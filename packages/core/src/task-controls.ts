import {
  validateCheckpointControlBusinessRequest,
  validateCheckpointControlGrant,
  validateCheckpointControlGrantRequest,
  validateCheckpointControlIntentConfirmation,
  validateCheckpointControlRevokeRequest,
  type CheckpointControlBusinessRequest,
  type CheckpointControlCapabilityRef,
  type CheckpointControlDenialReason,
  type CheckpointControlGrant,
  type CheckpointControlGrantRequest,
  type CheckpointControlIntentConfirmation,
  type CheckpointControlRevokeRequest,
} from '../../contracts/src/checkpoint-controls.js';
import type { TaskId } from '../../contracts/src/index.js';
import { CoreError } from './errors.js';

/**
 * Pure task-grant decisions. Inputs own all currentness: these functions read
 * no clock, config, session, constant, log or Journal.
 */

export interface TaskGrantIntentClassification {
  readonly outcome: 'intent-confirmed-only';
  readonly taskId: TaskId;
  readonly createsGrant: false;
}

export interface TaskGrantAccepted {
  readonly outcome: 'granted';
  readonly grant: CheckpointControlGrant;
}

export interface TaskRevokeAccepted {
  readonly outcome: 'revoked';
  readonly grant: CheckpointControlGrant;
}

/** Identical retry of an already-durable command: return the first result. */
export interface TaskGrantReplayed {
  readonly outcome: 'replayed';
  readonly grant: CheckpointControlGrant;
}

export interface TaskGrantRejected {
  readonly outcome: 'denied';
  readonly reason: CheckpointControlDenialReason;
}

export type TaskGrantDecision =
  | TaskGrantAccepted
  | TaskRevokeAccepted
  | TaskGrantReplayed
  | TaskGrantRejected;

export interface TaskBusinessAdmitted {
  readonly outcome: 'business-admitted';
  readonly allowed: true;
  readonly grantRevision: number;
  readonly grantRevisionString: string;
  readonly grantOwner: string;
}

export interface TaskBusinessDenied {
  readonly outcome: 'business-denied';
  readonly allowed: false;
  readonly reason: CheckpointControlDenialReason;
}

export type TaskBusinessAdmission = TaskBusinessAdmitted | TaskBusinessDenied;

function sameTask(left: TaskId, right: TaskId): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function sameCapability(left: CheckpointControlCapabilityRef, right: CheckpointControlCapabilityRef): boolean {
  return left.actionId === right.actionId
    && left.capabilities.length === right.capabilities.length
    && left.capabilities.every((capability, index) => capability === right.capabilities[index])
    && left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId?.value === right.scope.taskId?.value
    && left.scope.cycleId?.value === right.scope.cycleId?.value
    && left.scope.operationId?.value === right.scope.operationId?.value;
}

function capabilityMismatch(
  granted: CheckpointControlCapabilityRef,
  requested: CheckpointControlCapabilityRef,
): CheckpointControlDenialReason | undefined {
  if (granted.actionId !== requested.actionId) return 'wrong-action';
  if (!requested.capabilities.every((capability) => granted.capabilities.includes(capability))) {
    return 'wrong-capability';
  }
  const left = granted.scope;
  const right = requested.scope;
  if (
    left.organId.value !== right.organId.value
    || left.taskId?.value !== right.taskId?.value
    || left.cycleId?.value !== right.cycleId?.value
    || left.operationId?.value !== right.operationId?.value
  ) {
    return 'wrong-scope';
  }
  return undefined;
}

/** A confirmed Task submit intent is a business fact and never creates a grant. */
export function classifyTaskGrantIntent(
  confirmation: CheckpointControlIntentConfirmation,
): TaskGrantIntentClassification {
  validateCheckpointControlIntentConfirmation(confirmation);
  return { outcome: 'intent-confirmed-only', taskId: confirmation.taskId, createsGrant: false };
}

export function grantCheckpointControl(input: {
  readonly request: CheckpointControlGrantRequest;
  readonly current?: CheckpointControlGrant;
  readonly updatedAt: string;
}): TaskGrantDecision {
  validateCheckpointControlGrantRequest(input.request);
  const { request, current } = input;
  if (current === undefined) {
    if (request.expectedRevision !== 0) return { outcome: 'denied', reason: 'stale-revision' };
  } else {
    validateCheckpointControlGrant(current);
    if (!sameTask(current.task, request.taskId)) return { outcome: 'denied', reason: 'wrong-task' };
    if (current.requestId === request.requestId) {
      if (current.state === 'granted' && sameCapability(current.capability, request.capability) && current.owner === request.owner) {
        return { outcome: 'replayed', grant: current };
      }
      return { outcome: 'denied', reason: 'conflicting-intent' };
    }
    if (request.expectedRevision !== current.revision) return { outcome: 'denied', reason: 'stale-revision' };
  }
  return {
    outcome: 'granted',
    grant: {
      revision: (current?.revision ?? 0) + 1,
      requestId: request.requestId,
      task: request.taskId,
      owner: request.owner,
      capability: request.capability,
      state: 'granted',
      updatedAt: input.updatedAt,
    },
  };
}

