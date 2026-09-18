# HumanAgent Architecture DAG Audit

状态：`CANDIDATE / PENDING REVIEW`
日期：2026-09-18
审计对象：`3454a23f8854b7c0f79f32d083bcae471ecea42d`
审计树：`988cd08106cb6431b4bf2b389fd1a562d67e7e9a`
基线：`5fb25ee0955a65ba77f90a6642921a5cf85524d5`

## 0. Scope and Method

This document audits the **current project architecture DAG**. It does not
audit the development lifecycle, review workflow, merge order, or release
process. `Requirement`, `Design`, `Implementation`, `Verification`, and
`Delivery` are therefore not treated as mandatory phases. Implementation and
verification appear only as bindings on architecture nodes.

The As-Is graph is reconstructed from the current repository, not from a
normal-project template. A node exists only when an implementation, contract,
test, or runtime composition can be identified. A node is `MISSING` or
`UNKNOWN` only when the architecture has a real required surface but no
implementation or evidence was found.

Status vocabulary:

- `LIVE`: reachable from a current product entrypoint with a real
  implementation and verification binding.
- `PARTIAL`: present and used, but an ownership, persistence, scope, or
  fencing contract is incomplete.
- `UNWIRED`: implemented or tested in isolation, but not connected to the
  live product composition.
- `MISSING`: required architecture surface has no implementation.
- `UNKNOWN`: repository evidence is insufficient to decide.

Evidence layers remain separate:

- code and configuration bindings in `packages/`;
- focused tests in `tests/`;
- product entrypoints in `packages/app/src/cli.ts`;
- design contracts in `docs/architecture/`;
- Git identity of the audited candidate.

A passing unit test proves only the test binding. It does not prove that the
node is reachable from `run`, `resume`, or `serve`.

## 1. As-Is Architecture DAG

### 1.1 Entry and composition branches

```text
                    +----------------------+
                    | CLI: run / resume    |
                    +----------+-----------+
                               |
                    openRuntime / resumeRuntime
                               |
                  SessionStore + execution lock
                               |
                 runAgentOperation / resume
                               |
                    composeAgentDriver
                     /                 \
                fake driver         DSH driver
                     \                 /
                  AgentRuntime / AgentExecution
                               |
                JSONL checkpoint + Attention journal


                    +----------------------+
                    | CLI: serve           |
                    +----------+-----------+
                               |
                  config + rooted paths
                               |
                  composeRuntimeMemory
                               |
                +--------------+--------------+
                |                             |
        fake execution port             RCC provider port
                |                             |
                +--------------+--------------+
                               |
                        startUiRuntime
                               |
        explicit Brain -> FIFO inbox -> dispatch
                               |
                    RuntimeTaskCoordinator
                               |
           memory-bound provider driver
                               |
              UI projection + HTTP/SSE API
```

The two branches are real top-level architecture branches. `run/resume` is
the only live DSH path. `serve` rejects DSH and allows only `fake` or `rcc`.
See `packages/app/src/cli.ts:62-161`, `packages/app/src/cli.ts:181-224`, and
`packages/app/src/agent-driver-composition.ts:289-340`.

