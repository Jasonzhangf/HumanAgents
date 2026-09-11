# HumanAgent Memory System

状态：`DESIGN-BOOTSTRAP / MEMORY-DESIGN-DRAFT`  
日期：2026-09-11  
适用阶段：MVP → Milestone 3

本文定义记忆系统的边界、索引方式、用户交互面、后台操作面和 Agent 上下文插入接口。记忆系统不是一个必须通过 AI 对话才能工作的 agent；`memory agent` 只是任务流程中负责协调记忆分析的一个角色。真正的记忆能力由确定性的后台操作端口提供，AI provider 只能作为可选分析器或摘要器。

## 1. 设计结论

记忆系统拆成两个产品部分和一个受 Harness 控制的接缝：

```text
Memory System
  ├── Memory Interaction Surface
  │     └── 用户查看、搜索、比较、标注、review、批准/拒绝
  ├── Memory Operations Backend
  │     └── ingest、Index、RAG、比较、重复/新颖性、沉淀、保留
  └── Agent Context Injection Port
        └── 按 scope 和层级为 Agent 装配可追溯的上下文引用
```

三者职责不同：

| 部分 | 唯一责任 | 不能做什么 |
|---|---|---|
| Memory Interaction Surface | 把记忆事实和候选沉淀以人可理解的层次呈现，并接收用户的查询、标注和 review 决策 | 不直接读数据库、不绕过权限写 Journal、不自动入库 Skill |
| Memory Operations Backend | 从 Journal/checkpoint/session evidence 建立可查询投影，执行检索、比较、分析和保留 | 不拥有 Task/Checkpoint/Skill 最终真相，不直接决定用户批准 |
| Agent Context Injection Port | 根据 Agent 的 scope、角色和预算装配分层上下文，保留来源和 digest | 不把搜索分数当事实，不让 Agent 直接写索引或扩大 scope |

`Memory Agent` 调用 Operations Backend，形成 `MemoryFinding` 和 `SkillCandidate`；它不能代替 Backend，也不能绕过显式交互把候选 Skill 直接写入模板 registry。

## 2. 真源和索引分层

权威事实仍来自 HumanAgent Journal、checkpoint 和不可变 asset。Index 是可删除、可重建的查询投影：

```text
Organ Journal / Checkpoint / Asset evidence       [权威来源]
        │ ingest + verify
        ├── exact metadata index                  [scope/seq/type/tag]
        ├── lexical/full-text index               [关键词]
        ├── vector/RAG index                      [可选语义召回]
        └── recurrence/novelty projection          [可重建分析结果]
                │
                ├── Memory Interaction Surface
                └── Agent Context Injection Port
```

每个索引记录至少保存：

```ts
type MemoryIndexEntry = {
  indexEntryId: string
  sourceKind: 'journal' | 'checkpoint' | 'asset' | 'session-evidence'
  sourceRef: string
  scope: { organId?: string; taskId?: string; cycleId?: string }
  sourceSeq?: number
  sourceDigest: string
  indexVersion: string
  searchableTextRef?: string
  vectorRef?: string
  tags: string[]
  createdAt: string
}
```

约束：

1. Index entry 只能指向来源，不能生成新的任务状态、完成状态或权限状态。
2. `indexVersion`、embedding model、分词器或分析规则改变时，可以重建索引；不能修改原始来源 digest。
3. 查询结果先返回 `sourceRef`、`sourceSeq`、摘要和命中原因；完整内容通过 `inspect` 按需读取。
4. 向量相似度、关键词排名和新颖性分数是召回依据，不是事实可信度。UI 和 Agent 都必须能看到来源和证据范围。
5. Index 丢失、损坏或版本不兼容时，进入 `reindexing`/`memory-unavailable`，不能伪造“没有记忆”或静默使用过期结果。
6. 从 Journal 重建后，查询结果必须仍能定位到相同的 seq、asset digest 和 scope。

## 3. 分层暴露和 Agent 上下文插入

记忆不能把所有历史一次性塞进每个 Agent。上下文注入由 Harness 统一控制，按角色、Task scope、权限和窗口预算装配五层内容：

