---
name: headless-browser
description: |
  Drive a real headless browser (Playwright/Chromium) on the remote Kali for JS-heavy, SPA, and bot-protected
  targets that plain curl/ffuf cannot handle. Use when the app renders content client-side (React/Vue/Angular),
  when login/CSRF/anti-automation tokens are dynamic, when endpoints only appear after JS runs, when you need to
  keep a browser session (cookies) across multiple steps, or when a WAF/JS-challenge (Cloudflare/Akamai) blocks
  raw HTTP. Also for DOM XSS confirmation, postMessage/WebSocket flows, and screenshotting evidence.
tags: [pentest, browser, spa, waf, xss, recon]
---

# Headless Browser (Playwright over remote Kali)

Plain `curl`/`ffuf`/`gobuster` see only the initial HTML. Modern hardened targets are SPAs behind bot-protection:
routes, parameters and API calls only exist **after JavaScript executes**, login flows carry dynamic CSRF/nonce
tokens, and JS-challenge WAFs reject raw HTTP. When recon comes back "empty" but the site clearly works in a
browser, that is the signal to switch to this skill.

Everything runs on the **remote Kali** via `kali-arsenal` (`ssh_execute` / `ssh_upload`). Do NOT run browsers on the
control plane.

## One-time setup on Kali (usually already provisioned)

The provision script (`provision-pentest-vps.sh` Stage 5b) normally pre-installs node + Playwright + Chromium, so
**check first** and skip setup if it's already there:

```bash
# Verify (fast path — provisioned hosts already have these):
ssh_execute("node --version && npx --yes playwright --version && echo READY")
```

Only if that fails, install (idempotent; `--with-deps` pulls the Chromium sandbox libs — can take a few minutes):

```bash
ssh_execute("command -v node || (apt-get update && apt-get install -y nodejs npm)")
ssh_execute("npm -g ls playwright >/dev/null 2>&1 || npm i -g playwright")
ssh_execute("npx --yes playwright install --with-deps chromium")   # heavy; consider ssh_exec_bg + ssh_job_poll
```

If npm is slow/blocked, fall back to `pip install playwright && playwright install chromium` (Python API) or
`apt-get install -y chromium chromium-driver` + Selenium. Pick whichever installs; don't loop on one.

## Core pattern: write a small driver script, upload, run

Author a focused Node script locally, `ssh_upload` it (or write it on Kali with a heredoc via `ssh_execute`), then
run it with `ssh_execute`/`ssh_exec_bg`. Keep each script to the single task at hand.

```js
// nav.js — render a page after JS and dump the resolved DOM + all XHR/fetch URLs it calls
const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const calls = [];
  page.on('request', r => calls.push(`${r.method()} ${r.url()}`));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('=== RESOLVED HTML ===');
  console.log(await page.content());
  console.log('=== NETWORK (XHR/fetch/asset URLs) ===');
  console.log([...new Set(calls)].join('\n'));
  await browser.close();
})();
```

```bash
ssh_execute("node /root/nav.js https://target.example/app")
```

## What to use it for (highest value on hardened targets)

- **Reveal the real attack surface**: the `=== NETWORK ===` dump is gold — it lists the actual API endpoints,
  GraphQL operations, and parameters the SPA calls. Feed those into targeted testing instead of blind `ffuf`.
- **Authenticated multi-step flows**: log in through the browser (it handles the CSRF/nonce automatically), then
  dump `await ctx.cookies()` / `localStorage`; hand the session cookie/JWT to `curl`/`sqlmap` for fast fuzzing of
  the now-known endpoints, or keep driving the browser for stateful actions.
- **Bypass JS-challenge WAF**: Cloudflare/Akamai "checking your browser" pages pass in a real browser. Solve once,
  export the clearance cookie, reuse it in subsequent requests.
- **DOM / client-side bugs**: confirm DOM XSS, prototype pollution, postMessage and open-redirect issues that never
  show up in raw HTML. Use `page.on('dialog', ...)` to catch `alert()` as proof.
- **Evidence**: `await page.screenshot({ path: '/root/loot/xss.png', fullPage: true })`, then `ssh_download` it and
  reference it in `report_finding`.

## Interactive / long browser sessions

For flows you need to poke at across several turns, run the browser driver inside a persistent session with
`ssh_session_new` (see the `pentest` skill's session tools) so you can `ssh_session_send`/`ssh_session_read` step by
step, or keep a REPL:

```bash
ssh_session_new(name="browser", init_cmd="node -e \"globalThis.pw=require('playwright')\" -i")
```

## Discipline

- Always `--no-sandbox` under root on Kali, and `ignoreHTTPSErrors` for self-signed target certs.
- Prefer extracting the network/endpoint map first, then switch to fast HTTP tools for the heavy fuzzing — the
  browser is for what curl can't do, not for high-volume fuzzing.
- Save loot/screenshots under `/root/loot/<slug>/` and `ssh_download` decisive artifacts for findings.
- Only drive the in-scope target. Never navigate to the control plane, the Kali host itself, or out-of-scope hosts.
