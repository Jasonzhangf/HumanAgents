import { assertSameScope, validateAcceptedChildDelivery, validateAcceptedRawFact } from '../../../contracts/src/index.js';
import type {
  AcceptedChildDelivery,
  AcceptedRawFact,
  ActiveTurnBinding,
  ChildInvocationRecord,
  RawAsset,
  RuntimeRequestRecord,
  ScopeRef,
} from '../../../contracts/src/index.js';
import {
  activeTurnCommitId,
  type ActiveTurnJournalAppendRequest,
  type ActiveTurnJournalPort,
  type ActiveTurnJournalRecord,
} from '../../../runtime/src/context/active-turn-journal.js';
import { JournalIntegrityError, JsonlOrganJournal, type JournalRecord } from './index.js';

/**
 * Turn-bound typed codec for the Runtime-owned active turn over the existing
 * authoritative Organ Journal. One port instance serves exactly one admitted
 * turn, and it is created only after that turn is admitted.
 *
 * The Organ Journal is a shared chain: checkpoint, public output, operation
 * completion and recovery-assets phase records live in the same file. The codec
 * verifies that chain and decodes only its own tagged records, leaving every
 * other record kind to its owner.
 *
 * The Journal payload is only the encoding carrier; the logical facts stay
 * typed, are keyed by the existing Runtime commit id, and are replayed with
 * integrity validation. The Organ Journal remains the authority and its commit
 * digests remain the tamper boundary. There is no second state store.
 */

const ACTIVE_TURN_PAYLOAD_TYPE = 'active-turn.record';
const ACTIVE_TURN_COMMIT_PREFIX = 'active-turn:';
const REQUEST_PHASES: readonly RuntimeRequestRecord['phase'][] = ['dispatching', 'dispatched', 'waiting', 'settled', 'failed', 'cancelled'];
const ACTIVE_TURN_KINDS: readonly ActiveTurnJournalRecord['kind'][] = [
  'binding-opened', 'initial-input', 'request', 'accepted-fact', 'child-invocation', 'child-delivery',
];

type ActiveTurnJournalPayload = {
  readonly type: typeof ACTIVE_TURN_PAYLOAD_TYPE;
  readonly record: ActiveTurnJournalRecord;
};

