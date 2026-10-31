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
| D1 | 当前 main 重建后的真实入口 E2E | Carol（已接受邀请）/ Jenny 验收 | `working`（Bob 超一巡检周期未接单，已 withdraw 改派 Carol） | board task `real-entry-e2e-main-rerun-20261031`，revision 8 | Carol 正在从当前 main 重建 serve，在隔离 clean control root 跑真实首页输入→草稿确认→FIFO→任务结果，使用真实 RCC 4444，不触碰生产 10086；若本轮仍无 receipt，按 D1 规则向 Carol 要具体缺口或改派 | receipt `Result SUCCESS`；runtime terminal `succeeded`、`settled=true`、checkpoint committed、planner aligned；截图和资源收口齐全；否则保留首个失败证据并说明恢复责任 |
| D2 | work-card 浏览器证明与动态 dashboard 对齐 | Carol / Jenny 已验收 | `closed`（merged dea61873e，push origin/main） | 根因核实：`dashboard.html` 是动态壳，3 条静态 work-card 断言本就永不成立；absence `undefined:undefined` 源于 fixture 传裸字符串 id，违反 `ScopedId {scope,value}` 契约，DOM 渲染器只收已校验 ScopedId；`<dl>` 不渲染 `=`，旧 `statusDetails.includes('传输状态=未提供')` 结构性永假 | 已完成：fixture 改 ScopedId、dashboard 断言改动态壳、加 absence-no-undefined；master 对 main dist 复跑 39/39；merge f8e65672a→dea61873e 并 push；worktree/branch 已删；task close | proof 39/39 复跑通过；activity-dot stall/working 断言保持；absence 详情无 undefined；已入 main |
| D3 | P1 `21b1c11` 长业务输入 interpret 500/头超时 | D1 的同一 owner（Bob）/ 需要时拆给 `packages/app` + `packages/runtime` owner | `open`，由 D1 验证 | 历史证据：长输入卡在 `state=matching`，持续 reasoning delta 无 JSON decision；已有 `ec7e78b46`、`0e6e4cce5`、`90ac6a922` 系列修复；当前 main 仍需官方 E2E 通过 | D1 若通过则用 receipt 关闭；若复现则按原证据拆出显式 brain runtime + ui-runtime server 修复任务 | 真实 RCC 下 `real-explicit-implicit-e2e.mjs` 从长业务输入走到 `awaiting-confirmation`，继续 confirm→fifo→grant→executor→succeeded，无 500/头超时 |
| D4 | P1 `7cecfc8` web-search terminal blocked / raw 读取字节不一致 | 待定；先由 D1 的 web-search 场景验证 | `open` | `web-search-e2e-isolated-rerun-20261031` 已 3/3 PASS（含无 accepted-inspect/raw read-byte mismatch）；issue 尚未关闭 | D1 或独立 web-search 复跑通过后，带 journal seq 与 tool-output/raw 对比证据关闭 issue；若复现则派 provider adapter/runtime read-back owner | web-search E2E `succeeded`、checkpoint committed、无 read-byte mismatch；否则保留具体 mismatch 证据 |
| D5 | `e3b8584` standard-turn-end.delivery-unresolved | Bob（修复已合入）/ Jenny 关闭 issue | `open` issue；修复 `d5be671f3` 已合入 `a1274d880` | 修复已把 `evidenceId=`/`locator=` 标签归一化并限定 admitted turn scope；仍需 fresh main E2E 作最终验收 | D1 通过后附 E2E receipt 和 focused test 证据关闭 issue；若复现则重开同一 owner | fresh E2E terminal succeeded，`humanagent_turn_end` delivery ref 解析到 admitted turn，public output committed |
| D6 | P2 `9d2dc60` explicit-brain journal 全量快照 342MB | Alice（已接单）/ Jenny 验收 | `working`，board task `9d2dc60-journal-snapshot-20261031`，revision 4 | 342MB/933 lines，冷 parse ~1.2s，RSS 1.4-2.1GB；owner `packages/adapters/jsonl` + explicit-brain append boundaries | Alice 按 append-only 恢复语义改为有界 checkpoint/delta；先给 before/after 测量和 focused tests；不得丢恢复状态或 agent authority | append-only 恢复语义保留；focused tests 通过；冷 parse/RSS 有真实改善；无数据丢失或权限降级；master 集成裁决后合入 |
| D7 | P2 `0d6fcc7` 正式 restart 30s ready-timeout 但替换实例已健康 | 待派；Alice 完成 D6 后优先 | `pending`，board task `0d6fcc7-restart-ready-20261031` | 现象：客户端 `daemon-restart.ready-timeout`，随后 `/api/liveness` 200、`/api/runtime/status` ready/connected；owner serve supervisor readiness publication | 分配 owner 后复现，修 readiness publication 或 30s 边界；保持一个显式 timeout error，不制造重启循环 | 正式 restart 黑盒通过；ready 错误与替换实例健康可区分；无重启循环；相关 app/supervisor tests 通过 |
| D8 | F-C 父级最终验收 `62dd888` | 原 F-C controller；优先从 Alice/Bob 释放后选一个 owner | `pending`，board task `62dd888-fc-final-20261031` | F-C 子项已部分关闭，但 release build、manifest install、Dashboard browser receipts、installed canonical runtime 仍按 issue 父级验收未闭环 | 先由 owner 生成 acceptance matrix 与缺口表；再按 exact-candidate 证据收口，不跳过失败项 | `62dd888` 全部 acceptance 逐条 PASS；独立 review 有效；origin/main 包含候选；安装后运行证据与资源清理完整 |
| D9 | 最新 AppSDK 升级与治理改造 `054d2d7` | 原 `humanagent-governance` owner；待规划后再派 | `pending`，board task `054d2d7-appsdk-upgrade-20261031` | 需要官方迁移路径、`appsdk verify`、治理规则和 CI/release 入口证据 | 先做只读现状与迁移计划；不直接改 `.appsdk` 或用户 dirty work；计划通过后再分阶段实现 | 全局安装版本、source/installed 证据、`appsdk verify`、治理规则、CI/release 门禁和一次独立 review 全部满足 |
| D10 | 全量 release 门禁 | Jenny 先定位/派 owner | `blocked`，已知红 | `pnpm build:release` 仍被 `test:compiled:services` 14 项原生 run/checkpoint/memory 失败阻断；另有 adapter 包缺 `@types/node` 的环境性失败；`build:app` 产物本身干净 | 先做一次只读 A/B 对照，确认失败是否全部为基线环境问题；再决定修环境还是记录已知限制；不能把 `build:app` 当成 `build:release` | `pnpm build:release` 真实 exit 0，或明确记录不可交付范围和用户可见影响；不得伪造全绿 |
| D11 | UI/UX 动画与交互收口 | Carol（D2）+ Jenny 复验 | 已通过 | 当前 main dist（dea61873e）复跑：`entry-submit-progress-browser.mjs` 12/12（spinner `progress-spin`、可见/不透明、结算后移除、真实 receipt time、两页无 runtime error）；`interaction-work-card-browser.mjs` 39/39（activity-dot stall/working、absence 无 undefined、动态壳+静态 task.html 契约） | 已完成；后续 UI 改动再重跑两套浏览器证明 | 两套均通过无 runtime error，未降断言强度；后续 UI 改动再复验 |
| D12 | 自有 worktree 与资源巡检 | Jenny | 进行中 | 当前 6 个 worktree：main + Alice D6 树 + 4 个 locked provider 树；均未超 10；生产 serve PID 13505 @10086 只读保护 | 每轮核对 worktree 数、owner、dirty/active 状态；只清理本轮自有且已合入/不再需要的资源；不触碰 locked/他人/生产 | 自有资源清单与实际一致；清理有回执；生产 10086 和共享资源未被改动 |

## B. Peer 分工与推进方式

| Peer | 当前身份/状态 | 现在做什么 | 交付后下一步 | master 如何检查 |
|---|---|---|---|---|
| Bob | peer，presence present，agent_state unknown；D1 邀请已撤回 | 暂无任务（超一个巡检周期未接 D1，已改派 Carol） | 有空接受 D7/D8 或作为第二验证人 | 下轮看是否接新任务；无接单且无推进则记录不派，不空等 |
| Carol | peer，presence present，agent_state unknown；D2 已 close，D1 已改派邀请 | D1：从当前 main 重建 serve，隔离 clean control root + 真实 RCC 4444 跑真实入口 E2E，交 receipt+截图 | 通过后附 receipt 关闭 D3/D5；之后可接 D8/D9 规划 | 看 board 是否 invited→working/delivered；核对 receipt terminal/checkpoint/cleanup |
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
