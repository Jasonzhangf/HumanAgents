import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AssignmentGraphCommitRequest,
  type AssignmentGraphStream,
  type CommittedAssignmentGraphFact,
  type EvidenceRef,
  type InspectionItemDelivery,
  type RequirementEnvelope,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import { RequirementInbox } from '../../../packages/runtime/src/intake/requirement-inbox.js';
import {
  ImplicitBrainFifo,
  RequirementAdmissionError,
  createDefaultImplicitExecutorSubtasks,
  dispatchImplicitExecutorSubtasks,
} from '../../../packages/runtime/src/admission/index.js';
import {
  AgentRuntimePoolManager,
  AssignmentGraph,
  OrchestrationManager,
  replayAssignmentGraph,
  type ExecutionAgentInput,
  type ExecutionAgentPort,
  type ExecutionDelivery,
  type GraphMutation,
  type IndependentChildCallInput,
  type ChildCallPort,
  type MergeCoordinatorPort,
  type OrchestrationFeedbackEvent,
  type OrchestrationFeedbackPort,
  type OrchestrationRuntimeFactoryPort,
  type ReviewAgentPort,
} from '../../../packages/runtime/src/orchestration/index.js';
import type { ReviewResult } from '../../../packages/runtime/src/review/index.js';
import type {
  TaskExecutionHandle,
  TaskExecutionInstanceCreateInput,
  TaskReviewHandle,
  TaskReviewInstanceCreateInput,
} from '../../../packages/runtime/src/orchestration/types.js';
import {
  createTestAssignmentGraphJournal,
  type TestAssignmentGraphJournal,
} from './assignment-graph-test-journal.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: ScopeRef = { organId: organ, taskId: task };
const runtimeBinding = {
  runtimeId: 'runtime-a',
  generation: 1,
  leaseId: 'lease-a',
  assignmentId: 'assignment-a',
  executionEpoch: 1,
} as const;
const graphStream = {
  taskScope: { organId: organ, taskId: task },
  ownerId: 'orchestration-manager',
} as const;

function createManager(
  options: Omit<ConstructorParameters<typeof OrchestrationManager>[0], 'graphJournal' | 'graph'>
    & Partial<Pick<ConstructorParameters<typeof OrchestrationManager>[0], 'graph' | 'graphJournal'>>
    & { readonly taskId?: typeof task; readonly organId?: typeof organ },
): OrchestrationManager {
  const { taskId = task, organId = organ, ...rest } = options;
  const fixture = createTestAssignmentGraphJournal({ ownerId: options.ownerId, taskId, organId });
  return new OrchestrationManager({
    ...rest,
    graph: options.graph ?? fixture.graph,
    graphJournal: options.graphJournal ?? fixture,
  });
}

function graphStreamFor(ownerId: string, taskId: typeof task, organId: typeof organ): AssignmentGraphStream {
  return { taskScope: { organId, taskId }, ownerId };
}

async function commitGraphMutation<T>(
  journal: TestAssignmentGraphJournal,
  graph: AssignmentGraph,
  mutation: GraphMutation<T>,
): Promise<T> {
  const prepared = graph.prepare(mutation);
  if (!prepared.change) return prepared.value;
  const stream = graph.stream;
  if (!stream) throw new Error('test graph stream is required');
  const revision = graph.revision + 1;
  const request: AssignmentGraphCommitRequest = {
    commitId: `test-assignment-graph:${stream.ownerId}:${revision}`,
    expectedRevision: graph.revision,
    fact: { version: 1, stream, revision, change: prepared.change },
  };
  const committed = await journal.commit(request);
  graph.applyCommitted(committed);
  return prepared.value;
}

/** Produced subject body shared by the review fixtures in this file. */
const artifactBody = 'reviewed artifact body';

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: label,
    scope,
  };
}

function assignment(overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  const criteria = {
    objective: 'execute bounded work',
    successCriteria: ['success-a'],
    failureCriteria: ['failure-a'],
    incompleteCriteria: ['incomplete-a'],
  };
  return {
    assignmentId: 'assignment-a',
    taskId: task,
    pipelineNodeId: 'node-a',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: criteria.objective,
    targetRefs: ['target-a'],
    expectedOutputRefs: ['output-a'],
    successCriteria: [...criteria.successCriteria],
    failureCriteria: [...criteria.failureCriteria],
    incompleteCriteria: [...criteria.incompleteCriteria],
    requiredCapabilities: ['execute'],
    mergeGate: 'not-required',
    ...overrides,
  };
}

function result(overrides: Partial<WorkResult> = {}): WorkResult {
  const base = assignment();
  return {
    taskId: base.taskId,
    pipelineNodeId: base.pipelineNodeId,
    agentId: 'agent-a',
    assignmentId: base.assignmentId,
    attempt: base.attempt,
    executionEpoch: base.executionEpoch,
    inputRevision: base.inputRevision,
    producedArtifactRefs: ['artifact-a'],
    status: 'succeeded',
    summary: 'work completed',
    outputRefs: ['output-a'],
    evidenceRefs: [evidence('worker')],
    nextAction: 'review',
    ...overrides,
  };
}

function committedGraphFact(
  revision: number,
  change: CommittedAssignmentGraphFact['fact']['change'],
): CommittedAssignmentGraphFact {
  return {
    fact: {
      version: 1,
      stream: graphStream,
      revision,
      change,
    },
    commitRef: {
      commitId: `assignment-graph-${revision}`,
      journalSeq: revision,
      recordDigest: `digest-${revision}`,
    },
  };
}

function requireGraphChange(
  change: CommittedAssignmentGraphFact['fact']['change'] | null,
): CommittedAssignmentGraphFact['fact']['change'] {
  if (change === null) throw new Error('expected graph change');
  return change;
}

function criteria(overrides: Partial<{
  readonly satisfied: readonly string[];
  readonly failed: readonly string[];
  readonly incomplete: readonly string[];
}> = {}) {
  return {
    satisfied: ['success-a'],
    failed: [],
    incomplete: [],
    ...overrides,
  };
}

class FakeRuntimeFactory implements OrchestrationRuntimeFactoryPort {
  readonly starts: string[] = [];
  readonly disposes: string[] = [];
  readonly startInputs: Array<Parameters<OrchestrationRuntimeFactoryPort['start']>[0]> = [];
  readonly disposeInputs: Array<Parameters<OrchestrationRuntimeFactoryPort['dispose']>[0]> = [];
  readonly startFailures = new Set<string>();
  readonly disposeFailures = new Set<string>();
  startGate?: Promise<void>;
  startStarted?: () => void;

  async start(input: Parameters<OrchestrationRuntimeFactoryPort['start']>[0]) {
    this.starts.push(input.runtimeId);
    this.startInputs.push(input);
    this.startStarted?.();
    if (this.startGate) await this.startGate;
    if (this.startFailures.has(input.runtimeId)) throw new Error(`startup failed: ${input.runtimeId}`);
    return {
      runtimeId: input.runtimeId,
      generation: input.generation,
      capabilities: [...input.requiredCapabilities],
    };
  }

  async dispose(input: Parameters<OrchestrationRuntimeFactoryPort['dispose']>[0]): Promise<void> {
    this.disposes.push(input.runtimeId);
    this.disposeInputs.push(input);
    if (this.disposeFailures.has(input.runtimeId)) throw new Error(`dispose failed: ${input.runtimeId}`);
  }
}

class StaticExecutionAgent implements ExecutionAgentPort {
  readonly roleId = 'executor';
  readonly inputs: ExecutionAgentInput[] = [];
  constructor(private readonly deliveries: readonly (WorkResult | ExecutionDelivery)[]) {}

  createInstance(create: TaskExecutionInstanceCreateInput): TaskExecutionHandle {
    return {
      incarnation: create.incarnation,
      execute: (input) => this.execute(input),
      async dispose() {},
    };
  }

  async execute(input: ExecutionAgentInput): Promise<WorkResult | ExecutionDelivery> {
    this.inputs.push(input);
    const delivery = this.deliveries[Math.min(this.inputs.length - 1, this.deliveries.length - 1)];
    if (!delivery) throw new Error('missing execution delivery');
    return 'result' in delivery ? delivery.result : delivery;
  }
}

class RecordingChildCallPort implements ChildCallPort {
  readonly prepares: Parameters<ChildCallPort['prepare']>[0][] = [];
  readonly returns: Parameters<ChildCallPort['recordReturn']>[0][] = [];

  async prepare(input: Parameters<ChildCallPort['prepare']>[0]) {
    this.prepares.push(input);
    return {
      invocationId: input.invocationId,
      checkpointReceiptRef: `checkpoint:${input.invocationId}`,
    };
  }

  async recordReturn(input: Parameters<ChildCallPort['recordReturn']>[0]): Promise<void> {
    this.returns.push(input);
  }

  async recordAdoption(): Promise<void> {}

  async recordReviewCheckpoint(input: Parameters<ChildCallPort['recordReviewCheckpoint']>[0]) {
    return { checkpointReceiptRef: `checkpoint:${input.invocationId}` };
  }
}

function poolExecutionIdentity(assignmentId: string) {
  const agent = new StaticExecutionAgent([result({ assignmentId })]);
  return {
    taskId: task,
    roleId: agent.roleId,
    agentId: 'agent-a',
    assignment: assignment({ assignmentId }),
    creator: (create: TaskExecutionInstanceCreateInput) => agent.createInstance(create),
  };
}

class PassingReviewAgent implements ReviewAgentPort {
  readonly roleId = 'reviewer';
  createInstance(create: TaskReviewInstanceCreateInput): TaskReviewHandle {
    return {
      incarnation: create.incarnation,
      review: async (input) => ({
        result: await this.review(input),
        output: { text: `review ${input.reviewAssignment.assignmentId}`, artifactRef: null, artifactDigest: null },
        completedAt: new Date().toISOString(),
      }),
      async dispose() {},
    };
  }
  readonly kinds: string[] = [];
  readonly results: ReviewResult[] = [];
  fail = false;

  async review(input: Parameters<ReviewAgentPort['review']>[0]): Promise<ReviewResult> {
    this.kinds.push(input.reviewAssignment.reviewKind);
    const result: ReviewResult = {
      resultId: `review-result-${input.reviewAssignment.assignmentId}`,
      assignmentId: input.reviewAssignment.assignmentId,
      taskId: input.reviewAssignment.taskId,
      workerAgentId: input.reviewAssignment.workerAgentId,
      reviewKind: input.reviewAssignment.reviewKind,
      attempt: input.reviewAssignment.attempt,
      executionEpoch: input.reviewAssignment.executionEpoch,
      inputRevision: input.reviewAssignment.inputRevision,
      subjectRefs: [...input.reviewAssignment.subjectRefs],
      status: this.fail ? 'failed' : 'passed',
      findings: this.fail
        ? [{
            findingId: 'finding-a',
            severity: 'important',
            locationRef: 'artifact-a',
            problem: 'remediation required',
            expected: 'passing review',
            evidenceRefs: [evidence('finding')],
          }]
        : [],
      evidenceRefs: [evidence(`review-${input.reviewAssignment.reviewKind}`)],
    };
    this.results.push(result);
    return result;
  }
}

