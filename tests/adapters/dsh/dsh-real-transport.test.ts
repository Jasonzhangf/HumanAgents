import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import {
  id,
  validateProviderEvent,
  validateProviderSettlement,
  validateProviderStartReceipt,
  validateProviderStopReceipt,
  validateProviderSubmitResult,
  validateProviderCloseResult,
  validateProviderRecoveryResult,
  type EvidenceRef,
  type ProviderBinding,
  type ProviderStartInput,
  type ProviderSubmitInput,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  createRealDshTransport,
  dshBaselineLock,
  type DshRealTransportOptions,
  type DshProfileDescriptor,
  verifyDshSessionPersistence,
} from '../../../packages/adapters/dsh/src/index.js';

/**
 * Fake-contract layer for the real DSH transport. The transport is driven
 * through a stubbed spawn seam so the wire mapping, stop-vs-settle separation,
 * and resume boundary are exercised deterministically. The real end-to-end
 * entry is proven separately by `real-dsh-entry-proof.mjs`.
 */

const digest = (): string => `sha256:${'ab'.repeat(32)}`;

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const operation = id('operation', 'operation-a');
const scope: ScopeRef = { organId: organ, taskId: task, operationId: operation };

const binding: ProviderBinding = {
  bindingId: 'binding-dsh',
  providerId: 'dsh',
  protocol: 'other-explicit',
  endpointRef: 'local:dsh-stdio',
  modelRef: 'explicit/model',
  configDigest: digest(),
  capabilityDigest: digest(),
};

const profile: DshProfileDescriptor = {
  profileName: 'humanagent',
  homeRef: 'env:DSH_HOME',
  plugin: { bundleRef: 'humanagent-dsh-bundle:approved', digest: digest(), entry: 'dist/index.js' },
  routeRef: 'explicit/dsh/route',
  patchRefs: [],
};

const evidenceRef = (label: string): EvidenceRef => ({
  evidenceId: id('evidence', `ev-${label}`),
  kind: 'execution',
  source: 'dsh-real-transport-test',
  locator: `dsh://evidence/${label}`,
  scope,
});

const startInput = (overrides: Partial<ProviderStartInput> = {}): ProviderStartInput => ({
  runtimeId: 'runtime-a',
  taskId: task,
  operationId: operation,
  executionEpoch: 1,
  inputRefs: ['input-a'],
  evidenceRefs: [evidenceRef('start-input')],
  ...overrides,
});

/** Minimal fake child: records written frames and lets the test emit stdout. */
class FakeChild {
  readonly written: Record<string, unknown>[] = [];
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  exitCode: number | null = null;
  signalCode: string | null = null;
  private lineHandler: ((line: string) => void) | undefined;
  readonly stdin = {
    write: (chunk: string): boolean => {
      const frame = JSON.parse(chunk) as Record<string, unknown>;
      this.written.push(frame);
      this.respond(frame);
      return true;
    },
    end: (): void => {},
  };
  readonly stdout = {
    setEncoding: (): void => {},
    on: (_event: string, listener: (...args: unknown[]) => void): void => {
      this.lineHandler = (line: string) => listener({ toString: () => line });
    },
  };
  readonly stderr = {
    setEncoding: (): void => {},
    on: (_event: string, listener: (...args: unknown[]) => void): void => {
      void listener;
    },
  };

  /** Scripted responses keyed by request method; assign after construction to close over the child. */
  handlers: Record<string, (params: Record<string, unknown> | undefined, id: number) => Record<string, unknown> | undefined> = {};

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    return this.on(event, listener);
  }

  off(): this { return this; }
  removeListener(): this { return this; }
  emit(event: string, ...args: unknown[]): boolean {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    return true;
  }

  kill(signal = 'SIGTERM'): boolean {
    this.exitCode = signal === 'SIGTERM' ? 0 : null;
    this.signalCode = signal === 'SIGKILL' ? 'SIGKILL' : null;
    this.emit('exit', this.exitCode, this.signalCode);
    return true;
  }

  /** Push one server-to-client notification frame. */
  push(frame: Record<string, unknown>): void {
    this.lineHandler?.(`${JSON.stringify(frame)}\n`);
  }

  private respond(frame: Record<string, unknown>): void {
    const method = String(frame.method);
    const handler = this.handlers[method];
    if (!handler) return;
    const result = handler(frame.params as Record<string, unknown> | undefined, frame.id as number);
    if (result === undefined) return;
    queueMicrotask(() => this.lineHandler?.(`${JSON.stringify(result)}\n`));
  }
}

