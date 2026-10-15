# 双大脑分流、动态编排与任务模板续推设计

日期：2026-10-11（America/Los_Angeles）  
状态：USER-REQUIREMENTS-RECORDED / DESIGN；不是运行实现声明。  
需求绑定：项目 `.appsdk/requirements.json`，`requirements_version: 13`。原文、变更与撤回解释均保留；最新用户决定优先。

## 1. 显式大脑先分流

显式大脑处理多方面输入，并决定本次是简单问答还是需要派发的复杂问题。

- **简单问答：**显式大脑直接形成并返回答案，此次交互可结束。不创建业务任务，不要求用户填写 goal/交付物，不调用长程编排或额外 Planner。
- **复杂问题：**整理成标准任务模板，经既有确认/FIFO/准入路径派发。新建表单提交本身就是该新任务的确认，不增加第二次确认；已有任务目标/范围变更仍按原确认合同。

显式 context 使用前序任务/交互语义 checkpoints＋最新 turn 完整语义。简单问答的答案与交互语义沿正常历史路径保留；任务的四项 checkpoint/Planner 迭代不能机械套到一次普通回答。

## 2. 标准任务模板是复杂执行与续推的同一依据

沿用已确认任务的目标、范围、约束、交付物、完成/验收要求和对应身份/revision。任务模板是业务派单，不是 role prompt 模板，也不是一套预先固定的角色 DAG。

显式大脑派单时提供该模板；Runtime 初次执行或恢复时按任务真相装配同一模板，不让模型从标题或缺失 context 中猜目标，不创建第二份续推目标。实际字段继续引用现有 DraftRevision / TaskPlan / WorkAssignment 合同；本设计不新增同义 public 字段。

## 3. 隐式大脑：预算内 N 个独立编排实例

Harness Runtime 按预算准入 N 个实例，每个实例独立绑定目标/任务、语义 checkpoint 历史、最新 turn 完整 context、在途 assignment 和 Provider/model。子调用也占预算。实例间不共享可写活动 context。

编排者具有读写能力，但主要依赖角色 agent 执行工作，接收精炼结果、产物与必要证据。父编排者保留自己的完整决策 turn；子 agent 完整活动留在自己的证据归属，不复制成父 context。

## 4. 角色选择动态，调用 checkpoint 与 turn 收口分开

探索、plan、execute、review 由编排者自主选择，可多次、交错或在真实依赖/预算允许时并行。不存在“做过某个角色一次就必须进入下一角色”的固定边。Plan 结果由编排者核实适合性；Review 结论与未解决责任保留，不强制每次执行马上 review。

每次 subagent 调用有 checkpoint 边界，记录目标/阶段、assignment/attempt/epoch、明确输入/交付与未返回责任。调用 checkpoint 不关闭当前 turn。

结果回来后分别裁决：哪些语义接受入 checkpoint；阶段性任务和判断是否充分，可以收口当前 turn。可以已有足够判断而仍有其他调用在途，但必须保留这些调用与恢复义务。

每个 role agent 具有独立 context，不继承/fork 父活动上下文，可以独立使用不同 Provider/model。沿既有 WorkAssignment/WorkResult 身份与证据边界交付；子任务返回不自动关闭父任务。

## 5. 复杂任务的 turn 收口与持续执行

复杂任务的标准 turn 收口为压缩、总结、交付，并持久保存 checkpoint/closure；四项语义是：目标是什么、做了什么、结果是什么、下一步预计做什么。之后由独立 Planner 对齐和计划下一轮，编排者核实并继续动态选择行动。

完成一个阶段 turn 不等于完成整个任务。任务仍未完成则继续；任务完成或明确失败后停止运行。Provider finish reason、角色返回、一次 checkpoint 或一句“完成”均不能代替任务真相。

这条长程规则只适用于已派发的任务路径，不能用“没有复杂 goal、四项总结或交付物”强迫简单问答继续。简单问答正常回答即可结束。

## 6. 停止判断不再使用重复 control block

用户已明确撤回此前的模型 `is_simple_qa` / `task_complete` 布尔标签控制块。历史原文留在需求库，当前设计不实现、不读取该块。

问题类型来自显式大脑的分流。任务完成来自 Core/Runtime/Journal 的实际生命周期与完成事实；显式大脑可查询并呈现状态，但不成为第二个生命周期 owner。

复杂任务请求返回时按既有任务真相处理：已完成/明确失败则结束；未完成则继续推理或经正常 turn 收口进入下一轮；错误/未知则按恢复责任处理。不让模型反复分类，也不从业务正文、metadata 或日志重建控制状态。

## 7. 根据显式派单模板进行临时续推

续推指令通用地要求重新 orientation：读取显式大脑派单模板、对照当前工作与结果、找到未满足要求并继续完成。不依赖固定 `current_goal` 等字段，也不要求简单问答有复杂派单数据。

模板由 Runtime/Context owner 根据该任务的已确认输入装配；缺失时恢复或报告缺口，不能编造目标。提示词见[临时任务模板续推设计](turn-continuation-prompt-template-2026-10-11.md)。

临时续推指令只进入本次推理，不写规范 history/checkpoint/后续 context。原业务派单模板继续按既有规则装配与保留；不能把任务依据和临时指令混成一份持久 payload。

## 8. 错误 retry 后暂停与同 turn 恢复

错误可以按现有预算/策略多次 retry，未指定固定次数。多次仍不能继续可暂停；暂停不等于已结束 turn 或已完成/失败任务。

保留当前 turn 身份、完整活动 context、部分动作/交付事实、在途 assignment、副作用与恢复责任。恢复原 turn 和未完成位置；请求/attempt 可以变化，不重做已确认完成的副作用，不偷偷创建新 turn。

## 9. 标准探索模板

被选择探索时，任务至少说明：当前问题与目标、合法输入/证据引用、真实入口与 scope、allowed/forbidden 范围、资源和返回条件、预期交付，以及足以让编排者作下一判断的证据。

交付包含精炼事实/结论、适用条件、来源、确定程度、未知与下一步建议；不以探索数量凑完成。模板 owner 是既有 packages/agent-templates，运行 assignment/result 仍由 contracts/runtime 管理。

## 10. 唯一 owner 与当前落地边界

Core 管 Brain 规则、生命周期、义务与恢复许可；Runtime 管显式输入整理与分流组装、隐式准入、N 实例、上下文、派发、收口和恢复；JSONL Organ Journal 管权威历史；Provider adapter 管独立协议与请求编码；Context owner 管规范历史和有效输入装配；UI 只读投影；App 只组装公开入口。

新增设计仍未证明生产接线。原图册地址继续有效：图 01/16/24/27 展示显式分流与停止；图 22 展示动态控制循环；图 26 展示任务模板与临时指令隔离；图 23 展示真实调用依赖 DAG。控制循环不是可编译静态 DAG，实际 assignment 依赖是 DAG。
