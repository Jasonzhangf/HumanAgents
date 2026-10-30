import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImmutableAssetStore } from '../../../packages/adapters/filesystem/src/index.js';
import {
  ContractError,
  id,
  validateProviderEvent,
  type EvidenceRef,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderReadiness,
  type ProviderRawFact,
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
  type DecodeContext,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type ProviderTransport,
  type ProviderWireEvent,
  type ResponsesWireTool,
} from '../../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../../packages/adapters/provider/src/evidence.js';

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

function codecContext(overrides: Partial<DecodeContext> = {}) {
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
    responsesRequestStartEmitted: new Map<string, boolean>(),
    responsesStreamRound: { count: 0 },
    nextEventId: (type: string, locator: string) => `event-${type}-${locator.replace(/[^A-Za-z0-9._-]/g, '-')}-${++sequence}`,
    ...overrides,
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
  assert.equal(tool.events[0].summary, '调用工具：lookup');

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
  assert.equal(tool.events[0].summary, '调用工具：file.read');
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

test('responses codec keeps an extra provider model round out of the request terminal output', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const facts: ProviderRawFact[] = [];
  const decode = async (raw: Record<string, unknown>) => {
    const decoded = await codec.decodeEvent({ protocol: 'responses', ...raw } as never, context);
    facts.push(...decoded.rawFacts);
    return decoded;
  };
  // One RCC v3 request can open a second model round inside the same response
  // stream: the second round answers an instruction the client never sent, so
  // its text must stay out of the request terminal output instead of being
  // appended to the answer of the round the request actually asked for.
  await decode({ type: 'response.created', response: { id: 'round-1' } });
  await decode({
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'message', id: 'item-answer', role: 'assistant', content: [{ type: 'output_text', text: '{"kind":"answer","answer":"6"}' }] },
  });
  const secondRound = await decode({ type: 'response.created', response: { id: 'round-1' } });
  assert.match(String(secondRound.events.at(-1)?.summary), /additional response round/);
  const continuation = await decode({
    type: 'response.output_item.done',
    output_index: 1,
    item: { type: 'message', id: 'item-continuation', role: 'assistant', content: [{ type: 'output_text', text: '{"kind":"answer","answer":"no work"}' }] },
  });
  const completed = await decode({ type: 'response.completed', response: { id: 'round-1' } });
  assert.equal(completed.events.at(-1)?.terminalState, 'succeeded');
  // The extra round is still recorded: its item stays readable as evidence and
  // the output event still names it. Only the terminal output stays on round one.
  assert.equal(continuation.events.length, 1);
  assert.equal(continuation.events[0].evidenceRefs.length, 1);
  assert.deepEqual(facts.filter((fact) => fact.kind === 'content').map((fact) => fact.contentUnitId), ['responses:assistant-text:item-answer']);
  // The request outcome still lands on the terminal event of the extra round.
  assert.equal(facts.some((fact) => fact.kind === 'request-complete'), true);
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

test('responses codec declares the Harness tool surface and keeps tool-less requests instruction-free', () => {
  const codec = new ResponsesProviderCodec();
  const tools = [
    { toolId: 'file.read', description: 'read one file', inputSchema: { type: 'object' } },
    { toolId: 'web.search', description: 'search the web', inputSchema: { type: 'object' } },
  ];
  const withTools = codec.encodeStart(startInput({ tools }), ccBinding, 'cc-route');
  assert.match(withTools.instructions, /This Harness owns tool execution/);
  assert.match(withTools.instructions, /exec_command/);
  assert.match(withTools.instructions, /Only these function tools can be called: file_read, web_search\./);

  const withoutTools = codec.encodeStart(startInput(), ccBinding, 'cc-route');
  assert.equal(withoutTools.instructions, '');

  const continued = codec.encodeSubmit(submitInput({
    tools,
    toolContinuations: [{
      callId: 'call-1',
      toolId: 'web.search',
      arguments: { query: 'tokio' },
      continuationRef: 'response-1',
      output: 'web.search failed',
    }],
  }), ccBinding, 'cc-route');
  assert.match(continued.instructions, /Only these function tools can be called: file_read, web_search\./);
});

test('responses codec marks request starts once per response id regardless of lifecycle order', async () => {
  const codec = new ResponsesProviderCodec();
  const createdFirst = codecContext();
  const inProgressFirst = codecContext();

  const first = await codec.decodeEvent(
    { protocol: 'responses', type: 'response.created', response: { id: 'request-start-1' } },
    createdFirst,
  );
  const duplicateInProgress = await codec.decodeEvent(
    { protocol: 'responses', type: 'response.in_progress', response: { id: 'request-start-1' } },
    createdFirst,
  );
  assert.deepEqual(first.events.map((event) => event.summary), ['provider requested model work']);
  assert.deepEqual(duplicateInProgress.events, []);

  // A second `response.created` inside one stream opens another model round, so
  // it is reported as such instead of being folded into the first round.
  const secondRound = await codec.decodeEvent(
    { protocol: 'responses', type: 'response.created', response: { id: 'request-start-2' } },
    createdFirst,
  );
  assert.match(String(secondRound.events[0]?.summary), /additional response round/);
  const laterRoundInProgress = await codec.decodeEvent(
    { protocol: 'responses', type: 'response.in_progress', response: { id: 'request-start-2' } },
    createdFirst,
  );
  assert.deepEqual(laterRoundInProgress.events, []);
  const inProgress = await codec.decodeEvent(
    { protocol: 'responses', type: 'response.in_progress', response: { id: 'request-start-3' } },
    inProgressFirst,
  );
  const duplicateCreated = await codec.decodeEvent(
    { protocol: 'responses', type: 'response.created', response: { id: 'request-start-3' } },
    inProgressFirst,
  );
  assert.deepEqual(inProgress.events.map((event) => event.summary), ['provider requested model work']);
  assert.deepEqual(duplicateCreated.events, []);

  await assert.rejects(
    () => codec.decodeEvent(
      { protocol: 'responses', type: 'response.created', response: { id: 'missing-map' } },
      codecContext({ responsesRequestStartEmitted: undefined }) as DecodeContext,
    ),
    /Cannot read propert|get/,
  );
});

test('responses reasoning output item remains model evidence and does not become user-visible output text', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'reasoning-1', summary: [] },
  } as unknown as ProviderWireEvent, context);
  const decoded = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'reasoning', id: 'reasoning-1', summary: [] },
  } as unknown as ProviderWireEvent, context);
  assert.equal(decoded.events[0].kind, 'model');
  assert.equal(decoded.events[0].summary, 'provider prepared model output');
});