### 1.2 Shared domain and persistence nodes

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `A-CONFIG-1` | Configuration | Resolve workspace, project key, control root, Journal, checkpoint, artifact, memory, and lock paths. | CLI `--workspace`, `--control-root`, workspace cwd | `RuntimePaths` and loaded config | CLI entry | `packages/config/src/index.ts:73-100`, `555-639` | config tests and app path tests | `tests/config/config.test.ts`, `tests/app/app.test.ts` | `LIVE` |
| `A-IDENTITY-1` | Domain identity | Bind Organ, Task, Cycle, Operation, checkpoint, and execution epoch identities independently of provider sessions. | CLI/UI request | Typed scoped identities | `A-CONFIG-1` | `packages/contracts/src/index.ts`, `packages/app/src/agent-operation.ts` | operation identity tests and CLI tests | `tests/app/app.test.ts:188-267`, `1015-1170` | `LIVE` |
| `A-JOURNAL-1` | Authoritative history | Append and validate the Organ Journal/checkpoint chain. | Checkpoint and control facts | Durable JSONL records and receipts | `A-CONFIG-1`, `A-IDENTITY-1` | `packages/adapters/jsonl`, `packages/app/src/checkpoint-journal.ts`, `packages/app/src/attention-journal.ts` | Journal, checkpoint, and app tests | `tests/adapters/jsonl`, `tests/app/app.test.ts:1015-1170` | `LIVE` |
| `A-CHECKPOINT-1` | Control closure | Commit succeeded, failed, stopped, blocked, or unknown recovery state. | Runtime execution result and evidence refs | Durable checkpoint and next action | `A-JOURNAL-1` | `packages/runtime/src/checkpoints`, `packages/runtime/src/control`, `packages/app/src/run-operation.ts` | checkpoint, control, and stop/settle tests | `tests/runtime/checkpoints`, `tests/runtime/control`, `tests/app/app.test.ts:1259-1456` | `LIVE` |
| `A-ATTENTION-1` | Control delivery | Publish and resolve material foreground attention through a durable control port. | Checkpoint/runtime failure or resolution | Attention receipt | `A-JOURNAL-1`, `A-CHECKPOINT-1` | `packages/app/src/attention-journal.ts:16-52`, headless `packages/app/src/agent-operation.ts:237` | attention/control tests and DSH lifecycle proofs | `tests/runtime/control`, `proof:dsh-lifecycle` | `LIVE` |
| `A-ATTENTION-2` | Control delivery in UI runtime | Deliver UI-runtime attention while the server process is alive. | UI runtime failure/attention | In-memory attention audit | `A-CHECKPOINT-1` | `packages/app/src/ui-runtime/index.ts:103-116`, `127-141` | UI runtime control tests | `tests/app/ui-runtime.test.ts` | `PARTIAL` |

`A-ATTENTION-2` is separate because the live `serve` composition constructs
`InMemoryAttentionPort`; the durable JSONL attention port is used by the
headless path, not by `serve`. This is a real architecture difference, not a
naming difference.

### 1.3 Headless execution DAG

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `H-ENTRY-1` | Entry | Start or resume a named session from the CLI. | plan, prompt, session id, workspace | Runtime handle and session lifecycle records | `A-CONFIG-1`, `A-IDENTITY-1` | `packages/app/src/cli.ts:62-161`, `packages/app/src/index.ts:30-68` | app CLI/session tests | `tests/app/app.test.ts:1354-1456`, `1475-1697` | `LIVE` |
| `H-OPERATION-1` | Execution orchestration | Assemble prompt, recover checkpoint, create operation identity, run one agent operation, and commit outcome. | Runtime handle, prompt, checkpoint | Task/operation/epoch/checkpoint result | `H-ENTRY-1`, `A-CHECKPOINT-1` | `packages/app/src/agent-operation.ts:162-238`, `packages/app/src/run-operation.ts:26-121` | operation, checkpoint, recovery, and manifest tests | `tests/app/app.test.ts:1015-1456` | `LIVE` |
| `H-AGENT-1` | Agent runtime | Execute a provider-neutral agent lifecycle with observe, stop, settle, and evidence. | Driver and execution request | Agent events, closure, evidence refs | `H-OPERATION-1` | `packages/runtime/src/nodes/agent-runtime.ts`, `packages/app/src/agent-execution.ts` | Agent runtime, Agent I/O, and lifecycle tests | `tests/runtime/nodes/agent-runtime.test.ts`, `tests/runtime/agent-io` | `LIVE` |
| `H-FAKE-1` | Execution adapter | Provide deterministic replay execution for tests and headless fake mode. | Provider-neutral request | Normalized agent events | `H-AGENT-1` | `packages/app/src/agent-driver-composition.ts:289-292` | app driver tests | `tests/app/app.test.ts:866-901` | `LIVE` |
| `H-DSH-1` | Execution adapter | Run a real DSH session through a locked source/profile and map it to the HumanAgent driver. | Agent config, DSH lock/profile, workspace | DSH session evidence and agent events | `H-AGENT-1` | `packages/adapters/dsh`, `packages/app/src/agent-driver-composition.ts:293-340` | DSH source lock, adapter tests, real entry/lifecycle/CLI proofs | `tests/adapters/dsh`, `proof:dsh-entry`, `proof:dsh-lifecycle`, `proof:dsh-cli` | `LIVE` |
| `H-CLOSE-1` | Control closure | Settle execution, close the session, and preserve a recoverable terminal checkpoint. | Execution outcome | Session terminal/recoverable state | `H-OPERATION-1`, `A-CHECKPOINT-1` | `packages/app/src/index.ts:70-102`, `packages/app/src/cli.ts:77-145` | session settlement and resume tests | `tests/app/app.test.ts:1259-1456` | `LIVE` |

