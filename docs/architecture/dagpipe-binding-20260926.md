# DAGpipe Binding

Status: candidate for `humanagent.dagpipe.binding`
Base: `7f00515cb288dccd70b3606b457052e4782a4130`

## Purpose

This change makes DAGpipe SESE audit enforceable. Every
`docs/dagpipe/*.graph.json` must now have a sibling
`docs/dagpipe/*.graph.binding.json` that binds every node to a real owner path,
declares the graph-level operator, and preserves single source/sink
reachability. `pnpm dagpipe:validate` runs DAGpipe's own graph validator plus
this binding validator; `pnpm dagpipe:bind` runs the binding-only check.

## Binding contract

- Binding file name: replace `.graph.json` with `.graph.binding.json`.
- `binding.graph` must equal the graph `id`.
- `binding.operator` must be a `humanagent-*` operator with semver major `1`.
- Each node must have `ownerPath` and `ownerRel`.
- `ownerRel` must start with `packages/`, `docs/`, `scripts/`, or `tests/`.
- `ownerRel` must not contain `..`.
- `ownerPath` must exist in the repository.
- Every graph must have exactly one source and exactly one sink.
- Every node must be reachable from the single source.
- The single sink must be reachable from the single source.

The validator fails closed with exact errors, including:

- `missing binding file for <graph>: expected <binding>`
- `expected single source, got <n>`
- `expected single sink, got <n>`
- `node <id> is unreachable from source`
- `sink <id> cannot be reached`
- `operator <op> must start with humanagent-`

## Graph bindings

### humanagent-explicit-requirement

Source: `sensory_inbox`
Sink: `task_output`

| Node | ownerPath / ownerRel | Semantic label |
| --- | --- | --- |
| `sensory_inbox` | `packages/app/src/ui-runtime/service.ts` | 接收用户任务 |
| `explicit_normalize` | `packages/runtime/src/intake/explicit-intake.ts` | 显式整理需求 |
| `explicit_confirm` | `packages/runtime/src/intake/explicit-intake.ts` | 用户确认需求 |
| `implicit_classify` | `packages/runtime/src/admission/implicit-admission.ts` | 隐式分类需求 |
| `interactive_queue` | `packages/runtime/src/intake/requirement-inbox.ts` | 写入交互队列 |
| `execution_queue` | `packages/runtime/src/intake/requirement-inbox.ts` | 写入执行队列 |
| `research_queue` | `packages/runtime/src/intake/requirement-inbox.ts` | 写入研究队列 |
| `maintenance_queue` | `packages/runtime/src/intake/requirement-inbox.ts` | 写入维护队列 |
| `task_correlate_or_create` | `packages/runtime/src/ui-runtime/coordinator.ts` | 关联或创建任务 |
| `resource_admission` | `packages/runtime/src/admission/implicit-admission.ts` | 执行资源准入 |
| `pipeline_execute` | `packages/runtime/src/ui-runtime/coordinator.ts` | 执行流水线任务 |
| `settle` | `packages/runtime/src/checkpoints/submission.ts` | 收拢任务检查点 |
| `task_output` | `packages/ui/projection/runtime.ts` | 生成任务输出 |

### humanagent-headless-session

Source: `resolve_config`
Sink: `close_session`

| Node | ownerPath / ownerRel | Semantic label |
| --- | --- | --- |
| `resolve_config` | `packages/config/src/index.ts` | 解析运行配置 |
| `acquire_session_lock` | `packages/app/src/session-store.ts` | 获取会话锁 |
| `recover_or_create_operation` | `packages/app/src/run-operation.ts` | 恢复或创建操作 |
| `execute_agent` | `packages/app/src/agent-execution.ts` | 执行 Agent |
| `observe_events` | `packages/app/src/agent-execution.ts` | 观测执行事件 |
| `commit_checkpoint` | `packages/app/src/checkpoint-journal.ts` | 提交检查点 |
| `close_session` | `packages/app/src/session-store.ts` | 关闭会话 |

### humanagent-serve-task

Source: `fifo_peek`
Sink: `task_terminal`

