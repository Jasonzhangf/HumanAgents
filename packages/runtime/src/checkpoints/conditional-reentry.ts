import { createHash } from 'node:crypto';
import {
  assertSameScope,
  id,
  type Checkpoint,
  type CheckpointClosureRecord,
  type JsonValue,
  type NextAction,
  type ScopeRef,
  type Task,
} from '../../../contracts/src/index.js';
import type {
  ConfirmedContextCorrectionBasis,
  ContextCorrectionRef,
  CorrectionTaskScope,
} from '../../../contracts/src/context-correction.js';
import {
  applyContextCorrectionExclusions,
  sameCorrectionTaskScope,
} from '../../../core/src/context-correction.js';
import { assertContextHistoryRecord, durableContextDigest } from './coordinator.js';
import type { ExecutionPosition } from './ports.js';
import type {
  CheckpointReentryRecord as CoreCheckpointReentryRecord,
  ContextHistoryRecord,
  JournalCommitRef,
} from '../../../contracts/src/index.js';
import { assertReentryRecord, type ReentryRecord } from './closure.js';

/**
 * One schema-versioned conditional reentry.
 *
 * The target epoch is the committed checkpoint being re-entered, the displaced
 * epoch is the current related execution position, and the new epoch is the
 * allocated successor. They are three distinct facts: the target need not be the
 * latest committed checkpoint, and reentry never rewrites history or external
 * effects.
 *
 * The record carries its own Core evidence, exact source receipts and the
 * restored full context body. A missing required fact makes the caller hold the
 * transition; nothing here substitutes an empty default.
 */

export const CONDITIONAL_REENTRY_SCHEMA_VERSION = 1;
export const CONTEXT_CORRECTION_SCHEMA_VERSION = 2;

/** One affected runtime incarnation whose admitted work this transition displaces. */
export interface ReentryFence {
  readonly scope: ScopeRef;
  readonly agentRuntimeId: string;
  readonly executionEpoch: number;
}

/**
 * Immutable confirmed command. The client submits these fields; the server
 * supplies `principalOwner` after verifying the authenticated principal, and the
 * client never supplies epochs, restored context, Core evidence or policy results.
 */
export interface ConfirmedReentryCommand {
  readonly commandId: string;
  readonly taskScope: ScopeRef;
  readonly targetCheckpointCommitRef: JournalCommitRef;
  readonly expectedCurrentControlCommitRef: JournalCommitRef;
  readonly expectedExecutionEpoch: number;
  readonly expectedOperationControlCommitRef: JournalCommitRef;
  readonly expectedGrantCommitRef: JournalCommitRef;
  readonly permissionRevision: string;
  readonly confirmationRef: string;
  readonly principalOwner: string;
}

export interface ConditionalReentryRecord extends ReentryRecord {
  readonly schemaVersion: typeof CONDITIONAL_REENTRY_SCHEMA_VERSION;
  readonly scope: ScopeRef;
  readonly command: ConfirmedReentryCommand;
  readonly sourceCheckpointCommitRef: JournalCommitRef;
  readonly sourceClosureRef: string;
  readonly sourceContextCommitRef: JournalCommitRef;
  readonly expectedCurrentControlCommitRef: JournalCommitRef;
  readonly grantCommitRef: JournalCommitRef;
  readonly operationControlCommitRef: JournalCommitRef;
  readonly coreReentry: CoreCheckpointReentryRecord;
  readonly fencedBindings: readonly ReentryFence[];
  readonly restoredContext: ContextHistoryRecord;
  readonly currentStateCommitRef: JournalCommitRef;
  readonly currentTask: Task;
  readonly retainedDuties: readonly RetainedReentryDuty[];
}

/**
 * Confirmed Context correction. The accepted C2 basis is the durable exclusion
 * fact. Grant and operation-control receipts stay in the control envelope and
 * are validated against the locked current Journal records before commit.
 */
export interface ConfirmedContextCorrectionCommand {
  readonly basis: ConfirmedContextCorrectionBasis;
  readonly expectedOperationControlCommitRef: JournalCommitRef;
  readonly expectedGrantCommitRef: JournalCommitRef;
  readonly permissionRevision: string;
}

/**
 * Schema-2 correction variant on the existing conditional-reentry carrier.
 * `basis.sourceCheckpointReceipt` is only the user-referenced source pointer.
 * `correctedContext` is built from the authoritative current Context.
 */
