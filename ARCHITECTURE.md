# Architecture and Project Documentation

> This is the complete engineering documentation for BreachWeave / `tch-agent`: what the system is, how roles collaborate, how code is layered, how data flows, and how to develop and deploy.
>
> Related documents:
> - [README.md](README.md) — Project overview and architectural philosophy
> - [docs/项目文档.md](docs/项目文档.md) — Full Chinese project guide (deployment, engagement, API index)
> - [docs/配置手册.md](docs/配置手册.md) — Configuration reference (`~/.tch-agent/config/`)
> - [AGENTS.md](AGENTS.md) — Code style and Bun conventions

---

## 1. What This Is

BreachWeave is a **multi-agent collaboration system for authorized penetration testing**. It is not a single LLM running tools; it splits the penetration process into clearly scoped roles orchestrated by a non-LLM central hub:

- **Commander** — Human-driven conversational commander (LLM).
- **Planner** — Periodic, unattended auto-scheduler (LLM).
- **Solver** — Entity that executes the kill chain inside Kali containers (LLM).
- **Observer** — Sidecar supervisor maintaining the strategy board and lightweight course correction (LLM).
- **Verifier** — Independent re-verification subagent confirming whether objectives are truly achieved (LLM).
- **ChallengeManager** — **Pure-logic orchestration hub** wiring the above together (non-LLM).

All LLMs use **external APIs** (no models on the server; no GPU). Solver attack actions run in an **isolated Kali execution environment** (local Docker container or remote SSH host).

> This system can launch **real attacks**. Use it only against **authorized** targets with engagement scope configured.

---

## 2. Runtime Assembly (DaemonManager)

On process startup, `DaemonManager` (`packages/core/src/index.ts`) assembles four managers as a singleton — the dependency skeleton of the entire backend:

```
DaemonManager.getInstance()
├── ConfigManager        Config (API key / provider / model / prompt / skill / host-settings)
├── ChallengeManager     Orchestration hub (targets, shared state, Planner, Verifier)
├── RuntimeManager       Solver container lifecycle + JSONL RPC bridge
│     └── registers host-bridge handler: createChallengeHostBridgeHandler(challenge)
└── CommanderManager     Conversational commander agent
```

Key wiring (`index.ts:27-44`):

```31:35:packages/core/src/index.ts
            const config = await ConfigManager.getInstance()
            const challenge = new ChallengeManager(config)
            const runtime = new RuntimeManager(config, [createChallengeHostBridgeHandler(challenge)])
            challenge.attachRuntime(runtime)
            const commander = new CommanderManager(config, challenge)
```

- `ChallengeManager` obtains solver start/stop capability via `attachRuntime(runtime)`.
- `RuntimeManager` is constructed with the challenge host-bridge handler injected — the sole channel for solver reverse calls to the host.
- `CommanderManager` holds `challenge`; all commander tools are thin wrappers over `ChallengeManager` capabilities.

---

## 3. Layered Architecture

```
┌──────────────────────────────────────────────────────────┐
│  apps/cli            CLI entry (Commander.js)              │
│  └─ web / solver / solver rpc / subagent subcommands       │
├──────────────────────────────────────────────────────────┤
│  packages/ui-web     Web UI + REST/SSE (Bun.serve)        │
│  packages/ui-tui     Terminal UI (Ink, paused for some)   │
│  └─ calls @tch/core DaemonManager                         │
├──────────────────────────────────────────────────────────┤
│  packages/core       @tch/core                             │
│  ├─ config/    ConfigManager: config, tools, prompt, skill │
│  ├─ challenge/ ChallengeManager / Commander / Planner /   │
│  │             Verifier / shared blackboard / host-bridge │
│  ├─ runtime/   RuntimeManager / Docker backend / image    │
│  └─ solver/    solver session / RPC server / observer ext │
├──────────────────────────────────────────────────────────┤
│  packages/libs/pi-mcp-adapter   MCP config loading         │
├──────────────────────────────────────────────────────────┤
│  pi-coding-agent SDK / pi-ai SDK (third-party)             │
└──────────────────────────────────────────────────────────┘
```

Dependencies flow strictly one way: `UI → Runtime → Service → Config → Types`; `@tch/core` does not depend on any UI package.

