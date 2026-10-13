import { ContractError } from './errors.js';
import type { JournalCommitRef } from './i2-history.js';
import type { TaskRuntimeIncarnation } from './framework.js';
import type { EvidenceRef, ScopeRef, WorkAssignment } from './index.js';
import { assertEvidenceRef, assertScope, validateWorkAssignment } from './index.js';
import {
  validateAcceptedChildDelivery,
  validateAcceptedRawFact,
  validateActiveTurnCaptureBody,
  type AcceptedTurnEntry,
  type ActiveTurnCaptureBody,
  type ActiveTurnProviderExecutionIdentityRef,
  type ChildInvocationRecord,
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

/** Exact predecessor link: the segment this one resumes and its recovery receipt. */
export interface ActiveTurnSegmentPredecessorRef {
  readonly segmentId: string;
  /** Exact J1 recovery-assets receipt that closed the predecessor segment. */
  readonly recoveryAssetsReceiptRef: string;
}

/** Real binding of one execution segment. The incarnation is the actual handle. */
export interface ActiveTurnSegmentBinding {
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly assignment: WorkAssignment;
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly scope: ScopeRef;
}

/**
 * Exact read of one segment's recovery-assets receipt. A failed or unknown
 * receipt keeps the recovery obligation; the consumer never chooses the latest
 * state or replays an effect.
 */
export type ActiveTurnSegmentRecoveryReceiptRead =
  | { readonly status: 'exact'; readonly recoveryAssetsReceiptRef: string }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'unknown'; readonly reason: string };

/** The appendable record that opens one resumed execution segment. */
export interface ResumedTurnSegmentOpened {
  readonly kind: 'segment-opened';
  readonly segmentId: string;
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly predecessor: ActiveTurnSegmentPredecessorRef;
  readonly binding: ActiveTurnSegmentBinding;
  readonly authorityCommitRef: JournalCommitRef;
}

/**
 * Narrow segment capture v2. It holds only the new epoch's entries, references
 * the unique original input asset and keeps the exact predecessor receipt link.
 * It never copies or relabels the old segment's raw.
 */
