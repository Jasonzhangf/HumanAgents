<!-- project-memory:v1 {"category":"plan","created_at":"2026-11-28T07:29:10.009561+00:00","entry_kind":"fact","id":"mvp-ontology-code-alignment-plan-20261127","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","rule_control":null,"source_refs":[".agents/skills/humanagent-mvp-ontology/appsdk-guidance.json","docs/goals/mvp-v1-semantic-gap-plan-20261122.md"],"tags":["code-alignment","mvp","ontology","plan"],"updated_at":"2026-11-28T07:29:10.009561+00:00"} -->

# MVP Ontology 代码顺序接入计划（2026-11-27）

已批准的 10 条 MVP Ontology 语义按三步顺序接入产品代码：1. mvp-v1-08-runtime：在 packages/config 与 orchestration-pool 绑定默认 8 个隐式编排并发 slot（下游角色另计，配置可改并实时生效）；2. c05 + mvp-v1-17 + mvp-v1-20：实现 machine.CEO / machine.project.name 规范全名寻址解析、禁止广播/跨项目误投及远端断连隔离；3. mvp-v1-03 + mvp-v1-16 + mvp-v1-04：实现双提示词模板复制、50 名字池分配回收、成员独立配置与按职责自动分派（无匹配交 Jenny）。
<!-- project-memory:end -->
