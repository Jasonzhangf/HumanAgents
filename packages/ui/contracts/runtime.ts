import type { EvidenceRef, HealthState, LifecycleState, OrganId, TaskId } from '@humanagent/contracts';
import type { TaskDetailProjection } from './models.js';

export type { TaskDetailProjection };

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
  readonly waitingDecisionCount: number;
  readonly recentInputs: readonly RuntimeRecentInputProjection[];
  readonly recentOutputs: readonly RuntimeRecentOutputProjection[];
  readonly recentFailures: readonly RuntimeRecentFailureProjection[];
}

export interface RuntimeTaskRowProjection {
  readonly taskId: TaskId;
  readonly title: string;
  readonly state: LifecycleState;
  readonly stateLabel: string;
  readonly requirementQueue?: string;
  readonly requirementAdmission?: 'queued' | 'admitted' | 'executing' | 'completed' | 'blocked' | 'retired' | 'unknown';
  readonly requirementAdmissionLabel?: string;
  readonly currentState: string;
  readonly nextStep: string;
  readonly updatedAt: string;
  readonly entry: 'task-dashboard';
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
  readonly committedAt: string;
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
