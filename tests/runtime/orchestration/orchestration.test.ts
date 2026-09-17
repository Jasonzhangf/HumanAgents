import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import {
  AgentRuntimePoolManager,
  AssignmentGraph,
  OrchestrationManager,
  type ExecutionAgentInput,
  type ExecutionAgentPort,
  type MergeCoordinatorPort,
  type OrchestrationFeedbackEvent,
  type OrchestrationFeedbackPort,
  type OrchestrationRuntimeFactoryPort,
  type ReviewAgentPort,
} from '../../../packages/runtime/src/orchestration/index.js';
import type { ReviewResult } from '../../../packages/runtime/src/review/index.js';

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
  return {
    assignmentId: 'assignment-a',
    taskId: task,
    pipelineNodeId: 'node-a',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'execute bounded work',
    targetRefs: ['target-a'],
    expectedOutputRefs: ['output-a'],
    expectedArtifactDigests: ['sha256:artifact-a'],
    acceptanceCriteriaDigest: 'sha256:criteria-a',
    successCriteria: ['success-a'],
    failureCriteria: ['failure-a'],
    incompleteCriteria: ['incomplete-a'],
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
    producedArtifactDigests: ['sha256:artifact-a'],
    status: 'succeeded',
    summary: 'work completed',
    outputRefs: ['output-a'],
    evidenceRefs: [evidence('worker')],
    nextAction: 'review',
    ...overrides,
  };
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

  async start(input: Parameters<OrchestrationRuntimeFactoryPort['start']>[0]) {
    this.starts.push(input.runtimeId);
    this.startInputs.push(input);
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
  readonly inputs: ExecutionAgentInput[] = [];
  constructor(private readonly deliveries: readonly (WorkResult | { readonly result: WorkResult; readonly criteria: ReturnType<typeof criteria> })[]) {}

  async execute(input: ExecutionAgentInput): Promise<WorkResult> {
    this.inputs.push(input);
    const delivery = this.deliveries[Math.min(this.inputs.length - 1, this.deliveries.length - 1)];
    if (!delivery) throw new Error('missing execution delivery');
    return 'result' in delivery ? delivery.result : delivery;
  }
}

class PassingReviewAgent implements ReviewAgentPort {
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
      acceptanceCriteriaDigest: input.reviewAssignment.acceptanceCriteriaDigest,
      subjectRefs: [...input.reviewAssignment.subjectRefs],
      subjectDigests: [...input.reviewAssignment.subjectDigests],
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
    assignmentId: 'assignment-a',
    scope,
  });
  assert.equal(first.status, 'acquired');
  if (first.status !== 'acquired') return;
  assert.equal(first.lease.runtimeId, 'idle-a');
  assert.deepEqual(factory.starts, []);

  const second = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    assignmentId: 'assignment-b',
    scope,
  });
  assert.equal(second.status, 'acquired');
  if (second.status !== 'acquired') return;
  assert.equal(second.lease.runtimeId, 'orchestration-runtime-1');
  assert.deepEqual(factory.starts, ['orchestration-runtime-1']);

  const waiting = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    assignmentId: 'assignment-c',
    scope,
  });
  assert.equal(waiting.status, 'waiting');
  if (waiting.status === 'acquired') return;
  assert.equal(waiting.issue.conditionRef, 'orchestration.runtime.max');

  const blocked = await pool.acquire({
    requiredCapabilities: ['missing'],
    executionEpoch: 1,
    assignmentId: 'assignment-d',
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

test('runtime pool fences release by assignment, lease, generation, and execution epoch', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const acquired = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    assignmentId: 'assignment-a',
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

test('runtime pool cleans failed generation, advances on retry, and disposes the active generation once', async () => {
  const factory = new FakeRuntimeFactory();
  factory.startFailures.add('orchestration-runtime-1');
  const { pool } = factoryPool({ maxRuntimes: 1, factory });
  const acquired = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    assignmentId: 'assignment-a',
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
    assignmentId: 'assignment-b',
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
  assert.equal(accepted.record.status, 'succeeded');
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
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    maxAttempts: 1,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
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
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result(), criteria: criteria() },
    ]),
    reviewAgent: review,
    mergeCoordinator: merge,
    maxAttempts: 2,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: ['sha256:artifact-a'],
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
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result(), criteria: criteria() },
    ]),
    reviewAgent: review,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: ['sha256:artifact-a'],
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
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result(), criteria: criteria() },
    ]),
    reviewAgent: new PassingReviewAgent(),
    mergeCoordinator: merge,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: ['sha256:artifact-a'],
  });
  assert.equal(dispatched.status, 'merged');
  assert.equal(dispatched.assignment.status, 'merged');
  assert.equal(dispatched.mergeOutcome?.status, 'merged');
});

