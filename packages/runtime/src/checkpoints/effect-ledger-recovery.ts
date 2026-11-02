import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  decideTurnSegmentRecovery,
  id,
  validateTurnSegmentRecoveryFact,
  type Checkpoint,
  type EvidenceRef,
  type JournalCommitRef,
  type ProviderSettleReceipt,
  type ScopeRef,
  type ToolEffectLedgerEntry,
  type TurnSegmentRecoveryFact,
  type TurnSegmentRecoveryOutcome,
} from '../../../contracts/src/index.js';
import { completeCheckpoint, recallCheckpoint, sameCheckpoint } from './coordinator.js';
import type { CheckpointJournalPort, CommittedCheckpointRecord } from './ports.js';

export interface ToolEffectCachedResult {
  readonly output: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly status: 'succeeded' | 'failed';
}

export interface PersistedToolEffectLedgerItem {
  readonly scope: ScopeRef;
  readonly entry: ToolEffectLedgerEntry;
  readonly cachedOutput?: ToolEffectCachedResult;
  readonly operatorNote?: string;
  readonly commitRef: JournalCommitRef;
  readonly history: readonly ToolEffectLedgerEntry['state'][];
}

export interface ToolEffectLedgerPort {
  appendToolEffectLedgerEntry(
    input: ToolEffectLedgerEntry & {
      readonly scope: ScopeRef;
      readonly cachedOutput?: ToolEffectCachedResult;
      readonly operatorNote?: string;
    },
  ): Promise<JournalCommitRef>;
  readToolEffectLedgerEntries(query: {
    readonly scope: ScopeRef;
    readonly turnId?: string;
  }): Promise<readonly PersistedToolEffectLedgerItem[]>;
  appendTurnSegmentRecoveryFact(input: {
    readonly scope: ScopeRef;
    readonly fact: TurnSegmentRecoveryFact;
  }): Promise<JournalCommitRef>;
  readLatestTurnSegmentRecoveryFact(query: {
    readonly scope: ScopeRef;
    readonly turnId?: string;
  }): Promise<TurnSegmentRecoveryFact | null>;
}

export interface ExecuteToolWithEffectLedgerInput {
  readonly ledger: ToolEffectLedgerPort;
  readonly checkpointStore: CheckpointJournalPort;
  readonly ownerId?: string;
  readonly scope: ScopeRef;
  readonly turnId: string;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly recoveryStateRef: EvidenceRef;
  readonly boundStepEffectPolicy?: 'readonly' | 'mutating';
  readonly toolCallId: string;
  readonly toolId: string;
  readonly supportedKinds: readonly ('inspect' | 'apply' | 'run')[];
  readonly idempotencyKey?: string;
  readonly args: unknown;
  readonly execute: () => Promise<ToolEffectCachedResult>;
}

export interface ExecuteToolWithEffectLedgerResult {
  readonly result: ToolEffectCachedResult;
  readonly entry: ToolEffectLedgerEntry;
  readonly checkpoint: CommittedCheckpointRecord;
  readonly reusedCommittedEffect: boolean;
  readonly reusedReconciledEffect: boolean;
}

