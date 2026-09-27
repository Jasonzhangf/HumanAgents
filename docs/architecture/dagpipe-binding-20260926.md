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

## Findings

- All five current graphs have exactly one source and one sink.
- All node owners resolve to files inside the allowed project roots.
- No graph contains orphan nodes after binding validation.
- The owner mapping stays inside existing HumanAgent module ownership:
  `packages/config`, `packages/app`, `packages/runtime`, `packages/ui`.
- `pnpm dagpipe:validate` now fails if a binding file is missing, mismatched,
  or points at a non-existent owner.

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

- `pnpm dagpipe:validate` prints `validated 5 DAGpipe graph(s)`.
- `pnpm dagpipe:bind` prints five `bound <graph>: <n> nodes ok` lines.
- `node --test tests/release/dagpipe-binding.test.mjs` prints all binding
  fail-closed fixtures passing.
- `pnpm dagpipe:gate` runs `dagpipe:validate` followed by `test:release` and
  is wired into the checkpointed `ci` release stage.
- `pnpm typecheck` exits `0`.
