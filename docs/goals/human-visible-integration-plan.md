# HumanAgent 人类可见三脑整合计划

状态：APPROVED / EXECUTING

用户授权：2026-09-21，批准落盘正式计划，并由 Luna 编排完成显式大脑、隐式大脑、Memory Agent 的整合与调试。

用户追加要求：先报 bug，然后解决。父任务已通过 `appsdk bug intake` 查重并登记以下权威 issue；Luna 必须先用 `appsdk bug show` 读取，后续 worker、测试、review、mainline receipt 和结案绑定这些 ID，不重复建库或报同一问题。

| Bug ID | 对应阶段 | 已登记问题 |
| --- | --- | --- |
| `c6fbc2a` | G1 | 显式入口复制原文，未调用 interaction agent 完成理解 |
| `cf9d7d8` | G2 | 隐式准入固定 execution/零负载，派发由浏览器推动 |
| `80ad80c` | G3 | serve 的 Memory Agent 未绑定配置的模型驱动 |
| `f1dbe10` | G3/G4 | 记忆产品入口缺审核操作，观测借用任务状态 |
| `e30a022` | G0/G5 | 现有 RCC serve 实例缺少当前 memory/identity API |

已查旧 issue `496aed3`（显式 API 接线）和 `3dc9980`（记忆后端 API），它们已关闭且原问题不同，本轮不据此重开。只有满足各 bug 验收并取得当前 mainline receipt 后，使用 `appsdk bug close <id> -m "Solution: ..." --receipt-id <receipt>` 结案。无法交付的保留 open，并记录首个失败边界、原因、owner 和恢复动作。

## 目标与完成定义

从同一个正式产品入口完成：人提交需求 → 显式大脑理解与反馈 → 隐式大脑分类、准入和执行 → 结果交付 → Memory Agent 整理经验 → 人审核 → 后续任务召回使用。

完成 iff：下述 G0–G5 的适用验收全部有当前版本证据，候选通过独立 review，按项目标准交付到 main、重建和重启本地实例、同入口复测、push，并清理本轮临时资源。仅创建计划、启动 worker、通过类型检查、fake 回放或显示 ready，均不算完成。

本计划是本轮整合的唯一任务计划；复用既有 `live-composition-closeout-plan.md`、agent-framework 文档中的 owner 和实现，不重新建设治理框架。阶段执行状态、候选身份和 gate 证据复用项目现有 lifecycle/evidence store；本文件只记录计划、结论和证据引用，不复制事件账本。

## 基线与已知边界

- 首次审计 main：`366da84a538a76f08597ec81f44cd1086a0eb413`。
- 刷新 origin/main：`da26669eba277a20dedb5db49e39f57bd6a8f468`。
- 本轮新 worktree：`playground/human-visible-integration-20260921`；分支：`codex/human-visible-integration-20260921`；创建基线为上述 origin/main。
- main 另有两个观测相关本地提交；整合前核实其 review/归属和后续推进，避免丢失或重复实现。
- 主工作树有既有 `.appsdk/**` 和其他未提交内容；不得清理、覆盖、暂存或纳入本轮提交。
- 其他任务正在处理 observation drawer；本轮不接管其工作树、进程或未交付改动。
- 审计时 RCC 实例在 4552，进程始于 2026-09-18；status 返回 ready，但 memory summary 和 runtime identity 返回 404。10974 是另一个 fake 实例。地址和状态必须在使用时重查。
- 首次审计源码类型检查通过；没有当前三脑真实交互验收。
- 浏览器初次访问 4552 被客户端阻止；不得把 API 证据当作页面验收。
- 下列源码缺口是审计输入，Luna 必须在当前基线重新确认，已有修复应复用。

## 用户路径与 owner

```text
UI 输入
  → Runtime 显式交互 owner → interaction agent → typed decision
  → 新任务按提交确认；已有任务目标/范围变化由人确认
  → RequirementInbox
  → Runtime 后台消费 → 分类/准入 → orchestration
  → execution → review → checkpoint → 用户结果
  → memory boundary event → 独立 memory agent → 候选/审核
  → 后续任务 recall/attach → 结果中可追溯的记忆使用
```

