import { createHash } from 'node:crypto';
import { assertCheckpointClosureCommitted } from '../../../core/src/index.js';
import {
  assertEvidenceRef,
  assertSameScope,
  type Checkpoint,
  type EvidenceRef,
  type JournalCommitRef,
  type NextAction,
  type OperationId,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { checkpointCommitId, completeCheckpoint, sameCheckpoint, sameJournalCommitRef } from './coordinator.js';
import {
  assertDeadEndRecord,
  assertInteractionClosure,
  assertReconcileEvidenceScope,
  computeReentryDecision,
  readCheckpointClosurePreparation,
  sameEvidenceRef,
  sameCheckpointClosureRecord,
  sameOperationId,
  type CheckpointClosureRecord,
  type CheckpointClosureCompatibilityVersion,
  type ClosureRecord,
  type DeadEndRecord,
  type InteractionClosureRecord,
  type OperationReconcilePort,
  type OperationReconcileResult,
  type CheckpointReentryDecision,
  type CheckpointSubmissionSource,
  type CheckpointClosurePreparationRecord,
} from './closure.js';
import {
  assertConfirmedContextCorrectionCommand,
  assertConfirmedReentryCommand,
  sameContextCorrectionCommand,
  sameContextCorrectionRecord,
  sameConditionalReentryCommand,
  sameConditionalReentryRecord,
  type ConditionalReentryRecord,
  type ConfirmedContextCorrectionCommand,
  type ConfirmedReentryCommand,
  type ContextCorrectionRecord,
} from './conditional-reentry.js';
import { CheckpointSubmissionError } from './errors.js';
import type {
  CheckpointClosurePort,
  CheckpointJournalPort,
  CheckpointJournalReaderPort,
  CheckpointReentryAdmissionPort,
  ConditionalReentrySubmissionPort,
  ContextCorrectionSubmissionPort,
} from './ports.js';

const CHECKPOINT_SOURCES: readonly CheckpointSubmissionSource[] = ['agent-tool', 'harness-control', 'recovery'];

function asCheckpointJournalReader(journal: CheckpointJournalPort): CheckpointJournalReaderPort {
  if (typeof (journal as Partial<CheckpointJournalReaderPort>).readCommitted !== 'function') {
    throw new CheckpointSubmissionError(
      'bound checkpoint preparation requires the canonical exact checkpoint reader',
    );
  }
  return journal as CheckpointJournalReaderPort;
}

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
  const storedVersion = closure.compatibilityVersion ?? expectedVersion;
  assertSupportedCheckpointClosureCompatibilityVersion(storedVersion);
  if (storedVersion !== expectedVersion) {
    throw new CheckpointSubmissionError(
      `checkpoint closure compatibility version ${String(storedVersion)} does not match expected version ${String(expectedVersion)}`,
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
      if (scoped.closureId !== checkpointClosureId(checkpoint)) {
        throw new CheckpointSubmissionError('checkpoint closure identity does not match its canonical key');
      }
      assertStoredCheckpointClosureVersion(scoped, CHECKPOINT_CLOSURE_COMPATIBILITY.current.version);
      if (!closureMatchesCheckpoint(scoped, checkpoint)) {
        throw new CheckpointSubmissionError(
          `canonical checkpoint closure v${CHECKPOINT_CLOSURE_COMPATIBILITY.current.version} does not match the checkpoint`,
        );
      }
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
  /** Required on new producing callers; omission supports only old unbound consumers. */
  readonly preparation?: CheckpointClosurePreparationRecord;
  readonly turnRecoveryRef?: string;
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
    const preparation = input.preparation;
    if (preparation) {
      const stored = await readCheckpointClosurePreparation(input.closurePort, input.checkpoint);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(preparation)
        || stored.checkpointDigest !== `sha256:${createHash('sha256').update(JSON.stringify(input.checkpoint)).digest('hex')}`
        || stored.coreClosure.source !== input.source
        || stored.coreClosure.executionEpoch !== input.checkpoint.executionEpoch
        || !sameEvidenceRef(stored.coreClosure.recoveryStateRef, input.checkpoint.recoveryStateRef)
        || JSON.stringify(stored.coreClosure.nextAction) !== JSON.stringify(input.checkpoint.next)) {
        throw new CheckpointSubmissionError('bound checkpoint preparation does not match its exact stored candidate');
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
    const reentry = preparation?.reentry ?? computeReentryDecision({
      outcome: input.checkpoint.outcome,
      permissionRevoked: input.permissionRevoked,
      hardBlockers: input.hardBlockers,
      unresolvedOperations: unresolved,
    });
    if (input.permissionRevoked && input.checkpoint.outcome !== 'blocked' && input.checkpoint.outcome !== 'stopped' && input.checkpoint.outcome !== 'unknown') {
      throw new CheckpointSubmissionError('permission revoke closure must be blocked, stopped, or unknown');
    }
    if (preparation?.coreClosure.unknownOperations.length
      && (input.checkpoint.outcome !== 'unknown' || input.checkpoint.next.kind !== 'recover')) {
      throw new CheckpointSubmissionError('unknown operations require an unknown checkpoint closure until reconcile');
    }
    if (preparation?.permission.revoked
      && !['blocked', 'stopped', 'unknown'].includes(input.checkpoint.outcome)) {
      throw new CheckpointSubmissionError('permission revoke closure must be blocked, stopped, or unknown');
    }
    const evidenceRefs = reconciledOperations.flatMap((result) => result.evidenceRef ? [result.evidenceRef] : []);
    let closure: CheckpointClosureRecord = {
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
    if (preparation) {
      // Checkpoint and closure are separate commits. Never materialize authority before exact readback.
      const reader = asCheckpointJournalReader(input.journal);
      const verification = await reader.verify(input.checkpoint.scope);
      if (!verification.valid) throw new CheckpointSubmissionError(`checkpoint journal is invalid: ${verification.reason}`);
      let committed = await reader.readCommitted(input.checkpoint.scope, input.checkpoint.id);
      if (!committed) {
        if (existing) throw new CheckpointSubmissionError('checkpoint closure exists without its exact committed checkpoint');
        await completeCheckpoint(reader, {
          ownerId: input.ownerId,
          context: {
            scope: input.checkpoint.scope, cycleId: input.checkpoint.cycleId,
            executionEpoch: input.checkpoint.executionEpoch, directiveRevision: input.checkpoint.directiveRevision,
          },
          previous: input.previous,
          checkpoint: input.checkpoint,
        });
        committed = await reader.readCommitted(input.checkpoint.scope, input.checkpoint.id);
      }
      if (!committed || !sameCheckpoint(committed.checkpoint, input.checkpoint)) {
        throw new CheckpointSubmissionError('bound checkpoint exact readback is absent or different');
      }
      const coreClosure = { ...preparation.coreClosure, committed: true };
      assertCheckpointClosureCommitted(coreClosure);
      closure = {
        ...closure,
        recoveryBinding: {
          checkpointCommitRef: committed.commitRef,
          contextCommitRef: preparation.contextCommitRef,
          coreClosure,
          preparationRef: preparation.closureId,
          ...(input.turnRecoveryRef ? { turnRecoveryRef: input.turnRecoveryRef } : {}),
        },
      };
      if (existing) {
        if (!('closureKind' in existing) || existing.closureKind !== 'checkpoint'
          || !sameCheckpointClosureContent(existing, closure)) {
          throw new CheckpointSubmissionError('checkpoint closure id is already committed with different content');
        }
      } else {
        const receipt = await input.closurePort.commit(closure);
        if (!receipt.committed || receipt.closureId !== closure.closureId) {
          throw new CheckpointSubmissionError('checkpoint closure fact was not acknowledged');
        }
      }
      const readback = await input.closurePort.read(closure.closureId);
      if (!readback || !('closureKind' in readback) || readback.closureKind !== 'checkpoint'
        || !sameCheckpointClosureContent(readback, closure)) {
        throw new CheckpointSubmissionError('bound checkpoint closure exact readback is absent or different');
      }
      return { state: 'committed', checkpoint: committed.checkpoint, closure: readback, reentry: readback.reentry, unresolvedOperations: unresolved };
    }
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

export interface ConditionalReentryCommit {
  readonly port: ConditionalReentrySubmissionPort;
  readonly command: ConfirmedReentryCommand;
}

export interface CommitReentryInput {
  readonly ownerId: string;
  readonly conditional?: ConditionalReentryCommit;
  /**
   * Legacy unbound fields remain in the input shape only so existing callers
   * compile while A4.3 composes the actual public caller. They never authorize
   * or append a new reentry.
   */
  readonly closureId?: string;
  readonly checkpoint?: Checkpoint;
  readonly source?: 'agent-tool' | 'recovery';
  readonly previousExecutionEpoch?: number;
  readonly newExecutionEpoch?: number;
  readonly deadEndRef?: string;
  readonly nextAction?: NextAction;
  readonly journal?: CheckpointJournalPort;
  readonly closurePort?: CheckpointClosurePort;
  readonly admissionPort?: CheckpointReentryAdmissionPort;
}

export interface CommittedReentry {
  readonly state: 'committed';
  readonly record: ConditionalReentryRecord;
  readonly commitRef: JournalCommitRef;
}

/**
 * Canonical reentry now delegates to the schema-versioned conditional owner.
 * Legacy unbound history remains readable, but this mutation path never
 * reconstructs a latest-only target, an outcome-only decision or a recovery
 * bypass.
 */
export async function commitReentry(input: CommitReentryInput): Promise<CommittedReentry> {
  try {
    nonEmpty(input.ownerId, 'reentry owner');
    if (!input.conditional) {
      throw new CheckpointSubmissionError(
        'legacy unbound reentry is read-only; a confirmed conditional command and its owner port are required',
      );
    }
    const { port, command } = input.conditional;
    assertConfirmedReentryCommand(command);
    if (command.principalOwner !== input.ownerId) {
      throw new CheckpointSubmissionError('reentry owner does not match the verified principal');
    }
    const prepared = await port.prepare(command);
    if (!sameConditionalReentryCommand(prepared.command, command)) {
      throw new CheckpointSubmissionError('conditional preparation changed the confirmed command');
    }
    const commitRef = await port.commitReentryRecord(prepared, command.expectedCurrentControlCommitRef);
    const readback = await port.readReentry(command.taskScope, command.commandId);
    if (!readback || !sameJournalCommitRef(readback.commitRef, commitRef)
      || !sameConditionalReentryRecord(readback.record, prepared)) {
      throw new CheckpointSubmissionError('reentry exact readback is absent or different');
    }
    return { state: 'committed', record: readback.record, commitRef: readback.commitRef };
  } catch (error) {
    throw asSubmissionError(error);
  }
}

export interface ContextCorrectionCommit {
  readonly port: ContextCorrectionSubmissionPort;
  readonly command: ConfirmedContextCorrectionCommand;
}

export interface CommitContextCorrectionInput {
  readonly ownerId: string;
  readonly correction: ContextCorrectionCommit;
}

export interface CommittedContextCorrection {
  readonly state: 'committed';
  readonly record: ContextCorrectionRecord;
  readonly commitRef: JournalCommitRef;
}

function confirmedCommandOf(record: ContextCorrectionRecord): ConfirmedContextCorrectionCommand {
  return {
    basis: record.basis,
    expectedOperationControlCommitRef: record.expectedOperationControlCommitRef,
    expectedGrantCommitRef: record.expectedGrantCommitRef,
    permissionRevision: record.permissionRevision,
  };
}

/**
 * Canonical Context correction submission. It reuses the existing conditional
 * branch: prepare from authoritative current facts, compare the exact current
 * control token, commit the append-only carrier and read the physical record back.
 */
export async function commitContextCorrection(
  input: CommitContextCorrectionInput,
): Promise<CommittedContextCorrection> {
  try {
    nonEmpty(input.ownerId, 'context correction owner');
    const { port, command } = input.correction;
    assertConfirmedContextCorrectionCommand(command);
    if (command.basis.principalOwner !== input.ownerId) {
      throw new CheckpointSubmissionError('context correction owner does not match the verified principal');
    }
    const taskScope = {
      organId: command.basis.taskScope.organId,
      taskId: command.basis.taskScope.taskId,
    };
    const existing = await port.readContextCorrection(taskScope, command.basis.commandId);
    if (existing) {
      if (!sameContextCorrectionCommand(confirmedCommandOf(existing.record), command)) {
        throw new CheckpointSubmissionError(
          'context correction command id is already committed with different confirmed facts',
        );
      }
      return { state: 'committed', record: existing.record, commitRef: existing.commitRef };
    }
    const prepared = await port.prepare(command);
    if (!sameContextCorrectionCommand(confirmedCommandOf(prepared), command)) {
      throw new CheckpointSubmissionError('context correction preparation changed the confirmed command');
    }
    const commitRef = await port.commitContextCorrectionRecord(
      prepared,
      command.basis.expectedControlReceipt,
    );
    const readback = await port.readContextCorrection(
      taskScope,
      command.basis.commandId,
    );
    if (!readback || !sameJournalCommitRef(readback.commitRef, commitRef)
      || !sameContextCorrectionRecord(readback.record, prepared)) {
      throw new CheckpointSubmissionError('context correction exact readback is absent or different');
    }
    return { state: 'committed', record: readback.record, commitRef: readback.commitRef };
  } catch (error) {
    throw asSubmissionError(error);
  }
}
