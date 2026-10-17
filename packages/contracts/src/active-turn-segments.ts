import { ContractError } from './errors.js';
import type { CheckpointControlInputIdentity } from './checkpoint-controls.js';
import type { JournalCommitRef } from './i2-history.js';
import type { TaskRuntimeIncarnation } from './framework.js';
import type { CompletionReadInput } from './operation-completion.js';
import type { RecoveryHoldFacts } from './native-reasoning.js';
import type { AdmittedTurn, EvidenceRef, ScopeRef, WorkAssignment } from './index.js';
import { assertEvidenceRef, assertSameScope, assertScope, validateAdmittedTurn, validateWorkAssignment } from './index.js';
import {
  validateAcceptedChildDelivery,
  validateAcceptedRawFact,
  validateActiveTurnCaptureBody,
  validateChildInvocationReferences,
  type AcceptedRawFact,
  type AcceptedTurnEntry,
  type ActiveTurnBinding,
  type ActiveTurnCaptureBody,
  type ActiveTurnProviderExecutionIdentityRef,
  type ActiveTurnProviderRequestIdentityRef,
  type ChildInvocationRecord,
  type ProviderProducerDrainResult,
  type RawAsset,
  type RuntimeRequestRecord,
  type TurnCaptureCut,
} from './active-turn-context.js';
import { validateJournalCommitRef } from './i2-history.js';

/**
 * Same-business-turn execution segments. v1 `ActiveTurnCaptureBody` binds one
 * business admission to one execution epoch, and its validators reject
 * cross-epoch entries. A resumed epoch therefore appends a new immutable
 * segment record instead of rewriting the original binding or relabeling raw.
 *
 * This module defines the shared types, validators and commit discriminator
 * only. The physical commit, exact-turn decode and immutable recovery-asset
 * backing stay with the Journal (J1) owner; D owns no second store.
 */

/** Version of the appended segment record set. Distinct from capture body v1. */
export const ACTIVE_TURN_SEGMENT_SCHEMA_VERSION = 2;

/** Identity of one immutable execution segment within a single business turn. */
export interface ActiveTurnSegmentIdentity {
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly executionEpoch: number;
}

/**
 * The original immutable business admission a resumed segment continues. It
 * points at the original `binding-opened` commit and the original execution
 * identity; it never creates a new `AdmittedTurn`.
 */
export interface OriginalBusinessTurnRef {
  readonly businessTurnId: string;
  /** Commit receipt of the original `binding-opened` record. Never rewritten. */
  readonly bindingCommitRef: JournalCommitRef;
  /** Original execution identity; the first segment keeps this epoch. */
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
}

/**
 * Durable anchor of a predecessor segment that was opened and appended records
 * but never committed a v2 recovery-assets receipt. `openedCommitRef` is the real
 * `segment-opened` commit of that segment; `recordsThroughCommitRef` is its last
 * committed record, or the opened commit itself when it committed no record yet.
 * The anchor is a location, not a capture: it carries no pause, drain or freeze
 * fact, and it never claims the segment was saved.
 */
export interface ActiveTurnSegmentInterruptedAnchor {
  readonly openedCommitRef: JournalCommitRef;
  readonly recordsThroughCommitRef: JournalCommitRef;
}

/**
 * Durable anchor of an original turn that opened and appended records but never
 * committed a v1 capture. `bindingCommitRef` is the real `binding-opened` commit;
 * `recordsThroughCommitRef` is the last committed `active-turn:<businessTurnId>:*`
 * record. The anchor is a location, not a capture, and never claims a save.
 */
export interface ActiveTurnInitialOpenAnchor {
  readonly bindingCommitRef: JournalCommitRef;
  readonly recordsThroughCommitRef: JournalCommitRef;
}

/**
 * Exact predecessor link: the segment this one resumes, closed by exactly one
 * real fact. Field presence expresses the exclusive-or, so the captured branch
 * keeps its original byte shape and gains no discriminator. The runtime validator,
 * not the `never` fields, rejects a record that carries more than one fact or none.
 */
export type ActiveTurnSegmentPredecessorRef =
  | {
      readonly segmentId: string;
      /** Exact J1 recovery-assets receipt that closed the predecessor segment. */
      readonly recoveryAssetsReceiptRef: string;
      readonly interrupted?: never;
      readonly initialOpen?: never;
    }
  | {
      readonly segmentId: string;
      readonly recoveryAssetsReceiptRef?: never;
      /** Durable anchor of an opened but unsaved predecessor segment. */
      readonly interrupted: ActiveTurnSegmentInterruptedAnchor;
      readonly initialOpen?: never;
    }
  | {
      readonly segmentId: string;
      readonly recoveryAssetsReceiptRef?: never;
      readonly interrupted?: never;
      /** Durable anchor of the original turn that was never captured. */
      readonly initialOpen: ActiveTurnInitialOpenAnchor;
    };

