import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  validatePreparedRecoveryCapture,
  type AcceptedTurnEntry,
  type CompletionReadInput,
  type CompletionReadback,
  type EvidenceRef,
  type PreparedRecoveryCapture,
  type ProviderProducerDrainResult,
  type RawAsset,
  type RecoveryAssetsReadback,
  type RecoveryAssetsReceipt,
  type RecoveryHoldFacts,
  type ScopeRef,
} from '../../contracts/src/index.js';
import {
  validatePreparedActiveTurnSegmentCaptureV2,
  type ActiveTurnSegmentCaptureV2,
  type PreparedActiveTurnSegmentCaptureV2,
} from '../../contracts/src/active-turn-segments.js';
import type { ActiveTurnCaptureBody } from '../../contracts/src/index.js';
import {
  ImmutableAssetStore,
  evidenceReference,
} from '../../adapters/filesystem/src/index.js';
import {
  JsonlOrganJournal,
  type JournalRecord,
} from '../../adapters/jsonl/src/index.js';
import { createJsonlActiveTurnSegmentJournal } from '../../adapters/jsonl/src/active-turn.js';
import { JsonlOperationCompletionJournal } from '../../adapters/jsonl/src/operation-completion.js';
import type {
  ActiveTurnSegmentCaptureExactRead,
  ActiveTurnSegmentJournalPort,
  ActiveTurnSegmentJournalRecord,
} from '../../runtime/src/context/active-turn-journal.js';
import type {
  ActiveTurnInitialSegmentCapture,
  ActiveTurnSegmentRecoveryReceiptRead,
} from '../../contracts/src/active-turn-segments.js';
import type {
  OperationCompletionLookupDescriptor,
} from '../../runtime/src/gateway/operation-completion.js';

/**
 * The App-side assembly for the `recovery-assets` phase. It owns three narrow
 * actions only: write the raw initial input as an immutable asset, freeze a
 * `PreparedRecoveryCapture` into an immutable capture asset and commit one
 * typed phase receipt to the authoritative Organ Journal, and cold-read that
 * receipt without any latest fallback.
 *
 * The receipt and readback are the shared contract types. The receipt keeps the
 * actual `producerDrains` and `RecoveryHoldFacts` (not opaque refs) so a cold
 * reader sees the real producer cut and recovery responsibility. Completion
 * truth stays in the F-RC journal and is read through `readExact`; this module
 * never copies a completion result into the capture.
 */

export class RecoveryAssetsIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecoveryAssetsIntegrityError';
  }
}

const RECOVERY_ASSETS_PAYLOAD_TYPE = 'recovery-assets.phase';
const RECOVERY_ASSETS_RECEIPT_PREFIX = 'recovery-assets:v1:';
const RECOVERY_ASSETS_V2_RECEIPT_PREFIX = 'recovery-assets:v2:';
const RECOVERY_ASSETS_DOMAIN = 'humanagent.recovery-assets.v1';
const RECOVERY_ASSETS_V2_DOMAIN = 'humanagent.recovery-assets.v2';
const RECOVERY_ASSETS_SOURCE = 'humanagent.native-recovery-assets';

/** The durable receipt shape that is stored inside the Organ Journal payload. */
interface StoredRecoveryAssetsReceipt {
  readonly receiptRef: string;
  readonly turnId: string;
  readonly boundaryId: string;
  readonly controlRecordCount: number;
  readonly producerDrains: readonly ProviderProducerDrainResult[];
  readonly completionLookups: readonly OperationCompletionLookupDescriptor[];
  readonly recovery: RecoveryHoldFacts;
  readonly captureRef: EvidenceRef;
}

export interface RecoveryAssetsPhaseInput {
  readonly turnId: string;
  readonly boundaryId: string;
  readonly prepared: PreparedRecoveryCapture;
}

export interface RecoveryAssetsCompletionReadback {
  readonly lookup: OperationCompletionLookupDescriptor;
  readonly readback: CompletionReadback;
}

/**
 * The shared cold-read shape plus the exact completion states that the reader
 * resolved through the F-RC journal. `prepared` is the full frozen capture,
 * including the real producer drains and recovery facts.
 */
export type NativeRecoveryAssetsReadback = RecoveryAssetsReadback & {
  readonly completions: readonly RecoveryAssetsCompletionReadback[];
};