test('responses codec maps reasoning summary wire events as model evidence', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const events: readonly ProviderWireEvent[] = [
    {
      protocol: 'responses',
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'item-1', summary: [] },
    },
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
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'item-1', summary: [] },
    },
    {
      protocol: 'responses',
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'reasoning', id: 'item-empty', summary: [] },
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
    assert.match(decoded.events[0].summary ?? '', /^provider (prepared|provided) model /);
    assert.equal(decoded.events[0].evidenceRefs.length, 1);
  }
});

test('responses codec gives every visible model event a semantic summary', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();

  const created = await codec.decodeEvent({ protocol: 'responses', type: 'response.created', response: { id: 'response-semantic-1' } }, context);
  assert.equal(created.events[0].summary, 'provider requested model work');

  const inProgress = await codec.decodeEvent({ protocol: 'responses', type: 'response.in_progress', response: { id: 'response-semantic-2' } }, context);
  assert.equal(inProgress.events[0].summary, 'provider requested model work');

  const outputAdded = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'reasoning-semantic' },
  } as unknown as ProviderWireEvent, context);
  assert.equal(outputAdded.events[0].summary, 'provider prepared model output');

  const functionArgsDelta = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.function_call_arguments.delta',
    call_id: 'call-semantic',
    delta: '{"path":',
  }, context);
  assert.equal(functionArgsDelta.events[0].summary, 'provider completed tool request details');

  const functionArgsDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.function_call_arguments.done',
    call_id: 'call-semantic',
    arguments: '{"path":"README.md"}',
  }, context);
  assert.equal(functionArgsDone.events[0].kind, 'output');
  assert.equal(functionArgsDone.events[0].outputRefs?.length, 1);
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
    if (decoded.events[0]?.kind === 'output' && decoded.events[0].summary) summaries.push(decoded.events[0].summary);
  }
  assert.deepEqual(summaries, ['hello ', 'world']);
  assert.equal(summaries.join(''), 'hello world');
});

test('responses codec projects live reasoning_text parts as model events without aborting the stream', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  // Exact shape captured from the live RCC 4444 responses stream: a reasoning
  // content part interleaved before the assistant output message.
  const reasoningAdded = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.content_part.added',
    item_id: 'reason-1',
    output_index: 0,
    content_index: 0,
    part: { type: 'reasoning_text', text: '' },
  } as unknown as ProviderWireEvent, context);
  const reasoningDelta = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.reasoning_text.delta',
    item_id: 'reason-1',
    output_index: 0,
    content_index: 0,
    delta: 'The user wants me to reply with exactly "OK".',
  } as unknown as ProviderWireEvent, context);
  const reasoningDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.reasoning_text.done',
    item_id: 'reason-1',
    output_index: 0,
    content_index: 0,
    text: 'The user wants me to reply with exactly "OK".',
  } as unknown as ProviderWireEvent, context);
  const reasoningPartDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.content_part.done',
    item_id: 'reason-1',
    output_index: 0,
    content_index: 0,
    part: { type: 'reasoning_text', text: 'The user wants me to reply with exactly "OK".' },
  } as unknown as ProviderWireEvent, context);
  const outputPartAdded = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.content_part.added',
    item_id: 'item-1',
    output_index: 1,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  } as unknown as ProviderWireEvent, context);
  const outputText = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_text.delta',
    item_id: 'item-1',
    delta: 'OK',
  } as unknown as ProviderWireEvent, context);

  assert.equal(reasoningAdded.events[0].kind, 'model');
  assert.equal(reasoningAdded.events[0].summary, 'provider provided model reasoning');
  assert.equal(reasoningDelta.events[0].kind, 'model');
  assert.equal(reasoningDone.events[0].kind, 'model');
  assert.equal(reasoningPartDone.events[0].kind, 'model');
  // Reasoning text must never leak into business output.
  assert.equal(outputPartAdded.events[0].kind, 'output');
  assert.equal(outputPartAdded.events[0].summary, undefined);
  assert.equal(outputText.events[0].kind, 'output');
  assert.equal(outputText.events[0].summary, 'OK');
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

