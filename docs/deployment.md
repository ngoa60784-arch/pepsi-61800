# 部署指南

本文档说明如何把 tch-agent 部署到云端服务器。读完按步骤走即可上线。

> 这是一个能发起**真实渗透攻击**的系统。务必只对**已授权**的目标使用，并先读完末尾的「安全 checklist」。

---

## 1. 架构与资源

两层：

- **控制面**（本仓库）：Web UI + daemon，负责 Commander/Planner 调度、状态管理。本身很轻（进程约 200–400MB）。
- **solver 执行**：每个 solver 跑在一个 Kali 容器里执行扫描/利用工具。资源大头。LLM 走**外部 API**（不在服务器跑模型，无需 GPU）。

两个硬约束：

- **必须 x86_64 / amd64**。Dockerfile 写死 `--platform linux/amd64`，工具二进制均为 amd64。**不要用 ARM 服务器**。
- solver 镜像约 **10.4GB**，多个 solver 共享这**一份**镜像（不是每个 solver 占 10GB）。

### 服务器规格建议

执行后端可选 `docker`（solver 跑本机容器）或 `ssh`（solver 跑远程 Kali）。

**模式 A — 单机 all-in-one（`backend=docker`）**

| 并发 solver | 规格 |
| --- | --- |
| 1–2（试用） | 8 vCPU / 16GB / 100GB SSD |
| 3–5（常规） | 16 vCPU / 32GB / 200GB SSD |
| 6–10（高强度） | 32 vCPU / 64GB / 300GB SSD |

经验：`总配置 ≈ 控制面(2核/2GB) + 每并发 solver (2–3 vCPU / 3–4GB)`。

**模式 B — 控制 / 执行分离（`backend=ssh`，推荐规模化 & 安全隔离）**

| 角色 | 规格 |
| --- | --- |
| 控制机 | 2–4 vCPU / 4–8GB / 40GB |
| 执行机（Kali） | 8–16 vCPU / 16–32GB / 100GB+ SSD，可横向扩展多台 |

---

## 2. 前置依赖

服务器（amd64 Linux）需要：

- **Docker**（模式 A 必需；模式 B 在执行机不需要，控制机也不需要）
  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"   # 重新登录生效
  ```
- **Bun**（用源码方式跑控制面时需要；用预编译二进制则不需要）
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- 控制面要能访问你使用的 **LLM API**（本地若靠代理，服务器需确认能直连或自带代理）。

---

## 3. 分发 solver 镜像（不要在服务器上 build）

在**本地或 CI**（有源码、网络好）构建并推送，服务器只 `pull`：

```bash
# 本地：构建并推送（约 10GB+，耗时较长）
deploy/build-and-push-image.sh registry.example.com/sec latest

# 服务器：拉取并打成默认 tag
docker pull registry.example.com/sec/tch-agent:latest
docker tag  registry.example.com/sec/tch-agent:latest tch-agent:latest
```

或者在 UI 的 **Config → Host** 把 `runtime.image` 设成完整 registry 路径，省去 `docker tag`。

> 为什么不在服务器 build：构建会拉取数百个工具、产生数百 GB 构建缓存且很慢。

---

## 4. 部署控制面

把仓库放到 `/opt/tch-agent`（或任意目录），安装依赖：

```bash
cd /opt/tch-agent
bun install
```

可选：编译成单一二进制（之后用方式 A 启动，无需 bun/源码）：

```bash
bun run build:linux        # 产出 bin/tch-agent-linux-x64
```

### 用 systemd 常驻

仓库提供了 `deploy/tch-agent.service`：

```bash
# 1) 生成强随机访问令牌
openssl rand -hex 32

# 2) 编辑 unit，把 TCH_AUTH_TOKEN 改成上面的值，按需切换 ExecStart（二进制 / bun）、调整 User
sudo cp deploy/tch-agent.service /etc/systemd/system/tch-agent.service
sudo nano /etc/systemd/system/tch-agent.service

