import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderSettlement,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderSubmitResult,
  type ScopeRef,
  type Task,
  type WorkAssignment,
} from '../../packages/contracts/src/index.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import { fakeExecutionBinding } from '../../packages/app/src/fake-execution.js';
import { createDeterministicServeOrchestrationPorts, createRccServeOrchestrationPorts } from '../../packages/app/src/serve-orchestration.js';
import { createServeRuntimeComposition } from '../../packages/app/src/serve-runtime.js';
import { FakeReplayExecutionRuntimePort, startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import type { CheckpointJournalPort } from '../../packages/runtime/src/checkpoints/ports.js';
import type { ReviewAssignment } from '../../packages/runtime/src/review/index.js';
import type {
  EventBusPorts,
  EventPublisherRegistryPort,
  TrustedEventPublisher,
} from '../../packages/runtime/src/events/index.js';

async function eventBusPorts(): Promise<{ readonly ports: EventBusPorts; readonly close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-serve-runtime-'));
  const journal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
  const publisher: TrustedEventPublisher = {
    publisherId: 'serve-test',
    kind: 'harness',
    ownerId: 'humanagent.serve.test',
    scope: { organId: id('organ', 'humanagent-ui') },
    allowedClasses: ['control', 'data', 'observation'],
    capabilities: ['event.publish.control'],
  };
  const publishers: EventPublisherRegistryPort = {
    async resolvePublisher(publisherId) {
      return publisherId === publisher.publisherId ? publisher : null;
    },
  };
  return {
    ports: {
      journal,
      publishers,
      consumers: { async resolveConsumer() { return null; } },
      externalOperations: journal,
      barrierIntents: journal,
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

async function waitForTaskState(read: () => string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(read(), expected);
}

function assignment(task: Task): WorkAssignment {
  return {
    assignmentId: 'serve-assignment',
    taskId: task.id,
    pipelineNodeId: 'serve-stage',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'exercise the live serve orchestration boundary',
    targetRefs: ['serve-target'],
    expectedOutputRefs: ['serve-output'],
    expectedArtifactDigests: ['sha256:serve-target'],
    acceptanceCriteriaDigest: 'sha256:serve-criteria',
    successCriteria: ['worker result is accepted'],
    failureCriteria: ['worker result fails'],
    incompleteCriteria: ['worker result is incomplete'],
    requiredCapabilities: ['execute'],
    mergeGate: 'required',
  };
}

function providerBinding(): ProviderBinding {
  return {
    bindingId: 'serve-rcc-binding',
    providerId: 'rcc',
    protocol: 'responses',
    endpointRef: 'rcc-v3:test',
    modelRef: 'test-model',
    configDigest: 'sha256:serve-rcc-config',
    capabilityDigest: 'sha256:serve-rcc-capability',
  };
}

function providerPort(input: { readonly state: ProviderSettlement['state']; readonly reviewMarker?: string; readonly reviewMarkers?: readonly string[]; readonly outputRef?: string }): ExecutionRuntimePort {
  const binding = providerBinding();
  const evidence = (scope: ScopeRef) => ({
    evidenceId: id('evidence', `serve-rcc-${scope.operationId?.value ?? 'operation'}`),
    kind: 'operation' as const,
    source: 'test.serve-rcc-orchestration',
    locator: 'serve-rcc/provider',
    digest: 'sha256:serve-rcc-output',
    scope,
  });
  let active: { readonly runtimeId: string; readonly taskId: ReturnType<typeof id<'task'>>; readonly operationId: ReturnType<typeof id<'operation'>>; readonly executionEpoch: number; readonly scope: ScopeRef } | undefined;
  const readiness: ProviderReadiness = {
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    protocol: binding.protocol,
    state: 'ready',
    capabilityDigest: binding.capabilityDigest,
    checkedAt: '2026-09-20T00:00:00.000Z',
    expiresAt: '2099-09-20T00:00:00.000Z',
    evidenceRefs: [evidence({ organId: id('organ', 'serve-test') })],
  };
  return {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => readiness,
    capabilities: async (): Promise<ProviderCapabilities> => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      capabilities: ['responses'],
      version: 'test',
      digest: binding.capabilityDigest,
      checkedAt: readiness.checkedAt,
      expiresAt: readiness.expiresAt,
      evidenceRefs: readiness.evidenceRefs,
    }),
    start: async (request): Promise<ProviderStartReceipt> => {
      active = {
        runtimeId: request.runtimeId,
        taskId: request.taskId,
        operationId: request.operationId,
        executionEpoch: request.executionEpoch,
        scope: { organId: request.organId ?? id('organ', 'serve-test'), taskId: request.taskId, operationId: request.operationId },
      };
      return { ...request, startedAt: readiness.checkedAt, evidenceRefs: [evidence(active.scope)] };
    },
    resume: async (): Promise<ProviderRecoveryResult> => { throw new Error('not used'); },
    submit: async (request): Promise<ProviderSubmitResult> => ({
      ...request,
      status: 'accepted',
      outputRefs: [],
      evidenceRefs: active ? [evidence(active.scope)] : [],
    }),
    observe: async function* (): AsyncIterable<ProviderEvent> {
      if (!active) throw new Error('missing active provider execution');
      const reviewMarkers = input.reviewMarkers ?? (input.reviewMarker === undefined ? [] : [input.reviewMarker]);
      yield {
        ...active,
        eventId: `output-${active.runtimeId}`,
        kind: 'output',
        summary: reviewMarkers[0] ?? 'provider output',
        outputRefs: [input.outputRef ?? 'provider://output'],
        evidenceRefs: [evidence(active.scope)],
      };
      yield {
        ...active,
        eventId: `terminal-${active.runtimeId}`,
        kind: 'terminal',
        terminalState: input.state,
        summary: reviewMarkers[1] ?? reviewMarkers[0] ?? `provider ${input.state}`,
        evidenceRefs: [evidence(active.scope)],
      };
    },
    requestStop: async (request): Promise<ProviderStopReceipt> => ({
      ...request,
      status: 'accepted',
      receivedAt: readiness.checkedAt,
      evidenceRefs: active ? [evidence(active.scope)] : [],
    }),
    settle: async (request): Promise<ProviderSettlement> => ({
      ...request,
      state: input.state,
      evidenceRefs: active ? [evidence(active.scope)] : [],
      resourceRelease: { state: 'released', evidenceRefs: active ? [evidence(active.scope)] : [] },
      persistence: { state: 'committed', evidenceRefs: active ? [evidence(active.scope)] : [] },
    }),
    close: async (): Promise<ProviderCloseResult> => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'closed',
      evidenceRefs: readiness.evidenceRefs,
    }),
  };
}

