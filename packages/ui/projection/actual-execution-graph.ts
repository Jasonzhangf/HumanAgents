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

function projectGuidance(guidance: TaskFlowGuidance): TaskActualExecutionGuidanceProjection {
  const kind = guidance.kind;
  return {
    kind,
    kindLabel: GUIDANCE_KIND_LABELS[kind],
    aim: guidance.aim,
    selectionGuidance: guidance.selectionGuidance,
    displayGroups: guidance.displayGroups.map((group) => DISPLAY_GROUP_LABELS[group] ?? group),
  };
}

function roleLabel(pipelineNodeId: string): string {
  return PIPELINE_ROLE_LABELS[pipelineNodeId] ?? '执行成员';
}

function projectResult(result: WorkResult): TaskActualExecutionMemberProjection['result'] {
  const status = result.status;
  return {
    status,
    statusLabel: RESULT_STATUS_LABELS[status],
    summary: result.summary,
  };
}

function projectReviews(record: AssignmentRecord): readonly TaskActualExecutionReviewProjection[] {
  return record.reviewResults.map((review) => ({
    status: review.status,
    statusLabel: REVIEW_STATUS_LABELS[review.status],
    findingCount: review.findings.length,
  }));
}

function projectMember(record: AssignmentRecord): TaskActualExecutionMemberProjection {
  const status = record.status;
  const presentation = ASSIGNMENT_STATE_PRESENTATION[status];
  const assignment = record.assignment;
  const key = record.key;
  return {
    roleLabel: roleLabel(assignment.pipelineNodeId),
    objective: assignment.objective,
    status,
    statusLabel: presentation.label,
    statusTone: presentation.tone,
    ...(record.result === undefined ? {} : { result: projectResult(record.result) }),
    reviews: projectReviews(record),
    reason: record.reason,
    nextActionKind: record.nextAction.kind,
    nextActionLabel: NEXT_ACTION_LABELS[record.nextAction.kind],
    technical: {
      assignmentId: key.assignmentId,
      attempt: key.attempt,
      executionEpoch: key.executionEpoch,
      pipelineNodeId: assignment.pipelineNodeId,
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
  const state = stage.state;
  const presentation = ASSIGNMENT_STATE_PRESENTATION[state];
  const assignmentKeys = stage.assignmentKeys;
  return {
    stageNodeId: stage.nodeId,
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
  const ownerId = source.stream.ownerId;
  const stages = source.snapshot.stages;
  const assignments = source.snapshot.assignments;
  const stageLabels = new Map(
    stages.map((stage, index) => [stage.nodeId, `阶段 ${index + 1}`]),
  );

  const recordsByStage = new Map<string, AssignmentRecord[]>();
  for (const record of assignments) {
    const group = recordsByStage.get(record.stageNodeId) ?? [];
    group.push(record);
    recordsByStage.set(record.stageNodeId, group);
  }

  return {
    ownerId,
    ownerLabel: `执行分组 ${streamIndex + 1}`,
    stages: stages.map((stage, index) => projectStage(
      stage,
      index,
      stageLabels,
      recordsByStage.get(stage.nodeId) ?? [],
    )),
  };
}

function projectRecordedHistory(
  source: Extract<TaskActualExecutionGraphSnapshot['history'], { readonly status: 'recorded' }>,
): TaskActualExecutionGraphHistoryProjection {
  const streams = source.streams.map((stream, index) => projectStream(stream, index));
  const stageCount = streams.reduce((count, stream) => count + stream.stages.length, 0);
  const memberCount = streams.reduce(
    (count, stream) => count + stream.stages.reduce((sum, stage) => sum + stage.members.length, 0),
    0,
  );
  return {
    status: 'recorded',
    summary: `已记录 ${streams.length} 个执行分组、${stageCount} 个阶段和 ${memberCount} 个执行成员。`,
    streamCount: streams.length,
    stageCount,
    memberCount,
    streams,
  };
}

function projectHistory(
  source: TaskActualExecutionGraphSnapshot['history'],
): TaskActualExecutionGraphHistoryProjection {
  switch (source.status) {
    case 'recorded':
      return projectRecordedHistory(source);
    case 'not-recorded':
      return {
        status: 'not-recorded',
        reason: source.reason,
        label: '暂无执行过程记录',
        detail: '任务计划在计划区单独展示；这里仅展示已记录的执行过程。',
      };
  }
}

/**
 * Convert the P1 source snapshot to the one UI view consumed by both formal
 * task-reading surfaces. The source is typed App output built from verified
 * Journal records and Runtime replay. This function only maps semantics: it
 * never revalidates the graph, derives a stage state, dependency or historical
 * instance from a plan, parent or member status.
 */
export function projectTaskActualExecutionGraph(
  source: TaskActualExecutionGraphSnapshot,
): TaskActualExecutionGraphProjection {
  const taskScope = source.taskScope;
  return {
    surface: 'task-actual-execution-graph',
    taskScope: {
      organId: { ...taskScope.organId },
      taskId: { ...taskScope.taskId },
    },
    ...(source.guidance === undefined ? {} : { guidance: projectGuidance(source.guidance) }),
    history: projectHistory(source.history),
  };
}
