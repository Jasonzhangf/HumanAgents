import {
  assertSameScope,
  canonicalJsonStringify,
  validateAcceptedChildDelivery,
  validateAcceptedRawFact,
  scopeContains,
  validateTaskIdentityScope,
} from '../../../contracts/src/index.js';
import type {
  AcceptedChildDelivery,
  AcceptedRawFact,
  ActiveTurnBinding,
  ChildInvocationRecord,
  RawAsset,
  RuntimeRequestRecord,
  ScopeRef,
  TaskIdentityScope,
} from '../../../contracts/src/index.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import {
  activeTurnSegmentCommitId,
  validateResumedTurnSegmentOpened,
  type ActiveTurnInitialOpenAnchor,
  type ActiveTurnSegmentInterruptedAnchor,
  type ActiveTurnSegmentBinding,
  type ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import {
  activeTurnCommitId,
  type ActiveTurnJournalAppendRequest,
  type ActiveTurnJournalPort,
  type ActiveTurnJournalRecord,
  type ActiveTurnSegmentJournalRecord,
  type ActiveTurnSegmentRecordAppendRequest,
} from '../../../runtime/src/context/active-turn-journal.js';
import { JournalCommitConflictError, JournalIntegrityError, JsonlOrganJournal, type JournalRecord } from './index.js';
import { readTaskBusinessRegistration } from './task-grants.js';

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
const ACTIVE_TURN_BINDING_DISCRIMINATOR = 'binding-opened';
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

