import { canonicalJsonStringify } from '../../../contracts/src/index.js';
import type { NativeSaveIntent } from '../../../runtime/src/checkpoints/native-save-contract.js';
import { isNativeSegmentSaveIntentV2, NATIVE_SAVE_PHASES } from '../../../runtime/src/checkpoints/native-save-contract.js';
import { readCheckpointClosurePreparation } from '../../../runtime/src/checkpoints/closure.js';
import { submitCheckpoint } from '../../../runtime/src/checkpoints/submission.js';
import { createJsonlNativeTurnSave } from '../native-default-composition.js';
import { createJsonlCheckpointClosurePort, createJsonlCheckpointJournal, createJsonlNativeSegmentSave } from '../checkpoint-journal.js';
import { createNativeRecoveryAssets } from '../native-recovery-assets.js';
import type { NativeExecutionInput } from './native-execution.js';
import type { ActiveTurnSegmentJournalPort } from '../../../runtime/src/context/active-turn-journal.js';

/** Exact historical boundary owner. It owns no live Provider and cannot generate. */
export function createNativeBoundaryContinuation(input: Pick<NativeExecutionInput,
  'journal' | 'filePath' | 'artifactsRoot' | 'activeTurnJournal' | 'rawContent' | 'timeAuthority' | 'completionJournal'> & {
  readonly intent: NativeSaveIntent;
  readonly segmentJournal: ActiveTurnSegmentJournalPort;
}) {
  const intent = structuredClone(input.intent);
  const checkpoints = createJsonlCheckpointJournal(input);
  const closures = createJsonlCheckpointClosurePort(input);
  const recovery = createNativeRecoveryAssets({ journalPath: input.filePath, journal: input.journal,
    assetRoot: input.artifactsRoot, ...(input.completionJournal === undefined ? {} : { completionJournal: input.completionJournal }) });
  async function prepareCapture(boundaryId: string) {
    if (boundaryId !== intent.key.boundaryId) throw new Error('historical boundary selector conflicts');
    const assets = isNativeSegmentSaveIntentV2(intent)
      ? await recovery.readSegmentRecoveryAssetsExact(intent.recoveryAssets.captureRef)
      : await recovery.readRecoveryAssetsExact(intent.recoveryAssets.captureRef);
    return { captureRef: assets.receipt.commitIdentity, prepared: assets.prepared };
  }
  async function prepareTurnClosure(checkpoint: Parameters<typeof readCheckpointClosurePreparation>[1], boundaryId: string) {
    if (canonicalJsonStringify(checkpoint) !== canonicalJsonStringify(intent.checkpoint.checkpoint)) {
      throw new Error('historical checkpoint candidate conflicts');
    }
    const preparation = await readCheckpointClosurePreparation(closures, checkpoint);
    if (!preparation) throw new Error('exact historical bound closure preparation is absent; boundary remains held');
    const capture = await prepareCapture(boundaryId);
    return { preparation, turnRecoveryRef: capture.captureRef };
  }
  const common = { ...input,
    async prepareClosure(value: NativeSaveIntent, relationship: Parameters<Parameters<typeof createJsonlNativeTurnSave>[0]['prepareClosure']>[1]) {
      if (canonicalJsonStringify(value) !== canonicalJsonStringify(intent)) throw new Error('historical native intent changed');
      const committed = await checkpoints.readCommitted(intent.key.turn.scopeRef, intent.key.checkpoint.id);
      if (!committed) throw new Error('historical checkpoint is not committed');
      const prepared = await prepareTurnClosure(relationship.checkpoint, intent.key.boundaryId);
      return (await submitCheckpoint({ journal: checkpoints, closurePort: closures, ownerId: intent.ownerId,
        checkpoint: relationship.checkpoint, previous: committed.previous, source: intent.closure.source, ...prepared })).closure;
    } };
  const owner = isNativeSegmentSaveIntentV2(intent)
    ? createJsonlNativeSegmentSave({ ...common, readPreparedCapture: async (ref) => (await recovery.readSegmentRecoveryAssetsExact(ref)).prepared })
    : createJsonlNativeTurnSave({ ...common, readPreparedCapture: async (ref) => (await recovery.readRecoveryAssetsExact(ref)).prepared });
  return { prepareCapture, prepareTurnClosure, savePorts: owner.ports, saveProgress: owner.progress,
    recoveryAssetsReader: { readRecoveryAssetsExact: recovery.readRecoveryAssetsExact,
      async readBoundaryRecoveryAssetsExact(ref: string) {
        return isNativeSegmentSaveIntentV2(intent)
          ? { version: 2 as const, assets: await recovery.readSegmentRecoveryAssetsExact(ref), source: intent.source }
          : { version: 1 as const, assets: await recovery.readRecoveryAssetsExact(ref) };
      } },
    async save(value: NativeSaveIntent) {
      if (canonicalJsonStringify(value) !== canonicalJsonStringify(intent)) throw new Error('historical native intent changed');
      const checkpoint = await checkpoints.readCommitted(intent.key.turn.scopeRef, intent.key.checkpoint.id);
      if (!checkpoint || canonicalJsonStringify(checkpoint.checkpoint) !== canonicalJsonStringify(intent.checkpoint.checkpoint)) {
        throw new Error('historical exact checkpoint readback conflicts');
      }
      const binding = await checkpoints.readCheckpointRecoveryBinding(intent.key.turn.scopeRef, checkpoint.commitRef);
      if (!binding || binding.turnRecoveryRef !== intent.recoveryAssets.captureRef) {
        throw new Error('historical native save has no exact bound capture relationship');
      }
      return owner.controller.run(intent);
    },
    async readSaveStageFacts(): Promise<import('../../../runtime/src/ui-runtime/current-state.js').RuntimeTaskStageFacts> {
      const progress = await owner.progress.readExact(intent.key);
      if (progress.state !== 'found') return { state: 'unknown', reason: 'historical native progress is not exact-readable' };
      if (progress.progress.phases.some((phase) => phase.state === 'failed' || phase.state === 'unknown')) {
        return { state: 'unknown', reason: progress.progress.firstErrorRef ?? 'historical native phase is unresolved' };
      }
      return { state: 'known', stages: NATIVE_SAVE_PHASES.map((stageId) => {
        const phase = progress.progress.phases.find((item) => item.phase === stageId)!;
        return phase.state === 'committed' ? { stageId, state: 'succeeded' as const, value: phase, evidenceRefs: [phase.receiptRef] }
          : { stageId, state: 'not-executed' as const, blockedByStage: stageId, causeRef: intent.recoveryAssets.captureRef,
              recoveryRef: intent.recoveryAssets.captureRef };
      }) };
    },
  };
}
