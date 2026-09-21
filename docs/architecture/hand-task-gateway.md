# Hand Task Gateway

状态：`CANDIDATE / ASTRA-DAG-REVIEWED / DESIGN-FIXED`
范围：Hand 的任务级语义网关、模型路由、流程 recipe、递归执行、失败升级和服务注册

## 1. 设计结论

Hand 不是底层工具目录，也不是一次性 assignment 委任器。Hand 是一个任务网关：编排 Agent 提交完整的任务目标，Hand 根据任务类型选择语义服务、流程版本、模型和函数 Harness，持续执行并验证，直到得到可信交付或明确失败。

```text
编排 Agent
  → Hand Task Gateway
      → immutable service registry snapshot
      → task admission and route selection
      → planner / executor / repairer
      → operation gateway
          → function harness / provider tool
          → verifier
      → durable task report
```

Hand 对外暴露的是高层语义服务，例如 `code.search`、`code.edit`、`code.test`、`code.build` 和 `git.workflow`；`read_file`、`grep`、`list_files`、`diff`、`apply_patch`、shell command 等只能作为服务内部受约束的函数或 operation，不能成为编排 Agent 的原子工具清单。

已有的 `ToolExecutionGateway` 继续作为单个 operation 的生命周期 owner。Task Gateway 位于它之上，负责完整任务的路由、计划、recipe 和恢复；不复制 operation 的 lease、idempotency、verification 或 terminal state。

## 2. 任务网关与 operation 网关

两层必须保持物理和语义分离：

| 层 | 输入 | 唯一责任 | 输出 |
|---|---|---|---|
| Task Gateway | 完整语义任务目标 | 选择服务、模型、recipe 和执行流程；处理递归、重试和升级 | Task Report、result/evidence refs |
| Operation Gateway | 一个已编译的 operation intent | admission、route lease、执行、验证、恢复和幂等 | Operation Snapshot、Operation Result |
| Function Harness | 一个受限原子函数调用 | 文件、进程、patch、解析等实际副作用 | observation 或结构化函数错误 |

Task Gateway 不把 operation 的控制字段复制到业务 payload。`taskId`、`assignmentId`、`executionEpoch`、`serviceVersion`、`recipeDigest`、`attempt` 和 `recovery` 都由 Harness/Journal 控制面保存；模型只提交任务目标和业务约束。

## 3. 对外任务契约

模型和编排 Agent 只提交业务输入，不提交可信身份和控制事实。Gateway 的入口把外部业务输入与 Harness 注入的 typed control context 组合成内部任务；身份来自已认证的调用会话和项目权限绑定，不能由模型填写：

```ts
type HandTaskInput = {
  readonly taskType: 'search' | 'coding' | 'test' | 'build' | 'git'
  readonly workspaceRef: string
  readonly goal: string
  readonly scope?: readonly string[]
  readonly constraints: readonly string[]
  readonly acceptance: readonly string[]
  readonly deliverable: 'report' | 'matches' | 'diff' | 'test-report' | 'build-artifacts' | 'git-result'
}

type HandTaskControl = {
  readonly taskId: string
  readonly requestedBy: string
  readonly assignmentId: string
  readonly executionEpoch: string
  readonly registryDigest: string
  readonly serviceVersion: string
  readonly routeVersion: string
}

type HandTaskRequest = {
  readonly input: HandTaskInput
  readonly control: HandTaskControl
}
```

`goal`、`scope`、`constraints` 和 `acceptance` 是业务输入。模型不提供内部 patch hunk、命令序列、retry counter、route id 或 recipe digest；这些由当前注册快照和 Hand 控制面编译。

Task snapshot 是受信控制事实；它不进入模型业务 payload，但会沿 typed control 边界传给 operation resolve、executor 和 verifier。统一报告保持小而稳定，并显式区分“本次调用已经结束”和“需要恢复责任”：