Package dependencies:

```
@tch/cli
  ├── @tch/ui-web  ──→  @tch/core ──→ pi-mcp-adapter
  └── @tch/ui-tui  ──→  @tch/core
```

---

## 4. Multi-Agent Collaboration (System Core)

This is the project's core value. Five LLM roles plus one orchestration hub, each with a distinct responsibility.

### 4.1 Overview

```
                        REST / SSE
   Operator ───────────► Web UI ──────────► DaemonManager
                                                  │
   ┌──────────────┐   tool calls     ┌─────────────▼──────────────┐
   │ Commander    │ ─────────────► │      ChallengeManager       │ ◄── REST/UI direct calls
   │ (LLM, disk)  │                │   (orchestration hub, non-agent)│
   └──────────────┘                └──────┬───────────────┬──────┘
                                          │               │
        startSyncLoop / tickPlanner       │               │ launchSolver / steer / stop
                  │                        ▼               ▼
        ┌──────────────────┐      ┌───────────────┐  ┌────────────────────┐
        │ Planner          │      │ Verifier      │  │ RuntimeManager     │
        │ (LLM, periodic/  │      │ (LLM, re-verify)│  │ Docker / SSH solver │
        │  inMemory)       │      └───────────────┘  └─────────┬──────────┘
        └────────┬─────────┘                                    │
                 │ planner_launch_solver / steer                │
                 └──────────────────────────────────────────────┤
                                                                 ▼
                                                    ┌──────────────────────────┐
                                                    │ Solver (LLM, Kali container)│
                                                    │   + Observer sidecar (LLM)  │
                                                    │   + continuation (ralph-loop)│
                                                    └────────────┬─────────────┘
                                                                 │ host-bridge (stdout JSONL)
                                                                 ▼
                                                   host-bridge-handler → ChallengeManager
```

### 4.2 Commander — Conversational Commander

- **Is an LLM agent** with persisted sessions (`SessionManager.continueRecent`, multi-turn, human-driven).
- File: `packages/core/src/challenge/commander.ts`; system prompt fixed to `COMMANDER_SYSTEM_PROMPT`; skills not loaded.
- Available only in engagement mode.
- 7 tools (`defineTool`), all thin wrappers over `ChallengeManager`:

| Tool | Delegates to |
|------|-----------|
| `create_target` | `createChallenge(...)` |
| `launch_solver` | `launchSolver(targetId, "kimi-security", { plannerHandoff })` |
| `list_targets` | `listStoredChallenges()` |
| `list_solvers` | `getRuntime().listAll()` |
| `stop_solver` | `getRuntime().stopSolver(solverId)` |
| `import_findings` | `upsertStateAsset` / `appendMemory` / `addIdea` |
| `get_solver_progress` | `listMemory` / `listIdeas` / `listSubmissionLogs` |

Commander and Planner share the same `ChallengeManager` capabilities; the difference is **trigger mode**: Commander is human-driven persistent sessions; Planner is periodic one-shot sessions.

### 4.3 Planner — Auto-Scheduler

- **Is an LLM agent**, but each tick creates a fresh one-shot session via `SessionManager.inMemory()` (not persisted).
- Implemented in `manager.ts`: `runPlannerOnce` / `createPlannerTools` / `buildPlannerSnapshot` / `wrapPlannerResourceLoader`; system prompt is `CHALLENGE_PLANNER` (built-in prompt).
- Trigger: `startSyncLoop()` calls `tickPlanner` every `planner.tickIntervalMs` (default 30s); can also be triggered manually. Scheduler is **always on** (not disableable in UI); parameters like `maxSolvers` are in Config → Planner. Requires runtime attached.
- Input snapshot (`buildPlannerSnapshot`): challenge-level memory / ideas / findings / state assets + each solver local board's `currentFocus`.
- Output: round scheduling narrative + tool side effects + persisted `planner-last-round.json` (`actions` / `summary` / `battlePlan`).
- 7 `planner_*` tools: `planner_get_state`, `planner_start_challenge`, `planner_stop_challenge`, `planner_launch_solver`, `planner_stop_solver`, `planner_steer_solver`, `planner_set_plan`.

