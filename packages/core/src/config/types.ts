export interface AddResult {
    id: string
    rejected?: string
}

/** Result of setting one model-pref as the fleet-wide default. */
export interface ActivateModelResult {
    defaultModelPrefId: string
    promptsUpdated: number
    plannerUpdated: boolean
    verifierUpdated: boolean
}

/** Where authorized target commands execute. Default `remote-vps` (kali-arsenal MCP). */
export type ExecSurfaceMode = "remote-vps" | "local-host"

export interface HostRuntimeSettings {
    env?: Record<string, string>
    solverEnv?: Record<string, string>
    maxSolvers?: number
    /** Command execution surface for authorized targets. */
    execSurface?: ExecSurfaceMode
}

export interface HostChallengeSettings {
    /** Max automatic verifier re-runs after inconclusive (default 3). `0` disables auto-retry. */
    verifierAutoRetryMax?: number
    /** Base delay ms before first auto-retry; doubles each attempt (default 60_000). */
    verifierAutoRetryBaseMs?: number
    /**
     * When `true` (default), objective completion requires verifier `verified` or operator confirm.
     * When `false`, inconclusive submissions may offer skip-verification after grace period.
     */
    verifierRequired?: boolean
    /** Minutes an inconclusive submission must age before skip-verification prompt (default 30). */
    verifierSkipGraceMinutes?: number
}

export interface HostPlannerSettings {
    enabled?: boolean
    strategy?: string
    tickIntervalMs?: number
    staleTimeoutMs?: number
}

export interface HostSettings {
    runtime: HostRuntimeSettings
    challenge: HostChallengeSettings
    planner: HostPlannerSettings
    /**
     * Global default Agent model (model-pref id). All agents (planner/solver/verifier/commander/observer)
     * fall back here when the prompt does not declare a model. One UI choice, consistent fleet.
     */
    defaultModelPrefId?: string
}
