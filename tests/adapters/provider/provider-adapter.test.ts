import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  id,
  type EvidenceRef,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderResumeInput,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  AnthropicProviderCodec,
  ProviderAdapter,
  ProviderAdapterError,
  ResponsesProviderCodec,
  type ProviderTransport,
  type ProviderWireEvent,
} from '../../../packages/adapters/provider/src/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const operation = id('operation', 'operation-a');
const operationScope: ScopeRef = { organId: organ, taskId: task, operationId: operation };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `ev-provider-${label}`),
    kind: 'execution',
    source: 'test-provider',
    locator: label,
    scope: operationScope,
  };
}

function execution() {
  return { runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 };
}

function startInput(overrides: Partial<ProviderStartInput> = {}): ProviderStartInput {
  return { ...execution(), inputRefs: ['input-a'], evidenceRefs: [evidence('start')], ...overrides };
}

function resumeInput(overrides: Partial<ProviderResumeInput> = {}): ProviderResumeInput {
  return {
    ...startInput(),
    checkpointId: id('checkpoint', 'cp-provider'),
    checkpointExecutionEpoch: 1,
    ...overrides,
  };
}

function submitInput(overrides: Partial<ProviderSubmitInput> = {}): ProviderSubmitInput {
  return {
    ...execution(),
    inputRefs: ['input-b'],
    evidenceRefs: [evidence('submit')],
    payload: { question: 'continue' },
    ...overrides,
  };
}

