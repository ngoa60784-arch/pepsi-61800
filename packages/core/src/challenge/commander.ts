import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager } from "@mariozechner/pi-coding-agent"
import type { AgentSession, CreateAgentSessionOptions, ToolDefinition } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { relative, resolve, sep } from "node:path"
import { mkdir, rm } from "node:fs/promises"
import type { ConfigManager } from "../config/index"
import { DEFAULT_CONFIG_DIR } from "../config/index"
import type { ChallengeManager } from "./manager"
import type { RuntimeSolverDetails } from "../runtime/types"
import { isEngagementMode } from "./engagement"

/**
 * Commander —— conversational penetration-test commander.
 *
 * The operator gives objectives in natural language ("test example.com, focus on upload/SSRF"),
 * and this resident LLM agent handles: filling in the entrypoint, creating the target, dispatching solvers (injecting the requirements as a handoff),
 * reporting progress, and stopping solvers / steering direction on command. It is the human-facing conversational entry point, alongside the planner.
 *
 * Difference from the planner: the planner is a periodic, unattended automatic scheduler (a one-off inMemory session);
 * the Commander is resident, multi-turn, and human-driven (a persisted session). Both reuse the same ChallengeManager capabilities.
 */

const COMMANDER_SYSTEM_PROMPT = `You are the penetration-test commander for BreachWeave.

The operator gives you engagement targets in natural language. Your job is to turn that into real action — not just reply with text.

## Your responsibilities
- Extract the target (IP / domain / URL) from what the operator says. If only a domain or host is given, fill in the entrypoint yourself: default to both http:// and https://, and infer common web ports (80/443/8080) as needed.
- Use create_target to register the target, then launch_solver to dispatch a solver. Carry the operator's emphasis (e.g. "focus on upload and SSRF", "leave the login endpoint alone") into the solver handoff brief.
- Default to acting immediately — do not repeatedly ask for confirmation. Only ask a short clarifying question if you genuinely cannot extract any usable target from the operator's message.
- When the operator asks for progress, check real state with list_solvers / get_solver_progress before answering — never fabricate.
- When the operator asks how a target is doing overall ("how far have we gotten / what's the progress / should we keep going"), call get_target_overview — it gives the derived phase (untouched/recon/foothold/breakthrough), success rate, prune recommendation, obtained assets, attack-graph edges, and what each running solver is focused on. This is the fastest way to answer "overall progress". get_solver_progress only has the raw memory/ideas/findings summary.
- When the operator asks about the DETAILED process — what commands a solver ran, a tool's raw output, why it's stuck, or which step it's on — use get_solver_trace (NOT get_solver_progress, which only has the memory/findings summary). get_solver_progress = "what's concluded"; get_solver_trace = "what it actually did, step by step".
- When the operator tells you to stop a solver, change direction, or add more force, use the matching tool.

## Resuming a half-finished target (operator uploads a prior pentest document) — STRICT ORDER
When the operator uploads a pentest record, the full document body is appended in the same user message after the marker <<<TCH_OPERATOR_UPLOAD>>> (the UI hides this block). Parse that section as the source of truth. You may also call read_operator_upload if you need to re-read it. Execute these tool calls in this EXACT order, and you must NOT call launch_solver until import_findings has returned:

1. **create_target** — register the target (use the address from the document; if none, ask the operator).
2. **import_findings** — parse the WHOLE document into the four buckets and load it into shared state:
   - assets: reusable creds / sessions / hosts / services (reference secrets by name via secret_ref, never plaintext)
   - facts: confirmed facts / evidence
   - deadends: routes already blocked — include the boundary (e.g. "WAF strips custom response headers", "redis-cli EVAL blocked by WAF")
   - ideas: hypotheses to test next
3. **launch_solver** — ONLY after import_findings succeeds. The solver's task is built from shared state at launch time, so if you launch before importing, the solver starts BLIND (empty memory/ideas/state) and re-discovers everything from zero — wasting the entire document. Put the highest-priority next move into the handoff too.

NEVER launch a solver before the import completes. If you launched one too early by mistake, stop it and relaunch after importing.

## Tools
- read_operator_upload(): re-read the operator's uploaded document for this turn (optional; the upload block is usually already in the user message).
- create_target(id, entrypoint, description): register an engagement target. Use a short readable id (e.g. "example-com"); entrypoint is an array of entry addresses.
- import_findings(targetId, assets, facts, deadends, ideas): load an operator-supplied "half-done" pentest progress into the target's shared state so all solvers and the scheduler build on it instead of restarting. Use this whenever the operator provides prior findings/creds/notes. MUST be called BEFORE launch_solver.
- launch_solver(targetId, handoff): dispatch one solver against a target. handoff is the solver's startup brief (emphasis, known info, constraints).
- list_targets(): list all current targets.
- list_solvers(): list all current solvers and their status.
- stop_solver(solverId): stop a solver.
- get_solver_progress(targetId): view the memory / findings summary for a target's solvers.
- get_target_overview(targetId): view the full progress overview of a target — derived phase (untouched/recon/foothold/breakthrough), success rate, prune recommendation, obtained assets (host/service/credential/session), attack-graph edges, confirmed facts, dead-ends, live hypotheses, findings, and each running solver's current focus. Use for "overall progress / how it's going / whether to keep investing". Richer than get_solver_progress.
- get_solver_trace(solverId, limit?, thread?): view a solver's DETAILED execution trace — the actual commands/tool calls it ran and their raw output, step by step. Use for "what is it doing / what did that command output / why is it stuck". Get the solverId from list_solvers first.

## Operational discipline
- Only register and dispatch against the target the operator actually gave you. Do not invent or expand targets, and never treat the solver's own Kali container or BreachWeave's own host/API as a target.

## Style
- Concise, direct, like a combat commander. Act first (call the tools), then tell the operator in a sentence or two what you did and the current situation.
- Don't echo raw tool JSON — report in plain language.
- Reply in the operator's language (default English; match Chinese if they write Chinese).`

