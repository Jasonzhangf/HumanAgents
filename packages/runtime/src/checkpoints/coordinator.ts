import { createHash } from 'node:crypto';
import {
  assertEvidenceRef,
  assertSameScope,
  type Checkpoint,
  type CheckpointReceiptRelationshipV1,
  type CheckpointTimeAuthority,
  type CycleId,
  type EvidenceRef,
  type JsonValue,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { assertCheckpointRecoveryResponsibility } from '../../../core/src/checkpoint.js';
import { validateContextHistoryRecord } from '../../../contracts/src/agent-loop.js';
import type { ContextBuildInput } from '../context/index.js';
import { CheckpointCompletionError, CheckpointRecallError, ContextHistoryError } from './errors.js';
import type {
  CheckpointAppendReceipt,
  CheckpointJournalReaderPort,
  CheckpointListQuery,
  CheckpointListResult,
  CheckpointJournalPort,
  CheckpointRecoveryBinding,
  CommittedCheckpointRecord,
  ContextHistoryPort,
  ContextHistoryReadQuery,
  ContextHistoryReadResult,
  ContextHistoryRecord,
  ExecutionPosition,
  ExecutionIncarnationRef,
  JournalCommitRef,
  LatestCheckpointRecord,
  NativeCheckpointJournalPort,
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

export type CompleteNativeCheckpointInput = Omit<CompleteCheckpointInput, 'windowLimits'> & {
  readonly timeAuthority: CheckpointTimeAuthority;
};

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

export function sameCheckpoint(left: Checkpoint, right: Checkpoint): boolean {
  return sameId(left.id, right.id)
    && left.seq === right.seq
    && left.directiveRevision === right.directiveRevision
    && left.executionEpoch === right.executionEpoch
    && left.outcome === right.outcome
    && left.summary === right.summary
    && left.next.kind === right.next.kind
    && left.next.ref === right.next.ref
    && JSON.stringify(left.previousCheckpointId) === JSON.stringify(right.previousCheckpointId)
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
    && JSON.stringify(left.cycleId) === JSON.stringify(right.cycleId)
    && JSON.stringify(left.recoveryStateRef) === JSON.stringify(right.recoveryStateRef)
    && JSON.stringify(left.evidenceRefs) === JSON.stringify(right.evidenceRefs);
}

export function checkpointCommitId(checkpoint: Pick<Checkpoint, 'id' | 'scope'>): string {
  const { scope } = checkpoint;
  return `checkpoint:${scope.organId.value}:${scope.taskId?.value ?? '-'}:${scope.cycleId?.value ?? '-'}:${scope.operationId?.value ?? '-'}:${checkpoint.id.value}`;
}

function asRecallError(error: unknown): CheckpointRecallError {
  if (error instanceof CheckpointRecallError) return error;
  return new CheckpointRecallError(error instanceof Error ? error.message : String(error));
}

function asCompletionError(error: unknown): CheckpointCompletionError {
  if (error instanceof CheckpointCompletionError) return error;
  return new CheckpointCompletionError(error instanceof Error ? error.message : String(error), { cause: error });
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

    const latest = await journal.readLatest(input.checkpoint.scope);
    if (latest && sameId(latest.checkpoint.id, input.checkpoint.id)) {
      if (!sameCheckpoint(latest.checkpoint, input.checkpoint)) {
        throw new CheckpointCompletionError('checkpoint id is already committed with different content');
      }
      return {
        checkpoint: latest.checkpoint,
        receipt: {
          checkpointId: latest.checkpoint.id,
          seq: latest.checkpoint.seq,
          ...(latest.recordDigest === undefined ? {} : { recordDigest: latest.recordDigest }),
        },
        windows: assembleCheckpointWindows(latest.checkpoint, input.windowLimits),
      };
    }

    const receipt = await journal.append({
      ownerId: input.ownerId,
      commitId: checkpointCommitId(input.checkpoint),
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

/**
 * Digest of the exact ordered durable context body. It protects the assembled content and
 * is deliberately distinct from `ContextView.contextDigest`, which keeps its existing meaning.
 */
export function durableContextDigest(context: ContextBuildInput<JsonValue>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(context)).digest('hex')}`;
}

function sameScopedIdValue(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

/**
 * Matches one publication identity against committed affected-binding fences.
 * When the publication carries an agent runtime id, that id is part of the
 * match. A checkpoint publication has no runtime id, so its exact scope and
 * Harness epoch carry the bound identity instead of denying every numeric epoch.
 */
export function matchesExecutionIncarnationFence(
  fences: readonly ExecutionIncarnationRef[],
  candidate: ExecutionIncarnationRef,
): boolean {
  return fences.some((fence) => fence.executionEpoch === candidate.executionEpoch
    && sameScopedIdValue(fence.scope.organId, candidate.scope.organId)
    && sameScopedIdValue(fence.scope.taskId, candidate.scope.taskId)
    && sameScopedIdValue(fence.scope.cycleId, candidate.scope.cycleId)
    && sameScopedIdValue(fence.scope.operationId, candidate.scope.operationId)
    && (candidate.agentRuntimeId === undefined || fence.agentRuntimeId === candidate.agentRuntimeId));
}

export function sameJournalCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function assertJournalCommitRef(ref: JournalCommitRef, label: string): void {
  if (!ref.commitId.trim()) throw new ContextHistoryError(`${label} commit id is required`);
  if (!Number.isSafeInteger(ref.journalSeq) || ref.journalSeq < 1) {
    throw new ContextHistoryError(`${label} journal seq must be a positive safe integer`);
  }
  if (!ref.recordDigest.trim()) throw new ContextHistoryError(`${label} record digest is required`);
}

export function assertContextHistoryRecord(record: ContextHistoryRecord): void {
  // Canonical CT shape/binding validation is the single source of truth for the shared DTO.
  try {
    validateContextHistoryRecord(record);
  } catch (error) {
    throw new ContextHistoryError(error instanceof Error ? error.message : String(error));
  }
  // The exact ordered durable body digest is a Runtime-owned guarantee on top of the CT shape.
  const digest = durableContextDigest(record.durableContext);
  if (digest !== record.durableContextDigest) {
    throw new ContextHistoryError('context history durable context digest does not match its body');
  }
}

export interface ProduceContextHistoryInput {
  readonly record: ContextHistoryRecord;
  readonly expectedCurrentContextCommitRef: JournalCommitRef | null;
}

export interface ProducedContextHistory {
  readonly record: ContextHistoryRecord;
  readonly commitRef: JournalCommitRef;
}

/**
 * Pending -> durable commit -> exact readback. The committed body is read back and compared
 * to the prepared record before anything may install successor state. A commit or readback
 * failure surfaces unchanged; an unknown commit is never treated as absent.
 */
export async function produceContextHistory(
  port: ContextHistoryPort,
  input: ProduceContextHistoryInput,
): Promise<ProducedContextHistory> {
  assertContextHistoryRecord(input.record);
  const commitRef = await port.commit(input.record, input.expectedCurrentContextCommitRef);
  assertJournalCommitRef(commitRef, 'context history commit');
  const readback = await port.readContextCommit(input.record.scope, commitRef);
  if (
    readback.kind !== 'context-history'
    || readback.agentRuntimeId !== input.record.agentRuntimeId
    || readback.contextView.contextViewRef !== input.record.contextView.contextViewRef
    || readback.durableContextDigest !== input.record.durableContextDigest
  ) {
    throw new ContextHistoryError('context history readback does not match the committed identity');
  }
  if (durableContextDigest(readback.durableContext) !== readback.durableContextDigest) {
    throw new ContextHistoryError('context history readback body is corrupt');
  }
  return { record: readback, commitRef };
}

export async function readCommittedContextHistory(
  port: ContextHistoryPort,
  scope: ScopeRef,
  commitRef: JournalCommitRef,
): Promise<ContextHistoryRecord> {
  assertJournalCommitRef(commitRef, 'context history');
  const record = await port.readContextCommit(scope, commitRef);
  assertContextHistoryRecord(record);
  return record;
}

export async function readContextHistory(
  port: ContextHistoryPort,
  query: ContextHistoryReadQuery,
): Promise<ContextHistoryReadResult> {
  return port.readContextHistory(query);
}

function assertCheckpointInQuery(entry: CommittedCheckpointRecord, query: CheckpointListQuery): void {
  const scope = entry.checkpoint.scope;
  if (!sameScopedIdValue(scope.organId, query.scope.organId)) {
    throw new ContextHistoryError('committed checkpoint is outside the query organ');
  }
  if (query.scope.taskId && !sameScopedIdValue(scope.taskId, query.scope.taskId)) {
    throw new ContextHistoryError('committed checkpoint is outside the query task');
  }
  if (query.scope.cycleId && !sameScopedIdValue(scope.cycleId, query.scope.cycleId)) {
    throw new ContextHistoryError('committed checkpoint is outside the query cycle');
  }
  if (query.scope.operationId && !sameScopedIdValue(scope.operationId, query.scope.operationId)) {
    throw new ContextHistoryError('committed checkpoint is outside the query operation');
  }
  if (query.cycleId && !sameScopedIdValue(scope.cycleId, query.cycleId)) {
    throw new ContextHistoryError('committed checkpoint does not match the cycle filter');
  }
  if (query.directiveRevision !== undefined && entry.checkpoint.directiveRevision !== query.directiveRevision) {
    throw new ContextHistoryError('committed checkpoint does not match the directive revision filter');
  }
  if (query.executionEpoch !== undefined && entry.checkpoint.executionEpoch !== query.executionEpoch) {
    throw new ContextHistoryError('committed checkpoint does not match the execution epoch filter');
  }
}

/**
 * Enumerate committed checkpoints. Every filter is an independent AND predicate; a port that
 * returns an entry which violates any filter is rejected instead of silently widening the query.
 * The `occurrenceRef` filter is an explicit unavailable external dependency and must fail.
 */
export async function enumerateCheckpointHistory(
  journal: CheckpointJournalReaderPort,
  query: CheckpointListQuery,
): Promise<CheckpointListResult> {
  if (query.occurrenceRef !== undefined) {
    throw new ContextHistoryError('occurrence checkpoint filter is unavailable: no occurrence binding producer');
  }
  if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
    throw new ContextHistoryError('checkpoint list limit must be a positive safe integer');
  }
  const result = await journal.listCommitted(query);
  for (const entry of result.checkpoints) assertCheckpointInQuery(entry, query);
  return result;
}

export async function readCommittedCheckpoint(
  journal: CheckpointJournalReaderPort,
  scope: ScopeRef,
  checkpointId: Checkpoint['id'],
): Promise<CommittedCheckpointRecord | null> {
  return journal.readCommitted(scope, checkpointId);
}

export async function readExecutionPosition(
  journal: CheckpointJournalReaderPort,
  taskScope: ScopeRef,
): Promise<ExecutionPosition | null> {
  return journal.readExecutionPosition(taskScope);
}

export async function readCheckpointRecoveryBinding(
  journal: CheckpointJournalReaderPort,
  scope: ScopeRef,
  checkpointCommitRef: JournalCommitRef,
): Promise<CheckpointRecoveryBinding | null> {
  return journal.readCheckpointRecoveryBinding(scope, checkpointCommitRef);
}
export async function completeNativeCheckpoint(
  journal: NativeCheckpointJournalPort,
  input: CompleteNativeCheckpointInput,
): Promise<CheckpointReceiptRelationshipV1> {
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

    return await journal.commitNativeCheckpoint(input);
  } catch (error) {
    throw asCompletionError(error);
  }
}
