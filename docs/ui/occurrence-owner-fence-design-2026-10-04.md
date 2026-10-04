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
2. Define recovery authority for a plausible re-entrant execution. The design
   keeps two distinct identities: immutable admitted owner A and the
   supervisor-authenticated current caller B.
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

`SupervisorLease` is the actual local authority handle for the running process:
`createLease()` closes over the lease record created by `acquireDaemonLease()`,
and `assertActive()` re-reads the durable record under the same supervisor
authority. A persisted `SupervisorLeaseRecord`, including its readable
`leaseId`, `generation`, and `processStartToken`, is evidence of a lease, not
proof that the caller controls that lease. The future guard must use the
injected live lease handle for caller authentication. It must not treat a
caller-supplied copy of those fields as authority.

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
| `assertLeaseActive` | `packages/app/src/supervisor/supervisor.ts:508` | compares an already-held lease record with the durable record and rejects after replacement/disposal; by itself it does not authenticate a caller |
| `acquireDaemonLease` | `packages/app/src/supervisor/supervisor.ts:578` | creates replacement generation on takeover and returns the local `SupervisorLease` handle |
| `isDaemonLeaseHandoffCommitted` | `packages/app/src/supervisor/supervisor.ts:654` | confirms a different durable live replacement owner with a higher generation; this is the committed-handoff predicate |
| `withDaemonLeaseGuard` | `packages/app/src/supervisor/supervisor.ts:290` | serializes daemon lease transitions around an app-owned mutation; it does not by itself expose a typed current-owner decision |
| `SupervisorLease.assertActive` | `packages/app/src/supervisor/supervisor.ts:68` | refreshes and validates the active lease through the existing supervisor owner |
| `JsonlOrganJournal.transaction` | `packages/adapters/jsonl/src/index.ts:440` | acquires per-Journal lock, reads verified content, applies `appendLocked` |
| `JournalCommitConflictError` | `packages/adapters/jsonl/src/index.ts:77` | rejects same commitId with different commit-fact digest |
| `SessionStore.withWriteLock` pattern | `packages/app/src/session-store.ts:252` | holds `withDaemonLeaseGuard`, re-reads active fence, writes, releases |
| `SupervisorLeaseRecord.takeover` | `packages/app/src/supervisor/supervisor.ts:54` | durable `previousLeaseId`/`previousGeneration` evidence emitted by the existing takeover path |

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
2. No existing caller supplies the process's acquired local lease authority when
   it calls `ServeTaskConsumerPort` and fenced Journal mutation.
   `consumeExecution` only checks persisted claim equality and lease expiry
   before dispatch.
3. Existing `withDaemonLeaseGuard` serializes the lease transition, but it does
   not return a typed owner decision or bind that decision to the Journal append.
   A raw snapshot from `readDaemonLease` before the guard is not a fence.

The minimal future app supervisor extension is one public, typed authority
operation. Its exact implementation name is a source decision, but its public
shape must be equivalent to:

```text
withCurrentDaemonOwner(paths, binding, operation) -> Promise<T>
```

The operation must:

1. enter the existing `withDaemonLeaseGuard(paths, ...)` scope;
2. authenticate the local caller by calling the injected
   `SupervisorLease.assertActive()`;
3. re-read the durable lease and require the authenticated local lease record to
   match the durable current record, including disposed-state;
4. pass only the supervisor-authenticated current caller and a
   supervisor-owned replacement predicate into the callback; do not accept a
   caller-supplied admitted owner from the operation arguments;
5. keep the callback inside the same guard scope;
6. release the guard in `finally` after the callback settles.

The callback reads the real admission by the immutable `binding` inside the
Journal transaction. On an existing admission, that read supplies immutable
owner A. The callback then uses the supervisor-owned predicate to decide
whether authenticated current caller B is a committed replacement for A. A is
never an input supplied by the caller.

