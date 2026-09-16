import {
  assertEvidenceRef,
  assertSameScope,
  type Checkpoint,
  type EvidenceRef,
  type NextAction,
  type OperationId,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { checkpointCommitId, completeCheckpoint, sameCheckpoint } from './coordinator.js';
import {
  assertDeadEndRecord,
  assertInteractionClosure,
  assertReconcileEvidenceScope,
  assertReentryRecord,
  computeReentryDecision,
  sameCheckpointClosureRecord,
  sameOperationId,
  sameReentryRecord,
  type CheckpointClosureRecord,
  type DeadEndRecord,
  type InteractionClosureRecord,
  type OperationReconcilePort,
  type OperationReconcileResult,
  type ReentryRecord,
  type CheckpointReentryDecision,
  type CheckpointSubmissionSource,
} from './closure.js';
import { CheckpointSubmissionError } from './errors.js';
import type {
  CheckpointClosurePort,
  CheckpointJournalPort,
  CheckpointReentryAdmissionPort,
} from './ports.js';

const CHECKPOINT_SOURCES: readonly CheckpointSubmissionSource[] = ['agent-tool', 'harness-control', 'recovery'];

function asSubmissionError(error: unknown): CheckpointSubmissionError {
  if (error instanceof CheckpointSubmissionError) return error;
  return new CheckpointSubmissionError(error instanceof Error ? error.message : String(error));
}

function assertSource(value: unknown): asserts value is CheckpointSubmissionSource {
  if (typeof value !== 'string' || !CHECKPOINT_SOURCES.includes(value as CheckpointSubmissionSource)) {
    throw new CheckpointSubmissionError(`checkpoint submission source must be one of: ${CHECKPOINT_SOURCES.join(', ')}`);
  }
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new CheckpointSubmissionError(`${label} is required`);
  return value;
}

function requireEvidenceRefs(scope: ScopeRef, evidenceRefs: readonly EvidenceRef[], label: string): void {
  if (evidenceRefs.length === 0) throw new CheckpointSubmissionError(`${label} evidence is required`);
  for (const evidenceRef of evidenceRefs) {
    try {
      assertEvidenceRef(evidenceRef);
      assertSameScope(scope, evidenceRef.scope);
    } catch (error) {
      throw new CheckpointSubmissionError(error instanceof Error ? error.message : `${label} evidence is invalid or out of scope`);
    }
  }
}

function assertScopeAndCycle(checkpoint: Checkpoint): void {
  if (!checkpoint.scope.cycleId || checkpoint.scope.cycleId.scope !== checkpoint.cycleId.scope || checkpoint.scope.cycleId.value !== checkpoint.cycleId.value) {
    throw new CheckpointSubmissionError('checkpoint scope must match its cycle');
  }
}

function assertOperationIdScope(scope: ScopeRef, operationId: OperationId): void {
  if (scope.operationId && !sameOperationId(scope.operationId, operationId)) {
    throw new CheckpointSubmissionError('unknown operation does not match checkpoint operation scope');
  }
  const operationScope: ScopeRef = {
    organId: scope.organId,
    ...(scope.taskId ? { taskId: scope.taskId } : {}),
    ...(scope.cycleId ? { cycleId: scope.cycleId } : {}),
    operationId,
  };
  try {
    assertSameScope(
      { organId: scope.organId, taskId: scope.taskId, cycleId: scope.cycleId },
      { organId: operationScope.organId, taskId: operationScope.taskId, cycleId: operationScope.cycleId },
    );
  } catch (error) {
    throw new CheckpointSubmissionError(error instanceof Error ? error.message : 'unknown operation is out of checkpoint scope');
  }
}

function unresolvedOperations(
  unknownOperations: readonly OperationId[],
  reconciledOperations: readonly OperationReconcileResult[],
): readonly OperationId[] {
  const reconciledIds = new Set(reconciledOperations.map((result) => result.operationId.value));
  return unknownOperations.filter((operationId) => !reconciledIds.has(operationId.value));
}

function assertKnownClosure(checkpoint: Checkpoint, unresolved: readonly OperationId[]): void {
  if (unresolved.length === 0) return;
  if (checkpoint.outcome !== 'unknown') {
    throw new CheckpointSubmissionError('unknown operations require an unknown checkpoint closure until reconcile');
  }
  if (checkpoint.next.kind !== 'recover' || !checkpoint.next.ref?.trim()) {
    throw new CheckpointSubmissionError('unknown checkpoint closure requires a recover next action with reference');
  }
}

export interface SubmitCheckpointInput {
  readonly source: CheckpointSubmissionSource;
  readonly ownerId: string;
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
  readonly journal: CheckpointJournalPort;
  readonly closurePort: CheckpointClosurePort;
  readonly permissionRevoked?: boolean;
  readonly hardBlockers?: readonly string[];
  readonly unknownOperations?: readonly OperationId[];
  readonly reconciledOperations?: readonly OperationReconcileResult[];
}

export interface SubmittedCheckpoint {
  readonly state: 'committed';
  readonly checkpoint: Checkpoint;
  readonly closure: CheckpointClosureRecord;
  readonly reentry: CheckpointReentryDecision;
  readonly unresolvedOperations: readonly OperationId[];
}

export async function submitCheckpoint(input: SubmitCheckpointInput): Promise<SubmittedCheckpoint> {
  try {
    assertSource(input.source);
    nonEmpty(input.ownerId, 'checkpoint owner');
    assertScopeAndCycle(input.checkpoint);
    requireEvidenceRefs(input.checkpoint.scope, input.checkpoint.evidenceRefs, 'checkpoint');
    requireEvidenceRefs(input.checkpoint.scope, [input.checkpoint.recoveryStateRef], 'checkpoint recovery state');
    if (input.source === 'harness-control' || input.source === 'recovery') {
      if (input.checkpoint.evidenceRefs.length === 0) {
        throw new CheckpointSubmissionError(`${input.source} closure requires settle evidence`);
      }
    }
    const unknownOperations = input.unknownOperations ?? [];
    for (const operationId of unknownOperations) assertOperationIdScope(input.checkpoint.scope, operationId);
    const reconciledOperations = input.reconciledOperations ?? [];
    const reconciledIds = new Set<string>();
    for (const reconciled of reconciledOperations) {
      if (reconciled.state !== 'reconciled' || !reconciled.evidenceRef) {
        throw new CheckpointSubmissionError('reconciled operation result must be reconciled with evidence');
      }
      assertOperationIdScope(input.checkpoint.scope, reconciled.operationId);
      assertReconcileEvidenceScope(input.checkpoint.scope, reconciled.evidenceRef, reconciled.operationId);
      reconciledIds.add(reconciled.operationId.value);
    }
    const unresolved = unresolvedOperations(unknownOperations, reconciledOperations);
    assertKnownClosure(input.checkpoint, unresolved);
    const reentry = computeReentryDecision({
      outcome: input.checkpoint.outcome,
      permissionRevoked: input.permissionRevoked,
      hardBlockers: input.hardBlockers,
      unresolvedOperations: unresolved,
    });
    if (input.permissionRevoked && input.checkpoint.outcome !== 'blocked' && input.checkpoint.outcome !== 'stopped' && input.checkpoint.outcome !== 'unknown') {
      throw new CheckpointSubmissionError('permission revoke closure must be blocked, stopped, or unknown');
    }
    const evidenceRefs = reconciledOperations.flatMap((result) => result.evidenceRef ? [result.evidenceRef] : []);
    const closure: CheckpointClosureRecord = {
      closureKind: 'checkpoint',
      closureId: `checkpoint-closure:${checkpointCommitId(input.checkpoint)}`,
      checkpointId: input.checkpoint.id,
      source: input.source,
      outcome: input.checkpoint.outcome,
      summary: input.checkpoint.summary,
      next: input.checkpoint.next,
      evidenceRefs: [...input.checkpoint.evidenceRefs, ...evidenceRefs],
      reentry,
    };
    const existing = await input.closurePort.read(closure.closureId);
    if (existing) {
      if (!('closureKind' in existing) || existing.closureKind !== 'checkpoint' || !sameCheckpointClosureRecord(existing, closure)) {
        throw new CheckpointSubmissionError('checkpoint closure id is already committed with different content');
      }
      const verification = await input.journal.verify(input.checkpoint.scope);
      if (!verification.valid) {
        throw new CheckpointSubmissionError(`checkpoint journal is invalid: ${verification.reason}`);
      }
      const latest = await input.journal.readLatest(input.checkpoint.scope);
      if (!latest || !sameCheckpoint(latest.checkpoint, input.checkpoint)) {
        throw new CheckpointSubmissionError('checkpoint closure exists without a matching committed journal checkpoint');
      }
      return {
        state: 'committed',
        checkpoint: input.checkpoint,
        closure: existing,
        reentry: existing.reentry,
        unresolvedOperations: unresolved,
      };
    }
    await completeCheckpoint(input.journal, {
      ownerId: input.ownerId,
      context: {
        scope: input.checkpoint.scope,
        cycleId: input.checkpoint.cycleId,
        executionEpoch: input.checkpoint.executionEpoch,
        directiveRevision: input.checkpoint.directiveRevision,
      },
      previous: input.previous,
      checkpoint: input.checkpoint,
    });
    const receipt = await input.closurePort.commit(closure);
    if (!receipt.committed || receipt.closureId !== closure.closureId) {
      throw new CheckpointSubmissionError('checkpoint closure fact was not acknowledged');
    }
    return {
      state: 'committed',
      checkpoint: input.checkpoint,
      closure,
      reentry,
      unresolvedOperations: unresolved,
    };
  } catch (error) {
    throw asSubmissionError(error);
  }
}

export interface SubmitInteractionClosureInput {
  readonly ownerId: string;
  readonly closureId: string;
  readonly scope: ScopeRef;
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly closurePort: CheckpointClosurePort;
  readonly next?: NextAction;
}

export interface SubmittedInteractionClosure {
  readonly state: 'closed';
  readonly closure: InteractionClosureRecord;
}

export async function submitInteractionClosure(input: SubmitInteractionClosureInput): Promise<SubmittedInteractionClosure> {
  try {
    nonEmpty(input.ownerId, 'interaction closure owner');
    assertInteractionClosure(input);
    const closure: InteractionClosureRecord = {
      closureKind: 'interaction',
      closureId: input.closureId,
      scope: input.scope,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs,
      ...(input.next ? { next: input.next } : {}),
    };
    const receipt = await input.closurePort.commit(closure);
    if (!receipt.committed || receipt.closureId !== closure.closureId) {
      throw new CheckpointSubmissionError('interaction closure fact was not acknowledged');
    }
    return { state: 'closed', closure };
  } catch (error) {
    throw asSubmissionError(error);
  }
}

export interface CommitDeadEndInput {
  readonly ownerId: string;
  readonly record: DeadEndRecord;
  readonly closurePort: CheckpointClosurePort;
}

export interface CommittedDeadEnd {
  readonly state: 'committed';
  readonly record: DeadEndRecord;
}

export async function commitDeadEnd(input: CommitDeadEndInput): Promise<CommittedDeadEnd> {
  try {
    nonEmpty(input.ownerId, 'dead-end owner');
    assertDeadEndRecord(input.record);
    const record: DeadEndRecord = {
      deadEndRef: input.record.deadEndRef,
      scope: input.record.scope,
      failedPathRefs: input.record.failedPathRefs,
      conclusion: input.record.conclusion,
      invalidatedAssumptions: input.record.invalidatedAssumptions,
      evidenceRefs: input.record.evidenceRefs,
      ...(input.record.suggestedAlternatives ? { suggestedAlternatives: input.record.suggestedAlternatives } : {}),
    };
    const receipt = await input.closurePort.commit(record);
    if (!receipt.committed || receipt.closureId !== record.deadEndRef) {
      throw new CheckpointSubmissionError('dead-end fact was not acknowledged');
    }
    return { state: 'committed', record };
  } catch (error) {
    throw asSubmissionError(error);
  }
}

export interface CommitReentryInput {
  readonly ownerId: string;
  readonly closureId: string;
  readonly checkpoint: Checkpoint;
  readonly previousExecutionEpoch: number;
  readonly newExecutionEpoch: number;
  readonly deadEndRef?: string;
  readonly nextAction: NextAction;
  readonly journal: CheckpointJournalPort;
  readonly closurePort: CheckpointClosurePort;
  readonly admissionPort: CheckpointReentryAdmissionPort;
}

export interface CommittedReentry {
  readonly state: 'committed';
  readonly record: ReentryRecord;
}

export async function commitReentry(input: CommitReentryInput): Promise<CommittedReentry> {
  try {
    nonEmpty(input.ownerId, 'reentry owner');
    assertReentryRecord({
      closureId: input.closureId,
      checkpointId: input.checkpoint.id,
      checkpointExecutionEpoch: input.checkpoint.executionEpoch,
      previousExecutionEpoch: input.previousExecutionEpoch,
      newExecutionEpoch: input.newExecutionEpoch,
      deadEndRef: input.deadEndRef,
      nextAction: input.nextAction,
    });
    const existing = await input.closurePort.read(input.closureId);
    if (existing) {
      if (!('closureKind' in existing) || existing.closureKind !== 'reentry' || !existing.reentry.allowed || !sameReentryRecord(existing, {
        closureKind: 'reentry',
        closureId: input.closureId,
        checkpointId: input.checkpoint.id,
        checkpointExecutionEpoch: input.checkpoint.executionEpoch,
        previousExecutionEpoch: input.previousExecutionEpoch,
        newExecutionEpoch: input.newExecutionEpoch,
        ...(input.deadEndRef ? { deadEndRef: input.deadEndRef } : {}),
        nextAction: input.nextAction,
        reentry: existing.reentry,
      })) {
        throw new CheckpointSubmissionError('reentry closure id is already committed with different content');
      }
      return { state: 'committed', record: existing };
    }
    const latest = await input.journal.readLatest(input.checkpoint.scope);
    if (!latest || !sameCheckpoint(latest.checkpoint, input.checkpoint)) {
      throw new CheckpointSubmissionError('reentry checkpoint is not the committed latest checkpoint');
    }
    const closure = await input.closurePort.read(`checkpoint-closure:${checkpointCommitId(latest.checkpoint)}`);
    if (!closure || !('closureKind' in closure) || closure.closureKind !== 'checkpoint') {
      throw new CheckpointSubmissionError('reentry requires a committed checkpoint closure');
    }
    if (closure.checkpointId.scope !== latest.checkpoint.id.scope || closure.checkpointId.value !== latest.checkpoint.id.value) {
      throw new CheckpointSubmissionError('committed closure does not match reentry checkpoint');
    }
    const admission = await input.admissionPort.admit({
      ownerId: input.ownerId,
      checkpoint: latest.checkpoint,
      closure,
      previousExecutionEpoch: input.previousExecutionEpoch,
      newExecutionEpoch: input.newExecutionEpoch,
    });
    if (!admission.allowed) {
      throw new CheckpointSubmissionError(
        `reentry admission denied: ${admission.reason}`,
        { nextAction: { kind: 'recover', ref: admission.blockedBy?.[0] ?? 'reentry-admission' } },
      );
    }
    const record: ReentryRecord = {
      closureKind: 'reentry',
      closureId: input.closureId,
      checkpointId: latest.checkpoint.id,
      checkpointExecutionEpoch: latest.checkpoint.executionEpoch,
      previousExecutionEpoch: input.previousExecutionEpoch,
      newExecutionEpoch: input.newExecutionEpoch,
      ...(input.deadEndRef ? { deadEndRef: input.deadEndRef } : {}),
      nextAction: input.nextAction,
      reentry: {
        allowed: true,
        reason: admission.reason,
      },
    };
    const receipt = await input.closurePort.commit(record);
    if (!receipt.committed || receipt.closureId !== record.closureId) {
      throw new CheckpointSubmissionError('reentry fact was not acknowledged');
    }
    return { state: 'committed', record };
  } catch (error) {
    throw asSubmissionError(error);
  }
}
