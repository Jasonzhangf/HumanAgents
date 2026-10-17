import {
  assertSameScope,
  canonicalJsonStringify,
  validatePreparedRecoveryCapture,
  type CompletionReadInput,
  type JournalCommitRef,
  type PreparedRecoveryCapture,
  type ProviderSubmitResult,
  type RecoveryHoldFacts,
} from '../../../contracts/src/index.js';
import type { PreparedActiveTurnSegmentCaptureV2 } from '../../../contracts/src/active-turn-segments.js';
import type { ProviderRequestContextHook, ProviderRequestContextUnit, RequestScopedInstructions } from '../../../contracts/src/provider-request-context.js';
import { ProviderAgentDriver, type ProviderAgentDriverOptions } from '../../../adapters/provider/src/agent-driver.js';
import type { ProviderEvidenceSink } from '../../../adapters/provider/src/evidence.js';
import { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { ActiveTurnContext, ActiveTurnSegmentContext } from '../../../runtime/src/context/active-turn-context.js';
import { ActiveTurnSegmentRecoveryCapture } from '../../../runtime/src/context/active-turn-capture.js';
import type { ActiveTurnJournalPort, ActiveTurnSegmentJournalPort } from '../../../runtime/src/context/active-turn-journal.js';
import { readSemanticTurnContext,
  type SemanticReasoningLineageFilterV1 } from '../../../runtime/src/context/semantic-turn-context-reader.js';
import type { SemanticHistoryExactLookupV1 } from '../../../runtime/src/context/semantic-history.js';
import { prepareCheckpointClosure, type CheckpointClosurePermissionEvidence } from '../../../runtime/src/checkpoints/closure.js';
import { submitCheckpoint } from '../../../runtime/src/checkpoints/submission.js';
import { checkpointCommitId } from '../../../runtime/src/checkpoints/coordinator.js';
import type { ContextHistoryPort } from '../../../runtime/src/checkpoints/ports.js';
import { NATIVE_SAVE_PHASES, isNativeSegmentSaveIntentV2, type NativeSaveIntent } from '../../../runtime/src/checkpoints/native-save-contract.js';
import type { OperationControlReadback, OperationControlSelector } from '../../../runtime/src/gateway/ports.js';
import type { OperationCompletionJournalPort } from '../../../runtime/src/gateway/operation-completion.js';
import { createJsonlNativeTurnSave } from '../native-default-composition.js';
import { createNativeRecoveryAssets } from '../native-recovery-assets.js';
import { createJsonlCheckpointClosurePort, createJsonlCheckpointJournal, createJsonlNativeSegmentSave,
  createJsonlSemanticHistoryJournal, createNativeSegmentRequestContext,
  verifiedDeadEndContextUnits } from '../checkpoint-journal.js';

export type NativeAdmittedExecution =
  | { readonly version: 1; readonly activeTurn: ActiveTurnContext }
  | { readonly version: 2; readonly activeTurn: ActiveTurnSegmentContext; readonly segmentJournal: ActiveTurnSegmentJournalPort;
      readonly source: import('../../../contracts/src/active-turn-segments.js').NativeSegmentSaveSourceV2 };

/** Current owner facts. Null is unknown, never a successful empty recovery. */
export interface NativeExecutionOwnerReaders {
  readControl(selector: OperationControlSelector): Promise<OperationControlReadback>;
  readClosureFacts(contextCommitRef: JournalCommitRef): Promise<{
    readonly permission: CheckpointClosurePermissionEvidence;
    readonly hardBlockers: readonly string[];
    readonly unreturnedCallRefs: readonly string[];
    readonly unresolvedOperationRefs: readonly string[];
  } | null>;
  readCaptureReferences(): Promise<{
    readonly completionLookups: readonly CompletionReadInput[];
    readonly recovery: RecoveryHoldFacts;
    readonly checkpointPath: PreparedRecoveryCapture['body']['checkpointPath'];
    readonly completionRefs: PreparedRecoveryCapture['body']['completionRefs'];
  }>;
}

export interface NativeExecutionInput {
  readonly admitted: NativeAdmittedExecution;
  readonly provider: Omit<ProviderAgentDriverOptions, 'rawEvidence' | 'acceptRawFact' | 'registerRequest' | 'requestContext' | 'now'>;
  readonly journal: JsonlOrganJournal;
  readonly filePath: string;
  readonly artifactsRoot: string;
  readonly activeTurnJournal: ActiveTurnJournalPort;
  /** Per-turn segment reader for prior completed v2 turns; the query's turn ID is the authority. */
  readonly segmentJournalFor?: (businessTurnId: string) => Pick<ActiveTurnSegmentJournalPort, 'readSegmentRecords'>;
  /** Actual shared completion port. Recovery-assets cold reads resolve completion truth through it. */
  readonly completionJournal?: OperationCompletionJournalPort;
  readonly rawEvidence: ProviderEvidenceSink;
  readonly rawContent: Parameters<typeof createJsonlNativeTurnSave>[0]['rawContent'];
  readonly fullContext: ContextHistoryPort;
  readonly owners: NativeExecutionOwnerReaders;
  readonly timeAuthority: Parameters<typeof createJsonlNativeTurnSave>[0]['timeAuthority'];
  readonly now: () => Date;
  readonly rules: readonly string[];
  readonly priorCompletedTurns: readonly SemanticHistoryExactLookupV1[];
  /** Exact canonical active context receipt; absent only before any bound closure. */
  readonly activeContextCommitRef?: JournalCommitRef;
  /** Active-reasoning filter derived by the App journal owner. */
  readonly reasoningLineage?: SemanticReasoningLineageFilterV1;
  readonly orientation: (request: Parameters<ProviderRequestContextHook>[0]) => Promise<string | undefined>;
}

/** Concrete App adapter for an already admitted service allocation. Runtime retains decisions. */
export function createNativeExecution(input: NativeExecutionInput) {
  const admitted = input.admitted;
  const active = admitted.activeTurn;
  const binding = admitted.version === 1 ? admitted.activeTurn.activeBinding : admitted.activeTurn.segmentBinding();
  assertSameScope(binding.scope, input.provider.scope);
  if (binding.execution.runtimeId !== input.provider.runtimeId
    || binding.execution.executionEpoch !== input.provider.executionEpoch
    || binding.assignment.taskId.value !== input.provider.taskId.value
    || binding.assignment.assignmentId !== input.provider.assignmentId
    || binding.scope.operationId?.value !== input.provider.operationId.value) {
    throw new Error('native driver must use the actual admitted binding');
  }
  const checkpoints = createJsonlCheckpointJournal({ filePath: input.filePath, journal: input.journal });
  const closures = createJsonlCheckpointClosurePort({ filePath: input.filePath, journal: input.journal });
  const recovery = createNativeRecoveryAssets({ journalPath: input.filePath, journal: input.journal,
    assetRoot: input.artifactsRoot,
    ...(input.completionJournal === undefined ? {} : { completionJournal: input.completionJournal }) });
  const semantic = createJsonlSemanticHistoryJournal({ filePath: input.filePath, journal: input.journal,
    artifactsRoot: input.artifactsRoot, activeTurnJournal: input.activeTurnJournal,
    ...(input.segmentJournalFor === undefined ? {} : { segmentJournalFor: input.segmentJournalFor }),
    rawContent: input.rawContent, timeAuthority: input.timeAuthority });

  async function latestFullContext() {
    if (input.activeContextCommitRef !== undefined) {
      const record = await input.fullContext.readContextCommit(binding.scope, input.activeContextCommitRef);
      if (record.agentRuntimeId !== binding.execution.runtimeId
        || record.loopCheckpoint.executionEpoch !== binding.execution.executionEpoch) {
        throw new Error('native full I5 context does not match the admitted runtime epoch');
      }
      return { record, commitRef: input.activeContextCommitRef };
    }
    const head = await input.fullContext.readContextHistory({ scope: binding.scope, agentRuntimeId: binding.execution.runtimeId, limit: 1 });
    if (!head.currentContextCommitRef) throw new Error('native request requires committed full I5 context');
    const record = await input.fullContext.readContextCommit(binding.scope, head.currentContextCommitRef);
    if (record.agentRuntimeId !== binding.execution.runtimeId || record.loopCheckpoint.executionEpoch !== binding.execution.executionEpoch) {
      throw new Error('native full I5 context does not match the admitted runtime epoch');
    }
    return { record, commitRef: head.currentContextCommitRef };
  }

  const nativeContext: ProviderRequestContextHook = admitted.version === 2
    ? createNativeSegmentRequestContext({ activeTurn: admitted.activeTurn, segmentJournal: admitted.segmentJournal,
      history: semantic, priorCompletedTurns: input.priorCompletedTurns, rawContent: input.rawContent,
      ...(input.reasoningLineage === undefined ? {} : { reasoningLineage: input.reasoningLineage }),
      rules: input.rules, orientation: input.orientation })
    : async (request) => {
      const resolved = await readSemanticTurnContext({ history: semantic, priorCompletedTurns: input.priorCompletedTurns,
        live: { prefix: await admitted.activeTurn.readLivePrefix(admitted.activeTurn.currentBindingRef()), rawContent: input.rawContent },
        runtimeId: binding.execution.runtimeId, scope: binding.scope, assignment: binding.assignment,
        rules: input.rules, orientation: await input.orientation(request),
        ...(input.reasoningLineage === undefined ? {} : { reasoningLineage: input.reasoningLineage }) });
      const units: ProviderRequestContextUnit[] = [];
      const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      for (const message of resolved.context.messages) {
        if (message.kind === 'semantic-turn-prefix') units.push({ kind: 'message', role: 'user', text: canonicalJsonStringify({
          objective: message.objective, rules: message.rules, successCriteria: message.successCriteria,
          failureCriteria: message.failureCriteria, incompleteCriteria: message.incompleteCriteria }) });
        else if (message.kind === 'semantic-checkpoint') units.push({ kind: 'message', role: 'assistant', text: canonicalJsonStringify({
          goal: message.checkpoint.goal, actions: message.checkpoint.did, result: message.checkpoint.result, nextStep: message.checkpoint.next }) });
        else if (message.kind === 'refined-child') units.push({ kind: 'message', role: 'assistant', text: text(message.bytes) });
        else {
          const unit = message.message;
          if (unit.kind === 'initial-input') units.push({ kind: 'message', role: 'user', text: text(unit.bytes) });
          else if (unit.kind === 'content') units.push({ kind: 'message', role: 'assistant', text: text(unit.bytes) });
          else if (unit.kind === 'tool-call') units.push({ kind: 'tool-call', callId: unit.callId, toolId: unit.toolId, arguments: unit.arguments });
          else units.push({ kind: 'tool-result', callId: unit.callId, toolId: unit.toolId, output: text(unit.rawOutput), status: unit.status, evidenceRefs: [unit.rawOutputRef] });
        }
      }
      units.push(...verifiedDeadEndContextUnits(resolved.verifiedDeadEnds));
      return { canonical: { units }, ...(resolved.instructions === undefined ? {} : { instructions: resolved.instructions }) };
    };

  const requestContext: ProviderRequestContextHook = async (request) => {
    if (request.execution.runtimeId !== binding.execution.runtimeId
      || request.execution.executionEpoch !== binding.execution.executionEpoch
      || request.execution.taskId.value !== input.provider.taskId.value
      || request.execution.operationId.value !== input.provider.operationId.value) throw new Error('native request binding mismatch');
    const full = await latestFullContext();
    const native = await nativeContext(request);
    const body = full.record.durableContext;
    const fullUnits: ProviderRequestContextUnit[] = [...body.stablePrefix, ...body.indexRefs, ...body.dynamicHead, ...body.repairRefs]
      .map((entry) => ({ kind: 'message', role: 'user', text: typeof entry === 'string' ? entry : canonicalJsonStringify(entry) }));
    return { ...native, canonical: { units: [...fullUnits, ...native.canonical.units] } };
  };
  const driver = new ProviderAgentDriver({ ...input.provider, rawEvidence: input.rawEvidence,
    acceptRawFact: (envelope) => active.acceptRawFact(envelope),
    registerRequest: (registration) => active.registerProviderRequest(registration), requestContext, now: input.now });

  let producerDrain: Promise<Awaited<ReturnType<ProviderAgentDriver['closeProductionAndDrain']>>> | undefined;
  const producer = {
    async closeProductionAndDrain(value: Parameters<ProviderAgentDriver['closeProductionAndDrain']>[0]) {
      return producerDrain ??= (async () => {
        const drain = await driver.closeProductionAndDrain(value);
        // Settlement still owes its durable request registration. Keep the
        // Runtime producer lifetime open until that final accepted write.
        await driver.settle(binding.execution);
        return drain;
      })();
    },
  };

  const segmentCapture = admitted.version === 2
    ? new ActiveTurnSegmentRecoveryCapture(admitted.activeTurn, input.owners.readCaptureReferences, input.now) : undefined;
  segmentCapture?.bindProvider(producer);
  let release!: () => void;
  const lifetime = admitted.version === 1 ? admitted.activeTurn.runProducer(() => new Promise<void>((resolve) => { release = resolve; })) : undefined;
  let captured: Promise<{ readonly captureRef: string; readonly prepared: PreparedRecoveryCapture | PreparedActiveTurnSegmentCaptureV2 }> | undefined;
  let originalPrepared: Promise<PreparedRecoveryCapture> | undefined;
  let originalCapture: { readonly captureRef: string; readonly prepared: PreparedRecoveryCapture } | undefined;
  let drained: Promise<Awaited<ReturnType<typeof producer.closeProductionAndDrain>>> | undefined;
  let boundary: string | undefined;
  function drainCurrentTurn(boundaryId: string) {
    if (boundary !== undefined && boundary !== boundaryId) throw new Error('native capture has one save boundary');
    boundary = boundaryId;
    if (admitted.version === 2) return producer.closeProductionAndDrain({ execution: binding.execution, boundaryId });
    return drained ??= (async () => {
      const runtimeDrain = admitted.activeTurn.closeAndDrainProducers();
      let drain;
      try { drain = await producer.closeProductionAndDrain({ execution: binding.execution, boundaryId }); }
      finally { release(); await lifetime; }
      await runtimeDrain;
      return drain;
    })();
  }
  async function prepareCapture(boundaryId: string) {
    if (boundary !== undefined && boundary !== boundaryId) throw new Error('native capture has one save boundary');
    boundary = boundaryId;
    if (admitted.version === 1) {
      if (originalCapture) return structuredClone(originalCapture);
      // Producer/owner reads and the cut are sampled exactly once. Persistence
      // retry uses this same validated body; a drain/acceptance rejection stays
      // retained and cannot recapture newer facts.
      originalPrepared ??= (async () => {
        const drain = await drainCurrentTurn(boundaryId);
        const refs = await input.owners.readCaptureReferences();
        const initialInput = (await admitted.activeTurn.readLivePrefix(admitted.activeTurn.currentBindingRef())).initialInput;
        if (!initialInput) throw new Error('native capture requires the actual committed initial input asset');
        const prepared: PreparedRecoveryCapture = { body: admitted.activeTurn.capture({ pauseId: boundaryId,
          frozenAt: input.now().toISOString(), initialInput, checkpointPath: refs.checkpointPath, completionRefs: refs.completionRefs }),
          controlRecordCount: admitted.activeTurn.controlRecordCount(), producerDrains: [drain],
          completionLookups: refs.completionLookups, recovery: refs.recovery };
        validatePreparedRecoveryCapture(prepared);
        return structuredClone(prepared);
      })();
      const prepared = await originalPrepared;
      const receipt = await recovery.commitCapturePhase({ turnId: prepared.body.binding.admittedTurn.turnId, boundaryId, prepared });
      originalCapture = { captureRef: receipt.commitIdentity,
        prepared: (await recovery.readRecoveryAssetsExact(receipt.commitIdentity)).prepared };
      return structuredClone(originalCapture);
    }
    captured ??= (async () => {
      if (admitted.version === 2 && segmentCapture) {
        const prepared = await segmentCapture.prepare(boundaryId);
        const receipt = await recovery.writeSegmentCapturePhase({ businessTurnId: prepared.body.businessTurnRef.businessTurnId,
          segmentId: prepared.body.segmentId, boundaryId, prepared });
        return { captureRef: receipt.commitIdentity, prepared: (await recovery.readSegmentRecoveryAssetsExact(receipt.commitIdentity)).prepared };
      }
      throw new Error('native capture owner mismatch');
    })();
    const attempt = captured;
    try { return structuredClone(await attempt); }
    catch (error) {
      // The segment capture owner retains its immutable cut and drain. Only
      // persistence may retry; clearing this acknowledgement never recaptures.
      if (captured === attempt) captured = undefined;
      throw error;
    }
  }

  async function prepareTurnClosure(checkpoint: import('../../../contracts/src/index.js').Checkpoint, boundaryId: string,
    source: Parameters<typeof prepareCheckpointClosure>[0]['source']) {
    const frozen = await prepareCapture(boundaryId);
    const full = await latestFullContext();
    const facts = await input.owners.readClosureFacts(full.commitRef);
    if (!facts) throw new Error('native closure owner facts are unknown');
    const selector: OperationControlSelector = { scope: binding.scope, agentRuntimeId: binding.execution.runtimeId,
      harnessExecutionEpoch: binding.execution.executionEpoch };
    const preparation = await prepareCheckpointClosure({ checkpoint, source,
      closureReason: 'standard-turn-closure', contextCommitRef: full.commitRef, contextHistory: input.fullContext,
      operationSelector: selector, operationControl: await input.owners.readControl(selector), ...facts, closurePort: closures, now: input.now });
    return { preparation, turnRecoveryRef: frozen.captureRef };
  }

  async function prepareClosure(intent: NativeSaveIntent, checkpoint: Parameters<Parameters<typeof createJsonlNativeTurnSave>[0]['prepareClosure']>[1]) {
    if (intent.closure.closureId !== `checkpoint-closure:${checkpointCommitId(checkpoint.checkpoint)}`) throw new Error('native closure requires the canonical P3 closure identity');
    const { preparation, turnRecoveryRef } = await prepareTurnClosure(checkpoint.checkpoint, intent.key.boundaryId, intent.closure.source);
    const committed = await checkpoints.readCommitted(binding.scope, checkpoint.checkpoint.id);
    if (!committed) throw new Error('native bound closure requires the actual committed checkpoint');
    const submitted = await submitCheckpoint({ journal: checkpoints, closurePort: closures, ownerId: intent.ownerId,
      previous: committed.previous, checkpoint: checkpoint.checkpoint, source: intent.closure.source,
      preparation, turnRecoveryRef });
    const nested = await checkpoints.readCheckpointRecoveryBinding(binding.scope, committed.commitRef);
    if (!nested || canonicalJsonStringify(nested) !== canonicalJsonStringify(submitted.closure.recoveryBinding)) {
      throw new Error('native closure exact bound readback is absent or conflicts');
    }
    return submitted.closure;
  }
  const common = { filePath: input.filePath, journal: input.journal, artifactsRoot: input.artifactsRoot,
    activeTurnJournal: input.activeTurnJournal, rawContent: input.rawContent, timeAuthority: input.timeAuthority, prepareClosure,
    ...(input.completionJournal === undefined ? {} : { completionJournal: input.completionJournal }) };
  const saveOwner = admitted.version === 1
    ? createJsonlNativeTurnSave({ ...common, readPreparedCapture: async (ref) => (await recovery.readRecoveryAssetsExact(ref)).prepared })
    : createJsonlNativeSegmentSave({ ...common, segmentJournal: admitted.segmentJournal,
      readPreparedCapture: async (ref) => (await recovery.readSegmentRecoveryAssetsExact(ref)).prepared });
  let saveIntent: NativeSaveIntent | undefined;
  return { driver, requestContext, prepareCapture, prepareTurnClosure, drainCurrentTurn,
    recoveryAssetsReader: ({ readRecoveryAssetsExact: recovery.readRecoveryAssetsExact,
      async readBoundaryRecoveryAssetsExact(ref: string) {
        return admitted.version === 1 ? { version: 1 as const, assets: await recovery.readRecoveryAssetsExact(ref) }
          : { version: 2 as const, assets: await recovery.readSegmentRecoveryAssetsExact(ref), source: admitted.source };
      } } satisfies
      import('../../../runtime/src/agent-loop/reviewed-milestone-boundary.js').ReviewedBoundaryRecoveryAssetsPort),
    savePorts: saveOwner.ports, saveProgress: saveOwner.progress,
    async readSaveStageFacts(): Promise<import('../../../runtime/src/ui-runtime/current-state.js').RuntimeTaskStageFacts> {
      if (saveIntent === undefined) return { state: 'known', stages: NATIVE_SAVE_PHASES.map((phase) => ({
        stageId: phase, state: 'not-executed', blockedByStage: 'turn-close',
        causeRef: admitted.version === 1 ? admitted.activeTurn.currentBindingRef()
          : `active-turn-segment://${admitted.activeTurn.segmentOpened.segmentId}`,
        recoveryRef: admitted.version === 1 ? admitted.activeTurn.activeBinding.admittedTurn.recoveryStateRef
          : `active-turn-segment://${admitted.activeTurn.segmentOpened.segmentId}`,
      })) };
      const progress = await saveOwner.progress.readExact(saveIntent.key);
      if (progress.state !== 'found') return { state: 'unknown', reason: 'started native save has no exact progress readback' };
      if (progress.progress.phases.some((phase) => phase.state === 'unknown' || phase.state === 'failed')) {
        return { state: 'unknown', reason: `native save retains failed or unknown phase: ${progress.progress.firstErrorRef ?? saveIntent.recoveryAssets.captureRef}` };
      }
      return { state: 'known', stages: progress.progress.phases.map((phase) => phase.state === 'committed'
        ? { stageId: phase.phase, state: 'succeeded' as const, value: phase, evidenceRefs: [phase.receiptRef] }
        : { stageId: phase.phase, state: 'not-executed' as const, blockedByStage: phase.phase,
            causeRef: progress.progress.firstErrorRef ?? saveIntent!.recoveryAssets.captureRef,
            recoveryRef: saveIntent!.recoveryAssets.captureRef,
            ...(progress.progress.firstErrorRef === undefined ? {} : { firstErrorRef: progress.progress.firstErrorRef }) }) };
    },
    continueCurrentTurn(input: { readonly instructions: RequestScopedInstructions }): Promise<ProviderSubmitResult> {
      return driver.continueCurrentTurn(input);
    },
    async close(boundaryId: string) {
      await prepareCapture(boundaryId);
      return driver.close();
    },
    async save(intent: NativeSaveIntent) {
      if (isNativeSegmentSaveIntentV2(intent) !== (admitted.version === 2)) throw new Error('native save version must follow the actual admitted context');
      const frozen = await prepareCapture(intent.key.boundaryId);
      if (frozen.captureRef !== intent.recoveryAssets.captureRef) throw new Error('native save must use the actual frozen capture receipt');
      const relationship = await checkpoints.readNativeCheckpoint({ checkpoint: intent.key.checkpoint });
      if (!relationship) throw new Error('native save requires the canonical committed checkpoint');
      const committed = await checkpoints.readCommitted(binding.scope, intent.key.checkpoint.id);
      if (!committed) throw new Error('native save requires exact checkpoint readback');
      const bound = await checkpoints.readCheckpointRecoveryBinding(binding.scope, committed.commitRef);
      if (admitted.version === 1) {
        if (!bound || bound.turnRecoveryRef !== frozen.captureRef) {
          throw new Error('native original-turn save requires the exact canonical capture binding');
        }
      } else if (!bound) {
        await prepareClosure(intent, relationship);
      }
      if (saveIntent && canonicalJsonStringify(saveIntent) !== canonicalJsonStringify(intent)) {
        throw new Error('native save retry changed the retained immutable intent');
      }
      saveIntent ??= structuredClone(intent);
      return saveOwner.controller.run(saveIntent);
    },
  };
}
