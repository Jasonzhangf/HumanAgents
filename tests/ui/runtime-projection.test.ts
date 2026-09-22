import assert from 'node:assert/strict';
import test from 'node:test';
import { id } from '@humanagent/contracts';
import {
  projectPipelineObservation,
  type ObservationScopeSource,
  type ObservationNodeSource,
  type ObservationAgentFrameSource,
  type ObservationHandoffSource,
} from '../../packages/ui/projection/index.js';
import { UiProjectionError, type UiDataSource } from '../../packages/ui/contracts/models.js';
import {
  projectRuntimeDashboard,
  projectRuntimeTaskList,
  type RuntimeTaskSnapshotInput,
} from '../../packages/ui/projection/runtime.js';

const observationSource: UiDataSource = { state: 'ready', label: '运行记录' };

function assertProjectionRejected(run: () => unknown, expected: RegExp): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof UiProjectionError)) {
      throw new Error(`expected UiProjectionError, received ${String(error)}`);
    }
    assert.equal(expected.test(error.message), true, `expected ${String(expected)} in ${error.message}`);
    return;
  }
  throw new Error(`expected projection to be rejected with ${String(expected)}`);
}

function node(overrides: Partial<ObservationNodeSource> & { readonly nodeId: string; readonly owner: string }): ObservationNodeSource {
  return {
    title: overrides.nodeId,
    kind: 'execution',
    state: 'running',
    summary: `${overrides.nodeId} summary`,
    inputRefs: [],
    outputRefs: [],
    evidenceRefs: [],
    ...overrides,
  };
}

function scopeOf(overrides: Partial<ObservationScopeSource> & { readonly nodes: readonly ObservationNodeSource[] }): Record<string, ObservationScopeSource> {
  return {
    root: {
      scopeRef: 'root',
      title: '任务处理流水',
      summary: '只读节点树',
      projectionSeq: 'seq-1',
      ...overrides,
    },
  };
}

const handoffFrames: ObservationAgentFrameSource[] = [
  { agentId: 'agent-orchestration', role: 'orchestration', stateDisplay: '运行中', iteration: 2 },
  { agentId: 'agent-execution', role: 'execution', stateDisplay: '执行中', iteration: 2 },
];

const handoff: ObservationHandoffSource = {
  handoffId: 'handoff-1',
  fromNodeId: 'implicit.classify',
  toNodeId: 'pipeline.execute',
  carrySummary: '传递整理后的目标与证据范围',
  payloadPreview: 'objective=补齐证据; scope=docs',
  notCarried: '不传递隐式分类的候选队列和内部打分',
  occurredAt: '2026-09-21T00:00:00.000Z',
};

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

