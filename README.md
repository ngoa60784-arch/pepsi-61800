# BreachWeave

BreachWeave 面向智能渗透测试场景的多 Agent 协作架构。

## 第一次启动

```bash
bun run install && bun run web
```

## 竞赛成绩

| 起始日期   | 结束日期   | 竞赛                                                                                                            | 赛段     | 获奖情况 | 排名    |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------- | -------- | -------- | ------- |
| 2026-04-13 | 2026-04-17 | [腾讯云黑客松智能渗透测试挑战赛（第二期）](https://zc.tencent.com/competition/competitionHackathon?code=cha004) | 线上初赛 | N/A      | 1 / 613 |
| 2026-04-25 | 2026-04-25 | [腾讯云黑客松智能渗透测试挑战赛（第二期）](https://zc.tencent.com/competition/competitionHackathon?code=cha004) | 线下决赛 | 一等奖   | 1 / 613 |

<a href="https://zc.tencent.com/competition/competitionHackathon?code=cha004">
    <img width="1604" height="460" alt="dc25eea9efae81999d4660a747aa0b9c" src="https://github.com/user-attachments/assets/2cda17c3-e668-4459-abc0-e46a745860be" />
</a>

![](./docs/design.png)


https://github.com/user-attachments/assets/b051927e-b64f-4bdf-833d-d542e328ad20



## 架构核心

项目整体采用 `Manager / Solver / Observer` 的多角色架构。

### Manager

`Manager` 负责全局编排。

它的职责不是亲自执行利用链，而是站在 challenge 视角做统一调度：

- 管理题目推进节奏
- 分配和回收 Solver
- 汇总运行状态
- 组织多 Agent 协作

可以把它理解成整套系统的控制平面。

### Solver

`Solver` 是真正执行任务的主体。

它面向具体攻击路线推进实际动作，例如：

- 信息收集
- 漏洞验证
- 利用链推进
- 结果提交

一个题目可以同时存在多个 Solver，并行探索不同方向。

### Observer

`Observer` 不直接代替 Solver 解题，而是作为旁路监督角色持续观察任务执行过程。

它重点解决的是复杂任务里最容易出现的几个问题：

- 执行路径逐渐偏移
- 状态不断累积后变得混杂
- 模型在阶段性停顿时过早结束任务
- 上下文越来越重，影响后续推进

Observer 的作用，是让系统具备持续监督、轻量纠偏和状态维护能力。

## 系统能力概览

围绕上面的架构，项目重点构建了几类能力：

### 1. 多 Agent 协作

系统支持多个 Solver 并发探索不同方向，由 Manager 在全局视角统一调度，避免重复试错，并让有效结果能够继续沉淀和复用。

### 2. 运行态监督

Observer 持续检查最近几轮执行轨迹和反馈，不替代 Solver 做决定，而是在发现明显低效或偏移时进行轻量纠偏。

### 3. 状态分层维护

系统把“方向”和“事实”拆开维护：

- `Idea` 关注当前值得继续推进的方向
- `Memory` 保留可复用的事实、证据与约束

这样可以避免状态混在一起，导致后续决策越来越模糊。

### 4. 结束条件外置

任务是否结束，不完全交给模型主观判断，而是由系统结合任务状态统一约束，避免复杂任务在中途被过早结束。

### 5. 上下文压缩与降噪

系统不会把原始工具输出和历史会话无限堆进上下文，而是通过改写、压缩、摘要等方式，尽量让后续决策始终建立在高信号、低噪音的信息之上。
