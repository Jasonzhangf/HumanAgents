import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderToolCall,
  type RawFactEnvelope,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  AnthropicProviderCodec,
  ProviderAdapter,
  ProviderAdapterError,
  ProviderAgentDriver,
  type AnthropicWireRequest,
  type ProviderAgentEvent,
  type ProviderEvidenceSink,
  type ProviderEvidenceWrite,
  type ProviderTransport,
  type ProviderWireRequest,
  type ProviderWireEvent,
} from '../../../packages/adapters/provider/src/index.js';
import { invalidToolArguments } from '../../../packages/adapters/provider/src/tool-arguments.js';

const organId = id('organ', 'organ-anthropic-correction');
const taskId = id('task', 'task-anthropic-correction');
const operationId = id('operation', 'operation-anthropic-correction');
const scope: ScopeRef = { organId, taskId, operationId };
const identity = { runtimeId: 'runtime-anthropic-correction', taskId, operationId, executionEpoch: 1 };
const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'anthropic-correction-scope'),
  kind: 'operation',
  source: 'test',
  locator: 'operation/operation-anthropic-correction',
  scope,
};
const binding: ProviderBinding = {
  bindingId: 'binding-anthropic-correction',
  providerId: 'provider-anthropic',
  protocol: 'anthropic',
  endpointRef: 'endpoint-anthropic',
  modelRef: 'model-anthropic',
  configDigest: 'sha256:config',
  capabilityDigest: 'sha256:capability',
};

/** One real Anthropic Messages answer that requests one tool with `raw` input JSON. */
function anthropicToolRound(messageId: string, callId: string, name: string, raw: string): ProviderWireEvent[] {
  return [
    { protocol: 'anthropic', type: 'message_start', message: { id: messageId, model: 'model-anthropic', role: 'assistant' } },
    { protocol: 'anthropic', type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name, input: {} } },
    { protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: raw } },
    { protocol: 'anthropic', type: 'content_block_stop', index: 0 },
    { protocol: 'anthropic', type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { protocol: 'anthropic', type: 'message_stop' },
  ];
}

function anthropicFinalRound(messageId: string, text: string): ProviderWireEvent[] {
  return [
    { protocol: 'anthropic', type: 'message_start', message: { id: messageId, model: 'model-anthropic', role: 'assistant' } },
    { protocol: 'anthropic', type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { protocol: 'anthropic', type: 'content_block_stop', index: 0 },
    { protocol: 'anthropic', type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { protocol: 'anthropic', type: 'message_stop' },
  ];
}

function memoryEvidenceSink(): ProviderEvidenceSink {
  const content = new Map<string, Uint8Array>();
  return {
    async write(input: ProviderEvidenceWrite) {
      const ref: EvidenceRef = {
        evidenceId: id('evidence', `anthropic-correction-${input.type}-${content.size + 1}`),
        kind: input.kind,
        source: 'anthropic-correction-test',
        locator: input.locator,
        scope: input.scope,
      };
      content.set(ref.evidenceId.value, new TextEncoder().encode(
        typeof input.content === 'string' ? input.content : JSON.stringify(input.content),
      ));
      return ref;
    },
    async read(ref) {
      const bytes = content.get(ref.evidenceId.value);
      if (!bytes) throw new Error(`missing provider evidence ${ref.evidenceId.value}`);
      return bytes;
    },
  };
}

interface CorrectionHarness {
  readonly instance: ProviderAgentDriver;
  readonly requests: ProviderWireRequest[];
  readonly accepted: RawFactEnvelope[];
  readonly executed: ProviderToolCall[];
}

/** Real ProviderAgentDriver + ProviderAdapter + AnthropicProviderCodec over scripted wire events. */
function harness(rounds: readonly (readonly ProviderWireEvent[])[]): CorrectionHarness {
  const requests: ProviderWireRequest[] = [];
  const accepted: RawFactEnvelope[] = [];
  const executed: ProviderToolCall[] = [];
  const sink = memoryEvidenceSink();
  let round = 0;
  const transport: ProviderTransport = {
    start: async (_input, request) => {
      requests.push(request);
      return { ...identity, startedAt: '2026-01-01T00:00:00.000Z', evidenceRefs: [evidence] };
    },
    resume: async () => {
      throw new Error('not used');
    },
    submit: async (_input, request) => {
      requests.push(request);
      return { ...identity, status: 'accepted', outputRefs: [], evidenceRefs: [evidence] };
    },
    observe: async function* () {
      yield* rounds[round] ?? [];
      round += 1;
    },
    requestStop: async () => ({
      ...identity,
      status: 'accepted',
      receivedAt: '2026-01-01T00:00:00.000Z',
      evidenceRefs: [evidence],
    }),
    settle: async () => ({
      ...identity,
      state: 'succeeded',
      evidenceRefs: [evidence],
      resourceRelease: { state: 'released', evidenceRefs: [evidence] },
      persistence: { state: 'committed', evidenceRefs: [evidence] },
    }),
    close: async () => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'closed',
      evidenceRefs: [evidence],
    }),
  };
  const adapter = new ProviderAdapter({ binding, routeRef: 'anthropic-route', codec: new AnthropicProviderCodec(4096), transport, evidence: sink });
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
  const instance = new ProviderAgentDriver({
    port,
    binding,
    runtimeId: identity.runtimeId,
    taskId,
    operationId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-anthropic-correction',
    scope,
    inputRefs: ['input-1'],
    tools: [{ toolId: 'file.read', description: 'read a file', inputSchema: { type: 'object' } }],
    rawEvidence: sink,
    acceptRawFact: async (envelope) => {
      accepted.push(envelope);
      return { seq: accepted.length, envelope };
    },
    registerRequest: async (registration) => registration.record,
    executeTool: {
      async execute({ call }) {
        executed.push(call);
        return { output: 'README_CONTENT', outputRefs: [], evidenceRefs: [evidence] };
      },
    },
  });
  return { instance, requests, accepted, executed };
}

