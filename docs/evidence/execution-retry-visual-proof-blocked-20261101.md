# execution-retry-visual-proof-20261101 — BLOCKED (product change unavoidable)

Status: BLOCKED. The real-entry `execution.retry` step observation required by
this task is **architecturally unreachable** through the real `--mode rcc`
dashboard E2E entry. Reaching it requires a change in `packages/**`, which the
task contract forbids. Per the contract ("若产品改动不可避免，先退回 master 并附证据"),
the worktree returns to `master` with the evidence recorded below instead of
modifying product semantics.

Author: David (工作角色 测试工程师) task owner; orchestrated and verified by Lead.
Base: `origin/main` `2d0146981` (worktree `execution-retry-visual-proof-20261101`,
branch `codex/execution-retry-visual-proof-20261101`).

## What was attempted (and worked)

A deterministic, test-only injection was built under the allowed test surface, so
the failure hits the transport boundary without touching product code:

- `tests/app/dashboard-e2e/lib/retry-injection.mjs` — an attempt-aware HTTP proxy
  in front of the real RCC `127.0.0.1:4444`. It classifies a POST body as an
  execution turn (Responses wire tool names `file_search`/`file_read`) versus an
  interpretation turn (`dispatch_helper`, `accept_helper`, `interaction_propose`,
  `interaction_ask`, `interaction_approve`, `task_match`), then returns a
  one-shot HTTP 503 for the first execution turn only. The corrective attempt is
  forwarded untouched.
- `tests/app/dashboard-e2e/retry-injection-contract.test.mjs` — 3/3 pass
  (turn discrimination, non-request bodies never failed, one-shot injection plus
  real forward against a local stand-in upstream).
- `tests/app/dashboard-e2e/retry-visual-proof.mjs` — drives the real
  `local-file-search` scenario through the proxy, then looks for the
  `execution.retry` step, pages the dashboard history, captures 1280x720 and
  390x844 screenshots, and asserts the retry summary text.

The injection itself is proven to have fired. `retry-injection-record.json` from
the run:

```json
{ "upstream": "http://127.0.0.1:4444",
  "injectedCount": 1,
  "injectedPaths": ["/v1/responses"],
  "forwardedCount": 8,
  "forwardedPaths": ["/health","/health","/v1/models","/health","/v1/models","/v1/responses","/health","/v1/models"],
  "errors": [] }
```

So the first execution turn received a clean, retryable transport failure with no
tool event and no committed side effect — exactly the precondition the corrective
loop documents. The task still went straight to a blocked terminal.

## Observed result (the red evidence)

Run: `node tests/app/dashboard-e2e/retry-visual-proof.mjs`, outcome INCOMPLETE.

Full journal (`checkpoints/ui-runtime/rcc/ui-runtime-journal.jsonl`, 8 records):

```
task.created
task.created
operation.prepared
operation.started
operation.event  execution.started  running
operation.event  provider.model     dispatching   ownerId=humanagent.runtime
operation.event  provider.model     failed        ownerId=humanagent.runtime
operation.event  execution.terminal blocked       ownerId=humanagent.provider-adapter
  summary: RCC v3 returned HTTP 503: {"error":{"type":"harness_injected_retryable_failure",...}}
```

- `execution.retry` occurrences: **0**. `retrying` occurrences: **0**.
- No orchestration event precedes the failure: the attempt never entered the
  orchestrated execution lane.
- The run's own `operation.prepared` journal record proves it directly:

```json
{ "kind": "operation.prepared", "allocation": { ..., "orchestrated": false }, ... }
```

So the runtime itself committed `orchestrated: false` for this real run, before
the provider was ever reached. This is direct state evidence, not a code-reading
inference.
- Receipt evidence: `terminalRecord.state = blocked`, `toolRounds = 0`,
  `checkpointCommitted = 0`, `requestStartTurns = 0`;
  deviation `evidence_missing` (expected succeeded, ≥2 tool rounds,
  file.search / file.read calls); cleanup `unsettled-recovery-retained`.