/** Real binding of one execution segment. The incarnation is the actual handle. */
export interface ActiveTurnSegmentBinding {
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly assignment: WorkAssignment;
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly scope: ScopeRef;
}

/**
 * The complete typed segment-open intent. D-S builds it from the immutable
 * first capture and the committed chain after every read-only check, then hands
 * it to the current-authority admission. The admission registers this exact
 * work and derives the intent identity; the intent never carries a fabricated
 * grant or registration commit.
 */
export interface ActiveTurnSegmentOpenIntent {
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly segmentId: string;
  /** Real chain tail (or the derived initial segment) and its exact receipt. */
  readonly predecessor: ActiveTurnSegmentPredecessorRef;
  readonly binding: ActiveTurnSegmentBinding;
  /** The unique original input asset; never a second copy. */
  readonly initialInput: RawAsset;
}

/**
 * Exact read of one segment's recovery-assets receipt. A failed or unknown
 * receipt keeps the recovery obligation; the consumer never chooses the latest
 * state or replays an effect.
 */
export type ActiveTurnSegmentRecoveryReceiptRead =
  | { readonly status: 'exact'; readonly recoveryAssetsReceiptRef: string }
  | { readonly status: 'interrupted'; readonly anchor: ActiveTurnSegmentInterruptedAnchor }
  | { readonly status: 'initial-open'; readonly anchor: ActiveTurnInitialOpenAnchor }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'unknown'; readonly reason: string };

/** The appendable record that opens one resumed execution segment. */
export interface ResumedTurnSegmentOpened {
  readonly kind: 'segment-opened';
  readonly segmentId: string;
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly predecessor: ActiveTurnSegmentPredecessorRef;
  readonly binding: ActiveTurnSegmentBinding;
  /** Exact durable grant commit that admitted the work. */
  readonly authorityCommitRef: JournalCommitRef;
  /** Exact business reservation commit; a distinct fact from the grant commit. */
  readonly businessRegistrationCommitRef: JournalCommitRef;
  /** Stable identity of this segment-open work; binds business turn + segment. */
  readonly requestRef: string;
  /** Intent identity registered for this segment; its requestRef equals requestRef. */
  readonly inputIdentity: CheckpointControlInputIdentity;
}

/**
 * Narrow segment capture v2. It holds only the new epoch's entries, references
 * the unique original input asset and keeps the exact predecessor receipt link.
 * It never copies or relabels the old segment's raw.
 */
export interface ActiveTurnSegmentCaptureV2 {
  readonly version: typeof ACTIVE_TURN_SEGMENT_SCHEMA_VERSION;
  /** Locates this segment within the business turn; part of the commit identity. */
  readonly segmentId: string;
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly binding: ActiveTurnSegmentBinding;
  /** References the unique original input asset; never a second copy. */
  readonly initialInput: RawAsset;
  readonly entries: readonly AcceptedTurnEntry[];
  readonly requests: readonly RuntimeRequestRecord[];
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly cut: TurnCaptureCut;
  readonly predecessor: ActiveTurnSegmentPredecessorRef;
}

/**
 * Narrow prepared segment capture. It reuses the real control proof of the
 * prepared v1 capture (record count, producer drains, completion lookups,
 * recovery holds) for the current segment. It never copies completion results or
 * alignment facts.
 */
export interface PreparedActiveTurnSegmentCaptureV2 {
  readonly body: ActiveTurnSegmentCaptureV2;
  readonly controlRecordCount: number;
  readonly producerDrains: readonly ProviderProducerDrainResult[];
  readonly completionLookups: readonly CompletionReadInput[];
  readonly recovery: RecoveryHoldFacts;
}

/** Exact read of the immutable first (v1) capture plus its binding commit. */
export interface ActiveTurnInitialSegmentCapture {
  readonly bindingCommitRef: JournalCommitRef;
  readonly body: ActiveTurnCaptureBody;
}

/** Exact read of the immutable first (v1) capture, tagged for the source union. */
export interface ActiveTurnCapturedInitialSource extends ActiveTurnInitialSegmentCapture {
  readonly kind: 'captured';
}

/**
 * Root source for a turn that opened in v1 but never captured. The binding and
 * initial input come from the exact active-turn prefix; the anchor locates that
 * prefix in the Journal and is never a synthetic capture.
 */
export interface ActiveTurnInitialOpenSegmentSource {
  readonly kind: 'initial-open';
  readonly anchor: ActiveTurnInitialOpenAnchor;
  readonly binding: ActiveTurnBinding;
  readonly initialInput: RawAsset;
}

/** Explicit source of one business turn's initial segment. */
export type ActiveTurnInitialSegmentSource =
  | ActiveTurnCapturedInitialSource
  | ActiveTurnInitialOpenSegmentSource;

