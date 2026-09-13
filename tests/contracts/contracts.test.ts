import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError, assertBusinessPayload, assertCapabilities, assertCheckpointLink, assertContextBudget, assertExecutionEpoch,
  assertNotExpired, assertSameScope, assertScope, id, validateRequirementEnvelope, validateWorkAssignment, validateWorkResult, type AgentMemoryContext,
  type AgentDriver, type AgentMemoryContextInjectionPort, type Checkpoint, type HarnessPluginContext, type MemoryOperationsPort,
  type NoveltyResult, type RecurrenceResult, type RequirementEnvelope, type ScopeRef, type WorkAssignment, type WorkResult,
} from '@humanagent/contracts';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: ScopeRef = { organId: organ, taskId: task };
const operation = id('operation', 'operation-a');
const operationScope: ScopeRef = { ...scope, operationId: operation };
const checkpoint = (seq: number, previousCheckpointId: Checkpoint['previousCheckpointId']): Checkpoint => ({
  id: id('checkpoint', `cp-${seq}`), scope, cycleId: id('cycle', 'cycle-a'), seq, previousCheckpointId,
  directiveRevision: 1, executionEpoch: 1, outcome: 'waiting', summary: 'fixture',
  recoveryStateRef: { evidenceId: id('evidence', `ev-${seq}`), kind: 'operation', source: 'test', locator: `fixture-${seq}`, scope },
  evidenceRefs: [], next: { kind: 'wait', ref: 'condition-a' },
});
const assignment: WorkAssignment = {
  assignmentId: 'assignment-a', taskId: task, pipelineNodeId: 'node-a', attempt: 1, executionEpoch: 1, inputRevision: 1,
  objective: 'inspect fixture', targetRefs: ['target-a'], expectedOutputRefs: ['output-a'], expectedArtifactDigests: ['sha256:artifact-a'], acceptanceCriteriaDigest: 'sha256:a',
  successCriteria: ['output exists'], failureCriteria: ['input unavailable'], incompleteCriteria: ['needs review'], requiredCapabilities: ['inspect'], mergeGate: 'not-required',
};
const successfulResult = (overrides: Partial<WorkResult> = {}): WorkResult => ({
  ...assignment, agentId: 'agent-a', producedArtifactRefs: ['artifact-a'], producedArtifactDigests: ['sha256:artifact-a'],
  status: 'succeeded', summary: 'done', outputRefs: ['output-a'], evidenceRefs: [], nextAction: 'settle', ...overrides,
});

test('positive minimum fixtures validate', () => {
  assert.doesNotThrow(() => validateWorkAssignment(assignment));
  assert.doesNotThrow(() => validateWorkResult(successfulResult(), assignment));
  assert.doesNotThrow(() => assertCheckpointLink(checkpoint(1, null), null));
});

test('rejects illegal scopes and epochs', () => {
  assert.throws(() => id('task', ''), ContractError);
  assert.throws(() => assertScope(id('cycle', 'cycle-a'), 'task'), ContractError);
  assert.throws(() => assertExecutionEpoch(0), ContractError);
  assert.throws(() => assertExecutionEpoch(-1), ContractError);
  assert.throws(() => assertNotExpired('2000-01-01T00:00:00Z'), ContractError);
});

test('rejects broken checkpoint predecessor chains', () => {
  const first = checkpoint(1, null);
  assert.throws(() => assertCheckpointLink(checkpoint(3, first.id), first), ContractError);
  assert.throws(() => assertCheckpointLink(checkpoint(2, id('checkpoint', 'missing')), first), ContractError);
  assert.throws(() => assertCheckpointLink({ ...checkpoint(1, null), executionEpoch: 0 }, null), ContractError);
  assert.throws(() => assertCheckpointLink({ ...checkpoint(1, null), executionEpoch: NaN }, null), ContractError);
  for (const seq of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertCheckpointLink({ ...checkpoint(seq, null), id: id('checkpoint', 'invalid-current') }, null), ContractError);
    assert.throws(() => assertCheckpointLink(checkpoint(2, first.id), { ...first, seq }), ContractError);
  }
});

