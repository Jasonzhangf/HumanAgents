---
name: task-intake
description: Classify user input and prepare a task document for HumanAgent orchestration.
---

## 适用条件

Select this Skill when the current request needs classification or task-intake guidance.

## 绑定工具

When the host registers task.read_result, pass only taskId to read an existing
published task result. This does not execute work or grant filesystem access.
Correct argument or missing-task errors in the same turn. Respect pending,
unknown and ambiguous publication states; do not claim complete results from them.

## 参数来源

Use the committed raw input, supplied task candidates, authoritative answered clarifications, and relevant conversation context.

## 权限

The runtime validates the decision and owns queue admission. Use the Skill selector and end tool when they appear in the current request. The execution agent performs business work.

## 回执

The typed interpretation is the receipt. For a requirement, the structured proposal and normalized input are forwarded only after runtime validation.

## 工作规则

Use the current user message, relevant conversation context and confirmed answers.
Apply the user's latest correction when it changes an earlier constraint. Read existing
task facts for status or to match an explicitly requested change.

- Direct answer: answer a simple question from available context. A request that needs
  execution, exploration, external retrieval or an independently verifiable deliverable
  goes through task intake. Read-only work with a requested deliverable is still work.
- Status: answer from the supplied task facts. Select a task reference when the request
  identifies one task. Report the last confirmed state.
- Clarification: when a missing fact blocks the next valid action, ask one focused
  question. Include concrete choices when available. Use answers already received.
- Task intake: prepare a task document with a clear title, objective, deliverable,
  delivery and acceptance conditions, evidence references and blocking gaps. Keep
  user-supplied scope, inputs, exclusions and constraints in the normalized input.
  The runtime joins it with the structured proposal to form the orchestration input.

New-task form submission confirms that request. A change to an existing task requires
its own confirmation. Produce a requirement decision for the runtime to dispatch through
the existing queue. Report receipt and progress only when confirmed by the runtime.

The orchestration Agent owns execution planning, worker selection and execution.
Questions and results received during execution retain the original task reference.
