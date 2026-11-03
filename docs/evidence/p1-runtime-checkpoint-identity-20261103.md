# c5d4671 runtime checkpoint identity mismatch — SUCCESS evidence

Status: SUCCESS. The real `serve --mode rcc` entry now settles a task to
`succeeded` after a child-assembly review checkpoint, and the focused
`live-step-feedback` suite is 4/4 on the candidate and on clean `origin/main`.

Bug: `tests/app/live-step-feedback.test.ts` "task events stream reports
provider request rounds and child lifecycle steps" failed with
`runtime.execution.failure` / `checkpoint identity mismatch`, thrown from
`packages/contracts/src/index.ts:817` `assertCheckpointIdentity`.

Task: `p1-runtime-checkpoint-identity-20261103` (D19). Worktree
`/Volumes/Intel/playground/humanagent/p1-runtime-checkpoint-identity-20261103`,
branch `codex/p1-runtime-checkpoint-identity-20261103`, merged to `origin/main`
at `144038fdce117cbd888223006fe176a6192ce9fe`.

## Root cause

`commitBusinessCheckpoint` in
`packages/runtime/src/ui-runtime/coordinator.ts` built its business scope from
the record's cached `record.checkpoint` first, then read the store for a newer
predecessor afterwards. A checkpoint committed out of band (a child assembly's
`review-result` checkpoint) is therefore only discovered after the scope was
already fixed. The new terminal checkpoint then dropped the operation id its
real predecessor carries, and `assertCheckpointIdentity` rejected the link,
failing the task with `runtime.execution.failure` / `checkpoint identity
mismatch`.

Diagnosis (instrumented, since removed) confirmed the exact first divergence:
`newScope={organId,taskId,cycleId}` (no operationId) vs
`prevScope={organId,taskId,cycleId,operationId=ui-operation-implicit-draft-1}`
— the successor was linked to the operation-scoped `review-result` predecessor
but its own scope had dropped `operationId`.

## Fix

`packages/runtime/src/ui-runtime/coordinator.ts` — the single owner file. Read
the latest committed checkpoint before deriving the business scope, so the
inherited operation id comes from the real predecessor. Scope semantics and
`assertCheckpointIdentity` are unchanged; `packages/contracts`,
`packages/core`, and the UI/app service files are untouched.

## Evidence

- Red (pristine `1b0ac47b5`): focused test fails
  `not ok 1 - task events stream reports provider request rounds and child
  lifecycle steps` with task list `failed`, error
  `runtime.execution.failure` / `checkpoint identity mismatch`, checkpoint
  `checkpoint-ui-task-implicit-draft-1-1-4` seq 4 outcome `failed`.
- Green candidate (`640652956`): focused test `ok 1`; full suite `# pass 4 /
  # fail 0`.
- Regression sweep (candidate): `file-checkpoint-store`,
  `checkpoint-history-public-consumer`, `native-checkpoint-phase-public` all
  green; `cold-execution-resume-public-consumer` shows the same 9 failures on
  pristine base (pre-existing, not a regression from this fix).
- Clean `origin/main` (`fd31df603` rebased candidate): `# pass 4 / # fail 0`.
- Real RCC 4444 same entry: `scripts/c5d4671-rcc-receipt.mjs` drives the built
  `serve --mode rcc` CLI over its HTTP API against the live RCC endpoint
  `http://127.0.0.1:4444` (health `{"status":"ok","build_version":"0.90.4940"}`)
  through grant -> execution -> terminal settlement. Receipt
  `docs/evidence/c5d4671-rcc-receipt.json`: terminal `succeeded`, output
  `2+2 = 4.`, provider 36 `provider.model` rounds with `dispatching ->
  dispatched -> settled`, `dispatchTurn === settleTurn`, and the committed
  checkpoint `turn-active-turn-ui-operation-1-1` seq 1 outcome `succeeded`.

Note: the real RCC serve path uses the native driver (`standardTurn`), so the
non-native orchestration child lifecycle steps (`child.prepared`,
`child.returned`, `child.adopted`, `review.checkpointed`) are asserted by the
focused fake-replay-port test rather than the real RCC run, which instead
proves provider request rounds and terminal settlement on the same real entry.

## Delivery

- `b4746dfb7` fix(runtime): derive checkpoint business scope from the observed
  predecessor
- `144038fdc` evidence(c5d4671): real RCC 4444 same-entry receipt for
  checkpoint identity fix
- Merged `codex/p1-runtime-checkpoint-identity-20261103` to `origin/main`
  (fast-forward), pushed. Worktree removed. Diagnostic instrumentation was
  reverted before the candidate commit; only the final fix is in `main`.