test('serve runtime composes and closes a task-scoped M3 dispatch', async () => {
  const eventBus = await eventBusPorts();
  const composition = createServeRuntimeComposition({
    eventBusPorts: eventBus.ports,
    feedbackPorts: {
      journal: eventBus.ports.journal,
      publishers: eventBus.ports.publishers,
    },
    feedbackPublisherId: 'serve-test',
    ...createDeterministicServeOrchestrationPorts(),
  });
  const task: Task = {
    id: id('task', 'serve-composition-task'),
    organId: id('organ', 'humanagent-ui'),
    title: 'serve composition',
    directive: 'compose the live harness owners',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = {
    organId: task.organId,
    taskId: task.id,
    cycleId: id('cycle', 'serve-composition-cycle'),
  };
  const assembly = composition.createTaskAssembly({
    task,
    scope,
    checkpointJournal: {} as CheckpointJournalPort,
  });

  assembly.orchestration.planStage({ nodeId: 'serve-stage', taskId: task.id });
  const dispatched = await assembly.orchestration.dispatch({
    stageNodeId: 'serve-stage',
    assignment: assignment(task),
    agentId: 'serve-worker',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: ['sha256:serve-target'],
  });

  assert.equal(composition.ownerId, 'humanagent.app.serve-runtime');
  assert.ok(composition.nodeRuntime.strategies.refs().length > 0);
  assert.equal(assembly.task.id.value, task.id.value);
  assert.equal(assembly.scope.taskId?.value, task.id.value);
  assert.equal(dispatched.status, 'merged');
  assert.equal(dispatched.assignment.status, 'merged');
  const feedback = await eventBus.ports.journal.readEvents({
    streamId: `task:${task.id.value}`,
    afterSequence: 0,
    limit: 20,
  });
  assert.deepEqual(feedback.map((event) => event.class), ['data', 'data', 'control']);
  assert.ok(feedback.every((event) => event.publisherId === 'serve-test'));

  await composition.dispose();
  await eventBus.close();
});

test('confirmed requirement enters task orchestration before provider settlement', async () => {
  const eventBus = await eventBusPorts();
  const root = await mkdtemp(join(tmpdir(), 'humanagent-serve-requirement-'));
  const binding = fakeExecutionBinding({ bindingId: 'serve-requirement-binding' });
  const runtimeComposition = createServeRuntimeComposition({
    eventBusPorts: eventBus.ports,
    feedbackPorts: {
      journal: eventBus.ports.journal,
      publishers: eventBus.ports.publishers,
    },
    feedbackPublisherId: 'serve-test',
    ...createDeterministicServeOrchestrationPorts(),
  });
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId: id('organ', 'humanagent-ui'),
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    portNumber: 0,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'serve-requirement-project',
    },
    runtimeComposition,
  });
  try {
    const interactionId = await runtime.service.receiveExplicitInput({
      sourceRef: 'ui:task-detail',
      rawInput: 'run the confirmed orchestration path',
      channel: 'business',
    });
    await runtime.service.beginExplicitMatching(interactionId);
    await runtime.service.recordExplicitMatch(interactionId, {
      normalizedInput: 'run the confirmed orchestration path',
      matchedTasks: [],
      knownFacts: [],
    });
    await runtime.service.proposeExplicitRequirement(interactionId, {
      proposedIntent: 'create',
      proposal: 'create a task for the orchestration path',
    });
    const proposed = await runtime.service.inspectExplicitInteraction(interactionId);
    assert.ok(proposed.draft);
    await runtime.service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:serve-orchestration',
      confirmedBy: 'human:operator',
      confirmedAt: '2026-09-20T00:00:00.000Z',
      payloadRef: 'asset://requirements/serve-orchestration',
    });

    const dispatched = await runtime.service.dispatchNextExplicitRequirement();
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (runtime.service.taskDashboard(dispatched.taskId).state === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.service.taskDashboard(dispatched.taskId).state, 'succeeded');
    const graph = runtime.service.taskAssembly(dispatched.taskId).orchestration.graph.snapshot();
    assert.equal(graph.stages.length, 1);
    assert.equal(graph.assignments.length, 1);
    assert.equal(graph.assignments[0]?.status, 'merged');
    const feedback = await eventBus.ports.journal.readEvents({
      streamId: `task:${dispatched.taskId.value}`,
      afterSequence: 0,
      limit: 20,
    });
    assert.deepEqual(feedback.map((event) => event.class), ['data', 'data', 'control']);
  } finally {
    await runtime.server.close();
    await runtimeComposition.dispose();
    await eventBus.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('confirmed requirement preserves non-success provider closures through orchestration', async () => {
  for (const terminalState of ['waiting', 'blocked', 'failed'] as const) {
    const eventBus = await eventBusPorts();
    const root = await mkdtemp(join(tmpdir(), `humanagent-serve-requirement-${terminalState}-`));
    const binding = fakeExecutionBinding({ bindingId: `serve-requirement-${terminalState}` });
    const runtimeComposition = createServeRuntimeComposition({
      eventBusPorts: eventBus.ports,
      feedbackPorts: {
        journal: eventBus.ports.journal,
        publishers: eventBus.ports.publishers,
      },
      feedbackPublisherId: 'serve-test',
      ...createDeterministicServeOrchestrationPorts(),
    });
    const runtime = await startUiRuntime({
      mode: 'fake',
      organId: id('organ', 'humanagent-ui'),
      binding,
      port: new FakeReplayExecutionRuntimePort({
        binding,
        stepDelayMs: 1,
        replay: [{ kind: 'terminal', state: terminalState, summary: `fake replay: execution ${terminalState}`, terminalState }],
      }),
      checkpointRoot: join(root, 'checkpoints'),
      evidenceRoot: join(root, 'evidence'),
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      portNumber: 0,
      memory: {
        coordinator: new MemoryCoordinator(),
        backend: new DeterministicMemoryBackend(),
        projectKey: `serve-requirement-${terminalState}`,
      },
      runtimeComposition,
    });
    try {
      const interactionId = await runtime.service.receiveExplicitInput({
        sourceRef: 'ui:task-detail',
        rawInput: `run the ${terminalState} orchestration path`,
        channel: 'business',
      });
      await runtime.service.beginExplicitMatching(interactionId);
      await runtime.service.recordExplicitMatch(interactionId, {
        normalizedInput: `run the ${terminalState} orchestration path`,
        matchedTasks: [],
        knownFacts: [],
      });
      await runtime.service.proposeExplicitRequirement(interactionId, {
        proposedIntent: 'create',
        proposal: `create a ${terminalState} orchestration task`,
      });
      const proposed = await runtime.service.inspectExplicitInteraction(interactionId);
      assert.ok(proposed.draft);
      await runtime.service.confirmExplicitRequirement({
        draftId: proposed.draft!.draftId,
        inputRevision: 1,
        confirmationRef: `confirmation:serve-orchestration-${terminalState}`,
        confirmedBy: 'human:operator',
        confirmedAt: '2026-09-20T00:00:00.000Z',
        payloadRef: `asset://requirements/serve-orchestration-${terminalState}`,
      });

      const dispatched = await runtime.service.dispatchNextExplicitRequirement();
      await waitForTaskState(() => runtime.service.taskDashboard(dispatched.taskId).state, terminalState);
      const dashboard = runtime.service.taskDashboard(dispatched.taskId);
      assert.equal(dashboard.checkpoint?.outcome, terminalState);
      assert.equal(runtime.service.taskAssembly(dispatched.taskId).orchestration.graph.snapshot().assignments[0]?.status, terminalState === 'blocked' ? 'blocked' : 'escalated');
    } finally {
      await runtime.server.close();
      await runtimeComposition.dispose();
      await eventBus.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('RCC orchestration ports exercise execution and review agents with separate identities', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-agent-task'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC agent roles',
    directive: 'exercise provider-backed agent roles',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = {
    organId: task.organId,
    taskId: task.id,
    cycleId: id('cycle', 'serve-rcc-agent-cycle'),
  };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed', outputRef: 'serve-rcc-output' }),
    binding: providerBinding(),
    promptSegments: {
      execution: ['execution system prompt'],
      review: ['review system prompt'],
    },
  });
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-worker',
    pipelineNodeId: 'serve-rcc-stage',
    expectedOutputRefs: ['serve-rcc-output'],
    expectedArtifactDigests: undefined,
  };
  const workerDelivery = await ports.executionAgent.execute({
    assignment: workAssignment,
    agentId: 'serve-rcc-execution-agent',
    executionEpoch: 1,
    attempt: 1,
    lease: {
      leaseId: 'serve-rcc-lease',
      runtimeId: 'serve-rcc-runtime',
      generation: 1,
      executionEpoch: 1,
      ownerId: 'serve-test',
      assignmentId: workAssignment.assignmentId,
      capabilities: ['provider.execution'],
    },
    scope,
  });
  const worker = 'result' in workerDelivery ? workerDelivery.result : workerDelivery;
  assert.equal(worker.status, 'succeeded');
  assert.equal(worker.agentId, 'serve-rcc-execution-agent');
  assert.deepEqual(worker.outputRefs, ['serve-rcc-output']);
  assert.deepEqual(worker.producedArtifactDigests, ['sha256:serve-rcc-output']);

  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-execution-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    acceptanceCriteriaDigest: workAssignment.acceptanceCriteriaDigest,
    subjectRefs: ['serve-rcc-output'],
    subjectDigests: [],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment: workAssignment,
    workerResult: worker,
    scope,
  });
  assert.equal(review.status, 'passed');
  assert.equal(review.reviewKind, 'quality');
  assert.ok(review.evidenceRefs.length > 0);
  const merged = await ports.mergeCoordinator.merge({
    workerAssignment: workAssignment,
    workerResult: worker,
    reviewAssignments: [reviewAssignment],
    reviewResults: [review],
    ownerId: 'serve-test',
    scope,
  });
  assert.equal(merged.status, 'merged');
  assert.ok(merged.evidenceRefs.length > 0);
});

