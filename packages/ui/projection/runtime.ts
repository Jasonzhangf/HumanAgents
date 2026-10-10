import type { EvidenceRef, LifecycleState, TaskId } from '@humanagent/contracts';
import type { SemanticObservationEnvelope } from '@humanagent/contracts';
import {
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
} from '../contracts/runtime.js';
import type { RuntimeSemanticObservationEnvelope } from '../contracts/runtime.js';
import { RuntimeProjectionError } from '../contracts/runtime.js';

export type {
  RuntimeLivenessInput,
  RuntimeLivenessProjection,
  RuntimeLivenessState,
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
  readonly requirementQueue?: string;
  readonly requirementAdmission?: RuntimeTaskRowProjection['requirementAdmission'];
  readonly requirementAdmissionLabel?: string;
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
    requirementQueue: source.requirementQueue,
    requirementAdmission: source.requirementAdmission,
    requirementAdmissionLabel: source.requirementAdmissionLabel,
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
    implicitScheduling: input.implicitScheduling,
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

export function projectRuntimeTaskDashboard(
  source: RuntimeTaskSnapshotInput,
  mode: RuntimeMode,
): RuntimeTaskDashboardProjection {
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
    output: source.output,
    recentEvents: source.recentEvents.slice(-20),
    checkpoint: source.checkpoint,
    error: source.error,
    nextStep: source.nextStep,
    operationId: source.operationId,
    executionEpoch: source.executionEpoch,
    allowedActions: source.allowedActions,
    observationRef: `task://${source.taskId.value}/observation`,
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
