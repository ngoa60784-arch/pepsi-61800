import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_ENV_DIR } from "./env"
import { ChallengeManager } from "./manager"
import { appendChallengeSubmissionLog, saveChallengeRecord } from "./store"
import { readSolverBoardSnapshot } from "../solver/board-store"
import { solverSessionDir } from "../runtime/types"

let challengeDir: string
let manager: ChallengeManager
const originalFetch = globalThis.fetch

beforeEach(async () => {
    challengeDir = await mkdtemp(resolve(tmpdir(), "tch-challenge-manager-test-"))
    process.env[CHALLENGE_ENV_DIR] = challengeDir
    const config = {
        getHostSettings: async () => ({ runtime: {}, challenge: { mockEnabled: true }, planner: {} }),
        getPrompt: async () => ({ meta: { isSubagent: false } }),
        listAgentPrompts: async () => [],
        listModelPrefs: async () => [],
    } as unknown as ConfigManager
    manager = new ChallengeManager(config)
})

afterEach(async () => {
    delete process.env[CHALLENGE_ENV_DIR]
    globalThis.fetch = originalFetch
    await rm(challengeDir, { recursive: true, force: true })
})

describe("challenge-manager mock api", () => {
    test("limits running challenges to 3", async () => {
        for (const id of ["mock-a", "mock-b", "mock-c", "mock-d"]) {
            await manager.createChallenge({
                id,
                title: id,
                difficulty: "easy",
                description: "",
                level: 1,
                total_score: 100,
                total_got_score: 0,
                flag_count: 1,
                flag_got_count: 0,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: ["127.0.0.1:8080"],
                flags: ["flag{ok}"],
            })
        }

        await manager.startChallenge("mock-a")
        await manager.startChallenge("mock-b")
        await manager.startChallenge("mock-c")

        await expect(manager.startChallenge("mock-d")).rejects.toThrow("at most 3 challenges can run at the same time")
    })

    test("requires running instance before submit and hint", async () => {
        await manager.createChallenge({
            id: "mock-web-1",
            title: "mock-web-1",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: "mock hint",
            instance_status: "stopped",
            entrypoint: ["127.0.0.1:8080"],
            flags: ["flag{ok}"],
        })

        await expect(manager.submitFlag("mock-web-1", "flag{ok}")).rejects.toThrow("challenge instance is not running")
        await expect(manager.getHint("mock-web-1")).rejects.toThrow("challenge instance is not running")

        await manager.startChallenge("mock-web-1")
        const submit = await manager.submitFlag("mock-web-1", "flag{ok}")
        expect(submit.remote.correct).toBe(true)

        const hint = await manager.getHint("mock-web-1")
        expect(hint.remote.hint_content).toBe("mock hint")
        const challenge = await manager.getChallenge("mock-web-1")
        expect(challenge?.hint_viewed).toBe(true)
        expect(challenge?.hint_content).toBe("mock hint")
    })

    test("mock mode only lists mock challenges", async () => {
        await manager.createChallenge({
            id: "mock-visible",
            title: "mock-visible",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["127.0.0.1:8080"],
            flags: ["flag{ok}"],
        })

        await saveChallengeRecord(
            challengeDir,
            {
                id: "web-real",
                title: "web-real",
                difficulty: "easy",
                description: "",
                level: 1,
                total_score: 100,
                total_got_score: 0,
                flag_count: 1,
                flag_got_count: 0,
                hint_viewed: false,
                instance_status: "running",
                entrypoint: ["127.0.0.1:8080"],
            },
            "test",
        )

        const challenges = await manager.listStoredChallenges()
        expect(challenges.map((item) => item.id)).toEqual(["mock-visible"])
        expect(await manager.getChallenge("web-real")).toBeUndefined()
    })

    test("without mock and api config, listChallengesSafe reads local files", async () => {
        const localConfig = {
            getHostSettings: async () => ({ runtime: {}, challenge: {}, planner: {} }),
        } as unknown as ConfigManager
        const localManager = new ChallengeManager(localConfig)

        await saveChallengeRecord(
            challengeDir,
            {
                id: "mock-local",
                title: "mock-local",
                difficulty: "easy",
                description: "",
                level: 1,
                total_score: 100,
                total_got_score: 0,
                flag_count: 1,
                flag_got_count: 0,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: null,
            },
            "test",
        )

        await saveChallengeRecord(
            challengeDir,
            {
                id: "real-local",
                title: "real-local",
                difficulty: "easy",
                description: "",
                level: 1,
                total_score: 100,
                total_got_score: 0,
                flag_count: 1,
                flag_got_count: 0,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: null,
            },
            "test",
        )

        const challenges = await localManager.listChallengesSafe("test")
        expect(challenges.map((item) => item.id)).toEqual(["mock-local", "real-local"])
    })

    test("with real api configured and stored challenges, listChallengesSafe returns local data immediately", async () => {
        const localConfig = {
            getHostSettings: async () => ({
                runtime: {},
                challenge: {
                    apiBaseUrl: "https://challenge.example/api",
                    agentToken: "agent-token",
                },
                planner: {},
            }),
        } as unknown as ConfigManager
        const localManager = new ChallengeManager(localConfig)

        await saveChallengeRecord(
            challengeDir,
            {
                id: "real-local",
                title: "real-local",
                difficulty: "easy",
                description: "",
                level: 1,
                total_score: 100,
                total_got_score: 0,
                flag_count: 1,
                flag_got_count: 0,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: null,
            },
            "test",
        )

        const fetchMock = mock(() => new Promise<Response>(() => {}))
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const timeout = Symbol("timeout")
        const result = await Promise.race([localManager.listChallengesSafe("test"), Bun.sleep(100).then(() => timeout)])

        expect(result).not.toBe(timeout)
        expect(Array.isArray(result)).toBe(true)
        if (!Array.isArray(result)) throw new Error("expected challenge list")
        expect(result.map((item) => item.id)).toEqual(["real-local"])

        await Bun.sleep(0)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("background sync failure does not block local results", async () => {
        const localConfig = {
            getHostSettings: async () => ({
                runtime: {},
                challenge: {
                    apiBaseUrl: "https://challenge.example/api",
                    agentToken: "agent-token",
                },
                planner: {},
            }),
        } as unknown as ConfigManager
        const localManager = new ChallengeManager(localConfig)

        await saveChallengeRecord(
            challengeDir,
            {
                id: "real-local",
                title: "real-local",
                difficulty: "easy",
                description: "",
                level: 1,
                total_score: 100,
                total_got_score: 0,
                flag_count: 1,
                flag_got_count: 0,
                hint_viewed: false,
                instance_status: "stopped",
                entrypoint: null,
            },
            "test",
        )

        const fetchMock = mock(async () => {
            throw new Error("network offline")
        })
        globalThis.fetch = fetchMock as unknown as typeof fetch

        const first = await localManager.listChallengesSafe("test")
        const second = await localManager.listChallengesSafe("test")

        expect(first.map((item) => item.id)).toEqual(["real-local"])
        expect(second.map((item) => item.id)).toEqual(["real-local"])

        await Bun.sleep(20)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test("reloadFromConfig clears cached real api client so mock mode takes effect", async () => {
        const settings: {
            runtime: Record<string, never>
            challenge: {
                mockEnabled?: boolean
                apiBaseUrl?: string
                agentToken?: string
            }
            planner: Record<string, never>
        } = {
            runtime: {},
            challenge: {
                apiBaseUrl: "https://challenge.example/api",
                agentToken: "agent-token",
            },
            planner: {},
        }
        const switchConfig = {
            getHostSettings: async () => settings,
            getPrompt: async () => ({ meta: { isSubagent: false } }),
            listAgentPrompts: async () => [],
            listModelPrefs: async () => [],
        } as unknown as ConfigManager
        manager = new ChallengeManager(switchConfig)

        const fetchMock = mock(async () =>
            new Response(
                JSON.stringify({
                    code: 0,
                    message: "ok",
                    data: {
                        current_level: 0,
                        total_challenges: 0,
                        solved_challenges: 0,
                        challenges: [],
                    },
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        )
        globalThis.fetch = fetchMock as unknown as typeof fetch

        await manager.listChallengesSafe("test")
        expect(fetchMock).toHaveBeenCalledTimes(1)

        await manager.createChallenge({
            id: "mock-switch",
            title: "mock-switch",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: ["127.0.0.1:8080"],
            flags: ["flag{ok}"],
        })

        settings.challenge = { mockEnabled: true }
        manager.reloadFromConfig()

        const result = await manager.startChallenge("mock-switch")

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.challenge?.instance_status).toBe("running")
        expect(result.remote).toEqual(["127.0.0.1:8080"])
    })

    test("launchSolver starts challenge and records attempt", async () => {
        const config = {
            getHostSettings: async () => ({ runtime: {}, challenge: { mockEnabled: true }, planner: { strategy: "不要把这整段 planner 策略原样拼给 solver。" } }),
            getPrompt: async () => ({ meta: { isSubagent: false } }),
            listAgentPrompts: async () => [],
            listModelPrefs: async () => [],
        } as unknown as ConfigManager
        manager = new ChallengeManager(config)

        await manager.createChallenge({
            id: "mock-launch",
            title: "mock-launch",
            difficulty: "medium",
            description: "portal target",
            level: 2,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: true,
            hint_content: "check upload",
            instance_status: "stopped",
            entrypoint: ["127.0.0.1:8080"],
            flags: ["flag{ok}"],
        })
        await manager.appendMemory({
            challengeId: "mock-launch",
            kind: "fact",
            content: "login page exposes /admin",
            refs: ["scan-1"],
            source: "observer",
        })
        await manager.addIdea("mock-launch", { content: "test upload for webshell" })
        await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "mock-launch",
            solverId: "solver-prev-1",
            promptName: "pentest-orchestrator",
            modelName: "anthropic/claude-sonnet",
            flag: "flag{upload-1}",
            correct: true,
            writeup:
                "upload polyglot bypass -> webshell -> read /flag1 -> verify second-stage pivot -> collect evidence -> submit exact challenge-scoped flag without truncation",
        })
        await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "mock-launch",
            solverId: "solver-prev-2",
            promptName: "pentest-orchestrator",
            modelName: "anthropic/claude-sonnet",
            flag: "flag{login-guess}",
            correct: false,
            writeup: "tried login SQLi on /admin/login and captcha bypass, no flag",
        })

        const launch = mock(async (_promptName: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "solver-1",
            containerId: options?.solverId ?? "solver-1",
            name: options?.solverId ?? "solver-1",
            promptName: "pentest-orchestrator",
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({ launch } as never)

        const solver = await manager.launchSolver("mock-launch", "pentest-orchestrator", {
            plannerHandoff: "优先检查上传链；只有明确需要时再看 hint。",
        })
        const attempts = await manager.listAttemptLogs("mock-launch")

        expect(launch).toHaveBeenCalledTimes(1)
        expect(solver.challengeId).toBe("mock-launch")
        expect(solver.task).toContain("题目标题: mock-launch")
        expect(solver.task).toContain("难度: medium")
        expect(solver.task).toContain("check upload")
        expect(solver.task).toContain("启动补充说明:")
        expect(solver.task).toContain("优先检查上传链；只有明确需要时再看 hint。")
        expect(solver.task).not.toContain("用户额外策略（包含 hint 策略，如果有）:")
        expect(solver.task).not.toContain("不要把这整段 planner 策略原样拼给 solver。")
        expect(solver.task).toContain("当前 Memory 摘要:")
        expect(solver.task).toContain("login page exposes /admin")
        expect(solver.task).toContain("当前 Ideas 摘要:")
        expect(solver.task).toContain("test upload for webshell")
        expect(solver.task).toContain("当前 Submissions 摘要:")
        expect(solver.task).toContain("flag{upload-1}")
        expect(solver.task).toContain(
            "upload polyglot bypass -> webshell -> read /flag1 -> verify second-stage pivot -> collect evidence -> submit exact challenge-scoped flag without truncation",
        )
        expect(solver.task).not.toContain("flag{login-guess}")
        expect(solver.task).not.toContain("tried login SQLi on /admin/login and captcha bypass, no flag")
        expect(solver.task).toContain("先看当前 Submissions 摘要")
        const seededBoard = await readSolverBoardSnapshot(solverSessionDir(solver.id))
        expect(seededBoard.memory).toEqual(
            expect.arrayContaining([expect.objectContaining({ content: "login page exposes /admin", source: "observer" })]),
        )
        expect(seededBoard.ideas).toEqual(
            expect.arrayContaining([expect.objectContaining({ content: "test upload for webshell", status: "pending" })]),
        )
        expect(attempts).toHaveLength(1)
        expect(attempts[0]?.solver_id).toBe(solver.id)
    })

    test("launchSolver compacts initial memory and ideas context", async () => {
        await manager.createChallenge({
            id: "mock-compact",
            title: "mock-compact",
            difficulty: "hard",
            description: "compact me",
            level: 3,
            total_score: 100,
            total_got_score: 0,
            flag_count: 3,
            flag_got_count: 0,
            hint_viewed: true,
            hint_content: "focus on internal pivot",
            instance_status: "running",
            entrypoint: ["127.0.0.1:8081"],
            flags: ["flag{ok}"],
        })

        await manager.appendMemory({
            challengeId: "mock-compact",
            kind: "hint",
            content: "hint-priority",
            source: "observer",
        })
        for (let index = 0; index < 12; index += 1) {
            await manager.appendMemory({
                challengeId: "mock-compact",
                kind: "failure",
                content: `failure-${index}`,
                source: "observer",
            })
        }

        for (let index = 0; index < 10; index += 1) {
            await manager.addIdea("mock-compact", { content: `idea-${index}` })
        }

        const launch = mock(async (_promptName: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "solver-compact",
            containerId: options?.solverId ?? "solver-compact",
            name: options?.solverId ?? "solver-compact",
            promptName: "pentest-orchestrator",
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        manager.attachRuntime({ launch } as never)

        const solver = await manager.launchSolver("mock-compact", "pentest-orchestrator")

        expect(solver.task).toContain("focus on internal pivot")
        expect(solver.task).toContain("初始上下文仅展示最近 10/13 条 memory")
        expect(solver.task).toContain("初始上下文仅展示最近 8/10 条 idea")
        expect(solver.task).toContain("failure-11")
        expect(solver.task).not.toContain("failure-0")
        expect(solver.task).toContain("idea-9")
        expect(solver.task).not.toContain("idea-0")
        expect(solver.task).toContain("需要全量记录时再调用 memory_list")
        expect(solver.task).toContain("需要全量策略板时再调用 idea_list 或 idea_search")
        expect(solver.task).toContain("memory / ideas 已在 solver 启动时作为初始背景拼接给你")
    })

    test("appendMemory broadcasts challenge memory updates to running solvers on same challenge", async () => {
        const sendCommand = mock(() => {})
        manager.attachRuntime({
            list: () => [
                { id: "solver-a", challengeId: "chal-1", status: "running" },
                { id: "solver-b", challengeId: "chal-1", status: "starting" },
                { id: "solver-c", challengeId: "other", status: "running" },
            ],
            sendCommand,
        } as never)

        await manager.appendMemory({
            challengeId: "chal-1",
            kind: "hint",
            content: "focus on upload parser differential",
            source: "challenge-ui",
        })

        expect(sendCommand).toHaveBeenCalledTimes(1)
        expect(sendCommand).toHaveBeenCalledWith("solver-a", {
            type: "follow_up",
            message: `协作同步：Challenge Memory 已新增。
 - kind: hint
 - source: challenge-ui
 - content: focus on upload parser differential
 - 这是 challenge 级背景更新；如它影响当前路线，再自行吸收并调整。`.replace(/^ /gm, ""),
        })
    })

    test("addIdea broadcasts challenge idea updates to running solvers on same challenge", async () => {
        const sendCommand = mock(() => {})
        manager.attachRuntime({
            list: () => [
                { id: "solver-a", challengeId: "chal-1", status: "running" },
                { id: "solver-b", challengeId: "chal-1", status: "stopped" },
                { id: "solver-c", challengeId: "other", status: "running" },
            ],
            sendCommand,
        } as never)

        await manager.addIdea("chal-1", {
            content: "test upload parser differential",
            status: "testing",
            result: "png header accepted but php tail blocked",
        })

        expect(sendCommand).toHaveBeenCalledTimes(1)
        expect(sendCommand).toHaveBeenCalledWith("solver-a", {
            type: "follow_up",
            message: `协作同步：Challenge Idea 已新增。
 - status: testing
 - content: test upload parser differential
 - result: png header accepted but php tail blocked
 - 这是 challenge 级背景更新；把它当作参考假设，不要直接当作结论。`.replace(/^ /gm, ""),
        })
    })

    test("finishChallenge stops challenge instance and matching active solvers", async () => {
        await manager.createChallenge({
            id: "mock-finish",
            title: "mock-finish",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 100,
            flag_count: 1,
            flag_got_count: 1,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["127.0.0.1:8080"],
            flags: ["flag{ok}"],
        })

        const stopSolver = mock(async () => {})
        const listAll = mock(async () => [
            { id: "solver-a", challengeId: "mock-finish", status: "running" },
            { id: "solver-b", challengeId: "mock-finish", status: "starting" },
            { id: "solver-c", challengeId: "other", status: "running" },
            { id: "solver-d", challengeId: "mock-finish", status: "stopped" },
        ])
        manager.attachRuntime({ listAll, stopSolver } as never)

        await manager.finishChallenge("mock-finish")

        expect(stopSolver).toHaveBeenCalledTimes(2)
        expect(stopSolver).toHaveBeenNthCalledWith(1, "solver-a")
        expect(stopSolver).toHaveBeenNthCalledWith(2, "solver-b")

        const challenge = await manager.getChallenge("mock-finish")
        expect(challenge?.instance_status).toBe("stopped")
    })

    test("planner tools do not expose hint action", async () => {
        await manager.createChallenge({
            id: "mock-plan-hint",
            title: "mock-plan-hint",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: "planner hint",
            instance_status: "running",
            entrypoint: ["127.0.0.1:8080"],
            flags: ["flag{ok}"],
        })

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<unknown> }).buildPlannerSnapshot("test")
        const tools = (manager as unknown as { createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (_toolCallId: string, params: { challengeId: string }) => Promise<unknown> }> }).createPlannerTools(snapshot)

        expect(tools.some((tool) => tool.name === "planner_get_hint")).toBe(false)
    })
})