The first invocation has no admission to read. Inside the same outer daemon
guard and Journal transaction, it validates the complete immutable binding
against the actual authoritative input. Only after that validation passes does
it derive the initial admitted owner from the supervisor-authenticated current
caller, persist that owner with the unique admission, and permit the single
dispatch authorized by that admission. It must not dereference an absent
admission, precreate unfenced ownership, accept caller-readable identity as
authority, or introduce a second store or lease. Existing A applies only to
later mutations.

This is an extension of the existing supervisor authority. It is not a second
registry, lease, controller, or token. Until this callable public operation
exists, the admission/terminal/recovery fence is **BLOCKED**, and a proposed
query or raw lease snapshot is not an atomic guarantee.

The caller identity must never be accepted from the callback argument,
persisted claim, request payload, log, or harness. A caller that only supplies
A's readable fields, or copies B's readable fields, must fail authentication
even when those fields match the durable lease.

Because Provider/RCC resume is unsupported, transport abort is not resource
release, and terminal absence is not interruption, the missing binding cannot
be closed by timeout, PID probe, local maps, logs, or an invented death
detector. The persisted `takeover` relation proves only that a replacement was
committed. It does not prove that an old caller is dead, so recovery still
requires the authenticated current caller and the ordinary live-owner checks.

## 6. Domain-owned typed binding

Add fields to the existing `OccurrenceClaim` or to an adjacent validated domain
record. The app adapter translates `SupervisorLeaseRecord`. Core validates the
domain fields only and never imports `SupervisorLeaseRecord`.

Proposed immutable domain field on the admission record:

```text
admittedExecutionOwner: {
  daemonLeaseId: string
  daemonGeneration: number
  processStartToken: string
}
```

Rules:

- `admittedExecutionOwner` is an immutable occurrence binding. It identifies
  the owner that admitted the occurrence. It is not a bearer token and it is
  not evidence that the current caller owns the lease.
