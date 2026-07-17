import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent"
import type { AgentSession, CreateAgentSessionOptions, ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { mkdir } from "node:fs/promises"
import { ConfigManager } from "../config/index"
import type { PromptFile } from "../config/prompts/index"
import type { SolverInitPayload } from "./rpc/rpc-types"
import { solverDir, solverSessionDir, solverWorkspaceDir } from "../runtime/types"
import { challengeObserverExtension } from "./extension/challenge-observer/index"
import { execSurfaceExtension } from "./extension/exec-surface"
import { largeToolResultExtension } from "./extension/large-tool-result"
import { isEngagementMode, loadEngagementScope } from "../challenge/engagement"

export interface SolverSession {
    session: AgentSession
    sessionDir: string
    workspaceDir: string
}

export interface SubagentSession {
    session: AgentSession
    baseDir: string
    sessionDir: string
    workspaceDir: string
}

export function resolveObserverModelId(hostModel: string | undefined, promptModel: string | undefined): string | undefined {
    return hostModel?.trim() || promptModel?.trim() || undefined
}

export type SolverStartupDebugValue = string | number | boolean | null | undefined | SolverStartupDebugValue[] | { [key: string]: SolverStartupDebugValue }

export interface SolverStartupSnapshot {
    createdAt: number
    init: SolverInitPayload
    prompt: PromptFile
    paths: { solverDir: string; sessionDir: string; workspaceDir: string }
    sessionOptions: SolverStartupDebugValue
}

export interface SubagentStartupSnapshot {
    createdAt: number
    init: { promptName: string; task: string; parentToolCallId?: string; step?: number }
    prompt: PromptFile
    paths: { subagentDir: string; sessionDir: string; workspaceDir: string }
    sessionOptions: SolverStartupDebugValue
}

function readInjectedPath(name: string): string | undefined {
    const value = process.env[name]?.trim()
    return value ? value : undefined
}

export function buildSolverStartupSnapshot(
    init: SolverInitPayload,
    prompt: PromptFile,
    sessionOpts: CreateAgentSessionOptions,
    paths: { solverDir: string; sessionDir: string; workspaceDir: string },
): SolverStartupSnapshot {
    return {
        createdAt: Date.now(),
        init,
        prompt,
        paths,
        sessionOptions: sanitizeForDebug(sessionOpts),
    }
}

export function buildSubagentStartupSnapshot(
    promptName: string,
    task: string,
    parentToolCallId: string | undefined,
    step: number | undefined,
    prompt: PromptFile,
    sessionOpts: CreateAgentSessionOptions,
    paths: { subagentDir: string; sessionDir: string; workspaceDir: string },
): SubagentStartupSnapshot {
    return {
        createdAt: Date.now(),
        init: { promptName, task, parentToolCallId, step },
        prompt,
        paths,
        sessionOptions: sanitizeForDebug(sessionOpts),
    }
}

function sanitizeForDebug(value: unknown, depth = 0): SolverStartupDebugValue {
    if (value == null) return value
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
    if (depth >= 4) return `[${value.constructor?.name || "Object"}]`

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForDebug(item, depth + 1))
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
        if (entries.length === 0) return `[${value.constructor?.name || "Object"}]`

        return Object.fromEntries(entries.map(([key, item]) => [key, sanitizeForDebug(item, depth + 1)]))
    }

    return String(value)
}

/**
 * Create an AgentSession configured for a solver.
 * Resolves prompt config, prepares directories, returns the session.
 * Caller is responsible for sending prompts and disposing.
 */
