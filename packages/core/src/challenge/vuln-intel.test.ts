import { afterEach, beforeEach, expect, test } from "bun:test"
import {
    formatVulnBroadcast,
    formatVulnStatusNote,
    lookupComponentVulns,
    peekVulnLookupStatus,
    resetVulnIntelStateForTest,
    splitServiceVersion,
} from "./vuln-intel"
import type { VulnLookupResult } from "./vuln-intel"

const originalFetch = globalThis.fetch

beforeEach(() => {
    resetVulnIntelStateForTest()
})

afterEach(() => {
    globalThis.fetch = originalFetch
    resetVulnIntelStateForTest()
})

test("splitServiceVersion separates component and version", () => {
    expect(splitServiceVersion("nginx 1.25.3")).toEqual({ component: "nginx", version: "1.25.3" })
    expect(splitServiceVersion("Apache/2.4.49")).toEqual({ component: "Apache", version: "2.4.49" })
    expect(splitServiceVersion("OpenSSH 9.2p1")).toEqual({ component: "OpenSSH", version: "9.2p1" })
    // no version → treat the whole string as the component name
    expect(splitServiceVersion("WordPress")).toEqual({ component: "WordPress" })
})

test("formatVulnBroadcast returns empty string when no hits (don't nag)", () => {
    const result: VulnLookupResult = { component: "nginx", version: "1.25.3", hits: [], queried: true, status: "ok" }
    expect(formatVulnBroadcast(result)).toBe("")
})

test("formatVulnBroadcast surfaces KEV tag and CVE list for the solver", () => {
    const result: VulnLookupResult = {
        component: "Apache",
        version: "2.4.49",
        hits: [
            { id: "CVE-2021-41773", cvss: 7.5, severity: "HIGH", summary: "Path traversal in Apache 2.4.49", inKev: true },
            { id: "CVE-2021-42013", cvss: 9.8, severity: "CRITICAL", summary: "RCE via path traversal", inKev: false },
        ],
        queried: true,
        status: "ok",
    }
    const text = formatVulnBroadcast(result)
    expect(text).toContain("Apache 2.4.49")
    expect(text).toContain("CVE-2021-41773")
    expect(text).toContain("🔥KEV-in-the-wild")
    expect(text).toContain("CVSS 7.5")
    expect(text).toContain("vuln_exploit_check")
})

test("formatVulnStatusNote explains queued and rate_limited states", () => {
    expect(formatVulnStatusNote("queued", "nginx", "1.25.3")).toContain("queued")
    expect(formatVulnStatusNote("rate_limited", "nginx", "1.25.3")).toContain("rate limit")
})

test("lookupComponentVulns returns rate_limited on NVD 429", async () => {
    let nvdCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("nvd.nist.gov")) {
            nvdCalls += 1
            return new Response("too many", { status: 429 })
        }
        if (url.includes("cisa.gov")) {
            return new Response(JSON.stringify({ vulnerabilities: [] }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
    }) as typeof fetch

    const result = await lookupComponentVulns("nginx", "1.25.3")
    expect(result.status).toBe("rate_limited")
    expect(result.hits).toEqual([])
    expect(nvdCalls).toBe(1)
})

test("concurrent lookups for same component merge in-flight requests", async () => {
    let nvdCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("nvd.nist.gov")) {
            nvdCalls += 1
            await new Promise((r) => setTimeout(r, 30))
            return new Response(
                JSON.stringify({
                    vulnerabilities: [
                        {
                            cve: {
                                id: "CVE-TEST-1",
                                descriptions: [{ lang: "en", value: "test vuln" }],
                                metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.1, baseSeverity: "CRITICAL" } }] },
                            },
                        },
                    ],
                }),
                { status: 200 },
            )
        }
        if (url.includes("cisa.gov")) {
            return new Response(JSON.stringify({ vulnerabilities: [] }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
    }) as typeof fetch

    const component = `dedup-widget-${Date.now()}`
    const [first, second] = await Promise.all([
        lookupComponentVulns(component, "1.0"),
        lookupComponentVulns(component, "1.0"),
    ])
    expect(nvdCalls).toBe(1)
    expect(first.status).toBe("ok")
    expect(second.status).toBe("ok")
    expect(first.hits[0]?.id).toBe("CVE-TEST-1")
})

test("peekVulnLookupStatus returns cache_hit after first lookup", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("nvd.nist.gov")) {
            return new Response(JSON.stringify({ vulnerabilities: [] }), { status: 200 })
        }
        if (url.includes("cisa.gov")) {
            return new Response(JSON.stringify({ vulnerabilities: [] }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
    }) as typeof fetch

    await lookupComponentVulns("apache", "2.4.49")
    expect(peekVulnLookupStatus("apache", "2.4.49").status).toBe("cache_hit")
})
