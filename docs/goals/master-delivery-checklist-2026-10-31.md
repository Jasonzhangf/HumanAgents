# HumanAgent Master 交付清单与巡检台账（2026-10-31）

本文件是 master 的项目交付清单，也是每次 project-patrol 的必读巡检项。巡检不是复述状态；每轮必须核对每一行的 owner、实际进度、证据、下一动作和停止条件，并把变化写回本文件或 `note.md`。没有新证据不得把状态改成完成。

## 使用规则

- 每轮巡检先读本文件、`collab board show`、`appsdk goal status --json`、`collab notify status` 和相关 task/issue 回执。
- 每个交付项必须有唯一 owner、明确交付物、验收条件、证据路径和下一动作。
- 同一项连续两轮没有新证据时，master 必须向 owner 要具体缺口或改派，不能只记录“进行中”。
- 只有真实行为、公开入口或可复核回执才能把项目标为完成；代码存在、测试通过或 ACK 都不算交付。
- 完成一项后关闭对应 board task/issue，并清理自有 worktree；他人和受保护资源不动。
- 目标未结束时，巡检结束前确认 goal 订阅仍为 `subscribed`；被消费则立即重新 subscribe。

## A. 当前交付项

| ID | 交付物 | Owner | 当前状态 | 证据/缺口 | 下一动作 | 验收与停止条件 |
|---|---|---|---|---|---|---|
| D1 | 当前 main 重建后的真实入口 E2E | Carol / Jenny 已验收 | `closed`（read-only delivery，revision 8） | HEAD dea61873e（docs-only 6322a421c 之后），隔离 control root + 真实 RCC 4444，web-search receipt `Result=SUCCESS`；terminal seq868 succeeded、checkpoint seq865 committed、planner seq867 aligned、2 tool rounds、40 evidence refs、4 张截图；证据在 `/Volumes/Intel/playground/humanagent/e2e-real-entry-20261031/control/sessions/-private-var-folders-jm-blkk8bbd6v78rv2pwxgxh3kr0000gn-T-humanagent-e2e-web-search-20261031-082107-7irqc6-workspace/run-notes/web-search-20261031-082107-7irqc6/`；serve pid 2152 退出、port 51735 关闭、attempt root 移除 | 已完成；D3/D5 的 official typed new-task preview 仍需补证，不能用本 receipt 代替 | receipt `SUCCESS`、no deviation/missingEvidence、资源收口 verified；receipt/evidence/shots 01-04 见 evidence 路径 |
| D2 | work-card 浏览器证明与动态 dashboard 对齐 | Carol / Jenny 已验收 | `closed`（merged dea61873e，push origin/main） | 根因核实：`dashboard.html` 是动态壳，3 条静态 work-card 断言本就永不成立；absence `undefined:undefined` 源于 fixture 传裸字符串 id，违反 `ScopedId {scope,value}` 契约，DOM 渲染器只收已校验 ScopedId；`<dl>` 不渲染 `=`，旧 `statusDetails.includes('传输状态=未提供')` 结构性永假 | 已完成：fixture 改 ScopedId、dashboard 断言改动态壳、加 absence-no-undefined；master 对 main dist 复跑 39/39；merge f8e65672a→dea61873e 并 push；worktree/branch 已删；task close | proof 39/39 复跑通过；activity-dot stall/working 断言保持；absence 详情无 undefined；已入 main |
| D3 | P1 `21b1c11` 长业务输入 interpret 500/头超时 | Carol / Jenny 验收 | `closed` | current origin/main b381d5e2e 上 official `real-explicit-implicit-e2e.mjs` receipt `state=SUCCESS`（隔离 control root + 真实 RCC 4444）：typed new-task preview `requestKind=new-task-preview`/`proposedIntent=create`/`awaiting-confirmation`；confirm→FIFO fifoSeq=1→grant granted provider.execution→executor→terminal succeeded→checkpoint committed seq=1→publicOutput committed journalSeq=3212；无 500/头超时。issue `21b1c11` 已 close；board task 已 accepted+closed；证据 `/Volumes/Intel/playground/humanagent/typed-preview-evidence-20261031/`（before-review UNVERIFIED 与 after-review SUCCESS 双份保留） | 已完成；后续真实入口变更再重跑同一入口 | official receipt `state=SUCCESS`，链路 closure 完整，issue close |
| D4 | P1 `7cecfc8` web-search terminal blocked / raw 读取字节不一致 | Carol（D1）/ Jenny 已关闭 issue | `closed` | current-main web-search receipt `SUCCESS`，terminal seq868 succeeded、checkpoint seq865 committed、无 deviation/missingEvidence；issue `7cecfc8` 已 close | 已完成；后续 web-search 变更再重跑同一入口 | web-search E2E succeeded + checkpoint committed + 无 read-byte mismatch；current-main evidence 已满足 |
| D5 | `e3b8584` standard-turn-end.delivery-unresolved | Carol（D3 同一 board task）/ Bob（原修复）/ Jenny 验收 | `closed` issue；修复 `d5be671f3` 已入 main；补证任务 `typed-new-task-preview-20261031` 已 accepted+closed | 同一 current-main official receipt `state=SUCCESS`：terminal succeeded，closureReason=`standard-turn-closure`，checkpoint outcome=succeeded seq=1，publicOutput committed（journalSeq=3212，1 commit），turn-alignment Planner decision=complete；没有 standard-turn-end.delivery-unresolved | 已完成；后续真实入口变更再重跑同一入口 | fresh official E2E terminal succeeded，`humanagent_turn_end` 解析 admitted turn，public output committed，receipt state SUCCESS |
| D6 | P2 `9d2dc60` explicit-brain journal 全量快照 342MB | Alice（已接单）/ Jenny 验收 | `working`，board task `9d2dc60-journal-snapshot-20261031`，revision 4 | 342MB/933 lines，冷 parse ~1.2s，RSS 1.4-2.1GB；owner `packages/adapters/jsonl` + explicit-brain append boundaries | Alice 按 append-only 恢复语义改为有界 checkpoint/delta；先给 before/after 测量和 focused tests；不得丢恢复状态或 agent authority | append-only 恢复语义保留；focused tests 通过；冷 parse/RSS 有真实改善；无数据丢失或权限降级；master 集成裁决后合入 |
| D7 | P2 `0d6fcc7` 正式 restart 30s ready-timeout 但替换实例已健康 | Bob（已邀请）/ Jenny 验收 | `invited`，board task `0d6fcc7-restart-ready-20261031`，revision 4 | 现象：客户端 `daemon-restart.ready-timeout`，随后 `/api/liveness` 200、`/api/runtime/status` ready/connected；owner serve supervisor readiness publication | 保留 Bob 邀请一个巡检周期；接受后复现，修 readiness publication 或 30s 边界；保持一个显式 timeout error，不制造重启循环 | 正式 restart 黑盒通过；ready 错误与替换实例健康可区分；无重启循环；相关 app/supervisor tests 通过 |
| D8 | F-C 父级最终验收 `62dd888` | 原 F-C controller；优先从 Alice/Bob 释放后选一个 owner | `pending`，board task `62dd888-fc-final-20261031` | F-C 子项已部分关闭，但 release build、manifest install、Dashboard browser receipts、installed canonical runtime 仍按 issue 父级验收未闭环 | 先由 owner 生成 acceptance matrix 与缺口表；再按 exact-candidate 证据收口，不跳过失败项 | `62dd888` 全部 acceptance 逐条 PASS；独立 review 有效；origin/main 包含候选；安装后运行证据与资源清理完整 |
| D9 | 最新 AppSDK 升级与治理改造 `054d2d7` | 原 `humanagent-governance` owner；待规划后再派 | `pending`，board task `054d2d7-appsdk-upgrade-20261031` | 只读盘点已落盘：全局 binary `0.1.0015`，项目 `project.json/sdk.lock/manifest` 仍 `0.1.0014`；`appsdk verify` exit 1、`NON_CANONICAL_RECORD_CONTRACT_SET`，声明 record_contracts 19 项对磁盘 25 项，`sdk-resources` 混合版本；guide `needs_setup` 是 advisory，不是 verify 硬阻塞 | 报告已收；先交 AppSDK owner 给出不违反全局消融规则的 pin/升级路径和 record_contracts 对齐；`appsdk verify` exit 0 前不派实现 | 全局安装版本、source/installed 证据、`appsdk verify`、治理规则、CI/release 门禁和一次独立 review 全部满足 |
| D10 | 全量 release 门禁 | Jenny 先定位/派 owner | `blocked`，已知红 | `pnpm build:release` 仍被 `test:compiled:services` 14 项原生 run/checkpoint/memory 失败阻断；另有 adapter 包缺 `@types/node` 的环境性失败；`build:app` 产物本身干净 | 先做一次只读 A/B 对照，确认失败是否全部为基线环境问题；再决定修环境还是记录已知限制；不能把 `build:app` 当成 `build:release` | `pnpm build:release` 真实 exit 0，或明确记录不可交付范围和用户可见影响；不得伪造全绿 |
| D11 | UI/UX 动画与交互收口 | Carol（D2）+ Jenny 复验 | 已通过 | 当前 main dist（dea61873e）复跑：`entry-submit-progress-browser.mjs` 12/12（spinner `progress-spin`、可见/不透明、结算后移除、真实 receipt time、两页无 runtime error）；`interaction-work-card-browser.mjs` 39/39（activity-dot stall/working、absence 无 undefined、动态壳+静态 task.html 契约） | 已完成；后续 UI 改动再重跑两套浏览器证明 | 两套均通过无 runtime error，未降断言强度；后续 UI 改动再复验 |
| D12 | 自有 worktree 与资源巡检 | Jenny | 进行中 | 当前 6 个 worktree：main + Alice D6 树 + 4 个 locked provider 树；均未超 10；Carol typed-preview 树已 remove/prune/absent，分支 `codex/typed-new-task-preview-20261031` 已删；生产 serve PID 13505 @10086 只读保护 | 每轮核对 worktree 数、owner、dirty/active 状态；只清理本轮自有且已合入/不再需要的资源；不触碰 locked/他人/生产 | 自有资源清单与实际一致；清理有回执；生产 10086 和共享资源未被改动 |

