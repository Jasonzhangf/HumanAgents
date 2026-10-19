import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type TaskAgentActivityOwnershipRecord,
  type TaskAgentActivitySelectionOutcome,
  type TaskExecutionInstanceIdentity,
  type TaskId,
} from '@humanagent/contracts';
import {
  projectPipelineObservation,
  projectRuntimeAgentActivity,
  type ObservationScopeSource,
  type ObservationNodeSource,
  type ObservationAgentFrameSource,
  type ObservationHandoffSource,
} from '../../packages/ui/projection/index.js';
import { UiProjectionError, type UiDataSource } from '../../packages/ui/contracts/models.js';
import {
  RuntimeProjectionError,
  type RuntimeReadScope,
  type RuntimeTaskRowProjection,
} from '../../packages/ui/contracts/runtime.js';
import {
  projectRuntimeBusinessCycle,
  projectRuntimeBusinessCycles,
  projectRuntimeDashboard,
  projectRuntimeInspectionComparison,
  projectRuntimeInspectionOccurrence,
  projectRuntimeInspectionOccurrences,
  projectRuntimeMilestoneReviews,
  projectRuntimeTaskDashboard,
  projectRuntimeTaskWaitingStatus,
  projectRuntimeTaskList,
  type RuntimeBusinessCycleProjection,
  type RuntimeInspectionItemComparisonProjection,
  type RuntimeInspectionOccurrenceProjection,
  type RuntimeLivenessInput,
  type RuntimeLivenessProjection,
  type RuntimeMilestoneReviewProjection,
  type RuntimeTaskSnapshotInput,
} from '../../packages/ui/projection/runtime.js';

const runtimeApiModuleUrl = new URL('../../../../docs/ui/runtime-api.js', import.meta.url).href;
const agentActivityModuleUrl = new URL('../../../../docs/ui/agent-activity.js', import.meta.url).href;

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

test('task waiting copy describes settlement without guessing activity from raw nodes', () => {
  const task: RuntimeTaskSnapshotInput = {
    ...runtimeTask('running', 1),
    state: 'settling',
    currentNode: 'provider.model',
  };
  assert.equal(projectRuntimeTaskWaitingStatus(task), '正在收拢执行结果，等待检查点提交');
  const unknownNodeTask = { ...task, currentNode: 'unknown.node' };
  assert.equal(projectRuntimeTaskWaitingStatus(unknownNodeTask),
    '正在收拢执行结果，等待检查点提交');
  assert.equal(projectRuntimeTaskWaitingStatus({ ...task, state: 'running' }), '正在等待执行结果');
  assert.equal(projectRuntimeTaskWaitingStatus({ ...task, state: 'created' }), '尚无执行等待信息');
  assert.equal(projectRuntimeTaskDashboard(task, 'fake').currentNode, 'provider.model');
});

test('a checkpoint confirms a record without declaring task or public result completion', () => {
  const task: RuntimeTaskSnapshotInput = {
    ...runtimeTask('stopped', 2),
    checkpoint: { checkpointId: 'cp-2', seq: 7, outcome: 'stopped', summary: '收拢记录' },
  };
  assert.equal(projectRuntimeTaskWaitingStatus({ ...task, checkpoint: undefined }),
    '停止或取消请求已受理；等待收拢完成');
  assert.equal(projectRuntimeTaskWaitingStatus(task), '已提交收拢记录');
  const dashboard = projectRuntimeTaskDashboard({ ...task, state: 'running' }, 'fake');
  assert.equal(dashboard.state, 'running');
  assert.equal(dashboard.publicOutput?.commits.length, 0);
  assert.deepEqual(dashboard.checkpoint, task.checkpoint);
});

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

type GroupedRuntimeTaskRow = RuntimeTaskRowProjection & {
  readonly semanticTitle?: string;
  readonly executionLineage?: {
    readonly parentTaskId: TaskId;
    readonly subscriptionId: string;
    readonly occurrenceId: string;
  };
  readonly controlTarget?: { readonly projectKey: string; readonly mode: 'fake' | 'rcc' };
  readonly executions?: readonly RuntimeTaskRowProjection[];
};

