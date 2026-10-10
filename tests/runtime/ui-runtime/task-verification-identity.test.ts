import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  id,
  type AgentEvent,
  type EvidenceRef,
  type ProviderEvent,
  type ProviderToolResult,
  type Scope,
  type TaskCheckEvidence,
  type TaskCheckPolicy,
  type TaskId,
  type TaskExecutionEvidence,
  type TaskVerificationBinding,
  type TaskVerificationPolicy,
} from '../../../packages/contracts/src/index.js';
import type {
  TaskVerificationExecutionPort,
  TaskVerificationPort,
} from '../../../packages/runtime/src/gateway/ports.js';
import {
  RuntimeTaskCoordinator,
  RuntimeTaskControlError,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeTaskEvent,
  type RuntimeTaskJournalPort,
  type RuntimeTaskJournalRecord,
} from '../../../packages/runtime/src/ui-runtime/coordinator.js';
import {
  TaskVerificationBridge,
  TaskVerificationError,
  TaskVerificationIdentityConflictError,
} from '../../../packages/runtime/src/ui-runtime/task-verification.js';
import { verificationPolicyDigest } from '../../../packages/runtime/src/ui-runtime/verification-policy-compiler.js';

const scope: Scope = {
  organId: id('organ', 'organ-verification-identity'),
  taskId: id('task', 'task-verification-identity'),
};
const taskId = scope.taskId!;
const operationId = id('operation', 'operation-verification-identity');
const inputDigest = `sha256:${'1'.repeat(64)}`;
const SHA_X = sha('evaluator-x');
const SHA_Y = sha('evaluator-y');
const coordinatorOrganId = id('organ', 'organ-runtime-facet-identity');
const coordinatorOutputRefs = [
  'asset://provider-tool/output/result-b',
  'asset://provider-tool/output/result-a',
] as const;
type RuntimeTaskEventWithFacets = RuntimeTaskEvent & {
  readonly externalResponseId?: string;
  readonly responseModel?: string;
  readonly outputRefs?: readonly string[];
};
const evidenceRefs: readonly EvidenceRef[] = [
  {
    evidenceId: id('evidence', 'verification-input-evidence'),
    kind: 'operation',
    source: 'verification-identity-test',
    locator: 'verification/input-evidence',
    scope,
  },
];