- 领域状态、确认/权限和恢复责任：`packages/core` 与既有 Runtime owner。
- 显式理解和 typed tool admission：`packages/runtime/src/explicit-brain`、`intake`；app 仅组装。
- 分类、实际负载、资源准入和消费：`packages/runtime/src/admission`、`intake`、`orchestration`。
- Memory 分析、事件、scope 与候选：现有 memory runtime/coordinator；app 负责 driver 接线。
- Provider 协议与模型请求：既有 adapters/provider 与 agent driver composition。
- 用户展示：`packages/ui` typed projection 与 `docs/ui` 产品入口；不读原始 Journal、DSH 或 RCC 返回。
- 成功、waiting、blocked、failed、cancelled、停止收拢、资源释放及重启恢复，都必须有 owner 和可检查出口。

## G0：版本、接线和运行入口对齐

完成条件：

1. 核实 origin/main、本地 main、在途工作、实际运行产物和配置，形成准确输入身份。
2. 审核已有 DAG：入口、caller/callee、唯一 owner、终点及证据；缺链先补，禁止扩展断链下游。
3. 指定一个正式验收实例；候选测试使用隔离控制目录和空闲端口，不影响他人实例。
4. 记录 source SHA、产物版本/哈希、进程或 lease 身份、模式和 capability；不得仅用 ready 代表完整能力。
5. MCPX 新 worktree 注册已写入配置；若共享 Runtime 尚未刷新，不擅自重启共享服务。记录不可用边界，按适用规则使用宿主工具，不能借父 workspace 冒充子 worktree。

验证：Git 身份、现有入口与实际 API 对照、`pnpm typecheck`，复用身份一致的既有 PASS。

## G1：显式大脑真实理解闭环

首次缺口：新建页把原文作为 normalizedInput、matchedTasks 固定为空、意图固定 create；已有任务页面用当前 taskId 选择 append。工具执行器存在，但真实理解结果未驱动这些步骤。

完成条件：

1. UI 提交原话与当前上下文；由 interaction agent 产出任务匹配、查询、澄清和提案，Runtime 验证 typed decision。
2. 不以 UI 填写的空匹配或原文复制冒充模型理解，不新增第二个状态机或确认账本。
3. 新任务表单提交即确认；已有任务目标/范围/处理方式变更另行确认；状态查询不入业务队列。
4. 控制命令走正式停止/steer operation，不作为业务需求。
5. 模型失败、非法输出、权限拒绝清晰反馈；不自动退到伪造理解。
6. 接受输入、确认与投递均可恢复，重复提交不重复执行。

验证：先补证明接线缺口的失败测试；`pnpm test:explicit-brain`、受影响 `pnpm test:app`；真实入口验证新建、查询、追加、修改、澄清五种输入。

## G2：隐式大脑后台消费与真实准入

首次缺口：正式派发固定 execution 队列、容量极大、running/queued 固定 0；页面发起 dispatch-next。

完成条件：

1. 已确认需求由 Runtime 持续负责消费，浏览器关闭不影响推进；复用已有事件/调度 owner，不另造并行队列。
2. 分类结果、实际队列负载和可用资源进入唯一准入路径；先实现当前产品需要的类别。
3. 资源不足进入带条件的 waiting；条件满足后继续；重启后不重复执行已领取需求。
4. 复用已实现 execution/review/checkpoint 链；失败、取消、停止收拢与释放均有真实终点。
5. 人能看到当前动作、等待原因、下一动作和交付物；节点投影依据实际事实。

验证：受影响 intake/admission/orchestration focused tests、`pnpm test:app` 和 `pnpm test:runtime`；关闭页面继续、两个任务真实排队、资源解除后恢复、重启不重复执行。

## G3：Memory Agent 分析、审核、召回闭环

首次缺口：run/resume 已有 memoryDriverFactory，serve 未传模型 driverFor；页面 API 缺少 memory 操作；memory 节点借用 task 状态。

完成条件：

1. serve 绑定配置的独立 memory-role agent；角色、操作和模型身份不与执行 agent 混用。
2. 明确区分确定性存取、模型分析和召回注入；RCC 模式不得把无模型候选路径当作模型分析成功。
3. checkpoint 事件单次消费并可恢复；分析失败独立可见，任务成功不代表记忆成功。
4. 人可看候选内容、来源、project/global scope，并批准、拒绝或延期；`auto=false` 保持有效。
5. 下个任务召回已接受记忆，留下来源、绑定和实际 context attach 证据；拒绝内容不生效，跨项目不越权。
6. Memory 操作状态投影取自独立真实状态，不复制任务状态。

