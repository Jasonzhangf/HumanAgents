# Dashboard E2E runner design（编码前设计准入）

Status: design candidate（等待独立 review）
Baseline: `cc5f3f0d49d98a4148abcdc7f7bcc814c80cdbb2`
Graphs: 每条命令一个独立 SESE 图
[`dashboard-e2e-web-search.graph.json`](../dagpipe/dashboard-e2e-web-search.graph.json)、
[`dashboard-e2e-local-file-search.graph.json`](../dagpipe/dashboard-e2e-local-file-search.graph.json)、
[`dashboard-e2e-aitest.graph.json`](../dagpipe/dashboard-e2e-aitest.graph.json)
Contract: [`docs/ui/dashboard-e2e-acceptance.md`](dashboard-e2e-acceptance.md)
Web-search gate: [`docs/architecture/hand-search-websearch-plan.md`](../architecture/hand-search-websearch-plan.md)

## 1. 目标与范围

实现验收合同要求的三个命令，各自独立跑通一次真实浏览器 E2E 并产出绑定同一候选 SHA 的 receipt：

```sh
pnpm e2e:dashboard:web-search
pnpm e2e:dashboard:local-file-search
pnpm e2e:dashboard:aitest
```

三次 attempt 是三条互相独立的链路：各自新的 task/run ID、独立的隔离 runtime/workspace、独立的
receipt 与独立收口。因此每条命令有**自己的 SESE 图**（单源单汇），不把三条命令 AND-join 到一个终点：
单独跑一条命令时，另外两条的产物根本不存在，任何要求"三条同时成立"的汇合节点都无法满足。

范围内：统一 runner 与 lib、三个场景断言、为本地搜索补齐 typed 结果契约与读取入口、receipt/截图、
失败/超时/取消两条收口分支。
范围外：Retry-10 独立验收（本轮不验证，标 `INCOMPLETE`）；扩大 Dashboard 的事件窗口。

## 2. 能力确认（编码前门禁，已完成）

| 能力 | 证据 | 结论 |
| --- | --- | --- |
| 真实 headless 浏览器 | 既有兼容 runner 已跑通 入口→草稿→确认→队列→运行中看板，产出 4 张真实截图（`docs/evidence/explicit-implicit-e2e/browser-acceptance-584f048.md`） | 可用 |
| 真实 Provider | RCC `127.0.0.1:4444`；journal 记录 11 次 `provider.tool` 执行 | 可用 |
| `file.search` Provider 工具 | `packages/app/src/provider-tool-execution.ts:192` 已注册并接线 | 可用 |
| 网络搜索后端 | `monid run -p tinyfish -e /search` → HTTP 200，返回真实 title/url/snippet，价格 0 | 可用 |
| 网络搜索后端的分页与完整性语义 | 已按真实 provider 复核并记录：`docs/architecture/evidence/tinyfish-search-capability.md`。实测 `page` 为 0–10 的零基分页，每页恰 10 条且 `position` 每页从 1 重排；`total_results === results.length`，不是全局命中数；唯一可观测的完整性信号是"某页少于每页上限"。因此契约改为 provider 自己翻页 0–10、在首个短页停止，并记录 `providerPagesFetched` / `exhausted`，不再声称"网络上全部匹配" | 可用（契约已按实测修正） |
| 网络搜索的取消语义 | 同上证据文档：`monid runs get -r <runId>` / `monid runs stop -r <runId>` 存在；对已结束 run 调 stop 返回 `CONFLICT ... already COMPLETED`。本地 abort 不证明远端 run 已停 | 可用（契约已按实测修正） |
| 网络搜索 Provider 工具 | 不存在；`web.search` 目前只是 Hand gateway service | **缺口，见 §5 门禁** |
| AItest 任务与 checker | `AItest/tasks/pelican-bicycle/`：`prepare-run.sh`（run 已存在即失败，天然不覆盖）与 `inspect-result.mjs`（exit 0 要求非空 + html root + 恰好 1 个内联 SVG + 存在动画） | 可用 |

## 3. 已定位的既有偏差

1. **计数口径错误**：旧兼容 runner 从 `dashboard.recentEvents` 统计 turn/tool 数，而该窗口只有最近 20 条
   （`packages/runtime/src/ui-runtime/coordinator.ts:2764`、`packages/ui/projection/runtime.ts:210`）。
   实测任务成功并执行 11 次 `provider.tool`，runner 仍报 `0 provider.tool rounds` / `1 request-start turn`。
   本设计的**计数与终态断言取自权威 journal**，UI 渲染只作为独立的可见性断言（§6.1）。该兼容 runner
   已退役：其未被覆盖的可见性断言已迁入 `lib/browser.mjs` 与 `scenarios/local-file-search.mjs`。
