import type {
  AgentDriver,
  Checkpoint,
  EvidenceRef,
  OperationId,
  OrganId,
  ScopeRef,
  TaskId,
} from '../../../contracts/src/index.js';
import { assertCheckpointRecoveryStateRef } from '../../../core/src/index.js';
import type { AttentionPort } from './attention.js';
import { publishRequiredAttention, resolveAttention } from './attention.js';
import { assertControlCommand, ControlError, type RequestStopCommand, type SettleStopCommand } from './control-command.js';
import type { AgentRuntime } from '../nodes/agent-runtime.js';
import {
  requestAgentStop,
  settleAgentStop,
  assertPreparedStopSettlement,
  validateAgentStopRequest,
  StopSettlementCommitError,
  type CheckpointCommitPort,
  type StoppedCheckpointReceipt,
} from './steering.js';

export interface StopControlInput {
  readonly command: RequestStopCommand;
  readonly driver: AgentDriver;
  readonly checkpointPort: CheckpointCommitPort;
  readonly attentionPort: AttentionPort;
  readonly currentOrganId: OrganId;
  readonly currentTaskId: TaskId;
  readonly currentEpoch: number;
  readonly operationId: OperationId;
  readonly scope: ScopeRef;
  readonly cycleId: { readonly scope: 'cycle'; readonly value: string };
  readonly ownerId: string;
  readonly previousCheckpoint: Checkpoint | null;
  readonly checkpointSeq: number;
  readonly directiveRevision: number;
  readonly stopReason: string;
  readonly recoveryStateRef: EvidenceRef;
  readonly runtime: AgentRuntime;
}

export type StopControlResult =
  | (StoppedCheckpointReceipt & {
      readonly attentionResolution?: {
        readonly state: 'pending';
        readonly attentionId: string;
        readonly ownerId: string;
        readonly nextAction: { readonly kind: 'recover'; readonly ref: string };
        readonly failure: unknown;
      };
    })
  | {
      readonly state: 'settling';
      readonly ownerId: string;
      readonly nextAction: { readonly kind: 'wait'; readonly ref: string };
      readonly failure: unknown;
      readonly attentionId: string;
    };

function assertStopScope(input: StopControlInput): void {
  if (!input.scope.organId || input.scope.organId.value !== input.command.organId.value) {
    throw new ControlError('stop scope organ does not match originating stop request');
  }
  if (!input.scope.taskId || input.scope.taskId.value !== input.currentTaskId.value) {
    throw new ControlError('stop scope task does not match originating stop request');
  }
  if (!input.scope.cycleId || input.scope.cycleId.value !== input.cycleId.value) {
    throw new ControlError('stop scope cycle does not match stop cycle');
  }
  if (!input.scope.operationId || input.scope.operationId.value !== input.operationId.value) {
    throw new ControlError('stop scope operation does not match originating stop request');
  }
}

function settleCommandFor(input: StopControlInput): SettleStopCommand {
  return {
    source: 'control',
    command: 'steer.settle-stop',
    runtimeId: input.command.runtimeId,
    executionEpoch: input.command.executionEpoch,
    operationId: input.operationId,
    scope: input.scope,
    cycleId: input.cycleId,
    ownerId: input.ownerId,
    previousCheckpoint: input.previousCheckpoint,
    checkpointSeq: input.checkpointSeq,
    directiveRevision: input.directiveRevision,
    stopReason: input.stopReason,
  };
}