interface ValidatedRecord {
  readonly record: ActiveTurnJournalRecord;
  readonly turnId: string;
  readonly scope: ScopeRef;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new JournalIntegrityError(`${label} is required`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new JournalIntegrityError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertScope(value: ScopeRef, label: string): void {
  if (value.organId.scope !== 'organ' || value.organId.value.trim() === '') {
    throw new JournalIntegrityError(`${label} organ scope is invalid`);
  }
}

function assertTurnScope(scope: ScopeRef, binding: ActiveTurnBinding, label: string): void {
  try {
    assertSameScope(scope, binding.scope);
  } catch (error) {
    throw new JournalIntegrityError(`${label} scope does not match its active turn binding`, { cause: error });
  }
}

function assertBinding(binding: ActiveTurnBinding): void {
  nonEmpty(binding.admittedTurn.turnId, 'active turn binding turnId');
  nonEmpty(binding.admittedTurn.workAssignmentRef, 'active turn binding workAssignmentRef');
  nonEmpty(binding.assignment.assignmentId, 'active turn binding assignmentId');
  nonEmpty(binding.execution.runtimeId, 'active turn binding execution runtimeId');
  positiveInteger(binding.execution.executionEpoch, 'active turn binding execution epoch');
  assertScope(binding.scope, 'active turn binding');
  try {
    assertSameScope(binding.admittedTurn.scopeRef, binding.scope);
  } catch (error) {
    throw new JournalIntegrityError('active turn binding scope does not match its admitted turn', { cause: error });
  }
}

function turnIdFromCommitId(commitId: string, discriminator: string, admittedTurnId: string): string {
  const suffix = `:${discriminator}`;
  if (!commitId.startsWith(ACTIVE_TURN_COMMIT_PREFIX) || !commitId.endsWith(suffix)) {
    throw new JournalIntegrityError('active turn commit id does not match its record identity');
  }
  const turnId = commitId.slice(ACTIVE_TURN_COMMIT_PREFIX.length, commitId.length - suffix.length);
  if (turnId === '') throw new JournalIntegrityError('active turn commit id does not carry a turn id');
  if (turnId !== admittedTurnId) {
    throw new JournalIntegrityError(`active turn commit id does not belong to the admitted turn ${admittedTurnId}`);
  }
  return turnId;
}

function discriminatorOf(record: ActiveTurnJournalRecord): string {
  switch (record.kind) {
    case 'binding-opened':
      return 'binding-opened';
    case 'initial-input':
      return 'initial-input';
    case 'request':
      return `request:${record.record.request.requestId}:${record.record.phase}`;
    case 'accepted-fact':
      return `fact:${record.entry.envelope.request.requestId}:${record.entry.envelope.producerSeq}`;
    case 'child-invocation':
      return `invocation:${record.record.invocationId}`;
    default:
      return `delivery:${record.entry.invocationId}`;
  }
}

function validateRawAssetContent(asset: RawAsset, label: string): void {
  if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new JournalIntegrityError(`${label} must be a raw asset`);
  }
  const ref = asset.ref;
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new JournalIntegrityError(`${label} reference is required`);
  }
  if (ref.evidenceId === null || typeof ref.evidenceId !== 'object'
    || typeof ref.evidenceId.value !== 'string' || ref.evidenceId.value.trim() === '') {
    throw new JournalIntegrityError(`${label} evidence id is required`);
  }
  if (typeof ref.source !== 'string' || ref.source.trim() === ''
    || typeof ref.locator !== 'string' || ref.locator.trim() === '') {
    throw new JournalIntegrityError(`${label} locator is required`);
  }
  assertScope(ref.scope, label);
  const view = asset.view;
  if (view === null || typeof view !== 'object' || Array.isArray(view)) {
    throw new JournalIntegrityError(`${label} view is required`);
  }
  switch (view.kind) {
    case 'utf8-text':
    case 'arguments':
      return;
    case 'text-field':
      if (view.field === 'text' || view.field === 'delta') return;
      break;
    case 'thinking-field':
      if (view.field === 'thinking' || view.field === 'signature') return;
      break;
    case 'reasoning-item':
      if (view.selector === 'item-text' || view.selector === 'summary') return;
      break;
    case 'content-part':
      if (Number.isSafeInteger(view.partIndex) && view.partIndex >= 0) return;
      break;
    default:
      break;
  }
  throw new JournalIntegrityError(`${label} view kind is invalid`);
}

function payloadOf(record: JournalRecord): ActiveTurnJournalRecord {
  if (record.kind !== 'event') throw new JournalIntegrityError('active turn journal record must be an event');
  const payload = record.payload;
  if (payload === undefined
    || payload.type !== ACTIVE_TURN_PAYLOAD_TYPE
    || typeof payload.record !== 'object'
    || payload.record === null
    || Array.isArray(payload.record)) {
    throw new JournalIntegrityError('active turn journal record has no active-turn payload');
  }
  return payload.record as unknown as ActiveTurnJournalRecord;
}

function isActiveTurnCarrier(
  record: JournalRecord,
): record is ActiveTurnCarrierRecord {
  return record.kind === 'event'
    && record.payload?.type === ACTIVE_TURN_PAYLOAD_TYPE
    && typeof record.commitId === 'string'
    && record.commitId.trim() !== '';
}

type ActiveTurnCarrierRecord = JournalRecord & {
  readonly kind: 'event';
  readonly commitId: string;
  readonly payload: Record<string, unknown>;
};

function assertOwnedKind(kind: string): asserts kind is ActiveTurnJournalRecord['kind'] {
  if (!ACTIVE_TURN_KINDS.includes(kind as ActiveTurnJournalRecord['kind'])) {
    throw new JournalIntegrityError(`active turn record kind is not owned by this codec: ${kind}`);
  }
}

function isBoundTurnCarrier(record: ActiveTurnCarrierRecord, admittedTurnId: string): boolean {
  return record.commitId.startsWith(`${ACTIVE_TURN_COMMIT_PREFIX}${admittedTurnId}:`);
}

function bindingOfRecord(record: ActiveTurnJournalRecord, admittedTurnId: string): ActiveTurnBinding {
  if (record.kind !== 'binding-opened') throw new JournalIntegrityError('active turn binding record is required');
  assertBinding(record.binding);
  if (record.binding.admittedTurn.turnId !== admittedTurnId) {
    throw new JournalIntegrityError(`active turn binding does not belong to the admitted turn ${admittedTurnId}`);
  }
  return record.binding;
}

