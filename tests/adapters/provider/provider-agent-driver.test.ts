import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  validateProviderEvent,
  validateRawFactEnvelope,
  type AcceptedRawFact,
  type ActiveTurnBinding,
  type ActiveTurnProviderRequestIdentityRef,
  type AdmittedTurn,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type InteractionHelperIdentity,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionTurnIdentity,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderError,
  type ProviderRequestLifecycleEvent,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type TasklessProviderExecutionIdentityRef,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderSubmitResult,
  type ProviderSubmitInput,
  type ProviderToolCall,
  type ProviderToolStatus,
  type NativeRequestRegistration,
  type RawAsset,
  type RawFactEnvelope,
  type RuntimeRequestRecord,
  type ScopeRef,
  STANDARD_TURN_END_WIRE_TOOL_ID,
  type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import type { ProviderRequestContextHook } from '../../../packages/contracts/src/provider-request-context.js';
import {
  AnthropicProviderCodec,
  OpenAIChatProviderCodec,
  ResponsesProviderCodec,
  ProviderAdapter,
  ProviderAgentDriver,
  ProviderAdapterError,
  createV3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
  type ProviderAgentDriverOptions,
  type ProviderAgentEvent,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type ProviderToolExecutionPort,
  type ProviderTransport,
  type ProviderWireEvent,
  type ProviderWireRequest,
  type AnthropicWireRequest,
  type OpenAIChatWireRequest,
  type V3ProviderFetch,
  type V3ProviderFetchInit,
  type V3ProviderFetchResponse,
} from '../../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../../packages/adapters/filesystem/src/index.js';
import { ActiveTurnContext } from '../../../packages/runtime/src/context/active-turn-context.js';
import { foldActiveTurn } from '../../../packages/runtime/src/context/active-turn-materializer.js';
import type {
  ActiveTurnJournalPort,
  ActiveTurnJournalRecord,
} from '../../../packages/runtime/src/context/active-turn-journal.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    evidenceRefs: [evidence],
    output: JSON.stringify({ path: 'README.md', content: 'REAL_FILE_CONTENT' }),
  }, {
    callId: 'call-package',
    toolId: 'file.read',
    arguments: { path: 'package.json' },
    continuationRef: 'response-round-1',
    evidenceRefs: [evidence],
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

test('provider agent driver continues after a persisted reserved standard-turn-end refusal', async () => {
  const refusedOutput = JSON.stringify({
    owner: 'humanagent.app',
    kind: 'standard-turn-end',
    turnId: 'active-turn-ui-operation-1',
    accepted: false,
    error: {
      code: 'standard-turn-end.delivery-unresolved',
      message: 'delivery reference ux-handoff.md does not resolve to evidence scoped to this admitted turn',
    },
  });
  const correctedOutput = JSON.stringify({
    owner: 'humanagent.app',
    kind: 'standard-turn-end',
    turnId: 'active-turn-ui-operation-1',
    accepted: true,
  });
  const refusal: ProviderError = {
    errorId: 'provider.turn-end.refused',
    code: 'standard-turn-end.delivery-unresolved',
    category: 'provider',
    phase: 'tool',
    message: 'delivery reference ux-handoff.md does not resolve to evidence scoped to this admitted turn',
    ownerId: 'humanagent.app',
    retryable: 'manual',
    attention: 'foreground',
    evidenceRefs: [evidence],
    nextAction: { kind: 'recover', ref: 'standard-turn-end.delivery-unresolved' },
  };
  let round = 0;
  const submissions: ProviderSubmitInput[] = [];
  const executedCallIds: string[] = [];
  const acceptedFacts: RawFactEnvelope[] = [];
  const acceptedToolResults: Array<{ readonly status: string; readonly code: string | undefined }> = [];
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      round += 1;
      if (round <= 2) {
        const refused = round === 1;
        yield {
          ...identity,
          eventId: refused ? 'event-turn-end-refused' : 'event-turn-end-corrected',
          kind: 'tool',
          summary: STANDARD_TURN_END_WIRE_TOOL_ID,
          outputRefs: [`artifact://turn-end-${round}`],
          evidenceRefs: [evidence],
          toolCall: {
            callId: refused ? 'call-turn-end-refused' : 'call-turn-end-corrected',
            toolId: STANDARD_TURN_END_WIRE_TOOL_ID,
            arguments: {
              summary: { result: refused ? 'refuse invalid delivery' : 'deliver corrected result' },
              deliveryRefs: [refused ? 'ux-handoff.md' : 'provider-scoped-evidence'],
            },
            continuationRef: `response-round-${round}`,
          },
        };
        yield {
          ...identity,
          eventId: `event-waiting-${round}`,
          kind: 'terminal',
          terminalState: 'waiting',
          evidenceRefs: [evidence],
          nextAction: { kind: 'continue', ref: 'responses-tool-call' },
        };
        return;
      }
      yield { ...identity, eventId: 'event-turn-end-complete', kind: 'output', summary: 'turn ended', outputRefs: ['output-final'], evidenceRefs: [evidence] };
      yield { ...identity, eventId: 'event-turn-end-terminal', kind: 'terminal', terminalState: 'succeeded', evidenceRefs: [evidence] };
    },
    submit: async (input): Promise<ProviderSubmitResult> => {
      submissions.push(input);
      return { ...identity, status: 'accepted', outputRefs: [], evidenceRefs: [evidence] };
    },
  });
  const captured = recordingEvidenceSink();
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
    tools: [{ toolId: STANDARD_TURN_END_WIRE_TOOL_ID, description: 'end the current turn', inputSchema: { type: 'object' } }],
    rawEvidence: captured.sink,
    acceptRawFact: async (envelope) => {
      acceptedFacts.push(envelope);
      if (envelope.fact.kind === 'tool-result') {
        acceptedToolResults.push({
          status: envelope.fact.result.status,
          code: envelope.fact.result.error?.code,
        });
      }
      return { seq: acceptedFacts.length, acceptedAt: '2026-10-16T00:00:00.000Z', envelope };
    },
    registerRequest: async (registration) => registration.record,
    executeTool: {
      async execute({ call }) {
        executedCallIds.push(call.callId);
        if (call.callId === 'call-turn-end-refused') {
          return {
            output: refusedOutput,
            outputRefs: ['asset://provider-tool/refused'],
            evidenceRefs: [evidence],
            status: 'failed',
            error: refusal,
          };
        }
        return {
          output: correctedOutput,
          outputRefs: ['asset://provider-tool/corrected'],
          evidenceRefs: [evidence],
          status: 'succeeded',
        };
      },
    },
  });

  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'end the turn' } });
  const events: ProviderAgentEvent[] = [];
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) events.push(event);

  assert.deepEqual(executedCallIds, ['call-turn-end-refused', 'call-turn-end-corrected']);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0]?.toolContinuations?.[0]?.output, refusedOutput);
  assert.equal(submissions[0]?.toolContinuations?.[0]?.callId, 'call-turn-end-refused');
  assert.deepEqual(
    submissions[1]?.toolContinuations?.map((continuation) => [continuation.callId, continuation.output]),
    [
      ['call-turn-end-refused', refusedOutput],
      ['call-turn-end-corrected', correctedOutput],
    ],
  );
  assert.deepEqual(
    submissions.map((submission) => ({
      runtimeId: submission.runtimeId,
      taskId: submission.taskId,
      operationId: submission.operationId,
      executionEpoch: submission.executionEpoch,
    })),
    submissions.map(() => ({
      runtimeId: identity.runtimeId,
      taskId,
      operationId,
      executionEpoch: identity.executionEpoch,
    })),
  );
  const refusedWrite = captured.writes.find((write) => write.locator === 'provider/tool-result/call-turn-end-refused');
  assert.equal(refusedWrite?.type, 'tool-result-output');
  assert.equal(refusedWrite?.content, refusedOutput);
  assert.deepEqual(acceptedToolResults, [
    { status: 'failed', code: refusal.code },
    { status: 'succeeded', code: undefined },
  ]);
  assert.deepEqual(events.flatMap((event) => event.providerEvent.toolResult === undefined ? [] : [[event.providerEvent.toolResult.status, event.providerEvent.toolResult.callId]]), [
    ['failed', 'call-turn-end-refused'],
    ['succeeded', 'call-turn-end-corrected'],
  ]);
  assert.equal(events.at(-1)?.terminalState, 'succeeded');
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
  const registrations: NativeRequestRegistration[] = [];
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
    registerRequest: async (registration) => {
      registrations.push(structuredClone(registration));
      return registration.record;
    },
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
  assert.equal(
    registrations.some((entry) => entry.record.phase === 'settled'),
    false,
    'a partial batch failure must not commit normal settled for the request',
  );
  assert.equal(
    registrations.filter((entry) => entry.record.phase === 'dispatching').length,
    1,
    'a partial batch failure must not register a continuation dispatch',
  );
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
  const acceptedOrder: string[] = [];
  const writes: Array<{ type: string; content?: string }> = [];
  const fakeSink: ProviderEvidenceSink = {
    async write(writeInput) {
      writes.push({ type: writeInput.type, content: typeof writeInput.content === 'string' ? writeInput.content : undefined });
      return evidence;
    },
    async read() { throw new Error('unused'); },
  };
  const registrations: NativeRequestRegistration[] = [];
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
    rawEvidence: fakeSink,
    acceptRawFact: async (envelope) => {
      acceptedOrder.push(`raw:${envelope.fact.kind}`);
      return { seq: acceptedOrder.length, acceptedAt: '2026-10-16T00:00:00.000Z', envelope };
    },
    registerRequest: async (registration) => {
      registrations.push(structuredClone(registration));
      acceptedOrder.push(`register:${registration.record.phase}`);
      return registration.record;
    },
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

  const initialRequestId = registrations[0]!.record.request.requestId;
  const initialSettledIndex = acceptedOrder.indexOf('register:settled');
  const toolResultIndex = acceptedOrder.indexOf('raw:tool-result');
  const continuationDispatchIndex = acceptedOrder.lastIndexOf('register:dispatching');

  assert.ok(
    toolResultIndex !== -1,
    'unowned negative tool result must be durably accepted through raw fact acceptance',
  );
  assert.ok(
    toolResultIndex < initialSettledIndex,
    'unowned negative tool result acceptance must occur before request settled',
  );
  assert.ok(
    initialSettledIndex < continuationDispatchIndex,
    'request settled must be registered before continuation dispatching',
  );
  assert.deepEqual(
    registrations.map((entry) => [
      entry.record.request.requestId === initialRequestId ? 'R1' : 'R2',
      entry.record.phase,
    ]),
    [
      ['R1', 'dispatching'],
      ['R1', 'dispatched'],
      ['R1', 'waiting'],
      ['R1', 'settled'],
      ['R2', 'dispatching'],
      ['R2', 'dispatched'],
      ['R2', 'settled'],
    ],
  );
  assert.equal(
    writes.find((w) => w.type === 'tool-result-output')?.content,
    'exec_command is not available in this Harness; only these function tools can be called: file.read',
  );
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
  // The fixture always asks for another tool round up to a finite ninth round,
  // then emits an ordinary `succeeded` terminal with no tool call. Only an
  // explicit budget may stop the loop; a long-horizon task must not inherit a
  // hidden default bound. The same local fixture expresses both conditions.
  const buildDriver = (maxToolRounds?: number) => {
    let observeCalls = 0;
    let executions = 0;
    const runtimePort = port({
      observe: async function* (): AsyncIterable<ProviderEvent> {
        observeCalls += 1;
        const round = observeCalls;
        if (round <= 9) {
          yield {
            ...identity,
            eventId: `event-tool-call-${round}`,
            kind: 'tool',
            summary: 'file.read',
            outputRefs: [`artifact://tool-call-${round}`],
            evidenceRefs: [evidence],
            toolCall: {
              callId: `call-${round}`,
              toolId: 'file.read',
              arguments: { path: `file-${round}.md` },
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
        yield {
          ...identity,
          eventId: 'event-terminal-succeeded',
          kind: 'terminal',
          terminalState: 'succeeded',
          evidenceRefs: [evidence],
        };
      },
      submit: async (): Promise<ProviderSubmitResult> => ({ ...identity, status: 'accepted', outputRefs: [], evidenceRefs: [evidence] }),
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
      ...(maxToolRounds === undefined ? {} : { maxToolRounds }),
      executeTool: {
        async execute() {
          executions += 1;
          return { output: `file body ${executions}`, outputRefs: [], evidenceRefs: [evidence] };
        },
      },
    });
    return { instance, executions: () => executions };
  };

  // Missing budget: nine tool rounds must run, each producing a tool-result
  // continuation, and the ordinary terminal must arrive without a round-limit
  // rejection.
  const unbounded = buildDriver();
  await unbounded.instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await unbounded.instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'read README.md' } });
  const unboundedResults: string[] = [];
  let unboundedTerminal: string | undefined;
  let unboundedError: unknown;
  try {
    for await (const event of unbounded.instance.observe({ runtimeId: identity.runtimeId })) {
      if (event.kind === 'provider.tool-result') unboundedResults.push(event.providerEvent?.toolResult?.callId ?? '');
      if (event.kind === 'provider.terminal') unboundedTerminal = event.terminalState;
    }
  } catch (cause) {
    unboundedError = cause;
  }
  assert.equal(
    unbounded.executions(),
    9,
    `the missing-budget loop must run all nine rounds (error: ${unboundedError instanceof Error ? unboundedError.message : 'none'})`,
  );
  assert.equal(unboundedError, undefined, `the missing-budget loop must reach the normal terminal, not ${String(unboundedError)}`);
  assert.deepEqual(unboundedResults, ['call-1', 'call-2', 'call-3', 'call-4', 'call-5', 'call-6', 'call-7', 'call-8', 'call-9']);
  assert.equal(unboundedTerminal, 'succeeded');

  // Explicit budget: three rounds run, the fourth is rejected before any tool
  // side effect and without submitting its result.
  const bounded = buildDriver(3);
  await bounded.instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: 1 });
  await bounded.instance.submit({ taskId, executionEpoch: 1, assignmentId: 'assignment-a', payload: { prompt: 'read README.md' } });
  await assert.rejects(
    (async () => {
      for await (const _event of bounded.instance.observe({ runtimeId: identity.runtimeId })) {
        // Drain until the explicit bound stops the loop.
      }
    })(),
    /tool round limit was exceeded/,
  );
  assert.equal(bounded.executions(), 3);
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
    'settled',
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