```ts
type HandTaskReport = {
  readonly taskId: string
  readonly taskType: string
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'reconcile_required'
  readonly terminal: boolean
  readonly summary: string
  readonly resultRef?: string
  readonly evidenceRefs: readonly string[]
  readonly failure?: {
    readonly code: string
    readonly phase: 'admission' | 'planning' | 'execution' | 'verification' | 'reconcile'
    readonly message: string
    readonly nextAction: string
  }
}
```

`succeeded`、`failed`、`cancelled` 是终态；`blocked` 和 `reconcile_required` 是可恢复状态的对外快照，`terminal=false`，除非其恢复责任被显式关闭并转换为 `failed`。报告可以包含服务专属 result artifact，但顶层状态、summary、evidence 和 failure 规则不变。模型不能通过自报 `status=succeeded` 改变 Task 状态；只有 verifier 通过后 Harness 才能提交成功事实。

## 4. 服务注册与动态路由

服务是可挂载、可版本化、可替换的抽象语义。运行时不扫描目录猜测服务；服务必须经过 authoring → validate → compile → load，形成不可变注册快照。

```ts
type HandTaskServiceRegistration = {
  readonly taskType: string
  readonly contractVersion: string
  readonly routeVersion: string
  readonly owner: string
  readonly plannerPolicy: {
    readonly initial: 'none' | 'fast' | 'advanced'
    readonly onFailure: 'none' | 'after-budget' | 'always'
  }
  readonly executorPolicy: {
    readonly modelClass: 'function' | 'fast' | 'advanced'
    readonly maxAttempts: number
  }
  readonly repairPolicy: {
    readonly modelClass: 'none' | 'advanced'
    readonly maxRepairs: number
    readonly onVerificationFailure: 'never' | 'policy'
  }
  readonly recipePolicy: {
    readonly required: boolean
    readonly reusable: boolean
  }
  readonly operationKinds: readonly ('inspect' | 'apply' | 'run' | 'verify')[]
  readonly verifierRef: string
  readonly benchmarkRef: string
}
```

`maxAttempts` 按 `taskId + nodeId + planRevision + executionEpoch` 计数，只有一次真实 executor operation 产生不可接受结果后递增；重启恢复、读取旧 observation 和等待 retry 不递增。repair 创建新的 `planRevision`，不会删除或重置旧 revision 的计数；新 revision 有独立计数，但旧计数仍保留在 Journal 中。`maxRepairs` 按 Task 计数，repair 失败或耗尽后进入 `failed`，不得再次自动递归。

动态修改不能直接替换正在运行的服务：

```text
authoring candidate
  → schema/policy validation
  → compile deterministic snapshot
  → benchmark and regression
  → independent review / Astra gate
  → activate registry snapshot
```

每个 Task 在 admission 时绑定 `registryDigest`、`serviceVersion` 和 `routeVersion`。运行中的 Task 始终使用原快照；新版本只影响新的 Task 或经过明确迁移的 Task。Task Gateway 每次创建 operation intent 时，都从该快照解析 `serviceVersion + routeVersion + operationKind`，并把同一绑定交给 Operation Gateway 的 route lease、executor 和 verifier；Operation Gateway 拒绝当前 registry 中不存在该版本的 resolve。旧版本实例或可重载的不可变快照，必须在所有绑定它的 Task、operation、blocked/reconcile obligation 和取消收拢责任关闭前保持可用；仅进入 reconcile 不能释放旧版本。不能只在 Journal 里记录 digest 而改用当前实现。

路由更新的控制事实属于 registry owner，不进入 Agent prompt、request payload 或普通日志。动态路由只能通过受控的 register/activate operation 修改，失败必须保留原注册快照。

## 5. 统一执行 DAG 与状态机

静态执行计划是 DAG；重试和升级是有限的控制回边，不能把它们伪装成新的线性成功步骤。静态 plan 与运行时状态机是两份不同的契约：DAG 描述“哪些节点依赖哪些节点”，状态机描述“一个 Task 当前能否继续、等待恢复还是结束”。合法状态转移由 `packages/core` 负责，调度、恢复和节点推进由 `packages/runtime` 负责，operation 的执行/settle 仍由 Operation Gateway 负责。

