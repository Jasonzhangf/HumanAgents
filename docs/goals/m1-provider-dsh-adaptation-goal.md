# Milestone 1 Provider 与 DSH 适配目标提示词

用途：在用户明确启动 Milestone 1 实现后，作为可重入的完整执行目标，完成
M1-0 至 M1-5 的全部任务。当前只保存目标提示词，不因更新本文件而开始执行。

````text
/goal
目标：
完成 HumanAgent Milestone 1：在不让 DSH、RCC 或任一 Provider 类型泄漏到
contracts/core/runtime 的前提下，建立 Provider-neutral ExecutionRuntimePort，
接入本机 ~/.rcc 的 RCC v3 4444 入口，分别完成 cc/cc-sol 的 Responses adapter
与 goaichat 的 Anthropic adapter，并通过 DSH 的独立 Cordis profile 验证真实
start/resume/tool-result/error/requestStop/settle/recovery 闭环。

项目与基线：
- 项目：/Volumes/extension/code/humanagent
- 历史设计基线：main @ 41adc33e62629ae56c7b4eba667d13bd6cb358b8；它只用于追溯旧 receipts，不是本目标的执行输入。
- 执行基线：启动每次执行前从 clean `main` 读取并记录实际 HEAD、tree 和工作树状态；本文件编写时的 main 是 `36528f4e7d05932d63ddd7a4308c8863be424138`，后续文档提交会使其变化。
- DSH 锁定基线：c291e7961a515f6d7af9304e7fd1d257929aef26，tree e482b49bef64726be8f79380bb35bae569dc3c48
- DSH 计划：docs/architecture/dsh-baseline.md
- Provider 边界：docs/architecture/provider-adapters.md
- Host/Cordis 边界：docs/architecture/host-and-cordis.md
- 总体计划：docs/goals/mvp-to-milestones.md

范围与约束：
- Provider 临时使用本机 ~/.rcc 的 RCC v3 4444 listener；只读检查和记录非敏感
  capability/lock 摘要，不修改、迁移、重启或替换 ~/.rcc，不读取或提交凭据。
- cc/cc-sol 使用 Responses codec；goaichat 使用独立 Anthropic codec。可以复用
  协议内 codec，但不能合并 provider/route identity，也不能因为共用 4444 就
  合并 request、stream、tool-call、error 或 cancel/settle 语义。
- HumanAgent 自己拥有 Task、AgentRuntime、Operation、Checkpoint、Journal、
  Attention、lifecycle、stop/settle、health 和 UI projection。
- DSH 只拥有 DSH profile、Cordis tree、session、model、tool、原生事件和
  Session Log；RCC 只拥有外部 Provider endpoint、route/model/auth 配置。
- DSH SessionId、RCC request/session id、route、model、auth alias 都只能进入
  ExecutionBinding/EvidenceRef，不能成为 HumanAgent 的 TaskId、AgentRuntimeId
  或 CheckpointId，也不能写入业务 payload 作为控制真相。
- Provider binding、codec、readiness 和 Provider stop/settle 只能位于
  packages/adapters/provider；DSH session/event/DSH stop mapping 只能位于
  packages/adapters/dsh；app/plugin 只负责组装和消费 typed port。不得把协议
  类型上提到 contracts/core/runtime，也不得在 DSH bridge 复制 Provider owner。
- 不修改 /Volumes/extension/code/dsh；不修改 /Users/fanzhang/.rcc；不自动安装
  DSH/plugin；不接入 DSH WebUI 产品壳。
- 不实现多 Provider 路由策略、多 DSH profile、长程压缩、跨进程高可用、多租户、
  生产发布或未经证据支持的自动 fallback。
- 不以 listener 可连接、配置存在、TypeScript 编译、fake 通过或 DSH 日志存在
  代替真实 Provider/DSH 适配完成。
- 每个小阶段都必须有唯一 owner、输入版本、allowed/forbidden paths、正常/
  waiting/blocked/failed/cancelled 出口、下一动作和 evidence refs。