export interface ContextCorrectionRecord extends ReentryRecord {
  readonly schemaVersion: typeof CONTEXT_CORRECTION_SCHEMA_VERSION;
  readonly scope: ScopeRef;
  readonly basis: ConfirmedContextCorrectionBasis;
  readonly expectedOperationControlCommitRef: JournalCommitRef;
  readonly expectedGrantCommitRef: JournalCommitRef;
  readonly permissionRevision: string;
  readonly coreReentry: CoreCheckpointReentryRecord;
  readonly fencedBindings: readonly ReentryFence[];
  readonly correctedContext: ContextHistoryRecord;
  readonly currentStateCommitRef: JournalCommitRef;
  readonly currentTask: Task;
  readonly retainedDuties: readonly RetainedReentryDuty[];
}

export interface RetainedReentryDuty {
  readonly operationRef: string;
  readonly owner: string;
}

/** Required owner facts. The reader must consume only the supplied verified records. */
export interface ReentryCurrentFacts {
  readonly state: 'known';
  readonly stateCommitRef: JournalCommitRef;
  readonly task: Task;
  readonly position: ExecutionPosition;
  readonly context: ContextHistoryRecord;
  readonly entryPhase: string;
  readonly nextAction: string;
  readonly fencedBindings: readonly ReentryFence[];
  readonly retainedDuties: readonly RetainedReentryDuty[];
  readonly unresolvedDisplacedRefs: readonly string[];
}

export type ReentryCurrentRead = ReentryCurrentFacts | { readonly state: 'unknown'; readonly reason: string };

export function conditionalReentryIdentity(command: ConfirmedReentryCommand): string {
  return `conditional-reentry:${createHash('sha256').update(JSON.stringify([
    command.taskScope.organId, command.taskScope.taskId, command.commandId,
  ])).digest('hex')}`;
}

export function contextCorrectionIdentity(command: ConfirmedContextCorrectionCommand): string {
  return `context-correction:${createHash('sha256').update(JSON.stringify([
    command.basis.taskScope.organId, command.basis.taskScope.taskId, command.basis.commandId,
  ])).digest('hex')}`;
}

export function assertConfirmedContextCorrectionCommand(command: ConfirmedContextCorrectionCommand): void {
  const basis = command.basis;
  nonEmpty(basis.commandId, 'context correction command id');
  nonEmpty(basis.repairText, 'context correction repair text');
  nonEmpty(basis.confirmationRef, 'context correction confirmation ref');
  nonEmpty(basis.principalOwner, 'context correction principal owner');
  nonEmpty(command.permissionRevision, 'context correction permission revision');
  assertCorrectionTaskScope(basis.taskScope);
  positiveSafeInteger(basis.expectedExecutionEpoch, 'context correction expected execution epoch');
  for (const ref of [basis.sourceCheckpointReceipt, basis.expectedControlReceipt, basis.expectedContextReceipt,
    command.expectedOperationControlCommitRef, command.expectedGrantCommitRef]) {
    assertCommitRef(ref, 'context correction command receipt');
  }
  if (basis.wrongRefs.length === 0) throw new Error('context correction requires at least one wrong ref');
  for (const wrongRef of basis.wrongRefs) {
    if (!sameCorrectionTaskScope(wrongRef.taskScope, basis.taskScope)) {
      throw new Error('context correction wrong ref does not belong to the confirmed task');
    }
    nonEmpty(wrongRef.ref, 'context correction wrong ref');
  }
}

function assertCorrectionTaskScope(scope: CorrectionTaskScope): void {
  if (scope.organId.scope !== 'organ' || !scope.organId.value.trim()) {
    throw new Error('context correction organ id is invalid');
  }
  if (scope.taskId.scope !== 'task' || !scope.taskId.value.trim()) {
    throw new Error('context correction task id is invalid');
  }
}

function correctionTaskScope(scope: ScopeRef): CorrectionTaskScope {
  if (!scope.taskId) throw new Error('context correction requires a task scope');
  return { organId: scope.organId, taskId: scope.taskId };
}

function parseNextAction(value: string): NextAction {
  const [kind, ...rest] = value.split(':');
  const ref = rest.length > 0 ? rest.join(':') : undefined;
  if (kind !== 'continue' && kind !== 'wait' && kind !== 'stop' && kind !== 'recover') {
    throw new Error(`unsupported current next action: ${value}`);
  }
  if ((kind === 'wait' || kind === 'stop' || kind === 'recover') && !ref?.trim()) {
    throw new Error(`current next action requires a reference: ${value}`);
  }
  return { kind, ...(ref ? { ref } : {}) };
}

