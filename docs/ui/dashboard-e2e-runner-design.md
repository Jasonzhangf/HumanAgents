# Dashboard E2E runner design（编码前设计准入）

Status: design candidate（等待独立 review）
Baseline: `cc5f3f0d49d98a4148abcdc7f7bcc814c80cdbb2`
Graph: [`docs/dagpipe/dashboard-e2e.graph.json`](../dagpipe/dashboard-e2e.graph.json)
Contract: [`docs/ui/dashboard-e2e-acceptance.md`](dashboard-e2e-acceptance.md)

## 1. 目标与范围

实现验收合同要求的三个命令，各自跑通一次真实浏览器 E2E 并产出绑定候选 SHA 的 receipt：

```sh
pnpm e2e:dashboard:web-search
pnpm e2e:dashboard:local-file-search
pnpm e2e:dashboard:aitest
```

范围内：统一 runner、三个场景断言、receipt/截图、固定清理闭环、为网络搜索补齐 Provider 工具链。
范围外：Retry-10 独立验收；改造既有 `tests/app/real-browser-explicit-implicit-e2e.mjs` 的兼容语义；
新增 Dashboard 产品界面。

## 2. 能力确认（已完成，编码前门禁）

| 能力 | 证据 | 结论 |
| --- | --- | --- |
| 真实 headless 浏览器 | 既有 runner 已跑通 入口→草稿→确认→队列→运行中看板，产出 4 张真实截图 | 可用 |
| 真实 Provider | RCC `127.0.0.1:4444`；journal 记录 11 次 `provider.tool` 执行 | 可用 |
| `file.search` Provider 工具 | `packages/app/src/provider-tool-execution.ts:192` 已注册并在 dispatch switch 中接线 | 可用 |
| 网络搜索后端 | `monid run -p tinyfish -e /search` → HTTP 200，返回真实 title/url/snippet，价格 0 | 可用 |
| 网络搜索 Provider 工具 | **不存在**：`web.search` 只是 Hand gateway service（`packages/runtime/src/hand/web-search.ts`），Provider 工具表里没有对应项 | **缺口，必须补** |
| AItest 任务与 checker | `/Volumes/extension/code/AItest/tasks/pelican-bicycle/`：`scripts/prepare-run.sh`（run 目录已存在即失败，天然不覆盖）与 `scripts/inspect-result.mjs`（exit 0 要求非空 + html root + 恰好 1 个内联 SVG + 存在动画） | 可用 |

## 3. 已定位的既有偏差（本设计必须处理）

1. **计数口径错误**：既有 runner 从 `dashboard.recentEvents` 统计 turn/tool 数，而该窗口只有最近 20 条
   （`packages/runtime/src/ui-runtime/coordinator.ts:2764`、`packages/ui/projection/runtime.ts:210`）。
   实测任务成功且执行 11 次 `provider.tool`，runner 仍报 `0 provider.tool rounds` / `1 request-start turn`。
   新 runner 的**计数与终态断言必须取自权威 journal**（隔离 control root 下的
   `checkpoints/ui-runtime/<provider>/ui-runtime-journal.jsonl`），UI 渲染只作为独立的"可见性"断言。
2. **`pnpm e2e:dashboard:*` 不存在**：`package.json` 无任何 e2e script。
3. **web-search 断链**：`docs/architecture/hand-search-websearch-plan.md` 仍是 `design candidate` 且明确排除外部 provider。

## 4. Runner 架构

新增 `tests/app/dashboard-e2e/`：

```text
runner.mjs          唯一入口：解析 --scenario，串起 DAG 节点 1-4、8-10
scenarios/web-search.mjs
scenarios/local-file-search.mjs
scenarios/aitest.mjs
lib/binding.mjs     候选 SHA/tree/diff digest、隔离 root/workspace/端口登记
lib/journal.mjs     只读权威 journal，统计 turn/tool round 与终态
lib/receipt.mjs     写 receipt + 截图清单
lib/cleanup.mjs     settled / 未 settled 两条收口分支
```

`package.json` 增加三条 script，均调用同一 runner 并显式设定 receipt 与截图目录：

```json
"e2e:dashboard:web-search": "node tests/app/dashboard-e2e/runner.mjs --scenario web-search",
"e2e:dashboard:local-file-search": "node tests/app/dashboard-e2e/runner.mjs --scenario local-file-search",
"e2e:dashboard:aitest": "node tests/app/dashboard-e2e/runner.mjs --scenario aitest"
```

复用既有 runner 已验证的浏览器驱动（playwright、隔离 root、`--port 0`、`serve` 生命周期），
不改动其兼容脚本语义。

## 5. 场景证据

| 场景 | 用户任务 | 必需证据 |
| --- | --- | --- |
| web-search | 用网络搜索查一个真实问题并要求给出可核对来源 | Provider 工具调用 + 工具结果含真实 `url`/`title`；来源在 UI 可见；失败时展示真实 Provider 错误，不得伪造空结果成功 |
| local-file-search | 在隔离 workspace 搜索关键词并报告匹配 | `file.search` → `file.read` 真实路径与命中证据；搜索前后 workspace 文件清单 SHA-256 一致（证明未修改文件）；零命中必须显示真实零命中 |
| aitest | 在 AItest `pelican-bicycle` 新建 run 并产出动画 SVG | 新 run 目录（不覆盖既有 9 个 run）；`result.html` + `artifact.svg` 存在；`inspect-result.mjs` 原始 stdout 与 exit code；人工观察记录 |

每个场景都必须：从浏览器输入开始、产生可见草稿、经用户确认、进入运行队列、执行多个 turn/tool 步骤、
到达可验证终态；并分别断言成功、失败与取消路径中适用的部分。

## 6. 网络搜索能力补齐

新增 Provider 工具 `web.search`（Responses 与 Anthropic 两套协议各自投影，保持 `cc`/`cc-sol` 与 `goaichat` 独立实现）：

- 唯一 owner：`packages/app/src/provider-tool-execution.ts`（工具声明、dispatch、report 持久化与 digest）。
- 后端：`monid run -p tinyfish -e /search`，只读、免费；后端不可用时返回显式失败，不 fallback 到收费 provider。
- 控制面与 payload 分离：搜索结果只作为业务工具结果，不承载任何控制状态。
- 禁止把 `web.search` 与既有 Hand gateway `web.search` 语义混用；两者 owner 不同，需在设计中显式区分。

## 7. 清理闭环（SESE 终点）

按验收合同 §65-79 实现：attempt 启动前登记 owner/run id/候选 SHA/workspace/control root/PID/端口/临时路径；
`finally` 中：未 settled 则 `POST /api/tasks/{id}/stop` 并轮询至 settle，settle 不了就落 `INCOMPLETE` receipt 并保留恢复资源；
已 settled 才停止本轮服务（显式 PID）、删除本轮 workspace/control root/临时文件，并附进程退出、端口关闭、路径不存在的核验命令与退出码。

## 8. 非目标与风险

- 非目标：Retry-10（本轮不验证，标 `INCOMPLETE`）；把 20 条事件窗口改大（属 UI 改进，另行提出）。
- 风险：AItest run 命名需避开既有 `AGY_01`/`CLAUDE_01`/`CODEX_01..07`；TinyFish 依赖外网，不可用时该场景只能标 `INCOMPLETE`。