test('rejects undeclared capabilities and over-budget context', () => {
  assert.throws(() => assertCapabilities(['inspect', 'write'], ['inspect']), ContractError);
  const context: AgentMemoryContext = { contextId: 'ctx-a', executionEpoch: 1, entries: [{ layer: 'current', summary: 'x', sourceRef: 'src', sourceDigest: 'sha256:x', scope: 'task', tokenCost: 9 }], omitted: [] };
  assert.throws(() => assertContextBudget(context, 8), ContractError);
  for (const tokenCost of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => assertContextBudget({ ...context, entries: [{ ...context.entries[0], tokenCost }] }, 10), ContractError);
  }
  for (const budget of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => assertContextBudget(context, budget), ContractError);
  }
});

test('rejects control fields in business payloads', () => {
  assert.throws(() => assertBusinessPayload({ answer: 'ok', steer: true }), ContractError);
});

test('validates requirement payload references, revisions, FIFO sequence, and confirmation time', () => {
  const envelope: RequirementEnvelope = {
    requirementId: 'r', draftId: 'd', inputRevision: 1, intent: 'create', normalizedInput: 'new task',
    confirmedBy: 'human', confirmedAt: '2026-09-11T00:00:00Z', fifoSeq: 1, payloadRef: 'asset://requirements/r-1',
  };
  assert.doesNotThrow(() => validateRequirementEnvelope(envelope));
  for (const payloadRef of ['', '   ']) {
    assert.throws(() => validateRequirementEnvelope({ ...envelope, payloadRef }), ContractError);
  }
  for (const inputRevision of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => validateRequirementEnvelope({ ...envelope, inputRevision }), ContractError);
  }
  for (const fifoSeq of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => validateRequirementEnvelope({ ...envelope, fifoSeq }), ContractError);
  }
  for (const confirmedAt of ['', 'not-a-time']) {
    assert.throws(() => validateRequirementEnvelope({ ...envelope, confirmedAt }), ContractError);
  }
});

test('rejects invalid assignment and result input/output', () => {
  assert.throws(() => validateWorkAssignment({ ...assignment, executionEpoch: 0 }), ContractError);
  for (const attempt of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => validateWorkAssignment({ ...assignment, attempt }), ContractError);
  }
  for (const inputRevision of [NaN, Infinity, 1.5, 0]) {
    assert.throws(() => validateWorkAssignment({ ...assignment, inputRevision }), ContractError);
  }
  assert.throws(() => validateWorkResult({ ...successfulResult(), executionEpoch: 2 }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), agentId: ' ' }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), outputRefs: ['unrelated-output'] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), outputRefs: ['output-a', 'unrelated-output'] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), producedArtifactDigests: [] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), producedArtifactDigests: ['sha256:other'] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult(), producedArtifactRefs: [''] }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...successfulResult({ status: 'incomplete', outputRefs: [] }), producedArtifactRefs: ['artifact-a'], producedArtifactDigests: [] }, assignment), ContractError);
  assert.throws(() => validateWorkResult(successfulResult({ status: 'blocked', outputRefs: [], producedArtifactRefs: ['artifact-a'], producedArtifactDigests: [''] }), assignment), ContractError);
  assert.throws(() => validateWorkResult(successfulResult({ status: 'cancelled', outputRefs: [], producedArtifactRefs: ['artifact-a'], producedArtifactDigests: ['sha256:other'] }), assignment), ContractError);
  assert.doesNotThrow(() => validateWorkResult(successfulResult({ status: 'incomplete', outputRefs: [], producedArtifactRefs: ['artifact-a'], producedArtifactDigests: ['sha256:artifact-a'] }), assignment));
  assert.throws(() => validateWorkResult({ ...assignment, agentId: 'agent-a', producedArtifactRefs: [], producedArtifactDigests: [], status: 'blocked', summary: 'paused', outputRefs: [], evidenceRefs: [], nextAction: 'wait' }, assignment), ContractError);
  assert.throws(() => validateWorkResult({ ...assignment, assignmentId: 'other', agentId: 'agent-a', producedArtifactRefs: [], producedArtifactDigests: [], status: 'failed', summary: 'failed', outputRefs: [], evidenceRefs: [], nextAction: 'attention', failureRef: 'failure-a' }, assignment), ContractError);
});

