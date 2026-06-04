import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const requestHostBridge = mock(async () => ({
    challenge_id: "chal-1",
    is_completed: false,
    challenge: {
        id: "chal-1",
        title: "Upload",
        difficulty: "easy",
        level: 1,
        instance_status: "running",
        entrypoint: ["http://target"],
        flag_count: 2,
        flag_got_count: 0,
        hint_viewed: true,
        hint_content: "focus on upload parser",
        updated_at: "2026-04-12T00:00:00.000Z",
    },
}))

const resolveModelPref = mock(async () => ({
    model: { provider: "openai", id: "kimi-fast" },
    thinkingLevel: "low",
}))

const configInstance = {
    auth: {},
    models: {},
    settings: {},
    resolveModelPref,
}

let capturedLoaderOptions: { systemPromptOverride: () => string } | undefined
let capturedCreateSessionOptions: Record<string, unknown> | undefined
let capturedPrompt = ""
let lastSession: { prompt: ReturnType<typeof mock>; subscribe: ReturnType<typeof mock>; dispose: ReturnType<typeof mock> } | undefined

class FakeDefaultResourceLoader {
    constructor(options: { systemPromptOverride: () => string }) {
        capturedLoaderOptions = options
    }

    async reload(): Promise<void> {}
}

const sessionManagerCreate = mock((cwd: string, sessionDir: string) => ({ cwd, sessionDir }))

const createAgentSession = mock(async (options: Record<string, unknown>) => {
    capturedCreateSessionOptions = options
    let subscriber: ((event: unknown) => void) | undefined
    lastSession = {
        subscribe: mock((fn: (event: unknown) => void) => {
            subscriber = fn
            return () => {}
        }),
        prompt: mock(async (message: string) => {
            capturedPrompt = message
            subscriber?.({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "observer summary" }] },
            })
        }),
        dispose: mock(() => {}),
    }
    return { session: lastSession }
})

mock.module("../../../challenge/host-bridge-client", () => ({
    requestHostBridge,
}))

mock.module("../../../config/index", () => ({
    DEFAULT_CONFIG_DIR: "/tmp/test-config",
    ConfigManager: {
        getInstance: async () => configInstance,
    },
}))

const createObserverSidecarToolsWithOptions = mock((_options?: {
    sendCorrectionNotice?: (message: string) => void
    getSolverEntries?: () => Promise<unknown[]> | unknown[]
}) => [
    { name: "memory_list" },
    { name: "query_solver_history" },
    { name: "send_efficiency_reminder" },
])

mock.module("./tools", () => ({
    createObserverSidecarToolsWithOptions,
}))

// Bun's mock.module is a process-wide global: listing only some exports turns the real SDK's remaining exports (such as defineTool)
// into undefined in other test files, polluting manager.test.ts and others. Spread the real module first, then override the exports this test wants to fake.
const realPiCodingAgent = await import("@mariozechner/pi-coding-agent")
mock.module("@mariozechner/pi-coding-agent", () => ({
    ...realPiCodingAgent,
    DefaultResourceLoader: FakeDefaultResourceLoader,
    SessionManager: {
        create: sessionManagerCreate,
        open: mock(() => ({
            getEntries: () => [],
        })),
    },
    createAgentSession,
}))

const { runSolverObserverReview } = await import("./observer-agent")

let solverSessionDir = ""
let solverWorkspaceDir = ""

beforeEach(async () => {
    solverSessionDir = await mkdtemp(resolve(tmpdir(), "tch-observer-session-"))
    solverWorkspaceDir = await mkdtemp(resolve(tmpdir(), "tch-observer-workspace-"))
    process.env.TCH_SOLVER_SESSION_DIR = solverSessionDir
    process.env.TCH_SOLVER_WORKSPACE = solverWorkspaceDir
    // These assertions target the CTF-mode challenge-context format (difficulty/flags/hint, etc.);
    // explicitly turn off engagement mode so the default-on case doesn't switch to the Target State wording.
    process.env.TCH_ENGAGEMENT_MODE = "0"
    capturedLoaderOptions = undefined
    capturedCreateSessionOptions = undefined
    capturedPrompt = ""
    lastSession = undefined
    requestHostBridge.mockClear()
    resolveModelPref.mockClear()
    createAgentSession.mockClear()
    createObserverSidecarToolsWithOptions.mockClear()
    sessionManagerCreate.mockClear()
})

afterEach(async () => {
    delete process.env.TCH_SOLVER_SESSION_DIR
    delete process.env.TCH_SOLVER_WORKSPACE
    delete process.env.TCH_ENGAGEMENT_MODE
    await rm(solverSessionDir, { recursive: true, force: true })
    await rm(solverWorkspaceDir, { recursive: true, force: true })
})

describe("runSolverObserverReview", () => {
    test("returns early when no rounds are provided", async () => {
        const result = await runSolverObserverReview("chal-1", {
            reason: "periodic",
            rounds: [],
            session_context: "",
            branch_entry_count: 0,
            message_count: 0,
        })

        expect(result).toEqual({ applied: false })
        expect(requestHostBridge).not.toHaveBeenCalled()
        expect(createAgentSession).not.toHaveBeenCalled()
    })

    test("creates observer session and prompts with challenge context", async () => {
        const result = await runSolverObserverReview(
            "chal-1",
            {
                reason: "hint",
                rounds: [{ round: 2, assistant_summary: "try upload", tool_logs: [] }],
                session_context: "current_effective_context",
                branch_entry_count: 3,
                message_count: 7,
            },
            { observerModel: "kimi-fast" },
        )

        expect(result).toEqual({ applied: true, summary: "observer summary" })
        expect(resolveModelPref).toHaveBeenCalledWith("kimi-fast")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("observer sidecar")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("reply only `NO_CHANGE`")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("keep memory under 12 entries")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("Each round's user prompt provides only dynamic context")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("send_efficiency_reminder")
        expect(capturedLoaderOptions?.systemPromptOverride()).toContain("query_solver_history")
        expect(sessionManagerCreate).toHaveBeenCalledWith(solverWorkspaceDir, join(solverSessionDir, ".observer"))
        expect(createObserverSidecarToolsWithOptions).toHaveBeenCalledTimes(1)
        expect(capturedCreateSessionOptions).toMatchObject({
            cwd: solverWorkspaceDir,
            model: { provider: "openai", id: "kimi-fast" },
            thinkingLevel: "low",
            customTools: [{ name: "memory_list" }, { name: "query_solver_history" }, { name: "send_efficiency_reminder" }],
        })
        expect(capturedPrompt).toContain("## Challenge State")
        expect(capturedPrompt).toContain("- id: chal-1")
        expect(capturedPrompt).toContain("<solver-context>")
        expect(capturedPrompt).toContain("current_effective_context")
        expect(capturedPrompt).toContain("</solver-context>")
        expect(capturedPrompt).toContain("focus on upload parser")
        expect(capturedPrompt).toContain("## Recent Solver Activity")
        expect(capturedPrompt).toContain("### Round 2")
        expect(capturedPrompt).toContain("- assistant: try upload")
        expect(capturedPrompt).not.toContain("Do not solve the challenge yourself; only maintain the strategy board.")
        expect(capturedPrompt).not.toContain("The goal is to maintain the ideas / memory board, not to explain the solver process.")
        expect(lastSession?.dispose).toHaveBeenCalled()
    })
})
