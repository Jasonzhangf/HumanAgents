import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AgentEvent,
  type Attention,
  type EvidenceRef,
  type ProviderBinding,
  type ProviderCloseResult,
  type StopRequestReceipt,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import { RuntimeTaskCoordinator, type RuntimeExecutionDriver, type RuntimeExecutionDriverInput } from '../../../packages/runtime/src/ui-runtime/coordinator.js';
import { OrchestrationManager } from '../../../packages/runtime/src/orchestration/manager.js';
import { AgentRuntimePoolManager } from '../../../packages/runtime/src/orchestration/runtime-pool.js';
import type {
  ExecutionAgentPort,
  MergeCoordinatorPort,
  OrchestrationRuntimeFactoryPort,
  ReviewAgentPort,
} from '../../../packages/runtime/src/orchestration/index.js';
import type { ReviewResult } from '../../../packages/runtime/src/review/index.js';
import {
  type RetryCycleConfigSet,
  type RetryCycleControlRecord,
  type RetryCycleJournalPort,
} from '../../../packages/runtime/src/orchestration/retry-cycle.js';

const organId = id('organ', 'retry10-integration-organ');
const scope: ScopeRef = { organId, taskId: id('task', 'retry10-integration-task') };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `retry10-${label}`),
    kind: 'operation',
    source: 'retry10-coordinator-test',
    locator: label,
    scope,
  };
}

function binding(bindingId: string): ProviderBinding {
  return {
    bindingId,
    providerId: `provider-${bindingId}`,
    protocol: 'responses',
    endpointRef: 'fake://retry10',
    modelRef: `model-${bindingId}`,
    configDigest: `sha256:${bindingId}-config`,
    capabilityDigest: `sha256:${bindingId}-capability`,
  };
}

function retryConfig(bindingIds: readonly string[]): RetryCycleConfigSet {
  return {
    configRevision: 'retry10-test-revision',
    configDigest: 'sha256:retry10-test-config',
    candidates: bindingIds.map((bindingId) => ({
      binding: binding(bindingId),
      admission: {
        permissionRevision: 'test-permission',
        capabilityDigest: 'test-capability',
        readinessRef: `ready:${bindingId}`,
        leaseRef: `lease:${bindingId}`,
        checkpointRef: `checkpoint:${bindingId}`,
      },
    })),
  };
}

class MemoryRetryJournal implements RetryCycleJournalPort {
  readonly records = new Map<string, RetryCycleControlRecord>();
  readonly writes: RetryCycleControlRecord[] = [];

  async loadCycle(cycleId: string): Promise<RetryCycleControlRecord | null> {
    const record = this.records.get(cycleId);
    return record ? structuredClone(record) : null;
  }

  async persistCycle(record: RetryCycleControlRecord): Promise<RetryCycleControlRecord> {
    const key = `retry-cycle:${record.assignmentId}:${record.initialExecutionEpoch}`;
    this.records.set(key, structuredClone(record));
    this.writes.push(structuredClone(record));
    return structuredClone(record);
  }
}

class RuntimeFactory implements OrchestrationRuntimeFactoryPort {
  async start(input: Parameters<OrchestrationRuntimeFactoryPort['start']>[0]) {
    return { runtimeId: input.runtimeId, generation: input.generation, capabilities: input.requiredCapabilities };
  }
  async dispose(_input: Parameters<OrchestrationRuntimeFactoryPort['dispose']>[0]): Promise<void> {}
}

