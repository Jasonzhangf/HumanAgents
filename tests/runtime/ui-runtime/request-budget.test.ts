import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  id,
  type AgentEvent,
  type Checkpoint,
  type EvidenceRef,
  type ProviderEvent,
  type ProviderRequestLifecycleEvent,
  type TaskId,
} from '../../../packages/contracts/src/index.js';
import {
  projectDurableTaskInventory,
  RuntimeTaskCoordinator,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeTaskJournalPort,
  type RuntimeTaskJournalRecord,
} from '../../../packages/runtime/src/ui-runtime/coordinator.js';
import { DEFAULT_UI_EXECUTION_EVENT_BUDGET } from '../../../packages/runtime/src/ui-runtime/execution-budget.js';

const coordinatorOrganId = id('organ', 'organ-request-budget');
// One provider request that streams a single content unit at the production
// rate: a new delta about every 2.4 seconds, 130 frames, so the request spans
// roughly five minutes of provider time.
const SLOW_ADVANCING_FRAME_MS = 2_400;
const SLOW_ADVANCING_FRAMES = 130;

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
  readonly requestIds: string[] = [];
  readonly lifecyclePhases: ProviderRequestLifecycleEvent['phase'][] = [];

  constructor(
    readonly input: RuntimeExecutionDriverInput,
    private readonly scenario: 'never-completes' | 'completes-after-stream' | 'silent' | 'silent-after-first' | 'multi-request' | 'slow-advancing',
    private readonly settleState: 'succeeded' | 'stopped',
    private readonly reportLifecycle: (
      phase: ProviderRequestLifecycleEvent['phase'],
      requestId: string,
      turnId: string,
    ) => void = () => undefined,
    private readonly advanceClock: (ms: number) => void = () => undefined,
  ) {}

  private report(phase: ProviderRequestLifecycleEvent['phase'], requestId: string, turnId: string): void {
    this.lifecyclePhases.push(phase);
    this.reportLifecycle(phase, requestId, turnId);
  }

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

  private deltaEvent(seq: number, requestId = 'request-request-budget', turnId = 'turn-request-budget'): AgentEvent {
    const providerEvent: ProviderEvent = {
      runtimeId: this.input.runtimeId,
      taskId: this.input.taskId,
      operationId: this.input.operationId,
      executionEpoch: this.input.executionEpoch,
      eventId: `delta-${seq}`,
      kind: 'model',
      turnId,
      requestId,
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

  private completionEvent(eventId = 'arguments-done', requestId = 'request-request-budget', turnId = 'turn-request-budget'): AgentEvent {
    const providerEvent: ProviderEvent = {
      runtimeId: this.input.runtimeId,
      taskId: this.input.taskId,
      operationId: this.input.operationId,
      executionEpoch: this.input.executionEpoch,
      eventId,
      kind: 'output',
      turnId,
      requestId,
      summary: 'arguments complete',
      outputRefs: [`asset://provider/${eventId}`],
      evidenceRefs: [evidenceRef(this.input.scope, eventId)],
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

  private terminalEvent(requestId: string, turnId: string, seq: string): AgentEvent {
    const providerEvent: ProviderEvent = {
      runtimeId: this.input.runtimeId,
      taskId: this.input.taskId,
      operationId: this.input.operationId,
      executionEpoch: this.input.executionEpoch,
      eventId: `terminal-${seq}`,
      kind: 'terminal',
      terminalState: 'waiting',
      turnId,
      requestId,
      summary: 'request completed awaiting the next provider request',
      evidenceRefs: [evidenceRef(this.input.scope, `terminal-${seq}`)],
      ownerId: 'test.provider',
      nextAction: { kind: 'continue', ref: 'next-request' },
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
        this.report('dispatching', 'request-request-budget', 'turn-request-budget');
        this.report('dispatched', 'request-request-budget', 'turn-request-budget');
        await new Promise(() => {});
        return;
      }
      if (this.scenario === 'silent-after-first') {
        const firstRequestId = 'request-silent-first';
        const firstTurnId = 'turn-silent-first';
        this.report('dispatching', firstRequestId, firstTurnId);
        this.report('dispatched', firstRequestId, firstTurnId);
        yield this.completionEvent('output-silent-first', firstRequestId, firstTurnId);
        this.report('waiting', firstRequestId, firstTurnId);
        yield this.terminalEvent(firstRequestId, firstTurnId, 'waiting-silent-first');
        await sleep(20);
        this.report('dispatching', 'request-silent-second', 'turn-silent-second');
        this.report('dispatched', 'request-silent-second', 'turn-silent-second');
        await new Promise(() => {});
        return;
      }
      if (this.scenario === 'multi-request') {
        for (let round = 0; round < 4; round += 1) {
          const requestId = `request-multi-${round}`;
          const turnId = `turn-multi-${round}`;
          this.requestIds.push(requestId);
          this.report('dispatching', requestId, turnId);
          this.report('dispatched', requestId, turnId);
          for (let seq = 0; seq < 8; seq += 1) {
            yield this.deltaEvent(round * 100 + seq, requestId, turnId);
            await sleep(20);
          }
          yield this.completionEvent(`output-${round}`, requestId, turnId);
          this.report('waiting', requestId, turnId);
          yield this.terminalEvent(requestId, turnId, `waiting-${round}`);
          // r5 RED: the first request is already closed. A real tool or
          // orchestration wait longer than maxSilent must not be charged to it.
          await sleep(round === 0 ? 160 : 10);
        }
        this.report('settled', 'request-multi-3', 'turn-multi-3');
        return;
      }
      if (this.scenario === 'slow-advancing') {
        // Production shape: one provider request keeps a single content unit
        // open and delivers a delta roughly every 2.4 seconds, so the request
        // spans minutes while it keeps making forward progress.
        const requestId = 'request-slow-advancing';
        const turnId = 'turn-slow-advancing';
        this.requestIds.push(requestId);
        this.report('dispatching', requestId, turnId);
        this.report('dispatched', requestId, turnId);
        for (let seq = 0; seq < SLOW_ADVANCING_FRAMES; seq += 1) {
          this.advanceClock(SLOW_ADVANCING_FRAME_MS);
          yield this.deltaEvent(seq, requestId, turnId);
          await sleep(1);
        }
        this.advanceClock(1_000);
        yield this.completionEvent('output-slow-advancing', requestId, turnId);
        this.report('waiting', requestId, turnId);
        yield this.terminalEvent(requestId, turnId, 'waiting-slow-advancing');
        this.report('settled', requestId, turnId);
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

function budgetCheckpointStore(options: { readonly failStoppedCommitOnce?: boolean } = {}) {
  const commitAttempts: string[] = [];
  const committedCheckpoints: Checkpoint[] = [];
  let injectedCommitFailures = 0;
  return {
    commitAttempts,
    committedCheckpoints,
    async verify() { return { valid: true as const }; },
    async readLatest() { return null; },
    async readCommitted() { return null; },
    async listCommitted() { return { checkpoints: [] }; },
    async readExecutionPosition() { return null; },
    async readCheckpointRecoveryBinding() { return null; },
    async append(input: { readonly checkpoint: { readonly id: { readonly value: string }; readonly seq: number } }) {
      // The runtime's ContextCheckpointBoundary persists through append, not
      // through a separate commit port. Inject the one-shot stopped failure at
      // the same durable write so retry-stop has a real pending settlement.
      commitAttempts.push(input.checkpoint.id.value);
      if (options.failStoppedCommitOnce === true
        && injectedCommitFailures === 0
        && 'outcome' in input.checkpoint
        && input.checkpoint.outcome === 'stopped') {
        injectedCommitFailures += 1;
        throw new Error('injected stopped checkpoint commit failure');
      }
      committedCheckpoints.push(structuredClone(input.checkpoint as Checkpoint));
      return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq };
    },
    async commit(checkpoint: Checkpoint) {
      commitAttempts.push(checkpoint.id.value);
      if (options.failStoppedCommitOnce === true
        && injectedCommitFailures === 0
        && checkpoint.outcome === 'stopped') {
        injectedCommitFailures += 1;
        throw new Error('injected stopped checkpoint commit failure');
      }
      committedCheckpoints.push(structuredClone(checkpoint));
      return { checkpointId: checkpoint.id, committed: true as const };
    },
  };
}

/** File-backed journal so a cold read parses a fresh copy from the same root. */
class FileRuntimeTaskJournal implements RuntimeTaskJournalPort {
  constructor(private readonly filePath: string) {}

  append(record: RuntimeTaskJournalRecord): void {
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  replay(): readonly RuntimeTaskJournalRecord[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RuntimeTaskJournalRecord);
  }
}

function budgetCoordinator(input: {
  readonly scenario: 'never-completes' | 'completes-after-stream' | 'silent' | 'silent-after-first' | 'multi-request' | 'slow-advancing';
  readonly settleState: 'succeeded' | 'stopped';
  readonly orchestrate: boolean;
  readonly failStoppedCommitOnce?: boolean;
  readonly journal?: RuntimeTaskJournalPort;
  readonly executionBudget: { readonly maxTurnDurationMs?: number; readonly maxSilentDurationMs?: number; readonly noProgressAtMs?: number };
  readonly now?: () => Date;
  readonly advanceClock?: (ms: number) => void;
}): { readonly coordinator: RuntimeTaskCoordinator; readonly driver: () => DeltaDriver; readonly store: ReturnType<typeof budgetCheckpointStore> } {
  let driver: DeltaDriver | undefined;
  let coordinator: RuntimeTaskCoordinator;
  const store = budgetCheckpointStore({ failStoppedCommitOnce: input.failStoppedCommitOnce });
  coordinator = new RuntimeTaskCoordinator({
    organId: coordinatorOrganId,
    taskIdPrefix: 'request-budget',
    createDriver: (driverInput) => {
      driver = new DeltaDriver(driverInput, input.scenario, input.settleState, (phase, requestId, turnId) => {
        void coordinator.recordProviderRequestIdentity({
          runtimeId: driverInput.runtimeId,
          taskId: driverInput.taskId,
          operationId: driverInput.operationId,
          executionEpoch: driverInput.executionEpoch,
          turnId,
          requestId,
          phase,
          occurredAt: new Date().toISOString(),
          evidenceRefs: [evidenceRef(driverInput.scope, `lifecycle-${phase}-${requestId}`)],
        });
      }, input.advanceClock);
      return driver;
    },
    admitExecution: async () => {},
    executionBudget: input.executionBudget,
    ...(input.now === undefined ? {} : { now: input.now }),
    checkpointStoreFor: () => store as never,
    ...(input.journal === undefined ? {} : { journal: input.journal }),
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
  return { coordinator, driver: () => driver!, store };
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

test('DEFAULT production budget keeps a five-minute slow but advancing request alive', async () => {
  // Production RCC keeps one provider request open and streams a single content
  // unit at roughly one delta every 2.4 seconds for many minutes. The old
  // agent-io default stopped it at 120s of request lifetime even though it was
  // advancing. With the production-calibrated UI runtime defaults, no budget
  // may stop it: it must run past the old 120s window and converge.
  let clockMs = Date.parse('2026-10-25T09:00:00Z');
  const built = budgetCoordinator({
    scenario: 'slow-advancing',
    settleState: 'succeeded',
    orchestrate: false,
    // Absent: the coordinator applies its production-calibrated default budget.
    executionBudget: {},
    now: () => new Date(clockMs),
    advanceClock: (ms) => { clockMs += ms; },
  });
  const task = built.coordinator.createTask({ title: 'slow but advancing', directive: 'drip arguments then answer' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['succeeded', 'failed', 'blocked', 'stopped']);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  const providerElapsedMs = clockMs - Date.parse('2026-10-25T09:00:00Z');
  assert.ok(providerElapsedMs > 120_000, `expected the request to span well past the old 120s window, saw ${providerElapsedMs}ms`);
  assert.strictEqual(snapshot.state, 'succeeded');
  assert.strictEqual(snapshot.error, undefined);
  assert.strictEqual(built.driver().stopRequests, 0);
  assert.ok(!snapshot.events.some((event) => event.summary.includes('request budget exceeded')));
});

test('the UI runtime fallback budget stays looser than the transport silence judgement', () => {
  // Two layers judge one provider request. The transport ends real silence at
  // 120s with the typed stream.no-progress error, which production proved. The
  // UI runtime budget is only a final backstop, so it must never be tighter
  // than the transport: otherwise it kills a stream the transport would have
  // carried to completion, and two layers stop the same attempt.
  assert.ok(
    DEFAULT_UI_EXECUTION_EVENT_BUDGET.maxSilentDurationMs > 120_000,
    `runtime silence fallback must exceed the transport 120s silence judgement, saw ${DEFAULT_UI_EXECUTION_EVENT_BUDGET.maxSilentDurationMs}ms`,
  );
  assert.ok(
    (DEFAULT_UI_EXECUTION_EVENT_BUDGET.noProgressAtMs ?? 0) >= 600_000,
    `runtime no-progress fallback must not judge a unit by anything tighter than 600s, saw ${DEFAULT_UI_EXECUTION_EVENT_BUDGET.noProgressAtMs}ms`,
  );
  assert.ok(
    DEFAULT_UI_EXECUTION_EVENT_BUDGET.maxTurnDurationMs >= 1_800_000,
    `runtime per-request ceiling must leave room for a 26 minute production request, saw ${DEFAULT_UI_EXECUTION_EVENT_BUDGET.maxTurnDurationMs}ms`,
  );
});

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

test('consecutive real provider requests that each stay inside the turn budget complete normally', async () => {
  // r4-1 RED: the budget clock is the provider-reported request identity, so
  // four legal requests whose total wall time exceeds one maxTurnDurationMs
  // must not be stopped. Each request keeps making progress and finishes.
  const built = budgetCoordinator({
    scenario: 'multi-request',
    settleState: 'succeeded',
    orchestrate: false,
    executionBudget: { maxTurnDurationMs: 200, maxSilentDurationMs: 100, noProgressAtMs: 5_000 },
  });
  const task = built.coordinator.createTask({ title: 'multi request budget', directive: 'four legal requests' });
  const wallStart = Date.now();
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['succeeded', 'stopped', 'failed', 'blocked']);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'succeeded');
  assert.strictEqual(snapshot.error, undefined);
  assert.strictEqual(built.driver().stopRequests, 0);
  const acceptedRequests = new Set(
    snapshot.events
      .filter((event) => event.requestId !== undefined)
      .map((event) => event.requestId!),
  );
  assert.deepEqual([...acceptedRequests].sort(), ['request-multi-0', 'request-multi-1', 'request-multi-2', 'request-multi-3']);
  assert.deepEqual(built.driver().lifecyclePhases, [
    'dispatching', 'dispatched', 'waiting',
    'dispatching', 'dispatched', 'waiting',
    'dispatching', 'dispatched', 'waiting',
    'dispatching', 'dispatched', 'waiting',
    'settled',
  ]);
  const elapsed = Date.now() - wallStart;
  assert.ok(elapsed > 200, `the multi-request task must outlive one turn budget, elapsed=${elapsed}`);
});

test('a later dispatched request that stays silent is still stopped by the silence budget', async () => {
  // r5 guard: if the closed inter-request window disabled silence forever, a
  // genuinely dispatched but silent next request would never stop. The typed
  // lifecycle must reopen the request budget before its first delta.
  const built = budgetCoordinator({
    scenario: 'silent-after-first',
    settleState: 'stopped',
    orchestrate: false,
    executionBudget: { maxTurnDurationMs: 10_000, maxSilentDurationMs: 120, noProgressAtMs: 10_000 },
  });
  const task = built.coordinator.createTask({ title: 'silent later request', directive: 'silence after one legal request' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['stopped', 'failed', 'blocked']);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'stopped');
  assert.strictEqual(snapshot.error?.code, 'execution.request-budget.exceeded');
  assert.match(snapshot.error?.message ?? '', /no provider event within 120ms/);
  assert.strictEqual(built.driver().stopRequests, 1);
  assert.ok(
    built.driver().lifecyclePhases.includes('dispatched')
      && built.driver().lifecyclePhases.filter((phase) => phase === 'dispatched').length === 2,
    `both requests must report typed dispatch before their first delta, saw ${built.driver().lifecyclePhases.join(',')}`,
  );
});

test('one open provider request that never finishes is still stopped at the turn budget', async () => {
  // r4-1 guard: the per-request boundary must not disable the single open
  // request stop. Deltas stay activity; the content unit never completes.
  const built = budgetCoordinator({
    scenario: 'never-completes',
    settleState: 'stopped',
    orchestrate: false,
    executionBudget: { maxTurnDurationMs: 120, maxSilentDurationMs: 5_000, noProgressAtMs: 5_000 },
  });
  const task = built.coordinator.createTask({ title: 'single open request', directive: 'never answer' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['stopped', 'failed', 'blocked']);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'stopped');
  assert.strictEqual(snapshot.error?.code, 'execution.request-budget.exceeded');
  assert.match(snapshot.error?.message ?? '', /turn duration/);
  assert.strictEqual(built.driver().stopRequests, 1);
});

test('a deadline crossing after a manual stop writes no budget error or settling in the direct lane', async () => {
  const built = budgetCoordinator({
    scenario: 'silent',
    settleState: 'stopped',
    orchestrate: false,
    executionBudget: { maxTurnDurationMs: 10_000, maxSilentDurationMs: 250, noProgressAtMs: 10_000 },
  });
  const task = built.coordinator.createTask({ title: 'manual stop direct lane', directive: 'never answer' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['running', 'stopped']);
  const stopped = await built.coordinator.stop(task.taskId);
  assert.strictEqual(stopped.state, 'stopped');
  await sleep(600);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'stopped');
  assert.strictEqual(snapshot.error, undefined);
  assert.strictEqual(snapshot.checkpoint?.summary, 'operator-stop');
  assert.strictEqual(snapshot.checkpoint?.outcome, 'stopped');
  assert.strictEqual(built.driver().stopRequests, 1);
  const settling = snapshot.events.filter((event) => event.kind === 'execution.settling');
  assert.strictEqual(settling.length, 1);
  assert.ok(!snapshot.events.some((event) => event.summary.includes('request budget exceeded')));
});

test('a deadline crossing after a manual stop writes no budget error or settling in the orchestrated lane', async () => {
  const built = budgetCoordinator({
    scenario: 'silent',
    settleState: 'stopped',
    orchestrate: true,
    executionBudget: { maxTurnDurationMs: 10_000, maxSilentDurationMs: 250, noProgressAtMs: 10_000 },
  });
  const task = built.coordinator.createTask({ title: 'manual stop orchestrated lane', directive: 'never answer' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: true });
  await waitForState(built.coordinator, task.taskId, ['running', 'stopped']);
  const stopped = await built.coordinator.stop(task.taskId);
  assert.strictEqual(stopped.state, 'stopped');
  await sleep(600);

  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'stopped');
  assert.strictEqual(snapshot.error, undefined);
  assert.strictEqual(snapshot.checkpoint?.summary, 'operator-stop');
  assert.strictEqual(snapshot.checkpoint?.outcome, 'stopped');
  assert.strictEqual(built.driver().stopRequests, 1);
  const settling = snapshot.events.filter((event) => event.kind === 'execution.settling');
  assert.strictEqual(settling.length, 1);
  assert.ok(!snapshot.events.some((event) => event.summary.includes('request budget exceeded')));
});

test('retry-stop reuses the prepared budget stop settlement and its typed reason', async () => {
  const built = budgetCoordinator({
    scenario: 'never-completes',
    settleState: 'stopped',
    orchestrate: false,
    failStoppedCommitOnce: true,
    executionBudget: { maxTurnDurationMs: 10_000, maxSilentDurationMs: 2_000, noProgressAtMs: 120 },
  });
  const task = built.coordinator.createTask({ title: 'retry budget stop', directive: 'stream forever' });
  built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
  await waitForState(built.coordinator, task.taskId, ['settling', 'blocked', 'stopped', 'failed']);

  const failed = built.coordinator.taskSnapshot(task.taskId);
  assert.ok(failed.allowedActions.includes('retry-stop'), `expected retry-stop to be allowed, saw ${failed.allowedActions}`);
  assert.strictEqual(failed.checkpoint, undefined);
  assert.ok(failed.events.some((event) => event.kind === 'attention.opened'));

  const retried = await built.coordinator.retryStop(task.taskId);
  assert.strictEqual(retried.state, 'stopped');
  const snapshot = built.coordinator.taskSnapshot(task.taskId);
  assert.strictEqual(snapshot.state, 'stopped');
  assert.strictEqual(snapshot.checkpoint?.summary, 'request-budget-exceeded');
  assert.strictEqual(snapshot.checkpoint?.outcome, 'stopped');
  assert.strictEqual(snapshot.operationId, failed.operationId);
  assert.strictEqual(built.store.commitAttempts.length, 2);
  assert.strictEqual(built.store.commitAttempts[0], built.store.commitAttempts[1]);
  assert.strictEqual(built.driver().stopRequests, 1);
});

test('a fresh cold read from the same root restores the typed budget error and stopped checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b4-r4-cold-read-'));
  try {
    const journalPath = join(root, 'ui-runtime-journal.jsonl');
    const journal = new FileRuntimeTaskJournal(journalPath);
    const built = budgetCoordinator({
      scenario: 'never-completes',
      settleState: 'stopped',
      orchestrate: false,
      journal,
      executionBudget: { maxTurnDurationMs: 10_000, maxSilentDurationMs: 2_000, noProgressAtMs: 120 },
    });
    const task = built.coordinator.createTask({ title: 'cold read budget', directive: 'stream forever' });
    built.coordinator.startExecution(task.taskId, { prompt: 'execute', orchestrate: false });
    await waitForState(built.coordinator, task.taskId, ['stopped', 'failed', 'blocked']);
    assert.strictEqual(built.coordinator.taskSnapshot(task.taskId).state, 'stopped');
    assert.strictEqual(built.store.committedCheckpoints.length, 1);

    const recordsBeforeColdRead = journal.replay().length;
    const linesBeforeColdRead = readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.length > 0).length;
    const freshJournal = new FileRuntimeTaskJournal(journalPath);
    const inventory = await projectDurableTaskInventory({
      records: freshJournal.replay(),
      checkpointFor: () => ({
        async readLatest() {
          const checkpoint = built.store.committedCheckpoints.at(-1);
          return checkpoint ? { checkpoint, previous: null } : null;
        },
      }),
    });
    const entry = inventory.entries.find((candidate) => candidate.snapshot.taskId.value === task.taskId.value);
    assert.ok(entry, `fresh cold read must find the task; failures=${JSON.stringify(inventory.failures)}`);
    const cold = entry!;
    assert.strictEqual(cold.durableState, 'checkpoint');
    assert.strictEqual(cold.snapshot.error?.code, 'execution.request-budget.exceeded');
    assert.strictEqual(cold.snapshot.error?.ownerId, 'humanagent.runtime');
    assert.match(cold.snapshot.error?.message ?? '', /request budget exceeded: no completed content unit/);
    assert.strictEqual(cold.snapshot.error?.nextAction, 'inspect the unfinished provider request before starting another execution');
    assert.strictEqual(cold.snapshot.checkpoint?.outcome, 'stopped');
    assert.strictEqual(cold.snapshot.checkpoint?.summary, 'request-budget-exceeded');
    assert.strictEqual(freshJournal.replay().length, recordsBeforeColdRead, 'a cold read must not append records');
    assert.strictEqual(
      readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.length > 0).length,
      linesBeforeColdRead,
      'a cold read must not restart the business request or append to the journal',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
