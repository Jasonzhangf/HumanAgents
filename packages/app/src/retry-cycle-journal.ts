import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { JsonlOrganJournal, type JournalRecord } from '../../adapters/jsonl/src/index.js';
import { id } from '../../contracts/src/index.js';
import type {
  RetryCycleControlRecord,
  RetryCycleJournalPort,
} from '../../runtime/src/orchestration/retry-cycle.js';
import { AppLifecycleError } from './errors.js';

const OWNER = 'humanagent.app.retry-cycle-journal';
const RETRY_CYCLE_CONTROL_SCOPE = { organId: id('organ', 'humanagent-retry-cycle') };

export interface RetryCycleJournalPayload {
  readonly kind: 'retry-cycle';
  readonly cycleId: string;
  readonly retryCycle: RetryCycleControlRecord;
}

function assertRetryCyclePayload(value: unknown): RetryCycleJournalPayload {
  if (typeof value !== 'object' || value === null) {
    throw new AppLifecycleError(
      'retry-cycle-journal-corrupt',
      'retry cycle journal record payload is invalid',
      'preserve the retry cycle journal and repair its committed history',
      OWNER,
    );
  }
  const payload = value as Partial<RetryCycleJournalPayload>;
  if (payload.kind !== 'retry-cycle' || typeof payload.cycleId !== 'string' || !payload.retryCycle) {
    throw new AppLifecycleError(
      'retry-cycle-journal-corrupt',
      'retry cycle journal record is incomplete',
      'preserve the retry cycle journal and repair its committed history',
      OWNER,
    );
  }
  return payload as RetryCycleJournalPayload;
}

export function createJsonlRetryCycleJournalPort(input: {
  readonly filePath: string;
}): RetryCycleJournalPort {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'retry-cycle-journal-invalid',
      'retry cycle journal path is required',
      'provide the retry cycle journal path under the HumanAgent control root',
      OWNER,
    );
  }
  const journal = new JsonlOrganJournal(input.filePath);

  async function records(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'retry-cycle-journal-corrupt',
        verification.error ?? 'retry cycle journal is invalid',
        'preserve the retry cycle journal and repair its committed history before retrying',
        OWNER,
      );
    }
    return verification.records;
  }

  function findCycle(cycleId: string, all: readonly JournalRecord[]): RetryCycleControlRecord | null {
    for (const record of [...all].reverse()) {
      if (record.kind !== 'event' || record.payload === undefined) continue;
      try {
        const payload = assertRetryCyclePayload(record.payload);
        if (payload.cycleId === cycleId) return structuredClone(payload.retryCycle);
      } catch {
        continue;
      }
    }
    return null;
  }

  return {
    async loadCycle(cycleId: string) {
      return findCycle(cycleId, await records());
    },
    async persistCycle(record) {
      const cycleId = `retry-cycle:${record.assignmentId}:${record.initialExecutionEpoch}`;
      const all = await records();
      const existing = findCycle(cycleId, all);
      if (existing && JSON.stringify(existing) === JSON.stringify(record)) return structuredClone(existing);
      const commitId = existing
        ? `retry-cycle-version:${cycleId}:${createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16)}`
        : cycleId;
      await journal.append({
        commitId,
        kind: 'event',
        scope: RETRY_CYCLE_CONTROL_SCOPE,
        payload: {
          kind: 'retry-cycle',
          cycleId,
          retryCycle: structuredClone(record),
        } as unknown as Record<string, unknown>,
      });
      return structuredClone(record);
    },
  };
}

export function retryCycleJournalFilePath(paths: { readonly journalRoot: string }): string {
  return join(paths.journalRoot, 'retry-cycle.jsonl');
}
