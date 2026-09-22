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
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ProviderAdapterError,
  ResponsesProviderCodec,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type ProviderCodec,
  type ProviderWireEvent,
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
  return {
    ...execution,
    inputRefs: ['task://task-provider-rcc/input/1'],
    evidenceRefs: [evidence('start')],
    payload: { prompt: 'summarize the failing build log' },
  };
}

function anthropicAdapter(fetch: V3ProviderFetch) {
  const provider: ProviderBinding = {
    ...binding,
    bindingId: 'binding-anthropic-rcc-test',
    providerId: 'goaichat',
    protocol: 'anthropic',
    endpointRef: 'rcc-v3-4444-anthropic',
    modelRef: 'provider.model',
    configDigest: 'sha256:anthropic-test-config',
    capabilityDigest: 'sha256:anthropic-test-capability',
  };
  return adapter(fetch, provider, new AnthropicProviderCodec(4096));
}

function adapter(fetch: V3ProviderFetch, provider = binding, codec: ProviderCodec = new ResponsesProviderCodec()) {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const writes: ProviderEvidenceWrite[] = [];
  const contentByRef = new Map<EvidenceRef, Uint8Array>();
  const transportEvidence: ProviderEvidenceSink = {
    async write(input) {
      const ref = {
        evidenceId: id('evidence', `rcc-write-${input.type}-${input.locator.replace(/[^A-Za-z0-9._-]/g, '-')}`),
        kind: input.kind,
        source: 'rcc-v3-transport-test',
        locator: input.locator,
        scope: input.scope,
      };
      writes.push(input);
      contentByRef.set(ref, new TextEncoder().encode(typeof input.content === 'string' ? input.content : JSON.stringify(input.content)));
      return ref;
    },
    async read(ref) {
      const content = contentByRef.get(ref);
      if (!content) throw new Error(`missing evidence ${ref.locator}`);
      return content;
    },
  };
  const transport = createV3ProviderHttpTransport({
    binding: provider,
    baseUrl: 'http://127.0.0.1:4444',
    evidence: transportEvidence,
    fetch: async (url, init) => fetch(url, init),
  });
  return { adapter: new ProviderAdapter({ binding: provider, routeRef: 'test-route', codec, transport, evidence: sink() }), calls, writes, evidence: transportEvidence };
}

function openAIAdapter(fetch: V3ProviderFetch) {
  const provider: ProviderBinding = {
    ...binding,
    bindingId: 'binding-openai-rcc-test',
    providerId: 'rcc-openai-entry',
    protocol: 'openai',
    endpointRef: 'rcc-v3-4444-openai',
    modelRef: 'provider.model',
    configDigest: 'sha256:openai-test-config',
    capabilityDigest: 'sha256:openai-test-capability',
  };
  return adapter(fetch, provider, new OpenAIChatProviderCodec());
}

function transportHarness() {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const writes: ProviderEvidenceWrite[] = [];
  const refs: EvidenceRef[] = [];
  const contentByRef = new Map<EvidenceRef, Uint8Array>();
  const evidence: ProviderEvidenceSink = {
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
      contentByRef.set(ref, new TextEncoder().encode(typeof input.content === 'string' ? input.content : JSON.stringify(input.content)));
      return ref;
    },
    async read(ref) {
      const content = contentByRef.get(ref);
      if (!content) throw new Error(`missing evidence ${ref.locator}`);
      return content;
    },
  };
  const transport = createV3ProviderHttpTransport({
    binding,
    baseUrl: 'http://127.0.0.1:4444',
    evidence,
    fetch: async (url, init) => {
      calls.push({ url, init });
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  return { transport, calls, writes, refs, evidence };
}

function executionKey(input = execution): string {
  return `${input.runtimeId}:${input.taskId.value}:${input.operationId.value}:${input.executionEpoch}`;
}

// Seed the owned execution so post-start transport contracts remain isolated
// from the start request path.
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

test('RCC v3 probe keeps listener and model discovery evidence without inferring capability', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => {
    if (url.endsWith('/health')) return jsonResponse({ status: 'ok', version: '0.90.4785' });
    if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'provider.model' }] });
    throw new Error(`unexpected probe URL: ${url}`);
  }, writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'ready');
  assert.equal(readiness.failure, undefined);
  await assert.rejects(() => built.adapter.capabilities(binding), /capabilities are unavailable/);
  assert.deepEqual(built.calls.map((call) => [call.init.method, call.url]), [
    ['GET', 'http://127.0.0.1:4444/health'],
    ['GET', 'http://127.0.0.1:4444/v1/models'],
  ]);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health', 'probe-models']);
});

