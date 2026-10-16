import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type AgentEvent,
  type EvidenceRef,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderToolResult,
  type TaskId,
  type ToolExecutionFact,
} from '../../../packages/contracts/src/index.js';
import {
  RuntimeTaskCoordinator,
  RuntimeTaskControlError,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeExecutionAdmission,
  type RuntimeExecutionPreparationInput,
  type RuntimeTaskJournalPort,
  type RuntimeTaskJournalRecord,
} from '../../../packages/runtime/src/ui-runtime/coordinator.js';

const organId = id('organ', 'tool-execution-fact-organ');
const toolIdentity = {
  surface: 'humanagent.provider.responses',
  toolId: 'file.search',
  bindingRef: 'binding:responses-test',
  route: 'file.search:workspace',
} as const;
const outputRef = 'asset://provider-tool/output/call-r2';
const outputDigest = `sha256:${'a'.repeat(64)}`;

type Mismatch = 'none' | 'task' | 'operation' | 'epoch' | 'request' | 'call';

function evidence(taskId: TaskId, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `tool-fact-${label}`),
    kind: 'tool',
    source: 'tool-execution-fact-test',
    locator: label,
    scope: { organId, taskId },
  };
}

function toolFact(input: {
  readonly requestRef: string;
  readonly callRef: string;
  readonly operationRef: string;
}): ToolExecutionFact {
  return {
    identity: toolIdentity,
    requestRef: input.requestRef,
    callRef: input.callRef,
    operationRef: input.operationRef,
    state: 'succeeded',
    rawEvidenceRefs: ['evidence://file-search/report'],
    resultRef: outputRef,
    resultDigest: outputDigest,
  };
}

function toolResult(input: {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: ReturnType<typeof id<'operation'>>;
  readonly executionEpoch: number;
  readonly callId: string;
  readonly fact: ToolExecutionFact;
  readonly evidenceRefs: readonly EvidenceRef[];
}): ProviderToolResult {
  return {
    runtimeId: input.runtimeId,
    taskId: input.taskId,
    operationId: input.operationId,
    executionEpoch: input.executionEpoch,
    toolId: 'file.search',
    callId: input.callId,
    status: 'succeeded',
    outputRefs: [outputRef],
    evidenceRefs: input.evidenceRefs,
    outputRef,
    outputDigest,
    executionFact: input.fact,
    ownerId: 'test.provider',
    nextAction: { kind: 'continue', ref: 'responses-tool-call' },
  };
}

function providerEvent(input: {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: ReturnType<typeof id<'operation'>>;
  readonly executionEpoch: number;
  readonly requestId: string;
  readonly callId: string;
  readonly fact: ToolExecutionFact;
  readonly evidenceRefs: readonly EvidenceRef[];
}): ProviderEvent {
  return {
    runtimeId: input.runtimeId,
    taskId: input.taskId,
    operationId: input.operationId,
    executionEpoch: input.executionEpoch,
    eventId: `tool-result-${input.callId}`,
    kind: 'tool',
    toolPhase: 'result',
    turnId: 'turn-r2',
    requestId: input.requestId,
    occurredAt: '2026-10-09T16:00:00.000Z',
    summary: 'file.search succeeded',
    evidenceRefs: input.evidenceRefs,
    ownerId: 'test.provider',
    nextAction: { kind: 'continue', ref: 'responses-tool-call' },
    toolResult: toolResult({ ...input, evidenceRefs: input.evidenceRefs }),
  };
}

class MemoryTaskJournal implements RuntimeTaskJournalPort {
  readonly records: RuntimeTaskJournalRecord[] = [];

  append(record: RuntimeTaskJournalRecord): void {
    this.records.push(structuredClone(record));
  }

  replay(): readonly RuntimeTaskJournalRecord[] {
    return structuredClone(this.records);
  }
}

class ToolFactDriver implements RuntimeExecutionDriver {
  readonly kind = 'tool-execution-fact.fake-driver';

  constructor(readonly input: RuntimeExecutionDriverInput, readonly mismatch: Mismatch) {}

  async capabilities() {
    return { driverKind: this.kind, capabilities: ['execute'], version: '1' };
  }