const COMMANDER_SOLVER_PROMPT_NAME = "kimi-security"

interface CommanderEvent {
    type: "text_delta" | "message_end" | "tool_start" | "tool_end" | "error" | "rolled_back"
    text?: string
    toolName?: string
    args?: unknown
    isError?: boolean
}

type CommanderSubscriber = (event: CommanderEvent) => void

export interface CommanderSessionSummary {
    id: string
    path: string
    created: string
    modified: string
    messageCount: number
    preview: string
    active: boolean
}

function commanderSessionDir(): string {
    return resolve(DEFAULT_CONFIG_DIR, "commander-session")
}

/** Only allow deleting/opening session files under the commander session directory. */
export function resolveCommanderSessionPath(path: string): string {
    const sessionDir = commanderSessionDir()
    const resolved = resolve(path.trim())
    const rel = relative(sessionDir, resolved)
    if (rel.startsWith("..") || rel.split(sep).includes("..")) {
        throw new Error("invalid commander session path")
    }
    if (!resolved.endsWith(".jsonl")) {
        throw new Error("invalid commander session path")
    }
    return resolved
}

function clipSessionPreview(text: string | undefined): string {
    if (!text?.trim()) return "(空对话)"
    const oneLine = text.trim().replace(/\s+/g, " ")
    return oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine
}

/** Extract plain text from an SDK message.content: content may be a string or an array of {type,text} parts; keep only text parts. */
/** LLM sees the block; UI / rollback strip everything from this marker onward. */
export const OPERATOR_UPLOAD_BLOCK_BEGIN = "\n\n<<<TCH_OPERATOR_UPLOAD>>>"
export const OPERATOR_UPLOAD_BLOCK_END = "\n<<<END_TCH_OPERATOR_UPLOAD>>>"

/** Legacy prompts that only pointed at read_operator_upload. */
const OPERATOR_UPLOAD_HINT_RE = /\n\n（已上传文档「[^」]+」，请先调用 read_operator_upload 读取全文。）$/

export interface CommanderSendOptions {
    attachment?: { name: string; content: string }
}

/** Build the user turn persisted for the agent session (includes upload body when present). */
export function buildCommanderSessionPrompt(message: string, attachment?: { name: string; content: string }): string {
    const note = message.trim() || (attachment ? "请处理我上传的渗透记录文档。" : "")
    if (!note) throw new Error("message is required")
    if (!attachment) return note
    const name = attachment.name.trim() || "upload.txt"
    const body = attachment.content.trim()
    if (!body) throw new Error("attachment content is empty")
    return `${note}${OPERATOR_UPLOAD_BLOCK_BEGIN}\n--- 渗透记录文档（${name}）---\n${body}${OPERATOR_UPLOAD_BLOCK_END}`
}

/** Short text for Web UI bubbles and rollback input restoration. */
export function displayCommanderUserMessage(stored: string): string {
    const blockStart = stored.indexOf(OPERATOR_UPLOAD_BLOCK_BEGIN)
    if (blockStart >= 0) {
        const note = stored.slice(0, blockStart).trim()
        return note || "（渗透记录文档）"
    }
    const stripped = stored.replace(OPERATOR_UPLOAD_HINT_RE, "").trim()
    return stripped || stored
}

function extractEntryText(content: unknown): string {
    if (typeof content === "string") return content.trim()
    if (!Array.isArray(content)) return ""
    return content
        .filter((part): part is { type: string; text?: string } => !!part && typeof part === "object" && "type" in part)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim()
}

// ── Solver execution-trace extraction (lets the Commander see the detailed pentest process, not just the memory/ideas/findings summary) ──

interface TraceToolCall {
    name: string
    argSummary: string
    output: string
    isError: boolean
}

