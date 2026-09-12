# 生命周期与故障归属设计

状态：`DESIGN-BOOTSTRAP / LIFECYCLE-CLOSURE-DRAFT`  
日期：2026-09-11  
适用范围：启动、插件加载、Task 执行、runtime 意外、错误升级、停止和恢复

本文把“每个阶段必须闭环、每个问题必须有 owner”固化为 HumanAgent 的运行时契约。它依赖 [`organ-runtime.md`](organ-runtime.md)、[`agent-flows.md`](agent-flows.md) 和 [`host-and-cordis.md`](host-and-cordis.md)，不另建第二套生命周期真相。

## 1. 总原则

任何阶段或 operation 都必须同时拥有：

```text
输入事实
  → owner 接管
  → admitted / started
  → 处理中间状态
  → succeeded
      或 waiting / blocked / failed / cancelled
  → settle / checkpoint / evidence
  → next action 或责任交接
```

“发生了错误”不是终态；“已经发送取消”也不是停止完成。只有状态收拢、证据写入、资源释放/保留规则和下一责任人都可验证时，阶段才算闭环。

后台错误可以降级和持续恢复，但不能丢失 owner；前台错误必须立即反馈，但不能因此跳过标准收尾。重试必须有局部上限、改变条件或升级目标，不能空转。

## 2. 通用状态和结束证据

### 2.1 阶段状态

各模块可以有更细的内部状态，但对外必须投影到这组公共状态：

| 状态 | 含义 | 必须存在的事实 |
|---|---|---|
| `created` | 已记录，尚未准入 | 输入引用、owner、作用域 |
| `admitted` | 权限、资源、依赖和恢复条件已满足 | admission decision、lease/条件 |
| `running` | 已开始实际工作 | start operation、epoch |
| `settling` | 不再接受新工作，正在收拢 | settle operation、阻断入口 |
| `succeeded` | 交付条件已满足 | output refs、evidence refs、完成 checkpoint |
| `waiting` | 暂无可执行动作，但恢复条件明确 | condition ref、下一检查动作、owner |
| `blocked` | 当前条件不允许继续，需要处理或外部变化 | blocker、影响、升级目标、owner |
| `failed` | 本阶段未完成，且已执行错误处理 | 原始错误、影响范围、恢复/升级动作 |
| `cancelled` | 由授权控制命令撤销，且收尾已完成 | stop operation、资源结果、停止 checkpoint |
| `stale` | 事件属于旧 epoch 或过期投影 | source epoch、拒绝原因、evidence ref |
| `unknown` | 事实不足，禁止推断为成功 | 缺失事实、补证动作、owner |

`degraded` 是能力/健康维度，不是上述生命周期的替代值。一个任务可以是 `running + degraded`，也可以是 `waiting + healthy`。

### 2.2 闭环记录

所有阶段性事件至少关联：

```ts
type LifecycleClosure = {
  scope: 'host' | 'plugin' | 'interaction' | 'task' | 'runtime' | 'assignment' | 'operation' | 'review'
  scopeId: string
  ownerId: string
  state: string
  startedAt?: string
  settledAt?: string
  inputRefs: string[]
  outputRefs: string[]
  evidenceRefs: string[]
  checkpointRef?: string
  nextAction?: string
  conditionRef?: string
  failureRef?: string
  escalationTarget?: string
}
```

UI 可以只显示摘要，但 Journal/运行时投影不能省略这些关系。

收拢证据按 scope 区分，不强行制造 Task checkpoint：

- `task`/`cycle` 必须有 HumanAgent checkpoint；
- `interaction` 使用独立 `InteractionClosure`（interaction scope、输入/反馈、确认/拒绝/取消结果和 evidence refs），只查询或确认前取消不创建 Task；
- `host`/`plugin` 使用 startup/readiness/dispose closure 和 operation/evidence refs；
- `runtime`/`assignment`/`operation` 使用各自 settle operation，并通过父级已提交事件关联到 Task（如果已有 Task）。

确认成功后通过显式 `interaction.confirmed → task.bound` 事件建立关联；不能为确认前交互补造 `taskId`、`cycleId` 或 checkpoint。

状态字段不是自由文本：