async function run(instance: ProviderAgentDriver): Promise<ProviderAgentEvent[]> {
  await instance.start({ runtimeId: identity.runtimeId, taskId, executionEpoch: identity.executionEpoch });
  await instance.submit({
    taskId,
    executionEpoch: identity.executionEpoch,
    assignmentId: 'assignment-anthropic-correction',
    payload: { prompt: 'read README.md' },
  });
  const observed: ProviderAgentEvent[] = [];
  for await (const event of instance.observe({ runtimeId: identity.runtimeId })) observed.push(event);
  return observed;
}

function blocks(request: ProviderWireRequest) {
  assert.equal(request.protocol, 'anthropic');
  return (request as AnthropicWireRequest).messages.flatMap((message) => message.content);
}

test('anthropic malformed tool JSON returns a correctable tool_result by tool_use_id and the next legal call executes', async () => {
  const h = harness([
    anthropicToolRound('msg-bad', 'call-bad', 'file_read', '{bad'),
    anthropicToolRound('msg-good', 'call-good', 'file_read', '{"path":"README.md"}'),
    anthropicFinalRound('msg-final', 'done'),
  ]);
  const observed = await run(h.instance);

  // The malformed call never reaches the executor; the legal one runs once.
  assert.deepEqual(h.executed, [
    { callId: 'call-good', toolId: 'file.read', arguments: { path: 'README.md' }, continuationRef: 'msg-good' },
  ]);
  const badCallEvents = observed.filter((event) => event.providerEvent.toolCall?.callId === 'call-bad');
  assert.equal(badCallEvents.length, 1);
  assert.equal(badCallEvents[0]?.providerEvent.summary, '调用工具参数无效：file.read');
  const badCall = badCallEvents[0]?.providerEvent.toolCall;
  assert.ok(badCall);
  assert.equal(badCall.toolId, 'file.read');
  assert.equal(badCall.continuationRef, 'msg-bad');
  assert.deepEqual(badCall.arguments, {});
  assert.equal(invalidToolArguments(badCall.arguments)?.rawArguments, '{bad');
  assert.deepEqual(
    observed.flatMap((event) => event.providerEvent.toolResult === undefined
      ? []
      : [[event.providerEvent.toolResult.callId, event.providerEvent.toolResult.status, event.providerEvent.toolResult.error?.code]]),
    [['call-bad', 'failed', 'tool.arguments.invalid-json'], ['call-good', 'succeeded', undefined]],
  );
  assert.equal(observed.at(-1)?.terminalState, 'succeeded');
  assert.equal(h.requests.length, 3);

  // Round 2 is a real Anthropic Messages request: the original tool_use id is kept and
  // followed by its paired tool_result carrying the exact malformed attempt.
  const correction = blocks(h.requests[1]!);
  const toolUses = correction.filter((block) => block.type === 'tool_use');
  assert.deepEqual(toolUses.map((block) => block.type === 'tool_use' ? [block.id, block.name, block.input] : undefined), [
    // The request declares canonical tool names; the model's `file_read` was a decode alias.
    ['call-bad', 'file.read', {}],
  ]);
  assert.deepEqual((h.requests[1] as AnthropicWireRequest).tools?.map((tool) => tool.name), ['file.read']);
  const toolResults = correction.filter((block) => block.type === 'tool_result');
  assert.equal(toolResults.length, 1);
  const badResult = toolResults[0];
  assert.ok(badResult && badResult.type === 'tool_result');
  assert.equal(badResult.tool_use_id, 'call-bad');
  assert.match(badResult.content, /"code":"tool.arguments.invalid-json"/);
  assert.match(badResult.content, /"executed":false/);
  assert.match(badResult.content, /"rawArguments":"\{bad"/);
  assert.match(badResult.content, /"recoverable":true/);

  // Round 3 keeps the complete paired history before the final answer.
  const final = blocks(h.requests[2]!);
  assert.deepEqual(final.filter((block) => block.type === 'tool_use').map((block) => block.type === 'tool_use' ? block.id : undefined), ['call-bad', 'call-good']);
  assert.deepEqual(final.filter((block) => block.type === 'tool_result').map((block) => block.type === 'tool_result' ? block.tool_use_id : undefined), ['call-bad', 'call-good']);
});

