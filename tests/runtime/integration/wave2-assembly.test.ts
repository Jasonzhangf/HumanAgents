import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AgentClosure,
  type AgentDriver,
  type Attention,
  type Checkpoint,
  type EvidenceRef,
  type MemoryScope,
  type OperationId,
  type RequirementEnvelope,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import { DeterministicMemoryBackend } from '../../../packages/adapters/memory/src/index.js';
import { FakeAgentDriver } from '../../../packages/adapters/testing/src/index.js';
import {
  AgentRuntime,
  bindAgentDriver,
  ConfirmationLedger,
  ExplicitIntake,
  HarnessNodeRuntime,
  MemoryCoordinator,
  NODE_STRATEGY_REFS,
  RequirementInbox,
  RequirementSubmissionOwner,
  appendTaskRevision,
  assertReviewAssignment,
  checkAdmission,
  classifyRequirement,
  completeCheckpoint,
  createReviewAssignments,
  createDefaultNodeStrategyRegistry,
  decideOrchestrationRuntimePool,
  executeStopControl,
  RuntimeError,
  recallCheckpoint,
  type AttentionPort,
  type CheckpointAppendReceipt,
  type CheckpointAppendRequest,
  type CheckpointChainVerification,
  CheckpointCompletionError,
  type CheckpointCommitPort,
  type CheckpointJournalPort,
  type LatestCheckpointRecord,
  type NodeStepResult,
} from '../../../packages/runtime/src/index.js';

const organ = id('organ', 'organ-wave2');
const task = id('task', 'task-wave2');
const cycle = id('cycle', 'cycle-wave2');
const scope: ScopeRef = { organId: organ, taskId: task, cycleId: cycle };
const requirementPayloadRef = 'asset://requirements/wave2';

function evidence(label: string, scopeRef: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'integration-test',
    locator: `records/${label}`,
    scope: scopeRef,
  };
}

function scopedStopEvidenceDriver(delegate: FakeAgentDriver, stopEvidenceRef: EvidenceRef): AgentDriver {
  return {
    kind: 'integration-test.scoped-stop',
    capabilities: () => delegate.capabilities(),
    start: (input) => delegate.start(input),
    resume: (input) => delegate.resume(input),
    submit: (input) => delegate.submit(input),
    observe: (input) => delegate.observe(input),
    requestStop: (input) => delegate.requestStop(input),
    settle: async () => ({ state: 'stopped', evidenceRefs: [stopEvidenceRef] }),
  };
}

class TestCheckpointJournal implements CheckpointJournalPort {
  latest: LatestCheckpointRecord | null = null;
  readonly appended: CheckpointAppendRequest[] = [];

  async verify(): Promise<CheckpointChainVerification> {
    return { valid: true };
  }

  async readLatest(): Promise<LatestCheckpointRecord | null> {
    return this.latest;
  }

  async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
    this.appended.push(input);
    this.latest = { checkpoint: input.checkpoint, previous: this.latest?.checkpoint ?? null };
    return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq };
  }
}

function checkpointPort(): { readonly port: CheckpointCommitPort; readonly commits: Checkpoint[] } {
  const commits: Checkpoint[] = [];
  return {
    commits,
    port: {
      async commit(checkpoint) {
        commits.push(checkpoint);
        return { checkpointId: checkpoint.id, committed: true };
      },
    },
  };
}