/**
 * Initial segment form carried by the ordered chain read. The captured branch
 * carries only the body because the chain's `businessTurnRef` already names the
 * binding commit. The initial-open branch carries its full source because no
 * v1 capture exists.
 */
export type ActiveTurnSegmentChainInitial =
  | { readonly kind: 'captured'; readonly body: ActiveTurnCaptureBody }
  | ActiveTurnInitialOpenSegmentSource;

/**
 * Canonical source bundle for one resumed-segment native save. It is a read
 * result assembled by the App/Journal owner, not a grant, permission or second
 * admission record. Native save and semantic history must import this same
 * type so neither owner duplicates the shared v2 source shape.
 */
export interface NativeSegmentSaveSourceV2 {
  readonly originalAdmittedTurn: AdmittedTurn;
  readonly originalBusinessTurnRef: OriginalBusinessTurnRef;
  readonly opened: ResumedTurnSegmentOpened;
  readonly openedCommitRef: JournalCommitRef;
}

/** Immutable cold read of one business turn's ordered segment chain. */
export interface ActiveTurnSegmentChainRead {
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly initial: ActiveTurnSegmentChainInitial;
  readonly segments: readonly ResumedTurnSegmentOpened[];
}

/**
 * Durable commit identity for one record inside a segment. The segment id is
 * part of the identity so different epochs cannot collide on request ids or
 * producer sequences that repeat across epochs.
 */
export function activeTurnSegmentCommitId(segmentId: string, discriminator: string): string {
  if (!segmentId.trim()) throw new ContractError('segment commit id requires a segment id');
  if (!discriminator.trim()) throw new ContractError('segment commit id requires a discriminator');
  return `active-turn-segment:${segmentId}:${discriminator}`;
}

/**
 * Derive the original business turn reference from the immutable v1 binding.
 * This is the identity source for the initial segment; it never writes a
 * second `binding-opened` record. The initial segment id is the original
 * business turn id, so the first resumed segment precede-links it directly.
 */
export function originalBusinessTurnRef(
  bindingCommitRef: JournalCommitRef,
  body: ActiveTurnCaptureBody,
): OriginalBusinessTurnRef {
  validateJournalCommitRef(bindingCommitRef);
  validateActiveTurnCaptureBody(body);
  return {
    businessTurnId: body.binding.admittedTurn.turnId,
    bindingCommitRef: { ...bindingCommitRef },
    execution: { ...body.binding.execution },
  };
}

/**
 * Derive the original business turn reference from an exact v1 binding read.
 * The binding commit is the real `binding-opened` receipt; this function never
 * writes a second admission or capture.
 */
export function originalBusinessTurnRefFromBinding(
  bindingCommitRef: JournalCommitRef,
  binding: ActiveTurnBinding,
): OriginalBusinessTurnRef {
  validateJournalCommitRef(bindingCommitRef);
  assertActiveTurnBinding(binding, 'original business turn binding');
  return {
    businessTurnId: binding.admittedTurn.turnId,
    bindingCommitRef: { ...bindingCommitRef },
    execution: { ...binding.execution },
  };
}

export function validateActiveTurnSegmentIdentity(input: unknown): asserts input is ActiveTurnSegmentIdentity {
  assertPlainObject(input, 'segment identity');
  assertNonEmptyString(input.businessTurnId, 'segment identity businessTurnId');
  assertNonEmptyString(input.segmentId, 'segment identity segmentId');
  assertPositiveSafeInteger(input.executionEpoch, 'segment identity executionEpoch');
}

export function validateActiveTurnInitialOpenAnchor(input: unknown): asserts input is ActiveTurnInitialOpenAnchor {
  assertPlainObject(input, 'initial-open anchor');
  validateJournalCommitRef(input.bindingCommitRef as JournalCommitRef);
  validateJournalCommitRef(input.recordsThroughCommitRef as JournalCommitRef);
  const bindingCommitRef = input.bindingCommitRef as JournalCommitRef;
  const recordsThroughCommitRef = input.recordsThroughCommitRef as JournalCommitRef;
  if (recordsThroughCommitRef.journalSeq < bindingCommitRef.journalSeq) {
    throw new ContractError('initial-open anchor recordsThroughCommitRef cannot precede its bindingCommitRef');
  }
}

export function validateActiveTurnSegmentInterruptedAnchor(input: unknown): asserts input is ActiveTurnSegmentInterruptedAnchor {
  assertPlainObject(input, 'segment interrupted anchor');
  validateJournalCommitRef(input.openedCommitRef as JournalCommitRef);
  validateJournalCommitRef(input.recordsThroughCommitRef as JournalCommitRef);
  const openedCommitRef = input.openedCommitRef as JournalCommitRef;
  const recordsThroughCommitRef = input.recordsThroughCommitRef as JournalCommitRef;
  if (recordsThroughCommitRef.journalSeq < openedCommitRef.journalSeq) {
    throw new ContractError('segment interrupted anchor recordsThroughCommitRef cannot precede its openedCommitRef');
  }
}

