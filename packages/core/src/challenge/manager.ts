import { ChallengeApiClient } from "./api-client"
import type { ChallengeApiChallenge, ChallengeApiHintData, ChallengeApiListData, ChallengeApiStartData, ChallengeApiSubmitData } from "./api-client"
import { createAgentSession, defineTool, SessionManager } from "@mariozechner/pi-coding-agent"
import type { ResourceLoader, ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ConfigManager } from "../config/index"
import { join } from "path"
import { CHALLENGE_ENV_CHALLENGE_ID, ENGAGEMENT_ENV_MODE, ENGAGEMENT_ENV_SCOPE } from "./env"
import { isEngagementMode, loadEngagementScope } from "./engagement"
import {
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    listChallengeAttemptLogs,
    listChallengeSubmissionLogs,
    type ChallengeInfoRecord,
    type ChallengeRecord,
    type ChallengeAttemptLogRecord,
    type ChallengeSubmissionLogRecord,
    computeChallengeCompleted,
    ensureChallengeStoreBaseDir,
    challengeRecordDir,
    deleteChallengeDirectory,
    listChallengeRecords,
    readChallengeRecord,
    resolveChallengeDir,
    saveChallengeRecord,
    updateChallengeSubmissionVerification,
} from "./store"
import type { ChallengeStatsOverviewBucket, ChallengeStatsRecord, SolverStatsRecord } from "./stats"
import { buildChallengeStatsOverview, refreshChallengeStats } from "./stats"
import { buildChallengeAttackTimeline } from "./attack-timeline"
import { recordPlannerRoundFailure, recordPlannerRoundSuccess } from "../observability/metrics"
import { buildChallengeProgressDigest, type ChallengeProgressDigest } from "./progress-digest"
import { isRealFinding } from "./submission-utils"
import {
    type AddIdeaResult,
    type AddIdeaInput,
    type AddMemoryInput,
    type IdeaRecord,
    type IdeaStatus,
    type MemoryKind,
    type MemoryEntry,
    type UpdateIdeaInput,
    type MemoryRelation,
    type AddRelationInput,
    type UpdateRelationInput,
    type GraphPathResult,
    addChallengeIdea,
    appendChallengeMemory,
    deleteChallengeIdea,
    deleteChallengeMemory,
    listChallengeIdeas,
    listChallengeMemory,
    searchChallengeIdeas,
    updateChallengeMemory,
    updateChallengeIdea,
    appendChallengeRelation,
    listChallengeRelations,
    updateChallengeRelation,
    deleteChallengeRelation,
    queryChallengeRelations,
    findChallengeRelationShortestPath,
} from "./memory"
import type { RuntimeManager } from "../runtime/runtime"
import type { SolverInstance } from "../runtime/types"
import { solverSessionDir } from "../runtime/types"
import { readSolverBoardSnapshot, seedSolverBoardSnapshot } from "../solver/board-store"
import {
    type StateAsset,
    type AddStateAssetInput,
    type UpdateStateAssetInput,
    type UpsertStateAssetResult,
    listChallengeStateAssets,
    upsertChallengeStateAsset,
    updateChallengeStateAsset,
    deleteChallengeStateAsset,
} from "./state-store"
import {
    formatVulnBroadcast,
    formatVulnStatusNote,
    lookupComponentVulns,
    peekVulnLookupStatus,
    splitServiceVersion,
    type VulnLookupAck,
    type VulnLookupStatus,
} from "./vuln-intel"
import { Type } from "@sinclair/typebox"
import { CHALLENGE_PLANNER_PROMPT_NAME, KALI_PROVISIONER_PROMPT_NAME, OBJECTIVE_VERIFIER_PROMPT_NAME } from "../config/prompts/index"
import {
    buildPromoteIdeaInput,
    buildPromoteMemoryInput,
    extractFindingFactLines,
    memoryFingerprintExists,
    shouldPromoteIdeaStatus,
    shouldPromoteMemoryKind,
    type PromoteIdeaResult,
    type PromoteMemoryResult,
} from "./board-promotion"
import { requiresServerAccessObjective, validateObjectiveEvidence } from "./finding-validation"

export type { IdeaStatus, MemoryKind, MemoryEntry, AddMemoryInput, IdeaRecord, AddIdeaInput, AddIdeaResult, UpdateIdeaInput } from "./memory"

const DEFAULT_PLANNER_PROMPT_NAME = CHALLENGE_PLANNER_PROMPT_NAME
const DEFAULT_TICK_INTERVAL_MS = 30_000
const DEFAULT_STALE_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_MAX_SOLVERS = 1
export const MAX_ACTIVE_CHALLENGES = 3
const DEFAULT_VERIFIER_AUTO_RETRY_MAX = 3
const DEFAULT_VERIFIER_AUTO_RETRY_BASE_MS = 60_000
const PLANNER_FAILURE_ALERT_THRESHOLD = 5
const PLANNER_MAX_BACKOFF_MS = 10 * 60 * 1000
const NOISY_ERROR_THROTTLE_WINDOW_MS = 60_000
const NOISY_ERROR_SIGNATURE_LIMIT = 200
const SOLVER_MEMORY_LIMIT = 10
const SOLVER_IDEA_LIMIT = 8
/** Planner→solver startup brief / steer message cap (task also injects memory, ideas, findings, state). */
const SOLVER_HANDOFF_MAX_CHARS = 2000
const SOLVER_MEMORY_CONTENT_MAX_CHARS = 220
const SOLVER_IDEA_CONTENT_MAX_CHARS = 120
const SOLVER_RESULT_MAX_CHARS = 180
// Planner outcome-summary cap: tighter than solver brief because multi-target stacks; scheduler only needs high-signal bullets.
const PLANNER_MEMORY_FACT_LIMIT = 5
const PLANNER_FAILURE_LIMIT = 4
const PLANNER_IDEA_LIMIT = 5
const PLANNER_FINDING_LIMIT = 4
const PLANNER_SUMMARY_CONTENT_MAX_CHARS = 140
const PLANNER_INTEL_MAX_CHARS = 240
// research: hard route dead-ends >=3 with no foothold/live hypothesis → prune target, shift resources to more promising ones.
const PLANNER_PRUNE_FAILED_ROUTE_THRESHOLD = 3
const CHALLENGE_STATE_PLACEHOLDER = "{{CHALLENGE_STATE}}"
const AVAILABLE_SOLVER_PROMPTS_PLACEHOLDER = "{{AVAILABLE_SOLVER_PROMPTS}}"
const USER_STRATEGY_PLACEHOLDER = "{{USER_STRATEGY}}"
const PREVIOUS_PLANNER_ROUND_PLACEHOLDER = "{{PREVIOUS_PLANNER_ROUND}}"

export interface ChallengeListResult {
    remote: ChallengeApiListData
    local: ChallengeInfoRecord[]
    summary: {
        remote: number
        local: number
        solved: number
        total: number
    }
}

export interface ChallengeActionResult<T> {
    remote: T
    challenge?: ChallengeInfoRecord
    is_completed: boolean
}

export interface ChallengeSubmissionMeta {
    solverId?: string
    promptName?: string
    modelName?: string
    writeup?: string
    verificationStatus?: ChallengeSubmissionLogRecord["verification_status"]
}

interface LaunchSolverOptions {
    plannerHandoff?: string
}

export class MaxActiveChallengesError extends Error {
    readonly code = "max_active_challenges" as const
    readonly limit: number
    readonly running: string[]

    constructor(limit: number, running: string[]) {
        super(`maximum active challenges (${limit}) reached; running: ${running.join(", ")}`)
        this.name = "MaxActiveChallengesError"
        this.limit = limit
        this.running = running
    }
}

export interface ActiveChallengeSlots {
    limit: number
    running: string[]
    available: number
}

export interface PlannerHealth {
    lastOkAt: string | null
    consecutiveFailures: number
    lastError: string | null
    lastErrorAt: string | null
    alerting: boolean
    currentTickIntervalMs: number
    baseTickIntervalMs: number
}

export type PlannerTickOutcome = { ok: true; skipped?: boolean } | { ok: false; error: string }

function extractErrorMessage(error: unknown): string | undefined {
    if (error instanceof Error) {
        const message = error.message.trim()
        return message || error.name
    }
    if (error === undefined) return
    return String(error)
}

function isNoisyChallengeApiError(errorMessage: string | undefined): boolean {
    if (!errorMessage) return false
    const text = errorMessage.toLowerCase()
    return (
        text.includes("challenge api get /challenges") ||
        text.includes("unable to connect") ||
        text.includes("typo in the url or port") ||
        text.includes("timeout after")
    )
}

interface PlannerSnapshotChallenge {
    id: string
    title: string
    difficulty: string
    level: number
    totalScore: number
    gotScore: number
    flagCount: number
    gotFlags: number
    remainingFlags: number
    remainingScore: number
    hintViewed: boolean
    instanceStatus: string
    entrypoint: string[] | null
    attemptCount: number
    submissionCount: number
    correctSubmissionCount: number
    untouched: boolean
    stale: boolean
    activeSolverCount: number
    activeSolverIds: string[]
    activeForMinutes?: number
    minutesSinceLastAttempt?: number
    minutesSinceLastCorrectSubmission?: number
    // Outcome-aware scheduling: planner reads what solvers actually gained, not just counts.
    memoryFacts: string[]
    failureBoundaries: string[]
    liveIdeas: string[]
    ideaStatusCounts: Record<IdeaStatus, number>
    findings: string[]
    progressPhase: PlannerProgressPhase
    // Cross-solver structured battlefield asset summary (hosts/services/credentials/sessions).
    stateAssets: string[]
    // Difficulty-aware numeric signals (research: difficulty-aware planning, Type B failure 58%→27%).
    successRate: number // Laplace-smoothed per-target success rate (correct/submissions), 0..1
    failedRouteCount: number // Dead-end route count (failed ideas + failure memories)
    effortRank?: number // Cross-target relative effort rank (1=most effort); horizon proxy; filled by buildPlannerSnapshot
    pruneRecommended: boolean // >=3 dead routes + no foothold + no live hypothesis → recommend pruning this target
    /** Operator pre-brief excerpt for scheduling (not solver memory). */
    intelNotesExcerpt?: string
}

// Progress phase derived from outcomes; drives difficulty-aware scheduling (broad recon vs deep exploit/lateral).
export type PlannerProgressPhase = "untouched" | "recon" | "foothold" | "breakthrough"

/** Operator/commander view of one target's progress (richer than raw memory/ideas summaries). */
export interface TargetOverview {
    challengeId: string
    title: string
    instanceStatus: string
    progressPhase: PlannerProgressPhase
    successRate: number
    failedRouteCount: number
    findingCount: number
    activeSolverCount: number
    pruneRecommended: boolean
    stateAssets: string[]
    relations: string[]
    memoryFacts: string[]
    failureBoundaries: string[]
    liveIdeas: string[]
    findings: string[]
    activeSolvers: Array<{ id: string; status: string; currentFocus: string }>
}

interface PlannerSnapshot {
    generatedAt: string
    constraints: {
        maxActiveChallenges: number
        maxSolvers: number
        activeChallenges: number
        activeSolvers: number
        staleTimeoutMs: number
    }
    activeSolvers: Array<{
        id: string
        challengeId?: string
        promptName: string
        status: string
        activeForMinutes: number
        timeoutStatus: "normal" | "stale"
        // What this solver is doing now (from its board): lets planner separate advancing vs spinning,
        // so it can decide whom to steer or withdraw.
        currentFocus: string
    }>
    availableSolverPrompts: Array<{
        name: string
        description?: string
        modelPrefId?: string
        modelLabel?: string
        promptPerformance?: ChallengeStatsOverviewBucket
    }>
    challenges: PlannerSnapshotChallenge[]
}

interface PreviousPlannerRoundRecord {
    generated_at: string
    snapshot_digest: string
    actions: string[]
    summary: string
    // Cross-round battle plan: per-target strategy intent + next checkpoint.
    // Upgrades planner from reactive per-tick snapshots to continuous command with a plan.
    battlePlan?: PlannerBattlePlanEntry[]
}

interface PlannerBattlePlanEntry {
    challengeId: string
    strategy: string // Current overall approach/intent for this target
    nextCheckpoint?: string // Concrete milestone to revisit/verify next round
    updated_at: string
}

function requireText(value: string, fieldName: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)))
}

function resolvePlannerTickIntervalMs(value?: number): number {
    return clampInt(value ?? DEFAULT_TICK_INTERVAL_MS, 5_000, 10 * 60 * 1000)
}

function parseTimestamp(value?: string): number | undefined {
    if (!value) return
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
}

function formatMinutesFromTimestamp(value?: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return
    const diffMs = Date.now() - value
    if (!Number.isFinite(diffMs) || diffMs < 0) return 0
    return Math.floor(diffMs / 60000)
}

function isActiveSolver(solver: SolverInstance): boolean {
    return solver.status === "starting" || solver.status === "running"
}

function escapeMarkdownTableCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", "<br>")
}

function formatMarkdownTable(headers: string[], rows: string[][]): string {
    const header = `| ${headers.join(" | ")} |`
    const separator = `| ${headers.map(() => "---").join(" | ")} |`
    const body = rows.map((row) => `| ${row.map((cell) => escapeMarkdownTableCell(cell)).join(" | ")} |`)
    return [header, separator, ...body].join("\n")
}

function clipTaskText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function summarizeBroadcastRefs(refs: string[]): string | undefined {
    const items = refs
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 3)
        .map((item) => clipTaskText(item, 80))
    if (items.length === 0) return
    return items.join(" | ")
}

function formatChallengeMemoryBroadcastMessage(action: "added" | "updated" | "deleted", entry: MemoryEntry): string {
    const actionText = action === "added" ? "added" : action === "updated" ? "updated" : "deleted"
    const refsSummary = summarizeBroadcastRefs(entry.refs)

    return [
        `Collaboration sync: target memory ${actionText}.`,
        `- kind: ${entry.kind}`,
        `- source: ${clipTaskText(entry.source, 120)}`,
        `- content: ${clipTaskText(entry.content, 220)}`,
        refsSummary ? `- refs: ${refsSummary}` : undefined,
        action === "deleted" ? "- This target memory was removed; stop treating it as current background fact." : "- This is a target-level background update; if it affects your current route, absorb and adjust on your own.",
    ]
        .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
        .join("\n")
}

function formatChallengeIdeaBroadcastMessage(action: "added" | "updated" | "deleted", idea: IdeaRecord): string {
    const actionText = action === "added" ? "added" : action === "updated" ? "updated" : "deleted"

    return [
        `Collaboration sync: target idea ${actionText}.`,
        `- status: ${idea.status}`,
        `- content: ${clipTaskText(idea.content, 200)}`,
        idea.result.trim() ? `- result: ${clipTaskText(idea.result, 180)}` : undefined,
        action === "deleted" ? "- This target idea was removed; stop treating it as a current recommended route." : "- This is a target-level background update; treat it as a reference hypothesis, not a conclusion.",
    ]
        .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
        .join("\n")
}

// Compress one battlefield asset into a one-line summary (credentials by ref name, no plaintext secrets).
function formatRelationLine(relation: MemoryRelation): string {
    return `${relation.source} --${relation.relation}--> ${relation.target}`
}

function formatStateAssetLine(asset: StateAsset): string {
    const parts: string[] = [`[${asset.kind}] ${clipTaskText(asset.label, 80)}`]
    if (asset.host) parts.push(`host=${asset.host}`)
    if (typeof asset.port === "number") parts.push(`port=${asset.port}`)
    if (asset.service) parts.push(`svc=${clipTaskText(asset.service, 40)}`)
    if (asset.account) parts.push(`acct=${asset.account}`)
    if (asset.privilege) parts.push(`priv=${asset.privilege}`)
    if (asset.secretRef) parts.push(`secretRef=${asset.secretRef}`)
    if (asset.sessionType) parts.push(`session=${asset.sessionType}`)
    if (asset.note) parts.push(`note=${clipTaskText(asset.note, 80)}`)
    return parts.join(" ")
}

function formatChallengeStateAssetBroadcastMessage(action: "added" | "updated" | "deleted", asset: StateAsset): string {
    return [
        `Collaboration sync: shared state asset ${action}.`,
        `- ${formatStateAssetLine(asset)}`,
        action === "deleted"
            ? "- This asset was removed from shared state; stop relying on it."
            : "- A teammate added/updated a shared battlefield asset (host/service/credential/session). REUSE it — do NOT re-discover or re-brute what's already here. Credentials are referenced by name; pull the secret via your evidence refs.",
    ].join("\n")
}