function stopRequest(overrides: Partial<ProviderStopRequest> = {}): ProviderStopRequest {
  return { ...execution(), reason: 'operator stop', ownerId: 'stop-controller', evidenceRefs: [evidence('stop-request')], ...overrides };
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
const ccSolBinding = binding({
  bindingId: 'binding-cc-sol',
  providerId: 'cc-sol',
  endpointRef: 'local-endpoint-cc-sol',
  modelRef: 'model-cc-sol',
  configDigest: 'sha256:cc-sol-config',
  capabilityDigest: 'sha256:cc-sol-capability',
});
const goaichatBinding = binding({
  bindingId: 'binding-goaichat',
  providerId: 'goaichat',
  protocol: 'anthropic',
  endpointRef: 'local-endpoint-goaichat',
  modelRef: 'model-goaichat',
  configDigest: 'sha256:goaichat-config',
  capabilityDigest: 'sha256:goaichat-capability',
});

function readiness(provider: ProviderBinding): ProviderReadiness {
  return {
    bindingId: provider.bindingId,
    providerId: provider.providerId,
    protocol: provider.protocol,
    state: 'ready',
    capabilityDigest: provider.capabilityDigest,
    checkedAt: '2026-09-13T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    evidenceRefs: [evidence('readiness')],
  };
}

function capabilities(provider: ProviderBinding): ProviderCapabilities {
  return {
    bindingId: provider.bindingId,
    providerId: provider.providerId,
    protocol: provider.protocol,
    capabilities: ['start', 'resume', 'submit', 'observe', 'stop', 'settle', 'close'],
    version: '0.1.0',
    digest: provider.capabilityDigest,
    checkedAt: '2026-09-13T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    evidenceRefs: [evidence('capabilities')],
  };
}

function startReceipt(provider: ProviderBinding): ProviderStartReceipt {
  return {
    ...execution(),
    startedAt: '2026-09-13T00:00:00Z',
    evidenceRefs: [evidence('start-receipt')],
    externalExecutionRef: { ...evidence('external'), kind: 'external', locator: `external/${provider.providerId}` },
  };
}

function recoveryResult(): ProviderRecoveryResult {
  return {
    ...execution(),
    checkpointId: id('checkpoint', 'cp-provider'),
    recovered: true,
    staleRejected: false,
    recoveryStateRef: evidence('recovery-state'),
    evidenceRefs: [evidence('recovery')],
  };
}

function submitResult(): ProviderSubmitResult {
  return {
    ...execution(),
    status: 'completed',
    outputRefs: ['output-a'],
    evidenceRefs: [evidence('submit-result')],
    payload: { answer: 'ok' },
  };
}

function stopReceipt(): ProviderStopReceipt {
  return {
    ...execution(),
    status: 'accepted',
    receivedAt: '2026-09-13T00:00:00Z',
    evidenceRefs: [evidence('stop-receipt')],
  };
}

function settlement(): ProviderSettlement {
  return {
    ...execution(),
    state: 'succeeded',
    evidenceRefs: [evidence('settle')],
    resourceRelease: { state: 'released', evidenceRefs: [evidence('resource')] },
    persistence: { state: 'committed', evidenceRefs: [evidence('persistence')] },
  };
}

function closeResult(provider: ProviderBinding): ProviderCloseResult {
  return {
    bindingId: provider.bindingId,
    providerId: provider.providerId,
    protocol: provider.protocol,
    state: 'closed',
    evidenceRefs: [evidence('close')],
  };
}

function makeTransport(provider: ProviderBinding, overrides: Partial<ProviderTransport> = {}): ProviderTransport {
  const transport: ProviderTransport = {
    readiness: readiness(provider),
    capabilities: capabilities(provider),
    start: async () => startReceipt(provider),
    resume: async () => recoveryResult(),
    submit: async () => submitResult(),
    observe: async function* () { yield* []; },
    requestStop: async () => stopReceipt(),
    settle: async () => settlement(),
    close: async () => closeResult(provider),
  };
  return { ...transport, ...overrides };
}

function responsesAdapter(transport: ProviderTransport, provider = ccBinding) {
  return new ProviderAdapter({ binding: provider, routeRef: `${provider.providerId}-route`, codec: new ResponsesProviderCodec(), transport });
}

function anthropicAdapter(transport: ProviderTransport, provider = goaichatBinding) {
  return new ProviderAdapter({ binding: provider, routeRef: `${provider.providerId}-route`, codec: new AnthropicProviderCodec(4096), transport });
}

test('responses and anthropic codecs keep independent explicit wire contracts', () => {
  const responses = new ResponsesProviderCodec();
  const anthropic = new AnthropicProviderCodec(4096);
  const responsesRequest = responses.encodeStart(startInput(), ccBinding, 'cc-route');
  const anthropicRequest = anthropic.encodeStart(startInput(), goaichatBinding, 'goaichat-route');

  assert.equal(responsesRequest.type, 'responses.request');
  assert.equal(anthropicRequest.type, 'anthropic.request');
  assert.equal(responsesRequest.protocol, 'responses');
  assert.equal(anthropicRequest.protocol, 'anthropic');
  assert.equal(responsesRequest.route, 'cc:cc-route');
  assert.equal(anthropicRequest.route, 'goaichat:goaichat-route');
  assert.equal(responses.encodeStop(stopRequest(), ccBinding, 'cc-route').type, 'responses.cancel');
  assert.equal(anthropic.encodeStop(stopRequest(), goaichatBinding, 'goaichat-route').type, 'anthropic.cancel');
  assert.equal(Object.is(responsesRequest, anthropicRequest), false);
});

test('responses codec maps terminal, tool, and error wire events', () => {
  const codec = new ResponsesProviderCodec();
  const context = { execution: execution(), scope: operationScope };

  const completed = codec.decodeEvent({ protocol: 'responses', type: 'response.completed', response_id: 'response-1' }, context);
  assert.equal(completed.events[0].kind, 'terminal');
  assert.equal(completed.events[0].terminalState, 'succeeded');

  const tool = codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'lookup', arguments: '{}' },
  }, context);
  assert.equal(tool.events[0].kind, 'tool');

  const error = codec.decodeEvent({ protocol: 'responses', type: 'error', error: { code: 'wire.error', message: 'boom' } }, context);
  assert.equal(error.events[0].kind, 'error');
  assert.equal(error.events[0].error?.code, 'wire.error');
});

test('anthropic codec maps terminal, tool, and error wire events', () => {
  const codec = new AnthropicProviderCodec(4096);
  const context = { execution: execution(), scope: operationScope };

  const completed = codec.decodeEvent({ protocol: 'anthropic', type: 'message_stop' }, context);
  assert.equal(completed.events[0].kind, 'terminal');
  assert.equal(completed.events[0].terminalState, 'succeeded');

  const tool = codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
  }, context);
  assert.equal(tool.events[0].kind, 'tool');

  const error = codec.decodeEvent({ protocol: 'anthropic', type: 'error', error: { type: 'wire_error', message: 'boom' } }, context);
  assert.equal(error.events[0].kind, 'error');
  assert.equal(error.events[0].error?.code, 'wire_error');
});

