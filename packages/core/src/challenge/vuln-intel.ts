// Lightweight vuln-intel lookup on the control-plane side: auto-triggered when record_asset(service+version) runs,
// queries NVD + CISA KEV and broadcasts matched exploitable CVEs back to the solver (a progress-driven vuln-discovery loop).
//
// Why on the control plane instead of reusing the vuln-intel MCP: the auto-trigger fires while host-bridge handles state_upsert,
// which is inside the ChallengeManager process and has no access to any solver's MCP session; NVD/KEV are both public HTTP GETs,
// so a direct fetch is the simplest and most reliable. The solver's own deep lookups still go through the vuln-intel MCP (structured + GHSA + PoC).

const NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0"
const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"

// NVD without a key is rate-limited to 5 req/30s. The auto-trigger gets amplified by multiple solvers, so: dedup cache + serial rate-limiting.
const NVD_MIN_INTERVAL_MS = 7000 // Minimum interval between two NVD requests (conservative, leaves headroom)
const RESULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // Don't re-query the same component+version within 6h
const KEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // Cache the KEV list for 24h
const MAX_CVES_REPORTED = 4

export interface VulnHit {
    id: string
    cvss?: number
    severity?: string
    summary: string
    inKev: boolean
}

export interface VulnLookupResult {
    component: string
    version?: string
    hits: VulnHit[]
    queried: boolean // false = cache hit / skipped due to rate-limiting
}

interface CachedResult {
    at: number
    result: VulnLookupResult
}

const resultCache = new Map<string, CachedResult>()
let lastNvdAt = 0
let kevCache: { at: number; ids: Set<string> } | undefined
let nvdQueue: Promise<unknown> = Promise.resolve()

function cacheKey(component: string, version?: string): string {
    return `${component.trim().toLowerCase()}|${(version ?? "").trim().toLowerCase()}`
}

/** Split "nginx 1.25.3" / "OpenSSH 9.2p1" / "Apache/2.4.49" into component name + version (the first token that looks like a version number). */
export function splitServiceVersion(service: string): { component: string; version?: string } {
    const text = service.trim()
    const m = text.match(/^(.*?)[\s/]v?(\d+[\w.\-]*)\b/)
    if (m && m[1].trim()) return { component: m[1].trim(), version: m[2] }
    return { component: text }
}

