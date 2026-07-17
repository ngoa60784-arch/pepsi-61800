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