/**
 * Enforce the exclusive-or predecessor link. The captured branch carries the exact
 * J1 recovery-assets receipt that closed the predecessor; the interrupted branch
 * carries the durable anchor of an opened but unsaved v2 segment; the initial-open
 * branch carries the durable anchor of an original turn with no capture. Field
 * presence is the only discriminator, so a record holding more than one fact or
 * none is rejected here rather than resolved downstream. Commit refs use the
 * existing Journal validator. This never reinterprets the initial binding.
 */
export function validateActiveTurnSegmentPredecessorRef(input: unknown): asserts input is ActiveTurnSegmentPredecessorRef {
  assertPlainObject(input, 'segment predecessor');
  assertNonEmptyString(input.segmentId, 'segment predecessor segmentId');
  const hasReceipt = input.recoveryAssetsReceiptRef !== undefined;
  const hasInterrupted = input.interrupted !== undefined;
  const hasInitialOpen = input.initialOpen !== undefined;
  if ((hasReceipt ? 1 : 0) + (hasInterrupted ? 1 : 0) + (hasInitialOpen ? 1 : 0) !== 1) {
    throw new ContractError('segment predecessor requires exactly one of a recovery receipt, interrupted anchor, or initial-open anchor');
  }
  if (hasReceipt) {
    assertNonEmptyString(input.recoveryAssetsReceiptRef, 'segment predecessor recoveryAssetsReceiptRef');
    return;
  }
  if (hasInterrupted) {
    validateActiveTurnSegmentInterruptedAnchor(input.interrupted);
    return;
  }
  validateActiveTurnInitialOpenAnchor(input.initialOpen);
}

/** Validate one explicit recovery-receipt classification without widening it. */
export function validateActiveTurnSegmentRecoveryReceiptRead(input: unknown): asserts input is ActiveTurnSegmentRecoveryReceiptRead {
  assertPlainObject(input, 'segment recovery receipt read');
  if (input.status === 'exact') {
    assertNonEmptyString(input.recoveryAssetsReceiptRef, 'segment recovery receipt recoveryAssetsReceiptRef');
    return;
  }
  if (input.status === 'interrupted') {
    validateActiveTurnSegmentInterruptedAnchor(input.anchor);
    return;
  }
  if (input.status === 'initial-open') {
    validateActiveTurnInitialOpenAnchor(input.anchor);
    return;
  }
  if (input.status === 'failed' || input.status === 'unknown') {
    assertNonEmptyString(input.reason, `segment recovery receipt ${input.status} reason`);
    return;
  }
  throw new ContractError('segment recovery receipt status is invalid');
}

export function validateActiveTurnInitialOpenSegmentSource(input: unknown): asserts input is ActiveTurnInitialOpenSegmentSource {
  assertPlainObject(input, 'initial-open segment source');
  if (input.kind !== 'initial-open') throw new ContractError('initial-open segment source kind must be initial-open');
  validateActiveTurnInitialOpenAnchor(input.anchor);
  assertActiveTurnBinding(input.binding, 'initial-open segment source binding');
  assertRawAsset(input.initialInput, 'initial-open segment source initialInput');
}

/** Validate an explicit initial-segment source. */
export function validateActiveTurnInitialSegmentSource(input: unknown): asserts input is ActiveTurnInitialSegmentSource {
  assertPlainObject(input, 'initial segment source');
  if (input.kind === 'captured') {
    validateJournalCommitRef(input.bindingCommitRef as JournalCommitRef);
    validateActiveTurnCaptureBody(input.body);
    return;
  }
  if (input.kind === 'initial-open') {
    validateActiveTurnInitialOpenSegmentSource(input);
    return;
  }
  throw new ContractError('initial segment source kind is invalid');
}

/** Validate the initial segment form carried by a segment chain read. */
export function validateActiveTurnSegmentChainInitial(input: unknown): asserts input is ActiveTurnSegmentChainInitial {
  assertPlainObject(input, 'segment chain initial');
  if (input.kind === 'captured') {
    validateActiveTurnCaptureBody(input.body);
    return;
  }
  if (input.kind === 'initial-open') {
    validateActiveTurnInitialOpenSegmentSource(input);
    return;
  }
  throw new ContractError('segment chain initial kind is invalid');
}
export function validateOriginalBusinessTurnRef(input: unknown): asserts input is OriginalBusinessTurnRef {
  assertPlainObject(input, 'original business turn ref');
  assertNonEmptyString(input.businessTurnId, 'original business turn businessTurnId');
  validateJournalCommitRef(input.bindingCommitRef as JournalCommitRef);
  assertProviderExecution(input.execution, 'original business turn execution');
}

