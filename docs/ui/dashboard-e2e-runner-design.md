# Dashboard E2E runner design（编码前设计准入）

Status: design candidate（等待独立 review）
Baseline: `cc5f3f0d49d98a4148abcdc7f7bcc814c80cdbb2`
Graph: [`docs/dagpipe/dashboard-e2e.graph.json`](../dagpipe/dashboard-e2e.graph.json)
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
receipt 与独立收口。三者只在终点汇总，不共享运行状态（见 graph 中 `candidate_binding` 之后的三条分支
与唯一 sink `dashboard_e2e_closure`）。

范围内：统一 runner 与 lib、三个场景断言、为本地搜索补齐 typed 结果契约与读取入口、receipt/截图、
失败/超时/取消两条收口分支。
范围外：Retry-10 独立验收（本轮不验证，标 `INCOMPLETE`）；改造既有
`tests/app/real-browser-explicit-implicit-e2e.mjs` 的兼容语义；扩大 Dashboard 的 20 条事件窗口。

## 2. 能力确认（编码前门禁，已完成）

| 能力 | 证据 | 结论 |
| --- | --- | --- |
| 真实 headless 浏览器 | 既有兼容 runner 已跑通 入口→草稿→确认→队列→运行中看板，产出 4 张真实截图 | 可用 |
| 真实 Provider | RCC `127.0.0.1:4444`；journal 记录 11 次 `provider.tool` 执行 | 可用 |
| `file.search` Provider 工具 | `packages/app/src/provider-tool-execution.ts:192` 已注册并接线 | 可用 |
| 网络搜索后端 | `monid run -p tinyfish -e /search` → HTTP 200，返回真实 title/url/snippet，价格 0 | 可用 |
| 网络搜索 Provider 工具 | 不存在；`web.search` 目前只是 Hand gateway service | **缺口，见 §5 门禁** |
| AItest 任务与 checker | `AItest/tasks/pelican-bicycle/`：`prepare-run.sh`（run 已存在即失败，天然不覆盖）与 `inspect-result.mjs`（exit 0 要求非空 + html root + 恰好 1 个内联 SVG + 存在动画） | 可用 |

## 3. 已定位的既有偏差

1. **计数口径错误**：兼容 runner 从 `dashboard.recentEvents` 统计 turn/tool 数，而该窗口只有最近 20 条
   （`packages/runtime/src/ui-runtime/coordinator.ts:2764`、`packages/ui/projection/runtime.ts:210`）。
   实测任务成功并执行 11 次 `provider.tool`，runner 仍报 `0 provider.tool rounds` / `1 request-start turn`。
   本设计的**计数与终态断言取自权威 journal**，UI 渲染只作为独立的可见性断言（§6.1）。
2. **`pnpm e2e:dashboard:*` 不存在**：`package.json` 无任何 e2e script。
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

DAG 节点与 owner 的绑定见 `docs/dagpipe/dashboard-e2e.graph.binding.json`：runner 步骤绑定到本轮新增的
runner/lib/scenario 模块，产品步骤绑定到真实产品 owner（`provider-tool-execution.ts`、`agent-driver.ts`、
`ui-runtime/coordinator.ts`、`ui-runtime/server.ts`、`hand/web-search.ts`），终点绑定到验收合同本身。

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
- 每个场景分别断言适用的成功路径；失败/取消路径由 §7 的分支统一断言。

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

## 7. 失败、超时与取消收口（SESE 终点）

`attempt_failure_detect` 从三条分支的执行/能力节点接入；之后：

```text
attempt_failure_detect
  -> attempt_stop_settle          POST /api/tasks/{id}/stop，轮询 Dashboard 与 Journal 至 settled
  -> attempt_incomplete_receipt   写 INCOMPLETE receipt：首次偏离、原始错误、task/operation/tool-call ID
  -> attempt_settled_cleanup      已 settled：关闭本轮 browser context、按精确 PID 停本轮服务、
                                  核验 PID 退出/端口关闭/路径删除，附原始退出码
  -> attempt_unsettled_recovery   未 settled：保留恢复所需 PID/端口/路径，记录唯一 recovery owner
                                  与下一步，标 INCOMPLETE，不得宣称清理完成
```

两条分支都汇入唯一 sink。禁止 `pkill`、`killall`、`kill $(...)`、`xargs kill` 或端口扫描后批量终止；
只允许显式 PID 或服务级操作。成功路径不提供"保留临时 root"的开关。

## 8. 非目标与风险

- 非目标：Retry-10；扩大 20 条事件窗口；新增 Dashboard 产品界面。
- 风险：AItest run 命名冲突（用本轮 run ID 前缀避免）；TinyFish 依赖外网，不可用时该场景只能标 `INCOMPLETE`；
  本地搜索需要跨 6 个产品 owner 的契约补齐，是三条分支中工作量最大的一条。