2. **`pnpm e2e:dashboard:*` 当时不存在**：本设计在 `package.json` 增加三条 script（见 §4）。
3. **web-search 断链**：`docs/architecture/hand-search-websearch-plan.md` 仍是 `design candidate` 且排除外部 provider。

## 4. 模块与 owner

新增 `tests/app/dashboard-e2e/`（本轮先落接口骨架，行为在 design review PASS 后实现）：

```text
runner.mjs                        唯一入口；解析 --scenario；串起三条分支与失败分支
lib/binding.mjs                   候选 SHA/tree/diff digest 绑定 + 本轮资源登记
lib/browser.mjs                   playwright 装载、serve 生命周期、页面助手
lib/journal.mjs                   只读权威 journal；turn/tool 统计与终态断言
lib/receipt.mjs                   receipt / INCOMPLETE receipt 写入
lib/cleanup.mjs                   settled / 未 settled 两条收口分支
scenarios/web-search.mjs
scenarios/local-file-search.mjs
scenarios/aitest.mjs
```

`package.json` 增加三条 script，均调用同一 runner 并显式设定 receipt 与截图目录：

```json
"e2e:dashboard:web-search": "node tests/app/dashboard-e2e/runner.mjs --scenario web-search",
"e2e:dashboard:local-file-search": "node tests/app/dashboard-e2e/runner.mjs --scenario local-file-search",
"e2e:dashboard:aitest": "node tests/app/dashboard-e2e/runner.mjs --scenario aitest"
```

DAG 节点与 owner 的绑定见四张图的 `.graph.binding.json`：runner 步骤绑定到本轮新增的
runner/lib/scenario 模块——`browser_session` 绑定 `lib/browser.mjs`（真实浏览器与 serve 生命周期），
`candidate_binding` 绑定 `lib/binding.mjs`，失败/收口链路绑定 `runner.mjs`、`lib/journal.mjs`、
`lib/receipt.mjs`、`lib/cleanup.mjs`——产品步骤绑定到真实产品 owner。Dashboard `web.search` 工具链上：

- `packages/app/src/ui-runtime/index.ts` 是**工具注册/能力暴露**的唯一 owner（它组装 `providerTools`）；
- `packages/app/src/provider-tool-execution.ts` 拥有工具声明、派发、typed 结果与 report/digest 持久化，
  **不**注册工具；
- `packages/adapters/operations/src/web-search-provider.ts` 是 Agent Reach/TinyFish provider 调用的唯一
  owner，被 Hand service 与 Dashboard 工具共同复用；
- `packages/adapters/provider/src/agent-driver.ts` 在 report/digest 生成之后把 typed 结果投影为 Provider
  结果事件（含 `callId`、status、error、`outputDigest`），停止/取消时也必须发出同一 `callId` 的 typed
  结果事件，不能静默吞掉；
- `packages/contracts` 拥有该结果事件与 `ProviderToolResult` 的字段与 validator；
- `packages/runtime/src/ui-runtime/coordinator.ts` 负责把调用与结果投影进 Journal/SSE/DOM（结果投影必须
  发生在 report descriptor 生成之后）；
- `packages/app/src/ui-runtime/server.ts` 负责读取入口与任务级停止派发。

Hand gateway 的 `packages/runtime/src/hand/web-search.ts` 与
`packages/adapters/operations/src/web-search-route.ts` 只在 Hand service 自身在范围内时绑定，不承担
Dashboard 工具的 typed 结果与 report 语义；Dashboard 工具不得经由 `web-search-route.ts` 派发，否则
同一个调用会出现两个 report writer。

## 5. 网络搜索门禁（阻塞项）

验收合同 §24 要求：网络搜索只可按 `docs/architecture/hand-search-websearch-plan.md` 中明确覆盖
Agent Reach/Monid TinyFish、Dashboard 工具注册与调用/取消/result/report/cleanup 路径的版本实施，
且该 SESE DAG 须独立 review PASS 后才能编码。

因此 `web_search_*` 分支的实现顺序是：

```text
hand-search plan 更新（覆盖 TinyFish + Dashboard 生命周期边）
  -> 独立 review PASS
  -> 实现 Dashboard 到 TinyFish 的可执行边（Provider 工具 + 结果/report/cleanup）
  -> 实现 web_search_* runner 分支
```

