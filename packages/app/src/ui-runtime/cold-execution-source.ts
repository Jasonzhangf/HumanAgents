import { canonicalJsonStringify, type JournalCommitRef, type ScopeRef, type WorkAssignment } from '../../../contracts/src/index.js';
import type { ActiveTurnInitialSegmentCapture, ActiveTurnSegmentPredecessorRef,
  ResumedTurnSegmentOpened } from '../../../contracts/src/active-turn-segments.js';
import { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { JsonlOperationCompletionJournal } from '../../../adapters/jsonl/src/operation-completion.js';
import { ImmutableAssetStore } from '../../../adapters/filesystem/src/index.js';
import type { ActiveTurnSegmentCaptureExactRead, ActiveTurnSegmentJournalPort } from '../../../runtime/src/context/active-turn-journal.js';
import type { ReentryCurrentFacts } from '../../../runtime/src/checkpoints/conditional-reentry.js';
import { retryCycleId, type RetryCycleControlRecord, type RetryCycleJournalPort } from '../../../runtime/src/orchestration/retry-cycle.js';
import type { RuntimeExecutionAllocation, RuntimeTaskJournalPort } from '../../../runtime/src/ui-runtime/coordinator.js';
import { AppLifecycleError } from '../errors.js';
import { contextHistoryFromRecord, conditionalReentryFromRecord, closureFromRecord, segmentOpenedFromRecord } from '../checkpoint-journal.js';
import { createActiveTurnSegmentJournal, createNativeRecoveryAssets, type NativeRecoveryAssetsReadback } from '../native-recovery-assets.js';
import { readOperationControlFromRecords } from '../operation-control-journal.js';
import { readPreparedExecutionInput, type AdmittedExecutionInput } from '../prepared-execution-input.js';
import { readCurrentFromRecords } from './reentry-current-facts.js';

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
  readonly initial: ActiveTurnInitialSegmentCapture;
  readonly assignment: WorkAssignment;
  readonly scope: ScopeRef;
  readonly segments: readonly ResumedTurnSegmentOpened[];
  readonly tail: ActiveTurnSegmentPredecessorRef;
  /** Ordered exact captures, retaining original input, accepted prefix, completions and recovery holds. */
  readonly captures: readonly ColdExecutionCapture[];
  readonly predecessor: ColdExecutionCapture;
  readonly current: ReentryCurrentFacts;
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
  const current = readCurrentFromRecords(records, taskScope);
  if (current.state !== 'known') missing(current.reason);
  const completion = new JsonlOperationCompletionJournal({ journal: owners.journal });
  const native = createNativeRecoveryAssets({ journalPath: owners.journalPath,
    journal: owners.journal, assetRoot: owners.artifactsRoot, completionJournal: completion });
  const segmentJournal = createActiveTurnSegmentJournal({ journalPath: owners.journalPath,
    assetRoot: owners.artifactsRoot, completionJournal: completion, businessTurnId: request.businessTurnId });
  const initial = await segmentJournal.readInitialSegmentCapture(request.businessTurnId);
  if (!initial) missing('the original v1 capture is missing');
  const binding = initial.body.binding;
  if (!same(binding.scope, allocation.scope) || !same(binding.assignment.taskId, allocation.taskId)
    || binding.assignment.assignmentId !== allocation.assignmentId
    || binding.assignment.inputRevision !== preparedInput.inputRevision
    || binding.admittedTurn.turnId !== request.businessTurnId
    || !same(allocation.scope.operationId, allocation.operationId)) {
    missing('the original assignment, scope or input revision does not match the retained allocation');
  }
  const rawInput = await new ImmutableAssetStore(owners.artifactsRoot).readEvidence(initial.body.initialInput.ref);
  if (new TextDecoder('utf-8', { fatal: true }).decode(rawInput) !== preparedInput.input['prompt']) {
    missing('the original immutable input differs from the retained prepared input');
  }
  const segments = await segmentJournal.readSegments(request.businessTurnId);
  const tailSegment = segments.at(-1);
  const tailId = tailSegment?.segmentId ?? request.businessTurnId;
  const receipt = await segmentJournal.readSegmentRecoveryReceipt(tailId);
  if (receipt.status !== 'exact') missing(receipt.reason);
  const tail = { segmentId: tailId, recoveryAssetsReceiptRef: receipt.recoveryAssetsReceiptRef };
  if (!same(tail, request.predecessor)) missing('the exact predecessor selector does not match the committed segment tail');
  const tailBinding = tailSegment?.binding ?? binding;
  if (!same(current.context.scope, binding.scope)
    || current.context.agentRuntimeId !== tailBinding.execution.runtimeId
    || current.position.executionEpoch !== tailBinding.execution.executionEpoch
    || current.context.loopCheckpoint.executionEpoch !== tailBinding.execution.executionEpoch) {
    missing('the canonical current context does not match the committed segment tail incarnation');
  }
  const initialReceipt = segments[0]?.predecessor.recoveryAssetsReceiptRef ?? tail.recoveryAssetsReceiptRef;
  const original = await native.readRecoveryAssetsExact(initialReceipt);
  if (original.receipt.turnId !== request.businessTurnId || !same(original.prepared.body, initial.body)) {
    missing('the exact v1 predecessor receipt does not bind the original capture');
  }
  const captures: ColdExecutionCapture[] = [{ version: 1, source: original }];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const exactReceipt = segments[index + 1]?.predecessor.recoveryAssetsReceiptRef ?? tail.recoveryAssetsReceiptRef;
    captures.push({ version: 2, source: await segmentJournal.readSegmentCaptureExact({
      businessTurnId: request.businessTurnId, segmentId: segment.segmentId, recoveryAssetsReceiptRef: exactReceipt,
    }) });
  }
  const control = readOperationControlFromRecords(records, { scope: taskScope });
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
    // readOperationControlFromRecords has validated all scoped coverage carriers.
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
    segments, tail, captures, predecessor: captures[captures.length - 1]!, current, durableEpochs, retryCycle, segmentJournal };
}
