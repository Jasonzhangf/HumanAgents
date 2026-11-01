# 执行纠正循环任务合同（2026-11-01）

Master: Jenny。Owner: 执行 peer（默认 Carol）。Reviewer: Jenny。

## 背景与证据

- UI 真实执行路径在 `packages/runtime/src/ui-runtime/coordinator.ts:2839`（冷恢复）和 `:5012`（新派发）构造 task assembly 时硬编码 `maxAttempts: 1`，覆盖了编排层 `manager.ts:345` 的默认 2。
- dispatch 返回 `retryable` 时，`coordinator.ts:5033` 起的处理只把 closure 置 `blocked`、`error.retryable=true`，不重新派发。因此真实 UI 路径没有纠正循环。
- 模型输出类错误（Planner 非 JSON、file.search queryKind、asset:// 交付引用等）当前 fail-closed。2026-10-31 10:39、12:16 两次 E2E 因此 `INCOMPLETE`，靠外部重跑才成功。
- 可复用部件，不新造第二套：`packages/core/src/error-policy.ts` 的 retry/degrade/wait/blocked/failed/attention 与 changed-condition 约束；`packages/core/src/events.ts` 的 maxAttempts/nextAttemptAt；`packages/runtime/src/orchestration/manager.ts` 的 `retryAssignment`、`publishFailureFeedback`、`markRetryable`；tool-execution 的 `retryAllowed`。

## 目标

在 UI 真实执行路径上加入有界纠正循环：失败后按条件有限次重试，重试必须携带上一轮失败原因，耗尽后显式失败。

## 行为契约

1. 有界：默认最多 2 次尝试（首次 + 1 次纠正），必须有硬上限，不得无限循环。
2. 触发：仅当失败标记为可重试，且本轮没有已提交副作用（文件写入、tool 执行结果、checkpoint commit）时重试。
3. 纠正：下一次模型请求必须包含上一轮的具体失败原因或校验错误，不得原样盲重试。
4. 耗尽：达到上限后任务 blocked/escalated，`retryable=false`，保留首次错误原因与证据。
5. 可见：重试作为独立 step 投影到任务轨迹（第 N 次尝试与重试原因）；涉及用户承诺的前台错误仍立即可见。
6. 不重试已完成副作用的操作；不吞错；不改 `packages/core` 语义。

## 唯一 owner 与路径

- 主改：`packages/runtime/src/ui-runtime/coordinator.ts`。
- 仅在需要把失败原因写入下一次 assignment/feedback 时改：`packages/runtime/src/orchestration/manager.ts`。
- 测试：`tests/app/ui-runtime*.test.ts` 或 `tests/app/*retry*.test.ts`。
- 禁止：`packages/core` 语义、`.appsdk/`、生产 `~/.humanagent`、4 个 locked provider worktree。
- worktree：`/Volumes/Intel/playground/humanagent/execution-corrective-retry-20261101`，从最新 `origin/main` 建。

## 验收

- 红测：fake provider 首次可重试失败、第二次成功 → 任务 succeeded，轨迹含 retry step，第二次请求含失败原因。
- 红测：始终失败 → 达到上限后 blocked，`retryable=false`，保留首次原因。
- 红测：已提交副作用后失败 → 不重新派发。
- 现有 focused tests 不回归；真实入口 E2E 重跑至少 web-search，取 receipt 与截图。
- 提交前一次独立 review。

## 交付回执

commit、changed files、测试命令与结果、E2E receipt/截图、剩余风险、worktree/branch 清理回执。
