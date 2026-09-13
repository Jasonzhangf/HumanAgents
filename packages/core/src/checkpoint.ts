import type { Checkpoint, EvidenceRef, LifecycleState, NextAction, ScopeRef } from '../../contracts/src/index.js';
import { assertCheckpointLink, assertEvidenceRef, assertSameScope } from '../../contracts/src/index.js';
import { CheckpointError } from './errors.js';

const CHECKPOINT_OUTCOMES: readonly Checkpoint['outcome'][] = [
  'succeeded',
  'waiting',
  'blocked',
  'failed',
  'cancelled',
  'stopped',
  'unknown',
];

function hasReference(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function assertCheckpointOutcome(outcome: LifecycleState): asserts outcome is Checkpoint['outcome'] {
  if (!CHECKPOINT_OUTCOMES.includes(outcome as Checkpoint['outcome'])) {
    throw new CheckpointError(`checkpoint cannot commit active state: ${outcome}`);
  }
}

export function assertCheckpointNextAction(outcome: Checkpoint['outcome'], next: NextAction): void {
  if (outcome === 'waiting' && next.kind !== 'wait') {
    throw new CheckpointError('waiting checkpoint requires wait next action');
  }
  if ((outcome === 'succeeded' || outcome === 'failed') && next.kind === 'continue' && !hasReference(next.ref)) {
    throw new CheckpointError(`${outcome} checkpoint cannot continue without a reference`);
  }
  if ((outcome === 'stopped' || outcome === 'cancelled') && next.kind === 'continue') {
    throw new CheckpointError(`${outcome} checkpoint cannot continue execution`);
  }
  if (next.kind === 'wait' && !hasReference(next.ref)) {
    throw new CheckpointError('wait next action requires a condition reference');
  }
  if (next.kind === 'recover' && !hasReference(next.ref)) {
    throw new CheckpointError('recover next action requires a recovery reference');
  }
  if (next.kind === 'stop' && !hasReference(next.ref)) {
    throw new CheckpointError('stop next action requires a stop reason');
  }
}

export function assertCheckpointRecoveryStateRef(scope: ScopeRef, recoveryStateRef: EvidenceRef): void {
  try {
    assertEvidenceRef(recoveryStateRef);
    assertSameScope(scope, recoveryStateRef.scope);
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    throw new CheckpointError(error instanceof Error ? error.message : 'invalid checkpoint recovery state reference');
  }
}

export function assertCheckpointEvidenceRefs(scope: ScopeRef, evidenceRefs: readonly EvidenceRef[]): void {
  for (const evidenceRef of evidenceRefs) {
    try {
      assertEvidenceRef(evidenceRef);
      assertSameScope(scope, evidenceRef.scope);
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      throw new CheckpointError(error instanceof Error ? error.message : 'invalid checkpoint evidence reference');
    }
  }
}

export function assertCheckpointRecoveryResponsibility(input: {
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
  readonly ownerId: string;
}): void {
  assertCheckpointLink(input.checkpoint, input.previous);
  assertCheckpointOutcome(input.checkpoint.outcome);
  assertCheckpointNextAction(input.checkpoint.outcome, input.checkpoint.next);
  if (!input.ownerId.trim()) throw new CheckpointError('checkpoint owner is required');
  assertCheckpointRecoveryStateRef(input.checkpoint.scope, input.checkpoint.recoveryStateRef);
  assertCheckpointEvidenceRefs(input.checkpoint.scope, input.checkpoint.evidenceRefs);
  if (input.checkpoint.outcome === 'waiting') {
    if (input.checkpoint.next.kind !== 'wait' || !hasReference(input.checkpoint.next.ref)) {
      throw new CheckpointError('waiting checkpoint requires an explicit recovery condition');
    }
  }
  if (input.checkpoint.outcome === 'blocked' || input.checkpoint.outcome === 'failed' || input.checkpoint.outcome === 'unknown') {
    if (input.checkpoint.next.kind === 'continue') throw new CheckpointError('open failure cannot continue without recovery');
    if (!hasReference(input.checkpoint.next.ref)) throw new CheckpointError('open failure checkpoint requires next action reference');
  }
  if (input.checkpoint.outcome === 'stopped' && input.checkpoint.evidenceRefs.length === 0) {
    throw new CheckpointError('stopped checkpoint requires settle evidence');
  }
  if (input.previous?.outcome === 'stopped' && input.checkpoint.next.kind === 'continue') {
    throw new CheckpointError('stopped checkpoint cannot be followed by an ordinary continue');
  }
}

export function assertCheckpointSequence(checkpoints: readonly (Checkpoint & { readonly ownerId: string })[]): void {
  let previous: Checkpoint | null = null;
  for (const checkpoint of checkpoints) {
    assertCheckpointRecoveryResponsibility({ checkpoint, previous, ownerId: checkpoint.ownerId });
    previous = checkpoint;
  }
}

export function nextActionRef(next: NextAction): string | undefined {
  return hasReference(next.ref) ? next.ref : undefined;
}
