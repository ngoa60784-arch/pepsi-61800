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

// Bun 的 mock.module 是进程级全局：只列部分导出会让真实 SDK 的其余导出（如 defineTool）
// 在别的测试文件里变成 undefined，污染 manager.test.ts 等。先展开真实模块，再覆盖本测试要 fake 的导出。
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
    // 这些断言针对 CTF 模式的 challenge-context 格式（difficulty/flags/hint 等），
    // 显式关闭 engagement 模式，避免默认开启时切到 Target State 文案。
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
        expect(capturedPrompt).not.toContain("不要自己解题，只做策略看板维护。")
        expect(capturedPrompt).not.toContain("目标是维护 ideas / memory 看板，不是解释 solver 过程。")
        expect(lastSession?.dispose).toHaveBeenCalled()
    })
})
