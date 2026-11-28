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

function normalizeSnapshotStrict(raw: unknown): ControlDomainRosterSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('control-domain roster store root must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const projects: Record<string, ProjectMemberRecord[]> = {};
  if (obj.projects !== undefined) {
    if (!obj.projects || typeof obj.projects !== 'object' || Array.isArray(obj.projects)) {
      throw new Error('control-domain roster store projects field must be an object');
    }
    for (const [projectKey, members] of Object.entries(obj.projects as Record<string, unknown>)) {
      if (!Array.isArray(members)) {
        throw new Error(`control-domain roster project ${projectKey} must be an array`);
      }
      projects[projectKey] = members
        .filter((item): item is ProjectMemberRecord => Boolean(item && typeof item === 'object' && typeof (item as ProjectMemberRecord).memberId === 'string' && typeof (item as ProjectMemberRecord).name === 'string'))
        .map((member) => ({ ...member }));
    }
  }
  const limit = obj.implicitOrchestrationMaxRuntimes;
  return {
    schemaVersion: 1,
    ...(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1
      ? { implicitOrchestrationMaxRuntimes: limit }
      : {}),
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

function withFileLock<T>(lockPath: string, run: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid}:${Date.now()}\n`);
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
        if (Date.now() - stats.mtimeMs > STALE_LOCK_AGE_MS) {
          rmSync(lockPath, { force: true });
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
    try { rmSync(lockPath, { force: true }); } catch {}
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