| Node | ownerPath / ownerRel | Semantic label |
| --- | --- | --- |
| `fifo_peek` | `packages/app/src/ui-runtime/service.ts` | 读取 FIFO 队首 |
| `admission_check` | `packages/runtime/src/admission/implicit-admission.ts` | 执行资源准入 |
| `correlate_task` | `packages/runtime/src/ui-runtime/coordinator.ts` | 关联或创建运行时任务 |
| `provider_execution` | `packages/app/src/ui-runtime/service.ts` | 执行 Provider 任务 |
| `checkpoint_commit` | `packages/runtime/src/checkpoints/submission.ts` | 提交检查点 |
| `task_terminal` | `packages/ui/projection/runtime.ts` | 生成任务完成投影 |

### humanagent-memory-curation

Source: `wake_memory_agent`
Sink: `write_memory_event`

| Node | ownerPath / ownerRel | Semantic label |
| --- | --- | --- |
| `wake_memory_agent` | `packages/runtime/src/memory/events.ts` | 唤醒记忆 Agent |
| `read_task_evidence` | `packages/app/src/memory-composition.ts` | 读取任务证据 |
| `compose_memory_request` | `packages/runtime/src/memory/agent.ts` | 组装记忆请求 |
| `run_memory_agent` | `packages/runtime/src/memory/agent.ts` | 运行记忆 Agent |
| `curate_lesson` | `packages/runtime/src/memory/agent.ts` | 整理经验候选 |
| `write_memory_event` | `packages/runtime/src/memory/events.ts` | 写入持久经验 |

### humanagent-observation-read

Source: `http_api`
Sink: `browser_view`

| Node | ownerPath / ownerRel | Semantic label |
| --- | --- | --- |
| `http_api` | `packages/app/src/ui-runtime/server.ts` | 处理浏览器 HTTP 请求 |
| `task_dashboard` | `packages/ui/projection/runtime.ts` | 生成任务仪表盘投影 |
| `observation_projection` | `packages/ui/projection/runtime.ts` | 生成流水线观测投影 |
| `browser_view` | `packages/ui/surfaces/dsh-dashboard-replay.html` | 渲染浏览器只读视图 |

### humanagent-acp-runtime-wiring

Source: `resolve_agent_config`
Sink: `write_run_manifest`

| Node | ownerPath / ownerRel | Semantic label |
| --- | --- | --- |
| `resolve_agent_config` | `packages/config/src/index.ts` | 解析 agent 与 ACP 执行配置 |
| `compose_acp_driver` | `packages/app/src/agent-driver-composition.ts` | 按 driverRef 组合 ACP 驱动与 runtime adaptor |
| `open_acp_session` | `packages/adapters/acp/acp-client-driver.ts` | 打开 ACP 会话并绑定 HumanAgent scope |
| `run_opencode_adaptor` | `packages/adapters/acp/opencode.ts` | 经 opencode 真实 ACP v1 服务执行一轮 |
| `run_antigravity_shim` | `packages/adapters/acp/antigravity.ts` | 经 antigravity 一次性 CLI shim 执行一轮 |
| `run_dsh_shim` | `packages/adapters/acp/dsh.ts` | 经 dsh headless 一次性 shim 执行一轮 |
| `observe_driver_events` | `packages/app/src/agent-execution.ts` | 按 terminal 事件收束驱动事件流 |
| `settle_acp_session` | `packages/app/src/agent-operation.ts` | 收拢执行闭包并关闭 ACP 会话 |
| `commit_acp_checkpoint` | `packages/runtime/src/checkpoints/submission.ts` | 在应用 scope 下提交 checkpoint |
| `write_run_manifest` | `packages/app/src/run-manifest.ts` | 写入可读 run manifest |

## Findings

- All eleven current graphs have exactly one source and one sink.
- All node owners resolve to files inside the allowed project roots.
- No graph contains orphan nodes after binding validation.
- The owner mapping stays inside existing HumanAgent module ownership:
  `packages/config`, `packages/app`, `packages/runtime`, `packages/ui`.
- `pnpm dagpipe:validate` now fails if a binding file is missing, mismatched,
  or points at a non-existent owner.

## 2026-10-03 interaction redesign candidate

Interaction redesign design candidate revises `explicit-requirement`,
`serve-task`, and `observation-read` graph files plus their semantic and
binding siblings, and adds `subscription-control` and
`scheduled-occurrence`. Candidate details are in
`docs/ui/interaction-redesign-plan-2026-10-03.md`; this section records that
the binding gate remains the same and currently validates every
`docs/dagpipe/*.graph.json`. The graphs remain design candidates and do not
claim scheduler capability.

The redesign also corrects owner bindings that were previously too broad:

