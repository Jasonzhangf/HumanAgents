import type { EvidenceRef, LifecycleState, TaskFlowBinding, TaskId, TaskIdentitySource } from '@humanagent/contracts';
import type { SemanticObservationEnvelope } from '@humanagent/contracts';
import {
  type RuntimeCommitRefProjection,
  type RuntimeContextHistoryProjection,
  type RuntimeContextReplacementProjection,
  type RuntimeContextViewProjection,
  type RuntimeDashboardProjection,
  type RuntimeMode,
  type RuntimeModeStatus,
  type RuntimeRecentFailureProjection,
  type RuntimeRecentInputProjection,
  type RuntimeRecentOutputProjection,
  type RuntimeStatusProjection,
  type RuntimeSurfaceState,
  type RuntimeLivenessInput,
  type RuntimeLivenessProjection,
  type RuntimeTaskCheckpointProjection,
  type RuntimeTaskDashboardProjection,
  type RuntimeTaskErrorProjection,
  type RuntimeTaskEventProjection,
  type RuntimeTaskListProjection,
  type RuntimeTaskRowProjection,
  type RuntimeReadResult,
  type RuntimeReadScope,
  type PublicOutputPublicationProjection,
  type RuntimeCheckpointFilter,
  type RuntimeCheckpointHistoryProjection,
  type RuntimeCheckpointProjection,
  type RuntimePoolAvailabilityProjection,
  type RuntimeBusinessCycleHistoryProjection,
  type RuntimeBusinessCycleEntryProjection,
  type RuntimeBusinessCycleProjection,
  type RuntimeI2CurrentPosition,
  type RuntimeInspectionComparisonProjection,
  type RuntimeInspectionItemComparisonProjection,
  type RuntimeInspectionItemProjection,
  type RuntimeInspectionOccurrenceEntryProjection,
  type RuntimeInspectionOccurrenceHistoryProjection,
  type RuntimeInspectionOccurrenceProjection,
  type RuntimeMilestoneReviewHistoryProjection,
  type RuntimeMilestoneReviewProjection,
  type RuntimeNextActionProjection,
  type RuntimeReviewFindingProjection,
  type RuntimeScheduleOccurrenceProjection,
  type RuntimeSelectedReviewerProjection,
  type RuntimeTaskScopeProjection,
} from '../contracts/runtime.js';
import type { RuntimeTaskPlanHistoryProjection } from '../contracts/task-plan-history.js';
import type { RuntimeSemanticObservationEnvelope } from '../contracts/runtime.js';
import { RuntimeProjectionError } from '../contracts/runtime.js';

