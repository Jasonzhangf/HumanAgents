# HumanAgent Open P1 Governance

Status: ACTIVE
Date: 2026-11-01
Owner: Jenny (humanagent master)
Parent: user-task-explicit-implicit-e2e-20260925.md (COMPLETE)

## Objective

Keep the HumanAgent UI execution path deliverable and govern the remaining open
P1 defects under one long-horizon goal. The user requires all open problems to
live in one continuously updated list; each wake must either make progress,
update the list, or report the exact blocker without waiting for the next
reminder. The open P1 list is now empty; the goal remains armed for new tasks.

## Open P1 (update every wake)

1. `new-task-landing-execution-dashboard-20261101` (G1.4)
   - Board status: `closed`.
   - Candidate: `325c0bb15`, based on `af5a2a731`.
   - Accepted after rework. The explicit-scope dashboard path now subscribes
     to `/api/executions/:id/events` while running/settling and renders
     execution-event step updates. Browser assertions cover both tested
     viewports.
   - Integrated and pushed on `origin/main` `d268a2dd1`.
   - Worktree and branch removed. No remaining action for this item.

2. `execution-corrective-retry-20261101`
   - Board status: `closed`.
   - Candidate: `c75ea4de3` rebased onto current main, merged fast-forward as
     `5d3f20752`.
   - Real-entry `local-file-search` E2E `SUCCESS` receipt with 4 screenshots and
     settled cleanup recorded in
     `docs/evidence/execution-corrective-retry-accept-20261101.md`.
   - Retry semantics locked by 3 red/green behavior tests; the real-entry
     retry-step observation is explicitly `UNVERIFIED` and recorded as a future
     harness-injection item, not a blocker.
   - Integrated on `origin/main` `5d3f20752`, accept evidence pushed at
     `d049e9316`. Worktree and branch removed after close.

## Peer / Worker DAG

- `Jenny` (master): owns review, integration, delivery records, worktree
  lifecycle and final acceptance.
- `Carol` (peer): owns `execution-corrective-retry-20261101` rework. Current
  work is limited to the candidate worktree
  `/Volumes/Intel/playground/humanagent/execution-corrective-retry-20261101`.
  Required next action is rebase onto latest main and a local-file-search or
  RCC 4444 parameterized real-entry success receipt with retry-step evidence.
- `Alice` (peer): idle with no active board task or owned worktree. Available
  for a bounded verification task if a concrete review or observation gap
  appears; no dispatch while Carol owns the only open candidate.
- `Bob` (peer): no active board task; do not invent work.
- `David` (peer, test engineer): no active board task; available for focused
  test execution when a concrete test gap appears.

## Standing Patrol

- `project-patrol` (`master-idle`, subject `project-patrol`) must be armed.
  Current runtime reports `interval_ms=900000` and
  `cadence_runtime_gap=PATROL_CADENCE_RUNTIME_GAP`; rearm to
  `1500000` using the existing subscription, do not create a second one.
- Worktree SESE: keep at most one active worktree per task domain; the retry
  candidate worktree above is the only remaining open candidate. Four locked
  provider worktrees are `PROTECTED_HOLD` and must not be removed.
- Production boundary: `127.0.0.1:10086` and `~/.humanagent` are read-only for
  this master. No source edit in the main tree for candidate fixes.

## Delivery Evidence

- Goal registration receipt: `appsdk goal status --json`.
- Board state: `collab board show`.
- Rework evidence for `new-task-landing`: review finding and subsequent
  candidate delivery.
- Retry rework evidence:
  `docs/evidence/execution-corrective-retry-review-rework-20261101.md`.

## Update Log

- 2026-11-01 12:31 UTC: created and registered this goal. Goal receipt:
  `active=true`, `observed=subscribed`, `interval=20m`,
  `goal_id=sha256:ad967f017d9cee8ec0dad48e34ce3461eea97759f65f4c54dab647fbb2f35ddc`.
