import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

function normalizeSnapshot(raw: unknown): ControlDomainRosterSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { schemaVersion: 1, projects: {} };
  }
  const obj = raw as Record<string, unknown>;
  const projects: Record<string, ProjectMemberRecord[]> = {};
  if (obj.projects && typeof obj.projects === 'object' && !Array.isArray(obj.projects)) {
    for (const [projectKey, members] of Object.entries(obj.projects as Record<string, unknown>)) {
      if (!Array.isArray(members)) continue;
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

export function createFileControlDomainRosterStore(rootDir: string): ControlDomainRosterStore {
  const filePath = join(rootDir, 'control-domain-roster.json');
  const readSnapshot = (): ControlDomainRosterSnapshot => {
    if (!existsSync(filePath)) return { schemaVersion: 1, projects: {} };
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return normalizeSnapshot(parsed);
    } catch {
      return { schemaVersion: 1, projects: {} };
    }
  };
  return {
    readSnapshot,
    update<T>(mutate: (draft: ControlDomainRosterSnapshot) => T): T {
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
