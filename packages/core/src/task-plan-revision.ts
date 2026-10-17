import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../../contracts/src/explicit-brain.js';
import { ContractError } from '../../contracts/src/errors.js';
import { canonicalInspectionDefinitionContent } from './i2-history.js';
import {
  validateTaskPlanRevisionMetadata,
  validateTaskPlanSnapshot,
  type PublishedTaskPlanRevision,
  type TaskPlanDigest,
  type TaskPlanRevisionPublicationInput,
} from '../../contracts/src/task-plan-revision.js';

function snapshotDigest(snapshot: PublishedTaskPlanRevision['snapshot']): TaskPlanDigest {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(snapshot)).digest('hex')}`;
}

/** Constructs the content identity from the full immutable snapshot; array order remains author-declared. */
export function createPublishedTaskPlanRevision(input: TaskPlanRevisionPublicationInput): PublishedTaskPlanRevision {
  validateTaskPlanSnapshot(input.snapshot);
  const revision: PublishedTaskPlanRevision = { ...input, contentDigest: snapshotDigest(input.snapshot) };
  validateTaskPlanRevisionMetadata(revision);
  return revision;
}

export function validatePublishedTaskPlanRevision(revision: PublishedTaskPlanRevision): void {
  validateTaskPlanRevisionMetadata(revision);
  const actual = snapshotDigest(revision.snapshot);
  if (actual !== revision.contentDigest) throw new ContractError('task plan contentDigest does not match the full snapshot');
}

/** Validates a new publication against the current authoritative predecessor. No timestamps are used for ordering. */
export function validateTaskPlanRevisionTransition(
  previous: PublishedTaskPlanRevision | null,
  next: PublishedTaskPlanRevision,
): void {
  validatePublishedTaskPlanRevision(next);
  if (previous === null) {
    if (next.sequence !== 1 || next.predecessor !== null) {
      throw new ContractError('first task plan revision must have sequence 1 and no predecessor');
    }
    return;
  }
  validatePublishedTaskPlanRevision(previous);
  if (
    previous.scope.organId.value !== next.scope.organId.value ||
    previous.scope.taskId.value !== next.scope.taskId.value
  ) {
    throw new ContractError('task plan revision predecessor belongs to a different task scope');
  }
  if (next.revisionId === previous.revisionId) throw new ContractError('task plan revision identity must be unique');
  if (next.sequence !== previous.sequence + 1) throw new ContractError('task plan revision sequence must immediately follow its predecessor');
  if (
    next.predecessor?.revisionId !== previous.revisionId ||
    next.predecessor.sequence !== previous.sequence ||
    next.predecessor.contentDigest !== previous.contentDigest
  ) {
    throw new ContractError('task plan revision predecessor identity, sequence, or digest does not match');
  }
  const previousDefinition = previous.snapshot.inspectionDefinition;
  const nextDefinition = next.snapshot.inspectionDefinition;
  if (previousDefinition !== undefined) {
    if (nextDefinition === undefined) {
      throw new ContractError('task plan revision must retain its published inspection definition');
    }
    const sameIdentity =
      previousDefinition.definition.definitionId === nextDefinition.definition.definitionId &&
      previousDefinition.definition.definitionVersion === nextDefinition.definition.definitionVersion;
    if (
      sameIdentity &&
      canonicalJsonStringify(canonicalInspectionDefinitionContent(previousDefinition)) !==
        canonicalJsonStringify(canonicalInspectionDefinitionContent(nextDefinition))
    ) {
      throw new ContractError('task plan inspection definition content must not change within the same definition version');
    }
  }
}

function retryIdentity(revision: PublishedTaskPlanRevision): unknown {
  return {
    scope: revision.scope,
    revisionId: revision.revisionId,
    sequence: revision.sequence,
    contentDigest: revision.contentDigest,
    predecessor: revision.predecessor,
    snapshot: revision.snapshot,
    reason: revision.reason,
    source: revision.source,
    historyCoverage: revision.historyCoverage,
  };
}

/** Same publication identity and immutable content is an idempotent retry; any immutable payload drift conflicts. */
export function assertTaskPlanRevisionRetryMatches(
  existing: PublishedTaskPlanRevision,
  retry: PublishedTaskPlanRevision,
): void {
  validatePublishedTaskPlanRevision(existing);
  validatePublishedTaskPlanRevision(retry);
  if (
    existing.scope.organId.value !== retry.scope.organId.value ||
    existing.scope.taskId.value !== retry.scope.taskId.value ||
    existing.revisionId !== retry.revisionId
  ) {
    throw new ContractError('task plan publication retry has a different task scope or revision identity');
  }
  if (canonicalJsonStringify(retryIdentity(existing)) !== canonicalJsonStringify(retryIdentity(retry))) {
    throw new ContractError('task plan publication retry conflicts with the existing immutable revision');
  }
}
