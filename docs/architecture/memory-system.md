# HumanAgent Memory Agent

状态：`DESIGN-REBASE / PROJECT-GLOBAL-MEMORY`
日期：2026-09-16
适用阶段：MVP → Milestone 3

本文是 HumanAgent 记忆系统的唯一设计入口。它吸收 X 帖子提出的五层模型，但按 HumanAgent 的 Journal、checkpoint、scope、review 和错误归属重新落地。X 帖子是设计启发，不是性能验收标准；其中的白皮书引用和成本数字未在本项目中独立复现。

本轮重基于全局 Agent Framework 设计：main merge `905034862eba03ca5e9af872f04b14e79d107b57`，设计提交 `882fa199526e15edfc6d8233e1e359ccb986387d`，重点依赖 `agent-communication-and-feedback.md`、`agent-request-response.md`、`context-contract.md`、`agent-framework-work-plan.md` 和 `AGENTS.md`。本文只定义 Memory Agent 如何接入这些既有 owner，不重新定义全局协议。

## 1. 结论

Memory Agent 不是“把历史塞回 prompt”的工具，而是受 Harness 控制的记忆闭环：

```text
当前 cycle / checkpoint / operation evidence
        │
        ▼
  Episodic Journal       工作记忆之外的事实流水
        │
        ├── deterministic projection / exact search
        ├── optional semantic analysis
        │
        ├── Semantic candidates ── review ──► approved project memory
        └── Procedural candidates ─ review ─► project local Skill
                                                   │
                                                   └─ explicit promotion ─► global memory

project + approved global
        │
        ▼
  policy-bound context assembly ──► Agent Runtime

supersede / expire / archive / index rebuild
        └── Forgetting：清除旧投影，保留可审计来源
```

核心取舍：

1. 长期记忆只分两个 namespace：`project` 和 `global`。
2. `task`、`cycle`、`session` 不是第三套长期记忆；它们是 project 下的来源、恢复和检索过滤边界。
3. Journal、checkpoint、asset 和批准记录是真源；Index、摘要、向量、缓存和上下文是可重建投影。
4. 主 Agent/Runtime 负责捕获和使用临时 context；Memory Agent 负责在边界事件后提炼、比较、提出候选和请求 review，不能自行把事实或 Skill 写成 approved，也不能改变 Task/Checkpoint/Operation。
5. 遗忘首先改变可见性和投影；物理删除只允许作用于可重建数据，不能删除仍被恢复或批准记录引用的来源。

`packages/contracts`、`packages/config`、`packages/runtime` 和 deterministic memory adapter 已实现第一批 project/global 类型、权限、binding、candidate/review/promotion/forgetting 与查询边界；Journal canonical scope、持久化 migration 和真实 Memory Agent provider 尚未完成。迁移完成前，当前 `MemoryScope` 的 `task / organ / approved-global` 仍按旧契约运行；不能把旧的 `organ` 或 `approved-global` 输入解释成本文的新 project/global 语义。§10 的映射与 §11 的切片是后续实现合同。

## 2. 记忆边界：项目与全局

### 2.1 Namespace

```text
~/.humanagent/
├── memory/global/
│   ├── plan.jsonl           project-memory 全局记忆事件源
│   ├── path.jsonl
│   ├── knowledge.jsonl
│   ├── lesson.jsonl
│   ├── index.md             生成的索引/整理入口
│   ├── L1/ L2/              生成的详情投影
│   ├── L3/
│   └── index.sqlite         可删除、可重建的查询投影
└── project/<project-key>/
    ├── journal/             HumanAgent Organ Journal（唯一生命周期真源）
    └── memory/
        ├── plan.jsonl       project-memory 项目记忆事件源
        ├── path.jsonl
        ├── knowledge.jsonl
        ├── lesson.jsonl
        ├── index.md
        ├── L1/ L2/
        ├── L3/
        └── index.sqlite
```

`~/.humanagent` 是唯一持久化 root。workspace 只能作为执行上下文；不得在 workspace 写入 memory、session、Journal、checkpoint、Index、artifact 或 profile。

这里有两个不同层次，不能互相冒充：`packages/adapters/jsonl` 的 Organ Journal 记录 Task/Cycle/Operation/Checkpoint、source provenance 和 Harness 控制事实；`project-memory` 的四类 JSONL 是 Memory Operations Backend 的记忆事件源。后者由 Memory adapter 通过统一接口访问，不能由 Agent、UI 或 CLI 在 workspace 旁路写入。candidate、review、promotion、supersede 和 expiry 必须同时有可校验的 Organ Journal operation/evidence 引用；记忆内容本身由 project-memory backend 的 append-only 事件保存，Index、详情 Markdown、SQLite、摘要和语义投影只能重建。

当前 `project-memory` CLI 的默认输出可能落在 workspace `memory/` 或 `~/.local/share/project-memory/`。这不是 HumanAgent 的可接受运行时路径。接入时由 `packages/config` 解析并锁定 `controlRoot`，Memory adapter 只允许使用 `~/.humanagent/memory/global` 或 `~/.humanagent/project/<project-key>/memory`；若 backend 不能接受该 root，能力必须报告 `unavailable`，不得静默回退到默认路径。

| namespace | 可保存内容 | 默认可见范围 | 升级到 global |
|---|---|---|---|
| `project` | 项目事实、架构决定、已证实错误模式、项目偏好、项目 Skill | 当前 project 内 | 必须显式 promotion + review |
| `global` | 跨项目稳定事实、用户批准的通用偏好、通用 Skill | 被允许的 project/agent | 必须批准；project 不得静默改写 |

project 记忆可引用 task 来源，但 task 结束不会自动晋升 project。global 记忆可被 project 使用，但 project 的新结论不能覆盖 global；需要改变 global 时，产生独立 candidate 和 promotion review。这样既保留跨项目复用，又避免项目污染全局。

### 2.2 项目规则与单项目 Skill 主动更新配置

Memory Agent 的主动更新由 project config 统一控制，配置真源由 `packages/config` 解析，不能分别写进 Skill、`AGENTS.md` 或 Memory Agent prompt：

```toml
[memory.update]
auto = false

[memory.audit]
prompt_ref = "project-memory-audit"
```

`prompt_ref` 当前只接受安全文件名，由 source adapter 从 control root 的
`memory-audit/<prompt_ref>.md` 读取。它不是提示词正文，也不是系统内置默认提示词。项目可以随时替换该文件，下一次 analysis operation 读取新 revision。source adapter 必须返回 canonical ref、revision、digest 和读取时间；来源缺失、不可读或 ref 不可解析时，审计进入 `attention`，不得使用隐藏的系统 prompt 猜测补齐。typed `source://` URI 在独立 source/manifest 解析器接入前显式拒绝。

```text
auto = false
  → 只生成当前 project `AGENTS.md` / 单项目 local Skill update proposal
  → 等待对应 owner review/apply

auto = true
  → Memory Agent 在 task/cycle boundary 主动检查并提交更新
  → Project Rule owner 或 local Skill owner 校验并自动应用低风险、project-scoped patch
  → 记录 old digest、patch digest、new digest 和 evidence
```

当前运行时通过 `MemoryProjectPatchReader` 从 `artifactsRoot` 的 immutable patch artifact 读取并校验
`patchRef + patchDigest`。artifact 是带证据绑定的 typed envelope，不接受裸文本。Memory Agent
边界 producer 只能生成 `memory-entry` payload；project source owner 的 patch reader 是自动应用
准入的唯一权威，只接受这种无外部替换正文的 typed artifact，并按已校验的 kind/evidence 生成固定
的 memory entry。`replacement` payload 仅表示 proposal/review 内容，不能自动写入 project source：

```ts
interface ProjectSourcePatchArtifact {
  readonly schemaVersion: 1;
  readonly kind: 'project-fact' | 'project-experience' | 'local-skill-update';
  readonly target: 'project-agents' | 'project-local-skill';
  readonly payload:
    | { readonly type: 'memory-entry' }
    | { readonly type: 'replacement'; readonly content: string };
  readonly evidenceRefs: readonly string[];
}
```

`kind` 与 target 必须匹配，artifact evidence refs 必须等于 proposal evidence refs；未知 kind 或
`replacement` payload（包括其中携带的控制、安全、权限、发布、生命周期或所有权文字）直接进入
`attention`，不使用自然语言关键词或内容 denylist 判断。再由 project source owner 执行
compare-and-commit；该 owner 在 pending-state/source mutation 前完成上述 typed admission。
`memory.update.auto=true`
因此可以通过配置校验；缺失或 digest 漂移仍在 owner 阶段以 `attention` 显式失败。自动更新只允许
由绑定 Event Journal publisher 的 runtime composition 启用；owner 在替换源码前持久化 pending update，
发布失败或进程中断后按源码 digest 恢复并幂等补发 `memory.project-source.updated`，不允许留下无恢复记录的
源码修改。

这个开关只控制当前 project 的：

