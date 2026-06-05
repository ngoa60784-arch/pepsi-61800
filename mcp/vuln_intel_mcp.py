#!/usr/bin/env python3
"""
Vuln Intel MCP — 实时漏洞情报
═══════════════════════════════════════════════════════════════
四个公开 API 直接拉, 无缓存, 无本地数据库, 永远新鲜:
  - NVD (CVE 主源)             https://services.nvd.nist.gov/rest/json/cves/2.0
  - OSV.dev (Google, 多生态系统) https://api.osv.dev/v1/query
  - GHSA (GitHub Advisory)     GraphQL via GITHUB_TOKEN
  - CISA KEV (在野利用)         静态 JSON

返回结构化摘要 (markdown 表格 + 关键字段),不是 raw JSON,模型直接读。

依赖: pip install httpx
"""

import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote_plus

import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("vuln_intel")

# ═══════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════
NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0"
OSV_API = "https://api.osv.dev/v1/query"
GHSA_GRAPHQL = "https://api.github.com/graphql"
KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
GH_REST = "https://api.github.com"
EXPLOITDB_RSS = "https://www.exploit-db.com/rss.xml"

# NVD 公开 IP 限速 5 req / 30s, 带 key 50 req / 30s
NVD_API_KEY = os.getenv("NVD_API_KEY", "")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "") or os.getenv("GITHUB_PAT", "")

USER_AGENT = "vuln-intel-mcp/1.0 (pentest research)"
HTTP_TIMEOUT = 20.0

# Align with core vuln-intel.ts: 24h dedup cache + serial NVD pacing (public API ~5 req/30s).
_NVD_CACHE_TTL = timedelta(hours=24)
_NVD_MIN_INTERVAL_SEC = 7.0
_nvd_cache: dict[str, tuple[datetime, list[dict]]] = {}
_nvd_lock = asyncio.Lock()
_last_nvd_at = 0.0


def _nvd_cache_key(params: dict) -> str:
    return json.dumps(params, sort_keys=True, ensure_ascii=False)


async def _rate_limited_nvd(client: httpx.AsyncClient, params: dict) -> list[dict]:
    global _last_nvd_at
    key = _nvd_cache_key(params)
    cached = _nvd_cache.get(key)
    if cached and datetime.now(timezone.utc) - cached[0] < _NVD_CACHE_TTL:
        return cached[1]

    async with _nvd_lock:
        cached = _nvd_cache.get(key)
        if cached and datetime.now(timezone.utc) - cached[0] < _NVD_CACHE_TTL:
            return cached[1]
        wait = max(0.0, _NVD_MIN_INTERVAL_SEC - (datetime.now(timezone.utc).timestamp() - _last_nvd_at))
        if wait > 0:
            await asyncio.sleep(wait)
        results = await _nvd_query(client, params)
        _last_nvd_at = datetime.now(timezone.utc).timestamp()
        if results and not results[0].get("_error"):
            _nvd_cache[key] = (datetime.now(timezone.utc), results)
        return results


def _client() -> httpx.AsyncClient:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    # trust_env=False — 忽略系统代理 (尤其 SOCKS 系 ALL_PROXY),
    # 这些 API 直接走出口 IP 即可, 不需要走代理。
    # 如果未来需要走 HTTP/HTTPS 代理, 在此处显式 proxies= 参数指定。
    return httpx.AsyncClient(
        timeout=HTTP_TIMEOUT,
        headers=headers,
        follow_redirects=True,
        trust_env=False,
    )


def _truncate(s: str, n: int = 200) -> str:
    s = (s or "").strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


# ═══════════════════════════════════════════════════════════════
# NVD
# ═══════════════════════════════════════════════════════════════