class RecordingFeedback implements OrchestrationFeedbackPort {
  readonly events: OrchestrationFeedbackEvent[] = [];
  failOn?: OrchestrationFeedbackEvent['kind'];

  async publish(event: OrchestrationFeedbackEvent): Promise<void> {
    this.events.push(event);
    if (this.failOn === event.kind) throw new Error(`feedback failed: ${event.kind}`);
  }
}

function factoryPool(options: {
  readonly maxRuntimes?: number;
  readonly factory?: FakeRuntimeFactory;
  readonly initialRuntimes?: ConstructorParameters<typeof AgentRuntimePoolManager>[0]['initialRuntimes'];
} = {}) {
  const factory = options.factory ?? new FakeRuntimeFactory();
  return {
    factory,
    pool: new AgentRuntimePoolManager({
      maxRuntimes: options.maxRuntimes ?? 2,
      factory,
      ...(options.initialRuntimes ? { initialRuntimes: options.initialRuntimes } : {}),
    }),
  };
}

test('manager acquires dormant execution from its bound creator and same pool', async () => {
  const taskId = id('task', 'cold-acquisition');
  const scope: ScopeRef = { organId: id('organ', 'cold-acquisition'), taskId };
  const assignment: WorkAssignment = {
    assignmentId: 'original-assignment', taskId, pipelineNodeId: 'node',
    attempt: 1, executionEpoch: 1, inputRevision: 1, objective: 'bounded acquisition',
    targetRefs: [], expectedOutputRefs: [],
    successCriteria: [], failureCriteria: [],
    incompleteCriteria: [], requiredCapabilities: ['execute'], mergeGate: 'not-required',
  };
  let creates = 0;
  let effects = 0;
  let disposes = 0;
  let createdInput: TaskExecutionInstanceCreateInput | undefined;
  let createdHandle: TaskExecutionHandle | undefined;
  const delivery: WorkResult = {
    taskId, pipelineNodeId: 'node', agentId: 'worker', assignmentId: assignment.assignmentId,
    attempt: 1, executionEpoch: 1, inputRevision: 1, producedArtifactRefs: [],
    status: 'succeeded', summary: 'done', outputRefs: [],
    evidenceRefs: [], nextAction: 'review',
  };
  const agent: ExecutionAgentPort = {
    roleId: 'executor',
    createInstance(input) {
      assert.equal(this, agent, 'creator must retain bound port receiver');
      creates += 1;
      createdInput = input;
      createdHandle = {
        incarnation: input.incarnation,
        async execute() { effects += 1; return delivery; },
        async dispose() { disposes += 1; },
      };
      return createdHandle;
    },
    async execute() { throw new Error('legacy execution must not run'); },
  };
  const pool = new AgentRuntimePoolManager({
    maxRuntimes: 1, instanceIdFactory: () => 'fresh-instance',
    initialRuntimes: [{ runtimeId: 'same-slot', capabilities: ['execute'] }],
    factory: {
      async start(input) { return { runtimeId: input.runtimeId, generation: input.generation, capabilities: input.requiredCapabilities }; },
      async dispose() {},
    },
  });
  const manager = createManager({ ownerId: 'owner', runtimePool: pool, executionAgent: agent });
  const acquired = await manager.acquireExecutionInstance({ assignment, scope, agentId: 'worker', executionEpoch: 7 });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') throw new Error(acquired.issue.reason);
  assert.equal(creates, 1, 'bound creator must run exactly once');
  assert.equal(acquired.handle, createdHandle);
  assert.equal(createdInput?.assignment, assignment);
  assert.equal(createdInput?.agentId, 'worker');
  assert.deepEqual(createdInput?.scope, scope);
  assert.equal(acquired.incarnation.agentInstanceId, 'fresh-instance');
  assert.equal(acquired.incarnation.executionEpoch, 7);
  assert.equal(acquired.incarnation.roleId, 'executor');
  assert.equal(acquired.incarnation.assignmentId, assignment.assignmentId);
  assert.equal(acquired.lease.runtimeId, 'same-slot');
  assert.deepEqual(acquired.lease.incarnation, acquired.incarnation);
  assert.equal(pool.inspect().runtimes[0]?.lease?.leaseId, acquired.lease.leaseId, 'lease must belong to the bound pool');
  assert.equal(effects, 0, 'acquisition must remain dormant');
  await acquired.handle.execute({ assignment, scope, agentId: 'worker', executionEpoch: 7, attempt: 1, lease: acquired.lease });
  assert.equal(effects, 1);
  assert.equal((await pool.release(acquired.lease, { scope })).status, 'released');
  assert.equal(disposes, 1);
  assert.equal(pool.inspect().runtimes[0]?.lease, undefined);
  assert.equal((await pool.dispose()).status, 'disposed');
});

test('retained dispatch uses the exact acquired handle without re-acquiring or releasing its lease', async () => {
  const taskId = id('task', 'retained-dispatch');
  const retainedScope: ScopeRef = { organId: id('organ', 'retained-dispatch'), taskId };
  const originalAssignment = assignment({ assignmentId: 'retained-assignment', taskId });
  const physicalEpoch = 2;
  const businessDelivery = result({
    taskId,
    assignmentId: originalAssignment.assignmentId,
    nextAction: 'settle',
  });
  let creates = 0;
  let executes = 0;
  let disposes = 0;
  const executeInputs: ExecutionAgentInput[] = [];
  let createdHandle: TaskExecutionHandle | undefined;
  const agent: ExecutionAgentPort = {
    roleId: 'executor',
    createInstance(create: TaskExecutionInstanceCreateInput): TaskExecutionHandle {
      creates += 1;
      createdHandle = {
        incarnation: create.incarnation,
        async execute(input) {
          executes += 1;
          executeInputs.push(input);
          return businessDelivery;
        },
        async dispose() { disposes += 1; },
      };
      return createdHandle;
    },
    async execute() { throw new Error('legacy execution must not run'); },
  };
  const { pool } = factoryPool({
    maxRuntimes: 2,
    initialRuntimes: [{ runtimeId: 'retained-runtime', capabilities: ['execute'] }],
  });
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: agent,
    taskId,
    organId: retainedScope.organId,
  });
  await manager.planStage({ nodeId: 'node-a', taskId });
  const acquired = await manager.acquireExecutionInstance({
    assignment: originalAssignment,
    scope: retainedScope,
    agentId: 'agent-a',
    executionEpoch: physicalEpoch,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  assert.equal(creates, 1, 'the retained instance is created once');
  assert.equal(acquired.handle, createdHandle);
  assert.equal(acquired.incarnation.executionEpoch, physicalEpoch);
  assert.equal(acquired.lease.executionEpoch, physicalEpoch);

  const dispatched = await manager.dispatchAcquired({
    stageNodeId: 'node-a',
    assignment: originalAssignment,
    agentId: 'agent-a',
    scope: retainedScope,
  }, acquired);

  assert.equal(dispatched.status, 'succeeded');
  assert.equal(executes, 1, 'retained dispatch executes the acquired handle exactly once');
  assert.equal(creates, 1, 'retained dispatch must not acquire a second instance');
  assert.equal(executeInputs[0]?.lease, acquired.lease, 'the exact acquired lease reaches the handle');
  assert.equal(executeInputs[0]?.executionEpoch, physicalEpoch, 'physical execution input comes from the lease');
  assert.equal(dispatched.assignment.result?.assignmentId, originalAssignment.assignmentId);
  assert.equal(
    dispatched.assignment.result?.executionEpoch,
    originalAssignment.executionEpoch,
    'business result epoch stays the original assignment epoch',
  );
  assert.equal(dispatched.assignment.runtimeBinding?.executionEpoch, physicalEpoch, 'physical lease epoch is bound separately');
  assert.equal(pool.inspect().runtimes[0]?.lease?.leaseId, acquired.lease.leaseId, 'manager must not release the retained lease');
  assert.equal((await pool.release(acquired.lease, { scope: retainedScope })).status, 'released');
  assert.equal(pool.inspect().runtimes[0]?.lease, undefined);
  assert.equal((await pool.dispose()).status, 'disposed');
  assert.equal(disposes, 1);
});

test('inspection manager delivery preserves prepare binding, returned delivery and recordReturn payload', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'inspection-runtime', capabilities: ['execute'] }],
  });
  const completedAt = '2026-10-17T10:11:12.000Z';
  const judgment = 'free judgment: inspected body remains body, not control JSON';
  const inspectionDelivery: InspectionItemDelivery = {
    checkId: 'check-a',
    resultId: 'inspection-result:inspection-call',
    attempt: 1,
    outcome: { status: 'completed', judgment },
    evidenceRefs: [evidence('inspection-delivery')],
    completedAt,
  };
  const inspection = {
    binding: {
      occurrence: {
        scope: { organId: organ, taskId: task },
        occurrenceId: 'occurrence-a',
      },
      executionScope: scope,
      cycleId: 'cycle-a',
      executionEpoch: 1,
      definition: { definitionId: 'definition-a', definitionVersion: '1' },
      definitionCommitRef: {
        commitId: 'definition-commit',
        journalSeq: 2,
        recordDigest: 'definition-digest',
      },
      definitionDigest: 'definition-content-digest',
      cycleOpenedCommitRef: {
        commitId: 'cycle-opened-commit',
        journalSeq: 3,
        recordDigest: 'cycle-opened-digest',
      },
      scheduleOccurrenceRef: null,
    },
    check: {
      checkId: 'check-a',
      criterion: 'criterion-a',
      inputRefs: ['input-a'],
    },
  };
  const executionDelivery: ExecutionDelivery = {
    result: result({
      assignmentId: 'inspection-call',
      nextAction: 'settle',
      summary: 'full execution summary',
      producedArtifactBodies: ['full artifact body'],
    }),
    inspectionDelivery,
  };
  const executionInputs: ExecutionAgentInput[] = [];
  const execute = async (input: ExecutionAgentInput) => {
    executionInputs.push(input);
    return executionDelivery;
  };
  const execution: ExecutionAgentPort = {
    roleId: 'executor',
    execute,
    createInstance: (create) => ({
      incarnation: create.incarnation,
      execute,
      async dispose() {},
    }),
  };
  const childCallPort = new RecordingChildCallPort();
  const manager = createManager({
    ownerId: 'inspection-manager',
    runtimePool: pool,
    childCallPort,
  });
  const input: IndependentChildCallInput & { readonly kind: 'execution' } = {
    kind: 'execution',
    assignment: assignment({ assignmentId: 'inspection-call' }),
    executionAgent: execution,
    inspection,
    agentId: 'agent-a',
    scope,
    childCallPort,
    signal: new AbortController().signal,
    call: {
      invocationId: 'inspection-call',
      parentExecution: {
        runtimeId: 'inspection-parent',
        taskId: task,
        operationId: id('operation', 'inspection-parent'),
        executionEpoch: 1,
      },
      providerRequestId: 'request-inspection',
      toolCallId: 'tool-inspection',
      businessRegistrationCommitRef: {
        commitId: 'business-registration',
        journalSeq: 1,
        recordDigest: 'business-registration-digest',
      },
    },
  };

  const returned = await manager.callChild(input);
  assert.equal(returned.state, 'returned');
  if (returned.state !== 'returned' || returned.kind !== 'execution') {
    throw new Error(JSON.stringify(returned));
  }
  const prepared = childCallPort.prepares[0];
  const recorded = childCallPort.returns[0];
  assert.equal(prepared?.kind, 'execution');
  assert.equal(recorded?.kind, 'execution');
  if (prepared?.kind !== 'execution' || recorded?.kind !== 'execution') {
    throw new Error('execution child call was not prepared and recorded');
  }
  assert.deepEqual({
    prepared: prepared.inspection,
    executed: executionInputs[0]?.inspection,
    returned: returned.inspectionDelivery,
    recorded: recorded.inspectionDelivery,
  }, {
    prepared: inspection,
    executed: inspection,
    returned: inspectionDelivery,
    recorded: inspectionDelivery,
  });
  assert.deepEqual(recorded.result, returned.result);
  assert.equal(recorded.result.producedArtifactBodies?.[0], 'full artifact body');
  assert.deepEqual(returned.inspectionDelivery?.outcome, { status: 'completed', judgment });
  assert.equal(returned.inspectionDelivery?.completedAt, completedAt);
  assert.deepEqual(returned.inspectionDelivery?.evidenceRefs, inspectionDelivery.evidenceRefs);
  assert.equal(executionInputs.length, 1, 'inspection delivery must not call the child twice');
});

