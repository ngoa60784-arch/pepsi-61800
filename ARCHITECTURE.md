# 架构与项目文档

> 本文是 BreachWeave / `tch-agent` 的完整工程文档：讲清楚系统是什么、由哪些角色协作、代码怎么分层、数据怎么流动、怎么开发与部署。
>
> 配套文档：
> - [README.md](README.md) — 项目简介与架构理念
> - [docs/deployment.md](docs/deployment.md) — 云端部署完整指南
> - [docs/engagement-mode.md](docs/engagement-mode.md) — 实战模式、scope 与操作员工作流
> - [AGENTS.md](AGENTS.md) — 代码规范与 Bun 约定

---

## 1. 这是什么

BreachWeave 是一个**面向授权渗透测试的多 Agent 协作系统**。它不是单个 LLM 跑工具，而是把渗透过程拆成几个分工明确的角色，由一个非 LLM 的编排中枢统一调度：

- **Commander** —— 人驱动的对话式指挥官（LLM）。
- **Planner** —— 周期性、无人值守的自动调度器（LLM）。
- **Solver** —— 真正在 Kali 容器里执行 kill chain 的执行体（LLM）。
- **Observer** —— 旁路监督 sidecar，维护策略看板、轻量纠偏（LLM）。
- **Verifier** —— 独立复验 subagent，确认目标是否真正达成（LLM）。
- **ChallengeManager** —— 把上面这些串起来的**纯逻辑编排中枢**（非 LLM）。

LLM 全部走**外部 API**（不在服务器跑模型，无需 GPU）。Solver 的攻击动作跑在**隔离的 Kali 执行环境**（本机 Docker 容器或远程 SSH 主机）里。

> 这是能发起**真实攻击**的系统。只对**已授权**目标使用，并配置好 engagement scope。

---

## 2. 运行时装配（DaemonManager）

进程启动时，`DaemonManager`（`packages/core/src/index.ts`）以单例方式装配四个管理器，这是整个后端的依赖骨架：

```
DaemonManager.getInstance()
├── ConfigManager        配置（API key / provider / model / prompt / skill / host-settings）
├── ChallengeManager     编排中枢（目标、共享态、Planner、Verifier）
├── RuntimeManager       solver 容器生命周期 + JSONL RPC 桥接
│     └── 注册 host-bridge handler: createChallengeHostBridgeHandler(challenge)
└── CommanderManager     对话式指挥官 agent
```

关键接线（`index.ts:27-44`）：

```31:35:packages/core/src/index.ts
            const config = await ConfigManager.getInstance()
            const challenge = new ChallengeManager(config)
            const runtime = new RuntimeManager(config, [createChallengeHostBridgeHandler(challenge)])
            challenge.attachRuntime(runtime)
            const commander = new CommanderManager(config, challenge)
```

- `ChallengeManager` 通过 `attachRuntime(runtime)` 拿到启停 solver 的能力。
- `RuntimeManager` 在构造时被注入 challenge 的 host-bridge handler —— 这是 solver 反向调用 host 的唯一通道。
- `CommanderManager` 持有 `challenge`，所有指挥官工具都是对 `ChallengeManager` 能力的封装。

---

## 3. 分层架构

```
┌──────────────────────────────────────────────────────────┐
│  apps/cli            CLI 入口（Commander.js）              │
│  └─ web / solver / solver rpc / subagent 子命令            │
├──────────────────────────────────────────────────────────┤
│  packages/ui-web     Web UI + REST/SSE（Bun.serve）        │
│  packages/ui-tui     终端 UI（Ink，部分子命令暂停用）       │
│  └─ 调用 @tch/core 的 DaemonManager                        │
├──────────────────────────────────────────────────────────┤
│  packages/core       @tch/core                             │
│  ├─ config/    ConfigManager：配置、工具、prompt、skill     │
│  ├─ challenge/ ChallengeManager / Commander / Planner /    │
│  │             Verifier / 共享黑板 / host-bridge           │
│  ├─ runtime/   RuntimeManager / Docker·SSH 后端 / 镜像     │
│  └─ solver/    solver 会话 / RPC server / observer 扩展     │
├──────────────────────────────────────────────────────────┤
│  packages/libs/pi-mcp-adapter   MCP 配置加载               │
├──────────────────────────────────────────────────────────┤
│  pi-coding-agent SDK / pi-ai SDK（第三方）                  │
└──────────────────────────────────────────────────────────┘
```

