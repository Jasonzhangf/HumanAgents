import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UiCommandError, validateUiCommand, assertObservationReadOnly, type PipelineObservationCommand, type UiCommand } from '../../packages/ui/contracts/commands.js';
import { UiProjectionError } from '../../packages/ui/contracts/models.js';
import {
  enterObservationScope,
  openObservationDrawer,
  projectDashboard,
  projectMemoryInteraction,
  projectPipelineObservation,
  projectTaskDashboard,
  projectTaskDetail,
  projectTaskList,
  returnObservationScope,
  type ObservationScopeSource,
  type TaskSource,
  type AgentCardSource,
  type AgentFeedbackSource,
  type AgentRuntimePoolSource,
  type AssignmentSource,
  type MemoryEntrySource,
  type SkillCandidateSource,
} from '../../packages/ui/projection/index.js';
import {
  id,
  type EvidenceRef,
  type Task,
  type TaskOutput,
} from '@humanagent/contracts';

const organ = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const evidence = (name: string): EvidenceRef => ({
  evidenceId: id('evidence', name),
  kind: 'operation',
  source: 'test',
  locator: `evidence:${name}`,
  scope: { organId: organ, taskId },
});

const task = (overrides: Partial<Task> = {}): Task => ({
  id: taskId,
  organId: organ,
  title: '整理周报证据',
  directive: '补齐证据，不发布',
  directiveRevision: 1,
  state: 'waiting',
  memoryScope: 'task',
  ...overrides,
});

const output: TaskOutput = {
  taskId,
  state: 'partial',
  summary: '证据草稿可审阅，发布范围未确认',
  result: { ready: true },
  artifactRefs: ['artifact://evidence-draft'],
  evidenceRefs: [evidence('ev-output')],
};

const taskSource = (overrides: Partial<TaskSource> = {}): TaskSource => ({
  task: task(),
  summary: '已收集变更与验证结果',
  currentWork: '等待你的选择',
  nextStep: '进入处理',
  updatedAt: 'PT4M',
  evidenceCount: 3,
  ...overrides,
});

const readySource = { state: 'ready' as const, label: '已连接' };
const disconnectedSource = { state: 'disconnected' as const, label: '已断开', detail: 'projection unavailable' };
const errorSource = { state: 'error' as const, label: '投影失败', detail: 'projection validation failed' };

test('dashboard projection keeps concise status entry points', () => {
  const projection = projectDashboard({
    source: readySource,
    pending: [{
      task: task(),
      situation: '已收集本周变更，待补齐 3 条验证结果',
      proposal: '补齐证据，不发布',
      options: ['按建议执行', '调整目标', '另建任务', '只查看', '自定义'],
      updatedAt: 'PT4M',
    }],
    running: [taskSource({ task: task({ state: 'running', title: '重建导出索引' }), summary: '已检查目录，正在重建分片' })],
    recentInputs: [{ source: 'human', text: '先把周报证据补齐', receivedAt: 'PT4M', status: '已整理成待处理事项' }],
    history: [taskSource({ task: task({ state: 'succeeded', title: '发布月报' }), summary: '输出已交付' })],
  });
  assert.deepEqual(projection.surface, 'dashboard');
  assert.deepEqual(projection.state, 'running');
  assert.deepEqual(projection.summary, { pending: 1, running: 1, recentInputs: 1, history: 1 });
  assert.deepEqual(projection.pendingItems[0].proposal, '补齐证据，不发布');
  assert.deepEqual(projection.runningItems[0].taskId.value, 'task-a');
  assert.deepEqual(projection.recentInputs[0].sourceLabel, '来自你');
  assert.deepEqual(projection.historyItems[0].title, '发布月报');
  assert.deepEqual(projection.runningItems[0].entry, 'task-dashboard');
});

test('task list keeps running, decisions, and history separate', () => {
  const projection = projectTaskList({
    source: readySource,
    current: [taskSource({ task: task({ state: 'running', title: '重建导出索引' }) })],
    decisions: [{
      task: task(),
      situation: '需要补齐验证结果',
      proposal: '补齐证据，不发布',
      options: ['按建议执行', '只查看'],
    }],
    history: [taskSource({ task: task({ state: 'stopped', title: '迁移旧会话' }), summary: '停止收拢完成' })],
  });
  assert.deepEqual(projection.surface, 'task-list');
  assert.deepEqual(projection.counts, { current: 1, decisions: 1, history: 1 });
  assert.deepEqual(projection.decisions[0].entry, 'task-detail');
  assert.deepEqual(projection.history[0].stateLabel, '已停止');
});

test('task detail projection exposes only required user decisions', () => {
  const projection = projectTaskDetail({
    source: readySource,
    task: task(),
    currentState: '等待确认怎么处理',
    priorInput: '先补齐周报证据，不要发布',
    investigation: ['已找到当前任务', '周报草稿和 12 条证据可查'],
    proposal: '沿用当前任务，补齐证据，不发布',
    nextAction: '按建议继续后开始处理',
    requiredDecisions: ['按建议执行', '调整目标', '只查看状态'],
    customInputAllowed: true,
    output,
    observationRef: 'task://task-a/observation',
  });
  assert.deepEqual(projection.surface, 'task-detail');
  assert.deepEqual(projection.title, '整理周报证据');
  assert.deepEqual(projection.requiredDecisions.length, 3);
  assert.deepEqual(projection.requiredDecisions[0].label, '按建议执行');
  assert.deepEqual(projection.observationRef, 'task://task-a/observation');
  assert.deepEqual(projection.output?.summary, '证据草稿可审阅，发布范围未确认');
  assert.deepEqual(projection.output?.artifacts[0], 'artifact://evidence-draft');
});

test('task dashboard maps agent roles without organ presentation language', () => {
  const cards: AgentCardSource[] = [
    {
      agentId: 'interaction-a',
      role: 'interaction',
      statusDisplay: '已整理',
      inputPreview: '重建导出索引，先检查现有分片',
      outputPreview: '目标明确，进入当前任务',
    },
    {
      agentId: 'worker-a',
      role: 'execution',
      statusDisplay: '运行中',
      inputPreview: '导出目录和第 2 个分片',
      outputPreview: '已完成 2/4 个分片',
    },
  ];
  const projection = projectTaskDashboard({
    source: readySource,
    task: task({ state: 'running', title: '重建导出索引' }),
    userInput: '重建导出索引，先检查现有分片',
    objective: '恢复完整索引并校验导出结果',
    currentStatus: '正在处理第 2/4 个分片',
    agentCards: cards,
    requiresUserHandling: true,
    userHandlingSummary: '需要确认受影响分片范围',
  });
  assert.deepEqual(projection.surface, 'task-dashboard');
  assert.deepEqual(projection.agentCards[0].roleDisplay, '交互');
  assert.deepEqual(projection.agentCards[1].roleDisplay, '执行');
  assert.deepEqual(projection.feedback.required, true);
  assert.deepEqual(projection.feedback.entry, 'task-detail');
  assert.deepEqual(projection.agentCards.some((card) => card.title.includes('器官')), false);
});

test('task dashboard projects execution steps, checkpoint, and stop/recovery evidence', () => {
  const projection = projectTaskDashboard({
    source: readySource,
    task: task({ state: 'settling', title: '检查配置问题' }),
    userInput: '检查当前项目中是否存在配置问题',
    objective: '读取配置并给出结论',
    currentStatus: '正在收拢执行证据',
    agentCards: [{
      agentId: 'dsh-execution',
      role: 'execution',
      statusDisplay: '收拢中',
      inputPreview: '检查配置问题',
      outputPreview: '准备写入 checkpoint',
    }],
    executionSteps: [
      { stepId: 'input-1', kind: 'input', summary: '用户输入', refs: ['humanagent://session/check/input/1'], evidenceRefs: [evidence('ev-input')] },
      { stepId: 'tool-call-1', kind: 'tool-call', summary: '读取配置文件', refs: ['CONFIG-PROBE.txt'], evidenceRefs: [evidence('ev-tool-call')] },
      { stepId: 'tool-result-1', kind: 'tool-result', summary: '配置项读取成功', refs: ['tool-result:read:1'], evidenceRefs: [evidence('ev-tool-result')] },
      { stepId: 'output-1', kind: 'output', summary: '阶段性结论', refs: ['humanagent://session/check/output/1'], evidenceRefs: [evidence('ev-output')] },
    ],
    checkpoint: { checkpointId: 'check-1-1', executionEpoch: 1, outcome: 'stopped', ref: 'humanagent://session/check/checkpoint/1' },
    stopRecovery: { mode: 'recovering', summary: '从 HumanAgent checkpoint 启动新 execution epoch', evidenceRefs: [evidence('ev-recovery')] },
    requiresUserHandling: false,
  });
  assert.deepEqual(projection.surface, 'task-dashboard');
  assert.deepEqual(projection.executionSteps.map((step) => step.kind), ['input', 'tool-call', 'tool-result', 'output']);
  assert.equal(projection.executionSteps[1].refs[0], 'CONFIG-PROBE.txt');
  assert.equal(projection.executionSteps[2].evidenceRefs[0].locator, 'evidence:ev-tool-result');
  assert.equal(projection.checkpoint?.checkpointId, 'check-1-1');
  assert.equal(projection.stopRecovery?.mode, 'recovering');
  assert.equal(projection.stopRecovery?.evidenceRefs[0].locator, 'evidence:ev-recovery');
});

