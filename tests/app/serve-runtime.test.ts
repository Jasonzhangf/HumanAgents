import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ScopeRef, type Task, type WorkAssignment } from '../../packages/contracts/src/index.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import { createDeterministicServeOrchestrationPorts } from '../../packages/app/src/serve-orchestration.js';
import { createServeRuntimeComposition } from '../../packages/app/src/serve-runtime.js';
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
