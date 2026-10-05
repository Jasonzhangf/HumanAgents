# Durable occurrence consumer — author verification (2026-10-05)

Status: **AUTHOR VERIFICATION — candidate handed to parent for independent review
and composition.** This is not a self-review, not a merge, and not an
independent PASS.

This document was extended by the corrective pass
`durable-occurrence-consumer-failure-correction-20261005`; see
[Corrective pass](#corrective-pass-real-execution-failure-and-exception-path-cleanup).
The RCC section now reflects the corrected three-case harness.

## Identity and inputs

- task/worker: `durable-occurrence-consumer-completion-20261005`
- cwd: `/Volumes/Intel/playground/humanagent/interaction-durable-consumer-correction-20261005`
- branch: `codex/interaction-durable-consumer-correction-20261005`
- clean input HEAD: `5d14d3df557e0253279baad55a357634d7968e4b`
- admitted inputs already in history: fresh `origin/main` `22d8268`, admitted G
  `16c4d19` (`22d8268` is an ancestor of the input HEAD; ordinary merge, exit 0).
- candidate: the commit that adds this document on top of the input HEAD.
- record root:
  `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/durable-occurrence-consumer-completion-20261005`

## Changed files

- `packages/runtime/src/subscriptions/ports.ts` — minimal public
  `ServeTaskConsumerPort` / `OccurrenceClaimRecord` typed boundary.
- `packages/app/src/ui-runtime/occurrence-consumer.ts` — the single app-owned
  durable consumer implementation.
- `tests/app/durable-occurrence-consumer-public.test.ts` — public real-disk /
  real-process acceptance harness (10 tests).
- `tests/app/durable-occurrence-consumer-rcc-e2e.mjs` — real RCC 4444 provider
  consumer acceptance (success + real execution failure + real stop).

## Owner and contract decisions

- Authoritative binding is derived from the persisted `OccurrenceClaimRecord`
  (claim + policy); the requested binding is derived from the `Occurrence`.
  Both are passed to core `decideOccurrenceAuthority`, so a caller self-reported
  binding is never reused as authority.
- `SupervisorLease.withCurrentDaemonOwner` is the only caller authentication.
  Admission, terminal, and recovery Journal mutations all happen inside that
  guard. Public record/claim/PID/log fields are never treated as authority.
- Domain decisions reuse core `decideOccurrenceAuthority` and
  `decideOccurrenceTerminalReceipt`; the consumer adds no second registry,
  lease, token, or store.
- Persistence uses the real `JsonlOrganJournal` and `FileCheckpointStore` on the
  same task-cycle file. The receipt key is only
  `occurrenceTerminalReceiptCommitId(binding)`; result/release proofs stay inside
  the committed fact, so a different receipt fact under the same key is rejected
  by `JournalCommitConflictError`.
- Checkpoint is lifecycle truth and the typed receipt is the verification fact.
  The checkpoint commits first; a crash between the two leaves a visible
  recovery-pending window and never returns verified success.

## Author commands (real exits)

Raw outputs: record root `raw/`.

| command | exit | evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | run once to populate `node_modules`; not captured as raw (`node_modules` is the observable proof) |
| `pnpm exec tsc -p packages/contracts/tsconfig.json` | 0 | `raw/contracts.{stdout,stderr,exit}` |
| `pnpm exec tsc -p tests/app/tsconfig.json` | 0 | `raw/compiler.{stdout,stderr,exit}` |
| `node --test dist/tests/tests/app/durable-occurrence-consumer-public.test.js` | 0 | `raw/public-test.*` — TAP `1..10`, `# pass 10`, `# fail 0` |
| `node tests/app/durable-occurrence-consumer-rcc-e2e.mjs` | 0 | `raw/rcc-e2e.*` |
| `pnpm typecheck` | 0 | `raw/typecheck.{stdout,stderr,exit}` |
| `git diff --check` | 0 | no output |

The corrective pass reran the affected commands from this tree; raw exits are in
the corrective record root (see
[Corrective pass](#corrective-pass-real-execution-failure-and-exception-path-cleanup)).

## Public black-box coverage (`tests/app/durable-occurrence-consumer-public.test.ts`)

Real consumer entry, real on-disk `JsonlOrganJournal` / `FileCheckpointStore`,
real `SupervisorLease`, real OS child processes, and a real file side effect. No
private-map or source-string assertions.

1. First admission dispatches exactly once and commits one paired checkpoint +
   typed receipt with the admitted owner bound to the live lease.
2. A mismatched requested occurrence cannot mutate or dispatch against the
   authoritative claim.
3. Replay on the same port, a new port, and a new OS process never dispatches
   again; the replayed receipt equals the committed receipt.
4. Admission append failure leaves no admission record and dispatches zero
   times.
5. Receipt append failure stays `durable-unverified-recovery-pending`; the
   checkpoint is committed, no receipt is committed, and success is never
   returned.
6. A different receipt fact under the same binding key is rejected by
   `JournalCommitConflictError`; the first record is preserved and replay still
   returns it.
7. A second process cannot turn copied readable owner fields into authority and
   writes nothing.
8. A crashed owner is replaced and the committed replacement writes one blocked
   recovery receipt without redispatch or rebind.
9. Live stale A after a committed replacement cannot write; B recovers without
   rebind or dispatch.
10. Success, failed, rejected, missing, blocked, and cancelled terminals each
    persist a paired receipt; non-success terminals carry a recovery inventory.

## Real RCC 4444 provider evidence (`tests/app/durable-occurrence-consumer-rcc-e2e.mjs`)

The harness drives the public consumer over the existing provider/business seam
(`buildRccExecutionPort` = `ProviderAdapter` + `V3ProviderHttpTransport`, driven
by the real `ProviderAgentDriver`) against the live RCC endpoint. Provider
evidence is projected onto the consumer task scope with the same re-scope pattern
the serve orchestration seam uses; source/locator/digest are preserved.

The harness runs three independent cases. The failure case declares the real
`file.read` tool through `createResponsesFileToolExecutor`; the prompt asks the
model to read the directory `adir`, so the real executor returns
`EISDIR: illegal operation on a directory, read`. No provider, transport,
dispatch port, or settlement is mocked. Values below are from the corrective
pass; raw report and per-case evidence are in the corrective record root.

- RCC health: `GET http://127.0.0.1:4444/health` → HTTP 200, `status=ok`,
  `build_version=0.90.4832` (liveness only, not business acceptance).
- success case (`model=gpt-5.5`): provider settlement `succeeded` → receipt
  `status=success`, `terminalOutcome=succeeded`, checkpoint outcome `succeeded`;
  `admissionCount=1`, `checkpointCount=1`, `receiptCount=1`, real provider
  evidence artifacts on disk.
- failure case (`model=gpt-5.5`): the real provider tool round fails with
  `EISDIR: illegal operation on a directory, read`; receipt `status=failed`,
  `terminalOutcome=failed`, checkpoint outcome `failed`, checkpoint summary
  `tool.result.failure: EISDIR: illegal operation on a directory, read`; the
  failed verification check binds the original provider tool-error evidence
  (`observe-tool.result.failure`); `recoveryResponsibility.providerEffectState=possible`
  with a non-empty evidence inventory; `admissionCount=1`, `checkpointCount=1`,
  `receiptCount=1`.
- stop case: the live RCC stream is requested to stop and then settled; provider
  settlement `cancelled` → receipt `status=cancelled`, `terminalOutcome=cancelled`,
  checkpoint outcome `cancelled`; `admissionCount=1`, `checkpointCount=1`,
  `receiptCount=1`. The stop case is asserted separately and never counts as
  failure evidence.
- every case releases its own lease, deletes its own fixture root, and asserts
  physical absence; the same cleanup runs on an exception path.

Note: the live RCC endpoint routes an unknown model to a default model and
returns 200, so an unknown model is not a real failure. The non-success path is
therefore a real provider tool failure for the failed path, plus a real
stop/settle terminal for the separate cancel path.

## Cleanup and resource ownership

- The harness removes its own temp fixture roots and asserts absence.
- No daemon install, restart, or lifecycle action was taken; no merge or push
  was performed.
- The candidate worktree, build output, and raw evidence are retained for
  parent review and composition.

## Not claimed

- No independent architecture review, no merge, no push, no scheduler
  integration, no installed runtime, and no formal UI/browser acceptance.
- Provider auto-resume is still unsupported; replacement recovery writes a
  blocked recovery receipt, not a resumed execution.

## Corrective pass: real execution failure and exception-path cleanup

This pass closes the parent admission gaps
(`durable-consumer-business-admission-20261005.md`).

- task/worker: `durable-occurrence-consumer-failure-correction-20261005`
- cwd: `/Volumes/Intel/playground/humanagent/interaction-durable-consumer-failure-correction-20261005`
- branch: `codex/interaction-durable-consumer-failure-correction-20261005`
- base candidate HEAD: `b257c05447e15eb9ac2a5145ce9f6c0132234fac`
- inputs in history: fresh `origin/main` `22d8268`, admitted G `16c4d19`
- record root:
  `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/durable-occurrence-consumer-failure-correction-20261005`

### Defects closed

1. The case named `failure` passed `stopAfterFirstEvent: true` and asserted only
   `status != 'success'`. It is replaced by a real provider execution failure;
   operator stop is now a separate `stop` case.
2. `lease.release()` failures were swallowed by `.catch(() => undefined)`. The
   lease is now always released in a `finally`, and a release failure propagates.
3. Fixture cleanup only ran after both cases returned. Roots are now registered
   when allocated and removed in a single outer `finally`, so an exception in
   one case cannot leak any case's root.
4. The non-success status was derived from `settlement.state` alone. The harness
   now detects a real provider execution failure from the driver error / tool
   result event and maps it to `verification.status='failed'`.

### Failure wiring (real seam only)

- Provider seam: `buildRccExecutionPort(binding, routeRef, baseUrl, evidenceRoot)`
  returns a real `ExecutionRuntimePort`; the real `ProviderAgentDriver` drives
  `start/submit/observe/requestStop/settle/settlement`.
- The failure case declares `RESPONSES_FILE_READ_TOOL` and passes
  `createResponsesFileToolExecutor(...).executor` as the driver's `executeTool`.
  The prompt asks the model to read the directory `adir`; the real executor
  surfaces `EISDIR: illegal operation on a directory, read`.
- The driver event carries the typed provider error at `event.providerEvent.error`;
  the harness reads it there so the receipt keeps the original tool error
  (`tool.result.failure`) instead of the derived settlement code
  (`capability.continuation-unavailable`).
- Because the observed Responses stream ends on a `waiting` tool-call terminal,
  `V3ProviderHttpTransport.settle` returns `blocked` with a derived
  continuation-unavailable error. The harness keeps that as an effect/evidence
  fact but sets the verification status from the real execution failure, then
  sets `recoveryResponsibility.providerEffectState='possible'` with the real
  evidence inventory; core `decideOccurrenceTerminalReceipt` then persists a
  `failed` terminal receipt. No core, contracts, provider adapter, or
  supervisor file was changed and no compensation path was added.

A fixture detail: the OS temp root under `/var/folders` resolves through a
symlink (`/var` -> `/private/var`), and the real `file.read` route rejects a
workspace root that resolves through a symlink. The harness calls `realpath` on
its `mkdtemp` root so the bound workspace root is canonical. This is a
test-fixture fix; the symlink rejection is the route's documented behavior.

### Corrective commands (real exits)

Raw outputs in the corrective record root `raw/`.

| command | exit | evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | populated `node_modules` (no raw byte capture) |
| `pnpm exec tsc -p packages/contracts/tsconfig.json` | 0 | `raw/contracts.{stdout,stderr,exit}` |
| `pnpm exec tsc -p tests/app/tsconfig.json` | 0 | `raw/compiler.{stdout,stderr,exit}` |
| `node --test dist/tests/tests/app/durable-occurrence-consumer-public.test.js` | 0 | `raw/public-test.*` — TAP `1..10`, `# pass 10`, `# fail 0` |
| `node tests/app/durable-occurrence-consumer-rcc-e2e.mjs` | 0 | `raw/rcc-e2e.*`, `raw/rcc-e2e-{success,failure,stop}.json`, `raw/rcc-e2e-cleanup.json` |
| `HUMANAGENT_RCC_E2E_INJECT_FAILURE=failure node tests/app/durable-occurrence-consumer-rcc-e2e.mjs` | 1 (expected) | `raw/rcc-e2e-exception.*` — injected throw after the failure fixture root was allocated; `raw/rcc-e2e-cleanup-exception.json` shows both allocated roots absent |
| `pnpm typecheck` | 0 | `raw/typecheck.{stdout,stderr,exit}` |
| `git diff --check` | 0 | `raw/diff-check.{stdout,stderr,exit}` |

### Corrective evidence summary

- success: `status=success`, `terminalOutcome=succeeded`, checkpoint
  `succeeded`, `admission/checkpoint/receipt=1/1/1`, real provider evidence
  files present.
- failure: `status=failed`, `terminalOutcome=failed`, checkpoint `failed`,
  checkpoint summary `tool.result.failure: EISDIR: illegal operation on a
  directory, read`, failed check binds `observe-tool.result.failure`,
  `recoveryResponsibility.providerEffectState=possible` with a non-empty
  inventory, `admission/checkpoint/receipt=1/1/1`.
- stop: `status=cancelled`, `terminalOutcome=cancelled`, checkpoint `cancelled`,
  `admission/checkpoint/receipt=1/1/1`; asserted separately from failure.
- cleanup: `raw/rcc-e2e-cleanup.json` shows each allocated case root
  `absent: true`, `failureCount: 0`, `allAbsent: true` on the normal path, and
  `raw/rcc-e2e-cleanup-exception.json` shows the injected-exception run also
  removed all allocated roots.

### Corrective pass not claimed

- No independent review; no merge, push, or scheduler integration.
- The success, failure, and stop cases each exercise a live RCC round; the model
  decides whether to call `file.read`, so the failure case is retried a bounded
  number of times and never accepted as a pass if the path was not exercised.
