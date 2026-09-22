import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
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
  });
  assert.deepEqual(projection.surface, 'memory-interaction');
  assert.deepEqual(projection.reviewRequired, true);
  assert.deepEqual(projection.skillCandidates[0].proposedRule, '覆盖范围变化需先复核受影响分片');
  assert.deepEqual(projection.indexState, 'ready');
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
    'docs/ui/runtime-api.js',
    'docs/ui/runtime-shell.js',
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
});

test('UI index is an explicit historical handoff, not a fake runtime console', async () => {
  const html = await readFile('docs/ui/index.html', 'utf8');
  const readme = await readFile('docs/ui/README.md', 'utf8');
  assert.equal(html.includes("location.replace('./dashboard.html')"), true);
  assert.equal(html.includes('打开 Runtime Dashboard'), true);
  assert.equal(html.includes('历史视觉原型'), true);
  assert.equal(html.includes('不会伪造 Runtime 成功结果'), true);
  assert.equal(html.includes('data-mode="running"'), false);
  assert.equal(html.includes('本地状态已同步'), false);
  assert.equal(html.includes('正在运行'), false);
  assert.equal(html.includes('checkpoint committed'), false);
  assert.equal(readme.includes('明确重定向'), true);
  assert.equal(readme.includes('不呈现静态运行状态'), true);
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
  assert.equal(interaction.includes('api.receiveExplicitInput'), true);
  assert.equal(interaction.includes('api.inspectExplicitInteraction'), true);
  assert.equal(interaction.includes('api.beginExplicitMatching'), true);
  assert.equal(interaction.includes('api.recordExplicitMatch'), true);
  assert.equal(interaction.includes('api.proposeExplicitRequirement'), true);
  assert.equal(interaction.includes('api.completeExplicitStatusQuery'), true);
  assert.equal(interaction.includes('api.confirmExplicitRequirement'), true);
  assert.equal(interaction.includes('api.dispatchNextExplicitRequirement'), true);
  assert.equal(interaction.includes('api.stop'), true);
  assert.equal(interaction.includes('api.startExecution'), true);
  assert.equal(interaction.includes('channel: \'control\''), false);
  assert.equal(interaction.includes('dataset.runtimeState'), false);
  assert.equal(interaction.includes('data-task-status'), false);
  assert.equal(html.includes('type="module" src="./interaction.js"'), true);
  assert.equal(html.includes('data-explicit-input'), true);
  assert.equal(html.includes('data-explicit-confirmation'), true);
  assert.equal(html.includes('data-action="dispatch"'), true);
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

test('new task UI sends one natural-language input to the explicit brain', async () => {
  const source = await readFile('docs/ui/task.js', 'utf8');
  assert.equal(source.includes('title.required'), false);
  assert.equal(source.includes('title.value'), false);
  assert.equal(source.includes('api.createTask'), false);
  assert.equal(source.includes('api.receiveExplicitInput'), true);
  assert.equal(source.includes('api.answerExplicitClarification'), true);
  assert.equal(source.includes('提交给显式大脑'), true);
  assert.equal(source.includes('api.confirmExplicitRequirement(interactionId, {'), true);
  assert.equal(source.includes('确认并提交后台'), false);
  assert.equal(source.includes('api.interpretExplicitInput(interactionId)'), true);
  assert.equal(source.includes('ui:creation:'), true);
  assert.equal(source.includes('normalizedInput: snapshot.rawInput'), false);
  assert.equal(source.includes('matchedTasks: currentTaskId'), false);
  assert.equal(source.includes("proposedIntent: currentTaskId ? 'append' : 'create'"), false);
  assert.equal(source.includes("snapshot.state === 'received' || snapshot.state === 'matching'"), true);
  assert.equal(source.includes("dispatched.requirement?.draftId !== snapshot.draft.draftId"), true);
});

test('runtime task dashboard is observational and has no second execution-input form', async () => {
  const source = await readFile('docs/ui/task-dashboard.js', 'utf8');
  assert.equal(source.includes('本次执行输入'), false);
  assert.equal(source.includes('promptInput'), false);
  assert.equal(source.includes('api.startExecution'), false);
  assert.equal(source.includes('taskDetailHref(taskId)'), true);
  assert.equal(source.includes('进入显式大脑'), true);
});
