import type {
  TaskAgentActivityCurrency,
  TaskAgentActivityOwnershipRecord,
  TaskAgentActivitySelectionOutcome,
  TaskAgentActivitySourceKind,
  TaskExecutionInstanceIdentity,
} from '@humanagent/contracts';
import type {
  RuntimeAgentActivityEntryProjection,
  RuntimeAgentActivityInstanceProjection,
  RuntimeAgentActivityProjection,
  RuntimeCommitRefProjection,
  RuntimeReadResult,
  RuntimeReadScope,
} from '../contracts/runtime.js';

const SOURCE_KIND_LABELS: Record<TaskAgentActivitySourceKind, string> = {
  'native-allocation': '原生执行分配',
  'active-turn': '活动回合绑定',
  'resumed-segment': '恢复回合分段',
  'runtime-pool-lease': '运行池租约',
  'child-invocation': '子调用',
  'milestone-review': '里程碑复核',
};

const CURRENCY_LABELS: Record<TaskAgentActivityCurrency, string> = {
  current: '当前运行',
  historical: '历史记录',
  unknown: '当前归属未知',
};

/**
 * Display name per instance kind. It deliberately carries no raw identity:
 * the exact `runtimeId` / `roleId` / `agentInstanceId` belong to the detail
 * view, not to the list card.
 */
const INSTANCE_LABELS = {
  'native-execution': '原生执行',
  incarnation: '运行实例',
} as const;

function projectInstance(instance: TaskExecutionInstanceIdentity): RuntimeAgentActivityInstanceProjection {
  if (instance.kind === 'native-execution') {
    return {
      kind: 'native-execution',
      label: INSTANCE_LABELS['native-execution'],
      runtimeId: instance.execution.runtimeId,
      executionEpoch: instance.execution.executionEpoch,
    };
  }
  const incarnation = instance.incarnation;
  return {
    kind: 'incarnation',
    label: INSTANCE_LABELS.incarnation,
    runtimeId: incarnation.runtimeId,
    executionEpoch: incarnation.executionEpoch,
    roleId: incarnation.roleId,
    generation: incarnation.generation,
    agentInstanceId: incarnation.agentInstanceId,
  };
}

function projectCommitRef(ref: {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
}): RuntimeCommitRefProjection {
  return { commitId: ref.commitId, journalSeq: ref.journalSeq, recordDigest: ref.recordDigest };
}

function projectEntry(record: TaskAgentActivityOwnershipRecord): RuntimeAgentActivityEntryProjection {
  return {
    taskId: record.taskId,
    instance: projectInstance(record.instance),
    assignmentId: record.assignmentId,
    ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
    executionEpoch: record.executionEpoch,
    objective: record.objective,
    ...(record.businessTurnId === undefined ? {} : { businessTurnId: record.businessTurnId }),
    ...(record.segmentId === undefined ? {} : { segmentId: record.segmentId }),
    ...(record.nodeId === undefined ? {} : { nodeId: record.nodeId }),
    sourceKind: record.sourceKind,
    sourceKindLabel: SOURCE_KIND_LABELS[record.sourceKind],
    currency: record.currency,
    currencyLabel: CURRENCY_LABELS[record.currency],
    ...(record.missingSource === undefined ? {} : { missingSource: record.missingSource }),
    commitRefs: record.commitRefs.map(projectCommitRef),
    evidenceRefs: record.evidenceRefs,
  };
}

/**
 * Pure view mapping of the frozen `TaskAgentActivitySelectionOutcome` produced
 * by `packages/runtime/src/observation/agent-activity.ts`.
 *
 * This projection never imports `@humanagent/runtime`, never re-runs the
 * selector, never reclassifies or deduplicates an instance, and never builds a
 * new control or fact source. It carries the `current` / `historical` /
 * `unknown` / `selected` arrays exactly as the owner produced them, so an
 * `unknown` instance is never presented as `current`. The optional `scope` is
 * echoed for display/link context only.
 */
export function projectRuntimeAgentActivity(
  outcome: TaskAgentActivitySelectionOutcome,
  scope?: RuntimeReadScope,
): RuntimeReadResult<RuntimeAgentActivityProjection> {
  if (!outcome.ok) {
    const failure = outcome.failure;
    return {
      ok: false,
      failure: {
        code: failure.code,
        ownerId: failure.ownerId,
        message: failure.message,
        nextAction: failure.nextAction,
      },
    };
  }
  const value = outcome.value;
  const taskScope = scope !== undefined && scope.kind === 'task' ? scope : undefined;
  return {
    ok: true,
    value: {
      surface: 'runtime-agent-activity',
      ...(taskScope === undefined ? {} : { scope: taskScope }),
      taskId: value.taskId,
      mode: value.mode,
      ...(value.selectedInstance === undefined
        ? {}
        : { selectedInstance: projectInstance(value.selectedInstance) }),
      ...(value.selected === undefined ? {} : { selected: value.selected.map(projectEntry) }),
      current: value.current.map(projectEntry),
      historical: value.historical.map(projectEntry),
      unknown: value.unknown.map(projectEntry),
      unavailableSources: value.unavailableSources.map((source) => ({ ...source })),
    },
  };
}
