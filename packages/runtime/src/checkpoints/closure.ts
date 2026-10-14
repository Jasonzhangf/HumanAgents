import { createHash } from 'node:crypto';
import {
  assertEvidenceRef,
  assertCheckpointLink,
  assertSameScope,
  assertTurnSummaryContextIdentity,
  canonicalJsonStringify,
  validateAdmittedTurnIdentity,
  validatePlannerAlignmentReference,
  validateTurnCloseSummary,
  validateTurnRecoveryReference,
  validateJournalCommitRef,
  type AdmittedTurnIdentity,
  type Checkpoint,
  type CheckpointClosureRecord as CoreCheckpointClosureRecord,
  type EvidenceRef,
  type JournalCommitRef,
  type NextAction,
  type OperationId,
  type PlannerAlignmentReference,
  type ScopeRef,
  type TurnCloseSummary,
  type TurnSummaryEvidenceContext,
} from '../../../contracts/src/index.js';
import { isTerminalOperationStatus } from '../../../core/src/index.js';
import type { OperationControlReadback, OperationControlSelector } from '../gateway/ports.js';
import type { ConditionalReentryRecord } from './conditional-reentry.js';
import type { CheckpointClosurePort, CheckpointRecoveryBinding, ContextHistoryPort } from './ports.js';
import { checkpointCommitId, readCommittedContextHistory } from './coordinator.js';
import { CheckpointClosureError, CheckpointClosureSourceError, CheckpointSubmissionError } from './errors.js';

export type CheckpointSubmissionSource = 'agent-tool' | 'harness-control' | 'recovery';

export function sanitizeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  return cleaned || 'turn';
}

/** Existing durable turn record keys, shared by their writers and exact readers. */
export function turnBoundaryRecordRefs(
  identity: Pick<AdmittedTurnIdentity, 'turnId'>,
  checkpointId: Checkpoint['id'],
): {
  readonly turnClosureRef: string;
  readonly turnRecoveryRecordRef: string;
  readonly alignmentRef: string;
} {
  const suffix = `${sanitizeId(identity.turnId)}:${checkpointId.value}`;
  return {
    turnClosureRef: `turn-closure:${suffix}`,
    turnRecoveryRecordRef: `turn-recovery:${suffix}`,
    alignmentRef: `turn-alignment:${suffix}`,
  };
}

export interface CheckpointReentryDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly blockedBy?: readonly string[];
}

export type CheckpointClosureCompatibilityVersion = 1 | 2;

export interface CheckpointClosureRecord {
  readonly closureKind: 'checkpoint';
  readonly compatibilityVersion: CheckpointClosureCompatibilityVersion;
  readonly closureId: string;
  readonly checkpointId: Checkpoint['id'];
  readonly source: CheckpointSubmissionSource;
  readonly outcome: Checkpoint['outcome'];
  readonly summary: string;
  readonly next: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly reentry: CheckpointReentryDecision;
  /** Optional only for records produced before the bound closure format. */
  readonly recoveryBinding?: CheckpointRecoveryBinding;
}

export interface CheckpointClosurePermissionEvidence {
  readonly permissionRevision: string;
  readonly grantCommitRef: JournalCommitRef;
  readonly revoked: boolean;
}

export interface CheckpointClosurePreparationRecord {
  readonly closureKind: 'checkpoint-closure-preparation';
  readonly closureId: string;
  readonly checkpointClosureId: string;
  readonly scope: ScopeRef;
  readonly checkpointId: Checkpoint['id'];
  readonly checkpointDigest: string;
  readonly contextCommitRef: JournalCommitRef;
  readonly operationSelector: OperationControlSelector;
  readonly operationControl: Extract<OperationControlReadback, { readonly state: 'complete' }>;
  readonly permission: CheckpointClosurePermissionEvidence;
  readonly hardBlockers: readonly string[];
  readonly unreturnedCallRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
  readonly coreClosure: Omit<CoreCheckpointClosureRecord, 'committed'>;
  readonly reentry: CheckpointReentryDecision;
}