test('provider adapter keeps response-reported model evidence distinct from the request model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-attribution-'));
  try {
    const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(root));
    let requestedModel: string | undefined;
    const transport = makeTransport(ccBinding, {
      start: async (_input, request) => {
        requestedModel = request.model;
        return startReceipt(ccBinding);
      },
      observe: async function* () {
        yield { protocol: 'responses', type: 'response.created', response: { id: 'response-observed', model: 'model-observed' } };
        yield { protocol: 'responses', type: 'response.in_progress', response: { id: 'response-model-unconfirmed' } };
      },
    });
    const adapter = new ProviderAdapter({
      binding: ccBinding,
      routeRef: 'cc-route',
      codec: new ResponsesProviderCodec(),
      transport,
      evidence: sink,
    });

    await adapter.start(startInput());
    const observed: ProviderEvent[] = [];
    for await (const event of adapter.observe(execution())) observed.push(event);

    assert.equal(requestedModel, 'model-cc');
    const reported = observed.find((event) => event.externalResponseId === 'response-observed');
    const unconfirmed = observed.find((event) => event.externalResponseId === 'response-model-unconfirmed');
    assert.ok(reported);
    assert.ok(unconfirmed);

    const reportedContent = JSON.parse(new TextDecoder().decode(await sink.read(reported.evidenceRefs[0]))) as Record<string, unknown>;
    assert.deepEqual(reportedContent, { id: 'response-observed', model: 'model-observed' });
    assert.notEqual(reportedContent.model, requestedModel);
    assert.deepEqual(reported.evidenceRefs[0].scope, operationScope);

    const unconfirmedContent = JSON.parse(new TextDecoder().decode(await sink.read(unconfirmed.evidenceRefs[0]))) as Record<string, unknown>;
    assert.deepEqual(unconfirmedContent, { id: 'response-model-unconfirmed' });
    assert.equal('model' in unconfirmedContent, false);
    assert.notEqual(unconfirmedContent.model, requestedModel);
    assert.deepEqual(unconfirmed.evidenceRefs[0].scope, operationScope);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  assert.equal(tool.events[0].summary, '调用工具：lookup');

  const signature = await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'signature_delta', signature: 'sig' },
  } as unknown as ProviderWireEvent, context);
  assert.equal(signature.events[0].summary, 'provider completed reasoning signature');

  const inputJson = await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"q":' },
  }, context);
  assert.equal(inputJson.events[0].summary, 'provider completed tool request details');

  const messageDelta = await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
  }, context);
  assert.equal(messageDelta.events[0].summary, 'provider completed model turn details');

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

