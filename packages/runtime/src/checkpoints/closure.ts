import {
  assertEvidenceRef,
  assertSameScope,
  type Checkpoint,
  type EvidenceRef,
  type NextAction,
  type OperationId,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { CheckpointClosureError, CheckpointSubmissionError } from './errors.js';

export type CheckpointSubmissionSource = 'agent-tool' | 'harness-control' | 'recovery';

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

export type CheckpointClosureRecordInput =
  | CheckpointClosureRecord
  | DeadEndRecord
  | InteractionClosureRecord
  | ReentryRecord;

export type ClosureRecord =
  | CheckpointClosureRecord
  | DeadEndRecord
  | InteractionClosureRecord
  | ReentryRecord;

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
    && sameReentryDecision(left.reentry, right.reentry);
}

export function sameReentryRecord(left: ReentryRecord, right: ReentryRecord): boolean {
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
  readonly deadEndRef?: string;
  readonly nextAction: NextAction;
}): void {
  nonEmpty(input.closureId, 'reentry closure id');
  if (input.checkpointId.scope !== 'checkpoint' || !input.checkpointId.value.trim()) {
    throw new CheckpointClosureError('reentry checkpoint id is invalid');
  }
  positiveSafeInteger(input.previousExecutionEpoch, 'reentry previous execution epoch');
  positiveSafeInteger(input.newExecutionEpoch, 'reentry new execution epoch');
  if (input.checkpointExecutionEpoch !== input.previousExecutionEpoch) {
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
