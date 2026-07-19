import { describe, expect, test } from "bun:test"
import type { ChallengeSubmissionLogRecord } from "./store"
import { findDuplicateSubmission, isRealFinding, isRecordedFinding, isVerifiedFinding, normalizeFlagForDedup } from "./submission-utils"

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

describe("finding scheduling signals", () => {
    test("pending and inconclusive stay recorded without becoming verified success", () => {
        for (const verification_status of ["pending", "inconclusive", "unverified"] as const) {
            const item = submission({ writeup: "useful finding", verification_status })
            expect(isRecordedFinding(item)).toBe(true)
            expect(isVerifiedFinding(item)).toBe(false)
        }
    })

    test("verified or correct findings count as scheduling success", () => {
        expect(isVerifiedFinding(submission({ verification_status: "verified" }))).toBe(true)
        expect(isVerifiedFinding(submission({ correct: true }))).toBe(true)
    })
})

describe("normalizeFlagForDedup", () => {
    test("trims and collapses whitespace, preserves case", () => {
        expect(normalizeFlagForDedup("  flag{aB cD}  ")).toBe("flag{aB cD}")
        expect(normalizeFlagForDedup("flag{a\n\tb   c}")).toBe("flag{a b c}")
    })
})

describe("findDuplicateSubmission", () => {
    const banked = submission({ id: "orig", flag: "flag{secret_3}", writeup: "sqli -> creds", created_at: "2026-01-01T00:00:00.000Z" })

    test("matches an earlier non-rejected finding with the same normalized flag", () => {
        const dup = findDuplicateSubmission([banked], "  flag{secret_3}  ")
        expect(dup?.id).toBe("orig")
    })

    test("returns undefined when the flag differs (e.g. a typo re-submission)", () => {
        expect(findDuplicateSubmission([banked], "flag{secret_e}")).toBeUndefined()
    })

    test("ignores rejected originals so a fresh attempt can re-verify", () => {
        const rejected = submission({ id: "rej", flag: "flag{secret_3}", verification_status: "rejected" })
        expect(findDuplicateSubmission([rejected], "flag{secret_3}")).toBeUndefined()
    })

    test("skips existing duplicates so every dup chains back to the original", () => {
        const later = submission({ id: "dup1", flag: "flag{secret_3}", duplicate_of: "orig", created_at: "2026-01-02T00:00:00.000Z" })
        const dup = findDuplicateSubmission([banked, later], "flag{secret_3}")
        expect(dup?.id).toBe("orig")
    })

    test("empty flag never matches", () => {
        expect(findDuplicateSubmission([banked], "   ")).toBeUndefined()
    })
})