export function validateActiveTurnSegmentBinding(input: unknown): asserts input is ActiveTurnSegmentBinding {
  assertPlainObject(input, 'segment binding');
  validateOriginalBusinessTurnRef(input.businessTurnRef);
  assertPlainObject(input.assignment, 'segment binding assignment');
  if (!Array.isArray(input.assignment.successCriteria)) {
    throw new ContractError('segment binding assignment successCriteria must be an array');
  }
  validateWorkAssignment(input.assignment as unknown as WorkAssignment);
  assertProviderExecution(input.execution, 'segment binding execution');
  assertPlainObject(input.incarnation, 'segment binding incarnation');
  assertNonEmptyString(input.incarnation.runtimeId, 'segment binding incarnation runtimeId');
  assertPositiveSafeInteger(input.incarnation.generation, 'segment binding incarnation generation');
  assertNonEmptyString(input.incarnation.agentInstanceId, 'segment binding incarnation agentInstanceId');
  assertNonEmptyString(input.incarnation.roleId, 'segment binding incarnation roleId');
  assertPlainObject(input.incarnation.taskId, 'segment binding incarnation taskId');
  assertScope(input.incarnation.taskId as unknown as Parameters<typeof assertScope>[0], 'task');
  assertNonEmptyString(input.incarnation.assignmentId, 'segment binding incarnation assignmentId');
  assertPositiveSafeInteger(input.incarnation.executionEpoch, 'segment binding incarnation executionEpoch');
  assertPlainObject(input.scope, 'segment binding scope');
  assertScope(input.scope.organId as unknown as Parameters<typeof assertScope>[0], 'organ');
  if (input.scope.taskId !== undefined) {
    assertScope(input.scope.taskId as unknown as Parameters<typeof assertScope>[0], 'task');
  }
  if (input.scope.cycleId !== undefined) {
    assertScope(input.scope.cycleId as unknown as Parameters<typeof assertScope>[0], 'cycle');
  }
  if (input.scope.operationId !== undefined) {
    assertScope(input.scope.operationId as unknown as Parameters<typeof assertScope>[0], 'operation');
  }
  if (input.execution.executionEpoch !== input.incarnation.executionEpoch) {
    throw new ContractError('segment binding execution epoch must equal its incarnation epoch');
  }
}

export function validateActiveTurnSegmentOpenIntent(input: unknown): asserts input is ActiveTurnSegmentOpenIntent {
  assertPlainObject(input, 'segment open intent');
  validateOriginalBusinessTurnRef(input.businessTurnRef);
  assertNonEmptyString(input.segmentId, 'segment open intent segmentId');
  validateActiveTurnSegmentPredecessorRef(input.predecessor);
  if (input.predecessor.segmentId === input.segmentId) {
    throw new ContractError('segment open intent cannot precede itself');
  }
  validateActiveTurnSegmentBinding(input.binding);
  if (input.binding.businessTurnRef.businessTurnId !== input.businessTurnRef.businessTurnId) {
    throw new ContractError('segment open intent binding business turn does not match its ref');
  }
  assertRawAsset(input.initialInput, 'segment open intent initialInput');
}

export function validateResumedTurnSegmentOpened(input: unknown): asserts input is ResumedTurnSegmentOpened {
  assertPlainObject(input, 'resumed segment opened');
  if (input.kind !== 'segment-opened') throw new ContractError('resumed segment kind must be segment-opened');
  assertNonEmptyString(input.segmentId, 'resumed segment segmentId');
  validateOriginalBusinessTurnRef(input.businessTurnRef);
  validateActiveTurnSegmentPredecessorRef(input.predecessor);
  if (input.predecessor.segmentId === input.segmentId) {
    throw new ContractError('resumed segment cannot precede itself');
  }
  validateActiveTurnSegmentBinding(input.binding);
  validateJournalCommitRef(input.authorityCommitRef as JournalCommitRef);
  validateJournalCommitRef(input.businessRegistrationCommitRef as JournalCommitRef);
  if ((input.authorityCommitRef as JournalCommitRef).commitId === (input.businessRegistrationCommitRef as JournalCommitRef).commitId) {
    throw new ContractError('resumed segment registration commit must be distinct from its authority commit');
  }
  assertNonEmptyString(input.requestRef, 'resumed segment requestRef');
  assertPlainObject(input.inputIdentity, 'resumed segment inputIdentity');
  assertNonEmptyString(input.inputIdentity.requestRef, 'resumed segment inputIdentity requestRef');
  assertNonEmptyString(input.inputIdentity.digest, 'resumed segment inputIdentity digest');
  if (input.inputIdentity.requestRef !== input.requestRef) {
    throw new ContractError('resumed segment inputIdentity requestRef must match its requestRef');
  }
  if (input.binding.businessTurnRef.businessTurnId !== input.businessTurnRef.businessTurnId) {
    throw new ContractError('resumed segment binding business turn does not match its record');
  }
}

