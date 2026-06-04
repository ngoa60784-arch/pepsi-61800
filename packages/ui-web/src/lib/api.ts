import type { ActivateModelResult, AddResult, HostSettings } from "../../../core/src/config/index"
import type { ChallengeInfoRecord, ChallengeAttemptLogRecord, ChallengeSubmissionLogRecord } from "../../../core/src/challenge/store"
import type { AddIdeaResult, IdeaRecord, MemoryEntry } from "../../../core/src/challenge/manager"
import type { AttackTimelineEvent, AttackTimelineSnapshot } from "../../../core/src/challenge/attack-timeline"
import type { ChallengeStatsOverview, ChallengeStatsOverviewBucket, ChallengeStatsRecord, SolverStatsRecord } from "../../../core/src/challenge/stats"
import type { McpServerItem, ProbeResult } from "../../../core/src/config/mcp/index"
import type { PromptFile } from "../../../core/src/config/prompts/index"
import type { BuiltInProvider, ConfiguredModel, ModelConfigEntry, ModelDefinition, ProviderPrefEntry } from "../../../core/src/config/providers/types"
import type { ToolEntry } from "../../../core/src/config/tools/index"
import type { KaliSshTestResult } from "../../../core/src/runtime/kali-ssh"
import type { KaliSystemStats } from "../../../core/src/runtime/kali-stats"
import type { RuntimeMessageThread, RuntimeSolverDetails, SolverInstance } from "../../../core/src/runtime/types"
import type { Skill } from "@mariozechner/pi-coding-agent"
import type { Api, Model } from "@mariozechner/pi-ai"
import type { ServerEntry as McpServerEntry, McpSettings } from "pi-mcp-adapter/types.js"

// 从 @tch/core re-export，前端组件直接用
export type {
    ActivateModelResult,
    AddResult,
    HostSettings,
    ModelConfigEntry,
    ModelDefinition,
    ToolEntry,
    ChallengeInfoRecord,
    ChallengeAttemptLogRecord,
    ChallengeSubmissionLogRecord,
    ChallengeStatsRecord,
    ChallengeStatsOverview,
    ChallengeStatsOverviewBucket,
    AttackTimelineEvent,
    AttackTimelineSnapshot,
    SolverStatsRecord,
    MemoryEntry,
    IdeaRecord,
    McpServerEntry,
    McpServerItem,
    McpSettings,
    BuiltInProvider,
    ConfiguredModel,
    PromptFile,
    ProbeResult,
    SolverInstance,
    KaliSystemStats,
    RuntimeMessageThread,
    RuntimeSolverDetails,
    Skill,
    Model,
    Api,
}
export type ProviderEntry = ProviderPrefEntry

// ── HTTP helpers ──

