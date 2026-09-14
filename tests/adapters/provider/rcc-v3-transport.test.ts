import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ProviderBinding,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  AnthropicProviderCodec,
  ProviderAdapter,
  ProviderAdapterError,
  ResponsesProviderCodec,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type ProviderCodec,
  type V3ProviderFetch,
  type V3ProviderFetchInit,
  type V3ProviderFetchResponse,
  createV3ProviderHttpTransport,
} from '../../../packages/adapters/provider/src/index.js';

const scope: ScopeRef = {
  organId: id('organ', 'organ-rcc-test'),
  taskId: id('task', 'task-rcc-test'),
  operationId: id('operation', 'operation-rcc-test'),
};
const execution = {
  runtimeId: 'runtime-rcc-test',
  taskId: scope.taskId!,
  operationId: scope.operationId!,
  executionEpoch: 1,
};
const binding: ProviderBinding = {
  bindingId: 'binding-rcc-test',
  providerId: 'cc',
  protocol: 'responses',
  endpointRef: 'rcc-v3-4444',
  modelRef: 'provider.model',
  configDigest: 'sha256:test-config',
  capabilityDigest: 'sha256:test-capability',
};

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `rcc-test-${label}`),
    kind: 'execution',
    source: 'rcc-v3-transport-test',
    locator: `test://${label}`,
    scope,
  };
}

function sink(): ProviderEvidenceSink {
  return {
    async write(input: ProviderEvidenceWrite) {
      return {
        evidenceId: id('evidence', `rcc-write-${input.type}-${input.locator.replace(/[^A-Za-z0-9._-]/g, '-')}`),
        kind: input.kind,
        source: 'rcc-v3-transport-test',
        locator: input.locator,
        scope: input.scope,
      };
    },
    async read() {
      return new Uint8Array();
    },
  };
}

async function* chunks(values: readonly string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

function response(body: AsyncIterable<Uint8Array>, status = 200): V3ProviderFetchResponse {
  return {
    status,
    body,
    text: async () => 'rcc-test-response',
  };
}

function jsonResponse(value: unknown, status = 200): V3ProviderFetchResponse {
  return {
    status,
    body: null,
    text: async () => JSON.stringify(value),
  };
}

function textResponse(value: string, status = 200): V3ProviderFetchResponse {
  return {
    status,
    body: null,
    text: async () => value,
  };
}

function fetchStub(body: AsyncIterable<Uint8Array>, calls: Array<{ url: string; init: V3ProviderFetchInit }>, status = 200): V3ProviderFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return response(body, status);
  };
}

function startInput() {
  return { ...execution, inputRefs: ['input-rcc'], evidenceRefs: [evidence('start')] };
}

function adapter(fetch: V3ProviderFetch, provider = binding, codec: ProviderCodec = new ResponsesProviderCodec()) {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const writes: ProviderEvidenceWrite[] = [];
  const transport = createV3ProviderHttpTransport({
    binding: provider,
    baseUrl: 'http://127.0.0.1:4444',
    evidence: {
      async write(input) {
        writes.push(input);
        return {
          evidenceId: id('evidence', `rcc-write-${input.type}-${input.locator.replace(/[^A-Za-z0-9._-]/g, '-')}`),
          kind: input.kind,
          source: 'rcc-v3-transport-test',
          locator: input.locator,
          scope: input.scope,
        };
      },
      async read() {
        return new Uint8Array();
      },
    },
    fetch: async (url, init) => fetch(url, init),
  });
  return { adapter: new ProviderAdapter({ binding: provider, routeRef: 'test-route', codec, transport, evidence: sink() }), calls, writes };
}

