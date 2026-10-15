# Task Types, Templates, and Cycles — UX Design

Status: **DESIGN-CANDIDATE**. This document extends [the UX core framework](./ux-core-framework-2026-10-10.md); it describes intended interaction and does not claim that the browser UI or end-to-end flow is implemented or accepted.

## Goal and scope

Let a person state what continuing relationship they want with a task, understand what the system will do next, and distinguish the task's durable goal from each execution and its evidence. This design covers three task patterns: a single task, a timed inspection, and a long-running goal. It covers choosing a reusable template, publishing a concrete plan revision, first submission, occurrence/cycle/result display, pause/resume/next-cycle controls, and read-only observation.

The terms “single”, “inspection”, and “long-running” describe the user's intent and expected lifecycle. They are not aliases for scheduler `executionMode`. In current contracts, `ExecutionPolicyDefinition.executionMode` is `once | scheduled | recurring`; it describes when an execution is eligible to start. Keep this trigger policy independent of task pattern, so (for example) a long-running goal can be manually continued, event-triggered, or scheduled without changing its identity.

## Concepts the interface must keep distinct

| Concept | User-facing meaning | Domain boundary |
| --- | --- | --- |
| Task pattern | What kind of ongoing work the user intends: finish once, inspect at chosen times, or pursue a goal across continuing work | Proposed product classification. `Task` currently has no `taskType` field; don't infer it from schedule fields. |
| Trigger policy | When a new execution is eligible: one due time, a scheduled start, or a recurring frequency | Existing policy vocabulary: `ExecutionPolicyDefinition` in `packages/contracts/src/explicit-brain.ts`. Trigger and control truth remain outside business payload. |
| Template skeleton | A reusable starting structure: suggested goal framing, required information, deliverable shape, and applicable stages | Reusable guidance only. Selecting one does not create a task or authorize execution. The existing `packages/agent-templates` are agent-role templates, not these task templates. |
| Published TaskPlan revision | The immutable, task-specific plan accepted for execution, including its goal/scope/constraints/deliverables and applicable policy | Product concept to specify. Existing `DraftRevision` already carries goal, scope, constraints, deliverables, optional policy, version and hash; no dedicated published `TaskPlan` type or user-facing revision history is evidenced here. |
| Occurrence | One scheduled time slot, with its own due time, ordinal, and settlement status | Existing subscription domain record. An occurrence is not a whole task or a task cycle. |
| Cycle | One bounded execution pass against a task revision, with its own lifecycle, execution epoch, checkpoints, and outcome | Existing `Cycle` contract and checkpoint scope. A cycle can be associated with an occurrence, but the identities must not be merged. |
| Operation | A concrete unit of work or side effect within execution, with its own state and evidence | Existing `Operation` contract. It does not prove the task or occurrence succeeded by itself. |
| Attempt | A particular try to perform an operation or cycle work, including failure and retry history | The exact public attempt projection is not established by the cited UI contract. When absent, show “attempt history unavailable”; never derive attempt count from events or cycles. |

## Choosing a task pattern

Present three plain-language cards before optional configuration. Each card states what is retained, what causes another execution, and how the user will know the work is done.

| Choice | Explain to the user | Initial configuration |
| --- | --- | --- |
| **Do this once** | “Work toward this result once. It finishes with a result or a clear blocker.” | Goal, scope and deliverables. If a future start is requested, ask for its time separately; otherwise start according to the product's explicit immediate-start policy. |
| **Inspect on a schedule** | “Run this inspection at the times you choose. Each run gets its own result; skipped, missed, or waiting runs remain visible.” | Inspection target, expected findings, schedule/time zone, end or occurrence limit when desired, busy/late behavior where relevant. A run is one occurrence and normally one bounded cycle. |
| **Keep working toward a goal** | “Keep this goal and its accepted plan. Work may take several cycles; each cycle records progress and what should happen next.” | Goal, scope, completion conditions, checkpoint cadence or continuation condition, and who/what may authorize continuation. Scheduling is optional and configured separately. |