export interface PrepareCheckpointClosureInput {
  readonly checkpoint: Checkpoint;
  readonly source: CheckpointSubmissionSource;
  readonly closureReason: string;
  readonly contextCommitRef: JournalCommitRef;
  readonly contextHistory: ContextHistoryPort;
  readonly operationSelector: OperationControlSelector;
  readonly operationControl: OperationControlReadback;
  readonly permission: CheckpointClosurePermissionEvidence;
  readonly hardBlockers: readonly string[];
  readonly unreturnedCallRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
  readonly closurePort: CheckpointClosurePort;
  readonly now: () => Date;
}

export function checkpointClosurePreparationId(checkpoint: Pick<Checkpoint, 'scope' | 'id'>): string {
  return `checkpoint-closure-preparation:${checkpointCommitId(checkpoint)}`;
}

export async function readCheckpointClosurePreparation(
  port: CheckpointClosurePort,
  checkpoint: Pick<Checkpoint, 'scope' | 'id'>,
): Promise<CheckpointClosurePreparationRecord | null> {
  let record: ClosureRecord | null;
  try {
    record = await port.read(checkpointClosurePreparationId(checkpoint));
  } catch (cause) {
    throw new CheckpointClosureSourceError('checkpoint closure preparation read is unknown', { cause });
  }
  if (!record) return null;
  if (!('closureKind' in record) || record.closureKind !== 'checkpoint-closure-preparation'
    || record.closureId !== checkpointClosurePreparationId(checkpoint)
    || !sameScopedId(record.checkpointId, checkpoint.id)) {
    throw new CheckpointClosureError('checkpoint closure preparation identity conflicts');
  }
  assertSameScope(checkpoint.scope, record.scope);
  return record;
}

