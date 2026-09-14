# HumanAgent 宿主、启动和 Cordis 插件化架构

状态：`MVP-IMPLEMENTATION / DSH-BASELINE-LOCKED`
日期：2026-09-11  
适用阶段：MVP → Milestone 3

本文定义 HumanAgent 如何以 Cordis 为第一层插件宿主独立启动，如何装载固定 Harness 内核和可替换模块，如何在外部安装 DSH，以及如何把 DSH 作为一种 Agent/Execution provider 接入。Provider 协议和 RCC v3 临时绑定由 [`provider-adapters.md`](provider-adapters.md) 唯一维护。当前 DSH 源码基线已锁定；真实 adapter 仍需公开入口、profile、能力和同入口验证后才能实现，详见 [`dsh-baseline.md`](dsh-baseline.md)。

## 1. 设计结论

HumanAgent 自己是产品宿主和固定编排的 owner；Cordis 是 HumanAgent 的插件生命周期和模块组装宿主；DSH 只是其中一种可替换的 Agent/Execution provider。Cordis 只进入 `app/cordis-host` 和具体插件实现，不成为 `contracts/core` 的领域依赖。

```text
HumanAgent CLI / Host Supervisor
  └── HumanAgent Cordis Host
        ├── fixed Harness Kernel plugins [不可替换控制面]
        │     ├── lifecycle / gate / node protocol
        │     ├── Journal / checkpoint / control
        │     ├── queue / resource / review / supervision
        │     └── health and evidence policy
        ├── node orchestration plugins [策略可替换，协议固定]
        ├── agent registry / template plugins
        ├── memory interaction plugin
        ├── memory operations backend plugin
        ├── Journal / Index / asset adapters
        ├── UI projection plugins
        └── Agent Driver / Execution provider plugins
              ├── deterministic/fake（MVP）
              ├── DSH + Cordis bridge（Milestone 1）
              ├── native
              └── remote/other
```

固定 Harness 不是一个可选插件集合，而是由 `core/runtime` 定义、由 Cordis Host 挂载的不可绕过内核。节点内的编排策略、Agent Driver、存储、Memory backend、输入源和 UI projection 可以替换；插件不能重排确认门、资源准入、节点生命周期、checkpoint、review、settle、健康和错误 owner。插件注册到已声明的 typed seam，重复注册、未声明 capability 或试图覆盖内核 owner 都必须失败。

## 2. 进程与责任边界

推荐的 Milestone 1 起步形态是一个 HumanAgent Cordis Host 加一个受监督的外部 provider 进程：

```text
humanagent Cordis host
  owns: Task, Organ, Journal, checkpoint, queue, lease,
        fixed Harness, node lifecycle, health, UI projection, control
  mounts: kernel plugins, node strategies, templates, memory,
          journal/index/assets and Agent Drivers
        │ typed IPC / local authenticated transport
        ▼
DSH execution provider
  owns: DSH profile, Cordis tree, model, tools,
        DSH session log and native execution events
```

### HumanAgent host

- 读取并验证 HumanAgent profile 和 plugin lock；
- 挂载必需的 core plugins 和明确列出的 extension plugins；
- 接收显式交互 agent 的 `RequirementEnvelope`；
- 管理编排 agent runtime pool 和 worker/review/memory binding；
- 通过 `ExecutionRuntimePort` 请求一次具体执行；
- 将执行事件映射成高层 operation、node、evidence 和 checkpoint；
- 运行 Harness health probe 和 supervision；
- 为 UI 提供自己的 projection，不把 DSH WebUI 当作产品壳。

### DSH execution provider

- 使用单独安装的 DSH 和专用 profile；
- 根据 HumanAgent adapter 的请求创建/恢复 DSH session；
- 按 profile 装载 DSH Cordis bundles、模型、工具和 sandbox；
- 返回 DSH session/tool/model 事件和原生证据引用；
- 对 cancel/close/settle 提供真实后置结果。

DSH provider 不能直接写 Organ Journal、修改 Task lifecycle、发布 HumanAgent Attention、创建 review 或修改模板 registry。它的 session ID 只能作为 adapter 生成的 evidence locator。

### Milestone 1 的 RCC Provider 绑定

Milestone 1 暂时允许 DSH provider 通过本机 RCC v3 `4444` listener 获取模型
执行，但这只是一个外部 endpoint binding，不改变 DSH 或 HumanAgent 的身份边界：

```text
HumanAgent Host
  → DSH/Provider adapter
    → RCC v3 :4444
       ├── cc / cc-sol: Responses
       └── goaichat: Anthropic
```

`cc`/`cc-sol` 可以复用 Responses codec；`goaichat` 必须使用独立 Anthropic
codec。Host 不把 RCC route、model、auth alias 或 session id 写入高层 Task、
checkpoint 或业务 payload。`~/.rcc` 由外部 RCC 管理，HumanAgent 只做只读
readiness/capability 检查和非敏感 lock 摘要；协议未知或绑定不可证明时必须
停在 `capability-unavailable`，不能猜测 codec 或静默切换 provider。