The headless branch does not contain the explicit Brain, FIFO requirement
inbox, UI projection, or M3 orchestration manager. Those are separate
architecture nodes, not implied capabilities of `run`.

### 1.4 Live UI runtime DAG

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `U-ENTRY-1` | Entry | Start the loopback UI runtime and choose fake or RCC provider mode. | CLI flags, config, rooted paths | Running HTTP runtime and binding | `A-CONFIG-1` | `packages/app/src/cli.ts:181-224`, `packages/app/src/ui-runtime/server.ts:130-158` | CLI/app and UI HTTP tests | `tests/app/app.test.ts:298-460`, `tests/app/ui-runtime.test.ts:1369-1510` | `LIVE` |
| `U-MEMORY-1` | Memory composition | Open rooted project/global memory persistence and compose backend, coordinator, agent, sources, and admission. | Runtime paths and memory config | Memory backend, coordinator, agent, event handler | `A-CONFIG-1` | `packages/app/src/memory-composition.ts:570-648` | memory composition and rooted restart tests | `tests/app/app.test.ts:462-809`, `tests/app/ui-runtime.test.ts:145-223` | `LIVE` |
| `U-MEMORY-2` | Memory analysis delivery | Consume analysis wake events and admit memory-agent processing after lifecycle boundaries. | Durable event and evidence refs | Admission receipt or attention | `U-MEMORY-1` | `packages/app/src/memory-composition.ts:634-647`, `packages/runtime/src/memory/events.ts` | memory event tests | `tests/runtime/memory/memory-events.test.ts` | `UNWIRED` |
| `U-BRAIN-1` | Explicit Brain | Receive, normalize, match, propose, confirm, and persist explicit interaction state. | Human business input | Confirmed requirement draft and interaction state | `U-ENTRY-1` | `packages/app/src/ui-runtime/service.ts:587-674`, `packages/runtime/src/intake/explicit-intake.ts` | explicit-brain and UI tests | `tests/app/ui-runtime.test.ts:291-583`, `tests/runtime/explicit-brain` | `LIVE` |
| `U-INBOX-1` | Requirement admission | Hold confirmed requirements in FIFO order and expose exactly one consumable entry. | Confirmed requirement | FIFO envelope and acknowledgement | `U-BRAIN-1` | `packages/runtime/src/intake/requirement-inbox.ts`, `packages/app/src/ui-runtime/service.ts:676-740` | FIFO, idempotency, concurrency, and restart tests | `tests/app/ui-runtime.test.ts:291-515` | `LIVE` |
| `U-DISPATCH-1` | Runtime dispatch | Consume the FIFO entry, create or correlate a task, and start exactly one execution. | Confirmed FIFO envelope | Task and operation identity | `U-INBOX-1`, `U-TASK-1` | `packages/app/src/ui-runtime/service.ts:676-740` | concurrent dispatch and idempotency tests | `tests/app/ui-runtime.test.ts:392-467` | `LIVE` |
| `U-TASK-1` | Task coordinator | Own task lifecycle, operation epochs, provider events, stop, settle, checkpoint, and projection events. | Task input and execution driver | Task snapshot, SSE events, checkpoint | `A-CHECKPOINT-1`, `U-MEMORY-1` | `packages/runtime/src/ui-runtime/coordinator.ts:966-1208`, `1260-1472` | UI runtime lifecycle, restart, stop, and hook tests | `tests/app/ui-runtime.test.ts:224-1367`, `1605-2420` | `LIVE` |
| `U-MEMORY-3` | Memory-bound execution | Bind task/runtime identity to memory scope, recall context, attach it, then execute provider-neutral driver. | Task/operation/epoch and memory backend | Bound context receipt and provider execution | `U-TASK-1`, `U-MEMORY-1` | `packages/app/src/ui-runtime/service.ts:766-917` | memory binding, stale epoch, and CLI restart tests | `tests/app/ui-runtime.test.ts:145-223`, `tests/app/app.test.ts:298-460` | `LIVE` |
| `U-FAKE-1` | Execution adapter | Provide deterministic fake/replay execution for the live UI path. | Provider-neutral execution request | Normalized provider events | `U-MEMORY-3` | `packages/app/src/ui-runtime/fake-port.ts` | fake lifecycle, terminal-state, and SSE tests | `tests/app/ui-runtime.test.ts:224-675`, `1605-1638` | `LIVE` |
| `U-RCC-1` | Execution adapter | Probe and execute through the real RCC v3 transport with Responses, OpenAI Chat, or Anthropic codecs. | Explicit provider binding, route ref, endpoint | Provider events and evidence | `U-MEMORY-3` | `packages/app/src/ui-runtime/index.ts:88-101`, `packages/adapters/provider` | provider contract/replay tests and real UI provider proof | `tests/adapters/provider`, `proof:ui-provider-loop` | `LIVE` |
| `U-PROJECT-1` | UI projection | Convert runtime snapshots/events into typed read-only dashboard, task, observation, and SSE projections. | Task/operation/checkpoint state | UI view models and events | `U-TASK-1` | `packages/ui/projection`, `packages/app/src/ui-runtime/service.ts:293-555` | UI projection and HTTP tests | `tests/ui`, `tests/app/ui-runtime.test.ts:224-290`, `1511-1638` | `LIVE` |
| `U-JOURNAL-1` | UI recovery projection | Replay task, operation, event, explicit-brain, inbox, confirmation, and dispatch state after restart. | UI runtime journal records | Hydrated runtime projections | `U-TASK-1` | `packages/app/src/ui-runtime/journal.ts:19-22`, `168-195`; `service.ts:569-585` | restart and corruption tests | `tests/app/ui-runtime.test.ts:468-515`, `725-944`, `1542-1603` | `PARTIAL` |
| `U-SUPERVISOR-1` | Process ownership | Acquire a daemon lease and fence session writes against stale owners. | Rooted paths and daemon lifecycle | Active lease and fenced writes | `A-CONFIG-1` | `packages/app/src/supervisor/supervisor.ts:365-491`, `packages/app/src/session-store.ts:201-258` | supervisor lease, crash, and fence tests | `tests/app/supervisor/supervisor.test.ts:26-342` | `PARTIAL` |