test('runtime pool reuses idle runtimes, spawns at capacity, waits and blocks unavailable capabilities', async () => {
  const { pool, factory } = factoryPool({
    maxRuntimes: 3,
    initialRuntimes: [
      { runtimeId: 'idle-a', capabilities: ['execute'] },
      { runtimeId: 'running-a', capabilities: ['execute'], state: 'running' },
    ],
  });
  const first = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  assert.equal(first.status, 'acquired');
  if (first.status !== 'acquired') return;
  assert.equal(first.lease.runtimeId, 'idle-a');
  assert.deepEqual(factory.starts, []);

  const second = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-b'),
    scope,
  });
  assert.equal(second.status, 'acquired');
  if (second.status !== 'acquired') return;
  assert.equal(second.lease.runtimeId, 'orchestration-runtime-1');
  assert.deepEqual(factory.starts, ['orchestration-runtime-1']);

  const waiting = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-c'),
    scope,
  });
  assert.equal(waiting.status, 'waiting');
  if (waiting.status === 'acquired') return;
  assert.equal(waiting.issue.conditionRef, 'orchestration.runtime.max');

  const blocked = await pool.acquire({
    requiredCapabilities: ['missing'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-d'),
    scope,
  });
  assert.equal(blocked.status, 'blocked');
  if (blocked.status === 'acquired') return;
  assert.equal(blocked.issue.conditionRef, 'orchestration.capability.missing');

  const staleRelease = await pool.release({ ...first.lease, assignmentId: 'assignment-other' }, { scope });
  assert.equal(staleRelease.status, 'blocked');
  if (staleRelease.status !== 'blocked') return;
  assert.equal(staleRelease.issue.conditionRef, `orchestration.runtime.lease.${first.lease.runtimeId}`);

  const released = await pool.release(first.lease, { scope });
  assert.equal(released.status, 'released');
});

test('runtime pool reserves distinct idle runtimes before yielding', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 2,
    initialRuntimes: [
      { runtimeId: 'idle-a', capabilities: ['execute'] },
      { runtimeId: 'idle-b', capabilities: ['execute'] },
    ],
  });

  let first: Awaited<ReturnType<typeof pool.acquire>> | undefined;
  let second: Awaited<ReturnType<typeof pool.acquire>> | undefined;
  try {
    [first, second] = await Promise.all([
      pool.acquire({
        requiredCapabilities: ['execute'],
        executionEpoch: 1,
        ...poolExecutionIdentity('assignment-a'),
        scope,
      }),
      pool.acquire({
        requiredCapabilities: ['execute'],
        executionEpoch: 1,
        ...poolExecutionIdentity('assignment-b'),
        scope,
      }),
    ]);

    assert.equal(first.status, 'acquired');
    assert.equal(second.status, 'acquired');
    if (first.status !== 'acquired' || second.status !== 'acquired') return;

    assert.notEqual(first.lease.runtimeId, second.lease.runtimeId);
    assert.notEqual(first.handle, second.handle);
    assert.notEqual(first.lease.leaseId, second.lease.leaseId);
    assert.notEqual(first.incarnation.agentInstanceId, second.incarnation.agentInstanceId);

    assert.equal(first.handle.incarnation.runtimeId, first.lease.runtimeId);
    assert.equal(second.handle.incarnation.runtimeId, second.lease.runtimeId);
    assert.equal(first.handle.incarnation.agentInstanceId, first.incarnation.agentInstanceId);
    assert.equal(second.handle.incarnation.agentInstanceId, second.incarnation.agentInstanceId);
  } finally {
    try {
      if (first?.status === 'acquired') {
        await pool.release(first.lease, { scope });
      }
    } finally {
      try {
        if (second?.status === 'acquired') {
          await pool.release(second.lease, { scope });
        }
      } finally {
        await pool.dispose();
      }
    }
  }
});

test('runtime pool fences release by assignment, lease, generation, and execution epoch', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const acquired = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;

  for (const stale of [
    { ...acquired.lease, assignmentId: 'assignment-b' },
    { ...acquired.lease, leaseId: 'lease-stale' },
    { ...acquired.lease, generation: 2 },
    { ...acquired.lease, executionEpoch: 2 },
    { ...acquired.lease, ownerId: 'other-owner' },
  ]) {
    const fenced = await pool.release(stale, { scope });
    assert.equal(fenced.status, 'blocked');
    if (fenced.status === 'blocked') assert.equal(fenced.issue.ownerId, 'orchestration-runtime-manager');
  }

  assert.equal((await pool.release(acquired.lease, { scope })).status, 'released');
});

test('explicit failed runtime remains failed and is never reused', async () => {
  const { pool, factory } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'failed-a', capabilities: ['execute'], state: 'failed' }],
  });

  assert.equal(pool.inspect().runtimes[0]?.state, 'failed');
  const acquired = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });

  assert.equal(acquired.status, 'waiting');
  if (acquired.status === 'acquired') return;
  assert.equal(acquired.issue.conditionRef, 'orchestration.runtime.max');
  assert.deepEqual(factory.starts, []);
  assert.equal(pool.inspect().runtimes[0]?.state, 'failed');
});

