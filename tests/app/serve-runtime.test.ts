import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ScopeRef, type Task, type WorkAssignment } from '../../packages/contracts/src/index.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import { fakeExecutionBinding } from '../../packages/app/src/fake-execution.js';
import { createDeterministicServeOrchestrationPorts } from '../../packages/app/src/serve-orchestration.js';
import { createServeRuntimeComposition } from '../../packages/app/src/serve-runtime.js';
import { FakeReplayExecutionRuntimePort, startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import type { CheckpointJournalPort } from '../../packages/runtime/src/checkpoints/ports.js';
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
