import { mkdir, readdir, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { ObserverReviewPayload, ObserverRoundPayload, ObserverToolLog } from "./types"

const OBSERVER_RUNTIME_STATE_FILE = "state.json"
const OBSERVER_REVIEW_QUEUE_DIRNAME = "review-queue"
const OBSERVER_ROUNDS_DIRNAME = "rounds"

// Max review retries before drop (avoid poison pill blocking queue head).
const MAX_OBSERVER_REVIEW_ATTEMPTS = 3

// In-process chain tail serializing observer state writes (see updateObserverState).
let observerStateWriteChain: Promise<void> = Promise.resolve()

export interface ObserverRuntimeState {
    round: number
    current_round_tool_logs: ObserverToolLog[]
    tool_args_by_call_id: Record<string, string>
    force_review_reason?: ObserverReviewPayload["reason"]
    last_reminder?: {
        sent_at: string
        round: number
        message_fingerprint: string
        activity_fingerprint: string
    }
}

function resolveObserverRootDir(): string {
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) throw new Error("TCH_SOLVER_SESSION_DIR is required for observer runtime state")
    return join(solverSessionDir, ".observer")
}

function resolveObserverRuntimeStatePath(): string {
    return join(resolveObserverRootDir(), OBSERVER_RUNTIME_STATE_FILE)
}

function resolveObserverReviewQueueDir(): string {
    return join(resolveObserverRootDir(), OBSERVER_REVIEW_QUEUE_DIRNAME)
}

function resolveObserverRoundsDir(): string {
    return join(resolveObserverRootDir(), OBSERVER_ROUNDS_DIRNAME)
}

function createDefaultObserverRuntimeState(): ObserverRuntimeState {
    return {
        round: 0,
        current_round_tool_logs: [],
        tool_args_by_call_id: {},
    }
}

async function ensureObserverRuntimeDir(): Promise<void> {
    await mkdir(resolveObserverRootDir(), { recursive: true })
}

async function ensureObserverReviewQueueDir(): Promise<string> {
    const dir = resolveObserverReviewQueueDir()
    await mkdir(dir, { recursive: true })
    return dir
}

async function ensureObserverRoundsDir(): Promise<string> {
    const dir = resolveObserverRoundsDir()
    await mkdir(dir, { recursive: true })
    return dir
}

function formatRoundFileName(round: number): string {
    return `${String(round).padStart(6, "0")}.json`
}

export async function loadObserverState(): Promise<ObserverRuntimeState> {
    await ensureObserverRuntimeDir()
    const file = Bun.file(resolveObserverRuntimeStatePath())
    if (!(await file.exists())) {
        return createDefaultObserverRuntimeState()
    }
    return file.json() as Promise<ObserverRuntimeState>
}

export async function updateObserverState<T>(
    mutate: (state: ObserverRuntimeState) => { nextState: ObserverRuntimeState; result: T },
): Promise<T> {
    // Serialize updates: observer hooks (tool_execution_start/end, message_end) fire concurrently in one turn
    // Unlocked read-modify-write loses updates (later write wins,
    // dropping tool_args_by_call_id / current_round_tool_logs). Chain promises so each
    // update runs after the previous with latest persisted state.
    const run = observerStateWriteChain.then(async () => {
        const currentState = await loadObserverState()
        const { nextState, result } = mutate(currentState)
        await Bun.write(resolveObserverRuntimeStatePath(), `${JSON.stringify(nextState, null, 2)}\n`)
        return result
    })
    // Chain tail swallows errors so one failure does not block updates; caller still gets reject.
    observerStateWriteChain = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

export async function enqueueObserverReview(payload: ObserverReviewPayload): Promise<void> {
    const dir = await ensureObserverReviewQueueDir()
    const filePath = join(dir, `${Date.now()}-${crypto.randomUUID()}.json`)
    await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

export interface PendingObserverReview {
    payload: ObserverReviewPayload
    /** Queue file path; completeObserverReview / failObserverReview dequeue or retry. */
    filePath: string
    /** Failed retry count for this review (from filename; 0 when newly enqueued). */
    attempts: number
}

// Retry count embedded in filename: `<ts>-<uuid>.aN.json`. Timestamp prefix preserves FIFO.
function parseObserverReviewAttempts(fileName: string): number {
    const matched = fileName.match(/\.a(\d+)\.json$/)
    return matched ? Number(matched[1]) : 0
}

/**
 * Peek head review without deleting — only completeObserverReview dequeues.
 * runReview failure no longer silently drops review (unlink-before-return was at-most-once).
 */
export async function takeNextObserverReview(): Promise<PendingObserverReview | undefined> {
    const dir = await ensureObserverReviewQueueDir()
    const fileNames = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort((left, right) => left.localeCompare(right))
    const nextFile = fileNames.at(0)
    if (!nextFile) return undefined

    const filePath = join(dir, nextFile)
    const payload = (await Bun.file(filePath).json()) as ObserverReviewPayload
    return { payload, filePath, attempts: parseObserverReviewAttempts(nextFile) }
}

/** Review succeeded → dequeue (delete queue file). Unlink failure is non-fatal (idempotent retry). */
export async function completeObserverReview(filePath: string): Promise<void> {
    await unlink(filePath).catch(() => {})
}

/**
 * Review failed → keep and bump attempts if under cap, else drop.
 * dropped=true means review abandoned (caller should log clearly, not silently).
 */
export async function failObserverReview(filePath: string, attempts: number): Promise<{ dropped: boolean }> {
    const nextAttempts = attempts + 1
    if (nextAttempts >= MAX_OBSERVER_REVIEW_ATTEMPTS) {
        await unlink(filePath).catch(() => {})
        return { dropped: true }
    }
    const dir = dirname(filePath)
    const stem = basename(filePath).replace(/\.a\d+\.json$/, "").replace(/\.json$/, "")
    const nextPath = join(dir, `${stem}.a${nextAttempts}.json`)
    await rename(filePath, nextPath).catch(() => {})
    return { dropped: false }
}

export async function loadLatestObserverRoundNumber(): Promise<number> {
    const rounds = await loadRecentObserverRounds(1)
    return rounds.at(-1)?.round ?? 0
}

export async function persistObserverRound(record: ObserverRoundPayload): Promise<void> {
    const dir = await ensureObserverRoundsDir()
    const filePath = join(dir, formatRoundFileName(record.round))
    await Bun.write(filePath, `${JSON.stringify(record, null, 2)}\n`)
}

export async function loadRecentObserverRounds(limit: number): Promise<ObserverRoundPayload[]> {
    if (limit <= 0) return []

    const dir = await ensureObserverRoundsDir()
    const entries = await readdir(dir)
    const fileNames = entries
        .filter((name) => name.endsWith(".json"))
        .sort((left, right) => left.localeCompare(right))
        .slice(-limit)

    const rounds = await Promise.all(
        fileNames.map(async (fileName) => {
            const filePath = join(dir, fileName)
            return Bun.file(filePath).json() as Promise<ObserverRoundPayload>
        }),
    )

    return rounds.sort((left, right) => left.round - right.round)
}