test('runtime pool rejects startup completed after dispose and cleans the generation once', async () => {
  let releaseStart!: () => void;
  const factory = new FakeRuntimeFactory();
  factory.startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const started = new Promise<void>((resolve) => {
    factory.startStarted = resolve;
  });
  const pool = new AgentRuntimePoolManager({ maxRuntimes: 1, factory });

  const acquiring = pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  await started;
  let disposeSettled = false;
  const disposing = pool.dispose().then((result) => {
    disposeSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(disposeSettled, false);
  assert.deepEqual(factory.disposeInputs, []);

  releaseStart();
  const acquired = await acquiring;
  assert.equal(acquired.status, 'blocked');
  if (acquired.status === 'acquired') return;
  assert.equal(acquired.issue.code, 'runtime-startup-invalidated');
  assert.equal(acquired.issue.ownerId, 'orchestration-runtime-manager');
  assert.deepEqual(factory.disposeInputs, [{
    runtimeId: 'orchestration-runtime-1',
    generation: 1,
    executionEpoch: 1,
    ownerId: 'orchestration-runtime-manager',
    assignmentId: 'assignment-a',
  }]);
  assert.equal(pool.inspect().runtimes[0]?.state, 'disposed');
  assert.equal(pool.inspect().runtimes[0]?.lease, undefined);
  const disposed = await disposing;
  assert.equal(disposed.status, 'disposed');

  const secondDispose = await pool.dispose();
  assert.equal(secondDispose.status, 'disposed');
  assert.equal(secondDispose.alreadyDisposed, true);
  assert.equal(factory.disposeInputs.length, 1);
});

test('runtime pool does not block dispose after delayed startup failure with successful cleanup', async () => {
  let releaseStart!: () => void;
  const factory = new FakeRuntimeFactory();
  factory.startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  factory.startFailures.add('orchestration-runtime-1');
  const started = new Promise<void>((resolve) => {
    factory.startStarted = resolve;
  });
  const pool = new AgentRuntimePoolManager({ maxRuntimes: 1, factory });

  const acquiring = pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  await started;
  const disposing = pool.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(factory.disposeInputs, []);

  releaseStart();
  const acquired = await acquiring;
  assert.equal(acquired.status, 'blocked');
  if (acquired.status === 'acquired') return;
  assert.equal(acquired.issue.code, 'runtime-startup-failed');

  const disposed = await disposing;
  assert.equal(disposed.status, 'disposed');
  assert.equal(disposed.alreadyDisposed, false);
  assert.deepEqual(disposed.issues, []);
  assert.equal(factory.disposeInputs.length, 1);
  assert.deepEqual(pool.inspect().runtimes, []);
});

test('runtime pool waits for delayed startup cleanup failure and retries without polluting a later acquire', async () => {
  let releaseStart!: () => void;
  const factory = new FakeRuntimeFactory();
  factory.startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  factory.disposeFailures.add('orchestration-runtime-1');
  const started = new Promise<void>((resolve) => {
    factory.startStarted = resolve;
  });
  const pool = new AgentRuntimePoolManager({ maxRuntimes: 1, factory });

  const acquiring = pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  await started;
  let disposeSettled = false;
  const disposing = pool.dispose().then((result) => {
    disposeSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(disposeSettled, false);
  assert.deepEqual(factory.disposeInputs, []);

  releaseStart();
  const acquired = await acquiring;
  assert.equal(acquired.status, 'blocked');
  if (acquired.status === 'acquired') return;
  assert.equal(acquired.issue.code, 'runtime-startup-invalidated');
  assert.equal(acquired.issue.reason.includes('cleanup failed'), true);

  const failed = await disposing;
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.alreadyDisposed, false);
  assert.equal(failed.issues.length, 1);
  assert.equal(failed.issues[0]?.code, 'runtime-startup-invalidated');
  assert.equal(failed.issues[0]?.reason.includes('cleanup failed'), true);
  assert.equal(failed.issues[0]?.nextAction.kind, 'recover');
  assert.equal(failed.issues[0]?.conditionRef, 'orchestration.runtime.startup.cleanup.orchestration-runtime-1');
  assert.equal(pool.inspect().runtimes[0]?.state, 'failed');
  assert.equal(pool.inspect().runtimes[0]?.lease, undefined);

  const blocked = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-b'),
    scope,
  });
  assert.equal(blocked.status, 'blocked');
  if (blocked.status === 'acquired') return;
  assert.equal(blocked.issue.code, 'runtime-pool-disposed');

  factory.disposeFailures.delete('orchestration-runtime-1');
  const retried = await pool.dispose();
  assert.equal(retried.status, 'disposed');
  assert.equal(retried.alreadyDisposed, true);
  assert.deepEqual(retried.issues, []);
  assert.equal(pool.inspect().runtimes[0]?.state, 'disposed');
  assert.equal(factory.disposeInputs.length, 2);

  const idempotent = await pool.dispose();
  assert.equal(idempotent.status, 'disposed');
  assert.equal(idempotent.alreadyDisposed, true);
  assert.equal(factory.disposeInputs.length, 2);
});

test('runtime pool cleans failed generation, advances on retry, and disposes the active generation once', async () => {
  const factory = new FakeRuntimeFactory();
  factory.startFailures.add('orchestration-runtime-1');
  const { pool } = factoryPool({ maxRuntimes: 1, factory });
  const acquired = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  assert.equal(acquired.status, 'blocked');
  if (acquired.status === 'acquired') return;
  assert.equal(acquired.issue.ownerId, 'orchestration-runtime-manager');
  assert.equal(acquired.issue.nextAction.kind, 'recover');
  assert.ok(acquired.issue.evidenceRefs.length > 0);
  assert.deepEqual(factory.startInputs, [{
    runtimeId: 'orchestration-runtime-1',
    generation: 1,
    executionEpoch: 1,
    ownerId: 'orchestration-runtime-manager',
    assignmentId: 'assignment-a',
    requiredCapabilities: ['execute'],
    scope,
  }]);
  assert.deepEqual(factory.disposeInputs, [{
    runtimeId: 'orchestration-runtime-1',
    generation: 1,
    executionEpoch: 1,
    ownerId: 'orchestration-runtime-manager',
    assignmentId: 'assignment-a',
  }]);

  factory.startFailures.clear();
  const running = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-b'),
    scope,
  });
  assert.equal(running.status, 'acquired');
  if (running.status !== 'acquired') return;
  assert.equal(running.lease.generation, 2);
  assert.deepEqual(factory.startInputs.map(({ runtimeId, generation, assignmentId }) => ({
    runtimeId,
    generation,
    assignmentId,
  })), [
    { runtimeId: 'orchestration-runtime-1', generation: 1, assignmentId: 'assignment-a' },
    { runtimeId: 'orchestration-runtime-1', generation: 2, assignmentId: 'assignment-b' },
  ]);

  const firstDispose = await pool.dispose();
  assert.equal(firstDispose.status, 'disposed');
  assert.equal(firstDispose.alreadyDisposed, false);
  assert.deepEqual(factory.disposeInputs, [
    {
      runtimeId: 'orchestration-runtime-1',
      generation: 1,
      executionEpoch: 1,
      ownerId: 'orchestration-runtime-manager',
      assignmentId: 'assignment-a',
    },
    {
      runtimeId: 'orchestration-runtime-1',
      generation: 2,
      executionEpoch: 1,
      ownerId: 'orchestration-runtime-manager',
      assignmentId: 'assignment-b',
    },
  ]);
  const disposeCallsAfterFirst = factory.disposeInputs.length;
  const secondDispose = await pool.dispose();
  assert.equal(secondDispose.status, 'disposed');
  assert.equal(secondDispose.alreadyDisposed, true);
  assert.equal(factory.disposeInputs.length, disposeCallsAfterFirst);
});

test('assignment graph accepts a complete successful path and is idempotent by assignment attempt epoch', () => {
  const graph = new AssignmentGraph({ ownerId: 'orchestration-manager' });
  graph.addStage({ nodeId: 'node-a', taskId: task });
  const first = graph.createAssignment('node-a', assignment());
  const duplicate = graph.createAssignment('node-a', assignment());
  assert.equal(first.status, 'planned');
  assert.equal(duplicate.status, 'planned');
  assert.deepEqual(first, duplicate);
  assert.equal(graph.listAssignments().length, 1);

  graph.assign(assignment(), 'agent-a', runtimeBinding);
  graph.start(assignment(), 'agent-a', runtimeBinding);
  const accepted = graph.acceptResult(assignment(), {
    result: result(),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    maxAttempts: 2,
    runtimeBinding,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  assert.equal(accepted.record.status, 'running');
  assert.equal(accepted.record.result?.status, 'succeeded');
  assert.equal(graph.getStage('node-a')?.state, 'running');

  const completed = graph.markSucceeded(assignment(), accepted.record.evidenceRefs);
  assert.equal(completed.status, 'succeeded');
  assert.equal(graph.getStage('node-a')?.state, 'succeeded');

  const repeated = graph.acceptResult(assignment(), {
    result: result(),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    maxAttempts: 2,
    runtimeBinding,
  });
  assert.equal(repeated.accepted, true);
  if (!repeated.accepted) return;
  assert.equal(repeated.duplicate, true);
});

test('assignment graph rejects reuse of one assignment key in a different stage', () => {
  const graph = new AssignmentGraph({ ownerId: 'orchestration-manager' });
  graph.addStage({ nodeId: 'node-a', taskId: task });
  graph.addStage({ nodeId: 'node-b', taskId: task });
  graph.createAssignment('node-a', assignment());

  assert.throws(
    () => graph.createAssignment('node-b', assignment()),
    /different stage/,
  );
  assert.deepEqual(graph.getStage('node-a')?.assignmentKeys, ['assignment-a:1:1']);
  assert.deepEqual(graph.getStage('node-b')?.assignmentKeys, []);
});

test('resume binding installs a first agent without resetting committed assignment state', async () => {
  const stream = graphStreamFor('orchestration-manager', task, organ);
  const journal = createTestAssignmentGraphJournal({
    ownerId: 'orchestration-manager',
    taskId: task,
    organId: organ,
  });
  const graph = new AssignmentGraph({ ownerId: 'orchestration-manager', stream });
  await commitGraphMutation(journal, graph, {
    kind: 'declare-stage',
    apply: (draft) => draft.addStage({ nodeId: 'node-a', taskId: task }),
  });
  await commitGraphMutation(journal, graph, {
    kind: 'assignment-transition',
    action: 'create-assignment',
    apply: (draft) => draft.createAssignment('node-a', assignment()),
  });
  const beforeStage = graph.getStage('node-a');
  const segmentOpenedCommitRef = {
    commitId: 'segment-opened-a',
    journalSeq: 9,
    recordDigest: 'segment-opened-digest',
  };

  const rebound = await commitGraphMutation(journal, graph, {
    kind: 'resume-binding',
    segmentOpenedCommitRef,
    apply: (draft) => draft.resumeBinding(assignment(), 'agent-a', runtimeBinding),
  });

  assert.equal(rebound.status, 'planned');
  assert.equal(rebound.agentId, 'agent-a');
  assert.deepEqual(rebound.runtimeBinding, runtimeBinding);
  assert.deepEqual(graph.getStage('node-a'), beforeStage);
  assert.deepEqual(graph.getStage('node-a')?.assignmentKeys, ['assignment-a:1:1']);
  assert.throws(
    () => graph.prepare({
      kind: 'resume-binding',
      segmentOpenedCommitRef,
      apply: (draft) => draft.resumeBinding(assignment(), 'agent-b', runtimeBinding),
    }),
    /cannot replace the bound agent/,
  );
});

test('assignment graph rejects conflicting review results without replacing persisted truth', () => {
  const graph = new AssignmentGraph({ ownerId: 'orchestration-manager' });
  graph.addStage({ nodeId: 'node-a', taskId: task });
  graph.createAssignment('node-a', assignment());
  graph.assign(assignment(), 'agent-a', runtimeBinding);
  graph.start(assignment(), 'agent-a', runtimeBinding);
  const review: ReviewResult = {
    resultId: 'review-a',
    assignmentId: 'assignment-a',
    taskId: task.value,
    workerAgentId: 'agent-a',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    subjectRefs: ['target-a'],
    status: 'passed',
    findings: [],
    evidenceRefs: [evidence('review-a')],
  };
  graph.recordReviewResult(assignment(), review);

  assert.throws(
    () => graph.recordReviewResult(assignment(), {
      ...review,
      status: 'failed',
      findings: [{
        findingId: 'finding-conflict',
        severity: 'blocker',
        locationRef: 'artifact-a',
        problem: 'conflict',
        expected: 'persisted truth',
        evidenceRefs: [evidence('conflict')],
      }],
    }),
    /conflicts with existing content/,
  );
  assert.throws(
    () => graph.recordReviewResult(assignment(), {
      ...review,
      evidenceRefs: review.evidenceRefs.map((ref, index) => (
        index === 0 ? { ...ref, locator: 'different-evidence-locator' } : ref
      )),
    }),
    /conflicts with existing content/,
  );
  assert.deepEqual(graph.get(assignment())?.reviewResults, [review]);
});

test('assignment graph prepare stays uncommitted and replay preserves recorded stage facts', () => {
  const live = new AssignmentGraph({
    ownerId: 'orchestration-manager',
    stream: graphStream,
  });
  const entries: CommittedAssignmentGraphFact[] = [];
  let revision = 0;
  const commit = (change: CommittedAssignmentGraphFact['fact']['change']) => {
    revision += 1;
    const entry = committedGraphFact(revision, change);
    live.applyCommitted(entry);
    entries.push(entry);
  };

  const parent = live.prepare({
    kind: 'declare-stage',
    apply: (graph) => graph.addStage({ nodeId: 'stage-parent', taskId: task }),
  });
  commit(requireGraphChange(parent.change));

  const child = live.prepare({
    kind: 'declare-stage',
    apply: (graph) => graph.addStage({
      nodeId: 'stage-child',
      taskId: task,
      parentNodeId: 'stage-parent',
    }),
  });
  assert.ok(child.change);
  assert.equal(live.revision, 1);
  assert.equal(live.getStage('stage-child'), undefined);
  assert.equal(live.listStages().length, 1);
  commit(requireGraphChange(child.change));

  const empty = live.prepare({
    kind: 'declare-stage',
    apply: (graph) => graph.addStage({ nodeId: 'stage-empty', taskId: task }),
  });
  commit(requireGraphChange(empty.change));

  const created = live.prepare({
    kind: 'assignment-transition',
    action: 'create-assignment',
    apply: (graph) => graph.createAssignment('stage-child', assignment()),
  });
  assert.ok(created.change);
  assert.equal(live.revision, 3);
  assert.equal(live.get(assignment()), undefined);
  assert.equal(live.getStage('stage-child')?.assignmentKeys.length, 0);
  commit(requireGraphChange(created.change));

  const assigned = live.prepare({
    kind: 'assignment-transition',
    action: 'assign',
    apply: (graph) => graph.assign(assignment(), 'agent-a', runtimeBinding),
  });
  commit(requireGraphChange(assigned.change));

  const started = live.prepare({
    kind: 'assignment-transition',
    action: 'start',
    apply: (graph) => graph.start(assignment(), 'agent-a', runtimeBinding),
  });
  commit(requireGraphChange(started.change));

  const merged = live.prepare({
    kind: 'assignment-transition',
    action: 'mark-merged',
    apply: (graph) => graph.markMerged(assignment(), [evidence('merge')]),
  });
  commit(requireGraphChange(merged.change));

  const plannedAfterMerge = live.prepare({
    kind: 'assignment-transition',
    action: 'create-assignment',
    apply: (graph) => graph.createAssignment(
      'stage-child',
      assignment({ assignmentId: 'assignment-b' }),
    ),
  });
  commit(requireGraphChange(plannedAfterMerge.change));

  const childStage = live.getStage('stage-child');
  assert.equal(live.getStage('stage-empty')?.assignmentKeys.length, 0);
  assert.equal(childStage?.parentNodeId, 'stage-parent');
  assert.deepEqual(childStage?.assignmentKeys, ['assignment-a:1:1', 'assignment-b:1:1']);
  assert.equal(childStage?.state, 'merged');
  assert.equal(live.get(assignment())?.status, 'merged');
  assert.equal(live.get(assignment({ assignmentId: 'assignment-b' }))?.status, 'planned');
  assert.deepEqual(replayAssignmentGraph(graphStream, entries), live.snapshot());
});

test('assignment graph rejects stale epochs, wrong agents and duplicate conflicting results', () => {
  const graph = new AssignmentGraph({ ownerId: 'orchestration-manager' });
  graph.addStage({ nodeId: 'node-a', taskId: task });
  graph.createAssignment('node-a', assignment());
  graph.assign(assignment(), 'agent-a', runtimeBinding);
  graph.start(assignment(), 'agent-a', runtimeBinding);

  const stale = graph.acceptResult(assignment(), {
    result: result({ executionEpoch: 2 }),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    runtimeBinding,
  });
  assert.equal(stale.accepted, false);
  if (stale.accepted) return;
  assert.equal(stale.code, 'stale-epoch');

  const wrongAgent = graph.acceptResult(assignment(), {
    result: result({ agentId: 'agent-b' }),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    runtimeBinding,
  });
  assert.equal(wrongAgent.accepted, false);
  if (wrongAgent.accepted) return;
  assert.equal(wrongAgent.code, 'wrong-agent');

  graph.acceptResult(assignment(), {
    result: result(),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    runtimeBinding,
  });
  const conflict = graph.acceptResult(assignment(), {
    result: result({ summary: 'different duplicate' }),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    runtimeBinding,
  });
  assert.equal(conflict.accepted, false);
  if (conflict.accepted) return;
  assert.equal(conflict.code, 'duplicate-conflict');
});

test('failed work retries within budget and escalates after budget exhaustion', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const execution = new StaticExecutionAgent([
    result({ status: 'failed', outputRefs: [], failureRef: 'failure-a' }),
  ]);
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    maxAttempts: 1,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  });
  assert.equal(dispatched.status, 'escalated');
  assert.equal(dispatched.issue?.ownerId, 'orchestration-manager');
  assert.equal(dispatched.issue?.nextAction.kind, 'stop');
  assert.ok(dispatched.issue?.evidenceRefs.length);
});

