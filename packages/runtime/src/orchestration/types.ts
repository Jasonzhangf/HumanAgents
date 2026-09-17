import type {
  EvidenceRef,
  NextAction,
  ScopeRef,
  TaskId,
  WorkAssignment,
  WorkResult,
} from '../../../contracts/src/index.js';
import type {
  ReviewAssignment,
  ReviewKind,
  ReviewResult,
} from '../review/index.js';

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
}

export interface ExecutionAgentInput {
  readonly assignment: WorkAssignment;
  readonly agentId: string;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly lease: RuntimePoolLease;
  readonly scope: ScopeRef;
}

export interface ExecutionAgentPort {
  execute(input: ExecutionAgentInput): Promise<WorkResult | ExecutionDelivery>;
}

export interface ReviewAgentInput {
  readonly reviewAssignment: ReviewAssignment;
  readonly workerAssignment: WorkAssignment;
  readonly workerResult: WorkResult;
  readonly scope: ScopeRef;
}

export interface ReviewAgentPort {
  review(input: ReviewAgentInput): Promise<ReviewResult>;
}

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

export interface DispatchInput {
  readonly stageNodeId: string;
  readonly assignment: WorkAssignment;
  readonly agentId: string;
  readonly scope: ScopeRef;
  readonly reviewKinds?: readonly ReviewKind[];
  readonly reviewSubjectDigests?: readonly string[];
}

export interface OrchestrationDispatchResult {
  readonly status: AssignmentStatus;
  readonly assignment: AssignmentRecord;
  readonly issue?: OrchestrationIssue;
  readonly remediation?: WorkAssignment;
  readonly reviewResults: readonly ReviewResult[];
  readonly mergeOutcome?: MergeOutcome;
}
