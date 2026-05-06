import { describe, expect, test } from "bun:test"
import type { ChallengeInfoRecord, ChallengeSubmissionLogRecord } from "./store"
import { buildChallengeStatsOverview } from "./stats"
import type { ChallengeStatsRecord, SolverStatsRecord, UsageTotals } from "./stats"

function createUsageTotals(total: number): UsageTotals {
    return {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        total,
    }
}

function createChallenge(id: string, options?: { difficulty?: string; totalScore?: number; flagCount?: number; flagGotCount?: number }): ChallengeInfoRecord {
    return {
        id,
        title: id,
        difficulty: options?.difficulty ?? "easy",
        description: "",
        level: 1,
        total_score: options?.totalScore ?? 100,
        total_got_score: 0,
        flag_count: options?.flagCount ?? 1,
        flag_got_count: options?.flagGotCount ?? 0,
        hint_viewed: false,
        hint_content: null,
        instance_status: "running",
        entrypoint: null,
        flags: [],
        updated_at: "2026-01-01T00:00:00.000Z",
        source: "test",
    }
}

function createStats(challengeId: string, options?: { submissionCount?: number; correctSubmissionCount?: number }): ChallengeStatsRecord {
    return {
        challenge_id: challengeId,
        solver_count: 0,
        attempt_count: 0,
        submission_count: options?.submissionCount ?? 0,
        correct_submission_count: options?.correctSubmissionCount ?? 0,
        first_attempt_at: undefined,
        first_correct_submission_at: undefined,
        solve_duration_ms: undefined,
        solver_active_duration_ms_total: 0,
        usage: createUsageTotals(0),
        updated_at: "2026-01-01T00:00:00.000Z",
    }
}

function createSolverStat(options: {
    solverId: string
    challengeId: string
    promptName: string
    modelName: string
    totalTokens?: number
    durationMs?: number
}): SolverStatsRecord {
    return {
        solver_id: options.solverId,
        challenge_id: options.challengeId,
        prompt_name: options.promptName,
        model_name: options.modelName,
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: "2026-01-01T00:10:00.000Z",
        duration_ms: options.durationMs ?? 0,
        usage: createUsageTotals(options.totalTokens ?? 0),
    }
}

function createSubmission(options: {
    id: string
    challengeId: string
    solverId: string
    promptName: string
    modelName: string
    flag: string
    correct: boolean
}): ChallengeSubmissionLogRecord {
    return {
        id: options.id,
        challenge_id: options.challengeId,
        solver_id: options.solverId,
        prompt_name: options.promptName,
        model_name: options.modelName,
        flag: options.flag,
        correct: options.correct,
        created_at: "2026-01-01T00:00:00.000Z",
    }
}