/** Native and turn callers share this exact preparation seam; no checkpoint append occurs here. */
export async function prepareCheckpointClosure(input: PrepareCheckpointClosureInput): Promise<CheckpointClosurePreparationRecord> {
  // This exact read must precede clock sampling, including after a lost acknowledgement.
  const existing = await readCheckpointClosurePreparation(input.closurePort, input.checkpoint);
  if (input.operationControl.state === 'unknown') {
    throw new CheckpointClosureSourceError(`operation control coverage is unknown: ${input.operationControl.reason}`);
  }
  const checkpoint = input.checkpoint;
  assertSameScope(checkpoint.scope, input.operationSelector.scope);
  assertSameScope(input.operationSelector.scope, input.operationControl.scope);
  nonEmpty(input.closureReason, 'checkpoint closure reason');
  nonEmpty(input.permission.permissionRevision, 'closure permission revision');
  const context = await readCommittedContextHistory(input.contextHistory, checkpoint.scope, input.contextCommitRef);
  assertSameScope(checkpoint.scope, context.scope);
  if (context.loopCheckpoint.executionEpoch !== checkpoint.executionEpoch
    || (input.operationSelector.agentRuntimeId !== undefined && input.operationSelector.agentRuntimeId !== context.agentRuntimeId)
    || (input.operationSelector.harnessExecutionEpoch !== undefined && input.operationSelector.harnessExecutionEpoch !== checkpoint.executionEpoch)) {
    throw new CheckpointClosureError('closure context/selector does not match the Harness runtime epoch');
  }
  const pending: string[] = [...input.unreturnedCallRefs, ...input.unresolvedOperationRefs];
  const unknown: string[] = [...input.unresolvedOperationRefs];
  for (const operation of input.operationControl.operations) {
    const binding = operation.binding;
    const selected = input.operationSelector.scope;
    if (!sameScopedId(binding.scope.organId, selected.organId)
      || (selected.taskId && !sameScopedId(binding.scope.taskId, selected.taskId))
      || (selected.cycleId && !sameScopedId(binding.scope.cycleId, selected.cycleId))
      || (selected.operationId && (!sameScopedId(binding.scope.operationId, selected.operationId)
        || !sameScopedId(binding.parentOperationId, selected.operationId)))
      || (input.operationSelector.agentRuntimeId !== undefined && binding.agentRuntimeId !== input.operationSelector.agentRuntimeId)
      || (input.operationSelector.harnessExecutionEpoch !== undefined && binding.harnessExecutionEpoch !== input.operationSelector.harnessExecutionEpoch)) {
      throw new CheckpointClosureError('operation control contains facts outside the closure selector');
    }
    const ref = operation.intent.operationId.value;
    const uncertain = operation.status === 'reconcile_required' || operation.reconcile !== undefined
      || operation.observation?.sideEffectState === 'possible' || operation.blocked?.sideEffectState === 'possible';
    // A terminal event without the result/failure settlement body is still an obligation.
    const settled = isTerminalOperationStatus(operation.status) && (operation.result !== undefined || operation.failure !== undefined);
    if (!settled || uncertain) pending.push(ref);
    if (uncertain) unknown.push(ref);
  }
  const unknownOperations = [...new Set(unknown)];
  const reentry = computeReentryDecision({
    outcome: checkpoint.outcome,
    permissionRevoked: input.permission.revoked,
    hardBlockers: [...input.hardBlockers, ...(unknownOperations.length ? ['unknown-operations'] : [])],
  });
  const nonTime = {
    closureKind: 'checkpoint-closure-preparation' as const,
    closureId: checkpointClosurePreparationId(checkpoint),
    checkpointClosureId: `checkpoint-closure:${checkpointCommitId(checkpoint)}`,
    scope: checkpoint.scope,
    checkpointId: checkpoint.id,
    checkpointDigest: `sha256:${createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex')}`,
    contextCommitRef: input.contextCommitRef,
    operationSelector: input.operationSelector,
    operationControl: input.operationControl,
    permission: input.permission,
    hardBlockers: input.hardBlockers,
    unreturnedCallRefs: input.unreturnedCallRefs,
    unresolvedOperationRefs: input.unresolvedOperationRefs,
    coreClosure: {
      checkpointId: checkpoint.id,
      source: input.source,
      closureReason: input.closureReason,
      executionEpoch: checkpoint.executionEpoch,
      reentryAllowed: reentry.allowed,
      pendingOperations: [...new Set(pending)],
      unknownOperations,
      recoveryStateRef: checkpoint.recoveryStateRef,
      nextAction: checkpoint.next,
    },
    reentry,
  };
  const compare = (record: CheckpointClosurePreparationRecord): boolean => {
    const { closedAt: _closedAt, ...coreClosure } = record.coreClosure;
    return JSON.stringify({ ...record, coreClosure }) === JSON.stringify(nonTime);
  };
  if (existing) {
    if (!compare(existing)) throw new CheckpointClosureError('checkpoint closure preparation has different non-time facts');
    return existing;
  }
  const preparation: CheckpointClosurePreparationRecord = {
    ...nonTime,
    coreClosure: { ...nonTime.coreClosure, closedAt: input.now().toISOString() },
  };
  let commitError: unknown;
  try {
    const receipt = await input.closurePort.commit(preparation);
    if (!receipt.committed || receipt.closureId !== preparation.closureId) {
      throw new CheckpointClosureError('checkpoint closure preparation was not acknowledged');
    }
  } catch (error) {
    commitError = error;
  }
  const stored = await readCheckpointClosurePreparation(input.closurePort, checkpoint);
  if (!stored) {
    if (commitError) throw commitError;
    throw new CheckpointClosureSourceError('checkpoint closure preparation readback is absent');
  }
  if (!compare(stored)) throw new CheckpointClosureError('checkpoint closure preparation has different non-time facts');
  return stored;
}

export interface DeadEndRecord {
  readonly deadEndRef: string;
  readonly scope: ScopeRef;
  readonly failedPathRefs: readonly string[];
  readonly conclusion: string;
  readonly invalidatedAssumptions: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly suggestedAlternatives?: readonly string[];
}

export interface InteractionClosureRecord {
  readonly closureKind: 'interaction';
  readonly closureId: string;
  readonly scope: ScopeRef;
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly next?: NextAction;
}

export interface ReentryRecord {
  readonly closureKind: 'reentry';
  readonly closureId: string;
  readonly checkpointId: Checkpoint['id'];
  readonly checkpointExecutionEpoch: number;
  readonly previousExecutionEpoch: number;
  readonly newExecutionEpoch: number;
  readonly deadEndRef?: string;
  readonly nextAction: NextAction;
  readonly reentry: CheckpointReentryDecision;
}

