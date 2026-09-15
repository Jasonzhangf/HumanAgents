import type {
  BusinessPayload,
  HealthState,
  NextAction,
  RequirementEnvelope,
  TaskId,
} from '../../../contracts/src/index.js';

export const ADMISSION_QUEUE_KINDS = ['interactive', 'execution', 'research', 'maintenance'] as const;
export type AdmissionQueueKind = (typeof ADMISSION_QUEUE_KINDS)[number];

export interface AdmissionQueueConfig {
  readonly kind: AdmissionQueueKind;
  readonly concurrencyLimit: number;
  readonly maxBacklog: number;
}

export interface QueueLoadSnapshot {
  readonly running: number;
  readonly queued: number;
}

export interface CheckpointRecoveryFacts {
  readonly recoverable: boolean;
  readonly conditionRef?: string;
}

export interface AdmissionCheckInput {
  readonly queue: AdmissionQueueConfig;
  readonly queueLoad: QueueLoadSnapshot;
  readonly requiredCapabilities: readonly string[];
  readonly availableCapabilities: readonly string[];
  readonly health: HealthState;
  readonly requiredInputRefs: readonly string[];
  readonly providedInputRefs: readonly string[];
  readonly checkpoint: CheckpointRecoveryFacts;
  readonly businessPayload?: BusinessPayload;
  readonly ownerId?: string;
}

export type AdmissionStatus = 'admitted' | 'waiting' | 'blocked';

export interface AdmissionDecision {
  readonly status: AdmissionStatus;
  readonly queue: AdmissionQueueKind;
  readonly ownerId: string;
  readonly condition: string;
  readonly nextAction: NextAction;
  readonly reason: string;
}

export interface ClassifiedRequirement {
  readonly envelope: RequirementEnvelope;
  readonly queue: AdmissionQueueKind;
}

export interface TaskRevision {
  readonly inputRevision: number;
  readonly taskId: TaskId;
  readonly envelope: RequirementEnvelope;
}

export interface TaskRevisionState {
  readonly taskId: TaskId;
  readonly revisions: readonly TaskRevision[];
}

export type TaskUpdateStatus = 'updated' | 'waiting' | 'blocked';

export interface TaskUpdateDecision {
  readonly status: TaskUpdateStatus;
  readonly taskId: TaskId;
  readonly task: TaskRevisionState;
  readonly revision: number;
  readonly ownerId: string;
  readonly condition?: string;
  readonly nextAction: NextAction;
  readonly reason: string;
}

export type OrchestrationRuntimeState = 'idle' | 'running' | 'spawning' | 'failed';

export interface OrchestrationRuntimeCandidate {
  readonly runtimeId: string;
  readonly state: OrchestrationRuntimeState;
  readonly capabilities: readonly string[];
  readonly currentBindings: number;
  readonly maxBindings: number;
}

export interface OrchestrationRuntimePoolSnapshot {
  readonly maxRuntimes: number;
  readonly runtimes: readonly OrchestrationRuntimeCandidate[];
}

export type OrchestrationPoolAction = 'reuse' | 'spawn' | 'wait' | 'blocked';

export interface OrchestrationPoolDecision {
  readonly action: OrchestrationPoolAction;
  readonly ownerId: string;
  readonly condition: string;
  readonly nextAction: NextAction;
  readonly reason: string;
  readonly runtimeId?: string;
}
