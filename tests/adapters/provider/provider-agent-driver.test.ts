import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  validateProviderEvent,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderError,
  type ProviderRequestLifecycleEvent,
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
import {
  ResponsesProviderCodec,
  ProviderAdapter,
  ProviderAgentDriver,
  ProviderAdapterError,
  createV3ProviderHttpTransport,
  type ProviderAgentEvent,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type V3ProviderFetch,
  type V3ProviderFetchInit,
  type V3ProviderFetchResponse,
} from '../../../packages/adapters/provider/src/index.js';

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
    ['provider.tool-result', 'file.read succeeded', undefined],
    ['provider.tool-result', 'file.read succeeded', undefined],
    ['provider.output', 'Checklist from REAL_FILE_CONTENT', undefined],
    ['provider.terminal', undefined, 'succeeded'],
  ]);
});

test('provider driver attaches executor-supplied facts to their request, call, binding, route, and report', async () => {
  let round = 0;
  const observedRequestIds: string[] = [];
  const continuations: ProviderSubmitInput[] = [];
  const executedCallIds: string[] = [];
  const makeCall = (callId: string, continuationRef: string): ProviderEvent => ({
    ...identity,
    eventId: `event-${callId}`,
    kind: 'tool',
    summary: 'file.search',
    outputRefs: [`artifact://${callId}`],
    evidenceRefs: [evidence],
    ownerId: 'humanagent.provider-adapter',
    nextAction: { kind: 'continue' },
    toolCall: {
      callId,
      toolId: 'file.search',
      arguments: { path: 'src', query: 'ProviderToolResult', queryKind: 'literal' },
      continuationRef,
    },
  });
  const runtimePort = port({
    observe: async function* (input): AsyncIterable<ProviderEvent> {
      if (typeof input.requestId === 'string') observedRequestIds.push(input.requestId);
      if (round === 0) {
        yield makeCall('call-search-a', 'response-round-1');
        yield makeCall('call-search-a2', 'response-round-1');
        yield makeCall('call-search-no-route', 'response-round-1');
        yield makeCall('call-search-no-descriptor', 'response-round-1');
        yield makeCall('call-search-invalid-route', 'response-round-1');
        yield {
          ...identity,
          eventId: 'event-search-waiting-1',
          kind: 'terminal',
          terminalState: 'waiting',
          evidenceRefs: [evidence],
          ownerId: 'humanagent.provider-adapter',
          nextAction: { kind: 'continue', ref: 'responses-tool-call' },
        };
      } else if (round === 1) {
        yield makeCall('call-search-b', 'response-round-2');
        yield {
          ...identity,
          eventId: 'event-search-waiting-2',
          kind: 'terminal',
          terminalState: 'waiting',
          evidenceRefs: [evidence],
          ownerId: 'humanagent.provider-adapter',
          nextAction: { kind: 'continue', ref: 'responses-tool-call' },
        };
      } else {
        yield { ...identity, eventId: 'event-search-output', kind: 'output', summary: 'search continuation complete', outputRefs: ['output-final'], evidenceRefs: [evidence] };
        yield { ...identity, eventId: 'event-search-terminal', kind: 'terminal', terminalState: 'succeeded', evidenceRefs: [evidence], ownerId: 'humanagent.provider-adapter', nextAction: { kind: 'continue' } };
      }
      round += 1;
    },
    submit: async (input): Promise<ProviderSubmitResult> => {
      continuations.push(input);
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
    tools: [{ toolId: 'file.search', description: 'search files', inputSchema: { type: 'object' } }],
    executeTool: {
      async execute({ call }) {
        executedCallIds.push(call.callId);
        const outputRef = `report://tool-output/${call.callId}`;
        const outputDigest = `sha256:${'a'.repeat(63)}${String(executedCallIds.length)}`;
        const descriptor = { output: `raw output for ${call.callId}`, outputRef, outputDigest, outputRefs: [outputRef], evidenceRefs: [evidence] };
        if (call.callId === 'call-search-no-route') return descriptor;
        if (call.callId === 'call-search-no-descriptor') return { ...descriptor, executorRoute: 'app.file-search.local', outputRef: undefined, outputDigest: undefined, outputRefs: [] };
        if (call.callId === 'call-search-invalid-route') return { ...descriptor, executorRoute: '   ' };
        return { ...descriptor, executorRoute: 'app.file-search.local' };
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'search the source' } });
  const events: ProviderAgentEvent[] = [];
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) events.push(event);

  const results = events.flatMap((event) => event.providerEvent.toolResult === undefined ? [] : [event.providerEvent.toolResult]);
  assert.deepEqual(executedCallIds, ['call-search-a', 'call-search-a2', 'call-search-no-route', 'call-search-no-descriptor', 'call-search-invalid-route', 'call-search-b']);
  assert.equal(results.length, 6);
  const [first, sameRequestSecond, noRoute, noDescriptor, invalidRoute, secondRequestResult] = results;
  assert.ok(first?.executionFact);
  assert.ok(sameRequestSecond?.executionFact);
  assert.equal(noRoute?.executionFact, undefined);
  assert.equal(noDescriptor?.executionFact, undefined);
  assert.equal(invalidRoute?.executionFact, undefined);
  assert.ok(secondRequestResult?.executionFact);

  const expectedIdentity = { surface: 'responses', toolId: 'file.search', bindingRef: binding.bindingId, route: 'app.file-search.local' };
  const firstFact = first?.executionFact;
  const sameRequestSecondFact = sameRequestSecond?.executionFact;
  const secondRequestFact = secondRequestResult?.executionFact;
  assert.deepEqual(firstFact?.identity, expectedIdentity);
  assert.deepEqual(sameRequestSecondFact?.identity, expectedIdentity);
  assert.deepEqual(secondRequestFact?.identity, expectedIdentity);
  assert.equal(firstFact?.requestRef, observedRequestIds[0]);
  assert.equal(sameRequestSecondFact?.requestRef, observedRequestIds[0]);
  assert.equal(noRoute?.callId, 'call-search-no-route');
  assert.equal(noDescriptor?.callId, 'call-search-no-descriptor');
  assert.equal(invalidRoute?.callId, 'call-search-invalid-route');
  assert.equal(firstFact?.callRef, 'call-search-a');
  assert.equal(sameRequestSecondFact?.callRef, 'call-search-a2');
  assert.equal(secondRequestFact?.callRef, 'call-search-b');
  assert.equal(firstFact?.operationRef, operationId.value);
  assert.equal(sameRequestSecondFact?.operationRef, operationId.value);
  assert.equal(secondRequestFact?.operationRef, operationId.value);
  assert.equal(firstFact?.state, 'succeeded');
  assert.equal(sameRequestSecondFact?.state, 'succeeded');
  assert.equal(secondRequestFact?.state, 'succeeded');
  assert.equal(firstFact?.resultRef, first?.outputRef);
  assert.equal(firstFact?.resultDigest, first?.outputDigest);
  assert.equal(firstFact?.rawEvidenceRefs[0], first?.outputRef);
  assert.equal(sameRequestSecondFact?.resultRef, sameRequestSecond?.outputRef);
  assert.equal(sameRequestSecondFact?.resultDigest, sameRequestSecond?.outputDigest);
  assert.notEqual(sameRequestSecondFact?.resultRef, firstFact?.resultRef);
  assert.equal(secondRequestFact?.requestRef, observedRequestIds[1]);
  assert.notEqual(secondRequestFact?.requestRef, firstFact?.requestRef);
  assert.equal(secondRequestFact?.resultRef, secondRequestResult?.outputRef);
  assert.equal(secondRequestFact?.resultDigest, secondRequestResult?.outputDigest);
  for (const result of [first, sameRequestSecond, secondRequestResult]) {
    const event = events.find((candidate) => candidate.providerEvent.toolResult?.callId === result?.callId)?.providerEvent;
    assert.ok(event);
    validateProviderEvent(event, result?.executionFact?.identity);
  }
  assert.equal(continuations.length, 2);
  assert.deepEqual(continuations[0]?.toolContinuations?.map((item) => item.callId), ['call-search-a', 'call-search-a2', 'call-search-no-route', 'call-search-no-descriptor', 'call-search-invalid-route']);
  assert.equal(continuations[0]?.toolContinuations?.[0]?.output, 'raw output for call-search-a');
});

test('provider driver preserves explicit non-success executor states without emitting success facts', async () => {
  const statuses = ['failed', 'blocked', 'unknown'] as const;
  const observed: Array<{ status: string | undefined; errorCode: string | undefined; errorMessage: string | undefined; fact: unknown; summary: string | undefined }> = [];

  for (const status of statuses) {
    const callId = `call-search-${status}`;
    const outputRef = `report://tool-output/${callId}`;
    const outputDigest = `sha256:${'b'.repeat(64)}`;
    const runtimePort = port({
      submit: async (): Promise<ProviderSubmitResult> => ({
        ...identity,
        status: 'accepted',
        outputRefs: [],
        evidenceRefs: [evidence],
      }),
      observe: async function* (): AsyncIterable<ProviderEvent> {
        yield {
          ...identity,
          eventId: `event-${callId}`,
          kind: 'tool',
          summary: 'file.search',
          outputRefs: [outputRef],
          evidenceRefs: [evidence],
          toolCall: { callId, toolId: 'file.search', arguments: { query: 'source' }, continuationRef: `response-${status}` },
        };
        yield {
          ...identity,
          eventId: `event-waiting-${callId}`,
          kind: 'terminal',
          terminalState: 'waiting',
          evidenceRefs: [evidence],
          nextAction: { kind: 'continue', ref: 'responses-tool-call' },
        };
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
      tools: [{ toolId: 'file.search', description: 'search files', inputSchema: { type: 'object' } }],
      executeTool: {
        async execute() {
          return {
            output: `executor reported ${status}`,
            outputRefs: [outputRef],
            evidenceRefs: [evidence],
            outputRef,
            outputDigest,
            executorRoute: 'app.file-search.local',
            status,
          };
        },
      },
    });
    await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
    await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'search the source' } });

    const iterator = instance.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.kind, 'provider.tool');
    const resultEvent = (await iterator.next()).value;
    assert.equal(resultEvent?.kind, 'provider.tool-result');
    assert.ok(resultEvent?.providerEvent);
    validateProviderEvent(resultEvent.providerEvent);
    const toolResult = resultEvent?.providerEvent.toolResult;
    observed.push({
      status: toolResult?.status,
      errorCode: toolResult?.error?.code,
      errorMessage: toolResult?.error?.message,
      fact: toolResult?.executionFact,
      summary: resultEvent?.summary,
    });
    await assert.rejects(
      () => iterator.next(),
      (error: unknown) => error instanceof ProviderAdapterError
        && error.providerError.message.includes(status),
    );
  }

  assert.deepEqual(observed.map((result) => result.status), [...statuses]);
  assert.deepEqual(observed.map((result) => result.errorCode), statuses.map(() => 'tool.result.failed'));
  assert.equal(observed.every((result, index) => result.errorMessage?.includes(statuses[index]!)), true);
  assert.deepEqual(observed.map((result) => result.summary), statuses.map((status) => `file.search ${status}`));
  assert.deepEqual(observed.map((result) => result.fact), statuses.map(() => undefined));
});