依赖方向严格单向：`UI → Runtime → Service → Config → Types`，`@tch/core` 不依赖任何 UI 包。

包依赖：

```
@tch/cli
  ├── @tch/ui-web  ──→  @tch/core ──→ pi-mcp-adapter
  └── @tch/ui-tui  ──→  @tch/core
```

---

## 4. 多 Agent 协作（系统核心）

这是项目的核心价值。五个 LLM 角色 + 一个编排中枢，各司其职。

### 4.1 全景图

```
                        REST / SSE
   操作员 ──────────────► Web UI ──────────► DaemonManager
                                                  │
   ┌──────────────┐   工具调用      ┌─────────────▼──────────────┐
   │ Commander    │ ─────────────► │      ChallengeManager       │ ◄── REST/UI 直接调用
   │ (LLM,落盘)    │                │   (编排中枢,非 agent)        │
   └──────────────┘                └──────┬───────────────┬──────┘
                                          │               │
        startSyncLoop / tickPlanner       │               │ launchSolver / steer / stop
                  │                        ▼               ▼
        ┌──────────────────┐      ┌───────────────┐  ┌────────────────────┐
        │ Planner          │      │ Verifier      │  │ RuntimeManager     │
        │ (LLM, 周期/inMem) │      │ (LLM, 复验)   │  │ Docker / SSH solver │
        └────────┬─────────┘      └───────────────┘  └─────────┬──────────┘
                 │ planner_launch_solver / steer                │
                 └──────────────────────────────────────────────┤
                                                                 ▼
                                                    ┌──────────────────────────┐
                                                    │ Solver (LLM, Kali 容器)   │
                                                    │   + Observer sidecar(LLM) │
                                                    │   + 续跑机制(ralph-loop)   │
                                                    └────────────┬─────────────┘
                                                                 │ host-bridge (stdout JSONL)
                                                                 ▼
                                                   host-bridge-handler → ChallengeManager
```

### 4.2 Commander —— 对话式指挥官

- **是 LLM agent**，落盘会话（`SessionManager.continueRecent`，多轮、人来驱动）。
- 文件：`packages/core/src/challenge/commander.ts`，系统 prompt 固定为 `COMMANDER_SYSTEM_PROMPT`，不加载 skills。
- 仅在 engagement 模式下可用。
- 7 个工具（`defineTool`），全是对 `ChallengeManager` 能力的薄封装：

| 工具 | 落到的方法 |
|------|-----------|
| `create_target` | `createChallenge(...)` |
| `launch_solver` | `launchSolver(targetId, "kimi-security", { plannerHandoff })` |
| `list_targets` | `listStoredChallenges()` |
| `list_solvers` | `getRuntime().listAll()` |
| `stop_solver` | `getRuntime().stopSolver(solverId)` |
| `import_findings` | `upsertStateAsset` / `appendMemory` / `addIdea` |
| `get_solver_progress` | `listMemory` / `listIdeas` / `listSubmissionLogs` |

Commander 与 Planner 复用同一套 `ChallengeManager` 能力，区别只是**触发方式**：Commander 是人驱动常驻会话，Planner 是周期性一次性会话。

### 4.3 Planner —— 自动调度器

- **是 LLM agent**，但每个 tick 用 `SessionManager.inMemory()` 新建一次性会话（不落盘）。
- 实现在 `manager.ts`：`runPlannerOnce` / `createPlannerTools` / `buildPlannerSnapshot` / `wrapPlannerResourceLoader`；系统 prompt 为 `CHALLENGE_PLANNER`（内置 prompt）。
- 触发：`startSyncLoop()` 每 `planner.tickIntervalMs`（默认 30s）调一次 `tickPlanner`；也可手动触发。调度器**始终开启**（UI 不可关闭）；`maxSolvers` 等参数在 Config → 调度器 配置。前提已 attach runtime。
- 输入快照（`buildPlannerSnapshot`）：challenge 级 memory / ideas / findings / state assets + 各 solver 本地 board 的 `currentFocus`。
- 产出：本轮调度说明文本 + 工具副作用 + 持久化 `planner-last-round.json`（`actions` / `summary` / `battlePlan`）。
- 7 个 `planner_*` 工具：`planner_get_state`、`planner_start_challenge`、`planner_stop_challenge`、`planner_launch_solver`、`planner_stop_solver`、`planner_steer_solver`、`planner_set_plan`。

### 4.4 Solver —— 执行体

