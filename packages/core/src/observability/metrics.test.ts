import { afterEach, describe, expect, test } from "bun:test"
import {
    buildRuntimeMetricsSnapshot,
    formatPrometheusMetrics,
    recordRpcStdoutPollution,
    resetRuntimeMetricsForTest,
    tryParseStdoutJsonlLine,
} from "./metrics"

afterEach(() => {
    resetRuntimeMetricsForTest()
})

describe("rpc stdout pollution metrics", () => {
    test("tryParseStdoutJsonlLine accepts valid JSON", () => {
        const result = tryParseStdoutJsonlLine('{"type":"response","success":true}')
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.value).toMatchObject({ type: "response", success: true })
        }
    })

    test("tryParseStdoutJsonlLine rejects non-JSON stdout pollution", () => {
        const result = tryParseStdoutJsonlLine("hello from accidental console.log")
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.sample).toContain("console.log")
        }
    })

    test("recordRpcStdoutPollution increments snapshot counter", () => {
        recordRpcStdoutPollution("dirty line")
        const snapshot = buildRuntimeMetricsSnapshot({
            activeSolvers: 0,
            runningChallenges: 0,
            maxActiveChallenges: 3,
            sseSubscribers: 0,
            plannerConsecutiveFailures: 0,
            plannerLastError: null,
            plannerCurrentTickIntervalMs: 30_000,
        })
        expect(snapshot.rpc_stdout_pollution_total).toBe(1)
        expect(snapshot.rpc_stdout_pollution_last_sample).toBe("dirty line")
    })

    test("formatPrometheusMetrics exposes pollution counter", () => {
        recordRpcStdoutPollution("oops")
        const text = formatPrometheusMetrics(
            buildRuntimeMetricsSnapshot({
                activeSolvers: 2,
                runningChallenges: 1,
                maxActiveChallenges: 3,
                sseSubscribers: 3,
                plannerConsecutiveFailures: 0,
                plannerLastError: null,
                plannerCurrentTickIntervalMs: 30_000,
            }),
        )
        expect(text).toContain("tch_rpc_stdout_pollution_total 1")
        expect(text).toContain("tch_active_solvers 2")
    })
})