function makeChild(handlers: Partial<FakeChild['handlers']> = {}): FakeChild {
  const child = new FakeChild();
  child.handlers = { ...defaultHandlers(child), ...handlers };
  return child;
}

function makeTransport(child: FakeChild, overrides: Partial<DshRealTransportOptions> = {}) {
  return createRealDshTransport({
    binding,
    lock: dshBaselineLock,
    profile,
    sourceRoot: '/dsh/source',
    home: '/dsh/home',
    workspace: '/dsh/workspace',
    provider: 'rcc',
    model: 'gpt-5.5',
    patchFiles: ['/dsh/source/apps/cli/src/sdk-source.cordis.patch.yml'],
    spawnRuntime: () => child as never,
    verifyPersistence: async ({ scope: verificationScope }) => ({
      state: 'committed',
      evidenceRef: persistenceEvidence(verificationScope, 'persistence-commit'),
    }),
    ...overrides,
  });
}

function persistenceEvidence(scopeValue: ScopeRef, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `ev-${label}`),
    kind: 'execution',
    source: 'dsh-real-transport-test',
    locator: `dsh://evidence/${label}`,
    scope: scopeValue,
  };
}

async function writeSessionArtifact(input: {
  readonly home: string;
  readonly sessionId: string;
  readonly header: Record<string, unknown>;
}): Promise<void> {
  const directory = join(input.home, 'sessions', '--workspace--', 'runtime-a~003Atask-a~003A1');
  await mkdir(directory, { recursive: true });
  const bytes = zstdCompressSync(`${JSON.stringify(input.header)}\n`);
  await writeFile(join(directory, 'session.v3.jsonl.zstd'), bytes);
}

function defaultHandlers(child: FakeChild) {
  return {
  initialize: (_params: unknown, requestId: number) => ({
    jsonrpc: '2.0',
    id: requestId,
    result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } },
  }),
  'session/prompt': (_params: unknown, requestId: number) => ({
    jsonrpc: '2.0',
    id: requestId,
    result: { messageId: 'message-1' },
  }),
  shutdown: (_params: unknown, requestId: number) => {
    queueMicrotask(() => child.kill('SIGTERM'));
    return { jsonrpc: '2.0', id: requestId, result: {} };
  },
  };
}

const context = { binding, lock: dshBaselineLock, profile };

test('real DSH transport maps a model -> tool -> result -> continuation loop', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  const start = await transport.start(startInput());
  validateProviderStartReceipt(start);
  assert.equal(start.externalExecutionRef?.kind, 'external');
  assert.notEqual(start.externalExecutionRef?.locator, start.runtimeId);

  const submit = await transport.submit({
    runtimeId: 'runtime-a',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    inputRefs: ['input-b'],
    evidenceRefs: [evidenceRef('submit-input')],
    payload: { prompt: 'inspect the config' },
  });
  validateProviderSubmitResult(submit);
  assert.equal(submit.status, 'accepted');

  const sessionId = 'runtime-a:task-a:1';
  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'I will read it.' }] } } } } });
  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/call', seq: 2, data: { callId: 'call-1', name: 'read', arguments: '{}' } } } });
  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/result', seq: 3, data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false }] } } } } });
  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'feature_flag=true' }] } } } } });
  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } } } });

  const observed = [];
  for await (const event of transport.observe({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 })) {
    validateProviderEvent(event);
    observed.push(event);
    // `observe` stays open across turns, like the live runtime; the terminal
    // turn event is the operation-level boundary the consumer reacts to.
    if (event.kind === 'terminal') break;
  }
  const kinds = observed.map((event) => event.kind);
  assert.deepEqual(kinds, ['output', 'tool', 'tool', 'output', 'terminal']);
  const terminal = observed[observed.length - 1];
  assert.equal(terminal.terminalState, 'succeeded');
  // The tool result carries the same call id as its call, proving the pairing.
  assert.deepEqual(observed[1].outputRefs, ['call-1']);
  assert.deepEqual(observed[2].outputRefs, ['call-1']);
});

