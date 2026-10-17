import type {
  EvidenceRef,
  NextAction,
  OperationEvent,
  OperationFailure,
  OperationId,
  OperationIntent,
  OperationLease,
  OperationResult,
  OperationStatus,
  RouteSelection,
  Scope,
  ScopeRef,
  TaskCheckEvidence,
  TaskCheckPolicy,
  TaskExecutionEvidence,
  TaskObservationProductionResult,
  TaskVerificationBinding,
  TaskVerificationPolicy,
  TaskVerificationResult,
  TaskVisualCheckPolicy,
  TaskVisualObservationReceipt,
  ToolRegistration,
} from '../../../contracts/src/index.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type { TaskGrantBusinessRegistration } from '../admission/task-grant.js';
import type {
  OperationBlockedAfter,
  OperationSideEffectState,
} from '../../../core/src/tool-execution-lifecycle.js';

export interface OperationPermissionGrant {
  readonly scope: Scope;
  readonly revoked: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface OperationPermissionPort {
  readGrant(input: {
    readonly intent: OperationIntent;
    readonly registration: ToolRegistration;
  }): Promise<OperationPermissionGrant | null>;
}

export interface OperationTaskBoundary {
  readonly scope: Scope;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface OperationTaskBoundaryPort {
  readBoundary(input: {
    readonly intent: OperationIntent;
    readonly registration: ToolRegistration;
  }): Promise<OperationTaskBoundary | null>;
}

export type OperationExecutorStatus = 'completed' | 'blocked' | 'reconcile_required';

export interface OperationExecutorObservation {
  readonly executionEpoch: number;
  readonly status: OperationExecutorStatus;
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly owner: string;
  readonly sideEffectState: OperationSideEffectState;
  readonly nextAction?: NextAction;
  readonly conditionRef?: string;
  readonly message?: string;
}

export interface OperationExecutorRequest {
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  readonly lease: OperationLease;
}

export interface OperationExecutorPort {
  execute(input: OperationExecutorRequest): Promise<OperationExecutorObservation>;
}

export interface OperationStopSettlementRequest {
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  readonly executionEpoch: number;
  readonly owner: string;
  readonly lease?: OperationLease;
}

export interface OperationStopSettlementReceipt {
  readonly receiptId: string;
  readonly operationId: OperationIntent['operationId'];
  readonly taskId: OperationIntent['taskId'];
  readonly executionEpoch: number;
  readonly owner: string;
  readonly leaseId?: string;
  readonly stopped: boolean;
  readonly sideEffectState: OperationSideEffectState;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface OperationStopSettlementPort {
  settle(input: OperationStopSettlementRequest): Promise<OperationStopSettlementReceipt>;
}

export interface OperationVerifierDecision {
  readonly executionEpoch: number;
  readonly accepted: boolean;
  readonly decision: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly message?: string;
}

export interface OperationVerifierRequest {
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  readonly lease?: OperationLease;
  readonly observation: OperationExecutorObservation;
}

export interface OperationVerifierPort {
  verify(input: OperationVerifierRequest): Promise<OperationVerifierDecision>;
}

export interface TaskObservationProductionPort {
  produce(input: {
    readonly policy: TaskVisualCheckPolicy;
    readonly binding: TaskVerificationBinding;
  }): Promise<TaskObservationProductionResult>;
}

export interface TaskVerificationExecutionPort {
  execute(input: {
    readonly policy: TaskVerificationPolicy;
    readonly binding: TaskVerificationBinding;
    readonly check: TaskCheckPolicy;
    readonly observation?: TaskVisualObservationReceipt;
  }): Promise<TaskCheckEvidence>;
}

export interface TaskVerificationPort {
  verify(input: {
    readonly policy: TaskVerificationPolicy;
    readonly binding: TaskVerificationBinding;
    readonly executionEvidence: TaskExecutionEvidence;
  }): Promise<TaskVerificationResult>;
}

/**
 * Selector for a scoped operation-control read.
 *
 * `scope` identifies the declared task scope. `agentRuntimeId` and
 * `harnessExecutionEpoch` narrow the read to one runtime incarnation. The
 * Gateway attempt/lease epoch is never used as the Harness execution epoch.
 */
export interface OperationControlSelector {
  readonly scope: ScopeRef;
  readonly agentRuntimeId?: string;
  readonly harnessExecutionEpoch?: number;
  /** Select control.intent.operationId itself; omission reads the whole namespace, including pending child obligations. */
  readonly operationId?: OperationId;
}

/**
 * Durable task-coverage initialization fact.
 *
 * It binds the actual new-task admission identity to the operation-control
 * format/coverage start. A scope without this fact reads as `unknown`, never as
 * a known-empty complete set.
 */
export interface OperationCoverageInitialization {
  readonly scope: ScopeRef;
  readonly agentRuntimeId?: string;
  readonly harnessExecutionEpoch?: number;
  readonly admissionCommitRef: JournalCommitRef;
}

/**
 * Parent Harness runtime admission binding for one Gateway operation.
 *
 * `harnessExecutionEpoch` is the parent Harness runtime epoch. It is distinct
 * from the Gateway attempt/lease epoch carried by `OperationControlRecord`.
 */
export interface OperationControlBinding {
  readonly scope: ScopeRef;
  readonly agentRuntimeId: string;
  readonly harnessExecutionEpoch: number;
  readonly parentOperationId: OperationId;
  readonly admissionCommitRef: JournalCommitRef;
}

/**
 * Persisted authoritative operation-control state.
 *
 * It carries the existing Gateway lifecycle record, the parent admission
 * binding, and the minimum identity/fingerprint fields needed to recover
 * Gateway idempotency. `namespaceKey`/`fingerprintKey` reuse the existing
 * idempotency functions; no second idempotency policy is introduced.
 */
export interface OperationControlRecord {
  readonly binding: OperationControlBinding;
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  readonly status: OperationStatus;
  readonly executionEpoch: number;
  readonly namespaceKey: string;
  readonly fingerprintKey: string;
  /**
   * Explicit child-operation admission receipts. Parent external lifecycle
   * records remain valid without it; only the explicit child path carries it.
   */
  readonly childAdmission?: OperationChildAdmission;
  readonly lease?: OperationLease;
  readonly observation?: OperationExecutorObservation;
  readonly result?: OperationResult;
  readonly failure?: OperationFailure;
  readonly blocked?: OperationBlockedState;
  readonly reconcile?: OperationReconcileState;
  readonly executionInvalidated?: boolean;
}

/**
 * The three distinct facts that authorize one explicit child operation. They
 * are never interchangeable: the authority is the current grant commit, the
 * business registration is the child's own TG1 registration, and the coverage
 * is the admitted parent namespace coverage.
 */
export interface OperationChildAdmission {
  readonly authorityCommitRef: JournalCommitRef;
  readonly businessRegistrationCommitRef: JournalCommitRef;
  readonly coverageCommitRef: JournalCommitRef;
}

/** Physical child-admission lookup request on the explicit child path. */
export interface OperationChildAdmissionLookup {
  readonly binding: OperationControlBinding;
  readonly intent: OperationIntent;
  readonly admission: OperationChildAdmission;
}

/**
 * Physical child-admission readback. `verified` returns the exact decoded
 * business registration and parent control record with their physical commit
 * references; `unknown` carries the references that could not be joined.
 */
export type OperationChildAdmissionReadback =
  | {
      readonly state: 'verified';
      readonly registration: TaskGrantBusinessRegistration;
      readonly registrationCommitRef: JournalCommitRef;
      readonly parentControl: OperationControlRecord;
      readonly parentControlCommitRef: JournalCommitRef;
      readonly coverageCommitRef: JournalCommitRef;
    }
  | {
      readonly state: 'unknown';
      readonly reason: string;
      readonly missingRefs: readonly string[];
    };

/**
 * One registered child that has no matching child control yet. A parent-scoped
 * read must expose it instead of reporting a complete empty set.
 */
export interface OperationPendingChild {
  readonly operationId: OperationId;
  readonly businessRegistrationCommitRef: JournalCommitRef;
}

/**
 * Scoped operation-control readback.
 *
 * `complete` with `operations: []` is a known-empty set backed by an actual
 * coverage receipt. Missing initialization, incomplete admission coverage, a
 * failed read, or legacy events lacking required state read as `unknown`.
 */
export type OperationControlReadback =
  | {
      readonly state: 'complete';
      readonly scope: ScopeRef;
      readonly coverageCommitRef: JournalCommitRef;
      readonly currentControlCommitRef: JournalCommitRef;
      readonly operations: readonly OperationControlRecord[];
      /** Physical commit refs parallel to `operations`, in the same order. */
      readonly operationCommits: readonly JournalCommitRef[];
    }
  | {
      readonly state: 'unknown';
      readonly scope: ScopeRef;
      readonly reason: string;
      readonly missingRefs: readonly string[];
      readonly pendingChildren?: readonly OperationPendingChild[];
    };

/**
 * One bounded externally driven lifecycle register/update for the existing
 * parent Provider controller.
 *
 * `event` is the authoritative lifecycle event and `control` is its successor
 * control state. The Gateway commits both atomically under the Journal
 * authority and only then publishes the map/notification. A conflicting or
 * stale successor fails. The controller still owns the actual Provider
 * start/settle call; this method never invokes an executor or model.
 */
export interface ExternalOperationLifecycle {
  readonly event: OperationEvent;
  readonly control: OperationControlRecord;
}

export interface OperationJournalPort {
  /**
   * Commit the authoritative operation event and its exact successor control
   * state in one append before any notification is emitted. The returned
   * canonical receipt identifies that append.
   */
  commit(event: OperationEvent, control: OperationControlRecord): Promise<JournalCommitRef>;
  /**
   * Read complete or unknown operation-control state for one exact scope.
   * Physical read semantics (coverage, legacy detection, scoping) are owned by
   * the adapter; the Gateway only hydrates its cache from a complete read.
   */
  readControl(input: OperationControlSelector): Promise<OperationControlReadback>;
  /**
   * Initialize durable task coverage for an actual new-task admission. Returns
   * the coverage receipt that later complete reads carry.
   */
  initializeCoverage(input: OperationCoverageInitialization): Promise<JournalCommitRef>;
  /**
   * Narrow read-only child-admission lookup. It physically joins the exact
   * decoded child business registration, the parent control record and the
   * coverage fact. The explicit child path must fail when this capability is
   * absent; it must never trust a caller-supplied receipt without a read.
   */
  readChildAdmission?(input: OperationChildAdmissionLookup): Promise<OperationChildAdmissionReadback>;
  /** Optional post-commit notification; notification failure must not rewrite operation truth. */
  publishCommitted?(event: OperationEvent): Promise<void>;
}

export interface OperationBlockedState {
  readonly blockedAfter: OperationBlockedAfter;
  readonly sideEffectState: OperationSideEffectState;
  readonly retryAllowed: boolean;
  readonly owner: string;
  readonly nextAction: NextAction;
  readonly conditionRef?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface OperationReconcileState {
  readonly owner: string;
  readonly reason: string;
  readonly sideEffectState: OperationSideEffectState;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface OperationSnapshot {
  readonly operationId: OperationIntent['operationId'];
  readonly taskId: OperationIntent['taskId'];
  readonly status: OperationStatus;
  readonly executionEpoch: number;
  readonly route?: RouteSelection;
  readonly lease?: OperationLease;
  readonly observation?: OperationExecutorObservation;
  readonly result?: OperationResult;
  readonly failure?: OperationFailure;
  readonly blocked?: OperationBlockedState;
  readonly reconcile?: OperationReconcileState;
}

export interface OperationSubmissionResult {
  readonly decision: 'new' | 'replay';
  readonly operation: OperationSnapshot;
}

export interface ResumeOperationInput {
  readonly blockedAfter?: OperationBlockedAfter;
  readonly sideEffectState?: OperationSideEffectState;
  readonly retryAllowed?: boolean;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface ResolveReconcileInput {
  readonly outcome: 'recovered' | 'failed' | 'cancelled';
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly message?: string;
}
