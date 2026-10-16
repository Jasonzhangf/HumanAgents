import type {
  AdmittedTurnIdentity,
  Checkpoint,
  CheckpointSource,
  CheckpointTimeAuthorityMetadata,
  CycleId,
  EvidenceRef,
  NextAction,
  RawAsset,
} from '../../contracts/src/index.js';

import type { RuntimeCommitRefProjection, RuntimeReadScope } from './runtime.js';

/**
 * Read-only checkpoint-history projection. Every identity here comes from an actual committed
 * Journal record or an owner-provided current-position resolver. The projection never derives the
 * current position from the history list and never treats a viewed selection as current.
 */
export interface RuntimeCheckpointIdentityProjection {
  readonly checkpointId: Checkpoint['id'];
  readonly seq: number;
  readonly previousCheckpointId: Checkpoint['previousCheckpointId'];
  readonly cycleId: CycleId;
  readonly directiveRevision: number;
  /** The checkpoint's own commit-time execution epoch; not the reentry effective epoch. */
  readonly originalExecutionEpoch: number;
  readonly outcome: Checkpoint['outcome'];
  readonly summary: string;
  readonly next: NextAction;
  readonly recoveryStateRef: EvidenceRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Full physical Journal receipt. Never a synthetic, truncated or re-derived ref. */
  readonly commitRef: RuntimeCommitRefProjection;
  /** Trusted Harness commit instant from the exact native receipt. Absent when no native receipt exists. */
  readonly committedAt?: string;
  readonly timeAuthority?: CheckpointTimeAuthorityMetadata;
  /** Why trusted time is absent; absence is expected for legacy records and is never guessed. */
  readonly committedAtUnavailableReason?: string;
}

/** Authoritative execution position from typed committed control facts. */
export interface RuntimeCheckpointPositionProjection {
  readonly checkpointCommitRef: RuntimeCommitRefProjection;
  readonly contextCommitRef: RuntimeCommitRefProjection;
  readonly controlCommitRef: RuntimeCommitRefProjection;
  /** Effective control epoch after committed reentry; independent of the viewed checkpoint epoch. */
  readonly effectiveExecutionEpoch: number;
}

export interface RuntimeCheckpointCoreClosureProjection {
  readonly source: CheckpointSource;
  readonly closureReason: string;
  readonly executionEpoch: number;
  readonly committed: boolean;
  readonly reentryAllowed: boolean;
  readonly pendingOperations: readonly string[];
  readonly unknownOperations: readonly string[];
  readonly recoveryStateRef: EvidenceRef;
  readonly nextAction: NextAction;
  readonly closedAt: string;
}

export interface RuntimeCheckpointRecoveryBindingProjection {
  readonly checkpointCommitRef: RuntimeCommitRefProjection;
  readonly contextCommitRef: RuntimeCommitRefProjection;
  readonly coreClosure: RuntimeCheckpointCoreClosureProjection;
  readonly preparationRef?: string;
  readonly turnRecoveryRef?: string;
  readonly turnClosureRef?: string;
  readonly alignmentRef?: string;
}

export interface RuntimeCheckpointContextProjection {
  readonly state: 'known';
  readonly agentRuntimeId: string;
  readonly contextViewRef: string;
  readonly contextDigest: string;
  readonly executionEpoch: number;
  readonly activeRefs: readonly string[];
  readonly omittedRefs: readonly string[];
  readonly durableContextDigest: string;
  readonly previousContextCommitRef: RuntimeCommitRefProjection | null;
  readonly loopCheckpoint: {
    readonly checkpointId: Checkpoint['id'];
    readonly sequence: number;
    readonly digest: string;
    readonly executionEpoch: number;
    readonly contextViewRef: string;
  };
  readonly loopControl: {
    readonly mode: 'observation' | 'orchestration';
    readonly transitionSeq: number;
    readonly observationScopeId: string;
  };
  readonly replacement: {
    readonly reason: 'observation' | 'compaction' | 'recovery';
    readonly fromContextViewRef: string;
    readonly toContextViewRef: string;
    readonly toContextDigest: string;
  } | null;
}

export type RuntimeCheckpointContextRead =
  | RuntimeCheckpointContextProjection
  | { readonly state: 'unavailable'; readonly reason: string };

export interface RuntimeCheckpointSemanticPhaseReceiptProjection {
  readonly phase: 'context-view' | 'history-publication';
  readonly commitIdentity: string;
  readonly journalReceiptRef: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
  readonly committedAt: string;
  readonly timeAuthority: CheckpointTimeAuthorityMetadata;
}