class Reviewer implements ReviewAgentPort {
  async review(input: Parameters<ReviewAgentPort['review']>[0]): Promise<ReviewResult> {
    return {
      resultId: `retry10-review-${input.reviewAssignment.assignmentId}`,
      assignmentId: input.reviewAssignment.assignmentId,
      taskId: input.reviewAssignment.taskId,
      workerAgentId: input.reviewAssignment.workerAgentId,
      reviewKind: input.reviewAssignment.reviewKind,
      attempt: input.reviewAssignment.attempt,
      executionEpoch: input.reviewAssignment.executionEpoch,
      inputRevision: input.reviewAssignment.inputRevision,
      acceptanceCriteriaDigest: input.reviewAssignment.acceptanceCriteriaDigest,
      subjectRefs: input.reviewAssignment.subjectRefs,
      subjectDigests: input.reviewAssignment.subjectDigests,
      status: 'passed',
      findings: [],
      evidenceRefs: [evidence('review')],
    };
  }
}

type ProviderOutcome = 'failed' | 'succeeded' | 'unknown' | 'unsettled' | 'cancelled';

class FakeProviderDriver implements RuntimeExecutionDriver {
  readonly kind = 'retry10-fake-provider';
  constructor(
    readonly input: RuntimeExecutionDriverInput,
    private readonly bindingId: string,
    private readonly outcome: ProviderOutcome,
    private readonly events: string[],
  ) {}

  async capabilities() { return { driverKind: this.kind, capabilities: ['execute'], version: '1' }; }
  async start(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    this.events.push(`start:${this.input.executionEpoch}`);
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }
  async resume(input: { readonly runtimeId: string; readonly executionEpoch: number }) {
    return { runtimeId: input.runtimeId, executionEpoch: input.executionEpoch };
  }
  async submit(input: Parameters<RuntimeExecutionDriver['submit']>[0]) {
    this.events.push(`submit:${this.input.executionEpoch}`);
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: input.payload,
      outputRefs: [],
      evidenceRefs: [evidence(`submit-${this.input.executionEpoch}`)],
    };
  }
  async *observe(): AsyncIterable<AgentEvent> {
    if (this.outcome === 'succeeded') {
      yield {
        taskId: this.input.taskId,
        executionEpoch: this.input.executionEpoch,
        kind: 'provider.output',
        evidenceRefs: [evidence(`output-${this.input.executionEpoch}`)],
        providerEvent: {
          eventId: `output-${this.input.executionEpoch}`,
          kind: 'output',
          bindingId: this.bindingId,
          providerId: 'fake-provider',
          executionEpoch: this.input.executionEpoch,
          operationId: this.input.operationId,
          taskId: this.input.taskId,
          assignmentId: this.input.assignmentId,
          summary: `provider artifact for ${this.bindingId}`,
          evidenceRefs: [evidence(`output-${this.input.executionEpoch}`)],
        },
      } as AgentEvent;
    }
    const terminal = this.outcome === 'failed' ? 'failed'
      : this.outcome === 'succeeded' ? 'succeeded'
        : this.outcome === 'cancelled' ? 'cancelled'
          : this.outcome === 'unknown' ? 'unknown' : 'waiting';
    yield {
      taskId: this.input.taskId,
      executionEpoch: this.input.executionEpoch,
      kind: 'provider',
      evidenceRefs: [evidence(`event-${this.input.executionEpoch}`)],
      terminalState: terminal,
      providerEvent: {
        eventId: `event-${this.input.executionEpoch}`,
        kind: 'terminal',
        bindingId: this.bindingId,
        providerId: 'fake-provider',
        executionEpoch: this.input.executionEpoch,
        operationId: this.input.operationId,
        taskId: this.input.taskId,
        assignmentId: this.input.assignmentId,
        terminalState: terminal,
        evidenceRefs: [evidence(`terminal-${this.input.executionEpoch}`)],
      },
    } as AgentEvent;
  }
  async requestStop(input: Parameters<RuntimeExecutionDriver['requestStop']>[0]): Promise<StopRequestReceipt> {
    return { requested: true, operationId: input.operationId };
  }
  async settle() {
    const state = this.outcome === 'failed' ? 'failed'
      : this.outcome === 'succeeded' ? 'succeeded'
        : this.outcome === 'cancelled' ? 'cancelled'
          : this.outcome === 'unknown' ? 'unknown' : 'waiting';
    this.events.push(`settle:${this.input.executionEpoch}:${state}`);
    return { state, evidenceRefs: [evidence(`settle-${this.input.executionEpoch}`)] } as const;
  }
  async close(): Promise<ProviderCloseResult> {
    this.events.push(`close:${this.input.executionEpoch}`);
    return {
      bindingId: this.bindingId,
      providerId: 'fake-provider',
      protocol: 'responses',
      state: 'closed',
      evidenceRefs: [evidence(`close-${this.input.executionEpoch}`)],
    };
  }
}