- **是 LLM agent**，跑在 Kali 容器（或远程 SSH 主机）内，由 `solver rpc` 进程承载。
- 主 prompt：内置 `kimi-security.md`（授权渗透操作员，Kali kill chain 方法论，`observerEnabled: true`，启用 `security_kimi_search` + 6 个 engagement 工具 + 大量 skills）。
- 通过 host-bridge 与 host 通信（见 §6.3）：
  - `report_finding` → `challenge_submit_flag`（记录已验证发现 / 声明目标达成，写入本地 findings）
  - `get_target_intel` → `challenge_get_hint`
  - `record_asset` → `state_upsert`（写跨 solver 共享资产）
  - `record_relation` → `relation_upsert`（往跨 solver 攻击图谱写一条有向边）
  - `query_relations` → `relation_query`（按 source/relation/target 子串过滤查询图谱）
  - `find_attack_path` → `relation_path`（在图谱里 BFS 求 start→end 最短攻击路径）
- 一个目标可并行多个 Solver，探索不同方向。

### 4.5 Observer —— 旁路监督 sidecar

- **是独立 LLM agent**，但与 Solver **同进程**：在 solver 主 session 的 extension 里异步调度，每次 review 临时 `createAgentSession` + 完成后 `dispose`。
- 实现：`packages/core/src/solver/extension/challenge-observer/`。
- 激活条件：`TCH_CHALLENGE_ID` 存在 **且** prompt `observerEnabled: true`。
- 触发时机：每 6 轮 assistant 消息（periodic）/ 调用 `challenge_get_hint`（hint）/ 每次 `agent_end`。每次 review 带最近 10 轮活动摘要。
- 它做两件事：
  1. **维护策略看板**（主路径）：写 `.observer/board/` 下的 ideas / memory，solver 通过只读工具（`idea_list` / `memory_list` 等）消费。Observer 是 ideas 的**唯一写入者**。
  2. **轻量纠偏**（末手段）：`send_efficiency_reminder` → `pi.sendUserMessage(..., { deliverAs: "steer" })`，带冷却（6 轮）/去重（12 轮）抑制，避免打扰。

### 4.6 Verifier —— 独立复验

- **是 LLM subagent**（`OBJECTIVE_VERIFIER.md`，`isSubagent: true`），用 `SessionManager.inMemory()`。
- 触发：solver `report_finding(objective_achieved=true)` → host-bridge `challenge_submit_flag` 经证据门禁后，由 `ChallengeManager.verifyObjective(...)` 拉起。
- 它在 Kali 容器内**复现** solver 声称的达成，必须调用 `submit_verdict`：
  - `verified` → `markEngagementComplete` → `finishChallenge`（停掉该目标 solver）
  - `rejected` / `inconclusive` → 不收尾，solver 继续

### 4.7 结束条件外置（防过早结束）

由 `challenge-observer/ralph-loop.ts` 的 `attachChallengeContinuation` 实现，**不依赖 observer**，只要 `isChallengeMode()` 就注册：

- 每次 `agent_end`（solver 自认为一轮结束）先经 host-bridge 查 `challenge_is_completed`；
- 未完成 → 自动注入续跑消息（`triggerTurn: true`）拉起下一轮，文案强调"基于已有侦察继续、不要重头再来"；
- 错误时最多重试 10 次，指数退避。

这把"任务是否结束"从模型主观判断**外置**给系统状态，避免复杂任务中途被过早结束。

---

## 5. ChallengeManager —— 编排中枢

文件：`packages/core/src/challenge/manager.ts`。**纯逻辑层**，自身不是 agent，但内嵌 Planner、Verifier 两个 LLM 子会话。

### 5.1 核心字段（节选）

| 字段 | 作用 |
|------|------|
| `config` | 模型 / prompt / hostSettings |
| `runtime` | 启停 / steer solver |
| `syncTimer` / `syncLoopStarted` | Planner 周期 tick 循环 |
| `plannerRunning` | Planner 单飞锁 |
| `finishingChallenges` / `stoppedOnCompletion` | 完成收尾 & "撤销完成"时精确续跑 |

### 5.2 核心方法

- **`launchSolver(challengeId, promptName, options?)`**：构建实战任务文案（注入 scope / memory / ideas / findings / state assets / handoff）→ 从 challenge 级共享态 **seed** 到 solver 本地 board → 注入 `TCH_CHALLENGE_ID` 等 env → `runtime.launch(...)` 起容器。
- **`tickPlanner` / `startSyncLoop`**：周期触发 Planner。
- **`runPlannerOnce(source)`**：跑一轮 Planner LLM（inMemory）。
- **`verifyObjective(...)`**：拉起 Verifier LLM 复验，`verified` 才收尾。
- 共享态 CRUD（memory / ideas / state assets / submissions）+ 写入后**广播**给同目标 running solvers。

