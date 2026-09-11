# HumanAgent 项目交接

## 当前阶段

`DESIGN-BOOTSTRAP`。2026-09-10 建立空目录项目的第一版架构真源。没有 Git 基线，没有运行时代码，没有测试入口，没有 DSH adapter。

## 已确定

- HumanAgent 高层与 DSH 解耦。
- Organ Journal 是高层任务、操作和 checkpoint 的权威历史；DSH Session Log 是执行证据。
- `steer` 是标准停止 operation 的入口，实际收拢完成前不能报告 stopped。
- UI 自己拥有 Organ Console 和 runtime projection；DSH WebUI 不整体复用，纯视觉 primitives 仅作为后续可选依赖。
- 后台错误持续承担恢复责任，前台错误立即反馈；降级不改变正确性门槛。
- Journal 追加、Index 可重建、恢复状态与上下文/汇报窗口分离。

## 当前计划

MVP 不接 DSH，先用 fake backend + 最小 Operator Console 收口 HumanAgent 自己的 Journal、checkpoint、steer、错误策略和 standalone replay。Milestone 1 接真实 DSH，并评估纯 UI primitives；Milestone 2 做长程耐久/恢复；Milestone 3 做多任务、资源、安全和可部署交付。完整退出门禁见 `docs/goals/mvp-to-milestones.md`。

## 下一位执行者

先评审 MVP 边界，决定首个语言/包管理器和 standalone 入口，再初始化 Git/语言工具链。不得直接创建 DSH wrapper 或把现有 DSH checkout 当作 clean 基线。
