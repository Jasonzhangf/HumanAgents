import type {
  EvidenceRef,
  HealthState,
  InteractionTraceEntry,
  LifecycleState,
  OrganId,
  SemanticObservationEnvelope,
  TaskAgentActivityCurrency,
  TaskAgentActivitySourceKind,
  TaskAgentActivityUnavailableSource,
  TaskId,
  TaskIdentitySource,
  TaskFlowBinding,
} from '@humanagent/contracts';
import type { CanonicalContextEvent } from '../../context-events/src/index.js';
import type { TaskDetailProjection } from './models.js';
import type { RuntimeTaskPlanHistoryProjection } from './task-plan-history.js';
import type { RuntimeCheckpointFilter } from './checkpoint-history.js';
import type { TaskActualExecutionGraphProjection } from './actual-execution-graph.js';
export type { RuntimeCheckpointFilter } from './checkpoint-history.js';

export type { TaskDetailProjection };

/**
 * I1-C（设计稿 §17.3）：唯一的 canonical concrete specialization。
 *
 * UI 通过既有的 context-events public index 以 type-only import 使用 canonical 类型；
 * `SemanticObservationEnvelope` 来自共享 contracts。依赖方向 `UI -> context-events -> contracts`
 * 与 `UI -> contracts`，无反向边、无 runtime import、无事件副本或第二 schema。
 */
export type RuntimeSemanticObservationEnvelope = SemanticObservationEnvelope<CanonicalContextEvent>;

/**
 * I1 presentation-ready semantic observation view (`semantic-observation-view@1`).
 *
 * The typed envelope above is the authoritative read. This contract names the
 * concrete projection the shared read-only view component consumes, so the
 * browser never inspects raw event fields to infer semantics and never rebuilds
 * pairing state from a payload. Human-readable labels lead every field; the
 * technical identifiers travel as evidence only.
 */
export type SemanticObservationDisplayMode = 'current' | 'semantic' | 'actions' | 'raw';

export interface SemanticObservationViewCrumb {
  readonly scopeRef: string;
  readonly title: string;
  readonly current?: boolean;
}

export interface SemanticObservationViewEvidence {
  readonly evidenceId: string;
  readonly title: string;
  readonly summary?: string;
  readonly scopeLabel?: string;
  readonly sourceLabel?: string;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly refs?: readonly string[];
  readonly raw?: {
    readonly label: string;
    readonly content: string;
  };
}

export interface SemanticObservationViewItem {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly meta?: readonly string[];
  readonly state?: string;
  readonly stateLabel?: string;
  readonly tone?: string;
  readonly kind?: string;
  readonly evidence?: SemanticObservationViewEvidence;
}

export interface SemanticObservationViewSection {
  readonly id: string;
  readonly title: string;
  readonly kind: 'stable' | 'live' | 'semantic' | 'action' | 'raw' | 'capability';
  readonly description?: string;
  readonly items: readonly SemanticObservationViewItem[];
}

export interface SemanticObservationViewNotice {
  readonly tone: 'info' | 'stale' | 'unknown' | 'unavailable' | 'error' | 'empty' | 'loading';
  readonly title: string;
  readonly detail?: string;
  readonly nextAction?: string;
}

export interface SemanticObservationViewProjection {
  readonly contractVersion: 'semantic-observation-view@1';
  readonly mode: SemanticObservationDisplayMode;
  readonly modes: readonly {
    readonly id: SemanticObservationDisplayMode;
    readonly label: string;
    readonly available?: boolean;
    readonly reason?: string;
  }[];
  readonly scope: {
    readonly scopeRef: string;
    readonly title: string;
    readonly summary: string;
    readonly breadcrumbs: readonly SemanticObservationViewCrumb[];
  };
  readonly state: string;
  readonly stateLabel: string;
  readonly projectionVersion: string;
  readonly summary: readonly {
    readonly label: string;
    readonly value: string;
    readonly tone?: string;
  }[];
  readonly notices: readonly SemanticObservationViewNotice[];
  readonly capabilities: readonly {
    readonly capability: string;
    readonly state: 'available' | 'unavailable' | 'unknown';
    readonly reason?: string;
  }[];
  readonly sections: readonly SemanticObservationViewSection[];
}

