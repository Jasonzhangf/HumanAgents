import { createHash } from 'node:crypto';
import {
  assertSameScope,
  validateTurnSegmentRecoveryFact,
  type EvidenceRef,
  type JournalCommitRef,
  type ScopeRef,
  type ToolEffectLedgerEntry,
  type TurnSegmentRecoveryFact,
} from '../../../contracts/src/index.js';
import {
  JournalIntegrityError,
  JsonlOrganJournal,
  type JournalRecord,
} from './index.js';

const EFFECT_LEDGER_PAYLOAD_TYPE = 'turn-segment.tool-effect-ledger';
const RECOVERY_FACT_PAYLOAD_TYPE = 'turn-segment.recovery-fact';

export interface PersistedToolEffectCachedOutput {
  readonly output: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly status: 'succeeded' | 'failed';
}

export interface ToolEffectLedgerAppendInput {
  readonly scope: ScopeRef;
  readonly callId?: string;
  readonly toolCallId?: string;
  readonly turnId?: string;
  readonly boundPlanStepId?: string;
  readonly toolName: string;
  readonly effectPolicy: 'readonly' | 'mutating';
  readonly argsDigest?: string;
  readonly idempotencyKey: string;
  readonly state: ToolEffectLedgerEntry['state'];
  readonly outputArtifactRef?: string | null;
  readonly cachedOutput?: PersistedToolEffectCachedOutput;
  readonly operatorNote?: string;
}

export interface PersistedToolEffectLedgerRecord {
  readonly scope: ScopeRef;
  readonly entry: ToolEffectLedgerEntry;
  readonly cachedOutput?: PersistedToolEffectCachedOutput;
  readonly operatorNote?: string;
  readonly commitRef: JournalCommitRef;
  readonly history: readonly ToolEffectLedgerEntry['state'][];
}

export interface ToolEffectLedgerJournalPort {
  appendToolEffectLedgerEntry(input: ToolEffectLedgerAppendInput): Promise<JournalCommitRef>;
  readToolEffectLedgerEntries(query: {
    readonly scope: ScopeRef;
    readonly turnId?: string;
  }): Promise<readonly PersistedToolEffectLedgerRecord[]>;
  appendTurnSegmentRecoveryFact(input: {
    readonly scope: ScopeRef;
    readonly fact: TurnSegmentRecoveryFact;
  }): Promise<JournalCommitRef>;
  readLatestTurnSegmentRecoveryFact(query: {
    readonly scope: ScopeRef;
    readonly turnId?: string;
  }): Promise<TurnSegmentRecoveryFact | null>;
}

interface EffectLedgerPayload {
  readonly type: typeof EFFECT_LEDGER_PAYLOAD_TYPE;
  readonly entry: ToolEffectLedgerEntry;
  readonly cachedOutput?: PersistedToolEffectCachedOutput;
  readonly operatorNote?: string;
}

interface RecoveryFactPayload {
  readonly type: typeof RECOVERY_FACT_PAYLOAD_TYPE;
  readonly fact: TurnSegmentRecoveryFact;
}

