import type {
  AgentRoleDisplay,
  ReviewStatus,
  TaskActualExecutionActiveTurnNode,
  TaskActualExecutionChildInvocationNode,
  TaskActualExecutionChildReturn,
  TaskActualExecutionClosedTurnPlannerNode,
  TaskActualExecutionGraphEdge,
  TaskActualExecutionGraphEdgeKind,
  TaskActualExecutionGraphNode,
  TaskActualExecutionGraphSnapshot,
  TaskActualExecutionGraphUngroupedRelation,
  TaskActualExecutionMilestoneReviewNode,
  TaskActualExecutionNativeAllocationNode,
  TaskActualExecutionOrphanChildDeliveryNode,
  TaskActualExecutionResumedSegmentNode,
  TaskAgentActivityUnavailableSource,
  TaskFlowGuidance,
  TaskFlowKind,
  WorkResult,
} from '@humanagent/contracts';
import type {
  TaskActualExecutionEdgeSummaryProjection,
  TaskActualExecutionGraphHistoryProjection,
  TaskActualExecutionGraphProjection,
  TaskActualExecutionGroupProjection,
  TaskActualExecutionGuidanceProjection,
  TaskActualExecutionNodeProjection,
  TaskActualExecutionNodeSummaryProjection,
  TaskActualExecutionNodeTechnicalProjection,
  TaskActualExecutionStateTone,
  TaskActualExecutionUngroupedProjection,
  TaskActualExecutionUnavailableProjection,
} from '../contracts/actual-execution-graph.js';

interface StatePresentation {
  readonly label: string;
  readonly tone: TaskActualExecutionStateTone;
}

