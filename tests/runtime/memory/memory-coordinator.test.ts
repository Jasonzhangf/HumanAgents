import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryCoordinator,
  MemoryCoordinatorError,
  createMemoryInteractionPort,
  type SkillCandidate,
} from '../../../packages/runtime/src/memory/index.js';
import {
  type AgentMemoryContext,
  type AgentMemoryContextInjectionPort,
  type MemoryOperationsPort,
  type MemoryQueryRequest,
  type MemoryQueryResponse,
  type MemoryScope,
  type NoveltyResult,
  type RecurrenceResult,
  type TaskId,
  id,
} from '../../../packages/contracts/src/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const otherTask = id('task', 'task-b');
const taskScope: MemoryScope = { kind: 'task', organId: organ, taskId: task };
const taskProjectKey = 'project-a';
const taskAssignmentId = 'assignment-a';
const taskExecutionEpoch = 2;

function makeCandidate(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    candidateId: 'candidate-a',
    taskId: task,
    pattern: 'checkpoint settle timeout',
    proposedRule: 'bind checkpoint settle timeout to owner and next action',
    evidenceRefs: ['journal://task-a/1'],
    memoryRefs: ['memory://task-a/1'],
    runtimeSessionRefs: ['session://runtime-a/1'],
    uniqueness: 'unique',
    repeatability: 'recurring',
    value: 'review',
    ...overrides,
  };
}

function makeContext(input: { runtimeId: string; epoch: number; budget: number }): AgentMemoryContext {
  return {
    contextId: `ctx-${input.runtimeId}-${input.epoch}`,
    executionEpoch: input.epoch,
    entries: [{
      layer: 'current',
      summary: 'directive summary',
      sourceRef: 'journal://task-a/current',
      sourceDigest: 'sha256:current',
      scope: `task:${organ.value}:${task.value}`,
      tokenCost: 2,
    }],
    omitted: [],
    indexVersion: 'fake-memory-v1',
  };
}

function makePorts(overrides: {
  readonly context?: (input: { runtimeId: string; epoch: number; budget: number }) => AgentMemoryContext;
  readonly recallFailure?: () => never;
  readonly attachFailure?: () => never;
  readonly searchFailure?: () => never;
  readonly query?: (input: MemoryQueryRequest) => Promise<MemoryQueryResponse>;
} = {}): {
  readonly operations: MemoryOperationsPort;
  readonly injection: AgentMemoryContextInjectionPort;
  readonly calls: {
    recall: number;
    attach: number;
    search: number;
    ingest: number;
    review: number;
    query: number;
  };
} {
  const calls = { recall: 0, attach: 0, search: 0, ingest: 0, review: 0, query: 0 };
  const operations: MemoryOperationsPort = {
    ingest: async (input) => {
      calls.ingest += 1;
      return { sourceRef: input.sourceRef };
    },
    search: async () => {
      calls.search += 1;
      if (overrides.searchFailure) overrides.searchFailure();
      return [{ sourceRef: 'journal://task-a/current', summary: 'directive summary' }];
    },
    inspect: async (input) => ({ sourceRef: input.sourceRef, sourceDigest: 'sha256:current', text: 'text' }),
    compare: async () => ({ relation: 'same' }),
    detectNovelty: async (input): Promise<NoveltyResult> => ({ classification: 'novel', matchedRefs: [], reason: input.candidateRef }),
    detectRecurrence: async (): Promise<RecurrenceResult> => ({ classification: 'recurring', occurrences: [{ ref: 'journal://task-a/recur', digest: 'sha256:recur' }], reason: 'observed twice' }),
    query: async (input) => {
      calls.query += 1;
      if (overrides.query) return overrides.query(input);
      return { requestId: input.requestId, status: 'ready', entries: [], sourceFactRef: 'memory-query:test', omitted: [] };
    },
    submitCandidate: async (input) => ({
      submissionId: input.submissionId,
      status: 'accepted',
      candidateId: `candidate:${input.submissionId}`,
      operationId: input.operationId,
      nextAction: 'wait-analysis',
    }),
    reviewCandidate: async (input) => {
      calls.review += 1;
      return input;
    },
    promoteCandidate: async (input) => input,
    planForgetting: async (input) => input.plan,
  };
  const injection: AgentMemoryContextInjectionPort = {
    recall: async (input) => {
      calls.recall += 1;
      if (overrides.recallFailure) overrides.recallFailure();
      return (overrides.context ?? makeContext)({
        runtimeId: input.agentRuntimeId,
        epoch: input.executionEpoch,
        budget: input.tokenBudget,
      });
    },
    attach: async (input) => {
      calls.attach += 1;
      if (overrides.attachFailure) overrides.attachFailure();
      return { contextId: input.context.contextId, attached: true };
    },
  };
  return { operations, injection, calls };
}

