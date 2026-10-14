import { createHash } from 'node:crypto';
import { assertSameScope, id, type ScopeRef, type Task, type CheckpointClosureRecord } from '../../../contracts/src/index.js';
import { assertContextHistoryRecord, durableContextDigest } from './coordinator.js';
import type { ExecutionPosition } from './ports.js';
import type {
  CheckpointReentryRecord as CoreCheckpointReentryRecord,
  ContextHistoryRecord,
  JournalCommitRef,
} from '../../../contracts/src/index.js';
import type { ReentryRecord } from './closure.js';

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
  const base = { checkpointId: id('checkpoint', `reentry-loop-${identity.split(':')[1]}`),
    sequence: current.context.loopCheckpoint.sequence + 1, predecessor,
    executionEpoch: epoch, observationScopeId, contextViewRef,
    eventWatermark: current.context.loopCheckpoint.eventWatermark };
  const loopCheckpoint = { ...base, digest: `sha256:${createHash('sha256').update(JSON.stringify({
    ...base, contextDigest: targetContext.contextView.contextDigest,
  })).digest('hex')}` };
  const checkpointRef = { checkpointId: loopCheckpoint.checkpointId, digest: loopCheckpoint.digest };
  const restoredContext: ContextHistoryRecord = {
    ...targetContext,
    scope: current.context.scope,
    agentRuntimeId: current.context.agentRuntimeId,
    contextView: { ...targetContext.contextView, contextViewRef, executionEpoch: epoch, checkpoint: checkpointRef },
    loopCheckpoint, replacement: null,
    previousContextCommitRef: current.position.controlCommitRef,
    durableContextDigest: durableContextDigest(targetContext.durableContext),
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
