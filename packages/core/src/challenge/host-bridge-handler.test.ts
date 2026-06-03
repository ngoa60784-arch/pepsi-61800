import { describe, expect, mock, test } from "bun:test"
import { createChallengeHostBridgeHandler } from "./host-bridge-handler"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import type { ChallengeManager } from "./manager"
import type { HostBridgeHandleContext, SolverInstance } from "../runtime/types"

function createContext(overrides?: Partial<HostBridgeHandleContext>): HostBridgeHandleContext {
    const sendCommand = overrides?.sendCommand ?? mock(() => {})
    const solvers: SolverInstance[] = [
        { id: "solver-1", challengeId: "chal-1", status: "running", promptName: "p", task: "", containerId: "a", name: "a", createdAt: 0 },
        { id: "solver-2", challengeId: "chal-1", status: "running", promptName: "p", task: "", containerId: "b", name: "b", createdAt: 0 },
        { id: "solver-3", challengeId: "other", status: "running", promptName: "p", task: "", containerId: "c", name: "c", createdAt: 0 },
        { id: "solver-4", challengeId: "chal-1", status: "starting", promptName: "p", task: "", containerId: "d", name: "d", createdAt: 0 },
    ]
    return {
        solverId: "solver-1",
        action: "challenge_get_state" as const,
        params: {},
        getSolverEnvValue: (key: string) => (key === CHALLENGE_ENV_CHALLENGE_ID ? "chal-1" : undefined),
        listSolvers: () => solvers,
        sendCommand,
        ...overrides,
    }
}

