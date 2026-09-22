import type {
  EvidenceRef,
  LifecycleState,
  TaskId,
  TaskOutput,
} from '@humanagent/contracts';

export type UiSurfaceState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'running'
  | 'partial'
  | 'waiting'
  | 'degraded'
  | 'error'
  | 'permission'
  | 'cancelled'
  | 'stopped'
  | 'stale'
  | 'disconnected';

export interface UiDataSource {
  readonly state: UiSurfaceState;
  readonly label: string;
  readonly detail?: string;
  readonly updatedAt?: string;
}

export interface TaskRowProjection {
  readonly taskId: TaskId;
  readonly title: string;
  readonly state: LifecycleState;
  readonly stateLabel: string;
  readonly summary: string;
  readonly currentWork?: string;
  readonly progress?: string;
  readonly nextStep?: string;
  readonly updatedAt?: string;
  readonly evidenceCount: number;
  readonly entry: 'task-detail' | 'task-dashboard' | 'task-history';
}

export interface DecisionProjection {
  readonly taskId: TaskId;
  readonly title: string;
  readonly stateLabel: string;
  readonly situation: string;
  readonly proposal: string;
  readonly options: readonly string[];
  readonly customInputAllowed: boolean;
  readonly updatedAt?: string;
  readonly entry: 'task-detail';
}

export interface RecentInputProjection {
  readonly source: 'human' | 'task' | 'notification' | 'agent';
  readonly sourceLabel: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly taskRef?: TaskId;
  readonly status?: string;
}

export interface DashboardSummaryProjection {
  readonly pending: number;
  readonly running: number;
  readonly recentInputs: number;
  readonly history: number;
}

export interface DashboardProjection {
  readonly surface: 'dashboard';
  readonly state: UiSurfaceState;
  readonly data: UiDataSource;
  readonly summary: DashboardSummaryProjection;
  readonly pendingItems: readonly DecisionProjection[];
  readonly runningItems: readonly TaskRowProjection[];
  readonly recentInputs: readonly RecentInputProjection[];
  readonly historyItems: readonly TaskRowProjection[];
}

export interface TaskListProjection {
  readonly surface: 'task-list';
  readonly state: UiSurfaceState;
  readonly data: UiDataSource;
  readonly current: readonly TaskRowProjection[];
  readonly decisions: readonly DecisionProjection[];
  readonly history: readonly TaskRowProjection[];
  readonly counts: { readonly current: number; readonly decisions: number; readonly history: number };
}

export interface TaskDetailDecisionProjection {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
}

export interface TaskOutputProjection {
  readonly state: string;
  readonly summary: string;
  readonly artifacts: readonly string[];
}

export interface MemorySummaryProjection {
  readonly summary: string;
  readonly evidenceCount: number;
  readonly candidateCount: number;
  readonly reviewRequired: boolean;
}

export interface TaskDetailProjection {
  readonly surface: 'task-detail';
  readonly taskId: TaskId;
  readonly title: string;
  readonly state: UiSurfaceState;
  readonly data: UiDataSource;
  readonly currentState: string;
  readonly priorInput: string;
  readonly investigation: readonly string[];
  readonly proposal: string;
  readonly nextAction: string;
  readonly requiredDecisions: readonly TaskDetailDecisionProjection[];
  readonly customInputAllowed: boolean;
  readonly output?: TaskOutputProjection;
  readonly observationRef: string;
  readonly memorySummary?: MemorySummaryProjection;
}

export type AgentRoleDisplay =
  | 'interaction'
  | 'orchestration'
  | 'execution'
  | 'review'
  | 'memory';

export type PipelineNodeToolStepStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';

export interface PipelineNodeToolStepProjection {
  readonly stepId: string;
  readonly name: string;
  readonly status: PipelineNodeToolStepStatus;
  readonly statusDisplay: string;
  readonly returned: string;
  readonly occurredAt?: string;
}

export interface PipelineNodeActivityProjection {
  readonly activityRef: string;
  readonly summary: string;
  readonly occurredAt?: string;
}

export interface PipelineNodeProjection {
  readonly nodeId: string;
  readonly title: string;
  readonly kindDisplay: string;
  readonly ownerAgentRole: AgentRoleDisplay | 'unknown';
  readonly roleDisplay: string;
  readonly stateDisplay: string;
  readonly iteration: number;
  readonly activity: readonly PipelineNodeActivityProjection[];
  readonly summary: string;
  readonly updatedAt?: string;
  readonly toolSteps: readonly PipelineNodeToolStepProjection[];
}

export interface AgentOwnershipFrameProjection {
  readonly agentId: string;
  readonly role: AgentRoleDisplay | 'unknown';
  readonly roleDisplay: string;
  readonly stateDisplay: string;
  readonly iteration: number;
  readonly nodeIds: readonly string[];
}