function attentionPort(): { readonly port: AttentionPort; readonly published: Attention[]; readonly resolved: Attention[] } {
  const published: Attention[] = [];
  const resolved: Attention[] = [];
  return {
    published,
    resolved,
    port: {
      async publish(input) {
        published.push(input);
        return { attentionId: input.attentionId, delivered: true };
      },
      async resolve(input) {
        resolved.push(input);
        return { attentionId: input.attentionId, delivered: true };
      },
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

class PostCommitMarkStoppedFailureRuntime extends AgentRuntime {
  private closeAttempts = 0;

  override markStopped(_operationId: OperationId, _closure: AgentClosure): void {
    this.closeAttempts += 1;
    if (this.closeAttempts === 1) throw new RuntimeError('forced post-commit runtime close failure');
    super.markStopped(_operationId, _closure);
  }
}

async function confirmRequirement(): Promise<{
  readonly inbox: RequirementInbox;
  readonly envelope: RequirementEnvelope;
}> {
  const inbox = new RequirementInbox();
  const intake = new ExplicitIntake();
  const ledger = new ConfirmationLedger();
  const submissions = new RequirementSubmissionOwner(ledger, inbox, {
    async submit(envelope) { return { requirementId: envelope.requirementId }; },
  });
  const interactionId = await intake.receive({
    sourceRef: 'ui:task-wave2',
    rawInput: 'append integration evidence',
    channel: 'business',
  });
  await intake.beginMatching(interactionId);
  await intake.recordMatch(interactionId, {
    normalizedInput: 'append integration evidence',
    matchedTasks: [{ taskId: task, relation: 'current', status: 'running' }],
    knownFacts: ['task already exists'],
  });
  await intake.propose(interactionId, {
    proposedIntent: 'append',
    proposal: 'append the confirmed integration input to the running task',
  });
  const snapshot = await intake.inspect(interactionId);
  assert.ok(snapshot.draft);
  const confirmed = await intake.prepareConfirmation({
    draftId: snapshot.draft.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:requirement-wave2',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-11T00:00:00.000Z',
    payloadRef: requirementPayloadRef,
  });
  ledger.registerDraft({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    inputRevision: confirmed.inputRevision,
    normalizedInput: confirmed.normalizedInput,
    intent: confirmed.intent,
    taskRef: confirmed.taskRef,
    payloadRef: confirmed.payloadRef,
  });
  ledger.confirm({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    inputRevision: confirmed.inputRevision,
    confirmationRef: confirmed.confirmationRef,
    confirmedBy: confirmed.confirmedBy,
    confirmedAt: confirmed.confirmedAt,
  });
  const receipt = await submissions.submit({
    interactionId: confirmed.interactionId,
    draftId: confirmed.draftId,
    confirmationRef: confirmed.confirmationRef,
    inputRevision: confirmed.inputRevision,
  });
  const envelope = inbox.find(receipt.draftId);
  assert.ok(envelope);
  await intake.markDraftDispatched(envelope.draftId);
  return { inbox, envelope };
}

test('confirmed intake flows through admission, node execution, checkpoint, and memory context', async () => {
  const { inbox, envelope } = await confirmRequirement();
  const consumed = await inbox.readNext({ consumerId: 'runtime-coordinator' });
  assert.deepEqual(consumed, envelope);
  assert.ok(consumed);

  const classified = classifyRequirement({
    envelope: consumed,
    queue: 'execution',
    registeredQueues: ['interactive', 'execution', 'research', 'maintenance'],
  });
  const admission = checkAdmission({
    queue: { kind: classified.queue, concurrencyLimit: 1, maxBacklog: 2 },
    queueLoad: { running: 0, queued: 0 },
    requiredCapabilities: ['execution'],
    availableCapabilities: ['execution'],
    health: 'healthy',
    requiredInputRefs: [requirementPayloadRef],
    providedInputRefs: [requirementPayloadRef],
    checkpoint: { recoverable: true },
    businessPayload: { request: 'append integration evidence' },
  });
  assert.equal(admission.status, 'admitted');

  const revision = appendTaskRevision({ envelope: consumed });
  assert.equal(revision.status, 'updated');
  assert.equal(revision.task.revisions.length, 1);

  const pool = decideOrchestrationRuntimePool({
    pool: { maxRuntimes: 1, runtimes: [] },
    requiredCapabilities: ['execution'],
  });
  assert.equal(pool.action, 'spawn');
  assert.equal(pool.runtimeId, 'orchestration-runtime-1');

  const driver = new FakeAgentDriver({ 'assignment-wave2': 'succeeded' });
  const agentRuntime = new AgentRuntime(driver, {
    runtimeId: 'runtime-wave2',
    taskId: task,
    assignmentId: 'assignment-wave2',
    organId: id('organ', 'fake-organ'),
    cycleId: cycle,
    operationId: id('operation', 'operation-wave2'),
    executionEpoch: 1,
    ownerRef: 'agent-runtime-owner',
    recoveryRef: 'runtime-recovery',
  });
  await agentRuntime.start();

  const nodeRuntime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  const nodeScope: ScopeRef = { organId: id('organ', 'fake-organ'), taskId: task, cycleId: cycle };
  nodeRuntime.admit({
    nodeId: 'node-wave2-execute',
    parentNodeId: null,
    nodeKind: 'execution',
    orchestrationPolicyRef: NODE_STRATEGY_REFS.serial,
    inputRefs: [requirementPayloadRef],
    outputContractRef: 'wave2-output',
    ownerRef: 'node-owner',
    executionEpoch: 1,
    scope: nodeScope,
  });
  const plan = nodeRuntime.plan({
    nodeId: 'node-wave2-execute',
    executionEpoch: 1,
    items: [{
      stepId: 'execute',
      kind: 'execution',
      execute: async (): Promise<NodeStepResult> => {
        const output = await agentRuntime.submit({ request: 'append integration evidence' });
        const closure = await agentRuntime.settle();
        return {
          stepId: 'execute',
          state: closure.state,
          summary: 'fake agent executed the admitted requirement',
          outputRefs: output.outputRefs,
          evidenceRefs: closure.evidenceRefs,
          nextAction: closure.nextAction,
          conditionRef: closure.conditionRef,
          failureRef: closure.failureRef,
        };
      },
    }],
  });
  const dispatched = await nodeRuntime.dispatch({
    nodeId: 'node-wave2-execute',
    policyRef: NODE_STRATEGY_REFS.serial,
    executionEpoch: 1,
    scope: nodeScope,
    ownerRef: 'node-owner',
    plan,
  });
  assert.equal(dispatched.closure.state, 'succeeded');
  const observationEvidence = evidence('node-observe', nodeScope);
  const observation = nodeRuntime.observe({
    nodeId: 'node-wave2-execute',
    executionEpoch: 1,
    evidenceRefs: [observationEvidence],
  });
  const nodeClosure = nodeRuntime.settle({
    nodeId: 'node-wave2-execute',
    executionEpoch: 1,
    observation,
  });
  assert.equal(nodeClosure.evidenceRefs.length, 2);
  const fakeEvidence = nodeClosure.evidenceRefs.find((evidenceRef) => evidenceRef.source === 'humanagent.fake');
  assert.ok(fakeEvidence);
  assert.equal(fakeEvidence.scope.organId.value, 'fake-organ');
  assert.equal(fakeEvidence.scope.taskId?.value, task.value);
  assert.ok(fakeEvidence.scope.operationId);
  assert.equal(fakeEvidence.scope.cycleId?.value, cycle.value);

  const checkpointEvidenceRefs = nodeClosure.evidenceRefs.filter(
    (evidenceRef) => evidenceRef === observationEvidence,
  );
  assert.deepEqual(checkpointEvidenceRefs, [observationEvidence]);
  assert.deepEqual(checkpointEvidenceRefs[0]?.scope, nodeScope);

  const journal = new TestCheckpointJournal();
  assert.equal(await recallCheckpoint(journal, { ownerId: 'task-owner', scope: nodeScope }), null);
  const checkpoint: Checkpoint = {
    id: id('checkpoint', 'checkpoint-wave2-1'),
    scope: nodeScope,
    cycleId: cycle,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'succeeded',
    summary: 'wave 2 integration cycle succeeded',
    recoveryStateRef: evidence('recovery-wave2-1', nodeScope),
    evidenceRefs: checkpointEvidenceRefs,
    next: { kind: 'continue', ref: 'next-wave2-cycle' },
  };
  assert.deepEqual(checkpoint.scope, nodeScope);
  assert.equal(checkpoint.evidenceRefs[0], observationEvidence);
  await assert.rejects(
    async () => completeCheckpoint(journal, {
      ownerId: 'task-owner',
      context: { scope: nodeScope, cycleId: cycle, executionEpoch: 1, directiveRevision: 1 },
      previous: null,
      checkpoint: { ...checkpoint, evidenceRefs: [fakeEvidence] },
    }),
    CheckpointCompletionError,
  );
  assert.equal(journal.appended.length, 0);
  const completed = await completeCheckpoint(journal, {
    ownerId: 'task-owner',
    context: { scope: nodeScope, cycleId: cycle, executionEpoch: 1, directiveRevision: 1 },
    previous: null,
    checkpoint,
  });
  assert.equal(completed.receipt.seq, 1);
  assert.equal(journal.appended.length, 1);
  const recalled = await recallCheckpoint(journal, { ownerId: 'task-owner', scope: nodeScope });
  assert.equal(recalled?.checkpoint.id.value, 'checkpoint-wave2-1');

  const memoryScope: MemoryScope = { kind: 'task', organId: organ, taskId: task };
  const memoryBackend = new DeterministicMemoryBackend();
  memoryBackend.addContextEntry({
    scope: memoryScope,
    sourceRef: 'journal://task-wave2/checkpoint-wave2-1',
    sourceDigest: 'sha256:checkpoint-wave2-1',
    text: 'wave 2 integration cycle succeeded with deterministic evidence',
    layer: 'current',
    summary: 'wave 2 integration cycle succeeded',
  });
  const memory = new MemoryCoordinator();
  memory.bindTask({
    taskId: task,
    assignmentId: 'assignment-wave2',
    executionEpoch: 1,
    projectKey: 'project-wave2',
    scope: memoryScope,
    backendRef: 'memory://deterministic',
    indexVersion: memoryBackend.indexVersion,
    operations: memoryBackend,
    injection: memoryBackend,
  });
  const runtimeMemoryBinding = memory.bindRuntime({
    agentRuntimeId: 'runtime-wave2',
    taskId: task,
    assignmentId: 'assignment-wave2',
    roleId: 'execution',
    executionEpoch: 1,
  });
  assert.equal(runtimeMemoryBinding.status, 'ready');
  const memoryRequest = {
    agentRuntimeId: 'runtime-wave2',
    roleId: 'execution',
    taskId: task,
    scope: memoryScope,
    layers: ['current' as const],
    query: 'integration cycle',
    tokenBudget: 8,
    executionEpoch: 1,
    evidenceRequired: true,
  };
  const rawContext = await memoryBackend.recall(memoryRequest);
  const contextReceipt = await memory.recall(memoryRequest);
  assert.equal(contextReceipt.status, 'ready');
  if (contextReceipt.status !== 'ready') throw new Error('expected memory context');
  assert.equal(contextReceipt.value.entries[0]?.sourceDigest, 'sha256:checkpoint-wave2-1');
  const attached = await memory.attach({
    agentRuntimeId: 'runtime-wave2',
    taskId: task,
    scope: memoryScope,
    executionEpoch: 1,
    context: rawContext,
  });
  assert.equal(attached.status, 'ready');
});

test('stop control settles through the assembled checkpoint and attention ports', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-wave2': 'stopped' });
  const runtime = new AgentRuntime(delegate, {
    runtimeId: 'runtime-stop-wave2',
    taskId: task,
    assignmentId: 'assignment-stop-wave2',
    executionEpoch: 4,
    ownerRef: 'integration-test-agent-runtime',
  });
  await runtime.start();
  await runtime.submit({ request: 'stop integration evidence' });
  const operation = delegate.replay().at(-1);
  assert.ok(operation);

  const stopCycle = id('cycle', 'cycle-wave2-stop');
  const stopScope: ScopeRef = {
    organId: organ,
    taskId: task,
    cycleId: stopCycle,
    operationId: operation.operationId,
  };
  const stopEvidenceRef = evidence('stop-agent', stopScope);
  const driver = scopedStopEvidenceDriver(delegate, stopEvidenceRef);
  bindAgentDriver(runtime, driver);
  const store = checkpointPort();
  const attention = attentionPort();
  const result = await executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: 'runtime-stop-wave2',
    },
    driver,
    checkpointPort: store.port,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: operation.operationId,
    scope: stopScope,
    cycleId: stopCycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('stop-recovery', stopScope),
    runtime,
  });

  assert.equal(result.state, 'stopped');
  if (result.state !== 'stopped') throw new Error('expected stopped checkpoint');
  assert.equal(result.checkpoint.outcome, 'stopped');
  assert.equal(store.commits.length, 1);
  assert.equal(store.commits[0]?.id.value, result.checkpoint.id.value);
  assert.deepEqual(store.commits[0]?.scope, stopScope);
  assert.deepEqual(store.commits[0]?.evidenceRefs[0], stopEvidenceRef);
  assert.equal(attention.published.length, 0);
});

