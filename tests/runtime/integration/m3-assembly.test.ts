import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type Checkpoint,
  type EvidenceRef,
  type ScopeRef,
  type Task,
  type WorkAssignment,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import {
  type AppendEventRequest,
  type ConsumerCommitRequest,
  type ConsumerCommitResult,
  type ConsumerCursor,
  type EventConsumerReceipt,
  type EventDlqRecord,
  type EventJournalPort,
  type EventPublisherRegistryPort,
  type EventRecord,
  type EventRetryObligation,
  type ReadCursorInput,
  type ReadEventInput,
  type ReadEventsInput,
  type ReadRetryObligationInput,
  type TrustedEventPublisher,
} from '../../../packages/runtime/src/events/index.js';
import {
  AgentRuntimePoolManager,
  type ExecutionAgentPort,
  type MergeCoordinatorPort,
  type OrchestrationRuntimeFactoryPort,
  type ReviewAgentPort,
} from '../../../packages/runtime/src/orchestration/index.js';
import { type ReviewResult } from '../../../packages/runtime/src/review/index.js';
import {
  createM3Assembly,
  type M3Assembly,
} from '../../../packages/app/src/m3-assembly.js';
import { projectTaskDashboard } from '../../../packages/ui/index.js';
import type {
  CheckpointAppendReceipt,
  CheckpointAppendRequest,
  CheckpointChainVerification,
  CheckpointJournalPort,
  LatestCheckpointRecord,
} from '../../../packages/runtime/src/checkpoints/ports.js';

const organId = id('organ', 'm3-assembly');
const taskId = id('task', 'm3-assembly');
const cycleId = id('cycle', 'm3-assembly');
const scope: ScopeRef = { organId, taskId, cycleId };
const task: Task = {
  id: taskId,
  organId,
  title: 'M3 assembly',
  directive: 'assemble reviewed HumanAgent modules',
  directiveRevision: 1,
  state: 'running',
  memoryScope: 'task',
};

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `m3-${label}`),
    kind: 'operation',
    source: 'm3-assembly-test',
    locator: `m3/${label}`,
    scope,
  };
}

function assignment(overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  return {
    assignmentId: 'm3-assignment',
    taskId: taskId,
    pipelineNodeId: 'm3-node',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'assemble reviewed modules',
    targetRefs: ['m3-target'],
    expectedOutputRefs: ['m3-output'],
    expectedArtifactDigests: ['sha256:m3-artifact'],
    acceptanceCriteriaDigest: 'sha256:m3-criteria',
    successCriteria: ['modules assembled'],
    failureCriteria: ['assembly failed'],
    incompleteCriteria: ['assembly incomplete'],
    requiredCapabilities: ['execute'],
    mergeGate: 'required',
    ...overrides,
  };
}

function workResult(): WorkResult {
  return {
    taskId: taskId,
    pipelineNodeId: 'm3-node',
    agentId: 'worker-m3',
    assignmentId: 'm3-assignment',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    producedArtifactRefs: ['artifact://m3'],
    producedArtifactDigests: ['sha256:m3-artifact'],
    status: 'succeeded',
    summary: 'M3 modules assembled',
    outputRefs: ['m3-output'],
    evidenceRefs: [evidence('work')],
    nextAction: 'review',
  };
}

class MemoryEventJournal implements EventJournalPort {
  readonly events: EventRecord[] = [];

  async appendEvent(input: AppendEventRequest): Promise<EventRecord> {
    const record: EventRecord = {
      ...input.event,
      publisherId: input.publisherId,
      sequence: this.events.length + 1,
      committedAt: '2026-09-18T00:00:00.000Z',
    };
    this.events.push(record);
    return record;
  }

  async readEvents(_input: ReadEventsInput): Promise<readonly EventRecord[]> {
    return [...this.events];
  }

  async readEvent(input: ReadEventInput): Promise<EventRecord | null> {
    return this.events.find((event) => event.streamId === input.streamId && event.messageId === input.messageId) ?? null;
  }