function assertTurnScope(scope: ScopeRef, binding: { readonly scope: ScopeRef }, label: string): void {
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

/** The turn a binding-opened commit id names, or null when it names nothing. */
function bindingOpenedTurnId(commitId: string): string | null {
  const suffix = `:${ACTIVE_TURN_BINDING_DISCRIMINATOR}`;
  if (!commitId.startsWith(ACTIVE_TURN_COMMIT_PREFIX) || !commitId.endsWith(suffix)) return null;
  const turnId = commitId.slice(ACTIVE_TURN_COMMIT_PREFIX.length, commitId.length - suffix.length);
  return turnId === '' ? null : turnId;
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
  if (record.notSelectedResultSeq !== undefined) {
    positiveInteger(record.notSelectedResultSeq, 'active turn invocation notSelectedResultSeq');
  }
  if (record.adoptedResultSeq !== undefined && record.notSelectedResultSeq !== undefined) {
    throw new JournalIntegrityError('active turn invocation cannot both adopt and not select its delivery');
  }
  if (record.postReviewCheckpointRef !== undefined) {
    nonEmpty(record.postReviewCheckpointRef, 'active turn invocation postReviewCheckpointRef');
    if (record.binding.kind !== 'review') {
      throw new JournalIntegrityError('active turn post-review checkpoint requires a review invocation');
    }
    if (record.postReviewCheckpointRef === record.checkpointReceiptRef) {
      throw new JournalIntegrityError('active turn post-review checkpoint must differ from the pre-call checkpoint');
    }
  }
}

/**
 * One child-invocation snapshot names its transition through the typed decision
 * fields it carries, never through a single field-presence precedence. A
 * selection snapshot may retain the already committed post-review association,
 * and a review-checkpoint snapshot may still carry no selection, so the exact
 * permitted commit id is a bounded set. The commit id itself is validated
 * against that set instead of inferring the transition from key text.
 */
type InvocationTransition = 'invocation' | 'adopted' | 'not-selected' | 'review-checkpoint';

function permittedInvocationTransitions(
  record: ChildInvocationRecord,
): readonly { readonly transition: InvocationTransition; readonly discriminator: string }[] {
  const adopted = record.adoptedResultSeq !== undefined;
  const notSelected = record.notSelectedResultSeq !== undefined;
  const permitted: { transition: InvocationTransition; discriminator: string }[] = [];
  if (adopted && !notSelected) permitted.push({ transition: 'adopted', discriminator: `adopted:${record.invocationId}` });
  if (notSelected && !adopted) permitted.push({ transition: 'not-selected', discriminator: `not-selected:${record.invocationId}` });
  if (record.postReviewCheckpointRef !== undefined) {
    permitted.push({ transition: 'review-checkpoint', discriminator: `review-checkpoint:${record.invocationId}` });
  }
  if (!adopted && !notSelected && record.postReviewCheckpointRef === undefined) {
    permitted.push({ transition: 'invocation', discriminator: `invocation:${record.invocationId}` });
  }
  return permitted;
}

/**
 * Fold of the child facts retained before one child-invocation snapshot. The
 * latest snapshot per invocation carries every committed decision; the delivery
 * map carries each invocation's exact durable return.
 */
interface ChildInvocationFold {
  readonly latest: Map<string, ChildInvocationRecord>;
  readonly deliveries: Map<string, AcceptedChildDelivery>;
}

function emptyChildInvocationFold(): ChildInvocationFold {
  return { latest: new Map(), deliveries: new Map() };
}

/**
 * Validate one child-invocation snapshot against its exact permitted transition
 * identity and the retained preceding facts. The commit id must name one of the
 * transitions the typed decision fields permit. The snapshot must keep its
 * opening binding and every committed decision, and adoption, non-selection and
 * the post-review association each require their matching durable return.
 */
function validateChildInvocationTransition(
  commitId: string,
  record: ChildInvocationRecord,
  commitIdFor: (discriminator: string) => string,
  fold: ChildInvocationFold,
): void {
  validateInvocationRecord(record);
  const matched = permittedInvocationTransitions(record)
    .find((candidate) => commitIdFor(candidate.discriminator) === commitId);
  if (matched === undefined) {
    throw new JournalIntegrityError('active turn child invocation commit id does not match its decision');
  }
  const { transition } = matched;
  const prior = fold.latest.get(record.invocationId);
  if (transition === 'invocation') {
    if (prior !== undefined) {
      // The same-key exact retry reuses the committed opening snapshot.
      if (canonicalJsonStringify(prior) === canonicalJsonStringify(record)) return;
      throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} is already opened`);
    }
    fold.latest.set(record.invocationId, record);
    return;
  }
  if (prior === undefined) {
    throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} transition requires its opening record`);
  }
  if (canonicalJsonStringify(prior.binding) !== canonicalJsonStringify(record.binding)) {
    throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} cannot change its binding`);
  }
  if (prior.adoptedResultSeq !== undefined && record.adoptedResultSeq !== prior.adoptedResultSeq) {
    throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} cannot change its adopted decision`);
  }
  if (prior.notSelectedResultSeq !== undefined && record.notSelectedResultSeq !== prior.notSelectedResultSeq) {
    throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} cannot change its non-selection decision`);
  }
  if (prior.postReviewCheckpointRef !== undefined && record.postReviewCheckpointRef !== prior.postReviewCheckpointRef) {
    throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} cannot change its post-review association`);
  }
  const delivery = fold.deliveries.get(record.invocationId);
  if (transition === 'adopted') {
    if (prior.notSelectedResultSeq !== undefined) {
      throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} cannot adopt after a non-selection`);
    }
    if (delivery === undefined || delivery.seq !== record.adoptedResultSeq) {
      throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} adoption requires its retained delivery`);
    }
  }
  if (transition === 'not-selected') {
    if (prior.adoptedResultSeq !== undefined) {
      throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} cannot not-select after an adoption`);
    }
    if (delivery === undefined || delivery.seq !== record.notSelectedResultSeq) {
      throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} non-selection requires its retained delivery`);
    }
  }
  if (transition === 'review-checkpoint' && (delivery === undefined || delivery.kind !== 'review')) {
    throw new JournalIntegrityError(`active turn child invocation ${record.invocationId} post-review checkpoint requires its retained review return`);
  }
  fold.latest.set(record.invocationId, record);
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
  fold: ChildInvocationFold,
): ValidatedRecord {
  if (typed.kind === 'binding-opened') {
    turnIdFromCommitId(commitId, 'binding-opened', admittedTurnId);
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
    validateChildInvocationTransition(
      commitId,
      typed.record,
      (discriminator) => activeTurnCommitId(admittedTurnId, discriminator),
      fold,
    );
    return { record: typed, turnId: admittedTurnId, scope: binding.scope };
  }
  validateAcceptedDelivery(typed.entry);
  fold.deliveries.set(typed.entry.invocationId, typed.entry);
  const turnId = turnIdFromCommitId(commitId, `delivery:${typed.entry.invocationId}`, admittedTurnId);
  return { record: typed, turnId, scope: binding.scope };
}

interface ValidatedRecords {
  readonly records: ActiveTurnJournalRecord[];
  /** Child facts retained after the last validated record, for the next append. */
  readonly fold: ChildInvocationFold;
}

function validateRecords(
  records: readonly JournalRecord[],
  admittedTurnId: string,
  binding: ActiveTurnBinding,
): ValidatedRecords {
  const owned: ActiveTurnJournalRecord[] = [];
  const fold = emptyChildInvocationFold();
  for (const record of records) {
    if (!isActiveTurnCarrier(record) || !isBoundTurnCarrier(record, admittedTurnId)) continue;
    const typed = payloadOf(record);
    assertOwnedKind(typed.kind);
    const validated = validateRecordIdentity(record.commitId, typed, admittedTurnId, binding, fold);
    owned.push(validated.record);
  }
  return { records: owned, fold };
}

