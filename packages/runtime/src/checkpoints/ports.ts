import type {
  AdmittedTurnIdentity,
  CheckpointReceiptRelationshipV1,
  CheckpointTimeAuthority,
  Checkpoint,
  CheckpointClosureRecord as CoreCheckpointClosureRecord,
  ContextReplacement,
  ContextHistoryRecord,
  ContextLoopControl,
  ContextView,
  CycleId,
  EvidenceRef,
  JournalCommitRef,
  ScopeRef,
} from '../../../contracts/src/index.js';
import type { NativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
import type {
  AcceptedSemanticViewInputV2,
  AcceptedSemanticViewInputV1,
  CommittedSemanticCheckpoint,
  SemanticContextViewBodyV1,
  SemanticContextViewBodyV2,
  SemanticContextViewIdentityV1,
  SemanticHistoryExactLookupV1,
  SemanticHistoryPublicationBodyV1,
  SemanticHistoryPublicationBodyV2,
  SemanticHistoryPublicationIdentityV1,
  SemanticPhaseReceiptV1,
} from '../context/semantic-history.js';
import type { CheckpointClosureRecord, ClosureRecord } from './closure.js';
import type {
  ConditionalReentryPort,
  ConditionalReentryRecord,
  ConfirmedContextCorrectionCommand,
  ConfirmedReentryCommand,
  ContextCorrectionPort,
  ContextCorrectionRecord,
} from './conditional-reentry.js';

export type { ContextHistoryRecord, ContextLoopControl, JournalCommitRef };

export interface ContextHistoryReadQuery {
  readonly scope: ScopeRef;
  readonly agentRuntimeId?: string;
  readonly contextViewRef?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ContextHistoryReadResult {
  readonly views: readonly ContextView[];
  readonly replacements: readonly ContextReplacement[];
  readonly currentContextCommitRef: JournalCommitRef | null;
  readonly nextCursor?: string;
}

/**
 * Exact durable context history port. The producer prepares the record, commits it while
 * comparing the expected current context head under the Journal lock, then reads the exact
 * committed body back before installing any successor state.
 */
export interface ContextHistoryPort {
  commit(
    record: ContextHistoryRecord,
    expectedCurrentContextCommitRef: JournalCommitRef | null,
  ): Promise<JournalCommitRef>;
  readContextCommit(scope: ScopeRef, commitRef: JournalCommitRef): Promise<ContextHistoryRecord>;
  readContextHistory(query: ContextHistoryReadQuery): Promise<ContextHistoryReadResult>;
}

export interface CommittedCheckpointRecord {
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
  readonly commitRef: JournalCommitRef;
}

export interface CheckpointListQuery {
  readonly scope: ScopeRef;
  readonly cursor?: string;
  readonly limit: number;
  readonly directiveRevision?: number;
  readonly executionEpoch?: number;
  readonly cycleId?: CycleId;
  readonly occurrenceRef?: string;
}

export interface CheckpointListResult {
  readonly checkpoints: readonly CommittedCheckpointRecord[];
  readonly nextCursor?: string;
}

/** Authoritative execution position from typed committed control facts. */
export interface ExecutionPosition {
  readonly checkpointCommitRef: JournalCommitRef;
  readonly contextCommitRef: JournalCommitRef;
  readonly executionEpoch: number;
  readonly controlCommitRef: JournalCommitRef;
}

/**
 * One publication identity checked against committed conditional-reentry fences.
 * Context publication supplies `agentRuntimeId`; checkpoint publication may not
 * have one, so its scope and Harness execution epoch carry the exact bound fact.
 */
export interface ExecutionIncarnationRef {
  readonly scope: ScopeRef;
  readonly agentRuntimeId?: string;
  readonly executionEpoch: number;
}

/**
 * The Runtime-facing conditional reentry port. App owns the locked Journal
 * transaction and preparation; Runtime consumes this exact seam without
 * reimplementing record construction or locked reads.
 */
export interface ConditionalReentrySubmissionPort extends ConditionalReentryPort {
  prepare(command: ConfirmedReentryCommand): Promise<ConditionalReentryRecord>;
}

/** App-owned preparation over the same locked Journal and append-only carrier. */
export interface ContextCorrectionSubmissionPort extends ContextCorrectionPort {
  prepare(command: ConfirmedContextCorrectionCommand): Promise<ContextCorrectionRecord>;
}

/** Recovery binding written with a newly produced Runtime checkpoint closure. */
export interface CheckpointRecoveryBinding {
  readonly checkpointCommitRef: JournalCommitRef;
  readonly contextCommitRef: JournalCommitRef;
  readonly coreClosure: CoreCheckpointClosureRecord;
  /** Exact identity of the durable preparation in the existing closure port. */
  readonly preparationRef?: string;
  readonly turnRecoveryRef?: string;
  readonly turnClosureRef?: string;
  readonly alignmentRef?: string;
}

export type CheckpointChainVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string; readonly evidenceRef?: EvidenceRef };

export interface LatestCheckpointRecord {
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
  readonly recordDigest?: string;
}

export interface CheckpointAppendRequest {
  readonly ownerId: string;
  readonly commitId: string;
  readonly checkpoint: Checkpoint;
}

export interface CheckpointAppendReceipt {
  readonly checkpointId: Checkpoint['id'];
  readonly seq: number;
  readonly recordDigest?: string;
}

export interface CheckpointJournalPort {
  verify(scope: ScopeRef): Promise<CheckpointChainVerification>;
  readLatest(scope: ScopeRef): Promise<LatestCheckpointRecord | null>;
  append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt>;
  /** Exact committed checkpoint by identity. Never substitutes the latest checkpoint. */
  readCommitted(scope: ScopeRef, checkpointId: Checkpoint['id']): Promise<CommittedCheckpointRecord | null>;
  /** Verified committed entries. Every supplied filter is an independent AND predicate. */
  listCommitted(query: CheckpointListQuery): Promise<CheckpointListResult>;
  /** Authoritative execution position from typed committed control facts. */
  readExecutionPosition(taskScope: ScopeRef): Promise<ExecutionPosition | null>;
  /** Exact closure plus context/recovery/turn/alignment references for one checkpoint commit. */
  readCheckpointRecoveryBinding(
    scope: ScopeRef,
    checkpointCommitRef: JournalCommitRef,
  ): Promise<CheckpointRecoveryBinding | null>;
}

/**
 * Strict canonical reader seam over the same verified Journal. Ordinary
 * mutation-only ports keep implementing `CheckpointJournalPort`; A4.3 wires
 * readers through the App checkpoint journal factory that also returns this
 * subtype.
 */
export interface CheckpointJournalReaderPort extends CheckpointJournalPort {
  /** Exact committed checkpoint by identity. Never substitutes the latest checkpoint. */
  readCommitted(scope: ScopeRef, checkpointId: Checkpoint['id']): Promise<CommittedCheckpointRecord | null>;
  /** Verified committed entries. Every supplied filter is an independent AND predicate. */
  listCommitted(query: CheckpointListQuery): Promise<CheckpointListResult>;
  /** Authoritative execution position from typed committed control facts. */
  readExecutionPosition(taskScope: ScopeRef): Promise<ExecutionPosition | null>;
  /** Exact closure plus context/recovery/turn/alignment references for one checkpoint commit. */
  readCheckpointRecoveryBinding(
    scope: ScopeRef,
    checkpointCommitRef: JournalCommitRef,
  ): Promise<CheckpointRecoveryBinding | null>;
}

export interface NativeCheckpointCommitRequest {
  readonly ownerId: string;
  readonly checkpoint: Checkpoint;
  readonly timeAuthority: CheckpointTimeAuthority;
}

export interface NativeCheckpointJournalPort extends CheckpointJournalPort {
  commitNativeCheckpoint(input: NativeCheckpointCommitRequest): Promise<CheckpointReceiptRelationshipV1>;
  readNativeCheckpoint(input: {
    readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
  }): Promise<CheckpointReceiptRelationshipV1 | null>;
}

export interface SemanticContextViewCommitRequest {
  readonly ownerId: string;
  readonly accepted: AcceptedSemanticViewInputV1;
}

export interface SemanticContextViewCommitRequestV2 {
  readonly ownerId: string;
  readonly accepted: AcceptedSemanticViewInputV2;
}

export interface SemanticHistoryPublicationCommitRequest {
  readonly ownerId: string;
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly contextView: {
    readonly identity: SemanticContextViewIdentityV1;
    readonly receipt: SemanticPhaseReceiptV1;
  };
}

export interface SemanticHistoryPublicationCommitRequestV2 {
  readonly ownerId: string;
  readonly turn: AdmittedTurnIdentity;
  readonly segment: NativeSegmentSaveSourceV2;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly contextView: {
    readonly identity: SemanticContextViewIdentityV1;
    readonly receipt: SemanticPhaseReceiptV1;
  };
}

/** Physical persistence belongs to App; exact reads never select latest. */
export interface SemanticHistoryPersistencePort {
  commitContextView(input: SemanticContextViewCommitRequest): Promise<SemanticPhaseReceiptV1>;
  commitContextViewV2?(input: SemanticContextViewCommitRequestV2): Promise<SemanticPhaseReceiptV1>;
  commitHistoryPublication(input: SemanticHistoryPublicationCommitRequest): Promise<SemanticPhaseReceiptV1>;
  commitHistoryPublicationV2?(input: SemanticHistoryPublicationCommitRequestV2): Promise<SemanticPhaseReceiptV1>;
  readContextView(input: {
    readonly scope: ScopeRef;
    readonly contextViewReceiptRef: string;
  }): Promise<SemanticContextViewBodyV1 | SemanticContextViewBodyV2 | null>;
  readContextViewByIdentity?(input: {
    readonly scope: ScopeRef;
    readonly identity: SemanticContextViewIdentityV1;
  }): Promise<SemanticContextViewBodyV1 | SemanticContextViewBodyV2 | null>;
  readHistoryPublicationByIdentity?(input: {
    readonly scope: ScopeRef;
    readonly identity: SemanticHistoryPublicationIdentityV1;
  }): Promise<SemanticHistoryPublicationBodyV1 | SemanticHistoryPublicationBodyV2 | null>;
  readCommittedSemanticCheckpoint(input: SemanticHistoryExactLookupV1): Promise<CommittedSemanticCheckpoint | null>;
}

export interface CheckpointClosurePort {
  /** Preparation has an explicit scope; its checkpoint need not exist yet. */
  commit(input: ClosureRecord): Promise<{ readonly closureId: string; readonly committed: true }>;
  read(closureId: string): Promise<ClosureRecord | null>;
}

export interface CheckpointReentryAdmissionInput {
  readonly ownerId: string;
  readonly checkpoint: Checkpoint;
  readonly closure: CheckpointClosureRecord;
  readonly previousExecutionEpoch: number;
  readonly newExecutionEpoch: number;
}

export interface CheckpointReentryAdmissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly blockedBy?: readonly string[];
}

export interface CheckpointReentryAdmissionPort {
  admit(input: CheckpointReentryAdmissionInput): Promise<CheckpointReentryAdmissionDecision>;
}
