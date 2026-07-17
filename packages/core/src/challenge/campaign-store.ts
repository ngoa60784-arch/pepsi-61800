import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

export type CampaignTaskStatus = "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled"
export type CampaignTaskRole = "planner" | "recon" | "researcher" | "exploit" | "verifier" | "reporter" | "custom"

export interface CampaignTask {
    id: string
    challengeId: string
    parentId?: string
    title: string
    description: string
    status: CampaignTaskStatus
    role: CampaignTaskRole
    assignedSolverId?: string
    priority: number
    budgetTurns?: number
    budgetTokens?: number
    dependsOn: string[]
    successCriteria?: string
    exitCriteria?: string
    evidenceRefs: string[]
    createdAt: string
    updatedAt: string
}

export interface CreateCampaignTaskInput {
    challengeId: string
    parentId?: string
    title: string
    description?: string
    role?: CampaignTaskRole
    priority?: number
    budgetTurns?: number
    budgetTokens?: number
    dependsOn?: string[]
    successCriteria?: string
    exitCriteria?: string
}

export interface UpdateCampaignTaskInput {
    status?: CampaignTaskStatus
    assignedSolverId?: string | null
    priority?: number
    budgetTurns?: number | null
    budgetTokens?: number | null
    dependsOn?: string[]
    successCriteria?: string | null
    exitCriteria?: string | null
    evidenceRefs?: string[]
}

export type ArtifactKind = "command-output" | "http" | "screenshot" | "poc" | "loot" | "report" | "file" | "note"

export interface CampaignArtifact {
    id: string
    challengeId: string
    taskId?: string
    actionId?: string
    solverId?: string
    kind: ArtifactKind
    name: string
    uri: string
    sha256?: string
    mediaType?: string
    metadata: Record<string, unknown>
    createdAt: string
}

export interface CreateCampaignArtifactInput {
    challengeId: string
    taskId?: string
    actionId?: string
    solverId?: string
    kind: ArtifactKind
    name: string
    uri: string
    sha256?: string
    mediaType?: string
    metadata?: Record<string, unknown>
}

export interface CampaignTraceEvent {
    id: string
    traceId: string
    parentSpanId?: string
    challengeId?: string
    solverId?: string
    taskId?: string
    category: string
    name: string
    status: "running" | "ok" | "error"
    startedAt: string
    endedAt?: string
    durationMs?: number
    attributes: Record<string, unknown>
}

export interface IndexedMemory {
    id: string
    challengeId: string
    kind: string
    content: string
    sourceRef?: string
    confidence: number
    createdAt: string
    updatedAt: string
}

interface TaskRow {
    id: string
    challenge_id: string
    parent_id: string | null
    title: string
    description: string
    status: CampaignTaskStatus
    role: CampaignTaskRole
    assigned_solver_id: string | null
    priority: number
    budget_turns: number | null
    budget_tokens: number | null
    depends_on_json: string
    success_criteria: string | null
    exit_criteria: string | null
    evidence_refs_json: string
    created_at: string
    updated_at: string
}

interface ArtifactRow {
    id: string
    challenge_id: string
    task_id: string | null
    action_id: string | null
    solver_id: string | null
    kind: ArtifactKind
    name: string
    uri: string
    sha256: string | null
    media_type: string | null
    metadata_json: string
    created_at: string
}

interface TraceRow {
    id: string
    trace_id: string
    parent_span_id: string | null
    challenge_id: string | null
    solver_id: string | null
    task_id: string | null
    category: string
    name: string
    status: "running" | "ok" | "error"
    started_at: string
    ended_at: string | null
    duration_ms: number | null
    attributes_json: string
}

