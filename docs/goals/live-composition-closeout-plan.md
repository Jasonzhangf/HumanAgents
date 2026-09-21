# Live Composition Closeout Plan

状态：`IN_PROGRESS`

基线：`df70180808a3833bd74de0b9e4a9894870913131`（`origin/main`）

## 目标

把已经存在并通过模块测试的 Harness 能力接入同一个 live `serve` 入口，形成可观察、可恢复、可验证的主链：

```text
confirmed requirement
  → admission
  → orchestration runtime
  → execution/review/merge feedback
  → EventBus / Journal
  → memory boundary analysis
  → typed UI projection
```

本计划不把单元测试、孤立 Assembly 或静态 UI 误记为 live 完成。

## 当前基线纠偏

旧的 `feature-flow-dag-audit.md` 绑定较早的源码 SHA，不能直接作为当前结论。

当前代码检查已确认：

- `serve` 已调用 `runSupervisorStartup`，并获取和释放 daemon lease；该项从“未接入”改为“已接入，待 live 回放验证”。
- `serve` 已在 checkpoint boundary 调用 memory boundary publisher，并消费 memory handler；该项从“完全未接入”改为“直接消费路径已接入，EventBus 驱动路径仍待闭合”。
- UI Runtime 的 `eventBus` capability 仍明确为 `unavailable`。
- fake `serve` 已具备独立 execution/review/merge ports 和 task-scoped M3 assembly 工厂；当前 confirmed-requirement dispatch 仍走单 Provider 路径，RCC `serve` 也保留单 Provider 路径。
- 旧的 UI runtime journal、Attention port、memory scope 和 live orchestration projection 需要以当前代码为准重新核对。

## 阶段与完成条件

### G0：当前基线审计

范围：更新 live composition audit，记录当前 SHA、入口调用边、能力 projection 和已有测试证据。

当前进度：候选审计已刷新；最终 SHA/tree 绑定待 review 后回填。

完成条件：

- 审计绑定当前候选 commit，而非旧 SHA。
- 每项能力分为 `LIVE`、`PARTIAL`、`UNWIRED`、`MISSING` 或 `UNKNOWN`。
- 明确区分源码实现、模块测试、live serve 和真实入口回放。
- 不修改已有用户 dirty 文件。

验证：静态调用图检查、现有 app/runtime focused tests。

### G1：EventBus live composition

范围：由 app 组装权威事件 Journal、publisher/consumer registry、external operation owner；闭合 memory boundary 和 fake M3 feedback 的 live 使用。UI task-coordinator 在未真正消费这些 ports 前保持 unavailable。

完成条件：

- memory boundary 与 fake M3 feedback 使用 typed EventBus ports；UI task-coordinator 的 unavailable 状态必须与真实调用边一致。
- control/data/observation event 仍通过 typed EventBus contract 传递。
- publisher、consumer、scope、receipt、retry 和 epoch 规则沿用现有 runtime owner。
- 事件持久化位置仍位于 `~/.humanagent`。
- restart/replay 有 focused integration evidence。

非目标：不删除仍有独立语义的 legacy internal tool route。

### G2：M3 orchestration live entry

范围：先完成 fake `serve` 的 M3 composition 和真实 manager dispatch replay；下一步再把 confirmed-requirement dispatch owner 接到该 assembly，建立独立 worker、review、merge typed ports，为 RCC provider-backed ports保留明确边界。

完成条件：

- confirmed requirement 只能经 implicit admission 进入 orchestration。
- orchestration agent 只负责观察、计划、调度、验收和推进，不直接执行 worker operation。
- execution agent、review agent、merge coordinator 都有独立 owner 和权限边界。
- 每个 stage 的 success/waiting/blocked/failed/cancelled 都有 checkpoint、owner 和 next action。
- worker feedback 能返回 orchestration，并能发布到 EventBus/UI projection。
- M3 composition test 可以完成一条 task binding → plan → dispatch → result → review → feedback → merge 回放；confirmed requirement → orchestration 的 live edge 尚未完成，不用 capability/status 字段冒充完成。

非目标：本阶段不实现动态 Cordis、RALPH 或长期 schedule。

### G3：Memory / lease / projection 收口

范围：验证并修正 memory boundary、supervisor lease、Attention durability、project/global scope 和 orchestration projection 的 live 边界。

完成条件：

- supervisor startup、lease fence、shutdown release 和 restart recovery 有真实 serve 证据。
- memory analysis event 的直接路径与 EventBus 路径边界明确，不能双重消费。
- live task agent 使用 canonical project/global memory binding；旧 task scope 只保留明确兼容边界。
- Attention 不因 UI 进程重启丢失控制事实。
- Task Dashboard / Observation 获取真实 orchestration projection，不使用静态 fixture 冒充。

### G4：入口验证与文档收口

完成条件：

- `serve --mode fake` 真实回放通过。
- RCC 入口至少完成 provider readiness 和不影响既有单 Agent 回放的回归。
- 相关 typecheck、focused tests、compiled regression 通过。
- 普通独立 review 绑定候选 SHA 并通过；阻塞 finding 修复后重跑受影响 gate。
- README、AGENTS、目标文档和 audit 的状态一致。
- 未完成的 DSH UI、真实 RAG、long-horizon schedule 和完整 ACP live path 仍明确标为未完成或未验证。

## 所有权和边界

| 能力 | 唯一 owner | 允许修改范围 |
|---|---|---|
| live serve 组装 | `packages/app/src/cli.ts`、`packages/app/src/ui-runtime/*` | app 入口和 runtime composition |
| EventBus | `packages/runtime/src/events`、app event ports | EventBus contract/adapter wiring |
| orchestration | `packages/runtime/src/orchestration`、`packages/app/src/m3-assembly.ts` | 编排和组装边界 |
| memory | `packages/app/src/memory-*`、`packages/runtime/src/memory` | memory boundary 和 scope |
| UI projection | `packages/runtime/src/ui-runtime`、`packages/ui` | typed projection，不读 raw journal |
| 审计文档 | `docs/architecture`、`docs/goals` | 当前 SHA 的事实和计划 |

禁止：修改 DSH 源码、把 DSH 类型提升为领域类型、在 dirty main 开发、清理他人 worktree、用测试 fixture 伪造 live 入口完成。

## 证据顺序

```text
focused typecheck/tests
  → live fake serve replay
  → restart/recovery replay
  → RCC non-regression
  → independent review
  → candidate merge
```

任何一层缺证据，只报告到该层，不升级为整体完成。