test('stop control accepts a business-scoped predecessor and commits an operation-scoped stopped checkpoint', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-predecessor': 'stopped' });
  const runtime = new AgentRuntime(delegate, {
    runtimeId: 'runtime-stop-predecessor',
    taskId: task,
    assignmentId: 'assignment-stop-predecessor',
    executionEpoch: 4,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ request: 'stop after business checkpoint' });
  const operation = delegate.replay().at(-1);
  assert.ok(operation);
  assert.equal(runtime.snapshot().state, 'running');

  const stopCycle = id('cycle', 'cycle-wave2-stop-predecessor');
  const businessScope: ScopeRef = { organId: organ, taskId: task, cycleId: stopCycle };
  const previousCheckpointId = id('checkpoint', 'checkpoint-business-predecessor');
  const previousCheckpoint: Checkpoint = {
    id: previousCheckpointId,
    scope: businessScope,
    cycleId: stopCycle,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 4,
    outcome: 'succeeded',
    summary: 'ordinary business checkpoint before stop',
    recoveryStateRef: evidence('business-recovery', businessScope),
    evidenceRefs: [evidence('business-evidence', businessScope)],
    next: { kind: 'continue', ref: 'next-business-cycle' },
  };
  const journal = new TestCheckpointJournal();
  await completeCheckpoint(journal, {
    ownerId: 'control-owner',
    context: { scope: businessScope, cycleId: stopCycle, executionEpoch: 4, directiveRevision: 1 },
    previous: null,
    checkpoint: previousCheckpoint,
  });
  const recalled = await recallCheckpoint(journal, { ownerId: 'control-owner', scope: businessScope });
  assert.ok(recalled);
  assert.equal(recalled.checkpoint.id.value, previousCheckpointId.value);
  assert.equal(recalled.checkpoint.scope.operationId, undefined);
  assert.equal(journal.appended.length, 1);
  assert.deepEqual(journal.latest?.checkpoint, previousCheckpoint);

  const stopScope: ScopeRef = {
    organId: organ,
    taskId: task,
    cycleId: stopCycle,
    operationId: operation.operationId,
  };
  const stopEvidenceRef = evidence('stop-predecessor', stopScope);
  const stopRecoveryRef = evidence('stop-predecessor-recovery', stopScope);
  const driver = scopedStopEvidenceDriver(delegate, stopEvidenceRef);
  bindAgentDriver(runtime, driver);
  const store = checkpointPort();
  const attention = attentionPort();
  const result = await executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: 'runtime-stop-predecessor',
    },
    driver,
    checkpointPort: store.port,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: operation.operationId,
    scope: stopScope,
    cycleId: stopCycle,
    ownerId: 'control-owner',
    previousCheckpoint: recalled.checkpoint,
    checkpointSeq: 2,
    directiveRevision: 1,
    stopReason: 'operator-steer',
    recoveryStateRef: stopRecoveryRef,
    runtime,
  });

  assert.equal(result.state, 'stopped');
  if (result.state !== 'stopped') throw new Error('expected stopped checkpoint');
  assert.equal(result.checkpoint.outcome, 'stopped');
  assert.equal(result.checkpoint.previousCheckpointId?.value, previousCheckpointId.value);
  assert.deepEqual(result.checkpoint.scope, stopScope);
  assert.deepEqual(result.checkpoint.recoveryStateRef, stopRecoveryRef);
  assert.deepEqual(result.checkpoint.evidenceRefs, [stopEvidenceRef]);
  assert.equal(store.commits.length, 1);
  assert.deepEqual(store.commits[0]?.scope, stopScope);
  assert.deepEqual(store.commits[0]?.recoveryStateRef, stopRecoveryRef);
  assert.deepEqual(store.commits[0]?.evidenceRefs, [stopEvidenceRef]);
  assert.equal(attention.published.length, 0);
});

