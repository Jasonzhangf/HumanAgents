import { createHash } from 'node:crypto';
import {
  assertExecutionEpoch,
  assertSameScope,
  id,
  validateAdmittedTurn,
  validateAdmittedTurnIdentity,
  validateJournalCommitRef,
  validatePlannerAlignmentReference,
  validateTurnCloseSummary,
  type AdmittedTurnIdentity,
  type AgentLoopBudget,
  type AgentLoopBudgetUsage,
  type AgentLoopCheckpoint,
  type AgentLoopCheckpointRef,
  type AgentLoopEventWatermark,
  type AgentMode,
  type AgentModeCapabilityProfile,
  type AgentModeState,
  type AgentModeTransition,
  type Checkpoint,
  type ContextBuildInput,
  type ContextHistoryRecord,
  type ContextLoopControl,
  type ContextReplacement,
  type ContextReplacementReason,
  type ContextView,
  type CycleId,
  type EvidenceRef,
  type JournalCommitRef,
  type JsonValue,
  type NextAction,
  type ObservationBatch,
  type ObservationDelta,
  type ObservationScope,
  type ObservationScopeKind,
  type OperationId,
  type PlannerAlignmentDecision,
  type PlannerAlignmentReference,
  type PublishedTaskPlanRevision,
  type ScopeRef,
  type TurnCloseSummary,
  type TurnClosureReference,
  type TurnRecoveryReference,
} from '../../../contracts/src/index.js';
import { validateContextHistoryRecord } from '../../../contracts/src/agent-loop.js';
import { validateActiveTurnCaptureBody } from '../../../contracts/src/active-turn-context.js';
import {
  validateResumedTurnSegmentOpened,
  type ActiveTurnInitialSegmentCapture,
  type ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import {
  assertAgentModeTransitionCurrent,
  assertContextReplacementCurrent,
  assertModeCapabilityGranted,
  assertModeLeaseCurrent,
  assertObservationBatchFresh,
  assertObservationDeltaCurrent,
  assertTurnAdvanceAdmission,
  assertTurnAlignmentBinding,
  assertTurnDecisionAdmission,
  assertSameAdmittedTurn,
  classifyAgentLoopBudget,
  type AgentLoopDeltaState,
  type AgentLoopInboxState,
  type TurnAdvanceAdmission,
} from '../../../core/src/index.js';
import {
  validateAgentLoopBudget,
  validateAgentLoopCheckpoint,
  validateAgentLoopScopeRef,
  validateModeCapabilityProfile,
} from '../../../contracts/src/agent-loop.js';
import {
  assertPlannerAlignmentRecord,
  assertTurnClosureRecord,
  assertTurnRecoveryRecord,
  distinctReviewCommitRefs,
  frozenTurnCloseRef,
  sameReviewCommitRefs,
  sanitizeId,
  turnBoundaryRecordRefs,
  type CheckpointClosurePreparationRecord,
  type CheckpointSubmissionSource,
  type ClosureRecord,
  type OperationReconcileResult,
  type PlannerAlignmentRecord,
  type TurnClosureRecord,
  type TurnRecoveryPhase,
  type TurnRecoveryRecord,
} from '../checkpoints/closure.js';
import type { CheckpointClosurePort, CheckpointJournalPort } from '../checkpoints/ports.js';
import type { LatestCheckpointRecord } from '../checkpoints/ports.js';
import type { ContextHistoryPort } from '../checkpoints/ports.js';
import {
  durableContextDigest,
  produceContextHistory,
  readCommittedContextHistory,
} from '../checkpoints/coordinator.js';
import type {
  TaskPlanRevisionConsumerPort,
  TaskPlanRevisionPublishInput,
} from '../orchestration/task-plan-revisions.js';
import { submitCheckpoint } from '../checkpoints/submission.js';
import { RuntimeError } from '../nodes/errors.js';
import { AgentLoopRuntimeError } from './errors.js';

export interface AgentLoopActor {
  readonly agentRuntimeId: string;
  readonly leaseId: string;
}

export interface AgentLoopRuntimeRequest {
  readonly agentRuntimeId: string;
  readonly role: AgentModeCapabilityProfile['role'];
  readonly mode: AgentMode;
  readonly profiles: readonly AgentModeCapabilityProfile[];
  readonly budget: AgentLoopBudget;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly permissionRevision: string;
  readonly observationStreamId: string;
  /**
   * Optional durable turn binding. When present, the loop can close the current
   * logical turn through the existing `submitCheckpoint` durability path. Without
   * it, `closeTurn`/`advanceTurn` are unavailable and no turn can advance.
   */
  readonly turn?: AgentLoopTurnConfig;
  readonly activeRefs?: readonly string[];
  readonly omittedRefs?: readonly string[];
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
}

/** Start request. The durable body is the real pre-transient four-array assembly. */
export interface AgentLoopStartRequest extends AgentLoopRuntimeRequest {
  readonly durableContext: ContextBuildInput<JsonValue>;
}

/** Restore request. The committed body replaces this request's in-memory assembly. */
export type AgentLoopRestoreRequest = AgentLoopRuntimeRequest;

/** Exact historical physical binding for one original admitted business turn. */
export type HistoricalTurnBinding =
  | {
      readonly kind: 'initial';
      readonly initial: ActiveTurnInitialSegmentCapture;
    }
  | {
      readonly kind: 'segment';
      readonly segment: ResumedTurnSegmentOpened;
    };

export interface AgentLoopTurnConfig {
  readonly identity: AdmittedTurnIdentity;
  readonly cycleId: CycleId;
  readonly directiveRevision: number;
  readonly ownerId: string;
  readonly journal: CheckpointJournalPort;
  readonly closurePort: CheckpointClosurePort;
}

/** Recovery responsibility carried alongside the semantic four-part summary. */
export interface TurnRecoveryFacts {
  readonly contextRef: string;
  readonly unfinishedRef: string;
  readonly unreturnedCallRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
  readonly firstErrorRef?: string;
}

export interface CloseTurnInput {
  readonly reviewCommitRefs?: readonly JournalCommitRef[];
  readonly prepareCheckpointClosure?: (checkpoint: Checkpoint) => Promise<{
    readonly preparation: CheckpointClosurePreparationRecord;
    readonly turnRecoveryRef: string;
  }>;
  readonly summary: TurnCloseSummary;
  readonly recovery: TurnRecoveryFacts;
  readonly outcome: Checkpoint['outcome'];
  readonly source: CheckpointSubmissionSource;
  readonly permissionRevoked?: boolean;
  readonly hardBlockers?: readonly string[];
  readonly unknownOperations?: readonly OperationId[];
  readonly reconciledOperations?: readonly OperationReconcileResult[];
}

/**
 * Front-segment turn-close outcome. `closed-awaiting-planner-alignment` means the
 * four-part summary, durable checkpoint, checkpoint closure and turn-closure record
 * are all committed. It is NOT a terminal or next-turn authorization: that needs the
 * T1 planner alignment, so `advance` stays blocked.
 */
export type TurnCloseResult =
  | {
    readonly state: 'closed-awaiting-planner-alignment';
    readonly turnSummary: TurnCloseSummary;
    readonly checkpoint: Checkpoint;
    readonly closureRef: string;
    readonly recoveryStateRef: EvidenceRef;
    readonly plannerAlignment: 'pending';
    readonly advance: 'blocked-pending-planner-alignment';
  }
  | {
    readonly state: 'recovering';
    readonly recovery: TurnRecoveryReference;
    readonly failedPhase: TurnRecoveryRecord['failedPhase'];
    readonly firstErrorRef: string;
    readonly advance: 'blocked-recovery';
  };

export interface AlignTurnInput {
  /**
   * The real Runtime task-plan revision consumer. Alignment goes through this interface;
   * the turn controller never keeps a private revision store.
   */
  readonly consumer: TaskPlanRevisionConsumerPort;
  /**
   * The planner publication to align to. An already-committed revision is read back first,
   * so a recovery never publishes a second durable record.
   */
  readonly publication: TaskPlanRevisionPublishInput;
  readonly decision: PlannerAlignmentDecision;
}

/**
 * Back-segment alignment outcome. `aligned` means the durable planner-alignment fact is
 * committed and the `continue`/`complete`/`failed` admission is bound to the same turn,
 * checkpoint, and closure. `recovering` keeps the original logical turn and its recovery
 * responsibility instead of advancing.
 */
export type TurnAlignmentResult =
  | {
    readonly state: 'aligned';
    readonly alignment: PlannerAlignmentReference;
    readonly admission: TurnAdvanceAdmission;
    readonly advance: 'admitted';
  }
  | {
    readonly state: 'recovering';
    readonly recovery: TurnRecoveryReference;
    readonly failedPhase: 'alignment';
    readonly firstErrorRef: string;
    readonly advance: 'blocked-recovery';
  };

/**
 * Turn-advance gate. A next logical turn is only admitted for `continue`; `complete` and
 * `failed` end the task. Both require a committed closure plus a matching planner
 * alignment, so every other phase stays blocked on the original logical turn.
 */
export interface AdvanceTurnResult {
  readonly advanced: boolean;
  readonly state: 'open' | 'recovering' | 'awaiting-planner-alignment' | 'advancing' | 'terminal';
  readonly reason: string;
  readonly decision?: PlannerAlignmentDecision;
  readonly alignment?: PlannerAlignmentReference;
  readonly admission?: TurnAdvanceAdmission;
  readonly recoveryRef?: string;
}

/**
 * The authoritative durable stage of the current logical turn, read back on recovery.
 * `unknown` means the stage could not be confirmed, so the turn stays paused rather
 * than being treated as absent.
 */
export type TurnRecoveryStage =
  | 'closure-absent'
  | 'closure-committed-alignment-absent'
  | 'alignment-committed'
  | 'unknown';

export interface RecoverTurnResult {
  readonly stage: TurnRecoveryStage;
  readonly turnId: string;
  readonly checkpointId?: Checkpoint['id'];
  readonly closure?: TurnClosureReference;
  readonly alignment?: PlannerAlignmentReference;
  readonly recovery?: TurnRecoveryReference;
  readonly advance: 'resume-same-turn' | 'alignment-only' | 'readback-only' | 'paused';
}

/**
 * Recovery entry input. It is the same planner context as alignment. Recovery reads the
 * authoritative durable stage first and only runs planner alignment when the closure is
 * already committed and the alignment is still missing.
 */
export type RecoverTurnInput = AlignTurnInput;

/** Authoritative durable stage read back by `recoverTurn` before it resumes the turn. */
type ResolvedTurnRecoveryStage =
  | { readonly kind: 'unknown' }
  | {
    readonly kind: 'closure-absent';
    readonly checkpointId?: Checkpoint['id'];
    readonly recovery?: TurnRecoveryRecord;
  }
  | {
    readonly kind: 'closure-committed-alignment-absent';
    readonly checkpointId: Checkpoint['id'];
    readonly closure: TurnClosureReference;
    readonly recovery: TurnRecoveryRecord;
  }
  | {
    readonly kind: 'alignment-committed';
    readonly checkpointId: Checkpoint['id'];
    readonly closure: TurnClosureReference;
    readonly alignment: PlannerAlignmentReference;
  };

export interface OpenObservationScopeRequest {
  readonly actor: AgentLoopActor;
  readonly kind: ObservationScopeKind;
  readonly scope: ScopeRef;
  readonly readableRefs: readonly string[];
  readonly capabilities: readonly string[];
}

export interface TransitionModeRequest {
  readonly actor: AgentLoopActor;
  readonly toMode: AgentMode;
  readonly reason: AgentModeTransition['reason'];
  readonly deltaIds: readonly string[];
  readonly summary: string;
  readonly contextViewRef: string;
  readonly contextDigest: string;
  readonly activeRefs: readonly string[];
  readonly omittedRefs: readonly string[];
  readonly replacementReason?: ContextReplacementReason;
  /** Ordered durable context body assembled before any transient request instruction. */
  readonly durableContext: ContextBuildInput<JsonValue>;
}

export interface AgentLoopSnapshot {
  readonly modeState: AgentModeState;
  readonly checkpoint: AgentLoopCheckpoint;
  readonly contextView: ContextView;
  readonly lease: import('../../../contracts/src/index.js').ModeLease;
  readonly budgetUsage: AgentLoopBudgetUsage;
  readonly observationScope?: ObservationScope;
  readonly checkpointHistory: readonly AgentLoopCheckpoint[];
  readonly appliedDeltaIds: readonly string[];
  readonly handledBatchKeys: readonly string[];
}

/**
 * The actual in-memory logical-turn transition owned by this runtime. This is
 * the narrow owner exposure the current-state serialization consumes. It is
 * derived only from `turnState`; it never infers a phase from transport
 * termination, a localized label, an event stream or `snapshot()`.
 */
export interface AgentLoopTurnTransition {
  readonly phase: 'open' | 'recovering' | 'awaiting-planner-alignment' | 'aligned';
  readonly nextAction: NextAction;
  /**
   * The actual owner of the bound logical turn. It is absent only when the
   * runtime has no durable turn binding and therefore cannot publish a
   * current-state transition.
   */
  readonly turnOwnerRef?: string;
  readonly recoveryResponsibilityRef?: string;
  readonly firstErrorRef?: string;
  readonly laterErrorRefs: readonly string[];
  /**
   * Operations the turn recovery record still owns. The coordinator maps these
   * to retained reentry duties with `turnOwnerRef` as the responsibility owner.
   */
  readonly unresolvedOperationRefs: readonly string[];
}

export interface ObservationDeltaResult {
  readonly delta: ObservationDelta;
  readonly replacement: ContextReplacement;
  readonly checkpoint: AgentLoopCheckpoint;
  readonly contextView: ContextView;
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new RuntimeError(`${label} is required`);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function sameCheckpoint(left: AgentLoopCheckpointRef, right: AgentLoopCheckpointRef): boolean {
  return left.checkpointId.scope === right.checkpointId.scope
    && left.checkpointId.value === right.checkpointId.value
    && left.digest === right.digest;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.scope === right.organId.scope
    && left.organId.value === right.organId.value
    && left.taskId?.scope === right.taskId?.scope
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.scope === right.cycleId?.scope
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.scope === right.operationId?.scope
    && left.operationId?.value === right.operationId?.value;
}

/**
 * Derive the actual physical execution binding for a historical restore. The original
 * admitted identity stays untouched; only the real initial capture or committed segment
 * supplies the runtime id, physical epoch and scope that own the exact context.
 */
function historicalPhysicalBinding(
  binding: HistoricalTurnBinding,
  identity: AdmittedTurnIdentity,
): {
  readonly agentRuntimeId: string;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly committedSegment?: ResumedTurnSegmentOpened;
} {
  if (binding.kind === 'initial') {
    const { initial } = binding;
    validateJournalCommitRef(initial.bindingCommitRef);
    validateActiveTurnCaptureBody(initial.body);
    const capture = initial.body.binding;
    try {
      validateAdmittedTurn(capture.admittedTurn, identity);
    } catch {
      throw new AgentLoopRuntimeError('conflict', 'historical initial capture does not bind the original admitted turn');
    }
    if (!sameScope(capture.scope, identity.scopeRef)
      || !sameId(capture.assignment.taskId, identity.taskRef)
      || capture.assignment.assignmentId !== identity.workAssignmentRef
      || capture.assignment.inputRevision !== identity.inputRevision
      || capture.execution.executionEpoch !== identity.executionEpoch) {
      throw new AgentLoopRuntimeError('conflict', 'historical initial capture does not bind the original business turn and execution');
    }
    return {
      agentRuntimeId: capture.execution.runtimeId,
      executionEpoch: capture.execution.executionEpoch,
      scope: capture.scope,
    };
  }

  const { segment } = binding;
  validateResumedTurnSegmentOpened(segment);
  const { businessTurnRef, assignment, execution, incarnation, scope } = segment.binding;
  if (identity.turnId !== segment.businessTurnRef.businessTurnId
    || identity.turnId !== businessTurnRef.businessTurnId
    || identity.workAssignmentRef !== assignment.assignmentId
    || !sameId(identity.taskRef, assignment.taskId)
    || !sameScope(identity.scopeRef, scope)
    || identity.inputRevision !== assignment.inputRevision
    || identity.executionEpoch !== businessTurnRef.execution.executionEpoch
    || identity.executionEpoch !== assignment.executionEpoch
    || !sameId(incarnation.taskId, assignment.taskId)
    || incarnation.assignmentId !== assignment.assignmentId
    || incarnation.runtimeId !== execution.runtimeId
    || incarnation.executionEpoch !== execution.executionEpoch
    || digest(segment.binding.businessTurnRef) !== digest(segment.businessTurnRef)) {
    throw new AgentLoopRuntimeError('conflict', 'historical segment does not bind the original business turn and physical execution');
  }
  return {
    agentRuntimeId: execution.runtimeId,
    executionEpoch: execution.executionEpoch,
    scope,
    committedSegment: segment,
  };
}

function refOf(checkpoint: AgentLoopCheckpoint): AgentLoopCheckpointRef {
  return { checkpointId: checkpoint.checkpointId, digest: checkpoint.digest };
}

function unique(values: readonly string[], label: string): string[] {
  const result = [...values];
  if (new Set(result).size !== result.length) throw new AgentLoopRuntimeError('conflict', `${label} contains duplicates`);
  for (const value of result) nonEmpty(value, label);
  return result;
}

function nextContextDigest(activeRefs: readonly string[], omittedRefs: readonly string[]): string {
  return digest({ activeRefs, omittedRefs });
}

function cloneDurableContext(input: ContextBuildInput<JsonValue>): ContextBuildInput<JsonValue> {
  return {
    stablePrefix: [...input.stablePrefix],
    indexRefs: [...input.indexRefs],
    dynamicHead: [...input.dynamicHead],
    repairRefs: [...input.repairRefs],
  };
}

function cloneContextReplacement(replacement: ContextReplacement): ContextReplacement {
  return {
    ...replacement,
    baseCheckpoint: { ...replacement.baseCheckpoint },
    successorCheckpoint: { ...replacement.successorCheckpoint },
    deltaIds: [...replacement.deltaIds],
  };
}

function cloneObservationScope(scope: ObservationScope): ObservationScope {
  return {
    ...scope,
    checkpoint: { ...scope.checkpoint },
    scope: { ...scope.scope },
    readableRefs: [...scope.readableRefs],
    capabilities: [...scope.capabilities],
  };
}

function cloneCheckpointRef(ref: AgentLoopCheckpointRef): AgentLoopCheckpointRef {
  return { checkpointId: { ...ref.checkpointId }, digest: ref.digest };
}

function cloneLoopCheckpoint(checkpoint: AgentLoopCheckpoint): AgentLoopCheckpoint {
  return {
    ...checkpoint,
    predecessor: checkpoint.predecessor ? { ...checkpoint.predecessor } : null,
    eventWatermark: { ...checkpoint.eventWatermark },
  };
}

function cloneContextView(view: ContextView): ContextView {
  return {
    ...view,
    checkpoint: { ...view.checkpoint },
    activeRefs: [...view.activeRefs],
    omittedRefs: [...view.omittedRefs],
  };
}

function cloneScopeRef(scope: ScopeRef): ScopeRef {
  return {
    organId: { ...scope.organId },
    ...(scope.taskId ? { taskId: { ...scope.taskId } } : {}),
    ...(scope.cycleId ? { cycleId: { ...scope.cycleId } } : {}),
    ...(scope.operationId ? { operationId: { ...scope.operationId } } : {}),
  };
}

function cloneContextLoopControl(control: ContextLoopControl): ContextLoopControl {
  return {
    ...control,
    observationScope: control.observationScope ? cloneObservationScope(control.observationScope) : null,
    inboxCheckpoint: cloneCheckpointRef(control.inboxCheckpoint),
    deltaCheckpoint: cloneCheckpointRef(control.deltaCheckpoint),
    deltaWatermark: { ...control.deltaWatermark },
    handledEventIds: [...control.handledEventIds],
    handledBatchKeys: [...control.handledBatchKeys],
    appliedDeltaIds: [...control.appliedDeltaIds],
    appliedDeltaKeys: [...control.appliedDeltaKeys],
    closedObservationScopeIds: [...control.closedObservationScopeIds],
    budgetUsage: { ...control.budgetUsage },
  };
}

function cloneContextHistoryRecord(record: ContextHistoryRecord): ContextHistoryRecord {
  return {
    ...record,
    scope: cloneScopeRef(record.scope),
    contextView: cloneContextView(record.contextView),
    loopCheckpoint: cloneLoopCheckpoint(record.loopCheckpoint),
    replacement: record.replacement ? cloneContextReplacement(record.replacement) : null,
    previousContextCommitRef: record.previousContextCommitRef ? { ...record.previousContextCommitRef } : null,
    durableContext: cloneDurableContext(record.durableContext),
    loopControl: cloneContextLoopControl(record.loopControl),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameId(left: { readonly scope: string; readonly value: string } | undefined, right: { readonly scope: string; readonly value: string } | undefined): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function renderTurnCloseSummary(summary: TurnCloseSummary): string {
  return [
    `goal: ${summary.goal.text}`,
    `actions: ${summary.actions.text}`,
    `result: ${summary.result.text}`,
    `next: ${summary.expectedNextStep.text}`,
  ].join(' | ');
}

function dedupeEvidenceRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.evidenceId.scope}:${ref.evidenceId.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function turnNextAction(identity: AdmittedTurnIdentity, outcome: Checkpoint['outcome'], unknownOperations: readonly OperationId[]): NextAction {
  const alignmentRef = `turn-alignment:${identity.turnId}`;
  if (outcome === 'succeeded' && unknownOperations.length === 0) return { kind: 'continue', ref: alignmentRef };
  if (outcome === 'waiting') return { kind: 'wait', ref: alignmentRef };
  return { kind: 'recover', ref: alignmentRef };
}

export class AgentLoopRuntime {
  private readonly profiles: ReadonlyMap<AgentMode, AgentModeCapabilityProfile>;
  private readonly checkpointRecords = new Map<string, AgentLoopCheckpoint>();
  private readonly closedObservationScopes = new Set<string>();
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private readonly turn: AgentLoopTurnConfig | undefined;
  private pendingClose: {
    readonly checkpoint: Checkpoint;
    readonly previous: Checkpoint | null;
    readonly recoveryRecord: TurnRecoveryRecord;
    readonly reviewCommitRefs: readonly JournalCommitRef[];
    readonly inputs: Omit<CloseTurnInput, 'prepareCheckpointClosure' | 'reviewCommitRefs'>;
    readonly bound: boolean;
    prepared?: {
      readonly preparation: CheckpointClosurePreparationRecord;
      readonly turnRecoveryRef: string;
    };
  } | null = null;
  private turnState:
    | { readonly phase: 'open' }
    | { readonly phase: 'recovering'; readonly recoveryRef: string; readonly recovery: TurnRecoveryReference; readonly failedPhase: TurnRecoveryPhase }
    | {
      readonly phase: 'awaiting-planner-alignment';
      readonly closureRef: string;
      readonly closure: TurnClosureReference;
      readonly recoveryRecord: TurnRecoveryRecord;
    }
    | { readonly phase: 'aligned'; readonly closure: TurnClosureReference; readonly alignment: PlannerAlignmentReference } = { phase: 'open' };
  private lastCloseResult: TurnCloseResult | null = null;
  private leaseOrdinal = 0;
  private usage: AgentLoopBudgetUsage = {
    modeTransitions: 0,
    observationScopes: 0,
    contextReplacements: 0,
    deferredEvents: 0,
  };
  private checkpoint: AgentLoopCheckpoint;
  private contextView: ContextView;
  private durableContext: ContextBuildInput<JsonValue> | null;
  private lastReplacement: ContextReplacement | null = null;
  private currentContextCommitRef: JournalCommitRef | null = null;
  private installedRecord: ContextHistoryRecord | null = null;
  private pendingPublication: {
    readonly key: string;
    readonly record: ContextHistoryRecord;
    readonly expectedCurrentContextCommitRef: JournalCommitRef | null;
  } | null = null;
  private modeState: AgentModeState;
  private lease: import('../../../contracts/src/index.js').ModeLease;
  private observationScope: ObservationScope | undefined;
  private inboxState: AgentLoopInboxState;
  private deltaState: AgentLoopDeltaState;

  private constructor(
    private readonly request: AgentLoopRuntimeRequest,
    private readonly contextHistory: ContextHistoryPort,
    initialDurableContext: ContextBuildInput<JsonValue> | null,
    private readonly committedSegment?: ResumedTurnSegmentOpened,
  ) {
    nonEmpty(request.agentRuntimeId, 'agent runtime id');
    nonEmpty(request.permissionRevision, 'permission revision');
    nonEmpty(request.observationStreamId, 'observation stream id');
    assertExecutionEpoch(request.executionEpoch);
    if (request.profiles.length === 0) throw new AgentLoopRuntimeError('invalid-state', 'at least one mode profile is required');
    try {
      validateAgentLoopBudget(request.budget);
      validateAgentLoopScopeRef(request.scope, 'runtime scope');
      for (const profile of request.profiles) validateModeCapabilityProfile(profile);
    } catch (error) {
      throw new AgentLoopRuntimeError('invalid-state', error instanceof Error ? error.message : 'invalid agent loop configuration');
    }
    const profileMap = new Map<AgentMode, AgentModeCapabilityProfile>();
    for (const profile of request.profiles) {
      if (profile.role !== request.role) throw new AgentLoopRuntimeError('conflict', 'mode profile role does not match runtime role');
      if (profileMap.has(profile.mode)) throw new AgentLoopRuntimeError('conflict', `duplicate mode profile: ${profile.mode}`);
      profileMap.set(profile.mode, profile);
    }
    const currentProfile = profileMap.get(request.mode);
    if (!currentProfile) throw new AgentLoopRuntimeError('invalid-state', `missing profile for mode: ${request.mode}`);
    this.profiles = profileMap;
    this.now = request.now ?? (() => new Date());
    this.leaseDurationMs = request.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1) {
      throw new AgentLoopRuntimeError('invalid-state', 'lease duration must be a positive safe integer');
    }
    if (request.turn) {
      const { identity, cycleId, ownerId } = request.turn;
      try {
        validateAdmittedTurnIdentity(identity);
        assertSameScope(identity.scopeRef, request.scope);
        nonEmpty(ownerId, 'turn owner');
      } catch (error) {
        throw new AgentLoopRuntimeError('invalid-state', messageOf(error));
      }
      if (!sameId(identity.cycleRef, cycleId) || !sameId(request.scope.cycleId, cycleId)) {
        throw new AgentLoopRuntimeError('conflict', 'durable turn cycle must match the runtime scope cycle');
      }
      if (identity.executionEpoch !== request.executionEpoch && !committedSegment) {
        throw new AgentLoopRuntimeError('conflict', 'durable turn execution epoch must match the runtime execution epoch');
      }
    }
    this.turn = request.turn;

    const scopeId = `${request.agentRuntimeId}:observation:0`;
    const contextRef = `${request.agentRuntimeId}:context:0`;
    const activeRefs = unique(request.activeRefs ?? [], 'context active refs');
    const omittedRefs = unique(request.omittedRefs ?? [], 'context omitted refs');
    if (activeRefs.some((ref) => omittedRefs.includes(ref))) {
      throw new AgentLoopRuntimeError('conflict', 'context active refs and omitted refs overlap');
    }
    const contextDigest = nextContextDigest(activeRefs, omittedRefs);
    this.checkpoint = this.createRootCheckpoint(scopeId, contextRef, contextDigest);
    this.contextView = {
      contextViewRef: contextRef,
      executionEpoch: request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      contextDigest,
      activeRefs,
      omittedRefs,
    };
    this.durableContext = initialDurableContext ? cloneDurableContext(initialDurableContext) : null;
    this.modeState = {
      agentRuntimeId: request.agentRuntimeId,
      mode: request.mode,
      executionEpoch: request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      observationScopeId: scopeId,
      contextViewRef: contextRef,
      leaseId: '',
      transitionSeq: 1,
    };
    this.lease = this.issueLease(currentProfile, scopeId);
    this.modeState = { ...this.modeState, leaseId: this.lease.leaseId };
    this.inboxState = {
      streamId: request.observationStreamId,
      executionEpoch: request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      observationScopeId: scopeId,
      watermark: 0,
      handledEventIds: [],
      handledBatchKeys: [],
    };
    this.deltaState = {
      executionEpoch: request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      observationScopeId: scopeId,
      watermark: { streamId: request.observationStreamId, sequence: 0 },
      appliedDeltaIds: [],
      appliedDeltaKeys: [],
    };
  }

  /**
   * Durable initial start: prepare the complete root context record, commit it, read the exact
   * committed body back, then install it. A failure leaves no active runtime and the same request
   * identity can be retried without allocating a new root.
   */
  static async start(request: AgentLoopStartRequest, contextHistory: ContextHistoryPort): Promise<AgentLoopRuntime> {
    const runtime = new AgentLoopRuntime(request, contextHistory, request.durableContext);
    await runtime.publishPrepared('initial', runtime.contextHistoryRecord(), null);
    return runtime;
  }

  /**
   * Cold reconstruction from an exact committed context record. The committed body, control and
   * checkpoint replace the prepared root. A fresh current lease is issued; historical leases and
   * permission revisions never authorize resumed use.
   */
  static async restore(
    request: AgentLoopRestoreRequest,
    contextHistory: ContextHistoryPort,
    scope: ScopeRef,
    commitRef: JournalCommitRef,
  ): Promise<AgentLoopRuntime> {
    const runtime = new AgentLoopRuntime(request, contextHistory, null);
    await runtime.restoreCommitted(scope, commitRef);
    return runtime;
  }

  /**
   * Restore the original admitted turn at its exact historical physical binding.
   * This is a read-only recovery entry: it installs the exact committed context and
   * runs the existing turn recovery, but never publishes a context, opens a segment,
   * acquires an incarnation or starts Provider execution.
   */
  static async restoreHistoricalTurn(
    request: Omit<AgentLoopRestoreRequest, 'agentRuntimeId' | 'executionEpoch' | 'scope' | 'activeRefs' | 'omittedRefs'>,
    contextHistory: ContextHistoryPort,
    input: {
      readonly binding: HistoricalTurnBinding;
      readonly contextCommitRef: JournalCommitRef;
      readonly exact: { readonly checkpointId: Checkpoint['id'] | null };
    },
  ): Promise<{ readonly loop: AgentLoopRuntime; readonly recovery: RecoverTurnResult }> {
    const turn = request.turn;
    if (!turn) throw new AgentLoopRuntimeError('turn-not-configured', 'historical restore requires the original durable turn');
    const physical = historicalPhysicalBinding(input.binding, turn.identity);
    const record = await readCommittedContextHistory(contextHistory, physical.scope, input.contextCommitRef);
    if (record.agentRuntimeId !== physical.agentRuntimeId
      || record.loopCheckpoint.executionEpoch !== physical.executionEpoch
      || record.loopControl.inboxStreamId !== request.observationStreamId
      || !sameScope(record.scope, physical.scope)) {
      throw new AgentLoopRuntimeError('conflict', 'exact committed context does not match the historical physical binding');
    }
    const runtime = new AgentLoopRuntime({
      ...request,
      agentRuntimeId: physical.agentRuntimeId,
      executionEpoch: physical.executionEpoch,
      scope: physical.scope,
      mode: record.loopControl.mode,
    }, contextHistory, null, physical.committedSegment);
    runtime.installCommittedContext(record, input.contextCommitRef, true);
    const recovery = await runtime.recoverTurn(undefined, input.exact);
    return { loop: runtime, recovery };
  }

  /** Transfer an exact durable context to a committed incarnation of the same business turn. */
  static async resumeIncarnation(
    request: Omit<AgentLoopRestoreRequest, 'agentRuntimeId' | 'executionEpoch' | 'scope' | 'activeRefs' | 'omittedRefs'>,
    contextHistory: ContextHistoryPort,
    input: {
      readonly segment: ResumedTurnSegmentOpened;
      readonly sourceContextCommitRef: JournalCommitRef;
    },
  ): Promise<AgentLoopRuntime> {
    const { segment } = input;
    validateResumedTurnSegmentOpened(segment);
    const { incarnation, execution, assignment, scope } = segment.binding;
    const turn = request.turn;
    if (!turn) throw new AgentLoopRuntimeError('turn-not-configured', 'incarnation handoff requires the original durable turn');
    const identity = turn.identity;
    if (!sameScope(identity.scopeRef, scope)
      || !sameId(identity.taskRef, assignment.taskId)
      || !sameId(incarnation.taskId, assignment.taskId)
      || identity.turnId !== segment.businessTurnRef.businessTurnId
      || identity.workAssignmentRef !== assignment.assignmentId
      || incarnation.assignmentId !== assignment.assignmentId
      || identity.inputRevision !== assignment.inputRevision
      || identity.executionEpoch !== assignment.executionEpoch
      || identity.executionEpoch !== segment.businessTurnRef.execution.executionEpoch
      || execution.runtimeId !== incarnation.runtimeId
      || digest(segment.binding.businessTurnRef) !== digest(segment.businessTurnRef)) {
      throw new AgentLoopRuntimeError('conflict', 'resumed segment does not bind the original business turn and actual incarnation');
    }
    const source = await readCommittedContextHistory(contextHistory, scope, input.sourceContextCommitRef);
    if (!sameScope(source.scope, scope)
      || source.loopCheckpoint.executionEpoch >= incarnation.executionEpoch
      || source.loopControl.inboxStreamId !== request.observationStreamId) {
      throw new AgentLoopRuntimeError('conflict', 'source context does not match the same-turn incarnation handoff');
    }
    const head = await contextHistory.readContextHistory({ scope, agentRuntimeId: incarnation.runtimeId, limit: 1 });
    const runtime = new AgentLoopRuntime({
      ...request,
      mode: source.loopControl.mode,
      agentRuntimeId: incarnation.runtimeId,
      executionEpoch: incarnation.executionEpoch,
      scope,
    }, contextHistory, null, segment);
    const record = runtime.prepareIncarnationHandoff(source, head.currentContextCommitRef);
    await runtime.publishPrepared(`incarnation:${segment.segmentId}`, record, head.currentContextCommitRef);
    return runtime;
  }

  private prepareIncarnationHandoff(source: ContextHistoryRecord, head: JournalCommitRef | null): ContextHistoryRecord {
    const observationScopeId = `${this.request.agentRuntimeId}:observation:${source.loopCheckpoint.sequence + 1}`;
    const contextViewRef = `${this.request.agentRuntimeId}:context:${source.loopCheckpoint.sequence + 1}`;
    const base = {
      checkpointId: id('checkpoint', `${this.request.agentRuntimeId}-${source.loopCheckpoint.sequence + 1}`),
      sequence: source.loopCheckpoint.sequence + 1,
      predecessor: refOf(source.loopCheckpoint),
      executionEpoch: this.request.executionEpoch,
      eventWatermark: { ...source.loopCheckpoint.eventWatermark },
      observationScopeId,
      contextViewRef,
    };
    const checkpoint: AgentLoopCheckpoint = { ...base, digest: digest({ ...base, contextDigest: source.contextView.contextDigest }) };
    validateAgentLoopCheckpoint(checkpoint, source.loopCheckpoint);
    const control = cloneContextLoopControl(source.loopControl);
    const record: ContextHistoryRecord = {
      ...cloneContextHistoryRecord(source),
      agentRuntimeId: this.request.agentRuntimeId,
      scope: this.request.scope,
      loopCheckpoint: checkpoint,
      contextView: { ...cloneContextView(source.contextView), contextViewRef, executionEpoch: this.request.executionEpoch, checkpoint: refOf(checkpoint) },
      replacement: null,
      previousContextCommitRef: head,
      loopControl: {
        ...control,
        observationScopeId,
        observationScope: control.observationScope ? {
          ...control.observationScope,
          agentRuntimeId: this.request.agentRuntimeId,
          observationScopeId,
          executionEpoch: this.request.executionEpoch,
          checkpoint: refOf(checkpoint),
        } : null,
        inboxExecutionEpoch: this.request.executionEpoch,
        inboxCheckpoint: refOf(checkpoint),
        inboxObservationScopeId: observationScopeId,
        deltaExecutionEpoch: this.request.executionEpoch,
        deltaCheckpoint: refOf(checkpoint),
        deltaObservationScopeId: observationScopeId,
      },
    };
    validateContextHistoryRecord(record);
    return record;
  }

  snapshot(): AgentLoopSnapshot {
    return {
      modeState: { ...this.modeState, checkpoint: { ...this.modeState.checkpoint } },
      checkpoint: { ...this.checkpoint, predecessor: this.checkpoint.predecessor ? { ...this.checkpoint.predecessor } : null, eventWatermark: { ...this.checkpoint.eventWatermark } },
      contextView: { ...this.contextView, checkpoint: { ...this.contextView.checkpoint }, activeRefs: [...this.contextView.activeRefs], omittedRefs: [...this.contextView.omittedRefs] },
      lease: { ...this.lease, checkpoint: { ...this.lease.checkpoint } },
      budgetUsage: { ...this.usage },
      ...(this.observationScope ? { observationScope: { ...this.observationScope, checkpoint: { ...this.observationScope.checkpoint }, scope: { ...this.observationScope.scope }, readableRefs: [...this.observationScope.readableRefs], capabilities: [...this.observationScope.capabilities] } } : {}),
      checkpointHistory: [...this.checkpointRecords.values()].map((record) => ({ ...record, predecessor: record.predecessor ? { ...record.predecessor } : null, eventWatermark: { ...record.eventWatermark } })),
      appliedDeltaIds: [...this.deltaState.appliedDeltaIds],
      handledBatchKeys: [...this.inboxState.handledBatchKeys],
    };
  }

  /** The durable context commit currently installed, or null before the first durable commit. */
  contextCommitRef(): JournalCommitRef | null {
    return this.currentContextCommitRef ? { ...this.currentContextCommitRef } : null;
  }

  /** The actual logical-turn transition this runtime owns right now. */
  currentTurnTransition(): AgentLoopTurnTransition {
    switch (this.turnState.phase) {
      case 'open':
        return {
          phase: 'open',
          nextAction: { kind: 'continue' },
          ...(this.turn === undefined ? {} : { turnOwnerRef: this.turn.ownerId }),
          laterErrorRefs: [],
          unresolvedOperationRefs: [],
        };
      case 'recovering':
        return {
          phase: 'recovering',
          nextAction: { kind: 'recover', ref: this.turnState.recoveryRef },
          turnOwnerRef: this.turn!.ownerId,
          recoveryResponsibilityRef: this.turnState.recoveryRef,
          ...(this.turnState.recovery.firstErrorRef === undefined
            ? {}
            : { firstErrorRef: this.turnState.recovery.firstErrorRef }),
          laterErrorRefs: [],
          unresolvedOperationRefs: [...this.turnState.recovery.unresolvedOperationRefs],
        };
      case 'awaiting-planner-alignment':
        return {
          phase: 'awaiting-planner-alignment',
          nextAction: { kind: 'wait', ref: this.turnState.closureRef },
          turnOwnerRef: this.turn!.ownerId,
          recoveryResponsibilityRef: this.turnState.recoveryRecord.closureId,
          laterErrorRefs: [],
          unresolvedOperationRefs: [...this.turnState.recoveryRecord.unresolvedOperationRefs],
        };
      case 'aligned':
        return {
          phase: 'aligned',
          nextAction: { kind: 'continue', ref: this.turnState.closure.closureRef },
          turnOwnerRef: this.turn!.ownerId,
          laterErrorRefs: [],
          unresolvedOperationRefs: [],
        };
    }
  }

  /**
   * The installed `ContextHistoryRecord`. After any durable commit this is the exact readback
   * record that was installed, including its actual `previousContextCommitRef`. Before the first
   * commit it prepares the initial root record. It is a pure snapshot; nothing is committed here.
   */
  contextHistoryRecord(): ContextHistoryRecord {
    if (this.installedRecord) return cloneContextHistoryRecord(this.installedRecord);
    if (!this.durableContext) {
      throw new AgentLoopRuntimeError('invalid-state', 'runtime has no installed durable context body');
    }
    return this.recordFromState({
      checkpoint: this.checkpoint,
      contextView: this.contextView,
      durableContext: this.durableContext,
      replacement: this.lastReplacement,
      previousContextCommitRef: this.currentContextCommitRef,
      modeState: this.modeState,
      observationScope: this.observationScope,
      inboxState: this.inboxState,
      deltaState: this.deltaState,
      closedObservationScopes: this.closedObservationScopes,
      usage: this.usage,
    });
  }

  private recordFromState(state: {
    readonly checkpoint: AgentLoopCheckpoint;
    readonly contextView: ContextView;
    readonly durableContext: ContextBuildInput<JsonValue>;
    readonly replacement: ContextReplacement | null;
    readonly previousContextCommitRef: JournalCommitRef | null;
    readonly modeState: AgentModeState;
    readonly observationScope: ObservationScope | undefined;
    readonly inboxState: AgentLoopInboxState;
    readonly deltaState: AgentLoopDeltaState;
    readonly closedObservationScopes: ReadonlySet<string>;
    readonly usage: AgentLoopBudgetUsage;
  }): ContextHistoryRecord {
    const record: ContextHistoryRecord = {
      kind: 'context-history',
      schemaVersion: 1,
      scope: this.request.scope,
      agentRuntimeId: this.request.agentRuntimeId,
      contextView: cloneContextView(state.contextView),
      loopCheckpoint: cloneLoopCheckpoint(state.checkpoint),
      replacement: state.replacement ? cloneContextReplacement(state.replacement) : null,
      previousContextCommitRef: state.previousContextCommitRef ? { ...state.previousContextCommitRef } : null,
      durableContext: cloneDurableContext(state.durableContext),
      durableContextDigest: durableContextDigest(state.durableContext),
      loopControl: this.loopControlFrom(state),
    };
    validateContextHistoryRecord(record);
    return record;
  }

  private loopControlFrom(state: {
    readonly modeState: AgentModeState;
    readonly observationScope: ObservationScope | undefined;
    readonly inboxState: AgentLoopInboxState;
    readonly deltaState: AgentLoopDeltaState;
    readonly closedObservationScopes: ReadonlySet<string>;
    readonly usage: AgentLoopBudgetUsage;
  }): ContextLoopControl {
    return {
      mode: state.modeState.mode,
      transitionSeq: state.modeState.transitionSeq,
      observationScopeId: state.modeState.observationScopeId,
      observationScope: state.observationScope ? cloneObservationScope(state.observationScope) : null,
      inboxStreamId: state.inboxState.streamId,
      inboxExecutionEpoch: state.inboxState.executionEpoch,
      inboxCheckpoint: cloneCheckpointRef(state.inboxState.checkpoint),
      inboxObservationScopeId: state.inboxState.observationScopeId,
      inboxWatermark: state.inboxState.watermark,
      handledEventIds: [...state.inboxState.handledEventIds],
      handledBatchKeys: [...state.inboxState.handledBatchKeys],
      deltaExecutionEpoch: state.deltaState.executionEpoch,
      deltaCheckpoint: cloneCheckpointRef(state.deltaState.checkpoint),
      deltaObservationScopeId: state.deltaState.observationScopeId,
      deltaWatermark: { ...state.deltaState.watermark },
      appliedDeltaIds: [...state.deltaState.appliedDeltaIds],
      appliedDeltaKeys: [...state.deltaState.appliedDeltaKeys],
      closedObservationScopeIds: [...state.closedObservationScopes],
      budgetUsage: { ...state.usage },
    };
  }

  /**
   * Durable publication: pending -> commit -> exact readback -> install. A commit or readback
   * failure keeps the prior active state and the exact pending record for a same-identity retry.
   */
  private async publishPrepared(
    key: string,
    record: ContextHistoryRecord,
    expectedCurrentContextCommitRef: JournalCommitRef | null,
  ): Promise<{ readonly record: ContextHistoryRecord; readonly commitRef: JournalCommitRef }> {
    validateContextHistoryRecord(record);
    if (this.pendingPublication && this.pendingPublication.key !== key) {
      throw new AgentLoopRuntimeError('conflict', 'a different context publication is already pending');
    }
    const pending = this.pendingPublication ?? { key, record, expectedCurrentContextCommitRef };
    this.pendingPublication = pending;
    const produced = await produceContextHistory(this.contextHistory, {
      record: pending.record,
      expectedCurrentContextCommitRef: pending.expectedCurrentContextCommitRef,
    });
    this.installCommittedContext(produced.record, produced.commitRef);
    this.pendingPublication = null;
    return produced;
  }

  private async restoreCommitted(scope: ScopeRef, commitRef: JournalCommitRef): Promise<void> {
    const record = await readCommittedContextHistory(this.contextHistory, scope, commitRef);
    this.installCommittedContext(record, commitRef, true);
  }

  /**
   * Install the exact committed record. The lease is kept when the committed mode, scope and
   * checkpoint are unchanged (control-only publications); it is re-issued when the committed
   * position advances. A cold restore always forces a fresh current lease.
   */
  private installCommittedContext(record: ContextHistoryRecord, commitRef: JournalCommitRef, rotateLease = false): void {
    validateContextHistoryRecord(record);
    if (record.agentRuntimeId !== this.request.agentRuntimeId) {
      throw new AgentLoopRuntimeError('unknown-owner', 'committed context belongs to a different agent runtime');
    }
    if (!sameScope(record.scope, this.request.scope)) {
      throw new AgentLoopRuntimeError('conflict', 'committed context scope does not match the runtime scope');
    }
    const control = record.loopControl;
    this.checkpointRecords.clear();
    this.checkpoint = cloneLoopCheckpoint(record.loopCheckpoint);
    this.checkpointRecords.set(this.checkpoint.checkpointId.value, this.checkpoint);
    this.contextView = cloneContextView(record.contextView);
    this.durableContext = cloneDurableContext(record.durableContext);
    this.lastReplacement = record.replacement ? cloneContextReplacement(record.replacement) : null;
    this.currentContextCommitRef = { ...commitRef };
    this.usage = { ...control.budgetUsage };
    this.closedObservationScopes.clear();
    for (const closed of control.closedObservationScopeIds) this.closedObservationScopes.add(closed);
    this.modeState = {
      agentRuntimeId: this.request.agentRuntimeId,
      mode: control.mode,
      executionEpoch: record.loopCheckpoint.executionEpoch,
      checkpoint: refOf(record.loopCheckpoint),
      observationScopeId: control.observationScopeId,
      contextViewRef: record.contextView.contextViewRef,
      leaseId: '',
      transitionSeq: control.transitionSeq,
    };
    this.inboxState = {
      streamId: control.inboxStreamId,
      executionEpoch: control.inboxExecutionEpoch,
      checkpoint: cloneCheckpointRef(control.inboxCheckpoint),
      observationScopeId: control.inboxObservationScopeId,
      watermark: control.inboxWatermark,
      handledEventIds: [...control.handledEventIds],
      handledBatchKeys: [...control.handledBatchKeys],
    };
    this.deltaState = {
      executionEpoch: control.deltaExecutionEpoch,
      checkpoint: cloneCheckpointRef(control.deltaCheckpoint),
      observationScopeId: control.deltaObservationScopeId,
      watermark: { ...control.deltaWatermark },
      appliedDeltaIds: [...control.appliedDeltaIds],
      appliedDeltaKeys: [...control.appliedDeltaKeys],
    };
    this.observationScope = control.observationScope ? cloneObservationScope(control.observationScope) : undefined;
    const leaseCurrent = !rotateLease
      && this.lease.mode === this.modeState.mode
      && this.lease.observationScopeId === this.modeState.observationScopeId
      && sameCheckpoint(this.lease.checkpoint, refOf(this.checkpoint));
    if (!leaseCurrent) {
      this.lease = this.issueLease(this.requireProfile(this.modeState.mode), this.modeState.observationScopeId);
    }
    this.modeState = { ...this.modeState, leaseId: this.lease.leaseId };
    this.installedRecord = cloneContextHistoryRecord(record);
  }

  async openObservationScope(input: OpenObservationScopeRequest): Promise<ObservationScope> {
    this.requireActor(input.actor);
    if (this.modeState.mode !== 'observation') throw new AgentLoopRuntimeError('invalid-state', 'observation scope requires observation mode');
    const alreadyOpen = this.observationScope;
    if (alreadyOpen) throw new AgentLoopRuntimeError('conflict', 'an observation scope is already open');
    try {
      validateAgentLoopScopeRef(input.scope);
    } catch (error) {
      throw new AgentLoopRuntimeError('invalid-state', error instanceof Error ? error.message : 'invalid observation scope');
    }
    if (!sameScope(input.scope, this.request.scope)) throw new AgentLoopRuntimeError('conflict', 'observation scope is outside the runtime scope');
    this.assertBudget('observationScopes', 1);
    const profile = this.requireProfile('observation');
    if (!profile.observationScopes.includes(input.kind)) throw new AgentLoopRuntimeError('invalid-state', `observation scope kind is not granted: ${input.kind}`);
    for (const capability of input.capabilities) {
      assertModeCapabilityGranted(profile, { kind: 'observation', scope: input.kind, capability });
    }
    if (!sameCheckpoint(this.modeState.checkpoint, refOf(this.checkpoint))) throw new AgentLoopRuntimeError('conflict', 'mode state checkpoint is stale');
    const reopensClosedScope = this.closedObservationScopes.has(this.modeState.observationScopeId);
    let scopeId = this.modeState.observationScopeId;
    if (reopensClosedScope) {
      scopeId = `${this.request.agentRuntimeId}:observation:${this.checkpoint.sequence}:${this.usage.observationScopes + 1}`;
    }
    const readableRefs = unique(input.readableRefs, 'observation readable refs');
    const capabilities = unique(input.capabilities, 'observation capabilities');
    const scope: ObservationScope = {
      observationScopeId: scopeId,
      agentRuntimeId: this.request.agentRuntimeId,
      executionEpoch: this.request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      kind: input.kind,
      scope: input.scope,
      readableRefs,
      capabilities,
      openedAt: this.now().toISOString(),
    };
    const nextModeState = reopensClosedScope
      ? { ...this.modeState, observationScopeId: scopeId, leaseId: '' }
      : this.modeState;
    const nextInboxState = reopensClosedScope
      ? { ...this.inboxState, observationScopeId: scopeId }
      : this.inboxState;
    const nextDeltaState = reopensClosedScope
      ? { ...this.deltaState, observationScopeId: scopeId }
      : this.deltaState;
    const nextUsage = { ...this.usage, observationScopes: this.usage.observationScopes + 1 };
    const record = this.recordFromState({
      checkpoint: this.checkpoint,
      contextView: this.contextView,
      durableContext: this.requireDurableContext(),
      replacement: null,
      previousContextCommitRef: this.currentContextCommitRef,
      modeState: nextModeState,
      observationScope: scope,
      inboxState: nextInboxState,
      deltaState: nextDeltaState,
      closedObservationScopes: this.closedObservationScopes,
      usage: nextUsage,
    });
    await this.publishPrepared(`open:${scopeId}`, record, this.currentContextCommitRef);
    if (!this.observationScope || this.observationScope.observationScopeId !== scopeId) {
      throw new AgentLoopRuntimeError('invalid-state', 'committed observation scope was not installed');
    }
    return cloneObservationScope(this.observationScope);
  }

  async closeObservationScope(actor: AgentLoopActor, observationScopeId = this.modeState.observationScopeId): Promise<ObservationScope> {
    this.requireActor(actor);
    if (!this.observationScope || this.observationScope.observationScopeId !== observationScopeId) {
      throw new AgentLoopRuntimeError('invalid-state', `unknown observation scope: ${observationScopeId}`);
    }
    if (this.inboxState.watermark !== this.checkpoint.eventWatermark.sequence
      || this.deltaState.watermark.sequence !== this.checkpoint.eventWatermark.sequence
      || !sameCheckpoint(this.deltaState.checkpoint, this.checkpoint)) {
      throw new AgentLoopRuntimeError('conflict', 'cannot close observation scope with pending observation events');
    }
    const closed = this.observationScope;
    const nextClosed = new Set(this.closedObservationScopes);
    nextClosed.add(observationScopeId);
    const record = this.recordFromState({
      checkpoint: this.checkpoint,
      contextView: this.contextView,
      durableContext: this.requireDurableContext(),
      replacement: null,
      previousContextCommitRef: this.currentContextCommitRef,
      modeState: this.modeState,
      observationScope: undefined,
      inboxState: this.inboxState,
      deltaState: this.deltaState,
      closedObservationScopes: nextClosed,
      usage: this.usage,
    });
    await this.publishPrepared(`close:${observationScopeId}`, record, this.currentContextCommitRef);
    return cloneObservationScope(closed);
  }

  async mergeObservationBatch(actor: AgentLoopActor, batch: ObservationBatch): Promise<AgentLoopInboxState> {
    this.requireActor(actor);
    this.requireOpenObservationScope(batch.observationScopeId);
    if (batch.priority === 'deferred') this.assertBudget('deferredEvents', batch.eventIds.length);
    const next = assertObservationBatchFresh(this.inboxState, batch);
    const nextUsage = batch.priority === 'deferred'
      ? { ...this.usage, deferredEvents: this.usage.deferredEvents + batch.eventIds.length }
      : this.usage;
    const record = this.recordFromState({
      checkpoint: this.checkpoint,
      contextView: this.contextView,
      durableContext: this.requireDurableContext(),
      replacement: null,
      previousContextCommitRef: this.currentContextCommitRef,
      modeState: this.modeState,
      observationScope: this.observationScope,
      inboxState: next,
      deltaState: this.deltaState,
      closedObservationScopes: this.closedObservationScopes,
      usage: nextUsage,
    });
    await this.publishPrepared(`merge:${batch.idempotencyKey}`, record, this.currentContextCommitRef);
    return { ...this.inboxState, handledEventIds: [...this.inboxState.handledEventIds], handledBatchKeys: [...this.inboxState.handledBatchKeys] };
  }

  async applyObservationDelta(
    actor: AgentLoopActor,
    delta: ObservationDelta,
    input: { readonly durableContext: ContextBuildInput<JsonValue> },
  ): Promise<ObservationDeltaResult> {
    this.requireActor(actor);
    this.requireOpenObservationScope(delta.observationScopeId);
    if (delta.watermark.sequence !== this.inboxState.watermark) throw new AgentLoopRuntimeError('conflict', 'observation delta must consume the current observed batch watermark');
    const nextDeltaState = assertObservationDeltaCurrent(this.deltaState, delta);
    const activeRefs = unique([...this.contextView.activeRefs, ...delta.observationRefs], 'context active refs');
    const prepared = this.prepareReplacement({
      deltaIds: [delta.deltaId],
      reason: 'observation',
      summary: `observation delta ${delta.deltaId}`,
      contextViewRef: `${this.request.agentRuntimeId}:context:${this.checkpoint.sequence + 1}`,
      contextDigest: nextContextDigest(activeRefs, this.contextView.omittedRefs),
      activeRefs,
      omittedRefs: this.contextView.omittedRefs,
      watermark: delta.watermark,
      observationScopeId: this.modeState.observationScopeId,
    });
    const nextInboxState = { ...this.inboxState, checkpoint: refOf(prepared.checkpoint), observationScopeId: this.modeState.observationScopeId };
    const nextDelta = { ...nextDeltaState, checkpoint: refOf(prepared.checkpoint) };
    const nextClosed = new Set(this.closedObservationScopes);
    nextClosed.add(delta.observationScopeId);
    const record = this.recordFromState({
      checkpoint: prepared.checkpoint,
      contextView: prepared.contextView,
      durableContext: input.durableContext,
      replacement: prepared.replacement,
      previousContextCommitRef: this.currentContextCommitRef,
      modeState: this.modeState,
      observationScope: undefined,
      inboxState: nextInboxState,
      deltaState: nextDelta,
      closedObservationScopes: nextClosed,
      usage: prepared.usage,
    });
    await this.publishPrepared(`delta:${delta.deltaId}`, record, this.currentContextCommitRef);
    if (!this.lastReplacement) throw new AgentLoopRuntimeError('invalid-state', 'committed delta replacement was not installed');
    return { delta, replacement: cloneContextReplacement(this.lastReplacement), checkpoint: cloneLoopCheckpoint(this.checkpoint), contextView: cloneContextView(this.contextView) };
  }

  async transitionMode(input: TransitionModeRequest): Promise<AgentModeTransition> {
    this.requireActor(input.actor);
    if (input.toMode === this.modeState.mode) throw new AgentLoopRuntimeError('invalid-state', 'mode transition must change mode');
    this.assertBudget('modeTransitions', 1);
    this.assertBudget('contextReplacements', 1);
    if (this.inboxState.watermark !== this.checkpoint.eventWatermark.sequence
      || this.deltaState.watermark.sequence !== this.checkpoint.eventWatermark.sequence
      || !sameCheckpoint(this.deltaState.checkpoint, this.modeState.checkpoint)) {
      throw new AgentLoopRuntimeError('invalid-state', 'mode transition has pending observation events');
    }
    this.requireProfile(input.toMode);
    const oldObservationScopeId = this.modeState.observationScopeId;
    const activeRefs = unique(input.activeRefs, 'context active refs');
    const omittedRefs = unique(input.omittedRefs, 'context omitted refs');
    if (activeRefs.some((ref) => omittedRefs.includes(ref))) throw new AgentLoopRuntimeError('conflict', 'context active refs and omitted refs overlap');
    const prepared = this.prepareReplacement({
      deltaIds: unique(input.deltaIds, 'context replacement delta ids'),
      reason: input.replacementReason ?? (input.reason === 'recovery' ? 'recovery' : 'compaction'),
      summary: input.summary,
      contextViewRef: input.contextViewRef,
      contextDigest: input.contextDigest,
      activeRefs,
      omittedRefs,
      watermark: this.checkpoint.eventWatermark,
      observationScopeId: `${this.request.agentRuntimeId}:observation:${this.modeState.transitionSeq + 1}`,
    }, false);
    const transition: AgentModeTransition = {
      transitionId: `${this.request.agentRuntimeId}:transition:${this.modeState.transitionSeq + 1}`,
      fromMode: this.modeState.mode,
      toMode: input.toMode,
      executionEpoch: this.request.executionEpoch,
      baseCheckpoint: this.modeState.checkpoint,
      successorCheckpointId: prepared.checkpoint.checkpointId,
      contextReplacementId: prepared.replacement.replacementId,
      leaseId: input.actor.leaseId,
      transitionSeq: this.modeState.transitionSeq + 1,
      reason: input.reason,
    };
    assertAgentModeTransitionCurrent(transition, this.modeState, this.lease, this.now());
    const nextUsage = {
      ...this.usage,
      modeTransitions: this.usage.modeTransitions + 1,
      contextReplacements: this.usage.contextReplacements + 1,
    };
    const nextModeState: AgentModeState = {
      ...this.modeState,
      mode: input.toMode,
      checkpoint: refOf(prepared.checkpoint),
      contextViewRef: prepared.contextView.contextViewRef,
      observationScopeId: prepared.checkpoint.observationScopeId,
      leaseId: '',
      transitionSeq: transition.transitionSeq,
    };
    const nextClosed = new Set(this.closedObservationScopes);
    nextClosed.add(oldObservationScopeId);
    const nextInboxState = { ...this.inboxState, checkpoint: refOf(prepared.checkpoint), observationScopeId: prepared.checkpoint.observationScopeId };
    const nextDeltaState = { ...this.deltaState, checkpoint: refOf(prepared.checkpoint), observationScopeId: prepared.checkpoint.observationScopeId };
    const record = this.recordFromState({
      checkpoint: prepared.checkpoint,
      contextView: prepared.contextView,
      durableContext: input.durableContext,
      replacement: prepared.replacement,
      previousContextCommitRef: this.currentContextCommitRef,
      modeState: nextModeState,
      observationScope: undefined,
      inboxState: nextInboxState,
      deltaState: nextDeltaState,
      closedObservationScopes: nextClosed,
      usage: nextUsage,
    });
    await this.publishPrepared(`mode:${transition.transitionId}`, record, this.currentContextCommitRef);
    return { ...transition, baseCheckpoint: { ...transition.baseCheckpoint } };
  }

  async replaceContext(actor: AgentLoopActor, input: Omit<TransitionModeRequest, 'actor' | 'toMode' | 'reason'> & { readonly reason?: ContextReplacementReason }): Promise<ContextReplacement> {
    this.requireActor(actor);
    const prepared = this.prepareReplacement({
      deltaIds: unique(input.deltaIds, 'context replacement delta ids'),
      reason: input.reason ?? 'compaction',
      summary: input.summary,
      contextViewRef: input.contextViewRef,
      contextDigest: input.contextDigest,
      activeRefs: unique(input.activeRefs, 'context active refs'),
      omittedRefs: unique(input.omittedRefs, 'context omitted refs'),
      watermark: this.checkpoint.eventWatermark,
      observationScopeId: this.modeState.observationScopeId,
    });
    const nextObservationScope = this.observationScope
      ? { ...this.observationScope, checkpoint: refOf(prepared.checkpoint) }
      : undefined;
    const nextInboxState = { ...this.inboxState, checkpoint: refOf(prepared.checkpoint) };
    const nextDeltaState = { ...this.deltaState, checkpoint: refOf(prepared.checkpoint) };
    const record = this.recordFromState({
      checkpoint: prepared.checkpoint,
      contextView: prepared.contextView,
      durableContext: input.durableContext,
      replacement: prepared.replacement,
      previousContextCommitRef: this.currentContextCommitRef,
      modeState: this.modeState,
      observationScope: nextObservationScope,
      inboxState: nextInboxState,
      deltaState: nextDeltaState,
      closedObservationScopes: this.closedObservationScopes,
      usage: prepared.usage,
    });
    await this.publishPrepared(`replace:${prepared.replacement.replacementId}`, record, this.currentContextCommitRef);
    if (!this.lastReplacement) throw new AgentLoopRuntimeError('invalid-state', 'committed replacement was not installed');
    return cloneContextReplacement(this.lastReplacement);
  }

  /**
   * Close the current logical turn through the existing `submitCheckpoint` durability
   * path. The four-part summary, durable checkpoint, checkpoint closure, and the typed
   * turn-closure record are all committed before the turn can advance. This is the
   * front-segment foundation: it stops at `awaiting-planner-alignment` and never
   * authorizes a next turn or terminal result on its own.
   */
  async closeTurn(input: CloseTurnInput): Promise<TurnCloseResult> {
    const turn = this.requireTurn();
    const identity = turn.identity;
    let reviewCommitRefs: readonly JournalCommitRef[];
    try {
      reviewCommitRefs = distinctReviewCommitRefs(input.reviewCommitRefs);
      validateTurnCloseSummary(input.summary, identity.scopeRef);
    } catch (error) {
      throw new AgentLoopRuntimeError('turn-close-validation', messageOf(error));
    }
    // Copy serializable effective facts only. The composition callback is never cloned.
    const inputs = structuredClone({
      summary: input.summary,
      recovery: input.recovery,
      outcome: input.outcome,
      source: input.source,
      permissionRevoked: input.permissionRevoked ?? false,
      hardBlockers: input.hardBlockers ?? [],
      unknownOperations: input.unknownOperations ?? [],
      reconciledOperations: input.reconciledOperations ?? [],
    });
    const bound = input.prepareCheckpointClosure !== undefined;
    if (this.pendingClose && (JSON.stringify(this.pendingClose.inputs) !== JSON.stringify(inputs)
      || this.pendingClose.bound !== bound)) {
      throw new AgentLoopRuntimeError('turn-close-validation', 'turn close already started with different frozen inputs or preparation requirement');
    }
    if (this.turnState.phase === 'awaiting-planner-alignment' || this.turnState.phase === 'aligned') {
      const checkpointId = this.turnState.closure.checkpointId;
      const record = await turn.closurePort.read(turnBoundaryRecordRefs(identity, checkpointId).turnClosureRef);
      if (!record || !('closureKind' in record) || record.closureKind !== 'turn-closure') {
        throw new AgentLoopRuntimeError('turn-close-validation', 'closed turn has no durable typed closure');
      }
      assertTurnClosureRecord(record);
      if (!sameReviewCommitRefs(record.reviewCommitRefs, reviewCommitRefs)) {
        throw new AgentLoopRuntimeError('turn-close-validation', 'closed turn binds a different ordered review receipt list');
      }
      const committed = await turn.journal.readCommitted(identity.scopeRef, checkpointId);
      if (!committed) throw new AgentLoopRuntimeError('turn-close-validation', 'closed turn checkpoint is absent');
      const checkpointClosure = await turn.closurePort.read(record.closureRef);
      const recovery = await turn.closurePort.read(turnBoundaryRecordRefs(identity, checkpointId).turnRecoveryRecordRef);
      if (!checkpointClosure || !('closureKind' in checkpointClosure) || checkpointClosure.closureKind !== 'checkpoint'
        || checkpointClosure.source !== inputs.source || committed.checkpoint.outcome !== inputs.outcome
        || JSON.stringify(record.summary) !== JSON.stringify(inputs.summary)
        || !!checkpointClosure.recoveryBinding !== bound
        || !recovery || !('closureKind' in recovery) || recovery.closureKind !== 'turn-recovery'
        || JSON.stringify({ contextRef: recovery.contextRef, unfinishedRef: recovery.unfinishedRef,
          unreturnedCallRefs: recovery.unreturnedCallRefs, unresolvedOperationRefs: recovery.unresolvedOperationRefs,
          ...(recovery.firstErrorRef === undefined ? {} : { firstErrorRef: recovery.firstErrorRef }) }) !== JSON.stringify(inputs.recovery)) {
        throw new AgentLoopRuntimeError('turn-close-validation', 'closed turn has different frozen facts or preparation requirement');
      }
      if (this.lastCloseResult) return structuredClone(this.lastCloseResult);
      return {
        state: 'closed-awaiting-planner-alignment',
        turnSummary: record.summary,
        checkpoint: committed.checkpoint,
        closureRef: record.closureRef,
        recoveryStateRef: record.recoveryStateRef,
        plannerAlignment: 'pending',
        advance: 'blocked-pending-planner-alignment',
      };
    }
    if (!this.pendingClose) {
      const latest = await turn.journal.readLatest(identity.scopeRef);
      const previous = latest?.checkpoint ?? null;
      const recoveryStateRef = this.turnRecoveryStateRef();
      const checkpoint = this.buildTurnCheckpoint(previous, inputs, recoveryStateRef);
      const recoveryRecord: TurnRecoveryRecord = {
        closureKind: 'turn-recovery',
        closureId: turnBoundaryRecordRefs(identity, checkpoint.id).turnRecoveryRecordRef,
        identity,
        checkpointId: checkpoint.id,
        recoveryStateRef,
        contextRef: inputs.recovery.contextRef,
        unfinishedRef: inputs.recovery.unfinishedRef,
        unreturnedCallRefs: inputs.recovery.unreturnedCallRefs,
        unresolvedOperationRefs: inputs.recovery.unresolvedOperationRefs,
        ...(inputs.recovery.firstErrorRef === undefined ? {} : { firstErrorRef: inputs.recovery.firstErrorRef }),
        failedPhase: 'submission',
        frozenClose: { version: 1, checkpoint, previous, inputs, reviewCommitRefs, bound },
      };
      assertTurnRecoveryRecord(recoveryRecord);
      this.pendingClose = { checkpoint, previous, recoveryRecord, reviewCommitRefs, inputs, bound };
    }
    if (!sameReviewCommitRefs(this.pendingClose.reviewCommitRefs, reviewCommitRefs)) {
      throw new AgentLoopRuntimeError('turn-close-validation', 'pending turn close binds a different ordered review receipt list');
    }
    const pending = this.pendingClose;
    const { checkpoint, previous, recoveryRecord, inputs: frozen, reviewCommitRefs: retainedReviewCommitRefs } = pending;

    // Persist the recovery responsibility before any durable checkpoint/closure commit.
    try {
      const candidate = { ...recoveryRecord, closureId: frozenTurnCloseRef(identity) };
      const retained = await turn.closurePort.read(candidate.closureId);
      if (retained && JSON.stringify(retained) !== JSON.stringify(candidate)) {
        throw new AgentLoopRuntimeError('turn-close-validation', 'exact frozen close candidate conflicts');
      }
      if (!retained) await turn.closurePort.commit(candidate);
      const existingRecovery = await turn.closurePort.read(recoveryRecord.closureId);
      if (existingRecovery) {
        assertTurnRecoveryRecord(existingRecovery as TurnRecoveryRecord);
        if (JSON.stringify(existingRecovery) !== JSON.stringify(recoveryRecord)) {
          throw new AgentLoopRuntimeError('turn-close-validation', 'durable turn recovery has different frozen facts');
        }
      } else await turn.closurePort.commit(recoveryRecord);
    } catch (error) {
      throw new AgentLoopRuntimeError('turn-close-validation', `turn recovery asset could not be persisted: ${messageOf(error)}`);
    }

    // Single durable commit path: existing submitCheckpoint (journal checkpoint -> closure).
    let closureRef: string;
    try {
      if (pending.bound && !pending.prepared) {
        pending.prepared = structuredClone(await input.prepareCheckpointClosure!(structuredClone(checkpoint)));
      }
      const submitted = await submitCheckpoint({
        source: frozen.source,
        ownerId: turn.ownerId,
        checkpoint,
        previous,
        journal: turn.journal,
        closurePort: turn.closurePort,
        permissionRevoked: frozen.permissionRevoked,
        hardBlockers: frozen.hardBlockers,
        unknownOperations: frozen.unknownOperations,
        reconciledOperations: frozen.reconciledOperations,
        ...pending.prepared,
      });
      closureRef = submitted.closure.closureId;
    } catch (error) {
      const firstErrorRef = this.turnErrorRef('submission', messageOf(error));
      const recovery = this.turnRecoveryReference(recoveryRecord, firstErrorRef);
      this.turnState = { phase: 'recovering', recoveryRef: recoveryRecord.closureId, recovery, failedPhase: 'submission' };
      return {
        state: 'recovering',
        recovery,
        failedPhase: 'submission',
        firstErrorRef,
        advance: 'blocked-recovery',
      };
    }

    // Persist the typed four-part closure relationship as a first-class durable fact.
    const turnClosureFacts = {
      closureKind: 'turn-closure' as const,
      closureId: turnBoundaryRecordRefs(identity, checkpoint.id).turnClosureRef,
      identity,
      checkpointId: checkpoint.id,
      closureRef,
      recoveryStateRef: recoveryRecord.recoveryStateRef,
      summary: frozen.summary,
      ...(retainedReviewCommitRefs.length ? { reviewCommitRefs: retainedReviewCommitRefs } : {}),
    };
    let turnClosureRecord: TurnClosureRecord;
    try {
      const existingClosure = await turn.closurePort.read(turnClosureFacts.closureId);
      if (existingClosure) {
        if (!('closureKind' in existingClosure) || existingClosure.closureKind !== 'turn-closure') {
          throw new AgentLoopRuntimeError('turn-close-validation', 'durable turn closure has a different kind');
        }
        assertTurnClosureRecord(existingClosure);
        if (!sameReviewCommitRefs(existingClosure.reviewCommitRefs, retainedReviewCommitRefs)) {
          throw new AgentLoopRuntimeError('turn-close-validation', 'durable turn closure binds a different ordered review receipt list');
        }
        const { closedAt: _closedAt, reviewCommitRefs: _reviews, ...existingFacts } = existingClosure;
        const { reviewCommitRefs: _retainedReviews, ...expectedFacts } = turnClosureFacts;
        if (JSON.stringify(existingFacts) !== JSON.stringify(expectedFacts)) {
          throw new AgentLoopRuntimeError('turn-close-validation', 'durable turn closure has different frozen facts');
        }
        turnClosureRecord = existingClosure;
      } else {
        turnClosureRecord = { ...turnClosureFacts, closedAt: this.now().toISOString() };
        assertTurnClosureRecord(turnClosureRecord);
        await turn.closurePort.commit(turnClosureRecord);
      }
    } catch (error) {
      const firstErrorRef = this.turnErrorRef('turn-closure', messageOf(error));
      const recovery = this.turnRecoveryReference(recoveryRecord, firstErrorRef);
      this.turnState = { phase: 'recovering', recoveryRef: recoveryRecord.closureId, recovery, failedPhase: 'turn-closure' };
      return {
        state: 'recovering',
        recovery,
        failedPhase: 'turn-closure',
        firstErrorRef,
        advance: 'blocked-recovery',
      };
    }

    const result: TurnCloseResult = {
      state: 'closed-awaiting-planner-alignment',
      turnSummary: turnClosureRecord.summary,
      checkpoint,
      closureRef,
      recoveryStateRef: recoveryRecord.recoveryStateRef,
      plannerAlignment: 'pending',
      advance: 'blocked-pending-planner-alignment',
    };
    const turnClosure: TurnClosureReference = {
      identity: turnClosureRecord.identity,
      checkpointId: turnClosureRecord.checkpointId,
      closureRef: turnClosureRecord.closureRef,
      summary: turnClosureRecord.summary,
      recoveryStateRef: turnClosureRecord.recoveryStateRef,
      closedAt: turnClosureRecord.closedAt,
    };
    this.turnState = { phase: 'awaiting-planner-alignment', closureRef, closure: turnClosure, recoveryRecord };
    this.lastCloseResult = structuredClone(result);
    return structuredClone(result);
  }

  /**
   * Align one committed closure to the exact published planner revision and admit the
   * `continue`/`complete`/`failed` decision. The alignment fact is persisted and read back
   * only through the existing authoritative closure port. An already-committed revision is
   * read back through the real revision consumer, never republished.
   */
  async alignTurn(input: AlignTurnInput): Promise<TurnAlignmentResult> {
    const turn = this.requireTurn();
    const identity = turn.identity;

    if (this.turnState.phase === 'recovering') {
      return {
        state: 'recovering',
        recovery: this.turnState.recovery,
        failedPhase: 'alignment',
        firstErrorRef: this.turnErrorRef('alignment', 'turn closure is incomplete; the same logical turn must be recovered before alignment'),
        advance: 'blocked-recovery',
      };
    }
    if (this.turnState.phase === 'open') {
      throw new AgentLoopRuntimeError('invalid-state', 'the logical turn must be closed before planner alignment');
    }
    if (this.turnState.phase === 'aligned') {
      return {
        state: 'aligned',
        alignment: this.turnState.alignment,
        admission: {
          state: 'closed',
          decision: this.turnState.alignment.decision,
          closure: this.turnState.closure,
          alignment: this.turnState.alignment,
        },
        advance: 'admitted',
      };
    }

    const { closure, recoveryRecord } = this.turnState;
    const alignmentId = turnBoundaryRecordRefs(identity, closure.checkpointId).alignmentRef;
    try {
      const existing = await turn.closurePort.read(alignmentId);
      const record = existing
        ? this.asAlignmentRecord(existing)
        : await this.commitAlignment(turn, input, identity, closure, alignmentId);
      const alignment = record.alignment;
      assertTurnAlignmentBinding(closure, alignment);
      assertTurnDecisionAdmission({ closure, alignment, decision: input.decision });
      this.turnState = { phase: 'aligned', closure, alignment };
      return {
        state: 'aligned',
        alignment,
        admission: { state: 'closed', decision: alignment.decision, closure, alignment },
        advance: 'admitted',
      };
    } catch (error) {
      const firstErrorRef = this.turnErrorRef('alignment', messageOf(error));
      const alignmentRecovery = this.buildAlignmentRecoveryRecord(identity, closure, recoveryRecord);
      try {
        const existing = await turn.closurePort.read(alignmentRecovery.closureId);
        if (!existing) await turn.closurePort.commit(alignmentRecovery);
      } catch {
        // The original close-time recovery record already carries the responsibility.
      }
      return {
        state: 'recovering',
        recovery: this.turnRecoveryReference(alignmentRecovery, firstErrorRef),
        failedPhase: 'alignment',
        firstErrorRef,
        advance: 'blocked-recovery',
      };
    }
  }

  /**
   * Turn-advance gate. A next logical turn is only admitted for `continue`; `complete` and
   * `failed` end the task. Both require a committed closure plus a matching planner
   * alignment, so every other phase stays blocked on the original logical turn.
   */
  advanceTurn(): AdvanceTurnResult {
    this.requireTurn();
    if (this.turnState.phase === 'recovering') {
      return {
        advanced: false,
        state: 'recovering',
        reason: 'turn closure is incomplete; the same logical turn must be recovered before it can advance',
        recoveryRef: this.turnState.recoveryRef,
      };
    }
    if (this.turnState.phase === 'aligned') {
      const { closure, alignment } = this.turnState;
      const admission: TurnAdvanceAdmission = { state: 'closed', decision: alignment.decision, closure, alignment };
      assertTurnAdvanceAdmission(admission);
      if (alignment.decision === 'continue') {
        return {
          advanced: true,
          state: 'advancing',
          reason: 'durable closure and planner alignment admit the next logical turn',
          decision: 'continue',
          alignment,
          admission,
        };
      }
      return {
        advanced: false,
        state: 'terminal',
        reason: `durable closure and planner alignment end the task with decision: ${alignment.decision}`,
        decision: alignment.decision,
        alignment,
        admission,
      };
    }
    if (this.turnState.phase === 'awaiting-planner-alignment') {
      return {
        advanced: false,
        state: 'awaiting-planner-alignment',
        reason: 'durable checkpoint and closure are committed but planner alignment is not composed yet',
      };
    }
    return {
      advanced: false,
      state: 'open',
      reason: 'turn is open; a durable four-part checkpoint and closure are required before any advance',
    };
  }

  /**
   * Recover the current logical turn from its authoritative durable stage. The stage is read
   * back from the checkpoint journal and the closure port only; it is never inferred from a
   * provider finish reason, a UI snapshot, or a log. Recovery always keeps the same turn:
   * - `closure-absent`: resume the original turn; no confirmed effect is replayed.
   * - `closure-committed-alignment-absent`: run planner alignment only, reusing a committed revision.
   * - `alignment-committed`: retry the exact readback only; never re-plan, re-publish, or re-commit.
   * - `unknown`: stay paused; an unconfirmed stage is never treated as absent.
   */
  async recoverTurn(input?: RecoverTurnInput, exact?: { readonly checkpointId: Checkpoint['id'] | null }): Promise<RecoverTurnResult> {
    const turn = this.requireTurn();
    const identity = turn.identity;

    let resolved: ResolvedTurnRecoveryStage;
    try {
      const retained = await turn.closurePort.read(frozenTurnCloseRef(identity));
      if (retained) {
        const candidate = this.asTurnRecoveryRecord(retained);
        assertTurnRecoveryRecord(candidate);
        if (!candidate.frozenClose || JSON.stringify(candidate.identity) !== JSON.stringify(identity)
          || (exact?.checkpointId && exact.checkpointId.value !== candidate.checkpointId.value)) {
          return { stage: 'unknown', turnId: identity.turnId, advance: 'paused' };
        }
        const frozen = candidate.frozenClose;
        const recoveryRecord = { ...candidate, closureId: turnBoundaryRecordRefs(identity, candidate.checkpointId).turnRecoveryRecordRef };
        this.pendingClose = { ...structuredClone(frozen), recoveryRecord };
        exact = { checkpointId: candidate.checkpointId };
      }
      resolved = await this.resolveTurnRecoveryStage(turn, exact);
    } catch {
      return { stage: 'unknown', turnId: identity.turnId, advance: 'paused' };
    }

    if (resolved.kind === 'unknown') {
      return { stage: 'unknown', turnId: identity.turnId, advance: 'paused' };
    }

    if (resolved.kind === 'closure-absent') {
      // Resume the same logical turn. Recovery never builds a new turn or replays a confirmed effect.
      if (resolved.recovery && !this.pendingClose) {
        return { stage: 'unknown', turnId: identity.turnId, checkpointId: resolved.checkpointId, advance: 'paused' };
      }
      this.turnState = { phase: 'open' };
      return {
        stage: 'closure-absent',
        turnId: identity.turnId,
        ...(resolved.checkpointId ? { checkpointId: resolved.checkpointId } : {}),
        ...(resolved.recovery
          ? { recovery: this.turnRecoveryReference(resolved.recovery, resolved.recovery.firstErrorRef ?? this.turnErrorRef('recovery', 'same-turn recovery')) }
          : {}),
        advance: 'resume-same-turn',
      };
    }

    if (resolved.kind === 'closure-committed-alignment-absent') {
      // Closure is durable; only the missing planner alignment is resumed. Business never re-runs.
      this.turnState = {
        phase: 'awaiting-planner-alignment',
        closureRef: resolved.closure.closureRef,
        closure: resolved.closure,
        recoveryRecord: resolved.recovery,
      };
      if (!input) {
        return {
          stage: 'closure-committed-alignment-absent',
          turnId: identity.turnId,
          checkpointId: resolved.checkpointId,
          closure: resolved.closure,
          advance: 'alignment-only',
        };
      }
      const aligned = await this.alignTurn(input);
      if (aligned.state === 'aligned') {
        return {
          stage: 'closure-committed-alignment-absent',
          turnId: identity.turnId,
          checkpointId: resolved.checkpointId,
          closure: resolved.closure,
          alignment: aligned.alignment,
          advance: 'alignment-only',
        };
      }
      return {
        stage: 'closure-committed-alignment-absent',
        turnId: identity.turnId,
        checkpointId: resolved.checkpointId,
        closure: resolved.closure,
        recovery: aligned.recovery,
        advance: 'paused',
      };
    }

    // Alignment is already durable: only re-read it and re-validate the exact binding.
    try {
      assertTurnAlignmentBinding(resolved.closure, resolved.alignment);
    } catch {
      return { stage: 'unknown', turnId: identity.turnId, advance: 'paused' };
    }
    this.turnState = { phase: 'aligned', closure: resolved.closure, alignment: resolved.alignment };
    return {
      stage: 'alignment-committed',
      turnId: identity.turnId,
      checkpointId: resolved.checkpointId,
      closure: resolved.closure,
      alignment: resolved.alignment,
      advance: 'readback-only',
    };
  }

  /** Exact serialized candidate for App boundary continuation; callback stays App-owned. */
  retainedTurnClose() {
    if (!this.pendingClose) return null;
    const { checkpoint, previous, inputs, reviewCommitRefs, bound } = this.pendingClose;
    return structuredClone({ checkpoint, previous, inputs, reviewCommitRefs, bound });
  }

  private async resolveTurnRecoveryStage(turn: AgentLoopTurnConfig, exact?: { readonly checkpointId: Checkpoint['id'] | null }): Promise<ResolvedTurnRecoveryStage> {
    const identity = turn.identity;
    const selected = exact === undefined ? await turn.journal.readLatest(identity.scopeRef)
      : exact.checkpointId === null ? null : await turn.journal.readCommitted(identity.scopeRef, exact.checkpointId);
    if (!selected && !exact?.checkpointId) return { kind: 'closure-absent' };

    const checkpointId = exact?.checkpointId ?? selected!.checkpoint.id;
    const refs = turnBoundaryRecordRefs(identity, checkpointId);
    const [closureRecord, alignmentRecord, recoveryRecord] = await Promise.all([
      turn.closurePort.read(refs.turnClosureRef),
      turn.closurePort.read(refs.alignmentRef),
      turn.closurePort.read(refs.turnRecoveryRecordRef),
    ]);

    const recovery = recoveryRecord ? this.asTurnRecoveryRecord(recoveryRecord) : null;
    if (!closureRecord) {
      // A committed checkpoint is not a committed closure; resume the original turn.
      return { kind: 'closure-absent', checkpointId, ...(recovery ? { recovery } : {}) };
    }
    // A committed closure always carries a durable recovery responsibility; without it the
    // durable stage cannot be confirmed and the turn stays paused instead of resuming.
    if (!recovery) return { kind: 'unknown' };

    const closure = this.asTurnClosureReference(this.asTurnClosureRecord(closureRecord));
    if (!alignmentRecord) {
      return { kind: 'closure-committed-alignment-absent', checkpointId, closure, recovery };
    }
    return {
      kind: 'alignment-committed',
      checkpointId,
      closure,
      alignment: this.asAlignmentRecord(alignmentRecord).alignment,
    };
  }

  private asTurnClosureRecord(record: ClosureRecord): TurnClosureRecord {
    if (!('closureKind' in record) || record.closureKind !== 'turn-closure') {
      throw new AgentLoopRuntimeError('conflict', 'turn-closure fact is missing or has a different closure kind');
    }
    return record;
  }

  private asTurnRecoveryRecord(record: ClosureRecord): TurnRecoveryRecord {
    if (!('closureKind' in record) || record.closureKind !== 'turn-recovery') {
      throw new AgentLoopRuntimeError('conflict', 'turn-recovery fact is missing or has a different closure kind');
    }
    return record;
  }

  private asTurnClosureReference(record: TurnClosureRecord): TurnClosureReference {
    return {
      identity: record.identity,
      checkpointId: record.checkpointId,
      closureRef: record.closureRef,
      summary: record.summary,
      recoveryStateRef: record.recoveryStateRef,
      closedAt: record.closedAt,
    };
  }

  private requireTurn(): AgentLoopTurnConfig {
    if (!this.turn) {
      throw new AgentLoopRuntimeError('turn-not-configured', 'agent loop has no durable turn binding; a turn cannot be closed or advanced');
    }
    return this.turn;
  }

  private buildTurnCheckpoint(previous: Checkpoint | null, input: CloseTurnInput, recoveryStateRef: EvidenceRef): Checkpoint {
    const turn = this.requireTurn();
    const identity = turn.identity;
    const evidenceRefs = dedupeEvidenceRefs([
      ...input.summary.goal.evidenceRefs,
      ...input.summary.actions.evidenceRefs,
      ...input.summary.result.evidenceRefs,
      ...input.summary.expectedNextStep.evidenceRefs,
    ]);
    const seq = (previous?.seq ?? 0) + 1;
    return {
      id: id('checkpoint', `turn-${sanitizeId(identity.turnId)}-${seq}`),
      scope: identity.scopeRef,
      cycleId: turn.cycleId,
      seq,
      previousCheckpointId: previous?.id ?? null,
      directiveRevision: identity.directiveRevision,
      executionEpoch: this.committedSegment?.binding.execution.executionEpoch ?? identity.executionEpoch,
      outcome: input.outcome,
      summary: renderTurnCloseSummary(input.summary),
      recoveryStateRef,
      evidenceRefs,
      next: turnNextAction(identity, input.outcome, input.unknownOperations ?? []),
    };
  }

  private turnRecoveryStateRef(): EvidenceRef {
    const identity = this.requireTurn().identity;
    return {
      evidenceId: id('evidence', `turn-recovery-${sanitizeId(identity.turnId)}`),
      kind: 'execution',
      source: 'runtime.turn-controller',
      locator: `turn://${identity.turnId}/recovery`,
      scope: identity.scopeRef,
    };
  }

  private turnRecoveryReference(record: TurnRecoveryRecord, firstErrorRef: string): TurnRecoveryReference {
    return {
      identity: record.identity,
      recoveryStateRef: record.recoveryStateRef,
      contextRef: record.contextRef,
      unfinishedRef: record.unfinishedRef,
      unreturnedCallRefs: record.unreturnedCallRefs,
      unresolvedOperationRefs: record.unresolvedOperationRefs,
      firstErrorRef,
    };
  }

  private turnErrorRef(phase: string, message: string): string {
    return `turn-error:${phase}:${digest({ phase, message }).slice(7, 23)}`;
  }

  private async commitAlignment(
    turn: AgentLoopTurnConfig,
    input: AlignTurnInput,
    identity: AdmittedTurnIdentity,
    closure: TurnClosureReference,
    alignmentId: string,
  ): Promise<PlannerAlignmentRecord> {
    const revision = await this.readOrPublishRevision(input, identity);
    const alignment: PlannerAlignmentReference = {
      identity,
      checkpointId: closure.checkpointId,
      closureRef: closure.closureRef,
      planRevisionId: revision.revisionId,
      planRevisionSequence: revision.sequence,
      planContentDigest: revision.contentDigest,
      decision: input.decision,
      alignedAt: this.now().toISOString(),
    };
    validatePlannerAlignmentReference(alignment);
    const record: PlannerAlignmentRecord = {
      closureKind: 'planner-alignment',
      closureId: alignmentId,
      alignment,
      planJournalCommitRef: revision.journalCommitRef,
    };
    assertPlannerAlignmentRecord(record);
    const receipt = await turn.closurePort.commit(record);
    if (!receipt.committed || receipt.closureId !== record.closureId) {
      throw new AgentLoopRuntimeError('conflict', 'planner alignment fact was not acknowledged');
    }
    return this.asAlignmentRecord(await turn.closurePort.read(alignmentId));
  }

  private asAlignmentRecord(record: ClosureRecord | null): PlannerAlignmentRecord {
    if (!record || !('closureKind' in record) || record.closureKind !== 'planner-alignment') {
      throw new AgentLoopRuntimeError('conflict', 'planner alignment fact is missing or has a different closure kind');
    }
    return record;
  }

  private async readOrPublishRevision(input: AlignTurnInput, identity: AdmittedTurnIdentity): Promise<PublishedTaskPlanRevision> {
    // Recovery path: an already-committed revision is read back, never republished.
    const existing = await input.consumer.get(input.publication.scope, input.publication.revisionId);
    const revision = existing ?? (await input.consumer.publish(input.publication)).revision;
    const turnTask = identity.scopeRef.taskId;
    if (!turnTask || revision.scope.taskId.scope !== turnTask.scope || revision.scope.taskId.value !== turnTask.value) {
      throw new AgentLoopRuntimeError('conflict', 'published plan revision task does not match the logical turn');
    }
    return revision;
  }

  private buildAlignmentRecoveryRecord(
    identity: AdmittedTurnIdentity,
    closure: TurnClosureReference,
    base: TurnRecoveryRecord,
  ): TurnRecoveryRecord {
    return {
      ...base,
      closureId: `turn-recovery:alignment:${sanitizeId(identity.turnId)}:${closure.checkpointId.value}`,
      checkpointId: closure.checkpointId,
      failedPhase: 'alignment',
    };
  }

  private prepareReplacement(input: {
    readonly deltaIds: readonly string[];
    readonly reason: ContextReplacementReason;
    readonly summary: string;
    readonly contextViewRef: string;
    readonly contextDigest: string;
    readonly activeRefs: readonly string[];
    readonly omittedRefs: readonly string[];
    readonly watermark: AgentLoopEventWatermark;
    readonly observationScopeId: string;
  }, countBudget = true): {
    readonly replacement: ContextReplacement;
    readonly checkpoint: AgentLoopCheckpoint;
    readonly contextView: ContextView;
    readonly usage: AgentLoopBudgetUsage;
  } {
    if (countBudget) this.assertBudget('contextReplacements', 1);
    nonEmpty(input.summary, 'checkpoint summary');
    nonEmpty(input.contextViewRef, 'context view ref');
    nonEmpty(input.contextDigest, 'context digest');
    const activeRefs = unique(input.activeRefs, 'context active refs');
    const omittedRefs = unique(input.omittedRefs, 'context omitted refs');
    if (activeRefs.some((ref) => omittedRefs.includes(ref))) throw new AgentLoopRuntimeError('conflict', 'context active refs and omitted refs overlap');
    const previous = this.checkpoint;
    const successorContextRef = input.contextViewRef;
    const contextView: ContextView = {
      contextViewRef: successorContextRef,
      executionEpoch: this.request.executionEpoch,
      checkpoint: { checkpointId: id('checkpoint', `${this.request.agentRuntimeId}-${previous.sequence + 1}`), digest: '' },
      contextDigest: input.contextDigest,
      activeRefs,
      omittedRefs,
    };
    const checkpoint = this.createSuccessorCheckpoint(input.observationScopeId, successorContextRef, input.watermark, input.summary);
    const finalizedContext = { ...contextView, checkpoint: refOf(checkpoint) };
    const replacement: ContextReplacement = {
      replacementId: `${this.request.agentRuntimeId}:replacement:${checkpoint.sequence}`,
      executionEpoch: this.request.executionEpoch,
      baseCheckpoint: refOf(previous),
      successorCheckpoint: refOf(checkpoint),
      fromContextViewRef: this.contextView.contextViewRef,
      toContextViewRef: successorContextRef,
      toContextDigest: input.contextDigest,
      deltaIds: unique(input.deltaIds, 'context replacement delta ids'),
      reason: input.reason,
      replacementDigest: digest({ base: refOf(previous), successor: refOf(checkpoint), context: finalizedContext, deltaIds: input.deltaIds, reason: input.reason }),
    };
    assertContextReplacementCurrent(replacement, this.modeState.checkpoint, this.request.executionEpoch);
    const usage = countBudget
      ? { ...this.usage, contextReplacements: this.usage.contextReplacements + 1 }
      : this.usage;
    return { replacement, checkpoint, contextView: finalizedContext, usage };
  }

  private createRootCheckpoint(observationScopeId: string, contextViewRef: string, contextDigest: string): AgentLoopCheckpoint {
    const base = {
      checkpointId: id('checkpoint', `${this.request.agentRuntimeId}-1`),
      sequence: 1,
      predecessor: null,
      executionEpoch: this.request.executionEpoch,
      eventWatermark: { streamId: this.request.observationStreamId, sequence: 0 },
      observationScopeId,
      contextViewRef,
    };
    const checkpoint: AgentLoopCheckpoint = { ...base, digest: digest({ ...base, contextDigest }) };
    this.checkpointRecords.set(checkpoint.checkpointId.value, checkpoint);
    return checkpoint;
  }

  private createSuccessorCheckpoint(observationScopeId: string, contextViewRef: string, watermark: AgentLoopEventWatermark, summary: string): AgentLoopCheckpoint {
    if (watermark.streamId !== this.request.observationStreamId || watermark.sequence < this.checkpoint.eventWatermark.sequence) {
      throw new AgentLoopRuntimeError('conflict', 'successor checkpoint watermark is stale');
    }
    const previous = this.checkpoint;
    const base = {
      checkpointId: id('checkpoint', `${this.request.agentRuntimeId}-${previous.sequence + 1}`),
      sequence: previous.sequence + 1,
      predecessor: refOf(previous),
      executionEpoch: this.request.executionEpoch,
      eventWatermark: watermark,
      observationScopeId,
      contextViewRef,
    };
    const checkpoint: AgentLoopCheckpoint = { ...base, digest: digest({ ...base, summary }) };
    validateAgentLoopCheckpoint(checkpoint, previous);
    return checkpoint;
  }

  private issueLease(profile: AgentModeCapabilityProfile, observationScopeId: string): import('../../../contracts/src/index.js').ModeLease {
    const issuedAt = this.now();
    const lease = {
      leaseId: `${this.request.agentRuntimeId}:lease:${this.committedSegment ? `incarnation:${this.committedSegment.binding.incarnation.agentInstanceId}:` : ''}${this.leaseOrdinal += 1}`,
      agentRuntimeId: this.request.agentRuntimeId,
      role: this.request.role,
      mode: profile.mode,
      profileId: profile.profileId,
      executionEpoch: this.request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      observationScopeId,
      permissionRevision: this.request.permissionRevision,
      capabilityDigest: profile.capabilityDigest,
      state: 'active' as const,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.leaseDurationMs).toISOString(),
    };
    return lease;
  }

  private requireProfile(mode: AgentMode): AgentModeCapabilityProfile {
    const profile = this.profiles.get(mode);
    if (!profile) throw new AgentLoopRuntimeError('invalid-state', `missing mode profile: ${mode}`);
    return profile;
  }

  private requireDurableContext(): ContextBuildInput<JsonValue> {
    if (!this.durableContext) {
      throw new AgentLoopRuntimeError('invalid-state', 'runtime has no installed durable context body');
    }
    return this.durableContext;
  }

  private requireOpenObservationScope(scopeId: string): void {
    if (!this.observationScope || this.observationScope.observationScopeId !== scopeId) {
      if (this.closedObservationScopes.has(scopeId)) throw new AgentLoopRuntimeError('invalid-state', `observation scope is closed: ${scopeId}`);
      throw new AgentLoopRuntimeError('invalid-state', `unknown observation scope: ${scopeId}`);
    }
  }

  private requireActor(actor: AgentLoopActor): void {
    if (actor.agentRuntimeId !== this.request.agentRuntimeId) throw new AgentLoopRuntimeError('unknown-owner', 'agent runtime owner does not match');
    assertModeLeaseCurrent(this.lease, {
      agentRuntimeId: this.modeState.agentRuntimeId,
      mode: this.modeState.mode,
      executionEpoch: this.modeState.executionEpoch,
      checkpoint: this.modeState.checkpoint,
      observationScopeId: this.modeState.observationScopeId,
      leaseId: this.modeState.leaseId,
    }, this.now());
    if (actor.leaseId !== this.lease.leaseId) throw new AgentLoopRuntimeError('conflict', 'agent loop lease is stale');
  }

  private assertBudget(kind: keyof AgentLoopBudgetUsage, increment: number): void {
    const current = this.usage[kind];
    const limitKey = kind === 'modeTransitions' ? 'maxModeTransitions'
      : kind === 'observationScopes' ? 'maxObservationScopes'
        : kind === 'contextReplacements' ? 'maxContextReplacements' : 'maxDeferredEvents';
    const limit = this.request.budget[limitKey];
    if (current + increment > limit) {
      const decision = classifyAgentLoopBudget(this.request.budget, { ...this.usage, [kind]: limit });
      throw new AgentLoopRuntimeError('budget-exhausted', `agent loop budget exhausted: ${decision.state === 'blocked' ? decision.reason : limitKey}`);
    }
  }
}
