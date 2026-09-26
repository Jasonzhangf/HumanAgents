import {
  type EvidenceRef,
  type HealthState,
  type RequirementEnvelope,
  type ScopeRef,
  type TaskId,
  type WorkAssignment,
} from '../../../contracts/src/index.js';
import { id } from '../../../contracts/src/index.js';
import { RequirementInbox } from '../intake/requirement-inbox.js';
import {
  type OrchestrationDispatchResult,
  type OrchestrationIssue,
  type OrchestrationManager,
} from '../orchestration/index.js';
import { acceptanceCriteriaContent, digestOf } from '../orchestration/index.js';
import type { ReviewKind } from '../review/index.js';
import {
  admitRequirement,
  classifyConfirmedRequirement,
  defaultAdmissionQueueConfig,
  type RequirementAdmissionReceipt,
} from './implicit-admission.js';
import {
  ADMISSION_QUEUE_KINDS,
  type AdmissionQueueKind,
  type CheckpointRecoveryFacts,
  type QueueLoadSnapshot,
} from './types.js';

const DEFAULT_OWNER_ID = 'humanagent.runtime.implicit';

export interface ExecutorSubtask {
  readonly stageNodeId: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly objective: string;
  readonly targetRef: string;
  readonly expectedOutputRef: string;
  readonly successCriteria: readonly string[];
  readonly failureCriteria: readonly string[];
  readonly incompleteCriteria: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly reviewKinds?: readonly ReviewKind[];
  readonly mergeGate?: WorkAssignment['mergeGate'];
}

export interface ImplicitExecutorPlanInput {
  readonly envelope: RequirementEnvelope;
  readonly admission: RequirementAdmissionReceipt;
  readonly taskId: TaskId;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly inputRevision: number;
}

export interface ImplicitExecutorDispatchOptions extends ImplicitExecutorPlanInput {
  readonly orchestration: OrchestrationManager;
  readonly subtasks: readonly ExecutorSubtask[];
}

export type ImplicitExecutorTerminalStatus =
  | 'failed'
  | 'incomplete'
  | 'blocked'
  | 'retryable'
  | 'escalated';

export interface ImplicitExecutorDispatchResult extends ImplicitExecutorPlanInput {
  readonly status: 'succeeded' | ImplicitExecutorTerminalStatus;
  readonly dispatches: readonly OrchestrationDispatchResult[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly issue?: OrchestrationIssue;
}

export interface ImplicitBrainFifoDrainOptions {
  readonly taskId: TaskId;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly inputRevision: number;
  readonly queueLoad: QueueLoadSnapshot;
  readonly requiredCapabilities: readonly string[];
  readonly availableCapabilities: readonly string[];
  readonly health: HealthState;
  readonly requiredInputRefs: readonly string[];
  readonly providedInputRefs: readonly string[];
  readonly checkpoint: CheckpointRecoveryFacts;
  readonly planSubtasks?: (input: ImplicitExecutorPlanInput) => readonly ExecutorSubtask[];
}

export type ImplicitBrainFifoDrainResult =
  | { readonly kind: 'empty' }
  | (ImplicitExecutorDispatchResult & {
      readonly kind: 'succeeded' | ImplicitExecutorTerminalStatus;
    });

export interface ImplicitBrainFifoOptions {
  readonly inbox: RequirementInbox;
  readonly consumerId: string;
  readonly orchestration: OrchestrationManager;
  readonly ownerId?: string;
  readonly planSubtasks?: (input: ImplicitExecutorPlanInput) => readonly ExecutorSubtask[];
  readonly admit?: (input: {
    readonly envelope: RequirementEnvelope;
    readonly queueLoad: QueueLoadSnapshot;
    readonly requiredCapabilities: readonly string[];
    readonly availableCapabilities: readonly string[];
    readonly health: HealthState;
    readonly requiredInputRefs: readonly string[];
    readonly providedInputRefs: readonly string[];
    readonly checkpoint: CheckpointRecoveryFacts;
    readonly ownerId: string;
  }) => RequirementAdmissionReceipt;
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  return normalized || 'implicit';
}

function evidence(scope: ScopeRef, locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `implicit-${safeId(locator)}`),
    kind: 'operation',
    source: 'humanagent.runtime.implicit',
    locator,
    scope,
  };
}