### 静态 plan 契约

当前只要求线性和有限分支，不要求提前建设通用图执行器。编译后的 plan 必须显式包含依赖和必需终点：

```ts
type TaskPlan = {
  readonly planRevision: string
  readonly nodes: readonly TaskPlanNode[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
  readonly requiredTerminalNodes: readonly string[]
  readonly digest: string
}

type TaskPlanNode = {
  readonly nodeId: string
  readonly nodeType: string
  readonly operationKind: 'inspect' | 'apply' | 'run' | 'verify'
  readonly inputRefs: readonly string[]
  readonly outputRefs: readonly string[]
  readonly preconditions: readonly string[]
  readonly successCondition: readonly string[]
  readonly failureCondition: readonly string[]
}
```

Plan 编译必须拒绝未知节点、环、缺失依赖、重复 node id 和没有 required terminal node 的图。retry、repair 和 reconcile 不增加一个假成功节点；它们只改变控制状态或生成新的 `planRevision`。

### 运行时状态迁移表

下表是唯一的状态出口。每一行的事实都先写入 Organ Journal，再触发下一步调度；`blocked`、`reconcile_required` 不是终态。

| 当前状态 | 事件/guard | 下一状态 | owner 与必须持久化的事实 |
|---|---|---|---|
| `received` | 输入、身份和 scope 合法 | `admitted` | core：task control、admission evidence |
| `received` | 输入/权限/scope 不合法 | `failed` | core：首次根因、failure code、next action |
| `admitted` | 当前 registry snapshot 可解析 | `route-bound` | runtime：registry/service/route binding |
| `admitted` | route 暂不可用但可恢复 | `blocked` | core/runtime：恢复责任和 retry obligation |
| `admitted` | route 不存在或权限拒绝 | `failed` | core：不可恢复根因 |
| `route-bound` | recipe 必需且存在、fingerprint 匹配 | `plan-ready` | runtime：recipe digest/revision |
| `route-bound` | recipe 缺失或 stale | `planning` | runtime：planning obligation、source fingerprint |
| `blocked` | 原因消除且 obligation/epoch 仍匹配 | `route-bound`、`plan-ready` 或 `executing` | runtime：消费 obligation；不得更换 registry snapshot |
| `blocked` | cancel obligation 已 settle | `cancelled` | core/operation owner：停止和副作用收拢证据 |
| `blocked` | 恢复责任被明确关闭或不可恢复 | `failed` | core：保留首次根因和恢复失败证据 |
| `planning` | plan schema/scope/dependency 验证通过 | `plan-ready` | runtime：plan revision/digest |
| `planning` | planner 不可用或输出非法 | `failed` 或 `blocked` | core：不可恢复则 failed；依赖外部恢复则 blocked |
| `plan-ready` | 有满足依赖的未完成节点 | `executing` | runtime：node id、attempt、operation identity |
| `plan-ready` | 没有未完成节点且 required terminal nodes 已通过 | `verifying` | runtime：plan completion evidence |
| `executing` | operation 成功返回 | `verifying` | operation owner：observation/result/effect state |
| `executing` | 可重试失败且 attempt 未耗尽 | `retry-waiting` | core：递增后的 attempt、retry obligation、operation id |
| `executing` | 可重试失败且 attempt 已耗尽 | `escalating` | core：budget-exhausted、全部 attempts |
| `executing` | 副作用未知或 settle 不完整 | `reconcile_required` | operation owner：unknown effect、settle obligation |
| `executing` | scope/权限/完整性不可恢复失败 | `failed` | core：首次根因和部分结果 refs |
| `retry-waiting` | obligation 可恢复且 lease/epoch 匹配 | `executing` | runtime：新的 operation identity；不复用 failed operation |
| `retry-waiting` | route/资源仍不可用 | `blocked` | runtime：下一次唤醒条件 |
| `escalating` | repair 预算可用且 repairer 可用 | `repairing` | core/runtime：repair count、原因、旧 plan ref |
| `escalating` | repair 预算耗尽或不可恢复 | `failed` | core：首次根因、预算耗尽、全部证据 |
| `repairing` | 新 plan/recipe revision 验证通过 | `plan-ready` | runtime：新 revision；旧 revision 不覆盖 |
| `repairing` | repairer 失败/非法输出 | `failed` | core：repair failure、原始根因 |
| `reconcile_required` | operation owner 核实结果并 settle | `verifying` 或 `plan-ready` | runtime：节点 effect/result；只调度未完成且依赖满足节点 |
| `reconcile_required` | 存在 cancel obligation 且 stop/settle 已完成 | `cancelled` | core/operation owner：取消意图和最终 effect state |
| `reconcile_required` | 无法核实副作用 | `blocked` | core/runtime：reconcile obligation、恢复责任 |
| `verifying` | TaskCompletionGate 通过全部 required nodes | `succeeded` | core：最终 tree/result/evidence refs |
| `verifying` | 当前 node 验收通过但仍有 required nodes 未完成 | `plan-ready` | runtime：node settled evidence、下一组满足依赖的 nodes |
| `verifying` | 验证失败且允许 repair | `escalating` | core：verification evidence、repair reason |
| `verifying` | 验证失败且不允许 repair | `failed` | core：verification failure |
| 任一可运行状态 | cancel requested | `cancel-requested` | core：取消命令和 epoch |
| `cancel-requested` | stop/settle 完成 | `cancelled` | operation owner：停止和副作用证据 |
| `cancel-requested` | stop/settle 失败或副作用未知 | `reconcile_required` 或 `blocked` | operation owner：settle/reconcile obligation |