test('provider adapter releases terminal failure once resources are released even before persistence commit', async () => {
  const failed = settlement({
    state: 'failed',
    resourceRelease: { state: 'released', evidenceRefs: [evidence('resource')] },
    persistence: { state: 'pending', evidenceRefs: [evidence('persistence-pending')] },
    error: {
      errorId: 'provider.settle.continuation-unavailable',
      code: 'capability.continuation-unavailable',
      category: 'capability',
      phase: 'settle',
      message: 'provider cannot continue a fully observed waiting execution',
      ownerId: 'humanagent.provider-adapter',
      retryable: 'manual',
      attention: 'foreground',
      evidenceRefs: [evidence('error')],
      nextAction: { kind: 'recover', ref: 'humanagent.provider-adapter' },
    },
  });
  const transport = makeTransport(ccBinding, {
    observe: async function* () {
      yield { protocol: 'responses', type: 'response.output_text.delta', item_id: 'item-1', delta: 'x' };
    },
    settle: async () => failed,
  });
  const adapter = responsesAdapter(transport, ccBinding);

  await adapter.start(startInput());
  const settled = await adapter.settle(execution());
  assert.equal(settled.state, 'failed');
  assert.equal(settled.resourceRelease.state, 'released');
  assert.equal(settled.persistence.state, 'pending');
  assert.equal((await adapter.close(ccBinding)).state, 'closed');
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
  assert.equal(ping.events[0].summary, 'provider sent heartbeat');
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

function contentFactOf(facts: readonly ProviderRawFact[]): Extract<ProviderRawFact, { kind: 'content' }> {
  const fact = facts.find((candidate): candidate is Extract<ProviderRawFact, { kind: 'content' }> => candidate.kind === 'content');
  assert.ok(fact, 'expected a content raw fact');
  return fact;
}

test('responses codec emits ordered typed raw facts for parts, arguments, tool calls, and completion', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const reader = providerRawContentReader(context.evidence);
  const readContent = async (fact: Extract<ProviderRawFact, { kind: 'content' }>): Promise<string> =>
    new TextDecoder().decode(await reader.read({ scope: operationScope, content: fact.content }));

  const partAdded = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.content_part.added',
    item_id: 'item-1',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: 'hel' },
  }, context);
  const partFact = contentFactOf(partAdded.rawFacts);
  assert.equal(partFact.channel, 'assistant-text');
  assert.equal(partFact.update, 'full');
  assert.equal(partFact.complete, false);
  assert.equal(partFact.contentUnitId, 'responses:assistant-text:item-1:0');
  assert.equal(await readContent(partFact), 'hel');

  const delta = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_text.delta',
    item_id: 'item-1',
    delta: 'lo',
  }, context);
  const deltaFact = contentFactOf(delta.rawFacts);
  assert.equal(deltaFact.update, 'delta');
  assert.equal(deltaFact.complete, false);
  // No content_index on the wire -> item-scoped unit, never a default part 0.
  assert.equal(deltaFact.contentUnitId, 'responses:assistant-text:item-1');
  assert.equal(await readContent(deltaFact), 'lo');

  const done = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_text.done',
    item_id: 'item-1',
    text: 'hello',
  }, context);
  const doneFact = contentFactOf(done.rawFacts);
  assert.equal(doneFact.update, 'full');
  assert.equal(doneFact.complete, true);
  assert.equal(doneFact.contentUnitId, 'responses:assistant-text:item-1');
  assert.equal(await readContent(doneFact), 'hello');

  const itemDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'message', id: 'item-1', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
  }, context);
  const itemFact = contentFactOf(itemDone.rawFacts);
  assert.equal(itemFact.update, 'full');
  assert.equal(itemFact.complete, true);
  assert.deepEqual(itemFact.replacesUnitIds, ['responses:assistant-text:item-1:0']);
  assert.equal(await readContent(itemFact), 'hello');

  const argDelta = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.function_call_arguments.delta',
    call_id: 'call-1',
    delta: '{"path":',
  }, context);
  const argDeltaFact = contentFactOf(argDelta.rawFacts);
  assert.equal(argDeltaFact.channel, 'tool-arguments');
  assert.equal(argDeltaFact.update, 'delta');
  assert.equal(argDeltaFact.contentUnitId, 'responses:tool-arguments:call-1');
  assert.equal(await readContent(argDeltaFact), '{"path":');

  const argDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.function_call_arguments.done',
    call_id: 'call-1',
    arguments: '{"path":"README.md"}',
  }, context);
  const argDoneFact = contentFactOf(argDone.rawFacts);
  assert.equal(argDoneFact.update, 'full');
  assert.equal(argDoneFact.complete, true);
  assert.equal(await readContent(argDoneFact), '{"path":"README.md"}');

  await codec.decodeEvent({ protocol: 'responses', type: 'response.created', response: { id: 'resp-tool' } }, context);
  const toolDone = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'file_read', arguments: '{"path":"README.md"}' },
  }, context);
  const toolFact = toolDone.rawFacts.find((candidate): candidate is Extract<ProviderRawFact, { kind: 'tool-call' }> => candidate.kind === 'tool-call');
  assert.ok(toolFact, 'expected a tool-call raw fact');
  assert.equal(toolFact.contentUnitId, 'responses:tool-arguments:call-1');
  assert.equal(toolFact.call.callId, 'call-1');
  assert.equal(toolFact.call.toolId, 'file.read');
  assert.equal(toolFact.call.continuationRef, 'resp-tool');
  assert.equal(new TextDecoder().decode(await reader.read({ scope: operationScope, content: toolFact.rawArguments })), '{"path":"README.md"}');
});

