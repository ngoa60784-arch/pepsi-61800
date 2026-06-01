import Dockerode from "dockerode"
import { basename, dirname, resolve } from "node:path"
import { appendFile, mkdir, readdir, rename } from "node:fs/promises"
import type {
    ContainerConfig,
    HostBridgeHandler,
    RuntimeMessageThread,
    RuntimeSolverDetails,
    SolverEventHandler,
    SolverInstance,
} from "./types"
import { ARCHIVE_SOLVERS_DIR, SOLVERS_DIR, solverDir, solverSessionDir, solverStartupPath, solverWorkspaceDir } from "./types"
import { ConfigManager, DEFAULT_CONFIG_DIR } from "../config/index"
import { CHALLENGE_ENV_CHALLENGE_ID, ENGAGEMENT_ENV_SCOPE } from "../challenge/env"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import type { Message } from "@mariozechner/pi-ai"
import type { HostBridgeRequestEvent } from "../challenge/host-bridge-types"
import type { RpcCommand, SolverInitPayload } from "../solver/rpc/rpc-types"
import type { Subprocess } from "bun"
import { createExecutionBackend, type ExecutionBackend } from "./execution-backend"
import {
    DOCKERFILE_HASH_LABEL,
    RUNTIME_IMAGE_ARCH,
    ensureSolverBinary,
    getAgentEndError,
    getAssistantError,
    getStableSolverCreatedAt,
    hashDockerfileContent,
    pathExists,
    readMessagesFromSessionDir,
    readStartup,
    resolveDockerfilePath,
    resolveSolverInjection,
} from "./helpers"
const SOLVER_NAME_PREFIX = "tch-solver"
const DOCKER_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const

export { getAgentEndError, hashDockerfileContent } from "./helpers"

function isHostBridgeRequestEvent(value: unknown): value is HostBridgeRequestEvent {
    if (!value || typeof value !== "object") return false
    const event = value as { type?: unknown; request_id?: unknown; action?: unknown }
    return event.type === "host_bridge_request" && typeof event.request_id === "string" && typeof event.action === "string"
}

function getMessageTimestamp(message: { timestamp?: unknown }): number | undefined {
    return typeof message.timestamp === "number" ? message.timestamp : undefined
}

function normalizeToolResultContent(payload: unknown): Array<{ type: "text"; text: string } | Record<string, unknown>> {
    if (payload && typeof payload === "object" && "content" in payload) {
        const content = (payload as { content?: unknown }).content
        if (Array.isArray(content)) {
            return content.filter((item): item is { type: "text"; text: string } | Record<string, unknown> => !!item && typeof item === "object")
        }
    }

    if (typeof payload === "string" && payload.trim()) {
        return [{ type: "text", text: payload }]
    }

    if (payload == null) return []

    try {
        return [{ type: "text", text: JSON.stringify(payload, null, 2) }]
    } catch {
        return [{ type: "text", text: String(payload) }]
    }
}

function buildRuntimeToolResultMessage(event: AgentSessionEvent): Message | undefined {
    if (event.type !== "tool_execution_end") return
    if (!event.toolCallId || !event.toolName) return

    const payload = event.result
    const message = {
        role: "toolResult",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: normalizeToolResultContent(payload),
        isError: event.isError === true,
        timestamp: "timestamp" in event && typeof event.timestamp === "number" ? event.timestamp : Date.now(),
    } as Message & { details?: unknown }

    if (payload && typeof payload === "object" && "details" in payload) {
        message.details = (payload as { details?: unknown }).details
    }

    return message
}

function upsertToolResultMessage(messages: Message[], nextMessage: Message): Message[] {
    const toolCallId = "toolCallId" in nextMessage && typeof nextMessage.toolCallId === "string" ? nextMessage.toolCallId : ""
    if (!toolCallId) return [...messages, nextMessage]

    const index = messages.findIndex(
        (message) => message.role === "toolResult" && "toolCallId" in message && typeof message.toolCallId === "string" && message.toolCallId === toolCallId,
    )
    if (index < 0) return [...messages, nextMessage]

    const merged = [...messages]
    merged[index] = {
        ...merged[index],
        ...nextMessage,
    }
    return merged
}