/**
 * Durable closure fact for exactly one admitted turn. It binds the turn identity,
 * the committed checkpoint, the checkpoint closure commit, and the typed four-part
 * summary. The recovery responsibility stays in a separate `TurnRecoveryRecord`.
 */
export interface TurnClosureRecord {
  readonly closureKind: 'turn-closure';
  readonly closureId: string;
  readonly identity: AdmittedTurnIdentity;
  readonly checkpointId: Checkpoint['id'];
  readonly closureRef: string;
  readonly recoveryStateRef: EvidenceRef;
  readonly summary: TurnCloseSummary;
  readonly closedAt: string;
  readonly reviewCommitRefs?: readonly JournalCommitRef[];
  /**
   * Trusted control context persisted with the closure. It is supplied by the
   * App readback, never derived from the summary or model args. Absent means the
   * original exact parent scope rule applies.
   */
  readonly summaryEvidenceContext?: TurnSummaryEvidenceContext;
}

/**
 * Durable same-turn recovery responsibility. It keeps the logical turn alive while
 * closure or planner alignment is incomplete. Recovery facts never claim success.
 */
export interface TurnRecoveryRecord {
  readonly closureKind: 'turn-recovery';
  readonly closureId: string;
  readonly identity: AdmittedTurnIdentity;
  readonly checkpointId: Checkpoint['id'];
  readonly recoveryStateRef: EvidenceRef;
  readonly contextRef: string;
  readonly unfinishedRef: string;
  readonly unreturnedCallRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
  readonly firstErrorRef?: string;
  readonly failedPhase: TurnRecoveryPhase;
  readonly frozenClose?: FrozenTurnCloseCandidateV1;
}

/** Serializable inputs retained before the checkpoint submission can have effects. */
export interface FrozenTurnCloseCandidateV1 {
  readonly version: 1;
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
  readonly inputs: Omit<import('../agent-loop/runtime.js').CloseTurnInput, 'prepareCheckpointClosure' | 'reviewCommitRefs'>;
  readonly reviewCommitRefs: readonly JournalCommitRef[];
  readonly bound: boolean;
}

export function frozenTurnCloseRef(identity: AdmittedTurnIdentity): string {
  return `turn-frozen-close:${identity.turnId}`;
}

/**
 * Durable planner-alignment fact. It binds one published plan revision to the same
 * admitted turn, committed checkpoint, and checkpoint closure. The revision's exact
 * journal commit reference is carried verbatim so recovery re-reads that publication
 * instead of publishing a second one.
 */
export interface PlannerAlignmentRecord {
  readonly closureKind: 'planner-alignment';
  readonly closureId: string;
  readonly alignment: PlannerAlignmentReference;
  readonly planJournalCommitRef: string;
}

export type TurnRecoveryPhase = 'recovery' | 'submission' | 'turn-closure' | 'alignment';

export type CheckpointClosureRecordInput =
  | CheckpointClosureRecord
  | DeadEndRecord
  | InteractionClosureRecord
  | ReentryRecord
  | ConditionalReentryRecord;

export type ClosureRecord =
  | CheckpointClosureRecord
  | CheckpointClosurePreparationRecord
  | DeadEndRecord
  | InteractionClosureRecord
  | ReentryRecord
  | ConditionalReentryRecord
  | TurnClosureRecord
  | TurnRecoveryRecord
  | PlannerAlignmentRecord;

export interface OperationReconcileResult {
  readonly operationId: OperationId;
  readonly state: 'reconciled' | 'unknown' | 'not-found';
  readonly evidenceRef?: EvidenceRef;
}

export interface OperationReconcilePort {
  reconcile(input: { readonly operationId: OperationId }): Promise<OperationReconcileResult>;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new CheckpointClosureError(`${label} is required`);
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new CheckpointClosureError(`${label} must be a positive safe integer`);
  return value;
}

function sameScopedId(left: { readonly scope: string; readonly value: string } | undefined, right: { readonly scope: string; readonly value: string } | undefined): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

