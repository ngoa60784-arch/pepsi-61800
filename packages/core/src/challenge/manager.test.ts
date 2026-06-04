import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_ENV_DIR } from "./env"
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
    const config = {
        getHostSettings: async () => ({ runtime: {}, challenge: {}, planner: {} }),
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

describe("challenge-manager local api", () => {
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

        await expect(manager.submitFlag("mock-web-1", "flag{ok}")).rejects.toThrow("target instance is not running")
        await expect(manager.getHint("mock-web-1")).rejects.toThrow("target instance is not running")

        await manager.startChallenge("mock-web-1")
        const submit = await manager.submitFlag("mock-web-1", "flag{ok}")
        expect(submit.remote.correct).toBe(true)

        const hint = await manager.getHint("mock-web-1")
        expect(hint.remote.hint_content).toBe("mock hint")
        const challenge = await manager.getChallenge("mock-web-1")
        expect(challenge?.hint_viewed).toBe(true)
        expect(challenge?.hint_content).toBe("mock hint")
    })

    test("lists all local targets regardless of id prefix", async () => {
        await manager.createChallenge({
            id: "target-a",
            title: "target-a",
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
                id: "target-b",
                title: "target-b",
                difficulty: "easy",
                description: "",
                level: 1,
                total_score: 100,
                total_got_score: 0,
                flag_count: 1,
                flag_got_count: 0,
                hint_viewed: false,
                instance_status: "running",
                entrypoint: ["10.0.0.1:443"],
            },
            "test",
        )

        const challenges = await manager.listStoredChallenges()
        expect(challenges.map((item) => item.id).sort()).toEqual(["target-a", "target-b"])
        expect((await manager.getChallenge("target-b"))?.id).toBe("target-b")
    })

    test("listChallengesSafe reads local files", async () => {
        await saveChallengeRecord(
            challengeDir,
            {
                id: "local-a",
                title: "local-a",
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
                id: "local-b",
                title: "local-b",
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

        const challenges = await manager.listChallengesSafe("test")
        expect(challenges.map((item) => item.id).sort()).toEqual(["local-a", "local-b"])
    })

    test("launchSolver starts challenge and records attempt", async () => {
        const config = {
            getHostSettings: async () => ({ runtime: {}, challenge: {}, planner: { strategy: "Do not splice this whole planner strategy verbatim into the solver." } }),
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
            // Judged a false positive by the verifier -> must not enter the brief's Findings summary (in engagement an "invalid finding" = rejected, not correct:false).
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
        manager.attachRuntime({ launch, list: () => [] } as never)

        const solver = await manager.launchSolver("mock-launch", "pentest-orchestrator", {
            plannerHandoff: "Prioritize checking the upload chain; only look at the hint when clearly necessary.",
        })
        const attempts = await manager.listAttemptLogs("mock-launch")

        expect(launch).toHaveBeenCalledTimes(1)
        expect(solver.challengeId).toBe("mock-launch")
        expect(solver.task).toContain("Target id: mock-launch")
        expect(solver.task).toContain("authorized penetration-test operator")
        expect(solver.task).toContain("Startup brief:")
        expect(solver.task).toContain("Prioritize checking the upload chain; only look at the hint when clearly necessary.")
        expect(solver.task).not.toContain("User extra strategy (includes hint strategy, if any):")
        expect(solver.task).not.toContain("Do not splice this whole planner strategy verbatim into the solver.")
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
        // Opt 3: the shared operational-state section is always injected (even when currently empty), so the solver knows to reuse rather than re-discover.
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
        manager.attachRuntime({ launch, list: () => [] } as never)

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

    test("launchSolver enforces maxSolvers as a hard cap (rejects when at capacity)", async () => {
        const config = {
            // maxSolvers=2: the concurrency cap configured in the UI.
            getHostSettings: async () => ({ runtime: { maxSolvers: 2 }, challenge: {}, planner: {} }),
            getPrompt: async () => ({ meta: { isSubagent: false } }),
            listAgentPrompts: async () => [],
            listModelPrefs: async () => [],
        } as unknown as ConfigManager
        manager = new ChallengeManager(config)
        await manager.createChallenge({
            id: "mock-cap-target",
            title: "mock-cap-target",
            difficulty: "-",
            description: "",
            level: 0,
            total_score: 0,
            total_got_score: 0,
            flag_count: 0,
            flag_got_count: 0,
            hint_viewed: false,
            hint_content: null,
            instance_status: "running",
            entrypoint: ["127.0.0.1:9000"],
            flags: [],
        })

        const launch = mock(async (_p: string, task: string, env?: Record<string, string>, options?: { solverId?: string }) => ({
            id: options?.solverId ?? "s",
            containerId: "c",
            name: "n",
            promptName: "kimi-security",
            task,
            challengeId: env?.TCH_CHALLENGE_ID,
            status: "running" as const,
            createdAt: Date.now(),
        }))
        // Already 2 active solvers (both starting|running count), exactly at the cap.
        const activeSolvers = [
            { id: "live-1", challengeId: "mock-cap-target", status: "running" },
            { id: "live-2", challengeId: "mock-cap-target", status: "starting" },
        ]
        manager.attachRuntime({ launch, list: () => activeSolvers } as never)

        // The 3rd launch request must be hard-rejected at the code layer and must never call runtime.launch.
        await expect(manager.launchSolver("mock-cap-target", "kimi-security")).rejects.toThrow(/solver capacity reached: 2\/2/)
        expect(launch).not.toHaveBeenCalled()

        // Drop to 1 active (one stopped) -> a slot is free -> allowed through.
        activeSolvers.pop()
        const solver = await manager.launchSolver("mock-cap-target", "kimi-security")
        expect(solver.challengeId).toBe("mock-cap-target")
        expect(launch).toHaveBeenCalledTimes(1)
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

    test("tryPromoteMemoryToChallenge dedupes and skips low-signal facts", async () => {
        await manager.createChallenge({
            id: "mock-promote",
            title: "mock-promote",
            difficulty: "-",
            description: "",
            level: 0,
            total_score: 0,
            total_got_score: 0,
            flag_count: 0,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: ["http://t"],
            flags: [],
        })
        const first = await manager.tryPromoteMemoryToChallenge({
            challengeId: "mock-promote",
            kind: "failure",
            content: "XMLRPC method execution blocked; only listMethods returned",
            source: "observer",
        })
        expect(first.promoted).toBe(true)
        const dup = await manager.tryPromoteMemoryToChallenge({
            challengeId: "mock-promote",
            kind: "failure",
            content: "  xmlrpc method execution blocked; only listmethods returned ",
            source: "observer",
        })
        expect(dup.promoted).toBe(false)
        expect(dup.duplicate).toBe(true)
        const skipped = await manager.tryPromoteMemoryToChallenge({
            challengeId: "mock-promote",
            kind: "fact",
            content: "vague progress note",
            source: "observer",
        })
        expect(skipped.promoted).toBe(false)
        const memory = await manager.listMemory("mock-promote")
        expect(memory).toHaveLength(1)
    })

    test("tryPromoteIdeaToChallenge only accepts verified or failed", async () => {
        await manager.createChallenge({
            id: "mock-idea-promote",
            title: "mock-idea-promote",
            difficulty: "-",
            description: "",
            level: 0,
            total_score: 0,
            total_got_score: 0,
            flag_count: 0,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: ["http://t"],
            flags: [],
        })
        const pending = await manager.tryPromoteIdeaToChallenge("mock-idea-promote", {
            content: "try upload bypass on /ai/clothes/",
            status: "pending",
        })
        expect(pending.promoted).toBe(false)
        const verified = await manager.tryPromoteIdeaToChallenge("mock-idea-promote", {
            content: "upload polyglot bypass on /ai/clothes/",
            status: "verified",
            result: "webshell uploaded",
        })
        expect(verified.promoted).toBe(true)
        const ideas = await manager.listIdeas("mock-idea-promote")
        expect(ideas.some((item) => item.status === "verified")).toBe(true)
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

    test("deleteChallenge removes local data and stops matching solvers", async () => {
        await manager.createChallenge({
            id: "mock-delete",
            title: "mock-delete",
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
        await manager.appendMemory({ challengeId: "mock-delete", kind: "note", content: "keep me gone", source: "test" })

        const stopSolver = mock(async () => {})
        const deleteSolver = mock(async () => {})
        const listAll = mock(async () => [
            { id: "solver-del-a", challengeId: "mock-delete", status: "stopped" },
            { id: "solver-del-b", challengeId: "other", status: "running" },
        ])
        manager.attachRuntime({ listAll, stopSolver, deleteSolver } as never)

        const result = await manager.deleteChallenge("mock-delete")
        expect(result.deletedSolvers).toEqual(["solver-del-a"])
        expect(stopSolver).not.toHaveBeenCalled()
        expect(deleteSolver).toHaveBeenCalledWith("solver-del-a")
        expect(await manager.getChallenge("mock-delete")).toBeUndefined()
        expect(await manager.listMemory("mock-delete")).toEqual([])
        await expect(manager.deleteChallenge("mock-delete")).rejects.toThrow("not found")
    })

    test("deleteChallenge rejects while solvers are still active", async () => {
        await manager.createChallenge({
            id: "mock-del-active",
            title: "mock-del-active",
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
            flags: [],
        })
        manager.attachRuntime({
            listAll: async () => [{ id: "solver-live", challengeId: "mock-del-active", status: "running" }],
        } as never)
        await expect(manager.deleteChallenge("mock-del-active")).rejects.toThrow(/still active/)
        expect(await manager.getChallenge("mock-del-active")).toBeDefined()
    })

    test("stopChallenge preserves entrypoint after instance stop", async () => {
        await manager.createChallenge({
            id: "mock-stop-ep",
            title: "mock-stop-ep",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["https://dbgaming.com", "http://dbgaming.com"],
            flags: [],
        })
        await manager.stopChallenge("mock-stop-ep")
        const challenge = await manager.getChallenge("mock-stop-ep")
        expect(challenge?.instance_status).toBe("stopped")
        expect(challenge?.entrypoint).toEqual(["https://dbgaming.com", "http://dbgaming.com"])
    })

    test("launchSolver blocks KALI_PROVISIONER during untouched phase", async () => {
        const config = {
            getHostSettings: async () => ({ runtime: { maxSolvers: 3 }, challenge: {}, planner: {} }),
            getPrompt: async () => ({ meta: { isSubagent: false } }),
            listAgentPrompts: async () => [],
            listModelPrefs: async () => [],
        } as unknown as ConfigManager
        manager = new ChallengeManager(config)
        await manager.createChallenge({
            id: "mock-kali-block",
            title: "mock-kali-block",
            difficulty: "easy",
            description: "recon only",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 0,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["http://target.test"],
            flags: [],
        })
        manager.attachRuntime({ launch: mock(async () => ({})), list: () => [], listAll: async () => [] } as never)
        await expect(manager.launchSolver("mock-kali-block", "KALI_PROVISIONER")).rejects.toThrow("blocked")
    })

    test("buildPlannerSnapshot hides KALI_PROVISIONER when no target is foothold or breakthrough", async () => {
        const config = {
            getHostSettings: async () => ({ runtime: { maxSolvers: 3 }, challenge: {}, planner: {} }),
            getPrompt: async () => ({ meta: { isSubagent: false } }),
            listAgentPrompts: async () => [
                { name: "RECON_SOLVER", meta: { isSubagent: false, disabled: false }, deleted: false },
                { name: "KALI_PROVISIONER", meta: { isSubagent: false, disabled: false }, deleted: false },
            ],
            listModelPrefs: async () => [],
        } as unknown as ConfigManager
        const kaliManager = new ChallengeManager(config)
        await kaliManager.createChallenge({
            id: "mock-kali-hide",
            title: "mock-kali-hide",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 0,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["http://target.test"],
            flags: [],
        })
        await appendChallengeAttemptLog(challengeDir, { challengeId: "mock-kali-hide", solverId: "s1", promptName: "RECON_SOLVER", task: "recon" })
        kaliManager.attachRuntime({ listAll: async () => [] } as never)

        const snapshot = (await (
            kaliManager as unknown as { buildPlannerSnapshot: (reason: string) => Promise<{ availableSolverPrompts: Array<{ name: string }> }> }
        ).buildPlannerSnapshot("test")) as { availableSolverPrompts: Array<{ name: string }> }

        const names = snapshot.availableSolverPrompts.map((prompt) => prompt.name)
        expect(names).toContain("RECON_SOLVER")
        expect(names).not.toContain("KALI_PROVISIONER")
    })

    test("pauseTargetTesting stops solvers and blocks launch; resume clears pause flag", async () => {
        await manager.createChallenge({
            id: "mock-pause",
            title: "mock-pause",
            difficulty: "-",
            description: "",
            level: 0,
            total_score: 0,
            total_got_score: 0,
            flag_count: 0,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["https://example.com"],
            flags: [],
        })
        const stopSolver = mock(async () => {})
        const listAll = mock(async () => [{ id: "solver-p1", challengeId: "mock-pause", status: "running" }])
        manager.attachRuntime({ listAll, stopSolver } as never)

        const paused = await manager.pauseTargetTesting("mock-pause")
        expect(paused.stoppedSolvers).toEqual(["solver-p1"])
        expect(stopSolver).toHaveBeenCalledWith("solver-p1")
        const afterPause = await manager.getChallenge("mock-pause")
        expect(afterPause?.testing_paused).toBe(true)
        await expect(manager.launchSolver("mock-pause", "kimi-security")).rejects.toThrow("paused")

        const resumeSolver = mock(async () => ({ id: "solver-p1", status: "running" }))
        manager.attachRuntime({ listAll, stopSolver, resumeSolver } as never)
        const resumed = await manager.resumeTargetTesting("mock-pause")
        expect(resumed.resumed).toEqual(["solver-p1"])
        expect(resumeSolver).toHaveBeenCalled()
        const afterResume = await manager.getChallenge("mock-pause")
        expect(afterResume?.testing_paused).toBe(false)
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
        expect(challenge?.entrypoint).toEqual(["127.0.0.1:8080"])
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

        // Key point: steer goes through sendCommand(type:"steer"), without restarting the solver (no stop/launch call).
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

    test("planner snapshot carries solver results (result-aware scheduling)", async () => {
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

        // Drop one credential memory (pivot signal), one failure boundary, one verified idea, and one recorded finding.
        await manager.appendMemory({ challengeId: "mock-results", kind: "credential", content: "admin:Sup3r! for /admin panel", source: "observer" })
        await manager.appendMemory({ challengeId: "mock-results", kind: "failure", content: "union/error SQLi on /login dead-ended; parameterized", source: "observer" })
        await manager.addIdea("mock-results", { content: "polyglot php upload bypass", status: "verified", result: "webshell dropped" })
        await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "mock-results",
            flag: "webshell at /uploads/x.php",
            // Engagement semantics: report_finding writes correct:false (no judge). This entry should still count as a real result (not rejected by the verifier).
            correct: false,
            writeup: "upload bypass -> webshell -> dumped db creds",
        })
        // Create an attempt record so the target is not judged untouched.
        await appendChallengeAttemptLog(challengeDir, { challengeId: "mock-results", solverId: "solver-x", promptName: "p", task: "recon" })
        // Structured operational asset: one credential (reused across solvers).
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
        // credential memory -> foothold signal -> enters the foothold/breakthrough phase (with a correct finding -> breakthrough).
        expect(item?.progressPhase).toBe("breakthrough")
        // credential fills the facts section first.
        expect(item?.memoryFacts.some((line) => line.includes("[credential]") && line.includes("admin:Sup3r!"))).toBe(true)
        // Failure boundaries listed separately, so the planner avoids already-dead routes.
        expect(item?.failureBoundaries.some((line) => line.includes("union/error SQLi"))).toBe(true)
        // Live hypotheses carry status.
        expect(item?.liveIdeas.some((line) => line.includes("[verified]") && line.includes("polyglot"))).toBe(true)
        // Recorded findings are driven by the writeup.
        expect(item?.findings.some((line) => line.includes("upload bypass"))).toBe(true)
        expect(item?.ideaStatusCounts.verified).toBe(1)
        // Difficulty-aware numeric signal. Regression guard: an engagement finding (correct:false) must still count -> successRate reflects the result,
        // rather than degrading into a reverse value of "more findings = lower score".
        expect(typeof (item as unknown as { successRate: number })?.successRate).toBe("number")
        expect((item as unknown as { successRate: number })?.successRate).toBeGreaterThan(0)
        // 1 real result / (1 total submission) via Laplace -> (1+1)/(1+2) ≈ 0.667, which must be clearly higher than the 1/3 of "zero results".
        expect((item as unknown as { successRate: number })?.successRate).toBeGreaterThan(0.5)
        expect((item as unknown as { failedRouteCount: number })?.failedRouteCount).toBeGreaterThanOrEqual(1)
        expect(typeof (item as unknown as { effortRank: number })?.effortRank).toBe("number")
        // With a foothold (credential) + verified idea + correct finding -> never recommend pruning.
        expect((item as unknown as { pruneRecommended: boolean })?.pruneRecommended).toBe(false)
        // The structured operational asset enters the snapshot; the credential is visible to the scheduling layer.
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
        // 3 dead routes: 2 failure memories + 1 failed idea. No credential, no testing/pending/verified.
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
        // config stub has no resolvePromptSession -> verifyObjective takes the "verifier unavailable" fallback:
        // judges inconclusive, never winds down.
        await manager.verifyObjective({
            challengeId: "verify-fallback",
            recordId: record.id,
            proof: "uid=0(root)",
            onResolved: (verdict, note) => resolved.push({ verdict, note }),
        })

        expect(resolved).toHaveLength(1)
        expect(resolved[0].verdict).toBe("inconclusive")
        // Key point: an unavailable verifier must never silently wind down.
        const challenge = await manager.getChallenge("verify-fallback")
        expect(challenge?.objective_achieved).not.toBe(true)
        const submissions = await manager.listSubmissionLogs("verify-fallback")
        expect(submissions.find((s) => s.id === record.id)?.verification_status).toBe("inconclusive")
    })
})