test('preserves prior results and stops a Responses tool batch at the first owned-tool failure', async () => {
  const evidenceA: EvidenceRef = {
    ...evidence,
    evidenceId: id('evidence', 'batch-tool-a'),
    locator: 'provider-tool/call-a',
  };
  const evidenceB: EvidenceRef = {
    ...evidence,
    evidenceId: id('evidence', 'batch-tool-b'),
    locator: 'provider-tool/call-b',
  };
  const failure: ProviderError = {
    errorId: 'provider.tool.batch-b.failed',
    code: 'tool.batch-b.failed',
    category: 'provider',
    phase: 'tool',
    message: 'tool B failed with a typed provider error',
    ownerId: 'humanagent.provider-agent-driver',
    retryable: 'manual',
    attention: 'foreground',
    evidenceRefs: [evidenceB],
    nextAction: { kind: 'recover', ref: 'provider.tool.batch-b' },
  };
  const wireCalls = [
    { callId: 'call-a', toolName: 'file_read', arguments: { path: 'README.md' } },
    { callId: 'call-b', toolName: 'file_write', arguments: { file_path: 'result.txt' } },
    { callId: 'call-c', toolName: 'web_search', arguments: { query: 'must not execute' } },
  ];
  const wireEvents = [
    { type: 'response.created', response: { id: 'response-partial-batch' } },
    ...wireCalls.flatMap((call, output_index) => [
      {
        type: 'response.output_item.added',
        output_index,
        item: { type: 'function_call', call_id: call.callId, name: call.toolName, arguments: '' },
      },
      {
        type: 'response.output_item.done',
        output_index,
        item: { type: 'function_call', call_id: call.callId, name: call.toolName, arguments: JSON.stringify(call.arguments) },
      },
    ]),
    { type: 'response.completed', response: { id: 'response-partial-batch' } },
  ];
  const requests: Array<{ readonly url: string; readonly init: V3ProviderFetchInit }> = [];
  const fetch: V3ProviderFetch = async (url, init) => {
    requests.push({ url, init });
    return delayedResponse(chunks(wireEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`)));
  };
  const executions: Array<{ callId: string; toolId: string; arguments: unknown; continuationRef: string }> = [];
  const instance = new ProviderAgentDriver({
    port: realProviderAdapter(fetch),
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-a',
    scope,
    inputRefs: ['input-1'],
    tools: [
      { toolId: 'file.read', description: 'read a file', inputSchema: { type: 'object' } },
      { toolId: 'file.write', description: 'write a file', inputSchema: { type: 'object' } },
      { toolId: 'web.search', description: 'search the web', inputSchema: { type: 'object' } },
    ],
    executeTool: {
      async execute({ call }) {
        executions.push({ callId: call.callId, toolId: call.toolId, arguments: call.arguments, continuationRef: call.continuationRef });
        if (call.callId === 'call-a') {
          return { output: 'A completed', outputRefs: ['asset://provider-tool/a'], evidenceRefs: [evidenceA] };
        }
        if (call.callId === 'call-b') {
          return {
            output: 'B failed',
            outputRefs: ['asset://provider-tool/b-error'],
            evidenceRefs: [evidenceB],
            status: 'failed',
            error: failure,
          };
        }
        throw new Error(`tool C executed unexpectedly: ${call.callId}`);
      },
    },
  });

  const observed: ProviderAgentEvent[] = [];
  let observationFailure: unknown;
  let started = false;
  let stopReceipt: Awaited<ReturnType<typeof instance.requestStop>> | undefined;
  let closure: Awaited<ReturnType<typeof instance.settle>> | undefined;
  let closeResult: ProviderCloseResult | undefined;
  try {
    await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
    started = true;
    await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'run tools A, B, and C' } });
    const iterator = instance.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        observed.push(next.value);
      }
    } catch (error) {
      observationFailure = error;
    } finally {
      await iterator.return?.();
    }
  } finally {
    if (started) {
      try {
        stopReceipt = await instance.requestStop({ runtimeId: identity.runtimeId, executionEpoch: 1, operationId });
      } finally {
        try {
          closure = await instance.settle({ runtimeId: identity.runtimeId, executionEpoch: 1 });
        } finally {
          closeResult = await instance.close();
        }
      }
    } else {
      closeResult = await instance.close();
    }
  }

  const calls = observed.flatMap((event) => event.providerEvent.toolCall === undefined ? [] : [event.providerEvent.toolCall]);
  assert.deepEqual(calls.map((call) => [call.callId, call.toolId]), [
    ['call-a', 'file.read'],
    ['call-b', 'file.write'],
    ['call-c', 'web.search'],
  ]);
  assert.deepEqual(executions, [
    { callId: 'call-a', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-partial-batch' },
    { callId: 'call-b', toolId: 'file.write', arguments: { file_path: 'result.txt' }, continuationRef: 'response-partial-batch' },
  ]);
  const results = observed.filter((event) => event.kind === 'provider.tool-result');
  assert.deepEqual(results.map((event) => event.providerEvent.toolResult?.callId), ['call-a', 'call-b']);
  const resultA = results[0]?.providerEvent.toolResult;
  assert.equal(resultA?.toolId, 'file.read');
  assert.equal(resultA?.status, 'succeeded');
  assert.deepEqual(resultA?.outputRefs, ['asset://provider-tool/a']);
  assert.deepEqual(resultA?.evidenceRefs, [evidenceA]);
  const resultB = results[1]?.providerEvent.toolResult;
  assert.equal(resultB?.toolId, 'file.write');
  assert.equal(resultB?.status, 'failed');
  assert.deepEqual(resultB?.outputRefs, ['asset://provider-tool/b-error']);
  assert.deepEqual(resultB?.evidenceRefs, [evidenceB]);
  assert.deepEqual(resultB?.error, failure);
  assert.ok(observed.indexOf(results[0]!) < observed.indexOf(results[1]!));
  assert.equal(observed.some((event) => event.kind === 'provider.terminal' && event.terminalState === 'succeeded'), false);
  assert.ok(observationFailure instanceof ProviderAdapterError);
  assert.equal(observationFailure.providerError.code, failure.code);
  assert.equal(observationFailure.providerError.category, failure.category);
  assert.equal(observationFailure.providerError.message, failure.message);
  assert.equal(observationFailure.providerError.retryable, failure.retryable);
  assert.deepEqual(observationFailure.providerError.nextAction, failure.nextAction);
  assert.deepEqual(observationFailure.providerError.evidenceRefs, failure.evidenceRefs);

  assert.equal(requests.length, 1, 'a partial tool continuation request was sent after B failed');
  assert.equal(requests[0]?.init.method, 'POST');
  assert.equal(stopReceipt?.requested, true);
  assert.equal('state' in (stopReceipt ?? {}), false, 'stop receipt must not claim settlement');
  assert.equal(closure?.state, 'stopped');
  assert.equal(instance.settlement()?.state, 'stopped');
  assert.equal(instance.settlement()?.resourceRelease.state, 'released');
  assert.equal(closeResult?.state, 'closed');
});

test('provider agent driver reports an unowned tool call as an observation instead of stranding the execution', async () => {
  // The backend harness can advertise its own tool (for example exec_command).
  // The model reaching for it must not kill the task: the failure is fed back
  // so the model can retry with a tool this Harness actually owns.
  let round = 0;
  const submissions: ProviderSubmitInput[] = [];
  const executions: string[] = [];
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      round += 1;
      if (round === 1) {
        yield {
          ...identity,
          eventId: 'event-unowned-tool',
          kind: 'tool',
          summary: 'exec_command',
          outputRefs: ['artifact://exec-command'],
          evidenceRefs: [evidence],
          toolCall: {
            callId: 'call-unowned',
            toolId: 'exec_command',
            arguments: { command: 'ls' },
            continuationRef: 'response-round-1',
          },
        };
        yield {
          ...identity,
          eventId: 'event-unowned-waiting',
          kind: 'terminal',
          terminalState: 'waiting',
          evidenceRefs: [evidence],
          nextAction: { kind: 'continue', ref: 'responses-tool-call' },
        };
        return;
      }
      yield { ...identity, eventId: 'event-final', kind: 'terminal', terminalState: 'succeeded', evidenceRefs: [evidence] };
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
      async execute({ call }) {
        executions.push(call.toolId);
        return { output: 'file body', outputRefs: [], evidenceRefs: [evidence] };
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'list the directory' } });
  const events: ProviderAgentEvent[] = [];
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) events.push(event);

  // The executor is never asked to run a tool this Harness does not own.
  assert.deepEqual(executions, []);
  assert.deepEqual(events.map((event) => event.kind), ['provider.tool', 'provider.tool-result', 'provider.terminal']);
  const failed = events[1]?.providerEvent?.toolResult;
  assert.equal(failed?.callId, 'call-unowned');
  assert.equal(failed?.toolId, 'exec_command');
  assert.equal(failed?.status, 'failed');
  assert.match(String(failed?.error?.message ?? ''), /not available in this Harness/);
  assert.match(String(failed?.error?.message ?? ''), /file\.read/);
  // The observation reaches the model on the continuation instead of a fatal error.
  assert.deepEqual(submissions[0]?.toolContinuations?.map((continuation) => continuation.callId), ['call-unowned']);
  assert.match(String(submissions[0]?.toolContinuations?.[0]?.output ?? ''), /not available in this Harness/);
});

test('provider agent driver replays the whole tool history into every continuation', async () => {  // The provider has no server-side conversation state, so a continuation that
  // carried only the current round would hide every earlier round from the
  // model and make a multi-round task repeat itself indefinitely.
  let round = 0;
  const submissions: ProviderSubmitInput[] = [];
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      round += 1;
      if (round <= 3) {
        yield {
          ...identity,
          eventId: `event-tool-call-${round}`,
          kind: 'tool',
          summary: 'file.write',
          outputRefs: [`artifact://tool-call-${round}`],
          evidenceRefs: [evidence],
          toolCall: {
            callId: `call-${round}`,
            toolId: 'file.write',
            arguments: { file_path: `file-${round}.txt` },
            continuationRef: `response-round-${round}`,
          },
        };
        yield {
          ...identity,
          eventId: `event-tool-waiting-${round}`,
          kind: 'terminal',
          terminalState: 'waiting',
          evidenceRefs: [evidence],
          nextAction: { kind: 'continue', ref: 'responses-tool-call' },
        };
        return;
      }
      yield { ...identity, eventId: 'event-final', kind: 'terminal', terminalState: 'succeeded', evidenceRefs: [evidence] };
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
    tools: [{ toolId: 'file.write', description: 'write file', inputSchema: { type: 'object' } }],
    executeTool: {
      async execute({ call }) {
        return { output: `wrote ${String(call.arguments.file_path)}`, outputRefs: [], evidenceRefs: [evidence] };
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'write three files' } });
  for await (const _event of instance.observe({ runtimeId: identity.runtimeId })) {
    // Drain the execution to its terminal state.
  }
  assert.equal(submissions.length, 3);
  assert.deepEqual(submissions.map((input) => input.toolContinuations?.map((c) => c.callId)), [
    ['call-1'],
    ['call-1', 'call-2'],
    ['call-1', 'call-2', 'call-3'],
  ]);
  assert.deepEqual(submissions[2]?.toolContinuations?.map((c) => c.output), [
    'wrote file-1.txt',
    'wrote file-2.txt',
    'wrote file-3.txt',
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

test('provider agent driver drains cleanly when a stopped tool executor rejects with the abort', async () => {
  let enteredTool!: () => void;
  const toolEntered = new Promise<void>((resolve) => { enteredTool = resolve; });
  let providerSettled = false;
  let toolSignal: AbortSignal | undefined;
  const submissions: ProviderSubmitInput[] = [];
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      yield {
        ...identity,
        eventId: 'event-tool-call-abort',
        kind: 'tool',
        summary: 'file.read',
        outputRefs: ['artifact://tool-call-abort'],
        evidenceRefs: [evidence],
        toolCall: { callId: 'call-abort', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-round-1' },
      };
      yield {
        ...identity,
        eventId: 'event-tool-waiting-abort',
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
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('file.read was stopped'), { name: 'AbortError' }));
          }, { once: true });
        });
        throw new Error('unreachable tool result');
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
  const observation = await pendingObservation;
  assert.equal(observation.done, false);
  assert.equal(observation.value?.kind, 'provider.tool-result');
  assert.equal(observation.value?.providerEvent.toolPhase, 'result');
  assert.equal(observation.value?.providerEvent.toolResult?.callId, 'call-abort');
  assert.equal(observation.value?.providerEvent.toolResult?.toolId, 'file.read');
  assert.equal(observation.value?.providerEvent.toolResult?.status, 'cancelled');
  assert.equal((await iterator.next()).done, true);
  assert.equal((await pendingSettlement).state, 'stopped');
  assert.equal(providerSettled, true);
  assert.equal(submissions.length, 0);
});