async def _nvd_query(client: httpx.AsyncClient, params: dict) -> list[dict]:
    headers = {}
    if NVD_API_KEY:
        headers["apiKey"] = NVD_API_KEY
    try:
        r = await client.get(NVD_API, params=params, headers=headers)
        if r.status_code == 429:
            return [{"_error": "NVD 429 — rate limited; retry later or set NVD_API_KEY"}]
        if r.status_code == 403:
            return [{"_error": "NVD 403 — 限速 (5 req/30s 无 key) 或 IP 被封"}]
        r.raise_for_status()
        data = r.json()
    except (httpx.HTTPError, json.JSONDecodeError) as e:
        return [{"_error": f"NVD 请求失败: {type(e).__name__}: {e}"}]

    out = []
    for item in data.get("vulnerabilities", []):
        cve = item.get("cve", {})
        cve_id = cve.get("id", "?")
        descs = cve.get("descriptions", [])
        desc = next((d.get("value", "") for d in descs if d.get("lang") == "en"), "")
        published = cve.get("published", "")[:10]
        # CVSS — 优先 v3.1 > v3.0 > v2
        metrics = cve.get("metrics", {})
        cvss_score = None
        cvss_severity = None
        cvss_vector = None
        for key in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
            arr = metrics.get(key) or []
            if arr:
                m = arr[0].get("cvssData", {})
                cvss_score = m.get("baseScore")
                cvss_severity = m.get("baseSeverity") or arr[0].get("baseSeverity")
                cvss_vector = m.get("vectorString")
                break
        refs = [r.get("url", "") for r in cve.get("references", [])][:5]
        out.append({
            "cve_id": cve_id,
            "published": published,
            "score": cvss_score,
            "severity": cvss_severity,
            "vector": cvss_vector,
            "description": _truncate(desc, 280),
            "refs": refs,
        })
    return out


# ═══════════════════════════════════════════════════════════════
# OSV.dev
# ═══════════════════════════════════════════════════════════════

async def _osv_query(client: httpx.AsyncClient, package_name: str, ecosystem: str = "", version: str = "") -> list[dict]:
    body: dict = {"package": {"name": package_name}}
    if ecosystem:
        body["package"]["ecosystem"] = ecosystem
    if version:
        body["version"] = version
    try:
        r = await client.post(OSV_API, json=body)
        r.raise_for_status()
        data = r.json()
    except (httpx.HTTPError, json.JSONDecodeError) as e:
        return [{"_error": f"OSV 请求失败: {type(e).__name__}: {e}"}]

    out = []
    for vuln in data.get("vulns", []) or []:
        ids = [vuln.get("id", "")] + [a.get("id", "") for a in vuln.get("aliases", []) or []]
        cve_ids = [i for i in ids if i and i.startswith("CVE-")]
        published = (vuln.get("published") or "")[:10]
        summary = vuln.get("summary") or ""
        details = vuln.get("details") or ""
        # severity (CVSS 字段不一致, 取第一个)
        severity = ""
        for s in vuln.get("severity") or []:
            severity = f"{s.get('type','?')}={s.get('score','?')}"
            break
        refs = [r.get("url", "") for r in vuln.get("references", []) or []][:5]
        out.append({
            "id": vuln.get("id"),
            "cve_ids": cve_ids,
            "published": published,
            "severity": severity,
            "summary": _truncate(summary or details, 280),
            "refs": refs,
        })
    return out


# ═══════════════════════════════════════════════════════════════
# GHSA (GitHub Advisory) via GraphQL
# ═══════════════════════════════════════════════════════════════

async def _ghsa_search(client: httpx.AsyncClient, query: str, first: int = 10) -> list[dict]:
    if not GITHUB_TOKEN:
        return [{"_error": "未设置 GITHUB_TOKEN, 跳过 GHSA"}]

    gql = """
    query($q: String!, $first: Int!) {
      securityAdvisories(query: $q, first: $first, orderBy: {field: PUBLISHED_AT, direction: DESC}) {
        nodes {
          ghsaId
          summary
          severity
          publishedAt
          identifiers { type value }
          references { url }
          vulnerabilities(first: 5) {
            nodes {
              package { ecosystem name }
              vulnerableVersionRange
              firstPatchedVersion { identifier }
            }
          }
        }
      }
    }
    """
    try:
        r = await client.post(
            GHSA_GRAPHQL,
            json={"query": gql, "variables": {"q": query, "first": first}},
            headers={"Authorization": f"Bearer {GITHUB_TOKEN}"},
        )
        r.raise_for_status()
        data = r.json()
    except (httpx.HTTPError, json.JSONDecodeError) as e:
        return [{"_error": f"GHSA 请求失败: {type(e).__name__}: {e}"}]

    if "errors" in data:
        return [{"_error": f"GHSA GraphQL errors: {data['errors']}"}]

    out = []
    for n in (data.get("data") or {}).get("securityAdvisories", {}).get("nodes", []) or []:
        ids = [(i.get("type", ""), i.get("value", "")) for i in n.get("identifiers", []) or []]
        cve = next((v for t, v in ids if t == "CVE"), "")
        vulns = []
        for v in (n.get("vulnerabilities") or {}).get("nodes", []) or []:
            pkg = v.get("package") or {}
            vulns.append(f"{pkg.get('ecosystem','?')}:{pkg.get('name','?')} {v.get('vulnerableVersionRange','?')} → {((v.get('firstPatchedVersion') or {}).get('identifier')) or 'no-fix'}")
        out.append({
            "ghsa_id": n.get("ghsaId"),
            "cve_id": cve,
            "severity": n.get("severity"),
            "published": (n.get("publishedAt") or "")[:10],
            "summary": _truncate(n.get("summary", ""), 280),
            "affected": vulns,
            "refs": [r.get("url", "") for r in (n.get("references") or [])][:5],
        })
    return out