function sortByUpdatedAtDesc<T extends { updated_at?: string }>(items: T[]): T[] {
    return items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => {
            const timestampDiff = (parseTimestamp(right.item.updated_at) ?? 0) - (parseTimestamp(left.item.updated_at) ?? 0)
            if (timestampDiff !== 0) return timestampDiff
            return right.index - left.index
        })
        .map((entry) => entry.item)
}

function selectRecentItems<T extends { updated_at?: string }>(items: T[], limit: number): T[] {
    return sortByUpdatedAtDesc(items).slice(0, limit)
}

function formatSolverMemorySection(items: MemoryEntry[]): string {
    if (items.length === 0) return "(none)"
    const selected = selectRecentItems(items, SOLVER_MEMORY_LIMIT)
    const table = formatMarkdownTable(
        ["ID", "Kind", "Content", "Refs", "Source", "Updated"],
        selected.map((item) => [
            item.id,
            item.kind,
            clipTaskText(item.content, SOLVER_MEMORY_CONTENT_MAX_CHARS),
            item.refs.length > 0 ? clipTaskText(item.refs.join(", "), SOLVER_IDEA_CONTENT_MAX_CHARS) : "-",
            item.source,
            item.updated_at,
        ]),
    )
    if (selected.length === items.length) return table
    return `${table}\n\nNote: initial context shows only the most recent ${selected.length}/${items.length} memory entries; call memory_list for the full set.`
}

function formatSolverIdeasSection(items: IdeaRecord[]): string {
    if (items.length === 0) return "(none)"
    const selected = selectRecentItems(items, SOLVER_IDEA_LIMIT)
    const table = formatMarkdownTable(
        ["ID", "Status", "Idea", "Result", "Updated"],
        selected.map((item) => [
            item.id,
            item.status,
            clipTaskText(item.content, SOLVER_IDEA_CONTENT_MAX_CHARS),
            item.result ? clipTaskText(item.result, SOLVER_RESULT_MAX_CHARS) : "-",
            item.updated_at,
        ]),
    )
    if (selected.length === items.length) return table
    return `${table}\n\nNote: initial context shows only the most recent ${selected.length}/${items.length} ideas; call idea_list or idea_search for the full board.`
}

function formatSolverSubmissionsSection(items: ChallengeSubmissionLogRecord[]): string {
    const solvedItems = items.filter(isRealFinding)
    if (solvedItems.length === 0) return "(none)"
    const sorted = [...solvedItems].sort((a, b) => (parseTimestamp(b.created_at) ?? 0) - (parseTimestamp(a.created_at) ?? 0))
    return formatMarkdownTable(
        ["Finding", "Writeup"],
        sorted.map((item) => [item.flag, item.writeup || "-"]),
    )
}

function formatSolverStateAssetsSection(items: StateAsset[]): string {
    if (items.length === 0) return "(none)"
    // Credentials/sessions (reusable access) first, hosts/services after.
    const rank = (kind: StateAsset["kind"]) => (kind === "credential" ? 3 : kind === "session" ? 2 : kind === "service" ? 1 : 0)
    const sorted = [...items].sort((a, b) => rank(b.kind) - rank(a.kind) || (parseTimestamp(b.updated_at) ?? 0) - (parseTimestamp(a.updated_at) ?? 0))
    return sorted.map((asset) => `- ${formatStateAssetLine(asset)}`).join("\n")
}

// ── Planner outcome summary (feeds scheduler what solvers gained, not just counts) ──

// Confirmed facts/credentials: scheduler decides privilege-escalation/lateral solvers.
// Credentials first — hub signal for lateral/priv-esc; planner needs them first.
function buildPlannerMemoryFacts(items: MemoryEntry[]): string[] {
    const credentials = selectRecentItems(items.filter((item) => item.kind === "credential"), PLANNER_MEMORY_FACT_LIMIT)
    const others = selectRecentItems(items.filter((item) => item.kind === "fact" || item.kind === "evidence"), PLANNER_MEMORY_FACT_LIMIT)
    return [...credentials, ...others]
        .slice(0, PLANNER_MEMORY_FACT_LIMIT)
        .map((item) => `[${item.kind}] ${clipTaskText(item.content, PLANNER_SUMMARY_CONTENT_MAX_CHARS)}`)
}

// Dead-end boundaries: scheduler avoids re-dispatching doomed routes.
function buildPlannerFailureBoundaries(items: MemoryEntry[]): string[] {
    return selectRecentItems(
        items.filter((item) => item.kind === "failure"),
        PLANNER_FAILURE_LIMIT,
    ).map((item) => clipTaskText(item.content, PLANNER_SUMMARY_CONTENT_MAX_CHARS))
}

// Live hypotheses (verified/testing first): scheduler picks chains worth doubling down.
function buildPlannerLiveIdeas(items: IdeaRecord[]): string[] {
    const rank = (status: IdeaStatus): number => {
        switch (status) {
            case "verified":
                return 4
            case "testing":
                return 3
            case "pending":
                return 2
            case "failed":
                return 1
            default:
                return 0
        }
    }
    return [...items]
        .filter((item) => item.status === "verified" || item.status === "testing" || item.status === "pending")
        .sort((left, right) => rank(right.status) - rank(left.status))
        .slice(0, PLANNER_IDEA_LIMIT)
        .map((item) => `[${item.status}] ${clipTaskText(item.content, PLANNER_SUMMARY_CONTENT_MAX_CHARS)}${item.result.trim() ? ` -> ${clipTaskText(item.result, 100)}` : ""}`)
}

function buildPlannerIdeaStatusCounts(items: IdeaRecord[]): Record<IdeaStatus, number> {
    const counts: Record<IdeaStatus, number> = { pending: 0, testing: 0, verified: 0, failed: 0, skipped: 0 }
    for (const item of items) counts[item.status] += 1
    return counts
}

// Recorded finding summaries (writeup over raw proof; proof may contain base64/credential noise).
function buildPlannerFindings(items: ChallengeSubmissionLogRecord[]): string[] {
    return [...items]
        .filter(isRealFinding)
        .sort((a, b) => (parseTimestamp(b.created_at) ?? 0) - (parseTimestamp(a.created_at) ?? 0))
        .slice(0, PLANNER_FINDING_LIMIT)
        .map((item) => clipTaskText((item.writeup?.trim() || item.flag).replaceAll("\n", " "), PLANNER_SUMMARY_CONTENT_MAX_CHARS))
}

// Derive progress phase from outcomes (no recon→breadth; foothold→deep exploit/lateral).
function derivePlannerProgressPhase(input: {
    untouched: boolean
    correctSubmissionCount: number
    verifiedIdeaCount: number
    hasFootholdSignal: boolean
}): PlannerProgressPhase {
    if (input.correctSubmissionCount > 0) return "breakthrough"
    if (input.hasFootholdSignal || input.verifiedIdeaCount > 0) return "foothold"
    if (input.untouched) return "untouched"
    return "recon"
}

// Whether foothold-level intel exists (creds/session/access); drives lateral/priv-esc scheduling.
const FOOTHOLD_SIGNAL_PATTERN = /\b(cred|credential|password|passwd|token|api[_-]?key|secret|shell|rce|session|cookie|ssh|login|access|foothold|webshell)\b/i
function hasFootholdSignal(memoryFacts: string[], liveIdeas: string[]): boolean {
    return [...memoryFacts, ...liveIdeas].some((line) => FOOTHOLD_SIGNAL_PATTERN.test(line))
}

// Laplace (add-one) smoothed success rate: low samples stay neutral (0 submissions → 0.5, not 0/0).
// research uses per-branch historical success; avoids mislabeling a line as doomed/sure-win on low samples.
function laplaceSuccessRate(successes: number, total: number): number {
    return (successes + 1) / (total + 2)
}

function extractTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
    if (!content) return ""
    return content
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim()
}

function writePlannerTextChunk(chunk: string): void {
    const text = chunk.replace(/\r/g, "")
    if (!text) return
    process.stdout.write(text)
}

const CHALLENGE_LOG_SCOPE_ICONS: Record<string, string> = {
    planner: "🧠",
    "planner-tool": "🧠🛠",
    solver: "🤖",
    "sync-loop": "🔄",
    start: "🚀",
    stop: "🛑",
    submit: "🏁",
    hint: "💡",
    finish: "✅",
}

function formatChallengeLogScope(scope: string): string {
    const parts = scope.split(":").filter(Boolean)
    if (parts.length === 0) return "🎯"
    if (parts[0] === "challenge") parts.shift()
    if (parts.length === 0) return "🎯"
    return CHALLENGE_LOG_SCOPE_ICONS[parts.join(":")] ?? CHALLENGE_LOG_SCOPE_ICONS[parts[0]] ?? "🎯"
}

function formatPromptPerformance(bucket?: ChallengeStatsOverviewBucket): string {
    if (!bucket) return "-"
    return `${bucket.solved_count}/${bucket.total_flag_count}`
}

function formatAvailableSolverPromptsMarkdown(snapshot: PlannerSnapshot): string {
    const availablePromptRows = snapshot.availableSolverPrompts.map((prompt) => [
        prompt.name,
        prompt.modelLabel ?? "-",
        formatPromptPerformance(prompt.promptPerformance),
        prompt.description?.replaceAll("\n", " ") || "-",
    ])

    const table = availablePromptRows.length > 0 ? formatMarkdownTable(["Prompt", "Configured Model", "Prompt Flags", "Description"], availablePromptRows) : "No solver prompts available."

    const details = snapshot.availableSolverPrompts.flatMap((prompt) => [
        `### ${prompt.name}`,
        `- Description: ${prompt.description?.trim() || "-"}`,
        `- Configured model: ${prompt.modelLabel ?? "-"}`,
        `- Model pref id: ${prompt.modelPrefId ?? "-"}`,
        `- Prompt performance: ${formatPromptPerformance(prompt.promptPerformance)}`,
        "",
    ])

    return [table, "", "## Solver Prompt Details", ...details].join("\n")
}

function formatPlannerSnapshotMarkdown(snapshot: PlannerSnapshot): string {
    const challengeRows = snapshot.challenges.map((challenge) => [
        challenge.id,
        challenge.title.replaceAll("\n", " "),
        challenge.difficulty,
        challenge.progressPhase,
        `${challenge.gotScore}/${challenge.totalScore}`,
        `${challenge.gotFlags}/${challenge.flagCount}`,
        challenge.instanceStatus,
        String(challenge.activeSolverCount),
        challenge.untouched ? "yes" : "no",
        challenge.stale ? "yes" : "no",
        challenge.hintViewed ? "yes" : "no",
    ])
    const solverRows = snapshot.activeSolvers.map((solver) => [
        solver.id,
        solver.challengeId ?? "-",
        solver.promptName,
        solver.status,
        `${solver.activeForMinutes}m (${solver.timeoutStatus})`,
        solver.currentFocus.replaceAll("\n", " "),
    ])

    return [
        "## Constraints",
        `- Max active challenge instances: ${snapshot.constraints.maxActiveChallenges}`,
        `- Max solvers: ${snapshot.constraints.maxSolvers}`,
        `- Active challenge instances: ${snapshot.constraints.activeChallenges}`,
        `- Active solvers: ${snapshot.constraints.activeSolvers}`,
        `- Idle challenge slots: ${Math.max(snapshot.constraints.maxActiveChallenges - snapshot.constraints.activeChallenges, 0)}`,
        `- Idle solver slots: ${Math.max(snapshot.constraints.maxSolvers - snapshot.constraints.activeSolvers, 0)}`,
        `- Visible unsolved challenges: ${snapshot.challenges.length}`,
        `- Stale timeout minutes: ${Math.floor(snapshot.constraints.staleTimeoutMs / 60000)}`,
        "",
        "## Challenges",
        challengeRows.length > 0
            ? formatMarkdownTable(["ID", "Title", "Difficulty", "Phase", "Score", "Flags", "Instance", "Solvers", "Untouched", "Stale", "Hint"], challengeRows)
            : "No unsolved challenges.",
        "",
        "## Active Solvers",
        solverRows.length > 0 ? formatMarkdownTable(["Solver", "Challenge", "Prompt", "Status", "Active For", "Current Focus"], solverRows) : "No active solvers.",
        "",
        "## Challenge Details",
        ...snapshot.challenges.flatMap((challenge) => [
            `### ${challenge.id} - ${challenge.title}`,
            `- Difficulty: ${challenge.difficulty}`,
            `- Level: ${challenge.level}`,
            `- Progress phase: ${challenge.progressPhase}`,
            `- Score: ${challenge.gotScore}/${challenge.totalScore}`,
            `- Flags: ${challenge.gotFlags}/${challenge.flagCount}`,
            `- Remaining score: ${challenge.remainingScore}`,
            `- Remaining flags: ${challenge.remainingFlags}`,
            `- Instance status: ${challenge.instanceStatus}`,
            `- Hint viewed: ${challenge.hintViewed ? "yes" : "no"}`,
            `- Attempt count: ${challenge.attemptCount}`,
            `- Submission count: ${challenge.submissionCount}`,
            `- Correct submissions: ${challenge.correctSubmissionCount}`,
            `- Idea board: ${formatIdeaStatusCounts(challenge.ideaStatusCounts)}`,
            // Difficulty-aware numeric signals (research: difficulty-aware planning).
            `- Success rate (Laplace-smoothed): ${challenge.successRate.toFixed(2)}`,
            `- Failed/dead-end route count: ${challenge.failedRouteCount}`,
            typeof challenge.effortRank === "number" ? `- Effort rank (1=most effort vs other targets): ${challenge.effortRank}` : "- Effort rank: -",
            challenge.pruneRecommended
                ? `- PRUNE RECOMMENDED: >=${PLANNER_PRUNE_FAILED_ROUTE_THRESHOLD} dead routes, no foothold, no live hypothesis — this target is too hard for the current approach; free its solvers for a more promising target unless you change tactics.`
                : `- Prune recommended: no`,
            `- Active solver ids: ${challenge.activeSolverIds.length > 0 ? challenge.activeSolverIds.join(", ") : "none"}`,
            `- Untouched: ${challenge.untouched ? "yes" : "no"}`,
            `- Stale: ${challenge.stale ? "yes" : "no"}`,
            typeof challenge.activeForMinutes === "number" ? `- Active for minutes: ${challenge.activeForMinutes}` : "- Active for minutes: -",
            typeof challenge.minutesSinceLastAttempt === "number" ? `- Minutes since last attempt: ${challenge.minutesSinceLastAttempt}` : "- Minutes since last attempt: -",
            typeof challenge.minutesSinceLastCorrectSubmission === "number"
                ? `- Minutes since last correct submission: ${challenge.minutesSinceLastCorrectSubmission}`
                : "- Minutes since last correct submission: -",
            challenge.entrypoint && challenge.entrypoint.length > 0 ? `- Entrypoints: ${challenge.entrypoint.join(", ")}` : "- Entrypoints: -",
            challenge.intelNotesExcerpt ? `- Operator intel (pre-brief): ${challenge.intelNotesExcerpt.replaceAll("\n", " ")}` : "- Operator intel (pre-brief): (none)",
            // Outcome summary: scheduler sees what solvers gained for informed dispatch/hold/handoff.
            `- Shared state assets (hosts/services/credentials/sessions — reusable across solvers):`,
            ...(challenge.stateAssets.length > 0 ? challenge.stateAssets.map((line) => `    - ${line}`) : ["    - (none)"]),
            `- Confirmed facts / creds:`,
            ...(challenge.memoryFacts.length > 0 ? challenge.memoryFacts.map((line) => `    - ${line}`) : ["    - (none)"]),
            `- Failed / dead-end boundaries (do NOT re-dispatch these routes):`,
            ...(challenge.failureBoundaries.length > 0 ? challenge.failureBoundaries.map((line) => `    - ${line}`) : ["    - (none)"]),
            `- Live attack hypotheses (verified/testing/pending):`,
            ...(challenge.liveIdeas.length > 0 ? challenge.liveIdeas.map((line) => `    - ${line}`) : ["    - (none)"]),
            `- Recorded findings:`,
            ...(challenge.findings.length > 0 ? challenge.findings.map((line) => `    - ${line}`) : ["    - (none)"]),
            "",
        ]),
    ].join("\n")
}

function formatIdeaStatusCounts(counts: Record<IdeaStatus, number>): string {
    return `verified=${counts.verified} testing=${counts.testing} pending=${counts.pending} failed=${counts.failed} skipped=${counts.skipped}`
}

