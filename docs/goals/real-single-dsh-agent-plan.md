# 真实单 DSH Agent 执行计划

状态：`P0-COMPLETE / P1-COMPLETE / P2-COMPLETE / P3-COMPLETE / P4-COMPLETE / P5-COMPLETE / P6-COMPLETE`
基线：`origin/main @ 36528f4e7d05932d63ddd7a4308c8863be424138`
Worktree：`playground/real-single-dsh-agent`
分支：`codex/real-single-dsh-agent`
目标提示词：`docs/goals/real-single-dsh-agent-goal.md`
入口证明：`docs/architecture/dsh-entry-proof.md`

## 1. 当前事实

- `packages/adapters/provider` 已有真实 RCC v3 HTTP/SSE、Responses/Anthropic
  codec、readiness 和测试；已有 recorded/real RCC 证据。
- `packages/adapters/dsh` 已实现公开 stdio JSON-RPC real transport、native
  event mapping、stop/settle、resume capability rejection 和身份隔离。
- `AgentRuntime` 经 `ExecutionRuntimePort -> AgentDriver` 桥驱动同一 DSH
  session；tool result 回到 session 后继续模型推理。
- `packages/app` 已接通真实 CLI `run/resume`、HumanAgent Task/Operation/
  execution epoch/checkpoint、run manifest、crash recovery 和 Attention。
- `packages/config` 显式支持 `driverRef = "fake" | "dsh"`；配置缺失时失败，
  不 fallback 到 fake。
- DSH 适配真源是 `~/code/dsh`（canonical path
  `/Volumes/extension/code/dsh`），每次执行前先从该仓库 `git fetch origin
  master`，再锁定当时的最新 `origin/master`；不是本机旧安装
  `dsh 0.1.2-alpha.5`。当前锁定 commit
  `c291e7961a515f6d7af9304e7fd1d257929aef26`，
  tree `e482b49bef64726be8f79380bb35bae569dc3c48`，describe
  `dsh-v0.1.5-rc.2-139-gc291e7961a`。
- P6 已再次从 `~/code/dsh` 执行 `git fetch origin master`；当前最新
  `origin/master` 仍与上述 commit/tree/describe 完全一致。若之后发生前移，
  必须先把 `packages/adapters/dsh/src/lock.ts`、入口证明和真实 receipts
  一起重锁，再继续验证；禁止继续用旧 commit 生成 PASS。
- 干净源码 worktree
  `/Volumes/extension/code/dsh/playground/humanagent-0.1.5-20260914` 是唯一
  DSH 构建/运行目标；`/Volumes/extension/code/dsh` 主 checkout 保持只读。
- 源码入口为 `node --import tsx/esm apps/cli/src/bin.ts --profile sdk --patch
  apps/cli/src/sdk-source.cordis.patch.yml`；需先 `pnpm install` 与
  `pnpm run build:native-system`。
- Provider 绑定固定为 `rcc` route → `openai-completions` →
  `http://127.0.0.1:4444/v1` → `gpt-5.5`。RCC 的 `/v1/responses` 在工具调用时
  返回非标准 `status: requires_action`，pi-ai `0.85.1` 拒绝，故不选 Responses。
- DSH `0.1.5` 公开 SDK wire 只有 `initialize`/`session/prompt`/`shutdown`：
  没有 per-session cancel、没有 mid-turn cancel、不能跨进程重开已持久化
  session。因此 stop 语义固定为 runtime shutdown settle，recovery 语义固定为
  HumanAgent checkpoint → 新 DSH session。

## 2. 固定链路

```text
HumanAgent Task / Operation / execution epoch
  -> AgentRuntime
  -> ExecutionRuntimePort -> AgentDriver bridge
  -> packages/adapters/dsh real transport
  -> DSH SDK stdio session / agent / tool
  -> Provider binding / RCC 4444
  -> DSH native event -> ProviderEvent
  -> same DSH session continuation
  -> settle
  -> HumanAgent checkpoint
  -> UI projection
```

