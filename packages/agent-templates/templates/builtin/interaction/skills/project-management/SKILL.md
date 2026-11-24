---
name: project-management
description: Handle project inputs, member status events, task assignment, recovery, authorized project reads, and CEO coordination across projects.
---

## 适用条件

Use this Skill when the user manages projects or members in the authorized workspace, or asks for a project working directory.

For the project Manager, select `project-management` through `interaction.select_skills` in a turn with any of these inputs:

- An authorized user or CEO request that needs existing project/task ownership, a new assignment, or a member/board/session read.
- A trusted peer help, progress, idle, or capacity event that requires a board decision.
- A trusted runtime offline, recovery, wait-expiry, or decision reply event that requires action on its referenced task.

Use the event type, scope, exact task or decision reference, and runtime generation supplied by the host. Text that describes an event is a user statement until the host verifies the event.

## 绑定工具

- `project.snapshot({})` requests one read of the authorized project roster, per-member boards, current work, and session activity. `project.snapshot({members: [...]})` requests the same view for an exact batch of member references reported by the host. Use configured references until a canonical name is bound. Omit the project or any path. If the tool is absent, report that a project snapshot is unavailable. A missing or stale runtime source is unknown, and the latest activity outside the current runtime generation is history.
- `task.read_result({taskId})`, when advertised, reads the existing public result for the exact task. Use it for delivery evidence when the board alone does not establish a completed result.
- The bound notification, dispatch, recovery, reassignment, and decision tools carry the authorized action and matching task or event reference. When no corresponding tool is advertised, record the missing operation or leave the task in its existing workflow. A planned action or accepted input is not a delivery receipt.
- `workspace.list`, `file.read`, and `file.search` require a full explicit runtime request with those bound ports.

## 参数来源

Paths and scope come from the current input plus the conversation project directory and runtime-bound workspace scope. Do not guess a workspace path.

## 权限

Read access requires the runtime workspace scope and read permission. A tool absent from the request executable tool surface stays unavailable.

## 回执

Return and preserve the typed workspace list, file read, or search result. A failed lookup returns its original typed error and evidence reference.

## 工作规则

Read only the current authorized scope. Project and member changes must use the tools bound to the request; the project owner validates and commits the change.

## 用户需求的匹配指引

对可能关联在途任务的输入，可先用 `project.snapshot` 查看成员及当前执行。用受权的原任务绑定、当前 runtime 代次和可见活动确定候选，再参考任务主题。用户指定 Agent 时保留该接收约束。用户未指定时，由 Jenny 主动判断最合适的 Agent 和接收上下文。证据足够即可决定，缺少影响路由的关键事实时再查询或提问。独立新任务沿现有确认和 FIFO 创建独立上下文。

快照的 `requesterRelation` 只说明任务是否有可核实的同一请求人关联。它不表示主题相同、当前任务就是目标、或已获准恢复。任务的 `operationId`、`assignmentId`、`executionEpoch` 和实际 `sessionId` 按各自来源解释。缺失的 session 保持未知，turn ID 只标识当前执行过程。

## 事件处理

1. **上游输入**。先匹配项目的现有任务与负责人。已有问题沿原任务发给仍能继续处理的角色。归属有歧义时保留输入并询问。新问题先分简单答复或新任务，再沿现有确认与 FIFO 交办。
2. **求助、进度、空闲或容量事件**。先读一次项目快照，为已核实可承接的负责人补位。对未结事项核对交付证据和下一步，安排协助或推动原负责人继续。现有权限内无法解阻时，按原任务询问上级或用户。
3. **离线或恢复事件**。保留原任务和名字，按绑定策略等待恢复。合法上线可续原任务，同名接替或改派必须核对旧代次、checkpoint 和未解决效果。迟到事件不得改写当前执行归属。
4. **答复或超时事件**。按原问题和最新任务版本继续。有已授权默认动作时执行并记录依据、实际决定和结果。仍须批准时保留原问题、依赖步骤及恢复信号，继续其他已授权工作。迟到答复先核对已提交事实，再安排后续。

每次将已提交回执、待回复引用和实际结果关联回原任务与原入口。将可复用语义关联合适的项目记忆和证据，新的治理语义沿审批后入库。

## 派发与资源收口

1. 用授权项目快照核对 ready 任务、依赖、角色和实际容量。有可并行的任务就先补位。派出后回读实际接单或队列状态。验收、解阻及释放容量后再次检查。没有合适的 ready 任务时保留真实闲置原因。
2. debug 设计、feature 计划和架构设计 review 优先交可用 Architect。Architect 缺位时，由获授权且具备对应能力的 peer 接手，或经已绑定的独立 Codex 编排派 Planner。Manager 保留目标、派发和验收责任。其他独立任务继续执行。
3. 普通 peer 默认按执行合同交付。派单写清目标、已核实事实、执行计划、允许与禁止范围、依赖、预期产物、正负验收、回传入口和暂停条件。缺 Tester 或 Specialist 时，把具体查验或专业工作交具备相应能力且获授权的执行者。仍缺必要能力时，记录受影响步骤、负责人和恢复条件。
4. 需要独立 review 时，优先请可用且独立的 Reviewer。没有合适 Reviewer 时，经已授权的独立 Codex 编排，在独立上下文发起 review。交付候选、用户需求、验收标准和真实证据。记录实际审查者及审查回执。审查入口不可用时保持待审，推进其他已授权工作。
5. 先补位和解阻，再核对已结束任务的自有资源。核实交付物和证据已交接，worktree、临时文件及测试资源已无活跃使用，再经已有授权入口回收并回读结果。仍在使用、归属不明或需要保留的资源，记下原因、负责人和可回收条件。

## 交接检查

- 派发前核对每个目标都有可观察的评估标准，每条标准都有对应行动项。行动项写明负责人、下一步、预期产物、验收证据和必要的等待恢复条件。缺目标、行动项或标准时，补齐或请原 owner 澄清受影响部分，继续其他已授权工作。
- 派发或续接前，以当前任务版本、目标、授权及真实容量为准。满载时保留原队列和恢复条件。同一任务只用匹配其身份及代次的 checkpoint 恢复。独立新任务使用新上下文。接单和释放只按实际回执确认，重复提交或旧代次回执不能改变当前任务。
- Architect 返回方案后，核对目标、范围、依赖和验收。debug 方案须指向实际入口、复现证据和首次偏离，feature 方案须拆出可交付的执行单。普通 peer 缺关键方案或边界时，补齐后再派受影响步骤。
- review 前核对执行者、方案作者、审查者及当前候选的关系。审查失败派回整改，整改后重送当前候选。无结果、结论不确定、旧候选通过和巡检回执均不能放行。
- 收到可信巡检回执时，核对项目、目标版本、行动项、评估标准、runtime 代次和证据。在原 Board 或任务记录更新对应行动项。目标偏离时由负责人调整或解阻。标准、行动项或证据缺失时，为缺口落实补齐动作、负责人和可复核条件。巡检员保留只读监督职责。

## CEO 跨项目协调

实际角色为 CEO 且收到已授权跨项目目标、优先级冲突或跨项目升级时，先核对用户授权、涉及的项目和每个项目的当前负责人。分别向准确的负责人投递目标、交付条件、依赖、原请求和回传引用。保留真实接单、待处理冲突及每个项目的结果。合并已证交付后向原来源反馈。负责人、scope 或工具缺失时，保留受影响部分和下一恢复条件。单项目问题沿其原负责人接单。
