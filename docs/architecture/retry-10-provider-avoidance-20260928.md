# Retry-10 Provider Avoidance

Status: `DESIGN-ADMITTED / RETRY-10-PROVIDER-AVOIDANCE`
Date: 2026-09-28
Design admission reference: `m1790638856436-322`

## 1. Goal

Implement bounded provider avoidance for executor assignment retries without changing a provider binding inside an execution epoch.

The feature must support an initial attempt plus up to ten retries, for at most eleven settled attempts per retry cycle. A failed provider binding is excluded from later attempts in the same retry cycle. Each alternate provider binding starts a new execution epoch with a fresh checkpoint and fresh permission, capability, readiness, and lease admission.

This design is scoped to Retry-10 only. It does not introduce general fallback, provider/model substitution, DSH-specific retry behavior, or silent fallback through business payloads.

## 2. Invariants

The implementation must preserve these HumanAgent contracts:

- Journal remains the fact source of truth. Runtime/app retry-cycle facts must be persisted through typed `JournalCommitIntent` to Journal Owner. App adapter code may use the JSONL adapter, but it must not allocate `seq`, bypass Journal Owner, or copy control facts into business payload, metadata, or logs.
- Provider binding is immutable inside an execution epoch. Switching provider requires a new binding identity and a new execution epoch.
- Each new retry epoch must create a new checkpoint and perform fresh permission, capability, readiness, and lease admission.
- Provider/model selection is controlled by Harness/config admission. It must not be selected from prompt text, model output, tool results, ACP updates, or provider responses.
- Runtime owns retry policy, retry budget, exclusions, candidate eligibility, admission snapshots, and dispatch orchestration.
- Operation Owner owns operation settlement/reconciliation. Unknown, unsettled, cancelled, or recovery-requiring attempts must become visible recovery/attention state.
- Exhaustion is allowed only after settled retry-safe attempt 11. It must not be reported as success when a side effect remains unknown.

## 3. Retry Cycle State

Runtime owns a typed retry-cycle port:

```ts
interface RetryCycleControlRecord {
  readonly assignmentId: string;
  readonly initialExecutionEpoch: number;
  readonly retryBudget: {
    readonly initialAttempt: 1;
    readonly maxRetries: 10;
  };
  readonly state: 'admitted' | 'running' | 'settling' | 'retry-safe' | 'exhausted' | 'blocked-attention';
  readonly attempts: RetryCycleAttempt[];
  readonly exclusions: RetryBindingExclusion[];
  readonly admissionSnapshots: EpochAdmissionSnapshot[];
}

interface RetryCycleAttempt {
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly bindingId: string;
  readonly operationRef?: string;
  readonly failureRef?: string;
  readonly evidenceRefs: readonly string[];
  readonly settleState: 'unsettled' | 'retry-safe' | 'unknown' | 'cancelled' | 'success';
}

interface RetryBindingExclusion {
  readonly bindingId: string;
  readonly failedExecutionEpoch: number;
  readonly failureRef: string;
  readonly evidenceRefs: readonly string[];
}

interface EpochAdmissionSnapshot {
  readonly executionEpoch: number;
  readonly bindingId: string;
  readonly bindingFingerprint: string;
  readonly permissionRevision: string;
  readonly capabilityDigest: string;
  readonly readinessRef: string;
  readonly leaseRef: string;
  readonly checkpointRef: string;
  readonly admissionDigest: string;
}
```

All records are keyed by `assignmentId + initialExecutionEpoch` for the cycle and by `executionEpoch` for individual admission snapshots. The app adapter stores these records as dedicated Organ Journal control records through Journal Owner.

## 4. Flow

The retry loop follows this single path:

