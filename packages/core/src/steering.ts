import {
  assertExecutionEpoch,
  type EvidenceRef,
  type LifecycleState,
  type OperationId,
  type OrganId,
  type TaskId,
} from '../../contracts/src/index.js';
import { PermissionError } from './errors.js';
import { assertTransitionLifecycle } from './lifecycle.js';

export type ControlSource = 'control' | 'business-payload' | 'agent' | 'ui-business';
export type SteerActorKind = 'human-operator' | 'harness-control' | 'agent' | 'plugin';
export interface SteerPermissionInput {
  readonly source: ControlSource;
  readonly actorKind: SteerActorKind;
  readonly hasStopPermission: boolean;
  readonly targetEpoch: number;
  readonly currentEpoch: number;
  readonly targetOrganId: OrganId;
  readonly currentOrganId: OrganId;
  readonly targetTaskId: TaskId;
  readonly currentTaskId: TaskId;
  readonly currentState: LifecycleState;
}

export interface StopRequestPlan {
  readonly intent: 'request-stop';
  readonly state: 'settling';
}

export interface StopSettlePlan {
  readonly intent: 'settle-stop';
  readonly state: 'stopped';
  readonly operationId: OperationId;
  readonly evidenceRefs: readonly EvidenceRef[];
}

const STOP_REQUEST_STATES: readonly LifecycleState[] = ['admitted', 'running', 'waiting', 'blocked'];

function sameId(left: { readonly scope: string; readonly value: string }, right: { readonly scope: string; readonly value: string }): boolean {
  return left.scope === right.scope && left.value === right.value;
}

export function assertSteerPermission(input: SteerPermissionInput): void {
  assertExecutionEpoch(input.targetEpoch);
  assertExecutionEpoch(input.currentEpoch);
  if (input.source !== 'control') throw new PermissionError('steer must use the control channel');
  if (input.actorKind !== 'human-operator' && input.actorKind !== 'harness-control') {
    throw new PermissionError('actor is not authorized to steer');
  }
  if (!input.hasStopPermission) throw new PermissionError('stop permission is required');
  if (!sameId(input.targetOrganId, input.currentOrganId)) throw new PermissionError('steer target organ does not match current organ');
  if (!sameId(input.targetTaskId, input.currentTaskId)) throw new PermissionError('steer target task does not match current task');
  if (input.targetEpoch !== input.currentEpoch) throw new PermissionError('steer target epoch does not match current execution');
  if (!STOP_REQUEST_STATES.includes(input.currentState)) {
    throw new PermissionError(`cannot request stop from ${input.currentState}`);
  }
}

export function planStopRequest(input: SteerPermissionInput): StopRequestPlan {
  assertSteerPermission(input);
  assertTransitionLifecycle(input.currentState, 'settling');
  return { intent: 'request-stop', state: 'settling' };
}

export function assertStopSettleEvidence(evidenceRefs: readonly EvidenceRef[], operationId: OperationId): void {
  if (!operationId.value) throw new PermissionError('stop operation is required');
  if (evidenceRefs.length === 0) throw new PermissionError('actual settle evidence is required before stopped');
  for (const evidence of evidenceRefs) {
    if (!evidence.source.trim() || !evidence.locator.trim()) throw new PermissionError('settle evidence must identify its source and locator');
  }
}

export function planStopSettle(input: {
  readonly currentState: LifecycleState;
  readonly operationId: OperationId;
  readonly evidenceRefs: readonly EvidenceRef[];
}): StopSettlePlan {
  assertTransitionLifecycle(input.currentState, 'stopped');
  assertStopSettleEvidence(input.evidenceRefs, input.operationId);
  return {
    intent: 'settle-stop',
    state: 'stopped',
    operationId: input.operationId,
    evidenceRefs: input.evidenceRefs,
  };
}

export function stopRequestIsStopped(): false {
  return false;
}