test('cancel receipt is never a stopped settlement', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  const receipt = await transport.requestStop({
    runtimeId: 'runtime-a',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    reason: 'operator stop',
    ownerId: 'stop-controller',
    evidenceRefs: [evidenceRef('stop-input')],
  });
  validateProviderStopReceipt(receipt);
  assert.equal(receipt.status, 'accepted');
  // The receipt must not carry a settled state; only settle may report stopped.
  assert.equal('state' in receipt, false);
  // The accepted stop receipt is emitted only after a real DSH shutdown frame
  // has been sent, so a stop request can never claim acceptance while the
  // runtime is still live.
  assert.equal(child.written.some((frame) => frame.method === 'shutdown'), true);

  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'stopped');
  assert.equal(settlement.resourceRelease.state, 'released');
  assert.equal(settlement.persistence.state, 'committed');
});

test('ordinary settle after shutdown is not a stopped settlement', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());
  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } } } });

  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'succeeded');
  assert.equal(settlement.resourceRelease.state, 'released');
  assert.equal(settlement.persistence.state, 'committed');
});

test('clean exit before terminal evidence cannot settle as succeeded', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'failed');
  assert.match(settlement.error?.message ?? '', /terminal evidence/);
});

test('malformed turn/end evidence cannot settle as succeeded', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  child.push({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 'bad', data: { reason: { kind: 'completed' } } } },
  });
  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'unknown');
  assert.equal(settlement.error?.category, 'provider');
});

test('a later completed terminal cannot erase an earlier protocol failure', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  child.push({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 'bad', data: { reason: { kind: 'completed' } } } },
  });
  child.push({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } } },
  });

  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'unknown');
  assert.equal(settlement.error?.category, 'provider');
});

test('duplicate terminal evidence cannot overwrite a successful turn', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  const event = { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } };
  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'runtime-a:task-a:1', event } });
  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'runtime-a:task-a:1', event } });
  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'unknown');
  assert.match(settlement.error?.message ?? '', /protocol integrity failed/);
});

test('out-of-order session events cannot settle as succeeded', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  child.push({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } },
  });
  child.push({
    jsonrpc: '2.0',
    method: 'session.event',
    params: {
      sessionId: 'runtime-a:task-a:1',
      event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'late' }] } } },
    },
  });
  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'unknown');
  assert.match(settlement.error?.message ?? '', /protocol integrity failed/);
});

test('unknown non-ignorable session events fail visibly', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  child.push({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: 'runtime-a:task-a:1', event: { type: 'plugin/unknown', seq: 1, data: {} } },
  });
  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'unknown');
  assert.equal(settlement.error?.category, 'provider');
});

test('turn failure with clean exit settles failed instead of succeeded', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { message: 'provider rejected tool call' } } } } } });
  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'failed');
});

test('pending persistence verification cannot settle as succeeded', async () => {
  const child = makeChild();
  const transport = makeTransport(child, {
    verifyPersistence: async ({ scope: verificationScope }) => ({
      state: 'pending',
      evidenceRef: persistenceEvidence(verificationScope, 'persistence-pending'),
    }),
  });
  await transport.start(startInput());
  child.push({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } } },
  });

  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'failed');
  assert.equal(settlement.resourceRelease.state, 'released');
  assert.equal(settlement.persistence.state, 'pending');
  assert.match(settlement.error?.message ?? '', /persistence is pending/);
});