/** Run one NVD request serially and rate-limited, to avoid multiple concurrent solvers getting NVD to return 403. */
function rateLimitedNvd<T>(fn: () => Promise<T>): Promise<T> {
    const run = nvdQueue.then(async () => {
        const wait = Math.max(0, lastNvdAt + NVD_MIN_INTERVAL_MS - Date.now())
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        lastNvdAt = Date.now()
        return fn()
    })
    // Don't let a previous failure block the queue
    nvdQueue = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

// VULN_INTEL_IMPL_PLACEHOLDER

async function fetchKevIds(signal?: AbortSignal): Promise<Set<string>> {
    if (kevCache && Date.now() - kevCache.at < KEV_CACHE_TTL_MS) return kevCache.ids
    try {
        const res = await fetch(KEV_URL, { signal })
        if (!res.ok) return kevCache?.ids ?? new Set()
        const data = (await res.json()) as { vulnerabilities?: Array<{ cveID?: unknown }> }
        const ids = new Set<string>()
        for (const v of data.vulnerabilities ?? []) {
            if (typeof v.cveID === "string") ids.add(v.cveID.toUpperCase())
        }
        kevCache = { at: Date.now(), ids }
        return ids
    } catch {
        return kevCache?.ids ?? new Set()
    }
}

interface NvdCve {
    id: string
    cvss?: number
    severity?: string
    summary: string
}

function parseNvdResponse(payload: unknown): NvdCve[] {
    const data = payload as { vulnerabilities?: Array<{ cve?: Record<string, unknown> }> }
    const out: NvdCve[] = []
    for (const item of data.vulnerabilities ?? []) {
        const cve = item.cve as
            | {
                  id?: unknown
                  descriptions?: Array<{ lang?: string; value?: string }>
                  metrics?: Record<string, Array<{ cvssData?: { baseScore?: number; baseSeverity?: string } }>>
              }
            | undefined
        if (!cve || typeof cve.id !== "string") continue
        const summary = cve.descriptions?.find((d) => d.lang === "en")?.value?.trim() ?? ""
        // metrics may be cvssMetricV31 / V30 / V2; take the first one that has a score.
        let cvss: number | undefined
        let severity: string | undefined
        for (const key of Object.keys(cve.metrics ?? {})) {
            const m = cve.metrics?.[key]?.[0]?.cvssData
            if (m && typeof m.baseScore === "number") {
                cvss = m.baseScore
                severity = typeof m.baseSeverity === "string" ? m.baseSeverity : undefined
                break
            }
        }
        out.push({ id: cve.id, cvss, severity, summary })
    }
    return out
}

async function queryNvd(component: string, version: string | undefined, signal?: AbortSignal): Promise<NvdCve[]> {
    const keyword = version ? `${component} ${version}` : component
    const url = `${NVD_API}?keywordSearch=${encodeURIComponent(keyword)}&resultsPerPage=20`
    const apiKey = process.env.NVD_API_KEY?.trim()
    return rateLimitedNvd(async () => {
        try {
            const res = await fetch(url, { signal, headers: apiKey ? { apiKey } : undefined })
            if (!res.ok) return []
            return parseNvdResponse(await res.json())
        } catch {
            return []
        }
    })
}

/**
 * Look up exploitable vulnerabilities for a component (optionally with version): NVD hits + flagging which ones are exploited in the wild per CISA KEV.
 * Results are sorted by "in-the-wild first, CVSS descending", taking at most MAX_CVES_REPORTED entries. Backed by a 6h dedup cache.
 */
export async function lookupComponentVulns(component: string, version?: string, signal?: AbortSignal): Promise<VulnLookupResult> {
    const comp = component.trim()
    if (!comp) return { component, version, hits: [], queried: false }

    const key = cacheKey(comp, version)
    const cached = resultCache.get(key)
    if (cached && Date.now() - cached.at < RESULT_CACHE_TTL_MS) {
        return { ...cached.result, queried: false }
    }

    const [cves, kevIds] = await Promise.all([queryNvd(comp, version, signal), fetchKevIds(signal)])
    const hits: VulnHit[] = cves
        .map((cve) => ({
            id: cve.id,
            cvss: cve.cvss,
            severity: cve.severity,
            summary: cve.summary.length > 200 ? `${cve.summary.slice(0, 200)}...` : cve.summary,
            inKev: kevIds.has(cve.id.toUpperCase()),
        }))
        .sort((a, b) => {
            if (a.inKev !== b.inKev) return a.inKev ? -1 : 1 // in-the-wild first
            return (b.cvss ?? 0) - (a.cvss ?? 0) // then by CVSS descending
        })
        .slice(0, MAX_CVES_REPORTED)

    const result: VulnLookupResult = { component: comp, version, hits, queried: true }
    resultCache.set(key, { at: Date.now(), result })
    return result
}

/** Format the lookup result into steer/follow-up copy for the solver. Returns an empty string on no hits (don't nag). */
export function formatVulnBroadcast(result: VulnLookupResult): string {
    if (result.hits.length === 0) return ""
    const label = result.version ? `${result.component} ${result.version}` : result.component
    const lines = result.hits.map((h) => {
        const tags = [h.inKev ? "🔥KEV-in-the-wild" : "", typeof h.cvss === "number" ? `CVSS ${h.cvss}` : h.severity ?? ""].filter(Boolean).join(" ")
        return `- ${h.id}${tags ? ` [${tags}]` : ""}: ${h.summary}`
    })
    return [
        `Auto vuln-intel: the asset you just recorded "${label}" matches the following known vulnerabilities (NVD + CISA KEV, sorted by exploitability):`,
        ...lines,
        `Prioritize verifying the ones tagged 🔥KEV (exploited in the wild, usually with a ready-made PoC). Use the vuln-intel MCP's vuln_exploit_check(cve_id) to find a GitHub PoC, then try exploiting it on the remote Kali.`,
    ].join("\n")
}