test('runtime task list groups only exact committed lineage under one visible work item', () => {
  const parentTaskId = id('task', 'task-lineage-parent');
  const childTaskId = id('task', 'task-lineage-child');
  const missingParentTaskId = id('task', 'task-lineage-missing-parent');
  const parent = {
    ...runtimeTask('running', 21),
    taskId: parentTaskId,
    title: '原始父任务全文',
    semanticTitle: '父任务语义标题',
    controlTarget: { projectKey: 'project-parent-scope', mode: 'fake' as const },
    output: 'parent progress',
  };
  const child = {
    ...runtimeTask('succeeded', 22),
    taskId: childTaskId,
    title: '独立子任务标题',
    semanticTitle: '子任务语义标题',
    executionLineage: {
      parentTaskId,
      subscriptionId: 'subscription-child-1',
      occurrenceId: 'occurrence-child-1',
    },
    controlTarget: { projectKey: 'project-child-scope', mode: 'rcc' as const },
    allowedActions: ['start', 'view-records'],
    output: 'child committed result',
    publicOutput: {
      state: 'committed' as const,
      commits: [{
        commitId: 'child-output-1', journalSeq: 1, recordDigest: 'child-digest-1', text: 'child committed result',
      }],
    },
    error: {
      code: 'child.retained', ownerId: 'runtime', message: 'retained child fact',
      retryable: false, nextAction: 'recover child',
    },
    checkpoint: { checkpointId: 'child-cp-1', seq: 3, outcome: 'succeeded', summary: 'child closed' },
  };
  const orphan = {
    ...runtimeTask('failed', 23),
    state: 'waiting' as const,
    taskId: id('task', 'task-lineage-orphan'),
    title: '无匹配父任务的历史子任务',
    executionLineage: {
      parentTaskId: missingParentTaskId,
      subscriptionId: 'subscription-orphan-1',
      occurrenceId: 'occurrence-orphan-1',
    },
    controlTarget: { projectKey: 'project-orphan-scope', mode: 'fake' as const },
    allowedActions: ['view-records'],
    output: 'orphan history remains readable',
  };
  const prefixDecoy = {
    ...runtimeTask('succeeded', 24),
    taskId: id('task', 'task-lineage-prefix-decoy'),
    title: '原始父任务全文 的另一个任务',
  };
  const tasks = [parent, child, orphan, prefixDecoy];

  const list = projectRuntimeTaskList({ mode: 'fake', tasks });

  assert.deepEqual(list.running.map((row) => row.taskId.value), ['task-lineage-parent']);
  assert.deepEqual(list.waiting.map((row) => row.taskId.value), ['task-lineage-orphan']);
  assert.deepEqual(list.completed.map((row) => row.taskId.value), ['task-lineage-prefix-decoy']);

  const parentRow = list.running[0] as GroupedRuntimeTaskRow;
  assert.equal(parentRow.semanticTitle, '父任务语义标题');
  assert.equal(parentRow.title, '原始父任务全文');
  assert.equal(parentRow.controlTarget?.projectKey, 'project-parent-scope');
  assert.equal(parentRow.executions?.length, 1);
  const childRow = parentRow.executions?.[0] as GroupedRuntimeTaskRow;
  assert.equal(childRow.taskId.value, 'task-lineage-child');
  assert.equal(childRow.controlTarget?.projectKey, 'project-child-scope');
  assert.equal(childRow.controlTarget?.mode, 'rcc');
  assert.deepEqual(childRow.executionLineage, child.executionLineage);
  assert.deepEqual(childRow.allowedActions, ['start', 'view-records']);
  assert.equal(childRow.output, 'child committed result');
  assert.equal(childRow.publicOutput?.commits[0]?.text, 'child committed result');
  assert.equal(childRow.error?.code, 'child.retained');
  assert.equal(childRow.checkpoint?.checkpointId, 'child-cp-1');

  assert.equal(list.waiting[0]?.controlTarget?.projectKey, 'project-orphan-scope');
  assert.equal(list.waiting[0]?.output, 'orphan history remains readable');
  assert.deepEqual(list.counts, {
    running: 1, waiting: 1, completed: 1, stopped: 0, draft: 0, failed: 0, total: 3,
  });
  assert.equal(tasks.length, 4);
  assert.deepEqual(child.executionLineage, {
    parentTaskId,
    subscriptionId: 'subscription-child-1',
    occurrenceId: 'occurrence-child-1',
  });
});

