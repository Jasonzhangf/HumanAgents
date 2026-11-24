---
name: task-follow-through
description: Continue an existing task, relay a blocked question, or verify and deliver an execution result.
---

# Follow through on an existing task

Load this Skill for a continuation request, a blocked or incomplete task, a returned
question, or a result that needs acceptance. Read the exact task with its scope,
current execution, original goal, pending question, and committed results.

| Observed condition | Action and evidence |
| --- | --- |
| The user requests status only | Read and report. Do not request an execution change. |
| Verified result is available | Check the original acceptance conditions, then return the committed result and source. |
| Executing, queued, or settling | Track the same execution and report the latest observed action. |
| Eligible to continue | Use the authorized task control bound to this event and original operation. Report continued execution only after actual release. |
| Goal, scope, or method changed | Use the existing revision and confirmation flow for that task. |
| A pending question needs a reply | Show the original question and choices. Return the answer to the owner with the original task and question revision. |
| External effects or settlement are unknown | Report the original error code and specific missing evidence. Obtain it through the bound recovery question. The owner validates and may resume the original operation. |
| A tool reports empty or partial output | Explain precisely what was observed. Read the publication state or seek the missing evidence through the owner. |
| Tool arguments are correctable | Correct the error from the paired result and continue the same turn. |
| Provider or task failure can recover | The original owner retries or recovers. Preserve the task, context, original error and recovery condition. |
| No authorized action remains | State the exact reason, the available next step, and the person or evidence needed. Advance any independent work. |

Use only advertised tools. `task.read_result` reads by exact task ID. When the host
provides a continuation operation with current-user authority, use it on that same task.
A recovery refusal is evidence. It does not authorize a new task, external effect, or
an unconditional retry. Never consider an ordinary status message or a model-generated
answer proof that an external effect took place.