  async readCursor(_input: ReadCursorInput): Promise<ConsumerCursor | null> { return null; }
  async commitConsumerCommit(_input: ConsumerCommitRequest): Promise<ConsumerCommitResult> {
    throw new Error('consumer commits are outside M3 assembly');
  }
  async readReceipt(_input: { readonly consumerKey: string; readonly messageId: string }): Promise<EventConsumerReceipt | null> {
    return null;
  }
  async commitRetryObligation(obligation: EventRetryObligation): Promise<EventRetryObligation> { return obligation; }
  async readRetryObligation(_input: ReadRetryObligationInput): Promise<EventRetryObligation | null> { return null; }
  async listPendingRetryObligations(_input: { readonly streamId: string; readonly consumerKey: string; readonly limit: number }): Promise<readonly EventRetryObligation[]> { return []; }
  async commitDlq(record: EventDlqRecord): Promise<EventDlqRecord> { return record; }
  async readDlq(_input: ReadRetryObligationInput): Promise<EventDlqRecord | null> { return null; }
}

class MemoryPublishers implements EventPublisherRegistryPort {
  constructor(private readonly publisher: TrustedEventPublisher) {}
  async resolvePublisher(publisherId: string): Promise<TrustedEventPublisher | null> {
    return publisherId === this.publisher.publisherId ? this.publisher : null;
  }
}

class MemoryCheckpointJournal implements CheckpointJournalPort {
  private latest: LatestCheckpointRecord | null = null;
  readonly appended: CheckpointAppendRequest[] = [];

  async verify(_scope: ScopeRef): Promise<CheckpointChainVerification> { return { valid: true }; }
  async readLatest(_scope: ScopeRef): Promise<LatestCheckpointRecord | null> { return this.latest; }
  async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
    this.appended.push(input);
    this.latest = {
      checkpoint: input.checkpoint,
      previous: this.latest?.checkpoint ?? null,
    };
    return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq };
  }
}

class RuntimeFactory implements OrchestrationRuntimeFactoryPort {
  async start(input: Parameters<OrchestrationRuntimeFactoryPort['start']>[0]) {
    return { runtimeId: input.runtimeId, generation: input.generation, capabilities: input.requiredCapabilities };
  }
  async dispose(_input: Parameters<OrchestrationRuntimeFactoryPort['dispose']>[0]): Promise<void> {}
}

class Worker implements ExecutionAgentPort {
  async execute(_input: Parameters<ExecutionAgentPort['execute']>[0]): Promise<WorkResult> {
    return workResult();
  }
}

class Reviewer implements ReviewAgentPort {
  async review(input: Parameters<ReviewAgentPort['review']>[0]): Promise<ReviewResult> {
    return {
      resultId: 'm3-review-result',
      assignmentId: input.reviewAssignment.assignmentId,
      taskId: input.reviewAssignment.taskId,
      workerAgentId: input.reviewAssignment.workerAgentId,
      reviewKind: input.reviewAssignment.reviewKind,
      attempt: input.reviewAssignment.attempt,
      executionEpoch: input.reviewAssignment.executionEpoch,
      inputRevision: input.reviewAssignment.inputRevision,
      acceptanceCriteriaDigest: input.reviewAssignment.acceptanceCriteriaDigest,
      subjectRefs: input.reviewAssignment.subjectRefs,
      subjectDigests: input.reviewAssignment.subjectDigests,
      status: 'passed',
      findings: [],
      evidenceRefs: [evidence('review')],
    };
  }
}

