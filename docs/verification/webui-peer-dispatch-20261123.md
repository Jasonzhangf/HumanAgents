# Jenny 的投递与跟踪

Jenny 收到复杂目标，把任务投递给同级的隐式编排 Agent。主话题保留本轮交办回执，随后可以继续聊天。打开任务板中的原任务，可以查看该任务关联的执行 runtime、模型状态、工具调用与结果。任务记录间的执行关联只用于定位该任务的执行详情。

真实 RCC 的隔离首页验收覆盖了投递、第二条独立对话、任务板中的文件读取步骤和任务结果返回。真实历史的浏览器回放还核对了三次 bash 的参数与输出，并验证了切换任务后的归属。旧记录只有执行 runtime 和 assignment，界面显示可证实的执行信息。角色名和编排接单回执在该样本中均缺失。

问题卡按 task、request 和 revision 绑定原位回答。桌面及手机隔离浏览器验证了选项回答、自定义回答、普通新消息、刷新后保留引用，以及长历史的滚动。执行详情读取失败时，错误仍归入原任务所在的轮次。历史抽屉沿用聊天中的发言人身份。

白盒检查可运行 `pnpm test:ui` 和 `node --test tests/ui/dispatch-tracking.test.mjs tests/ui/main-topic-history-detail.test.mjs tests/ui/main-topic-legacy-read-consumer.test.mjs`。浏览器入口为 `tests/ui/main-topic-answer-browser.mjs` 和 `tests/ui/main-topic-history-layout-browser.mjs`，分别用 `MAIN_TOPIC_ANSWER_EVIDENCE` 和 `MAIN_TOPIC_LAYOUT_EVIDENCE` 指定独立证据目录。