MVP 可以把 fake backend 放在同一个 standalone 进程中，以减少安装面；这不改变上述端口边界。

## 3. 独立安装和启动

### 3.1 安装责任

DSH 是独立依赖，不由 HumanAgent 在运行时静默下载、升级或替换：

1. 使用方按 DSH 发布方式单独安装 DSH CLI/运行包；
2. HumanAgent 通过 `doctor` 检查 `dsh --version`、可执行路径、支持的 adapter API 和运行权限；
3. HumanAgent 创建自己的 DSH profile，例如 `humanagent`，并使用 HumanAgent 管理的独立 `DSH_HOME`，不读取或修改用户默认 `web` 或其他 profile；
4. 通过 DSH 官方 profile plugin 管理流程安装已批准的 HumanAgent DSH plugin/bundle；
5. 安装完成后锁定 package、版本、digest、profile manifest 和 patch 层；
6. 只有 preflight、模板/插件校验和 health probe 全部通过，Host 才进入 `ready`。

目标级命令形态如下，命令名是 HumanAgent 设计契约，DSH 命令以当前 clean 版本验证为准：

```sh
# HumanAgent 自己的 profile 和本地数据
humanagent init --profile default
humanagent doctor

# 独立检查外部 DSH，不在这里隐式安装
humanagent doctor --executor dsh

# 使用 DSH 官方 profile plugin 管理命令安装 HumanAgent 执行插件
dsh plugin --profile humanagent add <approved-humanagent-dsh-plugin>

# 独立启动 HumanAgent，Host 决定何时连接 DSH
humanagent start --profile default --executor dsh --dsh-profile humanagent
```

`<approved-humanagent-dsh-plugin>` 不是当前已发布包名；在 Milestone 1 绑定实际 package、entrypoint、版本和 license 后才能替换为具体值。

### 3.2 启动阶段

```text
resolve home/profile
  → read manifest + lock
  → validate schema/path/digest/compatibility
  → load mandatory core
  → load explicit extension plugins
  → initialize Journal/Index/Health/Template Registry
  → start or connect execution provider
  → run readiness probes
  → publish ready
  → accept input
```

任何阶段失败都要停止在明确状态：`config-invalid`、`plugin-invalid`、`dependency-missing`、`capability-unavailable` 或 `health-blocked`。不允许用 fake backend、旧模板或默认工具静默替代失败的 DSH profile。

### 3.3 关闭和更新

插件集合、DSH 版本、模板 registry 或 tool capability 改变时，默认采用“新配置验证 → 停止接收新任务 → 当前任务按策略等待/收拢 → 优雅停止 → 新进程启动 → readiness probe → 恢复 checkpoint”。专用 profile 的 patch 来源固定为该 profile 的锁定 bundle patch、该 profile 的锁定 `cordis.patch.yml` 和 HumanAgent 明确传入的 approved overlay；不加载共享 home-level patch，不接受任意调用目录 overlay。Milestone 1 固定 `patchReload: startup`，配置变化必须重启。

MVP 和 Milestone 1 不做活动执行中的任意热换插件。Cordis 的 patch 热重载能力不能绕过 HumanAgent 的 execution epoch、资源 lease 和 checkpoint 收拢门。M1 中如果更新会改变活动 Task 依赖的 plugin/template/profile，更新必须拒绝，或保留旧的已锁定 profile 直到活动 Task 收拢；不在 M1 承诺仅凭 digest 迁移旧 Task。

## 4. Cordis 的使用边界

DSH 当前设计提供了几个可以复用的工程模式：所有能力以插件挂载、profile 以 bundle 和有序 patch 组合、服务通过 Definition/Provider/Consumer seam 连接、插件 dispose 时撤销副作用。HumanAgent 采用这些模式，但不复制 DSH 的领域事件和 session 类型。HumanAgent 的 Cordis Host 是更高层的组装面，DSH 的 Cordis profile 只在 DSH provider 内部出现。

### 4.0 Host plugin tree

```text
Cordis Host
  ├── HarnessKernelPlugin              fixed, unique owner
  ├── NodeProtocolPlugin               fixed contract
  ├── NodeStrategyPlugin(s)            replaceable policy
  ├── AgentTemplateRegistryPlugin      replaceable data/loader
  ├── AgentDriverPlugin(s)             fake / DSH / native / remote
  ├── MemoryInteractionPlugin          user-facing memory surface
  ├── MemoryOperationsPlugin(s)        deterministic / RAG / Memmy adapter
  ├── JournalIndexAssetPlugin(s)       storage ports
  ├── HealthSupervisionPlugin          fixed owner facade
  └── UiProjectionPlugin(s)            read models and command facades
```