export function revokeCheckpointControl(input: {
  readonly request: CheckpointControlRevokeRequest;
  readonly current?: CheckpointControlGrant;
  readonly updatedAt: string;
}): TaskGrantDecision {
  validateCheckpointControlRevokeRequest(input.request);
  const { request, current } = input;
  if (current === undefined) return { outcome: 'denied', reason: 'missing-grant' };
  validateCheckpointControlGrant(current);
  if (!sameTask(current.task, request.taskId)) return { outcome: 'denied', reason: 'wrong-task' };
  if (current.requestId === request.requestId) {
    if (current.state === 'revoked' && current.owner === request.owner) return { outcome: 'replayed', grant: current };
    return { outcome: 'denied', reason: 'conflicting-intent' };
  }
  if (current.state === 'revoked') return { outcome: 'denied', reason: 'revoked' };
  if (request.expectedRevision !== current.revision) return { outcome: 'denied', reason: 'stale-revision' };
  return {
    outcome: 'revoked',
    grant: {
      ...current,
      revision: current.revision + 1,
      requestId: request.requestId,
      owner: request.owner,
      state: 'revoked',
      updatedAt: input.updatedAt,
    },
  };
}

/**
 * New-business admission from the exact current grant. `current` is `undefined`
 * only when the durable read is unknown (a hold): it is never treated as
 * absence, and no cache, constant or caller revision can stand in for it.
 */
/**
 * Shared pure action comparison: the declared task, owner, capability and
 * active state of one current grant against one requested action. It makes no
 * Journal read, forms no business request, and creates no registration. The
 * business admission and the control reentry check use this same comparison so
 * neither side drifts into its own copy.
 */
export function validateTaskGrantAction(input: {
  readonly request: Pick<
    CheckpointControlBusinessRequest,
    'taskId' | 'owner' | 'capability'
  >;
  readonly current: CheckpointControlGrant | null | undefined;
}): TaskBusinessAdmission {
  const { request, current } = input;
  if (current === undefined) return { outcome: 'business-denied', allowed: false, reason: 'current-unknown' };
  if (current === null) return { outcome: 'business-denied', allowed: false, reason: 'missing-grant' };
  validateCheckpointControlGrant(current);
  if (!sameTask(current.task, request.taskId)) return { outcome: 'business-denied', allowed: false, reason: 'wrong-task' };
  if (current.owner !== request.owner) return { outcome: 'business-denied', allowed: false, reason: 'wrong-owner' };
  if (current.state === 'revoked') return { outcome: 'business-denied', allowed: false, reason: 'revoked' };
  const capability = capabilityMismatch(current.capability, request.capability);
  if (capability !== undefined) return { outcome: 'business-denied', allowed: false, reason: capability };
  return {
    outcome: 'business-admitted',
    allowed: true,
    grantRevision: current.revision,
    grantRevisionString: String(current.revision),
    grantOwner: current.owner,
  };
}

export function validateTaskGrantAdmission(input: {
  readonly request: CheckpointControlBusinessRequest;
  readonly current: CheckpointControlGrant | null | undefined;
}): TaskBusinessAdmission {
  validateCheckpointControlBusinessRequest(input.request);
  return validateTaskGrantAction({ request: input.request, current: input.current });
}

/**
 * Derives the only new-business authority: the actual grant owner and
 * `String(actual revision)`. The verified principal must match the grant
 * owner; a numeric revision string is never a separate authorization.
 */
export function validateTaskGrantSnapshot(input: {
  readonly grant: CheckpointControlGrant | null;
  readonly principalOwner: string;
}): { readonly grant: CheckpointControlGrant; readonly permissionRevision: string } {
  if (!input.principalOwner.trim()) throw new CoreError('verified principal owner is required');
  const grant = input.grant;
  if (grant === null) throw new CoreError('task grant is missing');
  validateCheckpointControlGrant(grant);
  if (grant.state !== 'granted') throw new CoreError('task grant is not active');
  if (grant.owner !== input.principalOwner) throw new CoreError('task grant owner does not match the verified principal');
  return { grant, permissionRevision: String(grant.revision) };
}
