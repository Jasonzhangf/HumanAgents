import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ProviderBinding,
  type ProviderEvent,
  type ProviderSettlement,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  AnthropicProviderCodec,
  ProviderAdapter,
  ResponsesProviderCodec,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type ProviderTransport,
  type ProviderWireEvent,
} from '../../../packages/adapters/provider/src/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const operation = id('operation', 'operation-a');
const operationScope: ScopeRef = { organId: organ, taskId: task, operationId: operation };
const ownerId = 'humanagent.provider-adapter';

function fixtureUrl(file: string): URL {
  const compiled = /\/dist\//.test(import.meta.url);
  const ups = compiled ? 5 : 3;
  return new URL(`${'../'.repeat(ups)}tests/adapters/provider/fixtures/${file}`, import.meta.url);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(fixtureUrl(file), 'utf8')) as T;
}

async function readJsonl(file: string): Promise<ProviderWireEvent[]> {
  const text = await readFile(fixtureUrl(file), 'utf8');
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProviderWireEvent);
}

function execution() {
  return { runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 };
}

function evidence(label: string, kind: EvidenceRef['kind'] = 'execution'): EvidenceRef {
  return {
    evidenceId: id('evidence', `ev-provider-replay-${label}`),
    kind,
    source: 'test-provider-replay',
    locator: `replay://provider/${label}`,
    scope: operationScope,
  };
}

function startInput() {
  return { ...execution(), inputRefs: ['input-a'], evidenceRefs: [evidence('start')], payload: { prompt: 'replay the recorded provider exchange' } };
}

function stopRequest() {
  return { ...execution(), reason: 'operator stop', ownerId: 'stop-controller', evidenceRefs: [evidence('stop-request')] };
}

function binding(overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    bindingId: 'binding-cc',
    providerId: 'cc',
    protocol: 'responses',
    endpointRef: 'local-endpoint-cc',
    modelRef: 'model-cc',
    configDigest: 'sha256:cc-config',
    capabilityDigest: 'sha256:cc-capability',
    ...overrides,
  };
}

const ccBinding = binding();
const goaichatBinding = binding({
  bindingId: 'binding-goaichat',
  providerId: 'goaichat',
  protocol: 'anthropic',
  endpointRef: 'local-endpoint-goaichat',
  modelRef: 'model-goaichat',
  configDigest: 'sha256:goaichat-config',
  capabilityDigest: 'sha256:goaichat-capability',
});