export function validateActiveTurnSegmentCaptureV2(input: unknown): asserts input is ActiveTurnSegmentCaptureV2 {
  assertPlainObject(input, 'segment capture v2');
  if (input.version !== ACTIVE_TURN_SEGMENT_SCHEMA_VERSION) throw new ContractError('segment capture version must be 2');
  assertNonEmptyString(input.segmentId, 'segment capture segmentId');
  validateOriginalBusinessTurnRef(input.businessTurnRef);
  validateActiveTurnSegmentBinding(input.binding);
  if (input.binding.businessTurnRef.businessTurnId !== input.businessTurnRef.businessTurnId) {
    throw new ContractError('segment capture binding business turn does not match its record');
  }
  assertRawAsset(input.initialInput, 'segment capture initialInput');

  if (!Array.isArray(input.entries)) throw new ContractError('segment capture entries must be an array');
  const entries = input.entries as readonly AcceptedTurnEntry[];
  let previousSeq = 0;
  for (const entry of entries) {
    assertPlainObject(entry, 'segment capture entry');
    if ('envelope' in entry) {
      validateAcceptedRawFact(entry);
      if (entry.envelope.execution.runtimeId !== input.binding.execution.runtimeId
        || entry.envelope.execution.executionEpoch !== input.binding.execution.executionEpoch) {
        throw new ContractError('segment capture raw entry epoch does not match its segment binding');
      }
    } else {
      validateAcceptedChildDelivery(entry);
    }
    if (entry.seq <= previousSeq) throw new ContractError('segment capture entries must be ordered by strictly increasing seq');
    previousSeq = entry.seq;
  }

  if (!Array.isArray(input.requests)) throw new ContractError('segment capture requests must be an array');
  for (const request of input.requests as readonly RuntimeRequestRecord[]) {
    assertPlainObject(request, 'segment capture request record');
    assertPlainObject(request.scope, 'segment capture request scope');
    assertScope(request.scope.organId as unknown as Parameters<typeof assertScope>[0], 'organ');
    if (!['dispatching', 'dispatched', 'waiting', 'settled', 'failed', 'cancelled'].includes(request.phase)) {
      throw new ContractError('segment capture request phase is invalid');
    }
  }

  validateChildInvocationReferences(input.childInvocations, entries, 'segment capture');

  assertPlainObject(input.cut, 'segment capture cut');
  const cut = input.cut as unknown as TurnCaptureCut;
  assertNonEmptyString(cut.pauseId, 'segment capture cut pauseId');
  assertNonNegativeSafeInteger(cut.lastSeq, 'segment capture cut lastSeq');
  if (cut.producersDrained !== true) throw new ContractError('segment capture cut producersDrained must be true');
  assertNonEmptyString(cut.frozenAt, 'segment capture cut frozenAt');
  const maxEntrySeq = entries.length === 0 ? 0 : entries[entries.length - 1]!.seq;
  if (cut.lastSeq !== maxEntrySeq) throw new ContractError('segment capture cut lastSeq must equal the last entry seq');

  validateActiveTurnSegmentPredecessorRef(input.predecessor);
  if (input.predecessor.segmentId === input.segmentId) {
    throw new ContractError('segment capture cannot precede itself');
  }
}

/**
 * Validate a prepared segment v2 capture. The drain boundary, runtime and epoch
 * must belong to this segment; the fixed request cut and the durable raw
 * producer sequences must match the actual drains; every completion lookup must
 * belong to the captured task/execution; and the recovery responsibility must be
 * present. `producersDrained:true` is a structural condition, not proof.
 */
export function validatePreparedActiveTurnSegmentCaptureV2(input: PreparedActiveTurnSegmentCaptureV2): void {
  validateActiveTurnSegmentCaptureV2(input.body);
  assertNonNegativeSafeInteger(input.controlRecordCount, 'segment capture controlRecordCount');
  const { body } = input;
  const requests = new Map<string, { request: ActiveTurnProviderRequestIdentityRef; lastProducerSeq: number }>();
  for (const drain of input.producerDrains) {
    if (drain.boundaryId !== body.cut.pauseId
      || drain.execution.runtimeId !== body.binding.execution.runtimeId
      || drain.execution.executionEpoch !== body.binding.execution.executionEpoch) {
      throw new ContractError('producer drain does not belong to this segment boundary and execution');
    }
    for (const record of drain.requests) {
      assertPlainObject(record.request, 'drained request identity');
      assertNonEmptyString(record.request.turnId, 'drained request turnId');
      assertNonEmptyString(record.request.requestId, 'drained request requestId');
      assertNonNegativeSafeInteger(record.lastProducerSeq, 'drained request lastProducerSeq');
      if (requests.has(record.request.requestId)) throw new ContractError('segment capture repeats a drained request');
      requests.set(record.request.requestId, record);
      if (!body.requests.some((candidate) => candidate.request.requestId === record.request.requestId
        && candidate.request.turnId === record.request.turnId
        && candidate.request.parentRequestId === record.request.parentRequestId)) {
        throw new ContractError('drained request is absent from the fixed segment cut');
      }
    }
  }
  for (const record of body.requests) {
    if (!requests.has(record.request.requestId)) throw new ContractError('segment capture request has no producer drain');
  }
  for (const [requestId, drained] of requests) {
    const raw = body.entries.filter((entry) => 'envelope' in entry && entry.envelope.request.requestId === requestId) as AcceptedRawFact[];
    const lastSeq = raw.reduce((last, entry) => Math.max(last, entry.envelope.producerSeq), 0);
    if (lastSeq !== drained.lastProducerSeq) throw new ContractError('producer drain sequence does not match durable segment raw');
  }
  for (const lookup of input.completionLookups) {
    if (lookup.binding.execution.runtimeId !== body.binding.execution.runtimeId
      || lookup.binding.execution.executionEpoch !== body.binding.execution.executionEpoch
      || lookup.binding.execution.taskId.value !== body.binding.assignment.taskId.value) {
      throw new ContractError('completion lookup does not belong to the captured segment execution');
    }
  }
  assertNonEmptyString(input.recovery.recoveryResponsibilityRef, 'segment capture recovery responsibility');
}