test('checkpoint links allow operation-bearing stops after business checkpoints and keep strict scope checks', async () => {
  const first = checkpoint(1, null);
  assert.doesNotThrow(() => assertCheckpointLink({ ...checkpoint(1, null), scope: operationScope }, null));
  assert.doesNotThrow(() => assertCheckpointLink({ ...checkpoint(2, first.id), scope: operationScope, outcome: 'stopped', next: { kind: 'stop', ref: 'stopped' } }, first));
  assert.throws(() => assertCheckpointLink({ ...checkpoint(2, first.id), scope: operationScope }, first), ContractError);
  const operationFirst = { ...checkpoint(1, null), scope: operationScope };
  assert.throws(() => assertCheckpointLink({
    ...checkpoint(2, operationFirst.id),
    scope: { ...scope, operationId: id('operation', 'operation-b') },
    outcome: 'stopped',
    next: { kind: 'stop', ref: 'stopped' },
  }, operationFirst), ContractError);
  assert.throws(() => assertSameScope(scope, operationScope), ContractError);
  for (const mismatch of [
    { ...scope, organId: id('organ', 'organ-b') },
    { ...scope, taskId: id('task', 'task-b') },
    { ...scope, cycleId: id('cycle', 'cycle-b') },
  ]) {
    assert.throws(() => assertCheckpointLink({ ...checkpoint(2, first.id), scope: mismatch }, first), ContractError);
  }
  const registered: { drivers: AgentDriver[]; memory: MemoryOperationsPort[]; context: AgentMemoryContextInjectionPort[] } = { drivers: [], memory: [], context: [] };
  const context: HarnessPluginContext = {
    registerCapability: () => undefined,
    registerAgentDriver: (driver) => registered.drivers.push(driver),
    registerMemoryOperations: (port) => registered.memory.push(port),
    registerAgentMemoryContextInjection: (port) => registered.context.push(port),
  };
  const driver = {} as AgentDriver;
  const injection = {} as AgentMemoryContextInjectionPort;
  const novelty: NoveltyResult = { classification: 'variant', matchedRefs: ['memory-a'], reason: 'same operation family' };
  const recurrence: RecurrenceResult = { classification: 'recurring', occurrences: [{ ref: 'memory-a', digest: 'sha256:memory-a' }], reason: 'seen twice' };
  const memory: MemoryOperationsPort = {
    ingest: async (input) => ({ sourceRef: input.sourceRef }),
    search: async () => [{ sourceRef: 'memory-a', summary: 'fixture' }],
    inspect: async (input) => ({ sourceRef: input.sourceRef, sourceDigest: 'sha256:memory-a', text: 'fixture' }),
    compare: async () => ({ relation: 'same' }),
    detectNovelty: async () => novelty,
    detectRecurrence: async () => recurrence,
  };
  context.registerAgentDriver(driver);
  context.registerMemoryOperations(memory);
  context.registerAgentMemoryContextInjection(injection);
  assert.deepEqual(registered, { drivers: [driver], memory: [memory], context: [injection] });
  assert.deepEqual(await memory.detectNovelty({ scope: { kind: 'task', organId: organ, taskId: task }, sourceRef: 'source-a', sourceDigest: 'sha256:source-a', candidateRef: 'candidate-a', comparisonRefs: ['memory-a'], limit: 10 }), novelty);
  assert.deepEqual(await memory.detectRecurrence({ scope: { kind: 'task', organId: organ, taskId: task }, patternRef: 'pattern-a', windowRefs: ['memory-a'], limit: 10 }), recurrence);
});
