import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AgentEvent,
  type AgentInput,
  type EvidenceRef,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderError,
  type ProviderEvent,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderResumeInput,
  type ProviderSettleInput,
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
  createDshAgentDriver,
  dshBaselineLock,
  type DshProfileDescriptor,
  type DshTransport,
  type DshTransportContext,
} from '../../../packages/adapters/dsh/src/index.js';
import { createDshExecutionRuntimePort } from '../../../packages/adapters/dsh/src/index.js';

/**
 * P2 driver bridge proof: `ExecutionRuntimePort` -> `AgentDriver`.
 *
 * The transport is a contract-level fake here; the real DSH wire is proven by
 * `real-dsh-entry-proof.mjs` and the transport mapping by
 * `dsh-real-transport.test.ts`. This test proves the driver keeps DSH identity
 * inside evidence refs and that model -> tool -> result -> continuation events
 * reach `AgentRuntime`'s vocabulary.
 */

const digest = (): string => `sha256:${'ab'.repeat(32)}`;

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const operation = id('operation', 'operation-a');
const scope: ScopeRef = { organId: organ, taskId: task, operationId: operation };
const driverOrgan = id('organ', 'driver-organ-a');

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

const rootEvidence = (label: string): EvidenceRef => ({
  evidenceId: id('evidence', `ev-${label}`),
  kind: 'execution',
  source: 'dsh-driver-test',
  locator: `dsh://evidence/${label}`,
  scope: { organId: driverOrgan, taskId: task, operationId: operation },
});

/** Evidence scoped to one execution identity, as the bridge requires. */
const execEvidence = (
  label: string,
  execution: {
    readonly taskId: { readonly value: string };
    readonly operationId: { readonly value: string };
    readonly cycleId?: { readonly value: string };
  },
  kind: EvidenceRef['kind'] = 'execution',
): EvidenceRef => ({
  evidenceId: id('evidence', `ev-${label}`),
  kind,
  source: 'dsh-driver-test',
  locator: `dsh://evidence/${label}`,
  scope: {
    organId: driverOrgan,
    taskId: id('task', execution.taskId.value),
    ...(execution.cycleId ? { cycleId: id('cycle', execution.cycleId.value) } : {}),
    operationId: id('operation', execution.operationId.value),
  },
});

const validity = (): { checkedAt: string; expiresAt: string } => {
  const now = Date.now();
  return { checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
};

/** Contract-level transport that emits a real model -> tool -> result -> continue loop. */
class LoopTransport implements DshTransport {
  private readonly events = new Map<string, ProviderEvent[]>();
  readonly settledOperations: string[] = [];
  readonly startScopes: Array<{ readonly organId?: string; readonly cycleId?: string }> = [];
  startCalls = 0;
  private key(input: { readonly runtimeId: string; readonly taskId: { readonly value: string }; readonly executionEpoch: number }): string {
    return `${input.runtimeId}:${input.taskId.value}:${input.executionEpoch}`;
  }

  private push(input: ProviderStartInput, kind: ProviderEvent['kind'], extra: Partial<ProviderEvent> = {}): void {
    const key = this.key(input);
    const events = this.events.get(key) ?? [];
    events.push({
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      eventId: `event-${events.length}`,
      kind,
      evidenceRefs: [execEvidence(`event-${events.length}`, input, kind === 'tool' ? 'tool' : 'execution')],
      ...(kind === 'tool' || kind === 'terminal'
        ? { ownerId: 'humanagent.dsh-adapter.driver', nextAction: { kind: 'continue' as const, ref: 'driver' } }
        : {}),
      ...extra,
    });
    this.events.set(key, events);
  }

  async probe(context: DshTransportContext): Promise<ProviderReadiness> {
    const times = validity();
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      state: 'ready',
      capabilityDigest: context.binding.capabilityDigest,
      checkedAt: times.checkedAt,
      expiresAt: times.expiresAt,
      evidenceRefs: [rootEvidence('probe')],
    };
  }

  async capabilities(context: DshTransportContext): Promise<ProviderCapabilities> {
    const times = validity();
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      capabilities: ['dsh.session', 'dsh.model', 'dsh.tool'],
      version: '0.1.5-rc.2',
      digest: context.binding.capabilityDigest,
      checkedAt: times.checkedAt,
      expiresAt: times.expiresAt,
      evidenceRefs: [rootEvidence('capabilities')],
    };
  }

  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.startCalls += 1;
    this.startScopes.push({
      ...(input.organId ? { organId: input.organId.value } : {}),
      ...(input.cycleId ? { cycleId: input.cycleId.value } : {}),
    });
    this.events.set(this.key(input), []);
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      startedAt: new Date().toISOString(),
      evidenceRefs: [execEvidence('start', input)],
      externalExecutionRef: execEvidence('session', input, 'external'),
    };
  }

  async resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      checkpointId: input.checkpointId,
      recovered: false,
      staleRejected: false,
      recoveryStateRef: execEvidence('resume', input, 'external'),
      evidenceRefs: [execEvidence('resume', input)],
      error: {
        errorId: 'dsh.resume.unavailable',
        code: 'session-resume-unavailable',
        category: 'capability',
        phase: 'resume',
        message: 'cannot reopen',
        ownerId: 'dsh-driver',
        retryable: 'manual',
        attention: 'foreground',
        evidenceRefs: [execEvidence('resume-error', input)],
        nextAction: { kind: 'recover', ref: 'dsh-driver' },
      },
      ownerId: 'dsh-driver',
      nextAction: { kind: 'recover', ref: 'dsh-driver' },
    };
  }

  async submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> {
    const startInput = { ...input, inputRefs: input.inputRefs };
    this.push(startInput, 'output', { outputRefs: ['assistant-1'] });
    this.push(startInput, 'tool', { outputRefs: ['call-1'] });
    this.push(startInput, 'tool', { outputRefs: ['call-1'] });
    this.push(startInput, 'output', { outputRefs: ['assistant-2'] });
    this.push(startInput, 'terminal', { terminalState: 'succeeded' });
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      status: 'accepted',
      outputRefs: ['message-1'],
      evidenceRefs: [execEvidence('submit', input)],
    };
  }

  async *observe(input: { readonly runtimeId: string; readonly taskId: { readonly value: string }; readonly operationId: { readonly value: string }; readonly executionEpoch: number }): AsyncIterable<ProviderEvent> {
    const key = this.key(input);
    let cursor = 0;
    while (true) {
      const events = this.events.get(key) ?? [];
      while (cursor < events.length) yield events[cursor++];
      const terminal = (this.events.get(key) ?? []).some((event) => event.kind === 'terminal');
      if (terminal) return;
      await new Promise((settle) => setTimeout(settle, 5));
    }
  }

  async requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt> {
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      status: 'accepted',
      receivedAt: new Date().toISOString(),
      evidenceRefs: [execEvidence('stop', input, 'operation')],
    };
  }

  async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
    this.settledOperations.push(input.operationId.value);
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state: 'stopped',
      evidenceRefs: [execEvidence('settle', input)],
      resourceRelease: { state: 'released', evidenceRefs: [execEvidence('release', input)] },
      persistence: { state: 'committed', evidenceRefs: [execEvidence('persist', input)] },
    };
  }

  async close(context: DshTransportContext): Promise<ProviderCloseResult> {
    return {
      bindingId: context.binding.bindingId,
      providerId: context.binding.providerId,
      protocol: context.binding.protocol,
      state: 'closed',
      evidenceRefs: [rootEvidence('close')],
    };
  }
}