function aggregateEvidence(groups: readonly (readonly EvidenceRef[])[]): readonly EvidenceRef[] {
  const seen = new Set<string>();
  const refs: EvidenceRef[] = [];
  for (const ref of groups.flat()) {
    const key = `${ref.evidenceId.value}:${ref.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function assertSubtask(subtask: ExecutorSubtask, index: number): void {
  assertNonEmpty(subtask.stageNodeId, `subtask[${index}].stageNodeId`);
  assertNonEmpty(subtask.assignmentId, `subtask[${index}].assignmentId`);
  assertNonEmpty(subtask.agentId, `subtask[${index}].agentId`);
  assertNonEmpty(subtask.objective, `subtask[${index}].objective`);
  assertNonEmpty(subtask.targetRef, `subtask[${index}].targetRef`);
  assertNonEmpty(subtask.expectedOutputRef, `subtask[${index}].expectedOutputRef`);
  if (subtask.successCriteria.length === 0) throw new Error(`subtask[${index}].successCriteria is required`);
  if (subtask.failureCriteria.length === 0) throw new Error(`subtask[${index}].failureCriteria is required`);
  if (subtask.incompleteCriteria.length === 0) throw new Error(`subtask[${index}].incompleteCriteria is required`);
  if (subtask.requiredCapabilities.length === 0) throw new Error(`subtask[${index}].requiredCapabilities is required`);
}

function assignmentForSubtask(
  subtask: ExecutorSubtask,
  input: ImplicitExecutorPlanInput,
): WorkAssignment {
  const criteria = {
    objective: subtask.objective,
    successCriteria: [...subtask.successCriteria],
    failureCriteria: [...subtask.failureCriteria],
    incompleteCriteria: [...subtask.incompleteCriteria],
  };
  return {
    assignmentId: subtask.assignmentId,
    taskId: input.taskId,
    pipelineNodeId: subtask.stageNodeId,
    attempt: 1,
    executionEpoch: input.executionEpoch,
    inputRevision: input.inputRevision,
    objective: subtask.objective,
    targetRefs: [subtask.targetRef],
    expectedOutputRefs: [subtask.expectedOutputRef],
    acceptanceCriteriaDigest: digestOf(acceptanceCriteriaContent(criteria)),
    successCriteria: [...subtask.successCriteria],
    failureCriteria: [...subtask.failureCriteria],
    incompleteCriteria: [...subtask.incompleteCriteria],
    requiredCapabilities: [...subtask.requiredCapabilities],
    mergeGate: subtask.mergeGate ?? 'not-required',
  };
}

function dispatchEvidence(result: OrchestrationDispatchResult): readonly EvidenceRef[] {
  return aggregateEvidence([
    result.assignment.evidenceRefs,
    result.issue?.evidenceRefs ?? [],
    result.reviewResults.flatMap((review) => review.evidenceRefs),
    result.mergeOutcome?.evidenceRefs ?? [],
  ]);
}

export function createDefaultImplicitExecutorSubtasks(
  input: ImplicitExecutorPlanInput,
): readonly ExecutorSubtask[] {
  const base = safeId(input.envelope.requirementId);
  return [
    {
      stageNodeId: `stage-${base}-code-search`,
      assignmentId: `assignment-${base}-code-search`,
      agentId: 'humanagent.executor.code-search',
      objective: `find code and evidence for: ${input.envelope.normalizedInput}`,
      targetRef: `asset://implicit/${base}/code-search`,
      expectedOutputRef: `asset://implicit/${base}/code-search/report`,
      successCriteria: ['code search produces a scoped evidence report'],
      failureCriteria: ['code search fails'],
      incompleteCriteria: ['code search requires a narrower scope'],
      requiredCapabilities: ['code.search'],
      reviewKinds: ['quality'],
    },
    {
      stageNodeId: `stage-${base}-checkpoint`,
      assignmentId: `assignment-${base}-checkpoint`,
      agentId: 'humanagent.executor.checkpoint',
      objective: `write checkpoint evidence for: ${input.envelope.normalizedInput}`,
      targetRef: `asset://implicit/${base}/checkpoint`,
      expectedOutputRef: `asset://implicit/${base}/checkpoint/report`,
      successCriteria: ['checkpoint evidence is written'],
      failureCriteria: ['checkpoint evidence write fails'],
      incompleteCriteria: ['checkpoint evidence is incomplete'],
      requiredCapabilities: ['file.checkpoint'],
      reviewKinds: ['quality'],
    },
  ];
}