---

## 6. 共享作战态（Blackboard）与 Host-Bridge

### 6.1 两层 board

系统刻意区分两层状态，避免"方向"与"事实"混在一起：

| 层 | 位置 | 说明 |
|----|------|------|
| **Challenge 级共享态** | `~/.tch-agent/challenge/{id}/` | 跨 solver 共享的全局事实，Planner / Commander / Verifier 都读它 |
| **Solver 级本地 board** | `{solverSession}/.observer/board/` | 单个 solver 的策略看板，Observer 维护 |

launch 时从 challenge 级**单向 seed** 到 solver 本地 board（`seedSolverBoardFromChallenge`）；跨 solver 复用靠 challenge 级 **state assets + findings 广播**。

### 6.2 四类状态与存储

| 类型 | 路径 / 结构 | 主要读写者 |
|------|------------|-----------|
| **memory** | `memory/entries/{ts-seq-id}.json` → `MemoryEntry` | 写：Commander `import_findings` / UI / Observer；读：task & snapshot |
| **ideas** | `ideas/index.json` + `ideas/by-id/{id}.json` → `IdeaRecord` | 写：Observer（唯一）/ Commander；读：Planner / solver 只读 |
| **state assets** | `state/index.json` → `StateAsset[]`（host/service/credential/session，去重键 `kind+label+account+host+port`） | 写：solver `record_asset` → `state_upsert` / Commander；读：task / snapshot / planner |
| **relations（攻击图谱）** | `relations.db`（per-target SQLite）→ `MemoryRelation[]`（`source --relation--> target`，去重键 `LOWER(source)+LOWER(relation)+LOWER(target)`） | 写：solver `record_relation` → `relation_upsert`；读：task（喂图谱）/ solver `query_relations` / `find_attack_path`（BFS 最短路） |
| **findings** | `submissions/{ts-id}.json` → `ChallengeSubmissionLogRecord`（proof / writeup / verification_status） | 写：solver `report_finding` → `challenge_submit_flag`；读：Planner / Verifier |

存储模块分工：

| 模块 | 职责 |
|------|------|
| `store.ts` | 目标实体 `challenge.json`、attempt / submission 日志、完成判定 |
| `memory.ts` | 通用 memory / ideas CRUD + 目录锁（被 challenge 根目录与 solver board 共用） |
| `state-store.ts` | 结构化资产表（host / service / credential / session） |

`ChallengeManager` 是这三个 store 的 facade + 广播 + runtime/planner 集成。

### 6.3 Host-Bridge（solver → host 反向通道）

Solver 在隔离容器里，需要把发现 / 资产写回 host、读目标状态——通过 host-bridge 实现。

**协议**：stdin/stdout 上的 **JSONL**（每行一个 JSON）。

```
Solver 容器                              Host (RuntimeManager)
──────────────────────────────────────────────────────────────
engagement-tools / observer
  requestHostBridge(action, params)
       │ stdout: { type:"host_bridge_request", request_id, action, params }
       ├──────────────────────────────────────────────────►
       │                       runtime.readStream() 读 stdout
       │                       handleHostBridgeRequest
       │                       → createChallengeHostBridgeHandler
       │                       → ChallengeManager 方法
       │ stdin: { type:"host_bridge_response", request_id, success, data }
       ◄──────────────────────────────────────────────────┤
  rpc-server resolveHostBridgeResponse → Promise resolve
```

支持的 action（`host-bridge-types.ts`）：

| Action | 行为 | solver 侧工具 |
|--------|------|--------------|
| `challenge_get_state` | 返回目标记录 + scope + `is_completed`（给 observer review） | — |
| `challenge_get_hint` | 实战恒返回 `hint_content: null` | `get_target_intel` |
| `challenge_submit_flag` | 记录发现 + 证据门禁 + 可选触发 Verifier + 广播 steer（实战写本地 findings，不外联） | `report_finding` |
| `challenge_is_completed` | 查目标是否已完成（续跑机制用） | — |
| `state_upsert` | 写结构化资产 | `record_asset` |
| `relation_upsert` | 往攻击图谱写一条有向边 + 广播给同目标其它 solver | `record_relation` |
| `relation_query` | 按 source/relation/target 子串过滤查询图谱边 | `query_relations` |
| `relation_path` | 在图谱里 BFS 求 start→end 最短路径 | `find_attack_path` |