  async start(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async resume(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async submit(input: Parameters<RuntimeExecutionDriver['submit']>[0]) {
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: input.payload,
      outputRefs: [],
      evidenceRefs: [evidence(input.taskId, 'submit')],
    };
  }

  async *observe(): AsyncIterable<AgentEvent> {
    const { taskId, operationId, executionEpoch, runtimeId } = this.input;
    const ownerTaskId = this.mismatch === 'task' ? id('task', 'foreign-task') : taskId;
    const ownerOperationId = this.mismatch === 'operation' ? id('operation', 'foreign-operation') : operationId;
    const ownerEpoch = this.mismatch === 'epoch' ? executionEpoch + 1 : executionEpoch;
    const callId = this.mismatch === 'call' ? 'call-foreign' : 'call-r2';
    const requestId = this.mismatch === 'request' ? 'request-foreign' : 'request-r2';
    const refs = [evidence(ownerTaskId, 'tool-result')];

    yield {
      taskId,
      executionEpoch,
      kind: 'provider.tool',
      evidenceRefs: [evidence(taskId, 'tool-call')],
      providerEvent: {
        runtimeId,
        taskId,
        operationId,
        executionEpoch,
        eventId: 'tool-call-r2',
        kind: 'tool',
        toolPhase: 'invoke',
        turnId: 'turn-r2',
        requestId: 'request-r2',
        occurredAt: '2026-10-09T16:00:00.000Z',
        summary: 'file.search call',
        evidenceRefs: [evidence(taskId, 'tool-call-provider')],
        ownerId: 'test.provider',
        nextAction: { kind: 'continue', ref: 'responses-tool-call' },
        toolCall: {
          callId: 'call-r2',
          toolId: 'file.search',
          arguments: { path: '.', query: 'needle', queryKind: 'literal' },
          continuationRef: 'responses-tool-call',
        },
      },
    } as AgentEvent;

    const result = providerEvent({
      runtimeId,
      taskId: ownerTaskId,
      operationId: ownerOperationId,
      executionEpoch: ownerEpoch,
      requestId,
      callId,
      fact: toolFact({ requestRef: requestId, callRef: callId, operationRef: ownerOperationId.value }),
      evidenceRefs: refs,
    });
    yield {
      taskId,
      executionEpoch,
      kind: 'provider.tool',
      evidenceRefs: refs,
      providerEvent: result,
    } as AgentEvent;
  }

  async requestStop(input: Parameters<RuntimeExecutionDriver['requestStop']>[0]) {
    return { requested: true, operationId: input.operationId };
  }

  async settle() {
    return { state: 'succeeded' as const, evidenceRefs: [evidence(this.input.taskId, 'settle')] };
  }

  async close() {
    return {
      bindingId: 'fake-binding',
      providerId: 'fake-provider',
      protocol: 'responses' as const,
      state: 'closed' as const,
      evidenceRefs: [evidence(this.input.taskId, 'close')],
    };
  }
}

/**
 * Minimal public consumer driver that records the actual provider `start`
 * boundary. An execution held during async preparation must never reach it.
 */
class PreparedExecutionDriver implements RuntimeExecutionDriver {
  readonly kind = 'prepared-execution.fake-driver';
  startCalls = 0;
  closeCalls = 0;
  readonly requests: Parameters<RuntimeExecutionDriver['submit']>[0]['payload'][] = [];

  constructor(readonly input: RuntimeExecutionDriverInput) {}

  async capabilities() {
    return { driverKind: this.kind, capabilities: ['execute'], version: '1' };
  }

  async start(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    this.startCalls += 1;
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async resume(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async submit(input: Parameters<RuntimeExecutionDriver['submit']>[0]) {
    this.requests.push(input.payload);
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: input.payload,
      outputRefs: [],
      evidenceRefs: [],
    };
  }

  async *observe(): AsyncIterable<AgentEvent> {
    const { taskId, executionEpoch } = this.input;
    yield {
      taskId,
      executionEpoch,
      kind: 'provider.output',
      evidenceRefs: [],
      providerEvent: {
        runtimeId: this.input.runtimeId,
        taskId,
        operationId: this.input.operationId,
        executionEpoch,
        eventId: `prepared-output-${this.input.operationId.value}`,
        kind: 'output',
        summary: 'prepared provider output',
        evidenceRefs: [],
        ownerId: 'test.provider',
        nextAction: { kind: 'continue', ref: 'prepared-output' },
      },
    } as AgentEvent;
  }

  async requestStop(input: Parameters<RuntimeExecutionDriver['requestStop']>[0]) {
    return { requested: true, operationId: input.operationId };
  }

  async settle() {
    return { state: 'succeeded' as const, evidenceRefs: [] };
  }

  async close(): Promise<ProviderCloseResult> {
    this.closeCalls += 1;
    return {
      bindingId: 'prepared-binding',
      providerId: 'prepared-provider',
      protocol: 'responses',
      state: 'closed' as const,
      evidenceRefs: [],
    };
  }
}

function coordinator(journal: MemoryTaskJournal, mismatch: Mismatch = 'none'): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId,
    taskIdPrefix: 'tool-fact',
    admitExecution: async () => {},
    createDriver: (input) => new ToolFactDriver(input, mismatch),
    checkpointStoreFor: () => ({
      async verify() { return { valid: true as const }; },
      async readLatest() { return null; },
      // Stateless fake: nothing is persisted, so every committed read reports absence.
      async readCommitted() { return null; },
      async listCommitted() { return { checkpoints: [] }; },
      async readExecutionPosition() { return null; },
      async readCheckpointRecoveryBinding() { return null; },
      async append(input) { return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq }; },
      async commit(checkpoint) { return { checkpointId: checkpoint.id, committed: true as const }; },
    }),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
    journal,
  });
}

