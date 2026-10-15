import type {
  AcceptedChildDelivery,
  AdmittedTurnIdentity,
  ChildInvocationRecord,
  EvidenceRef,
  RawAsset,
  RawContentReadPort,
  ScopeKind,
  ScopeRef,
} from '../../../contracts/src/index.js';
import {
  activeTurnCommitId,
  type ActiveTurnJournalRecord,
} from './active-turn-journal.js';

export interface AdoptedChildSourceV1 {
  readonly parentTurn: AdmittedTurnIdentity;
  readonly invocationId: string;
  readonly childTurnId: string;
  readonly deliverySeq: number;
  readonly adoptionCommitId: string;
  readonly deliveryCommitId: string;
  readonly kind: 'execution' | 'review';
  readonly refinedDelivery: RawAsset;
  readonly preCallCheckpointRef: string;
  readonly postReviewCheckpointRef?: string;
}

export interface MaterializedAdoptedChildSource {
  readonly source: AdoptedChildSourceV1;
  readonly delivery: AcceptedChildDelivery;
  readonly invocation: ChildInvocationRecord;
  readonly bytes: Uint8Array;
}

export class SemanticHistoryAdoptionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SemanticHistoryAdoptionError';
  }
}

function fail(code: string, message: string): never {
  throw new SemanticHistoryAdoptionError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameScope(
  left: ScopeRef,
  right: ScopeRef,
): boolean {
  return sameId(left.organId, right.organId)
    && sameId(left.taskId, right.taskId)
    && sameId(left.cycleId, right.cycleId)
    && sameId(left.operationId, right.operationId);
}

function isScopedId(value: unknown, scope: ScopeKind): boolean {
  return isPlainObject(value)
    && value.scope === scope
    && typeof value.value === 'string'
    && value.value.trim() !== '';
}

function isScopeRef(value: unknown): value is ScopeRef {
  if (!isPlainObject(value) || !isScopedId(value.organId, 'organ')) return false;
  return (value.taskId === undefined || isScopedId(value.taskId, 'task'))
    && (value.cycleId === undefined || isScopedId(value.cycleId, 'cycle'))
    && (value.operationId === undefined || isScopedId(value.operationId, 'operation'));
}

function sameEvidenceRef(left: EvidenceRef, right: EvidenceRef): boolean {
  return sameId(left.evidenceId, right.evidenceId)
    && left.kind === right.kind
    && left.source === right.source
    && left.locator === right.locator
    && left.digest === right.digest
    && sameScope(left.scope, right.scope);
}

function sameRawAsset(left: RawAsset, right: RawAsset): boolean {
  return sameEvidenceRef(left.ref, right.ref) && JSON.stringify(left.view) === JSON.stringify(right.view);
}

function sameAdmittedTurnIdentity(
  left: AdoptedChildSourceV1['parentTurn'],
  right: AdoptedChildSourceV1['parentTurn'],
): boolean {
  return left.turnId === right.turnId
    && left.workAssignmentRef === right.workAssignmentRef
    && sameId(left.taskRef, right.taskRef)
    && sameScope(left.scopeRef, right.scopeRef)
    && sameId(left.cycleRef, right.cycleRef)
    && left.inputRevision === right.inputRevision
    && left.directiveRevision === right.directiveRevision
    && left.executionEpoch === right.executionEpoch
    && left.runtimeBindingRef === right.runtimeBindingRef
    && left.permissionRevision === right.permissionRevision;
}

function assertSourceShape(source: AdoptedChildSourceV1): void {
  const value = source as unknown;
  if (!isPlainObject(value)) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source must be an object');
  }
  const candidate = value as Partial<AdoptedChildSourceV1>;
  if (!isPlainObject(candidate.parentTurn)) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source parentTurn is required');
  }
  if (!isPlainObject(candidate.refinedDelivery) || !isPlainObject(candidate.refinedDelivery.ref)) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source refined delivery is required');
  }
  if (!isPlainObject(candidate.refinedDelivery.view)) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source refined delivery view is required');
  }
  if (!isScopeRef(candidate.refinedDelivery.ref.scope)) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source refined delivery scope is required');
  }
  const requiredStrings: readonly [unknown, string][] = [
    [candidate.parentTurn.turnId, 'parent turn id'],
    [candidate.parentTurn.workAssignmentRef, 'parent work assignment reference'],
    [candidate.parentTurn.runtimeBindingRef, 'parent runtime binding reference'],
    [candidate.parentTurn.permissionRevision, 'parent permission revision'],
    [candidate.invocationId, 'invocation id'],
    [candidate.childTurnId, 'child turn id'],
    [candidate.adoptionCommitId, 'adoption commit id'],
    [candidate.deliveryCommitId, 'delivery commit id'],
    [candidate.preCallCheckpointRef, 'pre-call checkpoint reference'],
    [candidate.refinedDelivery.ref.source, 'refined delivery evidence source'],
    [candidate.refinedDelivery.ref.locator, 'refined delivery evidence locator'],
  ];
  for (const [text, label] of requiredStrings) {
    if (typeof text !== 'string' || !text.trim()) {
      fail('semantic-history-adoption.source.invalid', `adopted child source ${label} is required`);
    }
  }
  if (candidate.kind !== 'execution' && candidate.kind !== 'review') {
    fail('semantic-history-adoption.source.invalid', 'adopted child source kind is invalid');
  }
  if (candidate.postReviewCheckpointRef !== undefined
    && (typeof candidate.postReviewCheckpointRef !== 'string' || !candidate.postReviewCheckpointRef.trim())) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source post-review checkpoint reference is invalid');
  }
  if (!Number.isSafeInteger(candidate.deliverySeq) || (candidate.deliverySeq ?? 0) < 1) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source delivery sequence is invalid');
  }
  if (!Number.isSafeInteger(candidate.parentTurn.inputRevision) || candidate.parentTurn.inputRevision < 1
    || !Number.isSafeInteger(candidate.parentTurn.directiveRevision) || candidate.parentTurn.directiveRevision < 1
    || !Number.isSafeInteger(candidate.parentTurn.executionEpoch) || candidate.parentTurn.executionEpoch < 1) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source parent turn revision is invalid');
  }
  if (!isScopedId(candidate.parentTurn.taskRef, 'task')
    || !isScopedId(candidate.parentTurn.cycleRef, 'cycle')
    || !isScopeRef(candidate.parentTurn.scopeRef)) {
    fail('semantic-history-adoption.source.invalid', 'adopted child source parent turn scope is invalid');
  }
}