export interface ActiveTurnSegmentCaptureV2 {
  readonly version: typeof ACTIVE_TURN_SEGMENT_SCHEMA_VERSION;
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

/** Exact read of the immutable first (v1) capture plus its binding commit. */
export interface ActiveTurnInitialSegmentCapture {
  readonly bindingCommitRef: JournalCommitRef;
  readonly body: ActiveTurnCaptureBody;
}

/** Immutable cold read of one business turn's ordered segment chain. */
export interface ActiveTurnSegmentChainRead {
  readonly businessTurnRef: OriginalBusinessTurnRef;
  readonly initial: ActiveTurnCaptureBody;
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

export function validateActiveTurnSegmentIdentity(input: unknown): asserts input is ActiveTurnSegmentIdentity {
  assertPlainObject(input, 'segment identity');
  assertNonEmptyString(input.businessTurnId, 'segment identity businessTurnId');
  assertNonEmptyString(input.segmentId, 'segment identity segmentId');
  assertPositiveSafeInteger(input.executionEpoch, 'segment identity executionEpoch');
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

export function validateResumedTurnSegmentOpened(input: unknown): asserts input is ResumedTurnSegmentOpened {
  assertPlainObject(input, 'resumed segment opened');
  if (input.kind !== 'segment-opened') throw new ContractError('resumed segment kind must be segment-opened');
  assertNonEmptyString(input.segmentId, 'resumed segment segmentId');
  validateOriginalBusinessTurnRef(input.businessTurnRef);
  assertPlainObject(input.predecessor, 'resumed segment predecessor');
  assertNonEmptyString(input.predecessor.segmentId, 'resumed segment predecessor segmentId');
  assertNonEmptyString(input.predecessor.recoveryAssetsReceiptRef, 'resumed segment predecessor recoveryAssetsReceiptRef');
  if (input.predecessor.segmentId === input.segmentId) {
    throw new ContractError('resumed segment cannot precede itself');
  }
  validateActiveTurnSegmentBinding(input.binding);
  validateJournalCommitRef(input.authorityCommitRef as JournalCommitRef);
  if (input.binding.businessTurnRef.businessTurnId !== input.businessTurnRef.businessTurnId) {
    throw new ContractError('resumed segment binding business turn does not match its record');
  }
}

export function validateActiveTurnSegmentCaptureV2(input: unknown): asserts input is ActiveTurnSegmentCaptureV2 {
  assertPlainObject(input, 'segment capture v2');
  if (input.version !== ACTIVE_TURN_SEGMENT_SCHEMA_VERSION) throw new ContractError('segment capture version must be 2');
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

  if (!Array.isArray(input.childInvocations)) throw new ContractError('segment capture childInvocations must be an array');
  for (const invocation of input.childInvocations as readonly ChildInvocationRecord[]) {
    assertPlainObject(invocation, 'segment capture child invocation');
    assertNonEmptyString(invocation.invocationId, 'segment capture child invocationId');
  }

  assertPlainObject(input.cut, 'segment capture cut');
  const cut = input.cut as unknown as TurnCaptureCut;
  assertNonEmptyString(cut.pauseId, 'segment capture cut pauseId');
  assertNonNegativeSafeInteger(cut.lastSeq, 'segment capture cut lastSeq');
  if (cut.producersDrained !== true) throw new ContractError('segment capture cut producersDrained must be true');
  assertNonEmptyString(cut.frozenAt, 'segment capture cut frozenAt');
  const maxEntrySeq = entries.length === 0 ? 0 : entries[entries.length - 1]!.seq;
  if (cut.lastSeq !== maxEntrySeq) throw new ContractError('segment capture cut lastSeq must equal the last entry seq');

  assertPlainObject(input.predecessor, 'segment capture predecessor');
  assertNonEmptyString(input.predecessor.segmentId, 'segment capture predecessor segmentId');
  assertNonEmptyString(input.predecessor.recoveryAssetsReceiptRef, 'segment capture predecessor recoveryAssetsReceiptRef');
}

/**
 * Validate an ordered chain. The initial capture stays epoch E; every appended
 * segment keeps the original business turn identity, references the original
 * binding commit, advances the execution epoch and links the exact predecessor.
 */
export function validateActiveTurnSegmentChainRead(input: unknown): asserts input is ActiveTurnSegmentChainRead {
  assertPlainObject(input, 'segment chain read');
  validateOriginalBusinessTurnRef(input.businessTurnRef);
  validateActiveTurnCaptureBody(input.initial);
  const original = input.businessTurnRef as OriginalBusinessTurnRef;
  const initial = input.initial as ActiveTurnCaptureBody;
  if (initial.binding.admittedTurn.turnId !== original.businessTurnId) {
    throw new ContractError('segment chain initial capture does not belong to the original business turn');
  }
  if (initial.binding.execution.runtimeId !== original.execution.runtimeId
    || initial.binding.execution.executionEpoch !== original.execution.executionEpoch) {
    throw new ContractError('segment chain original execution does not match the initial capture');
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
    } else if (segment.predecessor.segmentId !== previousSegmentId) {
      throw new ContractError('resumed segment predecessor must be the previously appended segment');
    }
    if (seenSegmentIds.has(segment.segmentId)) throw new ContractError('segment chain repeats a segment id');
    seenSegmentIds.add(segment.segmentId);
    previousEpoch = segment.binding.execution.executionEpoch;
    previousSegmentId = segment.segmentId;
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

function assertRawAsset(value: unknown, label: string): asserts value is RawAsset {
  assertPlainObject(value, label);
  assertEvidenceRef(value.ref as EvidenceRef);
  assertPlainObject(value.view, `${label} view`);
  assertNonEmptyString(value.view.kind, `${label} view kind`);
}