function makeHarness(input: {
  readonly bindingIds: readonly string[];
  readonly outcomes: readonly ProviderOutcome[];
}) {
  const events: string[] = [];
  const createdBindings: string[] = [];
  const journal = new MemoryRetryJournal();
  const attentions: Attention[] = [];
  const runtimePool = new AgentRuntimePoolManager({
    maxRuntimes: 1,
    factory: new RuntimeFactory(),
    initialRuntimes: [{ runtimeId: 'retry10-orchestrator', capabilities: ['provider.execution'] }],
  });
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    taskIdPrefix: 'retry10',
    createDriver: () => { throw new Error('retry10 must select a candidate-bound driver'); },
    providerRetry: {
      config: retryConfig(input.bindingIds),
      journal,
      createDriverForBinding(bindingId, driverInput) {
        const index = createdBindings.length;
        createdBindings.push(bindingId);
        return new FakeProviderDriver(driverInput, bindingId, input.outcomes[index] ?? 'failed', events);
      },
    },
    checkpointStoreFor: () => ({
      async verify() { return { valid: true as const }; },
      async readLatest() { return null; },
      async append(input) { return { checkpointId: input.checkpoint.id, seq: input.checkpoint.seq }; },
      async commit(checkpoint) { return { checkpointId: checkpoint.id, committed: true as const }; },
    }),
    attentionPort: {
      async publish(attention) { attentions.push(attention); return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
    createTaskAssembly({ executionAgent }) {
      const orchestration = new OrchestrationManager({
        ownerId: 'retry10-test-orchestration',
        runtimePool,
        executionAgent: executionAgent as ExecutionAgentPort,
        reviewAgent: new Reviewer(),
        mergeCoordinator: {
          async merge(_mergeInput: Parameters<MergeCoordinatorPort['merge']>[0]) {
            return { status: 'merged', evidenceRefs: [evidence('merge')] };
          },
        },
        maxAttempts: 1,
      });
      return { orchestration, runtimePool };
    },
  });
  return { coordinator, journal, events, createdBindings, attentions };
}

async function run(harness: ReturnType<typeof makeHarness>) {
  const task = harness.coordinator.createTask({ title: 'retry cycle integration', directive: 'execute through retry candidates' });
  const started = harness.coordinator.startExecution(task.taskId, { prompt: 'run', orchestrate: true });
  for (let index = 0; index < 200; index += 1) {
    const current = harness.coordinator.taskSnapshot(task.taskId);
    if (!['running', 'settling'].includes(current.state)) return { task: current, operationId: started.operationId };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`coordinator did not settle; last task state=${harness.coordinator.taskSnapshot(task.taskId).state}`);
}