# ═══════════════════════════════════════════════════════════════
# CISA KEV (in-the-wild)
# ═══════════════════════════════════════════════════════════════

async def _kev_fetch(client: httpx.AsyncClient) -> list[dict]:
    try:
        r = await client.get(KEV_URL)
        r.raise_for_status()
        return r.json().get("vulnerabilities", []) or []
    except (httpx.HTTPError, json.JSONDecodeError) as e:
        return [{"_error": f"KEV 请求失败: {type(e).__name__}: {e}"}]


# ═══════════════════════════════════════════════════════════════
# 渲染助手
# ═══════════════════════════════════════════════════════════════

def _md_table(rows: list[dict], cols: list[tuple[str, str]]) -> str:
    """rows: list of dict; cols: [(header, key), ...]"""
    if not rows:
        return "(no rows)"
    head = "| " + " | ".join(h for h, _ in cols) + " |"
    sep = "|" + "|".join("---" for _ in cols) + "|"
    body = []
    for r in rows:
        body.append("| " + " | ".join(str(r.get(k, "") or "") for _, k in cols) + " |")
    return "\n".join([head, sep] + body)


# ████████████████████████████████████████████████████████████████
# Tools
# ████████████████████████████████████████████████████████████████

@mcp.tool()
async def vuln_search(
    component: str,
    version: str = "",
    ecosystem: str = "",
    limit: int = 10,
) -> str:
    """实时查 NVD + OSV + GHSA, 返回结构化漏洞清单。

    Args:
        component: 组件/产品名 (如 "nginx", "spring-framework", "log4j")
        version: 可选, 版本号 (如 "1.18.0")
        ecosystem: 可选, OSV 生态系统标识 (npm/pypi/Go/Maven/RubyGems/crates.io/Packagist/NuGet/Hex)
                   不填会尝试通用搜索
        limit: 每个源最多返回几条 (默认 10, 最大 30)

    返回 markdown 表格, 按源分块, 含 CVE / CVSS / published / refs。
    """
    if not component.strip():
        return "[ERROR] component 不能为空"
    n = max(1, min(limit, 30))
    q = component.strip() + (f" {version}" if version else "")

    async with _client() as client:
        # NVD: keywordSearch
        nvd_params = {"keywordSearch": q, "resultsPerPage": n}
        # OSV: package query
        osv_results = []
        if ecosystem:
            osv_results = await _osv_query(client, component, ecosystem, version)
        elif version:
            # 没指定生态系统时,尝试不带 ecosystem 的查询
            osv_results = await _osv_query(client, component, version=version)

        nvd_task = _rate_limited_nvd(client, nvd_params)
        ghsa_task = _ghsa_search(client, q, first=n)
        nvd_results, ghsa_results = await asyncio.gather(nvd_task, ghsa_task)

    out = [f"# Vuln search: `{q}`" + (f" ({ecosystem})" if ecosystem else ""), ""]

    # NVD
    out.append("## NVD")
    if nvd_results and nvd_results[0].get("_error"):
        out.append(f"_{nvd_results[0]['_error']}_")
    elif not nvd_results:
        out.append("_no results_")
    else:
        for v in nvd_results[:n]:
            sev = v.get("severity") or "?"
            score = v.get("score")
            score_s = f"{score}" if score is not None else "?"
            out.append(f"- **{v['cve_id']}** [{sev} {score_s}] {v['published']}")
            out.append(f"  {v['description']}")
            if v["refs"]:
                out.append(f"  refs: {' '.join(v['refs'][:3])}")
    out.append("")

    # OSV
    out.append("## OSV.dev")
    if osv_results and osv_results[0].get("_error"):
        out.append(f"_{osv_results[0]['_error']}_")
    elif not osv_results:
        out.append("_no results_ (tip: 指定 ecosystem 参数提高命中,如 ecosystem=\"npm\")")
    else:
        for v in osv_results[:n]:
            cve_part = f" [{', '.join(v['cve_ids'])}]" if v["cve_ids"] else ""
            out.append(f"- **{v['id']}**{cve_part} {v['severity']} {v['published']}")
            out.append(f"  {v['summary']}")
            if v["refs"]:
                out.append(f"  refs: {' '.join(v['refs'][:3])}")
    out.append("")

    # GHSA
    out.append("## GHSA (GitHub Advisory)")
    if ghsa_results and ghsa_results[0].get("_error"):
        out.append(f"_{ghsa_results[0]['_error']}_")
    elif not ghsa_results:
        out.append("_no results_")
    else:
        for v in ghsa_results[:n]:
            cve_part = f" [{v['cve_id']}]" if v["cve_id"] else ""
            out.append(f"- **{v['ghsa_id']}**{cve_part} {v['severity']} {v['published']}")
            out.append(f"  {v['summary']}")
            for a in v["affected"][:3]:
                out.append(f"    affected: {a}")
            if v["refs"]:
                out.append(f"  refs: {' '.join(v['refs'][:3])}")

    return "\n".join(out)


