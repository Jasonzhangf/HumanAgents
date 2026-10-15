import { createHash } from 'node:crypto';
import { createJsonlNativeSaveProgressPort } from '../../adapters/jsonl/src/native-save-progress.js';
import { createNativeBoundarySaveController } from '../../runtime/src/checkpoints/boundary-save.js';
import {
  isNativeSegmentSaveIntentV2,
  type NativeSaveIntent,
  type NativeSaveIntentV1,
  type NativeSavePhase,
  type NativeSavePhaseReceipt,
  type NativeSavePorts,
} from '../../runtime/src/checkpoints/native-save-contract.js';
import type { CheckpointClosureRecord } from '../../runtime/src/checkpoints/closure.js';
import type { SemanticHistoryPersistencePort } from '../../runtime/src/checkpoints/ports.js';
import type {
  ActiveTurnJournalPort,
  ActiveTurnJournalRecord,
} from '../../runtime/src/context/active-turn-journal.js';
import {
  contextViewIdentityV1,
  historyPublicationIdentityV1,
  projectAdmittedTurnIdentityV1,
} from '../../runtime/src/context/semantic-history.js';
import {
  canonicalJsonStringify,
  scopeDigest,
  type ActiveTurnBinding,
  type CheckpointReceiptRelationshipV1,
  type CheckpointTimeAuthority,
  type CheckpointTimeAuthorityMetadata,
  type PreparedRecoveryCapture,
  type RawContentReadPort,
  type ScopeRef,
} from '../../contracts/src/index.js';
import {
  JsonlOrganJournal,
  type JournalRecord,
} from '../../adapters/jsonl/src/index.js';
import {
  createJsonlCheckpointClosurePort,
  createJsonlCheckpointJournal,
  createJsonlSemanticHistoryJournal,
} from './checkpoint-journal.js';
import {
  createNativeRecoveryAssets,
  recoveryAssetsReceiptRef,
} from './native-recovery-assets.js';
import type { OperationCompletionJournalPort } from '../../runtime/src/gateway/operation-completion.js';

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  const sameId = (
    a: { readonly scope: string; readonly value: string } | undefined,
    b: { readonly scope: string; readonly value: string } | undefined,
  ): boolean => a === undefined ? b === undefined : b !== undefined && a.scope === b.scope && a.value === b.value;
  return sameId(left.organId, right.organId)
    && sameId(left.taskId, right.taskId)
    && sameId(left.cycleId, right.cycleId)
    && sameId(left.operationId, right.operationId);
}

function semanticRecordDigest(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`native semantic record digest is invalid: ${value}`);
  }
  return value as `sha256:${string}`;
}

function closureJournalRecord(
  records: readonly JournalRecord[],
  closureId: string,
): JournalRecord | undefined {
  return records.find((record) => {
    if (record.kind !== 'event' || record.payload?.['kind'] !== 'checkpoint-closure') return false;
    const closure = record.payload['closure'];
    if (typeof closure !== 'object' || closure === null) return false;
    const candidate = closure as { readonly closureId?: unknown; readonly deadEndRef?: unknown };
    return (typeof candidate.closureId === 'string' && candidate.closureId === closureId)
      || (typeof candidate.deadEndRef === 'string' && candidate.deadEndRef === closureId);
  });
}

/**
 * The V1 five-stage App composition for one original native turn save. It
 * reuses the same owner factories as the resumed-segment save and binds every
 * stage to the supplied canonical Organ Journal. The V1 intent fixes the exact
 * already committed native checkpoint in its accepted view, so this factory
 * exact-reads that checkpoint and never mints a replacement epoch or segment.
 */