export async function createSolverSession(init: SolverInitPayload): Promise<SolverSession> {
    const config = await ConfigManager.getInstance()

    const workspaceDir = readInjectedPath("TCH_SOLVER_WORKSPACE") ?? solverWorkspaceDir(init.solverId)
    const sessionDir = readInjectedPath("TCH_SOLVER_SESSION_DIR") ?? solverSessionDir(init.solverId)
    const baseDir = readInjectedPath("TCH_SOLVER_BASE_DIR") ?? solverDir(init.solverId)
    const startupPath = readInjectedPath("TCH_SOLVER_STARTUP_PATH") ?? `${baseDir}/startup.json`
    await mkdir(baseDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    const prompt = await config.getPrompt(init.promptName)
    if (!prompt) {
        throw new Error(`prompt not found: ${init.promptName}`)
    }
    if (prompt.meta.isSubagent) {
        throw new Error(`subagent prompt cannot be started as solver: ${init.promptName}`)
    }

    const observerEnabled = prompt.meta.observerEnabled === true
    // Observer model fallback chain: explicit `observerModel` → the solver's own `model` → (in observer-agent)
    // the global default Agent model. So by default the observer runs on the SAME model as the solver it
    // supervises (never silently weaker than the solver). The independent Verifier likewise tracks the global
    // default (kept in sync by activateModelGlobally). Verifier soundness comes from demanding fresh,
    // self-generated reproduction evidence — not from being a bigger model — so a capable default is enough;
    // set a strong global default model and all three (solver-default / observer / verifier) benefit together.
    const hostSettings = await config.getHostSettings()
    const observerModel = resolveObserverModelId(
        hostSettings.challenge.observerModel,
        typeof prompt.meta.observerModel === "string" ? prompt.meta.observerModel : undefined,
    )

    const extensions = [
        execSurfaceExtension(),
        // Context compaction: tool output over threshold (default 32KB) spills to workspace .tool-results/,
        // context keeps ~600-char preview + path with grep/chunk hints. Avoids nmap/ffuf/nuclei
        // flooding context. Before observer so hooks see compressed results.
        largeToolResultExtension({ workspaceRoot: workspaceDir }),
        challengeObserverExtension({ observerEnabled, observerModel }),
    ]

    const sessionOpts = await config.resolvePromptSession(init.promptName, extensions)
    if (!sessionOpts) {
        throw new Error(`prompt not found: ${init.promptName}`)
    }
    const startupSnapshot = buildSolverStartupSnapshot(init, prompt, sessionOpts, {
        solverDir: baseDir,
        sessionDir,
        workspaceDir,
    })
    await Bun.write(startupPath, JSON.stringify(startupSnapshot, null, 2))

    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: workspaceDir,
        // resume: continue persisted session (full history/findings); else new empty session.
        sessionManager: init.resume
            ? SessionManager.continueRecent(workspaceDir, sessionDir)
            : SessionManager.create(workspaceDir, sessionDir),
    })
    await session.bindExtensions({})

    // SDK auto-compaction already defaults to enabled (summarizes older turns once context nears the
    // window limit, keeps recent messages verbatim — see pi-coding-agent's compaction settings). Pin it
    // explicitly for solvers so long unattended engagements (hours, hundreds of rounds under the Planner,
    // nobody at the Runtime UI to click "compact") never silently run with it off, regardless of global
    // settings.json. The durable memory that survives each compaction is the observer board + task.md
    // (file-backed, read fresh via tools, never part of the summarized transcript) — see the `pentest`
    // skill's "Burned Paths" discipline. Operators can still flip this per-solver via the existing
    // `set_auto_compaction` RPC command.
    try {
        session.setAutoCompactionEnabled(true)
    } catch {
        // Older/alternate SDK builds may not support this — non-fatal, solver still runs.
    }

    return { session, sessionDir, workspaceDir }
}

export async function createSubagentSession(promptName: string, task: string): Promise<SubagentSession> {
    const solverWorkspace = process.env.TCH_SOLVER_WORKSPACE?.trim()
    if (!solverWorkspace) {
        throw new Error("TCH_SOLVER_WORKSPACE is required for subagent sessions")
    }

    const config = await ConfigManager.getInstance()
    const prompt = await config.getPrompt(promptName)
    if (!prompt) {
        throw new Error(`prompt not found: ${promptName}`)
    }
    if (prompt.meta.isSubagent !== true) {
        throw new Error(`prompt is not a subagent: ${promptName}`)
    }

    const baseDir = process.cwd()
    const sessionDir = `${baseDir}/session`
    const workspaceDir = solverWorkspace
    const parentToolCallId = process.env.TCH_SUBAGENT_PARENT_TOOL_CALL_ID?.trim() || undefined
    const stepValue = process.env.TCH_SUBAGENT_STEP?.trim()
    const step = stepValue && Number.isFinite(Number(stepValue)) ? Number(stepValue) : undefined
    await mkdir(baseDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    const extensionFactories: ExtensionFactory[] = [
        // Subagent tool output may be large; same compaction (shared workspace .tool-results/).
        largeToolResultExtension({ workspaceRoot: workspaceDir }),
    ]

    const sessionOpts = await config.resolvePromptSession(promptName, extensionFactories)
    if (!sessionOpts) {
        throw new Error(`prompt not found: ${promptName}`)
    }

    const startupSnapshot = buildSubagentStartupSnapshot(promptName, task, parentToolCallId, step, prompt, sessionOpts, {
        subagentDir: baseDir,
        sessionDir,
        workspaceDir,
    })
    await Bun.write(`${baseDir}/startup.json`, JSON.stringify(startupSnapshot, null, 2))

    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: workspaceDir,
        sessionManager: SessionManager.create(workspaceDir, sessionDir),
    })
    await session.bindExtensions({})

    return { session, baseDir, sessionDir, workspaceDir }
}
