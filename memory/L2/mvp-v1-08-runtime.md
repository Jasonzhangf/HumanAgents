<!-- project-memory:v1 {"category":"plan","created_at":"2026-11-22T15:18:05.043261+00:00","entry_kind":null,"id":"mvp-v1-08-runtime","importance":0,"memory_level":2,"review_evidence":["用户逐条审批回执 revision 2：08 批准"],"review_status":"reviewed","rule_control":null,"source_refs":["memory/assets/mvp-ui-v1/ontology-confirmation.md","memory/assets/mvp-ui-v1/聊天界面审阅.html"],"tags":["mvp-ui-v1","ontology"],"updated_at":"2026-11-24T04:39:14.490568+00:00"} -->

# 任务关系与记忆 Agent

任务图从显式 runtime 关联隐式编排 runtime，各业务 Agent 关联自己的记忆 runtime。每个实例有独立 ID，可查看状态和会话，项目保留记忆入口。记忆 Agent 定期运行，也接受主动触发。它检查已记录的 session、文档和代码，提取和优化 skills 与项目记忆，按项目或全局作用域提交候选。用户审计通过后才写入对应库。

首条内部任务通信由显式 Agent 整理用户需求，将确认后的 `RequirementEnvelope` 交持久 FIFO。整个 HumanAgent 控制域共享默认 **8** 个可配置的隐式编排 runtime slot。下游角色另计。空位可启动独立隐式 runtime 并绑定实际任务。满额时原工单留队，等待 slot 释放。

用户可在 Settings 修改控制域并发上限。保存后实时生效，无需重启。Settings、调度和显式 Agent 的池查询读取同一个控制域限额真源。

显式 Agent 通过工具查看控制域预算、占用、空位及其有权查看的 idle 实例、现有任务和候选匹配。显式 Agent 可提出续用同一任务的既有绑定、复用合适的 idle 运行资源、开新实例或等待。调度时复核占用、能力和绑定。只有同一任务可沿用上下文。任何独立新任务均从新上下文开始。

来源：用户给定首条内部通信语义、默认并发和显式查询要求，并要求先入库。[闭环审计](/Volumes/extension/playground/humanagent/mvp-delivery-audit-20261122/通信架构审计-20261123/初始化与隐式编排闭环审计.md)
<!-- project-memory:end -->