test('failed and incomplete results map to retryable until the budget is exhausted', () => {
  const graph = new AssignmentGraph({ ownerId: 'orchestration-manager' });
  graph.addStage({ nodeId: 'node-a', taskId: task });
  graph.createAssignment('node-a', assignment());
  graph.assign(assignment(), 'agent-a', runtimeBinding);
  graph.start(assignment(), 'agent-a', runtimeBinding);

  const failed = graph.acceptResult(assignment(), {
    result: result({ status: 'failed', outputRefs: [], failureRef: 'failure-a' }),
    expectedAgentId: 'agent-a',
    criteria: criteria({ satisfied: [], failed: ['failure-a'] }),
    maxAttempts: 2,
    runtimeBinding,
  });
  assert.equal(failed.accepted, true);
  if (!failed.accepted) return;
  assert.equal(failed.record.status, 'retryable');
  assert.equal(failed.record.nextAction.kind, 'recover');

  const incompleteGraph = new AssignmentGraph({ ownerId: 'orchestration-manager' });
  incompleteGraph.addStage({ nodeId: 'node-a', taskId: task });
  incompleteGraph.createAssignment('node-a', assignment());
  incompleteGraph.assign(assignment(), 'agent-a', runtimeBinding);
  incompleteGraph.start(assignment(), 'agent-a', runtimeBinding);
  const incomplete = incompleteGraph.acceptResult(assignment(), {
    result: result({ status: 'incomplete', outputRefs: [] }),
    expectedAgentId: 'agent-a',
    criteria: criteria({ satisfied: [], incomplete: ['incomplete-a'] }),
    maxAttempts: 1,
    runtimeBinding,
  });
  assert.equal(incomplete.accepted, true);
  if (!incomplete.accepted) return;
  assert.equal(incomplete.record.status, 'escalated');
  assert.equal(incomplete.record.nextAction.kind, 'stop');
});

test('review failure creates a remediation assignment and merge cannot precede passing review', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const review = new PassingReviewAgent();
  review.fail = true;
  let mergeCalls = 0;
  const merge: MergeCoordinatorPort = {
    async merge() {
      mergeCalls += 1;
      return { status: 'merged', evidenceRefs: [evidence('merge')] };
    },
  };
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ producedArtifactBodies: [artifactBody] }), criteria: criteria() },
    ]),
    reviewAgent: review,
    mergeCoordinator: merge,
    maxAttempts: 2,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjects: [{ ref: 'target-a', body: artifactBody }],
  });
  assert.equal(dispatched.status, 'retryable');
  assert.equal(dispatched.remediation?.attempt, 2);
  assert.equal(mergeCalls, 0);
});

test('review result mismatch is rejected before graph state advances', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const review = new PassingReviewAgent();
  review.review = async (input) => ({
    ...(await PassingReviewAgent.prototype.review.call(review, input)),
    executionEpoch: input.reviewAssignment.executionEpoch + 1,
  });
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ producedArtifactBodies: [artifactBody] }), criteria: criteria() },
    ]),
    reviewAgent: review,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjects: [{ ref: 'target-a', body: artifactBody }],
  });
  assert.equal(dispatched.status, 'blocked');
  assert.equal(dispatched.issue?.code, 'review-result-invalid');
  assert.equal(dispatched.assignment.reviewResults.length, 0);
});

test('merge-required work passes review before merge and records merged status', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const merge: MergeCoordinatorPort = {
    async merge() {
      return { status: 'merged', evidenceRefs: [evidence('merge')] };
    },
  };
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ producedArtifactBodies: [artifactBody] }), criteria: criteria() },
    ]),
    reviewAgent: new PassingReviewAgent(),
    mergeCoordinator: merge,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjects: [{ ref: 'target-a', body: artifactBody }],
  });
  assert.equal(dispatched.status, 'merged');
  assert.equal(dispatched.assignment.status, 'merged');
  assert.equal(dispatched.mergeOutcome?.status, 'merged');
});

test('duplicate dispatch returns recoverable progress while review is pending', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const execution = new StaticExecutionAgent([
    { result: result({ producedArtifactBodies: [artifactBody] }), criteria: criteria() },
  ]);
  const review = new PassingReviewAgent();
  let releaseReview!: () => void;
  let markReviewStarted!: () => void;
  const reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  const reviewStarted = new Promise<void>((resolve) => {
    markReviewStarted = resolve;
  });
  let releaseMerge!: () => void;
  let markMergeStarted!: () => void;
  const mergeGate = new Promise<void>((resolve) => {
    releaseMerge = resolve;
  });
  const mergeStarted = new Promise<void>((resolve) => {
    markMergeStarted = resolve;
  });
  let mergeCalls = 0;
  review.review = async (input) => {
    markReviewStarted();
    await reviewGate;
    return PassingReviewAgent.prototype.review.call(review, input);
  };
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    reviewAgent: review,
    mergeCoordinator: {
      async merge() {
        mergeCalls += 1;
        markMergeStarted();
        await mergeGate;
        return { status: 'merged', evidenceRefs: [evidence('merge')] };
      },
    },
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const input = {
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' as const }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality' as const],
    reviewSubjects: [{ ref: 'target-a', body: artifactBody }],
  };

  const firstDispatch = manager.dispatch(input);
  await reviewStarted;
  const repeatedDuringReview = await manager.dispatch(input);
  releaseReview();
  await mergeStarted;
  const repeatedDuringMerge = await manager.dispatch(input);
  releaseMerge();
  const first = await firstDispatch;

  assert.equal(first.status, 'merged');
  assert.equal(repeatedDuringReview.status, 'running');
  assert.equal(repeatedDuringReview.assignment.status, 'running');
  assert.equal(repeatedDuringReview.issue?.ownerId, 'orchestration-manager');
  assert.equal(repeatedDuringReview.issue?.nextAction.kind, 'continue');
  assert.equal(repeatedDuringMerge.status, 'running');
  assert.equal(repeatedDuringMerge.assignment.status, 'running');
  assert.equal(repeatedDuringMerge.issue?.ownerId, 'orchestration-manager');
  assert.equal(repeatedDuringMerge.issue?.nextAction.kind, 'continue');
  assert.equal(execution.inputs.length, 1);
  assert.equal(mergeCalls, 1);
});

test('duplicate dispatch returns recoverable progress while execution is pending', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  let releaseExecution!: () => void;
  let markExecutionStarted!: () => void;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const executionStarted = new Promise<void>((resolve) => {
    markExecutionStarted = resolve;
  });
  let executionCalls = 0;
  const execution: ExecutionAgentPort = {
    roleId: 'executor',
    createInstance(create) {
      return {
        incarnation: create.incarnation,
        execute: (input) => execution.execute(input),
        async dispose() {},
      };
    },
    async execute() {
      executionCalls += 1;
      markExecutionStarted();
      await executionGate;
      return { result: result({ nextAction: 'settle' }), criteria: criteria() };
    },
  };
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const input = {
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  };

  const firstDispatch = manager.dispatch(input);
  await executionStarted;
  const leaseDuringExecution = pool.inspect().runtimes[0]?.lease?.leaseId;
  const repeated = await manager.dispatch(input);

  assert.equal(repeated.status, 'running');
  assert.equal(repeated.assignment.status, 'running');
  assert.equal(repeated.issue?.code, 'assignment-progress-pending');
  assert.equal(repeated.issue?.nextAction.kind, 'continue');
  assert.equal(executionCalls, 1);
  assert.equal(pool.inspect().runtimes[0]?.lease?.leaseId, leaseDuringExecution);

  releaseExecution();
  const first = await firstDispatch;
  assert.equal(first.status, 'succeeded');
  assert.equal(executionCalls, 1);
});

