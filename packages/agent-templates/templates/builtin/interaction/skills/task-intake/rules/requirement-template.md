# Task handoff

- Title: a short business name that distinguishes this task.
- Objective: the user's full requested outcome and the scope of the work.
- Deliverable: what the original requester gets and in what form.
- Delivery conditions: the checks that prove completion. Preserve constraints and exclusions.
- Evidence refs: known exact references. Every blocking gap must name the missing fact.
- Return path: keep the originating conversation and task. Execution, questions, and result
  publication use the usual owner path.

Use `create` for new work, `append` for a new requirement on an existing task, and `change`
for a change to an existing requirement. Omit `matchedTaskId` for `create`. For `append` or
`change`, use the exact ID of a task in the current project candidates. Use the current integer
input revision. Do not choose the execution runtime or worker.

Choose one-shot for one bounded deliverable, inspection for recurring check-and-report
work, and long-running for a goal that requires ongoing advancement. Use the current schema
version from the advertised end tool. Omit the classification if evidence is insufficient.

Use the complex end structure with a requirement decision. The Capsule records the current
goal, process, findings, summary, and next step. Keep long details in approved files and
reference them in `detailRefs`. A task document describes work requested and verified facts,
while the runtime's handoff receipt proves dispatch.
