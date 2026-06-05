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

/** P5-A: where solver brain process runs. Default `docker` until LocalProcessBackend ships. */
export type SolverHostMode = "local" | "docker"

/** P5-B: where authorized target commands execute. Default `remote-vps` (kali-arsenal MCP). */
export type ExecSurfaceMode = "remote-vps" | "local-host"

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
    /** P5-A — solver host: `local` (Bun.spawn rpc) or `docker` (current default). */
    solverHost?: SolverHostMode
    /** P5-B — command execution surface for authorized targets. */
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
