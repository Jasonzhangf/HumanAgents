import type {
  ContextHistoryRecord,
  JournalCommitRef,
  NextAction,
  ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  ConfirmedContextCorrectionBasis,
  ContextCorrectionBasisFacts,
  ContextCorrectionRef,
} from '../../../contracts/src/context-correction.js';
import {
  validateCheckpointControlGrant,
  type CheckpointControlGrant,
} from '../../../contracts/src/checkpoint-controls.js';
import { JsonlOrganJournal, type JournalRecord } from '../../../adapters/jsonl/src/index.js';
import { decodeActiveTurnRecords } from '../../../adapters/jsonl/src/active-turn.js';
import { activeTurnCommitId } from '../../../runtime/src/context/active-turn-journal.js';
import {
  buildConfirmedContextCorrectionBasis,
  sameCorrectionTaskScope,
} from '../../../core/src/context-correction.js';
import {
  buildContextCorrection,
  assertConfirmedContextCorrectionCommand,
  contextCorrectionIdentity,
  sameContextCorrectionCommand,
  type ConfirmedContextCorrectionCommand,
  type ContextCorrectionReadback,
  type ContextCorrectionRecord,
} from '../../../runtime/src/checkpoints/conditional-reentry.js';
import type {
  ContextCorrectionSubmissionPort,
  ExecutionPosition,
} from '../../../runtime/src/checkpoints/ports.js';
import type {
  ReentryCurrentFacts,
  ReentryCurrentRead,
  ReentryFence,
  RetainedReentryDuty,
} from '../../../runtime/src/checkpoints/conditional-reentry.js';
import { readRuntimeTaskCurrentStateFromRecords } from '../runtime-current-state-journal.js';
import { readOperationControlFromRecords } from '../operation-control-journal.js';
import {
  baseExecutionPositionFromRecords,
  closureFromRecord,
  commitConditionalTransitionRecord,
  conditionalReentryFromRecord,
  contextCorrectionFromRecord,
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

    const base = baseExecutionPositionFromRecords(records, taskScope);
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

interface TaskGrantRecordRead {
  readonly grant: CheckpointControlGrant;
  readonly commitRef: JournalCommitRef;
}

function readTaskGrantFromRecords(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
): TaskGrantRecordRead | null {
  let latest: TaskGrantRecordRead | null = null;
  for (const record of records) {
    if (record.kind !== 'event' || !record.commitId || record.payload?.['kind'] !== 'task-grant') continue;
    const grant = record.payload['grant'] as CheckpointControlGrant | undefined;
    if (!grant) continue;
    validateCheckpointControlGrant(grant);
    if (grant.task.value !== taskScope.taskId?.value
      || grant.capability.scope.organId.value !== taskScope.organId.value
      || grant.capability.scope.taskId?.value !== taskScope.taskId.value) {
      throw new Error('task grant does not match the context correction task scope');
    }
    latest = {
      grant,
      commitRef: { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest },
    };
  }
  return latest;
}

function sameCommit(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function resolvedBusinessRefsFromRecords(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
): readonly ContextCorrectionRef[] {
  const refs: ContextCorrectionRef[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record.commitId) continue;
    const context = contextHistoryFromRecord(record);
    if (!context || !inTaskScope(context.scope, taskScope)) continue;
    for (const ref of context.contextView.activeRefs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      refs.push({ taskScope: { organId: taskScope.organId, taskId: taskScope.taskId! }, ref });
    }
  }
  return Object.freeze(refs);
}

function sourceCheckpointFromRecords(
  records: readonly JournalRecord[],
  command: ConfirmedContextCorrectionCommand,
): JournalRecord {
  const record = exactJournalRecord(records, command.basis.sourceCheckpointReceipt);
  if (record.kind !== 'checkpoint' || !record.checkpoint) {
    throw new Error('context correction source receipt is not a committed checkpoint');
  }
  const taskScope: ScopeRef = {
    organId: command.basis.taskScope.organId,
    taskId: command.basis.taskScope.taskId,
  };
  if (!inTaskScope(record.checkpoint.scope, taskScope)) {
    throw new Error('context correction source checkpoint belongs to another task');
  }
  return record;
}

function expectedCurrentControl(
  records: readonly JournalRecord[],
  command: ConfirmedContextCorrectionCommand,
): ReentryCurrentFacts {
  const taskScope: ScopeRef = {
    organId: command.basis.taskScope.organId,
    taskId: command.basis.taskScope.taskId,
  };
  const current = readCurrentFromRecords(records, taskScope);
  if (current.state !== 'known') {
    throw new Error(`context correction current facts are unknown: ${current.reason}`);
  }
  if (current.unresolvedDisplacedRefs.length > 0) {
    throw new Error('context correction requires a settled current incarnation with no unresolved displaced work');
  }
  if (current.position.executionEpoch !== command.basis.expectedExecutionEpoch
    || !sameCommit(current.position.controlCommitRef, command.basis.expectedControlReceipt)
    || !sameCommit(current.position.contextCommitRef, command.basis.expectedContextReceipt)) {
    throw new Error('context correction current control token is stale');
  }
  return current;
}

function assertCurrentOperationControl(
  records: readonly JournalRecord[],
  current: ReentryCurrentFacts,
  command: ConfirmedContextCorrectionCommand,
): void {
  const readback = readOperationControlFromRecords(records, {
    scope: {
      organId: current.context.scope.organId,
      taskId: current.context.scope.taskId,
    },
    agentRuntimeId: current.context.agentRuntimeId,
    harnessExecutionEpoch: current.position.executionEpoch,
  });
  if (readback.state !== 'complete') {
    throw new Error(`context correction operation control is unknown: ${readback.reason}`);
  }
  if (!sameCommit(readback.currentControlCommitRef, command.expectedOperationControlCommitRef)) {
    throw new Error('context correction operation control token changed');
  }
}

function assertCurrentGrant(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
  command: ConfirmedContextCorrectionCommand,
): void {
  const readback = readTaskGrantFromRecords(records, taskScope);
  if (!readback || readback.grant.state !== 'granted'
    || readback.grant.owner !== command.basis.principalOwner
    || String(readback.grant.revision) !== command.permissionRevision
    || !sameCommit(readback.commitRef, command.expectedGrantCommitRef)) {
    throw new Error('context correction grant token or permission revision changed');
  }
}

function maxExecutionEpochForCorrection(
  source: JournalRecord,
  current: ReentryCurrentFacts,
): number {
  const sourceEpoch = source.checkpoint?.executionEpoch ?? 0;
  return Math.max(
    current.position.executionEpoch,
    current.context.contextView.executionEpoch,
    current.context.loopCheckpoint.executionEpoch,
    sourceEpoch,
    ...current.fencedBindings.map((fence) => fence.executionEpoch),
  );
}

function buildCorrectionFromRecords(
  records: readonly JournalRecord[],
  command: ConfirmedContextCorrectionCommand,
): ContextCorrectionRecord {
  assertConfirmedContextCorrectionCommand(command);
  const taskScope: ScopeRef = {
    organId: command.basis.taskScope.organId,
    taskId: command.basis.taskScope.taskId,
  };
  const source = sourceCheckpointFromRecords(records, command);
  const current = expectedCurrentControl(records, command);
  assertCurrentOperationControl(records, current, command);
  assertCurrentGrant(records, taskScope, command);

  const facts: ContextCorrectionBasisFacts = {
    commandId: command.basis.commandId,
    taskScope: command.basis.taskScope,
    sourceCheckpointReceipt: command.basis.sourceCheckpointReceipt,
    expectedControlReceipt: command.basis.expectedControlReceipt,
    expectedContextReceipt: command.basis.expectedContextReceipt,
    expectedExecutionEpoch: command.basis.expectedExecutionEpoch,
    repairText: command.basis.repairText,
    confirmationRef: command.basis.confirmationRef,
    principalOwner: command.basis.principalOwner,
    source: {
      taskScope: command.basis.taskScope,
      checkpointReceipt: command.basis.sourceCheckpointReceipt,
    },
    current: {
      taskScope: command.basis.taskScope,
      controlReceipt: current.position.controlCommitRef,
      contextReceipt: current.position.contextCommitRef,
      executionEpoch: current.position.executionEpoch,
    },
    wrongRefs: command.basis.wrongRefs,
    resolvedBusinessRefs: resolvedBusinessRefsFromRecords(records, taskScope),
  };
  const basis = buildConfirmedContextCorrectionBasis(facts);
  if (JSON.stringify(basis) !== JSON.stringify(command.basis)) {
    throw new Error('context correction confirmed basis conflicts with authoritative Journal facts');
  }
  return buildContextCorrection({
    command,
    sourceCheckpoint: source.checkpoint!,
    current,
    maxExecutionEpoch: maxExecutionEpochForCorrection(source, current),
  });
}

/**
 * App-owned correction submission over the authoritative Organ Journal. The
 * viewed checkpoint is resolved only as a source pointer. Current Context,
 * committed business refs, grant, operation control and CAS all come from the
 * same locked Journal records.
 */
export function createJsonlContextCorrectionSubmissionPort(input: {
  readonly filePath: string;
  readonly journal?: JsonlOrganJournal;
}): ContextCorrectionSubmissionPort {
  if (!input.filePath.trim()) throw new Error('context correction journal path is required');
  const journal = input.journal ?? new JsonlOrganJournal(input.filePath);

  async function records(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) throw new Error(verification.error ?? 'context correction Journal is invalid');
    return verification.records;
  }

  return {
    async prepare(command: ConfirmedContextCorrectionCommand): Promise<ContextCorrectionRecord> {
      return buildCorrectionFromRecords(await records(), command);
    },

    async commitContextCorrectionRecord(
      record: ContextCorrectionRecord,
      expectedCurrentControlCommitRef: JournalCommitRef,
    ): Promise<JournalCommitRef> {
      const command = {
        basis: record.basis,
        expectedOperationControlCommitRef: record.expectedOperationControlCommitRef,
        expectedGrantCommitRef: record.expectedGrantCommitRef,
        permissionRevision: record.permissionRevision,
      };
      assertConfirmedContextCorrectionCommand(command);
      if (record.closureId !== contextCorrectionIdentity(command)
        || !sameContextCorrectionCommand(command, {
          basis: record.basis,
          expectedOperationControlCommitRef: record.expectedOperationControlCommitRef,
          expectedGrantCommitRef: record.expectedGrantCommitRef,
          permissionRevision: record.permissionRevision,
        })) {
        throw new Error('context correction record does not match its confirmed command');
      }
      return commitConditionalTransitionRecord({
        journal,
        record,
        expectedCurrentControlCommitRef,
        validateLocked: (lockedRecords) => {
          const rebuilt = buildCorrectionFromRecords(lockedRecords, command);
          if (JSON.stringify(rebuilt) !== JSON.stringify(record)) {
            throw new Error('context correction transition conflicts with locked authoritative facts');
          }
        },
      });
    },

    async readContextCorrection(
      taskScope: ScopeRef,
      commandId: string,
    ): Promise<ContextCorrectionReadback | null> {
      const recordsValue = await records();
      for (const record of recordsValue) {
        const correction = contextCorrectionFromRecord(record);
        if (!correction || correction.basis.commandId !== commandId) continue;
        if (!inTaskScope(correction.scope, taskScope)) continue;
        if (!record.commitId) throw new Error('context correction record has no physical commit identity');
        return {
          record: correction,
          commitRef: { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest },
        };
      }
      return null;
    },
  };
}