test('observation projection groups nodes into stable agent frames and ordered tool steps', () => {
  const projection = projectPipelineObservation({
    source: observationSource,
    scopeStack: ['root'],
    scopes: scopeOf({
      currentNodeId: 'pipeline.execute',
      agents: handoffFrames,
      handoffs: [handoff],
      nodes: [
        node({
          nodeId: 'implicit.classify',
          title: '任务分类',
          kind: 'orchestration',
          state: 'succeeded',
          owner: 'agent-orchestration',
          ownerAgentRole: 'orchestration',
          iteration: 2,
          activity: [{ activityRef: 'activity://classify', summary: '整理需求并准入', occurredAt: '2026-09-21T00:00:00.000Z' }],
        }),
        node({
          nodeId: 'pipeline.execute',
          owner: 'agent-execution',
          ownerAgentRole: 'execution',
          iteration: 2,
          toolSteps: [
            { stepId: 'step-1', name: 'code-search', status: 'succeeded', returned: '12 matches', occurredAt: '2026-09-21T00:01:00.000Z' },
            { stepId: 'step-2', name: 'read-file', status: 'running', returned: 'pending', occurredAt: '2026-09-21T00:02:00.000Z' },
          ],
        }),
      ],
    }),
  });

  assert.deepEqual(projection.nodes.map((entry) => entry.nodeId), ['implicit.classify', 'pipeline.execute']);
  assert.deepEqual(projection.nodes.map((entry) => entry.ownerAgentRole), ['orchestration', 'execution']);
  assert.deepEqual(projection.nodes.map((entry) => entry.roleDisplay), ['任务编排', '执行']);
  assert.deepEqual(projection.nodes.map((entry) => entry.iteration), [2, 2]);
  assert.deepEqual(projection.nodes[0].activity.map((entry) => entry.activityRef), ['activity://classify']);

  const executeSteps = projection.nodes[1].toolSteps;
  assert.deepEqual(executeSteps.map((step) => step.name), ['code-search', 'read-file']);
  assert.deepEqual(executeSteps.map((step) => step.statusDisplay), ['已返回', '调用中']);
  assert.equal(executeSteps[0].returned, '12 matches');
  assert.equal(executeSteps[0].occurredAt, '2026-09-21T00:01:00.000Z');

  assert.deepEqual(projection.agentFrames.map((frame) => frame.agentId), ['agent-orchestration', 'agent-execution']);
  assert.deepEqual(projection.agentFrames.map((frame) => frame.roleDisplay), ['任务编排', '执行']);
  assert.deepEqual(projection.agentFrames.map((frame) => frame.nodeIds), [['implicit.classify'], ['pipeline.execute']]);
  assert.deepEqual(projection.agentFrames.map((frame) => frame.stateDisplay), ['运行中', '执行中']);
  assert.deepEqual(projection.agentFrames.map((frame) => frame.iteration), [2, 2]);

  assert.equal(projection.currentNode?.nodeId, 'pipeline.execute');
  assert.equal(projection.handoffs.length, 1);
  const firstHandoff = projection.handoffs[0];
  assert.equal(firstHandoff.fromAgentId, 'agent-orchestration');
  assert.equal(firstHandoff.toAgentId, 'agent-execution');
  assert.equal(firstHandoff.fromRoleDisplay, '任务编排');
  assert.equal(firstHandoff.toRoleDisplay, '执行');
  assert.equal(firstHandoff.notCarried, '不传递隐式分类的候选队列和内部打分');
  assert.equal(firstHandoff.payloadPreview, 'objective=补齐证据; scope=docs');

  const repeated = projectPipelineObservation({
    source: observationSource,
    scopeStack: ['root'],
    scopes: scopeOf({
      currentNodeId: 'pipeline.execute',
      agents: handoffFrames,
      handoffs: [handoff],
      nodes: [
        node({ nodeId: 'implicit.classify', owner: 'agent-orchestration' }),
        node({ nodeId: 'pipeline.execute', owner: 'agent-execution' }),
      ],
    }),
  });
  assert.deepEqual(
    repeated.agentFrames.map((frame) => frame.nodeIds),
    projection.agentFrames.map((frame) => frame.nodeIds),
  );
});

test('observation projection carries the declared agent role and iteration without inventing them', () => {
  const projection = projectPipelineObservation({
    source: observationSource,
    scopeStack: ['root'],
    scopes: scopeOf({
      agents: [{ agentId: 'agent-review', role: 'review', stateDisplay: '待复核', iteration: 4 }],
      nodes: [node({ nodeId: 'node.review', owner: 'agent-review' })],
    }),
  });
  assert.equal(projection.nodes[0].ownerAgentRole, 'review');
  assert.equal(projection.nodes[0].roleDisplay, '审核');
  assert.equal(projection.nodes[0].iteration, 4);
  assert.equal(projection.agentFrames[0].iteration, 4);
  assert.deepEqual(projection.nodes[0].toolSteps, []);
  assert.deepEqual(projection.nodes[0].activity, []);
  assert.equal(projection.nodes[0].updatedAt, undefined);

  const overriddenIteration = projectPipelineObservation({
    source: observationSource,
    scopeStack: ['root'],
    scopes: scopeOf({
      agents: [{ agentId: 'agent-review', role: 'review', stateDisplay: '待复核', iteration: 4 }],
      nodes: [node({ nodeId: 'node.review', owner: 'agent-review', ownerAgentRole: 'review', iteration: 5 })],
    }),
  });
  assert.equal(overriddenIteration.nodes[0].iteration, 5);
  assert.equal(overriddenIteration.agentFrames[0].iteration, 4);
});

