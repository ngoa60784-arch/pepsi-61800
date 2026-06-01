import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager } from "@mariozechner/pi-coding-agent"
import type { AgentSession, CreateAgentSessionOptions, ToolDefinition } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import type { ConfigManager } from "../config/index"
import { DEFAULT_CONFIG_DIR } from "../config/index"
import type { ChallengeManager } from "./manager"
import { isEngagementMode } from "./engagement"

/**
 * Commander —— 对话式渗透指挥官。
 *
 * 操作员用自然语言下达目标（"测一下 example.com，重点看上传/SSRF"），
 * Commander 这个常驻 LLM agent 负责：补全 entrypoint、建 target、派 solver（把要求作为 handoff 注入）、
 * 汇报进展、按指令停 solver / 调方向。它是 planner 之外、面向人的对话入口。
 *
 * 与 planner 的区别：planner 是周期性、无人值守的自动调度（一次性 inMemory session）；
 * Commander 是常驻、多轮、人来驱动（落盘 session），二者复用同一套 ChallengeManager 能力。
 */

const COMMANDER_SYSTEM_PROMPT = `You are the penetration-test commander for BreachWeave.

The operator gives you engagement targets in natural language. Your job is to turn that into real action — not just reply with text.

## Your responsibilities
- Extract the target (IP / domain / URL) from what the operator says. If only a domain or host is given, fill in the entrypoint yourself: default to both http:// and https://, and infer common web ports (80/443/8080) as needed.
- Use create_target to register the target, then launch_solver to dispatch a solver. Carry the operator's emphasis (e.g. "focus on upload and SSRF", "leave the login endpoint alone") into the solver handoff brief.
- Default to acting immediately — do not repeatedly ask for confirmation. Only ask a short clarifying question if you genuinely cannot extract any usable target from the operator's message.
- When the operator asks for progress, check real state with list_solvers / get_solver_progress before answering — never fabricate.
- When the operator tells you to stop a solver, change direction, or add more force, use the matching tool.

## Resuming a half-finished target (operator hands you a prior pentest document) — STRICT ORDER
When the operator gives you prior progress for a target (creds obtained, confirmed injection points, routes that failed, leads to try next), you MUST execute these tool calls in this EXACT order, and you must NOT call launch_solver until import_findings has returned:

1. **create_target** — register the target (use the address from the document; if none, ask the operator).
2. **import_findings** — parse the WHOLE document into the four buckets and load it into shared state:
   - assets: reusable creds / sessions / hosts / services (reference secrets by name via secret_ref, never plaintext)
   - facts: confirmed facts / evidence
   - deadends: routes already blocked — include the boundary (e.g. "WAF strips custom response headers", "redis-cli EVAL blocked by WAF")
   - ideas: hypotheses to test next
3. **launch_solver** — ONLY after import_findings succeeds. The solver's task is built from shared state at launch time, so if you launch before importing, the solver starts BLIND (empty memory/ideas/state) and re-discovers everything from zero — wasting the entire document. Put the highest-priority next move into the handoff too.

NEVER launch a solver before the import completes. If you launched one too early by mistake, stop it and relaunch after importing.

## Tools
- create_target(id, entrypoint, description): register an engagement target. Use a short readable id (e.g. "example-com"); entrypoint is an array of entry addresses.
- import_findings(targetId, assets, facts, deadends, ideas): load an operator-supplied "half-done" pentest progress into the target's shared state so all solvers and the scheduler build on it instead of restarting. Use this whenever the operator provides prior findings/creds/notes. MUST be called BEFORE launch_solver.
- launch_solver(targetId, handoff): dispatch one solver against a target. handoff is the solver's startup brief (emphasis, known info, constraints).
- list_targets(): list all current targets.
- list_solvers(): list all current solvers and their status.
- stop_solver(solverId): stop a solver.
- get_solver_progress(targetId): view the memory / findings summary for a target's solvers.

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

/** 从 SDK message.content 提取纯文本：content 可能是字符串或 {type,text} 片段数组，只取 text 片段。 */
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

export class CommanderManager {
    private readonly config: ConfigManager
    private readonly challenge: ChallengeManager
    private session: AgentSession | undefined
    private starting: Promise<AgentSession> | undefined
    private subscribers = new Set<CommanderSubscriber>()
    private running = false

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

    /** 解析 Commander 会话配置：模型用全局默认 Agent 模型(UI 选的那个)；系统提示固定为指挥官提示。 */
    private async resolveSessionOptions(): Promise<CreateAgentSessionOptions> {
        const modelPrefs = await this.config.listModelPrefs()
        if (modelPrefs.length === 0) {
            throw new Error("尚未配置任何模型：请先在 UI 的 Config → Providers / Models 里添加 provider、API key 与模型，再使用 Commander。")
        }
        const defaultPrefId = (await this.config.resolveDefaultModelPrefId()) ?? modelPrefs[0].id
        const resolved = await this.config.resolveModelPref(defaultPrefId)

        const resourceLoader = new DefaultResourceLoader({
            agentDir: DEFAULT_CONFIG_DIR,
            systemPromptOverride: () => COMMANDER_SYSTEM_PROMPT,
            // Commander 不加载任何内置技能/扩展，只用自己的指挥工具。
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

    private async ensureSession(): Promise<AgentSession> {
        if (this.session) return this.session
        if (this.starting) return this.starting
        this.starting = (async () => {
            const opts = await this.resolveSessionOptions()
            const sessionDir = resolve(DEFAULT_CONFIG_DIR, "commander-session")
            await mkdir(sessionDir, { recursive: true })
            const { session } = await createAgentSession({
                ...opts,
                cwd: sessionDir,
                // continueRecent：有上次落盘的 session 就续上（重启后对话/上下文保留），没有才新建。
                // 配合 startNewSession() 提供"开新一轮干净对话"的逃生口。
                sessionManager: SessionManager.continueRecent(sessionDir, sessionDir),
            })
            session.subscribe((event) => this.forwardSessionEvent(event))
            this.session = session
            return session
        })()
        try {
            return await this.starting
        } finally {
            this.starting = undefined
        }
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

    private createCommanderTools(): ToolDefinition[] {
        const challenge = this.challenge
        return [
            defineTool({
                name: "create_target",
                label: "Create Target",
                description: "建立一个渗透目标（target）。id 用简短可读标识；entrypoint 是入口地址数组（如 [\"http://x\",\"https://x\"]）。",
                parameters: Type.Object({
                    id: Type.String({ minLength: 1, description: "短标识，如 example-com" }),
                    entrypoint: Type.Array(Type.String(), { description: "入口地址数组，至少一个" }),
                    description: Type.Optional(Type.String({ description: "目标背景/已知信息" })),
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
                description: "对一个目标派出 solver 开打。handoff 是给 solver 的启动简报（侧重点、已知信息、约束）。",
                parameters: Type.Object({
                    targetId: Type.String({ minLength: 1 }),
                    handoff: Type.Optional(Type.String({ description: "给 solver 的启动简报" })),
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
                description: "列出当前所有目标及其状态。",
                parameters: Type.Object({}),
                execute: async () => {
                    const targets = await challenge.listStoredChallenges()
                    const rows = targets.map((t) => ({ id: t.id, entrypoint: t.entrypoint, status: t.instance_status }))
                    return {
                        content: [{ type: "text", text: rows.length > 0 ? JSON.stringify(rows, null, 2) : "（暂无目标）" }],
                        details: rows,
                    }
                },
            }),
            defineTool({
                name: "list_solvers",
                label: "List Solvers",
                description: "列出当前所有 solver 及其状态。",
                parameters: Type.Object({}),
                execute: async () => {
                    const runtime = challenge.getRuntime()
                    const solvers = runtime ? await runtime.listAll() : []
                    const rows = solvers.map((s) => ({ id: s.id, target: s.challengeId, status: s.status, prompt: s.promptName }))
                    return {
                        content: [{ type: "text", text: rows.length > 0 ? JSON.stringify(rows, null, 2) : "（暂无 solver）" }],
                        details: rows,
                    }
                },
            }),
            defineTool({
                name: "stop_solver",
                label: "Stop Solver",
                description: "停止一个正在运行的 solver。",
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
                    "把操作员提供的『渗透到一半』文档导入到目标的共享作战态，让所有现在/将来的 solver 与调度层都能接着上次进度继续测——而不是从零重测。把文档拆成四类结构化条目一次性提交：assets(可复用资产:已得凭据/会话/主机/服务)、facts(已确认事实/证据)、deadends(已撞死/被防御挡掉的路线)、ideas(待测的攻击假设)。凭据等密文用引用名(secret_ref)指代，不要贴明文。导入后通常再 launch_solver 让它接力。",
                parameters: Type.Object({
                    targetId: Type.String({ minLength: 1, description: "目标 id（需已 create_target）" }),
                    assets: Type.Optional(
                        Type.Array(
                            Type.Object({
                                kind: Type.Union([Type.Literal("host"), Type.Literal("service"), Type.Literal("credential"), Type.Literal("session")]),
                                label: Type.String({ minLength: 1, description: "可读标签，如 admin@webapp / http://x:8080 / 10.0.0.5" }),
                                host: Type.Optional(Type.String()),
                                port: Type.Optional(Type.Integer()),
                                service: Type.Optional(Type.String({ description: "服务/产品/版本" })),
                                account: Type.Optional(Type.String({ description: "账号/角色（凭据/会话用）" })),
                                privilege: Type.Optional(Type.String({ description: "权限级别 user/root/admin/www-data" })),
                                secret_ref: Type.Optional(Type.String({ description: "密文的引用名，不是明文" })),
                                session_type: Type.Optional(Type.String({ description: "ssh/reverse-shell/web-cookie 等" })),
                                note: Type.Optional(Type.String({ description: "如何获得/复用注意事项" })),
                            }),
                            { description: "可复用的结构化资产（已得凭据/会话/主机/服务）" },
                        ),
                    ),
                    facts: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "已确认的事实/证据（每条一句话）" })),
                    deadends: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "已撞死/被防御挡掉的路线（每条说明边界，如 'WAF 拦截所有 system() 类命令注入'）" })),
                    ideas: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "待测的攻击假设/下一步方向（每条一句话）" })),
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
                description: "查看某目标当前的 memory / findings 摘要，用于汇报进展。",
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
        ]
    }

    /** 发送一条操作员消息给 Commander，agent 自主调度工具。串行：一次只处理一轮。 */
    async send(message: string): Promise<void> {
        const text = message.trim()
        if (!text) throw new Error("message is required")
        if (!isEngagementMode()) {
            throw new Error("Commander 仅在 engagement 模式可用")
        }
        if (this.running) {
            throw new Error("Commander 正在处理上一条消息，请稍候")
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

    /** 读取已落盘的对话历史（用于前端首次加载）。 */
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
     * 读取“当前分支”的条目（从当前 leaf 走到 root）。
     * 关键区别于 getEntries()：session 是 append-only 树，回退(navigateTree)只是移动 leaf 指针，
     * 旧分支仍留在文件里。getEntries() 返回整棵树(含被回退掉的旧分支)，getBranch() 只返回当前路径。
     * 对话恢复/回退后展示必须用这个，否则被回退掉的消息会"复活"。
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
     * 把当前分支的条目转成前端可直接渲染的对话气泡 {role, text}。
     * 只取 type==="message" 且 role 为 user/assistant 的条目，提取其中的 text 片段
     * （忽略 thinking、session/model_change 等非对话条目）。用于切换版块后恢复对话 / 回退后刷新。
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
            const text = extractEntryText(message.content)
            if (!text) continue
            messages.push({ role, text })
        }
        return messages
    }

    /**
     * 列出可回退到的历史点（当前分支上每条操作员消息一个）。返回 {entryId, text}，按时间顺序。
     * 注意：不用 SDK 的 getUserMessagesForForking()——它基于 getEntries()（整棵树），回退后会把
     * 被丢弃旧分支上的用户消息也列出来，导致回退点错乱。这里改用当前分支条目自己提取。
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
            const text = extractEntryText(message.content)
            if (text) points.push({ entryId: entry.id, text })
        }
        return points
    }

    /**
     * 把对话回退到指定历史点：该点之后的所有消息与指挥官回复被丢弃，回到那一刻的状态。
     * 只动指挥官的对话上下文——不碰任何已派出/在跑的 solver。
     */
    async rollbackTo(entryId: string): Promise<void> {
        const target = entryId.trim()
        if (!target) throw new Error("entryId is required")
        if (this.running) throw new Error("Commander 正在处理消息，无法回退")
        const session = await this.ensureSession()
        const navigate = (session as unknown as {
            navigateTree?: (id: string, opts?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>
        }).navigateTree
        if (!navigate) throw new Error("当前 SDK 版本不支持对话回退")
        // summarize=false：直接丢弃被回退掉的分支，不做总结注入。
        await navigate.call(session, target, { summarize: false })
        // 通知前端刷新对话（回退后历史已变）。
        this.emit({ type: "rolled_back" })
    }

    /**
     * 开一轮全新的干净对话：丢弃当前 session（落盘的旧 session 仍保留在磁盘上，只是不再续用），
     * 下次 send / ensureSession 会用 continueRecent 续上——所以这里要新建一个空 session 并切过去。
     * 不影响任何已派出的 solver。
     */
    async startNewSession(): Promise<void> {
        if (this.running) throw new Error("Commander 正在处理消息，无法开新对话")
        const opts = await this.resolveSessionOptions()
        const sessionDir = resolve(DEFAULT_CONFIG_DIR, "commander-session")
        await mkdir(sessionDir, { recursive: true })
        const previous = this.session
        const { session } = await createAgentSession({
            ...opts,
            cwd: sessionDir,
            sessionManager: SessionManager.create(sessionDir, sessionDir),
        })
        session.subscribe((event) => this.forwardSessionEvent(event))
        this.session = session
        try {
            previous?.dispose()
        } catch {
            // ignore dispose errors
        }
        this.emit({ type: "rolled_back" })
    }

    isBusy(): boolean {
        return this.running
    }
}
