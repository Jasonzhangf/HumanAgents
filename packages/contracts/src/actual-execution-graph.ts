import type {
  AcceptedChildDelivery,
  ActiveTurnBinding,
  ActiveTurnProviderExecutionIdentityRef,
  ChildCallKind,
  ChildInvocationRecord,
} from './active-turn-context.js';
import type { ResumedTurnSegmentOpened } from './active-turn-segments.js';
import type {
  TaskAgentActivityCurrency,
  TaskAgentActivityUnavailableSource,
  TaskExecutionInstanceIdentity,
} from './agent-activity.js';
import type { TaskRuntimeIncarnation } from './framework.js';
import type { JournalCommitRef, MilestoneReviewResultRecord } from './i2-history.js';
import type { TaskFlowGuidance } from './task-flow.js';
import type { TaskIdentityScope } from './task-identity.js';
import type { TaskPlanRevisionId } from './task-plan-revision.js';
import type { PlannerAlignmentDecision, TurnClosureReference } from './turn-closure.js';
import type {
  AgentRoleDisplay,
  CheckpointId,
  EvidenceRef,
  OperationId,
  ProviderExecutionIdentityRef,
  ScopeRef,
  TaskId,
} from './index.js';

/**
 * The actual execution graph is a read-only presentation source. It contains
 * native records already owned by the active-turn, segment, review and Planner
 * contracts. It is not an assignment-graph fact stream and it is not the
 * current plan carrier.
 */
export type TaskActualExecutionNodeKind =
  | 'native-allocation'
  | 'active-turn'
  | 'resumed-segment'
  | 'child-invocation'
  | 'orphan-child-delivery'
  | 'milestone-review'
  | 'closed-turn-planner-call';

export type TaskActualExecutionGraphEdgeKind =
  | 'contains'
  | 'precedes'
  | 'delegates-child'
  | 'planner-duty';

/** A source gap survives in the graph instead of becoming an empty history. */
export interface TaskActualExecutionGraphUngroupedRelation {
  readonly nodeId: string;
  readonly kind: TaskActualExecutionGraphEdgeKind;
  readonly targetRef: string;
  readonly reason: string;
}

