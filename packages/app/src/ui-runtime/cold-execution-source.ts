import {
  canonicalJsonStringify,
  type CompletionReadInput,
  type JournalCommitRef,
  type OperationId,
  type ScopeRef,
  type TaskId,
  type WorkAssignment,
} from '../../../contracts/src/index.js';
import type {
  ActiveTurnInitialSegmentSource,
  ActiveTurnSegmentPredecessorRef,
  ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { listTaskActiveTurnBindings } from '../../../adapters/jsonl/src/active-turn.js';
import { JsonlOperationCompletionJournal } from '../../../adapters/jsonl/src/operation-completion.js';
import { ImmutableAssetStore } from '../../../adapters/filesystem/src/index.js';
import type {
  ActiveTurnInitialOpenExactRead,
  ActiveTurnSegmentCaptureExactRead,
  ActiveTurnSegmentInterruptedExactRead,
  ActiveTurnSegmentJournalPort,
} from '../../../runtime/src/context/active-turn-journal.js';
import type { ColdCurrentFacts } from '../../../runtime/src/ui-runtime/cold-current.js';
import { retryCycleId, type RetryCycleControlRecord, type RetryCycleJournalPort } from '../../../runtime/src/orchestration/retry-cycle.js';
import type { RuntimeExecutionAllocation, RuntimeTaskJournalPort } from '../../../runtime/src/ui-runtime/coordinator.js';
import type { RuntimeColdExecutionResumeRequest } from '../../../runtime/src/ui-runtime/cold-execution-resume.js';
import { AppLifecycleError } from '../errors.js';
import { contextHistoryFromRecord, conditionalReentryFromRecord, closureFromRecord, segmentOpenedFromRecord } from '../checkpoint-journal.js';
import { createActiveTurnSegmentJournal, createNativeRecoveryAssets, type NativeRecoveryAssetsReadback } from '../native-recovery-assets.js';
import { readOperationControlFromRecords } from '../operation-control-journal.js';
import { readPreparedExecutionInput, type AdmittedExecutionInput } from '../prepared-execution-input.js';
import { readColdCurrentFromJournal } from './reentry-current-facts.js';

/** Selectors only. The Runtime caller retains the allocation; no new business admission is made. */
export interface RuntimeColdExecutionSourceRequest {
  readonly businessTurnId: string;
  readonly predecessor: ActiveTurnSegmentPredecessorRef;
}

export type ColdExecutionCapture =
  | { readonly version: 1; readonly source: NativeRecoveryAssetsReadback }
  | { readonly version: 2; readonly source: ActiveTurnSegmentCaptureExactRead };

/** Durable floor inputs. Runtime owns validation/selection of the successor epoch. */
export interface ColdExecutionEpochFact {
  readonly owner: 'checkpoint' | 'context' | 'segment' | 'conditional-reentry' | 'closure' | 'operation-control';
  readonly commitRef: JournalCommitRef;
  readonly executionEpoch: number;
}

export interface RuntimeColdExecutionSource {
  readonly allocation: RuntimeExecutionAllocation;
  readonly preparedInput: AdmittedExecutionInput;
  readonly initial: ActiveTurnInitialSegmentSource;
  readonly assignment: WorkAssignment;
  readonly scope: ScopeRef;
  readonly segments: readonly ResumedTurnSegmentOpened[];
  readonly tail: ActiveTurnSegmentPredecessorRef;
  /** Ordered exact captures, retaining original input, accepted prefix, completions and recovery holds. */
  readonly captures: readonly ColdExecutionCapture[];
  /**
   * Ordered exact reads of predecessor segments that were opened and appended
   * records but never committed a recovery receipt. Each carries the committed
   * live prefix cut at its real anchor; it is not a frozen capture and claims no
   * save.
   */
  readonly interruptedSegments: readonly ActiveTurnSegmentInterruptedExactRead[];
  readonly initialOpenPrefix: ActiveTurnInitialOpenExactRead | null;
  readonly initialCompletions: readonly CompletionReadInput[];
  readonly current: ColdCurrentFacts;
  readonly durableEpochs: readonly ColdExecutionEpochFact[];
  readonly retryCycle: RetryCycleControlRecord | null;
  readonly segmentJournal: ActiveTurnSegmentJournalPort;
}

/** Bound once by App composition to actual physical owners, never supplied by the resume consumer. */
export interface ColdExecutionSourceOwners {
  readonly preparedJournal: RuntimeTaskJournalPort;
  readonly journalPath: string;
  readonly journal: JsonlOrganJournal;
  readonly artifactsRoot: string;
  readonly retryJournal: RetryCycleJournalPort;
  readonly principalOwner: string;
}

function missing(reason: string): never {
  throw new AppLifecycleError('cold-execution.source-unavailable', reason,
    'retain the recovery responsibility and resolve the exact physical owner source before resuming',
    'humanagent.app.cold-execution-source');
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

/** Read-only source resolution; does not acquire, admit, calculate a successor epoch or start a driver. */
export async function readColdExecutionSource(
  owners: ColdExecutionSourceOwners,
  input: { readonly allocation: RuntimeExecutionAllocation; readonly request: RuntimeColdExecutionSourceRequest },
): Promise<RuntimeColdExecutionSource> {
  const { allocation, request } = input;
  const preparedInput = readPreparedExecutionInput(owners.preparedJournal, allocation);
  const verification = await owners.journal.verify();
  if (!verification.valid) missing(verification.error ?? 'Organ Journal verification failed');
  const records = verification.records;
  const taskScope = { organId: allocation.scope.organId, taskId: allocation.taskId };
  const coldCurrent = await readColdCurrentFromJournal(
    owners.journal,
    { allocation, businessTurnId: request.businessTurnId },
    owners.principalOwner,
  );
  if (coldCurrent.state !== 'known') missing(coldCurrent.reason);
  const current: ColdCurrentFacts = coldCurrent;

  const completion = new JsonlOperationCompletionJournal({ journal: owners.journal });
  const native = createNativeRecoveryAssets({ journalPath: owners.journalPath,
    journal: owners.journal, assetRoot: owners.artifactsRoot, completionJournal: completion });
  const segmentJournal = createActiveTurnSegmentJournal({ journalPath: owners.journalPath,
    assetRoot: owners.artifactsRoot, completionJournal: completion, businessTurnId: request.businessTurnId });

  const initial = await segmentJournal.readInitialSegmentSource(request.businessTurnId);
  if (!initial) missing('the original initial segment source is missing');

  const binding = initial.kind === 'captured' ? initial.body.binding : initial.binding;
  const initialInputAsset = initial.kind === 'captured' ? initial.body.initialInput : initial.initialInput;

  if (!same(binding.scope, allocation.scope) || !same(binding.assignment.taskId, allocation.taskId)
    || binding.assignment.assignmentId !== allocation.assignmentId
    || binding.assignment.inputRevision !== preparedInput.inputRevision
    || binding.admittedTurn.turnId !== request.businessTurnId
    || !same(allocation.scope.operationId, allocation.operationId)) {
    missing('the original assignment, scope or input revision does not match the retained allocation');
  }

  const rawInput = await new ImmutableAssetStore(owners.artifactsRoot).readEvidence(initialInputAsset.ref);
  if (new TextDecoder('utf-8', { fatal: true }).decode(rawInput) !== preparedInput.input['prompt']) {
    missing('the original immutable input differs from the retained prepared input');
  }

  const segments = await segmentJournal.readSegments(request.businessTurnId);
  const tailSegment = segments.at(-1);
  const tailId = tailSegment?.segmentId ?? request.businessTurnId;
  const receipt = await segmentJournal.readSegmentRecoveryReceipt(tailId);
  if (receipt.status === 'failed' || receipt.status === 'unknown') missing(receipt.reason);
  const tail: ActiveTurnSegmentPredecessorRef = receipt.status === 'exact'
    ? { segmentId: tailId, recoveryAssetsReceiptRef: receipt.recoveryAssetsReceiptRef }
    : receipt.status === 'interrupted'
      ? { segmentId: tailId, interrupted: receipt.anchor }
      : { segmentId: tailId, initialOpen: receipt.anchor };
  if (!same(tail, request.predecessor)) missing('the exact predecessor selector does not match the committed segment tail');

  const tailBinding = tailSegment?.binding ?? binding;
  const currentContext = current.kind === 'checkpoint-bound' ? current.current.context : current.context;
  const currentPositionEpoch = current.kind === 'checkpoint-bound' ? current.current.position.executionEpoch : current.position.executionEpoch;

  if (!same(currentContext.scope, binding.scope)
    || currentContext.agentRuntimeId !== tailBinding.execution.runtimeId
    || currentPositionEpoch !== tailBinding.execution.executionEpoch
    || currentContext.loopCheckpoint.executionEpoch !== tailBinding.execution.executionEpoch) {
    missing('the canonical current context does not match the committed segment tail incarnation');
  }

  let initialOpenPrefix: ActiveTurnInitialOpenExactRead | null = null;
  let initialCompletions: readonly CompletionReadInput[] = [];
  const captures: ColdExecutionCapture[] = [];
  const interruptedSegments: ActiveTurnSegmentInterruptedExactRead[] = [];

  if (initial.kind === 'initial-open') {
    initialOpenPrefix = await segmentJournal.readInitialOpenExact({
      businessTurnId: request.businessTurnId,
      anchor: initial.anchor,
    });
    initialCompletions = await completion.discoverExactExecution({
      execution: {
        ...initial.binding.execution,
        taskId: allocation.taskId,
        operationId: allocation.operationId,
      },
    });
    if (segments.length > 0) {
      const firstSegment = segments[0]!;
      if (firstSegment.predecessor.initialOpen === undefined
        || !same(firstSegment.predecessor.initialOpen, initial.anchor)) {
        missing('the first resumed segment does not bind the original initial-open anchor');
      }
    }
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const closing: ActiveTurnSegmentPredecessorRef = index + 1 < segments.length ? segments[index + 1]!.predecessor : tail;
      if (closing.interrupted !== undefined) {
        interruptedSegments.push(await segmentJournal.readSegmentInterruptedExact({
          businessTurnId: request.businessTurnId,
          predecessor: { segmentId: segment.segmentId, interrupted: closing.interrupted },
        }));
      } else if (closing.initialOpen !== undefined) {
        missing('a successor segment cannot have an initialOpen predecessor');
      } else {
        captures.push({ version: 2, source: await segmentJournal.readSegmentCaptureExact({
          businessTurnId: request.businessTurnId, segmentId: segment.segmentId,
          recoveryAssetsReceiptRef: closing.recoveryAssetsReceiptRef,
        }) });
      }
    }
  } else {
    // The original immutable v1 capture is closed by the first resumed segment's
    // exact predecessor receipt, or by the tail receipt when no resumed segment
    // exists yet. The v1 base is always a saved predecessor.
    const initialClosing: ActiveTurnSegmentPredecessorRef = segments.length > 0 ? segments[0]!.predecessor : tail;
    if (initialClosing.interrupted !== undefined || initialClosing.initialOpen !== undefined) {
      missing('the original v1 base is not a saved predecessor');
    }
    const original = await native.readRecoveryAssetsExact(initialClosing.recoveryAssetsReceiptRef);
    if (original.receipt.turnId !== request.businessTurnId || !same(original.prepared.body, initial.body)) {
      missing('the exact v1 predecessor receipt does not bind the original capture');
    }
    captures.push({ version: 1, source: original });
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const closing: ActiveTurnSegmentPredecessorRef = index + 1 < segments.length ? segments[index + 1]!.predecessor : tail;
      if (closing.interrupted !== undefined) {
        interruptedSegments.push(await segmentJournal.readSegmentInterruptedExact({
          businessTurnId: request.businessTurnId,
          predecessor: { segmentId: segment.segmentId, interrupted: closing.interrupted },
        }));
      } else if (closing.initialOpen !== undefined) {
        missing('a successor segment cannot have an initialOpen predecessor');
      } else {
        captures.push({ version: 2, source: await segmentJournal.readSegmentCaptureExact({
          businessTurnId: request.businessTurnId, segmentId: segment.segmentId,
          recoveryAssetsReceiptRef: closing.recoveryAssetsReceiptRef,
        }) });
      }
    }
  }

  // The current operation-control namespace is the exact physical incarnation
  // the canonical position/context already bound to the committed segment tail.
  const control = readOperationControlFromRecords(records, { scope: taskScope,
    agentRuntimeId: tailBinding.execution.runtimeId, harnessExecutionEpoch: tailBinding.execution.executionEpoch });
  if (control.state !== 'complete') missing(control.reason);
  const durableEpochs: ColdExecutionEpochFact[] = [];
  for (const record of records) {
    if (record.scope.organId.value !== taskScope.organId.value || record.scope.taskId?.value !== taskScope.taskId.value) continue;
    const addEpoch = (owner: ColdExecutionEpochFact['owner'], executionEpoch: number): void => {
      if (!record.commitId) missing('a durable floor source has no commit identity');
      durableEpochs.push({ owner, executionEpoch,
        commitRef: { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest } });
    };
    if (record.kind === 'checkpoint' && record.checkpoint) {
      addEpoch('checkpoint', record.checkpoint.executionEpoch);
    }
    const context = contextHistoryFromRecord(record);
    if (context) addEpoch('context', context.loopCheckpoint.executionEpoch);
    const segment = segmentOpenedFromRecord(record);
    if (segment) addEpoch('segment', segment.binding.execution.executionEpoch);
    const transition = conditionalReentryFromRecord(record);
    if (transition) addEpoch('conditional-reentry', transition.newExecutionEpoch);
    const closure = closureFromRecord(record);
    if (closure && 'closureKind' in closure && closure.closureKind === 'checkpoint' && closure.recoveryBinding) {
      addEpoch('closure', closure.recoveryBinding.coreClosure.executionEpoch);
    }
    // The floor scans every scoped coverage carrier directly, so a narrow
    // current-namespace read never drops a valid historical epoch source.
    if (record.payload?.['kind'] === 'operation-control-coverage/v1') {
      const epoch = record.payload['harnessExecutionEpoch'];
      if (typeof epoch === 'number') addEpoch('operation-control', epoch);
    }
  }
  control.operations.forEach((operation, index) => durableEpochs.push({ owner: 'operation-control',
    commitRef: control.operationCommits[index]!, executionEpoch: operation.binding.harnessExecutionEpoch }));
  const retryCycle = await owners.retryJournal.loadCycle(retryCycleId({
    assignmentId: binding.assignment.assignmentId, initialExecutionEpoch: allocation.executionEpoch,
  }));
  if (retryCycle && (retryCycle.assignmentId !== binding.assignment.assignmentId
    || retryCycle.initialExecutionEpoch !== allocation.executionEpoch)) {
    missing('the durable retry cycle does not match the retained assignment and initial epoch');
  }
  return { allocation, preparedInput, initial, assignment: binding.assignment, scope: binding.scope,
    segments, tail, captures, interruptedSegments, initialOpenPrefix, initialCompletions,
    current, durableEpochs, retryCycle, segmentJournal };
}