function mergeMainThreadMessages(baseMessages: Message[], liveMessages: Message[]): Message[] {
    if (liveMessages.length === 0) return baseMessages

    let merged = [...baseMessages]
    for (const liveMessage of liveMessages) {
        merged = upsertToolResultMessage(merged, liveMessage)
    }

    return merged
        .map((message, index) => ({ message, index }))
        .sort((left, right) => {
            const leftTs = getMessageTimestamp(left.message)
            const rightTs = getMessageTimestamp(right.message)
            if (leftTs === undefined && rightTs === undefined) return left.index - right.index
            if (leftTs === undefined) return 1
            if (rightTs === undefined) return -1
            if (leftTs === rightTs) return left.index - right.index
            return leftTs - rightTs
        })
        .map((item) => item.message)
}

function getTextContent(content: unknown): string {
    if (typeof content === "string") return content.trim()
    if (!Array.isArray(content)) return ""
    return content
        .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object" && "type" in item)
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim()
}

function getObserverReasonLabel(message: { role?: unknown; content?: unknown }, index: number): string {
    if (message.role !== "user") return `Observer #${index + 1}`
    const text = getTextContent(message.content)
    const reason = text.match(/本次触发原因:\s*([^\n]+)/)?.[1]?.trim()
    return reason ? `Observer ${reason}` : `Observer #${index + 1}`
}

function splitObserverThreads(
    solverId: string,
    session: { sessionId?: string; createdAt?: number; messages: Array<{ role?: unknown; timestamp?: unknown; content?: unknown }> },
): RuntimeMessageThread[] {
    const groups: Array<Array<{ role?: unknown; timestamp?: unknown; content?: unknown }>> = []
    let current: Array<{ role?: unknown; timestamp?: unknown; content?: unknown }> = []

    for (const message of session.messages) {
        if (message.role === "user" && current.length > 0) {
            groups.push(current)
            current = [message]
            continue
        }
        current.push(message)
    }

    if (current.length > 0) {
        groups.push(current)
    }

    return groups.map((messages, index) => {
        const firstMessage = messages[0]
        return {
            id: `${solverId}:observer:${index + 1}`,
            solverId,
            kind: "observer",
            label: getObserverReasonLabel(firstMessage ?? {}, index),
            promptName: "observer",
            sessionId: session.sessionId,
            createdAt: getMessageTimestamp(firstMessage ?? {}) ?? session.createdAt,
            messages: messages as RuntimeMessageThread["messages"],
        }
    })
}

function readDockerBuildProxyArgs(): string[] {
    const args: string[] = []
    for (const key of DOCKER_PROXY_ENV_KEYS) {
        const value = process.env[key]?.trim()
        if (!value) continue
        args.push("--build-arg", `${key}=${value}`)
    }
    return args
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.stack || error.message : String(error)
}

function solverStartupLogPath(solverId: string): string {
    return resolve(solverDir(solverId), "startup.log")
}

export class RuntimeManager {
    private docker: Dockerode
    private config: ContainerConfig
    private solvers = new Map<string, SolverInstance>()
    private procs = new Map<string, Subprocess<"pipe", "pipe", "pipe">>()
    private solverEnvs = new Map<string, Record<string, string>>()
    private liveMainThreadMessages = new Map<string, Message[]>()
    private hostBridgeHandlers: HostBridgeHandler[]
    private hostConfig: ConfigManager
    private ready: Promise<void>
    private eventHandlers: SolverEventHandler[] = []
    private backend: ExecutionBackend