`storeKey` = `TCH_CHALLENGE_ID` env（不是 scope 名）。

---

## 7. Runtime 层 —— Solver 生命周期与执行后端

文件：`packages/core/src/runtime/`。

### 7.1 RuntimeManager（`runtime.ts`）

- 管理 solver 实例状态（`Map<id, SolverInstance>`）与子进程句柄。
- `init()`：等配置就绪 → `ensureImage()` 确保镜像 → bun 运行时下 `ensureSolverBinary()` 预编译 solver 二进制。
- `launch()`：建目录 → 解析二进制注入 → `backend.spawn()` → `readStream()` 读 stdout JSONL → 写 init payload 到 stdin → 等握手。
- `readStream()`：按行 `JSON.parse`，分发 `host_bridge_request` → handler、init response、`AgentSessionEvent` → emit。
- `sendCommand()`：把 `RpcCommand`（含 `host_bridge_response`）写 stdin。

### 7.2 两种执行后端（`execution-backend.ts`）

**核心不变量**：不管 Docker 还是 SSH，solver 都是一个 `Bun.spawn` 出来的子进程，stdin/stdout 跑同一套 JSONL RPC，所以 `readStream` / `sendCommand` 完全复用，后端只负责"启动哪个子进程"和"怎么停"。

| 维度 | DockerBackend | SshBackend |
|------|---------------|------------|
| 子进程 | `docker run -i ...` | `ssh ... 'exec binary solver rpc'` |
| 隔离 | 本机 Kali 容器 | 远程主机直跑 |
| 二进制注入 | volume 挂 host 编译产物到 `/opt/tch-agent/tch-agent:ro` | 用远程 `remoteBinary` |
| 资源限制 | `--memory` / `--cpus` / `networkMode` | 无 |
| 停止 | `docker stop <name>` | `pkill -f '/<solverId>/'`（经 ssh） |

`docker run` 形态（`buildDockerArgs`）：

```bash
docker run -i --platform linux/amd64 \
  --network <host|bridge> --name tch-solver-<id> -w /root/workspace --rm \
  [--memory 2g] [--cpus 1.5] \
  -v <binds...> -e <env...> \
  <image> /opt/tch-agent/tch-agent solver rpc --env KEY=VAL ...
```

`--memory` 仅在非空时加，`--cpus` 仅在 `>0` 时加（留空 = 不限制）。这些通过 UI **Config → Planner** 或 host-settings 配置（见 §10）。

### 7.3 Solver 二进制注入

容器**不把二进制 COPY 进镜像**，镜像只提供 Kali 工具环境；host 把编译好的 `tch-agent` 二进制以只读 volume 挂进容器。三条来源（`resolveSolverInjection`）：

- bun 运行时 → `ensureSolverBinary()` 编译产物（`~/.tch-agent/runtime/self/tch-agent-linux-x64`，约 158MB）
- 已编译的 linux/x64 本体 → 直接用 `execPath`
- 其他平台 → 解压嵌入的 linux 二进制

**新鲜度缓存**（`helpers.ts` 的 `ensureSolverBinary` + `newestSourceMtime`）：二进制 mtime ≥ 所有源文件最新 mtime 则复用，否则重编。`newestSourceMtime` **跳过 `*.generated.*` 文件**（这些文件每次启动都被重写，不跳过会导致缓存永远失效）。这是修掉"每次启动重编 158MB 二进制把内存打满"的关键。

### 7.4 Kali 镜像（`assets/Dockerfile`）

- `FROM --platform=linux/amd64 kalilinux/kali-rolling`。**必须 amd64，不要用 ARM**。
- 工具链：nmap / hydra / sqlmap / gobuster / feroxbuster / masscan / amass / nuclei / ffuf / katana / impacket / NetExec / BloodHound / seclists 等数百个。
- 命令名对齐软链：`/usr/local/bin/httpx → httpx-toolkit`、`/usr/local/bin/testssl.sh → testssl`。
- 镜像约 **10.4GB**，多个 solver **共享同一份镜像**（不是每个占 10GB）。

---

## 8. Solver 会话与扩展（`packages/core/src/solver/`）

### 8.1 会话创建（`session.ts`）

统一经 `ConfigManager.resolvePromptSession(promptName, extensions)` 解析 model / tools / skills / system prompt。

**Solver session** 挂两个 extension：

