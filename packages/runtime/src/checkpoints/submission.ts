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
  sameEvidenceRef,
  sameCheckpointClosureRecord,
  sameOperationId,
  sameReentryRecord,
  type CheckpointClosureRecord,
  type CheckpointClosureCompatibilityVersion,
  type ClosureRecord,
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

/**
 * Checkpoint closure identity is owned by the Checkpoint/Control Owner.
 *
 * v2 is the current scope-safe identity. v1 is a read-only compatibility
 * exception for records written before commit identities included scope. The
 * v1 branch is removable once every supported closure store has no
 * `checkpoint-closure:<checkpoint-id>` records left.
 */
export const CHECKPOINT_CLOSURE_COMPATIBILITY = {
  current: {
    version: 2,
    scope: 'checkpoint-commit-id',
  },
  legacy: {
    version: 1,
    scope: 'checkpoint-id',
    sunsetCondition: 'remove after all supported closure stores contain no legacy checkpoint-id records',
  },
} as const;

export function assertSupportedCheckpointClosureCompatibilityVersion(
  version: number,
): asserts version is CheckpointClosureCompatibilityVersion {
  if (version !== CHECKPOINT_CLOSURE_COMPATIBILITY.current.version
    && version !== CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.version) {
    throw new CheckpointSubmissionError(`unsupported checkpoint closure compatibility version: ${String(version)}`);
  }
}

function checkpointClosureId(checkpoint: Pick<Checkpoint, 'id' | 'scope'>): string {
  return `checkpoint-closure:${checkpointCommitId(checkpoint)}`;
}

function legacyCheckpointClosureId(checkpoint: Pick<Checkpoint, 'id'>): string {
  return `checkpoint-closure:${checkpoint.id.value}`;
}

function sameCheckpointClosureContent(left: CheckpointClosureRecord, right: CheckpointClosureRecord): boolean {
  return sameCheckpointClosureRecord({ ...left, closureId: right.closureId }, right);
}

function assertStoredCheckpointClosureVersion(
  closure: CheckpointClosureRecord,
  expectedVersion: CheckpointClosureCompatibilityVersion,
): void {
  assertSupportedCheckpointClosureCompatibilityVersion(closure.compatibilityVersion);
  if (closure.compatibilityVersion !== expectedVersion) {
    throw new CheckpointSubmissionError(
      `checkpoint closure compatibility version ${String(closure.compatibilityVersion)} does not match expected version ${String(expectedVersion)}`,
    );
  }
}

function closureMatchesCheckpoint(closure: CheckpointClosureRecord, checkpoint: Checkpoint): boolean {
  if (
    closure.checkpointId.scope !== checkpoint.id.scope
    || closure.checkpointId.value !== checkpoint.id.value
    || closure.outcome !== checkpoint.outcome
    || closure.summary !== checkpoint.summary
    || closure.next.kind !== checkpoint.next.kind
    || closure.next.ref !== checkpoint.next.ref
  ) {
    return false;
  }
  try {
    for (const evidenceRef of closure.evidenceRefs) assertSameScope(checkpoint.scope, evidenceRef.scope);
  } catch {
    return false;
  }
  return checkpoint.evidenceRefs.every((expected) =>
    closure.evidenceRefs.some((candidate) => sameEvidenceRef(candidate, expected)));
}

async function readCheckpointClosure(
  port: CheckpointClosurePort,
  checkpoint: Checkpoint,
): Promise<ClosureRecord | null> {
  assertSupportedCheckpointClosureCompatibilityVersion(CHECKPOINT_CLOSURE_COMPATIBILITY.current.version);
  const scoped = await port.read(checkpointClosureId(checkpoint));
  if (scoped) {
    if ('closureKind' in scoped && scoped.closureKind === 'checkpoint') {
      assertStoredCheckpointClosureVersion(scoped, CHECKPOINT_CLOSURE_COMPATIBILITY.current.version);
    }
    return scoped;
  }

  assertSupportedCheckpointClosureCompatibilityVersion(CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.version);
  const legacy = await port.read(legacyCheckpointClosureId(checkpoint));
  if (!legacy) return null;
  if (
    !('closureKind' in legacy)
    || legacy.closureKind !== 'checkpoint'
    || legacy.closureId !== legacyCheckpointClosureId(checkpoint)
  ) {
    throw new CheckpointSubmissionError(
      `legacy checkpoint closure v${CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.version} does not match the checkpoint`,
    );
  }
  assertStoredCheckpointClosureVersion(legacy, CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.version);
  if (!closureMatchesCheckpoint(legacy, checkpoint)) {
    throw new CheckpointSubmissionError(
      `legacy checkpoint closure v${CHECKPOINT_CLOSURE_COMPATIBILITY.legacy.version} does not match the checkpoint`,
    );
  }
  return legacy;
}

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
      compatibilityVersion: CHECKPOINT_CLOSURE_COMPATIBILITY.current.version,
      closureId: checkpointClosureId(input.checkpoint),
      checkpointId: input.checkpoint.id,
      source: input.source,
      outcome: input.checkpoint.outcome,
      summary: input.checkpoint.summary,
      next: input.checkpoint.next,
      evidenceRefs: [...input.checkpoint.evidenceRefs, ...evidenceRefs],
      reentry,
    };
    const existing = await readCheckpointClosure(input.closurePort, input.checkpoint);
    if (existing) {
      if (!('closureKind' in existing) || existing.closureKind !== 'checkpoint' || !sameCheckpointClosureContent(existing, closure)) {
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
    const verification = await input.journal.verify(input.checkpoint.scope);
    if (!verification.valid) {
      throw new CheckpointSubmissionError(`checkpoint journal is invalid: ${verification.reason}`);
    }
    const latest = await input.journal.readLatest(input.checkpoint.scope);
    if (!latest || !sameCheckpoint(latest.checkpoint, input.checkpoint)) {
      throw new CheckpointSubmissionError('reentry checkpoint is not the committed latest checkpoint');
    }
    const closure = await readCheckpointClosure(input.closurePort, latest.checkpoint);
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
