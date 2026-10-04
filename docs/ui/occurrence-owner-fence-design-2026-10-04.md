# Occurrence execution-owner and fenced-commit bounded design

Status: **PRE-CODE DESIGN FOUNDATION / BLOCKED capability**.

This is a docs-only design contract. It does not prove source, runtime, provider,
browser, or lifecycle behavior. It is the single owner-binding/guard contract for
the bounded occurrence owner fence. The consumer design
`docs/ui/durable-occurrence-consumer-design-2026-10-04.md` references this
document and does not duplicate it.

## 1. Goal

Close the minimum missing boundary between an admitted occurrence and its
execution owner:

1. Bind an admitted occurrence to the existing app supervisor owner.
2. Define recovery authority for a plausible re-entrant execution.
3. Fence admission, terminal, and recovery Journal mutation through a legal
   concurrent supervisor handoff.
4. Keep the existing occurrence/task/operation/executionEpoch/inputArtifactDigest
   and receipt lookup identity unchanged.

The target is a typed domain contract plus the app adapter wiring. We do not
invent a second lease, a second controller, death detection, or a second
execution registry.

## 2. Baseline identities

Read-only inputs used:

- Main source: `0020ab4f4442ea59bf4b9fc02416a8a77c6c68ed`.
- Frozen consumer candidate: `3ee0a362dcc5a18fe6efa21d818848cfdabf1d0e`.
- Frozen scheduler source: `45a6110ef474114b2c2aff114006c88718e16632`.
- Partial reminder source: `e78b368bcf8af1802eb6b9f56d019f36ffc991e9`.
- Retained W3 design/source evidence: `3a3dbcd5a35dbde4f8928305238f874fcf7cf1cf`.

## 3. Existing owners

The existing typed owners do not change:

- Scheduler/core owns occurrence claim and occurrence lifecycle.
- Runtime owns scheduling, checkpoint orchestration, window assembly, and
  recovery flow.
- App assembly and app supervisor own process start/death and daemon lease.
- App `ServeTaskConsumerPort` adapter owns execution/checkpoint/receipt.
- Jsonl Organ Journal is the authoritative Journal.

The current gap is the missing typed edge from the occurrence claim to the
app supervisor owner inside the app consumer adapter.

The app assembly already has the active `SupervisorLease` at the `hm serve`
startup boundary (`packages/app/src/cli.ts`). The future app adapter can inject
that existing lease handle or a supervisor-owned authority function into the
consumer. It must not copy a lease snapshot into a second mutable store.

## 4. Existing primitives

The following primitives already exist. They are the only primitives this design
can use:

| Primitive | Location | Behavior |
| --- | --- | --- |
| `OccurrenceClaim` | frozen `packages/contracts/src/framework.ts` | persisted claim identity and scheduler lease fields |
| `validateOccurrenceClaim` | frozen `packages/contracts/src/framework.ts` | validates claim identity and time only |
| `assertOccurrenceClaimFence`/`assertOccurrenceClaimLease` | frozen `packages/core/src/subscription.ts` | checks subscription identity and lease expiry only |
| `consumeExecution` | frozen `packages/runtime/src/subscriptions/index.ts` | byte-equality claim check, settlement replay, lease check, then `ServeTaskConsumerPort.executeOccurrence` |
| `SupervisorLeaseRecord` | `packages/app/src/supervisor/supervisor.ts:35` | `leaseId`, `generation`, `pid`, `processStartToken`, `ownerId`, `acquiredAt`, `disposedAt` |
| `assertLeaseActive` | `packages/app/src/supervisor/supervisor.ts:508` | rejects after replacement/disposal |
| `acquireDaemonLease` | `packages/app/src/supervisor/supervisor.ts:578` | creates replacement generation on takeover |
| `isDaemonLeaseHandoffCommitted` | `packages/app/src/supervisor/supervisor.ts:654` | confirms a different durable live replacement owner |
| `withDaemonLeaseGuard` | `packages/app/src/supervisor/supervisor.ts:290` | serializes daemon lease transitions around an app-owned mutation; it does not by itself expose a typed current-owner decision |
| `SupervisorLease.assertActive` | `packages/app/src/supervisor/supervisor.ts:68` | refreshes and validates the active lease through the existing supervisor owner |
| `JsonlOrganJournal.transaction` | `packages/adapters/jsonl/src/index.ts:440` | acquires per-Journal lock, reads verified content, applies `appendLocked` |
| `JournalCommitConflictError` | `packages/adapters/jsonl/src/index.ts:77` | rejects same commitId with different commit-fact digest |
| `SessionStore.withWriteLock` pattern | `packages/app/src/session-store.ts:252` | holds `withDaemonLeaseGuard`, re-reads active fence, writes, releases |

