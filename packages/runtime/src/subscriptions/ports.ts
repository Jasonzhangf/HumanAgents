// Minimum public occurrence-consumer contract.
//
// The scheduler owns the persisted claim and supplies the validated record.
// The app-owned consumer owns admission, dispatch-once, checkpoint/receipt
// durability, and restart replay. This file is only the shared typed boundary.
import type {
  ExecutionPolicyDefinition,
  Occurrence,
  OccurrenceClaim,
  OperationId,
  ServeTaskTerminalReceipt,
  TaskId,
} from '../../../contracts/src/index.js';

export interface OccurrenceClaimRecord extends OccurrenceClaim {
  readonly policyRevision: number;
  readonly policyHash: string;
  readonly policy: ExecutionPolicyDefinition;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly inputArtifactDigest: string;
}

export interface ServeTaskConsumerPort {
  executeOccurrence(input: {
    readonly occurrence: Occurrence;
    readonly policy: ExecutionPolicyDefinition;
    readonly claim: OccurrenceClaimRecord;
  }): Promise<ServeTaskTerminalReceipt>;
}