function clipTrace(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}\n… [truncated, ${text.length - maxChars} more chars — view the full transcript in the Runtime detail page]`
}

/** Collapse a single tool call's arguments into a one-line human-readable summary: bash shows the command itself, file tools show the path, everything else degrades to JSON. */
function summarizeToolArgs(name: string, args: unknown): string {
    if (!args || typeof args !== "object" || Array.isArray(args)) return ""
    const record = args as Record<string, unknown>
    if (typeof record.command === "string") return record.command.trim()
    const path = record.path ?? record.file_path
    if (typeof path === "string") {
        const pattern = typeof record.pattern === "string" ? `  pattern=${record.pattern}` : ""
        return `${path}${pattern}`
    }
    if (name === "record_relation" && typeof record.source === "string") {
        return `${record.source} --${String(record.relation ?? "")}--> ${String(record.target ?? "")}`
    }
    if (name === "find_attack_path") return `${String(record.start ?? "")} -> ${String(record.end ?? "")}`
    if ((name === "report_finding" || name === "record_asset") && typeof record.label === "string") return record.label
    try {
        return JSON.stringify(record)
    } catch {
        return String(record)
    }
}

/** Walk a thread's messages, pairing each assistant toolCall with its corresponding toolResult into an ordered list of execution actions. */
function extractThreadActions(messages: unknown[]): { actions: TraceToolCall[]; lastReasoning: string } {
    const results = new Map<string, { text: string; isError: boolean }>()
    for (const raw of messages) {
        if (!raw || typeof raw !== "object") continue
        const message = raw as { role?: unknown; toolCallId?: unknown; content?: unknown; isError?: unknown }
        if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue
        results.set(message.toolCallId, { text: extractEntryText(message.content), isError: message.isError === true })
    }

    const actions: TraceToolCall[] = []
    let lastReasoning = ""
    for (const raw of messages) {
        if (!raw || typeof raw !== "object") continue
        const message = raw as { role?: unknown; content?: unknown }
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue
        const text = extractEntryText(message.content)
        if (text) lastReasoning = text
        for (const part of message.content) {
            if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue
            const call = part as { id?: unknown; name?: unknown; arguments?: unknown }
            const id = typeof call.id === "string" ? call.id : ""
            const result = id ? results.get(id) : undefined
            actions.push({
                name: typeof call.name === "string" ? call.name : "(unknown tool)",
                argSummary: summarizeToolArgs(typeof call.name === "string" ? call.name : "", call.arguments),
                output: result?.text || "(no output captured yet — tool may still be running)",
                isError: result?.isError ?? false,
            })
        }
    }
    return { actions, lastReasoning }
}

/** Format solver details into an execution trace the Commander can read: the last N steps of "command + output" + the latest reasoning. */
function formatSolverTrace(
    details: RuntimeSolverDetails,
    options: { limit: number; threadKind: "main" | "subagent" | "observer" | "all" },
): string {
    const matched = options.threadKind === "all" ? details.threads : details.threads.filter((thread) => thread.kind === options.threadKind)
    if (matched.length === 0) {
        return `solver ${details.solver.id} has no "${options.threadKind}" thread yet (status: ${details.solver.status}).`
    }

    const allMessages = matched.flatMap((thread) => thread.messages as unknown[])
    const { actions, lastReasoning } = extractThreadActions(allMessages)
    const recent = actions.slice(-options.limit)

    const header = [
        `Solver ${details.solver.id} on target "${details.solver.challengeId ?? "-"}" — status: ${details.solver.status}`,
        `Thread: ${options.threadKind}; showing last ${recent.length} of ${actions.length} tool actions (each = a command/tool call + its output).`,
        details.solver.error ? `Solver error: ${details.solver.error}` : "",
    ]
        .filter((line) => line.length > 0)
        .join("\n")

    const body =
        recent.length > 0
            ? recent
                  .map((action, index) => {
                      const tag = action.isError ? " [ERROR]" : ""
                      return [`### Step ${actions.length - recent.length + index + 1}. ${action.name}${tag}`, `cmd/args: ${clipTrace(action.argSummary, 400) || "(none)"}`, `output:`, clipTrace(action.output, 800)].join(
                          "\n",
                      )
                  })
                  .join("\n\n")
            : "(this solver has not executed any tool calls yet)"

    const tail = lastReasoning ? `\n\n--- Latest solver reasoning ---\n${clipTrace(lastReasoning, 600)}` : ""
    return `${header}\n\n${body}${tail}`
}

export class CommanderManager {
    private readonly config: ConfigManager
    private readonly challenge: ChallengeManager
    private session: AgentSession | undefined
    private starting: Promise<AgentSession> | undefined
    private subscribers = new Set<CommanderSubscriber>()
    private running = false
    /** Persisted session file for the in-memory agent; drives list highlight and restart resume. */
    private activeSessionPath: string | undefined
    /** One-shot upload for the current operator turn; consumed by read_operator_upload. */
    private pendingOperatorUpload: { name: string; content: string } | undefined

    constructor(config: ConfigManager, challenge: ChallengeManager) {
        this.config = config
        this.challenge = challenge
    }

    subscribe(fn: CommanderSubscriber): () => void {
        this.subscribers.add(fn)
        return () => this.subscribers.delete(fn)
    }

    private emit(event: CommanderEvent): void {
        for (const fn of this.subscribers) {
            try {
                fn(event)
            } catch {
                // ignore subscriber errors
            }
        }
    }

