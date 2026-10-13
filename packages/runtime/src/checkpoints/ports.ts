import type {
  AdmittedTurnIdentity,
  Checkpoint,
  CheckpointReceiptRelationshipV1,
  CheckpointTimeAuthority,
  EvidenceRef,
  ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  AcceptedSemanticViewInputV1,
  CommittedSemanticCheckpointV1,
  SemanticContextViewBodyV1,
  SemanticContextViewIdentityV1,
  SemanticHistoryExactLookupV1,
  SemanticPhaseReceiptV1,
} from '../context/semantic-history.js';
import type { CheckpointClosureRecord, ClosureRecord } from './closure.js';

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
}

export interface NativeCheckpointCommitRequest {
  readonly ownerId: string;
  readonly checkpoint: Checkpoint;
  readonly timeAuthority: CheckpointTimeAuthority;
}

export interface NativeCheckpointJournalPort extends CheckpointJournalPort {
  commitNativeCheckpoint(
    input: NativeCheckpointCommitRequest,
  ): Promise<CheckpointReceiptRelationshipV1>;

  readNativeCheckpoint(input: {
    readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
  }): Promise<CheckpointReceiptRelationshipV1 | null>;
}

export interface CheckpointClosurePort {
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

export interface SemanticContextViewCommitRequest {
  readonly ownerId: string;
  readonly accepted: AcceptedSemanticViewInputV1;
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

/**
 * Durable persistence seam for the two semantic-history phases. The Runtime
 * owns the accepted-view gate and the phase relationship checks. The App owns
 * the immutable asset store, the Organ Journal append and the actual receipt
 * reconstruction. `readCommittedSemanticCheckpoint` is the exact cold-read
 * entry D consumes; `null` means the exact publication does not exist.
 */
export interface SemanticHistoryPersistencePort {
  commitContextView(input: SemanticContextViewCommitRequest): Promise<SemanticPhaseReceiptV1>;
  commitHistoryPublication(input: SemanticHistoryPublicationCommitRequest): Promise<SemanticPhaseReceiptV1>;
  readContextView(input: {
    readonly scope: ScopeRef;
    readonly contextViewReceiptRef: string;
  }): Promise<SemanticContextViewBodyV1 | null>;
  readCommittedSemanticCheckpoint(
    input: SemanticHistoryExactLookupV1,
  ): Promise<CommittedSemanticCheckpointV1 | null>;
}