1. Orchestration admits the first assignment and creates or receives the durable retry-cycle record for `assignmentId + initialExecutionEpoch`.
2. Admission selects the initial provider binding from explicit configured candidates and persists the per-epoch admission snapshot before dispatch.
3. The attempt dispatches as an ordinary executor operation under that binding and execution epoch.
4. On success, the retry cycle records the successful attempt and lets the assignment complete through its existing owner path.
5. On a retryable failure, Runtime first asks Operation Owner to settle/reconcile the failed operation.
6. If settlement returns `unknown`, unsettled side effect, cancellation, or recovery-required state, Runtime records a visible blocked-attention recovery path. It must not retry another provider until the failed attempt is known retry-safe.
7. If settlement returns retry-safe failure, Runtime appends an exclusion for `bindingId + failedExecutionEpoch`, increments the attempt count, and checks the retry budget.
8. If no eligible configured candidate remains, Runtime records `blocked-attention` or exhaustion according to whether attempt 11 has been settled retry-safe.
9. If another candidate remains, Runtime starts a new execution epoch, creates a fresh checkpoint, re-admits permission/capability/readiness/lease, persists the new admission snapshot, and dispatches the next attempt.
10. If attempt 11 has been settled retry-safe and no further retry is allowed, Runtime records exhaustion with evidence and routes to visible recovery/attention rather than success.

## 5. Candidate Provider Selection

Candidate provider lists must be explicit config owned by Harness/config admission. There is no automatic fallback to an unspecified provider/model.

Selection rules:

- The first epoch chooses from the configured candidate list according to existing admission order and eligibility.
- Retry epochs choose from configured candidates not present in persisted exclusions for the retry cycle.
- A candidate must pass permission, capability, readiness, and lease admission before dispatch.
- If no eligible candidate remains, the cycle does not dispatch. It records a visible recovery/attention state with owner and evidence.

## 6. Restart and Recovery

Before any retry dispatch after process restart, Runtime must hydrate from Journal:

- retry budget and current state,
- all recorded attempts,
- all persisted exclusions,
- every admitted per-epoch snapshot,
- checkpoint references,
- operation settlement evidence,
- evidence refs for failed attempts.

If any required fact is missing or inconsistent, the cycle must not guess or rediscover live provider state. It must enter visible blocked-attention with the missing fact, owner, and recovery action.

Operation reconciliation remains owned by Operation Owner. Retry-10 records can reference operation settlement/reconciliation evidence, but they must not duplicate operation lifecycle as truth.

## 7. Ownership

| Concern | Owner |
| --- | --- |
| Retry budget, exclusions, candidate eligibility, per-cycle state | Runtime Orchestration / RetryCyclePort |
| Per-epoch admission snapshot and binding fingerprint | Harness/config admission, consumed by Runtime |
| Checkpoint creation and checkpoint linkage | Checkpoint/Control Owner |
| Permission, capability, readiness, lease admission | Harness/runtime admission owners |
| Operation settle/reconcile | Operation Owner |
| Journal append, `seq`, previous digest, commit idempotency | Journal Owner |
| JSONL-backed persistence for RetryCycleControlRecord | app RetryCyclePort adapter through Journal Owner |
| Visible attention/recovery projection | existing Attention/Task lifecycle owners |

## 8. Tests Required Before Delivery

Focused tests must cover:

- provider A fails and provider B succeeds with a new execution epoch and new admission snapshot,
- exclusion persistence across provider switch,
- retry budget initial plus ten retries,
- exhaustion after settled retry-safe attempt 11,
- no candidate remaining goes to visible recovery,
- unknown/unsettled side effect goes to visible recovery and prevents provider switch,
- restart hydrates exclusions/admission snapshots before retry dispatch,
- Journal Owner is the only durable writer for retry-cycle control records.

Real-entry E2E must prove:

- A fails then B succeeds through the actual provider/runtime path,
- max retry and exhaustion/no-candidate paths produce visible non-success recovery state,
- restart rehydration does not silently choose a binding from live config or logs.

## 9. Non-Goals

This design does not:

- allow provider binding changes inside an execution epoch,
- copy provider/model facts into business payload, metadata, or logs as control truth,
- let model output choose a provider,
- bypass checkpoint, operation settlement, lease, permission, capability, readiness, or Journal Owner rules,
- add DSH-specific semantics to Runtime,
- treat exhausted attempts as success.
