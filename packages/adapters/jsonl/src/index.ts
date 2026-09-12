import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { assertCheckpointLink, assertEvidenceRef, assertSameScope, type Checkpoint, type ScopeRef } from '@humanagent/contracts';

export type JournalRecordKind = 'checkpoint' | 'event';

export interface JournalRecord {
  readonly version: 1;
  readonly seq: number;
  readonly kind: JournalRecordKind;
  readonly scope: ScopeRef;
  readonly checkpoint?: Checkpoint;
  readonly payload?: Record<string, unknown>;
  readonly previousRecordDigest: string | null;
  readonly recordDigest: string;
}

export interface JournalVerification {
  readonly valid: boolean;
  readonly records: readonly JournalRecord[];
  readonly error?: string;
  readonly trailingLine?: string;
}

export class JournalIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'JournalIntegrityError'; }
}

function assertJournalContract<T>(assertion: () => T): T {
  try {
    return assertion();
  } catch (error) {
    if (error instanceof JournalIntegrityError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new JournalIntegrityError(message, { cause: error });
  }
}

function digestRecord(record: Omit<JournalRecord, 'recordDigest'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
}

function validateRecord(record: JournalRecord, previous: JournalRecord | null, previousCheckpoint: Checkpoint | null): void {
  if (record.version !== 1 || !Number.isSafeInteger(record.seq) || record.seq < 1) throw new JournalIntegrityError('invalid journal record');
  if (record.seq !== (previous ? previous.seq + 1 : 1)) throw new JournalIntegrityError('duplicate or non-contiguous journal sequence');
  if (record.previousRecordDigest !== (previous?.recordDigest ?? null)) throw new JournalIntegrityError('broken journal predecessor link');
  if (record.recordDigest !== digestRecord({ ...record, recordDigest: undefined } as Omit<JournalRecord, 'recordDigest'>)) throw new JournalIntegrityError('journal record digest mismatch');
  assertScopeRef(record.scope);
  if (record.kind === 'checkpoint') {
    if (!record.checkpoint) throw new JournalIntegrityError('checkpoint record missing checkpoint');
    if (record.payload !== undefined) throw new JournalIntegrityError('checkpoint record cannot contain payload');
    assertScopeRef(record.checkpoint.scope);
    assertSameScope(record.scope, record.checkpoint.scope);
    if (record.checkpoint.scope.cycleId && record.checkpoint.scope.cycleId.value !== record.checkpoint.cycleId.value) throw new JournalIntegrityError('checkpoint cycle scope mismatch');
    if (record.scope.cycleId && record.scope.cycleId.value !== record.checkpoint.cycleId.value) throw new JournalIntegrityError('checkpoint cycle scope mismatch');
    assertJournalContract(() => {
      assertEvidenceRef(record.checkpoint!.recoveryStateRef);
      assertSameScope(record.checkpoint!.scope, record.checkpoint!.recoveryStateRef.scope);
      for (const evidenceRef of record.checkpoint!.evidenceRefs) {
        assertEvidenceRef(evidenceRef);
        assertSameScope(record.checkpoint!.scope, evidenceRef.scope);
      }
      assertCheckpointLink(record.checkpoint!, previousCheckpoint);
    });
  } else if (record.checkpoint) throw new JournalIntegrityError('event record cannot contain checkpoint');
  else if (record.payload === undefined) throw new JournalIntegrityError('event record missing payload');
}

function assertScopeRef(scope: ScopeRef): void {
  assertScopedId(scope.organId, 'organ');
  if (scope.taskId !== undefined) assertScopedId(scope.taskId, 'task');
  if (scope.cycleId !== undefined) assertScopedId(scope.cycleId, 'cycle');
  if (scope.operationId !== undefined) assertScopedId(scope.operationId, 'operation');
  assertSameScope(scope);
}

function assertScopedId(value: { readonly scope: string; readonly value: string }, expected: string): void {
  if (value.scope !== expected || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.value)) throw new JournalIntegrityError('invalid journal scope');
}

function parse(content: string): JournalVerification {
  if (content === '') return { valid: true, records: [] };
  const lines = content.split('\n');
  const trailingLine = lines[lines.length - 1] === '' ? undefined : lines.pop();
  const records: JournalRecord[] = [];
  let previousCheckpoint: Checkpoint | null = null;
  try {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) {
        if (index !== lines.length - 1) throw new JournalIntegrityError('blank journal line');
        continue;
      }
      const record = JSON.parse(line) as JournalRecord;
      validateRecord(record, records.at(-1) ?? null, previousCheckpoint);
      records.push(record);
      if (record.kind === 'checkpoint') previousCheckpoint = record.checkpoint ?? null;
    }
  } catch (error) {
    return { valid: false, records, error: error instanceof Error ? error.message : String(error), trailingLine };
  }
  return { valid: trailingLine === undefined, records, ...(trailingLine === undefined ? {} : { error: 'incomplete trailing journal line', trailingLine }) };
}

export class JsonlOrganJournal {
  constructor(private readonly filePath: string) {}

  async verify(): Promise<JournalVerification> { return parse(await readFile(this.filePath, 'utf8').catch((error: unknown) => (error as { code?: string }).code === 'ENOENT' ? '' : Promise.reject(error))); }

  async append(input: Omit<JournalRecord, 'version' | 'seq' | 'previousRecordDigest' | 'recordDigest'>): Promise<JournalRecord> {
    const verification = await this.verify();
    if (!verification.valid) throw new JournalIntegrityError(verification.error ?? 'journal is invalid');
    const previous = verification.records.at(-1) ?? null;
    const { kind, scope, checkpoint, payload } = input;
    assertScopeRef(scope);
    const recordWithoutDigest = { version: 1 as const, seq: (previous?.seq ?? 0) + 1, kind, scope, checkpoint, payload, previousRecordDigest: previous?.recordDigest ?? null };
    const lastCheckpoint = [...verification.records].reverse().find((record) => record.kind === 'checkpoint')?.checkpoint ?? null;
    if (input.kind === 'checkpoint') {
      if (!input.checkpoint) throw new JournalIntegrityError('checkpoint record missing checkpoint');
      if (input.payload !== undefined) throw new JournalIntegrityError('checkpoint record cannot contain payload');
      assertJournalContract(() => {
        assertEvidenceRef(input.checkpoint!.recoveryStateRef);
        assertSameScope(input.checkpoint!.scope, input.checkpoint!.recoveryStateRef.scope);
        for (const evidenceRef of input.checkpoint!.evidenceRefs) {
          assertEvidenceRef(evidenceRef);
          assertSameScope(input.checkpoint!.scope, evidenceRef.scope);
        }
        assertCheckpointLink(input.checkpoint!, lastCheckpoint);
      });
    }
    const record = { ...recordWithoutDigest, recordDigest: digestRecord(recordWithoutDigest) };
    validateRecord(record, previous, lastCheckpoint);
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  async latest(): Promise<JournalRecord | null> { const result = await this.verify(); if (!result.valid) throw new JournalIntegrityError(result.error ?? 'journal is invalid'); return result.records.at(-1) ?? null; }
  async replay(): Promise<readonly JournalRecord[]> { const result = await this.verify(); if (!result.valid) throw new JournalIntegrityError(result.error ?? 'journal is invalid'); return result.records; }
}
