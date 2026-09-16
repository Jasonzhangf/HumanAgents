import { mkdir, open as openFile, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { RuntimePaths } from '../../config/src/index.js';
import { AppLifecycleError } from './errors.js';
import { readDaemonLease } from './supervisor/supervisor.js';

export type SessionState = 'created' | 'opening' | 'ready' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly seq: number;
  readonly type: 'session.created' | 'session.state' | 'session.closed' | 'session.failed';
  readonly state: SessionState;
  readonly controlCwd: string;
  readonly agentCwd: string;
  readonly workspaceCwd: string;
  readonly projectKey: string;
  readonly plan: string;
  readonly runtimeManifestDigest?: string;
  readonly checkpointRef?: string;
  readonly ownerId: string;
  readonly errorCode?: string;
  readonly nextAction?: string;
  readonly occurredAt: string;
}

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly path: string;
  readonly records: readonly SessionRecord[];
  readonly state: SessionState;
  readonly recoverableTail: boolean;
}

export interface SessionLockFence {
  readonly leaseId: string;
  readonly generation: number;
}

export interface SessionLock {
  readonly path: string;
  readonly sessionId: string;
  readonly lockToken: string;
  readonly fence?: SessionLockFence;
  readonly release: () => Promise<void>;
}

type SessionWrite = () => Promise<SessionSnapshot>;

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
    throw new AppLifecycleError('session-invalid', 'invalid session id', 'use an alphanumeric session id', 'session-store');
  }
}

function sessionPath(paths: RuntimePaths, sessionId: string): string {
  validateSessionId(sessionId);
  return join(paths.sessionsRoot, sessionId + '.jsonl');
}

async function appendDurably(path: string, value: string): Promise<void> {
  const handle = await openFile(path, 'a');
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function withLockGuard<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const guardPath = `${lockPath}.acquire`;
  try {
    await mkdir(guardPath);
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new AppLifecycleError('session-locked', 'session lock transition is already in progress', 'wait for the session lock transition to finish', 'session-store');
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(guardPath, { recursive: true, force: true });
  }
}

