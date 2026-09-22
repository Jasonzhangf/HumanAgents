import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderSubmitResult,
  type ProviderSubmitInput,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import { ProviderAgentDriver, ProviderAdapterError } from '../../../packages/adapters/provider/src/index.js';

const organ = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const operationId = id('operation', 'operation-a');
const scope: ScopeRef = { organId: organ, taskId, operationId };
const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'driver-scope'),
  kind: 'operation',
  source: 'test',
  locator: 'operation/operation-a',
  scope,
};
const binding: ProviderBinding = {
  bindingId: 'binding-a',
  providerId: 'provider-a',
  protocol: 'responses',
  endpointRef: 'endpoint-a',
  modelRef: 'model-a',
  configDigest: 'sha256:config',
  capabilityDigest: 'sha256:capability',
};
const identity = { runtimeId: 'runtime-a', taskId, operationId, executionEpoch: 1 };

function readiness(): ProviderReadiness {
  return {
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    protocol: binding.protocol,
    state: 'ready',
    capabilityDigest: binding.capabilityDigest,
    checkedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    evidenceRefs: [evidence],
  };
}

function settlement(state: ProviderSettlement['state'] = 'succeeded'): ProviderSettlement {
  return {
    ...identity,
    state,
    evidenceRefs: [evidence],
    resourceRelease: { state: 'released', evidenceRefs: [evidence] },
    persistence: { state: 'committed', evidenceRefs: [evidence] },
  };
}

function port(overrides: Partial<ExecutionRuntimePort> = {}): ExecutionRuntimePort {
  const started: ProviderStartInput[] = [];
  const base: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => readiness(),
    capabilities: async (): Promise<ProviderCapabilities> => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      capabilities: ['responses'],
      version: '1',
      digest: binding.capabilityDigest,
      checkedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      evidenceRefs: [evidence],
    }),
    start: async (input): Promise<ProviderStartReceipt> => {
      started.push(input);
      return { ...identity, startedAt: '2026-01-01T00:00:00.000Z', evidenceRefs: [evidence] };
    },
    resume: async (): Promise<ProviderRecoveryResult> => {
      throw new Error('not used');
    },
    submit: async (): Promise<ProviderSubmitResult> => {
      throw new Error('not used');
    },
    observe: async function* (): AsyncIterable<ProviderEvent> {
      yield { ...identity, eventId: 'event-1', kind: 'output', outputRefs: ['output-1'], summary: 'normalized output', evidenceRefs: [evidence] };
      yield { ...identity, eventId: 'event-2', kind: 'terminal', terminalState: 'succeeded', evidenceRefs: [evidence] };
    },
    requestStop: async (): Promise<ProviderStopReceipt> => ({
      ...identity,
      status: 'accepted',
      receivedAt: '2026-01-01T00:00:00.000Z',
      evidenceRefs: [evidence],
    }),
    settle: async () => settlement(),
    close: async (): Promise<ProviderCloseResult> => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'closed',
      evidenceRefs: [evidence],
    }),
  };
  return Object.assign(base, overrides);
}

function driver(runtimePort = port()): ProviderAgentDriver {
  return new ProviderAgentDriver({
    port: runtimePort,
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-a',
    scope,
    inputRefs: ['input-1'],
  });
}

test('provider agent driver maps provider start, observe, stop, settle, and close', async () => {
  const runtimePort = port();
  const instance = driver(runtimePort);
  const handle = await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  assert.deepEqual(handle, { runtimeId: identity.runtimeId, executionEpoch: 1 });

  const submitted = await instance.submit({
    taskId,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    payload: { prompt: 'hello' },
  });
  assert.equal(submitted.payload.status, 'accepted');

  const events = [];
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) events.push(event);
  assert.deepEqual(events.map((event) => event.kind), ['provider.output', 'provider.terminal']);
  assert.equal(events[0]?.summary, 'normalized output');
  assert.equal(events[1]?.terminalState, 'succeeded');

  const stop = await instance.requestStop({ runtimeId: identity.runtimeId, executionEpoch: 1, operationId });
  assert.equal(stop.requested, true);
  assert.deepEqual(await instance.settle({ runtimeId: identity.runtimeId, executionEpoch: 1 }), {
    state: 'succeeded',
    evidenceRefs: [evidence],
  });
  assert.equal(instance.settlement()?.state, 'succeeded');
  await instance.close();
});

