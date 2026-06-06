import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import type { IdeaRecord, MemoryEntry } from "../challenge/memory"
import {
    readSolverSteerFocus,
    recordSolverSteerFocus,
    resolveSolverFocusSignal,
} from "./board-store"

let sessionDir: string

afterEach(async () => {
    if (sessionDir) await rm(sessionDir, { recursive: true, force: true })
})

describe("solver steer focus", () => {
    test("recordSolverSteerFocus persists and reads back", async () => {
        sessionDir = await mkdtemp(resolve(tmpdir(), "tch-steer-focus-"))
        await recordSolverSteerFocus({ message: "pivot to SSRF on message APIs", source: "planner:steer" }, sessionDir)
        const focus = await readSolverSteerFocus(sessionDir)
        expect(focus?.message).toBe("pivot to SSRF on message APIs")
        expect(focus?.source).toBe("planner:steer")
        expect(focus?.updated_at).toBeTruthy()
    })

    test("resolveSolverFocusSignal prefers fresh steer over stale testing idea title", () => {
        const ideas: IdeaRecord[] = [
            {
                id: "idea_old",
                content: "Login with provided credentials and explore authenticated functionality",
                normalized: "login",
                status: "testing",
                result: "Still trying login flows",
                created_at: "2026-06-06T04:39:00.000Z",
                updated_at: "2026-06-06T04:50:00.000Z",
            },
        ]
        const steer = {
            message: "Use auth session + origin IP to hit 76 API endpoints for SSRF",
            source: "planner:steer",
            updated_at: "2026-06-06T04:54:00.000Z",
        }
        const focus = resolveSolverFocusSignal({ steer, ideas, memory: [] })
        expect(focus).toContain("steered:")
        expect(focus).toContain("76 API endpoints")
        expect(focus).not.toContain("Login with provided credentials")
    })

    test("resolveSolverFocusSignal prefers testing result when observer updated after steer", () => {
        const ideas: IdeaRecord[] = [
            {
                id: "idea_live",
                content: "Login with provided credentials and explore authenticated functionality",
                normalized: "login",
                status: "testing",
                result: "PhoneLogin live on ai6pa.yuntsy.com; probing password encoding next",
                created_at: "2026-06-06T04:39:00.000Z",
                updated_at: "2026-06-06T04:55:00.000Z",
            },
        ]
        const steer = {
            message: "Pivot to authenticated API enumeration",
            source: "planner:steer",
            updated_at: "2026-06-06T04:54:00.000Z",
        }
        const focus = resolveSolverFocusSignal({ steer, ideas, memory: [] })
        expect(focus).toContain("testing:")
        expect(focus).toContain("PhoneLogin live on ai6pa.yuntsy.com")
    })

    test("resolveSolverFocusSignal uses most recently updated testing idea", () => {
        const ideas: IdeaRecord[] = [
            {
                id: "idea_old",
                content: "Login with provided credentials",
                normalized: "login",
                status: "testing",
                result: "",
                created_at: "2026-06-06T04:39:00.000Z",
                updated_at: "2026-06-06T04:39:00.000Z",
            },
            {
                id: "idea_new",
                content: "Check WebSocket endpoints for injection",
                normalized: "websocket",
                status: "testing",
                result: "WS endpoint ai6ws.yuntsy.com confirmed live",
                created_at: "2026-06-06T04:40:00.000Z",
                updated_at: "2026-06-06T04:51:00.000Z",
            },
        ]
        const focus = resolveSolverFocusSignal({ ideas, memory: [] })
        expect(focus).toContain("WS endpoint ai6ws.yuntsy.com")
        expect(focus).not.toContain("Login with provided credentials")
    })

    test("resolveSolverFocusSignal falls back to latest memory", () => {
        const memory: MemoryEntry[] = [
            {
                id: "mem_1",
                challengeId: "board",
                kind: "fact",
                content: "VABCP decrypted; reachable backend ai6pa.yuntsy.com",
                refs: [],
                source: "observer",
                created_at: "2026-06-06T04:46:00.000Z",
                updated_at: "2026-06-06T04:46:00.000Z",
            },
        ]
        const focus = resolveSolverFocusSignal({ ideas: [], memory })
        expect(focus).toContain("latest note [fact]")
        expect(focus).toContain("ai6pa.yuntsy.com")
    })
})
