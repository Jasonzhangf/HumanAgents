import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectMemberRecord } from '../../../config/src/index.js';

export interface ControlDomainRosterSnapshot {
  readonly schemaVersion: 1;
  readonly implicitOrchestrationMaxRuntimes?: number;
  readonly projects: Record<string, ProjectMemberRecord[]>;
}

export interface ControlDomainRosterStore {
  readSnapshot(): ControlDomainRosterSnapshot;
  update<T>(mutate: (draft: ControlDomainRosterSnapshot) => T): T;
}

const IN_MEMORY_JOURNAL_STORES = new WeakMap<object, ControlDomainRosterSnapshot>();

function cloneMembers(members: readonly ProjectMemberRecord[]): ProjectMemberRecord[] {
  return members.map((member) => ({ ...member }));
}

function cloneSnapshot(snapshot: ControlDomainRosterSnapshot): ControlDomainRosterSnapshot {
  const projects: Record<string, ProjectMemberRecord[]> = {};
  for (const [key, list] of Object.entries(snapshot.projects)) {
    projects[key] = cloneMembers(list);
  }
  return {
    schemaVersion: 1,
    ...(snapshot.implicitOrchestrationMaxRuntimes === undefined
      ? {}
      : { implicitOrchestrationMaxRuntimes: snapshot.implicitOrchestrationMaxRuntimes }),
    projects,
  };
}

const ALLOWED_ROLES = new Set(['manager', 'architect', 'reviewer', 'tester', 'specialist', 'executor']);

function normalizeSnapshotStrict(raw: unknown): ControlDomainRosterSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('control-domain roster store root must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new Error(`control-domain roster store unsupported schemaVersion: ${String(obj.schemaVersion)}`);
  }
  const projects: Record<string, ProjectMemberRecord[]> = {};
  if (obj.projects !== undefined) {
    if (!obj.projects || typeof obj.projects !== 'object' || Array.isArray(obj.projects)) {
      throw new Error('control-domain roster store projects field must be an object');
    }
    for (const [projectKey, members] of Object.entries(obj.projects as Record<string, unknown>)) {
      if (!Array.isArray(members)) {
        throw new Error(`control-domain roster project ${projectKey} must be an array`);
      }
      projects[projectKey] = members.map((item, idx) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`control-domain roster project ${projectKey}[${idx}] must be an object`);
        }
        const member = item as Record<string, unknown>;
        if (
          typeof member.memberId !== 'string' || !member.memberId.trim()
          || typeof member.name !== 'string' || !member.name.trim()
          || typeof member.role !== 'string' || !ALLOWED_ROLES.has(member.role)
          || typeof member.systemPrompt !== 'string'
          || typeof member.rolePrompt !== 'string'
        ) {
          throw new Error(`control-domain roster project ${projectKey}[${idx}] contains malformed member fields`);
        }
        if (member.provider !== undefined && typeof member.provider !== 'string') {
          throw new Error(`control-domain roster project ${projectKey}[${idx}].provider must be a string`);
        }
        if (member.model !== undefined && typeof member.model !== 'string') {
          throw new Error(`control-domain roster project ${projectKey}[${idx}].model must be a string`);
        }
        return { ...(member as unknown as ProjectMemberRecord) };
      });
    }
  }
  const limit = obj.implicitOrchestrationMaxRuntimes;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error('control-domain roster implicitOrchestrationMaxRuntimes must be a positive safe integer');
  }
  return {
    schemaVersion: 1,
    ...(limit === undefined ? {} : { implicitOrchestrationMaxRuntimes: limit }),
    projects,
  };
}

const LOCK_WAIT_STEP_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_AGE_MS = 15000;
const LOCK_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms: number): void {
  Atomics.wait(LOCK_SLEEP_BUF, 0, 0, ms);
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === code);
}

function isLockHolderDead(rawToken: string): boolean {
  const pidPart = Number(rawToken.split(':')[0]);
  if (!Number.isSafeInteger(pidPart) || pidPart <= 0) return false;
  try {
    process.kill(pidPart, 0);
    return false;
  } catch (error) {
    return isErrnoWithCode(error, 'ESRCH');
  }
}