// UI phase-one runtime surface. The browser consumes these typed projections from
// the HumanAgent Runtime API; it never reads Journal, DSH session, or RCC frames.
export type RuntimeMode = 'fake' | 'rcc' | 'dsh';

export type RuntimeSurfaceState =
  | 'ready'
  | 'running'
  | 'degraded'
  | 'unavailable'
  | 'disabled'
  | 'disconnected'
  | 'empty'
  | 'unknown';

export interface RuntimeModeStatus {
  readonly mode: RuntimeMode;
  readonly enabled: boolean;
  readonly state: RuntimeSurfaceState;
  readonly detail?: string;
}

export interface RuntimeStatusProjection {
  readonly surface: 'runtime-status';
  readonly mode: RuntimeMode;
  readonly state: RuntimeSurfaceState;
  readonly connected: boolean;
  readonly providerState: string;
  readonly providerError?: RuntimeTaskErrorProjection;
  readonly detail?: string;
  readonly modes: readonly RuntimeModeStatus[];
  readonly implicitScheduling?: RuntimeImplicitSchedulingProjection;
}

export interface RuntimeImplicitSchedulingProjection {
  readonly state: 'queued' | 'waiting' | 'blocked' | 'failed';
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
  readonly requirementId: string;
  readonly draftId: string;
  readonly fifoSeq: number;
}

export type OrganHealthDimension =
  | 'liveness'
  | 'readiness'
  | 'correctness'
  | 'continuity'
  | 'capacity'
  | 'dependency';

export interface OrganHealthDimensionProjection {
  readonly dimension: OrganHealthDimension;
  readonly status: 'healthy' | 'degraded' | 'failed' | 'unknown';
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly measurements: readonly {
    readonly name: string;
    readonly value: string | number;
    readonly unit?: string;
  }[];
}

