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
  type WorkResult,
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
import type { ReviewResult } from '../../packages/runtime/src/review/index.js';
import { acceptanceCriteriaContent, digestOf, resolveReviewMaterial } from '../../packages/runtime/src/orchestration/index.js';
import type { ExecutionAgentPort } from '../../packages/runtime/src/orchestration/index.js';

/** Produced subject body used by the fixture assignments in this file. */
const serveArtifactBody = 'serve fixture artifact body';
import type {
  EventBusPorts,
  EventPublisherRegistryPort,
  TrustedEventPublisher,
} from '../../packages/runtime/src/events/index.js';

const unusedExplicitBrainInterpreter = {
  async interpret(): Promise<never> {
    throw new Error('explicit brain interpretation is not used in serve orchestration tests');
  },
};

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

async function waitForRuntimeTask(runtime: Awaited<ReturnType<typeof startUiRuntime>>): Promise<Task['id']> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const tasks = runtime.service.listTasks();
    const rows = [...tasks.running, ...tasks.waiting, ...tasks.completed, ...tasks.failed, ...tasks.draft];
    for (const row of rows) {
      if (row.requirementAdmission === 'queued') continue;
      try {
        runtime.service.taskDashboard(row.taskId);
        return row.taskId;
      } catch {
        // Queued rows now resolve through the dashboard; still keep looking for
        // the real coordinator task created by FIFO dispatch.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('runtime did not consume the confirmed requirement');
}

function assignment(task: Task, overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  const criteria = {
    objective: 'exercise the live serve orchestration boundary',
    successCriteria: ['worker result is accepted'],
    failureCriteria: ['worker result fails'],
    incompleteCriteria: ['worker result is incomplete'],
  };
  return {
    assignmentId: 'serve-assignment',
    taskId: task.id,
    pipelineNodeId: 'serve-stage',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: criteria.objective,
    targetRefs: ['serve-target'],
    expectedOutputRefs: ['serve-output'],
    acceptanceCriteriaDigest: digestOf(acceptanceCriteriaContent(criteria)),
    successCriteria: [...criteria.successCriteria],
    failureCriteria: [...criteria.failureCriteria],
    incompleteCriteria: [...criteria.incompleteCriteria],
    requiredCapabilities: ['execute'],
    mergeGate: 'required',
    ...overrides,
  };
}

/** Review material for a fixture assignment, derived from its subject body. */
function materialFor(
  workerAssignment: WorkAssignment,
  workerResult: WorkResult,
  body = serveArtifactBody,
) {
  return resolveReviewMaterial({
    workerAssignment,
    workerResult,
    subjects: workerAssignment.targetRefs.map((ref) => ({ ref, body })),
  });
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

function providerPort(input: {
  readonly state: ProviderSettlement['state'];
  readonly reviewMarker?: string;
  readonly reviewMarkers?: readonly string[];
  readonly reviewMarkerSequence?: readonly (string | undefined)[];
  readonly outputRef?: string;
  readonly chunkedReviewText?: readonly string[];
  readonly organId?: ReturnType<typeof id<'organ'>>;
  readonly submittedPrompts?: string[];
}): ExecutionRuntimePort {
  const binding = providerBinding();
  // A real provider reports the scope it was admitted under. Hardcoding a
  // foreign organ here would make the fixture produce evidence the task-scoped
  // feedback event can never contain.
  const providerOrgan = () => input.organId ?? id('organ', 'humanagent-ui');
  const evidence = (scope: ScopeRef) => ({
    evidenceId: id('evidence', `serve-rcc-${scope.operationId?.value ?? 'operation'}`),
    kind: 'operation' as const,
    source: 'test.serve-rcc-orchestration',
    locator: 'serve-rcc/provider',
    digest: 'sha256:serve-rcc-output',
    scope,
  });
  let active: { readonly runtimeId: string; readonly taskId: ReturnType<typeof id<'task'>>; readonly operationId: ReturnType<typeof id<'operation'>>; readonly executionEpoch: number; readonly scope: ScopeRef } | undefined;
  let observeCount = 0;
  const readiness: ProviderReadiness = {
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    protocol: binding.protocol,
    state: 'ready',
    capabilityDigest: binding.capabilityDigest,
    checkedAt: '2026-09-20T00:00:00.000Z',
    expiresAt: '2099-09-20T00:00:00.000Z',
    evidenceRefs: [evidence({ organId: providerOrgan() })],
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
      // The driver admits the execution with the task's full scope (organ,
      // task, cycle, operation). A real provider reports that same admitted
      // scope, so the fixture must echo it rather than rebuild a partial one.
      const admittedScope = request.evidenceRefs[0]?.scope ?? {
        organId: request.organId ?? providerOrgan(),
        taskId: request.taskId,
        operationId: request.operationId,
      };
      active = {
        runtimeId: request.runtimeId,
        taskId: request.taskId,
        operationId: request.operationId,
        executionEpoch: request.executionEpoch,
        scope: admittedScope,
      };
      const prompt = request.payload?.prompt;
      if (prompt !== undefined && typeof prompt === 'string') input.submittedPrompts?.push(prompt);
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
      const sequenceMarker = input.reviewMarkerSequence?.[observeCount];
      observeCount += 1;
      // A reviewer reply split across SSE chunks arrives as several output
      // events; the review parser must reconstruct the whole reply from them.
      if (input.chunkedReviewText) {
        let index = 0;
        for (const chunk of input.chunkedReviewText) {
          yield {
            ...active,
            eventId: `output-chunk-${index}-${active.runtimeId}`,
            kind: 'output',
            summary: chunk,
            outputRefs: [input.outputRef ?? 'provider://output'],
            evidenceRefs: [evidence(active.scope)],
          };
          index += 1;
        }
        yield {
          ...active,
          eventId: `terminal-${active.runtimeId}`,
          kind: 'terminal',
          terminalState: input.state,
          evidenceRefs: [evidence(active.scope)],
        };
        return;
      }
      const reviewMarkers = sequenceMarker !== undefined
        ? [sequenceMarker]
        : input.reviewMarkers ?? (input.reviewMarker === undefined ? [] : [input.reviewMarker]);
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
  const serveArtifactDigest = digestOf(serveArtifactBody);
  const dispatched = await assembly.orchestration.dispatch({
    stageNodeId: 'serve-stage',
    assignment: assignment(task, { expectedArtifactDigests: [serveArtifactDigest] }),
    agentId: 'serve-worker',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: [serveArtifactDigest],
    reviewSubjects: [{ ref: 'serve-target', body: serveArtifactBody }],
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

test('confirmed requirement enters task orchestration with RCC review before provider settlement', async () => {
  const eventBus = await eventBusPorts();
  const root = await mkdtemp(join(tmpdir(), 'humanagent-serve-requirement-'));
  const binding = providerBinding();
  const deterministicPorts = createDeterministicServeOrchestrationPorts();
  // The deterministic fixture execution agent returns refs and digests but no
  // produced body, which would make the review gate fail closed on an empty
  // subject. Give it a real body derived from the same target refs it reports
  // so refs, digests and body all describe one artifact.
  const fixtureWorker = deterministicPorts.executionAgent!;
  const fixtureBody = 'serve orchestration fixture artifact body';
  const executionAgent: ExecutionAgentPort = {
    async execute(input) {
      const delivery = await fixtureWorker.execute(input);
      const result = 'result' in delivery ? delivery.result : delivery;
      return {
        ...result,
        // One artifact: the ref, its digest and its body must all describe the
        // same produced text, so the review gate can recompute the digest.
        producedArtifactDigests: input.assignment.targetRefs.map(() => digestOf(fixtureBody)),
        producedArtifactBodies: input.assignment.targetRefs.map(() => fixtureBody),
        // The composed provider fixture reports its own organ; the feedback
        // event scope is the task's, so evidence must be re-scoped to it.
        evidenceRefs: result.evidenceRefs.map((ref) => ({ ...ref, scope: { ...input.scope } })),
        // Evidence must sit inside the feedback event's admitted scope.
      };
    },
  };
  const rccPorts = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed' }),
    binding,
    promptSegments: { review: ['review system prompt'] },
  });
  const runtimeComposition = createServeRuntimeComposition({
    eventBusPorts: eventBus.ports,
    feedbackPorts: {
      journal: eventBus.ports.journal,
      publishers: eventBus.ports.publishers,
    },
    feedbackPublisherId: 'serve-test',
    executionAgent,
    reviewAgent: rccPorts.reviewAgent,
    mergeCoordinator: rccPorts.mergeCoordinator,
  });
  const runtime = await startUiRuntime({
    mode: 'rcc',
    organId: id('organ', 'humanagent-ui'),
    binding,
    port: providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed' }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    portNumber: 0,
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
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

    const taskId = await waitForRuntimeTask(runtime);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (runtime.service.taskDashboard(taskId).state === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.service.taskDashboard(taskId).state, 'succeeded');
    const graph = runtime.service.taskAssembly(taskId).orchestration.graph.snapshot();
    assert.equal(graph.stages.length, 1);
    assert.equal(graph.assignments.length, 1);
    assert.equal(graph.assignments[0]?.status, 'merged', JSON.stringify(graph.assignments[0]));
    const feedback = await eventBus.ports.journal.readEvents({
      streamId: `task:${taskId.value}`,
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
      explicitBrainInterpreter: unusedExplicitBrainInterpreter,
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

      const taskId = await waitForRuntimeTask(runtime);
      await waitForTaskState(() => runtime.service.taskDashboard(taskId).state, terminalState);
      const dashboard = runtime.service.taskDashboard(taskId);
      assert.equal(dashboard.checkpoint?.outcome, terminalState);
      assert.equal(runtime.service.taskAssembly(taskId).orchestration.graph.snapshot().assignments[0]?.status, terminalState === 'blocked' ? 'blocked' : 'escalated');
    } finally {
      await runtime.server.close();
      await runtimeComposition.dispose();
      await eventBus.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('same-task execution epochs commit epoch-scoped checkpoint ids', async () => {
  const eventBus = await eventBusPorts();
  const root = await mkdtemp(join(tmpdir(), 'humanagent-serve-epoch-checkpoint-'));
  const binding = fakeExecutionBinding({ bindingId: 'serve-epoch-checkpoint' });
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
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'serve-epoch-checkpoint',
    },
    runtimeComposition,
  });
  try {
    const task = runtime.service.createTask({ title: 'epoch checkpoint identity' });
    runtime.service.startExecution(task.taskId, { prompt: 'first epoch' });
    await waitForTaskState(() => runtime.service.taskDashboard(task.taskId).state, 'succeeded');
    const firstDashboard = runtime.service.taskDashboard(task.taskId);
    const first = firstDashboard.checkpoint;
    if (!first) throw new Error('epoch 1 checkpoint missing');

    runtime.service.startExecution(task.taskId, { prompt: 'second epoch' });
    await waitForTaskState(() => runtime.service.taskDashboard(task.taskId).state, 'succeeded');
    const secondDashboard = runtime.service.taskDashboard(task.taskId);
    const second = secondDashboard.checkpoint;
    if (!second) throw new Error('epoch 2 checkpoint missing');
    assert.ok(second.checkpointId !== first.checkpointId, 'epoch 2 checkpoint reuses epoch 1 checkpoint id');
    assert.match(second.checkpointId, /^checkpoint-.+-2-1$/, `epoch 2 checkpoint id should include epoch: ${second.checkpointId}`);
    assert.equal(secondDashboard.executionEpoch, 2);
    assert.equal(second.seq, 1);
  } finally {
    await runtime.server.close();
    await runtimeComposition.dispose();
    await eventBus.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('RCC orchestration ports provide review and merge agents for the live execution owner', async () => {
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
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-worker',
    pipelineNodeId: 'serve-rcc-stage',
    targetRefs: ['serve-rcc-output'],
    expectedOutputRefs: ['serve-rcc-output'],
    expectedArtifactDigests: [digestOf(serveArtifactBody)],
  };
  const workerDelivery = await workerPorts.executionAgent!.execute({
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
  assert.equal(worker.producedArtifactDigests.length, 1);

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
    reviewMaterial: materialFor(workAssignment, worker),
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

test('RCC review agent fails closed when the model exhausts retries without a review marker', async () => {
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
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-omission-worker',
    expectedArtifactDigests: [digestOf(serveArtifactBody)],
  };
  const workerDelivery = await workerPorts.executionAgent!.execute({
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
    reviewMaterial: materialFor(workAssignment, worker),
    scope,
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
  assert.match(review.findings[0]!.expected, /bounded recover\/re-review consumer/);
});

test('RCC review agent retries a real provider reply that dropped the terminal marker', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-review-retry'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review retry',
    directive: 'recover a markerless provider reply with a bounded real retry',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-retry-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded', reviewMarkerSequence: [undefined, 'HUMANAGENT_REVIEW: passed'] }),
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-retry-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-execution-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    acceptanceCriteriaDigest: 'sha256:serve-rcc-review-retry-criteria',
    subjectRefs: ['serve-output'],
    subjectDigests: [],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const workerAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-retry-worker',
    expectedArtifactDigests: [digestOf(serveArtifactBody)],
  };
  const workerResult: WorkResult = {
    ...assignment(task),
    pipelineNodeId: 'serve-stage',
    agentId: 'serve-rcc-execution-agent',
    assignmentId: 'serve-rcc-retry-worker',
    executionEpoch: 1,
    attempt: 1,
    inputRevision: 1,
    taskId: task.id,
    producedArtifactRefs: ['serve-output'],
    producedArtifactDigests: [digestOf(serveArtifactBody)],
    status: 'succeeded',
    summary: 'worker result',
    outputRefs: ['serve-output'],
    evidenceRefs: [],
    nextAction: 'review',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment,
    workerResult,
    reviewMaterial: materialFor(workerAssignment, workerResult),
    scope,
  });
  assert.equal(review.status, 'passed');
  assert.equal(review.findings.length, 0);
});

test('RCC review agent retries an inconclusive verdict before accepting a later pass', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'inconclusive-then-pass',
    provider: providerPort({
      state: 'succeeded',
      reviewMarkerSequence: ['HUMANAGENT_REVIEW: inconclusive', 'HUMANAGENT_REVIEW: passed'],
    }),
  });
  assert.equal(review.status, 'passed');
  assert.deepEqual(review.findings, []);
});

test('RCC review agent renders executor tool evidence into the review prompt', async () => {
  const submittedPrompts: string[] = [];
  const task: Task = {
    id: id('task', 'serve-rcc-review-executor-evidence'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review executor evidence',
    directive: 'carry executor tool evidence into the reviewer prompt',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-executor-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({
      state: 'succeeded',
      reviewMarker: 'HUMANAGENT_REVIEW: passed',
      submittedPrompts,
    }),
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-review-executor-worker',
    pipelineNodeId: 'serve-rcc-review-executor-stage',
    expectedArtifactDigests: [digestOf(serveArtifactBody)],
  };
  const workerDelivery = await workerPorts.executionAgent!.execute({
    assignment: workAssignment,
    agentId: 'serve-rcc-review-executor-agent',
    executionEpoch: 1,
    attempt: 1,
    lease: {
      leaseId: 'serve-rcc-review-executor-lease',
      runtimeId: 'serve-rcc-review-executor-runtime',
      generation: 1,
      executionEpoch: 1,
      ownerId: 'serve-test',
      assignmentId: workAssignment.assignmentId,
      capabilities: ['provider.execution'],
    },
    scope,
  });
  const worker = 'result' in workerDelivery ? workerDelivery.result : workerDelivery;
  const executorEvidence = [
    {
      summary: 'provider.tool search matched 3 files',
      evidenceRefs: [{
        evidenceId: id('evidence', 'serve-rcc-executor-tool'),
        kind: 'tool' as const,
        source: 'test.serve-rcc-orchestration',
        locator: 'serve-rcc/executor-tool',
        scope,
      }],
    },
  ];
  const workerWithEvidence = { ...worker, executorEvidence };
  const reviewAssignment: ReviewAssignment = {
    assignmentId: 'serve-rcc-review-executor-review',
    taskId: task.id.value,
    workerAgentId: 'serve-rcc-review-executor-agent',
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    acceptanceCriteriaDigest: workAssignment.acceptanceCriteriaDigest,
    subjectRefs: [...workAssignment.targetRefs],
    subjectDigests: [...worker.producedArtifactDigests],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment: workAssignment,
    workerResult: workerWithEvidence,
    reviewMaterial: materialFor(workAssignment, workerWithEvidence),
    scope,
  });
  assert.equal(review.status, 'passed');
  assert.equal(submittedPrompts.length, 1, 'the reviewer provider must receive the review prompt');
  const prompt = submittedPrompts[0] ?? '';
  assert.match(prompt, /provider\.tool search matched 3 files/);
  assert.match(prompt, /serve-rcc-executor-tool/);
  assert.match(prompt, /first-hand execution evidence/);
});

test('RCC review agent does not invent executor evidence when none exists', async () => {
  const submittedPrompts: string[] = [];
  const review = await reviewWithProviderText({
    taskSuffix: 'absent-executor-evidence',
    provider: providerPort({
      state: 'succeeded',
      reviewMarker: 'HUMANAGENT_REVIEW: failed',
      submittedPrompts,
    }),
  });
  assert.equal(review.status, 'failed');
  const prompt = submittedPrompts[0] ?? '';
  assert.match(prompt, /"executorEvidence":\[\]/);
});

test('RCC review agent honors an explicit failed verdict without retrying to pass', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'failed-not-retried',
    provider: providerPort({
      state: 'succeeded',
      reviewMarkerSequence: ['HUMANAGENT_REVIEW: failed', 'HUMANAGENT_REVIEW: passed'],
    }),
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
  assert.match(review.findings[0]!.problem, /HUMANAGENT_REVIEW: failed/);
});

test('RCC review agent uses the terminal verdict when review markers conflict', async () => {
  const task: Task = {
    id: id('task', 'serve-rcc-review-conflict'),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC review terminal verdict',
    directive: 'keep the terminal review verdict as authoritative',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = { organId: task.organId, taskId: task.id, cycleId: id('cycle', 'serve-rcc-review-conflict-cycle') };
  const ports = createRccServeOrchestrationPorts({
    port: providerPort({ state: 'succeeded', reviewMarkers: ['HUMANAGENT_REVIEW: passed', 'HUMANAGENT_REVIEW: failed'] }),
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
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
  const workerAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: 'serve-rcc-conflict-worker',
    expectedArtifactDigests: [digestOf(serveArtifactBody)],
  };
  const workerResult: WorkResult = {
    ...assignment(task),
    pipelineNodeId: 'serve-stage',
    agentId: 'serve-rcc-execution-agent',
    assignmentId: 'serve-rcc-conflict-worker',
    executionEpoch: 1,
    attempt: 1,
    inputRevision: 1,
    taskId: task.id,
    producedArtifactRefs: ['serve-output'],
    producedArtifactDigests: [digestOf(serveArtifactBody)],
    status: 'succeeded',
    summary: 'worker result',
    outputRefs: ['serve-output'],
    evidenceRefs: [],
    nextAction: 'review',
  };
  const review = await ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment,
    workerResult,
    reviewMaterial: materialFor(workerAssignment, workerResult),
    scope,
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
});

test('RCC review agent uses a terminal passed verdict after an earlier failed quote', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'terminal-passed-after-quote',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: [
        'The criteria text includes HUMANAGENT_REVIEW: failed only as an example. ',
        'HUMANAGENT_REVIEW: passed',
      ],
    }),
  });
  assert.equal(review.status, 'passed');
  assert.deepEqual(review.findings, []);
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
    ...createDeterministicServeOrchestrationPorts(),
    ...createRccServeOrchestrationPorts({
      port: providerPort({ state: 'succeeded', reviewMarker: 'HUMANAGENT_REVIEW: passed', outputRef: 'serve-rcc-manager-output' }),
      binding: providerBinding(),
      promptSegments: { review: ['review system prompt'] },
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
    expectedArtifactDigests: [digestOf(serveArtifactBody)],
  };
  try {
    assembly.orchestration.planStage({ nodeId: workAssignment.pipelineNodeId, taskId: task.id });
    const dispatched = await assembly.orchestration.dispatch({
      stageNodeId: workAssignment.pipelineNodeId,
      assignment: workAssignment,
      agentId: 'serve-rcc-execution-agent',
      scope,
      reviewKinds: ['quality'],
      reviewSubjects: [{ ref: 'serve-rcc-manager-output', body: serveArtifactBody }],
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

async function reviewWithProviderText(input: {
  readonly taskSuffix: string;
  readonly provider: ExecutionRuntimePort;
}): Promise<ReviewResult> {
  const task: Task = {
    id: id('task', `serve-chunk-${input.taskSuffix}`),
    organId: id('organ', 'humanagent-ui'),
    title: 'RCC chunked review',
    directive: 'parse reviewer text across chunk boundaries',
    directiveRevision: 1,
    state: 'created',
    memoryScope: 'task',
  };
  const scope: ScopeRef = {
    organId: task.organId,
    taskId: task.id,
    cycleId: id('cycle', `serve-chunk-${input.taskSuffix}-cycle`),
  };
  const ports = createRccServeOrchestrationPorts({
    port: input.provider,
    binding: providerBinding(),
    promptSegments: { review: ['review system prompt'] },
  });
  const workerPorts = createDeterministicServeOrchestrationPorts();
  const workAssignment: WorkAssignment = {
    ...assignment(task),
    assignmentId: `serve-chunk-${input.taskSuffix}-assignment`,
    pipelineNodeId: `serve-chunk-${input.taskSuffix}-stage`,
    expectedArtifactDigests: [digestOf(serveArtifactBody)],
  };
  const delivery = await workerPorts.executionAgent!.execute({
    assignment: workAssignment,
    agentId: `serve-chunk-${input.taskSuffix}-worker`,
    executionEpoch: 1,
    attempt: 1,
    lease: {
      leaseId: `serve-chunk-${input.taskSuffix}-lease`,
      runtimeId: `serve-chunk-${input.taskSuffix}-runtime`,
      generation: 1,
      executionEpoch: 1,
      ownerId: 'serve-test',
      assignmentId: workAssignment.assignmentId,
      capabilities: ['provider.execution'],
    },
    scope,
  });
  const worker = 'result' in delivery ? delivery.result : delivery;
  const reviewAssignment: ReviewAssignment = {
    assignmentId: `serve-chunk-${input.taskSuffix}-review`,
    taskId: task.id.value,
    workerAgentId: `serve-chunk-${input.taskSuffix}-worker`,
    reviewKind: 'quality',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    acceptanceCriteriaDigest: workAssignment.acceptanceCriteriaDigest,
    subjectRefs: [...workAssignment.targetRefs],
    subjectDigests: [...worker.producedArtifactDigests],
    workerCapabilities: ['provider.execution'],
    requiredCapabilities: ['quality.review'],
    mergeGate: 'required',
  };
  return ports.reviewAgent.review({
    reviewAssignment,
    workerAssignment: workAssignment,
    workerResult: worker,
    reviewMaterial: materialFor(workAssignment, worker),
    scope,
  });
}

test('RCC review parses a verdict marker split across provider output chunks', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'split-marker',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: ['Subject reviewed: the artifact body is present. HUMANAGENT_REV', 'IEW: passed'],
    }),
  });
  assert.equal(review.status, 'passed');
  assert.deepEqual(review.findings, []);
});

test('RCC review keeps a chunked explanation and does not drop it behind a marker-only chunk', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'chunked-explanation',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: [
        'The acceptance criteria are unmet because the artifact omits the required evidence. ',
        'HUMANAGENT_REVIEW: failed',
      ],
    }),
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
  assert.match(review.findings[0]!.problem, /omits the required evidence/);
});

test('RCC review keeps a verdict marker tail that depends on an earlier chunk', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'marker-after-explanation',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: ['All acceptance criteria are satisfied. ', 'HUMANAGENT_REVIEW: passed'],
    }),
  });
  assert.equal(review.status, 'passed');
});

test('RCC review uses the terminal verdict when verdict markers conflict across chunks', async () => {
  const review = await reviewWithProviderText({
    taskSuffix: 'conflicting-chunks',
    provider: providerPort({
      state: 'succeeded',
      chunkedReviewText: ['HUMANAGENT_REVIEW: passed', ' but on reflection HUMANAGENT_REVIEW: failed'],
    }),
  });
  assert.equal(review.status, 'failed');
  assert.equal(review.findings.length, 1);
});