test('anthropic codec keeps block channels separate and closes units and tool calls on block stop', async () => {
  const codec = new AnthropicProviderCodec(4096);
  const context = codecContext();
  const reader = providerRawContentReader(context.evidence);
  const readAsset = async (asset: Extract<ProviderRawFact, { kind: 'content' }>['content']): Promise<string> =>
    new TextDecoder().decode(await reader.read({ scope: operationScope, content: asset }));

  await codec.decodeEvent({ protocol: 'anthropic', type: 'message_start', message: { id: 'msg-1', model: 'm', role: 'assistant' } }, context);

  const thinking = await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: 'think', signature: 'sig' },
  }, context);
  assert.equal(thinking.rawFacts.length, 2);
  const thinkFact = contentFactOf(thinking.rawFacts);
  const sigFact = thinking.rawFacts.find((candidate): candidate is Extract<ProviderRawFact, { kind: 'content' }> => candidate.kind === 'content' && candidate.channel === 'reasoning-signature');
  assert.ok(sigFact, 'expected a reasoning-signature fact');
  assert.equal(thinkFact.channel, 'reasoning-text');
  assert.equal(thinkFact.complete, false);
  assert.equal(await readAsset(thinkFact.content), 'think');
  assert.equal(sigFact.complete, false);
  assert.equal(await readAsset(sigFact.content), 'sig');

  const thinkingStop = await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_stop', index: 0 }, context);
  assert.deepEqual(thinkingStop.rawFacts.map((fact) => fact.kind), ['content-complete', 'content-complete']);
  assert.deepEqual(
    thinkingStop.rawFacts.map((fact) => (fact.kind === 'content-complete' ? fact.contentUnitId : '')),
    ['anthropic:reasoning-text:0', 'anthropic:reasoning-signature:0'],
  );

  const toolStart = await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
  }, context);
  const toolStartFact = contentFactOf(toolStart.rawFacts);
  assert.equal(toolStartFact.channel, 'tool-arguments');
  assert.equal(toolStartFact.complete, false);
  assert.equal(await readAsset(toolStartFact.content), '{}');

  const frag1 = await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }, context);
  const frag2 = await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } }, context);
  const frag1Fact = contentFactOf(frag1.rawFacts);
  const frag2Fact = contentFactOf(frag2.rawFacts);
  assert.equal(frag1Fact.contentUnitId, 'anthropic:tool-arguments:1');
  assert.equal(frag2Fact.contentUnitId, 'anthropic:tool-arguments:1');
  assert.equal((await readAsset(frag1Fact.content)) + (await readAsset(frag2Fact.content)), '{"q":"x"}');

  const toolStop = await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_stop', index: 1 }, context);
  const toolCall = toolStop.rawFacts.find((candidate): candidate is Extract<ProviderRawFact, { kind: 'tool-call' }> => candidate.kind === 'tool-call');
  assert.ok(toolCall, 'expected a completed tool call');
  assert.deepEqual(toolCall.call.arguments, { q: 'x' });
  assert.equal(toolCall.call.callId, 'tool-1');
  assert.equal(toolCall.call.toolId, 'lookup');
  assert.equal(toolCall.call.continuationRef, 'msg-1');
  assert.equal(new TextDecoder().decode(await reader.read({ scope: operationScope, content: toolCall.rawArguments })), '{"q":"x"}');
});

test('openai chat codec keeps tool argument fragments in one unit across a late call id', async () => {
  const codec = new OpenAIChatProviderCodec();
  const context = codecContext();
  const reader = providerRawContentReader(context.evidence);
  const readContent = async (fact: Extract<ProviderRawFact, { kind: 'content' }>): Promise<string> =>
    new TextDecoder().decode(await reader.read({ scope: operationScope, content: fact.content }));

  const first = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-1',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{"q":' } }] }, finish_reason: null }],
  }, context);
  const firstFact = contentFactOf(first.rawFacts);

  const second = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-1',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { arguments: '"x"}' } }] }, finish_reason: null }],
  }, context);
  const secondFact = contentFactOf(second.rawFacts);

  assert.equal(firstFact.contentUnitId, 'openai:tool-arguments:chat-1:0:0');
  assert.equal(secondFact.contentUnitId, firstFact.contentUnitId);
  assert.equal((await readContent(firstFact)) + (await readContent(secondFact)), '{"q":"x"}');

  const finish = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-1',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }, context);
  const terminal = finish.rawFacts.find((candidate): candidate is Extract<ProviderRawFact, { kind: 'request-complete' }> => candidate.kind === 'request-complete');
  assert.equal(terminal?.terminal, 'completed');
});

test('openai chat codec assembles fragments into one executable typed tool call with a legal phase', async () => {
  const codec = new OpenAIChatProviderCodec();
  const context = codecContext();

  const first = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-typed',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'file_read', arguments: '{"path":' } }] }, finish_reason: null }],
  }, context);
  assert.equal(first.events[0].kind, 'tool');
  assert.equal(first.events[0].toolPhase, 'invoke');
  assert.equal(first.events[0].toolCall, undefined);
  for (const event of first.events) validateProviderEvent(event);

  const second = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-typed',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-typed', function: { arguments: '"README.md"}' } }] }, finish_reason: null }],
  }, context);
  assert.equal(second.events[0].toolPhase, 'invoke');

  const finish = await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-typed',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }, context);
  const executable = finish.events.filter((event) => event.toolCall !== undefined);
  assert.equal(executable.length, 1);
  assert.deepEqual(executable[0]?.toolCall, { callId: 'call-typed', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'chat-typed' });
  assert.equal(executable[0]?.toolPhase, undefined);
  for (const event of finish.events) validateProviderEvent(event);
  const rawCall = finish.rawFacts.find((candidate): candidate is Extract<ProviderRawFact, { kind: 'tool-call' }> => candidate.kind === 'tool-call');
  assert.ok(rawCall, 'expected a typed tool-call raw fact');
  assert.equal(rawCall.contentUnitId, 'openai:tool-arguments:chat-typed:0:0');
  assert.deepEqual(rawCall.call.arguments, { path: 'README.md' });
});

