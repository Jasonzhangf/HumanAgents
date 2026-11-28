<!-- project-memory:v1 {"category":"plan","created_at":"2026-11-22T15:18:04.703387+00:00","entry_kind":null,"id":"mvp-v1-02-identity","importance":0,"memory_level":2,"review_evidence":["用户逐条审批回执：02 批准"],"review_status":"reviewed","rule_control":null,"source_refs":["memory/assets/mvp-ui-v1/ontology-confirmation.md","memory/assets/mvp-ui-v1/聊天界面审阅.html"],"tags":["mvp-ui-v1","ontology"],"updated_at":"2026-11-24T07:30:08.186948+00:00"} -->

# 唯一显式入口与身份

无项目时唯一直接暴露的显式 Agent 是 CEO，历史界面称 Alex。每个项目恰有一位 Jenny，同时是该项目唯一 manager 和显式 Agent。CEO 和 Jenny 的规范身份详见 [C05](explicit-agent-context-tools-c05.md)。

项目 Manager 对项目目标、任务分配、解阻和交付负责。任务按规范名字归属，runtime 是可恢复或替换的执行实例。runtime 下线时，未结任务随原名字暂停，已结束任务保留终态。失联和效果未知须核实，不能认作空闲或成功。已授权沿用的同名接替保持任务归属，改派才转换归属。任务状态、名字归属、运行可用性分别可读，工作执行与变更由 Runtime 按权限和代次提交。Manager 须主动推动未结任务，在原入口回交，超时不等于新的授权。

稳定职责进入角色提示词，事件触发、处理顺序、工具参数和错误分支由 Manager Skill 持有。执行工具仍须由运行时实际注册和授权。具体流程见 [任务分配](mvp-v1-04-dispatch.md)。
<!-- project-memory:end -->
