# HumanAgent

器官式长程 Harness：每轮开始从 checkpoint recall 恢复，每轮结束以 checkpoint completion 收拢；后台器官持续承担恢复责任，前台显意识立即暴露错误。

## 当前状态

`MVP-IMPLEMENTATION`（2026-09-15）。已具备独立的启动/config/session 链、带
checkpoint 的本地编译链、真实单 DSH Agent 和 UI Provider Loop：DSH stdio
session、真实只读工具、RCC 4444 provider、同一 session continuation、
stop/settle、crash recovery、Runtime API、SSE、真实 Projection 和 UI stop
收拢已接通；两个候选已进入 main，production release 尚未完成。

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
`master@0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`，并使用 clean detached
worktree 验证 commit/tree、源码 patch、真实 RCC 和真实 DSH 同入口。单 DSH
Agent candidate `287a2f61cdfac79d321166b201a36b438d9d374b` 已通过独立 review
（PASS，P0/P1 = 0）并入 main。候选绑定的 receipts、gate manifest、HumanAgent
checkpoint、DSH session log 和 UI 截图见
[`docs/evidence/real-single-dsh-agent/`](docs/evidence/real-single-dsh-agent/)，
计划见
[`docs/goals/real-single-dsh-agent-plan.md`](docs/goals/real-single-dsh-agent-plan.md)。

UI Provider Loop 已接入 Runtime API、fake/RCC provider、SSE projection 和标准
stop 收拢；`56840b3d62d1d9db943e4d5376ff3febe99d979c` 已通过独立 review
（PASS，P0/P1 = 0），当前证据和计划见
[`docs/evidence/ui-provider-loop/`](docs/evidence/ui-provider-loop/) 与
[`docs/goals/ui-provider-loop-goal.md`](docs/goals/ui-provider-loop-goal.md)。
两个候选均尚未形成 production release。

## 本地启动与增量编译

当前可执行组装入口是 `packages/app/src/cli.ts`；构建后默认启动入口会从全局
`~/.humanagent/config.toml` 读取 provider，默认使用 RCC。fake 只保留给内部测试，
不属于人类运行模式。

```sh
pnpm run build
pnpm run test
pnpm run doctor -- --workspace /absolute/project
pnpm run run -- --workspace /absolute/project --plan default
pnpm run resume -- --workspace /absolute/project --session <session-id>
node dist/app/app/src/cli.js session list --workspace /absolute/project
node dist/app/app/src/cli.js session inspect --workspace /absolute/project --session <session-id>
node dist/app/app/src/cli.js --workspace /absolute/project
node dist/app/app/src/cli.js serve --workspace /absolute/project --protocol openai
pnpm build:release
pnpm release:check
pnpm run smoke
```

全局安装后不需要从仓库目录启动。任意目录执行：

```sh
humanagent --workspace /absolute/project
```

命令输出的 loopback URL 就是 WebUI 入口；`/` 是状态入口，
`/interaction.html` 是显式对话入口。页面提交首条业务输入后会创建显式 Agent
session，写入 `~/.humanagent/main/sessions/explicit-brain.jsonl`。对项目执行的
session 仍写入 `~/.humanagent/sessions/<project-key>/<session-id>.jsonl`；启动目录
只作为 workspace，不改变这两个持久化位置。

`pnpm build` 使用 `~/.humanagent/build/checkpoints/build/<project-key>/manifest.json` 保存 `typecheck → compile` 的 stage checkpoint；`pnpm run ci` 使用独立的 `.../checkpoints/ci/<project-key>/manifest.json`；`pnpm build:release` 使用独立的 `.../checkpoints/<project-key>/manifest.json` 保存 `typecheck → compile → regression → ci → package → package-smoke`。三条链共享 `~/.humanagent/build/locks/<project-key>/.run.lock`，不会并发改写同一工作树的编译产物。输入、依赖和已声明输出 evidence 未变的 PASS stage 复用；输出被篡改或首个 stage 失败时，从该 stage 及其下游继续。dirty worktree 只允许生成 local candidate，不能通过 release check。

`serve` 启动本地 HumanAgent Runtime API 和打包内置 UI（源码开发时才回退到
`docs/ui`）。默认 provider 来自 `~/.humanagent/config.toml` 的 `[provider]`，
初始配置为 RCC `127.0.0.1:4444`。RCC 通过同一个 Runtime API 连接，失败会显式投影
owner 和 next action，不会回退到 fake。`dsh` 在当前阶段保持关闭。
RCC 是透明代理，本阶段 MVP验收覆盖两个入口协议：
`responses -> /v1/responses` 和 `openai -> /v1/chat/completions`；
`anthropic -> /v1/messages` 保留既有入口能力，但不属于本阶段 UI Provider
Loop 验收范围。`providerId` 和 `--route` 都只是 HumanAgent 本地 binding /
入口标签，不代表 RCC 最终上游 Provider 身份，也不会写入 RCC 请求体作为
route selector；RCC 最终选择的 model 与请求 model 不同不构成 binding
mismatch。
默认端口是 `10086`；可用 `--port` 覆盖。`hm` 是 `humanagent` 的同一全局入口。
内部测试可使用 `serve --provider fake --port 0`，但不应写入普通用户启动脚本。
`serve --host` 只接受 loopback（`127.0.0.1` 或 `::1`）：控制 API 目前没有鉴权，
绑定非 loopback 地址会让任意可达客户端创建任务、发起执行和执行 stop，因此
server 会拒绝启动而不是静默暴露控制面。
`pnpm package:release` 只消费已经通过 review、且 source/artifact/stage digest 都匹配的 manifest；它不会覆盖 pending review，也不会替代 `build:release` 的候选构建。

标准 release 使用 `pnpm build:release`：它要求 clean worktree，自动递增 patch
版本，同步架构版本记录并提交版本变更，然后执行 checkpointed
`typecheck → compile → regression → ci → package → package-smoke`。普通
`pnpm build` 不递增版本；`pnpm build:release:gate` 只运行不 bump 的底层 gate。

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
