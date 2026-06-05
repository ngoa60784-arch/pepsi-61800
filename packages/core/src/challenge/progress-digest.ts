import type { AttackTimelineEvent } from "./attack-timeline"
import type { IdeaRecord, MemoryEntry, IdeaStatus, MemoryKind } from "./memory"
import type { ChallengeInfoRecord, ChallengeSubmissionLogRecord } from "./store"

export type PlannerProgressPhase = "untouched" | "recon" | "foothold" | "breakthrough"

export interface ProgressDigestOverviewInput {
    progressPhase: PlannerProgressPhase
    instanceStatus: string
    activeSolverCount: number
    findingCount: number
    failedRouteCount: number
    successRate: number
    pruneRecommended: boolean
    stateAssets: string[]
    activeSolvers: Array<{ id: string; status: string; currentFocus: string }>
}
import { isRealFinding } from "./submission-utils"

const IDEA_LIMIT_PER_COLUMN = 24
const MEMORY_LIMIT = 16
const FINDING_LIMIT = 12
const RECENT_EVENT_LIMIT = 12
const CONTENT_CLIP = 220

export interface ProgressDigestSolverRow {
    id: string
    status: string
    promptName?: string
    currentFocus: string
}

export interface ProgressDigestIdeaCard {
    id: string
    content: string
    result: string
    status: IdeaStatus
    updated_at: string
}

export interface ProgressDigestMemoryItem {
    id: string
    kind: MemoryKind
    content: string
    updated_at: string
}

export interface ProgressDigestFinding {
    id: string
    title: string
    verification_status?: ChallengeSubmissionLogRecord["verification_status"]
    correct: boolean
    created_at: string
    hasWriteup: boolean
}

export interface ProgressDigestRecentEvent {
    id: string
    timestamp: number
    lane: AttackTimelineEvent["lane"]
    kind: AttackTimelineEvent["kind"]
    title: string
    summary: string
    solverId?: string
}

export interface ProgressDigestBattlePlan {
    challengeId: string
    strategy: string
    nextCheckpoint?: string
    updated_at: string
}

export interface ChallengeProgressDigest {
    challengeId: string
    updatedAt: string
    progressPhase: PlannerProgressPhase
    phaseLabel: string
    instanceStatus: string
    testingPaused: boolean
    objectiveAchieved: boolean
    activeSolverCount: number
    findingCount: number
    submissionCount: number
    failedRouteCount: number
    successRate: number
    pruneRecommended: boolean
    ideaCounts: Record<IdeaStatus, number>
    solvers: ProgressDigestSolverRow[]
    ideasByStatus: Record<IdeaStatus, ProgressDigestIdeaCard[]>
    memoryFacts: ProgressDigestMemoryItem[]
    memoryFailures: ProgressDigestMemoryItem[]
    memoryCredentials: ProgressDigestMemoryItem[]
    stateAssets: string[]
    findings: ProgressDigestFinding[]
    battlePlan?: ProgressDigestBattlePlan
    plannerSummary?: string
    recentEvents: ProgressDigestRecentEvent[]
}

export const PROGRESS_PHASE_LABELS: Record<PlannerProgressPhase, string> = {
    untouched: "未接触",
    recon: "侦察中",
    foothold: "已有立足点",
    breakthrough: "突破 / 有成果",
}

export interface BuildProgressDigestInput {
    challenge: ChallengeInfoRecord
    overview: ProgressDigestOverviewInput
    ideas: IdeaRecord[]
    memory: MemoryEntry[]
    submissions: ChallengeSubmissionLogRecord[]
    solverPromptById: Record<string, string | undefined>
    battlePlan?: ProgressDigestBattlePlan
    plannerSummary?: string
    recentEvents: AttackTimelineEvent[]
}

function clipText(value: string, max = CONTENT_CLIP): string {
    const text = value.replace(/\s+/g, " ").trim()
    if (text.length <= max) return text
    return `${text.slice(0, max)}…`
}

function sortByUpdatedDesc<T extends { updated_at: string }>(items: T[]): T[] {
    return [...items].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
}