export interface NativeRecoveryAssets {
  writeInitialInput(input: {
    readonly scope: ScopeRef;
    readonly turnId: string;
    readonly rawInput: string;
  }): Promise<RawAsset>;
  commitCapturePhase(input: RecoveryAssetsPhaseInput): Promise<RecoveryAssetsReceipt>;
  readRecoveryAssetsExact(receiptRef: string): Promise<NativeRecoveryAssetsReadback>;
  writeSegmentCapturePhase(input: SegmentRecoveryAssetsPhaseInput): Promise<ActiveTurnSegmentRecoveryAssetsReceipt>;
  readSegmentRecoveryAssetsExact(receiptRef: string): Promise<NativeActiveTurnSegmentCaptureReadback>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new RecoveryAssetsIntegrityError(`${label} is required`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RecoveryAssetsIntegrityError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

export function initialInputAssetId(turnId: string): string {
  return `initial-input-${sha256Hex(`humanagent.initial-input.v1:${nonEmpty(turnId, 'turnId')}`).slice(0, 48)}`;
}

export function recoveryCaptureAssetId(turnId: string, boundaryId: string): string {
  return `recovery-capture-${sha256Hex(
    `humanagent.recovery-capture.v1:${nonEmpty(turnId, 'turnId')}:${nonEmpty(boundaryId, 'boundaryId')}`,
  ).slice(0, 48)}`;
}

export function recoveryAssetsReceiptRef(input: {
  readonly turnId: string;
  readonly boundaryId: string;
  readonly cut: ActiveTurnCaptureBody['cut'];
  readonly captureDigest: string;
  readonly controlRecordCount: number;
}): string {
  const digest = sha256Hex(canonicalJsonStringify({
    domain: RECOVERY_ASSETS_DOMAIN,
    turnId: nonEmpty(input.turnId, 'turnId'),
    boundaryId: nonEmpty(input.boundaryId, 'boundaryId'),
    cut: {
      pauseId: nonEmpty(input.cut.pauseId, 'cut pauseId'),
      lastSeq: nonNegativeInteger(input.cut.lastSeq, 'cut lastSeq'),
      frozenAt: nonEmpty(input.cut.frozenAt, 'cut frozenAt'),
    },
    captureDigest: nonEmpty(input.captureDigest, 'captureDigest'),
    controlRecordCount: nonNegativeInteger(input.controlRecordCount, 'controlRecordCount'),
  }));
  return `${RECOVERY_ASSETS_RECEIPT_PREFIX}${digest}`;
}

export function segmentCaptureAssetId(businessTurnId: string, segmentId: string, boundaryId: string): string {
  return `segment-capture-${sha256Hex(
    `humanagent.segment-capture.v2:${nonEmpty(businessTurnId, 'businessTurnId')}:${nonEmpty(segmentId, 'segmentId')}:${nonEmpty(boundaryId, 'boundaryId')}`,
  ).slice(0, 48)}`;
}

export function segmentRecoveryAssetsReceiptRef(input: {
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly boundaryId: string;
  readonly cut: ActiveTurnSegmentCaptureV2['cut'];
  readonly captureDigest: string;
  readonly controlRecordCount: number;
}): string {
  const digest = sha256Hex(canonicalJsonStringify({
    domain: RECOVERY_ASSETS_V2_DOMAIN,
    businessTurnId: nonEmpty(input.businessTurnId, 'businessTurnId'),
    segmentId: nonEmpty(input.segmentId, 'segmentId'),
    boundaryId: nonEmpty(input.boundaryId, 'boundaryId'),
    cut: {
      pauseId: nonEmpty(input.cut.pauseId, 'cut pauseId'),
      lastSeq: nonNegativeInteger(input.cut.lastSeq, 'cut lastSeq'),
      frozenAt: nonEmpty(input.cut.frozenAt, 'cut frozenAt'),
    },
    captureDigest: nonEmpty(input.captureDigest, 'captureDigest'),
    controlRecordCount: nonNegativeInteger(input.controlRecordCount, 'controlRecordCount'),
  }));
  return `${RECOVERY_ASSETS_V2_RECEIPT_PREFIX}${digest}`;
}

export interface SegmentRecoveryAssetsPhaseInput {
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly boundaryId: string;
  readonly prepared: PreparedActiveTurnSegmentCaptureV2;
}

export interface ActiveTurnSegmentRecoveryAssetsReceipt {
  readonly commitIdentity: string;
  readonly journalReceiptRef: string;
  readonly commitFactDigest: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly boundaryId: string;
  readonly capture: RawAsset;
}

export interface NativeActiveTurnSegmentCaptureReadback {
  readonly receipt: ActiveTurnSegmentRecoveryAssetsReceipt;
  readonly prepared: PreparedActiveTurnSegmentCaptureV2;
}

/** The durable v2 receipt shape stored inside the Organ Journal payload. */
interface StoredSegmentRecoveryAssetsReceipt {
  readonly receiptRef: string;
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly boundaryId: string;
  readonly controlRecordCount: number;
  readonly producerDrains: readonly ProviderProducerDrainResult[];
  readonly completionLookups: readonly OperationCompletionLookupDescriptor[];
  readonly recovery: RecoveryHoldFacts;
  readonly captureRef: EvidenceRef;
}

function assertPrepared(prepared: unknown): asserts prepared is PreparedRecoveryCapture {
  try {
    validatePreparedRecoveryCapture(prepared as PreparedRecoveryCapture);
  } catch (error) {
    throw new RecoveryAssetsIntegrityError(
      error instanceof Error ? error.message : 'prepared recovery capture is invalid',
      { cause: error },
    );
  }
}

function assertCapture(capture: unknown): asserts capture is ActiveTurnCaptureBody {
  if (capture === null || typeof capture !== 'object' || Array.isArray(capture)) {
    throw new RecoveryAssetsIntegrityError('capture body must be an object');
  }
}

function assertLookup(lookup: unknown): asserts lookup is OperationCompletionLookupDescriptor {
  if (lookup === null || typeof lookup !== 'object' || Array.isArray(lookup)) {
    throw new RecoveryAssetsIntegrityError('completion lookup descriptor must be an object');
  }
  const value = lookup as Partial<OperationCompletionLookupDescriptor>;
  nonEmpty(value.commitIdentity, 'completion lookup commitIdentity');
  nonEmpty(value.effectId, 'completion lookup effectId');
  if (value.binding === null || typeof value.binding !== 'object' || Array.isArray(value.binding)) {
    throw new RecoveryAssetsIntegrityError('completion lookup binding must be an object');
  }
}

function collectReferencedAssets(capture: {
  readonly initialInput: RawAsset;
  readonly entries: readonly AcceptedTurnEntry[];
}): readonly EvidenceRef[] {
  const refs: EvidenceRef[] = [capture.initialInput.ref];
  for (const entry of capture.entries) {
    if ('envelope' in entry) {
      const fact = entry.envelope.fact;
      if (fact.kind === 'content') refs.push(fact.content.ref);
      else if (fact.kind === 'tool-call') refs.push(fact.rawArguments.ref);
      else if (fact.kind === 'tool-result') refs.push(fact.rawOutput.ref);
    } else {
      refs.push(entry.refinedDelivery.ref);
    }
  }
  return refs;
}

function storedReceiptFromRecord(record: JournalRecord): StoredRecoveryAssetsReceipt {
  if (record.kind !== 'event' || record.payload?.type !== RECOVERY_ASSETS_PAYLOAD_TYPE) {
    throw new RecoveryAssetsIntegrityError('recovery-assets receipt record is not a typed phase commit');
  }
  const receipt = record.payload.receipt;
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new RecoveryAssetsIntegrityError('recovery-assets receipt payload is missing');
  }
  const value = receipt as StoredRecoveryAssetsReceipt;
  nonEmpty(value.receiptRef, 'receiptRef');
  if (value.receiptRef !== record.commitId) {
    throw new RecoveryAssetsIntegrityError('recovery-assets receipt identity does not match its journal commit');
  }
  nonEmpty(value.turnId, 'turnId');
  nonEmpty(value.boundaryId, 'boundaryId');
  nonNegativeInteger(value.controlRecordCount, 'controlRecordCount');
  if (!Array.isArray(value.producerDrains)) {
    throw new RecoveryAssetsIntegrityError('recovery-assets producer drains must be an array');
  }
  if (value.recovery === null || typeof value.recovery !== 'object' || Array.isArray(value.recovery)) {
    throw new RecoveryAssetsIntegrityError('recovery-assets recovery facts are missing');
  }
  nonEmpty(value.recovery.recoveryResponsibilityRef, 'recovery responsibility');
  if (value.captureRef === null || typeof value.captureRef !== 'object' || Array.isArray(value.captureRef)) {
    throw new RecoveryAssetsIntegrityError('recovery-assets capture reference is missing');
  }
  nonEmpty(value.captureRef.digest, 'captureRef digest');
  if (!Array.isArray(value.completionLookups)) {
    throw new RecoveryAssetsIntegrityError('recovery-assets completion lookups must be an array');
  }
  for (const lookup of value.completionLookups) assertLookup(lookup);
  return value;
}

function receiptFromRecord(record: JournalRecord): RecoveryAssetsReceipt {
  const stored = storedReceiptFromRecord(record);
  if (record.commitId === undefined || record.commitFactDigest === undefined || record.recordDigest === undefined) {
    throw new RecoveryAssetsIntegrityError('recovery-assets receipt record is not committed');
  }
  return {
    commitIdentity: record.commitId,
    journalReceiptRef: record.commitId,
    commitFactDigest: record.commitFactDigest,
    journalSeq: record.seq,
    recordDigest: record.recordDigest,
    turnId: stored.turnId,
    boundaryId: stored.boundaryId,
    capture: { ref: stored.captureRef, view: { kind: 'utf8-text' } },
  };
}

function decodeCapture(bytes: Uint8Array): ActiveTurnCaptureBody {
  let capture: ActiveTurnCaptureBody;
  try {
    capture = JSON.parse(new TextDecoder().decode(bytes)) as ActiveTurnCaptureBody;
  } catch (error) {
    throw new RecoveryAssetsIntegrityError('recovery-assets capture asset is not valid JSON', { cause: error });
  }
  assertCapture(capture);
  return capture;
}

function assertSegmentPrepared(prepared: unknown): asserts prepared is PreparedActiveTurnSegmentCaptureV2 {
  try {
    validatePreparedActiveTurnSegmentCaptureV2(prepared as PreparedActiveTurnSegmentCaptureV2);
  } catch (error) {
    throw new RecoveryAssetsIntegrityError(
      error instanceof Error ? error.message : 'prepared segment capture is invalid',
      { cause: error },
    );
  }
}

function storedSegmentReceiptFromRecord(record: JournalRecord): StoredSegmentRecoveryAssetsReceipt {
  if (record.kind !== 'event'
    || record.payload?.type !== RECOVERY_ASSETS_PAYLOAD_TYPE
    || record.payload.version !== 2) {
    throw new RecoveryAssetsIntegrityError('segment recovery-assets receipt record is not a typed v2 phase commit');
  }
  const receipt = record.payload.receipt;
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new RecoveryAssetsIntegrityError('segment recovery-assets receipt payload is missing');
  }
  const value = receipt as StoredSegmentRecoveryAssetsReceipt;
  nonEmpty(value.receiptRef, 'receiptRef');
  if (value.receiptRef !== record.commitId) {
    throw new RecoveryAssetsIntegrityError('segment recovery-assets receipt identity does not match its journal commit');
  }
  nonEmpty(value.businessTurnId, 'businessTurnId');
  nonEmpty(value.segmentId, 'segmentId');
  nonEmpty(value.boundaryId, 'boundaryId');
  nonNegativeInteger(value.controlRecordCount, 'controlRecordCount');
  if (!Array.isArray(value.producerDrains)) {
    throw new RecoveryAssetsIntegrityError('segment recovery-assets producer drains must be an array');
  }
  if (value.recovery === null || typeof value.recovery !== 'object' || Array.isArray(value.recovery)) {
    throw new RecoveryAssetsIntegrityError('segment recovery-assets recovery facts are missing');
  }
  nonEmpty(value.recovery.recoveryResponsibilityRef, 'recovery responsibility');
  if (value.captureRef === null || typeof value.captureRef !== 'object' || Array.isArray(value.captureRef)) {
    throw new RecoveryAssetsIntegrityError('segment recovery-assets capture reference is missing');
  }
  nonEmpty(value.captureRef.digest, 'captureRef digest');
  if (!Array.isArray(value.completionLookups)) {
    throw new RecoveryAssetsIntegrityError('segment recovery-assets completion lookups must be an array');
  }
  for (const lookup of value.completionLookups) assertLookup(lookup);
  return value;
}