- 2026-11-01 12:31 UTC: `new-task-landing-execution-dashboard-20261101`
  returned to Carol as `rework`. Evidence:
  `docs/evidence/new-task-landing-dashboard-review-rework-20261101.md`.
- 2026-11-01 12:31 UTC: `execution-corrective-retry-20261101` unblock
  direction changed: monid is not the bug root; use local-file-search or
  RCC 4444 parameterized real-entry scenario.
- 2026-11-01 12:31 UTC: sent both next actions to Carol in durable message
  `m1793536540127-320`.
- 2026-11-01 12:31 UTC: rearmed project patrol; existing subscription reused,
  cadence gap remains. Sent CEO completion reply `m1793536708700-324`.
- 2026-11-01 13:25 UTC: accepted and integrated `new-task-landing` candidate
  `325c0bb15`; `pnpm -s test:ui` passed 69/69; pushed `origin/main`
  `d268a2dd1`; removed worktree and branch; closed the task.
- 2026-11-01 13:30 UTC: returned `execution-corrective-retry` to rework for
  stale base and missing real-entry success receipt; sent Carol durable rework
  message `m1793539651471-403`.
- 2026-11-01 13:32 UTC: renewed the 20-minute goal deadline subscription after
  the one-shot deadline fired.
- 2026-11-01 13:40 UTC: consumed Alice idle report; no new task was assigned
  because the only open candidate remains owned by Carol.
- 2026-11-01 13:49 UTC: deadline fired and was renewed explicitly. Carol's
  retry worktree advanced to `3c1bdc5a6` on top of `d268a2dd1`; the board still
  reports rework and no new successful E2E receipt exists yet.
- 2026-11-01 14:12 UTC: second deadline fired and was renewed explicitly.
  Carol advanced to `af1125785` on top of `d05c0308e`; the board still reports
  rework, and no new local-file-search success receipt is present yet.
- 2026-11-01 14:37 UTC: third deadline fired and was renewed explicitly.
  Carol's candidate is still `af1125785`; no new E2E evidence appeared. Sent
  Carol a reply-required status request `m1793543854684-523`.
- 2026-11-01 14:58 UTC: fourth deadline fired and was renewed explicitly.
  Verified Carol's candidate advanced to `f83e1f600`, rebased directly onto
  current `origin/main` `8377e57c8`. Narrowed the remaining acceptance gap to a
  successful local-file-search real-entry receipt and sent Carol a concrete
  `--reply-required` command-level instruction; retry behavior remains covered
  by the 3 red/green behavior tests.
- 2026-11-01 15:44 UTC: reviewed Carol's delivery. Verified the local-file-search
  `SUCCESS` receipt, 4 screenshots, settled cleanup and the `04-task-result.png`
  task dashboard terminal. Re-ran `pnpm build:app` (exit 0),
  `execution-corrective-retry` (3/3) and `ui-runtime` (177/177) on the rebased
  candidate. Accepted, merged fast-forward, pushed `origin/main` `5d3f20752`,
  then pushed accept evidence `d049e9316`. Recorded `collab task review
  --accept`, `collab task integrated --commit d049e9316`, and closed the task.
  Worktree removed and branch deleted after verifying it was merged.
- 2026-11-01 15:53 UTC: no open P1 board task remains. Residual follow-up:
  deterministic attempt-1-fails/attempt-2-succeeds injection in the dashboard
  E2E harness so a real-entry `execution.retry` step can be observed. Not a
  blocker for the accepted candidate.
- 2026-11-01 16:17 UTC: deadline fired. Board has 0 open tasks, 0 open P1.
  main == origin/main == bbe8bff24. All workers idle/unknown, no eligible
  uncancelled tasks to wake. Goal deadline consumed; renewed for future wake.
  Remaining non-blocking follow-up: deterministic attempt-1-fails /
  attempt-2-succeeds injection in the dashboard E2E harness so a real-entry
  `execution.retry` step can be observed. This does not block any accepted
  candidate.
