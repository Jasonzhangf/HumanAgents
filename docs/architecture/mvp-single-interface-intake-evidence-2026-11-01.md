# MVP 新任务输入：同一界面与审批证据

范围：用户本轮明确要求新任务不需审批，交互过程无需跳转；用户可主动点击进度卡查看详情，理解不清时可 ask。记录为静态源码与历史回执核查，不冒称本轮已跑真实任务。

## 已确认

- `docs/ui/entry.js:1084-1129` 接收输入、处理 clarification、解释输入；直接回答分支显示结果，不创建任务。源码上，新任务分支在同一次用户提交处理中调用 confirmation API，内部确认不自动等同额外用户审批。
- `docs/ui/entry.js:739-768` 在获得已提交任务身份后调用 `window.location.assign(submittedTaskLandingHref(...))`。这与用户要求的提交后留在唯一交互界面的目标存在源码层差异。另建 bug `8a4ab78`；本轮没有在共享运行实例提交任务，故未声称当前实例已复现。
- `tests/app/dashboard-e2e/lib/browser.mjs:1018` 起将任务页面导航作为提交成功信号。历史 web-search 的 `evidence.json` 显示 `submittedOnce: true`、Task `succeeded`、settlement `settled`，支持该次完成了单次提交和执行；不能证明本轮提出的停留原界面要求。
- `tests/app/dashboard-e2e/lib/browser.mjs:1327` 的 `approvePendingTaskGrant` 在已有 grant/执行时提前返回；但若看到待授权决策，`:1432` 之后会向 task grant API 发 POST。因此测试辅助逻辑允许代用户授权，不能仅凭该测试 SUCCESS 推断从未出现额外审批。本次 web-search 的详细 grant disposition 未核实，不能断言该次实际执行了人工授权。
- `docs/dagpipe/explicit-requirement.graph.json:48-50` 同时记录单次提交与草稿/修订/确认链。源码确认后者可作为内部状态；是否压缩要按唯一职责、幂等、变更确认及恢复证据判断，不能仅凭节点名称宣称第二次用户审批。既有 `a807545` 保持候选状态。

## 下一步验收

先校正新任务受影响图与用户界面语义。隔离真实入口用简单回答、复杂任务和实际 ask 样本验证；一次点击后跟踪用户动作与网络决策，证明不会需要任务 grant 审批；验证同一页面持续显示进度卡，只有用户点击才进入详情，详情可返回原交互上下文。保留准确身份、持久 task-scoped 授权、错误与资源收口；按桌面及手机视口采集截图和真实回执。失败时记录首个偏离，禁止测试助手自动补授权后把整条用户路径判为通过。