`U-MEMORY-2` is implemented and tested, but `serve` passes only
`coordinator`, `backend`, and `projectKey` to `startUiRuntime`; the composed
`eventHandler` is dropped. See `packages/app/src/cli.ts:198`, `215-219`, and
`packages/app/src/memory-composition.ts:634-647`.

`U-JOURNAL-1` is marked `PARTIAL`, not `LIVE`, because it stores more than a
disposable projection: it restores explicit-brain state, inbox entries,
confirmation state, and dispatch idempotency. The authoritative Journal owns
task and recovery facts, but this second journal is currently required for UI
recovery semantics. The source comment calls it projection-only, while the
implementation also owns restart-sensitive control-adjacent state.

`U-SUPERVISOR-1` is marked `PARTIAL` because the lease and fencing machinery
exists and is tested, but the live `serve` entrypoint does not call
`runSupervisorStartup` or `acquireDaemonLease`. The session store can fence a
lease when one is supplied; `serve` does not currently supply or acquire one.

### 1.5 Implemented architecture modules not on the live product path

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `X-M3-1` | Orchestration assembly | Assemble orchestration, runtime pool, review/merge ports, feedback hub, and checkpoint journal. | Task, scope, runtime pool, agents, feedback ports | `M3Assembly` and `OrchestrationManager` | `A-CHECKPOINT-1` | `packages/app/src/m3-assembly.ts:133-173`, `packages/app/src/index.ts:120-121` | M3 integration tests | `tests/runtime/integration/m3-assembly.test.ts:255-400` | `UNWIRED` |
| `X-ORCH-1` | Orchestration manager | Plan stages, create assignments, dispatch execution/review/merge, and publish feedback. | Assignment graph, runtime pool, agent ports | Assignment state and feedback events | `X-M3-1` | `packages/runtime/src/orchestration/manager.ts:168-260` | orchestration and M3 tests | `tests/runtime/orchestration`, `tests/runtime/integration/m3-assembly.test.ts` | `UNWIRED` |
| `X-NODE-1` | Fixed node runtime | Enforce admit/plan/dispatch/observe/settle lifecycle and strategy validation. | Node admission, plan, strategy registry | Node closure and evidence | `X-M3-1` | `packages/runtime/src/nodes/node-runtime.ts:87-230` | node runtime tests | `tests/runtime/nodes/node-runtime.test.ts:50-950` | `UNWIRED` |
| `X-EVENT-1` | EventBus | Durably publish, scope-filter, consume, retry, and receipt control/data/observation events. | Event envelope, publisher/consumer registries, Journal ports | Event records, receipts, retry obligations, DLQ | `A-JOURNAL-1` | `packages/runtime/src/events/coordinator.ts:43-49`, `184-782` | EventBus tests | `tests/runtime/events/eventbus.test.ts:351-1550` | `UNWIRED` |
| `X-FEEDBACK-1` | Feedback publication | Convert orchestration feedback into typed EventBus publications. | Work result, attention, retry, review, merge outcome | Feedback events | `X-EVENT-1`, `X-M3-1` | `packages/app/src/m3-assembly.ts:98-125` | M3 integration tests | `tests/runtime/integration/m3-assembly.test.ts:255-400` | `UNWIRED` |