`cancel-requested` 产生的 `cancel obligation` 是持久化控制条件。它存在时，`blocked`/`reconcile_required` 不得恢复到 `executing`、`plan-ready` 或普通 `verifying`；收拢成功只能进入 `cancelled`，无法收拢则继续保留恢复责任或按明确策略 `failed`。

`failed`、`succeeded` 和 `cancelled` 才是终态；`blocked` 和 `reconcile_required` 对外可以立即返回 `terminal=false` 的 durable snapshot，但必须保留恢复责任。若恢复责任被人工/策略明确关闭，才将其转换为 `failed`，不能把暂时不可继续包装成成功。

状态不变量：

- `succeeded` 只能由 verifier 通过后产生；模型的 completion proposal 不是成功事实。
- `failed` 必须保留首次根因、失败阶段、owner、evidence 和 next action。
- `retry-waiting` 必须有持久化 retry obligation；重启后恢复同一 obligation，但真正再次执行必须创建新的 operation identity；同一 `taskId + nodeId + planRevision + executionEpoch + attempt` 只允许一个 operation。
- `escalating` 必须带 `reason=executor-budget-exhausted` 或 `reason=verification-repair-requested`；前者要求 executor 达到上限，后者要求 registration 的 `onVerificationFailure=policy` 且 repair 预算可用；不能无限递归调用模型。
- `repairing` 生成新 plan 或 recipe revision，但不能覆盖已经绑定的旧 revision。
- 发生未知外部副作用时进入 `reconcile_required`，禁止直接重做。
- `cancelled` 不是收到取消请求就成立；必须有实际停止和 settle 证据。
- 状态和 DAG 节点都绑定 task、assignment、execution epoch、plan revision 和 registry snapshot。

每个运行时 DAG 节点还必须具有：

```text
nodeId
nodeType
planRevision
dependencyNodeIds
inputRefs
outputRefs
owner
attempt
operationIdentity
inputTreeDigest
outputTreeDigest
observationRefs
preconditions
successCondition
failureCondition
nextAction
```

模型可以提出 plan node，但 Harness 只接受通过 schema、scope、权限、版本和前置条件检查的节点。模型不能自行增加一个未注册的 route，也不能跳过 verifier 节点。

