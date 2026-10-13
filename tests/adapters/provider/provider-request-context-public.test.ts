import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type NativeRequestRegistration,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderEvent,
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
  type ProviderRequestContextHook,
  type ProviderRequestContextHookInput,
} from '../../../packages/contracts/src/provider-request-context.js';
import {
  AnthropicProviderCodec,
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ProviderAgentDriver,
  ResponsesProviderCodec,
  type AnthropicWireRequest,
  type OpenAIChatWireRequest,
  type ProviderAgentEvent,
  type ProviderEvidenceSink,
  type ProviderTransport,
  type ProviderWireRequest,
  type ResponsesWireRequest,
} from '../../../packages/adapters/provider/src/index.js';

const organ = id('organ', 'organ-p');
const taskId = id('task', 'task-p');
const operationId = id('operation', 'operation-p');
const scope: ScopeRef = { organId: organ, taskId, operationId };
const identity = { runtimeId: 'runtime-p', taskId, operationId, executionEpoch: 1 };
const responsesBinding: ProviderBinding = {
  bindingId: 'binding-p-responses',
  providerId: 'cc',
  protocol: 'responses',
  endpointRef: 'endpoint-p-responses',
  modelRef: 'model-p',
  configDigest: 'sha256:config-p',
  capabilityDigest: 'sha256:capability-p',
};
const anthropicBinding: ProviderBinding = {
  ...responsesBinding,
  bindingId: 'binding-p-anthropic',
  providerId: 'goaichat',
  protocol: 'anthropic',
  endpointRef: 'endpoint-p-anthropic',
};
const openaiBinding: ProviderBinding = {
  ...responsesBinding,
  bindingId: 'binding-p-openai',
  providerId: 'openai-chat',
  protocol: 'openai',
  endpointRef: 'endpoint-p-openai',
};

function evidence(label: string): EvidenceRef {
  return { evidenceId: id('evidence', `ev-${label}`), kind: 'execution', source: 'test', locator: label, scope };
}

