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
        // Without scope file, storeKey falls back to solver challengeId ("chal-1").
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
        // Engagement mode never auto-marks complete.
        expect((result.data as { is_completed: boolean }).is_completed).toBe(false)
        expect((result.data as { recorded: boolean }).recorded).toBe(true)
        expect(recordEngagementObjective).toHaveBeenCalledTimes(1)
        // Record/read/broadcast always use challenge (target) id ("chal-1"), not scope name.
        // HIGH-1 fix: read/write key must match or findings never replay and broadcast fails.
        expect(recordEngagementObjective.mock.calls[0]?.[0]).toBe("chal-1")
        expect(listMemory).toHaveBeenCalledWith("chal-1")
        expect(listIdeas).toHaveBeenCalledWith("chal-1")
        expect((result.data as { challenge_id: string }).challenge_id).toBe("chal-1")

        // Broadcast only to same-scope running peers (solver-2); solver-4 starting is skipped.
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
        // Objective not achieved (isChallengeCompleted=false) → is_completed=false
        const notDone = createChallengeHostBridgeHandler({ isChallengeCompleted: async () => false } as unknown as ChallengeManager)
        const r1 = await notDone.handle(createContext({ action: "challenge_is_completed" }))
        expect(r1.handled).toBe(true)
        expect((r1.data as { is_completed: boolean }).is_completed).toBe(false)

        // Primary objective achieved → is_completed=true so solver loop can stop
        const done = createChallengeHostBridgeHandler({ isChallengeCompleted: async () => true } as unknown as ChallengeManager)
        const r2 = await done.handle(createContext({ action: "challenge_is_completed" }))
        expect((r2.data as { is_completed: boolean }).is_completed).toBe(true)
    })

    test("challenge_get_state returns target record and real completion status", async () => {
        // challenge_get_state must include target record and real completion for observer review
        // context (title/entry); is_completed decides whether review continues.
        const challengeRecord = {
            id: "chal-1",
            title: "ACME Upload Point",
            entrypoint: ["http://acme.test", "https://acme.test"],
            instance_status: "running",
        }
        const getChallenge = mock(async (_id: string) => challengeRecord)
        const isChallengeCompleted = mock(async () => true)
        const handler = createChallengeHostBridgeHandler({ getChallenge, isChallengeCompleted } as unknown as ChallengeManager)

        const result = await handler.handle(createContext({ action: "challenge_get_state" }))

        expect(result.handled).toBe(true)
        // Query with storeKey("chal-1"), not scope name.
        expect(getChallenge).toHaveBeenCalledWith("chal-1")
        expect(isChallengeCompleted).toHaveBeenCalledWith("chal-1")
        const data = result.data as { challenge: typeof challengeRecord | null; is_completed: boolean; challenge_id: string }
        expect(data.challenge_id).toBe("chal-1")
        expect(data.challenge).toMatchObject({ title: "ACME Upload Point", entrypoint: ["http://acme.test", "https://acme.test"] })
        // Real completion status passed through, not hardcoded false.
        expect(data.is_completed).toBe(true)
    })

    test("challenge_get_state degrades gracefully when manager lookups fail", async () => {
        // getChallenge/isChallengeCompleted errors must not crash review; fall back to null/false.
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
        // In verification, not wound down yet.
        expect((result.data as { is_completed: boolean }).is_completed).toBe(false)
        expect((result.data as { under_verification?: boolean }).under_verification).toBe(true)
        expect((result.data as { objective_downgraded?: boolean }).objective_downgraded).toBe(false)
        // Key: passed evidence gate → independent verifier (not direct markEngagementComplete).
        expect(verifyObjective).toHaveBeenCalledTimes(1)
        expect(verifyObjective.mock.calls[0]?.[0]).toMatchObject({ challengeId: "chal-1", recordId: "rec-1" })
        // Auto wind-down only from verifier after reproduction; handler does not call directly.
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
        // Empty claim without artifacts → no verification, no auto wind-down; downgraded finding (still logged).
        expect((result.data as { is_completed: boolean }).is_completed).toBe(false)
        expect((result.data as { under_verification?: boolean }).under_verification).toBe(false)
        expect((result.data as { objective_downgraded?: boolean }).objective_downgraded).toBe(true)
        expect((result.data as { recorded: boolean }).recorded).toBe(true)
        expect(recordEngagementObjective).toHaveBeenCalledTimes(1)
        // Key: insufficient evidence → no verifier, no auto stop; line stays active.
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
})