在该 review PASS 之前，`pnpm e2e:dashboard:web-search` 只允许报告 `INCOMPLETE` 并附具体断点，
不得用内置搜索、mock、模型知识、付费 provider 或一次 Provider 调用计数替代。

## 6. 场景断言

### 6.1 统一前置（三条分支共用）

- 每次 attempt 先登记：owner、唯一 run ID、候选 SHA/tree、workspace、control root、serve PID 与端口、
  浏览器 profile、临时文件与日志路径（`lib/binding.mjs`）。
- 真实页面链路：加载 served Dashboard → 在 `.quick-create-form` 输入 → 等待可见草稿 → 点击确认 →
  任务进入队列 → 打开任务详情。
- 计数与终态只取自权威 journal：`<controlRoot>/sessions/<workspace-key>/checkpoints/ui-runtime/<provider>/ui-runtime-journal.jsonl`
  的 `operation.event` 记录；断言 `execution.terminal` 为成功终态、`provider.tool` 轮数 ≥ 2、
  每轮有配对的 `provider.tool-result`。UI 侧另行断言事件行、状态 chip 与终态文案。
- 每个场景分别断言适用的成功路径；失败/取消路径由 §7 的链路统一断言。
- **尝试记录链**：每条命令的图是一条单链。每个阶段节点都产出"成功或错误"的 typed 尝试记录并把它
  交给下一节点，因此**任一阶段先失败时，失败收口依然可达**：不存在"必须先拿到后面的成功产物才能
  触发失败检测"的断边。整图没有任何合取（AND）汇合节点，唯一的终态选择节点 `attempt_outcome_select`
  只接收上一步的记录，并只发出**一个**终态（成功 / 失败 / 取消）。

### 6.2 网络搜索

- 任务要求真实网络搜索并给出可核对来源。
- 断言存在真实 Provider 工具调用与其结果，结果含真实 `url`/`title`；来源在任务详情可见。
- Provider 失败时必须展示真实错误语义；禁止伪造空结果成功。

### 6.3 本地只读搜索（产品契约补齐）

合同 §25 要求的契约与入口，按唯一 owner 落地：

| 契约/入口 | 唯一 owner | 设计要求 |
| --- | --- | --- |
| `ProviderEvent.toolCall` 是 callId/toolId/arguments 唯一真源 | `packages/adapters/provider` | 不得从 summary、eventId、evidence locator、operationId 或最终回答反推 |
| `toolPhase='result'` 携带 typed `ProviderToolResult`（task/operation/epoch、callId、toolId、status、evidenceRefs、error） | `packages/contracts` + `packages/adapters/provider/src/agent-driver.ts` | validator 校验；失败/取消也必须产生同 callId 的结果，不能只抛异常 |
| 成功结果含唯一 immutable output descriptor `{ outputRef, outputDigest }`，`outputDigest` 为 `sha256:<64 lowercase hex>` | `packages/app/src/provider-tool-execution.ts` | 报告持久化与摘要生成唯一 owner；写入 `ImmutableAssetStore` 后附入结果；读取时重算 SHA-256 |
| 调用与结果投影到 `RuntimeTaskEvent`/Journal | `packages/runtime/src/ui-runtime/coordinator.ts` | 唯一投影 owner |
| `RuntimeTaskEventProjection` / `RuntimeSseEvent` 类型字段 | `packages/ui/contracts/runtime.ts` | 事件与公开投影保留 taskId、operationId、executionEpoch、seq、callId、toolId、arguments、结果状态/错误及 descriptor |
| task-scoped 读取入口 `GET /api/tasks/{taskId}/operations/{operationId}/executions/{executionEpoch}/events/{seq}/tool-output` | `packages/app/src/ui-runtime/service.ts` + `server.ts` | 由 `UiRuntimeService` 校验 task/operation/epoch/seq 对应的成功 `file.search` 结果及 descriptor digest 后返回报告；不得用 task 内不保证唯一的 callId 单独查找，不得暴露 artifact 文件路径 |
| Dashboard renderer 投影 | `packages/ui` | GET/SSE/DOM 三处一致 |

