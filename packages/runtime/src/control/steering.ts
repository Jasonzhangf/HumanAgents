import {
  assertEvidenceRef,
  assertSameScope,
  type AgentClosure,
  type AgentDriver,
  type Checkpoint,
  type EvidenceRef,
  type ScopeRef,
  type StopRequestReceipt,
  type TaskId,
} from '../../../contracts/src/index.js';
import {
  assertCheckpointRecoveryResponsibility,
  assertSteerPermission,
  fenceExecutionEvent,
  planStopRequest,
  planStopSettle,
  type CurrentExecutionFence,
  type ExecutionEventFence,
} from '../../../core/src/index.js';
import { assertControlCommand, assertNoRequirementEnvelopePayload, ControlError, type RequestStopCommand, type SettleStopCommand } from './control-command.js';

export interface StopRequestResult {
  readonly state: 'settling';
  readonly receipt: StopRequestReceipt;
  readonly ownerId: string;
  readonly nextAction: { readonly kind: 'wait'; readonly ref: string };
}

export interface AgentStopRequestInput {
  readonly command: RequestStopCommand;
  readonly driver: AgentDriver;
  readonly currentOrganId: RequestStopCommand['organId'];
  readonly currentTaskId: RequestStopCommand['taskId'];
  readonly currentEpoch: number;
  readonly operationId: StopRequestReceipt['operationId'];
  readonly ownerId: string;
}

export interface StoppedCheckpointReceipt {
  readonly state: 'stopped';
  readonly checkpoint: Checkpoint;
  readonly closure: AgentClosure;
  readonly ownerId: string;
  readonly nextAction: Checkpoint['next'];
}

export interface PreparedStopSettlement {
  readonly runtimeId: string;
  readonly executionEpoch: number;
  readonly operationId: StopRequestReceipt['operationId'];
  readonly ownerId: string;
  readonly stopReceipt: StopRequestReceipt;
  readonly closure: AgentClosure;
  readonly checkpoint: Checkpoint;
}

export class StopSettlementCommitError extends ControlError {
  readonly prepared: PreparedStopSettlement;

  constructor(message: string, prepared: PreparedStopSettlement, cause: unknown) {
    super(message, { cause });
    this.name = 'StopSettlementCommitError';
    this.prepared = structuredClone(prepared);
  }
}

export type ControlExecutionEvent = ExecutionEventFence;