- `created` 必须有输入引用和 owner；`admitted` 必须有准入决定、权限和 lease/条件；
- `running` 必须有 start operation、execution epoch 和当前 owner；`settling` 必须已经关闭新工作入口并有 settle operation；
- `succeeded` 必须有满足交付条件的 output/evidence 和完成 checkpoint；
- `waiting`/`blocked` 必须有 condition、影响、owner 和下一检查/升级动作；
- `failed` 必须有原始 failure、影响和恢复/升级动作；`cancelled` 必须有 stop operation、资源结果和停止 checkpoint；
- `stale` 必须有被拒绝的 source epoch/attempt；`unknown` 必须说明缺失事实和补证动作，不能转写成成功。

跨 scope 的状态只通过父级引用和已提交事件关联：runtime 事件可以形成 assignment/operation 节点，节点不能反写 Task lifecycle；UI projection 只能带着 source `seq` 投影这些事实。

## 3. 唯一 owner 责任表

| 范围 | 唯一 owner | 负责闭环 | 不能转嫁给 |
|---|---|---|---|
| Host 启动/关闭 | Harness Supervisor | profile、plugin、依赖、ready、graceful shutdown | DSH session、UI |
| 高层状态迁移 | `core` lifecycle owner | 合法迁移、epoch fence、终态判定 | agent prompt、debug log |
| Journal durability | Journal owner | append、链校验、提交/尾记录处理、资产引用完整性 | Index、DSH log |
| Task/cycle recall/completion | Runtime Coordinator | 读取最新 checkpoint、决定 recall/completion、提交生命周期迁移 | Journal storage、Index、DSH log |
| Plugin manifest/加载 | Plugin Registry/Loader | validate、compile、load、dispose、digest | 任意插件自身 |
| Agent Template | Template Loader | 模板解析、能力上限、snapshot、版本追踪 | Agent、DSH profile |
| 需求 FIFO/准入 | Runtime Coordinator | 确认门、分类、资源准入、等待条件 | UI、交互 agent |
| 编排 runtime pool | Orchestration Runtime Manager | idle 复用、spawn、lease、释放、资源不足等待 | 编排 agent |
| 阶段计划/assignment | 编排 agent | plan、分解、派发、整改 assignment、结果核对、推进 | 执行 agent、Review Coordinator |
| worker assignment | 执行 agent | 固定目标、执行、WorkResult 和证据 | 编排 agent、review agent |
| external operation lifecycle | Runtime Operation Owner | operation start/settle/cancel、资源释放和最终状态 | 执行 agent、DSH session |
| 审计闭环 | Review Coordinator | review request、findings、复审有效性、merge gate 判定和整改请求引用 | review agent、编排 agent、UI |
| 记忆闭环 | Memory Coordinator + Memory Operations Backend；可选 memory analysis agent | scope binding、历史读取、比较、candidate、review 请求、context injection | RAG service、Skill Registry、AI provider |
| 健康诊断 | Harness Health Manager | probe、聚合、TTL、Attention、准入影响 | 任何 agent |
| 执行后端 | Execution Adapter | 外部 session、事件映射、stop/settle、证据读取 | 高层 Task owner |
| UI 状态 | UI Projection owner | 只读 projection、command routing、断线/stale 展示 | Journal、DSH WebUI |
| 用户控制 | Control/Steering owner | 权限检查、stop operation、stopped checkpoint | 业务队列、模型 |

每条故障记录一个 `ownerId`。交接时必须记录 `previousOwner`、`newOwner`、交接原因和证据；没有交接记录就不能把问题标为已处理。

## 4. 阶段闭环矩阵

| 阶段 | 进入条件 | 成功出口 | 异常出口 | owner 的下一动作 |
|---|---|---|---|---|
| 启动配置 | profile 可定位 | config snapshot 已锁定 | `config-invalid` | 修复配置或升级，不启动半成品 |
| 插件加载 | manifest/lock 可读 | plugin registered + ready | `plugin-invalid` / `dependency-missing` | 禁止加载该插件，保留错误证据 |
| 模板加载 | role/version 已解析 | compiled template digest | `template-invalid` | 修模板/版本，不能换角色回退 |
| 需求确认 | draft 有状态证据 | 用户确认并生成 envelope | rejected/status-only/waiting | 交互 agent 保留 draft 和下一询问 |
| FIFO 消费 | envelope 已提交 | queue claim 有 seq | duplicate/conflict/blocked | Runtime Coordinator 处理冲突并保留原输入 |
| runtime 绑定 | 资源/权限/健康满足 | lease + task binding | `waiting` / `resource-blocked` | pool manager 等待或释放，不伪造 running |
| assignment | 目标和交付条件完整 | worker 已接收 | invalid/permission blocked | 编排 agent 修 assignment 或升级 |
| worker operation | 输入和工具已准入 | WorkResult + evidence | failed/incomplete/blocked/cancelled | operation owner 按 policy 重试、等待或升级 |
| review | 交付证据齐全 | review passed | findings/inconclusive | 编排 agent 生成整改并请求复审 |
| memory review | 历史范围可读 | candidate/暂无沉淀结论 | `memory-unavailable` | Memory Coordinator 保留责任，不静默跳过 |
| checkpoint | 状态和引用齐全 | commit 可 replay | write/chain/asset error | Journal owner 阻止错误完成并恢复写入 |
| steer/stop | 命令授权且 epoch 匹配 | settle + stopped checkpoint | stop timeout/unknown | Control owner 保持 `stopping`，发布 Attention |
| UI projection | source cursor 可读 | 新投影带 seq | stale/disconnected | UI projection 标明过期，不猜测当前状态 |

