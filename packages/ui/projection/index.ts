import type {
  EvidenceRef,
  LifecycleState,
  Task,
  TaskId,
  TaskOutput,
} from '@humanagent/contracts';
import {
  fromTaskOutput,
  UiProjectionError,
  type AgentRoleDisplay,
  type AgentFeedbackKind,
  type AgentFeedbackProjection,
  type AgentFeedbackState,
  type AgentRuntimePoolEntryProjection,
  type AgentRuntimePoolProjection,
  type AgentRuntimePoolState,
  type AgentWorkCardProjection,
  type AssignmentProjection,
  type AssignmentReconcileProjection,
  type AssignmentStatus,
  type DashboardProjection,
  type DecisionProjection,
  type MemoryComparisonProjection,
  type MemoryDetailProjection,
  type MemoryInteractionSurfaceProjection,
  type MemorySummaryProjection,
  type ObservationNodeDetailProjection,
  type AgentHandoffProjection,
  type AgentOwnershipFrameProjection,
  type PipelineNodeActivityProjection,
  type PipelineNodeProjection,
  type PipelineNodeToolStepProjection,
  type PipelineNodeToolStepStatus,
  type PipelineObservationProjection,
  type RecentInputProjection,
  type ExecutionStepKind,
  type TaskDashboardProjection,
  type TaskDetailProjection,
  type TaskListProjection,
  type TaskOutputProjection,
  type TaskRowProjection,
  type UiDataSource,
  type UiSurfaceState,
  type AgentCheckpointProjection,
  type StopRecoveryProjection,
  type TaskExecutionStepProjection,
} from '../contracts/models.js';

const STATE_LABELS: Record<LifecycleState, string> = {
  created: '已创建',
  admitted: '已准入',
  running: '运行中',
  settling: '收拢中',
  succeeded: '已完成',
  waiting: '等待中',
  blocked: '受阻',
  failed: '失败',
  cancelled: '已取消',
  stopped: '已停止',
  unknown: '未知',
  stale: '过期',
};

const NODE_KIND_LABELS: Record<string, string> = {
  interaction: '输入与交互',
  orchestration: '任务推进',
  execution: '执行',
  review: '复核',
  memory: '经验整理',
};

const AGENT_ROLE_LABELS: Record<AgentRoleDisplay, string> = {
  interaction: '交互',
  orchestration: '任务编排',
  execution: '执行',
  review: '审核',
  memory: '经验整理',
};

const AGENT_ROLE_TITLES: Record<AgentRoleDisplay, string> = {
  interaction: '输入与目标',
  orchestration: '任务推进',
  execution: '当前执行',
  review: '完成前复核',
  memory: '经验与 skill 整理',
};

const RUNTIME_POOL_STATE_LABELS: Record<AgentRuntimePoolState, string> = {
  available: '可分配',
  starting: '启动中',
  idle: '空闲',
  bound: '已绑定',
  executing: '执行中',
  settling: '收拢中',
  stopped: '已停止',
  failed: '失败',
};

const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  waiting: '等待中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  incomplete: '未完成',
  blocked: '受阻',
  cancelled: '已取消',
  stale: '已过期',
};

const FEEDBACK_STATE_LABELS: Record<AgentFeedbackState, string> = {
  open: '待处理',
  recovering: '恢复中',
  resolved: '已处理',
  stale: '已过期',
  blocked: '受阻',
};

const RECONCILE_STATE_LABELS: Record<AssignmentReconcileProjection['state'], string> = {
  'not-required': '无需核对',
  required: '需要核对',
  reconciling: '核对中',
  resolved: '已核对',
  blocked: '核对受阻',
  stale: '核对过期',
};

const SOURCE_LABELS: Record<RecentInputProjection['source'], string> = {
  human: '来自你',
  task: '来自任务',
  notification: '来自通知',
  agent: '来自任务',
};

const OBSERVATION_KEYBOARD_RULES = [
  'nodes are buttons',
  'drawer focus moves to selected node',
  'drawer close returns focus to trigger',
  'breadcrumb return keeps the path visible',
] as const;

const OBSERVATION_NARROW_RULES = [
  'single-column layout',
  'nodes before drawer',
  'evidence previews first',
] as const;

export interface TaskSource {
  readonly task: Task;
  readonly summary: string;
  readonly stateLabel?: string;
  readonly currentWork?: string;
  readonly progress?: string;
  readonly nextStep?: string;
  readonly updatedAt?: string;
  readonly evidenceCount?: number;
  readonly entry?: TaskRowProjection['entry'];
}