test('openai chat codec fails closed on incomplete fragmented tool arguments', async () => {
  const codec = new OpenAIChatProviderCodec();
  const context = codecContext();
  await codec.decodeEvent({
    protocol: 'openai',
    type: 'openai.chat.completion',
    id: 'chat-bad',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-bad', function: { name: 'file_read', arguments: '{"path":' } }] }, finish_reason: null }],
  }, context);
  await assert.rejects(
    () => codec.decodeEvent({
      protocol: 'openai',
      type: 'openai.chat.completion',
      id: 'chat-bad',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    }, context),
    (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'tool.arguments.invalid-json',
  );
});

test('anthropic codec emits one executable typed tool call with a legal phase on block stop', async () => {
  const codec = new AnthropicProviderCodec(4096);
  const context = codecContext();

  await codec.decodeEvent({ protocol: 'anthropic', type: 'message_start', message: { id: 'msg-typed', model: 'm', role: 'assistant' } }, context);
  const start = await codec.decodeEvent({
    protocol: 'anthropic',
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'call-typed', name: 'file_read', input: {} },
  }, context);
  assert.equal(start.events[0].kind, 'tool');
  assert.equal(start.events[0].toolPhase, 'invoke');
  assert.equal(start.events[0].toolCall, undefined);
  for (const event of start.events) validateProviderEvent(event);

  await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }, context);
  await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } }, context);

  const stop = await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_stop', index: 0 }, context);
  const executable = stop.events.filter((event) => event.toolCall !== undefined);
  assert.equal(executable.length, 1);
  assert.deepEqual(executable[0]?.toolCall, { callId: 'call-typed', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'msg-typed' });
  for (const event of stop.events) validateProviderEvent(event);
  const rawCall = stop.rawFacts.find((candidate): candidate is Extract<ProviderRawFact, { kind: 'tool-call' }> => candidate.kind === 'tool-call');
  assert.ok(rawCall, 'expected a typed tool-call raw fact');
  assert.equal(rawCall.call.toolId, 'file.read');
  assert.equal(rawCall.call.continuationRef, 'msg-typed');
});

test('anthropic codec fails closed on incomplete tool arguments at block stop', async () => {
  const codec = new AnthropicProviderCodec(4096);
  const context = codecContext();
  await codec.decodeEvent({ protocol: 'anthropic', type: 'message_start', message: { id: 'msg-bad', model: 'm', role: 'assistant' } }, context);
  await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-bad', name: 'file_read', input: {} } }, context);
  await codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }, context);
  await assert.rejects(
    () => codec.decodeEvent({ protocol: 'anthropic', type: 'content_block_stop', index: 0 }, context),
    (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'tool.arguments.invalid-json',
  );
});

test('provider raw reader cold-reads an immutable asset from a fresh store object and rejects scope mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-provider-raw-'));
  const store = new ImmutableAssetStore(root);
  const sink = filesystemProviderEvidenceSink(store);
  const codec = new ResponsesProviderCodec();
  const context = codecContext({ evidence: sink });

  const decoded = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_text.delta',
    item_id: 'item-1',
    delta: 'line-1\nline-2',
  }, context);
  const fact = contentFactOf(decoded.rawFacts);

  // Drop the producer store/sink and rebuild from the same root.
  const freshStore = new ImmutableAssetStore(root);
  const reader = providerRawContentReader(filesystemProviderEvidenceSink(freshStore));
  const bytes = await reader.read({ scope: operationScope, content: fact.content });
  assert.equal(new TextDecoder().decode(bytes), 'line-1\nline-2');

  const otherScope: ScopeRef = { organId: id('organ', 'organ-b'), taskId: id('task', 'task-b'), operationId: id('operation', 'operation-b') };
  await assert.rejects(() => reader.read({ scope: otherScope, content: fact.content }), /scope/i);
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
  assert.equal(done.events[0].outputRefs?.length, 1);
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

test('responses codec binds item-less reasoning summary deltas to the active summary unit', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const reader = providerRawContentReader(context.evidence);

  await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'reasoning-before', status: 'in_progress', summary: [] },
  } as unknown as ProviderWireEvent, context);
  await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.reasoning_summary_part.added',
    item_id: 'reasoning-before',
    part: { type: 'reasoning_summary', summary: [{ type: 'summary_text', text: '' }] },
  } as unknown as ProviderWireEvent, context);

  const deltaOne = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.reasoning_summary_text.delta',
    delta: ' blocking',
  } as unknown as ProviderWireEvent, context);
  const deltaTwo = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.reasoning_summary_text.delta',
    delta: 'ness',
  } as unknown as ProviderWireEvent, context);
  const done = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.reasoning_summary_text.done',
    item_id: 'reasoning-before',
    text: ' blockingness',
  } as unknown as ProviderWireEvent, context);

  const firstFact = contentFactOf(deltaOne.rawFacts);
  const secondFact = contentFactOf(deltaTwo.rawFacts);
  const doneFact = contentFactOf(done.rawFacts);
  assert.equal(firstFact.contentUnitId, 'responses:reasoning-summary:reasoning-before');
  assert.equal(secondFact.contentUnitId, firstFact.contentUnitId);
  assert.equal(doneFact.contentUnitId, firstFact.contentUnitId);
  assert.equal(firstFact.complete, false);
  assert.equal(secondFact.complete, false);
  assert.equal(doneFact.complete, true);
  assert.equal(new TextDecoder().decode(await reader.read({ scope: operationScope, content: firstFact.content })), ' blocking');
  assert.equal(new TextDecoder().decode(await reader.read({ scope: operationScope, content: secondFact.content })), 'ness');
  await assert.rejects(
    () => codec.decodeEvent({
      protocol: 'responses',
      type: 'response.reasoning_summary_text.delta',
      delta: ' after done',
    } as unknown as ProviderWireEvent, context),
    /missing item_id/,
  );

  await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'reasoning',
      id: 'reasoning-before',
      status: 'completed',
      summary: [{ type: 'summary_text', text: ' blockingness' }],
    },
  } as unknown as ProviderWireEvent, context);
  await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'reasoning', id: 'reasoning-after', status: 'in_progress', summary: [] },
  } as unknown as ProviderWireEvent, context);
  await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.reasoning_summary_part.added',
    item_id: 'reasoning-after',
    part: { type: 'reasoning_summary', summary: [{ type: 'summary_text', text: '' }] },
  } as unknown as ProviderWireEvent, context);
  const nextDelta = await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.reasoning_summary_text.delta',
    delta: 'next',
  } as unknown as ProviderWireEvent, context);
  const nextFact = contentFactOf(nextDelta.rawFacts);
  assert.equal(nextFact.contentUnitId, 'responses:reasoning-summary:reasoning-after');
  assert.notEqual(nextFact.contentUnitId, firstFact.contentUnitId);
});

