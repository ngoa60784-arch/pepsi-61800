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

describe("challenge host bridge notifications", () => {
    test("correct flag submission notifies other solvers with board summary", async () => {
        const submitFlag = mock(async () => ({
            remote: { correct: true, flag_got_count: 1, flag_count: 3 },
            challenge: undefined,
            is_completed: false,
        }))
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
        const handler = createChallengeHostBridgeHandler({ submitFlag, listMemory, listIdeas } as unknown as ChallengeManager)
        const sendCommand = mock(() => {})

        const result = await handler.handle(
            createContext({
                action: "challenge_submit_flag",
                params: { flag: "flag{web-1}", writeup: "upload polyglot bypass -> webshell -> read /flag" },
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
        expect(sendCommand).toHaveBeenCalledTimes(1)
        expect(sendCommand).toHaveBeenCalledWith("solver-2", {
            type: "steer",
            message: `协作同步：同题已有 solver 提交正确 flag。
- flag: flag{web-1}
- 进度: 1/3
- 剩余 flag: 2
- 这条路线已经拿到一个 flag，不要重复挖同一支，转向剩余 flag。
- 本次 flag 路线摘要：
- upload polyglot bypass -> webshell -> read /flag
- 当前思路板摘要：
- [verified] test upload for polyglot php bypass -> upload filter bypassed via polyglot payload
- [failed] retry login SQLi -> no injectable parameter
- 当前记忆摘要：
- [failure] union/time/error SQLi on /login failed; likely parameterized
- [hint] Hint says focus on upload processing`,
        })
    })
})
