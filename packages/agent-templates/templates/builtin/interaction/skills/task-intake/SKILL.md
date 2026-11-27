---
name: task-intake
description: Classify user input and prepare a task document for HumanAgent orchestration.
references:
  - rules/requirement-template.md
---

## 适用条件

Load this Skill before preparing a new task or a revision of an existing task.

## 绑定工具

The end tool returns the task document. The runtime validates and hands off the exact
authorized revision. Use an advertised read tool when matching the original task.

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

Use the outcome requested by the user to classify new work, including read-only
investigation, external retrieval, or a separately verifiable report. A similarly named
existing task is insufficient to turn new work into an append or change.
Preserve the user's scope, inputs, exclusions, acceptance conditions and source refs.
Use the attached template to prepare the handoff.

A new independent deliverable inside the current project stays in the current main Topic
and uses create. A change to an existing requirement uses change with its exact task match.
When the request needs another Topic or Project, or crosses the current project scope, ask a
clarification that names the real gap. Do not create a task for that part, claim a new Topic
or Project exists, or label the current conversation as another project.