async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init)
    const text = await res.text()
    const body = text ? safeParseJson(text) : null
    if (!res.ok) {
        const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`
        throw new Error(message)
    }
    return body as T
}

function safeParseJson(text: string): Record<string, unknown> | unknown {
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

function resolveErrorMessage(status: number, statusText: string, body: unknown): string {
    return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `${status} ${statusText}`
}

function parseDownloadFileName(contentDisposition: string | null): string | undefined {
    if (!contentDisposition) return

    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
    if (utf8Match?.[1]) {
        try {
            return decodeURIComponent(utf8Match[1])
        } catch {
            return utf8Match[1]
        }
    }

    const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i)
    return plainMatch?.[1]
}

function post(url: string, body: unknown) {
    return json<{ ok: boolean }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
}

function del(url: string, body: unknown) {
    return json<{ ok: boolean }>(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
}

function patch(url: string, body: unknown) {
    return json<{ ok: boolean }>(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
}

async function download(url: string): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(url)
    if (!res.ok) {
        const text = await res.text()
        throw new Error(resolveErrorMessage(res.status, res.statusText, text ? safeParseJson(text) : null))
    }

    return {
        blob: await res.blob(),
        fileName: parseDownloadFileName(res.headers.get("Content-Disposition")) ?? "download.bin",
    }
}

// ── API Keys ──

export const apiKeys = {
    list: () => json<string[]>("/api/config/api-keys"),
    set: (provider: string, key: string) => post("/api/config/api-keys", { provider, key }),
    remove: (provider: string) => del("/api/config/api-keys", { provider }),
}

// ── Providers ──

export const providers = {
    list: () => json<ProviderEntry[]>("/api/config/providers"),
    add: (entry: Omit<ProviderEntry, "id" | "hash"> & { id?: string }) =>
        json<AddResult>("/api/config/providers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
        }),
    update: (id: string, fields: Partial<ProviderEntry>) =>
        json<AddResult>("/api/config/providers", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, ...fields }),
        }),
    remove: (id: string) => del("/api/config/providers", { id }),
}

// ── Models ──

export const models = {
    list: () => json<Model<Api>[]>("/api/config/models"),
}

export const providerModels = {
    list: () => json<ConfiguredModel[]>("/api/config/provider-models"),
    add: (provider: string, model: ModelDefinition) => post("/api/config/provider-models", { provider, model }),
    remove: (provider: string, modelId: string) => del("/api/config/provider-models", { provider, modelId }),
}

export const modelPrefs = {
    list: () => json<ModelConfigEntry[]>("/api/config/model-prefs"),
    add: (entry: ModelConfigEntry) =>
        json<AddResult>("/api/config/model-prefs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
        }),
    remove: (id: string) => del("/api/config/model-prefs", { id }),
    test: (id: string) =>
        json<{
            ok: boolean
            error?: string
            response?: string
            details?: {
                modelPrefId: string
                provider: string
                providerId?: string
                providerLabel: string
                runtimeProvider: string
                modelId: string
                api?: string
                baseUrl?: string
                baseOrigin?: string
                baseHost?: string
                basePath?: string
                thinkingLevel?: string
                reasoning?: boolean
                contextWindow?: number
                maxTokens?: number
                apiKeySummary?: string
                headers?: Record<string, string>
                compat?: Record<string, unknown>
            }
        }>("/api/config/test-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
        }),
    activate: (id: string) =>
        json<ActivateModelResult>("/api/config/activate-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
        }),
}

// ── Skills ──

export const skills = {
    list: () => json<Pick<Skill, "name" | "description" | "filePath">[]>("/api/config/skills"),
    upload: async (file: File) => {
        const form = new FormData()
        form.append("file", file)
        const res = await fetch("/api/config/skills", { method: "POST", body: form })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || `${res.status} ${res.statusText}`)
        }
        return res.json() as Promise<{ name: string }>
    },
    remove: (name: string) => del("/api/config/skills", { name }),
    content: (name: string) => json<{ content: string }>(`/api/config/skills/${encodeURIComponent(name)}/content`),
    installFromGit: async (url: string) => {
        const res = await fetch("/api/config/skills-git", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
        })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error || `${res.status} ${res.statusText}`)
        }
        return res.json() as Promise<{ name: string }>
    },
}

// ── Prompts ──

export const prompts = {
    listAgents: () => json<PromptFile[]>("/api/config/prompts?type=agent"),
    listSubagents: () => json<PromptFile[]>("/api/config/prompts?type=subagent"),
    set: (prompt: PromptFile) => post("/api/config/prompts", prompt),
    remove: (name: string) => del("/api/config/prompts", { name }),
}

// ── Tools ──

export const tools = {
    list: () => json<ToolEntry[]>("/api/config/tools"),
}

// ── MCP Servers ──

export interface KaliSshTestResult {
    ok: boolean
    message: string
    uid?: string
    isRoot?: boolean
}

export interface KaliToolCheckEntry {
    tool: string
    ok: boolean
    path?: string
}

export interface KaliToolCheckResult {
    ready: string[]
    missing: string[]
    entries: KaliToolCheckEntry[]
}

export type KaliProvisionEvent =
    | { type: "log"; line: string; stream: "stdout" | "stderr" }
    | { type: "done"; exitCode: number; ok: boolean }
    | { type: "error"; message: string }

export const mcpServers = {
    list: () => json<McpServerItem[]>("/api/config/mcp"),
    add: (name: string, server: McpServerEntry) => post("/api/config/mcp", { name, server }),
    remove: (name: string) => del("/api/config/mcp", { name }),
    update: (name: string, server: Partial<McpServerEntry>, newName?: string) => patch("/api/config/mcp", { name, server, newName }),
    probe: (name?: string) =>
        json<ProbeResult | ProbeResult[]>("/api/config/mcp-probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        }),
    probeDraft: (name: string, server: McpServerEntry) =>
        json<ProbeResult>("/api/config/mcp-probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, server }),
        }),
    checkKaliTools: (env: Record<string, string>) =>
        json<KaliToolCheckResult>("/api/config/mcp/kali-tool-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ env }),
        }),
    async testKaliSsh(env: Record<string, string>): Promise<KaliSshTestResult> {
        const res = await fetch("/api/config/mcp/kali-ssh-test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ env }),
        })
        const body = (await res.json()) as KaliSshTestResult
        return body
    },
    async provisionKali(
        env: Record<string, string>,
        onEvent: (event: KaliProvisionEvent) => void,
        signal?: AbortSignal,
    ): Promise<void> {
        const res = await fetch("/api/config/mcp/kali-provision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ env }),
            signal,
        })
        if (!res.ok) {
            const text = await res.text()
            throw new Error(text || `${res.status} ${res.statusText}`)
        }
        if (!res.body) throw new Error("无响应流")

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        const dispatch = (block: string) => {
            const lines = block.split("\n")
            let eventName = ""
            let dataLine = ""
            for (const line of lines) {
                if (line.startsWith("event: ")) eventName = line.slice(7).trim()
                else if (line.startsWith("data: ")) dataLine = line.slice(6)
            }
            if (!eventName || !dataLine) return
            const data = JSON.parse(dataLine) as Record<string, unknown>
            if (eventName === "log") {
                onEvent({
                    type: "log",
                    line: String(data.line ?? ""),
                    stream: data.stream === "stderr" ? "stderr" : "stdout",
                })
            } else if (eventName === "done") {
                onEvent({
                    type: "done",
                    exitCode: Number(data.exitCode ?? 1),
                    ok: Boolean(data.ok),
                })
            } else if (eventName === "error") {
                onEvent({ type: "error", message: String(data.message ?? "unknown error") })
            }
        }

        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let sep: number
            while ((sep = buffer.indexOf("\n\n")) >= 0) {
                const block = buffer.slice(0, sep)
                buffer = buffer.slice(sep + 2)
                if (block.trim()) dispatch(block)
            }
        }
        if (buffer.trim()) dispatch(buffer)
    },
}

// ── MCP Settings ──

export const mcpSettings = {
    get: () => json<McpSettings>("/api/config/mcp-settings"),
    set: (settings: McpSettings) => post("/api/config/mcp-settings", settings),
}

export const auth = {
    status: () => json<{ authRequired: boolean; authed: boolean }>("/api/auth/status"),
    login: (token: string) =>
        json<{ ok: boolean }>("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
        }),
    logout: () => json<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
}

export const hostSettings = {
    get: () => json<HostSettings>("/api/config/host-settings"),
    set: (settings: Partial<HostSettings>) =>
        json<HostSettings>("/api/config/host-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
        }),
}

export const hostPlannerPrompt = {
    get: () => json<PromptFile>("/api/config/host-planner-prompt"),
    set: (content: string, model?: string) =>
        json<PromptFile>("/api/config/host-planner-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, model }),
        }),
}

export interface ChallengeDetails {
    challenge: ChallengeInfoRecord
    memory: MemoryEntry[]
    ideas: IdeaRecord[]
    attempts: ChallengeAttemptLogRecord[]
    submissions: ChallengeSubmissionLogRecord[]
    stats: ChallengeStatsRecord
    solver_stats: SolverStatsRecord[]
    solvers: SolverInstance[]
}

export const challenges = {
    list: () => json<ChallengeInfoRecord[]>("/api/challenges"),
    get: (id: string) => json<ChallengeDetails>(`/api/challenges/${encodeURIComponent(id)}`),
    delete: (id: string) =>
        json<{ ok: boolean; deletedSolvers: string[] }>(`/api/challenges/${encodeURIComponent(id)}`, {
            method: "DELETE",
        }),
    attackTimeline: (id: string) => json<AttackTimelineSnapshot>(`/api/challenges/${encodeURIComponent(id)}/attack-timeline`),
    exportSolverSessions: (id: string) => download(`/api/challenges/${encodeURIComponent(id)}/solver-sessions.zip`),
    startSolver: (id: string, promptName: string) =>
        json<SolverInstance>(`/api/challenges/${encodeURIComponent(id)}/solvers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptName }),
        }),
    complete: (id: string) => json<{ ok: boolean }>(`/api/challenges/${encodeURIComponent(id)}/complete`, { method: "POST" }),
    revokeComplete: (id: string) =>
        json<{ ok: boolean; resumed: string[] }>(`/api/challenges/${encodeURIComponent(id)}/revoke-complete`, { method: "POST" }),
    pauseTesting: (id: string) =>
        json<{ ok: boolean; stoppedSolvers: string[] }>(`/api/challenges/${encodeURIComponent(id)}/pause-testing`, { method: "POST" }),
    resumeTesting: (id: string) =>
        json<{ ok: boolean; resumed: string[] }>(`/api/challenges/${encodeURIComponent(id)}/resume-testing`, { method: "POST" }),
    addMemory: (id: string, input: { kind: MemoryEntry["kind"]; content: string; refs?: string[]; source?: string }) =>
        json<MemoryEntry>(`/api/challenges/${encodeURIComponent(id)}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        }),
    updateMemory: (
        id: string,
        entryId: string,
        patch: { kind?: MemoryEntry["kind"]; content?: string; refs?: string[]; source?: string },
    ) =>
        json<MemoryEntry>(`/api/challenges/${encodeURIComponent(id)}/memory/${encodeURIComponent(entryId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        }),
    deleteMemory: (id: string, entryId: string) =>
        json<MemoryEntry>(`/api/challenges/${encodeURIComponent(id)}/memory/${encodeURIComponent(entryId)}`, {
            method: "DELETE",
        }),
    addIdea: (id: string, input: { content: string; status?: IdeaRecord["status"]; result?: string }) =>
        json<AddIdeaResult>(`/api/challenges/${encodeURIComponent(id)}/ideas`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        }),
    updateIdea: (
        id: string,
        ideaId: string,
        patch: { content?: string; status?: IdeaRecord["status"]; result?: string },
    ) =>
        json<IdeaRecord>(`/api/challenges/${encodeURIComponent(id)}/ideas/${encodeURIComponent(ideaId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        }),
    deleteIdea: (id: string, ideaId: string) =>
        json<IdeaRecord>(`/api/challenges/${encodeURIComponent(id)}/ideas/${encodeURIComponent(ideaId)}`, {
            method: "DELETE",
        }),
    statsOverview: () => json<ChallengeStatsOverview>("/api/challenges/stats-overview"),
}

// ── Built-in Reference ──

export const builtIn = {
    providers: () => json<BuiltInProvider[]>("/api/config/built-in/providers"),
    protocols: () => json<string[]>("/api/config/built-in/protocols"),
    models: (provider: string) => json<Model<Api>[]>(`/api/config/built-in/models/${encodeURIComponent(provider)}`),
    lookupModel: (api: string, modelId: string) =>
        json<Model<Api> | null>(`/api/config/built-in/model-lookup?api=${encodeURIComponent(api)}&modelId=${encodeURIComponent(modelId)}`),
    discoverModels: (provider: string) => json<Array<{ id: string; name: string }>>(`/api/config/discover-models/${encodeURIComponent(provider)}`),
}

// ── Runtime (Container Management) ──

export interface RuntimeStatus {
    docker: boolean
    solvers: number
}

export interface KaliProbeResult {
    ssh: KaliSshTestResult
    stats: KaliSystemStats
}

export type { KaliSystemStats }

export const runtime = {
    status: () => json<RuntimeStatus>("/api/runtime/status"),
    probeKali: () =>
        json<KaliProbeResult>("/api/runtime/kali-probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        }),
    list: () => json<SolverInstance[]>("/api/runtime/solvers"),
    start: (promptName: string, task: string) =>
        json<SolverInstance>("/api/runtime/solvers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promptName, task }),
        }),
    get: (id: string) => json<RuntimeSolverDetails>(`/api/runtime/solvers/${id}`),
    stop: (id: string) => json<{ ok: boolean }>(`/api/runtime/solvers/${id}`, { method: "DELETE" }),
    send: (id: string, message: Record<string, unknown>) => post(`/api/runtime/solvers/${id}/command`, message),
}

// ── Commander (对话式渗透指挥官) ──

export interface CommanderSessionItem {
    id: string
    path: string
    created: string
    modified: string
    messageCount: number
    preview: string
    active: boolean
}

export interface CommanderMessageAttachment {
    name: string
    content: string
}

export const commander = {
    send: (message: string, attachment?: CommanderMessageAttachment) =>
        json<{ accepted: boolean }>("/api/commander/message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, attachment }),
        }),
    history: () => json<{ entries: unknown[] }>("/api/commander/history"),
    messages: () => json<{ messages: Array<{ role: "user" | "assistant"; text: string }> }>("/api/commander/messages"),
    status: () => json<{ busy: boolean }>("/api/commander/status"),
    newSession: () => json<{ ok: boolean }>("/api/commander/new-session", { method: "POST" }),
    sessions: () => json<{ sessions: CommanderSessionItem[] }>("/api/commander/sessions"),
    switchSession: (path: string) =>
        json<{ ok: boolean; messages: Array<{ role: "user" | "assistant"; text: string }> }>("/api/commander/sessions/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        }),
    deleteSession: (path: string) =>
        json<{
            ok: boolean
            messages: Array<{ role: "user" | "assistant"; text: string }>
            sessions: CommanderSessionItem[]
        }>("/api/commander/sessions/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        }),
    rollbackPoints: () => json<{ points: Array<{ entryId: string; text: string }> }>("/api/commander/rollback-points"),
    rollback: (entryId: string) =>
        json<{ ok: boolean; messages: Array<{ role: "user" | "assistant"; text: string }> }>("/api/commander/rollback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entryId }),
        }),
}