test('feedback failures surface as blocked business outcomes instead of success', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const feedback = new RecordingFeedback();
  feedback.failOn = 'work-result';
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ nextAction: 'settle' }), criteria: criteria() },
    ]),
    feedback,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
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
  const manager = new OrchestrationManager({
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
  manager.planStage({ nodeId: 'node-a', taskId: task });
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

test('dispose releases assigned runtimes and reports dispose failures', async () => {
  const factory = new FakeRuntimeFactory();
  const { pool } = factoryPool({
    maxRuntimes: 1,
    factory,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute'] }],
  });
  const acquired = await pool.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    scope,
  });
  assert.equal(acquired.status, 'acquired');
  factory.disposeFailures.add('runtime-a');
  const failed = await pool.dispose();
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.issues[0]?.ownerId, 'orchestration-runtime-manager');
  assert.equal(failed.issues[0]?.nextAction.kind, 'recover');
});

test('dispatch is idempotent for terminal assignments and duplicate work results do not repeat merge', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const execution = new StaticExecutionAgent([
    { result: result(), criteria: criteria() },
  ]);
  let mergeCalls = 0;
  const merge: MergeCoordinatorPort = {
    async merge() {
      mergeCalls += 1;
      return { status: 'merged', evidenceRefs: [evidence('merge')] };
    },
  };
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
    reviewAgent: new PassingReviewAgent(),
    mergeCoordinator: merge,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
  const input = {
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' as const }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality' as const],
    reviewSubjectDigests: ['sha256:artifact-a'],
  };
  const first = await manager.dispatch(input);
  const repeated = await manager.dispatch(input);
  assert.equal(first.status, 'merged');
  assert.equal(repeated.status, 'merged');
  assert.equal(execution.inputs.length, 1);
  assert.equal(manager.graph.get(assignment())?.status, 'merged');
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
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: execution,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
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

test('review result id conflicts are rejected and merge gate uses persisted review truth', async () => {
  const { pool } = factoryPool({
    maxRuntimes: 1,
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
  const firstReview = new PassingReviewAgent();
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([{ result: result(), criteria: criteria() }]),
    reviewAgent: firstReview,
    mergeCoordinator: {
      async merge() {
        return { status: 'merged', evidenceRefs: [evidence('merge')] };
      },
    },
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
  await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: ['sha256:artifact-a'],
  });
  const stored = manager.graph.get(assignment())?.reviewResults[0];
  assert.ok(stored);
  if (!stored) return;
  assert.throws(
    () => manager.graph.recordReviewResult(assignment(), { ...stored, status: 'failed', findings: [{
      findingId: 'finding-conflict',
      severity: 'blocker',
      locationRef: 'artifact-a',
      problem: 'conflict',
      expected: 'persisted truth',
      evidenceRefs: [evidence('conflict')],
    }] }),
    /conflicts with existing content/,
  );
  assert.throws(
    () => manager.graph.recordReviewResult(assignment(), {
      ...stored,
      evidenceRefs: [{ ...stored.evidenceRefs[0], locator: 'different-review-evidence' }],
    }),
    /conflicts with existing content/,
  );
});

test('assignment graph owner is injected by the orchestration manager and mismatches are rejected', () => {
  const { pool } = factoryPool();
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
  });
  assert.equal(manager.graph.ownerId, 'orchestration-manager');
  const graph = new AssignmentGraph({ ownerId: 'other-owner' });
  assert.throws(
    () => new OrchestrationManager({
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
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([{ result: result(), criteria: criteria() }]),
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
  manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment({ mergeGate: 'required' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: ['sha256:artifact-a'],
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
    assignmentId: 'assignment-a',
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
    assignmentId: 'assignment-a',
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
    assignmentId: 'assignment-a',
    scope,
  });
  assert.equal(first.status, 'acquired');
  if (first.status !== 'acquired') return;
  assert.equal(first.lease.generation, 1);
  await growing.release(first.lease, { scope });
  const second = await growing.acquire({
    requiredCapabilities: ['execute'],
    executionEpoch: 2,
    assignmentId: 'assignment-b',
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
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool,
    executionAgent: new StaticExecutionAgent([
      { result: result({ status: 'failed', outputRefs: [], failureRef: 'failure-a' }), criteria: criteria({ satisfied: [], failed: ['failure-a'] }) },
    ]),
    maxAttempts: 2,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
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