test('provider agent driver runs a taskless helper through the real adapter tool round and settles without a task', async () => {
  const helperOrgan = id('organ', 'organ-taskless');
  const helperOperation = id('operation', 'operation-taskless');
  const helperScope: ScopeRef = { organId: helperOrgan, operationId: helperOperation };
  const helperEvidence: EvidenceRef = {
    evidenceId: id('evidence', 'taskless-helper-scope'),
    kind: 'operation',
    source: 'provider-agent-driver-test',
    locator: `operation/${helperOperation.value}/scope`,
    scope: helperScope,
  };
  const helper: InteractionHelperIdentity = {
    organId: helperOrgan,
    interactionScopeId: 'interaction-taskless-1',
    interactionId: 'interaction-taskless-1',
    inputRevision: 1,
    parentTurnId: 'turn-parent-1',
    assignmentId: 'assignment-taskless-1',
    helperCallId: 'helper-call-1',
    attempt: 1,
  };
  const helperExecution: TasklessProviderExecutionIdentityRef = {
    runtimeId: identity.runtimeId,
    organId: helperOrgan,
    operationId: helperOperation,
    executionEpoch: 1,
    helper,
  };
  let round = 0;
  const fetch: V3ProviderFetch = async () => {
    round += 1;
    if (round === 1) {
      return delayedResponse(chunks([
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-taskless-1' } })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call-taskless-read', name: 'file_read', arguments: '' },
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call-taskless-read', name: 'file_read', arguments: '{"path":"README.md"}' },
        })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-taskless-1' } })}\n\n`,
      ]));
    }
    return delayedResponse(chunks([
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-taskless-2' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.done', item_id: 'final-message', text: 'README.md read' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-taskless-2' } })}\n\n`,
    ]));
  };
  const captured = recordingEvidenceSink();
  const accepted: RawFactEnvelope<TasklessProviderExecutionIdentityRef>[] = [];
  const registrations: NativeRequestRegistration[] = [];
  const lifecycle: ProviderRequestLifecycleEvent<TasklessProviderExecutionIdentityRef>[] = [];
  const adapter = new ProviderAdapter<TasklessProviderExecutionIdentityRef>({
    binding,
    routeRef: 'test-route',
    codec: new ResponsesProviderCodec(),
    transport: createV3ProviderHttpTransport<TasklessProviderExecutionIdentityRef>({
      binding,
      baseUrl: 'http://127.0.0.1:4444',
      evidence: captured.sink,
      fetch,
    }),
    evidence: captured.sink,
  });
  const options: ProviderAgentDriverOptions<TasklessProviderExecutionIdentityRef> = {
    port: adapter,
    binding,
    runtimeId: identity.runtimeId,
    organId: helperOrgan,
    helper,
    operationId: helperOperation,
    executionEpoch: 1,
    assignmentId: helper.assignmentId,
    scope: helperScope,
    inputRefs: ['input-1'],
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    rawEvidence: captured.sink,
    acceptRawFact: async (envelope) => {
      validateRawFactEnvelope(envelope);
      accepted.push(envelope);
      return { seq: accepted.length, envelope };
    },
    registerRequest: async (registration) => {
      registrations.push(registration);
      return registration.record;
    },
    onRequestLifecycle(event) {
      lifecycle.push(event);
    },
    executeTool: {
      async execute() {
        return {
          output: JSON.stringify({ path: 'README.md', content: 'README_CONTENT' }),
          outputRefs: ['asset://provider-tool/readme'],
          evidenceRefs: [helperEvidence],
        };
      },
    },
  };
  const instance = new ProviderAgentDriver<TasklessProviderExecutionIdentityRef>(options);
  await instance.start({ ...helperExecution });
  const submitted = await instance.submit({
    ...helperExecution,
    assignmentId: helper.assignmentId,
    payload: { prompt: 'read README.md' },
  });
  assert.equal(submitted.payload.status, 'accepted');

  const observed: string[] = [];
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) observed.push(event.kind);
  const settled = await instance.settle({ runtimeId: identity.runtimeId, executionEpoch: 1 });
  assert.equal(settled.state, 'succeeded');
  assert.deepEqual(observed, [
    'provider.model',
    'provider.model',
    'provider.tool',
    'provider.tool-result',
    'provider.model',
    'provider.output',
    'provider.terminal',
  ]);

  const settlement = instance.settlement();
  assert.ok(settlement);
  const scopeRefs = [...settled.evidenceRefs, ...settlement.evidenceRefs];
  assert.ok(scopeRefs.length > 0);
  for (const ref of scopeRefs) {
    assert.equal(ref.scope.organId.value, helperOrgan.value);
    assert.equal(ref.scope.operationId?.value, helperOperation.value);
    assert.equal(ref.scope.taskId, undefined);
  }

  const toolResultEnvelope = accepted.find((envelope) => envelope.fact.kind === 'tool-result');
  assert.ok(toolResultEnvelope, 'expected a durably accepted tool-result raw fact');
  if (toolResultEnvelope.fact.kind !== 'tool-result') throw new Error('expected a tool-result raw fact');
  const toolResult = toolResultEnvelope.fact.result;
  assert.deepEqual(toolResult.helper, helper);
  assert.equal('taskId' in toolResult, false);
  assert.equal(toolResult.runtimeId, helperExecution.runtimeId);
  assert.equal(toolResult.executionEpoch, helperExecution.executionEpoch);
  assert.equal(
    captured.writes.find((write) => write.type === 'tool-result-output')?.content,
    JSON.stringify({ path: 'README.md', content: 'README_CONTENT' }),
  );
  assert.ok(registrations.length > 0);
  assert.equal(registrations.every(({ record }) => record.scope.taskId === undefined), true);
  assert.equal(lifecycle.find((event) => event.phase === 'waiting')?.externalResponseId, 'resp-taskless-1');
  assert.equal(lifecycle.at(-1)?.externalResponseId, 'resp-taskless-2');

  const wrongEpoch: RawFactEnvelope<TasklessProviderExecutionIdentityRef> = {
    ...toolResultEnvelope,
    fact: {
      ...toolResultEnvelope.fact,
      result: { ...toolResult, executionEpoch: toolResult.executionEpoch + 1 },
    },
  };
  assert.throws(
    () => validateRawFactEnvelope(wrongEpoch),
    (error) => error instanceof ContractError,
  );

  const mismatch = new ProviderAgentDriver<TasklessProviderExecutionIdentityRef>(options);
  await assert.rejects(
    () => mismatch.start({ ...helperExecution, helper: { ...helper, helperCallId: 'helper-call-other' } }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
});