`HarnessKernelPlugin` 注册固定生命周期和唯一 owner；其他插件只能依赖它提供的 typed seam，不能提供同名的控制资源。Cordis 的注册顺序、dispose 和 dependency resolution 解决“如何装载”，不决定“任务是否可以越过 Harness gate”。后者仍由 `core` 的纯规则和 `runtime` 的唯一 owner 决定。

### 4.1 HumanAgent plugin API

HumanAgent 需要自己的、框架无关的 plugin manifest：

```ts
type HarnessPluginManifest = {
  kind: 'humanagent.plugin'
  pluginId: string
  version: string
  apiVersion: number
  entry: string
  dependencies: string[]
  provides: string[]
  consumes: string[]
  permissions: string[]
  configSchemaRef?: string
  digest: string
}

interface HarnessPlugin {
  manifest: HarnessPluginManifest
  register(context: HarnessPluginContext): void
  start?(): Promise<void>
  dispose?(): Promise<void>
}
```

上面的 manifest 和接口是 HumanAgent 自己的框架无关契约；`app/cordis-host` 负责将它映射为 Cordis 的 Definition/Provider/Consumer 和生命周期 hook。`HarnessPluginContext` 只暴露注册过的 typed seam，例如 `registerNodeStrategy`、`registerAgentDriver`、`registerMemoryInteraction`、`registerMemoryOperations`、`registerInputSource`、`registerAssetStore`、`registerHealthProbe` 和 `registerUiProjection`。没有通用的“拿到 root context 后任意修改状态”入口。

同进程 plugin 是受信任代码，不等同于 sandbox：它拥有宿主进程的语言运行时权限。默认选择独立 DSH provider 进程；若未来允许同进程 plugin，必须额外通过 signed/allowlisted package、API compatibility、permission review 和独立 test fixture，且仍只能拿到 capability facade。manifest 中的 `permissions` 是 Harness 的准入输入，不是对恶意代码的安全隔离承诺。

### 4.2 Cordis bridge

Cordis bridge 是一个 adapter：

```text
HumanAgent typed seam
  ↕ bridge mapping
Cordis Definition / Provider / Consumer
  ↕
DSH profile plugin tree
```

桥接层负责：

- 将 HumanAgent `ExecutionRuntimePort` 映射到 DSH session/agent/tool 能力；
- 把 DSH 事件映射为带 `taskId`、`operationId`、`executionEpoch` 的高层 execution event；
- 把 DSH session log 保存为 evidence ref；
- 将 stop request 映射为 DSH cancel/close，并等待实际 settle；
- 在 DSH plugin dispose 时释放进程、transport、session subscription 和 lease。

桥接层禁止：

- 将 DSH `SessionId` 作为 `TaskId`、`CheckpointId` 或 `AgentRuntimeId`；
- 从 DSH debug log 重建 HumanAgent 控制状态；
- 把 DSH 的 profile config 直接当作 HumanAgent agent template；
- 让任意 Cordis plugin 直接消费 HumanAgent Journal；
- 通过 prompt 或 metadata 携带 retry、steer、health、checkpoint 等控制字段。

## 5. 固定编排和插件 seam

固定流程由 core/runtime 保证，插件 seam 只位于边界：

```text
input source plugin
      ↓
interaction confirmation gate       [fixed]
      ↓
RequirementInbox / queue             [fixed]
      ↓
classification + resource admission [fixed]
      ↓
orchestration runtime pool           [fixed]
      ↓
WorkAssignment                      [fixed]
      ↓
execution provider plugin
      ↓
typed WorkResult                     [fixed]
      ↓
review coordinator + remediation     [fixed]
      ↓
memory review                        [fixed binding]
      ↓
checkpoint completion / settle       [fixed]
```

允许插件提供：

- 新的输入源，例如 webhook、通知或本地目录观察；
- 新的节点编排策略，但只能实现已定义的 `NodeOrchestrator` 生命周期；
- 新的 Agent Driver/执行后端，例如 fake、DSH、native、远端 sandbox；
- 新的 worker tool capability；
- Memory Interaction Surface 和新的 memory/RAG Operations adapter；
- Agent Context Injection 的 Index/召回实现；
- 新的 Journal asset store 或 Index projection；
- 新的 health probe；
- 新的 UI projection 或通知 delivery。

不允许插件改变：

- 显式确认前不得入 FIFO；
- 没有资源/权限/恢复条件不得创建 pipeline；
- 编排 agent 是 manager，不能变成 worker；
- review failure 必须经过整改和复审；
- 每个 Task 必须绑定 memory scope/runtime；是否启动 AI memory agent 由流程和能力决定；
- 健康 owner 是 Harness；
- stop 必须经过 operation settle 和 stopped checkpoint；
- Journal 是高层状态真源。