test('duplicate dispatch returns recoverable progress while runtime startup is pending', async () => {
  const factory = new FakeRuntimeFactory();
  const { pool } = factoryPool({ maxRuntimes: 1, factory });
  let releaseStartup!: () => void;
  let markStartupStarted!: () => void;
  factory.startGate = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  const startupStarted = new Promise<void>((resolve) => {
    markStartupStarted = resolve;
  });
  factory.startStarted = markStartupStarted;
  const execution = new StaticExecutionAgent([
    { result: result({ nextAction: 'settle' }), criteria: criteria() },
  ]);
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const input = {
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  };

  const firstDispatch = manager.dispatch(input);
  await startupStarted;
  const repeated = await manager.dispatch(input);

  assert.equal(repeated.status, 'running');
  assert.notEqual(repeated.assignment.status, 'blocked');
  assert.equal(repeated.issue?.code, 'assignment-progress-pending');
  assert.equal(repeated.issue?.nextAction.kind, 'continue');
  assert.equal(factory.startInputs.length, 1);
  assert.equal(pool.inspect().runtimes[0]?.lease, undefined);

  releaseStartup();
  const first = await firstDispatch;
  assert.equal(first.status, 'succeeded');
  assert.equal(factory.startInputs.length, 1);
  assert.equal(execution.inputs.length, 1);
});

test('ordinary dispatch returns progress for a hydrated running assignment without executing', async () => {
  const stream = graphStreamFor('orchestration-manager', task, organ);
  const journal = createTestAssignmentGraphJournal({
    ownerId: 'orchestration-manager',
    taskId: task,
    organId: organ,
  });
  const builder = new AssignmentGraph({ ownerId: 'orchestration-manager', stream });
  await commitGraphMutation(journal, builder, {
    kind: 'declare-stage',
    apply: (graph) => graph.addStage({ nodeId: 'node-a', taskId: task }),
  });
  await commitGraphMutation(journal, builder, {
    kind: 'assignment-transition',
    action: 'create-assignment',
    apply: (graph) => graph.createAssignment('node-a', assignment()),
  });
  await commitGraphMutation(journal, builder, {
    kind: 'assignment-transition',
    action: 'assign',
    apply: (graph) => graph.assign(assignment(), 'agent-a', runtimeBinding),
  });
  await commitGraphMutation(journal, builder, {
    kind: 'assignment-transition',
    action: 'start',
    apply: (graph) => graph.start(assignment(), 'agent-a', runtimeBinding),
  });
  const execution = new StaticExecutionAgent([
    { result: result({ nextAction: 'settle' }), criteria: criteria() },
  ]);
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    graph: new AssignmentGraph({ ownerId: 'orchestration-manager', stream }),
    graphJournal: journal,
  });

  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  });

  assert.equal(dispatched.status, 'running');
  assert.equal(dispatched.assignment.status, 'running');
  assert.equal(dispatched.issue?.code, 'assignment-progress-pending');
  assert.equal(execution.inputs.length, 0);
  assert.equal(pool.inspect().runtimes[0]?.lease, undefined);
});

test('two dispatch callers before journal replay share one execution', async () => {
  let markReplayStarted!: () => void;
  const replayStarted = new Promise<void>((resolve) => {
    markReplayStarted = resolve;
  });
  let releaseReplay!: () => void;
  const holdReplay = new Promise<void>((resolve) => {
    releaseReplay = resolve;
  });
  const stream = graphStreamFor('orchestration-manager', task, organ);
  const journal = createTestAssignmentGraphJournal({
    ownerId: 'orchestration-manager',
    taskId: task,
    organId: organ,
    holdReplay,
    markReplayStarted,
  });
  const builder = new AssignmentGraph({ ownerId: 'orchestration-manager', stream });
  await commitGraphMutation(journal, builder, {
    kind: 'declare-stage',
    apply: (graph) => graph.addStage({ nodeId: 'node-a', taskId: task }),
  });
  const execution = new StaticExecutionAgent([
    { result: result({ nextAction: 'settle' }), criteria: criteria() },
  ]);
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    graph: new AssignmentGraph({ ownerId: 'orchestration-manager', stream }),
    graphJournal: journal,
  });
  await replayStarted;
  const input = {
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  };

  const firstDispatch = manager.dispatch(input);
  const repeatedDispatch = manager.dispatch(input);
  releaseReplay();
  const [first, repeated] = await Promise.all([firstDispatch, repeatedDispatch]);

  assert.equal(first.status, 'succeeded');
  assert.equal(repeated.status, 'running');
  assert.equal(repeated.issue?.code, 'assignment-progress-pending');
  assert.equal(execution.inputs.length, 1);
});

test('graph commit failure before durable write blocks acquire and execution', async () => {
  const journal = createTestAssignmentGraphJournal({
    ownerId: 'orchestration-manager',
    taskId: task,
    organId: organ,
  });
  const execution = new StaticExecutionAgent([
    { result: result({ nextAction: 'settle' }), criteria: criteria() },
  ]);
  const { factory, pool } = factoryPool({ maxRuntimes: 1 });
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    graph: journal.graph,
    graphJournal: journal,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });

  journal.failNextCommitBeforeWrite();
  let beforeWriteFailure: unknown;
  try {
    await manager.dispatch({
      stageNodeId: 'node-a',
      assignment: assignment(),
      agentId: 'agent-a',
      scope,
    });
    throw new Error('dispatch must reject when its first graph commit fails');
  } catch (error) {
    beforeWriteFailure = error;
  }
  assert.ok(beforeWriteFailure instanceof Error);
  assert.ok((beforeWriteFailure as Error).message.includes('failed before write'));

  assert.equal(factory.startInputs.length, 0);
  assert.equal(execution.inputs.length, 0);
  assert.equal(manager.listAssignments().length, 0);
  assert.deepEqual(manager.getStage('node-a')?.assignmentKeys, []);

  const retried = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  });
  assert.equal(retried.status, 'succeeded');
  assert.equal(factory.startInputs.length, 1);
  assert.equal(execution.inputs.length, 1);
  assert.equal(manager.listAssignments().length, 1);
  assert.equal(journal.entries.length, 6);
});

test('uncertain journal receipt retains the identical commit until exact retry confirms persistence', async () => {
  const journal = createTestAssignmentGraphJournal({
    ownerId: 'orchestration-manager',
    taskId: task,
    organId: organ,
  });
  const execution = new StaticExecutionAgent([
    { result: result({ nextAction: 'settle' }), criteria: criteria() },
  ]);
  const { factory, pool } = factoryPool({ maxRuntimes: 1 });
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    graph: journal.graph,
    graphJournal: journal,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });

  journal.failNextCommitAfterWrite();
  let receiptFailure: unknown;
  try {
    await manager.dispatch({
      stageNodeId: 'node-a',
      assignment: assignment(),
      agentId: 'agent-a',
      scope,
    });
    throw new Error('dispatch must reject when its graph commit receipt is uncertain');
  } catch (error) {
    receiptFailure = error;
  }
  assert.ok(receiptFailure instanceof Error);
  assert.ok((receiptFailure as Error).message.includes('receipt failed after durable write'));

  assert.equal(journal.entries.length, 2);
  assert.equal(manager.listAssignments().length, 0);
  assert.equal(factory.startInputs.length, 0);
  assert.equal(execution.inputs.length, 0);

  const retried = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  });
  assert.equal(retried.status, 'succeeded');
  assert.equal(journal.entries.length, 6);
  assert.equal(manager.listAssignments().length, 1);
  assert.equal(factory.startInputs.length, 1);
  assert.equal(execution.inputs.length, 1);
});

test('resource admission blocked keeps the same assignment reusable after release', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const held = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-other'),
    scope,
  });
  assert.equal(held.status, 'acquired');
  if (held.status !== 'acquired') return;

  const execution = new StaticExecutionAgent([
    { result: result({ nextAction: 'settle' }), criteria: criteria() },
  ]);
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const input = {
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  };

  const blocked = await manager.dispatch(input);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.assignment.status, 'planned');
  assert.equal(blocked.issue?.ownerId, 'orchestration-manager');
  assert.equal(blocked.issue?.nextAction.kind, 'wait');
  assert.equal(manager.listAssignments().length, 1);

  const released = await pool.release(held.lease, { scope });
  assert.equal(released.status, 'released');
  const retried = await manager.dispatch(input);
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.assignment.status, 'succeeded');
  assert.equal(retried.assignment.assignment.assignmentId, blocked.assignment.assignment.assignmentId);
  assert.equal(execution.inputs.length, 1);
});

test('feedback failures surface as blocked business outcomes instead of success', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const feedback = new RecordingFeedback();
  feedback.failOn = 'work-result';
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ nextAction: 'settle' }), criteria: criteria() },
    ]),
    feedback,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  });
  assert.equal(dispatched.status, 'blocked');
  assert.equal(dispatched.issue?.code, 'feedback-failed');
  assert.equal(dispatched.assignment.status, 'blocked');
});

test('attention results preserve recovery ownership and never become success', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const feedback = new RecordingFeedback();
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      {
        result: result({
          nextAction: 'attention',
          conditionRef: 'condition-a',
        }),
        criteria: criteria(),
      },
    ]),
    feedback,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  });
  assert.equal(dispatched.status, 'escalated');
  assert.equal(dispatched.assignment.status, 'escalated');
  assert.equal(dispatched.issue?.ownerId, 'orchestration-manager');
  assert.equal(feedback.events.some((event) => event.kind === 'attention'), true);
});

