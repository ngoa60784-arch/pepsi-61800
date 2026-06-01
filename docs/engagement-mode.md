# 实战（Engagement）模式

面向**授权**攻防演练（如护网 HVV）的运行模式。本项目已**移除 CTF 比赛链路**：不再连接任何远程评分 API，改用本地 scope 白名单 + findings 取证 + 操作员确认。

> 实战模式现在是**唯一运行形态、默认开启**：`isEngagementMode()` 默认为 true，host-bridge 统一走实战处理，CTF 远程评分/flag-scoring 分支已删除。`hasRealApiMode()` 恒为 false，永不外联腾讯评分服务。仅 `TCH_ENGAGEMENT_MODE=0` 这个逃生口可关闭（主要给历史 mock 测试用）。`challenge` 子系统（Manager/Observer/memory/ideas/board/solver 编排）作为通用编排底座保留。

## 与（已移除的）CTF 模式的区别

| 维度 | 旧 CTF 行为（已删除） | 实战模式 |
| --- | --- | --- |
| 目标来源 | 远程拉题（challengeId） | 本地 scope 文件白名单 + 操作员创建 target |
| 范围约束 | 无（题目即沙箱） | scope 文件定义授权白名单，注入 solver 上下文；**目前无自动拦截层**，边界靠模型自律 + 操作员复核 |
| "提交" | flag 提交给远程裁判打分 | 已验证目标记录到本地 findings/提交日志 |
| 完成判定 | 远程 API（flag 拿全） | **操作员外部确认**，引擎从不自动判完成 |

## 启用

实战模式默认开启，**无需**额外开关。只需提供 scope 文件：

```bash
export TCH_ENGAGEMENT_SCOPE=/绝对路径/engagement-scope.json
# 可选：TCH_ENGAGEMENT_MODE=0 显式回退到历史 mock 语义（仅测试/调试用）
```

未设置 `TCH_ENGAGEMENT_SCOPE`、文件不存在、或 `allowed_targets` 为空时，solver 上下文里无法注入授权范围；host-bridge 记录类动作会回退到 solver 的 challengeId 标识，但**强烈建议始终提供 scope 文件**，否则模型只能看到任务入口、完全不知道授权边界，等于"无授权范围运行"。

## scope 文件格式

见 [engagement-scope.example.json](engagement-scope.example.json)。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `engagement` | 是 | 演练名称，用于报告/审计标识 |
| `allowed_targets` | 是（非空） | 授权白名单：IP / 域名 / CIDR / URL 前缀 |
| `out_of_scope` | 否 | 排除项，优先级高于白名单 |
| `no_scan` | 否 | true 则禁用 nmap/ffuf 等主动扫描类命令，默认 false |
| `forbidden_commands` | 否 | 额外禁用的命令 token，叠加在默认集之上 |
| `rules_of_engagement` | 否 | 自由文本约束（禁止 DoS、仅工作时间等） |

## 行为约束

- **范围约束（当前为软约束）**：scope 的 `allowed_targets` / `out_of_scope` / `rules_of_engagement` 会注入主 solver 与每个 subagent 的任务上下文，作为模型必须遵守的行为指令。**当前没有自动拦截层**：不会在 bash/MCP 层 block 越界 HTTP 目标或被禁命令，也不会自动写 `audit.log`。范围边界目前完全靠模型自律 + 操作员复核兜底。统一授权层（覆盖 bash + MCP 全链路的强制拦截）待重建。
- **不伪造完成**：实战下 `challenge_submit_flag` 仅把已验证目标写入本地提交日志（`correct` 恒为 false，标注 pending operator confirmation），并广播给同范围其它 solver 降重；`is_completed` 永远返回 false。
- **完成靠人**：是否收尾、是否转下一目标，由操作员在范围外确认，模型不能自行宣布完成。

## 注意

- scope 文件含真实目标信息，**不要提交进仓库**；示例文件仅为模板。
- 凭证类证据应通过 `evidence_refs` 引用，避免明文堆进共享状态。

## 操作员工作流

1. 写好 scope 文件（参考模板），设置 `TCH_ENGAGEMENT_MODE=1` 与 `TCH_ENGAGEMENT_SCOPE`，启动 `bun run web`。
2. 在 UI 创建一个 target（`POST /api/challenges`，实战模式下不再要求 mock 开关，id 用原始目标标识、不强制 `mock-` 前缀；`entrypoint` 填目标入口）。
3. 对该 target 启动 solver（`POST /api/challenges/:id/solvers`，指定 promptName）。solver 会以授权演练框架运行，scope 范围作为软约束注入上下文；**目前无自动拦截，需你在过程中关注 solver 行为是否越界**。
4. solver 验证到漏洞/控制权后调用 `challenge_submit_flag` 记录发现（写入本地 findings/提交日志，不外联、不判完成）。
5. 你在范围外复核 findings，决定收尾或转下一目标。