function transportHarness() {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const writes: ProviderEvidenceWrite[] = [];
  const refs: EvidenceRef[] = [];
  const transport = createV3ProviderHttpTransport({
    binding,
    baseUrl: 'http://127.0.0.1:4444',
    evidence: {
      async write(input) {
        writes.push(input);
        const ref = {
          evidenceId: id('evidence', `rcc-write-${input.type}-${input.locator.replace(/[^A-Za-z0-9._-]/g, '-')}`),
          kind: input.kind,
          source: 'rcc-v3-transport-test',
          locator: input.locator,
          scope: input.scope,
        };
        refs.push(ref);
        return ref;
      },
      async read() {
        return new Uint8Array();
      },
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  return { transport, calls, writes, refs };
}

function executionKey(input = execution): string {
  return `${input.runtimeId}:${input.taskId.value}:${input.operationId.value}:${input.executionEpoch}`;
}

// Start fails closed without a verified RCC selector; seed the owned execution
// so post-start transport contracts remain testable without faking route success.
function seedActive(
  transport: ReturnType<typeof createV3ProviderHttpTransport>,
  body: AsyncIterable<Uint8Array>,
  protocol: 'responses' | 'anthropic' = 'responses',
) {
  const controller = new AbortController();
  const active = {
    identity: { ...execution },
    controller,
    body,
    protocol,
    route: `${binding.providerId}:test-route`,
    model: binding.modelRef,
    evidenceScope: scope,
    stopRequested: false,
    observed: false,
    streamDone: false,
    resourceReleased: false,
  };
  (transport as unknown as { executions: Map<string, typeof active> }).executions.set(executionKey(), active);
  return { controller, active };
}

function probeAdapter(fetch: V3ProviderFetch, writes: Array<ProviderEvidenceWrite>, provider = binding) {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const evidence: ProviderEvidenceSink = {
    async write(input) {
      writes.push(input);
      return {
        evidenceId: id('evidence', `probe-${writes.length}`),
        kind: input.kind,
        source: 'rcc-v3-transport-test',
        locator: input.locator,
        scope: input.scope,
      };
    },
    async read() {
      return new Uint8Array();
    },
  };
  const transport = createV3ProviderHttpTransport({
    binding: provider,
    baseUrl: 'http://127.0.0.1:4444',
    evidence,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fetch(url, init);
    },
    now: () => new Date('2099-01-01T00:00:00Z'),
  });
  return { adapter: new ProviderAdapter({ binding: provider, routeRef: 'test-route', codec: new ResponsesProviderCodec(), transport, evidence }), calls };
}

test('RCC v3 probe keeps listener and model discovery but does not infer protocol readiness', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => {
    if (url.endsWith('/health')) return jsonResponse({ status: 'ok', version: '0.90.4785' });
    if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'provider.model' }] });
    throw new Error(`unexpected probe URL: ${url}`);
  }, writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'capability-unavailable');
  assert.equal(readiness.failure?.code, 'capability.protocol-unverified');
  assert.equal(readiness.failure?.ownerId, 'humanagent.provider-adapter.rcc-v3');
  await assert.rejects(() => built.adapter.capabilities(binding), /capabilities are unavailable/);
  assert.deepEqual(built.calls.map((call) => [call.init.method, call.url]), [
    ['GET', 'http://127.0.0.1:4444/health'],
    ['GET', 'http://127.0.0.1:4444/v1/models'],
  ]);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health', 'probe-models', 'probe-capability-unverified']);
});

test('RCC v3 probe reports capability-unavailable for an empty model list', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => url.endsWith('/health')
    ? jsonResponse({ status: 'ok' })
    : jsonResponse({ data: [], models: [] }), writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'capability-unavailable');
  assert.equal(readiness.failure?.code, 'models.empty');
  assert.equal(readiness.failure?.ownerId, 'humanagent.provider-adapter.rcc-v3');
  assert.equal(readiness.evidenceRefs.length, 2);
  await assert.rejects(() => built.adapter.capabilities(binding), /capabilities are unavailable/);
  assert.equal(built.calls.length, 2);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health', 'probe-models']);
});

test('RCC v3 probe reports capability-unavailable when the requested model is absent', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => url.endsWith('/health')
    ? jsonResponse({ status: 'ok' })
    : jsonResponse({ data: [{ id: 'another.model' }] }), writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'capability-unavailable');
  assert.equal(readiness.failure?.code, 'capability.model-unavailable');
  assert.equal(readiness.evidenceRefs.length, 3);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health', 'probe-models', 'probe-model-unavailable']);
});