test('provider agent driver still surfaces a non-abort tool failure during a tool round', async () => {
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      yield {
        ...identity,
        eventId: 'event-tool-call-failure',
        kind: 'tool',
        summary: 'file.read',
        outputRefs: ['artifact://tool-call-failure'],
        evidenceRefs: [evidence],
        toolCall: { callId: 'call-failure', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-round-1' },
      };
      yield {
        ...identity,
        eventId: 'event-tool-waiting-failure',
        kind: 'terminal',
        terminalState: 'waiting',
        evidenceRefs: [evidence],
        nextAction: { kind: 'continue', ref: 'responses-tool-call' },
      };
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
      async execute() {
        throw new Error('file.read failed for real');
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'read README.md' } });
  const iterator = instance.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, 'provider.tool');
  // The typed failure must cross the driver as evidence bound to the same
  // callId before the executor error propagates: a consumer that records the
  // round needs the descriptor, and the error must still fail the execution.
  const failed = await iterator.next();
  assert.equal(failed.value?.kind, 'provider.tool-result');
  assert.equal(failed.value?.summary, 'file.read failed');
  assert.equal(failed.value?.providerEvent?.toolResult?.callId, 'call-failure');
  assert.equal(failed.value?.providerEvent?.toolResult?.status, 'failed');
  assert.match(String(failed.value?.providerEvent?.toolResult?.error?.message ?? ''), /file\.read failed for real/);
  await assert.rejects(() => iterator.next(), /file.read failed for real/);
});

