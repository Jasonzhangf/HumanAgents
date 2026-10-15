import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  validateTaskPlanRevisionMetadata,
  type PublishedTaskPlanRevision,
} from '@humanagent/contracts';

const digest = `sha256:${'a'.repeat(64)}` as const;
const base: PublishedTaskPlanRevision = {
  scope: { organId: { scope: 'organ', value: 'organ-1' }, taskId: { scope: 'task', value: 'task-1' } },
  revisionId: 'plan-revision-1', sequence: 1, contentDigest: digest, predecessor: null,
  snapshot: {
    title: 'Deliver feature', summary: 'Implement and verify the feature.',
    completeness: { scope: 'whole-task', status: 'complete' },
    acceptanceCriteria: [{ criterionId: 'works', description: 'The feature meets the requested user outcome.' }],
    phases: [{ phaseId: 'build', title: 'Build', memberNodeIds: ['implement'] }],
    nodes: [{ nodeId: 'implement', kind: 'work', title: 'Implement', intent: 'Create the feature', definition: { owner: 'runtime' }, phaseId: 'build' }],
    relations: [],
  },
  reason: { kind: 'initial', basisRefs: [] },
  source: { requirementId: 'requirement-1', inputRevision: 1, draftId: 'draft-1', draftRevisionVersion: 1, draftRevisionHash: 'draft-hash-1', confirmationRef: 'confirmation-1', evidenceRefs: [] },
  historyCoverage: 'complete-from-task-start', publishedAt: '2026-10-11T12:00:00.000Z', publishedBy: 'planner-1', journalCommitRef: 'journal:1',
};

test('published revision contract accepts a complete first task-scoped snapshot', () => {
  assert.doesNotThrow(() => validateTaskPlanRevisionMetadata(base));
});

test('published revision contract rejects incomplete scope, invalid sequence and malformed digest', () => {
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, scope: { organId: base.scope.organId } } as PublishedTaskPlanRevision), ContractError);
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, sequence: 0 }), ContractError);
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, contentDigest: 'sha256:bad' }), ContractError);
});

test('published revision contract rejects snapshots with dangling or duplicate structure', () => {
  const dangling = { ...base.snapshot, relations: [{ fromNodeId: 'implement', toNodeId: 'missing', kind: 'depends-on' as const }] };
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: dangling }), ContractError);
  const duplicate = { ...base.snapshot, nodes: [...base.snapshot.nodes, base.snapshot.nodes[0]!] };
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: duplicate }), ContractError);
});

test('published revision contract requires explicit whole-task completeness and business acceptance criteria', () => {
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: { ...base.snapshot, completeness: undefined } } as never), ContractError);
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: { ...base.snapshot, completeness: { scope: 'phase', status: 'complete' } } } as never), ContractError);
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: { ...base.snapshot, acceptanceCriteria: [] } }), ContractError);
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: { ...base.snapshot, acceptanceCriteria: [{ criterionId: 'works', description: '  ' }] } }), ContractError);
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: { ...base.snapshot, acceptanceCriteria: [base.snapshot.acceptanceCriteria[0]!, base.snapshot.acceptanceCriteria[0]!] } }), ContractError);
});

test('published revision contract rejects undeclared phase membership, relation cycles, and non-JSON definitions', () => {
  const mismatchedPhase = { ...base.snapshot, phases: [{ phaseId: 'build', title: 'Build', memberNodeIds: [] }] };
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: mismatchedPhase }), ContractError);
  const twoNodes = {
    ...base.snapshot,
    phases: [],
    nodes: [base.snapshot.nodes[0]!, { ...base.snapshot.nodes[0]!, nodeId: 'verify', phaseId: undefined }],
    relations: [
      { fromNodeId: 'implement', toNodeId: 'verify', kind: 'depends-on' as const },
      { fromNodeId: 'verify', toNodeId: 'implement', kind: 'depends-on' as const },
    ],
  };
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: twoNodes }), ContractError);
  const invalidDefinition = { ...base.snapshot, nodes: [{ ...base.snapshot.nodes[0]!, definition: { callback: () => undefined } }] } as unknown as typeof base.snapshot;
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: invalidDefinition }), ContractError);
  const dateDefinition = { ...base.snapshot, nodes: [{ ...base.snapshot.nodes[0]!, definition: { when: new Date('2026-10-11T12:00:00.000Z') } }] } as unknown as typeof base.snapshot;
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: dateDefinition }), ContractError);
});

test('published revision contract rejects a Date on a non-definition snapshot field', () => {
  const datedSnapshot = {
    ...base.snapshot,
    capturedAt: new Date('2026-10-11T12:00:00.000Z'),
  } as unknown as typeof base.snapshot;

  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: datedSnapshot }), ContractError);
});

test('published revision contract rejects a definition array with custom toJSON', () => {
  const steps = ['implement'];
  Object.assign(steps, { toJSON: () => ['changed'] });
  const snapshotWithToJson = {
    ...base.snapshot,
    nodes: [{ ...base.snapshot.nodes[0]!, definition: { owner: 'runtime', steps } }],
  } as unknown as typeof base.snapshot;

  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, snapshot: snapshotWithToJson }), ContractError);
});

test('initial, adjustment, and legacy boundary meanings are explicit', () => {
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, sequence: 2, reason: { kind: 'initial', basisRefs: [] }, predecessor: { revisionId: 'plan-revision-1', sequence: 1, contentDigest: digest } }), ContractError);
  assert.throws(() => validateTaskPlanRevisionMetadata({ ...base, historyCoverage: 'unknown' as PublishedTaskPlanRevision['historyCoverage'] }), ContractError);
  assert.doesNotThrow(() => validateTaskPlanRevisionMetadata({ ...base, historyCoverage: 'prior-history-unavailable' }));
});
