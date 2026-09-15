# HumanAgent

器官式长程 Harness：每轮开始从 checkpoint recall 恢复，每轮结束以 checkpoint completion 收拢；后台器官持续承担恢复责任，前台显意识立即暴露错误。

## 当前状态

`MVP-IMPLEMENTATION`（2026-09-14）。已具备独立的启动/config/session 链、带
checkpoint 的本地编译链，以及真实单 DSH Agent candidate：DSH stdio session、
真实只读工具、RCC 4444 provider、同一 session continuation、stop/settle、
crash recovery 和 UI projection 已接通；candidate 尚未 merge 或 release。

## 核心决定

高层拥有自己的领域模型和 Organ Journal。HumanAgent 以 Cordis Host 组装固定 Harness Kernel 和可替换模块；Agent 通过统一的 Template + Driver + Runtime 抽象执行。DSH 只是一个可替换的 Agent/Execution provider，通过 `ExecutionRuntimePort` 接入，负责具体模型/工具执行和 DSH 原生 session 证据，但不拥有 HumanAgent 的任务状态、checkpoint 或恢复语义。

Memory 由用户可交互的 Memory Interaction Surface、后台 Memory Operations Backend 和受 Harness 控制的 Agent Context Injection 接口组成。Index 是可重建的查询投影，不是状态真源；基础检索、比较和按来源 inspect 不要求 AI 对话。

UI 采用同一边界：HumanAgent 自己拥有 Organ Console、状态投影和控制操作；DSH WebUI 不作为整套产品壳复用，只在版本和 license 证据通过后选择性复用纯视觉 primitives。

阅读顺序：

1. [初始报告](docs/initial-report.md)
2. [MVP → Milestone 1/2/3 计划](docs/goals/mvp-to-milestones.md)
3. [器官运行时架构](docs/architecture/organ-runtime.md)
4. [Agent 流程](docs/architecture/agent-flows.md)
5. [Agent 模板系统](docs/architecture/agent-templates.md)
6. [宿主、启动和 Cordis 插件化](docs/architecture/host-and-cordis.md)
7. [Memory System](docs/architecture/memory-system.md)
8. [生命周期与故障归属](docs/architecture/lifecycle-and-failure-ownership.md)
9. [DSH 基线与 Milestone 1 适配准备](docs/architecture/dsh-baseline.md)
10. [项目规则](AGENTS.md)

## 当前收口

DSH 源码基线锁定到上游
`master@c291e7961a515f6d7af9304e7fd1d257929aef26`，并使用 clean detached
worktree 验证 commit/tree、源码 patch、真实 RCC 和真实 DSH 同入口。当前分支已
完成 P0-P6，最终候选 review `PASS`（P0/P1 = 0）；候选绑定的 receipts、gate manifest、HumanAgent checkpoint、DSH
session log 和 UI 截图见
[`docs/evidence/real-single-dsh-agent/`](docs/evidence/real-single-dsh-agent/)，
计划见
[`docs/goals/real-single-dsh-agent-plan.md`](docs/goals/real-single-dsh-agent-plan.md)。
该 candidate 尚未 merge、push 或 production release。

## 本地启动与增量编译

```sh
pnpm build
pnpm test
node dist/app/app/src/cli.js doctor --workspace /absolute/project
node dist/app/app/src/cli.js run --workspace /absolute/project --plan default
node dist/app/app/src/cli.js resume --workspace /absolute/project --session <session-id>
node dist/app/app/src/cli.js session list --workspace /absolute/project
node dist/app/app/src/cli.js session inspect --workspace /absolute/project --session <session-id>
pnpm build:release
pnpm release:check
pnpm smoke
```

`pnpm build:release` 使用 `~/.humanagent/build/checkpoints/<project-key>/manifest.json` 保存 `typecheck → compile → regression → ci → package → package-smoke` 的 stage checkpoint。输入、依赖和已声明输出 evidence 未变的 PASS stage 复用；输出被篡改或首个 stage 失败时，从该 stage 及其下游继续。dirty worktree 只允许生成 local candidate，不能通过 release check。
`pnpm package:release` 只消费已经通过 review、且 source/artifact/stage digest 都匹配的 manifest；它不会覆盖 pending review，也不会替代 `build:release` 的候选构建。