/**
 * The bound turn's binding is the only one this port needs. Other turns'
 * bindings belong to their own ports, so they are left untouched here.
 */
function bindingOf(records: readonly JournalRecord[], admittedTurnId: string): ActiveTurnBinding {
  const expectedCommitId = activeTurnCommitId(admittedTurnId, ACTIVE_TURN_BINDING_DISCRIMINATOR);
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

/** The physical receipt of one committed binding-opened record. */
function taskBindingCommitRef(record: ActiveTurnCarrierRecord): JournalCommitRef {
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

export interface JsonlActiveTurnJournalOptions {
  readonly filePath?: string;
  /** Actual shared Organ Journal object; preferred over a second path handle. */
  readonly journal?: JsonlOrganJournal;
  readonly turnId: string;
}

/**
 * Pure decoder over supplied, already-verified records for one admitted turn.
 * It selects only its own payload kind, derives the binding from the committed
 * record, and never locks, replays or awaits a producer.
 */
export function decodeActiveTurnRecords(
  records: readonly JournalRecord[],
  admittedTurnId: string,
): readonly ActiveTurnJournalRecord[] {
  return validateRecords(records, admittedTurnId, bindingOf(records, admittedTurnId)).records;
}

export type TaskActiveTurnBindingEntry = {
  readonly binding: ActiveTurnBinding;
  readonly commitRef: JournalCommitRef;
};

/**
 * Task-scoped enumeration over the same verified Organ Journal. It reads the
 * codec's own committed binding-opened carriers without naming one turn, and
 * it never appends or prepares a capture.
 */
export async function listTaskActiveTurnBindings(input: {
  readonly journal: Pick<JsonlOrganJournal, 'replay'>;
  readonly scope: TaskIdentityScope;
}): Promise<readonly TaskActiveTurnBindingEntry[]> {
  validateTaskIdentityScope(input.scope);
  const committed = await input.journal.replay();
  const bindings: TaskActiveTurnBindingEntry[] = [];
  for (const record of committed) {
    if (!isActiveTurnCarrier(record)) continue;
    const typed = payloadOf(record);
    if (typed.kind !== 'binding-opened') continue;
    const turnId = bindingOpenedTurnId(record.commitId);
    if (turnId === null) {
      throw new JournalIntegrityError('active turn binding commit id does not match its record');
    }
    const binding = bindingOfRecord(typed, turnId);
    if (!scopeContains(input.scope, binding.scope)) continue;
    bindings.push({ binding, commitRef: taskBindingCommitRef(record) });
  }
  return bindings;
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
    this.turnId = nonEmpty(input.turnId, 'active turn journal turnId');
    if (input.journal !== undefined) {
      this.journal = input.journal;
    } else {
      if (input.filePath === undefined || !input.filePath.trim()) {
        throw new JournalIntegrityError('active turn journal requires a path or shared journal');
      }
      this.journal = new JsonlOrganJournal(input.filePath);
    }
  }

  async append(input: ActiveTurnJournalAppendRequest): Promise<void> {
    if (!input.commitId.trim()) throw new JournalIntegrityError('active turn append commit id is required');
    const record = input.record;
    assertOwnedKind(record.kind);
    const records = await this.journal.replay();
    const binding = record.kind === 'binding-opened'
      ? bindingOfRecord(record, this.turnId)
      : bindingOf(records, this.turnId);
    const { fold } = validateRecords(records, this.turnId, binding);
    const validated = validateRecordIdentity(input.commitId, record, this.turnId, binding, fold);
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
    return validateRecords(records, this.turnId, bindingOf(records, this.turnId)).records;
  }

  /**
   * Task-scoped enumeration over the same verified Organ Journal. It reads the
   * codec's own committed binding-opened carriers without limiting this port
   * instance to one turn, and it never appends or prepares a capture.
   */
  listTaskBindings(scope: TaskIdentityScope): Promise<readonly TaskActiveTurnBindingEntry[]> {
    return listTaskActiveTurnBindings({ journal: this.journal, scope });
  }
}

export function createJsonlActiveTurnJournal(input: JsonlActiveTurnJournalOptions): ActiveTurnJournalPort {
  return new JsonlActiveTurnJournal(input);
}

/**
 * Segment-scoped codec over the same authoritative Organ Journal. A resumed
 * segment reuses the existing active-turn record kinds; the `segment-opened`
 * envelope carries the new execution ownership. It decodes only its own tagged
 * records and leaves every other record kind to its owner. There is no second
 * store, no second `initial-input` and no fabricated `binding-opened`.
 */
const ACTIVE_TURN_SEGMENT_PAYLOAD_TYPE = 'active-turn.segment-record';
const ACTIVE_TURN_SEGMENT_COMMIT_PREFIX = 'active-turn-segment:';

type ActiveTurnSegmentPayload = {
  readonly type: typeof ACTIVE_TURN_SEGMENT_PAYLOAD_TYPE;
  readonly record: ResumedTurnSegmentOpened | ActiveTurnSegmentJournalRecord;
};

function journalCommitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined || record.recordDigest === undefined) {
    throw new JournalIntegrityError('active turn segment journal record is not committed');
  }
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function isSegmentCarrier(record: JournalRecord): record is JournalRecord & {
  readonly kind: 'event';
  readonly commitId: string;
  readonly payload: Record<string, unknown>;
} {
  return record.kind === 'event'
    && record.payload?.type === ACTIVE_TURN_SEGMENT_PAYLOAD_TYPE
    && typeof record.commitId === 'string'
    && record.commitId.startsWith(ACTIVE_TURN_SEGMENT_COMMIT_PREFIX);
}

