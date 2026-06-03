// 控制面侧的轻量漏洞情报查询：record_asset(service+version) 时自动触发，
// 查 NVD + CISA KEV，把命中的可利用 CVE 广播回 solver（进度驱动的漏洞发现闭环）。
//
// 为何放控制面而非复用 vuln-intel MCP：自动触发发生在 host-bridge 处理 state_upsert 时，
// 此处在 ChallengeManager 进程内、拿不到某个 solver 的 MCP 会话；NVD/KEV 都是公开 HTTP GET，
// 直接 fetch 最简单、最稳。solver 主动深查仍走 vuln-intel MCP（结构化 + GHSA + PoC）。

const NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0"
const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"

// NVD 无 key 限速 5 req/30s。自动触发会被多 solver 放大，所以：去重缓存 + 串行限流。
const NVD_MIN_INTERVAL_MS = 7000 // 两次 NVD 请求最小间隔（保守，留余量）
const RESULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 同组件+版本 6h 内不重复查
const KEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // KEV 列表 24h 缓存
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
    queried: boolean // false = 命中缓存/被限流跳过
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

/** 把 "nginx 1.25.3" / "OpenSSH 9.2p1" / "Apache/2.4.49" 拆成组件名 + 版本(第一个像版本号的 token)。 */
export function splitServiceVersion(service: string): { component: string; version?: string } {
    const text = service.trim()
    const m = text.match(/^(.*?)[\s/]v?(\d+[\w.\-]*)\b/)
    if (m && m[1].trim()) return { component: m[1].trim(), version: m[2] }
    return { component: text }
}

/** 串行 + 限速地跑一个 NVD 请求，避免多 solver 并发把 NVD 打 403。 */
function rateLimitedNvd<T>(fn: () => Promise<T>): Promise<T> {
    const run = nvdQueue.then(async () => {
        const wait = Math.max(0, lastNvdAt + NVD_MIN_INTERVAL_MS - Date.now())
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        lastNvdAt = Date.now()
        return fn()
    })
    // 不让前一个失败阻塞队列
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
        // metrics 可能是 cvssMetricV31 / V30 / V2，取第一个有分的。
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
 * 查一个组件(可带版本)的可利用漏洞：NVD 命中 + 标注哪些在 CISA KEV 在野。
 * 结果按"在野优先、CVSS 降序"排序，最多取 MAX_CVES_REPORTED 条。带 6h 去重缓存。
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
            if (a.inKev !== b.inKev) return a.inKev ? -1 : 1 // 在野优先
            return (b.cvss ?? 0) - (a.cvss ?? 0) // 再按 CVSS 降序
        })
        .slice(0, MAX_CVES_REPORTED)

    const result: VulnLookupResult = { component: comp, version, hits, queried: true }
    resultCache.set(key, { at: Date.now(), result })
    return result
}

/** 把查询结果格式化成给 solver 的 steer/follow-up 文案。无命中返回空串(不打扰)。 */
export function formatVulnBroadcast(result: VulnLookupResult): string {
    if (result.hits.length === 0) return ""
    const label = result.version ? `${result.component} ${result.version}` : result.component
    const lines = result.hits.map((h) => {
        const tags = [h.inKev ? "🔥KEV-在野" : "", typeof h.cvss === "number" ? `CVSS ${h.cvss}` : h.severity ?? ""].filter(Boolean).join(" ")
        return `- ${h.id}${tags ? ` [${tags}]` : ""}: ${h.summary}`
    })
    return [
        `Auto vuln-intel: 你刚记录的资产 "${label}" 命中以下已知漏洞（NVD + CISA KEV，按可利用性排序）:`,
        ...lines,
        `优先验证标 🔥KEV 的（在野利用，通常有现成 PoC）。用 vuln-intel MCP 的 vuln_exploit_check(cve_id) 查 GitHub PoC，再在远程 Kali 上尝试利用。`,
    ].join("\n")
}

