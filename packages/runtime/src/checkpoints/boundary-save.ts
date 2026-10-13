import {
  canonicalJsonStringify,
  validateCheckpointBoundaryOutcome,
  type CheckpointBoundaryOutcome,
  type DurableCheckpointReceipt,
  type DurablePhaseOutcome,
  type StageResult,
} from '../../../contracts/src/index.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';

import {
  NATIVE_SAVE_PHASES,
  type NativeSaveIntent,
  type NativeSaveKey,
  type NativeSavePhase,
  type NativeSavePhaseReceipt,
  type NativeSavePorts,
  type NativeSaveProgress,
  type NativeSaveProgressPort,
  type NativeSaveStagePort,
} from './native-save-contract.js';

const PHASES = NATIVE_SAVE_PHASES;

export interface NativeBoundarySaveController {
  readonly run: (intent: NativeSaveIntent) => Promise<NativeBoundarySaveResult>;
}

export type NativeBoundarySaveResult =
  | {
      readonly state: 'complete';
      readonly key: NativeSaveKey;
      readonly outcome: CheckpointBoundaryOutcome;
      readonly durablePhases: readonly DurablePhaseOutcome[];
      readonly progress: NativeSaveProgress;
      readonly progressCommit: JournalCommitRef;
      readonly recoveryResponsibilityRef: string;
      readonly receiptRefs: NativeSaveReceiptRefs;
      /** Native save never decides task success or next-turn admission by itself. */
      readonly readiness: 'pending-owner-facts';
    }
  | {
      readonly state: 'hold';
      readonly reason: 'save-incomplete' | 'progress-unknown';
      readonly key: NativeSaveKey;
      readonly firstErrorRef: string;
      readonly recoveryResponsibilityRef: string;
      readonly durablePhases: readonly DurablePhaseOutcome[];
      readonly progress: NativeSaveProgress;
      readonly progressCommit: JournalCommitRef;
    }
  | {
      readonly state: 'persistence-unconfirmed';
      readonly key: NativeSaveKey;
      readonly persistenceErrorRef: string;
      readonly recoveryResponsibilityRef: string;
      readonly durablePhases: readonly DurablePhaseOutcome[];
      readonly unconfirmedReceipt: { readonly phase: NativeSavePhase; readonly receiptRef: string };
      readonly progress: NativeSaveProgress;
    };

export interface NativeSaveReceiptRefs {
  readonly recoveryAssets: string;
  readonly checkpoint: string;
  readonly closure: string;
  readonly contextView: string;
  readonly historyPublication: string;
}

export function createNativeBoundarySaveController(
  progressPort: NativeSaveProgressPort,
  ports: NativeSavePorts,
): NativeBoundarySaveController {
  return { run: (intent) => runNativeBoundarySave(progressPort, ports, intent) };
}