/**
 * Validate an ordered chain. The initial capture stays epoch E; every appended
 * segment keeps the original business turn identity, references the original
 * binding commit, advances the execution epoch and links the exact predecessor.
 */
export function validateActiveTurnSegmentChainRead(input: unknown): asserts input is ActiveTurnSegmentChainRead {
  assertPlainObject(input, 'segment chain read');
  validateOriginalBusinessTurnRef(input.businessTurnRef);
  validateActiveTurnSegmentChainInitial(input.initial);
  const original = input.businessTurnRef as OriginalBusinessTurnRef;
  const initial = input.initial as ActiveTurnSegmentChainInitial;
  if (initial.kind === 'captured') {
    if (initial.body.binding.admittedTurn.turnId !== original.businessTurnId) {
      throw new ContractError('segment chain initial capture does not belong to the original business turn');
    }
    if (initial.body.binding.execution.runtimeId !== original.execution.runtimeId
      || initial.body.binding.execution.executionEpoch !== original.execution.executionEpoch) {
      throw new ContractError('segment chain original execution does not match the initial capture');
    }
  } else {
    if (!sameJournalCommitRef(initial.anchor.bindingCommitRef, original.bindingCommitRef)) {
      throw new ContractError('segment chain initial-open anchor does not match the original binding commit');
    }
    if (initial.binding.admittedTurn.turnId !== original.businessTurnId) {
      throw new ContractError('segment chain initial-open binding does not belong to the original business turn');
    }
    if (initial.binding.execution.runtimeId !== original.execution.runtimeId
      || initial.binding.execution.executionEpoch !== original.execution.executionEpoch) {
      throw new ContractError('segment chain original execution does not match the initial-open binding');
    }
  }

  if (!Array.isArray(input.segments)) throw new ContractError('segment chain segments must be an array');
  let previousEpoch = original.execution.executionEpoch;
  let previousSegmentId: string | undefined;
  const seenSegmentIds = new Set<string>([original.businessTurnId]);
  for (const segment of input.segments as readonly ResumedTurnSegmentOpened[]) {
    validateResumedTurnSegmentOpened(segment);
    if (segment.businessTurnRef.businessTurnId !== original.businessTurnId
      || segment.businessTurnRef.bindingCommitRef.commitId !== original.bindingCommitRef.commitId
      || segment.businessTurnRef.bindingCommitRef.journalSeq !== original.bindingCommitRef.journalSeq
      || segment.businessTurnRef.bindingCommitRef.recordDigest !== original.bindingCommitRef.recordDigest) {
      throw new ContractError('resumed segment does not reference the original business turn');
    }
    if (segment.binding.execution.executionEpoch <= previousEpoch) {
      throw new ContractError('resumed segment epoch must advance past its predecessor');
    }
    if (segment.binding.incarnation.executionEpoch !== segment.binding.execution.executionEpoch) {
      throw new ContractError('resumed segment incarnation epoch must match its execution');
    }
    if (previousSegmentId === undefined) {
      if (segment.predecessor.segmentId !== original.businessTurnId) {
        throw new ContractError('the first resumed segment must precede-link the derived initial segment');
      }
      if (initial.kind === 'initial-open') {
        if (segment.predecessor.initialOpen === undefined
          || !sameJournalCommitRef(segment.predecessor.initialOpen.bindingCommitRef, initial.anchor.bindingCommitRef)
          || !sameJournalCommitRef(segment.predecessor.initialOpen.recordsThroughCommitRef, initial.anchor.recordsThroughCommitRef)) {
          throw new ContractError('the first resumed segment must precede-link the exact initial-open anchor');
        }
      } else if (segment.predecessor.initialOpen !== undefined) {
        throw new ContractError('a captured segment chain cannot begin from an initial-open anchor');
      }
    } else if (segment.predecessor.segmentId !== previousSegmentId) {
      throw new ContractError('resumed segment predecessor must be the previously appended segment');
    } else if (segment.predecessor.initialOpen !== undefined) {
      throw new ContractError('only the first resumed segment can precede-link an initial-open anchor');
    }
    if (seenSegmentIds.has(segment.segmentId)) throw new ContractError('segment chain repeats a segment id');
    seenSegmentIds.add(segment.segmentId);
    previousEpoch = segment.binding.execution.executionEpoch;
    previousSegmentId = segment.segmentId;
  }
}

