import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { requestHostBridge } from "../../../challenge/host-bridge-client"

const DEFENSE_SIGNAL_PATTERN = /ANTI-BAN WARN|\b429\b|rate.?limit|ip[ -]?ban|captcha|cloudflare|akamai|blocked by waf/i

function stringifyResult(value: unknown): string {
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

export function extractDefenseSignal(toolName: string, result: unknown): string | undefined {
    if (!/^ssh_|^(bash|curl|ffuf|nuclei|sqlmap)$/i.test(toolName)) return
    const text = stringifyResult(result).replace(/\s+/g, " ").trim()
    if (!DEFENSE_SIGNAL_PATTERN.test(text)) return
    return `Automated defense signal from ${toolName}: ${text.slice(0, 240)}`
}

export function attachOperationalSignalCapture(pi: ExtensionAPI): void {
    let lastSignal = ""
    pi.on("tool_execution_end", async (event) => {
        const signal = extractDefenseSignal(event.toolName, event.result)
        if (!signal || signal === lastSignal) return
        lastSignal = signal
        await requestHostBridge("challenge_promote_memory", {
            kind: "failure",
            content: signal,
            source: "runtime:defense-signal",
            refs: [],
        }).catch(() => {})
    })
}
