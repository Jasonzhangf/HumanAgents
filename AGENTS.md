# HumanAgent 项目规则

## 项目定位

HumanAgent 是独立的长程器官式 Harness。它拥有器官、任务、指令、执行轮次、操作、checkpoint、错误策略和恢复责任；DSH 只是可替换的执行后端。

当前项目处于 `MVP-IMPLEMENTATION`：用户已批准 MVP；Wave 0/1/2 fixed Harness Runtime 已完成并进入 main。DSH 仍只是可替换执行后端；MVP 不接 DSH provider。

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
- 开发仓库只承载源码、文档和测试；`~/.humanagent` 是项目 runtime 的唯一 root（显式 agent）。禁止在 project workspace 中持久化 session、journal、checkpoint、index、artifact、memory、user profile 或 runtime lock。
- Organ Journal 决定任务状态和恢复责任；DSH Session Log 只证明模型请求、工具调用和具体执行过程。两者不得互相冒充。
- 控制面与业务 payload 分离。retry、degrade、steer、continuation、health、debug、checkpoint 等控制真相不得写入请求/响应业务字段、metadata 或日志后再重建。
- `steer` 只能启动标准停止 operation；取消模型请求不等于停止完成。停止必须有收拢 checkpoint 和实际副作用结果。
- 后台错误默认分层处置、局部降级并保留恢复责任；前台错误立即反馈。降级不能降低权限、正确性或验收标准。
- 偶发或暂态错误必须自动重试，最多 10 次退避重试；10 次后仍失败才向用户显式暴露错误。重试必须保持同一任务语义，不得另起新任务或丢失原任务上下文。
- 恢复状态必须准确且可独立读取；上下文窗口和汇报窗口可以有界淘汰。摘要不能代替恢复状态。
- 显式 Brain 职责边界：显式 Brain 只能回答简单问题；对复杂目标，显式 Brain 负责拆解任务并交给隐式 Brain 执行，自己不执行任务。执行中途需要用户输入时，显式 Brain 做 relay：把问题交回用户，并将回答回传以继续执行。显式 Brain 与隐式 Brain 各有责任区间，不得越权。新建任务表单的提交本身就是用户对该新任务的确认，显式 Brain 在同一次提交处理中整理并按 FIFO 投递 `RequirementEnvelope`，不再要求第二次确认。已有任务的目标、范围或处理方式变更仍须单独确认。隐式 Brain 负责分类队列、运行任务更新、资源准入和 Pipeline 创建。steer/停止/权限撤销等控制命令不得混入业务需求队列或 task payload。Web search 只是旁支优化，不是交付主线。
- 当前项目处于开发阶段，未进入生产。开发所需的安装、重建与本地实例重启可直接执行，不需逐次请示；生产环境变更仍须单独授权。
- 记忆 agent 与 MVP 主线彼此独立。记忆 agent 不可用不阻断任务交付；记忆 agent 只整理记忆、发现冲突并等待用户裁决，不替 master 宣称完成。
- 潜意识必须可观测但默认不直接呈现给人：Pipeline Observation 只读展示节点树、状态、输入/输出和证据，支持 drawer、递归 scope、面包屑返回；不能在观测界面消费需求、修改队列、重试 operation 或执行 steer。
- 用户界面不显示内部阶段名、原始英文事件或内部机械标识；只显示用户能理解的语义阶段，例如“执行工具等待结果”“发出请求等待响应”。技术详情只在必要时折叠展示。
- 入口页的任务列表可放入抽屉并可隐藏，不占用入口主区，也不与 Task List 页重复。
- Index 可删除后重建；Journal 追加记录、资产引用和提交关系必须可校验。
- 未完成 DSH 当前源码复核和真实停止/崩溃恢复验证前，不得宣称 DSH 适配完成。
- RCC `~/.rcc` 是外部 Provider 配置真源；HumanAgent 只做非敏感 capability/lock 读取和验证，不修改 RCC 配置，不提交凭据，不把 RCC route/model/session 当作 HumanAgent 身份。

