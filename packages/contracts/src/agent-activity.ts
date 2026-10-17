import { ContractError } from './errors.js';
import {
  assertAgentRuntimeId,
  assertEvidenceRef,
  assertExecutionEpoch,
  assertScope,
  type EvidenceRef,
  type TaskId,
} from './index.js';
import type { ActiveTurnProviderExecutionIdentityRef } from './active-turn-context.js';
import type { TaskRuntimeIncarnation } from './framework.js';
import { validateJournalCommitRef, type JournalCommitRef } from './i2-history.js';

/**
 * Domain contracts for the per-task Agent activity read projection (F09).
 *
 * The real execution instance identity is carried by its single owner: a native
 * Provider execution identity (`runtimeId` + `executionEpoch`) or a managed
 * runtime incarnation (`TaskRuntimeIncarnation`). This module never invents a
 * second runtime identity, never concatenates ids, and never rebuilds control
 * state from logs. A role frame or a directory name is never a durable instance
 * identity.
 */
export type TaskExecutionInstanceIdentity =
  | {
      readonly kind: 'native-execution';
      readonly execution: ActiveTurnProviderExecutionIdentityRef;
    }
  | {
      readonly kind: 'incarnation';
      readonly incarnation: TaskRuntimeIncarnation;
    };

export type TaskAgentActivitySourceKind =
  | 'native-allocation'
  | 'active-turn'
  | 'resumed-segment'
  | 'runtime-pool-lease'
  | 'child-invocation'
  | 'milestone-review';

export type TaskAgentActivityCurrency = 'current' | 'historical' | 'unknown';

const TASK_AGENT_ACTIVITY_SOURCE_KINDS: ReadonlySet<string> = new Set<TaskAgentActivitySourceKind>([
  'native-allocation',
  'active-turn',
  'resumed-segment',
  'runtime-pool-lease',
  'child-invocation',
  'milestone-review',
]);

const TASK_AGENT_ACTIVITY_CURRENCIES: ReadonlySet<string> = new Set<TaskAgentActivityCurrency>([
  'current',
  'historical',
  'unknown',
]);

/** A producer that held real activity facts but could not be bound to a managed instance. */
export interface TaskAgentActivityUnavailableSource {
  readonly sourceId: string;
  readonly ownerId: string;
  readonly message: string;
}

