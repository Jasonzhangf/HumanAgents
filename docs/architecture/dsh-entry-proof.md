# 真实 DSH 入口证明（P0 / P1）

状态：`P0-COMPLETE / P1-COMPLETE / P2-COMPLETE / P3-COMPLETE / P4-COMPLETE / P5-COMPLETE / P6-REVIEW-PENDING`
日期：2026-09-14
Owner：`packages/adapters/dsh` + `docs/architecture`

本文只记录从干净 DSH 源码 worktree 上真实运行得到的事实。所有原始 JSON receipt 由
`tests/adapters/dsh/real-dsh-entry-proof.mjs` 和
`tests/adapters/dsh/real-dsh-lifecycle-proof.mjs` 生成；HumanAgent CLI
同入口 receipt 由 `tests/adapters/dsh/real-dsh-humanagent-cli-smoke.mjs`
生成。候选绑定的可提交副本、SHA-256、命令退出码和 HumanAgent checkpoint /
DSH session log artifact 位于 `docs/evidence/real-single-dsh-agent/`；
运行时脚本默认仍写入 ignored `dist/receipts/`，不把该路径当作唯一证据。

## 1. 锁定的 DSH 输入

| 项目 | 值 |
|---|---|
| 上游仓库 | `https://github.com/deepseek-ai/deepseek-harness.git` |
| ref | `refs/remotes/origin/master` |
| commit | `c291e7961a515f6d7af9304e7fd1d257929aef26` |
| Git tree | `e482b49bef64726be8f79380bb35bae569dc3c48` |
| describe | `dsh-v0.1.5-rc.2-139-gc291e7961a` |
| root version | `0.1.5-rc.2` |
| commit 时间 | `2026-09-10T22:17:09+08:00` |
| 干净 worktree | `/Volumes/extension/code/dsh/playground/humanagent-0.1.5-20260914` |
| 包管理器 / Node | `pnpm@11.7.0` / `v22.22.2` |

与 `docs/architecture/dsh-baseline.md` 锁定的 commit/tree 一致。本机安装的
`dsh 0.1.2-alpha.5` 是旧版本，不作为适配目标，只作为历史证据保留。

2026-09-14 从 canonical `~/code/dsh` 仓库重新执行 `git fetch origin master`
后，`origin/master` 仍为 `c291e7961a515f6d7af9304e7fd1d257929aef26`。该路径的
主 checkout 当前仍位于 dirty 的 `dsh-memory/alpha5`，因此所有构建和运行证据都
来自上面的 clean detached worktree，而不是旧 checkout 或本机旧安装。

### 源码启动入口

干净源码 checkout 没有构建产物，必须走源码入口：

```text
node --import tsx/esm apps/cli/src/bin.ts \
  --profile sdk \
  --patch apps/cli/src/sdk-source.cordis.patch.yml
```

- `--profile sdk` = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-sdk-app`，
  提供 stdio JSON-RPC 与 `read`/`write`/`edit`/`bash`/`web_*` 工具集。
- `--patch apps/cli/src/sdk-source.cordis.patch.yml` 是仓库自带的源码补丁，
  禁用只存在于构建产物中的 `typert-loader` 行。缺少它时 `initialize`
  会以 `typert contributor(s) failed to register` 失败。
- 首次运行需要 `pnpm install` 与 `pnpm run build:native-system`；后者构建
  `native/system/packages/darwin-arm64/bin/system.node`，缺少它时首个
  `turn/start` 会以 `Cannot find module .../system.node` 结束。

## 2. Provider 绑定

RCC `~/.rcc` 是外部配置真源，本阶段只读，不修改。

| 项目 | 值 |
|---|---|
| endpoint | `http://127.0.0.1:4444/v1` |
| route key | `rcc` |
| 认证 | 占位 `Authorization: Bearer`（`apiKeyEnv: RCC_LOCAL_API_KEY`） |
| 模型 | `gpt-5.5` |
| 协议 | `openai-completions` |

绑定通过独立 `DSH_HOME` 下的 `settings.yaml` 提供 `llm-pi-ai:` section；
DSH base 已挂载 `@deepseek-ai/dsh-llm-pi-ai`，section 一到就注册 route。
人类可复核命令：

```text
curl -sS http://127.0.0.1:4444/health
curl -sS http://127.0.0.1:4444/v1/models
```

### 协议选择是实测结论，不是偏好

RCC 4444 的 `/v1/responses` 在工具调用时返回非标准终止状态
`status: "requires_action"`；pi-ai `0.85.1` 的 Responses 停止原因映射只接受
`completed`/`incomplete`/`failed`/`cancelled`/`in_progress`/`queued`，因此
真实 turn 以 `Unhandled stop reason: requires_action` 失败。RCC 4444 的
`/v1/chat/completions` 返回标准 `finish_reason: "tool_calls"`，工具闭环可用。
因此本阶段把 route 绑定到 `openai-completions`。这是当前 endpoint 行为，
不是对 `responses` 协议的永久结论；RCC 行为变化时必须重测。

## 3. P1 入口证明（`real-dsh-entry-proof.mjs`）

单次真实运行的可复核事实：

- `initialize` → `serverInfo.name = deepseek-harness-sdk-runtime`。
- `session/prompt` 返回持久化入队 receipt `messageId`。
- 模型真实调用 `read` 工具：`tool/call` 带 `callId` 与
  `arguments.file_path`。
