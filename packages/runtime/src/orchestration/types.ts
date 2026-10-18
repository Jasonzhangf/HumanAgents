import type {
  CycleId,
  EvidenceRef,
  ExecutionChildCallBinding,
  InspectionItemDelivery,
  JournalCommitRef,
  NextAction,
  ProviderExecutionIdentityRef,
  ReviewDelivery,
  ReviewOutput,
  ScopeRef,
  TaskId,
  TaskRuntimeIncarnation,
  WorkAssignment,
  WorkResult,
} from '../../../contracts/src/index.js';
import type { ReviewMaterial } from './review-material.js';
import type {
  ReviewAssignment,
  ReviewKind,
  ReviewResult,
} from '../review/index.js';

export type { TaskRuntimeIncarnation } from '../../../contracts/src/index.js';

export type AssignmentStatus =
  | 'planned'
  | 'assigned'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'incomplete'
  | 'blocked'
  | 'retryable'
  | 'escalated'
  | 'merged';

export interface OrchestrationIssue {
  readonly code: string;
  readonly ownerId: string;
  readonly reason: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly conditionRef?: string;
}

export interface RuntimePoolLease {
  readonly leaseId: string;
  readonly runtimeId: string;
  readonly generation: number;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly executionEpoch: number;
  readonly ownerId: string;
  readonly assignmentId: string;
  readonly capabilities: readonly string[];
}

export interface OrchestrationRuntimeStartInput {
  readonly runtimeId: string;
  readonly generation: number;
  readonly executionEpoch: number;
  readonly ownerId: string;
  readonly assignmentId: string;
  readonly requiredCapabilities: readonly string[];
  readonly scope: ScopeRef;
}

export interface OrchestrationRuntimeStarted {
  readonly runtimeId: string;
  readonly generation: number;
  readonly capabilities: readonly string[];
}

export interface OrchestrationRuntimeDisposeInput {
  readonly runtimeId: string;
  readonly generation: number;
  readonly executionEpoch: number;
  readonly ownerId: string;
  readonly assignmentId?: string;
}

export interface OrchestrationRuntimeFactoryPort {
  start(input: OrchestrationRuntimeStartInput): Promise<OrchestrationRuntimeStarted>;
  dispose(input: OrchestrationRuntimeDisposeInput): Promise<void>;
}

export interface WorkCriterionEvaluation {
  readonly satisfied: readonly string[];
  readonly failed: readonly string[];
  readonly incomplete: readonly string[];
}

export interface ExecutionDelivery {
  readonly result: WorkResult;
  readonly criteria?: WorkCriterionEvaluation;
  readonly inspectionDelivery?: InspectionItemDelivery;
}

export interface ExecutionAgentInput {
  readonly assignment: WorkAssignment;
  readonly agentId: string;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly lease: RuntimePoolLease;
  readonly scope: ScopeRef;
  readonly inspection?: ExecutionChildCallBinding['inspection'];
  readonly signal?: AbortSignal;
}

export interface ExecutionAgentPort {
  readonly roleId: string;
  createInstance(input: TaskExecutionInstanceCreateInput): TaskExecutionHandle;
  execute(input: ExecutionAgentInput): Promise<WorkResult | ExecutionDelivery>;
  /**
   * Optional release hook for execution agents that bind external resources
   * (for example a shared provider session) and finished non-successfully.
   * The runtime calls it before closing shared resources so a non-final
   * settlement does not leave that resource pending.
   */
  release?(input: {
    readonly assignment: WorkAssignment;
    readonly agentId: string;
    readonly executionEpoch: number;
    readonly attempt: number;
    readonly scope: ScopeRef;
  }): Promise<void>;
}

export interface ExecutionInstanceAcquireInput {
  readonly assignment: WorkAssignment;
  readonly scope: ScopeRef;
  readonly agentId: string;
  readonly executionEpoch: number;
}

export type TaskExecutionInstanceCreateInput = RuntimeInstanceCreateContext<WorkAssignment>;

export interface TaskExecutionHandle extends TaskInstanceHandle {
  execute(input: ExecutionAgentInput): Promise<WorkResult | ExecutionDelivery>;
}

export type ExecutionInstanceCreator = (
  input: TaskExecutionInstanceCreateInput,
) => TaskExecutionHandle;

/**
 * One prepared child call. The Runtime persists the call checkpoint and the
 * invocation/checkpoint association before the external port is invoked.
 */
export interface PreparedChildCall {
  readonly invocationId: string;
  readonly checkpointReceiptRef: string;
}