export interface DecisionSource {
  readonly task: Task;
  readonly situation: string;
  readonly proposal: string;
  readonly options: readonly string[];
  readonly customInputAllowed?: boolean;
  readonly updatedAt?: string;
}

export interface RecentInputSource {
  readonly source: RecentInputProjection['source'];
  readonly text: string;
  readonly receivedAt: string;
  readonly taskRef?: TaskId;
  readonly status?: string;
}

export interface DashboardProjectionInput {
  readonly source: UiDataSource;
  readonly pending: readonly DecisionSource[];
  readonly running: readonly TaskSource[];
  readonly recentInputs: readonly RecentInputSource[];
  readonly history: readonly TaskSource[];
}

export interface TaskListProjectionInput {
  readonly source: UiDataSource;
  readonly current: readonly TaskSource[];
  readonly decisions: readonly DecisionSource[];
  readonly history: readonly TaskSource[];
}

export interface TaskDetailProjectionInput {
  readonly source: UiDataSource;
  readonly task: Task;
  readonly currentState: string;
  readonly priorInput: string;
  readonly investigation: readonly string[];
  readonly proposal: string;
  readonly nextAction: string;
  readonly requiredDecisions: readonly string[];
  readonly customInputAllowed: boolean;
  readonly output?: TaskOutput;
  readonly observationRef?: string;
  readonly memorySummary?: MemorySummaryProjection;
}

export interface AgentCardSource {
  readonly agentId: string;
  readonly role: AgentRoleDisplay;
  readonly title?: string;
  readonly statusDisplay: string;
  readonly current?: string;
  readonly past?: string;
  readonly next?: string;
  readonly needsUser?: boolean;
  readonly needsUserSummary?: string;
  readonly inputPreview: string;
  readonly outputPreview: string;
  readonly updatedAt?: string;
  readonly processRef?: string;
}

export interface AgentRuntimePoolEntrySource {
  readonly runtimeId: string;
  readonly agentId?: string;
  readonly role: AgentRoleDisplay;
  readonly state: AgentRuntimePoolState;
  readonly currentAssignmentId?: string;
  readonly executionEpoch?: number;
  readonly resourceSummary: string;
  readonly updatedAt?: string;
}

export interface AgentRuntimePoolSource {
  readonly available: number;
  readonly active: number;
  readonly runtimes: readonly AgentRuntimePoolEntrySource[];
}

export interface AssignmentSource {
  readonly assignmentId: string;
  readonly pipelineNodeId: string;
  readonly agentId: string;
  readonly role: AgentRoleDisplay;
  readonly status: AssignmentStatus;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly inputRevision: number;
  readonly objective: string;
  readonly targetRefs?: readonly string[];
  readonly inputPreview: string;
  readonly outputPreview: string;
  readonly outputRefs?: readonly string[];
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly nextAction?: string;
  readonly conditionRef?: string;
  readonly failureRef?: string;
  readonly parentAssignmentId?: string;
  readonly reviewRequired?: boolean;
  readonly mergeGate?: 'required' | 'not-required';
  readonly updatedAt?: string;
}

export interface AgentFeedbackSource {
  readonly feedbackId: string;
  readonly kind: AgentFeedbackKind;
  readonly state: AgentFeedbackState;
  readonly severity?: 'info' | 'attention' | 'blocker';
  readonly summary: string;
  readonly ownerId?: string;
  readonly nextAction?: string;
  readonly assignmentId?: string;
  readonly conditionRef?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly occurredAt?: string;
  readonly requiresUser?: boolean;
}