## 3. 阶段

### P0：基线与入口冻结 —— `COMPLETE`

Owner：`packages/adapters/dsh` + `docs/architecture`

结果见 `docs/architecture/dsh-entry-proof.md`：锁定 commit/tree、源码入口、
profile/patch、RCC 绑定、协议选择理由与 stop/resume 能力边界均已记录。

交付：

- 记录 HumanAgent main、worktree HEAD/tree、dirty 状态和 DSH 外部依赖摘要。
- 只读验证 `dsh --profile sdk-minimal` 或专用 profile 能否由 SDK stdio 驱动。
- 固定单 profile、单 agent、单 ProviderBinding、单只读 tool 和验收问题。
- 输出 DSH entry decision：SDK client 包版本、runtime 版本、profile 来源、
  patch 来源、环境变量和版本不兼容时的失败出口。

退出证据：

- `dsh --version`、package manifest/digest、profile dump 或 help receipt。
- 版本不兼容时停在 `dependency-missing`，不得自行升级或 fallback。
- 不写 transport；此阶段只形成可复核事实。

### P1：真实 DSH entry proof —— `COMPLETE`

Owner：`packages/adapters/dsh`，测试位于 `tests/adapters/dsh`

已交付 `tests/adapters/dsh/real-dsh-entry-proof.mjs` 与
`tests/adapters/dsh/real-dsh-lifecycle-proof.mjs`，可重复运行并写出 JSON
receipt。已证明：profile boot、session create、prompt admission、follow
事件、真实 tool call/result、同 session continuation、shutdown exit 0、
persistence commit、同 session 多轮推理、SIGKILL crash 后同 home 恢复。
已记录失败出口：跨进程 session resume 被公开入口拒绝。

交付：

- 用专用 `DSH_HOME` 和 `humanagent` profile 启动真实 DSH runtime。
- 证明 profile boot、session create、prompt admission、follow snapshot/event、
  tool call/result、同 session continuation、cancel receipt、close/dispose。
- 原始 DSH session locator 只进入 `EvidenceRef`；HumanAgent identity 不依赖
  DSH SessionId。

测试条件：

- 真实入口 smoke 必须使用显式 binary、profile、home 和 workspace。
- 失败矩阵覆盖 binary missing、profile invalid、provider unavailable、
  malformed frame、transport close、cancel receipt 后未 settle。
- 测试失败保留原始 stderr 和 exit code，不转成成功。

退出证据：

- 可复核 JSON receipt、事件顺序、tool callId/result 对应关系和进程退出证据。
- 未完成项明确列为 `runtime-unverified`，不得从源码能力推断完成。

### P2：DSH driver bridge —— `COMPLETE`

Owner：`packages/adapters/dsh`；必要时只做最小 `packages/contracts` seam 调整

交付：

- 实现真实 `DshTransport`，消费 DSH stdio 事件并返回 Provider-neutral
  receipts/settlements。
- 选择性集成 M1-3 的 native follow/event/stop mapping；不得整支合并。
- 实现 `ExecutionRuntimePort` 驱动的 `AgentDriver` adapter。
- DSH 类型、SessionId、Cordis、SDK wire 类型留在 adapter 内。

测试条件：

- fake transport contract。
- recorded native follow replay。
- identity isolation、epoch fence、late event、event ordering。
- 同一 session 的 model -> tool -> result -> continue。
- `cancel receipt != stopped`；settle 必须包含 resource release 和 persistence
  commit。

退出证据：

- focused adapter tests、identity negative tests、same-session continuation test。
- `tests/adapters/dsh/dsh-real-transport.test.ts` 6/6、`dsh-driver.test.ts` 3/3
  通过，且测试进程干净退出。
- 真实 DSH receipt 已证明 same-session model -> tool -> result -> continue。
- candidate SHA 和独立 review receipt 留到 P6 收口。

