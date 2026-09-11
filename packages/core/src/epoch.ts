import { assertExecutionEpoch, type OperationId, type TaskId } from '../../contracts/src/index.js';
import { EpochError } from './errors.js';

export interface ExecutionEventFence {
  readonly taskId: TaskId;
  readonly operationId?: OperationId;
  readonly executionEpoch: number;
  readonly attempt?: number;
  readonly inputRevision?: number;
}

export interface CurrentExecutionFence {
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly attempt?: number;
  readonly inputRevision?: number;
}

export interface LateEventRejection {
  readonly accepted: false;
  readonly stale: true;
  readonly reason: 'epoch-mismatch' | 'attempt-mismatch' | 'input-revision-mismatch' | 'task-mismatch';
  readonly sourceEpoch: number;
  readonly currentEpoch: number;
  readonly sourceAttempt?: number;
  readonly currentAttempt?: number;
  readonly sourceInputRevision?: number;
  readonly currentInputRevision?: number;
}

export type FenceDecision = { readonly accepted: true } | LateEventRejection;

function sameId(left: { readonly scope: string; readonly value: string }, right: { readonly scope: string; readonly value: string }): boolean {
  return left.scope === right.scope && left.value === right.value;
}

export function fenceExecutionEvent(current: CurrentExecutionFence, event: ExecutionEventFence): FenceDecision {
  assertExecutionEpoch(current.executionEpoch);
  assertExecutionEpoch(event.executionEpoch);
  if (!sameId(current.taskId, event.taskId)) {
    return {
      accepted: false,
      stale: true,
      reason: 'task-mismatch',
      sourceEpoch: event.executionEpoch,
      currentEpoch: current.executionEpoch,
    };
  }
  if (event.executionEpoch !== current.executionEpoch) {
    return {
      accepted: false,
      stale: true,
      reason: 'epoch-mismatch',
      sourceEpoch: event.executionEpoch,
      currentEpoch: current.executionEpoch,
    };
  }
  if (current.attempt !== undefined || event.attempt !== undefined) {
    if (event.attempt !== current.attempt) {
      return {
        accepted: false,
        stale: true,
        reason: 'attempt-mismatch',
        sourceEpoch: event.executionEpoch,
        currentEpoch: current.executionEpoch,
        sourceAttempt: event.attempt,
        currentAttempt: current.attempt,
      };
    }
  }
  if (current.inputRevision !== undefined || event.inputRevision !== undefined) {
    if (event.inputRevision !== current.inputRevision) {
      return {
        accepted: false,
        stale: true,
        reason: 'input-revision-mismatch',
        sourceEpoch: event.executionEpoch,
        currentEpoch: current.executionEpoch,
        sourceInputRevision: event.inputRevision,
        currentInputRevision: current.inputRevision,
      };
    }
  }
  return { accepted: true };
}

export function assertExecutionEventFence(current: CurrentExecutionFence, event: ExecutionEventFence): void {
  const decision = fenceExecutionEvent(current, event);
  if (!decision.accepted) throw new EpochError(`stale execution event: ${decision.reason}`);
}

export function isLateEventRejection(decision: FenceDecision): decision is LateEventRejection {
  return !decision.accepted;
}
