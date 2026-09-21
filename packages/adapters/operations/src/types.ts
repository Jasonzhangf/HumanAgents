import type {
  ArtifactRef,
  EvidenceRef,
  OperationFailure,
  OperationId,
  OperationIntent,
  OperationResult,
  Scope,
} from '../../../contracts/src/index.js';
import type { OperationStopSettlementReceipt, OperationStopSettlementRequest } from '../../../runtime/src/gateway/ports.js';

export interface OperationExecutionRequest {
  readonly intent: OperationIntent;
  readonly effectiveScope: Scope;
  readonly executionEpoch: number;
}

export interface OperationExecutionObservation {
  readonly operationId: OperationId;
  readonly outputRef?: ArtifactRef;
  readonly outputDigest?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface OperationExecutorPort {
  execute(input: OperationExecutionRequest): Promise<OperationExecutionObservation>;
}

export interface OperationVerificationRequest {
  readonly intent: OperationIntent;
  readonly effectiveScope: Scope;
  readonly observation: OperationExecutionObservation;
}

export interface OperationVerifierPort {
  verify(input: OperationVerificationRequest): Promise<OperationResult>;
}

export interface CancellableOperationRoute {
  stop(input: OperationStopSettlementRequest): Promise<OperationStopSettlementReceipt>;
}

export interface LegacyInternalExecutionContext {
  readonly entryId: string;
  readonly operationId: OperationId;
  readonly scope: Scope;
  readonly inputRef: ArtifactRef;
}

export interface LegacyInternalExecutionResult {
  readonly outputRef?: ArtifactRef;
  readonly outputDigest?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface LegacyInternalToolEntry {
  readonly entryId: string;
  execute(context: LegacyInternalExecutionContext): Promise<LegacyInternalExecutionResult | unknown>;
}

export type OperationFailureValue = OperationFailure;