function memoryEvidenceSink(): ProviderEvidenceSink {
  const assets = new Map<string, Uint8Array>();
  return {
    async write(input) {
      const locator = `${input.type}-${input.locator}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
      const text = typeof input.content === 'string' ? input.content : JSON.stringify(input.content);
      assets.set(locator, new TextEncoder().encode(text));
      return { evidenceId: id('evidence', locator), kind: input.kind, source: 'test', locator, scope: input.scope };
    },
    async read(ref) {
      return assets.get(ref.locator) ?? new Uint8Array();
    },
  };
}

interface Captured {
  readonly order: string[];
  readonly starts: ProviderWireRequest[];
  readonly submits: ProviderWireRequest[];
}

function capturingTransport(captured: Captured): ProviderTransport {
  let observeRound = 0;
  return {
    async start(_input, request): Promise<ProviderStartReceipt> {
      captured.order.push('start');
      captured.starts.push(request);
      return { ...identity, startedAt: '2026-01-01T00:00:00.000Z', evidenceRefs: [evidence('start-receipt')] };
    },
    async resume(): Promise<never> {
      throw new Error('resume not used');
    },
    async submit(_input, request): Promise<ProviderSubmitResult> {
      captured.order.push('submit');
      captured.submits.push(request);
      return { ...identity, status: 'accepted', outputRefs: [], evidenceRefs: [evidence('submit-receipt')] };
    },
    async *observe() {
      observeRound += 1;
      if (observeRound === 1) {
        yield { protocol: 'responses', type: 'response.created', response: { id: 'resp-1' } } as const;
        yield { protocol: 'responses', type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-1', name: 'file_read', arguments: '' } } as const;
        yield { protocol: 'responses', type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-1', name: 'file_read', arguments: '{"path":"README.md"}' } } as const;
        yield { protocol: 'responses', type: 'response.completed', response: { id: 'resp-1' } } as const;
        return;
      }
      yield { protocol: 'responses', type: 'response.created', response: { id: 'resp-2' } } as const;
      yield { protocol: 'responses', type: 'response.output_text.done', item_id: 'msg-2', text: 'done' } as const;
      yield { protocol: 'responses', type: 'response.completed', response: { id: 'resp-2' } } as const;
    },
    async requestStop(): Promise<ProviderStopReceipt> {
      return { ...identity, status: 'accepted', receivedAt: '2026-01-01T00:00:00.000Z', evidenceRefs: [evidence('stop-receipt')] };
    },
    async settle(): Promise<ProviderSettlement> {
      return {
        ...identity,
        state: 'succeeded',
        evidenceRefs: [evidence('settle')],
        resourceRelease: { state: 'released', evidenceRefs: [evidence('release')] },
        persistence: { state: 'committed', evidenceRefs: [evidence('persistence')] },
      };
    },
    async close(): Promise<ProviderCloseResult> {
      return { bindingId: responsesBinding.bindingId, providerId: responsesBinding.providerId, protocol: responsesBinding.protocol, state: 'closed', evidenceRefs: [evidence('close')] };
    },
  };
}

function contextUnits(phase: ProviderRequestContextHookInput['phase']) {
  if (phase === 'initial') {
    return {
      canonical: { units: [{ kind: 'message' as const, role: 'user' as const, text: 'CURRENT_TURN_INPUT' }] },
      instructions: { text: 'ORIENTATION_ONE' },
    };
  }
  return {
    canonical: {
      units: [
        { kind: 'message' as const, role: 'user' as const, text: 'CURRENT_TURN_INPUT' },
        { kind: 'tool-call' as const, callId: 'call-1', toolId: 'file.read', arguments: { path: 'README.md' } },
        { kind: 'tool-result' as const, callId: 'call-1', toolId: 'file.read', output: 'TOOL_OUTPUT', status: 'succeeded' as const },
      ],
    },
    instructions: { text: 'ORIENTATION_TWO' },
  };
}

test('provider driver materializes fresh typed context and encodes each protocol once', async () => {
  const captured: Captured = { order: [], starts: [], submits: [] };
  const sink = memoryEvidenceSink();
  const adapter = new ProviderAdapter({
    binding: responsesBinding,
    routeRef: 'route-p',
    codec: new ResponsesProviderCodec(),
    transport: capturingTransport(captured),
    evidence: sink,
  });
  const startInputs: ProviderStartInput[] = [];
  const submitInputs: ProviderSubmitInput[] = [];
  const port: ExecutionRuntimePort = {
    kind: adapter.kind,
    probe: (target) => adapter.probe(target),
    capabilities: (target) => adapter.capabilities(target),
    start: (input) => {
      startInputs.push(input);
      return adapter.start(input);
    },
    resume: (input) => adapter.resume(input),
    submit: (input) => {
      submitInputs.push(input);
      return adapter.submit(input);
    },
    observe: (input) => adapter.observe(input),
    requestStop: (input: ProviderStopRequest) => adapter.requestStop(input),
    settle: (input) => adapter.settle(input),
    close: (target) => adapter.close(target),
  };

  const hookCalls: ProviderRequestContextHookInput[] = [];
  const requestContext: ProviderRequestContextHook = async (input) => {
    captured.order.push(`hook:${input.phase}`);
    hookCalls.push(input);
    return contextUnits(input.phase);
  };
  const registerRequest = async (registration: NativeRequestRegistration) => {
    captured.order.push(`register:${registration.record.phase}`);
    return registration.record;
  };

  const driver = new ProviderAgentDriver({
    port,
    binding: responsesBinding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-p',
    scope,
    inputRefs: ['input-p'],
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    executeTool: { execute: async () => ({ output: 'TOOL_OUTPUT', outputRefs: [], evidenceRefs: [evidence('tool-result')], status: 'succeeded' as const }) },
    registerRequest,
    requestContext,
  });

  await driver.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await driver.submit({
    taskId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-p',
    payload: { prompt: 'PRIOR_TURN_RAW_MARKER' },
  });
  const events: ProviderAgentEvent[] = [];
  for await (const event of driver.observe({ runtimeId: identity.runtimeId })) events.push(event);

  assert.deepEqual(hookCalls.map((call) => call.phase), ['initial', 'continuation']);
  assert.notEqual(hookCalls[0]?.request.requestId, hookCalls[1]?.request.requestId);
  assert.deepEqual(
    captured.order.filter((entry) => entry.startsWith('hook:') || entry === 'start' || entry === 'submit' || entry === 'register:dispatching'),
    ['register:dispatching', 'hook:initial', 'start', 'register:dispatching', 'hook:continuation', 'submit'],
  );

  assert.equal(startInputs[0]?.requestContext?.units.length, 1);
  assert.deepEqual(startInputs[0]?.instructions, { text: 'ORIENTATION_ONE' });
  assert.equal(submitInputs[0]?.requestContext?.units.length, 3);
  assert.deepEqual(submitInputs[0]?.instructions, { text: 'ORIENTATION_TWO' });
  assert.equal(submitInputs[0]?.toolContinuations, undefined);

  const initialWire = captured.starts[0] as ResponsesWireRequest;
  const continuationWire = captured.submits[0] as ResponsesWireRequest;
  assert.equal(initialWire.protocol, 'responses');
  assert.match(initialWire.instructions, /ORIENTATION_ONE/);
  assert.equal(JSON.stringify(initialWire).includes('PRIOR_TURN_RAW_MARKER'), false);
  assert.deepEqual(initialWire.input, [{ type: 'message', role: 'user', content: 'CURRENT_TURN_INPUT' }]);

  assert.match(continuationWire.instructions, /ORIENTATION_TWO/);
  assert.equal(continuationWire.instructions.includes('ORIENTATION_ONE'), false);
  const functionCalls = continuationWire.input.filter((item) => item.type === 'function_call');
  const functionOutputs = continuationWire.input.filter((item) => item.type === 'function_call_output');
  assert.equal(functionCalls.length, 1);
  assert.equal(functionOutputs.length, 1);
  assert.deepEqual(functionCalls[0], { type: 'function_call', call_id: 'call-1', name: 'file_read', arguments: '{"path":"README.md"}' });
  assert.deepEqual(functionOutputs[0], { type: 'function_call_output', call_id: 'call-1', output: 'TOOL_OUTPUT' });
  assert.deepEqual(
    continuationWire.input.filter((item) => item.type === 'message'),
    [{ type: 'message', role: 'user', content: 'CURRENT_TURN_INPUT' }],
  );
  assert.equal(JSON.stringify(continuationWire).includes('PRIOR_TURN_RAW_MARKER'), false);

  const anthropicCodec = new AnthropicProviderCodec(1024);
  const anthropicInitial = anthropicCodec.encodeStart(startInputs[0]!, anthropicBinding, 'route-p') as AnthropicWireRequest;
  assert.match(anthropicInitial.system, /ORIENTATION_ONE/);
  assert.equal(anthropicInitial.system.includes('CURRENT_TURN_INPUT'), false);
  assert.deepEqual(anthropicInitial.messages, [{ role: 'user', content: [{ type: 'text', text: 'CURRENT_TURN_INPUT' }] }]);

  const anthropicContinuation = anthropicCodec.encodeSubmit(submitInputs[0]!, anthropicBinding, 'route-p') as AnthropicWireRequest;
  assert.match(anthropicContinuation.system, /ORIENTATION_TWO/);
  assert.equal(anthropicContinuation.system.includes('ORIENTATION_ONE'), false);
  assert.equal(JSON.stringify(anthropicContinuation).includes('PRIOR_TURN_RAW_MARKER'), false);
  const blocks = anthropicContinuation.messages.flatMap((message) => message.content);
  assert.deepEqual(blocks.filter((block) => block.type === 'text'), [{ type: 'text', text: 'CURRENT_TURN_INPUT' }]);
  assert.deepEqual(blocks.filter((block) => block.type === 'tool_use'), [{ type: 'tool_use', id: 'call-1', name: 'file.read', input: { path: 'README.md' } }]);
  assert.deepEqual(blocks.filter((block) => block.type === 'tool_result'), [{ type: 'tool_result', tool_use_id: 'call-1', content: 'TOOL_OUTPUT' }]);
  assert.equal(blocks.some((block) => block.type === 'thinking'), false);

  assert.equal(events.at(-1)?.providerEvent.terminalState, 'succeeded');
});

test('openai chat rejects typed request context before dispatch and keeps legacy payload encoding', async () => {
  const captured: Captured = { order: [], starts: [], submits: [] };
  const adapter = new ProviderAdapter({
    binding: openaiBinding,
    routeRef: 'route-p',
    codec: new OpenAIChatProviderCodec(),
    transport: capturingTransport(captured),
    evidence: memoryEvidenceSink(),
  });
  const port: ExecutionRuntimePort = {
    kind: adapter.kind,
    probe: (target) => adapter.probe(target),
    capabilities: (target) => adapter.capabilities(target),
    start: (input) => adapter.start(input),
    resume: (input) => adapter.resume(input),
    submit: (input) => adapter.submit(input),
    observe: (input) => adapter.observe(input),
    requestStop: (input: ProviderStopRequest) => adapter.requestStop(input),
    settle: (input) => adapter.settle(input),
    close: (target) => adapter.close(target),
  };
  const driver = new ProviderAgentDriver({
    port,
    binding: openaiBinding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-p',
    scope,
    inputRefs: ['input-p'],
    requestContext: async () => contextUnits('initial'),
  });

  await driver.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await assert.rejects(
    () => driver.submit({
      taskId,
      executionEpoch: identity.executionEpoch,
      assignmentId: 'assignment-p',
      payload: { prompt: 'LEGACY_CHAT_PAYLOAD' },
    }),
    (error: unknown) => (error as { providerError?: { code?: string } }).providerError?.code === 'request.context.unsupported',
  );
  // The rejected request must not reach the transport.
  assert.equal(captured.starts.length, 0);
  assert.equal(captured.order.includes('start'), false);

  // Legacy openai chat still stringifies the business payload when no typed context is bound.
  const legacy = new OpenAIChatProviderCodec().encodeStart(
    { ...identity, inputRefs: ['input-p'], evidenceRefs: [evidence('legacy-chat')], payload: { prompt: 'LEGACY_CHAT_PAYLOAD' } },
    openaiBinding,
    'route-p',
  ) as OpenAIChatWireRequest;
  assert.equal(legacy.messages.length, 1);
  assert.match(legacy.messages[0]!.content, /LEGACY_CHAT_PAYLOAD/);
});