### 4.4 Solver — Executor

- **Is an LLM agent** running inside a Kali container (or remote SSH host), hosted by the `solver rpc` process.
- Main prompt: built-in `kimi-security.md` (authorized penetration operator, Kali kill-chain methodology, `observerEnabled: true`, enables `security_kimi_search` + 3 engagement tools + many skills).
- Communicates with the host via three host-bridge tools (see §6.3):
  - `report_finding` → `challenge_submit_flag` (records verified findings / declares objective achieved, writes local findings)
  - `get_target_intel` → `challenge_get_hint`
  - `record_asset` → `state_upsert` (writes cross-solver shared assets)
- Multiple Solvers can run in parallel per target, exploring different directions.

### 4.5 Observer — Sidecar Supervisor

- **Is an independent LLM agent**, but runs **in-process with the Solver**: scheduled asynchronously in the solver main session extension; each review creates a temporary `createAgentSession` + `dispose` on completion.
- Implementation: `packages/core/src/solver/extension/challenge-observer/`.
- Activation: `TCH_CHALLENGE_ID` present **and** prompt `observerEnabled: true`.
- Trigger timing: every 6 assistant messages (periodic) / on `challenge_get_hint` (hint) / on each `agent_end`. Each review includes a summary of the last 10 rounds of activity.
- Does two things:
  1. **Maintains the strategy board** (primary path): writes ideas / memory under `.observer/board/`; solver consumes via read-only tools (`idea_list` / `memory_list`, etc.). Observer is the **sole writer** of ideas.
  2. **Lightweight course correction** (last resort): `send_efficiency_reminder` → `pi.sendUserMessage(..., { deliverAs: "steer" })`, with cooldown (6 rounds) / dedup (12 rounds) to avoid noise.

### 4.6 Verifier — Independent Re-Verification

- **Is an LLM subagent** (`OBJECTIVE_VERIFIER.md`, `isSubagent: true`), using `SessionManager.inMemory()`.
- Trigger: solver `report_finding(objective_achieved=true)` → host-bridge `challenge_submit_flag` passes evidence gate → `ChallengeManager.verifyObjective(...)` launches it.
- **Reproduces** inside the Kali container what the solver claims was achieved; must call `submit_verdict`:
  - `verified` → `markEngagementComplete` → `finishChallenge` (stops solvers for that target)
  - `rejected` / `inconclusive` → no wrap-up; solver continues

### 4.7 Externalized Termination (Prevents Premature End)

Implemented by `attachChallengeContinuation` in `challenge-observer/ralph-loop.ts`; **does not depend on observer**; registers whenever `isChallengeMode()`:

- Each `agent_end` (solver considers a round complete) first queries `challenge_is_completed` via host-bridge;
- If not complete → auto-injects a continuation message (`triggerTurn: true`) to start the next round, emphasizing "continue from existing recon, do not start over";
- On error, retries up to 10 times with exponential backoff.

This **externalizes** "whether the task is done" from the model's subjective judgment to system state, preventing complex tasks from ending too early.

---

## 5. ChallengeManager — Orchestration Hub

File: `packages/core/src/challenge/manager.ts`. **Pure logic layer** — not an agent itself, but embeds Planner and Verifier LLM sub-sessions.

### 5.1 Core Fields (excerpt)

| Field | Purpose |
|------|------|
| `config` | Model / prompt / hostSettings |
| `runtime` | Start/stop / steer solver |
| `syncTimer` / `syncLoopStarted` | Planner periodic tick loop |
| `plannerRunning` | Planner single-flight lock |
| `finishingChallenges` / `stoppedOnCompletion` | Completion wrap-up & precise resume on "revoke complete" |

### 5.2 Core Methods

- **`launchSolver(challengeId, promptName, options?)`**: Builds engagement task text (injects scope / memory / ideas / findings / state assets / handoff) → **seeds** from challenge-level shared state to solver local board → injects `TCH_CHALLENGE_ID` etc. env → `runtime.launch(...)` starts container.
- **`tickPlanner` / `startSyncLoop`**: Periodically triggers Planner.
- **`runPlannerOnce(source)`**: Runs one Planner LLM round (inMemory).
- **`verifyObjective(...)`**: Launches Verifier LLM re-verification; wraps up only on `verified`.
- Shared-state CRUD (memory / ideas / state assets / submissions) + **broadcast** to running solvers on the same target after writes.