export interface OrganHealthProjection {
  readonly surface: 'organ-health';
  readonly organId: OrganId;
  readonly lifecycleState: string;
  readonly healthState: HealthState;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly stale: boolean;
  readonly dimensions: readonly OrganHealthDimensionProjection[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RuntimeRecentInputProjection {
  readonly text: string;
  readonly receivedAt: string;
  readonly taskId?: TaskId;
  readonly taskTitle?: string;
  readonly source: 'human' | 'task';
}

export interface RuntimeRecentOutputProjection {
  readonly taskId: TaskId;
  readonly taskTitle: string;
  readonly text: string;
  readonly occurredAt: string;
}

export interface RuntimeRecentFailureProjection {
  readonly taskId: TaskId;
  readonly taskTitle: string;
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
  readonly occurredAt: string;
}

export interface RuntimeDashboardProjection {
  readonly surface: 'runtime-dashboard';
  readonly mode: RuntimeMode;
  readonly hasRunning: boolean;
  readonly taskCount: number;
  readonly recentInputs: readonly RuntimeRecentInputProjection[];
  readonly recentOutputs: readonly RuntimeRecentOutputProjection[];
  readonly recentFailures: readonly RuntimeRecentFailureProjection[];
}

export interface RuntimeTaskRowProjection {
  readonly taskId: TaskId;
  readonly title: string;
  /**
   * App-derived committed `TaskIdentityRecord.title` only. Present when an
   * exact committed semantic name exists; absent for legacy rows. `title`
   * stays the full original task title for detail reads.
   */
  readonly semanticTitle?: string;
  /**
   * Exact committed execution lineage of a child Task. The app supplies it
   * only from the committed identity source and occurrence binding; the UI
   * never infers it from titles, IDs, or query guesses.
   */
  readonly executionLineage?: RuntimeTaskExecutionLineage;
  /**
   * Navigation scope only, paired with this row's exact task ID. It is never
   * permission evidence or a grant inherited from a parent row.
   */
  readonly controlTarget?: RuntimeTaskControlTarget;
  /**
   * Read-only children grouped under this business work item. Present only
   * when the list projection matched explicit committed lineage; the child
   * row still carries its own full row, history, and control target.
   */
  readonly executions?: readonly RuntimeTaskRowProjection[];
  readonly state: LifecycleState;
  readonly stateLabel: string;
  readonly taskFlow?: TaskFlowBinding;
  readonly requirementQueue?: string;
  readonly requirementAdmission?: 'queued' | 'admitted' | 'executing' | 'completed' | 'blocked' | 'retired' | 'unknown';
  readonly requirementAdmissionLabel?: string;
  /**
   * Exact accepted source of the Task, projected from the committed Task
   * identity whose scope matches this row. Absent when no identity is committed
   * for this Task (for example a queued or legacy row). Absence must not be read
   * as a matching Task.
   */
  readonly identitySource?: TaskIdentitySource;
  readonly currentState: string;
  readonly nextStep: string;
  readonly updatedAt: string;
  readonly allowedActions: readonly string[];
  readonly output: string;
  readonly publicOutput?: PublicOutputPublicationProjection;
  readonly error?: RuntimeTaskErrorProjection;
  readonly checkpoint?: RuntimeTaskCheckpointProjection;
  readonly entry: 'task-dashboard';
}

export interface RuntimeTaskExecutionLineage {
  readonly parentTaskId: TaskId;
  readonly subscriptionId: string;
  readonly occurrenceId: string;
}

export interface RuntimeTaskControlTarget {
  readonly projectKey: string;
  readonly mode: 'fake' | 'rcc';
}

export interface RuntimeTaskListProjection {
  readonly surface: 'runtime-task-list';
  readonly mode: RuntimeMode;
  readonly running: readonly RuntimeTaskRowProjection[];
  readonly waiting: readonly RuntimeTaskRowProjection[];
  readonly completed: readonly RuntimeTaskRowProjection[];
  readonly stopped: readonly RuntimeTaskRowProjection[];
  readonly draft: readonly RuntimeTaskRowProjection[];
  readonly failed: readonly RuntimeTaskRowProjection[];
  readonly counts: {
    readonly running: number;
    readonly waiting: number;
    readonly completed: number;
    readonly stopped: number;
    readonly draft: number;
    readonly failed: number;
    readonly total: number;
  };
}

export interface RuntimeTaskEventProjection {
  readonly seq: number;
  readonly kind: string;
  readonly state: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly callId?: string;
  readonly toolId?: string;
  readonly arguments?: unknown;
  readonly status?: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';
  readonly error?: RuntimeTaskErrorProjection;
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly ownerId?: string;
  readonly retryable?: boolean;
  readonly nextAction?: string;
  readonly terminalPhase?: 'provider' | 'final';
}

export interface RuntimeTaskCheckpointProjection {
  readonly checkpointId: string;
  readonly seq: number;
  readonly outcome: string;
  readonly summary: string;
  /**
   * First durable commit time. Present only when the committed checkpoint has
   * a native receipt; a legacy v1 record never invents one.
   */
  readonly committedAt?: string;
  /** Why no durable commit time exists. Present only when `committedAt` is absent. */
  readonly committedAtUnavailableReason?: string;
}

export interface PublicOutputCommitProjection {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
  readonly text: string;
}

export interface PublicOutputPublicationProjection {
  readonly state: 'pending' | 'committed' | 'unavailable' | 'unknown';
  readonly commits: readonly PublicOutputCommitProjection[];
  readonly publicCommitWatermark?: number;
}

export interface TaskRuntimeIncarnationProjection {
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

export interface RuntimePoolAvailabilityProjection {
  readonly state: 'available' | 'unavailable' | 'unknown';
  readonly reason?: string;
}

export interface RuntimeReadFailure {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
}

export type RuntimeReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RuntimeReadFailure };

export type RuntimeReadScope =
  | { readonly kind: 'system' }
  | { readonly kind: 'project'; readonly projectKey: string }
  | {
      readonly kind: 'task';
      readonly projectKey: string;
      readonly mode: RuntimeMode;
      readonly taskId: TaskId;
    };

export interface RuntimeProjectTaskReadRow {
  readonly scope: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly task: RuntimeTaskRowProjection;
  readonly basis: 'live-runtime' | 'durable-history';
}

export interface RuntimeProjectReadProjection {
  readonly surface: 'runtime-project';
  readonly scope: Extract<RuntimeReadScope, { readonly kind: 'project' }>;
  readonly label: string;
  readonly observedAt: string;
  readonly tasks: readonly RuntimeProjectTaskReadRow[];
  readonly taskCount: number;
  readonly complete: boolean;
  readonly failures: readonly RuntimeReadFailure[];
}

export interface RuntimeSystemReadProjection {
  readonly surface: 'runtime-system';
  readonly scope: { readonly kind: 'system' };
  readonly observedAt: string;
  readonly runtime: RuntimeStatusProjection;
  readonly coverage: 'configured-projects-in-current-control-root';
  readonly projects: readonly RuntimeProjectReadProjection[];
  readonly taskCount: number;
  readonly complete: boolean;
  readonly failures: readonly RuntimeReadFailure[];
}

export interface RuntimeStoredRecordRef {
  readonly projectKey: string;
  readonly mode: RuntimeMode;
  readonly taskId: TaskId;
  readonly source: 'task-journal' | 'checkpoint-journal';
  readonly ordinal: number;
  readonly operationId?: string;
  readonly executionEpoch?: number;
  readonly checkpointId?: string;
}

export interface RuntimeRawEventProjection extends RuntimeTaskEventProjection {
  readonly eventId: string;
  readonly operationId: string;
  readonly executionEpoch: number;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly parentRequestId?: string;
  readonly providerOccurredAt?: string;
}

export type RuntimeRawRecordBody =
  | {
      readonly kind: 'task.created' | 'task.updated';
      readonly title: string;
      readonly directive: string;
      readonly directiveRevision: number;
    }
  | { readonly kind: 'task.deleted'; readonly deletedAt: string }
  | {
      readonly kind: 'operation.started';
      readonly operationId: string;
      readonly executionEpoch: number;
      readonly input: string;
      readonly orchestrated: boolean;
    }
  | { readonly kind: 'operation.event'; readonly event: RuntimeRawEventProjection }
  | {
      readonly kind: 'checkpoint';
      readonly checkpointId: string;
      readonly seq: number;
      readonly outcome: string;
      readonly summary: string;
      readonly evidenceRefs: readonly EvidenceRef[];
    };

export interface RuntimeRawRecordProjection {
  readonly ref: RuntimeStoredRecordRef;
  readonly occurredAt: string;
  readonly body: RuntimeRawRecordBody;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RuntimeTaskRecordsProjection {
  readonly surface: 'runtime-task-records';
  readonly scope: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly observedAt: string;
  readonly actions: readonly {
    readonly entry: InteractionTraceEntry;
    readonly rawRef: RuntimeStoredRecordRef;
  }[];
  readonly raw: readonly RuntimeRawRecordProjection[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface RuntimeTaskErrorProjection {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextAction: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly cleanupError?: RuntimeTaskErrorProjection;
}

export interface RuntimeTaskDashboardProjection {
  readonly surface: 'runtime-task-dashboard';
  readonly mode: RuntimeMode;
  readonly taskId: TaskId;
  readonly taskTitle: string;
  readonly state: LifecycleState;
  readonly stateLabel: string;
  readonly currentNode: string;
  readonly input: string;
  readonly output: string;
  readonly recentEvents: readonly RuntimeTaskEventProjection[];
  readonly checkpoint?: RuntimeTaskCheckpointProjection;
  readonly error?: RuntimeTaskErrorProjection;
  readonly nextStep: string;
  readonly operationId?: string;
  readonly executionEpoch?: number;
  readonly allowedActions: readonly string[];
  readonly observationRef: string;
  /** Real execution liveness as the runtime observed it; absent when no facts were reported. */
  readonly liveness?: RuntimeLivenessProjection;
  /** Public text exists only when its commit is explicitly included here. */
  readonly publicOutput?: PublicOutputPublicationProjection;
  readonly runtimePool?: {
    readonly incarnations: readonly TaskRuntimeIncarnationProjection[];
    readonly availability: RuntimePoolAvailabilityProjection;
  };
  /**
   * Per-task Agent activity read, mounted by the app from the frozen
   * `TaskAgentActivitySelectionOutcome`. Absent when the app composed no read;
   * the projection never reclassifies or invents a current instance.
   */
  readonly agentActivity?: RuntimeReadResult<RuntimeAgentActivityProjection>;
  readonly taskPlanHistory: RuntimeReadResult<RuntimeTaskPlanHistoryProjection>;
}

export interface RuntimeCommitRefProjection {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
}

/**
 * UI view of one real execution instance. The identity is flattened so the
 * frozen `docs/ui/agent-activity.js` consumer can read `instance.runtimeId`,
 * `instance.executionEpoch` and, for a managed incarnation, `instance.roleId`,
 * `instance.generation` and `instance.agentInstanceId` directly. `label` is a
 * display name only and never carries the raw identity into the list view.
 */
export type RuntimeAgentActivityInstanceProjection =
  | {
      readonly kind: 'native-execution';
      readonly label: string;
      readonly runtimeId: string;
      readonly executionEpoch: number;
    }
  | {
      readonly kind: 'incarnation';
      readonly label: string;
      readonly runtimeId: string;
      readonly executionEpoch: number;
      readonly roleId: string;
      readonly generation: number;
      readonly agentInstanceId: string;
    };

interface RuntimeAgentActivityEntryProjectionCommon {
  readonly taskId: TaskId;
  readonly instance: RuntimeAgentActivityInstanceProjection;
  readonly assignmentId: string;
  /** Present only when the source record carried a real attempt; never defaulted. */
  readonly attempt?: number;
  readonly executionEpoch: number;
  readonly businessTurnId?: string;
  readonly segmentId?: string;
  readonly nodeId?: string;
  readonly sourceKindLabel: string;
  readonly currency: TaskAgentActivityCurrency;
  readonly currencyLabel: string;
  readonly missingSource?: string;
  readonly commitRefs: readonly RuntimeCommitRefProjection[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * A `closed-turn-planner-call` instance carries no authoritative Planner
 * `objective` (no persisted `WorkAssignment.objective` for the Planner record),
 * so `objective` is optional for it only. Every other source kind keeps the
 * mandatory non-empty `objective`. The projection never fabricates a role name
 * or placeholder in its place.
 */
export type RuntimeAgentActivityEntryProjection =
  | (RuntimeAgentActivityEntryProjectionCommon & {
      readonly sourceKind: Exclude<TaskAgentActivitySourceKind, 'closed-turn-planner-call'>;
      readonly objective: string;
    })
  | (RuntimeAgentActivityEntryProjectionCommon & {
      readonly sourceKind: 'closed-turn-planner-call';
      readonly objective?: string;
    });

/**
 * Pure UI projection of the frozen `TaskAgentActivitySelectionOutcome`. The
 * `current` / `historical` / `unknown` / `selected` arrays are carried
 * independently: this view never reclassifies, deduplicates or selects an
 * instance. `scope` is display/link context only; it owns no control.
 */
export interface RuntimeAgentActivityProjection {
  readonly surface: 'runtime-agent-activity';
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly taskId: TaskId;
  readonly mode: 'catalog' | 'selected';
  readonly selectedInstance?: RuntimeAgentActivityInstanceProjection;
  readonly selected?: readonly RuntimeAgentActivityEntryProjection[];
  readonly current: readonly RuntimeAgentActivityEntryProjection[];
  readonly historical: readonly RuntimeAgentActivityEntryProjection[];
  readonly unknown: readonly RuntimeAgentActivityEntryProjection[];
  readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
  /**
   * App-owned read-only attachment on a successful activity value. The app
   * projects the P1 source snapshot through the UI helper; this field never
   * creates, replays or mutates execution state in the browser.
   */
  readonly actualExecutionGraph?: TaskActualExecutionGraphProjection;
}

export interface RuntimeContextViewProjection {
  readonly contextViewRef: string;
  readonly executionEpoch: number;
  readonly contextDigest: string;
  readonly checkpointId: string;
  readonly activeRefs: readonly string[];
  readonly omittedRefs: readonly string[];
}

export interface RuntimeContextReplacementProjection {
  readonly replacementId: string;
  readonly executionEpoch: number;
  readonly fromContextViewRef: string;
  readonly toContextViewRef: string;
  readonly toContextDigest: string;
  readonly deltaIds: readonly string[];
  readonly reason: 'observation' | 'compaction' | 'recovery';
  readonly replacementDigest: string;
}

export interface RuntimeContextHistoryProjection {
  readonly surface: 'runtime-context-history';
  readonly mode: RuntimeMode;
  readonly taskId: TaskId;
  readonly currentContextCommitRef: RuntimeCommitRefProjection | undefined;
  readonly views: readonly RuntimeContextViewProjection[];
  readonly replacements: readonly RuntimeContextReplacementProjection[];
  readonly nextCursor?: string;
}

export interface RuntimeCheckpointProjection {
  readonly checkpointId: string;
  readonly seq: number;
  readonly executionEpoch: number;
  readonly summary: string;
  readonly directiveRevision?: string;
  readonly cycleId?: string;
  readonly occurrenceRef?: string;
  readonly committedAt?: string;
  readonly commitRef?: RuntimeCommitRefProjection;
}

export interface RuntimeCheckpointCursorProjection {
  readonly checkpointId: string;
  readonly executionEpoch: number;
}

export interface RuntimeCheckpointHistoryProjection {
  readonly surface: 'runtime-checkpoint-history';
  readonly mode: RuntimeMode;
  readonly taskId: TaskId;
  /** Execution position is independent from user selection. */
  readonly current: RuntimeCheckpointCursorProjection | undefined;
  readonly viewed: RuntimeCheckpointCursorProjection | undefined;
  readonly checkpoints: readonly RuntimeCheckpointProjection[];
  readonly nextCursor?: string;
  readonly capabilities: Partial<Record<RuntimeCheckpointFilter, RuntimePoolAvailabilityProjection>>;
}

// ── I2 durable history read projections ─────────────────────────────────────
// These are the frozen U schema for the I2 public history routes. Every field
// comes from a committed I2 record or an owner-provided current-position
// resolver. The projection never derives the current position from history.

export interface RuntimeTaskScopeProjection {
  readonly organId: OrganId;
  readonly taskId: TaskId;
}

/**
 * Current execution position for an I2 history read.
 *
 * `unknown` is explicit: a runtime assembled without a current-position owner
 * reports `unknown`, never a known-empty `{ cycleId: null }` that would read as
 * "this task has no current cycle". Selecting an old history entry never writes
 * this value.
 */
export type RuntimeI2CurrentPosition =
  | {
      readonly state: 'known';
      readonly cycleId: string | null;
      readonly planRevisionCommitRef: RuntimeCommitRefProjection | null;
    }
  | { readonly state: 'unknown'; readonly reason: string };

export interface RuntimeNextActionProjection {
  readonly kind: string;
  readonly ref: string | null;
}

export interface RuntimeScheduleOccurrenceProjection {
  readonly subscriptionId: string;
  readonly scheduleRevision: number;
  readonly ordinal: number;
  readonly occurrenceId: string;
}

export interface RuntimeInspectionItemProjection {
  readonly checkId: string;
  /** What the check inspected, from the immutable definition. */
  readonly criterion: string;
  /** Display state; a negative observed condition is still `completed`. */
  readonly state: 'completed' | 'failed' | 'missing';
  /** Exact execution outcome, keeping the distinct blocked/cancelled/unknown. */
  readonly outcome: 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unknown' | 'missing';
  readonly judgment: string | null;
  readonly reason: string | null;
  readonly resultRef: string | null;
  readonly completedAt: string | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RuntimeInspectionOccurrenceProjection {
  readonly occurrenceId: string;
  readonly cycleId: string;
  readonly executionEpoch: number;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionDigest: string;
  readonly definitionCommitRef: RuntimeCommitRefProjection;
  readonly openingCommitRef: RuntimeCommitRefProjection;
  readonly settlementCommitRef: RuntimeCommitRefProjection | null;
  readonly openedAt: string;
  readonly settledAt: string | null;
  readonly state: 'open' | 'settled';
  readonly outcome: 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unknown' | 'pending';
  readonly outcomeReason: string | null;
  readonly scheduleOccurrenceRef: RuntimeScheduleOccurrenceProjection | null;
  readonly items: readonly RuntimeInspectionItemProjection[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RuntimeInspectionOccurrenceHistoryProjection {
  readonly surface: 'runtime-inspection-occurrences';
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly viewed: { readonly occurrenceId: string } | null;
  readonly entries: readonly RuntimeInspectionOccurrenceProjection[];
  readonly nextCursor?: string;
}

export interface RuntimeInspectionOccurrenceEntryProjection {
  readonly surface: 'runtime-inspection-occurrence';
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly viewed: { readonly occurrenceId: string } | null;
  readonly entry: RuntimeInspectionOccurrenceProjection;
}

export interface RuntimeReviewFindingProjection {
  readonly findingId: string;
  readonly severity: string;
  readonly locationRef: string;
  readonly problem: string;
  readonly expected: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RuntimeSelectedReviewerProjection {
  readonly runtimeId: string;
  readonly generation: number;
  readonly agentInstanceId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly executionEpoch: number;
}

export interface RuntimeMilestoneReviewProjection {
  readonly milestoneId: string;
  readonly cycleId: string;
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly reviewKind: string;
  readonly findings: readonly RuntimeReviewFindingProjection[];
  readonly outputText: string;
  readonly artifactRef: string | null;
  readonly artifactDigest: string | null;
  readonly reviewer: RuntimeSelectedReviewerProjection;
  readonly completedAt: string;
  readonly reviewCommitRef: RuntimeCommitRefProjection;
  readonly planRevisionCommitRef: RuntimeCommitRefProjection;
  /** Alignment is a separate durable edge; `pending` is not a passed milestone. */
  readonly alignment: 'aligned' | 'pending';
  readonly alignmentCommitRef: RuntimeCommitRefProjection | null;
  readonly alignedPlanRevisionCommitRef: RuntimeCommitRefProjection | null;
  readonly checkpointCommitRef: RuntimeCommitRefProjection | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RuntimeMilestoneReviewHistoryProjection {
  readonly surface: 'runtime-milestone-reviews';
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly entries: readonly RuntimeMilestoneReviewProjection[];
  readonly nextCursor?: string;
}

export interface RuntimeBusinessCycleProjection {
  readonly cycleId: string;
  readonly state: LifecycleState;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly taskFlow: { readonly kind: string; readonly definitionVersion: number };
  readonly openedAt: string;
  readonly openingReason: string;
  readonly openedCommitRef: RuntimeCommitRefProjection;
  readonly planRevisionCommitRef: RuntimeCommitRefProjection;
  readonly previousCycleCommitRef: RuntimeCommitRefProjection | null;
  readonly scheduleOccurrenceRef: RuntimeScheduleOccurrenceProjection | null;
  readonly inspectionOccurrenceId: string | null;
  readonly progress: 'open' | 'closed';
  readonly outcome: 'continue' | 'wait' | 'stop' | 'recover' | null;
  readonly next: RuntimeNextActionProjection | null;
  readonly closedAt: string | null;
  readonly closureCommitRef: RuntimeCommitRefProjection | null;
  readonly checkpointCommitRef: RuntimeCommitRefProjection | null;
  readonly inspectionSettlementCommitRef: RuntimeCommitRefProjection | null;
  readonly reviews: readonly RuntimeMilestoneReviewProjection[];
  readonly alignmentPending: number;
}

export interface RuntimeBusinessCycleHistoryProjection {
  readonly surface: 'runtime-business-cycles';
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly viewed: { readonly cycleId: string } | null;
  readonly entries: readonly RuntimeBusinessCycleProjection[];
  readonly nextCursor?: string;
}

export interface RuntimeBusinessCycleEntryProjection {
  readonly surface: 'runtime-business-cycle';
  readonly taskScope: RuntimeTaskScopeProjection;
  readonly scope?: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeI2CurrentPosition;
  readonly viewed: { readonly cycleId: string } | null;
  readonly entry: RuntimeBusinessCycleProjection;
}

export interface RuntimeInspectionItemComparisonProjection {
  readonly checkId: string;
  readonly criterion: string;
  readonly change: 'unchanged' | 'changed' | 'not-compared';
  readonly before: RuntimeInspectionItemProjection;
  readonly after: RuntimeInspectionItemProjection;
}

export interface RuntimeInspectionComparisonProjection {
  readonly surface: 'runtime-inspection-comparison';
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

/**
 * Real liveness facts. Every field is a reported observation: the projection
 * derives a state from them and never invents one. `silenceBudgetMs` is the
 * single declared silence budget (agent-io policy); it is not a UI timer.
 *
 * The event-transport fact is deliberately absent here. The only observer that
 * can read a transport loss is the page that holds the stream, and a
 * server-derived value cannot be fetched while that transport is down. The
 * transport fact therefore travels on the card's own transport field.
 */
export interface RuntimeLivenessInput {
  /** True while the runtime is executing this task (running or settling). */
  readonly active: boolean;
  /** Newest real activity timestamp reported for this task; absent when none was reported. */
  readonly lastActivityAt?: string;
  /** Which real runtime signal produced `lastActivityAt`. */
  readonly lastActivitySource?: string;
  /** Declared silence budget in milliseconds. */
  readonly silenceBudgetMs?: number;
  /** Real clock reading used for the derivation. */
  readonly observedAt: string;
}

/**
 * Liveness states with a real producer.
 *
 * `no-activity` is named for the signal that actually exists at this boundary:
 * the declared silence budget measured against the newest real activity
 * instant. The runtime's separate no-progress budget is owned inside `agent-io`
 * and is not mirrored here.
 */
export type RuntimeLivenessState =
  | 'working'
  | 'no-activity'
  | 'waiting-for-answer'
  | 'failed'
  | 'idle'
  | 'unknown';

/**
 * Liveness as observed, not as judged. `reason` states the observed fact (for
 * example "no real activity for 42000 ms; the declared silence budget is 30000
 * ms"); it never claims that the runtime already intervened or will intervene.
 */
export interface RuntimeLivenessProjection {
  readonly state: RuntimeLivenessState;
  readonly reason: string;
  readonly observedAt: string;
  readonly lastActivityAt?: string;
  readonly lastActivitySource?: string;
  readonly silentForMs?: number;
  readonly silenceBudgetMs?: number;
}

// Normalized SSE event stream. Carries domain lifecycle only; never raw RCC
// frames, full provider payloads, secrets, Journal records, or DSH types.
export type RuntimeSseEventKind =
  | 'execution.started'
  | 'provider.model'
  | 'provider.output'
  | 'provider.tool'
  | 'provider.tool-result'
  | 'provider.error'
  | 'execution.settling'
  | 'checkpoint.committed'
  | 'execution.terminal'
  | 'attention.opened'
  | 'attention.resolved';

export interface RuntimeSseEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly taskId: TaskId;
  readonly operationId: string;
  readonly executionEpoch: number;
  readonly kind: RuntimeSseEventKind;
  readonly state: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly callId?: string;
  readonly toolId?: string;
  readonly arguments?: unknown;
  readonly status?: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';
  readonly error?: RuntimeTaskErrorProjection;
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly ownerId?: string;
  readonly retryable?: boolean;
  readonly nextAction?: string;
  readonly terminalPhase?: 'provider' | 'final';
}

export class RuntimeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeProjectionError';
  }
}
