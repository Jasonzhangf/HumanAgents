import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type BusinessPayload, type CycleId, type OperationId, type OrganId } from '../../../packages/contracts/src/index.js';
import {
  ACP_JSONRPC,
  ACP_PROTOCOL_VERSION,
  assertAcpInitializeResult,
  assertAcpNewSessionResult,
  assertAcpPromptResult,
  assertAcpSessionUpdateNotification,
  decodeAcpFrame,
  encodeAcpNotification,
  encodeAcpRequest,
  isAcpResponse,
} from '../../../packages/adapters/acp/protocol.js';
import { createAcpClientDriver } from '../../../packages/adapters/acp/acp-client-driver.js';
import { createAntigravityRuntime } from '../../../packages/adapters/acp/antigravity.js';
import { createDshRuntime } from '../../../packages/adapters/acp/dsh.js';
import {
  createOpencodeRuntime,
} from '../../../packages/adapters/acp/opencode.js';
import type {
  AcpRuntimeAdaptor,
  AcpRuntimeCancelInput,
  AcpRuntimeCancelResult,
  AcpRuntimeCloseInput,
  AcpRuntimeCloseResult,
  AcpRuntimeLoadInput,
  AcpRuntimeOpenInput,
  AcpRuntimeOpenResult,
  AcpRuntimeSession,
  AcpRuntimeSubmitInput,
  AcpRuntimeSubmitResult,
} from '../../../packages/adapters/acp/runtime.js';

const taskId = id('task', 'task-a');
const operationId: OperationId = id('operation', 'operation-a');
const assignmentId = 'runtime-a';
const epoch = 1;

const submitPayload: BusinessPayload = { prompt: 'reply with exactly POGS' };

function startInput(overrides: {
  readonly runtimeId?: string;
  readonly assignmentId?: string;
  readonly operationId?: OperationId;
  readonly organId?: OrganId;
  readonly cycleId?: CycleId;
} = {}) {
  return {
    runtimeId: overrides.runtimeId ?? 'runtime-a',
    taskId,
    executionEpoch: epoch,
    assignmentId: overrides.assignmentId ?? assignmentId,
    organId: overrides.organId ?? id('organ', 'organ-a'),
    cycleId: overrides.cycleId ?? id('cycle', 'task-a-cycle-1'),
    operationId: overrides.operationId ?? operationId,
  };
}

test('ACP codec encodes a request and decodes its shape', () => {
  const frame = encodeAcpRequest('session/new', 7, { cwd: '/workspace' });
  const decoded = decodeAcpFrame(frame);
  const request = decoded as { readonly jsonrpc: string; readonly id: number; readonly method: string; readonly params: unknown; readonly result?: unknown; readonly error?: unknown };
  assert.equal(request.jsonrpc, '2.0');
  assert.equal(request.id, 7);
  assert.equal(request.method, 'session/new');
  assert.deepEqual(request.params, { cwd: '/workspace' });
  // A request carries a method and params, never a result or an error.
  assert.equal('method' in decoded, true);
  assert.equal('result' in decoded, false);
  assert.equal('error' in decoded, false);
});

test('ACP codec marks a correlated response frame', () => {
  const response = { jsonrpc: '2.0' as const, id: 3, result: { stopReason: 'end_turn' as const } };
  assert.equal(isAcpResponse(response), true);
  assert.equal(isAcpResponse({ jsonrpc: '2.0' as const, method: 'session/cancel', params: {} }), false);
});

test('ACP codec encodes a notification without an id', () => {
  const frame = encodeAcpNotification('session/cancel', { sessionId: 'ses-1' });
  const decoded = decodeAcpFrame(frame);
  assert.equal('id' in decoded, false);
  const notification = decoded as { readonly method: string; readonly params: unknown };
  assert.equal(notification.method, 'session/cancel');
  assert.deepEqual(notification.params, { sessionId: 'ses-1' });
});

test('ACP initialize rejects a wrong protocolVersion', () => {
  assert.throws(() => assertAcpInitializeResult({ protocolVersion: 2 }), /unsupported protocolVersion 2/);
  assert.equal(assertAcpInitializeResult({ protocolVersion: ACP_PROTOCOL_VERSION }).protocolVersion, ACP_PROTOCOL_VERSION);
});