function sha(label: string): string {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function policy(evaluatorDigest: string): TaskVerificationPolicy {
  const unsigned = {
    policyId: 'policy-verification-identity',
    policyRevision: 1,
    requirementId: 'requirement-verification-identity',
    directiveRevision: 1,
    profileRef: 'verification-profile://default/v1',
    checks: [
      {
        checkId: 'native-default-task-output',
        kind: 'native' as const,
        required: true,
        evaluator: 'default-task-output-v1' as const,
        evaluatorDigest,
        timeoutMs: 10_000,
        permissionRefs: ['permission://task-output/read'],
      },
    ],
  };
  return {
    ...unsigned,
    compiledRef: 'verification-policy:policy-verification-identity:1',
    compiledDigest: verificationPolicyDigest({
      ...unsigned,
      compiledRef: '',
      compiledDigest: '',
    }),
  };
}

function binding(forPolicy: TaskVerificationPolicy, attempt = 1): TaskVerificationBinding {
  return {
    bindingRef: `binding-verification:${forPolicy.compiledDigest}`,
    bindingDigest: sha(`binding:${forPolicy.compiledDigest}:${attempt}`),
    policyRef: forPolicy.compiledRef,
    policyDigest: forPolicy.compiledDigest,
    taskId,
    operationId,
    executionEpoch: 1,
    attempt,
    executionEvidenceRef: `task-execution:${operationId.value}`,
    executionEvidenceDigest: inputDigest,
    artifacts: [
      {
        role: 'primary',
        artifactRef: 'artifact://verification-input',
        artifactDigest: inputDigest,
      },
    ],
    boundAt: '2026-10-05T00:00:00.000Z',
  };
}

function executionEvidence(): TaskExecutionEvidence {
  return {
    taskId,
    operationId,
    executionEpoch: 1,
    inputArtifactDigest: inputDigest,
    stdout: '',
    exitCode: 0,
    evidenceRefs,
  };
}

function checkEvidence(
  input: Parameters<TaskVerificationExecutionPort['execute']>[0],
  status: 'succeeded' | 'failed',
): TaskCheckEvidence {
  const check = input.check as Extract<TaskCheckPolicy, { kind: 'native' }>;
  return {
    checkId: check.checkId,
    kind: check.kind,
    status,
    decisionRef: `verification-decision:${check.checkId}`,
    decisionDigest: sha(`decision:${check.evaluatorDigest}:${status}`),
    artifactDigests: input.binding.artifacts.map((artifact) => artifact.artifactDigest),
    evidenceRefs: [
      {
        evidenceId: id('evidence', `verification-result-${status}`),
        kind: 'operation',
        source: 'verification-identity-test',
        locator: `verification/result/${status}`,
        scope,
      },
    ],
  };
}

class MemoryRuntimeTaskJournal implements RuntimeTaskJournalPort {
  readonly records: RuntimeTaskJournalRecord[];

  constructor(records: readonly RuntimeTaskJournalRecord[] = []) {
    this.records = structuredClone(records) as RuntimeTaskJournalRecord[];
  }

  append(record: RuntimeTaskJournalRecord): void {
    this.records.push(structuredClone(record));
  }

  replay(): readonly RuntimeTaskJournalRecord[] {
    return structuredClone(this.records);
  }
}

class RuntimeFacetDriver implements RuntimeExecutionDriver {
  readonly kind = 'runtime-facet-identity.fake-driver';
  readonly observations: number[] = [];
  readonly submitted: string[] = [];

  constructor(readonly input: RuntimeExecutionDriverInput) {}

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
    this.submitted.push(typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload));
    return {
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: input.payload,
      outputRefs: [...coordinatorOutputRefs],
      evidenceRefs: [],
    };
  }

  async *observe(): AsyncIterable<AgentEvent> {
    const runtimeEventId = 'runtime-facet-event-1';
    this.observations.push(this.observations.length + 1);
    const providerEvent: ProviderEvent = {
      runtimeId: this.input.runtimeId,
      taskId: this.input.taskId,
      operationId: this.input.operationId,
      executionEpoch: this.input.executionEpoch,
      eventId: runtimeEventId,
      kind: 'output',
      turnId: 'turn-runtime-facet',
      requestId: 'request-runtime-facet',
      occurredAt: '2026-10-09T16:00:00.000Z',
      externalResponseId: 'response-runtime-facet',
      responseModel: 'model-runtime-facet',
      outputRefs: [...coordinatorOutputRefs],
      summary: 'runtime facet output',
      evidenceRefs: [
        {
          evidenceId: id('evidence', 'runtime-facet-provider-event'),
          kind: 'external',
          source: 'runtime-facet-identity-test',
          locator: 'provider/runtime-facet-event',
          scope: { organId: coordinatorOrganId, taskId: this.input.taskId },
        },
      ],
      ownerId: 'test.provider',
      nextAction: { kind: 'continue', ref: 'runtime-facet-event' },
    };
    yield {
      taskId: this.input.taskId,
      executionEpoch: this.input.executionEpoch,
      kind: 'provider.output',
      evidenceRefs: providerEvent.evidenceRefs,
      providerEvent,
    } as AgentEvent;
  }

  async requestStop(input: Parameters<RuntimeExecutionDriver['requestStop']>[0]) {
    return { requested: true, operationId: input.operationId };
  }

  async settle() {
    return { state: 'succeeded' as const, evidenceRefs: [] };
  }

  async close() {
    return {
      bindingId: 'runtime-facet-binding',
      providerId: 'runtime-facet-provider',
      protocol: 'responses' as const,
      state: 'closed' as const,
      evidenceRefs: [],
    };
  }
}

function runtimeFacetCoordinator(
  journal: MemoryRuntimeTaskJournal,
  drivers: RuntimeFacetDriver[],
): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId: coordinatorOrganId,
    taskIdPrefix: 'runtime-facet',
    createDriver: (input) => {
      const driver = new RuntimeFacetDriver(input);
      drivers.push(driver);
      return driver;
    },
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
    journal,
  });
}

async function waitForCoordinatorTerminal(runtime: RuntimeTaskCoordinator, taskId: TaskId): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = runtime.taskSnapshot(taskId).state;
    if (state === 'succeeded' || state === 'failed' || state === 'blocked') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`runtime did not finish; state=${runtime.taskSnapshot(taskId).state}`);
}

function journalStartedRecord(input: {
  readonly taskId: TaskId;
  readonly operationId: ReturnType<typeof id<'operation'>>;
  readonly executionEpoch?: number;
}): Extract<RuntimeTaskJournalRecord, { readonly kind: 'operation.started' }> {
  const cycleId = id('cycle', `cycle-${input.operationId.value}`);
  return {
    kind: 'operation.started',
    operationId: input.operationId,
    taskId: input.taskId,
    cycleId,
    scope: { organId: coordinatorOrganId, taskId: input.taskId, cycleId, operationId: input.operationId },
    executionEpoch: input.executionEpoch ?? 1,
    operationCounter: 1,
    cycleCounter: 1,
    startedAt: '2026-10-09T16:00:00.000Z',
    input: 'runtime identity',
  };
}