export interface TaskAgentActivityOwnershipRecord {
  readonly taskId: TaskId;
  readonly instance: TaskExecutionInstanceIdentity;
  readonly assignmentId: string;
  /** Present only when the authoritative source (e.g. WorkAssignment / ReviewAssignment) carries a real attempt. Never defaulted to 1. */
  readonly attempt?: number;
  readonly executionEpoch: number;
  readonly objective: string;
  readonly businessTurnId?: string;
  readonly segmentId?: string;
  readonly nodeId?: string;
  readonly sourceKind: TaskAgentActivitySourceKind;
  readonly currency: TaskAgentActivityCurrency;
  readonly missingSource?: string;
  readonly commitRefs: readonly JournalCommitRef[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface TaskAgentActivitySelectionQuery {
  readonly taskId: TaskId;
  readonly instance?: TaskExecutionInstanceIdentity;
  readonly assignmentId?: string;
  readonly attempt?: number;
  readonly businessTurnId?: string;
  readonly segmentId?: string;
  readonly nodeId?: string;
}

export interface TaskAgentActivitySelectionFailure {
  readonly code:
    | 'agent-activity.invalid-selection'
    | 'agent-activity.selection-not-found'
    | 'agent-activity.source-conflict';
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
}

/**
 * Frozen domain outcome produced by `packages/runtime/src/observation/agent-activity.ts`
 * and consumed directly by `packages/ui/projection/agent-activity.ts` without
 * introducing a UI -> Runtime dependency.
 */
export type TaskAgentActivitySelectionOutcome =
  | {
      readonly ok: true;
      readonly value: {
        readonly taskId: TaskId;
        readonly mode: 'catalog' | 'selected';
        readonly selectedInstance?: TaskExecutionInstanceIdentity;
        readonly selected?: readonly TaskAgentActivityOwnershipRecord[];
        readonly current: readonly TaskAgentActivityOwnershipRecord[];
        readonly historical: readonly TaskAgentActivityOwnershipRecord[];
        readonly unknown: readonly TaskAgentActivityOwnershipRecord[];
        readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
      };
    }
  | {
      readonly ok: false;
      readonly failure: TaskAgentActivitySelectionFailure;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

function assertTaskId(value: unknown, label: string): asserts value is TaskId {
  if (!isObject(value)) throw new ContractError(`${label} must be a task id`);
  assertScope(value as unknown as TaskId, 'task');
}

function instanceExecutionEpoch(instance: TaskExecutionInstanceIdentity): number {
  return instance.kind === 'native-execution'
    ? instance.execution.executionEpoch
    : instance.incarnation.executionEpoch;
}

export function validateActiveTurnProviderExecutionIdentityRef(
  value: ActiveTurnProviderExecutionIdentityRef,
): ActiveTurnProviderExecutionIdentityRef {
  if (!isObject(value)) throw new ContractError('native execution identity must be an object');
  assertAgentRuntimeId(value.runtimeId);
  assertExecutionEpoch(value.executionEpoch);
  return value;
}

export function validateTaskRuntimeIncarnation(
  value: TaskRuntimeIncarnation,
  expectedTaskId?: TaskId,
): TaskRuntimeIncarnation {
  if (!isObject(value)) throw new ContractError('task runtime incarnation must be an object');
  assertAgentRuntimeId(value.runtimeId);
  assertPositiveSafeInteger(value.generation, 'incarnation generation');
  assertNonEmptyString(value.agentInstanceId, 'incarnation agent instance id');
  assertNonEmptyString(value.roleId, 'incarnation role id');
  assertTaskId(value.taskId, 'incarnation task id');
  assertNonEmptyString(value.assignmentId, 'incarnation assignment id');
  assertExecutionEpoch(value.executionEpoch);
  if (expectedTaskId !== undefined) {
    assertTaskId(expectedTaskId, 'expected task id');
    if (value.taskId.value !== expectedTaskId.value) {
      throw new ContractError('incarnation task id does not match the expected task');
    }
  }
  return value;
}

export function validateTaskExecutionInstanceIdentity(
  value: TaskExecutionInstanceIdentity,
  expectedTaskId?: TaskId,
): TaskExecutionInstanceIdentity {
  const raw = value as unknown as Record<string, unknown>;
  if (!isObject(raw)) throw new ContractError('task execution instance identity must be an object');
  if (raw.kind === 'native-execution') {
    for (const forbidden of ['incarnation', 'roleId', 'generation', 'agentInstanceId']) {
      if (forbidden in raw) {
        throw new ContractError('native execution identity must not carry managed incarnation fields');
      }
    }
    validateActiveTurnProviderExecutionIdentityRef(raw.execution as ActiveTurnProviderExecutionIdentityRef);
    return value;
  }
  if (raw.kind === 'incarnation') {
    if ('execution' in raw) {
      throw new ContractError('incarnation identity must not carry a native execution identity');
    }
    validateTaskRuntimeIncarnation(raw.incarnation as TaskRuntimeIncarnation, expectedTaskId);
    return value;
  }
  throw new ContractError('task execution instance identity kind is invalid');
}

export function sameTaskExecutionInstanceIdentity(
  left: TaskExecutionInstanceIdentity,
  right: TaskExecutionInstanceIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'native-execution') {
    if (right.kind !== 'native-execution') return false;
    return left.execution.runtimeId === right.execution.runtimeId
      && left.execution.executionEpoch === right.execution.executionEpoch;
  }
  if (right.kind !== 'incarnation') return false;
  const a = left.incarnation;
  const b = right.incarnation;
  return a.runtimeId === b.runtimeId
    && a.executionEpoch === b.executionEpoch
    && a.generation === b.generation
    && a.agentInstanceId === b.agentInstanceId
    && a.roleId === b.roleId
    && a.taskId.value === b.taskId.value
    && a.assignmentId === b.assignmentId;
}

export function validateTaskAgentActivityOwnershipRecord(
  record: TaskAgentActivityOwnershipRecord,
  expectedTaskId?: TaskId,
): TaskAgentActivityOwnershipRecord {
  if (!isObject(record)) throw new ContractError('agent activity ownership record must be an object');
  assertTaskId(record.taskId, 'agent activity record task id');
  if (expectedTaskId !== undefined) {
    assertTaskId(expectedTaskId, 'expected task id');
    if (record.taskId.value !== expectedTaskId.value) {
      throw new ContractError('agent activity record task id does not match the expected task');
    }
  }
  validateTaskExecutionInstanceIdentity(record.instance, record.taskId);
  assertNonEmptyString(record.assignmentId, 'agent activity record assignment id');
  if (record.attempt !== undefined) {
    assertPositiveSafeInteger(record.attempt, 'agent activity record attempt');
  }
  assertExecutionEpoch(record.executionEpoch);
  if (record.executionEpoch !== instanceExecutionEpoch(record.instance)) {
    throw new ContractError('agent activity record execution epoch does not match its instance identity');
  }
  if (record.instance.kind === 'incarnation' && record.assignmentId !== record.instance.incarnation.assignmentId) {
    throw new ContractError('agent activity record assignment id does not match its incarnation identity');
  }
  assertNonEmptyString(record.objective, 'agent activity record objective');
  if (record.businessTurnId !== undefined) assertNonEmptyString(record.businessTurnId, 'agent activity record business turn id');
  if (record.segmentId !== undefined) assertNonEmptyString(record.segmentId, 'agent activity record segment id');
  if (record.nodeId !== undefined) assertNonEmptyString(record.nodeId, 'agent activity record node id');
  if (!TASK_AGENT_ACTIVITY_SOURCE_KINDS.has(record.sourceKind)) {
    throw new ContractError('agent activity record source kind is invalid');
  }
  if (!TASK_AGENT_ACTIVITY_CURRENCIES.has(record.currency)) {
    throw new ContractError('agent activity record currency is invalid');
  }
  if (record.missingSource !== undefined) assertNonEmptyString(record.missingSource, 'agent activity record missing source');
  if (!Array.isArray(record.commitRefs)) throw new ContractError('agent activity record commit refs must be an array');
  for (const ref of record.commitRefs) validateJournalCommitRef(ref);
  if (!Array.isArray(record.evidenceRefs)) throw new ContractError('agent activity record evidence refs must be an array');
  for (const ref of record.evidenceRefs) {
    assertEvidenceRef(ref);
    if (ref.scope.taskId !== undefined && ref.scope.taskId.value !== record.taskId.value) {
      throw new ContractError('agent activity record evidence ref task scope does not match the record task');
    }
  }
  return record;
}

export function validateTaskAgentActivitySelectionQuery(
  query: TaskAgentActivitySelectionQuery,
  expectedTaskId?: TaskId,
): TaskAgentActivitySelectionQuery {
  if (!isObject(query)) throw new ContractError('agent activity selection query must be an object');
  assertTaskId(query.taskId, 'agent activity selection query task id');
  if (expectedTaskId !== undefined) {
    assertTaskId(expectedTaskId, 'expected task id');
    if (query.taskId.value !== expectedTaskId.value) {
      throw new ContractError('agent activity selection query task id does not match the expected task');
    }
  }
  if (query.instance === undefined) {
    if (
      query.assignmentId !== undefined
      || query.attempt !== undefined
      || query.businessTurnId !== undefined
      || query.segmentId !== undefined
      || query.nodeId !== undefined
    ) {
      throw new ContractError('agent activity selection query requires an instance identity before narrowing by assignment, attempt, turn, segment or node');
    }
    return query;
  }
  validateTaskExecutionInstanceIdentity(query.instance, query.taskId);
  if (query.assignmentId !== undefined) {
    assertNonEmptyString(query.assignmentId, 'agent activity selection query assignment id');
    if (query.instance.kind === 'incarnation' && query.assignmentId !== query.instance.incarnation.assignmentId) {
      throw new ContractError('agent activity selection query assignment id does not match its incarnation identity');
    }
  }
  if (query.attempt !== undefined) assertPositiveSafeInteger(query.attempt, 'agent activity selection query attempt');
  if (query.businessTurnId !== undefined) assertNonEmptyString(query.businessTurnId, 'agent activity selection query business turn id');
  if (query.segmentId !== undefined) assertNonEmptyString(query.segmentId, 'agent activity selection query segment id');
  if (query.nodeId !== undefined) assertNonEmptyString(query.nodeId, 'agent activity selection query node id');
  return query;
}