```text
L0  当前控制上下文：Task/Directive/Checkpoint/Assignment 必需字段
L1  当前任务上下文：近期输入、最近结果、当前 Reporting Window
L2  相关历史上下文：Index 召回的摘要、引用、比较结果
L3  跨任务长期上下文：已批准的记忆、稳定经验、SkillCandidate 证据
L4  原始详情：完整 Journal/asset/session evidence，默认不注入，按需 inspect
```

默认规则：

- interaction agent 默认只读 L0–L2 的人类可解释摘要，不自动获得跨任务原始历史；
- orchestration/review agent 可以按任务需要请求 L2–L3，但每条结果必须带来源、scope 和 digest；
- execution agent 默认只获得 assignment 需要的 L0–L1 和明确授权的 L2，不获得无关任务历史；
- memory agent 可以查询 L2–L4，但仍受 task scope、权限和证据策略限制；
- L4 只通过显式 `inspect` 或明确的 Agent 请求展开，不因为命中 Index 就自动注入。

统一插入接口由 `contracts` 定义，具体 Index/RAG 实现由 Backend 提供：

```ts
type AgentMemoryContextRequest = {
  agentRuntimeId: string
  roleId: string
  taskId: string
  scope: 'task' | 'organ' | 'approved-global'
  layers: Array<'current' | 'task-recent' | 'related' | 'approved-long-term' | 'raw'>
  query?: string
  tokenBudget: number
  evidenceRequired: boolean
}

type AgentMemoryContext = {
  contextId: string
  entries: Array<{
    layer: string
    summary: string
    sourceRef: string
    sourceSeq?: number
    sourceDigest: string
    scope: string
  }>
  omitted: Array<{ reason: string; sourceRef?: string }>
  indexVersion?: string
}

interface AgentMemoryContextInjectionPort {
  recall(input: AgentMemoryContextRequest): Promise<AgentMemoryContext>
  attach(input: {
    agentRuntimeId: string
    context: AgentMemoryContext
  }): Promise<{ contextId: string; attached: boolean }>
}
```

`attach` 只是把已审计的上下文引用交给本次 Agent Runtime；它不把记忆写入 Task payload，也不改变 Journal。Harness 在 Agent 启动、resume 和每次 assignment 变更时调用该端口，记录 `contextId`、scope、layer、indexVersion 和 source digest；旧 execution epoch 的上下文不能推进当前任务。

## 4. Memory Operations Backend

后台操作端口可以完全由规则、SQL/full-text、文件索引、embedding/vector 和确定性分析组成：

```ts
interface MemoryOperationsPort {
  ingest(input: MemoryIngestRequest): Promise<MemoryIngestReceipt>
  search(input: MemorySearchRequest): Promise<MemorySearchResult>
  inspect(input: MemoryInspectRequest): Promise<MemoryRecord>
  compare(input: MemoryCompareRequest): Promise<MemoryComparison>
  detectNovelty(input: NoveltyRequest): Promise<NoveltyResult>
  detectRecurrence(input: RecurrenceRequest): Promise<RecurrenceResult>
  proposeSkill(input: SkillProposalRequest): Promise<SkillCandidate>
  reindex(input: ReindexRequest): Promise<ReindexReceipt>
  compact(input: MemoryCompactionRequest): Promise<MemoryCompactionReceipt>
}
```

最小后台流水：

```text
Journal/checkpoint/session evidence
  → ingest + source verification
  → exact/lexical/vector projection
  → search/compare/recurrence/novelty
  → MemoryFinding / SkillCandidate
  → explicit review or task policy decision
  → approved memory/skill record
```

其中 `proposeSkill` 只能生成候选及其证据，不能写入 Agent Template 或 Skill registry。`compact` 只能清理可重建的索引、窗口和已解除引用的历史细节；不得删除仍被 checkpoint 或 approved memory 引用的来源。

可选的 AI provider 位于 Operations Backend 后面：

```text
Memory Operations Backend
  ├── deterministic index/search/compare   required
  ├── vector/RAG adapter                   optional
  └── AI summarizer/semantic analyst      optional
```

AI 不可用时，exact search、full-text search、source inspect、duplicate/recurrence 规则分析和 context assembly 仍可以完成；只有依赖 AI 的语义摘要或语义判断进入明确的 `degraded`/`waiting`，不能把空摘要视为成功。

## 5. Memory Interaction Surface

