/**
 * Assertion-based evidence gate for engagement findings.
 *
 * Background: when a solver self-reports objective_achieved=true, the engine stops every solver on
 * that target and the planner stops dispatching more. Models sometimes "declare victory" with no real
 * proof (hallucinated RCE / mistaking a single error for a shell), and a wrongful stop wastes the
 * entire line of attack. Here objective_achieved must carry a concrete evidence signal; otherwise it
 * is downgraded to an ordinary finding (still recorded, but no automatic wind-down), letting the
 * operator / other solvers keep pushing instead of being halted by an empty claim.
 *
 * This is a heuristic gate, not a judge: better to let through a few genuine findings (downgraded
 * findings are still recorded and can still be confirmed by the operator) than to let one
 * evidence-free "achieved" shut down the whole target.
 */

// Strong evidence signals: matching any one is treated as a concrete credential/artifact, enough to back objective_achieved.
const STRONG_EVIDENCE_PATTERNS: RegExp[] = [
    // shell / RCE: id output, root prompt, Windows whoami
    /\buid=\d+\b/i,
    /\bgid=\d+\b/i,
    /\bnt authority\\system\b/i,
    /\b[\w.-]+@[\w.-]+:[~/][^\s]*[$#]/, // user@host:/path$  style prompt
    /\bMicrosoft Windows \[Version/i,
    /\b[A-Z]:\\Windows\\system32/i,
    // sensitive file contents
    /root:.*:0:0:/, // /etc/passwd line
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    // credentials / hashes / tokens
    /\$2[abxy]?\$\d{1,2}\$[./A-Za-z0-9]{20,}/, // bcrypt ($2y$10$...)
    /\$[1356]\$[./A-Za-z0-9$]{8,}/, // md5crypt / sha256crypt / sha512crypt
    /\b[a-f0-9]{32}\b/i, // md5
    /\b[a-f0-9]{40}\b/i, // sha1
    /\b[a-f0-9]{64}\b/i, // sha256
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, // JWT
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
    // SQLi / database dump
    /\binformation_schema\b/i,
    /\b(?:mysql|mariadb|postgresql|microsoft sql server)\b.*\b\d+\.\d+/i,
    // HTTP response evidence
    /\bHTTP\/\d(?:\.\d)?\s+\d{3}\b/,
]

// Weak evidence signals: not enough alone; need >= 2 matches (and sufficiently long text) to count as an artifact.
const WEAK_EVIDENCE_PATTERNS: RegExp[] = [
    /\b(?:whoami|hostname|ifconfig|ip addr|netstat|systeminfo)\b/i,
    /\/(?:etc|var|home|root|proc|usr)\//,
    /\bcurl\b|\bwget\b|\bnc\b|\bncat\b/i,
    /\bbase64\b/i,
    /\bcookie\b|\bsession\b|\btoken\b|\bpassword\b|\bpasswd\b/i,
    /\bport\s+\d{1,5}\b|\b:\d{2,5}\/\b/,
    /```|\$\s|\#\s/, // code block / command prompt fragment
]

// Bare-claim red flag: when short text contains only these "declare victory" words with no artifact, it is almost certainly an empty report.
const BARE_CLAIM_PATTERN =
    /\b(?:rce achieved|got (?:a )?shell|objective (?:complete|achieved|met)|success(?:fully)?|done|pwned|confirmed rce|i (?:have|got)|we (?:have|got)|fully compromised)\b/i

export interface ObjectiveEvidenceResult {
    sufficient: boolean
    reason: string
}

const MIN_COMBINED_LENGTH = 40

/**
 * Decide whether a proof (+writeup) is enough to back automatic wind-down on a "primary objective achieved" claim.
 * When sufficient=false, the caller should downgrade objective_achieved to an ordinary finding and prompt for more evidence.
 */
export function validateObjectiveEvidence(proof: string, writeup?: string): ObjectiveEvidenceResult {
    const proofText = (proof ?? "").trim()
    const extra = (writeup ?? "").trim()
    const combined = `${proofText}\n${extra}`.trim()

    if (combined.length < MIN_COMBINED_LENGTH) {
        return {
            sufficient: false,
            reason: "evidence too short — a primary-objective claim needs concrete proof (command output, shell prompt, file contents, captured credential, HTTP response, or DB dump), not a one-line claim",
        }
    }

    const strongHit = STRONG_EVIDENCE_PATTERNS.some((pattern) => pattern.test(combined))
    if (strongHit) {
        return { sufficient: true, reason: "strong evidence artifact present" }
    }

    const weakHits = WEAK_EVIDENCE_PATTERNS.reduce((count, pattern) => (pattern.test(combined) ? count + 1 : count), 0)
    if (weakHits >= 2) {
        return { sufficient: true, reason: "multiple corroborating evidence signals present" }
    }

    // Only a claim, no artifact -> judged insufficient.
    if (BARE_CLAIM_PATTERN.test(combined)) {
        return {
            sufficient: false,
            reason: "looks like a bare success claim with no concrete artifact — attach the actual command output / shell evidence / captured credential that proves the objective",
        }
    }

    // Neither a strong signal nor at least 2 weak signals: conservatively judged insufficient (still recorded as an ordinary finding).
    return {
        sufficient: false,
        reason: "could not detect a concrete evidence artifact — include the raw proof (command output, file contents, credential, HTTP/DB response) so the objective can be auto-confirmed",
    }
}