```129:135:packages/core/src/solver/session.ts
    const extensions = [
        // 上下文压缩：工具输出超过阈值(默认 32KB)就溢出到 workspace 的 .tool-results/ 文件，
        // 上下文里只留 600 字预览 + 文件路径，并提示用 grep/分块读定位。避免 nmap/ffuf/nuclei
        // 等海量输出把上下文撑爆、稀释信号。放在 observer 之前，让后续钩子看到的是已压缩的结果。
        largeToolResultExtension({ workspaceRoot: workspaceDir }),
        challengeObserverExtension({ observerEnabled, observerModel }),
    ]
```

**Subagent session** 只挂 `largeToolResultExtension`。

| 组件 | 是否挂载 | 实际生效条件 |
|------|---------|-------------|
| `largeToolResultExtension` | ✅ 总是 | ✅ 总是 |
| challenge append prompt | ✅ 总是 | ✅ 写入 system prompt |
| observer append prompt | ✅ 传入 | 仅 `observerEnabled: true` |
| `attachChallengeContinuation`（续跑） | ✅ 挂载 | 需 `TCH_CHALLENGE_ID` |
| `attachObserverLoop` + sidecar | ✅ 挂载 | 需 `TCH_CHALLENGE_ID` **且** `observerEnabled` |

### 8.2 上下文压缩（`extension/large-tool-result.ts`）

- 在 SDK 的 **`tool_result`** 钩子介入：序列化输出 → 超过 `DEFAULT_MAX_INLINE_CHARS = 32000` 字符 → 落盘到 `{workspace}/.tool-results/{ts}-{tool}-{id}.md`，inline 只留 600 字预览 + 文件路径 + grep/分块读指引。
- 例外：`read` 读 `SKILL.md` 不压缩。
- **绝不能往 stdout 写 `console.log`**：solver rpc 的 stdout 是 JSONL 协议通道，写非 JSON 行会污染协议、让 host 解析崩溃。日志一律走 **stderr**。

### 8.3 容器内 RPC server（`rpc/rpc-server.ts`）

bootstrap：读一行 stdin（`SolverInitPayload`）→ 解析 prompt 建 session → emit init response。之后 stdin = `RpcCommand`，stdout = `RpcResponse | AgentSessionEvent`。启动后 `session.prompt(initialPrompt)` 自动开干；`resume` 时改发"操作员已撤销完成判定，继续推进"。

---

## 9. Config 层（`packages/core/src/config/`）

### 9.1 工具（`tools/`）

| 文件 | 内容 |
|------|------|
| `engagement-tools.ts` | `report_finding` / `get_target_intel` / `record_asset` + 攻击图谱 `record_relation` / `query_relations` / `find_attack_path`（均走 host-bridge） |
| `security-kimi-search.ts` | `security_kimi_search`：并行 Kimi + Qwen 联网搜安全情报（CVE PoC / EXP / bypass），**不走 host-bridge**，直接 fetch |
| `subagent.ts` | `createSubagentTool()`，prompt 配了 `subagents` 时运行时动态注入 |
| `index.ts` | `customTools = [securityKimiSearchTool, ...engagementTools]`；builtin 工具：bash/read/edit/write/grep/find/ls |

> 历史上的 `challenge-tools` / `document-finding` / `pentest-*` 工具已在 engagement 重构中删除。

### 9.2 内置 Prompt（`prompts/builtin/`，3 个）

| Prompt | 角色 | 常量 |
|--------|------|------|
| `CHALLENGE_PLANNER.md` | Planner 调度器（被 `listPrompts` 过滤，经 `/api/config/host-planner-prompt` 编辑） | `CHALLENGE_PLANNER_PROMPT_NAME` |
| `OBJECTIVE_VERIFIER.md` | 独立目标复验 subagent（`isSubagent: true`，调 `submit_verdict`） | `OBJECTIVE_VERIFIER_PROMPT_NAME` |
| `kimi-security.md` | 主 solver agent（`observerEnabled: true`） | 无常量 |

### 9.3 内置 Skill（`skills/builtin/`，21 个）

`ad-pentest`、`agent-browser`、`ffuf-skill`、`fuzz-dicts-skills`、`intranet-pentest`、`jwt-oauth-token-attacks`、`jwt-tool-skill`、`known-product-exploit`、`nuclei-skill`、`payload-research`、`payloads-everything`、`pentest`、`pentest-fuzz-skill`、`php-payload-builder`、`recon`、`redis-webroot-rce`、`remote-cmd-execution`、`ssrf-server-side-request-forgery`、`targeted-pentest`、`tch-headless-skill`。