---

## 6. Shared Operational State (Blackboard) and Host-Bridge

### 6.1 Two Board Layers

The system deliberately separates two state layers to avoid mixing "direction" with "facts":

| Layer | Location | Description |
|----|------|------|
| **Challenge-level shared state** | `~/.tch-agent/challenge/{id}/` | Global facts shared across solvers; read by Planner / Commander / Verifier |
| **Solver-level local board** | `{solverSession}/.observer/board/` | Single solver strategy board; maintained by Observer |

On launch, one-way **seed** from challenge level to solver local board (`seedSolverBoardFromChallenge`); cross-solver reuse via challenge-level **state assets + findings broadcast**.

### 6.2 Four State Types and Storage

| Type | Path / Structure | Primary Readers/Writers |
|------|------------|-----------|
| **memory** | `memory/entries/{ts-seq-id}.json` → `MemoryEntry` | Write: Commander `import_findings` / UI / Observer; Read: task & snapshot |
| **ideas** | `ideas/index.json` + `ideas/by-id/{id}.json` → `IdeaRecord` | Write: Observer (sole) / Commander; Read: Planner / solver read-only |
| **state assets** | `state/index.json` → `StateAsset[]` (host/service/credential/session, dedup key `kind+label+account+host+port`) | Write: solver `record_asset` → `state_upsert` / Commander; Read: task / snapshot / planner |
| **findings** | `submissions/{ts-id}.json` → `ChallengeSubmissionLogRecord` (proof / writeup / verification_status) | Write: solver `report_finding` → `challenge_submit_flag`; Read: Planner / Verifier |

Storage module responsibilities:

| Module | Responsibility |
|------|------|
| `store.ts` | Target entity `challenge.json`, attempt / submission logs, completion determination |
| `memory.ts` | Generic memory / ideas CRUD + directory lock (shared by challenge root and solver board) |
| `state-store.ts` | Structured asset table (host / service / credential / session) |

`ChallengeManager` is the facade over these three stores + broadcast + runtime/planner integration.

### 6.3 Host-Bridge (solver → host reverse channel)

Solvers run in isolated containers and need to write findings / assets back to the host and read target state — via host-bridge.

**Protocol**: **JSONL** on stdin/stdout (one JSON object per line).

```
Solver container                           Host (RuntimeManager)
──────────────────────────────────────────────────────────────
engagement-tools / observer
  requestHostBridge(action, params)
       │ stdout: { type:"host_bridge_request", request_id, action, params }
       ├──────────────────────────────────────────────────►
       │                       runtime.readStream() reads stdout
       │                       handleHostBridgeRequest
       │                       → createChallengeHostBridgeHandler
       │                       → ChallengeManager methods
       │ stdin: { type:"host_bridge_response", request_id, success, data }
       ◄──────────────────────────────────────────────────┤
  rpc-server resolveHostBridgeResponse → Promise resolve
```

Supported actions (`host-bridge-types.ts`):

| Action | Behavior | Solver-side tool |
|--------|------|--------------|
| `challenge_get_state` | Returns target record + scope + `is_completed` (for observer review) | — |
| `challenge_get_hint` | Always returns `hint_content: null` in engagement | `get_target_intel` |
| `challenge_submit_flag` | Records finding + evidence gate + optional Verifier trigger + broadcast steer (engagement writes local findings, no external linkage) | `report_finding` |
| `challenge_is_completed` | Checks whether target is complete (for continuation mechanism) | — |
| `state_upsert` | Writes structured asset | `record_asset` |

`storeKey` = `TCH_CHALLENGE_ID` env (not scope name).

---

## 7. Runtime Layer — Solver Lifecycle and Execution Backend

Files: `packages/core/src/runtime/`.

### 7.1 RuntimeManager (`runtime.ts`)