export { projectTaskActualExecutionGraph } from './actual-execution-graph.js';
export type {
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

export type {
  PublicOutputCommitProjection,
  PublicOutputPublicationProjection,
  RuntimeCheckpointCursorProjection,
  RuntimeCheckpointFilter,
  RuntimeCheckpointHistoryProjection,
  RuntimeCheckpointProjection,
  RuntimeContextHistoryProjection,
  RuntimeContextReplacementProjection,
  RuntimeContextViewProjection,
  RuntimeCommitRefProjection,
  RuntimePoolAvailabilityProjection,
  RuntimeBusinessCycleEntryProjection,
  RuntimeBusinessCycleHistoryProjection,
  RuntimeBusinessCycleProjection,
  RuntimeI2CurrentPosition,
  RuntimeInspectionComparisonProjection,
  RuntimeInspectionItemComparisonProjection,
  RuntimeInspectionItemProjection,
  RuntimeInspectionOccurrenceEntryProjection,
  RuntimeInspectionOccurrenceHistoryProjection,
  RuntimeInspectionOccurrenceProjection,
  RuntimeMilestoneReviewHistoryProjection,
  RuntimeMilestoneReviewProjection,
  RuntimeNextActionProjection,
  RuntimeReviewFindingProjection,
  RuntimeScheduleOccurrenceProjection,
  RuntimeSelectedReviewerProjection,
  RuntimeTaskScopeProjection,
  RuntimeLivenessInput,
  RuntimeLivenessProjection,
  RuntimeLivenessState,
  RuntimeProjectReadProjection,
  RuntimeProjectTaskReadRow,
  RuntimeRawEventProjection,
  RuntimeRawRecordBody,
  RuntimeRawRecordProjection,
  RuntimeReadFailure,
  RuntimeReadResult,
  RuntimeReadScope,
  RuntimeStoredRecordRef,
  RuntimeSystemReadProjection,
  RuntimeTaskRecordsProjection,
  TaskRuntimeIncarnationProjection,
} from '../contracts/runtime.js';

const STATE_LABELS: Record<LifecycleState, string> = {
  created: '已创建',
  admitted: '已准入',
  running: '运行中',
  settling: '收拢中',
  succeeded: '已完成',
  waiting: '等待决策',
  blocked: '受阻',
  failed: '失败',
  cancelled: '已取消',
  stopped: '已停止',
  unknown: '未知',
  stale: '过期',
};

export interface RuntimeStatusInput {
  readonly mode: RuntimeMode;
  readonly state: RuntimeSurfaceState;
  readonly connected: boolean;
  readonly providerState: string;
  readonly providerError?: RuntimeTaskErrorProjection;
  readonly detail?: string;
  readonly modes: readonly RuntimeModeStatus[];
  readonly implicitScheduling?: RuntimeStatusProjection['implicitScheduling'];
}

export interface RuntimeTaskSnapshotInput {
  readonly taskId: TaskId;
  readonly title: string;
  readonly state: LifecycleState;
  /**
   * Committed task-flow binding read from this Task's identity record. Absent
   * when the Task committed no binding; the projection then claims no binding.
   */
  readonly taskFlow?: TaskFlowBinding;
  readonly requirementQueue?: string;
  readonly requirementAdmission?: RuntimeTaskRowProjection['requirementAdmission'];
  readonly requirementAdmissionLabel?: string;
  readonly identitySource?: TaskIdentitySource;
  readonly taskPlanHistory?: RuntimeReadResult<RuntimeTaskPlanHistoryProjection>;
  readonly currentState: string;
  readonly nextStep: string;
  readonly updatedAt: string;
  readonly input: string;
  readonly output: string;
  readonly currentNode: string;
  readonly operationId?: string;
  readonly executionEpoch?: number;
  readonly allowedActions: readonly string[];
  readonly recentEvents: readonly RuntimeTaskEventProjection[];
  readonly checkpoint?: RuntimeTaskCheckpointProjection;
  readonly error?: RuntimeTaskErrorProjection;
  /**
   * Real execution liveness facts reported by the runtime: whether an execution
   * is active, the newest activity timestamp the runtime actually recorded, and
   * the declared silence budget. Absent when the caller reported no liveness
   * facts; the projection then claims nothing.
   */
  readonly liveness?: RuntimeLivenessInput;
  /** Committed public output, supplied by the authoritative publication read. */
  readonly publicOutput?: PublicOutputPublicationProjection;
  readonly runtimePool?: RuntimeTaskDashboardProjection['runtimePool'];
}

export interface PublicOutputCommitRefInput {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
}

export interface PublicOutputPublicationInput {
  readonly state: PublicOutputPublicationProjection['state'];
  readonly commits: readonly (PublicOutputCommitRefInput & { readonly text: string })[];
  readonly publicCommitWatermark?: number;
}

export interface TaskRuntimeIncarnationInput {
  readonly runtimeId: string;
  readonly generation: number;
  readonly agentInstanceId?: string;
  readonly roleId?: string;
  readonly taskId: TaskId;
  readonly assignmentId?: string;
  readonly executionEpoch?: number;
  readonly capabilities?: readonly string[];
  readonly unavailable?: string;
}

export interface RuntimePoolAvailabilityInput {
  readonly state: RuntimePoolAvailabilityProjection['state'];
  readonly reason?: string;
}

export interface RuntimeCommitRefInput {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
}

export interface RuntimeContextViewInput {
  readonly contextViewRef: string;
  readonly executionEpoch: number;
  readonly contextDigest: string;
  readonly checkpointId: string;
  readonly activeRefs: readonly string[];
  readonly omittedRefs: readonly string[];
}

export interface RuntimeContextReplacementInput {
  readonly replacementId: string;
  readonly executionEpoch: number;
  readonly fromContextViewRef: string;
  readonly toContextViewRef: string;
  readonly toContextDigest: string;
  readonly deltaIds: readonly string[];
  readonly reason: RuntimeContextReplacementProjection['reason'];
  readonly replacementDigest: string;
}

export interface RuntimeContextHistoryInput {
  readonly mode: RuntimeMode;
  readonly taskId: TaskId;
  readonly currentContextCommitRef?: RuntimeCommitRefInput;
  readonly views: readonly RuntimeContextViewInput[];
  readonly replacements: readonly RuntimeContextReplacementInput[];
  readonly nextCursor?: string;
}

export interface RuntimeCheckpointHistoryInput {
  readonly mode: RuntimeMode;
  readonly taskId: TaskId;
  readonly current?: { readonly checkpointId: string; readonly executionEpoch: number };
  readonly viewed?: { readonly checkpointId: string; readonly executionEpoch: number };
  readonly checkpoints: readonly RuntimeCheckpointProjection[];
  readonly nextCursor?: string;
  readonly capabilities: Partial<Record<RuntimeCheckpointFilter, RuntimePoolAvailabilityInput>>;
}

export interface RuntimeInspectionOccurrenceHistoryInput {
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly viewed: { readonly occurrenceId: string } | null;
  readonly occurrences: readonly RuntimeInspectionOccurrenceProjection[];
  readonly nextCursor?: string;
}

export interface RuntimeInspectionOccurrenceEntryInput {
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly viewed: { readonly occurrenceId: string } | null;
  readonly occurrence: RuntimeInspectionOccurrenceProjection;
}

export interface RuntimeMilestoneReviewHistoryInput {
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly reviews: readonly RuntimeMilestoneReviewProjection[];
  readonly nextCursor?: string;
}

export interface RuntimeBusinessCycleHistoryInput {
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly viewed: { readonly cycleId: string } | null;
  readonly cycles: readonly RuntimeBusinessCycleProjection[];
  readonly nextCursor?: string;
}

export interface RuntimeBusinessCycleEntryInput {
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly viewed: { readonly cycleId: string } | null;
  readonly cycle: RuntimeBusinessCycleProjection;
}

export interface RuntimeInspectionComparisonInput {
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly left: { readonly occurrenceId: string };
  readonly right: { readonly occurrenceId: string };
  readonly comparable: boolean;
  readonly reason: string | null;
  readonly definition: { readonly definitionId: string; readonly definitionVersion: string } | null;
  readonly items: readonly RuntimeInspectionItemComparisonProjection[];
}

export interface RuntimeDashboardInput {
  readonly mode: RuntimeMode;
  readonly tasks: readonly RuntimeTaskSnapshotInput[];
  readonly recentInputs: readonly RuntimeRecentInputProjection[];
}

export interface RuntimeTaskListInput {
  readonly mode: RuntimeMode;
  readonly tasks: readonly RuntimeTaskSnapshotInput[];
}

export interface RuntimeSemanticObservationInput {
  readonly taskId: TaskId;
  readonly semantic: RuntimeSemanticObservationEnvelope;
}

export type RuntimeSemanticObservationProjection = RuntimeSemanticObservationEnvelope;

function stateLabel(state: LifecycleState): string {
  return STATE_LABELS[state];
}

function isActive(state: LifecycleState): boolean {
  return state === 'running' || state === 'settling';
}

function isWaiting(state: LifecycleState): boolean {
  return state === 'waiting' || state === 'blocked';
}

function isCompleted(state: LifecycleState): boolean {
  return state === 'succeeded';
}

function isStopped(state: LifecycleState): boolean {
  return state === 'stopped';
}

function isDraft(state: LifecycleState): boolean {
  return state === 'created' || state === 'admitted';
}

function isFailed(state: LifecycleState): boolean {
  return state === 'failed' || state === 'cancelled' || state === 'unknown';
}

function toRow(source: RuntimeTaskSnapshotInput): RuntimeTaskRowProjection {
  return {
    taskId: source.taskId,
    title: source.title,
    state: source.state,
    stateLabel: stateLabel(source.state),
    ...(source.taskFlow === undefined ? {} : { taskFlow: source.taskFlow }),
    requirementQueue: source.requirementQueue,
    requirementAdmission: source.requirementAdmission,
    requirementAdmissionLabel: source.requirementAdmissionLabel,
    ...(source.identitySource === undefined ? {} : { identitySource: source.identitySource }),
    currentState: source.currentState,
    nextStep: source.nextStep,
    updatedAt: source.updatedAt,
    allowedActions: source.allowedActions,
    output: source.output,
    ...(source.publicOutput === undefined ? {} : { publicOutput: projectPublicOutputPublication(source.publicOutput) }),
    ...(source.error === undefined ? {} : { error: source.error }),
    ...(source.checkpoint === undefined ? {} : { checkpoint: source.checkpoint }),
    entry: 'task-dashboard',
  };
}

export function projectRuntimeStatus(input: RuntimeStatusInput): RuntimeStatusProjection {
  return {
    surface: 'runtime-status',
    mode: input.mode,
    state: input.state,
    connected: input.connected,
    providerState: input.providerState,
    providerError: input.providerError,
    detail: input.detail,
    modes: input.modes,
    implicitScheduling: input.implicitScheduling,
  };
}

export function projectRuntimeDashboard(input: RuntimeDashboardInput): RuntimeDashboardProjection {
  const recentOutputs: RuntimeRecentOutputProjection[] = input.tasks
    // Dashboard summaries display committed publication only. `task.output` can still be the
    // runtime's internal execution value, but it is not trusted public publication evidence.
    .filter((task) => projectPublicOutputPublication(task.publicOutput).commits.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map((task) => ({
      taskId: task.taskId,
      taskTitle: task.title,
      text: joinPublicOutputText(projectPublicOutputPublication(task.publicOutput).commits),
      occurredAt: task.updatedAt,
    }));
  const recentFailures: RuntimeRecentFailureProjection[] = input.tasks
    .filter((task): task is RuntimeTaskSnapshotInput & { readonly error: RuntimeTaskErrorProjection } => task.error !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map((task) => ({
      taskId: task.taskId,
      taskTitle: task.title,
      code: task.error.code,
      ownerId: task.error.ownerId,
      message: task.error.message,
      nextAction: task.error.nextAction,
      occurredAt: task.updatedAt,
    }));
  return {
    surface: 'runtime-dashboard',
    mode: input.mode,
    hasRunning: input.tasks.some((task) => isActive(task.state)),
    taskCount: input.tasks.length,
    waitingDecisionCount: input.tasks.filter((task) => isWaiting(task.state)).length,
    recentInputs: input.recentInputs.slice(0, 5),
    recentOutputs,
    recentFailures,
  };
}

export function projectRuntimeTaskList(input: RuntimeTaskListInput): RuntimeTaskListProjection {
  const running = input.tasks.filter((task) => isActive(task.state)).map(toRow);
  const waiting = input.tasks.filter((task) => isWaiting(task.state)).map(toRow);
  const completed = input.tasks.filter((task) => isCompleted(task.state)).map(toRow);
  const stopped = input.tasks.filter((task) => isStopped(task.state)).map(toRow);
  const draft = input.tasks.filter((task) => isDraft(task.state)).map(toRow);
  const failed = input.tasks.filter((task) => isFailed(task.state)).map(toRow);
  return {
    surface: 'runtime-task-list',
    mode: input.mode,
    running,
    waiting,
    completed,
    stopped,
    draft,
    failed,
    counts: {
      running: running.length,
      waiting: waiting.length,
      completed: completed.length,
      stopped: stopped.length,
      draft: draft.length,
      failed: failed.length,
      total: input.tasks.length,
    },
  };
}

export function projectRuntimeSemanticObservation(
  input: RuntimeSemanticObservationInput,
): RuntimeSemanticObservationProjection {
  if (input.semantic.scope.taskId?.value !== input.taskId.value) {
    throw new RuntimeProjectionError(
      `semantic observation scope taskId ${input.semantic.scope.taskId?.value ?? 'missing'} does not match ${input.taskId.value}`,
    );
  }
  return input.semantic;
}

/** Waiting copy describes recorded state, never activity inferred from a node. */
export function projectRuntimeTaskWaitingStatus(
  source: Pick<RuntimeTaskSnapshotInput, 'state' | 'checkpoint'>,
): string {
  if (source.checkpoint !== undefined) return '已提交收拢记录';
  switch (source.state) {
    case 'running': return '正在等待执行结果';
    case 'settling': return '正在收拢执行结果，等待检查点提交';
    case 'blocked': return '等待资源或人工处理后才能继续';
    case 'failed': return '执行失败；等待错误证据和资源收拢';
    case 'stopped':
    case 'cancelled': return '停止或取消请求已受理；等待收拢完成';
    default: return '尚无执行等待信息';
  }
}

export function projectRuntimeTaskDashboard(
  source: RuntimeTaskSnapshotInput,
  mode: RuntimeMode,
): RuntimeTaskDashboardProjection {
  const publicOutput = projectPublicOutputPublication(source.publicOutput);
  const liveness = source.liveness === undefined
    ? undefined
    : projectRuntimeLiveness(source.liveness, {
        state: source.state,
        hasError: source.error !== undefined,
      });
  return {
    surface: 'runtime-task-dashboard',
    mode,
    taskId: source.taskId,
    taskTitle: source.title,
    state: source.state,
    stateLabel: stateLabel(source.state),
    currentNode: source.currentNode,
    input: source.input,
    output: joinPublicOutputText(publicOutput.commits),
    recentEvents: source.recentEvents.slice(-20),
    checkpoint: source.checkpoint,
    error: source.error,
    nextStep: source.nextStep,
    operationId: source.operationId,
    executionEpoch: source.executionEpoch,
    allowedActions: source.allowedActions,
    observationRef: `task://${source.taskId.value}/observation`,
    publicOutput,
    runtimePool: source.runtimePool,
    taskPlanHistory: source.taskPlanHistory ?? {
      ok: false,
      failure: {
        code: 'task-plan-history.not-composed',
        ownerId: 'humanagent.ui.projection.runtime',
        message: 'no task plan history read was composed for this dashboard projection',
        nextAction: 'compose the task plan history read through the canonical control Journal before projecting the dashboard',
      },
    },
    ...(liveness === undefined ? {} : { liveness }),
  };
}

/**
 * Derives the single liveness state from real reported facts. Precedence:
 * reported failure, then a lifecycle that waits for a human or resource
 * decision, then a non-active execution, then the observed silence against the
 * declared budget.
 *
 * States that have no real producer stay `unknown`; this function never turns a
 * missing signal into a claim about progress. The event-transport fact is not
 * an input: only the page holding the stream observes it, so it is carried on
 * the card's own transport field instead of being derived here.
 */
export function projectRuntimeLiveness(
  facts: RuntimeLivenessInput,
  task: { readonly state: LifecycleState; readonly hasError: boolean },
): RuntimeLivenessProjection {
  const base = {
    observedAt: facts.observedAt,
    ...(facts.lastActivityAt === undefined ? {} : { lastActivityAt: facts.lastActivityAt }),
    ...(facts.lastActivitySource === undefined ? {} : { lastActivitySource: facts.lastActivitySource }),
    ...(facts.silenceBudgetMs === undefined ? {} : { silenceBudgetMs: facts.silenceBudgetMs }),
  };

  if (task.hasError || task.state === 'failed' || task.state === 'cancelled') {
    return {
      ...base,
      state: 'failed',
      reason: `the execution reported failure (state: ${task.state})`,
    };
  }
  if (task.state === 'waiting' || task.state === 'blocked') {
    return {
      ...base,
      state: 'waiting-for-answer',
      reason: `the execution is waiting for a human or resource decision (state: ${task.state})`,
    };
  }
  if (!facts.active) {
    if (task.state === 'unknown' || task.state === 'stale') {
      return {
        ...base,
        state: 'unknown',
        reason: `the reported execution state is ${task.state}; no execution activity is observable`,
      };
    }
    return {
      ...base,
      state: 'idle',
      reason: `no execution is active (state: ${task.state})`,
    };
  }

  const budget = facts.silenceBudgetMs;
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) {
    return {
      ...base,
      state: 'unknown',
      reason: 'the declared silence budget is not a usable duration, so no activity state is derived',
    };
  }
  if (facts.lastActivityAt === undefined) {
    return {
      ...base,
      state: 'unknown',
      reason: 'the runtime reported no real activity timestamp for this execution yet',
    };
  }

  const observedMs = Date.parse(facts.observedAt);
  const activityMs = Date.parse(facts.lastActivityAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(activityMs)) {
    return {
      ...base,
      state: 'unknown',
      reason: 'the reported observation or activity timestamp is not a usable time',
    };
  }

  const silentForMs = Math.max(0, observedMs - activityMs);
  if (silentForMs >= budget) {
    return {
      ...base,
      state: 'no-activity',
      silentForMs,
      reason: `no real activity for ${silentForMs} ms; the declared silence budget is ${budget} ms`,
    };
  }
  return {
    ...base,
    state: 'working',
    silentForMs,
    reason: `real activity ${silentForMs} ms ago; the declared silence budget is ${budget} ms`,
  };
}

export function projectPublicOutputPublication(
  input: PublicOutputPublicationInput | undefined,
): PublicOutputPublicationProjection {
  if (!input) return { state: 'unavailable', commits: [] };
  return {
    state: input.state,
    commits: [...input.commits],
    ...(input.publicCommitWatermark === undefined ? {} : { publicCommitWatermark: input.publicCommitWatermark }),
  };
}

function joinPublicOutputText(commits: readonly { readonly text: string }[]): string {
  return commits.map((commit) => commit.text).join('');
}

export function projectTaskRuntimePool(input: {
  readonly incarnations?: readonly TaskRuntimeIncarnationInput[];
  readonly availability?: RuntimePoolAvailabilityInput;
}): RuntimeTaskDashboardProjection['runtimePool'] {
  if (!input.incarnations && !input.availability) return undefined;
  return {
    incarnations: (input.incarnations ?? []).map((entry) => ({ ...entry })),
    availability: {
      state: input.availability?.state ?? (input.incarnations?.length ? 'available' : 'unknown'),
      reason: input.availability?.reason,
    },
  };
}

function projectCommitRef(ref: RuntimeCommitRefInput): RuntimeCommitRefProjection {
  return { ...ref };
}

function projectOptionalI2TaskReadScope(input: {
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
}): { readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }> } {
  if (input.scope === undefined) {
    return {};
  }
  if (input.scope.taskId.value !== input.taskScope.taskId.value) {
    throw new RuntimeProjectionError(
      `task read scope taskId ${input.scope.taskId.value} does not match ${input.taskScope.taskId.value}`,
    );
  }
  return { scope: { ...input.scope } };
}

export function projectRuntimeContextHistory(input: RuntimeContextHistoryInput): RuntimeContextHistoryProjection {
  return {
    surface: 'runtime-context-history',
    mode: input.mode,
    taskId: input.taskId,
    currentContextCommitRef: input.currentContextCommitRef
      ? projectCommitRef(input.currentContextCommitRef)
      : undefined,
    views: input.views.map((view) => ({ ...view })),
    replacements: input.replacements.map((replacement) => ({ ...replacement })),
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
  };
}

export function projectRuntimeCheckpointHistory(input: RuntimeCheckpointHistoryInput): RuntimeCheckpointHistoryProjection {
  return {
    surface: 'runtime-checkpoint-history',
    mode: input.mode,
    taskId: input.taskId,
    current: input.current,
    viewed: input.viewed,
    checkpoints: input.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
    capabilities: Object.fromEntries(
      Object.entries(input.capabilities).map(([filter, value]) => [filter, { ...value }]),
    ),
  };
}

export function projectRuntimeInspectionOccurrences(
  input: RuntimeInspectionOccurrenceHistoryInput,
): RuntimeInspectionOccurrenceHistoryProjection {
  return {
    surface: 'runtime-inspection-occurrences',
    taskScope: { ...input.taskScope },
    ...projectOptionalI2TaskReadScope(input),
    current: input.current,
    viewed: input.viewed,
    entries: input.occurrences.map((occurrence) => ({ ...occurrence })),
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
  };
}

export function projectRuntimeInspectionOccurrence(
  input: RuntimeInspectionOccurrenceEntryInput,
): RuntimeInspectionOccurrenceEntryProjection {
  return {
    surface: 'runtime-inspection-occurrence',
    taskScope: { ...input.taskScope },
    ...projectOptionalI2TaskReadScope(input),
    current: input.current,
    viewed: input.viewed,
    entry: { ...input.occurrence },
  };
}

export function projectRuntimeMilestoneReviews(
  input: RuntimeMilestoneReviewHistoryInput,
): RuntimeMilestoneReviewHistoryProjection {
  return {
    surface: 'runtime-milestone-reviews',
    taskScope: { ...input.taskScope },
    ...projectOptionalI2TaskReadScope(input),
    current: input.current,
    entries: input.reviews.map((review) => ({ ...review })),
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
  };
}

export function projectRuntimeBusinessCycles(
  input: RuntimeBusinessCycleHistoryInput,
): RuntimeBusinessCycleHistoryProjection {
  return {
    surface: 'runtime-business-cycles',
    taskScope: { ...input.taskScope },
    ...projectOptionalI2TaskReadScope(input),
    current: input.current,
    viewed: input.viewed,
    entries: input.cycles.map((cycle) => ({ ...cycle })),
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
  };
}

export function projectRuntimeBusinessCycle(
  input: RuntimeBusinessCycleEntryInput,
): RuntimeBusinessCycleEntryProjection {
  return {
    surface: 'runtime-business-cycle',
    taskScope: { ...input.taskScope },
    ...projectOptionalI2TaskReadScope(input),
    current: input.current,
    viewed: input.viewed,
    entry: { ...input.cycle },
  };
}

export function projectRuntimeInspectionComparison(
  input: RuntimeInspectionComparisonInput,
): RuntimeInspectionComparisonProjection {
  return {
    surface: 'runtime-inspection-comparison',
    taskScope: { ...input.taskScope },
    ...projectOptionalI2TaskReadScope(input),
    current: input.current,
    left: { ...input.left },
    right: { ...input.right },
    comparable: input.comparable,
    reason: input.reason,
    definition: input.definition === null ? null : { ...input.definition },
    items: input.items.map((item) => ({ ...item })),
  };
}

export function selectRuntimeCheckpointView(
  source: RuntimeCheckpointHistoryProjection,
  checkpointId: string,
): RuntimeCheckpointHistoryProjection {
  const target = source.checkpoints.find((checkpoint) => checkpoint.checkpointId === checkpointId);
  if (!target) {
    throw new RuntimeProjectionError(`unknown checkpoint ${checkpointId}; current stays unchanged`);
  }
  return {
    ...source,
    viewed: { checkpointId: target.checkpointId, executionEpoch: target.executionEpoch },
  };
}
