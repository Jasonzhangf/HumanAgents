import type {
  JournalCommitRef,
  LifecycleState,
  NextAction,
  ScopeRef,
  StageResult,
  Task,
  TaskId,
} from '../../../contracts/src/index.js';

/**
 * One Runtime-assigned retained reentry duty.
 *
 * This is the frozen A4 conditional-reentry dependency type, adopted verbatim
 * from `packages/runtime/src/checkpoints/conditional-reentry.ts`. It records
 * only the Runtime owner's assignment of responsibility for an operation that
 * stays independent of the reentered turn; it is not a copy of Gateway
 * operation lifecycle.
 */
export interface RetainedReentryDuty {
  readonly operationRef: string;
  readonly owner: string;
}

/**
 * The Runtime-owned processing facts that the locked reentry reader cannot
 * derive from other durable owners. Every field comes from the actual Runtime
 * owner at the moment it accepts a transition. This is not a second state
 * machine and it never copies grant, Gateway control, full context, completion
 * results or P4 execution position.
 */
export interface RuntimeTaskProcessingState {
  /** Existing Runtime phase discriminant at the transition boundary. */
  readonly entryPhase: string;
  readonly nextAction: NextAction;
  readonly hardBlockers: readonly string[];
  readonly recoveryResponsibilityRef: string;
  readonly firstErrorRef?: string;
  readonly laterErrorRefs: readonly string[];
  readonly stages: readonly StageResult<unknown>[];
}

/**
 * One typed current-state transition of a Runtime task.
 *
 * `task` is the owner's actual current Task. `processing` is the owner's actual
 * accepted control transition. `retainedDuties` are the owner's actual retained
 * responsibility assignments. `sourceCommitRefs` are the exact prior Journal
 * receipts this state was derived from; a first enrollment has none, and an
 * empty array there is the owner's known-empty fact rather than a placeholder.
 */
export interface RuntimeTaskCurrentState {
  readonly task: Task;
  readonly processing: RuntimeTaskProcessingState;
  readonly retainedDuties: readonly RetainedReentryDuty[];
  readonly sourceCommitRefs: readonly JournalCommitRef[];
  readonly currentPlan?: RuntimeTaskCurrentPlan;
}

/** Exact publication accepted by Runtime, rather than a selection from plan history. */
export interface RuntimeTaskCurrentPlan {
  readonly revisionId: string;
  readonly revisionCommitRef: JournalCommitRef;
}

/**
 * The actual logical-turn facts owned by the AgentLoop controller. The
 * coordinator consumes this narrow view instead of inferring a phase from a
 * Provider event, a display label or a snapshot.
 */
export interface RuntimeTaskTurnFacts {
  readonly phase: 'open' | 'recovering' | 'awaiting-planner-alignment' | 'aligned';
  readonly nextAction: NextAction;
  readonly ownerRef: string;
  readonly recoveryResponsibilityRef?: string;
  readonly firstErrorRef?: string;
  readonly laterErrorRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
}

/**
 * The actual stage facts owned by the native-save/boundary owner. `unknown` is
 * explicit: the coordinator never converts a missing owner read into `[]`.
 */
export type RuntimeTaskStageFacts =
  | {
      readonly state: 'known';
      readonly stages: readonly StageResult<unknown>[];
    }
  | {
      readonly state: 'unknown';
      readonly reason: string;
    };

/**
 * Owner facts required when a current-state transition belongs to an actual
 * execution. The source is supplied by the composition that holds the real
 * AgentLoop runtime and native-save progress owner.
 */
export interface RuntimeTaskCurrentStateFacts {
  readonly turn: RuntimeTaskTurnFacts;
  readonly stages: RuntimeTaskStageFacts;
  readonly currentPlan?: RuntimeTaskCurrentPlan;
}

export type RuntimeTaskCurrentStateFactsRead =
  | {
      readonly state: 'known';
      readonly value: RuntimeTaskCurrentStateFacts;
    }
  | {
      readonly state: 'unknown';
      readonly reason: string;
    };

export interface RuntimeTaskCurrentStateFactsPort {
  read(input: {
    readonly taskId: TaskId;
    readonly scope: ScopeRef;
    readonly executionEpoch?: number;
  }): Promise<RuntimeTaskCurrentStateFactsRead>;
}

