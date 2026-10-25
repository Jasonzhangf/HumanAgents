import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type AgentEvent,
  type EvidenceRef,
  type ProviderEvent,
  type TaskId,
} from '../../../packages/contracts/src/index.js';
import {
  RuntimeTaskCoordinator,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
} from '../../../packages/runtime/src/ui-runtime/coordinator.js';

const coordinatorOrganId = id('organ', 'organ-request-budget');

declare module 'node:assert/strict' {
  interface Assert {
    strictEqual<T>(actual: unknown, expected: T, message?: string): void;
  }
}

function evidenceRef(scope: EvidenceRef['scope'], label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `request-budget-${label}`),
    kind: 'external',
    source: 'request-budget-test',
    locator: `provider/${label}`,
    scope,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A provider driver that reports one content unit as streamed `model` deltas
 * and never completes it unless the scenario says so. Delta bytes are
 * activity; only the closing `output` event is progress.
 */
class DeltaDriver implements RuntimeExecutionDriver {
  readonly kind = 'request-budget.fake-driver';
  stopRequests = 0;
  observeReturned = false;

  constructor(
    readonly input: RuntimeExecutionDriverInput,
    private readonly scenario: 'never-completes' | 'completes-after-stream' | 'silent',
    private readonly settleState: 'succeeded' | 'stopped',
  ) {}

  async capabilities() {
    return { driverKind: this.kind, capabilities: ['execute'], version: '1' };
  }

  async start(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async resume(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }

  async submit(input: Parameters<RuntimeExecutionDriver['submit']>[0]) {
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: input.payload,
      outputRefs: [],
      evidenceRefs: [],
    };
  }

  private deltaEvent(seq: number): AgentEvent {
    const providerEvent: ProviderEvent = {
      runtimeId: this.input.runtimeId,
      taskId: this.input.taskId,
      operationId: this.input.operationId,
      executionEpoch: this.input.executionEpoch,
      eventId: `delta-${seq}`,
      kind: 'model',
      turnId: 'turn-request-budget',
      requestId: 'request-request-budget',
      summary: 'provider completed tool request details',
      evidenceRefs: [evidenceRef(this.input.scope, `delta-${seq}`)],
      ownerId: 'test.provider',
      nextAction: { kind: 'continue', ref: 'streaming' },
    };
    return {
      taskId: this.input.taskId,
      executionEpoch: this.input.executionEpoch,
      kind: 'provider.output',
      evidenceRefs: providerEvent.evidenceRefs,
      providerEvent,
    } as unknown as AgentEvent;
  }

  private completionEvent(): AgentEvent {
    const providerEvent: ProviderEvent = {
      runtimeId: this.input.runtimeId,
      taskId: this.input.taskId,
      operationId: this.input.operationId,
      executionEpoch: this.input.executionEpoch,
      eventId: 'arguments-done',
      kind: 'output',
      turnId: 'turn-request-budget',
      requestId: 'request-request-budget',
      summary: 'arguments complete',
      outputRefs: ['asset://provider/arguments-done'],
      evidenceRefs: [evidenceRef(this.input.scope, 'arguments-done')],
      ownerId: 'test.provider',
      nextAction: { kind: 'continue', ref: 'tool-call' },
    };
    return {
      taskId: this.input.taskId,
      executionEpoch: this.input.executionEpoch,
      kind: 'provider.output',
      evidenceRefs: providerEvent.evidenceRefs,
      providerEvent,
    } as unknown as AgentEvent;
  }

  async *observe(): AsyncIterable<AgentEvent> {
    try {
      if (this.scenario === 'silent') {
        await new Promise(() => {});
        return;
      }
      const deltaCount = this.scenario === 'never-completes' ? Number.POSITIVE_INFINITY : 60;
      for (let seq = 0; seq < deltaCount; seq += 1) {
        yield this.deltaEvent(seq);
        await sleep(10);
      }
      if (this.scenario === 'completes-after-stream') yield this.completionEvent();
    } finally {
      this.observeReturned = true;
    }
  }

  async requestStop(input: Parameters<RuntimeExecutionDriver['requestStop']>[0]) {
    this.stopRequests += 1;
    return { requested: true, operationId: input.operationId };
  }

  async settle() {
    return {
      state: this.settleState,
      evidenceRefs: [evidenceRef(this.input.scope, `closure-${this.settleState}`)],
    };
  }

  async close() {
    return {
      bindingId: 'request-budget-binding',
      providerId: 'request-budget-provider',
      protocol: 'responses' as const,
      state: 'closed' as const,
      evidenceRefs: [],
    };
  }
}

const checkpointStore = {
  async verify() { return { valid: true as const }; },
  async readLatest() { return null; },
  async readCommitted() { return null; },
  async listCommitted() { return { checkpoints: [] }; },
  async readExecutionPosition() { return null; },
  async readCheckpointRecoveryBinding() { return null; },
  async append(input: { readonly checkpoint: { readonly id: { readonly value: string }; readonly seq: number } }) {
    return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq };
  },
  async commit(checkpoint: { readonly id: { readonly value: string } }) {
    return { checkpointId: checkpoint.id, committed: true as const };
  },
};