export interface RuntimeCheckpointAdoptedChildProjection {
  readonly invocationId: string;
  readonly childTurnId: string;
  readonly deliverySeq: number;
  readonly kind: 'execution' | 'review';
  /** Exact durable refined-delivery asset descriptor. Raw bytes stay with the asset owner. */
  readonly refinedDelivery: RawAsset;
  readonly preCallCheckpointRef: string;
  readonly postReviewCheckpointRef?: string;
  readonly segmentId?: string;
}

export interface RuntimeCheckpointSemanticRecoveryProjection {
  readonly recoveryStateRef: string;
  readonly recoveryResponsibilityRef: string;
  readonly unresolvedOperationRefs: readonly string[];
  readonly firstErrorRef?: string;
  readonly laterErrorRefs: readonly string[];
}

export interface RuntimeCheckpointCaptureRecoveryProjection {
  readonly recoveryResponsibilityRef: string;
  readonly unresolvedOperationRefs: readonly string[];
  readonly firstErrorRef?: string;
  readonly laterErrorRefs: readonly string[];
}

export interface RuntimeCheckpointSemanticProjection {
  readonly state: 'known';
  readonly version: 1 | 2;
  readonly turn: AdmittedTurnIdentity;
  readonly savedAt: string;
  readonly description: string;
  readonly semantics: {
    readonly goal: string;
    readonly actions: string;
    readonly result: string;
    readonly nextStep: string;
  };
  readonly save: {
    readonly checkpoint: {
      readonly commitIdentity: string;
      readonly checkpointRef: string;
      readonly journalReceiptRef: string;
      readonly journalSeq: number;
      readonly recordDigest: string;
      readonly committedAt: string;
      readonly timeAuthority: CheckpointTimeAuthorityMetadata;
    };
    readonly contextView: RuntimeCheckpointSemanticPhaseReceiptProjection;
    readonly historyPublication: RuntimeCheckpointSemanticPhaseReceiptProjection;
  };
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly adoptedChildren: readonly RuntimeCheckpointAdoptedChildProjection[];
  readonly recovery: RuntimeCheckpointSemanticRecoveryProjection;
  readonly segment?: {
    readonly segmentId: string;
    readonly openedCommitRef: RuntimeCommitRefProjection;
  };
}

export type RuntimeCheckpointSemanticRead =
  | RuntimeCheckpointSemanticProjection
  | { readonly state: 'unavailable'; readonly reason: string };

export interface RuntimeCheckpointCaptureProjection {
  readonly state: 'known';
  readonly turnRecoveryRef: string;
  /** Exact immutable recovery-capture asset descriptor. */
  readonly capture: RawAsset;
  readonly controlRecordCount: number;
  readonly recovery: RuntimeCheckpointCaptureRecoveryProjection;
}

export type RuntimeCheckpointCaptureRead =
  | RuntimeCheckpointCaptureProjection
  | { readonly state: 'unavailable'; readonly reason: string };

export interface RuntimeCheckpointDetailProjection {
  readonly identity: RuntimeCheckpointIdentityProjection;
  readonly recoveryBinding:
    | RuntimeCheckpointRecoveryBindingProjection
    | { readonly state: 'unavailable'; readonly reason: string };
  readonly context: RuntimeCheckpointContextRead;
  readonly semantic: RuntimeCheckpointSemanticRead;
  readonly capture: RuntimeCheckpointCaptureRead;
}

export type RuntimeCheckpointCurrentProjection =
  | {
      readonly state: 'known';
      readonly identity: RuntimeCheckpointIdentityProjection;
      readonly position: RuntimeCheckpointPositionProjection;
      readonly context: RuntimeCheckpointContextRead;
    }
  | { readonly state: 'unknown'; readonly reason: string };

export type RuntimeCheckpointFilter =
  | 'directiveRevision'
  | 'executionEpoch'
  | 'cycleId'
  | 'occurrenceRef';

export interface RuntimeCheckpointCapabilityProjection {
  readonly state: 'available' | 'unavailable';
  readonly reason?: string;
}

export interface RuntimeCheckpointReadProjection {
  readonly surface: 'runtime-checkpoint-history';
  readonly scope: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeCheckpointCurrentProjection;
  readonly viewed: RuntimeCheckpointDetailProjection | null;
  readonly checkpoints: readonly RuntimeCheckpointIdentityProjection[];
  readonly nextCursor?: string;
  readonly capabilities: Partial<Record<RuntimeCheckpointFilter, RuntimeCheckpointCapabilityProjection>>;
}