test('RCC execution does not claim success when provider output refs miss the assignment contract', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-output-mismatch'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC output mismatch',
    directive: 'keep provider output identity truthful',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-output-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded', outputRef: 'provider://unexpected-output' }),
    binding: providerBinding(),
    promptSegments: { execution: ['execution system prompt'], review: ['review system prompt'] },
  });
  const workAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-output-mismatch-worker',
    expectedOutputRefs: ['required-output'],
    expectedArtifactDigests: undefined,
  };
  const delivery = await ports.executionAgent.execute({
    assignment: workAssignment,
    agentId: 'serve-rcc-execution-agent',
    executionEpoch: 1,
    attempt: 1,
    lease: {
      leaseId: 'serve-rcc-output-mismatch-lease',
      runtimeId: 'serve-rcc-output-mismatch-runtime',
      generation: 1,
      executionEpoch: 1,
      ownerId: 'serve-test',
      assignmentId: workAssignment.assignmentId,
      capabilities: ['provider.execution'],
    },
    scope,
  });
  const result = 'result' in delivery ? delivery.result : delivery;
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.outputRefs, ['provider://unexpected-output']);
});

test('RCC review agent remains inconclusive when the model omits its review marker', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-review-omission'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review omission',
    directive: 'keep an omitted review marker visible',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded' }),
    binding: providerBinding(),
    promptSegments: { execution: ['execution system prompt'], review: ['review system prompt'] },
  });
  const workAssignment = { ...assignment(task), assignmentId: 'serve-rcc-omission-worker', expectedArtifactDigests: undefined };
  const workerDelivery = await ports.executionAgent.execute({
    assignment: workAssignment,
    agentId: 'serve-rcc-execution-agent',
    executionEpoch: 1,
    attempt: 1,
    lease: {
      leaseId: 'serve-rcc-omission-lease',
      runtimeId: 'serve-rcc-omission-runtime',
      generation: 1,
      executionEpoch: 1,
      ownerId: 'serve-test',
      assignmentId: workAssignment.assignmentId,
      capabilities: ['provider.execution'],
    },
    scope,
  });
  const worker = 'result' in workerDelivery ? workerDelivery.result : workerDelivery;
  const review = await ports.reviewAgent.review({
    reviewAssignment: {
      assignmentId: 'serve-rcc-omission-review',
      taskId: task.id.value,
      workerAgentId: 'serve-rcc-execution-agent',
      reviewKind: 'quality',
      attempt: 1,
      executionEpoch: 1,
      inputRevision: 1,
      acceptanceCriteriaDigest: workAssignment.acceptanceCriteriaDigest,
      subjectRefs: ['serve-output'],
      subjectDigests: [],
      workerCapabilities: ['provider.execution'],
      requiredCapabilities: ['quality.review'],
      mergeGate: 'required',
    },
    workerAssignment: workAssignment,
    workerResult: worker,
    scope,
  });
  assert.equal(review.status, 'inconclusive');
});

