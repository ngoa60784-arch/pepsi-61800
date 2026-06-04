# BreachWeave

BreachWeave（`tch-agent`）是一套面向**已授权渗透测试与红队演练**的多智能体协作平台：多个 Solver 在隔离环境中并行推进杀伤链，由编排中枢统一调度，Observer 旁路维护作战状态，Commander 与 Planner 分别负责人机协同与自动调度。

> 仅对**已取得授权**的目标使用。系统会发起真实扫描与利用尝试。

## 中文文档

- **[项目文档](docs/项目文档.md)** — 完整说明（架构、协作、部署、API）
- **[配置手册](docs/配置手册.md)** — 全部配置项与 `~/.tch-agent/config/` 详解
- [架构与开发文档（英文）](ARCHITECTURE.md)

## Quick Start

```bash
bun run install && bun run web
```

浏览器打开 **http://127.0.0.1:3000**，在 **配置** 中填写 LLM API 与 **MCP → kali-arsenal** SSH，然后在 **指挥官** 下达目标或到 **目标** 页手动启动 Solver。

公网部署前请设置 `TCH_AUTH_TOKEN`，见 [项目文档 §10](docs/项目文档.md#10-部署与运维)。

## Roles at a Glance

| Role | Responsibility |
|------|----------------|
| **Commander** | Conversational operator interface |
| **Planner** | Periodic auto-scheduling |
| **Solver** | Kill-chain execution in Docker; attacks via remote Kali MCP |
| **Observer** | Sidecar supervision (ideas / memory / steer) |
| **Verifier** | Independent objective re-verification |
| **ChallengeManager** | Non-LLM orchestration hub |

## Architecture

```
Operator → Web UI → ChallengeManager → RuntimeManager → Docker Solver
                                              ↓
                                    MCP kali-arsenal → Remote Kali (SSH)
```

![](./docs/design.png)

## Capabilities

- **Multi-agent collaboration** — Parallel Solvers with Planner/Commander coordination
- **Runtime supervision** — Observer course-correction without replacing Solver decisions
- **Layered state** — Ideas (hypotheses) vs Memory (facts/evidence)
- **Externalized termination** — Verifier + operator confirmation
- **Context hygiene** — Large tool output offloaded to workspace paths

Engagement mode is the default runtime (local findings, scope whitelist, no remote scoring platform). See [项目文档 §7](docs/项目文档.md#7-作战模式engagement).

## Development

Runtime: **Bun** (not Node). See [AGENTS.md](AGENTS.md) for conventions.

```bash
bun run dev          # Web with HMR
bun run typecheck
cd packages/core && bun test
```

## Data Directory

State under `~/.tch-agent/` (`config/`, `challenge/`, `solvers/`, `runtime/`). Backup `config/` and `challenge/` first.