test('responses codec rejects item-less reasoning summary deltas without an active summary', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  await assert.rejects(
    () => codec.decodeEvent({
      protocol: 'responses',
      type: 'response.reasoning_summary_text.delta',
      delta: 'orphan',
    } as unknown as ProviderWireEvent, context),
    /missing item_id/,
  );
});

test('responses codec enforces fail-closed reasoning lifecycle (RULING 3.2.1)', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const decode = (raw: Record<string, unknown>) =>
    codec.decodeEvent({ protocol: 'responses', ...raw } as unknown as ProviderWireEvent, context);

  // 1. reasoning_summary_part.added with no active reasoning item throws.
  await assert.rejects(
    () => decode({
      type: 'response.reasoning_summary_part.added',
      item_id: 'rs-orphan',
      part: { type: 'reasoning_summary', summary: [] },
    }),
    (error: unknown) => {
      assert.equal((error as ProviderAdapterError).providerError.code, 'protocol.reasoning-mismatch');
      return true;
    },
  );

  // Open one reasoning item, start its summary.
  await decode({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs-1', status: 'in_progress', summary: [] },
  });
  await decode({
    type: 'response.reasoning_summary_part.added',
    item_id: 'rs-1',
    part: { type: 'reasoning_summary', summary: [] },
  });

  // 2a. An explicit-item-id delta for a different active item throws.
  await assert.rejects(
    () => decode({ type: 'response.reasoning_summary_text.delta', item_id: 'rs-other', delta: 'x' }),
    (error: unknown) => {
      assert.equal((error as ProviderAdapterError).providerError.code, 'protocol.reasoning-mismatch');
      return true;
    },
  );

  // 2b. An explicit-item-id delta for the active item but before summaryStarted throws.
  // Close and re-open cleanly, then send a delta without having started the summary.
  await decode({
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs-1', status: 'completed', summary: [] },
  });
  await decode({
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'reasoning', id: 'rs-2', status: 'in_progress', summary: [] },
  });
  await assert.rejects(
    () => decode({ type: 'response.reasoning_summary_text.delta', item_id: 'rs-2', delta: 'x' }),
    (error: unknown) => {
      assert.equal((error as ProviderAdapterError).providerError.code, 'protocol.reasoning-mismatch');
      return true;
    },
  );

  // 3. reasoning_summary_text.done must match the active item and require a started summary.
  await assert.rejects(
    () => decode({ type: 'response.reasoning_summary_text.done', item_id: 'rs-3', text: 'x' }),
    (error: unknown) => {
      assert.equal((error as ProviderAdapterError).providerError.code, 'protocol.reasoning-mismatch');
      return true;
    },
  );

  // 4. output_item.done for a reasoning item with an explicit id must match the active item.
  await assert.rejects(
    () => decode({
      type: 'response.output_item.done',
      output_index: 1,
      item: { type: 'reasoning', id: 'rs-other', status: 'completed', summary: [] },
    }),
    (error: unknown) => {
      assert.equal((error as ProviderAdapterError).providerError.code, 'protocol.reasoning-mismatch');
      return true;
    },
  );
});

test('responses codec rejects a reasoning summary that spans a different active item', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  await codec.decodeEvent({
    protocol: 'responses',
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'reasoning-active', status: 'in_progress', summary: [] },
  } as unknown as ProviderWireEvent, context);
  await assert.rejects(
    () => codec.decodeEvent({
      protocol: 'responses',
      type: 'response.reasoning_summary_part.added',
      item_id: 'reasoning-other',
      part: { type: 'reasoning_summary', summary: [] },
    } as unknown as ProviderWireEvent, context),
    /different item/,
  );
});

