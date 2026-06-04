export interface ChallengeApiEnvelope<T> {
    code: number
    message: string
    data: T
}

export interface ChallengeApiChallenge {
    title: string
    code: string
    difficulty: string
    description: string
    level: number
    total_score: number
    total_got_score: number
    flag_count: number
    flag_got_count: number
    hint_viewed: boolean
    instance_status: string
    entrypoint: string[] | null
}

export interface ChallengeApiListData {
    current_level: number
    total_challenges: number
    solved_challenges: number
    challenges: ChallengeApiChallenge[]
}

export interface ChallengeApiSubmitData {
    correct: boolean
    message: string
    flag_count: number
    flag_got_count: number
}

export interface ChallengeApiHintData {
    code: string
    hint_content: string | null
}

export type ChallengeApiStartData = string[] | { already_completed: boolean }

const CHALLENGE_API_MAX_REQUESTS_PER_SECOND = 3
const CHALLENGE_API_REQUEST_INTERVAL_MS = Math.ceil(1000 / CHALLENGE_API_MAX_REQUESTS_PER_SECOND)

export type ChallengeApiMockState = {
    listChallenges: () => Promise<ChallengeApiListData>
    startChallenge: (code: string) => Promise<ChallengeApiStartData>
    stopChallenge: (code: string) => Promise<null>
    submitFlag: (code: string, flag: string) => Promise<ChallengeApiSubmitData>
    getHint: (code: string) => Promise<ChallengeApiHintData>
}

function requireText(value: string | undefined, fieldName: string): string {
    const text = value?.trim() ?? ""
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

/** Local in-process challenge API (engagement / local target store). Remote CTF scoring was removed. */
export class ChallengeApiClient {
    private readonly mockState: ChallengeApiMockState
    private nextRequestAt = 0
    private schedule = Promise.resolve()

    private constructor(mockState: ChallengeApiMockState) {
        this.mockState = mockState
    }

    static createMock(mockState: ChallengeApiMockState): ChallengeApiClient {
        return new ChallengeApiClient(mockState)
    }

    async listChallenges(): Promise<ChallengeApiListData> {
        return this.runLimited(() => this.mockState.listChallenges())
    }

    async startChallenge(code: string): Promise<ChallengeApiStartData> {
        return this.runLimited(() => this.mockState.startChallenge(requireText(code, "code")))
    }

    async stopChallenge(code: string): Promise<null> {
        return this.runLimited(() => this.mockState.stopChallenge(requireText(code, "code")))
    }

    async submitFlag(code: string, flag: string): Promise<ChallengeApiSubmitData> {
        return this.runLimited(() => this.mockState.submitFlag(requireText(code, "code"), requireText(flag, "flag")))
    }

    async getHint(code: string): Promise<ChallengeApiHintData> {
        return this.runLimited(() => this.mockState.getHint(requireText(code, "code")))
    }

    private async runLimited<T>(run: () => Promise<T>): Promise<T> {
        await this.waitForRateLimitWindow()
        return run()
    }

    private async waitForRateLimitWindow(): Promise<void> {
        let release!: () => void
        const ready = new Promise<void>((resolve) => {
            release = resolve
        })
        const previous = this.schedule
        this.schedule = (async () => {
            await previous
            const now = Date.now()
            const waitMs = Math.max(0, this.nextRequestAt - now)
            if (waitMs > 0) await Bun.sleep(waitMs)
            this.nextRequestAt = Math.max(this.nextRequestAt, Date.now()) + CHALLENGE_API_REQUEST_INTERVAL_MS
            release()
        })()
        await ready
    }
}