describe("buildChallengeStatsOverview flag-based buckets", () => {
    test("overview completion uses flag progress and full challenge completion", () => {
        const challengeA = createChallenge("challenge-overview-a", { flagCount: 6, flagGotCount: 4 })
        const challengeB = createChallenge("challenge-overview-b", { flagCount: 2, flagGotCount: 2 })

        const overview = buildChallengeStatsOverview([
            {
                challenge: challengeA,
                stats: createStats(challengeA.id),
                solver_stats: [],
                submissions: [],
            },
            {
                challenge: challengeB,
                stats: createStats(challengeB.id),
                solver_stats: [],
                submissions: [],
            },
        ])

        expect(overview.flags_total).toBe(8)
        expect(overview.flags_solved).toBe(6)
        expect(overview.flag_completion_rate).toBeCloseTo(0.75)
        expect(overview.challenges_total).toBe(2)
        expect(overview.challenges_solved).toBe(1)
        expect(overview.completion_rate).toBeCloseTo(0.5)
    })

    test("groups model buckets by model id suffix instead of provider prefix", () => {
        const challenge = createChallenge("challenge-model-group", { difficulty: "easy", totalScore: 100, flagCount: 2 })
        const solverStats = [
            createSolverStat({
                solverId: "solver-provider-a",
                challengeId: challenge.id,
                promptName: "prompt-a",
                modelName: "provider:9ac2076c/claude-opus-4-6",
            }),
            createSolverStat({
                solverId: "solver-provider-b",
                challengeId: challenge.id,
                promptName: "prompt-b",
                modelName: "provider:4e11f585/claude-opus-4-6",
            }),
        ]
        const submissions = [
            createSubmission({
                id: "sub-1",
                challengeId: challenge.id,
                solverId: "solver-provider-a",
                promptName: "prompt-a",
                modelName: "provider:9ac2076c/claude-opus-4-6",
                flag: "flag{a}",
                correct: true,
            }),
            createSubmission({
                id: "sub-2",
                challengeId: challenge.id,
                solverId: "solver-provider-b",
                promptName: "prompt-b",
                modelName: "provider:4e11f585/claude-opus-4-6",
                flag: "flag{b}",
                correct: true,
            }),
        ]

        const overview = buildChallengeStatsOverview([
            {
                challenge,
                stats: createStats(challenge.id, { submissionCount: 2, correctSubmissionCount: 2 }),
                solver_stats: solverStats,
                submissions,
            },
        ])

        expect(overview.models).toHaveLength(1)
        expect(overview.models[0]?.key).toBe("claude-opus-4-6")
        expect(overview.models[0]?.label).toBe("claude-opus-4-6")
        expect(overview.models[0]?.solved_count).toBe(2)
        expect(overview.models[0]?.total_flag_count).toBe(2)
    })

    test("deduplicates repeated correct flags per bucket", () => {
        const challenge = createChallenge("challenge-a", { difficulty: "medium", totalScore: 90, flagCount: 3 })
        const solverStats = [
            createSolverStat({ solverId: "solver-1", challengeId: challenge.id, promptName: "prompt-a", modelName: "model-a", totalTokens: 200, durationMs: 3000 }),
            createSolverStat({ solverId: "solver-2", challengeId: challenge.id, promptName: "prompt-a", modelName: "model-a", totalTokens: 300, durationMs: 5000 }),
        ]
        const submissions = [
            createSubmission({ id: "1", challengeId: challenge.id, solverId: "solver-1", promptName: "prompt-a", modelName: "model-a", flag: "flag{a}", correct: true }),
            createSubmission({ id: "2", challengeId: challenge.id, solverId: "solver-1", promptName: "prompt-a", modelName: "model-a", flag: "flag{a}", correct: true }),
            createSubmission({ id: "3", challengeId: challenge.id, solverId: "solver-1", promptName: "prompt-a", modelName: "model-a", flag: "flag{b}", correct: true }),
            createSubmission({ id: "4", challengeId: challenge.id, solverId: "solver-2", promptName: "prompt-a", modelName: "model-a", flag: "flag{b}", correct: true }),
            createSubmission({ id: "5", challengeId: challenge.id, solverId: "solver-2", promptName: "prompt-a", modelName: "model-a", flag: "flag{c}", correct: true }),
            createSubmission({ id: "6", challengeId: challenge.id, solverId: "solver-2", promptName: "prompt-a", modelName: "model-a", flag: "flag{wrong}", correct: false }),
        ]

        const overview = buildChallengeStatsOverview([
            {
                challenge,
                stats: createStats(challenge.id, { submissionCount: submissions.length, correctSubmissionCount: 5 }),
                solver_stats: solverStats,
                submissions,
            },
        ])

        expect(overview.models).toHaveLength(1)
        expect(overview.prompts).toHaveLength(1)

        const modelBucket = overview.models[0]
        expect(modelBucket.challenge_count).toBe(1)
        expect(modelBucket.total_flag_count).toBe(3)
        expect(modelBucket.solved_count).toBe(3)
        expect(modelBucket.completion_rate).toBe(1)
        expect(modelBucket.submission_count).toBe(6)
        expect(modelBucket.correct_submission_count).toBe(5)
        expect(modelBucket.error_rate).toBeCloseTo(1 / 6)
        expect(modelBucket.quality_score).toBeCloseTo(180)

        const promptBucket = overview.prompts[0]
        expect(promptBucket.total_flag_count).toBe(3)
        expect(promptBucket.solved_count).toBe(3)
        expect(promptBucket.completion_rate).toBe(1)
        expect(promptBucket.quality_score).toBeCloseTo(180)
    })

    test("computes completion and quality by unique flags across challenges", () => {
        const challengeA = createChallenge("challenge-a", { difficulty: "easy", totalScore: 100, flagCount: 2 })
        const challengeB = createChallenge("challenge-b", { difficulty: "hard", totalScore: 120, flagCount: 4 })

        const overview = buildChallengeStatsOverview([
            {
                challenge: challengeA,
                stats: createStats(challengeA.id, { submissionCount: 2, correctSubmissionCount: 2 }),
                solver_stats: [createSolverStat({ solverId: "solver-a", challengeId: challengeA.id, promptName: "prompt-a", modelName: "model-a" })],
                submissions: [
                    createSubmission({ id: "1", challengeId: challengeA.id, solverId: "solver-a", promptName: "prompt-a", modelName: "model-a", flag: "flag{a1}", correct: true }),
                    createSubmission({ id: "2", challengeId: challengeA.id, solverId: "solver-a", promptName: "prompt-a", modelName: "model-a", flag: "flag{a1}", correct: true }),
                ],
            },
            {
                challenge: challengeB,
                stats: createStats(challengeB.id, { submissionCount: 3, correctSubmissionCount: 2 }),
                solver_stats: [createSolverStat({ solverId: "solver-b", challengeId: challengeB.id, promptName: "prompt-a", modelName: "model-a" })],
                submissions: [
                    createSubmission({ id: "3", challengeId: challengeB.id, solverId: "solver-b", promptName: "prompt-a", modelName: "model-a", flag: "flag{b1}", correct: true }),
                    createSubmission({ id: "4", challengeId: challengeB.id, solverId: "solver-b", promptName: "prompt-a", modelName: "model-a", flag: "flag{b2}", correct: true }),
                    createSubmission({ id: "5", challengeId: challengeB.id, solverId: "solver-b", promptName: "prompt-a", modelName: "model-a", flag: "flag{wrong}", correct: false }),
                ],
            },
        ])

        const modelBucket = overview.models[0]
        expect(modelBucket.challenge_count).toBe(2)
        expect(modelBucket.total_flag_count).toBe(6)
        expect(modelBucket.solved_count).toBe(3)
        expect(modelBucket.completion_rate).toBeCloseTo(0.5)
        expect(modelBucket.quality_score).toBeCloseTo(230)

        const promptBucket = overview.prompts[0]
        expect(promptBucket.total_flag_count).toBe(6)
        expect(promptBucket.solved_count).toBe(3)
        expect(promptBucket.completion_rate).toBeCloseTo(0.5)
        expect(promptBucket.quality_score).toBeCloseTo(230)
    })
})