function preparedCoordinator(
  journal: MemoryTaskJournal,
  factory: (input: RuntimeExecutionPreparationInput) => Promise<PreparedExecutionDriver>,
  admitExecution?: RuntimeExecutionAdmission,
): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId,
    taskIdPrefix: 'prepared',
    createDriver: factory,
    ...(admitExecution === undefined ? {} : { admitExecution }),
    checkpointStoreFor: () => ({
      async verify() { return { valid: true as const }; },
      async readLatest() { return null; },
      // Stateless fake: nothing is persisted, so every committed read reports absence.
      async readCommitted() { return null; },
      async listCommitted() { return { checkpoints: [] }; },
      async readExecutionPosition() { return null; },
      async readCheckpointRecoveryBinding() { return null; },
      async append(input) { return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq }; },
      async commit(checkpoint) { return { checkpointId: checkpoint.id, committed: true as const }; },
    }),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
    journal,
  });
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForTerminal(runtime: RuntimeTaskCoordinator, taskId: TaskId): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = runtime.taskSnapshot(taskId).state;
    if (state === 'succeeded' || state === 'failed' || state === 'blocked') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`runtime did not finish; state=${runtime.taskSnapshot(taskId).state}`);
}

async function run(mismatch: Mismatch) {
  const journal = new MemoryTaskJournal();
  const runtime = coordinator(journal, mismatch);
  const task = runtime.createTask({ title: 'tool execution fact', directive: 'preserve tool execution fact' });
  const { operationId } = runtime.startExecution(task.taskId, { prompt: 'search for needle' });
  await waitForTerminal(runtime, task.taskId);
  return { runtime, journal, taskId: task.taskId, operationId };
}

test('Runtime preserves a validated tool execution fact in snapshot, events, and journal replay', async () => {
  const result = await run('none');
  assert.equal(result.runtime.taskSnapshot(result.taskId).state, 'succeeded');
  const publicEvent = result.runtime.eventsSince(result.operationId).find((event) => event.kind === 'provider.tool-result');
  if (publicEvent?.executionFact === undefined) throw new Error('expected public tool result with execution fact');
  assert.deepEqual(publicEvent.executionFact, toolFact({
    requestRef: 'request-r2',
    callRef: 'call-r2',
    operationRef: result.operationId.value,
  }));
  assert.equal(publicEvent.outputRef, outputRef);
  assert.equal(publicEvent.outputDigest, outputDigest);
  assert.deepEqual(
    result.runtime.taskSnapshot(result.taskId).events.find((event) => event.kind === 'provider.tool-result')?.executionFact,
    publicEvent.executionFact,
  );

  const restored = coordinator(result.journal);
  const replayed = restored.taskSnapshot(result.taskId).events.find((event) => event.kind === 'provider.tool-result');
  assert.deepEqual(replayed?.executionFact, publicEvent.executionFact);
  assert.equal(replayed?.outputRef, outputRef);
  assert.equal(replayed?.outputDigest, outputDigest);
  assert.equal(restored.taskSnapshot(result.taskId).state, 'unknown');
});