function setup(overrides: {
  readonly failurePolicy?: 'waiting' | 'attention';
  readonly ports?: ReturnType<typeof makePorts>;
} = {}) {
  const coordinator = new MemoryCoordinator();
  const ports = overrides.ports ?? makePorts();
  const taskReceipt = coordinator.bindTask({
    taskId: task,
    assignmentId: taskAssignmentId,
    executionEpoch: taskExecutionEpoch,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://fake',
    indexVersion: 'fake-memory-v1',
    operations: ports.operations,
    injection: ports.injection,
    failurePolicy: overrides.failurePolicy,
  });
  const runtimeOutcome = coordinator.bindRuntime({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    assignmentId: taskAssignmentId,
    roleId: 'execution',
    executionEpoch: taskExecutionEpoch,
  });
  assert.equal(runtimeOutcome.status, 'ready');
  return { coordinator, ports, taskReceipt, runtimeBinding: runtimeOutcome.status === 'ready' ? runtimeOutcome.value : undefined };
}

test('memory coordinator recalls by bound scope, role, layer, query, budget, and epoch', async () => {
  const { coordinator, ports } = setup();
  const recallResult = await coordinator.recall({
    agentRuntimeId: 'runtime-a',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current'],
    query: 'directive',
    tokenBudget: 8,
    executionEpoch: 2,
    evidenceRequired: true,
  });
  assert.equal(recallResult.status, 'ready');
  assert.equal(ports.calls.recall, 1);
  assert.equal(ports.calls.search, 0);
  if (recallResult.status !== 'ready') throw new Error('expected recall to be ready');
  assert.equal(recallResult.value.contextId, 'ctx-runtime-a-2');
  assert.equal(recallResult.value.executionEpoch, 2);
  assert.deepEqual(recallResult.value.layers, ['current']);
  assert.equal(recallResult.value.entries[0].sourceRef, 'journal://task-a/current');
  assert.equal(recallResult.value.entries[0].sourceDigest, 'sha256:current');
  assert.equal(recallResult.value.indexVersion, 'fake-memory-v1');

  const attachResult = await coordinator.attach({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    scope: taskScope,
    executionEpoch: 2,
    context: {
      contextId: 'ctx-runtime-a-2',
      executionEpoch: 2,
      entries: [{
        layer: 'current',
        summary: 'directive summary',
        sourceRef: 'journal://task-a/current',
        sourceDigest: 'sha256:current',
        scope: `task:${organ.value}:${task.value}`,
        tokenCost: 2,
      }],
      omitted: [],
      indexVersion: 'fake-memory-v1',
    },
  });
  assert.equal(attachResult.status, 'ready');
  assert.equal(ports.calls.attach, 1);
  if (attachResult.status !== 'ready') throw new Error('expected attach to be ready');
  assert.equal(attachResult.value.bindingId, 'memory-binding:task-a');
  assert.equal(attachResult.value.entries[0].sourceDigest, 'sha256:current');
});

test('memory coordinator rejects recalled entries whose scope does not match the requested task', async () => {
  const baseContext = makeContext({ runtimeId: 'runtime-a', epoch: 2, budget: 8 });
  const crossTaskContext: AgentMemoryContext = {
    ...baseContext,
    contextId: 'ctx-task-b',
    entries: [
      {
        ...baseContext.entries[0],
        sourceRef: 'journal://task-b/current',
        sourceDigest: 'sha256:task-b-current',
        scope: `task:${organ.value}:${otherTask.value}`,
      },
      {
        ...baseContext.entries[0],
        sourceRef: 'journal://task-b/legacy',
        sourceDigest: 'sha256:task-b-legacy',
        scope: `task:${otherTask.value}`,
      },
    ],
  };
  const ports = makePorts({ context: () => crossTaskContext });
  const { coordinator } = setup({ ports });

  const recalled = await coordinator.recall({
    agentRuntimeId: 'runtime-a',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current'],
    query: 'directive',
    tokenBudget: 8,
    executionEpoch: 2,
    evidenceRequired: true,
  });
  assert.equal(recalled.status, 'attention');
  if (recalled.status !== 'attention') throw new Error('expected cross-task recall to be attention');
  assert.equal(recalled.issue.code, 'memory-context-invalid');
  assert.ok(recalled.issue.message.includes('scope does not match'));
  assert.equal(ports.calls.attach, 0);

  const attachWithoutRecall = await coordinator.attach({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    scope: taskScope,
    executionEpoch: 2,
    context: crossTaskContext,
  });
  assert.equal(attachWithoutRecall.status, 'attention');
  assert.equal(attachWithoutRecall.status === 'attention' && attachWithoutRecall.issue.code, 'memory-context-unbound');
});