- The separate authenticated caller identity is supplied by the supervisor
  guard at execution time. It is not persisted into the occurrence claim as a
  replacement for A.
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
| No admission | no admission record; complete immutable binding validates against the actual authoritative input; current caller is supervisor-authenticated | derive initial admitted owner only from the authenticated caller; append owner plus the unique admission; permit exactly one dispatch |
| current live owner | the guard's injected `SupervisorLease.assertActive()` passes and its local record matches the durable current lease; immutable A equals the current authenticated caller | allow normal mutation; same bindings only |
| concurrent B / live unproven | persisted claim equals admitted owner, claim unexpired, B cannot prove A is dead or fenced | typed `owner-live-unproven`/`in-progress`; no dispatch, no recovery, no terminal |
| expired claim | claim lease expired | typed `lease-expired`; no recovery from expiry alone |
| confirmed fenced handoff | the guard authenticates current caller B locally; `isDaemonLeaseHandoffCommitted(paths, A)` is true under the same daemon guard, proving the durable current lease is live, distinct from A, and at a higher generation | B may write one blocked/recovery checkpoint/receipt for A's immutable admission; never redispatch or rebind A |
| stale A after handoff | A presents A's old admitted identity or copies B's readable fields; the guard authenticates A's local lease handle and it is not the durable current lease | reject terminal/recovery mutation; no user-supplied readable B fields can pass |
| stale A without handoff | A holds old domain owner; current lease still A; caller is not the verified active owner | reject unless B is authenticated and a committed monotonic replacement from A is proved |
| replacement with uncertain/expired claim | current caller B is authenticated, but A's claim is still live/uncertain or expired without a committed replacement | typed unique-owner pending/expired rejection; no recovery append, no redispatch |
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
withCurrentDaemonOwner(paths, binding, async (currentCaller, proveReplacement) => {
  // currentCaller is supervisor-authenticated by the injected local lease.
  return journal.transaction(async ({ records }) => {
    const requested = validateAuthoritativeBinding(records, binding)
    const admission = readAdmission(records, binding)
    if (admission === undefined) {
      return createInitialAdmission(requested, currentCaller)
    }
    return decideExistingAdmission(admission, currentCaller, proveReplacement)
  }, async (decision, append) => {
    if (decision.kind !== 'admitted' && decision.kind !== 'recovery-allowed') {
      return decision.rejected
    }
    return append(decision.record)
  })
})
```

The code must not read the lease once and then append later without the guard.
The existing `withDaemonLeaseGuard` and `readDaemonLease` primitives are the
implementation basis. The `SessionStore.withWriteLock` pattern also demonstrates
the accepted scope: hold the daemon guard, re-read the active fence, write, and
release.

Why this closes the race:

- `withCurrentDaemonOwner` enters the existing daemon lease transition guard.
- It authenticates the injected local lease and re-reads the durable current
  lease inside that guard. It passes only that authenticated caller plus a
  supervisor-owned replacement predicate. It does not accept caller-supplied
  identity as proof.
- The Journal transaction acquires the Journal lock and appends inside the
  same guard scope.
- The first admission validates the complete binding against the actual
  authoritative input. It derives the initial owner only from the already
  supervisor-authenticated current caller and persists it with the unique
  admission.
- Existing-admission reads supply immutable A. The decision compares A with
  the authenticated caller or with the supervisor predicate. The apply
  callback runs only after that read validation.
- Validation-to-append overlap with handoff is impossible if the guard is held
  for the whole mutation.
- A stale A that holds the guard after handoff cannot authenticate as the
  current durable lease or produce B's committed replacement evidence, so it
  fails before append.

### Normal admission and terminal path

The guard authenticates the local caller before the Journal transaction. The
first-admission branch runs only when no matching record exists. It validates
the complete immutable binding against the actual authoritative input, then
uses the authenticated current caller as the only source for the initial
`admittedExecutionOwner`. The initial owner and unique admission are appended
together; only that committed admission authorizes one dispatch. An append
failure produces no dispatch. A concurrent caller, replay, or different caller
either reads that admission or is typed-rejected; it never creates a second
admission or dispatch.

For an existing admission, the Journal read callback receives immutable A from
the real persisted admission. Normal mutation is allowed only when A equals
the authenticated current caller. Recovery uses the committed-replacement
predicate instead. A mismatch returns the typed concurrent/rejected outcome
and performs no dispatch or Journal mutation.

### Replacement recovery path

Recovery uses the same guard, but with two distinct identities:

1. The Journal read callback reads immutable owner A from A's real admission by
   the immutable binding. The caller does not supply A.
2. `currentCaller` is owner B, authenticated by B's injected local lease under
   the existing daemon guard.
3. The guard proves A-to-B replacement with the existing
   `isDaemonLeaseHandoffCommitted(paths, A)` predicate under the same daemon
   guard. This requires a durable current lease that is live, distinct from A,
   and at a higher generation. The immediate `takeover.previousLeaseId` and
   `previousGeneration` fields may corroborate a one-step replacement, but they
   are not sufficient for a multi-step chain; the generation/liveness predicate
   is the actual committed-replacement basis.
4. Inside `journal.transaction`, the read callback locates the existing
   admission by the immutable binding-derived commit ID and validates its
   complete binding and A identity. If the admission is absent or invalid, fail
   closed.
5. The apply callback appends exactly one recovery checkpoint/receipt event with
   the original logical occurrence/task/epoch/digest/key. It does not overwrite
   the admission, rebind A, rediscover or redispatch the occurrence, or imply
   provider/tool/browser/port release.
6. Replays of B's recovery use the same original binding-derived receipt key.
   Same content returns the existing fact. Different content for the same key
   raises `JournalCommitConflictError`.

This is a future typed path. The current source has the durable takeover
relation and Journal lock, but it does not yet have the domain record,
authenticated caller binding, or guarded recovery operation. Those missing
pieces are **BLOCKED** until the source tasks below are admitted and implemented.

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
  -> app supervisor typed withCurrentDaemonOwner
  -> durable consumer adapter fenced mutation
  -> journal-adapter receipt/replay seam
  -> scheduler integration with receipt/replay
  -> public two-process proof
```

Allowed paths:

| Task | Allowed paths |
| --- | --- |
| core authority | `packages/contracts/src/framework.ts`, `packages/core/src/subscription.ts` |
| app supervisor authority | `packages/app/src/supervisor/*` for the typed guard, caller authentication, replacement predicate and exports; no lease duplication |
| durable consumer | `packages/app/src/ui-runtime/occurrence-consumer.ts`; `packages/app/src/ui-runtime/journal.ts` is a separate journal-adapter write after the consumer contract is frozen |
| scheduler integration | `packages/runtime/src/subscriptions/index.ts`; W3 `packages/runtime/src/ui-runtime/task-verification.ts` is composed by the parent before this sequence |
| tests | `tests/app/supervisor/supervisor.test.ts` pattern, `tests/runtime/subscriptions/public-consumer.test.ts` pattern |

The parent composes frozen W3 bytes before task F and dispatches F -> G -> A ->
J -> B in that order. Tasks do not share write ranges. In particular, the
consumer adapter and the Journal adapter are not concurrent writers. No task
starts a second lease or second terminal store.

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
2. First admission: with no admission record, the guarded Journal transaction
   validates the complete immutable binding against the actual authoritative
   input and persists `admittedExecutionOwner` equal to the authenticated
   initializer. The assertion reads back the real persisted owner. Only that
   committed unique admission permits exactly one dispatch. Append failure
   yields no dispatch. Concurrent and replay callers never create a second
   admission or dispatch; the record/receipt identity is unchanged.
3. Two-process A/B before terminal: B copies A's exact readable
   `daemonLeaseId`/`daemonGeneration`/`processStartToken`. B's mutation callback
   never runs. Assert no dispatch, terminal, or recovery record is appended.
4. Crash after admission: replacement daemon lease B has a new generation and
   token. `isDaemonLeaseHandoffCommitted(paths, A)` is true inside the guard. B
   writes exactly one recovery checkpoint/receipt for the original binding and
   does not redispatch or rebind A.
5. Stale A after replacement: A tries the same recovery operation but cannot
   authenticate as the durable current lease or prove a handoff from itself.
   The mutation callback never runs. A also copies B's readable identity and
   must still fail.
6. Concurrent B/uncertain/expired: while A is live, or when A's claim is expired
   without a committed replacement, B receives typed rejection/pending and
   writes nothing.
7. Validation-to-append race: a handoff attempted between Journal read and
   append cannot interleave because the guard is held across the transaction.
   The post-guard authoritative replay returns the committed winner.
8. Persistence/effect uncertainty: append failure is visible; a failed append
   leaves no receipt; provider/tool/browser/port release remains `possible`
   until real stop/settlement evidence exists.
9. Same receipt key: second receipt with the same binding and different content
   throws `JournalCommitConflictError`; checkpoint-only remains
   `durable-unverified-recovery-pending`; standard stop/settlement and original
   errors/external effects remain unchanged.
10. Cleanup: only this task's fixture roots are removed.

Fake counters are RED/control evidence only. They cannot be GREEN.

The future fixture must use the existing supervisor child-process pattern:
`fixture()`, `ensureControlLayout`, and `startLeaseChild`-equivalent real child
processes. The fixture must create its own `RuntimePaths` root. The test must
remove that root after the assertions and verify physical absence.

## 13. Blocked facts

- The occurrence owner binding and fenced mutation are not implemented.
- `consumeExecution` still lacks the app supervisor authority.
- The public `withCurrentDaemonOwner`-equivalent supervisor operation is
  missing, including local caller authentication and the committed-replacement
  recovery decision.
- No current caller combines supervisor owner validation with occurrence
  Journal mutation in one guard scope.
- Current canonical `main` does not contain the frozen scheduler source files.
- Provider/RCC resume is unsupported.
- Transport abort is not external-effect release.
- Provider/tool/browser/port effect release is not proved by process death or a
  stale lease fence.
- Scheduler source R5 cap and installed design R6 cap exception remain open.
- This document is not source review or implementation admission.