test('provider agent driver rethrows an executor-returned failure as a typed provider error', async () => {
  // The web-search executor reports an unavailable backend by RETURNING a failed
  // result, not by throwing. Throwing the bare ProviderError object would make
  // every downstream projection degrade to String(plainObject) and lose the real
  // code, category, retryability and next action of the failure.
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      yield {
        ...identity,
        eventId: 'event-tool-call-returned-failure',
        kind: 'tool',
        summary: 'web.search',
        outputRefs: ['artifact://tool-call-returned-failure'],
        evidenceRefs: [evidence],
        toolCall: { callId: 'call-returned-failure', toolId: 'web.search', arguments: { query: 'rust' }, continuationRef: 'response-round-1' },
      };
      yield {
        ...identity,
        eventId: 'event-tool-waiting-returned-failure',
        kind: 'terminal',
        terminalState: 'waiting',
        evidenceRefs: [evidence],
        nextAction: { kind: 'continue', ref: 'responses-tool-call' },
      };
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
    tools: [{ toolId: 'web.search', description: 'search the web', inputSchema: { type: 'object' } }],
    executeTool: {
      async execute() {
        return {
          output: '{"code":"provider-unavailable"}',
          outputRefs: [],
          evidenceRefs: [evidence],
          status: 'failed' as const,
          error: {
            errorId: 'provider.observe.provider-unavailable',
            code: 'provider-unavailable',
            category: 'provider' as const,
            phase: 'observe' as const,
            message: 'the provider backend is unavailable',
            ownerId: 'humanagent.provider-adapter',
            retryable: 'retryable' as const,
            attention: 'foreground' as const,
            evidenceRefs: [evidence],
            nextAction: { kind: 'recover' as const, ref: 'provider.retry' },
          },
        };
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'search the web for rust' } });
  const iterator = instance.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, 'provider.tool');
  const failed = await iterator.next();
  assert.equal(failed.value?.kind, 'provider.tool-result');
  assert.equal(failed.value?.providerEvent?.toolResult?.status, 'failed');
  assert.equal(failed.value?.providerEvent?.toolResult?.error?.code, 'provider-unavailable');
  await assert.rejects(
    () => iterator.next(),
    (error: unknown) => {
      assert.ok(error instanceof ProviderAdapterError, 'the failure must stay an Error instance');
      assert.equal(error.providerError.code, 'provider-unavailable');
      assert.equal(error.providerError.category, 'provider');
      assert.equal(error.providerError.message, 'the provider backend is unavailable');
      assert.equal(error.providerError.retryable, 'retryable');
      assert.equal(error.providerError.nextAction.ref, 'provider.retry');
      assert.notEqual(String(error), '[object Object]');
      return true;
    },
  );
});

