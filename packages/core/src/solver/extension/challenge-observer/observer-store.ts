import { mkdir, readdir, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { ObserverReviewPayload, ObserverRoundPayload, ObserverToolLog } from "./types"

const OBSERVER_RUNTIME_STATE_FILE = "state.json"
const OBSERVER_REVIEW_QUEUE_DIRNAME = "review-queue"
const OBSERVER_ROUNDS_DIRNAME = "rounds"

// 一条 review 最多重试几次后放弃（避免毒丸消息无限重试卡住队首）。
const MAX_OBSERVER_REVIEW_ATTEMPTS = 3

// 进程内串行化 observer state 写入的链尾（见 updateObserverState）。
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
    // 串行化所有 update：observer 的 tool_execution_start/end、message_end 等钩子在同一 turn
    // 并发多个 tool call 时会并发触发，无锁的 read-modify-write 会丢更新（后写覆盖前写，
    // 丢掉 tool_args_by_call_id / current_round_tool_logs 条目）。用链式 promise 把每次
    // update 排到上一次之后，保证读到的是最新落盘状态。
    const run = observerStateWriteChain.then(async () => {
        const currentState = await loadObserverState()
        const { nextState, result } = mutate(currentState)
        await Bun.write(resolveObserverRuntimeStatePath(), `${JSON.stringify(nextState, null, 2)}\n`)
        return result
    })
    // 链尾吞掉异常，避免一次失败卡死后续所有 update；调用方仍能拿到本次的 reject。
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
    /** 队列文件路径，处理完后用 completeObserverReview / failObserverReview 出队或重试。 */
    filePath: string
    /** 这条 review 已失败重试的次数（从文件名解析，新入队为 0）。 */
    attempts: number
}

// 文件名里嵌入重试次数：`<ts>-<uuid>.aN.json`。保留时间戳前缀，FIFO 顺序不受影响。
function parseObserverReviewAttempts(fileName: string): number {
    const matched = fileName.match(/\.a(\d+)\.json$/)
    return matched ? Number(matched[1]) : 0
}

/**
 * 读取队首 review 但**不删除**——只有 completeObserverReview 才真正出队。
 * 这样 runReview 失败时不会像之前那样静默丢失整条 review（先 unlink 再返回 = at-most-once）。
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

/** review 处理成功 → 出队（删除队列文件）。删除失败不抛（下次 takeNext 会再取到，幂等）。 */
export async function completeObserverReview(filePath: string): Promise<void> {
    await unlink(filePath).catch(() => {})
}

/**
 * review 处理失败 → 未达重试上限则保留并递增 attempts（下次再试），达到上限则丢弃。
 * 返回 dropped=true 表示已彻底放弃这条 review（调用方应记录明确日志，而非静默）。
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