@mcp.tool()
async def vuln_exploit_check(cve_id: str) -> str:
    """检查 CVE 是否在 CISA KEV 在野利用列表 + GitHub 是否有公开 PoC。

    返回:
      - KEV 状态: 是否在野, 加入日期, 攻击行动 (ransomware? actor?)
      - GitHub PoC 搜索: 仓库名 + URL + stars + 描述

    Args:
        cve_id: 形如 "CVE-2024-1234"
    """
    cve_id = cve_id.strip().upper()
    if not re.match(r"^CVE-\d{4}-\d{4,}$", cve_id):
        return f"[ERROR] 不是有效 CVE id: {cve_id!r}"

    async with _client() as client:
        kev_task = _kev_fetch(client)

        # GitHub repo 搜索 — 用 REST search/repositories with q=<cve_id>
        gh_headers = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
        if GITHUB_TOKEN:
            gh_headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"

        async def gh_search() -> list[dict]:
            """GitHub repo search; 如果 token 账号被 flag 为 spammy (HTTP 422),
            回退到无 token 的请求 (60 req/h 配额, 但能用)"""
            async def _try(use_token: bool):
                hdrs = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
                if use_token and GITHUB_TOKEN:
                    hdrs["Authorization"] = f"Bearer {GITHUB_TOKEN}"
                return await client.get(
                    f"{GH_REST}/search/repositories",
                    params={"q": cve_id, "sort": "stars", "order": "desc", "per_page": 10},
                    headers=hdrs,
                )
            try:
                r = await _try(use_token=True)
                # 422 + "spammy" → 用 token 触发 spam-filter, 回退无 token 重试
                if r.status_code == 422 and "spammy" in r.text.lower():
                    r = await _try(use_token=False)
                r.raise_for_status()
                return r.json().get("items", []) or []
            except (httpx.HTTPError, json.JSONDecodeError) as e:
                return [{"_error": f"GitHub 搜索失败: {type(e).__name__}: {e}"}]

        kev_data, gh_repos = await asyncio.gather(kev_task, gh_search())

    out = [f"# Exploit check: {cve_id}", ""]

    # KEV
    out.append("## CISA KEV (在野利用)")
    if kev_data and isinstance(kev_data[0], dict) and kev_data[0].get("_error"):
        out.append(f"_{kev_data[0]['_error']}_")
    else:
        match = next((v for v in kev_data if v.get("cveID", "").upper() == cve_id), None)
        if match:
            out.append(f"- **状态**: 🚨 IN KEV")
            out.append(f"- 加入日期: {match.get('dateAdded', '?')}")
            out.append(f"- 厂商/产品: {match.get('vendorProject', '?')} / {match.get('product', '?')}")
            out.append(f"- 漏洞名: {match.get('vulnerabilityName', '?')}")
            out.append(f"- 已知用于勒索: {match.get('knownRansomwareCampaignUse', '?')}")
            out.append(f"- 修复要求日期: {match.get('dueDate', '?')}")
            out.append(f"- 描述: {_truncate(match.get('shortDescription', ''), 300)}")
            if match.get("notes"):
                out.append(f"- 备注: {_truncate(match['notes'], 200)}")
        else:
            out.append("- 不在 KEV (未确认在野利用)")
    out.append("")

    # GitHub
    out.append("## GitHub PoC 搜索 (按 stars)")
    if gh_repos and isinstance(gh_repos[0], dict) and gh_repos[0].get("_error"):
        out.append(f"_{gh_repos[0]['_error']}_")
    elif not gh_repos:
        out.append("_no GitHub repos found_")
    else:
        for repo in gh_repos[:10]:
            stars = repo.get("stargazers_count", 0)
            name = repo.get("full_name", "?")
            url = repo.get("html_url", "")
            desc = _truncate(repo.get("description", "") or "", 120)
            out.append(f"- ⭐{stars:>4} **{name}** — {desc}")
            out.append(f"  {url}")

    return "\n".join(out)