test('memory coordinator exposes missing and mismatched bindings as owned issues', async () => {
  const coordinator = new MemoryCoordinator();
  const missing = await coordinator.recall({
    agentRuntimeId: 'missing-runtime',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current'],
    tokenBudget: 8,
    executionEpoch: 1,
    evidenceRequired: true,
  });
  assert.equal(missing.status, 'attention');
  if (missing.status !== 'attention') throw new Error('expected missing binding to be attention');
  assert.equal(missing.issue.code, 'memory-binding-missing');
  assert.equal(missing.issue.ownerId, 'memory-coordinator');
  assert.deepEqual(missing.issue.nextAction, { kind: 'recover', ref: 'memory-binding' });

  const ports = makePorts();
  coordinator.bindTask({
    taskId: task,
    assignmentId: taskAssignmentId,
    executionEpoch: taskExecutionEpoch,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://fake',
    operations: ports.operations,
    injection: ports.injection,
  });
  const bound = coordinator.bindRuntime({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    assignmentId: taskAssignmentId,
    roleId: 'execution',
    executionEpoch: taskExecutionEpoch,
  });
  assert.equal(bound.status, 'ready');
  const stale = coordinator.bindRuntime({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    assignmentId: taskAssignmentId,
    roleId: 'memory',
    executionEpoch: taskExecutionEpoch,
  });
  assert.equal(stale.status, 'attention');
  assert.equal(stale.status === 'attention' && stale.issue.code, 'memory-binding-mismatch');
});

test('memory coordinator rejects task runtime assignment and epoch drift', async () => {
  const coordinator = new MemoryCoordinator();
  const ports = makePorts();
  coordinator.bindTask({
    taskId: task,
    assignmentId: taskAssignmentId,
    executionEpoch: taskExecutionEpoch,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://fake',
    operations: ports.operations,
    injection: ports.injection,
  });

  const assignmentMismatch = coordinator.bindRuntime({
    agentRuntimeId: 'runtime-assignment-mismatch',
    taskId: task,
    assignmentId: 'assignment-other',
    roleId: 'execution',
    executionEpoch: taskExecutionEpoch,
  });
  assert.equal(assignmentMismatch.status, 'attention');
  assert.equal(assignmentMismatch.status === 'attention' && assignmentMismatch.issue.code, 'memory-binding-mismatch');

  const epochMismatch = coordinator.bindRuntime({
    agentRuntimeId: 'runtime-epoch-mismatch',
    taskId: task,
    assignmentId: taskAssignmentId,
    roleId: 'execution',
    executionEpoch: taskExecutionEpoch + 1,
  });
  assert.equal(epochMismatch.status, 'attention');
  assert.equal(epochMismatch.status === 'attention' && epochMismatch.issue.code, 'memory-binding-mismatch');
});

test('memory coordinator advances a task binding only with a new assignment and epoch', async () => {
  const coordinator = new MemoryCoordinator();
  const ports = makePorts();
  const base = {
    taskId: task,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://fake',
    indexVersion: 'fake-memory-v1',
    operations: ports.operations,
    injection: ports.injection,
  };
  const epochOneBinding = coordinator.bindTask({ ...base, assignmentId: 'assignment-a', executionEpoch: 1 });
  coordinator.bindRuntime({
    agentRuntimeId: 'runtime-epoch-1',
    taskId: task,
    assignmentId: 'assignment-a',
    roleId: 'execution',
    executionEpoch: 1,
  });
  const epochOne = await coordinator.recall({
    agentRuntimeId: 'runtime-epoch-1',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current'],
    tokenBudget: 8,
    executionEpoch: 1,
    evidenceRequired: true,
  });
  assert.equal(epochOne.status, 'ready');

  const advanced = coordinator.bindTask({ ...base, assignmentId: 'assignment-b', executionEpoch: 2 });
  assert.equal(advanced.assignmentId, 'assignment-b');
  assert.equal(advanced.executionEpoch, 2);
  const epochTwo = coordinator.bindRuntime({
    agentRuntimeId: 'runtime-epoch-2',
    taskId: task,
    assignmentId: 'assignment-b',
    roleId: 'execution',
    executionEpoch: 2,
  });
  assert.equal(epochTwo.status, 'ready');

  const staleRecall = await coordinator.recall({
    agentRuntimeId: 'runtime-epoch-1',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current'],
    tokenBudget: 8,
    executionEpoch: 1,
    evidenceRequired: true,
  });
  assert.equal(staleRecall.status, 'attention');
  assert.equal(staleRecall.status === 'attention' && staleRecall.issue.code, 'memory-binding-missing');
  const staleAttach = await coordinator.attach({
    agentRuntimeId: 'runtime-epoch-1',
    taskId: task,
    scope: taskScope,
    executionEpoch: 1,
    context: makeContext({ runtimeId: 'runtime-epoch-1', epoch: 1, budget: 8 }),
  });
  assert.equal(staleAttach.status, 'attention');
  assert.equal(staleAttach.status === 'attention' && staleAttach.issue.code, 'memory-binding-missing');
  const staleSearch = await coordinator.search({ agentRuntimeId: 'runtime-epoch-1', query: 'directive', limit: 5 });
  assert.equal(staleSearch.status, 'attention');
  assert.equal(staleSearch.status === 'attention' && staleSearch.issue.code, 'memory-binding-missing');
  const staleQuery = await coordinator.query({
    requestId: 'query-epoch-1',
    operationId: id('operation', 'query-epoch-1'),
    bindingRef: epochOneBinding.bindingId,
    actor: {
      actorId: 'actor-epoch-1',
      roleId: 'memory',
      permissions: ['memory.read'],
      projectKey: taskProjectKey,
    },
    projectKey: taskProjectKey,
    namespace: 'project',
    query: 'directive',
    kinds: ['semantic'],
    states: ['approved'],
    limit: 5,
    tokenBudget: 100,
    inputDigest: 'sha256:query-epoch-1',
  });
  assert.equal(staleQuery.status, 'attention');
  assert.equal(staleQuery.status === 'attention' && staleQuery.issue.code, 'memory-binding-missing');
});