test('provider adapter binds cc, cc-sol, and goaichat as distinct explicit routes', async () => {
  const cc = responsesAdapter(makeTransport(ccBinding), ccBinding);
  const ccSol = responsesAdapter(makeTransport(ccSolBinding), ccSolBinding);
  const goaichat = anthropicAdapter(makeTransport(goaichatBinding), goaichatBinding);

  assert.equal((await cc.probe(ccBinding)).state, 'ready');
  assert.equal((await ccSol.probe(ccSolBinding)).state, 'ready');
  assert.equal((await goaichat.probe(goaichatBinding)).state, 'ready');
  await assert.rejects(() => cc.probe(ccSolBinding), /binding identity/);
  await assert.rejects(() => goaichat.probe(ccBinding), /binding identity/);
});

test('provider adapter runs start, observe, stop receipt, settle, and close', async () => {
  const events: ProviderWireEvent[] = [
    { protocol: 'responses', type: 'response.created', response_id: 'response-1', model: 'model-cc' },
    { protocol: 'responses', type: 'response.output_text.delta', item_id: 'item-1', delta: 'hello' },
    { protocol: 'responses', type: 'response.completed', response_id: 'response-1' },
  ];
  const transport = makeTransport(ccBinding, {
    observe: async function* () { yield* events; },
  });
  const adapter = responsesAdapter(transport, ccBinding);

  const started = await adapter.start(startInput());
  assert.equal(started.operationId.value, operation.value);
  const observed: ProviderEvent[] = [];
  for await (const event of adapter.observe(execution())) observed.push(event);
  assert.equal(observed.at(-1)?.terminalState, 'succeeded');
  const stop = await adapter.requestStop(stopRequest());
  assert.equal(stop.status, 'accepted');
  assert.equal((stop as unknown as Record<string, unknown>).state, undefined);
  const settled = await adapter.settle(execution());
  assert.equal(settled.state, 'succeeded');
  assert.equal((await adapter.close(ccBinding)).state, 'closed');
});

test('protocol mismatch, missing readiness evidence, unknown event, and missing fields fail explicitly', async () => {
  assert.throws(
    () => new ProviderAdapter({ binding: goaichatBinding, routeRef: 'goaichat-route', codec: new ResponsesProviderCodec(), transport: makeTransport(goaichatBinding) }),
    /protocol/,
  );

  const noReadiness = responsesAdapter(makeTransport(ccBinding, { readiness: undefined }), ccBinding);
  await assert.rejects(() => noReadiness.probe(ccBinding), /readiness evidence/);

  const unknownAdapter = responsesAdapter(makeTransport(ccBinding, {
    observe: async function* () { yield { protocol: 'responses', type: 'response.unknown' } as unknown as ProviderWireEvent; },
  }), ccBinding);
  await unknownAdapter.start(startInput());
  await assert.rejects(async () => {
    for await (const _event of unknownAdapter.observe(execution())) void _event;
  }, /unknown/);

  const missingFieldAdapter = responsesAdapter(makeTransport(ccBinding, {
    observe: async function* () { yield { protocol: 'responses', type: 'response.completed' } as unknown as ProviderWireEvent; },
  }), ccBinding);
  await missingFieldAdapter.start(startInput());
  await assert.rejects(async () => {
    for await (const _event of missingFieldAdapter.observe(execution())) void _event;
  }, /missing response_id/);

  const noActiveExecution = responsesAdapter(makeTransport(ccBinding), ccBinding);
  await assert.rejects(async () => {
    for await (const _event of noActiveExecution.observe(execution())) void _event;
  }, /active execution/);
});

test('provider adapter source avoids dsh/rcc/sdk imports, network calls, and secret patterns', async () => {
  const files = ['adapter.ts', 'codecs.ts', 'errors.ts', 'index.ts', 'wire.ts'];
  const forbidden = [
    /[\s('"]dsh/i,
    /[\s('"]rcc/i,
    /routecodex/i,
    /@openai|openai/i,
    /anthropic-ai|anthropic-sdk/i,
    /provider-sdk/i,
    /(?:api[_-]?key|authorization|bearer|secret|password|access[_-]?token|auth[_-]?token)/i,
    /fetch\s*\(/i,
    /https?:\/\//i,
    /node:(?:http|https|net|child_process)/i,
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../../../../../packages/adapters/provider/src/${file}`, import.meta.url), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${file} must not contain ${pattern}`);
    }
  }
});