function segmentPayloadOf(record: JournalRecord): ResumedTurnSegmentOpened | ActiveTurnSegmentJournalRecord {
  if (!isSegmentCarrier(record)) {
    throw new JournalIntegrityError('active turn segment journal record has no segment payload');
  }
  const payload = record.payload as unknown as ActiveTurnSegmentPayload;
  const typed = payload.record;
  if (typed === null || typeof typed !== 'object' || Array.isArray(typed)) {
    throw new JournalIntegrityError('active turn segment journal record has no typed payload');
  }
  return typed;
}

function decodeSegmentOpened(record: JournalRecord): ResumedTurnSegmentOpened {
  const typed = segmentPayloadOf(record);
  if (typed.kind !== 'segment-opened') {
    throw new JournalIntegrityError('active turn segment-opened record is not a segment-opened payload');
  }
  validateResumedTurnSegmentOpened(typed);
  return typed;
}

function segmentIdFromCommitId(commitId: string, discriminator: string, segmentId: string): void {
  const suffix = `:${discriminator}`;
  if (!commitId.startsWith(ACTIVE_TURN_SEGMENT_COMMIT_PREFIX) || !commitId.endsWith(suffix)) {
    throw new JournalIntegrityError('active turn segment commit id does not match its record identity');
  }
  const encoded = commitId.slice(ACTIVE_TURN_SEGMENT_COMMIT_PREFIX.length, commitId.length - suffix.length);
  if (encoded === '') throw new JournalIntegrityError('active turn segment commit id does not carry a segment id');
  if (encoded !== segmentId) {
    throw new JournalIntegrityError(`active turn segment commit id does not belong to segment ${segmentId}`);
  }
}

function assertSegmentRecordKind(kind: string): asserts kind is ActiveTurnSegmentJournalRecord['kind'] {
  if (kind !== 'request' && kind !== 'accepted-fact' && kind !== 'child-invocation' && kind !== 'child-delivery') {
    throw new JournalIntegrityError(`active turn segment record kind is not owned by this codec: ${kind}`);
  }
}

/**
 * Validate one segment-scoped record against its opened segment binding. The
 * commit id carries the segment id, so a repeated request id or producer
 * sequence is legal across segments and a conflict is confined to one segment.
 */
function validateSegmentRecordIdentity(
  commitId: string,
  typed: ActiveTurnSegmentJournalRecord,
  segmentId: string,
  binding: ActiveTurnSegmentBinding,
  fold: ChildInvocationFold,
): ScopeRef {
  if (typed.kind === 'request') {
    validateRequestRecord(typed.record);
    segmentIdFromCommitId(commitId, `request:${typed.record.request.requestId}:${typed.record.phase}`, segmentId);
    assertTurnScope(typed.record.scope, binding, 'active turn segment request');
    return binding.scope;
  }
  if (typed.kind === 'accepted-fact') {
    validateAcceptedRaw(typed.entry);
    segmentIdFromCommitId(commitId, `fact:${typed.entry.envelope.request.requestId}:${typed.entry.envelope.producerSeq}`, segmentId);
    assertTurnScope(typed.entry.envelope.scope, binding, 'active turn segment accepted fact');
    if (typed.entry.envelope.execution.runtimeId !== binding.execution.runtimeId
      || typed.entry.envelope.execution.executionEpoch !== binding.execution.executionEpoch) {
      throw new JournalIntegrityError('active turn segment accepted fact execution does not match its segment binding');
    }
    return binding.scope;
  }
  if (typed.kind === 'child-invocation') {
    validateChildInvocationTransition(
      commitId,
      typed.record,
      (discriminator) => activeTurnSegmentCommitId(segmentId, discriminator),
      fold,
    );
    return binding.scope;
  }
  validateAcceptedDelivery(typed.entry);
  fold.deliveries.set(typed.entry.invocationId, typed.entry);
  segmentIdFromCommitId(commitId, `delivery:${typed.entry.invocationId}`, segmentId);
  return binding.scope;
}

