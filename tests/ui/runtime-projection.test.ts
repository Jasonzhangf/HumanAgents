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
  projectRuntimeTaskDashboard,
  projectRuntimeTaskList,
  type RuntimeLivenessInput,
  type RuntimeLivenessProjection,
  type RuntimeTaskSnapshotInput,
} from '../../packages/ui/projection/runtime.js';

const runtimeApiModuleUrl = new URL('../../../../docs/ui/runtime-api.js', import.meta.url).href;

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

test('runtime API maps every real task state to its declared chip tone', async () => {
  const { stateTone } = await import(runtimeApiModuleUrl);
  const expectedTones = {
    running: 'active',
    settling: 'active',
    created: 'blue',
    admitted: 'blue',
    waiting: 'blue',
    blocked: 'warning',
    failed: 'danger',
    succeeded: 'success',
    stopped: 'success',
    cancelled: 'gray',
    unknown: 'gray',
    stale: 'gray',
    unavailable: 'gray',
  };
  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedTones).map((state) => [state, stateTone(state)])),
    expectedTones,
  );
  assert.equal(stateTone('mystery-state'), 'gray');
});

test('the browser runtime API keeps the bounded original cause chain', async () => {
  const { RuntimeApiError } = await import(runtimeApiModuleUrl);
  const error = new RuntimeApiError({
    code: 'ui-runtime.unexpected',
    ownerId: 'humanagent.app',
    message: 'implicit executor failed and settlement also failed: settle timed out',
    nextAction: 'inspect the runtime error and retry from a new operation',
    cause: {
      name: 'Error',
      message: 'executor could not reach its provider',
      cause: { name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:4444' },
    },
  }, 500);
  // The typed surface the human already sees must not regress.
  assert.equal(error.code, 'ui-runtime.unexpected');
  assert.equal(error.ownerId, 'humanagent.app');
  assert.equal(/settlement also failed/.test(error.message), true, `expected the settlement failure in ${error.message}`);
  assert.equal(error.nextAction, 'inspect the runtime error and retry from a new operation');
  assert.equal(error.status, 500);
  // The original executor failure survives instead of being collapsed to a
  // status code, so the page can name the real cause.
  const cause = (error as unknown as {
    readonly cause?: { readonly message: string; readonly cause?: { readonly message: string } };
  }).cause;
  assert.equal(cause?.message, 'executor could not reach its provider');
  assert.equal(cause?.cause?.message, 'connect ECONNREFUSED 127.0.0.1:4444');
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

// ── Real liveness truth (task-6) ────────────────────────────────────────────
// The work card must distinguish "still working" from "nothing is happening".
// Every state below is derived from facts the runtime actually reported: the
// task lifecycle and the newest real activity timestamp. A state with no real
// producer surfaces as `unknown`, never as a claim.
//
// The event-transport fact is deliberately NOT part of this projection: the
// only observer that can read a transport loss is the page holding the stream,
// and a server-derived value is unfetchable exactly when the transport is down.
// The transport fact therefore lives on the card's own `cardMetadata.transport`,
// fed by the page's real EventSource.

const SILENCE_BUDGET_MS = 30_000;

function livenessTask(
  state: RuntimeTaskSnapshotInput['state'],
  liveness: RuntimeLivenessInput | undefined,
  overrides: Partial<RuntimeTaskSnapshotInput> = {},
): RuntimeTaskSnapshotInput {
  return {
    taskId: id('task', 'task-liveness'),
    title: 'liveness task',
    state,
    currentState: state,
    nextStep: 'next',
    updatedAt: '2026-10-06T12:00:00.000Z',
    input: '',
    output: '',
    currentNode: 'provider.turn',
    allowedActions: [],
    recentEvents: [],
    ...(liveness === undefined ? {} : { liveness }),
    ...overrides,
  };
}

function livenessFacts(overrides: Partial<RuntimeLivenessInput> = {}): RuntimeLivenessInput {
  return {
    active: true,
    lastActivityAt: '2026-10-06T12:00:00.000Z',
    silenceBudgetMs: SILENCE_BUDGET_MS,
    observedAt: '2026-10-06T12:00:05.000Z',
    ...overrides,
  };
}

function livenessOf(task: RuntimeTaskSnapshotInput): RuntimeLivenessProjection {
  const liveness = projectRuntimeTaskDashboard(task, 'fake').liveness;
  if (!liveness) throw new Error('expected the runtime dashboard to carry a liveness projection');
  return liveness;
}

test('runtime dashboard reports working only from real recent activity', () => {
  const liveness = livenessOf(livenessTask('running', livenessFacts()));
  assert.equal(liveness.state, 'working');
  assert.equal(liveness.lastActivityAt, '2026-10-06T12:00:00.000Z');
  assert.equal(liveness.observedAt, '2026-10-06T12:00:05.000Z');
  assert.equal(liveness.silentForMs, 5_000);
  assert.equal(liveness.silenceBudgetMs, SILENCE_BUDGET_MS);
  assert.equal(/5000/.test(liveness.reason), true, liveness.reason);
  assert.equal(/30000/.test(liveness.reason), true, liveness.reason);
});

test('runtime liveness projection carries no transport state', () => {
  const liveness = livenessOf(livenessTask('running', livenessFacts()));
  assert.equal(Object.prototype.hasOwnProperty.call(liveness, 'transport'), false);
  assert.equal('transport' in liveness, false);
});

test('runtime dashboard reports no-activity only past the declared silence budget', () => {
  const stalled = livenessOf(livenessTask('running', livenessFacts({
    observedAt: '2026-10-06T12:00:40.000Z',
  })));
  assert.equal(stalled.state, 'no-activity');
  assert.equal(stalled.silentForMs, 40_000);
  assert.equal(stalled.silenceBudgetMs, SILENCE_BUDGET_MS);

  const atBudget = livenessOf(livenessTask('running', livenessFacts({
    observedAt: '2026-10-06T12:00:30.000Z',
  })));
  assert.equal(atBudget.state, 'no-activity');

  const justUnder = livenessOf(livenessTask('running', livenessFacts({
    observedAt: '2026-10-06T12:00:29.999Z',
  })));
  assert.equal(justUnder.state, 'working');
});

test('runtime dashboard returns to working when real activity resumes', () => {
  const stalled = livenessOf(livenessTask('running', livenessFacts({
    observedAt: '2026-10-06T12:00:40.000Z',
  })));
  assert.equal(stalled.state, 'no-activity');

  const recovered = livenessOf(livenessTask('running', livenessFacts({
    lastActivityAt: '2026-10-06T12:00:39.000Z',
    observedAt: '2026-10-06T12:00:40.000Z',
  })));
  assert.equal(recovered.state, 'working');
  assert.equal(recovered.silentForMs, 1_000);
});

test('runtime dashboard reports unknown instead of inventing progress without a real timestamp', () => {
  const liveness = livenessOf(livenessTask('running', {
    active: true,
    silenceBudgetMs: SILENCE_BUDGET_MS,
    observedAt: '2026-10-06T12:10:00.000Z',
  }));
  assert.equal(liveness.state, 'unknown');
  assert.equal(liveness.lastActivityAt, undefined);
  assert.equal(liveness.silentForMs, undefined);
  assert.equal(/no real activity timestamp/.test(liveness.reason), true, liveness.reason);
});

test('runtime dashboard refuses to derive no-activity from an unusable silence budget', () => {
  const liveness = livenessOf(livenessTask('running', livenessFacts({
    silenceBudgetMs: 0,
    observedAt: '2026-10-06T12:10:00.000Z',
  })));
  assert.equal(liveness.state, 'unknown');
  assert.equal(/silence budget/.test(liveness.reason), true, liveness.reason);
});

test('runtime dashboard keeps failure and waiting-for-answer as explicit liveness states', () => {
  const failed = livenessOf(livenessTask('failed', livenessFacts({
    active: false,
    observedAt: '2026-10-06T12:00:10.000Z',
  }), {
    error: {
      code: 'provider.transport.failure',
      message: 'transport failed',
      ownerId: 'humanagent.provider-adapter',
      retryable: false,
      nextAction: 'retry',
    },
  }));
  assert.equal(failed.state, 'failed');

  const waiting = livenessOf(livenessTask('waiting', livenessFacts({ active: false })));
  assert.equal(waiting.state, 'waiting-for-answer');

  const blocked = livenessOf(livenessTask('blocked', livenessFacts({ active: false })));
  assert.equal(blocked.state, 'waiting-for-answer');
});

test('runtime dashboard reports idle instead of a liveness claim when nothing is executing', () => {
  const settled = livenessOf(livenessTask('succeeded', livenessFacts({
    active: false,
    observedAt: '2026-10-06T12:01:00.000Z',
  })));
  assert.equal(settled.state, 'idle');

  const unknownState = livenessOf(livenessTask('unknown', livenessFacts({ active: false })));
  assert.equal(unknownState.state, 'unknown');
});

test('runtime dashboard omits liveness when the runtime reported no real facts', () => {
  const dashboard = projectRuntimeTaskDashboard(livenessTask('running', undefined), 'fake');
  assert.equal(dashboard.liveness, undefined);
});