## B. Peer 分工与推进方式

| Peer | 当前身份/状态 | 现在做什么 | 交付后下一步 | master 如何检查 |
|---|---|---|---|---|
| Bob | peer，presence present，agent_state unknown；D7 邀请中 | 等待接受 D7 `0d6fcc7-restart-ready-20261031` | 接受后复现并修 restart readiness publication；之后可接 D8 | 下轮看是否接受；一个巡检周期内保留邀请，不静默改派 |
| Carol | peer，presence present，agent_state unknown；D2/D1/D3/D5 已 close | D3/D5：`typed-new-task-preview-20261031` 已 delivered→accepted→closed；official receipt `SUCCESS`，证据在 `/Volumes/Intel/playground/humanagent/typed-preview-evidence-20261031/` | 可接 D8（F-C 最终验收）或 D9 规划 | 看 board 是否 delivered/closed；核对 official receipt、terminal/checkpoint/publicOutput 与资源回收 |
| Alice | peer，presence present，agent_state unknown；D6 `invited` | 接受 D6，做 journal snapshot 压缩/有界 checkpoint；先给 before/after 测量 | D6 交付后优先接 D7；若 D6 被拒或阻塞，明确回报缺口，不空转 | 看 task 状态、focused tests、冷 parse/RSS 前后数据；不接受只改代码不证明恢复语义 |
| Jenny | master；project patrol armed；goal subscribed | 巡检本清单、验收 D1/D2/D6、关闭 D3/D4/D5、推进 D7-D9、收口 D10-D12；不替 peer 写实现 | 每轮巡检更新本文件；goal 被消费则立即 rearm；有容量时继续派 ready 工作 | 每轮至少检查：board、goal、patrol、worktree、生产健康、每个 peer 的 task 状态和证据 |