/** Only emitted when both node endpoints exist. */
export interface TaskActualExecutionGraphEdge {
  readonly edgeId: string;
  readonly kind: TaskActualExecutionGraphEdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

/** The real durable location that contains one child invocation or delivery. */
export type TaskActualExecutionContainingLocation =
  | {
      readonly kind: 'active-turn';
      readonly businessTurnId: string;
      readonly bindingCommitRef: JournalCommitRef;
    }
  | {
      readonly kind: 'resumed-segment';
      readonly businessTurnId: string;
      readonly segmentId: string;
      readonly openedCommitRef: JournalCommitRef;
    };

/**
 * Business closure is a fact about the admitted turn. It never means that every
 * physical resumed segment is closed.
 */
export type TaskActualExecutionBusinessClosure =
  | {
      readonly status: 'recorded';
      readonly closure: TurnClosureReference;
      readonly commitRef: JournalCommitRef;
    }
  | {
      readonly status: 'unknown';
      readonly reason: string;
    };

export interface TaskActualExecutionGraphNodeCommon {
  readonly nodeId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly objective?: string;
  /** Ownership currency is separate from the node's source-specific outcome. */
  readonly currency: TaskAgentActivityCurrency;
  readonly missingSource?: string;
  readonly commitRefs: readonly JournalCommitRef[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface TaskActualExecutionInstanceNodeCommon
  extends TaskActualExecutionGraphNodeCommon {
  readonly instance: TaskExecutionInstanceIdentity;
  readonly executionEpoch: number;
  readonly businessTurnId?: string;
  readonly segmentId?: string;
  readonly pipelineNodeId?: string;
}

export interface TaskActualExecutionNativeAllocationNode
  extends TaskActualExecutionInstanceNodeCommon {
  readonly kind: 'native-allocation';
  readonly instance: {
    readonly kind: 'native-execution';
    readonly execution: ActiveTurnProviderExecutionIdentityRef;
  };
  readonly objective: string;
  readonly allocation: {
    readonly runtimeId: string;
    readonly operationId: OperationId;
    readonly executionEpoch: number;
    readonly assignmentId: string;
    readonly scope: ScopeRef;
    readonly inputRefs: readonly string[];
    readonly ownerId: string;
    readonly directiveRevision: number;
    readonly inputRevision: number;
    readonly orchestrated: boolean;
    readonly role?: AgentRoleDisplay;
    readonly configuredAgentId?: string;
  };
}

export interface TaskActualExecutionActiveTurnNode
  extends TaskActualExecutionInstanceNodeCommon {
  readonly kind: 'active-turn';
  readonly instance: {
    readonly kind: 'native-execution';
    readonly execution: ActiveTurnProviderExecutionIdentityRef;
  };
  readonly businessTurnId: string;
  readonly binding: ActiveTurnBinding;
  readonly bindingCommitRef: JournalCommitRef;
  readonly businessClosure: TaskActualExecutionBusinessClosure;
}

export interface TaskActualExecutionResumedSegmentNode
  extends TaskActualExecutionInstanceNodeCommon {
  readonly kind: 'resumed-segment';
  readonly instance: {
    readonly kind: 'incarnation';
    readonly incarnation: TaskRuntimeIncarnation;
  };
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly opened: ResumedTurnSegmentOpened;
  readonly openedCommitRef: JournalCommitRef;
  /**
   * The opened record proves an opened physical segment. A business closure
   * never closes every physical segment. An empty `terminalCommitRefs` means no
   * exact terminal fact exists for this segment, so it stays open/unknown
   * instead of being reported closed.
   */
  readonly terminalCommitRefs: readonly JournalCommitRef[];
  readonly segmentState:
    | { readonly status: 'opened' }
    | { readonly status: 'unknown'; readonly reason: string };
}

export type TaskActualExecutionChildAcquisition =
  | {
      readonly status: 'acquired';
      readonly incarnation: TaskRuntimeIncarnation;
    }
  | {
      readonly status: 'unacquired';
      readonly reason: string;
    }
  | {
      readonly status: 'unknown';
      readonly reason: string;
    };

export type TaskActualExecutionChildReturn =
  | {
      readonly status: 'unreturned';
    }
  | {
      readonly status: 'returned';
      readonly delivery: AcceptedChildDelivery;
      readonly deliveryCommitRef: JournalCommitRef;
    }
  | {
      readonly status: 'unknown';
      readonly reason: string;
    };

export type TaskActualExecutionChildAdoption =
  | {
      readonly status: 'adopted';
      readonly resultSeq: number;
    }
  | {
      readonly status: 'not-selected';
      readonly resultSeq: number;
    }
  | {
      readonly status: 'undecided';
    }
  | {
      readonly status: 'unknown';
      readonly reason: string;
    };

export interface TaskActualExecutionChildInvocationNode
  extends TaskActualExecutionGraphNodeCommon {
  readonly kind: 'child-invocation';
  readonly callKind: ChildCallKind;
  readonly invocationId: string;
  readonly childTurnId: string;
  readonly checkpointReceiptRef: string;
  readonly record: ChildInvocationRecord;
  readonly invocationCommitRef: JournalCommitRef;
  readonly containingLocation: TaskActualExecutionContainingLocation;
  readonly linkage:
    | {
        readonly status: 'linked';
        readonly parentNodeId: string;
      }
    | {
        readonly status: 'ungrouped';
        readonly reason: string;
      };
  readonly acquisition: TaskActualExecutionChildAcquisition;
  readonly returnState: TaskActualExecutionChildReturn;
  readonly adoption: TaskActualExecutionChildAdoption;
}

export interface TaskActualExecutionOrphanChildDeliveryNode
  extends TaskActualExecutionGraphNodeCommon {
  readonly kind: 'orphan-child-delivery';
  readonly callKind: ChildCallKind;
  readonly invocationId: string;
  readonly delivery: AcceptedChildDelivery;
  readonly containingCommitRef: JournalCommitRef;
  readonly deliverySeq: number;
  readonly containingLocation?: TaskActualExecutionContainingLocation;
  readonly linkage: {
    readonly status: 'orphan';
    readonly reason: 'invocation-not-recorded';
  };
}

export interface TaskActualExecutionMilestoneReviewNode
  extends TaskActualExecutionInstanceNodeCommon {
  readonly kind: 'milestone-review';
  readonly instance: {
    readonly kind: 'incarnation';
    readonly incarnation: TaskRuntimeIncarnation;
  };
  readonly record: MilestoneReviewResultRecord;
  readonly reviewCommitRef: JournalCommitRef;
}

export type TaskActualExecutionPlannerCallStage = 'prepared' | 'invoked' | 'returned';

/**
 * Minimal presentation form of a closed-turn Planner call. Runtime maps the
 * real prepared/invoked/returned records into this shape. Contracts does not
 * clone the Runtime Planner record schema.
 */
export interface TaskActualExecutionClosedTurnPlannerNode
  extends TaskActualExecutionGraphNodeCommon {
  readonly kind: 'closed-turn-planner-call';
  readonly stage: TaskActualExecutionPlannerCallStage;
  readonly dutyKey: string;
  readonly invocationId: string;
  readonly scope: ScopeRef;
  readonly businessTurnId?: string;
  readonly segmentId?: string;
  readonly instance: {
    readonly kind: 'incarnation';
    readonly incarnation: TaskRuntimeIncarnation;
  };
  readonly execution: ProviderExecutionIdentityRef;
  readonly checkpointId: CheckpointId;
  readonly checkpointCommitRef: JournalCommitRef;
  readonly closureRef?: string;
  readonly closureCommitRef?: JournalCommitRef;
  readonly grantCommitRef: JournalCommitRef;
  readonly admissionCommitRef: JournalCommitRef;
  readonly preparationCommitRef: JournalCommitRef;
  readonly invocationCommitRef?: JournalCommitRef;
  readonly returnCommitRef?: JournalCommitRef;
  readonly planRevision?: {
    readonly revisionId: TaskPlanRevisionId;
    readonly sequence: number;
    readonly decision: PlannerAlignmentDecision;
  };
}

export type TaskActualExecutionGraphNode =
  | TaskActualExecutionNativeAllocationNode
  | TaskActualExecutionActiveTurnNode
  | TaskActualExecutionResumedSegmentNode
  | TaskActualExecutionChildInvocationNode
  | TaskActualExecutionOrphanChildDeliveryNode
  | TaskActualExecutionMilestoneReviewNode
  | TaskActualExecutionClosedTurnPlannerNode;

export type TaskActualExecutionGraphHistory =
  | {
      readonly status: 'recorded';
      readonly nodes: readonly TaskActualExecutionGraphNode[];
      readonly edges: readonly TaskActualExecutionGraphEdge[];
      readonly ungrouped: readonly TaskActualExecutionGraphUngroupedRelation[];
      readonly unavailable: readonly TaskAgentActivityUnavailableSource[];
    }
  | {
      readonly status: 'not-recorded';
      readonly reason: 'no-recorded-facts';
      readonly unavailable?: readonly TaskAgentActivityUnavailableSource[];
    };

/**
 * Contracts-owned source for the actual execution graph read carrier.
 * Task plan snapshots keep their existing carrier and are not copied here.
 */
export interface TaskActualExecutionGraphSnapshot {
  readonly taskScope: TaskIdentityScope;
  readonly guidance?: TaskFlowGuidance;
  readonly history: TaskActualExecutionGraphHistory;
}
