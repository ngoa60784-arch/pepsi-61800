import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "fs/promises"
import { join, resolve } from "path"
import { buildChallengeAttackTimeline } from "./attack-timeline"
import { SOLVERS_DIR } from "../runtime/types"

const challengeId = "timeline-test"
let solverSessionDir = ""

beforeEach(async () => {
    solverSessionDir = join(SOLVERS_DIR, "solver-a", "session")
    await mkdir(solverSessionDir, { recursive: true })
})

afterEach(async () => {
    await rm(join(SOLVERS_DIR, "solver-a"), { recursive: true, force: true }).catch(() => {})
})

describe("buildChallengeAttackTimeline", () => {
    test("returns empty events for empty input", async () => {
        const snapshot = await buildChallengeAttackTimeline({
            challengeId,
            attempts: [],
            submissions: [],
            memory: [],
            ideas: [],
            solverStats: [],
        })
        expect(snapshot.events).toEqual([])
        expect(snapshot.challengeId).toBe(challengeId)
    })

    test("aggregates attempt, submission, memory, and idea with correct lanes", async () => {
        const snapshot = await buildChallengeAttackTimeline({
            challengeId,
            attempts: [
                {
                    id: "attempt-1",
                    challenge_id: challengeId,
                    solver_id: "solver-a",
                    prompt_name: "pentest",
                    task: "recon",
                    created_at: "2026-06-01T10:00:00.000Z",
                },
            ],
            submissions: [
                {
                    id: "sub-1",
                    challenge_id: challengeId,
                    solver_id: "solver-a",
                    flag: "flag{ok}",
                    correct: true,
                    created_at: "2026-06-01T10:05:00.000Z",
                },
            ],
            memory: [
                {
                    id: "mem-1",
                    challengeId,
                    kind: "fact",
                    content: "admin panel at /admin",
                    refs: [],
                    source: "test",
                    created_at: "2026-06-01T10:02:00.000Z",
                    updated_at: "2026-06-01T10:02:00.000Z",
                },
            ],
            ideas: [
                {
                    id: "idea-1",
                    content: "try SQLi on login",
                    normalized: "try sqli on login",
                    status: "pending",
                    result: "",
                    created_at: "2026-06-01T10:03:00.000Z",
                    updated_at: "2026-06-01T10:03:00.000Z",
                },
            ],
            solverStats: [],
        })

        const kinds = snapshot.events.map((event) => `${event.lane}:${event.kind}`)
        expect(kinds).toContain("challenge:solver_started")
        expect(kinds).toContain("submission:flag_submitted")
        expect(kinds).toContain("board:memory_added")
        expect(kinds).toContain("board:idea_added")
        expect(snapshot.events[0]?.timestamp).toBeLessThan(snapshot.events[snapshot.events.length - 1]?.timestamp ?? 0)
    })

    test("does not duplicate static memory when solver JSONL already recorded it", async () => {
        const timestamp = "2026-06-01T10:04:00.000Z"
        await writeFile(
            join(solverSessionDir, "messages.jsonl"),
            `${JSON.stringify({
                type: "message",
                id: "msg-1",
                timestamp,
                message: {
                    role: "toolResult",
                    toolName: "memory_add",
                    toolCallId: "tc-1",
                    isError: false,
                    content: [{ type: "text", text: "saved" }],
                    details: {
                        entry: {
                            id: "mem-dup",
                            challenge_id: challengeId,
                            kind: "fact",
                            content: "from solver tool",
                            created_at: timestamp,
                            updated_at: timestamp,
                        },
                    },
                    timestamp: Date.parse(timestamp),
                },
            })}\n`,
        )

        const snapshot = await buildChallengeAttackTimeline({
            challengeId,
            attempts: [
                {
                    id: "attempt-1",
                    challenge_id: challengeId,
                    solver_id: "solver-a",
                    prompt_name: "pentest",
                    task: "recon",
                    created_at: "2026-06-01T10:00:00.000Z",
                },
            ],
            submissions: [],
            memory: [
                {
                    id: "mem-dup",
                    challengeId,
                    kind: "fact",
                    content: "from solver tool",
                    refs: [],
                    source: "test",
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            ],
            ideas: [],
            solverStats: [],
        })

        const memoryEvents = snapshot.events.filter((event) => event.kind === "memory_added")
        expect(memoryEvents).toHaveLength(1)
        expect(memoryEvents[0]?.lane).toBe("board")
    })
})