/**
 * Materializes the exact adopted child refinement from durable active-turn
 * replay. The child raw asset is never read; only the adopted descriptor is
 * resolved through the raw content port.
 */
export async function materializeAdoptedChildSource(input: {
  readonly source: AdoptedChildSourceV1;
  readonly records: readonly ActiveTurnJournalRecord[];
  readonly rawContent: RawContentReadPort;
}): Promise<MaterializedAdoptedChildSource> {
  const { source, records, rawContent } = input;
  assertSourceShape(source);

  const adoptionCommitId = activeTurnCommitId(source.parentTurn.turnId, `adopted:${source.invocationId}`);
  const deliveryCommitId = activeTurnCommitId(source.parentTurn.turnId, `delivery:${source.invocationId}`);
  if (source.adoptionCommitId !== adoptionCommitId || source.deliveryCommitId !== deliveryCommitId) {
    fail(
      'semantic-history-adoption.commit-identity.mismatch',
      'adopted child source commit identities do not match the active-turn records',
    );
  }

  const bindingOpened = records.find((record): record is Extract<ActiveTurnJournalRecord, { kind: 'binding-opened' }> => (
    record.kind === 'binding-opened' && record.binding.admittedTurn.turnId === source.parentTurn.turnId
  ));
  if (!bindingOpened) {
    fail('semantic-history-adoption.parent-turn.missing', `no binding-opened record for ${source.parentTurn.turnId}`);
  }
  if (!sameAdmittedTurnIdentity(bindingOpened.binding.admittedTurn, source.parentTurn)) {
    fail('semantic-history-adoption.parent-turn.mismatch', 'projected parent turn identity differs from the durable binding');
  }

  const invocationRecords = records.filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-invocation' }> => (
    record.kind === 'child-invocation' && record.record.invocationId === source.invocationId
  ));
  const invocation = invocationRecords[invocationRecords.length - 1]?.record;
  if (!invocation || invocation.adoptedResultSeq === undefined) {
    fail('semantic-history-adoption.invocation.unadopted', `invocation ${source.invocationId} has no durable adoptedResultSeq`);
  }
  if (invocation.childTurnId !== source.childTurnId
    || invocation.adoptedResultSeq !== source.deliverySeq
    || invocation.binding.kind !== source.kind
    || invocation.checkpointReceiptRef !== source.preCallCheckpointRef
    || (source.postReviewCheckpointRef !== undefined
      && invocation.postReviewCheckpointRef !== source.postReviewCheckpointRef)) {
    fail('semantic-history-adoption.invocation.mismatch', 'invocation replay does not match the adopted child source');
  }

  const deliveryEntry = records.find((record): record is Extract<ActiveTurnJournalRecord, { kind: 'child-delivery' }> => (
    record.kind === 'child-delivery'
    && record.entry.invocationId === source.invocationId
    && record.entry.seq === source.deliverySeq
  ))?.entry;
  if (!deliveryEntry) {
    fail('semantic-history-adoption.delivery.missing', `no child delivery at sequence ${source.deliverySeq}`);
  }
  if (deliveryEntry.kind !== source.kind
    || !sameRawAsset(deliveryEntry.refinedDelivery, source.refinedDelivery)) {
    fail('semantic-history-adoption.delivery.mismatch', 'child delivery kind or refined asset descriptor differs');
  }

  const bytes = await rawContent.read({
    scope: source.refinedDelivery.ref.scope,
    content: source.refinedDelivery,
  });
  return {
    source,
    delivery: deliveryEntry,
    invocation,
    bytes,
  };
}