@mcp.tool()
async def vuln_recent(days: int = 7, severity: str = "") -> str:
    """最近 N 天新增的 CVE + KEV。用于 incident response / 0day 监控。

    Args:
        days: 多久内 (默认 7, 最大 30 — NVD 限制单次窗口 ≤120 天但对大窗口慢)
        severity: 可选过滤 — CRITICAL / HIGH / MEDIUM / LOW (大小写不敏感)
    """
    days = max(1, min(days, 30))
    sev = severity.strip().upper()
    if sev and sev not in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        return f"[ERROR] severity 必须是 CRITICAL/HIGH/MEDIUM/LOW (或留空), 得到: {severity!r}"

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    fmt = "%Y-%m-%dT%H:%M:%S.000"

    async with _client() as client:
        params = {
            "pubStartDate": start.strftime(fmt),
            "pubEndDate": end.strftime(fmt),
            "resultsPerPage": 50,
        }
        if sev:
            params["cvssV3Severity"] = sev

        nvd_task = _rate_limited_nvd(client, params)
        kev_task = _kev_fetch(client)
        nvd_results, kev_data = await asyncio.gather(nvd_task, kev_task)

    out = [f"# Recent vulns (last {days}d" + (f", {sev}" if sev else "") + ")", ""]

    # NVD recent
    out.append(f"## NVD (新发布 CVE)")
    if nvd_results and nvd_results[0].get("_error"):
        out.append(f"_{nvd_results[0]['_error']}_")
    elif not nvd_results:
        out.append("_no results_")
    else:
        # 按 score 降序
        nvd_sorted = sorted(
            nvd_results,
            key=lambda x: (x.get("score") or 0),
            reverse=True,
        )
        for v in nvd_sorted[:30]:
            score = v.get("score")
            sev_s = v.get("severity") or "?"
            score_s = f"{score}" if score is not None else "?"
            out.append(f"- **{v['cve_id']}** [{sev_s} {score_s}] {v['published']}")
            out.append(f"  {v['description']}")
    out.append("")

    # KEV new (within window)
    out.append(f"## CISA KEV (新加入在野列表)")
    if kev_data and isinstance(kev_data[0], dict) and kev_data[0].get("_error"):
        out.append(f"_{kev_data[0]['_error']}_")
    else:
        cutoff = start.date()
        new_kev = [
            k for k in kev_data
            if isinstance(k, dict) and k.get("dateAdded") and k["dateAdded"] >= cutoff.isoformat()
        ]
        if not new_kev:
            out.append(f"_无新增 (近 {days} 天)_")
        else:
            new_kev.sort(key=lambda x: x.get("dateAdded", ""), reverse=True)
            for k in new_kev[:30]:
                out.append(f"- **{k.get('cveID')}** {k.get('dateAdded')} — {k.get('vendorProject')}/{k.get('product')}")
                out.append(f"  {_truncate(k.get('vulnerabilityName',''), 150)}")

    return "\n".join(out)


@mcp.tool()
async def vuln_ghsa_advisory(query: str, first: int = 15) -> str:
    """直接查 GitHub Security Advisory — 比 vuln_search 信息更详细 (受影响版本范围、补丁版本)。

    Args:
        query: GHSA 搜索语法, 例如:
            "log4j"                       — 关键词
            "ecosystem:Maven log4j"       — 限定生态系统
            "severity:CRITICAL django"    — 限定严重度
            "published:>2025-01-01 spring" — 时间范围
        first: 返回最多几条 (默认 15, 最大 50)
    """
    n = max(1, min(first, 50))
    async with _client() as client:
        results = await _ghsa_search(client, query, first=n)

    out = [f"# GHSA: `{query}`", ""]
    if results and results[0].get("_error"):
        out.append(f"_{results[0]['_error']}_")
        return "\n".join(out)
    if not results:
        out.append("_no advisories found_")
        return "\n".join(out)

    for v in results:
        cve_part = f" [{v['cve_id']}]" if v["cve_id"] else ""
        out.append(f"### {v['ghsa_id']}{cve_part} — {v['severity']}")
        out.append(f"- published: {v['published']}")
        out.append(f"- summary: {v['summary']}")
        if v["affected"]:
            out.append(f"- affected:")
            for a in v["affected"]:
                out.append(f"    - {a}")
        if v["refs"]:
            out.append(f"- refs: {' '.join(v['refs'])}")
        out.append("")

    return "\n".join(out)


