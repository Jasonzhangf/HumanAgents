import { createHash } from 'node:crypto';
import type {
  PublishedTaskPlanRevision,
  ScopeRef,
  TaskPlanRevisionPublicationInput,
} from '@humanagent/contracts';
import {
  assertTaskPlanRevisionRetryMatches,
  createPublishedTaskPlanRevision,
  validatePublishedTaskPlanRevision,
  validateTaskPlanRevisionTransition,
} from '../../../core/src/task-plan-revision.js';
import { JournalCommitConflictError, JournalIntegrityError } from './index.js';
import type { JournalRecord, JsonlOrganJournal } from './index.js';

export type TaskPlanRevisionAppendInput = Omit<TaskPlanRevisionPublicationInput, 'journalCommitRef'>;

const RECORD_TYPE = 'task-plan-revision.published';

function taskKey(scope: PublishedTaskPlanRevision['scope']): string {
  return `${scope.organId.value}\0${scope.taskId.value}`;
}

function sameTaskScope(scope: PublishedTaskPlanRevision['scope'], filter: ScopeRef): boolean {
  return scope.organId.scope === filter.organId.scope
    && scope.organId.value === filter.organId.value
    && (!filter.taskId || (scope.taskId.scope === filter.taskId.scope && scope.taskId.value === filter.taskId.value));
}

function revisionCommitId(scope: PublishedTaskPlanRevision['scope'], revisionId: string): string {
  return `task-plan-revision:${createHash('sha256').update(`${scope.organId.value}\0${scope.taskId.value}\0${revisionId}`).digest('hex')}`;
}

function revisionFromRecord(record: JournalRecord): PublishedTaskPlanRevision | undefined {
  if (record.kind !== 'event' || record.payload?.type !== RECORD_TYPE) return undefined;
  const revision = record.payload.revision as PublishedTaskPlanRevision | undefined;
  if (revision === undefined) throw new JournalIntegrityError('task plan revision record has no revision');
  try {
    validatePublishedTaskPlanRevision(revision);
    if (record.commitId === undefined || revision.journalCommitRef !== `jsonl:${record.commitId}`) {
      throw new JournalIntegrityError('task plan revision commit reference does not match its Journal record');
    }
    if (revision.scope.organId.scope !== record.scope.organId.scope
      || revision.scope.organId.value !== record.scope.organId.value
      || revision.scope.taskId.scope !== record.scope.taskId?.scope
      || revision.scope.taskId.value !== record.scope.taskId?.value) {
      throw new JournalIntegrityError('task plan revision scope does not match its Journal record');
    }
  } catch (error) {
    if (error instanceof JournalIntegrityError) throw error;
    throw new JournalIntegrityError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  return revision;
}

function typedReplay(records: readonly JournalRecord[]): PublishedTaskPlanRevision[] {
  const revisions: PublishedTaskPlanRevision[] = [];
  const previousByTask = new Map<string, PublishedTaskPlanRevision>();
  const seenIdentities = new Set<string>();
  for (const record of records) {
    const revision = revisionFromRecord(record);
    if (!revision) continue;
    const key = taskKey(revision.scope);
    const identity = `${key}\0${revision.revisionId}`;
    if (seenIdentities.has(identity)) {
      throw new JournalIntegrityError('task plan revision identity must be unique within its task history');
    }
    seenIdentities.add(identity);
    try {
      validateTaskPlanRevisionTransition(previousByTask.get(key) ?? null, revision);
    } catch (error) {
      throw new JournalIntegrityError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    previousByTask.set(key, revision);
    revisions.push(revision);
  }
  return revisions;
}

/** Typed append/replay surface over the existing authoritative Organ Journal. */
export class JsonlTaskPlanRevisionJournal {
  constructor(private readonly journal: JsonlOrganJournal) {}

  async append(input: TaskPlanRevisionAppendInput): Promise<PublishedTaskPlanRevision> {
    const commitId = revisionCommitId(input.scope, input.revisionId);
    const candidate = createPublishedTaskPlanRevision({ ...input, journalCommitRef: `jsonl:${commitId}` });
    return this.journal.transaction(
      ({ records }) => {
        const existing = typedReplay(records)
          .find((revision) => revision.scope.organId.value === candidate.scope.organId.value
            && revision.scope.taskId.value === candidate.scope.taskId.value
            && revision.revisionId === candidate.revisionId);
        if (existing) {
          try {
            assertTaskPlanRevisionRetryMatches(existing, candidate);
          } catch (error) {
            throw new JournalCommitConflictError(commitId, records.find((record) => record.commitId === commitId)!, { cause: error });
          }
          return { existing, append: false as const };
        }
        const occupiedCommit = records.find((record) => record.commitId === commitId);
        if (occupiedCommit) throw new JournalCommitConflictError(commitId, occupiedCommit);
        const previous = typedReplay(records)
          .reverse()
          .find((revision) => revision.scope.organId.value === candidate.scope.organId.value
            && revision.scope.taskId.value === candidate.scope.taskId.value) ?? null;
        try {
          validateTaskPlanRevisionTransition(previous, candidate);
        } catch (error) {
          throw new JournalIntegrityError(error instanceof Error ? error.message : String(error), { cause: error });
        }
        return { candidate, append: true as const };
      },
      async (plan, append) => {
        if (!plan.append) return plan.existing;
        const record = await append({
          commitId,
          kind: 'event',
          scope: plan.candidate.scope,
          payload: { type: RECORD_TYPE, revision: plan.candidate as unknown as Record<string, unknown> },
        });
        return revisionFromRecord(record)!;
      },
    );
  }

  async replay(scope?: ScopeRef): Promise<readonly PublishedTaskPlanRevision[]> {
    const revisions = typedReplay(await this.journal.replay());
    return scope === undefined ? revisions : revisions.filter((revision) => sameTaskScope(revision.scope, scope));
  }
}