async function runNativeBoundarySave(
  progressPort: NativeSaveProgressPort,
  ports: NativeSavePorts,
  intent: NativeSaveIntent,
): Promise<NativeBoundarySaveResult> {
  const begin = await progressPort.begin(intent);
  const readback = await progressPort.readExact(intent.key);

  if (readback.state === 'unknown') {
    return {
      state: 'hold',
      reason: 'progress-unknown',
      key: intent.key,
      firstErrorRef: readback.recoveryRef,
      recoveryResponsibilityRef: intent.recoveryResponsibilityRef,
      durablePhases: notExecuted(),
      progress: freshProgress(begin, intent),
      progressCommit: begin,
    };
  }

  if (readback.state === 'found' && readback.progress.intentDigest !== intent.inputIntentDigest) {
    throw new Error(`native save intent conflict for boundary ${intent.key.boundaryId}`);
  }

  let progress = readback.state === 'found'
    ? { ...readback.progress, phases: normalizePhases(readback.progress.phases) }
    : freshProgress(begin, intent);
  let progressCommit = begin;

  for (const phase of PHASES) {
    const port = ports[phase];
    let observed: NativeSavePhaseReceipt | null;
    try {
      observed = await exactRead(port, phase, intent);
    } catch (error) {
      return failPhase(progressPort, progress, progressCommit, intent, phase, errorRef(error, phase), 'unknown');
    }
    if (observed) {
      progress = markPhase(progress, committed(phase, observed.journalReceiptRef));
      continue;
    }

    let committedReceipt: NativeSavePhaseReceipt;
    try {
      committedReceipt = await port.commit(intent);
      assertReceiptForPhase(committedReceipt, phase, intent);
    } catch (error) {
      return failPhase(progressPort, progress, progressCommit, intent, phase, errorRef(error, phase), 'failed');
    }

    const next = markPhase(progress, committed(phase, committedReceipt.journalReceiptRef));
    try {
      progressCommit = await progressPort.recordProgress(next);
      progress = next;
    } catch (error) {
      return {
        state: 'persistence-unconfirmed',
        key: intent.key,
        persistenceErrorRef: errorRef(error, `progress-${phase}`),
        recoveryResponsibilityRef: intent.recoveryResponsibilityRef,
        durablePhases: progress.phases,
        unconfirmedReceipt: { phase, receiptRef: committedReceipt.journalReceiptRef },
        progress,
      };
    }
  }

  const receipts = await exactReceipts(ports, intent);
  if (receipts['context-view'].journalReceiptRef === receipts['history-publication'].journalReceiptRef) {
    throw new Error('native save cannot alias context-view and history-publication receipts');
  }
  const outcome = buildOutcome(intent, progress, receipts);
  validateCheckpointBoundaryOutcome(outcome);

  return {
    state: 'complete',
    key: intent.key,
    outcome,
    durablePhases: progress.phases,
    progress,
    progressCommit,
    recoveryResponsibilityRef: intent.recoveryResponsibilityRef,
    receiptRefs: {
      recoveryAssets: receipts['recovery-assets'].journalReceiptRef,
      checkpoint: receipts.checkpoint.journalReceiptRef,
      closure: receipts.closure.journalReceiptRef,
      contextView: receipts['context-view'].journalReceiptRef,
      historyPublication: receipts['history-publication'].journalReceiptRef,
    },
    readiness: 'pending-owner-facts',
  };
}

async function failPhase(
  progressPort: NativeSaveProgressPort,
  progress: NativeSaveProgress,
  progressCommit: JournalCommitRef,
  intent: NativeSaveIntent,
  phase: NativeSavePhase,
  phaseErrorRef: string,
  state: 'failed' | 'unknown',
): Promise<NativeBoundarySaveResult> {
  const firstErrorRef = progress.firstErrorRef ?? phaseErrorRef;
  const laterErrorRefs = progress.firstErrorRef ? [...progress.laterErrorRefs, phaseErrorRef] : progress.laterErrorRefs;
  const failed: NativeSaveProgress = {
    ...progress,
    phases: markPhase(progress, { phase, state }).phases,
    firstErrorRef,
    laterErrorRefs,
  };
  try {
    const committedProgress = await progressPort.recordProgress(failed);
    return {
      state: 'hold',
      reason: 'save-incomplete',
      key: intent.key,
      firstErrorRef,
      recoveryResponsibilityRef: intent.recoveryResponsibilityRef,
      durablePhases: failed.phases,
      progress: failed,
      progressCommit: committedProgress,
    };
  } catch (error) {
    return {
      state: 'persistence-unconfirmed',
      key: intent.key,
      persistenceErrorRef: errorRef(error, `progress-${phase}`),
      recoveryResponsibilityRef: intent.recoveryResponsibilityRef,
      durablePhases: progress.phases,
      unconfirmedReceipt: { phase, receiptRef: phaseErrorRef },
      progress,
    };
  }
}

function freshProgress(begin: JournalCommitRef, intent: NativeSaveIntent): NativeSaveProgress {
  return {
    intentCommitRef: begin,
    key: intent.key,
    intentDigest: intent.inputIntentDigest,
    phases: notExecuted(),
    ...(intent.firstErrorRef === undefined ? {} : { firstErrorRef: intent.firstErrorRef }),
    laterErrorRefs: intent.laterErrorRefs,
    unresolvedOperationRefs: intent.unresolvedOperationRefs,
  };
}