function budgetCoordinator(input: {
  readonly scenario: 'never-completes' | 'completes-after-stream' | 'silent';
  readonly settleState: 'succeeded' | 'stopped';
  readonly orchestrate: boolean;
  readonly executionBudget: { readonly maxTurnDurationMs?: number; readonly maxSilentDurationMs?: number; readonly noProgressAtMs?: number };
}): { readonly coordinator: RuntimeTaskCoordinator; readonly driver: () => DeltaDriver } {
  let driver: DeltaDriver | undefined;
  const coordinator = new RuntimeTaskCoordinator({
    organId: coordinatorOrganId,
    taskIdPrefix: 'request-budget',
    createDriver: (driverInput) => {
      driver = new DeltaDriver(driverInput, input.scenario, input.settleState);
      return driver;
    },
    admitExecution: async () => {},
    executionBudget: input.executionBudget,
    checkpointStoreFor: () => checkpointStore as never,
    attentionPort: {
      async publish(attention: { readonly attentionId: string }) {
        return { attentionId: attention.attentionId, delivered: true };
      },
      async resolve(attention: { readonly attentionId: string }) {
        return { attentionId: attention.attentionId, delivered: true };
      },
    },
    ...(input.orchestrate
      ? {
          createTaskAssembly: (assemblyInput: { readonly executionAgent?: { execute(input: never): Promise<unknown> } }) => ({
            orchestration: {
              async planStage() {},
              async dispatch(dispatchInput: { readonly assignment: never; readonly agentId: string }) {
                const executionAgent = assemblyInput.executionAgent;
                if (!executionAgent) throw new Error('execution agent missing');
                await executionAgent.execute({
                  assignment: dispatchInput.assignment,
                  agentId: dispatchInput.agentId,
                } as never);
                return { status: 'merged' };
              },
            },
            runtimePool: {} as never,
          }) as never,
        }
      : {}),
  });
  return { coordinator, driver: () => driver! };
}

async function waitForState(
  coordinator: RuntimeTaskCoordinator,
  taskId: TaskId,
  states: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (states.includes(coordinator.taskSnapshot(taskId).state)) return;
    await sleep(10);
  }
  const stuck = coordinator.taskSnapshot(taskId);
  throw new Error(`runtime did not reach ${states.join('/')}; state=${stuck.state}; nextStep=${stuck.nextStep}; error=${JSON.stringify(stuck.error)}; events=${stuck.events.map((event) => `${event.kind}:${event.state}:${event.summary}`).join(' | ')}`);
}

test('a streamed content unit that never completes is stopped by the declared request budget', async () => {
  const built = budgetCoordinator({
    scenario: 'never-completes',
    settleState: 'stopped',
    orchestrate: false,
    executionBudget: { maxTurnDurationMs: 10_000, maxSilentDurationMs: 2_000, noProgressAtMs: 120 },
  });
  const task = built.coordinator.createTask({ title: 'budget', directive: 'stream forever' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['stopped', 'failed', 'blocked']);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'stopped');
  assert.strictEqual(snapshot.error?.code, 'execution.request-budget.exceeded');
  assert.match(snapshot.error?.message ?? '', /no completed content unit within 120ms/);
  assert.strictEqual(snapshot.checkpoint?.outcome, 'stopped');
  assert.strictEqual(snapshot.checkpoint?.summary, 'request-budget-exceeded');
  assert.strictEqual(built.driver().stopRequests, 1);
  const summaries = snapshot.events.map((event) => event.summary);
  assert.ok(summaries.some((summary) => summary.includes('request budget exceeded') && summary.includes('standard stop control')));
  assert.ok(snapshot.events.some((event) => event.kind === 'execution.terminal' && event.state === 'stopped'));
  assert.ok(!summaries.some((summary) => summary.includes('protocol-noncompliant')));

  const recordedAfterStop = snapshot.events.length;
  await sleep(200);
  const later = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(later.events.length, recordedAfterStop);
  assert.strictEqual(built.driver().stopRequests, 1);
});

test('a long stream that keeps completing units inside the budget finishes normally', async () => {
  const built = budgetCoordinator({
    scenario: 'completes-after-stream',
    settleState: 'succeeded',
    orchestrate: false,
    executionBudget: { maxTurnDurationMs: 5_000, maxSilentDurationMs: 300, noProgressAtMs: 1_500 },
  });
  const task = built.coordinator.createTask({ title: 'legal long stream', directive: 'stream then complete' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['succeeded', 'failed', 'blocked', 'stopped']);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'succeeded');
  assert.strictEqual(snapshot.error, undefined);
  assert.strictEqual(built.driver().stopRequests, 0);
  const deltaEvents = snapshot.events.filter((event) => event.summary === 'provider completed tool request details');
  assert.ok(deltaEvents.length > 20, `expected the long delta stream to be consumed, saw ${deltaEvents.length}`);
});

test('a silent provider stream is stopped at the declared silence budget', async () => {
  const built = budgetCoordinator({
    scenario: 'silent',
    settleState: 'stopped',
    orchestrate: false,
    executionBudget: { maxTurnDurationMs: 10_000, maxSilentDurationMs: 100, noProgressAtMs: 10_000 },
  });
  const task = built.coordinator.createTask({ title: 'silent', directive: 'never answer' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['stopped', 'failed', 'blocked']);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'stopped');
  assert.match(snapshot.error?.message ?? '', /no provider event within 100ms/);
  assert.strictEqual(built.driver().stopRequests, 1);
});

test('the orchestrated provider lane uses the same budget stop', async () => {
  const built = budgetCoordinator({
    scenario: 'never-completes',
    settleState: 'stopped',
    orchestrate: true,
    executionBudget: { maxTurnDurationMs: 10_000, maxSilentDurationMs: 2_000, noProgressAtMs: 120 },
  });
  const task = built.coordinator.createTask({ title: 'orchestrated budget', directive: 'stream forever' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: true });
  await waitForState(built.coordinator, task.taskId, ['stopped', 'failed', 'blocked']);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'stopped');
  assert.strictEqual(snapshot.error?.code, 'execution.request-budget.exceeded');
  assert.strictEqual(built.driver().stopRequests, 1);
});