其中 `pentest/` 带 `references/`：automation / binary-audit / custom-rules / disclosure / external-platforms / fuzzing / hack-skills / mobile-pentest / pentest-self-audit / source-audit / target-selection。

### 9.4 ConfigManager 关键方法

| 领域 | 方法 |
|------|------|
| Auth | `setApiKey` / `removeApiKey` / `listApiKeys` |
| Provider | `listProviderPrefs` / `addProviderPref` |
| Models | `listModelPrefs` / `addModelPref` / `testModel` |
| Prompts | `listPrompts` / `savePrompt` / `removePrompt` |
| Skills | `listSkills` / `removeSkill` |
| Tools | `resolveTools` / `allTools` |
| MCP | `listMcpServers` / `addMcpServer` / `probeMcpServer` |
| Session | `resolvePromptSession`（从 prompt 组装 `CreateAgentSessionOptions` + 挂 extension） |

---

## 10. Web UI / REST / SSE（`packages/ui-web/`）

### 10.1 Server（`server.ts`，Bun.serve）

REST 路由大类：

| 类别 | 示例 |
|------|------|
| 静态 UI | `/` → `index.html` |
| Auth | `/api/auth/status` `/login` `/logout` |
| Config | `/api/config/{api-keys,providers,models,model-prefs,test-model,skills,prompts,tools,host-settings,host-planner-prompt,mcp,...}` |
| Challenges | `/api/challenges`、`/:id`、`attack-timeline`、`complete`、`revoke-complete`、`memory`、`ideas`、`solvers`、`solver-sessions.zip`、`stats-overview` |
| Runtime | `/api/runtime/{status,solvers,solvers/:id,command,stream}` |
| Commander | `/api/commander/{stream,message,history,messages,status,new-session,rollback-points,rollback}` |

### 10.2 认证（P0）

- 设 `TCH_AUTH_TOKEN`（非空）即启用。凭证：`Authorization: Bearer <token>` 或 HttpOnly cookie `tch_auth`（constant-time 比较）。
- `withAuth()` 包装所有路由，**豁免** `/` 和 `/api/auth/*`；`guard()` 未认证返回 401。
- 登录成功 `Set-Cookie: tch_auth=...; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`。
- 不设 token = 零认证，**公网部署务必设置**（见 deployment.md §5）。

### 10.3 SSE 端点

| 端点 | event | 内容 |
|------|-------|------|
| `/api/runtime/stream` | `status` / `solvers` | Docker ping + solver 列表 |
| `/api/runtime/solvers/:id/stream` | `details` / `agent_event` | solver 详情（含 board）+ AgentSessionEvent |
| `/api/challenges/:id/attack-timeline/stream` | `snapshot` | 攻击时间线快照 |
| `/api/commander/stream` | `commander` | 指挥官对话事件 |

全部带 5s `: keepalive`。反代时需 `proxy_buffering off`（见 deployment.md §7）。

### 10.4 前端（`src/`）

- 入口 `index.html → main.tsx → app.tsx`，hash 路由。
- 登录门：`useAuthGate` + `LoginScreen`（`app.tsx`），未认证先登录再进主 UI。
- 主导航：指挥官 / 目标 / 运行时；Config 子页：目标 / 调度器 / 提供商 / 模型 / 工具 / MCP / 技能 / 提示词。
- 重点页面：`challenge/page.tsx`（列表+详情 Tabs）、`challenge/attack-flow.tsx`（ReactFlow+ELK 攻击流，订阅 SSE 回放）、`commander/page.tsx`（聊天+文档上传）、`runtime/detail-page.tsx`（消息时间线+board）、`config/host.tsx`（含 memory/CPU 限制配置）。

---

## 11. CLI（`apps/cli/src/main.ts`）

| 命令 | 说明 |
|------|------|
| `web` | 启动 Web UI（`-l/--listen`，默认 `127.0.0.1:3000`） |
| `solver <task>` | headless solver（`-p/--prompt`，`-e/--env`） |
| `solver rpc` | 容器内 RPC（stdin JSONL）—— 容器里实际跑的就是它 |
| `solver list` | 列出 agent prompts |
| `subagent <task>` / `subagent list` | subagent 入口 |

> `tui` 默认子命令当前在源码中注释、未启用。启动时会 `initBuiltinSkills` + `initBuiltinPrompts` 把内置资源释放到 `~/.tch-agent/config/`。

---

## 12. 数据持久化