These primitives are real. They do not yet form a demonstrated occurrence
fence because the occurrence claim has no execution-owner fields, no existing
caller combines the app supervisor authority with occurrence mutation, and
`withDaemonLeaseGuard` does not expose an atomic "compare current owner, then
append" result. The guard prevents a lease transition while the callback runs.
The callback must still re-read and validate the current owner inside the same
scope.

## 5. Missing boundary

The missing boundary has two parts:

1. `OccurrenceClaim` has no typed execution-owner identity. It has scheduler
   claim identity plus `leaseId`, `generation`, and `executionEpoch`, but those
   are scheduler claim values. They do not bind `consumeExecution` to the app
   supervisor owner.
2. No existing caller calls `ServeTaskConsumerPort` with a daemon-lease owner
   and then fenced Journal mutation. `consumeExecution` only checks persisted
   claim equality and lease expiry before dispatch.
3. Existing `withDaemonLeaseGuard` serializes the lease transition, but it does
   not return a typed owner decision or bind that decision to the Journal append.
   A raw snapshot from `readDaemonLease` before the guard is not a fence.

The minimal future app supervisor extension is one public, typed authority
operation. Its exact implementation name is a source decision, but its public
shape must be equivalent to:

```text
withCurrentDaemonOwner(paths, executionOwner, operation) -> Promise<T>
```

The operation must:

1. enter the existing `withDaemonLeaseGuard(paths, ...)` scope;
2. re-read the durable lease through the existing `readDaemonLease(paths)`;
3. reject missing, disposed, replaced, or mismatched
   `daemonLeaseId`/`daemonGeneration`/`processStartToken`;
4. pass only the supervisor-verified current owner facts to the callback;
5. keep the callback inside the same guard scope;
6. release the guard in `finally` after the callback settles.

This is an extension of the existing supervisor authority. It is not a second
registry, lease, controller, or token. Until this callable public operation
exists, the admission/terminal/recovery fence is **BLOCKED**, and a proposed
query or raw lease snapshot is not an atomic guarantee.

Because Provider/RCC resume is unsupported, transport abort is not resource
release, and terminal absence is not interruption, the missing binding cannot
be closed by timeout, PID probe, local maps, logs, or an invented death
detector.

## 6. Domain-owned typed binding

Add fields to the existing `OccurrenceClaim` or to an adjacent validated domain
record. The app adapter translates `SupervisorLeaseRecord`. Core validates the
domain fields only and never imports `SupervisorLeaseRecord`.

Proposed domain fields:

```text
executionOwner: {
  daemonLeaseId: string
  daemonGeneration: number
  processStartToken: string
}
```

Rules:

- Keep existing `claimedBy`, `schedulerInstanceId`, claim `leaseId`, claim
  `generation`, and `executionEpoch`.
- Do not replace the existing `OccurrenceClaim`.
- Do not promote `pid`, RCC route/model/session, or DSH identity as task
  identity.
- Do not put credentials or provider config in the domain binding.
- Preserve `OccurrenceTaskBinding` receipt lookup identity unchanged:
  `occurrenceId`, `subscriptionId`, `scheduleRevision`, `occurrenceOrdinal`,
  `taskId`, `operationId`, `executionEpoch`, `inputArtifactDigest`.

## 7. State and authority outcomes

