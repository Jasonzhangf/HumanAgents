import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
import { AcpStdioBackend } from '../../../packages/adapters/acp/backend.js';
import { terminateProcess } from '../../../packages/adapters/acp/terminate.js';
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
  AcpRuntimeOpenInput,
  AcpRuntimeOpenResult,
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

test('ACP backend does not hold the process open after a clean close', async () => {
  // The SIGKILL grace timer is a fallback for a child that ignores SIGTERM. If
  // `close` never clears it, the timer keeps the event loop alive for the whole
  // grace period after `close` has already resolved, so a short-lived process
  // cannot exit. That symptom is only visible from outside the closing process,
  // so run the close in a child and measure how long the child takes to exit.
  const backendUrl = new URL('../../../packages/adapters/acp/backend.js', import.meta.url).href;
  const script = [
    `import { AcpStdioBackend } from ${JSON.stringify(backendUrl)};`,
    'const started = Date.now();',
    `const backend = new AcpStdioBackend({ command: process.execPath, args: ['-e', 'process.stdin.resume()'] });`,
    'await backend.close();',
    'const closeMs = Date.now() - started;',
    '// Wait for the report to flush before letting the process exit.',
    'await new Promise((resolve) => {',
    '  process.stdout.write(JSON.stringify({ closeMs }) + "\\n", () => resolve(undefined));',
    '});',
  ].join('\n');

  const spawnedAt = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once('exit', (value) => resolve(value)));
  const exitMs = Date.now() - spawnedAt;

  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout.trim()) as { closeMs: number };
  assert.ok(report.closeMs < 4_000, `close() waited ${report.closeMs}ms`);
  // With the grace timer leaked the child cannot exit before the timer fires.
  assert.ok(exitMs < 4_000, `the process needed ${exitMs}ms to exit after close()`);
});

test('ACP process termination resolves only after the runtime has exited', async () => {
  // The child keeps running for a moment after SIGTERM. A close that only sends
  // the signal would resolve first, and the caller would report a stopped
  // runtime that is still alive.
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  // The handler must be installed before the signal arrives, otherwise the
  // default action kills the child and the test would pass for the wrong reason.
  await new Promise((resolve) => child.stdout.once('data', () => resolve(undefined)));

  const startedAt = Date.now();
  await terminateProcess(child, 5_000);
  const elapsed = Date.now() - startedAt;

  assert.notEqual(child.exitCode, null, 'the process was still running when termination resolved');
  assert.ok(elapsed >= 200, `termination resolved after ${elapsed}ms, before the process exited`);
});

test('ACP process termination escalates to SIGKILL when the runtime ignores SIGTERM', async () => {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', () => resolve(undefined)));

  await terminateProcess(child, 300);

  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    'the process survived the termination grace period',
  );
});

test('ACP driver never settles a session that ran no turn as succeeded', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  // No turn was submitted, so there is no outcome to report. Claiming success
  // here would be a fabricated result on a public seam.
  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
  assert.equal(closure.state, 'unknown');
});

test('ACP driver settles a refused empty turn as failed, never as succeeded', async () => {
  // A server that answers `end_turn` with no message chunk: the turn completed
  // by the server's own account but produced no answer, so the driver rejects it.
  const runtime = makeFakeRuntime({ submitResult: { stopReason: 'end_turn', outputText: '' } });
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  await assert.rejects(
    driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: submitPayload }),
    (error: Error & { code?: string }) => error.code === 'protocol-error' && /empty turn answer/.test(error.message),
  );

  // The rejection must survive into the closure: it is the only place the app
  // can read the outcome of a turn that threw.
  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
  assert.equal(closure.state, 'failed');
});

test('ACP driver maps a truncated turn to failed instead of succeeded', async () => {
  const runtime = makeFakeRuntime({ submitResult: { stopReason: 'max_tokens', outputText: 'partial' } });
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  const output = await driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: submitPayload });
  assert.equal(output.payload.stopReason, 'max_tokens');

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