所有状态在运行用户的 `~/.tch-agent/`：

```
~/.tch-agent/
├── config/            API key / provider / model / prompts / skills / host-settings
├── solvers/           活跃 solver 的 session / workspace / 状态 / .observer board
├── archive_solvers/   归档的 solver
├── challenge/         目标与共享作战态（memory / ideas / findings / state assets）
└── runtime/           同步出的 Dockerfile + 编译的 solver 二进制（self/）
```

- 备份重点：`config/` 与 `challenge/`；`solvers/` `runtime/` 可重建。
- 部署时确保该 home 落在持久卷上（见 deployment.md §6）。

---

## 13. 实战（Engagement）模式

- **唯一默认运行形态**；`TCH_ENGAGEMENT_MODE=0` 才关（主要给本地 mock 测试）。
- 用 **scope 白名单** 约束授权目标，**本地 findings** 记录发现，**操作员 / Verifier** 确认完成；不连接远程评分平台。
- **Scope**（`engagement.ts` 的 `EngagementScope`）：`engagement`（名称）、`allowed_targets`（白名单，≥1）、`out_of_scope?`、`no_scan?`、`forbidden_commands?`、`rules_of_engagement?`。
- 加载：`TCH_ENGAGEMENT_SCOPE` 指向 JSON 文件 → `loadEngagementScope` → `parseEngagementScope`（校验失败抛错，不允许无范围运行）。
- 注入点：`launchSolver` 写 env、`buildEngagementSolverTask` 写任务文案、`challenge_get_state` 返回 scope。
- 示例见 `docs/engagement-scope.example.json`，详解见 [docs/engagement-mode.md](docs/engagement-mode.md)。

---

## 14. 开发 / 构建 / 测试

运行时是 **Bun**（非 Node）。常用命令：

```bash
bun install              # 安装依赖（或 bun run install 跑 scripts/install.ts）
bun run web              # 启动 Web UI（apps/cli/src/main.ts web）
bun run dev              # Web HMR（bun --hot；内存紧张机器慎用，见下）
bun test                 # 跑 packages/core 测试
bun run typecheck        # tsc --noEmit -p packages/core
bun run build:linux      # 编译 linux/x64 单文件二进制 → bin/tch-agent-linux-x64
bun run build            # 编译全平台二进制
```

> 内存紧张的机器上 `bun --hot`（dev）可能因高内存 + inotify 触发卡死/宕机；生产/受限环境用 `bun run web`（非 hot）。solver 二进制编译已加新鲜度缓存（§7.3），避免每次启动重编。

代码规范见 [AGENTS.md](AGENTS.md)：kebab-case 文件名、`import type` 分离、named export、Bun API 优先（`Bun.file` / `Bun.serve` / `bun:sqlite` 等）、`strict: true` 不用 `any`。

---

## 15. 部署

完整步骤见 [docs/deployment.md](docs/deployment.md)。要点：

- 两层：轻量控制面（本仓库，进程约 200–400MB）+ solver 执行（Kali 容器，资源大头）。
- **必须 amd64**；solver 镜像约 10.4GB，多 solver 共享一份。
- 执行后端二选一：`docker`（单机 all-in-one）或 `ssh`（控制/执行分离，推荐规模化）。
- 镜像在本地/CI build 后推 registry，服务器只 `pull`（`deploy/build-and-push-image.sh`）。
- 控制面用 `deploy/tch-agent.service`（systemd）常驻，环境变量配 `TCH_AUTH_TOKEN`。
- 公网必设认证、设 solver `--memory`/`--cpus` 上限、只对授权目标作战。

---

## 16. 目录速查

```
apps/cli/                CLI 入口（web / solver / subagent 子命令）
packages/core/src/
├── index.ts             DaemonManager 装配
├── config/              ConfigManager + tools / prompts / skills / providers / mcp
├── challenge/           ChallengeManager / Commander / Planner / Verifier / 共享态 / host-bridge
├── runtime/             RuntimeManager / Docker·SSH 后端 / helpers / Dockerfile
└── solver/              solver 会话 / rpc server / extension(large-tool-result, challenge-observer)
packages/ui-web/         Web UI + REST/SSE（server.ts + React 前端）
packages/ui-tui/         终端 UI（Ink）
packages/libs/pi-mcp-adapter/   MCP 配置加载
deploy/                  tch-agent.service + build-and-push-image.sh
docs/                    deployment.md / engagement-mode.md / engagement-scope.example.json
scripts/                 install.ts / build.ts 等
```