test('memory coordinator rejects invalid binding advances without mutating current state', () => {
  const coordinator = new MemoryCoordinator();
  const ports = makePorts();
  const base = {
    taskId: task,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://fake',
    indexVersion: 'fake-memory-v1',
    operations: ports.operations,
    injection: ports.injection,
  };
  coordinator.bindTask({ ...base, assignmentId: 'assignment-a', executionEpoch: 2 });

  assert.throws(
    () => coordinator.bindTask({ ...base, assignmentId: 'assignment-a', executionEpoch: 3 }),
    MemoryCoordinatorError,
  );
  assert.throws(
    () => coordinator.bindTask({ ...base, assignmentId: 'assignment-b', executionEpoch: 2 }),
    MemoryCoordinatorError,
  );
  assert.throws(
    () => coordinator.bindTask({ ...base, assignmentId: 'assignment-b', executionEpoch: 1 }),
    MemoryCoordinatorError,
  );
  assert.throws(
    () => coordinator.bindTask({ ...base, assignmentId: 'assignment-b', executionEpoch: 3, scope: { kind: 'organ', organId: organ, taskId: task } }),
    MemoryCoordinatorError,
  );
  assert.throws(
    () => coordinator.bindTask({ ...base, assignmentId: 'assignment-b', executionEpoch: 3, backendRef: 'memory://other' }),
    MemoryCoordinatorError,
  );

  const stillCurrent = coordinator.bindRuntime({
    agentRuntimeId: 'runtime-current',
    taskId: task,
    assignmentId: 'assignment-a',
    roleId: 'execution',
    executionEpoch: 2,
  });
  assert.equal(stillCurrent.status, 'ready');
});

test('memory coordinator reuses a compatible project backend and rejects conflicts without partial binding', () => {
  const coordinator = new MemoryCoordinator();
  const firstPorts = makePorts();
  const conflictingPorts = makePorts();
  coordinator.bindTask({
    taskId: task,
    assignmentId: taskAssignmentId,
    executionEpoch: taskExecutionEpoch,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://first',
    operations: firstPorts.operations,
    injection: firstPorts.injection,
  });

  const reused = coordinator.bindTask({
    taskId: otherTask,
    assignmentId: 'assignment-b',
    executionEpoch: 1,
    projectKey: taskProjectKey,
    scope: { kind: 'task', organId: organ, taskId: otherTask },
    backendRef: 'memory://first',
    operations: firstPorts.operations,
    injection: firstPorts.injection,
  });
  assert.equal(reused.taskId.value, otherTask.value);

  const thirdTask = id('task', 'task-c');
  let conflict: unknown;
  try {
    coordinator.bindTask({
      taskId: thirdTask,
      assignmentId: 'assignment-c',
      executionEpoch: 1,
      projectKey: taskProjectKey,
      scope: { kind: 'task', organId: organ, taskId: thirdTask },
      backendRef: 'memory://conflict',
      operations: conflictingPorts.operations,
      injection: conflictingPorts.injection,
    });
  } catch (error) {
    conflict = error;
  }
  assert.ok(conflict instanceof MemoryCoordinatorError);
  if (!(conflict instanceof MemoryCoordinatorError)) throw new Error('expected project binding conflict');
  assert.ok(conflict.message.includes('memory backend binding conflicts'));
  const retry = coordinator.bindTask({
    taskId: thirdTask,
    assignmentId: 'assignment-c',
    executionEpoch: 1,
    projectKey: taskProjectKey,
    scope: { kind: 'task', organId: organ, taskId: thirdTask },
    backendRef: 'memory://first',
    operations: firstPorts.operations,
    injection: firstPorts.injection,
  });
  assert.equal(retry.taskId.value, thirdTask.value);
});