for (const mismatch of ['task', 'operation', 'epoch', 'request', 'call'] as const) {
  test(`Runtime rejects an attached tool fact with a mismatched operation-owned ${mismatch}`, async () => {
    const result = await run(mismatch);
    assert.notEqual(result.runtime.taskSnapshot(result.taskId).state, 'succeeded');
    assert.equal(
      result.runtime.eventsSince(result.operationId).some((event) => event.kind === 'provider.tool-result' && event.executionFact !== undefined),
      false,
    );
    assert.equal(
      result.journal.records.some((record) => record.kind === 'operation.event'
        && record.event.kind === 'provider.tool-result' && record.event.executionFact !== undefined),
      false,
    );
  });
}

test('prepared admission holds effects until release and retains denial or stop duty', async () => {
  const journal = new MemoryTaskJournal();
  const preparedInputs: RuntimeExecutionPreparationInput[] = [];
  let admit!: () => void;
  const admission = new Promise<void>((resolve) => { admit = resolve; });
  let releaseDriver!: (driver: PreparedExecutionDriver) => void;
  const gate = new Promise<PreparedExecutionDriver>((resolve) => {
    releaseDriver = resolve;
  });
  const runtime = preparedCoordinator(journal, async (input) => {
    preparedInputs.push(input);
    return gate;
  }, async (allocation) => {
    assert.equal(journal.records.some((record) => record.kind === 'operation.prepared'
      && record.allocation.operationId.value === allocation.operationId.value), true,
    'prepared identity must be persisted before admission');
    await admission;
  });
  const task = runtime.createTask({ title: 'prepared admission', directive: 'release after allocation' });
  const executionInput = {
    prompt: 'prepared input',
    role: 'execution' as const,
    configuredAgentId: 'configured-execution',
  };
  const allocation = runtime.prepareExecution(task.taskId, executionInput);
  const held = new PreparedExecutionDriver(allocation);
  assert.strictEqual(runtime.prepareExecution(task.taskId, {
    ...executionInput, operationId: allocation.operationId,
  }), allocation, 'exact retry reuses the owner allocation');
  const release = runtime.releaseExecution(task.taskId, allocation.operationId);
  assert.strictEqual(runtime.releaseExecution(task.taskId, allocation.operationId), release,
    'exact release retry awaits the same preparation');

  await tick();
  assert.equal(held.startCalls, 0, 'held admission must prevent driver.start');
  assert.deepEqual(held.requests, [], 'held admission must prevent provider requests');
  assert.equal(preparedInputs.length, 0, 'held admission must precede the driver factory');
  assert.equal(runtime.taskSnapshot(task.taskId).state, 'waiting', 'unreleased execution is not running');
  admit();
  await tick();
  assert.equal(held.startCalls, 0, 'pending async factory must prevent driver.start');
  assert.deepEqual(held.requests, [], 'pending async factory must prevent provider requests');
  assert.equal(preparedInputs.length, 1);
  assert.equal(preparedInputs[0]!.scope.taskId?.value, task.taskId.value);
  assert.equal(preparedInputs[0]!.scope.operationId?.value, allocation.operationId.value);
  assert.equal(preparedInputs[0]!.executionEpoch, 1);
  assert.equal(preparedInputs[0]!.directiveRevision, 1);
  assert.equal(preparedInputs[0]!.role, 'execution');
  assert.equal(preparedInputs[0]!.configuredAgentId, 'configured-execution');
  assert.equal(preparedInputs[0]!.orchestrated, false);
  assert.equal(
    journal.records.some((record) => record.kind === 'operation.prepared' && record.allocation.operationId.value === allocation.operationId.value),
    true,
    'prepared identity must be persisted before effects',
  );
  assert.equal(preparedInputs[0]!.inputRefs.length, 1);

  releaseDriver(held);
  assert.deepEqual(await release, { state: 'released' });
  await waitForTerminal(runtime, task.taskId);
  assert.equal(runtime.taskSnapshot(task.taskId).state, 'succeeded');
  assert.equal(held.startCalls, 1, 'released execution starts the driver exactly once');
  assert.deepEqual(held.requests, [{ prompt: 'prepared input' }]);
  assert.equal(held.closeCalls, 1, 'completed execution releases its driver');
  assert.equal(runtime.taskSnapshot(task.taskId).executionEpoch, 1);
  assert.equal(
    journal.records.filter((record) => record.kind === 'operation.prepared').length,
    1,
    'one prepared identity per operation',
  );

  const deniedJournal = new MemoryTaskJournal();
  let deniedFactoryCalls = 0;
  const denied = preparedCoordinator(deniedJournal, async (input) => {
    deniedFactoryCalls += 1;
    return new PreparedExecutionDriver(input);
  }, async () => {
    throw new RuntimeTaskControlError(
      'execution.admission.denied',
      'test.admission',
      'execution was not admitted',
      'authorize this task execution before releasing the provider',
    );
  });
  const deniedTask = denied.createTask({ title: 'denied preparation', directive: 'deny before release' });
  const deniedAllocation = denied.prepareExecution(deniedTask.taskId, { prompt: 'denied input' });
  await assert.rejects(denied.releaseExecution(deniedTask.taskId, deniedAllocation.operationId),
    (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'execution.admission.denied');

  const snapshot = denied.taskSnapshot(deniedTask.taskId);
  assert.equal(snapshot.state, 'blocked');
  assert.equal(snapshot.error?.code, 'execution.admission.denied');
  assert.equal(snapshot.error?.ownerId, 'test.admission');
  assert.equal(snapshot.error?.nextAction, 'authorize this task execution before releasing the provider');
  assert.equal(
    deniedJournal.records.some((record) => record.kind === 'operation.prepared'),
    true,
    'allocation persists even when the admission denies the release',
  );
  assert.equal(
    deniedJournal.records.some((record) => record.kind === 'operation.event'
      && record.event.kind === 'execution.started'),
    false,
    'no provider request/effect exists after denial',
  );
  assert.equal(deniedFactoryCalls, 0, 'denial releases no driver construction');
  assert.equal((await denied.stop(deniedTask.taskId)).state, 'stopped');

  const missingJournal = new MemoryTaskJournal();
  const missing = preparedCoordinator(missingJournal, async (input) => {
    deniedFactoryCalls += 1;
    return new PreparedExecutionDriver(input);
  });
  const missingTask = missing.createTask({ title: 'missing admission source' });
  const missingAllocation = missing.prepareExecution(missingTask.taskId, { prompt: 'missing source input' });
  await assert.rejects(missing.releaseExecution(missingTask.taskId, missingAllocation.operationId),
    (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'execution.admission.missing');
  assert.equal(missing.taskSnapshot(missingTask.taskId).state, 'blocked');
  assert.equal(missing.taskSnapshot(missingTask.taskId).error?.code, 'execution.admission.missing');
  assert.equal(deniedFactoryCalls, 0, 'missing source releases no driver construction');
  assert.equal((await missing.stop(missingTask.taskId)).state, 'stopped');

  const stopJournal = new MemoryTaskJournal();
  let finishStoppedFactory!: (driver: PreparedExecutionDriver) => void;
  const stoppedGate = new Promise<PreparedExecutionDriver>((resolve) => {
    finishStoppedFactory = resolve;
  });
  const stopped = preparedCoordinator(stopJournal, async () => stoppedGate, async () => {});
  const stoppedTask = stopped.createTask({ title: 'stop held preparation', directive: 'stop before release' });
  const stoppedAllocation = stopped.prepareExecution(stoppedTask.taskId, { prompt: 'held input' });
  const heldDriver = new PreparedExecutionDriver(stoppedAllocation);
  const stoppedRelease = assert.rejects(stopped.releaseExecution(stoppedTask.taskId, stoppedAllocation.operationId),
    (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'execution.preparation.stopped');
  await tick();
  const stopPromise = stopped.stop(stoppedTask.taskId);
  await tick();
  finishStoppedFactory(heldDriver);
  await stoppedRelease;
  assert.equal((await stopPromise).state, 'stopped', 'stop acknowledges actual prepared-resource release');
  const stoppedSnapshot = stopped.taskSnapshot(stoppedTask.taskId);
  assert.equal(heldDriver.startCalls, 0, 'no late provider start after stop while held');
  assert.deepEqual(heldDriver.requests, [], 'stop releases no late model request');
  assert.equal(heldDriver.closeCalls, 1, 'stop closes its actual prepared driver exactly once');
  assert.equal(stoppedSnapshot.state, 'stopped');
  assert.deepEqual(stoppedSnapshot.allowedActions, ['start']);
  assert.equal(
    stopJournal.records.some((record) => record.kind === 'operation.event'
      && record.event.terminalPhase === 'final'
      && record.event.kind === 'execution.terminal'),
    true,
    'the held execution records a visible terminal event without any provider request',
  );
  assert.equal(stopJournal.records.some((record) => record.kind === 'operation.event'
    && record.event.kind === 'execution.started'), false, 'stopped preparation never reports a running Provider');
});
