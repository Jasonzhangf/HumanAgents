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

const coordinatorOrganId = id('organ', 'organ-executor-evidence');

interface CapturedExecutorEvidence {
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

interface CapturedWorkResult {
  readonly status: string;
  readonly executorEvidence?: readonly CapturedExecutorEvidence[];
}

interface DriverEventSpec {
  readonly kind: 'output' | 'tool';
  readonly summary: string;
  readonly evidenceId: string;
  readonly stale?: boolean;
  readonly toolCall?: {
    readonly callId: string;
    readonly toolId: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  };
}

function evidenceRef(taskId: TaskId, evidenceId: string): EvidenceRef {
  return {
    evidenceId: id('evidence', evidenceId),
    kind: 'external',
    source: 'executor-evidence-test',
    locator: `provider/${evidenceId}`,
    scope: { organId: coordinatorOrganId, taskId },
  };
}

class EvidenceDriver implements RuntimeExecutionDriver {
  readonly kind = 'executor-evidence.fake-driver';
  readonly observations: number[] = [];

  constructor(
    readonly input: RuntimeExecutionDriverInput,
    private readonly events: readonly DriverEventSpec[],
    private readonly settleState: 'succeeded' | 'failed',
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

  async *observe(): AsyncIterable<AgentEvent> {
    this.observations.push(this.observations.length + 1);
    for (const spec of this.events) {
      const eventTaskId = spec.stale ? id('task', 'stale-task') : this.input.taskId;
      const eventEpoch = this.input.executionEpoch;
      const ref = evidenceRef(eventTaskId, spec.evidenceId);
      const providerEvent: ProviderEvent = {
        runtimeId: this.input.runtimeId,
        taskId: eventTaskId,
        operationId: this.input.operationId,
        executionEpoch: eventEpoch,
        eventId: `${spec.evidenceId}-event`,
        kind: spec.kind,
        turnId: 'turn-executor-evidence',
        requestId: 'request-executor-evidence',
        occurredAt: '2026-10-10T00:00:00.000Z',
        summary: spec.summary,
        evidenceRefs: [ref],
        ownerId: 'test.provider',
        nextAction: { kind: 'continue', ref: spec.evidenceId },
        ...(spec.toolCall === undefined
          ? {}
          : { toolPhase: 'invoke' as const, toolCall: spec.toolCall as never }),
      };
      yield {
        taskId: eventTaskId,
        executionEpoch: eventEpoch,
        kind: spec.kind === 'tool' ? 'provider.tool' : 'provider.output',
        evidenceRefs: providerEvent.evidenceRefs,
        providerEvent,
      } as unknown as AgentEvent;
    }
  }

  async requestStop(input: Parameters<RuntimeExecutionDriver['requestStop']>[0]) {
    return { requested: true, operationId: input.operationId };
  }

  async settle() {
    return {
      state: this.settleState,
      evidenceRefs: [evidenceRef(this.input.taskId, `closure-${this.settleState}`)],
    };
  }

  async close() {
    return {
      bindingId: 'executor-evidence-binding',
      providerId: 'executor-evidence-provider',
      protocol: 'responses' as const,
      state: 'closed' as const,
      evidenceRefs: [],
    };
  }
}

function evidenceCoordinator(
  events: readonly DriverEventSpec[],
  settleState: 'succeeded' | 'failed',
  captured: { result?: CapturedWorkResult },
): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId: coordinatorOrganId,
    taskIdPrefix: 'executor-evidence',
    createDriver: (input) => new EvidenceDriver(input, events, settleState),
    checkpointStoreFor: () => ({
      async verify() { return { valid: true as const }; },
      async readLatest() { return null; },
      async append(input) { return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq }; },
      async commit(checkpoint) { return { checkpointId: checkpoint.id, committed: true as const }; },
    }),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
    createTaskAssembly: (input) => ({
      orchestration: {
        async planStage() {},
        async dispatch(dispatchInput: { readonly assignment: never; readonly agentId: string }) {
          const executionAgent = input.executionAgent;
          if (!executionAgent) throw new Error('execution agent missing');
          const result = await executionAgent.execute({
            assignment: dispatchInput.assignment,
            agentId: dispatchInput.agentId,
          } as never);
          captured.result = result as CapturedWorkResult;
          return { status: 'merged' };
        },
      },
      runtimePool: {} as never,
    }) as never,
  });
}

