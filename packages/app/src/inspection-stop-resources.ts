import {
  canonicalJsonStringify,
  type ActiveTurnBinding,
  type ScopeRef,
  type TaskIdentityScope,
} from '../../contracts/src/index.js';
import type { ResumedTurnSegmentOpened } from '../../contracts/src/active-turn-segments.js';
import { listTaskActiveTurnBindings } from '../../adapters/jsonl/src/active-turn.js';
import { JournalIntegrityError, type JsonlOrganJournal } from '../../adapters/jsonl/src/index.js';
import type {
  InspectionRuntimeResourceReader,
  InspectionStopCaptureSource,
} from '../../runtime/src/agent-loop/inspection-runtime-helpers.js';
import type {
  ReviewedBoundaryRecoveryAssets,
  ReviewedBoundaryRecoveryAssetsPort,
} from '../../runtime/src/agent-loop/reviewed-milestone-boundary.js';
import type { CommittedCheckpointRecord } from '../../runtime/src/checkpoints/ports.js';
import type { ActiveTurnSegmentJournalPort } from '../../runtime/src/context/active-turn-journal.js';
import { projectAdmittedTurnIdentityV1 } from '../../runtime/src/context/semantic-history.js';
import type { OperationCompletionJournalPort } from '../../runtime/src/gateway/operation-completion.js';
import { readCommittedNativeSegmentSource } from './checkpoint-journal.js';
import {
  createActiveTurnSegmentJournal,
  createNativeRecoveryAssets,
  RecoveryAssetsIntegrityError,
} from './native-recovery-assets.js';

export interface InspectionStopResourceReaderInput {
  readonly journal: JsonlOrganJournal;
  readonly journalPath: string;
  readonly assetRoot: string;
  readonly completionJournalPath?: string;
  readonly completionJournal?: OperationCompletionJournalPort;
}

type SegmentCandidate =
  | {
      readonly kind: 'initial';
      readonly binding: ActiveTurnBinding;
      readonly segments: ActiveTurnSegmentJournalPort;
    }
  | {
      readonly kind: 'resumed';
      readonly binding: ActiveTurnBinding;
      readonly segments: ActiveTurnSegmentJournalPort;
      readonly opened: ResumedTurnSegmentOpened;
    };

function taskIdentityScope(scope: ScopeRef): TaskIdentityScope {
  if (scope.taskId === undefined) {
    throw new JournalIntegrityError('inspection stop resource requires an exact task scope');
  }
  return { organId: scope.organId, taskId: scope.taskId };
}

function sameFullScope(left: ScopeRef, right: ScopeRef): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function exactReceiptRef(result: Awaited<ReturnType<
  ActiveTurnSegmentJournalPort['readSegmentRecoveryReceipt']
>>, label: string): string {
  if (result.status === 'exact') return result.recoveryAssetsReceiptRef;
  if (result.status === 'failed') {
    throw new RecoveryAssetsIntegrityError(`${label} recovery receipt failed: ${result.reason}`);
  }
  throw new RecoveryAssetsIntegrityError(`${label} recovery receipt is ${result.status}`);
}

/**
 * App-side physical locator for one inspection stop checkpoint. It maps the
 * checkpoint's committed task scope and execution epoch to the exact committed
 * active-turn binding or segment. Recovery, cut, occurrence and business
 * consistency stay with the Runtime helper.
 */
