---
name: waf-evasion
description: |
  Keep working against hardened targets protected by a WAF / rate-limiter / IPS without getting the source IP
  banned. Use when scans start returning 403/429/captcha/Cloudflare pages, when the [ANTI-BAN WARN] banner appears,
  when tools suddenly all time out (IP blocked), or before touching a target you already know is high-protection.
  Covers low-and-slow pacing, request/payload obfuscation, header tricks, egress rotation, and WAF-aware tool flags.
tags: [pentest, waf, evasion, anti-ban, stealth]
---

# WAF / Rate-limit / IP-ban Evasion (hardened targets)

Automated scanners at default speed are exactly what WAFs and rate-limiters are tuned to catch. On a hardened
target the failure mode is: a few minutes of `nuclei`/`ffuf`/`sqlmap` at full speed → source IP banned → every
tool times out → the agent misreads it as "no vulns". Recognize the ban, slow down, obfuscate, or rotate egress.

## 0. Detect the ban (don't grind a blocked IP)

Signals: sudden `403`/`429`, a Cloudflare/Akamai/"checking your browser" interstitial, captcha, identical short
responses to every request, or all commands timing out at once. The `kali-arsenal` MCP prepends an
`[ANTI-BAN WARN]` banner when it detects these — treat it as a hard signal to change tactics, not to retry harder.
Check current pacing/egress state with `anti_ban_status`.

## 1. Low-and-slow first (cheapest fix)

- Turn on global pacing so *every* command is spaced out: set env `ATTACK_RATE_MIN_INTERVAL` (e.g. 2–5s) and
  `ATTACK_RATE_JITTER` (e.g. 1–3s) on the `kali-arsenal` MCP. This throttles all tools uniformly.
- Throttle each tool too:
  - `ffuf -rate 20 -p 0.3-1.5` (requests/sec + random delay), fewer threads `-t 5`.
  - `nuclei -rl 20 -c 10` (rate-limit, concurrency), `-timeout` up.
  - `sqlmap --delay=1 --randomize=... --time-sec=... --threads=1`.
  - `gobuster/feroxbuster --delay 500ms`, low concurrency.
- Shrink the fuzz surface: use a small high-signal wordlist, not a 100k blast. Passive first (see §4).

## 2. Obfuscate requests & payloads

- **Rotate identity**: randomize `User-Agent` (real browser UAs), vary `Accept`/`Accept-Language`, drop obvious
  tool fingerprints (default nuclei/sqlmap UAs are flagged). Add plausible `Referer`.
- **Spoofable origin headers** (bypass IP allow/deny on some WAFs): `X-Forwarded-For`, `X-Real-IP`,
  `X-Originating-IP`, `X-Client-IP`, `X-Forwarded-Host` — try 127.0.0.1 / internal IPs.
- **sqlmap tamper scripts**: `--tamper=space2comment,between,randomcase,charencode` (choose by DB/WAF); start with
  `--tamper=space2comment,randomcase` and add based on what's filtered.
- **Encoding layers**: URL/double-URL encode, mixed case, comment injection (`/**/`), unicode/overlong, chunked
  bodies. For XSS see the `payloads-all-the-things` bypass sets; fuzz which chars are filtered first, then craft.
- **HTTP method/verb & content-type swaps**: `POST`→`PUT`, `application/json`↔form-encoded; some WAF rules only
  inspect one path.

## 3. Rotate egress (when a single IP keeps getting banned)

- Configure an egress pool `ATTACK_PROXY_POOL` (comma-separated `socks5://ip:port` / `http://ip:port`) on the
  `kali-arsenal` MCP, then run sensitive commands with `ssh_execute_proxied(...)` — it auto-rotates to the next
  exit each call via `proxychains4`. Install once: `apt-get install -y proxychains4`.
- Note: raw-socket tools (`masscan`, `nmap -sS`) don't traverse SOCKS — use `nmap -sT` full-connect through the
  proxy, or reserve un-proxied scanning for when you're not yet blocked.
- A pivot SOCKS (chisel/ligolo, see `lateral-movement`) can also serve as an alternate egress.

## 4. Go passive to avoid touching the target at all

Collect surface without sending attack traffic: `gau` / `waybackurls` (archived URLs), `subfinder`/`amass -passive`,
crt.sh, FOFA/Shodan, JS endpoint extraction (`katana -jc`, or the `headless-browser` network dump). Build the target
map passively, then spend your (rate-limited) active budget only on the highest-value endpoints.

## 5. WAF-aware exploitation

- Identify the WAF (`wafw00f`) — bypass techniques are WAF-specific.
- Prefer a precise, hand-crafted single request that works over a noisy scanner that gets you banned before it
  finds anything. On hardened targets, one good manual probe beats 10k blind requests.

## Discipline
- The goal is to keep a working channel to the target, not to "beat" the WAF for its own sake. If blocked, slow/rotate
  and continue the actual objective.
- Stay in scope; egress rotation changes *your* source, never the target set.
