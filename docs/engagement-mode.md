# 实战（Engagement）模式

面向**已授权**渗透测试与攻防演练（如护网 HVV、红队评估、靶场实战）的运行模式。目标来源、范围约束、发现记录与完成判定均在本地完成，**不依赖远程评分或 flag 平台**。

> 实战模式是**唯一默认运行形态**：`isEngagementMode()` 默认为 true。`challenge` 子系统（目标编排 / memory / ideas / findings / solver 调度）作为通用作战底座保留。仅 `TCH_ENGAGEMENT_MODE=0` 可关闭（主要用于本地 mock 测试）。

## 核心原则

| 维度 | 行为 |
| --- | --- |
| 目标来源 | 操作员在 UI 创建 target，或 Commander `create_target`；`entrypoint` 填授权目标入口 |
| 范围约束 | `TCH_ENGAGEMENT_SCOPE` 指向的 JSON 白名单注入 solver 上下文（**当前为软约束**，见下文） |
| 发现记录 | Solver 调用 `report_finding` → 写入本地 findings / 提交日志，可附 proof、writeup、证据引用 |
| 完成判定 | **操作员外部确认** 或 Verifier 复验通过；引擎不会仅凭模型自述自动判「任务完成」 |
| 情报查询 | `get_target_intel` 在实战下不拉远程 hint，仅返回本地已有上下文 |

## 启用

实战模式默认开启，**无需**额外开关。部署前准备好 scope 文件：

```bash
export TCH_ENGAGEMENT_SCOPE=/绝对路径/engagement-scope.json
# 可选：TCH_ENGAGEMENT_MODE=0  回退 mock 语义（仅本地测试）
```

未设置 `TCH_ENGAGEMENT_SCOPE`、文件不存在、或 `allowed_targets` 为空时，solver 上下文里**无法注入授权范围**。host-bridge 记录类动作仍会落到 target id，但模型看不到明确边界——等于「无 scope 运行」，**强烈不建议**。

## scope 文件格式

见 [engagement-scope.example.json](engagement-scope.example.json)。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `engagement` | 是 | 演练名称，用于报告 / 审计标识 |
| `allowed_targets` | 是（非空） | 授权白名单：IP / 域名 / CIDR / URL 前缀 |
| `out_of_scope` | 否 | 排除项，优先级高于白名单 |
| `no_scan` | 否 | true 则禁用 nmap / ffuf 等主动扫描类命令，默认 false |
| `forbidden_commands` | 否 | 额外禁用的命令 token，叠加在默认集之上 |
| `rules_of_engagement` | 否 | 自由文本约束（禁止 DoS、仅工作时间等） |

## 行为约束

- **范围约束（当前为软约束）**：scope 注入主 solver 与 subagent 的任务上下文，作为必须遵守的行为指令。**尚无自动拦截层**：bash / MCP 不会 block 越界目标或被禁命令。边界靠模型自律 + 操作员复核；统一授权拦截层待建设。
- **发现记录**：`report_finding` 经证据门禁后写入本地 submissions；`correct` 不表示远程裁判认可，仅标记「待操作员确认」；同目标其它 running solver 会收到 steer 广播以降低重复劳动。
- **完成靠人 + Verifier**：`objective_achieved=true` 可触发 Verifier 在容器内复验；`verified` 才 `finishChallenge` 停 solver。操作员也可在 UI 手动标记完成或撤销完成。

## 注意

- scope 文件含真实目标信息，**不要提交进仓库**；示例仅为模板。
- 凭证类证据应通过 `evidence_refs` 引用，避免明文堆进共享状态。

## 操作员工作流

1. 编写 scope 文件（参考模板），设置 `TCH_ENGAGEMENT_SCOPE`，启动 `bun run web`（公网部署务必设 `TCH_AUTH_TOKEN`，见 [deployment.md](deployment.md)）。
2. 在 UI **目标**页创建 target（`POST /api/challenges`）：`id` 用业务标识（不强制 `mock-` 前缀），`entrypoint` 填授权入口 URL / host:port。
3. 启动 Solver（`POST /api/challenges/:id/solvers`，指定 promptName，如 `kimi-security`）。scope 作为软约束注入任务文案；过程中关注是否越界。
4. Solver 验证到漏洞或控制权后调用 `report_finding` 记录发现（本地 findings，不外联）。
5. 在 UI 查看 submissions / 攻击流 / Runtime 详情，范围外复核后决定收尾、续跑或转下一目标。
6. 可选：通过 **指挥官** 对话式下指令、导入历史 findings，或依赖 **调度器** 自动 tick 分配 solver。

## 相关 API（本地 REST）

实战下使用 Web UI 或本机 REST，**不是**外部比赛平台 API：

| 用途 | 方法 / 路径 |
| --- | --- |
| 列出 / 创建目标 | `GET` / `POST` `/api/challenges` |
| 目标详情、memory、ideas | `GET` `/api/challenges/:id` 及子资源 |
| 启动 / 停止 solver | `POST` `/api/challenges/:id/solvers`；Runtime API 停止实例 |
| 攻击时间线 | `GET` `/api/challenges/:id/attack-timeline`（SSE 流式） |
| 手动完成 / 撤销完成 | `POST` `/api/challenges/:id/complete`、`revoke-complete` |

完整路由见 [ARCHITECTURE.md](../ARCHITECTURE.md) 第 10 节。