function contextDigest(activeRefs: readonly string[], omittedRefs: readonly string[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ activeRefs, omittedRefs })).digest('hex')}`;
}

function applyAcceptedCorrectionBases(
  bases: readonly ConfirmedContextCorrectionBasis[],
  candidateRefs: readonly ContextCorrectionRef[],
): readonly ContextCorrectionRef[] {
  let refs = candidateRefs;
  for (const basis of bases) refs = applyContextCorrectionExclusions(basis, refs);
  return refs;
}

/**
 * Apply the same exact declared-ref exclusions to a durable assembly array.
 * Only top-level string refs participate. Raw dynamic units and any structured
 * entries stay byte-for-byte intact, so call/result groups keep their pairing.
 */
function applyAcceptedCorrectionsToDurableRefs(
  bases: readonly ConfirmedContextCorrectionBasis[],
  entries: readonly JsonValue[],
  taskScope: CorrectionTaskScope,
): readonly JsonValue[] {
  if (bases.length === 0) return entries;
  const refs: readonly ContextCorrectionRef[] = entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((ref) => ({ taskScope, ref }));
  const allowed = new Set(applyAcceptedCorrectionBases(bases, refs).map((entry) => entry.ref));
  return entries.filter((entry) => typeof entry !== 'string' || allowed.has(entry));
}

function uniqueRefs(values: readonly string[], label: string): readonly string[] {
  const result = [...values];
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  for (const value of result) nonEmpty(value, label);
  return result;
}

/**
 * Build the schema-2 correction transition from the authoritative current
 * Context. The viewed checkpoint is the exact source pointer only. Its historical
 * Context is never used as the correction base.
 */
export function buildContextCorrection(input: {
  readonly command: ConfirmedContextCorrectionCommand;
  readonly sourceCheckpoint: Checkpoint;
  readonly current: ReentryCurrentFacts;
  readonly maxExecutionEpoch: number;
}): ContextCorrectionRecord {
  assertConfirmedContextCorrectionCommand(input.command);
  const { command, current, sourceCheckpoint } = input;
  assertContextHistoryRecord(current.context);
  if (current.task.id.value !== command.basis.taskScope.taskId.value
    || current.task.organId.value !== command.basis.taskScope.organId.value) {
    throw new Error('current Task scope conflicts with the context correction');
  }
  if (current.unresolvedDisplacedRefs.length) {
    throw new Error('displaced recovery obligations remain unresolved');
  }
  if (sourceCheckpoint.id.scope !== 'checkpoint' || !sourceCheckpoint.id.value.trim()) {
    throw new Error('source checkpoint identity is invalid');
  }
  if (current.position.executionEpoch !== command.basis.expectedExecutionEpoch) {
    throw new Error('current execution epoch changed before context correction');
  }
  if (!sameCommitRef(current.position.controlCommitRef, command.basis.expectedControlReceipt)) {
    throw new Error('current control receipt changed before context correction');
  }
  if (!sameCommitRef(current.position.contextCommitRef, command.basis.expectedContextReceipt)) {
    throw new Error('current context receipt changed before context correction');
  }

  const taskScope = correctionTaskScope(current.context.scope);
  if (!sameCorrectionTaskScope(taskScope, command.basis.taskScope)) {
    throw new Error('current Context task scope conflicts with the context correction');
  }
  const candidateRefs: readonly ContextCorrectionRef[] = current.context.contextView.activeRefs.map((ref) => ({
    taskScope,
    ref,
  }));
  const activeRefs = applyContextCorrectionExclusions(command.basis, candidateRefs).map((entry) => entry.ref);
  const omittedRefs = uniqueRefs([
    ...current.context.contextView.omittedRefs,
    ...command.basis.wrongRefs.filter((wrongRef) => !activeRefs.includes(wrongRef.ref)).map((wrongRef) => wrongRef.ref),
  ], 'context correction omitted refs');
  if (activeRefs.some((ref) => omittedRefs.includes(ref))) {
    throw new Error('context correction produced overlapping active and omitted refs');
  }

  const epoch = input.maxExecutionEpoch + 1;
  positiveSafeInteger(epoch, 'new execution epoch');
  const identity = contextCorrectionIdentity(command);
  const observationScopeId = `${identity}:observation`;
  const contextViewRef = `${identity}:context`;
  const predecessor = current.context.contextView.checkpoint;
  const base = {
    checkpointId: id('checkpoint', `correction-loop-${identity.split(':')[1]}`),
    sequence: current.context.loopCheckpoint.sequence + 1,
    predecessor,
    executionEpoch: epoch,
    observationScopeId,
    contextViewRef,
    eventWatermark: current.context.loopCheckpoint.eventWatermark,
  };
  const loopCheckpoint = {
    ...base,
    digest: `sha256:${createHash('sha256').update(JSON.stringify({
      ...base,
      contextDigest: contextDigest(activeRefs, omittedRefs),
    })).digest('hex')}`,
  };
  const checkpointRef = { checkpointId: loopCheckpoint.checkpointId, digest: loopCheckpoint.digest };
  const correctedDurableContext = {
    ...current.context.durableContext,
    indexRefs: applyAcceptedCorrectionsToDurableRefs(
      [command.basis],
      current.context.durableContext.indexRefs,
      taskScope,
    ),
    repairRefs: applyAcceptedCorrectionsToDurableRefs(
      [command.basis],
      current.context.durableContext.repairRefs,
      taskScope,
    ),
  };
  const correctedContext: ContextHistoryRecord = {
    ...current.context,
    scope: current.context.scope,
    agentRuntimeId: current.context.agentRuntimeId,
    contextView: {
      ...current.context.contextView,
      contextViewRef,
      executionEpoch: epoch,
      checkpoint: checkpointRef,
      contextDigest: contextDigest(activeRefs, omittedRefs),
      activeRefs,
      omittedRefs,
    },
    loopCheckpoint,
    replacement: null,
    previousContextCommitRef: command.basis.expectedContextReceipt,
    durableContext: correctedDurableContext,
    durableContextDigest: durableContextDigest(correctedDurableContext),
    loopControl: {
      ...current.context.loopControl,
      observationScopeId,
      observationScope: current.context.loopControl.observationScope === null ? null : {
        ...current.context.loopControl.observationScope,
        observationScopeId,
        agentRuntimeId: current.context.agentRuntimeId,
        executionEpoch: epoch,
        checkpoint: checkpointRef,
      },
      inboxExecutionEpoch: epoch,
      inboxCheckpoint: checkpointRef,
      inboxObservationScopeId: observationScopeId,
      deltaExecutionEpoch: epoch,
      deltaCheckpoint: checkpointRef,
      deltaObservationScopeId: observationScopeId,
    },
  };
  assertContextHistoryRecord(correctedContext);

  const nextAction = parseNextAction(current.nextAction);
  const record: ContextCorrectionRecord = {
    schemaVersion: CONTEXT_CORRECTION_SCHEMA_VERSION,
    closureKind: 'reentry',
    closureId: identity,
    scope: current.context.scope,
    basis: command.basis,
    expectedOperationControlCommitRef: command.expectedOperationControlCommitRef,
    expectedGrantCommitRef: command.expectedGrantCommitRef,
    permissionRevision: command.permissionRevision,
    checkpointId: sourceCheckpoint.id,
    checkpointExecutionEpoch: sourceCheckpoint.executionEpoch,
    previousExecutionEpoch: current.position.executionEpoch,
    newExecutionEpoch: epoch,
    nextAction,
    reentry: { allowed: true, reason: 'conditional Core context correction admission' },
    coreReentry: {
      checkpointId: sourceCheckpoint.id,
      reentryId: identity,
      checkpointExecutionEpoch: sourceCheckpoint.executionEpoch,
      previousExecutionEpoch: current.position.executionEpoch,
      newExecutionEpoch: epoch,
      fencedEpochs: [...new Set(current.fencedBindings.map((fence) => fence.executionEpoch))],
      permissionRevision: command.permissionRevision,
      contextViewRef,
      entryPhase: current.entryPhase,
      nextAction: current.nextAction,
      reentryRef: identity,
    },
    fencedBindings: current.fencedBindings,
    correctedContext,
    currentStateCommitRef: current.stateCommitRef,
    currentTask: current.task,
    retainedDuties: current.retainedDuties,
  };
  assertContextCorrectionRecord({ record });
  return record;
}

export function assertConfirmedReentryCommand(command: ConfirmedReentryCommand): void {
  nonEmpty(command.commandId, 'reentry command id');
  nonEmpty(command.principalOwner, 'verified principal owner');
  nonEmpty(command.confirmationRef, 'explicit reentry confirmation');
  nonEmpty(command.permissionRevision, 'permission revision');
  if (!command.taskScope.taskId) throw new Error('reentry requires a task scope');
  assertSameScope(command.taskScope, { organId: command.taskScope.organId, taskId: command.taskScope.taskId });
  positiveSafeInteger(command.expectedExecutionEpoch, 'expected current epoch');
  for (const ref of [command.targetCheckpointCommitRef, command.expectedCurrentControlCommitRef,
    command.expectedOperationControlCommitRef, command.expectedGrantCommitRef]) assertCommitRef(ref, 'command receipt');
}

/** Restore historical reasoning and current processing truth without reviving a lease. */
export function buildConditionalReentry(input: {
  readonly command: ConfirmedReentryCommand;
  readonly targetScope: ScopeRef;
  readonly targetContext: ContextHistoryRecord;
  readonly targetClosure: CheckpointClosureRecord;
  readonly sourceContextCommitRef: JournalCommitRef;
  readonly sourceClosureRef: string;
  readonly current: ReentryCurrentFacts;
  readonly maxExecutionEpoch: number;
  /**
   * Accepted exact exclusions already committed at the current waterline.
   * Historical restore must not reintroduce a ref the user confirmed wrong.
   */
  readonly acceptedCorrectionBases?: readonly ConfirmedContextCorrectionBasis[];
}): ConditionalReentryRecord {
  assertConfirmedReentryCommand(input.command);
  const { command, current, targetContext, targetClosure } = input;
  assertContextHistoryRecord(targetContext);
  assertContextHistoryRecord(current.context);
  if (current.task.id.value !== command.taskScope.taskId!.value
    || current.task.organId.value !== command.taskScope.organId.value) throw new Error('current Task scope conflicts');
  if (current.unresolvedDisplacedRefs.length) throw new Error('displaced recovery obligations remain unresolved');
  const epoch = input.maxExecutionEpoch + 1;
  positiveSafeInteger(epoch, 'new execution epoch');
  const identity = conditionalReentryIdentity(command);
  const observationScopeId = `${identity}:observation`;
  const contextViewRef = `${identity}:context`;
  const predecessor = current.context.contextView.checkpoint;
  const targetTaskScope = correctionTaskScope(targetContext.scope);
  const acceptedCorrectionBases = input.acceptedCorrectionBases ?? [];
  for (const basis of acceptedCorrectionBases) {
    if (!sameCorrectionTaskScope(basis.taskScope, targetTaskScope)) {
      throw new Error('accepted context correction basis belongs to another task');
    }
  }
  const targetCandidateRefs: readonly ContextCorrectionRef[] = targetContext.contextView.activeRefs.map((ref) => ({
    taskScope: targetTaskScope,
    ref,
  }));
  const restoredActiveRefs = applyAcceptedCorrectionBases(
    acceptedCorrectionBases,
    targetCandidateRefs,
  ).map((entry) => entry.ref);
  const restoredOmittedRefs = uniqueRefs([
    ...targetContext.contextView.omittedRefs,
    ...acceptedCorrectionBases.flatMap((basis) => basis.wrongRefs.map((wrongRef) => wrongRef.ref))
      .filter((ref) => !restoredActiveRefs.includes(ref)),
  ], 'restored context omitted refs');
  const restoredContextDigest = contextDigest(restoredActiveRefs, restoredOmittedRefs);
  const base = { checkpointId: id('checkpoint', `reentry-loop-${identity.split(':')[1]}`),
    sequence: current.context.loopCheckpoint.sequence + 1, predecessor,
    executionEpoch: epoch, observationScopeId, contextViewRef,
    eventWatermark: current.context.loopCheckpoint.eventWatermark };
  const loopCheckpoint = { ...base, digest: `sha256:${createHash('sha256').update(JSON.stringify({
    ...base, contextDigest: restoredContextDigest,
  })).digest('hex')}` };
  const checkpointRef = { checkpointId: loopCheckpoint.checkpointId, digest: loopCheckpoint.digest };
  const restoredDurableContext = {
    ...targetContext.durableContext,
    indexRefs: applyAcceptedCorrectionsToDurableRefs(
      acceptedCorrectionBases,
      targetContext.durableContext.indexRefs,
      targetTaskScope,
    ),
    repairRefs: applyAcceptedCorrectionsToDurableRefs(
      acceptedCorrectionBases,
      targetContext.durableContext.repairRefs,
      targetTaskScope,
    ),
  };
  const restoredContext: ContextHistoryRecord = {
    ...targetContext,
    scope: current.context.scope,
    agentRuntimeId: current.context.agentRuntimeId,
    contextView: {
      ...targetContext.contextView,
      contextViewRef,
      executionEpoch: epoch,
      checkpoint: checkpointRef,
      contextDigest: restoredContextDigest,
      activeRefs: restoredActiveRefs,
      omittedRefs: restoredOmittedRefs,
    },
    loopCheckpoint, replacement: null,
    previousContextCommitRef: current.position.controlCommitRef,
    durableContext: restoredDurableContext,
    durableContextDigest: durableContextDigest(restoredDurableContext),
    loopControl: { ...current.context.loopControl, observationScopeId,
      observationScope: current.context.loopControl.observationScope === null ? null : {
        ...current.context.loopControl.observationScope, observationScopeId,
        agentRuntimeId: current.context.agentRuntimeId, executionEpoch: epoch, checkpoint: checkpointRef },
      inboxExecutionEpoch: epoch, inboxCheckpoint: checkpointRef, inboxObservationScopeId: observationScopeId,
      deltaExecutionEpoch: epoch, deltaCheckpoint: checkpointRef, deltaObservationScopeId: observationScopeId },
  };
  assertContextHistoryRecord(restoredContext);
  const record: ConditionalReentryRecord = {
    schemaVersion: 1, closureKind: 'reentry', closureId: identity,
    scope: input.targetScope, command,
    checkpointId: targetClosure.checkpointId,
    checkpointExecutionEpoch: targetClosure.executionEpoch,
    previousExecutionEpoch: current.position.executionEpoch, newExecutionEpoch: epoch,
    nextAction: targetClosure.nextAction, reentry: { allowed: true, reason: 'conditional Core admission' },
    sourceCheckpointCommitRef: command.targetCheckpointCommitRef,
    sourceClosureRef: input.sourceClosureRef, sourceContextCommitRef: input.sourceContextCommitRef,
    expectedCurrentControlCommitRef: command.expectedCurrentControlCommitRef,
    grantCommitRef: command.expectedGrantCommitRef, operationControlCommitRef: command.expectedOperationControlCommitRef,
    coreReentry: { checkpointId: targetClosure.checkpointId, reentryId: identity,
      checkpointExecutionEpoch: targetClosure.executionEpoch,
      previousExecutionEpoch: current.position.executionEpoch, newExecutionEpoch: epoch,
      fencedEpochs: [...new Set(current.fencedBindings.map((fence) => fence.executionEpoch))],
      permissionRevision: command.permissionRevision, contextViewRef,
      entryPhase: current.entryPhase, nextAction: current.nextAction, reentryRef: identity },
    fencedBindings: current.fencedBindings, restoredContext,
    currentStateCommitRef: current.stateCommitRef, currentTask: current.task, retainedDuties: current.retainedDuties,
  };
  assertConditionalReentryRecord({ record, command, targetExecutionEpoch: targetClosure.executionEpoch,
    currentExecutionEpoch: current.position.executionEpoch, permissionRevision: command.permissionRevision, restoredContext });
  return record;
}

export interface ConditionalReentryReadback {
  readonly record: ConditionalReentryRecord;
  readonly commitRef: JournalCommitRef;
}

export interface ConditionalReentryPort {
  commitReentryRecord(
    record: ConditionalReentryRecord,
    expectedCurrentControlCommitRef: JournalCommitRef,
  ): Promise<JournalCommitRef>;

  readReentry(
    taskScope: ScopeRef,
    commandId: string,
  ): Promise<ConditionalReentryReadback | null>;
}

export interface ContextCorrectionReadback {
  readonly record: ContextCorrectionRecord;
  readonly commitRef: JournalCommitRef;
}

export interface ContextCorrectionPort {
  commitContextCorrectionRecord(
    record: ContextCorrectionRecord,
    expectedCurrentControlCommitRef: JournalCommitRef,
  ): Promise<JournalCommitRef>;

  readContextCorrection(
    taskScope: ScopeRef,
    commandId: string,
  ): Promise<ContextCorrectionReadback | null>;
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
}

function sameCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function assertCommitRef(ref: JournalCommitRef, label: string): void {
  nonEmpty(ref.commitId, `${label} commit id`);
  positiveSafeInteger(ref.journalSeq, `${label} journal seq`);
  nonEmpty(ref.recordDigest, `${label} record digest`);
}

function assertFence(fence: ReentryFence, label: string): void {
  nonEmpty(fence.agentRuntimeId, `${label} agent runtime id`);
  positiveSafeInteger(fence.executionEpoch, `${label} execution epoch`);
}

/** Exact field-by-field mapping from the extended Runtime reentry record. */
export function conditionalCoreReentry(
  record: ConditionalReentryRecord,
): CoreCheckpointReentryRecord {
  return {
    checkpointId: record.checkpointId,
    reentryId: record.closureId,
    checkpointExecutionEpoch: record.checkpointExecutionEpoch,
    previousExecutionEpoch: record.previousExecutionEpoch,
    newExecutionEpoch: record.newExecutionEpoch,
    fencedEpochs: [...new Set(record.fencedBindings.map((fence) => fence.executionEpoch))],
    permissionRevision: record.coreReentry.permissionRevision,
    contextViewRef: record.restoredContext.contextView.contextViewRef,
    entryPhase: record.coreReentry.entryPhase,
    nextAction: record.coreReentry.nextAction,
    reentryRef: record.coreReentry.reentryRef,
  };
}

/**
 * Validates the conditional relation before the transaction runs. The three
 * epochs stay distinct, Core keeps fenced epochs below the new epoch, and the
 * restored context keeps an exact schema-1 body.
 */
export function assertConditionalReentryRecord(input: {
  readonly record: ConditionalReentryRecord;
  readonly targetExecutionEpoch: number;
  readonly currentExecutionEpoch: number;
  readonly permissionRevision: string;
  readonly command: ConfirmedReentryCommand;
  readonly restoredContext: ContextHistoryRecord;
}): void {
  const { record } = input;
  if (record.schemaVersion !== CONDITIONAL_REENTRY_SCHEMA_VERSION) {
    throw new Error('conditional reentry schemaVersion must be 1');
  }
  if (record.scope.organId.value !== input.command.taskScope.organId.value
    || record.scope.taskId?.value !== input.command.taskScope.taskId?.value) throw new Error('reentry target task scope conflicts');
  nonEmpty(record.closureId, 'conditional reentry closure id');
  nonEmpty(record.command.commandId, 'conditional reentry command id');

  // Target, displaced and new epochs are three distinct facts.
  if (record.checkpointExecutionEpoch !== input.targetExecutionEpoch) {
    throw new Error('conditional reentry target epoch must match the committed target');
  }
  if (record.previousExecutionEpoch !== input.currentExecutionEpoch) {
    throw new Error('conditional reentry displaced epoch must match the current execution position');
  }
  if (record.newExecutionEpoch <= record.previousExecutionEpoch) {
    throw new Error('conditional reentry must create a new execution epoch');
  }
  if (record.newExecutionEpoch <= record.checkpointExecutionEpoch) {
    throw new Error('conditional reentry new epoch must exceed the target epoch');
  }

  for (const fence of record.fencedBindings) {
    assertFence(fence, 'conditional reentry fence');
    if (fence.executionEpoch >= record.newExecutionEpoch) {
      throw new Error('conditional reentry must fence epochs below the new execution epoch');
    }
  }

  assertCommitRef(record.sourceCheckpointCommitRef, 'conditional reentry checkpoint');
  assertCommitRef(record.sourceContextCommitRef, 'conditional reentry context');
  assertCommitRef(record.grantCommitRef, 'conditional reentry grant');
  assertCommitRef(record.operationControlCommitRef, 'conditional reentry operation control');
  nonEmpty(record.sourceClosureRef, 'conditional reentry closure ref');

  if (!sameCommitRef(record.command.targetCheckpointCommitRef, record.sourceCheckpointCommitRef)) {
    throw new Error('conditional reentry command target must match the resolved target receipt');
  }
  if (!sameCommitRef(record.command.expectedCurrentControlCommitRef, record.expectedCurrentControlCommitRef)) {
    throw new Error('conditional reentry current control token must match the command');
  }
  if (record.command.permissionRevision !== input.permissionRevision
    || record.coreReentry.permissionRevision !== input.permissionRevision) {
    throw new Error('conditional reentry permission revision must match the current grant');
  }
  if (!sameCommitRef(record.command.expectedGrantCommitRef, record.grantCommitRef)) {
    throw new Error('conditional reentry grant token must match the resolved grant receipt');
  }
  if (!sameCommitRef(record.command.expectedOperationControlCommitRef, record.operationControlCommitRef)) {
    throw new Error('conditional reentry operation control token must match the resolved control receipt');
  }

  if (record.restoredContext.previousContextCommitRef === null
    || !sameCommitRef(record.restoredContext.previousContextCommitRef, record.expectedCurrentControlCommitRef)) {
    throw new Error('conditional reentry restored context must follow the current control receipt');
  }
  if (record.restoredContext.scope.organId.value !== input.command.taskScope.organId.value
    || record.restoredContext.scope.taskId?.value !== input.command.taskScope.taskId?.value) throw new Error('restored context task scope conflicts');
  if (JSON.stringify(input.restoredContext) !== JSON.stringify(record.restoredContext)) {
    throw new Error('conditional reentry restored context must match the resolved context body');
  }
}

function sameScopeRef(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

export function assertContextCorrectionRecord(input: {
  readonly record: ContextCorrectionRecord;
}): void {
  const { record } = input;
  if (record.schemaVersion !== CONTEXT_CORRECTION_SCHEMA_VERSION) {
    throw new Error('context correction schemaVersion must be 2');
  }
  assertReentryRecord({ ...record, schemaVersion: 1 });
  positiveSafeInteger(record.checkpointExecutionEpoch, 'context correction source epoch');
  assertConfirmedContextCorrectionCommand({
    basis: record.basis,
    expectedOperationControlCommitRef: record.expectedOperationControlCommitRef,
    expectedGrantCommitRef: record.expectedGrantCommitRef,
    permissionRevision: record.permissionRevision,
  });
  if (record.closureId !== contextCorrectionIdentity({
    basis: record.basis,
    expectedOperationControlCommitRef: record.expectedOperationControlCommitRef,
    expectedGrantCommitRef: record.expectedGrantCommitRef,
    permissionRevision: record.permissionRevision,
  })) {
    throw new Error('context correction command identity conflicts');
  }
  const taskScope = correctionTaskScope(record.scope);
  if (!sameCorrectionTaskScope(taskScope, record.basis.taskScope)) {
    throw new Error('context correction record scope conflicts with its basis');
  }
  if (record.previousExecutionEpoch !== record.basis.expectedExecutionEpoch) {
    throw new Error('context correction displaced epoch differs from its confirmed basis');
  }
  assertCommitRef(record.currentStateCommitRef, 'context correction current state');
  if (!sameScopeRef(record.correctedContext.scope, record.scope)
    || record.correctedContext.contextView.executionEpoch !== record.newExecutionEpoch
    || record.correctedContext.loopCheckpoint.executionEpoch !== record.newExecutionEpoch) {
    throw new Error('context correction Context body does not match its transition epoch or scope');
  }
  if (record.correctedContext.previousContextCommitRef === null
    || !sameCommitRef(record.correctedContext.previousContextCommitRef, record.basis.expectedContextReceipt)) {
    throw new Error('context correction Context body must follow the confirmed current Context receipt');
  }
  for (const wrongRef of record.basis.wrongRefs) {
    if (record.correctedContext.contextView.activeRefs.includes(wrongRef.ref)) {
      throw new Error('context correction Context still contains a confirmed wrong ref');
    }
    if (!record.correctedContext.contextView.omittedRefs.includes(wrongRef.ref)) {
      throw new Error('context correction Context does not persist the exact omission');
    }
  }
  if (record.coreReentry.reentryId !== record.closureId
    || record.coreReentry.previousExecutionEpoch !== record.previousExecutionEpoch
    || record.coreReentry.newExecutionEpoch !== record.newExecutionEpoch
    || record.coreReentry.permissionRevision !== record.permissionRevision
    || record.coreReentry.contextViewRef !== record.correctedContext.contextView.contextViewRef) {
    throw new Error('context correction Core relation conflicts with its Context transition');
  }
  for (const fence of record.fencedBindings) {
    assertFence(fence, 'context correction fence');
    if (fence.executionEpoch >= record.newExecutionEpoch) {
      throw new Error('context correction fence epoch must be below the new execution epoch');
    }
  }
}

export function sameContextCorrectionCommand(
  left: ConfirmedContextCorrectionCommand,
  right: ConfirmedContextCorrectionCommand,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameContextCorrectionRecord(
  left: ContextCorrectionRecord,
  right: ContextCorrectionRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameConditionalReentryCommand(
  left: ConfirmedReentryCommand,
  right: ConfirmedReentryCommand,
): boolean {
  return left.commandId === right.commandId
    && JSON.stringify(left.taskScope) === JSON.stringify(right.taskScope)
    && sameCommitRef(left.targetCheckpointCommitRef, right.targetCheckpointCommitRef)
    && sameCommitRef(left.expectedCurrentControlCommitRef, right.expectedCurrentControlCommitRef)
    && left.expectedExecutionEpoch === right.expectedExecutionEpoch
    && sameCommitRef(left.expectedOperationControlCommitRef, right.expectedOperationControlCommitRef)
    && sameCommitRef(left.expectedGrantCommitRef, right.expectedGrantCommitRef)
    && left.permissionRevision === right.permissionRevision
    && left.confirmationRef === right.confirmationRef
    && left.principalOwner === right.principalOwner;
}

export function sameReentryFence(left: ReentryFence, right: ReentryFence): boolean {
  return left.agentRuntimeId === right.agentRuntimeId
    && left.executionEpoch === right.executionEpoch
    && left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId?.value === right.scope.taskId?.value
    && left.scope.cycleId?.value === right.scope.cycleId?.value
    && left.scope.operationId?.value === right.scope.operationId?.value;
}

export function sameConditionalReentryRecord(
  left: ConditionalReentryRecord,
  right: ConditionalReentryRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
