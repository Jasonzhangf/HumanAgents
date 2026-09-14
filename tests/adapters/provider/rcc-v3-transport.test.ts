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
  const transport = createV3ProviderHttpTransport({
    binding: provider,
    baseUrl: 'http://127.0.0.1:4444',
    evidence: sink(),
    fetch: async (url, init) => fetch(url, init),
  });
  return { adapter: new ProviderAdapter({ binding: provider, routeRef: 'test-route', codec, transport, evidence: sink() }), calls };
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

test('RCC v3 probe verifies health and requested model before reporting ready', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => {
    if (url.endsWith('/health')) return jsonResponse({ status: 'ok', version: '0.90.4785' });
    if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'provider.model' }] });
    throw new Error(`unexpected probe URL: ${url}`);
  }, writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'ready');
  const capabilities = await built.adapter.capabilities(binding);
  assert.deepEqual(capabilities.capabilities, ['model:provider.model', 'responses:stream', 'observe', 'stop', 'settle', 'close']);
  assert.deepEqual(built.calls.map((call) => [call.init.method, call.url]), [
    ['GET', 'http://127.0.0.1:4444/health'],
    ['GET', 'http://127.0.0.1:4444/v1/models'],
  ]);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health', 'probe-models']);
});

test('ProviderAdapter refreshes an explicit probe while reusing an unexpired capability result', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => url.endsWith('/health')
    ? jsonResponse({ status: 'ok', version: '0.90.4785' })
    : jsonResponse({ data: [{ id: 'provider.model' }] }), writes);

  await built.adapter.probe(binding);
  await built.adapter.capabilities(binding);
  assert.equal(built.calls.length, 2);
  await built.adapter.probe(binding);
  assert.equal(built.calls.length, 4);
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

test('RCC v3 transport maps internal Responses wire to standard endpoint JSON', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const body = chunks([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1"}}\n\n',
  ]);
  const built = adapter(fetchStub(body, calls));
  await built.adapter.start(startInput());
  const request = JSON.parse(calls[0].init.body!);

  assert.equal(calls[0].url, 'http://127.0.0.1:4444/v1/responses');
  assert.equal(request.model, 'provider.model');
  assert.equal(request.stream, true);
  assert.equal(request.route, undefined);
  assert.equal(request.execution, undefined);
  assert.equal(request.checkpointId, undefined);
  assert.equal(request.type, undefined);

  const events = [];
  for await (const event of built.adapter.observe(execution)) events.push(event);
  assert.equal(events.at(-1)?.terminalState, 'succeeded');
});

test('RCC v3 transport maps Anthropic wire to /v1/messages and preserves SSE chunk boundaries', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const body = chunks([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","model":"provider.model","role":"assistant"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const anthropicBinding = { ...binding, bindingId: 'binding-anthropic', providerId: 'goaichat', protocol: 'anthropic' as const };
  const built = adapter(fetchStub(body, calls), anthropicBinding, new AnthropicProviderCodec(4096));
  await built.adapter.start(startInput());
  const request = JSON.parse(calls[0].init.body!);

  assert.equal(calls[0].url, 'http://127.0.0.1:4444/v1/messages');
  assert.equal(request.model, 'provider.model');
  assert.equal(request.stream, true);
  assert.equal(request.execution, undefined);
  assert.equal(request.checkpointId, undefined);
  const events = [];
  for await (const event of built.adapter.observe(execution)) events.push(event);
  assert.equal(events.at(-1)?.terminalState, 'succeeded');
});

test('RCC v3 transport exposes provider error and rejects incomplete SSE without terminal', async () => {
  const errorBody = chunks(['event: error\ndata: {"type":"error","error":{"code":"overloaded","message":"busy"}}\n\n']);
  const built = adapter(fetchStub(errorBody, []));
  await built.adapter.start(startInput());
  const events = [];
  for await (const event of built.adapter.observe(execution)) events.push(event);
  assert.equal(events.at(-1)?.kind, 'error');
  const failed = await built.adapter.settle(execution);
  assert.equal(failed.state, 'failed');

  const incomplete = adapter(fetchStub(chunks(['data: {"type":"response.created"}']), []) );
  await incomplete.adapter.start(startInput());
  await assert.rejects(async () => {
    for await (const _event of incomplete.adapter.observe(execution)) void _event;
  }, /incomplete|terminal/);
  const incompleteSettlement = await incomplete.adapter.settle(execution);
  assert.equal(incompleteSettlement.state, 'failed');
});

test('RCC v3 stop receipt is distinct from settle and does not claim remote cancellation', async () => {
  const built = adapter(fetchStub(chunks([]), []));
  await built.adapter.start(startInput());
  const stop = await built.adapter.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' });
  assert.equal(stop.status, 'accepted');
  assert.equal('state' in stop, false);
  const settled = await built.adapter.settle(execution);
  assert.equal(settled.state, 'waiting');
  assert.equal(settled.resourceRelease.state, 'pending');
});

test('RCC v3 stop request remains stopped when the Responses stream later closes', async () => {
  const built = adapter(fetchStub(chunks([
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-stop"}}\n\n',
  ]), []));
  await built.adapter.start(startInput());
  const stop = await built.adapter.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' });
  assert.equal(stop.status, 'accepted');
  for await (const _event of built.adapter.observe(execution)) void _event;
  const settled = await built.adapter.settle(execution);
  assert.equal(settled.state, 'stopped');
});

test('RCC v3 stop swallows the transport abort and settles stopped', async () => {
  const abortAwareFetch: V3ProviderFetch = async (_url, init) => ({
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        if (init.signal?.aborted) throw new Error('AbortError');
        await new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
        });
      },
    },
    text: async () => 'rcc-test-response',
  });
  const built = adapter(abortAwareFetch);
  await built.adapter.start(startInput());
  await built.adapter.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' });
  for await (const _event of built.adapter.observe(execution)) void _event;
  const settled = await built.adapter.settle(execution);
  assert.equal(settled.state, 'stopped');
});