export function validateNativeSegmentSaveSourceV2(input: unknown): asserts input is NativeSegmentSaveSourceV2 {
  assertPlainObject(input, 'native segment save source v2');
  validateAdmittedTurn(input.originalAdmittedTurn as AdmittedTurn);
  validateOriginalBusinessTurnRef(input.originalBusinessTurnRef as OriginalBusinessTurnRef);
  validateResumedTurnSegmentOpened(input.opened as ResumedTurnSegmentOpened);
  validateJournalCommitRef(input.openedCommitRef as JournalCommitRef);
  const original = input.originalAdmittedTurn as AdmittedTurn;
  const businessRef = input.originalBusinessTurnRef as OriginalBusinessTurnRef;
  const opened = input.opened as ResumedTurnSegmentOpened;
  if (original.turnId !== businessRef.businessTurnId) {
    throw new ContractError('native segment source admission does not match its business turn');
  }
  if (original.workAssignmentRef !== opened.binding.assignment.assignmentId) {
    throw new ContractError('native segment source admission does not match its segment assignment');
  }
  if (businessRef.bindingCommitRef.commitId !== opened.businessTurnRef.bindingCommitRef.commitId
    || businessRef.bindingCommitRef.journalSeq !== opened.businessTurnRef.bindingCommitRef.journalSeq
    || businessRef.bindingCommitRef.recordDigest !== opened.businessTurnRef.bindingCommitRef.recordDigest) {
    throw new ContractError('native segment source business refs do not match its opened record');
  }
  if (businessRef.execution.runtimeId !== opened.businessTurnRef.execution.runtimeId
    || businessRef.execution.executionEpoch !== opened.businessTurnRef.execution.executionEpoch) {
    throw new ContractError('native segment source execution does not match its opened record');
  }
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError(`${label} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError(`${label} must be a non-empty string`);
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ContractError(`${label} must be a non-negative safe integer`);
  }
}

function assertProviderExecution(value: unknown, label: string): asserts value is ActiveTurnProviderExecutionIdentityRef {
  assertPlainObject(value, label);
  assertNonEmptyString(value.runtimeId, `${label} runtimeId`);
  assertPositiveSafeInteger(value.executionEpoch, `${label} executionEpoch`);
}

function assertActiveTurnBinding(value: unknown, label: string): asserts value is ActiveTurnBinding {
  assertPlainObject(value, label);
  const binding = value as unknown as ActiveTurnBinding;
  validateAdmittedTurn(binding.admittedTurn);
  validateWorkAssignment(binding.assignment);
  assertProviderExecution(binding.execution, `${label} execution`);
  assertPlainObject(binding.scope, `${label} scope`);
  assertScope(binding.scope.organId, 'organ');
  if (binding.scope.taskId !== undefined) {
    assertScope(binding.scope.taskId, 'task');
  }
  if (binding.scope.cycleId !== undefined) {
    assertScope(binding.scope.cycleId, 'cycle');
  }
  if (binding.scope.operationId !== undefined) {
    assertScope(binding.scope.operationId, 'operation');
  }
  assertSameScope(binding.admittedTurn.scopeRef, binding.scope);
  if (binding.admittedTurn.workAssignmentRef !== binding.assignment.assignmentId) {
    throw new ContractError(`${label} assignment does not match its admitted turn workAssignmentRef`);
  }
  if (binding.admittedTurn.taskRef.value !== binding.assignment.taskId.value) {
    throw new ContractError(`${label} task does not match its admitted turn taskRef`);
  }
  if (binding.admittedTurn.executionEpoch !== binding.execution.executionEpoch
    || binding.assignment.executionEpoch !== binding.execution.executionEpoch) {
    throw new ContractError(`${label} execution epoch mismatch`);
  }
}

function assertRawAsset(value: unknown, label: string): asserts value is RawAsset {
  assertPlainObject(value, label);
  assertEvidenceRef(value.ref as EvidenceRef);
  assertPlainObject(value.view, `${label} view`);
  assertNonEmptyString(value.view.kind, `${label} view kind`);
}

function sameJournalCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}