function validateRequestRecord(record: RuntimeRequestRecord): void {
  nonEmpty(record.request.turnId, 'active turn request turnId');
  nonEmpty(record.request.requestId, 'active turn request requestId');
  if (record.request.parentRequestId !== undefined) {
    nonEmpty(record.request.parentRequestId, 'active turn request parentRequestId');
    if (record.request.parentRequestId === record.request.requestId) {
      throw new JournalIntegrityError('active turn request parentRequestId cannot equal requestId');
    }
  }
  if (record.parentRequestId !== undefined && record.parentRequestId !== record.request.parentRequestId) {
    throw new JournalIntegrityError('active turn request parentRequestId does not match its request identity');
  }
  if (!REQUEST_PHASES.includes(record.phase)) throw new JournalIntegrityError('active turn request phase is invalid');
  assertScope(record.scope, 'active turn request');
}

function validateInvocationRecord(record: ChildInvocationRecord): void {
  nonEmpty(record.invocationId, 'active turn invocationId');
  nonEmpty(record.childTurnId, 'active turn invocation childTurnId');
  nonEmpty(record.checkpointReceiptRef, 'active turn invocation checkpointReceiptRef');
  if (record.binding.kind !== 'execution' && record.binding.kind !== 'review') {
    throw new JournalIntegrityError('active turn invocation binding kind is invalid');
  }
  if (record.adoptedResultSeq !== undefined) {
    positiveInteger(record.adoptedResultSeq, 'active turn invocation adoptedResultSeq');
  }
  if (record.postReviewCheckpointRef !== undefined) {
    nonEmpty(record.postReviewCheckpointRef, 'active turn invocation postReviewCheckpointRef');
    if (record.binding.kind !== 'review') {
      throw new JournalIntegrityError('active turn post-review checkpoint requires a review invocation');
    }
  }
}

function validateAcceptedRaw(entry: AcceptedRawFact): void {
  try {
    validateAcceptedRawFact(entry);
  } catch (error) {
    throw new JournalIntegrityError(error instanceof Error ? error.message : 'accepted raw fact is invalid', { cause: error });
  }
}

function validateAcceptedDelivery(entry: AcceptedChildDelivery): void {
  try {
    validateAcceptedChildDelivery(entry);
  } catch (error) {
    throw new JournalIntegrityError(error instanceof Error ? error.message : 'accepted child delivery is invalid', { cause: error });
  }
}

function validateRecordIdentity(
  commitId: string,
  typed: ActiveTurnJournalRecord,
  admittedTurnId: string,
  binding: ActiveTurnBinding,
): ValidatedRecord {
  if (typed.kind === 'binding-opened') {
    return { record: typed, turnId: admittedTurnId, scope: bindingOfRecord(typed, admittedTurnId).scope };
  }
  if (typed.kind === 'initial-input') {
    validateRawAssetContent(typed.content, 'active turn initial input');
    const turnId = turnIdFromCommitId(commitId, 'initial-input', admittedTurnId);
    assertTurnScope(typed.content.ref.scope, binding, 'active turn initial input');
    return { record: typed, turnId, scope: binding.scope };
  }
  if (typed.kind === 'request') {
    validateRequestRecord(typed.record);
    const turnId = turnIdFromCommitId(commitId, `request:${typed.record.request.requestId}:${typed.record.phase}`, admittedTurnId);
    assertTurnScope(typed.record.scope, binding, 'active turn request');
    return { record: typed, turnId, scope: binding.scope };
  }
  if (typed.kind === 'accepted-fact') {
    validateAcceptedRaw(typed.entry);
    const turnId = turnIdFromCommitId(commitId, `fact:${typed.entry.envelope.request.requestId}:${typed.entry.envelope.producerSeq}`, admittedTurnId);
    assertTurnScope(typed.entry.envelope.scope, binding, 'active turn accepted fact');
    if (typed.entry.envelope.execution.runtimeId !== binding.execution.runtimeId
      || typed.entry.envelope.execution.executionEpoch !== binding.execution.executionEpoch) {
      throw new JournalIntegrityError('active turn accepted fact execution does not match its binding');
    }
    return { record: typed, turnId, scope: binding.scope };
  }
  if (typed.kind === 'child-invocation') {
    validateInvocationRecord(typed.record);
    const turnId = turnIdFromCommitId(commitId, `invocation:${typed.record.invocationId}`, admittedTurnId);
    return { record: typed, turnId, scope: binding.scope };
  }
  validateAcceptedDelivery(typed.entry);
  const turnId = turnIdFromCommitId(commitId, `delivery:${typed.entry.invocationId}`, admittedTurnId);
  return { record: typed, turnId, scope: binding.scope };
}