export function createInspectionStopResourceReader(
  input: InspectionStopResourceReaderInput,
): Pick<InspectionRuntimeResourceReader, 'forCheckpoint'> {
  const native = createNativeRecoveryAssets({
    journal: input.journal,
    journalPath: input.journalPath,
    assetRoot: input.assetRoot,
    ...(input.completionJournal === undefined
      ? (input.completionJournalPath === undefined ? {} : { completionJournalPath: input.completionJournalPath })
      : { completionJournal: input.completionJournal }),
  });

  function segmentsFor(businessTurnId: string): ActiveTurnSegmentJournalPort {
    return createActiveTurnSegmentJournal({
      journalPath: input.journalPath,
      assetRoot: input.assetRoot,
      businessTurnId,
      ...(input.completionJournal === undefined
        ? (input.completionJournalPath === undefined ? {} : { completionJournalPath: input.completionJournalPath })
        : { completionJournal: input.completionJournal }),
    });
  }

  async function committedBindingForTurn(
    scope: TaskIdentityScope,
    businessTurnId: string,
  ): Promise<ActiveTurnBinding> {
    const matches = (await listTaskActiveTurnBindings({ journal: input.journal, scope }))
      .filter((entry) => entry.binding.admittedTurn.turnId === businessTurnId);
    if (matches.length === 0) {
      throw new JournalIntegrityError(`inspection stop business turn binding is not committed: ${businessTurnId}`);
    }
    if (matches.length > 1) {
      throw new JournalIntegrityError(`inspection stop business turn binding is ambiguous: ${businessTurnId}`);
    }
    return matches[0]!.binding;
  }

  async function readBoundaryRecoveryAssetsExact(receiptRef: string): Promise<ReviewedBoundaryRecoveryAssets> {
    const readback = await native.readCaptureAssetsExact(receiptRef);
    if (readback.version === 1) {
      return { version: 1, assets: readback.assets };
    }

    const body = readback.assets.prepared.body;
    const businessTurnId = body.businessTurnRef.businessTurnId;
    const scope = taskIdentityScope(body.binding.scope);
    const binding = await committedBindingForTurn(scope, businessTurnId);
    const segments = segmentsFor(businessTurnId);
    const matches = (await segments.readSegments(businessTurnId))
      .filter((opened) => opened.segmentId === body.segmentId);
    if (matches.length === 0) {
      throw new JournalIntegrityError(`inspection stop segment is not committed: ${body.segmentId}`);
    }
    if (matches.length > 1) {
      throw new JournalIntegrityError(`inspection stop segment is ambiguous: ${body.segmentId}`);
    }
    const source = await readCommittedNativeSegmentSource({
      journal: input.journal,
      originalAdmittedTurn: binding.admittedTurn,
      opened: matches[0]!,
    });
    return { version: 2, assets: readback.assets, source };
  }

  const assets: ReviewedBoundaryRecoveryAssetsPort = {
    readRecoveryAssetsExact: async (receiptRef) => await native.readRecoveryAssetsExact(receiptRef),
    readBoundaryRecoveryAssetsExact,
  };

  async function forCheckpoint(
    checkpoint: CommittedCheckpointRecord,
  ): Promise<InspectionStopCaptureSource | null> {
    const scope = taskIdentityScope(checkpoint.checkpoint.scope);
    const executionEpoch = checkpoint.checkpoint.executionEpoch;
    const candidates: SegmentCandidate[] = [];

    for (const entry of await listTaskActiveTurnBindings({ journal: input.journal, scope })) {
      const businessTurnId = entry.binding.admittedTurn.turnId;
      const segments = segmentsFor(businessTurnId);
      if (sameFullScope(entry.binding.scope, checkpoint.checkpoint.scope)
        && entry.binding.execution.executionEpoch === executionEpoch) {
        candidates.push({ kind: 'initial', binding: entry.binding, segments });
      }
      for (const opened of await segments.readSegments(businessTurnId)) {
        if (sameFullScope(opened.binding.scope, checkpoint.checkpoint.scope)
          && opened.binding.execution.executionEpoch === executionEpoch) {
          candidates.push({ kind: 'resumed', binding: entry.binding, segments, opened });
        }
      }
    }

    if (candidates.length > 1) {
      throw new JournalIntegrityError(
        'inspection stop resource physical binding is ambiguous: multiple candidates for the same task scope and execution epoch',
      );
    }
    if (candidates.length === 0) return null;
    const selected = candidates[0]!;

    const turn = projectAdmittedTurnIdentityV1(selected.binding.admittedTurn);
    if (selected.kind === 'initial') {
      const businessTurnId = selected.binding.admittedTurn.turnId;
      const initial = await selected.segments.readInitialSegmentSource(businessTurnId);
      if (initial === null) {
        throw new RecoveryAssetsIntegrityError(
          `inspection stop initial segment is not committed: ${businessTurnId}`,
        );
      }
      const receiptRef = exactReceiptRef(
        await selected.segments.readSegmentRecoveryReceipt(businessTurnId),
        `inspection stop initial segment ${businessTurnId}`,
      );
      const readback = await native.readCaptureAssetsExact(receiptRef);
      if (readback.version !== 1) {
        throw new RecoveryAssetsIntegrityError('inspection stop initial segment resolved to a non-v1 capture');
      }
      return {
        turn,
        boundaryId: readback.assets.receipt.boundaryId,
        recoveryAssetsReceiptRef: readback.assets.receipt.commitIdentity,
        assets,
        segments: selected.segments,
      };
    }

    const receiptRef = exactReceiptRef(
      await selected.segments.readSegmentRecoveryReceipt(selected.opened.segmentId),
      `inspection stop resumed segment ${selected.opened.segmentId}`,
    );
    const readback = await native.readCaptureAssetsExact(receiptRef);
    if (readback.version !== 2) {
      throw new RecoveryAssetsIntegrityError('inspection stop resumed segment resolved to a non-v2 capture');
    }
    if (readback.assets.receipt.businessTurnId !== selected.binding.admittedTurn.turnId
      || readback.assets.receipt.segmentId !== selected.opened.segmentId) {
      throw new RecoveryAssetsIntegrityError('inspection stop resumed receipt does not match the selected segment');
    }
    const source = await readCommittedNativeSegmentSource({
      journal: input.journal,
      originalAdmittedTurn: selected.binding.admittedTurn,
      opened: selected.opened,
    });
    return {
      turn,
      boundaryId: readback.assets.receipt.boundaryId,
      recoveryAssetsReceiptRef: readback.assets.receipt.commitIdentity,
      segmentSource: source,
      assets,
      segments: selected.segments,
    };
  }

  return { forCheckpoint };
}