    constructor(config: ConfigManager, hostBridgeHandlers: HostBridgeHandler[]) {
        this.docker = new Dockerode()
        const binds = [`${DEFAULT_CONFIG_DIR}:/root/.tch-agent/config:ro`]
        this.config = {
            image: "tch-agent:latest",
            binds,
        }
        this.hostConfig = config
        this.hostBridgeHandlers = hostBridgeHandlers
        this.backend = createExecutionBackend(this.config)
        this.ready = this.reloadFromConfig()
    }

    private async ensureReady(): Promise<void> {
        await this.ready
    }

    async reloadFromConfig(): Promise<void> {
        const hostSettings = await this.hostConfig.getHostSettings()
        this.config = { ...this.config, ...hostSettings.runtime }
        this.backend = createExecutionBackend(this.config)
    }

    async init(onProgress?: (message: string) => void) {
        await this.ensureReady()
        await this.ensureImage(onProgress)
        const execName = basename(process.execPath).toLowerCase()
        if (execName === "bun" || execName === "bun.exe") {
            onProgress?.("Compiling runtime solver binary...")
            await ensureSolverBinary()
        }
    }

    onEvent(handler: SolverEventHandler) {
        this.eventHandlers.push(handler)
    }

    private emit(solverId: string, event: AgentSessionEvent) {
        const liveMessage = buildRuntimeToolResultMessage(event)
        if (liveMessage) {
            const current = this.liveMainThreadMessages.get(solverId) ?? []
            this.liveMainThreadMessages.set(solverId, upsertToolResultMessage(current, liveMessage))
        }
        for (const handler of this.eventHandlers) {
            try {
                handler(solverId, event)
            } catch {
                // ignore handler errors
            }
        }
    }

    private recordAgentEnd(solverId: string, errorMessage?: string) {
        const solver = this.solvers.get(solverId)
        if (solver) {
            if (errorMessage) solver.error = errorMessage
            else delete solver.error
        }
    }

    private clearSolverRuntimeState(solverId: string): void {
        this.procs.delete(solverId)
        this.solverEnvs.delete(solverId)
        this.liveMainThreadMessages.delete(solverId)
    }

    private async appendSolverStartupLog(solverId: string, line: string): Promise<void> {
        const text = line.trim()
        if (!text) return
        try {
            await appendFile(solverStartupLogPath(solverId), `${new Date().toISOString()} ${text}\n`)
        } catch (error) {
            console.error(`[runtime:${solverId}] failed to append startup log`, formatError(error))
        }
    }

    private normalizeSolverEnv(solverEnv?: Record<string, string>): Record<string, string> {
        if (!solverEnv) return {}
        const normalized: Record<string, string> = {}
        for (const [rawKey, rawValue] of Object.entries(solverEnv)) {
            const key = rawKey.trim()
            if (!key) continue
            if (typeof rawValue !== "string") continue
            normalized[key] = rawValue
        }
        return normalized
    }

    private getSolverEnvValue(solverId: string, key: string): string | undefined {
        const solverEnv = this.solverEnvs.get(solverId)
        if (!solverEnv) return
        const value = solverEnv[key]
        if (typeof value !== "string") return
        const text = value.trim()
        return text || undefined
    }

    private async executeHostBridgeAction(solverId: string, action: HostBridgeRequestEvent["action"], params: unknown): Promise<unknown> {
        for (const handler of this.hostBridgeHandlers) {
            const result = await handler.handle({
                solverId,
                action,
                params,
                getSolverEnvValue: (key: string) => this.getSolverEnvValue(solverId, key),
                getSolver: () => this.get(solverId),
                getSolverStartup: () => readStartup(solverStartupPath(solverId)),
                listSolvers: () => this.list(),
                sendCommand: (targetSolverId, command) => this.sendCommand(targetSolverId, command),
            })
            if (result.handled) {
                return result.data
            }
        }
        throw new Error(`unsupported host bridge action: ${action}`)
    }

