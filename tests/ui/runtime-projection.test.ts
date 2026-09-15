import assert from 'node:assert/strict';
import test from 'node:test';
import { id } from '@humanagent/contracts';
import {
  projectRuntimeDashboard,
  projectRuntimeTaskList,
  type RuntimeTaskSnapshotInput,
} from '../../packages/ui/projection/runtime.js';

function runtimeTask(state: 'created' | 'running' | 'succeeded' | 'stopped' | 'failed', index: number): RuntimeTaskSnapshotInput {
  return {
    taskId: id('task', `task-runtime-${index}`),
    title: `runtime task ${index}`,
    state,
    currentState: state,
    nextStep: 'next',
    updatedAt: '2026-09-14T00:00:00.000Z',
    input: '',
    output: '',
    currentNode: 'node',
    allowedActions: [],
    recentEvents: [],
  };
}

test('runtime task list classifies every task into a visible projection group', () => {
  const tasks = [
    runtimeTask('created', 1),
    runtimeTask('running', 2),
    runtimeTask('succeeded', 3),
    runtimeTask('stopped', 4),
    runtimeTask('failed', 5),
  ];
  const list = projectRuntimeTaskList({ mode: 'fake', tasks });
  assert.deepEqual(list.draft.map((row) => row.taskId.value), ['task-runtime-1']);
  assert.deepEqual(list.running.map((row) => row.taskId.value), ['task-runtime-2']);
  assert.deepEqual(list.completed.map((row) => row.taskId.value), ['task-runtime-3']);
  assert.deepEqual(list.stopped.map((row) => row.taskId.value), ['task-runtime-4']);
  assert.deepEqual(list.failed.map((row) => row.taskId.value), ['task-runtime-5']);
  assert.deepEqual(list.counts, { running: 1, waiting: 0, completed: 1, stopped: 1, draft: 1, failed: 1, total: 5 });
});

test('runtime dashboard only reports hasRunning for execution-active tasks', () => {
  const dashboard = projectRuntimeDashboard({
    mode: 'fake',
    tasks: [runtimeTask('created', 1)],
    recentInputs: [],
  });
  assert.equal(dashboard.hasRunning, false);
  assert.equal(dashboard.taskCount, 1);
  assert.equal(dashboard.waitingDecisionCount, 0);
});