export interface ChildCallPrepareExecutionInput {
  readonly kind: 'execution';
  readonly invocationId: string;
  readonly assignment: WorkAssignment;
  readonly agentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly inspection?: ExecutionChildCallBinding['inspection'];
  /** Present for execution calls; absent for review calls, which hold no pool lease. */
  readonly lease?: RuntimePoolLease;
}

export interface ChildCallPrepareReviewInput {
  readonly kind: 'review';
  readonly invocationId: string;
  readonly assignment: ReviewAssignment;
  readonly agentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  /** Genuine acquired review lease; legacy direct review callers may omit it. */
  readonly lease?: RuntimePoolLease;
}

export type ChildCallPrepareInput = ChildCallPrepareExecutionInput | ChildCallPrepareReviewInput;

export interface ChildCallReturnExecutionInput {
  readonly kind: 'execution';
  readonly invocationId: string;
  readonly assignment: WorkAssignment;
  readonly agentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly result: WorkResult;
  readonly inspectionDelivery?: InspectionItemDelivery;
}

export interface ChildCallReturnReviewInput {
  readonly kind: 'review';
  readonly invocationId: string;
  readonly assignment: ReviewAssignment;
  readonly agentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly result: ReviewResult;
}

export type ChildCallReturnInput = ChildCallReturnExecutionInput | ChildCallReturnReviewInput;

export interface ChildCallAdoptionExecutionInput {
  readonly kind: 'execution';
  readonly invocationId: string;
  readonly assignment: WorkAssignment;
  readonly result: WorkResult;
  readonly scope: ScopeRef;
}

export interface ChildCallAdoptionReviewInput {
  readonly kind: 'review';
  readonly invocationId: string;
  readonly assignment: ReviewAssignment;
  readonly result: ReviewResult;
  readonly scope: ScopeRef;
}

export type ChildCallAdoptionInput = ChildCallAdoptionExecutionInput | ChildCallAdoptionReviewInput;

export interface ChildCallReviewCheckpointInput {
  readonly kind: 'review';
  readonly invocationId: string;
  readonly assignment: ReviewAssignment;
  readonly result: ReviewResult;
  readonly scope: ScopeRef;
}

export interface ChildCallReviewCheckpointReceipt {
  readonly checkpointReceiptRef: string;
}

/**
 * Narrow Runtime child-call port. The orchestration manager only asks the
 * Runtime to establish the recovery anchor before a real child call, record the
 * returned refined delivery, and record owner adoption. It never writes the
 * Journal, assembles raw context, or mints a Provider identity itself.
 */
export interface ChildCallPort {
  prepare(input: ChildCallPrepareInput): Promise<PreparedChildCall>;
  recordReturn(input: ChildCallReturnInput): Promise<void>;
  recordAdoption(input: ChildCallAdoptionInput): Promise<void>;
  recordReviewCheckpoint(input: ChildCallReviewCheckpointInput): Promise<ChildCallReviewCheckpointReceipt>;
}

export interface ReviewAgentInput {
  readonly reviewAssignment: ReviewAssignment;
  readonly workerAssignment: WorkAssignment;
  readonly workerResult: WorkResult;
  /**
   * Verified acceptance criteria content and produced subject bodies. The
   * reviewer evaluates this material instead of the worker summary or an
   * evidence locator.
   */
  readonly reviewMaterial: ReviewMaterial;
  readonly scope: ScopeRef;
  readonly signal?: AbortSignal;
}

/** Verified and registered by the actual parent tool/admission owner. */
export interface RegisteredParentChildCall {
  readonly invocationId: string;
  readonly parentExecution: ProviderExecutionIdentityRef;
  readonly providerRequestId: string;
  readonly toolCallId: string;
  readonly businessRegistrationCommitRef: JournalCommitRef;
}

export interface ChildCallCommon {
  readonly call: RegisteredParentChildCall;
  readonly agentId: string;
  readonly scope: ScopeRef;
  readonly childCallPort: ChildCallPort;
  readonly signal: AbortSignal;
}

export type IndependentChildCallInput =
  | (ChildCallCommon & {
      readonly kind: 'execution';
      readonly assignment: WorkAssignment;
      readonly executionAgent: ExecutionAgentPort;
      readonly inspection?: ExecutionChildCallBinding['inspection'];
    })
  | (ChildCallCommon & {
      readonly kind: 'review';
      readonly input: ReviewAgentInput;
      readonly reviewAgent: ReviewAgentPort;
      readonly milestoneReview?: MilestoneReviewBinding;
    });