export function sameEvidenceRef(left: EvidenceRef, right: EvidenceRef): boolean {
  return sameScopedId(left.evidenceId, right.evidenceId)
    && left.kind === right.kind
    && left.source === right.source
    && left.locator === right.locator
    && left.digest === right.digest
    && sameScopedId(left.scope.organId, right.scope.organId)
    && sameScopedId(left.scope.taskId, right.scope.taskId)
    && sameScopedId(left.scope.cycleId, right.scope.cycleId)
    && sameScopedId(left.scope.operationId, right.scope.operationId);
}

export function sameReentryDecision(left: CheckpointReentryDecision, right: CheckpointReentryDecision): boolean {
  return left.allowed === right.allowed
    && left.reason === right.reason
    && JSON.stringify(left.blockedBy) === JSON.stringify(right.blockedBy);
}

export function sameCheckpointClosureRecord(left: CheckpointClosureRecord, right: CheckpointClosureRecord): boolean {
  return left.closureKind === right.closureKind
    && left.closureId === right.closureId
    && left.checkpointId.scope === right.checkpointId.scope
    && left.checkpointId.value === right.checkpointId.value
    && left.source === right.source
    && left.outcome === right.outcome
    && left.summary === right.summary
    && left.next.kind === right.next.kind
    && left.next.ref === right.next.ref
    && left.evidenceRefs.length === right.evidenceRefs.length
    && left.evidenceRefs.every((evidenceRef, index) => sameEvidenceRef(evidenceRef, right.evidenceRefs[index]!))
    && JSON.stringify(left.recoveryBinding) === JSON.stringify(right.recoveryBinding)
    && sameReentryDecision(left.reentry, right.reentry);
}

export function sameReentryRecord(left: ReentryRecord, right: ReentryRecord): boolean {
  if ('schemaVersion' in left || 'schemaVersion' in right) {
    return 'schemaVersion' in left
      && 'schemaVersion' in right
      && JSON.stringify(left) === JSON.stringify(right);
  }
  return left.closureKind === right.closureKind
    && left.closureId === right.closureId
    && left.checkpointId.scope === right.checkpointId.scope
    && left.checkpointId.value === right.checkpointId.value
    && left.checkpointExecutionEpoch === right.checkpointExecutionEpoch
    && left.previousExecutionEpoch === right.previousExecutionEpoch
    && left.newExecutionEpoch === right.newExecutionEpoch
    && left.deadEndRef === right.deadEndRef
    && left.nextAction.kind === right.nextAction.kind
    && left.nextAction.ref === right.nextAction.ref
    && sameReentryDecision(left.reentry, right.reentry);
}

export function sameOperationId(left: OperationId, right: OperationId): boolean {
  return left.scope === right.scope && left.value === right.value;
}

export function assertReconcileEvidenceScope(scope: ScopeRef, evidenceRef: EvidenceRef, operationId: OperationId): void {
  try {
    assertEvidenceRef(evidenceRef);
  } catch (error) {
    throw new CheckpointSubmissionError(error instanceof Error ? error.message : 'reconcile evidence is invalid');
  }
  if (evidenceRef.kind !== 'operation') throw new CheckpointSubmissionError('reconcile evidence must use operation kind');
  if (!evidenceRef.scope.operationId || !sameOperationId(operationId, evidenceRef.scope.operationId)) {
    throw new CheckpointSubmissionError('reconcile evidence operation does not match reconciled operation');
  }
  if (scope.operationId) {
    if (!sameOperationId(scope.operationId, evidenceRef.scope.operationId ?? scope.operationId)) {
      throw new CheckpointSubmissionError('reconcile evidence operation does not match checkpoint scope');
    }
  } else if (evidenceRef.scope.operationId) {
    if (!sameOperationId(operationId, evidenceRef.scope.operationId)) {
      throw new CheckpointSubmissionError('reconcile evidence operation does not match reconciled operation');
    }
  }
  try {
    assertSameScope(
      { organId: scope.organId, taskId: scope.taskId, cycleId: scope.cycleId },
      { organId: evidenceRef.scope.organId, taskId: evidenceRef.scope.taskId, cycleId: evidenceRef.scope.cycleId },
    );
  } catch (error) {
    throw new CheckpointSubmissionError(error instanceof Error ? error.message : 'reconcile evidence scope does not match checkpoint scope');
  }
}