## 5. 故障处理梯度

每个问题按最小影响范围处理，但必须向上保留责任：

```text
operation error
  → 保存原始错误和影响
  → 受上限约束的同条件修复/重试
  → 换已授权路径或进入 waiting
  → assignment/agent 级 blocked 或 failed
  → task Attention / foreground feedback
  → runtime/organ 级 supervision
  → Host blocked / operator intervention
```

规则：

- 局部失败不能终止未受影响的任务或健康 runtime；
- 重试必须记录次数、条件和结果；同一条件达到上限后不得继续重试；
- 降级只减少速度、并发或可用功能，不降低权限、证据或验收标准；
- 影响用户承诺时立即创建/更新同一个 Attention；恢复后关闭它；
- 错误原因未确定时记录 `unknown` 或 `inconclusive`，不能包装成成功；
- 当前 owner 不可用时由其监督 owner 接管“运行容器恢复”；Task/operation 结果仍由原领域 owner 判定，Journal owner 只负责持久性，Supervisor 不得替代 core/runtime 猜测成功。

## 6. Runtime 意外案例

| 案例 | 首个事实 | 首要 owner | 处置 | 完成证据 |
|---|---|---|---|---|
| 启动配置错误 | schema/path/digest 失败 | Supervisor | 拒绝 ready | error + profile ref + exit state |
| 模板缺失/越权 | role 引用或 allowlist 无效 | Template Loader | 拒绝 runtime spawn | validation result |
| 编排池无资源 | 无 idle 且 quota 满 | Pool Manager | 条件 waiting/backpressure | condition + next check |
| worker 返回不完整 | 缺 output/evidence/criteria | 编排 agent | `incomplete`，不得推进 | WorkResult + remediation/wait |
| review 失败 | blocker finding | Review Coordinator | 整改 → 复审 | finding → fix → review chain |
| memory 服务不可用 | query/history port 失败 | Memory Coordinator | `memory-unavailable` 或等待 | error + retry bound + owner |
| DSH 进程崩溃 | provider exit/transport close | Execution Adapter | 报告 provider 事实；Runtime Operation Owner 负责 settle/unknown，Attention，按 checkpoint 恢复 | exit code + operation + checkpoint |
| DSH plugin 版本不兼容 | capability probe 失败 | Plugin Registry | 不启动 provider；Adapter 只报告探针结果 | version/compatibility evidence |
| Journal 尾记录损坏 | replay verify 失败 | Journal owner | 隔离尾记录，禁止伪造完成 | verify report + recovery decision |
| 迟到事件 | epoch/attempt/revision 不匹配 | Core lifecycle | 标 stale，不推进状态 | rejection reason |
| steer 超时 | cancel 返回但未 settle | Control owner | 保持 `stopping`，升级 Attention | stop operation + pending condition |
| UI 断线 | projection cursor 无法更新 | UI Projection owner | 显示 stale/disconnected | last seq + reconnect state |

## 7. 问题记录契约

问题和 Attention 不能只写日志。至少要有：

```ts
type ManagedIssue = {
  issueId: string
  scope: string
  scopeId: string
  category: 'config' | 'dependency' | 'permission' | 'operation' | 'integrity' | 'health' | 'control' | 'projection'
  severity: 'info' | 'attention' | 'blocker'
  firstObservedAt: string
  ownerId: string
  state: 'open' | 'recovering' | 'waiting' | 'blocked' | 'resolved' | 'superseded'
  impact: string
  originalErrorRef?: string
  actionRefs: string[]
  conditionRef?: string
  escalationTarget?: string
  evidenceRefs: string[]
  resolvedBy?: string
}
```