async function exactRead(
  port: NativeSaveStagePort,
  phase: NativeSavePhase,
  intent: NativeSaveIntent,
): Promise<NativeSavePhaseReceipt | null> {
  const receipt = await port.readExact(intent);
  if (!receipt) return null;
  assertReceiptForPhase(receipt, phase, intent);
  return receipt;
}

async function exactReceipts(
  ports: NativeSavePorts,
  intent: NativeSaveIntent,
): Promise<Record<NativeSavePhase, NativeSavePhaseReceipt>> {
  const receipts = {} as Record<NativeSavePhase, NativeSavePhaseReceipt>;
  for (const phase of PHASES) {
    const receipt = await exactRead(ports[phase], phase, intent);
    if (!receipt) throw new Error(`native save ${phase} receipt is absent after completion`);
    receipts[phase] = receipt;
  }
  return receipts;
}

function assertReceiptForPhase(receipt: NativeSavePhaseReceipt, phase: NativeSavePhase, intent: NativeSaveIntent): void {
  if (receipt.phase !== phase) throw new Error(`native save phase alias from ${receipt.phase} to ${phase}`);
  if (receipt.intentDigest !== intent.inputIntentDigest) throw new Error(`native save intent digest mismatch in ${phase}`);
  if (!receipt.journalReceiptRef.trim()) throw new Error(`native save ${phase} receipt reference is empty`);
}

function buildOutcome(
  intent: NativeSaveIntent,
  progress: NativeSaveProgress,
  receipts: Record<NativeSavePhase, NativeSavePhaseReceipt>,
): CheckpointBoundaryOutcome {
  const checkpoint = receipts.checkpoint;
  const checkpointReceipt: DurableCheckpointReceipt = {
    commitIdentity: checkpoint.commitIdentity,
    checkpointRef: checkpoint.journalReceiptRef,
    journalReceiptRef: checkpoint.journalReceiptRef,
    committedAt: checkpoint.committedAt,
    timeAuthority: checkpoint.timeAuthority,
  };
  const holdsRecovery = progress.firstErrorRef !== undefined
    || progress.laterErrorRefs.length > 0
    || progress.unresolvedOperationRefs.length > 0;
  return {
    commitIdentity: checkpoint.commitIdentity,
    stages: progress.phases.map((phase): StageResult<unknown> => {
      if (phase.state !== 'committed') throw new Error(`native save ${phase.phase} is not committed`);
      return { stageId: phase.phase, state: 'succeeded', value: phase.receiptRef, evidenceRefs: [phase.receiptRef] };
    }),
    durablePhases: progress.phases,
    checkpointReceipt,
    closureReceiptRef: receipts.closure.journalReceiptRef,
    contextViewReceiptRef: receipts['context-view'].journalReceiptRef,
    historyReceiptRef: receipts['history-publication'].journalReceiptRef,
    ...(progress.firstErrorRef === undefined ? {} : { firstErrorRef: progress.firstErrorRef }),
    ...(holdsRecovery ? { recoveryRef: intent.recoveryResponsibilityRef } : {}),
    laterErrorRefs: progress.laterErrorRefs,
    unresolvedOperationRefs: progress.unresolvedOperationRefs,
    rawTurnRefs: intent.rawTurnRefs,
  };
}

function notExecuted(): readonly DurablePhaseOutcome[] {
  return PHASES.map((phase) => ({ phase, state: 'not-executed' as const }));
}

function normalizePhases(phases: readonly DurablePhaseOutcome[]): readonly DurablePhaseOutcome[] {
  const byPhase = new Map(phases.map((phase) => [phase.phase, phase]));
  return PHASES.map((phase) => byPhase.get(phase) ?? { phase, state: 'not-executed' as const });
}

function committed(phase: NativeSavePhase, receiptRef: string): DurablePhaseOutcome {
  return { phase, state: 'committed', receiptRef };
}

function markPhase(progress: NativeSaveProgress, record: DurablePhaseOutcome): NativeSaveProgress {
  return {
    ...progress,
    phases: progress.phases.map((existing) => existing.phase === record.phase ? record : existing),
  };
}

function errorRef(error: unknown, phase: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `native-save:${phase}:${canonicalJsonStringify(message)}`;
}