test('RCC v3 probe stops at health failure and preserves recovery ownership', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async () => textResponse('<html>bad gateway</html>', 503), writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'not-ready');
  assert.equal(readiness.failure?.code, 'health.http.503');
  assert.equal(readiness.nextAction?.kind, 'recover');
  assert.equal(built.calls.length, 1);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health']);
});

test('RCC v3 start fails closed because route selection is unavailable', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const built = adapter(fetchStub(chunks([]), calls));

  await assert.rejects(() => built.adapter.start(startInput()), (error) => {
    assert.equal(error instanceof ProviderAdapterError, true);
    assert.equal((error as ProviderAdapterError).providerError.code, 'capability.route-selection-unavailable');
    assert.equal((error as ProviderAdapterError).providerError.category, 'capability');
    assert.equal((error as ProviderAdapterError).providerError.nextAction.kind, 'recover');
    return true;
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(built.writes.map((write) => write.type), ['route-selection-unavailable']);
  assert.equal((built.writes[0].content as { route?: string }).route, 'cc:test-route');
});

test('RCC v3 transport rejects route bindings that do not match the provider', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const provider = { ...binding, providerId: 'cc-sol', bindingId: 'binding-cc-sol' };
  const transport = createV3ProviderHttpTransport({
    binding: binding,
    baseUrl: 'http://127.0.0.1:4444',
    evidence: sink(),
    fetch: fetchStub(chunks([]), calls),
  });
  const wrongRouteAdapter = new ProviderAdapter({
    binding: provider,
    routeRef: 'test-route',
    codec: new ResponsesProviderCodec(),
    transport,
    evidence: sink(),
  });

  await assert.rejects(() => wrongRouteAdapter.start(startInput()), (error) => {
    assert.equal(error instanceof ProviderAdapterError, true);
    assert.match(String(error instanceof Error ? error.message : error), /bind provider/i);
    return true;
  });
});

test('RCC v3 failed settlement persists and returns the configured error evidence ref', async () => {
  const errorBody = chunks(['event: error\ndata: {"type":"error","error":{"code":"overloaded","message":"busy"}}\n\n']);
  const built = transportHarness();
  seedActive(built.transport, errorBody);
  const events = [];
  for await (const event of built.transport.observe(execution)) events.push(event);
  assert.equal(events.at(-1)?.type, 'error');
  const failed = await built.transport.settle(execution);
  assert.equal(failed.state, 'failed');
  const errorEvidenceIndex = built.writes.findIndex((write) => write.type === 'settle-error');
  assert.ok(errorEvidenceIndex >= 0);
  assert.deepEqual(failed.error?.evidenceRefs, [built.refs[errorEvidenceIndex]]);
  assert.equal(failed.error?.evidenceRefs[0]?.locator, 'rcc-v3://settle-error');

  const incomplete = transportHarness();
  seedActive(incomplete.transport, chunks(['data: {"type":"response.created"}']));
  await assert.rejects(async () => {
    for await (const _event of incomplete.transport.observe(execution)) void _event;
  }, /incomplete|terminal/);
  const incompleteSettlement = await incomplete.transport.settle(execution);
  assert.equal(incompleteSettlement.state, 'failed');
  assert.equal(incompleteSettlement.error?.evidenceRefs[0]?.locator, 'rcc-v3://settle-error');
});