export interface AgentHandoffProjection {
  readonly handoffId: string;
  readonly fromAgentId: string;
  readonly fromRole: AgentRoleDisplay | 'unknown';
  readonly fromRoleDisplay: string;
  readonly toAgentId: string;
  readonly toRole: AgentRoleDisplay | 'unknown';
  readonly toRoleDisplay: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly carrySummary: string;
  readonly payloadPreview: string;
  readonly notCarried: string;
  readonly occurredAt?: string;
}

export interface AgentWorkCardProjection {
  readonly agentId: string;
  readonly role: AgentRoleDisplay;
  readonly roleDisplay: string;
  readonly title: string;
  readonly statusDisplay: string;
  readonly current: string;
  readonly past: string;
  readonly next: string;
  readonly needsUser: boolean;
  readonly needsUserSummary?: string;
  readonly inputPreview: string;
  readonly outputPreview: string;
  readonly updatedAt?: string;
  readonly processRef?: string;
}

export interface TaskFeedbackProjection {
  readonly required: boolean;
  readonly summary?: string;
  readonly entry?: 'task-detail';
}

export type ExecutionStepKind = 'input' | 'tool-call' | 'tool-result' | 'output' | 'terminal';

export interface TaskExecutionStepProjection {
  readonly stepId: string;
  readonly kind: ExecutionStepKind;
  readonly summary: string;
  readonly refs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AgentCheckpointProjection {
  readonly checkpointId: string;
  readonly executionEpoch: number;
  readonly outcome: LifecycleState;
  readonly ref: string;
}

export interface StopRecoveryProjection {
  readonly mode: 'running' | 'recovering' | 'stopped';
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type AgentRuntimePoolState = 'available' | 'starting' | 'idle' | 'bound' | 'executing' | 'settling' | 'stopped' | 'failed';

export interface AgentRuntimePoolEntryProjection {
  readonly runtimeId: string;
  readonly agentId?: string;
  readonly role: AgentRoleDisplay;
  readonly state: AgentRuntimePoolState;
  readonly stateDisplay: string;
  readonly currentAssignmentId?: string;
  readonly executionEpoch?: number;
  readonly resourceSummary: string;
  readonly updatedAt?: string;
}

export interface AgentRuntimePoolProjection {
  readonly available: number;
  readonly active: number;
  readonly runtimes: readonly AgentRuntimePoolEntryProjection[];
}

export type AssignmentStatus = 'waiting' | 'running' | 'succeeded' | 'failed' | 'incomplete' | 'blocked' | 'cancelled' | 'stale';

export interface AssignmentProjection {
  readonly assignmentId: string;
  readonly pipelineNodeId: string;
  readonly agentId: string;
  readonly role: AgentRoleDisplay;
  readonly status: AssignmentStatus;
  readonly statusDisplay: string;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly inputRevision: number;
  readonly objective: string;
  readonly targetRefs: readonly string[];
  readonly inputPreview: string;
  readonly outputPreview: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly nextAction?: string;
  readonly conditionRef?: string;
  readonly failureRef?: string;
  readonly parentAssignmentId?: string;
  readonly reviewRequired: boolean;
  readonly mergeGate: 'required' | 'not-required';
  readonly updatedAt?: string;
}

export type AgentFeedbackKind = 'work-result' | 'attention' | 'resource' | 'review' | 'memory' | 'reconcile';
export type AgentFeedbackState = 'open' | 'recovering' | 'resolved' | 'stale' | 'blocked';

export interface AgentFeedbackProjection {
  readonly feedbackId: string;
  readonly kind: AgentFeedbackKind;
  readonly state: AgentFeedbackState;
  readonly stateDisplay: string;
  readonly severity?: 'info' | 'attention' | 'blocker';
  readonly summary: string;
  readonly ownerId?: string;
  readonly nextAction?: string;
  readonly assignmentId?: string;
  readonly conditionRef?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly occurredAt?: string;
  readonly requiresUser: boolean;
}

export interface AssignmentReconcileProjection {
  readonly state: 'not-required' | 'required' | 'reconciling' | 'resolved' | 'blocked' | 'stale';
  readonly stateDisplay: string;
  readonly summary: string;
  readonly ownerId: string;
  readonly operationRef?: string;
  readonly nextAction: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface TaskDashboardProjection {
  readonly surface: 'task-dashboard';
  readonly taskId: TaskId;
  readonly state: UiSurfaceState;
  readonly data: UiDataSource;
  readonly taskTitle: string;
  readonly userInput: string;
  readonly objective: string;
  readonly currentStatus: string;
  readonly agentCards: readonly AgentWorkCardProjection[];
  readonly runtimePool: AgentRuntimePoolProjection;
  readonly assignments: readonly AssignmentProjection[];
  readonly agentFeedback: readonly AgentFeedbackProjection[];
  readonly feedback: TaskFeedbackProjection;
  readonly reconcile?: AssignmentReconcileProjection;
  readonly executionSteps: readonly TaskExecutionStepProjection[];
  readonly checkpoint?: AgentCheckpointProjection;
  readonly stopRecovery?: StopRecoveryProjection;
  readonly observationRef?: string;
}

export interface PipelineNodeViewProjection {
  readonly nodeId: string;
  readonly title: string;
  readonly kindDisplay: string;
  readonly state: LifecycleState;
  readonly stateDisplay: string;
  readonly summary: string;
  readonly owner: string;
  readonly updatedAt?: string;
  readonly hasChildScope: boolean;
  readonly evidenceCount: number;
}

export interface NodePreviewProjection {
  readonly ref: string;
  readonly label: string;
}

export interface ObservationNodeDetailProjection {
  readonly nodeId: string;
  readonly title: string;
  readonly kindDisplay: string;
  readonly stateDisplay: string;
  readonly owner: string;
  readonly updatedAt?: string;
  readonly summary: string;
  readonly inputs: readonly NodePreviewProjection[];
  readonly outputs: readonly NodePreviewProjection[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly childScopeRef?: string;
  readonly assignment?: AssignmentProjection;
  readonly feedback: readonly AgentFeedbackProjection[];
  readonly reconcile?: AssignmentReconcileProjection;
}

export interface ObservationScopeProjection {
  readonly scopeRef: string;
  readonly title: string;
  readonly summary: string;
  readonly projectionSeq: string;
  readonly nodes: readonly PipelineNodeViewProjection[];
  readonly breadcrumbs: readonly { readonly ref: string; readonly title: string }[];
  readonly canReturn: boolean;
}

export interface ObservationPresentationRules {
  readonly keyboardFocus: readonly string[];
  readonly narrowWidth: readonly string[];
  readonly mobileOrder: 'single-column';
  readonly drawer: 'read-only-modal';
  readonly readOnly: true;
}

export interface PipelineObservationProjection {
  readonly currentNode?: PipelineNodeProjection;
  readonly nodes: readonly PipelineNodeProjection[];
  readonly agentFrames: readonly AgentOwnershipFrameProjection[];
  readonly handoffs: readonly AgentHandoffProjection[];
  readonly surface: 'observation';
  readonly state: UiSurfaceState;
  readonly data: UiDataSource;
  readonly scope: ObservationScopeProjection;
  readonly selectedNode?: ObservationNodeDetailProjection;
  readonly rules: ObservationPresentationRules;
}

export interface MemoryEntryProjection {
  readonly id: string;
  readonly sourceRef: string;
  readonly scope: string;
  readonly summary: string;
  readonly digest: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface MemoryDetailProjection {
  readonly sourceRef: string;
  readonly text: string;
}

export interface MemoryComparisonProjection {
  readonly leftRef: string;
  readonly rightRef: string;
  readonly relation: string;
  readonly reason?: string;
}

export interface SkillCandidateProjection {
  readonly candidateId: string;
  readonly pattern: string;
  readonly proposedRule: string;
  readonly uniqueness: string;
  readonly repeatability: string;
  readonly value: string;
  readonly state: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly namespace: 'project' | 'global';
  readonly projectKey: string;
  readonly taskId?: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
}

export interface MemoryAnalysisProjection {
  readonly mode: 'model' | 'deterministic';
  readonly state: 'idle' | 'running' | 'succeeded' | 'waiting' | 'failed' | 'unknown';
  readonly operationRef?: string;
  readonly failureRef?: string;
}

export interface MemoryInteractionSurfaceProjection {
  readonly surface: 'memory-interaction';
  readonly state: UiSurfaceState;
  readonly data: UiDataSource;
  readonly scope: string;
  readonly summary: string;
  readonly indexState: string;
  readonly entries: readonly MemoryEntryProjection[];
  readonly selectedDetail?: MemoryDetailProjection;
  readonly comparison?: MemoryComparisonProjection;
  readonly skillCandidates: readonly SkillCandidateProjection[];
  readonly reviewRequired: boolean;
  readonly inspectEnabled: boolean;
  readonly compareEnabled: boolean;
  readonly analysis: MemoryAnalysisProjection;
  readonly autoUpdate: boolean;
}

export type UiProjection =
  | DashboardProjection
  | TaskListProjection
  | TaskDetailProjection
  | TaskDashboardProjection
  | PipelineObservationProjection
  | MemoryInteractionSurfaceProjection;

export class UiProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiProjectionError';
  }
}

export function fromTaskOutput(output?: TaskOutput): TaskOutputProjection | undefined {
  if (!output) return undefined;
  return {
    state: output.state,
    summary: output.summary,
    artifacts: output.artifactRefs,
  };
}
