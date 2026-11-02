# HumanAgent Retry Visual Proof Governance

Status: COMPLETE
Date: 2026-11-01
Owner: Jenny (humanagent master)
Reviewer: David（复审，不做实现）
Executor: D17 GCM 执行者 + Jenny 独立审查
Closure: COMPLETE — D17 候选 ede3189ba 已并入 origin/main 751580a17，bug 3c8c433 已关闭，独立审查 d17-native-rcc-retry-review-20261102 verdict=pass，findings=[]；真实 RCC 4444 once-503 回执 Result: SUCCESS，terminal succeeded，checkpoint committed，execution.retry seq=4，双视口截图；工作树/branch 已 remove+prune 并 verified 不存在。目标工作项均已落盘，不再续订 goal 订阅。

## Objective

Close the only remaining verification gap from D15: prove the real UI execution
path shows a distinct `execution.retry` step when attempt 1 fails retryably and
attempt 2 succeeds. David's real RCC injection proof returned BLOCKED and
reopened the underlying defect: the merged bounded retry loop only runs on the
`orchestrated` lane, so the real `--mode rcc` product lane never retries. The
goal now owns the product fix that makes the real lane retry, not just the
visual proof.

## Open P1

1. `execution-retry-native-rcc-lane-20261101` (D17)
   - Status: `open`, executor GCM, reviewer Jenny.
   - Scope: `packages/**` and the retry harness under
     `tests/app/dashboard-e2e/**`, `tests/app/**retry*.test.*`, `docs/evidence/**`.
   - Forbidden: `.appsdk/**`, production `~/.humanagent`, four locked provider
     worktrees.
   - Provider: real RCC 4444 using `local-file-search`; monid is not used.
   - Root cause: `packages/runtime/src/ui-runtime/coordinator.ts:4811` retries
     only when `record.orchestrated` is true; `defaultOrchestrate()` at
     `packages/app/src/ui-runtime/service.ts:7241` returns `{}` whenever the
     native driver is bound, which is always true for `--mode rcc`
     (`packages/app/src/ui-runtime/index.ts:538`); `service.ts:2406` also
     withholds the `providerRetry` port when `executionPorts` is bound.
   - Acceptance: deterministic attempt 1 retryable failure then attempt 2
     success on the real RCC 4444 lane; E2E `receipt=SUCCESS`; terminal
     `succeeded`; checkpoint `committed`; cleanup `settled`; dashboard/journal
     trace contains `execution.retry`; 1280x720 and 390x844 screenshots;
     worktree and branch cleanup receipt.

2. `execution-retry-visual-proof-20261101` (closed as BLOCKED)
   - Board status: `working`, revision 3, executor David, reviewer Jenny.
   - David returned the injection harness plus BLOCKED evidence
     `docs/evidence/execution-retry-visual-proof-blocked-20261101.md` after
     proving the real lane cannot reach the retry branch without a product
     change. The harness (`tests/app/dashboard-e2e/lib/retry-injection.mjs`,
     `tests/app/dashboard-e2e/retry-visual-proof.mjs`) is reusable for D17.
   - The task is a BLOCKED handback, not a delivery. Master keeps the evidence
     and closes the board task once Collab is reachable.

## Standing Patrol

- Keep `project-patrol` (`master-idle`, subject `project-patrol`) armed.
- This goal uses a finite 20-minute deadline subscription; renew it only while
  the task remains open or new authorized work appears.
- The `board-idle-patrol` for the task may wake David. Do not duplicate a blind
  wake manually; use the current board facts.

## Worktree Boundary

David's proof worktree is
`/Volumes/Intel/playground/humanagent/execution-retry-visual-proof-20261101`
(branch `codex/execution-retry-visual-proof-20261101`, candidate `672a00d7d`).
One task domain has at most one active worktree. Before opening the D17
worktree, first preserve `672a00d7d` and this evidence, then run
`git worktree remove` + `git worktree prune` and confirm the old path is gone
(Close-Before-Open). The four locked provider worktrees are `PROTECTED_HOLD`
and must not be removed.

## Update Log

- 2026-11-01 17:30 UTC: created ACTIVE goal and published board task
  `execution-retry-visual-proof-20261101` to David. The first board invite
  notification was rejected by DSH (`no notification batch is ready`), but the
  board remained `invited`; a durable direct message
  `m1793554088716-866` was queued (`dsh-wake-enqueued`, consumed false).
- 2026-11-01 17:30 UTC: David accepted the board task (status=working,
  revision=3). The agreed worktree
  `/Volumes/Intel/playground/humanagent/execution-retry-visual-proof-20261101`
  was not yet present at 17:30 UTC; the task had just been accepted, so this
  is not an abnormal stall. No blind wake or duplicate dispatch is issued
  while David is working.
- 2026-11-01 17:30 UTC: patrol cleanup stopped the orphaned 06:04
  `execution-corrective-retry` E2E serve at explicit PID 8552. Its worktree
  had already been removed, the process was orphaned under PID 1, and it held
  only a localhost listener on port 58929. The port is now released. The
  production server on port 10086 was not touched.
- 2026-11-01 22:30 UTC: David returned the task BLOCKED (base `2d0146981`,
  candidate `672a00d7d`). Real RCC 4444 injection recorded
  `injectedCount=1` on `/v1/responses`, `forwardedCount=8`; the run's
  `operation.prepared` shows `orchestrated: false`, the journal shows
  `provider.model failed` with `retryable: true`, then
  `execution.terminal blocked`, and `execution.retry` occurrences = 0. The
  retry branch is unreachable on the native lane, so D15's retry loop is a code
  fact, not a reachable product behavior. D15 is reopened as P1 and D17 was
  created for the product fix under `packages/**`. Goal status is `ACTIVE`.
- 2026-11-01 22:45 UTC: Collab control plane became unreachable (daemon PID
  83158 no longer alive; `collab context`, `collab board show`, `collab status`
  and `appsdk goal status` all fail or time out). Master does not restart the
  user-managed daemon. Board close of `execution-retry-visual-proof-20261101`,
  goal re-arm and any peer dispatch via Collab are deferred until the daemon is
  reachable.
- 2026-11-01 22:51 UTC: attempted the AGENTS.md `nn-code` symbol-exploration
  route from `UiRuntimeService.startExecution` / `defaultOrchestrate` and
  `RuntimeTaskCoordinator.startExecution`. All variants return
  `status=unmet` / `resolution=entry_not_found` for class methods, even with
  `--entry-lexical-path UiRuntimeService.defaultOrchestrate`; the text scan
  still finds the declarations. Recorded as a `[capability-gap]` local report
  at `~/.local/state/nn-code/bug-reports/bug-20261101T225109Z-01.json`;
  Collab delivery to `NNAnything.Bob` is pending daemon recovery.