```text
project/AGENTS.md
project cwd-named local Skill
```

自动更新 target 不是可任意填写的路径，而是固定的 typed union：

```ts
type ProjectAutoUpdateTarget = 'project-agents' | 'project-local-skill';
```

`project-local-skill` 只能解析到当前 project 的唯一 cwd-named Skill source；`project-agents` 只能解析到当前 project 的 `AGENTS.md`。`global`、外部 Skill、audit prompt 和其他配置没有对应 target。

```ts
interface ProjectSourceUpdateProposal {
  readonly target: ProjectAutoUpdateTarget;
  readonly sourceRef: string;
  readonly expectedRevision: string;
  readonly expectedDigest: string;
  readonly patchRef: string;
  readonly patchDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly ownerRef: string;
}
```

该 proposal 的 `target`、source revision/digest 和 owner 是强约束；`auto=false` 时只能作为 proposal 留存，`auto=true` 时也必须由对应 owner 的 typed update capability 执行 compare-and-commit。

项目的 local Skill 是单数且有固定身份：Skill 名称必须等于项目 canonical cwd 的 basename（例如 cwd 为 `humanagent` 时名称为 `humanagent`），名称和目录不得带版本号或版本后缀。实际 source path 由 project source/manifest 解析，Memory Agent 不猜路径、不创建第二个 Skill；revision、digest、metadata 和 update evidence 用于追踪版本变化。缺少、重复、名称不匹配或 manifest 无法解析时，只发布 `attention`，不执行自动更新。

它不授权自动修改：

```text
global AGENTS.md
~/.agents、~/.codex、~/.agent 的外部 Skill 真源
global memory
用户画像
独立 audit prompt source
权限、provider、release、安全和 lifecycle 配置
```

`auto=true` 不是跳过 owner、权限、digest、冲突和验证。当前文件 revision 发生漂移、候选涉及控制/安全/权限语义、无法确定唯一 owner、验证失败或 patch 不是 project-scoped 时，必须退回 proposal + `attention`，禁止覆盖或静默降级。

`auto=true` 也不改变审计提示词：提示词由 `memory.audit.prompt_ref` 的 source owner 独立维护，不能被 Memory Agent 的自动更新覆盖；它不是 `AGENTS.md` 或 local Skill 的隐式副本。自动更新的 target 若不是当前 project `AGENTS.md` 或唯一 cwd-named local Skill，必须拒绝。

### 2.3 访问规则

```text
task/session source  ──窄读──► 当前 task
project approved     ─────────► 当前 project
global approved      ─────────► 明确允许跨项目读取
```

- 默认 recall 顺序：当前 task/cycle → project approved → global approved。
- 冲突显示全部来源；当前 project 的明确批准事实只在当前 project 内优先，不能覆盖 global 原记录。
- `global` 写入是高风险操作，必须有 promotion candidate、来源、理由、影响范围和批准者。
- 未批准 candidate、原始 debug 日志、隐藏 prompt、向量分数和 provider 控制字段不进入普通 Agent context。
- `MemoryOperationsBackend` 不凭 Index 结果扩大 scope。每条结果必须携带 namespace、project key、source ref、source digest 和状态。

### 2.4 Canonical Journal scope

project/global namespace 不是把 `projectKey` 塞进现有事件 `payload`。迁移后的 Journal record 增加与业务 payload 平级、可校验的 memory scope envelope：

```ts
type CanonicalMemoryJournalScope =
  | {
      readonly namespace: 'project';
      readonly projectKey: string;
      readonly organId: string;
      readonly taskId?: string;
    }
  | {
      readonly namespace: 'global';
      readonly globalId: 'global';
      readonly sourceProjectKey?: string;
      readonly sourceOrganId?: string;
    };
```

`globalId: 'global'` 是独立的全局 identity，不是某个 organ 的别名；`sourceProjectKey/sourceOrganId` 只保留 promotion provenance，不能成为 global 可见性的过滤条件。现有 v1 `JournalRecord.scope` 仍要求 `organId`，因此在 Journal contract 支持该 envelope 前，旧 `approved-global` 不能被静默迁移成 global。迁移必须先扩展 record schema、digest 校验、replay 和 scope filter，再改变 backend/coordinator；旧记录只按旧语义读取。

## 3. 五层模型的 HumanAgent 映射

文章的五层不是五个平行数据库，而是同一条事实链的不同生命周期。

| 文章层 | HumanAgent 实现 | 持久化 | 写入者 | 退出条件 |
|---|---|---|---|---|
| Working | cycle 当前窗口、directive、checkpoint、assignment、最近结果 | 有界 projection；不作为长期真源 | Runtime Window/Context owner | cycle 结束或窗口重建 |
| Episodic | Journal 中带时间和 scope 的事件、checkpoint、operation/session evidence 引用 | 追加、可 replay | Journal/Runtime owner | 来源已 durable；可继续检索 |
| Semantic | 从 episodic 提炼的事实、实体关系、偏好、约束、纠正 | candidate → reviewed approved record | Memory Agent 提案，review owner 批准 | approved / rejected / superseded |
| Procedural | 可重复的成功路径、前置条件、步骤、失败边界和证据 | candidate → project local Skill 或显式 global Skill promotion | Memory Agent 提案，local Skill/global Skill owner 批准 | approved / rejected / superseded |
| Forgetting | 冲突消解、过期、降权、归档、投影清理、来源引用保护 | 状态变更记录；来源不静默丢失 | Memory Coordinator + review owner | replaced / expired / archived / safely deleted |

### 3.1 Working Memory

Working Memory 是主 Agent 每次运行时自己维护的最小可用上下文，不是“最近 N 条文本”，也不是 Memory Agent 的上下文。live context、turn slot、窗口淘汰、有限改写和当前任务使用权属于主 Agent 的 Runtime/Context owner；Memory Agent 只在明确生命周期边界收到已经 committed 的 source 引用或短期记忆快照，不能读取或修改主 Agent 的 live slot。

装配输入固定为：

- 当前 Task/Directive revision、Cycle、Assignment、execution epoch；
- 最新可用 checkpoint 和 recovery state ref；
- 当前 reporting window 的必要输入、结果和未完成项；
- 被 policy 允许的 project/global approved memory 摘要；
- 每项来源的 `sourceRef`、`sourceDigest`、namespace、状态和 token cost。

窗口超过预算时按优先级省略，并记录 `omitted` 原因；不得从开头静默截断，也不得以摘要替代 recovery state。Working Memory 被丢弃后可由 checkpoint + source refs 重建。主 Agent 可以通过 `memory.search`/`memory.inspect` 主动使用已批准记忆，但 Memory Agent 不负责自动 attach，也不决定某条记忆是否进入当前 context。

### 3.2 Episodic Memory

Episodic Memory 记录“发生了什么”，但不把所有 provider 输出复制成长期知识：

```ts
interface EpisodicMemorySource {
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly projectKey: string;
  readonly taskId?: string;
  readonly cycleId?: string;
  readonly sessionRef?: string;
  readonly occurredAt: string;
  readonly kind: 'input' | 'checkpoint' | 'operation' | 'tool' | 'output' | 'error' | 'review';
  readonly payloadRef: string;
}
```

原始大对象放 filesystem asset，Journal 只保留不可变引用和 digest。DSH session log 只能作为 execution evidence；它不能冒充 HumanAgent Journal、Task 状态或恢复 checkpoint。

### 3.3 Semantic Memory

Semantic candidate 必须说明“什么事实、适用哪里、来自哪里、何时失效”：

```ts
interface SemanticMemoryCandidate {
  readonly candidateId: string;
  readonly namespace: 'project' | 'global';
  readonly projectKey: string;
  readonly statement: string;
  readonly entities: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly confidence: 'observed' | 'supported' | 'confirmed';
  readonly validity: { readonly kind: 'open' | 'until'; readonly until?: string };
  readonly supersedes?: readonly string[];
  readonly review: 'required' | 'approved' | 'rejected';
}
```

规则：一次 observation 只能产生 candidate；重复发生、明确用户确认或独立证据支持才提高可信级别。`confirmed` 不等于 global approved；namespace promotion 仍需要独立 review。

### 3.4 Procedural Memory

程序记忆保存“怎么完成”，不是把某次聊天总结成无边界 prompt：

```ts
interface ProceduralMemoryCandidate {
  readonly candidateId: string;
  readonly namespace: 'project' | 'global';
  readonly projectKey: string;
  readonly name: string;
  readonly intent: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly failureBoundaries: readonly string[];
  readonly successEvidenceRefs: readonly string[];
  readonly repeatability: 'one-off' | 'observed' | 'recurring';
  readonly review: 'required' | 'approved' | 'rejected';
}
```