- 每个小阶段完成 focused validation 后，必须执行独立 Astra review；没有当前
  阶段 Astra PASS receipt 不得进入下一阶段。review FAIL 回对应 owner 修复、
  重验、重审；不得换通道取 PASS。Astra PASS 不自动授权 merge 到 main、push 或
  release。当前 goal 执行前提已经批准 M1 implementation scope；因此 worker
  可以在自己的 clean worktree 创建本地 candidate commit，供验证和 Astra 审查
  使用，但 candidate commit 不等于 main 集成或发布。若执行上下文没有该 scope
  批准，阶段必须进入 `approval-waiting`，不得用未提交工作树冒充 candidate。
- 阶段可重入：保存候选 SHA、配置/环境摘要、验证结果和 Astra receipt；输入未
  变化时复用已通过阶段，发生变化时从最早受影响阶段重跑，不做无关全量重跑。

执行与 Astra review：
- 实现任务使用当前宿主允许的独立 worker；Desktop 默认是 `codex exec --profile gcm --json`，其他已声明的协作宿主按其自身路由规则执行。每个 worker
  必须从当前阶段 candidate 创建独立 `playground/<task>` worktree，只写派单中
  的 allowed paths；worker 不能修改 main、其他 worker 的 worktree 或外部 DSH/RCC。
- 编排 Agent 只负责拆分、资源、worktree、生命周期、验证、Astra review、merge
  和提交；不直接编写 Provider/DSH/runtime 实现代码。每个派单必须写清输入 SHA、
  owner、独占范围、禁止范围、完成 iff、测试命令、证据位置和失败下一动作。
- 阶段顺序固定为：worker 在独立 worktree 创建 candidate commit → focused
  validation → native Astra review → 修复/重验（如有）→ 阶段 PASS → 等待或执行
  用户已授权的 integration merge。候选 commit、main 集成 commit、push 和 release
  是四个独立事实，不能互相冒充。
- M1 必须使用宿主批准的独立 Astra review 路由；review 启动方式服从当前宿主
  和 review skill，不在目标提示词中硬编码 worker/reviewer 工具。无论宿主如何
  启动，reviewer 都必须只读审查当前 candidate SHA，使用独立上下文并输出
  P0/P1/P2 findings；普通 review backend 的 PASS 不得冒充 Astra PASS。
- 每个阶段 focused validation 完成后，按如下协议启动独立 Astra：

  ```text
  independent Astra reviewer
    → read-only review of the exact candidate SHA and scoped diff
    → record reviewer task, candidate SHA, scope, final result, and review time
  ```

- Native Astra 必须是独立上下文；不得把实现 worker 的上下文、未提交工作树或
  隐式结论当作审查输入。只能提供明确的 candidate SHA、diff 范围、验证结果和
  项目规则路径。
- Astra 返回 P0/P1、缺少最终结果、超时、工具错误或上下文不可用时，阶段状态
  为 `review-blocked`，不得把它记为 PASS；修复后必须重新 spawn 新的 native
  Astra agent。只有明确无 P0/P1 的最终审查结果才可生成 `Astra PASS receipt`。
- 每个 M1 小阶段都必须单独 spawn 一次 native Astra；不能用 M1-5 的一次审查
  覆盖 M1-0 至 M1-4，也不能用一次 Astra 结果覆盖多个不同 candidate。

固定阶段：
- M1-0：只读复核 DSH public entrypoint、profile、session、tool、事件、取消、
  settle、持久化、license，以及 RCC 4444 listener、Responses、Anthropic 能力。
  输出能力矩阵、失败矩阵和未验证项。未通过时停在 dependency-missing、
  entrypoint-unavailable 或 capability-unavailable，不写 adapter。
- M1-1：定义并锁定 Provider-neutral binding/port；让 fake、Responses、Anthropic
  和 DSH driver 共享高层 contract；加入外部身份泄漏、协议错配、epoch、stop
  和 settle 的负向测试。