用户交互面不是普通聊天窗口，也不要求用户通过 AI 才能使用记忆：

```ts
interface MemoryInteractionPort {
  open(input: MemoryScope): Promise<MemoryViewHandle>
  query(input: MemoryQuery): Promise<MemoryView>
  inspect(input: MemoryInspectSelection): Promise<MemoryDetailView>
  compare(input: MemoryCompareSelection): Promise<MemoryComparisonView>
  annotate(input: MemoryAnnotationCommand): Promise<MemoryAnnotationReceipt>
  reviewSkill(input: SkillReviewCommand): Promise<SkillReviewReceipt>
}
```

呈现采用分层暴露：

- Task Detail 只显示当前任务相关的记忆摘要、重复性/独特性判断、候选沉淀和证据数量；
- 点击摘要进入 drawer，查看命中来源、seq、scope、digest 和比较依据；
- Memory Inspector 才提供跨任务搜索、原始历史、Index 状态和重建入口；
- Skill review 只显示候选、依据、影响范围和批准/拒绝/延后选项；批准后才提交给 Skill registry owner；
- 正常任务 UI 不展示 Index 表、向量分数、Agent 内部提示词或后台 RAG 调试信息。

UI 只能调用 `MemoryInteractionPort`，不能直接读取 Journal、SQLite、向量库或 Memmy-like service。Memmy-like 服务必须通过 `MemoryOperationsPort` adapter 接入，并受 scope、来源 digest 和重建协议约束。

## 6. Memory Agent 的位置

每个 Task 都绑定 memory scope 和 memory runtime，但不要求每次都启动 AI memory agent。Harness 至少保证：

1. 任务历史可被 Operations Backend ingest 和查询；
2. 编排 agent 可以通过 `MemoryOperationsPort`/`AgentMemoryContextInjectionPort` 查询和询问；
3. memory agent 若被启用，只负责分析、比较、候选沉淀和反馈；
4. memory agent 故障不应让 Journal、普通历史查询或 Task 生命周期失去真相；
5. memory backend 不可用时，任务进入明确的 `memory-unavailable` 或降级路径，保留恢复责任；
6. Skill 入库始终由显式 review 和 registry owner 完成。

## 7. 生命周期和错误闭环

Memory 每次操作都遵循：

```text
request
  → scope/permission admission
  → ingest/search/compare/propose
  → evidence and source verification
  → result or explicit unavailable
  → checkpoint/operation closure
  → next action or escalation
```

典型错误 owner：

| 问题 | owner | 处理 |
|---|---|---|
| Journal 来源损坏/断链 | Journal owner | 拒绝 ingest，报告证据错误，等待修复 |
| Index 缺失或版本漂移 | Index/Memory Operations owner | 重建或进入 `reindexing`，不伪造空结果 |
| RAG/embedding provider 不可用 | RAG adapter owner | 保留 exact/full-text 路径；语义能力标记 degraded |
| scope 越权或来源不匹配 | Harness permission owner | 拒绝注入并产生 Attention |
| AI 摘要失败 | 可选 AI provider owner | 保留原始引用，进入待分析；不阻塞基础 inspect |
| Skill review 超时/拒绝 | Memory/interaction owner | 候选保持 pending/rejected，不自动入库 |

## 8. 阶段安排

- MVP：本地 deterministic Memory Operations Backend，基于 Journal/asset 引用提供 exact/full-text 查询、inspect、基础重复/重复发生分析、最小 context injection；提供静态 Memory Interaction Surface 和 Skill review 入口，不依赖 AI、向量库或 Memmy。
- Milestone 1：Memory runtime 作为固定 Task 流程绑定，支持编排 agent 查询、context attach、session evidence ingest；不改变 Harness gate。
- Milestone 2：SQLite/全文/向量 Index、重建、分层窗口、长程 compact、历史恢复和跨 cycle recurrence；增加可选 RAG adapter。
- Milestone 3：Memmy-like remote backend、索引迁移、权限/租户隔离、provider 插件签名、远端故障恢复和可运维的 Memory Inspector。

Memory System 完成的判定不是“AI 能回忆”，而是：权威来源可追溯、Index 可重建、分层召回有边界、Agent context 可插入且带证据、无 AI 时基础操作仍成立、候选 Skill 不会绕过用户 review 自动入库。
