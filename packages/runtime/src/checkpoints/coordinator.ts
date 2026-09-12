import {
  assertEvidenceRef,
  assertSameScope,
  type Checkpoint,
  type CycleId,
  type EvidenceRef,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { assertCheckpointRecoveryResponsibility } from '../../../core/src/checkpoint.js';
import { CheckpointCompletionError, CheckpointRecallError } from './errors.js';
import type {
  CheckpointAppendReceipt,
  CheckpointJournalPort,
  LatestCheckpointRecord,
} from './ports.js';
import {
  assembleCheckpointWindows,
  type CheckpointWindowLimits,
  type CheckpointWindows,
} from './windows.js';

export interface RecallCheckpointInput {
  readonly ownerId: string;
  readonly scope: ScopeRef;
  readonly windowLimits?: Partial<CheckpointWindowLimits>;
}

export interface RecalledCheckpoint {
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
  readonly windows: CheckpointWindows;
}

export interface CompletionContext {
  readonly scope: ScopeRef;
  readonly cycleId: CycleId;
  readonly executionEpoch: number;
  readonly directiveRevision?: number;
}

export interface CompleteCheckpointInput {
  readonly ownerId: string;
  readonly context: CompletionContext;
  readonly previous: Checkpoint | null;
  readonly checkpoint: Checkpoint;
  readonly windowLimits?: Partial<CheckpointWindowLimits>;
}

export interface CompletedCheckpoint {
  readonly checkpoint: Checkpoint;
  readonly receipt: CheckpointAppendReceipt;
  readonly windows: CheckpointWindows;
}

function sameId(left: { readonly scope: string; readonly value: string }, right: { readonly scope: string; readonly value: string }): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new CheckpointRecallError(`${label} is required`);
}

function assertEvidenceRefs(checkpoint: Pick<Checkpoint, 'scope' | 'recoveryStateRef' | 'evidenceRefs'>): void {
  assertSameScope(checkpoint.scope, checkpoint.recoveryStateRef.scope);
  if (checkpoint.evidenceRefs.length === 0) throw new CheckpointRecallError('checkpoint evidence is required');
  for (const evidenceRef of checkpoint.evidenceRefs) {
    try {
      assertEvidenceRef(evidenceRef);
    } catch (error) {
      throw new CheckpointRecallError(error instanceof Error ? error.message : 'checkpoint evidence reference is invalid');
    }
    assertSameScope(checkpoint.scope, evidenceRef.scope);
  }
}

function assertCheckpointCycle(checkpoint: Checkpoint): void {
  if (!checkpoint.scope.cycleId || !sameId(checkpoint.scope.cycleId, checkpoint.cycleId)) {
    throw new CheckpointRecallError('checkpoint scope must match its cycle');
  }
}

function asRecallError(error: unknown): CheckpointRecallError {
  if (error instanceof CheckpointRecallError) return error;
  return new CheckpointRecallError(error instanceof Error ? error.message : String(error));
}

function asCompletionError(error: unknown): CheckpointCompletionError {
  if (error instanceof CheckpointCompletionError) return error;
  return new CheckpointCompletionError(error instanceof Error ? error.message : String(error));
}

export async function recallCheckpoint(
  journal: CheckpointJournalPort,
  input: RecallCheckpointInput,
): Promise<RecalledCheckpoint | null> {
  try {
    assertNonEmpty(input.ownerId, 'checkpoint owner');
    const verification = await journal.verify(input.scope);
    if (!verification.valid) throw new CheckpointRecallError(`checkpoint chain is invalid: ${verification.reason}`);

    const latest: LatestCheckpointRecord | null = await journal.readLatest(input.scope);
    if (!latest) return null;

    assertSameScope(input.scope, latest.checkpoint.scope);
    assertCheckpointCycle(latest.checkpoint);
    assertEvidenceRefs(latest.checkpoint);
    assertCheckpointRecoveryResponsibility({
      checkpoint: latest.checkpoint,
      previous: latest.previous,
      ownerId: input.ownerId,
    });

    return {
      checkpoint: latest.checkpoint,
      previous: latest.previous,
      windows: assembleCheckpointWindows(latest.checkpoint, input.windowLimits),
    };
  } catch (error) {
    throw asRecallError(error);
  }
}

export async function completeCheckpoint(
  journal: CheckpointJournalPort,
  input: CompleteCheckpointInput,
): Promise<CompletedCheckpoint> {
  try {
    assertNonEmpty(input.ownerId, 'checkpoint owner');
    if (!input.context.scope.cycleId || !sameId(input.context.scope.cycleId, input.context.cycleId)) {
      throw new CheckpointCompletionError('completion context scope must match its cycle');
    }
    if (!sameId(input.context.cycleId, input.checkpoint.cycleId)) {
      throw new CheckpointCompletionError('completion context cycle does not match checkpoint');
    }
    if (!Number.isSafeInteger(input.context.executionEpoch) || input.context.executionEpoch < 1) {
      throw new CheckpointCompletionError('completion execution epoch must be a positive safe integer');
    }
    if (input.context.executionEpoch !== input.checkpoint.executionEpoch) {
      throw new CheckpointCompletionError('completion execution epoch does not match checkpoint');
    }
    if (
      input.context.directiveRevision !== undefined &&
      input.context.directiveRevision !== input.checkpoint.directiveRevision
    ) {
      throw new CheckpointCompletionError('completion directive revision does not match checkpoint');
    }
    if (!Number.isSafeInteger(input.checkpoint.directiveRevision) || input.checkpoint.directiveRevision < 1) {
      throw new CheckpointCompletionError('checkpoint directive revision must be a positive safe integer');
    }

    assertSameScope(input.context.scope, input.checkpoint.scope);
    assertCheckpointCycle(input.checkpoint);
    assertEvidenceRefs(input.checkpoint);
    assertCheckpointRecoveryResponsibility({
      checkpoint: input.checkpoint,
      previous: input.previous,
      ownerId: input.ownerId,
    });

    const receipt = await journal.append({
      ownerId: input.ownerId,
      checkpoint: input.checkpoint,
    });
    if (!sameId(receipt.checkpointId, input.checkpoint.id) || receipt.seq !== input.checkpoint.seq) {
      throw new CheckpointCompletionError('checkpoint append receipt does not match checkpoint');
    }

    return {
      checkpoint: input.checkpoint,
      receipt,
      windows: assembleCheckpointWindows(input.checkpoint, input.windowLimits),
    };
  } catch (error) {
    throw asCompletionError(error);
  }
}
