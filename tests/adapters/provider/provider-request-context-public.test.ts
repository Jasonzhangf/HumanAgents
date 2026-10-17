import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type AgentClosure,
  id,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type NativeRequestRegistration,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderProducerDrainResult,
  type ProviderRequestLifecycleEvent,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
  type ProviderToolCall,
  type RawFactEnvelope,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  type MaterializedRequestInput,
  type ProviderRequestContextHook,
  type ProviderRequestContextHookInput,
} from '../../../packages/contracts/src/provider-request-context.js';
import {
  AnthropicProviderCodec,
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ProviderAgentDriver,
  ResponsesProviderCodec,
  createHttpProviderTransport,
  type AnthropicWireRequest,
  type OpenAIChatWireRequest,
  type ProviderAgentEvent,
  type ProviderCodec,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type ProviderTransport,
  type ProviderWireRequest,
  type ResponsesWireRequest,
  type V3ProviderFetch,
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

// The footer the wire must render after the original tool output when a result
// carries accepted evidence refs. The resolver accepts an evidenceId value or a
// locator, so both are rendered.
function expectedFooter(refs: readonly EvidenceRef[]): string {
  return [
    '',
    '[HumanAgent evidence refs]',
    'Cite one exact evidenceId value below when you finish the turn.',
    ...refs.map((ref) => [
      `- evidenceId=${ref.evidenceId.value}`,
      `kind=${ref.kind}`,
      `locator=${ref.locator}`,
      ...(ref.digest === undefined ? [] : [`digest=${ref.digest}`]),
    ].join(' ')),
    '[/HumanAgent evidence refs]',
  ].join('\n');
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
        { kind: 'tool-result' as const, callId: 'call-1', toolId: 'file.read', output: 'TOOL_OUTPUT', evidenceRefs: [evidence('tool-result')], status: 'succeeded' as const },
      ],
    },
    instructions: { text: 'ORIENTATION_TWO' },
  };
}

