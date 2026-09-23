# 显式大脑端到端可用目标

状态：`ACTIVE`
日期：2026-09-22
父目标：`p0-p1-patrol-20260922.md`（巡检收口）

## 唯一目标

把「显式大脑」推进到**真实前端可跑通且正确呈现**：用户在真实产品入口用自然语言提出需求，
显式大脑完成理解 → 确认 → 派发 → 执行 → 观测，并且每一个状态在 UI 上都有正确、可核验的呈现。
完成判据是真实入口证据，不是源码测试、候选分支或理论分析。

## 1. 主线 DAG（五段必须逐段有真实证据）

```text
自然语言输入
  → [A] 理解：显式大脑整理成 draft/understanding，不自动确认
  → [B] 确认：用户显式确认后才入库（无 auto-confirm、无 auto-redirect）
  → [C] 派发：按 FIFO 进入隐式队列并创建 task
  → [D] 执行：真实 provider 轮次拿到要求正文并实际执行
  → [E] 观测：Pipeline Observation 只读展示节点树、状态、输入/输出与证据
```

每段终点都必须有真实入口证据。缺任一段 → `INCOMPLETE`。

## 2. 进度大盘（2026-09-22 基线）

基线 main：`a2e9e96848f21c2ba4253471284286d3b9e6e0f7`（本轮起点 `a88bd03`）
origin/main：`a2e9e96`（已推送）

| 段 | 缺陷/任务 | 状态 | 证据层级 |
| --- | --- | --- | --- |
| A/B | `7b6c725` 显式大脑 UI 自动确认、隐藏 queued/retired/blocked | **已合入 main `d604fbc`（tree `8a23c42`，与 review 候选逐字节一致）并推送**；bug 已关闭，worktree/分支已回收 | 候选级 review PASS（commit 模式，仅 2×P2）。main 级真实入口复验进行中：`ha-fe-main-e2e-20260922` |
| C | 隐式队列准入与 retired 语义 | `2f61663`/`c7d9c99`/`5c03c99` 等已合入 main | main 级 |
| D | `80ad80c` serve 记忆/推理组合缺 model driver；任务绑定记忆 | 候选 `7c31b17` review FAIL（2×P1） | **BLOCKED**：①`reviewState()` 取 Map 末位 consumer，多任务时状态来自任意/stale consumer；②缺 `publishTask → task consumer stream → admission` 端到端证据；③live RCC curation JSON 解析失败，无候选产出 |
| D/E | 显式大脑推理真实可用 | 未成立 | live RCC 未产出可审核候选，审核→后续召回未跑通 |
| 集成 | main 被 `80ad80c`/`7b6c725` 泄漏字节污染，`pnpm typecheck` RED（8 errors） | 待收口 | 泄漏字节已定位，非本轮 commit，未授权前不动 |
| A/B 布局 | `1bf5d7a` 任务列表竖排文字 | **已合入 main `8e4e42b`（`b0df103`+`8e4e42b`）并推送**；bug 已关闭，worktree/分支已回收 | main 上 `tasks.css` 与 review 候选 `86673c0` 逐字节一致；main 级逐宽度复验进行中 |
| A/B 布局 | `1bf5d7a` main 级复验 | **PASS**：1081/1104/1129/1130/1280/1536 六档 `.task-row-link` 内溢出=0、行溢出=0、时间列与操作列恒 +12px 不重叠、无横向滚动条；1130 处 197 字符标题为正常换行（140×187，约 9 行）而非竖排 | 真实浏览器 + 隔离 serve，`/private/tmp/ha-fe-main-e2e-art/d-band-measurements.jsonl` |
| D | `80ad80c` 任务绑定记忆状态聚合 + audit JSON 契约 | **已合入 main `a2e9e96`（候选 `ca4adec`）并推送**；独立 review PASS（0 findings） | main 级：typecheck 0、test:app 283/283、test:memory 44/44、test:agent-templates 17/17 |
| D | 真实 provider 产出候选 | **阻塞已定位（新 bug `eab6700`，P1）**：`publishTask` 传给分析的 observation 只有 `checkpoint <outcome> for task <id>` + recovery pointer，任务指令/输入/输出/run notes 从未进入分析，模型只能判 `attention`。已授权 owner 扩展证据装配 | live RCC 原始 curation JSON 为 `outcome=attention`（诚实分类）；已隔离证据 `/tmp/ha-rcc-lesson-FeLKhd/serve.log` |
| A/B | 排队态可见性 | **新 bug `8ca7e7d`（P1）**：drain 与确认响应同处一个 microtask（`service.ts:1977-1985`、`1869`），且 `queuedRequirementProjection()` 只读 `pendingDraftIds[0]`，被 blocked 头阻塞的后续需求完全不投影 | 105256 次采样只见 `none`；已派实现并将在实现后独立 review |
| 集成 | main 泄漏字节收口 | **已完成**：6 个非 commit 文件恢复到 `a88bd03` 提交内容，字节先保存到 `/tmp/main-leak-preserve-20260923T0528/`（diff sha256 `4ddd8c70…207`）；用户既有脏状态原样保留 | main 级：`pnpm typecheck` 由 RED(8 errors) 转为 0 |

## 3. 完成定义

1. `7b6c725` 候选 `7783557` 合入 clean main，重建前端，在 main 同入口用真实 serve 复验 A/B 段
   （不自动确认、draft/confirmation 可见、queued/retired/blocked 与 admitted/executing/completed 区分）。
2. `80ad80c` 两条 P1 修复 + live 真实 provider 跑通**至少一次** candidate → approve/reject → 后续任务召回；
   若确认是外部 provider 契约阻塞，给出精确 raw artifact、parser 错误、owner 与决策，不得以"未实现"含糊收口。
3. D 段在 main 上真实入口复验：真实 provider 轮次读到要求正文（非 payloadRef），工具轮续传成功。
4. E 段在真实前端可观测：Pipeline Observation 展示节点树/状态/输入输出/证据，只读、不消费需求、不改队列。
5. main 保持可验证：`pnpm typecheck`、受影响 focused tests、app/runtime 测试全绿。
6. 已合入任务的 worktree、分支、临时进程、camo target、playground 条目全部回收。

## 4. 调度与所有权

- 实现者与独立审查者必须是不同 agent。
- 共享组装点（`packages/app/src/cli.ts`、`packages/app/src/memory-composition.ts`、
  `packages/app/src/memory-runtime.ts`、`ui-runtime/service.ts`、`docs/ui/runtime-api.js`）
  由单一集成 owner 持有；实现者先交独立模块与测试，再由该 owner 接线。
- 每个 worker 独占新 worktree 与不重叠文件范围；禁止在 dirty main 上改业务代码。
- main 收口（保存泄漏字节到 main 之外 → 恢复 `a88bd03`）是唯一前置集成动作。

## 5. 非目标

不扩展 DSH、向量/RAG、多节点或生产部署；不重写 Harness；不改 RCC 配置或凭据；
不为本目标新建治理骨架或第二套 task truth。

## 6. 外部闸门

- main 收口需人类授权（git 状态改变）。解除条件：授权保存泄漏字节并恢复 clean main。
- `80ad80c` 若确认为 RCC provider 契约阻塞，需给出精确证据后由人类决定是否调整 provider 侧。
