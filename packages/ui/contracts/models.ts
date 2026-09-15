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

export interface AgentWorkCardProjection {
  readonly agentId: string;
  readonly role: AgentRoleDisplay;
  readonly roleDisplay: string;
  readonly title: string;
  readonly statusDisplay: string;
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
  readonly feedback: TaskFeedbackProjection;
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
}

export interface PipelineObservationProjection {
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