function segmentReceiptFromRecord(record: JournalRecord): ActiveTurnSegmentRecoveryAssetsReceipt {
  const stored = storedSegmentReceiptFromRecord(record);
  if (record.commitId === undefined || record.commitFactDigest === undefined || record.recordDigest === undefined) {
    throw new RecoveryAssetsIntegrityError('segment recovery-assets receipt record is not committed');
  }
  return {
    commitIdentity: record.commitId,
    journalReceiptRef: record.commitId,
    commitFactDigest: record.commitFactDigest,
    journalSeq: record.seq,
    recordDigest: record.recordDigest,
    businessTurnId: stored.businessTurnId,
    segmentId: stored.segmentId,
    boundaryId: stored.boundaryId,
    capture: { ref: stored.captureRef, view: { kind: 'utf8-text' } },
  };
}

function decodeSegmentCapture(bytes: Uint8Array): ActiveTurnSegmentCaptureV2 {
  let capture: ActiveTurnSegmentCaptureV2;
  try {
    capture = JSON.parse(new TextDecoder().decode(bytes)) as ActiveTurnSegmentCaptureV2;
  } catch (error) {
    throw new RecoveryAssetsIntegrityError('segment capture asset is not valid JSON', { cause: error });
  }
  if (capture === null || typeof capture !== 'object' || Array.isArray(capture)) {
    throw new RecoveryAssetsIntegrityError('segment capture body must be an object');
  }
  return capture;
}

