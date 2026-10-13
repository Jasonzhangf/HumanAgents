import { ContractError } from './errors.js';
import { assertScope, type ScopeRef, type TaskId } from './index.js';

/**
 * Minimal task-scoped authorization contracts. Business intent and execution
 * permission are separate facts: a confirmed Task submit intent does not
 * become a `CheckpointControlGrant` by itself. The exact Journal commit of a
 * grant belongs to the Runtime readback, not to this structural contract.
 */

export type CheckpointControlGrantState = 'granted' | 'revoked';

export type CheckpointControlDenialReason =
  | 'task-intent-only'
  | 'missing-grant'
  | 'wrong-task'
  | 'wrong-scope'
  | 'wrong-action'
  | 'wrong-capability'
  | 'wrong-owner'
  | 'revoked'
  | 'stale-revision'
  | 'conflicting-intent'
  | 'current-unknown';

/** Task-scoped action plus the capabilities that action may exercise. */
export interface CheckpointControlCapabilityRef {
  readonly actionId: string;
  readonly capabilities: readonly string[];
  readonly scope: ScopeRef;
}

/** Immutable identity of one submitted business or control intent. */
export interface CheckpointControlInputIdentity {
  readonly requestRef: string;
  readonly digest: string;
}

/** User-confirmed Task submit intent. It grants no execution authority. */
export interface CheckpointControlIntentConfirmation {
  readonly confirmationId: string;
  readonly taskId: TaskId;
  readonly inputIdentity: CheckpointControlInputIdentity;
  readonly confirmedBy: string;
}

export interface CheckpointControlGrantRequest {
  readonly requestId: string;
  readonly taskId: TaskId;
  readonly owner: string;
  readonly capability: CheckpointControlCapabilityRef;
  readonly expectedRevision: number;
}

export interface CheckpointControlRevokeRequest {
  readonly requestId: string;
  readonly taskId: TaskId;
  readonly owner: string;
  readonly expectedRevision: number;
}

/** Request to begin new business under an already durable task grant. */
export interface CheckpointControlBusinessRequest {
  readonly requestRef: string;
  readonly taskId: TaskId;
  readonly owner: string;
  readonly capability: CheckpointControlCapabilityRef;
  readonly inputIdentity: CheckpointControlInputIdentity;
}

/** Latest durable grant fact for a task. The commit lives on the readback. */
export interface CheckpointControlGrant {
  readonly revision: number;
  readonly requestId: string;
  readonly task: TaskId;
  readonly owner: string;
  readonly capability: CheckpointControlCapabilityRef;
  readonly state: CheckpointControlGrantState;
  readonly updatedAt: string;
}

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError(`${label} must be an object`);
  }
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError(`${label} must be a non-empty string`);
}

function revision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContractError(`${label} must be a non-negative safe integer`);
  }
}

function timestamp(value: unknown, label: string): asserts value is string {
  text(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new ContractError(`${label} must be a valid timestamp`);
}

function stringList(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ContractError(`${label} must not be empty`);
  for (const entry of value) text(entry, `${label} entry`);
}

function inputIdentity(value: unknown, label: string): asserts value is CheckpointControlInputIdentity {
  record(value, label);
  text(value.requestRef, `${label} requestRef`);
  text(value.digest, `${label} digest`);
}

export function validateCheckpointControlCapabilityRef(
  capability: CheckpointControlCapabilityRef,
  label = 'task grant capability',
): void {
  record(capability, label);
  text(capability.actionId, `${label} actionId`);
  stringList(capability.capabilities, `${label} capabilities`);
  record(capability.scope, `${label} scope`);
  assertScope(capability.scope.organId, 'organ');
  const taskId = capability.scope.taskId;
  if (taskId === undefined) throw new ContractError(`${label} must be task-scoped`);
  assertScope(taskId, 'task');
  if (capability.scope.cycleId !== undefined) assertScope(capability.scope.cycleId, 'cycle');
  if (capability.scope.operationId !== undefined) assertScope(capability.scope.operationId, 'operation');
}

export function validateCheckpointControlIntentConfirmation(
  confirmation: CheckpointControlIntentConfirmation,
): void {
  record(confirmation, 'task grant intent confirmation');
  text(confirmation.confirmationId, 'task grant intent confirmationId');
  assertScope(confirmation.taskId, 'task');
  inputIdentity(confirmation.inputIdentity, 'task grant intent inputIdentity');
  text(confirmation.confirmedBy, 'task grant intent confirmedBy');
}

export function validateCheckpointControlGrantRequest(request: CheckpointControlGrantRequest): void {
  record(request, 'task grant request');
  text(request.requestId, 'task grant requestId');
  assertScope(request.taskId, 'task');
  text(request.owner, 'task grant owner');
  validateCheckpointControlCapabilityRef(request.capability);
  const scopedTask = request.capability.scope.taskId;
  if (scopedTask === undefined || scopedTask.value !== request.taskId.value) {
    throw new ContractError('task grant capability scope does not match taskId');
  }
  revision(request.expectedRevision, 'task grant expectedRevision');
}

export function validateCheckpointControlRevokeRequest(request: CheckpointControlRevokeRequest): void {
  record(request, 'task grant revoke request');
  text(request.requestId, 'task grant revoke requestId');
  assertScope(request.taskId, 'task');
  text(request.owner, 'task grant revoke owner');
  revision(request.expectedRevision, 'task grant revoke expectedRevision');
}

export function validateCheckpointControlBusinessRequest(request: CheckpointControlBusinessRequest): void {
  record(request, 'task grant business request');
  text(request.requestRef, 'task grant business requestRef');
  assertScope(request.taskId, 'task');
  text(request.owner, 'task grant business owner');
  validateCheckpointControlCapabilityRef(request.capability);
  const scopedTask = request.capability.scope.taskId;
  if (scopedTask === undefined || scopedTask.value !== request.taskId.value) {
    throw new ContractError('task grant business capability scope does not match taskId');
  }
  inputIdentity(request.inputIdentity, 'task grant business inputIdentity');
}

export function validateCheckpointControlGrant(grant: CheckpointControlGrant): void {
  record(grant, 'task grant');
  revision(grant.revision, 'task grant revision');
  text(grant.requestId, 'task grant requestId');
  assertScope(grant.task, 'task');
  text(grant.owner, 'task grant owner');
  validateCheckpointControlCapabilityRef(grant.capability);
  if (grant.capability.scope.taskId?.value !== grant.task.value) {
    throw new ContractError('task grant capability scope does not match grant task');
  }
  if (grant.state !== 'granted' && grant.state !== 'revoked') throw new ContractError('task grant state is invalid');
  timestamp(grant.updatedAt, 'task grant updatedAt');
}