只有满足“成功结果 + 可定位 evidence + 可复现前置条件 + 明确失败边界”的路径才可提案 Skill。候选不能直接编辑 Skill source；批准后由当前 project 的 local Skill owner 写入唯一 cwd-named Skill。若要形成 global procedural memory 或 global Skill，必须另走 promotion review，再审查环境假设、权限影响和跨项目适用性。项目不得通过新增带版本号的 Skill 绕过这条边界。
`compact` 只能清理可重建的索引、窗口和已解除引用的历史细节；不得删除仍被 checkpoint 或 approved memory 引用的来源。Absolute Journal、原始资产、Context Slot 和派生 Index 的保留根与清理边界以 [`context-contract.md`](context-contract.md) §10 为唯一真源，本节不重复定义。

### 3.5 Forgetting Engine

遗忘不是定时 `delete all old records`。它是可审计的状态与投影策略：

```text
active
  ├── superseded  被新批准事实替代
  ├── expired     validity.until 已过
  ├── archived    不再默认召回，但保留审计引用
  └── forgotten   仅允许删除无引用的 derived projection
```

判定顺序：

1. 先检查 namespace、来源引用、批准状态和有效期。
2. 检查新旧事实是否冲突；不能用相似度分数直接判定“旧事实错误”。
3. 新事实被批准后，显式记录 `supersedes`，旧事实变为 `superseded`。
4. 仅删除 Index、embedding、summary、cache 等可重建投影；保留 Journal、checkpoint、approved record 的来源。
5. 任何物理清理都必须有明确 target、引用检查和可重建证据；memory unavailable 时不执行清理。

## 4. Memory Agent 的职责与边界

### 4.1 角色分工

```text
Runtime / Journal owner
  capture episodic source, checkpoint, source digest

Memory Operations Backend
  verify source, index, exact search, inspect, compare, recurrence, rebuild

Memory Agent (bound to one main Agent)
  process boundary snapshots, extract multi-layer candidates, explain conflict, request review

Memory Coordinator
  admit memory operation, validate trusted binding/scope/role/budget/epoch, submit result, retain memory recovery obligation

Memory Review / Skill owner
  approve, reject, supersede, promote project → global, publish Skill
```

主 Agent 的 live context 由 Runtime/Context owner 管理，不属于 Memory Agent 的职责。AI provider 失败时，capture、exact search、inspect、digest 校验和明确的 recurrence 仍可用；只有依赖 AI 的 extraction、semantic conflict explanation、跨层分类或摘要进入 `waiting`/`degraded`。不能把空结果报告为“没有记忆”。

### 4.2 Memory Agent 工具面

Memory Agent 只暴露 typed tools；控制字段不进业务 payload：

```text
memory.source.list       按 project/task/cycle/时间读取来源引用
memory.source.inspect    校验 digest 后读取指定来源
memory.search            exact/full-text 查询 approved 或指定 candidate
memory.compare           比较两个来源/事实并返回关系与证据
memory.extract           生成 Semantic/Procedural candidate
memory.recurrence        统计已指定窗口内的重复模式
memory.forgetting.plan   生成 supersede/expire/archive/cleanup plan
memory.review.request    提交 candidate review，不直接批准
memory.session.read      只读读取绑定主 Agent 的 session evidence
memory.project.read      只读读取当前 project 的架构、AGENTS.md 和唯一 local Skill evidence
memory.audit.prompt.read 读取本次审计 operation 绑定的独立提示词 source
```

`memory.context.recall` 和 `memory.context.attach` 不属于 Memory Agent 的工具面：前者是主 Agent Runtime 通过 `AgentMemoryContextInjectionPort` 调用的 recall seam，后者是 ContextBuilder/Runtime 的绑定动作。Memory Agent 只能产生可供查询的 candidate、approved record 或 feedback，不能直接把结果 attach 到主 Agent 的 live context。

`memory.session.read` 和 `memory.project.read` 是 Memory Agent 的只读分析工具，不是其他 Agent 访问 Memory Agent 私有状态的接口。二者都必须由当前 binding 授权、返回 source ref/digest，并经过 scope、permission 和 epoch 校验。

禁止：直接写 Task payload、metadata、DSH session、local Skill source/global Skill registry、Journal lifecycle 状态；读取 debug log 反推控制状态；跨 project 搜索时省略 namespace；失败时返回伪造的空记忆或成功。

### 4.3 Memory Agent 如何自主运行

Memory Agent 是与一个主 Agent 绑定的、由 Harness 监督的后台 Organ，通过既有 Agent Runtime 运行。它不是拥有第二套 daemon、scheduler、session 或无限循环的服务。一个 runtime 进程可以承载多个 binding，但每个主 Agent 在一个 project execution scope 内必须有自己的 Memory Agent binding。Memory Agent 可以被宿主保持 ready，也可以按事件唤醒；两者都必须服从 `RuntimeBinding`、Host lease、Operation、EventBus cursor 和 Checkpoint/Control Owner。project lane 和 global promotion lane 必须使用不同的 scope、cursor、capability digest 和权限。

```text
Main Agent blocked / checkpoint rewind / task completion
  / explicit memory submission
                         │
                         ▼
         Journal commit + durable EventBus event
                         │
                         ▼
     scope-filtered delivery; Host grants lease; Runtime creates operation
                         │
                         ▼
   read committed source refs from durable cursor and verify binding
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
       source         classify       exact match /
       digest         memory kind    conflict analysis
          └──────────────┬──────────────┘
                         ▼
       candidate / duplicate / conflict / no-op / attention
                         │
       project-memory append + Organ Journal effect evidence
                         │
       checkpoint cursor + handler receipt, then wait
```

自主运行规则：

1. 每个主 Agent 只绑定一个 Memory Agent logical binding。该 binding 负责当前 project 的记忆整理；global lane 只是受限的 promotion 处理能力，不代表 global memory 的私有所有权。
2. Memory Agent 主要在四类边界被唤醒：主 Agent 报告 blocked/attention、checkpoint rewind/reentry、task/cycle 完成、主 Agent 显式提交 memory candidate。普通 turn 不逐条触发模型整理。
3. 唤醒先经过 EventBus 的 publisher、scope ACL、epoch 和 permission revalidation；收到事件不等于已经交付，也不等于可以改变状态。
4. 每次 wake 都创建有界 analysis operation：固定 source 数、token budget、operation 数、deadline 和 execution epoch。达到任一上限，必须先保存当前进度/未完成责任，再由 Checkpoint Owner 提交 checkpoint，不能靠内存继续跑。
5. 每次只从 durable cursor 读取已 committed source。cursor 无效、Journal 断链、source digest 不匹配或 binding 过期时进入 `attention`，不从模型上下文猜测进度。
6. Memory Agent 可以 ingest、deduplicate、compare、提出 candidate、请求 review；不能 approve、project → global promotion、publish Skill、修改 Task/Checkpoint/Permission 或执行物理清理。
7. `Memory Operations Backend` 负责 `project-memory` 的 entry/query/review/index/export/compact/verify adapter 调用；Memory Agent 不直接编辑 JSONL、Markdown、SQLite 或 Index。普通 entry 走 one-shot `entry` 语义，详情和索引不得分别写入。
8. 无新记录时返回 `waiting/idle`，不调用模型制造记忆；AI 不可用时保留 source、submission、cursor 和 retry obligation，显式标记 `degraded/waiting`，不能返回伪造的空记忆或成功。
9. lease、wake reason、cursor、operation intent、handler receipt、checkpoint 和 next action 由各自 owner 以 typed Journal record 保存；模型输出和 provider session 只作为 evidence ref。
10. crash/restart 先由 Host supervisor 取得 lease，再由 Checkpoint/Control Owner 恢复 binding/epoch，最后由 EventBus 从 durable cursor replay。重复 wake、重投和 ACK 丢失依靠 `consumerKey + messageId`、`submissionId`、`operationId` 幂等，不依靠时间去重。
11. 具有外部 project-memory 写入的事件处理采用 `operation-barrier`：先保存 operation intent/idempotency key，完成或 reconcile 后才能提交 effect refs、handler receipt 和 cursor；未知副作用禁止盲目重做。

推荐状态机：

```text
stopped → starting → ready → running
                         ├── waiting ──► running
                         ├── degraded ─► running
                         ├── attention
                         └── stopping → stopped
```

这里的 `running` 是一次受界定的 Agent Request/analysis operation，不是永久对话。Runtime 负责全局 binding/epoch admission，Memory Coordinator 只负责 Memory operation 的 scope、预算、可信 binding 校验和结果收口；EventBus owner 负责投递；Checkpoint/Control Owner 负责恢复；Memory Agent 只负责当前 operation 的分析 data/observation。两者不可合并成“agent 自己修改自己的状态”。

### 4.4 对全局 Agent Framework 的依赖