The UI runtime explicitly reports `eventBus` as unavailable:
`packages/runtime/src/ui-runtime/coordinator.ts:433-437`. `M3Assembly` is
exported from the app package but is not imported by `serve`. `HarnessNodeRuntime`
and `OrchestrationManager` are tested directly and through M3 assembly, but
there is no `serve` composition edge to them.

### 1.6 Live UI capability projection

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `U-CAP-1` | Capability truth | Report which provider-neutral harness capabilities are actually available in the live UI runtime. | Runtime composition | Capability projection | `U-TASK-1` | `packages/runtime/src/ui-runtime/coordinator.ts:423-438` | UI capability test | `tests/app/ui-runtime.test.ts:2464-2472` | `LIVE` |

Current live projection:

```text
providerNeutralHarness              available
requestResponseHooks                available
agentIoRequestLifecycle             unavailable
contextCommitReentry                available
checkpointSettlementCancellation    available
eventBus                            unavailable
```

This projection is architectural evidence: the live UI runtime is not the
same architecture as the fully assembled M3/EventBus surface.

### 1.7 Memory namespace and scope DAG

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `M-CANON-1` | Canonical memory contract | Define `project` and `global` namespaces with explicit provenance and source identity. | Memory design and contracts | `CanonicalMemoryScope` and memory records | `A-IDENTITY-1` | `packages/contracts/src/index.ts:197-253` | memory adapter/coordinator tests | `tests/adapters/memory`, `tests/runtime/memory` | `LIVE` for contract surface |
| `M-LEGACY-1` | Live runtime memory scope | Bind live execution memory using the legacy `task` scope contract. | Task and organ identity | `MemoryScope { kind: 'task' }` | `U-MEMORY-3` | `packages/app/src/ui-runtime/service.ts:766-768` | memory binding tests | `tests/app/ui-runtime.test.ts:145-223` | `PARTIAL` |
| `M-COMPAT-1` | Scope compatibility gap | Prevent silent reinterpretation between legacy `task|organ|approved-global` and canonical `project|global`. | Legacy and canonical contracts | Explicit migration boundary | `M-CANON-1`, `M-LEGACY-1` | Design constraint in `docs/architecture/memory-system.md`; no live migration edge | No canonical live scope integration test | Contract comparison only | `MISSING` |

The canonical design explicitly says the old `task / organ /
approved-global` contract is still the running contract until migration.
`packages/contracts/src/index.ts:197-211` and `packages/app/src/ui-runtime/service.ts:766-768`
show both surfaces coexisting.

## 2. To-Be Architecture DAG

This is the minimal architecture for the project's actual product goal: a
provider-neutral long-horizon harness with one shared runtime core, explicit
input confirmation, durable control facts, memory at epoch boundaries, and
read-only UI projection.

```text
Configuration / rooted paths
        |
        v
Provider binding + process lease
        |
        v
Explicit input -> confirmation -> FIFO requirement inbox
        |
        v
Admission / classification
        |
        v
Task + cycle + operation + execution epoch
        |
        +-------------------------------+
        |                               |
        v                               v
Node/orchestration plan             Direct single-operation path
        |                               |
        +---------------+---------------+
                        |
                        v
                AgentRuntime harness
                        |
          +-------------+-------------+
          |             |             |
          v             v             v
     fake adapter   RCC adapter   DSH adapter
          |             |             |
          +-------------+-------------+
                        |
                        v
             Execution result + evidence
                        |
                        v
          Checkpoint/control closure (epoch n)
                        |
                        v
          Authoritative Journal fact (epoch n)
                        |
                        v
             EventBus / Attention delivery
                        |
                        v
        Memory analysis + durable snapshot (epoch n)
                        |
                        v
          Context assembly for epoch n+1
                        |
                        v
                Read-only UI projection
```