function createAssembly(): { readonly assembly: M3Assembly; readonly events: MemoryEventJournal; readonly checkpoints: MemoryCheckpointJournal } {
  const events = new MemoryEventJournal();
  const publisher: TrustedEventPublisher = {
    publisherId: 'm3-harness',
    kind: 'harness',
    ownerId: 'm3-app',
    scope,
    allowedClasses: ['control', 'data', 'observation'],
    capabilities: ['event.publish.control'],
  };
  const checkpoints = new MemoryCheckpointJournal();
  const pool = new AgentRuntimePoolManager({
    maxRuntimes: 1,
    factory: new RuntimeFactory(),
    initialRuntimes: [{ runtimeId: 'm3-runtime', capabilities: ['execute'] }],
  });
  const assembly = createM3Assembly({
    ownerId: 'm3-orchestration',
    task,
    scope,
    runtimePool: pool,
    executionAgent: new Worker(),
    reviewAgent: new Reviewer(),
    mergeCoordinator: {
      async merge(_input: Parameters<MergeCoordinatorPort['merge']>[0]) {
        return { status: 'merged', evidenceRefs: [evidence('merge')] };
      },
    },
    feedbackPorts: {
      journal: events,
      publishers: new MemoryPublishers(publisher),
    },
    feedbackPublisherId: publisher.publisherId,
    checkpointJournal: checkpoints,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
  });
  return { assembly, events, checkpoints };
}

test('M3 app assembly closes dispatch, feedback, checkpoint, and typed UI projection', async () => {
  const { assembly, events, checkpoints } = createAssembly();
  assembly.orchestration.planStage({ nodeId: 'm3-node', taskId });

  const dispatched = await assembly.orchestration.dispatch({
    stageNodeId: 'm3-node',
    assignment: assignment(),
    agentId: 'worker-m3',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: ['sha256:m3-artifact'],
  });

  assert.equal(dispatched.status, 'merged');
  assert.equal(dispatched.assignment.status, 'merged');
  assert.deepEqual(events.events.map((event) => event.class), ['data', 'data', 'control']);
  assert.deepEqual(events.events.map((event) => event.publisherId), ['m3-harness', 'm3-harness', 'm3-harness']);

  const checkpoint: Checkpoint = {
    id: id('checkpoint', 'm3-checkpoint'),
    scope,
    cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: task.directiveRevision,
    executionEpoch: 1,
    outcome: 'succeeded',
    summary: 'M3 assembly merged',
    recoveryStateRef: evidence('recovery'),
    evidenceRefs: [evidence('merge')],
    next: { kind: 'continue', ref: 'task:m3-assembly' },
  };
  await assembly.appendCheckpoint({
    ownerId: 'm3-orchestration',
    commitId: 'm3-commit',
    checkpoint,
  });
  const latest = await assembly.readLatestCheckpoint();
  assert.equal(latest?.checkpoint.id.value, checkpoint.id.value);
  assert.equal(checkpoints.appended.length, 1);

  const projection = projectTaskDashboard({
    source: { state: 'ready', label: task.title, updatedAt: '2026-09-18T00:00:00.000Z' },
    task,
    userInput: task.directive,
    objective: dispatched.assignment.result?.summary ?? dispatched.assignment.reason,
    currentStatus: dispatched.assignment.status,
    agentCards: [{
      agentId: dispatched.assignment.agentId ?? 'worker-m3',
      role: 'orchestration',
      statusDisplay: dispatched.assignment.status,
      inputPreview: dispatched.assignment.assignment.objective,
      outputPreview: dispatched.assignment.result?.summary ?? 'merged',
    }],
    runtimePool: {
      available: 1,
      active: 0,
      runtimes: [{
        runtimeId: 'm3-runtime',
        role: 'orchestration',
        state: 'available',
        resourceSummary: 'execute',
      }],
    },
    requiresUserHandling: false,
    observationRef: 'task://m3-assembly/observation',
  });
  assert.equal(projection.surface, 'task-dashboard');
  assert.equal(projection.taskId.value, taskId.value);
  assert.equal(projection.agentCards[0]?.outputPreview, 'M3 modules assembled');
  assert.equal(projection.runtimePool.runtimes[0]?.runtimeId, 'm3-runtime');
});
