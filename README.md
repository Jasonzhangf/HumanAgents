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
pnpm build
pnpm test
node dist/app/app/src/cli.js doctor --workspace /absolute/project
node dist/app/app/src/cli.js run --workspace /absolute/project --plan default
node dist/app/app/src/cli.js resume --workspace /absolute/project --session <session-id>
node dist/app/app/src/cli.js session list --workspace /absolute/project
node dist/app/app/src/cli.js session inspect --workspace /absolute/project --session <session-id>
node dist/app/app/src/cli.js serve --mode fake --workspace /absolute/project
node dist/app/app/src/cli.js serve --mode rcc --workspace /absolute/project \
  --binding rcc-entry --provider rcc --protocol responses \
  --model MiniMax-M3 --route default \
  --rcc-base-url http://127.0.0.1:4444
node dist/app/app/src/cli.js serve --mode rcc --workspace /absolute/project \
  --binding rcc-openai-entry --provider rcc --protocol openai \
  --model MiniMax-M3 --route default \
  --rcc-base-url http://127.0.0.1:4444
pnpm build:release
pnpm release:check
pnpm smoke
```

`serve` 启动本地 HumanAgent Runtime API 和 `docs/ui`。`fake` 只使用固定 replay；
`rcc` 通过同一个 Runtime API 连接 RCC v3 `127.0.0.1:4444`，失败会显式投影
owner 和 next action，不会回退到 fake。`dsh` 在当前阶段保持关闭。
RCC 是透明代理，本阶段 MVP验收覆盖两个入口协议：
`responses -> /v1/responses` 和 `openai -> /v1/chat/completions`；
`anthropic -> /v1/messages` 保留既有入口能力，但不属于本阶段 UI Provider
Loop 验收范围。`providerId` 只是本地 binding 标签，不代表上游 Provider
身份；RCC 最终选择的 model 与请求 model 不同不构成 binding mismatch。
`serve --host` 只接受 loopback（`127.0.0.1` 或 `::1`）：控制 API 目前没有鉴权，
绑定非 loopback 地址会让任意可达客户端创建任务、发起执行和执行 stop，因此
server 会拒绝启动而不是静默暴露控制面。

`pnpm build:release` 使用 `~/.humanagent/build/checkpoints/<project-key>/manifest.json` 保存 `typecheck → compile → regression → ci → package → package-smoke` 的 stage checkpoint。输入、依赖和已声明输出 evidence 未变的 PASS stage 复用；输出被篡改或首个 stage 失败时，从该 stage 及其下游继续。dirty worktree 只允许生成 local candidate，不能通过 release check。
`pnpm package:release` 只消费已经通过 review、且 source/artifact/stage digest 都匹配的 manifest；它不会覆盖 pending review，也不会替代 `build:release` 的候选构建。
