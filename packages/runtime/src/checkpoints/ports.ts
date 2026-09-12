import type { Checkpoint, EvidenceRef, ScopeRef } from '../../../contracts/src/index.js';

export type CheckpointChainVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string; readonly evidenceRef?: EvidenceRef };

export interface LatestCheckpointRecord {
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
}

export interface CheckpointAppendRequest {
  readonly ownerId: string;
  readonly checkpoint: Checkpoint;
}

export interface CheckpointAppendReceipt {
  readonly checkpointId: Checkpoint['id'];
  readonly seq: number;
}

export interface CheckpointJournalPort {
  verify(scope: ScopeRef): Promise<CheckpointChainVerification>;
  readLatest(scope: ScopeRef): Promise<LatestCheckpointRecord | null>;
  append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt>;
}