## 工作边界

- 设计与文档：`docs/`、`README.md`、`note.md`；启动/release gate：`scripts/`、`tests/release/`。
- 已批准 MVP 实现代码在 `packages/`、`tests/`；当前阶段已经进入 runtime 实现。
- 未获批准的 DSH adapter、SQLite、vector/RAG、daemon 和生产部署能力不得作为 MVP 放行结果声称。
- DSH 源码只作为外部依赖证据读取；不得把本项目代码写入 `/Volumes/extension/code/dsh`。
- 新任务一律使用独占 Git worktree；存量 worktree 由原 owner
  完成原任务，合并后自然关闭，`dirty`、未合并、活动或有未交付内容的不强删。存量
  worktree 生命周期仍遵守全局 AGENTS L2 的 **Worktree SESE 存量治理规则**（严禁在
  仓库内新建 `<repo>/playground/<task>`）。

## 符号探索

  排查问题、审计流程或追踪 TypeScript/JavaScript 函数调用关系时，使用全局
  `nn-code` Skill。已知入口函数后，继续找被调用方优先一次 `nn-code calls`，
  不默认用多轮搜索逐层展开。衡量优化目标覆盖整个模型调用过程：组织命令、
  等待结果和下一轮推理的往返，不只比较单条命令执行耗时。

  未解析调用点按 Skill 记录的声明/调用点跨度读源码核验；不得把人工补查或
  猜测的结果冒称为工具输出。发现结果遗漏、错误、执行异常或阻断实际任务的
  能力缺口时，按该 Skill 的反馈流程投递 bug 或 capability-gap。

## Git 交付流程

- 默认流程是标准交付，视为已授权，不需要逐项申请：候选提交 -> merge 到 main ->
  重建产物并重启本地运行实例 -> 验证修复 -> push `origin/main`。
- 进入该流程的前提不变：改动在独占 Git worktree（存量任务在其原
  worktree）完成，适用 focused tests 与独立 review 通过，merge 后 main 保持可验证状态。
- 需要单独授权的是超出该流程的操作：删除、回滚、迁移、清权限、生产变更、force push、
  改写他人已推送历史、清理他人 worktree。

## 长程任务与 peer DAG

- master 是项目唯一负责人，项目进度由 master 负责推进、验收、集成和汇报；peer 缺位或失联不改变 master 的进度责任。
- 推动项目向前是最高优先级。master 必须主动用尽一切可用编排手段解除阻塞并保持主线前进，不能把 peer 缺位、角色缺失、外部等待或权限缺口当作停下等待的借口；无法完成当前动作时继续推进其他可执行工作。
- 任何角色缺失都要灵活处理：reviewer、planner、裁判或其他固定角色缺失时，按现有编排规则改派可用 peer、独立 worker 或已有 review/plan 流程承接，不得因角色缺失暂停或卡住整条主线。
- 独立 reviewer 优先选择另一个空闲 peer 或独立 worker；没有可用的 idle peer，且 subagent 独立 review 不可用的极端情况下，master（Jenny）可亲自承担独立 review，仍须按现有 review 合同产出真实审查证据，不得把“角色缺失”写成硬阻塞。
- 具体 feature/debug/重构/迁移/清理任务必须拆分给 peer 执行；master 只做目标拆解、
  依赖判定、派发、证据验收、集成裁决和最终验收，不亲自实现 peer-owned concrete task。
- 全局规则提供原则，本项目规则提供 HumanAgent 的执行细节；不得把项目细节反向当作全局规则。
- peer 写入必须在独占 Git worktree 完成；存量任务仍在原 worktree
  完成并在合并后自然关闭。docs-only 快速路径除外，但仍保留已有 dirty 状态。