test('stop control closes the bound AgentRuntime work entry after stopped settle', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-runtime': 'stopped' });
  const runtime = new AgentRuntime(delegate, {
    runtimeId: 'runtime-stop-runtime',
    taskId: task,
    assignmentId: 'assignment-stop-runtime',
    executionEpoch: 4,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ request: 'close stop evidence' });
  const operation = delegate.replay().at(-1);
  assert.ok(operation);
  assert.equal(runtime.snapshot().state, 'running');

  const stopCycle = id('cycle', 'cycle-stop-runtime');
  const stopScope: ScopeRef = { organId: organ, taskId: task, cycleId: stopCycle, operationId: operation.operationId };
  const stopEvidenceRef = evidence('stop-agent-runtime', stopScope);
  const driver = scopedStopEvidenceDriver(delegate, stopEvidenceRef);
  bindAgentDriver(runtime, driver);
  const store = checkpointPort();
  const attention = attentionPort();
  const result = await executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: 'runtime-stop-runtime',
    },
    driver,
    checkpointPort: store.port,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: operation.operationId,
    scope: stopScope,
    cycleId: stopCycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('stop-runtime-recovery', stopScope),
    runtime,
  });

  assert.equal(result.state, 'stopped');
  if (result.state !== 'stopped') throw new Error('expected stopped receipt');
  assert.equal(runtime.snapshot().state, 'stopped');
  assert.equal(runtime.snapshot().closure?.state, 'stopped');
  assert.deepEqual(runtime.snapshot().closure?.evidenceRefs, [stopEvidenceRef]);
  assert.equal(store.commits.length, 1);
  assert.equal(attention.published.length, 0);

  await assert.rejects(async () => runtime.submit({ request: 'after stop' }), RuntimeError);
  await assert.rejects(async () => {
    for await (const _observation of runtime.observe()) {
      break;
    }
  }, RuntimeError);
});