test('failed persistence verification preserves its error and blocks settlement', async () => {
  const child = makeChild();
  const verificationFailure = {
    errorId: 'dsh.settle.persistence-artifact-missing',
    code: 'persistence-artifact-missing',
    category: 'runtime' as const,
    phase: 'settle' as const,
    message: 'DSH session log artifact is missing',
    ownerId: 'test',
    retryable: 'manual' as const,
    attention: 'foreground' as const,
    evidenceRefs: [evidenceRef('persistence-failure')],
    nextAction: { kind: 'recover' as const, ref: 'test' },
  };
  const transport = makeTransport(child, {
    verifyPersistence: async ({ scope: verificationScope }) => ({
      state: 'failed',
      evidenceRef: persistenceEvidence(verificationScope, 'persistence-failed'),
      failure: verificationFailure,
    }),
  });
  await transport.start(startInput());
  child.push({
    jsonrpc: '2.0',
    method: 'session.event',
    params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } } },
  });

  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'failed');
  assert.equal(settlement.persistence.state, 'failed');
  assert.equal(settlement.persistence.failure, verificationFailure);
  assert.equal(settlement.error, verificationFailure);
});

test('persistence verifier validates the committed session artifact header', async () => {
  const home = await mkdtemp(join(tmpdir(), 'humanagent-persistence-verifier-'));
  const sessionId = 'runtime-a:task-a:1';
  try {
    await writeSessionArtifact({
      home,
      sessionId,
      header: {
        type: 'session',
        version: 3,
        id: sessionId,
        createdAt: Date.now(),
        cwd: '/dsh/workspace',
        isSeeded: false,
        delegationDepth: 0,
      },
    });
    const verification = await verifyDshSessionPersistence({
      sessionId,
      home,
      workspace: '/dsh/workspace',
      scope,
    });
    assert.equal(verification.state, 'committed');
    assert.match(verification.evidenceRef.digest ?? '', /^sha256:/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('persistence verifier rejects missing, corrupt, and mismatched artifacts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'humanagent-persistence-verifier-'));
  const sessionId = 'runtime-a:task-a:1';
  try {
    const missing = await verifyDshSessionPersistence({
      sessionId,
      home,
      workspace: '/dsh/workspace',
      scope,
    });
    assert.equal(missing.state, 'failed');
    assert.match(missing.failure?.message ?? '', /missing/);

    const directory = join(home, 'sessions', '--workspace--', 'runtime-a~003Atask-a~003A1');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.v3.jsonl.zstd'), 'not-zstd');
    const corrupt = await verifyDshSessionPersistence({
      sessionId,
      home,
      workspace: '/dsh/workspace',
      scope,
    });
    assert.equal(corrupt.state, 'failed');
    assert.match(corrupt.failure?.message ?? '', /corrupt/);

    await writeSessionArtifact({
      home,
      sessionId,
      header: {
        type: 'session',
        version: 3,
        id: 'other-session',
        createdAt: Date.now(),
        cwd: '/dsh/workspace',
        isSeeded: false,
        delegationDepth: 0,
      },
    });
    const mismatch = await verifyDshSessionPersistence({
      sessionId,
      home,
      workspace: '/dsh/workspace',
      scope,
    });
    assert.equal(mismatch.state, 'failed');
    assert.match(mismatch.failure?.message ?? '', /does not match/);

    await writeSessionArtifact({
      home,
      sessionId,
      header: {
        type: 'session',
        version: 3,
        id: sessionId,
        createdAt: Date.now(),
        cwd: '/other/workspace',
        isSeeded: false,
        delegationDepth: 0,
      },
    });
    const wrongWorkspace = await verifyDshSessionPersistence({
      sessionId,
      home,
      workspace: '/dsh/workspace',
      scope,
    });
    assert.equal(wrongWorkspace.state, 'failed');
    assert.match(wrongWorkspace.failure?.message ?? '', /does not match/);

    await writeSessionArtifact({
      home,
      sessionId,
      header: {
        type: 'session',
        version: 2,
        id: sessionId,
        createdAt: Date.now(),
        cwd: '/dsh/workspace',
        isSeeded: false,
        delegationDepth: 0,
      },
    });
    const wrongVersion = await verifyDshSessionPersistence({
      sessionId,
      home,
      workspace: '/dsh/workspace',
      scope,
    });
    assert.equal(wrongVersion.state, 'failed');
    assert.match(wrongVersion.failure?.message ?? '', /does not match/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('failed turn/end maps to valid error and terminal provider events', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { message: 'provider rejected tool call' } } } } } });
  const observed: Array<{ readonly kind: string; readonly terminalState?: string }> = [];
  for await (const event of transport.observe({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 })) {
    validateProviderEvent(event);
    observed.push(event);
    if (event.kind === 'terminal') break;
  }
  assert.deepEqual(observed.map((event) => event.kind), ['error', 'terminal']);
  assert.equal(observed[1]?.terminalState, 'failed');
});

