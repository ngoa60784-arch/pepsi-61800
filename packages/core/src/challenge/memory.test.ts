import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { resolve } from "path"
import type { ConfigManager } from "../config/index"
import { CHALLENGE_ENV_DIR } from "./env"
import { ChallengeManager } from "./manager"

let challengeDir: string
let manager: ChallengeManager

beforeEach(async () => {
    challengeDir = await mkdtemp(resolve(tmpdir(), "tch-challenge-memory-test-"))
    process.env[CHALLENGE_ENV_DIR] = challengeDir
    const config = {
        getHostSettings: async () => ({ runtime: {}, challenge: {}, planner: {} }),
    } as unknown as ConfigManager
    manager = new ChallengeManager(config)
})

afterEach(async () => {
    delete process.env[CHALLENGE_ENV_DIR]
    await rm(challengeDir, { recursive: true, force: true })
})

describe("challenge-memory", () => {
    test("adds, edits, and deletes ideas by id prefix", async () => {
        const first = await manager.addIdea("abc123", { content: "Try SQL injection on /login" })
        expect(first.created).toBe(true)
        expect(first.item.status).toBe("pending")

        const deduped = await manager.addIdea("abc123", { content: "try sql injection on /login" })
        expect(deduped.created).toBe(false)
        expect(deduped.item.id).toBe(first.item.id)

        const updated = await manager.updateIdea("abc123", first.item.id.slice(0, 8), {
            content: "Try SQL injection on /admin/login",
            status: "failed",
            result: "No injection point",
        })
        expect(updated.content).toBe("Try SQL injection on /admin/login")
        expect(updated.status).toBe("failed")
        expect(updated.result).toBe("No injection point")

        const deleted = await manager.deleteIdea("abc123", first.item.id.slice(0, 8))
        expect(deleted.id).toBe(first.item.id)

        const items = await manager.listIdeas("abc123")
        expect(items).toHaveLength(0)
    })

    test("listing ideas does not create storage for missing challenge", async () => {
        const items = await manager.listIdeas("missing")
        expect(items).toEqual([])
        expect(await readdir(challengeDir)).toEqual([])
    })

    test("rejects editing an idea into another existing normalized value", async () => {
        const first = await manager.addIdea("abc123", { content: "Try SQL injection on /login" })
        const second = await manager.addIdea("abc123", { content: "Check upload polyglot" })

        expect(first.created).toBe(true)
        expect(second.created).toBe(true)

        await expect(
            manager.updateIdea("abc123", second.item.id, {
                content: "  try sql injection on /login  ",
            }),
        ).rejects.toThrow("duplicates")
    })

    test("adds idea with status/result and without content length limit", async () => {
        const longContent = "A".repeat(240)
        const created = await manager.addIdea("abc123", {
            content: longContent,
            status: "verified",
            result: "worked",
        })

        expect(created.created).toBe(true)
        expect(created.item.content).toBe(longContent)
        expect(created.item.status).toBe("verified")
        expect(created.item.result).toBe("worked")
    })

    test("appends and lists memory entries", async () => {
        await manager.appendMemory({
            challengeId: "abc123",
            kind: "fact",
            content: "found /admin",
            refs: ["evidence/http-1.txt"],
            source: "solver:1",
        })
        await manager.appendMemory({
            challengeId: "abc123",
            kind: "failure",
            content: "sqli failed",
            refs: [],
            source: "solver:1",
        })

        const entries = await manager.listMemory("abc123")
        expect(entries).toHaveLength(2)
        expect(entries.some((item) => item.kind === "fact")).toBe(true)
        expect(entries.some((item) => item.kind === "failure")).toBe(true)
    })

    test("updates and deletes memory by id prefix", async () => {
        const first = await manager.appendMemory({
            challengeId: "abc123",
            kind: "fact",
            content: "found /admin",
            refs: ["evidence/http-1.txt"],
            source: "solver:1",
        })
        const second = await manager.appendMemory({
            challengeId: "abc123",
            kind: "failure",
            content: "sqli failed",
            refs: [],
            source: "solver:1",
        })

        const updated = await manager.updateMemory("abc123", first.id.slice(0, 8), {
            kind: "evidence",
            content: "found /admin/login",
            refs: ["evidence/http-2.txt"],
            source: "observer:solver-1",
        })
        expect(updated.id).toBe(first.id)
        expect(updated.kind).toBe("evidence")
        expect(updated.content).toBe("found /admin/login")
        expect(updated.refs).toEqual(["evidence/http-2.txt"])
        expect(updated.source).toBe("observer:solver-1")
        // created_at 在更新后保持不变；updated_at 不早于 created_at（ISO 串按字典序即时间序，
        // 同毫秒内更新会相等，故用 >= 而非严格不等，避免时序竞态偶发失败）。
        expect(updated.created_at).toBe(first.created_at)
        expect(updated.updated_at >= updated.created_at).toBe(true)

        const deleted = await manager.deleteMemory("abc123", second.id.slice(0, 8))
        expect(deleted.id).toBe(second.id)

        const entries = await manager.listMemory("abc123")
        expect(entries).toHaveLength(1)
        expect(entries[0].id).toBe(first.id)
        expect(entries[0].content).toBe("found /admin/login")
    })

    test("appends, lists, updates, and deletes relational graph memory", async () => {
        const first = await manager.appendRelation({
            challengeId: "abc123",
            source: "Host:192.168.1.10",
            relation: "exploitable_via",
            target: "Vuln:CVE-2023-xxxx",
            note: "confirmed via nmap scan",
            source_ref: "mem_123456"
        })
        expect(first.id.startsWith("rel_")).toBe(true)
        expect(first.source).toBe("Host:192.168.1.10")
        expect(first.relation).toBe("exploitable_via")
        expect(first.target).toBe("Vuln:CVE-2023-xxxx")
        expect(first.note).toBe("confirmed via nmap scan")
        expect(first.source_ref).toBe("mem_123456")

        // Dedup test: duplicate insertion of same triple should ignore and return the existing record
        const dup = await manager.appendRelation({
            challengeId: "abc123",
            source: "  Host:192.168.1.10  ", // trailing spaces
            relation: "EXPLOITABLE_VIA",      // case insensitive
            target: "Vuln:CVE-2023-xxxx",
            note: "different note",
        })
        expect(dup.id).toBe(first.id)

        // List relations
        const list = await manager.listRelations("abc123")
        expect(list).toHaveLength(1)
        expect(list[0].id).toBe(first.id)

        // Update relation
        const updated = await manager.updateRelation("abc123", first.id.slice(0, 8), {
            note: "updated note",
            target: "Vuln:CVE-2023-NEW",
        })
        expect(updated.id).toBe(first.id)
        expect(updated.note).toBe("updated note")
        expect(updated.target).toBe("Vuln:CVE-2023-NEW")

        // Query relation
        const qResult = await manager.queryRelations("abc123", { target: "NEW" })
        expect(qResult).toHaveLength(1)
        expect(qResult[0].id).toBe(first.id)

        // Delete relation
        const deleted = await manager.deleteRelation("abc123", first.id.slice(0, 8))
        expect(deleted.id).toBe(first.id)

        const final_list = await manager.listRelations("abc123")
        expect(final_list).toHaveLength(0)
    })

    test("finds shortest relation paths in graph", async () => {
        // Construct a path: Host A -> routes_to -> Subnet B -> contains -> Host C -> exploits -> Root Shell
        await manager.appendRelation({ challengeId: "path-test", source: "Host:A", relation: "routes_to", target: "Subnet:B" })
        await manager.appendRelation({ challengeId: "path-test", source: "Subnet:B", relation: "contains", target: "Host:C" })
        await manager.appendRelation({ challengeId: "path-test", source: "Host:C", relation: "exploits", target: "Shell" })
        await manager.appendRelation({ challengeId: "path-test", source: "Host:A", relation: "independent", target: "Host:D" }) // dummy distractor

        const pathResult = await manager.findRelationShortestPath("path-test", "Host:A", "Shell")
        expect(pathResult.found).toBe(true)
        expect(pathResult.path).toHaveLength(3)
        expect(pathResult.path[0].source).toBe("Host:A")
        expect(pathResult.path[0].target).toBe("Subnet:B")
        expect(pathResult.path[1].source).toBe("Subnet:B")
        expect(pathResult.path[1].target).toBe("Host:C")
        expect(pathResult.path[2].source).toBe("Host:C")
        expect(pathResult.path[2].target).toBe("Shell")

        const missingPath = await manager.findRelationShortestPath("path-test", "Host:A", "NonExistent")
        expect(missingPath.found).toBe(false)
        expect(missingPath.path).toHaveLength(0)
    })
})