- Manages solver instance state (`Map<id, SolverInstance>`) and subprocess handles.
- `init()`: wait for config ready → `ensureImage()` ensures image → under bun runtime `ensureSolverBinary()` precompiles solver binary.
- `launch()`: create directory → resolve binary injection → `backend.spawn()` → `readStream()` reads stdout JSONL → write init payload to stdin → wait for handshake.
- `readStream()`: line-by-line `JSON.parse`, dispatches `host_bridge_request` → handler, init response, `AgentSessionEvent` → emit.
- `sendCommand()`: writes `RpcCommand` (including `host_bridge_response`) to stdin.

### 7.2 Docker Execution Backend (`execution-backend.ts`)

**Core invariant**: The solver is a `Bun.spawn` child of `docker run -i` with JSONL RPC on stdin/stdout. Pentest commands inside the container go to **remote Kali** via MCP `kali-arsenal` (`ssh_execute`), not a second solver backend.

| Dimension | DockerBackend |
|------|---------------|
| Subprocess | `docker run -i ...` |
| Isolation | Local Kali container |
| Binary injection | volume mounts host build artifact to `/opt/tch-agent/tch-agent:ro` |
| Resource limits | `--memory` / `--cpus` / `networkMode` |
| Stop | `docker stop <name>` + kill local client |

`docker run` form (`buildDockerArgs`):

```bash
docker run -i --platform linux/amd64 \
  --network <host|bridge> --name tch-solver-<id> -w /root/workspace --rm \
  [--memory 2g] [--cpus 1.5] \
  -v <binds...> -e <env...> \
  <image> /opt/tch-agent/tch-agent solver rpc --env KEY=VAL ...
```

`--memory` added only when non-empty; `--cpus` only when `>0` (empty = no limit). Configured via UI **Config → Planner** or host-settings (see §10).

### 7.3 Solver Binary Injection

The container **does not COPY the binary into the image**; the image only provides the Kali tool environment; the host mounts the compiled `tch-agent` binary read-only via volume. Three sources (`resolveSolverInjection`):

- bun runtime → `ensureSolverBinary()` build artifact (`~/.tch-agent/runtime/self/tch-agent-linux-x64`, ~158MB)
- already-built linux/x64 binary → use `execPath` directly
- other platforms → extract embedded linux binary

**Freshness cache** (`helpers.ts` `ensureSolverBinary` + `newestSourceMtime`): reuse if binary mtime ≥ newest source file mtime; otherwise rebuild. `newestSourceMtime` **skips `*.generated.*` files** (rewritten every startup; not skipping would invalidate cache forever). This fixes "recompiling 158MB binary every startup exhausting memory".

### 7.4 Kali Image (`assets/Dockerfile`)

- `FROM --platform=linux/amd64 kalilinux/kali-rolling`. **Must be amd64; do not use ARM**.
- Toolchain: nmap / hydra / sqlmap / gobuster / feroxbuster / masscan / amass / nuclei / ffuf / katana / impacket / NetExec / BloodHound / seclists and hundreds more.
- Command name alignment symlinks: `/usr/local/bin/httpx → httpx-toolkit`, `/usr/local/bin/testssl.sh → testssl`.
- Image ~ **10.4GB**; multiple solvers **share the same image** (not 10GB each).

---

## 8. Solver Session and Extensions (`packages/core/src/solver/`)

### 8.1 Session Creation (`session.ts`)

Unified resolution via `ConfigManager.resolvePromptSession(promptName, extensions)` for model / tools / skills / system prompt.

**Solver session** mounts two extensions:

```129:135:packages/core/src/solver/session.ts
    const extensions = [
        // Context compression: tool output over threshold (default 32KB) spills to workspace .tool-results/ files,
        // context keeps 600-char preview + file path + grep/chunk-read hints. Prevents nmap/ffuf/nuclei
        // massive output from blowing up context and diluting signal. Before observer so subsequent hooks see compressed results.
        largeToolResultExtension({ workspaceRoot: workspaceDir }),
        challengeObserverExtension({ observerEnabled, observerModel }),
    ]
```

**Subagent session** mounts only `largeToolResultExtension`.

