import type { Checkpoint, EvidenceRef, ScopeRef } from '../../../contracts/src/index.js';
import type { CheckpointClosureRecord, ClosureRecord } from './closure.js';

export type CheckpointChainVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string; readonly evidenceRef?: EvidenceRef };

export interface LatestCheckpointRecord {
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
}

export interface CheckpointAppendRequest {
  readonly ownerId: string;
  readonly commitId: string;
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
