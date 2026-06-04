import type { AddIdeaInput, AddMemoryInput, IdeaRecord, IdeaStatus, MemoryEntry, MemoryKind } from "./memory"

/** Normalize text for cross-solver dedupe on the challenge-level board. */
export function normalizeBoardFingerprint(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .slice(0, 500)
}

const MIN_PROMOTABLE_FACT_CHARS = 24

/** Lines worth promoting from a finding writeup/proof into target-level memory. */
const FINDING_FACT_SIGNAL =
    /(?:https?:\/\/|\/[\w./-]+|\b\d{1,3}(?:\.\d{1,3}){3}\b|:\d{2,5}\b|CVE-\d{4}-\d+|eyJ[A-Za-z0-9_-]{8,}|(?:key|iv|sign_key|token|password|admin)\s*[:=]|\b(?:aes\s+)?key\s+[0-9a-f]{8,}\b|Typecho|xmlrpc|SSRF|RCE|gopher:\/\/|redis|elasticsearch)/i

export function shouldPromoteMemoryKind(kind: MemoryKind, content: string): boolean {
    const text = content.trim()
    if (!text) return false
    if (kind === "failure" || kind === "credential" || kind === "evidence") return true
    if (kind === "note" || kind === "hint") return false
    if (kind === "fact") {
        return text.length >= MIN_PROMOTABLE_FACT_CHARS && FINDING_FACT_SIGNAL.test(text)
    }
    return false
}

/** Only terminal hypothesis outcomes are shared target-wide (not pending/testing noise). */
export function shouldPromoteIdeaStatus(status: IdeaStatus): boolean {
    return status === "verified" || status === "failed"
}

function splitFindingLines(proof: string, writeup?: string): string[] {
    const combined = [proof, writeup].filter((part) => part?.trim()).join("\n")
    const lines: string[] = []
    for (const raw of combined.split(/\n+/)) {
        const line = raw.replace(/^[\s#>*•\-]+/, "").trim()
        if (line.length >= MIN_PROMOTABLE_FACT_CHARS) lines.push(line)
    }
    return lines
}

/**
 * Extract high-signal bullets from a finding for challenge-level `fact` memory.
 * Conservative: URL/port/CVE/key patterns only, capped per finding.
 */
export function extractFindingFactLines(proof: string, writeup?: string, maxLines = 5): string[] {
    const seen = new Set<string>()
    const picked: string[] = []
    for (const line of splitFindingLines(proof, writeup)) {
        if (!FINDING_FACT_SIGNAL.test(line)) continue
        const fp = normalizeBoardFingerprint(line)
        if (seen.has(fp)) continue
        seen.add(fp)
        picked.push(line.length > 280 ? `${line.slice(0, 277)}...` : line)
        if (picked.length >= maxLines) break
    }
    return picked
}

export function memoryFingerprintExists(entries: MemoryEntry[], content: string): boolean {
    const fp = normalizeBoardFingerprint(content)
    return entries.some((entry) => normalizeBoardFingerprint(entry.content) === fp)
}

export interface PromoteMemoryResult {
    promoted: boolean
    duplicate: boolean
    entry?: MemoryEntry
}

export interface PromoteIdeaResult {
    promoted: boolean
    duplicate: boolean
    item?: IdeaRecord
}

export function buildPromoteMemoryInput(
    challengeId: string,
    kind: MemoryKind,
    content: string,
    source: string,
    refs?: string[],
): AddMemoryInput {
    return {
        challengeId,
        kind,
        content: content.trim(),
        refs: refs ?? [],
        source: source.trim() || "promoted",
    }
}

export function buildPromoteIdeaInput(content: string, status: IdeaStatus, result?: string): AddIdeaInput {
    return {
        content: content.trim(),
        status,
        result: result?.trim() ?? "",
    }
}