test('RuntimeTaskCoordinator dispatches settled failure A then successful B with binding, epoch, journal, and closure proof', async () => {
  const harness = makeHarness({ bindingIds: ['binding-a', 'binding-b'], outcomes: ['failed', 'succeeded'] });
  const result = await run(harness);

  assert.equal(result.task.state, 'succeeded', JSON.stringify({ state: result.task.state, error: result.task.error, bindings: harness.createdBindings, events: harness.events, retry: harness.journal.writes.at(-1) }));
  assert.deepEqual(harness.createdBindings, ['binding-a', 'binding-b']);
  assert.deepEqual(harness.journal.writes.at(-1)?.attempts.map((attempt) => [attempt.bindingId, attempt.executionEpoch, attempt.settleState]), [
    ['binding-a', 1, 'retry-safe'],
    ['binding-b', 2, 'success'],
  ]);
  assert.equal(harness.journal.writes.at(-1)?.assignmentId, `assignment-${result.operationId.value}`);
  assert.equal(harness.journal.writes.at(-1)?.initialExecutionEpoch, 1);
  assert.ok(harness.events.indexOf('close:1') < harness.events.indexOf('start:2'), harness.events.join(', '));
  assert.ok(harness.events.indexOf('settle:1:failed') < harness.events.indexOf('close:1'), harness.events.join(', '));
});

test('RuntimeTaskCoordinator runs eleven settled failures once each and surfaces exhausted attention', async () => {
  const bindings = Array.from({ length: 11 }, (_, index) => `binding-${index + 1}`);
  const harness = makeHarness({ bindingIds: bindings, outcomes: Array.from({ length: 11 }, () => 'failed') });
  const result = await run(harness);

  assert.equal(harness.createdBindings.length, 11, JSON.stringify({ state: result.task.state, error: result.task.error, bindings: harness.createdBindings, events: harness.events, retry: harness.journal.writes.at(-1) }));
  assert.deepEqual(harness.createdBindings, bindings);
  assert.equal(harness.journal.writes.at(-1)?.attempts.length, 11);
  assert.equal(harness.journal.writes.at(-1)?.state, 'exhausted');
  assert.ok(result.task.error?.nextAction, JSON.stringify({ state: result.task.state, error: result.task.error, attentionCount: harness.coordinator.attentionAudit().published.length, retryState: harness.journal.writes.at(-1)?.state }));
  assert.ok(harness.coordinator.attentionAudit().published.length > 0, JSON.stringify({ state: result.task.state, error: result.task.error, retryState: harness.journal.writes.at(-1)?.state }));
});

test('RuntimeTaskCoordinator exposes no-candidate attention without an extra provider execution', async () => {
  const harness = makeHarness({ bindingIds: ['binding-only'], outcomes: ['failed'] });
  const result = await run(harness);

  assert.deepEqual(harness.createdBindings, ['binding-only']);
  assert.equal(harness.journal.writes.at(-1)?.state, 'blocked-attention');
  assert.ok(result.task.error?.nextAction, JSON.stringify({ state: result.task.state, error: result.task.error, attentionCount: harness.coordinator.attentionAudit().published.length, retryState: harness.journal.writes.at(-1)?.state }));
  assert.ok(harness.coordinator.attentionAudit().published.length > 0, JSON.stringify({ state: result.task.state, error: result.task.error, retryState: harness.journal.writes.at(-1)?.state }));
});

for (const outcome of ['unknown', 'unsettled', 'cancelled'] as const) {
  test(`RuntimeTaskCoordinator keeps ${outcome} provider outcome on the same binding and exposes recovery responsibility`, async () => {
    const harness = makeHarness({ bindingIds: ['binding-a', 'binding-b'], outcomes: [outcome, 'succeeded'] });
    const result = await run(harness);

    assert.deepEqual(harness.createdBindings, ['binding-a']);
    assert.equal(harness.journal.writes.at(-1)?.state, 'blocked-attention');
    assert.equal(harness.journal.writes.at(-1)?.attempts.length, 1);
    assert.ok(result.task.error?.nextAction, JSON.stringify({ state: result.task.state, error: result.task.error, attentionCount: harness.coordinator.attentionAudit().published.length, retryState: harness.journal.writes.at(-1)?.state }));
    assert.ok(harness.coordinator.attentionAudit().published.length > 0, JSON.stringify({ state: result.task.state, error: result.task.error, retryState: harness.journal.writes.at(-1)?.state }));
  });
}
