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
