# HumanAgent Open P1 Governance

Status: ACTIVE
Date: 2026-11-01
Owner: Jenny (humanagent master)
Parent: user-task-explicit-implicit-e2e-20260925.md (COMPLETE)

## Objective

Keep the HumanAgent UI execution path deliverable and govern the remaining open
P1 defects under one active long-horizon goal. The user requires all open
problems to live in one continuously updated list; each wake must either make
progress, update the list, or report the exact blocker without waiting for the
next reminder.

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
   - Board status: `rework` after Jenny review.
   - Candidate: `f641096b9` in
     `/Volumes/Intel/playground/humanagent/execution-corrective-retry-20261101`.
   - Review finding: the candidate merge base is `42ad8e69c`, while current
     `origin/main` is `d268a2dd1`. Rebase/merge the candidate onto latest main.
   - Review finding: real web-search E2E is `INCOMPLETE` because `web.search`
     returns `INSUFFICIENT_BALANCE` from monid. The contract requires a successful
     real-entry receipt and screenshots, plus observable retry behavior.
   - Required rework: use local-file-search or an RCC 4444 parameterized
     real-entry scenario; capture the first failure, `execution.retry` step,
     second request carrying the failure reason, terminal result, and cleanup.
   - Owner: Carol. Reviewer: Jenny.

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