export function createJsonlNativeTurnSave(input: {
  readonly filePath: string;
  readonly journal: JsonlOrganJournal;
  readonly artifactsRoot: string;
  readonly activeTurnJournal: ActiveTurnJournalPort;
  /** Actual shared completion port; recovery-assets cold reads resolve real completion truth through it. */
  readonly completionJournal?: OperationCompletionJournalPort;
  readonly rawContent: RawContentReadPort;
  readonly timeAuthority: CheckpointTimeAuthority;
  /** Exact frozen V1 producer capture, selected by the intent's captureRef. */
  readonly readPreparedCapture: (captureRef: string) => Promise<PreparedRecoveryCapture>;
  /** Runtime closure owner supplies the actual closure decision after checkpoint read. */
  readonly prepareClosure: (
    intent: NativeSaveIntentV1,
    checkpoint: CheckpointReceiptRelationshipV1,
  ) => Promise<CheckpointClosureRecord>;
}) {
  const journal = input.journal;
  const checkpoints = createJsonlCheckpointJournal({ filePath: input.filePath, journal });
  const closures = createJsonlCheckpointClosurePort({ filePath: input.filePath, journal });
  const recovery = createNativeRecoveryAssets({
    journalPath: input.filePath,
    journal,
    assetRoot: input.artifactsRoot,
    ...(input.completionJournal === undefined ? {} : { completionJournal: input.completionJournal }),
  });
  const semantic = createJsonlSemanticHistoryJournal({
    filePath: input.filePath,
    journal,
    artifactsRoot: input.artifactsRoot,
    activeTurnJournal: input.activeTurnJournal,
    rawContent: input.rawContent,
    timeAuthority: input.timeAuthority,
  });
  const progress = createJsonlNativeSaveProgressPort({ journal });

  function turnIntent(intent: NativeSaveIntent): NativeSaveIntentV1 {
    if (isNativeSegmentSaveIntentV2(intent)) {
      throw new Error('turn save requires a version 1 intent');
    }
    return intent;
  }

  async function verifiedRecords(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new Error(`native turn save journal is corrupt: ${verification.error ?? 'unknown'}`);
    }
    return verification.records;
  }

  async function originalBinding(): Promise<ActiveTurnBinding> {
    const records = await input.activeTurnJournal.replay();
    const record = records.find(
      (candidate): candidate is Extract<ActiveTurnJournalRecord, { kind: 'binding-opened' }> =>
        candidate.kind === 'binding-opened',
    );
    if (!record) throw new Error('native turn save requires the actual original binding-opened record');
    return record.binding;
  }

  async function checkpoint(intent: NativeSaveIntentV1): Promise<CheckpointReceiptRelationshipV1> {
    const relationship = await checkpoints.readNativeCheckpoint({ checkpoint: intent.key.checkpoint });
    if (!relationship) throw new Error('native stage requires the exact committed checkpoint');
    return relationship;
  }

  async function capture(intent: NativeSaveIntentV1): Promise<{
    readonly prepared: PreparedRecoveryCapture;
    readonly ref: string;
  }> {
    const prepared = await input.readPreparedCapture(intent.recoveryAssets.captureRef);
    if (prepared.body.binding.admittedTurn.turnId !== intent.key.turn.turnId
      || prepared.body.cut.pauseId !== intent.key.boundaryId
      || !sameScope(prepared.body.binding.scope, intent.key.turn.scopeRef)) {
      throw new Error('native capture does not match the fixed original turn');
    }
    const records = await input.activeTurnJournal.replay();
    const bindingRecord = records.find(
      (candidate): candidate is Extract<ActiveTurnJournalRecord, { kind: 'binding-opened' }> =>
        candidate.kind === 'binding-opened',
    );
    const initialRecord = records.find(
      (candidate): candidate is Extract<ActiveTurnJournalRecord, { kind: 'initial-input' }> =>
        candidate.kind === 'initial-input',
    );
    if (!bindingRecord || !initialRecord
      || canonicalJsonStringify(bindingRecord.binding) !== canonicalJsonStringify(prepared.body.binding)
      || canonicalJsonStringify(initialRecord.content) !== canonicalJsonStringify(prepared.body.initialInput)) {
      throw new Error('native capture does not match the actual original active-turn records');
    }
    const ref = recoveryAssetsReceiptRef({
      turnId: intent.key.turn.turnId,
      boundaryId: intent.key.boundaryId,
      cut: prepared.body.cut,
      captureDigest: `sha256:${createHash('sha256').update(canonicalJsonStringify(prepared.body)).digest('hex')}`,
      controlRecordCount: prepared.controlRecordCount,
    });
    return { prepared, ref };
  }

  async function receipt(
    phase: NativeSavePhase,
    intent: NativeSaveIntentV1,
    record: JournalRecord,
    committedAt: string,
    authority: CheckpointTimeAuthorityMetadata,
  ): Promise<NativeSavePhaseReceipt> {
    if (!record.commitId || !sameScope(record.scope, intent.key.turn.scopeRef)) {
      throw new Error('native phase record identity/scope mismatch');
    }
    return {
      phase,
      commitIdentity: record.commitId,
      journalReceiptRef: `humanagent://journal-record/v1/${await scopeDigest(record.scope)}/${record.seq}/${record.recordDigest.slice('sha256:'.length)}`,
      journalSeq: record.seq,
      recordDigest: record.recordDigest,
      committedAt,
      intentDigest: intent.inputIntentDigest,
      timeAuthority: authority,
    };
  }

  async function exact(phase: NativeSavePhase, value: NativeSaveIntent): Promise<NativeSavePhaseReceipt | null> {
    const intent = turnIntent(value);
    if (phase === 'recovery-assets') {
      const selected = await capture(intent);
      const record = (await verifiedRecords()).find((candidate) => candidate.commitId === selected.ref);
      if (!record) return null;
      const read = await recovery.readRecoveryAssetsExact(selected.ref);
      return receipt(phase, intent, record, read.prepared.body.cut.frozenAt, intent.checkpoint.timeAuthority);
    }
    if (phase === 'checkpoint') {
      const relationship = await checkpoints.readNativeCheckpoint({ checkpoint: intent.key.checkpoint });
      if (!relationship) return null;
      const record = (await verifiedRecords()).find((candidate) => candidate.commitId === relationship.envelope.identity);
      if (!record) throw new Error('native checkpoint receipt has no Journal record');
      return receipt(phase, intent, record, relationship.envelope.committedAt, relationship.envelope.timeAuthority);
    }
    const relationship = await checkpoint(intent);
    if (phase === 'closure') {
      const closure = await closures.read(intent.closure.closureId);
      if (!closure) return null;
      if (!('closureKind' in closure) || closure.closureKind !== 'checkpoint'
        || closure.checkpointId.value !== intent.key.checkpoint.id.value
        || closure.source !== intent.closure.source
        || closure.summary !== intent.closure.closureSummary
        || canonicalJsonStringify(closure.evidenceRefs) !== canonicalJsonStringify(intent.closure.closureEvidenceRefs)) {
        throw new Error('native closure does not match the fixed closure selectors');
      }
      const committed = await checkpoints.readCommitted(intent.key.checkpoint.scope, intent.key.checkpoint.id);
      if (!committed) throw new Error('native closure requires the exact full checkpoint receipt');
      const binding = await checkpoints.readCheckpointRecoveryBinding(intent.key.checkpoint.scope, committed.commitRef);
      if (!binding || !closure.recoveryBinding
        || canonicalJsonStringify(binding) !== canonicalJsonStringify(closure.recoveryBinding)
        || binding.turnRecoveryRef !== intent.recoveryAssets.captureRef) {
        throw new Error('native closure requires the exact physical checkpoint/capture binding');
      }
      const record = closureJournalRecord(await verifiedRecords(), intent.closure.closureId);
      if (!record) throw new Error('native closure has no Journal record');
      return receipt(phase, intent, record, relationship.envelope.committedAt, relationship.envelope.timeAuthority);
    }
    if (phase === 'context-view') {
      const identity = await contextViewIdentityV1({ turn: intent.key.turn, checkpoint: intent.key.checkpoint });
      const body = await semantic.readContextViewByIdentity!({
        scope: intent.key.turn.scopeRef,
        identity,
      });
      if (!body) return null;
      const record = (await verifiedRecords()).find((candidate) => candidate.commitId === identity);
      if (!record) throw new Error('semantic context-view body has no Journal record');
      return receipt(phase, intent, record, body.committedAt, body.timeAuthority);
    }
    const identity = await historyPublicationIdentityV1({ turn: intent.key.turn, checkpoint: intent.key.checkpoint });
    const body = await semantic.readHistoryPublicationByIdentity!({
      scope: intent.key.turn.scopeRef,
      identity,
    });
    if (!body) return null;
    const record = (await verifiedRecords()).find((candidate) => candidate.commitId === identity);
    if (!record) throw new Error('semantic history-publication body has no Journal record');
    return receipt(phase, intent, record, body.committedAt, body.timeAuthority);
  }

  async function commit(phase: NativeSavePhase, value: NativeSaveIntent): Promise<NativeSavePhaseReceipt> {
    const intent = turnIntent(value);
    if (phase === 'recovery-assets') {
      const selected = await capture(intent);
      await recovery.commitCapturePhase({
        turnId: intent.key.turn.turnId,
        boundaryId: intent.key.boundaryId,
        prepared: selected.prepared,
      });
    } else if (phase === 'checkpoint') {
      await checkpoints.commitNativeCheckpoint({
        ownerId: intent.ownerId,
        checkpoint: intent.checkpoint.checkpoint,
        timeAuthority: input.timeAuthority,
      });
    } else if (phase === 'closure') {
      const closure = await input.prepareClosure(intent, await checkpoint(intent));
      await closures.commit(closure);
    } else if (phase === 'context-view') {
      const binding = await originalBinding();
      await semantic.commitContextView({
        ownerId: intent.ownerId,
        accepted: {
          version: 1,
          admittedTurn: binding.admittedTurn,
          checkpoint: await checkpoint(intent),
          acceptance: intent.contextView.accepted.acceptance,
          semantics: intent.contextView.accepted.semantics,
          adoptedChildren: intent.contextView.accepted.adoptedChildren,
          recovery: intent.contextView.accepted.recovery,
        },
      });
    } else {
      const view = await exact('context-view', intent);
      if (!view) throw new Error('history publication requires an actual context-view receipt');
      await semantic.commitHistoryPublication({
        ownerId: intent.ownerId,
        turn: intent.key.turn,
        checkpoint: await checkpoint(intent),
        contextView: {
          identity: await contextViewIdentityV1({ turn: intent.key.turn, checkpoint: intent.key.checkpoint }),
          receipt: {
            phase: 'context-view',
            commitIdentity: view.commitIdentity,
            journalReceiptRef: view.journalReceiptRef,
            journalSeq: view.journalSeq,
            recordDigest: semanticRecordDigest(view.recordDigest),
            committedAt: view.committedAt,
            timeAuthority: view.timeAuthority,
          },
        },
      });
    }
    const actual = await exact(phase, intent);
    if (!actual) throw new Error(`native ${phase} owner returned without an exact receipt`);
    return actual;
  }

  async function assertV1SaveIntent(intent: NativeSaveIntentV1): Promise<void> {
    if (intent.recoveryAssets.turnId !== intent.key.turn.turnId
      || intent.recoveryAssets.boundaryId !== intent.key.boundaryId) {
      throw new Error('native recovery-assets selectors do not match the save key');
    }
    const binding = await originalBinding();
    if (canonicalJsonStringify(projectAdmittedTurnIdentityV1(binding.admittedTurn)) !== canonicalJsonStringify(intent.key.turn)
      || !sameScope(binding.scope, intent.key.turn.scopeRef)) {
      throw new Error('native save key does not match the actual original admission');
    }
    const expectedKey = { turn: intent.key.turn, checkpoint: intent.key.checkpoint };
    if (canonicalJsonStringify(intent.contextView.key) !== canonicalJsonStringify(expectedKey)
      || canonicalJsonStringify(intent.historyPublication.key) !== canonicalJsonStringify(expectedKey)) {
      throw new Error('native semantic selectors do not match the save key');
    }
    if (intent.key.checkpoint.id.value !== intent.checkpoint.checkpoint.id.value
      || !sameScope(intent.key.checkpoint.scope, intent.checkpoint.checkpoint.scope)
      || intent.closure.checkpoint.id.value !== intent.key.checkpoint.id.value
      || !sameScope(intent.closure.checkpoint.scope, intent.key.checkpoint.scope)) {
      throw new Error('native checkpoint selectors do not match the save key');
    }
    const relationship = await checkpoints.readNativeCheckpoint({ checkpoint: intent.key.checkpoint });
    if (!relationship) {
      throw new Error('v1 native save requires the exact committed checkpoint before the intent');
    }
    if (canonicalJsonStringify(relationship) !== canonicalJsonStringify(intent.contextView.accepted.checkpoint)) {
      throw new Error('v1 accepted view checkpoint does not match the exact committed checkpoint');
    }
    if (canonicalJsonStringify(binding.admittedTurn) !== canonicalJsonStringify(intent.contextView.accepted.admittedTurn)) {
      throw new Error('v1 accepted view admitted turn does not match the actual original admission');
    }
    // V1 follows the canonical close submission. It never creates or upgrades
    // an absent/unbound closure during a later native save.
    await exact('closure', intent).then((actual) => {
      if (!actual) throw new Error('v1 native save requires the committed canonical bound closure');
    });
  }

  const ports: NativeSavePorts = {
    'recovery-assets': {
      commit: (intent) => commit('recovery-assets', intent),
      readExact: (intent) => exact('recovery-assets', intent),
    },
    checkpoint: {
      commit: (intent) => commit('checkpoint', intent),
      readExact: (intent) => exact('checkpoint', intent),
    },
    closure: {
      commit: (intent) => commit('closure', intent),
      readExact: (intent) => exact('closure', intent),
    },
    'context-view': {
      commit: (intent) => commit('context-view', intent),
      readExact: (intent) => exact('context-view', intent),
    },
    'history-publication': {
      commit: (intent) => commit('history-publication', intent),
      readExact: (intent) => exact('history-publication', intent),
    },
  };
  const controller = createNativeBoundarySaveController(progress, ports);
  return {
    ports,
    progress,
    semantic,
    controller: {
      async run(value: NativeSaveIntent) {
        const intent = turnIntent(value);
        await assertV1SaveIntent(intent);
        return controller.run(intent);
      },
    },
  };
}