test('runtime task rows retain existing terminal actions and result facts', () => {
  const completed = {
    ...runtimeTask('succeeded', 9),
    currentState: '已完成',
    nextStep: '查看任务详情',
    allowedActions: ['start'],
    output: 'committed result',
    publicOutput: {
      state: 'committed',
      commits: [{ commitId: 'out-1', journalSeq: 1, recordDigest: 'digest-1', text: 'committed result' }],
    },
    error: {
      code: 'retained.failure', ownerId: 'runtime', message: 'retained',
      retryable: false, nextAction: 'recover',
    },
    checkpoint: { checkpointId: 'cp-9', seq: 9, outcome: 'succeeded', summary: 'closed' },
  } satisfies RuntimeTaskSnapshotInput;
  const row = projectRuntimeTaskList({ mode: 'fake', tasks: [completed] }).completed[0];
  assert.deepEqual(row.allowedActions, ['start']);
  assert.equal(row.output, 'committed result');
  assert.equal(row.publicOutput?.commits[0]?.text, 'committed result');
  assert.equal(row.error?.code, 'retained.failure');
  assert.equal(row.checkpoint?.checkpointId, 'cp-9');
  assert.equal(row.nextStep, '查看任务详情');
});

test('task waiting copy describes settlement without guessing activity from raw nodes', () => {
  const task: RuntimeTaskSnapshotInput = {
    ...runtimeTask('running', 1),
    state: 'settling',
    currentNode: 'provider.model',
  };
  assert.equal(projectRuntimeTaskWaitingStatus(task), '正在收拢执行结果，等待检查点提交');
  const unknownNodeTask = { ...task, currentNode: 'unknown.node' };
  assert.equal(projectRuntimeTaskWaitingStatus(unknownNodeTask),
    '正在收拢执行结果，等待检查点提交');
  assert.equal(projectRuntimeTaskWaitingStatus({ ...task, state: 'running' }), '正在等待执行结果');
  assert.equal(projectRuntimeTaskWaitingStatus({ ...task, state: 'created' }), '尚无执行等待信息');
  assert.equal(projectRuntimeTaskDashboard(task, 'fake').currentNode, 'provider.model');
});

