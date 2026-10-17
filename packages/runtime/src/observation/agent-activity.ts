import {
  sameTaskExecutionInstanceIdentity,
  validateTaskAgentActivityOwnershipRecord,
  validateTaskAgentActivitySelectionQuery,
} from '../../../contracts/src/index.js';
import type {
  ActiveTurnBinding,
  ChildInvocationRecord,
  EvidenceRef,
  JournalCommitRef,
  MilestoneReviewResultRecord,
  ReviewAssignment,
  TaskAgentActivityOwnershipRecord,
  TaskAgentActivitySelectionFailure,
  TaskAgentActivitySelectionOutcome,
  TaskAgentActivitySelectionQuery,
  TaskAgentActivitySourceKind,
  TaskAgentActivityUnavailableSource,
  TaskExecutionInstanceIdentity,
  TaskId,
  TaskRuntimeIncarnation,
  WorkAssignment,
} from '../../../contracts/src/index.js';
import type { ResumedTurnSegmentOpened } from '../../../contracts/src/active-turn-segments.js';
import type { RuntimeExecutionAllocation } from '../ui-runtime/coordinator.js';
import type { AgentRuntimePoolManager } from '../orchestration/runtime-pool.js';

/**
 * The single Runtime owner that classifies real per-task Agent activity into
 * current / historical / unknown ownership. It consumes decoded source facts
 * from the App, never reads stores or logs, and never invents an instance
 * identity. UI only projects the frozen outcome.
 */
const SELECTOR_OWNER_ID = 'runtime.observation.agent-activity';

type PoolRuntime =
  ReturnType<AgentRuntimePoolManager['inspect']>['runtimes'][number];

export interface AgentActivitySourceEvidence {
  readonly sourceId: string;
  readonly ownerId: string;
  readonly commitRefs: readonly JournalCommitRef[];
  readonly evidenceRefs: readonly EvidenceRef[];
  // true only proves this source is still bound to a real live handle; false
  // does not prove the source is terminal.
  readonly boundLive: boolean | undefined;
  // Decoded real terminal commits, not a checkpoint or a diagnostic log.
  readonly terminalCommitRefs: readonly JournalCommitRef[];
}

export interface AgentActivityCurrentLocation {
  readonly instance: TaskExecutionInstanceIdentity;
  readonly assignmentId: TaskAgentActivityOwnershipRecord['assignmentId'];
  readonly businessTurnId?: TaskAgentActivityOwnershipRecord['businessTurnId'];
  readonly segmentId?: TaskAgentActivityOwnershipRecord['segmentId'];
  readonly nodeId?: TaskAgentActivityOwnershipRecord['nodeId'];
}

export interface AgentActivityCurrentAuthority {
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly locations: readonly AgentActivityCurrentLocation[];
}

export interface AgentActivityNativeSource extends AgentActivitySourceEvidence {
  readonly allocation: RuntimeExecutionAllocation;
  // Comes from the real task/assignment target; an allocation has no objective.
  readonly objective: WorkAssignment['objective'];
}

export interface AgentActivityActiveSource extends AgentActivitySourceEvidence {
  readonly binding: ActiveTurnBinding;
  readonly bindingCommitRef: JournalCommitRef;
}

export interface AgentActivityResumedSource extends AgentActivitySourceEvidence {
  readonly opened: ResumedTurnSegmentOpened;
  readonly openedCommitRef: JournalCommitRef;
}

export interface AgentActivityChildSource extends AgentActivitySourceEvidence {
  readonly record: ChildInvocationRecord;
  readonly commitRef: JournalCommitRef;
  // The caller only decodes the real assignment; the relation is re-verified.
  readonly assignment: WorkAssignment | ReviewAssignment;
  readonly objective: WorkAssignment['objective'];
  readonly parentLocation: AgentActivityCurrentLocation;
}

export interface AgentActivityPoolSource extends AgentActivitySourceEvidence {
  readonly runtime: PoolRuntime;
  readonly objective: WorkAssignment['objective'];
}

export interface AgentActivityReviewSource extends AgentActivitySourceEvidence {
  readonly record: MilestoneReviewResultRecord;
  readonly commitRef: JournalCommitRef;
  // ReviewAssignment has no objective; the real reviewed target supplies it.
  readonly objective: WorkAssignment['objective'];
}