test('provider agent driver runs a neutral interaction-parent turn through the real adapter tool round without a task or helper', async () => {
  // The neutral interaction parent is the third identity shape: a real
  // interaction turn and no Task, cycle or helper. This consumer drives the same
  // adapter tool round the Task and taskless-helper paths use, then folds the
  // durable parent facts through the shared Runtime materializer.
  const parentOrgan = id('organ', 'organ-interaction-parent');
  const parentOperation = id('operation', 'operation-interaction-parent');
  const parentScope: ScopeRef = { organId: parentOrgan, operationId: parentOperation };
  const parentEvidence: EvidenceRef = {
    evidenceId: id('evidence', 'interaction-parent-scope'),
    kind: 'operation',
    source: 'provider-agent-driver-test',
    locator: `operation/${parentOperation.value}/scope`,
    scope: parentScope,
  };
  const interactionTurn: InteractionTurnIdentity = {
    organId: parentOrgan,
    interactionScopeId: 'interaction-parent-1',
    interactionId: 'interaction-parent-1',
    inputRevision: 1,
    turnId: 'turn-interaction-parent-1',
  };
  const parentExecution: InteractionParentProviderExecutionIdentityRef = {
    runtimeId: identity.runtimeId,
    organId: parentOrgan,
    operationId: parentOperation,
    executionEpoch: 1,
    interactionTurn,
  };
  let round = 0;
  const fetch: V3ProviderFetch = async () => {
    round += 1;
    if (round === 1) {
      return delayedResponse(chunks([
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-parent-1' } })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call-parent-read', name: 'file_read', arguments: '' },
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call-parent-read', name: 'file_read', arguments: '{"path":"README.md"}' },
        })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-parent-1' } })}\n\n`,
      ]));
    }
    return delayedResponse(chunks([
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-parent-2' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.done', item_id: 'final-message', text: 'README.md read' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-parent-2' } })}\n\n`,
    ]));
  };
  const captured = recordingEvidenceSink();
  const accepted: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef>[] = [];
  const registrations: NativeRequestRegistration[] = [];
  const lifecycle: ProviderRequestLifecycleEvent<InteractionParentProviderExecutionIdentityRef>[] = [];
  const adapter = new ProviderAdapter<InteractionParentProviderExecutionIdentityRef>({
    binding,
    routeRef: 'test-route',
    codec: new ResponsesProviderCodec(),
    transport: createV3ProviderHttpTransport<InteractionParentProviderExecutionIdentityRef>({
      binding,
      baseUrl: 'http://127.0.0.1:4444',
      evidence: captured.sink,
      fetch,
    }),
    evidence: captured.sink,
  });
  const options: ProviderAgentDriverOptions<InteractionParentProviderExecutionIdentityRef> = {
    port: adapter,
    binding,
    runtimeId: identity.runtimeId,
    organId: parentOrgan,
    interactionTurn,
    operationId: parentOperation,
    executionEpoch: 1,
    assignmentId: 'assignment-interaction-parent-1',
    scope: parentScope,
    inputRefs: ['input-1'],
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    rawEvidence: captured.sink,
    acceptRawFact: async (envelope) => {
      validateRawFactEnvelope(envelope);
      accepted.push(envelope);
      return { seq: accepted.length, envelope };
    },
    registerRequest: async (registration) => {
      registrations.push(registration);
      return registration.record;
    },
    onRequestLifecycle(event) {
      lifecycle.push(event);
    },
    executeTool: {
      async execute() {
        return {
          output: JSON.stringify({ path: 'README.md', content: 'README_CONTENT' }),
          outputRefs: ['asset://provider-tool/readme'],
          evidenceRefs: [parentEvidence],
        };
      },
    },
  };
  const instance = new ProviderAgentDriver<InteractionParentProviderExecutionIdentityRef>(options);
  await instance.start({ ...parentExecution });
  const submitted = await instance.submit({
    ...parentExecution,
    assignmentId: 'assignment-interaction-parent-1',
    payload: { prompt: 'read README.md' },
  });
  assert.equal(submitted.payload.status, 'accepted');

  const observed: ProviderAgentEvent<InteractionParentProviderExecutionIdentityRef>[] = [];
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) observed.push(event);
  const settled = await instance.settle({ runtimeId: identity.runtimeId, executionEpoch: 1 });
  assert.equal(settled.state, 'succeeded');
  assert.deepEqual(observed.map((event) => event.kind), [
    'provider.model',
    'provider.model',
    'provider.tool',
    'provider.tool-result',
    'provider.model',
    'provider.output',
    'provider.terminal',
  ]);

  // Every event carries the real interaction turn and no Task or helper.
  for (const event of observed) {
    assert.deepEqual(event.interactionTurn, interactionTurn);
    assert.deepEqual(event.providerEvent.interactionTurn, interactionTurn);
    assert.equal('taskId' in event, false);
    assert.equal('helper' in event, false);
  }
  assert.equal(lifecycle.length > 0, true);
  for (const event of lifecycle) {
    assert.deepEqual(event.interactionTurn, interactionTurn);
    assert.equal('taskId' in event, false);
    assert.equal('helper' in event, false);
  }
  assert.equal(lifecycle.find((event) => event.phase === 'waiting')?.externalResponseId, 'resp-parent-1');
  assert.equal(lifecycle.at(-1)?.externalResponseId, 'resp-parent-2');

  const settlement = instance.settlement();
  assert.ok(settlement);
  const scopeRefs = [...settled.evidenceRefs, ...settlement.evidenceRefs];
  assert.ok(scopeRefs.length > 0);
  for (const ref of scopeRefs) {
    assert.equal(ref.scope.organId.value, parentOrgan.value);
    assert.equal(ref.scope.operationId?.value, parentOperation.value);
    assert.equal(ref.scope.taskId, undefined);
  }

  const toolResultEnvelope = accepted.find((envelope) => envelope.fact.kind === 'tool-result');
  assert.ok(toolResultEnvelope, 'expected a durably accepted parent tool-result raw fact');
  if (toolResultEnvelope.fact.kind !== 'tool-result') throw new Error('expected a tool-result raw fact');
  const toolResult = toolResultEnvelope.fact.result;
  assert.deepEqual(toolResult.interactionTurn, interactionTurn);
  assert.equal('taskId' in toolResult, false);
  assert.equal('helper' in toolResult, false);
  assert.equal(toolResult.runtimeId, parentExecution.runtimeId);
  assert.equal(toolResult.executionEpoch, parentExecution.executionEpoch);
  assert.equal(
    captured.writes.find((write) => write.type === 'tool-result-output')?.content,
    JSON.stringify({ path: 'README.md', content: 'README_CONTENT' }),
  );
  assert.ok(registrations.length > 0);
  assert.equal(registrations.every(({ record }) => record.scope.taskId === undefined), true);
  assert.equal(registrations.every(({ record }) => record.scope.operationId?.value === parentOperation.value), true);

  // The shared Runtime materializer folds the durable parent facts: the tool
  // result resolves and still carries the real interaction turn.
  const inputRef = await captured.sink.write({
    scope: parentScope,
    kind: 'operation',
    type: 'interaction-parent-input',
    locator: `operation/${parentOperation.value}/input`,
    content: 'read README.md',
  });
  const initialInput: RawAsset = { ref: inputRef, view: { kind: 'utf8-text' } };
  const folded = await foldActiveTurn<{ readonly producersDrained: true }, { readonly execution: InteractionParentProviderExecutionIdentityRef; readonly scope: ScopeRef }, InteractionParentProviderExecutionIdentityRef>({
    binding: { execution: parentExecution, scope: parentScope },
    initialInput,
    entries: accepted.map((envelope, index) => ({ seq: index + 1, envelope })),
    requests: registrations.map(({ record }) => record),
    childInvocations: [],
    cut: { producersDrained: true },
    checkpointPath: [],
    completionRefs: [],
    rawContent: providerRawContentReader(captured.sink),
  });
  const foldedToolResult = folded.entries.find((entry) => entry.kind === 'tool-result');
  assert.ok(foldedToolResult, 'expected the shared materializer to fold the parent tool-result');
  if (!foldedToolResult || foldedToolResult.kind !== 'tool-result') throw new Error('expected a folded tool-result');
  assert.deepEqual(foldedToolResult.accepted.envelope.fact.result.interactionTurn, interactionTurn);

  const wrongEpoch: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef> = {
    ...toolResultEnvelope,
    fact: {
      ...toolResultEnvelope.fact,
      result: { ...toolResult, executionEpoch: toolResult.executionEpoch + 1 },
    },
  };
  assert.throws(
    () => validateRawFactEnvelope(wrongEpoch),
    (error) => error instanceof ContractError,
  );

  const mismatch = new ProviderAgentDriver<InteractionParentProviderExecutionIdentityRef>(options);
  await assert.rejects(
    () => mismatch.start({ ...parentExecution, interactionTurn: { ...interactionTurn, turnId: 'turn-interaction-parent-other' } }),
    (error) => error instanceof ProviderAdapterError && error.providerError.code === 'runtime.identity.mismatch',
  );
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