test('ACP session/update rejects an unknown sessionUpdate kind instead of dropping it', () => {
  assert.throws(
    () => assertAcpSessionUpdateNotification({ sessionId: 'ses-1', update: { sessionUpdate: 'nope', content: { type: 'text', text: 'x' } } }),
    /unknown sessionUpdate kind nope/,
  );
  const accepted = assertAcpSessionUpdateNotification({
    sessionId: 'ses-1',
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'hello' } },
  });
  assert.equal(accepted.update.sessionUpdate, 'agent_message_chunk');
});

test('ACP prompt result validates stopReason and rejects unknown values', () => {
  assert.equal(assertAcpPromptResult({ stopReason: 'end_turn' }).stopReason, 'end_turn');
  assert.equal(assertAcpNewSessionResult({ sessionId: 'ses-1' }).sessionId, 'ses-1');
  assert.throws(() => assertAcpPromptResult({ stopReason: 'done' }), /invalid stopReason done/);
  assert.throws(() => assertAcpNewSessionResult({ sessionId: 7 }), /sessionId/);
});

function failWith(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, name: 'AcpAdapterError' });
}

test('ACP driver rejects a stop request whose operation id does not match', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  await assert.rejects(
    driver.requestStop({ runtimeId: 'runtime-a', executionEpoch: epoch, operationId: id('operation', 'other') }),
    (error: Error & { code?: string }) => error.code === 'identity-mismatch' && /does not match/.test(error.message),
  );
  await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
});

test('ACP driver requires HumanAgent-owned identity before opening a session', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await assert.rejects(
    driver.start({ runtimeId: 'runtime-a', taskId, executionEpoch: epoch, assignmentId }),
    (error: Error & { code?: string; message: string }) => error.code === 'identity-mismatch' && /requires HumanAgent-owned/.test(error.message),
  );
});

test('ACP driver evidence scope comes from the app, never minted by the driver', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  const handle = await driver.start(startInput({
    organId: id('organ', 'organ-a'),
    cycleId: id('cycle', 'task-a-cycle-1'),
    operationId,
  }));
  const output = await driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: submitPayload });

  const scopes = output.evidenceRefs.map((ref) => ref.scope);
  assert.equal(scopes.length, 1);
  for (const scope of scopes) {
    assert.equal(scope.organId.value, 'organ-a');
    assert.equal(scope.taskId?.value, 'task-a');
    assert.equal(scope.cycleId?.value, 'task-a-cycle-1');
    assert.equal(scope.operationId?.value, 'operation-a');
  }
  await driver.settle(handle);
});

test('ACP driver returns the runtime output and settles as succeeded', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  const handle = await driver.start(startInput());
  assert.equal(handle.runtimeId, 'runtime-a');

  // Observe must start before the turn runs, but the stream only ends when
  // settle finishes it, so awaiting the events comes after settle.
  const eventsPromise = collectEvents(driver, 'runtime-a');
  const output = await driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: submitPayload });
  assert.equal(output.payload.stopReason, 'end_turn');
  assert.equal(output.payload.outputText, 'POGS');
  assert.equal(output.payload.userMessageId, 'ha-msg-runtime-a-1-1');

  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
  assert.equal(closure.state, 'succeeded');

  const events = await eventsPromise;
  assert.deepEqual(events.map((event) => event.kind), ['output', 'terminal']);
  assert.equal(events[0]!.summary, 'POGS');
  assert.equal(events[1]!.terminalState, 'succeeded');
});
test('ACP driver surfaces a submit failure as a failure, never as success', async () => {
  const runtime = makeFakeRuntime({
    submitFailure: failWith('transport-failure', 'prompt exploded'),
  });
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  await assert.rejects(
    driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: submitPayload }),
    (error: Error & { code?: string; message: string }) => error.code === 'transport-failure' && /prompt exploded/.test(error.message),
  );

  // The failed turn must settle as failed, not as succeeded.
  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
  assert.equal(closure.state, 'failed');
});

