import {
  assertSameScope,
  validateTaskIdentityScope,
  type JournalCommitRef,
  type PublishedTaskPlanRevision,
  type TaskIdentityScope,
} from '../../../contracts/src/index.js';
import { sameJournalCommitRef } from '../../../runtime/src/checkpoints/coordinator.js';
import type { TaskPlanRevisionConsumerPort } from '../../../runtime/src/orchestration/task-plan-revisions.js';
import type { RuntimeTaskCurrentPlan } from '../../../runtime/src/ui-runtime/current-state.js';
import type { RuntimeReadResult, RuntimeReadScope } from '../../../ui/contracts/runtime.js';
import type {
  RuntimeTaskPlanCurrentProjection,
  RuntimeTaskPlanHistoryProjection,
  RuntimeTaskPlanRevisionProjection,
} from '../../../ui/contracts/task-plan-history.js';

const OWNER_ID = 'humanagent.app.ui-runtime.task-plan-history';
export type TaskPlanHistoryCurrentRead =
  | { readonly state: 'known'; readonly value: RuntimeTaskCurrentPlan }
  | { readonly state: 'unknown'; readonly reason: string };
export interface TaskPlanHistoryReader {
  read(input: {
    readonly scope: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
    readonly taskScope: TaskIdentityScope;
    readonly current: TaskPlanHistoryCurrentRead;
  }): Promise<RuntimeReadResult<RuntimeTaskPlanHistoryProjection>>;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function failure(code: string, message: string, nextAction: string): RuntimeReadResult<RuntimeTaskPlanHistoryProjection> {
  return { ok: false, failure: { code, ownerId: OWNER_ID, message, nextAction } };
}
function mapRevision(revision: PublishedTaskPlanRevision): RuntimeTaskPlanRevisionProjection {
  return {
    revisionId: revision.revisionId,
    sequence: revision.sequence,
    journalCommitRef: revision.journalCommitRef,
    predecessor: revision.predecessor === null ? null : {
      revisionId: revision.predecessor.revisionId, sequence: revision.predecessor.sequence,
    },
    snapshot: revision.snapshot,
    reason: revision.reason,
    evidenceRefs: revision.source.evidenceRefs,
    historyCoverage: revision.historyCoverage,
    publishedAt: revision.publishedAt,
  };
}
export function createTaskPlanHistoryReader(
  plans: Pick<TaskPlanRevisionConsumerPort, 'list' | 'getCommitRef'>,
): TaskPlanHistoryReader {
  return {
    async read(input): Promise<RuntimeReadResult<RuntimeTaskPlanHistoryProjection>> {
      const { scope, taskScope, current } = input;
      try { validateTaskIdentityScope(taskScope); }
      catch (error) {
        return failure('task-plan-history.scope-mismatch', errorMessage(error),
          'supply the canonical task identity scope for this task before reading plan history');
      }
      if (taskScope.taskId.value !== scope.taskId.value) {
        return failure('task-plan-history.scope-mismatch',
          `task identity scope ${taskScope.taskId.value} does not match read scope task ${scope.taskId.value}`,
          'bind the read scope and the task identity scope to the same canonical task');
      }
      let publications: readonly PublishedTaskPlanRevision[];
      try { publications = await plans.list(taskScope); }
      catch (error) {
        return failure('task-plan-history.read-failed', errorMessage(error),
          'restore the authoritative task plan revision journal read for this task scope');
      }
      try {
        for (const publication of publications) assertSameScope(publication.scope, taskScope);
      } catch (error) {
        return failure('task-plan-history.scope-mismatch', errorMessage(error),
          'resolve plan history only from the task identity scope that owns these publications');
      }
      let currentProjection: RuntimeTaskPlanCurrentProjection;
      if (current.state === 'unknown') {
        currentProjection = { state: 'unknown', reason: current.reason };
      } else {
        const publication = publications.find((candidate) => candidate.revisionId === current.value.revisionId);
        let receipt: JournalCommitRef | null;
        try { receipt = await plans.getCommitRef(taskScope, current.value.revisionId); }
        catch (error) {
          return failure('task-plan-history.read-failed', errorMessage(error),
            'restore the authoritative task plan revision receipt read for this task scope');
        }
        if (publication === undefined || receipt === null) {
          return failure('task-plan-history.current-mismatch',
            `accepted current revision ${current.value.revisionId} has no publication or physical receipt in this task scope`,
            'supply the current revision that Runtime accepted together with its committed Journal receipt');
        }
        if (publication.journalCommitRef !== `jsonl:${receipt.commitId}`) {
          return failure('task-plan-history.current-mismatch',
            `accepted current revision ${current.value.revisionId} publication is not the record that owns its receipt`,
            'restore the authoritative publication and receipt binding for the accepted current revision');
        }
        if (!sameJournalCommitRef(receipt, current.value.revisionCommitRef)) {
          return failure('task-plan-history.current-mismatch',
            `accepted current revision ${current.value.revisionId} receipt differs from the exact committed record`,
            'supply the exact physical receipt that Runtime accepted for the current revision');
        }
        currentProjection = { state: 'known', value: {
          revisionId: current.value.revisionId, revisionCommitRef: current.value.revisionCommitRef,
        } };
      }
      return { ok: true, value: {
        surface: 'runtime-task-plan-history', scope, current: currentProjection,
        revisions: publications.map(mapRevision),
      } };
    },
  };
}
