<!-- project-memory:v1 {"category":"plan","created_at":"2026-11-22T15:20:33.273432+00:00","entry_kind":null,"id":"mvp-v1-16-template","importance":0,"memory_level":2,"review_evidence":["用户逐条审批回执：16 批准"],"review_status":"reviewed","rule_control":null,"source_refs":["memory/assets/mvp-ui-v1/ontology-confirmation.md"],"tags":["mvp-ui-v1","ontology"],"updated_at":"2026-11-24T07:00:15.972329+00:00"} -->

# 按模板新增成员

在项目成员区选模板、新增具名成员。模板分别提供系统提示词（共同工作约束）与角色提示词（岗位职责）；创建时复制为该成员的配置，可独立编辑两层及 provider、model。编辑成员只影响本人，重名时保留原成员并提示。

同一 HumanAgent 控制域共用一个由 50 个普通 worker 名字组成的有序池。新增 worker 默认是 `executor`，按池顺序取第一个可用名字。Jenny 保留固定名字，不占池。删除并完成收拢后，名字回到池中，下一次分配可复用；新 Agent 获得独立 ID。任务接替与历史保真沿 [V1 03](mvp-v1-03-member.md) 的规范地址语义。

来源为本轮用户确认控制域共享分配顺序、名字可回收和任务按名接替。跨项目、跨进程分配须经同一控制域权威，避免同一个可用名字被领两次。
<!-- project-memory:end -->
