import { describe, expect, test } from "bun:test"
import { buildChallengeProgressDigest } from "./progress-digest"
import type { ChallengeInfoRecord } from "./store"

const baseChallenge = {
    id: "demo",
    title: "Demo",
    instance_status: "running",
    testing_paused: false,
    objective_achieved: false,
} as ChallengeInfoRecord

const baseOverview = {
    progressPhase: "recon" as const,
    instanceStatus: "running",
    successRate: 0.5,
    failedRouteCount: 1,
    findingCount: 0,
    activeSolverCount: 1,
    pruneRecommended: false,
    stateAssets: [],
    activeSolvers: [{ id: "s1", status: "running", currentFocus: "nmap full port" }],
}

describe("buildChallengeProgressDigest", () => {
    test("maps phase label and solver focus", () => {
        const digest = buildChallengeProgressDigest({
            challenge: baseChallenge,
            overview: baseOverview,
            ideas: [{ id: "i1", content: "test sqli", normalized: "x", status: "testing", result: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
            memory: [],
            submissions: [],
            solverPromptById: { s1: "kimi-security" },
            recentEvents: [],
        })
        expect(digest.phaseLabel).toBe("侦察中")
        expect(digest.solvers[0]?.promptName).toBe("kimi-security")
        expect(digest.ideasByStatus.testing).toHaveLength(1)
    })
})