test('dispose retries a failed runtime cleanup and remains idempotent after success', async () => {
  const factory = new FakeRuntimeFactory();
  const { pool } = factoryPool({
    maxRuntimes: 1,
    factory,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const acquired = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  assert.equal(acquired.status, 'acquired');
  factory.disposeFailures.add('runtime-a');
  const failed = await pool.dispose();
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.alreadyDisposed, false);
  assert.equal(failed.issues[0]?.ownerId, 'orchestration-runtime-manager');
  assert.equal(failed.issues[0]?.nextAction.kind, 'recover');
  assert.equal(pool.inspect().runtimes[0]?.state, 'failed');
  assert.equal(pool.inspect().runtimes[0]?.lease?.assignmentId, 'assignment-a');

  factory.disposeFailures.delete('runtime-a');
  const retried = await pool.dispose();
  assert.equal(retried.status, 'disposed');
  assert.equal(retried.alreadyDisposed, true);
  assert.deepEqual(retried.issues, []);
  assert.equal(pool.inspect().runtimes[0]?.state, 'disposed');
  assert.equal(pool.inspect().runtimes[0]?.lease, undefined);
  assert.deepEqual(factory.disposeInputs, [
    {
      runtimeId: 'runtime-a',
      generation: 1,
      executionEpoch: 1,
      ownerId: 'orchestration-runtime-manager',
      assignmentId: 'assignment-a',
    },
    {
      runtimeId: 'runtime-a',
      generation: 1,
      executionEpoch: 1,
      ownerId: 'orchestration-runtime-manager',
      assignmentId: 'assignment-a',
    },
  ]);

  const secondRetry = await pool.dispose();
  assert.equal(secondRetry.status, 'disposed');
  assert.equal(secondRetry.alreadyDisposed, true);
  assert.equal(factory.disposeInputs.length, 2);
});

test('dispatch is idempotent for terminal assignments and duplicate work results do not repeat merge', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const execution = new StaticExecutionAgent([
    { result: result({ producedArtifactBodies: [artifactBody] }), criteria: criteria() },
  ]);
  let mergeCalls = 0;
  const merge: MergeCoordinatorPort = {
    async merge() {
      mergeCalls += 1;
      return { status: 'merged', evidenceRefs: [evidence('merge')] };
    },
  };
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    reviewAgent: new PassingReviewAgent(),
    mergeCoordinator: merge,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const input = {
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' as const }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality' as const],
    reviewSubjects: [{ ref: 'target-a', body: artifactBody }],
  };
  const first = await manager.dispatch(input);
  const repeated = await manager.dispatch(input);
  assert.equal(first.status, 'merged');
  assert.equal(repeated.status, 'merged');
  assert.equal(execution.inputs.length, 1);
  assert.equal(manager.get(assignment())?.status, 'merged');
  assert.equal((manager as unknown as { reviewAgent?: PassingReviewAgent }).reviewAgent?.kinds.length, 1);
  assert.equal(mergeCalls, 1);
});

test('dispatch is idempotent for succeeded terminal assignments', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const execution = new StaticExecutionAgent([
    { result: result({ nextAction: 'settle' }), criteria: criteria() },
  ]);
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const input = {
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  };
  const first = await manager.dispatch(input);
  const repeated = await manager.dispatch(input);
  assert.equal(first.status, 'succeeded');
  assert.equal(repeated.status, 'succeeded');
  assert.equal(execution.inputs.length, 1);
});

test('merge gate uses persisted review truth', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const firstReview = new PassingReviewAgent();
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ producedArtifactBodies: [artifactBody] }), criteria: criteria() },
    ]),
    reviewAgent: firstReview,
    mergeCoordinator: {
      async merge() {
        return { status: 'merged', evidenceRefs: [evidence('merge')] };
      },
    },
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjects: [{ ref: 'target-a', body: artifactBody }],
  });
  const stored = manager.get(assignment())?.reviewResults[0];
  assert.ok(stored);
  if (!stored) return;
  assert.equal(manager.get(assignment())?.reviewResults.length, 1);
});

test('assignment graph owner is injected by the orchestration manager and mismatches are rejected', () => {
  const { pool } = factoryPool();
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
  });
  assert.equal(manager.ownerId, 'orchestration-manager');
  const graph = new AssignmentGraph({ ownerId: 'other-owner' });
  assert.throws(
    () => createManager({
      ownerId: 'orchestration-manager',
      runtimePool: pool,
      graph,
    }),
    /owner does not match/,
  );
  graph.addStage({ nodeId: 'node-a', taskId: task });
  assert.equal(graph.createAssignment('node-a', assignment()).ownerId, 'other-owner');
});

test('blocked merge outcomes expose owner, reason, next action, and fallback evidence', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ producedArtifactBodies: [artifactBody] }), criteria: criteria() },
    ]),
    reviewAgent: new PassingReviewAgent(),
    mergeCoordinator: {
      async merge() {
        return {
          status: 'blocked',
          reason: 'merge blocked by external state',
          nextAction: { kind: 'recover', ref: 'merge.external-state' },
          evidenceRefs: [],
        };
      },
    },
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjects: [{ ref: 'target-a', body: artifactBody }],
  });
  assert.equal(dispatched.status, 'blocked');
  assert.equal(dispatched.issue?.ownerId, 'orchestration-manager');
  assert.ok(dispatched.issue?.reason);
  assert.deepEqual(dispatched.issue?.nextAction, { kind: 'recover', ref: 'merge.external-state' });
  assert.ok(dispatched.issue?.evidenceRefs.length);
  assert.ok(dispatched.assignment.evidenceRefs.length);
});

test('runtime startup cleanup uses full identity inputs and idle leases preserve generation', async () => {
  const factory = new FakeRuntimeFactory();
  const badIdentity = await new AgentRuntimePoolManager({ maxRuntimes: 1, factory }).acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  assert.equal(badIdentity.status, 'acquired');

  class BadRuntimeFactory extends FakeRuntimeFactory {
    override async start(input: Parameters<OrchestrationRuntimeFactoryPort['start']>[0]) {
      this.starts.push(input.runtimeId);
      this.startInputs.push(input);
      return {
        runtimeId: 'wrong-runtime',
        generation: input.generation,
        capabilities: [...input.requiredCapabilities],
      };
    }
  }
  const badFactory = new BadRuntimeFactory();
  const pool = new AgentRuntimePoolManager({ maxRuntimes: 1, factory: badFactory });
  const failed = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  assert.equal(failed.status, 'blocked');
  assert.deepEqual(badFactory.startInputs, [{
    runtimeId: 'orchestration-runtime-1',
    generation: 1,
    executionEpoch: 1,
    ownerId: 'orchestration-runtime-manager',
    assignmentId: 'assignment-a',
    requiredCapabilities: ['execute'],
    scope,
  }]);
  assert.deepEqual(badFactory.disposeInputs, [{
    runtimeId: 'orchestration-runtime-1',
    generation: 1,
    executionEpoch: 1,
    ownerId: 'orchestration-runtime-manager',
    assignmentId: 'assignment-a',
  }]);

  const goodFactory = new FakeRuntimeFactory();
  const growing = new AgentRuntimePoolManager({ maxRuntimes: 1, factory: goodFactory });
  const first = await growing.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    ...poolExecutionIdentity('assignment-a'),
    scope,
  });
  assert.equal(first.status, 'acquired');
  if (first.status !== 'acquired') return;
  assert.equal(first.lease.generation, 1);
  await growing.release(first.lease, { scope });
  const second = await growing.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 2,
    ...poolExecutionIdentity('assignment-b'),
    scope,
  });
  assert.equal(second.status, 'acquired');
  if (second.status !== 'acquired') return;
  assert.equal(second.lease.runtimeId, first.lease.runtimeId);
  assert.equal(second.lease.generation, 1);
  assert.equal(goodFactory.startInputs.length, 1);
  assert.equal(goodFactory.startInputs[0]?.assignmentId, 'assignment-a');
  await growing.release(second.lease, { scope });
});

test('acceptResult rejects late and released lease results while running binding matches', () => {
  const graph = new AssignmentGraph({ ownerId: 'orchestration-manager' });
  graph.addStage({ nodeId: 'node-a', taskId: task });
  graph.createAssignment('node-a', assignment());
  graph.assign(assignment(), 'agent-a', runtimeBinding);
  graph.start(assignment(), 'agent-a', runtimeBinding);

  const released = graph.acceptResult(assignment(), {
    result: result(),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    runtimeBinding: { ...runtimeBinding, leaseId: 'lease-released' },
  });
  assert.equal(released.accepted, false);
  if (released.accepted) return;
  assert.equal(released.code, 'stale-lease');

  const accepted = graph.acceptResult(assignment(), {
    result: result(),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    runtimeBinding,
  });
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  const late = graph.acceptResult(assignment(), {
    result: result({ summary: 'late different' }),
    expectedAgentId: 'agent-a',
    criteria: criteria(),
    runtimeBinding,
  });
  assert.equal(late.accepted, false);
  if (late.accepted) return;
  assert.equal(late.code, 'duplicate-conflict');
});

test('retry control stays out of business objective and all failure issues carry evidence', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const manager = createManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ status: 'failed', outputRefs: [], failureRef: 'failure-a' }), criteria: criteria({ satisfied: [], failed: ['failure-a'] }) },
    ]),
    maxAttempts: 2,
  });
  await manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
  });
  assert.equal(dispatched.status, 'retryable');
  assert.equal(dispatched.remediation?.objective, assignment().objective);
  assert.equal(dispatched.issue?.ownerId, 'orchestration-manager');
  assert.ok(dispatched.issue?.reason);
  assert.ok(dispatched.issue?.nextAction);
  assert.ok(dispatched.issue?.evidenceRefs.length);

  const missing = new AssignmentGraph({ ownerId: 'orchestration-manager' });
  assert.throws(
    () => missing.createAssignment('missing-stage', assignment()),
    (error: unknown) => error instanceof Error
      && 'evidenceRefs' in error
      && Array.isArray((error as { evidenceRefs?: unknown }).evidenceRefs)
      && (error as { evidenceRefs: unknown[] }).evidenceRefs.length > 0,
  );
});

const implicitOrgan = id('organ', 'implicit-brain-organ');
const implicitTask = id('task', 'implicit-brain-task');
const implicitScope: ScopeRef = { organId: implicitOrgan, taskId: implicitTask };

function implicitEvidence(label: string): EvidenceRef {
  const safeValue = label.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  return {
    evidenceId: id('evidence', `implicit-test-${safeValue}`),
    kind: 'operation',
    source: 'implicit-brain-test',
    locator: label,
    scope: implicitScope,
  };
}

class ImplicitRuntimeFactory implements OrchestrationRuntimeFactoryPort {
  async start(input: Parameters<OrchestrationRuntimeFactoryPort['start']>[0]) {
    return {
      runtimeId: input.runtimeId,
      generation: input.generation,
      capabilities: [...input.requiredCapabilities],
    };
  }

  async dispose(): Promise<void> {}
}

class ImplicitExecutor implements ExecutionAgentPort {
  readonly roleId = 'executor';
  readonly inputs: ExecutionAgentInput[] = [];

  constructor(private readonly failures = new Set<string>()) {}

  createInstance(create: TaskExecutionInstanceCreateInput): TaskExecutionHandle {
    return {
      incarnation: create.incarnation,
      execute: (input) => this.execute(input),
      async dispose() {},
    };
  }