## 6. 模型路由策略

模型按任务阶段路由，不按模型名称写死：

| 任务 | 首次规划 | 正常执行 | 失败升级 |
|---|---|---|---|
| `search` | `none` 或 fast | function harness / fast | 无需升级，范围问题返回结构化报告 |
| `coding` | advanced | advanced 或受控 coding executor | advanced repair |
| `test` | fast 或 function | fast/process harness | advanced 解释测试失败并提出修复建议 |
| `build` | advanced（初始化或 recipe 失效时） | fast/process harness | 达到失败上限后 advanced 修复 recipe/流程 |
| `git` | advanced（复杂流程） | fast/process harness | advanced 接管状态分析；高风险动作仍需 policy gate |

模型路由结果同样是控制事实：

```text
Task Gateway admission
  → model capability/health/permission check
  → bind planner/executor/repairer provider
  → freeze binding for current attempt
```

如果模型不可用，不允许静默降级到另一个模型。只有注册策略明确允许的下一类模型才能被选择，并且要记录新的 binding、原因和 execution epoch。

## 7. Recipe 与流程记忆

Recipe 是可验证的执行流程，不是模型聊天记录。它至少包含：

```ts
type TaskRecipe = {
  readonly recipeId: string
  readonly taskType: string
  readonly workspaceFingerprint: string
  readonly sourceRevision?: string
  readonly routeVersion: string
  readonly stages: readonly {
    readonly stageId: string
    readonly operationRef: string
    readonly inputSchema: string
    readonly preconditions: readonly string[]
    readonly successEvidence: readonly string[]
  }[]
  readonly createdBy: string
  readonly digest: string
}
```

Recipe 的持久化位置是 `~/.humanagent` 下的受控 artifact/control store；workspace 只提供执行上下文和临时构建输出。临时输出不是权威 artifact；recipe、diff、日志证据、恢复状态和成功标记最终都必须写入 `~/.humanagent`。Recipe revision、失败次数和激活关系不能依赖 workspace 文件或模型上下文恢复。

Recipe activation 只允许 Organ Journal 提交以下有序事实：

```text
candidate artifact persisted
  → candidate validated against exact workspace fingerprint/source revision
  → first execution observations persisted
  → required verification passed
  → active-recipe pointer compare-and-set(candidate digest, fingerprint)
  → task records recipe activation and continues
```

恢复时按 Journal 重放：候选 artifact 已存在但没有验证事实则继续验证；验证存在但没有 activation pointer 则重新做 fingerprint/verification 后尝试 compare-and-set；pointer 已激活但 Task 成功记录缺失则恢复 Task，而不是重复 build。fingerprint 至少覆盖项目配置、锁文件、构建入口、相关源码 revision 和 route/recipe contract version。并发初始化只有一个匹配 fingerprint 的 candidate 能激活；source 变化时 candidate 变为 stale。

Task 的恢复提交顺序同样由 Journal 约束：

```text
state transition + node attempt + operation identity
  → operation observation/result/effect state
  → verifier result
  → retry obligation 或 next runnable node
```

每个箭头都是可重放的追加事实，Task snapshot 由 Journal 重建；不得用内存 Map、普通日志或模型上下文作为恢复真相。重启时先读取最后一个合法 snapshot 和未完成 obligation，再向 Operation Gateway 查询对应 operation 的 durable settlement；没有 settlement 就保持 `reconcile_required`/`blocked`，不猜测成功，也不启动相同 operation 的第二个副作用。

### Build 初始化

```text
build request
  → 检查 workspace fingerprint 和 active recipe
  → 无 recipe/recipe stale
  → advanced planner 生成候选 recipe
  → Harness 校验 stage、命令引用、输出和权限
  → 首次执行并验证
  → 成功后激活 recipe
```

### Build 常规执行

```text
active recipe
  → fast executor 执行 stage
  → 每个 stage 独立验证
  → 全部通过 → build success
  → 可恢复失败 → 有界重试（总计最多 3 次 fast executor 尝试）
  → 第 3 次仍失败 → advanced repair 一次
  → repair 失败或修复预算耗尽 → failed
```