Do not ask users to choose a raw `executionMode` as a proxy for intent. If a product surface must expose trigger configuration, phrase it as a separate question: **When should work start?** Choices and controls must be supported by the authoritative policy/allowed-actions projection. Do not invent an event trigger until its owner and contract exist.

Template choice fills a draft, not a task. The draft can be edited before publication. Show which parts came from the template and which were supplied or changed for this task only when that helps the user review the result; do not expose prompt files, agent role internals, hashes, or raw policy fields in the main path.

## New task: review and one confirmation

1. The user chooses a task pattern, enters the goal, and optionally starts from a template. Ask only for information needed to make the plan reviewable and executable.
2. Show a preview with the task name, goal, boundaries, deliverables, expected completion/continuation behavior, and (when applicable) trigger summary with time zone. Clearly label it **Preview — not submitted**.
3. Let the user revise ambiguous or incorrect details in place. Editing produces a newer draft revision; a stale preview must not be submitted as the current plan.
4. The final action states the consequence, e.g. **Create task and start once** or **Create inspection and activate schedule**. This one submission is the user's confirmation of this new task. Do not add a second confirmation step. Existing tasks' goal, scope, or handling changes remain a separate confirmed change.
5. After submission, show the accepted task and current plan revision, then its actual lifecycle state and next expected action. A click, preview, or successful API response alone is not proof that execution finished.

This flow follows the contracts in `packages/contracts/src/explicit-brain.ts` (`DraftRevision`, preview receipt, `DraftConfirmation`, `FinalSubmit`) and the project rule that a new-task form submission is confirmation and FIFO enqueue. The exact preview-to-persisted-plan consumer path still needs production verification; the types alone do not establish that UI behavior.

## Task detail and results

The default task view answers, in this order: **What is the goal? What is happening now? What did the latest completed work establish? What happens next? Is my decision needed?** Keep lifecycle state, schedule state, and run result separate.

- The task header identifies the stable task goal and current accepted plan revision. If viewing an older revision, label it as historical and keep runtime current refs visible separately.
- A scheduled inspection shows the next due time and time zone, plus recent occurrences with due time, outcome, and result/evidence availability. A skipped or invalidated occurrence is a visible outcome, not an empty history row.
- A long-running task shows completed cycles in order, each with its plan revision, checkpoint summary, evidence, and next action (`continue`, `wait`, `stop`, or `recover`) when supplied by the authoritative checkpoint. Do not convert a checkpoint summary into a new plan revision.
- Within a cycle, show operations under their owning cycle and show retries/attempts as separate events only when their typed source and identity are available. Keep failed attempts and their recovery responsibility visible; a later success must not erase them.
- Present the latest task/occurrence result only from the terminal and settlement evidence owned by the runtime. A provider response, operation result, or “currently active” animation is not task success.
- Keep IDs, hashes, raw records, and protocol payloads in deliberate evidence details. Link to evidence using real task/cycle/occurrence/operation scope; never construct a link from display order.

## Continuing, pausing, and starting another cycle

For a long-running task, **Continue** means “request the next authorized cycle from the current accepted plan.” It must not silently edit the goal, scope, or plan. If the next cycle needs a changed goal, scope, or handling, route that as an explicit proposed change and obtain confirmation before publishing its new revision.

For scheduled inspections, **Pause schedule** and **Resume schedule** affect future unclaimed occurrences. They do not imply that an already claimed occurrence or in-flight cycle was stopped. **Cancel future runs** likewise does not silently stop work already in progress. If the user wants to stop an active operation, use the standard stop flow and show it as complete only after stop settlement and side-effect outcome are recorded.

After a cycle ends, show **Start next cycle** only when the authoritative state permits it. If the task is waiting, blocked, stale, exhausted, cancelled, or requires recovery, show the actual reason and its permitted action instead. A “next cycle” request starts work through the normal lifecycle; observation controls never dispatch it.

## Empty, unknown, and recovery states