The future core validator returns typed outcomes. The table is the contract:

| Case | Observable facts | Result |
| --- | --- | --- |
| No admission | no admission record and current owner available | admit once |
| current live owner | current caller holds the active supervisor lease; `SupervisorLease.assertActive()` passes; domain `daemonLeaseId`/`daemonGeneration`/`processStartToken` match the current lease | allow mutation; same bindings only |
| concurrent B / live unproven | persisted claim equals admitted owner, claim unexpired, B cannot prove A is dead or fenced | typed `owner-live-unproven`/`in-progress`; no dispatch, no recovery, no terminal |
| expired claim | claim lease expired | typed `lease-expired`; no recovery from expiry alone |
| confirmed fenced handoff | current lease is a different live durable lease from A, and `isDaemonLeaseHandoffCommitted(paths, previous)` is true under the existing supervisor authority | replacement B may write one blocked/recovery terminal; never redispatches |
| stale A after handoff | A holds old domain owner; current lease has new `daemonLeaseId`/`daemonGeneration`/`processStartToken` | reject terminal/recovery mutation |
| stale A without handoff | A holds old domain owner; current lease still A; caller is not the verified active owner | reject unless confirmed replacement authority |
| external effects uncertain | provider/tool/browser/port release proof absent | preserve `providerEffectState: 'possible'` and resource inventory |

Do not treat any of these as sufficient for external release:

- terminal absent
- lease timeout
- PID dead
- local map empty
- logs silent

## 8. Fenced Journal mutation

All occurrence admission, terminal, and recovery mutations need the same guard
scope. The app adapter that implements `ServeTaskConsumerPort` uses this order:

```text
withCurrentDaemonOwner(paths, domainExecutionOwner, async (verifiedOwner) => {
  validate persisted occurrence claim vs caller claim
  return journal.transaction(read, apply)
})
```

The code must not read the lease once and then append later without the guard.
The existing `withDaemonLeaseGuard` and `readDaemonLease` primitives are the
implementation basis. The `SessionStore.withWriteLock` pattern also demonstrates
the accepted scope: hold the daemon guard, re-read the active fence, write, and
release.

Why this closes the race:

- `withCurrentDaemonOwner` enters the existing daemon lease transition guard.
- It re-reads the current lease inside that guard and compares the domain owner.
- The Journal transaction acquires the Journal lock and appends inside the
  same guard scope.
- Validation-to-append overlap with handoff is impossible if the guard is held
  for the whole mutation.
- A stale A that holds the guard after handoff reads the new lease and
  fails the owner match.

This operation is the **minimum missing primitive**. If a future implementation
cannot keep the daemon guard and Journal transaction in the same scope, the
required primitive is not ready. A proposed query or token outside that scope
is not an atomic guarantee.

## 9. Journal records

The consumer design `docs/ui/durable-occurrence-consumer-design-2026-10-04.md`
keeps the receipt-key and replay contract. This document adds the fence rule:

- `Kind: occurrence-execution-admission`
- `Kind: occurrence-terminal-receipt`
- Deterministic `commitId` derived only from the immutable binding.
- Same `commitId` and same digest returns existing record.
- Same `commitId` and different digest throws `JournalCommitConflictError`.
- Checkpoint-only without receipt is `durable-unverified-recovery-pending`.
- Admission-only without terminal is not auto-redispatch. It is
  live/unproven/fenced according to Section 7.

## 10. Graph and reconciliation

The `serve-task` graph keeps both revisions' real nodes:

- Retained W3 source/recovery, policy, verification, and settlement nodes.
- Consumer `durable_consume` and `receipt_commit`.

The graph is one SESE path. It does not imply runtime execution. Bindings mark
`implementationStatus: pending` and `status: pending-w3v/w3-app` where source is
not yet merged.

## 11. Future source task dependency order

Do not start these source tasks without root's independent pre-code admission.

Order:

```text
contracts/core owner binding + typed states
  -> app supervisor typed withCurrentDaemonOwner + adapter fenced mutation
  -> consumer/scheduler integration with receipt/replay
  -> public two-process proof
```