@mcp.tool()
async def vuln_patch_diff(repo: str, days: int = 30, max_results: int = 20) -> str:
    """扫描某个 GitHub 仓库近 N 天可疑安全 commit (silent fix 候选).

    工作原理:
      1. GitHub commits API 拉近 N 天 commit 历史
      2. 用关键词 (fix/security/vuln/cve/sanitize/escape/auth/inject 等) 过滤
      3. 列出 commit 短哈希 + 标题 + URL 供你 git show / patch-diff

    用法 (skill RESEARCH 模式 patch→variant 工作流):
      vuln_patch_diff(repo="apache/struts", days=180)
      → 看哪些"小修复"可能是 silent CVE patch
      → 然后对 commit diff 做变体搜索

    Args:
        repo: GitHub 仓库 owner/name (如 "apache/struts")
        days: 多久内 (默认 30)
        max_results: 最多返回多少 (默认 20, 最大 100)
    """
    if "/" not in repo or repo.count("/") != 1:
        return f"[ERROR] repo 必须是 owner/name 格式, 得到: {repo!r}"
    days = max(1, min(days, 365))
    n = max(1, min(max_results, 100))

    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    headers = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"

    async with _client() as client:
        try:
            r = await client.get(
                f"{GH_REST}/repos/{repo}/commits",
                params={"since": since, "per_page": 100},
                headers=headers,
            )
            if r.status_code == 404:
                return f"[ERROR] 仓库 {repo} 不存在或不可见"
            if r.status_code == 403:
                return f"[ERROR] GitHub API 限速 (无 token 60/h, 带 token 5000/h). 设置 GITHUB_TOKEN 环境变量"
            r.raise_for_status()
            commits = r.json()
        except (httpx.HTTPError, json.JSONDecodeError) as e:
            return f"[ERROR] commits 拉取失败: {type(e).__name__}: {e}"

    # 关键词过滤 — 涵盖最常见的 silent-fix 暗号
    pattern = re.compile(
        r"\b(fix|secur|vuln|cve|bypass|leak|expos|sanitiz|escape|"
        r"valid|inject|auth|priv|crash|oob|uaf|race|null|deref|"
        r"redos|ssrf|sqli|xxe|xss|deserial|patch|hardening|"
        r"overflow|underflow|tocttou|raceconditi)",
        re.IGNORECASE,
    )

    suspicious = []
    for c in commits:
        msg = (c.get("commit") or {}).get("message", "")
        first_line = msg.split("\n", 1)[0]
        if pattern.search(first_line) or pattern.search(msg[:500]):
            suspicious.append({
                "sha": c.get("sha", "")[:10],
                "date": (c.get("commit") or {}).get("author", {}).get("date", "")[:10],
                "author": (c.get("commit") or {}).get("author", {}).get("name", "?"),
                "title": _truncate(first_line, 200),
                "url": c.get("html_url", ""),
            })

    out = [f"# Patch diff: {repo} (last {days}d, {len(commits)} commits scanned)", ""]
    if not suspicious:
        out.append("_无可疑安全 commit_")
        return "\n".join(out)

    out.append(f"找到 {len(suspicious)} 个可疑 commit (top {n}):")
    out.append("")
    for c in suspicious[:n]:
        out.append(f"- **{c['sha']}** {c['date']} {c['author']}")
        out.append(f"  {c['title']}")
        out.append(f"  {c['url']}")
        out.append(f"  patch: {c['url']}.patch")
        out.append("")

    out.append("---")
    out.append("**下一步 (RESEARCH 模式 patch→variant 工作流)**:")
    out.append("- 取可疑 commit 的 .patch 内容: read_url_content '<url>.patch'")
    out.append("- 识别其修复的不变性 (新加的检查 / 删除的 sink)")
    out.append("- grep 当前 HEAD 找 sibling 调用点未应用同一不变性的位置")
    out.append("- 对每个候选写 PoC 验证")

    return "\n".join(out)


# ═══════════════════════════════════════════════════════════════
# 启动
# ═══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    mcp.run(transport="stdio")
