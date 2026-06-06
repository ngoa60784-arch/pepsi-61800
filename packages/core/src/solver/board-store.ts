import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { AddIdeaInput, AddIdeaResult, AddMemoryInput, IdeaRecord, IdeaStatus, MemoryEntry, MemoryKind, UpdateIdeaInput } from "../challenge/memory"
import {
    addChallengeIdea,
    appendChallengeMemory,
    deleteChallengeMemory,
    listChallengeIdeas,
    listChallengeMemory,
    searchChallengeIdeas,
    updateChallengeIdea,
    updateChallengeMemory,
} from "../challenge/memory"

const SOLVER_BOARD_NAMESPACE = "board"

function requireSessionDir(sessionDir?: string): string {
    const value = sessionDir?.trim() || process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!value) {
        throw new Error("TCH_SOLVER_SESSION_DIR is required for solver board storage")
    }
    return value
}

export function solverBoardRootDir(sessionDir?: string): string {
    return join(requireSessionDir(sessionDir), ".observer")
}

export async function appendSolverBoardMemory(
    input: Omit<AddMemoryInput, "challengeId">,
    sessionDir?: string,
): Promise<MemoryEntry> {
    return appendChallengeMemory(solverBoardRootDir(sessionDir), {
        ...input,
        challengeId: SOLVER_BOARD_NAMESPACE,
    })
}

export async function listSolverBoardMemory(sessionDir?: string): Promise<MemoryEntry[]> {
    return listChallengeMemory(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE)
}

export async function updateSolverBoardMemory(
    entryIdOrPrefix: string,
    patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string },
    sessionDir?: string,
): Promise<MemoryEntry> {
    return updateChallengeMemory(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, entryIdOrPrefix, patch)
}

export async function deleteSolverBoardMemory(entryIdOrPrefix: string, sessionDir?: string): Promise<MemoryEntry> {
    return deleteChallengeMemory(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, entryIdOrPrefix)
}

export async function listSolverBoardIdeas(sessionDir?: string): Promise<IdeaRecord[]> {
    return listChallengeIdeas(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE)
}

export async function searchSolverBoardIdeas(query: string, sessionDir?: string): Promise<IdeaRecord[]> {
    return searchChallengeIdeas(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, query)
}

export async function addSolverBoardIdea(input: AddIdeaInput, sessionDir?: string): Promise<AddIdeaResult> {
    return addChallengeIdea(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, input)
}

export async function updateSolverBoardIdea(ideaIdOrPrefix: string, patch: UpdateIdeaInput, sessionDir?: string): Promise<IdeaRecord> {
    return updateChallengeIdea(solverBoardRootDir(sessionDir), SOLVER_BOARD_NAMESPACE, ideaIdOrPrefix, patch)
}

export async function readSolverBoardSnapshot(sessionDir?: string): Promise<{ memory: MemoryEntry[]; ideas: IdeaRecord[] }> {
    const [memory, ideas] = await Promise.all([listSolverBoardMemory(sessionDir), listSolverBoardIdeas(sessionDir)])
    return { memory, ideas }
}

export interface SolverSteerFocus {
    message: string
    source: string
    updated_at: string
}

function steerFocusPath(sessionDir?: string): string {
    return join(solverBoardRootDir(sessionDir), "steer-focus.json")
}

function clipFocusText(value: string, maxChars: number): string {
    const text = value.replaceAll("\n", " ").trim()
    if (!text) return ""
    if (text.length <= maxChars) return text
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function parseFocusTimestamp(value?: string): number {
    if (!value?.trim()) return 0
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
}

function pickMostRecentIdea(ideas: IdeaRecord[], status: IdeaStatus): IdeaRecord | undefined {
    return ideas
        .filter((idea) => idea.status === status)
        .sort((a, b) => parseFocusTimestamp(b.updated_at) - parseFocusTimestamp(a.updated_at))[0]
}

/** Persist the latest steering directive so planner/commander snapshots stay aligned with runtime tasking. */
export async function recordSolverSteerFocus(
    input: { message: string; source: string },
    sessionDir?: string,
): Promise<SolverSteerFocus> {
    const entry: SolverSteerFocus = {
        message: input.message.trim(),
        source: input.source.trim(),
        updated_at: new Date().toISOString(),
    }
    await mkdir(solverBoardRootDir(sessionDir), { recursive: true })
    await Bun.write(steerFocusPath(sessionDir), JSON.stringify(entry, null, 2))
    return entry
}

export async function readSolverSteerFocus(sessionDir?: string): Promise<SolverSteerFocus | undefined> {
    const file = Bun.file(steerFocusPath(sessionDir))
    if (!(await file.exists())) return undefined
    try {
        const parsed = (await file.json()) as Partial<SolverSteerFocus>
        const message = typeof parsed.message === "string" ? parsed.message.trim() : ""
        if (!message) return undefined
        return {
            message,
            source: typeof parsed.source === "string" && parsed.source.trim() ? parsed.source.trim() : "steer",
            updated_at: typeof parsed.updated_at === "string" && parsed.updated_at.trim() ? parsed.updated_at : new Date(0).toISOString(),
        }
    } catch {
        return undefined
    }
}

/**
 * Derive one-line solver focus for planner/commander tables.
 * Priority: fresh steer directive > active testing progress (result text) > pending > latest memory.
 */
export function resolveSolverFocusSignal(input: {
    steer?: SolverSteerFocus
    ideas: IdeaRecord[]
    memory: MemoryEntry[]
    maxChars?: number
}): string {
    const maxChars = input.maxChars ?? 140
    const steer = input.steer
    const testing = pickMostRecentIdea(input.ideas, "testing")
    const steerAt = steer ? parseFocusTimestamp(steer.updated_at) : 0
    const testingAt = testing ? parseFocusTimestamp(testing.updated_at) : 0

    if (steer && steerAt >= testingAt) {
        return `steered: ${clipFocusText(steer.message, maxChars)}`
    }
    if (testing) {
        const detail = testing.result.trim() || testing.content
        return `testing: ${clipFocusText(detail, maxChars)}`
    }
    const pending = pickMostRecentIdea(input.ideas, "pending")
    if (pending) return `pending: ${clipFocusText(pending.content, maxChars)}`
    const latestMemory = [...input.memory].sort((a, b) => parseFocusTimestamp(b.updated_at) - parseFocusTimestamp(a.updated_at))[0]
    if (latestMemory) return `latest note [${latestMemory.kind}]: ${clipFocusText(latestMemory.content, maxChars)}`
    return "(no board signal yet — just started or spinning)"
}

export async function seedSolverBoardSnapshot(
    input: {
        memory: MemoryEntry[]
        ideas: IdeaRecord[]
    },
    sessionDir?: string,
): Promise<void> {
    const existing = await readSolverBoardSnapshot(sessionDir)
    if (existing.memory.length > 0 || existing.ideas.length > 0) return

    for (const entry of input.memory) {
        await appendSolverBoardMemory(
            {
                kind: entry.kind,
                content: entry.content,
                refs: entry.refs,
                source: entry.source,
            },
            sessionDir,
        )
    }

    for (const idea of input.ideas) {
        await addSolverBoardIdea(
            {
                content: idea.content,
                status: idea.status,
                result: idea.result,
            },
            sessionDir,
        )
    }
}
