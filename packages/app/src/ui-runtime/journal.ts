import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Checkpoint,
  ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  CheckpointAppendReceipt,
  CheckpointAppendRequest,
  CheckpointChainVerification,
  CheckpointJournalPort,
  LatestCheckpointRecord,
} from '../../../runtime/src/checkpoints/ports.js';
import type { CheckpointClosurePort } from '../../../runtime/src/checkpoints/ports.js';
import type { ClosureRecord, InteractionClosureRecord } from '../../../runtime/src/checkpoints/closure.js';
import type { CheckpointCommitPort } from '../../../runtime/src/control/steering.js';
import { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import type { RuntimeTaskJournalPort, RuntimeTaskJournalRecord } from '../../../runtime/src/ui-runtime/coordinator.js';
import { checkpointCommitId } from '../../../runtime/src/checkpoints/coordinator.js';

// App-owned UI runtime journal. This is not the Organ Journal or the runtime
// lifecycle state; it only stores enough typed projection state for the UI
// runtime server to reconstruct tasks, operation event streams, and counters
// after a process restart without making the browser read raw runtime state.
export type UiRuntimeJournalRecord = RuntimeTaskJournalRecord;

function requireRecordString(record: Record<string, unknown>, key: string, filePath: string, line: number): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} is required`);
  }
  return value;
}

function requireRecordObject(record: Record<string, unknown>, key: string, filePath: string, line: number): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} is required`);
  }
  return value as Record<string, unknown>;
}

function requireScopedId(record: Record<string, unknown>, key: string, scope: string, filePath: string, line: number): void {
  const value = requireRecordObject(record, key, filePath, line);
  if (value.scope !== scope) throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key}.scope must be ${scope}`);
  requireRecordString(value, 'value', filePath, line);
}

function requirePositiveInteger(record: Record<string, unknown>, key: string, filePath: string, line: number): void {
  if (!Number.isSafeInteger(record[key]) || Number(record[key]) <= 0) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} is invalid`);
  }
}

function checkpointIdKey(id: Checkpoint['id']): string {
  return `${id.scope}:${id.value}`;
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function checkpointScopeKey(scope: ScopeRef): string {
  return [
    `${scope.organId.scope}:${scope.organId.value}`,
    `${scope.taskId?.scope ?? '-'}:${scope.taskId?.value ?? '-'}`,
    `${scope.cycleId?.scope ?? '-'}:${scope.cycleId?.value ?? '-'}`,
    `${scope.operationId?.scope ?? '-'}:${scope.operationId?.value ?? '-'}`,
  ].join('|');
}

function checkpointChainKey(id: Checkpoint['id'], scope: ScopeRef): string {
  return `${checkpointIdKey(id)}|${checkpointScopeKey(scope)}`;
}

function validateEvidenceRefs(value: unknown, filePath: string, line: number): void {
  if (!Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: event.evidenceRefs are required`);
  }
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: event evidenceRef must be an object`);
    }
    const ref = candidate as Record<string, unknown>;
    requireScopedId(ref, 'evidenceId', 'evidence', filePath, line);
    requireRecordString(ref, 'kind', filePath, line);
    requireRecordString(ref, 'source', filePath, line);
    requireRecordString(ref, 'locator', filePath, line);
    requireRecordObject(ref, 'scope', filePath, line);
  }
}

