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

## 3. Milestone 1 适配计划

### M1-0：入口和能力复核

Owner：DSH adapter owner。
输入：本文件锁定的 commit。
输出：public entrypoint、包依赖、Cordis profile、session 创建/恢复、事件、工具、取消、settle、持久化和 license 的证据矩阵。

失败时停止在 `dependency-missing`、`entrypoint-unavailable` 或 `capability-unavailable`，不得用 fake backend 伪造成功。

### M1-1：高层 port contract

Owner：`packages/contracts` / `packages/adapters/dsh`。
先让 fake driver 与 DSH driver 共用同一组高层 contract：

```text
start → resume → submit/observe → requestStop → settle
```

DSH 类型只能存在 adapter 边界。DSH `SessionId` 只能进入 `EvidenceRef`，不能成为 `TaskId`、`CheckpointId` 或 `AgentRuntimeId`。

### M1-2：独立 DSH profile 与 Cordis bridge

Owner：`packages/app` / DSH provider adapter。
使用独立 `DSH_HOME` 和 `humanagent` profile；HumanAgent 只做版本、profile、plugin、capability 和 readiness 检查，不静默下载或升级 DSH。默认 profile 不得被修改。

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

### M1-4：三层验证

Owner：独立验证 owner。
按顺序执行：

1. fake backend contract tests；
2. recorded DSH session replay；
3. 真实 DSH 同入口 `start/resume/tool-result/error/requestStop/settle`；
4. provider crash、transport close、plugin incompatibility 和 stop timeout；
5. checkpoint recall、Attention、恢复和 Journal/Session Log 分离证据。

每个失败、等待、阻塞、取消和成功出口都必须有 owner、下一动作和证据。

### M1-5：审查与放行

Owner：项目集成 owner。
放行前必须同时满足：

- adapter 只位于 `packages/adapters/dsh` 与受控 app/plugin 边界；
- 高层 contracts/core/runtime 没有 DSH 类型泄漏；
- DSH 版本、依赖、profile、plugin 和 patch 都有 lock/digest；
- fake、recorded、real 三层证据齐全；
- Astra review 通过；
- 用户批准后才 commit、push 或进入下一个 milestone。

## 4. 适配阶段的非目标

Milestone 1 只验证一个 DSH profile、一个 provider/model 路径和一个代表性工具。不做多 provider 路由、多 profile、长程压缩、高可用、生产部署或额外 DSH WebUI 产品范围。

完整的阶段退出条件沿用 [`mvp-to-milestones.md`](../goals/mvp-to-milestones.md#43-退出条件)；本文件只补充当前锁定的 DSH 输入。