| Component | Mounted | Effective when |
|------|---------|-------------|
| `largeToolResultExtension` | ✅ always | ✅ always |
| challenge append prompt | ✅ always | ✅ written to system prompt |
| observer append prompt | ✅ passed | only `observerEnabled: true` |
| `attachChallengeContinuation` (continuation) | ✅ mounted | requires `TCH_CHALLENGE_ID` |
| `attachObserverLoop` + sidecar | ✅ mounted | requires `TCH_CHALLENGE_ID` **and** `observerEnabled` |

### 8.2 Context Compression (`extension/large-tool-result.ts`)

- Intervenes at SDK **`tool_result`** hook: serialize output → exceeds `DEFAULT_MAX_INLINE_CHARS = 32000` chars → write to `{workspace}/.tool-results/{ts}-{tool}-{id}.md`, inline keeps 600-char preview + file path + grep/chunk-read guidance.
- Exception: `read` of `SKILL.md` is not compressed.
- **Never write `console.log` to stdout**: solver rpc stdout is the JSONL protocol channel; non-JSON lines corrupt the protocol and crash host parsing. All logs go to **stderr**.

### 8.3 In-Container RPC Server (`rpc/rpc-server.ts`)

Bootstrap: read one stdin line (`SolverInitPayload`) → resolve prompt, create session → emit init response. After that stdin = `RpcCommand`, stdout = `RpcResponse | AgentSessionEvent`. After startup `session.prompt(initialPrompt)` starts work; on `resume`, sends "operator revoked completion, continue advancing".

---

## 9. Config Layer (`packages/core/src/config/`)

### 9.1 Tools (`tools/`)

| File | Content |
|------|------|
| `engagement-tools.ts` | `report_finding` / `get_target_intel` / `record_asset` (all via host-bridge) |
| `security-kimi-search.ts` | `security_kimi_search`: parallel Kimi + Qwen web search for security intel (CVE PoC / EXP / bypass); **not via host-bridge**, direct fetch |
| `subagent.ts` | `createSubagentTool()`, dynamically injected at runtime when prompt configures `subagents` |
| `index.ts` | `customTools = [securityKimiSearchTool, ...engagementTools]`; builtin tools: bash/read/edit/write/grep/find/ls |

> Historical `challenge-tools` / `document-finding` / `pentest-*` tools were removed in the engagement refactor.

### 9.2 Built-in Prompts (`prompts/builtin/`, 3 total)

| Prompt | Role | Constant |
|--------|------|------|
| `CHALLENGE_PLANNER.md` | Planner scheduler (filtered by `listPrompts`, edited via `/api/config/host-planner-prompt`) | `CHALLENGE_PLANNER_PROMPT_NAME` |
| `OBJECTIVE_VERIFIER.md` | Independent objective re-verification subagent (`isSubagent: true`, calls `submit_verdict`) | `OBJECTIVE_VERIFIER_PROMPT_NAME` |
| `kimi-security.md` | Main solver agent (`observerEnabled: true`) | no constant |

### 9.3 Built-in Skills (`skills/builtin/`, 11 total)

`ffuf-skill`, `fuzz-dicts-skills` (skill name `fuzz-dicts-navigator`), `known-product-exploit`, `nuclei-skill`, `payload-research`, `payloads-everything` (skill name `payloads-all-the-things`), `pentest`, `pentest-fuzz-skill`, `recon`, `remote-cmd-execution`, `targeted-pentest`.

Removed from the repo (not loaded by any default prompt): `ad-pentest`, `agent-browser`, `intranet-pentest`, `jwt-oauth-token-attacks`, `jwt-tool-skill`, `php-payload-builder`, `redis-webroot-rce`, `ssrf-server-side-request-forgery`, `tch-headless-skill`.

`pentest/` includes `references/`: automation / binary-audit / custom-rules / disclosure / external-platforms / fuzzing / hack-skills / mobile-pentest / pentest-self-audit / source-audit / target-selection.

### 9.4 ConfigManager Key Methods

| Domain | Methods |
|------|------|
| Auth | `setApiKey` / `removeApiKey` / `listApiKeys` |
| Provider | `listProviderPrefs` / `addProviderPref` |
| Models | `listModelPrefs` / `addModelPref` / `testModel` |
| Prompts | `listPrompts` / `savePrompt` / `removePrompt` |
| Skills | `listSkills` / `removeSkill` |
| Tools | `resolveTools` / `allTools` |
| MCP | `listMcpServers` / `addMcpServer` / `probeMcpServer` |
| Session | `resolvePromptSession` (assembles `CreateAgentSessionOptions` from prompt + mount extensions) |