test('provider agent driver rejects a start for another runtime or task', async () => {
  const instance = driver();
  await assert.rejects(
    () => instance.start({ runtimeId: 'runtime-b', taskId, executionEpoch: 1 }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
});

test('provider agent driver fences observe and stop to its bound execution identity', async () => {
  const instance = driver();
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'hello' } });

  await assert.rejects(
    async () => {
      for await (const _event of instance.observe({ runtimeId: 'runtime-b' })) void _event;
    },
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
  await assert.rejects(
    () => instance.requestStop({ runtimeId: 'runtime-b', executionEpoch: 1, operationId }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
  await assert.rejects(
    () => instance.requestStop({ runtimeId: identity.runtimeId, executionEpoch: 2, operationId }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
  await assert.rejects(
    () => instance.requestStop({ runtimeId: identity.runtimeId, executionEpoch: 1, operationId: id('operation', 'operation-b') }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
});

test('provider agent driver rejects start receipts and events for another execution identity', async () => {
  const foreignOperation = id('operation', 'operation-b');
  const foreignTask = id('task', 'task-b');
  const receiptMismatch = driver(port({
    start: async (input): Promise<ProviderStartReceipt> => ({
      ...identity,
      operationId: foreignOperation,
      startedAt: '2026-01-01T00:00:00.000Z',
      evidenceRefs: [evidence],
    }),
  }));
  await receiptMismatch.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await assert.rejects(
    () => receiptMismatch.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'hello' } }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );

  const eventMismatch = driver(port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      yield {
        ...identity,
        taskId: foreignTask,
        eventId: 'foreign-task',
        kind: 'output',
        outputRefs: ['output-1'],
        evidenceRefs: [evidence],
      };
      yield {
        ...identity,
        operationId: foreignOperation,
        eventId: 'foreign-operation',
        kind: 'output',
        outputRefs: ['output-2'],
        evidenceRefs: [evidence],
      };
    },
  }));
  await eventMismatch.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await eventMismatch.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'hello' } });
  await assert.rejects(
    async () => {
      for await (const _event of eventMismatch.observe({ runtimeId: identity.runtimeId })) void _event;
    },
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
});

test('provider agent driver rejects stop receipts and settlements for another execution identity', async () => {
  const foreignRuntime = 'runtime-b';
  const stopMismatch = driver(port({
    requestStop: async (): Promise<ProviderStopReceipt> => ({
      ...identity,
      runtimeId: foreignRuntime,
      status: 'accepted',
      receivedAt: '2026-01-01T00:00:00.000Z',
      evidenceRefs: [evidence],
    }),
  }));
  await stopMismatch.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await stopMismatch.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'hello' } });
  await assert.rejects(
    () => stopMismatch.requestStop({ runtimeId: identity.runtimeId, executionEpoch: 1, operationId }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );

  const settlementMismatch = driver(port({
    settle: async () => ({
      ...settlement(),
      runtimeId: foreignRuntime,
    }),
  }));
  await assert.rejects(
    () => settlementMismatch.settle({ runtimeId: identity.runtimeId, executionEpoch: 1 }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
});

test('provider agent driver keeps stop, observe, and settle behind a real provider start', async () => {
  const instance = driver();
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await assert.rejects(
    () => instance.requestStop({ runtimeId: identity.runtimeId, executionEpoch: 1, operationId }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.not.submitted',
  );
  await assert.rejects(
    async () => {
      for await (const _event of instance.observe({ runtimeId: identity.runtimeId })) void _event;
    },
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.not.submitted',
  );
});

test('provider agent driver exposes explicit resume capability failure', async () => {
  const instance = driver();
  await assert.rejects(
    () => instance.resume({
      runtimeId: identity.runtimeId,
      taskId,
      executionEpoch: 1,
      checkpointId: id('checkpoint', 'checkpoint-a'),
    }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'resume.unsupported',
  );
});

test('provider agent driver executes a complete Responses tool call once and continues with its verified result', async () => {
  let round = 0;
  const submissions: ProviderSubmitInput[] = [];
  const toolCalls: string[] = [];
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      round += 1;
      if (round === 1) {
        yield {
          ...identity,
          eventId: 'event-tool-call',
          kind: 'tool',
          summary: 'file.read',
          outputRefs: ['artifact://tool-call'],
          evidenceRefs: [evidence],
          ownerId: 'humanagent.provider-adapter',
          nextAction: { kind: 'continue' },
          toolCall: {
            callId: 'call-readme',
            toolId: 'file.read',
            arguments: { path: 'README.md' },
            continuationRef: 'response-round-1',
          },
        };
        yield {
          ...identity,
          eventId: 'event-tool-call-package',
          kind: 'tool',
          summary: 'file.read',
          outputRefs: ['artifact://tool-call-package'],
          evidenceRefs: [evidence],
          ownerId: 'humanagent.provider-adapter',
          nextAction: { kind: 'continue' },
          toolCall: {
            callId: 'call-package',
            toolId: 'file.read',
            arguments: { path: 'package.json' },
            continuationRef: 'response-round-1',
          },
        };
        yield {
          ...identity,
          eventId: 'event-tool-waiting',
          kind: 'terminal',
          terminalState: 'waiting',
          evidenceRefs: [evidence],
          ownerId: 'humanagent.provider-adapter',
          nextAction: { kind: 'continue', ref: 'responses-tool-call' },
        };
        return;
      }
      yield { ...identity, eventId: 'event-final-output', kind: 'output', summary: 'Checklist from REAL_FILE_CONTENT', outputRefs: ['output-final'], evidenceRefs: [evidence] };
      yield { ...identity, eventId: 'event-final', kind: 'terminal', terminalState: 'succeeded', evidenceRefs: [evidence], ownerId: 'humanagent.provider-adapter', nextAction: { kind: 'continue' } };
    },
    submit: async (input): Promise<ProviderSubmitResult> => {
      submissions.push(input);
      return { ...identity, status: 'accepted', outputRefs: [], evidenceRefs: [evidence] };
    },
  });
  const instance = new ProviderAgentDriver({
    port: runtimePort,
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    scope,
    inputRefs: ['input-1'],
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    executeTool: {
      async execute(input) {
        toolCalls.push(`${input.call.toolId}:${String(input.call.arguments.path)}`);
        const path = String(input.call.arguments.path);
        return {
          output: JSON.stringify({ path, content: path === 'README.md' ? 'REAL_FILE_CONTENT' : 'REAL_PACKAGE_CONTENT' }),
          outputRefs: [`asset://provider-tool/output/${input.call.callId}`],
          evidenceRefs: [evidence],
        };
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'read README.md' } });
  const events = [];
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) events.push(event);

  assert.deepEqual(toolCalls, ['file.read:README.md', 'file.read:package.json']);
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0]?.toolContinuations, [{
    callId: 'call-readme',
    toolId: 'file.read',
    arguments: { path: 'README.md' },
    continuationRef: 'response-round-1',
    output: JSON.stringify({ path: 'README.md', content: 'REAL_FILE_CONTENT' }),
  }, {
    callId: 'call-package',
    toolId: 'file.read',
    arguments: { path: 'package.json' },
    continuationRef: 'response-round-1',
    output: JSON.stringify({ path: 'package.json', content: 'REAL_PACKAGE_CONTENT' }),
  }]);
  assert.deepEqual(events.map((event) => [event.kind, event.summary, event.terminalState]), [
    ['provider.tool', 'file.read', undefined],
    ['provider.tool', 'file.read', undefined],
    ['provider.tool', 'file.read succeeded', undefined],
    ['provider.tool', 'file.read succeeded', undefined],
    ['provider.output', 'Checklist from REAL_FILE_CONTENT', undefined],
    ['provider.terminal', undefined, 'succeeded'],
  ]);
});