test('RCC review agent remains inconclusive when review markers conflict', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-review-conflict'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review conflict',
    directive: 'keep contradictory review output blocked',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-conflict-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded', reviewMarkers: ['HUMANAGENT_REVIEW: passed', 'HUMANAGENT_REVIEW: failed'] }),
    binding: providerBinding(),
    promptSegments: { execution: ['execution system prompt'], review: ['review system prompt'] },
  });
  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-conflict-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-execution-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    acceptanceCriteriaDigest: 'sha256:serve-rcc-review-criteria',
    subjectRefs: ['serve-output'],
    subjectDigests: [],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment: { ...assignment(task), assignmentId: 'serve-rcc-conflict-worker', expectedArtifactDigests: undefined },
    workerResult: {
      ...assignment(task),
      pipelineNodeId: 'serve-stage',
      agentId: 'serve-rcc-execution-agent',
      assignmentId: 'serve-rcc-conflict-worker',
      executionEpoch: 1,
      attempt: 1,
      inputRevision: 1,
      taskId: task.id,
      producedArtifactRefs: ['serve-output'],
      producedArtifactDigests: ['sha256:serve-output'],
      status: 'succeeded',
      summary: 'worker result',
      outputRefs: ['serve-output'],
      evidenceRefs: [],
      nextAction: 'review',
    },
    scope,
  });
  assert.equal(review.status, 'inconclusive');
});

