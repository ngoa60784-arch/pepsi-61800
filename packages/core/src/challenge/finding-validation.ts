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

// Shell / RCE signals — required when the engagement objective explicitly demands server access.
const SHELL_EVIDENCE_PATTERNS: RegExp[] = [
    /\buid=\d+\b/i,
    /\bgid=\d+\b/i,
    /\bnt authority\\system\b/i,
    /\b[\w.-]+@[\w.-]+:[~/][^\s]*[$#]/, // user@host:/path$  style prompt
    /\bMicrosoft Windows \[Version/i,
    /\b[A-Z]:\\Windows\\system32/i,
    /root:.*:0:0:/, // /etc/passwd line
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

// Strong evidence signals: matching any one is treated as a concrete credential/artifact, enough to back objective_achieved.
const STRONG_EVIDENCE_PATTERNS: RegExp[] = [
    ...SHELL_EVIDENCE_PATTERNS,
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

/** Engagement text that means "primary objective = host/server control", not merely app/API admin. */
const SERVER_ACCESS_OBJECTIVE_PATTERN =
    /(?:服务器权限|拿(?:到|下)?(?:服务器|主机|机器)(?:权限|控制权)?|get\s+(?:server|host|machine)\s+(?:access|shell|root)|obtain\s+(?:server|host)\s+(?:access|control)|interactive\s+shell|remote\s+code\s+execution|\bRCE\b|root\s+shell|shell\s+on\s+(?:the\s+)?(?:server|host|target))/i

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

export interface ValidateObjectiveEvidenceOptions {
    /** Target title + description — used to require shell/RCE proof when the engagement asks for server access. */
    objectiveText?: string
}

const MIN_COMBINED_LENGTH = 40

export function requiresServerAccessObjective(objectiveText: string): boolean {
    const text = objectiveText.trim()
    if (!text) return false
    return SERVER_ACCESS_OBJECTIVE_PATTERN.test(text)
}

function hasShellEvidence(combined: string): boolean {
    return SHELL_EVIDENCE_PATTERNS.some((pattern) => pattern.test(combined))
}

/**
 * Decide whether a proof (+writeup) is enough to back automatic wind-down on a "primary objective achieved" claim.
 * When sufficient=false, the caller should downgrade objective_achieved to an ordinary finding and prompt for more evidence.
 */
export function validateObjectiveEvidence(
    proof: string,
    writeup?: string,
    options?: ValidateObjectiveEvidenceOptions,
): ObjectiveEvidenceResult {
    const proofText = (proof ?? "").trim()
    const extra = (writeup ?? "").trim()
    const combined = `${proofText}\n${extra}`.trim()
    const needsShell = requiresServerAccessObjective(options?.objectiveText ?? "")

    if (combined.length < MIN_COMBINED_LENGTH) {
        return {
            sufficient: false,
            reason: needsShell
                ? "evidence too short — server-access objectives need fresh shell/RCE proof (command output with uid=, interactive prompt, or equivalent), not a one-line claim"
                : "evidence too short — a primary-objective claim needs concrete proof (command output, shell prompt, file contents, captured credential, HTTP response, or DB dump), not a one-line claim",
        }
    }

    const shellHit = hasShellEvidence(combined)
    const strongHit = STRONG_EVIDENCE_PATTERNS.some((pattern) => pattern.test(combined))
    if (strongHit) {
        if (needsShell && !shellHit) {
            return {
                sufficient: false,
                reason: "primary objective requires server access (shell/RCE on the engagement target); API tokens, admin JWT, or CMS login alone are not sufficient — attach interactive shell proof (uid=, shell prompt, or fresh command output from the target host)",
            }
        }
        return { sufficient: true, reason: shellHit ? "shell/RCE evidence present" : "strong evidence artifact present" }
    }

    const weakHits = WEAK_EVIDENCE_PATTERNS.reduce((count, pattern) => (pattern.test(combined) ? count + 1 : count), 0)
    if (weakHits >= 2) {
        if (needsShell && !shellHit) {
            return {
                sufficient: false,
                reason: "primary objective requires server access; corroborating signals are not enough without shell/RCE artifacts (uid=, interactive prompt, or target-host command output)",
            }
        }
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