export async function reconcileUnknownOperations(
  port: OperationReconcilePort,
  operationIds: readonly OperationId[],
): Promise<{ readonly reconciled: readonly OperationReconcileResult[]; readonly unresolved: readonly OperationId[] }> {
  const reconciled: OperationReconcileResult[] = [];
  const unresolved: OperationId[] = [];
  for (const operationId of operationIds) {
    const result = await port.reconcile({ operationId });
    if (result.state === 'reconciled' && result.evidenceRef) {
      reconciled.push(result);
    } else {
      unresolved.push(operationId);
    }
  }
  return { reconciled, unresolved };
}

export function computeReentryDecision(input: {
  readonly outcome: Checkpoint['outcome'];
  readonly permissionRevoked?: boolean;
  readonly hardBlockers?: readonly string[];
  readonly unresolvedOperations?: readonly OperationId[];
}): CheckpointReentryDecision {
  const blockedBy: string[] = [];
  if (input.permissionRevoked) blockedBy.push('permission-revoked');
  if ((input.unresolvedOperations?.length ?? 0) > 0) blockedBy.push('unknown-operations');
  for (const blocker of input.hardBlockers ?? []) blockedBy.push(blocker);
  if (blockedBy.length > 0) {
    return { allowed: false, reason: 'checkpoint committed without reentry admission', blockedBy };
  }
  switch (input.outcome) {
    case 'waiting':
      return { allowed: true, reason: 'waiting checkpoint can be reentered from its recovery condition' };
    case 'succeeded':
      return { allowed: true, reason: 'succeeded checkpoint is committed and can be recalled' };
    default:
      return { allowed: false, reason: `${input.outcome} closure is not reentrant without explicit reentry` };
  }
}

export function assertDeadEndRecord(record: DeadEndRecord): void {
  nonEmpty(record.deadEndRef, 'dead-end ref');
  if (record.failedPathRefs.length === 0) throw new CheckpointClosureError('dead-end failed paths are required');
  for (const path of record.failedPathRefs) nonEmpty(path, 'dead-end failed path');
  nonEmpty(record.conclusion, 'dead-end conclusion');
  if (record.invalidatedAssumptions.length === 0) throw new CheckpointClosureError('dead-end invalidated assumptions are required');
  for (const assumption of record.invalidatedAssumptions) nonEmpty(assumption, 'dead-end invalidated assumption');
  if (record.evidenceRefs.length === 0) throw new CheckpointClosureError('dead-end evidence is required');
  for (const evidenceRef of record.evidenceRefs) {
    try {
      assertEvidenceRef(evidenceRef);
      assertSameScope(record.scope, evidenceRef.scope);
    } catch (error) {
      throw new CheckpointClosureError(error instanceof Error ? error.message : 'dead-end evidence is invalid');
    }
  }
}

export function assertInteractionClosure(input: {
  readonly closureId: string;
  readonly scope: ScopeRef;
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}): void {
  nonEmpty(input.closureId, 'interaction closure id');
  nonEmpty(input.reason, 'interaction closure reason');
  if (input.scope.taskId || input.scope.cycleId || input.scope.operationId) {
    throw new CheckpointClosureError('interaction closure must use an interaction scope without task checkpoint identity');
  }
  if (input.evidenceRefs.length === 0) throw new CheckpointClosureError('interaction closure evidence is required');
  for (const evidenceRef of input.evidenceRefs) {
    try {
      assertEvidenceRef(evidenceRef);
      assertSameScope(input.scope, evidenceRef.scope);
    } catch (error) {
      throw new CheckpointClosureError(error instanceof Error ? error.message : 'interaction closure evidence is invalid');
    }
  }
}