/**
 * Validate every retained record of one segment in append order and return the
 * child fold left for the next append. The same shared transition and fold
 * rules as the v1 active turn apply; only the commit-id namespace differs.
 */
function validateSegmentRecordsInOrder(
  records: readonly JournalRecord[],
  segmentId: string,
  binding: ActiveTurnSegmentBinding,
): { readonly records: ActiveTurnSegmentJournalRecord[]; readonly fold: ChildInvocationFold } {
  const owned: ActiveTurnSegmentJournalRecord[] = [];
  const fold = emptyChildInvocationFold();
  for (const record of records) {
    if (!isSegmentCarrier(record) || record.commitId === undefined) continue;
    if (!record.commitId.startsWith(`${ACTIVE_TURN_SEGMENT_COMMIT_PREFIX}${segmentId}:`)) continue;
    const typed = segmentPayloadOf(record);
    if (typed.kind === 'segment-opened') continue;
    assertSegmentRecordKind(typed.kind);
    validateSegmentRecordIdentity(record.commitId, typed, segmentId, binding, fold);
    owned.push(typed);
  }
  return { records: owned, fold };
}

function bindingCommitRefOf(records: readonly JournalRecord[], businessTurnId: string): JournalCommitRef {
  const expected = activeTurnCommitId(businessTurnId, 'binding-opened');
  const record = records.find((candidate) => candidate.commitId === expected);
  if (record === undefined) {
    throw new JournalIntegrityError(`active turn binding is not committed: ${businessTurnId}`);
  }
  bindingOfRecord(payloadOf(record), businessTurnId);
  return journalCommitRef(record);
}

function decodeSegmentChain(records: readonly JournalRecord[], businessTurnId: string): ResumedTurnSegmentOpened[] {
  const opened: ResumedTurnSegmentOpened[] = [];
  for (const record of records) {
    if (!isSegmentCarrier(record)) continue;
    const typed = segmentPayloadOf(record);
    if (typed.kind !== 'segment-opened') continue;
    const validated = decodeSegmentOpened(record);
    if (validated.businessTurnRef.businessTurnId === businessTurnId) opened.push(validated);
  }
  return opened;
}

function findSegmentOpened(
  records: readonly JournalRecord[],
  businessTurnId: string,
  segmentId: string,
): ResumedTurnSegmentOpened | null {
  for (const record of records) {
    if (!isSegmentCarrier(record)) continue;
    const typed = segmentPayloadOf(record);
    if (typed.kind !== 'segment-opened') continue;
    if (typed.segmentId !== segmentId) continue;
    const validated = decodeSegmentOpened(record);
    if (validated.businessTurnRef.businessTurnId !== businessTurnId) continue;
    return validated;
  }
  return null;
}

function assertPredecessorReceiptRef(records: readonly JournalRecord[], receiptRef: string): void {
  if (!records.some((record) => record.commitId === receiptRef)) {
    throw new JournalIntegrityError(`segment predecessor recovery receipt is not committed: ${receiptRef}`);
  }
}

/**
 * The durable anchor of an original turn that opened in v1: the real
 * `binding-opened` commit and the last committed `active-turn:<businessTurnId>:*`
 * record (the binding commit itself when it committed nothing else). It returns
 * null when no binding-opened record exists, so a caller never invents an anchor
 * for an unopened turn. It carries no capture and claims no save.
 */
function initialOpenAnchorOf(
  records: readonly JournalRecord[],
  businessTurnId: string,
): ActiveTurnInitialOpenAnchor | null {
  const bindingCommitId = activeTurnCommitId(businessTurnId, ACTIVE_TURN_BINDING_DISCRIMINATOR);
  const bindingRecord = records.find((candidate) => candidate.commitId === bindingCommitId);
  if (bindingRecord === undefined) return null;
  const bindingPayload = payloadOf(bindingRecord);
  if (bindingPayload.kind !== 'binding-opened') {
    throw new JournalIntegrityError('active turn binding commit id does not match its record');
  }
  bindingOfRecord(bindingPayload, businessTurnId);
  const owned = records.filter((record) => isActiveTurnCarrier(record) && isBoundTurnCarrier(record, businessTurnId));
  if (owned.length === 0) {
    throw new JournalIntegrityError(`active turn binding is not committed: ${businessTurnId}`);
  }
  const last = owned[owned.length - 1]!;
  return { bindingCommitRef: journalCommitRef(bindingRecord), recordsThroughCommitRef: journalCommitRef(last) };
}

function sameCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

/**
 * The durable anchor of one committed segment: its real `segment-opened` commit
 * and the last committed record in that segment's commit-id namespace. It
 * returns null when no matching opened record exists, so a caller never invents
 * an anchor for an unopened segment. It carries no capture and claims no save.
 */