test('task dashboard projects runtime pool, assignment graph, agent previews, and feedback', () => {
  const runtimePool: AgentRuntimePoolSource = {
    available: 1,
    active: 1,
    runtimes: [
      {
        runtimeId: 'runtime-worker-a',
        agentId: 'worker-a',
        role: 'execution',
        state: 'executing',
        currentAssignmentId: 'assignment-worker-a',
        executionEpoch: 2,
        resourceSummary: '1 个执行 lease',
        updatedAt: 'PT1M',
      },
      {
        runtimeId: 'runtime-review-a',
        role: 'review',
        state: 'idle',
        resourceSummary: '无活动 lease',
      },
    ],
  };
  const assignments: AssignmentSource[] = [
    {
      assignmentId: 'assignment-worker-a',
      pipelineNodeId: 'node.execute',
      agentId: 'worker-a',
      role: 'execution',
      status: 'running',
      attempt: 2,
      executionEpoch: 2,
      inputRevision: 7,
      objective: '补齐观测投影',
      targetRefs: ['packages/ui'],
      inputPreview: 'typed projection source',
      outputPreview: '已补 pool 和 graph',
      outputRefs: ['artifact://ui-projection'],
      evidenceRefs: [evidence('ev-assignment')],
      nextAction: 'continue',
      reviewRequired: true,
      mergeGate: 'required',
      updatedAt: 'PT1M',
    },
    {
      assignmentId: 'assignment-review-a',
      pipelineNodeId: 'node.review',
      agentId: 'reviewer-a',
      role: 'review',
      status: 'waiting',
      attempt: 1,
      executionEpoch: 2,
      inputRevision: 7,
      objective: '独立复核',
      inputPreview: '等待执行结果',
      outputPreview: '尚未开始',
      parentAssignmentId: 'assignment-worker-a',
      reviewRequired: false,
      mergeGate: 'required',
    },
  ];
  const agentFeedback: AgentFeedbackSource[] = [
    {
      feedbackId: 'feedback-review',
      kind: 'review',
      state: 'open',
      severity: 'attention',
      summary: 'review 发现 1 个 blocker',
      ownerId: 'review-coordinator',
      nextAction: 'remediate',
      assignmentId: 'assignment-worker-a',
      evidenceRefs: [evidence('ev-review-feedback')],
      requiresUser: true,
    },
    {
      feedbackId: 'feedback-memory',
      kind: 'memory',
      state: 'resolved',
      summary: '记忆候选等待独立 review',
      ownerId: 'memory-owner',
      nextAction: 'review',
      assignmentId: 'assignment-worker-a',
      evidenceRefs: [evidence('ev-memory-feedback')],
      requiresUser: false,
    },
  ];

  const projection = projectTaskDashboard({
    source: readySource,
    task: task({ state: 'running', title: '补齐 M3 观测' }),
    userInput: '补齐 M3 观测投影',
    objective: '让 pool、assignment 和反馈可观测',
    currentStatus: '执行 agent 正在补齐投影',
    agentCards: [{
      agentId: 'worker-a',
      role: 'execution',
      statusDisplay: '执行中',
      current: '补齐 Assignment projection',
      past: '已读取现有 typed source',
      next: '等待 review',
      needsUser: true,
      needsUserSummary: 'review blocker 需要处理',
      inputPreview: 'typed projection source',
      outputPreview: '已补 pool 和 graph',
      processRef: 'task://task-a/observation/node.execute',
    }],
    runtimePool,
    assignments,
    agentFeedback,
    reconcile: {
      state: 'reconciling',
      summary: '正在核对未知 operation 的副作用',
      ownerId: 'operation-owner',
      operationRef: 'operation://unknown-1',
      nextAction: 'wait-for-reconcile',
      evidenceRefs: [evidence('ev-reconcile')],
    },
    requiresUserHandling: false,
  });

  assert.equal(projection.runtimePool.available, 1);
  assert.equal(projection.runtimePool.active, 1);
  assert.equal(projection.runtimePool.runtimes[0].stateDisplay, '执行中');
  assert.equal(projection.runtimePool.runtimes[1].stateDisplay, '空闲');
  assert.equal(projection.assignments.length, 2);
  assert.equal(projection.assignments[0].statusDisplay, '执行中');
  assert.equal(projection.assignments[0].inputPreview, 'typed projection source');
  assert.equal(projection.assignments[0].outputPreview, '已补 pool 和 graph');
  assert.equal(projection.assignments[1].parentAssignmentId, 'assignment-worker-a');
  assert.equal(projection.assignments[0].evidenceRefs[0].locator, 'evidence:ev-assignment');
  assert.equal(projection.agentFeedback[0].kind, 'review');
  assert.equal(projection.agentFeedback[0].stateDisplay, '待处理');
  assert.equal(projection.agentFeedback[1].kind, 'memory');
  assert.equal(projection.feedback.required, true);
  assert.equal(projection.feedback.summary, 'review 发现 1 个 blocker');
  assert.equal(projection.reconcile?.stateDisplay, '核对中');
  assert.equal(projection.reconcile?.ownerId, 'operation-owner');
  assert.equal(projection.agentCards[0].current, '补齐 Assignment projection');
  assert.equal(projection.agentCards[0].past, '已读取现有 typed source');
  assert.equal(projection.agentCards[0].next, '等待 review');
  assert.equal(projection.agentCards[0].needsUser, true);
  assert.equal(projection.agentCards[0].needsUserSummary, 'review blocker 需要处理');
});

test('task dashboard keeps stale, blocked, and reconcile states visible without raw control leakage', () => {
  const projection = projectTaskDashboard({
    source: { ...readySource, state: 'stale' },
    task: task({ state: 'stale', title: '旧执行结果' }),
    userInput: '检查旧执行结果',
    objective: '展示 stale 与 blocked',
    currentStatus: '旧 execution epoch 结果已拒绝',
    agentCards: [],
    runtimePool: {
      available: 0,
      active: 0,
      runtimes: [{
        runtimeId: 'runtime-old',
        role: 'execution',
        state: 'failed',
        executionEpoch: 1,
        resourceSummary: 'lease 已释放',
      }],
    },
    assignments: [{
      assignmentId: 'assignment-old',
      pipelineNodeId: 'node.execute',
      agentId: 'worker-old',
      role: 'execution',
      status: 'stale',
      attempt: 1,
      executionEpoch: 1,
      inputRevision: 3,
      objective: '旧 assignment',
      inputPreview: '旧输入',
      outputPreview: '结果已过期',
      nextAction: 'wait',
    }, {
      assignmentId: 'assignment-blocked',
      pipelineNodeId: 'node.blocked',
      agentId: 'worker-blocked',
      role: 'execution',
      status: 'blocked',
      attempt: 1,
      executionEpoch: 2,
      inputRevision: 4,
      objective: '等待资源',
      inputPreview: '等待资源 lease',
      outputPreview: '尚未执行',
      conditionRef: 'resource.capacity',
      nextAction: 'wait',
    }],
    agentFeedback: [{
      feedbackId: 'feedback-resource',
      kind: 'resource',
      state: 'blocked',
      severity: 'blocker',
      summary: '资源不足',
      ownerId: 'resource-owner',
      nextAction: 'wait',
      conditionRef: 'resource.capacity',
      requiresUser: false,
    }, {
      feedbackId: 'feedback-reconcile',
      kind: 'reconcile',
      state: 'recovering',
      summary: '未知 operation 正在核对',
      ownerId: 'operation-owner',
      nextAction: 'reconcile',
      requiresUser: false,
    }],
    reconcile: {
      state: 'blocked',
      summary: 'reconcile 被资源阻塞',
      ownerId: 'operation-owner',
      operationRef: 'operation://unknown-2',
      nextAction: 'wait-for-resource',
    },
    requiresUserHandling: false,
  });

  assert.equal(projection.state, 'stale');
  assert.equal(projection.assignments[0].statusDisplay, '已过期');
  assert.equal(projection.assignments[1].statusDisplay, '受阻');
  assert.equal(projection.agentFeedback[0].stateDisplay, '受阻');
  assert.equal(projection.agentFeedback[1].stateDisplay, '恢复中');
  assert.equal(projection.reconcile?.stateDisplay, '核对受阻');
  assert.equal(projection.reconcile?.nextAction, 'wait-for-resource');
  assert.equal('retry' in projection, false);
  assert.equal('steer' in projection, false);
  assert.equal(JSON.stringify(projection).includes('"executionEpoch"'), true);
  assert.equal(JSON.stringify(projection).includes('"steer"'), false);
  assert.equal(JSON.stringify(projection).includes('"retry"'), false);
});

test('UI projection code does not read Journal or DSH session logs', async () => {
  const source = await readFile(join(process.cwd(), 'packages', 'ui', 'projection', 'index.ts'), 'utf8');
  assert.equal(/\bJsonlOrganJournal\b|DSH Session|DSH\s+Session\s+Log|sessionLog/i.test(source), false);
});

