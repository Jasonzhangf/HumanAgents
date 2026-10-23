import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type ProductMessageActor,
} from '../../packages/contracts/src/index.js';
import {
  FileCheckpointStore,
  FakeReplayExecutionRuntimePort,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../packages/app/src/ui-runtime/index.js';
import type { ExplicitInput } from '../../packages/runtime/src/intake/explicit-intake.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';

// S wiring consumer for plan §8 T1 and the thin App wiring. This consumer
// proves the dashboard recentInputs no longer fakes task.input/task.updatedAt
// as human, and that productPublicOutput stays empty when no commit exists.
const organId = id('organ', 's-organ');
const binding = {
  bindingId: 's-binding',
  providerId: 's-provider',
  protocol: 'responses' as const,
  endpointRef: 'fake://s',
  modelRef: 'fake',
  configDigest: 'sha256:s-config',
  capabilityDigest: 'sha256:s-capability',
};

function makeService(): UiRuntimeService {
  const journal = new UiRuntimeJournal('/tmp/humanagent-s-wiring-journal.jsonl');
  return new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding }),
    journal,
    closurePort: journal,
    providerState: 'ready',
    checkpointStoreFor: (taskId, cycleId) =>
      new FileCheckpointStore(`/tmp/humanagent-s-wiring-${taskId.value}-${cycleId.value}.jsonl`),
    attentionPort: {
      async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
      async resolve(input) { return { attentionId: input.attentionId, delivered: true }; },
    },
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'project-s',
      roleId: 'execution',
    },
    explicitBrainInterpreter: { async interpret() { throw new Error('unused'); } },
  });
}

function receive(service: UiRuntimeService, input: Omit<ExplicitInput, 'channel' | 'workspace'> & {
  readonly channel: 'business' | 'control';
}) {
  return service.receiveExplicitInput(input);
}

test('T1: dashboard recentInputs never fakes human or updatedAt', async () => {
  const service = makeService();

  const human: ProductMessageActor = {
    kind: 'human',
    sourceKind: 'authenticated-principal',
    sourceRef: 'principal-a',
  };

  await receive(service, {
    sourceRef: 'entry-1',
    rawInput: 'please build it',
    channel: 'business',
    actor: human,
    occurredAt: '2026-10-21T10:00:00.000Z',
  });
  await receive(service, {
    sourceRef: 'entry-2',
    rawInput: 'orchestration matched this task',
    channel: 'business',
    occurredAt: '2026-10-21T10:01:00.000Z',
  });

  const dashboard = await service.dashboardWithIdentitySource();
  assert.equal(dashboard.recentInputs.length, 2);
  assert.equal(dashboard.recentInputs[0].text, 'orchestration matched this task');
  assert.equal(dashboard.recentInputs[0].receivedAt, '2026-10-21T10:01:00.000Z');
  assert.equal(dashboard.recentInputs[0].source, 'task');
  assert.equal(dashboard.recentInputs[1].text, 'please build it');
  assert.equal(dashboard.recentInputs[1].receivedAt, '2026-10-21T10:00:00.000Z');
  assert.equal(dashboard.recentInputs[1].source, 'human');

  const board = await service.productBoardIndex({ kind: 'project', projectKey: 'project-s' });
  const interactionBoard = board.boards.find((section) => section.board === 'interaction');
  if (interactionBoard === undefined) throw new Error('interaction board is missing');
  assert.deepEqual(
    interactionBoard.live.map((item) => item.title).sort(),
    ['orchestration matched this task', 'please build it'],
  );

  const session = await service.productSessionRead({ kind: 'project', projectKey: 'project-s' });
  const humanMessage = session.messages.find((message) => message.text === 'please build it');
  const unmatchedMessage = session.messages.find((message) => message.text === 'orchestration matched this task');
  if (humanMessage === undefined) throw new Error('human interaction message is missing');
  if (unmatchedMessage === undefined) throw new Error('unmatched interaction message is missing');
  assert.equal(humanMessage.actor.kind, 'human');
  assert.equal(humanMessage.occurredAt, '2026-10-21T10:00:00.000Z');
  assert.equal(unmatchedMessage.actor.kind, 'unknown');
  assert.equal(unmatchedMessage.occurredAt, '2026-10-21T10:01:00.000Z');

  service.createTask({ title: 'fake task', directive: 'this task input must not appear' });
  const withTask = await service.dashboardWithIdentitySource();
  assert.equal(
    withTask.recentInputs.some((item) => item.text === 'this task input must not appear'),
    false,
  );
});

test('T1: no committed result yields an empty public result', async () => {
  const service = makeService();
  const task = service.createTask({ title: 'empty result task' });
  const detail = service.taskDetail(task.taskId);
  assert.equal(detail.output, undefined);
  assert.deepEqual(detail.investigation, []);
  const view = await service.productPublicOutput(task.taskId);
  assert.equal(view.resultAvailable, false);
  assert.deepEqual(view.commits, []);
});