function validateRecords(
  records: readonly JournalRecord[],
  admittedTurnId: string,
  binding: ActiveTurnBinding,
): ActiveTurnJournalRecord[] {
  const owned: ActiveTurnJournalRecord[] = [];
  for (const record of records) {
    if (!isActiveTurnCarrier(record) || !isBoundTurnCarrier(record, admittedTurnId)) continue;
    const typed = payloadOf(record);
    assertOwnedKind(typed.kind);
    const validated = validateRecordIdentity(record.commitId, typed, admittedTurnId, binding);
    owned.push(validated.record);
  }
  return owned;
}

/**
 * The bound turn's binding is the only one this port needs. Other turns'
 * bindings belong to their own ports, so they are left untouched here.
 */
function bindingOf(records: readonly JournalRecord[], admittedTurnId: string): ActiveTurnBinding {
  const expectedCommitId = activeTurnCommitId(admittedTurnId, 'binding-opened');
  let found: ActiveTurnBinding | undefined;
  for (const record of records) {
    if (!isActiveTurnCarrier(record)) continue;
    if (record.commitId !== expectedCommitId) continue;
    const typed = payloadOf(record);
    if (typed.kind !== 'binding-opened') throw new JournalIntegrityError('active turn binding commit id does not match its record');
    if (found) throw new JournalIntegrityError(`duplicate active turn binding: ${admittedTurnId}`);
    found = bindingOfRecord(typed, admittedTurnId);
  }
  if (!found) throw new JournalIntegrityError(`active turn binding is not committed: ${admittedTurnId}`);
  return found;
}

export interface JsonlActiveTurnJournalOptions {
  readonly filePath: string;
  readonly turnId: string;
}

/**
 * One instance per admitted turn over the shared Organ Journal. `turnId` is
 * required because two independent turns may share one journal file, and a
 * file-wide replay would hand one turn the initial input or raw facts of
 * another. There is deliberately no latest or default turn fallback.
 */
export class JsonlActiveTurnJournal implements ActiveTurnJournalPort {
  private readonly journal: JsonlOrganJournal;
  private readonly turnId: string;

  constructor(input: JsonlActiveTurnJournalOptions) {
    if (!input.filePath.trim()) throw new JournalIntegrityError('active turn journal path is required');
    this.turnId = nonEmpty(input.turnId, 'active turn journal turnId');
    this.journal = new JsonlOrganJournal(input.filePath);
  }

  async append(input: ActiveTurnJournalAppendRequest): Promise<void> {
    if (!input.commitId.trim()) throw new JournalIntegrityError('active turn append commit id is required');
    const record = input.record;
    assertOwnedKind(record.kind);
    if (input.commitId !== activeTurnCommitId(this.turnId, discriminatorOf(record))) {
      throw new JournalIntegrityError(`active turn append does not carry the commit id of turn ${this.turnId}`);
    }
    const records = await this.journal.replay();
    const binding = record.kind === 'binding-opened'
      ? bindingOfRecord(record, this.turnId)
      : bindingOf(records, this.turnId);
    const validated = validateRecordIdentity(input.commitId, record, this.turnId, binding);
    const payload: ActiveTurnJournalPayload = { type: ACTIVE_TURN_PAYLOAD_TYPE, record };
    await this.journal.append({
      commitId: input.commitId,
      kind: 'event',
      scope: validated.scope,
      payload,
    });
  }

  async replay(): Promise<readonly ActiveTurnJournalRecord[]> {
    const records = await this.journal.replay();
    return validateRecords(records, this.turnId, bindingOf(records, this.turnId));
  }
}

export function createJsonlActiveTurnJournal(input: JsonlActiveTurnJournalOptions): ActiveTurnJournalPort {
  return new JsonlActiveTurnJournal(input);
}
