# 2026-10-08 静态语义观测验收

范围：静态 HTML 和功能差距报告。没有修改 packages、运行实例、Provider、权限或生产配置。生产 G1–G14 / F01–F20 全部 OPEN。

输入基线：`56995b3e742b3a400efa45bb42508dd3185284fb`。冻结 HTML SHA256：`3a85040bfe69200af5d37c31a420c594d6ddac8f182bb8e815b8ad4f010da505`。

实际入口为候选文件的 file URL。Ego TaskSpace 8 / p1 为本任务唯一浏览器空间。root 运行原生按钮、键盘、鼠标及公开只读消费者验收；不从 evaluate 调用 MockDriver、dispatch 私有命令或 DOM.click。Storage 故障仅注入自己的 `humanagent.mock.display-preference.v1` key；结束时撤销 hook 并恢复该 key。

| 回执 | 实际结果 | 证明范围 |
|---|---|---|
| [baseline.json](baseline.json) | 65/65 PASS | 类型分组、四模式、错误上下文排除与历史保留、CP 游标、全部固定/跟随偏好、共享引用、三模板、Agent、失败与深链 |
| [long-revision.json](long-revision.json) | 20/20 PASS | Tour10 retained v2、CP/revision 独立、冲突拒绝、v4 未发布/发布、前缀不变、其他任务隔离、完整 v1..v4 演变 |
| [supplement.json](supplement.json) | 19/19 PASS | Storage read/write/remove 失败、坏 JSON/未知版本、浏览器前进后退、双消费者同 ref/退订、原生 pointer raw 跳转、reduced motion、无 HTTP 请求 |
| [responsive.json](responsive.json) | 105 站 + 24 视图 PASS | 35 站各在 1440/768/390 宽度；1080/1081/860/861/620/621 断点视图；无 body 横溢、SVG namespace 错误或活动依赖错误 |

计数是 104 个专项断言、105 个 Tour 站点访问和 24 个断点视图，不能把不同计量合并为“233 个测试”。Responsive 归档省略了重复的导览说明文字；完整原始回执保留在过程目录。

root 初次验收在旧作者候选 `e5effd63a9250be8f4b08ea1c4ac802b03dc01f5a91bab6e75a84c2c986cb3ea` 发现：长程没有下一次修订可发布，Tour10 的 ver2 显示 CP3 的 v3 图。[红证据](long-revision-red.json) 保留该失败。独立作者修复后，上述 long-revision 回执证实新候选消除了这两处错误。旧候选的局部绿测不作为新交付证据。

截图视觉检查：root 查看新候选 `historical-v2.png`，确认历史 v2 / 当前 v3 的标识分离；查看 390px `project-mobile-uncovered.png`，确认三类任务、空类别及卡片可读。截图保留在外置过程目录，不把未生成的旧截图当成新证据。移动端顶部工具按钮会换行，属于可进一步打磨的静态设计细节。

浏览器只证明当前 JS 进程内不可变共享引用和旧版本保留。它不证明 Rust Arc、跨进程同地址共享或生产 context-events 已接线。Mock 回退不撤销真实副作用；导航不推进任务。没有真实 Runtime/Provider 请求。

过程真源：`/Volumes/Intel/playground/humanagent/.worker-runs/semantic-checkpoints-20261008/note.md`。可重复操作脚本为该目录的 `ui-fix/baseline-acceptance.mjs`、`ui-fix/long-acceptance.mjs`、`browser/tour-matrix.mjs`、`browser/supplement.mjs`。脚本中的候选绝对路径是验收时的真实输入；worktree 回收后复验应使用正式 main 文件，并更新记录的输入路径/hash。

## Review 输入

请最终 reviewer 先读本文件、报告第 1 节权威需求与第 1.1 节 R1.4，以及上述过程目录的 `observation.md`、`planner-r4/plan.md` 和 `note.md`。该目录的 `retrospective.md` 是独立 planner 的经验复核建议；请对照红/绿原始证据按 user-correction-alignment 核对，不写 Skills/记忆、不新增产品范围。

用户最后两条展示要求：

> 默认显式哪个方式是可以配置的，这样下次显式用用户习惯的展示方式默认用这个方式展示
>
> 简单的显式方式在长程编排里面只显示更新的最后编排，就是当前编排。语义显示会显式整个修订的改变历史，能看到改变过程

本轮修改四模式设计及偏好，按这些原文执行。未获授权更改其他需求。独立 review 只读审查静态设计、源码审计准确性与验收边界；生产 DAG/build/install/restart 不适用于这个 docs 候选。