test('active stop claim fences submit and observe until claim release', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-fence': 'succeeded' });
  const runtime = new AgentRuntime(delegate, {
    runtimeId: 'runtime-stop-fence',
    taskId: task,
    assignmentId: 'assignment-stop-fence',
    executionEpoch: 4,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ request: 'before stop claim' });
  const operation = delegate.replay().at(-1);
  assert.ok(operation);
  runtime.beginStop(
    runtime.binding.runtimeId,
    runtime.binding.executionEpoch,
    operation.operationId,
    'agent-runtime-owner',
    { ...scope, operationId: operation.operationId },
  );
  assert.equal(runtime.snapshot().state, 'running');

  await assert.rejects(() => runtime.submit({ request: 'after stop claim' }), RuntimeError);
  await assert.rejects(async () => {
    for await (const _observation of runtime.observe()) {
      break;
    }
  }, RuntimeError);

  runtime.releaseStopClaim(operation.operationId);
  const retry = await runtime.submit({ request: 'after claim release' });
  assert.equal(retry.assignmentId, 'assignment-stop-fence');
});

test('stop claim fences submit and observe while stop settle is in flight', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-settle-fence': 'stopped' });
  const runtime = new AgentRuntime(delegate, {
    runtimeId: 'runtime-stop-settle-fence',
    taskId: task,
    assignmentId: 'assignment-stop-settle-fence',
    executionEpoch: 4,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ request: 'stop settle fence evidence' });
  const operation = delegate.replay().at(-1);
  assert.ok(operation);
  assert.equal(runtime.snapshot().state, 'running');

  const stopCycle = id('cycle', 'cycle-stop-settle-fence');
  const stopScope: ScopeRef = {
    organId: organ,
    taskId: task,
    cycleId: stopCycle,
    operationId: operation.operationId,
  };
  const stopEvidenceRef = evidence('stop-settle-fence', stopScope);
  const controlSettleStarted = deferred<void>();
  const releaseControlSettle = deferred<void>();
  let settleCalls = 0;
  const driver: AgentDriver = {
    kind: 'integration-test.stop-settle-fence',
    capabilities: () => delegate.capabilities(),
    start: (input) => delegate.start(input),
    resume: (input) => delegate.resume(input),
    submit: (input) => delegate.submit(input),
    observe: (input) => delegate.observe(input),
    requestStop: (input) => delegate.requestStop(input),
    settle: async () => {
      const call = settleCalls++;
      if (call === 0) {
        controlSettleStarted.resolve();
        await releaseControlSettle.promise;
        return { state: 'stopped', evidenceRefs: [stopEvidenceRef] };
      }
      throw new Error('stop settle fence must settle only through stop control');
    },
  };
  bindAgentDriver(runtime, driver);
  const control = executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: 'runtime-stop-settle-fence',
    },
    driver,
    checkpointPort: checkpointPort().port,
    attentionPort: attentionPort().port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: operation.operationId,
    scope: stopScope,
    cycleId: stopCycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('stop-settle-fence-recovery', stopScope),
    runtime,
  });
  await controlSettleStarted.promise;

  await assert.rejects(() => runtime.submit({ request: 'after stop claim' }), RuntimeError);
  await assert.rejects(async () => {
    for await (const _observation of runtime.observe()) {
      break;
    }
  }, RuntimeError);

  releaseControlSettle.resolve();
  const result = await control;
  assert.equal(result.state, 'stopped');
  if (result.state !== 'stopped') throw new Error('expected stopped receipt');
  assert.equal(runtime.snapshot().state, 'stopped');
});

