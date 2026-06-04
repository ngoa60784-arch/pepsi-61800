import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import {
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    deleteChallengeDirectory,
    isChallengeCompletedInStore,
    listChallengeAttemptLogs,
    listChallengeRecords,
    listChallengeSubmissionLogs,
    readChallengeRecord,
    saveChallengeRecord,
    updateChallengeSubmissionVerification,
} from "./store"

let challengeDir: string

beforeEach(async () => {
    challengeDir = await mkdtemp(resolve(tmpdir(), "tch-challenge-store-test-"))
})

afterEach(async () => {
    await rm(challengeDir, { recursive: true, force: true })
})

describe("challenge-store", () => {
    test("save/read/list challenge records by challenge id", async () => {
        await saveChallengeRecord(challengeDir, {
            id: "abc123",
            title: "challenge-a",
            difficulty: "easy",
            description: "desc",
            level: 1,
            total_score: 100,
            total_got_score: 40,
            flag_count: 2,
            flag_got_count: 1,
            hint_viewed: false,
            instance_status: "running",
            entrypoint: ["127.0.0.1:8080"],
        })
        const challenge = await readChallengeRecord(challengeDir, "abc123")
        expect(challenge?.id).toBe("abc123")
        expect(challenge?.title).toBe("challenge-a")
        expect(await isChallengeCompletedInStore("abc123", challengeDir)).toBe(false)

        await saveChallengeRecord(challengeDir, {
            id: "abc123",
            title: "challenge-a",
            difficulty: "easy",
            description: "desc",
            level: 1,
            total_score: 100,
            total_got_score: 100,
            flag_count: 2,
            flag_got_count: 2,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: null,
        })
        const updated = await readChallengeRecord(challengeDir, "abc123")
        expect(updated?.flag_got_count).toBe(2)
        expect(await isChallengeCompletedInStore("abc123", challengeDir)).toBe(true)

        const records = await listChallengeRecords(challengeDir)
        expect(records).toHaveLength(1)
        expect(records[0].id).toBe("abc123")
    })

    test("writes attempt logs and submission logs as files", async () => {
        await saveChallengeRecord(challengeDir, {
            id: "abc123",
            title: "challenge-a",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: null,
        })

        const attempt = await appendChallengeAttemptLog(challengeDir, {
            challengeId: "abc123",
            solverId: "solver-1",
            promptName: "p",
            task: "recon",
        })
        const submission = await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "abc123",
            flag: "flag{test}",
            correct: true,
        })
        expect(attempt.challenge_id).toBe("abc123")
        expect(submission.flag).toBe("flag{test}")

        const attempts = await listChallengeAttemptLogs(challengeDir, "abc123")
        const submissions = await listChallengeSubmissionLogs(challengeDir, "abc123")
        expect(attempts).toHaveLength(1)
        expect(submissions).toHaveLength(1)
    })

    test("updateChallengeSubmissionVerification rewrites verdict on the matching record", async () => {
        const pending = await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "verify-1",
            flag: "proof",
            correct: false,
            verificationStatus: "pending",
        })
        const updated = await updateChallengeSubmissionVerification(challengeDir, "verify-1", pending.id, {
            verification_status: "verified",
            verifier_note: "reproduced",
        })
        expect(updated?.verification_status).toBe("verified")
        expect(typeof updated?.verified_at).toBe("string")

        const submissions = await listChallengeSubmissionLogs(challengeDir, "verify-1")
        expect(submissions).toHaveLength(1)
        expect(submissions[0].verification_status).toBe("verified")
    })

    test("updateChallengeSubmissionVerification returns undefined for unknown record id", async () => {
        const result = await updateChallengeSubmissionVerification(challengeDir, "verify-2", "submission_doesnotexist", {
            verification_status: "rejected",
        })
        expect(result).toBeUndefined()
    })

    test("deleteChallengeDirectory removes target data", async () => {
        await saveChallengeRecord(challengeDir, {
            id: "to-delete",
            title: "to-delete",
            difficulty: "easy",
            description: "",
            level: 1,
            total_score: 100,
            total_got_score: 0,
            flag_count: 1,
            flag_got_count: 0,
            hint_viewed: false,
            instance_status: "stopped",
            entrypoint: null,
        })
        await appendChallengeAttemptLog(challengeDir, {
            challengeId: "to-delete",
            solverId: "solver-1",
            promptName: "p",
            task: "recon",
        })

        await deleteChallengeDirectory(challengeDir, "to-delete")
        expect(await readChallengeRecord(challengeDir, "to-delete")).toBeUndefined()
        expect(await listChallengeRecords(challengeDir)).toHaveLength(0)
    })
})
