import type { ContextView } from './agent-loop.js';
import type { JournalCommitRef } from './i2-history.js';
import type { ScopeRef } from './index.js';

/**
 * Task-bound correction scope. Both organ and task identity are required: one
 * correction never spans organs or tasks.
 */
export type CorrectionTaskScope = Readonly<{
  organId: ScopeRef['organId'];
  taskId: NonNullable<ScopeRef['taskId']>;
}>;

/**
 * One opaque Context business ref bound to its owning Task. `ref` is the exact
 * `ContextView.activeRefs` string. No path, prefix, descendant or normalization
 * meaning applies to it.
 */
export type ContextCorrectionRef = Readonly<{
  taskScope: CorrectionTaskScope;
  ref: ContextView['activeRefs'][number];
}>;

/** Owner-resolved source checkpoint the user pointed at. */
export interface CorrectionSourceFacts {
  readonly taskScope: CorrectionTaskScope;
  readonly checkpointReceipt: JournalCommitRef;
}

/** Owner-resolved authoritative current position. */
export interface CorrectionCurrentFacts {
  readonly taskScope: CorrectionTaskScope;
  readonly controlReceipt: JournalCommitRef;
  readonly contextReceipt: JournalCommitRef;
  readonly executionEpoch: number;
}

/**
 * Confirmed command facts plus the owner-resolved source, current, requested
 * wrong-ref and committed business-ref facts. Core only checks consistency
 * between these facts. The C4 owner supplies them after authoritative
 * resolution; Core cannot infer a Task or commit from an arbitrary string.
 */
export interface ContextCorrectionBasisFacts {
  readonly commandId: string;
  readonly taskScope: CorrectionTaskScope;
  readonly sourceCheckpointReceipt: JournalCommitRef;
  readonly expectedControlReceipt: JournalCommitRef;
  readonly expectedContextReceipt: JournalCommitRef;
  readonly expectedExecutionEpoch: number;
  readonly repairText: string;
  readonly confirmationRef: string;
  readonly principalOwner: string;
  readonly source: CorrectionSourceFacts;
  readonly current: CorrectionCurrentFacts;
  readonly wrongRefs: readonly ContextCorrectionRef[];
  /** Exact owner-resolved committed business refs that can confirm requested wrong refs. */
  readonly resolvedBusinessRefs: readonly ContextCorrectionRef[];
}

/**
 * Immutable accepted-exclusion basis. It keeps the confirmed command facts and the
 * exact wrong refs the user confirmed, including refs that are legitimately
 * inactive at confirmation time. It is not durable acceptance: the C4 owner
 * commits it before it becomes production truth. It carries no grant, operation
 * control, permission revision or fabricated receipt.
 */
export interface ConfirmedContextCorrectionBasis {
  readonly commandId: string;
  readonly taskScope: CorrectionTaskScope;
  readonly sourceCheckpointReceipt: JournalCommitRef;
  readonly expectedControlReceipt: JournalCommitRef;
  readonly expectedContextReceipt: JournalCommitRef;
  readonly expectedExecutionEpoch: number;
  readonly wrongRefs: readonly ContextCorrectionRef[];
  readonly repairText: string;
  readonly confirmationRef: string;
  readonly principalOwner: string;
}