```text
C Contracts/Core：RuntimeBinding、scope、permission、message、candidate 类型
        ↓
J Journal/Filesystem：source/evidence 与 control fact 的持久化
        ↓
X Context/Projection：recall、budget、Context View、epoch fence
Q Agent I/O：Memory Agent Request/Response、有限 repair、watchdog
K Checkpoint/Control：checkpoint、stop、reentry、closure
E Event delivery：durable event、cursor、ACK、retry、DLQ
H Host supervisor：唯一 lease、wake、generation fencing、重启接管
P Audit Prompt Source：独立 ref、revision、digest、读取时间
        ↓
Memory Agent + Memory Operations Backend
        ├── project-memory adapter：entry/query/review/promotion/index
        └── optional AI adapter：extract/compare/explain only
```

依赖方向固定：Memory Agent 依赖这些 typed seam，不反向拥有它们。禁止新增第二套 Journal、EventBus、Agent Driver、ContextBuilder、Checkpoint、lease/cursor recovery 或 global promotion owner。Memory backend 只保存记忆域事件和可重建投影；Harness lifecycle 仍由既有 owner 决定。

### 4.5 独立审计提示词

审计提示词是可替换的分析输入，不是 Memory Agent system prompt 的一部分，也不是 contracts、控制状态或记忆内容。`packages/config` 只解析 `memory.audit.prompt_ref`；当前 MVP 将该 ref 作为安全文件名，由 Source adapter 从 control root 的 `memory-audit/` 读取对应 Markdown 文件，并在每次 boundary analysis operation 开始时固定一份 prompt snapshot。独立 source/manifest URI 尚未接入，不能被当作文件名隐式解释：

```ts
interface AuditPromptSnapshot {
  readonly promptRef: string;
  readonly canonicalRef: string;
  readonly revision: string;
  readonly digest: string;
  readonly loadedAt: string;
}
```

运行规则：

- prompt source 可独立修改，不需要修改 Memory Agent 或系统代码；下一次 analysis operation 使用修改后的 revision。
- 已开始的 operation 只使用自己的 `promptRef + revision + digest`，不在同一 operation 中混用新旧提示词；新版本由后续 operation 读取。
- operation result、candidate、proposal 和 audit evidence 必须记录该 snapshot；不能只记录自然语言结论。
- prompt 只影响 observation、分类、候选和 proposal 的分析策略，不能改变 scope、permission、owner、approval、Task、Checkpoint、Journal 或 global promotion 权限。
- prompt 读取失败、digest 无法校验或 source 漂移时，保留原始 evidence，发布 `attention`，不使用内置隐藏 prompt、旧 prompt 或空分析结果替代。
- 其他 Agent 不直接读取或修改 Memory Agent 的 prompt；需要变更时由 prompt source owner 独立更新 source，再由下一次 operation 重新绑定。

`memory.audit.prompt.read` 只供 Memory Agent/Coordinator 在 operation admission 后读取当前 snapshot，不向普通 memory query 暴露提示词正文。提示词 source 的内容不是 approved memory，也不允许由 `memory.update.auto` 自动改写。

### 4.6 分析输入：Session 与项目架构证据

Memory Agent 可以看到与自己绑定的主 Agent session 文件，但只能通过 `memory.session.read` 读取，不直接猜路径、不读取其他 Agent 的 session、不修改 session 文件。session file 在这里是 execution evidence，不是 Task、Checkpoint 或 Memory 的真源。

允许读取的 session evidence 包括：

- 主 Agent 的用户输入、用户明确纠正和确认；
- Agent turn 的请求摘要、搜索/执行关键词、tool intent/result/error 引用；
- blocked、attention、operation failure、checkpoint save、rewind/reentry 和成功收口引用；
- 当前 project 内、与该 task/assignment 绑定的 source refs、context snapshot refs 和 branch refs。

Memory Agent 读取项目文件时，`memory.project.read` 只允许当前 project binding 声明的范围，优先读取：

```text
project/AGENTS.md
docs/architecture/**（与当前 task、owner、受影响路径相关）
manifest 声明的唯一 cwd-named local Skill 文件
必要的只读配置、流程和 capability 描述
```

项目 workspace 只作为读取和执行上下文；读取结果不能写回 workspace。每个文件都带 canonical path、revision/digest 和读取时间。Memory Agent 对比“文档声明的流程”与“session/Journal 的实际流程”，输出差异 evidence；不把文档内容直接当作已经验证的事实，也不直接修改 `AGENTS.md` 或唯一 local Skill。

### 4.7 生命周期边界加工：从短期材料到长期候选

Memory Agent 不处理主 Agent 的每个 live turn。它只处理主 Agent 在生命周期边界提交的材料：

```text
主 Agent live context / turn slots
        │ 由 Runtime/Context owner 管理
        ▼
blocked / checkpoint rewind / task completion / explicit submit
        │
        ▼
committed source refs + short-term context snapshot ref
        │
        ▼
Memory Agent 分析、分类、去重、冲突判断、重复模式识别
        │
        ├── project fact candidate
        ├── project experience candidate
        ├── global memory candidate
        ├── user profile candidate
        └── procedural / local Skill update candidate
```

| 加工产物 | 内容 | 默认落点 | 后续 gate |
|---|---|---|---|
| 项目事实 | 架构、路径、约束、配置、稳定实体关系 | project `knowledge/path/plan` candidate | project review；稳定事实才可 active |
| 项目经验 | 已验证的根因、失败边界、解决方式、避坑 | project `lesson` candidate | evidence review；未验证失败不晋升 |
| 全局记忆 | 跨项目稳定事实、通用经验、用户确认的通用规则 | global candidate | 独立 promotion review；不能由 project 自动写入 |
| 用户画像 | 用户偏好、沟通方式、授权习惯、输出习惯 | profile candidate/registry | 明确用户确认或既有 profile owner 批准 |
| local Skill 更新候选 | 可重复步骤、前置条件、失败边界、与当前唯一 cwd-named Skill 的差异 | procedural candidate + local Skill update proposal | local Skill owner review；revision、diff、evidence 必须可追溯 |

`desiredScope`、模型置信度或“看起来通用”不能跳过这些 gate。Memory Agent 只产生 candidate、差异和建议；review、profile、local Skill、global Skill 和 global promotion owner 决定是否真正生效。

### 4.8 Block 与 checkpoint rewind 的特殊加工

主 Agent blocked 时，Memory Agent 记录阻塞来源、已验证失败边界、未完成假设和下一步建议；不能把失败自动写成长期事实。checkpoint rewind/reentry 时，Memory Agent 比较被回退分支与新分支，提取可复用的死路结论和成功路径。

每次 rewind 分析必须保存并校验同一条证据链：

```text
failedBranchRef
  → rewindCheckpointRef
  → recoveryCheckpointRef
  → committed reentryFactRef
  → successfulBranchRefs + successEvidenceRefs
  → Absolute Journal sourceRefs
```

这里的 `recoveryCheckpointRef` 是实际恢复使用的 checkpoint，不是“可尝试的候选 checkpoint”；`reentryFactRef` 证明该 checkpoint 已由既有 Checkpoint/Control owner 提交并实际重入。发生多次 rewind 时，每一条失败分支都必须绑定自己的 rewind/recovery/reentry 关系，不能凭时间顺序或模型摘要归因。缺少任一关联时，只保留 episodic evidence 并发布待补证据的 `attention`，不生成已验证的项目经验或成功流程结论。

```text
Absolute Journal Slot
  保留所有已提交 turn/source，不能改写、删除

当前 Context Turn Slot
  主 Agent 可在有限修复窗口内合并、改写、移除

rewind 后
  失败 turn 从当前 active context 移除
  失败 source 仍可从 Absolute Journal 查询
  成功路径成为后续加工的主要 source
```

成功执行后，错误 turn 可以退出主 Agent 的 active context；不能从 Absolute Journal 消失。只有错误中包含可复用的失败边界、根因或替代方向时，才生成项目经验 candidate；普通无价值错误只保留 episodic history。成功历史和成功 evidence 必须保留，并优先用于 Procedural/Skill candidate 分析。

### 4.9 固定分析流程（阶段固定，提示词可替换）

每次边界 processing 按以下顺序执行，不能只做一次开放式总结：

```text
1. 证据扫描
   session file + Absolute Journal + checkpoint/rewind + project docs/Skill + audit prompt snapshot
   → 建立 turn、operation、error、correction、branch、文档 revision 和 prompt revision 视图

2. 重复与回退分析
   → 检查用户反复纠正
   → 检查相同 error/blocked/failed operation 是否重复
   → 将失败分支 → rewind checkpoint → 实际 recovery checkpoint/reentry fact → 成功分支绑定到错误记忆

3. 流程效率分析
   → 对比实际执行路径与 AGENTS.md、架构文件、Skill 声明流程
   → 找出重复调用、无效步骤、错误路径、缺失前置条件和可复用成功路径

4. 分层提炼
   → project fact / project lesson / global candidate
   → user profile candidate
   → Skill update proposal / AGENTS.md fact proposal

5. 准入与反馈
   → 写入 candidate/evidence refs
   → 发送 review、promotion、profile、local Skill/AGENTS.md update 或 attention 请求
   → 不直接修改主 Agent context、AGENTS.md、local Skill、audit prompt 或 global record
```

