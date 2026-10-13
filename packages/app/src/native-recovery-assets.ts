import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  validatePreparedRecoveryCapture,
  type ActiveTurnCaptureBody,
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
  ImmutableAssetStore,
  evidenceReference,
} from '../../adapters/filesystem/src/index.js';
import {
  JsonlOrganJournal,
  type JournalRecord,
} from '../../adapters/jsonl/src/index.js';
import { JsonlOperationCompletionJournal } from '../../adapters/jsonl/src/operation-completion.js';
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
const RECOVERY_ASSETS_DOMAIN = 'humanagent.recovery-assets.v1';
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

function collectReferencedAssets(capture: ActiveTurnCaptureBody): readonly EvidenceRef[] {
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

  return { writeInitialInput, commitCapturePhase, readRecoveryAssetsExact };
}