export async function dispatchImplicitExecutorSubtasks(
  options: ImplicitExecutorDispatchOptions,
): Promise<ImplicitExecutorDispatchResult> {
  if (options.subtasks.length === 0) throw new Error('implicit executor subtasks are required');
  options.subtasks.forEach(assertSubtask);

  const dispatches: OrchestrationDispatchResult[] = [];
  for (const subtask of options.subtasks) {
    options.orchestration.planStage({
      nodeId: subtask.stageNodeId,
      taskId: options.taskId,
    });
    const assignment = assignmentForSubtask(subtask, options);
    const dispatched = await options.orchestration.dispatch({
      stageNodeId: subtask.stageNodeId,
      assignment,
      agentId: subtask.agentId,
      scope: options.scope,
      ...(subtask.reviewKinds ? { reviewKinds: subtask.reviewKinds } : {}),
    });
    dispatches.push(dispatched);
    if (dispatched.status !== 'succeeded' && dispatched.status !== 'merged') {
      return {
        status: dispatched.status as ImplicitExecutorTerminalStatus,
        envelope: options.envelope,
        admission: options.admission,
        taskId: options.taskId,
        scope: options.scope,
        executionEpoch: options.executionEpoch,
        inputRevision: options.inputRevision,
        dispatches,
        evidenceRefs: aggregateEvidence(dispatches.map(dispatchEvidence)),
        ...(dispatched.issue ? { issue: dispatched.issue } : {}),
      };
    }
  }
  return {
    status: 'succeeded',
    envelope: options.envelope,
    admission: options.admission,
    taskId: options.taskId,
    scope: options.scope,
    executionEpoch: options.executionEpoch,
    inputRevision: options.inputRevision,
    dispatches,
    evidenceRefs: aggregateEvidence(dispatches.map(dispatchEvidence)),
  };
}

export class ImplicitBrainFifo {
  readonly ownerId: string;
  private readonly inbox: RequirementInbox;
  private readonly consumerId: string;
  private readonly orchestration: OrchestrationManager;
  private readonly planSubtasks: (input: ImplicitExecutorPlanInput) => readonly ExecutorSubtask[];
  private readonly admit: NonNullable<ImplicitBrainFifoOptions['admit']>;

  constructor(options: ImplicitBrainFifoOptions) {
    if (!options.consumerId.trim()) throw new Error('implicit FIFO consumer id is required');
    this.ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
    if (!this.ownerId.trim()) throw new Error('implicit FIFO owner is required');
    this.inbox = options.inbox;
    this.consumerId = options.consumerId;
    this.orchestration = options.orchestration;
    this.planSubtasks = options.planSubtasks ?? createDefaultImplicitExecutorSubtasks;
    this.admit = options.admit ?? defaultAdmit;
  }

  async drainNext(input: ImplicitBrainFifoDrainOptions): Promise<ImplicitBrainFifoDrainResult> {
    const envelope = await this.inbox.peekNext({ consumerId: this.consumerId });
    if (!envelope) return { kind: 'empty' };
    const admission = this.admit({
      envelope,
      queueLoad: input.queueLoad,
      requiredCapabilities: input.requiredCapabilities,
      availableCapabilities: input.availableCapabilities,
      health: input.health,
      requiredInputRefs: input.requiredInputRefs,
      providedInputRefs: input.providedInputRefs,
      checkpoint: input.checkpoint,
      ownerId: this.ownerId,
    });
    const planInput: ImplicitExecutorPlanInput = {
      envelope,
      admission,
      taskId: input.taskId,
      scope: input.scope,
      executionEpoch: input.executionEpoch,
      inputRevision: input.inputRevision,
    };
    const subtasks = input.planSubtasks
      ? input.planSubtasks(planInput)
      : this.planSubtasks(planInput);
    const dispatched = await dispatchImplicitExecutorSubtasks({
      orchestration: this.orchestration,
      ...planInput,
      subtasks,
    });
    if (dispatched.status === 'succeeded') {
      await this.inbox.acknowledge({
        consumerId: this.consumerId,
        requirementId: envelope.requirementId,
      });
    }
    return { kind: dispatched.status, ...dispatched };
  }
}

function defaultAdmit(input: {
  readonly envelope: RequirementEnvelope;
  readonly queueLoad: QueueLoadSnapshot;
  readonly requiredCapabilities: readonly string[];
  readonly availableCapabilities: readonly string[];
  readonly health: HealthState;
  readonly requiredInputRefs: readonly string[];
  readonly providedInputRefs: readonly string[];
  readonly checkpoint: CheckpointRecoveryFacts;
  readonly ownerId: string;
}): RequirementAdmissionReceipt {
  const queue: AdmissionQueueKind = classifyConfirmedRequirement(input.envelope);
  return admitRequirement({
    envelope: input.envelope,
    queue: defaultAdmissionQueueConfig(queue),
    registeredQueues: ADMISSION_QUEUE_KINDS,
    queueLoad: input.queueLoad,
    requiredCapabilities: input.requiredCapabilities,
    availableCapabilities: input.availableCapabilities,
    health: input.health,
    requiredInputRefs: input.requiredInputRefs,
    providedInputRefs: input.providedInputRefs,
    checkpoint: input.checkpoint,
    ownerId: input.ownerId,
  });
}