test('UI projection stays a typed read-only adapter and hides internal presentation language', async () => {
  const source = await readFile(join(process.cwd(), 'packages', 'ui', 'projection', 'index.ts'), 'utf8');
  assert.equal(/from ['"][^'"]*\/runtime\//.test(source), false);
  assert.equal(/from ['"][^'"]*\/(?:adapters|jsonl|dsh)\//.test(source), false);
  assert.equal(/\b(?:AgentRuntime|RuntimeTaskCoordinator|JsonlOrganJournal)\b/.test(source), false);
  assert.equal(source.includes('器官'), false);
  assert.equal(source.includes('大脑'), false);
});

test('observation projection supports recursion, drawer details, return, and read-only rules', () => {
  const scopes: Record<string, ObservationScopeSource> = {
    root: {
      scopeRef: 'root',
      title: '任务处理流水',
      summary: '从输入到任务结果的完整处理记录',
      projectionSeq: 'seq-184',
      agents: [{ agentId: '任务编排', role: 'orchestration', stateDisplay: '运行中', iteration: 1 }],
      nodes: [
        {
          nodeId: 'implicit.classify',
          title: '分类和安排任务',
          kind: 'orchestration',
          state: 'running',
          summary: '正在选择处理方式',
          owner: '任务编排',
          ownerAgentRole: 'orchestration',
          iteration: 1,
          inputRefs: ['requirement:184'],
          outputRefs: ['queue:execution'],
          evidenceRefs: [evidence('ev-classify')],
          childScopeRef: 'classify.children',
        },
      ],
    },
    'classify.children': {
      scopeRef: 'classify.children',
      title: '任务分类结果',
      summary: '当前项进入执行队列',
      projectionSeq: 'seq-185',
      agents: [{ agentId: '任务编排', role: 'orchestration', stateDisplay: '运行中', iteration: 1 }],
      nodes: [
        {
          nodeId: 'queue.execution',
          title: '执行队列',
          kind: 'execution',
          state: 'waiting',
          summary: '等待条件检查',
          owner: '任务编排',
          ownerAgentRole: 'orchestration',
          iteration: 1,
          activity: [{ activityRef: 'activity:queue-execution', summary: '执行队列等待条件检查' }],
          toolSteps: [{
            stepId: 'step-queue-1',
            name: 'humanagent.fake-provider',
            status: 'succeeded',
            returned: 'tool: fake://tool/queue-1',
          }],
          inputRefs: ['requirement:184'],
          outputRefs: [],
          evidenceRefs: [evidence('ev-queue')],
        },
      ],
    },
  };

  const root = projectPipelineObservation({
    source: readySource,
    scopes,
    scopeStack: ['root'],
  });
  assert.deepEqual(root.scope.canReturn, false);
  assert.deepEqual(root.scope.nodes[0].evidenceCount, 1);
  assert.deepEqual(root.rules.keyboardFocus, ['nodes are buttons', 'drawer focus moves to selected node', 'drawer close returns focus to trigger', 'breadcrumb return keeps the path visible']);
  assert.deepEqual(root.rules.narrowWidth, ['single-column layout', 'nodes before drawer', 'evidence previews first']);
  assert.equal(root.rules.readOnly, true);

  const enteredInput = enterObservationScope(rootInput(readySource, scopes, ['root']), 'classify.children');
  const entered = projectPipelineObservation(enteredInput);
  assert.deepEqual(entered.scope.scopeRef, 'classify.children');
  assert.deepEqual(entered.scope.canReturn, true);
  assert.deepEqual(entered.scope.breadcrumbs[0].title, '任务处理流水');
  assert.deepEqual(entered.scope.breadcrumbs[1].title, '任务分类结果');

  const withDrawer = projectPipelineObservation(openObservationDrawer(enteredInput, 'queue.execution'));
  assert.deepEqual(withDrawer.selectedNode?.title, '执行队列');
  assert.deepEqual(withDrawer.selectedNode?.kindDisplay, '执行');
  assert.deepEqual(withDrawer.selectedNode?.inputs[0].ref, 'requirement:184');
  assert.deepEqual(withDrawer.selectedNode?.evidenceRefs[0].locator, 'evidence:ev-queue');
  assert.deepEqual(withDrawer.selectedNode?.feedback, []);
  // The drawer panes read these typed fields; the detail projection must carry them from the same
  // source `toPipelineNode` reads, never a second conversion of its own.
  assert.deepEqual(withDrawer.selectedNode?.owner, '任务编排');
  assert.deepEqual(withDrawer.selectedNode?.ownerAgentRole, 'orchestration');
  assert.deepEqual(withDrawer.selectedNode?.roleDisplay, '任务编排');
  assert.deepEqual(withDrawer.selectedNode?.iteration, 1);
  assert.deepEqual(withDrawer.selectedNode?.activity, [{
    activityRef: 'activity:queue-execution',
    summary: '执行队列等待条件检查',
    occurredAt: undefined,
  }]);
  assert.deepEqual(withDrawer.selectedNode?.toolSteps, [{
    stepId: 'step-queue-1',
    name: 'humanagent.fake-provider',
    status: 'succeeded',
    statusDisplay: '已返回',
    returned: 'tool: fake://tool/queue-1',
    occurredAt: undefined,
  }]);

  const back = projectPipelineObservation(returnObservationScope(enteredInput));
  assert.deepEqual(back.scope.scopeRef, 'root');

  assert.throws(
    () => projectPipelineObservation({ source: readySource, scopes, scopeStack: ['missing'] }),
    UiProjectionError,
  );

  const disconnected = projectPipelineObservation({ source: disconnectedSource, scopes, scopeStack: ['root'] });
  assert.deepEqual(disconnected.state, 'disconnected');
  assert.deepEqual(disconnected.data.detail, 'projection unavailable');

  const failed = projectPipelineObservation({ source: errorSource, scopes, scopeStack: ['root'] });
  assert.deepEqual(failed.state, 'error');
  assert.deepEqual(failed.data.label, '投影失败');
  assert.deepEqual(failed.data.detail, 'projection validation failed');
});

test('observation drawer maps assignment, feedback, and reconcile while staying read-only', () => {
  const assignment: AssignmentSource = {
    assignmentId: 'assignment-observation',
    pipelineNodeId: 'node.execute',
    agentId: 'worker-a',
    role: 'execution',
    status: 'running',
    attempt: 1,
    executionEpoch: 2,
    inputRevision: 5,
    objective: '补齐 typed observation',
    inputPreview: 'typed source',
    outputPreview: 'drawer 已生成',
    outputRefs: ['artifact://observation'],
    evidenceRefs: [evidence('ev-observation-assignment')],
    reviewRequired: true,
    mergeGate: 'required',
  };
  const feedback: AgentFeedbackSource[] = [{
    feedbackId: 'feedback-observation',
    kind: 'attention',
    state: 'open',
    severity: 'attention',
    summary: '需要独立 review',
    ownerId: 'review-owner',
    nextAction: 'review',
    assignmentId: 'assignment-observation',
    evidenceRefs: [evidence('ev-observation-feedback')],
    requiresUser: true,
  }];
  const scopes: Record<string, ObservationScopeSource> = {
    root: {
      scopeRef: 'root',
      title: '任务处理流水',
      summary: '只读节点树',
      projectionSeq: 'seq-200',
      agents: [{ agentId: 'execution-owner', role: 'execution', stateDisplay: '执行中', iteration: 3 }],
      nodes: [{
        nodeId: 'node.execute',
        title: '执行',
        kind: 'execution',
        state: 'running',
        summary: '执行 assignment',
        owner: 'execution-owner',
        ownerAgentRole: 'execution',
        iteration: 3,
        inputRefs: ['assignment://assignment-observation/input'],
        outputRefs: ['artifact://observation'],
        evidenceRefs: [evidence('ev-observation-node')],
        assignment,
        feedback,
        reconcile: {
          state: 'required',
          summary: '需要核对未知 operation',
          ownerId: 'operation-owner',
          operationRef: 'operation://unknown-3',
          nextAction: 'reconcile',
          evidenceRefs: [evidence('ev-observation-reconcile')],
        },
      }],
    },
  };
  const projection = projectPipelineObservation(
    openObservationDrawer({ source: readySource, scopes, scopeStack: ['root'] }, 'node.execute'),
  );
  assert.equal(projection.rules.drawer, 'read-only-modal');
  assert.equal(projection.rules.readOnly, true);
  assert.equal(projection.selectedNode?.assignment?.assignmentId, 'assignment-observation');
  assert.equal(projection.selectedNode?.assignment?.inputPreview, 'typed source');
  assert.equal(projection.selectedNode?.assignment?.outputPreview, 'drawer 已生成');
  assert.equal(projection.selectedNode?.assignment?.evidenceRefs[0].locator, 'evidence:ev-observation-assignment');
  assert.equal(projection.selectedNode?.feedback[0].kind, 'attention');
  assert.equal(projection.selectedNode?.feedback[0].stateDisplay, '待处理');
  assert.equal(projection.selectedNode?.feedback[0].requiresUser, true);
  assert.equal(projection.selectedNode?.reconcile?.stateDisplay, '需要核对');
  assert.equal(projection.selectedNode?.reconcile?.operationRef, 'operation://unknown-3');
  assert.equal(JSON.stringify(projection).includes('"steer"'), false);
  assert.equal(JSON.stringify(projection).includes('"retry"'), false);
});

function rootInput(source: typeof readySource, scopes: Record<string, ObservationScopeSource>, stack: readonly string[]): Parameters<typeof projectPipelineObservation>[0] {
  return { source, scopes, scopeStack: stack };
}

test('observation node detail carries the typed tool steps and owner role the drawer panes read', () => {
  const scopes: Record<string, ObservationScopeSource> = {
    root: {
      scopeRef: 'root',
      title: '任务处理流水',
      summary: '两个节点：一个有工具调用，一个没有',
      projectionSeq: 'seq-186',
      agents: [{ agentId: '执行', role: 'execution', stateDisplay: '运行中', iteration: 2 }],
      nodes: [
        {
          nodeId: 'pipeline.execute',
          title: '执行流水线',
          kind: 'execution',
          state: 'running',
          summary: '正在调用 provider 工具',
          owner: '执行',
          ownerAgentRole: 'execution',
          inputRefs: [],
          outputRefs: [],
          evidenceRefs: [evidence('ev-execute-detail')],
          activity: [{ activityRef: 'activity:execute-1', summary: 'provider 工具调用已返回' }],
          toolSteps: [{
            stepId: 'step-execute-1',
            name: 'humanagent.fake-provider',
            status: 'succeeded',
            returned: 'tool: fake://tool/1',
          }],
        },
        {
          nodeId: 'sequential.queue',
          title: '串行队列',
          kind: 'orchestration',
          state: 'created',
          summary: '运行时尚未投影「串行队列」的事实。',
          owner: '执行',
          ownerAgentRole: 'execution',
          iteration: 2,
          inputRefs: [],
          outputRefs: [],
          evidenceRefs: [],
        },
      ],
    },
  };
  const input = rootInput(readySource, scopes, ['root']);

  const withTools = projectPipelineObservation(openObservationDrawer(input, 'pipeline.execute')).selectedNode;
  if (!withTools) throw new Error('expected pipeline.execute drawer detail');
  assert.equal(withTools.owner, '执行');
  assert.equal(withTools.ownerAgentRole, 'execution');
  assert.equal(withTools.roleDisplay, '执行');
  assert.equal(withTools.iteration, 2);
  assert.equal(withTools.activity.length, 1);
  assert.equal(withTools.activity[0]?.activityRef, 'activity:execute-1');
  assert.equal(withTools.toolSteps.length, 1);
  assert.equal(withTools.toolSteps[0]?.stepId, 'step-execute-1');
  assert.equal(withTools.toolSteps[0]?.name, 'humanagent.fake-provider');
  assert.equal(withTools.toolSteps[0]?.status, 'succeeded');
  assert.equal(withTools.toolSteps[0]?.statusDisplay, '已返回');
  assert.equal(withTools.toolSteps[0]?.returned, 'tool: fake://tool/1');

  // A node the runtime reports no tool call for keeps the explicit empty history: the drawer must
  // never fabricate a step to fill the pane.
  const withoutTools = projectPipelineObservation(openObservationDrawer(input, 'sequential.queue')).selectedNode;
  if (!withoutTools) throw new Error('expected sequential.queue drawer detail');
  assert.deepEqual(withoutTools.toolSteps, []);
  assert.deepEqual(withoutTools.activity, []);
  assert.equal(withoutTools.ownerAgentRole, 'execution');
});

test('memory interaction surface keeps candidates behind explicit review', () => {
  const candidate: SkillCandidateSource = {
    candidateId: 'skill-1',
    pattern: '导出目录权限变化',
    proposedRule: '覆盖范围变化需先复核受影响分片',
    uniqueness: 'variant',
    repeatability: 'observed',
    value: 'review',
    state: 'candidate',
    evidenceRefs: [evidence('ev-skill')],
    namespace: 'project',
    projectKey: 'project-a',
    taskId: 'task-a',
    sourceRefs: ['journal://task-a/seq-19'],
    sourceDigests: ['sha256:entry-1'],
  };
  const entry: MemoryEntrySource = {
    id: 'entry-1',
    sourceRef: 'journal://task-a/seq-19',
    scope: 'task-a',
    summary: '旧会话已有可恢复保存点',
    digest: 'sha256:entry-1',
    evidenceRefs: [evidence('ev-mem')],
  };
  const projection = projectMemoryInteraction({
    source: readySource,
    scope: 'task-a',
    summary: '当前任务记录可查询',
    indexState: 'ready',
    entries: [entry],
    skillCandidates: [candidate],
    inspectEnabled: true,
    compareEnabled: true,
    analysis: { mode: 'model', state: 'succeeded', operationRef: 'memory-analysis:task-a' },
    autoUpdate: false,
  });
  assert.deepEqual(projection.surface, 'memory-interaction');
  assert.deepEqual(projection.reviewRequired, true);
  assert.deepEqual(projection.skillCandidates[0].proposedRule, '覆盖范围变化需先复核受影响分片');
  assert.deepEqual(projection.indexState, 'ready');
  assert.deepEqual(projection.analysis, { mode: 'model', state: 'succeeded', operationRef: 'memory-analysis:task-a' });
  assert.equal(projection.autoUpdate, false);
  assert.deepEqual(projection.skillCandidates[0].sourceRefs, ['journal://task-a/seq-19']);
});

test('command validation keeps observation read-only and decisions on explicit interaction surfaces', () => {
  const observationCommand: PipelineObservationCommand = {
    commandId: 'cmd-1',
    surface: 'observation',
    kind: 'open-node-drawer',
    nodeId: 'queue.execution',
  };
  assert.doesNotThrow(() => validateUiCommand(observationCommand));
  assertObservationReadOnly(observationCommand);

  assert.throws(
    () => validateUiCommand({ commandId: 'bad-1', surface: 'observation', kind: 'review-skill', candidateId: 'skill-1', decision: 'approve' } as unknown as UiCommand),
    UiCommandError,
  );
  assert.throws(
    () => validateUiCommand({ commandId: 'bad-2', surface: 'task-dashboard', kind: 'submit-input', taskId, payload: { answer: 'ok' }, inputPreview: 'bad' } as unknown as UiCommand),
    UiCommandError,
  );
  assert.throws(
    () => validateUiCommand({ commandId: 'bad-3', surface: 'task-detail', kind: 'submit-input', taskId, payload: { answer: 'ok', steer: true }, inputPreview: 'bad' }),
    UiCommandError,
  );
  assert.doesNotThrow(
    () => validateUiCommand({ commandId: 'ok-1', surface: 'task-detail', kind: 'confirm-draft', draftId: 'draft-1', intent: 'append', taskId, normalizedInput: '补齐证据', confirmedBy: 'human', payloadRef: 'asset://req' }),
  );
  assert.doesNotThrow(
    () => validateUiCommand({ commandId: 'ok-2', surface: 'memory-interaction', kind: 'review-skill', candidateId: 'skill-1', decision: 'approve', decisionReason: '证据完整' }),
  );
});

test('runtime UI consumes typed API without hardcoded success or direct source access', async () => {
  const files = [
    'docs/ui/dashboard.js',
    'docs/ui/tasks.js',
    'docs/ui/task.js',
    'docs/ui/task-dashboard.js',
    'docs/ui/observation.js',
    'docs/ui/memory.js',
    'docs/ui/memory-actions.js',
    'docs/ui/runtime-api.js',
    'docs/ui/runtime-shell.js',
    'docs/ui/entry.js',
  ];
  const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.equal(source.includes('Journal'), false);
  assert.equal(source.includes('RCC raw'), false);
  assert.equal(source.includes('DSH Session'), false);
  assert.equal(source.includes('fake://output'), false);
  assert.equal(source.includes('重试 operation'), false);
  assert.equal(source.includes('steer'), false);
  assert.equal(source.includes('/api/runtime/status'), true);
  assert.equal(source.includes('createRuntimeApi'), true);
  assert.equal(source.includes('implicitScheduling'), true);
  assert.equal(source.includes('/api/memory/summary'), true);
  assert.equal(source.includes('/api/memory/review'), true);
});

test('semantic observation carries one complete scope through GET, SSE, and finite completion', async () => {
  const { createRuntimeApi } = await import(new URL(
    `file://${join(process.cwd(), 'docs/ui/runtime-api.js')}`,
  ).href) as {
    createRuntimeApi: (options: {
      fetchImpl: (url: string, init: unknown) => Promise<unknown>;
    }) => {
      semanticObservation: (taskId: string, scope?: Record<string, unknown>) => Promise<unknown>;
      semanticEventsUrl: (taskId: string, scope?: Record<string, unknown>) => string;
    };
  };

  const calls: string[] = [];
  const api = createRuntimeApi({
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const scope = {
    kind: 'task',
    projectKey: 'project-config-a',
    mode: 'rcc',
    taskId: { value: 'same-task' },
  };

  await api.semanticObservation('same-task', scope);
  const streamUrl = api.semanticEventsUrl('same-task', scope);
  await api.semanticObservation('legacy-task');
  const legacyStreamUrl = api.semanticEventsUrl('legacy-task');

  assert.equal(calls[0], '/api/tasks/same-task/semantic?projectKey=project-config-a&mode=rcc');
  assert.equal(
    streamUrl,
    '/api/tasks/same-task/semantic/stream?projectKey=project-config-a&mode=rcc',
  );
  assert.equal(calls.at(-1), '/api/tasks/legacy-task/semantic');
  assert.equal(legacyStreamUrl, '/api/tasks/legacy-task/semantic/stream');
});

test('observation API keeps subtree, node, agent, project, and mode in one read', async () => {
  const { createRuntimeApi } = await import(new URL(
    `file://${join(process.cwd(), 'docs/ui/runtime-api.js')}`,
  ).href) as {
    createRuntimeApi: (options: {
      fetchImpl: (url: string, init: unknown) => Promise<unknown>;
    }) => {
      observation: (
        taskId: string,
        scopeRef: string,
        selectedNodeId: string,
        agentQuery: URLSearchParams,
        taskScope: { kind: 'task'; projectKey: string; mode: 'rcc' },
      ) => Promise<unknown>;
    };
  };

  const calls: string[] = [];
  const api = createRuntimeApi({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  await api.observation(
    'same-task',
    'task://same-task/observation/pipeline.execute',
    'task.output',
    new URLSearchParams({ agentRuntimeId: 'runtime-a', agentExecutionEpoch: '2' }),
    { kind: 'task', projectKey: 'project-config-a', mode: 'rcc' },
  );

  const request = new URL(calls[0]!, 'http://ui.test');
  assert.equal(request.pathname, '/api/tasks/same-task/observation');
  assert.equal(request.searchParams.get('scope'), 'task://same-task/observation/pipeline.execute');
  assert.equal(request.searchParams.get('node'), 'task.output');
  assert.equal(request.searchParams.get('agentRuntimeId'), 'runtime-a');
  assert.equal(request.searchParams.get('agentExecutionEpoch'), '2');
  assert.equal(request.searchParams.get('projectKey'), 'project-config-a');
  assert.equal(request.searchParams.get('mode'), 'rcc');
});

test('semantic panel closes a finite stream without disconnecting or publishing stale events', async () => {
  class FakeElement {
    readonly nodeType = 1;
    className = '';
    textContent = '';
    readonly dataset: Record<string, string> = {};
    readonly children: FakeElement[] = [];
    private readonly attributes = new Map<string, string>();

    constructor(readonly tagName: string) {}

    get firstChild(): FakeElement | undefined { return this.children[0]; }
    get childElementCount(): number { return this.children.length; }
    append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
    replaceChildren(...nodes: FakeElement[]): void {
      this.children.length = 0;
      this.children.push(...nodes);
    }
    removeChild(node: FakeElement): void {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    getAttribute(name: string): string | undefined { return this.attributes.get(name); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    querySelector(): FakeElement | null { return null; }
    focus(): void {}
    close(): void {}
    showModal(): void {}
    contains(node: FakeElement): boolean {
      return this.children.some((child) => child === node || child.contains(node));
    }
  }

  class FakeEventSource {
    static readonly instances: FakeEventSource[] = [];
    readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
    closed = false;
    onopen?: () => void;
    onerror?: () => void;

    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: { data: string }) => void): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close(): void { this.closed = true; }

    emit(type: string, data: unknown = {}): void {
      const event = { data: JSON.stringify(data) };
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  const semanticEnvelope = (taskId: string, summary: string) => ({
    projectionVersion: 'semantic-observation@1',
    scope: { taskId: { scope: 'task', value: taskId } },
    events: [{
      eventId: `event-${taskId}`,
      type: 'semantic.test',
      status: 'completed',
      summary,
      scope: { taskId: { scope: 'task', value: taskId } },
      sourceId: `source-${taskId}`,
      evidenceRefs: [],
    }],
    pairing: [],
    coverageIssues: [],
    capabilities: [],
  });
  const scope = {
    kind: 'task',
    projectKey: 'project-config-a',
    mode: 'rcc',
    taskId: { value: 'same-task' },
  };
  const observedScopes: Array<Record<string, unknown> | undefined> = [];
  const apiClient = {
    semanticObservation: async (_taskId: string, receivedScope?: Record<string, unknown>) => {
      observedScopes.push(receivedScope);
      return semanticEnvelope('same-task', 'scope A committed output');
    },
    semanticEventsUrl: (_taskId: string, receivedScope?: Record<string, unknown>) => {
      observedScopes.push(receivedScope);
      return '/api/tasks/same-task/semantic/stream?projectKey=project-config-a&mode=rcc';
    },
  };
  const text = (node: FakeElement): string => node.textContent + node.children.map(text).join('');
  const globals = globalThis as unknown as {
    document?: unknown;
    HTMLElement?: unknown;
    EventSource?: unknown;
  };
  const previousDocument = globals.document;
  const previousHTMLElement = globals.HTMLElement;
  const previousEventSource = globals.EventSource;
  globals.document = {
    createElement: (tag: string) => new FakeElement(tag),
  };
  globals.HTMLElement = FakeElement;
  globals.EventSource = FakeEventSource;

  let panel: { dispose: () => void } | undefined;
  try {
    const { mountSemanticObservationPanel } = await import(new URL(
      `file://${join(process.cwd(), 'docs/ui/runtime-shell.js')}`,
    ).href) as {
      mountSemanticObservationPanel: (
        host: FakeElement,
        options: Record<string, unknown>,
      ) => { dispose: () => void };
    };
    const host = new FakeElement('div');
    panel = mountSemanticObservationPanel(host, {
      taskId: 'same-task',
      scope,
      apiClient,
    });
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    };
    await settle();

    assert.equal(observedScopes.length, 2);
    assert.deepEqual(observedScopes, [scope, scope]);
    const stream = FakeEventSource.instances.at(-1);
    if (!stream) throw new Error('semantic panel did not open its stream');

    stream.emit('semantic-complete');
    stream.emit('semantic.observation', semanticEnvelope('project-b', 'scope B committed output'));
    await settle();

    assert.equal(stream.closed, true);
    assert.equal(text(host).includes('scope A committed output'), true);
    assert.equal(text(host).includes('scope B committed output'), false);
    assert.equal(text(host).includes('实时连接已断开'), false);
  } finally {
    panel?.dispose();
    globals.document = previousDocument;
    globals.HTMLElement = previousHTMLElement;
    globals.EventSource = previousEventSource;
  }
});

test('task dashboard event rows do not render internal owner or next action details', async () => {
  const source = await readFile('docs/ui/task-dashboard.js', 'utf8');
  assert.equal(source.includes('event.nextAction'), false);
  assert.equal(source.includes("event.kind !== 'provider.model' || (event.summary && event.summary !== 'model')"), true);
  assert.equal(source.includes("'provider.tool-result'"), true);
  assert.equal(source.includes('historyChunks'), true);
  assert.equal(source.includes('olderEventCount'), true);
  assert.equal(source.includes('connectionState'), true);
});

test('task dashboard status copy keeps stopped conditional on a collected checkpoint', async () => {
  const source = await readFile('docs/ui/task-dashboard.js', 'utf8');
  assert.equal(source.includes("dashboard.state === 'stopped'"), true);
  assert.equal(source.includes('不能宣称已停止'), true);
  assert.equal(source.includes('statusSections.business'), true);
  assert.equal(source.includes('statusSections.waiting'), true);
  assert.equal(source.includes('连接新鲜度'), true);
  assert.equal(source.includes('historyPage'), true);
  assert.equal(source.includes('HISTORY_PAGE_SIZE'), true);
  assert.equal(source.includes("'更早'"), true);
  assert.equal(source.includes('本页之前还有'), false);
  assert.equal(source.includes('停止请求已受理'), true);
  assert.equal(source.includes("['succeeded', 'failed'].includes(dashboard.state)"), true);
});

test('dashboard submission never waits on a second confirmation', async () => {
  const source = await readFile('docs/ui/dashboard.js', 'utf8');
  // The new-task form submit is the only authorization point on this page, so
  // the second-confirmation wait that used to gate the draft here is deleted.
  // None of its copy and none of its direct confirmation call may come back.
  assert.equal(source.includes("progress.waiting('等待你确认任务草案'"), false);
  assert.equal(source.includes("progress.set('等待你确认任务草案'"), false);
  assert.equal(source.includes('await api.confirmExplicitRequirement(interaction.id'), false);
  assert.equal(source.includes("timer.hidden = true"), false);
  assert.equal(source.includes("root.dataset.tone = 'waiting'"), false);
});

test('memory review button exposes typed API failure and becomes usable again', async () => {
  const { bindMemoryReviewAction } = await import(new URL(`file://${join(process.cwd(), 'docs/ui/memory-actions.js')}`).href);
  let listener: (() => Promise<void>) | undefined;
  const button = {
    disabled: false,
    addEventListener(type: string, callback: () => Promise<void>) {
      assert.equal(type, 'click');
      listener = callback;
    },
  };
  let requested = false;
  let refreshed = false;
  let visibleError: unknown;
  bindMemoryReviewAction({
    button,
    candidateId: 'candidate-failure',
    decision: 'approve',
    readReason: () => 'evidence digest must be reviewed',
    review: async () => {
      requested = true;
      assert.equal(button.disabled, true);
      throw Object.assign(new Error('candidate evidence digest does not match'), {
        code: 'memory-review-unavailable',
        ownerId: 'memory-coordinator',
        nextAction: 'inspect the candidate evidence digest',
      });
    },
    refresh: async () => { refreshed = true; },
    showError: (error: unknown) => { visibleError = error; },
  });
  assert.ok(listener);
  await listener!();
  assert.equal(requested, true);
  assert.equal(refreshed, false);
  assert.equal(button.disabled, false);
  assert.deepEqual(visibleError, {
    code: 'memory-review-unavailable',
    message: 'candidate evidence digest does not match',
    ownerId: 'memory-coordinator',
    nextAction: 'inspect the candidate evidence digest',
  });
});

test('observation work-card adapter pairs tool calls with results and marks unprojected turns', async () => {
  const { projectObservationWorkCard } = await import(new URL(
    `file://${join(process.cwd(), 'docs/ui/interaction-work-card.js')}`,
  ).href);
  const projection = projectObservationWorkCard({
    node: {
      nodeId: 'pipeline.execute',
      title: '执行流水线',
      kindDisplay: '执行',
      stateDisplay: '运行中',
      owner: '执行',
      ownerAgentRole: 'execution',
      roleDisplay: '执行',
      iteration: 2,
      updatedAt: '2026-10-05T12:00:03Z',
      summary: '执行完成，taskId 技术标识已折叠',
      turnId: 'turn-provider-reported',
      activity: [{
        activityRef: 'activity:execute-1',
        summary: 'provider 工具调用已返回',
        occurredAt: '2026-10-05T12:00:00Z',
        turnId: 'turn-provider-reported',
      }],
      toolSteps: [
        {
          stepId: 'call-returned',
          name: 'read.file',
          status: 'succeeded',
          statusDisplay: '已返回',
          returned: 'status=succeeded · outputRef=asset://output',
          occurredAt: '2026-10-05T12:00:01Z',
          turnId: 'turn-provider-reported',
        },
        {
          stepId: 'call-unreturned',
          name: 'write.file',
          status: 'unknown',
          statusDisplay: '未知',
          returned: 'status=unknown · call=write.file',
          occurredAt: '2026-10-05T12:00:02Z',
        },
      ],
    },
  });

  assert.equal(projection.surface, 'interaction-work-card');
  assert.equal(projection.mode, 'observation');
  assert.deepEqual(projection.actions, []);
  assert.equal(projection.conversation.turns.length, 2);
  assert.equal(projection.conversation.turns[1].markdown, '该条目包含技术细节，完整内容在折叠详情中。');
  assert.deepEqual(projection.conversation.turns[1].details, [['节点结论原文', '执行完成，taskId 技术标识已折叠']]);
  const tools = projection.history.items.filter((item: { tool?: unknown }) => item.tool);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].tool.paired, true);
  assert.equal(tools[1].tool.paired, false);
  assert.equal(projection.history.items.some((item: { kind: string }) => item.kind === 'model-request'), true);
  assert.equal(projection.history.items.some((item: { kind: string }) => item.kind === 'conclusion'), true);
  // The real provider turn id the node reported reaches every entry whose
  // source carried it, and nothing is renamed to a synthesized turn key.
  assert.equal(projection.history.items.every((item: { turnKey?: string }) => item.turnKey === undefined), true);
  assert.equal(projection.history.items.filter((item: { turnId?: string }) => item.turnId === 'turn-provider-reported').length, 3);
  // The step whose source reported no turn has the explicit absent state.
  const unreturned = tools[1] as { turnId?: string };
  assert.equal(unreturned.turnId, undefined);
  assert.equal(projection.cardMetadata.source.turnId, 'turn-provider-reported');
});

test('UI index is the task input entry with explicit draft, confirmation gate, and runtime status', async () => {
  const html = await readFile('docs/ui/index.html', 'utf8');
  const entry = await readFile('docs/ui/entry.js', 'utf8');
  assert.equal(html.includes('HumanAgent · Task Input'), true);
  assert.equal(entry.includes('api.listTasks'), true);
  assert.equal(entry.includes('id = \'entry-confirm-button\''), false);
  assert.equal(entry.includes('确认并进入队列'), false);
  assert.equal(entry.includes('implicitScheduling'), true);
  assert.equal(entry.includes('taskDashboardHref'), true);
  assert.equal(html.includes('data-mode="running"'), false);
  assert.equal(html.includes('本地状态已同步'), false);
  assert.equal(html.includes('正在运行'), false);
  assert.equal(html.includes('checkpoint committed'), false);
  assert.equal(html.includes('id="entry-confirm-button"'), false);
  assert.equal(html.includes('data-region="confirmation"'), false);
});

test('explicit interaction UI uses typed brain routes and keeps control separate', async () => {
  const api = await readFile('docs/ui/runtime-api.js', 'utf8');
  const interaction = await readFile('docs/ui/interaction.js', 'utf8');
  const html = await readFile('docs/ui/interaction.html', 'utf8');
  for (const method of [
    'receiveExplicitInput',
    'inspectExplicitInteraction',
    'answerExplicitClarification',
    'beginExplicitMatching',
    'recordExplicitMatch',
    'proposeExplicitRequirement',
    'completeExplicitStatusQuery',
    'confirmExplicitRequirement',
    'dispatchNextExplicitRequirement',
  ]) assert.equal(api.includes(`${method}:`), true);
  assert.equal(api.includes("channel: 'business'"), true);
  assert.equal(interaction.includes('api.inspectExplicitInteraction'), true);
  assert.equal(interaction.includes('api.completeExplicitStatusQuery'), true);
  assert.equal(interaction.includes('api.confirmExplicitRequirement'), true);
  assert.equal(interaction.includes('api.dispatchNextExplicitRequirement'), true);
  assert.equal(interaction.includes('api.stop'), true);
  assert.equal(interaction.includes('api.startExecution'), true);
  assert.equal(interaction.includes('channel: \'control\''), false);
  assert.equal(interaction.includes('dataset.runtimeState'), false);
  assert.equal(interaction.includes('data-task-status'), false);
  assert.equal(interaction.includes("field(matchingForm, 'normalizedInput').value"), false);
  assert.equal(interaction.includes("field(inputForm, 'rawInput').value"), false);
  assert.equal(html.includes('data-explicit-confirmation'), true);
  assert.equal(html.includes('data-action="dispatch"'), true);
  assert.equal(html.includes('name="normalizedInput"'), false);
});

test('explicit interaction UI executes route order and confirmation gate', async () => {
  type EventListener = (event: { preventDefault(): void }) => void;
  class FakeElement {
    textContent = '';
    className = '';
    value = '';
    disabled = false;
    firstChild: FakeElement | null = null;
    readonly children: FakeElement[] = [];
    readonly listeners = new Map<string, EventListener[]>();
    readonly fields = new Map<string, FakeElement>();
    readonly elements = { namedItem: (name: string): FakeElement => this.fields.get(name)! };

    append(...nodes: FakeElement[]): void {
      this.children.push(...nodes);
      this.firstChild ??= nodes[0] ?? null;
    }

    removeChild(child: FakeElement): void {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      this.firstChild = this.children[0] ?? null;
    }

    addEventListener(type: string, listener: EventListener): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    dispatch(type: string): void {
      for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} });
    }

    click(): void {
      if (!this.disabled) this.dispatch('click');
    }

    querySelector(selector: string): FakeElement {
      if (selector === 'button[type="submit"]') return this.fields.get('submit')!;
      throw new Error(`unexpected element selector: ${selector}`);
    }
  }

  class FakeForm extends FakeElement {
    readonly fields = new Map<string, FakeElement>();
    addField(name: string, initial = ''): FakeElement {
      const control = new FakeElement();
      control.value = initial;
      this.fields.set(name, control);
      return control;
    }
  }

  const feedback = new FakeElement();
  const diagnostic = new FakeElement();
  const serverResult = new FakeElement();
  const runtimeMode = new FakeElement();
  const visibleState = new FakeElement();
  const interactionIdLabel = new FakeElement();
  const inspection = new FakeElement();
  const draftFeedback = new FakeElement();
  const inputForm = new FakeForm();
  inputForm.addField('sourceRef', 'ui:test');
  inputForm.addField('rawInput', 'create an evidence task');
  inputForm.addField('inputRevision', '1');
  const matchingForm = new FakeForm();
  matchingForm.addField('normalizedInput', 'create an evidence task');
  matchingForm.addField('knownFacts', 'fact-1');
  matchingForm.addField('matchedTasks', '[]');
  const proposalForm = new FakeForm();
  proposalForm.addField('proposedIntent', 'create');
  proposalForm.addField('proposal', 'create the evidence task');
  proposalForm.addField('decisionRefs', '');
  const confirmationForm = new FakeForm();
  confirmationForm.addField('draftId');
  confirmationForm.addField('inputRevision', '1');
  confirmationForm.addField('confirmationRef', 'confirmation:test');
  confirmationForm.addField('confirmedBy', 'human:test');
  confirmationForm.addField('confirmedAt', '2026-09-19T01:00');
  confirmationForm.addField('payloadRef', 'asset://requirements/test');
  const controlForm = new FakeForm();
  controlForm.addField('taskId', 'task-control');
  controlForm.addField('prompt', 'continue the task');
  const matchButton = new FakeElement();
  const proposalButton = new FakeElement();
  const confirmationButton = new FakeElement();
  const dispatchButton = new FakeElement();
  const statusInputButton = new FakeElement();
  const statusMatchButton = new FakeElement();
  matchingForm.fields.set('submit', matchButton);
  proposalForm.fields.set('submit', proposalButton);
  confirmationForm.fields.set('submit', confirmationButton);

  const elements = new Map<string, FakeElement>([
    ['[data-action-feedback]', feedback],
    ['[data-diagnostic-output]', diagnostic],
    ['[data-server-result]', serverResult],
    ['[data-runtime-mode]', runtimeMode],
    ['[data-visible-state]', visibleState],
    ['[data-interaction-id]', interactionIdLabel],
    ['[data-inspection]', inspection],
    ['[data-draft-feedback]', draftFeedback],
    ['[data-explicit-input]', inputForm],
    ['[data-explicit-match]', matchingForm],
    ['[data-explicit-proposal]', proposalForm],
    ['[data-explicit-confirmation]', confirmationForm],
    ['[data-control-form]', controlForm],
    ['[data-action="dispatch"]', dispatchButton],
    ['[data-action="steer"]', new FakeElement()],
    ['[data-action="continue"]', new FakeElement()],
  ]);
  const steerButton = elements.get('[data-action="steer"]')!;
  const continueButton = elements.get('[data-action="continue"]')!;
  const documentDouble = {
    querySelector: (selector: string): FakeElement => elements.get(selector) ?? (() => { throw new Error(`unexpected selector: ${selector}`); })(),
    querySelectorAll: (selector: string): FakeElement[] => selector === '[data-action="status-only"]' ? [statusInputButton, statusMatchButton] : [],
    createElement: (_tag: string): FakeElement => new FakeElement(),
  };

  interface RequestRecord { path: string; method: string; body?: Record<string, unknown> }
  const requests: RequestRecord[] = [];
  let interactionSeq = 0;
  let state = 'received';
  let activeInteraction = '';
  let draftId = '';
  const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchDouble = async (input: string | URL, init: { method?: string; body?: string } = {}) => {
    const url = new URL(String(input), 'http://ui.test');
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>;
    requests.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) });
    if (url.pathname === '/api/runtime/status') return response(200, { mode: 'fake' });
    if (url.pathname === '/api/explicit/inputs') {
      assert.equal(method, 'POST');
      assert.equal(body?.channel, 'business');
      activeInteraction = `interaction-${++interactionSeq}`;
      state = 'received';
      return response(201, { interactionId: activeInteraction });
    }
    if (url.pathname === `/api/explicit/interactions/${activeInteraction}`) {
      return response(200, {
        interactionId: activeInteraction,
        state,
        sourceRef: 'ui:test',
        rawInput: 'create an evidence task',
        owner: 'explicit-intake',
        nextAction: state === 'received' ? 'start-matching' : 'present-status',
        ...(draftId ? { draft: { draftId, inputRevision: 1, normalizedInput: 'create an evidence task', matchedTasks: [], knownFacts: ['fact-1'], proposedIntent: 'create', proposal: 'create the evidence task', decisionRefs: [], state } } : {}),
        history: [state],
      });
    }
    if (url.pathname.endsWith('/matching')) {
      assert.equal(method, 'POST');
      state = 'matching';
      return response(202, { interactionId: activeInteraction });
    }
    if (url.pathname.endsWith('/match')) {
      assert.equal(method, 'POST');
      assert.deepEqual(body, { normalizedInput: 'create an evidence task', matchedTasks: [], knownFacts: ['fact-1'] });
      state = 'awaiting-intent';
      draftId = 'draft-1';
      return response(202, { interactionId: activeInteraction });
    }
    if (url.pathname.endsWith('/proposal')) {
      assert.equal(method, 'POST');
      assert.deepEqual(body, { proposedIntent: 'create', proposal: 'create the evidence task', decisionRefs: [] });
      state = 'awaiting-confirmation';
      return response(202, { interactionId: activeInteraction });
    }
    if (url.pathname.endsWith('/status-only')) {
      assert.equal(method, 'POST');
      state = 'status-only';
      return response(200, { kind: 'status-only', interactionId: activeInteraction, owner: 'explicit-intake', nextAction: 'present-status' });
    }
    if (url.pathname.endsWith('/confirmation')) {
      assert.equal(method, 'POST');
      assert.equal(body?.draftId, 'draft-1');
      assert.equal(body?.confirmedBy, 'human:test');
      state = 'confirmed';
      return response(200, { requirement: { status: 'submitted', requirementId: 'requirement:draft-1:1' } });
    }
    if (url.pathname === '/api/explicit/dispatch-next') {
      assert.equal(method, 'POST');
      assert.equal(state, 'confirmed');
      state = 'dispatched';
      return response(202, { requirement: { fifoSeq: 1 }, taskId: { value: 'ui-task-1' }, operationId: { value: 'operation-1' } });
    }
    if (url.pathname === '/api/tasks/task-control/stop') {
      assert.equal(method, 'POST');
      assert.equal(body, undefined);
      return response(202, { state: 'stopped', operationId: 'operation-stop' });
    }
    if (url.pathname === '/api/tasks/task-control/executions') {
      assert.equal(method, 'POST');
      assert.deepEqual(body, { mode: 'fake', prompt: 'continue the task' });
      return response(202, { operationId: 'operation-continue', executionEpoch: 2 });
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`);
  };

  const host = globalThis as unknown as { document?: unknown; fetch: typeof globalThis.fetch };
  const previousDocument = host.document;
  const previousFetch = host.fetch;
  host.document = documentDouble;
  host.fetch = fetchDouble as typeof globalThis.fetch;
  try {
    await import(`${new URL(`file://${join(process.cwd(), 'docs/ui/interaction.js')}`).href}?executable-ui-test`);
    const settle = async (): Promise<void> => { for (let index = 0; index < 4; index += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

    inputForm.dispatch('submit');
    await settle();
    assert.equal(visibleState.textContent, 'received');
    assert.equal(matchButton.disabled, false);

    const dispatchBeforeConfirmation = requests.filter((request) => request.path === '/api/explicit/dispatch-next').length;
    for (const invalidMatchedTasks of ['{', '{}']) {
      matchingForm.fields.get('matchedTasks')!.value = invalidMatchedTasks;
      const matchingCallsBeforeInvalid = requests.filter((request) => request.path.endsWith('/matching')).length;
      matchingForm.dispatch('submit');
      await settle();
      assert.equal(requests.filter((request) => request.path.endsWith('/matching')).length, matchingCallsBeforeInvalid);
      assert.equal(state, 'received');
      assert.equal(visibleState.textContent, 'received');
    }
    matchingForm.fields.get('matchedTasks')!.value = '[]';
    matchingForm.dispatch('submit');
    await settle();
    assert.equal(proposalButton.disabled, false);
    proposalForm.dispatch('submit');
    await settle();
    assert.equal(confirmationButton.disabled, false);
    dispatchButton.click();
    await settle();
    assert.equal(requests.filter((request) => request.path === '/api/explicit/dispatch-next').length, dispatchBeforeConfirmation);

    confirmationForm.dispatch('submit');
    await settle();
    assert.equal(dispatchButton.disabled, false);
    dispatchButton.click();
    await settle();
    assert.equal(requests.filter((request) => request.path === '/api/explicit/dispatch-next').length, dispatchBeforeConfirmation + 1);
    const routeIndex = (path: string): number => requests.findIndex((request) => request.path === path || request.path.endsWith(path));
    assert.ok(routeIndex('/api/explicit/inputs') < routeIndex('/matching'));
    assert.ok(routeIndex('/matching') < routeIndex('/match'));
    assert.ok(routeIndex('/match') < routeIndex('/proposal'));
    assert.ok(routeIndex('/proposal') < routeIndex('/confirmation'));
    assert.ok(routeIndex('/confirmation') < routeIndex('/api/explicit/dispatch-next'));

    const taskCallsBeforeStatus = requests.filter((request) => request.path.startsWith('/api/tasks')).length;
    inputForm.dispatch('submit');
    await settle();
    statusInputButton.click();
    await settle();
    assert.equal(requests.some((request) => request.path.endsWith('/status-only')), true);
    assert.equal(requests.filter((request) => request.path === '/api/explicit/dispatch-next').length, dispatchBeforeConfirmation + 1);
    assert.equal(requests.filter((request) => request.path.startsWith('/api/tasks')).length, taskCallsBeforeStatus);

    steerButton.click();
    await settle();
    continueButton.click();
    await settle();
    assert.equal(requests.some((request) => request.path === '/api/tasks/task-control/stop'), true);
    assert.equal(requests.some((request) => request.path === '/api/tasks/task-control/executions'), true);
    assert.equal(requests.some((request) => request.path === '/api/explicit/inputs' && request.body?.channel === 'control'), false);
    assert.equal(runtimeMode.textContent, 'mode=fake');
  } finally {
    host.document = previousDocument;
    host.fetch = previousFetch;
  }
});

test('task detail UI consumes typed task-detail projection fields', async () => {
  const source = await readFile('docs/ui/task.js', 'utf8');
  assert.equal(source.includes('detail.taskTitle'), false);
  assert.equal(source.includes('detail.stateLabel'), false);
  assert.equal(source.includes('detail.data.label'), false);
  assert.equal(source.includes('detail.output?.summary'), true);
  assert.equal(source.includes('detail.artifacts'), false);
  assert.equal(/detail\.observation\b/.test(source), false);
  assert.equal(source.includes('detail.title'), true);
  assert.equal(source.includes('detail.currentState'), true);
  assert.equal(source.includes('detail.priorInput'), true);
  assert.equal(source.includes('detail.investigation'), true);
  assert.equal(source.includes('detail.proposal'), true);
  assert.equal(source.includes('detail.requiredDecisions'), true);
  assert.equal(source.includes('detail.output'), true);
  assert.equal(source.includes('detail.output?.artifacts'), true);
  assert.equal(source.includes('detail.observationRef'), true);
});

test('task clarification handler retries interpretation by typed state without resubmitting the answer', async () => {
  const flow = await import(
    `${new URL(`file://${join(process.cwd(), 'docs/ui/explicit-interaction-flow.js')}`).href}?clarification-retry-test`
  ) as {
    readonly advanceExplicitInteraction: (
      api: {
        readonly inspectExplicitInteraction: (interactionId: string) => Promise<{ readonly state: string }>;
        readonly answerExplicitClarification: (interactionId: string, answer: string) => Promise<{ readonly state: string }>;
        readonly interpretExplicitInput: (interactionId: string) => Promise<{ readonly state: string }>;
      },
      input: { readonly interactionId: string; readonly clarificationAnswer?: string },
    ) => Promise<{ readonly state: string }>;
  };
  const calls: string[] = [];
  let state = 'awaiting-clarification';
  let interpretationAttempt = 0;
  const api = {
    async inspectExplicitInteraction(interactionId: string) {
      assert.equal(interactionId, 'interaction-existing-task');
      calls.push('inspect');
      return { state };
    },
    async answerExplicitClarification(interactionId: string, answer: string) {
      assert.equal(interactionId, 'interaction-existing-task');
      assert.equal(answer, '只修改验收范围');
      assert.equal(state, 'awaiting-clarification');
      calls.push('clarification');
      state = 'matching';
      return { state };
    },
    async interpretExplicitInput(interactionId: string) {
      assert.equal(interactionId, 'interaction-existing-task');
      calls.push('interpret');
      interpretationAttempt += 1;
      if (interpretationAttempt === 1) throw new Error('temporary interaction provider failure');
      state = 'awaiting-confirmation';
      return { state };
    },
  };

  let firstFailure: unknown;
  try {
    await flow.advanceExplicitInteraction(api, {
      interactionId: 'interaction-existing-task',
      clarificationAnswer: '只修改验收范围',
    });
  } catch (error) {
    firstFailure = error;
  }
  assert.equal(firstFailure instanceof Error && firstFailure.message === 'temporary interaction provider failure', true);
  assert.deepEqual(calls, ['inspect', 'clarification', 'interpret']);
  assert.equal(state, 'matching');

  const retried = await flow.advanceExplicitInteraction(api, {
    interactionId: 'interaction-existing-task',
    clarificationAnswer: '只修改验收范围',
  });
  assert.equal(retried.state, 'awaiting-confirmation');
  assert.deepEqual(calls, ['inspect', 'clarification', 'interpret', 'inspect', 'interpret']);
});

test('explicit confirmation stays on the interaction page and exposes the FIFO receipt', async () => {
  const source = await readFile('docs/ui/task.js', 'utf8');
  const interactionSource = source.slice(
    source.indexOf('async function renderInteraction'),
    source.indexOf('function renderTask()'),
  );
  class Node {
    children: Node[] = [];
    textContent = '';
    className = '';
    hidden = false;
    disabled = false;
    href = '';
    attrs: Record<string, string> = {};
    handlers: Record<string, () => Promise<void>> = {};
    append(...nodes: Node[]) { this.children.push(...nodes); }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    addEventListener(type: string, handler: () => Promise<void>) { this.handlers[type] = handler; }
    replaceChildren(...nodes: Node[]) { this.children = nodes; }
    removeChild(node: Node) { this.children = this.children.filter((candidate) => candidate !== node); }
    get firstChild() { return this.children[0]; }
  }
  const nodes: Node[] = [];
  const element = (tag: string, text?: string, className?: string) => {
    const node = new Node();
    node.textContent = text ?? '';
    node.className = className ?? '';
    nodes.push(node);
    return node;
  };
  const document = {
    createElement: (tag: string) => element(tag),
  };
  const main = new Node();
  let confirmed = 0;
  const api = {
    async inspectExplicitInteraction() {
      return {
        state: 'awaiting-confirmation',
        rawInput: 'prepare the release evidence',
        nextAction: 'confirm-or-revise',
        draft: { draftId: 'draft-7', inputRevision: 1, proposal: 'prepare release evidence' },
      };
    },
    async confirmExplicitRequirement(interactionId: string) {
      assert.equal(interactionId, 'interaction-confirm');
      confirmed += 1;
      return { requirement: { requirementId: 'requirement:draft-7:1' } };
    },
  };
  const window = { location: { href: './task.html?task=new&interaction=interaction-confirm' } };
  const advance = async () => ({
    state: 'awaiting-confirmation',
    rawInput: 'prepare the release evidence',
    nextAction: 'confirm-or-revise',
    draft: { draftId: 'draft-7', inputRevision: 1, proposal: 'prepare release evidence' },
  });
  const clearNode = (node: Node) => { node.children = []; };
  const appendCardEvent = () => {};
  const appendCardError = () => {};
  const updateCardFromSnapshot = () => {};
  const attachInteractionCardHost = () => {};
  const interactionCard = null;
  // The shared technical-detail trigger is imported by task.js and mounted by renderInteraction so
  // the last typed failure stays reachable. It starts hidden and is shown only by showError, so the
  // happy-path assertions here never observe it.
  const technicalDetailTrigger = () => {
    const node = new Node();
    node.hidden = true;
    return node;
  };
  await new Function(
    'element',
    'main',
    'api',
    'advanceExplicitInteraction',
    'window',
    'document',
    'clearNode',
    'appendCardEvent',
    'appendCardError',
    'updateCardFromSnapshot',
    'attachInteractionCardHost',
    'interactionCard',
    'technicalDetailTrigger',
    `${interactionSource}; return renderInteraction('interaction-confirm', undefined)`,
  )(element, main, api, advance, window, document, clearNode, appendCardEvent, appendCardError, updateCardFromSnapshot, attachInteractionCardHost, interactionCard, technicalDetailTrigger);
  const feedback = nodes.find((node) => node.attrs.role === 'status');
  const confirm = nodes.find((node) => node.textContent === '按此方案继续');
  if (!feedback || !confirm) throw new Error('expected confirmation controls');
  await confirm.handlers.click();
  assert.equal(confirmed, 1);
  assert.equal(window.location.href, './task.html?task=new&interaction=interaction-confirm');
  assert.equal(feedback.textContent.includes('已进入 FIFO'), true);
  assert.equal(feedback.textContent.includes('requirement:draft-7:1'), true);
  assert.equal(nodes.some((node) => node.textContent === '打开任务列表' && node.href === './tasks.html'), true);
});

test('runtime task dashboard is observational and has no second execution-input form', async () => {
  const source = await readFile('docs/ui/task-dashboard.js', 'utf8');
  assert.equal(source.includes('本次执行输入'), false);
  assert.equal(source.includes('promptInput'), false);
  assert.equal(source.includes('api.startExecution'), false);
  assert.equal(source.includes('进入显式大脑'), true);
  assert.equal(/shouldObserveActiveState\(\)/.test(source), true);
  assert.equal(/dashboard\.state\)\n    && !dashboard\.operationId/.test(source), true);
  assert.equal(/dashboard\.operationId && \['running', 'settling'\]\.includes\(dashboard\.state\)/.test(source), true);
  assert.equal(/if \(subscribedOperationId === operationId\) return/.test(source), true);
  assert.equal(/subscribedOperationId = operationId/.test(source), true);
  assert.equal(/if \(subscribedOperationId\) \{[\s\S]*subscribedOperationId = undefined/.test(source), true);
  assert.equal(source.includes('subscribe(dashboard.operationId)'), true);
});

type InteractionCardPageAdapter = {
  readonly projectInteractionCardFromEntries: (
    entries: readonly unknown[],
    state?: string,
    context?: unknown,
  ) => {
    readonly surface: string;
    readonly taskState: string;
    readonly stateLabel?: string;
    readonly actions: readonly unknown[];
    readonly conversation: {
      readonly summary: { readonly missing?: true; readonly goal?: { readonly text: string } };
      readonly turns: readonly { readonly markdown?: string }[];
    };
    readonly trace: { readonly items: readonly { readonly requestId: string }[] };
    readonly history: { readonly result: string };
    readonly cardMetadata: {
      readonly nextAction?: string;
      readonly waitingOn?: string;
      readonly source: {
        readonly interactionId?: string;
        readonly taskId?: { readonly scope: string; readonly value: string };
        readonly operationId?: { readonly scope: string; readonly value: string };
        readonly executionEpoch?: number;
      };
    };
  };
  readonly projectInteractionCardFromSnapshot: (snapshot: unknown) => {
    readonly conversation: {
      readonly summary: { readonly missing?: true; readonly goal?: { readonly text: string } };
      readonly turns: readonly { readonly markdown?: string }[];
    };
  };
  readonly scopedId: (scope: string, value: string) => { readonly scope: string; readonly value: string };
};

const interactionCardPage = await import(
  pathToFileURL(resolve('docs/ui/interaction-card-page.js')).href
) as InteractionCardPageAdapter;

test('interaction card page adapter keeps technical identifiers in trace details only', () => {
  const projection = interactionCardPage.projectInteractionCardFromEntries([
    {
      sequence: 1,
      interactionId: 'interaction-1',
      kind: 'status',
      sourceKind: 'progress',
      eventKey: 'explicit.interpret',
      text: '显式大脑正在整理输入',
    },
  ], 'matching');

  assert.equal(projection.surface, 'interaction-work-card');
  assert.equal(projection.conversation.turns[0]?.markdown, '显式大脑正在整理输入');
  assert.equal(projection.conversation.turns[0]?.markdown?.includes('requestId'), false);
  // An explicit interaction is owned by explicit intake, not by a provider
  // request, so it has no turn or request identity to show. The card reports
  // the absent history explicitly instead of synthesizing a turn id.
  assert.equal(projection.trace.items.length, 0);
  assert.equal(projection.history.result, 'missing');
  // The conversation and trace carry no technical identity; the interaction's
  // own event key stays in the folded status detail only.
  assert.equal(JSON.stringify(projection.conversation).includes('explicit.interpret'), false);
  assert.equal(JSON.stringify(projection.trace).includes('explicit.interpret'), false);
  assert.equal(JSON.stringify(projection.trace).includes('1.explicit.interpret'), false);
  assert.equal(
    JSON.stringify({ ...projection.cardMetadata, nextAction: undefined }).includes('1.explicit.interpret'),
    false,
  );
});

test('interaction card page adapter preserves draft facts without leaking decision refs', () => {
  assert.equal(
    interactionCardPage.projectInteractionCardFromSnapshot({ state: 'received' }) as unknown,
    undefined,
  );
  const projection = interactionCardPage.projectInteractionCardFromSnapshot({
    interactionId: 'interaction-2',
    state: 'awaiting-confirmation',
    rawInput: '整理周报证据',
    reply: '请确认',
    clarifications: [],
    draft: {
      draftId: 'draft-1',
      inputRevision: 1,
      proposedIntent: 'append',
      normalizedInput: '整理周报证据并保持不发布',
      proposal: '补齐证据，不发布。',
      decisionRefs: ['decision:internal'],
      knownFacts: ['已有草稿'],
    },
  });

  const summary = projection.conversation.summary;
  assert.equal(summary.missing, undefined);
  assert.equal(summary.goal?.text, '整理周报证据');
  assert.equal(JSON.stringify(summary).includes('decision:internal'), false);
  assert.equal(JSON.stringify(projection.conversation.turns).includes('decision:internal'), false);
});

test('interaction card page adapter scoped ids are explicit and deterministic', () => {
  assert.deepEqual(interactionCardPage.scopedId('task', 'task-1'), { scope: 'task', value: 'task-1' });
});

// The confirmation flow the entry page and the dashboard share. The runtime
// records `confirmed` when it accepts the exact revision, and `dispatched` once
// the coordinator consumed the requirement. Both are declared
// `ExplicitInteractionState` values, so the card must project them onto a
// declared `LifecycleState` instead of falling through to `unknown`.
const confirmedCardEntries = [
  {
    sequence: 1,
    interactionId: 'interaction-confirmed',
    kind: 'user',
    sourceKind: 'user',
    eventKey: 'explicit.raw-input',
    text: '读取 README 并汇报',
  },
  {
    sequence: 2,
    interactionId: 'interaction-confirmed',
    kind: 'decision',
    sourceKind: 'decision',
    eventKey: 'explicit.confirmation-submitted',
    text: '任务已提交，正在等待隐式大脑派发',
  },
];

// Failure mode (basis: known served defect, docs/ui/interaction-card-page.js
// L43-86 on the base): an interaction-only `confirmed`/`dispatched` card
// reported `running` and synthesized a Task/Operation id from the interaction
// id, so the user saw a running Task before any execution existed. Impact is
// high (false task existence and progress); cost is one ~2s JSDOM test. The
// counterexample is the same projection on the base, which returns
// `taskState: 'running'` and a fabricated `source.taskId.value`.
test('interaction card keeps confirmed and dispatched as an interaction-only waiting state', () => {
  for (const state of ['confirmed', 'dispatched']) {
    const projection = interactionCardPage.projectInteractionCardFromEntries(confirmedCardEntries, state);
    // A confirmation hands the next step to the runtime: the card is waiting,
    // never running.
    assert.equal(projection.taskState, 'waiting');
    assert.equal(projection.cardMetadata.waitingOn, 'runtime');
    // The card keeps the real interaction identity and mints no Task/Operation.
    assert.equal(projection.cardMetadata.source.interactionId, 'interaction-confirmed');
    assert.equal(projection.cardMetadata.source.taskId, undefined);
    assert.equal(projection.cardMetadata.source.operationId, undefined);
    assert.deepEqual(projection.actions, []);
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes('等待决策'), false);
    assert.equal(serialized.includes('等待你确认任务草案'), false);
    assert.equal(serialized.includes('确认并进入队列'), false);
  }
  // The fix must not move the pre-confirmation draft out of the human-waiting
  // projection: the pre-confirmation state stays read-only draft history.
  const waiting = interactionCardPage.projectInteractionCardFromEntries(confirmedCardEntries, 'awaiting-confirmation');
  assert.equal(waiting.taskState, 'waiting');
  assert.equal(waiting.cardMetadata.waitingOn, 'human');
});

// Failure mode (basis: docs/ui/task.js omitted dashboard.taskId/operationId and
// the projector derived identity from the interaction): a real admitted Task or
// running Task was labelled with a fabricated `pending-input` scope. Impact is
// high (identity and execution truth are wrong); cost is one ~2s JSDOM test.
test('interaction card forwards a genuine dashboard task identity and fabricates none', () => {
  // No real interaction or Task identity is a no-mount projection, not a
  // source-less card.
  assert.equal(
    interactionCardPage.projectInteractionCardFromEntries([], 'received') as unknown,
    undefined,
  );
  // A real admitted Task without an operation stays a real waiting task with its
  // real TaskId and no invented Operation or interaction.
  const admitted = interactionCardPage.projectInteractionCardFromEntries([], 'awaiting-confirmation', {
    execution: {
      taskId: { scope: 'task', value: 'task-real-admitted' },
      state: 'waiting',
      stateLabel: '已入队，等待执行',
    },
  });
  assert.equal(admitted.taskState, 'waiting');
  assert.equal(admitted.cardMetadata.source.taskId?.value, 'task-real-admitted');
  assert.equal(admitted.cardMetadata.source.operationId, undefined);
  assert.equal(admitted.cardMetadata.source.interactionId, undefined);
  // A genuine running execution keeps the real Task, Operation and epoch, and
  // the runtime's own localized state governs the card.
  const running = interactionCardPage.projectInteractionCardFromEntries([], 'received', {
    execution: {
      taskId: { scope: 'task', value: 'task-real-1' },
      operationId: 'op-real-1',
      executionEpoch: 1,
      state: 'running',
      stateLabel: '运行中',
    },
  });
  assert.equal(running.taskState, 'running');
  assert.equal(running.stateLabel, '运行中');
  assert.equal(running.cardMetadata.source.taskId?.value, 'task-real-1');
  assert.equal(running.cardMetadata.source.operationId?.value, 'op-real-1');
  assert.equal(running.cardMetadata.source.executionEpoch, 1);
  // A supplied invalid epoch stays supplied, so the existing contract validator
  // can reject it instead of the page silently laundering it into absent.
  const invalidEpoch = interactionCardPage.projectInteractionCardFromEntries([], 'received', {
    execution: {
      taskId: { scope: 'task', value: 'task-real-invalid-epoch' },
      executionEpoch: 0,
      state: 'running',
      stateLabel: '运行中',
    },
  });
  assert.equal(invalidEpoch.cardMetadata.source.executionEpoch, 0);
});

type InteractionWorkCardAdapter = {
  readonly mountInteractionWorkCard: (target: unknown, options?: unknown) => {
    readonly update: (projection: unknown) => void;
  };
};

test('interaction card DOM shows a declared lifecycle label after the requirement is confirmed', async () => {
  const { mountInteractionWorkCard } = await import(new URL(
    `file://${join(process.cwd(), 'docs/ui/interaction-work-card.js')}`,
  ).href) as InteractionWorkCardAdapter;

  class FakeClassList {
    private readonly names = new Set<string>();
    add(...names: string[]): void { for (const name of names) this.names.add(name); }
    remove(...names: string[]): void { for (const name of names) this.names.delete(name); }
    contains(name: string): boolean { return this.names.has(name); }
  }

  class FakeNode {
    readonly nodeType = 1;
    textContent = '';
    className = '';
    hidden = false;
    href = '';
    name = '';
    value = '';
    disabled = false;
    type = '';
    readonly dataset: Record<string, string> = {};
    readonly classList = new FakeClassList();
    readonly children: FakeNode[] = [];
    private readonly attributes = new Map<string, string>();

    constructor(readonly tagName: string) {}

    get firstChild(): FakeNode | undefined { return this.children[0]; }
    append(...nodes: FakeNode[]): void { this.children.push(...nodes); }
    replaceChildren(...nodes: FakeNode[]): void {
      this.children.length = 0;
      this.children.push(...nodes);
    }
    removeChild(node: FakeNode): void {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
    }
    remove(): void {}
    focus(): void {}
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    getAttribute(name: string): string | undefined { return this.attributes.get(name); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
    addEventListener(): void {}
    removeEventListener(): void {}
    contains(node: FakeNode): boolean {
      return this.children.some((child) => child === node || child.contains(node));
    }
    querySelector(selector: string): FakeNode | null {
      for (const child of this.children) {
        if (matchesFakeSelector(child, selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
  }

  const matchesFakeSelector = (node: FakeNode, selector: string): boolean => {
    const attribute = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      const name = attribute[1]!;
      const expected = attribute[2];
      const datasetKey = name.startsWith('data-')
        ? name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
        : undefined;
      const actual = node.getAttribute(name) ?? (datasetKey === undefined ? undefined : node.dataset[datasetKey]);
      return expected === undefined ? actual !== undefined : actual === expected;
    }
    if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
    return node.tagName === selector;
  };

  const fakeText = (node: FakeNode): string => node.textContent + node.children.map(fakeText).join('');
  // The lifecycle chip is the first `交互`/`任务`/`节点` state chip in the card.
  const lifecycleChip = (node: FakeNode): string => {
    let found = '';
    const walk = (current: FakeNode): void => {
      if (current.className.split(/\s+/).includes('iwc-state-chip') && /^(交互|任务|节点) /.test(current.textContent)) {
        found = current.textContent;
      }
      for (const child of current.children) walk(child);
    };
    walk(node);
    return found;
  };

  const scope = globalThis as unknown as { document?: unknown };
  const previousDocument = scope.document;
  scope.document = {
    activeElement: null,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => {
      const node = new FakeNode('#text');
      node.textContent = text;
      return node;
    },
  };
  try {
    const host = new FakeNode('div');
    const card = mountInteractionWorkCard(host);
    card.update({ ...interactionCardPage.projectInteractionCardFromEntries(confirmedCardEntries, 'confirmed'), actions: [] });
    // An interaction-only card is labelled as an interaction and reads as
    // waiting for the runtime, not as a running task.
    assert.equal(host.querySelector('.iwc-lifecycle-label')?.textContent, '已确认，等待调度');
    assert.equal(lifecycleChip(host), '交互 已确认，等待调度');
    assert.equal(host.querySelector('.iwc-source-ref')?.textContent?.includes('interaction=interaction-confirmed'), true);
    assert.equal(host.querySelector('.iwc-source-ref')?.textContent?.includes('operation=未提供'), true);
    const text = fakeText(host);
    assert.equal(text.includes('运行中'), false);
    assert.equal(text.includes('未知'), false);
    assert.equal(text.includes('等待决策'), false);
    // The raw interaction enum must not be the card's state reading. The
    // technical source reference legitimately shows the real interaction id
    // (which embeds the state word), so the human state surfaces are checked on
    // their own.
    assert.equal(host.querySelector('.iwc-lifecycle-label')?.textContent?.includes('confirmed'), false);
    assert.equal(host.querySelector('.iwc-status-detail')?.textContent?.includes('confirmed'), false);
    assert.equal(text.includes('等待你确认任务草案'), false);
    assert.equal(text.includes('确认并进入队列'), false);
    // The card carries no second authorization control after the confirmed
    // projection.
    assert.equal(host.querySelector('.iwc-button--primary'), null);

    // A genuine running execution keeps its real task identity and running label.
    const runningHost = new FakeNode('div');
    mountInteractionWorkCard(runningHost).update(interactionCardPage.projectInteractionCardFromEntries([], 'received', {
      execution: {
        taskId: { scope: 'task', value: 'task-real-1' },
        operationId: 'op-real-1',
        executionEpoch: 1,
        state: 'running',
        stateLabel: '运行中',
      },
    }));
    assert.equal(lifecycleChip(runningHost), '任务 运行中');
    assert.equal(runningHost.querySelector('.iwc-source-ref')?.textContent?.includes('task=task:task-real-1'), true);
  } finally {
    scope.document = previousDocument;
  }
});

test('entry page projects the post-confirmation state instead of the pre-confirmation snapshot', async () => {
  const source = await readFile('docs/ui/entry.js', 'utf8');
  const start = source.indexOf('const POST_CONFIRMATION_STATES');
  const end = source.indexOf('function handleSubmissionError');
  assert.ok(start >= 0, 'entry.js must name the post-confirmation states');
  assert.ok(end > start, 'entry.js must keep the confirmation flow before its error handler');
  const block = source.slice(start, end);
  const confirmIndex = block.indexOf('await api.confirmExplicitRequirement(interactionId');
  const refreshIndex = block.indexOf('latestState = await postConfirmationState()');
  const decisionIndex = block.indexOf("appendCardEvent('decision'");
  assert.ok(confirmIndex >= 0 && refreshIndex >= 0 && decisionIndex >= 0);
  // The card state is refreshed from the runtime after the confirmation request
  // and before the decision event is projected.
  assert.equal(confirmIndex < refreshIndex && refreshIndex < decisionIndex, true);

  const harnessSource = [
    block,
    'let interactionId;',
    'let latestState = "received";',
    'let confirmation;',
    'let api = apiRef.current;',
    'const cardStates = [];',
    'const draftedStates = [];',
    'const status = { dataset: {}, textContent: "" };',
    'const window = { location: { assign() {} } };',
    'function appendCardEvent(kind, text, sourceKind) { cardStates.push({ kind, state: latestState, text }); }',
    'function appendCardError() {}',
    'function renderDraft(snapshot) { draftedStates.push(snapshot.state); }',
    'async function waitForTask() { return "task-1"; }',
    'function observationHref(taskId) { return "./task.html?task=" + taskId; }',
    'async function refreshQueue() {}',
    // The identity helpers sit before the sliced confirmation block, so the harness stubs them for
    // the waitForTask call. waitForTask is stubbed here too, so these only keep the call chain real.
    'function identityFromReceipt(requirement) { return requirement ?? null; }',
    'function identityFromConfirmedSnapshot(snapshot) { return snapshot?.confirmation ?? null; }',
    'return {',
    '  async run(submission, nextApi) {',
    '    api = nextApi;',
    '    interactionId = "interaction-entry";',
    '    latestState = "received";',
    '    cardStates.length = 0;',
    '    draftedStates.length = 0;',
    '    return await executeSubmission(submission);',
    '  },',
    '  cardStates,',
    '  draftedStates,',
    '  state: () => latestState,',
    '};',
  ].join('\n');
  type EntryHarness = {
    readonly run: (submission: unknown, api: unknown) => Promise<unknown>;
    readonly cardStates: readonly { readonly kind: string; readonly state: string }[];
    readonly draftedStates: readonly string[];
    readonly state: () => string;
  };
  const buildHarness = (): EntryHarness => new Function('apiRef', harnessSource)({ current: undefined }) as EntryHarness;

  const preConfirmation = {
    state: 'awaiting-confirmation',
    rawInput: '读取 README',
    nextAction: 'confirm-or-revise',
    draft: {
      draftId: 'draft-1',
      inputRevision: 1,
      normalizedInput: '读取 README',
      proposal: '读取 README 并汇报',
    },
  };
  const submission = { rawInput: '读取 README', executionPolicy: { executionMode: 'once' } };
  const entryApi = (postConfirmation: unknown, failRead = false) => {
    let reads = 0;
    return {
      async inspectExplicitInteraction() {
        reads += 1;
        if (reads === 1) return preConfirmation;
        if (failRead) throw Object.assign(new Error('interaction read unavailable'), { code: 'read.failed' });
        return postConfirmation;
      },
      async confirmExplicitRequirement() {
        return { requirement: { requirementId: 'requirement:draft-1:1', fifoSeq: 1 } };
      },
    };
  };

  for (const [postConfirmation, expected] of [
    [{ state: 'dispatched' }, 'dispatched'],
    [{ state: 'confirmed' }, 'confirmed'],
    // A read that still reports the pre-confirmation state must never drive the
    // post-confirmation projection.
    [preConfirmation, 'confirmed'],
    [undefined, 'confirmed'],
  ] as readonly [unknown, string][]) {
    const harness = buildHarness();
    await harness.run(submission, entryApi(postConfirmation, postConfirmation === undefined));
    assert.equal(harness.state(), expected);
    assert.deepEqual(harness.draftedStates, ['awaiting-confirmation']);
    assert.equal(harness.cardStates.length, 1);
    assert.equal(harness.cardStates[0]!.kind, 'decision');
    assert.equal(harness.cardStates[0]!.state, expected);
    assert.equal(harness.cardStates[0]!.state === 'awaiting-confirmation', false);
  }
});