function validateRecord(record: unknown, expectedSessionId: string, expectedSeq: number, paths: RuntimePaths): SessionRecord {
  if (typeof record !== 'object' || record === null) {
    throw new AppLifecycleError('session-corrupt', 'session record is not an object', 'inspect and repair the session tail', 'session-store');
  }
  const value = record as Partial<SessionRecord>;
  const types: readonly SessionRecord['type'][] = ['session.created', 'session.state', 'session.closed', 'session.failed'];
  const states: readonly SessionState[] = ['created', 'opening', 'ready', 'running', 'stopping', 'stopped', 'failed'];
  if (value.schemaVersion !== 1 || value.sessionId !== expectedSessionId || value.seq !== expectedSeq || !Number.isSafeInteger(value.seq) || value.seq < 1) {
    throw new AppLifecycleError('session-corrupt', 'session identity or sequence is invalid', 'inspect and repair the session before resume', 'session-store');
  }
  if (value.controlCwd !== paths.controlRoot || value.agentCwd !== paths.agentCwd || value.workspaceCwd !== paths.workspaceCwd || value.projectKey !== paths.projectKey) {
    throw new AppLifecycleError('session-identity-mismatch', 'session path identity does not match current runtime', 'resume from the original workspace or create a new session', 'session-store');
  }
  if (typeof value.type !== 'string' || !types.includes(value.type as SessionRecord['type']) || typeof value.state !== 'string' || !states.includes(value.state as SessionState) || typeof value.plan !== 'string' || !value.plan || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.occurredAt !== 'string' || !value.occurredAt) {
    throw new AppLifecycleError('session-corrupt', 'session record is missing required fields', 'inspect and repair the session before resume', 'session-store');
  }
  if (value.type === 'session.created' && (value.seq !== 1 || value.state !== 'created')) {
    throw new AppLifecycleError('session-corrupt', 'session.created has an invalid state or sequence', 'inspect and repair the session before resume', 'session-store');
  }
  if (value.type === 'session.state' && (value.state === 'stopped' || value.state === 'failed')) {
    throw new AppLifecycleError('session-corrupt', 'session.state cannot commit a terminal state', 'inspect and repair the session before resume', 'session-store');
  }
  if (value.type === 'session.closed' && value.state !== 'stopped') {
    throw new AppLifecycleError('session-corrupt', 'session.closed must commit stopped state', 'inspect and repair the session before resume', 'session-store');
  }
  if (value.type === 'session.failed' && value.state !== 'failed') {
    throw new AppLifecycleError('session-corrupt', 'session.failed must commit failed state', 'inspect and repair the session before resume', 'session-store');
  }
  for (const key of ['controlCwd', 'agentCwd', 'workspaceCwd', 'projectKey'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) throw new AppLifecycleError('session-corrupt', `session record field ${key} is invalid`, 'inspect and repair the session before resume', 'session-store');
  }
  for (const key of ['runtimeManifestDigest', 'checkpointRef', 'errorCode', 'nextAction'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new AppLifecycleError('session-corrupt', `session record field ${key} is invalid`, 'inspect and repair the session before resume', 'session-store');
  }
  return value as SessionRecord;
}

function parseSession(content: string, sessionId: string, paths: RuntimePaths): { records: SessionRecord[]; recoverableTail: boolean } {
  if (content === '') return { records: [], recoverableTail: false };
  const lines = content.split('\n');
  const trailingLine = lines.pop() ?? '';
  const records: SessionRecord[] = [];
  const appendRecord = (raw: unknown): void => {
    const record = validateRecord(raw, sessionId, records.length + 1, paths);
    if (records.length === 0 && (record.type !== 'session.created' || record.state !== 'created')) {
      throw new AppLifecycleError('session-corrupt', 'session history must begin with session.created in created state', 'inspect and repair the session before resume', 'session-store');
    }
    const previous = records.at(-1);
    if (previous) {
      try {
        validateTransition(previous.state, record);
      } catch {
        throw new AppLifecycleError('session-corrupt', 'session lifecycle history is invalid', 'inspect and repair the session before resume', 'session-store');
      }
    }
    records.push(record);
  };
  try {
    for (const [index, line] of lines.entries()) {
      if (!line) throw new AppLifecycleError('session-corrupt', 'blank session record', 'inspect and repair the session', 'session-store');
      if (index !== records.length) throw new AppLifecycleError('session-corrupt', 'session sequence is not contiguous', 'inspect and repair the session', 'session-store');
      appendRecord(JSON.parse(line));
    }
  } catch (error) {
    if (error instanceof AppLifecycleError) throw error;
    throw new AppLifecycleError('session-corrupt', 'session record is invalid JSON', 'inspect and repair the session', 'session-store');
  }
  if (trailingLine === '') return { records, recoverableTail: false };
  let trailingRecord: unknown;
  try {
    trailingRecord = JSON.parse(trailingLine);
  } catch {
    return { records, recoverableTail: true };
  }
  appendRecord(trailingRecord);
  return { records, recoverableTail: false };
}

function validateTransition(current: SessionState, input: { readonly type: SessionRecord['type']; readonly state: SessionState }): void {
  if (input.type === 'session.closed' && input.state !== 'stopped') {
    throw new AppLifecycleError('session-transition', 'session.closed must commit stopped state', 'append a stopped close record', 'session-store');
  }
  if (input.type === 'session.closed' && !['ready', 'running', 'stopping'].includes(current)) {
    throw new AppLifecycleError('session-transition', `cannot close session from state: ${current}`, 'advance the session to a closable state first', 'session-store');
  }
  if (input.type === 'session.failed' && input.state !== 'failed') {
    throw new AppLifecycleError('session-transition', 'session.failed must commit failed state', 'append a failed record with state=failed', 'session-store');
  }
  if (input.type === 'session.state' && (input.state === 'stopped' || input.state === 'failed')) {
    throw new AppLifecycleError('session-transition', 'terminal state requires a terminal session record type', 'use session.closed or session.failed', 'session-store');
  }
  if (input.type === 'session.closed' || input.type === 'session.failed') return;
  const allowed: Readonly<Record<SessionState, readonly SessionState[]>> = {
    created: ['opening', 'ready'],
    opening: ['ready'],
    ready: ['running', 'stopping'],
    running: ['ready', 'stopping'],
    stopping: ['ready'],
    stopped: [],
    failed: [],
  };
  if (!allowed[current].includes(input.state)) {
    throw new AppLifecycleError('session-transition', `invalid session transition: ${current} -> ${input.state}`, 'append the next valid lifecycle state', 'session-store');
  }
}

export class SessionStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly paths: RuntimePaths) {}

  private async assertFenceActive(fence: SessionLockFence): Promise<void> {
    const lease = await readDaemonLease(this.paths);
    if (
      !lease
      || lease.disposedAt !== undefined
      || lease.leaseId !== fence.leaseId
      || lease.generation !== fence.generation
    ) {
      throw new AppLifecycleError('session-lock-fence-mismatch', 'session lock fence no longer matches the active daemon lease', 'reacquire the session lock with the current daemon lease', 'session-store');
    }
  }

  private async verifyLock(sessionId: string, lock: SessionLock): Promise<void> {
    validateSessionId(sessionId);
    if (lock.sessionId !== sessionId || lock.path !== join(this.paths.locksRoot, sessionId + '.lock')) {
      throw new AppLifecycleError('session-lock-owner-mismatch', 'session write is not bound to its lock', 'use the lock acquired for this session', 'session-store');
    }
    let owner: { lockToken?: string; sessionId?: string; released?: boolean; fence?: SessionLockFence };
    try {
      owner = JSON.parse(await readFile(join(lock.path, 'owner.json'), 'utf8')) as { lockToken?: string; sessionId?: string; released?: boolean; fence?: SessionLockFence };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        throw new AppLifecycleError('session-lock-owner-mismatch', 'session lock is no longer active', 'acquire the session lock again before writing', 'session-store');
      }
      throw error;
    }
    if (owner.sessionId !== sessionId || owner.lockToken !== lock.lockToken || owner.released === true) {
      throw new AppLifecycleError('session-lock-owner-mismatch', 'session lock is owned by another runtime', 'acquire the session lock again before writing', 'session-store');
    }
    if (lock.fence !== undefined && (owner.fence === undefined || owner.fence.leaseId !== lock.fence.leaseId || owner.fence.generation !== lock.fence.generation)) {
      throw new AppLifecycleError('session-lock-fence-mismatch', 'session lock fence no longer matches the owning host', 'reacquire the session lock with the current daemon lease', 'session-store');
    }
    if (lock.fence === undefined && owner.fence !== undefined) {
      throw new AppLifecycleError('session-lock-fence-mismatch', 'session lock is bound to a newer host generation', 'reacquire the session lock with the current daemon lease', 'session-store');
    }
    if (lock.fence !== undefined) {
      await this.assertFenceActive(lock.fence);
    }
  }

  private async withWriteLock(sessionId: string, lock: SessionLock | undefined, write: SessionWrite): Promise<SessionSnapshot> {
    const ownedLock = lock ?? await this.acquire(sessionId);
    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const current = new Promise<void>((resolveQueue) => { releaseQueue = resolveQueue; });
    const queued = previous.then(() => current);
    this.writeQueues.set(sessionId, queued);
    try {
      await previous;
      return await withLockGuard(ownedLock.path, async () => {
        await this.verifyLock(sessionId, ownedLock);
        return write();
      });
    } finally {
      releaseQueue();
      if (this.writeQueues.get(sessionId) === queued) this.writeQueues.delete(sessionId);
      if (!lock) await ownedLock.release();
    }
  }

  async acquire(sessionId: string, fence?: SessionLockFence): Promise<SessionLock> {
    validateSessionId(sessionId);
    if (fence !== undefined) {
      await this.assertFenceActive(fence);
    }
    const lockPath = join(this.paths.locksRoot, sessionId + '.lock');
    const acquisitionPath = join(this.paths.locksRoot, sessionId + '.lock.acquire');
    const lockToken = randomUUID();
    try {
      await mkdir(acquisitionPath);
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') {
        throw new AppLifecycleError('session-locked', 'session is already owned by another runtime', 'wait for the owner to release the session lock', 'session-store');
      }
      throw error;
    }
    let created = false;
    try {
      let existing: { lockToken?: string; sessionId?: string; released?: boolean; fence?: SessionLockFence } | undefined;
      try {
        existing = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as { lockToken?: string; sessionId?: string; released?: boolean; fence?: SessionLockFence };
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      if (existing && existing.released !== true) {
        if (existing.fence === undefined) {
          throw new AppLifecycleError('session-locked', 'session is already owned by another runtime', 'wait for the owner to release the session lock', 'session-store');
        }
        const active = await readDaemonLease(this.paths);
        const activeFenceMatches = active !== undefined
          && active.disposedAt === undefined
          && active.leaseId === existing.fence.leaseId
          && active.generation === existing.fence.generation;
        if (activeFenceMatches) {
          throw new AppLifecycleError('session-locked', 'session is already owned by another runtime', 'wait for the owner to release the session lock', 'session-store');
        }
        if (fence === undefined) {
          throw new AppLifecycleError('session-lock-fence-mismatch', 'session lock is bound to an inactive daemon generation', 'reacquire the session lock with the current daemon lease', 'session-store');
        }
        await rm(lockPath, { recursive: true, force: true });
      }
      if (existing && existing.released === true) await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath);
      created = true;
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
        lockToken,
        sessionId,
        controlCwd: this.paths.controlRoot,
        workspaceCwd: this.paths.workspaceCwd,
        acquiredAt: new Date().toISOString(),
        released: false,
        ...(fence === undefined ? {} : { fence }),
      }) + '\n', 'utf8');
    } catch (error) {
      if (created) await rm(lockPath, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(acquisitionPath, { recursive: true, force: true });
    }
    let released = false;
    return {
      path: lockPath,
      sessionId,
      lockToken,
      ...(fence === undefined ? {} : { fence }),
      release: async () => {
        if (released) return;
        await withLockGuard(lockPath, async () => {
          let owner: { lockToken?: string };
          try {
            owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as { lockToken?: string };
          } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') {
              released = true;
              return;
            }
            throw error;
          }
          if (owner.lockToken !== lockToken) {
            throw new AppLifecycleError('session-lock-owner-mismatch', 'session lock is owned by another runtime', 'do not remove the replacement owner lock', 'session-store');
          }
          const ownerPath = join(lockPath, 'owner.json');
          const releasedOwnerPath = `${ownerPath}.released-${lockToken}`;
          await writeFile(releasedOwnerPath, JSON.stringify({ ...owner, released: true, releasedAt: new Date().toISOString() }) + '\n', 'utf8');
          await rename(releasedOwnerPath, ownerPath);
          released = true;
        });
      },
    };
  }

  async create(input: { readonly sessionId: string; readonly plan: string; readonly runtimeManifestDigest?: string }, lock?: SessionLock): Promise<SessionSnapshot> {
    return this.withWriteLock(input.sessionId, lock, async () => {
      const path = sessionPath(this.paths, input.sessionId);
      await mkdir(dirname(path), { recursive: true });
      try {
        await readFile(path, 'utf8');
        throw new AppLifecycleError('session-exists', 'session already exists', 'open the existing session or choose another id', 'session-store');
      } catch (error) {
        if (error instanceof AppLifecycleError) throw error;
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      const record: SessionRecord = {
        schemaVersion: 1,
        sessionId: input.sessionId,
        seq: 1,
        type: 'session.created',
        state: 'created',
        controlCwd: this.paths.controlRoot,
        agentCwd: this.paths.agentCwd,
        workspaceCwd: this.paths.workspaceCwd,
        projectKey: this.paths.projectKey,
        plan: input.plan,
        ...(input.runtimeManifestDigest === undefined ? {} : { runtimeManifestDigest: input.runtimeManifestDigest }),
        ownerId: 'host',
        occurredAt: new Date().toISOString(),
      };
      await appendDurably(path, JSON.stringify(record) + '\n');
      return this.open(input.sessionId);
    });
  }

  async open(sessionId: string): Promise<SessionSnapshot> {
    const path = sessionPath(this.paths, sessionId);
    let content: string;
    try { content = await readFile(path, 'utf8'); } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        throw new AppLifecycleError('session-missing', 'session does not exist', 'create a session or choose an existing id', 'session-store');
      }
      throw error;
    }
    const parsed = parseSession(content, sessionId, this.paths);
    const last = parsed.records.at(-1);
    if (!last) throw new AppLifecycleError('session-corrupt', 'session has no committed record', 'inspect and repair the session', 'session-store');
    return { sessionId, path, records: parsed.records, state: last.state, recoverableTail: parsed.recoverableTail };
  }

  async list(): Promise<readonly SessionSnapshot[]> {
    const entries = await readdir(this.paths.sessionsRoot, { withFileTypes: true });
    const sessionIds = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name.slice(0, -'.jsonl'.length))
      .sort();
    return Promise.all(sessionIds.map((sessionId) => this.open(sessionId)));
  }

  async append(sessionId: string, input: { readonly type: 'session.state' | 'session.closed' | 'session.failed'; readonly state: SessionState; readonly checkpointRef?: string; readonly errorCode?: string; readonly nextAction?: string }, lock?: SessionLock): Promise<SessionSnapshot> {
    return this.withWriteLock(sessionId, lock, async () => {
      const current = await this.open(sessionId);
      if (current.state === 'stopped' || current.state === 'failed') {
        throw new AppLifecycleError('session-terminal', 'cannot append after terminal session state', 'open a new session or resume from its checkpoint', 'session-store');
      }
      validateTransition(current.state, input);
      const first = current.records[0];
      const record: SessionRecord = {
        schemaVersion: 1,
        sessionId,
        seq: current.records.length + 1,
        type: input.type,
        state: input.state,
        controlCwd: this.paths.controlRoot,
        agentCwd: this.paths.agentCwd,
        workspaceCwd: this.paths.workspaceCwd,
        projectKey: this.paths.projectKey,
        plan: first.plan,
        ...(first.runtimeManifestDigest === undefined ? {} : { runtimeManifestDigest: first.runtimeManifestDigest }),
        ...(input.checkpointRef === undefined ? {} : { checkpointRef: input.checkpointRef }),
        ownerId: input.type === 'session.failed' ? 'host' : 'runtime',
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }),
        occurredAt: new Date().toISOString(),
      };
      if (current.recoverableTail) {
        const content = await readFile(current.path, 'utf8');
        const lastCompleteLine = content.lastIndexOf('\n');
        if (lastCompleteLine < 0) {
          throw new AppLifecycleError('session-corrupt', 'session has no complete record before its trailing data', 'inspect and repair the session before resume', 'session-store');
        }
        await truncate(current.path, lastCompleteLine + 1);
      }
      let separator = '';
      if (!current.recoverableTail) {
        const content = await readFile(current.path, 'utf8');
        if (content !== '' && !content.endsWith('\n')) separator = '\n';
      }
      await appendDurably(current.path, separator + JSON.stringify(record) + '\n');
      return this.open(sessionId);
    });
  }

  async close(sessionId: string, checkpointRef?: string, lock?: SessionLock): Promise<SessionSnapshot> {
    return this.append(sessionId, { type: 'session.closed', state: 'stopped', checkpointRef }, lock);
  }
}