- **No tasks:** explain the three patterns in user language and offer the task creation entry. Do not display zero-value charts or fabricated percentages.
- **No runs yet:** distinguish a newly created task awaiting its first trigger from an inspection with no due occurrence yet and a long-running task awaiting its first cycle.
- **No result:** say that no terminal result is available. Keep the task/cycle/occurrence state and next action visible.
- **Stale or disconnected:** retain the last known facts with a stale/sync time label. A connection loss is not a task failure.
- **Unknown or legacy task pattern:** display the known title, directive, lifecycle, and available evidence. Label the pattern “Not declared”; do not infer it from a schedule, task name, template, or current cycle. Hide unsupported type-specific controls.
- **Unknown future type or policy:** preserve and display the raw value only in technical details; present “This task type is not supported in this view” and its known status/evidence. Do not coerce it to single, scheduled, or long-running, and do not offer controls that cannot be validated by the owner.
- **Recovery needed / unknown outcome:** state what may have happened, which action/evidence remains unresolved, and the supported recovery path. Keep user-entered content when asking for correction. Never label a missing result successful or automatically retry a side effect with uncertain completion.
- **Occurrence skipped, late, or superseded:** show the occurrence's recorded reason and policy outcome. Do not imply that pause/resume or a new schedule revision rewrites its history.

## Read-only observation boundary

Task detail, cycle history, occurrence history, operation detail, and the semantic/action/raw observation modes are read-only. They may navigate, filter, expand evidence, and change the viewed task/revision/cycle/occurrence. They must not submit requirements, publish revisions, alter schedules, retry operations, create a cycle, or steer/stop execution. Put those commands in their owning task controls, derive availability from lifecycle and `allowedActions`, and keep control outcomes distinct from business payload and logs.

## Evidence and implementation gap

**Design input and existing capabilities:**

- [UX core framework](./ux-core-framework-2026-10-10.md) is marked DESIGN-CANDIDATE; it defines current/semantic/actions/raw viewing, separates viewed references from runtime-current references, requires typed projections, and limits observation to read-only behavior.
- [`Task`, `Cycle`, and `Operation`](../../packages/contracts/src/index.ts) are separate domain interfaces. `Task` currently has no type or published-plan history field.
- [`ExecutionPolicyDefinition` and subscription controls](../../packages/contracts/src/explicit-brain.ts) model once/scheduled/recurring trigger policy and confirmed schedule modification separately from the draft goal/scope/deliverables.
- [`Subscription` and `Occurrence`](../../packages/contracts/src/framework.ts) provide a schedule revision, occurrence ordinal, due time, and occurrence state.
- [`packages/app/src/ui-runtime/index.ts`](../../packages/app/src/ui-runtime/index.ts) assembles a subscription journal/control port and dispatches claimed occurrences through the runtime service. This is source-level wiring evidence, not proof of the browser flow or all recovery cases.
- [Scheduler recovery design](./scheduler-recovery-design-2026-10-04.md) records unresolved consumer/recovery and settlement risks. Do not present its planned behaviors as accepted production behavior.

**Not established by this inspection:** a declared three-pattern task classification; task-template registry for these three patterns; a dedicated immutable published `TaskPlan` revision/read-history contract; user-facing plan revision history; a typed attempt projection; rendered create/detail/control flows for all three patterns; and browser/runtime acceptance for the above user outcomes. The UX core framework also records occurrence-result projection as partial and identifies open schedule-recovery risks. These are implementation/evidence gaps, not reasons to misrepresent existing `agent-templates` or backend wiring as UX completion.

## Focused acceptance scenarios for a later UI implementation

1. Create one single task from a template, revise the preview once, submit once, and verify the displayed accepted revision and actual result lifecycle.
2. Create a scheduled inspection, inspect its next due time and one settled occurrence, then pause/resume future occurrences while confirming an in-flight occurrence remains accurately represented.
3. Create a long-running goal, complete one cycle, inspect its checkpoint and next action, then start a permitted next cycle without changing the accepted goal or plan revision.
4. Open an older plan revision and a legacy/unknown task; verify historical/current labels, no inferred task type, and no unsupported controls.
5. Exercise empty, stale, skipped, failed, and recovery-required states; verify observation remains read-only and no missing result becomes success.

These scenarios are future acceptance criteria, not executed test results.
