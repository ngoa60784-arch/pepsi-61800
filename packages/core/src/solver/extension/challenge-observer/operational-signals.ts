import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { requestHostBridge } from "../../../challenge/host-bridge-client"

const DEFENSE_SIGNAL_PATTERN = /ANTI-BAN WARN|\b429\b|rate.?limit|ip[ -]?ban|captcha|cloudflare|akamai|blocked by waf/i

// Background pivot/tunnel failures (chisel / frpc / ssh forwarding / proxychains) are the classic
// "silent loop": a background job retries forever without any foreground tool activity. When the solver
// DOES surface that output (e.g. via ssh_job_poll / ssh_execute on the log), turn it into a failure
// memory so it enters the shared board and wakes the planner instead of being lost.
const PIVOT_FAILURE_PATTERN =
    /cannot listen on|address already in use|connection refused|connection error|no route to host|i\/o timeout|dial tcp .*(refused|timeout)|(chisel|frpc|frps|proxychains|socks)\b.*(error|fail|refused|denied|retry|retrying)|retrying in \d/i

const SIGNAL_TOOL_PATTERN = /^ssh_|^(bash|curl|ffuf|nuclei|sqlmap)$/i

function stringifyResult(value: unknown): string {
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

export function extractDefenseSignal(toolName: string, result: unknown): string | undefined {
    if (!SIGNAL_TOOL_PATTERN.test(toolName)) return
    const text = stringifyResult(result).replace(/\s+/g, " ").trim()
    if (!DEFENSE_SIGNAL_PATTERN.test(text)) return
    return `Automated defense signal from ${toolName}: ${text.slice(0, 240)}`
}

export function extractPivotFailureSignal(toolName: string, result: unknown): string | undefined {
    if (!SIGNAL_TOOL_PATTERN.test(toolName)) return
    const text = stringifyResult(result).replace(/\s+/g, " ").trim()
    // Don't double-report a defense block as a pivot failure.
    if (DEFENSE_SIGNAL_PATTERN.test(text)) return
    if (!PIVOT_FAILURE_PATTERN.test(text)) return
    return `Pivot/tunnel failure from ${toolName} (a background pivot may be looping without progress — reconsider the tunnel/route): ${text.slice(0, 240)}`
}

export function attachOperationalSignalCapture(pi: ExtensionAPI): void {
    let lastSignal = ""
    pi.on("tool_execution_end", async (event) => {
        const signal = extractDefenseSignal(event.toolName, event.result)
        if (signal && signal !== lastSignal) {
            lastSignal = signal
            await requestHostBridge("challenge_promote_memory", {
                kind: "failure",
                content: signal,
                source: "runtime:defense-signal",
                refs: [],
            }).catch(() => {})
            return
        }
        const pivotSignal = extractPivotFailureSignal(event.toolName, event.result)
        if (pivotSignal && pivotSignal !== lastSignal) {
            lastSignal = pivotSignal
            await requestHostBridge("challenge_promote_memory", {
                kind: "failure",
                content: pivotSignal,
                source: "runtime:pivot-failure",
                refs: [],
            }).catch(() => {})
        }
    })
}