function tryReclaimDeadLock(lockPath: string, holderToken: string, statsMtimeMs: number): boolean {
  if (Date.now() - statsMtimeMs <= STALE_LOCK_AGE_MS || !isLockHolderDead(holderToken)) {
    return false;
  }
  const claimHash = createHash('sha256').update(holderToken).digest('hex').slice(0, 16);
  const reclaimPath = `${lockPath}.reclaim.${claimHash}`;
  const reclaimToken = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}\n`;
  let claimFd: number;
  try {
    claimFd = openSync(reclaimPath, 'wx', 0o600);
  } catch (error) {
    if (isErrnoWithCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  }
  try {
    writeSync(claimFd, reclaimToken);
  } finally {
    closeSync(claimFd);
  }
  try {
    let currentHolder: string;
    try {
      currentHolder = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (isErrnoWithCode(error, 'ENOENT')) return false;
      throw error;
    }
    if (currentHolder !== holderToken) {
      return false;
    }
    rmSync(lockPath, { force: true });
    return true;
  } finally {
    try {
      if (readFileSync(reclaimPath, 'utf8') === reclaimToken) {
        rmSync(reclaimPath, { force: true });
      }
    } catch {}
  }
}

function withFileLock<T>(lockPath: string, run: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}\n`;
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, lockToken);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (!isErrnoWithCode(error, 'EEXIST')) {
        throw error;
      }
      try {
        const stats = statSync(lockPath);
        const holderToken = readFileSync(lockPath, 'utf8');
        if (tryReclaimDeadLock(lockPath, holderToken, stats.mtimeMs)) {
          continue;
        }
      } catch (statError) {
        if (isErrnoWithCode(statError, 'ENOENT')) continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`control-domain roster lock contention timeout: ${lockPath}`);
      }
      sleepSyncMs(LOCK_WAIT_STEP_MS);
    }
  }
  try {
    return run();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8') === lockToken) {
        rmSync(lockPath, { force: true });
      }
    } catch {}
  }
}

export function createFileControlDomainRosterStore(rootDir: string): ControlDomainRosterStore {
  const filePath = join(rootDir, 'control-domain-roster.json');
  const lockPath = join(rootDir, '.control-domain-roster.lock');
  const readSnapshot = (): ControlDomainRosterSnapshot => {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      if (isErrnoWithCode(error, 'ENOENT')) {
        return { schemaVersion: 1, projects: {} };
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    return normalizeSnapshotStrict(parsed);
  };
  return {
    readSnapshot,
    update<T>(mutate: (draft: ControlDomainRosterSnapshot) => T): T {
      return withFileLock(lockPath, () => {
        const draft = cloneSnapshot(readSnapshot());
        const result = mutate(draft);
        mkdirSync(dirname(filePath), { recursive: true });
        const tempPath = join(dirname(filePath), `.control-domain-roster-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
        try {
          writeFileSync(tempPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
          renameSync(tempPath, filePath);
        } catch (error) {
          try { rmSync(tempPath, { recursive: false, force: true }); } catch {}
          throw error;
        }
        return result;
      });
    },
  };
}

export function createJournalSharedControlDomainRosterStore(
  journalKey: object | undefined,
  onPersist?: (snapshot: ControlDomainRosterSnapshot) => void,
): ControlDomainRosterStore {
  const getOrInit = (): ControlDomainRosterSnapshot => {
    if (!journalKey) return { schemaVersion: 1, projects: {} };
    let existing = IN_MEMORY_JOURNAL_STORES.get(journalKey);
    if (!existing) {
      existing = { schemaVersion: 1, projects: {} };
      IN_MEMORY_JOURNAL_STORES.set(journalKey, existing);
    }
    return existing;
  };
  return {
    readSnapshot: () => cloneSnapshot(getOrInit()),
    update<T>(mutate: (draft: ControlDomainRosterSnapshot) => T): T {
      const previous = cloneSnapshot(getOrInit());
      const draft = cloneSnapshot(previous);
      try {
        const result = mutate(draft);
        if (journalKey) IN_MEMORY_JOURNAL_STORES.set(journalKey, cloneSnapshot(draft));
        onPersist?.(draft);
        return result;
      } catch (error) {
        if (journalKey) IN_MEMORY_JOURNAL_STORES.set(journalKey, previous);
        throw error;
      }
    },
  };
}
