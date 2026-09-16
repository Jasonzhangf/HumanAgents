import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { assertCheckpointLink, assertEvidenceRef, assertSameScope, type Checkpoint, type ScopeRef } from '@humanagent/contracts';

declare module 'node:fs/promises' {
  interface FileHandle {
    sync(): Promise<void>;
  }
  function link(oldPath: string, newPath: string): Promise<void>;
  function rename(oldPath: string, newPath: string): Promise<void>;
}

export type JournalRecordKind = 'checkpoint' | 'event';

export interface JournalRecord {
  readonly version: 1;
  readonly seq: number;
  readonly kind: JournalRecordKind;
  readonly scope: ScopeRef;
  readonly commitId?: string;
  readonly commitFactDigest?: string;
  readonly checkpoint?: Checkpoint;
  readonly payload?: Record<string, unknown>;
  readonly previousRecordDigest: string | null;
  readonly recordDigest: string;
}

export interface JournalAppendInput {
  readonly commitId?: string;
  readonly kind: JournalRecordKind;
  readonly scope: ScopeRef;
  readonly checkpoint?: Checkpoint;
  readonly payload?: Record<string, unknown>;
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

export class JournalCommitConflictError extends JournalIntegrityError {
  constructor(
    public readonly commitId: string,
    public readonly existingRecord: JournalRecord,
    options?: ErrorOptions,
  ) {
    super(`commit conflict for ${commitId}`, options);
    this.name = 'JournalCommitConflictError';
  }
}

const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(): string {
  return String(createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex'));
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

function digestCommitFact(input: Pick<JournalAppendInput, 'kind' | 'scope' | 'checkpoint' | 'payload'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    kind: input.kind,
    scope: input.scope,
    checkpoint: input.checkpoint ?? null,
    payload: input.payload ?? null,
  })).digest('hex')}`;
}

function validateCommitId(commitId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(commitId)) throw new JournalIntegrityError('invalid journal commitId');
}

function checkpointKey(checkpoint: Checkpoint): string {
  return `${checkpoint.id.scope}:${checkpoint.id.value}`;
}

function resolveCheckpointPredecessor(checkpoint: Checkpoint, checkpoints: ReadonlyMap<string, Checkpoint>): Checkpoint | null {
  if (checkpoint.previousCheckpointId === null) return null;
  const previous = checkpoints.get(`${checkpoint.previousCheckpointId.scope}:${checkpoint.previousCheckpointId.value}`);
  if (!previous) throw new JournalIntegrityError('broken checkpoint predecessor');
  return previous;
}

function validateRecord(record: JournalRecord, previous: JournalRecord | null, checkpoints: ReadonlyMap<string, Checkpoint>): void {
  if (record.version !== 1 || !Number.isSafeInteger(record.seq) || record.seq < 1) throw new JournalIntegrityError('invalid journal record');
  if (record.seq !== (previous ? previous.seq + 1 : 1)) throw new JournalIntegrityError('duplicate or non-contiguous journal sequence');
  if (record.previousRecordDigest !== (previous?.recordDigest ?? null)) throw new JournalIntegrityError('broken journal predecessor link');
  if (record.recordDigest !== digestRecord({ ...record, recordDigest: undefined } as Omit<JournalRecord, 'recordDigest'>)) throw new JournalIntegrityError('journal record digest mismatch');
  if (record.commitFactDigest !== undefined || record.commitId !== undefined) {
    if (record.commitId === undefined || record.commitFactDigest === undefined) throw new JournalIntegrityError('journal commit fields are incomplete');
    validateCommitId(record.commitId);
    if (record.commitFactDigest !== digestCommitFact(record)) throw new JournalIntegrityError('journal commit fact digest mismatch');
  }
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
      assertCheckpointLink(record.checkpoint!, resolveCheckpointPredecessor(record.checkpoint!, checkpoints));
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
  const checkpoints = new Map<string, Checkpoint>();
  try {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) {
        if (index !== lines.length - 1) throw new JournalIntegrityError('blank journal line');
        continue;
      }
      const record = JSON.parse(line) as JournalRecord;
      validateRecord(record, records.at(-1) ?? null, checkpoints);
      records.push(record);
      if (record.kind === 'checkpoint' && record.checkpoint) checkpoints.set(checkpointKey(record.checkpoint), record.checkpoint);
    }
  } catch (error) {
    return { valid: false, records, error: error instanceof Error ? error.message : String(error), trailingLine };
  }
  return { valid: trailingLine === undefined, records, ...(trailingLine === undefined ? {} : { error: 'incomplete trailing journal line', trailingLine }) };
}

function recoverCommittedContent(content: string): { readonly content: string; readonly truncated: boolean } {
  if (content === '') return { content, truncated: false };
  const trailingLine = content.split('\n').at(-1) ?? '';
  if (trailingLine !== '') return { content: content.slice(0, content.length - trailingLine.length), truncated: true };
  return { content, truncated: false };
}

interface LockInfo {
  readonly pid: number;
  readonly startedAt: string;
  readonly token?: string;
}

function readLockInfo(content: string): LockInfo | null {
  try {
    const parsed = JSON.parse(content) as Partial<LockInfo>;
    if (
      typeof parsed.pid === 'number'
      && typeof parsed.startedAt === 'string'
      && Number.isFinite(Date.parse(parsed.startedAt))
      && (parsed.token === undefined || (typeof parsed.token === 'string' && parsed.token.length > 0))
    ) {
      return { pid: parsed.pid, startedAt: parsed.startedAt, ...(parsed.token === undefined ? {} : { token: parsed.token }) };
    }
    return null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    (process as unknown as { kill(pid: number, signal: 0): void }).kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    return readLockInfo(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function evictDeadLock(lockPath: string, expected: LockInfo): Promise<boolean> {
  const guardPath = `${lockPath}.evict`;
  try {
    await mkdir(guardPath);
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const current = await readLock(lockPath);
    if (!current) return false;
    if (current.pid !== expected.pid || current.token !== expected.token) return false;
    if (processAlive(current.pid)) return false;
    const stalePath = `${lockPath}.stale-${process.pid}-${Date.now().toString(36)}-${randomToken()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return true;
      throw error;
    }
    await rm(stalePath, { force: true });
    return true;
  } finally {
    await rm(guardPath, { recursive: true, force: true });
  }
}