    /** Resolve the Commander session config: the model uses the global default Agent model (the one selected in the UI); the system prompt is fixed to the commander prompt. */
    private async resolveSessionOptions(): Promise<CreateAgentSessionOptions> {
        const modelPrefs = await this.config.listModelPrefs()
        if (modelPrefs.length === 0) {
            throw new Error("No model configured yet: please first add a provider, API key, and model under Config → Providers / Models in the UI, then use the Commander.")
        }
        const defaultPrefId = (await this.config.resolveDefaultModelPrefId()) ?? modelPrefs[0].id
        const resolved = await this.config.resolveModelPref(defaultPrefId)

        const resourceLoader = new DefaultResourceLoader({
            agentDir: DEFAULT_CONFIG_DIR,
            systemPromptOverride: () => COMMANDER_SYSTEM_PROMPT,
            // The Commander loads no built-in skills/extensions; it uses only its own command tools.
            skillsOverride: (base) => ({ ...base, skills: [] }),
        })
        await resourceLoader.reload()

        return {
            model: resolved.model,
            thinkingLevel: resolved.thinkingLevel,
            tools: [],
            customTools: this.createCommanderTools(),
            resourceLoader,
            authStorage: this.config.auth,
            modelRegistry: this.config.models,
            settingsManager: this.config.settings,
        }
    }

    private getActiveSessionPath(): string | undefined {
        const manager = (this.session as unknown as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)
            ?.sessionManager
        return manager?.getSessionFile?.() ?? this.activeSessionPath
    }

    private async ensureSession(): Promise<AgentSession> {
        if (this.session) return this.session
        if (this.starting) return this.starting
        this.starting = (async () => {
            const opts = await this.resolveSessionOptions()
            const sessionDir = commanderSessionDir()
            await mkdir(sessionDir, { recursive: true })
            let sessionManager: SessionManager
            if (this.activeSessionPath && (await Bun.file(this.activeSessionPath).exists())) {
                sessionManager = SessionManager.open(this.activeSessionPath, sessionDir)
            } else {
                this.activeSessionPath = undefined
                sessionManager = SessionManager.continueRecent(sessionDir, sessionDir)
                this.activeSessionPath = sessionManager.getSessionFile()
            }
            const { session } = await createAgentSession({
                ...opts,
                cwd: sessionDir,
                sessionManager,
            })
            session.subscribe((event) => this.forwardSessionEvent(event))
            this.session = session
            this.activeSessionPath = sessionManager.getSessionFile() ?? this.activeSessionPath
            return session
        })()
        try {
            return await this.starting
        } finally {
            this.starting = undefined
        }
    }

    private async replaceSession(buildManager: (sessionDir: string) => SessionManager): Promise<void> {
        if (this.running) throw new Error("Commander is processing a message and cannot switch conversations")
        const opts = await this.resolveSessionOptions()
        const sessionDir = commanderSessionDir()
        await mkdir(sessionDir, { recursive: true })
        const sessionManager = buildManager(sessionDir)
        const previous = this.session
        const { session } = await createAgentSession({
            ...opts,
            cwd: sessionDir,
            sessionManager,
        })
        session.subscribe((event) => this.forwardSessionEvent(event))
        this.session = session
        this.activeSessionPath = sessionManager.getSessionFile()
        try {
            previous?.dispose()
        } catch {
            // ignore dispose errors
        }
        this.emit({ type: "rolled_back" })
    }

    private forwardSessionEvent(event: { type: string; [key: string]: unknown }): void {
        if (event.type === "message_update") {
            const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent
            if (inner?.type === "text_delta" && typeof inner.delta === "string") {
                this.emit({ type: "text_delta", text: inner.delta })
            }
            return
        }
        if (event.type === "message_end") {
            const message = (event as { message?: { role?: string } }).message
            if (message?.role === "assistant") this.emit({ type: "message_end" })
            return
        }
        if (event.type === "tool_execution_start") {
            this.emit({ type: "tool_start", toolName: String(event.toolName ?? ""), args: event.args })
            return
        }
        if (event.type === "tool_execution_end") {
            this.emit({ type: "tool_end", toolName: String(event.toolName ?? ""), isError: event.isError === true })
        }
    }

    private clearPendingOperatorUpload(): void {
        this.pendingOperatorUpload = undefined
    }