const WORK_RESULT_PRESENTATION: Readonly<Record<WorkResult['status'], StatePresentation>> = {
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  incomplete: { label: '未完成', tone: 'warning' },
  blocked: { label: '受阻', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

const REVIEW_STATUS_PRESENTATION: Readonly<Record<ReviewStatus, StatePresentation>> = {
  passed: { label: '复核通过', tone: 'success' },
  failed: { label: '复核未通过', tone: 'danger' },
  inconclusive: { label: '复核无法判定', tone: 'warning' },
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

const ROLE_LABELS: Readonly<Record<AgentRoleDisplay, string>> = {
  interaction: '交互',
  orchestration: '编排',
  execution: '执行',
  review: '复核',
  memory: '记忆',
};

const EDGE_KIND_LABELS: Readonly<Record<TaskActualExecutionGraphEdgeKind, string>> = {
  contains: '包含',
  precedes: '接续',
  'delegates-child': '派发子任务',
  'planner-duty': '计划职责',
};

const PLANNER_DECISION_LABELS = {
  continue: '继续',
  complete: '完成',
  failed: '失败',
} as const;

const CONTAINER_PURPOSES: Readonly<Record<
  'active-turn' | 'resumed-segment' | 'native-allocation',
  string
>> = {
  'active-turn': '这一轮业务处理的真实执行记录。',
  'resumed-segment': '同一业务轮次恢复后的独立执行分段。',
  'native-allocation': '已记录的执行入口分配。',
};

const AGGREGATE_GROUPS = {
  allocation: {
    groupId: 'group:native-allocation',
    label: '执行分配',
    purpose: CONTAINER_PURPOSES['native-allocation'],
  },
  review: {
    groupId: 'group:milestone-review',
    label: '里程碑复核',
    purpose: '已记录的里程碑复核。',
  },
  planner: {
    groupId: 'group:closed-turn-planner-call',
    label: '计划核对',
    purpose: '轮次收拢后核对目标并更新计划。',
  },
  ungrouped: {
    groupId: 'group:ungrouped',
    label: '未归组记录',
    purpose: '这些记录无法关联到已出现的执行轮次或分段，仍按原样展示。',
  },
} as const;

function projectGuidance(guidance: TaskFlowGuidance): TaskActualExecutionGuidanceProjection {
  return {
    kind: guidance.kind,
    kindLabel: GUIDANCE_KIND_LABELS[guidance.kind],
    aim: guidance.aim,
    selectionGuidance: guidance.selectionGuidance,
    displayGroups: guidance.displayGroups.map((group) => DISPLAY_GROUP_LABELS[group] ?? group),
  };
}

function currencySuffix(node: TaskActualExecutionGraphNode): string {
  return node.currency === 'historical' ? '（历史）' : '';
}

function withCurrency(node: TaskActualExecutionGraphNode, label: string): string {
  return `${label}${currencySuffix(node)}`;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, undefined, 2) ?? String(value);
}

function technicalEntries(
  entries: readonly (readonly [string, string | number | undefined])[],
): string {
  return entries
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function baseTechnical(
  node: TaskActualExecutionGraphNode,
  message: string,
): TaskActualExecutionNodeTechnicalProjection {
  return {
    nodeId: node.nodeId,
    nodeKind: node.kind,
    taskIdValue: node.taskId.value,
    assignmentId: node.assignmentId,
    commitRefs: node.commitRefs,
    evidenceRefs: node.evidenceRefs,
    ...(node.missingSource === undefined ? {} : { missingSource: node.missingSource }),
    ...(message.length === 0 ? {} : { message }),
  };
}

function instanceTechnical(
  node:
    | TaskActualExecutionNativeAllocationNode
    | TaskActualExecutionActiveTurnNode
    | TaskActualExecutionResumedSegmentNode
    | TaskActualExecutionMilestoneReviewNode,
): Pick<
  TaskActualExecutionNodeTechnicalProjection,
  'instance' | 'executionEpoch' | 'businessTurnId' | 'segmentId' | 'pipelineNodeId'
> {
  return {
    instance: node.instance,
    executionEpoch: node.executionEpoch,
    ...(node.businessTurnId === undefined ? {} : { businessTurnId: node.businessTurnId }),
    ...(node.segmentId === undefined ? {} : { segmentId: node.segmentId }),
    ...(node.pipelineNodeId === undefined ? {} : { pipelineNodeId: node.pipelineNodeId }),
  };
}

function projectNativeAllocation(
  node: TaskActualExecutionNativeAllocationNode,
  unresolved: string,
): {
  summary: TaskActualExecutionNodeSummaryProjection;
  technical: TaskActualExecutionNodeTechnicalProjection;
} {
  const allocation = node.allocation;
  const role = allocation.role === undefined ? '执行成员' : `${ROLE_LABELS[allocation.role]}成员`;
  return {
    summary: {
      roleLabel: role,
      objective: node.objective,
      stateLabel: withCurrency(node, '已记录'),
      stateTone: 'neutral',
      ...(allocation.orchestrated ? {} : { reason: '这条分配未标记为编排派发。' }),
    },
    technical: {
      ...baseTechnical(node, technicalEntries([
        ['allocation', serialize({
          runtimeId: allocation.runtimeId,
          operationId: allocation.operationId,
          ownerId: allocation.ownerId,
          directiveRevision: allocation.directiveRevision,
          inputRevision: allocation.inputRevision,
          orchestrated: allocation.orchestrated,
          scope: allocation.scope,
          inputRefs: allocation.inputRefs,
          configuredAgentId: allocation.configuredAgentId,
        })],
        ['unresolved', unresolved],
      ])),
      ...instanceTechnical(node),
    },
  };
}

function projectActiveTurn(
  node: TaskActualExecutionActiveTurnNode,
  unresolved: string,
): {
  summary: TaskActualExecutionNodeSummaryProjection;
  technical: TaskActualExecutionNodeTechnicalProjection;
} {
  const closure = node.businessClosure;
  const closureRecorded = closure.status === 'recorded';
  return {
    summary: {
      roleLabel: '执行轮次',
      objective: node.objective ?? node.binding.assignment.objective,
      stateLabel: withCurrency(node, closureRecorded ? '业务已收拢' : '收拢情况未知'),
      stateTone: closureRecorded ? 'success' : 'neutral',
      ...(closureRecorded
        ? {
          outcomeLabel: '业务已收拢',
          resultSummary: closure.closure.summary.result.text,
          nextActionLabel: closure.closure.summary.expectedNextStep.text,
        }
        : { reason: '该业务轮次的收拢情况尚未确认。' }),
    },
    technical: {
      ...baseTechnical(node, technicalEntries([
        ['binding', serialize(node.binding)],
        ['bindingCommitRef', serialize(node.bindingCommitRef)],
        ['businessClosure', serialize(node.businessClosure)],
        ['unresolved', unresolved],
      ])),
      ...instanceTechnical(node),
    },
  };
}

function projectResumedSegment(
  node: TaskActualExecutionResumedSegmentNode,
  unresolved: string,
): {
  summary: TaskActualExecutionNodeSummaryProjection;
  technical: TaskActualExecutionNodeTechnicalProjection;
} {
  const segmentState = node.segmentState;
  const hasTerminal = node.terminalCommitRefs.length > 0;
  const stateLabel = segmentState.status === 'unknown'
    ? '状态未知'
    : hasTerminal
      ? '已记录结束'
      : '进行中';
  return {
    summary: {
      roleLabel: '恢复分段',
      ...(node.objective === undefined ? {} : { objective: node.objective }),
      stateLabel: withCurrency(node, stateLabel),
      stateTone: segmentState.status === 'unknown' ? 'neutral' : hasTerminal ? 'neutral' : 'active',
      ...(hasTerminal ? { outcomeLabel: '已记录结束' } : {}),
      ...(segmentState.status === 'unknown'
        ? { reason: '该恢复分段的执行状态尚未确认。' }
        : hasTerminal
          ? {}
          : { reason: '尚未记录该分段的结束。' }),
    },
    technical: {
      ...baseTechnical(node, technicalEntries([
        ['opened', serialize(node.opened)],
        ['openedCommitRef', serialize(node.openedCommitRef)],
        ['terminalCommitRefs', serialize(node.terminalCommitRefs)],
        ['segmentState', serialize(node.segmentState)],
        ['unresolved', unresolved],
      ])),
      ...instanceTechnical(node),
    },
  };
}

function childResultPresentation(
  returnState: TaskActualExecutionChildReturn,
): StatePresentation | undefined {
  if (returnState.status !== 'returned') return undefined;
  return returnState.delivery.kind === 'execution'
    ? WORK_RESULT_PRESENTATION[returnState.delivery.result.status]
    : REVIEW_STATUS_PRESENTATION[returnState.delivery.result.status];
}

function childResultSummary(node: TaskActualExecutionChildInvocationNode): string | undefined {
  const returnState = node.returnState;
  if (returnState.status !== 'returned') return undefined;
  if (returnState.delivery.kind === 'execution') return returnState.delivery.result.summary;
  const findings = returnState.delivery.result.findings.length;
  return findings === 0 ? '未发现问题' : `发现 ${findings} 项问题`;
}

function childStatePresentation(
  node: TaskActualExecutionChildInvocationNode,
): StatePresentation {
  const returned = childResultPresentation(node.returnState);
  if (returned !== undefined) return returned;
  if (node.returnState.status === 'unknown') {
    return { label: '返回情况未知', tone: 'neutral' };
  }
  if (node.acquisition.status === 'unacquired') {
    return { label: '未取得执行实例', tone: 'warning' };
  }
  if (node.acquisition.status === 'unknown') {
    return { label: '执行实例未知', tone: 'neutral' };
  }
  return { label: '已派发，等待返回', tone: 'active' };
}

function childReason(node: TaskActualExecutionChildInvocationNode): string | undefined {
  if (node.returnState.status === 'unknown') return '子任务返回情况尚未确认。';
  if (node.returnState.status === 'unreturned' && node.acquisition.status === 'unacquired') {
    return '该调用暂未取得执行实例。';
  }
  if (node.returnState.status === 'unreturned' && node.acquisition.status === 'unknown') {
    return '该调用的执行实例情况尚未确认。';
  }
  if (node.linkage.status === 'ungrouped') return '该调用尚未归入执行轮次或恢复分段。';
  return undefined;
}

function childAdoptionLabel(node: TaskActualExecutionChildInvocationNode): string | undefined {
  switch (node.adoption.status) {
    case 'adopted':
      return '结果已采用';
    case 'not-selected':
      return '结果未被采用';
    case 'undecided':
      return '采用决定尚未记录';
    case 'unknown':
      return '采用情况未知';
  }
}

function projectChildInvocation(
  node: TaskActualExecutionChildInvocationNode,
  unresolved: string,
): {
  summary: TaskActualExecutionNodeSummaryProjection;
  technical: TaskActualExecutionNodeTechnicalProjection;
} {
  const state = childStatePresentation(node);
  const objective = node.objective
    ?? (node.record.binding.kind === 'execution' ? node.record.binding.assignment.objective : undefined);
  const adoptionLabel = childAdoptionLabel(node);
  const reason = childReason(node);
  return {
    summary: {
      roleLabel: node.callKind === 'execution' ? '子任务执行' : '子任务复核',
      ...(objective === undefined ? {} : { objective }),
      stateLabel: withCurrency(node, state.label),
      stateTone: state.tone,
      ...(childResultPresentation(node.returnState) === undefined
        ? {}
        : { outcomeLabel: state.label }),
      ...(childResultSummary(node) === undefined
        ? {}
        : { resultSummary: childResultSummary(node) }),
      ...(adoptionLabel === undefined ? {} : { adoptionLabel }),
      ...(reason === undefined ? {} : { reason }),
    },
    technical: {
      ...baseTechnical(node, technicalEntries([
        ['invocation', serialize({
          invocationId: node.invocationId,
          childTurnId: node.childTurnId,
          checkpointReceiptRef: node.checkpointReceiptRef,
          containingLocation: node.containingLocation,
          linkage: node.linkage,
          acquisition: node.acquisition,
          adoption: node.adoption,
          record: node.record,
        })],
        ['invocationCommitRef', serialize(node.invocationCommitRef)],
        ['returnState', serialize(node.returnState)],
        ['unresolved', unresolved],
      ])),
      invocationId: node.invocationId,
      childTurnId: node.childTurnId,
      checkpointReceiptRef: node.checkpointReceiptRef,
      containingLocationKind: node.containingLocation.kind,
      containingLocationBusinessTurnId: node.containingLocation.businessTurnId,
      ...(node.containingLocation.kind === 'resumed-segment'
        ? { containingLocationSegmentId: node.containingLocation.segmentId }
        : {}),
      ...(node.record.incarnation === undefined
        ? {}
        : {
          instance: {
            kind: 'incarnation',
            incarnation: node.record.incarnation,
          },
        }),
    },
  };
}

function projectOrphanDelivery(
  node: TaskActualExecutionOrphanChildDeliveryNode,
  unresolved: string,
): {
  summary: TaskActualExecutionNodeSummaryProjection;
  technical: TaskActualExecutionNodeTechnicalProjection;
} {
  const delivery = node.delivery;
  const outcome = delivery.kind === 'execution'
    ? WORK_RESULT_PRESENTATION[delivery.result.status]
    : REVIEW_STATUS_PRESENTATION[delivery.result.status];
  const resultSummary = delivery.kind === 'execution'
    ? delivery.result.summary
    : delivery.result.findings.length === 0
      ? '未发现问题'
      : `发现 ${delivery.result.findings.length} 项问题`;
  return {
    summary: {
      roleLabel: node.callKind === 'execution' ? '未归组的子任务结果' : '未归组的复核结果',
      stateLabel: withCurrency(node, '未关联到调用记录'),
      stateTone: 'warning',
      outcomeLabel: outcome.label,
      resultSummary,
      reason: '调用记录未找到，结果仍按原样保留。',
    },
    technical: {
      ...baseTechnical(node, technicalEntries([
        ['delivery', serialize({
          invocationId: node.invocationId,
          deliverySeq: node.deliverySeq,
          containingCommitRef: node.containingCommitRef,
          containingLocation: node.containingLocation,
          linkage: node.linkage,
          delivery: node.delivery,
        })],
        ['unresolved', unresolved],
      ])),
      invocationId: node.invocationId,
      ...(node.containingLocation === undefined
        ? {}
        : {
          containingLocationKind: node.containingLocation.kind,
          containingLocationBusinessTurnId: node.containingLocation.businessTurnId,
          ...(node.containingLocation.kind === 'resumed-segment'
            ? { containingLocationSegmentId: node.containingLocation.segmentId }
            : {}),
        }),
    },
  };
}

function projectMilestoneReview(
  node: TaskActualExecutionMilestoneReviewNode,
  unresolved: string,
): {
  summary: TaskActualExecutionNodeSummaryProjection;
  technical: TaskActualExecutionNodeTechnicalProjection;
} {
  const result = node.record.delivery.result;
  const presentation = REVIEW_STATUS_PRESENTATION[result.status];
  return {
    summary: {
      roleLabel: '里程碑复核',
      ...(node.objective === undefined ? {} : { objective: node.objective }),
      stateLabel: withCurrency(node, presentation.label),
      stateTone: presentation.tone,
      outcomeLabel: presentation.label,
      resultSummary: result.findings.length === 0
        ? '未发现问题'
        : `发现 ${result.findings.length} 项问题`,
    },
    technical: {
      ...baseTechnical(node, technicalEntries([
        ['reviewCommitRef', serialize(node.reviewCommitRef)],
        ['record', serialize(node.record)],
        ['unresolved', unresolved],
      ])),
      ...instanceTechnical(node),
    },
  };
}

function projectPlannerCall(
  node: TaskActualExecutionClosedTurnPlannerNode,
  unresolved: string,
): {
  summary: TaskActualExecutionNodeSummaryProjection;
  technical: TaskActualExecutionNodeTechnicalProjection;
} {
  const stageLabel = node.stage === 'prepared'
    ? '准备完成'
    : node.stage === 'invoked'
      ? '已发起'
      : '已返回';
  const stageTone: TaskActualExecutionStateTone = node.stage === 'invoked' ? 'active' : 'neutral';
  const decision = node.planRevision === undefined
    ? undefined
    : PLANNER_DECISION_LABELS[node.planRevision.decision];
  const decisionTone: TaskActualExecutionStateTone | undefined = node.planRevision === undefined
    ? undefined
    : node.planRevision.decision === 'complete'
      ? 'success'
      : node.planRevision.decision === 'failed'
        ? 'danger'
        : 'active';
  return {
    summary: {
      roleLabel: '计划核对',
      ...(node.objective === undefined ? {} : { objective: node.objective }),
      stateLabel: withCurrency(node, stageLabel),
      stateTone: decisionTone ?? stageTone,
      ...(decision === undefined ? {} : { decisionLabel: decision }),
    },
    technical: {
      ...baseTechnical(node, technicalEntries([
        ['plannerCall', serialize({
          stage: node.stage,
          dutyKey: node.dutyKey,
          invocationId: node.invocationId,
          scope: node.scope,
          checkpointId: node.checkpointId,
          closureRef: node.closureRef,
          planRevision: node.planRevision,
        })],
        ['checkpointCommitRef', serialize(node.checkpointCommitRef)],
        ['closureCommitRef', serialize(node.closureCommitRef)],
        ['grantCommitRef', serialize(node.grantCommitRef)],
        ['admissionCommitRef', serialize(node.admissionCommitRef)],
        ['preparationCommitRef', serialize(node.preparationCommitRef)],
        ['invocationCommitRef', serialize(node.invocationCommitRef)],
        ['returnCommitRef', serialize(node.returnCommitRef)],
        ['unresolved', unresolved],
      ])),
      invocationId: node.invocationId,
      executionEpoch: node.execution.executionEpoch,
      instance: node.instance,
      ...(node.businessTurnId === undefined ? {} : { businessTurnId: node.businessTurnId }),
      ...(node.segmentId === undefined ? {} : { segmentId: node.segmentId }),
    },
  };
}

function projectNode(
  node: TaskActualExecutionGraphNode,
  unresolvedRelations: readonly TaskActualExecutionGraphUngroupedRelation[],
): TaskActualExecutionNodeProjection {
  const unresolved = unresolvedRelations
    .filter((relation) => relation.nodeId === node.nodeId)
    .map((relation) => `${EDGE_KIND_LABELS[relation.kind]}关系未归组`)
    .join('\n');
  const projected = (() => {
    switch (node.kind) {
      case 'native-allocation':
        return projectNativeAllocation(node, unresolved);
      case 'active-turn':
        return projectActiveTurn(node, unresolved);
      case 'resumed-segment':
        return projectResumedSegment(node, unresolved);
      case 'child-invocation':
        return projectChildInvocation(node, unresolved);
      case 'orphan-child-delivery':
        return projectOrphanDelivery(node, unresolved);
      case 'milestone-review':
        return projectMilestoneReview(node, unresolved);
      case 'closed-turn-planner-call':
        return projectPlannerCall(node, unresolved);
    }
  })();
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    summary: projected.summary,
    technical: projected.technical,
  };
}

function nodeDisplayLabel(node: TaskActualExecutionGraphNode): string {
  switch (node.kind) {
    case 'native-allocation':
      return '执行分配';
    case 'active-turn':
      return '执行轮次';
    case 'resumed-segment':
      return '恢复分段';
    case 'child-invocation':
      return node.callKind === 'execution' ? '子任务执行' : '子任务复核';
    case 'orphan-child-delivery':
      return node.callKind === 'execution' ? '未归组的子任务结果' : '未归组的复核结果';
    case 'milestone-review':
      return '里程碑复核';
    case 'closed-turn-planner-call':
      return '计划核对';
  }
}

function edgeSummary(
  edge: TaskActualExecutionGraphEdge,
  nodeById: ReadonlyMap<string, TaskActualExecutionGraphNode>,
): TaskActualExecutionEdgeSummaryProjection {
  const from = nodeById.get(edge.fromNodeId);
  const to = nodeById.get(edge.toNodeId);
  const label = EDGE_KIND_LABELS[edge.kind];
  const fromLabel = from === undefined ? '未记录节点' : nodeDisplayLabel(from);
  const toLabel = to === undefined ? '未记录节点' : nodeDisplayLabel(to);
  return {
    edgeId: edge.edgeId,
    kind: edge.kind,
    label,
    detail: `${fromLabel}${label}${toLabel}`,
  };
}

function projectUngroupedRelation(
  relation: TaskActualExecutionGraphUngroupedRelation,
): TaskActualExecutionUngroupedProjection {
  return {
    nodeId: relation.nodeId,
    label: `${EDGE_KIND_LABELS[relation.kind]}关系未归组`,
    detail: relation.reason,
  };
}

function projectUnavailable(
  source: TaskAgentActivityUnavailableSource,
): TaskActualExecutionUnavailableProjection {
  return {
    sourceId: source.sourceId,
    label: '部分执行来源不可用',
    detail: source.message,
  };
}

interface GroupDraft {
  readonly groupId: string;
  readonly label: string;
  readonly purpose: string;
  readonly nodes: readonly TaskActualExecutionGraphNode[];
}

function childParentId(node: TaskActualExecutionGraphNode): string | undefined {
  if (node.kind !== 'child-invocation') return undefined;
  return node.linkage.status === 'linked' ? node.linkage.parentNodeId : undefined;
}

function buildGroupDrafts(
  nodes: readonly TaskActualExecutionGraphNode[],
  edges: readonly TaskActualExecutionGraphEdge[],
): readonly GroupDraft[] {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenByParent = new Map<string, string[]>();
  const addChild = (parentId: string, childId: string): void => {
    if (!nodeById.has(parentId) || !nodeById.has(childId) || parentId === childId) return;
    const current = childrenByParent.get(parentId) ?? [];
    if (current.includes(childId)) return;
    current.push(childId);
    childrenByParent.set(parentId, current);
  };
  for (const edge of edges) {
    if (edge.kind === 'contains') addChild(edge.fromNodeId, edge.toNodeId);
  }
  for (const node of nodes) {
    const parentId = childParentId(node);
    if (parentId !== undefined) addChild(parentId, node.nodeId);
  }

  const containerNodeIds = new Set(nodes.filter((node) => (
    node.kind === 'active-turn'
    || node.kind === 'resumed-segment'
    || (node.kind === 'native-allocation' && (childrenByParent.get(node.nodeId)?.length ?? 0) > 0)
  )).map((node) => node.nodeId));
  const containerNodes = nodes.filter((node) => containerNodeIds.has(node.nodeId));
  const containerCounts = new Map<string, number>();
  for (const node of containerNodes) {
    containerCounts.set(node.kind, (containerCounts.get(node.kind) ?? 0) + 1);
  }
  const containerOrdinals = new Map<string, number>();
  const drafts: GroupDraft[] = [];
  const assignedNodeIds = new Set<string>();
  for (const node of containerNodes) {
    assignedNodeIds.add(node.nodeId);
    const ordinal = (containerOrdinals.get(node.kind) ?? 0) + 1;
    containerOrdinals.set(node.kind, ordinal);
    const numbered = (containerCounts.get(node.kind) ?? 0) > 1;
    const baseLabel = node.kind === 'active-turn'
      ? '执行轮次'
      : node.kind === 'resumed-segment'
        ? '恢复分段'
        : '执行分配';
    const children = (childrenByParent.get(node.nodeId) ?? []).flatMap((childId) => {
      if (containerNodeIds.has(childId) || assignedNodeIds.has(childId)) return [];
      const child = nodeById.get(childId);
      if (child === undefined) return [];
      assignedNodeIds.add(childId);
      return [child];
    });
    drafts.push({
      groupId: node.nodeId,
      label: numbered ? `${baseLabel} ${ordinal}` : baseLabel,
      purpose: CONTAINER_PURPOSES[
        node.kind === 'active-turn'
          ? 'active-turn'
          : node.kind === 'resumed-segment'
            ? 'resumed-segment'
            : 'native-allocation'
      ],
      nodes: [node, ...children],
    });
  }

  const leftovers = nodes.filter((node) => !assignedNodeIds.has(node.nodeId));
  const allocation = leftovers.filter((node) => node.kind === 'native-allocation');
  const reviews = leftovers.filter((node) => node.kind === 'milestone-review');
  const planners = leftovers.filter((node) => node.kind === 'closed-turn-planner-call');
  const ungrouped = leftovers.filter((node) => (
    node.kind === 'orphan-child-delivery'
    || node.kind === 'child-invocation'
  ));
  if (allocation.length > 0) drafts.push({ ...AGGREGATE_GROUPS.allocation, nodes: allocation });
  if (reviews.length > 0) drafts.push({ ...AGGREGATE_GROUPS.review, nodes: reviews });
  if (planners.length > 0) drafts.push({ ...AGGREGATE_GROUPS.planner, nodes: planners });
  if (ungrouped.length > 0) drafts.push({ ...AGGREGATE_GROUPS.ungrouped, nodes: ungrouped });
  return drafts;
}

function projectRecordedHistory(
  source: Extract<TaskActualExecutionGraphSnapshot['history'], { readonly status: 'recorded' }>,
): TaskActualExecutionGraphHistoryProjection {
  const nodeById = new Map(source.nodes.map((node) => [node.nodeId, node]));
  const drafts = buildGroupDrafts(source.nodes, source.edges);
  const groups: TaskActualExecutionGroupProjection[] = drafts.map((draft) => ({
    groupId: draft.groupId,
    label: draft.label,
    purpose: draft.purpose,
    nodes: draft.nodes.map((node) => projectNode(node, source.ungrouped)),
  }));
  const nodeCount = groups.reduce((count, group) => count + group.nodes.length, 0);
  const deliveryCount = source.nodes.reduce((count, node) => {
    if (node.kind === 'orphan-child-delivery') return count + 1;
    if (node.kind === 'child-invocation' && node.returnState.status === 'returned') return count + 1;
    return count;
  }, 0);
  return {
    status: 'recorded',
    summary: `已记录 ${groups.length} 个执行分组和 ${source.nodes.length} 条执行记录${deliveryCount === 0 ? '' : `，其中 ${deliveryCount} 条子任务结果已返回`}。`,
    groupCount: groups.length,
    nodeCount,
    edgeCount: source.edges.length,
    groups,
    edges: source.edges.map((edge) => edgeSummary(edge, nodeById)),
    ungrouped: source.ungrouped.map(projectUngroupedRelation),
    unavailable: source.unavailable.map(projectUnavailable),
    recordCount: source.nodes.length,
    deliveryCount,
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
        ...(source.unavailable === undefined
          ? {}
          : { unavailable: source.unavailable.map(projectUnavailable) }),
      };
  }
}

/**
 * Convert the native actual-execution source snapshot to the one UI view
 * consumed by both formal task-reading surfaces. This function only maps
 * recorded facts into human-readable groups and relations. It never derives a
 * state, a dependency or a physical completion from a plan, a role, a
 * timestamp, an ownership currency or a business closure.
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