test('RCC v3 probe remains ready for an empty model list without claiming model capability', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => url.endsWith('/health')
    ? jsonResponse({ status: 'ok' })
    : jsonResponse({ data: [], models: [] }), writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'ready');
  assert.equal(readiness.failure, undefined);
  assert.equal(readiness.evidenceRefs.length, 3);
  await assert.rejects(() => built.adapter.capabilities(binding), /capabilities are unavailable/);
  assert.equal(built.calls.length, 2);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health', 'probe-models', 'probe-model-unavailable']);
  assert.deepEqual(writes[2].content, { model: binding.modelRef, models: [] });
});

test('RCC v3 probe remains ready when the requested model is absent from discovery', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => url.endsWith('/health')
    ? jsonResponse({ status: 'ok' })
    : jsonResponse({ data: [{ id: 'another.model' }] }), writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'ready');
  assert.equal(readiness.failure, undefined);
  assert.equal(readiness.evidenceRefs.length, 3);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health', 'probe-models', 'probe-model-unavailable']);
  assert.deepEqual(writes[2].content, { model: binding.modelRef, models: ['another.model'] });
});

test('RCC v3 probe reports model discovery failure as degraded readiness', async () => {
  const cases = [
    {
      code: 'models.http.503',
      fetch: async (url: string) => url.endsWith('/health')
        ? jsonResponse({ status: 'ok' })
        : textResponse('models unavailable', 503),
    },
    {
      code: 'models.invalid-json',
      fetch: async (url: string) => url.endsWith('/health')
        ? jsonResponse({ status: 'ok' })
        : textResponse('{'),
    },
    {
      code: 'models.transport-failure',
      fetch: async (url: string) => {
        if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
        throw new Error('models transport unavailable');
      },
    },
  ] as const;

  for (const probeCase of cases) {
    const writes: ProviderEvidenceWrite[] = [];
    const built = probeAdapter(probeCase.fetch, writes);

    const readiness = await built.adapter.probe(binding);
    assert.equal(readiness.state, 'degraded');
    assert.equal(readiness.failure?.code, probeCase.code);
    assert.equal(readiness.failure?.phase, 'probe');
    assert.equal(readiness.ownerId, 'humanagent.provider-adapter.rcc-v3');
    assert.equal(readiness.nextAction?.kind, 'recover');
    assert.equal(readiness.evidenceRefs.length, 2);
    assert.deepEqual(writes.map((write) => write.type), ['probe-health', 'probe-models']);
  }
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

test('RCC v3 probe treats a non-ok health payload as not-ready', async () => {
  const writes: ProviderEvidenceWrite[] = [];
  const built = probeAdapter(async (url) => url.endsWith('/health')
    ? jsonResponse({ status: 'error' })
    : jsonResponse({ data: [{ id: 'provider.model' }] }), writes);

  const readiness = await built.adapter.probe(binding);
  assert.equal(readiness.state, 'not-ready');
  assert.equal(readiness.failure?.code, 'health.not-ready');
  assert.equal(readiness.ownerId, 'humanagent.provider-adapter.rcc-v3');
  assert.equal(readiness.nextAction?.kind, 'recover');
  assert.deepEqual(built.calls.map((call) => call.url), ['http://127.0.0.1:4444/health']);
  assert.deepEqual(writes.map((write) => write.type), ['probe-health']);
});

test('RCC v3 start sends the explicit request and returns a receipt', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const body = chunks([
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1"}}\n\n',
  ]);
  const built = adapter(fetchStub(body, calls));

  const receipt = await built.adapter.start(startInput());
  assert.equal(receipt.runtimeId, execution.runtimeId);
  assert.equal(receipt.taskId.value, execution.taskId.value);
  assert.equal(receipt.operationId.value, execution.operationId.value);
  assert.equal(receipt.executionEpoch, execution.executionEpoch);
  assert.equal(receipt.ownerId, undefined);
  assert.equal(receipt.nextAction, undefined);
  assert.equal(receipt.evidenceRefs.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4444/v1/responses');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body!), {
    model: binding.modelRef,
    instructions: '',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: JSON.stringify({ prompt: 'summarize the failing build log' }) }],
    }],
    stream: true,
  });
  assert.deepEqual(built.writes.map((write) => write.type), ['start']);
  assert.equal((built.writes[0].content as { route?: string }).route, 'cc:test-route');
});