function segmentAnchorOf(
  records: readonly JournalRecord[],
  businessTurnId: string,
  segmentId: string,
): ActiveTurnSegmentInterruptedAnchor | null {
  const openedCommitId = activeTurnSegmentCommitId(segmentId, 'segment-opened');
  const openedRecord = records.find((record) => record.commitId === openedCommitId);
  if (openedRecord === undefined) return null;
  const opened = decodeSegmentOpened(openedRecord);
  if (opened.businessTurnRef.businessTurnId !== businessTurnId) return null;
  const prefix = `${ACTIVE_TURN_SEGMENT_COMMIT_PREFIX}${segmentId}:`;
  const owned = records.filter((record) => isSegmentCarrier(record) && record.commitId.startsWith(prefix));
  const last = owned[owned.length - 1] ?? openedRecord;
  return {
    openedCommitRef: journalCommitRef(openedRecord),
    recordsThroughCommitRef: journalCommitRef(last),
  };
}

export interface JsonlActiveTurnSegmentJournalOptions {
  readonly filePath?: string;
  /** Actual shared Organ Journal object; preferred over a second path handle. */
  readonly journal?: JsonlOrganJournal;
  readonly businessTurnId: string;
  /**
   * Optional held-transaction check that the predecessor's recovery receipt
   * belongs to that exact predecessor. The App supplies it so the recovery-asset
   * codec stays with its owner; it runs inside the Journal lock and only reads
   * the local records.
   */
  readonly verifyPredecessorReceipt?: (
    records: readonly JournalRecord[],
    predecessor: ResumedTurnSegmentOpened['predecessor'],
  ) => void;
}

/**
 * Segment journal bound to one business turn. It reads the committed segment
 * chain, appends one `segment-opened` envelope, and reads/appends the segment's
 * content records over the shared Organ Journal. The exact v1 capture and the
 * immutable v2 capture asset stay with the App assembly.
 */
export class JsonlActiveTurnSegmentJournal {
  private readonly journal: JsonlOrganJournal;
  private readonly businessTurnId: string;
  private readonly verifyPredecessorReceipt?: JsonlActiveTurnSegmentJournalOptions['verifyPredecessorReceipt'];

  constructor(input: JsonlActiveTurnSegmentJournalOptions) {
    this.businessTurnId = nonEmpty(input.businessTurnId, 'active turn segment journal businessTurnId');
    if (input.journal !== undefined) {
      this.journal = input.journal;
    } else {
      if (input.filePath === undefined || !input.filePath.trim()) {
        throw new JournalIntegrityError('active turn segment journal requires a path or shared journal');
      }
      this.journal = new JsonlOrganJournal(input.filePath);
    }
    this.verifyPredecessorReceipt = input.verifyPredecessorReceipt;
  }

  private assertBoundBusinessTurn(businessTurnId: string): void {
    if (businessTurnId !== this.businessTurnId) {
      throw new JournalIntegrityError(`active turn segment journal is bound to business turn ${this.businessTurnId}`);
    }
  }

  async readInitialBindingCommit(): Promise<JournalCommitRef> {
    return bindingCommitRefOf(await this.journal.replay(), this.businessTurnId);
  }

  async readSegments(businessTurnId: string): Promise<readonly ResumedTurnSegmentOpened[]> {
    this.assertBoundBusinessTurn(businessTurnId);
    return decodeSegmentChain(await this.journal.replay(), this.businessTurnId);
  }

  async readSegmentOpened(segmentId: string): Promise<ResumedTurnSegmentOpened | null> {
    return findSegmentOpened(await this.journal.replay(), this.businessTurnId, nonEmpty(segmentId, 'segmentId'));
  }

  /**
   * The durable anchor of the original turn when it opened in v1 but never
   * committed a v1 capture, or null when no binding-opened record exists for the
   * bound business turn.
   */
  async readInitialOpenAnchor(): Promise<ActiveTurnInitialOpenAnchor | null> {
    return initialOpenAnchorOf(await this.journal.replay(), this.businessTurnId);
  }

  /**
   * The durable anchor of a committed segment of the bound business turn, or
   * null when no segment-opened record exists for that segment id.
   */
  async readSegmentAnchor(segmentId: string): Promise<ActiveTurnSegmentInterruptedAnchor | null> {
    return segmentAnchorOf(await this.journal.replay(), this.businessTurnId, nonEmpty(segmentId, 'segmentId'));
  }