test('stop control owns AgentRuntime settle before committing a stopped checkpoint', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-race': 'stopped' });
  const runtime = new AgentRuntime(delegate, {
    runtimeId: 'runtime-stop-race',
    taskId: task,
    assignmentId: 'assignment-stop-race',
    executionEpoch: 4,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ request: 'stop race evidence' });
  const operation = delegate.replay().at(-1);
  assert.ok(operation);
  assert.equal(runtime.snapshot().state, 'running');

  const stopCycle = id('cycle', 'cycle-stop-race');
  const stopScope: ScopeRef = { organId: organ, taskId: task, cycleId: stopCycle, operationId: operation.operationId };
  const stopEvidenceRef = evidence('stop-race', stopScope);
  const runtimeSettleEvidenceRef = evidence('runtime-settle-race', stopScope);
  const controlSettleStarted = deferred<void>();
  const releaseControlSettle = deferred<void>();
  let settleCalls = 0;
  const driver: AgentDriver = {
    kind: 'integration-test.stop-race',
    capabilities: () => delegate.capabilities(),
    start: (input) => delegate.start(input),
    resume: (input) => delegate.resume(input),
    submit: (input) => delegate.submit(input),
    observe: (input) => delegate.observe(input),
    requestStop: (input) => delegate.requestStop(input),
    settle: async (input) => {
      const call = settleCalls++;
      if (call === 0) {
        controlSettleStarted.resolve();
        await releaseControlSettle.promise;
        return { state: 'stopped', evidenceRefs: [stopEvidenceRef] };
      }
      return { state: 'succeeded', evidenceRefs: [runtimeSettleEvidenceRef] };
    },
  };
  bindAgentDriver(runtime, driver);

  const control = executeStopControl({
    command: {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running',
      runtimeId: 'runtime-stop-race',
    },
    driver,
    checkpointPort: checkpointPort().port,
    attentionPort: attentionPort().port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: operation.operationId,
    scope: stopScope,
    cycleId: stopCycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('stop-race-recovery', stopScope),
    runtime,
  });
  await controlSettleStarted.promise;
  const concurrentSettle = runtime.settle();
  releaseControlSettle.resolve();

  const [stoppedResult, settleResult] = await Promise.allSettled([control, concurrentSettle]);
  assert.equal(stoppedResult.status, 'fulfilled');
  if (stoppedResult.status !== 'fulfilled') throw new Error('expected stop control to settle');
  assert.equal(stoppedResult.value.state, 'stopped');
  assert.equal(runtime.snapshot().state, 'stopped');
  assert.equal(settleResult.status, 'rejected');
  if (settleResult.status !== 'rejected') throw new Error('runtime.settle must not race stop control');
  assert.ok(settleResult.reason instanceof RuntimeError);
});

test('stop control cannot claim a runtime whose ordinary settle is already in flight', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-reverse-race': 'succeeded' });
  const settleStarted = deferred<void>();
  const releaseSettle = deferred<void>();
  const driver: AgentDriver = {
    kind: 'integration-test.stop-reverse-race',
    capabilities: () => delegate.capabilities(),
    start: (input) => delegate.start(input),
    resume: (input) => delegate.resume(input),
    submit: (input) => delegate.submit(input),
    observe: (input) => delegate.observe(input),
    requestStop: (input) => delegate.requestStop(input),
    settle: async () => {
      settleStarted.resolve();
      await releaseSettle.promise;
      return { state: 'succeeded', evidenceRefs: [] };
    },
  };
  const runtime = new AgentRuntime(driver, {
    runtimeId: 'runtime-stop-reverse-race',
    taskId: task,
    assignmentId: 'assignment-stop-reverse-race',
    executionEpoch: 4,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ request: 'ordinary settle reverse race' });
  const settle = runtime.settle();
  await settleStarted.promise;
  const stopCycle = id('cycle', 'cycle-stop-reverse-race');
  const stopOperation = id('operation', 'operation-stop-reverse-race');
  const stopScope: ScopeRef = { organId: organ, taskId: task, cycleId: stopCycle, operationId: stopOperation };
  await assert.rejects(
    () => executeStopControl({
      command: {
        source: 'control',
        command: 'steer.request-stop',
        actorKind: 'human-operator',
        hasStopPermission: true,
        organId: organ,
        taskId: task,
        executionEpoch: 4,
        currentState: 'running',
        runtimeId: 'runtime-stop-reverse-race',
      },
      driver,
      checkpointPort: checkpointPort().port,
      attentionPort: attentionPort().port,
      currentOrganId: organ,
      currentTaskId: task,
      currentEpoch: 4,
      operationId: stopOperation,
      scope: stopScope,
      cycleId: stopCycle,
      ownerId: 'control-owner',
      previousCheckpoint: null,
      checkpointSeq: 1,
      directiveRevision: 1,
      stopReason: 'operator-steer',
      recoveryStateRef: evidence('stop-reverse-race-recovery', stopScope),
      runtime,
    }),
    RuntimeError,
  );
  releaseSettle.resolve();
  const closure = await settle;
  assert.equal(closure.state, 'succeeded');
  assert.equal(runtime.snapshot().state, 'succeeded');
});