export interface CommitSubagentIncrementalCheckpointInput {
  readonly checkpointStore: CheckpointJournalPort;
  readonly ownerId?: string;
  readonly scope: ScopeRef;
  readonly turnId: string;
  readonly invocationId: string;
  readonly subagentKind: 'execution' | 'review';
  readonly summary: string;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly recoveryStateRef: EvidenceRef;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface EvaluateAndPersistTurnRecoveryInput {
  readonly ledger: ToolEffectLedgerPort;
  readonly checkpointStore: CheckpointJournalPort;
  readonly ownerId?: string;
  readonly scope: ScopeRef;
  readonly turnId: string;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly recoveryStateRef: EvidenceRef;
  readonly providerSettlements?: readonly ProviderSettleReceipt[];
  readonly stopped?: boolean;
}

export interface EvaluatedTurnRecoveryDecision {
  readonly outcome: TurnSegmentRecoveryOutcome | 'corrupt-blocked';
  readonly allowedActions: readonly ('start' | 'stop' | 'recover')[];
  readonly checkpoint?: CommittedCheckpointRecord;
  readonly fact?: TurnSegmentRecoveryFact;
  readonly error?: string;
  readonly ownerId: string;
}

export interface ReconcileHeldTurnEffectsInput {
  readonly ledger: ToolEffectLedgerPort;
  readonly checkpointStore: CheckpointJournalPort;
  readonly ownerId?: string;
  readonly scope: ScopeRef;
  readonly turnId: string;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly recoveryStateRef: EvidenceRef;
  readonly providerSettlements?: readonly ProviderSettleReceipt[];
  readonly operatorNote?: string;
}

const DEFAULT_EFFECT_RECOVERY_OWNER = 'humanagent.runtime.effect-ledger-recovery';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deriveToolEffectPolicy(
  supportedKinds: readonly ('inspect' | 'apply' | 'run')[],
): 'readonly' | 'mutating' {
  for (const kind of supportedKinds) {
    if (kind === 'apply' || kind === 'run') {
      return 'mutating';
    }
  }
  return 'readonly';
}

export function computeToolArgsDigest(args: unknown): string {
  const serialized = canonicalJsonStringify((args ?? {}) as Record<string, unknown>);
  return `sha256:${sha256Hex(serialized)}`;
}

export function computeToolIdempotencyKey(input: {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolId: string;
  readonly argsDigest: string;
}): string {
  return `idem:${input.turnId}:${input.toolCallId}:${input.toolId}:${input.argsDigest.slice(0, 24)}`;
}

async function commitIdempotentCheckpoint(input: {
  readonly checkpointStore: CheckpointJournalPort;
  readonly ownerId: string;
  readonly scope: ScopeRef;
  readonly checkpointIdValue: string;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly outcome: Checkpoint['outcome'];
  readonly summary: string;
  readonly recoveryStateRef: EvidenceRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly next: Checkpoint['next'];
  readonly checkpointKind: NonNullable<Checkpoint['checkpointKind']>;
  readonly recoveryOutcome?: TurnSegmentRecoveryOutcome;
  readonly recoveryFact?: TurnSegmentRecoveryFact;
}): Promise<CommittedCheckpointRecord> {
  if (!input.scope.cycleId) {
    throw new Error('effect-ledger checkpoint requires cycleId on scope');
  }
  const checkpointId = id('checkpoint', input.checkpointIdValue);
  const existing = await input.checkpointStore.readCommitted(input.scope, checkpointId);
  if (existing) {
    return existing;
  }
  const recalled = await recallCheckpoint(input.checkpointStore, {
    ownerId: input.ownerId,
    scope: input.scope,
  });
  const previous = recalled?.checkpoint ?? null;
  const checkpoint: Checkpoint = {
    id: checkpointId,
    scope: input.scope,
    cycleId: input.scope.cycleId,
    seq: (previous?.seq ?? 0) + 1,
    previousCheckpointId: previous?.id ?? null,
    directiveRevision: input.directiveRevision,
    executionEpoch: input.executionEpoch,
    outcome: input.outcome,
    summary: input.summary,
    recoveryStateRef: input.recoveryStateRef,
    evidenceRefs: input.evidenceRefs,
    next: input.next,
    checkpointKind: input.checkpointKind,
    ...(input.recoveryOutcome === undefined ? {} : { recoveryOutcome: input.recoveryOutcome }),
    ...(input.recoveryFact === undefined ? {} : { recoveryFact: input.recoveryFact }),
  };
  await completeCheckpoint(input.checkpointStore, {
    ownerId: input.ownerId,
    context: {
      scope: input.scope,
      cycleId: input.scope.cycleId,
      executionEpoch: input.executionEpoch,
      directiveRevision: input.directiveRevision,
    },
    previous,
    checkpoint,
  });
  const committed = await input.checkpointStore.readCommitted(input.scope, checkpointId);
  if (!committed || !sameCheckpoint(committed.checkpoint, checkpoint)) {
    throw new Error(`checkpoint ${checkpointId.value} exact committed readback is missing or mismatched`);
  }
  return committed;
}

export async function commitToolIncrementalCheckpoint(input: {
  readonly checkpointStore: CheckpointJournalPort;
  readonly ownerId?: string;
  readonly scope: ScopeRef;
  readonly turnId: string;
  readonly entry: ToolEffectLedgerEntry;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly recoveryStateRef: EvidenceRef;
  readonly evidenceRefs?: readonly EvidenceRef[];
}): Promise<CommittedCheckpointRecord> {
  const ownerId = input.ownerId ?? DEFAULT_EFFECT_RECOVERY_OWNER;
  const token = sha256Hex(`${input.turnId}:${input.entry.idempotencyKey}:${input.entry.state}`).slice(0, 24);
  const checkpointIdValue = `tool-inc-${token}`;
  const evidenceRefs =
    input.evidenceRefs && input.evidenceRefs.length > 0
      ? input.evidenceRefs
      : [input.recoveryStateRef];
  return commitIdempotentCheckpoint({
    checkpointStore: input.checkpointStore,
    ownerId,
    scope: input.scope,
    checkpointIdValue,
    directiveRevision: input.directiveRevision,
    executionEpoch: input.executionEpoch,
    outcome: 'waiting',
    summary: `工具增量检查点：${input.entry.toolName} (${input.entry.toolCallId}) 已记录账本状态 ${input.entry.state}。`,
    recoveryStateRef: input.recoveryStateRef,
    evidenceRefs,
    next: { kind: 'wait', ref: `tool-incremental:${input.entry.idempotencyKey}` },
    checkpointKind: 'tool-incremental',
  });
}

export async function commitSubagentIncrementalCheckpoint(
  input: CommitSubagentIncrementalCheckpointInput,
): Promise<CommittedCheckpointRecord> {
  const ownerId = input.ownerId ?? DEFAULT_EFFECT_RECOVERY_OWNER;
  const token = sha256Hex(`${input.turnId}:subagent:${input.subagentKind}:${input.invocationId}`).slice(0, 24);
  const checkpointIdValue = `subagent-inc-${token}`;
  const evidenceRefs =
    input.evidenceRefs && input.evidenceRefs.length > 0
      ? input.evidenceRefs
      : [input.recoveryStateRef];
  return commitIdempotentCheckpoint({
    checkpointStore: input.checkpointStore,
    ownerId,
    scope: input.scope,
    checkpointIdValue,
    directiveRevision: input.directiveRevision,
    executionEpoch: input.executionEpoch,
    outcome: 'waiting',
    summary: input.summary,
    recoveryStateRef: input.recoveryStateRef,
    evidenceRefs,
    next: { kind: 'wait', ref: `subagent:${input.invocationId}` },
    checkpointKind: 'subagent-incremental',
  });
}

export async function executeToolWithEffectLedger(
  input: ExecuteToolWithEffectLedgerInput,
): Promise<ExecuteToolWithEffectLedgerResult> {
  const ownerId = input.ownerId ?? DEFAULT_EFFECT_RECOVERY_OWNER;
  const effectPolicy = deriveToolEffectPolicy(input.supportedKinds);
  if (input.boundStepEffectPolicy === 'readonly' && effectPolicy === 'mutating') {
    const violation = new Error(
      `tool.effect-policy.violation: mutating tool ${input.toolId} is not allowed under readonly plan step`,
    ) as Error & { code?: string };
    violation.code = 'tool.effect-policy.violation';
    throw violation;
  }

  const argsDigest = computeToolArgsDigest(input.args);
  const idempotencyKey =
    input.idempotencyKey ??
    computeToolIdempotencyKey({
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      toolId: input.toolId,
      argsDigest,
    });

  const existingRecords = await input.ledger.readToolEffectLedgerEntries({
    scope: input.scope,
    turnId: input.turnId,
  });
  const matching = existingRecords.find(
    (item) => item.entry.idempotencyKey === idempotencyKey || item.entry.toolCallId === input.toolCallId,
  );

  if (matching && matching.entry.state === 'effect-committed') {
    const cachedResult: ToolEffectCachedResult = matching.cachedOutput ?? {
      output: JSON.stringify({
        reusedCommittedEffect: true,
        toolCallId: matching.entry.toolCallId,
        outputArtifactRef: matching.entry.outputArtifactRef ?? null,
      }),
      outputRefs: matching.entry.outputArtifactRef ? [matching.entry.outputArtifactRef] : [],
      evidenceRefs: [input.recoveryStateRef],
      status: 'succeeded',
    };
    const checkpoint = await commitToolIncrementalCheckpoint({
      checkpointStore: input.checkpointStore,
      ownerId,
      scope: input.scope,
      turnId: input.turnId,
      entry: matching.entry,
      directiveRevision: input.directiveRevision,
      executionEpoch: input.executionEpoch,
      recoveryStateRef: input.recoveryStateRef,
      evidenceRefs: cachedResult.evidenceRefs,
    });
    return {
      result: cachedResult,
      entry: matching.entry,
      checkpoint,
      reusedCommittedEffect: true,
      reusedReconciledEffect: false,
    };
  }

  if (matching && matching.entry.state === 'reconciled') {
    const reconciledResult: ToolEffectCachedResult = {
      output: JSON.stringify({
        reconciled: true,
        toolCallId: matching.entry.toolCallId,
        toolName: matching.entry.toolName,
        idempotencyKey: matching.entry.idempotencyKey,
        note: matching.operatorNote ?? 'operator reconciled unknown mutating effect without replay',
      }),
      outputRefs: matching.entry.outputArtifactRef ? [matching.entry.outputArtifactRef] : [],
      evidenceRefs: [input.recoveryStateRef],
      status: 'succeeded',
    };
    const checkpoint = await commitToolIncrementalCheckpoint({
      checkpointStore: input.checkpointStore,
      ownerId,
      scope: input.scope,
      turnId: input.turnId,
      entry: matching.entry,
      directiveRevision: input.directiveRevision,
      executionEpoch: input.executionEpoch,
      recoveryStateRef: input.recoveryStateRef,
      evidenceRefs: reconciledResult.evidenceRefs,
    });
    return {
      result: reconciledResult,
      entry: matching.entry,
      checkpoint,
      reusedCommittedEffect: false,
      reusedReconciledEffect: true,
    };
  }

  const preDispatchEntry: ToolEffectLedgerEntry = {
    callId: input.toolCallId,
    toolCallId: input.toolCallId,
    turnId: input.turnId,
    boundPlanStepId: 'step-1',
    toolName: input.toolId,
    effectPolicy,
    idempotencyKey,
    argsDigest,
    state: 'dispatched-effect-unknown',
    outputArtifactRef: null,
  };
  await input.ledger.appendToolEffectLedgerEntry({
    ...preDispatchEntry,
    scope: input.scope,
  });

  const result = await input.execute();

  if (result.status === 'succeeded') {
    const outputArtifactRef =
      result.outputRefs[0] ?? `artifact:tool:${sha256Hex(`${idempotencyKey}:${result.output}`).slice(0, 24)}`;
    const committedEntry: ToolEffectLedgerEntry = {
      ...preDispatchEntry,
      state: 'effect-committed',
      outputArtifactRef,
    };
    await input.ledger.appendToolEffectLedgerEntry({
      ...committedEntry,
      scope: input.scope,
      cachedOutput: result,
    });
    const checkpoint = await commitToolIncrementalCheckpoint({
      checkpointStore: input.checkpointStore,
      ownerId,
      scope: input.scope,
      turnId: input.turnId,
      entry: committedEntry,
      directiveRevision: input.directiveRevision,
      executionEpoch: input.executionEpoch,
      recoveryStateRef: input.recoveryStateRef,
      evidenceRefs: result.evidenceRefs,
    });
    return {
      result,
      entry: committedEntry,
      checkpoint,
      reusedCommittedEffect: false,
      reusedReconciledEffect: false,
    };
  }

  if (effectPolicy === 'readonly') {
    const failedCleanEntry: ToolEffectLedgerEntry = {
      ...preDispatchEntry,
      state: 'effect-failed-clean',
    };
    await input.ledger.appendToolEffectLedgerEntry({
      ...failedCleanEntry,
      scope: input.scope,
      cachedOutput: result,
    });
    const checkpoint = await commitToolIncrementalCheckpoint({
      checkpointStore: input.checkpointStore,
      ownerId,
      scope: input.scope,
      turnId: input.turnId,
      entry: failedCleanEntry,
      directiveRevision: input.directiveRevision,
      executionEpoch: input.executionEpoch,
      recoveryStateRef: input.recoveryStateRef,
      evidenceRefs: result.evidenceRefs,
    });
    return {
      result,
      entry: failedCleanEntry,
      checkpoint,
      reusedCommittedEffect: false,
      reusedReconciledEffect: false,
    };
  }

  // Mutating tool failed with unknown external effect: keep dispatched-effect-unknown and commit incremental checkpoint
  const checkpoint = await commitToolIncrementalCheckpoint({
    checkpointStore: input.checkpointStore,
    ownerId,
    scope: input.scope,
    turnId: input.turnId,
    entry: preDispatchEntry,
    directiveRevision: input.directiveRevision,
    executionEpoch: input.executionEpoch,
    recoveryStateRef: input.recoveryStateRef,
    evidenceRefs: result.evidenceRefs,
  });
  return {
    result,
    entry: preDispatchEntry,
    checkpoint,
    reusedCommittedEffect: false,
    reusedReconciledEffect: false,
  };
}

export async function evaluateAndPersistTurnRecovery(
  input: EvaluateAndPersistTurnRecoveryInput,
): Promise<EvaluatedTurnRecoveryDecision> {
  const ownerId = input.ownerId ?? DEFAULT_EFFECT_RECOVERY_OWNER;

  try {
    if (!input.turnId.trim()) {
      throw new Error('missing turnId for turn recovery evaluation');
    }
    if (!input.scope.taskId || !input.scope.cycleId || !input.scope.operationId) {
      throw new Error('incomplete scope for turn recovery evaluation');
    }

    const recalled = await recallCheckpoint(input.checkpointStore, {
      ownerId,
      scope: input.scope,
    });
    if (input.stopped === true || recalled?.checkpoint.outcome === 'stopped') {
      const committedStopped = recalled
        ? await input.checkpointStore.readCommitted(input.scope, recalled.checkpoint.id)
        : null;
      return {
        outcome: 'stopped',
        allowedActions: ['start'],
        ...(committedStopped ? { checkpoint: committedStopped } : {}),
        ownerId,
      };
    }

    const ledgerRecords = await input.ledger.readToolEffectLedgerEntries({
      scope: input.scope,
      turnId: input.turnId,
    });
    const entries = ledgerRecords.map((item) => item.entry);
    const providerSettlements = input.providerSettlements ?? [];
    const latestSettle = providerSettlements.at(-1);
    const priorFact =
      latestSettle === undefined
        ? await input.ledger.readLatestTurnSegmentRecoveryFact({
            scope: input.scope,
            turnId: input.turnId,
          })
        : null;
    const resolvedSettleReceipt: ProviderSettleReceipt = latestSettle
      ? {
          providerRequestId: latestSettle.providerRequestId,
          state: latestSettle.state,
          verifiedBy: latestSettle.verifiedBy,
          verifiedAt: latestSettle.verifiedAt,
        }
      : priorFact?.providerSettleReceipt ?? {
          providerRequestId: null,
          state: 'unknown',
          verifiedBy: 'lease-process-exit-reconcile',
          verifiedAt: new Date().toISOString(),
        };
    const recoveryOutcome = decideTurnSegmentRecovery(entries);

    const digestToken = sha256Hex(
      canonicalJsonStringify({
        turnId: input.turnId,
        outcome: recoveryOutcome,
        settleState: resolvedSettleReceipt.state,
        providerRequestId: resolvedSettleReceipt.providerRequestId,
        verifiedBy: resolvedSettleReceipt.verifiedBy,
        entries: entries.map((e) => ({ id: e.toolCallId ?? e.callId, state: e.state, key: e.idempotencyKey })),
      }),
    ).slice(0, 24);
    const checkpointIdValue = `recovery-${digestToken}`;
    const recoveryCheckpointRef = `checkpoint:${checkpointIdValue}`;
    const existingRecoveryCheckpoint = await input.checkpointStore.readCommitted(
      input.scope,
      id('checkpoint', checkpointIdValue),
    );
    if (existingRecoveryCheckpoint) {
      const existingFact =
        existingRecoveryCheckpoint.checkpoint.recoveryFact
        ?? priorFact
        ?? (await input.ledger.readLatestTurnSegmentRecoveryFact({
          scope: input.scope,
          turnId: input.turnId,
        }))
        ?? undefined;
      const isAutoResumeExisting = recoveryOutcome === 'recovery-auto-resumed';
      return {
        outcome: recoveryOutcome,
        allowedActions: isAutoResumeExisting ? ['stop'] : ['recover', 'stop'],
        checkpoint: existingRecoveryCheckpoint,
        ...(existingFact ? { fact: existingFact } : {}),
        ownerId,
      };
    }

    const fact: TurnSegmentRecoveryFact = {
      taskId: input.scope.taskId.value,
      operationId: input.scope.operationId.value,
      turnId: input.turnId,
      executionEpoch: input.executionEpoch,
      segmentSeq: 1,
      predecessorCheckpointId: recalled?.checkpoint.id.value ?? null,
      planRevisionId: null,
      recoveryResponsibilityOwner: 'humanagent.runtime',
      providerSettleReceipt: resolvedSettleReceipt,
      toolEffects: entries,
      recoveryOutcome,
      outcome: recoveryOutcome,
      recoveryCheckpointRef,
    };
    validateTurnSegmentRecoveryFact(fact);
    await input.ledger.appendTurnSegmentRecoveryFact({
      scope: input.scope,
      fact,
    });

    const isAutoResume = recoveryOutcome === 'recovery-auto-resumed';
    const committed = await commitIdempotentCheckpoint({
      checkpointStore: input.checkpointStore,
      ownerId,
      scope: input.scope,
      checkpointIdValue,
      directiveRevision: input.directiveRevision,
      executionEpoch: input.executionEpoch,
      outcome: isAutoResume ? 'waiting' : 'blocked',
      summary: isAutoResume
        ? `恢复检查点（recovery-auto-resumed）：已对账 ${entries.length} 条工具效果账本记录，无未决外部变更副作用，允许在同一业务 Turn 继续执行。`
        : `恢复检查点（recovery-hold-effect-unknown）：存在未决变更类工具副作用（dispatched-effect-unknown），已进入人工恢复等待（recover / stop）。`,
      recoveryStateRef: input.recoveryStateRef,
      evidenceRefs: [input.recoveryStateRef],
      next: isAutoResume
        ? { kind: 'wait', ref: recoveryCheckpointRef }
        : { kind: 'recover', ref: recoveryCheckpointRef },
      checkpointKind: 'recovery',
      recoveryOutcome,
      recoveryFact: fact,
    });

    return {
      outcome: recoveryOutcome,
      allowedActions: isAutoResume ? ['stop'] : ['recover', 'stop'],
      checkpoint: committed,
      fact,
      ownerId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let blockedCheckpoint: CommittedCheckpointRecord | undefined;
    if (input.scope.cycleId) {
      try {
        const corruptToken = sha256Hex(`${input.turnId}:corrupt:${message}`).slice(0, 24);
        blockedCheckpoint = await commitIdempotentCheckpoint({
          checkpointStore: input.checkpointStore,
          ownerId,
          scope: input.scope,
          checkpointIdValue: `recovery-corrupt-${corruptToken}`,
          directiveRevision: input.directiveRevision,
          executionEpoch: input.executionEpoch,
          outcome: 'blocked',
          summary: `恢复阻断（${ownerId}）：恢复事实缺失或损坏（${message}），保留原错误与恢复责任。`,
          recoveryStateRef: input.recoveryStateRef,
          evidenceRefs: [input.recoveryStateRef],
          next: { kind: 'stop', ref: `corrupt-recovery-facts:${ownerId}` },
          checkpointKind: 'recovery',
        });
      } catch {
        // Preserve original error if checkpoint store itself is unavailable
      }
    }
    return {
      outcome: 'corrupt-blocked',
      allowedActions: [],
      ...(blockedCheckpoint === undefined ? {} : { checkpoint: blockedCheckpoint }),
      error: message,
      ownerId,
    };
  }
}

export async function reconcileHeldTurnEffectsForRecover(
  input: ReconcileHeldTurnEffectsInput,
): Promise<EvaluatedTurnRecoveryDecision> {
  const ownerId = input.ownerId ?? DEFAULT_EFFECT_RECOVERY_OWNER;
  const existingRecords = await input.ledger.readToolEffectLedgerEntries({
    scope: input.scope,
    turnId: input.turnId,
  });
  const heldUnknownMutating = existingRecords.filter(
    (item) => item.entry.effectPolicy === 'mutating' && item.entry.state === 'dispatched-effect-unknown',
  );

  for (const held of heldUnknownMutating) {
    await input.ledger.appendToolEffectLedgerEntry({
      ...held.entry,
      scope: input.scope,
      state: 'reconciled',
      operatorNote: input.operatorNote ?? 'operator confirmed external side effect via recover action',
    });
  }

  return evaluateAndPersistTurnRecovery({
    ledger: input.ledger,
    checkpointStore: input.checkpointStore,
    ownerId,
    scope: input.scope,
    turnId: input.turnId,
    directiveRevision: input.directiveRevision,
    executionEpoch: input.executionEpoch,
    recoveryStateRef: input.recoveryStateRef,
    providerSettlements: input.providerSettlements,
    stopped: false,
  });
}