  async execute(input: ExecutionAgentInput): Promise<WorkResult> {
    this.inputs.push(input);
    const assignment = input.assignment;
    if (this.failures.has(assignment.assignmentId)) {
      return {
        taskId: assignment.taskId,
        pipelineNodeId: assignment.pipelineNodeId,
        agentId: input.agentId,
        assignmentId: assignment.assignmentId,
        attempt: assignment.attempt,
        executionEpoch: assignment.executionEpoch,
        inputRevision: assignment.inputRevision,
        producedArtifactRefs: [],
        status: 'failed',
        summary: 'implicit executor failed',
        outputRefs: [],
        evidenceRefs: [implicitEvidence(`fail-${assignment.assignmentId}`)],
        nextAction: 'attention',
        failureRef: `asset://implicit/${assignment.assignmentId}/failure`,
      };
    }
    return {
      taskId: assignment.taskId,
      pipelineNodeId: assignment.pipelineNodeId,
      agentId: input.agentId,
      assignmentId: assignment.assignmentId,
      attempt: assignment.attempt,
      executionEpoch: assignment.executionEpoch,
      inputRevision: assignment.inputRevision,
      producedArtifactRefs: [...assignment.targetRefs],
      producedArtifactBodies: ['implicit artifact body'],
      status: 'succeeded',
      summary: 'implicit executor succeeded',
      outputRefs: [...assignment.expectedOutputRefs],
      evidenceRefs: [implicitEvidence(`ok-${assignment.assignmentId}`)],
      nextAction: 'review',
    };
  }
}

class ImplicitReviewAgent implements ReviewAgentPort {
  readonly roleId = 'reviewer';
  createInstance(create: TaskReviewInstanceCreateInput): TaskReviewHandle {
    return {
      incarnation: create.incarnation,
      review: async (input) => ({
        result: await this.review(input),
        output: { text: `review ${input.reviewAssignment.assignmentId}`, artifactRef: null, artifactDigest: null },
        completedAt: new Date().toISOString(),
      }),
      async dispose() {},
    };
  }
  readonly results: ReviewResult[] = [];

  async review(input: Parameters<ReviewAgentPort['review']>[0]): Promise<ReviewResult> {
    const reviewResult: ReviewResult = {
      resultId: `review-${input.reviewAssignment.assignmentId}`,
      assignmentId: input.reviewAssignment.assignmentId,
      taskId: input.reviewAssignment.taskId,
      workerAgentId: input.reviewAssignment.workerAgentId,
      reviewKind: input.reviewAssignment.reviewKind,
      attempt: input.reviewAssignment.attempt,
      executionEpoch: input.reviewAssignment.executionEpoch,
      inputRevision: input.reviewAssignment.inputRevision,
      subjectRefs: [...input.reviewAssignment.subjectRefs],
      status: 'passed',
      findings: [],
      evidenceRefs: [implicitEvidence(`review-${input.reviewAssignment.assignmentId}`)],
    };
    this.results.push(reviewResult);
    return reviewResult;
  }
}

function implicitAssembly(failures = new Set<string>()) {
  const factory = new ImplicitRuntimeFactory();
  const pool = new AgentRuntimePoolManager({
    maxRuntimes: 4,
    factory,
    initialRuntimes: [{ runtimeId: 'implicit-runtime', capabilities: ['provider.execution'] }],
  });
  const executor = new ImplicitExecutor(failures);
  const review = new ImplicitReviewAgent();
  const orchestration = createManager({
    ownerId: 'implicit-test',
    runtimePool: pool,
    executionAgent: executor,
    reviewAgent: review,
    maxAttempts: 1,
    taskId: implicitTask,
    organId: implicitOrgan,
  });
  return { orchestration, executor, review };
}

function implicitEnvelope(overrides: Partial<RequirementEnvelope> = {}): RequirementEnvelope {
  return {
    requirementId: 'requirement-implicit-a',
    draftId: 'draft-implicit-a',
    inputRevision: 1,
    intent: 'create',
    normalizedInput: 'find code evidence and write checkpoint',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-25T00:00:00.000Z',
    fifoSeq: 1,
    payloadRef: 'asset://requirements/implicit-a',
    ...overrides,
  };
}

async function appendImplicitConfirmed(inbox: RequirementInbox, envelope: RequirementEnvelope): Promise<void> {
  inbox.markConfirmed(envelope);
  await inbox.append(envelope);
}

function implicitDrainOptions() {
  return {
    taskId: implicitTask,
    scope: implicitScope,
    executionEpoch: 1,
    inputRevision: 1,
    queueLoad: { running: 0, queued: 0 },
    requiredCapabilities: ['code.search', 'file.checkpoint'],
    availableCapabilities: ['code.search', 'file.checkpoint'],
    health: 'healthy' as const,
    requiredInputRefs: ['asset://requirements/implicit-a'],
    providedInputRefs: ['asset://requirements/implicit-a'],
    checkpoint: { recoverable: true },
  };
}

test('implicit FIFO admits and dispatches executor subtasks to terminal success with evidence', async () => {
  const inbox = new RequirementInbox();
  await appendImplicitConfirmed(inbox, implicitEnvelope());
  const { orchestration, executor, review } = implicitAssembly();
  const brain = new ImplicitBrainFifo({
    inbox,
    consumerId: 'implicit-test',
    orchestration,
  });

  const result = await brain.drainNext(implicitDrainOptions());
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.dispatches.length, 1);
  assert.equal(executor.inputs.length, 1);
  assert.deepEqual(
    executor.inputs.map((input) => input.assignment.requiredCapabilities[0]),
    ['provider.execution'],
  );
  assert.equal(review.results.length, 1);
  assert.equal(result.evidenceRefs.length >= 2, true);
  assert.equal(inbox.size, 0);
});

test('implicit FIFO maxConcurrentTasks budget seam admits running one and waits at running two', async () => {
  const inbox = new RequirementInbox();
  await appendImplicitConfirmed(inbox, implicitEnvelope());
  const { orchestration } = implicitAssembly();
  const options = {
    inbox,
    consumerId: 'implicit-budget-test',
    orchestration,
    maxConcurrentTasks: 2,
  };
  const brain = new ImplicitBrainFifo(options);
  const second = await brain.drainNext({
    ...implicitDrainOptions(),
    queueLoad: { running: 1, queued: 0 },
  });
  assert.equal(second.kind, 'succeeded');
  if (second.kind !== 'succeeded') return;
  assert.equal(second.admission.decision.status, 'admitted');
  assert.equal(inbox.size, 0);

  const thirdEnvelope = implicitEnvelope({
    requirementId: 'requirement-implicit-third',
    draftId: 'draft-implicit-third',
    fifoSeq: 2,
  });
  await appendImplicitConfirmed(inbox, thirdEnvelope);
  await assert.rejects(
    () => brain.drainNext({
      ...implicitDrainOptions(),
      queueLoad: { running: 2, queued: 0 },
    }).catch((error: unknown) => {
      if (error instanceof RequirementAdmissionError) {
        assert.equal(error.decision.status, 'waiting');
        assert.equal(error.decision.condition, 'queue.execution.concurrency');
      }
      throw error;
    }),
    RequirementAdmissionError,
  );
  assert.equal(inbox.size, 1);
  assert.deepEqual(await inbox.peekNext({ consumerId: 'implicit-budget-test' }), thirdEnvelope);
});

test('implicit executor dispatch uses the execution agent override for every subtask', async () => {
  const envelope = implicitEnvelope();
  const admission = {
    classified: { envelope, queue: 'execution' as const },
    decision: {
      status: 'admitted' as const,
      queue: 'execution' as const,
      ownerId: 'implicit-test',
      condition: 'admitted',
      nextAction: { kind: 'continue', ref: 'orchestration.bind' } as const,
      reason: 'admission requirements are satisfied',
    },
  };
  const planInput = {
    envelope,
    admission,
    taskId: implicitTask,
    scope: implicitScope,
    executionEpoch: 1,
    inputRevision: 1,
  };
  const { orchestration } = implicitAssembly();
  const override = new ImplicitExecutor();
  const result = await dispatchImplicitExecutorSubtasks({
    orchestration,
    ...planInput,
    subtasks: createDefaultImplicitExecutorSubtasks(planInput),
    executionAgentOverride: override,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(override.inputs.length, 1);
  assert.deepEqual(
    override.inputs.map((input) => input.assignment.requiredCapabilities[0]),
    ['provider.execution'],
  );
});

test('implicit FIFO keeps a failed head pending and tracks evidence to terminal escalation', async () => {
  const inbox = new RequirementInbox();
  const envelope = implicitEnvelope();
  await appendImplicitConfirmed(inbox, envelope);
  const planInput = {
    envelope,
    admission: {
      classified: { envelope, queue: 'execution' as const },
      decision: {
        status: 'admitted' as const,
        queue: 'execution' as const,
        ownerId: 'implicit-test',
        condition: 'admitted',
        nextAction: { kind: 'continue', ref: 'orchestration.bind' } as const,
        reason: 'admission requirements are satisfied',
      },
    },
    taskId: implicitTask,
    scope: implicitScope,
    executionEpoch: 1,
    inputRevision: 1,
  };
  const plan = createDefaultImplicitExecutorSubtasks(planInput);
  const firstAssignmentId = plan[0]!.assignmentId;
  const { orchestration } = implicitAssembly(new Set([firstAssignmentId]));
  const brain = new ImplicitBrainFifo({
    inbox,
    consumerId: 'implicit-test',
    orchestration,
  });

  const result = await brain.drainNext(implicitDrainOptions());
  assert.equal(result.kind, 'escalated');
  if (result.kind !== 'escalated') return;
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.dispatches[0]?.assignment.assignment.assignmentId, firstAssignmentId);
  assert.equal(result.evidenceRefs.some((ref) => ref.locator.includes(`fail-${firstAssignmentId}`)), true);
  assert.equal(inbox.size, 1);
});

test('implicit FIFO lets the pre-admit retirement port remove a stale head before dispatch', async () => {
  const inbox = new RequirementInbox();
  await appendImplicitConfirmed(inbox, implicitEnvelope());
  const { orchestration, executor } = implicitAssembly();
  const retired: string[] = [];
  const brain = new ImplicitBrainFifo({
    inbox,
    consumerId: 'implicit-test',
    orchestration,
    retireHead: async ({ envelope, ownerId }) => {
      assert.equal(ownerId, 'humanagent.runtime.implicit');
      retired.push(envelope.requirementId);
      await inbox.retire({
        consumerId: 'implicit-test',
        requirementId: envelope.requirementId,
        code: 'task.not.found',
        message: 'stale head',
        retiredAt: '2026-09-25T00:00:00.000Z',
      });
      return true;
    },
  });

  const result = await brain.drainNext(implicitDrainOptions());
  assert.deepEqual(result, { kind: 'retired' });
  assert.deepEqual(retired, ['requirement-implicit-a']);
  assert.equal(executor.inputs.length, 0);
  assert.equal(inbox.size, 0);
});