test('concurrent stop control rejects the second controller before duplicate driver or checkpoint work', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-concurrent': 'stopped' });
  const runtime = new AgentRuntime(delegate, {
    runtimeId: 'runtime-stop-concurrent',
    taskId: task,
    assignmentId: 'assignment-stop-concurrent',
    executionEpoch: 4,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ request: 'concurrent stop evidence' });
  const operation = delegate.replay().at(-1);
  assert.ok(operation);
  assert.equal(runtime.snapshot().state, 'running');

  const stopCycle = id('cycle', 'cycle-stop-concurrent');
  const stopScope: ScopeRef = { organId: organ, taskId: task, cycleId: stopCycle, operationId: operation.operationId };
  const secondOperationId = id('operation', 'operation-stop-concurrent-alt');
  const secondStopScope: ScopeRef = { ...stopScope, operationId: secondOperationId };
  const stopEvidenceRef = evidence('stop-concurrent', stopScope);
  const controlSettleStarted = deferred<void>();
  const releaseControlSettle = deferred<void>();
  let requestStopCalls = 0;
  let settleCalls = 0;
  const driver: AgentDriver = {
    kind: 'integration-test.stop-concurrent',
    capabilities: () => delegate.capabilities(),
    start: (input) => delegate.start(input),
    resume: (input) => delegate.resume(input),
    submit: (input) => delegate.submit(input),
    observe: (input) => delegate.observe(input),
    requestStop: async (input) => {
      requestStopCalls += 1;
      return { requested: true, operationId: input.operationId };
    },
    settle: async () => {
      const call = settleCalls++;
      if (call === 0) {
        controlSettleStarted.resolve();
        await releaseControlSettle.promise;
        return { state: 'stopped', evidenceRefs: [stopEvidenceRef] };
      }
      throw new Error('second stop controller must not settle');
    },
  };
  bindAgentDriver(runtime, driver);
  const store = checkpointPort();
  const attention = attentionPort();
  const stopCommand = {
    source: 'control' as const,
    command: 'steer.request-stop' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    organId: organ,
    taskId: task,
    executionEpoch: 4,
    currentState: 'running' as const,
    runtimeId: 'runtime-stop-concurrent',
  };
  const firstControl = executeStopControl({
    command: stopCommand,
    driver,
    checkpointPort: store.port,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: operation.operationId,
    scope: stopScope,
    cycleId: stopCycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('stop-concurrent-recovery', stopScope),
    runtime,
  });
  await controlSettleStarted.promise;
  const secondControl = executeStopControl({
    command: stopCommand,
    driver,
    checkpointPort: store.port,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: secondOperationId,
    scope: secondStopScope,
    cycleId: stopCycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('stop-concurrent-recovery-alt', secondStopScope),
    runtime,
  });
  await assert.rejects(() => secondControl, RuntimeError);
  releaseControlSettle.resolve();

  const result = await firstControl;
  if (result.state !== 'stopped') throw result.failure;
  assert.equal(result.state, 'stopped');
  assert.equal(runtime.snapshot().state, 'stopped');
  assert.equal(requestStopCalls, 1);
  assert.equal(settleCalls, 1);
  assert.equal(store.commits.length, 1);
  assert.equal(attention.published.length, 0);
});

