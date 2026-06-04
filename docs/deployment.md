# Deployment Guide

This document explains how to deploy tch-agent to a cloud server. Follow the steps below to go live.

> This system can launch **real penetration attacks**. Use it only against **authorized** targets, and read the security checklist at the end before proceeding.

---

## 1. Architecture and Resources

Two layers:

- **Control plane** (this repository): Web UI + daemon, responsible for Commander/Planner scheduling and state management. Lightweight (process ~200–400MB).
- **Solver execution**: Each solver runs in a Kali container executing scan/exploit tools. This is where most resources are consumed. LLMs use **external APIs** (no models run on the server; no GPU required).

Two hard constraints:

- **Must be x86_64 / amd64**. The Dockerfile pins `--platform linux/amd64`; tool binaries are all amd64. **Do not use ARM servers**.
- The solver image is about **10.4GB**; multiple solvers **share this single image** (not 10GB per solver).

### Recommended Server Specs

Solvers always run in **local Docker** containers (Kali image). Pentest commands are executed on your **remote Kali** via MCP **`kali-arsenal`** (configure SSH under **Settings → MCP**).

| Concurrent solvers | Recommended spec (control machine + Docker) |
| --- | --- |
| 1–2 (trial) | 8 vCPU / 16GB / 100GB SSD |
| 3–5 (regular) | 16 vCPU / 32GB / 200GB SSD |
| 6–10 (high intensity) | 32 vCPU / 64GB / 300GB SSD |

Rule of thumb: `total resources ≈ control plane (2 cores / 2GB) + per concurrent solver (2–3 vCPU / 3–4GB)`.

Remote Kali VPS only needs SSH reachable from the control machine (for `kali-arsenal`); it does **not** run the solver agent process.

---

## 2. Prerequisites

The server (amd64 Linux) needs:

- **Docker** (required on the control machine for solver containers)
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"   # takes effect after re-login
  ```
- **Bun** (required when running the control plane from source; not needed with prebuilt binaries)
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- The control plane must reach your **LLM API** (if you rely on a proxy locally, confirm the server can reach it directly or provide its own proxy).

---

## 3. Distributing the Solver Image (Do Not Build on the Server)

Build and push on **local machine or CI** (with source code and good network); the server only `pull`s:

```bash
# Local: build and push (~10GB+, takes a while)
deploy/build-and-push-image.sh registry.example.com/sec latest

# Server: pull and tag as default
docker pull registry.example.com/sec/tch-agent:latest
docker tag  registry.example.com/sec/tch-agent:latest tch-agent:latest
```

Alternatively, set `runtime.image` to the full registry path in the UI under **Config → Host** to skip `docker tag`.

> Why not build on the server: the build pulls hundreds of tools, generates hundreds of GB of build cache, and is very slow.

---

## 4. Deploying the Control Plane

Place the repository at `/opt/tch-agent` (or any directory) and install dependencies:

```bash
cd /opt/tch-agent
bun install
```

Optional: compile to a single binary (then start with Method A, no bun/source needed):

```bash
bun run build:linux        # produces bin/tch-agent-linux-x64
```

### Running with systemd

The repository provides `deploy/tch-agent.service`:

```bash
# 1) Generate a strong random access token
openssl rand -hex 32

# 2) Edit the unit: set TCH_AUTH_TOKEN to the value above, switch ExecStart (binary / bun) as needed, adjust User
sudo cp deploy/tch-agent.service /etc/systemd/system/tch-agent.service
sudo nano /etc/systemd/system/tch-agent.service