async function acquireLock(journalPath: string): Promise<{ path: string; token: string }> {
  const lockPath = `${journalPath}.lock`;
  const startedAt = new Date().toISOString();
  const token = randomToken();
  const deadline = Date.now() + LOCK_WAIT_MS;
  await mkdir(dirname(journalPath), { recursive: true });
  for (;;) {
    const tempLockPath = `${lockPath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try {
      const handle = await open(tempLockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt, token }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tempLockPath, lockPath);
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        await rm(tempLockPath, { force: true }).catch(() => undefined);
        const current = await readLock(lockPath);
        if (current && !processAlive(current.pid)) {
          if (await evictDeadLock(lockPath, current)) continue;
        }
        if (Date.now() >= deadline) throw new JournalIntegrityError('journal lock timeout');
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      await rm(tempLockPath, { force: true }).catch(() => undefined);
      return { path: lockPath, token };
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') {
        await rm(tempLockPath, { force: true }).catch(() => undefined);
        continue;
      }
      await rm(tempLockPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function releaseLock(lock: { readonly path: string; readonly token: string }): Promise<void> {
  const current = await readLock(lock.path);
  if (current?.pid === process.pid && current.token === lock.token) {
    await rm(lock.path, { force: true });
  }
}

async function readVerifiedJournal(filePath: string): Promise<JournalVerification> {
  const raw = await readFile(filePath, 'utf8').catch((error: unknown) => (error as { code?: string }).code === 'ENOENT' ? '' : Promise.reject(error));
  return parse(raw);
}

async function replaceFileDurably(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.recover-${process.pid}-${Date.now().toString(36)}-${randomToken()}`;
  try {
    const handle = await open(tempPath, 'wx');
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    const directory = await open(dirname(filePath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class JsonlOrganJournal {
  constructor(private readonly filePath: string) {}

  async verify(): Promise<JournalVerification> { return readVerifiedJournal(this.filePath); }

  async recover(): Promise<JournalVerification> {
    const lock = await acquireLock(this.filePath);
    try {
      const raw = await readFile(this.filePath, 'utf8').catch((error: unknown) => (error as { code?: string }).code === 'ENOENT' ? '' : Promise.reject(error));
      const recovered = recoverCommittedContent(raw);
      const verification = parse(recovered.content);
      if (!verification.valid) throw new JournalIntegrityError(verification.error ?? 'journal is invalid');
      if (recovered.truncated) await replaceFileDurably(this.filePath, recovered.content);
      return verification;
    } finally {
      await releaseLock(lock);
    }
  }

  async findByCommitId(commitId: string): Promise<JournalRecord | null> {
    validateCommitId(commitId);
    const verification = await this.verify();
    if (!verification.valid) throw new JournalIntegrityError(verification.error ?? 'journal is invalid');
    return verification.records.find((record) => record.commitId === commitId) ?? null;
  }

  async append(input: JournalAppendInput): Promise<JournalRecord> {
    const commitId = input.commitId;
    if (commitId !== undefined) validateCommitId(commitId);
    if (input.kind === 'checkpoint' && input.payload !== undefined) throw new JournalIntegrityError('checkpoint record cannot contain payload');
    if (input.kind === 'event' && input.checkpoint !== undefined) throw new JournalIntegrityError('event record cannot contain checkpoint');
    const lock = await acquireLock(this.filePath);
    try {
      const verification = await readVerifiedJournal(this.filePath);
      if (!verification.valid) throw new JournalIntegrityError(verification.error ?? 'journal is invalid');
      if (commitId !== undefined) {
        const existing = verification.records.find((record) => record.commitId === commitId);
        if (existing) {
          if (existing.commitFactDigest === digestCommitFact(input)) return existing;
          throw new JournalCommitConflictError(commitId, existing);
        }
      }
      const previous = verification.records.at(-1) ?? null;
      const { kind, scope, checkpoint, payload } = input;
      assertScopeRef(scope);
      const recordWithoutDigest = {
        version: 1 as const,
        seq: (previous?.seq ?? 0) + 1,
        kind,
        scope,
        commitId,
        commitFactDigest: commitId === undefined ? undefined : digestCommitFact(input),
        checkpoint,
        payload,
        previousRecordDigest: previous?.recordDigest ?? null,
      };
      const checkpoints = new Map<string, Checkpoint>();
      for (const record of verification.records) {
        if (record.kind === 'checkpoint' && record.checkpoint) checkpoints.set(checkpointKey(record.checkpoint), record.checkpoint);
      }
      if (input.kind === 'checkpoint') {
        if (!input.checkpoint) throw new JournalIntegrityError('checkpoint record missing checkpoint');
        assertJournalContract(() => {
          assertEvidenceRef(input.checkpoint!.recoveryStateRef);
          assertSameScope(input.checkpoint!.scope, input.checkpoint!.recoveryStateRef.scope);
          for (const evidenceRef of input.checkpoint!.evidenceRefs) {
            assertEvidenceRef(evidenceRef);
            assertSameScope(input.checkpoint!.scope, evidenceRef.scope);
          }
          assertCheckpointLink(input.checkpoint!, resolveCheckpointPredecessor(input.checkpoint!, checkpoints));
        });
      }
      const record = { ...recordWithoutDigest, recordDigest: digestRecord(recordWithoutDigest) };
      validateRecord(record, previous, checkpoints);
      await mkdir(dirname(this.filePath), { recursive: true });
      const handle = await open(this.filePath, 'a');
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return record;
    } finally {
      await releaseLock(lock);
    }
  }

  async latest(): Promise<JournalRecord | null> { const result = await this.verify(); if (!result.valid) throw new JournalIntegrityError(result.error ?? 'journal is invalid'); return result.records.at(-1) ?? null; }
  async replay(): Promise<readonly JournalRecord[]> { const result = await this.verify(); if (!result.valid) throw new JournalIntegrityError(result.error ?? 'journal is invalid'); return result.records; }
}