---

## 10. Web UI / REST / SSE (`packages/ui-web/`)

### 10.1 Server (`server.ts`, Bun.serve)

REST route categories:

| Category | Examples |
|------|------|
| Static UI | `/` → `index.html` |
| Auth | `/api/auth/status` `/login` `/logout` |
| Config | `/api/config/{api-keys,providers,models,model-prefs,test-model,skills,prompts,tools,host-settings,host-planner-prompt,mcp,...}` |
| Challenges | `/api/challenges`, `/:id`, `attack-timeline`, `complete`, `revoke-complete`, `memory`, `ideas`, `solvers`, `solver-sessions.zip`, `stats-overview` |
| Runtime | `/api/runtime/{status,solvers,solvers/:id,command,stream}` |
| Commander | `/api/commander/{stream,message,history,messages,status,new-session,rollback-points,rollback}` |

### 10.2 Authentication (P0)

- Set `TCH_AUTH_TOKEN` (non-empty) to enable. Credentials: `Authorization: Bearer <token>` or HttpOnly cookie `tch_auth` (constant-time compare).
- `withAuth()` wraps all routes, **exempts** `/` and `/api/auth/*`; `guard()` returns 401 when unauthenticated.
- On login success `Set-Cookie: tch_auth=...; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`.
- No token = zero auth; **must set for public deployment** (see docs/项目文档.md §5).

### 10.3 SSE Endpoints

| Endpoint | event | Content |
|------|-------|------|
| `/api/runtime/stream` | `status` / `solvers` | Docker ping + solver list |
| `/api/runtime/solvers/:id/stream` | `details` / `agent_event` | Solver details (incl. board) + AgentSessionEvent |
| `/api/challenges/:id/attack-timeline/stream` | `snapshot` | Attack timeline snapshot |
| `/api/commander/stream` | `commander` | Commander conversation events |

All include 5s `: keepalive`. Reverse proxy needs `proxy_buffering off` (see docs/项目文档.md §7).

### 10.4 Frontend (`src/`)

- Entry `index.html → main.tsx → app.tsx`, hash routing.
- Login gate: `useAuthGate` + `LoginScreen` (`app.tsx`); unauthenticated users see login before main UI.
- Main nav: Commander / Targets / Runtime; Config subpages: Targets / Planner / Providers / Models / Tools / MCP / Skills / Prompts.
- Key pages: `challenge/page.tsx` (list+detail tabs), `challenge/attack-flow.tsx` (ReactFlow+ELK attack flow, SSE replay), `commander/page.tsx` (chat+document upload), `runtime/detail-page.tsx` (message timeline+board), `config/host.tsx` (incl. memory/CPU limit config).

---

## 11. CLI (`apps/cli/src/main.ts`)

| Command | Description |
|------|------|
| `web` | Start Web UI (`-l/--listen`, default `127.0.0.1:3000`) |
| `solver <task>` | Headless solver (`-p/--prompt`, `-e/--env`) |
| `solver rpc` | In-container RPC (stdin JSONL) — what actually runs inside containers |
| `solver list` | List agent prompts |
| `subagent <task>` / `subagent list` | Subagent entry |

> `tui` default subcommand is currently commented out in source, not enabled. Startup runs `initBuiltinPrompts` + `initBuiltinMcpServers` under `~/.tch-agent/config/`. Built-in **skills** load from the repo tree `packages/core/src/config/skills/builtin/` when developing from source (`$TCH_BUILTIN_SKILLS_DIR`); compiled binaries without that tree copy skills into `~/.tch-agent/config/skills/` instead. Docker solvers bind-mount the repo builtin path when it differs from the config copy. Built-in MCP scripts in `mcp.json` use `/opt/tch-mcp/*.py`; runtime bind-mounts the repo `mcp/` directory to that path (read-only). Host-side MCP probe resolves `/opt/tch-mcp` back to the checkout.

---

## 12. Data Persistence

All state under the running user's `~/.tch-agent/`:

```
~/.tch-agent/
├── config/            API key / provider / model / prompts / skills / host-settings
├── solvers/           Active solver session / workspace / state / .observer board
├── archive_solvers/   Archived solvers
├── challenge/         Targets and shared operational state (memory / ideas / findings / state assets)
└── runtime/           Synced Dockerfile + compiled solver binary (self/)
```

- Backup priorities: `config/` and `challenge/`; `solvers/` and `runtime/` can be rebuilt.
- On deployment ensure home is on persistent volume (see docs/项目文档.md §6).

---

## 13. Engagement Mode

- **Only default runtime**; disable with `TCH_ENGAGEMENT_MODE=0` (mainly for local mock testing).
- **Scope whitelist** constrains authorized targets; **local findings** record discoveries; **operator / Verifier** confirm completion; no remote scoring platform.
- **Scope** (`EngagementScope` in `engagement.ts`): `engagement` (name), `allowed_targets` (whitelist, ≥1), `out_of_scope?`, `no_scan?`, `forbidden_commands?`, `rules_of_engagement?`.
- Loading: `TCH_ENGAGEMENT_SCOPE` points to JSON file → `loadEngagementScope` → `parseEngagementScope` (validation failure throws; running without scope not allowed).
- Injection points: `launchSolver` writes env, `buildEngagementSolverTask` writes task text, `challenge_get_state` returns scope.
- Example: `docs/engagement-scope.example.json`; details in [docs/项目文档.md](docs/项目文档.md).

---

## 14. Development / Build / Test

Runtime is **Bun** (not Node). Common commands:

```bash
bun install              # install deps (or bun run install runs scripts/install.ts)
bun run web              # start Web UI (apps/cli/src/main.ts web)
bun run dev              # Web HMR (bun --hot; use cautiously on memory-constrained machines, see below)
bun test                 # run packages/core tests
bun run typecheck        # tsc --noEmit -p packages/core
bun run build:linux      # compile linux/x64 single-file binary → bin/tch-agent-linux-x64
bun run build            # compile all-platform binaries
```

> On memory-constrained machines `bun --hot` (dev) may hang/crash from high memory + inotify; use `bun run web` (non-hot) in production/constrained environments. Solver binary compile has freshness cache (§7.3) to avoid rebuild every startup.

Code style: see [AGENTS.md](AGENTS.md) — kebab-case filenames, `import type` separation, named exports, Bun API preference (`Bun.file` / `Bun.serve` / `bun:sqlite`, etc.), `strict: true` no `any`.

---

## 15. Deployment

Full steps: [docs/项目文档.md](docs/项目文档.md) §10. Highlights:

- Two layers: lightweight control plane (this repo, process ~200–400MB) + solver execution (Kali containers, bulk of resources).
- **Must be amd64**; solver image ~10.4GB, multiple solvers share one copy.
- Solvers: local Docker only; remote Kali via MCP `kali-arsenal` SSH (Settings → MCP).
- Image built locally/CI and pushed to registry; server only `pull`s (`deploy/build-and-push-image.sh`).
- Control plane via `deploy/tch-agent.service` (systemd) with `TCH_AUTH_TOKEN` env.
- Public deployment: require auth, set solver `--memory`/`--cpus` limits, operate only against authorized targets.

---

## 16. Directory Quick Reference

```
apps/cli/                CLI entry (web / solver / subagent subcommands)
packages/core/src/
├── index.ts             DaemonManager assembly
├── config/              ConfigManager + tools / prompts / skills / providers / mcp
├── challenge/           ChallengeManager / Commander / Planner / Verifier / shared state / host-bridge
├── runtime/             RuntimeManager / Docker backend / helpers / Dockerfile
└── solver/              solver session / rpc server / extension(large-tool-result, challenge-observer)
packages/ui-web/         Web UI + REST/SSE (server.ts + React frontend)
packages/ui-tui/         Terminal UI (Ink)
packages/libs/pi-mcp-adapter/   MCP config loading
deploy/                  tch-agent.service + build-and-push-image.sh
docs/                    项目文档.md / 配置手册.md / engagement-scope.example.json
scripts/                 install.ts / build.ts etc.
```