### P3：HumanAgent runtime/app 接线

Owner：`packages/runtime`、`packages/app`、`packages/config`

本轮已补强：

- `JsonlOrganJournal` 改为按 `previousCheckpointId` 解析前驱，支持一个 Journal 内
  多个 operation/epoch 的独立 checkpoint 链；这是从失败 checkpoint 恢复 epoch 的
  真源修复。
- 真实 DSH transport 的普通 `shutdown()` 不再隐式把运行标记为 stopped；只有经过
  `requestStop` 的 stop control 才会由 settle 返回 `stopped`。否则普通完成会被
  `AgentRuntime` 拒绝为 “ordinary settle cannot complete stopped”。
- `test:app` 26/26：覆盖 stopped settle 证据、settle 失败不得 commit stopped、以及
  失败 checkpoint 后新 epoch 恢复。
- 新增 jsonl 与 DSH transport 回归测试，覆盖独立根链和普通 settle 不返回 stopped。

交付：

- 用显式 `driverRef = "dsh"` 组装真实 driver；fake 和 DSH 共用同一高层 runtime
  contract。
- CLI/standalone 的 `run` 创建 Task/Operation，启动 DSH，提交输入，观测事件，
  写 checkpoint；`resume` 从 HumanAgent checkpoint 恢复或明确 waiting。
- `~/.humanagent` 仍是唯一持久化 root；DSH session log 只作为 evidence。

测试条件：

- app lifecycle 使用 fake 和 DSH 共享测试。
- 外部身份不进入 Task/Operation/Checkpoint ID。
- 未显式配置 dsh 时拒绝，不 fallback 到 fake。
- run/resume 的实际入口 smoke。

退出证据：

- runtime/app focused tests、实际 CLI 命令、Journal/checkpoint 和 DSH evidence
  引用。
- 真实 DSH CLI `run` smoke：`session=dsh-smoke-tool`，`outcome=succeeded`，
  `observedKinds=["output","tool","tool","output","terminal"]`，证明同一 DSH session
  内完成 model -> tool -> result -> continue -> HumanAgent checkpoint。
- 当前收口 smoke 由
  `tests/adapters/dsh/real-dsh-humanagent-cli-smoke.mjs` 可重复生成：
  `session=dsh-smoke-1789432192051`，`outcome=succeeded`，
  `checkpoint=dsh-smoke-1789432192051-1-1`，RCC health 200，receipt 为
  `dist/receipts/dsh-humanagent-cli-smoke.json`，并保留 DSH session log 与
  HumanAgent checkpoint journal artifact。

### P4：Stop、crash 与 recovery —— `COMPLETE`

Owner：`packages/core`、`packages/runtime`、`packages/adapters/dsh`

DSH 能力边界（P1 已实测）：公开 SDK wire 无 per-session cancel / close，也不能
跨进程重开已持久化 session。因此：

- stop operation：撤销继续许可 → `requestStop`（映射为 runtime shutdown 请求）
  → 等待 root dispose + persistence quiescence + 进程 exit `0` → 收拢状态 →
  stopped checkpoint → close。不得返回虚构的 session cancel receipt。
- recovery：从 HumanAgent checkpoint 重建上下文并启动新 DSH session；DSH
  session log 只作 evidence，不作状态真源。

交付：

- stop operation 如上，settle 证据必须包含进程 exit 与 persistence commit。
- DSH runtime 意外退出：保留原始错误、生成恢复责任、从 checkpoint 恢复或明确
  waiting/blocked。
- 区分 cancel receipt、session quiescence、resource release、persistence close
  和 HumanAgent checkpoint commit。

测试条件：

- stop timeout、late event、transport close、crash、restart recovery。
- stop 未 settle 时不得生成 stopped checkpoint。
- recovery 失败必须带 owner、下一动作和原始错误。

退出证据：