对应到图上是三个独立节点，且顺序与真实执行方向一致：`local_search_invoke`
（`packages/app/src/provider-tool-execution.ts` 执行 `file.search`）→ `local_search_report_persistence`
（同一 owner 持久化报告并生成 `{outputRef, outputDigest}` descriptor）→ `local_search_result_contract`
（`packages/adapters/provider/src/agent-driver.ts` 在 `executeTool` 返回之后，从原始调用上下文构造携带
descriptor 的 typed `ProviderToolResult` 结果事件）→ `local_search_journal_projection`
（`packages/runtime/src/ui-runtime/coordinator.ts`）。descriptor 必须先生成再跨回 driver，因此持久化节点在
typed 结果节点之前，读取入口校验的 digest 来源在这条链上是闭合的。

runner 断言：

1. 通过页面实际使用的 `GET /api/tasks/{taskId}/dashboard` 与 SSE 验证同一 `file.search` invoke/result 的
   callId、toolId 以及 taskId、operationId、epoch、seq 关联一致；
2. 通过上述读取入口断言报告包含 query、匹配路径及行/摘要；
3. 之后 `file.read` 必须读取搜索命中的同一路径，并把真实路径与内容写入 receipt；
4. 执行前后各保存按相对路径排序的 workspace 文件清单及每个文件 SHA-256，断言两份清单完全相同；
5. 真实零命中必须显示为零命中，不得把"搜索未执行"表现成零命中。

以上投影、报告、读取入口或清单证据任一缺失，该场景为 `INCOMPLETE`。

### 6.4 AItest

- 先核实 AItest 仓库、目标 task、输入/输出与适用 checker；使用本轮专属隔离目录执行真实任务。
- 新建 run 目录（不得覆盖既有 `AGY_01`/`CLAUDE_01`/`CODEX_01..07`），产物写到 task 要求的路径。
- 运行 task 指定 checker，保存原始 stdout 与 exit code；按 task 人工观察要求记录截图与结论。
- 仅存在 HTML/SVG/动画标签不构成 task 完成；checker 通过也不替代语义验收。

## 7. 失败、超时与取消收口（每条命令图内的链路）

每张图是一条单链，每个节点恰好一个入口、一个出口，全图没有合取汇合：

```text
candidate_binding                    绑定候选并登记本轮资源
  -> <本命令的阶段节点…>              每阶段产出 typed 尝试记录（成功或错误）并向下传递
  -> attempt_failure_detect          从尝试记录识别首次偏离（失败 / 超时 / 取消）
  -> attempt_outcome_select          唯一终态选择节点：只发出成功 或 失败 或 取消 之一
  -> attempt_stop_settle             按所选终态证明 settle：成功也须确认已 settle；
                                     失败/取消则 POST /api/tasks/{id}/stop 并轮询 Dashboard 与 Journal
  -> <cmd>_cleanup                   已 settle：关闭本轮 browser context、按精确 PID 停本轮服务、
                                     核验 PID 退出/端口关闭/路径删除，附原始退出码
                                     未 settle：保留恢复所需 PID/端口/路径，记录唯一 recovery owner
                                     与下一步，标 INCOMPLETE，不得宣称清理完成
  -> attempt_receipt (sink)          收口记账，必须在清理之后：成功写成功 receipt，失败/取消写 INCOMPLETE
                                     receipt，两者都包含清理与核验结论（PID 是否退出、端口是否关闭、
                                     路径是否移除、退出码）以及首次偏离与 task/operation/tool-call ID
```

`attempt_receipt` 是唯一的 sink：receipt 在 cleanup 之后写，清理结论因此必然进入唯一被持久化的 receipt，
清理失败不会被一条已经写好的 receipt 掩盖。

阶段节点在失败时把错误放进尝试记录继续下传，因此**任一阶段先失败时收口链路依然可达**；成功、失败
与取消三种终态由 `attempt_outcome_select` 互斥选择，只有被选中的那一个进入收口，不会同时产生。

禁止 `pkill`、`killall`、`kill $(...)`、`xargs kill` 或端口扫描后批量终止；只允许显式 PID 或服务级操作。
成功路径不提供"保留临时 root"的开关。runner 入口在行为实现前必须 fail closed：`node runner.mjs --scenario <name>`
现在直接以非零退出，不允许出现"命令返回 0 但没有跑任何场景"的假通过。

## 8. 非目标与风险

- 非目标：Retry-10；扩大 20 条事件窗口；新增 Dashboard 产品界面。
- 风险：AItest run 命名冲突（用本轮 run ID 前缀避免）；TinyFish 依赖外网，不可用时该场景只能标 `INCOMPLETE`；
  本地搜索需要跨 6 个产品 owner 的契约补齐，是三条分支中工作量最大的一条。
