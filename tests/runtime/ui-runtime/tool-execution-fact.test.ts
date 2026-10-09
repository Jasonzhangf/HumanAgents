import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type AgentEvent,
  type EvidenceRef,
  type ProviderEvent,
  type ProviderToolResult,
  type TaskId,
  type ToolExecutionFact,
} from '../../../packages/contracts/src/index.js';
import {
  RuntimeTaskCoordinator,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
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

function coordinator(journal: MemoryTaskJournal, mismatch: Mismatch = 'none'): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId,
    taskIdPrefix: 'tool-fact',
    createDriver: (input) => new ToolFactDriver(input, mismatch),
    checkpointStoreFor: () => ({
      async verify() { return { valid: true as const }; },
      async readLatest() { return null; },
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
