import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import {
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    isChallengeCompletedInStore,
    listChallengeAttemptLogs,
    listChallengeRecords,
    listChallengeSubmissionLogs,
    readChallengeRecord,
    saveChallengeRecord,
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
        expect(challenge?.flag_count).toBe(2)
        expect(challenge?.flag_got_count).toBe(1)
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
            hint_viewed: true,
            instance_status: "stopped",
            entrypoint: null,
        })

        const updated = await readChallengeRecord(challengeDir, "abc123")
        expect(updated?.flag_got_count).toBe(2)
        expect(updated?.instance_status).toBe("stopped")
        expect(updated?.hint_viewed).toBe(true)
        expect(await isChallengeCompletedInStore("abc123", challengeDir)).toBe(true)

        const records = await listChallengeRecords(challengeDir)
        expect(records).toHaveLength(1)
        expect(records[0].id).toBe("abc123")
    })

    test("writes attempt logs and submission logs as files", async () => {
        const attempt = await appendChallengeAttemptLog(challengeDir, {
            challengeId: "abc123",
            solverId: "solver-1",
            promptName: "default",
            task: "solve it",
        })
        const submission = await appendChallengeSubmissionLog(challengeDir, {
            challengeId: "abc123",
            solverId: "solver-1",
            promptName: "default",
            modelName: "anthropic/claude-sonnet",
            flag: "flag{test}",
            correct: true,
            message: "ok",
            writeup: "upload polyglot bypass -> webshell -> read flag",
        })

        const attempts = await listChallengeAttemptLogs(challengeDir, "abc123")
        const submissions = await listChallengeSubmissionLogs(challengeDir, "abc123")

        expect(attempts).toHaveLength(1)
        expect(attempts[0].id).toBe(attempt.id)
        expect(attempts[0].solver_id).toBe("solver-1")
        expect(submissions).toHaveLength(1)
        expect(submissions[0].id).toBe(submission.id)
        expect(submissions[0].solver_id).toBe("solver-1")
        expect(submissions[0].prompt_name).toBe("default")
        expect(submissions[0].model_name).toBe("anthropic/claude-sonnet")
        expect(submissions[0].correct).toBe(true)
        expect(submissions[0].writeup).toBe("upload polyglot bypass -> webshell -> read flag")
    })
})