test('provider driver materializes fresh typed context and encodes each protocol once', async () => {
  const toolOutput = `TOOL_OUTPUT${expectedFooter([evidence('tool-result')])}`;
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
  assert.deepEqual(functionOutputs[0], { type: 'function_call_output', call_id: 'call-1', output: toolOutput });
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
  assert.deepEqual(anthropicInitial.tools, [
    { name: 'file.read', description: 'read file', input_schema: { type: 'object' } },
  ]);

  const anthropicContinuation = anthropicCodec.encodeSubmit(submitInputs[0]!, anthropicBinding, 'route-p') as AnthropicWireRequest;
  assert.deepEqual(anthropicContinuation.tools, [
    { name: 'file.read', description: 'read file', input_schema: { type: 'object' } },
  ]);
  assert.match(anthropicContinuation.system, /ORIENTATION_TWO/);
  assert.equal(anthropicContinuation.system.includes('ORIENTATION_ONE'), false);
  assert.equal(JSON.stringify(anthropicContinuation).includes('PRIOR_TURN_RAW_MARKER'), false);
  const blocks = anthropicContinuation.messages.flatMap((message) => message.content);
  assert.deepEqual(blocks.filter((block) => block.type === 'text'), [{ type: 'text', text: 'CURRENT_TURN_INPUT' }]);
  assert.deepEqual(blocks.filter((block) => block.type === 'tool_use'), [{ type: 'tool_use', id: 'call-1', name: 'file.read', input: { path: 'README.md' } }]);
  assert.deepEqual(blocks.filter((block) => block.type === 'tool_result'), [{ type: 'tool_result', tool_use_id: 'call-1', content: toolOutput }]);
  assert.equal(blocks.some((block) => block.type === 'thinking'), false);

  const chatCodec = new OpenAIChatProviderCodec();
  const chatInitial = chatCodec.encodeStart(startInputs[0]!, openaiBinding, 'route-p');
  assert.equal(chatInitial.protocol, 'openai');
  // The transient orientation is a request-local system message; canonical text stays in units.
  assert.equal(chatInitial.messages[0]!.role, 'system');
  assert.match(chatInitial.messages[0]!.content, /ORIENTATION_ONE/);
  assert.equal(chatInitial.messages[0]!.content.includes('CURRENT_TURN_INPUT'), false);
  assert.deepEqual(chatInitial.messages.slice(1), [{ role: 'user', content: 'CURRENT_TURN_INPUT' }]);
  assert.deepEqual(chatInitial.tools, [{ type: 'function', function: { name: 'file_read', description: 'read file', parameters: { type: 'object' } } }]);
  assert.equal(JSON.stringify(chatInitial).includes('PRIOR_TURN_RAW_MARKER'), false);

  const chatContinuation = chatCodec.encodeSubmit(submitInputs[0]!, openaiBinding, 'route-p');
  assert.match(chatContinuation.messages[0]!.content, /ORIENTATION_TWO/);
  assert.equal(chatContinuation.messages[0]!.content.includes('ORIENTATION_ONE'), false);
  // Canonical user/assistant text, one contiguous assistant tool_calls group, exact tool result.
  assert.deepEqual(chatContinuation.messages.slice(1), [
    { role: 'user', content: 'CURRENT_TURN_INPUT' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'file_read', arguments: '{"path":"README.md"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: toolOutput },
  ]);
  assert.equal(JSON.stringify(chatContinuation).includes('PRIOR_TURN_RAW_MARKER'), false);

  assert.equal(events.at(-1)?.providerEvent.terminalState, 'succeeded');
});

test('openai chat driver encodes typed request context to the captured transport', async () => {
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
  await driver.submit({
    taskId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-p',
    payload: { prompt: 'LEGACY_CHAT_PAYLOAD' },
  });
  // The typed-context request must reach the captured transport, not be rejected.
  assert.equal(captured.starts.length, 1);
  const wire = captured.starts[0] as OpenAIChatWireRequest;
  assert.equal(wire.protocol, 'openai');
  assert.equal(wire.messages[0]!.role, 'system');
  assert.match(wire.messages[0]!.content, /ORIENTATION_ONE/);
  assert.deepEqual(wire.messages.slice(1), [{ role: 'user', content: 'CURRENT_TURN_INPUT' }]);
  // The wire execution field is identity only.
  assert.deepEqual(wire.execution, { runtimeId: identity.runtimeId, taskId, operationId, executionEpoch: identity.executionEpoch });
  assert.equal(JSON.stringify(wire.execution).includes('LEGACY_CHAT_PAYLOAD'), false);

  // Legacy openai chat (no typed context, no instructions) still stringifies the business payload.
  const legacy = new OpenAIChatProviderCodec().encodeStart(
    { ...identity, inputRefs: ['input-p'], evidenceRefs: [evidence('legacy-chat')], payload: { prompt: 'LEGACY_CHAT_PAYLOAD' } },
    openaiBinding,
    'route-p',
  ) as OpenAIChatWireRequest;
  assert.deepEqual(legacy.messages, [{ role: 'user', content: '{"prompt":"LEGACY_CHAT_PAYLOAD"}' }]);
  assert.equal(legacy.tools, undefined);

  // Instructions-only: an independent system message plus the legacy user payload.
  const instructionsOnly = new OpenAIChatProviderCodec().encodeStart(
    { ...identity, inputRefs: ['input-p'], evidenceRefs: [evidence('instructions-only')], payload: { prompt: 'LEGACY_CHAT_PAYLOAD' }, instructions: { text: 'ORIENTATION_ONLY' } },
    openaiBinding,
    'route-p',
  ) as OpenAIChatWireRequest;
  assert.equal(instructionsOnly.messages[0]!.role, 'system');
  assert.match(instructionsOnly.messages[0]!.content, /ORIENTATION_ONLY/);
  assert.deepEqual(instructionsOnly.messages.slice(1), [{ role: 'user', content: '{"prompt":"LEGACY_CHAT_PAYLOAD"}' }]);
});

test('openai chat groups contiguous tool calls and preserves exact tool result output', () => {
  const codec = new OpenAIChatProviderCodec();
  const wire = codec.encodeStart(
    {
      ...identity,
      inputRefs: ['input-p'],
      evidenceRefs: [evidence('chat-two-calls')],
      payload: { prompt: 'IGNORED_LEGACY_PAYLOAD' },
      requestContext: {
        units: [
          { kind: 'message', role: 'user', text: 'CURRENT_TURN_INPUT' },
          { kind: 'message', role: 'assistant', text: 'READING' },
          { kind: 'tool-call', callId: 'call-1', toolId: 'file.read', arguments: { path: 'README.md' } },
          { kind: 'tool-call', callId: 'call-2', toolId: 'file.list', arguments: { dir: '.' } },
          { kind: 'tool-result', callId: 'call-1', toolId: 'file.read', output: 'TOOL_OUTPUT\n', status: 'succeeded' },
          { kind: 'tool-result', callId: 'call-2', toolId: 'file.list', output: 'boom: not found\n', status: 'failed' },
        ],
      },
      instructions: { text: 'ORIENTATION_X' },
    },
    openaiBinding,
    'route-p',
  );
  // Two contiguous calls fold into one assistant message; a failed result keeps its exact output
  // and is not rewritten to success (no status wrapper, no non-standard is_error field).
  assert.deepEqual(wire.messages.slice(1), [
    { role: 'user', content: 'CURRENT_TURN_INPUT' },
    { role: 'assistant', content: 'READING' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call-1', type: 'function', function: { name: 'file_read', arguments: '{"path":"README.md"}' } },
        { id: 'call-2', type: 'function', function: { name: 'file_list', arguments: '{"dir":"."}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'TOOL_OUTPUT\n' },
    { role: 'tool', tool_call_id: 'call-2', content: 'boom: not found\n' },
  ]);
  assert.equal(JSON.stringify(wire).includes('IGNORED_LEGACY_PAYLOAD'), false);
  assert.equal(JSON.stringify(wire).includes('"failed"'), false);

  // An unregistered/invalid tool id still fails through the existing mapper error channel.
  assert.throws(
    () => codec.encodeStart(
      {
        ...identity,
        inputRefs: ['input-p'],
        evidenceRefs: [evidence('chat-bad-tool')],
        payload: { prompt: 'x' },
        requestContext: { units: [{ kind: 'tool-call', callId: 'call-x', toolId: 'file read', arguments: {} }] },
      },
      openaiBinding,
      'route-p',
    ),
    (error: unknown) => (error as { providerError?: { code?: string } }).providerError?.code === 'tool.name.unsupported',
  );
});

// --- J: native protocol round trips over the real HTTP source transport ---
//
// These three fixtures drive the real ProviderAgentDriver + ProviderAdapter + the
// protocol codec over the real createHttpProviderTransport with an injected
// recorded fetch. The Runtime seams (registerRequest / acceptRawFact / the
// evidence sink) are injected via the existing public driver options and are
// labeled as such: this proves the send/decode/execute/continue chain, not the
// full App/Journal/cold/live path.

const NATIVE_LOOP_BASE_URL = 'http://127.0.0.1:4444';
const NATIVE_LOOP_ROUTE = 'route-native-loop';
const NATIVE_LOOP_LEGACY_SENTINEL = 'PRIOR_TURN_RAW_MARKER';
const NATIVE_LOOP_ASSIGNMENT = 'assignment-native-loop';

/** The codec puts the provider binding id in front of the local route label. */
function nativeRoute(providerId: string): string {
  return `${providerId}:${NATIVE_LOOP_ROUTE}`;
}

interface RecordedFetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly rawBody: string;
}

interface LocalRequestReceiptView {
  readonly body: string;
  readonly identity: {
    readonly runtimeId: string;
    readonly taskId?: { readonly value: string };
    readonly operationId: { readonly value: string };
    readonly executionEpoch: number;
  };
  readonly turnId?: string;
  readonly requestId?: string;
  readonly parentRequestId?: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly model: string;
  readonly route: string;
  readonly status: number;
  readonly callIds?: readonly string[];
  readonly continuationRef?: string;
}

interface HttpEvidenceReceipt {
  readonly status: number;
  readonly endpoint: string;
  readonly protocol: string;
  readonly model: string;
  readonly route: string;
  readonly requestReceipt: LocalRequestReceiptView;
}

interface NativeLoopHarnessInput {
  readonly binding: ProviderBinding;
  readonly codec: ProviderCodec;
  readonly rounds: readonly (readonly unknown[])[];
  readonly context: ProviderRequestContextHook;
  readonly tools: NonNullable<ProviderStartInput['tools']>;
  readonly execute: (call: ProviderToolCall) => string;
}

interface NativeLoopHarness {
  readonly driver: ProviderAgentDriver;
  readonly calls: RecordedFetchCall[];
  readonly order: string[];
  readonly registrations: NativeRequestRegistration[];
  readonly accepted: RawFactEnvelope[];
  readonly executed: ProviderToolCall[];
  readonly lifecycle: ProviderRequestLifecycleEvent[];
  readonly evidence: ProviderEvidenceWrite[];
  readonly consumed: boolean[];
  readonly read: (ref: EvidenceRef) => Promise<Uint8Array>;
}

function nativeLoopHarness(input: NativeLoopHarnessInput): NativeLoopHarness {
  const order: string[] = [];
  const calls: RecordedFetchCall[] = [];
  const registrations: NativeRequestRegistration[] = [];
  const accepted: RawFactEnvelope[] = [];
  const executed: ProviderToolCall[] = [];
  const lifecycle: ProviderRequestLifecycleEvent[] = [];
  const evidenceWrites: ProviderEvidenceWrite[] = [];
  const consumed: boolean[] = [];
  const assets = new Map<string, Uint8Array>();
  const sink: ProviderEvidenceSink = {
    async write(write) {
      evidenceWrites.push(write);
      if (write.type === 'tool-result-output') order.push(`store:${write.type}`);
      const locator = `${write.type}-${write.locator}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
      const ref: EvidenceRef = {
        evidenceId: id('evidence', locator),
        kind: write.kind,
        source: 'provider-native-loop-consumer-test',
        locator: write.locator,
        scope: write.scope,
      };
      const text = typeof write.content === 'string' ? write.content : JSON.stringify(write.content);
      assets.set(ref.evidenceId.value, new TextEncoder().encode(text));
      return ref;
    },
    async read(ref) {
      return assets.get(ref.evidenceId.value) ?? new Uint8Array();
    },
  };
  let round = 0;
  const fetch: V3ProviderFetch = async (url, init) => {
    const index = round;
    round += 1;
    const events = input.rounds[index];
    if (events === undefined) throw new Error(`unexpected provider fetch #${index + 1}`);
    calls.push({
      url,
      body: JSON.parse(init.body ?? '{}') as Record<string, unknown>,
      rawBody: init.body ?? '',
    });
    order.push(`fetch:${index + 1}`);
    return {
      status: 200,
      body: (async function* (): AsyncIterable<Uint8Array> {
        for (const event of events) yield new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
        consumed[index] = true;
      })(),
      text: async () => '',
    };
  };
  const transport = createHttpProviderTransport({ binding: input.binding, baseUrl: NATIVE_LOOP_BASE_URL, evidence: sink, fetch });
  const adapter = new ProviderAdapter({ binding: input.binding, routeRef: NATIVE_LOOP_ROUTE, codec: input.codec, transport, evidence: sink });
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
  const tag = (parent: string | undefined): 'root' | 'child' => (parent === undefined ? 'root' : 'child');
  const driver = new ProviderAgentDriver({
    port,
    binding: input.binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: NATIVE_LOOP_ASSIGNMENT,
    scope,
    inputRefs: ['input-native-loop'],
    tools: input.tools,
    rawEvidence: sink,
    acceptRawFact: async (envelope) => {
      accepted.push(envelope);
      order.push(`accept:${envelope.fact.kind}:${tag(envelope.request.parentRequestId)}`);
      return { seq: accepted.length, envelope };
    },
    registerRequest: async (registration) => {
      registrations.push(registration);
      order.push(`register:${registration.record.phase}:${tag(registration.record.parentRequestId)}`);
      return registration.record;
    },
    requestContext: async (hookInput) => {
      order.push(`hook:${hookInput.phase}`);
      return input.context(hookInput);
    },
    executeTool: {
      async execute({ call }) {
        order.push(`execute:${call.callId}`);
        executed.push(call);
        return { output: input.execute(call), outputRefs: [], evidenceRefs: [evidence('tool-result')] };
      },
    },
    onRequestLifecycle: (event) => lifecycle.push(event),
  });
  return {
    driver,
    calls,
    order,
    registrations,
    accepted,
    executed,
    lifecycle,
    evidence: evidenceWrites,
    consumed,
    read: (ref) => sink.read(ref),
  };
}

async function runNativeLoop(harness: NativeLoopHarness): Promise<{
  readonly closure: AgentClosure;
  readonly settlement: ProviderSettlement;
  readonly drain: ProviderProducerDrainResult;
  readonly events: ProviderAgentEvent[];
}> {
  await harness.driver.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await harness.driver.submit({
    taskId,
    executionEpoch: identity.executionEpoch,
    assignmentId: NATIVE_LOOP_ASSIGNMENT,
    payload: { prompt: NATIVE_LOOP_LEGACY_SENTINEL },
  });
  const events: ProviderAgentEvent[] = [];
  for await (const event of harness.driver.observe({ runtimeId: identity.runtimeId })) events.push(event);
  const closure = await harness.driver.settle({ runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch });
  const settlement = harness.driver.settlement();
  assert.ok(settlement, 'expected a provider settlement after settle');
  const drain = await harness.driver.closeProductionAndDrain({
    execution: { runtimeId: identity.runtimeId, executionEpoch: identity.executionEpoch },
    boundaryId: 'boundary-native-loop',
  });
  return { closure, settlement, drain, events };
}

function position(order: readonly string[], entry: string): number {
  const index = order.indexOf(entry);
  assert.notEqual(index, -1, `expected order entry ${entry} in ${order.join(',')}`);
  return index;
}

function assertBefore(order: readonly string[], first: string, second: string): void {
  assert.ok(position(order, first) < position(order, second), `expected ${first} before ${second} in ${order.join(',')}`);
}

function factsFor(harness: NativeLoopHarness, tagName: 'root' | 'child'): readonly RawFactEnvelope[] {
  return harness.accepted.filter((entry) => (entry.request.parentRequestId === undefined ? 'root' : 'child') === tagName);
}

function assertRealSettlement(settlement: ProviderSettlement): void {
  assert.equal(settlement.state, 'succeeded');
  assert.equal(settlement.resourceRelease.state, 'released');
  assert.equal(settlement.persistence.state, 'committed');
}

test('J: typed Responses tool loop runs one real transport round trip with fresh continuation context', async () => {
  const output = 'RESPONSES_TOOL_OUTPUT\n{"token":"R_ONLY"}';
  const wireOutput = `${output}${expectedFooter([evidence('tool-result')])}`;
  const harness = nativeLoopHarness({
    binding: responsesBinding,
    codec: new ResponsesProviderCodec(),
    rounds: [
      [
        { type: 'response.created', response: { id: 'resp-loop-1' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-resp', name: 'file_read', arguments: '' } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-resp', name: 'file_read', arguments: '{"path":"README.md"}' } },
        { type: 'response.completed', response: { id: 'resp-loop-1' } },
      ],
      [
        { type: 'response.created', response: { id: 'resp-loop-2' } },
        { type: 'response.output_text.done', item_id: 'msg-loop-2', text: 'read complete' },
        { type: 'response.completed', response: { id: 'resp-loop-2' } },
      ],
    ],
    context: async (input): Promise<MaterializedRequestInput> => input.phase === 'initial'
      ? { canonical: { units: [{ kind: 'message', role: 'user', text: 'CURRENT_TURN_INPUT' }] }, instructions: { text: 'ORIENTATION_ONE' } }
      : {
          canonical: {
            units: [
              { kind: 'message', role: 'user', text: 'CURRENT_TURN_INPUT' },
              { kind: 'tool-call', callId: 'call-resp', toolId: 'file.read', arguments: { path: 'README.md' } },
              { kind: 'tool-result', callId: 'call-resp', toolId: 'file.read', output, evidenceRefs: [evidence('tool-result')], status: 'succeeded' },
            ],
          },
          instructions: { text: 'ORIENTATION_TWO' },
        },
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    execute: () => output,
  });

  const { settlement, drain, events } = await runNativeLoop(harness);

  assertBefore(harness.order, 'register:dispatching:root', 'hook:initial');
  assertBefore(harness.order, 'hook:initial', 'fetch:1');
  assertBefore(harness.order, 'accept:tool-call:root', 'execute:call-resp');
  assertBefore(harness.order, 'execute:call-resp', 'store:tool-result-output');
  assertBefore(harness.order, 'store:tool-result-output', 'accept:tool-result:root');
  assertBefore(harness.order, 'accept:tool-result:root', 'register:dispatching:child');
  assertBefore(harness.order, 'register:dispatching:child', 'hook:continuation');
  assertBefore(harness.order, 'hook:continuation', 'fetch:2');

  assert.deepEqual(harness.registrations.map((entry) => entry.record.phase), ['dispatching', 'dispatched', 'waiting', 'settled', 'dispatching', 'dispatched', 'settled']);
  const rootRequestId = harness.registrations[0]!.record.request.requestId;
  const childDispatch = harness.registrations.find((entry) => entry.record.phase === 'dispatching' && entry.record.parentRequestId === rootRequestId);
  assert.ok(childDispatch, 'expected a continuation dispatching registration bound to the root request');
  assert.notEqual(childDispatch!.record.request.requestId, rootRequestId);
  assert.equal(harness.registrations.every((entry) => entry.execution.runtimeId === identity.runtimeId), true);
  assert.equal(harness.registrations.every((entry) => entry.record.scope.organId.value === organ.value), true);
  assert.deepEqual(harness.lifecycle.map((event) => event.phase), ['dispatching', 'dispatched', 'waiting', 'settled', 'dispatching', 'dispatched', 'settled']);
  assert.equal(harness.lifecycle.every((event) => event.turnId === harness.lifecycle[0]!.turnId), true);
  assert.equal(harness.lifecycle[2]!.externalResponseId, 'resp-loop-1');
  assert.equal(harness.lifecycle.at(-1)!.externalResponseId, 'resp-loop-2');
  assert.equal(harness.lifecycle.filter((event) => event.phase === 'dispatching')[1]!.parentRequestId, rootRequestId);

  const rootFacts = factsFor(harness, 'root');
  assert.deepEqual(rootFacts.map((entry) => [entry.fact.kind, entry.producerSeq]), [['tool-call', 1], ['request-complete', 2], ['tool-result', 3]]);
  const toolResultFact = rootFacts.find((entry) => entry.fact.kind === 'tool-result')!.fact;
  if (toolResultFact.kind !== 'tool-result') throw new Error('unreachable');
  assert.equal(toolResultFact.callId, 'call-resp');
  assert.equal(toolResultFact.continuationRef, 'resp-loop-1');
  assert.equal(new TextDecoder().decode(await harness.read(toolResultFact.rawOutput.ref)), output);
  assert.equal(harness.evidence.find((write) => write.type === 'tool-result-output')?.content, output);
  assert.deepEqual(harness.executed, [{ callId: 'call-resp', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'resp-loop-1' }]);
  assert.equal(harness.accepted.filter((entry) => entry.fact.kind === 'tool-call').length, 1);
  assert.equal(harness.accepted.filter((entry) => entry.fact.kind === 'tool-result').length, 1);

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0]!.url, `${NATIVE_LOOP_BASE_URL}/v1/responses`);
  assert.equal(harness.calls[1]!.url, `${NATIVE_LOOP_BASE_URL}/v1/responses`);
  const startEvidence = harness.evidence.find((write) => write.type === 'start');
  const rootRequest = harness.registrations[0]!.record.request;
  const childRequest = childDispatch!.record.request;
  assert.equal(childRequest.turnId, rootRequest.turnId);
  assert.equal(childRequest.parentRequestId, rootRequest.requestId);
  assert.equal(startEvidence?.locator, 'http://start');
  const startContent = startEvidence?.content as HttpEvidenceReceipt;
  assert.equal(startContent.status, 200);
  assert.equal(startContent.endpoint, '/v1/responses');
  assert.equal(startContent.protocol, 'responses');
  assert.equal(startContent.model, 'model-p');
  assert.equal(startContent.route, nativeRoute('cc'));
  assert.equal(startContent.requestReceipt.body, harness.calls[0]!.rawBody);
  assert.equal(startContent.requestReceipt.identity.runtimeId, identity.runtimeId);
  assert.equal(startContent.requestReceipt.identity.taskId?.value, taskId.value);
  assert.equal(startContent.requestReceipt.identity.operationId.value, operationId.value);
  assert.equal(startContent.requestReceipt.identity.executionEpoch, identity.executionEpoch);
  assert.equal(startContent.requestReceipt.turnId, harness.registrations[0]!.record.request.turnId);
  assert.equal(startContent.requestReceipt.requestId, rootRequestId);
  assert.equal(startContent.requestReceipt.parentRequestId, undefined);
  assert.equal(startContent.requestReceipt.protocol, 'responses');
  assert.equal(startContent.requestReceipt.endpoint, '/v1/responses');
  assert.equal(startContent.requestReceipt.model, 'model-p');
  assert.equal(startContent.requestReceipt.route, nativeRoute('cc'));
  assert.equal(startContent.requestReceipt.status, 200);

  const submitEvidence = harness.evidence.find((write) => write.type === 'submit');
  const submitContent = submitEvidence?.content as HttpEvidenceReceipt;
  assert.equal(submitContent.status, 200);
  assert.equal(submitContent.endpoint, '/v1/responses');
  assert.equal(submitContent.protocol, 'responses');
  assert.equal(submitContent.model, 'model-p');
  assert.equal(submitContent.route, nativeRoute('cc'));
  assert.equal(submitContent.requestReceipt.body, harness.calls[1]!.rawBody);
  assert.equal(submitContent.requestReceipt.identity.runtimeId, identity.runtimeId);
  assert.equal(submitContent.requestReceipt.identity.taskId?.value, taskId.value);
  assert.equal(submitContent.requestReceipt.identity.operationId.value, operationId.value);
  assert.equal(submitContent.requestReceipt.identity.executionEpoch, identity.executionEpoch);
  assert.equal(submitContent.requestReceipt.turnId, childDispatch!.record.request.turnId);
  assert.equal(submitContent.requestReceipt.requestId, childDispatch!.record.request.requestId);
  assert.equal(submitContent.requestReceipt.parentRequestId, rootRequestId);
  assert.equal(submitContent.requestReceipt.protocol, 'responses');
  assert.equal(submitContent.requestReceipt.endpoint, '/v1/responses');
  assert.equal(submitContent.requestReceipt.model, 'model-p');
  assert.equal(submitContent.requestReceipt.route, nativeRoute('cc'));
  assert.equal(submitContent.requestReceipt.status, 200);
  // This consumer carries the continuation through typed requestContext, so the
  // transport has no toolContinuations identity to record and must not derive
  // callIds or continuationRef from the business payload.
  assert.equal(submitContent.requestReceipt.callIds, undefined);
  assert.equal(submitContent.requestReceipt.continuationRef, undefined);
  for (const call of harness.calls) {
    assert.equal('turnId' in call.body, false);
    assert.equal('requestId' in call.body, false);
    assert.equal('parentRequestId' in call.body, false);
  }

  // The Responses wire carries the stable harness tool-surface guidance plus the
  // transient request-scoped orientation.
  assert.match(String(harness.calls[0]!.body.instructions), /ORIENTATION_ONE/);
  assert.deepEqual(harness.calls[0]!.body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CURRENT_TURN_INPUT' }] }]);
  assert.match(String(harness.calls[1]!.body.instructions), /ORIENTATION_TWO/);
  assert.equal(String(harness.calls[1]!.body.instructions).includes('ORIENTATION_ONE'), false);
  assert.equal(JSON.stringify(harness.calls[1]!.body).includes(NATIVE_LOOP_LEGACY_SENTINEL), false);
  const continuationInput = harness.calls[1]!.body.input as readonly Record<string, unknown>[];
  assert.deepEqual(continuationInput.filter((item) => item.type === 'function_call'), [
    { type: 'function_call', call_id: 'call-resp', name: 'file_read', arguments: '{"path":"README.md"}' },
  ]);
  assert.deepEqual(continuationInput.filter((item) => item.type === 'function_call_output'), [
    { type: 'function_call_output', call_id: 'call-resp', output: wireOutput },
  ]);
  assert.equal(continuationInput.filter((item) => item.type === 'message').length, 1);

  assert.equal(harness.consumed[1], true);
  assertRealSettlement(settlement);
  assert.equal(drain.boundaryId, 'boundary-native-loop');
  assert.deepEqual(drain.requests.map((entry) => entry.request.requestId), [rootRequestId, childDispatch!.record.request.requestId]);
  assert.deepEqual(drain.requests.map((entry) => entry.lastProducerSeq), [3, 2]);
  assert.equal(events.at(-1)?.providerEvent.terminalState, 'succeeded');
});

test('J: typed Anthropic tool loop runs one real transport round trip with fresh continuation context', async () => {
  const output = 'ANTHROPIC_TOOL_OUTPUT\n{"token":"A_ONLY"}';
  const wireOutput = `${output}${expectedFooter([evidence('tool-result')])}`;
  const harness = nativeLoopHarness({
    binding: anthropicBinding,
    codec: new AnthropicProviderCodec(1024),
    rounds: [
      [
        { type: 'message_start', message: { id: 'msg-loop-a', model: 'model-p', role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-anthropic', name: 'file_read', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"READ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ME.md"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', message: { id: 'msg-loop-a2', model: 'model-p', role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'read complete' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ],
    ],
    context: async (input): Promise<MaterializedRequestInput> => input.phase === 'initial'
      ? { canonical: { units: [{ kind: 'message', role: 'user', text: 'CURRENT_TURN_INPUT' }] }, instructions: { text: 'ORIENTATION_ONE' } }
      : {
          canonical: {
            units: [
              { kind: 'message', role: 'user', text: 'CURRENT_TURN_INPUT' },
              { kind: 'tool-call', callId: 'call-anthropic', toolId: 'file.read', arguments: { path: 'README.md' } },
              { kind: 'tool-result', callId: 'call-anthropic', toolId: 'file.read', output, evidenceRefs: [evidence('tool-result')], status: 'succeeded' },
            ],
          },
          instructions: { text: 'ORIENTATION_TWO' },
        },
    tools: [{ toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } }],
    execute: () => output,
  });

  const { settlement, drain, events } = await runNativeLoop(harness);

  assertBefore(harness.order, 'register:dispatching:root', 'hook:initial');
  assertBefore(harness.order, 'hook:initial', 'fetch:1');
  assertBefore(harness.order, 'accept:tool-call:root', 'execute:call-anthropic');
  assertBefore(harness.order, 'execute:call-anthropic', 'store:tool-result-output');
  assertBefore(harness.order, 'store:tool-result-output', 'accept:tool-result:root');
  assertBefore(harness.order, 'accept:tool-result:root', 'register:dispatching:child');
  assertBefore(harness.order, 'accept:tool-result:root', 'register:settled:root');
  assertBefore(harness.order, 'register:settled:root', 'register:dispatching:child');
  assertBefore(harness.order, 'register:dispatching:child', 'hook:continuation');
  assertBefore(harness.order, 'hook:continuation', 'fetch:2');

  assert.deepEqual(harness.registrations.map((entry) => entry.record.phase), ['dispatching', 'dispatched', 'waiting', 'settled', 'dispatching', 'dispatched', 'settled']);
  const rootRequestId = harness.registrations[0]!.record.request.requestId;
  const childDispatch = harness.registrations.find((entry) => entry.record.phase === 'dispatching' && entry.record.parentRequestId === rootRequestId);
  assert.ok(childDispatch, 'expected a continuation dispatching registration bound to the root request');
  const rootSettled = harness.registrations.find((entry) => entry.record.phase === 'settled' && entry.record.parentRequestId === undefined);
  assert.ok(rootSettled, 'expected the root request to record its own settled phase before continuation');
  assert.equal(rootSettled!.record.request.requestId, rootRequestId);
  assert.equal(harness.lifecycle.filter((event) => event.phase === 'dispatching')[1]!.parentRequestId, rootRequestId);
  assert.equal(harness.lifecycle.every((event) => event.turnId === harness.lifecycle[0]!.turnId), true);

  assert.deepEqual(harness.executed, [{ callId: 'call-anthropic', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'msg-loop-a' }]);
  const rootFacts = factsFor(harness, 'root');
  const toolCallIndex = rootFacts.findIndex((entry) => entry.fact.kind === 'tool-call');
  const toolResultEntry = rootFacts.find((entry) => entry.fact.kind === 'tool-result');
  assert.ok(toolCallIndex !== -1 && toolResultEntry !== undefined);
  assert.ok(toolResultEntry!.producerSeq > rootFacts[toolCallIndex]!.producerSeq);
  if (toolResultEntry!.fact.kind !== 'tool-result') throw new Error('unreachable');
  assert.equal(toolResultEntry!.fact.callId, 'call-anthropic');
  assert.equal(new TextDecoder().decode(await harness.read(toolResultEntry!.fact.rawOutput.ref)), output);
  assert.equal(harness.evidence.find((write) => write.type === 'tool-result-output')?.content, output);
  assert.equal(harness.accepted.filter((entry) => entry.fact.kind === 'tool-call').length, 1);
  assert.equal(harness.accepted.filter((entry) => entry.fact.kind === 'tool-result').length, 1);
  assert.equal(harness.accepted.filter((entry) => entry.fact.kind === 'request-complete').length, 2);

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0]!.url, `${NATIVE_LOOP_BASE_URL}/v1/messages`);
  assert.equal(harness.calls[1]!.url, `${NATIVE_LOOP_BASE_URL}/v1/messages`);
  const startEvidence = harness.evidence.find((write) => write.type === 'start');
  assert.deepEqual(startEvidence?.content, {
    status: 200, endpoint: '/v1/messages', protocol: 'anthropic', model: 'model-p', route: nativeRoute('goaichat'),
    requestReceipt: {
      body: JSON.stringify(harness.calls[0]!.body), identity,
      turnId: harness.registrations[0]!.record.request.turnId, requestId: rootRequestId,
      status: 200, endpoint: '/v1/messages', protocol: 'anthropic', model: 'model-p', route: nativeRoute('goaichat'),
    },
  });
  assert.equal(startEvidence?.locator, 'http://start');

  assert.equal(harness.calls[0]!.body.system, 'ORIENTATION_ONE');
  assert.equal(harness.calls[0]!.body.max_tokens, 1024);
  assert.deepEqual(harness.calls[0]!.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'CURRENT_TURN_INPUT' }] }]);
  assert.match(String(harness.calls[1]!.body.system), /ORIENTATION_TWO/);
  assert.equal(String(harness.calls[1]!.body.system).includes('ORIENTATION_ONE'), false);
  assert.equal(JSON.stringify(harness.calls[1]!.body).includes(NATIVE_LOOP_LEGACY_SENTINEL), false);
  const blocks = (harness.calls[1]!.body.messages as readonly { content: readonly Record<string, unknown>[] }[]).flatMap((message) => message.content);
  assert.deepEqual(blocks.filter((block) => block.type === 'text'), [{ type: 'text', text: 'CURRENT_TURN_INPUT' }]);
  assert.deepEqual(blocks.filter((block) => block.type === 'tool_use'), [{ type: 'tool_use', id: 'call-anthropic', name: 'file.read', input: { path: 'README.md' } }]);
  assert.deepEqual(blocks.filter((block) => block.type === 'tool_result'), [{ type: 'tool_result', tool_use_id: 'call-anthropic', content: wireOutput }]);

  assert.equal(harness.consumed[1], true);
  assertRealSettlement(settlement);
  assert.deepEqual(drain.requests.map((entry) => entry.request.requestId), [rootRequestId, childDispatch!.record.request.requestId]);
  assert.equal(events.at(-1)?.providerEvent.terminalState, 'succeeded');
});