export interface RuntimeTaskCurrentStateTransition {
  readonly transitionId: string;
  readonly taskScope: ScopeRef;
  /**
   * The exact current-state receipt this transition supersedes, or `null` when
   * the task has no committed current state yet. The codec rejects a transition
   * whose expected predecessor no longer matches the committed record.
   */
  readonly expectedStateCommitRef: JournalCommitRef | null;
  readonly state: RuntimeTaskCurrentState;
}

export type RuntimeTaskCurrentStateRead =
  | {
      readonly state: 'known';
      readonly value: RuntimeTaskCurrentState;
      readonly stateCommitRef: JournalCommitRef;
      /** The original committed record scope, exposed by the serialization owner. */
      readonly scope: ScopeRef;
    }
  | { readonly state: 'unknown'; readonly reason: string };

/**
 * The committed Task lifecycle one cold read must project. It is selected by
 * the single Runtime rule below, never assembled at a call site. The two
 * variants keep the accepted current-state payload only where it applies, so
 * a checkpoint-only read has no state payload to read by mistake.
 */
export type RuntimeTaskCurrentStateSelection =
  | {
      /** A committed current-state follows the checkpoint and is authoritative. */
      readonly basis: 'terminal';
      readonly lifecycle: LifecycleState;
      readonly currentState: RuntimeTaskCurrentState;
    }
  | {
      /** No applicable record; the existing checkpoint outcome stays authoritative. */
      readonly basis: 'checkpoint-only';
      readonly lifecycle: LifecycleState;
    };

function sameScopedValue(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left !== undefined && right !== undefined
    && left.scope === right.scope && left.value === right.value;
}

/**
 * One common Runtime read-only rule: reconcile the latest committed Task
 * current-state against the latest committed checkpoint. Both are typed facts
 * from the same Organ Journal at different phases, not parallel state sources.
 *
 * Selection rules, in order:
 * 1. A current-state that does not belong to this task, or that carries a
 *    different scope than the retained execution scope, is not applicable.
 *    Another operation's success never overrides the current execution.
 * 2. Journal sequence decides precedence. A current-state that precedes the
 *    latest checkpoint never overrides a newer checkpoint.
 * 3. An applicable current-state that follows the checkpoint supplies the Task
 *    lifecycle and the accepted current plan. The business checkpoint itself
 *    stays intact as the turn-close fact.
 * 4. An absent or inapplicable current-state keeps the checkpoint rule. This
 *    covers checkpoint-only histories.
 * 5. A failed current-state read is an explicit failure with its own reason,
 *    never a silent fall back to waiting or succeeded.
 */
export function selectRuntimeTaskCurrentState(input: {
  readonly checkpointOutcome: LifecycleState;
  readonly scope: ScopeRef;
  readonly checkpointCommitRef: JournalCommitRef;
  readonly currentState: RuntimeTaskCurrentStateRead;
}): RuntimeTaskCurrentStateSelection {
  if (input.currentState.state !== 'known') {
    return { basis: 'checkpoint-only', lifecycle: input.checkpointOutcome };
  }
  const owner = input.currentState.value;
  const sameExecutionScope = sameScopedValue(input.currentState.scope.organId, input.scope.organId)
    && sameScopedValue(input.currentState.scope.taskId, input.scope.taskId)
    && sameScopedValue(input.currentState.scope.cycleId, input.scope.cycleId)
    && sameScopedValue(input.currentState.scope.operationId, input.scope.operationId);
  if (!sameExecutionScope) {
    return { basis: 'checkpoint-only', lifecycle: input.checkpointOutcome };
  }
  if (input.currentState.stateCommitRef.journalSeq <= input.checkpointCommitRef.journalSeq) {
    return { basis: 'checkpoint-only', lifecycle: input.checkpointOutcome };
  }
  return { basis: 'terminal', lifecycle: owner.task.state as LifecycleState, currentState: owner };
}

/**
 * The Runtime serialization boundary. The implementation commits the transition
 * to the existing Organ Journal and resolves only after the durable record is
 * read back exactly. A failed append must reject and leave the prior committed
 * state and recovery responsibility untouched. `read` lets a cold coordinator
 * recover the exact committed predecessor receipt instead of assuming none.
 */
export interface RuntimeTaskCurrentStatePort {
  commit(input: RuntimeTaskCurrentStateTransition): Promise<JournalCommitRef>;
  read(taskScope: ScopeRef): Promise<RuntimeTaskCurrentStateRead>;
}