- focused tests、crash/recovery receipt、stopped checkpoint 和资源释放证据。
- `dist/receipts/dsh-lifecycle-proof.json` 已验证 stop exit 0、mid-turn
  shutdown exit 0、跨进程 resume 被拒绝、crash 原始错误保留和新 session 恢复。

### P5：UI projection —— `COMPLETE`

Owner：`packages/ui/projection`、`packages/ui/surfaces`

交付：

- 只读展示真实输入、agent 状态、tool call/result、输出、checkpoint、
  stop/recovery 状态。
- UI 不读取 Journal、DSH Session 或原始日志。

测试条件：

- projection contract 正反测试。
- 实际入口桌面/窄宽度验证；状态、错误和 stop/recovery 可见。

退出证据：

- projection fixture/replay 和实际入口截图/交互证据。
- UI focused tests 9/9；`dist/receipts/ui/dsh-dashboard-desktop.png` 与
  `dist/receipts/ui/dsh-dashboard-narrow.png` 记录桌面和窄宽度投影。

### P6：四层验证与收口 —— `COMPLETE`

Owner：validation

交付：

1. fake contract。
2. recorded replay。
3. real RCC 4444 same-entry。
4. real DSH same-entry。

测试条件：

- 成功、waiting、blocked、failed、cancelled、stopped。
- tool failure、provider failure、session failure、transport close、stop timeout、
  crash recovery、late event、Journal/Session Log 分离。
- typecheck、build、focused tests、runtime integration、适用 release gate。

退出证据：

- 每层命令、退出码、artifact/receipt、限制和剩余风险。
- 独立 review PASS；P0/P1 = 0；candidate、merge、push、release 分别报告。
- `corepack pnpm@10.31.0 run typecheck` exit `0`；`test` 112/112；
  `test:release` 18/18。
- `proof:dsh-entry`、`proof:dsh-lifecycle`、`proof:dsh-cli` 均 exit `0`；
  receipts 为 `dist/receipts/dsh-entry-proof.json`、
  `dist/receipts/dsh-lifecycle-proof.json`、
  `dist/receipts/dsh-humanagent-cli-smoke.json`。
- `packages/app/src/agent-driver-composition.ts` 的真实 review finding
  “配置值可改变生成的 YAML route”已修复为 JSON 双引号 scalar 编码，并有
  `tests/app/app.test.ts` 负向测试；代码候选
  `9b67217774a05a5e4776d774e33993261460ea73` 的独立 review 为 PASS，
  P0/P1 = 0，receipt 为
  `.agent-collab/review/humanagent-real-single-dsh-agent-9b67217/`。
- 该 candidate 尚未 merge、push 或 release；最终文档提交会作为新的精确 SHA
  再运行一次只读 review，旧 review 不自动代表最终 SHA。

## 4. 验收场景

任务：`检查当前项目中是否存在某个配置问题，并给出结论。`

1. 用户创建 Task。
2. HumanAgent 创建 Operation 和 execution epoch。
3. 真实 DSH Agent 启动并加载 prompt、tools、provider、workspace、权限和 timeout。
4. Agent 调用一个真实只读工具。
5. Tool result 回到同一 DSH Session，模型继续推理。
6. Agent 形成阶段性结论。
7. HumanAgent 写 checkpoint。
8. UI 显示输入、tool call/result、输出和状态。
9. 用户执行 stop，等待真实 settle 后显示 stopped。
10. 模拟 DSH 退出，验证 checkpoint 恢复或明确 waiting。

## 5. 禁止事项

- 不在 dirty main 或 `/Volumes/extension/code/dsh` 开发。
- 不修改 `~/.rcc`，不自动安装/升级 DSH，不接 DSH WebUI。
- 不把 DSH/RCC/Cordis/SDK wire 类型上提为领域类型。
- 不用 fake、编译、listener readiness 或日志代替真实执行证据。
- 不把 cancel receipt 当 stopped，不用 fallback 隐藏失败。
