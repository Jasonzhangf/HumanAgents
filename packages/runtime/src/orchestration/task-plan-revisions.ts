import {
  assertSameScope,
  canonicalJsonStringify,
  id,
  validateTaskIdentityRecord,
  type JournalCommitRef,
  type PublishedTaskPlanRevision,
  type ScopeRef,
  type TaskIdentityRecord,
  type TaskPlanRevisionPublicationInput,
} from '../../../contracts/src/index.js';
import {
  JournalCommitConflictError,
  type JsonlTaskPlanRevisionJournal,
} from '../../../adapters/jsonl/src/index.js';
import { validatePublishedTaskPlanRevision } from '../../../core/src/task-plan-revision.js';
import { sameJournalCommitRef } from '../checkpoints/coordinator.js';
import type { RuntimeTaskCurrentPlan } from '../ui-runtime/current-state.js';
import { OrchestrationError, OrchestrationPortError } from './errors.js';

/**
 * Publication input owned by the Runtime consumer. It is the K1 contract input without the
 * journal commit reference, which only the authoritative journal adapter may assign.
 */
export type TaskPlanRevisionPublishInput = Omit<TaskPlanRevisionPublicationInput, 'journalCommitRef'>;

export type TaskPlanRevisionPublicationOutcome = 'published' | 'existing';

/** Result of one publication attempt. `existing` means the identical revision was already committed. */
export interface TaskPlanRevisionPublicationResult {
  readonly outcome: TaskPlanRevisionPublicationOutcome;
  readonly revision: PublishedTaskPlanRevision;
}

/**
 * The single Runtime surface for reading and publishing task plan revisions. Every operation is
 * served by the authoritative JSONL port; there is no second store or projection.
 */
export interface TaskPlanRevisionConsumerPort {
  publish(input: TaskPlanRevisionPublishInput): Promise<TaskPlanRevisionPublicationResult>;
  get(scope: ScopeRef, revisionId: string): Promise<PublishedTaskPlanRevision | null>;
  list(scope: ScopeRef): Promise<readonly PublishedTaskPlanRevision[]>;
  replay(scope?: ScopeRef): Promise<readonly PublishedTaskPlanRevision[]>;
  getCommitRef(scope: ScopeRef, revisionId: string): Promise<JournalCommitRef | null>;
}

const OWNER_ID = 'runtime.orchestration.task-plan-revisions';

/** Exact selected publication and its physical receipt; reading does not accept a plan. */
export interface CurrentTaskPlanResult {
  readonly revision: PublishedTaskPlanRevision;
  readonly currentPlan: RuntimeTaskCurrentPlan;
}

function currentPlanFailure(scope: ScopeRef, reason: string): OrchestrationError {
  return new OrchestrationError(reason, {
    ownerId: OWNER_ID,
    reason: 'current-task-plan-binding',
    nextAction: { kind: 'recover', ref: 'task-plan-revision.publication' },
    evidenceRefs: [{ evidenceId: id('evidence', 'current-task-plan-source'), kind: 'operation',
      source: OWNER_ID, locator: 'task-plan-revision.publication', scope }],
  });
}

/** Resolve only Runtime's exact accepted reference. Missing selection never falls back to history. */
export async function readCurrentTaskPlan(input: {
  readonly plans: Pick<TaskPlanRevisionConsumerPort, 'get' | 'getCommitRef'>;
  readonly identity: TaskIdentityRecord;
  readonly currentPlan: RuntimeTaskCurrentPlan;
}): Promise<CurrentTaskPlanResult> {
  const { plans, identity, currentPlan } = input;
  validateTaskIdentityRecord(identity);
  const revision = await plans.get(identity.scope, currentPlan.revisionId);
  const receipt = await plans.getCommitRef(identity.scope, currentPlan.revisionId);
  if (!revision || !receipt || revision.revisionId !== currentPlan.revisionId
    || revision.journalCommitRef !== `jsonl:${receipt.commitId}`) {
    throw currentPlanFailure(identity.scope, 'task plan exact publication or physical receipt is missing or mismatched');
  }
  assertSameScope(revision.scope, identity.scope);
  const { evidenceRefs: _evidence, ...source } = revision.source;
  if (canonicalJsonStringify(source) !== canonicalJsonStringify(identity.source)) {
    throw currentPlanFailure(identity.scope, 'task plan publication does not match confirmed Task identity source');
  }
  validatePublishedTaskPlanRevision(revision);
  if (!sameJournalCommitRef(receipt, currentPlan.revisionCommitRef)) {
    throw currentPlanFailure(identity.scope, 'selected current plan receipt differs from exact publication receipt');
  }
  return { revision, currentPlan: { revisionId: revision.revisionId, revisionCommitRef: receipt } };
}

function toPortError(error: unknown): OrchestrationPortError {
  if (error instanceof OrchestrationPortError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new OrchestrationPortError(`task plan revision port failed: ${message}`, {
    ownerId: OWNER_ID,
    reason: error instanceof JournalCommitConflictError ? 'task-plan-revision-conflict' : 'task-plan-revision-port-failure',
    nextAction: { kind: 'recover', ref: 'task-plan-revision.publication' },
    evidenceRefs: [],
    cause: error,
  });
}

export class TaskPlanRevisionConsumer implements TaskPlanRevisionConsumerPort {
  constructor(private readonly journal: JsonlTaskPlanRevisionJournal) {}

  /**
   * Publishes one revision through the authoritative JSONL port. A retry of the exact same
   * publication returns the committed revision as `existing` and writes no new record.
   */
  async publish(input: TaskPlanRevisionPublishInput): Promise<TaskPlanRevisionPublicationResult> {
    const existing = await this.get(input.scope, input.revisionId);
    if (existing) return { outcome: 'existing', revision: existing };
    const revision = await this.guard(() => this.journal.append(input));
    return { outcome: 'published', revision };
  }

  async get(scope: ScopeRef, revisionId: string): Promise<PublishedTaskPlanRevision | null> {
    const revisions = await this.replay(scope);
    return revisions.find((revision) => revision.revisionId === revisionId) ?? null;
  }

  async list(scope: ScopeRef): Promise<readonly PublishedTaskPlanRevision[]> {
    return this.replay(scope);
  }

  async replay(scope?: ScopeRef): Promise<readonly PublishedTaskPlanRevision[]> {
    return this.guard(() => this.journal.replay(scope));
  }

  /**
   * Returns the authoritative Journal commit receipt for one committed revision, or null when the
   * revision was never committed. Corruption and binding inconsistencies throw instead of null.
   */
  async getCommitRef(scope: ScopeRef, revisionId: string): Promise<JournalCommitRef | null> {
    return this.guard(() => this.journal.getCommitRef(scope, revisionId));
  }

  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw toPortError(error);
    }
  }
}