重复纠正必须保留每次纠正的 source ref、原规则、主 Agent 当时的处理、后续结果和重复次数；不能仅凭情绪或相似文本判定。重复错误必须绑定 error fingerprint、operation/step、失败原因、出现的 task/cycle 和是否被 rewind；同一错误在成功后仍保留 Absolute Journal，但只有具备根因或可复用失败边界时才晋升项目经验。

流程效率 proposal 必须同时给出：当前实际路径、架构/AGENTS/Skill 声明路径、差异、节省的步骤或资源、风险、证据和建议 owner。若建议更新 local Skill，必须带唯一 cwd-named Skill 的 canonical source ref/digest、目标内容、最小 diff、适用范围、成功/失败证据和回归要求；不生成带版本号的新 Skill，也不把版本号写入 Skill identity。若建议更新项目 `AGENTS.md`，必须带事实来源、owner、影响路径和冲突检查。`auto=false` 时 Memory Agent 只提交 proposal；`auto=true` 时也只能调用对应 owner 的 typed update capability，不能直接编辑文件。

自动更新采用 compare-and-commit：读取当前 `AGENTS.md` 或唯一 local Skill 的 revision → 生成最小 patch → 校验原 digest 未变 → 执行对应文档/Skill 验证 → 由 Project Rule owner 或 local Skill owner 提交更新 → 记录新 revision/digest 和 update evidence → 发布 `memory.project-source.updated`。任一步失败都保留 candidate 和原文件，不生成半完成更新；这条路径不处理 audit prompt source、global AGENTS、global memory 或外部 Skill。

## 5. Agent 间查询、提交和整理接口

全局通信合同只允许两条正式路径：主动操作用 `Capability Call`，异步通知用 durable `Internal EventBus`。以下是 Memory capability 的设计语义，不是新增一套私有 RPC/session 协议。每个 call 和 event 都必须携带全局 `AgentMessageEnvelope` 所需的 publisher binding、scope、correlation、source fact 和 capability proof。

### 5.1 查询：Capability Call，同步结果、只读、带证据

普通 Agent 通过已注册的 Memory capability 查询，Runtime 先创建 `Operation`/dispatch receipt，再返回 typed result 或 typed error。调用方不能直接读 Memory Agent 的 Context、Journal、provider session、SQLite 或 Markdown。

```ts
interface MemoryQueryRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly bindingRef: string;
  readonly actor: MemoryActorContext;
  readonly projectKey: string;
  readonly namespace: 'project' | 'global';
  readonly taskId?: string;
  readonly query: string;
  readonly kinds: readonly ('episodic' | 'semantic' | 'procedural')[];
  readonly states: readonly ('approved' | 'active' | 'superseded' | 'archived')[];
  readonly limit: number;
  readonly tokenBudget: number;
  readonly inputDigest: string;
}

interface MemoryQueryResponse {
  readonly requestId: string;
  readonly status: 'ready' | 'waiting' | 'attention';
  readonly entries: readonly MemoryQueryEntry[];
  readonly indexVersion?: string;
  readonly sourceFactRef: string;
  readonly nextCursor?: string;
  readonly omitted: readonly { readonly reason: string; readonly ref?: string }[];
}

interface MemoryQueryEntry {
  readonly memoryId: string;
  readonly namespace: 'project' | 'global';
  readonly kind: 'episodic' | 'semantic' | 'procedural';
  readonly state: 'approved' | 'active' | 'superseded' | 'archived';
  readonly summary: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly projectKey?: string;
  readonly sourceScopeRef: string;
  readonly relevanceReason: string;
}
```

`global` query 必须同时满足 RuntimeBinding、actor permission、cross-project grant、project policy 和 capability digest；无授权不是空数组，而是显式 `capability-denied/attention`。查询结果是 evidence-bound reference，完整来源另走 `memory.inspect`，避免把摘要当事实。查询只读，不产生 memory approval；EventBus 也不用于替代这个主动查询。

### 5.2 提交：Capability Call + data event，异步 intake

别的 Agent 不能直接写 approved memory、覆盖已有 global record 或调用 project-memory CLI 旁路写文件，只能调用 `memory.save_candidate`。Coordinator 校验后把提交作为 `data` 事件持久化并异步交给 Memory Agent 整理：

```ts
interface MemorySubmission {
  readonly submissionId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly bindingRef: string;
  readonly actor: MemoryActorContext;
  readonly projectKey: string;
  readonly taskId?: string;
  readonly cycleId?: string;
  readonly requestedKind: 'episodic' | 'semantic' | 'procedural';
  readonly contentRef: string;
  readonly contentDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly observation: string;
  readonly desiredScope: 'project' | 'global';
  readonly reason: string;
  readonly inputDigest: string;
}

interface MemorySubmissionReceipt {
  readonly submissionId: string;
  readonly status: 'accepted' | 'duplicate' | 'queued' | 'rejected';
  readonly candidateId?: string;
  readonly operationId?: string;
  readonly sourceRef?: string;
  readonly sourceFactRef?: string;
  readonly nextAction: 'none' | 'wait-analysis' | 'review-required' | 'attention';
}
```

处理顺序：

```text
Agent A
  → Capability Call: memory.save_candidate
  → RuntimeBinding / scope / permission / digest 校验
  → Journal Owner durable commit: intake source + data event
  → return accepted receipt（只表示 durable intake）
  → EventBus scope-filtered delivery to project Memory Agent
  → Memory Agent curation operation
  → candidate / duplicate / conflict / attention event
  → review owner approve project
  → separately authorized project → global promotion
```

`desiredScope` 是意图，不是授权结果；普通 agent 不能靠填 `global` 获得全局写权限。提交成功只表示 intake durable，不表示“记忆已经生效”。整理失败保留 submission 和 cursor，receipt 状态不能伪造成 approved。

### 5.3 整理：候选输出，不直接批准

Memory Agent 处理一个或多个已提交 source，输出结构化整理结果：

```ts
interface MemoryCurationResult {
  readonly operationId: string;
  readonly auditPrompt: AuditPromptSnapshot;
  readonly sourceRefs: readonly string[];
  readonly outcome: 'candidate' | 'duplicate' | 'conflict' | 'no-op' | 'attention';
  readonly candidateId?: string;
  readonly matchedMemoryIds: readonly string[];
  readonly conflictRefs: readonly string[];
  readonly explanation: string;
  readonly nextAction: 'review' | 'supersede-review' | 'retry-analysis' | 'none' | 'attention';
}
```

`candidate` 必须带证据和适用 namespace；`conflict` 必须并列新旧来源，不能让模型用一句“最新”静默覆盖；`duplicate` 仍保留新 submission 的 receipt 和匹配依据。review owner 决定 approve/reject/defer；global promotion 是另一条 command，不能隐藏在整理结果里。

### 5.4 异步反馈：EventBus 事件，不是控制后门

Memory Agent 和其他 Agent 之间的异步反馈使用全局 `AgentMessageEnvelope` 与 durable EventBus。事件只携带 typed data/observation 引用；需要改变 review、promotion、Task 或 Checkpoint 状态时，接收方必须再调用对应 owner 的 capability/command。

```text
memory.submission.accepted
memory.candidate.created
memory.candidate.review-required
memory.candidate.approved
memory.candidate.rejected
memory.candidate.promoted
memory.skill.update-proposed
memory.project-rules.update-proposed
memory.project-source.updated
memory.feedback
memory.attention
```

事件消费固定遵循全局协议：scope-filtered delivery → binding/ACL/epoch 校验 → handler 返回 `EventHandlerCommit` → Journal Owner 持久化 receipt/effect/cursor → 再发布 projection。ACK 丢失只允许重复投递并返回 `duplicate`；AI 失败只产生 retry obligation/attention，不产生空 candidate 或“无记忆”结果。`memory.candidate.approved` 和 `memory.candidate.promoted` 是 review/promotion owner 发布的事实，`memory.project-source.updated` 是对应 project source owner 发布的事实，Memory Agent 不能伪造这些事实。`memory.skill.update-proposed` 与 `memory.project-rules.update-proposed` 只表示可审查的 data/proposal；它们不等于文件已经修改。

## 6. Agent 与 Memory Agent 的多轮交互

全局 Agent Communication Contract 不允许 Memory Agent 私有 Session 成为 Agent-to-Agent 后门。因此这里不定义 `MemorySession`、`open/turn/close` 或独立 transcript 协议。其他 Agent 的“会话”只是一组有相关性的 Capability Call、Agent Request/Response 和 EventBus 事件；长期责任由 operation、Journal 和 checkpoint 保存。

### 6.1 三种交互形态

```text
一次查询/比较        Capability Call       request → typed result
提交整理输入         save_candidate        accepted receipt → EventBus feedback
多轮澄清/补证据       correlated operations  question → evidence → result
```