    private async handleHostBridgeRequest(solverId: string, request: HostBridgeRequestEvent): Promise<void> {
        const commandId = `host-bridge-${request.request_id}`
        try {
            const data = await this.executeHostBridgeAction(solverId, request.action, request.params)
            try {
                this.sendCommand(solverId, {
                    id: commandId,
                    type: "host_bridge_response",
                    request_id: request.request_id,
                    success: true,
                    data,
                })
            } catch (sendError) {
                console.error(`[runtime:${solverId}] failed to send host bridge success response`, formatError(sendError))
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            try {
                this.sendCommand(solverId, {
                    id: commandId,
                    type: "host_bridge_response",
                    request_id: request.request_id,
                    success: false,
                    error: message,
                })
            } catch (sendError) {
                console.error(`[runtime:${solverId}] failed to send host bridge error response`, formatError(sendError))
            }
        }
    }

    /** Check if Docker daemon is accessible */
    async ping(): Promise<boolean> {
        try {
            await this.docker.ping()
            return true
        } catch {
            return false
        }
    }

    /** Check if the configured image exists locally */
    async hasImage(image?: string): Promise<boolean> {
        try {
            const img = this.docker.getImage(image ?? this.config.image)
            await img.inspect()
            return true
        } catch {
            return false
        }
    }

    private async getDockerfileHash(dockerfilePath: string): Promise<string> {
        const content = await Bun.file(dockerfilePath).text()
        return hashDockerfileContent(content)
    }

    private async getImageDockerfileHash(image?: string): Promise<string | undefined> {
        try {
            const img = this.docker.getImage(image ?? this.config.image)
            const inspect = await img.inspect()
            return inspect.Config?.Labels?.[DOCKERFILE_HASH_LABEL]
        } catch {
            return
        }
    }

    private async getImageArchitecture(image?: string): Promise<string | undefined> {
        try {
            const img = this.docker.getImage(image ?? this.config.image)
            const inspect = await img.inspect()
            return inspect.Architecture
        } catch {
            return
        }
    }

    /**
     * Ensure the solver image exists. If not, build it from the Dockerfile.
     *
     * Dockerfile resolution order:
     *   1. ~/.tch-agent/config/Dockerfile  (user-customizable)
     *   2. Built-in Dockerfile bundled with the package
     *
     * If the user copy doesn't exist, the built-in one is copied there first.
     */
    async ensureImage(onProgress?: (message: string) => void): Promise<void> {
        const dockerfilePath = await resolveDockerfilePath(onProgress)
        const imageExists = await this.hasImage()

        if (imageExists) {
            const actualArchitecture = await this.getImageArchitecture()
            if (actualArchitecture === RUNTIME_IMAGE_ARCH) return
            onProgress?.(`Image ${this.config.image} has wrong architecture (${actualArchitecture ?? "unknown"}); rebuilding...`)
        }

        const expectedDockerfileHash = await this.getDockerfileHash(dockerfilePath)
        onProgress?.(`Building image ${this.config.image} from ${dockerfilePath}...`)

        const contextDir = dirname(dockerfilePath)
        const proxyArgs = readDockerBuildProxyArgs()
        const proc = Bun.spawn(
            [
                "docker",
                "buildx",
                "build",
                "--platform",
                "linux/amd64",
                "--load",
                "-t",
                this.config.image,
                "-f",
                dockerfilePath,
                "--label",
                `${DOCKERFILE_HASH_LABEL}=${expectedDockerfileHash}`,
                ...proxyArgs,
                contextDir,
            ],
            {
                stdout: "pipe",
                stderr: "pipe",
            },
        )

        const readProgress = async (stream: ReadableStream<Uint8Array> | null) => {
            if (!stream) return
            // 每路流独立的 streaming decoder：stdout/stderr 并发读，共用一个 decoder 会互相污染，
            // 且非流式 decode 会截断跨 chunk 的多字节字符。
            const decoder = new TextDecoder()
            const reader = stream.getReader()
            let buffer = ""
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""
                for (const line of lines) {
                    const text = line.trim()
                    if (text) onProgress?.(text)
                }
            }
            const tail = buffer.trim()
            if (tail) onProgress?.(tail)
        }

        await Promise.all([readProgress(proc.stdout), readProgress(proc.stderr)])
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new Error(`Failed to build image ${this.config.image} (exit ${exitCode})`)
        }