test('memory coordinator resolves candidate operations by canonical candidate identity, not insertion order', async () => {
  const coordinator = new MemoryCoordinator();
  const firstPorts = makePorts();
  const secondPorts = makePorts();
  const first = coordinator.bindInteraction({
    interactionScopeId: 'interaction-a',
    projectKey: 'project-a',
    backendRef: 'memory://first',
    operations: firstPorts.operations,
    injection: firstPorts.injection,
  });
  coordinator.bindInteraction({
    interactionScopeId: 'interaction-b',
    projectKey: 'project-b',
    backendRef: 'memory://second',
    operations: secondPorts.operations,
    injection: secondPorts.injection,
  });
  const actor = {
    actorId: 'actor-a',
    roleId: 'memory' as const,
    permissions: ['memory.read', 'memory.propose', 'memory.review', 'memory.promote'] as const,
    projectKey: 'project-a',
  };
  const submission = {
    submissionId: 'submission-a',
    requestId: 'request-a',
    operationId: id('operation', 'operation-a'),
    bindingRef: first.bindingId,
    actor,
    projectKey: 'project-a',
    requestedKind: 'semantic' as const,
    contentRef: 'asset://memory/candidate-a',
    contentDigest: 'sha256:candidate-a',
    evidenceRefs: ['journal://project-a/1'],
    observation: 'checkpoint commit is durable',
    desiredScope: 'project' as const,
    reason: 'observed at a lifecycle boundary',
    inputDigest: 'sha256:input-a',
  };
  const submitted = await coordinator.submitCandidate(submission);
  assert.equal(submitted.status, 'ready');

  const reviewed = await coordinator.reviewCandidate({
    candidateId: 'candidate:submission-a',
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'evidence is complete',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: ['journal://project-a/review'],
  });
  assert.equal(reviewed.status, 'ready');
  assert.equal(firstPorts.calls.review, 1);
  assert.equal(secondPorts.calls.review, 0);
});

test('memory coordinator rejects query, review, and promotion project drift', async () => {
  const coordinator = new MemoryCoordinator();
  const ports = makePorts();
  const interaction = coordinator.bindInteraction({
    interactionScopeId: 'interaction-project-a',
    projectKey: 'project-a',
    backendRef: 'memory://project-a',
    operations: ports.operations,
    injection: ports.injection,
  });
  const actor = {
    actorId: 'actor-a',
    roleId: 'review' as const,
    permissions: ['memory.read', 'memory.propose', 'memory.review', 'memory.promote'] as const,
    projectKey: 'project-b',
  };

  const queried = await coordinator.query({
    requestId: 'query-a',
    operationId: id('operation', 'query-a'),
    bindingRef: interaction.bindingId,
    actor: { ...actor, projectKey: 'project-b' },
    projectKey: 'project-b',
    namespace: 'project',
    query: 'checkpoint',
    kinds: ['semantic'],
    states: ['approved'],
    limit: 10,
    tokenBudget: 100,
    inputDigest: 'sha256:query-a',
  });
  assert.equal(queried.status, 'attention');
  assert.equal(queried.status === 'attention' && queried.issue.code, 'memory-binding-mismatch');

  const reviewed = await coordinator.reviewCandidate({
    candidateId: 'candidate-a',
    decision: 'approve',
    actor,
    decisionReason: 'evidence is complete',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: ['journal://project-a/review'],
  });
  assert.equal(reviewed.status, 'attention');
  assert.equal(reviewed.status === 'attention' && reviewed.issue.code, 'memory-binding-missing');

  const promoted = await coordinator.promoteCandidate({
    candidateId: 'candidate-a',
    from: 'project',
    to: 'global',
    actor,
    reason: 'stable across projects',
    impactScope: 'all projects',
    approvalRef: 'approval://global-promotion',
    approvalDigest: 'sha256:approval-global-promotion',
    sourceRefs: ['journal://project-a/1'],
    sourceDigests: ['sha256:a'],
    promotedAt: '2026-09-17T00:00:00Z',
  });
  assert.equal(promoted.status, 'attention');
  assert.equal(promoted.status === 'attention' && promoted.issue.code, 'memory-binding-missing');
});

test('memory coordinator denies global query without a cross-project grant before backend access', async () => {
  const coordinator = new MemoryCoordinator();
  const ports = makePorts();
  const interaction = coordinator.bindInteraction({
    interactionScopeId: 'interaction-project-a',
    projectKey: taskProjectKey,
    backendRef: 'memory://project-a',
    operations: ports.operations,
    injection: ports.injection,
  });
  const actor = {
    actorId: 'actor-a',
    roleId: 'memory' as const,
    permissions: ['memory.read'] as const,
    projectKey: taskProjectKey,
  };

  const queried = await coordinator.query({
    requestId: 'query-global',
    operationId: id('operation', 'query-global'),
    bindingRef: interaction.bindingId,
    actor,
    projectKey: taskProjectKey,
    namespace: 'global',
    query: 'fact',
    kinds: ['semantic'],
    states: ['approved'],
    limit: 10,
    tokenBudget: 100,
    inputDigest: 'sha256:query-global',
  });

  assert.equal(queried.status, 'attention');
  assert.equal(queried.status === 'attention' && queried.issue.code, 'memory-capability-denied');
  assert.equal(ports.calls.query, 0);
});

