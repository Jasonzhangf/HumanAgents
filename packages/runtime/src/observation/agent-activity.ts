import {
  assertSameScope,
  sameTaskExecutionInstanceIdentity,
  validateActiveTurnProviderExecutionIdentityRef,
  validateTaskAgentActivityOwnershipRecord,
  validateTaskAgentActivitySelectionQuery,
  validateTaskRuntimeIncarnation,
  validateTurnClosureReference,
} from '../../../contracts/src/index.js';
import type {
  AcceptedChildDelivery,
  ActiveTurnBinding,
  ChildCallKind,
  ChildInvocationRecord,
  EvidenceRef,
  JournalCommitRef,
  MilestoneReviewResultRecord,
  ReviewAssignment,
  ScopeRef,
  TaskActualExecutionBusinessClosure,
  TaskActualExecutionContainingLocation,
  TaskActualExecutionGraphEdge,
  TaskActualExecutionGraphNode,
  TaskActualExecutionGraphSnapshot,
  TaskActualExecutionGraphUngroupedRelation,
  TaskAgentActivityOwnershipRecord,
  TaskAgentActivitySelectionFailure,
  TaskAgentActivitySelectionOutcome,
  TaskAgentActivitySelectionQuery,
  TaskAgentActivitySourceKind,
  TaskAgentActivityUnavailableSource,
  TaskExecutionInstanceIdentity,
  TaskFlowGuidance,
  TaskId,
  TaskIdentityScope,
  TaskRuntimeIncarnation,
  TurnClosureReference,
  WorkAssignment,
} from '../../../contracts/src/index.js';
import {
  validateResumedTurnSegmentOpened,
  type ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import type {
  ClosedTurnPlannerCallInvocationRecord,
  ClosedTurnPlannerCallPreparationRecord,
  ClosedTurnPlannerCallReturnRecord,
} from '../orchestration/closed-turn-planner-call.js';
import { sameJournalCommitRef } from '../checkpoints/coordinator.js';
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

export interface AgentActivityGraphChildInvocationSource extends AgentActivitySourceEvidence {
  readonly record: ChildInvocationRecord;
  readonly commitRef: JournalCommitRef;
  readonly containingLocation: TaskActualExecutionContainingLocation;
  readonly objective?: WorkAssignment['objective'];
  readonly parentLocation?: AgentActivityCurrentLocation;
}

export interface AgentActivityGraphChildDeliverySource extends AgentActivitySourceEvidence {
  readonly delivery: AcceptedChildDelivery;
  readonly commitRef: JournalCommitRef;
  readonly containingLocation?: TaskActualExecutionContainingLocation;
}

export interface AgentActivityReviewSource extends AgentActivitySourceEvidence {
  readonly record: MilestoneReviewResultRecord;
  readonly commitRef: JournalCommitRef;
  // ReviewAssignment has no objective; the real reviewed target supplies it.
  readonly objective: WorkAssignment['objective'];
}

/**
 * One closed-turn Planner call decoded from its same-Organ-Journal stages. The
 * preparation is required because it is the only record that carries the real
 * acquired incarnation. Later stages are optional; a terminal fact exists only
 * when the `returned` record and its own commit are both present.
 */
export interface AgentActivityPlannerSource extends AgentActivitySourceEvidence {
  readonly prepared: ClosedTurnPlannerCallPreparationRecord;
  readonly preparationCommitRef: JournalCommitRef;
  readonly invoked?: ClosedTurnPlannerCallInvocationRecord;
  readonly invocationCommitRef?: JournalCommitRef;
  readonly returned?: ClosedTurnPlannerCallReturnRecord;
  readonly returnCommitRef?: JournalCommitRef;
  readonly closure?: TurnClosureReference;
  readonly resumedSegment?: ResumedTurnSegmentOpened;
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
  readonly plannerCalls?: readonly AgentActivityPlannerSource[];
  readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
}

export interface SelectTaskActualExecutionGraphInput {
  readonly taskScope: TaskIdentityScope;
  readonly guidance?: TaskFlowGuidance;
  readonly nativeAllocations: readonly AgentActivityNativeSource[];
  readonly activeTurns: readonly AgentActivityActiveSource[];
  readonly resumedSegments: readonly AgentActivityResumedSource[];
  readonly rawChildInvocations: readonly AgentActivityGraphChildInvocationSource[];
  readonly childDeliveries: readonly AgentActivityGraphChildDeliverySource[];
  readonly businessClosures: readonly {
    readonly closure: TurnClosureReference;
    readonly commitRef: JournalCommitRef;
  }[];
  readonly milestoneReviews: readonly AgentActivityReviewSource[];
  readonly plannerCalls: readonly AgentActivityPlannerSource[];
  readonly currentAuthority?: AgentActivityCurrentAuthority;
  readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
}

// A distributive omit keeps each source variant's own required fields: the six
// task-execution sources still require an objective, while the closed-turn
// Planner call may omit it.
type DistributiveOmit<TRecord, TKey extends PropertyKey> =
  TRecord extends unknown ? Omit<TRecord, TKey> : never;

type RecordBase = DistributiveOmit<
  TaskAgentActivityOwnershipRecord,
  'currency' | 'missingSource'
>;

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
  sourceKind: TaskAgentActivitySourceKind,
  executionEpoch: number,
  boundLive: boolean | undefined,
  terminal: boolean,
  authority: AgentActivityCurrentAuthority | undefined,
  matchesAuthorityLocation: (location: AgentActivityCurrentLocation) => boolean,
): { readonly currency: TaskAgentActivityOwnershipRecord['currency']; readonly missingSource?: string } {
  // A record whose epoch is older than the authoritative task epoch is history,
  // even if a live handle still exists. The identity keeps its own epoch.
  // A closed-turn Planner call carries the closed turn's allocation epoch, not
  // the resumed segment's physical epoch, so Task epoch supersession cannot
  // settle it. Planner finality requires a real returned stage commit below.
  if (
    sourceKind !== 'closed-turn-planner-call'
    && authority !== undefined
    && authority.executionEpoch > executionEpoch
  ) {
    return { currency: 'historical' };
  }
  if (terminal) return { currency: 'historical' };
  if (boundLive === true) {
    if (authority === undefined) {
      return { currency: 'unknown', missingSource: 'current-authority' };
    }
    if (authority.locations.some(matchesAuthorityLocation)) {
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
  const { currency, missingSource } = classify(
    base.sourceKind,
    base.executionEpoch,
    boundLive,
    terminal,
    authority,
    (location) => recordMatchesLocation(base, location),
  );
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

function buildPlanner(
  source: AgentActivityPlannerSource,
  taskId: TaskId,
  authority: AgentActivityCurrentAuthority | undefined,
): BuildResult {
  const prepared = source.prepared;
  validateTaskRuntimeIncarnation(prepared.incarnation, taskId);
  validateActiveTurnProviderExecutionIdentityRef(prepared.execution);
  if (prepared.duty.taskId.value !== taskId.value) {
    return conflict(
      `planner call ${source.sourceId} duty belongs to task ${prepared.duty.taskId.value}, not ${taskId.value}`,
    );
  }
  if (prepared.duty.scope.taskId?.value !== taskId.value) {
    return conflict(
      `planner call ${source.sourceId} duty scope does not name task ${taskId.value}`,
    );
  }
  if (prepared.execution.taskId.value !== taskId.value
    || prepared.execution.runtimeId !== prepared.incarnation.runtimeId
    || prepared.incarnation.executionEpoch !== prepared.execution.executionEpoch) {
    return conflict(
      `planner call ${source.sourceId} Provider execution does not match its incarnation`,
    );
  }
  if (!sameTaskExecutionInstanceIdentity(
    { kind: 'incarnation', incarnation: prepared.lease.incarnation },
    { kind: 'incarnation', incarnation: prepared.incarnation },
  )) {
    return conflict(
      `planner call ${source.sourceId} lease incarnation does not match its prepared incarnation`,
    );
  }
  if (prepared.lease.executionEpoch !== prepared.incarnation.executionEpoch
    || prepared.lease.assignmentId !== prepared.incarnation.assignmentId) {
    return conflict(
      `planner call ${source.sourceId} lease does not match its prepared assignment or physical epoch`,
    );
  }
  if (prepared.checkpoint.checkpoint.id.value !== prepared.duty.checkpointId.value
    || prepared.checkpoint.checkpoint.scope.taskId?.value !== taskId.value
    || !sameJournalCommitRef(prepared.checkpoint.commitRef, prepared.duty.checkpointCommitRef)) {
    return conflict(
      `planner call ${source.sourceId} checkpoint does not match its duty anchor`,
    );
  }
  const hasInvoked = source.invoked !== undefined;
  const hasInvocationCommit = source.invocationCommitRef !== undefined;
  if (hasInvoked !== hasInvocationCommit) {
    return conflict(
      `planner call ${source.sourceId} invocation stage and invocation commit must be present together`,
    );
  }
  const hasReturned = source.returned !== undefined;
  const hasReturnCommit = source.returnCommitRef !== undefined;
  if (hasReturned !== hasReturnCommit) {
    return conflict(
      `planner call ${source.sourceId} return stage and return commit must be present together`,
    );
  }
  if (source.invoked !== undefined) {
    const invoked = source.invoked;
    if (invoked.kind !== 'closed-turn-planner-call' || invoked.stage !== 'invoked') {
      return conflict(`planner call ${source.sourceId} invocation record is not an invoked stage`);
    }
    if (invoked.duty.dutyKey !== prepared.duty.dutyKey
      || invoked.duty.inputDigest !== prepared.duty.inputDigest
      || invoked.invocationId !== prepared.invocationId
      || !sameJournalCommitRef(invoked.preparationCommitRef, source.preparationCommitRef)) {
      return conflict(
        `planner call ${source.sourceId} invocation record does not match its preparation`,
      );
    }
  }
  if (source.returned !== undefined) {
    if (source.invoked === undefined) {
      return conflict(`planner call ${source.sourceId} returned without an invoked stage`);
    }
    const returned = source.returned;
    if (returned.kind !== 'closed-turn-planner-call' || returned.stage !== 'returned') {
      return conflict(`planner call ${source.sourceId} return record is not a returned stage`);
    }
    if (returned.duty.dutyKey !== prepared.duty.dutyKey
      || returned.duty.inputDigest !== prepared.duty.inputDigest
      || returned.invocationId !== prepared.invocationId
      || returned.publication.scope.taskId.value !== taskId.value) {
      return conflict(
        `planner call ${source.sourceId} return record does not match its preparation`,
      );
    }
  }
  // A checkpoint or any other source's terminal commit cannot stand in for the
  // Planner's own returned record.
  if (!hasReturned) {
    if (source.terminalCommitRefs.length > 0) {
      return conflict(
        `planner call ${source.sourceId} cannot claim terminal commits without a returned record`,
      );
    }
  } else if (source.terminalCommitRefs.some(
    (ref) => !sameJournalCommitRef(ref, source.returnCommitRef!),
  )) {
    return conflict(
      `planner call ${source.sourceId} terminal commit does not match its return commit`,
    );
  }

  let businessTurnId: string | undefined;
  if (source.closure !== undefined) {
    // The optional second parameter is a TurnSummaryEvidenceContext, never a
    // scope. This input carries no such context, so validate the real closure
    // alone and associate only its scope and refs with the duty here.
    validateTurnClosureReference(source.closure);
    assertSameScope(source.closure.identity.scopeRef, prepared.duty.scope);
    if (source.closure.closureRef !== prepared.duty.closureRef
      || source.closure.checkpointId.value !== prepared.duty.checkpointId.value
      || source.closure.identity.taskRef.value !== taskId.value
      || source.closure.identity.executionEpoch !== prepared.incarnation.executionEpoch) {
      return conflict(
        `planner call ${source.sourceId} closure does not match its duty`,
      );
    }
    businessTurnId = source.closure.identity.turnId;
  }

  let segmentId: string | undefined;
  if (source.resumedSegment !== undefined) {
    validateResumedTurnSegmentOpened(source.resumedSegment);
    if (source.resumedSegment.binding.incarnation.taskId.value !== taskId.value
      || source.resumedSegment.binding.execution.executionEpoch
        !== prepared.checkpoint.checkpoint.executionEpoch
      || source.resumedSegment.businessTurnRef.execution.executionEpoch
        !== prepared.incarnation.executionEpoch) {
      return conflict(
        `planner call ${source.sourceId} resumed segment does not match its task or epochs`,
      );
    }
    if (source.closure !== undefined
      && source.resumedSegment.businessTurnRef.businessTurnId !== source.closure.identity.turnId) {
      return conflict(
        `planner call ${source.sourceId} resumed segment does not continue its closed turn`,
      );
    }
    segmentId = source.resumedSegment.segmentId;
  }

  const base: RecordBase = {
    taskId: prepared.incarnation.taskId,
    instance: { kind: 'incarnation', incarnation: prepared.incarnation },
    assignmentId: prepared.incarnation.assignmentId,
    executionEpoch: prepared.incarnation.executionEpoch,
    sourceKind: 'closed-turn-planner-call',
    ...(businessTurnId === undefined ? {} : { businessTurnId }),
    ...(segmentId === undefined ? {} : { segmentId }),
    commitRefs: [
      source.preparationCommitRef,
      ...(source.invocationCommitRef === undefined ? [] : [source.invocationCommitRef]),
      ...(source.returnCommitRef === undefined ? [] : [source.returnCommitRef]),
      prepared.grantCommitRef,
      prepared.admissionCommitRef,
      prepared.duty.checkpointCommitRef,
      ...source.commitRefs,
    ],
    evidenceRefs: [...source.evidenceRefs],
  };
  return {
    kind: 'record',
    record: makeRecord(base, source.boundLive, hasReturned, authority),
  };
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
  for (const source of input.plannerCalls ?? []) {
    const failure = apply(safeBuild(() => buildPlanner(source, input.taskId, authority)));
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

/**
 * Runtime-owned pure selector for the actual execution graph. It consumes the
 * same decoded native sources as activity selection plus the raw invocation and
 * delivery facts, and it never reads stores or derives a relation the source
 * does not prove.
 */
const ACTUAL_EXECUTION_GRAPH_OWNER_ID = 'runtime.observation.agent-activity';

function requireRecord(result: BuildResult, label: string): TaskAgentActivityOwnershipRecord {
  if (result.kind === 'record') return result.record;
  if (result.kind === 'conflict') throw new Error(result.message);
  if (result.kind === 'unavailable') throw new Error(result.source.message);
  throw new Error(`${label} was not built`);
}

function sameScopeRef(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

function nodeCommon(
  record: TaskAgentActivityOwnershipRecord,
  nodeId: string,
): {
  readonly nodeId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly objective?: string;
  readonly currency: TaskAgentActivityOwnershipRecord['currency'];
  readonly missingSource?: string;
  readonly commitRefs: readonly JournalCommitRef[];
  readonly evidenceRefs: readonly EvidenceRef[];
} {
  return {
    nodeId,
    taskId: record.taskId,
    assignmentId: record.assignmentId,
    ...(record.objective === undefined ? {} : { objective: record.objective }),
    currency: record.currency,
    ...(record.missingSource === undefined ? {} : { missingSource: record.missingSource }),
    commitRefs: [...record.commitRefs],
    evidenceRefs: [...record.evidenceRefs],
  };
}

function nativeAllocationNodeId(
  runtimeId: string,
  executionEpoch: number,
  assignmentId: string,
  operationId: string,
): string {
  return `native-allocation:${runtimeId}:${executionEpoch}:${assignmentId}:${operationId}`;
}

function activeTurnNodeId(businessTurnId: string, bindingCommitRef: JournalCommitRef): string {
  return `active-turn:${businessTurnId}:${bindingCommitRef.commitId}`;
}

function resumedSegmentNodeId(
  businessTurnId: string,
  segmentId: string,
  openedCommitRef: JournalCommitRef,
): string {
  return `resumed-segment:${businessTurnId}:${segmentId}:${openedCommitRef.commitId}`;
}

function locationKey(location: TaskActualExecutionContainingLocation): string {
  if (location.kind === 'active-turn') {
    return `active-turn:${location.businessTurnId}:${location.bindingCommitRef.commitId}`;
  }
  return `resumed-segment:${location.businessTurnId}:${location.segmentId}:${location.openedCommitRef.commitId}`;
}

function childInvocationNodeId(
  location: TaskActualExecutionContainingLocation,
  callKind: ChildCallKind,
  invocationId: string,
): string {
  return `child-invocation:${locationKey(location)}:${callKind}:${invocationId}`;
}

function orphanChildDeliveryNodeId(
  containingCommitRef: JournalCommitRef,
  deliverySeq: number,
  invocationId: string,
): string {
  return `child-delivery:${containingCommitRef.commitId}:${deliverySeq}:${invocationId}`;
}

function milestoneReviewNodeId(reviewCommitRef: JournalCommitRef): string {
  return `milestone-review:${reviewCommitRef.commitId}`;
}

function closedTurnPlannerNodeId(dutyKey: string, preparationCommitRef: JournalCommitRef): string {
  return `closed-turn-planner-call:${dutyKey}:${preparationCommitRef.commitId}`;
}

interface GraphNodeLocation {
  readonly nodeId: string;
  readonly instance: TaskExecutionInstanceIdentity;
  readonly assignmentId: string;
  readonly businessTurnId?: string;
  readonly segmentId?: string;
  readonly pipelineNodeId?: string;
  readonly containingLocation?: TaskActualExecutionContainingLocation;
}

function locationIndexMatches(
  entry: GraphNodeLocation,
  location: AgentActivityCurrentLocation,
): boolean {
  if (!sameTaskExecutionInstanceIdentity(entry.instance, location.instance)) return false;
  if (entry.assignmentId !== location.assignmentId) return false;
  if (location.businessTurnId !== undefined && entry.businessTurnId !== location.businessTurnId) return false;
  if (location.segmentId !== undefined && entry.segmentId !== location.segmentId) return false;
  if (location.nodeId !== undefined && entry.pipelineNodeId !== location.nodeId) return false;
  return true;
}

function nodeIdForContainingLocation(
  locations: readonly GraphNodeLocation[],
  location: TaskActualExecutionContainingLocation,
): string | undefined {
  const key = locationKey(location);
  return locations.find((entry) =>
    entry.containingLocation !== undefined && locationKey(entry.containingLocation) === key)?.nodeId;
}

function admittedTurnMatchesClosure(binding: ActiveTurnBinding, closure: TurnClosureReference): boolean {
  const identity = closure.identity;
  const admitted = binding.admittedTurn;
  return identity.turnId === admitted.turnId
    && identity.workAssignmentRef === binding.assignment.assignmentId
    && identity.taskRef.value === binding.assignment.taskId.value
    && sameScopeRef(identity.scopeRef, binding.scope)
    && identity.cycleRef.value === admitted.cycleRef.value
    && identity.inputRevision === admitted.inputRevision
    && identity.directiveRevision === admitted.directiveRevision
    && identity.executionEpoch === binding.execution.executionEpoch
    && identity.runtimeBindingRef === admitted.runtimeBindingRef
    && identity.permissionRevision === admitted.permissionRevision;
}

function businessClosureFor(
  binding: ActiveTurnBinding,
  closures: SelectTaskActualExecutionGraphInput['businessClosures'],
): TaskActualExecutionBusinessClosure {
  const matching = closures.filter(({ closure }) => admittedTurnMatchesClosure(binding, closure));
  if (matching.length === 1) {
    return { status: 'recorded', closure: matching[0]!.closure, commitRef: matching[0]!.commitRef };
  }
  if (matching.length > 1) {
    return {
      status: 'unknown',
      reason: 'multiple business closure records match this admitted turn',
    };
  }
  return {
    status: 'unknown',
    reason: 'no exact business closure record matches this admitted turn',
  };
}

function graphCurrency(
  sourceKind: TaskAgentActivitySourceKind,
  executionEpoch: number,
  boundLive: boolean | undefined,
  terminal: boolean,
  authority: AgentActivityCurrentAuthority | undefined,
  matchesAuthorityLocation: (location: AgentActivityCurrentLocation) => boolean,
): { readonly currency: TaskAgentActivityOwnershipRecord['currency']; readonly missingSource?: string } {
  return classify(sourceKind, executionEpoch, boundLive, terminal, authority, matchesAuthorityLocation);
}

function childInvocationLocationMatches(
  incarnation: TaskRuntimeIncarnation | undefined,
  assignmentId: string,
  location: AgentActivityCurrentLocation,
): boolean {
  return incarnation !== undefined
    && sameTaskExecutionInstanceIdentity(location.instance, { kind: 'incarnation', incarnation })
    && location.assignmentId === assignmentId;
}

function graphUnavailableSource(
  sourceId: string,
  ownerId: string,
  message: string,
): TaskAgentActivityUnavailableSource {
  return { sourceId, ownerId, message };
}

function pushUnavailable(
  sources: TaskAgentActivityUnavailableSource[],
  source: TaskAgentActivityUnavailableSource,
): void {
  if (sources.some((existing) => existing.sourceId === source.sourceId
    && existing.ownerId === source.ownerId
    && existing.message === source.message)) return;
  sources.push(source);
}

export function selectTaskActualExecutionGraph(
  input: SelectTaskActualExecutionGraphInput,
): TaskActualExecutionGraphSnapshot {
  const taskId = input.taskScope.taskId;
  const authority = input.currentAuthority;
  const nodes: TaskActualExecutionGraphNode[] = [];
  const edges: TaskActualExecutionGraphEdge[] = [];
  const ungrouped: TaskActualExecutionGraphUngroupedRelation[] = [];
  const unavailableSources = [...input.unavailableSources];
  const locations: GraphNodeLocation[] = [];

  if (authority !== undefined && authority.taskId.value !== taskId.value) {
    throw new Error(
      `current authority belongs to task ${authority.taskId.value}, not ${taskId.value}`,
    );
  }

  for (const source of input.nativeAllocations) {
    const record = requireRecord(
      safeBuild(() => buildNative(source, taskId, authority)),
      `native allocation ${source.sourceId}`,
    );
    const allocation = source.allocation;
    nodes.push({
      ...nodeCommon(record, nativeAllocationNodeId(
        allocation.runtimeId,
        allocation.executionEpoch,
        allocation.assignmentId,
        allocation.operationId.value,
      )),
      kind: 'native-allocation',
      instance: {
        kind: 'native-execution',
        execution: { runtimeId: allocation.runtimeId, executionEpoch: allocation.executionEpoch },
      },
      executionEpoch: allocation.executionEpoch,
      objective: source.objective,
      allocation: {
        runtimeId: allocation.runtimeId,
        operationId: allocation.operationId,
        executionEpoch: allocation.executionEpoch,
        assignmentId: allocation.assignmentId,
        scope: allocation.scope,
        inputRefs: [...allocation.inputRefs],
        ownerId: allocation.ownerId,
        directiveRevision: allocation.directiveRevision,
        inputRevision: allocation.inputRevision,
        orchestrated: allocation.orchestrated,
        ...(allocation.role === undefined ? {} : { role: allocation.role }),
        ...(allocation.configuredAgentId === undefined
          ? {}
          : { configuredAgentId: allocation.configuredAgentId }),
      },
    });
  }

  for (const source of input.activeTurns) {
    const record = requireRecord(
      safeBuild(() => buildActive(source, taskId, authority)),
      `active turn ${source.sourceId}`,
    );
    const binding = source.binding;
    const businessTurnId = binding.admittedTurn.turnId;
    const nodeId = activeTurnNodeId(businessTurnId, source.bindingCommitRef);
    nodes.push({
      ...nodeCommon(record, nodeId),
      kind: 'active-turn',
      instance: { kind: 'native-execution', execution: binding.execution },
      executionEpoch: binding.execution.executionEpoch,
      businessTurnId,
      pipelineNodeId: binding.assignment.pipelineNodeId,
      binding,
      bindingCommitRef: source.bindingCommitRef,
      businessClosure: businessClosureFor(binding, input.businessClosures),
    });
    locations.push({
      nodeId,
      instance: { kind: 'native-execution', execution: binding.execution },
      assignmentId: binding.assignment.assignmentId,
      businessTurnId,
      pipelineNodeId: binding.assignment.pipelineNodeId,
      containingLocation: {
        kind: 'active-turn',
        businessTurnId,
        bindingCommitRef: source.bindingCommitRef,
      },
    });
  }

  for (const source of input.resumedSegments) {
    const record = requireRecord(
      safeBuild(() => buildResumed(source, taskId, authority)),
      `resumed segment ${source.sourceId}`,
    );
    const opened = source.opened;
    const businessTurnId = opened.businessTurnRef.businessTurnId;
    const nodeId = resumedSegmentNodeId(businessTurnId, opened.segmentId, source.openedCommitRef);
    const exactTerminalCommitRefs = source.terminalCommitRefs.filter((ref) =>
      !input.businessClosures.some(({ commitRef }) => sameJournalCommitRef(ref, commitRef)));
    nodes.push({
      ...nodeCommon(record, nodeId),
      kind: 'resumed-segment',
      instance: { kind: 'incarnation', incarnation: opened.binding.incarnation },
      executionEpoch: opened.binding.incarnation.executionEpoch,
      businessTurnId,
      segmentId: opened.segmentId,
      pipelineNodeId: opened.binding.assignment.pipelineNodeId,
      opened,
      openedCommitRef: source.openedCommitRef,
      terminalCommitRefs: exactTerminalCommitRefs,
      segmentState: { status: 'opened' },
    });
    locations.push({
      nodeId,
      instance: { kind: 'incarnation', incarnation: opened.binding.incarnation },
      assignmentId: opened.binding.assignment.assignmentId,
      businessTurnId,
      segmentId: opened.segmentId,
      pipelineNodeId: opened.binding.assignment.pipelineNodeId,
      containingLocation: {
        kind: 'resumed-segment',
        businessTurnId,
        segmentId: opened.segmentId,
        openedCommitRef: source.openedCommitRef,
      },
    });
  }

  const joinedDeliveries = new Set<AcceptedChildDelivery>();
  for (const source of input.rawChildInvocations) {
    const record = source.record;
    const binding = record.binding;
    const callKind = binding.kind;
    const assignment = binding.assignment;
    const assignmentTaskId = binding.kind === 'execution'
      ? binding.assignment.taskId.value
      : binding.assignment.taskId;
    if (assignmentTaskId !== taskId.value) {
      throw new Error(
        `child invocation ${record.invocationId} belongs to task ${assignmentTaskId}, not ${taskId.value}`,
      );
    }
    const invocationId = record.invocationId;
    const nodeId = childInvocationNodeId(source.containingLocation, callKind, invocationId);
    const matchingDeliveries = input.childDeliveries.filter(({ delivery, containingLocation }) =>
      delivery.invocationId === invocationId
      && delivery.kind === callKind
      && containingLocation !== undefined
      && locationKey(containingLocation) === locationKey(source.containingLocation));
    if (matchingDeliveries.length > 1) {
      throw new Error(
        `child invocation ${invocationId} has multiple exact accepted deliveries`,
      );
    }
    const matchedDelivery = matchingDeliveries[0];
    if (matchedDelivery !== undefined) joinedDeliveries.add(matchedDelivery.delivery);
    const returned = matchedDelivery === undefined
      ? { status: 'unreturned' as const }
      : {
          status: 'returned' as const,
          delivery: matchedDelivery.delivery,
          deliveryCommitRef: matchedDelivery.commitRef,
        };
    const adoption = record.adoptedResultSeq !== undefined && record.notSelectedResultSeq !== undefined
      ? { status: 'unknown' as const, reason: 'child invocation carries conflicting adoption facts' }
      : record.adoptedResultSeq !== undefined
        ? { status: 'adopted' as const, resultSeq: record.adoptedResultSeq }
        : record.notSelectedResultSeq !== undefined
          ? { status: 'not-selected' as const, resultSeq: record.notSelectedResultSeq }
          : { status: 'undecided' as const };
    const carrierNodeId = nodeIdForContainingLocation(locations, source.containingLocation);
    const parentLocationMismatch = source.parentLocation !== undefined
      && !locations.some((entry) =>
        entry.nodeId === carrierNodeId && locationIndexMatches(entry, source.parentLocation!));
    const linkage = carrierNodeId !== undefined && !parentLocationMismatch
      ? { status: 'linked' as const, parentNodeId: carrierNodeId }
      : {
          status: 'ungrouped' as const,
          reason: carrierNodeId === undefined
            ? 'the containing location has no selected graph node'
            : 'the explicit parent location does not match the containing location',
        };
    const terminal = returned.status === 'returned' || source.terminalCommitRefs.length > 0;
    const incarnation = record.incarnation;
    const { currency, missingSource } = graphCurrency(
      'child-invocation',
      assignment.executionEpoch,
      source.boundLive,
      terminal,
      authority,
      (location) => childInvocationLocationMatches(incarnation, assignment.assignmentId, location),
    );
    if (incarnation === undefined) {
      pushUnavailable(unavailableSources, graphUnavailableSource(
        source.sourceId,
        source.ownerId,
        `child invocation ${invocationId} has no acquired incarnation`,
      ));
    }
    nodes.push({
      nodeId,
      taskId,
      assignmentId: assignment.assignmentId,
      ...(source.objective === undefined ? {} : { objective: source.objective }),
      currency,
      ...(missingSource === undefined ? {} : { missingSource }),
      commitRefs: [source.commitRef, ...source.commitRefs],
      evidenceRefs: [...source.evidenceRefs],
      kind: 'child-invocation',
      callKind,
      invocationId,
      childTurnId: record.childTurnId,
      checkpointReceiptRef: record.checkpointReceiptRef,
      record,
      invocationCommitRef: source.commitRef,
      containingLocation: source.containingLocation,
      linkage,
      acquisition: incarnation === undefined
        ? { status: 'unacquired', reason: 'child invocation has no acquired incarnation' }
        : { status: 'acquired', incarnation },
      returnState: returned,
      adoption,
    });
    if (linkage.status === 'linked') {
      edges.push({
        edgeId: `delegates-child:${linkage.parentNodeId}->${nodeId}`,
        kind: 'delegates-child',
        fromNodeId: linkage.parentNodeId,
        toNodeId: nodeId,
      });
    } else {
      ungrouped.push({
        nodeId,
        kind: 'delegates-child',
        targetRef: locationKey(source.containingLocation),
        reason: linkage.reason,
      });
    }
  }

  for (const source of input.childDeliveries) {
    if (joinedDeliveries.has(source.delivery)) continue;
    const delivery = source.delivery;
    const assignment = delivery.assignment;
    const deliveryTaskId = delivery.kind === 'execution'
      ? delivery.assignment.taskId.value
      : delivery.assignment.taskId;
    if (deliveryTaskId !== taskId.value) {
      throw new Error(
        `child delivery ${delivery.invocationId} belongs to task ${deliveryTaskId}, not ${taskId.value}`,
      );
    }
    const nodeId = orphanChildDeliveryNodeId(
      source.commitRef,
      delivery.seq,
      delivery.invocationId,
    );
    const carrierNodeId = source.containingLocation === undefined
      ? undefined
      : nodeIdForContainingLocation(locations, source.containingLocation);
    const { currency, missingSource } = graphCurrency(
      'child-invocation',
      assignment.executionEpoch,
      source.boundLive,
      source.terminalCommitRefs.length > 0,
      authority,
      () => false,
    );
    pushUnavailable(unavailableSources, graphUnavailableSource(
      source.sourceId,
      source.ownerId,
      `child delivery ${delivery.invocationId} has no exact recorded invocation`,
    ));
    nodes.push({
      nodeId,
      taskId,
      assignmentId: assignment.assignmentId,
      ...(delivery.kind === 'execution' ? { objective: delivery.assignment.objective } : {}),
      currency,
      ...(missingSource === undefined ? {} : { missingSource }),
      commitRefs: [source.commitRef, ...source.commitRefs],
      evidenceRefs: [...source.evidenceRefs],
      kind: 'orphan-child-delivery',
      callKind: delivery.kind,
      invocationId: delivery.invocationId,
      delivery,
      containingCommitRef: source.commitRef,
      deliverySeq: delivery.seq,
      ...(source.containingLocation === undefined
        ? {}
        : { containingLocation: source.containingLocation }),
      linkage: { status: 'orphan', reason: 'invocation-not-recorded' },
    });
    if (carrierNodeId !== undefined) {
      edges.push({
        edgeId: `contains:${carrierNodeId}->${nodeId}`,
        kind: 'contains',
        fromNodeId: carrierNodeId,
        toNodeId: nodeId,
      });
    } else {
      ungrouped.push({
        nodeId,
        kind: 'contains',
        targetRef: source.containingLocation === undefined
          ? `child-delivery:${delivery.invocationId}`
          : locationKey(source.containingLocation),
        reason: 'the containing location has no selected graph node',
      });
    }
  }

  for (const source of input.milestoneReviews) {
    const record = requireRecord(
      safeBuild(() => buildReview(source, taskId, authority)),
      `milestone review ${source.sourceId}`,
    );
    const reviewer = source.record.delivery.reviewer;
    nodes.push({
      ...nodeCommon(record, milestoneReviewNodeId(source.commitRef)),
      kind: 'milestone-review',
      instance: { kind: 'incarnation', incarnation: reviewer },
      executionEpoch: reviewer.executionEpoch,
      record: source.record,
      reviewCommitRef: source.commitRef,
    });
  }

  for (const source of input.plannerCalls) {
    const record = requireRecord(
      safeBuild(() => buildPlanner(source, taskId, authority)),
      `closed-turn planner call ${source.sourceId}`,
    );
    const prepared = source.prepared;
    const stage = source.returned !== undefined
      ? 'returned' as const
      : source.invoked !== undefined
        ? 'invoked' as const
        : 'prepared' as const;
    const businessTurnId = source.closure?.identity.turnId ?? record.businessTurnId;
    const segmentId = source.resumedSegment?.segmentId ?? record.segmentId;
    const closureCommitRef = source.closure === undefined
      ? undefined
      : input.businessClosures.find(({ closure }) =>
          closure.closureRef === source.closure!.closureRef
          && closure.checkpointId.value === source.closure!.checkpointId.value
          && closure.identity.turnId === source.closure!.identity.turnId)?.commitRef;
    const nodeId = closedTurnPlannerNodeId(prepared.duty.dutyKey, source.preparationCommitRef);
    nodes.push({
      ...nodeCommon(record, nodeId),
      kind: 'closed-turn-planner-call',
      stage,
      dutyKey: prepared.duty.dutyKey,
      invocationId: prepared.invocationId,
      scope: prepared.duty.scope,
      ...(businessTurnId === undefined ? {} : { businessTurnId }),
      ...(segmentId === undefined ? {} : { segmentId }),
      instance: { kind: 'incarnation', incarnation: prepared.incarnation },
      execution: prepared.execution,
      checkpointId: prepared.duty.checkpointId,
      checkpointCommitRef: prepared.duty.checkpointCommitRef,
      ...(source.closure === undefined ? {} : { closureRef: source.closure.closureRef }),
      ...(closureCommitRef === undefined ? {} : { closureCommitRef }),
      grantCommitRef: prepared.grantCommitRef,
      admissionCommitRef: prepared.admissionCommitRef,
      preparationCommitRef: source.preparationCommitRef,
      ...(source.invocationCommitRef === undefined
        ? {}
        : { invocationCommitRef: source.invocationCommitRef }),
      ...(source.returnCommitRef === undefined ? {} : { returnCommitRef: source.returnCommitRef }),
      ...(source.returned === undefined
        ? {}
        : {
            planRevision: {
              revisionId: source.returned.publication.revisionId,
              sequence: source.returned.publication.sequence,
              decision: source.returned.decision,
            },
          }),
    });
    if (source.closure === undefined) {
      ungrouped.push({
        nodeId,
        kind: 'planner-duty',
        targetRef: prepared.duty.dutyKey,
        reason: 'the planner preparation has no exact turn closure fact',
      });
    } else {
      const closure = source.closure;
      const parent = input.activeTurns.find(({ binding }) =>
        admittedTurnMatchesClosure(binding, closure));
      if (parent === undefined) {
        ungrouped.push({
          nodeId,
          kind: 'planner-duty',
          targetRef: closure.closureRef,
          reason: 'the closed turn has no selected active-turn node',
        });
      } else {
        edges.push({
          edgeId: `planner-duty:${activeTurnNodeId(closure.identity.turnId, parent.bindingCommitRef)}->${nodeId}`,
          kind: 'planner-duty',
          fromNodeId: activeTurnNodeId(closure.identity.turnId, parent.bindingCommitRef),
          toNodeId: nodeId,
        });
      }
    }
  }

  for (const activeSource of input.activeTurns) {
    const binding = activeSource.binding;
    const activeNodeId = activeTurnNodeId(binding.admittedTurn.turnId, activeSource.bindingCommitRef);
    const allocation = input.nativeAllocations.find(({ allocation: candidate }) =>
      candidate.taskId.value === taskId.value
      && candidate.assignmentId === binding.assignment.assignmentId
      && candidate.executionEpoch === binding.execution.executionEpoch
      && candidate.runtimeId === binding.execution.runtimeId
      && candidate.operationId.value === binding.scope.operationId?.value);
    if (allocation !== undefined) {
      const allocationNodeId = nativeAllocationNodeId(
        allocation.allocation.runtimeId,
        allocation.allocation.executionEpoch,
        allocation.allocation.assignmentId,
        allocation.allocation.operationId.value,
      );
      edges.push({
        edgeId: `contains:${allocationNodeId}->${activeNodeId}`,
        kind: 'contains',
        fromNodeId: allocationNodeId,
        toNodeId: activeNodeId,
      });
    }
  }

  for (const resumedSource of input.resumedSegments) {
    const opened = resumedSource.opened;
    const businessTurnId = opened.businessTurnRef.businessTurnId;
    const resumedNodeId = resumedSegmentNodeId(
      businessTurnId,
      opened.segmentId,
      resumedSource.openedCommitRef,
    );
    const parent = input.activeTurns.find(({ binding, bindingCommitRef }) =>
      binding.admittedTurn.turnId === businessTurnId
      && sameJournalCommitRef(bindingCommitRef, opened.businessTurnRef.bindingCommitRef));
    if (parent === undefined) {
      ungrouped.push({
        nodeId: resumedNodeId,
        kind: 'contains',
        targetRef: opened.businessTurnRef.bindingCommitRef.commitId,
        reason: 'the original business turn has no selected active-turn node',
      });
    } else {
      const parentNodeId = activeTurnNodeId(businessTurnId, parent.bindingCommitRef);
      edges.push({
        edgeId: `contains:${parentNodeId}->${resumedNodeId}`,
        kind: 'contains',
        fromNodeId: parentNodeId,
        toNodeId: resumedNodeId,
      });
    }
    const predecessorSegmentId = opened.predecessor.segmentId;
    const predecessor = nodes.find((node) =>
      node.kind === 'resumed-segment'
      && node.businessTurnId === businessTurnId
      && node.segmentId === predecessorSegmentId);
    if (predecessor === undefined) {
      ungrouped.push({
        nodeId: resumedNodeId,
        kind: 'precedes',
        targetRef: predecessorSegmentId,
        reason: 'the exact predecessor segment has no selected graph node',
      });
    } else {
      edges.push({
        edgeId: `precedes:${predecessor.nodeId}->${resumedNodeId}`,
        kind: 'precedes',
        fromNodeId: predecessor.nodeId,
        toNodeId: resumedNodeId,
      });
    }
  }

  if (nodes.length === 0) {
    return {
      taskScope: input.taskScope,
      ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
      history: {
        status: 'not-recorded',
        reason: 'no-recorded-facts',
        ...(unavailableSources.length === 0 ? {} : { unavailable: unavailableSources }),
      },
    };
  }
  return {
    taskScope: input.taskScope,
    ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
    history: {
      status: 'recorded',
      nodes,
      edges,
      ungrouped,
      unavailable: unavailableSources,
    },
  };
}