function canonicalStopControlInput(input: StopControlInput): StopControlInput {
  return {
    ...input,
    command: deepFreeze(structuredClone(input.command)),
    currentOrganId: structuredClone(input.currentOrganId),
    currentTaskId: structuredClone(input.currentTaskId),
    operationId: structuredClone(input.operationId),
    scope: deepFreeze(structuredClone(input.scope)),
    cycleId: deepFreeze(structuredClone(input.cycleId)),
    ownerId: input.ownerId,
    previousCheckpoint: input.previousCheckpoint ? deepFreeze(structuredClone(input.previousCheckpoint)) : null,
    stopReason: input.stopReason,
    recoveryStateRef: deepFreeze(structuredClone(input.recoveryStateRef)),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  Object.freeze(value);
  return value;
}

export async function resolvePendingStopAttention(input: {
  readonly runtime: AgentRuntime;
  readonly operationId: OperationId;
  readonly attentionPort: AttentionPort;
  readonly scope: ScopeRef;
  readonly ownerId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}): Promise<
  | { readonly state: 'resolved'; readonly attentionId: string }
  | { readonly state: 'pending'; readonly attentionId: string; readonly ownerId: string; readonly nextAction: { readonly kind: 'recover'; readonly ref: string }; readonly failure: unknown }
> {
  const attentionId = input.runtime.stopAttention(input.operationId);
  if (!attentionId) throw new ControlError('stop attention resolution has no pending attention');
  const boundScope = structuredClone(input.scope);
  const boundEvidenceRefs = structuredClone(input.evidenceRefs);
  input.runtime.assertStopAttentionResolutionBinding(input.operationId, boundScope, input.ownerId, boundEvidenceRefs);
  input.runtime.claimStopAttentionResolution(input.operationId);
  const nextAction = { kind: 'recover' as const, ref: `stop-attention-resolution:${input.operationId.value}` };
  const pending = (failure: unknown) => ({
    state: 'pending' as const,
    attentionId,
    ownerId: input.ownerId,
    nextAction,
    failure,
  });
  try {
    if (!input.runtime.isStopAttentionResolved(input.operationId)) {
      try {
        await resolveAttention(input.attentionPort, {
          attentionId,
          scope: deepFreeze(structuredClone(boundScope)),
          severity: 'blocker',
          state: 'resolved',
          message: 'stop operation recovered and completed',
          evidenceRefs: deepFreeze(structuredClone(boundEvidenceRefs)),
        });
        input.runtime.markStopAttentionResolved(input.operationId);
      } catch (failure) {
        const originalFailure = input.runtime.stopAttentionResolutionFailure(input.operationId) ?? failure;
        let resolutionAttention = input.runtime.pendingStopAttentionResolution(input.operationId);
        if (!resolutionAttention) {
          if (input.runtime.stopAttentionResolutionAttention(input.operationId)) {
            return pending(new ControlError(
              'stop attention resolution remains open and is awaiting closure',
              { cause: originalFailure },
            ));
          }
          const resolutionAttentionId = `stop-attention-resolution-${input.operationId.value}`;
          resolutionAttention = {
            attentionId: resolutionAttentionId,
            scope: structuredClone(boundScope),
            severity: 'blocker',
            state: 'open',
            message: originalFailure instanceof Error ? originalFailure.message : 'stop attention resolution failed',
            evidenceRefs: structuredClone(boundEvidenceRefs),
            ownerId: input.ownerId,
            nextAction,
            relatedAttentionId: attentionId,
          } as const;
          input.runtime.beginStopAttentionResolution(input.operationId, resolutionAttention, originalFailure);
        }
        if (input.runtime.stopAttentionResolution(input.operationId) === undefined) {
          const claimed = input.runtime.claimStopAttentionResolutionPublication(input.operationId);
          try {
            await publishRequiredAttention(input.attentionPort, claimed);
            input.runtime.markStopAttentionResolutionPublished(input.operationId);
          } catch (publicationFailure) {
            input.runtime.markStopAttentionResolutionPublicationFailed(input.operationId, publicationFailure);
            return pending(new ControlError(
              `${originalFailure instanceof Error ? originalFailure.message : String(originalFailure)}; resolution publication failed: ${publicationFailure instanceof Error ? publicationFailure.message : String(publicationFailure)}`,
              { cause: originalFailure, publicationFailure },
            ));
          }
        }
        return pending(new ControlError(
          'stop attention resolution is published and awaiting closure',
          { cause: originalFailure },
        ));
      }
    }
    const pendingResolutionAttention = input.runtime.pendingStopAttentionResolution(input.operationId);
    if (pendingResolutionAttention) {
      const claimed = input.runtime.claimStopAttentionResolutionPublication(input.operationId);
      try {
        await publishRequiredAttention(input.attentionPort, claimed);
        input.runtime.markStopAttentionResolutionPublished(input.operationId);
      } catch (publicationFailure) {
        input.runtime.markStopAttentionResolutionPublicationFailed(input.operationId, publicationFailure);
        const originalFailure = input.runtime.stopAttentionResolutionFailure(input.operationId) ?? publicationFailure;
        return pending(new ControlError(
          `${originalFailure instanceof Error ? originalFailure.message : String(originalFailure)}; resolution publication failed: ${publicationFailure instanceof Error ? publicationFailure.message : String(publicationFailure)}`,
          { cause: originalFailure, publicationFailure },
        ));
      }
    }
    const resolutionAttentionId = input.runtime.stopAttentionResolution(input.operationId);
    if (resolutionAttentionId) {
      try {
        await resolveAttention(input.attentionPort, {
          attentionId: resolutionAttentionId,
          scope: deepFreeze(structuredClone(boundScope)),
          severity: 'blocker',
          state: 'resolved',
          message: 'stop attention resolution recovered and completed',
          evidenceRefs: deepFreeze(structuredClone(boundEvidenceRefs)),
          ownerId: input.ownerId,
          nextAction,
          relatedAttentionId: attentionId,
        });
        input.runtime.markStopAttentionResolutionResolved(input.operationId);
      } catch (failure) {
        const originalFailure = input.runtime.stopAttentionResolutionFailure(input.operationId) ?? failure;
        return pending(new ControlError(
          `${originalFailure instanceof Error ? originalFailure.message : String(originalFailure)}; resolution closure failed: ${failure instanceof Error ? failure.message : String(failure)}`,
          { cause: originalFailure, publicationFailure: failure },
        ));
      }
    }
    input.runtime.clearStopAttention(input.operationId);
    return { state: 'resolved', attentionId };
  } finally {
    input.runtime.releaseStopAttentionResolution(input.operationId);
  }
}

export async function publishPendingStopAttention(input: {
  readonly runtime: AgentRuntime;
  readonly operationId: OperationId;
  readonly attentionPort: AttentionPort;
}): Promise<{ readonly state: 'published'; readonly attentionId: string } | { readonly state: 'pending'; readonly attentionId: string; readonly failure: unknown }> {
  const attention = input.runtime.pendingStopAttention(input.operationId);
  if (!attention) throw new ControlError('stop attention publication has no pending attention');
  const claimedAttention = input.runtime.claimStopAttentionPublication(input.operationId);
  try {
    await publishRequiredAttention(input.attentionPort, claimedAttention);
    input.runtime.markStopAttentionPublished(input.operationId);
    input.runtime.markStopRetryable(input.operationId);
    return { state: 'published', attentionId: claimedAttention.attentionId };
  } catch (failure) {
    input.runtime.recordStopAttentionPublicationFailure(input.operationId, failure);
    input.runtime.markStopAttentionPublicationFailed(input.operationId);
    const originalFailure = input.runtime.stopAttentionOriginalFailure(input.operationId) ?? failure;
    return {
      state: 'pending',
      attentionId: claimedAttention.attentionId,
      failure: new ControlError(
        `${originalFailure instanceof Error ? originalFailure.message : String(originalFailure)}; attention publication failed: ${failure instanceof Error ? failure.message : String(failure)}`,
        { cause: originalFailure, publicationFailure: failure },
      ),
    };
  }
}

export async function executeStopControl(input: StopControlInput): Promise<StopControlResult> {
  const boundInput = canonicalStopControlInput(input);
  assertStopScope(boundInput);
  boundInput.runtime.assertStopTarget(boundInput.command.runtimeId, boundInput.command.taskId, boundInput.command.executionEpoch);
  validateAgentStopRequest({
    command: boundInput.command,
    driver: boundInput.driver,
    currentOrganId: boundInput.currentOrganId,
    currentTaskId: boundInput.currentTaskId,
    currentEpoch: boundInput.currentEpoch,
    operationId: boundInput.operationId,
    ownerId: boundInput.ownerId,
  });
  const settleCommand = settleCommandFor(boundInput);
  assertControlCommand(settleCommand);
  try {
    assertCheckpointRecoveryStateRef(boundInput.scope, boundInput.recoveryStateRef);
  } catch (error) {
    throw new ControlError(error instanceof Error ? error.message : 'stop recovery state reference is invalid');
  }
  boundInput.runtime.assertDriverBinding(boundInput.driver);
  const retrying = boundInput.runtime.isStopRetryable(boundInput.operationId);
  const pendingSettlement = boundInput.runtime.pendingStopSettlement(boundInput.operationId);
  if (pendingSettlement) assertPreparedStopSettlement(settleCommand, boundInput.recoveryStateRef, pendingSettlement);
  boundInput.runtime.beginStop(boundInput.command.runtimeId, boundInput.command.executionEpoch, boundInput.operationId, boundInput.ownerId, boundInput.scope);
  let request: Awaited<ReturnType<typeof requestAgentStop>>;
  if (pendingSettlement) {
    request = {
      state: 'settling',
      receipt: pendingSettlement.stopReceipt,
      ownerId: boundInput.ownerId,
      nextAction: { kind: 'wait', ref: `agent-settle:${boundInput.command.runtimeId}:${boundInput.command.executionEpoch}` },
    };
  } else try {
    request = await requestAgentStop({
        command: boundInput.command,
        driver: boundInput.driver,
        currentOrganId: boundInput.currentOrganId,
        currentTaskId: boundInput.currentTaskId,
        currentEpoch: boundInput.currentEpoch,
        operationId: boundInput.operationId,
        ownerId: boundInput.ownerId,
      });
  } catch (failure) {
    const attentionId = `stop-pending-${boundInput.operationId.value}`;
    const attention = {
      attentionId,
      scope: boundInput.scope,
      severity: 'blocker',
      state: 'open',
      message: failure instanceof Error ? failure.message : 'stop request failed',
      evidenceRefs: [],
      ownerId: boundInput.ownerId,
      nextAction: { kind: 'wait', ref: `agent-settle:${boundInput.command.runtimeId}:${boundInput.command.executionEpoch}` },
    } as const;
    boundInput.runtime.recordStopAttention(boundInput.operationId, attention, failure);
    const publication = await publishPendingStopAttention({ runtime: boundInput.runtime, operationId: boundInput.operationId, attentionPort: boundInput.attentionPort });
    return {
      state: 'settling',
      ownerId: boundInput.ownerId,
      nextAction: publication.state === 'published'
        ? { kind: 'wait', ref: `agent-settle:${boundInput.command.runtimeId}:${boundInput.command.executionEpoch}` }
        : { kind: 'wait', ref: `stop-attention-publication:${boundInput.operationId.value}` },
      failure: publication.state === 'published'
        ? failure instanceof Error ? failure : new ControlError(String(failure))
        : new ControlError(`${failure instanceof Error ? failure.message : String(failure)}; attention publication failed: ${publication.failure instanceof Error ? publication.failure.message : String(publication.failure)}`, { cause: failure, publicationFailure: publication.failure }),
      attentionId,
    };
  }
  let receipt: StoppedCheckpointReceipt;
  if (pendingSettlement?.checkpointCommitted) {
    if (pendingSettlement.recovery) {
      throw new StopSettlementCommitError(
        'stopped checkpoint committed but post-commit recovery failed',
        pendingSettlement,
        undefined,
        { checkpointCommitted: true, recovery: pendingSettlement.recovery },
      );
    }
    receipt = {
      state: 'stopped',
      checkpoint: structuredClone(pendingSettlement.checkpoint),
      closure: structuredClone(pendingSettlement.closure),
      ownerId: pendingSettlement.ownerId,
      nextAction: structuredClone(pendingSettlement.checkpoint.next),
    };
  } else try {
      receipt = await settleAgentStop({
        command: settleCommand,
        driver: boundInput.driver,
        stopRequestCommand: boundInput.command,
        stopReceipt: request.receipt,
        checkpointPort: boundInput.checkpointPort,
        recoveryStateRef: boundInput.recoveryStateRef,
        preparedSettlement: pendingSettlement,
      });
    } catch (failure) {
      if (failure instanceof StopSettlementCommitError) {
        if (failure.checkpointCommitted) {
          boundInput.runtime.recordStopSettlement(
            boundInput.operationId,
            { ...failure.prepared, ...(failure.recovery ? { recovery: failure.recovery } : {}) },
            true,
          );
          if (!failure.recovery) throw new ControlError('committed stop settlement is missing post-commit recovery');
          throw failure;
        }
        boundInput.runtime.recordStopSettlement(boundInput.operationId, failure.prepared);
      }
      const attentionId = `stop-pending-${boundInput.operationId.value}`;
      const attention = {
        attentionId,
        scope: boundInput.scope,
        severity: 'blocker',
        state: 'open',
        message: failure instanceof Error ? failure.message : 'stop settle failed',
        evidenceRefs: [],
        ownerId: boundInput.ownerId,
        nextAction: request.nextAction,
      } as const;
      boundInput.runtime.recordStopAttention(boundInput.operationId, attention, failure);
      const publication = await publishPendingStopAttention({ runtime: boundInput.runtime, operationId: boundInput.operationId, attentionPort: boundInput.attentionPort });
      return {
        state: 'settling',
        ownerId: boundInput.ownerId,
        nextAction: publication.state === 'published'
          ? request.nextAction
          : { kind: 'wait', ref: `stop-attention-publication:${boundInput.operationId.value}` },
        failure: publication.state === 'published'
          ? failure instanceof Error ? failure : new ControlError(String(failure))
          : new ControlError(`${failure instanceof Error ? failure.message : String(failure)}; attention publication failed: ${publication.failure instanceof Error ? publication.failure.message : String(publication.failure)}`, { cause: failure, publicationFailure: publication.failure }),
        attentionId,
      };
    }
  const previousAttentionId = retrying ? boundInput.runtime.stopAttentionForCompletion(boundInput.operationId) : undefined;
  try {
    boundInput.runtime.markStopped(boundInput.operationId, receipt.closure);
  } catch (failure) {
    boundInput.runtime.recordStopSettlement(boundInput.operationId, {
      runtimeId: boundInput.command.runtimeId,
      executionEpoch: boundInput.command.executionEpoch,
      operationId: boundInput.operationId,
      ownerId: boundInput.ownerId,
      stopReceipt: request.receipt,
      closure: receipt.closure,
      checkpoint: receipt.checkpoint,
    }, true);
    const attentionId = previousAttentionId ?? `stop-runtime-mismatch-${boundInput.operationId.value}`;
    const attention = {
      attentionId,
      scope: boundInput.scope,
      severity: 'blocker',
      state: 'open',
      message: failure instanceof Error ? failure.message : 'stopped checkpoint committed but agent runtime could not close',
      evidenceRefs: [],
      ownerId: boundInput.ownerId,
      nextAction: { kind: 'recover', ref: `stop-runtime-mismatch:${boundInput.operationId.value}` },
    } as const;
    boundInput.runtime.recordStopAttention(boundInput.operationId, attention, failure);
    const publication = await publishPendingStopAttention({
      runtime: boundInput.runtime,
      operationId: boundInput.operationId,
      attentionPort: boundInput.attentionPort,
    });
    if (publication.state === 'pending') {
      return {
        state: 'settling',
        ownerId: boundInput.ownerId,
        nextAction: { kind: 'wait', ref: `stop-attention-publication:${boundInput.operationId.value}` },
        failure: publication.failure,
        attentionId,
      };
    }
    throw failure instanceof Error ? failure : new ControlError(String(failure));
  }
  if (pendingSettlement) boundInput.runtime.clearStopSettlement(boundInput.operationId);
  if (!previousAttentionId) return receipt;
  const attentionResolution = await resolvePendingStopAttention({
    runtime: boundInput.runtime,
    operationId: boundInput.operationId,
    attentionPort: boundInput.attentionPort,
    scope: boundInput.scope,
    ownerId: boundInput.ownerId,
    evidenceRefs: receipt.closure.evidenceRefs,
  });
  if (attentionResolution.state === 'pending') return { ...receipt, attentionResolution };
  return receipt;
}
