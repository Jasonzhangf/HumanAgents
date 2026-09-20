import type {
  EvidenceRef,
  LifecycleState,
  OperationEvent,
  OperationStatus,
  OperationFailure,
  TaskId,
  OperationId,
} from '../../contracts/src/index.js';
import { assertExecutionEventFence, fenceExecutionEvent, type ExecutionEventFence, type FenceDecision } from './epoch.js';
import { EpochError, LifecycleError } from './errors.js';
import { assertTransitionLifecycle, canTransitionLifecycle, isTerminalLifecycleState } from './lifecycle.js';

export type OperationBlockedAfter = 'admission' | 'execution' | 'verification' | 'reconcile';
export type OperationExecutionMode = 'execute' | 'verify-only';
export type OperationSideEffectState = 'none' | 'possible' | 'confirmed';

export interface OperationRecoveryInput {
  readonly blockedAfter: OperationBlockedAfter;
  readonly sideEffectState: OperationSideEffectState;
  readonly retryAllowed: boolean;
}

export interface OperationRecoveryDecision {
  readonly status: 'queued' | 'verifying';
  readonly executionMode: OperationExecutionMode;
  readonly requiresExecutor: boolean;
  readonly requiresVerifier: boolean;
}

export interface OperationEventFence {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
}

export interface OperationCancelSettlementInput {
  readonly stopped: boolean;
  readonly sideEffectState: OperationSideEffectState;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface OperationCancelSettlementDecision {
  readonly status: 'cancelled' | 'reconcile_required' | 'failed';
  readonly reason: 'stopped' | 'side-effect-uncertain' | 'stop-failed';
}

export interface OperationReconcileResolution {
  readonly status: 'blocked' | 'failed' | 'cancelled';
  readonly blockedAfter?: 'reconcile';
}

const OPERATION_STATUS_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  accepted: ['queued', 'failed', 'blocked', 'cancel_requested'],
  queued: ['leased', 'blocked', 'failed', 'cancel_requested'],
  leased: ['running', 'settling', 'blocked', 'failed', 'cancel_requested'],
  running: ['settling', 'blocked', 'cancel_requested'],
  settling: ['verifying', 'blocked', 'failed', 'reconcile_required', 'cancel_requested'],
  verifying: ['succeeded', 'failed', 'blocked', 'reconcile_required', 'cancel_requested'],
  succeeded: [],
  failed: [],
  blocked: ['queued', 'verifying', 'failed', 'cancel_requested'],
  cancel_requested: ['cancelled', 'failed', 'reconcile_required'],
  cancelled: [],
  reconcile_required: ['blocked', 'failed', 'cancelled'],
};

const OPERATION_STATUS_LIFECYCLE: Readonly<Record<OperationStatus, LifecycleState>> = {
  accepted: 'admitted',
  queued: 'waiting',
  leased: 'running',
  running: 'running',
  settling: 'settling',
  verifying: 'settling',
  succeeded: 'succeeded',
  failed: 'failed',
  blocked: 'blocked',
  cancel_requested: 'settling',
  cancelled: 'cancelled',
  reconcile_required: 'unknown',
};

function assertOperationStatus(status: OperationStatus): void {
  if (!(status in OPERATION_STATUS_LIFECYCLE)) throw new LifecycleError('operation status is invalid');
}

export function operationStatusToLifecycleState(status: OperationStatus): LifecycleState {
  assertOperationStatus(status);
  return OPERATION_STATUS_LIFECYCLE[status];
}