一次查询使用 `memory.search`、`memory.inspect`、`memory.compare`；提交使用 `memory.save_candidate`。需要多轮时，Memory Agent 返回 typed `question`/`conflict`/`attention` data，调用 Agent 以新的 correlated request 补充 evidence；不把自然语言 transcript 当作控制状态，也不把 provider/ACP/DSH session 当作 HumanAgent session。

### 6.2 多轮 operation 合同

```ts
interface MemoryFollowUpRequest {
  readonly requestId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly inReplyTo: string;
  readonly bindingRef: string;
  readonly actor: MemoryActorContext;
  readonly projectKey: string;
  readonly namespace: 'project' | 'global';
  readonly taskId?: string;
  readonly evidenceRefs: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly inputDigest: string;
}
```

Memory operation 的响应沿用全局 `AgentResponseEnvelope`，只在 `data` 中引用 Memory typed result：

```text
request.created
  → request.admitted（binding/scope/capability/context）
  → request.dispatched
  → Memory Agent operation
  → response.decoded（answer/candidate/question/attention）
  → result/evidence refs committed
  → response.delivered
  → operation settled or waiting for follow-up
```

规则：

- 每个 request 用 `requestId + operationId + correlationId + inputDigest` 幂等；重复请求返回既有 receipt/result，不重复写入或调用外部副作用。
- 迟到、旧 epoch、权限撤销或 scope 不匹配的 follow-up 只能形成 `stale/rejected/attention` 事实，不能改变当前 operation 或把 project 改绑到 global。
- Memory Agent 必须区分 `answer`、`candidate`、`question`、`conflict`、`attention`；自然语言解释不能代替 review/promotion receipt。
- follow-up 只允许引用调用 Agent 有权提交的 evidence refs；Memory Agent 不接受“把上一个 Agent 的隐藏上下文全部给我”这类请求。
- operation 等待补证据时，由 EventBus 发布 `memory.candidate.review-required` 或 `memory.attention`；恢复依靠 durable operation/checkpoint/cursor，不依靠内存 transcript。
- operation settle/close 只关闭本次请求或分析责任，不自动批准 candidate、不自动 promotion、不修改 Task 完成状态。

### 6.3 谁负责“会话”

```text
调用 Agent
  → Agent Runtime / registered Memory capability
  → Agent I/O admission（Request/Response）
  → Memory Coordinator + Memory Operations Backend
  → Memory Agent analysis operation
  → Journal/Checkpoint/EventBus owners
  → typed AgentResponse + evidence/source refs
```

调用 Agent 不直接连接 Memory Agent provider；Runtime/Memory Coordinator 负责 capability admission、scope、窗口、epoch、重试/等待和收口。Memory Agent provider 只看到经过 admission 的 Agent Request、Context View 和 evidence refs，也不能把 provider session 当作 HumanAgent session。若需要“问一句、补证据、再问一句”，每一轮仍是新 Request/Response，靠 correlation 串联。

## 7. 运行时闭环

### 7.1 Capture → extract → review → inject

```text
1. cycle start
   └─ Main Agent Runtime recalls checkpoint → assembles its own Working Memory
2. cycle execution
   └─ input/output/tool/error 只生成 Episodic source 引用
3. blocked / checkpoint rewind / task completion
   └─ Runtime commits boundary source/snapshot；EventBus publishes memory analysis event
4. Memory Agent analysis
   ├─ recurrence / novelty / conflict
   ├─ Semantic candidate
   └─ Procedural candidate
5. review
   ├─ reject / defer
   ├─ approve project
   └─ approve + promote global
6. next cycle / next task
   └─ Main Agent decides whether to query memory → ContextBuilder assembles its own context
```

提炼触发点以 checkpoint completion 或明确 review 请求为主，不在每个 token 后调用分析 agent。原因：减少成本、避免半成品污染、让一次 cycle 的结果和恢复证据先稳定。

### 7.2 Context injection

现有 `AgentMemoryContextInjectionPort` 保留为 Runtime 的 memory recall seam；它服务主 Agent 的 context assembly，不把 context ownership 转移给 Memory Agent。主 Agent/Runtime 按 project/global policy 主动查询，再由 ContextBuilder 生成自己的 Context View：

```ts
interface MemoryContextPolicy {
  readonly namespaces: readonly ('project' | 'global')[];
  readonly layers: readonly ('working' | 'episodic' | 'semantic' | 'procedural')[];
  readonly allowCandidates: boolean;
  readonly maxTokenBudget: number;
  readonly evidenceRequired: boolean;
}

interface MemoryRecallRequest {
  readonly agentRuntimeId: string;
  readonly bindingRef: string;
  readonly projectKey: string;
  readonly policy: MemoryContextPolicy;
  readonly query?: string;
}
```

`MemoryRecallRequest.bindingRef` 必须解析到全局 `ContextBinding` 的同一判别式合同：`interaction` 分支使用 `interactionScopeId`，不要求也不得补造 `taskId`；`task` 分支由可信 binding 提供 `taskId + assignmentId + executionEpoch`。`MemorySubmission.taskId` 只允许作为已验证 source/filter 引用，不能用来替代 binding；Coordinator 必须从 binding 校验 task scope、assignment 和 epoch。Memory Agent 不创建、修改或拥有 `ContextBinding`。

当前代码中的 `current / task-recent / related / approved-long-term / raw` 是注入窗口层，不是长期记忆类型；映射如下：

| 现有 context layer | 新语义 |
|---|---|
| `current` | Working：当前 directive/assignment/checkpoint |
| `task-recent` | Episodic：当前 task/cycle 的近期来源摘要 |
| `related` | project approved Semantic/Procedural + 相关 episodic 引用 |
| `approved-long-term` | approved project/global Semantic/Procedural |
| `raw` | 按需 inspect 的 Episodic 原文；默认关闭 |

注入结果必须保留 `contextId`、`executionEpoch`、namespace、project key、layer、source ref、digest、token cost、omitted reason 和 index version。`attach` 只绑定主 Agent 已主动选择的召回结果，不修改 Task payload 或 Journal 状态；旧 epoch 的 context 必须拒绝。Memory Agent 不拥有 `attach`，也不因自己的分析结果自动改变 live context。

UI `serve` 的 memory-context operation receipt 是进程内的绑定投影，不是可跨重启恢复的 Operation 事实。当前 `UiRuntimeService` 只在进程内保存已绑定 receipt；UI runtime Journal 只恢复 task、operation 和事件投影，不恢复旧 memory binding、recall context 或 attach 事实。进程重启后，旧 operation 仍可由 Journal 查询，但请求其 receipt 必须返回 `memory-binding-missing`；调用方必须创建新 operation，让新 runtime binding 重新 recall/attach。这样不会把已失效的进程内 binding 伪装成当前 binding。若未来要求跨重启读取 receipt，必须另行定义 durable binding 的 owner、重验证和失效语义，不能仅持久化 receipt JSON。

### 7.3 Memory Interaction Surface

UI 继续通过 `MemoryInteractionPort` 访问记忆；这是用户查询和 review 的唯一边界，不被 context injection seam 取代。这里的 `open` 只创建带 scope/permission 的只读 view handle，不创建 Memory Session，也不保存私有对话上下文：

```ts
interface MemoryActorContext {
  readonly actorId: string;
  readonly roleId: 'interaction' | 'orchestration' | 'review' | 'memory' | 'system';
  readonly permissions: readonly ('memory.read' | 'memory.propose' | 'memory.review' | 'memory.promote' | 'memory.forget')[];
  readonly projectKey: string;
  readonly crossProjectGrantRef?: string;
}

interface MemoryInteractionPort {
  open(input: { readonly actor: MemoryActorContext; readonly projectKey: string; readonly namespace: 'project' | 'global'; readonly taskId?: string }): Promise<MemoryViewHandle>;
  query(input: { readonly actor: MemoryActorContext; readonly projectKey: string; readonly namespace: 'project' | 'global'; readonly query: string; readonly limit: number }): Promise<MemoryView>;
  inspect(input: { readonly actor: MemoryActorContext; readonly sourceRef: string; readonly sourceDigest: string }): Promise<MemoryDetailView>;
  compare(input: { readonly actor: MemoryActorContext; readonly leftRef: string; readonly rightRef: string }): Promise<MemoryComparisonView>;
  review(input: { readonly actor: MemoryActorContext; readonly candidateId: string; readonly decision: 'approve' | 'reject' | 'defer'; readonly decisionReason: string }): Promise<MemoryReviewReceipt>;
  promote(input: { readonly actor: MemoryActorContext; readonly candidateId: string; readonly from: 'project'; readonly to: 'global'; readonly reason: string; readonly impactScope: string; readonly approvalRef: string; readonly sourceRefs: readonly string[] }): Promise<MemoryPromotionReceipt>;
  planForgetting(input: MemoryForgettingRequest): Promise<MemoryForgettingPlan>;
}
```