## C. 每轮 project-patrol 固定检查

1. 读 `collab board show`，确认每个 task 的 status、owner、revision、`next_step`。
2. 读 `appsdk goal status --json`，确认 `active=true`、`observed=subscribed`；若不是则立即重新 subscribe。
3. 读 `collab notify status`，记录 `project_patrol.armed` 与 `cadence_runtime_gap`；当前运行间隔 900000ms，目标 1500000ms，存在 `PATROL_CADENCE_RUNTIME_GAP`，不得声称已对齐。
4. 逐项核对 A 表 D1-D12；连续两轮无新证据的项，直接向 owner 要具体缺口或改派。
5. 核对 worktree 数量、owner、dirty/active 状态；只处理自有可清理项，4 个 locked provider 树和生产 10086 保持不动。
6. 读 peer 的 task 状态与最近回执；idle 但持有开放任务的 peer 必须唤醒或重新安排，unknown 不作为 idle 处理。
7. 本轮有实际推进时更新本文件或 `note.md`；没有推进也要记录真实缺口，不用 ACK 结束。

## D. 当前不可动的边界

- 生产实例 `127.0.0.1:10086` 和 `~/.humanagent` 只读，禁止 restart、写操作或清理用户数据。
- 4 个 locked provider worktree 的 lifecycle 归 Root，保留为 `PROTECTED_HOLD`，不删除。
- 不批量杀进程，不用 `pkill`/`killall`；只通过正式服务入口或明确 PID 操作。
- 不改用户 dirty 文件、不重置 main、不绕过 hook；文档改动只动本清单和明确的 note 记录。