# 3) 启用
sudo systemctl daemon-reload
sudo systemctl enable --now tch-agent
sudo systemctl status tch-agent
journalctl -u tch-agent -f      # 看日志，等 "Web UI running at ..."
```

> 首次启动会拉取/校验 solver 镜像、（bun 方式下）编译一个 solver 二进制，可能耗时一两分钟，`TimeoutStartSec` 已放宽。

---

## 5. 认证（P0，公网必做）

设置 `TCH_AUTH_TOKEN` 即启用认证：所有 `/api/*` 与 SSE 都需要令牌（登录后写入 HttpOnly cookie）。**不设则 Web UI 零认证**——任何能访问端口的人都能派渗透 solver。

- 已在 `tch-agent.service` 的 `Environment=TCH_AUTH_TOKEN=...` 配置。
- 打开 Web UI 会出现登录页，输入该令牌即可。

---

## 6. 数据持久化

所有状态在运行用户的 `~/.tch-agent/`：

```
~/.tch-agent/
├── config/      # API key、provider/model、prompts、skills、host-settings
├── solvers/     # 活跃 solver 的 session/workspace/状态
├── archive_solvers/
├── challenge/   # 目标与共享作战态（memory/ideas/findings/assets）
└── runtime/     # 同步出来的 Dockerfile、编译的 solver 二进制
```

- 确保该用户的 home 落在**持久卷**上，不要随实例销毁。
- 备份重点：`~/.tch-agent/config` 和 `~/.tch-agent/challenge`。
- `solvers/`、`runtime/` 可重建，不强制备份。

---

## 7. 对外访问

默认监听 `127.0.0.1:3000`（只本机）。两种暴露方式：

**A. SSH 隧道（最简单、最安全）**
```bash
ssh -L 3000:127.0.0.1:3000 user@server
# 本地浏览器打开 http://127.0.0.1:3000
```

**B. 反向代理 + HTTPS（对外提供）**

用 nginx/caddy 终止 TLS 转发到 `127.0.0.1:3000`。注意 SSE 需要禁用缓冲：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;          # SSE 必需
    proxy_read_timeout 3600s;
}
```

> 走 HTTPS 时，建议把 server.ts 登录 cookie 追加 `Secure`（当前为兼容 http/隧道未加）。

---

## 8. 执行后端配置（UI: Config → Host）

- **Memory / CPU Limit per Solver**：给单个 solver 容器设 `--memory`（如 `2g`）/`--cpus`（如 `1.5`），防止失控 solver 吃满宿主。留空 = 不限制。
- **Max Solvers**：调度器最大并发 solver 数。
- **Network Mode**：`host`（默认）或 `bridge`。
- **Backend = ssh**：填远程 Kali 的 host/port/alias 或密码、`remoteBinary`、`remoteSolversDir`（需与本机 `SOLVERS_DIR` 经 sshfs 同视图）。

---

## 9. 上线前冒烟验证

```bash
TOKEN=你的令牌; B=http://127.0.0.1:3000
# 登录拿 cookie
curl -s -c /tmp/jar -X POST -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" $B/api/auth/login
# 关键端点应返回 200
curl -s -b /tmp/jar $B/api/runtime/status      # {"docker":true,...} 说明 Docker 通
curl -s -b /tmp/jar $B/api/config/tools | head -c 80
```

然后在 UI 里：配好 provider/API key/模型 → 在 Commander 对一个**已授权**靶机下一条指令 → 观察 Runtime 里 solver 起容器、Attack Flow 里出现实时事件。建议**先在隔离环境对授权靶机完整跑通一次**再正式作战。

---

## 10. 安全 checklist

- [ ] `TCH_AUTH_TOKEN` 已设为强随机值
- [ ] 未直接把 `0.0.0.0:3000` 暴露公网（用隧道或带 TLS 的反代）
- [ ] 给 solver 容器设了 `--memory`/`--cpus` 上限
- [ ] 只对**已授权**目标作战，配置了 engagement scope（见 `docs/engagement-mode.md`）
- [ ] 云厂商**允许**安全测试出站流量（否则实例可能被封）
- [ ] `~/.tch-agent/config` 已纳入备份

---

## 升级

```bash
cd /opt/tch-agent && git pull && bun install
sudo systemctl restart tch-agent
# 工具/镜像有更新时，重新 build-and-push-image.sh 并在服务器 pull + tag
```