The epoch edge is directional:

```text
checkpoint_n -> memory_snapshot_n -> context_n+1 -> execution_n+1
```

This prevents a cycle. Memory can inform a future execution only after the
source execution has committed its control fact. It cannot mutate the
checkpoint that produced it.

### 2.1 Node necessity

| node | existence reason | deletion impact |
|---|---|---|
| Configuration / rooted paths | Every process needs one physical persistence and control root. | Breaks correctness and delivery; paths become implicit. |
| Provider binding + process lease | Prevents two live owners and keeps provider identity explicit. | Breaks correctness and safety; stale writers can race. |
| Explicit input -> confirmation -> FIFO | Separates human business input from control commands and prevents unconfirmed work. | Breaks correctness and traceability. |
| Admission / classification | Decides whether a requirement can create or update work. | Breaks correctness; queue and resource rules disappear. |
| Task / cycle / operation / epoch | Gives recovery and evidence stable identity. | Breaks correctness, verifiability, and recovery. |
| Node/orchestration plan | Required when a task has multiple dependent steps; optional for a single operation. | For simple work, removal only changes scheduling shape, not correctness. |
| AgentRuntime harness | Owns start/observe/stop/settle and provider-neutral events. | Breaks correctness and provider replaceability. |
| Provider adapters | Convert provider protocols into one harness contract. | Breaks delivery for real providers; fake-only remains a test path. |
| Checkpoint/control closure | Converts execution evidence into authoritative recovery state. | Breaks correctness and recovery. |
| Journal fact | Makes checkpoint and control state durable and auditable. | Breaks traceability, verifiability, and recovery. |
| EventBus/Attention | Delivers control/data/observation events with durable receipts. | Breaks asynchronous coordination and foreground feedback. |
| Memory analysis/snapshot | Produces approved memory after a committed epoch. | Breaks long-horizon learning, but not one-shot execution correctness. |
| Context assembly for next epoch | Injects approved memory into future execution without mutating source facts. | Breaks memory usefulness; direct execution still works. |
| Read-only UI projection | Makes runtime state observable without exposing raw Journal/session data. | Breaks UI delivery, not core execution correctness. |

## 3. DAG Diff

| Difference | Classification | Evidence |
|---|---|---|
| `serve` uses in-memory Attention while headless uses durable JSONL Attention. | `MISSING_EDGE`, `MISSING_EVIDENCE` | `packages/app/src/ui-runtime/index.ts:103-141`; `packages/app/src/attention-journal.ts:16-52` |
| `serve` does not acquire the implemented daemon lease. | `MISSING_EDGE` | `packages/app/src/cli.ts:181-224`; `packages/app/src/supervisor/supervisor.ts:365-491` |
| `M3Assembly` and `OrchestrationManager` are not imported by `serve`. | `MISSING_EDGE` | `packages/app/src/m3-assembly.ts:133-173`; `packages/app/src/cli.ts:181-224` |
| `HarnessNodeRuntime` is implemented and tested but not live. | `MISSING_EDGE` | `packages/runtime/src/nodes/node-runtime.ts:87-230`; no `serve` import |
| EventBus is implemented and tested but reported unavailable in the UI runtime. | `MISSING_NODE`, `MISSING_EDGE` | `packages/runtime/src/events/coordinator.ts`; `packages/runtime/src/ui-runtime/coordinator.ts:433-437` |
| The composed memory analysis event handler is dropped by `serve`. | `MISSING_EDGE` | `packages/app/src/memory-composition.ts:634-647`; `packages/app/src/cli.ts:198`, `215-219` |
| UI recovery uses a second journal for explicit-brain, inbox, confirmation, and dispatch state. | `WRONG_DEPENDENCY`, `MISSING_BINDING` | `packages/app/src/ui-runtime/journal.ts:19-22`, `158-195`; `packages/app/src/ui-runtime/service.ts:569-585`, `742-753` |
| Live execution memory uses legacy `task` scope while canonical design is `project|global`. | `MISSING_BINDING`, `MISSING_VERIFICATION` | `packages/contracts/src/index.ts:197-211`; `packages/app/src/ui-runtime/service.ts:766-768` |
| DSH is live in headless but disabled in `serve`. | `WRONG_DEPENDENCY` for a claimed shared harness, not an invalid adapter boundary | `packages/app/src/cli.ts:181-184`, `289-340` |
| Headless and UI paths duplicate execution composition instead of sharing one harness assembly. | `REDUNDANT_NODE` | `packages/app/src/agent-operation.ts:162-238`; `packages/runtime/src/ui-runtime/coordinator.ts:966-1044` |