export interface SelectTaskAgentActivityInput {
  readonly taskId: TaskId;
  readonly query: TaskAgentActivitySelectionQuery;
  readonly currentAuthority?: AgentActivityCurrentAuthority;
  readonly nativeAllocations: readonly AgentActivityNativeSource[];
  readonly activeTurns: readonly AgentActivityActiveSource[];
  readonly resumedSegments: readonly AgentActivityResumedSource[];
  readonly childInvocations: readonly AgentActivityChildSource[];
  readonly runtimePoolLeases: readonly AgentActivityPoolSource[];
  readonly milestoneReviews: readonly AgentActivityReviewSource[];
  readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
}

type RecordBase = Omit<TaskAgentActivityOwnershipRecord, 'currency' | 'missingSource'>;

type BuildResult =
  | {
      readonly kind: 'record';
      readonly record: TaskAgentActivityOwnershipRecord;
    }
  | {
      readonly kind: 'unavailable';
      readonly source: TaskAgentActivityUnavailableSource;
    }
  | { readonly kind: 'skip' }
  | { readonly kind: 'conflict'; readonly message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskValue(taskId: TaskId | string): string {
  return typeof taskId === 'string' ? taskId : taskId.value;
}

function conflict(message: string): BuildResult {
  return { kind: 'conflict', message };
}

function selectionFailure(
  code: TaskAgentActivitySelectionFailure['code'],
  message: string,
  nextAction: string,
): TaskAgentActivitySelectionOutcome {
  return {
    ok: false,
    failure: { code, ownerId: SELECTOR_OWNER_ID, message, nextAction },
  };
}

function recordMatchesLocation(
  base: RecordBase,
  location: AgentActivityCurrentLocation,
): boolean {
  if (!sameTaskExecutionInstanceIdentity(location.instance, base.instance)) return false;
  if (location.assignmentId !== base.assignmentId) return false;
  if (base.businessTurnId !== undefined
    && (location.businessTurnId === undefined || location.businessTurnId !== base.businessTurnId)) {
    return false;
  }
  if (base.segmentId !== undefined
    && (location.segmentId === undefined || location.segmentId !== base.segmentId)) {
    return false;
  }
  if (base.nodeId !== undefined
    && (location.nodeId === undefined || location.nodeId !== base.nodeId)) {
    return false;
  }
  return true;
}

function classify(
  base: RecordBase,
  boundLive: boolean | undefined,
  terminal: boolean,
  authority: AgentActivityCurrentAuthority | undefined,
): { readonly currency: TaskAgentActivityOwnershipRecord['currency']; readonly missingSource?: string } {
  // A record whose epoch is older than the authoritative task epoch is history,
  // even if a live handle still exists. The identity keeps its own epoch.
  if (authority !== undefined && authority.executionEpoch > base.executionEpoch) {
    return { currency: 'historical' };
  }
  if (terminal) return { currency: 'historical' };
  if (boundLive === true) {
    if (authority === undefined) {
      return { currency: 'unknown', missingSource: 'current-authority' };
    }
    if (authority.locations.some((location) => recordMatchesLocation(base, location))) {
      return { currency: 'current' };
    }
    return { currency: 'unknown', missingSource: 'current-authority-location' };
  }
  if (boundLive === false) {
    return { currency: 'unknown', missingSource: 'live-handle' };
  }
  return { currency: 'unknown', missingSource: 'live-or-terminal-evidence' };
}

function makeRecord(
  base: RecordBase,
  boundLive: boolean | undefined,
  terminal: boolean,
  authority: AgentActivityCurrentAuthority | undefined,
): TaskAgentActivityOwnershipRecord {
  const { currency, missingSource } = classify(base, boundLive, terminal, authority);
  const record: TaskAgentActivityOwnershipRecord = {
    ...base,
    currency,
    ...(missingSource !== undefined ? { missingSource } : {}),
  };
  return validateTaskAgentActivityOwnershipRecord(record);
}

function buildNative(
  source: AgentActivityNativeSource,
  taskId: TaskId,
  authority: AgentActivityCurrentAuthority | undefined,
): BuildResult {
  const allocation = source.allocation;
  if (allocation.taskId.value !== taskId.value) {
    return conflict(
      `native allocation ${source.sourceId} belongs to task ${allocation.taskId.value}, not ${taskId.value}`,
    );
  }
  const base: RecordBase = {
    taskId: allocation.taskId,
    instance: {
      kind: 'native-execution',
      execution: {
        runtimeId: allocation.runtimeId,
        executionEpoch: allocation.executionEpoch,
      },
    },
    assignmentId: allocation.assignmentId,
    executionEpoch: allocation.executionEpoch,
    objective: source.objective,
    sourceKind: 'native-allocation',
    commitRefs: [...source.commitRefs],
    evidenceRefs: [...source.evidenceRefs],
  };
  return {
    kind: 'record',
    record: makeRecord(base, source.boundLive, source.terminalCommitRefs.length > 0, authority),
  };
}

function buildActive(
  source: AgentActivityActiveSource,
  taskId: TaskId,
  authority: AgentActivityCurrentAuthority | undefined,
): BuildResult {
  const binding = source.binding;
  const assignment = binding.assignment;
  if (assignment.taskId.value !== taskId.value) {
    return conflict(
      `active turn ${source.sourceId} belongs to task ${assignment.taskId.value}, not ${taskId.value}`,
    );
  }
  if (binding.admittedTurn.taskRef.value !== assignment.taskId.value) {
    return conflict(
      `active turn ${source.sourceId} admitted task does not match its assignment task`,
    );
  }
  const base: RecordBase = {
    taskId: assignment.taskId,
    instance: { kind: 'native-execution', execution: binding.execution },
    assignmentId: assignment.assignmentId,
    attempt: assignment.attempt,
    executionEpoch: binding.execution.executionEpoch,
    objective: assignment.objective,
    businessTurnId: binding.admittedTurn.turnId,
    nodeId: assignment.pipelineNodeId,
    sourceKind: 'active-turn',
    commitRefs: [source.bindingCommitRef, ...source.commitRefs],
    evidenceRefs: [...source.evidenceRefs],
  };
  return {
    kind: 'record',
    record: makeRecord(base, source.boundLive, source.terminalCommitRefs.length > 0, authority),
  };
}

function buildResumed(
  source: AgentActivityResumedSource,
  taskId: TaskId,
  authority: AgentActivityCurrentAuthority | undefined,
): BuildResult {
  const opened = source.opened;
  const incarnation = opened.binding.incarnation;
  const assignment = opened.binding.assignment;
  if (incarnation.taskId.value !== taskId.value) {
    return conflict(
      `resumed segment ${source.sourceId} incarnation belongs to task ${incarnation.taskId.value}, not ${taskId.value}`,
    );
  }
  if (assignment.taskId.value !== taskId.value) {
    return conflict(
      `resumed segment ${source.sourceId} assignment belongs to task ${assignment.taskId.value}, not ${taskId.value}`,
    );
  }
  if (incarnation.assignmentId !== assignment.assignmentId
    || incarnation.executionEpoch !== opened.binding.execution.executionEpoch) {
    return conflict(
      `resumed segment ${source.sourceId} incarnation does not match its assignment or the segment physical execution`,
    );
  }
  const base: RecordBase = {
    taskId: incarnation.taskId,
    instance: { kind: 'incarnation', incarnation },
    assignmentId: incarnation.assignmentId,
    attempt: assignment.attempt,
    executionEpoch: incarnation.executionEpoch,
    objective: assignment.objective,
    businessTurnId: opened.businessTurnRef.businessTurnId,
    segmentId: opened.segmentId,
    nodeId: assignment.pipelineNodeId,
    sourceKind: 'resumed-segment',
    commitRefs: [source.openedCommitRef, ...source.commitRefs],
    evidenceRefs: [...source.evidenceRefs],
  };
  return {
    kind: 'record',
    record: makeRecord(base, source.boundLive, source.terminalCommitRefs.length > 0, authority),
  };
}

function buildPool(
  source: AgentActivityPoolSource,
  taskId: TaskId,
  authority: AgentActivityCurrentAuthority | undefined,
): BuildResult {
  const incarnation = source.runtime.incarnation;
  if (incarnation === undefined) return { kind: 'skip' };
  if (incarnation.taskId.value !== taskId.value) {
    return conflict(
      `pool runtime ${source.sourceId} belongs to task ${incarnation.taskId.value}, not ${taskId.value}`,
    );
  }
  const base: RecordBase = {
    taskId: incarnation.taskId,
    instance: { kind: 'incarnation', incarnation },
    assignmentId: incarnation.assignmentId,
    executionEpoch: incarnation.executionEpoch,
    objective: source.objective,
    sourceKind: 'runtime-pool-lease',
    commitRefs: [...source.commitRefs],
    evidenceRefs: [...source.evidenceRefs],
  };
  return {
    kind: 'record',
    record: makeRecord(base, source.boundLive, source.terminalCommitRefs.length > 0, authority),
  };
}

function buildChild(
  source: AgentActivityChildSource,
  taskId: TaskId,
  authority: AgentActivityCurrentAuthority | undefined,
): BuildResult {
  const record = source.record;
  const incarnation = record.incarnation;
  if (incarnation === undefined) {
    return {
      kind: 'unavailable',
      source: {
        sourceId: record.invocationId,
        ownerId: source.ownerId,
        message: `child invocation ${record.invocationId} has no acquired incarnation`,
      },
    };
  }
  // The assignment must be the one the invocation was actually bound to; a
  // caller-supplied same-id assignment is not trusted on its own.
  const bindingAssignment = record.binding.assignment;
  if (bindingAssignment.assignmentId !== source.assignment.assignmentId
    || taskValue(bindingAssignment.taskId) !== taskValue(source.assignment.taskId)
    || bindingAssignment.attempt !== source.assignment.attempt
    || bindingAssignment.executionEpoch !== source.assignment.executionEpoch) {
    return conflict(
      `child invocation ${record.invocationId} assignment does not match its recorded binding`,
    );
  }
  if (incarnation.assignmentId !== bindingAssignment.assignmentId
    || incarnation.taskId.value !== taskValue(bindingAssignment.taskId)
    || incarnation.executionEpoch !== bindingAssignment.executionEpoch) {
    return conflict(
      `child invocation ${record.invocationId} incarnation does not match its assignment`,
    );
  }
  if (incarnation.taskId.value !== taskId.value) {
    return conflict(
      `child invocation ${record.invocationId} belongs to task ${incarnation.taskId.value}, not ${taskId.value}`,
    );
  }
  const base: RecordBase = {
    taskId: incarnation.taskId,
    instance: { kind: 'incarnation', incarnation },
    assignmentId: incarnation.assignmentId,
    executionEpoch: incarnation.executionEpoch,
    objective: source.objective,
    sourceKind: 'child-invocation',
    commitRefs: [source.commitRef, ...source.commitRefs],
    evidenceRefs: [...source.evidenceRefs],
  };
  return {
    kind: 'record',
    record: makeRecord(base, source.boundLive, source.terminalCommitRefs.length > 0, authority),
  };
}

function buildReview(
  source: AgentActivityReviewSource,
  taskId: TaskId,
  authority: AgentActivityCurrentAuthority | undefined,
): BuildResult {
  const record = source.record;
  const reviewer = record.delivery.reviewer;
  const reviewAssignment = record.reviewAssignment;
  if (reviewer.taskId.value !== reviewAssignment.taskId) {
    return conflict(
      `milestone review ${source.sourceId} reviewer task does not match its review assignment`,
    );
  }
  if (reviewer.assignmentId !== reviewAssignment.assignmentId) {
    return conflict(
      `milestone review ${source.sourceId} reviewer assignment does not match its review assignment`,
    );
  }
  if (reviewer.executionEpoch !== reviewAssignment.executionEpoch) {
    return conflict(
      `milestone review ${source.sourceId} reviewer epoch does not match its review assignment`,
    );
  }
  if (reviewer.taskId.value !== taskId.value) {
    return conflict(
      `milestone review ${source.sourceId} belongs to task ${reviewer.taskId.value}, not ${taskId.value}`,
    );
  }
  if (record.taskScope.taskId.value !== taskId.value) {
    return conflict(
      `milestone review ${source.sourceId} task scope does not match task ${taskId.value}`,
    );
  }
  if (record.executionScope.taskId !== undefined
    && record.executionScope.taskId.value !== taskId.value) {
    return conflict(
      `milestone review ${source.sourceId} execution scope does not match task ${taskId.value}`,
    );
  }
  const base: RecordBase = {
    taskId: reviewer.taskId,
    instance: { kind: 'incarnation', incarnation: reviewer },
    assignmentId: reviewer.assignmentId,
    attempt: reviewAssignment.attempt,
    executionEpoch: reviewer.executionEpoch,
    objective: source.objective,
    sourceKind: 'milestone-review',
    commitRefs: [source.commitRef, ...source.commitRefs],
    evidenceRefs: [...source.evidenceRefs],
  };
  // A milestone review result proves that review delivery completed; the record
  // is history and does not claim the reviewer runtime was released.
  return { kind: 'record', record: makeRecord(base, source.boundLive, true, authority) };
}

function safeBuild(build: () => BuildResult): BuildResult {
  try {
    return build();
  } catch (error) {
    return { kind: 'conflict', message: messageOf(error) };
  }
}

function recordKey(record: TaskAgentActivityOwnershipRecord): string {
  return JSON.stringify({
    instance: record.instance,
    assignmentId: record.assignmentId,
    attempt: record.attempt,
    sourceKind: record.sourceKind,
    businessTurnId: record.businessTurnId,
    segmentId: record.segmentId,
    nodeId: record.nodeId,
    objective: record.objective,
    currency: record.currency,
    missingSource: record.missingSource,
    commitRefs: record.commitRefs,
    evidenceRefs: record.evidenceRefs,
  });
}

function pushUnique(
  records: TaskAgentActivityOwnershipRecord[],
  record: TaskAgentActivityOwnershipRecord,
): void {
  // Only exact duplicates collapse. Conflicting duplicates are kept as separate
  // facts rather than resolved with a last-wins rule.
  const key = recordKey(record);
  if (records.some((existing) => recordKey(existing) === key)) return;
  records.push(record);
}

function matchesQuery(
  record: TaskAgentActivityOwnershipRecord,
  query: TaskAgentActivitySelectionQuery,
): boolean {
  if (query.instance === undefined) return false;
  if (!sameTaskExecutionInstanceIdentity(record.instance, query.instance)) return false;
  if (query.assignmentId !== undefined && record.assignmentId !== query.assignmentId) return false;
  if (query.attempt !== undefined && record.attempt !== query.attempt) return false;
  if (query.businessTurnId !== undefined && record.businessTurnId !== query.businessTurnId) return false;
  if (query.segmentId !== undefined && record.segmentId !== query.segmentId) return false;
  if (query.nodeId !== undefined && record.nodeId !== query.nodeId) return false;
  return true;
}

export function selectTaskAgentActivity(
  input: SelectTaskAgentActivityInput,
): TaskAgentActivitySelectionOutcome {
  try {
    validateTaskAgentActivitySelectionQuery(input.query, input.taskId);
  } catch (error) {
    return selectionFailure(
      'agent-activity.invalid-selection',
      messageOf(error),
      'correct the selection query and retry',
    );
  }

  if (input.currentAuthority !== undefined
    && input.currentAuthority.taskId.value !== input.taskId.value) {
    return selectionFailure(
      'agent-activity.source-conflict',
      `current authority belongs to task ${input.currentAuthority.taskId.value}, not ${input.taskId.value}`,
      'reconcile the conflicting source facts before selecting',
    );
  }

  const records: TaskAgentActivityOwnershipRecord[] = [];
  const unavailableSources: TaskAgentActivityUnavailableSource[] = [...input.unavailableSources];
  const authority = input.currentAuthority;

  const apply = (result: BuildResult): TaskAgentActivitySelectionFailure | undefined => {
    if (result.kind === 'conflict') {
      return {
        code: 'agent-activity.source-conflict',
        ownerId: SELECTOR_OWNER_ID,
        message: result.message,
        nextAction: 'reconcile the conflicting source facts before selecting',
      };
    }
    if (result.kind === 'unavailable') {
      unavailableSources.push(result.source);
      return undefined;
    }
    if (result.kind === 'record') pushUnique(records, result.record);
    return undefined;
  };

  for (const source of input.nativeAllocations) {
    const failure = apply(safeBuild(() => buildNative(source, input.taskId, authority)));
    if (failure) return { ok: false, failure };
  }
  for (const source of input.activeTurns) {
    const failure = apply(safeBuild(() => buildActive(source, input.taskId, authority)));
    if (failure) return { ok: false, failure };
  }
  for (const source of input.resumedSegments) {
    const failure = apply(safeBuild(() => buildResumed(source, input.taskId, authority)));
    if (failure) return { ok: false, failure };
  }
  for (const source of input.childInvocations) {
    const failure = apply(safeBuild(() => buildChild(source, input.taskId, authority)));
    if (failure) return { ok: false, failure };
  }
  for (const source of input.runtimePoolLeases) {
    const failure = apply(safeBuild(() => buildPool(source, input.taskId, authority)));
    if (failure) return { ok: false, failure };
  }
  for (const source of input.milestoneReviews) {
    const failure = apply(safeBuild(() => buildReview(source, input.taskId, authority)));
    if (failure) return { ok: false, failure };
  }

  const current = records.filter((record) => record.currency === 'current');
  const historical = records.filter((record) => record.currency === 'historical');
  const unknown = records.filter((record) => record.currency === 'unknown');

  if (input.query.instance === undefined) {
    return {
      ok: true,
      value: {
        taskId: input.taskId,
        mode: 'catalog',
        current,
        historical,
        unknown,
        unavailableSources,
      },
    };
  }

  const selected = records.filter((record) => matchesQuery(record, input.query));
  if (selected.length === 0) {
    return selectionFailure(
      'agent-activity.selection-not-found',
      `no agent activity instance matches the requested selection for task ${input.taskId.value}`,
      'provide an exact instance and matching assignment, attempt, turn, segment or node',
    );
  }
  return {
    ok: true,
    value: {
      taskId: input.taskId,
      mode: 'selected',
      selectedInstance: input.query.instance,
      selected,
      current,
      historical,
      unknown,
      unavailableSources,
    },
  };
}