interface MemoryRow {
    id: string
    challenge_id: string
    kind: string
    content: string
    source_ref: string | null
    confidence: number
    created_at: string
    updated_at: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function requireText(value: string, field: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${field} is required`)
    return text
}

function uniqueText(items: string[] | undefined): string[] {
    return [...new Set((items ?? []).map((item) => item.trim()).filter(Boolean))]
}

function parseStringArray(value: string): string[] {
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
    } catch {
        return []
    }
}

function parseObject(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
        return {}
    }
}

function taskFromRow(row: TaskRow): CampaignTask {
    return {
        id: row.id,
        challengeId: row.challenge_id,
        parentId: row.parent_id ?? undefined,
        title: row.title,
        description: row.description,
        status: row.status,
        role: row.role,
        assignedSolverId: row.assigned_solver_id ?? undefined,
        priority: row.priority,
        budgetTurns: row.budget_turns ?? undefined,
        budgetTokens: row.budget_tokens ?? undefined,
        dependsOn: parseStringArray(row.depends_on_json),
        successCriteria: row.success_criteria ?? undefined,
        exitCriteria: row.exit_criteria ?? undefined,
        evidenceRefs: parseStringArray(row.evidence_refs_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

function artifactFromRow(row: ArtifactRow): CampaignArtifact {
    return {
        id: row.id,
        challengeId: row.challenge_id,
        taskId: row.task_id ?? undefined,
        actionId: row.action_id ?? undefined,
        solverId: row.solver_id ?? undefined,
        kind: row.kind,
        name: row.name,
        uri: row.uri,
        sha256: row.sha256 ?? undefined,
        mediaType: row.media_type ?? undefined,
        metadata: parseObject(row.metadata_json),
        createdAt: row.created_at,
    }
}

export class CampaignStore {
    private constructor(private readonly db: Database) {}

    static async open(rootDir: string): Promise<CampaignStore> {
        await mkdir(rootDir, { recursive: true })
        const db = new Database(resolve(rootDir, "campaign.db"), { create: true, readwrite: true, strict: true })
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA foreign_keys = ON")
        const store = new CampaignStore(db)
        store.migrate()
        return store
    }

    private migrate(): void {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS campaign_tasks (
                id TEXT PRIMARY KEY,
                challenge_id TEXT NOT NULL,
                parent_id TEXT,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                status TEXT NOT NULL,
                role TEXT NOT NULL,
                assigned_solver_id TEXT,
                priority INTEGER NOT NULL DEFAULT 50,
                budget_turns INTEGER,
                budget_tokens INTEGER,
                depends_on_json TEXT NOT NULL DEFAULT '[]',
                success_criteria TEXT,
                exit_criteria TEXT,
                evidence_refs_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `)
        this.db.run("CREATE INDEX IF NOT EXISTS idx_campaign_tasks_challenge_status ON campaign_tasks(challenge_id, status, priority DESC)")
        this.db.run(`
            CREATE TABLE IF NOT EXISTS campaign_artifacts (
                id TEXT PRIMARY KEY,
                challenge_id TEXT NOT NULL,
                task_id TEXT,
                action_id TEXT,
                solver_id TEXT,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                uri TEXT NOT NULL,
                sha256 TEXT,
                media_type TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            )
        `)
        this.db.run("CREATE INDEX IF NOT EXISTS idx_campaign_artifacts_challenge ON campaign_artifacts(challenge_id, task_id, created_at DESC)")
        this.db.run(`
            CREATE TABLE IF NOT EXISTS campaign_traces (
                id TEXT PRIMARY KEY,
                trace_id TEXT NOT NULL,
                parent_span_id TEXT,
                challenge_id TEXT,
                solver_id TEXT,
                task_id TEXT,
                category TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                duration_ms INTEGER,
                attributes_json TEXT NOT NULL DEFAULT '{}'
            )
        `)
        this.db.run("CREATE INDEX IF NOT EXISTS idx_campaign_traces_trace ON campaign_traces(trace_id, started_at)")
        this.db.run(`
            CREATE TABLE IF NOT EXISTS campaign_memory (
                id TEXT PRIMARY KEY,
                challenge_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                source_ref TEXT,
                confidence REAL NOT NULL DEFAULT 0.5,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `)
        this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS campaign_memory_fts USING fts5(id UNINDEXED, challenge_id UNINDEXED, content)")
    }

    private run(sql: string, ...params: Array<string | number | bigint | boolean | Uint8Array | null>): void {
        const statement = this.db.prepare(sql)
        try {
            statement.run(...params)
        } finally {
            statement.finalize()
        }
    }

    private get<T>(sql: string, ...params: Array<string | number | bigint | boolean | Uint8Array | null>): T | undefined {
        const statement = this.db.prepare(sql)
        try {
            return (statement.get(...params) as T | null) ?? undefined
        } finally {
            statement.finalize()
        }
    }

    private all<T>(sql: string, ...params: Array<string | number | bigint | boolean | Uint8Array | null>): T[] {
        const statement = this.db.prepare(sql)
        try {
            return statement.all(...params) as T[]
        } finally {
            statement.finalize()
        }
    }

    close(): void {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        this.db.close(true)
    }

    createTask(input: CreateCampaignTaskInput): CampaignTask {
        const challengeId = requireText(input.challengeId, "challengeId")
        const title = requireText(input.title, "title")
        const dependsOn = uniqueText(input.dependsOn)
        this.assertTaskReferences(challengeId, input.parentId, dependsOn)
        const id = `task_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
        const now = nowIso()
        this.run(`
            INSERT INTO campaign_tasks (
                id, challenge_id, parent_id, title, description, status, role, priority,
                budget_turns, budget_tokens, depends_on_json, success_criteria, exit_criteria,
                evidence_refs_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
        `,
            id,
            challengeId,
            input.parentId?.trim() || null,
            title,
            input.description?.trim() ?? "",
            input.role ?? "custom",
            Math.max(0, Math.min(100, Math.trunc(input.priority ?? 50))),
            input.budgetTurns ?? null,
            input.budgetTokens ?? null,
            JSON.stringify(dependsOn),
            input.successCriteria?.trim() || null,
            input.exitCriteria?.trim() || null,
            now,
            now,
        )
        return this.getTask(id)!
    }

    getTask(taskId: string): CampaignTask | undefined {
        const row = this.get<TaskRow>("SELECT * FROM campaign_tasks WHERE id = ?", taskId)
        return row ? taskFromRow(row) : undefined
    }

    listTasks(challengeId: string): CampaignTask[] {
        const rows = this.all<TaskRow>("SELECT * FROM campaign_tasks WHERE challenge_id = ? ORDER BY priority DESC, created_at ASC", challengeId)
        return rows.map(taskFromRow)
    }

    listReadyTasks(challengeId: string): CampaignTask[] {
        const tasks = this.listTasks(challengeId)
        const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id))
        return tasks
            .filter((task) => (task.status === "pending" || task.status === "ready") && task.dependsOn.every((id) => completed.has(id)))
            .map((task) => task.status === "ready" ? task : this.updateTask(task.id, { status: "ready" }))
    }

    updateTask(taskId: string, patch: UpdateCampaignTaskInput): CampaignTask {
        const current = this.getTask(requireText(taskId, "taskId"))
        if (!current) throw new Error(`campaign task not found: ${taskId}`)
        const dependsOn = patch.dependsOn ? uniqueText(patch.dependsOn) : current.dependsOn
        this.assertTaskReferences(current.challengeId, current.parentId, dependsOn, current.id)
        const evidenceRefs = patch.evidenceRefs ? uniqueText(patch.evidenceRefs) : current.evidenceRefs
        this.run(`
            UPDATE campaign_tasks SET
                status = ?, assigned_solver_id = ?, priority = ?, budget_turns = ?, budget_tokens = ?,
                depends_on_json = ?, success_criteria = ?, exit_criteria = ?, evidence_refs_json = ?, updated_at = ?
            WHERE id = ?
        `,
            patch.status ?? current.status,
            patch.assignedSolverId === null ? null : patch.assignedSolverId?.trim() || current.assignedSolverId || null,
            Math.max(0, Math.min(100, Math.trunc(patch.priority ?? current.priority))),
            patch.budgetTurns === null ? null : patch.budgetTurns ?? current.budgetTurns ?? null,
            patch.budgetTokens === null ? null : patch.budgetTokens ?? current.budgetTokens ?? null,
            JSON.stringify(dependsOn),
            patch.successCriteria === null ? null : patch.successCriteria?.trim() || current.successCriteria || null,
            patch.exitCriteria === null ? null : patch.exitCriteria?.trim() || current.exitCriteria || null,
            JSON.stringify(evidenceRefs),
            nowIso(),
            current.id,
        )
        return this.getTask(current.id)!
    }

    private assertTaskReferences(challengeId: string, parentId: string | undefined, dependsOn: string[], currentId?: string): void {
        if (currentId && dependsOn.includes(currentId)) throw new Error("task cannot depend on itself")
        for (const id of uniqueText([parentId ?? "", ...dependsOn])) {
            const referenced = this.getTask(id)
            if (!referenced || referenced.challengeId !== challengeId) throw new Error(`referenced task is missing or belongs to another target: ${id}`)
        }
        if (!currentId) return
        const tasks = this.listTasks(challengeId)
        const edges = new Map(tasks.map((task) => [task.id, task.id === currentId ? dependsOn : task.dependsOn]))
        const visit = (id: string, path: Set<string>): void => {
            if (path.has(id)) throw new Error("task dependency cycle detected")
            const next = edges.get(id) ?? []
            const branch = new Set(path).add(id)
            for (const dependency of next) visit(dependency, branch)
        }
        visit(currentId, new Set())
    }

    createArtifact(input: CreateCampaignArtifactInput): CampaignArtifact {
        const id = `artifact_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
        const createdAt = nowIso()
        this.run(`
            INSERT INTO campaign_artifacts (
                id, challenge_id, task_id, action_id, solver_id, kind, name, uri, sha256, media_type, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
            id,
            requireText(input.challengeId, "challengeId"),
            input.taskId?.trim() || null,
            input.actionId?.trim() || null,
            input.solverId?.trim() || null,
            input.kind,
            requireText(input.name, "name"),
            requireText(input.uri, "uri"),
            input.sha256?.trim() || null,
            input.mediaType?.trim() || null,
            JSON.stringify(input.metadata ?? {}),
            createdAt,
        )
        return artifactFromRow(this.get<ArtifactRow>("SELECT * FROM campaign_artifacts WHERE id = ?", id)!)
    }

    listArtifacts(challengeId: string, taskId?: string): CampaignArtifact[] {
        const rows = taskId
            ? this.all<ArtifactRow>("SELECT * FROM campaign_artifacts WHERE challenge_id = ? AND task_id = ? ORDER BY created_at DESC", challengeId, taskId)
            : this.all<ArtifactRow>("SELECT * FROM campaign_artifacts WHERE challenge_id = ? ORDER BY created_at DESC", challengeId)
        return rows.map(artifactFromRow)
    }

    startTrace(input: Omit<CampaignTraceEvent, "id" | "status" | "startedAt" | "endedAt" | "durationMs">): CampaignTraceEvent {
        const id = `span_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
        const startedAt = nowIso()
        this.run(`
            INSERT INTO campaign_traces (
                id, trace_id, parent_span_id, challenge_id, solver_id, task_id, category, name, status, started_at, attributes_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
        `,
            id,
            requireText(input.traceId, "traceId"),
            input.parentSpanId?.trim() || null,
            input.challengeId?.trim() || null,
            input.solverId?.trim() || null,
            input.taskId?.trim() || null,
            requireText(input.category, "category"),
            requireText(input.name, "name"),
            startedAt,
            JSON.stringify(input.attributes),
        )
        return { ...input, id, status: "running", startedAt }
    }

    endTrace(spanId: string, status: "ok" | "error", attributes?: Record<string, unknown>): CampaignTraceEvent {
        const row = this.get<TraceRow>("SELECT * FROM campaign_traces WHERE id = ?", spanId)
        if (!row) throw new Error(`trace span not found: ${spanId}`)
        const endedAt = nowIso()
        const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(row.started_at))
        const merged = { ...parseObject(row.attributes_json), ...(attributes ?? {}) }
        this.run("UPDATE campaign_traces SET status = ?, ended_at = ?, duration_ms = ?, attributes_json = ? WHERE id = ?", status, endedAt, durationMs, JSON.stringify(merged), spanId)
        return {
            id: row.id,
            traceId: row.trace_id,
            parentSpanId: row.parent_span_id ?? undefined,
            challengeId: row.challenge_id ?? undefined,
            solverId: row.solver_id ?? undefined,
            taskId: row.task_id ?? undefined,
            category: row.category,
            name: row.name,
            status,
            startedAt: row.started_at,
            endedAt,
            durationMs,
            attributes: merged,
        }
    }

    listTraces(traceId: string): CampaignTraceEvent[] {
        const rows = this.all<TraceRow>("SELECT * FROM campaign_traces WHERE trace_id = ? ORDER BY started_at ASC", traceId)
        return rows.map((row) => ({
            id: row.id,
            traceId: row.trace_id,
            parentSpanId: row.parent_span_id ?? undefined,
            challengeId: row.challenge_id ?? undefined,
            solverId: row.solver_id ?? undefined,
            taskId: row.task_id ?? undefined,
            category: row.category,
            name: row.name,
            status: row.status,
            startedAt: row.started_at,
            endedAt: row.ended_at ?? undefined,
            durationMs: row.duration_ms ?? undefined,
            attributes: parseObject(row.attributes_json),
        }))
    }

    listChallengeTraces(challengeId: string): CampaignTraceEvent[] {
        const traceIds = this.all<{ trace_id: string }>("SELECT DISTINCT trace_id FROM campaign_traces WHERE challenge_id = ? ORDER BY trace_id", challengeId)
        return traceIds.flatMap((row) => this.listTraces(row.trace_id))
    }

    indexMemory(input: Omit<IndexedMemory, "createdAt" | "updatedAt">): IndexedMemory {
        const now = nowIso()
        const record: IndexedMemory = { ...input, confidence: Math.max(0, Math.min(1, input.confidence)), createdAt: now, updatedAt: now }
        const write = this.db.transaction(() => {
            this.run(`
                INSERT INTO campaign_memory (id, challenge_id, kind, content, source_ref, confidence, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, content = excluded.content,
                    source_ref = excluded.source_ref, confidence = excluded.confidence, updated_at = excluded.updated_at
            `, record.id, record.challengeId, record.kind, record.content, record.sourceRef ?? null, record.confidence, now, now)
            this.run("DELETE FROM campaign_memory_fts WHERE id = ?", record.id)
            this.run("INSERT INTO campaign_memory_fts (id, challenge_id, content) VALUES (?, ?, ?)", record.id, record.challengeId, record.content)
        })
        write()
        return record
    }

    searchMemory(challengeId: string, query: string, limit = 10): IndexedMemory[] {
        const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
        if (!terms) return []
        const rows = this.all<MemoryRow>(`
            SELECT m.* FROM campaign_memory_fts f
            JOIN campaign_memory m ON m.id = f.id
            WHERE f.challenge_id = ? AND campaign_memory_fts MATCH ?
            ORDER BY bm25(campaign_memory_fts), m.updated_at DESC LIMIT ?
        `, challengeId, terms, Math.max(1, Math.min(100, Math.trunc(limit))))
        return rows.map((row) => ({
            id: row.id,
            challengeId: row.challenge_id,
            kind: row.kind,
            content: row.content,
            sourceRef: row.source_ref ?? undefined,
            confidence: row.confidence,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }))
    }
}