export function createNativeRecoveryAssets(input: {
  readonly journalPath: string;
  readonly assetRoot: string;
  readonly completionJournalPath?: string;
}): NativeRecoveryAssets {
  if (!input.journalPath.trim()) throw new RecoveryAssetsIntegrityError('recovery-assets journal path is required');
  if (!input.assetRoot.trim()) throw new RecoveryAssetsIntegrityError('recovery-assets asset root is required');
  const journal = new JsonlOrganJournal(input.journalPath);
  const assets = new ImmutableAssetStore(input.assetRoot);
  const completionJournal = input.completionJournalPath?.trim()
    ? new JsonlOperationCompletionJournal(input.completionJournalPath)
    : undefined;

  async function writeInitialInput(initial: {
    readonly scope: ScopeRef;
    readonly turnId: string;
    readonly rawInput: string;
  }): Promise<RawAsset> {
    const bytes = new TextEncoder().encode(initial.rawInput);
    const reference = await assets.write(initialInputAssetId(initial.turnId), bytes);
    const ref = evidenceReference(reference, initial.scope, 'operation', `${RECOVERY_ASSETS_SOURCE}.initial-input`);
    return { ref, view: { kind: 'utf8-text' } };
  }

  async function commitCapturePhase(phase: RecoveryAssetsPhaseInput): Promise<RecoveryAssetsReceipt> {
    nonEmpty(phase.turnId, 'turnId');
    nonEmpty(phase.boundaryId, 'boundaryId');
    assertPrepared(phase.prepared);
    const prepared = structuredClone(phase.prepared);
    const capture = prepared.body;
    if (capture.binding.admittedTurn.turnId !== phase.turnId) {
      throw new RecoveryAssetsIntegrityError('capture binding does not match the committed turn');
    }
    if (capture.cut.pauseId !== phase.boundaryId) {
      throw new RecoveryAssetsIntegrityError('capture cut pauseId does not match the committed boundary');
    }

    const bytes = new TextEncoder().encode(canonicalJsonStringify(capture));
    const reference = await assets.write(recoveryCaptureAssetId(phase.turnId, phase.boundaryId), bytes);
    const captureRef = evidenceReference(reference, capture.binding.scope, 'operation', `${RECOVERY_ASSETS_SOURCE}.capture`);
    const receiptRef = recoveryAssetsReceiptRef({
      turnId: phase.turnId,
      boundaryId: phase.boundaryId,
      cut: capture.cut,
      captureDigest: captureRef.digest!,
      controlRecordCount: prepared.controlRecordCount,
    });
    const stored: StoredRecoveryAssetsReceipt = {
      receiptRef,
      turnId: phase.turnId,
      boundaryId: phase.boundaryId,
      controlRecordCount: prepared.controlRecordCount,
      producerDrains: structuredClone(prepared.producerDrains),
      completionLookups: prepared.completionLookups.map((lookup) => structuredClone(lookup)),
      recovery: structuredClone(prepared.recovery),
      captureRef,
    };
    const record = await journal.append({
      commitId: receiptRef,
      kind: 'event',
      scope: capture.binding.scope,
      payload: { type: RECOVERY_ASSETS_PAYLOAD_TYPE, version: 1, receipt: stored },
    });
    return receiptFromRecord(record);
  }

  async function readRecoveryAssetsExact(receiptRef: string): Promise<NativeRecoveryAssetsReadback> {
    nonEmpty(receiptRef, 'receiptRef');
    const records = await journal.replay();
    const record = records.find((candidate) => candidate.commitId === receiptRef);
    if (!record) {
      throw new RecoveryAssetsIntegrityError(`recovery-assets receipt is not committed: ${receiptRef}`);
    }
    const stored = storedReceiptFromRecord(record);
    const receipt = receiptFromRecord(record);
    if (!sameScope(record.scope, receipt.capture.ref.scope)) {
      throw new RecoveryAssetsIntegrityError('recovery-assets receipt scope does not match its capture reference');
    }

    const capture = decodeCapture(await assets.readEvidence(receipt.capture.ref));
    if (capture.binding.admittedTurn.turnId !== receipt.turnId) {
      throw new RecoveryAssetsIntegrityError('recovery-assets capture turn does not match its receipt');
    }
    if (capture.cut.pauseId !== receipt.boundaryId) {
      throw new RecoveryAssetsIntegrityError('recovery-assets capture cut does not match its receipt boundary');
    }
    if (!sameScope(capture.binding.scope, record.scope)) {
      throw new RecoveryAssetsIntegrityError('recovery-assets capture scope does not match its journal commit');
    }

    const prepared: PreparedRecoveryCapture = {
      body: capture,
      controlRecordCount: stored.controlRecordCount,
      producerDrains: structuredClone(stored.producerDrains),
      completionLookups: stored.completionLookups.map((lookup) => structuredClone(lookup)),
      recovery: structuredClone(stored.recovery),
    };
    assertPrepared(prepared);

    for (const ref of collectReferencedAssets(capture)) {
      await assets.readEvidence(ref);
    }

    const completions: RecoveryAssetsCompletionReadback[] = [];
    if (prepared.completionLookups.length > 0) {
      if (!completionJournal) {
        throw new RecoveryAssetsIntegrityError('recovery-assets completion journal is not configured');
      }
      for (const lookup of prepared.completionLookups) {
        completions.push({ lookup, readback: await completionJournal.readExact(lookup) });
      }
    }

    return { receipt, prepared, completions };
  }

  async function writeSegmentCapturePhase(
    phase: SegmentRecoveryAssetsPhaseInput,
  ): Promise<ActiveTurnSegmentRecoveryAssetsReceipt> {
    nonEmpty(phase.businessTurnId, 'businessTurnId');
    nonEmpty(phase.segmentId, 'segmentId');
    nonEmpty(phase.boundaryId, 'boundaryId');
    assertSegmentPrepared(phase.prepared);
    const prepared = structuredClone(phase.prepared);
    const capture = prepared.body;
    if (capture.businessTurnRef.businessTurnId !== phase.businessTurnId) {
      throw new RecoveryAssetsIntegrityError('segment capture business turn does not match the committed segment');
    }
    if (capture.segmentId !== phase.segmentId) {
      throw new RecoveryAssetsIntegrityError('segment capture segmentId does not match the committed segment');
    }
    if (capture.cut.pauseId !== phase.boundaryId) {
      throw new RecoveryAssetsIntegrityError('segment capture cut pauseId does not match the committed boundary');
    }

    const bytes = new TextEncoder().encode(canonicalJsonStringify(capture));
    const reference = await assets.write(segmentCaptureAssetId(phase.businessTurnId, phase.segmentId, phase.boundaryId), bytes);
    const captureRef = evidenceReference(reference, capture.binding.scope, 'operation', `${RECOVERY_ASSETS_SOURCE}.segment-capture`);
    const receiptRef = segmentRecoveryAssetsReceiptRef({
      businessTurnId: phase.businessTurnId,
      segmentId: phase.segmentId,
      boundaryId: phase.boundaryId,
      cut: capture.cut,
      captureDigest: captureRef.digest!,
      controlRecordCount: prepared.controlRecordCount,
    });
    const stored: StoredSegmentRecoveryAssetsReceipt = {
      receiptRef,
      businessTurnId: phase.businessTurnId,
      segmentId: phase.segmentId,
      boundaryId: phase.boundaryId,
      controlRecordCount: prepared.controlRecordCount,
      producerDrains: structuredClone(prepared.producerDrains),
      completionLookups: prepared.completionLookups.map((lookup) => structuredClone(lookup)),
      recovery: structuredClone(prepared.recovery),
      captureRef,
    };
    const record = await journal.append({
      commitId: receiptRef,
      kind: 'event',
      scope: capture.binding.scope,
      payload: { type: RECOVERY_ASSETS_PAYLOAD_TYPE, version: 2, receipt: stored },
    });
    return segmentReceiptFromRecord(record);
  }

  async function readSegmentRecoveryAssetsExact(receiptRef: string): Promise<NativeActiveTurnSegmentCaptureReadback> {
    nonEmpty(receiptRef, 'receiptRef');
    const records = await journal.replay();
    const record = records.find((candidate) => candidate.commitId === receiptRef);
    if (!record) {
      throw new RecoveryAssetsIntegrityError(`segment recovery-assets receipt is not committed: ${receiptRef}`);
    }
    const stored = storedSegmentReceiptFromRecord(record);
    const receipt = segmentReceiptFromRecord(record);
    if (!sameScope(record.scope, receipt.capture.ref.scope)) {
      throw new RecoveryAssetsIntegrityError('segment recovery-assets receipt scope does not match its capture reference');
    }

    const capture = decodeSegmentCapture(await assets.readEvidence(receipt.capture.ref));
    if (capture.businessTurnRef.businessTurnId !== receipt.businessTurnId) {
      throw new RecoveryAssetsIntegrityError('segment capture business turn does not match its receipt');
    }
    if (capture.segmentId !== receipt.segmentId) {
      throw new RecoveryAssetsIntegrityError('segment capture segmentId does not match its receipt');
    }
    if (capture.cut.pauseId !== receipt.boundaryId) {
      throw new RecoveryAssetsIntegrityError('segment capture cut does not match its receipt boundary');
    }
    if (!sameScope(capture.binding.scope, record.scope)) {
      throw new RecoveryAssetsIntegrityError('segment capture scope does not match its journal commit');
    }

    const prepared: PreparedActiveTurnSegmentCaptureV2 = {
      body: capture,
      controlRecordCount: stored.controlRecordCount,
      producerDrains: structuredClone(stored.producerDrains),
      completionLookups: stored.completionLookups.map((lookup) => structuredClone(lookup)),
      recovery: structuredClone(stored.recovery),
    };
    assertSegmentPrepared(prepared);

    for (const ref of collectReferencedAssets(capture)) {
      await assets.readEvidence(ref);
    }

    return { receipt, prepared };
  }

  return {
    writeInitialInput,
    commitCapturePhase,
    readRecoveryAssetsExact,
    writeSegmentCapturePhase,
    readSegmentRecoveryAssetsExact,
  };
}

