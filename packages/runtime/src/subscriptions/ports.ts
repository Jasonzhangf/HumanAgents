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
  OccurrenceTaskBinding,
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

// Execute-or-resume contract. The consumer owns one business execution per
// immutable `OccurrenceTaskBinding`; duplicate, concurrent, and restart calls
// must return or recover the same `ServeTaskTerminalReceipt` instead of
// dispatching a second execution.
export interface ServeTaskConsumerPort {
  // True when this consumer owns durable admission and first-admission lease
  // authority. The scheduler must not duplicate that admission check before the
  // consumer can read a committed receipt or prove committed replacement recovery.
  readonly ownsFirstAdmissionAuthority?: boolean;

  executeOccurrence(input: {
    readonly occurrence: Occurrence;
    readonly policy: ExecutionPolicyDefinition;
    readonly claim: OccurrenceClaimRecord;
    readonly binding: OccurrenceTaskBinding;
  }): Promise<ServeTaskTerminalReceipt>;
}
