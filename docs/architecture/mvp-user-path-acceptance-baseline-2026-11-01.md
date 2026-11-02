# MVP 用户路径验收基线

负责人：Emma；修复与集成协调：Jenny。依据用户本轮明确的 MVP 目标及 `docs/ui/dashboard-e2e-acceptance.md`。本表是验证状态，不以旧 receipt 代替当前用户路径验收。

| 用户行为 | 当前证据 | 结论与下一步 |
| --- | --- | --- |
| 输入简单问题并直接得到回答 | 存在正式验收要求：真实 Provider settlement 关联本次输入；本轮尚未采到当前入口 receipt。 | UNVERIFIED。先用隔离 control root 和真实浏览器验证不创建 Task 的直接回答。 |
| 复杂请求一次提交、理解并执行；不明确时 ask | 历史真实执行 receipt 位于 `/Volumes/Intel/playground/humanagent/.worker-runs/fc-final-62dd888-20261031/productmain-3a90267b7/receipts/`；另有旧台账记载 typed preview 和确认流程。 | 当前版本的单次提交、无需二次审批和 ask 条件尚未用同一次真实操作证实。不得把旧 preview/confirm receipt 自动等同于用户本次要求。 |
| 单一交互界面、无不必要跳转 | 2026-11-01 当前 `http://127.0.0.1:10086/` 可打开，页面显示输入框、任务卡片及 Dashboard/Task List 等导航。 | 页面可打开不证明任务提交后连续；需在隔离任务中观察实际导航、用户决策与返回。 |
| 显式和隐式过程实时可见；进度卡和步骤详情 | 旧台账记录双视口进度截图和受影响测试；本轮尚未将其与当前真实任务和每一步动画对齐。 | UNVERIFIED。记录同一任务的等待、执行、卡片及详情动态，并检查桌面与手机视口。 |
| 错误后自动恢复并最终交付 | 开放 bug `3c8c433` 的真实 RCC 失败注入回执显示 retryable 503 后走 blocked，未显示 retry 步骤。 | 已知失败，修复由 Jenny 协调；修复后复验一次失败、自动重试、成功、checkpoint、进度呈现与资源收口。 |
| 显示与校验最小必要 | 首轮静态候选见 `docs/architecture/minimality-ablation-audit-2026-11-01.md`；已登记项目 bug。 | 候选需按真实消费者和失败模式逐项核实，不把历史数据恢复或必要控制校验误删。 |

## 当前实际观察范围

浏览器 TaskSpace 32 的 `p1` 打开现有运行实例首页，观察为只读；没有提交输入、停止任务或修改现有任务。`/api/liveness` 返回 `alive`。当前页面内容及 liveness 不能证明简单回答、复杂任务完成、动画、重试或已安装实例与当前源码一致。

真实输入、执行及失败注入必须按项目验收规范使用独立任务和受控资源，保存真实 Provider receipt、截图及 stop/settle/checkpoint 清理证据。不得清理当前页面显示的既有用户任务。