- 每个 peer 任务必须写明入口、唯一 owner、allowed/forbidden paths、交付物、测试命令、
  E2E/manual 验证、review 条件和资源清理条件。
- peer 回传必须包含自然 Git 提交标识（若有提交）、changed files、受影响测试结果、
  真实入口/E2E 或手动验证证据、清理列表和剩余风险。READ IS NOT DONE；测试和 review 是 gate，不是建议。
  对外 release 前不主动计算 SHA/checksum、目录摘要、冻结快照或候选身份绑定；子任务不单独触发独立
  Review，仅在完整且重大的可交付 milestone 完成作者自检与适用黑盒验收后、正式集成前执行一次整体独立 Review。
- master 合并前必须 fetch 最新 `origin/main`，确认候选已组合到最新 main 并重跑受影响验证；
  若当前 main 有大量 dirty 或未归属候选，先派 audit/classification 任务，不得直接提交。
- 资源清理是终点生命周期：新任务使用独占 worktree；存量 worktree 按全局 [`worktree-lifecycle.graph.json`](/Users/fanzhang/.agents/skills/codex-orchestrator/references/worktree-lifecycle.graph.json) 与 [交付合同：Worktree SESE 生命周期](/Users/fanzhang/.agents/skills/codex-orchestrator/references/delivery-contract.md#worktree-sese-生命周期与资源单源单汇) 做四分类核销，已合入 main 且无未交付内容与活动进程的当轮关闭并清理临时目录。清理失败必须报告原因并标记 `INCOMPLETE`，不得静默跳过、强删 dirty/未合并/活动树或清理他人资源。

## 已批准 MVP 交付门禁

1. 先保持 `contracts` 的最小类型与负向测试，再实现 `core` 不变量；不得先写 DSH wrapper。
2. Journal、checkpoint、steer、错误升级、恢复和窗口装配必须有 focused tests。
3. Provider 直连路径必须通过 fake contract、Responses/Anthropic 录制 replay 和真实 RCC 4444 同入口；DSH bridge 在此基础上另行通过真实 DSH 同入口。只有声称 Provider+DSH 组合交付时，四层证据才必须同时齐全；单一 TypeScript 编译不算任一路径接入完成。
4. review 要检查唯一 owner、控制/业务隔离、Journal/Index 真源关系、失败可见性和删除/压缩的数据完整性。
5. Dashboard 输入、确认、turn 展示和结果展示的浏览器验收与清理统一按 [`docs/ui/dashboard-e2e-acceptance.md`](docs/ui/dashboard-e2e-acceptance.md) 执行；本次变更适用的真实任务 receipt 或资源清理核对缺失时标记 `INCOMPLETE`。
6. 测试按最小充分性选择。每项测试必须对应需求/不变量、具体失败模式和应失败断言，并以已有红测或可执行反例说明抓错能力；未验证的能力标 `UNVERIFIED`。证据足够即停止，不按数量、覆盖率或场景类别扩面。
7. 新增测试前记录失败可能性的依据（允许为 `未知`）、失败影响、执行和维护成本；没有这些理由不新增测试。测试/review 必须直接服务于本次改动的验收。
8. MVP 首版优先功能完整。保留内存、资源与业务正确性所需约束，以及产品身份和 task-scoped 授权；不为传输安全增加或保留 TLS、Origin/CSRF、cookie 安全标志、远端访问拒绝或 supervisor loopback-only 限制及其专属测试。
9. 全局交付门禁：任务集成或完成前必须由测试员在真实前端按用户视角测试通过；单元测试、构建、CI、独立审查、候选分支不替代此门禁，缺真实前端验收回执记 `INCOMPLETE`/`UNVERIFIED`。门禁通过 [`docs/goals/mia-mvp-user-perspective-tests-20261107.md`](docs/goals/mia-mvp-user-perspective-tests-20261107.md) 的 5 条测试执行并产出可复现验收证据（Mia，测试员）。
