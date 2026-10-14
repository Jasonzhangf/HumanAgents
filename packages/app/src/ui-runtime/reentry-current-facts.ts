import type {
  ContextHistoryRecord,
  JournalCommitRef,
  NextAction,
  ScopeRef,
} from '../../../contracts/src/index.js';
import type { JournalRecord } from '../../../adapters/jsonl/src/index.js';
import { decodeActiveTurnRecords } from '../../../adapters/jsonl/src/active-turn.js';
import { activeTurnCommitId } from '../../../runtime/src/context/active-turn-journal.js';
import type { ExecutionPosition } from '../../../runtime/src/checkpoints/ports.js';
import type {
  ReentryCurrentFacts,
  ReentryCurrentRead,
  ReentryFence,
  RetainedReentryDuty,
} from '../../../runtime/src/checkpoints/conditional-reentry.js';
import { readRuntimeTaskCurrentStateFromRecords } from '../runtime-current-state-journal.js';
import { readOperationControlFromRecords } from '../operation-control-journal.js';
import {
  assertRecoveryBinding,
  closureFromRecord,
  conditionalReentryFromRecord,
  contextHistoryFromRecord,
  exactJournalRecord,
  foldExecutionPositionFromRecords,
} from '../checkpoint-journal.js';

/**
 * Pure locked composition of the existing `ReentryCurrentFacts` from verified
 * Organ Journal records.
 *
 * Every field comes from an actual owner decoder over the records the A4
 * transaction already holds:
 *
 * - Task / processing / retained duties: `readRuntimeTaskCurrentStateFromRecords`.
 * - Related position, exact full context and any committed conditional
 *   relation: `foldExecutionPositionFromRecords`, `exactJournalRecord`,
 *   `conditionalReentryFromRecord`, `contextHistoryFromRecord`.
 * - Current physical operation-control namespace: `readOperationControlFromRecords`,
 *   keyed by the canonical position's runtime and Harness execution epoch.
 * - Admitted active request/child obligations: `decodeActiveTurnRecords`.
 *
 * It is synchronous and never relocks, probes, drains, awaits a model or reads
 * an asset. A required source that is missing, unreadable or inconsistent
 * returns `unknown` with a concrete reason instead of a fabricated default.
 * There is deliberately no snapshot, UI-event, log or cached read, and no
 * `[]` placeholder: an empty obligation set is only ever the result of a
 * completed owner scan.
 */

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inTaskScope(scope: ScopeRef, taskScope: ScopeRef): boolean {
  return scope.organId.value === taskScope.organId.value
    && scope.taskId?.value === taskScope.taskId?.value;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

function journalCommitRef(record: JournalRecord): JournalCommitRef {
  if (!record.commitId) throw new Error('the current-state record has no commit identity');
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

/** The existing Runtime owner string form for a typed `NextAction`. */
function nextActionText(next: NextAction): string {
  return `${next.kind}${next.ref ? `:${next.ref}` : ''}`;
}

function incarnationOfContext(context: ContextHistoryRecord): ReentryFence {
  return {
    scope: context.scope,
    agentRuntimeId: context.agentRuntimeId,
    executionEpoch: context.loopCheckpoint.executionEpoch,
  };
}

function sameIncarnation(left: ReentryFence, right: ReentryFence): boolean {
  return left.agentRuntimeId === right.agentRuntimeId
    && left.executionEpoch === right.executionEpoch
    && sameScope(left.scope, right.scope);
}

/**
 * The committed base of the related execution position. It reuses the exact
 * rule the async canonical reader uses: the latest bound checkpoint closure in
 * the task scope supplies the anchor receipt, context and epoch, and
 * `foldExecutionPositionFromRecords` advances it over committed transitions.
 */
function baseExecutionPosition(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
): ExecutionPosition | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (!inTaskScope(record.scope, taskScope)) continue;
    const closure = closureFromRecord(record);
    if (closure === null || !('closureKind' in closure) || closure.closureKind !== 'checkpoint') continue;
    const binding = closure.recoveryBinding;
    if (binding === undefined) continue;
    assertRecoveryBinding(records, record, closure);
    return {
      checkpointCommitRef: binding.checkpointCommitRef,
      contextCommitRef: binding.contextCommitRef,
      executionEpoch: binding.coreClosure.executionEpoch,
      controlCommitRef: journalCommitRef(record),
    };
  }
  return null;
}

function contextOfPosition(
  records: readonly JournalRecord[],
  position: ExecutionPosition,
): ContextHistoryRecord | null {
  const record = exactJournalRecord(records, position.contextCommitRef);
  return conditionalReentryFromRecord(record)?.restoredContext
    ?? contextHistoryFromRecord(record);
}

/**
 * Affected incarnation fences come from real records: every committed
 * checkpoint closure in the task scope names the exact context incarnation it
 * bound, and the current related execution position names its own incarnation.
 * An independent runtime that produced no checkpoint closure is not fenced.
 */
