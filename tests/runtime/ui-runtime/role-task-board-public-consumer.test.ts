import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id } from '../../../packages/contracts/src/index.js';
import { UiRuntimeJournal } from '../../../packages/app/src/ui-runtime/journal.js';
import { RuntimeTaskCoordinator, type RuntimeTaskCoordinatorOptions, type RuntimeTaskJournalRecord } from '../../../packages/runtime/src/ui-runtime/coordinator.js';

const alex = { scope: 'ceo', actorId: 'Alex' } as const;
const jenny = { scope: 'project', projectId: '/projects/acme', actorId: 'Jenny' } as const;
const mia = { scope: 'project', projectId: '/projects/acme', actorId: 'Mia' } as const;

function createCoordinator(root: string, journal: RuntimeTaskCoordinatorOptions['journal']): RuntimeTaskCoordinator {
  return new RuntimeTaskCoordinator({
    organId: id('organ', 'role-board'),
    createDriver: () => { throw new Error('Board read must not execute a task'); },
    checkpointStoreFor: () => ({} as ReturnType<RuntimeTaskCoordinatorOptions['checkpointStoreFor']>),
    attentionPort: { publish: async () => ({ attentionId: 'unused', delivered: true }), resolve: async () => ({ attentionId: 'unused', delivered: true }) },
    journal,
  });
}

function journal(records: RuntimeTaskJournalRecord[]): RuntimeTaskCoordinatorOptions['journal'] {
  return { replay: () => records, append: (record) => { records.push(record); } };
}

test('role board keeps legacy tasks unowned and replays real journal assignments once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-role-board-journal-'));
  try {
    const journalPath = join(root, 'ui-runtime-journal.jsonl');
    const realJournal = new UiRuntimeJournal(journalPath);
    const coordinator = createCoordinator(root, realJournal);
    const legacy = coordinator.createTask({ title: 'Legacy', directive: 'no committed board owner' });
    const projectTask = coordinator.createTask({
      title: 'Project work',
      directive: 'project task',
      boardOwner: jenny,
      taskKind: 'inspection',
    });

    assert.equal(legacy.boardOwner, undefined);
    assert.equal(coordinator.taskBoard(alex).current.some((entry) => entry.task.taskId.value === legacy.taskId.value), false);
    assert.deepEqual(coordinator.taskBoard(jenny).current[0]?.task.taskKind, 'inspection');

    coordinator.reassignTask(legacy.taskId, jenny);
    coordinator.reassignTask(projectTask.taskId, mia);
    coordinator.reassignTask(projectTask.taskId, mia);
    const replayed = createCoordinator(root, new UiRuntimeJournal(journalPath));
    assert.equal(replayed.taskBoard(jenny).current.filter((entry) => entry.task.taskId.value === legacy.taskId.value).length, 1);
    assert.equal(replayed.taskBoard(alex).current.some((entry) => entry.task.taskId.value === legacy.taskId.value), false);
    assert.equal(replayed.taskBoard(mia).current.filter((entry) => entry.task.taskId.value === projectTask.taskId.value).length, 1);
    assert.equal(replayed.taskBoard(jenny).history.filter((entry) => entry.task.taskId.value === projectTask.taskId.value).length, 1);
    assert.deepEqual(replayed.taskBoard(jenny).history[0]?.previousOwner, jenny);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('role board projects one task source into current and owner history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-role-board-'));
  try {
    const records: RuntimeTaskJournalRecord[] = [];
    const coordinator = createCoordinator(root, journal(records));
    const general = coordinator.createTask({ title: 'CEO request', directive: 'general work', boardOwner: alex });
    const projectTask = coordinator.createTask({ title: 'Project work', directive: 'project task', boardOwner: jenny });
    const inspection = coordinator.createTask({ title: 'Check project', directive: 'inspect state', boardOwner: jenny, taskKind: 'inspection' });

    assert.deepEqual(coordinator.taskBoard(alex).current.map((entry) => entry.task.taskId), [general.taskId]);
    assert.deepEqual(coordinator.taskBoard(jenny).current.map((entry) => entry.task.taskId), [projectTask.taskId, inspection.taskId]);
    assert.deepEqual(
      coordinator.taskBoard({ actorId: 'Jenny', projectId: '/projects/acme', scope: 'project' }).current.map((entry) => entry.task.taskId),
      [projectTask.taskId, inspection.taskId],
    );
    assert.deepEqual(coordinator.taskBoard({ ...jenny, projectId: '/projects/other' }).current, []);
    assert.equal(coordinator.taskBoard(jenny).current[1].task.taskKind, 'inspection');

    coordinator.reassignTask(projectTask.taskId, mia);
    coordinator.reassignTask(projectTask.taskId, mia);
    assert.equal(coordinator.taskBoard(jenny).current.some((entry) => entry.task.taskId.value === projectTask.taskId.value), false);
    assert.equal(coordinator.taskBoard(mia).current.filter((entry) => entry.task.taskId.value === projectTask.taskId.value).length, 1);
    assert.equal(coordinator.taskBoard(jenny).history.filter((entry) => entry.task.taskId.value === projectTask.taskId.value).length, 1);
    assert.deepEqual(coordinator.taskBoard(jenny).history.find((entry) => entry.task.taskId.value === projectTask.taskId.value)?.previousOwner, jenny);

    coordinator.updateTask(inspection.taskId, { title: 'Checked project' });
    const deleted = coordinator.createTask({ title: 'Temporary', directive: 'remove me', boardOwner: jenny });
    coordinator.deleteTask(deleted.taskId);
    assert.equal(coordinator.taskBoard(jenny).current.some((entry) => entry.task.taskId.value === deleted.taskId.value), false);
    assert.equal(coordinator.taskBoard(jenny).history.some((entry) => entry.task.taskId.value === deleted.taskId.value && entry.deletedAt), true);

    const replayed = createCoordinator(root, journal(records));
    assert.equal(replayed.taskBoard(mia).current.filter((entry) => entry.task.taskId.value === projectTask.taskId.value).length, 1);
    assert.equal(replayed.taskBoard(jenny).current.some((entry) => entry.task.taskId.value === projectTask.taskId.value), false);
    assert.equal(replayed.taskBoard(jenny).history.some((entry) => entry.task.taskId.value === deleted.taskId.value), true);
    assert.equal(replayed.taskSnapshots().some((task) => task.taskId.value === deleted.taskId.value), false);

    const brokenRecords: RuntimeTaskJournalRecord[] = [];
    const broken = createCoordinator(root, { replay: () => brokenRecords, append(record) {
      if (record.kind === 'task.reassigned') throw new Error('reassignment journal failed');
      brokenRecords.push(record);
    } });
    const held = broken.createTask({ title: 'Held', directive: 'must stay with Alex', boardOwner: alex });
    assert.throws(() => broken.reassignTask(held.taskId, jenny), /reassignment journal failed/);
    assert.equal(broken.taskBoard(alex).current.length, 1);
    assert.equal(broken.taskBoard(jenny).current.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
