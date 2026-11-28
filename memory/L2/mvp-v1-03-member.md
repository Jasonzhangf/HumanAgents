<!-- project-memory:v1 {"category":"plan","created_at":"2026-11-22T15:18:04.751717+00:00","entry_kind":null,"id":"mvp-v1-03-member","importance":0,"memory_level":2,"review_evidence":["用户逐条审批回执：03 批准"],"review_status":"reviewed","rule_control":null,"source_refs":["memory/assets/mvp-ui-v1/ontology-confirmation.md","memory/assets/mvp-ui-v1/聊天界面审阅.html"],"tags":["mvp-ui-v1","ontology"],"updated_at":"2026-11-24T07:00:13.899364+00:00"} -->

# 成员配置与寻址

成员以 [C05](explicit-agent-context-tools-c05.md) 的规范全名通信和绑定任务。任务的归属锚点是 `machine.project.name`。同一名字在原项目由新的 Agent 接替时，历史任务仍归该地址，由当前 Agent 接手。新旧 Agent 的独立 ID、运行代次、会话和历史行为分别保留。正在运行的旧实例须先通过正常生命周期收拢，接替后不能以旧实例身份提交。另一项目复用同一个短名字时，已有任务仍在原项目地址；跨项目转交走现有授权路径。

项目成员展示为 `role:name`，其中角色可变，名字和规范地址继续对应同一任务归属。当前用户选择的角色是 `architect`、`reviewer`、`tester`、`specialist`、`manager`（固定 Jenny）和 `executor`。普通 worker 默认 `executor`。可配置成员角色提示词、provider、model，支持不同成员同时展开会话。

用户可在项目 worker 的右键菜单进行角色变更和成员 CRUD。角色变更经过目标角色模板和权限核准，保持原名字与当前 Agent ID。新增与删除使用 [V1 16](mvp-v1-16-template.md) 的共用名池语义。

来源为本轮用户对角色、名字池、复用和任务接替的书面裁决。运行时执行绑定与正负门禁仍待验证。
<!-- project-memory:end -->
