import type {
  CheckpointClosureRecord,
  ContextHistoryRecord,
  JournalCommitRef,
  NextAction,
  ScopeRef,
  TaskIdentityRecord,
} from '../../../contracts/src/index.js';
import type { ResumedTurnSegmentOpened } from '../../../contracts/src/active-turn-segments.js';
import type {
  ConfirmedContextCorrectionBasis,
  ContextCorrectionBasisFacts,
  ContextCorrectionRef,
} from '../../../contracts/src/context-correction.js';
import {
  validateCheckpointControlGrant,
  type CheckpointControlGrant,
} from '../../../contracts/src/checkpoint-controls.js';
import { validateTaskIdentityRecord } from '../../../contracts/src/task-identity.js';
import { JsonlOrganJournal, type JournalRecord } from '../../../adapters/jsonl/src/index.js';
import { decodeActiveTurnRecords } from '../../../adapters/jsonl/src/active-turn.js';
import { activeTurnCommitId } from '../../../runtime/src/context/active-turn-journal.js';
import type { ActiveTurnJournalRecord } from '../../../runtime/src/context/active-turn-journal.js';
import {
  buildConfirmedContextCorrectionBasis,
  sameCorrectionTaskScope,
} from '../../../core/src/context-correction.js';
import { TaskIdentityConsumer } from '../../../runtime/src/orchestration/task-identity.js';
import { JsonlTaskIdentityJournal } from '../../../adapters/jsonl/src/task-identities.js';
import { JsonlTaskGrantJournal } from '../../../adapters/jsonl/src/task-grants.js';
import { projectTaskGrantAuthority } from '../../../runtime/src/admission/task-grant.js';
import {
  assertConfirmedReentryCommand,
  buildContextCorrection,
  assertConfirmedContextCorrectionCommand,
  buildConditionalReentry,
  conditionalReentryIdentity,
  contextCorrectionIdentity,
  sameConditionalReentryCommand,
  sameContextCorrectionCommand,
  type ConditionalReentryReadback,
  type ConditionalReentryRecord,
  type ConfirmedReentryCommand,
  type ConfirmedContextCorrectionCommand,
  type ContextCorrectionReadback,
  type ContextCorrectionRecord,
} from '../../../runtime/src/checkpoints/conditional-reentry.js';
import type {
  ConditionalReentrySubmissionPort,
  ContextCorrectionSubmissionPort,
  ExecutionPosition,
} from '../../../runtime/src/checkpoints/ports.js';
import type { CheckpointClosureRecord as RuntimeCheckpointClosureRecord } from '../../../runtime/src/checkpoints/closure.js';
import type {
  ReentryCurrentFacts,
  ReentryCurrentRead,
  ReentryFence,
  RetainedReentryDuty,
} from '../../../runtime/src/checkpoints/conditional-reentry.js';
import type { TaskGrantAuthority } from '../../../runtime/src/admission/task-grant.js';
import type {
  ColdCurrentRead,
  ColdCurrentReadInput,
  ColdInitialOpenCurrentFacts,
  ColdInitialOpenPosition,
  ColdInitialOpenSource,
} from '../../../runtime/src/ui-runtime/cold-current.js';
import { readRuntimeTaskCurrentStateFromRecords } from '../runtime-current-state-journal.js';
import { readOperationControlFromRecords } from '../operation-control-journal.js';
import {
  acceptedContextCorrectionBasesFromRecords,
  assertRecoveryBinding,
  baseExecutionPositionFromRecords,
  closureFromRecord,
  commitConditionalTransitionRecord,
  conditionalReentryFromRecord,
  contextCorrectionFromRecord,
  contextHistoryFromRecord,
  exactJournalRecord,
  foldExecutionPositionFromRecords,
  segmentOpenedFromRecord,
} from '../checkpoint-journal.js';