test('turn failure is not masked as stopped when stop arrives before settle', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());

  child.push({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'runtime-a:task-a:1', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { message: 'provider failure' } } } } } });
  await transport.requestStop({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1, reason: 'operator', ownerId: 'test', evidenceRefs: [evidenceRef('stop-input')] });
  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'failed');
});

test('resume refuses to claim a reopened DSH session', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  const result = await transport.resume({
    runtimeId: 'runtime-a',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    inputRefs: ['input-a'],
    evidenceRefs: [evidenceRef('resume-input')],
    checkpointId: id('checkpoint', 'cp-1'),
    checkpointExecutionEpoch: 1,
  });
  validateProviderRecoveryResult(result);
  assert.equal(result.recovered, false);
  assert.equal(result.staleRejected, false);
  assert.equal(result.error?.category, 'capability');
  assert.equal(result.error?.code, 'session-resume-unavailable');
});

test('a non-zero runtime exit fails settle instead of reporting stopped', async () => {
  const child = makeChild({
    shutdown: (_params: unknown, requestId: number) => {
      queueMicrotask(() => child.kill('SIGKILL'));
      return { jsonrpc: '2.0', id: requestId, result: {} };
    },
  });
  const transport = makeTransport(child);
  await transport.start(startInput());
  await assert.rejects(
    () => transport.requestStop({
      runtimeId: 'runtime-a',
      taskId: task,
      operationId: operation,
      executionEpoch: 1,
      reason: 'operator stop',
      ownerId: 'stop-controller',
    }),
    /did not exit cleanly/,
  );
  const settlement = await transport.settle({ runtimeId: 'runtime-a', taskId: task, operationId: operation, executionEpoch: 1 });
  validateProviderSettlement(settlement);
  assert.equal(settlement.state, 'failed');
  assert.equal(settlement.resourceRelease.state, 'failed');
  assert.equal(settlement.persistence.state, 'failed');
  assert.ok(settlement.error);
});

test('close shuts down every live runtime and is idempotent', async () => {
  const child = makeChild();
  const transport = makeTransport(child);
  await transport.start(startInput());
  const first = await transport.close(context);
  validateProviderCloseResult(first);
  assert.equal(first.state, 'closed');
  const second = await transport.close(context);
  validateProviderCloseResult(second);
  assert.equal(second.state, 'closed');
});

test('submit surfaces a rejected prompt as a failed result with an error', async () => {
  const child = makeChild({
    'session/prompt': (_params: unknown, requestId: number) => ({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32603, message: 'prompt rejected' },
    }),
  });
  const transport = makeTransport(child);
  await transport.start(startInput());
  const result = await transport.submit({
    runtimeId: 'runtime-a',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    inputRefs: ['input-b'],
    evidenceRefs: [evidenceRef('submit-input')],
    payload: { prompt: 'boom' },
  } satisfies ProviderSubmitInput);
  validateProviderSubmitResult(result);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.phase, 'submit');
});

test('submit rejects a prompt response without a DSH message id', async () => {
  const child = makeChild({
    'session/prompt': (_params: unknown, requestId: number) => ({
      jsonrpc: '2.0',
      id: requestId,
      result: {},
    }),
  });
  const transport = makeTransport(child);
  await transport.start(startInput());
  const result = await transport.submit({
    runtimeId: 'runtime-a',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    inputRefs: ['input-b'],
    evidenceRefs: [evidenceRef('submit-input')],
    payload: { prompt: 'boom' },
  } satisfies ProviderSubmitInput);
  validateProviderSubmitResult(result);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.outputRefs, []);
  assert.match(result.error?.message ?? '', /messageId/);
});
