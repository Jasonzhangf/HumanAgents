import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError } from '../../packages/contracts/src/errors.js';
import {
  assertTaskPlanRevisionRetryMatches,
  createPublishedTaskPlanRevision,
  validatePublishedTaskPlanRevision,
  validateTaskPlanRevisionTransition,
} from '../../packages/core/src/task-plan-revision.js';
import type { PublishedTaskPlanRevision, TaskPlanRevisionPublicationInput } from '../../packages/contracts/src/task-plan-revision.js';

const scope = { organId: { scope: 'organ' as const, value: 'organ-1' }, taskId: { scope: 'task' as const, value: 'task-1' } };
const source = { requirementId: 'requirement-1', inputRevision: 1, draftId: 'draft-1', draftRevisionVersion: 1, draftRevisionHash: 'draft-hash-1', confirmationRef: 'confirmation-1', evidenceRefs: [] } as const;
const snapshot = {
  title: 'Deliver feature', summary: 'Implement and verify the feature.',
  completeness: { scope: 'whole-task' as const, status: 'complete' as const },
  acceptanceCriteria: [{ criterionId: 'works', description: 'The feature meets the requested user outcome.' }],
  phases: [{ phaseId: 'build', title: 'Build', memberNodeIds: ['implement'] }],
  nodes: [{ nodeId: 'implement', kind: 'work', title: 'Implement', intent: 'Create the feature', definition: { owner: 'runtime' }, phaseId: 'build' }],
  relations: [],
} as const;

function publication(overrides: Partial<TaskPlanRevisionPublicationInput> = {}): TaskPlanRevisionPublicationInput {
  return {
    scope, revisionId: 'revision-1', sequence: 1, predecessor: null, snapshot,
    reason: { kind: 'initial', basisRefs: [] }, source, historyCoverage: 'complete-from-task-start',
    publishedAt: '2026-10-11T12:00:00.000Z', publishedBy: 'planner-1', journalCommitRef: 'journal:1',
    ...overrides,
  };
}

function nextRevision(previous: PublishedTaskPlanRevision, overrides: Partial<TaskPlanRevisionPublicationInput> = {}): PublishedTaskPlanRevision {
  return createPublishedTaskPlanRevision(publication({
    revisionId: 'revision-2', sequence: previous.sequence + 1,
    predecessor: { revisionId: previous.revisionId, sequence: previous.sequence, contentDigest: previous.contentDigest },
    reason: { kind: 'adjustment', text: 'Refined the implementation plan', basisRefs: [] },
    snapshot: { ...snapshot, summary: 'Implement, verify, and document the feature.' },
    publishedAt: '2026-10-11T11:00:00.000Z',
    ...overrides,
  }));
}

test('constructs and validates digest from the complete plan snapshot', () => {
  const revision = createPublishedTaskPlanRevision(publication());
  assert.equal(/^sha256:[a-f0-9]{64}$/.test(revision.contentDigest), true);
  assert.doesNotThrow(() => validatePublishedTaskPlanRevision(revision));
  assert.notEqual(revision.contentDigest, createPublishedTaskPlanRevision(publication({ snapshot: { ...snapshot, summary: 'Different full snapshot.' } })).contentDigest);
});

test('revision order follows sequence and predecessor, not timestamps', () => {
  const first = createPublishedTaskPlanRevision(publication());
  const second = nextRevision(first, { publishedAt: '2026-10-10T00:00:00.000Z' });
  assert.doesNotThrow(() => validateTaskPlanRevisionTransition(first, second));
});

test('transition rejects wrong task scope, skipped sequence, and predecessor digest drift', () => {
  const first = createPublishedTaskPlanRevision(publication());
  const validSecond = nextRevision(first);
  assert.throws(() => validateTaskPlanRevisionTransition(first, nextRevision(first, { scope: { ...scope, taskId: { scope: 'task', value: 'task-2' } } })), ContractError);
  assert.throws(() => validateTaskPlanRevisionTransition(first, nextRevision(first, { sequence: 3 })), ContractError);
  assert.throws(() => validateTaskPlanRevisionTransition(first, nextRevision(first, { predecessor: { ...validSecond.predecessor!, contentDigest: `sha256:${'f'.repeat(64)}` } })), ContractError);
});

test('same revision identity and immutable content retry idempotently; changed content conflicts', () => {
  const existing = createPublishedTaskPlanRevision(publication());
  const identicalRetry = createPublishedTaskPlanRevision(publication({ publishedAt: '2026-10-12T12:00:00.000Z', journalCommitRef: 'retry-attempt' }));
  assert.doesNotThrow(() => assertTaskPlanRevisionRetryMatches(existing, identicalRetry));
  const changed = createPublishedTaskPlanRevision(publication({ snapshot: { ...snapshot, summary: 'Changed content under same identity.' } }));
  assert.throws(() => assertTaskPlanRevisionRetryMatches(existing, changed), ContractError);
});

test('digest drift is rejected and does not mutate the original published snapshot', () => {
  const revision = createPublishedTaskPlanRevision(publication());
  const altered = { ...revision, snapshot: { ...revision.snapshot, summary: 'mutable overlay' } };
  assert.throws(() => validatePublishedTaskPlanRevision(altered), ContractError);
  assert.equal(revision.snapshot.summary, 'Implement and verify the feature.');
});

test('digest covers completeness and business acceptance criteria', () => {
  const original = createPublishedTaskPlanRevision(publication());
  const incomplete = createPublishedTaskPlanRevision(publication({
    snapshot: { ...snapshot, completeness: { scope: 'whole-task', status: 'complete' }, acceptanceCriteria: [{ criterionId: 'works', description: 'A different business outcome.' }] },
  }));
  assert.notEqual(original.contentDigest, incomplete.contentDigest);
  assert.throws(() => validatePublishedTaskPlanRevision({
    ...original, snapshot: { ...original.snapshot, acceptanceCriteria: [{ criterionId: 'works', description: 'tampered' }] },
  }), ContractError);
});

test('first publication requires sequence one and no predecessor', () => {
  const invalid = createPublishedTaskPlanRevision(publication({
    sequence: 2,
    predecessor: { revisionId: 'revision-0', sequence: 1, contentDigest: `sha256:${'0'.repeat(64)}` },
    reason: { kind: 'adjustment', text: 'Adjustment', basisRefs: [] },
  }));
  assert.throws(() => validateTaskPlanRevisionTransition(null, invalid), ContractError);
});