export interface AssignmentReconcileSource {
  readonly state: AssignmentReconcileProjection['state'];
  readonly summary: string;
  readonly ownerId: string;
  readonly operationRef?: string;
  readonly nextAction: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface ExecutionStepSource {
  readonly stepId: string;
  readonly kind: ExecutionStepKind;
  readonly summary: string;
  readonly refs?: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface CheckpointSource {
  readonly checkpointId: string;
  readonly executionEpoch: number;
  readonly outcome: LifecycleState;
  readonly ref: string;
}

export interface StopRecoverySource {
  readonly mode: StopRecoveryProjection['mode'];
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface TaskDashboardProjectionInput {
  readonly source: UiDataSource;
  readonly task: Task;
  readonly userInput: string;
  readonly objective: string;
  readonly currentStatus: string;
  readonly agentCards: readonly AgentCardSource[];
  readonly runtimePool?: AgentRuntimePoolSource;
  readonly assignments?: readonly AssignmentSource[];
  readonly agentFeedback?: readonly AgentFeedbackSource[];
  readonly reconcile?: AssignmentReconcileSource;
  readonly executionSteps?: readonly ExecutionStepSource[];
  readonly checkpoint?: CheckpointSource;
  readonly stopRecovery?: StopRecoverySource;
  readonly requiresUserHandling: boolean;
  readonly userHandlingSummary?: string;
  readonly observationRef?: string;
}

export interface ObservationNodeSource {
  readonly nodeId: string;
  readonly title: string;
  readonly kind: string;
  readonly state: LifecycleState;
  readonly summary: string;
  readonly owner: string;
  readonly ownerAgentRole?: AgentRoleDisplay;
  readonly iteration?: number;
  readonly updatedAt?: string;
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly activity?: readonly ObservationNodeActivitySource[];
  readonly toolSteps?: readonly ObservationNodeToolStepSource[];
  readonly childScopeRef?: string;
  readonly assignment?: AssignmentSource;
  readonly feedback?: readonly AgentFeedbackSource[];
  readonly reconcile?: AssignmentReconcileSource;
}

export interface ObservationNodeActivitySource {
  readonly activityRef: string;
  readonly summary: string;
  readonly occurredAt?: string;
}

export interface ObservationNodeToolStepSource {
  readonly stepId: string;
  readonly name: string;
  readonly status: PipelineNodeToolStepStatus;
  readonly returned: string;
  readonly occurredAt?: string;
}

export interface ObservationAgentFrameSource {
  readonly agentId: string;
  readonly role: AgentRoleDisplay;
  readonly stateDisplay: string;
  readonly iteration: number;
}

export interface ObservationHandoffSource {
  readonly handoffId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly carrySummary: string;
  readonly payloadPreview: string;
  readonly notCarried: string;
  readonly occurredAt?: string;
}

export interface ObservationScopeSource {
  readonly scopeRef: string;
  readonly title: string;
  readonly summary: string;
  readonly projectionSeq: string;
  readonly currentNodeId?: string;
  readonly agents?: readonly ObservationAgentFrameSource[];
  readonly handoffs?: readonly ObservationHandoffSource[];
  readonly nodes: readonly ObservationNodeSource[];
}

export interface PipelineObservationProjectionInput {
  readonly source: UiDataSource;
  readonly scopes: Readonly<Record<string, ObservationScopeSource>>;
  readonly scopeStack: readonly string[];
  readonly selectedNodeId?: string;
}

export interface MemoryEntrySource {
  readonly id: string;
  readonly sourceRef: string;
  readonly scope: string;
  readonly summary: string;
  readonly digest: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface SkillCandidateSource {
  readonly candidateId: string;
  readonly pattern: string;
  readonly proposedRule: string;
  readonly uniqueness: string;
  readonly repeatability: string;
  readonly value: string;
  readonly state: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface MemoryInteractionSurfaceInput {
  readonly source: UiDataSource;
  readonly scope: string;
  readonly summary: string;
  readonly indexState: string;
  readonly entries: readonly MemoryEntrySource[];
  readonly selectedDetail?: MemoryDetailProjection;
  readonly comparison?: MemoryComparisonProjection;
  readonly skillCandidates: readonly SkillCandidateSource[];
  readonly inspectEnabled: boolean;
  readonly compareEnabled: boolean;
}

function deriveState(source: UiDataSource, hasActivity: boolean, hasContent: boolean): UiSurfaceState {
  if (source.state !== 'ready') return source.state;
  if (hasActivity) return 'running';
  return hasContent ? 'ready' : 'empty';
}

function stateLabel(state: LifecycleState, override?: string): string {
  return override ?? STATE_LABELS[state];
}

function nodeKindLabel(kind: string): string {
  return NODE_KIND_LABELS[kind] ?? '处理';
}

function toTaskRow(source: TaskSource): TaskRowProjection {
  return {
    taskId: source.task.id,
    title: source.task.title,
    state: source.task.state,
    stateLabel: stateLabel(source.task.state, source.stateLabel),
    summary: source.summary,
    currentWork: source.currentWork,
    progress: source.progress,
    nextStep: source.nextStep,
    updatedAt: source.updatedAt,
    evidenceCount: source.evidenceCount ?? 0,
    entry: source.entry ?? (source.task.state === 'running' || source.task.state === 'settling' ? 'task-dashboard' : 'task-detail'),
  };
}

function toDecision(source: DecisionSource): DecisionProjection {
  return {
    taskId: source.task.id,
    title: source.task.title,
    stateLabel: stateLabel(source.task.state),
    situation: source.situation,
    proposal: source.proposal,
    options: source.options,
    customInputAllowed: source.customInputAllowed ?? true,
    updatedAt: source.updatedAt,
    entry: 'task-detail',
  };
}

function toRecentInput(source: RecentInputSource): RecentInputProjection {
  return {
    source: source.source,
    sourceLabel: SOURCE_LABELS[source.source],
    text: source.text,
    receivedAt: source.receivedAt,
    taskRef: source.taskRef,
    status: source.status,
  };
}

export function projectDashboard(input: DashboardProjectionInput): DashboardProjection {
  const pending = input.pending.map(toDecision);
  const running = input.running.map(toTaskRow);
  const recentInputs = input.recentInputs.map(toRecentInput);
  const history = input.history.map(toTaskRow);
  return {
    surface: 'dashboard',
    state: deriveState(input.source, running.length > 0, pending.length > 0 || recentInputs.length > 0 || history.length > 0),
    data: input.source,
    summary: {
      pending: pending.length,
      running: running.length,
      recentInputs: recentInputs.length,
      history: history.length,
    },
    pendingItems: pending,
    runningItems: running,
    recentInputs,
    historyItems: history,
  };
}

export function projectTaskList(input: TaskListProjectionInput): TaskListProjection {
  const current = input.current.map(toTaskRow);
  const decisions = input.decisions.map(toDecision);
  const history = input.history.map(toTaskRow);
  return {
    surface: 'task-list',
    state: deriveState(input.source, current.length > 0, current.length > 0 || decisions.length > 0 || history.length > 0),
    data: input.source,
    current,
    decisions,
    history,
    counts: { current: current.length, decisions: decisions.length, history: history.length },
  };
}

export function projectTaskDetail(input: TaskDetailProjectionInput): TaskDetailProjection {
  const output: TaskOutputProjection | undefined = fromTaskOutput(input.output);
  const memorySummary = input.memorySummary
    ? {
        summary: input.memorySummary.summary,
        evidenceCount: input.memorySummary.evidenceCount,
        candidateCount: input.memorySummary.candidateCount,
        reviewRequired: input.memorySummary.reviewRequired,
      }
    : undefined;
  return {
    surface: 'task-detail',
    taskId: input.task.id,
    title: input.task.title,
    state: input.source.state,
    data: input.source,
    currentState: input.currentState,
    priorInput: input.priorInput,
    investigation: input.investigation,
    proposal: input.proposal,
    nextAction: input.nextAction,
    requiredDecisions: input.requiredDecisions.map((label, index) => ({
      id: `decision-${index + 1}`,
      label,
      required: true,
    })),
    customInputAllowed: input.customInputAllowed,
    output,
    observationRef: input.observationRef ?? `task://${input.task.id.value}/observation`,
    memorySummary,
  };
}

function toAgentWorkCard(source: AgentCardSource): AgentWorkCardProjection {
  return {
    agentId: source.agentId,
    role: source.role,
    roleDisplay: AGENT_ROLE_LABELS[source.role],
    title: source.title ?? AGENT_ROLE_TITLES[source.role],
    statusDisplay: source.statusDisplay,
    current: source.current ?? source.statusDisplay,
    past: source.past ?? source.outputPreview,
    next: source.next ?? '等待下一步',
    needsUser: source.needsUser ?? false,
    needsUserSummary: source.needsUserSummary,
    inputPreview: source.inputPreview,
    outputPreview: source.outputPreview,
    updatedAt: source.updatedAt,
    processRef: source.processRef,
  };
}

function toRuntimePoolEntry(source: AgentRuntimePoolEntrySource): AgentRuntimePoolEntryProjection {
  return {
    runtimeId: source.runtimeId,
    agentId: source.agentId,
    role: source.role,
    state: source.state,
    stateDisplay: RUNTIME_POOL_STATE_LABELS[source.state],
    currentAssignmentId: source.currentAssignmentId,
    executionEpoch: source.executionEpoch,
    resourceSummary: source.resourceSummary,
    updatedAt: source.updatedAt,
  };
}

function toRuntimePool(source: AgentRuntimePoolSource | undefined): AgentRuntimePoolProjection {
  const entries = (source?.runtimes ?? []).map(toRuntimePoolEntry);
  return {
    available: source?.available ?? entries.filter((entry) => entry.state === 'available' || entry.state === 'idle').length,
    active: source?.active ?? entries.filter((entry) => entry.state === 'bound' || entry.state === 'executing' || entry.state === 'settling').length,
    runtimes: entries,
  };
}

function toAssignment(source: AssignmentSource): AssignmentProjection {
  return {
    assignmentId: source.assignmentId,
    pipelineNodeId: source.pipelineNodeId,
    agentId: source.agentId,
    role: source.role,
    status: source.status,
    statusDisplay: ASSIGNMENT_STATUS_LABELS[source.status],
    attempt: source.attempt,
    executionEpoch: source.executionEpoch,
    inputRevision: source.inputRevision,
    objective: source.objective,
    targetRefs: source.targetRefs ?? [],
    inputPreview: source.inputPreview,
    outputPreview: source.outputPreview,
    outputRefs: source.outputRefs ?? [],
    evidenceRefs: source.evidenceRefs ?? [],
    nextAction: source.nextAction,
    conditionRef: source.conditionRef,
    failureRef: source.failureRef,
    parentAssignmentId: source.parentAssignmentId,
    reviewRequired: source.reviewRequired ?? false,
    mergeGate: source.mergeGate ?? 'not-required',
    updatedAt: source.updatedAt,
  };
}

function toAgentFeedback(source: AgentFeedbackSource): AgentFeedbackProjection {
  return {
    feedbackId: source.feedbackId,
    kind: source.kind,
    state: source.state,
    stateDisplay: FEEDBACK_STATE_LABELS[source.state],
    severity: source.severity,
    summary: source.summary,
    ownerId: source.ownerId,
    nextAction: source.nextAction,
    assignmentId: source.assignmentId,
    conditionRef: source.conditionRef,
    evidenceRefs: source.evidenceRefs ?? [],
    occurredAt: source.occurredAt,
    requiresUser: source.requiresUser ?? false,
  };
}

function toReconcile(source: AssignmentReconcileSource | undefined): AssignmentReconcileProjection | undefined {
  if (!source) return undefined;
  return {
    state: source.state,
    stateDisplay: RECONCILE_STATE_LABELS[source.state],
    summary: source.summary,
    ownerId: source.ownerId,
    operationRef: source.operationRef,
    nextAction: source.nextAction,
    evidenceRefs: source.evidenceRefs ?? [],
  };
}

function toExecutionSteps(sources: readonly ExecutionStepSource[] | undefined): TaskExecutionStepProjection[] {
  if (!sources) return [];
  return sources.map((source) => ({
    stepId: source.stepId,
    kind: source.kind,
    summary: source.summary,
    refs: source.refs ?? [],
    evidenceRefs: source.evidenceRefs,
  }));
}

function toCheckpoint(source: CheckpointSource | undefined): AgentCheckpointProjection | undefined {
  if (!source) return undefined;
  return {
    checkpointId: source.checkpointId,
    executionEpoch: source.executionEpoch,
    outcome: source.outcome,
    ref: source.ref,
  };
}

function toStopRecovery(source: StopRecoverySource | undefined): StopRecoveryProjection | undefined {
  if (!source) return undefined;
  return {
    mode: source.mode,
    summary: source.summary,
    evidenceRefs: source.evidenceRefs,
  };
}

export function projectTaskDashboard(input: TaskDashboardProjectionInput): TaskDashboardProjection {
  const assignments = (input.assignments ?? []).map(toAssignment);
  const agentFeedback = (input.agentFeedback ?? []).map(toAgentFeedback);
  const requiresUserHandling = input.requiresUserHandling || agentFeedback.some((feedback) => feedback.requiresUser);
  const userHandlingSummary = input.userHandlingSummary
    ?? agentFeedback.find((feedback) => feedback.requiresUser)?.summary;
  return {
    surface: 'task-dashboard',
    taskId: input.task.id,
    state: input.source.state,
    data: input.source,
    taskTitle: input.task.title,
    userInput: input.userInput,
    objective: input.objective,
    currentStatus: input.currentStatus,
    agentCards: input.agentCards.map(toAgentWorkCard),
    runtimePool: toRuntimePool(input.runtimePool),
    assignments,
    agentFeedback,
    executionSteps: toExecutionSteps(input.executionSteps),
    checkpoint: toCheckpoint(input.checkpoint),
    stopRecovery: toStopRecovery(input.stopRecovery),
    feedback: {
      required: requiresUserHandling,
      summary: userHandlingSummary,
      entry: requiresUserHandling ? 'task-detail' : undefined,
    },
    reconcile: toReconcile(input.reconcile),
    observationRef: input.observationRef,
  };
}

function toObservationNodeView(source: ObservationNodeSource) {
  return {
    nodeId: source.nodeId,
    title: source.title,
    kindDisplay: nodeKindLabel(source.kind),
    state: source.state,
    stateDisplay: stateLabel(source.state),
    summary: source.summary,
    owner: source.owner,
    updatedAt: source.updatedAt,
    hasChildScope: Boolean(source.childScopeRef),
    evidenceCount: source.evidenceRefs.length,
  };
}

function toObservationDetail(source: ObservationNodeSource): ObservationNodeDetailProjection {
  return {
    nodeId: source.nodeId,
    title: source.title,
    kindDisplay: nodeKindLabel(source.kind),
    stateDisplay: stateLabel(source.state),
    owner: source.owner,
    updatedAt: source.updatedAt,
    summary: source.summary,
    inputs: source.inputRefs.map((ref) => ({ ref, label: ref })),
    outputs: source.outputRefs.map((ref) => ({ ref, label: ref })),
    evidenceRefs: source.evidenceRefs,
    childScopeRef: source.childScopeRef,
    assignment: source.assignment ? toAssignment(source.assignment) : undefined,
    feedback: (source.feedback ?? []).map(toAgentFeedback),
    reconcile: toReconcile(source.reconcile),
  };
}

const TOOL_STEP_STATUS_LABELS: Record<PipelineNodeToolStepStatus, string> = {
  running: '调用中',
  succeeded: '已返回',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消',
  unknown: '未知',
};

const TOOL_STEP_STATUSES: readonly PipelineNodeToolStepStatus[] = ['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'unknown'];

function isAgentRoleDisplay(value: unknown): value is AgentRoleDisplay {
  return typeof value === 'string' && typeof (AGENT_ROLE_LABELS as Record<string, string | undefined>)[value] === 'string';
}

function isToolStepStatus(value: unknown): value is PipelineNodeToolStepStatus {
  return typeof value === 'string' && (TOOL_STEP_STATUSES as readonly string[]).includes(value);
}

function requireToolStepStatus(value: string): PipelineNodeToolStepStatus {
  if (!isToolStepStatus(value)) {
    throw new UiProjectionError(`unknown tool step status ${String(value)}`);
  }
  return value;
}

function requireAgentRole(role: string): AgentRoleDisplay {
  if (!isAgentRoleDisplay(role)) {
    throw new UiProjectionError(`unknown agent role ${String(role)} in observation projection`);
  }
  return role;
}

function assertNonEmpty(value: string, label: string, ownerId: string): void {
  if (value.trim().length === 0) throw new UiProjectionError(`${label} is required for ${ownerId}`);
}

function toPipelineNodeToolStep(source: ObservationNodeToolStepSource): PipelineNodeToolStepProjection {
  const status = requireToolStepStatus(source.status);
  assertNonEmpty(source.name, 'tool step name', source.stepId);
  assertNonEmpty(source.returned, 'tool step returned content', source.stepId);
  return {
    stepId: source.stepId,
    name: source.name,
    status,
    statusDisplay: TOOL_STEP_STATUS_LABELS[status],
    returned: source.returned,
    occurredAt: source.occurredAt,
  };
}

function toPipelineNodeActivity(source: ObservationNodeActivitySource): PipelineNodeActivityProjection {
  assertNonEmpty(source.activityRef, 'activity ref', 'observation node activity');
  assertNonEmpty(source.summary, 'activity summary', source.activityRef);
  return {
    activityRef: source.activityRef,
    summary: source.summary,
    occurredAt: source.occurredAt,
  };
}

function toPipelineNode(source: ObservationNodeSource, frameByAgentId: ReadonlyMap<string, ObservationAgentFrameSource>): PipelineNodeProjection {
  const frame = frameByAgentId.get(source.owner);
  if (!frame) throw new UiProjectionError(`node ${source.nodeId} owner ${source.owner} has no declared agent frame`);
  const role = requireAgentRole(frame.role);
  if (source.ownerAgentRole !== undefined && source.ownerAgentRole !== role) {
    throw new UiProjectionError(
      `node ${source.nodeId} declares role ${source.ownerAgentRole} but owner ${source.owner} is ${role}`,
    );
  }
  return {
    nodeId: source.nodeId,
    title: source.title,
    kindDisplay: nodeKindLabel(source.kind),
    ownerAgentRole: role,
    roleDisplay: AGENT_ROLE_LABELS[role],
    stateDisplay: stateLabel(source.state),
    iteration: source.iteration ?? frame.iteration,
    activity: (source.activity ?? []).map(toPipelineNodeActivity),
    summary: source.summary,
    updatedAt: source.updatedAt,
    toolSteps: (source.toolSteps ?? []).map(toPipelineNodeToolStep),
  };
}

function toAgentFrames(
  declared: readonly ObservationAgentFrameSource[],
  nodes: readonly ObservationNodeSource[],
): AgentOwnershipFrameProjection[] {
  const frames = declared.map((frame) => {
    const role = requireAgentRole(frame.role);
    return {
      agentId: frame.agentId,
      role,
      roleDisplay: AGENT_ROLE_LABELS[role],
      stateDisplay: frame.stateDisplay,
      iteration: frame.iteration,
      nodeIds: nodes.filter((node) => node.owner === frame.agentId).map((node) => node.nodeId),
    };
  });
  const declaredFrames = new Set(frames.map((frame) => frame.agentId));
  for (const node of nodes) {
    if (!declaredFrames.has(node.owner)) {
      throw new UiProjectionError(`node ${node.nodeId} owner ${node.owner} is not a declared agent frame`);
    }
  }
  return frames;
}

function toHandoffs(
  declared: readonly ObservationHandoffSource[],
  nodes: readonly ObservationNodeSource[],
  frames: readonly AgentOwnershipFrameProjection[],
): AgentHandoffProjection[] {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const frameByAgentId = new Map(frames.map((frame) => [frame.agentId, frame]));
  return declared.map((handoff) => {
    const fromNode = nodeById.get(handoff.fromNodeId);
    if (!fromNode) throw new UiProjectionError(`handoff ${handoff.handoffId} references unknown from node ${handoff.fromNodeId}`);
    const toNode = nodeById.get(handoff.toNodeId);
    if (!toNode) throw new UiProjectionError(`handoff ${handoff.handoffId} references unknown to node ${handoff.toNodeId}`);
    const fromFrame = frameByAgentId.get(fromNode.owner);
    const toFrame = frameByAgentId.get(toNode.owner);
    if (!fromFrame || !toFrame) {
      throw new UiProjectionError(`handoff ${handoff.handoffId} endpoint has no declared agent frame`);
    }
    assertNonEmpty(handoff.carrySummary, 'handoff carry summary', handoff.handoffId);
    assertNonEmpty(handoff.payloadPreview, 'handoff payload preview', handoff.handoffId);
    assertNonEmpty(handoff.notCarried, 'handoff notCarried', handoff.handoffId);
    return {
      handoffId: handoff.handoffId,
      fromAgentId: fromFrame.agentId,
      fromRole: fromFrame.role,
      fromRoleDisplay: fromFrame.roleDisplay,
      toAgentId: toFrame.agentId,
      toRole: toFrame.role,
      toRoleDisplay: toFrame.roleDisplay,
      fromNodeId: handoff.fromNodeId,
      toNodeId: handoff.toNodeId,
      carrySummary: handoff.carrySummary,
      payloadPreview: handoff.payloadPreview,
      notCarried: handoff.notCarried,
      occurredAt: handoff.occurredAt,
    };
  });
}

export function projectPipelineObservation(input: PipelineObservationProjectionInput): PipelineObservationProjection {
  const currentRef = input.scopeStack[input.scopeStack.length - 1];
  if (!currentRef) throw new UiProjectionError('observation scope stack may not be empty');
  const scope = input.scopes[currentRef];
  if (!scope) throw new UiProjectionError(`unknown observation scope ${currentRef}`);

  const frames = toAgentFrames(scope.agents ?? [], scope.nodes);
  const frameByAgentId = new Map((scope.agents ?? []).map((frame) => [frame.agentId, frame]));
  const nodes = scope.nodes.map((node) => toPipelineNode(node, frameByAgentId));
  const handoffs = toHandoffs(scope.handoffs ?? [], scope.nodes, frames);

  let currentNode: PipelineNodeProjection | undefined;
  if (scope.currentNodeId !== undefined) {
    currentNode = nodes.find((node) => node.nodeId === scope.currentNodeId);
    if (!currentNode) throw new UiProjectionError(`unknown current observation node ${scope.currentNodeId}`);
  }

  let selectedNode: ObservationNodeDetailProjection | undefined;
  if (input.selectedNodeId) {
    const node = scope.nodes.find((candidate) => candidate.nodeId === input.selectedNodeId);
    if (!node) throw new UiProjectionError(`unknown observation node ${input.selectedNodeId}`);
    selectedNode = toObservationDetail(node);
  }

  return {
    surface: 'observation',
    state: input.source.state,
    data: input.source,
    currentNode,
    nodes,
    agentFrames: frames,
    handoffs,
    scope: {
      scopeRef: currentRef,
      title: scope.title,
      summary: scope.summary,
      projectionSeq: scope.projectionSeq,
      nodes: scope.nodes.map(toObservationNodeView),
      breadcrumbs: input.scopeStack.map((ref) => ({
        ref,
        title: input.scopes[ref]?.title ?? ref,
      })),
      canReturn: input.scopeStack.length > 1,
    },
    selectedNode,
    rules: {
      keyboardFocus: OBSERVATION_KEYBOARD_RULES,
      narrowWidth: OBSERVATION_NARROW_RULES,
      mobileOrder: 'single-column',
      drawer: 'read-only-modal',
      readOnly: true,
    },
  };
}

export function enterObservationScope(
  input: PipelineObservationProjectionInput,
  scopeRef: string,
): PipelineObservationProjectionInput {
  if (!input.scopes[scopeRef]) throw new UiProjectionError(`unknown observation scope ${scopeRef}`);
  return { ...input, scopeStack: [...input.scopeStack, scopeRef], selectedNodeId: undefined };
}

export function returnObservationScope(
  input: PipelineObservationProjectionInput,
  stepsBack = 1,
): PipelineObservationProjectionInput {
  if (!Number.isSafeInteger(stepsBack) || stepsBack < 1) {
    throw new UiProjectionError('stepsBack must be a positive safe integer');
  }
  const nextSize = Math.max(1, input.scopeStack.length - stepsBack);
  return { ...input, scopeStack: input.scopeStack.slice(0, nextSize), selectedNodeId: undefined };
}

export function openObservationDrawer(
  input: PipelineObservationProjectionInput,
  nodeId: string,
): PipelineObservationProjectionInput {
  const currentRef = input.scopeStack[input.scopeStack.length - 1];
  const scope = currentRef ? input.scopes[currentRef] : undefined;
  if (!scope?.nodes.some((candidate) => candidate.nodeId === nodeId)) {
    throw new UiProjectionError(`unknown node ${nodeId} in current observation scope`);
  }
  return { ...input, selectedNodeId: nodeId };
}

export function closeObservationDrawer(
  input: PipelineObservationProjectionInput,
): PipelineObservationProjectionInput {
  return { ...input, selectedNodeId: undefined };
}

function toMemoryEntry(source: MemoryEntrySource) {
  return {
    id: source.id,
    sourceRef: source.sourceRef,
    scope: source.scope,
    summary: source.summary,
    digest: source.digest,
    evidenceRefs: source.evidenceRefs,
  };
}

function toSkillCandidate(source: SkillCandidateSource) {
  return {
    candidateId: source.candidateId,
    pattern: source.pattern,
    proposedRule: source.proposedRule,
    uniqueness: source.uniqueness,
    repeatability: source.repeatability,
    value: source.value,
    state: source.state,
    evidenceRefs: source.evidenceRefs,
  };
}

export function projectMemoryInteraction(input: MemoryInteractionSurfaceInput): MemoryInteractionSurfaceProjection {
  const candidates = input.skillCandidates.map(toSkillCandidate);
  return {
    surface: 'memory-interaction',
    state: input.source.state,
    data: input.source,
    scope: input.scope,
    summary: input.summary,
    indexState: input.indexState,
    entries: input.entries.map(toMemoryEntry),
    selectedDetail: input.selectedDetail,
    comparison: input.comparison,
    skillCandidates: candidates,
    reviewRequired: candidates.some((candidate) => candidate.state === 'candidate' || candidate.state === 'reviewing'),
    inspectEnabled: input.inspectEnabled,
    compareEnabled: input.compareEnabled,
  };
}

export * from './runtime.js';