test('memory unavailable and attach failures are explicit, not fake RAG success', async () => {
  const ports = makePorts({
    recallFailure: () => { throw new Error('backend down'); },
  });
  const { coordinator } = setup({ failurePolicy: 'waiting', ports });
  const result = await coordinator.recall({
    agentRuntimeId: 'runtime-a',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current'],
    tokenBudget: 8,
    executionEpoch: 2,
    evidenceRequired: true,
  });
  assert.equal(result.status, 'waiting');
  assert.equal(ports.calls.search, 0);
  if (result.status !== 'waiting') throw new Error('expected memory unavailable to wait');
  assert.equal(result.issue.code, 'memory-context-unavailable');
  assert.equal(result.issue.ownerId, 'memory-coordinator');
  assert.deepEqual(result.issue.nextAction, { kind: 'wait', ref: 'memory-context-ready' });

  const attachCalls = makePorts({ attachFailure: () => { throw new Error('attach down'); } });
  const attachCoordinator = new MemoryCoordinator();
  attachCoordinator.bindTask({
    taskId: task,
    assignmentId: taskAssignmentId,
    executionEpoch: taskExecutionEpoch,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://fake',
    operations: attachCalls.operations,
    injection: attachCalls.injection,
    failurePolicy: 'attention',
  });
  attachCoordinator.bindRuntime({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    assignmentId: taskAssignmentId,
    roleId: 'execution',
    executionEpoch: taskExecutionEpoch,
  });
  await attachCoordinator.recall({
    agentRuntimeId: 'runtime-a',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current'],
    query: 'directive',
    tokenBudget: 8,
    executionEpoch: 2,
    evidenceRequired: true,
  });
  const attachResult = await attachCoordinator.attach({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    scope: taskScope,
    executionEpoch: 2,
    context: makeContext({ runtimeId: 'runtime-a', epoch: 2, budget: 8 }),
  });
  assert.equal(attachResult.status, 'attention');
  assert.equal(attachCalls.calls.attach, 1);
  if (attachResult.status !== 'attention') throw new Error('expected attach failure to be attention');
  assert.equal(attachResult.issue.code, 'memory-attach-unavailable');
  assert.deepEqual(attachResult.issue.nextAction, { kind: 'recover', ref: 'memory-attach-ready' });
});

test('memory coordinator rejects stale epochs, tampered context, and unbound attach', async () => {
  const { coordinator } = setup();
  await coordinator.recall({
    agentRuntimeId: 'runtime-a',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current'],
    query: 'directive',
    tokenBudget: 8,
    executionEpoch: 2,
    evidenceRequired: true,
  });

  const stale = await coordinator.attach({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    scope: taskScope,
    executionEpoch: 1,
    context: makeContext({ runtimeId: 'runtime-a', epoch: 1, budget: 8 }),
  });
  assert.equal(stale.status, 'attention');
  assert.equal(stale.status === 'attention' && stale.issue.code, 'memory-binding-mismatch');

  const recalledContext = makeContext({ runtimeId: 'runtime-a', epoch: 2, budget: 8 });
  const tamperedContext: AgentMemoryContext = {
    ...recalledContext,
    entries: recalledContext.entries.map((entry) => ({ ...entry, sourceDigest: 'sha256:tampered' })),
  };
  const tampered = await coordinator.attach({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    scope: taskScope,
    executionEpoch: 2,
    context: tamperedContext,
  });
  assert.equal(tampered.status, 'attention');
  if (tampered.status !== 'attention') throw new Error('expected tampered context to be attention');
  assert.equal(tampered.issue.code, 'memory-context-invalid');
  assert.equal(tampered.issue.nextAction.ref, 'memory-context-integrity');

  const unbound = await coordinator.attach({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    scope: taskScope,
    executionEpoch: 2,
    context: { ...makeContext({ runtimeId: 'runtime-a', epoch: 2, budget: 8 }), contextId: 'ctx-other' },
  });
  assert.equal(unbound.status, 'attention');
  assert.equal(unbound.status === 'attention' && unbound.issue.code, 'memory-context-unbound');
});

test('memory coordinator rejects an older recalled context after a newer recall', async () => {
  let sequence = 0;
  const ports = makePorts({
    context: (input) => ({
      ...makeContext(input),
      contextId: `ctx-${++sequence}`,
    }),
  });
  const { coordinator } = setup({ ports });
  const request = {
    agentRuntimeId: 'runtime-a',
    roleId: 'execution',
    taskId: task,
    scope: taskScope,
    layers: ['current' as const],
    query: 'directive',
    tokenBudget: 8,
    executionEpoch: 2,
    evidenceRequired: true,
  };
  await coordinator.recall(request);
  const first = makeContext({ runtimeId: 'runtime-a', epoch: 2, budget: 8 });
  await coordinator.recall(request);
  const second = makeContext({ runtimeId: 'runtime-a', epoch: 2, budget: 8 });

  const stale = await coordinator.attach({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    scope: taskScope,
    executionEpoch: 2,
    context: { ...first, contextId: 'ctx-1' },
  });
  assert.equal(stale.status, 'attention');
  assert.equal(stale.status === 'attention' && stale.issue.code, 'memory-context-unbound');

  const current = await coordinator.attach({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    scope: taskScope,
    executionEpoch: 2,
    context: { ...second, contextId: 'ctx-2' },
  });
  assert.equal(current.status, 'ready');
});