export interface CheckpointCommitPort {
  commit(input: Checkpoint): Promise<{ readonly checkpointId: Checkpoint['id']; readonly committed: true }>;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new ControlError(`${label} is required`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  Object.freeze(value);
  return value;
}

function stopEvidence(receipt: StopRequestReceipt, evidenceRefs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  if (!receipt.requested) throw new ControlError('agent driver did not accept stop request');
  if (evidenceRefs.length === 0) throw new ControlError('actual settle evidence is required');
  return evidenceRefs;
}

function assertStopEvidenceScope(scope: ScopeRef, evidenceRefs: readonly EvidenceRef[]): void {
  for (const evidenceRef of evidenceRefs) {
    try {
      assertEvidenceRef(evidenceRef);
    } catch (error) {
      throw new ControlError(error instanceof Error ? error.message : 'settle evidence reference is invalid');
    }
    try {
      assertSameScope(scope, evidenceRef.scope);
    } catch {
      throw new ControlError('settle evidence scope does not match stop checkpoint scope');
    }
  }
}

function requireTaskId(scope: ScopeRef): TaskId {
  if (!scope.taskId) throw new ControlError('control scope must include a task id');
  return scope.taskId;
}

function requireOperationId(scope: ScopeRef, operationId: { readonly scope: 'operation'; readonly value: string }): void {
  if (!scope.operationId) throw new ControlError('control scope must include an operation id');
  if (scope.operationId.value !== operationId.value) throw new ControlError('control scope operation id does not match stop operation');
}

function sameEvidence(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.evidenceId.value === right.evidenceId.value
    && left.kind === right.kind
    && left.source === right.source
    && left.locator === right.locator
    && left.digest === right.digest
    && left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId?.value === right.scope.taskId?.value
    && left.scope.cycleId?.value === right.scope.cycleId?.value
    && left.scope.operationId?.value === right.scope.operationId?.value;
}

export function assertPreparedStopSettlement(
  command: SettleStopCommand,
  recoveryStateRef: EvidenceRef,
  prepared: PreparedStopSettlement,
): void {
  if (prepared.runtimeId !== command.runtimeId
    || prepared.executionEpoch !== command.executionEpoch
    || prepared.operationId.value !== command.operationId.value
    || prepared.ownerId !== command.ownerId
    || prepared.checkpoint.seq !== command.checkpointSeq
    || prepared.checkpoint.directiveRevision !== command.directiveRevision
    || prepared.checkpoint.summary !== command.stopReason
    || prepared.checkpoint.cycleId.value !== command.cycleId.value
    || prepared.checkpoint.previousCheckpointId?.value !== command.previousCheckpoint?.id.value
    || !sameEvidence(prepared.checkpoint.recoveryStateRef, recoveryStateRef)) {
    throw new ControlError('prepared stop settlement does not match retry command');
  }
  try {
    assertSameScope(prepared.checkpoint.scope, command.scope);
  } catch {
    throw new ControlError('prepared stop settlement scope does not match retry command');
  }
  if (prepared.checkpoint.scope.operationId?.value !== command.operationId.value) {
    throw new ControlError('prepared stop settlement operation does not match retry command');
  }
  if (prepared.checkpoint.executionEpoch !== command.executionEpoch
    || prepared.checkpoint.outcome !== 'stopped'
    || prepared.checkpoint.next.kind !== 'stop'
    || prepared.checkpoint.next.ref !== command.stopReason
    || prepared.closure.state !== 'stopped'
    || !prepared.stopReceipt.requested
    || prepared.stopReceipt.operationId.value !== command.operationId.value) {
    throw new ControlError('prepared stop settlement is not a valid stopped closure and checkpoint');
  }
  const evidenceRefs = stopEvidence(prepared.stopReceipt, prepared.closure.evidenceRefs);
  assertStopEvidenceScope(command.scope, evidenceRefs);
  if (prepared.checkpoint.evidenceRefs.length !== evidenceRefs.length
    || prepared.checkpoint.evidenceRefs.some((evidence, index) => !sameEvidence(evidence, evidenceRefs[index]!))) {
    throw new ControlError('prepared stop settlement checkpoint evidence does not match stopped closure');
  }
  try {
    assertCheckpointRecoveryResponsibility({
      checkpoint: prepared.checkpoint,
      previous: command.previousCheckpoint,
      ownerId: command.ownerId,
    });
  } catch (error) {
    throw new ControlError(error instanceof Error ? error.message : 'prepared stop checkpoint recovery responsibility is invalid');
  }
}

export function fenceControlEvent(current: CurrentExecutionFence, event: ExecutionEventFence): boolean {
  const decision = fenceExecutionEvent(current, event);
  if (!decision.accepted) {
    throw new ControlError(`stale control event rejected: ${decision.reason}`);
  }
  return true;
}

export function validateAgentStopRequest(input: AgentStopRequestInput): void {
  assertControlCommand(input.command);
  assertNoRequirementEnvelopePayload(input.command);
  nonEmpty(input.command.runtimeId, 'runtime id');
  nonEmpty(input.ownerId, 'control owner');
  planStopRequest({
    source: input.command.source,
    actorKind: input.command.actorKind,
    hasStopPermission: input.command.hasStopPermission,
    targetEpoch: input.command.executionEpoch,
    currentEpoch: input.currentEpoch,
    targetOrganId: input.command.organId,
    currentOrganId: input.currentOrganId,
    targetTaskId: input.command.taskId,
    currentTaskId: input.currentTaskId,
    currentState: input.command.currentState,
  });
}

export async function requestAgentStop(input: AgentStopRequestInput): Promise<StopRequestResult> {
  validateAgentStopRequest(input);
  const receipt = await input.driver.requestStop({
    runtimeId: input.command.runtimeId,
    executionEpoch: input.command.executionEpoch,
    operationId: input.operationId,
  });
  if (!receipt.requested || receipt.operationId.value !== input.operationId.value) {
    throw new ControlError('agent driver stop receipt does not match operation');
  }
  return {
    state: 'settling',
    receipt,
    ownerId: input.ownerId,
    nextAction: { kind: 'wait', ref: `agent-settle:${input.command.runtimeId}:${input.command.executionEpoch}` },
  };
}

export async function settleAgentStop(input: {
  readonly command: SettleStopCommand;
  readonly stopRequestCommand: RequestStopCommand;
  readonly driver: AgentDriver;
  readonly stopReceipt: StopRequestReceipt;
  readonly checkpointPort: CheckpointCommitPort;
  readonly recoveryStateRef: EvidenceRef;
  readonly preparedSettlement?: PreparedStopSettlement;
}): Promise<StoppedCheckpointReceipt> {
  assertControlCommand(input.command);
  assertControlCommand(input.stopRequestCommand);
  assertNoRequirementEnvelopePayload(input.command);
  assertNoRequirementEnvelopePayload(input.stopRequestCommand);
  nonEmpty(input.command.ownerId, 'control owner');
  if (input.command.runtimeId !== input.stopRequestCommand.runtimeId) {
    throw new ControlError('settle-stop runtime does not match originating stop request');
  }
  if (input.command.executionEpoch !== input.stopRequestCommand.executionEpoch) {
    throw new ControlError('settle-stop execution epoch does not match originating stop request');
  }
  if (input.command.scope.organId.value !== input.stopRequestCommand.organId.value) {
    throw new ControlError('settle-stop organ does not match originating stop request');
  }
  if (input.command.scope.taskId?.value !== input.stopRequestCommand.taskId.value) {
    throw new ControlError('settle-stop task does not match originating stop request');
  }
  const taskId = requireTaskId(input.command.scope);
  requireOperationId(input.command.scope, input.command.operationId);
  if (!input.stopReceipt.requested || input.stopReceipt.operationId.value !== input.command.operationId.value) {
    throw new ControlError('stop receipt does not match stop operation');
  }
  if (input.preparedSettlement) {
    assertPreparedStopSettlement(input.command, input.recoveryStateRef, input.preparedSettlement);
    if (input.stopReceipt.operationId.value !== input.preparedSettlement.stopReceipt.operationId.value) {
      throw new ControlError('prepared stop settlement receipt does not match retry receipt');
    }
    return commitPreparedStopSettlement(input.checkpointPort, input.preparedSettlement, input.command.ownerId);
  }
  fenceControlEvent(
    { taskId, executionEpoch: input.command.executionEpoch },
    { taskId, executionEpoch: input.command.executionEpoch, operationId: input.command.operationId },
  );
  const closure = await input.driver.settle({
    runtimeId: input.command.runtimeId,
    executionEpoch: input.command.executionEpoch,
  });
  if (closure.state !== 'stopped') {
    throw new ControlError(`agent settle did not stop: ${closure.state}`);
  }
  if (input.stopReceipt.operationId.value !== input.command.operationId.value) {
    throw new ControlError('stop receipt operation does not match stop operation');
  }
  const evidenceRefs = stopEvidence(input.stopReceipt, closure.evidenceRefs);
  assertStopEvidenceScope(input.command.scope, evidenceRefs);
  planStopSettle({
    currentState: 'settling',
    operationId: input.command.operationId,
    evidenceRefs,
  });
  const checkpoint: Checkpoint = {
    id: { scope: 'checkpoint', value: `stopped-${input.command.operationId.value}-${input.command.checkpointSeq}` },
    scope: input.command.scope,
    cycleId: input.command.cycleId,
    seq: input.command.checkpointSeq,
    previousCheckpointId: input.command.previousCheckpoint?.id ?? null,
    directiveRevision: input.command.directiveRevision,
    executionEpoch: input.command.executionEpoch,
    outcome: 'stopped',
    summary: nonEmpty(input.command.stopReason, 'stop reason'),
    recoveryStateRef: input.recoveryStateRef,
    evidenceRefs,
    next: { kind: 'stop', ref: input.command.stopReason },
  };
  assertCheckpointRecoveryResponsibility({
    checkpoint,
    previous: input.command.previousCheckpoint,
    ownerId: input.command.ownerId,
  });
  return commitPreparedStopSettlement(input.checkpointPort, {
    runtimeId: input.command.runtimeId,
    executionEpoch: input.command.executionEpoch,
    operationId: input.command.operationId,
    ownerId: input.command.ownerId,
    stopReceipt: input.stopReceipt,
    closure,
    checkpoint,
  }, input.command.ownerId);
}

async function commitPreparedStopSettlement(
  checkpointPort: CheckpointCommitPort,
  prepared: PreparedStopSettlement,
  ownerId: string,
): Promise<StoppedCheckpointReceipt> {
  const canonicalPrepared = structuredClone(prepared);
  const submittedCheckpoint = deepFreeze(structuredClone(canonicalPrepared.checkpoint));
  try {
    const commit = await checkpointPort.commit(submittedCheckpoint);
    if (!commit.committed || commit.checkpointId.value !== canonicalPrepared.checkpoint.id.value) {
      throw new ControlError('stopped checkpoint was not committed');
    }
  } catch (failure) {
    throw new StopSettlementCommitError('stopped checkpoint commit failed', canonicalPrepared, failure);
  }
  return {
    state: 'stopped',
    checkpoint: structuredClone(canonicalPrepared.checkpoint),
    closure: structuredClone(canonicalPrepared.closure),
    ownerId,
    nextAction: structuredClone(canonicalPrepared.checkpoint.next),
  };
}
