import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImmutableAssetStore } from '../../../packages/adapters/filesystem/src/index.js';
import {
  ContractError,
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
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ProviderAdapterError,
  ResponsesProviderCodec,
  filesystemProviderEvidenceSink,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type ProviderTransport,
  type ProviderWireEvent,
  type ResponsesWireTool,
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
  return { ...execution(), inputRefs: ['input-a'], evidenceRefs: [evidence('start')], payload: { prompt: 'start the task' }, ...overrides };
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
const openAIBinding = binding({
  bindingId: 'binding-openai-entry',
  providerId: 'rcc-openai-entry',
  protocol: 'openai',
  endpointRef: 'local-endpoint-rcc-openai',
  modelRef: 'model-openai-entry',
  configDigest: 'sha256:openai-entry-config',
  capabilityDigest: 'sha256:openai-entry-capability',
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

function startReceipt(provider: ProviderBinding, idRef = execution()): ProviderStartReceipt {
  return {
    ...idRef,
    startedAt: '2026-09-13T00:00:00Z',
    evidenceRefs: [evidence('start-receipt')],
    externalExecutionRef: { ...evidence('external'), kind: 'external', locator: `external/${provider.providerId}` },
  };
}

function recoveryResult(idRef = execution()): ProviderRecoveryResult {
  return {
    ...idRef,
    checkpointId: id('checkpoint', 'cp-provider'),
    recovered: true,
    staleRejected: false,
    recoveryStateRef: evidence('recovery-state'),
    evidenceRefs: [evidence('recovery')],
  };
}

function submitResult(idRef = execution()): ProviderSubmitResult {
  return {
    ...idRef,
    status: 'completed',
    outputRefs: ['output-a'],
    evidenceRefs: [evidence('submit-result')],
    payload: { answer: 'ok' },
  };
}

function stopReceipt(idRef = execution()): ProviderStopReceipt {
  return {
    ...idRef,
    status: 'accepted',
    receivedAt: '2026-09-13T00:00:00Z',
    evidenceRefs: [evidence('stop-receipt')],
  };
}

function settlement(overrides: Partial<ProviderSettlement> = {}, idRef = execution()): ProviderSettlement {
  return {
    ...idRef,
    state: 'succeeded',
    evidenceRefs: [evidence('settle')],
    resourceRelease: { state: 'released', evidenceRefs: [evidence('resource')] },
    persistence: { state: 'committed', evidenceRefs: [evidence('persistence')] },
    ...overrides,
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

function memoryEvidenceSink(): ProviderEvidenceSink {
  const store = new Map<string, string>();
  return {
    async write(input: ProviderEvidenceWrite) {
      const content = typeof input.content === 'string' ? input.content : JSON.stringify(input.content);
      const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      const evidenceId = id('evidence', `provider-${`${input.type}-${input.locator}-${digest}`.replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 128));
      store.set(evidenceId.value, content);
      return {
        evidenceId,
        kind: input.kind,
        source: 'test-provider',
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

function codecContext() {
  let sequence = 0;
  const sink = memoryEvidenceSink();
  return {
    execution: execution(),
    scope: operationScope,
    evidence: sink,
    sink,
    responsesOutputText: new Map<string, string>(),
    responsesCurrentResponseId: new Map<string, string>(),
    responsesPendingToolCalls: new Set<string>(),
    nextEventId: (type: string, locator: string) => `event-${type}-${locator.replace(/[^A-Za-z0-9._-]/g, '-')}-${++sequence}`,
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
  return new ProviderAdapter({ binding: provider, routeRef: `${provider.providerId}-route`, codec: new ResponsesProviderCodec(), transport, evidence: memoryEvidenceSink() });
}

function anthropicAdapter(transport: ProviderTransport, provider = goaichatBinding) {
  return new ProviderAdapter({ binding: provider, routeRef: `${provider.providerId}-route`, codec: new AnthropicProviderCodec(4096), transport, evidence: memoryEvidenceSink() });
}

function openAIAdapter(transport: ProviderTransport, provider = openAIBinding) {
  return new ProviderAdapter({ binding: provider, routeRef: `${provider.providerId}-route`, codec: new OpenAIChatProviderCodec(), transport, evidence: memoryEvidenceSink() });
}

test('responses, openai, and anthropic codecs keep independent explicit wire contracts', () => {
  const responses = new ResponsesProviderCodec();
  const openai = new OpenAIChatProviderCodec();
  const anthropic = new AnthropicProviderCodec(4096);
  const responsesRequest = responses.encodeStart(startInput(), ccBinding, 'cc-route');
  const openAIRequest = openai.encodeStart(startInput(), openAIBinding, 'openai-route');
  const anthropicRequest = anthropic.encodeStart(startInput(), goaichatBinding, 'goaichat-route');

  assert.equal(responsesRequest.type, 'responses.request');
  assert.equal(openAIRequest.type, 'openai.chat.request');
  assert.equal(anthropicRequest.type, 'anthropic.request');
  assert.equal(responsesRequest.protocol, 'responses');
  assert.equal(openAIRequest.protocol, 'openai');
  assert.equal(anthropicRequest.protocol, 'anthropic');
  assert.equal(responsesRequest.route, 'cc:cc-route');
  assert.equal(openAIRequest.route, 'rcc-openai-entry:openai-route');
  assert.equal(anthropicRequest.route, 'goaichat:goaichat-route');
  assert.equal(responses.encodeStop(stopRequest(), ccBinding, 'cc-route').type, 'responses.cancel');
  assert.equal(openai.encodeStop(stopRequest(), openAIBinding, 'openai-route').type, 'openai.cancel');
  assert.equal(anthropic.encodeStop(stopRequest(), goaichatBinding, 'goaichat-route').type, 'anthropic.cancel');
  assert.equal(Object.is(responsesRequest, openAIRequest), false);
  assert.equal(Object.is(openAIRequest, anthropicRequest), false);
});

test('openai chat codec maps text, tool calls, finish reason, and error events', async () => {
  const codec = new OpenAIChatProviderCodec();
  const context = codecContext();

  const text = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-1',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
  }, context);
  assert.equal(text.events[0].kind, 'output');
  assert.equal(text.events[0].summary, 'hello');

  const tool = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-1',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"x"}' },
        }],
      },
      finish_reason: null,
    }],
  }, context);
  assert.equal(tool.events[0].kind, 'tool');
  assert.equal(tool.events[0].summary, 'lookup');

  const terminal = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-1',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }, context);
  assert.equal(terminal.events[0].kind, 'terminal');
  assert.equal(terminal.events[0].terminalState, 'succeeded');

  const error = await codec.decodeEvent({
    protocol: 'openai',
    type: 'error',
    error: { code: 'server_error', message: 'provider exploded' },
  }, context);
  assert.equal(error.events[0].kind, 'error');
  assert.equal(error.events[0].error?.code, 'server_error');
  assert.equal(error.events[1].terminalState, 'failed');
});

test('openai chat codec blocks content_filter and unsupported finish reasons', async () => {
  const codec = new OpenAIChatProviderCodec();
  const context = codecContext();

  const filtered = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-filtered',
    choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
  }, context);
  assert.deepEqual(filtered.events.map((event) => event.kind), ['error', 'terminal']);
  assert.equal(filtered.events[1].terminalState, 'blocked');
  assert.equal(filtered.events[0].error?.code, 'openai.finish_reason.content_filter');
  assert.equal(filtered.events[0].error?.retryable, 'manual');
  assert.equal(filtered.events[0].nextAction?.kind, 'recover');

  const unsupported = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-unsupported',
    choices: [{ index: 0, delta: {}, finish_reason: 'surprise_stop' }],
  }, context);
  assert.deepEqual(unsupported.events.map((event) => event.kind), ['error', 'terminal']);
  assert.equal(unsupported.events[1].terminalState, 'blocked');
  assert.equal(unsupported.events[0].error?.code, 'openai.finish_reason.unsupported');

  const toolCall = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-tool-call',
    choices: [{ index: 0, delta: {}, finish_reason: 'function_call' }],
  }, context);
  assert.equal(toolCall.events[0].kind, 'terminal');
  assert.equal(toolCall.events[0].terminalState, 'waiting');
});

test('openai chat codec keeps checkpoint control truth off business payload', () => {
  const openai = new OpenAIChatProviderCodec();
  const request = openai.encodeResume(resumeInput(), openAIBinding, 'openai-route');
  const serializedMessages = JSON.stringify(request.messages);

  assert.equal(serializedMessages.includes('cp-provider'), false);
  assert.equal(serializedMessages.includes('checkpoint'), false);
  assert.equal(request.checkpointId?.value, 'cp-provider');
  assert.equal(request.execution.executionEpoch, 1);
});

test('openai chat codec accepts a legal usage-only chunk with empty choices', async () => {
  const codec = new OpenAIChatProviderCodec();
  const decodeContext = codecContext();
  const decoded = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-usage',
    object: 'chat.completion.chunk',
    choices: [],
  }, decodeContext);
  assert.deepEqual(decoded.events, []);
});

test('provider adapter binds openai chat as an explicit route', async () => {
  const openai = openAIAdapter(makeTransport(openAIBinding), openAIBinding);

  assert.equal((await openai.probe(openAIBinding)).state, 'ready');
  await assert.rejects(() => openai.probe(ccBinding), /binding identity/);
});

test('responses codec maps terminal, tool, and error wire events', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();

  const completed = await codec.decodeEvent({ protocol: 'responses', type: 'response.completed', response: { id: 'response-1' } }, context);
  assert.equal(completed.events[0].kind, 'terminal');
  assert.equal(completed.events[0].terminalState, 'succeeded');

  await codec.decodeEvent({ protocol: 'responses', type: 'response.created', response: { id: 'response-tool' } }, context);
  const tool = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'file.read', arguments: '{"path":"README.md"}' },
  }, context);
  assert.equal(tool.events[0].kind, 'tool');
  assert.deepEqual(tool.events[0].toolCall, {
    callId: 'call-1',
    toolId: 'file.read',
    arguments: { path: 'README.md' },
    continuationRef: 'response-tool',
  });
  const waiting = await codec.decodeEvent({ protocol: 'responses', type: 'response.completed', response: { id: 'response-tool' } }, context);
  assert.equal(waiting.events[0].terminalState, 'waiting');
  assert.equal(waiting.events[0].nextAction?.ref, 'responses-tool-call');

  const error = await codec.decodeEvent({ protocol: 'responses', type: 'error', error: { code: 'wire.error', message: 'boom' } }, context);
  assert.equal(error.events[0].kind, 'error');
  assert.equal(error.events[0].error?.code, 'wire.error');
});

test('responses codec keeps tool control typed and encodes a call-bound continuation', () => {
  const codec = new ResponsesProviderCodec();
  const tools = [{ toolId: 'file.read', description: 'read one file', inputSchema: { type: 'object' } }];
  const started = codec.encodeStart(startInput({ tools }), ccBinding, 'cc-route');
  assert.deepEqual(started.tools, [{ type: 'function', name: 'file_read', description: 'read one file', parameters: { type: 'object' } }]);
  assert.equal(JSON.stringify(started.input).includes('file.read'), false);

  const continued = codec.encodeSubmit(submitInput({
    tools,
    toolContinuations: [{
      callId: 'call-1',
      toolId: 'file.read',
      arguments: { path: 'README.md' },
      continuationRef: 'response-1',
      output: JSON.stringify({ path: 'README.md', content: 'REAL_FILE_CONTENT' }),
    }],
  }), ccBinding, 'cc-route');
  assert.deepEqual(continued.input, [
    { type: 'message', role: 'user', content: JSON.stringify(submitInput().payload) },
    { type: 'function_call', call_id: 'call-1', name: 'file_read', arguments: JSON.stringify({ path: 'README.md' }) },
    { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ path: 'README.md', content: 'REAL_FILE_CONTENT' }) },
  ]);
});

test('responses reasoning output item remains model evidence and does not become user-visible output text', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const decoded = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'reasoning', id: 'reasoning-1', summary: [] },
  } as unknown as ProviderWireEvent, context);
  assert.equal(decoded.events[0].kind, 'model');
  assert.equal(decoded.events[0].summary, undefined);
});

test('responses codec maps reasoning summary wire events as model evidence', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const events: readonly ProviderWireEvent[] = [
    {
      protocol: 'responses',
      type: 'response.reasoning_summary_part.added',
      item_id: 'item-1',
      output_index: 0,
      content_index: 0,
      part: { type: 'reasoning_summary', summary: [{ type: 'summary_text', text: 'part added' }] },
    },
    {
      protocol: 'responses',
      type: 'response.reasoning_summary_part.delta',
      item_id: 'item-1',
      output_index: 0,
      content_index: 0,
      delta: { type: 'reasoning_summary_text', text: 'part delta' },
    },
    {
      protocol: 'responses',
      type: 'response.reasoning_summary_part.done',
      item_id: 'item-1',
      output_index: 0,
      content_index: 0,
      part: { type: 'reasoning_summary', summary: [{ type: 'summary_text', text: 'part done' }] },
    },
    {
      protocol: 'responses',
      type: 'response.reasoning_summary_text.delta',
      item_id: 'item-1',
      output_index: 0,
      content_index: 0,
      delta: 'text delta',
    },
    {
      protocol: 'responses',
      type: 'response.reasoning_summary_text.done',
      item_id: 'item-1',
      output_index: 0,
      content_index: 0,
      text: 'text done',
    },
    {
      protocol: 'responses',
      type: 'response.reasoning_summary_part.added',
      item_id: 'item-empty',
      output_index: 1,
      content_index: 0,
      part: { type: 'reasoning_summary', summary: [] },
    },
    {
      protocol: 'responses',
      type: 'response.reasoning_summary_part.delta',
      item_id: 'item-empty',
      output_index: 1,
      content_index: 0,
      delta: { type: 'reasoning_summary_text', text: '' },
    },
    {
      protocol: 'responses',
      type: 'response.reasoning_summary_part.done',
      item_id: 'item-empty',
      output_index: 1,
      content_index: 0,
      part: { type: 'reasoning_summary', summary: [] },
    },
  ];
  for (const event of events) {
    const decoded = await codec.decodeEvent(event, context);
    assert.equal(decoded.events.length, 1);
    assert.equal(decoded.events[0].kind, 'model');
    assert.equal(decoded.events[0].summary, undefined);
    assert.equal(decoded.events[0].evidenceRefs.length, 1);
  }
});

test('responses codec accepts RCC transparent-proxy events with empty response and message ids', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();

  const created = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.created',
    response: { id: '' },
  }, context);
  const output = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
  } as unknown as ProviderWireEvent, context);
  const completed = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.completed',
    response: { id: '' },
  }, context);

  assert.equal(created.events[0].kind, 'model');
  assert.equal(output.events[0].kind, 'output');
  assert.equal(output.events[0].summary, 'OK');
  assert.equal(completed.events[0].terminalState, 'succeeded');
});

test('responses codec emits each output item text exactly once across delta and completion events', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const events = [
    {
      protocol: 'responses' as const,
      type: 'response.output_item.added' as const,
      output_index: 0,
      item: { type: 'message' as const, id: 'item-1', role: 'assistant' as const, content: [] },
    },
    { protocol: 'responses' as const, type: 'response.content_part.added' as const, item_id: 'item-1', output_index: 0, content_index: 0, part: { type: 'output_text' as const, text: '' } },
    { protocol: 'responses' as const, type: 'response.output_text.delta' as const, item_id: 'item-1', delta: 'hello ' },
    { protocol: 'responses' as const, type: 'response.output_text.delta' as const, item_id: 'item-1', delta: 'world' },
    { protocol: 'responses' as const, type: 'response.output_text.done' as const, item_id: 'item-1', text: 'hello world' },
    { protocol: 'responses' as const, type: 'response.content_part.done' as const, item_id: 'item-1', output_index: 0, content_index: 0, part: { type: 'output_text' as const, text: 'hello world' } },
    { protocol: 'responses' as const, type: 'response.output_item.done' as const, output_index: 0, item: { type: 'message' as const, id: 'item-1', role: 'assistant' as const, content: [{ type: 'output_text' as const, text: 'hello world' }] } },
  ];
  const summaries: string[] = [];
  for (const event of events) {
    const decoded = await codec.decodeEvent(event, context);
    const summary = decoded.events[0]?.summary;
    if (summary) summaries.push(summary);
  }
  assert.deepEqual(summaries, ['hello ', 'world']);
  assert.equal(summaries.join(''), 'hello world');
});

test('responses and anthropic resume codecs keep checkpoint control truth off business payload', () => {
  const responses = new ResponsesProviderCodec();
  const anthropic = new AnthropicProviderCodec(4096);

  const responsesResume = responses.encodeResume(resumeInput(), ccBinding, 'cc-route');
  const anthropicResume = anthropic.encodeResume(resumeInput(), goaichatBinding, 'goaichat-route');

  const responsesInput = responsesResume.input[0];
  assert.equal(responsesInput.type, 'message');
  const responsesContent = responsesInput.type === 'message' ? responsesInput.content : '';
  assert.equal(responsesContent.includes('cp-provider'), false);
  assert.equal(responsesContent.includes('checkpoint'), false);
  assert.equal(responsesResume.checkpointId?.value, 'cp-provider');
  assert.equal(responsesResume.execution.executionEpoch, 1);

  const anthropicContent = anthropicResume.messages[0].content[0];
  assert.equal(anthropicContent.type, 'text');
  const anthropicText = anthropicContent.type === 'text' ? anthropicContent.text : '';
  assert.equal(anthropicText.includes('cp-provider'), false);
  assert.equal(anthropicText.includes('checkpoint'), false);
  assert.equal(anthropicResume.checkpointId?.value, 'cp-provider');
  assert.equal(anthropicResume.execution.executionEpoch, 1);
});

test('responses wire shape uses nested response id and real tool parameters', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();

  const created = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.created',
    response: { id: 'response-1', model: 'model-cc' },
  }, context);
  assert.match(created.events[0].eventId, /^event-response\.created/);

  const toolSchema: ResponsesWireTool = {
    type: 'function',
    name: 'lookup',
    description: 'lookup a value',
    parameters: { type: 'object', properties: { key: { type: 'string' } } },
  };
  assert.deepEqual(toolSchema.parameters.properties, { key: { type: 'string' } });
});

test('anthropic codec maps terminal, tool, and error wire events', async () => {
  const codec = new AnthropicProviderCodec(4096);
  const context = codecContext();

  await codec.decodeEvent({ protocol: 'anthropic', type: 'message_delta', delta: { stop_reason: 'end_turn' } }, context);
  const completed = await codec.decodeEvent({ protocol: 'anthropic', type: 'message_stop' }, context);
  assert.equal(completed.events[0].kind, 'terminal');
  assert.equal(completed.events[0].terminalState, 'succeeded');

  const tool = await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
  }, context);
  assert.equal(tool.events[0].kind, 'tool');

  const error = await codec.decodeEvent({ protocol: 'anthropic', type: 'error', error: { type: 'wire_error', message: 'boom' } }, context);
  assert.equal(error.events[0].kind, 'error');
  assert.equal(error.events[0].error?.code, 'wire_error');
});

test('anthropic codec accepts legal empty content fields and maps stop_reason', async () => {
  const codec = new AnthropicProviderCodec(4096);
  const context = codecContext();

  await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }, context);
  await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'thinking', thinking: '' },
  } as unknown as ProviderWireEvent, context);
  await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '' },
  }, context);

  await codec.decodeEvent({ protocol: 'anthropic', type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, context);
  const incomplete = await codec.decodeEvent({ protocol: 'anthropic', type: 'message_stop' }, context);
  assert.equal(incomplete.events[0].terminalState, 'waiting');

  await codec.decodeEvent({ protocol: 'anthropic', type: 'message_delta', delta: { stop_reason: 'end_turn' } }, context);
  const completed = await codec.decodeEvent({ protocol: 'anthropic', type: 'message_stop' }, context);
  assert.equal(completed.events[0].terminalState, 'succeeded');
});

test('codec evidence refs preserve provider wire content digests instead of fake wire refs', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();

  const delta = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_text.delta',
    item_id: 'item-1',
    delta: 'hello',
  }, context);
  assert.equal(delta.events[0].outputRefs?.[0].startsWith('wire://'), false);
  assert.equal(typeof delta.events[0].evidenceRefs[0].digest, 'string');

  await codec.decodeEvent({ protocol: 'responses', type: 'response.created', response: { id: 'response-tool-evidence' } }, context);
  const tool = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' },
  }, context);
  assert.equal(tool.events[0].outputRefs?.[0].startsWith('wire://'), false);
  assert.equal(typeof tool.events[0].evidenceRefs[0].digest, 'string');
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
    { protocol: 'responses', type: 'response.created', response: { id: 'response-1', model: 'model-cc' } },
    { protocol: 'responses', type: 'response.output_text.delta', item_id: 'item-1', delta: 'hello' },
    { protocol: 'responses', type: 'response.completed', response: { id: 'response-1' } },
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

test('provider adapter fences full active execution identity and refuses mismatched operations', async () => {
  const transport = makeTransport(ccBinding, {
    observe: async function* () {
      yield { protocol: 'responses', type: 'response.output_text.delta', item_id: 'item-1', delta: 'x' };
    },
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await adapter.start(startInput());
  await assert.rejects(() => adapter.submit(submitInput({ executionEpoch: 2 })), /identity/);
  await assert.rejects(() => adapter.requestStop(stopRequest({ operationId: id('operation', 'operation-b') })), /identity/);
  await assert.rejects(() => adapter.settle({ ...execution(), taskId: id('task', 'task-b') }), /identity/);
  for await (const _event of adapter.observe(execution())) void _event;
});

test('provider adapter keeps active execution until settlement is final', async () => {
  const waiting = settlement({
    state: 'waiting',
    ownerId: 'humanagent.provider-adapter',
    nextAction: { kind: 'wait', ref: 'condition-a' },
    resourceRelease: { state: 'pending', evidenceRefs: [evidence('resource-pending')] },
    persistence: { state: 'pending', evidenceRefs: [evidence('persistence-pending')] },
  });
  const transport = makeTransport(ccBinding, {
    observe: async function* () {
      yield { protocol: 'responses', type: 'response.output_text.delta', item_id: 'item-1', delta: 'x' };
    },
    settle: async () => waiting,
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await adapter.start(startInput());
  const settled = await adapter.settle(execution());
  assert.equal(settled.state, 'waiting');

  const observed: ProviderEvent[] = [];
  for await (const event of adapter.observe(execution())) observed.push(event);
  assert.ok(observed.length > 0);
});

test('provider adapter rejects expired readiness/capability evidence and mismatched close receipts', async () => {
  const expiredReadiness = responsesAdapter(makeTransport(ccBinding, {
    readiness: { ...readiness(ccBinding), expiresAt: '2000-01-01T00:00:00Z' },
  }), ccBinding);
  await assert.rejects(() => expiredReadiness.probe(ccBinding), /expired/);

  const expiredCapabilities = responsesAdapter(makeTransport(ccBinding, {
    capabilities: { ...capabilities(ccBinding), expiresAt: '2000-01-01T00:00:00Z' },
  }), ccBinding);
  await assert.rejects(() => expiredCapabilities.capabilities(ccBinding), /expired/);

  const badClose = responsesAdapter(makeTransport(ccBinding, {
    close: async () => closeResult(ccSolBinding),
  }), ccBinding);
  await assert.rejects(() => badClose.close(ccBinding), /binding identity/);
});

test('provider adapter maps transport exceptions to typed provider errors with cause', async () => {
  const transport = makeTransport(ccBinding, {
    start: async () => {
      throw new Error('network down');
    },
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await assert.rejects(() => adapter.start(startInput()), (error) => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.equal(error.providerError.phase, 'start');
    assert.equal(error.providerError.ownerId, 'humanagent.provider-adapter');
    assert.equal(error.providerError.nextAction.ref, 'humanagent.provider-adapter');
    assert.equal((error as Error & { cause?: Error }).cause?.message, 'network down');
    return true;
  });
});

test('provider adapter binds immutable execution snapshots across epochs', async () => {
  const transport = makeTransport(ccBinding, {
    start: async (input) => startReceipt(ccBinding, input),
    observe: async function* () {
      yield { protocol: 'responses', type: 'response.created', response: { id: 'response-old' } };
    },
    settle: async (input) => settlement({}, input),
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await adapter.start(startInput({ executionEpoch: 1 }));
  await adapter.start(startInput({ executionEpoch: 2 }));

  const observed: ProviderEvent[] = [];
  for await (const event of adapter.observe(startInput({ executionEpoch: 1 }))) observed.push(event);
  assert.equal(observed[0].executionEpoch, 1);

  await adapter.settle(startInput({ executionEpoch: 1 }));
  const settledNew = await adapter.settle(startInput({ executionEpoch: 2 }));
  assert.equal(settledNew.executionEpoch, 2);
});

test('provider adapter rejects close while settlement is pending and allows recovery before close', async () => {
  const waiting = settlement({
    state: 'waiting',
    ownerId: 'humanagent.provider-adapter',
    nextAction: { kind: 'wait', ref: 'condition-a' },
    resourceRelease: { state: 'pending', evidenceRefs: [evidence('resource-pending')] },
    persistence: { state: 'pending', evidenceRefs: [evidence('persistence-pending')] },
  });
  let settleCalls = 0;
  const transport = makeTransport(ccBinding, {
    settle: async (input) => {
      settleCalls += 1;
      return settleCalls === 1 ? waiting : settlement({}, input);
    },
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await adapter.start(startInput());
  await adapter.settle(execution());
  await assert.rejects(() => adapter.close(ccBinding), /active executions/);

  await adapter.settle(execution());
  assert.equal((await adapter.close(ccBinding)).state, 'closed');
});

test('provider adapter wraps ContractError validation failures with typed provider errors and cause', async () => {
  const transport = makeTransport(ccBinding, {
    resume: async () => ({ ...recoveryResult(), recovered: true, staleRejected: true }),
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await assert.rejects(() => adapter.resume(resumeInput()), (error) => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.equal(error.providerError.phase, 'resume');
    assert.ok((error as Error & { cause?: unknown }).cause instanceof ContractError);
    return true;
  });
});

test('provider adapter preserves structured non-Error transport rejection cause', async () => {
  const transport = makeTransport(ccBinding, {
    start: async () => {
      throw { code: 'wire.reject', detail: 'x' };
    },
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await assert.rejects(() => adapter.start(startInput()), (error) => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.deepEqual((error as Error & { cause?: unknown }).cause, { code: 'wire.reject', detail: 'x' });
    return true;
  });
});

test('provider adapter verifies resume checkpoint and recovery evidence scope', async () => {
  const checkpointMismatch = responsesAdapter(makeTransport(ccBinding, {
    resume: async () => ({ ...recoveryResult(), checkpointId: id('checkpoint', 'cp-other') }),
  }), ccBinding);
  await assert.rejects(() => checkpointMismatch.resume(resumeInput()), (error) => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.equal(error.providerError.code, 'resume.checkpoint.mismatch');
    return true;
  });

  const badRecoveryScope = responsesAdapter(makeTransport(ccBinding, {
    resume: async () => ({
      ...recoveryResult(),
      recoveryStateRef: { ...evidence('recovery-state'), scope: { ...operationScope, taskId: id('task', 'task-b') } },
    }),
  }), ccBinding);
  await assert.rejects(() => badRecoveryScope.resume(resumeInput()), (error) => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.match(error.providerError.message, /recovery state/);
    return true;
  });
});

test('codecs consume legal wire events and preserve real error fields', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();

  const part = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.content_part.added',
    item_id: 'item-1',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: 'part' },
  }, context);
  assert.equal(part.events[0].kind, 'output');

  const done = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_text.done',
    item_id: 'item-1',
    output_index: 0,
    content_index: 0,
    text: 'done',
  }, context);
  assert.equal(done.events[0].kind, 'output');

  const partDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.content_part.done',
    item_id: 'item-1',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: 'part-done' },
  }, context);
  assert.equal(partDone.events[0].kind, 'output');
  assert.equal(partDone.events[0].evidenceRefs.length, 1);

  const itemDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'message', id: 'item-1', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
  }, context);
  assert.equal(itemDone.events[0].kind, 'output');
  assert.equal(itemDone.events[0].evidenceRefs.length, 1);

  const argsDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.function_call_arguments.done',
    item_id: 'item-1',
    arguments: '{"q":"x"}',
  }, context);
  assert.equal(argsDone.events[0].kind, 'output');
  assert.equal(argsDone.events[0].outputRefs?.length, 1);

  const incomplete = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.incomplete',
    response: { id: 'response-1', incomplete_details: { reason: 'max_output_tokens' } },
  }, context);
  assert.equal(incomplete.events[0].terminalState, 'waiting');

  const failed = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.failed',
    response: { id: 'response-1', error: { code: 'server_error', message: 'boom', param: 'model' } },
  }, context);
  assert.equal(failed.events[0].error?.code, 'server_error');

  const anthropic = new AnthropicProviderCodec(4096);
  const anthropicContext = codecContext();
  const ping = await anthropic.decodeEvent({ protocol: 'anthropic', type: 'ping' }, anthropicContext);
  assert.equal(ping.events[0].kind, 'model');
});

test('codec evidence refs remain readable through the injected content sink', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();

  const delta = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_text.delta',
    item_id: 'item-1',
    delta: 'hello',
  }, context);
  assert.equal(new TextDecoder().decode(await context.sink.read(delta.events[0].evidenceRefs[0])), 'hello');
  assert.equal(delta.events[0].outputRefs?.[0].startsWith('wire://'), false);
});

test('filesystem provider evidence sink writes immutable readable content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-evidence-'));
  const store = new ImmutableAssetStore(root);
  const sink = filesystemProviderEvidenceSink(store);

  const ref = await sink.write({
    scope: operationScope,
    kind: 'execution',
    type: 'response.output_text.delta',
    locator: 'text/item-1',
    content: 'hello',
  });
  assert.equal(new TextDecoder().decode(await store.readEvidence(ref)), 'hello');
});

test('protocol mismatch, missing readiness evidence, unknown event, and missing fields fail explicitly', async () => {
  assert.throws(
    () => new ProviderAdapter({ binding: goaichatBinding, routeRef: 'goaichat-route', codec: new ResponsesProviderCodec(), transport: makeTransport(goaichatBinding), evidence: memoryEvidenceSink() }),
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
    observe: async function* () { yield { protocol: 'responses', type: 'response.completed', response: {} } as unknown as ProviderWireEvent; },
  }), ccBinding);
  await missingFieldAdapter.start(startInput());
  await assert.rejects(async () => {
    for await (const _event of missingFieldAdapter.observe(execution())) void _event;
  }, /missing id/);

  const noActiveExecution = responsesAdapter(makeTransport(ccBinding), ccBinding);
  await assert.rejects(async () => {
    for await (const _event of noActiveExecution.observe(execution())) void _event;
  }, /active execution/);
});

test('provider adapter source avoids dsh/rcc/sdk imports, network calls, and secret patterns', async () => {
  const files = ['adapter.ts', 'codecs.ts', 'errors.ts', 'evidence.ts', 'index.ts', 'wire.ts'];
  const forbidden = [
    /[\s('"]dsh/i,
    /[\s('"]rcc/i,
    /routecodex/i,
    /@openai|openai-sdk|from\s+['"]openai['"]|import\s*\(\s*['"]openai['"]/i,
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

test('responses codec accepts the live provider function_call item shape without a provider item id', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  await codec.decodeEvent({ protocol: 'responses', type: 'response.created', response: { id: 'response-real-tool' } }, context);

  const added = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', call_id: 'toolu_01FMxC9BbAnqkdbSQmQf0LvZ', name: 'file_read', arguments: '' },
  }, context);
  assert.equal(added.events[0].kind, 'model');

  const done = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'function_call', call_id: 'toolu_01FMxC9BbAnqkdbSQmQf0LvZ', name: 'file_read', arguments: '{"path":"README.md"}' },
  }, context);
  assert.equal(done.events[0].kind, 'tool');
  assert.deepEqual(done.events[0].toolCall, {
    callId: 'toolu_01FMxC9BbAnqkdbSQmQf0LvZ',
    toolId: 'file.read',
    arguments: { path: 'README.md' },
    continuationRef: 'response-real-tool',
  });
});

test('responses codec accepts the live function_call_arguments.done shape without an item_id', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const done = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.function_call_arguments.done',
    call_id: 'toolu_01J4J0xby0cnLcieuGiDku1c',
    output_index: 0,
    arguments: '{"path":"README.md"}',
  }, context);
  assert.equal(done.events[0].kind, 'output');
});

test('responses codec still rejects a function_call_arguments.done without any call identity', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  await assert.rejects(
    () => codec.decodeEvent({
      protocol: 'responses',
      type: 'response.function_call_arguments.done',
      output_index: 0,
      arguments: '{"path":"README.md"}',
    }, context),
    /missing item_id or call_id/,
  );
});