function journalEventRecord(input: {
  readonly taskId: TaskId;
  readonly operationId: ReturnType<typeof id<'operation'>>;
  readonly executionEpoch?: number;
  readonly taskIdValue?: string;
  readonly operationIdValue?: string;
}): Extract<RuntimeTaskJournalRecord, { readonly kind: 'operation.event' }> {
  const executionEpoch = input.executionEpoch ?? 1;
  return {
    kind: 'operation.event',
    operationId: input.operationId,
    event: {
      eventId: `${input.operationId.value}-1`,
      seq: 1,
      occurredAt: '2026-10-09T16:00:00.001Z',
      taskId: id('task', input.taskIdValue ?? input.taskId.value),
      operationId: input.operationIdValue ?? input.operationId.value,
      executionEpoch,
      kind: 'execution.started',
      state: 'running',
      summary: 'execution started',
      evidenceRefs: [],
    },
  };
}

class RecordingExecutionPort implements TaskVerificationExecutionPort {
  readonly requests: Parameters<TaskVerificationExecutionPort['execute']>[0][] = [];

  async execute(input: Parameters<TaskVerificationExecutionPort['execute']>[0]): Promise<TaskCheckEvidence> {
    this.requests.push(input);
    const check = input.check as Extract<TaskCheckPolicy, { kind: 'native' }>;
    return checkEvidence(input, check.evaluatorDigest === SHA_Y ? 'failed' : 'succeeded');
  }
}

function bridge(execution: TaskVerificationExecutionPort): TaskVerificationPort {
  return new TaskVerificationBridge({
    execution,
    evidenceScope: { organId: id('organ', 'organ-verification-identity') },
    now: () => '2026-10-05T00:00:00.000Z',
  });
}

test('task verification rejects a changed checker under an old immutable identity', async () => {
  const execution = new RecordingExecutionPort();
  const verifier = bridge(execution);
  const first = policy(SHA_X);
  const second = policy(SHA_Y);

  const firstResult = await verifier.verify({
    policy: first,
    binding: binding(first),
    executionEvidence: executionEvidence(),
  });
  assert.equal(firstResult.status, 'success');
  assert.notEqual(first.compiledDigest, second.compiledDigest);
  await assert.rejects(
    verifier.verify({
      policy: second,
      binding: binding(second),
      executionEvidence: executionEvidence(),
    }),
    (error: unknown) => error instanceof TaskVerificationIdentityConflictError
      && error instanceof TaskVerificationError
      && error.code === 'identity-conflict'
      && /immutable verification identity/i.test(error.message),
  );
  assert.equal(execution.requests.length, 1);
  assert.equal(execution.requests[0]?.policy.compiledDigest, first.compiledDigest);
});

test('task verification rejects a changed immutable identity and keeps the old evidence unrelabeled', async () => {
  const execution = new RecordingExecutionPort();
  const verifier = bridge(execution);
  const first = policy(SHA_X);
  const second = policy(SHA_Y);

  const firstResult = await verifier.verify({
    policy: first,
    binding: binding(first),
    executionEvidence: executionEvidence(),
  });
  assert.equal(firstResult.status, 'success');

  await assert.rejects(
    verifier.verify({
      policy: second,
      binding: binding(second),
      executionEvidence: executionEvidence(),
    }),
    (error: unknown) => error instanceof TaskVerificationIdentityConflictError
      && error instanceof TaskVerificationError
      && error.code === 'identity-conflict'
      && /immutable verification identity/i.test(error.message),
  );
  assert.equal(execution.requests.length, 1);
  assert.equal(execution.requests[0]?.policy.compiledDigest, first.compiledDigest);
});

test('task verification keeps single-flight execution for the same immutable identity', async () => {
  const execution = new RecordingExecutionPort();
  const verifier = bridge(execution);
  const identity = policy(SHA_X);
  const identityBinding = binding(identity);

  const results = await Promise.all([
    verifier.verify({ policy: identity, binding: identityBinding, executionEvidence: executionEvidence() }),
    verifier.verify({ policy: identity, binding: identityBinding, executionEvidence: executionEvidence() }),
  ]);

  assert.deepEqual(results.map((result) => result.status), ['success', 'success']);
  assert.deepEqual(results.map((result) => result.policyDigest), [identity.compiledDigest, identity.compiledDigest]);
  assert.equal(execution.requests.length, 1);
});