## E. 本轮巡检记录

- 2026-10-31 14:57 UTC：goal 原 deadline 已消费；重新 `appsdk goal subscribe` 后 `active=true`、`observed=subscribed`，trigger_ms `1793459354246`；project patrol 仍 armed（`sub-m1793413132850-18`，900000ms，目标 1500000ms，`PATROL_CADENCE_RUNTIME_GAP`）。
- 2026-10-31 14:57 UTC：Carol `work-card-proof-dashboard-alignment-20261031` 仍在 working；Alice 已接受 `9d2dc60-journal-snapshot-20261031` 并进入 working；Bob 仍为 `invited`，其 `dsh-wake-enqueued` 已入队；master 下一 tick 优先核对 Bob 是否真正接单。
- 2026-10-31 15:18 UTC：D2 交付并验收。根因为 fixture 违反 `ScopedId` 契约 + 3 条永假 dashboard 静态断言 + `<dl>` 不渲染 `=`，非投影缺陷；master 对 main dist 复跑 `interaction-work-card-browser.mjs` 39/39；`entry-submit-progress-browser.mjs` 12/12。候选 dea61873e 以 ff 合入 main（f8e65672a→dea61873e）并 push origin/main；`collab task integrated` + `close` 已记录；worktree/branch 已删，现存 6 个 worktree（main + 4 locked provider + Alice 9d2dc60 树）。
- 2026-10-31 15:18 UTC：D1 改派。Bob 接受邀请超一巡检周期仍未接单（present/unknown，pending 0），已 `board withdraw` 并改派 Carol（invited，`dsh-wake-enqueued`，revision 6）；下一 tick 核对 Carol 是否接单，仍不接则 D6 完成后改派 Alice。
- 2026-10-31 15:18 UTC：goal 仍 `active=true`、`observed=subscribed`、`collab_subscribed=true`，trigger_ms `1793459354246`；project patrol 仍 armed（900000ms，目标 1500000ms，`PATROL_CADENCE_RUNTIME_GAP`，未对齐不声称）。
- 2026-10-31 15:28 UTC：Carol 已接受 D1，board task `real-entry-e2e-main-rerun-20261031` 为 `working`，revision 8；D2 的 `pending_merges` 为空，work-card worktree 已移除，daemon 集成义务已了结。
- 2026-10-31 15:28 UTC：Bob 空闲且在线，已按合同 `board invite` D7 `0d6fcc7-restart-ready-20261031`，邀请 revision 4，等待 accept；不把一个任务在跑当作并发已充分。
- 2026-10-31 15:28 UTC：goal 一次性 deadline 已 consumed；已重新 `appsdk goal subscribe`，当前 `active=true`、`observed=subscribed`。project patrol 仍 900000ms，目标 1500000ms，`PATROL_CADENCE_RUNTIME_GAP` 未解除。
- 2026-10-31 15:33 UTC：D1 完成并由 master 验收。current main `dea61873e` 上隔离 control root + 真实 RCC 4444 的 web-search E2E receipt `Result=SUCCESS`，no deviation/missingEvidence；terminal seq868 succeeded、checkpoint seq865 committed、planner seq867 aligned、2 tool rounds、40 evidence refs，4 张截图；资源收口 verified。board task 已 close。
- 2026-10-31 15:33 UTC：D4 关闭。current-main web-search terminal succeeded + checkpoint committed，满足 issue `7cecfc8` 的 succeeded/无 read-byte mismatch 验收；已执行 `appsdk bug close 7cecfc8`。
- 2026-10-31 15:33 UTC：D3/D5 未关闭。official `real-explicit-implicit-e2e.mjs` 最终 receipt 仍为 `state=UNVERIFIED`，failure=`missing or inconsistent public typed new-task preview awaiting-confirmation/create`；`behavior=PASS` 不足以关闭 issue。需同一补证后再验收，不以 D1 的 dashboard web-search receipt 代替。
- 2026-10-31 15:42 UTC：D3/D5 的同一补证任务 `typed-new-task-preview-20261031` 已从 revision 1 发布到 revision 3，并以 `--expected-revision 2` 邀请 Carol；当前 `invited`，指定 reviewer Jenny。工作树为 `/Volumes/Intel/playground/humanagent/typed-new-task-preview-20261031`，从最新 origin/main 新建。原 official `UNVERIFIED` receipt 保留，不把邀请或 board 状态当验收。
- 2026-10-31 15:42 UTC：D7 仍保留 Bob 的 `0d6fcc7-restart-ready-20261031` 邀请，revision 4；未接受前不改派。Alice 的 D6 `9d2dc60-journal-snapshot-20261031` 仍为 working。
- 2026-10-31 15:48 UTC：Carol 已接受 `typed-new-task-preview-20261031`，board 当前 `working`、revision 4、owner=Carol、reviewer=Jenny；D3/D5 进入实际执行。master 同时并发启动两项只读观察：`fc-acceptance-matrix-20261031` 盘点 62dd888 F-C 最终验收，`appsdk-migration-inventory-20261031` 盘点 054d2d7 AppSDK 迁移现状；两者不写产品。
- 2026-10-31 15:54 UTC：AppSDK 只读盘点完成。全局 installed `0.1.0015`，项目锁/manifest 仍 `0.1.0014`；`appsdk verify` exit 1 / `NON_CANONICAL_RECORD_CONTRACT_SET`，record_contracts 声明 19 对磁盘 25；guide `needs_setup` 为 advisory。D9 保持 pending，先找 AppSDK owner 解 pin/record 契约，不执行 pin-lock。
- 2026-10-31 15:54 UTC：goal deadline 通知 m1793462007640-1287 已读并消费；因 D3/D5/D6/D8/D9 仍需继续调度，已显式 `appsdk goal subscribe --interval 10m` 续订。project patrol 仍 900000ms、目标 1500000ms，`PATROL_CADENCE_RUNTIME_GAP` 未解除。
- 2026-10-31 15:54 UTC：Carol typed-preview worktree HEAD 6322a421c，落后 origin/main b381d5e2e 仅两个文档提交（checklist/note），代码无 delta；后续集成前需 fetch/rebase，当前不阻断。
- 2026-10-31 16:02 UTC：Carol 交付 `typed-new-task-preview-20261031`（no-candidate）。master 独立核 verified：当前 origin/main b381d5e2e 的 official `real-explicit-implicit-e2e.mjs` receipt `state=SUCCESS`（before-review 原始 `UNVERIFIED` 双份保留），typed preview awaiting-confirmation/create、confirm→FIFO→grant→executor→succeeded、terminal succeeded、checkpoint committed seq=1、publicOutput committed journalSeq=3212、Planner decision=complete、standard-turn-closure；未访问网络/用户文件，业务输出为真实 1364 字方案分析。
- 2026-10-31 16:02 UTC：`collab task review --accept` typed-new-task-preview-20261031 成功（disposition `no_merge_required`），`collab task close` 成功，cleanup receipt `cleanup-typed-new-task-preview-20261031-1793462776480` verified。issue `21b1c11`、`e3b8584` 已 `appsdk bug close`（均有 solution/evidence）。
- 2026-10-31 16:06 UTC：D3/D5 关闭后，master 移除已验收的 Carol typed-preview worktree 并删除分支 `codex/typed-new-task-preview-20261031`，`git worktree prune` 后路径不存在，现存 6 个 worktree（main + Alice D6 + 4 locked provider PROTECTED_HOLD）。