The failure is `retryable: true` with `nextAction: "recover:humanagent.provider-adapter"`,
so the error policy itself judged the failure correctable. The retry still did not
happen, because the retry branch is not on this lane.

## Root cause: the corrective-retry branch is orchestrated-lane only

The loop added by D15 (`c75ea4de3`) lives behind a single gate.

`packages/runtime/src/ui-runtime/coordinator.ts:4811`

```ts
if (record.orchestrated && this.options.createTaskAssembly) {
```

Only that branch contains `executeProviderAttempt`, the `while (true)` attempt
loop, and the two `execution.retry` pushes (`coordinator.ts:5188` `retrying`,
`coordinator.ts:5234` `blocked`). The `else` branch at `coordinator.ts:5240`
starts the composition directly and has no retry path at all; it also explicitly
rejects retry wiring:

```ts
if (this.options.providerRetry) {
  throw new RuntimeTaskControlError('execution.retry.wiring.invalid', ...);
}
```

`record.orchestrated` comes from `operation.orchestrated`
(`coordinator.ts:2728`), which is set from `input.orchestrate === true`
(`coordinator.ts:2652`, `:2667`).

That input is produced by exactly one place:

`packages/app/src/ui-runtime/service.ts:7241`

```ts
private defaultOrchestrate(): { orchestrate?: true } {
  return !this.nativeDriverBound && this.options.runtimeComposition?.createTaskAssembly !== undefined
    ? { orchestrate: true }
    : {};
}
```

with `nativeDriverBound = executionPorts?.createDriver !== undefined`
(`service.ts:2394`).

And for the real RCC serve, the native driver is always bound:

- `packages/app/src/ui-runtime/index.ts:538` —
  `const configuredNativeLaunch = options.mode !== 'fake';`
- `packages/app/src/ui-runtime/index.ts:563` — when
  `configuredNativeLaunch`, `createExecutionPorts` is injected, and it supplies
  `createDriver: composition.createExecutionDriver`
  (`createDefaultExecutionComposition` always returns `createExecutionDriver` —
  `execution-composition.ts:471`, `:1686`).

So for `--mode rcc`: `configuredNativeLaunch = true` → `executionPorts` bound →
`nativeDriverBound = true` → `defaultOrchestrate()` returns `{}` →
`orchestrated = false` → the retry branch at `coordinator.ts:4811` never runs.

The real dashboard HTTP entry cannot override this either: the start route calls

`packages/app/src/ui-runtime/server.ts:1982`

```ts
const started = await service.startExecution(id('task', decodeURIComponent(taskExecutions[1]!)), { prompt: requirePrompt(body) });
```

with no `orchestrate` field, so the decision is entirely `defaultOrchestrate()`'s.

A repo-wide search confirms `{ orchestrate: true }` has exactly one production
producer — `service.ts:7243`; every other occurrence is a test passing
`orchestrate: true` explicitly to `startExecution`. There is no CLI flag,
environment variable or config key that forces the orchestrated lane for a real
serve.

The same exclusion is enforced a second time, independently, at the retry-cycle
wiring. `packages/app/src/ui-runtime/service.ts:2406`:

```ts
...(options.providerRetryConfig === undefined || executionPorts !== undefined
  ? {}
  : { providerRetry: { ... } }),
```

The `providerRetry` port — the retry-cycle driver factory the orchestrated loop
consumes — is deliberately **withheld whenever `executionPorts` is bound**, which
is exactly the native RCC lane. So the product wiring declines to install retry
cycle support on the native lane by design, in two separate places. This is
consistent behaviour, not an accident of one condition.

## Why the D15 red test passes but the real entry cannot