- M1-2：实现并隔离 Responses 与 Anthropic codec seam；为 cc/cc-sol 和 goaichat
  生成显式 binding/capability/readiness；准备独立 DSH_HOME、humanagent profile
  和 Cordis bridge seam。配置或协议不可证明时显式失败，不 fallback。
- M1-3：实现事件、工具、证据、错误和停止映射；验证协议事件 → Provider event
  → HumanAgent operation/Attention/checkpoint 的关系；cancel receipt 不等于
  stopped，必须等待真实 settle、资源结果和 stopped checkpoint；将 DSH capability
  probe 通过既有 `OrganHealthProbePort` 接入，健康结果不能从 debug log 猜测。
- M1-4：按 fake → recorded replay → real RCC → real DSH 四层验证；先验证 RCC
  4444 的 Responses/Anthropic 请求，再验证 DSH profile 绑定；覆盖 start/resume、
  tool result、stream error、transport close、provider/DSH crash、requestStop、
  stop timeout、late event、checkpoint recall/completion、实际
  `OrganHealthProbePort` 调用/失败可见性和 Journal/Session Log 分离。
- M1-5：只做收口和放行准备；核对源码/依赖/profile/plugin/provider lock、digest、
  clean tree、全部 Astra receipts、验证命令、限制清单和未完成项。用户明确批准
  后才能 merge 到 main、push 或 release。

生命周期与错误闭环：
- 启动顺序：resolve HumanAgent config → validate lock → load fixed Harness →
  load explicit adapter → probe RCC/DSH capability → publish ready → accept task。
- 关闭/更新：停止新任务 → 当前 operation 按策略等待或收拢 → requestStop →
  settle → checkpoint → dispose → 重启 probe → recall。
- `requestStop`、transport close、provider error、DSH session crash、plugin
  incompatibility、Journal commit failure 和 review failure 都必须保留原始错误、
  owner、影响、下一动作和恢复条件。
- 不把 debug log、snapshot、UI 状态或 response metadata 当控制真源；控制真源
  由 core/runtime 和 Organ Journal 决定。
- 后台 adapter 可局部重试或等待，但不能无限重试、空转或静默 fake fallback；
  前台影响必须立即进入 Attention/用户可见错误路径。

验收：
- M1-0 至 M1-5 每个阶段均有候选 SHA、focused validation 结果、独立 Astra
  review receipt、findings/修复/重验记录和唯一 owner。
- `cc`/`cc-sol` Responses 与 `goaichat` Anthropic 有分离 codec、stream、tool、
  error、cancel/settle 和 real same-entry 证据；provider identity 未被合并。
- RCC 4444 的 listener readiness、协议 readiness、same-entry request replay 和
  DSH profile binding 是分层证据；任何缺失都如实保留为未完成或阻塞。
- DSH capability probe 已通过 `OrganHealthProbePort` 在实际入口运行；健康结果、
  有效期、失败状态和 evidence ref 可复核，不能由 listener readiness 代替。
- fake contract、recorded replay、real RCC、real DSH 四层 execution 的高层
  lifecycle semantics 一致；失败、等待、阻塞、取消、stopping、stopped 和恢复均有证据。
- 高层 contracts/core/runtime 不导入 DSH/RCC 类型；Journal 与 DSH Session Log
  分离；旧 epoch 事件不会推进新 cycle；cancel 不会伪造 stopped。
- adapter、profile、plugin、provider config、dependency 和 artifact 具有可复核
  的版本/digest 锁定；敏感值不进入仓库、Journal、review prompt 或最终报告。
- 最终报告明确列出已验证、未验证、限制、剩余风险、下一动作和 owner。

依据：
docs/architecture/provider-adapters.md
docs/architecture/dsh-baseline.md
docs/architecture/host-and-cordis.md
docs/goals/mvp-to-milestones.md

直接执行本任务，不再为它生成一层提示词。
````
