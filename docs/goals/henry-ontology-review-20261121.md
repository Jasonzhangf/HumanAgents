## 2026-11-27 三轴审批入库与治理同步

- 用户已批准 MVP 基础语义（含 Clauses 1、2、3 及 `mvp-v1-*`、`explicit-agent-context-tools-*`、`ontology-*` 核心规则）。
- 全库 67 个 `project-memory` 节点已全部完成 `entry_kind`（`rule` / `fact`）与三轴 `rule_control` 审批入库，`project-memory verify .` 返回 `ok: true`、`status: "ready"`。
- 已同步完成治理升级（`appsdk 0.1.0015`，`appsdk verify .` 与 `appsdk verify --admission .` 均退出码 `0`）及 MVP 代码/测试消融（移除 `OperationMode` 无消费者 `'legacy-forward'` 分支与失效测试 `stop-planner-settlement-caller.test.ts`）。

# HumanAgent ontology review

Long-term goal: review the HumanAgent domain ontology clause by clause with the user, record each user-approved fact into project memory, and keep candidate or uncertain semantics out of implementation claims.

## 2026-11-21

- Reviewed and recorded Organ, Task v3, Goal, and the distinction between periodic execution wakeups and one-shot progress-check wakeups.
- The user confirmed `skip` as the standard wakeup behavior in the [Goal review](../../memory/L3/ontology-goal.md). The [delivery plan](../architecture/agent-framework-work-plan.md) places long-horizon subscriptions and reminders in Milestone 2.
- User-approved patrol reminder rule: the whole patrol cycle defers while the executor is busy; when idle, send this reminder immediately and resume the original cadence. The wakeup itself is the goal. Reminders do not merge.
- Recorded the one-shot user-input rule. A user response resumes the waiting task immediately. The third unanswered progress check makes the task continue from the accepted Goal and task rules, records the automatic decision, and notifies the user Inbox without inventing a user answer.
- Recorded the user's late-answer decision in the [same memory entry](../../memory/L3/ontology-one-shot-user-input-wakeup.md). The original task assesses the answer against current progress and its accepted Goal, applies the existing Goal update process when needed, then reassesses its state and next action.
- The user confirmed that cancellation invalidates every unsent reminder for that subscription, including a due reminder deferred while busy. See the [cancellation decision](../../memory/L3/ontology-subscription-cancel-unsent.md).
- The user clarified that every reminder counts when sent, from the first through the last. See the [counting rule](../../memory/L3/ontology-reminder-count-on-send.md).
- The user confirmed that only the final ten patrol reminders each request renewal. The agent decides whether to renew. Expiry ends reminders, while the task owns its execution lifecycle. See the [renewal decision](../../memory/L3/ontology-patrol-renewal-tail.md).
- The user clarified that renewal only updates the remaining reminder count on the original subscription.
- The user confirmed the sequence for a new requirement on an existing one-shot Task. Clarify what the requirement means and update the Goal. Compare the old Cycle's results with the updated Goal to identify gaps. Update the plan from that assessment and continue execution. See the [project memory decision](../../memory/L3/ontology-terminal-evaluation-current-goal.md).
- Source observation. The [task editing entry](../../packages/runtime/src/ui-runtime/coordinator.ts) returns `task.busy` during running or settling and asks the caller to stop execution before editing. This bounds what the editing path can demonstrate about the proposed scenario.
- The [running-task append test](../../tests/app/ui-runtime.test.ts) exercises a separate user path. A confirmed addition queues on the same Task while its first execution runs. The test checks that the next execution receives the addition and that the Task eventually succeeds.
- The [append dispatch path](../../packages/app/src/ui-runtime/service.ts#L8714) marks the input revision consumed when the next execution is prepared, before releasing that execution. The cursor therefore proves input pickup. The test checks the eventual Task state but leaves the displayed state between executions and the content of the combined deliverable unverified.
- The [third unanswered check](../../memory/L3/ontology-one-shot-user-input-wakeup.md) resumes work under the accepted Goal. The [existing-task change requirement](../../.appsdk/requirements.json#L646) requires separate confirmation for a change to its goal, scope, or handling. At that check, the agent can advance work within its current authority and report what it actually did. A proposed change that requires confirmation stays pending.
- Read the retained `humanagent-ui-append-running-iymTS1/ui-runtime-journal.jsonl` from the [running append case](../../tests/app/ui-runtime.test.ts#L5185). Record 24 closes the first execution with `execution.terminal`, `final`, `succeeded`. Records 26 and 27 prepare and start the confirmed `appended instruction` on the same Task. The test samples the dashboard before releasing the first execution and after the second starts. The task state visible between those events and acceptance of the combined output are still open.
- The user confirmed that all Tasks follow the new requirements when resolving conflicts. An executor that is unsure may ask the user to decide. In the absence of a ruling, it follows the applicable default path and adds the decision to the user's to-do reminders. In the draft example, “review before sending” takes effect for the pending send. [Project memory decision](../../memory/L3/ontology-task-conflict-current-goal.md)
- Replayed records 1 through 25 of the retained running-append fixture through `projectDurableTaskInventory`, using `FileCheckpointStore` for the recorded cycle. Immediately before record 26 prepares the confirmed addition, the inventory returns one Task with `state=succeeded`, `executionEpoch=1`, `input=baseline input`, and `durableState=checkpoint`. The checkpoint outcome is `succeeded`. This identifies a task-level success projection while confirmed work is pending. The remaining frontend observation is the task status rendered during that interval.
- The [Task List page](../../docs/ui/tasks.js#L206) reads the project or system dashboard. The [row loader](../../packages/app/src/ui-runtime/service.ts#L5907) uses live rows for the bound project and mode. Other scopes read durable inventory with additional current-state and inspection-stop readers. The fixture replay establishes the checkpoint-based intermediate state. The status rendered by either dashboard during that interval still needs a browser observation.
- Reviewed responsibility for outstanding assignments after an accepted parent Goal change. The [role table](../architecture/agent-flows.md#22-agent-角色总览) assigns dispatch to the orchestrator. The [handoff design](../architecture/native-agent-handoff.md#owner-boundaries) assigns acceptance to the designated task or pipeline owner. The user approved the proposal: the current parent-task orchestrator assesses outstanding assignments against the revised Goal and updates or withdraws affected work. A formal transfer of parent-task responsibility transfers this duty to the successor. See the [project memory decision](../../memory/L3/ontology-parent-goal-assignment-handoff.md). The earlier decision on conflict precedence is already in project memory.
- Applied the approved Goal and conflict decisions to completed sends. “Show me future drafts before sending” changes subsequent sends. “Recall my last message” identifies the earlier send and requests a recall attempt. The original send receipt records what happened. The recall result determines what the Task can report. See the [gateway contract](../architecture/hand-task-gateway.md#L321).
- Application of the [approved conflict decision](../../memory/L3/ontology-task-conflict-current-goal.md). For “correct the version the customer received,” assess what the customer already has, then choose an authorized action that delivers the correct version. A successful recall alone leaves delivery of the correct version outstanding. When the executor uses the default path in the absence of a ruling, record its decision in the user's to-do list.
- Task completion after an amendment follows the approved [current Goal assessment](../../memory/L3/ontology-terminal-evaluation-current-goal.md). A concrete acceptance case is a request for a report of sales by region, followed by a confirmed request to add a total to that report. Open the final report from the same Task and check both the regional figures and the total. A report containing only the total leaves the original breakdown outstanding. The [running append test](../../tests/app/ui-runtime.test.ts#L5242) checks dispatch, final state, input revision and Task identity. The contents of the delivered report still need observation. The [service verifier](../architecture/hand-task-gateway.md#L323) owns this semantic check in the design.
- Late replies at the closure boundary. Use the Task closure committed to the Organ Journal to locate the reply in the lifecycle. While the Task is open, assess the reply immediately against its current Goal and results. After closure, assess the reply in the context of the original work. A reply accepting the delivered result can be recorded as an event. A confirmed request for further execution follows the new Task path and can use the earlier result as input. The running-append replay covers the interval between Cycles. Post-closure behavior still needs runtime evidence. This applies the existing [Task transitions](../../memory/L3/ontology-task.md) and [late-answer decision](../../memory/L3/ontology-one-shot-user-input-wakeup.md).
- Candidate review started for Task, Cycle, Operation, and Checkpoint lifecycle ownership. Evidence: [Task has four main states](../../memory/L3/ontology-task.md), [Cycle is one finite recall/work/completion round and Operation is an auditable or settlable effect](../../docs/architecture/organ-runtime.md#L417), [Checkpoint is a chained durable recovery state rather than a completion fact](../../docs/architecture/context-contract.md#L89), and [operation settlement must precede checkpoint closure while unknown effects require reconciliation](../../docs/architecture/organ-runtime.md#L705). Current contracts still expose a shared `LifecycleState` on Task, Cycle, and Operation. This candidate is pending user approval and is not project memory or implementation authority.
- Scope correction before user review. The [interaction closure contract](../../packages/runtime/src/checkpoints/closure.ts) rejects task, cycle, or operation identity, and the [provider identity contract](../../packages/contracts/src/index.ts) preserves taskless interaction and helper execution. The pending clause therefore applies only to Task-scoped execution. It does not create Task identities for taskless interactions and does not claim that every global Operation belongs to a Task.

### Candidate source clause: lifecycle ownership

This combined draft is retained for source traceability only. It is not an
approval unit; the three split clauses below are the exact pending decisions.

- Object `Task`: the user-visible business work object. It has `created`, `active`, `waiting`, and `closed` main states.
- Object `Cycle`: one finite execution round under one committed Goal revision. A Task may have many Cycles.
- Object `Operation`: a task-scoped operation is one auditable, cancellable, or settlable effect inside one Cycle. It retains its own execution status.
- Object `Checkpoint`: a task-scoped checkpoint is one durable recovery record in a checkpoint chain. It references exact Task and Cycle scope, execution epoch, evidence, and recovery state.
- Behavior: a Cycle may end as `succeeded`, `waiting`, `blocked`, `failed`, `cancelled`, `stopped`, or `unknown` without directly becoming the Task state. The Task owner decides whether the Task stays `active`, becomes `waiting`, or becomes `closed`.
- Behavior: before a Task can close with `succeeded`, the current Cycle result and every affected Operation must be settled, verified, or explicitly reconciled. An unknown side effect cannot be treated as success.
- Behavior: a confirmed Goal change may leave an already running Cycle on its bound Goal revision. The next Cycle uses the new revision; it must not switch the running Cycle silently.
- Forbidden action: writing a task-scoped Cycle, Operation, or Checkpoint state into Task state as equivalent values.
- Forbidden action: closing a Task successfully without a committed checkpoint or with an unreconciled affected Operation.
- Forbidden action: treating a checkpoint as closure, task completion, or proof that an external effect succeeded.
- Relation: Task `1--*` Cycle, task-scoped Cycle `1--*` Operation, task-scoped Cycle `1--*` Checkpoint, and Task `1--*` Checkpoint through its Cycles.
- State effect: the Journal commits Cycle, Operation, and Checkpoint facts. The Task lifecycle owner commits Task transitions only after consuming their closed or recoverable outcomes.
- Owner: `packages/core` owns Task lifecycle semantics. `packages/runtime` owns Cycle coordination, Operation settlement coordination, and Checkpoint submission. `packages/adapters/jsonl` owns durable Journal append.
- Exclusion: taskless interaction uses `InteractionClosure` without Task, Cycle, Operation, or Checkpoint identity. The [existing requirement](../../.appsdk/requirements.json) forbids creating a pseudo-Task for that path.
- Evidence: [Task ontology](../../memory/L3/ontology-task.md), [Goal ontology](../../memory/L3/ontology-goal.md), [Cycle and Operation definitions](../../docs/architecture/organ-runtime.md#L417), [Checkpoint closure and reentry](../../docs/architecture/context-contract.md#L89), [operation-to-checkpoint order](../../docs/architecture/organ-runtime.md#L705), [interaction closure identity](../../packages/runtime/src/checkpoints/closure.ts), and the [serve-task recovery graph](../../docs/dagpipe/serve-task.graph.json).
- Approval: `candidate`. No project-memory write or governance binding has been made.
- Proposed gate: `transition` at the Task closure path. Allow a known successful Cycle with all affected Operations settled, verified, and checkpointed. Deny Task success while an affected Operation is `reconcile_required` or the required Checkpoint is missing. Observe through the public Task detail and its committed Journal chain.

### Clauses after one-by-one split

The combined draft above is historical. Clauses 1 and 2 have user decisions
recorded below. Clause 3 awaits review.

1. Lifecycle ownership. A Task owns only the four main states `created`,
   `active`, `waiting`, and `closed`, plus its closed outcome. Task-scoped
   Cycle, Operation, and Checkpoint records own their execution facts and
   outcomes. A projection may reuse a generic label, but it must not treat
   Cycle, Operation, or Checkpoint state as the Task state. Taskless
   interaction stays on `InteractionClosure` and carries no Task, Cycle,
   Operation, or Checkpoint identity. Proposed gate: `identity/transition` on
   public Task state commits; observe Task detail and its Journal scope.
2. Goal change during execution (user-confirmed semantics). When the user
   changes the Goal, the Task immediately enters the Goal-change flow and
   the current Cycle stops advancing the old Goal. Clarify the new requirement
   and commit the updated Goal. Use existing results to assess the remaining
   gap, update the plan, and continue the same Task under the updated Goal.
   Keep the old Cycle's revision association as execution history.
   See the latest clause 2 review entry for the proposed gate and evidence.
3. Successful Task closure (candidate). Once the user confirms a Goal change,
   the same Task can deliver available results under the revised Goal. If a
   previously started Operation has an unknown result that affects acceptance
   of the current Goal, report the uncertainty and retain responsibility for
   checking the result. Defer committing Task success until that result is
   known and the Task owner has assessed it against the current Goal.
   Proposed gate: `terminal/effect` at Task closure. Deny a success commit
   while a result needed for acceptance is still unknown. Allow success once
   that result is known and the current Goal meets its acceptance criteria,
   subject to existing closure requirements. Observe the public Task detail
   and the Operation receipt in the Organ Journal. See the latest clause 3
   review entry for the pending user decision.

Current source evidence for the split: `packages/contracts/src/index.ts`
reuses `LifecycleState` across Task, Cycle, and Operation while Operation also
has its own `OperationStatus`; `packages/core/src/tool-execution-lifecycle.ts`
maps `reconcile_required` to `unknown`; and
`packages/runtime/src/checkpoints/submission.ts::assertKnownClosure` rejects a
non-unknown checkpoint when unresolved operations remain. These observations
support the semantics but do not replace user approval or a bound executable
gate.

## 2026-11-21 19:33 UTC clause 1 review handoff

- Consumed deadline `m1795289511367-251` once. This was cycle 30/100 of the
  existing task subscription. No duplicate subscription or identity was made.
- Rechecked the current owner boundary and source. `Task`, `Cycle`, and
  `Operation` still share `LifecycleState` in
  `packages/contracts/src/index.ts`. Runtime task snapshots also expose that
  generic state.
- The checkpoint submission owner already rejects a non-unknown closure while
  unresolved operations remain. `prepareCheckpointClosure` collects unsettled
  and uncertain operations as pending, and the architecture says that
  Checkpoint records recovery facts rather than the Task's final state.
- The design owner still has to separate the public Task lifecycle from Cycle,
  Operation, and Checkpoint state. Successful Task closure also needs a
  check that all affected effects are settled or explicitly reconciled and
  the required checkpoint chain is committed.
- Clause 1 is ready for an exact user decision. No project-memory write or
  governance binding was made.

### 2026-11-21 20:05 UTC clause 1 recheck

- Reconciled duplicate notification `m1795291308167-285`. `collab recv` returned
  zero new messages, and exact readback confirms the cycle-32 deadline was
  already consumed. It added no authority and did not approve clause 1.
- Rechecked the approved Task ontology, shared `LifecycleState` declarations,
  Checkpoint closure preparation, and unresolved-operation handling. Clause 1
  remains the exact pending decision; no project memory or governance binding
  was written.

### 2026-11-21 20:30 UTC clause 1 source recheck

- Rechecked the split clause against the current Task, Cycle, Operation, and
  Checkpoint contracts; the lifecycle responsibility table; the interaction
  closure contract; and the Checkpoint submission boundary.
- The evidence supports the clause wording: Task owns its four main states and
  closed outcome; Task-scoped execution records own their execution facts and
  outcomes; taskless interaction stays on `InteractionClosure`.
- Clause 1 remains `candidate`. It is not written to project memory and has no
  governance binding. Clauses 2 and 3 are also unapproved.

### 2026-11-21 21:02 UTC notification and clause 1 recheck

- The wake for `m1795294306891-330` added no execution authority. `collab recv`
  returned no new messages, and exact readback showed the durable message was
  already consumed. Its OAuth executor had already exited with `INCOMPLETE`.
- Confirmed that the candidate still contains only the pre-exit test-file
  change and the previously retained tracked and untracked changes. No commit,
  merge, push, tester start, or fresh executor followed.
- Rechecked clause 1 against the shared `LifecycleState` declarations, the
  interaction closure boundary that rejects Task, Cycle, and Operation identity,
  the four-state Task memory, and the operation-to-Checkpoint settlement path.
  No source evidence invalidates the clause wording.
- Clause 1 remains the sole exact approval unit for review. It is still
  `candidate`; no project-memory write or governance binding exists.

### 2026-11-21 21:05 UTC OAuth audit reply

- Sent Jenny the exact `attempt-oauth-1` audit in `m1795295043128-342`. The
  worker exited `0`, but its result is `INCOMPLETE`: the required proof command
  exited `1` at a parent/child Task identity mismatch, so no-pause RED and
  paused GREEN remain `UNVERIFIED`.
- The business parent was `ui-task-implicit-draft-2`; the exact grant belonged
  to current execution child `scheduled-task-665227213af5adf02045`. This
  supports the accepted architecture ruling and does not prove a product grant
  regression.
- No candidate file changed after the OAuth exit. No commit, merge, push,
  tester, or fresh executor followed. Settlement cleanup remains `INCOMPLETE`;
  runner PID `67397` and port `64068` are gone, no matching runner or Chromium
  remains, and recovery root
  `/var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/humanagent-confirmed-append-no-pause-red-n4yDAr`
  remains under Henry.
- Clause 1 remains the sole exact approval unit. Approval would affect only
  ontology and project memory. Code implementation and governance binding
  remain separate later steps.

### 2026-11-21 21:30 UTC OAuth2 public relation admission result

- Consumed `m1795296103738-356`; the wake added no new execution authority.
  Jenny's original gate `m1795296036491-355` was read through the permitted
  exact-message path. Message `m1795295960268-354` is not readable by this
  caller because it is neither sender, recipient, nor an open reply obligation.
  The existing audit references were used instead; no ACL bypass was attempted.
- OAuth attempt 2's required `proof:liveness` command ran once and exited `1`.
  The build completed. Real Chromium submitted the homepage confirmation for
  parent `ui-task-implicit-draft-2`, but the same-scope public parent row did
  not expose `currentExecutionTaskId` during 30 seconds. No grant or append was
  submitted, so the no-pause RED and quiesced GREEN remain `UNVERIFIED`.
- Retained runtime evidence independently contains child
  `scheduled-task-665227213af5adf02045`, operation
  `scheduled-operation-665227213af5adf02045`, epoch 1, public output
  `BASELINE_RESULT`, and a succeeded checkpoint. The failure is therefore a
  public relation projection gap, not evidence that execution or grant state
  was lost.
- Source audit shows `projectParentExecutions` skips parents with their own
  execution facts. `projectRuntimeTaskList` sets `currentExecutionTaskId` only
  for a grouped parent without own execution/failure, and existing tests expect
  the pointer absent for own-execution and terminal-child parents.
  `productRelations` exposes committed lineage edges but no unique
  current-child, current-operation, or epoch selection.
- Architecture ruling: the existing test-only contract must remain suspended.
  No supported exact relation currently identifies the one current child.
  Title, row order, arbitrary nested child, and parent ID fallback remain
  forbidden. A continued browser gate requires a separately authorized App
  public projection fix with legal and illegal relation cases and same-parent
  list/detail composition. Do not broaden the candidate writer scope by
  assumption.
- Wrote the incomplete attempt handoff and architecture admission result under
  the retained worker-run directory. No candidate source or test file changed
  in this round. No commit, merge, push, review, tester, or browser process
  followed. OAuth1 and OAuth2 recovery roots remain under Henry.
- Clause 1 remains the sole exact approval unit. It is still `candidate`; no
  project-memory write or governance binding exists.

### 2026-11-21 21:28 UTC duplicate wake recheck

- `collab context` restored Henry as peer/architect on the same worker
  `collab-36dd279f45324c9563062d85eb76a8ad`, the same Codex session, and the
  existing Rex session. No new Rex session or identity was created.
- The wake for `m1795296103738-356` added no new authority. `collab recv`
  returned `count=0`, and `collab inbox` remained empty. Exact readback of
  `m1795295960268-354` was rejected because this caller is neither sender,
  recipient, nor an open reply-claim holder; no ACL bypass was attempted.
- Clause 1 remains the exact pending user decision. It is still `candidate`;
  no project-memory write or governance binding exists. The browser-execution,
  tester, commit, merge, and push suspension remains unchanged.

### 2026-11-22 01:08 UTC clause 1 approved and recorded

- The user approved clause 1 with the exact text `同意`.
- Recorded it as approved project-memory rule
  `ontology-task-lifecycle-ownership` revision 1 at
  [memory/L2/ontology-task-lifecycle-ownership.md](../L2/ontology-task-lifecycle-ownership.md).
  The Memory receipt promoted it from a revision-1 candidate to level 2 /
  reviewed with the matching project scope, entry ID, and revision.
- The approved semantics separate Task main state and closed outcome from
  task-scoped Cycle, Operation, and Checkpoint execution facts. The Task owner
  assesses the current confirmed Goal and available results, commits the
  whole-Task decision to the Organ Journal, and interface Task status follows
  that decision. Taskless interaction remains `InteractionClosure`.
- `project-memory verify /Volumes/extension/code/humanagent` passed for both
  project and global scopes; the project scope now has 36 consistent nodes.
- The proposed identity gate at `task-lifecycle/public-state-commit` is
  recorded as the target but remains unbound and unexecuted. No product
  implementation or governance execution is claimed.
- Clause 2, Goal revision binding, is now the exact next approval unit.
  Clause 3, successful Task closure, remains unapproved.

### 2026-11-22 01:18 UTC clause 2 evidence review

Historical review. The latest clause 2 entry supersedes its recommendation
to let the admitted Cycle continue executing the old Goal.

- Rechecked the approved Goal ontology, Cycle definition, task update path,
  checkpoint identity, scheduled-occurrence claim, and serve-task admission.
- The evidence supports a persistent binding at the Cycle's durable admission
  or execution claim. A Goal revision committed before that binding is
  eligible. A revision committed after it leaves the admitted Cycle on its
  recorded revision; the next Cycle reads the then-current accepted revision.
- The current implementation persists `directiveRevision` and
  `executionEpoch`, but exposes no independent committed GoalRevision chain or
  Cycle-to-GoalRevision field. This is an implementation gap. It does not
  invalidate the proposed semantic boundary.
- Clause 2 remains `candidate`. No project-memory write or governance binding
  was made for it. It is now the sole exact pending approval unit.

### 2026-11-22 01:47 UTC P0 wait and parent-task alignment

- Consumed P0 receipt `m1795311308935-12`. Its request was limited to
  cancelling the entry-recovery board-idle patrol while the task remains under
  `PROTECTED_HOLD`.
- `collab notify status` now reports no eligible board-idle tasks. The
  task-linked goal deadline and the one-shot fixture deadline are cancelled;
  only the direct-message subscription remains armed.
- The P0 entry-recovery task remains `accepted` with `cleanup_status=pending`.
  Its exact next step still requires a new Jenny ruling or released owner
  evidence. No service, cleanup, reconstruction, fixture, close, or resource
  action was started.
- Consumed `m1795311990736-27`. Jenny aligned clause 1 on the existing parent
  task and confirmed that it does not authorize a new source trace, code,
  fixture, or service action. Bob remains plan/review only.
- Clause 2 remains the sole exact pending approval unit. Clause 3 remains
  unapproved.

### Clause 2 revised after user correction

- Source: the user said that changing the Goal starts the Goal-change flow
  immediately and that work must not continue under the old Goal. The
  previous proposal incorrectly treated the Cycle's revision binding as
  permission to finish old work.
- Objects and relation: the Task retains its identity. Its Goal has a current
  committed revision. The old Cycle and its recorded results retain their
  historical revision association.
- User decision recorded in clause 2 above and in the [Goal project memory](../../memory/L3/ontology-goal.md).
- Design handoff `m1795316367221-188` aligns with clause 2. Core owns the Task
  and Goal transition. Runtime must check the authoritative Task and Goal-change
  state when dispatching the next operation, including from an already-admitted
  Cycle. The planned new-Cycle claim gate covers only admission. Operations
  already started retain their original revision, receipts and settlement owner.
- Proposed public-entry check: hold an admitted Cycle just before it sends a
  draft. Confirm the change to presenting the draft. Verify that the old send
  never starts and the same Task presents the draft under its updated plan.
  With the change still unconfirmed, otherwise authorized dispatch remains
  eligible. The exact dispatch point and race boundary await a scoped trace
  before implementation. [Design handoff](/Volumes/Intel/playground/humanagent/ontology-code-governance-20261121/docs/verification/ontology-code-governance-20261121.md:922)

### Clause 3 review focus

- Clause 1 already assigns the Task owner responsibility for evaluating the
  current confirmed Goal against available results. Clause 2 starts the Goal
  change immediately. Both decisions apply while prior effects are checked.
- Pending decision. When a user changes a delivery task from sending an email
  to reviewing its draft, the draft can be presented immediately. If an
  earlier send attempt has an unknown result, the proposed closure condition
  is to report that uncertainty and retain responsibility for checking the
  send before committing Task success. The send result affects whether the
  customer may have seen the draft before review.
- Proposed observation. Check the draft and the send status in Task detail
  and compare the Task outcome with the Operation receipt in the Organ
  Journal. The Task owner in Core makes the closure decision. Runtime
  coordinates reconciliation. Clause 3 awaits the user's decision.

### Clause 3 source check

- The closure-preparation path rejects unknown Operation coverage before it
  can propose a terminal closure. See
  [closure.ts](../../packages/runtime/src/checkpoints/closure.ts#L147).
- An Operation in `reconcile_required`, an already attached reconciliation,
  or a possible side effect is classified as uncertain. That Operation stays
  pending and becomes an unknown Operation in the prepared closure. See
  [closure.ts](../../packages/runtime/src/checkpoints/closure.ts#L177).
- The checkpoint submission path accepts unresolved unknown Operations only
  with an `unknown` checkpoint and a recovery next action. See
  [submission.ts](../../packages/runtime/src/checkpoints/submission.ts#L247).
- The runtime Task projection copies the closed checkpoint outcome when no
  separate terminal state is committed. An unknown outcome therefore remains
  non-successful for the Task projection. See
  [coordinator.ts](../../packages/runtime/src/ui-runtime/coordinator.ts#L7920).
- This evidence matches the revised candidate. Clause 3 still has no user
  approval, project-memory write, or executable governance binding.
- Existing plan revisions carry business acceptance criteria, but there is no
  current committed GoalRevision chain. The implementation also has no typed
  relation from an unresolved Operation to the current acceptance criterion
  that the Operation may affect. Model text, UI copy, or a Task outcome label
  cannot supply that relation.
- Existing shutdown and checkpoint closure already distinguish an unresolved
  result from a known result. This supports retaining recovery responsibility,
  but it does not prove that the unknown effect matters to the current Goal.
- The Task UI contracts expose public output commits and per-event output
  references. They do not expose a typed acceptance assessment that binds a
  retained result or unresolved Operation to the current Goal. The documented
  UX intent to show prior results without treating them as completion is
  design guidance, not runtime enforcement.

### Clause 3 candidate ontology model

This is a modeling candidate, not an approved rule or enforcement claim.

Object candidate `task-goal-acceptance`:

- Definition: the current GoalRevision and the acceptance criteria that the
  Task owner will evaluate for a successful outcome.
- Identity: one Task plus its current committed GoalRevision plus the plan
  revision evaluated against that GoalRevision.
- Owner: Core for the Task, Goal, outcome, and acceptance decision.
- Perception: public Task detail for the acceptance state, with the committed
  Journal Goal and plan references available through the existing history
  observation path.
- Must have: a committed GoalRevision and the acceptance criteria applicable
  to the Task plan revision.
- Must not have: a model-authored summary, UI label, notification, or stale
  GoalRevision acting as acceptance truth.

Behavior candidate `assess-prior-unknown-before-task-success`:

- Precondition: a previous Operation has an unknown result. The Task may
  already deliver results that satisfy the current Goal while the Operation
  result remains relevant to successful closure.
- Input: the current GoalRevision, the plan acceptance criteria, the Operation
  result state, and evidence that the Operation may affect a criterion.
- Transition: `(waiting-or-settling, unknown Operation affecting acceptance) ->
  (non-success Task outcome plus retained recovery responsibility)`.
- Effects: expose the missing result as an uncertainty to the user; keep the
  reconciliation action and its owner; do not commit success.
- Perception: public Task detail shows the uncertainty and next owner; the
  Organ Journal preserves the Operation result state and reconciliation
  evidence.
- Must have: a typed link from the unresolved Operation to the affected
  acceptance criterion, plus an identifiable recovery owner.
- Must not have: success inferred from available partial delivery, closure
  from a merely possible side effect, or a new Task used to mask the unknown
  Operation.

Relation candidate `operation-affects-goal-acceptance`:

- From: one unresolved Operation.
- To: one acceptance criterion in the current GoalRevision's applicable plan.
- Kind: acceptance dependency.
- Direction and cardinality: several unresolved Operations may affect one
  criterion; one Operation may affect several criteria. Each link is explicit.
- Perception: the Task detail and Organ Journal expose the unknown Operation,
  affected criterion, and reconciliation owner.
- Must have: committed identities for both endpoints and source evidence for
  the dependency.
- Must not have: an inferred dependency from similar wording, an unstructured
  model note, or a criterion from a retired GoalRevision.

Candidate closure rule:

- Allow successful Task closure when all acceptance criteria for the current
  GoalRevision are met and no unresolved Operation affects any of them.
- Deny successful Task closure when an affected unresolved Operation lacks a
  known result and an acceptance assessment. Use a non-success Task outcome
  with the reconciliation owner and recovery evidence.
- Allow successful Task closure after reconciliation when the resulting
  Operation evidence has been assessed against the current GoalRevision and
  all applicable acceptance criteria are met.
- Do not require a result from an Operation that is proven irrelevant to the
  current GoalRevision to block a successful outcome.

Delivery and acceptance are separate:

- Available results may be shown to the user without waiting for unrelated
  reconciliation.
- Showing the result does not create a success terminal. Only Core can commit
  the assessed Task outcome.
- A stale GoalRevision or a historical result remains readable, but it cannot
  count as evidence for the current Goal unless the Task owner has assessed it
  against the current GoalRevision.

Future executable candidate:

- Owner: Core owns the Task success decision. Runtime owns reconciliation
  coordination and Journal evidence.
- Gate: `terminal/relation` on successful Task closure.
- Legal case: a draft-review Goal is satisfied, and every earlier send
  Operation is settled or proven irrelevant to the review Goal.
- Illegal case: a draft-review Goal is satisfied, but an earlier send has an
  unknown result linked to the review acceptance criterion; success is denied
  until reconciliation.
- Real observation: a public Task view shows the outcome and uncertainty,
  while the committed Journal shows the GoalRevision, acceptance link,
  Operation result state, and reconciliation receipt.

This candidate currently has no executable gate. A GoalRevision chain and a
typed Operation-to-acceptance relation must exist before implementation can
enforce the rule. User approval of the semantics does not by itself establish
either capability.