验证：`pnpm test:memory`、受影响 memory-agent/app/context tests、`pnpm test:ui`；真实模型分析 → 候选审核 → 下一任务召回与使用，另验拒绝和项目隔离。

## G4：人类可见纵向验收

| 场景 | 输入或动作 | 必须观察到的结果 |
| --- | --- | --- |
| A 新任务 | 读取当前项目 README，整理启动步骤，每条附来源位置 | 真实理解、后台执行、可打开的产物和来源 |
| B 查询 | 现在进行到哪一步？ | 返回当前状态，不新增任务、不重新派发 |
| C 变更 | 增加常见启动失败处理方式 | 提案明确变化，确认后更新正确任务 |
| D 后台 | 提交后关闭页面，再打开 | 后台继续；状态和产物可恢复 |
| E 记忆 | 审核本次可复用启动经验，限定本项目 | 候选内容/来源可读，审核结果持久化 |
| F 复用 | 按本项目约定给出启动检查清单 | 召回已接受记忆，实际注入并影响结果 |
| G 故障 | Provider 失败、停止、服务重启 | 明确失败/等待/停止与下一动作，无假成功、无重复执行 |
| H 隔离 | 拒绝一条候选，并在另一项目查询 | 被拒绝内容不生效；项目记忆不泄漏 |

同时保留 API、实际页面和真实模型三层证据。页面验收受阻则该层标 UNVERIFIED，先完成独立可执行项；不替代为静态截图或 fake 数据。

## G5：独立审查与标准交付

1. 本轮实现者之外独立审查；普通阶段按 AGY + Codex review，整合 milestone 按 Astra。FAIL 修 owner 后只重跑受影响验证及 review。
2. 按项目授权：候选 commit → clean main 集成 → main 重新分配版本并重建 → 重启本地运行实例 → 同入口复验 → push origin/main。
3. dirty main 或并行集成冲突必须保持现有内容，给出具体首个阻断边界与最小解决方案，不通过 stash/reset/删除他人文件绕过。
4. Web/Node 项目不凭空引入 Android、emulator、真机或 OTA 流程；仅对项目现有且受影响的交付物执行适用检查，说明适用性依据。
5. 最终记录 candidate/main SHA、review verdict、产物版本/哈希、实际运行身份、G4 证据和资源回收；缺项只能报 INCOMPLETE/UNVERIFIED。

## Luna 派单与并行边界

- Luna 负责目标、依赖、合同、集成、验收与收口。使用全新 `codex exec --profile gcm` worker；禁止 resume/fork 或注入父 transcript。
- 每个 worker 独占新工作树和明确文件范围；必须说明还有其他执行者，不覆盖或回滚他人变更。
- `cli.ts`、`ui-runtime/service.ts`、`server.ts`、`runtime-api.js` 等共享组装点由单一集成 owner 持有。实现者先交独立模块和测试，再由该 owner 接线；不得平分目标造成重叠写入。
- G0 后锁定 G1/G2 接口；无文件冲突的 Memory 核心和测试可并行。UI 接线等待 typed contract 稳定。G4 依赖 G1/G2/G3。
- 每个合同包含输入 SHA、独占 worktree、允许/禁止路径、完成 iff、具体测试及预期、产物位置、阻塞与回报格式。
- 复用 identity 未变的有效 PASS；按现有 evidence store 记录 reuse/rerun，避免重复全量验证。
- 不接管其他 Desktop 任务；如需 task-to-task 协调只用已发现的 native thread bridge。缺能力时报告，不自建 Collab 身份或冒充 master。

## 非目标与硬约束

不扩展 DSH、向量/RAG、多节点、生产部署或通用平台。无需重写已有 Harness。控制/业务 payload 隔离；Journal 与恢复 owner 不变；持久化在 `~/.humanagent` 下；不改 RCC 配置或凭据；不修改 `.appsdk/**`；不删除他人资源。只修当前主线阻断、安全与数据正确性问题，其余记录后置。

## 初始状态

- 计划已批准；G0 基线和缺陷登记完成，G1、G2、G3 已由 Luna 分配到互相隔离的实现工作树并行执行，G4、G5 依赖候选审查与组合集成。
- 当前不宣称三脑交付完成。
