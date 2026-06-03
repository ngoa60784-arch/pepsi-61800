import { test, expect } from "bun:test"
import { splitServiceVersion, formatVulnBroadcast } from "./vuln-intel"
import type { VulnLookupResult } from "./vuln-intel"

test("splitServiceVersion separates component and version", () => {
    expect(splitServiceVersion("nginx 1.25.3")).toEqual({ component: "nginx", version: "1.25.3" })
    expect(splitServiceVersion("Apache/2.4.49")).toEqual({ component: "Apache", version: "2.4.49" })
    expect(splitServiceVersion("OpenSSH 9.2p1")).toEqual({ component: "OpenSSH", version: "9.2p1" })
    // 无版本 → 整串当组件名
    expect(splitServiceVersion("WordPress")).toEqual({ component: "WordPress" })
})

test("formatVulnBroadcast returns empty string when no hits (don't nag)", () => {
    const result: VulnLookupResult = { component: "nginx", version: "1.25.3", hits: [], queried: true }
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
    }
    const text = formatVulnBroadcast(result)
    expect(text).toContain("Apache 2.4.49")
    expect(text).toContain("CVE-2021-41773")
    expect(text).toContain("🔥KEV-在野")
    expect(text).toContain("CVSS 7.5")
    expect(text).toContain("vuln_exploit_check")
})