export type IndependentChildCallResult =
  | {
      readonly state: 'returned';
      readonly kind: 'execution';
      readonly invocationId: string;
      readonly incarnation: TaskRuntimeIncarnation;
      readonly result: WorkResult;
      readonly inspectionDelivery?: InspectionItemDelivery;
    }
  | {
      readonly state: 'returned';
      readonly kind: 'review';
      readonly invocationId: string;
      readonly incarnation: TaskRuntimeIncarnation;
      readonly delivery: ReviewDelivery;
      readonly reviewCommitRef?: JournalCommitRef;
    }
  | {
      readonly state: 'waiting' | 'blocked';
      readonly invocationId: string;
      readonly issue: OrchestrationIssue;
      /** Secondary release failure never replaces the primary call error. */
      readonly releaseIssue?: OrchestrationIssue;
    };

export interface ReviewAgentPort {
  readonly roleId: string;
  createInstance(input: TaskReviewInstanceCreateInput): TaskReviewHandle;
  review(input: ReviewAgentInput): Promise<ReviewResult>;
}

/** Minimal identity an acquired runtime instance is bound to. */
export interface RuntimeInstanceRequest {
  readonly assignmentId: string;
  readonly taskId: TaskId;
  readonly attempt: number;
}

export interface RuntimeInstanceCreateContext<TRequest extends RuntimeInstanceRequest> {
  readonly incarnation: TaskRuntimeIncarnation;
  readonly agentId: string;
  readonly scope: ScopeRef;
  readonly assignment: TRequest;
}

export interface RuntimeInstanceReleaseInput {
  readonly assignment: RuntimeInstanceRequest;
  readonly agentId: string;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly scope: ScopeRef;
}

/** Lifecycle shared by every acquired, incarnation-bound instance handle. */
export interface TaskInstanceHandle {
  readonly incarnation: TaskRuntimeIncarnation;
  /**
   * Releases per-instance resources, including any active Provider driver or
   * attempt state. Pool slot ownership remains with the factory.
   */
  release?(input: RuntimeInstanceReleaseInput): Promise<void>;
  dispose(): Promise<void>;
}

export interface ReviewInstanceRequest extends RuntimeInstanceRequest {
  /**
   * Registered standalone parent call that selected this review. It is the
   * parent invocation identity, not the subject-bound review assignment, and it
   * lets the reviewer creator bind the real registered call. Absent for the
   * durable dispatch review path, which already carries its own binding.
   */
  readonly invocationId?: string;
  readonly reviewAssignment: ReviewAssignment;
  readonly workerAssignment: WorkAssignment;
}

export type TaskReviewInstanceCreateInput = RuntimeInstanceCreateContext<ReviewInstanceRequest>;

/**
 * Reviewer-side delivery returned by a constructed review instance. The
 * manager pairs it with the handle's real incarnation to form the shared
 * `ReviewDelivery`: the reviewer cannot name its own identity.
 */
export interface ReviewAgentDelivery {
  readonly result: ReviewResult;
  readonly output: ReviewOutput;
  readonly completedAt: string;
}

export interface TaskReviewHandle extends TaskInstanceHandle {
  review(input: ReviewAgentInput): Promise<ReviewAgentDelivery>;
}

export type ReviewInstanceCreator = (
  input: TaskReviewInstanceCreateInput,
) => TaskReviewHandle;

export interface MergeCoordinatorInput {
  readonly workerAssignment: WorkAssignment;
  readonly workerResult: WorkResult;
  readonly reviewAssignments: readonly ReviewAssignment[];
  readonly reviewResults: readonly ReviewResult[];
  readonly ownerId: string;
  readonly scope: ScopeRef;
}

export interface MergeOutcome {
  readonly status: 'merged' | 'failed' | 'blocked';
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly reason?: string;
  readonly nextAction?: NextAction;
  readonly failureRef?: string;
}

export interface MergeCoordinatorPort {
  merge(input: MergeCoordinatorInput): Promise<MergeOutcome>;
}