# 3) Enable
sudo systemctl daemon-reload
sudo systemctl enable --now tch-agent
sudo systemctl status tch-agent
journalctl -u tch-agent -f      # watch logs, wait for "Web UI running at ..."
```

> First startup may pull/verify the solver image and (under bun) compile a solver binary — can take one to two minutes; `TimeoutStartSec` is relaxed accordingly.

---

## 5. Authentication (P0, Required for Public Deployment)

Setting `TCH_AUTH_TOKEN` enables authentication: all `/api/*` and SSE endpoints require the token (stored in an HttpOnly cookie after login). **If unset, the Web UI has zero authentication** — anyone who can reach the port can dispatch penetration solvers.

- Already configured in `tch-agent.service` as `Environment=TCH_AUTH_TOKEN=...`.
- Opening the Web UI shows a login page; enter that token.

---

## 6. Data Persistence

All state lives under the running user's `~/.tch-agent/`:

```
~/.tch-agent/
├── config/      # API keys, provider/model, prompts, skills, host-settings
├── solvers/     # Active solver sessions/workspaces/state
├── archive_solvers/
├── challenge/   # Targets and shared operational state (memory/ideas/findings/assets)
└── runtime/     # Synced Dockerfile, compiled solver binary
```

- Ensure the user's home directory is on **persistent storage**, not destroyed with the instance.
- Backup priorities: `~/.tch-agent/config` and `~/.tch-agent/challenge`.
- `solvers/` and `runtime/` can be rebuilt; backup is optional.

---

## 7. External Access

Default listen address is `127.0.0.1:3000` (localhost only). Two ways to expose:

**A. SSH tunnel (simplest, most secure)**
```bash
ssh -L 3000:127.0.0.1:3000 user@server
# Open http://127.0.0.1:3000 in local browser
```

**B. Reverse proxy + HTTPS (for external access)**

Use nginx/caddy to terminate TLS and forward to `127.0.0.1:3000`. SSE requires buffering disabled:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;          # required for SSE
    proxy_read_timeout 3600s;
}
```

> When using HTTPS, consider appending `Secure` to the login cookie in server.ts (currently omitted for http/tunnel compatibility).

---

## 8. Runtime & Remote Kali (UI: Settings → Scheduler / MCP)

**Settings → Scheduler** (runtime):

- **Memory / CPU limit per solver**: Docker `--memory` / `--cpus` (e.g. `2g`, `1.5`). Empty = no limit.
- **Max solvers**: Scheduler concurrency cap.
- **Network mode**: `host` (default) or `bridge`.

**Settings → MCP → `kali-arsenal`** (remote command execution):

- `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASS` (or `SSH_ALIAS` for `~/.ssh/config`).
- Solver containers call `ssh_execute` on this host for nmap, ffuf, etc.

---

## 9. Pre-Launch Smoke Test

```bash
TOKEN=your-token; B=http://127.0.0.1:3000
# Login to get cookie
curl -s -c /tmp/jar -X POST -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" $B/api/auth/login
# Key endpoints should return 200
curl -s -b /tmp/jar $B/api/runtime/status      # {"docker":true,...} means Docker is reachable
curl -s -b /tmp/jar $B/api/config/tools | head -c 80
```

Then in the UI: configure provider/API key/model → set `TCH_ENGAGEMENT_SCOPE` → issue commands or start a Solver against an **authorized** target on the **Commander** or **Targets** page → watch Runtime for container startup and live events in the attack flow. **Run a full pass against an authorized target in an isolated environment before production use.**

---

## 10. Security Checklist

- [ ] `TCH_AUTH_TOKEN` set to a strong random value
- [ ] Not exposing `0.0.0.0:3000` directly to the public internet (use tunnel or TLS reverse proxy)
- [ ] Solver containers have `--memory`/`--cpus` limits set
- [ ] Operating only against **authorized** targets with engagement scope configured (see `docs/engagement-mode.md`)
- [ ] Cloud provider **allows** security-testing egress traffic (otherwise instances may be blocked)
- [ ] `~/.tch-agent/config` included in backups

---

## Upgrading

```bash
cd /opt/tch-agent && git pull && bun install
sudo systemctl restart tch-agent
# When tools/image update: re-run build-and-push-image.sh and pull + tag on the server
```
