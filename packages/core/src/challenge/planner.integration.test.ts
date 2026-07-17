import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_PLANNER_PROMPT_NAME } from "../config/prompts/index"
import { CHALLENGE_ENV_DIR } from "./env"
import { ChallengeManager } from "./manager"
import type { RuntimeManager } from "../runtime/runtime"

let challengeDir = ""
let manager: ChallengeManager
const TARGET_ID = "planner-target"
let runtimeSolvers: Array<{ id: string; status: "running"; challengeId: string; promptName: string; createdAt: number }> = []

const createAgentSession = mock(async (opts: {
    customTools?: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>
}) => {
    const setPlan = opts.customTools?.find((tool) => tool.name === "planner_set_plan")
    const launchSolver = opts.customTools?.find((tool) => tool.name === "planner_launch_solver")
    type Subscriber = (event: {
        type: string
        message?: { role: string; content: Array<{ type: string; text?: string }>; stopReason?: string }
    }) => void
    let subscriber: Subscriber | undefined
    const session = {
        subscribe(fn: Subscriber) {
            subscriber = fn
        },
        async prompt() {
            if (setPlan) {
                await setPlan.execute("tc-planner-1", {
                    challengeId: TARGET_ID,
                    strategy: "focus upload surface and verify RCE",
                    nextCheckpoint: "confirm shell on target",
                })
            }
            if (launchSolver) {
                await launchSolver.execute("tc-planner-2", {
                    challengeId: TARGET_ID,
                    promptName: "kimi-security",
                    solverHandoff: "Recon the upload surface and record only verified typed assets.",
                })
            }
            subscriber?.({
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "planner round complete" }],
                    stopReason: "end_turn",
                },
            })
        },
        dispose() {},
    }
    return { session }
})

const realPiCodingAgent = await import("@mariozechner/pi-coding-agent")
mock.module("@mariozechner/pi-coding-agent", () => ({
    ...realPiCodingAgent,
    createAgentSession,
}))

const { ChallengeManager: ChallengeManagerImpl } = await import("./manager")

beforeEach(async () => {
    challengeDir = await mkdtemp(join(tmpdir(), "tch-planner-integration-"))
    process.env[CHALLENGE_ENV_DIR] = challengeDir
    createAgentSession.mockClear()
    runtimeSolvers = []

    const fakeResourceLoader = {
        getExtensions: () => [],
        getSkills: () => [],
        getPrompts: () => [],
        getThemes: () => [],
        getAgentsFiles: () => [],
        getSystemPrompt: () =>
            "Planner state: {{CHALLENGE_STATE}}\nPrompts: {{AVAILABLE_SOLVER_PROMPTS}}\nStrategy: {{USER_STRATEGY}}\nPrevious: {{PREVIOUS_PLANNER_ROUND}}",
        getAppendSystemPrompt: () => undefined,
        extendResources: () => {},
        reload: async () => {},
    }

    const config = {
        getHostSettings: async () => ({
            runtime: { maxSolvers: 3 },
            challenge: {},
            planner: { enabled: true, tickIntervalMs: 30_000, staleTimeoutMs: 3_600_000, strategy: "test strategy" },
        }),
        getPrompt: async () => ({ meta: { isSubagent: false } }),
        listAgentPrompts: async () => [
            { name: "kimi-security", meta: { isSubagent: false, disabled: false }, deleted: false },
        ],
        listModelPrefs: async () => [],
        resolvePromptSession: async (name: string) => {
            if (name !== CHALLENGE_PLANNER_PROMPT_NAME) return undefined
            return {
                resourceLoader: fakeResourceLoader,
                customTools: [],
                model: { provider: "mock", id: "mock-model" },
            }
        },
    } as unknown as ConfigManager

    manager = new ChallengeManagerImpl(config)

    const runtime = {
        listAll: async () => runtimeSolvers,
        list: () => runtimeSolvers,
        launch: mock(async (promptName: string, task: string) => {
            const solver = {
                id: "solver-mock",
                containerId: "solver-mock",
                name: "solver-mock",
                status: "running" as const,
                challengeId: TARGET_ID,
                promptName,
                task,
                createdAt: Date.now(),
            }
            runtimeSolvers.push(solver)
            return solver
        }),
        stopSolver: mock(async () => {}),
        sendCommand: mock(() => {}),
    } as unknown as RuntimeManager
    manager.attachRuntime(runtime)

    await manager.createChallenge({
        id: TARGET_ID,
        title: TARGET_ID,
        difficulty: "medium",
        description: "integration test target",
        level: 1,
        total_score: 100,
        total_got_score: 0,
        flag_count: 1,
        flag_got_count: 0,
        hint_viewed: false,
        hint_content: "",
        instance_status: "running",
        entrypoint: ["10.0.0.5:80"],
        flags: ["flag{planner}"],
    })
    await manager.addIdea(TARGET_ID, {
        content: "Try file upload bypass on /upload endpoint",
        status: "pending",
    })
})

afterEach(async () => {
    delete process.env[CHALLENGE_ENV_DIR]
    await rm(challengeDir, { recursive: true, force: true })
})

describe("planner integration smoke", () => {
    test("tickPlanner persists battle plan from mock LLM tool call", async () => {
        const outcome = await manager.tickPlanner("planner-integration-test")
        expect(outcome.ok).toBe(true)
        if (outcome.ok) expect(outcome.skipped).toBeFalsy()
        expect(createAgentSession).toHaveBeenCalled()

        const roundFile = Bun.file(join(challengeDir, "planner-last-round.json"))
        expect(await roundFile.exists()).toBe(true)
        const round = (await roundFile.json()) as {
            battlePlan?: Array<{ challengeId: string; strategy: string; nextCheckpoint?: string }>
            summary?: string
        }
        const entry = round.battlePlan?.find((item) => item.challengeId === TARGET_ID)
        expect(entry?.strategy).toContain("upload surface")
        expect(entry?.nextCheckpoint).toContain("shell")
        expect(round.summary).toContain("planner round complete")
        expect(runtimeSolvers.map((solver) => solver.id)).toContain("solver-mock")
    })
})