export type OrchestrationFeedbackEvent =
  | {
      readonly kind: 'work-result';
      readonly assignment: WorkAssignment;
      readonly result: WorkResult;
      readonly ownerId: string;
      readonly scope: ScopeRef;
      readonly evidenceRefs: readonly EvidenceRef[];
    }
  | {
      readonly kind: 'attention';
      readonly assignment: WorkAssignment;
      readonly attentionId: string;
      readonly ownerId: string;
      readonly reason: string;
      readonly nextAction: NextAction;
      readonly scope: ScopeRef;
      readonly evidenceRefs: readonly EvidenceRef[];
    }
  | {
      readonly kind: 'retry';
      readonly assignment: WorkAssignment;
      readonly nextAttempt: number;
      readonly ownerId: string;
      readonly reason: string;
      readonly scope: ScopeRef;
      readonly evidenceRefs: readonly EvidenceRef[];
    }
  | {
      readonly kind: 'review-feedback';
      readonly assignment: WorkAssignment;
      readonly reviewAssignment: ReviewAssignment;
      readonly reviewResult: ReviewResult;
      readonly ownerId: string;
      readonly scope: ScopeRef;
      readonly evidenceRefs: readonly EvidenceRef[];
    }
  | {
      readonly kind: 'merge-outcome';
      readonly assignment: WorkAssignment;
      readonly outcome: MergeOutcome;
      readonly ownerId: string;
      readonly scope: ScopeRef;
      readonly evidenceRefs: readonly EvidenceRef[];
    };

export interface OrchestrationFeedbackPort {
  publish(event: OrchestrationFeedbackEvent): Promise<void>;
}

export interface AssignmentKey {
  readonly assignmentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
}

export interface AssignmentRuntimeBinding {
  readonly runtimeId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly assignmentId: string;
  readonly executionEpoch: number;
}

export interface AssignmentStageNode {
  readonly nodeId: string;
  readonly taskId: TaskId;
  readonly parentNodeId: string | null;
  readonly state: AssignmentStatus;
  readonly assignmentKeys: readonly string[];
}

export interface AssignmentRecord {
  readonly key: AssignmentKey;
  readonly stageNodeId: string;
  readonly assignment: WorkAssignment;
  readonly status: AssignmentStatus;
  readonly ownerId: string;
  readonly agentId?: string;
  readonly runtimeBinding?: AssignmentRuntimeBinding;
  readonly result?: WorkResult;
  readonly reviewResults: readonly ReviewResult[];
  readonly reason: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AssignmentGraphSnapshot {
  readonly stages: readonly AssignmentStageNode[];
  readonly assignments: readonly AssignmentRecord[];
}

/**
 * Declares one dispatch as an I2 milestone review. The manager binds the
 * committed `MilestoneReviewResultRecord` to these exact facts and to the real
 * review assignment and delivery it produced.
 */
export interface MilestoneReviewBinding {
  readonly milestoneId: string;
  readonly cycleId: CycleId;
  /**
   * Task-level scope: the committed milestone review record binds a task, not a
   * cycle or operation. The shared contract validator re-checks this at commit.
   */
  readonly taskScope: ScopeRef & { readonly taskId: TaskId };
  readonly executionScope: ScopeRef;
  readonly planRevisionCommitRef: JournalCommitRef;
  readonly reviewerAgentId: string;
}

export interface DispatchInput {
  readonly stageNodeId: string;
  readonly assignment: WorkAssignment;
  readonly agentId: string;
  readonly scope: ScopeRef;
  /**
   * Optional executor bound to this dispatch only. The orchestration manager
   * still owns the graph, review gate, merge gate, and feedback path; this
   * override only selects which worker executes the bounded work.
   */
  readonly executionAgentOverride?: ExecutionAgentPort;
  /**
   * Optional reviewer bound to this dispatch only. The orchestration manager
   * still owns the graph, review gate, merge gate, and feedback path; this
   * override only selects which reviewer answers the bounded review.
   */
  readonly reviewAgentOverride?: ReviewAgentPort;
  readonly reviewKinds?: readonly ReviewKind[];
  /**
   * Produced subject bodies for the review gate. A missing, empty, or
   * body that differs from the produced artifact blocks before the reviewer
   * is invoked.
   */
  readonly reviewSubjects?: readonly {
    readonly ref: string;
    readonly body: string;
  }[];
  /**
   * Declares the review as an I2 milestone review. When present the manager
   * constructs a real reviewer instance and commits the milestone review result
   * (with an exact readback) before any graph acceptance, feedback, or gate.
   */
  readonly milestoneReview?: MilestoneReviewBinding;
}

export interface OrchestrationDispatchResult {
  readonly status: AssignmentStatus;
  readonly assignment: AssignmentRecord;
  readonly issue?: OrchestrationIssue;
  readonly remediation?: WorkAssignment;
  readonly reviewResults: readonly ReviewResult[];
  readonly mergeOutcome?: MergeOutcome;
  /** Committed milestone-review receipts, in review-assignment order. */
  readonly reviewCommitRefs?: readonly JournalCommitRef[];
}