export interface ActiveTurnSegmentJournalInput {
  readonly journalPath: string;
  readonly assetRoot: string;
  readonly completionJournalPath?: string;
  readonly businessTurnId: string;
}

function storedPhaseReceipt(record: JournalRecord): Record<string, unknown> | null {
  if (record.kind !== 'event' || record.payload?.type !== RECOVERY_ASSETS_PAYLOAD_TYPE) return null;
  const receipt = record.payload.receipt;
  return receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
    ? receipt as Record<string, unknown>
    : null;
}

/**
 * The J1 App assembly for one business turn. It composes the JSONL segment
 * codec with the immutable-asset phase writer so the Runtime segment consumer
 * gets the real read/append ports and D-L/D-M get the exact record and capture
 * reads. Recovery lookups use the explicit `segmentId` selector; there is no
 * latest fallback and no second store. A segment reservation never grants
 * unlimited later work.
 */
export function createActiveTurnSegmentJournal(input: ActiveTurnSegmentJournalInput): ActiveTurnSegmentJournalPort {
  const businessTurnId = nonEmpty(input.businessTurnId, 'businessTurnId');
  const journal = new JsonlOrganJournal(input.journalPath);
  const native = createNativeRecoveryAssets({
    journalPath: input.journalPath,
    assetRoot: input.assetRoot,
    ...(input.completionJournalPath === undefined ? {} : { completionJournalPath: input.completionJournalPath }),
  });
  const completionJournal = input.completionJournalPath?.trim()
    ? new JsonlOperationCompletionJournal(input.completionJournalPath)
    : undefined;
  const segmentJournal = createJsonlActiveTurnSegmentJournal({
    filePath: input.journalPath,
    businessTurnId,
    verifyPredecessorReceipt: (records, predecessor) => {
      const record = records.find((candidate) => candidate.commitId === predecessor.recoveryAssetsReceiptRef);
      if (record === undefined) {
        throw new RecoveryAssetsIntegrityError('segment predecessor recovery receipt is not committed');
      }
      const receipt = storedPhaseReceipt(record);
      if (receipt === null) {
        throw new RecoveryAssetsIntegrityError('segment predecessor recovery receipt is not a typed phase commit');
      }
      if (record.payload?.version === 2) {
        if (receipt.businessTurnId !== businessTurnId || receipt.segmentId !== predecessor.segmentId) {
          throw new RecoveryAssetsIntegrityError('segment predecessor receipt does not belong to the predecessor segment');
        }
      } else if (receipt.turnId !== predecessor.segmentId) {
        throw new RecoveryAssetsIntegrityError('initial predecessor receipt does not belong to the business turn');
      }
    },
  });

  async function initialRecoveryReceiptRef(): Promise<string | null> {
    const matches = (await journal.replay()).filter((record) => {
      if (record.kind !== 'event' || record.payload?.type !== RECOVERY_ASSETS_PAYLOAD_TYPE) return false;
      if ((record.payload.version ?? 1) !== 1) return false;
      return storedPhaseReceipt(record)?.turnId === businessTurnId;
    });
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new RecoveryAssetsIntegrityError('multiple v1 recovery receipts exist for the business turn');
    }
    return matches[0]!.commitId ?? null;
  }

  async function segmentRecoveryReceiptRef(segmentId: string): Promise<string | null> {
    const matches = (await journal.replay()).filter((record) => {
      if (record.kind !== 'event' || record.payload?.type !== RECOVERY_ASSETS_PAYLOAD_TYPE) return false;
      if (record.payload.version !== 2) return false;
      const receipt = storedPhaseReceipt(record);
      return receipt?.businessTurnId === businessTurnId && receipt?.segmentId === segmentId;
    });
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new RecoveryAssetsIntegrityError(`multiple v2 recovery receipts exist for segment ${segmentId}`);
    }
    return matches[0]!.commitId ?? null;
  }

  async function readInitialSegmentCapture(requested: string): Promise<ActiveTurnInitialSegmentCapture | null> {
    if (requested !== businessTurnId) {
      throw new RecoveryAssetsIntegrityError(`segment journal is bound to business turn ${businessTurnId}`);
    }
    const receiptRef = await initialRecoveryReceiptRef();
    if (receiptRef === null) return null;
    const readback = await native.readRecoveryAssetsExact(receiptRef);
    const bindingCommitRef = await segmentJournal.readInitialBindingCommit();
    return { bindingCommitRef, body: readback.prepared.body };
  }

  async function readSegmentRecoveryReceipt(segmentId: string): Promise<ActiveTurnSegmentRecoveryReceiptRead> {
    const ref = segmentId === businessTurnId
      ? await initialRecoveryReceiptRef()
      : await segmentRecoveryReceiptRef(segmentId);
    return ref === null
      ? { status: 'unknown', reason: `no recovery receipt for segment ${segmentId}` }
      : { status: 'exact', recoveryAssetsReceiptRef: ref };
  }

  async function readSegmentCaptureExact(request: {
    readonly businessTurnId: string;
    readonly segmentId: string;
    readonly recoveryAssetsReceiptRef: string;
  }): Promise<ActiveTurnSegmentCaptureExactRead> {
    if (request.businessTurnId !== businessTurnId) {
      throw new RecoveryAssetsIntegrityError(`segment journal is bound to business turn ${businessTurnId}`);
    }
    const readback = await native.readSegmentRecoveryAssetsExact(request.recoveryAssetsReceiptRef);
    if (readback.receipt.businessTurnId !== request.businessTurnId || readback.receipt.segmentId !== request.segmentId) {
      throw new RecoveryAssetsIntegrityError('segment capture receipt does not match the requested business turn and segment');
    }
    const opened = await segmentJournal.readSegmentOpened(request.segmentId);
    if (opened === null) {
      throw new RecoveryAssetsIntegrityError(`segment is not opened: ${request.segmentId}`);
    }
    if (canonicalJsonStringify(opened.businessTurnRef) !== canonicalJsonStringify(readback.prepared.body.businessTurnRef)
      || canonicalJsonStringify(opened.binding) !== canonicalJsonStringify(readback.prepared.body.binding)
      || canonicalJsonStringify(opened.predecessor) !== canonicalJsonStringify(readback.prepared.body.predecessor)) {
      throw new RecoveryAssetsIntegrityError('segment capture does not match its committed segment-opened record');
    }
    const initial = await readInitialSegmentCapture(businessTurnId);
    if (initial === null) {
      throw new RecoveryAssetsIntegrityError('the original immutable v1 capture is missing');
    }
    if (canonicalJsonStringify(initial.body.initialInput) !== canonicalJsonStringify(readback.prepared.body.initialInput)) {
      throw new RecoveryAssetsIntegrityError('segment capture does not reference the original immutable input');
    }

    const completions: Array<ActiveTurnSegmentCaptureExactRead['completions'][number]> = [];
    if (readback.prepared.completionLookups.length > 0) {
      if (!completionJournal) {
        throw new RecoveryAssetsIntegrityError('segment recovery-assets completion journal is not configured');
      }
      for (const lookup of readback.prepared.completionLookups) {
        completions.push({ lookup, readback: await completionJournal.readExact(lookup) });
      }
    }
    return { receipt: readback.receipt, prepared: readback.prepared, completions };
  }

  async function readSegmentRecords(request: {
    readonly businessTurnId: string;
    readonly segmentId: string;
  }): Promise<readonly ActiveTurnSegmentJournalRecord[]> {
    return await segmentJournal.readSegmentRecords(request);
  }

  return {
    readInitialSegmentCapture,
    readSegments: async (requested) => await segmentJournal.readSegments(requested),
    readSegmentRecoveryReceipt,
    appendSegmentOpened: async (request) => await segmentJournal.appendSegmentOpened(request),
    appendSegmentRecord: async (request) => await segmentJournal.appendSegmentRecord(request),
    readSegmentRecords,
    readSegmentCaptureExact,
  };
}
