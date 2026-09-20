import type {
  EvidenceRef,
  NextAction,
  OperationEvent,
  OperationFailure,
  OperationIntent,
  OperationLease,
  OperationResult,
  OperationStatus,
  RouteSelection,
  Scope,
  ToolRegistration,
} from '../../../contracts/src/index.js';
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

export interface OperationJournalPort {
  /** Commit the authoritative operation event before any notification is emitted. */
  commit(event: OperationEvent): Promise<void>;
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
