import { describe, expect, test } from "bun:test"
import { extractDefenseSignal, extractPivotFailureSignal } from "./operational-signals"

describe("extractDefenseSignal", () => {
    test("turns anti-ban tool output into a machine-captured defense signal", () => {
        expect(extractDefenseSignal("ssh_execute", "[ANTI-BAN WARN] target returned 429 rate limited"))
            .toContain("Automated defense signal")
    })

    test("ignores ordinary output and unrelated tools", () => {
        expect(extractDefenseSignal("ssh_execute", "200 OK")).toBeUndefined()
        expect(extractDefenseSignal("read", "429 rate limited")).toBeUndefined()
    })
})

describe("extractPivotFailureSignal", () => {
    test("captures a looping chisel reverse-socks failure surfaced via ssh_job_poll", () => {
        const log =
            "client: Connection error: server: Server cannot listen on R:127.0.0.1:1080=>socks (Attempt: 84/unlimited)\nclient: Retrying in 5m0s..."
        const signal = extractPivotFailureSignal("ssh_job_poll", log)
        expect(signal).toBeDefined()
        expect(signal).toContain("Pivot/tunnel failure")
    })

    test("captures a refused proxychains/dial-tcp pivot attempt", () => {
        expect(extractPivotFailureSignal("ssh_execute", "proxychains: connection refused")).toContain("Pivot/tunnel failure")
        expect(extractPivotFailureSignal("bash", "dial tcp 172.51.3.3:80: i/o timeout")).toContain("Pivot/tunnel failure")
    })

    test("does not fire on healthy output, unrelated tools, or a pure defense block", () => {
        expect(extractPivotFailureSignal("ssh_execute", "tunnel established; socks proxy listening on 1080")).toBeUndefined()
        expect(extractPivotFailureSignal("read", "connection refused")).toBeUndefined()
        // A WAF/rate-limit block is a defense signal, not a pivot failure — avoid double-reporting.
        expect(extractPivotFailureSignal("ssh_execute", "blocked by waf, connection refused")).toBeUndefined()
    })
})