test('observation projection fails explicitly on unknown nodes, undeclared owners, and unknown roles', () => {
  assertProjectionRejected(
    () => projectPipelineObservation({
      source: observationSource,
      scopeStack: ['root'],
      scopes: scopeOf({
        currentNodeId: 'missing.node',
        agents: handoffFrames,
        nodes: [node({ nodeId: 'implicit.classify', owner: 'agent-orchestration' })],
      }),
    }),
    /missing\.node/,
  );

  assertProjectionRejected(
    () => projectPipelineObservation({
      source: observationSource,
      scopeStack: ['root'],
      scopes: scopeOf({
        agents: handoffFrames,
        nodes: [node({ nodeId: 'orphan.node', owner: 'agent-undeclared' })],
      }),
    }),
    /agent-undeclared/,
  );

  assertProjectionRejected(
    () => projectPipelineObservation({
      source: observationSource,
      scopeStack: ['root'],
      scopes: scopeOf({
        agents: handoffFrames,
        nodes: [node({
          nodeId: 'implicit.classify',
          owner: 'agent-orchestration',
          ownerAgentRole: 'execution',
        })],
      }),
    }),
    /declares role execution but owner agent-orchestration is orchestration/,
  );

  assertProjectionRejected(
    () => projectPipelineObservation({
      source: observationSource,
      scopeStack: ['root'],
      scopes: scopeOf({
        agents: [{ agentId: 'agent-bogus', role: 'wizard' as never, stateDisplay: '运行中', iteration: 1 }],
        nodes: [node({ nodeId: 'node.bogus', owner: 'agent-bogus' })],
      }),
    }),
    /wizard/,
  );

  assertProjectionRejected(
    () => projectPipelineObservation({
      source: observationSource,
      scopeStack: ['root'],
      scopes: scopeOf({
        agents: handoffFrames,
        handoffs: [{ ...handoff, toNodeId: 'missing.node' }],
        nodes: [node({ nodeId: 'implicit.classify', owner: 'agent-orchestration' })],
      }),
    }),
    /handoff handoff-1 references unknown to node missing\.node/,
  );

  assertProjectionRejected(
    () => projectPipelineObservation({
      source: observationSource,
      scopeStack: ['root'],
      scopes: scopeOf({
        agents: handoffFrames,
        handoffs: [{ ...handoff, notCarried: '   ' }],
        nodes: [
          node({ nodeId: 'implicit.classify', owner: 'agent-orchestration' }),
          node({ nodeId: 'pipeline.execute', owner: 'agent-execution' }),
        ],
      }),
    }),
    /notCarried/,
  );

  assertProjectionRejected(
    () => projectPipelineObservation({
      source: observationSource,
      scopeStack: ['root'],
      scopes: scopeOf({
        agents: handoffFrames,
        nodes: [node({
          nodeId: 'pipeline.execute',
          owner: 'agent-execution',
          toolSteps: [{ stepId: 'step-1', name: 'code-search', status: 'mystery' as never, returned: 'x' }],
        })],
      }),
    }),
    /mystery/,
  );

  assertProjectionRejected(
    () => projectPipelineObservation({
      source: observationSource,
      scopeStack: ['root'],
      scopes: scopeOf({
        agents: handoffFrames,
        nodes: [node({ nodeId: 'pipeline.execute', owner: 'agent-execution' })],
      }),
      selectedNodeId: 'node.absent',
    }),
    /node\.absent/,
  );
});