Build 的“三次失败”是同一 Task、同一 stage/plan revision、同一 execution epoch 下的三次真实 fast executor 尝试，包含首次尝试；重启、等待和 reconcile 不重置计数，也不重复计数。第三次失败只创建一个 escalation obligation。advanced repair 可以生成新 recipe/plan revision，但不能把旧的三次失败清零；新 revision 的尝试计数从 1 开始，并受该 Task 的 `maxRepairs` 限制。

高级模型修复的是 recipe 或流程，不直接伪造一次成功结果。修复后产生新的 recipe revision，经过验证才能成为 active；旧 recipe 仍可用于审计和回滚判断，但不能在当前 repair attempt 中被静默覆盖。

## 8. 服务语义

### `search`

`search` 负责在给定 workspace/path/query/kind 下交付命中、完整性和范围边界。`scope-too-large` 必须返回 bounded `pathTree`，不能把部分搜索包装成完整成功。现有 `code.search` 是第一条实现服务。

### `coding`

`coding` 接收目标、上下文、允许范围和验收条件。高级模型可以生成修改方案，Hand 负责把方案分成有序、可验证的连续编辑步骤；每一步重新确认上下文，最后交付 diff artifact、changed paths、验证结果和失败原因。

每个连续编辑步骤都必须在 Journal 中绑定：执行前 tree/content digest、`operationIdentity`、执行后 digest、changed paths 和验证 evidence。步骤 A 成功、步骤 B 冲突/中断时，A 的结果保留为部分结果，B 不得盲目重放；先由 Operation Gateway 做只读核对，确认当前 tree 是否等于 A 的 output digest。若不能确认，进入 `reconcile_required`；若能确认，则只从第一个未完成且前置条件满足的步骤继续。最终 diff、测试和 scope 验证必须引用同一个最终 tree digest；失败报告必须包含 partial result refs。外部修改、取消或未知副作用不得被 repairer 静默覆盖，回滚也必须是显式授权的独立操作。

### `test`

`test` 接收 target/profile/完整性要求。实际命令通过项目 allowlist 或已验证 recipe 解析，模型不得自由拼接 shell。报告必须保留 exit code、阶段、测试汇总、stdout/stderr artifact 和是否完整执行。

### `build`

`build` 先处理 recipe 初始化和 source/workspace fingerprint，再运行阶段化流程。成功必须同时满足命令、阶段和预期 artifact verifier；未知产物状态进入 reconcile，而不是重跑破坏现场。

### `git`

`git` 也可使用同一 Task Gateway，但必须绑定精确 worktree、branch、base 和 source tree。status/diff 属于低风险 inspect；commit/merge/push 属于 policy-gated apply/delivery；reset、回滚、删除和 force push 不得成为无条件自动修复步骤。

## 9. 失败、递归与交付

Hand 的递归是受状态机和预算约束的递归，不是模型无限自调用：

```text
执行器返回真实结果
  → Task Gateway 判断可恢复性
  → 可恢复：更新 retry obligation，继续当前 recipe
  → 达到当前 executor 预算且策略允许：调用 repairer
  → repairer 产生新 plan/recipe revision
  → 重新进入 verifier 约束下的执行
```

失败分类至少包括：

- `invalid-request`：任务目标、scope 或 contract 不合法；不重试；
- `route-unavailable`：注册服务或当前版本不可用；进入明确 blocked；
- `executor-failure`：进程、模型或函数 Harness 失败；按策略有限重试；
- `verification-failure`：结果不满足验收；只有 registration 明确允许且 repair 预算可用时交给 repairer，否则失败；
- `scope-violation`：越权路径或越权操作；立即失败；
- `unknown-side-effect`：副作用状态不确定；进入 reconcile；
- `recipe-stale`：流程与 workspace/source 不匹配；进入 advanced planning；
- `budget-exhausted`：当前执行器达到上限；仅触发一次明确的 escalation obligation，不继续盲重试；repair 耗尽后失败。

