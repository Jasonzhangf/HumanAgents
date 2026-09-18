import type {
  Checkpoint,
  EvidenceRef,
  ScopeRef,
  Task,
} from '../../contracts/src/index.js';
import {
  FeedbackHub,
  OrchestrationManager,
  type CheckpointJournalPort,
  type CheckpointAppendReceipt,
  type CheckpointAppendRequest,
  type LatestCheckpointRecord,
  type FeedbackHubPorts,
  AgentRuntimePoolManager,
  type ExecutionAgentPort,
  type MergeCoordinatorPort,
  type OrchestrationFeedbackEvent,
  type OrchestrationFeedbackPort,
  type ReviewAgentPort,
} from '../../runtime/src/index.js';

export interface M3AssemblyOptions {
  readonly ownerId: string;
  readonly task: Task;
  readonly scope: ScopeRef;
  readonly runtimePool: AgentRuntimePoolManager;
  readonly executionAgent: ExecutionAgentPort;
  readonly reviewAgent: ReviewAgentPort;
  readonly mergeCoordinator: MergeCoordinatorPort;
  readonly feedbackPorts: FeedbackHubPorts;
  readonly feedbackPublisherId: string;
  readonly checkpointJournal: CheckpointJournalPort;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

export interface M3Assembly {
  readonly task: Task;
  readonly scope: ScopeRef;
  readonly orchestration: OrchestrationManager;
  readonly runtimePool: AgentRuntimePoolManager;
  readonly feedback: FeedbackHub;
  readonly feedbackPort: OrchestrationFeedbackPort;
  readonly checkpointJournal: CheckpointJournalPort;
  appendCheckpoint(input: Omit<CheckpointAppendRequest, 'checkpoint'> & { readonly checkpoint: Checkpoint }): Promise<CheckpointAppendReceipt>;
  readLatestCheckpoint(): Promise<LatestCheckpointRecord | null>;
}

type FeedbackPublication = Parameters<FeedbackHub['publish']>[0];

const FEEDBACK_KIND_BY_EVENT = {
  'work-result': 'work-result',
  attention: 'attention',
  retry: 'assignment-feedback',
  'review-feedback': 'review-feedback',
  'merge-outcome': 'assignment-feedback',
} as const;

const EVENT_CLASS_BY_FEEDBACK_KIND = {
  'work-result': 'data',
  attention: 'data',
  'assignment-feedback': 'control',
  'review-feedback': 'data',
} as const;

function eventSummary(event: OrchestrationFeedbackEvent): string {
  switch (event.kind) {
    case 'work-result':
      return event.result.summary;
    case 'attention':
    case 'retry':
      return event.reason;
    case 'review-feedback':
      return `${event.reviewAssignment.reviewKind} review ${event.reviewResult.status}`;
    case 'merge-outcome':
      return event.outcome.reason ?? `merge ${event.outcome.status}`;
  }
}

function eventIdentity(event: OrchestrationFeedbackEvent): string {
  const evidence = event.evidenceRefs.map((ref) => ref.evidenceId.value).join(',') || 'no-evidence';
  switch (event.kind) {
    case 'review-feedback':
      return `${event.kind}:${event.reviewResult.resultId}:${evidence}`;
    case 'merge-outcome':
      return `${event.kind}:${event.assignment.assignmentId}:${event.outcome.status}:${evidence}`;
    default:
      return `${event.kind}:${event.assignment.assignmentId}:${event.assignment.attempt}:${evidence}`;
  }
}

class FeedbackHubOrchestrationPort implements OrchestrationFeedbackPort {
  constructor(
    private readonly hub: FeedbackHub,
    private readonly publisherId: string,
    private readonly now: () => Date,
  ) {}

  async publish(event: OrchestrationFeedbackEvent): Promise<void> {
    const kind = FEEDBACK_KIND_BY_EVENT[event.kind];
    const publication: FeedbackPublication = {
      kind,
      publisherId: this.publisherId,
      event: {
        messageId: eventIdentity(event),
        streamId: `task:${event.assignment.taskId.value}`,
        class: EVENT_CLASS_BY_FEEDBACK_KIND[kind],
        scope: event.scope,
        occurredAt: this.now().toISOString(),
        summary: eventSummary(event),
        evidenceRefs: [...event.evidenceRefs],
        executionEpoch: event.assignment.executionEpoch,
        attempt: event.assignment.attempt,
        inputRevision: event.assignment.inputRevision,
      },
    };
    await this.hub.publish(publication);
  }
}

function assertScopeMatchesTask(task: Task, scope: ScopeRef): void {
  if (scope.organId.value !== task.organId.value || scope.taskId?.value !== task.id.value) {
    throw new Error('M3 assembly task scope does not match the task');
  }
}

export function createM3Assembly(options: M3AssemblyOptions): M3Assembly {
  assertScopeMatchesTask(options.task, options.scope);
  const feedback = new FeedbackHub(options.feedbackPorts);
  const feedbackPort = new FeedbackHubOrchestrationPort(
    feedback,
    options.feedbackPublisherId,
    options.now ?? (() => new Date()),
  );
  const orchestration = new OrchestrationManager({
    ownerId: options.ownerId,
    runtimePool: options.runtimePool,
    executionAgent: options.executionAgent,
    reviewAgent: options.reviewAgent,
    mergeCoordinator: options.mergeCoordinator,
    feedback: feedbackPort,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  return {
    task: options.task,
    scope: options.scope,
    orchestration,
    runtimePool: options.runtimePool,
    feedback,
    feedbackPort,
    checkpointJournal: options.checkpointJournal,
    async appendCheckpoint(input) {
      const checkpointScope = input.checkpoint.scope;
      if (checkpointScope.organId.value !== options.scope.organId.value
        || checkpointScope.taskId?.value !== options.scope.taskId?.value
        || checkpointScope.cycleId?.value !== options.scope.cycleId?.value
        || checkpointScope.operationId?.value !== options.scope.operationId?.value
        || input.checkpoint.cycleId.value !== options.scope.cycleId?.value) {
        throw new Error('M3 assembly checkpoint scope does not match the task scope');
      }
      return options.checkpointJournal.append(input);
    },
    async readLatestCheckpoint() {
      return options.checkpointJournal.readLatest(options.scope);
    },
  };
}