  async appendSegmentOpened(input: {
    readonly commitId: string;
    readonly record: ResumedTurnSegmentOpened;
  }): Promise<JournalCommitRef> {
    const record = input.record;
    validateResumedTurnSegmentOpened(record);
    if (record.businessTurnRef.businessTurnId !== this.businessTurnId) {
      throw new JournalIntegrityError(`segment-opened record does not belong to business turn ${this.businessTurnId}`);
    }
    if (input.commitId !== activeTurnSegmentCommitId(record.segmentId, 'segment-opened')) {
      throw new JournalIntegrityError('segment-opened commit id does not match its segment identity');
    }
    return await this.journal.transaction(
      ({ records }) => {
        const existing = records.find((candidate) => candidate.commitId === input.commitId);
        if (existing !== undefined) {
          const stored = decodeSegmentOpened(existing);
          if (canonicalJsonStringify(stored) !== canonicalJsonStringify(record)) {
            throw new JournalCommitConflictError(input.commitId, existing);
          }
          return { kind: 'existing' as const, commit: journalCommitRef(existing) };
        }

        // Exact registration: the recorded business reservation commit must be
        // the durable TG1 registration for this exact segment-open work.
        const registration = readTaskBusinessRegistration({
          records,
          commitId: record.businessRegistrationCommitRef.commitId,
        });
        if (registration === null) {
          throw new JournalIntegrityError('segment-opened registration commit is not a durable business registration');
        }
        if (registration.commit.journalSeq !== record.businessRegistrationCommitRef.journalSeq
          || registration.commit.recordDigest !== record.businessRegistrationCommitRef.recordDigest) {
          throw new JournalIntegrityError('segment-opened registration commit does not match its durable record');
        }
        if (registration.registration.requestRef !== record.requestRef) {
          throw new JournalIntegrityError('segment-opened registration requestRef does not match the segment intent');
        }
        if (registration.registration.inputIdentity.requestRef !== record.inputIdentity.requestRef
          || registration.registration.inputIdentity.digest !== record.inputIdentity.digest) {
          throw new JournalIntegrityError('segment-opened registration input identity does not match the segment intent');
        }
        if (registration.registration.taskId.value !== record.binding.assignment.taskId.value) {
          throw new JournalIntegrityError('segment-opened registration task does not match the segment binding');
        }
        // The exact grant commit must be a committed record too.
        const authority = records.find((candidate) => candidate.commitId === record.authorityCommitRef.commitId);
        if (authority === undefined
          || authority.seq !== record.authorityCommitRef.journalSeq
          || authority.recordDigest !== record.authorityCommitRef.recordDigest) {
          throw new JournalIntegrityError('segment-opened authority commit is not a committed record');
        }

        // The original binding commit, business turn and scope must match.
        const bindingCommit = bindingCommitRefOf(records, this.businessTurnId);
        if (bindingCommit.commitId !== record.businessTurnRef.bindingCommitRef.commitId
          || bindingCommit.journalSeq !== record.businessTurnRef.bindingCommitRef.journalSeq
          || bindingCommit.recordDigest !== record.businessTurnRef.bindingCommitRef.recordDigest) {
          throw new JournalIntegrityError('segment-opened does not reference the committed original binding');
        }

        // The predecessor must be the current committed chain tail.
        if (record.predecessor.initialOpen !== undefined) {
          const chain = decodeSegmentChain(records, this.businessTurnId);
          // The initial-open predecessor must still be the unsaved original turn
          // with no resumed segment yet; the anchor is re-derived under the lock
          // and must equal the supplied anchor exactly. The App's held-transaction
          // verifyPredecessorReceipt re-checks that no v1 receipt exists.
          if (chain.length !== 0) {
            throw new JournalIntegrityError('segment-opened initial-open predecessor requires the unsaved original turn');
          }
          if (record.predecessor.segmentId !== this.businessTurnId) {
            throw new JournalIntegrityError('segment-opened initial-open predecessor must name the original business turn');
          }
          const anchor = initialOpenAnchorOf(records, this.businessTurnId);
          if (anchor === null) {
            throw new JournalIntegrityError('segment-opened initial-open predecessor is not a committed original turn');
          }
          if (anchor.bindingCommitRef.commitId !== record.predecessor.initialOpen.bindingCommitRef.commitId
            || anchor.bindingCommitRef.journalSeq !== record.predecessor.initialOpen.bindingCommitRef.journalSeq
            || anchor.bindingCommitRef.recordDigest !== record.predecessor.initialOpen.bindingCommitRef.recordDigest
            || anchor.recordsThroughCommitRef.commitId !== record.predecessor.initialOpen.recordsThroughCommitRef.commitId
            || anchor.recordsThroughCommitRef.journalSeq !== record.predecessor.initialOpen.recordsThroughCommitRef.journalSeq
            || anchor.recordsThroughCommitRef.recordDigest !== record.predecessor.initialOpen.recordsThroughCommitRef.recordDigest) {
            throw new JournalIntegrityError('segment-opened initial-open anchor does not match the committed initial turn facts');
          }
        } else if (record.predecessor.interrupted !== undefined) {
          const expectedPredecessor = decodeSegmentChain(records, this.businessTurnId).at(-1);
          if (expectedPredecessor === undefined || record.predecessor.segmentId !== expectedPredecessor.segmentId) {
            throw new JournalIntegrityError('segment-opened predecessor is not the current committed chain tail');
          }
          const anchor = segmentAnchorOf(records, this.businessTurnId, record.predecessor.segmentId);
          if (anchor === null) {
            throw new JournalIntegrityError('segment-opened interrupted predecessor is not a committed segment');
          }
          if (!sameCommitRef(anchor.openedCommitRef, record.predecessor.interrupted.openedCommitRef)
            || !sameCommitRef(anchor.recordsThroughCommitRef, record.predecessor.interrupted.recordsThroughCommitRef)) {
            throw new JournalIntegrityError('segment-opened interrupted anchor does not match the committed segment facts');
          }
        } else {
          const expectedPredecessor = decodeSegmentChain(records, this.businessTurnId).at(-1)?.segmentId ?? this.businessTurnId;
          if (record.predecessor.segmentId !== expectedPredecessor) {
            throw new JournalIntegrityError('segment-opened predecessor is not the current committed chain tail');
          }
          assertPredecessorReceiptRef(records, record.predecessor.recoveryAssetsReceiptRef);
        }
        this.verifyPredecessorReceipt?.(records, record.predecessor);
        return { kind: 'append' as const, scope: record.binding.scope, commitId: input.commitId };
      },
      async (plan, append) => {
        if (plan.kind === 'existing') return plan.commit;
        const journalRecord = await append({
          commitId: plan.commitId,
          kind: 'event',
          scope: plan.scope,
          payload: { type: ACTIVE_TURN_SEGMENT_PAYLOAD_TYPE, record } satisfies ActiveTurnSegmentPayload,
        });
        return journalCommitRef(journalRecord);
      },
    );
  }

