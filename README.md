# HumanAgent

器官式长程 Harness：每轮开始从 checkpoint recall 恢复，每轮结束以 checkpoint completion 收拢；后台器官持续承担恢复责任，前台显意识立即暴露错误。

## 当前状态

`MVP-IMPLEMENTATION`（2026-09-13）。已具备独立的启动/config/session 链和带 checkpoint 的本地编译链；DSH 仍是后续可替换执行后端。

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

## 当前未完成

DSH 源码基线已锁定到上游 `master@c291e7961a515f6d7af9304e7fd1d257929aef26`，并记录了 tree、最近发布标记和 clean checkout 证据。真实 DSH 适配、Cordis bridge、持久化故障恢复、steer 同入口停止和长程 replay 仍待 Milestone 1；当前只完成基线和计划，不声称 adapter 已接入。

## 本地启动与增量编译

```sh
pnpm run build
pnpm run test
pnpm run doctor -- --workspace /absolute/project
pnpm run run -- --workspace /absolute/project --plan default
pnpm run resume -- --workspace /absolute/project --session <session-id>
pnpm run smoke
```

`pnpm build` 使用 `~/.humanagent/build/checkpoints/build/<project-key>/manifest.json` 保存 `typecheck → compile` 的 stage checkpoint；`pnpm run ci` 使用独立的 `.../checkpoints/ci/<project-key>/manifest.json`；`pnpm build:release` 使用独立的 `.../checkpoints/<project-key>/manifest.json` 保存 `typecheck → compile → regression → ci → package → package-smoke`。三条链共享 `~/.humanagent/build/locks/<project-key>/.run.lock`，不会并发改写同一工作树的编译产物。输入、依赖和已声明输出 evidence 未变的 PASS stage 复用；输出被篡改或首个 stage 失败时，从该 stage 及其下游继续。dirty worktree 只允许生成 local candidate，不能通过 release check。
`pnpm package:release` 只消费已经通过 review、且 source/artifact/stage digest 都匹配的 manifest；它不会覆盖 pending review，也不会替代 `build:release` 的候选构建。

日常入口：

```sh
pnpm run doctor -- --workspace /absolute/project
pnpm run run -- --workspace /absolute/project --plan default
pnpm run resume -- --workspace /absolute/project --session <session-id>
pnpm run ci
pnpm run build:release
pnpm run review:record -- --review-id <review-id>
pnpm run release
pnpm run package
```

`ci` 通过 checkpoint runner 在 `~/.humanagent/build/checkpoints/ci/<project-key>/manifest.json` 执行 `typecheck → compile → regression → ci`；已通过且输入/输出 digest 未变的 stage 会复用，失败从首个失效 stage 继续。需要强制全量诊断时才直接运行 `pnpm run ci:check`。

发布使用独立的 release checkpoint：`pnpm run build:release` 生成 candidate 与 `dist/release/release-manifest.json`（`review.status = pending`）；`pnpm run review:record -- --review-id <review-id>` 读取 `.agent-collab/review/<review-id>/` 的独立 review receipt，校验完整 review 输出契约、PASS verdict、base 和 source commit 与当前 candidate 一致、且无 P0/P1 finding 后写入 commit-scoped review 证据；最后 `pnpm run release` 只执行 `release:check`，校验 source commit、stage manifest、release artifact、package artifact 及 commit-scoped review 证据，其中 artifact 完整性由 release gate 独立校验，不由 review receipt 冒充。`review:record` 拒绝覆盖已 passed 的 review，`package` 只消费已通过 `release:check` 的 manifest。

checkpoint 的 `regression` 阶段运行 `test:compiled`，只消费 compile 已生成的测试产物，不在下游重新编译并污染 compile 输出；`pnpm run test` 仍是需要强制重编译的全量诊断入口。
