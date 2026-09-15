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

test('UI projection code does not read Journal or DSH session logs', async () => {
  const source = await readFile(join(process.cwd(), 'packages', 'ui', 'projection', 'index.ts'), 'utf8');
  assert.equal(/\bJsonlOrganJournal\b|DSH Session|DSH\s+Session\s+Log|sessionLog/i.test(source), false);
});

test('observation projection supports recursion, drawer details, return, and read-only rules', () => {
  const scopes: Record<string, ObservationScopeSource> = {
    root: {
      scopeRef: 'root',
      title: '任务处理流水',
      summary: '从输入到任务结果的完整处理记录',
      projectionSeq: 'seq-184',
      nodes: [
        {
          nodeId: 'implicit.classify',
          title: '分类和安排任务',
          kind: 'orchestration',
          state: 'running',
          summary: '正在选择处理方式',
          owner: '任务编排',
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
      nodes: [
        {
          nodeId: 'queue.execution',
          title: '执行队列',
          kind: 'execution',
          state: 'waiting',
          summary: '等待条件检查',
          owner: '任务编排',
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
