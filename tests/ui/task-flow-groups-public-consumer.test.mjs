import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { TASK_FLOW_KINDS } from '../../packages/contracts/dist/task-flow.js';
import {
  groupTaskFlowRows,
  unclassifiedTaskFlowReason,
} from '../../docs/ui/task-flow-groups.js';

// Product presentation labels. The helper owns this table; the test asserts it
// against the actual TASK_FLOW_KINDS order from the compiled contract.
const LABELS = { 'one-shot': '单次', inspection: '巡检', 'long-running': '长程' };

function makeRow({ taskId, kind, state, identitySource }) {
  return {
    scope: { kind: 'task', projectKey: 'demo-project', mode: 'fake', taskId },
    task: {
      taskId,
      title: `Task ${taskId}`,
      state,
      ...(identitySource === undefined ? {} : { identitySource }),
      ...(kind === undefined ? {} : { taskFlow: { kind, definitionVersion: 1 } }),
    },
    basis: 'live-runtime',
  };
}

test('renders the three ordered type sections from the actual TASK_FLOW_KINDS', () => {
  const rows = TASK_FLOW_KINDS.map((kind, index) =>
    makeRow({ taskId: `task-${kind}`, kind, state: index === 0 ? 'running' : 'created' }),
  );

  const result = groupTaskFlowRows(rows);

  assert.deepEqual(
    result.sections.map((section) => section.kind),
    [...TASK_FLOW_KINDS],
  );
  for (const section of result.sections) {
    assert.equal(section.label, LABELS[section.kind]);
  }
  assert.equal(result.unclassified.rows.length, 0);
});

test('keeps original wrapper references, scope and identity unchanged', () => {
  const identitySource = { requirementId: 'req-1', confirmationRef: 'confirm-1' };
  const rows = TASK_FLOW_KINDS.map((kind) =>
    makeRow({ taskId: `task-${kind}`, kind, state: 'running', identitySource }),
  );
  const input = [...rows];

  const result = groupTaskFlowRows(input);

  const seen = [];
  for (const section of result.sections) {
    for (const row of section.rows) {
      seen.push(row);
      assert.ok(rows.includes(row), 'row is the original wrapper reference');
      assert.equal(row.scope.projectKey, 'demo-project');
      assert.equal(row.scope.kind, 'task');
      assert.equal(row.basis, 'live-runtime');
      assert.equal(row.task.identitySource, identitySource);
    }
  }
  assert.equal(seen.length, rows.length);
  assert.equal(input.length, rows.length);
  input.forEach((row, index) => assert.equal(row, rows[index]));
});

test('retains a missing binding in visible unclassified without a default', () => {
  const row = makeRow({ taskId: 'task-missing', state: 'running' });

  const result = groupTaskFlowRows([row]);

  assert.equal(result.unclassified.rows.length, 1);
  assert.equal(result.unclassified.rows[0], row);
  assert.equal(result.unclassified.kind, 'unclassified');
  assert.equal(unclassifiedTaskFlowReason(row), 'missing');
  for (const section of result.sections) {
    assert.equal(section.rows.length, 0, `no default into ${section.kind}`);
  }
});

test('retains an unsupported public kind in visible unclassified', () => {
  const badKind = 'manual-intervention';
  assert.equal(TASK_FLOW_KINDS.includes(badKind), false);
  const row = makeRow({ taskId: 'task-bad', kind: badKind, state: 'created' });

  const result = groupTaskFlowRows([row]);

  assert.equal(result.unclassified.rows.length, 1);
  assert.equal(result.unclassified.rows[0], row);
  assert.equal(unclassifiedTaskFlowReason(row), 'unsupported');
});

test('applies lifecycle selection inside each type section and unclassified', () => {
  const oneShotRunning = makeRow({ taskId: 'one-running', kind: TASK_FLOW_KINDS[0], state: 'running' });
  const oneShotCreated = makeRow({ taskId: 'one-created', kind: TASK_FLOW_KINDS[0], state: 'created' });
  const inspectionRunning = makeRow({ taskId: 'inspection-running', kind: TASK_FLOW_KINDS[1], state: 'running' });
  const longRunningCreated = makeRow({ taskId: 'long-created', kind: TASK_FLOW_KINDS[2], state: 'created' });
  const missingRunning = makeRow({ taskId: 'missing-running', state: 'running' });
  const missingCreated = makeRow({ taskId: 'missing-created', state: 'created' });
  const rows = [
    oneShotRunning,
    oneShotCreated,
    inspectionRunning,
    longRunningCreated,
    missingRunning,
    missingCreated,
  ];

  const result = groupTaskFlowRows(rows, { lifecycle: 'running' });

  assert.deepEqual(
    result.sections.map((section) => section.kind),
    [...TASK_FLOW_KINDS],
  );
  assert.deepEqual(result.sections[0].rows, [oneShotRunning]);
  assert.deepEqual(result.sections[1].rows, [inspectionRunning]);
  assert.deepEqual(result.sections[2].rows, []);
  assert.deepEqual(result.unclassified.rows, [missingRunning]);

  assert.equal(rows.length, 6, 'input is not mutated or reduced');
  for (const row of [oneShotCreated, longRunningCreated, missingCreated]) {
    assert.ok(rows.includes(row), 'filtered row stays in the input');
  }
});
