import { describe, expect, test } from "bun:test"
import type { ChallengeSubmissionLogRecord } from "./store"
import { isRealFinding } from "./submission-utils"

function submission(overrides: Partial<ChallengeSubmissionLogRecord> = {}): ChallengeSubmissionLogRecord {
    return {
        id: "sub-1",
        challenge_id: "c1",
        solver_id: "s1",
        flag: "finding",
        correct: false,
        created_at: "2026-01-01T00:00:00.000Z",
        ...overrides,
    }
}

describe("isRealFinding", () => {
    test("CTF correct submission counts", () => {
        expect(isRealFinding(submission({ correct: true }))).toBe(true)
    })

    test("engagement finding counts when not rejected", () => {
        expect(isRealFinding(submission({ correct: false, writeup: "redis exposed on 6379" }))).toBe(true)
        expect(isRealFinding(submission({ correct: false, verification_status: "verified" }))).toBe(true)
        expect(isRealFinding(submission({ correct: false, verification_status: "pending" }))).toBe(true)
    })

    test("failed CTF flag attempt without writeup does not count", () => {
        expect(isRealFinding(submission({ correct: false, flag: "flag{wrong}" }))).toBe(false)
    })

    test("verifier-rejected finding does not count", () => {
        expect(isRealFinding(submission({ correct: false, verification_status: "rejected" }))).toBe(false)
    })
})