export function assertReentryRecord(input: {
  readonly closureId: string;
  readonly checkpointId: Checkpoint['id'];
  readonly checkpointExecutionEpoch: number;
  readonly previousExecutionEpoch: number;
  readonly newExecutionEpoch: number;
  /** Present only on the schema-versioned conditional extension. */
  readonly schemaVersion?: number;
  readonly deadEndRef?: string;
  readonly nextAction: NextAction;
}): void {
  nonEmpty(input.closureId, 'reentry closure id');
  if (input.checkpointId.scope !== 'checkpoint' || !input.checkpointId.value.trim()) {
    throw new CheckpointClosureError('reentry checkpoint id is invalid');
  }
  positiveSafeInteger(input.previousExecutionEpoch, 'reentry previous execution epoch');
  positiveSafeInteger(input.newExecutionEpoch, 'reentry new execution epoch');
  if (input.schemaVersion !== 1 && input.checkpointExecutionEpoch !== input.previousExecutionEpoch) {
    throw new CheckpointClosureError('reentry previous execution epoch must match checkpoint');
  }
  if (input.newExecutionEpoch <= input.previousExecutionEpoch) {
    throw new CheckpointClosureError('reentry must create a new execution epoch');
  }
  if (input.deadEndRef !== undefined && !input.deadEndRef.trim()) {
    throw new CheckpointClosureError('reentry dead-end ref must be non-empty');
  }
  if (input.nextAction.kind !== 'continue' && input.nextAction.kind !== 'wait' && input.nextAction.kind !== 'recover') {
    throw new CheckpointClosureError('reentry next action must allow reentry');
  }
  if ((input.nextAction.kind === 'wait' || input.nextAction.kind === 'recover') && !input.nextAction.ref?.trim()) {
    throw new CheckpointClosureError('reentry next action requires a reference');
  }
}

const TURN_RECOVERY_PHASES: readonly TurnRecoveryPhase[] = ['recovery', 'submission', 'turn-closure', 'alignment'];

function assertTurnRecoveryPhase(value: unknown): asserts value is TurnRecoveryPhase {
  if (typeof value !== 'string' || !TURN_RECOVERY_PHASES.includes(value as TurnRecoveryPhase)) {
    throw new CheckpointClosureError(`turn recovery phase must be one of: ${TURN_RECOVERY_PHASES.join(', ')}`);
  }
}