test('provider agent driver honors the configured tool round limit', async () => {
  // The provider always asks for another tool round, so only the configured
  // bound can stop the loop. A long-horizon task needs a bound larger than the
  // adapter default, so the limit must come from the assembly decision.
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      yield {
        ...identity,
        eventId: 'event-tool-call-loop',
        kind: 'tool',
        summary: 'file.read',
        outputRefs: ['artifact://tool-call-loop'],
        evidenceRefs: [evidence],
        toolCall: { callId: 'call-loop', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-round-1' },
      };
      yield {
        ...identity,
        eventId: 'event-tool-waiting-loop',
        kind: 'terminal',
        terminalState: 'waiting',
        evidenceRefs: [evidence],
        nextAction: { kind: 'continue', ref: 'responses-tool-call' },
      };
    },
    submit: async (): Promise<ProviderSubmitResult> => ({ ...identity, status: 'accepted', outputRefs: [], evidenceRefs: [evidence] }),
  });
  let executions = 0;
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
    maxToolRounds: 3,
    executeTool: {
      async execute() {
        executions += 1;
        return { output: 'file body', outputRefs: [], evidenceRefs: [evidence] };
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'read README.md' } });
  await assert.rejects(
    (async () => {
      for await (const _event of instance.observe({ runtimeId: identity.runtimeId })) {
        // Drain until the bound stops the loop.
      }
    })(),
    /tool round limit was exceeded/,
  );
  assert.equal(executions, 3);
});

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function recordingEvidenceSink(): {
  readonly sink: ProviderEvidenceSink;
  readonly writes: ProviderEvidenceWrite[];
} {
  const writes: ProviderEvidenceWrite[] = [];
  const content = new Map<string, Uint8Array>();
  const sink: ProviderEvidenceSink = {
    async write(input) {
      const ref: EvidenceRef = {
        evidenceId: id('evidence', `provider-driver-${input.type}-${writes.length + 1}`),
        kind: input.kind,
        source: 'provider-agent-driver-test',
        locator: input.locator,
        scope: input.scope,
      };
      writes.push(input);
      content.set(ref.evidenceId.value, new TextEncoder().encode(
        typeof input.content === 'string' ? input.content : JSON.stringify(input.content),
      ));
      return ref;
    },
    async read(ref) {
      const bytes = content.get(ref.evidenceId.value);
      if (!bytes) throw new Error(`missing provider evidence ${ref.evidenceId.value}`);
      return bytes;
    },
  };
  return { sink, writes };
}

