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