describe("engagement host bridge notifications", () => {
    test("report_finding records objective and notifies other solvers with board summary", async () => {
        // 无 scope 文件时，storeKey 回退到 solver 的 challengeId ("chal-1")。
        const recordEngagementObjective = mock(async (_challengeId: string, _proof: string) => ({ id: "submission-123" }))
        const listMemory = mock(async () => [
            {
                id: "mem_1",
                challengeId: "chal-1",
                kind: "failure" as const,
                content: "union/time/error SQLi on /login failed; likely parameterized",
                refs: [],
                source: "observer",
                created_at: "2026-04-12T00:00:00.000Z",
                updated_at: "2026-04-12T00:00:00.000Z",
            },
            {
                id: "mem_2",
                challengeId: "chal-1",
                kind: "hint" as const,
                content: "Hint says focus on upload processing",
                refs: [],
                source: "observer",
                created_at: "2026-04-12T00:00:00.000Z",
                updated_at: "2026-04-12T00:00:00.000Z",
            },
        ])
        const listIdeas = mock(async () => [
            {
                id: "idea_1",
                content: "test upload for polyglot php bypass",
                normalized: "test upload for polyglot php bypass",
                status: "verified" as const,
                result: "upload filter bypassed via polyglot payload",
                created_at: "2026-04-12T00:00:00.000Z",
                updated_at: "2026-04-12T00:00:00.000Z",
            },
            {
                id: "idea_2",
                content: "retry login SQLi",
                normalized: "retry login sqli",
                status: "failed" as const,
                result: "no injectable parameter",
                created_at: "2026-04-12T00:00:00.000Z",
                updated_at: "2026-04-12T00:00:00.000Z",
            },
        ])
        const handler = createChallengeHostBridgeHandler({ recordEngagementObjective, listMemory, listIdeas } as unknown as ChallengeManager)
        const sendCommand = mock(() => {})

        const result = await handler.handle(
            createContext({
                action: "challenge_submit_flag",
                params: { flag: "creds: admin:Sup3r!", writeup: "upload polyglot bypass -> webshell -> dump db creds" },
                sendCommand,
                getSolver: () => ({
                    id: "solver-1",
                    challengeId: "chal-1",
                    status: "running",
                    promptName: "p",
                    task: "",
                    containerId: "a",
                    name: "a",
                    createdAt: 0,
                }),
            }),
        )

        expect(result.handled).toBe(true)
        // 实战模式永远不自动判完成。
        expect((result.data as { is_completed: boolean }).is_completed).toBe(false)
        expect((result.data as { recorded: boolean }).recorded).toBe(true)
        expect(recordEngagementObjective).toHaveBeenCalledTimes(1)
        // 记录/读取/广播一律以 challenge(target) id 为 key（"chal-1"），而非 scope 名。
        // 这正是 HIGH-1 修复的核心：写读 key 必须一致，否则 findings 永不回灌、广播失效。
        expect(recordEngagementObjective.mock.calls[0]?.[0]).toBe("chal-1")
        expect(listMemory).toHaveBeenCalledWith("chal-1")
        expect(listIdeas).toHaveBeenCalledWith("chal-1")
        expect((result.data as { challenge_id: string }).challenge_id).toBe("chal-1")

        // 只广播给同范围、运行中、非自身的 solver（solver-2）；solver-4 是 starting 跳过。
        expect(sendCommand).toHaveBeenCalledTimes(1)
        expect(sendCommand).toHaveBeenCalledWith("solver-2", {
            type: "steer",
            message: `Collaboration sync: another solver in the same scope has recorded a verified objective/finding.
- This only means that route produced a result; it does NOT mean the whole engagement is complete (the operator confirms completion).
- Don't re-dig the same route — pivot to other in-scope targets or attack surface.
- Finding route summary:
- upload polyglot bypass -> webshell -> dump db creds
- Current idea board summary:
- [verified] test upload for polyglot php bypass -> upload filter bypassed via polyglot payload
- [failed] retry login SQLi -> no injectable parameter
- Current memory summary:
- [failure] union/time/error SQLi on /login failed; likely parameterized
- [hint] Hint says focus on upload processing`,
        })
    })

    test("challenge_is_completed reflects target objective_achieved state", async () => {
        // 未达成目标(isChallengeCompleted=false) → is_completed=false
        const notDone = createChallengeHostBridgeHandler({ isChallengeCompleted: async () => false } as unknown as ChallengeManager)
        const r1 = await notDone.handle(createContext({ action: "challenge_is_completed" }))
        expect(r1.handled).toBe(true)
        expect((r1.data as { is_completed: boolean }).is_completed).toBe(false)

        // 主目标达成(isChallengeCompleted=true) → is_completed=true,让 solver 续跑循环收手
        const done = createChallengeHostBridgeHandler({ isChallengeCompleted: async () => true } as unknown as ChallengeManager)
        const r2 = await done.handle(createContext({ action: "challenge_is_completed" }))
        expect((r2.data as { is_completed: boolean }).is_completed).toBe(true)
    })

    test("challenge_get_state returns target record and real completion status", async () => {
        // challenge_get_state 必须带上目标记录与真实完成状态：observer review 靠 challenge 字段填充
        // 上下文(标题/入口)，靠 is_completed 判断是否还要继续 review。
        const challengeRecord = {
            id: "chal-1",
            title: "ACME 上传点",
            entrypoint: ["http://acme.test", "https://acme.test"],
            instance_status: "running",
        }
        const getChallenge = mock(async (_id: string) => challengeRecord)
        const isChallengeCompleted = mock(async () => true)
        const handler = createChallengeHostBridgeHandler({ getChallenge, isChallengeCompleted } as unknown as ChallengeManager)

        const result = await handler.handle(createContext({ action: "challenge_get_state" }))

        expect(result.handled).toBe(true)
        // 用 storeKey("chal-1") 查询，而非 scope 名。
        expect(getChallenge).toHaveBeenCalledWith("chal-1")
        expect(isChallengeCompleted).toHaveBeenCalledWith("chal-1")
        const data = result.data as { challenge: typeof challengeRecord | null; is_completed: boolean; challenge_id: string }
        expect(data.challenge_id).toBe("chal-1")
        expect(data.challenge).toMatchObject({ title: "ACME 上传点", entrypoint: ["http://acme.test", "https://acme.test"] })
        // 真实完成状态透传，不再硬编码 false。
        expect(data.is_completed).toBe(true)
    })

    test("challenge_get_state degrades gracefully when manager lookups fail", async () => {
        // getChallenge / isChallengeCompleted 抛错时不应让整个 review 流程崩溃，回退到 null / false。
        const handler = createChallengeHostBridgeHandler({
            getChallenge: async () => {
                throw new Error("store unavailable")
            },
            isChallengeCompleted: async () => {
                throw new Error("store unavailable")
            },
        } as unknown as ChallengeManager)

        const result = await handler.handle(createContext({ action: "challenge_get_state" }))

        const data = result.data as { challenge: unknown; is_completed: boolean }
        expect(data.challenge).toBeNull()
        expect(data.is_completed).toBe(false)
    })

    test("report_finding with objective_achieved + concrete evidence enters independent verification (not auto-stopped)", async () => {
        const recordEngagementObjective = mock(async (_id: string, _proof: string) => ({ id: "rec-1" }))
        const markEngagementComplete = mock(async () => {})
        const verifyObjective = mock(async (_input: { challengeId: string; recordId: string }) => {})
        const handler = createChallengeHostBridgeHandler({
            recordEngagementObjective,
            markEngagementComplete,
            verifyObjective,
            listMemory: async () => [],
            listIdeas: async () => [],
        } as unknown as ChallengeManager)
        const result = await handler.handle(
            createContext({
                action: "challenge_submit_flag",
                params: {
                    flag: "$ id\nuid=0(root) gid=0(root) groups=0(root)",
                    writeup: "deserialization RCE on /api/import -> interactive shell as root",
                    objective_achieved: true,
                },
            }),
        )
        expect(result.handled).toBe(true)
        // 进入复核流程,尚未收尾。
        expect((result.data as { is_completed: boolean }).is_completed).toBe(false)
        expect((result.data as { under_verification?: boolean }).under_verification).toBe(true)
        expect((result.data as { objective_downgraded?: boolean }).objective_downgraded).toBe(false)
        // 关键:过证据门禁 → 起独立 verifier 复跑(不直接 markEngagementComplete)。
        expect(verifyObjective).toHaveBeenCalledTimes(1)
        expect(verifyObjective.mock.calls[0]?.[0]).toMatchObject({ challengeId: "chal-1", recordId: "rec-1" })
        // 自动收尾只能由 verifier 在复现确认后从内部触发,handler 不直接调用。
        expect(markEngagementComplete).not.toHaveBeenCalled()
    })

    test("report_finding with objective_achieved but no concrete evidence is downgraded (no verification, not auto-stopped)", async () => {
        const recordEngagementObjective = mock(async (_id: string, _proof: string) => ({ id: "rec-2" }))
        const markEngagementComplete = mock(async () => {})
        const verifyObjective = mock(async () => {})
        const handler = createChallengeHostBridgeHandler({
            recordEngagementObjective,
            markEngagementComplete,
            verifyObjective,
            listMemory: async () => [],
            listIdeas: async () => [],
        } as unknown as ChallengeManager)
        const result = await handler.handle(
            createContext({
                action: "challenge_submit_flag",
                params: { flag: "got root shell via deserialization RCE, objective achieved", objective_achieved: true },
            }),
        )
        expect(result.handled).toBe(true)
        // 空口号无产物 → 不进验证流程、不自动收尾，降级为普通 finding（仍记录）。
        expect((result.data as { is_completed: boolean }).is_completed).toBe(false)
        expect((result.data as { under_verification?: boolean }).under_verification).toBe(false)
        expect((result.data as { objective_downgraded?: boolean }).objective_downgraded).toBe(true)
        expect((result.data as { recorded: boolean }).recorded).toBe(true)
        expect(recordEngagementObjective).toHaveBeenCalledTimes(1)
        // 关键:证据不足 → 既不起 verifier，也绝不自动停，整条战线保留。
        expect(verifyObjective).not.toHaveBeenCalled()
        expect(markEngagementComplete).not.toHaveBeenCalled()
    })

    test("state_upsert records a structured asset via the manager", async () => {
        const upsertStateAsset = mock(async (_id: string, _input: { kind: string; label: string }) => ({ created: true, asset: { id: "asset_abc" } }))
        const handler = createChallengeHostBridgeHandler({ upsertStateAsset } as unknown as ChallengeManager)
        const result = await handler.handle(
            createContext({
                action: "state_upsert" as never,
                params: { kind: "credential", label: "admin@webapp", host: "10.0.0.5", account: "admin", secret_ref: "finding:rec-1" },
            }),
        )
        expect(result.handled).toBe(true)
        expect((result.data as { recorded: boolean }).recorded).toBe(true)
        expect((result.data as { asset_id: string }).asset_id).toBe("asset_abc")
        expect(upsertStateAsset).toHaveBeenCalledTimes(1)
        expect(upsertStateAsset.mock.calls[0]?.[0]).toBe("chal-1")
        expect(upsertStateAsset.mock.calls[0]?.[1]).toMatchObject({ kind: "credential", label: "admin@webapp", account: "admin", secretRef: "finding:rec-1" })
    })

    test("state_upsert rejects an invalid kind without touching the manager", async () => {
        const upsertStateAsset = mock(async () => ({ created: true, asset: { id: "x" } }))
        const handler = createChallengeHostBridgeHandler({ upsertStateAsset } as unknown as ChallengeManager)
        const result = await handler.handle(
            createContext({
                action: "state_upsert" as never,
                params: { kind: "banana", label: "nope" },
            }),
        )
        expect(result.handled).toBe(true)
        expect((result.data as { recorded: boolean }).recorded).toBe(false)
        expect(upsertStateAsset).not.toHaveBeenCalled()
    })

    test("relation_upsert records an attack-graph edge via the manager (keyed by challenge id)", async () => {
        const appendRelation = mock(async (input: { challengeId: string }) => ({
            id: "rel_abc123",
            challengeId: input.challengeId,
            source: "Host:10.0.0.5",
            relation: "exploitable_via",
            target: "Vuln:CVE-2023-1234",
            note: "confirmed via nuclei",
            source_ref: "",
            created_at: "2026-04-12T00:00:00.000Z",
            updated_at: "2026-04-12T00:00:00.000Z",
        }))
        const handler = createChallengeHostBridgeHandler({ appendRelation } as unknown as ChallengeManager)
        const result = await handler.handle(
            createContext({
                action: "relation_upsert" as never,
                params: { source: "Host:10.0.0.5", relation: "exploitable_via", target: "Vuln:CVE-2023-1234", note: "confirmed via nuclei" },
            }),
        )
        expect(result.handled).toBe(true)
        expect((result.data as { recorded: boolean }).recorded).toBe(true)
        expect((result.data as { relation_id: string }).relation_id).toBe("rel_abc123")
        expect(appendRelation).toHaveBeenCalledTimes(1)
        // 写攻击图谱同样以 challenge(target) id 为 key,而非 scope 名。
        expect(appendRelation.mock.calls[0]?.[0]).toMatchObject({
            challengeId: "chal-1",
            source: "Host:10.0.0.5",
            relation: "exploitable_via",
            target: "Vuln:CVE-2023-1234",
            note: "confirmed via nuclei",
        })
    })

    test("relation_upsert rejects a missing required field without touching the manager", async () => {
        const appendRelation = mock(async () => ({}) as never)
        const handler = createChallengeHostBridgeHandler({ appendRelation } as unknown as ChallengeManager)
        // 缺 target → getRequiredString 抛错,handler 不应吞掉成功;调用方(rpc)会把它作为失败回传。
        await expect(
            handler.handle(
                createContext({
                    action: "relation_upsert" as never,
                    params: { source: "Host:A", relation: "routes_to" },
                }),
            ),
        ).rejects.toThrow("target is required")
        expect(appendRelation).not.toHaveBeenCalled()
    })

    test("relation_query filters edges via the manager and returns a trimmed projection", async () => {
        const queryRelations = mock(async (_id: string, _filter: Record<string, string | undefined>) => [
            {
                id: "rel_1",
                challengeId: "chal-1",
                source: "Cred:admin@web01",
                relation: "grants_access_to",
                target: "Host:10.0.0.9",
                note: "reused on dc",
                source_ref: "asset_x",
                created_at: "2026-04-12T00:00:00.000Z",
                updated_at: "2026-04-12T00:00:00.000Z",
            },
        ])
        const handler = createChallengeHostBridgeHandler({ queryRelations } as unknown as ChallengeManager)
        const result = await handler.handle(
            createContext({
                action: "relation_query" as never,
                params: { relation: "grants" },
            }),
        )
        expect(result.handled).toBe(true)
        expect((result.data as { count: number }).count).toBe(1)
        expect(queryRelations).toHaveBeenCalledWith("chal-1", { source: undefined, relation: "grants", target: undefined })
        const edges = (result.data as { relations: Array<Record<string, string>> }).relations
        // 投影只暴露 id/source/relation/target/note,不外泄内部 timestamp / challengeId。
        expect(edges[0]).toEqual({ id: "rel_1", source: "Cred:admin@web01", relation: "grants_access_to", target: "Host:10.0.0.9", note: "reused on dc" })
    })

    test("relation_path returns the shortest mapped chain via the manager", async () => {
        const findRelationShortestPath = mock(async (_id: string, _start: string, _end: string) => ({
            found: true,
            path: [
                { source: "Host:A", relation: "routes_to", target: "Subnet:B", note: "" },
                { source: "Subnet:B", relation: "contains", target: "Host:C", note: "" },
            ],
        }))
        const handler = createChallengeHostBridgeHandler({ findRelationShortestPath } as unknown as ChallengeManager)
        const result = await handler.handle(
            createContext({
                action: "relation_path" as never,
                params: { start: "Host:A", end: "Host:C" },
            }),
        )
        expect(result.handled).toBe(true)
        expect((result.data as { found: boolean }).found).toBe(true)
        expect((result.data as { hops: number }).hops).toBe(2)
        expect(findRelationShortestPath).toHaveBeenCalledWith("chal-1", "Host:A", "Host:C")
    })
})