test('ACP driver settles a failed turn as failed even when the stop was refused', async () => {
  const runtime = makeFakeRuntime({
    submitFailure: failWith('transport-failure', 'the engine died mid-turn'),
    cancelResult: { accepted: false },
  });
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  await driver.start(startInput());

  await assert.rejects(
    driver.submit({ taskId, executionEpoch: epoch, assignmentId, payload: submitPayload }),
    (error: Error & { code?: string }) => error.code === 'transport-failure',
  );
  const receipt = await driver.requestStop({ runtimeId: 'runtime-a', executionEpoch: epoch, operationId });
  assert.equal(receipt.requested, false);

  // A refused stop must not turn the failed turn into a stopped one.
  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: epoch });
  assert.equal(closure.state, 'failed');
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
  const runtime = makeFakeRuntime({ closeResult: { closed: false } });
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

test('ACP driver refuses a resume and names the runtime that cannot reopen a session', async () => {
  const runtime = makeFakeRuntime();
  const driver = createAcpClientDriver({ runtime, workspace: '/workspace', command: '/bin/true' });
  // No runtime behind this seam can reopen a persisted session, so resume must
  // fail closed instead of pretending the old session resumed.
  await assert.rejects(
    driver.resume({ ...startInput(), checkpointId: id('checkpoint', 'cp-1') }),
    (error: Error & { code?: string; message: string }) =>
      error.code === 'capability-unavailable' && /opencode/.test(error.message),
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
  assert.equal(JSON.stringify(output.payload).includes('session-runtime-a'), false);
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
  } = {},
): AcpRuntimeAdaptor {
  const closeResult: AcpRuntimeCloseResult = options.closeResult ?? { closed: true };
  return {
    runtime: 'opencode',
    version: 'test-runtime-1',
    capabilities: ['acp.shim'],

    async open(input: AcpRuntimeOpenInput): Promise<AcpRuntimeOpenResult> {
      return {
        sessionId: input.sessionIdFor ? input.sessionIdFor(input.runtimeId) : `session-${input.runtimeId}`,
      };
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
      return options.cancelResult ?? { accepted: true };
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

test('ACP driver refuses a resume on every runtime behind the seam', async () => {
  for (const factory of [createOpencodeRuntime, createAntigravityRuntime, createDshRuntime]) {
    const driver = createAcpClientDriver({
      runtime: factory(),
      workspace: '/workspace',
      command: '/opt/homebrew/bin/does-not-exist',
    });
    await assert.rejects(
      driver.resume({ ...startInput(), checkpointId: id('checkpoint', 'cp-1') }),
      (error: Error & { code?: string }) => error.code === 'capability-unavailable',
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

/**
 * `execution.antigravity.args` is operator config, so it must actually reach
 * `agy`. A shell script stands in for the CLI and records its argv; the shim
 * owns `-p` and `--output-format`, so those must follow the configured flags.
 */
test('antigravity shim passes the configured args to the CLI ahead of its own protocol flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-agy-stub-'));
  const logPath = join(dir, 'args.log');
  const script = `printf '%s\\n' "$0" "$@" >> '${logPath}'; printf '%s\\n' '{"status":"SUCCESS","response":"POGS"}'`;
  const args = ['-c', script];
  const runtime = createAntigravityRuntime({ args, timeoutMs: 10_000 });
  const opened = await runtime.open({ runtimeId: 'runtime-agy-args', workspace: dir, command: '/bin/sh', args, timeoutMs: 10_000 });

  const turn = await runtime.submit({ runtimeId: opened.sessionId, sessionId: opened.sessionId, prompt: 'hello', messageId: 'm-1', timeoutMs: 10_000 });
  assert.equal(turn.outputText, 'POGS');
  assert.equal(turn.stopReason, 'end_turn');

  // If the configured args were dropped, `/bin/sh` would never run the script,
  // so this file would not exist at all.
  const argv = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.deepEqual(argv, ['-p', 'hello', '--output-format', 'json']);

  await runtime.close({ runtimeId: opened.sessionId, sessionId: opened.sessionId, timeoutMs: 10_000 });
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
