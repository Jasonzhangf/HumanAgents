export const AGENT_IO_PROTOCOL_VERSION = 1 as const;

export type AgentIoProviderProtocol = 'responses' | 'anthropic' | 'openai' | 'other-explicit';

export interface AgentIoProviderBinding {
  readonly bindingId: string;
  readonly providerId: string;
  readonly protocol: AgentIoProviderProtocol;
  readonly endpointRef: string;
  readonly modelRef: string;
  readonly configDigest: string;
  readonly capabilityDigest: string;
  readonly owner: string;
}

export type AgentIoBinding =
  | {
      readonly kind: 'interaction';
      readonly interactionScopeId: string;
      readonly bindingFingerprint: string;
      readonly provider: AgentIoProviderBinding;
    }
  | {
      readonly kind: 'task';
      readonly taskId: string;
      readonly assignmentId: string;
      readonly executionEpoch: number;
      readonly bindingFingerprint: string;
      readonly provider: AgentIoProviderBinding;
    };

export type AgentIoReplyMode = 'terminal' | 'stream';

export interface AgentIoRequestControl {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly attemptId: string;
  readonly binding: AgentIoBinding;
  readonly contextViewRef: string;
  readonly permissionRevision: string;
  readonly idempotencyKey: string;
  readonly replyMode: AgentIoReplyMode;
}

export interface AgentIoRequestData {
  readonly inputRefs: readonly string[];
  readonly outputContractRef: string;
  readonly capabilitySetRef: string;
  readonly memoryRecallRefs?: readonly string[];
}

export type ControlDisposition =
  | 'continue'
  | 'checkpoint-proposed'
  | 'waiting-user'
  | 'waiting-operation'
  | 'blocked'
  | 'failed'
  | 'completion-proposed'
  | 'stop-ack';

export interface AgentControlBlock {
  readonly summary?: string;
  readonly schemaVersion?: 1;
  readonly turnRef?: string;
  readonly phase?: string;
  readonly disposition?: ControlDisposition;
  readonly goal?: {
    readonly status: 'in-progress' | 'complete' | 'blocked' | 'unknown';
    readonly evidenceRefs?: string[];
    readonly missing?: string[];
  };
  readonly blocked?: {
    readonly reason: string;
    readonly owner?: string;
    readonly resumeCondition?: string;
  };
  readonly next?: {
    readonly kind: 'reason' | 'tool' | 'wait' | 'ask-user' | 'review' | 'stop' | 'close';
    readonly objective: string;
  };
  readonly checkpoint?: {
    readonly disposition: 'none' | 'propose' | 'waiting' | 'blocked';
    readonly checkpointRef?: string;
    readonly evidenceRefs?: string[];
  };
  readonly completion?: {
    readonly deliverableRefs: string[];
    readonly evidenceRefs: string[];
    readonly acceptanceRefs?: string[];
  };
  readonly memory?: {
    readonly learned: ReadonlyArray<{
      readonly kind: 'fact' | 'lesson' | 'dead-end' | 'preference' | 'skill-candidate';
      readonly title: string;
      readonly summary: string;
      readonly sourceRefs?: string[];
      readonly tags?: string[];
    }>;
  };
  readonly repair?: {
    readonly target: string;
    readonly reason: string;
    readonly requestedFields: string[];
  };
}

export type ControlDecodeStatus =
  | 'valid'
  | 'partial'
  | 'missing'
  | 'malformed'
  | 'multiple-conflicting';

export interface ControlDecodeResult {
  readonly status: ControlDecodeStatus;
  readonly sourceRef: string;
  readonly block?: Readonly<Partial<AgentControlBlock>>;
  readonly completeness: 'complete' | 'partial' | 'absent';
  readonly absentFields: readonly string[];
  readonly diagnostics: readonly string[];
  readonly partialRaw?: string;
  readonly rejectedBindings?: readonly string[];
}

export type AgentIoRequestStatus =
  | 'created'
  | 'admitted'
  | 'dispatched'
  | 'running'
  | 'repairing'
  | 'settled'
  | 'failed'
  | 'incomplete'
  | 'unknown';

export type AgentIoAttemptStatus =
  | 'accepted'
  | 'running'
  | 'repairing'
  | 'ended'
  | 'failed'
  | 'unknown';

export type AgentIoClosureStatus =
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'protocol-noncompliant';

export interface AgentIoClosure {
  readonly status: AgentIoClosureStatus;
  readonly reason: string;
  readonly ownerId: string;
  readonly evidenceRefs: readonly string[];
  readonly nextAction?: string;
}

export interface AgentIoAttempt {
  readonly attemptId: string;
  readonly status: AgentIoAttemptStatus;
  readonly repairOrdinal: number;
  readonly turnNumber: number;
  readonly startedAtMs: number;
  readonly lastActivityAtMs: number;
  readonly lastProgressAtMs: number;
  readonly latestSourceRef?: string;
  readonly latestCursor?: string;
}

export interface AgentIoRequest {
  readonly requestId: string;
  readonly attemptId: string;
  readonly control: AgentIoRequestControl;
  readonly data: AgentIoRequestData;
  readonly status: AgentIoRequestStatus;
  readonly attempt: AgentIoAttempt;
  readonly totalTurns: number;
  readonly noProgressTurns: number;
  readonly controlRepairAttempts: number;
  readonly closed: boolean;
}

export interface AgentIoBudgetRecord {
  readonly totalTurns: number;
  readonly noProgressTurns: number;
  readonly controlRepairAttempts: number;
  readonly restartCount: number;
}

export interface AgentIoRestartBudgetStore {
  read(requestId: string): Promise<AgentIoBudgetRecord | null>;
  write(requestId: string, record: AgentIoBudgetRecord): Promise<void>;
}

export interface AgentIoPolicy {
  readonly maxSilentDurationMs: number;
  readonly maxTurnDurationMs: number;
  readonly maxTotalTurns: number;
  readonly maxTurnsBetweenProbes: number;
  readonly maxNoProgressTurns: number;
  readonly maxControlRepairAttempts: number;
  readonly restartBudget: number;
  readonly noProgressAtMs?: number;
}

export const DEFAULT_AGENT_IO_POLICY: AgentIoPolicy = {
  maxSilentDurationMs: 30_000,
  maxTurnDurationMs: 120_000,
  maxTotalTurns: 32,
  maxTurnsBetweenProbes: 8,
  maxNoProgressTurns: 4,
  maxControlRepairAttempts: 3,
  restartBudget: 2,
  noProgressAtMs: 90_000,
};

export interface AgentIoClock {
  readonly now: () => number;
}

export interface AgentIoError {
  readonly code: string;
  readonly message: string;
  readonly ownerId: string;
  readonly retryable: boolean;
  readonly nextAction?: string;
}
