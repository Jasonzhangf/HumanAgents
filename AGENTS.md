# HumanAgent 项目规则

## 项目定位

HumanAgent 是独立的长程器官式 Harness。它拥有器官、任务、指令、执行轮次、操作、checkpoint、错误策略和恢复责任；DSH 只是可替换的执行后端。

当前项目处于 `MVP-IMPLEMENTATION`：用户已批准 MVP；Wave 0/1/2 fixed Harness Runtime 已完成并进入 main，Wave 2 已通过 commit-bound Astra gate。DSH 仍只是可替换执行后端；MVP 不接 DSH provider。

## 唯一 owner

- 高层领域状态、生命周期、错误策略、steer 和恢复：`packages/core`。
- Brain/需求队列规则和健康状态分类：`packages/core`；显式输入整理、隐式分类/准入和 Pipeline 编排：`packages/runtime`。
- 调度、checkpoint 编排、窗口装配和恢复流程：`packages/runtime`。
- Organ 基础功能探针执行：`packages/runtime`；具体外部能力探针：对应 adapter；健康快照不是控制真源。
- 权威历史：`packages/adapters/jsonl` 实现的 Organ Journal。
- 历史查询：`packages/adapters/sqlite` 的可重建 Index；Index 不是状态真源。
- 不可变大对象和工具输出：`packages/adapters/filesystem`。
- Provider binding、协议 codec、readiness 和外部 Provider stop/settle 映射：`packages/adapters/provider`；`cc`/`cc-sol` 的 Responses 与 `goaichat` 的 Anthropic 必须保持独立协议实现。
- DSH 会话、模型、工具执行和取消映射：`packages/adapters/dsh`；不得把 DSH 类型上提为领域类型。
- 进程、文件、远端等副作用：`packages/adapters/operations`。
- internal/user/project 配置解析、校验、编译和 control-root/project 路径派生：`packages/config`；不得让 UI 或 adapter 各自解析 TOML。
- UI 领域 view model、投影和产品壳：`packages/ui`；UI 不直接读取 Journal/DSH Session，也不拥有运行时状态。
- 组装入口：`packages/app`。
- Task 输入输出契约和节点观测 projection：`packages/contracts` / `packages/ui/projection`；Dashboard/Task Detail、Organ Console 和 Pipeline Observation 的产品界面：`packages/ui`。

## 硬约束

- 高层设计必须可脱离 DSH；高层不得导入 DSH 的 `SessionId`、事件类型或日志格式作为自身身份和状态。
- UI 必须可在没有 DSH 的情况下呈现 Organ/Task/Cycle/Checkpoint/Attention；DSH WebUI 只能作为可选的视觉实现或执行细节面。
- `~/.humanagent` 是全部持久化数据的唯一 root；project workspace 只提供执行上下文，禁止在其中持久化 session、journal、checkpoint、index、artifact、memory、user profile 或 runtime lock。
- Organ Journal 决定任务状态和恢复责任；DSH Session Log 只证明模型请求、工具调用和具体执行过程。两者不得互相冒充。
- 控制面与业务 payload 分离。retry、degrade、steer、continuation、health、debug、checkpoint 等控制真相不得写入请求/响应业务字段、metadata 或日志后再重建。
- `steer` 只能启动标准停止 operation；取消模型请求不等于停止完成。停止必须有收拢 checkpoint 和实际副作用结果。
- 后台错误默认分层处置、局部降级并保留恢复责任；前台错误立即反馈。降级不能降低权限、正确性或验收标准。
- 恢复状态必须准确且可独立读取；上下文窗口和汇报窗口可以有界淘汰。摘要不能代替恢复状态。
- 显式 Brain 负责感知输入整理、任务匹配、状态查询、意图确认和整理反馈；只有用户确认后才形成并按 FIFO 投递 `RequirementEnvelope`。隐式 Brain 负责分类队列、运行任务更新、资源准入和 Pipeline 创建。steer/停止/权限撤销等控制命令不得混入业务需求队列或 task payload。
- 潜意识必须可观测但默认不直接呈现给人：Pipeline Observation 只读展示节点树、状态、输入/输出和证据，支持 drawer、递归 scope、面包屑返回；不能在观测界面消费需求、修改队列、重试 operation 或执行 steer。
- Index 可删除后重建；Journal 追加记录、资产引用和提交关系必须可校验。
- 未完成 DSH 当前源码复核和真实停止/崩溃恢复验证前，不得宣称 DSH 适配完成。
- RCC `~/.rcc` 是外部 Provider 配置真源；HumanAgent 只做非敏感 capability/lock 读取和验证，不修改 RCC 配置，不提交凭据，不把 RCC route/model/session 当作 HumanAgent 身份。

## 工作边界

- 设计与文档：`docs/`、`README.md`、`note.md`；启动/release gate：`scripts/`、`tests/release/`。
- 已批准 MVP 实现代码在 `packages/`、`tests/`；当前阶段已经进入 runtime 实现。
- 未获批准的 DSH adapter、SQLite、vector/RAG、daemon 和生产部署能力不得作为 MVP 放行结果声称。
- DSH 源码只作为外部依赖证据读取；不得把本项目代码写入 `/Volumes/extension/code/dsh`。
- 后续实现必须在 `playground/<task>` 下的独立 clean worktree 中进行；本轮 review-fix 从 clean worktree HEAD `4ec6313cfad75c00363bbbedd6234928234121dd` 开始。

## Git 交付流程

- 默认流程是标准交付，视为已授权，不需要逐项申请：候选提交 -> merge 到 main ->
  重建产物并重启本地运行实例 -> 验证修复 -> push `origin/main`。
- 进入该流程的前提不变：改动在独立 clean worktree 完成，适用 focused tests 与独立
  review 通过，merge 后 main 保持可验证状态。
- 需要单独授权的是超出该流程的操作：删除、回滚、迁移、清权限、生产变更、force push、
  改写他人已推送历史、清理他人 worktree。

## 已批准 MVP 交付门禁

1. Wave 2 candidate 只有在 focused tests、runtime integration 和独立 Codex/Astra review 通过后才可进入 main；不得伪造已入 main。
2. 先保持 `contracts` 的最小类型与负向测试，再实现 `core` 不变量；不得先写 DSH wrapper。
3. Journal、checkpoint、steer、错误升级、恢复和窗口装配必须有 focused tests。
4. Provider 直连路径必须通过 fake contract、Responses/Anthropic 录制 replay 和真实 RCC 4444 同入口；DSH bridge 在此基础上另行通过真实 DSH 同入口。只有声称 Provider+DSH 组合交付时，四层证据才必须同时齐全；单一 TypeScript 编译不算任一路径接入完成。
5. review 要检查唯一 owner、控制/业务隔离、Journal/Index 真源关系、失败可见性和删除/压缩的数据完整性。