test('a checkpoint confirms a record without declaring task or public result completion', () => {
  const task: RuntimeTaskSnapshotInput = {
    ...runtimeTask('stopped', 2),
    checkpoint: {
      checkpointId: 'cp-2',
      seq: 7,
      outcome: 'stopped',
      summary: '收拢记录',
      committedAt: '2026-10-16T11:38:49.000Z',
    },
  };
  assert.equal(projectRuntimeTaskWaitingStatus({ ...task, checkpoint: undefined }),
    '停止或取消请求已受理；等待收拢完成');
  assert.equal(projectRuntimeTaskWaitingStatus(task), '已提交收拢记录');
  const dashboard = projectRuntimeTaskDashboard({ ...task, state: 'running' }, 'fake');
  assert.equal(dashboard.state, 'running');
  assert.deepEqual(dashboard.checkpoint, task.checkpoint);
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

test('runtime dashboard keeps failure explicit without inventing a human decision', () => {
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

  // Observed incident: lifecycle waiting/blocked rows were labeled as human
  // decisions although the projection received no question, options, or action.
  // That false claim could send the user looking for a decision that did not
  // exist. Reuse the existing liveness projection instead of adding a DTO.
  const waitingTask = livenessTask('waiting', livenessFacts({ active: false }));
  const waitingDashboard = projectRuntimeTaskDashboard(waitingTask, 'fake');
  assert.equal(waitingDashboard.stateLabel, '等待中');
  assert.equal(waitingDashboard.liveness?.state, 'idle');
  assert.equal(/decision/.test(waitingDashboard.liveness?.reason ?? ''), false);

  const blockedTask = livenessTask('blocked', livenessFacts({ active: false }));
  const blockedDashboard = projectRuntimeTaskDashboard(blockedTask, 'fake');
  assert.equal(blockedDashboard.stateLabel, '受阻');
  assert.equal(blockedDashboard.liveness?.state, 'idle');
  assert.equal(/decision/.test(blockedDashboard.liveness?.reason ?? ''), false);

  const dashboard = projectRuntimeDashboard({
    mode: 'fake',
    tasks: [waitingTask, blockedTask],
    recentInputs: [],
  });
  assert.equal('waitingDecisionCount' in dashboard, false);
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

// ── Agent activity UI projection (M4/F09 A3) ───────────────────────────────
// The projection consumes only the frozen `TaskAgentActivitySelectionOutcome`.
// These cases prove the frozen renderer can consume its output, that current
// and selected stay independent, and that unknown/unavailable/failure keep
// their real meaning. No case re-runs the runtime selector.

const agentTaskId = id('task', 'task-agent-activity');
const agentOrganId = id('organ', 'organ-agent-activity');

function agentEvidence(value: string): EvidenceRef {
  return {
    evidenceId: id('evidence', value),
    kind: 'execution',
    source: 'journal',
    locator: `journal://${value}`,
    digest: `digest-${value}`,
    scope: { organId: agentOrganId, taskId: agentTaskId },
  };
}

function incarnationInstance(input: {
  readonly runtimeId: string;
  readonly executionEpoch: number;
  readonly roleId: string;
  readonly generation: number;
  readonly agentInstanceId: string;
  readonly assignmentId: string;
}): TaskExecutionInstanceIdentity {
  return { kind: 'incarnation', incarnation: { ...input, taskId: agentTaskId } };
}

const agentCurrentRecord: TaskAgentActivityOwnershipRecord = {
  taskId: agentTaskId,
  instance: incarnationInstance({
    runtimeId: 'runtime-current',
    executionEpoch: 5,
    roleId: 'role-shared',
    generation: 2,
    agentInstanceId: 'agent-current',
    assignmentId: 'assignment-current',
  }),
  assignmentId: 'assignment-current',
  attempt: 3,
  executionEpoch: 5,
  objective: 'keep the current instance independent',
  businessTurnId: 'turn-current',
  segmentId: 'segment-current',
  nodeId: 'node-current',
  sourceKind: 'active-turn',
  currency: 'current',
  commitRefs: [{ commitId: 'commit-current', journalSeq: 11, recordDigest: 'digest-commit-current' }],
  evidenceRefs: [agentEvidence('evidence-current')],
};

const agentSelectedRecord: TaskAgentActivityOwnershipRecord = {
  taskId: agentTaskId,
  instance: incarnationInstance({
    runtimeId: 'runtime-selected',
    executionEpoch: 4,
    roleId: 'role-shared',
    generation: 1,
    agentInstanceId: 'agent-selected',
    assignmentId: 'assignment-selected',
  }),
  assignmentId: 'assignment-selected',
  attempt: 2,
  executionEpoch: 4,
  objective: 'keep the selected instance independent',
  businessTurnId: 'turn-selected',
  segmentId: 'segment-selected',
  nodeId: 'node-selected',
  sourceKind: 'resumed-segment',
  currency: 'historical',
  commitRefs: [{ commitId: 'commit-selected', journalSeq: 9, recordDigest: 'digest-commit-selected' }],
  evidenceRefs: [agentEvidence('evidence-selected')],
};

const agentUnknownRecord: TaskAgentActivityOwnershipRecord = {
  taskId: agentTaskId,
  instance: { kind: 'native-execution', execution: { runtimeId: 'runtime-unknown', executionEpoch: 6 } },
  assignmentId: 'assignment-unknown',
  executionEpoch: 6,
  objective: 'unknown must stay unknown',
  sourceKind: 'native-allocation',
  currency: 'unknown',
  missingSource: 'no binding record for epoch 6',
  commitRefs: [],
  evidenceRefs: [agentEvidence('evidence-unknown')],
};

// The seventh source carries no authoritative Planner objective, so the record
// omits the key entirely and the projection must keep it absent.
const agentPlannerRecord: TaskAgentActivityOwnershipRecord = {
  taskId: agentTaskId,
  instance: incarnationInstance({
    runtimeId: 'runtime-planner',
    executionEpoch: 1,
    roleId: 'orchestration',
    generation: 1,
    agentInstanceId: 'agent-planner',
    assignmentId: 'planner:active-turn-ui-operation-1',
  }),
  assignmentId: 'planner:active-turn-ui-operation-1',
  executionEpoch: 1,
  businessTurnId: 'turn-planner',
  sourceKind: 'closed-turn-planner-call',
  currency: 'historical',
  commitRefs: [{ commitId: 'commit-planner', journalSeq: 21, recordDigest: 'digest-commit-planner' }],
  evidenceRefs: [agentEvidence('evidence-planner')],
};

const agentActivityScope: RuntimeReadScope = {
  kind: 'task', projectKey: 'project-agent-activity', mode: 'fake', taskId: agentTaskId,
};

type AgentActivityValue = Extract<TaskAgentActivitySelectionOutcome, { readonly ok: true }>['value'];

const agentCatalogValue: AgentActivityValue = {
  taskId: agentTaskId,
  mode: 'catalog',
  current: [agentCurrentRecord],
  historical: [agentSelectedRecord],
  unknown: [agentUnknownRecord],
  unavailableSources: [{
    sourceId: 'child-invocation:invocation-1',
    ownerId: 'humanagent.runtime.observation',
    message: 'child invocation has no managed instance binding',
  }],
};
const agentCatalogOutcome: TaskAgentActivitySelectionOutcome = { ok: true, value: agentCatalogValue };

const agentSelectedValue: AgentActivityValue = {
  taskId: agentTaskId,
  mode: 'selected',
  selectedInstance: agentSelectedRecord.instance,
  selected: [agentSelectedRecord],
  current: [agentCurrentRecord],
  historical: [],
  unknown: [],
  unavailableSources: [],
};
const agentSelectedOutcome: TaskAgentActivitySelectionOutcome = { ok: true, value: agentSelectedValue };

const agentPlannerValue: AgentActivityValue = {
  taskId: agentTaskId,
  mode: 'catalog',
  current: [],
  historical: [agentPlannerRecord],
  unknown: [],
  unavailableSources: [],
};
const agentPlannerOutcome: TaskAgentActivitySelectionOutcome = { ok: true, value: agentPlannerValue };

class AgentActivityPortElement {
  readonly children: AgentActivityPortElement[] = [];
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, Set<() => void>>();
  textContent: string;
  className: string;
  constructor(readonly tag: string, text?: string, className?: string) {
    this.textContent = text ?? '';
    this.className = className ?? '';
  }
  append(...children: AgentActivityPortElement[]): void {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  click(): void {
    for (const listener of this.listeners.get('click') ?? []) listener();
  }
}

const agentActivityElement = (tag: string, text?: string, className?: string) =>
  new AgentActivityPortElement(tag, text, className);

function agentActivityNodes(root: AgentActivityPortElement): AgentActivityPortElement[] {
  return [root, ...root.children.flatMap(agentActivityNodes)];
}

function agentActivityText(root: AgentActivityPortElement): string {
  return agentActivityNodes(root).map((node) => node.textContent).join('\n');
}

test('agent activity projection renders a native catalog through the real consumer', async () => {
  const result = projectRuntimeAgentActivity(agentCatalogOutcome, agentActivityScope);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.surface, 'runtime-agent-activity');
  assert.equal(result.value.mode, 'catalog');
  assert.deepEqual(result.value.scope, agentActivityScope);
  assert.equal(result.value.current.length, 1);
  assert.equal(result.value.historical.length, 1);
  assert.equal(result.value.unknown.length, 1);
  assert.equal(result.value.selected, undefined);
  assert.equal(result.value.current[0].instance.label, '运行实例');
  assert.equal(result.value.unknown[0].instance.label, '原生执行');
  assert.equal(result.value.unknown[0].attempt, undefined);
  assert.equal(result.value.current[0].attempt, 3);
  assert.deepEqual(result.value.unavailableSources, agentCatalogValue.unavailableSources);

  const { renderAgentActivity } = await import(agentActivityModuleUrl);
  const view = renderAgentActivity(result, { element: agentActivityElement });
  const rendered = agentActivityText(view.element);
  assert.equal(/keep the current instance independent/.test(rendered), true, rendered);
  assert.equal(/unknown must stay unknown/.test(rendered), true, rendered);
  assert.equal(/child invocation has no managed instance binding/.test(rendered), true, rendered);
  assert.equal(/原生执行/.test(rendered), true, rendered);
  assert.equal(/runtime-current|agent-current|role-shared|assignment-current|node-current/.test(rendered), false, rendered);
  view.dispose();
});

test('agent activity projection keeps current and selected independent with exact refs', () => {
  const result = projectRuntimeAgentActivity(agentSelectedOutcome, agentActivityScope);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value = result.value;
  assert.equal(value.mode, 'selected');
  assert.deepEqual(value.selectedInstance, {
    kind: 'incarnation',
    label: '运行实例',
    runtimeId: 'runtime-selected',
    executionEpoch: 4,
    roleId: 'role-shared',
    generation: 1,
    agentInstanceId: 'agent-selected',
  });
  assert.equal(value.selected?.length, 1);
  const selected = value.selected?.[0];
  if (selected === undefined) throw new Error('expected a selected entry');
  assert.equal(selected.instance.kind, 'incarnation');
  assert.equal(selected.instance.runtimeId, 'runtime-selected');
  assert.equal(
    selected.instance.kind === 'incarnation' ? selected.instance.agentInstanceId : undefined,
    'agent-selected',
  );
  assert.equal(selected.taskId, agentTaskId);
  assert.equal(selected.assignmentId, 'assignment-selected');
  assert.equal(selected.attempt, 2);
  assert.equal(selected.businessTurnId, 'turn-selected');
  assert.equal(selected.segmentId, 'segment-selected');
  assert.equal(selected.nodeId, 'node-selected');
  assert.equal(selected.currency, 'historical');
  assert.equal(selected.currencyLabel, '历史记录');
  assert.equal(selected.sourceKind, 'resumed-segment');
  assert.equal(selected.sourceKindLabel, '恢复回合分段');
  assert.deepEqual(selected.commitRefs, agentSelectedRecord.commitRefs);
  assert.deepEqual(selected.evidenceRefs, agentSelectedRecord.evidenceRefs);

  assert.equal(value.current.length, 1);
  assert.equal(value.current[0].instance.runtimeId, 'runtime-current');
  assert.equal(value.historical.length, 0);
  assert.equal(value.unknown.length, 0);
  assert.equal(selected === value.current[0], false);
  assert.equal(selected.instance === value.current[0].instance, false);
});

test('agent activity projection preserves unknown, unavailable and failure meaning', () => {
  const catalog = projectRuntimeAgentActivity(agentCatalogOutcome, agentActivityScope);
  assert.equal(catalog.ok, true);
  if (!catalog.ok) return;
  assert.deepEqual(catalog.value.current.map((entry) => entry.instance.runtimeId), ['runtime-current']);
  assert.deepEqual(catalog.value.unknown.map((entry) => entry.instance.runtimeId), ['runtime-unknown']);
  assert.equal(
    catalog.value.current.some((entry) => entry.instance.runtimeId === 'runtime-unknown'),
    false,
  );
  assert.equal(catalog.value.unknown[0].currency, 'unknown');
  assert.equal(catalog.value.unknown[0].currencyLabel, '当前归属未知');
  assert.equal(catalog.value.unknown[0].attempt, undefined);
  assert.equal(catalog.value.unknown[0].missingSource, 'no binding record for epoch 6');
  assert.deepEqual(catalog.value.unavailableSources, agentCatalogValue.unavailableSources);

  const failure = projectRuntimeAgentActivity({
    ok: false,
    failure: {
      code: 'agent-activity.source-conflict',
      ownerId: 'humanagent.runtime.observation',
      message: 'record identity conflicts with the binding',
      nextAction: 'inspect the conflicting source before selecting an instance',
    },
  });
  assert.deepEqual(failure, {
    ok: false,
    failure: {
      code: 'agent-activity.source-conflict',
      ownerId: 'humanagent.runtime.observation',
      message: 'record identity conflicts with the binding',
      nextAction: 'inspect the conflicting source before selecting an instance',
    },
  });
});

test('agent activity projection renders a closed-turn planner call without a fabricated objective', async () => {
  const result = projectRuntimeAgentActivity(agentPlannerOutcome, agentActivityScope);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.mode, 'catalog');
  assert.equal(result.value.historical.length, 1);
  assert.equal(result.value.current.length, 0);
  assert.equal(result.value.unknown.length, 0);

  const projected = result.value.historical[0];
  assert.equal(projected.sourceKind, 'closed-turn-planner-call');
  assert.equal(projected.sourceKindLabel, '回合收口规划');
  assert.equal(projected.currency, 'historical');
  assert.equal(projected.currencyLabel, '历史记录');
  assert.equal(projected.objective, undefined);
  assert.equal('objective' in projected, false);
  assert.equal(projected.assignmentId, 'planner:active-turn-ui-operation-1');
  assert.equal(projected.businessTurnId, 'turn-planner');
  assert.equal(projected.instance.runtimeId, 'runtime-planner');
  assert.equal(
    projected.instance.kind === 'incarnation' ? projected.instance.agentInstanceId : undefined,
    'agent-planner',
  );
  assert.deepEqual(projected.commitRefs, agentPlannerRecord.commitRefs);
  assert.deepEqual(projected.evidenceRefs, agentPlannerRecord.evidenceRefs);

  const { renderAgentActivity } = await import(agentActivityModuleUrl);
  const view = renderAgentActivity(result, { element: agentActivityElement });
  const rendered = agentActivityText(view.element);
  assert.equal(/回合收口规划/.test(rendered), true, rendered);
  assert.equal(/closed-turn-planner-call/.test(rendered), false, rendered);
  assert.equal(/undefined/.test(rendered), false, rendered);
  view.dispose();
});

test('I2 runtime projections preserve optional task read scope and reject mismatched taskId', () => {
  const taskId = id('task', 'i2-scope-task');
  const foreignTaskId = id('task', 'i2-scope-foreign-task');
  const taskScope = { organId: id('organ', 'i2-scope-organ'), taskId };
  const scope: RuntimeReadScope = {
    kind: 'task',
    projectKey: 'project-alpha',
    mode: 'fake',
    taskId,
  };
  const current = { state: 'known' as const, cycleId: 'cycle-1', planRevisionCommitRef: null };
  const commitRef = { commitId: 'commit-1', journalSeq: 1, recordDigest: 'digest-1' };
  const item: RuntimeInspectionItemComparisonProjection = {
    checkId: 'check-1',
    criterion: 'criterion-1',
    change: 'unchanged',
    before: {
      checkId: 'check-1', criterion: 'criterion-1', state: 'completed', outcome: 'completed',
      judgment: 'ok', reason: null, resultRef: 'result-1', completedAt: '2026-10-17T00:00:00.000Z', evidenceRefs: [],
    },
    after: {
      checkId: 'check-1', criterion: 'criterion-1', state: 'completed', outcome: 'completed',
      judgment: 'ok', reason: null, resultRef: 'result-2', completedAt: '2026-10-17T00:01:00.000Z', evidenceRefs: [],
    },
  };
  const occurrence: RuntimeInspectionOccurrenceProjection = {
    occurrenceId: 'occurrence-1', cycleId: 'cycle-1', executionEpoch: 1, definitionId: 'definition-1',
    definitionVersion: '1', definitionDigest: 'digest-definition-1', definitionCommitRef: commitRef,
    openingCommitRef: commitRef, settlementCommitRef: null, openedAt: '2026-10-17T00:00:00.000Z',
    settledAt: null, state: 'open', outcome: 'pending', outcomeReason: null, scheduleOccurrenceRef: null,
    items: [], evidenceRefs: [],
  };
  const review: RuntimeMilestoneReviewProjection = {
    milestoneId: 'milestone-1', cycleId: 'cycle-1', status: 'passed', reviewKind: 'quality', findings: [],
    outputText: 'passed', artifactRef: null, artifactDigest: null,
    reviewer: {
      runtimeId: 'runtime-1', generation: 1, agentInstanceId: 'agent-1', roleId: 'reviewer',
      assignmentId: 'assignment-1', executionEpoch: 1,
    },
    completedAt: '2026-10-17T00:02:00.000Z', reviewCommitRef: commitRef, planRevisionCommitRef: commitRef,
    alignment: 'aligned', alignmentCommitRef: commitRef, alignedPlanRevisionCommitRef: commitRef,
    checkpointCommitRef: commitRef, evidenceRefs: [],
  };
  const cycle: RuntimeBusinessCycleProjection = {
    cycleId: 'cycle-1', state: 'running', directiveRevision: 1, executionEpoch: 1,
    taskFlow: { kind: 'inspection', definitionVersion: 1 }, openedAt: '2026-10-17T00:00:00.000Z',
    openingReason: 'authorized start', openedCommitRef: commitRef, planRevisionCommitRef: commitRef,
    previousCycleCommitRef: null, scheduleOccurrenceRef: null, inspectionOccurrenceId: 'occurrence-1',
    progress: 'open', outcome: null, next: null, closedAt: null, closureCommitRef: null,
    checkpointCommitRef: null, inspectionSettlementCommitRef: null, reviews: [review], alignmentPending: 0,
  };
  const historyInput = { taskScope, current, viewed: null, occurrences: [occurrence] };
  const occurrenceEntryInput = { taskScope, current, viewed: null, occurrence };
  const reviewInput = { taskScope, current, reviews: [review] };
  const cycleHistoryInput = { taskScope, current, viewed: null, cycles: [cycle] };
  const cycleEntryInput = { taskScope, current, viewed: null, cycle };
  const comparisonInput = {
    taskScope, current, left: { occurrenceId: 'occurrence-1' }, right: { occurrenceId: 'occurrence-2' },
    comparable: true, reason: null,
    definition: { definitionId: 'definition-1', definitionVersion: '1' }, items: [item],
  };
  type OptionalTaskScope = { readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }> };
  const projectors = [
    (input: OptionalTaskScope) => projectRuntimeInspectionOccurrences({ ...historyInput, ...input }),
    (input: OptionalTaskScope) => projectRuntimeInspectionOccurrence({ ...occurrenceEntryInput, ...input }),
    (input: OptionalTaskScope) => projectRuntimeMilestoneReviews({ ...reviewInput, ...input }),
    (input: OptionalTaskScope) => projectRuntimeBusinessCycles({ ...cycleHistoryInput, ...input }),
    (input: OptionalTaskScope) => projectRuntimeBusinessCycle({ ...cycleEntryInput, ...input }),
    (input: OptionalTaskScope) => projectRuntimeInspectionComparison({ ...comparisonInput, ...input }),
  ] as const;
  for (const projector of projectors) {
    assert.equal('scope' in projector({}), false);
    assert.deepEqual((projector({ scope }) as { readonly scope?: unknown }).scope, scope);
  }
  const mismatchedScope = { ...scope, taskId: foreignTaskId };
  for (const projector of projectors) {
    assert.throws(
      () => projector({ scope: mismatchedScope }),
      RuntimeProjectionError,
    );
  }
});