test('post-commit AgentRuntime close failure tracks and resolves a retry attention', async () => {
  const delegate = new FakeAgentDriver({ 'assignment-stop-post-commit': 'stopped' });
  const runtime = new PostCommitMarkStoppedFailureRuntime(delegate, {
    runtimeId: 'runtime-stop-post-commit',
    taskId: task,
    assignmentId: 'assignment-stop-post-commit',
    executionEpoch: 4,
    ownerRef: 'agent-runtime-owner',
  });
  await runtime.start();
  await runtime.submit({ request: 'post commit close failure' });
  const operation = delegate.replay().at(-1);
  assert.ok(operation);
  assert.equal(runtime.snapshot().state, 'running');

  const stopCycle = id('cycle', 'cycle-stop-post-commit');
  const stopScope: ScopeRef = {
    organId: organ,
    taskId: task,
    cycleId: stopCycle,
    operationId: operation.operationId,
  };
  const stopEvidenceRef = evidence('stop-post-commit', stopScope);
  const baseDriver = scopedStopEvidenceDriver(delegate, stopEvidenceRef);
  let settleCalls = 0;
  const driver: AgentDriver = {
    ...baseDriver,
    settle: async (input) => {
      settleCalls += 1;
      return baseDriver.settle(input);
    },
  };
  bindAgentDriver(runtime, driver);
  const commits: Checkpoint[] = [];
  let failFirstCommit = true;
  const store: CheckpointCommitPort = {
    async commit(checkpoint) {
      if (failFirstCommit) {
        failFirstCommit = false;
        throw new Error('forced initial stopped checkpoint commit failure');
      }
      commits.push(checkpoint);
      return { checkpointId: checkpoint.id, committed: true };
    },
  };
  const attention = attentionPort();

  const stopInput = {
    command: {
      source: 'control' as const,
      command: 'steer.request-stop' as const,
      actorKind: 'human-operator' as const,
      hasStopPermission: true,
      organId: organ,
      taskId: task,
      executionEpoch: 4,
      currentState: 'running' as const,
      runtimeId: 'runtime-stop-post-commit',
    },
    driver,
    checkpointPort: store,
    attentionPort: attention.port,
    currentOrganId: organ,
    currentTaskId: task,
    currentEpoch: 4,
    operationId: operation.operationId,
    scope: stopScope,
    cycleId: stopCycle,
    ownerId: 'control-owner',
    previousCheckpoint: null,
    checkpointSeq: 1,
    directiveRevision: 1,
    stopReason: 'operator-steer',
    recoveryStateRef: evidence('stop-post-commit-recovery', stopScope),
    runtime,
  };
  const first = await executeStopControl(stopInput);
  assert.equal(first.state, 'settling');
  if (first.state !== 'settling') throw new Error('expected initial stop settlement failure');
  const originalAttentionId = `stop-pending-${operation.operationId.value}`;
  assert.equal(first.attentionId, originalAttentionId);
  assert.equal(attention.published.length, 1);
  assert.equal(attention.published[0]?.attentionId, originalAttentionId);
  assert.equal(settleCalls, 1);
  assert.equal(commits.length, 0);
  const pending = runtime.pendingStopSettlement(operation.operationId);
  assert.ok(pending);
  assert.equal(pending.checkpointCommitted, false);
  await assert.rejects(
    () => executeStopControl(stopInput),
    RuntimeError,
  );
  assert.equal(pending.checkpointCommitted, false);
  const committed = runtime.pendingStopSettlement(operation.operationId);
  assert.ok(committed);
  assert.equal(committed.checkpointCommitted, true);
  assert.equal(settleCalls, 1);
  assert.equal(commits.length, 1);
  assert.deepEqual(attention.published.map((item) => item.attentionId), [originalAttentionId, originalAttentionId]);
  assert.equal(attention.published[1]?.ownerId, 'control-owner');
  assert.deepEqual(attention.published[1]?.nextAction, { kind: 'recover', ref: `stop-runtime-mismatch:${operation.operationId.value}` });
  assert.equal(attention.published[0]?.ownerId, 'control-owner');
  assert.equal(runtime.stopAttentionForCompletion(operation.operationId), originalAttentionId);
  await assert.rejects(() => runtime.submit({ request: 'after checkpoint/runtime mismatch' }), RuntimeError);
  await assert.rejects(async () => {
    for await (const _observation of runtime.observe()) {
      break;
    }
  }, RuntimeError);

  const retry = await executeStopControl(stopInput);
  assert.equal(retry.state, 'stopped');
  assert.equal(runtime.snapshot().state, 'stopped');
  assert.equal(settleCalls, 1);
  assert.equal(commits.length, 1);
  assert.equal(runtime.pendingStopSettlement(operation.operationId), undefined);
  assert.equal(attention.published.length, 2);
  assert.equal(attention.resolved.length, 1);
  assert.equal(attention.resolved[0]?.attentionId, originalAttentionId);
  assert.equal(attention.resolved[0]?.state, 'resolved');
  assert.deepEqual(attention.resolved.map((item) => item.attentionId), [originalAttentionId]);
  assert.equal(runtime.stopAttention(operation.operationId), undefined);
});

test('runtime public entrypoint exposes security and delivery review assignments', () => {
  const workAssignment: WorkAssignment = {
    assignmentId: 'assignment-review-wave2',
    taskId: task,
    pipelineNodeId: 'node-review-wave2',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'audit security and delivery readiness',
    targetRefs: ['subject-wave2'],
    expectedOutputRefs: ['review-wave2'],
    expectedArtifactDigests: ['sha256:review-wave2'],
    acceptanceCriteriaDigest: 'sha256:review-criteria-wave2',
    successCriteria: ['security and delivery reviews pass'],
    failureCriteria: ['review binding is invalid'],
    incompleteCriteria: ['review evidence is incomplete'],
    requiredCapabilities: ['worker.execute', 'test'],
    mergeGate: 'not-required',
  };
  const workResult: WorkResult = {
    taskId: task,
    pipelineNodeId: workAssignment.pipelineNodeId,
    agentId: 'agent-review-wave2',
    assignmentId: workAssignment.assignmentId,
    attempt: workAssignment.attempt,
    executionEpoch: workAssignment.executionEpoch,
    inputRevision: workAssignment.inputRevision,
    producedArtifactRefs: ['review-wave2'],
    producedArtifactDigests: ['sha256:review-wave2'],
    status: 'succeeded',
    summary: 'ready for security and delivery review',
    outputRefs: ['review-wave2'],
    evidenceRefs: [evidence('review-wave2', scope)],
    nextAction: 'review',
  };

  const reviews = createReviewAssignments({
    workerAssignment: workAssignment,
    workerResult: workResult,
    reviewKinds: ['security', 'delivery'],
    subjectRefs: ['subject-wave2'],
    subjectDigests: ['sha256:subject-wave2'],
  });

  assert.deepEqual(reviews.map((review) => review.reviewKind), ['security', 'delivery']);
  assert.deepEqual(reviews.map((review) => review.requiredCapabilities), [
    ['security.review'],
    ['delivery.review'],
  ]);
  for (const review of reviews) assertReviewAssignment(review);
});
