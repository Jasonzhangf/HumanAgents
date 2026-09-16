# DSH 基线与 Milestone 1 适配准备

状态：`BASELINE-RE-LOCKED / REAL-SINGLE-DSH-AGENT`
日期：2026-09-14

本文是 DSH 外部源码基线的唯一项目记录。它只锁定可复现的 DSH 输入和适配计划，不代表 HumanAgent 已经实现或接入 DSH adapter。

## 1. 已锁定基线

| 项目 | 值 |
|---|---|
| 上游仓库 | `https://github.com/deepseek-ai/deepseek-harness.git` |
| 上游 ref | `refs/heads/master` |
| 验证 ref | `refs/remotes/origin/master` |
| 锁定 commit | `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` |
| Git tree | `80b651cca20f29d587518cf07a978f2bc58bc2c1` |
| 最近发布标记 | `dsh-v0.1.5-rc.2` |
| describe | `dsh-v0.1.5-rc.2-805-g0d1f50007f` |
| commit 时间 | `2026-09-15T11:16:06+08:00` |
| 基线性质 | 上游 master 源码快照，不是已发布的稳定包 |

该 commit 已在干净 detached worktree `/Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915` 中验证，验证时间为 `2026-09-14T22:53:33-07:00`。验证命令为 `git status --porcelain`、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}` 和 `git rev-parse refs/remotes/origin/master`；status 输出为空，验证 ref、commit/tree 与本表一致。原有 `/Volumes/extension/code/dsh` checkout 的 `git status --porcelain` 有大量 dirty/untracked 输出，仍保留其 dirty 状态，没有被覆盖、清理或当作基线。

### 版本解释

当前上游 master 的 root package 版本已为 `0.1.6-alpha.1`，但最近发布 tag 仍为 `dsh-v0.1.5-rc.2`；describe 显示在该 tag 之后还有 805 个提交。因此本项目锁定的是精确 commit，而不是把 `0.1.6-alpha.1` 或 `0.1.5-rc.2` 误写成当前 master 版本。

后续如果改用发布包，必须重新记录 package archive digest、依赖 lock、入口和 license；不能只把 commit 替换成一个 semver 字符串。

## 2. 当前边界

本次只完成：

- 更新 DSH remote tracking refs 和 tags；
- 取得上游最新 master 的 clean commit；
- 固化 commit/tree/tag 证据；
- 准备 Milestone 1 的适配计划。

本次不做：

- `packages/adapters/dsh` 实现；
- Cordis bridge 实现；
- DSH plugin/profile 安装；
- 真实模型、工具或 provider 凭据配置；
- DSH WebUI 接入；
- start/resume/stop/crash-recovery 运行验证。

## 2.1 Milestone 1 的临时 Provider 绑定

Milestone 1 暂时使用本机 RCC v3 的 `4444` listener 作为 Provider 执行入口。
当前只读事实和协议边界见 [`provider-adapters.md`](provider-adapters.md)。

```text
HumanAgent ProviderAdapter / DSH bridge
             ↓ 明确的 binding
          RCC v3 :4444
             ├── cc / cc-sol → responses codec
             └── goaichat    → anthropic codec