function memoryEvidenceSink(): ProviderEvidenceSink {
  const store = new Map<string, string>();
  return {
    async write(input: ProviderEvidenceWrite) {
      const content = typeof input.content === 'string' ? input.content : JSON.stringify(input.content);
      const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      const evidenceId = id('evidence', `provider-replay-${`${input.type}-${input.locator}-${digest}`.replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 128));
      store.set(evidenceId.value, content);
      return {
        evidenceId,
        kind: input.kind,
        source: 'test-provider-replay',
        locator: input.locator,
        digest,
        scope: input.scope,
      };
    },
    async read(ref: EvidenceRef) {
      return new TextEncoder().encode(store.get(ref.evidenceId.value) ?? '');
    },
  };
}

function codecContext(sink = memoryEvidenceSink()) {
  let sequence = 0;
  return {
    execution: execution(),
    scope: operationScope,
    evidence: sink,
    sink,
    responsesOutputText: new Map<string, string>(),
    nextEventId: (type: string, locator: string) => `event-${type}-${locator.replace(/[^A-Za-z0-9._-]/g, '-')}-${++sequence}`,
  };
}

function startReceipt(): ProviderStartReceipt {
  return {
    ...execution(),
    startedAt: '2026-09-13T00:00:00Z',
    evidenceRefs: [evidence('start-receipt')],
    externalExecutionRef: { ...evidence('external-execution', 'external'), locator: 'replay://provider/external-execution' },
  };
}

function stopReceipt(): ProviderStopReceipt {
  return {
    ...execution(),
    status: 'accepted',
    receivedAt: '2026-09-13T00:00:01Z',
    evidenceRefs: [evidence('stop-receipt')],
  };
}

function settlement(): ProviderSettlement {
  return {
    ...execution(),
    state: 'stopped',
    evidenceRefs: [evidence('settle')],
    resourceRelease: { state: 'released', evidenceRefs: [evidence('resource-release')] },
    persistence: { state: 'committed', evidenceRefs: [evidence('persistence')] },
  };
}

function replayTransport(events: readonly ProviderWireEvent[], overrides: Partial<ProviderTransport> = {}): ProviderTransport {
  const transport: ProviderTransport = {
    start: async () => startReceipt(),
    resume: async () => ({
      ...execution(),
      checkpointId: id('checkpoint', 'cp-replay'),
      recovered: true,
      staleRejected: false,
      recoveryStateRef: evidence('recovery-state'),
      evidenceRefs: [evidence('resume')],
    }),
    submit: async () => ({
      ...execution(),
      status: 'completed',
      outputRefs: ['output-a'],
      evidenceRefs: [evidence('submit')],
      payload: { answer: 'ok' },
    }),
    observe: async function* () {
      yield* events;
    },
    requestStop: async () => stopReceipt(),
    settle: async () => settlement(),
    close: async (bindingRef) => ({
      bindingId: bindingRef.bindingId,
      providerId: bindingRef.providerId,
      protocol: bindingRef.protocol,
      state: 'closed',
      evidenceRefs: [evidence('close')],
    }),
  };
  return { ...transport, ...overrides };
}

function responsesAdapter(transport: ProviderTransport, provider = ccBinding) {
  return new ProviderAdapter({
    binding: provider,
    routeRef: `${provider.providerId}-route`,
    codec: new ResponsesProviderCodec(),
    transport,
    evidence: memoryEvidenceSink(),
  });
}

function anthropicAdapter(transport: ProviderTransport, provider = goaichatBinding) {
  return new ProviderAdapter({
    binding: provider,
    routeRef: `${provider.providerId}-route`,
    codec: new AnthropicProviderCodec(4096),
    transport,
    evidence: memoryEvidenceSink(),
  });
}

async function observeReplay(adapter: ProviderAdapter, events: readonly ProviderWireEvent[]): Promise<ProviderEvent[]> {
  await adapter.start(startInput());
  const observed: ProviderEvent[] = [];
  for await (const event of adapter.observe(execution())) observed.push(event);
  return observed;
}

test('recorded Responses success sequence replays through codec and immutable evidence sink', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const decoded: ProviderEvent[] = [];

  for (const raw of await readJsonl('responses-success.jsonl')) {
    decoded.push(...(await codec.decodeEvent(raw, context)).events);
  }

  assert.deepEqual(decoded.map((event) => event.kind), ['model', 'output', 'terminal']);
  assert.equal(decoded.find((event) => event.kind === 'output')?.summary, 'hello');
  assert.equal(decoded.at(-1)?.terminalState, 'succeeded');
  assert.equal(decoded.at(-1)?.ownerId, ownerId);
  assert.deepEqual(decoded.at(-1)?.nextAction, { kind: 'continue' });
  assert.match(new TextDecoder().decode(await context.sink.read(decoded.at(-1)!.evidenceRefs[0])), /resp-replay-success/);
});

test('recorded Anthropic success sequence replays through codec and immutable evidence sink', async () => {
  const codec = new AnthropicProviderCodec(4096);
  const context = codecContext();
  const decoded: ProviderEvent[] = [];

  for (const raw of await readJsonl('anthropic-success.jsonl')) {
    decoded.push(...(await codec.decodeEvent(raw, context)).events);
  }

  assert.equal(decoded.filter((event) => event.kind === 'output').length, 2);
  assert.equal(decoded.at(-1)?.kind, 'terminal');
  assert.equal(decoded.at(-1)?.terminalState, 'succeeded');
  assert.equal(decoded.at(-1)?.ownerId, ownerId);
  assert.match(new TextDecoder().decode(await context.sink.read(decoded.at(-1)!.evidenceRefs[0])), /end_turn/);
});

test('recorded Responses provider error replays through adapter with owner and next action', async () => {
  const events = await readJsonl('responses-error.jsonl');
  const observed = await observeReplay(responsesAdapter(replayTransport(events), ccBinding), events);
  const errorEvent = observed.find((event) => event.kind === 'error');

  assert.equal(errorEvent?.error?.code, 'server_error');
  assert.equal(errorEvent?.error?.ownerId, ownerId);
  assert.deepEqual(errorEvent?.nextAction, { kind: 'recover', ref: ownerId });
  assert.deepEqual(errorEvent?.error?.nextAction, { kind: 'recover', ref: ownerId });
});

test('recorded Anthropic provider error replays through adapter with owner and next action', async () => {
  const events = await readJsonl('anthropic-error.jsonl');
  const observed = await observeReplay(anthropicAdapter(replayTransport(events), goaichatBinding), events);
  const errorEvent = observed.find((event) => event.kind === 'error');

  assert.equal(errorEvent?.error?.code, 'overloaded_error');
  assert.equal(errorEvent?.error?.ownerId, ownerId);
  assert.deepEqual(errorEvent?.nextAction, { kind: 'recover', ref: ownerId });
  assert.deepEqual(errorEvent?.error?.nextAction, { kind: 'recover', ref: ownerId });
});

test('recorded stop receipt stays distinct from settle result', async () => {
  const recorded = await readJson<{
    start: ProviderStartReceipt;
    stop: ProviderStopReceipt;
    settle: ProviderSettlement;
  }>('stop-settle.json');
  const transport = replayTransport([], {
    start: async () => recorded.start,
    requestStop: async () => recorded.stop,
    settle: async () => recorded.settle,
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await adapter.start(startInput());
  const stop = await adapter.requestStop(stopRequest());
  assert.equal(stop.status, 'accepted');
  assert.equal('state' in stop, false);
  assert.equal('settled' in stop, false);

  const settled = await adapter.settle(execution());
  assert.equal(settled.state, 'stopped');
  assert.equal(settled.resourceRelease.state, 'released');
  assert.equal(settled.persistence.state, 'committed');
});