No `INVALID_CYCLE` was found in the reconstructed As-Is graph. The apparent
memory/checkpoint feedback is not a cycle when execution epochs are explicit:
the edge always goes from epoch `n` facts to epoch `n+1` context.

## 4. Closure Violations

### A. Orphan Requirement

The live UI runtime does not yet connect the implemented M3 orchestration,
node runtime, EventBus, and memory analysis delivery to `serve`. If those are
part of the current product requirement, they are orphaned at the composition
boundary.

### B. Orphan Implementation

`M3Assembly`, `OrchestrationManager`, `HarnessNodeRuntime`, `EventBus`, and
the composed memory analysis handler have tests and implementations but no
live product entry edge. They are not dead code in the repository sense, but
they are architecture orphans relative to the current `serve` product path.

### C. Unverified Implementation

No live-entry verification exists for the M3/EventBus/node composition in
`serve`. The isolated tests verify the modules, not the product path.

### D. Unbound Verification

Several tests bind to modules rather than requirements or live paths:

- node runtime tests bind to `HarnessNodeRuntime`;
- EventBus tests bind to EventBus ports;
- M3 assembly tests bind to `createM3Assembly`;
- provider proof binds to the UI provider loop.

That is sufficient for module verification, but not sufficient to prove a
shared architecture path from `serve` through orchestration, EventBus, and
memory analysis.

### E. Missing Acceptance

There is no evidence that the live `serve` runtime satisfies the full
architecture contract for orchestration, EventBus delivery, durable
Attention, daemon ownership, and canonical memory scope. The live capability
projection explicitly says EventBus is unavailable.

### F. Missing Evidence

The live UI path has no durable evidence binding for:

- daemon lease acquisition;
- durable Attention publication;
- EventBus delivery receipts;
- memory analysis handler consumption;
- canonical project/global memory scope.

### G. Dependency Gap

The live `serve` path depends on memory context for execution, but its
analysis event handler is not wired. It also depends on runtime ownership
safety, but does not acquire the implemented daemon lease. The M3 assembly
depends on EventBus ports, while the live UI capability projection reports
EventBus unavailable.

### H. Dead Node

No node in the live execution path is dead. The unwired M3/EventBus/node
nodes are not deletable without losing a declared architecture capability,
but they are currently unreachable from the product entrypoint.

### I. Cycle

No invalid cycle was found. The memory/checkpoint relationship must remain
epoch-scoped: `checkpoint_n -> memory_n -> context_n+1`.

### J. Premature Closure

The live UI runtime must not be described as a complete provider-neutral
orchestration architecture while its own capability projection reports
`eventBus: unavailable`, its memory analysis handler is not composed, and its
process ownership lease is not acquired.

## 5. Minimal Migration Plan

The migration order follows the requested priority: binding, verification,
evidence, edge, necessary node, then architecture refactor.

1. **Bind durable Attention in `serve`.**
   Replace the UI runtime's in-memory Attention with the existing
   `createJsonlAttentionPort` or inject an Attention port from the CLI
   composition. Keep the current headless behavior unchanged.

2. **Bind daemon lease ownership in `serve`.**
   Acquire the existing supervisor lease at UI startup and release it on
   shutdown. Do not add a second ownership mechanism.

3. **Bind the memory analysis handler.**
   Pass `memory.eventHandler` through the `serve` composition and consume it
   through the EventBus or the declared event delivery owner.

4. **Bind EventBus to the live UI runtime.**
   Provide the missing journal, registry, and external-operation ports to the
   UI runtime composition instead of leaving the capability unavailable.