test('ACP driver maps a cancelled turn to cancelled and settles as stopped', async () => {
  const runtime = makeFakeRuntime({ submitResult: { stopReason: 'cancelled', outputText: '' } });
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  const output = await driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: submitPayload });
  assert.equal(output.payload.stopReason, 'cancelled');

  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
  assert.equal(closure.state, 'stopped');
});

test('ACP driver does not report stopped from a cancel acceptance alone', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  const receipt = await driver.requestStop({ runtimeId: 'runtime-a', executionEpoch: epoch, operationId });
  assert.equal(receipt.requested, true);

  // Accepted is not stopped: settle must report stopped only because the
  // runtime confirmed the close.
  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
  assert.equal(closure.state, 'stopped');
});

test('ACP driver reports unknown instead of stopped when the runtime refuses to close', async () => {
  const runtime = makeFakeRuntime({ closeResult: { closed: false, evidenceRef: 'evidence/a' } });
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  const receipt = await driver.requestStop({ runtimeId: 'runtime-a', executionEpoch: epoch, operationId });
  assert.equal(receipt.requested, true);

  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
  assert.equal(closure.state, 'unknown');
});

test('ACP driver keeps a close failure visible instead of resolving the session', async () => {
  const runtime = makeFakeRuntime({ closeFailure: failWith('transport-closed', 'close refused') });
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  await assert.rejects(
    driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch }),
    (error: Error & { code?: string }) => error.code === 'transport-closed',
  );
});

test('ACP driver refuses a resume for a runtime without session load support', async () => {
  const runtime = makeFakeRuntime({ loadFailure: failWith('capability-unavailable', 'load not supported') });
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  // The driver keeps the runtime's own load error visible instead of hiding it
  // behind a generic failure.
  await assert.rejects(
    driver.resume({ ...startInput(), checkpointId: id('checkpoint', 'cp-1') }),
    (error: Error & { code?: string; message: string }) =>
      error.code === 'capability-unavailable' && /load not supported/.test(error.message),
  );
});

test('ACP driver exposes runtime capabilities and the ACP capability set', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  const capabilities = await driver.capabilities();
  assert.equal(capabilities.driverKind, 'humanagent.agent-driver.acp');
  assert.deepEqual(capabilities.capabilities.filter((value) => value.startsWith('acp.')), [
    'acp.v1', 'acp.session', 'acp.prompt', 'acp.cancel', 'acp.settle', 'acp.shim',
  ]);
  assert.equal(capabilities.version, 'test-runtime-1');
});

test('ACP session id stays evidence only and is never a runtime id', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  const handle = await driver.start(startInput());
  assert.equal(handle.runtimeId, 'runtime-a');
  const output = await driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: submitPayload });
  // The output payload must not leak the backend session id as an identity.
  assert.equal(output.payload.sessionId, undefined);
  assert.equal(output.assignmentId, assignmentId);
});

/**
 * Consumes the driver's observation stream exactly as `serve-orchestration`
 * does: stop at the first terminal event. Draining the stream to its end would
 * instead wait for `settle`, which is not the real consumption pattern.
 */
async function collectEvents(
  driver: { readonly observe: (input: { readonly runtimeId: string }) => AsyncIterable<{ readonly kind: string; readonly summary?: string; readonly terminalState?: string }> },
  runtimeId: string,
): Promise<Array<{ readonly kind: string; readonly summary?: string; readonly terminalState?: string }>> {
  const events: Array<{ readonly kind: string; readonly summary?: string; readonly terminalState?: string }> = [];
  for await (const event of driver.observe({ runtimeId })) {
    events.push({
      kind: event.kind,
      ...(event.summary === undefined ? {} : { summary: event.summary }),
      ...(event.terminalState === undefined ? {} : { terminalState: event.terminalState }),
    });
    if (event.kind === 'terminal') break;
  }
  return events;
}

/**
 * A deterministic fake ACP runtime for driver-level tests. It never spawns a
 * process: it records the calls and returns scripted results, so each test
 * asserts one driver decision in isolation.
 */