- `humanagent-explicit-requirement`: `validate_draft_revision` binds to
  `packages/core/src/index.ts`, with the W1b invariant implemented in the new
  `packages/core/src/draft-revision.ts` and exported from the bound public
  index; `persist_authorized_plan` binds to
  `packages/adapters/jsonl/src/index.ts`.
- `humanagent-subscription-control`: a separate SESE graph for public
  `SubscriptionControlRequest` -> runtime orchestration -> JSONL transaction
  critical section -> core domain decision -> JSONL atomic commit -> durable
  control receipt. New `subscriptions/` and `subscription.ts` code does not
  exist yet, so binding uses existing owner paths as a design binding and
  records `plannedOwnerPath` / `pending`; it does not claim a running
  capability.
- `humanagent-scheduled-occurrence`: atomic claim and settle bind to
  `packages/adapters/jsonl/src/index.ts`; `validate_occurrence_domain` binds to
  `packages/core/src/index.ts`; `read_committed_subscription_state` reads the
  committed subscription state and `claim_due_occurrence` rechecks
  state/revision in the same JSONL transaction. The due path no longer applies
  subscription control. `execute_occurrence_task` invokes the public
  `humanagent-serve-task@2` subflow and returns only its verified
  `ServeTaskTerminalReceipt`; `settle_occurrence` consumes that receipt and
  cannot project checker failed/missing/rejected, identity mismatch, stale
  epoch, or pending verification as occurrence success. This is a typed
  public input/output call between two independent SESE graphs, not a
  cross-graph node edge, back-edge, scheduler verifier, or second lifecycle
  truth. Both subscription graphs share the JSONL transaction resource and
  typed control receipt data edge, with no cross-graph edge, cycle, or second
  control truth.
- `humanagent-serve-task`: `validate_plan_lifecycle` binds to
  `packages/core/src/index.ts`; `verify_task_result` binds to
  `packages/runtime/src/ui-runtime/coordinator.ts`, with W3 extracting the
  concrete bridge as `packages/runtime/src/ui-runtime/task-verification.ts`;
  `checkpoint_commit` binds to `packages/adapters/jsonl/src/index.ts`.
- `humanagent-observation-read`: `browser_view` binds to the actually served
  `docs/ui/observation.js`, not the unused
  `packages/ui/surfaces/dsh-dashboard-replay.html`.

Shared contracts remain the first implementation dependency: W1 is
contracts-only and exports `TaskVerificationResult` /
`ServeTaskTerminalReceipt`, W1b implements draft-domain/intake after W1, W2
receives the core export handoff only after W1b, and W3/W4 receive `server.ts`
/ `runtime-api.js` only after the network worker hands them off. W2 may land
the domain/Journal/claim skeleton first, but final `due -> execute -> settle`
acceptance depends on the W3 task-verification bridge; no scheduler
independent execution path is allowed. The W3 task-verification node consumes
task/operation/executionEpoch and the immutable input artifact digest;
`OperationVerifierDecision` remains operation-scoped and is not claimed as a
task-verification contract.
W3 owns `packages/runtime/src/gateway/ports.ts`; after landing the concrete
`task-verification.ts` bridge it also synchronizes
`serve-task.graph.binding.json`. W2 synchronizes the scheduled-occurrence
binding to its real owner; W3 synchronizes the subscription-control binding
after the W2 handoff. The two subscription bindings have one writer at a time.
Scheduling, serve, projection, and acceptance workers must not create a second
lifecycle or persistence truth outside these bindings.

## SESE statement

Each graph is a single-source single-exit DAG with a real owner path on every
node. The binding gate is deterministic and fail-closed, so a future graph
edit cannot silently introduce a second source, second sink, disconnected
node, unreachable sink, or unmapped node without the release gate failing.

## Gate commands

```sh
pnpm dagpipe:validate
pnpm dagpipe:bind
node --test tests/release/dagpipe-binding.test.mjs
pnpm typecheck
pnpm dagpipe:gate
```

Expected results:

- `pnpm dagpipe:validate` prints `validated <n> DAGpipe graph(s)` where `<n>` is
  the directory graph count.
- `pnpm dagpipe:bind` prints one `bound <graph>: <n> nodes ok` line per graph.
- `node --test tests/release/dagpipe-binding.test.mjs` prints all binding
  fail-closed fixtures passing.
- `pnpm dagpipe:gate` runs `dagpipe:validate` followed by `test:release` and
  is wired into the checkpointed `ci` release stage.
- `pnpm typecheck` exits `0`.