test('provider agent driver waits for a stopped tool to settle and never submits its late result', async () => {
  let enteredTool!: () => void;
  const toolEntered = new Promise<void>((resolve) => { enteredTool = resolve; });
  let releaseTool!: () => void;
  const toolRelease = new Promise<void>((resolve) => { releaseTool = resolve; });
  let providerSettled = false;
  let toolSignal: AbortSignal | undefined;
  const submissions: ProviderSubmitInput[] = [];
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      yield {
        ...identity,
        eventId: 'event-tool-call-stop',
        kind: 'tool',
        summary: 'file.read',
        outputRefs: ['artifact://tool-call-stop'],
        evidenceRefs: [evidence],
        toolCall: { callId: 'call-stop', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-round-1' },
      };
      yield {
        ...identity,
        eventId: 'event-tool-waiting-stop',
        kind: 'terminal',
        terminalState: 'waiting',
        evidenceRefs: [evidence],
        nextAction: { kind: 'continue', ref: 'responses-tool-call' },
      };
    },
    submit: async (input) => {
      submissions.push(input);
      return { ...identity, status: 'accepted', outputRefs: [], evidenceRefs: [evidence] };
    },
    settle: async () => {
      providerSettled = true;
      return settlement('stopped');
    },
  });
  const instance = new ProviderAgentDriver({
    port: runtimePort,
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    scope,
    inputRefs: ['input-1'],
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    executeTool: {
      async execute(input) {
        toolSignal = input.signal;
        enteredTool();
        await toolRelease;
        return { output: 'LATE_RESULT', outputRefs: ['asset://late'], evidenceRefs: [evidence] };
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'read README.md' } });
  const iterator = instance.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, 'provider.tool');
  const pendingObservation = iterator.next();
  await toolEntered;
  await instance.requestStop({ runtimeId: identity.runtimeId, executionEpoch: 1, operationId });
  assert.equal(toolSignal?.aborted, true);
  const pendingSettlement = instance.settle({ runtimeId: identity.runtimeId, executionEpoch: 1 });
  await Promise.resolve();
  assert.equal(providerSettled, false);
  releaseTool();
  assert.equal((await pendingObservation).done, true);
  assert.equal((await pendingSettlement).state, 'stopped');
  assert.equal(providerSettled, true);
  assert.equal(submissions.length, 0);
});
