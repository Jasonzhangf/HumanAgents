import {
  assertBusinessPayload,
  validateRequirementEnvelope,
  type RequirementEnvelope,
} from '../../../../packages/contracts/src/index.js';
import { AdmissionError } from './errors.js';
import {
  ADMISSION_QUEUE_KINDS,
  type AdmissionCheckInput,
  type AdmissionDecision,
  type AdmissionQueueConfig,
  type AdmissionQueueKind,
  type ClassifiedRequirement,
  type QueueLoadSnapshot,
  type TaskRevision,
  type TaskRevisionState,
  type TaskUpdateStatus,
  type TaskUpdateDecision,
} from './types.js';

const DEFAULT_OWNER_ID = 'runtime-coordinator';

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AdmissionError(`${label} must be a non-negative safe integer`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new AdmissionError(`${label} is required`);
}

function assertQueueRegistered(queue: AdmissionQueueKind, registeredQueues: readonly AdmissionQueueKind[]): void {
  if (!ADMISSION_QUEUE_KINDS.includes(queue) || !registeredQueues.includes(queue)) {
    throw new AdmissionError(`admission queue is not registered: ${queue}`);
  }
}

export function validateQueueConfig(config: AdmissionQueueConfig): void {
  assertQueueRegistered(config.kind, ADMISSION_QUEUE_KINDS);
  assertNonNegativeSafeInteger(config.concurrencyLimit, 'queue concurrency limit');
  assertNonNegativeSafeInteger(config.maxBacklog, 'queue max backlog');
}

export function validateQueueLoad(load: QueueLoadSnapshot): void {
  assertNonNegativeSafeInteger(load.running, 'queue running count');
  assertNonNegativeSafeInteger(load.queued, 'queue queued count');
}

export function classifyRequirement(input: {
  readonly envelope: RequirementEnvelope;
  readonly queue: AdmissionQueueKind;
  readonly registeredQueues: readonly AdmissionQueueKind[];
}): ClassifiedRequirement {
  validateRequirementEnvelope(input.envelope);
  assertQueueRegistered(input.queue, input.registeredQueues);
  return { envelope: input.envelope, queue: input.queue };
}

function waiting(
  queue: AdmissionQueueKind,
  ownerId: string,
  condition: string,
  reason: string,
): AdmissionDecision {
  return {
    status: 'waiting',
    queue,
    ownerId,
    condition,
    nextAction: { kind: 'wait', ref: condition },
    reason,
  };
}

function blocked(
  queue: AdmissionQueueKind,
  ownerId: string,
  condition: string,
  reason: string,
): AdmissionDecision {
  return {
    status: 'blocked',
    queue,
    ownerId,
    condition,
    nextAction: { kind: 'recover', ref: condition },
    reason,
  };
}

export function checkAdmission(input: AdmissionCheckInput): AdmissionDecision {
  validateQueueConfig(input.queue);
  validateQueueLoad(input.queueLoad);
  if (input.businessPayload) assertBusinessPayload(input.businessPayload);

  const ownerId = input.ownerId ?? DEFAULT_OWNER_ID;
  assertNonEmpty(ownerId, 'admission owner');

  for (const capability of input.requiredCapabilities) {
    assertNonEmpty(capability, 'required capability');
    if (!input.availableCapabilities.includes(capability)) {
      return blocked(
        input.queue.kind,
        ownerId,
        `capability.${capability}`,
        `required capability is unavailable: ${capability}`,
      );
    }
  }

  if (input.health === 'unhealthy') {
    return blocked(input.queue.kind, ownerId, 'health.healthy', 'organ health is unhealthy');
  }
  if (input.health === 'attention') {
    return waiting(input.queue.kind, ownerId, 'health.attention', 'organ health requires attention');
  }
  if (input.health === 'unknown') {
    return waiting(input.queue.kind, ownerId, 'health.known', 'organ health is unknown');
  }

  const providedInputRefs = new Set(input.providedInputRefs);
  for (const inputRef of input.requiredInputRefs) {
    assertNonEmpty(inputRef, 'required input reference');
    if (!providedInputRefs.has(inputRef)) {
      return waiting(
        input.queue.kind,
        ownerId,
        `input.${inputRef}`,
        `required input is incomplete: ${inputRef}`,
      );
    }
  }

  if (!input.checkpoint.recoverable) {
    return blocked(
      input.queue.kind,
      ownerId,
      input.checkpoint.conditionRef ?? 'checkpoint.recoverable',
      'checkpoint is not recoverable',
    );
  }

  if (input.queueLoad.running >= input.queue.concurrencyLimit) {
    return waiting(
      input.queue.kind,
      ownerId,
      `queue.${input.queue.kind}.concurrency`,
      'queue concurrency quota is exhausted',
    );
  }

  if (input.queueLoad.queued >= input.queue.maxBacklog) {
    return waiting(
      input.queue.kind,
      ownerId,
      `queue.${input.queue.kind}.backlog`,
      'queue backlog is full',
    );
  }

  return {
    status: 'admitted',
    queue: input.queue.kind,
    ownerId,
    condition: 'admitted',
    nextAction: { kind: 'continue', ref: 'orchestration.bind' },
    reason: 'admission requirements are satisfied',
  };
}

function taskUpdateDecision(input: {
  readonly status: TaskUpdateStatus;
  readonly task: TaskRevisionState;
  readonly revision: TaskRevision;
  readonly ownerId: string;
  readonly condition?: string;
  readonly nextAction: TaskUpdateDecision['nextAction'];
  readonly reason: string;
}): TaskUpdateDecision {
  return {
    status: input.status,
    taskId: input.revision.taskId,
    task: input.task,
    revision: input.revision.inputRevision,
    ownerId: input.ownerId,
    condition: input.condition,
    nextAction: input.nextAction,
    reason: input.reason,
  };
}

export function appendTaskRevision(input: {
  readonly task?: TaskRevisionState;
  readonly envelope: RequirementEnvelope;
  readonly ownerId?: string;
}): TaskUpdateDecision {
  validateRequirementEnvelope(input.envelope);
  if (!input.envelope.taskRef) throw new AdmissionError('task update requires taskRef');

  const ownerId = input.ownerId ?? DEFAULT_OWNER_ID;
  assertNonEmpty(ownerId, 'task update owner');

  const revision: TaskRevision = {
    inputRevision: input.envelope.inputRevision,
    taskId: input.envelope.taskRef,
    envelope: input.envelope,
  };
  const task = input.task ?? { taskId: input.envelope.taskRef, revisions: [] };

  if (task.taskId.value !== input.envelope.taskRef.value) {
    return taskUpdateDecision({
      status: 'blocked',
      task,
      revision,
      ownerId,
      condition: 'task.ref-mismatch',
      nextAction: { kind: 'recover', ref: 'task.ref-mismatch' },
      reason: 'requirement task reference does not match task state',
    });
  }

  const previous = task.revisions.at(-1);
  if (previous && input.envelope.inputRevision <= previous.inputRevision) {
    const condition = `task.inputRevision.after.${previous.inputRevision}`;
    return taskUpdateDecision({
      status: 'blocked',
      task,
      revision,
      ownerId,
      condition,
      nextAction: { kind: 'recover', ref: condition },
      reason: 'task update revision must advance without overwriting prior revision',
    });
  }

  return taskUpdateDecision({
    status: 'updated',
    task: { taskId: task.taskId, revisions: [...task.revisions, revision] },
    revision,
    ownerId,
    nextAction: { kind: 'continue', ref: 'task.input.dispatch' },
    reason: 'task input revision appended',
  });
}