- 工具结果回到同一 session：`tool/result` 的
  `content[].toolCallId` 与 `tool/call.callId` 一致，`isError=false`。
- 同一 turn 的后续 step 产生新的 `assistant/message`，即模型消费了工具结果
  后继续推理（`continuedAfterToolResult = true`）。
- `turn/end.reason.kind = completed`。
- `shutdown` 返回 `{}`，进程 exit code `0`。
- session log 落盘：`$DSH_HOME/sessions/**/session.v3.jsonl.zstd`，
  zstd magic `28b52ffd`，首行 header `type=session, version=3`。
- 探针第二行是每次运行生成的 UUID nonce；proof 只有在模型真实调用 `read`、
  tool result 回到同一 session，且模型在后续 step 回报该 nonce 时才通过。

运行命令（下面示例写 `dist/`；正式候选证据已按 manifest 同步到
`docs/evidence/real-single-dsh-agent/`）：

```text
HUMANAGENT_DSH_SOURCE=/Volumes/extension/code/dsh/playground/humanagent-0.1.5-20260914 \
HUMANAGENT_RECEIPT_PATH=dist/receipts/dsh-entry-proof.json \
node tests/adapters/dsh/real-dsh-entry-proof.mjs
```

HumanAgent CLI 同入口 receipt：

```text
HUMANAGENT_DSH_SOURCE=/Volumes/extension/code/dsh/playground/humanagent-0.1.5-20260914 \
HUMANAGENT_RECEIPT_PATH=dist/receipts/dsh-humanagent-cli-smoke.json \
node tests/adapters/dsh/real-dsh-humanagent-cli-smoke.mjs
```

## 4. P4 生命周期证明（`real-dsh-lifecycle-proof.mjs`）

单次真实运行同时验证四个出口，并记录 DSH 的真实能力边界：

| 能力 | 结果 | 证据 |
|---|---|---|
| 持续推理（同 session 两轮） | PASS | 第二轮模型无需工具即复述第一轮读到的行 |
| stop / settle | PASS | `shutdown` → `{}`，exit `0`，session log 已 commit |
| 跨进程 session resume | **NOT AVAILABLE** | 复用已持久化 session id 得到 `session "main" already exists` |
| crash 恢复 | PASS | 中途 `SIGKILL` 得到 `signal=SIGKILL`；同一 `DSH_HOME` 上重新 boot 并完成新 session |

### 能力边界（决定 stop / recovery 语义）

DSH `0.1.5` 的公开 SDK stdio wire 只有三个请求方法：
`initialize`、`session/prompt`、`shutdown`。没有 per-session close，也没有
mid-turn prompt cancel：

- `packages/sdk/protocol/README.md#known-limitations-and-deferred-work`：
  “No cancel or session-close methods”。
- `packages/sdk/server/src/server.ts` 的 `getOrCreateSession` 只调用
  `agents.create`，没有 resume 分支；因此跨进程复用 session id 被拒绝。

由此确定本阶段的语义，而不是发明一个 cancel receipt：

1. **stop = runtime shutdown**。HumanAgent 撤销继续许可后请求 DSH 停止，
   唯一真实的 settle 是 `shutdown` 触发 root dispose、persistence 到达
   quiescence、进程 exit `0`。HumanAgent 只有在这些事实齐备后才写 stopped
   checkpoint。
2. **recovery = HumanAgent checkpoint → 新 DSH session**。因为公开入口不能
   重开旧 session，恢复不能把 DSH session log 当作状态真源。HumanAgent
   从自己的 checkpoint 重建上下文并启动新 DSH session；DSH log 只作为
   execution evidence。
3. **cancel receipt 不存在**。任何把“请求已受理”写成 stopped 的实现都违反
   本项目硬约束。

### 对 `DshTransport` 的约束

- `requestStop` 必须映射到 runtime shutdown 请求，不能返回虚构的 session
  cancel receipt。
- `settle` 必须等进程 exit 与 persistence commit，才能返回
  `resourceRelease.state = released` 且 `persistence.state = committed`。
- `resume` 不得声称恢复同一 DSH session；它只从 HumanAgent checkpoint 恢复
  并开启新 session，DSH session locator 只进入 `EvidenceRef`。
- `close` 与 `settle` 是同一物理动作的两个视角，必须可独立观测。

## 5. 当前收口

P0-P5 已完成，P6 实现与验证已完成但独立 review 仍为 `PENDING`：真实
transport、runtime/app/config 接线、stop/settle、crash recovery 和 UI
projection 均已通过 focused tests 与真实入口证据。四层验证已执行；当前实现候选
`29d4cfa1f690ab9b281115f570868cd4d38c92c2`，tree
`957110c188acffc20f00c146131f6f296a92524f`，把 HumanAgent Organ 收回 app
所有，DSH 只校验并转发 `organId` / `cycleId` / `operationId`。

candidate-bound receipts、gate manifest、HumanAgent checkpoint、DSH session log
和 UI 截图已提交到 `docs/evidence/real-single-dsh-agent/`。独立 review 结果由
后续 evidence commit 绑定到上述精确 SHA；review PASS 前不宣称最终收口。该
candidate 尚未 merge、push 或 production release。
