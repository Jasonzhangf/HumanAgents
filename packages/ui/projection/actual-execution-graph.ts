import type {
  AssignmentRecord,
  AssignmentStageNode,
  AssignmentStatus,
  RecordedAssignmentGraphStream,
  TaskActualExecutionGraphSnapshot,
  TaskFlowGuidance,
  TaskFlowKind,
  WorkResult,
} from '@humanagent/contracts';
import { UiProjectionError } from '../contracts/models.js';
import type {
  TaskActualExecutionGraphHistoryProjection,
  TaskActualExecutionGraphProjection,
  TaskActualExecutionGuidanceProjection,
  TaskActualExecutionMemberProjection,
  TaskActualExecutionReviewProjection,
  TaskActualExecutionStageParentProjection,
  TaskActualExecutionStageProjection,
  TaskActualExecutionStateTone,
  TaskActualExecutionStreamProjection,
} from '../contracts/actual-execution-graph.js';

interface StatePresentation {
  readonly label: string;
  readonly tone: TaskActualExecutionStateTone;
}

const ASSIGNMENT_STATE_PRESENTATION: Readonly<Record<AssignmentStatus, StatePresentation>> = {
  planned: { label: '待安排', tone: 'neutral' },
  assigned: { label: '已分配', tone: 'neutral' },
  running: { label: '进行中', tone: 'active' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  incomplete: { label: '未完成', tone: 'warning' },
  blocked: { label: '受阻', tone: 'danger' },
  retryable: { label: '可重试', tone: 'warning' },
  escalated: { label: '已升级', tone: 'warning' },
  merged: { label: '已合并', tone: 'success' },
};

const RESULT_STATUS_LABELS: Readonly<Record<WorkResult['status'], string>> = {
  succeeded: '已完成',
  failed: '失败',
  incomplete: '未完成',
  blocked: '受阻',
  cancelled: '已取消',
};

const REVIEW_STATUS_LABELS: Readonly<Record<TaskActualExecutionReviewProjection['status'], string>> = {
  passed: '通过',
  failed: '未通过',
  inconclusive: '无法判定',
};

const NEXT_ACTION_LABELS: Readonly<Record<AssignmentRecord['nextAction']['kind'], string>> = {
  continue: '继续',
  wait: '等待',
  stop: '停止',
  recover: '恢复',
};

const GUIDANCE_KIND_LABELS: Readonly<Record<TaskFlowKind, string>> = {
  'one-shot': '单次交付',
  inspection: '巡检',
  'long-running': '长程任务',
};

const DISPLAY_GROUP_LABELS: Readonly<Record<string, string>> = {
  Deliverable: '交付物',
  Review: '复核',
  Closure: '收拢',
  'Check Definition': '检查定义',
  Results: '检查结果',
  Findings: '发现',
  Action: '处置',
  History: '历史',
  'Current Part': '当前部分',
  'Plan Update': '计划更新',
};

const PIPELINE_ROLE_LABELS: Readonly<Record<string, string>> = {
  'pipeline.execute': '执行',
  'child.execution': '子任务执行',
  'child.review': '子任务复核',
};

function fail(message: string): never {
  throw new UiProjectionError(message);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function requireAssignmentStatus(value: unknown, label: string): AssignmentStatus {
  if (typeof value !== 'string'
    || !(ASSIGNMENT_STATE_PRESENTATION as Readonly<Record<string, StatePresentation | undefined>>)[value]) {
    fail(`${label} has an unknown assignment status`);
  }
  return value as AssignmentStatus;
}

function requireResultStatus(value: unknown, label: string): WorkResult['status'] {
  if (typeof value !== 'string'
    || !(RESULT_STATUS_LABELS as Readonly<Record<string, string | undefined>>)[value]) {
    fail(`${label} has an unknown result status`);
  }
  return value as WorkResult['status'];
}

function requireReviewStatus(value: unknown, label: string): TaskActualExecutionReviewProjection['status'] {
  if (typeof value !== 'string'
    || !(REVIEW_STATUS_LABELS as Readonly<Record<string, string | undefined>>)[value]) {
    fail(`${label} has an unknown review status`);
  }
  return value as TaskActualExecutionReviewProjection['status'];
}

function requireNextAction(value: unknown): AssignmentRecord['nextAction']['kind'] {
  if (typeof value !== 'string'
    || !(NEXT_ACTION_LABELS as Readonly<Record<string, string | undefined>>)[value]) {
    fail('assignment next action is unknown');
  }
  return value as AssignmentRecord['nextAction']['kind'];
}

function guidanceKind(kind: unknown): TaskFlowKind {
  if (typeof kind !== 'string'
    || !(GUIDANCE_KIND_LABELS as Readonly<Record<string, string | undefined>>)[kind]) {
    fail('task-flow guidance has an unknown kind');
  }
  return kind as TaskFlowKind;
}

function projectGuidance(guidance: TaskFlowGuidance): TaskActualExecutionGuidanceProjection {
  const kind = guidanceKind(guidance.kind);
  const displayGroups = requireArray(guidance.displayGroups, 'guidance displayGroups')
    .map((group) => requireText(group, 'guidance display group'));
  return {
    kind,
    kindLabel: GUIDANCE_KIND_LABELS[kind],
    aim: requireText(guidance.aim, 'guidance aim'),
    selectionGuidance: requireText(guidance.selectionGuidance, 'guidance selectionGuidance'),
    displayGroups: displayGroups.map((group) => DISPLAY_GROUP_LABELS[group] ?? group),
  };
}

function roleLabel(pipelineNodeId: string): string {
  return PIPELINE_ROLE_LABELS[pipelineNodeId] ?? '执行成员';
}

function projectResult(result: WorkResult): TaskActualExecutionMemberProjection['result'] {
  const status = requireResultStatus(result.status, 'assignment result');
  return {
    status,
    statusLabel: RESULT_STATUS_LABELS[status],
    summary: requireText(result.summary, 'assignment result summary'),
  };
}

function projectReviews(record: AssignmentRecord): readonly TaskActualExecutionReviewProjection[] {
  return requireArray(record.reviewResults, 'assignment reviewResults').map((entry, index) => {
    if (!entry || typeof entry !== 'object') fail(`assignment review result ${index + 1} is invalid`);
    const review = entry as { readonly status?: unknown; readonly findings?: unknown };
    const status = requireReviewStatus(review.status, `assignment review result ${index + 1}`);
    const findings = requireArray(review.findings, `assignment review result ${index + 1} findings`);
    return {
      status,
      statusLabel: REVIEW_STATUS_LABELS[status],
      findingCount: findings.length,
    };
  });
}

function projectMember(record: AssignmentRecord): TaskActualExecutionMemberProjection {
  const status = requireAssignmentStatus(record.status, 'assignment');
  const presentation = ASSIGNMENT_STATE_PRESENTATION[status];
  const assignment = record.assignment;
  if (!assignment || typeof assignment !== 'object') fail('assignment record has no WorkAssignment');
  const key = record.key;
  if (!key || typeof key !== 'object') fail('assignment record has no key');
  const nextAction = requireNextAction(record.nextAction?.kind);
  return {
    roleLabel: roleLabel(requireText(assignment.pipelineNodeId, 'assignment pipelineNodeId')),
    objective: requireText(assignment.objective, 'assignment objective'),
    status,
    statusLabel: presentation.label,
    statusTone: presentation.tone,
    ...(record.result === undefined ? {} : { result: projectResult(record.result) }),
    reviews: projectReviews(record),
    reason: typeof record.reason === 'string' ? record.reason : '',
    nextActionLabel: NEXT_ACTION_LABELS[nextAction],
    technical: {
      assignmentId: requireText(key.assignmentId, 'assignment key id'),
      attempt: key.attempt,
      executionEpoch: key.executionEpoch,
      pipelineNodeId: requireText(assignment.pipelineNodeId, 'assignment pipelineNodeId'),
      ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
      evidenceRefs: record.evidenceRefs,
    },
  };
}

function projectParent(
  parentNodeId: string | null,
  stageLabels: ReadonlyMap<string, string>,
): TaskActualExecutionStageParentProjection {
  if (parentNodeId === null) return { kind: 'none', label: '无上级阶段' };
  const label = stageLabels.get(parentNodeId);
  return label === undefined
    ? { kind: 'missing', parentNodeId, label: '上级阶段未记录' }
    : { kind: 'recorded', stageNodeId: parentNodeId, label: `上级阶段：${label}` };
}

function projectStage(
  stage: AssignmentStageNode,
  stageIndex: number,
  stageLabels: ReadonlyMap<string, string>,
  records: readonly AssignmentRecord[],
): TaskActualExecutionStageProjection {
  const state = requireAssignmentStatus(stage.state, 'stage');
  const presentation = ASSIGNMENT_STATE_PRESENTATION[state];
  const assignmentKeys = requireArray(stage.assignmentKeys, 'stage assignmentKeys')
    .map((key) => requireText(key, 'stage assignment key'));
  if (assignmentKeys.length !== records.length) {
    fail(`stage ${stage.nodeId} assignment key count does not match its recorded members`);
  }
  return {
    stageNodeId: requireText(stage.nodeId, 'stage node id'),
    label: `阶段 ${stageIndex + 1}`,
    state,
    stateLabel: presentation.label,
    stateTone: presentation.tone,
    parent: projectParent(stage.parentNodeId, stageLabels),
    members: records.map(projectMember),
    technical: {
      parentNodeId: stage.parentNodeId,
      assignmentKeys,
    },
  };
}

function projectStream(
  source: RecordedAssignmentGraphStream,
  streamIndex: number,
): TaskActualExecutionStreamProjection {
  const ownerId = requireText(source.stream.ownerId, 'assignment graph stream owner');
  const stages = requireArray(source.snapshot.stages, 'assignment graph stages');
  const assignments = requireArray(source.snapshot.assignments, 'assignment graph assignments');
  if (stages.length === 0) fail(`assignment graph stream ${ownerId} has no recorded stages`);

  const stageLabels = new Map<string, string>();
  for (const [index, value] of stages.entries()) {
    if (!value || typeof value !== 'object') fail(`assignment graph stage ${index + 1} is invalid`);
    const stage = value as { readonly nodeId?: unknown; readonly taskId?: { readonly value?: unknown } };
    const stageNodeId = requireText(stage.nodeId, `assignment graph stage ${index + 1} node id`);
    if (stageLabels.has(stageNodeId)) fail(`assignment graph has duplicate stage ${stageNodeId}`);
    if (stage.taskId?.value !== source.stream.taskScope.taskId.value) {
      fail(`assignment graph stage ${stageNodeId} belongs to another task`);
    }
    stageLabels.set(stageNodeId, `阶段 ${index + 1}`);
  }

  const recordsByStage = new Map<string, AssignmentRecord[]>();
  const seenKeys = new Set<string>();
  for (const value of assignments) {
    if (!value || typeof value !== 'object') fail('assignment graph assignment is invalid');
    const record = value as AssignmentRecord;
    const key = record.key;
    if (!key || typeof key !== 'object') fail('assignment graph assignment has no key');
    const keyText = `${String(key.assignmentId)}\u0000${String(key.attempt)}\u0000${String(key.executionEpoch)}`;
    if (seenKeys.has(keyText)) fail('assignment graph has a duplicate assignment key');
    seenKeys.add(keyText);
    if (!stageLabels.has(record.stageNodeId)) {
      fail(`assignment ${key.assignmentId} belongs to an unrecorded stage`);
    }
    if (record.assignment?.taskId?.value !== source.stream.taskScope.taskId.value) {
      fail(`assignment ${key.assignmentId} belongs to another task`);
    }
    const group = recordsByStage.get(record.stageNodeId) ?? [];
    group.push(record);
    recordsByStage.set(record.stageNodeId, group);
  }

  return {
    ownerId,
    ownerLabel: `责任流 ${streamIndex + 1}`,
    stages: stages.map((value, index) => {
      const stage = value as AssignmentStageNode;
      return projectStage(
        stage,
        index,
        stageLabels,
        recordsByStage.get(stage.nodeId) ?? [],
      );
    }),
  };
}

function projectRecordedHistory(
  source: Extract<TaskActualExecutionGraphSnapshot['history'], { readonly status: 'recorded' }>,
): TaskActualExecutionGraphHistoryProjection {
  const sourceStreams = requireArray(source.streams, 'recorded assignment graph streams');
  if (sourceStreams.length === 0) fail('recorded assignment graph has no owner streams');
  const streams = sourceStreams.map((stream, index) => projectStream(
    stream as RecordedAssignmentGraphStream,
    index,
  ));
  const stageCount = streams.reduce((count, stream) => count + stream.stages.length, 0);
  const memberCount = streams.reduce(
    (count, stream) => count + stream.stages.reduce((sum, stage) => sum + stage.members.length, 0),
    0,
  );
  return {
    status: 'recorded',
    summary: `已记录 ${streams.length} 个责任流、${stageCount} 个阶段和 ${memberCount} 个执行成员。`,
    streamCount: streams.length,
    stageCount,
    memberCount,
    streams,
  };
}

/**
 * Convert the P1 source snapshot to the one UI view consumed by both formal
 * task-reading surfaces. This function is pure and never derives a stage state,
 * dependency or historical instance from a plan, parent or member status.
 */
export function projectTaskActualExecutionGraph(
  source: TaskActualExecutionGraphSnapshot,
): TaskActualExecutionGraphProjection {
  if (!source || typeof source !== 'object') fail('actual execution graph source is required');
  const taskScope = source.taskScope;
  if (!taskScope || typeof taskScope !== 'object') fail('actual execution graph task scope is required');
  requireText(taskScope.organId?.value, 'actual execution graph organ id');
  requireText(taskScope.taskId?.value, 'actual execution graph task id');

  const history = source.history;
  if (!history || typeof history !== 'object') fail('actual execution graph history is required');
  let projectedHistory: TaskActualExecutionGraphHistoryProjection;
  if (history.status === 'recorded') {
    projectedHistory = projectRecordedHistory(history);
  } else if (history.status === 'not-recorded' && history.reason === 'no-recorded-facts') {
    projectedHistory = {
      status: 'not-recorded',
      reason: 'no-recorded-facts',
      label: '实际执行记录缺失',
      detail: '这段历史没有记录实际执行图事实，不能把计划或固定节点目录当作执行记录。',
    };
  } else {
    fail('actual execution graph history status is invalid');
  }

  return {
    surface: 'task-actual-execution-graph',
    taskScope: {
      organId: { ...taskScope.organId },
      taskId: { ...taskScope.taskId },
    },
    ...(source.guidance === undefined ? {} : { guidance: projectGuidance(source.guidance) }),
    history: projectedHistory,
  };
}