同一持续故障更新同一个 `issueId`；影响扩大才升级严重度，恢复后写解除事件。没有 `nextAction`、condition 或 escalation target 的 open issue 不能被视为后台已处理。

## 8. 阶段退出审查

在进入下一阶段前，必须逐项回答：

1. 当前阶段的 owner、输入、输出和终态是否唯一？
2. 成功、等待、阻塞、失败、取消、迟到事件是否都能收拢？
3. 每条错误是否保留原始事实、影响、当前 owner 和下一动作？
4. 是否存在重试无上限、静默 fallback、伪造完成或丢失责任？
5. 是否有对应 Journal/checkpoint/evidence/health/UI projection 证据？
6. 如果 owner 进程崩溃，监督层能否接管并从最新 checkpoint 恢复？

阶段 review 不只审查 happy path；缺任一异常闭环证据就不能通过。

### 8.1 阶段性、可重入的治理 Gate

Gate 是可恢复的阶段记录，不是每次从头执行的脚本。每个候选都按固定阶段推进，并为每个阶段保存一条可校验记录：

```text
stage
  → candidateDigest
  → input/toolchain/dependency digests
  → status: pending | running | passed | invalidated | failed | blocked
  → evidenceRefs + completedAt
  → owner + nextAction
```

当前候选的最小阶段顺序是：

```text
source/diff check
  → focused validation
  → required build/full validation
  → ordinary review
  → milestone/Astra review
  → delivery gate
```

每个阶段必须满足以下重入规则：

1. `passed` 只有在候选内容、阶段输入、工具链/依赖和前置阶段证据指纹都未变化时才可复用；重入从第一个 `pending`、`failed`、`blocked` 或 `invalidated` 阶段继续。
2. 代码、测试、配置或依赖变化只使受影响阶段及其下游失效；没有影响映射时按保守规则使下游全部失效，不得凭感觉复用。
3. 未受影响的 focused test、build、review 和已固定的证据可以跳过；跳过必须引用原阶段记录，不能把“上次跑过”当作当前证据。
4. `full validation` 不是每次重入的默认动作：首次候选需要它；之后只有公共契约、构建配置、依赖/工具链、跨模块 owner 或影响映射要求时才重跑。局部改动只跑对应 focused validation 和必要构建。
5. review 的候选范围或代码/配置输入发生变化时，旧 review 只能标记 `invalidated`，不能沿用 PASS；仅阶段重入且输入指纹不变时可复用原 review。
6. `milestone/Astra review` 必须在所有适用前置阶段为当前候选 `passed` 后执行；Astra FAIL 只回到受影响的实现/验证/review 阶段，不重置无关阶段。
7. 任何阶段都必须有唯一 owner、失败原因、下一动作、恢复条件或升级目标。进程中断后依据阶段记录重入，不能以“重新开始”掩盖已完成证据或未收口责任。

最小影响映射如下：

| 变化 | 必须失效 | 可以保留 |
|---|---|---|
| 单模块源代码 | 该模块 focused validation 及所有下游 review/delivery | 其他模块的独立 focused validation |
| 测试文件或测试断言 | 对应测试阶段及下游 review | 未受影响的源代码 build 证据 |
| contracts、公共类型、生命周期或控制协议 | 全部编译/运行验证及下游 review | 仅与候选无关的文档检查 |
| package、锁文件、编译配置或工具链 | 全部适用 build/test/review | 与候选完全无关的静态文档检查 |
| 仅治理文档或阶段记录 | 文档检查；若改变验收契约则使相关实现/review 失效 | 不受契约影响的运行验证 |

Gate 收口时必须同时报告：本次执行的阶段、复用的阶段、被失效的阶段、每个 PASS 的证据引用，以及尚未执行的阶段。这样“跳过”是有依据的证据复用，不是省略验证。

## 9. 与提交闸门的关系

第一版设计完成后，顺序固定为：

```text
设计文档收口
  → 文档一致性检查
  → Astra 独立只读 review
  → 修复 review findings
  → 用户审批
  → 建立远端仓库 clean 基线/worktree
  → 按审批范围提交
```

当前用户已经提供远端仓库地址 [`HumanAgents`](https://github.com/Jasonzhangf/HumanAgents)，但在设计审批前不执行 commit、push 或创建运行时代码。Astra review 通过不自动授权提交；提交仍以用户审批为最终门。