for (const stopReason of ['tool_use', 'max_tokens', 'pause_turn'] as const) {
  test(`RCC v3 Anthropic ${stopReason} becomes blocked capability-unavailable after observation`, async () => {
    const built = transportHarness();
    seedActive(built.transport, chunks([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","model":"provider.model","role":"assistant"}}\n\n',
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"}}\n\n`,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]), 'anthropic');
    for await (const _event of built.transport.observe(execution)) void _event;

    const settled = await built.transport.settle(execution);
    assert.equal(settled.state, 'blocked');
    assert.equal(settled.resourceRelease.state, 'released');
    assert.equal(settled.persistence.state, 'pending');
    assert.equal(settled.error?.category, 'capability');
    assert.equal(settled.error?.code, 'capability.continuation-unavailable');
    assert.equal(settled.error?.ownerId, 'humanagent.provider-adapter.rcc-v3');
    assert.equal(settled.error?.nextAction.kind, 'recover');
    assert.equal(settled.nextAction?.kind, 'recover');
    const errorEvidenceIndex = built.writes.findIndex((write) => write.type === 'settle-error');
    assert.ok(errorEvidenceIndex >= 0);
    assert.deepEqual(settled.error?.evidenceRefs, [built.refs[errorEvidenceIndex]]);
  });
}

test('RCC v3 stop receipt is distinct from settle and does not claim remote cancellation', async () => {
  const built = transportHarness();
  seedActive(built.transport, chunks([]));
  const stop = await built.transport.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' }, {
    protocol: 'responses',
    type: 'responses.cancel',
    route: 'cc:test-route',
    model: binding.modelRef,
    reason: 'operator stop',
    execution,
  });
  assert.equal(stop.status, 'accepted');
  assert.equal('state' in stop, false);
  const settled = await built.transport.settle(execution);
  assert.equal(settled.state, 'waiting');
  assert.equal(settled.resourceRelease.state, 'pending');
});

test('RCC v3 stop request remains stopped when the Responses stream later closes', async () => {
  const built = transportHarness();
  seedActive(built.transport, chunks([
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-stop"}}\n\n',
  ]));
  const stop = await built.transport.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' }, {
    protocol: 'responses',
    type: 'responses.cancel',
    route: 'cc:test-route',
    model: binding.modelRef,
    reason: 'operator stop',
    execution,
  });
  assert.equal(stop.status, 'accepted');
  for await (const _event of built.transport.observe(execution)) void _event;
  const settled = await built.transport.settle(execution);
  assert.equal(settled.state, 'stopped');
});

test('RCC v3 stop swallows the exact controller cancellation identity', async () => {
  const built = transportHarness();
  let controller!: AbortController;
  const abortingBody: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      if (controller.signal.aborted) throw controller.signal.reason;
      await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    },
  };
  controller = seedActive(built.transport, abortingBody).controller;
  await built.transport.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' }, {
    protocol: 'responses',
    type: 'responses.cancel',
    route: 'cc:test-route',
    model: binding.modelRef,
    reason: 'operator stop',
    execution,
  });
  for await (const _event of built.transport.observe(execution)) void _event;
  const settled = await built.transport.settle(execution);
  assert.equal(settled.state, 'stopped');
});

test('RCC v3 stop does not mask an ordinary Error containing abort as stopped', async () => {
  const built = transportHarness();
  let controller!: AbortController;
  const abortingBody: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      if (controller.signal.aborted) throw new Error('AbortError');
      await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
      });
    },
  };
  controller = seedActive(built.transport, abortingBody).controller;
  await built.transport.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' }, {
    protocol: 'responses',
    type: 'responses.cancel',
    route: 'cc:test-route',
    model: binding.modelRef,
    reason: 'operator stop',
    execution,
  });

  await assert.rejects(async () => {
    for await (const _event of built.transport.observe(execution)) void _event;
  }, /AbortError/);
  const settled = await built.transport.settle(execution);
  assert.equal(settled.state, 'failed');
});

test('RCC v3 early observe return cancels the response body and controller', async () => {
  const built = transportHarness();
  let bodyCancelled = false;
  const body: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      try {
        yield new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\n');
        await new Promise<never>(() => {});
      } finally {
        bodyCancelled = true;
      }
    },
  };
  const { controller } = seedActive(built.transport, body);

  for await (const _event of built.transport.observe(execution)) break;
  assert.equal(bodyCancelled, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason instanceof DOMException, true);
  const settled = await built.transport.settle(execution);
  assert.equal(settled.state, 'blocked');
  assert.equal(settled.resourceRelease.state, 'released');
  assert.equal(settled.nextAction?.kind, 'recover');
});