`tests/app/execution-corrective-retry.test.ts` constructs the service with
`mode: 'fake'` and `runtimeComposition: { createTaskAssembly }`, and with **no**
`createExecutionPorts` (`execution-corrective-retry.test.ts:205-212`). Therefore
`nativeDriverBound = false` → `orchestrate: true` → the retry branch runs. That
test proves the loop's internal logic; it does not prove the loop is reachable
from the real product lane, and it is not evidence of real-entry behaviour.

## Secondary gap (would remain even if the lane were forced)

`createRccServeOrchestrationPorts` (`packages/app/src/serve-orchestration.ts:266+`),
which the real serve uses (`cli.ts:1125`), returns only
`{ reviewAgent, mergeCoordinator }` — no `executionAgent`. The M3 assembly falls
back to `unboundExecutionAgent` (`serve-runtime.ts:192-206`). Only
`createDeterministicServeOrchestrationPorts` (`serve-orchestration.ts:123`)
provides an execution agent, and it is not the real RCC lane. So even an
orchestrated real serve would need a product change to bind a real execution
agent, not just an `orchestrate` flag.

## Why earlier attempts also failed (consistent, not contradictory)

`docs/evidence/execution-corrective-retry-review-rework-20261101.md` recorded the
retry step as UNVERIFIED for four reasons (tool-result side effects are not
retryable, the live RCC settle failure cannot be induced by runner options, the
fake scenario repeats the same failure, the no-tool directive never passes the
confirmation gate). This run removes the remaining uncertainty: the settle
failure *was* induced deterministically and cleanly, and the retry still did not
occur — because the lane itself is non-orchestrated.

## What closing this task actually requires (product change, not in scope)

One of the following, all in `packages/**` and therefore out of scope:

1. Move the bounded corrective retry onto the native (non-orchestrated) lane in
   `coordinator.ts`, so the retry contract holds for the real provider path.
2. Make the real RCC serve use the orchestrated lane and bind a real
   `executionAgent` for it (serve orchestration + M3 assembly), which also
   requires `defaultOrchestrate()` to stop excluding the native driver.
3. Expose an explicit, non-test-only control that selects the orchestrated lane
   for a real serve, if that is the intended product contract.

None of these is a test-surface change, so none can be delivered under this
task's allowed paths (`tests/app/dashboard-e2e/**`, `tests/app/**retry*.test.*`,
`docs/evidence/**`).

## Decision and cleanup

- No `packages/**` file was modified. `git status` shows only the three new test
  files listed above plus this evidence document.
- The candidate test assets are not submitted as satisfying the retry-step
  requirement; the injection harness is sound and reusable, but the product lane
  cannot reach the branch it was built to observe.
- The worktree returns to `master` (`2d0146981`) with this evidence attached, per
  the task contract for an unavoidable product change.

## Verification run results

- `node tests/app/dashboard-e2e/retry-injection-contract.test.mjs` — PASS 3/3.
- `npx tsc -p tests/app/tsconfig.json --noEmit` — PASS (exit 0).
- `node tests/app/dashboard-e2e/runner-contract.test.mjs` — 64/65, test
  `cancel identity failures retain recovery and issue zero stop POSTs` FAILS
  (assert `ambiguous must not issue a stop POST`, 1 !== 0). This is
  **pre-existing on clean master**: the same test fails identically when run
  alone from the main worktree (`/Volumes/extension/code/humanagent`, HEAD
  `2d0146981`, which contains none of the files added here). It is not caused by
  this task and is a separate master defect, reported to the board alongside the
  blocked finding.

## Residual risk / notes

- The injection proxy classifies turns by tool-name markers. If a future run's
  first execution turn carried no tool markers, the proxy would forward it and
  `injectedCount` would be 0; `retry-visual-proof.mjs` fails non-zero on that
  condition rather than reporting a false pass, so the harness cannot silently
  degrade.
- `HUMANAGENT_RCC_BASE_URL` must point at the proxy for both `probeProvider` and
  the spawned serve; the runner honours this and the record file proves the
  upstream was the real `127.0.0.1:4444`.