class FailingLoopTransport extends LoopTransport {
  settleCalls = 0;

  override async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
    this.settleCalls += 1;
    if (this.settleCalls === 1) {
      const failure: ProviderError = {
        errorId: 'dsh.settle.failed',
        code: 'turn-failed',
        category: 'provider',
        phase: 'settle',
        message: 'turn failed; retry settle',
        ownerId: 'dsh-driver-test',
        retryable: 'retryable',
        attention: 'foreground',
        evidenceRefs: [execEvidence('settle-failed', input)],
        nextAction: { kind: 'recover', ref: 'dsh-driver-test' },
      };
      return {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        state: 'failed',
        evidenceRefs: failure.evidenceRefs,
        resourceRelease: { state: 'failed', evidenceRefs: failure.evidenceRefs, failure },
        persistence: { state: 'failed', evidenceRefs: failure.evidenceRefs, failure },
        error: failure,
        ownerId: 'dsh-driver-test',
        nextAction: { kind: 'recover', ref: 'dsh-driver-test' },
      };
    }
    return super.settle(input);
  }
}

class FailedFinalSettlementTransport extends LoopTransport {
  override async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
    const failure: ProviderError = {
      errorId: 'dsh.turn.failed',
      code: 'turn-failed',
      category: 'provider',
      phase: 'settle',
      message: 'turn failed after resource release',
      ownerId: 'dsh-driver-test',
      retryable: 'manual',
      attention: 'foreground',
      evidenceRefs: [execEvidence('settle-final-failed', input)],
      nextAction: { kind: 'recover', ref: 'dsh-driver-test' },
    };
    return {
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      state: 'failed',
      evidenceRefs: failure.evidenceRefs,
      resourceRelease: { state: 'released', evidenceRefs: [execEvidence('release', input)] },
      persistence: { state: 'committed', evidenceRefs: [execEvidence('persist', input)] },
      error: failure,
      ownerId: 'dsh-driver-test',
      nextAction: { kind: 'recover', ref: 'dsh-driver-test' },
    };
  }
}

function makeDriver(transport: DshTransport) {
  const runtime = createDshExecutionRuntimePort({
    lock: dshBaselineLock,
    profile,
    transport,
    requiredCapabilities: ['dsh.session', 'dsh.model'],
    ownerId: 'dsh-driver-test',
  });
  return createDshAgentDriver({ runtime, binding });
}

