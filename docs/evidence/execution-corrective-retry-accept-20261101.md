# Review Accept: execution-corrective-retry-20261101

Status: ACCEPTED
Reviewer: Jenny (humanagent master)
Task: execution-corrective-retry-20261101
Owner: Carol
Date: 2026-11-01

## What was accepted

The UI execution path now has a bounded corrective retry loop owned by
`packages/runtime/src/ui-runtime/coordinator.ts`:

- Default attempts raised from 1 to 2, with a hard attempt cap.
- A failed attempt is re-dispatched only when the failure is retryable, the
  execution mode is `execute`, and no side effect was committed.
- The corrective dispatch carries the prior attempt's concrete failure reason
  in the prompt instead of resending the original input unchanged.
- Exhaustion produces an explicit blocked terminal with `retryable=false` and
  keeps the first failure reason and evidence.
- A committed side effect blocks re-dispatch and says so explicitly.
- The retry is projected as a distinct `execution.retry` step in the trace and
  SSE event stream.

## Verification on current main

Candidate branch `codex/execution-corrective-retry-20261101` was rebased onto
current `origin/main` before integration and merged fast-forward. On the merged
main tree:

- `pnpm build:app` exit 0.
- `tsc -p tests/app/tsconfig.json` exit 0.
- `tests/app/execution-corrective-retry.test.js` 3/3 pass.
- `ui-runtime.test.js` 177/177 pass.

Integration: merged fast-forward and pushed to `origin/main` at `5d3f20752`.

## Real-entry evidence

The owner delivered a `local-file-search` dashboard E2E `SUCCESS` receipt with
four screenshots and settled cleanup. This path uses RCC for the model and local
`file.search`/`file.read` tools, so it does not depend on the monid wallet.

- Receipt root:
  `~/.humanagent/sessions/-private-var-folders-jm-blkk8bbd6v78rv2pwxgxh3kr0000gn-T-humanagent-e2e-local-file-search-20261101-061117-3fq3j2-workspace/run-notes/local-file-search-20261101-061117-3fq3j2/`
- `receipt.md` / `evidence.json` report `result: SUCCESS`, terminal `succeeded`,
  `cleanup.branch: settled`.
- Screenshots: `shots/01-input-before-submit.png`, `02-draft-confirmed.png`,
  `03-run-queue.png`, `04-task-result.png`.
- The inspected `04-task-result.png` shows the real task dashboard with the task
  marked complete and the execution trace ending in `execution.terminal
  succeeded` plus planner alignment `complete`.

## Residual gap (explicit, not hidden)

The real-entry `local-file-search` success run completed on its first provider
attempt, so it did not naturally exercise the `execution.retry` step. The owner
reported the retry-step real-entry observation as `UNVERIFIED` instead of
fabricating it. The corrective retry semantics are proven by the three
deterministic red/green behavior tests, which drive the real coordinator loop
with a scripted provider port.

A deterministic "attempt 1 fails, attempt 2 succeeds" injection in the dashboard
E2E harness is tracked as a separate follow-up and does not block this candidate.

## Decision

Accept. Merge, verify main, push, close the task, and remove the task worktree and
branch.