class MemoryActiveTurnJournal implements ActiveTurnJournalPort {
  private readonly records: ActiveTurnJournalRecord[] = [];

  async append(input: { readonly commitId: string; readonly record: ActiveTurnJournalRecord }): Promise<void> {
    this.records.push(input.record);
  }

  async replay(): Promise<readonly ActiveTurnJournalRecord[]> {
    return [...this.records];
  }
}

function r1ActiveBinding(): ActiveTurnBinding {
  const assignment: WorkAssignment = {
    assignmentId: 'assignment-r1',
    taskId,
    pipelineNodeId: 'node-r1',
    attempt: 1,
    executionEpoch: identity.executionEpoch,
    inputRevision: 1,
    objective: 'R1 raw persistence fixture',
    targetRefs: [],
    expectedOutputRefs: [],
    acceptanceCriteriaDigest: 'sha256:r1',
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  };
  const admittedTurn: AdmittedTurn = {
    turnId: 'turn-r1',
    workAssignmentRef: assignment.assignmentId,
    taskRef: taskId,
    scopeRef: scope,
    cycleRef: id('cycle', 'cycle-r1'),
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: identity.executionEpoch,
    runtimeBindingRef: 'runtime-binding-r1',
    permissionRevision: 'permission-r1',
    admissionEvidenceRefs: ['evidence-admission-r1'],
    currentTurnRef: 'active-turn://r1/binding',
    recoveryStateRef: 'evidence-recovery-r1',
  };
  return {
    admittedTurn,
    assignment,
    execution: { runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch },
    scope,
  };
}

function providerAdapterWithSink(fetch: V3ProviderFetch, sink: ProviderEvidenceSink): ProviderAdapter {
  const transport = createV3ProviderHttpTransport({
    binding,
    baseUrl: 'http://127.0.0.1:4444',
    evidence: sink,
    fetch,
  });
  return new ProviderAdapter({
    binding,
    routeRef: 'test-route',
    codec: new ResponsesProviderCodec(),
    transport,
    evidence: sink,
  });
}

function sseResponse(events: readonly unknown[]): V3ProviderFetchResponse {
  return delayedResponse(chunks(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)));
}

function singleToolRoundFetch(callId: string, responseId: string): V3ProviderFetch {
  return async () => sseResponse([
    { type: 'response.created', response: { id: responseId } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: callId, name: 'file_read', arguments: '' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: callId, name: 'file_read', arguments: '{"path":"README.md"}' } },
    { type: 'response.completed', response: { id: responseId } },
  ]);
}

interface RawPersistenceHarnessInput {
  readonly root: string;
  readonly fetch: V3ProviderFetch;
  readonly executeTool: ProviderToolExecutionPort;
  readonly sink?: ProviderEvidenceSink;
  readonly accept?: (
    inner: (envelope: RawFactEnvelope) => Promise<AcceptedRawFact>,
  ) => (envelope: RawFactEnvelope) => Promise<AcceptedRawFact>;
  readonly registerRequest?: (registration: NativeRequestRegistration) => Promise<RuntimeRequestRecord>;
  readonly parentRequest?: ActiveTurnProviderRequestIdentityRef;
}

function sseResponseReturning(onClose: () => void): V3ProviderFetch {
  return async (_url, init): Promise<V3ProviderFetchResponse> => {
    // The transport aborts its request controller when the observe consumer
    // stops before the provider terminal, so the abort is the observable
    // stream-close signal. A generator `finally` would not fire while the body
    // is parked on a never-resolving await.
    init.signal?.addEventListener('abort', onClose);
    return delayedResponse((async function* (): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-close-probe' } })}\n\n`,
      );
      yield new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg-close-probe', delta: 'probe' })}\n\n`,
      );
      yield new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-close-probe' } })}\n\n`,
      );
      await new Promise<void>(() => {});
    })());
  };
}

interface RawPersistenceHarness {
  readonly instance: ProviderAgentDriver;
  readonly context: ActiveTurnContext;
  readonly store: ImmutableAssetStore;
  readonly baseSink: ProviderEvidenceSink;
  readonly submissions: ProviderSubmitInput[];
  readonly settleCalls: () => number;
}

async function rawPersistenceHarness(input: RawPersistenceHarnessInput): Promise<RawPersistenceHarness> {
  const store = new ImmutableAssetStore(input.root);
  const baseSink = filesystemProviderEvidenceSink(store, 'provider-r1-test');
  const context = await ActiveTurnContext.open({
    journal: new MemoryActiveTurnJournal(),
    binding: r1ActiveBinding(),
    currentTurnRef: 'active-turn://r1/binding',
  });
  const submissions: ProviderSubmitInput[] = [];
  const adapter = providerAdapterWithSink(input.fetch, baseSink);
  let settleCalls = 0;
  const port: ExecutionRuntimePort = {
    kind: adapter.kind,
    probe: (target) => adapter.probe(target),
    capabilities: (target) => adapter.capabilities(target),
    start: (startInput) => adapter.start(startInput),
    resume: (resumeInput) => adapter.resume(resumeInput),
    submit: (submitInput) => {
      submissions.push(submitInput);
      return adapter.submit(submitInput);
    },
    observe: (observeInput) => adapter.observe(observeInput),
    requestStop: (stopInput) => adapter.requestStop(stopInput),
    settle: (settleInput) => {
      settleCalls += 1;
      return adapter.settle(settleInput);
    },
    close: (target) => adapter.close(target),
  };
  const acceptBase = (envelope: RawFactEnvelope): Promise<AcceptedRawFact> => context.acceptRawFact(envelope);
  const acceptRawFact = input.accept === undefined ? acceptBase : input.accept(acceptBase);
  const registerRequest = input.registerRequest
    ?? ((registration: NativeRequestRegistration) => context.registerRequest(registration.record));
  // A seeded continuation parent must be durably registered in the same active
  // turn, because the Runtime rejects a new request whose parent is unknown.
  if (input.parentRequest !== undefined) {
    const parentIdentity = {
      turnId: input.parentRequest.turnId,
      requestId: input.parentRequest.requestId,
      ...(input.parentRequest.parentRequestId === undefined
        ? {}
        : { parentRequestId: input.parentRequest.parentRequestId }),
    };
    await context.registerRequest({ request: parentIdentity, scope, phase: 'dispatching' });
    await context.registerRequest({ request: parentIdentity, scope, phase: 'settled' });
  }
  const instance = new ProviderAgentDriver({
    port,
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-r1',
    scope,
    inputRefs: ['input-1'],
    ...(input.parentRequest === undefined ? {} : { parentRequest: input.parentRequest }),
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    rawEvidence: input.sink ?? baseSink,
    acceptRawFact,
    registerRequest,
    executeTool: input.executeTool,
  });
  return { instance, context, store, baseSink, submissions, settleCalls: () => settleCalls };
}

async function startHarnessTool(harness: RawPersistenceHarness): Promise<{
  readonly iterator: AsyncIterator<ProviderAgentEvent>;
  readonly pendingObservation: Promise<IteratorResult<ProviderAgentEvent>>;
}> {
  await harness.instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await harness.instance.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-r1', payload: { prompt: 'read README.md' } });
  const iterator = harness.instance.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
  // The real codec emits model events (for example response.created) before the
  // function-call event. Advance to the first tool event, which is where the
  // driver is about to run the executor and enter the save/accept barrier.
  let toolEvent = await iterator.next();
  while (!toolEvent.done && toolEvent.value?.kind !== 'provider.tool') {
    toolEvent = await iterator.next();
  }
  assert.equal(toolEvent.value?.kind, 'provider.tool');
  return { iterator, pendingObservation: iterator.next() };
}

function acceptedRawFacts(context: ActiveTurnContext): readonly AcceptedRawFact[] {
  return context.entries().filter((entry): entry is AcceptedRawFact => 'envelope' in entry);
}

function durableToolResultFact(context: ActiveTurnContext) {
  const entry = acceptedRawFacts(context).find((candidate) => candidate.envelope.fact.kind === 'tool-result');
  assert.ok(entry, 'expected a durable tool-result raw fact');
  const fact = entry.envelope.fact;
  if (fact.kind !== 'tool-result') throw new Error('expected tool-result raw fact');
  return fact;
}

