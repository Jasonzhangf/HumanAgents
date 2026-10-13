import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type {
  AdmittedTurnIdentity,
  Checkpoint,
  CheckpointTimeAuthorityMetadata,
  DurablePhaseOutcome,
  EvidenceRef,
  RecoveryHoldFacts,
} from '../../../contracts/src/index.js';

import type {
  AcceptedSemanticViewInputV1,
  SemanticHistoryExactLookupV1,
  SemanticHistoryKeyInputV1,
} from '../context/semantic-history.js';

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
 * Exact identity of one native save. A save is recovered by this key alone; no
 * latest-window selection is allowed.
 */
export interface NativeSaveKey {
  readonly turn: AdmittedTurnIdentity;
  readonly boundaryId: string;
  readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
}

/**
 * Control record persisted before phase work starts. It fixes the turn,
 * boundary, checkpoint, owner, recovery responsibility and input intent so a
 * retry cannot mint a new identity from current time or current state.
 */
export interface NativeSaveIntent {
  readonly key: NativeSaveKey;
  readonly ownerId: string;
  readonly recoveryResponsibilityRef: RecoveryHoldFacts['recoveryResponsibilityRef'];
  readonly inputIntentDigest: string;
  readonly unresolvedOperationRefs: RecoveryHoldFacts['unresolvedOperationRefs'];
  readonly rawTurnRefs: RecoveryHoldFacts['rawTurnRefs'];
  readonly firstErrorRef?: RecoveryHoldFacts['firstErrorRef'];
  readonly laterErrorRefs: RecoveryHoldFacts['laterErrorRefs'];
  readonly recoveryAssets: NativeRecoveryAssetsSelectors;
  readonly checkpoint: NativeCheckpointSelectors;
  readonly closure: NativeClosureSelectors;
  readonly contextView: NativeContextViewSelectors;
  readonly historyPublication: NativeHistoryPublicationSelectors;
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
