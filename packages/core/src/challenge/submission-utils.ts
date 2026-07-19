import type { ChallengeSubmissionLogRecord } from "./store"

/**
 * CTF: correct === true.
 * Engagement: report_finding rows (writeup or verifier status), excluding rejected.
 * Failed CTF flag attempts (correct:false, no writeup) do not count.
 */
export function isRealFinding(item: ChallengeSubmissionLogRecord): boolean {
    if (item.correct) return true
    if (item.verification_status === "rejected") return false
    if (
        item.verification_status === "verified" ||
        item.verification_status === "pending" ||
        item.verification_status === "inconclusive" ||
        item.verification_status === "unverified"
    ) {
        return true
    }
    return Boolean(item.writeup?.trim())
}

/** A recorded, non-rejected finding. Useful for reporting, but not a success signal. */
export function isRecordedFinding(item: ChallengeSubmissionLogRecord): boolean {
    return isRealFinding(item)
}

/** A finding strong enough to drive breakthrough/success scheduling decisions. */
export function isVerifiedFinding(item: ChallengeSubmissionLogRecord): boolean {
    return item.correct === true || item.verification_status === "verified"
}

/**
 * Normalize a reported flag/proof for duplicate detection: trim, collapse internal whitespace.
 * Case is preserved on purpose — flags are usually opaque tokens where case is significant, and we
 * would rather miss a case-only "duplicate" than merge two genuinely different results.
 */
export function normalizeFlagForDedup(flag: string): string {
    return flag.trim().replace(/\s+/g, " ")
}

/**
 * Find an earlier, non-rejected submission on the same target whose flag matches `flag` after
 * normalization — i.e. this new submission re-derives an already-banked result. Returns the earliest
 * such record (the original that first banked it) so callers can point `duplicate_of` at a stable id.
 * Already-duplicate records are skipped as candidates so every duplicate chains back to the original.
 */
export function findDuplicateSubmission(
    existing: ChallengeSubmissionLogRecord[],
    flag: string,
): ChallengeSubmissionLogRecord | undefined {
    const normalized = normalizeFlagForDedup(flag)
    if (!normalized) return undefined
    return [...existing]
        .filter((item) => !item.duplicate_of && item.verification_status !== "rejected" && isRealFinding(item))
        .filter((item) => normalizeFlagForDedup(item.flag) === normalized)
        .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0))[0]
}