test('memory coordinator validates search and exposes search failures', async () => {
  const okCoordinator = new MemoryCoordinator();
  const okPorts = makePorts();
  okCoordinator.bindTask({
    taskId: task,
    assignmentId: taskAssignmentId,
    executionEpoch: taskExecutionEpoch,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://fake',
    operations: okPorts.operations,
    injection: okPorts.injection,
  });
  okCoordinator.bindRuntime({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    assignmentId: taskAssignmentId,
    roleId: 'memory',
    executionEpoch: taskExecutionEpoch,
  });
  const search = await okCoordinator.search({ agentRuntimeId: 'runtime-a', query: 'directive', limit: 5 });
  assert.equal(search.status, 'ready');
  if (search.status !== 'ready') throw new Error('expected search to succeed');
  assert.equal(search.value[0].sourceRef, 'journal://task-a/current');

  const downPorts = makePorts({ searchFailure: () => { throw new Error('search down'); } });
  const downCoordinator = new MemoryCoordinator();
  downCoordinator.bindTask({
    taskId: task,
    assignmentId: taskAssignmentId,
    executionEpoch: taskExecutionEpoch,
    projectKey: taskProjectKey,
    scope: taskScope,
    backendRef: 'memory://fake',
    operations: downPorts.operations,
    injection: downPorts.injection,
    failurePolicy: 'waiting',
  });
  downCoordinator.bindRuntime({
    agentRuntimeId: 'runtime-a',
    taskId: task,
    assignmentId: taskAssignmentId,
    roleId: 'memory',
    executionEpoch: taskExecutionEpoch,
  });
  const down = await downCoordinator.search({ agentRuntimeId: 'runtime-a', query: 'directive', limit: 5 });
  assert.equal(down.status, 'waiting');
  if (down.status !== 'waiting') throw new Error('expected search failure to wait');
  assert.equal(down.issue.code, 'memory-search-unavailable');
  assert.deepEqual(down.issue.nextAction, { kind: 'wait', ref: 'memory-operations-ready' });

  await assert.rejects(okCoordinator.search({ agentRuntimeId: 'runtime-a', query: '', limit: 5 }), MemoryCoordinatorError);
});

test('memory coordinator marks skill candidates review-required without auto-ingestion', () => {
  const { coordinator, ports } = setup();
  const review = coordinator.proposeSkillCandidate(makeCandidate());
  assert.equal(review.state, 'review-required');
  assert.equal(review.candidate.taskId.value, task.value);
  assert.equal(review.ownerId, 'memory-coordinator');
  assert.deepEqual(review.nextAction, { kind: 'wait', ref: 'skill-review:candidate-a' });
  assert.equal(ports.calls.ingest, 0);
  assert.throws(() => coordinator.proposeSkillCandidate(makeCandidate({ evidenceRefs: [] })), MemoryCoordinatorError);
  assert.throws(() => coordinator.proposeSkillCandidate(makeCandidate({ uniqueness: 'novel' as never })), MemoryCoordinatorError);
});

test('memory interaction port dispatches typed views and review through the coordinator', async () => {
  const { coordinator, ports } = setup();
  const actor = {
    actorId: 'interaction-agent',
    roleId: 'interaction' as const,
    permissions: ['memory.read', 'memory.propose', 'memory.review'] as const,
    projectKey: taskProjectKey,
  };
  const interaction = createMemoryInteractionPort({
    coordinator,
    bindingFor: ({ projectKey, namespace, taskId }) => (
      projectKey === taskProjectKey && namespace === 'project'
        ? { projectKey, namespace, ...(taskId === undefined ? {} : { taskId }), bindingRef: 'memory-binding:task-a' }
        : undefined
    ),
    now: () => '2026-09-17T00:00:00.000Z',
  });

  const handle = await interaction.open({
    actor,
    projectKey: taskProjectKey,
    namespace: 'project',
    taskId: task,
  });
  assert.equal(handle.readOnly, true);
  assert.equal(handle.actorId, actor.actorId);

  const view = await interaction.query({
    actor,
    projectKey: taskProjectKey,
    namespace: 'project',
    query: 'directive',
    limit: 5,
  });
  assert.equal(view.handle.projectKey, taskProjectKey);
  assert.equal(ports.calls.query, 1);

  const submission = {
    submissionId: 'interaction-submission-a',
    requestId: 'interaction-request-a',
    operationId: id('operation', 'interaction-operation-a'),
    bindingRef: 'memory-binding:task-a',
    actor,
    projectKey: taskProjectKey,
    taskId: task,
    requestedKind: 'semantic' as const,
    candidateCategory: 'project-fact' as const,
    contentRef: 'asset://memory/interaction-candidate-a',
    contentDigest: 'sha256:interaction-candidate-a',
    evidenceRefs: ['journal://task-a/1'],
    observation: 'checkpoint commit is durable',
    desiredScope: 'project' as const,
    reason: 'observed at a lifecycle boundary',
    inputDigest: 'sha256:interaction-input-a',
  };
  const submitted = await coordinator.submitCandidate(submission);
  assert.equal(submitted.status, 'ready');
  if (submitted.status !== 'ready' || submitted.value.candidateId === undefined) {
    throw new Error('expected interaction submission candidate');
  }

  const reviewed = await interaction.review({
    actor,
    candidateId: submitted.value.candidateId,
    decision: 'approve',
    decisionReason: 'evidence is complete',
  });
  assert.equal(reviewed.candidateId, submitted.value.candidateId);
  assert.equal(ports.calls.review, 1);

  await assert.rejects(
    () => interaction.open({
      actor,
      projectKey: taskProjectKey,
      namespace: 'global',
      taskId: task,
    }),
    /global memory view cannot be bound to a task/,
  );
});