test('J: typed Chat tool loop runs one real transport round trip with two tools in one assistant group', async () => {
  const readOutput = 'CHAT_READ_OUTPUT\n{"token":"C_READ"}';
  const listOutput = 'CHAT_LIST_OUTPUT\n{"token":"C_LIST"}';
  const readWire = `${readOutput}${expectedFooter([evidence('tool-result')])}`;
  const listWire = `${listOutput}${expectedFooter([evidence('tool-result')])}`;
  const outputs = new Map([['call-chat-read', readOutput], ['call-chat-list', listOutput]]);
  const harness = nativeLoopHarness({
    binding: openaiBinding,
    codec: new OpenAIChatProviderCodec(),
    rounds: [
      [
        { protocol: 'openai', type: 'openai.chat.completion', id: 'chat-loop-1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
          { index: 0, id: 'call-chat-read', type: 'function', function: { name: 'file_read', arguments: '{"path":' } },
          { index: 1, id: 'call-chat-list', type: 'function', function: { name: 'file_list', arguments: '{"dir":' } },
        ] }, finish_reason: null }] },
        { protocol: 'openai', type: 'openai.chat.completion', id: 'chat-loop-1', choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, function: { arguments: '"README.md"}' } },
          { index: 1, function: { arguments: '"."}' } },
        ] }, finish_reason: null }] },
        { protocol: 'openai', type: 'openai.chat.completion', id: 'chat-loop-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ],
      [
        { protocol: 'openai', type: 'openai.chat.completion', id: 'chat-loop-2', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
        { protocol: 'openai', type: 'openai.chat.completion', id: 'chat-loop-2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ],
    ],
    context: async (input): Promise<MaterializedRequestInput> => input.phase === 'initial'
      ? { canonical: { units: [{ kind: 'message', role: 'user', text: 'CURRENT_TURN_INPUT' }] }, instructions: { text: 'ORIENTATION_ONE' } }
      : {
          canonical: {
            units: [
              { kind: 'message', role: 'user', text: 'CURRENT_TURN_INPUT' },
              { kind: 'tool-call', callId: 'call-chat-read', toolId: 'file.read', arguments: { path: 'README.md' } },
              { kind: 'tool-call', callId: 'call-chat-list', toolId: 'file.list', arguments: { dir: '.' } },
              { kind: 'tool-result', callId: 'call-chat-read', toolId: 'file.read', output: readOutput, evidenceRefs: [evidence('tool-result')], status: 'succeeded' },
              { kind: 'tool-result', callId: 'call-chat-list', toolId: 'file.list', output: listOutput, evidenceRefs: [evidence('tool-result')], status: 'succeeded' },
            ],
          },
          instructions: { text: 'ORIENTATION_TWO' },
        },
    tools: [
      { toolId: 'file.read', description: 'read file', inputSchema: { type: 'object' } },
      { toolId: 'file.list', description: 'list dir', inputSchema: { type: 'object' } },
    ],
    execute: (call) => outputs.get(call.callId) ?? '',
  });

  const { settlement, drain, events } = await runNativeLoop(harness);

  assertBefore(harness.order, 'register:dispatching:root', 'hook:initial');
  assertBefore(harness.order, 'hook:initial', 'fetch:1');
  assertBefore(harness.order, 'accept:tool-call:root', 'execute:call-chat-read');
  assertBefore(harness.order, 'execute:call-chat-read', 'execute:call-chat-list');
  assert.ok(harness.order.lastIndexOf('accept:tool-result:root') < position(harness.order, 'register:settled:root'), 'expected every root tool result to be accepted before the root request settles');
  assert.ok(position(harness.order, 'register:settled:root') < position(harness.order, 'register:dispatching:child'));
  assertBefore(harness.order, 'register:dispatching:child', 'hook:continuation');
  assertBefore(harness.order, 'hook:continuation', 'fetch:2');

  assert.deepEqual(harness.registrations.map((entry) => entry.record.phase), ['dispatching', 'dispatched', 'waiting', 'settled', 'dispatching', 'dispatched', 'settled']);
  const rootRequestId = harness.registrations[0]!.record.request.requestId;
  const childDispatch = harness.registrations.find((entry) => entry.record.phase === 'dispatching' && entry.record.parentRequestId === rootRequestId);
  assert.ok(childDispatch, 'expected a continuation dispatching registration bound to the root request');
  const rootSettled = harness.registrations.find((entry) => entry.record.phase === 'settled' && entry.record.parentRequestId === undefined);
  assert.ok(rootSettled, 'expected the root request to record its own settled phase before continuation');
  assert.equal(rootSettled!.record.request.requestId, rootRequestId);
  assert.equal(harness.lifecycle.filter((event) => event.phase === 'dispatching')[1]!.parentRequestId, rootRequestId);
  assert.equal(harness.lifecycle.every((event) => event.turnId === harness.lifecycle[0]!.turnId), true);

  assert.deepEqual(harness.executed, [
    { callId: 'call-chat-read', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'chat-loop-1' },
    { callId: 'call-chat-list', toolId: 'file.list', arguments: { dir: '.' }, continuationRef: 'chat-loop-1' },
  ]);
  const rootFacts = factsFor(harness, 'root');
  assert.equal(rootFacts.filter((entry) => entry.fact.kind === 'tool-call').length, 2);
  assert.equal(rootFacts.filter((entry) => entry.fact.kind === 'tool-result').length, 2);
  const readResult = rootFacts.find((entry) => entry.fact.kind === 'tool-result' && entry.fact.callId === 'call-chat-read')!.fact;
  const listResult = rootFacts.find((entry) => entry.fact.kind === 'tool-result' && entry.fact.callId === 'call-chat-list')!.fact;
  if (readResult.kind !== 'tool-result' || listResult.kind !== 'tool-result') throw new Error('unreachable');
  assert.equal(new TextDecoder().decode(await harness.read(readResult.rawOutput.ref)), readOutput);
  assert.equal(new TextDecoder().decode(await harness.read(listResult.rawOutput.ref)), listOutput);
  const storedOutputs = harness.evidence.filter((write) => write.type === 'tool-result-output').map((write) => write.content);
  assert.deepEqual(storedOutputs, [readOutput, listOutput]);
  assert.equal(harness.accepted.filter((entry) => entry.fact.kind === 'tool-call').length, 2);
  assert.equal(harness.accepted.filter((entry) => entry.fact.kind === 'tool-result').length, 2);

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0]!.url, `${NATIVE_LOOP_BASE_URL}/v1/chat/completions`);
  assert.equal(harness.calls[1]!.url, `${NATIVE_LOOP_BASE_URL}/v1/chat/completions`);
  const startEvidence = harness.evidence.find((write) => write.type === 'start');
  assert.deepEqual(startEvidence?.content, {
    status: 200, endpoint: '/v1/chat/completions', protocol: 'openai', model: 'model-p', route: nativeRoute('openai-chat'),
    requestReceipt: {
      body: JSON.stringify(harness.calls[0]!.body), identity,
      turnId: harness.registrations[0]!.record.request.turnId, requestId: rootRequestId,
      status: 200, endpoint: '/v1/chat/completions', protocol: 'openai', model: 'model-p', route: nativeRoute('openai-chat'),
    },
  });
  assert.equal(startEvidence?.locator, 'http://start');

  const continuationMessages = harness.calls[1]!.body.messages as readonly Record<string, unknown>[];
  assert.equal(continuationMessages[0]!.role, 'system');
  assert.match(String(continuationMessages[0]!.content), /ORIENTATION_TWO/);
  assert.equal(String(continuationMessages[0]!.content).includes('ORIENTATION_ONE'), false);
  assert.deepEqual(continuationMessages.slice(1), [
    { role: 'user', content: 'CURRENT_TURN_INPUT' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call-chat-read', type: 'function', function: { name: 'file_read', arguments: '{"path":"README.md"}' } },
      { id: 'call-chat-list', type: 'function', function: { name: 'file_list', arguments: '{"dir":"."}' } },
    ] },
    { role: 'tool', tool_call_id: 'call-chat-read', content: readWire },
    { role: 'tool', tool_call_id: 'call-chat-list', content: listWire },
  ]);
  assert.equal(continuationMessages.filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)).length, 1);
  assert.equal(JSON.stringify(harness.calls[1]!.body).includes(NATIVE_LOOP_LEGACY_SENTINEL), false);

  assert.equal(harness.consumed[1], true);
  assertRealSettlement(settlement);
  assert.deepEqual(drain.requests.map((entry) => entry.request.requestId), [rootRequestId, childDispatch!.record.request.requestId]);
  assert.equal(events.at(-1)?.providerEvent.terminalState, 'succeeded');
});
