import { canonicalJsonStringify } from '../../../contracts/src/index.js';
import { validateJournalCommitRef, type JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type { NativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
import { validateNativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
import type {
  AdmittedTurnIdentity,
  Checkpoint,
  CheckpointTimeAuthorityMetadata,
  DurablePhaseOutcome,
  EvidenceRef,
  RecoveryHoldFacts,
} from '../../../contracts/src/index.js';

import {
  projectAdmittedTurnIdentityV1,
  type AcceptedSemanticViewInputV1,
  type AdoptedChildSourceV1,
  type FourPartSemanticViewV1,
  type SemanticHistoryExactLookupV1,
  type SemanticHistoryKeyInputV1,
  type SemanticHistoryRecoveryV1,
  type SemanticViewAcceptanceV1,
} from '../context/semantic-history.js';

export type { NativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';

/** The five durable native save phases, in their only valid execution order. */
export const NATIVE_SAVE_PHASES = [
  'recovery-assets',
  'checkpoint',
  'closure',
  'context-view',
  'history-publication',
] as const;

export type NativeSavePhase = (typeof NATIVE_SAVE_PHASES)[number];

/**
 * Exact identity of one v1 native save. A save is recovered by this key alone;
 * no latest-window selection is allowed. It carries no `version` field so the
 * existing v1 records and readers keep their original bytes and semantics.
 */
export interface NativeSaveKeyV1 {
  readonly turn: AdmittedTurnIdentity;
  readonly boundaryId: string;
  readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
}

/**
 * Exact identity of one resumed-segment native save. It adds the explicit
 * version-2 segment discriminator so two segments of the same original
 * business turn stay distinct even when they share a boundary string. The
 * original turn identity stays the immutable admission; the segment carries
 * only its id and the actual opened commit receipt.
 */
export interface NativeSegmentSaveKeyV2 {
  readonly version: 2;
  readonly turn: AdmittedTurnIdentity;
  readonly segment: {
    readonly segmentId: string;
    readonly openedCommitRef: JournalCommitRef;
  };
  readonly boundaryId: string;
  readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
}

export type NativeSaveKey = NativeSaveKeyV1 | NativeSegmentSaveKeyV2;

export type NativeSaveDigest = `sha256:${string}`;

/** Fields every native save intent fixes before phase work starts. */
interface NativeSaveIntentCommon {
  readonly ownerId: string;
  readonly recoveryResponsibilityRef: RecoveryHoldFacts['recoveryResponsibilityRef'];
  readonly inputIntentDigest: string;
  readonly unresolvedOperationRefs: RecoveryHoldFacts['unresolvedOperationRefs'];
  readonly rawTurnRefs: RecoveryHoldFacts['rawTurnRefs'];
  readonly firstErrorRef?: RecoveryHoldFacts['firstErrorRef'];
  readonly laterErrorRefs: RecoveryHoldFacts['laterErrorRefs'];
}

/**
 * Control record persisted before v1 phase work starts. It fixes the turn,
 * boundary, checkpoint, owner, recovery responsibility and input intent so a
 * retry cannot mint a new identity from current time or current state.
 */
export interface NativeSaveIntentV1 extends NativeSaveIntentCommon {
  readonly key: NativeSaveKeyV1;
  readonly recoveryAssets: NativeRecoveryAssetsSelectors;
  readonly checkpoint: NativeCheckpointSelectors;
  readonly closure: NativeClosureSelectors;
  readonly contextView: NativeContextViewSelectors;
  readonly historyPublication: NativeHistoryPublicationSelectors;
}

/**
 * Control record persisted before resumed-segment phase work starts. It carries
 * the actual source bundle A read from the Journal, and only the inputs that
 * already exist before the save. The context-view and history-publication
 * selectors derive from this key plus actual prior-phase readbacks; no future
 * checkpoint relationship, publication receipt or progress sequence is fixed
 * here.
 */
export interface NativeSegmentSaveIntentV2 extends NativeSaveIntentCommon {
  readonly key: NativeSegmentSaveKeyV2;
  readonly source: NativeSegmentSaveSourceV2;
  readonly recoveryAssets: NativeSegmentRecoveryAssetsSelectorsV2;
  readonly checkpoint: NativeCheckpointSelectors;
  readonly closure: NativeClosureSelectors;
  readonly contextView: NativeSegmentContextViewSelectorsV2;
}

export type NativeSaveIntent = NativeSaveIntentV1 | NativeSegmentSaveIntentV2;

export function isNativeSegmentSaveIntentV2(intent: NativeSaveIntent): intent is NativeSegmentSaveIntentV2 {
  return 'version' in intent.key && intent.key.version === 2;
}

/**
 * Resumed-segment recovery-assets input. It points at the canonical source
 * bundle and the current producer cut; it never copies grant, permission or
 * registration truth.
 */
export interface NativeSegmentRecoveryAssetsSelectorsV2 {
  readonly source: NativeSegmentSaveSourceV2;
  readonly boundaryId: string;
  /** Actual producer cut selector owned by the capture producer, not a mirror. */
  readonly captureRef: string;
}

/**
 * Resumed-segment context-view input. It fixes only pre-save semantic inputs.
 * A reads the actual checkpoint relationship during the phase and then builds
 * the version-2 accepted view; the relationship is never pre-created here.
 */
export interface NativeSegmentContextViewSelectorsV2 {
  readonly source: NativeSegmentSaveSourceV2;
  readonly acceptance: SemanticViewAcceptanceV1;
  readonly semantics: FourPartSemanticViewV1;
  readonly adoptedChildren: readonly AdoptedChildSourceV1[];
  readonly recovery: SemanticHistoryRecoveryV1;
}

export interface NativeRecoveryAssetsSelectors {
  readonly turnId: string;
  readonly boundaryId: string;
  /** Actual producer cut selector owned by the capture producer, not a mirror. */
  readonly captureRef: string;
}

export interface NativeCheckpointSelectors {
  readonly checkpoint: Checkpoint;
  readonly timeAuthority: CheckpointTimeAuthorityMetadata;
  readonly previousCheckpointId: Checkpoint['previousCheckpointId'];
  readonly acceptedAt: string;
}

export interface NativeClosureSelectors {
  readonly closureId: string;
  readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
  readonly source: 'agent-tool' | 'harness-control' | 'recovery';
  readonly closureSummary: string;
  readonly closureEvidenceRefs: readonly EvidenceRef[];
}

export interface NativeContextViewSelectors {
  readonly key: SemanticHistoryKeyInputV1;
  readonly accepted: AcceptedSemanticViewInputV1;
}

export interface NativeHistoryPublicationSelectors {
  readonly key: SemanticHistoryKeyInputV1;
  readonly exactLookup: SemanticHistoryExactLookupV1;
}

/**
 * Durable progress projection of one native save. It records which phases are
 * committed and the original recovery responsibility; it is never a second
 * source of phase truth.
 */
export interface NativeSaveProgress {
  readonly intentCommitRef: JournalCommitRef;
  readonly key: NativeSaveKey;
  readonly intentDigest: string;
  readonly phases: readonly DurablePhaseOutcome[];
  readonly firstErrorRef?: string;
  readonly laterErrorRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
}

export type NativeSaveProgressReadback =
  | { readonly state: 'found'; readonly progress: NativeSaveProgress }
  | { readonly state: 'absent'; readonly verifiedThrough: JournalCommitRef | null }
  | { readonly state: 'unknown'; readonly recoveryRef: string };

/**
 * Progress persistence boundary. `absent` must be a verified exact absence;
 * an unreadable or corrupt progress record is `unknown`.
 */
export interface NativeSaveProgressPort {
  begin(intent: NativeSaveIntent): Promise<JournalCommitRef>;

  readExact(key: NativeSaveKey): Promise<NativeSaveProgressReadback>;

  recordProgress(progress: NativeSaveProgress): Promise<JournalCommitRef>;
}

export interface NativeSavePhaseReceipt {
  readonly phase: NativeSavePhase;
  readonly commitIdentity: string;
  readonly journalReceiptRef: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
  readonly committedAt: string;
  readonly intentDigest: string;
  readonly timeAuthority: CheckpointTimeAuthorityMetadata;
}

/**
 * One typed phase endpoint. Each stage owner implements commit and an exact
 * readback keyed by the same native save intent; a readback must never fall
 * back to the latest record.
 */
export interface NativeSaveStagePort {
  commit(input: NativeSaveIntent): Promise<NativeSavePhaseReceipt>;

  readExact(input: NativeSaveIntent): Promise<NativeSavePhaseReceipt | null>;
}

export type NativeSavePorts = { readonly [Phase in NativeSavePhase]: NativeSaveStagePort };

function scopeTuple(scope: Checkpoint['scope']): readonly (string | null)[] {
  return [
    scope.organId.value,
    scope.taskId?.value ?? null,
    scope.cycleId?.value ?? null,
    scope.operationId?.value ?? null,
  ];
}

function journalCommitRefTuple(ref: JournalCommitRef): readonly unknown[] {
  return [ref.commitId, ref.journalSeq, ref.recordDigest];
}

function admittedTurnIdentityTuple(turn: AdmittedTurnIdentity): readonly unknown[] {
  return [
    turn.turnId,
    turn.workAssignmentRef,
    [turn.taskRef.scope, turn.taskRef.value],
    scopeTuple(turn.scopeRef),
    [turn.cycleRef.scope, turn.cycleRef.value],
    turn.inputRevision,
    turn.directiveRevision,
    turn.executionEpoch,
    turn.runtimeBindingRef,
    turn.permissionRevision,
  ];
}

function checkpointRefTuple(checkpoint: Pick<Checkpoint, 'id' | 'scope'>): readonly unknown[] {
  return [checkpoint.id.scope, checkpoint.id.value, scopeTuple(checkpoint.scope)];
}

function nativeSegmentSaveKeyTupleV2(key: NativeSegmentSaveKeyV2): readonly unknown[] {
  return [
    'humanagent.native-segment-save-key.v2',
    admittedTurnIdentityTuple(key.turn),
    key.segment.segmentId,
    journalCommitRefTuple(key.segment.openedCommitRef),
    key.boundaryId,
    checkpointRefTuple(key.checkpoint),
  ];
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assertNativeSegmentSaveKeyV2(key: NativeSegmentSaveKeyV2): void {
  if (key.version !== 2) throw new Error('native segment save key version must be 2');
  if (typeof key.segment.segmentId !== 'string' || !key.segment.segmentId.trim()) {
    throw new Error('native segment save key requires a segment id');
  }
  validateJournalCommitRef(key.segment.openedCommitRef);
  if (typeof key.boundaryId !== 'string' || !key.boundaryId.trim()) {
    throw new Error('native segment save key requires a boundary id');
  }
}

/**
 * The one canonical v2 key encoder. A reuses this hash for the intent commit
 * identity and the phase adapter slot; no second concatenation lives in App.
 */
export async function nativeSegmentSaveKeyDigestV2(key: NativeSegmentSaveKeyV2): Promise<NativeSaveDigest> {
  assertNativeSegmentSaveKeyV2(key);
  return `sha256:${await sha256Hex(canonicalJsonStringify(nativeSegmentSaveKeyTupleV2(key)))}`;
}

/** Deterministic phase adapter slot derived from the same canonical key. */
export async function nativeSegmentSavePhaseSlotV2(
  key: NativeSegmentSaveKeyV2,
  phase: NativeSavePhase,
): Promise<readonly [string, NativeSaveDigest, NativeSavePhase]> {
  return ['native-save-phase/v2', await nativeSegmentSaveKeyDigestV2(key), phase];
}

/**
 * Pre-write guard for one resumed-segment save. It rejects a key/source or
 * checkpoint mismatch before any progress or phase record is written. It never
 * repairs or widens the input.
 */
export function assertNativeSegmentSaveIntentV2(intent: NativeSegmentSaveIntentV2): void {
  assertNativeSegmentSaveKeyV2(intent.key);
  validateNativeSegmentSaveSourceV2(intent.source);
  const source = intent.source;
  const turn = projectAdmittedTurnIdentityV1(source.originalAdmittedTurn);
  if (canonicalJsonStringify(turn) !== canonicalJsonStringify(intent.key.turn)) {
    throw new Error('native segment save key turn does not match the source admission');
  }
  if (intent.key.segment.segmentId !== source.opened.segmentId) {
    throw new Error('native segment save key segment does not match the source opened record');
  }
  if (canonicalJsonStringify(intent.key.segment.openedCommitRef) !== canonicalJsonStringify(source.openedCommitRef)) {
    throw new Error('native segment save key opened commit does not match the source opened commit');
  }
  if (intent.recoveryAssets.boundaryId !== intent.key.boundaryId) {
    throw new Error('native segment save recovery-assets boundary does not match the save key');
  }
  if (intent.checkpoint.checkpoint.executionEpoch !== source.opened.binding.execution.executionEpoch) {
    throw new Error('native segment save checkpoint epoch does not match the current segment epoch');
  }
  if (canonicalJsonStringify(intent.checkpoint.checkpoint.scope) !== canonicalJsonStringify(turn.scopeRef)) {
    throw new Error('native segment save checkpoint scope does not match the source admission');
  }
  if (canonicalJsonStringify(intent.key.checkpoint) !== canonicalJsonStringify({
    id: intent.checkpoint.checkpoint.id,
    scope: intent.checkpoint.checkpoint.scope,
  })) {
    throw new Error('native segment save key checkpoint does not match the checkpoint selectors');
  }
  if (intent.closure.checkpoint.id.value !== intent.key.checkpoint.id.value
    || canonicalJsonStringify(intent.closure.checkpoint.scope) !== canonicalJsonStringify(intent.key.checkpoint.scope)) {
    throw new Error('native segment save closure checkpoint does not match the save key');
  }
}

/** Validate one native save intent before any phase work runs. */
export function assertNativeSaveIntent(intent: NativeSaveIntent): void {
  if (isNativeSegmentSaveIntentV2(intent)) assertNativeSegmentSaveIntentV2(intent);
}

/**
 * The one canonical v2 intent digest. It fixes only pre-save inputs: the key,
 * the actual source bundle, the selectors and the recovery responsibility. It
 * excludes every future phase receipt, progress sequence and re-sampled time.
 */
export async function nativeSegmentSaveIntentDigestV2(
  intent: NativeSegmentSaveIntentV2,
): Promise<NativeSaveDigest> {
  assertNativeSegmentSaveIntentV2(intent);
  const tuple = [
    'humanagent.native-segment-save-intent.v2',
    nativeSegmentSaveKeyTupleV2(intent.key),
    intent.source,
    intent.recoveryAssets,
    intent.checkpoint,
    intent.closure,
    intent.contextView,
    [
      intent.ownerId,
      intent.recoveryResponsibilityRef,
      intent.unresolvedOperationRefs,
      intent.rawTurnRefs,
      intent.firstErrorRef ?? null,
      intent.laterErrorRefs,
    ],
  ];
  return `sha256:${await sha256Hex(canonicalJsonStringify(tuple))}`;
}