/**
 * Cold-only current-facts read over the authoritative Organ Journal.
 *
 * This reader answers the question the existing `readCurrentFromRecords()`
 * cannot: what the current turn is when the task has no committed checkpoint
 * closure and no v1 recovery capture, so there is no execution position to
 * fold. It reuses the existing canonical owners for every durable fact and
 * adds no second parser.
 *
 * - Task identity comes from the Runtime consumer over `JsonlTaskIdentityJournal`.
 * - Grant authority comes from `JsonlTaskGrantJournal` projected through
 *   `projectTaskGrantAuthority()`, so the same validation the admission path
 *   uses also applies here. Preserved state is the observed grant, not an
 *   authorization for new work.
 * - Binding, initial input, requests and accepted facts come from the owner
 *   codec `decodeActiveTurnRecords()`.
 * - Current state comes from `readRuntimeTaskCurrentStateFromRecords()`.
 * - Root context comes from `contextHistoryFromRecord()`.
 * - Physical operation control comes from `readOperationControlFromRecords()`.
 *
 * `cold-current` is a facts read, not an authorization and not a capture. It
 * never constructs `producersDrained`, `cut`, a checkpoint ref or a synthetic
 * control receipt. Missing, malformed, conflicting or unsupported facts return
 * `unknown` with a concrete reason. There is no fallback path: a known fact
 * cannot be invented by reinterpreting another branch.
 */
function coldCurrentUnknown(reason: string): ColdCurrentRead {
  return { state: 'unknown', reason };
}

/**
 * App-local proof that the exact resumed segment tail is committed. The source
 * resolver owns segment resolution and supplies this value; the reader
 * re-decodes the carrier from its own verified records before using it.
 */
export interface ColdPhysicalTailProof {
  readonly segment: ResumedTurnSegmentOpened;
  readonly commitRef: JournalCommitRef;
}

