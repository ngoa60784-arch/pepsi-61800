export interface RuntimeMetricsSnapshot {
    planner_rounds_total: number
    planner_failures_total: number
    rpc_stdout_pollution_total: number
    rpc_stdout_pollution_last_sample: string | null
    active_solvers: number
    running_challenges: number
    max_active_challenges: number
    sse_subscribers: number
    planner_consecutive_failures: number
    planner_last_error: string | null
    planner_current_tick_interval_ms: number
    collected_at: string
}

const state = {
    plannerRoundsTotal: 0,
    plannerFailuresTotal: 0,
    rpcStdoutPollutionTotal: 0,
    rpcStdoutPollutionLastSample: null as string | null,
}

export function recordPlannerRoundSuccess(): void {
    state.plannerRoundsTotal += 1
}

export function recordPlannerRoundFailure(): void {
    state.plannerFailuresTotal += 1
}

export function recordRpcStdoutPollution(line: string): void {
    state.rpcStdoutPollutionTotal += 1
    const sample = line.trim().slice(0, 200)
    state.rpcStdoutPollutionLastSample = sample || "(empty line)"
}

export function tryParseStdoutJsonlLine(line: string): { ok: true; value: unknown } | { ok: false; sample: string } {
    const trimmed = line.trim()
    if (!trimmed) return { ok: false, sample: "(empty line)" }
    try {
        return { ok: true, value: JSON.parse(trimmed) as unknown }
    } catch {
        return { ok: false, sample: trimmed.slice(0, 200) }
    }
}

export function buildRuntimeMetricsSnapshot(input: {
    activeSolvers: number
    runningChallenges: number
    maxActiveChallenges: number
    sseSubscribers: number
    plannerConsecutiveFailures: number
    plannerLastError: string | null
    plannerCurrentTickIntervalMs: number
}): RuntimeMetricsSnapshot {
    return {
        planner_rounds_total: state.plannerRoundsTotal,
        planner_failures_total: state.plannerFailuresTotal,
        rpc_stdout_pollution_total: state.rpcStdoutPollutionTotal,
        rpc_stdout_pollution_last_sample: state.rpcStdoutPollutionLastSample,
        active_solvers: input.activeSolvers,
        running_challenges: input.runningChallenges,
        max_active_challenges: input.maxActiveChallenges,
        sse_subscribers: input.sseSubscribers,
        planner_consecutive_failures: input.plannerConsecutiveFailures,
        planner_last_error: input.plannerLastError,
        planner_current_tick_interval_ms: input.plannerCurrentTickIntervalMs,
        collected_at: new Date().toISOString(),
    }
}

export function formatPrometheusMetrics(snapshot: RuntimeMetricsSnapshot): string {
    const lines = [
        "# HELP tch_planner_rounds_total Planner scheduling rounds completed successfully.",
        "# TYPE tch_planner_rounds_total counter",
        `tch_planner_rounds_total ${snapshot.planner_rounds_total}`,
        "# HELP tch_planner_failures_total Planner scheduling round failures.",
        "# TYPE tch_planner_failures_total counter",
        `tch_planner_failures_total ${snapshot.planner_failures_total}`,
        "# HELP tch_rpc_stdout_pollution_total Non-JSON lines read from solver RPC stdout.",
        "# TYPE tch_rpc_stdout_pollution_total counter",
        `tch_rpc_stdout_pollution_total ${snapshot.rpc_stdout_pollution_total}`,
        "# HELP tch_active_solvers Currently active solver instances.",
        "# TYPE tch_active_solvers gauge",
        `tch_active_solvers ${snapshot.active_solvers}`,
        "# HELP tch_running_challenges Challenge instances in running state.",
        "# TYPE tch_running_challenges gauge",
        `tch_running_challenges ${snapshot.running_challenges}`,
        "# HELP tch_max_active_challenges Maximum concurrent running challenge instances.",
        "# TYPE tch_max_active_challenges gauge",
        `tch_max_active_challenges ${snapshot.max_active_challenges}`,
        "# HELP tch_sse_subscribers Active challenge progress SSE subscribers.",
        "# TYPE tch_sse_subscribers gauge",
        `tch_sse_subscribers ${snapshot.sse_subscribers}`,
        "# HELP tch_planner_consecutive_failures Current consecutive planner failures.",
        "# TYPE tch_planner_consecutive_failures gauge",
        `tch_planner_consecutive_failures ${snapshot.planner_consecutive_failures}`,
    ]
    return `${lines.join("\n")}\n`
}

export function resetRuntimeMetricsForTest(): void {
    state.plannerRoundsTotal = 0
    state.plannerFailuresTotal = 0
    state.rpcStdoutPollutionTotal = 0
    state.rpcStdoutPollutionLastSample = null
}