`MemoryViewHandle`、`MemoryView`、`MemoryDetailView`、`MemoryComparisonView`、`MemoryReviewReceipt`、`MemoryPromotionReceipt` 和 `MemoryForgettingPlan` 是 typed result；此处不允许 UI 自行读取 Journal、Index、artifact、local Skill source 或 Skill Registry。每次 global query 必须由 `actor.permissions` 和 `crossProjectGrantRef` 证明授权；review 必须有 `memory.review`、actor、decision 和 reason；promotion 必须有 `memory.promote`、批准记录、来源列表和影响范围；forgetting 必须有 `memory.forget`，并用 `MemoryForgettingRequest { actor, plan }` 绑定执行者与计划。校验失败显式拒绝。`review` 与 `promote` 只追加 Organ Journal command/result，真正的 approved record 仍由 review/registry owner 落盘。

## 8. 状态与真源

长期记录采用 append-only 状态变化，不原地覆盖：

```text
candidate → approved → active → superseded / expired / archived
candidate → rejected
```

每次状态变化至少引用：

- `recordId`、namespace、project key；
- source refs 和 source digests；
- candidate/review/approval actor；
- `createdAt`、`effectiveAt`、可选 `validUntil`；
- previous record / supersedes refs；
- Journal seq 或 review operation evidence。

真源表：

| 事实 | owner | 非 owner |
|---|---|---|
| Task/Cycle/Checkpoint/Operation 状态 | `packages/core` / `packages/runtime` | Memory Agent、Index、DSH log |
| Task/Cycle/Operation/Checkpoint、source provenance、memory operation 审计链 | `packages/adapters/jsonl` Organ Journal | project-memory projection、Memory Agent、DSH log |
| 大对象和原始输出 | filesystem adapter | prompt、Index |
| 绑定主 Agent 的 session evidence、project 架构/AGENTS/唯一 local Skill 文件 | Session/Filesystem/Source adapter | Memory Agent 不拥有、不改写、不扩大读取范围 |
| 独立 audit prompt source 及其 revision/digest | Project source/Prompt adapter | Memory Agent 只读取 operation snapshot，不拥有、不自动修改 |
| Semantic/Procedural candidate 与 approved memory 的内容/状态 | `project-memory` adapter 的分类 JSONL 事件源 | Markdown、SQLite、summary、Agent 自行入库 |
| candidate/review/promotion 的授权和 operation 结果 | Memory review/registry owner + Organ Journal evidence | Memory Agent、recall、Index |
| project `AGENTS.md` 与唯一 cwd-named local Skill 的文件更新 | Project Rule owner / local Skill owner + compare-and-commit evidence | Memory Agent、audit prompt、global source |
| 检索排名和 embedding | Memory Operations Backend | 事实状态 |
| Runtime binding/epoch/reentry | Core/Runtime + Checkpoint/Control owner | Memory Agent、Memory Coordinator、provider payload、debug log |
| Context View binding/attach | ContextBuilder/ContextCommitter | Memory Agent、provider payload |

## 9. 错误与恢复

| 失败 | 状态 | owner | 下一步 |
|---|---|---|---|
| Journal/source digest 无效 | attention | Journal owner | 修复来源或恢复写入；拒绝提炼 |
| 绑定主 Agent session 或项目文件不可读 | attention | Session/Source adapter | 保留未完成分析责任；不凭缺失文件生成结论 |
| 架构/AGENTS/唯一 local Skill digest 漂移 | waiting 或 attention | Source adapter/Memory Coordinator | 重新读取并绑定新 revision；不混用旧新证据 |
| audit prompt source 缺失、不可读或 digest 漂移 | attention | Prompt source owner/Memory Coordinator | 保留旧 operation evidence；下一次 operation 重新读取，不用内置 prompt 替代 |
| project/global scope 不匹配 | attention | Memory Coordinator | 向 Runtime/Checkpoint owner 请求刷新 binding；Memory Coordinator 重新校验，不注入 |
| 无 Task 的 interaction binding 查询或提交 | `ContextBinding.kind=interaction` + trusted `bindingRef` | Runtime/Memory Coordinator | 正常 recall/save；使用 `interactionScopeId`，不创建伪 Task |
| Index 缺失/版本漂移 | waiting 或 attention | Operations Backend | 重建 Index；不报告空记忆 |
| AI extraction 失败 | waiting/degraded | Memory Agent provider | 保留 episodic；稍后重试分析 |
| candidate 无 evidence | attention | Memory Coordinator | 补齐 evidence；不进入 review |
| project → global promotion 被拒 | ready（candidate rejected） | Review owner | 保留项目记录或结束 candidate |
| forgetting 引用检查失败 | attention | Memory Coordinator | 停止清理，保留恢复责任 |
| attach epoch 过期/上下文篡改 | attention | Runtime/Memory Coordinator | 重新 recall；拒绝 provider attach |

### 9.1 关键场景矩阵

| 场景 | 首个事实 | 负责 owner | 可接受结果 |
|---|---|---|---|
| checkpoint 完成，存在新 source | Journal commit → `memory.analysis.requested` | Runtime/EventBus | project lane 从 durable cursor 开始一次有界分析 |
| 主 Agent 反复被用户纠正 | session correction evidence | Memory Agent | 生成带每次纠正 source refs 的 profile/project-policy candidate |
| 同一流程反复出错 | error/blocked fingerprint | Memory Agent | 生成带 operation、步骤、根因和重复次数的 project lesson candidate |
| checkpoint rewind | rewind/reentry fact | Checkpoint Owner → Memory Agent | 生成绑定失败分支、rewind checkpoint、实际 recovery checkpoint 和 committed reentry fact 的错误/死路记忆；不删除 Absolute Journal |
| rewind 后成功 | success branch + prior failed branch | Memory Agent | 校验 recovery checkpoint/reentry fact 与成功分支的关系；错误 turn 退出 active context；成功路径保留并优先提炼 |
| 多次 rewind 后成功 | 每条 failed branch 的 rewind/recovery/reentry chain | Memory Agent + Checkpoint Owner | 不错配恢复点与成功分支；缺链时保留 episodic evidence 并发布 attention |
| 实际路径偏离架构/AGENTS/唯一 local Skill | source revision/digest comparison | Memory Agent + owner | 输出 efficiency / fact / local Skill update proposal，不直接改文件 |
| `memory.update.auto = false` | update candidate | Memory Agent + owner | 只保留 proposal，不自动修改当前 project `AGENTS.md` 或唯一 local Skill |
| `memory.update.auto = true` | owner update capability | Project Rule/local Skill owner | 仅自动应用通过 digest、冲突、权限和验证 gate 的 project patch |
| auto update 前文件发生变化 | compare-and-commit conflict | Project Rule/local Skill owner | 停止自动更新，保留 candidate，发布 attention，不覆盖人工修改 |
| 自动更新目标是 global/external Skill 或 audit prompt | target admission failure | Memory Coordinator | 显式拒绝，不创建副本、不扩大 auto 权限 |
| 没有新 source | cursor 已追平 | Memory Agent | `waiting/idle`，不调用模型，不制造空记忆 |
| 普通 Agent 查询 project | capability admission | Memory Coordinator/Backend | 仅返回当前 project 的 evidence-bound refs |
| 查询 global 但无 grant | capability denied | Contracts/Core | 显式 `capability-denied/attention`，不是空数组 |
| Agent 提交 `desiredScope=global` | durable intake data event | Memory Coordinator | 先按 project candidate 排队，不能直接写 global |
| source digest 不匹配 | source validation failure | Journal/Memory Coordinator | `attention`，保留 source 和未完成责任，不提炼 |
| candidate 与已有记忆重复 | curation result | Memory Agent/Backend | `duplicate`，保留 submission receipt 和匹配 refs |
| candidate 与已有记忆冲突 | curation result | Memory Agent + review owner | 并列来源进入 review，不静默覆盖 |
| candidate review 通过 | review command/result | Review/Registry owner | approved project；发布 approved event |
| project → global promotion | 独立 promotion command | Review/Registry owner | 有批准、来源、影响范围后才写 global |
| EventBus ACK 丢失 | 原消息重新投递 | Event delivery + Journal Owner | `duplicate` receipt，不重复 backend 写入/外部副作用 |
| Agent 崩溃或 daemon 重启 | lease/reentry + durable cursor | Host/Checkpoint/EventBus | 先取新 lease，再按 cursor replay；不依赖内存 |
| 旧 epoch follow-up 到达 | binding revalidation | Runtime/Memory Coordinator | `stale/rejected/attention`，不改变新 epoch |
| AI provider 不可用 | operation failure | Memory Agent provider | episodic/cursor 保留，`degraded/waiting`，按 retry obligation 重试 |
| Index 缺失或 digest 漂移 | projection verify | Memory Operations Backend | index/export 重建；不把“当前无结果”当作无记忆 |
| forgetting 命中仍被 checkpoint 引用 | reference check | Memory Coordinator | 停止清理，保留 source 和恢复责任 |

