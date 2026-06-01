import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_ENV_DIR, ENGAGEMENT_ENV_MODE } from "./env"
import { ChallengeManager } from "./manager"
import { appendChallengeAttemptLog, appendChallengeSubmissionLog, saveChallengeRecord } from "./store"
import { readSolverBoardSnapshot } from "../solver/board-store"
import { solverSessionDir } from "../runtime/types"

let challengeDir: string
let manager: ChallengeManager
const originalFetch = globalThis.fetch

beforeEach(async () => {
    challengeDir = await mkdtemp(resolve(tmpdir(), "tch-challenge-manager-test-"))
    process.env[CHALLENGE_ENV_DIR] = challengeDir
    // 这些用例覆盖的是本地存储底座 + 传统任务文案；用逃生口关掉实战默认，确定性地走 mock 语义。
    process.env[ENGAGEMENT_ENV_MODE] = "0"
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
    delete process.env[ENGAGEMENT_ENV_MODE]
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

    // NOTE: 远程 CTF 评分 API 已移除。原先三个针对 real-api 模式
    // （apiBaseUrl/agentToken + fetch 行为）的测试随该功能一并删除。

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
            // verifier 判定为误报 → 不应进入 brief 的 Findings 摘要（实战里"无效发现"= rejected，而非 correct:false）。
            verificationStatus: "rejected",
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
        expect(solver.task).toContain("Target id: mock-launch")
        expect(solver.task).toContain("authorized penetration-test operator")
        expect(solver.task).toContain("Startup brief:")
        expect(solver.task).toContain("优先检查上传链；只有明确需要时再看 hint。")
        expect(solver.task).not.toContain("用户额外策略（包含 hint 策略，如果有）:")
        expect(solver.task).not.toContain("不要把这整段 planner 策略原样拼给 solver。")
        expect(solver.task).toContain("Current Memory summary:")
        expect(solver.task).toContain("login page exposes /admin")
        expect(solver.task).toContain("Current Ideas summary:")
        expect(solver.task).toContain("test upload for webshell")
        expect(solver.task).toContain("Current Findings summary:")
        expect(solver.task).toContain("flag{upload-1}")
        expect(solver.task).toContain(
            "upload polyglot bypass -> webshell -> read /flag1 -> verify second-stage pivot -> collect evidence -> submit exact challenge-scoped flag without truncation",
        )
        expect(solver.task).not.toContain("flag{login-guess}")
        expect(solver.task).not.toContain("tried login SQLi on /admin/login and captcha bypass, no flag")
        expect(solver.task).toContain("check the Findings summary")
        // Opt 3: 共享作战状态段始终注入(即便当前为空),让 solver 知道去复用而非重新发现。
        expect(solver.task).toContain("Shared battlefield state")
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

        expect(solver.task).toContain("Note: initial context shows only the most recent 10/13 memory entries")
        expect(solver.task).toContain("Note: initial context shows only the most recent 8/10 ideas")
        expect(solver.task).toContain("failure-11")
        expect(solver.task).not.toContain("failure-0")
        expect(solver.task).toContain("idea-9")
        expect(solver.task).not.toContain("idea-0")
        expect(solver.task).toContain("call memory_list for the full set")
        expect(solver.task).toContain("call idea_list or idea_search for the full board")
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
            message: `Collaboration sync: target memory added.
 - kind: hint
 - source: challenge-ui
 - content: focus on upload parser differential
 - This is a target-level background update; if it affects your current route, absorb and adjust on your own.`.replace(/^ /gm, ""),
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
            message: `Collaboration sync: target idea added.
 - status: testing
 - content: test upload parser differential
 - result: png header accepted but php tail blocked
 - This is a target-level background update; treat it as a reference hypothesis, not a conclusion.`.replace(/^ /gm, ""),
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

    test("planner_steer_solver re-tasks a running solver without restarting it", async () => {
        await manager.createChallenge({
            id: "mock-steer",
            title: "mock-steer",
            difficulty: "medium",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: "",
            instance_status: "running",
            entrypoint: ["10.0.0.5:80"],
            flags: ["flag{ok}"],
        })

        const sendCommand = mock((_solverId: string, _command: { type: string; message: string }) => {})
        const runningSolver = { id: "solver-live", challengeId: "mock-steer", status: "running", promptName: "p", task: "", containerId: "c", name: "c", createdAt: Date.now() }
        const listAll = mock(async () => [runningSolver])
        manager.attachRuntime({ listAll, sendCommand } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<unknown> }).buildPlannerSnapshot("test")
        const tools = (
            manager as unknown as {
                createPlannerTools: (snapshot: unknown) => Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>
            }
        ).createPlannerTools(snapshot)

        const steer = tools.find((tool) => tool.name === "planner_steer_solver")
        expect(steer).toBeDefined()
        await steer?.execute("call-1", { solverId: "solver-live", message: "creds obtained for /admin; pivot from recon to privilege escalation" })

        // 关键:steer 走 sendCommand(type:"steer"),不重启 solver(不调用 stop/launch)。
        expect(sendCommand).toHaveBeenCalledTimes(1)
        expect(sendCommand.mock.calls[0]?.[0]).toBe("solver-live")
        expect(sendCommand.mock.calls[0]?.[1]).toMatchObject({ type: "steer" })
    })

    test("planner_set_plan persists a battle plan that carries into the next round", async () => {
        await manager.createChallenge({
            id: "mock-plan",
            title: "mock-plan",
            difficulty: "medium",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: "",
            instance_status: "running",
            entrypoint: ["10.0.0.6:80"],
            flags: ["flag{ok}"],
        })
        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = await (manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<unknown> }).buildPlannerSnapshot("test")
        const battlePlan = new Map<string, unknown>()
        const tools = (
            manager as unknown as {
                createPlannerTools: (snapshot: unknown, plan: Map<string, unknown>) => Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>
            }
        ).createPlannerTools(snapshot, battlePlan)

        const setPlan = tools.find((tool) => tool.name === "planner_set_plan")
        expect(setPlan).toBeDefined()
        await setPlan?.execute("call-1", { challengeId: "mock-plan", strategy: "creds obtained -> escalate -> pivot internal", nextCheckpoint: "confirm escalation solver got root" })

        expect(battlePlan.size).toBe(1)
        const entry = battlePlan.get("mock-plan") as { strategy: string; nextCheckpoint?: string }
        expect(entry.strategy).toContain("escalate")
        expect(entry.nextCheckpoint).toContain("root")
    })

    test("planner snapshot carries solver results (战果感知调度)", async () => {
        await manager.createChallenge({
            id: "mock-results",
            title: "mock-results",
            difficulty: "medium",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: "",
            instance_status: "running",
            entrypoint: ["10.0.0.5:8080"],
            flags: ["flag{ok}"],
        })

        // 落一个 credential memory（枢纽信号）、一个 failure 边界、一条 verified idea、一条已记录 finding。
        await manager.appendMemory({ challengeId: "mock-results", kind: "credential", content: "admin:Sup3r! for /admin panel", source: "observer" })
        await manager.appendMemory({ challengeId: "mock-results", kind: "failure", content: "union/error SQLi on /login dead-ended; parameterized", source: "observer" })
        await manager.addIdea("mock-results", { content: "polyglot php upload bypass", status: "verified", result: "webshell dropped" })
        await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "mock-results",
            flag: "webshell at /uploads/x.php",
            // 实战语义:report_finding 写 correct:false(无裁判)。这条仍应被算作真实战果(未被 verifier 否决)。
            correct: false,
            writeup: "upload bypass -> webshell -> dumped db creds",
        })
        // 制造一次 attempt 记录，让目标不被判为 untouched。
        await appendChallengeAttemptLog(challengeDir, { challengeId: "mock-results", solverId: "solver-x", promptName: "p", task: "recon" })
        // 结构化作战资产:一个凭据(跨 solver 复用)。
        await manager.upsertStateAsset("mock-results", { kind: "credential", label: "admin@webapp", host: "10.0.0.5", account: "admin", secretRef: "finding:rec-1" })

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = (await (
            manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<{ challenges: Array<Record<string, unknown>> }> }
        ).buildPlannerSnapshot("test")) as { challenges: Array<Record<string, unknown>> }

        const item = snapshot.challenges.find((entry) => entry.id === "mock-results") as
            | {
                  progressPhase: string
                  memoryFacts: string[]
                  failureBoundaries: string[]
                  liveIdeas: string[]
                  findings: string[]
                  ideaStatusCounts: Record<string, number>
              }
            | undefined
        expect(item).toBeDefined()
        // credential memory → foothold 信号 → 进入 foothold/breakthrough 阶段（有 correct finding → breakthrough）。
        expect(item?.progressPhase).toBe("breakthrough")
        // credential 优先填充 facts 段。
        expect(item?.memoryFacts.some((line) => line.includes("[credential]") && line.includes("admin:Sup3r!"))).toBe(true)
        // 失败边界单列，供 planner 避开已死路线。
        expect(item?.failureBoundaries.some((line) => line.includes("union/error SQLi"))).toBe(true)
        // 活跃假设带状态。
        expect(item?.liveIdeas.some((line) => line.includes("[verified]") && line.includes("polyglot"))).toBe(true)
        // 已记录发现以 writeup 为主。
        expect(item?.findings.some((line) => line.includes("upload bypass"))).toBe(true)
        expect(item?.ideaStatusCounts.verified).toBe(1)
        // 难度感知数值信号。回归防护:实战 finding(correct:false)仍须计入 → successRate 反映出战果，
        // 而不是退化成"越多发现分越低"的反向值。
        expect(typeof (item as unknown as { successRate: number })?.successRate).toBe("number")
        expect((item as unknown as { successRate: number })?.successRate).toBeGreaterThan(0)
        // 1 条真实战果 / (1 总提交) 经 Laplace → (1+1)/(1+2) ≈ 0.667，必须明显高于"零战果"的 1/3。
        expect((item as unknown as { successRate: number })?.successRate).toBeGreaterThan(0.5)
        expect((item as unknown as { failedRouteCount: number })?.failedRouteCount).toBeGreaterThanOrEqual(1)
        expect(typeof (item as unknown as { effortRank: number })?.effortRank).toBe("number")
        // 有立足点(credential) + verified idea + correct finding → 绝不建议剪枝。
        expect((item as unknown as { pruneRecommended: boolean })?.pruneRecommended).toBe(false)
        // 结构化作战资产进入 snapshot,凭据可被调度层看到。
        expect((item as unknown as { stateAssets: string[] })?.stateAssets.some((line) => line.includes("[credential]") && line.includes("admin@webapp"))).toBe(true)
    })

    test("planner snapshot recommends pruning a target with >=3 dead routes, no foothold, no live hypothesis", async () => {
        await manager.createChallenge({
            id: "mock-prune",
            title: "mock-prune",
            difficulty: "hard",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: "",
            instance_status: "running",
            entrypoint: ["10.0.0.7:443"],
            flags: ["flag{ok}"],
        })
        // 3 条死路线：2 个 failure memory + 1 个 failed idea。无 credential、无 testing/pending/verified。
        await manager.appendMemory({ challengeId: "mock-prune", kind: "failure", content: "SQLi everywhere parameterized; dead", source: "observer" })
        await manager.appendMemory({ challengeId: "mock-prune", kind: "failure", content: "no file upload endpoint exists", source: "observer" })
        await manager.addIdea("mock-prune", { content: "brute force admin login", status: "failed", result: "account lockout after 5" })
        await appendChallengeAttemptLog(challengeDir, { challengeId: "mock-prune", solverId: "solver-y", promptName: "p", task: "recon" })

        const listAll = mock(async () => [])
        manager.attachRuntime({ listAll } as never)

        const snapshot = (await (
            manager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<{ challenges: Array<Record<string, unknown>> }> }
        ).buildPlannerSnapshot("test")) as { challenges: Array<Record<string, unknown>> }
        const item = snapshot.challenges.find((entry) => entry.id === "mock-prune") as
            | { pruneRecommended: boolean; failedRouteCount: number; progressPhase: string }
            | undefined
        expect(item).toBeDefined()
        expect(item?.failedRouteCount).toBeGreaterThanOrEqual(3)
        expect(item?.pruneRecommended).toBe(true)
        expect(item?.progressPhase).toBe("recon")
    })

    test("verifyObjective leaves target unfinished + marks record inconclusive when verifier is unavailable", async () => {
        await manager.createChallenge({
            id: "verify-fallback",
            title: "verify-fallback",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: "",
            instance_status: "running",
            entrypoint: ["10.0.0.9:80"],
            flags: ["flag{ok}"],
        })
        const record = await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "verify-fallback",
            flag: "uid=0(root)",
            correct: false,
            verificationStatus: "pending",
        })

        const resolved: Array<{ verdict: string; note: string }> = []
        // config stub 没有 resolvePromptSession → verifyObjective 走"verifier 不可用"兜底:
        // 判 inconclusive、绝不收尾。
        await manager.verifyObjective({
            challengeId: "verify-fallback",
            recordId: record.id,
            proof: "uid=0(root)",
            onResolved: (verdict, note) => resolved.push({ verdict, note }),
        })

        expect(resolved).toHaveLength(1)
        expect(resolved[0].verdict).toBe("inconclusive")
        // 关键:verifier 不可用绝不能默默收尾。
        const challenge = await manager.getChallenge("verify-fallback")
        expect(challenge?.objective_achieved).not.toBe(true)
        const submissions = await manager.listSubmissionLogs("verify-fallback")
        expect(submissions.find((s) => s.id === record.id)?.verification_status).toBe("inconclusive")
    })
})
