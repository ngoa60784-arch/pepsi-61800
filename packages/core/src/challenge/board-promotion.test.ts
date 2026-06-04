import { describe, expect, test } from "bun:test"
import {
    extractFindingFactLines,
    memoryFingerprintExists,
    normalizeBoardFingerprint,
    shouldPromoteIdeaStatus,
    shouldPromoteMemoryKind,
} from "./board-promotion"
import type { MemoryEntry } from "./memory"

describe("board-promotion", () => {
    test("shouldPromoteMemoryKind promotes failure and credential always", () => {
        expect(shouldPromoteMemoryKind("failure", "login SQLi dead-end")).toBe(true)
        expect(shouldPromoteMemoryKind("credential", "admin:pass")).toBe(true)
    })

    test("shouldPromoteMemoryKind promotes fact only with signal and length", () => {
        expect(shouldPromoteMemoryKind("fact", "short")).toBe(false)
        expect(
            shouldPromoteMemoryKind(
                "fact",
                "Typecho 1.1 at https://51cg1.com/action/xmlrpc with SSRF via gopher://127.0.0.1:6379",
            ),
        ).toBe(true)
    })

    test("shouldPromoteMemoryKind skips note and hint", () => {
        expect(shouldPromoteMemoryKind("note", "https://51cg1.com/admin is interesting for later review today")).toBe(false)
    })

    test("shouldPromoteIdeaStatus only verified and failed", () => {
        expect(shouldPromoteIdeaStatus("verified")).toBe(true)
        expect(shouldPromoteIdeaStatus("failed")).toBe(true)
        expect(shouldPromoteIdeaStatus("testing")).toBe(false)
        expect(shouldPromoteIdeaStatus("pending")).toBe(false)
    })

    test("extractFindingFactLines pulls URL/CVE lines and dedupes", () => {
        const proof = "ignored short line"
        const writeup = [
            "- SSRF via https://51cg1.com/action/xmlrpc to gopher://127.0.0.1:6379",
            "- SSRF via https://51cg1.com/action/xmlrpc to gopher://127.0.0.1:6379",
            "- AES key 2acf7e91e9864673 in auth-core.js for api backend",
        ].join("\n")
        const lines = extractFindingFactLines(proof, writeup)
        expect(lines.length).toBe(2)
        expect(lines[0]).toContain("xmlrpc")
    })

    test("memoryFingerprintExists compares normalized content", () => {
        const entries: MemoryEntry[] = [
            {
                id: "mem_a",
                challengeId: "c1",
                kind: "fact",
                content: "  HTTPS://Example.COM/path  ",
                refs: [],
                source: "t",
                created_at: "",
                updated_at: "",
            },
        ]
        expect(memoryFingerprintExists(entries, "https://example.com/path")).toBe(true)
        expect(normalizeBoardFingerprint("  HTTPS://Example.COM/path  ")).toBe("https://example.com/path")
    })
})