  async appendSegmentRecord(input: ActiveTurnSegmentRecordAppendRequest): Promise<JournalCommitRef> {
    if (input.businessTurnId !== this.businessTurnId) {
      throw new JournalIntegrityError(`segment record does not belong to business turn ${this.businessTurnId}`);
    }
    assertSegmentRecordKind(input.record.kind);
    if (!input.commitId.startsWith(`${ACTIVE_TURN_SEGMENT_COMMIT_PREFIX}${input.segmentId}:`)) {
      throw new JournalIntegrityError('segment record commit id does not match its segment identity');
    }
    return await this.journal.transaction(
      ({ records }) => {
        const existing = records.find((candidate) => candidate.commitId === input.commitId);
        if (existing !== undefined) {
          const stored = segmentPayloadOf(existing);
          if (stored.kind === 'segment-opened' || canonicalJsonStringify(stored) !== canonicalJsonStringify(input.record)) {
            throw new JournalCommitConflictError(input.commitId, existing);
          }
          return { kind: 'existing' as const, commit: journalCommitRef(existing) };
        }
        const opened = findSegmentOpened(records, this.businessTurnId, input.segmentId);
        if (opened === null) {
          throw new JournalIntegrityError(`active turn segment is not opened: ${input.segmentId}`);
        }
        const { fold } = validateSegmentRecordsInOrder(records, input.segmentId, opened.binding);
        validateSegmentRecordIdentity(input.commitId, input.record, input.segmentId, opened.binding, fold);
        return { kind: 'append' as const, scope: opened.binding.scope, commitId: input.commitId };
      },
      async (plan, append) => {
        if (plan.kind === 'existing') return plan.commit;
        const journalRecord = await append({
          commitId: plan.commitId,
          kind: 'event',
          scope: plan.scope,
          payload: { type: ACTIVE_TURN_SEGMENT_PAYLOAD_TYPE, record: input.record } satisfies ActiveTurnSegmentPayload,
        });
        return journalCommitRef(journalRecord);
      },
    );
  }

  async readSegmentRecords(input: {
    readonly businessTurnId: string;
    readonly segmentId: string;
  }): Promise<readonly ActiveTurnSegmentJournalRecord[]> {
    this.assertBoundBusinessTurn(input.businessTurnId);
    const records = await this.journal.replay();
    const opened = findSegmentOpened(records, this.businessTurnId, input.segmentId);
    if (opened === null) {
      throw new JournalIntegrityError(`active turn segment is not opened: ${input.segmentId}`);
    }
    return validateSegmentRecordsInOrder(records, input.segmentId, opened.binding).records;
  }
}

export function createJsonlActiveTurnSegmentJournal(
  input: JsonlActiveTurnSegmentJournalOptions,
): JsonlActiveTurnSegmentJournal {
  return new JsonlActiveTurnSegmentJournal(input);
}
