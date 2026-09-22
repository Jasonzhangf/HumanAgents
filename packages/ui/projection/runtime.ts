import type { EvidenceRef, LifecycleState, TaskId } from '@humanagent/contracts';
import {
  type RuntimeDashboardProjection,
  type RuntimeMode,
  type RuntimeModeStatus,
  type RuntimeRecentFailureProjection,
  type RuntimeRecentInputProjection,
  type RuntimeRecentOutputProjection,
  type RuntimeStatusProjection,
  type RuntimeSurfaceState,
  type RuntimeTaskCheckpointProjection,
  type RuntimeTaskDashboardProjection,
  type RuntimeTaskErrorProjection,
  type RuntimeTaskEventProjection,
  type RuntimeTaskListProjection,
  type RuntimeTaskRowProjection,
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
}

export interface RuntimeTaskSnapshotInput {
  readonly taskId: TaskId;
  readonly title: string;
  readonly state: LifecycleState;
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
    currentState: source.currentState,
    nextStep: source.nextStep,
    updatedAt: source.updatedAt,
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
  };
}

export function projectRuntimeDashboard(input: RuntimeDashboardInput): RuntimeDashboardProjection {
  const recentOutputs: RuntimeRecentOutputProjection[] = input.tasks
    .filter((task) => task.output.trim().length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map((task) => ({
      taskId: task.taskId,
      taskTitle: task.title,
      text: task.output,
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

export function projectRuntimeTaskDashboard(source: RuntimeTaskSnapshotInput, mode: RuntimeMode): RuntimeTaskDashboardProjection {
  return {
    surface: 'runtime-task-dashboard',
    mode,
    taskId: source.taskId,
    taskTitle: source.title,
    state: source.state,
    stateLabel: stateLabel(source.state),
    currentNode: source.currentNode,
    input: source.input,
    output: source.output,
    recentEvents: source.recentEvents.slice(-20),
    checkpoint: source.checkpoint,
    error: source.error,
    nextStep: source.nextStep,
    operationId: source.operationId,
    executionEpoch: source.executionEpoch,
    allowedActions: source.allowedActions,
    observationRef: `task://${source.taskId.value}/observation`,
  };
}