```

`4444` 是 listener，不是协议身份。`cc`/`cc-sol` 可共享 Responses codec，但
必须保留各自的 provider/route binding；`goaichat` 使用独立 Anthropic codec。
不得因为它们都经过 4444 就共用 request、stream、tool-call、error 或
cancel/settle 语义。`~/.rcc` 不是 HumanAgent 配置真源；本项目只读取非敏感
capability/lock 摘要，不修改 RCC 配置、不写入凭据，也不以 listener 可连接
作为适配完成证据。

## 3. Milestone 1 适配计划

### M1-0：入口和能力复核

Owner：DSH adapter owner。
输入：本文件锁定的 commit。
输出：DSH public entrypoint、包依赖、Cordis profile、session 创建/恢复、事件、
工具、取消、settle、持久化、license，以及 RCC 4444 listener、`responses`、
`anthropic` capability 的证据矩阵。必须记录 DSH 是否能以可审计方式绑定
Provider endpoint、protocol 和 model。

失败时停止在 `dependency-missing`、`entrypoint-unavailable` 或 `capability-unavailable`，不得用 fake backend 伪造成功。

### M1-1：高层 port contract

Owner：`packages/contracts` / `packages/adapters/dsh`。
先让 fake driver、Provider adapter 与 DSH driver 共用 [`agent-request-response.md`](agent-request-response.md) §10 的高层 Driver contract：

```text
start → send(dispatch receipt) → observe/readResult → requestStop → reconcile → settle → close
```

旧 `resume`、`submit` 只能作为 adapter 内部兼容入口，分别映射到 `start({ mode: 'resume' })` 和 `send` + `readResult`，不能进入公共高层 contract。DSH 类型只能存在 adapter 边界。DSH `SessionId` 只能进入 `EvidenceRef`，不能成为 `TaskId`、`CheckpointId` 或 `AgentRuntimeId`。
Provider `providerId`、route、model 和外部 session/request id 同样不能成为高层身份。

### M1-2：`cc` / `goaichat` 协议 adapter 与独立 DSH profile

Owner：`packages/adapters/provider` 负责 binding、Responses/Anthropic codec 和
Provider readiness；`packages/adapters/dsh` 负责 DSH profile/Cordis bridge；
`packages/app` 只负责组装和生命周期接线。
先实现并分别验证 `responses`（`cc`/`cc-sol`）和 `anthropic`（`goaichat`）
协议 seam，再使用独立 `DSH_HOME` 和 `humanagent` profile；HumanAgent 只做
版本、profile、plugin、capability 和 readiness 检查，不静默下载或升级 DSH。
默认 profile 不得被修改。

优先验证受监督的外部 provider 进程和 typed local transport；transport 选择不能改变高层 `ExecutionRuntimePort`。

### M1-3：事件、证据和停止映射

Owner：DSH adapter。
验证：

- DSH 原生事件映射为带 `taskId`、`operationId`、`executionEpoch` 的高层事件；
- DSH session log 保存为 evidence ref；
- provider 错误进入 operation/Attention/error owner；
- cancel receipt 不直接等价于 stopped；
- 只有真实 settle 和 stopped checkpoint 才能关闭 stop operation；
- DSH debug log 不用于重建 HumanAgent 控制状态。
- Responses 与 Anthropic 的 stream/tool/error/cancel 事件分别经过各自 codec，
  不能用另一协议的字段猜测缺失事件。

### M1-4：四层验证

Owner：独立验证 owner。
按顺序执行：

1. fake backend contract tests；
2. recorded Provider/DSH session replay，分别覆盖 Responses 与 Anthropic；
3. 真实 RCC 4444 同入口 `start/resume/tool-result/error/requestStop/settle`；
4. 真实 DSH profile 同入口（仅在 M1-0 证明该绑定能力可用时）；
5. provider crash、transport close、plugin incompatibility、stop timeout、
   checkpoint recall、Attention、恢复和 Journal/Session Log 分离证据。

每个失败、等待、阻塞、取消和成功出口都必须有 owner、下一动作和证据。

### M1-5：审查与放行

Owner：项目集成 owner。
放行前必须同时满足：

- Provider adapter 只位于 `packages/adapters/provider`；DSH bridge 只位于
  `packages/adapters/dsh` 与受控 app/plugin 边界；
- 高层 contracts/core/runtime 没有 DSH 类型泄漏；
- DSH 版本、依赖、profile、plugin 和 patch 都有 lock/digest；
- fake、recorded、real RCC、real DSH 四层证据齐全；
- Astra review 通过；
- 用户批准后才 commit、push 或进入下一个 milestone。

### 3.1 每个小阶段的 Astra gate

M1 不允许跨阶段带病前进。每个小阶段都必须在其自身候选范围内完成 focused
validation 和独立 Astra review；Astra PASS 只证明当前候选满足审查标准，不
自动授予 merge、commit、push 或发布权限。

| 小阶段 | 独立交付 | 最小证据 | Astra gate |
|---|---|---|---|
| M1-0 | DSH/RCC 能力矩阵和失败矩阵 | clean DSH baseline、4444 listener、协议/入口证据 | `Astra-M1-0` PASS 后才可写 adapter |
| M1-1 | Provider-neutral binding/port | fake contract、负向 identity/protocol tests | `Astra-M1-1` PASS |
| M1-2 | Responses/Anthropic adapter seams + DSH profile seam | codec fixtures、readiness、lock 摘要 | `Astra-M1-2` PASS |
| M1-3 | event/evidence/error/stop mapping | recorded replay、epoch/settle/Attention tests | `Astra-M1-3` PASS |
| M1-4 | real same-entry execution | RCC 4444 与 DSH start/resume/stop/recovery 证据 | `Astra-M1-4` PASS |
| M1-5 | closeout candidate | clean tree、digest、全 receipts、限制清单 | `Astra-M1-5` PASS 后才可放行 |

每个 receipt 必须绑定候选 commit、scope、验证命令、reviewer task/result、
findings 和修复后的重验结果。review 失败回到对应 owner；不得换通道取 PASS，
不得用下一阶段的结果掩盖当前阶段缺证据。

## 4. 适配阶段的非目标

Milestone 1 只验证一个 DSH profile、一个代表性工具、两种协议和三个独立的
ProviderBinding（Responses 的 `cc`、`cc-sol` 与 Anthropic 的 `goaichat`）。不做多
provider 路由策略、多 profile、长程压缩、高可用、生产部署或额外 DSH WebUI
产品范围。

完整的阶段退出条件沿用 [`mvp-to-milestones.md`](../goals/mvp-to-milestones.md#43-退出条件)；本文件只补充当前锁定的 DSH 输入。