function sha256Short(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JournalIntegrityError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateLedgerEntry(entry: ToolEffectLedgerEntry): void {
  assertNonEmptyString(entry.turnId, 'tool effect ledger turnId');
  assertNonEmptyString(entry.toolCallId ?? entry.callId, 'tool effect ledger toolCallId');
  assertNonEmptyString(entry.toolName, 'tool effect ledger toolName');
  assertNonEmptyString(entry.idempotencyKey, 'tool effect ledger idempotencyKey');
  assertNonEmptyString(entry.argsDigest, 'tool effect ledger argsDigest');
  if (entry.effectPolicy !== 'readonly' && entry.effectPolicy !== 'mutating') {
    throw new JournalIntegrityError(`invalid tool effectPolicy: ${String(entry.effectPolicy)}`);
  }
  if (
    entry.state !== 'dispatched-effect-unknown'
    && entry.state !== 'effect-committed'
    && entry.state !== 'effect-failed-clean'
    && entry.state !== 'reconciled'
  ) {
    throw new JournalIntegrityError(`invalid tool effect state: ${String(entry.state)}`);
  }
  if (entry.state === 'effect-committed' && entry.outputArtifactRef !== undefined && entry.outputArtifactRef !== null) {
    assertNonEmptyString(entry.outputArtifactRef, 'tool effect ledger outputArtifactRef');
  }
}

function toEntryOnly(input: ToolEffectLedgerAppendInput): ToolEffectLedgerEntry {
  const resolvedCallId = input.callId ?? input.toolCallId ?? '';
  return {
    callId: resolvedCallId,
    toolCallId: input.toolCallId ?? resolvedCallId,
    turnId: input.turnId,
    boundPlanStepId: input.boundPlanStepId ?? 'step-1',
    toolName: input.toolName,
    effectPolicy: input.effectPolicy,
    idempotencyKey: input.idempotencyKey,
    argsDigest: input.argsDigest,
    state: input.state,
    outputArtifactRef: input.outputArtifactRef ?? null,
  };
}

function scopeMatches(recordScope: ScopeRef, queryScope: ScopeRef): boolean {
  if (recordScope.organId.value !== queryScope.organId.value) return false;
  if (queryScope.taskId && recordScope.taskId?.value !== queryScope.taskId.value) return false;
  if (queryScope.cycleId && recordScope.cycleId?.value !== queryScope.cycleId.value) return false;
  if (queryScope.operationId && recordScope.operationId?.value !== queryScope.operationId.value) return false;
  return true;
}

function isEffectLedgerRecord(record: JournalRecord): boolean {
  return record.kind === 'event' && record.payload?.type === EFFECT_LEDGER_PAYLOAD_TYPE;
}

function isRecoveryFactRecord(record: JournalRecord): boolean {
  return record.kind === 'event' && record.payload?.type === RECOVERY_FACT_PAYLOAD_TYPE;
}

function decodeEffectLedgerPayload(record: JournalRecord): EffectLedgerPayload {
  const payload = record.payload as unknown as EffectLedgerPayload;
  if (!payload || payload.type !== EFFECT_LEDGER_PAYLOAD_TYPE || !payload.entry) {
    throw new JournalIntegrityError('invalid tool effect ledger journal payload');
  }
  validateLedgerEntry(payload.entry);
  return payload;
}

function decodeRecoveryFactPayload(record: JournalRecord): RecoveryFactPayload {
  const payload = record.payload as unknown as RecoveryFactPayload;
  if (!payload || payload.type !== RECOVERY_FACT_PAYLOAD_TYPE || !payload.fact) {
    throw new JournalIntegrityError('invalid turn segment recovery fact payload');
  }
  validateTurnSegmentRecoveryFact(payload.fact);
  return payload;
}

function materializeLedgerRecords(
  records: readonly JournalRecord[],
  query: { readonly scope: ScopeRef; readonly turnId?: string },
): readonly PersistedToolEffectLedgerRecord[] {
  const byCallKey = new Map<string, PersistedToolEffectLedgerRecord>();
  for (const record of records) {
    if (!isEffectLedgerRecord(record)) continue;
    if (!scopeMatches(record.scope, query.scope)) continue;
    const payload = decodeEffectLedgerPayload(record);
    if (query.turnId !== undefined && payload.entry.turnId !== query.turnId) continue;
    const key = `${payload.entry.turnId}::${payload.entry.toolCallId}`;
    const commitRef: JournalCommitRef = {
      commitId: record.commitId ?? `seq:${record.seq}`,
      journalSeq: record.seq,
      recordDigest: record.recordDigest,
    };
    const existing = byCallKey.get(key);
    if (!existing) {
      if (payload.entry.state !== 'dispatched-effect-unknown') {
        throw new JournalIntegrityError(
          `tool effect ledger entry ${key} must start in dispatched-effect-unknown, found ${payload.entry.state}`,
        );
      }
      byCallKey.set(key, {
        scope: record.scope,
        entry: payload.entry,
        ...(payload.cachedOutput === undefined ? {} : { cachedOutput: payload.cachedOutput }),
        ...(payload.operatorNote === undefined ? {} : { operatorNote: payload.operatorNote }),
        commitRef,
        history: [payload.entry.state],
      });
      continue;
    }
    if (
      existing.entry.toolName !== payload.entry.toolName
      || existing.entry.effectPolicy !== payload.entry.effectPolicy
      || existing.entry.idempotencyKey !== payload.entry.idempotencyKey
      || existing.entry.argsDigest !== payload.entry.argsDigest
    ) {
      throw new JournalIntegrityError(`tool effect ledger identity mismatch on transition for ${key}`);
    }
    if (existing.entry.state === payload.entry.state) {
      continue;
    }
    if (existing.entry.state !== 'dispatched-effect-unknown') {
      throw new JournalIntegrityError(
        `illegal tool effect ledger state transition for ${key}: ${existing.entry.state} -> ${payload.entry.state}`,
      );
    }
    byCallKey.set(key, {
      scope: record.scope,
      entry: payload.entry,
      cachedOutput: payload.cachedOutput ?? existing.cachedOutput,
      operatorNote: payload.operatorNote ?? existing.operatorNote,
      commitRef,
      history: [...existing.history, payload.entry.state],
    });
  }
  return [...byCallKey.values()];
}

export function createJsonlToolEffectLedgerJournal(input: {
  readonly filePath: string;
  readonly journal?: JsonlOrganJournal;
}): ToolEffectLedgerJournalPort {
  if (!input.filePath.trim()) {
    throw new JournalIntegrityError('tool effect ledger journal path is required');
  }
  const journal = input.journal ?? new JsonlOrganJournal(input.filePath);

  return {
    async appendToolEffectLedgerEntry(appendInput: ToolEffectLedgerAppendInput): Promise<JournalCommitRef> {
      assertSameScope(appendInput.scope);
      const entry = toEntryOnly(appendInput);
      validateLedgerEntry(entry);
      const commitId = `effect-ledger:${sha256Short(
        `${appendInput.scope.taskId?.value ?? ''}:${appendInput.scope.operationId?.value ?? ''}:${entry.turnId}:${entry.toolCallId}:${entry.state}`,
      )}`;

      return journal.transaction(
        ({ records }) => {
          const current = materializeLedgerRecords(records, {
            scope: appendInput.scope,
            turnId: entry.turnId,
          }).find((item) => item.entry.toolCallId === entry.toolCallId);

          if (!current) {
            if (entry.state !== 'dispatched-effect-unknown') {
              throw new JournalIntegrityError(
                `cannot append ${entry.state} before dispatched-effect-unknown for toolCallId ${entry.toolCallId}`,
              );
            }
            return { existingCommit: null as JournalCommitRef | null };
          }
          if (
            current.entry.toolName !== entry.toolName
            || current.entry.effectPolicy !== entry.effectPolicy
            || current.entry.idempotencyKey !== entry.idempotencyKey
            || current.entry.argsDigest !== entry.argsDigest
          ) {
            throw new JournalIntegrityError(
              `tool effect ledger transition conflicts with existing identity for toolCallId ${entry.toolCallId}`,
            );
          }
          if (current.entry.state === entry.state) {
            return { existingCommit: current.commitRef };
          }
          if (current.entry.state !== 'dispatched-effect-unknown') {
            throw new JournalIntegrityError(
              `cannot transition toolCallId ${entry.toolCallId} from terminal state ${current.entry.state} to ${entry.state}`,
            );
          }
          return { existingCommit: null as JournalCommitRef | null };
        },
        async (plan, append) => {
          if (plan.existingCommit) return plan.existingCommit;
          const payload: EffectLedgerPayload = {
            type: EFFECT_LEDGER_PAYLOAD_TYPE,
            entry,
            ...(appendInput.cachedOutput === undefined ? {} : { cachedOutput: appendInput.cachedOutput }),
            ...(appendInput.operatorNote === undefined ? {} : { operatorNote: appendInput.operatorNote }),
          };
          const record = await append({
            commitId,
            kind: 'event',
            scope: appendInput.scope,
            payload: payload as unknown as Record<string, unknown>,
          });
          return {
            commitId: record.commitId ?? commitId,
            journalSeq: record.seq,
            recordDigest: record.recordDigest,
          };
        },
      );
    },

    async readToolEffectLedgerEntries(query: {
      readonly scope: ScopeRef;
      readonly turnId?: string;
    }): Promise<readonly PersistedToolEffectLedgerRecord[]> {
      assertSameScope(query.scope);
      const verification = await journal.verify();
      if (!verification.valid) {
        throw new JournalIntegrityError(verification.error ?? 'tool effect ledger journal is invalid');
      }
      return materializeLedgerRecords(verification.records, query);
    },

    async appendTurnSegmentRecoveryFact(factInput: {
      readonly scope: ScopeRef;
      readonly fact: TurnSegmentRecoveryFact;
    }): Promise<JournalCommitRef> {
      assertSameScope(factInput.scope);
      validateTurnSegmentRecoveryFact(factInput.fact);
      const commitId = `recovery-fact:${sha256Short(
        `${factInput.scope.taskId?.value ?? ''}:${factInput.scope.operationId?.value ?? ''}:${factInput.fact.turnId}:${factInput.fact.recoveryCheckpointRef}:${factInput.fact.outcome ?? factInput.fact.recoveryOutcome}`,
      )}`;
      return journal.transaction(
        ({ records }) => {
          const existing = records.find((r) => r.commitId === commitId);
          return {
            existingCommit: existing
              ? {
                  commitId: existing.commitId ?? commitId,
                  journalSeq: existing.seq,
                  recordDigest: existing.recordDigest,
                }
              : null,
          };
        },
        async (plan, append) => {
          if (plan.existingCommit) return plan.existingCommit;
          const payload: RecoveryFactPayload = {
            type: RECOVERY_FACT_PAYLOAD_TYPE,
            fact: factInput.fact,
          };
          const record = await append({
            commitId,
            kind: 'event',
            scope: factInput.scope,
            payload: payload as unknown as Record<string, unknown>,
          });
          return {
            commitId: record.commitId ?? commitId,
            journalSeq: record.seq,
            recordDigest: record.recordDigest,
          };
        },
      );
    },

    async readLatestTurnSegmentRecoveryFact(query: {
      readonly scope: ScopeRef;
      readonly turnId?: string;
    }): Promise<TurnSegmentRecoveryFact | null> {
      assertSameScope(query.scope);
      const verification = await journal.verify();
      if (!verification.valid) {
        throw new JournalIntegrityError(verification.error ?? 'tool effect ledger journal is invalid');
      }
      let latest: TurnSegmentRecoveryFact | null = null;
      for (const record of verification.records) {
        if (!isRecoveryFactRecord(record)) continue;
        if (!scopeMatches(record.scope, query.scope)) continue;
        const payload = decodeRecoveryFactPayload(record);
        if (query.turnId !== undefined && payload.fact.turnId !== query.turnId) continue;
        latest = payload.fact;
      }
      return latest;
    },
  };
}
