# Goal：真实单 DSH Agent

```text
/goal
目标：
完成 `docs/goals/real-single-dsh-agent-plan.md` 定义的真实单 DSH Agent 主线：
HumanAgent 拥有 Task、Operation、execution epoch、checkpoint 和恢复责任；
真实 DSH Agent 通过 Provider-neutral ExecutionRuntimePort 执行，调用真实工具，
经 RCC 4444 持续推理，结果回到同一 DSH Session，并由 HumanAgent 写
checkpoint。stop 按计划的真实 DSH stop/settle 映射完成，不得把请求受理、
cancel receipt 或进程退出单点当作 stopped。

范围与约束：
- 项目：/Volumes/extension/code/humanagent
- 从最新 origin/main 创建独立 clean worktree；只在该 worktree 修改。
- DSH 适配真源固定为 `~/code/dsh`（canonical path
  `/Volumes/extension/code/dsh`）：先 `git fetch origin master`，再以当时
  `origin/master` 的 commit/tree/describe 建立 detached clean worktree；
  禁止使用 `dsh-memory/alpha5`、本机旧安装或缓存版本。
- 2026-09-14 已复核最新 `origin/master` 为
  `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`（tree
  `80b651cca20f29d587518cf07a978f2bc58bc2c1`，describe
  `dsh-v0.1.5-rc.2-805-g0d1f50007f`）。该值是当前参考锁，不是可长期复用的
  old pin：每次开始 DSH build/run 前必须重新 fetch；若 `origin/master` 前移，
  先同步 `packages/adapters/dsh/src/lock.ts`、入口证明和 receipts，再跑验证，
  不得继续运行旧 commit。
- 先完成脚手架和真实 DSH entry proof，再实现 transport、bridge、runtime/app
  接线、stop/recovery 和 UI projection；不跳过入口证明直接写 adapter。
- 优先使用 DSH 公开 out-of-process SDK/stdio JSON-RPC entry；不得把 DSH
  SessionId、事件类型、日志格式或 Cordis 类型上提到 contracts/core/runtime。
- HumanAgent 自己拥有 Task、Operation、execution epoch、checkpoint、Journal、
  Attention、stop/settle、health 和 UI projection。DSH 只拥有 profile、session、
  agent、tool、model 和原生执行事件；RCC 只拥有外部 Provider endpoint、route、
  model 和 auth 配置。
- stop、recovery、session continuation、工具边界和 UI 投影的语义以
  `docs/goals/real-single-dsh-agent-plan.md` 与
  `docs/architecture/dsh-entry-proof.md` 的实测结论为准。
- 不修改 /Volumes/extension/code/dsh；不修改 ~/.rcc；不自动安装或升级 DSH；
  不接 DSH WebUI、不做多 Agent、不做 Memory/RAG、不做生产发布。
- 不静默 fallback，不用 fake、编译、listener 可连接或 DSH 日志存在冒充真实执行。
- cancel receipt 不等于 stopped；必须等待实际 settle、资源释放和 persistence
  commit，再写 HumanAgent stopped checkpoint。
- 保留用户已有 dirty 文档和其他 worktree；禁止 checkout/reset/restore/stash
  清理，禁止覆盖他人改动。

依据：
docs/goals/real-single-dsh-agent-plan.md
docs/goals/foundation-ui-dsh-plan.md
docs/goals/m1-provider-dsh-adaptation-goal.md
docs/architecture/dsh-baseline.md
docs/architecture/provider-adapters.md
docs/architecture/host-and-cordis.md
docs/architecture/organ-runtime.md

验收：
- 真实 DSH entry proof 有可复核 receipt：profile boot、session create、
  prompt admission、follow 事件、tool result、shutdown/settle、能力边界和
  失败矩阵；所有 DSH 身份只进入 EvidenceRef。
- ExecutionRuntimePort 经 AgentDriver 驱动 AgentRuntime；同一 DSH Session 内
  完成至少一次 model -> tool -> tool result -> continue 闭环。
- stop operation 有 HumanAgent 撤销继续许可、按当前 DSH wire 的 stop/settle、
  资源释放、persistence commit 和 stopped checkpoint 证据。
- DSH 意外退出保留原始错误，operation 不静默成功，能恢复或进入明确 waiting。
- fake contract、recorded replay、real RCC 4444、real DSH same-entry 四层验证
  语义一致；Journal 与 DSH Session Log 分离。
- UI projection 可显示输入、agent 状态、tool call/result、输出、checkpoint 和
  stop/recovery；UI 不读取 DSH log。
- focused tests、runtime integration、typecheck、build、适用 release gate 和独立
  review PASS；P0/P1 = 0。未完成项必须明确列出，不得声称已入 main。

完成信号：
输出 REAL_SINGLE_DSH_AGENT_COMPLETE，并附 candidate SHA、验证命令与退出码、
真实 DSH receipt、四层验证结果、review receipt、剩余风险和未完成项。

直接执行本任务，不再为它生成一层提示词。
```
