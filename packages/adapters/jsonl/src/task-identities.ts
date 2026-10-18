import { createHash } from 'node:crypto';
import type {
  ScopeRef,
  TaskIdentityAppendInput,
  TaskIdentityRecord,
} from '@humanagent/contracts';
import {
  assertTaskIdentityEstablishmentMatches,
  createTaskIdentityRecord,
  validateTaskIdentityAppendInput,
  validateTaskIdentityRecord,
} from '../../../core/src/task-identity.js';
import { JournalIntegrityError } from './index.js';
import type { JournalRecord, JsonlOrganJournal } from './index.js';

export type { TaskIdentityAppendInput } from '@humanagent/contracts';

const RECORD_TYPE = 'task-identity.established';

function taskKey(scope: TaskIdentityRecord['scope']): string {
  return `${scope.organId.value}\0${scope.taskId.value}`;
}

function sameTaskScope(scope: TaskIdentityRecord['scope'], filter: ScopeRef): boolean {
  return scope.organId.scope === filter.organId.scope
    && scope.organId.value === filter.organId.value
    && (!filter.taskId || (scope.taskId.scope === filter.taskId.scope && scope.taskId.value === filter.taskId.value));
}

function identityCommitId(scope: TaskIdentityRecord['scope']): string {
  return `task-identity:${createHash('sha256').update(`${scope.organId.value}\0${scope.taskId.value}`).digest('hex')}`;
}

function identityFromRecord(record: JournalRecord): TaskIdentityRecord | undefined {
  if (record.kind !== 'event' || record.payload?.type !== RECORD_TYPE) return undefined;
  const identity = record.payload.identity as TaskIdentityRecord | undefined;
  if (identity === undefined) throw new JournalIntegrityError('task identity record has no identity');
  try {
    validateTaskIdentityRecord(identity);
    if (record.commitId === undefined || identity.journalCommitRef !== `jsonl:${record.commitId}`) {
      throw new JournalIntegrityError('task identity commit reference does not match its Journal record');
    }
    if (identity.scope.organId.scope !== record.scope.organId.scope
      || identity.scope.organId.value !== record.scope.organId.value
      || identity.scope.taskId.scope !== record.scope.taskId?.scope
      || identity.scope.taskId.value !== record.scope.taskId?.value) {
      throw new JournalIntegrityError('task identity scope does not match its Journal record');
    }
  } catch (error) {
    if (error instanceof JournalIntegrityError) throw error;
    throw new JournalIntegrityError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  return identity;
}

function typedReplay(records: readonly JournalRecord[]): TaskIdentityRecord[] {
  const identities: TaskIdentityRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const identity = identityFromRecord(record);
    if (!identity) continue;
    const key = taskKey(identity.scope);
    if (seen.has(key)) throw new JournalIntegrityError('task identity must be unique within its Organ/task scope');
    seen.add(key);
    identities.push(identity);
  }
  return identities;
}

/** Pure typed replay over already verified Organ Journal records. */
export function decodeTaskIdentityRecords(
  records: readonly JournalRecord[],
): readonly TaskIdentityRecord[] {
  return typedReplay(records);
}

/** Typed append/replay surface over the existing authoritative Organ Journal. */
export class JsonlTaskIdentityJournal {
  constructor(private readonly journal: JsonlOrganJournal) {}

  async append(input: TaskIdentityAppendInput): Promise<TaskIdentityRecord> {
    validateTaskIdentityAppendInput(input);
    const commitId = identityCommitId(input.scope);
    const candidate = createTaskIdentityRecord(input, `jsonl:${commitId}`);
    return this.journal.transaction(
      ({ records }) => {
        const existing = typedReplay(records).find((identity) => taskKey(identity.scope) === taskKey(candidate.scope));
        if (existing) {
          assertTaskIdentityEstablishmentMatches(existing, input);
          return { existing, append: false as const };
        }
        const occupiedCommit = records.find((record) => record.commitId === commitId);
        if (occupiedCommit) throw new JournalIntegrityError(`task identity commit ${commitId} belongs to another fact`);
        return { candidate, append: true as const };
      },
      async (plan, append) => {
        if (!plan.append) return plan.existing;
        const record = await append({
          commitId,
          kind: 'event',
          scope: plan.candidate.scope,
          payload: { type: RECORD_TYPE, identity: plan.candidate as unknown as Record<string, unknown> },
        });
        return identityFromRecord(record)!;
      },
    );
  }

  async replay(scope?: ScopeRef): Promise<readonly TaskIdentityRecord[]> {
    const identities = typedReplay(await this.journal.replay());
    return scope === undefined ? identities : identities.filter((identity) => sameTaskScope(identity.scope, scope));
  }
}