test('responses codec accepts the exact late item-less duplicate tails after completed units', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const decode = (raw: Record<string, unknown>) =>
    codec.decodeEvent({ protocol: 'responses', ...raw } as unknown as ProviderWireEvent, context);
  const completedSummary = 'The tool is unavailable, but listing it is non-blocking. I\'ll include it.\n\nNo helper dispatch needed.';
  const lateSummaryTail = 'ng. I\'ll include it.\n\nNo helper dispatch needed.';
  const completedOutput = '{"kind":"requirement","proposal":{"blockingGaps":["The execution environment must provide a web search capability equivalent to the web_search function."]},"taskFlowKind":"one-shot"}';
  const lateOutputTail = 'b_search function."]},"taskFlowKind":"one-shot"}';

  await decode({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs-late', status: 'in_progress', summary: [] },
  });
  await decode({
    type: 'response.reasoning_summary_part.added',
    item_id: 'rs-late',
    part: { type: 'reasoning_summary', summary: [] },
  });
  await decode({ type: 'response.reasoning_summary_text.delta', item_id: 'rs-late', delta: completedSummary });
  await decode({ type: 'response.reasoning_summary_text.done', item_id: 'rs-late', text: completedSummary });
  await decode({
    type: 'response.reasoning_summary_part.done',
    item_id: 'rs-late',
    part: { type: 'reasoning_summary', summary: [{ type: 'summary_text', text: completedSummary }] },
  });
  await decode({
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs-late', status: 'completed', summary: [{ type: 'summary_text', text: completedSummary }] },
  });
  await decode({
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'message', id: 'msg-late', role: 'assistant', content: [] },
  });
  await decode({
    type: 'response.content_part.added',
    item_id: 'msg-late',
    output_index: 1,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  });
  await decode({ type: 'response.output_text.delta', item_id: 'msg-late', content_index: 0, delta: completedOutput });
  await decode({ type: 'response.output_text.done', item_id: 'msg-late', content_index: 0, text: completedOutput });
  await decode({
    type: 'response.content_part.done',
    item_id: 'msg-late',
    output_index: 1,
    content_index: 0,
    part: { type: 'output_text', text: completedOutput },
  });
  await decode({
    type: 'response.output_item.done',
    output_index: 1,
    item: { type: 'message', id: 'msg-late', role: 'assistant', content: [{ type: 'output_text', text: completedOutput }] },
  });

  const lateSummary = await decode({ type: 'response.reasoning_summary_text.delta', delta: lateSummaryTail });
  const lateOutput = await decode({ type: 'response.output_text.delta', delta: lateOutputTail });

  assert.deepEqual(lateSummary.rawFacts, []);
  assert.equal(lateSummary.events[0]?.kind, 'model');
  assert.match(lateSummary.events[0]?.eventId ?? '', /response\.reasoning_summary_text\.delta/);
  assert.equal(lateSummary.events[0]?.evidenceRefs.length, 1);
  assert.deepEqual(lateOutput.rawFacts, []);
  assert.equal(lateOutput.events[0]?.kind, 'output');
  assert.match(lateOutput.events[0]?.eventId ?? '', /response\.output_text\.delta/);
  assert.equal(lateOutput.events[0]?.evidenceRefs.length, 1);
  assert.equal(lateOutput.events[0]?.summary, undefined);
});

test('responses codec rejects repeated and conflicting item-less tails after completion', async () => {
  const codec = new ResponsesProviderCodec();
  const context = codecContext();
  const decode = (raw: Record<string, unknown>) =>
    codec.decodeEvent({ protocol: 'responses', ...raw } as unknown as ProviderWireEvent, context);
  const completedSummary = 'Reasoning ends here.\n\nNo helper dispatch needed.';
  const completedOutput = 'The final answer includes the literal string humanagent-e2e-web-search.';

  await decode({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs-repeat', status: 'in_progress', summary: [] },
  });
  await decode({
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs-repeat', status: 'completed', summary: [{ type: 'summary_text', text: completedSummary }] },
  });
  await decode({
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'message', id: 'msg-repeat', role: 'assistant', content: [] },
  });
  await decode({
    type: 'response.output_item.done',
    output_index: 1,
    item: { type: 'message', id: 'msg-repeat', role: 'assistant', content: [{ type: 'output_text', text: completedOutput }] },
  });

  await decode({ type: 'response.reasoning_summary_text.delta', delta: 'No helper dispatch needed.' });
  await assert.rejects(
    () => decode({ type: 'response.reasoning_summary_text.delta', delta: 'No helper dispatch needed.' }),
    (error: unknown) => {
      assert.equal((error as ProviderAdapterError).providerError.code, 'protocol.duplicate-tail');
      assert.match((error as Error).message, /already covered/);
      return true;
    },
  );

  await decode({ type: 'response.output_text.delta', delta: 'humanagent-e2e-web-search.' });
  await assert.rejects(
    () => decode({ type: 'response.output_text.delta', delta: 'not present in the completed output' }),
    (error: unknown) => {
      assert.equal((error as ProviderAdapterError).providerError.code, 'protocol.duplicate-tail');
      assert.match((error as Error).message, /not a duplicate suffix/);
      return true;
    },
  );
});