        const builtArchitecture = await this.getImageArchitecture()
        if (builtArchitecture !== RUNTIME_IMAGE_ARCH) {
            throw new Error(`Image ${this.config.image} built with wrong architecture: ${builtArchitecture ?? "unknown"} (expected ${RUNTIME_IMAGE_ARCH})`)
        }

        onProgress?.(`Image ${this.config.image} built successfully`)
    }

    /** Start a new solver for a given prompt (docker container or remote ssh process) */
    async launch(promptName: string, task: string, solverEnv?: Record<string, string>, options?: { solverId?: string; resume?: boolean }): Promise<SolverInstance> {
        await this.ensureReady()
        // ssh 后端：solver 在远程主机跑，本地无需构建/检查 docker 镜像。
        if (this.backend.kind !== "ssh") {
            await this.ensureImage()
        }

        const id = options?.solverId?.trim() || crypto.randomUUID().slice(0, 8)
        const name = `${SOLVER_NAME_PREFIX}-${id}`
        const normalizedSolverEnv = this.normalizeSolverEnv(solverEnv)

        const solver: SolverInstance = {
            id,
            containerId: name,
            name,
            promptName,
            task,
            challengeId: normalizedSolverEnv[CHALLENGE_ENV_CHALLENGE_ID]?.trim() || undefined,
            status: "starting",
            createdAt: Date.now(),
        }
        this.solvers.set(id, solver)
        this.solverEnvs.set(id, normalizedSolverEnv)

        const baseDir = solverDir(id)
        const sessionDir = solverSessionDir(id)
        const workspaceDir = solverWorkspaceDir(id)

        await mkdir(baseDir, { recursive: true })
        await mkdir(sessionDir, { recursive: true })
        await mkdir(workspaceDir, { recursive: true })

        // ssh 后端在远程主机用自己的 remoteBinary，injectionCmd/extraBinds 都用不到；
        // 跳过 resolveSolverInjection() 以免每次启动都白白触发一次 solver 二进制编译。
        const injection = this.backend.kind === "ssh" ? { cmd: [], binds: [] } : await resolveSolverInjection()
        const hostScopePath = normalizedSolverEnv[ENGAGEMENT_ENV_SCOPE]?.trim() || undefined

        try {
            const proc = this.backend.spawn({
                solverId: id,
                containerName: name,
                solverEnv: normalizedSolverEnv,
                injectionCmd: injection.cmd,
                extraBinds: injection.binds,
                hostScopePath,
                hostBaseDir: baseDir,
                hostSessionDir: sessionDir,
                hostWorkspaceDir: workspaceDir,
            })

            this.procs.set(id, proc)
            solver.status = "running"

            // Start reading JSONL, wait for init handshake to complete
            const initReady = this.readStream(id, proc)
            const initPayload: SolverInitPayload = { solverId: id, promptName, task, challengeId: solver.challengeId, resume: options?.resume === true }
            proc.stdin.write(JSON.stringify(initPayload) + "\n")
            await initReady

            // Init done — task prompt is auto-executed by RPC server

            return solver
        } catch (err) {
            solver.status = "error"
            solver.error = err instanceof Error ? err.message : String(err)
            await this.appendSolverStartupLog(id, `[launch-error] ${solver.error}`)
            // spawn 成功但 init 握手失败时（如 RPC server 返回 success:false 却仍在运行），
            // 必须显式杀掉子进程，否则 clearSolverRuntimeState 删掉句柄后本地 client + 远端 solver 双泄漏。
            this.procs.get(id)?.kill()
            this.clearSolverRuntimeState(id)
            throw err
        }
    }

    /** Send an RPC command to a solver's stdin */
    sendCommand(solverId: string, command: RpcCommand) {
        const proc = this.procs.get(solverId)
        if (!proc) throw new Error(`No process for solver ${solverId}`)
        proc.stdin.write(JSON.stringify(command) + "\n")
    }

    /** Stop a solver container */
    async stopSolver(solverId: string) {
        const solver = this.solvers.get(solverId)
        if (!solver) throw new Error(`Solver ${solverId} not found`)

        solver.status = "stopping"

        try {
            await this.backend.stop({ solverId, containerName: solver.containerId })
        } catch (error) {
            // backend.stop 失败不再静默：docker(--rm) 下容器多半已随退出清理，但 ssh 后端靠远端
            // pkill 关闭，失败时远端 solver 可能孤儿化（本地 proc 仍会被 finally 兜底 kill）。
            // 记录日志让操作员能察觉并手动清理远端残留。
            console.error(
                `[runtime] backend.stop failed for solver ${solverId} (backend=${this.backend.kind}): ${error instanceof Error ? error.message : String(error)}`,
            )
        } finally {
            // 显式关闭本地 client 子进程（docker run -i / ssh）。docker 下 --rm 容器退出后
            // 它本会自行结束；但 ssh 后端依赖远端 pkill 关闭管道，一旦 pkill 失败或连接挂死，
            // 不主动 kill 就会泄漏一个本地 ssh 进程。这里兜底杀掉。
            this.procs.get(solverId)?.kill()
            solver.status = "stopped"
            this.clearSolverRuntimeState(solverId)
        }
    }

    /**
     * 续跑一个已停止的 solver:用同一个 solverId 重新起进程,加载它落盘的旧 session 接着推进。
     * promptName/task/challengeId 从落盘的 startup.json 恢复;solverEnv 由调用方(ChallengeManager)重建。
     * 与 launch 的区别只有 resume:true —— session 走 continueRecent、RPC 不重发原始 task。
     */
    async resumeSolver(solverId: string, solverEnv: Record<string, string>): Promise<SolverInstance> {
        const id = solverId.trim()
        if (!id) throw new Error("solverId is required")
        const existing = this.solvers.get(id)
        if (existing && (existing.status === "running" || existing.status === "starting")) {
            throw new Error(`solver ${id} is already active`)
        }
        const startup = await readStartup(solverStartupPath(id))
        const init =
            startup && typeof startup === "object" && "init" in startup
                ? (startup as { init?: { promptName?: string; task?: string } }).init
                : undefined
        const promptName = init?.promptName?.trim()
        if (!promptName) throw new Error(`cannot resume solver ${id}: missing startup info`)
        const task = init?.task ?? ""
        return this.launch(promptName, task, solverEnv, { solverId: id, resume: true })
    }

    /** List all tracked solver instances */
    list(): SolverInstance[] {
        return [...this.solvers.values()]
    }

    async listAll(): Promise<SolverInstance[]> {
        const items = new Map<string, SolverInstance>()
        for (const solver of this.solvers.values()) items.set(solver.id, solver)

        let solverIds: string[] = []
        try {
            solverIds = (await readdir(SOLVERS_DIR, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
        } catch {
            return [...items.values()].sort((a, b) => b.createdAt - a.createdAt)
        }

        for (const solverId of solverIds) {
            if (items.has(solverId)) continue
            const startup = await readStartup(solverStartupPath(solverId))
            const mainSession = await readMessagesFromSessionDir(solverSessionDir(solverId))
            const startupInit =
                startup && typeof startup === "object" && "init" in startup
                    ? (startup as { init?: { promptName?: string; task?: string; challengeId?: string } }).init
                    : undefined
            const status = getAssistantError(mainSession.messages) ? "error" : "stopped"
            const createdAt = await getStableSolverCreatedAt(solverId, startup, mainSession.createdAt)
            items.set(solverId, {
                id: solverId,
                containerId: `${SOLVER_NAME_PREFIX}-${solverId}`,
                name: `${SOLVER_NAME_PREFIX}-${solverId}`,
                promptName: startupInit?.promptName ?? "unknown",
                task: startupInit?.task ?? "",
                challengeId: startupInit?.challengeId?.trim() || undefined,
                status,
                createdAt,
                error: getAssistantError(mainSession.messages),
            })
        }

        return [...items.values()].sort((a, b) => b.createdAt - a.createdAt)
    }

    /** Get a solver by ID */
    get(solverId: string): SolverInstance | undefined {
        return this.solvers.get(solverId)
    }

    async getDetails(solverId: string): Promise<RuntimeSolverDetails | undefined> {
        const solver = this.get(solverId) ?? (await this.listAll()).find((item) => item.id === solverId)
        if (!solver) return undefined

        const startup = await readStartup(solverStartupPath(solverId))
        const mainSession = await readMessagesFromSessionDir(solverSessionDir(solverId))
        const threads: RuntimeMessageThread[] = [
            {
                id: `${solverId}:main`,
                solverId,
                kind: "main",
                label: "Main",
                promptName: solver.promptName,
                task: solver.task,
                sessionId: mainSession.sessionId,
                createdAt: mainSession.createdAt,
                messages: mergeMainThreadMessages(mainSession.messages, this.liveMainThreadMessages.get(solverId) ?? []),
            },
        ]

        const subagentsDir = resolve(solverWorkspaceDir(solverId), ".subagents")
        try {
            const entries = await readdir(subagentsDir, { withFileTypes: true })
            for (const entry of entries) {
                if (!entry.isDirectory()) continue
                const subagentDir = resolve(subagentsDir, entry.name)
                const subStartup = await readStartup(resolve(subagentDir, "startup.json"))
                const subSession = await readMessagesFromSessionDir(resolve(subagentDir, "session"))
                const init =
                    subStartup && typeof subStartup === "object" && "init" in subStartup
                        ? (subStartup as { init?: { promptName?: string; task?: string; parentToolCallId?: string } }).init
                        : undefined
                threads.push({
                    id: `${solverId}:subagent:${entry.name}`,
                    solverId,
                    kind: "subagent",
                    label: entry.name,
                    parentToolCallId: init?.parentToolCallId?.trim() || undefined,
                    promptName: init?.promptName,
                    task: init?.task,
                    sessionId: subSession.sessionId,
                    createdAt: subSession.createdAt,
                    messages: subSession.messages,
                })
            }
        } catch {}

        const observerSessionDir = resolve(solverSessionDir(solverId), ".observer")
        if (await pathExists(observerSessionDir)) {
            const observerSession = await readMessagesFromSessionDir(observerSessionDir)
            threads.push(...splitObserverThreads(solverId, observerSession))
        }

        threads.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        return { solver, threads, startup }
    }

    /** Remove a stopped solver from tracking */
    remove(solverId: string) {
        const solver = this.solvers.get(solverId)
        if (solver && (solver.status === "stopped" || solver.status === "error")) {
            this.solvers.delete(solverId)
            this.clearSolverRuntimeState(solverId)
        }
    }

    async deleteSolver(solverId: string) {
        const solver = this.solvers.get(solverId)
        if (solver && (solver.status === "running" || solver.status === "starting" || solver.status === "stopping")) {
            throw new Error(`Solver ${solverId} is still running`)
        }

        this.solvers.delete(solverId)
        this.clearSolverRuntimeState(solverId)

        const sourceDir = solverDir(solverId)
        if (!(await pathExists(sourceDir))) return

        await mkdir(ARCHIVE_SOLVERS_DIR, { recursive: true })
        let archiveDir = resolve(ARCHIVE_SOLVERS_DIR, solverId)
        if (await pathExists(archiveDir)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-")
            archiveDir = resolve(ARCHIVE_SOLVERS_DIR, `${solverId}-${stamp}`)
        }
        await rename(sourceDir, archiveDir)
    }

    /** Stop all running solvers */
    async stopAll() {
        const running = [...this.solvers.values()].filter((s) => s.status === "running" || s.status === "starting")
        await Promise.allSettled(running.map((s) => this.stopSolver(s.id)))
    }

    private readStream(solverId: string, proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
        // stdout / stderr 各自独立的流式 decoder：共用一个 streaming decoder 会让两路字节互相污染；
        // 且必须 decode(value, { stream: true })，否则跨 read() chunk 的多字节字符（中文等）会被截断成 U+FFFD。
        const stdoutDecoder = new TextDecoder()

        // Promise resolves when init response is received
        let resolveInit!: () => void
        let rejectInit!: (err: Error) => void
        const initReady = new Promise<void>((res, rej) => {
            resolveInit = res
            rejectInit = rej
        })

        // Read stdout for JSONL events
        ;(async () => {
            const reader = proc.stdout.getReader()
            let buffer = ""
            let initResolved = false
            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    buffer += stdoutDecoder.decode(value, { stream: true })
                    const parts = buffer.split("\n")
                    buffer = parts.pop()!
                    for (const line of parts) {
                        if (!line.trim()) continue
                        try {
                            const parsed = JSON.parse(line)
                            if (isHostBridgeRequestEvent(parsed)) {
                                // 不要 await：host-bridge 动作可能较慢（启动/停止 solver、广播等），
                                // 在读循环里 await 会卡住后续所有 stdout 事件（tool 结果、agent_end）。
                                // 异步派发，响应通过 stdin 回写，与读循环解耦。
                                void this.handleHostBridgeRequest(solverId, parsed)
                                continue
                            }
                            if (parsed.type === "response") {
                                if (!initResolved && parsed.command === "init") {
                                    initResolved = true
                                    if (parsed.success) {
                                        resolveInit()
                                    } else {
                                        rejectInit(new Error(parsed.error ?? "init failed"))
                                    }
                                }
                                continue
                            }
                            const event = parsed as AgentSessionEvent
                            const finalError = getAgentEndError(event)
                            if (event.type === "agent_end") {
                                this.recordAgentEnd(solverId, finalError)
                            }
                            this.emit(solverId, event)
                        } catch {
                            // ignore malformed stdout lines
                        }
                    }
                }
            } catch (error) {
                console.error(`[runtime:${solverId}] stdout reader failed`, formatError(error))
                const solver = this.solvers.get(solverId)
                if (solver && !solver.error) {
                    solver.error = error instanceof Error ? error.message : String(error)
                }
                await this.appendSolverStartupLog(solverId, `[stdout-reader-failed] ${formatError(error)}`)
                if (!initResolved) {
                    rejectInit(error instanceof Error ? error : new Error(String(error)))
                }
            } finally {
                if (!initResolved) {
                    rejectInit(new Error("solver process exited before init response"))
                }
                const solver = this.solvers.get(solverId)
                if (solver && (solver.status === "running" || solver.status === "starting" || solver.status === "stopping")) {
                    solver.status = solver.error ? "error" : "stopped"
                }
                this.clearSolverRuntimeState(solverId)
            }
        })().catch((error) => {
            console.error(`[runtime:${solverId}] stdout loop crashed`, formatError(error))
        })

        // Read stderr (log for debugging)
        ;(async () => {
            const stderrDecoder = new TextDecoder()
            try {
                const reader = proc.stderr.getReader()
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    const text = stderrDecoder.decode(value, { stream: true }).trim()
                    if (!text) continue
                    console.error(`[solver:${solverId}:stderr]`, text)
                    await this.appendSolverStartupLog(solverId, `[stderr] ${text}`)
                }
            } catch (error) {
                console.error(`[runtime:${solverId}] stderr reader failed`, formatError(error))
                await this.appendSolverStartupLog(solverId, `[stderr-reader-failed] ${formatError(error)}`)
            }
        })().catch((error) => {
            console.error(`[runtime:${solverId}] stderr loop crashed`, formatError(error))
        })

        return initReady
    }
}