test('provider wire bodies carry business text and never internal control refs', async () => {
  const bodies: string[] = [];
  for (const build of [adapter, openAIAdapter, anthropicAdapter]) {
    const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
    const built = build(fetchStub(chunks([]), calls));
    await built.adapter.start({
      ...startInput(),
      inputRefs: [
        'task://task-provider-rcc/input/1',
        'humanagent://session/provider-rcc/input/1',
        'asset://provider-rcc/report.md',
        'operation://operation-rcc-test/input',
      ],
    });
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0]!.init.body, 'string');
    bodies.push(calls[0]!.init.body!);
  }

  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.equal(body.includes('summarize the failing build log'), true);
    assert.equal(body.includes('inputRefs'), false);
    assert.equal(body.includes('task://'), false);
    assert.equal(body.includes('humanagent://'), false);
    assert.equal(body.includes('asset://'), false);
    assert.equal(body.includes('operation://'), false);
  }
});

test('RCC v3 openai entry sends Chat Completions and settles on [DONE]', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const built = openAIAdapter(fetchStub(chunks([
    'data: {"id":"chat-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"RCC_PROXY_ENTRY_OK"},"finish_reason":null}]}\n\n',
    'data: {"id":"chat-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]), calls));

  const receipt = await built.adapter.start(startInput());
  assert.equal(receipt.runtimeId, execution.runtimeId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4444/v1/chat/completions');
  assert.deepEqual(JSON.parse(calls[0].init.body!), {
    model: 'provider.model',
    messages: [
      { role: 'user', content: JSON.stringify({ prompt: 'summarize the failing build log' }) },
    ],
    stream: true,
  });

  const observed = [];
  for await (const event of built.adapter.observe(execution)) observed.push(event);
  assert.deepEqual(observed.map((event) => event.kind), ['output', 'terminal']);
  assert.equal(observed[0].summary, 'RCC_PROXY_ENTRY_OK');
  assert.equal(observed[1].terminalState, 'succeeded');
  const settled = await built.adapter.settle(execution);
  assert.equal(settled.state, 'succeeded');
});

test('RCC v3 openai entry maps a provider error before settle', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const built = openAIAdapter(fetchStub(chunks([
    'data: {"error":{"code":"server_error","message":"provider exploded"}}\n\n',
  ]), calls));

  await built.adapter.start(startInput());
  const observed = [];
  for await (const event of built.adapter.observe(execution)) observed.push(event);
  assert.deepEqual(observed.map((event) => event.kind), ['error', 'terminal']);
  const settled = await built.adapter.settle(execution);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error?.code, 'server_error');
  assert.equal(settled.error?.ownerId, 'humanagent.provider-adapter.rcc-v3');
});

test('RCC v3 openai content_filter finish reason becomes blocked', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const built = openAIAdapter(fetchStub(chunks([
    'data: {"id":"chat-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"harms"},"finish_reason":null}]}\n\n',
    'data: {"id":"chat-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n',
    'data: [DONE]\n\n',
  ]), calls));

  await built.adapter.start(startInput());
  const observed = [];
  for await (const event of built.adapter.observe(execution)) observed.push(event);
  assert.deepEqual(observed.map((event) => event.kind), ['output', 'error', 'terminal']);
  assert.equal(observed.at(-1)?.terminalState, 'blocked');
  assert.equal(observed.at(-2)?.error?.code, 'openai.finish_reason.content_filter');
  const settled = await built.adapter.settle(execution);
  assert.equal(settled.state, 'blocked');
  assert.equal(settled.error?.code, 'openai.finish_reason.content_filter');
});

test('RCC v3 transport accepts a route label that does not match the final upstream provider', async () => {
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

  const receipt = await wrongRouteAdapter.start(startInput());
  assert.equal(receipt.runtimeId, execution.runtimeId);
  assert.equal(calls.length, 1);
});

test('RCC v3 start exposes HTTP failure with owner, next action, and evidence', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const built = adapter(fetchStub(chunks([]), calls, 503));

  await assert.rejects(() => built.adapter.start(startInput()), (error) => {
    assert.equal(error instanceof ProviderAdapterError, true);
    const providerError = (error as ProviderAdapterError).providerError;
    assert.equal(providerError.code, 'http.503');
    assert.equal(providerError.category, 'provider');
    assert.equal(providerError.ownerId, 'humanagent.provider-adapter');
    assert.equal(providerError.nextAction.kind, 'recover');
    assert.equal(providerError.evidenceRefs.length, 1);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('RCC v3 start rejects a successful HTTP response without an SSE body', async () => {
  const calls: Array<{ url: string; init: V3ProviderFetchInit }> = [];
  const built = adapter(async (url, init) => {
    calls.push({ url, init });
    return { ...response(chunks([])), body: null };
  });

  await assert.rejects(() => built.adapter.start(startInput()), (error) => {
    assert.equal(error instanceof ProviderAdapterError, true);
    const providerError = (error as ProviderAdapterError).providerError;
    assert.equal(providerError.code, 'transport.empty.body');
    assert.equal(providerError.category, 'transport');
    assert.equal(providerError.ownerId, 'humanagent.provider-adapter');
    assert.equal(providerError.nextAction.kind, 'recover');
    assert.equal(providerError.evidenceRefs.length, 1);
    return true;
  });
  assert.equal(calls.length, 1);
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

test('RCC v3 stop-before-observe collapses to stopped without an observation loop', async () => {
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
  assert.equal(settled.state, 'stopped');
  assert.equal(settled.resourceRelease.state, 'released');
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

test('RCC v3 stop request awaits the aborted stream before settle instead of reporting waiting', async () => {
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
  const observed: ProviderWireEvent[] = [];
  const observing = (async () => {
    for await (const event of built.transport.observe(execution)) observed.push(event);
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stop = await built.transport.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' }, {
    protocol: 'responses',
    type: 'responses.cancel',
    route: 'cc:test-route',
    model: binding.modelRef,
    reason: 'operator stop',
    execution,
  });
  assert.equal(stop.status, 'accepted');
  const settled = await built.transport.settle(execution);
  await observing;
  assert.equal(settled.state, 'stopped');
  assert.equal(settled.resourceRelease.state, 'released');
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

test('RCC v3 provider failure remains failed when exact stop abort closes observation', async () => {
  const built = transportHarness();
  let controller!: AbortController;
  let resolveErrorSeen!: () => void;
  const errorSeen = new Promise<void>((resolve) => {
    resolveErrorSeen = resolve;
  });
  const providerFailureBody: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode('event: error\ndata: {"type":"error","error":{"code":"overloaded","message":"busy"}}\n\n');
      if (controller.signal.aborted) throw controller.signal.reason;
      await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    },
  };
  controller = seedActive(built.transport, providerFailureBody).controller;
  const observing = (async () => {
    for await (const event of built.transport.observe(execution)) {
      if (event.type === 'error') resolveErrorSeen();
    }
  })();

  await errorSeen;
  const stop = await built.transport.requestStop({ ...execution, reason: 'operator stop', ownerId: 'stop-controller' }, {
    protocol: 'responses',
    type: 'responses.cancel',
    route: 'cc:test-route',
    model: binding.modelRef,
    reason: 'operator stop',
    execution,
  });
  await observing;

  assert.equal(stop.status, 'accepted');
  const settled = await built.transport.settle(execution);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error?.code, 'overloaded');
  assert.equal(settled.resourceRelease.state, 'released');
  assert.equal(settled.persistence.state, 'pending');
  assert.equal((built.transport as unknown as { executions: Map<string, unknown> }).executions.has(executionKey()), true);
  const errorRef = settled.error?.evidenceRefs[0];
  assert.ok(errorRef);
  const readable = await built.evidence.read(errorRef);
  assert.match(new TextDecoder().decode(readable), /overloaded/);
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

test('RCC v3 ignores the duplicate response.done trailer emitted by the transparent proxy', async () => {
  const built = transportHarness();
  seedActive(built.transport, chunks([
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":""}}\n\n',
    'event: response.done\ndata: {"type":"response.done","response":{"id":""}}\n\n',
    'data: [DONE]\n\n',
  ]));

  const events: ProviderWireEvent[] = [];
  for await (const event of built.transport.observe(execution)) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['response.completed']);
  const settled = await built.transport.settle(execution);
  assert.equal(settled.state, 'succeeded');
});