function realProviderAdapter(fetch: V3ProviderFetch): ProviderAdapter {
  const captured = recordingEvidenceSink();
  const transport = createV3ProviderHttpTransport({
    binding,
    baseUrl: 'http://127.0.0.1:4444',
    evidence: captured.sink,
    fetch,
  });
  return new ProviderAdapter({
    binding,
    routeRef: 'test-route',
    codec: new ResponsesProviderCodec(),
    transport,
    evidence: captured.sink,
  });
}

function delayedResponse(body: AsyncIterable<Uint8Array>): V3ProviderFetchResponse {
  return {
    status: 200,
    body,
    text: async () => '',
  };
}

async function* chunks(values: readonly string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

test('provider agent driver mints one stable turn id across a real request lifecycle', async () => {
  const firstFetchStarted = deferred<V3ProviderFetchInit>();
  const releaseFirstFetch = deferred<void>();
  const requests: Array<{ readonly url: string; readonly init: V3ProviderFetchInit }> = [];
  const fetch: V3ProviderFetch = async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) {
      firstFetchStarted.resolve(init);
      await releaseFirstFetch.promise;
      return delayedResponse(chunks([
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-round-1' } })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call-readme', name: 'file_read', arguments: '' },
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call-readme', name: 'file_read', arguments: '{"path":"README.md"}' },
        })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-round-1' } })}\n\n`,
      ]));
    }
    return delayedResponse(chunks([
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-round-2' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.done', item_id: 'final-message', text: 'README.md read' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-round-2' } })}\n\n`,
    ]));
  };
  const lifecycle: ProviderRequestLifecycleEvent[] = [];
  const observed: ProviderAgentEvent[] = [];
  const instance = new ProviderAgentDriver({
    port: realProviderAdapter(fetch),
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-a',
    scope,
    inputRefs: ['input-1'],
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    executeTool: {
      async execute({ call }) {
        return {
          output: JSON.stringify({ path: call.arguments.path, content: 'README_CONTENT' }),
          outputRefs: ['asset://provider-tool/readme'],
          evidenceRefs: [evidence],
        };
      },
    },
    onRequestLifecycle(event) {
      lifecycle.push(event);
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });

  const submit = instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'read README.md' } });
  await firstFetchStarted.promise;
  assert.deepEqual(lifecycle.map((event) => event.phase), ['dispatching']);
  const turnId = lifecycle[0]?.turnId;
  assert.equal(typeof turnId, 'string');
  assert.notEqual(turnId, '');
  const initialRequestId = lifecycle[0]?.requestId;
  assert.equal(typeof initialRequestId, 'string');
  assert.notEqual(initialRequestId, '');

  releaseFirstFetch.resolve();
  await submit;
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) observed.push(event);
  const settled = await instance.settle({ runtimeId: identity.runtimeId, executionEpoch: 1 });

  assert.equal(settled.state, 'succeeded');
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    'dispatching',
    'dispatched',
    'waiting',
    'dispatching',
    'dispatched',
    'settled',
  ]);
  assert.equal(lifecycle.every((event) => event.turnId === turnId), true);
  const continuationDispatch = lifecycle.filter((event) => event.phase === 'dispatching')[1];
  assert.ok(continuationDispatch);
  assert.equal(continuationDispatch.parentRequestId, initialRequestId);
  assert.notEqual(continuationDispatch.requestId, initialRequestId);
  assert.equal(lifecycle[2]?.externalResponseId, 'resp-round-1');
  assert.equal(lifecycle.at(-1)?.externalResponseId, 'resp-round-2');

  const initialEvent = observed.find((event) => event.providerEvent.turnId === turnId && event.providerEvent.requestId === initialRequestId);
  const continuationEvent = observed.find((event) => event.providerEvent.requestId === continuationDispatch.requestId);
  assert.ok(initialEvent);
  assert.ok(continuationEvent);
  assert.equal(initialEvent.providerEvent.occurredAt.endsWith('Z'), true);
  assert.equal(continuationEvent.providerEvent.parentRequestId, initialRequestId);
  assert.equal(requests.length, 2);
});

test('provider agent driver publishes a failed lifecycle endpoint when the initial fetch fails', async () => {
  const lifecycle: ProviderRequestLifecycleEvent[] = [];
  const instance = new ProviderAgentDriver({
    port: realProviderAdapter(async () => {
      throw new Error('local provider connection refused');
    }),
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    scope,
    inputRefs: ['input-1'],
    onRequestLifecycle(event) {
      lifecycle.push(event);
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await assert.rejects(
    () => instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'fail' } }),
    /connection refused/,
  );
  assert.deepEqual(lifecycle.map((event) => event.phase), ['dispatching', 'failed']);
  assert.equal(lifecycle.every((event) => event.turnId === lifecycle[0]?.turnId), true);
  assert.equal(lifecycle[1]?.requestId, lifecycle[0]?.requestId);
  assert.equal(lifecycle.some((event) => event.phase === 'dispatched'), false);
});