function fencedBindings(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
  current: ContextHistoryRecord,
): readonly ReentryFence[] {
  const fences: ReentryFence[] = [incarnationOfContext(current)];
  for (const record of records) {
    if (!inTaskScope(record.scope, taskScope)) continue;
    const closure = closureFromRecord(record);
    if (closure === null || !('closureKind' in closure) || closure.closureKind !== 'checkpoint') continue;
    const binding = closure.recoveryBinding;
    if (binding === undefined) continue;
    const contextRecord = exactJournalRecord(records, binding.contextCommitRef);
    const context = conditionalReentryFromRecord(contextRecord)?.restoredContext
      ?? contextHistoryFromRecord(contextRecord);
    if (!context) continue;
    const fence = incarnationOfContext(context);
    if (!fences.some((existing) => sameIncarnation(existing, fence))) fences.push(fence);
  }
  return fences;
}

/**
 * Discovery of admitted active-turn identities from the codec's own committed
 * binding carrier. The identity is confirmed with the codec's exported
 * `activeTurnCommitId`; the record body is then validated by the owner decoder
 * `decodeActiveTurnRecords`. This only locates the turn id the owner decoder
 * requires; it does not re-implement record validation.
 */
function admittedTurnIds(records: readonly JournalRecord[]): readonly string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.kind !== 'event' || !record.commitId) continue;
    const payload = record.payload;
    if (!payload || payload['type'] !== 'active-turn.record') continue;
    const typed = payload['record'] as
      | { readonly kind?: unknown; readonly binding?: { readonly admittedTurn?: { readonly turnId?: unknown } } }
      | undefined;
    if (!typed || typed.kind !== 'binding-opened') continue;
    const turnId = typed.binding?.admittedTurn?.turnId;
    if (typeof turnId !== 'string' || !turnId.trim()) continue;
    if (record.commitId !== activeTurnCommitId(turnId, 'binding-opened')) continue;
    ids.add(turnId);
  }
  return [...ids];
}

function outstandingRequestPhase(phase: string): boolean {
  return phase === 'dispatching' || phase === 'dispatched' || phase === 'waiting';
}

/**
 * Actual admitted request/child obligations of the fenced incarnations. A
 * request is outstanding until it settles, fails or is cancelled; a child
 * invocation is outstanding until its result is adopted.
 */
function displacedObligationRefs(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
  fences: readonly ReentryFence[],
): readonly string[] {
  const refs: string[] = [];
  for (const turnId of admittedTurnIds(records)) {
    const turnRecords = decodeActiveTurnRecords(records, turnId);
    const opened = turnRecords.find((record) => record.kind === 'binding-opened');
    if (!opened || opened.kind !== 'binding-opened') continue;
    const binding = opened.binding;
    if (!inTaskScope(binding.scope, taskScope)) continue;
    const fenced = fences.some((fence) =>
      fence.agentRuntimeId === binding.execution.runtimeId
      && fence.executionEpoch === binding.execution.executionEpoch
      && sameScope(fence.scope, binding.scope));
    if (!fenced) continue;
    for (const record of turnRecords) {
      if (record.kind === 'request' && outstandingRequestPhase(record.record.phase)) {
        refs.push(record.record.request.requestId);
      }
      if (record.kind === 'child-invocation' && record.record.adoptedResultSeq === undefined) {
        refs.push(record.record.invocationId);
      }
    }
  }
  return [...new Set(refs)];
}

export function readCurrentFromRecords(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
): ReentryCurrentRead {
  try {
    const current = readRuntimeTaskCurrentStateFromRecords(records, taskScope);
    if (current.state !== 'known') return { state: 'unknown', reason: current.reason };

    const base = baseExecutionPosition(records, taskScope);
    if (base === null) {
      return {
        state: 'unknown',
        reason: 'no committed bound checkpoint closure establishes a related execution position for this task',
      };
    }
    const position = foldExecutionPositionFromRecords(records, taskScope, base);
    const context = contextOfPosition(records, position);
    if (context === null) {
      return {
        state: 'unknown',
        reason: 'the canonical execution position has no readable full context body',
      };
    }

    // The operation-control namespace is the exact physical (runtime, Harness
    // epoch) of the canonical execution position and its full context. A
    // task-wide read is ambiguous once a successor namespace exists, so select
    // the real current namespace and never fall back to first/latest.
    if (position.executionEpoch !== context.loopCheckpoint.executionEpoch) {
      return {
        state: 'unknown',
        reason: 'the canonical execution position and its full context disagree on the physical Harness execution epoch',
      };
    }
    const control = readOperationControlFromRecords(records, {
      scope: taskScope,
      agentRuntimeId: context.agentRuntimeId,
      harnessExecutionEpoch: position.executionEpoch,
    });
    if (control.state !== 'complete') {
      return { state: 'unknown', reason: `current physical operation control is unknown: ${control.reason}` };
    }

    const fences = fencedBindings(records, taskScope, context);
    const unresolvedDisplacedRefs = displacedObligationRefs(records, taskScope, fences);
    const retainedDuties: readonly RetainedReentryDuty[] = current.value.retainedDuties.map((duty) => ({
      operationRef: duty.operationRef,
      owner: duty.owner,
    }));

    const facts: ReentryCurrentFacts = {
      state: 'known',
      stateCommitRef: current.stateCommitRef,
      task: current.value.task,
      position,
      context,
      entryPhase: current.value.processing.entryPhase,
      nextAction: nextActionText(current.value.processing.nextAction),
      fencedBindings: fences,
      retainedDuties,
      unresolvedDisplacedRefs,
    };
    return facts;
  } catch (error) {
    return { state: 'unknown', reason: `locked current-facts composition failed: ${message(error)}` };
  }
}