## 6. Profile、插件和模板的隔离

建议为 HumanAgent 和 DSH 分别保存 profile：

```text
$HUMANAGENT_HOME/
  profiles/default/
    humanagent.manifest.json
    humanagent.lock.json
    agent-templates/
    plugins/
    config/
  journal/
  assets/
  runtime/

$DSH_HOME/
  profiles/humanagent/
    package.json
    pnpm-lock.yaml
    cordis.patch.yml
    node_modules/
```

HumanAgent profile 保存高层 plugin/template 配置和锁；DSH profile 保存 DSH bundle 依赖和 Cordis patch。两者通过 adapter manifest 的绑定关系连接，不互相读取对方的配置文件作为状态真源。

三种内容必须分开：

- `HumanAgent plugin`：实现高层 port 的代码；
- `DSH bundle/plugin`：向 DSH Cordis 树提供 session/model/tool 能力；
- `Agent Template/Skill`：角色行为和知识配置。

一个 DSH plugin 可以被 HumanAgent adapter 使用，但不会因此自动成为某个 agent 的 tool；必须同时通过 template allowlist、assignment capability 和 Harness permission gate。

## 7. 典型流程

### 7.1 首次启动

```text
user installs DSH independently
  → user installs approved DSH plugin into dedicated profile
  → humanagent doctor verifies binary/profile/lock
  → humanagent host loads fixed core
  → host validates templates and HumanAgent plugins
  → host starts DSH provider
  → DSH loads Cordis profile
  → provider readiness returned
  → host publishes ready
```

### 7.2 一个任务执行

```text
Task input
  → interaction agent template
  → user confirmation
  → fixed queue/admission
  → orchestration agent template
  → assignment selects execution agent template
  → Harness grants tool capability
  → DSH provider executes one operation
  → adapter returns WorkResult + evidence refs
  → orchestration checks delivery
  → review / remediation / memory review
  → completion checkpoint
```

### 7.3 DSH 插件失效

```text
health probe or provider error
  → Harness records exact failure
  → affected operation settles or waits
  → user-facing Attention if the current promise is affected
  → no fake fallback
  → restore/replace DSH profile under explicit operation
  → readiness probe
  → resume from checkpoint if permitted
```

## 8. 验收和安全门

### MVP

- `humanagent start --executor fake` 可以独立启动，不安装 DSH；
- Cordis Host 可以装载 fixed Harness Kernel、fake Agent Driver、deterministic Memory backend 和 UI projection plugins；
- core/runtime/plugin/template contracts 不依赖 Cordis 或 DSH 类型；
- explicit plugin manifest、digest、模板加载和 dispose 生命周期可 replay；
- Node strategy、Agent Driver 和 Memory backend 的替换不改变固定 Harness gate；
- 固定编排 gate 不能由插件绕过；
- plugin 失败、模板失败、依赖缺失和 health blocked 都是显式状态。

### Milestone 1

- DSH 以独立安装物存在，HumanAgent 不静默安装或升级它；
- 使用专用 DSH profile 安装 approved bundle，默认 profile 不被修改；
- clean DSH 版本、公开 package entrypoint、bundle patch、license 和 lock 有证据；
- Host ↔ DSH bridge 通过 fake contract、recorded replay、真实 RCC 4444 同入口和真实 DSH 同入口四层验证；
- DSH plugin 变化后通过重启加载；若旧 Task 仍绑定被替换的 plugin，M1 必须阻止更新或继续保留旧 profile，不以 digest 代替完整模板/plugin snapshot；
- DSH session log 只是 execution evidence，不替代高层 Journal。

### Milestone 2/3

- profile、plugin lock、template snapshot、runtime epoch 和 checkpoint 可共同恢复；
- 插件更新/移除有 staged install、健康验证和可逆回滚边界；
- 发布包包含明确的 compatibility matrix、依赖和 license；
- 多任务下插件能力、资源 lease 和 Journal scope 不串线；
- 没有签名/兼容性/权限证据时不允许加载生产插件。

## 9. 已锁定与待验证

已锁定的 DSH 源码基线、tree 和最近发布标记见 [`dsh-baseline.md`](dsh-baseline.md)。以下项目仍属于 Milestone 1 的适配验证，不得提前写成实现事实：

- HumanAgent host 与 DSH provider 使用子进程 IPC 还是本机服务 transport；
- 首个 Host Plugin API 的语言/包格式和 manifest 签名方案；
- DSH 最小支持版本、公开 package entrypoint 和真实 session stop 语义；
- DSH profile 的实际目录、环境变量和凭据边界；
- 插件更新时正在运行任务的等待、迁移或禁止更新策略。

这些是 Milestone 1 的验证决定，不阻塞当前高层设计；在证据出现前不写 runtime 实现、不声明 DSH adapter 完成。
