import { ENGAGEMENT_ENV_MODE, ENGAGEMENT_ENV_SCOPE } from "./env"

/**
 * Engagement-mode scope definition.
 *
 * Unlike CTF mode, an engagement has no remote referee: the target scope, constraints, and end conditions are all defined locally.
 * This scope file is the sole authorization source for engagement mode — without it, or with an empty allowlist, the engine refuses to start.
 */
export interface EngagementScope {
    /** Name of this exercise, used only as a report/audit label (e.g. "HVV-2026-BlueTeamA"). */
    engagement: string
    /** Authorized-target allowlist: IP / domain / CIDR / URL prefix. An empty array is treated as invalid. */
    allowed_targets: string[]
    /** Explicitly excluded targets (takes precedence over allowed_targets); used to carve out sensitive assets within the range. */
    out_of_scope?: string[]
    /** Whether active-scanning commands (nmap/ffuf, etc.) are forbidden. Defaults to false (engagements usually allow scanning). */
    no_scan?: boolean
    /** Additional forbidden command tokens, layered on top of the default forbidden set. */
    forbidden_commands?: string[]
    /** Free-text constraints/notes injected into the solver context (e.g. "no DoS", "working hours only"). */
    rules_of_engagement?: string
}

export interface LoadedEngagement {
    scope: EngagementScope
    scopePath: string
}

/**
 * Whether the current process is in engagement mode.
 *
 * The CTF path has been removed; engagement is the **only** operating form — enabled by default.
 * It is disabled only when `TCH_ENGAGEMENT_MODE=0` is explicitly set (an escape hatch kept mainly for legacy mock tests).
 */
export function isEngagementMode(getEnv: (key: string) => string | undefined = (k) => process.env[k]): boolean {
    return getEnv(ENGAGEMENT_ENV_MODE)?.trim() !== "0"
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
}

/**
 * Validate and normalize a raw scope object.
 * Anything invalid (missing engagement name, empty allowlist) throws — engagement mode does not permit "running with no scope".
 */
export function parseEngagementScope(raw: unknown, scopePath: string): EngagementScope {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`engagement scope file is not a JSON object: ${scopePath}`)
    }
    const data = raw as Record<string, unknown>

    const engagement = typeof data.engagement === "string" ? data.engagement.trim() : ""
    if (!engagement) {
        throw new Error(`engagement scope must define a non-empty "engagement" name: ${scopePath}`)
    }

    const allowedTargets = asStringArray(data.allowed_targets)
    if (allowedTargets.length === 0) {
        throw new Error(
            `engagement scope "allowed_targets" must list at least one authorized target (IP/host/CIDR/URL): ${scopePath}`,
        )
    }

    return {
        engagement,
        allowed_targets: allowedTargets,
        out_of_scope: asStringArray(data.out_of_scope),
        no_scan: typeof data.no_scan === "boolean" ? data.no_scan : false,
        forbidden_commands: asStringArray(data.forbidden_commands),
        rules_of_engagement:
            typeof data.rules_of_engagement === "string" && data.rules_of_engagement.trim()
                ? data.rules_of_engagement.trim()
                : undefined,
    }
}

/**
 * Load the scope from the file pointed to by TCH_ENGAGEMENT_SCOPE.
 * Must succeed in engagement mode, otherwise the caller should refuse to start a solver.
 */
export async function loadEngagementScope(
    getEnv: (key: string) => string | undefined = (k) => process.env[k],
): Promise<LoadedEngagement> {
    const scopePath = getEnv(ENGAGEMENT_ENV_SCOPE)?.trim()
    if (!scopePath) {
        throw new Error(
            `${ENGAGEMENT_ENV_MODE}=1 requires ${ENGAGEMENT_ENV_SCOPE} to point at a scope file defining authorized targets`,
        )
    }

    const file = Bun.file(scopePath)
    if (!(await file.exists())) {
        throw new Error(`engagement scope file not found: ${scopePath}`)
    }

    let raw: unknown
    try {
        raw = await file.json()
    } catch {
        throw new Error(`engagement scope file is not valid JSON: ${scopePath}`)
    }

    return { scope: parseEngagementScope(raw, scopePath), scopePath }
}