export async function readColdCurrentFromJournal(
  journal: JsonlOrganJournal,
  input: ColdCurrentReadInput,
  principalOwner: string,
  physicalTail?: ColdPhysicalTailProof,
): Promise<ColdCurrentRead> {
  try {
    const verification = await journal.verify();
    if (!verification.valid) {
      return coldCurrentUnknown(verification.error ?? 'Organ Journal verification failed');
    }
    const records = verification.records;
    const taskScope: ScopeRef = {
      organId: input.allocation.scope.organId,
      taskId: input.allocation.taskId,
    };
    // A committed bound checkpoint closure means the unchanged checkpoint
    // reader already owns this task's current facts. That branch is selected
    // here and delegated without reinterpretation; only a task with no base
    // position continues into the initial-open read below.
    if (baseExecutionPositionFromRecords(records, taskScope) !== null) {
      const current = readCurrentFromRecords(records, taskScope);
      if (current.state === 'known') {
        return { state: 'known', kind: 'checkpoint-bound', current };
      }
      return coldCurrentUnknown(current.reason);
    }
    const { allocation } = input;
    const currentState = readRuntimeTaskCurrentStateFromRecords(records, taskScope);
    if (currentState.state !== 'known') {
      return coldCurrentUnknown(currentState.reason);
    }
    if (currentState.value.processing.entryPhase !== 'open') {
      return coldCurrentUnknown('the current task processing phase is not open, so this is not an initial open turn');
    }
    const grantReadback = await new JsonlTaskGrantJournal(journal).readTaskGrant(allocation.taskId);
    if (grantReadback.grant === null || grantReadback.commit === null) {
      return coldCurrentUnknown('no committed task grant authority is readable for this task');
    }
    let grant: TaskGrantAuthority;
    try {
      grant = projectTaskGrantAuthority({ readback: grantReadback, principalOwner });
    } catch (error) {
      return coldCurrentUnknown(`canonical task grant authority cannot be projected: ${message(error)}`);
    }
    let identity: TaskIdentityRecord | undefined;
    try {
      identity = await new TaskIdentityConsumer(new JsonlTaskIdentityJournal(journal)).read(taskScope);
      if (identity !== undefined) validateTaskIdentityRecord(identity);
    } catch (error) {
      return coldCurrentUnknown(`canonical task identity cannot be read: ${message(error)}`);
    }
    if (identity === undefined) {
      return coldCurrentUnknown('no committed task identity record is readable for this task');
    }
    if (identity.scope.taskId.value !== allocation.taskId.value
      || identity.scope.organId.value !== allocation.scope.organId.value) {
      return coldCurrentUnknown('canonical task identity does not match the retained allocation');
    }
    if (grant.grant.task.value !== allocation.taskId.value
      || grant.grant.capability.scope.organId.value !== allocation.scope.organId.value
      || grant.grant.capability.scope.taskId?.value !== allocation.taskId.value) {
      return coldCurrentUnknown('canonical task grant does not match the retained allocation');
    }
    let activeRecords: readonly ActiveTurnJournalRecord[];
    try {
      activeRecords = decodeActiveTurnRecords(records, input.businessTurnId);
    } catch (error) {
      return coldCurrentUnknown(`active turn records cannot be decoded: ${message(error)}`);
    }
    const bindingRecord = activeRecords.find(
      (record): record is Extract<ActiveTurnJournalRecord, { readonly kind: 'binding-opened' }> => record.kind === 'binding-opened',
    );
    if (bindingRecord === undefined) {
      return coldCurrentUnknown('the active turn binding is not committed for this business turn');
    }
    const initialInputRecord = activeRecords.find(
      (record): record is Extract<ActiveTurnJournalRecord, { readonly kind: 'initial-input' }> => record.kind === 'initial-input',
    );
    if (initialInputRecord === undefined) {
      return coldCurrentUnknown('the active turn initial input is not committed for this business turn');
    }
    const binding = bindingRecord.binding;
    if (binding.scope.organId.value !== allocation.scope.organId.value
      || binding.scope.taskId?.value !== allocation.taskId.value
      || binding.scope.cycleId?.value !== allocation.scope.cycleId?.value
      || binding.scope.operationId?.value !== allocation.operationId.value) {
      return coldCurrentUnknown('the active turn binding scope does not match the retained allocation');
    }
    if (binding.assignment.assignmentId !== allocation.assignmentId
      || binding.admittedTurn.inputRevision !== allocation.inputRevision
      || binding.admittedTurn.turnId !== input.businessTurnId) {
      return coldCurrentUnknown('the active turn binding assignment or input revision does not match the retained allocation');
    }
    if (binding.execution.runtimeId !== allocation.runtimeId
      || binding.execution.executionEpoch !== allocation.executionEpoch) {
      return coldCurrentUnknown('the active turn binding execution does not match the retained allocation');
    }
    const expectedBindingCommitId = activeTurnCommitId(input.businessTurnId, 'binding-opened');
    let bindingCommitRef: JournalCommitRef | undefined;
    let recordsThroughCommitRef: JournalCommitRef | undefined;
    for (const record of records) {
      if (record.kind !== 'event' || record.commitId === undefined) continue;
      if (!record.commitId.startsWith(`active-turn:${input.businessTurnId}:`)) continue;
      if (record.payload?.type !== 'active-turn.record') continue;
      recordsThroughCommitRef = { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
      if (record.commitId === expectedBindingCommitId) {
        bindingCommitRef = { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
      }
    }
    if (bindingCommitRef === undefined) {
      return coldCurrentUnknown('the active turn binding has no physical Journal commit identity');
    }
    if (recordsThroughCommitRef === undefined) {
      return coldCurrentUnknown('the active turn has no committed carrier records');
    }
    const targetRuntimeId = physicalTail?.segment.binding.execution.runtimeId
      ?? binding.execution.runtimeId;
    const targetExecutionEpoch = physicalTail?.segment.binding.execution.executionEpoch
      ?? binding.execution.executionEpoch;
    if (physicalTail !== undefined) {
      const carrier = exactJournalRecord(records, physicalTail.commitRef);
      const decoded = segmentOpenedFromRecord(carrier);
      if (decoded === null) {
        return coldCurrentUnknown('the physical tail proof carrier is not a committed resumed segment record');
      }
      if (JSON.stringify(decoded) !== JSON.stringify(physicalTail.segment)) {
        return coldCurrentUnknown('the physical tail proof does not match its committed segment record');
      }
      if (decoded.binding.businessTurnRef.businessTurnId !== input.businessTurnId) {
        return coldCurrentUnknown('the physical tail segment belongs to another business turn');
      }
      if (!sameScope(decoded.binding.scope, binding.scope)) {
        return coldCurrentUnknown('the physical tail segment scope does not match the original active turn binding');
      }
      if (decoded.binding.assignment.assignmentId !== binding.assignment.assignmentId) {
        return coldCurrentUnknown('the physical tail segment assignment does not match the original active turn binding');
      }
    }
    let context: ContextHistoryRecord | null = null;
    let contextCommitRef: JournalCommitRef | undefined;
    for (const record of records) {
      if (record.kind !== 'event' || record.commitId === undefined) continue;
      const candidate = contextHistoryFromRecord(record);
      if (candidate === null) continue;
      if (physicalTail === undefined && candidate.previousContextCommitRef !== null) continue;
      if (candidate.agentRuntimeId !== targetRuntimeId
        || candidate.loopCheckpoint.executionEpoch !== targetExecutionEpoch
        || candidate.contextView.executionEpoch !== targetExecutionEpoch) continue;
      if (!sameScope(candidate.scope, binding.scope)) continue;
      if (contextCommitRef !== undefined) {
        return coldCurrentUnknown(physicalTail === undefined
          ? 'more than one unambiguous initial root context matches this active turn binding'
          : 'more than one unambiguous context matches the proven physical tail');
      }
      context = candidate;
      contextCommitRef = { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
    }
    if (context === null || contextCommitRef === undefined) {
      return coldCurrentUnknown(physicalTail === undefined
        ? 'no unambiguous initial root context matches this active turn binding'
        : 'no unambiguous context matches the proven physical tail');
    }
    const control = readOperationControlFromRecords(records, {
      scope: taskScope,
      agentRuntimeId: context.agentRuntimeId,
      harnessExecutionEpoch: context.loopCheckpoint.executionEpoch,
    });
    if (control.state !== 'complete') {
      return coldCurrentUnknown(`physical operation control is unknown: ${control.reason}`);
    }
    const retainedParentOperation = control.operations.find(
      (record) => record.intent.operationId.value === allocation.operationId.value);
    if (retainedParentOperation === undefined) {
      return coldCurrentUnknown('the physical operation-control namespace has no retained parent operation');
    }
    if (retainedParentOperation.binding.agentRuntimeId !== context.agentRuntimeId
      || retainedParentOperation.binding.harnessExecutionEpoch !== context.loopCheckpoint.executionEpoch) {
      return coldCurrentUnknown('the retained parent operation does not belong to the physical operation-control namespace');
    }
    const position: ColdInitialOpenPosition = {
      contextCommitRef,
      executionEpoch: targetExecutionEpoch,
    };
    const initial: ColdInitialOpenSource = {
      binding,
      bindingCommitRef,
      recordsThroughCommitRef,
      records: activeRecords,
    };
    const fences = fencedBindings(records, taskScope, context);
    const unresolvedDisplacedRefs = displacedObligationRefs(records, taskScope, fences);
    const retainedDuties: readonly RetainedReentryDuty[] = currentState.value.retainedDuties.map((duty) => ({
      operationRef: duty.operationRef,
      owner: duty.owner,
    }));
    const facts: ColdInitialOpenCurrentFacts = {
      state: 'known',
      kind: 'initial-turn-open',
      stateCommitRef: currentState.stateCommitRef,
      task: currentState.value.task,
      identity,
      grant,
      initial,
      position,
      context,
      operationControl: control,
      entryPhase: currentState.value.processing.entryPhase,
      nextAction: currentState.value.processing.nextAction,
      fencedBindings: fences,
      retainedDuties,
      unresolvedDisplacedRefs,
    };
    return facts;
  } catch (error) {
    return coldCurrentUnknown(`cold current-facts composition failed: ${message(error)}`);
  }
}

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

function readReentryFromRecords(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
  commandId: string,
): ConditionalReentryReadback | null {
  for (const record of records) {
    const transition = conditionalReentryFromRecord(record);
    if (!transition || transition.command.commandId !== commandId) continue;
    if (!inTaskScope(transition.scope, taskScope)) continue;
    if (!record.commitId) throw new Error('conditional reentry record has no physical commit identity');
    return {
      record: transition,
      commitRef: { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest },
    };
  }
  return null;
}

function boundCheckpointClosureFromRecords(
  records: readonly JournalRecord[],
  command: ConfirmedReentryCommand,
): { readonly closure: RuntimeCheckpointClosureRecord } {
  const taskScope: ScopeRef = {
    organId: command.taskScope.organId,
    taskId: command.taskScope.taskId,
  };
  for (const record of [...records].reverse()) {
    const closure = closureFromRecord(record);
    if (!closure || !('closureKind' in closure) || closure.closureKind !== 'checkpoint') continue;
    if (closure.recoveryBinding === undefined) continue;
    if (!inTaskScope(record.scope, taskScope)) continue;
    if (!sameCommit(closure.recoveryBinding.checkpointCommitRef, command.targetCheckpointCommitRef)) continue;
    assertRecoveryBinding(records, record, closure);
    return { closure };
  }
  throw new Error('conditional reentry target checkpoint has no bound closure in the confirmed task');
}

function maxExecutionEpochForReentry(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
  current: ReentryCurrentFacts,
  targetClosure: CheckpointClosureRecord,
): number {
  let maxExecutionEpoch = Math.max(
    current.position.executionEpoch,
    current.context.contextView.executionEpoch,
    current.context.loopCheckpoint.executionEpoch,
    targetClosure.executionEpoch,
    ...current.fencedBindings.map((fence) => fence.executionEpoch),
  );
  for (const record of records) {
    if (!inTaskScope(record.scope, taskScope)) continue;
    if (record.checkpoint) {
      maxExecutionEpoch = Math.max(maxExecutionEpoch, record.checkpoint.executionEpoch);
    }
    const context = contextHistoryFromRecord(record);
    if (context !== null) {
      maxExecutionEpoch = Math.max(
        maxExecutionEpoch,
        context.contextView.executionEpoch,
        context.loopCheckpoint.executionEpoch,
      );
    }
    const reentry = conditionalReentryFromRecord(record);
    if (reentry !== null) {
      maxExecutionEpoch = Math.max(
        maxExecutionEpoch,
        reentry.previousExecutionEpoch,
        reentry.checkpointExecutionEpoch,
        reentry.newExecutionEpoch,
      );
    }
    const correction = contextCorrectionFromRecord(record);
    if (correction !== null) {
      maxExecutionEpoch = Math.max(
        maxExecutionEpoch,
        correction.previousExecutionEpoch,
        correction.newExecutionEpoch,
      );
    }
  }
  return maxExecutionEpoch;
}

function buildReentryFromRecords(
  records: readonly JournalRecord[],
  command: ConfirmedReentryCommand,
): ConditionalReentryRecord {
  assertConfirmedReentryCommand(command);
  const taskScope: ScopeRef = {
    organId: command.taskScope.organId,
    taskId: command.taskScope.taskId,
  };
  const existing = readReentryFromRecords(records, taskScope, command.commandId);
  if (existing !== null) {
    if (!sameConditionalReentryCommand(existing.record.command, command)) {
      throw new Error('conditional reentry command id is already committed with different confirmed facts');
    }
    return existing.record;
  }
  const current = readCurrentFromRecords(records, taskScope);
  if (current.state !== 'known') {
    throw new Error(`conditional reentry current facts are unknown: ${current.reason}`);
  }
  if (current.unresolvedDisplacedRefs.length > 0) {
    throw new Error('conditional reentry requires a settled current incarnation with no unresolved displaced work');
  }
  if (current.position.executionEpoch !== command.expectedExecutionEpoch
    || !sameCommit(current.position.controlCommitRef, command.expectedCurrentControlCommitRef)) {
    throw new Error('conditional reentry current control token is stale');
  }
  const operationControl = readOperationControlFromRecords(records, {
    scope: current.context.scope,
    agentRuntimeId: current.context.agentRuntimeId,
    harnessExecutionEpoch: current.position.executionEpoch,
  });
  if (operationControl.state !== 'complete') {
    throw new Error(`conditional reentry operation control is unknown: ${operationControl.reason}`);
  }
  if (!sameCommit(operationControl.currentControlCommitRef, command.expectedOperationControlCommitRef)) {
    throw new Error('conditional reentry operation control token changed');
  }
  const grant = readTaskGrantFromRecords(records, taskScope);
  if (!grant || grant.grant.state !== 'granted'
    || grant.grant.owner !== command.principalOwner
    || String(grant.grant.revision) !== command.permissionRevision
    || !sameCommit(grant.commitRef, command.expectedGrantCommitRef)) {
    throw new Error('conditional reentry grant token or permission revision changed');
  }
  const target = boundCheckpointClosureFromRecords(records, command);
  const targetContextRecord = exactJournalRecord(records, target.closure.recoveryBinding!.contextCommitRef);
  const targetContext = contextHistoryFromRecord(targetContextRecord);
  if (targetContext === null) {
    throw new Error('conditional reentry target context is unreadable');
  }
  const targetCoreClosure = target.closure.recoveryBinding!.coreClosure;
  const acceptedCorrectionBases = acceptedContextCorrectionBasesFromRecords(records, taskScope);
  return buildConditionalReentry({
    command,
    targetScope: targetContext.scope,
    targetContext,
    targetClosure: targetCoreClosure,
    sourceContextCommitRef: target.closure.recoveryBinding!.contextCommitRef,
    sourceClosureRef: target.closure.closureId,
    current,
    maxExecutionEpoch: maxExecutionEpochForReentry(records, taskScope, current, targetCoreClosure),
    acceptedCorrectionBases,
  });
}

/**
 * App-owned conditional reentry submission over the authoritative Organ
 * Journal. Preparation and the locked CAS rebuild both use the same owner
 * builders; the port adds no second control store or state machine.
 */
export function createJsonlConditionalReentrySubmissionPort(input: {
  readonly filePath: string;
  readonly journal?: JsonlOrganJournal;
}): ConditionalReentrySubmissionPort {
  if (!input.filePath.trim()) throw new Error('conditional reentry journal path is required');
  const journal = input.journal ?? new JsonlOrganJournal(input.filePath);

  async function records(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) throw new Error(verification.error ?? 'conditional reentry Journal is invalid');
    return verification.records;
  }

  return {
    async prepare(command: ConfirmedReentryCommand): Promise<ConditionalReentryRecord> {
      return buildReentryFromRecords(await records(), command);
    },

    async commitReentryRecord(
      record: ConditionalReentryRecord,
      expectedCurrentControlCommitRef: JournalCommitRef,
    ): Promise<JournalCommitRef> {
      assertConfirmedReentryCommand(record.command);
      if (record.closureId !== conditionalReentryIdentity(record.command)) {
        throw new Error('conditional reentry record does not match its confirmed command');
      }
      if (!sameCommit(record.expectedCurrentControlCommitRef, expectedCurrentControlCommitRef)) {
        throw new Error('conditional reentry expected current control token does not match the record');
      }
      return commitConditionalTransitionRecord({
        journal,
        record,
        expectedCurrentControlCommitRef,
        validateLocked: (lockedRecords) => {
          const rebuilt = buildReentryFromRecords(lockedRecords, record.command);
          if (JSON.stringify(rebuilt) !== JSON.stringify(record)) {
            throw new Error('conditional reentry transition conflicts with locked authoritative facts');
          }
        },
      });
    },

    async readReentry(
      taskScope: ScopeRef,
      commandId: string,
    ): Promise<ConditionalReentryReadback | null> {
      return readReentryFromRecords(await records(), taskScope, commandId);
    },
  };
}