test('driver bridges model -> tool -> result -> continuation into AgentDriver events', async () => {
  const transport = new LoopTransport();
  const driver = makeDriver(transport);
  const cycle = id('cycle', 'cycle-a');
  await driver.start({
    runtimeId: 'runtime-a',
    taskId: task,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    organId: driverOrgan,
    cycleId: cycle,
    operationId: operation,
  });
  assert.deepEqual(transport.startScopes, [{ organId: driverOrgan.value, cycleId: cycle.value }]);
  await driver.submit({
    taskId: task,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    payload: { prompt: 'inspect the config' },
  });

  const observed: AgentEvent[] = [];
  for await (const event of driver.observe({ runtimeId: 'runtime-a' })) {
    observed.push(event);
    if (event.kind === 'terminal') break;
  }
  assert.deepEqual(observed.map((event) => event.kind), ['output', 'tool', 'tool', 'output', 'terminal']);
  // DSH identity never leaks: the driver only exposes task/epoch plus evidence.
  for (const event of observed) {
    assert.equal(event.taskId.value, 'task-a');
    assert.equal(event.executionEpoch, 1);
    assert.equal('sessionId' in event, false);
    for (const ref of event.evidenceRefs) assert.ok(ref.locator.startsWith('dsh://') || ref.locator.startsWith('humanagent://'));
  }
});

test('driver rejects missing HumanAgent identity before touching the runtime', async () => {
  const transport = new LoopTransport();
  const driver = makeDriver(transport);
  await assert.rejects(
    driver.start({
      runtimeId: 'runtime-a',
      taskId: task,
      executionEpoch: 1,
      assignmentId: 'assignment-a',
    } as Parameters<typeof driver.start>[0]),
    /requires HumanAgent-owned organId and operationId/,
  );
  assert.equal(transport.startCalls, 0);
});

test('driver stop requests the operation and settles only through the port', async () => {
  const transport = new LoopTransport();
  const driver = makeDriver(transport);
  await driver.start({
    runtimeId: 'runtime-a',
    taskId: task,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    organId: driverOrgan,
    operationId: operation,
  });
  const receipt = await driver.requestStop({
    runtimeId: 'runtime-a',
    executionEpoch: 1,
    operationId: operation,
  });
  assert.equal(receipt.requested, true);
  // The stop receipt alone must not be a closure.
  const closure = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: 1 });
  assert.equal(closure.state, 'stopped');
  assert.equal(transport.settledOperations.length, 1);
});

test('driver keeps a failed settle instance alive for retry', async () => {
  const transport = new FailingLoopTransport();
  const driver = makeDriver(transport);
  await driver.start({
    runtimeId: 'runtime-a',
    taskId: task,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    organId: driverOrgan,
    operationId: operation,
  });

  const failed = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: 1 });
  assert.equal(failed.state, 'failed');
  assert.equal(transport.settleCalls, 1);

  // A non-final settlement must not destroy the driver instance, otherwise a
  // retry of settle/stop after the same failure would be impossible.
  const retried = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: 1 });
  assert.equal(retried.state, 'stopped');
  assert.equal(transport.settleCalls, 2);
});

test('driver releases a failed settlement instance once resources are released and persistence is committed', async () => {
  const transport = new FailedFinalSettlementTransport();
  const driver = makeDriver(transport);
  await driver.start({
    runtimeId: 'runtime-a',
    taskId: task,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    organId: driverOrgan,
    operationId: operation,
  });

  const failed = await driver.settle({ runtimeId: 'runtime-a', executionEpoch: 1 });
  assert.equal(failed.state, 'failed');
  await assert.rejects(
    driver.settle({ runtimeId: 'runtime-a', executionEpoch: 1 }),
    /has no active runtime for this epoch/,
  );
});

test('driver rejects a stop operation that does not own the active execution', async () => {
  const transport = new LoopTransport();
  const driver = makeDriver(transport);
  await driver.start({
    runtimeId: 'runtime-a',
    taskId: task,
    executionEpoch: 1,
    assignmentId: 'assignment-a',
    organId: driverOrgan,
    operationId: operation,
  });
  await assert.rejects(
    driver.requestStop({
      runtimeId: 'runtime-a',
      executionEpoch: 1,
      operationId: id('operation', 'other-operation'),
    }),
    /stop operation does not match/,
  );
  assert.equal(transport.settledOperations.length, 0);
});

test('driver surfaces the DSH resume capability gap instead of faking recovery', async () => {
  const transport = new LoopTransport();
  const driver = makeDriver(transport);
  await assert.rejects(
    driver.resume({
      runtimeId: 'runtime-a',
      taskId: task,
      executionEpoch: 1,
      assignmentId: 'assignment-a',
      organId: driverOrgan,
      operationId: operation,
      checkpointId: id('checkpoint', 'cp-1'),
    }),
    /cannot reopen/,
  );
});