test('anthropic stream that ends before content_block_stop synthesizes no tool call or result', async () => {
  const h = harness([[
    { protocol: 'anthropic', type: 'message_start', message: { id: 'msg-cut', model: 'model-anthropic', role: 'assistant' } },
    { protocol: 'anthropic', type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-cut', name: 'file_read', input: {} } },
    { protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{bad' } },
  ]]);
  const observed = await run(h.instance);

  assert.equal(observed.some((event) => event.providerEvent.toolCall !== undefined), false);
  assert.equal(observed.some((event) => event.providerEvent.toolResult !== undefined), false);
  assert.equal(observed.at(-1)?.terminalState, undefined);
  assert.deepEqual(h.executed, []);
  assert.equal(h.requests.length, 1);
  assert.equal(h.accepted.some((envelope) => envelope.fact.kind === 'tool-call' || envelope.fact.kind === 'tool-result'), false);
});
test('anthropic stream that stops after the malformed block but before message_stop executes and returns nothing', async () => {
  const h = harness([[
    { protocol: 'anthropic', type: 'message_start', message: { id: 'msg-cut-late', model: 'model-anthropic', role: 'assistant' } },
    { protocol: 'anthropic', type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-cut-late', name: 'file_read', input: {} } },
    { protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{bad' } },
    { protocol: 'anthropic', type: 'content_block_stop', index: 0 },
  ]]);
  await assert.rejects(
    () => run(h.instance),
    (error: unknown) => error instanceof ProviderAdapterError && error.providerError.code === 'tool.terminal.missing',
  );

  assert.deepEqual(h.executed, []);
  assert.equal(h.requests.length, 1);
  assert.equal(h.accepted.some((envelope) => envelope.fact.kind === 'tool-result'), false);
});

test('anthropic provider error event after the malformed delta surfaces as a provider failure without a tool result', async () => {
  const h = harness([[
    { protocol: 'anthropic', type: 'message_start', message: { id: 'msg-error', model: 'model-anthropic', role: 'assistant' } },
    { protocol: 'anthropic', type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-error', name: 'file_read', input: {} } },
    { protocol: 'anthropic', type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{bad' } },
    { protocol: 'anthropic', type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  ]]);
  const observed = await run(h.instance);

  assert.deepEqual(observed.filter((event) => event.providerEvent.kind === 'error').map((event) => event.providerEvent.error?.code), ['overloaded_error']);
  assert.equal(observed.some((event) => event.providerEvent.toolCall !== undefined || event.providerEvent.toolResult !== undefined), false);
  assert.equal(observed.at(-1)?.terminalState, undefined);
  assert.deepEqual(h.executed, []);
  assert.equal(h.requests.length, 1);
  assert.equal(h.accepted.some((envelope) => envelope.fact.kind === 'tool-call' || envelope.fact.kind === 'tool-result'), false);
});