function formatPreviousPlannerRoundMarkdown(previousRound?: PreviousPlannerRoundRecord): string {
    if (!previousRound) return "No previous scheduling round on record."
    const planLines =
        previousRound.battlePlan && previousRound.battlePlan.length > 0
            ? [
                  "",
                  "Carried-over battle plan (your standing intent per target from last round — continue it, check its next checkpoint, and update it this round):",
                  ...previousRound.battlePlan.map(
                      (entry) =>
                          `- ${entry.challengeId}: ${entry.strategy.replaceAll("\n", " ")}${entry.nextCheckpoint?.trim() ? ` | next checkpoint: ${entry.nextCheckpoint.replaceAll("\n", " ")}` : ""}`,
                  ),
              ]
            : []
    return [
        `- Snapshot digest: ${previousRound.snapshot_digest}`,
        `- Actions: ${previousRound.actions.length > 0 ? previousRound.actions.join(" | ") : "none"}`,
        "",
        previousRound.summary.trim() || "No summary.",
        ...planLines,
    ].join("\n")
}

function computePlannerSnapshotDigest(snapshot: PlannerSnapshot): string {
    const payload = JSON.stringify({
        constraints: snapshot.constraints,
        activeSolvers: snapshot.activeSolvers.map((solver) => ({
            id: solver.id,
            challengeId: solver.challengeId,
            promptName: solver.promptName,
            status: solver.status,
        })),
        challenges: snapshot.challenges.map((challenge) => ({
            id: challenge.id,
            instanceStatus: challenge.instanceStatus,
            activeSolverIds: challenge.activeSolverIds,
            attemptCount: challenge.attemptCount,
            submissionCount: challenge.submissionCount,
            correctSubmissionCount: challenge.correctSubmissionCount,
            stale: challenge.stale,
        })),
        prompts: snapshot.availableSolverPrompts.map((prompt) => prompt.name),
    })
    return Bun.hash(payload).toString(16)
}

function wrapPlannerResourceLoader(base: ResourceLoader, snapshot: PlannerSnapshot, strategy?: string, previousRound?: PreviousPlannerRoundRecord): ResourceLoader {
    const stateText = formatPlannerSnapshotMarkdown(snapshot)
    const availableSolverPromptsText = formatAvailableSolverPromptsMarkdown(snapshot)
    const strategyText = strategy?.trim() ? strategy.trim() : "No extra user preferences. Follow the default strategy."
    const previousPlannerRoundText = formatPreviousPlannerRoundMarkdown(previousRound)
    const basePrompt = base.getSystemPrompt() ?? ""
    const replacedPrompt = basePrompt
        .replaceAll(CHALLENGE_STATE_PLACEHOLDER, stateText)
        .replaceAll(AVAILABLE_SOLVER_PROMPTS_PLACEHOLDER, availableSolverPromptsText)
        .replaceAll(USER_STRATEGY_PLACEHOLDER, strategyText)
        .replaceAll(PREVIOUS_PLANNER_ROUND_PLACEHOLDER, previousPlannerRoundText)

    return {
        getExtensions: () => base.getExtensions(),
        getSkills: () => base.getSkills(),
        getPrompts: () => base.getPrompts(),
        getThemes: () => base.getThemes(),
        getAgentsFiles: () => base.getAgentsFiles(),
        getSystemPrompt: () => replacedPrompt,
        getAppendSystemPrompt: () => base.getAppendSystemPrompt(),
        extendResources: (paths) => base.extendResources(paths),
        reload: () => base.reload(),
    }
}

function isChallengeSolved(record: { flag_count: number; flag_got_count: number } | undefined): boolean {
    if (!record) return false
    return record.flag_count > 0 && record.flag_got_count >= record.flag_count
}

function mapApiChallengeToRecord(challenge: ChallengeApiChallenge): ChallengeRecord {
    return {
        id: challenge.code,
        title: challenge.title,
        difficulty: challenge.difficulty,
        description: challenge.description,
        level: challenge.level,
        total_score: challenge.total_score,
        total_got_score: challenge.total_got_score,
        flag_count: challenge.flag_count,
        flag_got_count: challenge.flag_got_count,
        hint_viewed: challenge.hint_viewed,
        hint_content: null,
        instance_status: challenge.instance_status,
        entrypoint: challenge.entrypoint,
        flags: [],
    }
}

function mapRecordToApiChallenge(challenge: ChallengeInfoRecord): ChallengeApiChallenge {
    return {
        title: challenge.title,
        code: challenge.id,
        difficulty: challenge.difficulty,
        description: challenge.description,
        level: challenge.level,
        total_score: challenge.total_score,
        total_got_score: challenge.total_got_score,
        flag_count: challenge.flag_count,
        flag_got_count: challenge.flag_got_count,
        hint_viewed: challenge.hint_viewed,
        instance_status: challenge.instance_status,
        entrypoint: challenge.entrypoint,
    }
}

export class ChallengeManager {
    private readonly config: ConfigManager
    private api: ChallengeApiClient | undefined
    private rootDir: string | undefined
    private runtime: RuntimeManager | undefined
    private syncTimer: ReturnType<typeof setTimeout> | undefined
    private syncLoopStarted = false
    private syncRunning = false
    private finishingChallenges = new Set<string>()
    // On completion, record stopped solver ids per target for precise resume on revoke (not new launches).
    private stoppedOnCompletion = new Map<string, string[]>()
    /** Solvers stopped by operator pause; resumeTargetTesting restores these sessions. */
    private stoppedOnPause = new Map<string, string[]>()
    private plannerRunning = false
    private loopTickCount = 0
    private plannerBackoffMultiplier = 1
    private plannerHealthState = {
        lastOkAt: null as string | null,
        consecutiveFailures: 0,
        lastError: null as string | null,
        lastErrorAt: null as string | null,
        currentTickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
    }
    private noisyErrorLogState = new Map<string, { lastLoggedAt: number; suppressedCount: number }>()
    private verifierRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

    constructor(config: ConfigManager) {
        this.config = config
    }

    private log(scope: string, message: string, fields?: Record<string, unknown>): void {
        const prefix = formatChallengeLogScope(scope)
        if (!fields || Object.keys(fields).length === 0) {
            console.log(`${prefix} ${message}`)
            return
        }
        console.log(`${prefix} ${message} ${JSON.stringify(fields)}`)
    }

    private error(scope: string, message: string, error?: unknown, fields?: Record<string, unknown>): void {
        const prefix = formatChallengeLogScope(scope)
        const nextFields: Record<string, unknown> = { ...(fields ?? {}) }
        const errorMessage = extractErrorMessage(error)
        if (errorMessage) {
            nextFields.error = errorMessage
        }

        if (isNoisyChallengeApiError(errorMessage)) {
            const signature = `${scope}|${message}|${errorMessage}`
            const now = Date.now()
            const state = this.noisyErrorLogState.get(signature)
            if (state && now - state.lastLoggedAt < NOISY_ERROR_THROTTLE_WINDOW_MS) {
                state.suppressedCount += 1
                return
            }
            const suppressedCount = state?.suppressedCount ?? 0
            this.noisyErrorLogState.set(signature, { lastLoggedAt: now, suppressedCount: 0 })
            if (this.noisyErrorLogState.size > NOISY_ERROR_SIGNATURE_LIMIT) {
                const oldest = this.noisyErrorLogState.keys().next()
                if (!oldest.done) this.noisyErrorLogState.delete(oldest.value)
            }
            if (suppressedCount > 0) {
                nextFields.suppressed = suppressedCount
            }
        }

        console.error(`${prefix} ${message}${Object.keys(nextFields).length > 0 ? ` ${JSON.stringify(nextFields)}` : ""}`)
    }

    attachRuntime(runtime: RuntimeManager): void {
        this.runtime = runtime
        void this.resumePendingVerifierRetries()
    }

    async getActiveChallengeSlots(): Promise<ActiveChallengeSlots> {
        const rootDir = await this.getRootDir()
        const challenges = await this.filterChallengesByMode(await listChallengeRecords(rootDir))
        const running = challenges.filter((challenge) => challenge.instance_status === "running").map((challenge) => challenge.id)
        return {
            limit: MAX_ACTIVE_CHALLENGES,
            running,
            available: Math.max(0, MAX_ACTIVE_CHALLENGES - running.length),
        }
    }

    reloadFromConfig(): void {
        this.api = undefined
    }

    getRuntime(): RuntimeManager | undefined {
        return this.runtime
    }

    async getPlannerHealth(): Promise<PlannerHealth> {
        const settings = await this.config.getHostSettings()
        const baseTickIntervalMs = resolvePlannerTickIntervalMs(settings.planner.tickIntervalMs)
        return {
            ...this.plannerHealthState,
            alerting: this.plannerHealthState.consecutiveFailures >= PLANNER_FAILURE_ALERT_THRESHOLD,
            baseTickIntervalMs,
        }
    }

    private notePlannerTickSuccess(baseIntervalMs: number): void {
        recordPlannerRoundSuccess()
        this.plannerHealthState.lastOkAt = new Date().toISOString()
        this.plannerHealthState.consecutiveFailures = 0
        this.plannerHealthState.lastError = null
        this.plannerBackoffMultiplier = 1
        this.plannerHealthState.currentTickIntervalMs = baseIntervalMs
    }

    private notePlannerTickFailure(error: string | undefined, baseIntervalMs: number): void {
        recordPlannerRoundFailure()
        this.plannerHealthState.consecutiveFailures += 1
        this.plannerHealthState.lastError = error ?? "planner tick failed"
        this.plannerHealthState.lastErrorAt = new Date().toISOString()
        this.plannerBackoffMultiplier = Math.min(this.plannerBackoffMultiplier * 2, 64)
        const nextIntervalMs = Math.min(baseIntervalMs * this.plannerBackoffMultiplier, PLANNER_MAX_BACKOFF_MS)
        this.plannerHealthState.currentTickIntervalMs = nextIntervalMs
        if (this.plannerHealthState.consecutiveFailures >= PLANNER_FAILURE_ALERT_THRESHOLD) {
            this.error("challenge:planner-health", "consecutive planner failures threshold reached", undefined, {
                consecutiveFailures: this.plannerHealthState.consecutiveFailures,
                lastError: this.plannerHealthState.lastError,
                nextIntervalMs,
            })
        }
    }

    private async assertCanStartChallenge(challengeId: string): Promise<void> {
        const rootDir = await this.getRootDir()
        const challenges = await this.filterChallengesByMode(await listChallengeRecords(rootDir))
        const running = challenges.filter((challenge) => challenge.instance_status === "running").map((challenge) => challenge.id)
        const current = challenges.find((challenge) => challenge.id === challengeId)
        if (current?.instance_status === "running") return
        if (running.length >= MAX_ACTIVE_CHALLENGES) {
            throw new MaxActiveChallengesError(MAX_ACTIVE_CHALLENGES, running)
        }
    }

    private broadcastHintToRunningSolvers(challengeId: string, hintContent: string): void {
        const runtime = this.runtime
        const targetChallengeId = challengeId.trim()
        const message = hintContent.trim()
        if (!runtime || !targetChallengeId || !message) return
        for (const solver of runtime.list()) {
            if (solver.challengeId !== targetChallengeId) continue
            if (solver.status !== "running") continue
            try {
                runtime.sendCommand(solver.id, {
                    type: "follow_up",
                    message: `Target intel update:\n${message}`,
                })
            } catch {
                // ignore inactive solver pipes
            }
        }
    }

    private broadcastChallengeBoardUpdateToRunningSolvers(challengeId: string, message: string): void {
        const runtime = this.runtime
        const targetChallengeId = challengeId.trim()
        const text = message.trim()
        if (!runtime || !targetChallengeId || !text) return
        for (const solver of runtime.list()) {
            if (solver.challengeId !== targetChallengeId) continue
            if (solver.status !== "running") continue
            try {
                runtime.sendCommand(solver.id, {
                    type: "follow_up",
                    message: text,
                })
            } catch {
                // ignore inactive solver pipes
            }
        }
    }

    startSyncLoop(): void {
        if (this.syncLoopStarted) return
        this.syncLoopStarted = true
        this.log("challenge:sync-loop", "starting loop", { intervalMs: DEFAULT_TICK_INTERVAL_MS })
        const tick = async () => {
            this.syncRunning = true
            const tickId = ++this.loopTickCount
            let nextIntervalMs = this.plannerHealthState.currentTickIntervalMs
            try {
                console.log(`\n========== planner round #${tickId} ==========`)
                const settings = await this.config.getHostSettings()
                const baseIntervalMs = resolvePlannerTickIntervalMs(settings.planner.tickIntervalMs)
                nextIntervalMs = baseIntervalMs
                await this.tickPlanner("challenge-planner:loop")
                nextIntervalMs = this.plannerHealthState.currentTickIntervalMs
                console.log(`========== end planner round #${tickId} ==========\n`)
            } catch (error) {
                const settings = await this.config.getHostSettings()
                const baseIntervalMs = resolvePlannerTickIntervalMs(settings.planner.tickIntervalMs)
                this.notePlannerTickFailure(extractErrorMessage(error), baseIntervalMs)
                nextIntervalMs = this.plannerHealthState.currentTickIntervalMs
                this.error("challenge:sync-loop", "tick failed", error, { tickId, nextIntervalMs })
                console.log(`========== end planner round #${tickId} ==========\n`)
            } finally {
                this.syncRunning = false
                this.syncTimer = setTimeout(() => {
                    void tick()
                }, nextIntervalMs)
            }
        }
        void tick()
    }

    async tickPlanner(source = "challenge-planner:manual"): Promise<PlannerTickOutcome> {
        const settings = await this.config.getHostSettings()
        const baseIntervalMs = resolvePlannerTickIntervalMs(settings.planner.tickIntervalMs)
        if (this.plannerRunning) return { ok: true, skipped: true }
        if (settings.planner.enabled !== true) return { ok: true, skipped: true }

        this.plannerRunning = true
        try {
            const outcome = await this.runPlannerOnce(source)
            if (outcome.ok) {
                if (!outcome.skipped) {
                    this.notePlannerTickSuccess(baseIntervalMs)
                }
            } else {
                this.notePlannerTickFailure(outcome.error, baseIntervalMs)
            }
            return outcome
        } catch (error) {
            const message = extractErrorMessage(error) ?? "planner tick failed"
            this.notePlannerTickFailure(message, baseIntervalMs)
            this.error("challenge:planner", "tick failed", error, { source })
            return { ok: false, error: message }
        } finally {
            this.plannerRunning = false
        }
    }

    private async getRootDir(): Promise<string> {
        if (this.rootDir) return this.rootDir
        const rootDir = resolveChallengeDir()
        await ensureChallengeStoreBaseDir(rootDir)
        this.rootDir = rootDir
        return rootDir
    }

    private async readPreviousPlannerRound(): Promise<PreviousPlannerRoundRecord | undefined> {
        const rootDir = await this.getRootDir()
        const file = Bun.file(join(rootDir, "planner-last-round.json"))
        if (!(await file.exists())) return
        try {
            return (await file.json()) as PreviousPlannerRoundRecord
        } catch {
            return
        }
    }

    private async writePreviousPlannerRound(record: PreviousPlannerRoundRecord): Promise<void> {
        const rootDir = await this.getRootDir()
        await Bun.write(join(rootDir, "planner-last-round.json"), JSON.stringify(record, null, 2))
    }

    private async filterChallengesByMode(challenges: ChallengeInfoRecord[]): Promise<ChallengeInfoRecord[]> {
        return challenges
    }

