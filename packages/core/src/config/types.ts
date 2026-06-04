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

export interface HostRuntimeSettings {
    image?: string
    env?: Record<string, string>
    solverEnv?: Record<string, string>
    binds?: string[]
    maxSolvers?: number
    networkMode?: "bridge" | "host"
    /**
     * Per-solver container memory cap (docker backend only), Docker `--memory` syntax, e.g. "2g" / "512m".
     * Omit for unlimited — a runaway scan/brute may exhaust host memory.
     */
    memory?: string
    /**
     * Per-solver container CPU cap (docker only), Docker `--cpus` syntax, e.g. 1.5 / 2.
     * Omit for unlimited.
     */
    cpus?: number
}

/** Reserved for future host-level challenge options; engagement targets are managed in the UI. */
export interface HostChallengeSettings {}

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