    private createCommanderTools(): ToolDefinition[] {
        const challenge = this.challenge
        const commander = this
        return [
            defineTool({
                name: "read_operator_upload",
                label: "Read Operator Upload",
                description:
                    "Re-read the operator's uploaded pentest document for this turn (same content as the <<<TCH_OPERATOR_UPLOAD>>> block in the user message). Use when you need the full text again.",
                parameters: Type.Object({}),
                execute: async () => {
                    const doc = commander.pendingOperatorUpload
                    if (!doc) throw new Error("当前轮次没有待读取的上传文档。")
                    commander.clearPendingOperatorUpload()
                    return {
                        content: [{ type: "text", text: `--- 渗透记录文档（${doc.name}）---\n${doc.content}` }],
                        details: { name: doc.name, chars: doc.content.length } as Record<string, unknown>,
                    }
                },
            }),
            defineTool({
                name: "create_target",
                label: "Create Target",
                description: "Create a penetration target. Use a short readable id; entrypoint is an array of entry addresses (e.g. [\"http://x\",\"https://x\"]).",
                parameters: Type.Object({
                    id: Type.String({ minLength: 1, description: "short id, e.g. example-com" }),
                    entrypoint: Type.Array(Type.String(), { description: "array of entry addresses, at least one" }),
                    description: Type.Optional(Type.String({ description: "target background / known info" })),
                }),
                execute: async (_id, params) => {
                    const targetId = params.id.trim()
                    const entrypoint = params.entrypoint.map((item) => item.trim()).filter((item) => item.length > 0)
                    if (!targetId) throw new Error("target id is required")
                    if (entrypoint.length === 0) throw new Error("at least one entrypoint is required")
                    const created = await challenge.createChallenge(
                        {
                            id: targetId,
                            title: targetId,
                            difficulty: "-",
                            description: params.description?.trim() || "",
                            level: 0,
                            total_score: 0,
                            total_got_score: 0,
                            flag_count: 0,
                            flag_got_count: 0,
                            hint_viewed: false,
                            hint_content: null,
                            instance_status: "running",
                            entrypoint,
                            flags: [],
                        },
                        "commander:create-target",
                    )
                    return {
                        content: [{ type: "text", text: `target "${targetId}" created with entrypoint ${entrypoint.join(", ")}` }],
                        details: created,
                    }
                },
            }),
            defineTool({
                name: "launch_solver",
                label: "Launch Solver",
                description: "Dispatch a solver against a target to start attacking. handoff is the solver's startup brief (emphasis, known info, constraints).",
                parameters: Type.Object({
                    targetId: Type.String({ minLength: 1 }),
                    handoff: Type.Optional(Type.String({ description: "startup brief for the solver" })),
                }),
                execute: async (_id, params) => {
                    const solver = await challenge.launchSolver(params.targetId.trim(), COMMANDER_SOLVER_PROMPT_NAME, {
                        plannerHandoff: params.handoff?.trim() || undefined,
                    })
                    return {
                        content: [{ type: "text", text: `solver ${solver.id} launched on target "${params.targetId}"` }],
                        details: { solverId: solver.id, status: solver.status },
                    }
                },
            }),
            defineTool({
                name: "list_targets",
                label: "List Targets",
                description: "List all current targets and their status.",
                parameters: Type.Object({}),
                execute: async () => {
                    const targets = await challenge.listStoredChallenges()
                    const rows = targets.map((t) => ({ id: t.id, entrypoint: t.entrypoint, status: t.instance_status }))
                    return {
                        content: [{ type: "text", text: rows.length > 0 ? JSON.stringify(rows, null, 2) : "(no targets yet)" }],
                        details: rows,
                    }
                },
            }),
            defineTool({
                name: "list_solvers",
                label: "List Solvers",
                description: "List all current solvers and their status.",
                parameters: Type.Object({}),
                execute: async () => {
                    const runtime = challenge.getRuntime()
                    const solvers = runtime ? await runtime.listAll() : []
                    const rows = solvers.map((s) => ({ id: s.id, target: s.challengeId, status: s.status, prompt: s.promptName }))
                    return {
                        content: [{ type: "text", text: rows.length > 0 ? JSON.stringify(rows, null, 2) : "(no solvers yet)" }],
                        details: rows,
                    }
                },
            }),
            defineTool({
                name: "stop_solver",
                label: "Stop Solver",
                description: "Stop a running solver.",
                parameters: Type.Object({ solverId: Type.String({ minLength: 1 }) }),
                execute: async (_id, params) => {
                    const runtime = challenge.getRuntime()
                    if (!runtime) throw new Error("runtime is not attached")
                    await runtime.stopSolver(params.solverId.trim())
                    return { content: [{ type: "text", text: `solver ${params.solverId} stopped` }], details: { solverId: params.solverId } }
                },
            }),
            defineTool({
                name: "import_findings",
                label: "Import Findings",
                description:
                    "Import an operator-supplied 'half-done' pentest document into the target's shared operational state, so all current/future solvers and the scheduler can pick up from prior progress instead of re-testing from scratch. Break the document into four kinds of structured entries and submit them at once: assets (reusable assets: obtained credentials/sessions/hosts/services), facts (confirmed facts/evidence), deadends (routes already blocked or stopped by defenses), ideas (attack hypotheses to test). Reference secrets like credentials by name (secret_ref); do not paste plaintext. After importing, usually call launch_solver to carry the relay forward.",
                parameters: Type.Object({
                    targetId: Type.String({ minLength: 1, description: "target id (must already be create_target'd)" }),
                    assets: Type.Optional(
                        Type.Array(
                            Type.Object({
                                kind: Type.Union([Type.Literal("host"), Type.Literal("service"), Type.Literal("credential"), Type.Literal("session")]),
                                label: Type.String({ minLength: 1, description: "readable label, e.g. admin@webapp / http://x:8080 / 10.0.0.5" }),
                                host: Type.Optional(Type.String()),
                                port: Type.Optional(Type.Integer()),
                                service: Type.Optional(Type.String({ description: "service/product/version" })),
                                account: Type.Optional(Type.String({ description: "account/role (for credential/session)" })),
                                privilege: Type.Optional(Type.String({ description: "privilege level user/root/admin/www-data" })),
                                secret_ref: Type.Optional(Type.String({ description: "reference name of the secret, not the plaintext" })),
                                session_type: Type.Optional(Type.String({ description: "ssh/reverse-shell/web-cookie etc." })),
                                note: Type.Optional(Type.String({ description: "how it was obtained / reuse caveats" })),
                            }),
                            { description: "reusable structured assets (obtained credentials/sessions/hosts/services)" },
                        ),
                    ),
                    facts: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "confirmed facts/evidence (one sentence each)" })),
                    deadends: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "routes already blocked or stopped by defenses (state the boundary in each, e.g. 'WAF blocks all system()-style command injection')" })),
                    ideas: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "attack hypotheses / next directions to test (one sentence each)" })),
                }),
                execute: async (_id, params) => {
                    const targetId = params.targetId.trim()
                    if (!targetId) throw new Error("target id is required")
                    const counts = { assets: 0, facts: 0, deadends: 0, ideas: 0 }
                    for (const asset of params.assets ?? []) {
                        if (!asset.label?.trim()) continue
                        await challenge.upsertStateAsset(targetId, {
                            kind: asset.kind,
                            label: asset.label.trim(),
                            host: asset.host?.trim() || undefined,
                            port: typeof asset.port === "number" ? asset.port : undefined,
                            service: asset.service?.trim() || undefined,
                            account: asset.account?.trim() || undefined,
                            privilege: asset.privilege?.trim() || undefined,
                            secretRef: asset.secret_ref?.trim() || undefined,
                            sessionType: asset.session_type?.trim() || undefined,
                            note: asset.note?.trim() || undefined,
                            sourceRefs: ["operator-import"],
                        })
                        counts.assets += 1
                    }
                    for (const fact of params.facts ?? []) {
                        if (!fact.trim()) continue
                        await challenge.appendMemory({ challengeId: targetId, kind: "fact", content: fact.trim(), source: "operator-import" })
                        counts.facts += 1
                    }
                    for (const deadend of params.deadends ?? []) {
                        if (!deadend.trim()) continue
                        await challenge.appendMemory({ challengeId: targetId, kind: "failure", content: deadend.trim(), source: "operator-import" })
                        counts.deadends += 1
                    }
                    for (const idea of params.ideas ?? []) {
                        if (!idea.trim()) continue
                        await challenge.addIdea(targetId, { content: idea.trim(), status: "pending" })
                        counts.ideas += 1
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `imported into "${targetId}": ${counts.assets} assets, ${counts.facts} facts, ${counts.deadends} dead-ends, ${counts.ideas} ideas. All solvers and the planner can now build on this prior progress.`,
                            },
                        ],
                        details: counts,
                    }
                },
            }),
            defineTool({
                name: "get_solver_progress",
                label: "Get Solver Progress",
                description: "View the current memory / findings summary for a target, used for reporting progress.",
                parameters: Type.Object({ targetId: Type.String({ minLength: 1 }) }),
                execute: async (_id, params) => {
                    const targetId = params.targetId.trim()
                    const [memory, ideas, findings] = await Promise.all([
                        challenge.listMemory(targetId).catch(() => []),
                        challenge.listIdeas(targetId).catch(() => []),
                        challenge.listSubmissionLogs(targetId).catch(() => []),
                    ])
                    const summary = {
                        memory: memory.map((m) => ({ kind: m.kind, content: m.content })),
                        ideas: ideas.map((i) => ({ status: i.status, content: i.content })),
                        findings: findings.map((f) => ({ proof: f.flag, writeup: f.writeup })),
                    }
                    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], details: summary }
                },
            }),
            defineTool({
                name: "get_solver_trace",
                label: "Get Solver Trace",
                description:
                    "View a solver's detailed pentest execution process — the actual commands/tool calls it ran and their output (real output from nmap/ffuf/sqlmap/bash etc., the step-by-step kill chain), not just the memory/findings summary. Use this when the operator asks 'what exactly is it doing / which step is it on / why is it stuck / what did that command output'. Needs the solverId (get the target's solver id from list_solvers first).",
                parameters: Type.Object({
                    solverId: Type.String({ minLength: 1, description: "solver id (from list_solvers)" }),
                    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "how many of the most recent tool-call steps to return, default 20" })),
                    thread: Type.Optional(
                        Type.Union([Type.Literal("main"), Type.Literal("subagent"), Type.Literal("observer"), Type.Literal("all")], {
                            description: "which thread to view: main=solver's main execution (default), subagent=sub-agent, observer=side-channel supervision, all=everything",
                        }),
                    ),
                }),
                execute: async (_id, params) => {
                    const solverId = params.solverId.trim()
                    if (!solverId) throw new Error("solverId is required")
                    const runtime = challenge.getRuntime()
                    if (!runtime) throw new Error("runtime is not attached")
                    const details = await runtime.getDetails(solverId)
                    if (!details) {
                        return {
                            content: [{ type: "text", text: `no solver found with id "${solverId}" (use list_solvers to see valid ids)` }],
                            details: { solverId, found: false } as Record<string, unknown>,
                        }
                    }
                    const limit = typeof params.limit === "number" ? params.limit : 20
                    const threadKind = params.thread ?? "main"
                    const text = formatSolverTrace(details, { limit, threadKind })
                    return {
                        content: [{ type: "text", text }],
                        details: { solverId, found: true, status: details.solver.status, threadCount: details.threads.length } as Record<string, unknown>,
                    }
                },
            }),
            defineTool({
                name: "get_target_overview",
                label: "Get Target Overview",
                description:
                    "View the full progress panorama of a target: derived phase (untouched/recon/foothold/breakthrough), success rate, whether pruning is recommended, obtained assets (host/service/credential/session), attack-graph edges, confirmed facts, failure boundaries, live hypotheses, findings, and what each running solver is doing right now. Use this when the operator asks 'how far has this target gotten overall / what's the progress / should we keep investing' — it's more complete than get_solver_progress (progress only has the three raw summaries memory/ideas/findings, with no phase/assets/graph/per-solver focus).",
                parameters: Type.Object({ targetId: Type.String({ minLength: 1 }) }),
                execute: async (_id, params) => {
                    const targetId = params.targetId.trim()
                    if (!targetId) throw new Error("targetId is required")
                    const ov = await challenge.buildTargetOverview(targetId)
                    const lines: string[] = [
                        `Target ${ov.title} (${ov.challengeId}) — instance status: ${ov.instanceStatus}`,
                        `Phase: ${ov.progressPhase} | success rate: ${ov.successRate.toFixed(2)} | dead routes: ${ov.failedRouteCount} | findings: ${ov.findingCount} | active solvers: ${ov.activeSolverCount}${ov.pruneRecommended ? " | ⚠ pruning recommended (too hard for the current approach)" : ""}`,
                        "",
                        `Obtained assets (host/service/credential/session):`,
                        ...(ov.stateAssets.length > 0 ? ov.stateAssets.map((line: string) => `  - ${line}`) : ["  - (none)"]),
                        `Attack-graph edges:`,
                        ...(ov.relations.length > 0 ? ov.relations.map((line: string) => `  - ${line}`) : ["  - (none)"]),
                        `Confirmed facts / credentials:`,
                        ...(ov.memoryFacts.length > 0 ? ov.memoryFacts.map((line: string) => `  - ${line}`) : ["  - (none)"]),
                        `Failure / dead-route boundaries:`,
                        ...(ov.failureBoundaries.length > 0 ? ov.failureBoundaries.map((line: string) => `  - ${line}`) : ["  - (none)"]),
                        `Live hypotheses (verified/testing/pending):`,
                        ...(ov.liveIdeas.length > 0 ? ov.liveIdeas.map((line: string) => `  - ${line}`) : ["  - (none)"]),
                        `Findings:`,
                        ...(ov.findings.length > 0 ? ov.findings.map((line: string) => `  - ${line}`) : ["  - (none)"]),
                        `Running solvers' current focus:`,
                        ...(ov.activeSolvers.length > 0
                            ? ov.activeSolvers.map((solver) => `  - ${solver.id} [${solver.status}]: ${solver.currentFocus}`)
                            : ["  - (no running solvers)"]),
                    ]
                    return { content: [{ type: "text", text: lines.join("\n") }], details: ov as unknown as Record<string, unknown> }
                },
            }),
        ]
    }

    /** Send one operator message to the Commander; the agent autonomously schedules tools. Serial: only one round is processed at a time. */
    async send(message: string, options?: CommanderSendOptions): Promise<void> {
        if (!isEngagementMode()) {
            throw new Error("Commander is only available in engagement mode")
        }
        const attachment = options?.attachment
        if (attachment) {
            const content = attachment.content.trim()
            if (!content) throw new Error("attachment content is empty")
            this.pendingOperatorUpload = {
                name: attachment.name.trim() || "upload.txt",
                content,
            }
        } else {
            this.clearPendingOperatorUpload()
        }
        const text = buildCommanderSessionPrompt(message, attachment)
        if (this.running) {
            throw new Error("Commander is still processing the previous message, please wait")
        }
        const session = await this.ensureSession()
        this.running = true
        try {
            await session.prompt(text, { source: "rpc" })
        } catch (error) {
            this.emit({ type: "error", text: error instanceof Error ? error.message : String(error) })
            throw error
        } finally {
            this.running = false
        }
    }

    /** Read the persisted conversation history (for the frontend's first load). */
    async history(): Promise<unknown[]> {
        try {
            const session = await this.ensureSession()
            const manager = (session as unknown as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager
            return manager?.getEntries?.() ?? []
        } catch {
            return []
        }
    }

    /**
     * Read the entries of the "current branch" (walking from the current leaf to the root).
     * Key difference from getEntries(): the session is an append-only tree, and a rollback (navigateTree) only moves the leaf pointer,
     * while old branches remain in the file. getEntries() returns the whole tree (including rolled-back old branches); getBranch() returns only the current path.
     * Display after conversation restore/rollback must use this, otherwise rolled-back messages would "come back to life".
     */
    private async branchEntries(): Promise<unknown[]> {
        try {
            const session = await this.ensureSession()
            const manager = (session as unknown as { sessionManager?: { getBranch?: (fromId?: string) => unknown[]; getEntries?: () => unknown[] } }).sessionManager
            if (manager?.getBranch) return manager.getBranch()
            return manager?.getEntries?.() ?? []
        } catch {
            return []
        }
    }

    /**
     * Convert the current branch's entries into conversation bubbles {role, text} that the frontend can render directly.
     * Takes only entries where type==="message" and role is user/assistant, extracting their text parts
     * (ignoring thinking, session/model_change, and other non-conversation entries). Used to restore the conversation after switching panels / refresh after rollback.
     */
    async historyMessages(): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
        const entries = await this.branchEntries()
        const messages: Array<{ role: "user" | "assistant"; text: string }> = []
        for (const raw of entries) {
            if (!raw || typeof raw !== "object") continue
            const entry = raw as { type?: unknown; message?: unknown }
            if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue
            const message = entry.message as { role?: unknown; content?: unknown }
            const role = message.role
            if (role !== "user" && role !== "assistant") continue
            let text = extractEntryText(message.content)
            if (!text) continue
            if (role === "user") text = displayCommanderUserMessage(text)
            messages.push({ role, text })
        }
        return messages
    }

    /**
     * List the history points we can roll back to (one per operator message on the current branch). Returns {entryId, text}, in chronological order.
     * Note: does not use the SDK's getUserMessagesForForking() — it is based on getEntries() (the whole tree), and after a rollback it would also list
     * user messages on discarded old branches, causing rollback points to get jumbled. Here we extract from the current branch entries ourselves instead.
     */
    async rollbackPoints(): Promise<Array<{ entryId: string; text: string }>> {
        const entries = await this.branchEntries()
        const points: Array<{ entryId: string; text: string }> = []
        for (const raw of entries) {
            if (!raw || typeof raw !== "object") continue
            const entry = raw as { type?: unknown; id?: unknown; message?: unknown }
            if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message || typeof entry.message !== "object") continue
            const message = entry.message as { role?: unknown; content?: unknown }
            if (message.role !== "user") continue
            const text = displayCommanderUserMessage(extractEntryText(message.content))
            if (text) points.push({ entryId: entry.id, text })
        }
        return points
    }

    /**
     * Roll the conversation back to a given history point: all messages and commander replies after that point are discarded, returning to the state at that moment.
     * Only touches the commander's conversation context — does not touch any dispatched/running solver.
     */
    async rollbackTo(entryId: string): Promise<void> {
        const target = entryId.trim()
        if (!target) throw new Error("entryId is required")
        if (this.running) throw new Error("Commander is processing a message and cannot roll back")
        const session = await this.ensureSession()
        const navigate = (session as unknown as {
            navigateTree?: (id: string, opts?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>
        }).navigateTree
        if (!navigate) throw new Error("the current SDK version does not support conversation rollback")
        // summarize=false: directly discard the rolled-back branch, no summary injection.
        await navigate.call(session, target, { summarize: false })
        // Notify the frontend to refresh the conversation (history has changed after rollback).
        this.emit({ type: "rolled_back" })
    }

    /**
     * Start a brand-new clean conversation: creates a new session file and switches to it.
     * Older session files remain on disk and appear in the session list until deleted.
     * Does not affect any dispatched solver.
     */
    async startNewSession(): Promise<void> {
        this.clearPendingOperatorUpload()
        await this.replaceSession((sessionDir) => SessionManager.create(sessionDir, sessionDir))
    }

    /** List persisted commander conversations (newest activity first). */
    async listSessions(): Promise<CommanderSessionSummary[]> {
        const sessionDir = commanderSessionDir()
        await mkdir(sessionDir, { recursive: true })
        const listed = await SessionManager.list(sessionDir, sessionDir)
        const activePath = this.getActiveSessionPath()
        const sessions = listed.map((item) => ({
            id: item.id,
            path: item.path,
            created: typeof item.created === "string" ? item.created : new Date(item.created).toISOString(),
            modified: typeof item.modified === "string" ? item.modified : new Date(item.modified).toISOString(),
            messageCount: item.messageCount ?? 0,
            preview: clipSessionPreview(item.firstMessage),
            active: item.path === activePath,
        }))
        sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
        return sessions
    }

    /** Switch to a persisted session file. */
    async switchSession(path: string): Promise<void> {
        const resolved = resolveCommanderSessionPath(path)
        if (!(await Bun.file(resolved).exists())) {
            throw new Error("session not found")
        }
        if (this.getActiveSessionPath() === resolved && this.session) return
        this.clearPendingOperatorUpload()
        await this.replaceSession((sessionDir) => SessionManager.open(resolved, sessionDir))
    }

    /** Delete a persisted session file. If it is the active conversation, clears the in-memory session. */
    async deleteSession(path: string): Promise<void> {
        if (this.running) throw new Error("Commander is processing a message and cannot delete a conversation")
        const resolved = resolveCommanderSessionPath(path)
        const wasActive = this.getActiveSessionPath() === resolved
        if (wasActive) {
            this.clearPendingOperatorUpload()
            try {
                this.session?.dispose()
            } catch {
                // ignore dispose errors
            }
            this.session = undefined
            this.activeSessionPath = undefined
        }
        if (await Bun.file(resolved).exists()) {
            await rm(resolved)
        }
        this.emit({ type: "rolled_back" })
    }

    isBusy(): boolean {
        return this.running
    }
}