5. **Correct the UI recovery truth boundary.**
   Decide which state is authoritative and move explicit-brain, inbox,
   confirmation, and dispatch recovery to that owner. Keep the UI journal only
   for disposable projections if the authoritative Journal already covers the
   facts.

6. **Bind M3 orchestration and node runtime only if required by the current
   architecture contract.**
   If the product path requires multi-step orchestration, connect the existing
   `M3Assembly` and `HarnessNodeRuntime`; otherwise record them as non-product
   capability surfaces and do not force them into the main path.

7. **Unify memory scope semantics.**
   Add the canonical `project|global` scope binding to the live execution
   path, with a migration boundary for existing `task|organ|approved-global`
   records. Do not silently reinterpret old records.

8. **Share composition only after the bindings are correct.**
   Extract the common harness assembly only when the headless and UI paths
   have the same required behavior. Do not rewrite the working execution
   code to satisfy a diagram.

## 6. Remaining Risks

- **UI process ownership is not closed**: `serve` constructs the UI runtime
  without acquiring the implemented daemon lease, so two live writers can
  remain possible even though the fencing mechanism exists.
- **UI attention is not durable**: the live UI path uses an in-memory
  Attention port while headless execution uses the JSONL Attention journal.
  A UI process restart can therefore lose a control-delivery fact that the
  headless path preserves.
- **EventBus and orchestration are absent from the live composition**:
  `M3Assembly`, `OrchestrationManager`, `HarnessNodeRuntime`, and EventBus are
  implemented and tested, but `serve` neither imports nor wires them. The live
  capability projection reports `eventBus: unavailable`.
- **Memory analysis is dropped at composition**: `serve` does not pass the
  composed `memory.eventHandler` into the UI runtime, so the implemented
  memory-analysis delivery node has no live consumer.
- **UI recovery has a second truth surface**: the UI runtime journal restores
  explicit-brain, inbox, confirmation, and dispatch state in addition to the
  authoritative Organ Journal. The current restart semantics depend on this
  second surface.
- **Memory scope is split**: live execution memory uses legacy `task` scope,
  while the canonical contract exposes `project|global`. There is no explicit
  live compatibility or migration binding between them.
- **The two top-level branches are not one harness**: `run/resume` is the
  live DSH path, while `serve` supports only fake/RCC execution. This may be
  valid if they are intentionally separate products, but the architecture
  cannot claim one shared live harness until that boundary is explicit.
- **Loopback API exposure is unverified as an architectural boundary**: the
  UI runtime exposes an HTTP/SSE surface, but the audited graph has no
  authentication or network-scope node. If loopback-only is the contract, it
  must remain an explicit deployment boundary rather than an implicit
  assumption.
- **Unwired capabilities have no product-path evidence**: isolated tests
  prove module behavior, not reachability, delivery receipts, or terminal
  closure through a live entrypoint.

## 7. Final Closure Criteria

This is an architecture-closure checklist, not a development-lifecycle
checklist. The architecture is closed only when all of the following hold:

1. Every claimed requirement has a traced path through the live
   implementation to a terminal control and delivery outcome.
2. Every live node has an implementation binding, a verification binding, and
   evidence identifying the exact runtime path that produced it.
3. Every live path terminates at a legal closure state: succeeded, failed,
   stopped, blocked, or explicitly recoverable unknown.
4. The live capability projection matches the actual runtime composition; an
   unavailable capability cannot be claimed as part of the live harness.
5. There is no undeclared second truth surface for recovery, attention,
   process ownership, or dispatch state.
6. Memory and checkpoint edges remain epoch-scoped:
   `checkpoint_n -> memory_n -> context_n+1 -> execution_n+1`; no edge may
   mutate the source epoch.
7. Every implemented-but-unwired node is either connected to a live
   entrypoint or explicitly classified as a non-product capability and
   excluded from live acceptance.
8. No requirement path remains an orphan, no implementation lacks a
   requirement or design owner, and no live implementation lacks verification.
9. No unbound verification, missing acceptance evidence, dead live node,
   dependency gap, or invalid cycle remains.
10. The audit and its claims are bound to the exact repository SHA and tree
    under review.

For the audited architecture at `3454a23f8854b7c0f79f32d083bcae471ecea42d`,
the path is not closed. The first blocking gaps are the unwired live
EventBus/orchestration path, the dropped memory-analysis handler, and the
`serve` process-ownership/durable-Attention gaps.