function makeFakeRuntime(
  options: {
    readonly submitResult?: { readonly stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'; readonly outputText: string };
    readonly submitFailure?: Error;
    readonly cancelResult?: { readonly accepted: boolean; readonly evidenceRef?: string };
    readonly closeResult?: AcpRuntimeCloseResult;
    readonly closeFailure?: Error;
    readonly loadFailure?: Error;
  } = {},
): AcpRuntimeAdaptor {
  const closeResult: AcpRuntimeCloseResult = options.closeResult ?? { closed: true, evidenceRef: 'evidence/close' };
  return {
    runtime: 'opencode',
    kind: 'shim',
    version: 'test-runtime-1',
    evidenceRef: 'evidence/runtime',
    capabilities: ['acp.shim'],

    async open(input: AcpRuntimeOpenInput): Promise<AcpRuntimeOpenResult> {
      return {
        sessionId: input.sessionIdFor ? input.sessionIdFor(input.runtimeId) : `session-${input.runtimeId}`,
        initialize: { protocolVersion: ACP_PROTOCOL_VERSION, agentInfo: { name: 'test-runtime', version: 'test-runtime-1' } },
        implementation: { name: 'test-runtime', version: 'test-runtime-1' },
        capabilities: {},
        protocol: 'shim',
        backendRef: 'evidence/backend',
      };
    },

    async load(_input: AcpRuntimeLoadInput): Promise<AcpRuntimeSession> {
      if (options.loadFailure) throw options.loadFailure;
      return { sessionId: 'session-resumed' };
    },

    async submit(input: AcpRuntimeSubmitInput): Promise<AcpRuntimeSubmitResult> {
      if (options.submitFailure) throw options.submitFailure;
      const result = options.submitResult ?? { stopReason: 'end_turn' as const, outputText: 'POGS' };
      return {
        stopReason: result.stopReason,
        outputText: result.outputText,
        userMessageId: input.messageId,
      };
    },

    async cancel(_input: AcpRuntimeCancelInput): Promise<AcpRuntimeCancelResult> {
      return options.cancelResult ?? { accepted: true, evidenceRef: 'evidence/cancel' };
    },

    async close(_input: AcpRuntimeCloseInput): Promise<AcpRuntimeCloseResult> {
      if (options.closeFailure) throw options.closeFailure;
      return closeResult;
    },
  };
}

test('ACP runtime shim reports its protocol honestly instead of claiming ACP v1', () => {
  const opencode = createOpencodeRuntime();
  const antigravity = createAntigravityRuntime();
  const dsh = createDshRuntime();
  assert.equal(opencode.kind, 'direct');
  assert.equal(antigravity.kind, 'shim');
  assert.equal(dsh.kind, 'shim');
  assert.equal(opencode.runtime, 'opencode');
  assert.equal(antigravity.runtime, 'antigravity');
  assert.equal(dsh.runtime, 'dsh');
  assert.equal(opencode.capabilities.includes('acp.direct'), true);
  assert.equal(antigravity.capabilities.includes('acp.shim'), true);
  assert.equal(dsh.capabilities.includes('acp.shim'), true);
  assert.equal(opencode.capabilities.includes('acp.shim'), false);
});

test('ACP runtime shim rejects an unknown protocolVersion from initialize', async () => {
  const protocol = {
    ACP_JSONRPC,
    ACP_PROTOCOL_VERSION,
    encodeAcpRequest,
    encodeAcpNotification,
    decodeAcpFrame,
    isAcpResponse,
    assertAcpInitializeResult,
  } as typeof import('../../../packages/adapters/acp/protocol.js');
  assert.equal(protocol.ACP_PROTOCOL_VERSION, 1);
  assert.equal(protocol.ACP_JSONRPC.CANCELLED, -32002);
  assert.throws(() => protocol.assertAcpInitializeResult({ protocolVersion: 0 }), /unsupported protocolVersion 0/);
});

test('ACP shim adaptor fails closed when load is requested', async () => {
  for (const factory of [createAntigravityRuntime, createDshRuntime]) {
    const runtime = factory();
    await assert.rejects(
      runtime.load({
        runtimeId: 'runtime-a',
        sessionId: 'session-a',
        workspace: '/workspace',
        command: '/opt/homebrew/bin/does-not-exist',
        timeoutMs: 100,
      }),
      (error: Error & { code?: string }) => error.code === 'capability-unavailable' && /not supported/.test(error.message),
    );
  }
});

test('ACP shim adaptor rejects a submit before a session is opened', async () => {
  for (const factory of [createAntigravityRuntime, createDshRuntime]) {
    const runtime = factory();
    await assert.rejects(
      runtime.submit({ runtimeId: 'runtime-a', sessionId: 'missing', prompt: 'x', messageId: 'm-1', timeoutMs: 100 }),
      (error: Error & { code?: string }) => error.code === 'session-not-found',
    );
    await assert.rejects(
      runtime.cancel({ runtimeId: 'runtime-a', sessionId: 'missing', timeoutMs: 100 }),
      (error: Error & { code?: string }) => error.code === 'session-not-found',
    );
  }
});

/**
 * The dsh shim runs one process per turn. A shell script stands in for the CLI
 * so the contract is locked without needing the real binary: the prompt arrives
 * as a positional argument, and the script prints canned NDJSON run events.
 */
function dshStub(input: {
  readonly lines: readonly string[];
  readonly exitCode?: number;
  readonly logPath?: string;
}): readonly string[] {
  const parts: string[] = [];
  // The prompt is `$0` because it is passed after `sh -c <script>`; later turns
  // add `--session-id <id>` ahead of it.
  if (input.logPath !== undefined) parts.push(`printf '%s\\n' "$0" "$@" >> '${input.logPath}'`);
  parts.push([`printf '%s\\n'`, ...input.lines.map((line) => `'${line}'`)].join(' '));
  if (input.exitCode !== undefined) parts.push(`exit ${input.exitCode}`);
  return ['-c', parts.join('; ')];
}

test('dsh shim runs one process per turn and resumes the persisted session id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-dsh-stub-'));
  const logPath = join(dir, 'args.log');
  const args = dshStub({
    logPath,
    lines: [
      '{"type":"session","sessionId":"session-stub-1"}',
      '{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}',
      '{"type":"final","text":"POGS"}',
    ],
  });
  const runtime = createDshRuntime({ args, timeoutMs: 10_000 });
  const opened = await runtime.open({ runtimeId: 'runtime-dsh-oneshot', workspace: dir, command: '/bin/sh', args, timeoutMs: 10_000 });

  const first = await runtime.submit({ runtimeId: opened.sessionId, sessionId: opened.sessionId, prompt: 'first', messageId: 'm-1', timeoutMs: 10_000 });
  assert.equal(first.outputText, 'POGS');
  assert.equal(first.stopReason, 'end_turn');

  // A second turn proves the adaptor does not hold a session process open: the
  // first process exited, and a fresh one serves this turn.
  const second = await runtime.submit({ runtimeId: opened.sessionId, sessionId: opened.sessionId, prompt: 'second', messageId: 'm-2', timeoutMs: 10_000 });
  assert.equal(second.outputText, 'POGS');

  const invocations = (await readFile(logPath, 'utf8')).trim().split('\n');
  // Turn one starts a session; turn two adopts the id the first turn reported.
  assert.equal(invocations[0], 'first');
  assert.equal(invocations.slice(1).join(' '), '--session-id session-stub-1 second');

  const closed = await runtime.close({ runtimeId: opened.sessionId, sessionId: opened.sessionId, timeoutMs: 10_000 });
  assert.equal(closed.closed, true);
});

test('dsh shim reports a failed turn instead of an empty success', async () => {
  const args = dshStub({
    exitCode: 1,
    lines: [
      '{"type":"status","phase":"turn_end","reason":{"kind":"error","error":{"code":"MISSING_CREDENTIAL"}}}',
      '{"type":"final","text":""}',
    ],
  });
  const runtime = createDshRuntime({ args, timeoutMs: 10_000 });
  const opened = await runtime.open({ runtimeId: 'runtime-dsh-fail', workspace: '/tmp', command: '/bin/sh', args, timeoutMs: 10_000 });

  await assert.rejects(
    runtime.submit({ runtimeId: opened.sessionId, sessionId: opened.sessionId, prompt: 'x', messageId: 'm-1', timeoutMs: 10_000 }),
    (error: Error & { code?: string }) => error.code === 'transport-failure' && /MISSING_CREDENTIAL/.test(error.message),
  );
});