交付结果必须区分：

```text
执行成功 ≠ 验证成功
部分结果 ≠ 完整任务成功
模型声称完成 ≠ Harness 完成
retry accepted ≠ retry delivered
```

只有 `TaskCompletionGate` 验证 result/evidence、scope、recipe/route revision 和所有 required stages 后，才提交 `succeeded`。

## 10. 动态更新和 Memory Agent 边界

在线任务不依赖 Memory Agent 才能完成。Memory Agent 只在 idle 时：

1. 统计服务历史中的成功率、失败类型、重试次数、耗时和 recipe 漂移；
2. 发现可抽象为新 semantic service 的重复编排任务；
3. 生成 service/route/harness/verifier/benchmark candidate；
4. 经过 benchmark、回归、权限检查和独立 review 后提出 activate。

Memory Agent 不能直接修改 active registry、当前 Task 的 route snapshot、recipe revision 或成功状态。服务升级必须回到 authoring → validate → compile → review → activate 流程。

## 11. 当前实现映射与非目标

当前可证明实现：

- `ToolExecutionGateway` 提供 operation 生命周期、幂等、恢复和 verifier 入口；
- `code.search` 提供第一个 Hand service、function harness、报告和 route verifier；
- orchestration 模板已声明优先使用 `code.search`，execution 的底层 `search/coding/test/build` 保留。

本设计不宣称以下能力已经接通：

- 生产 Agent → Hand Task Gateway 的真实 dispatcher；
- `code.edit`、`code.test`、`code.build`、`git.workflow` 的具体 route；
- build recipe store 和动态 service registry 的 live composition；
- 高级/快速模型的真实 planner/executor/repairer 路由；
- 多轮 provider tool call 到 Hand task report 的 live replay。

这些是后续实现任务，必须分别提供 contract、route、verifier、focused benchmark、failure replay 和 live composition 证据。

## 12. 验收 DAG

```text
task contract
  → service registration
  → deterministic compile/load
  → admission and snapshot pinning
  → planner/executor route
  → operation gateway
  → function/provider execution
  → verifier
  → retry/escalation/reconcile
  → terminal task report
```

设计审查必须检查每条边都有唯一 owner、数据或控制事实来源、失败出口和验证证据。不能只审查某个 service 的函数测试就宣称 Task Gateway 已接通。

### 设计修复后的关键回放

`coding` 部分成功：A 节点写入并记录 `outputTreeDigest=A1`，B 节点在写入前冲突。Task 进入 `reconcile_required`；Operation Gateway 只读核对当前 tree。核对为 A1 后，Journal 把 A 标为 settled、B 保持未完成，Task 回到 `plan-ready`，只调度 B；核对失败则保持 `blocked` 并报告恢复责任。最终 `diffRef` 和测试 evidence 必须都绑定最终 tree digest。

`build` 初始化中断：candidate recipe artifact 已保存，首次执行产生输出但进程在 activation 前退出。重启从 Journal 发现 candidate、observations 和缺失的 active pointer；先重新确认 fingerprint 和 required verification，再 compare-and-set 激活。若 fingerprint 已变，candidate 标记 stale 并回到 `planning`；不重复运行未知副作用的 build。

这两条回放覆盖了部分成功、未知副作用、重启、版本冻结和交付证据绑定；后续实现必须以它们作为正向和负向 benchmark，而不是只测模型是否生成了计划。

后续实现建议顺序：

1. `code.test`：验证任务契约、process harness、阶段报告和失败升级；
2. `code.build`：增加 recipe、artifact、fingerprint 和初始化/复用；
3. `code.edit`：增加 scope-safe edit、连续 hunk、diff artifact 和验证；
4. `git.workflow`：增加 worktree/branch/merge/push policy gate；
5. dynamic registry activation：把新服务版本纳入 authoring/review/activate 生命周期。