export function isTerminalOperationStatus(status: OperationStatus): boolean {
  assertOperationStatus(status);
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function canTransitionOperationStatus(from: OperationStatus, to: OperationStatus): boolean {
  assertOperationStatus(from);
  assertOperationStatus(to);
  if (!OPERATION_STATUS_TRANSITIONS[from].includes(to)) return false;
  const fromLifecycle = operationStatusToLifecycleState(from);
  const toLifecycle = operationStatusToLifecycleState(to);
  return fromLifecycle === toLifecycle || canTransitionLifecycle(fromLifecycle, toLifecycle);
}

export function assertTransitionOperationStatus(from: OperationStatus, to: OperationStatus): void {
  if (!canTransitionOperationStatus(from, to)) {
    throw new LifecycleError(`illegal operation status transition: ${from} -> ${to}`);
  }
}

export function transitionOperationStatus(from: OperationStatus, to: OperationStatus): OperationStatus {
  assertTransitionOperationStatus(from, to);
  return to;
}

export function planBlockedRecovery(input: OperationRecoveryInput): OperationRecoveryDecision {
  if (!['admission', 'execution', 'verification', 'reconcile'].includes(input.blockedAfter)) {
    throw new LifecycleError('operation blockedAfter is invalid');
  }
  if (!['none', 'possible', 'confirmed'].includes(input.sideEffectState)) {
    throw new LifecycleError('operation sideEffectState is invalid');
  }

  // admission + no side effects is still the initial execution, so retryAllowed=false does not block it;
  // retryAllowed only gates re-execution after execution.
  const canExecute = input.sideEffectState === 'none'
    && (input.blockedAfter === 'admission'
      || (input.blockedAfter === 'execution' && input.retryAllowed));
  if (canExecute) {
    return {
      status: 'queued',
      executionMode: 'execute',
      requiresExecutor: true,
      requiresVerifier: true,
    };
  }
  return {
    status: 'verifying',
    executionMode: 'verify-only',
    requiresExecutor: false,
    requiresVerifier: true,
  };
}

export function assertVerifyOnlyRecovery(decision: OperationRecoveryDecision): void {
  if (decision.executionMode !== 'verify-only'
    || decision.requiresExecutor
    || !decision.requiresVerifier
    || decision.status !== 'verifying') {
    throw new LifecycleError('operation recovery is not verify-only');
  }
}

export function planOperationCancellation(
  current: OperationStatus,
  input: OperationCancelSettlementInput,
): OperationCancelSettlementDecision {
  assertOperationStatus(current);
  if (current !== 'cancel_requested') {
    throw new LifecycleError(`operation cancellation requires cancel_requested, got ${current}`);
  }
  if (input.evidenceRefs.length === 0) {
    throw new LifecycleError('operation cancellation requires settlement evidence');
  }
  if (input.sideEffectState === 'possible' || input.sideEffectState === 'confirmed') {
    assertTransitionOperationStatus(current, 'reconcile_required');
    return { status: 'reconcile_required', reason: 'side-effect-uncertain' };
  }
  if (!input.stopped) {
    const status = 'failed';
    const reason = 'stop-failed';
    assertTransitionOperationStatus(current, status);
    return { status, reason };
  }
  assertTransitionOperationStatus(current, 'cancelled');
  return { status: 'cancelled', reason: 'stopped' };
}

export function planReconcileRequiredResolution(
  current: OperationStatus,
  outcome: 'recovered' | 'failed' | 'cancelled',
): OperationReconcileResolution {
  assertOperationStatus(current);
  if (current !== 'reconcile_required') {
    throw new LifecycleError(`reconcile resolution requires reconcile_required, got ${current}`);
  }
  if (outcome === 'recovered') {
    assertTransitionOperationStatus(current, 'blocked');
    return { status: 'blocked', blockedAfter: 'reconcile' };
  }
  assertTransitionOperationStatus(current, outcome);
  return { status: outcome };
}

export function assertOperationFailureMatchesStatus(
  status: OperationStatus,
  failure: OperationFailure | undefined,
): void {
  assertOperationStatus(status);
  if (status === 'failed') {
    if (failure === undefined) throw new LifecycleError('failed operation status requires failure');
    return;
  }
  if (failure !== undefined) throw new LifecycleError('only failed operation status may carry failure');
}

export function assertTerminalOperationStatus(status: OperationStatus): void {
  if (!isTerminalOperationStatus(status)) {
    throw new LifecycleError(`operation status is not terminal: ${status}`);
  }
  if (!isTerminalLifecycleState(operationStatusToLifecycleState(status))) {
    throw new LifecycleError(`operation terminal status does not project to a terminal lifecycle: ${status}`);
  }
}

export function assertOperationLifecycleProjection(from: OperationStatus, to: OperationStatus): void {
  const fromLifecycle = operationStatusToLifecycleState(from);
  const toLifecycle = operationStatusToLifecycleState(to);
  if (fromLifecycle !== toLifecycle) assertTransitionLifecycle(fromLifecycle, toLifecycle);
}

export function fenceOperationEvent(current: OperationEventFence, event: OperationEvent): FenceDecision {
  if (current.operationId.scope !== event.operationId.scope
    || current.operationId.value !== event.operationId.value) {
    throw new EpochError('stale operation event: operation-mismatch');
  }
  const executionEvent: ExecutionEventFence = {
    taskId: event.taskId,
    operationId: event.operationId,
    executionEpoch: event.executionEpoch,
  };
  return fenceExecutionEvent(current, executionEvent);
}

export function assertOperationEventFence(current: OperationEventFence, event: OperationEvent): void {
  fenceOperationEvent(current, event);
  assertExecutionEventFence(current, {
    taskId: event.taskId,
    operationId: event.operationId,
    executionEpoch: event.executionEpoch,
  });
}

export interface OperationTransitionPlan {
  readonly from: OperationStatus;
  readonly to: OperationStatus;
  readonly lifecycleFrom: LifecycleState;
  readonly lifecycleTo: LifecycleState;
}

export function planOperationTransition(
  from: OperationStatus,
  to: OperationStatus,
): OperationTransitionPlan {
  assertTransitionOperationStatus(from, to);
  return {
    from,
    to,
    lifecycleFrom: operationStatusToLifecycleState(from),
    lifecycleTo: operationStatusToLifecycleState(to),
  };
}