function validateRuntimeEvent(value: unknown, filePath: string, line: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: operation.event event is required`);
  }
  const event = value as Record<string, unknown>;
  requireRecordString(event, 'eventId', filePath, line);
  requirePositiveInteger(event, 'seq', filePath, line);
  requireRecordString(event, 'occurredAt', filePath, line);
  requireScopedId(event, 'taskId', 'task', filePath, line);
  requireRecordString(event, 'operationId', filePath, line);
  requirePositiveInteger(event, 'executionEpoch', filePath, line);
  requireRecordString(event, 'kind', filePath, line);
  requireRecordString(event, 'state', filePath, line);
  requireRecordString(event, 'summary', filePath, line);
  validateEvidenceRefs(event.evidenceRefs, filePath, line);
}

function validateJournalRecord(value: unknown, filePath: string, line: number): UiRuntimeJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: record must be an object`);
  }
  const record = value as Record<string, unknown>;
  const kind = requireRecordString(record, 'kind', filePath, line);
  if (kind === 'task.created') {
    requireScopedId(record, 'taskId', 'task', filePath, line);
    requireRecordString(record, 'title', filePath, line);
    requireRecordString(record, 'directive', filePath, line);
    requirePositiveInteger(record, 'directiveRevision', filePath, line);
    requireRecordString(record, 'createdAt', filePath, line);
    requirePositiveInteger(record, 'taskCounter', filePath, line);
    return record as unknown as UiRuntimeJournalRecord;
  }
  if (kind === 'task.updated') {
    requireScopedId(record, 'taskId', 'task', filePath, line);
    requireRecordString(record, 'title', filePath, line);
    requireRecordString(record, 'directive', filePath, line);
    requirePositiveInteger(record, 'directiveRevision', filePath, line);
    requireRecordString(record, 'updatedAt', filePath, line);
    return record as unknown as UiRuntimeJournalRecord;
  }
  if (kind === 'task.deleted') {
    requireScopedId(record, 'taskId', 'task', filePath, line);
    requireRecordString(record, 'deletedAt', filePath, line);
    return record as unknown as UiRuntimeJournalRecord;
  }
  if (kind === 'operation.started') {
    requireScopedId(record, 'operationId', 'operation', filePath, line);
    requireScopedId(record, 'taskId', 'task', filePath, line);
    requireScopedId(record, 'cycleId', 'cycle', filePath, line);
    const scope = requireRecordObject(record, 'scope', filePath, line);
    requireScopedId(scope, 'organId', 'organ', filePath, line);
    requireScopedId(scope, 'taskId', 'task', filePath, line);
    requireScopedId(scope, 'cycleId', 'cycle', filePath, line);
    requireScopedId(scope, 'operationId', 'operation', filePath, line);
    requireRecordString(record, 'startedAt', filePath, line);
    requirePositiveInteger(record, 'executionEpoch', filePath, line);
    requirePositiveInteger(record, 'operationCounter', filePath, line);
    requirePositiveInteger(record, 'cycleCounter', filePath, line);
    requireRecordString(record, 'input', filePath, line);
    if (record.orchestrated !== undefined && typeof record.orchestrated !== 'boolean') {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: orchestrated must be a boolean`);
    }
    return record as unknown as UiRuntimeJournalRecord;
  }
  if (kind === 'operation.event') {
    requireScopedId(record, 'operationId', 'operation', filePath, line);
    validateRuntimeEvent(record.event, filePath, line);
    if (record.taskOutput !== undefined && typeof record.taskOutput !== 'string') {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: taskOutput must be a string`);
    }
    if (record.error !== undefined) {
      const taskError = requireRecordObject(record, 'error', filePath, line);
      requireRecordString(taskError, 'code', filePath, line);
      requireRecordString(taskError, 'ownerId', filePath, line);
      requireRecordString(taskError, 'message', filePath, line);
      if (typeof taskError.retryable !== 'boolean') throw new Error(`corrupt UI runtime journal ${filePath}:${line}: error.retryable is invalid`);
      requireRecordString(taskError, 'nextAction', filePath, line);
    }
    return record as unknown as UiRuntimeJournalRecord;
  }
  if (kind === 'explicit-brain.state') {
    const state = requireRecordObject(record, 'state', filePath, line);
    requireRecordObject(state, 'intake', filePath, line);
    requireRecordObject(state, 'inbox', filePath, line);
    requireRecordObject(state, 'confirmationLedger', filePath, line);
    return record as unknown as UiRuntimeJournalRecord;
  }
  if (kind === 'interaction.closure') {
    const closure = requireRecordObject(record, 'closure', filePath, line);
    if (closure.closureKind !== 'interaction') {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: closure kind must be interaction`);
    }
    requireRecordString(closure, 'closureId', filePath, line);
    requireRecordObject(closure, 'scope', filePath, line);
    requireRecordString(closure, 'reason', filePath, line);
    validateEvidenceRefs(closure.evidenceRefs, filePath, line);
    return record as unknown as UiRuntimeJournalRecord;
  }
  throw new Error(`corrupt UI runtime journal ${filePath}:${line}: unsupported record kind ${kind}`);
}

export class UiRuntimeJournal implements RuntimeTaskJournalPort, CheckpointClosurePort {
  constructor(private readonly filePath: string) {}

  append(record: UiRuntimeJournalRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  replay(): readonly UiRuntimeJournalRecord[] {
    if (!existsSync(this.filePath)) return [];
    const records: UiRuntimeJournalRecord[] = [];
    const lines = readFileSync(this.filePath, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(validateJournalRecord(JSON.parse(trimmed), this.filePath, index + 1));
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`corrupt UI runtime journal ${this.filePath}:${index + 1}: invalid JSON`);
        }
        throw error;
      }
    }
    return records;
  }

  async commit(input: ClosureRecord): Promise<{ readonly closureId: string; readonly committed: true }> {
    if (!('closureKind' in input) || input.closureKind !== 'interaction') {
      throw new Error('UI runtime journal only owns interaction closures');
    }
    const existing = [...this.replay()].reverse().find((record) => (
      record.kind === 'interaction.closure' && record.closure.closureId === input.closureId
    ));
    if (existing?.kind === 'interaction.closure') {
      if (JSON.stringify(existing.closure) !== JSON.stringify(input)) {
        throw new Error(`interaction closure conflict: ${input.closureId}`);
      }
      return { closureId: input.closureId, committed: true };
    }
    this.append({ kind: 'interaction.closure', closure: input });
    return { closureId: input.closureId, committed: true };
  }

  async read(closureId: string): Promise<ClosureRecord | null> {
    const record = [...this.replay()].reverse().find((candidate) => candidate.kind === 'interaction.closure' && candidate.closure.closureId === closureId);
    return record?.kind === 'interaction.closure' ? structuredClone(record.closure) as InteractionClosureRecord : null;
  }
}

// File-backed checkpoint store. Wraps the authoritative JsonlOrganJournal adapter
// (packages/adapters/jsonl) so checkpoint persistence and link validation stay in
// their single owner; the UI runtime only assembles the port.
export class FileCheckpointStore implements CheckpointJournalPort, CheckpointCommitPort {
  constructor(private readonly filePath: string) {}

  async verify(_scope: ScopeRef): Promise<CheckpointChainVerification> {
    const verification = await this.journal().verify();
    return verification.valid ? { valid: true } : { valid: false, reason: verification.error ?? 'checkpoint journal is invalid' };
  }

  async readLatest(scope: ScopeRef): Promise<LatestCheckpointRecord | null> {
    const records = await this.journal().replay();
    const checkpointByChain = new Map<string, Checkpoint>();
    for (const record of records) {
      if (record.kind === 'checkpoint' && record.checkpoint) {
        checkpointByChain.set(checkpointChainKey(record.checkpoint.id, record.checkpoint.scope), record.checkpoint);
      }
    }
    const businessCheckpoints = records
      .filter((record) =>
        record.kind === 'checkpoint'
        && record.checkpoint
        && sameScopedId(record.scope.organId, scope.organId)
        && sameScopedId(record.scope.taskId, scope.taskId)
        && sameScopedId(record.scope.cycleId, scope.cycleId))
      .map((record) => record.checkpoint as Checkpoint);
    const exactOperationCheckpoints = scope.operationId
      ? businessCheckpoints.filter((checkpoint) => sameScopedId(checkpoint.scope.operationId, scope.operationId))
      : [];
    const checkpoints = exactOperationCheckpoints.length > 0
      ? exactOperationCheckpoints
      : businessCheckpoints.filter((checkpoint) => !checkpoint.scope.operationId);
    const latest = checkpoints.at(-1);
    if (!latest) return null;
    if (latest.previousCheckpointId === null) {
      return { checkpoint: latest, previous: null };
    }
    const previous = checkpointByChain.get(checkpointChainKey(latest.previousCheckpointId, latest.scope))
      ?? (latest.outcome === 'stopped' && latest.scope.operationId
        ? checkpointByChain.get(checkpointChainKey(latest.previousCheckpointId, {
          organId: latest.scope.organId,
          ...(latest.scope.taskId ? { taskId: latest.scope.taskId } : {}),
          ...(latest.scope.cycleId ? { cycleId: latest.scope.cycleId } : {}),
        }))
        : undefined);
    if (!previous) {
      throw new Error(`corrupt UI runtime checkpoint journal ${this.filePath}: previous checkpoint ${latest.previousCheckpointId.value} is missing`);
    }
    return { checkpoint: latest, previous };
  }

  async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
    const record = await this.journal().append({
      commitId: input.commitId,
      kind: 'checkpoint',
      scope: input.checkpoint.scope,
      checkpoint: input.checkpoint,
    });
    return {
      checkpointId: input.checkpoint.id,
      seq: record.seq,
      recordDigest: record.recordDigest,
    };
  }

  async commit(checkpoint: Checkpoint): Promise<{
    readonly checkpointId: Checkpoint['id'];
    readonly committed: true;
    readonly recordDigest: string;
  }> {
    const receipt = await this.append({
      ownerId: 'humanagent.app',
      commitId: checkpointCommitId(checkpoint),
      checkpoint,
    });
    if (!receipt.recordDigest) {
      throw new Error(`checkpoint commit ${checkpoint.id.value} did not return a journal record digest`);
    }
    return {
      checkpointId: checkpoint.id,
      committed: true,
      recordDigest: receipt.recordDigest,
    };
  }

  private journal(): JsonlOrganJournal {
    return new JsonlOrganJournal(this.filePath);
  }
}