test('memory interaction port verifies source digest pairs and compares by source digest', async () => {
  const entries = {
    'journal://task-a/1': {
      memoryId: 'memory-a',
      namespace: 'project' as const,
      kind: 'semantic' as const,
      state: 'approved' as const,
      summary: 'same summary',
      sourceRefs: ['journal://task-a/1'],
      sourceDigests: ['sha256:same'],
      projectKey: taskProjectKey,
      sourceScopeRef: `task:${organ.value}:${task.value}`,
      relevanceReason: 'exact source',
    },
    'journal://task-a/2': {
      memoryId: 'memory-b',
      namespace: 'project' as const,
      kind: 'semantic' as const,
      state: 'approved' as const,
      summary: 'same summary',
      sourceRefs: ['journal://task-a/2'],
      sourceDigests: ['sha256:same'],
      projectKey: taskProjectKey,
      sourceScopeRef: `task:${organ.value}:${task.value}`,
      relevanceReason: 'exact source',
    },
    'journal://task-a/3': {
      memoryId: 'memory-c',
      namespace: 'project' as const,
      kind: 'semantic' as const,
      state: 'approved' as const,
      summary: 'different summary',
      sourceRefs: ['journal://task-a/3'],
      sourceDigests: ['sha256:different'],
      projectKey: taskProjectKey,
      sourceScopeRef: `task:${organ.value}:${task.value}`,
      relevanceReason: 'exact source',
    },
  } as const;
  const { coordinator } = setup({
    ports: makePorts({
      query: async (input) => ({
        requestId: input.requestId,
        status: 'ready' as const,
        entries: [entries[input.query as keyof typeof entries]].filter(Boolean),
        sourceFactRef: 'memory-query:test',
        omitted: [],
      }),
    }),
  });
  const actor = {
    actorId: 'interaction-inspect-agent',
    roleId: 'interaction' as const,
    permissions: ['memory.read'] as const,
    projectKey: taskProjectKey,
  };
  const interaction = createMemoryInteractionPort({
    coordinator,
    bindingFor: ({ projectKey, namespace, taskId }) => (
      projectKey === taskProjectKey && namespace === 'project'
        ? { projectKey, namespace, ...(taskId === undefined ? {} : { taskId }), bindingRef: 'memory-binding:task-a' }
        : undefined
    ),
    now: () => '2026-09-17T00:00:00.000Z',
  });

  const detail = await interaction.inspect({
    actor,
    sourceRef: 'journal://task-a/1',
    sourceDigest: 'sha256:same',
  });
  assert.equal(detail.content, 'same summary');
  assert.equal(detail.sourceDigest, 'sha256:same');

  await assert.rejects(
    () => interaction.inspect({
      actor,
      sourceRef: 'journal://task-a/1',
      sourceDigest: 'sha256:wrong',
    }),
    /memory source is unavailable/,
  );

  const same = await interaction.compare({
    actor,
    leftRef: 'journal://task-a/1',
    rightRef: 'journal://task-a/2',
  });
  assert.equal(same.relation, 'same');
  assert.deepEqual(same.evidenceRefs, ['journal://task-a/1', 'journal://task-a/2']);

  const different = await interaction.compare({
    actor,
    leftRef: 'journal://task-a/1',
    rightRef: 'journal://task-a/3',
  });
  assert.equal(different.relation, 'different');

  const unknown = await interaction.compare({
    actor,
    leftRef: 'journal://task-a/1',
    rightRef: 'journal://task-a/missing',
  });
  assert.equal(unknown.relation, 'unknown');
});

test('memory interaction compare preserves coordinator denial instead of returning unknown', async () => {
  const { coordinator } = setup();
  const actor = {
    actorId: 'interaction-denied-agent',
    roleId: 'interaction' as const,
    permissions: [] as const,
    projectKey: taskProjectKey,
  };
  const interaction = createMemoryInteractionPort({
    coordinator,
    bindingFor: ({ projectKey, namespace, taskId }) => (
      projectKey === taskProjectKey && namespace === 'project'
        ? { projectKey, namespace, ...(taskId === undefined ? {} : { taskId }), bindingRef: 'memory-binding:task-a' }
        : undefined
    ),
  });

  await assert.rejects(
    () => interaction.compare({
      actor,
      leftRef: 'journal://task-a/1',
      rightRef: 'journal://task-a/2',
    }),
    /memory-capability-denied/,
  );
});