/**
 * Canonical cold-resume request selector.
 *
 * It discovers the unique retained prepared allocation from `owners.preparedJournal`,
 * resolves the matching committed `active-turn:*:binding-opened` record in `owners.journal`,
 * reads the committed segment tail and its recovery receipt via `createActiveTurnSegmentJournal`,
 * and validates the full source with `readColdExecutionSource` before returning.
 */
export async function resolveColdExecutionResumeRequest(
  owners: ColdExecutionSourceOwners,
  input: {
    readonly taskId: TaskId;
    readonly operationId: OperationId;
  },
): Promise<RuntimeColdExecutionResumeRequest> {
  if (!input.taskId?.value || !input.operationId?.value) {
    missing('the taskId and operationId are required to resolve a cold execution resume request');
  }
  const preparedRecords = owners.preparedJournal.replay().filter(
    (record): record is Extract<ReturnType<typeof owners.preparedJournal.replay>[number], { kind: 'operation.prepared' }> =>
      record.kind === 'operation.prepared'
      && record.allocation.taskId.value === input.taskId.value
      && record.allocation.operationId.value === input.operationId.value,
  );
  if (preparedRecords.length !== 1) {
    missing('the retained execution has no single prepared allocation for the task and operation');
  }
  const allocation = preparedRecords[0]!.allocation;
  const taskScope = { organId: allocation.scope.organId, taskId: allocation.taskId };
  const taskBindings = await listTaskActiveTurnBindings({
    journal: owners.journal,
    scope: taskScope,
  });
  const preparedInput = readPreparedExecutionInput(owners.preparedJournal, allocation);
  const matching = taskBindings.filter((entry) => {
    return same(entry.binding.scope, allocation.scope)
      && entry.binding.assignment.assignmentId === allocation.assignmentId
      && same(entry.binding.assignment.taskId, allocation.taskId)
      && entry.binding.assignment.inputRevision === preparedInput.inputRevision;
  });
  if (matching.length !== 1) {
    missing('the retained execution allocation has no single committed active-turn binding');
  }
  const businessTurnId = matching[0]!.binding.admittedTurn.turnId;
  const completion = new JsonlOperationCompletionJournal({ journal: owners.journal });
  const segmentJournal = createActiveTurnSegmentJournal({
    journalPath: owners.journalPath,
    assetRoot: owners.artifactsRoot,
    completionJournal: completion,
    businessTurnId,
  });
  const segments = await segmentJournal.readSegments(businessTurnId);
  const tailSegment = segments.at(-1);
  const tailId = tailSegment?.segmentId ?? businessTurnId;
  const receipt = await segmentJournal.readSegmentRecoveryReceipt(tailId);
  if (receipt.status === 'failed' || receipt.status === 'unknown') {
    missing(receipt.reason);
  }
  const predecessor: ActiveTurnSegmentPredecessorRef = receipt.status === 'exact'
    ? { segmentId: tailId, recoveryAssetsReceiptRef: receipt.recoveryAssetsReceiptRef }
    : receipt.status === 'interrupted'
      ? { segmentId: tailId, interrupted: receipt.anchor }
      : { segmentId: tailId, initialOpen: receipt.anchor };

  await readColdExecutionSource(owners, {
    allocation,
    request: { businessTurnId, predecessor },
  });

  return {
    businessTurnId,
    predecessor,
  };
}
