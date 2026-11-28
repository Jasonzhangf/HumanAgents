<!-- project-memory:v1 {"category":"plan","created_at":"2026-11-23T02:24:29.184188+00:00","entry_kind":null,"id":"explicit-agent-context-tools-c05","importance":0,"memory_level":2,"review_evidence":["当前对话书面裁决 C05 批准"],"review_status":"reviewed","rule_control":null,"source_refs":["/Volumes/extension/playground/humanagent/mvp-delivery-audit-20261122/显式Agent上下文审计.html#ontology"],"tags":["c05","context-tools","explicit-agent","ontology"],"updated_at":"2026-11-24T04:33:23.503201+00:00"} -->

# C05 · Agent 寻址工具模块

Agent 的规范全名是唯一身份锚点。项目 Agent 使用 `machine.project.name`，唯一 CEO 使用 `machine.CEO`。注册、收发寻址、运行实例和会话归属均绑定该全名。内部 Agent ID、runtime ID、epoch、session ID 引用具体记录，并能回查所属全名。

首次初始化由操作者显式确认机器名和项目名并持久化。可用主机名和项目目录名预填。保留旧短地址作为输入别名，只有能唯一解析到规范全名时才受理。寻址携带来源作用域，并报告缺失、歧义或不可达。

整个 HumanAgent 控制域同时只有一个 CEO。原机器重启后，确认旧实例已退出方可在同一 `machine.CEO` 地址恢复。跨机器接管需要显式授权。别名不能单独注册第二个 CEO 或改变恢复归属。改名迁移规则另议。

来源：用户裁决「名字是唯一锚点：machine.project.name CEO 是 machine.CEO」及后续入库指令。[闭环审计](/Volumes/extension/playground/humanagent/mvp-delivery-audit-20261122/通信架构审计-20261123/初始化与隐式编排闭环审计.md)
<!-- project-memory:end -->