function buildIdeaCounts(ideas: IdeaRecord[]): Record<IdeaStatus, number> {
    const counts: Record<IdeaStatus, number> = { pending: 0, testing: 0, verified: 0, failed: 0, skipped: 0 }
    for (const idea of ideas) counts[idea.status] += 1
    return counts
}

function buildIdeasByStatus(ideas: IdeaRecord[]): Record<IdeaStatus, ProgressDigestIdeaCard[]> {
    const sorted = sortByUpdatedDesc(ideas)
    const buckets: Record<IdeaStatus, ProgressDigestIdeaCard[]> = {
        pending: [],
        testing: [],
        verified: [],
        failed: [],
        skipped: [],
    }
    for (const idea of sorted) {
        const bucket = buckets[idea.status]
        if (bucket.length >= IDEA_LIMIT_PER_COLUMN) continue
        bucket.push({
            id: idea.id,
            content: clipText(idea.content),
            result: clipText(idea.result, 120),
            status: idea.status,
            updated_at: idea.updated_at,
        })
    }
    return buckets
}

function mapMemoryItems(items: MemoryEntry[]): ProgressDigestMemoryItem[] {
    return sortByUpdatedDesc(items)
        .slice(0, MEMORY_LIMIT)
        .map((item) => ({
            id: item.id,
            kind: item.kind,
            content: clipText(item.content),
            updated_at: item.updated_at,
        }))
}

function buildFindings(submissions: ChallengeSubmissionLogRecord[]): ProgressDigestFinding[] {
    return [...submissions]
        .filter(isRealFinding)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, FINDING_LIMIT)
        .map((item) => ({
            id: item.id,
            title: clipText(item.writeup?.trim() || item.flag || item.message || "finding", 160),
            verification_status: item.verification_status,
            correct: item.correct,
            created_at: item.created_at,
            hasWriteup: Boolean(item.writeup?.trim()),
        }))
}

function mapRecentEvents(events: AttackTimelineEvent[] | undefined): ProgressDigestRecentEvent[] {
    return [...(events ?? [])]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, RECENT_EVENT_LIMIT)
        .map((event) => ({
            id: event.id,
            timestamp: event.timestamp,
            lane: event.lane,
            kind: event.kind,
            title: event.title,
            summary: clipText(event.summary, 140),
            solverId: event.solverId,
        }))
}

export function buildChallengeProgressDigest(input: BuildProgressDigestInput): ChallengeProgressDigest {
    const { challenge, overview, ideas, memory, submissions, solverPromptById, battlePlan, plannerSummary, recentEvents } = input

    const memoryFacts = mapMemoryItems(memory.filter((item) => item.kind === "fact" || item.kind === "evidence" || item.kind === "note"))
    const memoryFailures = mapMemoryItems(memory.filter((item) => item.kind === "failure"))
    const memoryCredentials = mapMemoryItems(memory.filter((item) => item.kind === "credential"))

    const solvers: ProgressDigestSolverRow[] = overview.activeSolvers.map((solver) => ({
        id: solver.id,
        status: solver.status,
        promptName: solverPromptById[solver.id],
        currentFocus: clipText(solver.currentFocus, 180),
    }))

    return {
        challengeId: challenge.id,
        updatedAt: new Date().toISOString(),
        progressPhase: overview.progressPhase,
        phaseLabel: PROGRESS_PHASE_LABELS[overview.progressPhase],
        instanceStatus: overview.instanceStatus,
        testingPaused: challenge.testing_paused === true,
        objectiveAchieved: challenge.objective_achieved === true,
        activeSolverCount: overview.activeSolverCount,
        findingCount: overview.findingCount,
        submissionCount: submissions.length,
        failedRouteCount: overview.failedRouteCount,
        successRate: overview.successRate,
        pruneRecommended: overview.pruneRecommended,
        ideaCounts: buildIdeaCounts(ideas),
        solvers,
        ideasByStatus: buildIdeasByStatus(ideas),
        memoryFacts,
        memoryFailures,
        memoryCredentials,
        stateAssets: overview.stateAssets,
        findings: buildFindings(submissions),
        battlePlan,
        plannerSummary: plannerSummary?.trim() ? clipText(plannerSummary, 400) : undefined,
        recentEvents: mapRecentEvents(recentEvents),
    }
}