Allowed paths:

| Task | Allowed paths |
| --- | --- |
| core authority | `packages/contracts/src/framework.ts`, `packages/core/src/subscription.ts` |
| app supervisor/adapter | `packages/app/src/supervisor/*` for the typed `withCurrentDaemonOwner` operation and exports; `packages/app/src/ui-runtime/*` for the consumer adapter |
| consumer/scheduler integration | `packages/runtime/src/ui-runtime/task-verification.ts` composition, `packages/runtime/src/subscriptions/index.ts`, `packages/app/src/ui-runtime/journal.ts`, `packages/runtime/src/ui-runtime/coordinator.ts` |
| tests | `tests/app/supervisor/supervisor.test.ts` pattern, `tests/runtime/subscriptions/public-consumer.test.ts` pattern |

No task owns another task's files. No task starts a second lease or second
terminal store.

## 12. Public proof design

Use real public entrypoints and real persisted Journal/checkpoint state. Use two
real OS processes for cases that need process death or handoff.

The public interface must bind claimed control facts to the authoritative lease.
It must not accept a harness-injected success flag, fake counter, PID query, or
log-derived value as owner proof.

The existing supervisor test `tests/app/supervisor/supervisor.test.ts` already
has these reusable patterns:

- `fixture()` creates a controlled system root with `resolveRuntimePaths` and
  `ensureControlLayout`.
- `startLeaseChild` starts a real child process with its own daemon lease and
  optional identity server.
- `real child-process crash leaves a stale owner that cannot commit after
  takeover` proves stale writes fail after takeover.

The frozen scheduler public test
`tests/runtime/subscriptions/public-consumer.test.ts` has the real
`SubscriptionControlPort` + `JsonlOrganJournal` harness shape.

Target commands after source admission:

```sh
pnpm exec tsc -p tests/app/tsconfig.json
node --test dist/tests/tests/app/supervisor/supervisor.test.js
pnpm exec tsc -p tests/runtime/tsconfig.json
node --test dist/tests-runtime/tests/runtime/subscriptions/public-consumer.test.js
```

The scheduler public test path is frozen evidence, not a file in current
canonical `main`. The exact runtime compile path and output directory must be
confirmed against the project test build during implementation. Do not claim
these commands as current evidence.

Required public assertions:

1. Same-process success: one admission, one dispatch, same receipt replay.
2. Two-process A/B before terminal: B returns typed `in-progress` or
   `owner-live-unproven`; B writes no terminal/recovery/dispatch.
3. Crash after admission: replacement daemon lease B with new generation and
   token is durable; B writes exactly one blocked/recovery terminal and does
   not redispatch.
4. stale A terminal/recovery after replacement is rejected even after A holds
   the daemon guard and then reads the new lease.
5. Same receipt key: second receipt with same binding and different evidence
   throws `JournalCommitConflictError`.
6. External effects: no confirmed release without provider/tool/browser/port
   stop/settlement proof.
7. Cleanup: only this task's fixture roots are removed.

Fake counters are RED/control evidence only. They cannot be GREEN.

The future fixture must use the existing supervisor child-process pattern:
`fixture()`, `ensureControlLayout`, and `startLeaseChild`-equivalent real child
processes. The fixture must create its own `RuntimePaths` root. The test must
remove that root after the assertions and verify physical absence.

## 13. Blocked facts

- The occurrence owner binding and fenced mutation are not implemented.
- `consumeExecution` still lacks the app supervisor authority.
- The public `withCurrentDaemonOwner`-equivalent supervisor operation is missing.
- No current caller combines supervisor owner validation with occurrence
  Journal mutation in one guard scope.
- Current canonical `main` does not contain the frozen scheduler source files.
- Provider/RCC resume is unsupported.
- Transport abort is not external-effect release.
- Provider/tool/browser/port effect release is not proved by process death or a
  stale lease fence.
- Scheduler source R5 cap and installed design R6 cap exception remain open.
- This document is not source review or implementation admission.
