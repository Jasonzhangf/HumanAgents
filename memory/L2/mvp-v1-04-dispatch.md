<!-- project-memory:v1 {"category":"plan","created_at":"2026-11-22T15:18:04.807485+00:00","entry_kind":null,"id":"mvp-v1-04-dispatch","importance":0,"memory_level":2,"review_evidence":["用户逐条审批回执：04 批准"],"review_status":"reviewed","rule_control":null,"source_refs":["memory/assets/mvp-ui-v1/ontology-confirmation.md","memory/assets/mvp-ui-v1/聊天界面审阅.html"],"tags":["mvp-ui-v1","ontology"],"updated_at":"2026-11-24T07:30:08.397951+00:00"} -->

# 自动分派的默认决定

建议对自动分派先匹配本项目已配置的对应职责，无匹配者交回本项目 Jenny 接收协调；保留手动指定地址。多个同职责成员的排序暂留实现阶段。

Space 把授权上游输入、peer 求助和框架状态变化交给 Manager。上游先匹配现有项目与原任务，能继续处理的角色沿原任务接单。新问题区分简单问答和独立任务，后者语义整理后进入原确认与持久 FIFO。状态和求助事件检查 board、可用负责人和交付，优先补位，查未结原因并解阻。离线按配置等待、恢复、同名接替或改派。需上报的问题使用原任务和问题 ID，期限到达时执行已授权默认动作或继续其他独立工作，保留决定、事实和原问题回复入口。

Manager 通过单次只读 `project.snapshot` 查询授权项目所有成员的 board、当前任务、运行可用性和最新可公开会话活动，可用规范全名列表缩小到一批成员。作用域由 Manager 身份确定。来源缺失或换代时保留处置原因和最后可信时间，旧 runtime 活动只属历史。工具触发、参数、未绑定端口的行为和回执由既有 `project-management` Skill 持有。

来源：用户审批的 Space 事件、Manager 决策及单命令快照 DAG，和本轮提示词/Skill 分工裁决。执行接线和正负门禁以项目候选的实际证据为准。
<!-- project-memory:end -->
