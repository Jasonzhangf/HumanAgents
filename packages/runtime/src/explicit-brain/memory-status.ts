import type {
  MemoryBoundaryWakeup,
  MemoryOperationRequestedEvent,
  MemoryOperationState,
  MemoryOperationStatus,
  OperationId,
} from '../../../contracts/src/index.js';
import { MEMORY_BOUNDARY_WAKEUPS, validateMemoryOperationStatus } from '../../../contracts/src/index.js';
import { stableIdentity } from './idempotency.js';

export class MemoryOperationProjectionError extends Error {
  readonly code: 'unknown-operation' | 'invalid-boundary' | 'accepted-not-applied' | 'duplicate-submission';

  constructor(code: MemoryOperationProjectionError['code'], message: string) {
    super(message);
    this.name = 'MemoryOperationProjectionError';
    this.code = code;
  }
}

export interface MemoryOperationRecord extends MemoryOperationStatus {
  readonly sourceRefs: readonly string[];
  readonly requestedOutputs: readonly string[];
  readonly boundary: MemoryBoundaryWakeup;
}

export interface MemoryWakeupDecision {
  readonly wake: boolean;
  readonly reason: 'boundary' | 'not-boundary';
  readonly boundary: MemoryBoundaryWakeup;
  readonly operationId: OperationId;
}

const BOUNDARY_BY_TRIGGER: Readonly<Record<MemoryOperationRequestedEvent['trigger'], MemoryBoundaryWakeup>> = {
  'human-correction': 'explicit-memory-submission',
  'human-emotion': 'explicit-memory-submission',
  'explicit-memory-request': 'explicit-memory-submission',
  'skill-revision-request': 'explicit-memory-submission',
  'process-feedback': 'explicit-memory-submission',
  rewind: 'checkpoint-rewind',
  'task-completion': 'task-cycle-completion',
  'attention-blocked': 'blocked-attention',
};

export class MemoryOperationProjection {
  private readonly operations = new Map<string, MemoryOperationRecord>();
  private readonly submissions = new Map<string, {
    readonly inputIdentity: string;
    readonly record: MemoryOperationRecord;
  }>();

  acceptSubmission(input: {
    readonly submissionId: string;
    readonly operationId: OperationId;
    readonly event: MemoryOperationRequestedEvent;
  }): MemoryOperationRecord {
    const existing = this.submissions.get(input.submissionId);
    if (existing) {
      if (existing.inputIdentity !== stableIdentity(input)) {
        throw new MemoryOperationProjectionError(
          'duplicate-submission',
          `memory submission id was reused with different content: ${input.submissionId}`,
        );
      }
      return existing.record;
    }
    if (BOUNDARY_BY_TRIGGER[input.event.trigger] !== input.event.boundary) {
      throw new MemoryOperationProjectionError('invalid-boundary', 'memory operation trigger does not match its boundary');
    }
    const record: MemoryOperationRecord = {
      operationId: input.operationId,
      state: 'accepted',
      nextAction: 'wait-analysis',
      resultRefs: [],
      attentionRefs: [],
      sourceRefs: [...input.event.sourceRefs],
      requestedOutputs: [...input.event.requestedOutputs],
      boundary: input.event.boundary,
    };
    this.operations.set(input.operationId.value, record);
    this.submissions.set(input.submissionId, {
      inputIdentity: stableIdentity(input),
      record,
    });
    return record;
  }

  transition(input: {
    readonly operationId: OperationId;
    readonly state: MemoryOperationState;
    readonly nextAction: string;
    readonly resultRefs?: readonly string[];
    readonly attentionRefs?: readonly string[];
  }): MemoryOperationRecord {
    const existing = this.operations.get(input.operationId.value);
    if (!existing) throw new MemoryOperationProjectionError('unknown-operation', `memory operation not found: ${input.operationId.value}`);
    const updated: MemoryOperationRecord = {
      ...existing,
      state: input.state,
      nextAction: input.nextAction,
      resultRefs: input.resultRefs ? [...input.resultRefs] : existing.resultRefs,
      attentionRefs: input.attentionRefs ? [...input.attentionRefs] : existing.attentionRefs,
    };
    this.operations.set(input.operationId.value, updated);
    return updated;
  }

  status(operationId: OperationId): MemoryOperationStatus {
    const record = this.operations.get(operationId.value);
    if (!record) throw new MemoryOperationProjectionError('unknown-operation', `memory operation not found: ${operationId.value}`);
    const projection: MemoryOperationStatus = {
      operationId: record.operationId,
      state: record.state,
      nextAction: record.nextAction,
      resultRefs: [...record.resultRefs],
      attentionRefs: [...record.attentionRefs],
    };
    validateMemoryOperationStatus(projection);
    return projection;
  }

  replyState(operationId: OperationId): string {
    const status = this.status(operationId);
    return status.state === 'accepted' ? 'accepted; analysis has not been applied' : status.state;
  }

  wakeup(event: MemoryOperationRequestedEvent): MemoryWakeupDecision {
    if (!MEMORY_BOUNDARY_WAKEUPS.includes(event.boundary)) {
      throw new MemoryOperationProjectionError('invalid-boundary', `unknown memory boundary: ${event.boundary}`);
    }
    return {
      wake: true,
      reason: 'boundary',
      boundary: event.boundary,
      operationId: event.operationId,
    };
  }

  isBoundaryWakeup(event: MemoryOperationRequestedEvent): boolean {
    return BOUNDARY_BY_TRIGGER[event.trigger] === event.boundary
      && MEMORY_BOUNDARY_WAKEUPS.includes(event.boundary);
  }
}