    private async readVisibleChallenge(challengeId: string): Promise<ChallengeInfoRecord | undefined> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        return readChallengeRecord(rootDir, id)
    }

    private async getApi(): Promise<ChallengeApiClient> {
        if (this.api) return this.api
        const rootDir = await this.getRootDir()
        const listStored = async () => this.filterChallengesByMode(await listChallengeRecords(rootDir))
        const api = ChallengeApiClient.createMock({
                listChallenges: async () => {
                    const challenges = await listStored()
                    return {
                        current_level: challenges.reduce((max, challenge) => Math.max(max, challenge.level), 0),
                        total_challenges: challenges.length,
                        solved_challenges: challenges.filter((challenge) => computeChallengeCompleted(challenge)).length,
                        challenges: challenges.map(mapRecordToApiChallenge),
                    }
                },
                startChallenge: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (computeChallengeCompleted(challenge)) {
                        return { already_completed: true }
                    }
                    const engagement = isEngagementMode()
                    // Engagement: entrypoint is a real external address; never overwrite with 127.0.0.1:8080 placeholder
                    // (otherwise solver drops the real target and attacks the nearest host — known incident root cause).
                    const resolveEntrypoint = (): string[] => {
                        if (challenge.entrypoint && challenge.entrypoint.length > 0) return challenge.entrypoint
                        throw new Error(`target "${code}" has no entrypoint; refuse to start with placeholder`)
                    }
                    if (challenge.instance_status === "running") {
                        return resolveEntrypoint()
                    }
                    const stored = await listStored()
                    const running = stored.filter((item) => item.instance_status === "running").map((item) => item.id)
                    if (running.length >= MAX_ACTIVE_CHALLENGES) {
                        throw new MaxActiveChallengesError(MAX_ACTIVE_CHALLENGES, running)
                    }
                    const entrypoint = resolveEntrypoint()
                    await saveChallengeRecord(
                        rootDir,
                        {
                            ...challenge,
                            instance_status: "running",
                            entrypoint,
                        },
                        "challenge-api:local-start",
                    )
                    return entrypoint
                },
                stopChallenge: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (challenge.instance_status !== "running" && challenge.instance_status !== "pending") {
                        throw new Error("target instance is not running")
                    }
                    await saveChallengeRecord(
                        rootDir,
                        {
                            ...challenge,
                            instance_status: "stopped",
                        },
                        "challenge-api:local-stop",
                    )
                    return null
                },
                submitFlag: async (code, flag) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (challenge.instance_status !== "running") {
                        throw new Error("target instance is not running")
                    }
                    const flags = challenge.flags ?? []
                    const isCorrect = flags.includes(flag)
                    const alreadySolved = isCorrect && challenge.flag_got_count >= challenge.flag_count
                    const nextGotCount = isCorrect && !alreadySolved ? Math.min(challenge.flag_got_count + 1, challenge.flag_count) : challenge.flag_got_count
                    if (nextGotCount !== challenge.flag_got_count) {
                        await saveChallengeRecord(
                            rootDir,
                            {
                                ...challenge,
                                flag_got_count: nextGotCount,
                                total_got_score:
                                    challenge.flag_count > 0 ? Math.min(challenge.total_score, Math.round((challenge.total_score * nextGotCount) / challenge.flag_count)) : challenge.total_got_score,
                            },
                            "challenge-api:local-submit",
                        )
                    }
                    return {
                        correct: isCorrect,
                        message: isCorrect ? "flag correct" : "flag incorrect",
                        flag_count: challenge.flag_count,
                        flag_got_count: nextGotCount,
                    }
                },
                getHint: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (challenge.instance_status !== "running") {
                        throw new Error("target instance is not running")
                    }
                    if (!challenge.hint_viewed) {
                        await saveChallengeRecord(
                            rootDir,
                            {
                                ...challenge,
                                hint_viewed: true,
                            },
                            "challenge-api:local-hint",
                        )
                    }
                    return {
                        code,
                        hint_content: challenge.hint_content ?? null,
                    }
                },
        })
        this.api = api
        return api
    }

    private async getContext(): Promise<{ api: ChallengeApiClient; rootDir: string }> {
        const api = await this.getApi()
        const rootDir = await this.getRootDir()
        return { api, rootDir }
    }

    async listChallenges(source = "challenge-api:list"): Promise<ChallengeListResult> {
        const { api, rootDir } = await this.getContext()
        const remote = await api.listChallenges()
        for (const challenge of remote.challenges) {
            const next = mapApiChallengeToRecord(challenge)
            const existing = await readChallengeRecord(rootDir, next.id)
            await saveChallengeRecord(
                rootDir,
                {
                    ...next,
                    hint_viewed: existing?.hint_viewed === true || next.hint_viewed,
                    flags: existing?.flags ?? next.flags,
                    hint_content: existing?.hint_content ?? next.hint_content,
                    intel_notes: existing?.intel_notes ?? next.intel_notes,
                },
                source,
            )
            if (!isChallengeSolved(existing) && isChallengeSolved(next)) {
                void this.finishChallenge(next.id)
            }
        }
        const local = await this.filterChallengesByMode(await listChallengeRecords(rootDir))
        return {
            remote,
            local,
            summary: {
                remote: remote.challenges.length,
                local: local.length,
                solved: remote.solved_challenges,
                total: remote.total_challenges,
            },
        }
    }

    async listChallengesSafe(_source = "challenge-api:list"): Promise<ChallengeInfoRecord[]> {
        return this.listStoredChallenges()
    }

    async listStoredChallenges(): Promise<ChallengeInfoRecord[]> {
        const rootDir = await this.getRootDir()
        return this.filterChallengesByMode(await listChallengeRecords(rootDir))
    }

    async createChallenge(challenge: ChallengeRecord, source = "manual"): Promise<ChallengeInfoRecord | undefined> {
        const rootDir = await this.getRootDir()
        await saveChallengeRecord(rootDir, challenge, source)
        return this.readVisibleChallenge(challenge.id)
    }

    async getChallenge(challengeId: string): Promise<ChallengeInfoRecord | undefined> {
        return this.readVisibleChallenge(challengeId)
    }

    async updateIntelNotes(challengeId: string, intelNotes: string | null | undefined): Promise<ChallengeInfoRecord> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await readChallengeRecord(rootDir, id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        const normalized = intelNotes?.trim() ? intelNotes.trim() : null
        await saveChallengeRecord(rootDir, { ...challenge, intel_notes: normalized }, "challenge:update-intel")
        this.log("challenge:intel", "operator intel updated", { challengeId: id, chars: normalized?.length ?? 0 })
        const updated = await readChallengeRecord(rootDir, id)
        if (!updated) throw new Error(`challenge "${id}" not found after intel update`)
        return updated
    }

    async deleteChallenge(challengeId: string): Promise<{ deletedSolvers: string[] }> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")

        const challenge = await readChallengeRecord(rootDir, id)
        if (!challenge && !(await Bun.file(challengeRecordDir(rootDir, id)).exists())) {
            throw new Error(`challenge "${id}" not found`)
        }

        this.log("challenge:delete", "deleting challenge and local data", { challengeId: id })

        const runtime = this.runtime
        if (runtime) {
            const solvers = await runtime.listAll()
            const activeOnTarget = solvers.filter(
                (solver) =>
                    solver.challengeId === id &&
                    (solver.status === "starting" || solver.status === "running" || solver.status === "stopping"),
            )
            if (activeOnTarget.length > 0) {
                throw new Error(
                    `cannot delete target "${id}" while ${activeOnTarget.length} solver(s) are still active; stop solvers first`,
                )
            }
        }

        if (challenge && (challenge.instance_status === "running" || challenge.instance_status === "pending")) {
            try {
                await this.stopChallenge(id)
            } catch (error) {
                this.error("challenge:delete", "failed to stop challenge instance before delete", error, { challengeId: id })
            }
        }

        const deletedSolvers: string[] = []
        if (runtime) {
            const solvers = await runtime.listAll()
            const matching = solvers.filter((solver) => solver.challengeId === id)
            for (const solver of matching) {
                if (solver.status === "running" || solver.status === "starting" || solver.status === "stopping") {
                    try {
                        await runtime.stopSolver(solver.id)
                    } catch (error) {
                        this.error("challenge:delete", "failed to stop solver before delete", error, {
                            challengeId: id,
                            solverId: solver.id,
                        })
                    }
                }
                try {
                    await runtime.deleteSolver(solver.id)
                    deletedSolvers.push(solver.id)
                } catch (error) {
                    this.error("challenge:delete", "failed to delete solver workspace", error, {
                        challengeId: id,
                        solverId: solver.id,
                    })
                }
            }
        }

        this.stoppedOnCompletion.delete(id)
        this.stoppedOnPause.delete(id)
        await this.prunePlannerRoundForChallenge(id)

        await deleteChallengeDirectory(rootDir, id)

        this.log("challenge:delete", "challenge deleted", { challengeId: id, deletedSolvers })
        return { deletedSolvers }
    }

    private async prunePlannerRoundForChallenge(challengeId: string): Promise<void> {
        const previous = await this.readPreviousPlannerRound()
        if (!previous?.battlePlan?.length) return
        const nextPlan = previous.battlePlan.filter((entry) => entry.challengeId !== challengeId)
        if (nextPlan.length === previous.battlePlan.length) return
        await this.writePreviousPlannerRound({ ...previous, battlePlan: nextPlan })
    }

    async startChallenge(challengeId: string): Promise<ChallengeActionResult<ChallengeApiStartData>> {
        const { api } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        await this.assertCanStartChallenge(id)
        this.log("challenge:start", "starting challenge instance", { challengeId: id })
        const remote = await api.startChallenge(id)
        const challenge = await this.syncChallenge(id, "challenge-api:start")
        this.log("challenge:start", "challenge instance started", {
            challengeId: id,
            instanceStatus: challenge?.instance_status,
            entrypoint: challenge?.entrypoint ?? null,
            alreadyCompleted: computeChallengeCompleted(challenge),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async stopChallenge(challengeId: string): Promise<ChallengeActionResult<null>> {
        const { api } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        this.log("challenge:stop", "stopping challenge instance", { challengeId: id })
        const remote = await api.stopChallenge(id)
        const challenge = await this.syncChallenge(id, "challenge-api:stop")
        this.log("challenge:stop", "challenge instance stopped", {
            challengeId: id,
            instanceStatus: challenge?.instance_status,
            completed: computeChallengeCompleted(challenge),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async submitFlag(challengeId: string, flag: string, meta?: ChallengeSubmissionMeta): Promise<ChallengeActionResult<ChallengeApiSubmitData>> {
        const { api, rootDir } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        const normalizedFlag = requireText(flag, "flag")
        this.log("challenge:submit", "submitting flag", {
            challengeId: id,
            solverId: meta?.solverId,
            promptName: meta?.promptName,
            modelName: meta?.modelName,
        })
        const remote = await api.submitFlag(id, normalizedFlag)
        await appendChallengeSubmissionLog(rootDir, {
            challengeId: id,
            solverId: meta?.solverId,
            promptName: meta?.promptName,
            modelName: meta?.modelName,
            flag: normalizedFlag,
            correct: remote.correct,
            message: "message" in remote && typeof remote.message === "string" ? remote.message : undefined,
            writeup: meta?.writeup,
        })
        const challenge = await this.syncChallenge(id, "challenge-api:submit")
        this.log("challenge:submit", "flag submission finished", {
            challengeId: id,
            correct: remote.correct,
            flags: `${remote.flag_got_count}/${remote.flag_count}`,
            completed: computeChallengeCompleted(challenge),
        })
        if (computeChallengeCompleted(challenge)) {
            setTimeout(() => {
                void this.finishChallenge(id)
            }, 0)
        }
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    /**
     * Record a verified objective/finding in engagement mode.
     *
     * Unlike submitFlag:
     * - No remote scoring API (engagement has no judge)
     * - Writes local submission log only; correct always false (no "judged correct"; operator reviews)
     * - Never auto finishChallenge / mark complete — completion confirmed externally by operator
     */
    async recordEngagementObjective(
        engagementId: string,
        proof: string,
        meta?: ChallengeSubmissionMeta,
    ): Promise<ChallengeSubmissionLogRecord> {
        const rootDir = await this.getRootDir()
        const id = requireText(engagementId, "engagementId")
        const normalizedProof = requireText(proof, "proof")
        this.log("engagement:record", "recording verified objective", {
            engagementId: id,
            solverId: meta?.solverId,
            promptName: meta?.promptName,
            modelName: meta?.modelName,
        })
        return appendChallengeSubmissionLog(rootDir, {
            challengeId: id,
            solverId: meta?.solverId,
            promptName: meta?.promptName,
            modelName: meta?.modelName,
            flag: normalizedProof,
            correct: false,
            message: "recorded in engagement mode; pending operator confirmation",
            writeup: meta?.writeup,
            verificationStatus: meta?.verificationStatus,
        })
    }

    /**
     * Mark engagement target "primary objective achieved" → triggers finishChallenge:
     * Stops all solvers on that target; computeChallengeCompleted now true,
     * buildPlannerSnapshot excludes it from incomplete set → no re-dispatch.
     * Source: solver self-report via report_finding(objective_achieved=true), or operator manual mark.
     */
    async markEngagementComplete(challengeId: string, source = "engagement:objective-achieved"): Promise<void> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await readChallengeRecord(rootDir, id)
        if (!challenge) {
            this.error("engagement:complete", "target not found, cannot mark complete", undefined, { challengeId: id })
            return
        }
        if (challenge.objective_achieved === true) return // idempotent: already marked
        this.log("engagement:complete", "marking objective achieved", { challengeId: id, source })
        await saveChallengeRecord(rootDir, { ...challenge, objective_achieved: true }, source)
        // Reuse finish cleanup: stop instance + all solvers on this target.
        await this.finishChallenge(id)
    }

    private verifierRetryKey(challengeId: string, recordId: string): string {
        return `${challengeId}:${recordId}`
    }

    private async resolveVerifierRetrySettings(): Promise<{ maxRetries: number; baseMs: number }> {
        const settings = await this.config.getHostSettings()
        const maxRetries = clampInt(settings.challenge.verifierAutoRetryMax ?? DEFAULT_VERIFIER_AUTO_RETRY_MAX, 0, 12)
        const baseMs = clampInt(settings.challenge.verifierAutoRetryBaseMs ?? DEFAULT_VERIFIER_AUTO_RETRY_BASE_MS, 5_000, 30 * 60_000)
        return { maxRetries, baseMs }
    }

    private clearVerifierRetryTimer(challengeId: string, recordId: string): void {
        const key = this.verifierRetryKey(challengeId, recordId)
        const timer = this.verifierRetryTimers.get(key)
        if (timer) {
            clearTimeout(timer)
            this.verifierRetryTimers.delete(key)
        }
    }

    private async scheduleVerifierAutoRetry(input: {
        challengeId: string
        recordId: string
        proof: string
        writeup?: string
        entrypoint?: string[] | null
        retryCount: number
        reason: string
    }): Promise<void> {
        const { maxRetries, baseMs } = await this.resolveVerifierRetrySettings()
        if (maxRetries <= 0 || input.retryCount >= maxRetries) {
            this.clearVerifierRetryTimer(input.challengeId, input.recordId)
            const rootDir = await this.getRootDir()
            await updateChallengeSubmissionVerification(rootDir, input.challengeId, input.recordId, {
                verification_status: "inconclusive",
                verifier_note: `${input.reason} (auto-retry exhausted after ${input.retryCount} attempts)`,
                verification_next_retry_at: null,
            }).catch(() => {})
            return
        }

        const delayMs = baseMs * 2 ** input.retryCount
        const nextAt = new Date(Date.now() + delayMs).toISOString()
        const rootDir = await this.getRootDir()
        await updateChallengeSubmissionVerification(rootDir, input.challengeId, input.recordId, {
            verification_status: "pending",
            verifier_note: `${input.reason}; auto-retry ${input.retryCount + 1}/${maxRetries} scheduled`,
            verification_retry_count: input.retryCount + 1,
            verification_next_retry_at: nextAt,
        }).catch(() => {})

        const key = this.verifierRetryKey(input.challengeId, input.recordId)
        this.clearVerifierRetryTimer(input.challengeId, input.recordId)
        const timer = setTimeout(() => {
            this.verifierRetryTimers.delete(key)
            void this.runVerifierAutoRetry(input.challengeId, input.recordId)
        }, delayMs)
        this.verifierRetryTimers.set(key, timer)
        this.log("engagement:verify", "scheduled verifier auto-retry", {
            challengeId: input.challengeId,
            recordId: input.recordId,
            attempt: input.retryCount + 1,
            maxRetries,
            delayMs,
        })
    }

    private async runVerifierAutoRetry(challengeId: string, recordId: string): Promise<void> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const submissions = await this.listSubmissionLogs(id)
        const record = submissions.find((item) => item.id === recordId)
        if (!record) return
        if (record.verification_status === "verified" || record.verification_status === "rejected") return
        const challenge = await readChallengeRecord(rootDir, id)
        await this.verifyObjective({
            challengeId: id,
            recordId,
            proof: record.flag,
            writeup: record.writeup,
            entrypoint: challenge?.entrypoint ?? null,
        })
    }

    async resumePendingVerifierRetries(): Promise<void> {
        const rootDir = await this.getRootDir()
        const challenges = await this.filterChallengesByMode(await listChallengeRecords(rootDir))
        const now = Date.now()
        for (const challenge of challenges) {
            const submissions = await listChallengeSubmissionLogs(rootDir, challenge.id)
            for (const record of submissions) {
                if (!record.verification_next_retry_at) continue
                if (record.verification_status === "verified" || record.verification_status === "rejected") continue
                const dueAt = Date.parse(record.verification_next_retry_at)
                if (Number.isNaN(dueAt)) continue
                const delayMs = Math.max(0, dueAt - now)
                const key = this.verifierRetryKey(challenge.id, record.id)
                if (this.verifierRetryTimers.has(key)) continue
                const timer = setTimeout(() => {
                    this.verifierRetryTimers.delete(key)
                    void this.runVerifierAutoRetry(challenge.id, record.id)
                }, delayMs)
                this.verifierRetryTimers.set(key, timer)
            }
        }
    }

    /**
     * Independent verifier re-run (the "active reproduction" half of dual verification).
     *
     * After solver reports primary objective and passes evidence gate (deterministic first pass), engine starts async verifier agent,
     * re-runs core proof assertions on target via bash in Kali, with freshly generated evidence
     * before verified. Only verified triggers markEngagementComplete (auto wind-down); rejected/inconclusive
     * do not wind down; solvers keep going (rejected steers "verification failed, continue").
     *
     * Fixes hallucinated RCE stopping the whole line — regex gate is cheap first pass; verifier is active reproduction.
     */
    async verifyObjective(input: {
        challengeId: string
        recordId: string
        proof: string
        writeup?: string
        entrypoint?: string[] | null
        onResolved?: (verdict: "verified" | "rejected" | "inconclusive", note: string) => void
    }): Promise<void> {
        const rootDir = await this.getRootDir()
        const id = requireText(input.challengeId, "challengeId")
        const challengeRecord = await readChallengeRecord(rootDir, id).catch(() => undefined)
        const objectiveText = challengeRecord ? `${challengeRecord.title}\n${challengeRecord.description}` : ""
        const entrypoint = input.entrypoint ?? challengeRecord?.entrypoint ?? null
        const resolve = async (verdict: "verified" | "rejected" | "inconclusive", note: string) => {
            if (verdict === "verified" || verdict === "rejected") {
                this.clearVerifierRetryTimer(id, input.recordId)
            }
            await updateChallengeSubmissionVerification(rootDir, id, input.recordId, {
                verification_status: verdict,
                verifier_note: note,
                verification_next_retry_at: verdict === "verified" || verdict === "rejected" ? null : undefined,
            }).catch(() => {})
            try {
                input.onResolved?.(verdict, note)
            } catch {
                // ignore callback errors
            }
            if (verdict === "inconclusive") {
                const submissions = await this.listSubmissionLogs(id)
                const record = submissions.find((item) => item.id === input.recordId)
                const retryCount = record?.verification_retry_count ?? 0
                await this.scheduleVerifierAutoRetry({
                    challengeId: id,
                    recordId: input.recordId,
                    proof: input.proof,
                    writeup: input.writeup,
                    entrypoint,
                    retryCount,
                    reason: note,
                })
            }
        }

        let sessionOpts: Awaited<ReturnType<ConfigManager["resolvePromptSession"]>>
        try {
            sessionOpts = await this.config.resolvePromptSession(OBJECTIVE_VERIFIER_PROMPT_NAME)
        } catch (error) {
            this.error("engagement:verify", "verifier prompt failed to resolve", error, { challengeId: id })
            sessionOpts = undefined
        }
        if (!sessionOpts?.resourceLoader) {
            // Verifier unavailable must not silently pass; mark inconclusive for operator review.
            this.log("engagement:verify", "verifier unavailable; leaving for operator review", { challengeId: id })
            await resolve("inconclusive", "verifier prompt unavailable; left for operator confirmation")
            return
        }

        const needsShell = requiresServerAccessObjective(objectiveText)
        const verifierBrief = [
            `A solver reported the PRIMARY OBJECTIVE achieved on this target. Independently reproduce it now and return a verdict.`,
            ``,
            `Target id: ${input.challengeId}`,
            objectiveText.trim() ? `Stated primary objective (from target record):\n${objectiveText.trim()}` : `Stated primary objective: (see proof)`,
            entrypoint && entrypoint.length > 0 ? `Target entrypoint:\n${entrypoint.map((item) => `- ${item}`).join("\n")}` : `Target entrypoint: (see proof)`,
            needsShell
                ? `IMPORTANT: This engagement requires SERVER ACCESS (interactive shell/RCE on the stated target). Credential-only proof (JWT, API admin token, NoSQL/CMS login) is NOT sufficient for verified — reproduce code execution with fresh command output (e.g. id, hostname).`
                : ``,
            ``,
            `Reported proof:`,
            input.proof.trim() || "(empty)",
            ``,
            input.writeup?.trim() ? `Reported route writeup:\n${input.writeup.trim()}` : `Reported route writeup: (none)`,
            ``,
            `Reproduce the core claim against the target, then call submit_verdict exactly once.`,
        ]
            .filter((line) => line !== "")
            .join("\n")

        let verdict: "verified" | "rejected" | "inconclusive" | undefined
        let verdictNote = ""
        const verifierTool = defineTool({
            name: "submit_verdict",
            label: "Submit Verdict",
            description: "Submit your final verification verdict for the reported objective. Call exactly once when reproduction is done.",
            parameters: Type.Object({
                verdict: Type.Union([Type.Literal("verified"), Type.Literal("rejected"), Type.Literal("inconclusive")], {
                    description: "verified = you independently reproduced it with fresh evidence; rejected = you tried and it does not hold; inconclusive = you could not run the check",
                }),
                evidence: Type.String({ description: "The fresh command(s) you ran and the decisive output, or why you could not verify. Keep it tight." }),
            }),
            execute: async (_toolCallId, params: { verdict: "verified" | "rejected" | "inconclusive"; evidence: string }) => {
                verdict = params.verdict
                verdictNote = params.evidence?.trim() || ""
                return { content: [{ type: "text", text: `verdict recorded: ${params.verdict}` }], details: { verdict: params.verdict } }
            },
        })

        try {
            const { session } = await createAgentSession({
                ...sessionOpts,
                customTools: [...(sessionOpts.customTools ?? []), verifierTool],
                sessionManager: SessionManager.inMemory(),
            })
            session.subscribe((event) => {
                if (event.type === "tool_execution_end" && event.isError) {
                    this.error("engagement:verify", "verifier tool failed", undefined, { toolName: event.toolName, result: event.result })
                }
            })
            this.log("engagement:verify", "verifier reproducing reported objective", { challengeId: id, recordId: input.recordId })
            await session.prompt(verifierBrief)
            session.dispose()
        } catch (error) {
            this.error("engagement:verify", "verifier session failed", error, { challengeId: id })
            await resolve("inconclusive", "verifier session errored; left for operator confirmation")
            return
        }

        if (verdict === "verified") {
            const postGate = validateObjectiveEvidence(input.proof, [input.writeup, verdictNote].filter(Boolean).join("\n"), {
                objectiveText,
            })
            if (!postGate.sufficient) {
                this.log("engagement:verify", "verifier said verified but evidence gate rejected (server-access objective)", {
                    challengeId: id,
                    reason: postGate.reason,
                })
                await resolve("rejected", postGate.reason)
                return
            }
            this.log("engagement:verify", "objective VERIFIED by independent re-run; winding down target", { challengeId: id })
            await resolve("verified", verdictNote || "independently reproduced")
            await this.markEngagementComplete(id, "engagement:verifier-confirmed")
            return
        }
        if (verdict === "rejected") {
            this.log("engagement:verify", "objective REJECTED by verifier (likely false positive); target stays active", { challengeId: id })
            await resolve("rejected", verdictNote || "verifier could not reproduce the claim")
            return
        }
        // No verdict / inconclusive: do not wind down; operator reviews.
        this.log("engagement:verify", "verifier inconclusive; left for operator review", { challengeId: id })
        await resolve("inconclusive", verdictNote || "verifier could not run the check")
    }

    /** Operator-triggered re-run of independent objective verification. */
    async retryVerifyObjective(challengeId: string, recordId: string): Promise<void> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const rid = requireText(recordId, "recordId")
        const submissions = await this.listSubmissionLogs(id)
        const record = submissions.find((item) => item.id === rid)
        if (!record) throw new Error(`submission "${rid}" not found`)
        const status = record.verification_status
        if (status !== "inconclusive" && status !== "pending" && status !== "rejected") {
            throw new Error(`submission verification status "${status ?? "unset"}" is not retryable`)
        }
        this.clearVerifierRetryTimer(id, rid)
        await updateChallengeSubmissionVerification(rootDir, id, rid, {
            verification_status: "pending",
            verifier_note: "operator requested re-verification",
            verification_retry_count: 0,
            verification_next_retry_at: null,
        })
        const challenge = await readChallengeRecord(rootDir, id)
        await this.verifyObjective({
            challengeId: id,
            recordId: rid,
            proof: record.flag,
            writeup: record.writeup,
            entrypoint: challenge?.entrypoint ?? null,
        })
    }

    /** Operator manually confirms completion (same as marking primary objective achieved). */
    async confirmEngagementComplete(challengeId: string): Promise<void> {
        await this.markEngagementComplete(challengeId, "engagement:operator-confirm")
    }

    /**
     * Operator revokes "complete" (false-positive safety net):
     * 1. Clear objective_achieved → target back to incomplete (planner resumes)
     * 2. Resume solvers stopped on completion with same session (continue with context, not cold restart)
     * If no recorded stop list, fall back to all stopped solvers on this target.
     */
    async revokeEngagementComplete(challengeId: string): Promise<{ resumed: string[] }> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await readChallengeRecord(rootDir, id)
        if (!challenge) {
            this.error("engagement:revoke", "target not found", undefined, { challengeId: id })
            return { resumed: [] }
        }
        if (challenge.objective_achieved === true) {
            await saveChallengeRecord(rootDir, { ...challenge, objective_achieved: false }, "engagement:operator-revoke")
            this.log("engagement:revoke", "objective_achieved cleared; target back to in-progress", { challengeId: id })
        }

        const runtime = this.runtime
        if (!runtime) return { resumed: [] }

        // Prefer solvers recorded at completion; else fall back to currently stopped solvers on this target.
        let toResume = this.stoppedOnCompletion.get(id)
        if (!toResume || toResume.length === 0) {
            const all = await runtime.listAll()
            toResume = all.filter((s) => s.challengeId === id && s.status === "stopped").map((s) => s.id)
        }

        const solverEnv: Record<string, string> = { [CHALLENGE_ENV_CHALLENGE_ID]: id }
        if (isEngagementMode()) {
            solverEnv[ENGAGEMENT_ENV_MODE] = "1"
            const scopePath = process.env[ENGAGEMENT_ENV_SCOPE]?.trim()
            if (scopePath) solverEnv[ENGAGEMENT_ENV_SCOPE] = scopePath
        }

        const resumed: string[] = []
        for (const solverId of toResume) {
            try {
                await runtime.resumeSolver(solverId, solverEnv)
                resumed.push(solverId)
            } catch (error) {
                this.error("engagement:revoke", "failed to resume solver", error, { challengeId: id, solverId })
            }
        }
        this.stoppedOnCompletion.delete(id)
        this.log("engagement:revoke", "resumed solvers after revoke", { challengeId: id, resumed })
        return { resumed }
    }

    private buildSolverEnvForChallenge(challengeId: string): Record<string, string> {
        const solverEnv: Record<string, string> = { [CHALLENGE_ENV_CHALLENGE_ID]: challengeId }
        if (isEngagementMode()) {
            solverEnv[ENGAGEMENT_ENV_MODE] = "1"
            const scopePath = process.env[ENGAGEMENT_ENV_SCOPE]?.trim()
            if (scopePath) solverEnv[ENGAGEMENT_ENV_SCOPE] = scopePath
        }
        return solverEnv
    }

    private async listStoppedSolverIdsForChallenge(challengeId: string): Promise<string[]> {
        const runtime = this.runtime
        if (!runtime) return []
        const all = await runtime.listAll()
        return all.filter((solver) => solver.challengeId === challengeId && solver.status === "stopped").map((solver) => solver.id)
    }

    private async stopActiveSolversForChallenge(challengeId: string): Promise<string[]> {
        const runtime = this.runtime
        if (!runtime) return []
        const all = await runtime.listAll()
        const active = all.filter(
            (solver) =>
                solver.challengeId === challengeId &&
                (solver.status === "running" || solver.status === "starting" || solver.status === "stopping"),
        )
        const stopped: string[] = []
        for (const solver of active) {
            try {
                await runtime.stopSolver(solver.id)
                stopped.push(solver.id)
            } catch (error) {
                this.error("challenge:pause", "failed to stop solver", error, { challengeId, solverId: solver.id })
            }
        }
        return stopped
    }

    /**
     * Operator pause: stop active solvers on this target and block planner / new launches.
     * Shared operational state (memory, ideas, assets) is preserved.
     */
    async pauseTargetTesting(challengeId: string): Promise<{ stoppedSolvers: string[] }> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await readChallengeRecord(rootDir, id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        if (computeChallengeCompleted(challenge)) {
            throw new Error(`challenge "${id}" is already completed`)
        }
        if (challenge.testing_paused === true) {
            return { stoppedSolvers: [] }
        }

        const stoppedSolvers = await this.stopActiveSolversForChallenge(id)
        if (stoppedSolvers.length > 0) {
            this.stoppedOnPause.set(id, stoppedSolvers)
        }

        await saveChallengeRecord(rootDir, { ...challenge, testing_paused: true }, "engagement:pause-testing")
        this.log("challenge:pause", "target testing paused", { challengeId: id, stoppedSolvers })
        return { stoppedSolvers }
    }

    /**
     * Operator resume: clear pause flag and continue stopped solvers with persisted sessions (same as revoke-complete resume path).
     */
    async resumeTargetTesting(challengeId: string): Promise<{ resumed: string[] }> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await readChallengeRecord(rootDir, id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        if (computeChallengeCompleted(challenge)) {
            throw new Error(`challenge "${id}" is already completed`)
        }
        if (challenge.testing_paused !== true) {
            return { resumed: [] }
        }

        await saveChallengeRecord(rootDir, { ...challenge, testing_paused: false }, "engagement:resume-testing")

        const runtime = this.runtime
        if (!runtime) {
            this.stoppedOnPause.delete(id)
            this.log("challenge:resume", "target testing resumed (no runtime attached)", { challengeId: id })
            return { resumed: [] }
        }

        let toResume = this.stoppedOnPause.get(id)
        if (!toResume || toResume.length === 0) {
            toResume = await this.listStoppedSolverIdsForChallenge(id)
        }
        const solverEnv = this.buildSolverEnvForChallenge(id)
        const resumed: string[] = []
        for (const solverId of toResume) {
            try {
                await runtime.resumeSolver(solverId, solverEnv)
                resumed.push(solverId)
            } catch (error) {
                this.error("challenge:resume", "failed to resume solver", error, { challengeId: id, solverId })
            }
        }
        this.stoppedOnPause.delete(id)
        this.log("challenge:resume", "target testing resumed", { challengeId: id, resumed })
        return { resumed }
    }

    async getHint(challengeId: string): Promise<ChallengeActionResult<ChallengeApiHintData>> {
        const { api, rootDir } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        this.log("challenge:hint", "requesting hint", { challengeId: id })
        const remote = await api.getHint(id)
        const current = await this.readVisibleChallenge(id)
        if (current) {
            await saveChallengeRecord(
                rootDir,
                {
                    ...current,
                    hint_viewed: true,
                    hint_content: remote.hint_content,
                },
                "challenge-api:hint-content",
            )
        }
        const challenge = await this.syncChallenge(id, "challenge-api:hint")
        this.log("challenge:hint", "hint received", {
            challengeId: id,
            hintViewed: challenge?.hint_viewed === true,
            hasHintContent: Boolean(remote.hint_content?.trim()),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async isChallengeCompleted(challengeId: string): Promise<boolean> {
        const challenge = await this.readVisibleChallenge(challengeId)
        return computeChallengeCompleted(challenge)
    }

    async appendMemory(input: AddMemoryInput): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await appendChallengeMemory(rootDir, input)
        this.broadcastChallengeBoardUpdateToRunningSolvers(input.challengeId, formatChallengeMemoryBroadcastMessage("added", entry))
        return entry
    }

    /**
     * Promote one memory line to the challenge-level board when it passes promotion rules and is not a duplicate.
     * Used by observer sidecar (via host bridge) and finding extraction.
     */
    async tryPromoteMemoryToChallenge(input: AddMemoryInput): Promise<PromoteMemoryResult> {
        const challengeId = requireText(input.challengeId, "challengeId")
        const content = requireText(input.content, "content")
        if (!shouldPromoteMemoryKind(input.kind, content)) {
            return { promoted: false, duplicate: false }
        }
        const existing = await this.listMemory(challengeId)
        if (memoryFingerprintExists(existing, content)) {
            return { promoted: false, duplicate: true }
        }
        const entry = await this.appendMemory({
            ...input,
            challengeId,
            content,
            source: requireText(input.source, "source"),
        })
        return { promoted: true, duplicate: false, entry }
    }

    /**
     * Promote a terminal hypothesis (verified/failed) to the challenge-level idea board.
     */
    async tryPromoteIdeaToChallenge(
        challengeId: string,
        input: AddIdeaInput,
        source = "observer-promote",
    ): Promise<PromoteIdeaResult> {
        const id = requireText(challengeId, "challengeId")
        const status = input.status ?? "pending"
        if (!shouldPromoteIdeaStatus(status)) {
            return { promoted: false, duplicate: false }
        }
        const rootDir = await this.getRootDir()
        const result = await addChallengeIdea(rootDir, id, buildPromoteIdeaInput(input.content, status, input.result))
        if (result.created) {
            this.broadcastChallengeBoardUpdateToRunningSolvers(id, formatChallengeIdeaBroadcastMessage("added", result.item))
            return { promoted: true, duplicate: false, item: result.item }
        }
        const updated = await updateChallengeIdea(rootDir, id, result.item.id, {
            status,
            result: input.result,
        })
        const statusChanged = updated.status !== result.item.status || (input.result?.trim() ?? "") !== result.item.result
        if (statusChanged) {
            this.broadcastChallengeBoardUpdateToRunningSolvers(id, formatChallengeIdeaBroadcastMessage("updated", updated))
            return { promoted: true, duplicate: true, item: updated }
        }
        return { promoted: false, duplicate: true, item: result.item }
    }

    /** Extract high-signal lines from a finding into challenge-level fact memory (deduped). */
    async promoteFindingFactsToChallenge(
        challengeId: string,
        proof: string,
        writeup: string | undefined,
        source: string,
    ): Promise<{ promoted: number; duplicate: number; skipped: number }> {
        const id = requireText(challengeId, "challengeId")
        const lines = extractFindingFactLines(proof, writeup)
        let promoted = 0
        let duplicate = 0
        let skipped = 0
        for (const line of lines) {
            const result = await this.tryPromoteMemoryToChallenge(
                buildPromoteMemoryInput(id, "fact", line, source),
            )
            if (result.promoted) promoted += 1
            else if (result.duplicate) duplicate += 1
            else skipped += 1
        }
        return { promoted, duplicate, skipped }
    }

    async listMemory(challengeId: string): Promise<MemoryEntry[]> {
        const rootDir = await this.getRootDir()
        return listChallengeMemory(rootDir, challengeId)
    }

    async updateMemory(challengeId: string, entryIdOrPrefix: string, patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string }): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await updateChallengeMemory(rootDir, challengeId, entryIdOrPrefix, patch)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeMemoryBroadcastMessage("updated", entry))
        return entry
    }

    async deleteMemory(challengeId: string, entryIdOrPrefix: string): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await deleteChallengeMemory(rootDir, challengeId, entryIdOrPrefix)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeMemoryBroadcastMessage("deleted", entry))
        return entry
    }

    // ── Relational Graph Memory Wrappers ──

    async appendRelation(input: AddRelationInput): Promise<MemoryRelation> {
        const rootDir = await this.getRootDir()
        return appendChallengeRelation(rootDir, input)
    }

    async listRelations(challengeId: string): Promise<MemoryRelation[]> {
        const rootDir = await this.getRootDir()
        return listChallengeRelations(rootDir, challengeId)
    }

    async updateRelation(challengeId: string, relationIdOrPrefix: string, patch: UpdateRelationInput): Promise<MemoryRelation> {
        const rootDir = await this.getRootDir()
        return updateChallengeRelation(rootDir, challengeId, relationIdOrPrefix, patch)
    }

    async deleteRelation(challengeId: string, relationIdOrPrefix: string): Promise<MemoryRelation> {
        const rootDir = await this.getRootDir()
        return deleteChallengeRelation(rootDir, challengeId, relationIdOrPrefix)
    }

    async queryRelations(challengeId: string, filter: { source?: string; relation?: string; target?: string }): Promise<MemoryRelation[]> {
        const rootDir = await this.getRootDir()
        return queryChallengeRelations(rootDir, challengeId, filter)
    }

    async findRelationShortestPath(challengeId: string, start: string, end: string): Promise<GraphPathResult> {
        const rootDir = await this.getRootDir()
        const relations = await listChallengeRelations(rootDir, challengeId)
        return findChallengeRelationShortestPath(relations, start, end)
    }

    /** Full target progress panorama for Commander / operator tools. */
    async buildTargetOverview(targetId: string): Promise<TargetOverview> {
        const challengeId = requireText(targetId, "targetId")
        const challenge = await this.getChallenge(challengeId)
        if (!challenge) {
            throw new Error(`challenge "${challengeId}" not found`)
        }

        const rootDir = await this.getRootDir()
        const [attempts, submissions, memory, ideas, stateAssets, relations] = await Promise.all([
            listChallengeAttemptLogs(rootDir, challengeId),
            listChallengeSubmissionLogs(rootDir, challengeId),
            listChallengeMemory(rootDir, challengeId),
            listChallengeIdeas(rootDir, challengeId),
            listChallengeStateAssets(rootDir, challengeId),
            listChallengeRelations(rootDir, challengeId),
        ])

        const settings = await this.config.getHostSettings()
        const staleTimeoutMs = clampInt(settings.planner.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS, 5 * 60 * 1000, 24 * 60 * 60 * 1000)

        let activeSolvers: SolverInstance[] = []
        if (this.runtime) {
            const allSolvers =
                typeof this.runtime.listAll === "function" ? await this.runtime.listAll() : this.runtime.list()
            activeSolvers = allSolvers.filter(isActiveSolver).filter((solver) => solver.challengeId === challengeId)
        }

        const snapshot = this.buildPlannerSnapshotItem(
            challenge,
            attempts,
            submissions,
            memory,
            ideas,
            stateAssets,
            activeSolvers,
            staleTimeoutMs,
        )

        const activeSolverRows = await Promise.all(
            activeSolvers.map(async (solver) => ({
                id: solver.id,
                status: solver.status,
                currentFocus: await this.deriveSolverFocus(solver),
            })),
        )

        const relationLines = sortByUpdatedAtDesc(relations)
            .slice(0, PLANNER_MEMORY_FACT_LIMIT)
            .map((item) => formatRelationLine(item))

        return {
            challengeId: challenge.id,
            title: challenge.title,
            instanceStatus: challenge.instance_status,
            progressPhase: snapshot.progressPhase,
            successRate: snapshot.successRate,
            failedRouteCount: snapshot.failedRouteCount,
            findingCount: snapshot.correctSubmissionCount,
            activeSolverCount: snapshot.activeSolverCount,
            pruneRecommended: snapshot.pruneRecommended,
            stateAssets: snapshot.stateAssets,
            relations: relationLines,
            memoryFacts: snapshot.memoryFacts,
            failureBoundaries: snapshot.failureBoundaries,
            liveIdeas: snapshot.liveIdeas,
            findings: snapshot.findings,
            activeSolvers: activeSolverRows,
        }
    }

    /** Aggregated live progress view for the operations board UI. */
    async buildProgressDigest(challengeId: string): Promise<ChallengeProgressDigest> {
        const id = requireText(challengeId, "challengeId")
        const challenge = await this.getChallenge(id)
        if (!challenge) {
            throw new Error(`challenge "${id}" not found`)
        }

        const [overview, ideas, memory, submissions, attempts, statsResult] = await Promise.all([
            this.buildTargetOverview(id),
            this.listIdeas(id),
            this.listMemory(id),
            this.listSubmissionLogs(id),
            this.listAttemptLogs(id),
            this.refreshStats(id),
        ])

        const solverPromptById: Record<string, string | undefined> = {}
        if (this.runtime) {
            const allSolvers =
                typeof this.runtime.listAll === "function" ? await this.runtime.listAll() : this.runtime.list()
            for (const solver of allSolvers) {
                if (solver.challengeId === id) solverPromptById[solver.id] = solver.promptName
            }
        }

        const previousRound = await this.readPreviousPlannerRound()
        const battlePlanEntry = previousRound?.battlePlan?.find((entry) => entry.challengeId === id)
        const timeline = await buildChallengeAttackTimeline({
            challengeId: id,
            memory,
            ideas,
            attempts,
            submissions,
            solverStats: statsResult.solver_stats,
        })

        return buildChallengeProgressDigest({
            challenge,
            overview: {
                progressPhase: overview.progressPhase,
                instanceStatus: overview.instanceStatus,
                activeSolverCount: overview.activeSolverCount,
                findingCount: overview.findingCount,
                failedRouteCount: overview.failedRouteCount,
                successRate: overview.successRate,
                pruneRecommended: overview.pruneRecommended,
                stateAssets: overview.stateAssets,
                activeSolvers: overview.activeSolvers,
            },
            ideas,
            memory,
            submissions,
            solverPromptById,
            battlePlan: battlePlanEntry
                ? {
                      challengeId: battlePlanEntry.challengeId,
                      strategy: battlePlanEntry.strategy,
                      nextCheckpoint: battlePlanEntry.nextCheckpoint,
                      updated_at: battlePlanEntry.updated_at,
                  }
                : undefined,
            plannerSummary: previousRound?.summary,
            recentEvents: timeline.events,
        })
    }

    async listIdeas(challengeId: string): Promise<IdeaRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeIdeas(rootDir, challengeId)
    }

    async searchIdeas(challengeId: string, query: string): Promise<IdeaRecord[]> {
        const rootDir = await this.getRootDir()
        return searchChallengeIdeas(rootDir, challengeId, query)
    }

    async addIdea(challengeId: string, input: AddIdeaInput): Promise<AddIdeaResult> {
        const rootDir = await this.getRootDir()
        const result = await addChallengeIdea(rootDir, challengeId, input)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("added", result.item))
        return result
    }

    async updateIdea(challengeId: string, ideaIdOrPrefix: string, patch: UpdateIdeaInput): Promise<IdeaRecord> {
        const rootDir = await this.getRootDir()
        const item = await updateChallengeIdea(rootDir, challengeId, ideaIdOrPrefix, patch)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("updated", item))
        return item
    }

    async deleteIdea(challengeId: string, ideaIdOrPrefix: string): Promise<IdeaRecord> {
        const rootDir = await this.getRootDir()
        const item = await deleteChallengeIdea(rootDir, challengeId, ideaIdOrPrefix)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("deleted", item))
        return item
    }

    // ── Structured battlefield state (cross-solver hosts/services/credentials/sessions) ──

    async listStateAssets(challengeId: string): Promise<StateAsset[]> {
        const rootDir = await this.getRootDir()
        return listChallengeStateAssets(rootDir, challengeId)
    }

    async upsertStateAsset(challengeId: string, input: AddStateAssetInput): Promise<UpsertStateAssetResult & { vulnLookup?: VulnLookupAck }> {
        const rootDir = await this.getRootDir()
        const result = await upsertChallengeStateAsset(rootDir, challengeId, input)
        // New assets (especially creds/sessions) are high-value intel → broadcast to avoid duplicate brute/re-acquisition.
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeStateAssetBroadcastMessage(result.created ? "added" : "updated", result.asset))

        let vulnLookup: VulnLookupAck | undefined
        if (input.kind === "service") {
            const serviceText = (input.service ?? input.label).trim()
            const { component, version } = splitServiceVersion(serviceText)
            if (component) {
                vulnLookup = peekVulnLookupStatus(component, version)
                void this.finalizeServiceVulnLookup(challengeId, component, version, vulnLookup.status)
            }
        }
        return { ...result, vulnLookup }
    }

    private async finalizeServiceVulnLookup(
        challengeId: string,
        component: string,
        version: string | undefined,
        initialStatus: VulnLookupStatus,
    ): Promise<void> {
        if (initialStatus === "queued") {
            const note = formatVulnStatusNote("queued", component, version)
            if (note) await this.appendMemory({ challengeId, kind: "note", content: note, source: "vuln-intel" })
        }

        const result = await lookupComponentVulns(component, version)

        if (result.status === "rate_limited") {
            const note = formatVulnStatusNote("rate_limited", component, version)
            if (note) await this.appendMemory({ challengeId, kind: "note", content: note, source: "vuln-intel" })
            return
        }

        const broadcast = formatVulnBroadcast(result)
        if (broadcast) this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, broadcast)
    }

    async updateStateAsset(challengeId: string, assetId: string, patch: UpdateStateAssetInput): Promise<StateAsset | undefined> {
        const rootDir = await this.getRootDir()
        const asset = await updateChallengeStateAsset(rootDir, challengeId, assetId, patch)
        if (asset) this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeStateAssetBroadcastMessage("updated", asset))
        return asset
    }

    async deleteStateAsset(challengeId: string, assetId: string): Promise<boolean> {
        const rootDir = await this.getRootDir()
        return deleteChallengeStateAsset(rootDir, challengeId, assetId)
    }

    async appendAttemptLog(input: { challengeId: string; solverId: string; promptName: string; task: string }) {
        const rootDir = await this.getRootDir()
        return appendChallengeAttemptLog(rootDir, input)
    }

    async listAttemptLogs(challengeId: string): Promise<ChallengeAttemptLogRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeAttemptLogs(rootDir, challengeId)
    }

    async listSubmissionLogs(challengeId: string): Promise<ChallengeSubmissionLogRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeSubmissionLogs(rootDir, challengeId)
    }

    async refreshStats(challengeId: string): Promise<{ stats: ChallengeStatsRecord; solver_stats: SolverStatsRecord[] }> {
        const rootDir = await this.getRootDir()
        return refreshChallengeStats(rootDir, challengeId)
    }

    private async seedSolverBoardFromChallenge(solverId: string, challengeId: string): Promise<void> {
        const [memoryItems, ideaItems] = await Promise.all([this.listMemory(challengeId), this.listIdeas(challengeId)])
        await seedSolverBoardSnapshot(
            {
                memory: memoryItems,
                ideas: ideaItems,
            },
            solverSessionDir(solverId),
        )
    }

    private async getChallengeProgressPhase(challengeId: string): Promise<PlannerProgressPhase> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await readChallengeRecord(rootDir, id)
        if (!challenge) throw new Error(`challenge "${id}" not found`)
        const [attempts, submissions, memory, ideas, stateAssets] = await Promise.all([
            listChallengeAttemptLogs(rootDir, id),
            listChallengeSubmissionLogs(rootDir, id),
            listChallengeMemory(rootDir, id),
            listChallengeIdeas(rootDir, id),
            listChallengeStateAssets(rootDir, id),
        ])
        return this.buildPlannerSnapshotItem(challenge, attempts, submissions, memory, ideas, stateAssets, [], DEFAULT_STALE_TIMEOUT_MS)
            .progressPhase
    }

    async launchSolver(challengeId: string, promptName: string, options?: LaunchSolverOptions): Promise<SolverInstance> {
        if (!this.runtime) {
            throw new Error("runtime is not attached")
        }
        const promptNameText = requireText(promptName, "promptName")
        this.log("challenge:solver", "launch requested", { challengeId, promptName: promptNameText })

        const prompt = await this.config.getPrompt(promptNameText)
        if (!prompt) {
            throw new Error(`prompt not found: ${promptNameText}`)
        }
        if (prompt.meta.disabled === true) {
            throw new Error(`prompt is disabled: ${promptNameText}`)
        }
        if (prompt.meta.isSubagent === true) {
            throw new Error(`subagent prompt cannot be started as solver: ${promptNameText}`)
        }

        const current = await this.getChallenge(challengeId)
        if (!current) {
            throw new Error(`challenge "${challengeId}" not found`)
        }
        if (computeChallengeCompleted(current)) {
            throw new Error(`challenge "${challengeId}" is already completed`)
        }
        if (current.testing_paused === true) {
            throw new Error(`target "${challengeId}" testing is paused; use resume testing on the target page first`)
        }
        if (promptNameText === KALI_PROVISIONER_PROMPT_NAME) {
            const progressPhase = await this.getChallengeProgressPhase(challengeId)
            if (progressPhase === "untouched" || progressPhase === "recon") {
                throw new Error(
                    `KALI_PROVISIONER is blocked during ${progressPhase} phase; use a recon/exploit solver until foothold, or wait until breakthrough`,
                )
            }
        }

        let challenge: ChallengeInfoRecord | undefined = current
        if (current.instance_status === "running" || current.instance_status === "pending") {
            this.log("challenge:solver", "reuse running challenge instance", {
                challengeId,
                instanceStatus: current.instance_status,
                entrypoint: current.entrypoint ?? null,
            })
        } else {
            const started = await this.startChallenge(challengeId)
            challenge = started.challenge ?? (await this.getChallenge(challengeId))
        }
        if (!challenge) {
            throw new Error(`challenge "${challengeId}" not found after start`)
        }
        if (computeChallengeCompleted(challenge)) {
            void this.finishChallenge(challengeId)
            throw new Error(`challenge "${challengeId}" is already completed`)
        }

        const settings = await this.config.getHostSettings()
        const maxSolvers = clampInt(settings.runtime.maxSolvers ?? DEFAULT_MAX_SOLVERS, 0, 64)
        const allSolvers =
            typeof this.runtime.listAll === "function" ? await this.runtime.listAll() : this.runtime.list()
        const activeSolvers = allSolvers.filter(isActiveSolver)
        if (activeSolvers.length >= maxSolvers) {
            throw new Error(`solver capacity reached: ${activeSolvers.length}/${maxSolvers}`)
        }

        const solverId = crypto.randomUUID().slice(0, 8)
        const task = await this.buildSolverTask(challenge, options)
        try {
            await this.seedSolverBoardFromChallenge(solverId, challengeId)
        } catch (error) {
            this.error("challenge:solver", "failed to seed solver board from challenge context", error, {
                challengeId,
                solverId,
            })
        }
        const solverEnv: Record<string, string> = { [CHALLENGE_ENV_CHALLENGE_ID]: challengeId }
        // Engagement: pass engagement flag and scope path to solver,
        // so host-bridge-handler uses engagement branch via getSolverEnvValue (local records, no remote scoring).
        if (isEngagementMode()) {
            solverEnv[ENGAGEMENT_ENV_MODE] = "1"
            const scopePath = process.env[ENGAGEMENT_ENV_SCOPE]?.trim()
            if (scopePath) solverEnv[ENGAGEMENT_ENV_SCOPE] = scopePath
        }
        const solver = await this.runtime.launch(promptNameText, task, solverEnv, { solverId })
        await this.appendAttemptLog({
            challengeId,
            solverId: solver.id,
            promptName: promptNameText,
            task: solver.task,
        })
        this.log("challenge:solver", "solver launched", {
            challengeId,
            solverId: solver.id,
            promptName: promptNameText,
            solverName: solver.name,
        })
        return solver
    }

    async finishChallenge(challengeId: string): Promise<void> {
        const id = requireText(challengeId, "challengeId")
        if (this.finishingChallenges.has(id)) return
        this.finishingChallenges.add(id)
        this.log("challenge:finish", "finishing solved challenge", { challengeId: id })
        try {
            const challenge = await this.getChallenge(id)
            if (!computeChallengeCompleted(challenge)) return

            if (challenge && (challenge.instance_status === "running" || challenge.instance_status === "pending")) {
                try {
                    await this.stopChallenge(id)
                } catch (error) {
                    this.error("challenge:finish", "failed to stop challenge instance during finish", error, { challengeId: id })
                }
            }

            if (!this.runtime) return
            const solvers = await this.runtime.listAll()
            const active = solvers.filter((solver) => solver.challengeId === id && (solver.status === "starting" || solver.status === "running" || solver.status === "stopping"))
            await Promise.allSettled(active.map((solver) => this.runtime!.stopSolver(solver.id)))
            // Record solvers stopped on completion for precise resume on revoke.
            if (active.length > 0) this.stoppedOnCompletion.set(id, active.map((solver) => solver.id))
            this.log("challenge:finish", "finished solved challenge cleanup", { challengeId: id, stoppedSolvers: active.map((solver) => solver.id) })
        } finally {
            this.finishingChallenges.delete(id)
        }
    }

    private async runPlannerOnce(source: string): Promise<PlannerTickOutcome> {
        const runtime = this.getRuntime()
        if (!runtime) return { ok: true, skipped: true }

        const settings = await this.config.getHostSettings()
        const sessionOpts = await this.config.resolvePromptSession(DEFAULT_PLANNER_PROMPT_NAME)
        if (!sessionOpts?.resourceLoader) {
            this.error("challenge:planner", "planner prompt missing or failed to resolve", undefined, { promptName: DEFAULT_PLANNER_PROMPT_NAME })
            return { ok: false, error: "planner prompt missing or failed to resolve" }
        }

        const snapshot = await this.buildPlannerSnapshot(source)
        if (snapshot.challenges.length === 0) {
            return { ok: true, skipped: true }
        }

        const previousRound = await this.readPreviousPlannerRound()
        const resourceLoader = wrapPlannerResourceLoader(sessionOpts.resourceLoader, snapshot, settings.planner.strategy, previousRound)
        await resourceLoader.reload()

        // Battle plan collector: seed from previous round (unchanged targets carry over),
        // planner updates incrementally via planner_set_plan, persisted at end.
        const battlePlan = new Map<string, PlannerBattlePlanEntry>()
        for (const entry of previousRound?.battlePlan ?? []) {
            battlePlan.set(entry.challengeId, entry)
        }
        // Keep only visible (incomplete) targets to avoid unbounded plan growth.
        const visibleChallengeIds = new Set(snapshot.challenges.map((challenge) => challenge.id))
        for (const id of [...battlePlan.keys()]) {
            if (!visibleChallengeIds.has(id)) battlePlan.delete(id)
        }

        const { session } = await createAgentSession({
            ...sessionOpts,
            resourceLoader,
            customTools: [...(sessionOpts.customTools ?? []), ...this.createPlannerTools(snapshot, battlePlan)],
            sessionManager: SessionManager.inMemory(),
        })

        let plannerMessage = ""
        let plannerStopReason = ""
        const plannerActions = new Map<string, string>()
        let plannerStreaming = false
        session.subscribe((event) => {
            if (event.type === "message_start") {
                plannerStreaming = false
            }
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                if (!plannerStreaming) {
                    process.stdout.write(`${formatChallengeLogScope("challenge:planner")} output\n`)
                    plannerStreaming = true
                }
                writePlannerTextChunk(event.assistantMessageEvent.delta)
            }
            if (event.type === "message_end" && event.message?.role === "assistant") {
                if (plannerStreaming) process.stdout.write("\n")
                plannerMessage = extractTextContent(event.message.content as Array<{ type: string; text?: string }> | undefined)
                plannerStopReason = event.message.stopReason ?? ""
                if (plannerStopReason === "error") {
                    this.error("challenge:planner", "planner LLM round errored", undefined, {
                        message: JSON.stringify(event.message).slice(0, 1500),
                    })
                }
            }
            if (event.type === "tool_execution_start") {
                plannerActions.set(event.toolCallId, `${event.toolName} ${JSON.stringify(event.args ?? {})}`)
            }
            if (event.type === "tool_execution_end" && event.isError) {
                this.error("challenge:planner", "planner tool failed", undefined, { toolName: event.toolName, result: event.result })
            }
        })

        try {
            await session.prompt("Begin this scheduling round.")
        } catch (error) {
            session.dispose()
            return { ok: false, error: extractErrorMessage(error) ?? "planner session failed" }
        }
        session.dispose()
        if (plannerStopReason === "error") {
            return { ok: false, error: "planner LLM round errored" }
        }
        const plannerText =
            plannerMessage ||
            [
                `unsolved=${snapshot.challenges.length}`,
                `activeChallenges=${snapshot.constraints.activeChallenges}`,
                `activeSolvers=${snapshot.constraints.activeSolvers}`,
                `availablePrompts=${snapshot.availableSolverPrompts.length}`,
            ].join(" ")
        const plannerHeader = `${formatChallengeLogScope("challenge:planner")} model output${plannerStopReason ? ` [${plannerStopReason}]` : ""}`
        console.log(`${plannerHeader}\n${plannerText}`)
        await this.writePreviousPlannerRound({
            generated_at: new Date().toISOString(),
            snapshot_digest: computePlannerSnapshotDigest(snapshot),
            actions: [...plannerActions.values()],
            summary: plannerText,
            battlePlan: [...battlePlan.values()],
        })
        return { ok: true }
    }

    private createPlannerTools(snapshot: PlannerSnapshot, battlePlan?: Map<string, PlannerBattlePlanEntry>): ToolDefinition[] {
        const emptyObject = Type.Object({})
        const challengeIds = snapshot.challenges.map((challenge) => challenge.id)
        const solverPromptNames = snapshot.availableSolverPrompts.map((prompt) => prompt.name)
        const activeSolverIds = snapshot.activeSolvers.map((solver) => solver.id)
        const snapshotChallenges = new Map(snapshot.challenges.map((challenge) => [challenge.id, challenge]))
        const snapshotSolvers = new Map(snapshot.activeSolvers.map((solver) => [solver.id, solver]))
        const challengeIdSchema = challengeIds.length > 0 ? Type.Union(challengeIds.map((id) => Type.Literal(id))) : Type.String({ description: "challenge id" })
        const promptNameSchema = solverPromptNames.length > 0 ? Type.Union(solverPromptNames.map((name) => Type.Literal(name))) : Type.String({ description: "solver prompt name" })
        const solverIdSchema = activeSolverIds.length > 0 ? Type.Union(activeSolverIds.map((id) => Type.Literal(id))) : Type.String({ description: "solver id" })

        return [
            defineTool({
                name: "planner_get_state",
                label: "Get Planner State",
                description: "Get current unsolved challenges, active challenge instances, solver allocation, attempts, submissions and stale indicators.",
                parameters: emptyObject,
                execute: async () => {
                    const snapshot = await this.buildPlannerSnapshot("challenge-planner:tool-state")
                    return {
                        content: [{ type: "text", text: formatPlannerSnapshotMarkdown(snapshot) }],
                        details: snapshot,
                    }
                },
            }),
            defineTool({
                name: "planner_start_challenge",
                label: "Start Challenge",
                description: "Start a challenge instance. Use when you want to occupy one of the 3 challenge-instance slots.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    this.log("challenge:planner-tool", "start challenge requested", { challengeId: params.challengeId })
                    const result = await this.startChallenge(params.challengeId)
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        details: result,
                    }
                },
            }),
            defineTool({
                name: "planner_stop_challenge",
                label: "Stop Challenge",
                description: "Stop a challenge instance and free one of the 3 challenge-instance slots.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    const challenge = snapshotChallenges.get(params.challengeId)
                    if (challenge && !challenge.stale) {
                        throw new Error(`challenge "${params.challengeId}" is not stale yet; stop is blocked before stale timeout`)
                    }
                    this.log("challenge:planner-tool", "stop challenge requested", { challengeId: params.challengeId })
                    const result = await this.stopChallenge(params.challengeId)
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        details: result,
                    }
                },
            }),
            defineTool({
                name: "planner_launch_solver",
                label: "Launch Solver",
                description:
                    "Launch a solver for a challenge. Always include solverHandoff: a concise solver-facing startup brief distilled from user strategy and current challenge state. Do not paste scheduling rules verbatim.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                    promptName: promptNameSchema,
                    solverHandoff: Type.String({
                        minLength: 1,
                        maxLength: SOLVER_HANDOFF_MAX_CHARS,
                        description: "Short solver-facing startup note. Include only solver-executable guidance relevant to this challenge.",
                    }),
                }),
                execute: async (_toolCallId, params) => {
                    const promptName = requireText(params.promptName, "promptName")
                    const solverHandoff = clipTaskText(requireText(params.solverHandoff, "solverHandoff"), SOLVER_HANDOFF_MAX_CHARS)
                    if ((await this.getChallenge(params.challengeId))?.testing_paused === true) {
                        throw new Error(`target "${params.challengeId}" testing is paused by operator`)
                    }
                    this.log("challenge:planner-tool", "launch solver requested", { challengeId: params.challengeId, promptName })
                    try {
                        const solver = await this.launchSolver(params.challengeId, promptName, { plannerHandoff: solverHandoff })
                        return {
                            content: [{ type: "text", text: JSON.stringify(solver, null, 2) }],
                            details: solver,
                        }
                    } catch (error) {
                        this.error("challenge:planner-tool", "launch solver failed", error, { challengeId: params.challengeId, promptName })
                        throw error
                    }
                },
            }),
            defineTool({
                name: "planner_stop_solver",
                label: "Stop Solver",
                description: "Stop a running solver to free a solver slot.",
                parameters: Type.Object({
                    solverId: solverIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    const runtime = this.getRuntime()
                    if (!runtime) throw new Error("runtime is not attached")
                    const solver = snapshotSolvers.get(params.solverId)
                    const challenge = solver?.challengeId ? snapshotChallenges.get(solver.challengeId) : undefined
                    if (challenge && !challenge.stale) {
                        throw new Error(`challenge "${challenge.id}" is not stale yet; solver stop is blocked before stale timeout`)
                    }
                    this.log("challenge:planner-tool", "stop solver requested", { solverId: params.solverId })
                    await runtime.stopSolver(params.solverId)
                    return {
                        content: [{ type: "text", text: `stopped solver ${params.solverId}` }],
                        details: { solverId: params.solverId },
                    }
                },
            }),
            defineTool({
                name: "planner_steer_solver",
                label: "Steer Solver",
                description:
                    "Re-task a RUNNING solver in-flight without restarting it — it keeps all its context and continues. Use this to redirect a solver based on battlefield results: e.g. 'creds for service X were obtained, pivot from recon to privilege escalation / lateral movement', or 'this route is a confirmed dead-end, switch to the upload surface'. Prefer this over stop+launch when the solver already has useful context. The message is delivered as a steering instruction to that specific solver.",
                parameters: Type.Object({
                    solverId: solverIdSchema,
                    message: Type.String({
                        minLength: 1,
                        maxLength: SOLVER_HANDOFF_MAX_CHARS,
                        description: "Solver-facing steering instruction: the new focus/direction and the concrete intel behind it (which cred, which surface, which dead-end to drop). Keep it tight and executable.",
                    }),
                }),
                execute: async (_toolCallId, params) => {
                    const runtime = this.getRuntime()
                    if (!runtime) throw new Error("runtime is not attached")
                    const solver = snapshotSolvers.get(params.solverId)
                    if (!solver) throw new Error(`solver "${params.solverId}" is not in the current snapshot`)
                    if (solver.status !== "running") {
                        throw new Error(`solver "${params.solverId}" is ${solver.status}, not running; can only steer a running solver`)
                    }
                    const message = clipTaskText(requireText(params.message, "message"), SOLVER_HANDOFF_MAX_CHARS)
                    this.log("challenge:planner-tool", "steer solver requested", { solverId: params.solverId, challengeId: solver.challengeId })
                    runtime.sendCommand(params.solverId, { type: "steer", message })
                    return {
                        content: [{ type: "text", text: `steered solver ${params.solverId}` }],
                        details: { solverId: params.solverId, challengeId: solver.challengeId },
                    }
                },
            }),
            defineTool({
                name: "planner_set_plan",
                label: "Set Battle Plan",
                description:
                    "Record or update your standing battle plan for a target — your current strategy/intent and the next checkpoint to verify. This persists ACROSS scheduling rounds: next round you'll see it under 'Carried-over battle plan', so you can continue a multi-step intent (e.g. 'creds obtained -> escalate -> then pivot to internal host') instead of re-deciding from scratch each tick. Update it whenever the situation on a target changes. Use it to stay a coherent commander across rounds, not just a reactive dispatcher.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                    strategy: Type.String({ minLength: 1, maxLength: 600, description: "Current overall approach/intent for this target." }),
                    nextCheckpoint: Type.Optional(Type.String({ maxLength: 300, description: "The specific milestone to re-check next round (e.g. 'confirm escalation solver got root')." })),
                }),
                execute: async (_toolCallId, params) => {
                    if (!battlePlan) {
                        return { content: [{ type: "text", text: "battle plan persistence is not available in this context" }], details: { stored: false } }
                    }
                    const entry: PlannerBattlePlanEntry = {
                        challengeId: params.challengeId,
                        strategy: clipTaskText(requireText(params.strategy, "strategy"), 600),
                        nextCheckpoint: params.nextCheckpoint?.trim() ? clipTaskText(params.nextCheckpoint.trim(), 300) : undefined,
                        updated_at: new Date().toISOString(),
                    }
                    battlePlan.set(params.challengeId, entry)
                    this.log("challenge:planner-tool", "battle plan updated", { challengeId: params.challengeId })
                    return {
                        content: [{ type: "text", text: `battle plan recorded for ${params.challengeId}` }],
                        details: { stored: true, ...entry },
                    }
                },
            }),
        ]
    }

    private async buildPlannerSnapshot(source: string): Promise<PlannerSnapshot> {
        const runtime = this.getRuntime()
        if (!runtime) throw new Error("runtime is not attached")

        const settings = await this.config.getHostSettings()
        const maxSolvers = clampInt(settings.runtime.maxSolvers ?? DEFAULT_MAX_SOLVERS, 0, 64)
        const staleTimeoutMs = clampInt(settings.planner.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS, 5 * 60 * 1000, 24 * 60 * 60 * 1000)
        const challenges = await this.listChallengesSafe(source)
        const unsolved = challenges.filter((item) => !computeChallengeCompleted(item) && item.testing_paused !== true)
        const solvers = await runtime.listAll()
        const activeSolvers = solvers.filter(isActiveSolver)
        const modelPrefs = await this.config.listModelPrefs()
        const solverPrompts = (await this.config.listAgentPrompts()).filter(
            (prompt) => prompt.meta.isSubagent !== true && prompt.meta.disabled !== true && prompt.deleted !== true && prompt.name !== DEFAULT_PLANNER_PROMPT_NAME,
        )
        const statsOverview = buildChallengeStatsOverview(
            await Promise.all(
                challenges.map(async (challenge) => {
                    const [statsResult, submissions] = await Promise.all([this.refreshStats(challenge.id), this.listSubmissionLogs(challenge.id)])
                    return {
                        challenge,
                        stats: statsResult.stats,
                        solver_stats: statsResult.solver_stats,
                        submissions,
                    }
                }),
            ),
        )
        const promptPerformanceByName = new Map(statsOverview.prompts.map((bucket) => [bucket.key, bucket]))

        const challengeItems = await Promise.all(
            unsolved.map(async (challenge) => {
                const [attempts, submissions, memory, ideas, stateAssets] = await Promise.all([
                    this.listAttemptLogs(challenge.id),
                    this.listSubmissionLogs(challenge.id),
                    this.listMemory(challenge.id).catch(() => [] as MemoryEntry[]),
                    this.listIdeas(challenge.id).catch(() => [] as IdeaRecord[]),
                    this.listStateAssets(challenge.id).catch(() => [] as StateAsset[]),
                ])
                return this.buildPlannerSnapshotItem(challenge, attempts, submissions, memory, ideas, stateAssets, activeSolvers, staleTimeoutMs)
            }),
        )
        // Backfill cross-target effort rank (horizon proxy): most attempts ranks #1.
        // research prefers relative ranking over raw counts to avoid misleading absolutes.
        const effortOrder = [...challengeItems].sort((a, b) => b.attemptCount - a.attemptCount)
        effortOrder.forEach((item, index) => {
            item.effortRank = index + 1
        })

        const kaliProvisionerAllowed = challengeItems.some(
            (item) => item.progressPhase === "foothold" || item.progressPhase === "breakthrough",
        )
        const plannerSolverPrompts = solverPrompts.filter(
            (prompt) => kaliProvisionerAllowed || prompt.name !== KALI_PROVISIONER_PROMPT_NAME,
        )

        // Per active solver focus line from its board,
        // so planner separates advancing vs idle and decides steer/withdraw.
        const solverFocusById = new Map<string, string>(
            await Promise.all(
                activeSolvers.map(async (solver): Promise<[string, string]> => {
                    const focus = await this.deriveSolverFocus(solver).catch(() => "(no board signal yet)")
                    return [solver.id, focus]
                }),
            ),
        )

        return {
            generatedAt: new Date().toISOString(),
            constraints: {
                maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
                maxSolvers,
                activeChallenges: challengeItems.filter((item) => item.instanceStatus === "running" || item.instanceStatus === "pending").length,
                activeSolvers: activeSolvers.length,
                staleTimeoutMs,
            },
            activeSolvers: activeSolvers.map((solver) => ({
                id: solver.id,
                challengeId: solver.challengeId,
                promptName: solver.promptName,
                status: solver.status,
                activeForMinutes: formatMinutesFromTimestamp(solver.createdAt) ?? 0,
                timeoutStatus: solver.createdAt + staleTimeoutMs <= Date.now() ? "stale" : "normal",
                currentFocus: solverFocusById.get(solver.id) ?? "(no board signal yet)",
            })),
            availableSolverPrompts: plannerSolverPrompts.map((prompt) => {
                const modelPrefId = typeof prompt.meta.model === "string" && prompt.meta.model.trim() ? prompt.meta.model.trim() : undefined
                const model = modelPrefId ? modelPrefs.find((entry) => entry.id === modelPrefId) : undefined
                const modelLabel = model ? `${model.provider}/${model.modelId}${model.name ? ` (${model.name})` : ""}` : modelPrefId
                const modelBucketKey = model ? `${model.provider}/${model.modelId}` : modelPrefId

                return {
                    name: prompt.name,
                    description: prompt.meta.description,
                    modelPrefId,
                    modelLabel,
                    promptPerformance: promptPerformanceByName.get(prompt.name),
                }
            }),
            challenges: challengeItems.sort((a, b) => {
                if (a.untouched !== b.untouched) return a.untouched ? -1 : 1
                if (a.difficulty !== b.difficulty) return a.difficulty.localeCompare(b.difficulty)
                return b.remainingScore - a.remainingScore
            }),
        }
    }

    private buildPlannerSnapshotItem(
        challenge: ChallengeInfoRecord,
        attempts: ChallengeAttemptLogRecord[],
        submissions: ChallengeSubmissionLogRecord[],
        memory: MemoryEntry[],
        ideas: IdeaRecord[],
        stateAssets: StateAsset[],
        activeSolvers: SolverInstance[],
        staleTimeoutMs: number,
    ): PlannerSnapshotChallenge {
        const challengeSolvers = activeSolvers.filter((solver) => solver.challengeId === challenge.id)
        const oldestActiveSolverAt = challengeSolvers.map((solver) => solver.createdAt).sort((a, b) => a - b)[0]
        const lastAttemptAt = attempts
            .map((item) => parseTimestamp(item.created_at))
            .filter((item): item is number => typeof item === "number")
            .sort((a, b) => b - a)[0]
        const lastCorrectSubmissionAt = submissions
            .filter(isRealFinding)
            .map((item) => parseTimestamp(item.created_at))
            .filter((item): item is number => typeof item === "number")
            .sort((a, b) => b - a)[0]

        const memoryFacts = buildPlannerMemoryFacts(memory)
        const failureBoundaries = buildPlannerFailureBoundaries(memory)
        const liveIdeas = buildPlannerLiveIdeas(ideas)
        const ideaStatusCounts = buildPlannerIdeaStatusCounts(ideas)
        const findings = buildPlannerFindings(submissions)
        const stateAssetLines = [...stateAssets]
            .sort((a, b) => {
                const rank = (kind: StateAsset["kind"]) => (kind === "credential" ? 3 : kind === "session" ? 2 : kind === "service" ? 1 : 0)
                return rank(b.kind) - rank(a.kind) || (parseTimestamp(b.updated_at) ?? 0) - (parseTimestamp(a.updated_at) ?? 0)
            })
            .slice(0, PLANNER_MEMORY_FACT_LIMIT)
            .map((asset) => formatStateAssetLine(asset))
        // "Real finding" count: CTF uses correct; engagement uses recorded and not verifier-rejected (isRealFinding).
        // Difficulty/phase/pruning depend on it — else engagement stays 0, successRate inverts, findings empty.
        const correctSubmissionCount = submissions.filter(isRealFinding).length
        // Foothold signal (precision first): credential/session assets > credential memory > text heuristic.
        const hasCredentialAsset = stateAssets.some((asset) => asset.kind === "credential" || asset.kind === "session")
        const hasCredentialMemory = memory.some((item) => item.kind === "credential")
        const footholdSignal = hasCredentialAsset || hasCredentialMemory || hasFootholdSignal(memoryFacts, liveIdeas)
        const progressPhase = derivePlannerProgressPhase({
            untouched: attempts.length === 0,
            correctSubmissionCount,
            verifiedIdeaCount: ideaStatusCounts.verified,
            hasFootholdSignal: footholdSignal,
        })

        // Difficulty-aware numeric signals.
        const successRate = laplaceSuccessRate(correctSubmissionCount, submissions.length)
        // Dead routes = failed ideas + failure memories (both; observer may write either).
        const failureMemoryCount = memory.filter((item) => item.kind === "failure").length
        const failedRouteCount = ideaStatusCounts.failed + failureMemoryCount
        const hasLiveHypothesis = ideaStatusCounts.testing > 0 || ideaStatusCounts.pending > 0 || ideaStatusCounts.verified > 0
        // >=3 dead routes, no foothold, no live hypothesis → target too hard for current approach; prune.
        const pruneRecommended = failedRouteCount >= PLANNER_PRUNE_FAILED_ROUTE_THRESHOLD && !footholdSignal && !hasLiveHypothesis && correctSubmissionCount === 0

        return {
            id: challenge.id,
            title: challenge.title,
            difficulty: challenge.difficulty,
            level: challenge.level,
            totalScore: challenge.total_score,
            gotScore: challenge.total_got_score,
            flagCount: challenge.flag_count,
            gotFlags: challenge.flag_got_count,
            remainingFlags: Math.max(challenge.flag_count - challenge.flag_got_count, 0),
            remainingScore: Math.max(challenge.total_score - challenge.total_got_score, 0),
            hintViewed: challenge.hint_viewed,
            instanceStatus: challenge.instance_status,
            entrypoint: challenge.entrypoint,
            attemptCount: attempts.length,
            submissionCount: submissions.length,
            correctSubmissionCount,
            untouched: attempts.length === 0,
            stale: Boolean(oldestActiveSolverAt && Date.now() - oldestActiveSolverAt >= staleTimeoutMs && !submissions.some(isRealFinding)),
            activeSolverCount: challengeSolvers.length,
            activeSolverIds: challengeSolvers.map((solver) => solver.id),
            activeForMinutes: formatMinutesFromTimestamp(oldestActiveSolverAt),
            minutesSinceLastAttempt: formatMinutesFromTimestamp(lastAttemptAt),
            minutesSinceLastCorrectSubmission: formatMinutesFromTimestamp(lastCorrectSubmissionAt),
            memoryFacts,
            failureBoundaries,
            liveIdeas,
            ideaStatusCounts,
            findings,
            progressPhase,
            stateAssets: stateAssetLines,
            successRate,
            failedRouteCount,
            effortRank: undefined, // filled by buildPlannerSnapshot
            pruneRecommended,
            intelNotesExcerpt: clipTaskText(challenge.intel_notes?.trim() || "", PLANNER_INTEL_MAX_CHARS) || undefined,
        }
    }

    private async buildSolverTask(challenge: ChallengeInfoRecord, options?: LaunchSolverOptions): Promise<string> {
        if (!challenge.entrypoint || challenge.entrypoint.length === 0) {
            throw new Error(`challenge ${challenge.id} is missing entrypoint`)
        }
        // Engagement-only path; CTF challenge copy removed.
        return this.buildEngagementSolverTask(challenge, options)
    }

    /**
     * Derive one-line "what am I doing now" from solver board for planner Active Solvers table.
     * Priority: testing hypothesis > pending > latest memory.
     * None → no board signal yet (just started or idle); planner decides steer/withdraw.
     */
    private async deriveSolverFocus(solver: SolverInstance): Promise<string> {
        if (solver.status !== "running") return `(${solver.status})`
        const board = await readSolverBoardSnapshot(solverSessionDir(solver.id)).catch(() => ({ memory: [], ideas: [] }))
        const testing = board.ideas.find((idea) => idea.status === "testing")
        if (testing) return `testing: ${clipTaskText(testing.content, 120)}`
        const pending = board.ideas.find((idea) => idea.status === "pending")
        if (pending) return `pending: ${clipTaskText(pending.content, 120)}`
        const latestMemory = [...board.memory].sort((a, b) => (parseTimestamp(b.updated_at) ?? 0) - (parseTimestamp(a.updated_at) ?? 0))[0]
        if (latestMemory) return `latest note [${latestMemory.kind}]: ${clipTaskText(latestMemory.content, 120)}`
        return "(no board signal yet — just started or spinning)"
    }

    /**
     * Engagement-mode solver task brief:
     * Authorized exercise framing, no CTF/flag; inject scope and rules of engagement.
     */
    private async buildEngagementSolverTask(challenge: ChallengeInfoRecord, options?: LaunchSolverOptions): Promise<string> {
        const entrypoint = (challenge.entrypoint ?? []).map((item) => `- ${item}`).join("\n")
        const [memoryItems, ideaItems, submissionItems, stateAssets] = await Promise.all([
            this.listMemory(challenge.id),
            this.listIdeas(challenge.id),
            this.listSubmissionLogs(challenge.id),
            this.listStateAssets(challenge.id).catch(() => [] as StateAsset[]),
        ])
        const plannerHandoff = options?.plannerHandoff?.trim()

        // Inject scope as target context (your operational target list). Scope safety is enforced
        // by the execution layer; we do NOT ask the model to self-restrain in the brief — that only
        // makes it hesitant and second-guess legitimate actions.
        let scopeLines: string[] = []
        try {
            const { scope } = await loadEngagementScope()
            scopeLines = [
                `Engagement: ${scope.engagement}`,
                `Authorized targets (allowed_targets):`,
                ...scope.allowed_targets.map((target) => `- ${target}`),
                ...((scope.out_of_scope?.length ?? 0) > 0
                    ? [`Out of scope (out_of_scope — auto-blocked by the execution layer, no need to worry about it):`, ...(scope.out_of_scope ?? []).map((target) => `- ${target}`)]
                    : []),
                ...(scope.rules_of_engagement ? [`Rules of engagement: ${scope.rules_of_engagement}`] : []),
            ]
        } catch {
            scopeLines = [`(No scope file loaded; just press the target given in this task's entrypoint at full force — out-of-scope is handled by the execution layer.)`]
        }

        return [
            `You are an authorized penetration-test operator on an authorized engagement (e.g. a red-team / HVV exercise). You have full authorization over the targets below — operate at full force using the most effective approach. Do not repeatedly second-guess "am I in scope"; scope boundaries are enforced by the execution layer.`,
            ``,
            ...scopeLines,
            ``,
            ...(plannerHandoff ? [`Startup brief:`, plannerHandoff, ``] : []),
            ...(challenge.intel_notes?.trim()
                ? [
                      `Operator-provided initial intel (authoritative pre-brief — not solver memory; use get_target_intel to re-read):`,
                      challenge.intel_notes.trim(),
                      ``,
                  ]
                : []),
            `Current Memory summary:`,
            formatSolverMemorySection(memoryItems),
            ``,
            `Current Ideas summary:`,
            formatSolverIdeasSection(ideaItems),
            ``,
            `Current Findings summary:`,
            formatSolverSubmissionsSection(submissionItems),
            ``,
            `Shared battlefield state (hosts/services/credentials/sessions already obtained by the team — REUSE, do not re-discover):`,
            formatSolverStateAssetsSection(stateAssets),
            ``,
            `Requirements:`,
            `- The moment you verify a vuln / obtain control / get high-value evidence, record it with report_finding (proof + route writeup).`,
            `- When you achieve the primary objective (confirmed RCE / interactive shell / the core goal stated above), call report_finding with objective_achieved=true to wind down this target. Only set it true for a real primary-objective achievement — never for partial progress or unverified leads.`,
            `- Reference credential-type evidence via evidence_refs; do not pile plaintext into shared state.`,
            `- Before deciding a direction, check the Findings summary to avoid repeating already-verified entries/routes.`,
            `- When context grows long or you suspect you forgot a verified conclusion, check memory_list / idea_list / idea_search first.`,
            `- Only write to memory facts/evidence/failure-boundaries worth keeping across rounds.`,
            `- The Kali arsenal box is your weapon, not a target. Only attack the target entrypoint below — never the arsenal box, localhost, or the engine's own control plane.`,
            ``,
            `Target id: ${challenge.title || challenge.id}`,
            ``,
            `Target entrypoint:`,
            entrypoint,
            ``,
            `Target description:`,
            challenge.description || "(none)",
        ].join("\n")
    }

    private async syncChallenge(challengeId: string, source: string): Promise<ChallengeInfoRecord | undefined> {
        const result = await this.listChallenges(source)
        return result.local.find((challenge) => challenge.id === challengeId)
    }
}