Memory Agent 故障不能让 Journal、checkpoint recall、普通 source inspect 或 Task lifecycle 失去真相。Memory 作为 Task 的必需能力时，任务只能进入明确 `memory-unavailable`/`waiting`；不能切到未经批准的全局 fallback。

## 10. 对当前代码的迁移映射

当前实现已有 `MemoryCoordinator`、`MemoryOperationsPort`、`AgentMemoryContextInjectionPort` 和 `DeterministicMemoryBackend`。它们继续复用；迁移只改变长期语义、backend binding 和最小 typed seam：

| 当前实现 | 重设计后的唯一含义 | 迁移动作 |
|---|---|---|
| `MemoryScope.kind = task` | project namespace 下的 task 来源过滤 | 保留为内部窄读输入，不作为长期 namespace |
| `MemoryScope.kind = organ` | 旧的 project 代称 | 改为显式 `namespace: 'project'` + `projectKey`；不再用 organ id 代表 project |
| `MemoryScope.kind = approved-global` | 旧的 organ-scoped global | 改为显式 `namespace: 'global'`；global identity 不绑定某个 organ |
| `ContextLayer` | Working context 的窗口层 | 保留；按 §7.2 映射到五层记忆语义 |
| `MemoryOperationsPort` | Memory Operations Backend 的唯一查询/整理边界 | 保留基础方法；由 `project-memory` adapter 实现 entry/query/get/review/promote/index/export/compact/verify；candidate、promotion、forgetting 使用独立 command/result 类型 |
| `MemoryCoordinator.proposeSkillCandidate` | Procedural candidate / 唯一 local Skill update review request | 保留“只提案”语义，并增加 project Skill source ref、preconditions、failure boundaries 和 update evidence |
| `DeterministicMemoryBackend` | MVP 无 AI backend 的确定性 fallback backend | 先实现 project/global visibility、source provenance、supersede projection；不在 backend 内批准 candidate，也不绕过 `project-memory` 的 root binding |

`project-memory` CLI 的现有操作映射如下：`entry` 是普通 candidate/source 的 one-shot writer；`query/get` 是只读 recall/inspect；`review` 读取 task/run evidence 并形成 review 结果；`promote` 用于有 evidence 的显式 level promotion；project → global 则必须走 adapter 定义的显式 promotion command，并带批准记录。`index/export/compact/verify` 只维护可重建 projection。Memory Agent 不能把 `export` 的 Markdown 当第二真源，不能用 `compact` 删除 source event，也不能把 `desiredScope=global` 映射成无审批的 global entry。local Skill 更新必须回到 manifest 解析出的唯一 cwd-named source；不得通过 CLI 旁路创建带版本号的 Skill。

迁移顺序固定为：

```text
contracts: namespace/source/candidate/state types
  → runtime: binding + policy + promotion/forgetting commands
  → jsonl/filesystem: append source and approved-state records
  → adapters/memory: deterministic project/global index and recall
  → optional provider: extraction only
  → UI/review: approve/reject/promote/expire commands
```

不要把五层各自实现成独立 Memory Agent，也不要新增第二个“长期记忆 manager”。`MemoryCoordinator` 只负责 Memory admission、可信 binding 校验、结果协调和 Memory recovery obligation；Runtime/Checkpoint/Control owner 仍拥有 binding、epoch、reentry 等控制事实。Operations Backend 是查询与可重建投影 owner；可选 AI adapter 只负责分析输出。

## 11. MVP 实施切片

### MVP 必须完成

1. 先将 §2.4 的 canonical memory scope 写进 Journal/contracts，完成 global identity、source provenance、digest/replay 和旧记录兼容边界；再将 project/global namespace 写进其余 contracts。保留 task/cycle/session 作为来源过滤，不再用 `organ` 名义表达 project memory。
2. 为 episodic source、semantic candidate、procedural candidate、review/promotion、supersedes/expiry 定义最小 typed record。
3. Journal ingest 校验 source digest、project key 和 task scope；Index 只保存来源引用。
4. Deterministic backend 提供 exact/full-text search、inspect、compare、recurrence、novelty 和 context assembly；无 AI 可用。
5. `MemoryCoordinator` 统一执行 project/global scope admission、role policy、budget、trusted binding/epoch validation、candidate review request 和 failure state；不产生或修改 Runtime binding/epoch。
6. 一个 memory-agent fixture 完成：读取来源 → 生成 candidate → 进入 review-required；测试证明不能直接写 approved、local Skill source 或 Skill registry。
7. 一个 project/global fixture 完成：project 记忆可读，未批准 global 不可读；显式 promotion 后 global 才可读；project 新事实不改写 global。
8. forgetting fixture 完成：新批准记录 supersede 旧记录；derived Index 可重建；仍被 checkpoint/approved record 引用的 Journal 来源不可删除。
9. boundary fixture 覆盖 blocked、checkpoint rewind 和 task completion：主 Agent 的 live context 不被 Memory Agent 修改；Memory Agent 能从 committed source 生成 project fact、project experience、profile、global 和 Skill update candidates。
10. local Skill update fixture 证明重复且成功的 procedural evidence 才能形成带 source ref/revision/diff/evidence 的唯一 cwd-named Skill update proposal；没有 local Skill owner review 不能生效。
11. auto update fixture 覆盖 `auto=false` proposal-only、`auto=true` project `AGENTS.md`/唯一 local Skill patch、typed artifact 缺失或 digest conflict、source digest conflict、验证失败和 global/external/prompt target 拒绝；自动更新不能越过对应 owner。
12. audit prompt fixture 证明 prompt source 可独立替换；每个 operation 固定 prompt ref/revision/digest，下一次 operation 使用新版本，且 prompt 不能改变 control fact 或自动更新范围。
13. interaction binding fixture 证明无 Task 的 Agent 可通过可信 `bindingRef` recall 和提交 candidate；task binding 仍校验 `taskId + assignmentId + executionEpoch`，Memory 层不创建伪 Task 或拥有 epoch。

### MVP 不做

- 向量数据库、知识图谱产品化、远端 Memmy、跨租户同步；
- 自动把每轮对话写成 Semantic/Procedural approved memory；
- 未经 review 的自动 global promotion；
- 以 LLM 相似度代替 source digest、scope 或批准状态；
- 为性能数字建立未经本地样本和同入口证据支持的承诺。

## 12. 验收证据

Memory Agent 完成 iff：

- project/global 数据路径在 `~/.humanagent`，workspace 无持久化 memory；
- episodic 来源可从 Journal replay，source digest 可验证；
- 绑定主 Agent 的 session evidence 可只读读取并带 source ref/digest；其他 Agent session 不可读；
- 相关架构文件、项目 `AGENTS.md` 和唯一 cwd-named local Skill 可按 allowlist 只读读取并绑定 revision/digest；读取失败或漂移不会被猜测补齐；
- 独立 audit prompt source 可按 `prompt_ref` 读取并绑定 prompt revision/digest；提示词可独立修改，operation 不混用新旧 prompt；
- working context 有界、带 omitted reason，可由 checkpoint/source refs 重建；
- semantic/procedural candidate 带证据，review 前不可成为 approved；
- project 与 global 的读取、promotion、冲突边界有正反测试；
- forgetting 不丢失恢复/审计来源，Index 删除后能重建；
- recall/attach 绑定 role、scope、budget、index version 和 execution epoch；
- interaction-bound recall/submission 不要求或伪造 Task；task-bound recall/submission 的 Task、Assignment 和 Epoch 来自全局可信 binding；
- 主 Agent 自己拥有临时 context/turn slots；blocked/rewind 后可移除 active 错误 turn，但 Absolute Journal 仍可查询；
- blocked、checkpoint rewind、task completion 都能触发有界 Memory Agent processing；项目经验、项目事实、用户画像、global 和 local Skill update 结果各走对应 review/approval owner；
- 重复用户纠正、重复错误、rewind checkpoint 和实际流程效率差异均有独立 evidence refs、分析结果和后续 owner；
- rewind 错误记忆可校验关联 failed branch → rewind checkpoint → 实际 recovery checkpoint/reentry fact → successful branch/evidence → Absolute Journal；多次 rewind 不错配，缺链时只保留 episodic evidence 并发布 attention；
- `memory.update.auto` 的默认值、仅限当前 project `AGENTS.md`/唯一 cwd-named local Skill 的 target、自动 patch 的 old/new revision/digest、验证结果和失败 attention 可审计；global AGENTS、global memory、audit prompt 与外部 Skill 不受 project auto 开关越权修改；
- AI 不可用时基础 capture/search/inspect 仍成立，AI 依赖失败显式暴露；
- 失败 owner、状态、next action 和未完成项可从 Journal/Attention/UI projection 读取；
- review 通过后才可进入候选提交、merge、重建产物和实际入口验收；文档设计本身不冒充代码、安装或运行时完成。