/** Empty and absent lists both mean no attribution. Receipt order is part of the binding. */
export function sameReviewCommitRefs(
  left: readonly JournalCommitRef[] | undefined,
  right: readonly JournalCommitRef[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((ref, index) => {
    const other = b[index]!;
    return ref.commitId === other.commitId && ref.journalSeq === other.journalSeq && ref.recordDigest === other.recordDigest;
  });
}

/** Copy and retain acceptance order; repeated acceptance of one exact receipt is idempotent. */
export function distinctReviewCommitRefs(refs: readonly JournalCommitRef[] = []): readonly JournalCommitRef[] {
  if (!Array.isArray(refs)) throw new CheckpointClosureError('review commit references must be an array');
  const result: JournalCommitRef[] = [];
  for (const ref of refs) {
    validateJournalCommitRef(ref);
    if (!result.some((existing) => sameReviewCommitRefs([existing], [ref]))) result.push({ ...ref });
  }
  return result;
}

/** Validate a durable turn-closure record by reusing the frozen Contracts validators. */
export function assertTurnClosureRecord(record: TurnClosureRecord, context?: TurnSummaryEvidenceContext): void {
  try {
    nonEmpty(record.closureId, 'turn closure id');
    validateAdmittedTurnIdentity(record.identity);
    const effectiveContext = context ?? record.summaryEvidenceContext;
    if (effectiveContext !== undefined) assertTurnSummaryContextIdentity(effectiveContext, record.identity);
    if (context !== undefined && record.summaryEvidenceContext !== undefined
      && canonicalJsonStringify(context) !== canonicalJsonStringify(record.summaryEvidenceContext)) {
      throw new CheckpointClosureError('turn closure summary evidence context conflicts with the durable context');
    }
    validateTurnCloseSummary(record.summary, record.identity.scopeRef, effectiveContext);
    if (record.checkpointId.scope !== 'checkpoint' || !record.checkpointId.value.trim()) {
      throw new CheckpointClosureError('turn closure checkpoint id is invalid');
    }
    nonEmpty(record.closureRef, 'turn closure commit reference');
    nonEmpty(record.closedAt, 'turn closure closedAt');
    if (record.reviewCommitRefs !== undefined
      && distinctReviewCommitRefs(record.reviewCommitRefs).length !== record.reviewCommitRefs.length) {
      throw new CheckpointClosureError('turn closure review commit references must be distinct');
    }
  } catch (error) {
    throw new CheckpointClosureError(error instanceof Error ? error.message : 'turn closure record is invalid');
  }
}

/** Validate a durable turn-recovery record by reusing the frozen Contracts validators. */
export function assertTurnRecoveryRecord(record: TurnRecoveryRecord): void {
  try {
    nonEmpty(record.closureId, 'turn recovery id');
    if (record.checkpointId.scope !== 'checkpoint' || !record.checkpointId.value.trim()) {
      throw new CheckpointClosureError('turn recovery checkpoint id is invalid');
    }
    assertTurnRecoveryPhase(record.failedPhase);
    if (record.frozenClose) {
      const frozen = record.frozenClose;
      assertCheckpointLink(frozen.checkpoint, frozen.previous);
      assertSameScope(frozen.checkpoint.scope, record.identity.scopeRef);
      if (frozen.version !== 1 || typeof frozen.bound !== 'boolean'
        || frozen.checkpoint.id.value !== record.checkpointId.value
        || JSON.stringify(frozen.checkpoint.previousCheckpointId) !== JSON.stringify(frozen.previous?.id ?? null)
        || frozen.checkpoint.seq !== (frozen.previous?.seq ?? 0) + 1) {
        throw new CheckpointClosureError('frozen close candidate identity conflicts');
      }
      if (frozen.inputs.summaryEvidenceContext !== undefined) {
        assertTurnSummaryContextIdentity(frozen.inputs.summaryEvidenceContext, record.identity);
      }
      validateTurnCloseSummary(frozen.inputs.summary, record.identity.scopeRef, frozen.inputs.summaryEvidenceContext);
      if (frozen.checkpoint.directiveRevision !== record.identity.directiveRevision
        || frozen.checkpoint.cycleId.value !== record.identity.cycleRef.value
        || frozen.inputs.recovery.contextRef !== record.contextRef
        || frozen.inputs.recovery.unfinishedRef !== record.unfinishedRef
        || JSON.stringify(frozen.inputs.recovery.unreturnedCallRefs) !== JSON.stringify(record.unreturnedCallRefs)
        || JSON.stringify(frozen.inputs.recovery.unresolvedOperationRefs) !== JSON.stringify(record.unresolvedOperationRefs)) {
        throw new CheckpointClosureError('frozen close candidate inputs conflict with the recovery duty');
      }
      if (distinctReviewCommitRefs(frozen.reviewCommitRefs).length !== frozen.reviewCommitRefs.length) {
        throw new CheckpointClosureError('frozen close candidate contains duplicate reviews');
      }
    }
    validateTurnRecoveryReference({
      identity: record.identity,
      recoveryStateRef: record.recoveryStateRef,
      contextRef: record.contextRef,
      unfinishedRef: record.unfinishedRef,
      unreturnedCallRefs: record.unreturnedCallRefs,
      unresolvedOperationRefs: record.unresolvedOperationRefs,
      ...(record.firstErrorRef === undefined ? {} : { firstErrorRef: record.firstErrorRef }),
    });
  } catch (error) {
    throw new CheckpointClosureError(error instanceof Error ? error.message : 'turn recovery record is invalid');
  }
}

/** Validate a durable planner-alignment record by reusing the frozen Contracts validator. */
export function assertPlannerAlignmentRecord(record: PlannerAlignmentRecord): void {
  try {
    nonEmpty(record.closureId, 'planner alignment id');
    validatePlannerAlignmentReference(record.alignment);
    nonEmpty(record.planJournalCommitRef, 'planner alignment plan commit reference');
  } catch (error) {
    throw new CheckpointClosureError(error instanceof Error ? error.message : 'planner alignment record is invalid');
  }
}