test('RCC ports reach the runtime review and Harness merge gates with provider artifacts', async () => {
  const eventBus = await eventBusPorts();
  const task: Task = {
    id: id('task', 'serve-rcc-manager-task'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC manager integration',
    directive: 'exercise the provider-backed runtime review and merge gates',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-manager-cycle') };
  const runtimeComposition = createServeRuntimeComposition({
    eventBusPorts: eventBus.ports,
    feedbackPorts: { journal: eventBus.ports.journal, publishers: eventBus.ports.publishers },
    feedbackPublisherId: 'serve-test',
    ...createRccServeOrchestrationPorts({
      port: providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed', outputRef: 'serve-rcc-manager-output' }),
      binding: providerBinding(),
      promptSegments: { execution: ['execution system prompt'], review: ['review system prompt'] },
    }),
  });
  const assembly = runtimeComposition.createTaskAssembly({
    task,
    scope,
    checkpointJournal: {} as CheckpointJournalPort,
  });
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-manager-assignment',
    pipelineNodeId: 'serve-rcc-manager-stage',
    targetRefs: ['serve-rcc-manager-output'],
    expectedOutputRefs: ['serve-rcc-manager-output'],
    expectedArtifactDigests: undefined,
  };
  try {
    assembly.orchestration.planStage({ nodeId: workAssignment.pipelineNodeId, taskId: task.id });
    const dispatched = await assembly.orchestration.dispatch({
      stageNodeId: workAssignment.pipelineNodeId,
      assignment: workAssignment,
      agentId: 'serve-rcc-execution-agent',
      scope,
      reviewKinds: ['quality'],
    });
    assert.equal(dispatched.status, 'merged', JSON.stringify(dispatched));
    assert.equal(dispatched.assignment.status, 'merged');
    assert.equal(dispatched.reviewResults[0]?.status, 'passed');
    assert.equal(dispatched.mergeOutcome?.status, 'merged');
  } finally {
    await runtimeComposition.dispose();
    await eventBus.close();
  }
});