async function waitForTerminal(runtime: RuntimeTaskCoordinator, taskId: TaskId): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = runtime.taskSnapshot(taskId).state;
    if (state === 'succeeded' || state === 'failed' || state === 'blocked') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`runtime did not finish; state=${runtime.taskSnapshot(taskId).state}`);
}

function aggregateEntries(result: CapturedWorkResult | undefined): readonly CapturedExecutorEvidence[] {
  return (result?.executorEvidence ?? []).filter((entry) => entry.summary.includes('executor aggregate'));
}

async function runCase(
  events: readonly DriverEventSpec[],
  settleState: 'succeeded' | 'failed',
): Promise<{ readonly result: CapturedWorkResult | undefined }> {
  const captured: { result?: CapturedWorkResult } = {};
  const runtime = evidenceCoordinator(events, settleState, captured);
  const task = runtime.createTask({ title: 'executor evidence', directive: 'observe executor evidence' });
  runtime.startExecution(task.taskId, { prompt: 'execute', orchestrate: true });
  await waitForTerminal(runtime, task.taskId);
  return { result: captured.result };
}

test('executor evidence aggregates a complete no-tool accepted stream', async () => {
  const { result } = await runCase(
    [{ kind: 'output', summary: 'done', evidenceId: 'observed-output' }],
    'succeeded',
  );

  assert.equal(result?.status, 'succeeded');
  const aggregates = aggregateEntries(result);
  assert.equal(aggregates.length, 1);
  const aggregate = aggregates[0]!;
  assert.match(aggregate.summary, /observed 1 provider event\(s\)/);
  assert.match(aggregate.summary, /0 tool event\(s\)/);
  assert.match(aggregate.summary, /no tool execution was observed/);
  assert.match(aggregate.summary, /closure succeeded/);
  assert.match(aggregate.summary, /0 produced file readback\(s\)/);
  assert.deepEqual(
    aggregate.evidenceRefs.map((ref) => ref.evidenceId.value),
    ['observed-output', 'closure-succeeded'],
  );
  assert.doesNotMatch(aggregate.summary, /whole Provider|machine had no side effects/);
});

test('executor evidence keeps a tool entry and does not report zero tools', async () => {
  const { result } = await runCase([
    { kind: 'output', summary: 'done', evidenceId: 'observed-output' },
    {
      kind: 'tool',
      summary: 'tool ran',
      evidenceId: 'observed-tool',
      toolCall: { callId: 'call-1', toolId: 'shell.run', arguments: {} },
    },
  ], 'succeeded');

  assert.equal(result?.status, 'succeeded');
  const evidence = result?.executorEvidence ?? [];
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0]?.summary, 'tool ran');
  assert.deepEqual(
    evidence[0]?.evidenceRefs.map((ref) => ref.evidenceId.value),
    ['observed-tool'],
  );
  const aggregates = aggregateEntries(result);
  assert.equal(aggregates.length, 1);
  assert.match(aggregates[0]!.summary, /observed 2 provider event\(s\)/);
  assert.match(aggregates[0]!.summary, /1 tool event\(s\)/);
  assert.doesNotMatch(aggregates[0]!.summary, /0 tool event\(s\)/);
});

test('executor evidence omits the success aggregate when settlement fails', async () => {
  const { result } = await runCase(
    [{ kind: 'output', summary: 'done', evidenceId: 'observed-output' }],
    'failed',
  );

  assert.equal(result?.status, 'failed');
  assert.equal(aggregateEntries(result).length, 0);
});

test('executor evidence ignores a fenced stale event in counts and refs', async () => {
  const { result } = await runCase([
    { kind: 'output', summary: 'done', evidenceId: 'observed-output' },
    { kind: 'output', summary: 'stale', evidenceId: 'stale-output', stale: true },
  ], 'succeeded');

  assert.equal(result?.status, 'succeeded');
  const aggregates = aggregateEntries(result);
  assert.equal(aggregates.length, 1);
  assert.match(aggregates[0]!.summary, /observed 1 provider event\(s\)/);
  const refs = aggregates[0]!.evidenceRefs.map((ref) => ref.evidenceId.value);
  assert.deepEqual(refs, ['observed-output', 'closure-succeeded']);
  assert.ok(!refs.includes('stale-output'));
});