async function coldRead(harness: RawPersistenceHarness, fact: ReturnType<typeof durableToolResultFact>): Promise<string> {
  const reader = providerRawContentReader(harness.baseSink);
  return new TextDecoder().decode(await reader.read({ scope, content: fact.rawOutput }));
}

test('R1-A: provider driver forwards codec raw facts and persists the exact executor output in request order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-r1-a-'));
  try {
    const rawOutput = 'RAW_TOOL_OUTPUT\n{"token":"A_ONLY"}';
    let round = 0;
    const fetch: V3ProviderFetch = async () => {
      round += 1;
      if (round === 1) {
        return sseResponse([
          { type: 'response.created', response: { id: 'resp-r1' } },
          { type: 'response.output_text.delta', item_id: 'msg-r1', delta: 'reasoning about the read' },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-r1', name: 'file_read', arguments: '' } },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-r1', name: 'file_read', arguments: '{"path":"README.md"}' } },
          { type: 'response.completed', response: { id: 'resp-r1' } },
        ]);
      }
      return sseResponse([
        { type: 'response.created', response: { id: 'resp-r2' } },
        { type: 'response.output_text.done', item_id: 'msg-r2', text: 'read complete' },
        { type: 'response.completed', response: { id: 'resp-r2' } },
      ]);
    };
    const harness = await rawPersistenceHarness({
      root,
      fetch,
      parentRequest: { turnId: 'turn-seeded', requestId: 'req-0' },
      executeTool: {
        async execute() {
          return { output: rawOutput, outputRefs: [], evidenceRefs: [evidence] };
        },
      },
    });
    await harness.instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
    await harness.instance.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-r1', payload: { prompt: 'read README.md' } });
    for await (const _event of harness.instance.observe({ runtimeId: identity.runtimeId })) {
      // Drain to the provider terminal so the whole request chain is accepted.
    }
    await harness.instance.settle({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch });

    const accepted = acceptedRawFacts(harness.context);
    const firstRequestId = accepted[0]!.envelope.request.requestId;
    // The seeded settled parent anchors the first request of this new driver
    // instance, so the recovered turn is one lineage instead of two roots.
    assert.equal(accepted[0]!.envelope.request.turnId, 'turn-seeded');
    assert.equal(accepted[0]!.envelope.request.parentRequestId, 'req-0');
    const continuation = accepted.find((entry) => entry.envelope.request.parentRequestId === firstRequestId);
    assert.ok(continuation, 'expected a continuation request identity');
    assert.equal(continuation.envelope.request.parentRequestId, firstRequestId);
    assert.equal(continuation.envelope.request.turnId, 'turn-seeded');
    assert.notEqual(continuation.envelope.request.requestId, firstRequestId);

    assert.deepEqual(
      accepted.map((entry) => [
        entry.envelope.request.requestId === firstRequestId ? 'R1' : 'R2',
        entry.envelope.producerSeq,
        entry.envelope.fact.kind,
      ]),
      [
        ['R1', 1, 'content'],
        ['R1', 2, 'tool-call'],
        ['R1', 3, 'request-complete'],
        ['R1', 4, 'tool-result'],
        ['R2', 1, 'content'],
        ['R2', 2, 'request-complete'],
      ],
    );
    assert.deepEqual(accepted.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6]);

    const fact = durableToolResultFact(harness.context);
    const factEnvelope = accepted.find((entry) => entry.envelope.fact.kind === 'tool-result')!.envelope;
    assert.equal(factEnvelope.request.requestId, firstRequestId);
    assert.equal(fact.callId, 'call-r1');
    assert.equal(fact.continuationRef, 'resp-r1');
    assert.equal(fact.result.callId, 'call-r1');
    assert.equal(fact.result.status, 'succeeded');
    assert.equal(await coldRead(harness, fact), rawOutput);

    const requestPhases = harness.context.requests().map((record) => [
      record.request.requestId === 'req-0' ? 'R0' : record.request.requestId === firstRequestId ? 'R1' : 'R2',
      record.phase,
    ]);
    assert.deepEqual(requestPhases, [
      ['R0', 'dispatching'],
      ['R0', 'settled'],
      ['R1', 'dispatching'],
      ['R1', 'dispatched'],
      ['R1', 'waiting'],
      ['R1', 'settled'],
      ['R2', 'dispatching'],
      ['R2', 'dispatched'],
      ['R2', 'settled'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- C/D native tool-loop round trips (Chat + Anthropic) ---

interface ProtocolRoundTripHarness {
  readonly instance: ProviderAgentDriver;
  readonly requests: ProviderWireRequest[];
  readonly submissions: ProviderSubmitInput[];
  readonly accepted: RawFactEnvelope[];
  readonly executed: ProviderToolCall[];
}

/**
 * Real ProviderAgentDriver + real ProviderAdapter + the protocol codec over a
 * scripted transport. The raw path is bound so the typed call must pass durable
 * acceptance before the executor runs.
 */
function protocolRoundTripHarness(input: {
  readonly protocol: 'openai' | 'anthropic';
  readonly rounds: readonly (readonly ProviderWireEvent[])[];
  readonly requestContext: ProviderRequestContextHook;
}): ProtocolRoundTripHarness {
  const protocolBinding: ProviderBinding = {
    ...binding,
    bindingId: `binding-${input.protocol}`,
    providerId: `provider-${input.protocol}`,
    protocol: input.protocol,
    endpointRef: `endpoint-${input.protocol}`,
    modelRef: `model-${input.protocol}`,
  };
  const requests: ProviderWireRequest[] = [];
  const submissions: ProviderSubmitInput[] = [];
  const accepted: RawFactEnvelope[] = [];
  const executed: ProviderToolCall[] = [];
  let round = 0;
  const captured = recordingEvidenceSink();
  const transport: ProviderTransport = {
    start: async (_input, request) => {
      requests.push(request);
      return { ...identity, startedAt: '2026-01-01T00:00:00.000Z', evidenceRefs: [evidence] };
    },
    resume: async () => {
      throw new Error('not used');
    },
    submit: async (submitInput, request) => {
      submissions.push(submitInput);
      requests.push(request);
      return { ...identity, status: 'accepted', outputRefs: [], evidenceRefs: [evidence] };
    },
    observe: async function* () {
      const events = input.rounds[round] ?? [];
      round += 1;
      yield* events;
    },
    requestStop: async () => ({
      ...identity,
      status: 'accepted',
      receivedAt: '2026-01-01T00:00:00.000Z',
      evidenceRefs: [evidence],
    }),
    settle: async () => settlement(),
    close: async () => ({
      bindingId: protocolBinding.bindingId,
      providerId: protocolBinding.providerId,
      protocol: protocolBinding.protocol,
      state: 'closed',
      evidenceRefs: [evidence],
    }),
  };
  const adapter = new ProviderAdapter({
    binding: protocolBinding,
    routeRef: 'test-route',
    codec: input.protocol === 'openai' ? new OpenAIChatProviderCodec() : new AnthropicProviderCodec(4096),
    transport,
    evidence: captured.sink,
  });
  const port: ExecutionRuntimePort = {
    kind: adapter.kind,
    probe: (target) => adapter.probe(target),
    capabilities: (target) => adapter.capabilities(target),
    start: (startInput) => adapter.start(startInput),
    resume: (resumeInput) => adapter.resume(resumeInput),
    submit: (submitInput) => adapter.submit(submitInput),
    observe: (observeInput) => adapter.observe(observeInput),
    requestStop: (stopInput) => adapter.requestStop(stopInput),
    settle: (settleInput) => adapter.settle(settleInput),
    close: (target) => adapter.close(target),
  };
  const instance = new ProviderAgentDriver({
    port,
    binding: protocolBinding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-protocol',
    scope,
    inputRefs: ['input-1'],
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    rawEvidence: captured.sink,
    acceptRawFact: async (envelope) => {
      accepted.push(envelope);
      return { seq: accepted.length, envelope };
    },
    registerRequest: async (registration) => registration.record,
    requestContext: input.requestContext,
    executeTool: {
      async execute({ call }) {
        executed.push(call);
        return { output: 'PROTO_CONTENT', outputRefs: [], evidenceRefs: [evidence] };
      },
    },
  });
  return { instance, requests, submissions, accepted, executed };
}

function toolCallRawFact(envelopes: readonly RawFactEnvelope[]): RawFactEnvelope {
  const entry = envelopes.find((envelope) => envelope.fact.kind === 'tool-call');
  assert.ok(entry, 'expected a durable tool-call raw fact');
  return entry;
}

test('C/D: openai chat native tool round trip executes the typed call once and continues with fresh context', async () => {
  const chatId = 'chat-round-1';
  const hookPhases: string[] = [];
  const harness = protocolRoundTripHarness({
    protocol: 'openai',
    rounds: [
      [
        { protocol: 'openai', type: 'openai.chat.completion', id: chatId, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-chat', type: 'function', function: { name: 'file_read', arguments: '{"path":' } }] }, finish_reason: null }] },
        { protocol: 'openai', type: 'openai.chat.completion', id: chatId, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: null }] },
        { protocol: 'openai', type: 'openai.chat.completion', id: chatId, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ],
      [
        { protocol: 'openai', type: 'openai.chat.completion', id: 'chat-round-2', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
        { protocol: 'openai', type: 'openai.chat.completion', id: 'chat-round-2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ],
    ],
    requestContext: async (input) => {
      hookPhases.push(input.phase);
      return input.phase === 'initial'
        ? { canonical: { units: [{ kind: 'message', role: 'user', text: 'CURRENT_TURN' }] }, instructions: { text: 'ORIENT_ONE' } }
        : {
            canonical: {
              units: [
                { kind: 'message', role: 'user', text: 'CURRENT_TURN' },
                { kind: 'tool-call', callId: 'call-chat', toolId: 'file.read', arguments: { path: 'README.md' } },
                { kind: 'tool-result', callId: 'call-chat', toolId: 'file.read', output: 'PROTO_CONTENT', status: 'succeeded' },
              ],
            },
            instructions: { text: 'ORIENT_TWO' },
          };
    },
  });
  await harness.instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await harness.instance.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-protocol', payload: { prompt: 'read README.md' } });
  const observed: ProviderAgentEvent[] = [];
  for await (const event of harness.instance.observe({ runtimeId: identity.runtimeId })) observed.push(event);

  assert.deepEqual(hookPhases, ['initial', 'continuation']);
  assert.deepEqual(harness.executed, [{ callId: 'call-chat', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: chatId }]);
  assert.equal(harness.submissions.length, 1);
  assert.equal(harness.submissions[0]?.toolContinuations, undefined);
  assert.equal(harness.submissions[0]?.requestContext?.units.length, 3);
  assert.equal(harness.requests.length, 2);
  const rawCall = toolCallRawFact(harness.accepted);
  if (rawCall.fact.kind === 'tool-call') {
    assert.equal(rawCall.fact.call.callId, 'call-chat');
    assert.equal(rawCall.fact.call.toolId, 'file.read');
    assert.deepEqual(rawCall.fact.call.arguments, { path: 'README.md' });
    assert.equal(rawCall.fact.call.continuationRef, chatId);
  }
  assert.equal(harness.accepted.some((envelope) => envelope.fact.kind === 'tool-result'), true);

  const initial = harness.requests[0] as OpenAIChatWireRequest;
  assert.equal(initial.tools?.[0]?.function.name, 'file_read');
  const continuation = harness.requests[1] as OpenAIChatWireRequest;
  const assistant = continuation.messages.find((message) => message.role === 'assistant');
  assert.ok(assistant && assistant.role === 'assistant');
  assert.equal(assistant.tool_calls?.[0]?.id, 'call-chat');
  assert.equal(assistant.tool_calls?.[0]?.function.name, 'file_read');
  assert.equal(assistant.tool_calls?.[0]?.function.arguments, '{"path":"README.md"}');
  const tool = continuation.messages.find((message) => message.role === 'tool');
  assert.ok(tool && tool.role === 'tool');
  assert.equal(tool.tool_call_id, 'call-chat');
  assert.equal(tool.content, 'PROTO_CONTENT');
  assert.equal(observed.at(-1)?.terminalState, 'succeeded');
});

test('C/D: anthropic native tool round trip executes the typed call once and continues with fresh context', async () => {
  const messageId = 'anthropic-message-1';
  const hookPhases: string[] = [];
  const harness = protocolRoundTripHarness({
    protocol: 'anthropic',
    rounds: [
      [
        { protocol: 'anthropic', type: 'message_start', message: { id: messageId, model: 'model-anthropic', role: 'assistant' } },
        { protocol: 'anthropic', type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-anth', name: 'file_read', input: {} } },
        { protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } },
        { protocol: 'anthropic', type: 'content_block_stop', index: 0 },
        { protocol: 'anthropic', type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { protocol: 'anthropic', type: 'message_stop' },
      ],
      [
        { protocol: 'anthropic', type: 'message_start', message: { id: 'anthropic-message-2', model: 'model-anthropic', role: 'assistant' } },
        { protocol: 'anthropic', type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } },
        { protocol: 'anthropic', type: 'content_block_stop', index: 0 },
        { protocol: 'anthropic', type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { protocol: 'anthropic', type: 'message_stop' },
      ],
    ],
    requestContext: async (input) => {
      hookPhases.push(input.phase);
      return input.phase === 'initial'
        ? { canonical: { units: [{ kind: 'message', role: 'user', text: 'CURRENT_TURN' }] }, instructions: { text: 'ORIENT_ONE' } }
        : {
            canonical: {
              units: [
                { kind: 'message', role: 'user', text: 'CURRENT_TURN' },
                { kind: 'tool-call', callId: 'call-anth', toolId: 'file.read', arguments: { path: 'README.md' } },
                { kind: 'tool-result', callId: 'call-anth', toolId: 'file.read', output: 'PROTO_CONTENT', status: 'succeeded' },
              ],
            },
            instructions: { text: 'ORIENT_TWO' },
          };
    },
  });
  await harness.instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await harness.instance.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-protocol', payload: { prompt: 'read README.md' } });
  const observed: ProviderAgentEvent[] = [];
  for await (const event of harness.instance.observe({ runtimeId: identity.runtimeId })) observed.push(event);

  assert.deepEqual(hookPhases, ['initial', 'continuation']);
  assert.deepEqual(harness.executed, [{ callId: 'call-anth', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: messageId }]);
  assert.equal(harness.submissions.length, 1);
  assert.equal(harness.submissions[0]?.toolContinuations, undefined);
  assert.equal(harness.submissions[0]?.requestContext?.units.length, 3);
  assert.equal(harness.requests.length, 2);
  const rawCall = toolCallRawFact(harness.accepted);
  if (rawCall.fact.kind === 'tool-call') {
    assert.equal(rawCall.fact.call.callId, 'call-anth');
    assert.equal(rawCall.fact.call.toolId, 'file.read');
    assert.deepEqual(rawCall.fact.call.arguments, { path: 'README.md' });
    assert.equal(rawCall.fact.call.continuationRef, messageId);
  }
  assert.equal(harness.accepted.some((envelope) => envelope.fact.kind === 'tool-result'), true);

  const continuation = harness.requests[1] as AnthropicWireRequest;
  const toolUse = continuation.messages.flatMap((message) => message.content).find((block) => block.type === 'tool_use');
  assert.ok(toolUse && toolUse.type === 'tool_use');
  assert.equal(toolUse.id, 'call-anth');
  assert.deepEqual(toolUse.input, { path: 'README.md' });
  const toolResult = continuation.messages.flatMap((message) => message.content).find((block) => block.type === 'tool_result');
  assert.ok(toolResult && toolResult.type === 'tool_result');
  assert.equal(toolResult.tool_use_id, 'call-anth');
  assert.equal(toolResult.content, 'PROTO_CONTENT');
  assert.equal(observed.at(-1)?.terminalState, 'succeeded');
});

test('R1-B: stop signals immediately but settlement waits for the exact-output save and durable ack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-r1-b-'));
  try {
    const rawOutput = 'LATE_EXACT_OUTPUT\n{"token":"B_ONLY"}';
    const toolEntered = deferred<void>();
    const releaseTool = deferred<void>();
    const writeEntered = deferred<void>();
    const releaseWrite = deferred<void>();
    const acceptEntered = deferred<void>();
    const releaseAccept = deferred<void>();
    let toolSignal: AbortSignal | undefined;
    let executions = 0;
    const gateStore = new ImmutableAssetStore(root);
    const gateSink = filesystemProviderEvidenceSink(gateStore, 'provider-r1-test');
    const gatedSink: ProviderEvidenceSink = {
      async write(writeInput) {
        writeEntered.resolve();
        await releaseWrite.promise;
        return gateSink.write(writeInput);
      },
      read: (ref) => gateSink.read(ref),
    };
    const harness = await rawPersistenceHarness({
      root,
      fetch: singleToolRoundFetch('call-stop', 'resp-r1'),
      sink: gatedSink,
      accept: (inner) => async (envelope) => {
        if (envelope.fact.kind === 'tool-result') {
          acceptEntered.resolve();
          await releaseAccept.promise;
        }
        return inner(envelope);
      },
      executeTool: {
        async execute(executeInput) {
          executions += 1;
          toolSignal = executeInput.signal;
          toolEntered.resolve();
          await releaseTool.promise;
          return { output: rawOutput, outputRefs: [], evidenceRefs: [evidence] };
        },
      },
    });

    const { pendingObservation } = await startHarnessTool(harness);
    await toolEntered.promise;
    await harness.instance.requestStop({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch, operationId });
    assert.equal(toolSignal?.aborted, true);
    const pendingSettlement = harness.instance.settle({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch });
    releaseTool.resolve();
    await writeEntered.promise;
    assert.equal(harness.settleCalls(), 0, 'settlement started before the exact output was saved');
    assert.equal(harness.submissions.length, 0, 'a continuation was submitted after stop');
    releaseWrite.resolve();
    await acceptEntered.promise;
    assert.equal(harness.settleCalls(), 0, 'settlement started before durable acceptance returned');
    assert.equal(harness.submissions.length, 0, 'a continuation was submitted before durable acceptance returned');
    releaseAccept.resolve();
    assert.equal((await pendingObservation).done, true, 'the stopped tool result was projected before the barrier');
    assert.equal((await pendingSettlement).state, 'stopped');
    assert.equal(harness.settleCalls(), 1);
    assert.equal(harness.submissions.length, 0);
    assert.equal(executions, 1, 'stop did not prevent new tool work');

    const fact = durableToolResultFact(harness.context);
    assert.equal(await coldRead(harness, fact), rawOutput);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R1-C: non-success output stays evidence and save, accept and ack failures surface without a normal stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-r1-c-'));
  try {
    {
      const failure: ProviderError = {
        errorId: 'provider.tool.c-failed',
        code: 'tool.c-failed',
        category: 'provider',
        phase: 'tool',
        message: 'executor reported a real failure',
        ownerId: 'humanagent.provider-agent-driver',
        retryable: 'manual',
        attention: 'foreground',
        evidenceRefs: [evidence],
        nextAction: { kind: 'recover', ref: 'provider.tool.c-failed' },
      };
      const harness = await rawPersistenceHarness({
        root: join(root, 'non-success'),
        fetch: singleToolRoundFetch('call-c-failed', 'resp-c-failed'),
        executeTool: {
          async execute() {
            return { output: 'NON_SUCCESS_EXACT_OUTPUT', outputRefs: [], evidenceRefs: [evidence], status: 'failed', error: failure };
          },
        },
      });
      const { iterator, pendingObservation } = await startHarnessTool(harness);
      const resultEvent = await pendingObservation;
      assert.equal(resultEvent.value?.kind, 'provider.tool-result');
      assert.equal(resultEvent.value?.providerEvent.toolResult?.status, 'failed');
      assert.equal(resultEvent.value?.providerEvent.toolResult?.error?.code, failure.code);
      await assert.rejects(
        () => iterator.next(),
        (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === failure.code,
      );
      assert.equal(harness.submissions.length, 0);
      assert.equal(harness.context.requests().some((record) => record.phase === 'settled'), false, 'non-success tool result must not settle the request');
      assert.equal(harness.context.requests().filter((record) => record.phase === 'dispatching').length, 1, 'non-success tool result must not dispatch continuation');
      const fact = durableToolResultFact(harness.context);
      assert.equal(fact.result.status, 'failed');
      assert.equal(fact.result.error?.code, failure.code);
      assert.equal(await coldRead(harness, fact), 'NON_SUCCESS_EXACT_OUTPUT');
    }

    {
      const harness = await rawPersistenceHarness({
        root: join(root, 'write-reject'),
        fetch: singleToolRoundFetch('call-c-write', 'resp-c-write'),
        sink: {
          async write() {
            throw new Error('immutable store unavailable');
          },
          async read() {
            throw new Error('unused');
          },
        },
        executeTool: {
          async execute() {
            return { output: 'WRITE_REJECT_OUTPUT', outputRefs: [], evidenceRefs: [evidence] };
          },
        },
      });
      const { pendingObservation } = await startHarnessTool(harness);
      await assert.rejects(
        () => pendingObservation,
        (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'raw.output.save.failed',
      );
      assert.equal(harness.submissions.length, 0);
      assert.equal(acceptedRawFacts(harness.context).some((entry) => entry.envelope.fact.kind === 'tool-result'), false);
      assert.equal(harness.context.requests().some((record) => record.phase === 'settled'), false, 'save failure must not settle the request');
      assert.equal(harness.context.requests().filter((record) => record.phase === 'dispatching').length, 1, 'save failure must not dispatch continuation');
      await assert.rejects(
        () => harness.instance.settle({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch }),
        (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'raw.output.save.failed',
      );
    }

    {
      const harness = await rawPersistenceHarness({
        root: join(root, 'accept-reject'),
        fetch: singleToolRoundFetch('call-c-accept', 'resp-c-accept'),
        accept: (inner) => async (envelope) => {
          if (envelope.fact.kind === 'tool-result') throw new Error('runtime journal append failed');
          return inner(envelope);
        },
        executeTool: {
          async execute() {
            return { output: 'ACCEPT_REJECT_OUTPUT', outputRefs: [], evidenceRefs: [evidence] };
          },
        },
      });
      const { pendingObservation } = await startHarnessTool(harness);
      await assert.rejects(
        () => pendingObservation,
        (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'raw.fact.accept.failed',
      );
      assert.equal(harness.submissions.length, 0);
      assert.equal(harness.context.requests().some((record) => record.phase === 'settled'), false, 'accept failure must not settle the request');
      assert.equal(harness.context.requests().filter((record) => record.phase === 'dispatching').length, 1, 'accept failure must not dispatch continuation');
      await assert.rejects(
        () => harness.instance.settle({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch }),
        (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'raw.fact.accept.failed',
      );
    }

    {
      const harness = await rawPersistenceHarness({
        root: join(root, 'ack-mismatch'),
        fetch: singleToolRoundFetch('call-c-ack', 'resp-c-ack'),
        accept: (inner) => async (envelope) => {
          const accepted = await inner(envelope);
          if (envelope.fact.kind !== 'tool-result') return accepted;
          return { ...accepted, envelope: { ...envelope, producerSeq: envelope.producerSeq + 1_000 } };
        },
        executeTool: {
          async execute() {
            return { output: 'ACK_MISMATCH_OUTPUT', outputRefs: [], evidenceRefs: [evidence] };
          },
        },
      });
      const { pendingObservation } = await startHarnessTool(harness);
      await assert.rejects(
        () => pendingObservation,
        (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'raw.fact.ack.mismatch',
      );
      assert.equal(harness.submissions.length, 0);
      assert.equal(harness.context.requests().some((record) => record.phase === 'settled'), false, 'ack mismatch must not settle the request');
      assert.equal(harness.context.requests().filter((record) => record.phase === 'dispatching').length, 1, 'ack mismatch must not dispatch continuation');
      await assert.rejects(
        () => harness.instance.settle({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch }),
        (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'raw.fact.ack.mismatch',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function nativeDriver(input: {
  readonly fetch: V3ProviderFetch;
  readonly registerRequest?: (registration: NativeRequestRegistration) => Promise<RuntimeRequestRecord>;
  readonly tools?: ProviderStartInput['tools'];
  readonly executeTool?: ProviderToolExecutionPort;
}): ProviderAgentDriver {
  return new ProviderAgentDriver({
    port: realProviderAdapter(input.fetch),
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-native',
    scope,
    inputRefs: ['input-1'],
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.executeTool === undefined ? {} : { executeTool: input.executeTool }),
    ...(input.registerRequest === undefined ? {} : { registerRequest: input.registerRequest }),
  });
}

test('P1-L1: native registration is awaited before the external start and a rejected registration blocks dispatch', async () => {
  const gate = deferred<void>();
  const registrations: NativeRequestRegistration[] = [];
  let dispatchCalls = 0;
  const instance = nativeDriver({
    fetch: async () => {
      dispatchCalls += 1;
      return sseResponse([{ type: 'response.completed', response: { id: 'resp-p1-l1' } }]);
    },
    registerRequest: async (registration) => {
      registrations.push(structuredClone(registration));
      if (registration.record.phase === 'dispatching') await gate.promise;
      return registration.record;
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  const submit = instance.submit({
    taskId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-native',
    payload: { prompt: 'register first' },
  });
  await flushMicrotasks();
  assert.equal(dispatchCalls, 0, 'the external start ran before the dispatching registration resolved');
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.record.phase, 'dispatching');
  gate.resolve();
  await submit;
  assert.equal(dispatchCalls, 1);
  assert.deepEqual(registrations.map((entry) => entry.record.phase), ['dispatching', 'dispatched']);
  assert.equal(registrations.every((entry) => entry.execution.runtimeId === identity.runtimeId), true);
  assert.equal(registrations.every((entry) => entry.record.scope.organId.value === organ.value), true);

  let rejectedDispatchCalls = 0;
  const rejected = nativeDriver({
    fetch: async () => {
      rejectedDispatchCalls += 1;
      throw new Error('dispatch must not run');
    },
    registerRequest: async () => {
      throw new Error('active turn journal append failed');
    },
  });
  await rejected.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await assert.rejects(
    () => rejected.submit({
      taskId,
      executionEpoch: identity.executionEpoch,
      assignmentId: 'assignment-native',
      payload: { prompt: 'no dispatch' },
    }),
    (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'request.registration.failed',
  );
  assert.equal(rejectedDispatchCalls, 0, 'a rejected registration still dispatched to the provider');
});

test('P1-L1: continuation registration carries the parent request id and both dispatch phases', async () => {
  const registrations: NativeRequestRegistration[] = [];
  let round = 0;
  const fetch: V3ProviderFetch = async () => {
    round += 1;
    if (round === 1) {
      return sseResponse([
        { type: 'response.created', response: { id: 'resp-p1-r1' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-p1', name: 'file_read', arguments: '' } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-p1', name: 'file_read', arguments: '{"path":"README.md"}' } },
        { type: 'response.completed', response: { id: 'resp-p1-r1' } },
      ]);
    }
    return sseResponse([
      { type: 'response.created', response: { id: 'resp-p1-r2' } },
      { type: 'response.output_text.done', item_id: 'msg-p1-r2', text: 'done' },
      { type: 'response.completed', response: { id: 'resp-p1-r2' } },
    ]);
  };
  const instance = nativeDriver({
    fetch,
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    executeTool: {
      async execute() {
        return { output: 'README_CONTENT', outputRefs: [], evidenceRefs: [evidence] };
      },
    },
    registerRequest: async (registration) => {
      registrations.push(structuredClone(registration));
      return registration.record;
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await instance.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-native', payload: { prompt: 'read README.md' } });
  for await (const _event of instance.observe({ runtimeId: identity.runtimeId })) {
    // Drain the whole request chain so both requests are registered.
  }
  await instance.settle({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch });

  assert.deepEqual(
    registrations.map((entry) => entry.record.phase),
    ['dispatching', 'dispatched', 'waiting', 'settled', 'dispatching', 'dispatched', 'settled'],
  );
  const initialRequestId = registrations[0]!.record.request.requestId;
  const initialSettled = registrations.find((entry) => entry.record.phase === 'settled')!;
  assert.equal(initialSettled.record.request.requestId, initialRequestId);
  const continuationDispatch = registrations.filter((entry) => entry.record.phase === 'dispatching')[1]!;
  assert.equal(continuationDispatch.record.request.parentRequestId, initialRequestId);
  assert.equal(continuationDispatch.record.parentRequestId, initialRequestId);
  assert.notEqual(continuationDispatch.record.request.requestId, initialRequestId);
  assert.ok(
    registrations.indexOf(initialSettled) < registrations.indexOf(continuationDispatch),
    'parent request must be settled before continuation dispatching is registered',
  );
});

test('P1-L2: closeProductionAndDrain waits for the exact-output write and durable ack of a late tool result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-p1-l2-'));
  try {
    const rawOutput = 'LATE_DRAIN_OUTPUT\n{"token":"P1_L2"}';
    const toolEntered = deferred<void>();
    const releaseTool = deferred<void>();
    const writeEntered = deferred<void>();
    const releaseWrite = deferred<void>();
    const acceptEntered = deferred<void>();
    const releaseAccept = deferred<void>();
    const gateStore = new ImmutableAssetStore(root);
    const gateSink = filesystemProviderEvidenceSink(gateStore, 'provider-p1-l2-test');
    const gatedSink: ProviderEvidenceSink = {
      async write(writeInput) {
        writeEntered.resolve();
        await releaseWrite.promise;
        return gateSink.write(writeInput);
      },
      read: (ref) => gateSink.read(ref),
    };
    const harness = await rawPersistenceHarness({
      root,
      fetch: singleToolRoundFetch('call-drain', 'resp-drain'),
      sink: gatedSink,
      accept: (inner) => async (envelope) => {
        if (envelope.fact.kind === 'tool-result') {
          acceptEntered.resolve();
          await releaseAccept.promise;
        }
        return inner(envelope);
      },
      executeTool: {
        async execute() {
          toolEntered.resolve();
          await releaseTool.promise;
          return { output: rawOutput, outputRefs: [], evidenceRefs: [evidence] };
        },
      },
    });
    const { pendingObservation } = await startHarnessTool(harness);
    await toolEntered.promise;
    await harness.instance.requestStop({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch, operationId });
    let drained = false;
    const pendingDrain = harness.instance.closeProductionAndDrain({
      execution: { runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch },
      boundaryId: 'boundary-p1-l2',
    }).then((result) => {
      drained = true;
      return result;
    });
    releaseTool.resolve();
    await writeEntered.promise;
    await flushMicrotasks();
    assert.equal(drained, false, 'drain resolved before the exact output was saved');
    releaseWrite.resolve();
    await acceptEntered.promise;
    await flushMicrotasks();
    assert.equal(drained, false, 'drain resolved before durable acceptance returned');
    releaseAccept.resolve();
    const result = await pendingDrain;
    assert.equal(result.boundaryId, 'boundary-p1-l2');
    assert.equal(result.execution.runtimeId, identity.runtimeId);
    assert.equal(result.requests.length, 1);
    const factSeqs = acceptedRawFacts(harness.context).map((entry) => [
      entry.envelope.fact.kind,
      entry.envelope.producerSeq,
    ]);
    assert.deepEqual(factSeqs, [['tool-call', 1], ['request-complete', 2], ['tool-result', 3]]);
    assert.equal(result.requests[0]!.lastProducerSeq, 3, 'drain did not bind the final accepted producer sequence');
    assert.equal(harness.submissions.length, 0, 'drain started a new continuation request');
    assert.equal((await pendingObservation).done, true);
    const fact = durableToolResultFact(harness.context);
    assert.equal(await coldRead(harness, fact), rawOutput);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P1-L2: an executor rejection with no further consumer resume still drains and surfaces the failure', async () => {
  const runtimePort = port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      yield {
        ...identity,
        eventId: 'event-reject-call',
        kind: 'tool',
        summary: 'file.read',
        outputRefs: ['artifact://reject-call'],
        evidenceRefs: [evidence],
        toolCall: { callId: 'call-reject', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'response-reject' },
      };
      yield {
        ...identity,
        eventId: 'event-reject-waiting',
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
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-native',
    scope,
    inputRefs: ['input-1'],
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    executeTool: {
      async execute() {
        throw new Error('executor failed hard');
      },
    },
  });
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await instance.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-native', payload: { prompt: 'read README.md' } });
  const iterator = instance.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, 'provider.tool');
  const failed = await iterator.next();
  assert.equal(failed.value?.kind, 'provider.tool-result');
  assert.equal(failed.value?.providerEvent.toolResult?.status, 'failed');
  // Deliberately do not resume the iterator again: the barrier must already be
  // released so the drain cannot deadlock on a suspended yield.
  await assert.rejects(
    () => withDeadline(instance.closeProductionAndDrain({
      execution: { runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch },
      boundaryId: 'boundary-reject',
    }), 2_000),
    /executor failed hard/,
  );
});

test('P1-L2: an early observe exit explicitly closes the provider iterator', async () => {
  let closed = false;
  let closedByDrain = false;
  const makePort = (onClose: () => void): ExecutionRuntimePort => port({
    observe: async function* (): AsyncIterable<ProviderEvent> {
      try {
        yield {
          ...identity,
          eventId: 'event-close-model',
          kind: 'model',
          summary: 'first model event',
          outputRefs: [],
          evidenceRefs: [evidence],
        };
        await new Promise<void>(() => {});
      } finally {
        onClose();
      }
    },
  });
  const makeInstance = (runtimePort: ExecutionRuntimePort): ProviderAgentDriver => new ProviderAgentDriver({
    port: runtimePort,
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-native',
    scope,
    inputRefs: ['input-1'],
  });

  const consumerExit = makeInstance(makePort(() => {
    closed = true;
  }));
  await consumerExit.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await consumerExit.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-native', payload: { prompt: 'close early' } });
  const iterator = consumerExit.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  await iterator.return?.();
  assert.equal(closed, true, 'the provider observe iterator was not explicitly closed on consumer exit');

  const drainExit = makeInstance(makePort(() => {
    closedByDrain = true;
  }));
  await drainExit.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await drainExit.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-native', payload: { prompt: 'close by drain' } });
  const drainIterator = drainExit.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
  const drainFirst = await drainIterator.next();
  assert.equal(drainFirst.done, false);
  await drainExit.closeProductionAndDrain({
    execution: { runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch },
    boundaryId: 'boundary-iterator-close',
  });
  assert.equal(closedByDrain, true, 'closeProductionAndDrain did not explicitly close the live provider iterator');
});

test('P1-L2: closeProductionAndDrain waits for an in-flight observe raw acceptance and then closes the provider stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-p1-observer-drain-'));
  try {
    const releaseAccept = deferred<void>();
    const acceptEntered = deferred<void>();
    let transportClosed = false;
    const harness = await rawPersistenceHarness({
      root,
      fetch: sseResponseReturning(() => {
        transportClosed = true;
      }),
      accept: (inner) => async (envelope) => {
        if (envelope.fact.kind === 'content') {
          acceptEntered.resolve();
          await releaseAccept.promise;
        }
        return inner(envelope);
      },
      executeTool: {
        async execute() {
          return { output: 'OBSERVER_DRAIN_OUTPUT', outputRefs: [], evidenceRefs: [evidence] };
        },
      },
    });
    await harness.instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
    await harness.instance.submit({ taskId, executionEpoch: identity.executionEpoch, assignmentId: 'assignment-r1', payload: { prompt: 'observe then drain' } });
    const iterator = harness.instance.observe({ runtimeId: identity.runtimeId })[Symbol.asyncIterator]();
    // response.created yields the first model event and carries no raw fact.
    const first = await iterator.next();
    assert.equal(first.value?.kind, 'provider.model');
    // The next step drives the adapter into the delta content raw acceptance,
    // which the gate holds, so the observer/decode/raw-ack work is genuinely in
    // flight when the drain starts.
    const second = iterator.next();
    await acceptEntered.promise;
    assert.equal(transportClosed, false, 'the provider stream closed before the close/drain was requested');

    let closed = false;
    const pendingClose = Promise.resolve(iterator.return?.()).then(() => {
      closed = true;
    });
    let drained = false;
    const pendingDrain = harness.instance.closeProductionAndDrain({
      execution: { runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch },
      boundaryId: 'boundary-observer-drain',
    }).then((result) => {
      drained = true;
      return result;
    });
    await flushMicrotasks();
    assert.equal(closed, false, 'observe close resolved before the in-flight raw acceptance returned');
    assert.equal(drained, false, 'drain resolved before the in-flight observe raw acceptance returned');
    assert.equal(transportClosed, false, 'the provider stream closed before the in-flight raw acceptance returned');

    releaseAccept.resolve();
    const result = await withDeadline(pendingDrain, 3_000);
    assert.equal(result.boundaryId, 'boundary-observer-drain');
    assert.equal(result.execution.runtimeId, identity.runtimeId);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0]!.lastProducerSeq, 1, 'drain did not bind the observed content raw fact sequence');
    assert.equal(transportClosed, true, 'drain did not close the provider stream');
    assert.equal(
      acceptedRawFacts(harness.context).some((entry) => entry.envelope.fact.kind === 'content'),
      true,
      'the observed raw fact was lost when production drained',
    );
    const observed = await withDeadline(second, 3_000);
    assert.equal(observed.value?.kind, 'provider.output');
    await withDeadline(pendingClose, 3_000);
    assert.equal(closed, true, 'the observe iterator did not close after the raw acceptance resolved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
