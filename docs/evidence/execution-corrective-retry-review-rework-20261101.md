# Review Rework: execution-corrective-retry-20261101

Status: REWORK
Reviewer: Jenny (humanagent master)
Task: execution-corrective-retry-20261101
Candidate: f641096b90e3b519ebccd6a92d2fc0c9a1350ac5
Branch: codex/execution-corrective-retry-20261101

## Required fixes

1. Rebase the candidate onto the current `origin/main`. The candidate merge base
   is `42ad8e69c`; current `origin/main` is `d268a2dd1` after the landing
   dashboard integration. The candidate must be combined with latest main and
   the affected checks re-run before review.

2. Provide a real-entry E2E receipt with `success` and a screenshot chain.
   The submitted web-search receipts end in `INCOMPLETE` because `web.search`
   fails with monid `INSUFFICIENT_BALANCE`. That is an external environment
   dependency, not a passing receipt.

3. Use a real-entry scenario that does not depend on the monid wallet. The
   project already has a local-file-search dashboard E2E graph and scenario.
   Run a local-file-search or an RCC 4444 parameterized scenario and capture:
   first failure, corrective retry step, second attempt carrying the prior
   failure reason, terminal result, and cleanup.

## Evidence reviewed

- Code and red/green behavior tests for bounded corrective retry are present.
- Focused ui-runtime regression is 177/177 in the submitted log.
- The submitted `deepseek-v4-pro` web-search receipt is `INCOMPLETE` with
  `provider start failed ... INSUFFICIENT_BALANCE`.
- No successful real-entry receipt or successful retry-step observation is
  included.

## Decision

Do not integrate this candidate until the base is current and a real-entry
retry-loop receipt with `success` plus screenshots is available.

---

# Rework Response (author)

Status: PARTIAL — fixes 1 and 2 satisfied; fix 3 satisfied only for the success
half. The retry-step half is UNVERIFIED and is reported as such, not rewritten.

Candidate branch: `codex/execution-corrective-retry-20261101`, HEAD `f83e1f600`,
merge base with `origin/main` (`8377e57c8`) is the current main tip.

## Fix 1 — rebase onto current origin/main: DONE

The candidate is rebased onto `8377e57c8`. `git merge-base HEAD origin/main`
returns `8377e57c8`, so the candidate now sits directly on the current main tip
(the earlier base was `42ad8e69c`). The two rework documents landed on main since
the review touch only `docs/`; no candidate source file overlaps them, so the
rebase was conflict-free.

Affected checks re-run on the rebased candidate:

- `execution-corrective-retry` red/green tests: 3/3 pass.
- `ui-runtime` regression: 177/177 pass.
- `pnpm build:app` and `pnpm build:runtime`: exit 0.

## Fix 2 — real-entry receipt with `success` and a screenshot chain: DONE

`local-file-search` was run through the real browser entrance against RCC 4444
(`inferai.deepseek-v4-pro`) from the rebased candidate. The receipt reports
`result: SUCCESS` with `cleanup.branch: settled`, and settlement states
`authoritative same-scope journal terminal succeeded with compatible
checkpoint/operation closure`. Every stage is `ok`, including `provider_probe`,
`serve_start`, `browser_session`, `local-file-search_entry`,
`attempt_stop_settle`, and `local-file-search_cleanup`.

This path does not touch the monid wallet, so it does not reproduce the
`INSUFFICIENT_BALANCE` failure that made the web-search receipts INCOMPLETE.

Receipt and screenshots (product path, derived from `~/.humanagent`):

- Root:
  `~/.humanagent/sessions/-private-var-folders-jm-blkk8bbd6v78rv2pwxgxh3kr0000gn-T-humanagent-e2e-local-file-search-20261101-061117-3fq3j2-workspace/run-notes/local-file-search-20261101-061117-3fq3j2/`
- `evidence.json`, `receipt.md`
- Screenshots `shots/01-input-before-submit.png`, `02-draft-confirmed.png`,
  `03-run-queue.png`, `04-task-result.png`

A failed-effort copy is archived outside the product root for review
convenience at `/tmp/retry-e2e-evidence/archive/` (`success-evidence.json`,
`success-receipt.md`). The product path above is the authoritative receipt root.

## Fix 3 — first failure, retry step, corrective second attempt: UNVERIFIED

The success receipt above does not contain the retry loop. It records
`execution.retry` zero times and `纠正说明` zero times: the first provider attempt
succeeded, so the corrective branch never ran. That receipt proves entrance
connectivity, tool rounds, terminal result and cleanup. It does not prove the
retry loop, and it is not submitted as if it did.

The blocking fact is that the four required retry observations are not
obtainable from the current real entrance:

1. `local-file-search --outcome failure` drives a real `file.read` against a
   deliberately missing path. That attempt records
   `provider.tool-result` summary `file.read failed`, then `execution.terminal`
   state `blocked` with summary
   `ENOENT: no such file or directory, lstat '.../e2e-fixture/e2e-missing-file.txt'`.
   The journal contains no `execution.retry`. This is correct behavior, not a
   candidate defect: a tool execution result is a committed side effect, and
   `coordinator.ts` requires `!committedSideEffects` before re-dispatch
   (the guard at the `shouldRetry` computation). The run reports
   `INCOMPLETE` with `deviation.stage: outcome_mismatch` and
   `cleanup.branch: unsettled-recovery-retained`.

2. The retry branch needs `workResult.status === 'failed'` together with
   `closure.state === 'failed'` and no committed side effects. Through the live
   RCC entrance that is a provider-level settle failure, which cannot be induced
   deterministically by any existing runner option. The runner exposes exactly
   three outcomes (`success`, `failure`, `cancel`); none of them reaches it.

3. The scripted fake provider does have a no-tool failure replay
   (`--fake-scenario error`: `model` then `terminal failed`, no tool event),
   which would satisfy `!committedSideEffects`. But the fake scenario is fixed
   for the whole serve lifetime, so a second attempt repeats the same failure and
   the task ends `blocked` rather than `succeeded`. Producing "first attempt
   fails, second succeeds" would require new attempt-aware provider behavior in
   the harness.

4. An attempt to route the failure through a directive that instructs the model
   not to call any tool was tried and reverted. The confirmation gate keeps the
   draft submit control disabled for that directive, so the attempt never
   reaches execution (`page.click: Timeout 30000ms exceeded ... element is not
   enabled`). The scenario file is restored to its committed content.

Therefore the retry-step evidence requested by fix 3 is reported UNVERIFIED
rather than fabricated. What is proven for the retry semantics today is the
red/green behavior suite, which covers all three retry branches directly:
first-attempt retryable failure then success with the prior failure reason
carried into the second dispatch; repeated failure reaching the attempt cap with
`retryable: false` and the first reason retained; and committed-side-effect
failure not being re-dispatched. The real-entry proof is limited to the success
half.

## What is needed to close fix 3

One decision or one change:

- Add a deterministic provider-failure injection to the dashboard E2E harness so
  a real entrance drives attempt 1 to a provider-level failure and attempt 2 to
  success, then capture the `execution.retry` step, the corrective prompt
  carrying the first failure reason, the terminal result and cleanup. This is a
  change to `tests/app/dashboard-e2e/`, outside the current candidate source
  scope.
- Or accept the retry-step real-entry observation as UNVERIFIED for this
  candidate, on the basis of the 3/3 behavior suite plus the real-entry success
  receipt, and record the gap explicitly.