test('task verification executes a changed policy under an explicit new attempt', async () => {
  const execution = new RecordingExecutionPort();
  const verifier = bridge(execution);
  const first = policy(SHA_X);
  const second = policy(SHA_Y);

  const firstResult = await verifier.verify({
    policy: first,
    binding: binding(first),
    executionEvidence: executionEvidence(),
  });
  const secondResult = await verifier.verify({
    policy: second,
    binding: binding(second, 2),
    executionEvidence: executionEvidence(),
  });

  assert.equal(firstResult.status, 'success');
  assert.equal(secondResult.status, 'rejected');
  assert.equal(secondResult.attempt, 2);
  assert.equal(secondResult.policyDigest, second.compiledDigest);
  assert.equal(execution.requests.length, 2);
  assert.deepEqual(execution.requests.map((request) => request.policy.compiledDigest), [
    first.compiledDigest,
    second.compiledDigest,
  ]);
});

test('runtime coordinator preserves provider-reported facets and plural output refs across live, journal, and hydrate', async () => {
  const journal = new MemoryRuntimeTaskJournal();
  const drivers: RuntimeFacetDriver[] = [];
  const runtime = runtimeFacetCoordinator(journal, drivers);
  const task = runtime.createTask({ title: 'runtime facets', directive: 'preserve runtime facets' });
  const started = runtime.startExecution(task.taskId, { prompt: 'observe facets' });
  await waitForCoordinatorTerminal(runtime, task.taskId);

  const liveEvent = runtime.eventsSince(started.operationId).find((event) => event.kind === 'provider.output') as RuntimeTaskEventWithFacets | undefined;
  assert.equal(liveEvent?.externalResponseId, 'response-runtime-facet');
  assert.equal(liveEvent?.responseModel, 'model-runtime-facet');
  assert.deepEqual(liveEvent?.outputRefs, coordinatorOutputRefs);
  assert.deepEqual(
    runtime.taskSnapshot(task.taskId).events.map((event) => event.eventId),
    liveEvent === undefined ? [] : runtime.eventsSince(started.operationId).map((event) => event.eventId),
  );

  const durableEvents = journal.records.flatMap((record) => (
    record.kind === 'operation.event' ? [record.event] : []
  ));
  const durableEvent = durableEvents.find((event) => event.kind === 'provider.output') as RuntimeTaskEventWithFacets | undefined;
  assert.deepEqual(durableEvent?.outputRefs, coordinatorOutputRefs);
  assert.deepEqual(durableEvents.map((event) => event.eventId), runtime.eventsSince(started.operationId).map((event) => event.eventId));

  const replayDrivers: RuntimeFacetDriver[] = [];
  const hydrated = runtimeFacetCoordinator(journal, replayDrivers);
  const hydratedEvent = hydrated.eventsSince(started.operationId).find((event) => event.kind === 'provider.output') as RuntimeTaskEventWithFacets | undefined;
  assert.equal(hydratedEvent?.externalResponseId, 'response-runtime-facet');
  assert.equal(hydratedEvent?.responseModel, 'model-runtime-facet');
  assert.deepEqual(hydratedEvent?.outputRefs, coordinatorOutputRefs);
  await hydrated.hydrate();
  assert.equal(replayDrivers.length, 0);
  assert.equal(drivers[0]?.submitted.length, 1);
});

test('runtime coordinator replay rejects operation, task, and epoch mismatch and a conflicting repeated start', () => {
  const taskId = id('task', 'task-runtime-replay-bind');
  const operationId = id('operation', 'operation-runtime-replay-bind');
  const started = journalStartedRecord({ taskId, operationId });
  const taskOnly = new MemoryRuntimeTaskJournal([
    started,
    journalEventRecord({ taskId, operationId, taskIdValue: 'task-runtime-replay-other' }),
  ]);
  const operationOnly = new MemoryRuntimeTaskJournal([
    started,
    journalEventRecord({ taskId, operationId, operationIdValue: 'operation-runtime-replay-other' }),
  ]);
  const epochOnly = new MemoryRuntimeTaskJournal([
    started,
    journalEventRecord({ taskId, operationId, executionEpoch: 2 }),
  ]);

  for (const [journal, message] of [
    [taskOnly, 'operation-runtime-replay-bind'],
    [operationOnly, 'operation-runtime-replay-bind'],
    [epochOnly, 'operation-runtime-replay-bind'],
  ] as const) {
    assert.throws(
      () => runtimeFacetCoordinator(journal, []),
      (error: unknown) => error instanceof RuntimeTaskControlError
        && error.code === 'journal.corrupt'
        && error.message.includes(message),
    );
  }

  const conflictingStart = new MemoryRuntimeTaskJournal([
    started,
    journalStartedRecord({ taskId, operationId, executionEpoch: 2 }),
  ]);
  assert.throws(
    () => runtimeFacetCoordinator(conflictingStart, []),
    (error: unknown) => error instanceof RuntimeTaskControlError
      && error.code === 'journal.corrupt'
      && error.message.includes('identity does not match'),
  );
});
