import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  JsonlOrganJournal,
  JsonlTaskPlanRevisionJournal,
  JournalCommitConflictError,
  JournalIntegrityError,
} from '../../../packages/adapters/jsonl/src/index.js';
import type { TaskPlanRevisionAppendInput } from '../../../packages/adapters/jsonl/src/task-plan-revisions.js';
import {
  createPublishedTaskPlanRevision,
  validatePublishedTaskPlanRevision,
  validateTaskPlanRevisionTransition,
} from '../../../packages/core/src/task-plan-revision.js';
import { ContractError } from '../../../packages/contracts/src/errors.js';

const scope = { organId: { scope: 'organ' as const, value: 'organ-plan-test' }, taskId: { scope: 'task' as const, value: 'task-plan-test' } };
const source = { requirementId: 'req-1', inputRevision: 1, draftId: 'draft-1', draftRevisionVersion: 1, draftRevisionHash: 'draft-hash-1', confirmationRef: 'confirm-1', evidenceRefs: [] } as const;
const snapshot = {
  title: 'Complete task', summary: 'Build and verify.',
  completeness: { scope: 'whole-task' as const, status: 'complete' as const },
  acceptanceCriteria: [{ criterionId: 'deliverable-verified', description: 'The requested deliverable exists and passes its focused verification.' }],
  nodes: [{ nodeId: 'build', kind: 'work', title: 'Build', intent: 'Implement requested work', definition: { owner: 'orchestration' }, phaseId: 'implementation' }],
  phases: [{ phaseId: 'implementation', title: 'Implementation', memberNodeIds: ['build'] }],
  relations: [],
} as const;

function input(overrides: Partial<TaskPlanRevisionAppendInput> = {}): TaskPlanRevisionAppendInput {
  return {
    scope, revisionId: 'plan-v1', sequence: 1, predecessor: null, snapshot,
    reason: { kind: 'initial', basisRefs: [] }, source, historyCoverage: 'prior-history-unavailable',
    publishedAt: '2026-10-11T12:00:00.000Z', publishedBy: 'task-plan-owner',
    ...overrides,
  };
}

async function fixture(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-plan-journal-'));
  return { file: join(dir, 'organ.jsonl'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function recordCount(file: string): Promise<number> {
  return (await new JsonlOrganJournal(file).replay()).length;
}

test('append returns the real journal ref and a fresh adapter replays the ordered chain', async () => {
  const { file, cleanup } = await fixture();
  try {
    const writer = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    const first = await writer.append(input());
    const second = await writer.append(input({
      revisionId: 'plan-v2', sequence: 2,
      predecessor: { revisionId: first.revisionId, sequence: first.sequence, contentDigest: first.contentDigest },
      snapshot: { ...snapshot, summary: 'Build, test, and document.' },
      reason: { kind: 'adjustment', text: 'Add a documentation step', basisRefs: [] },
      source: { ...source, inputRevision: 2, draftRevisionVersion: 2, confirmationRef: 'confirm-2' },
      publishedAt: '2026-10-11T11:00:00.000Z',
    }));

    // Failure mode: the returned ref is not the durable Journal commit id, or the revision sequence leaks into it.
    const records = await new JsonlOrganJournal(file).replay();
    assert.deepEqual(records.map((record) => record.commitId), [
      first.journalCommitRef.slice('jsonl:'.length),
      second.journalCommitRef.slice('jsonl:'.length),
    ]);
    assert.equal((await new JsonlOrganJournal(file).findByCommitId(second.journalCommitRef.slice('jsonl:'.length)))?.seq, 2);
    assert.notEqual(first.journalCommitRef, second.journalCommitRef);

    // Failure mode: a fresh adapter loses, reorders, or rejects a valid chain; history coverage must survive intact.
    const restarted = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    const replayed = await restarted.replay(scope);
    assert.deepEqual(replayed, [first, second]);
    assert.equal(replayed[0].historyCoverage, 'prior-history-unavailable');
    assert.deepEqual(await restarted.replay({ ...scope, taskId: { scope: 'task', value: 'other-task' } }), []);

    // Failure mode: replay returns revisions that do not satisfy the Core transition rules.
    validateTaskPlanRevisionTransition(null, replayed[0]);
    validateTaskPlanRevisionTransition(replayed[0], replayed[1]);
  } finally {
    await cleanup();
  }
});

test('same publication retry returns the prior result without adding bytes or records', async () => {
  const { file, cleanup } = await fixture();
  try {
    const store = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    const first = await store.append(input());
    const bytes = await readFile(file, 'utf8');
    const count = await recordCount(file);

    // Failure mode: a duplicate publication re-appends because only journal metadata (publishedAt/publishedBy) changed.
    const retried = await store.append(input({ publishedAt: '2026-10-11T12:30:00.000Z', publishedBy: 'task-plan-owner-again' }));
    assert.deepEqual(retried, first);
    assert.equal(retried.journalCommitRef, first.journalCommitRef);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal(await recordCount(file), count);
  } finally {
    await cleanup();
  }
});

test('changed immutable content under the same identity conflicts without appending', async () => {
  const { file, cleanup } = await fixture();
  try {
    const store = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    await store.append(input());
    const bytes = await readFile(file, 'utf8');
    const count = await recordCount(file);

    // Failure mode: identity content drift is accepted, or an extra record is written for the same identity.
    await assert.rejects(
      () => store.append(input({ snapshot: { ...snapshot, summary: 'Changed under the same identity.' } })),
      JournalCommitConflictError,
    );
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal(await recordCount(file), count);
  } finally {
    await cleanup();
  }
});

test('invalid content and predecessor drift are rejected before append', async () => {
  const { file, cleanup } = await fixture();
  try {
    const store = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    const first = await store.append(input());
    const bytes = await readFile(file, 'utf8');
    const count = await recordCount(file);

    // Failure mode: a snapshot that Core rejects still reaches durable append.
    await assert.rejects(() => store.append(input({ snapshot: { ...snapshot, acceptanceCriteria: [] } })), Error);
    // Failure mode: a predecessor digest that does not match the authoritative revision is appended.
    await assert.rejects(
      () => store.append(input({
        revisionId: 'plan-v2', sequence: 2,
        predecessor: { revisionId: first.revisionId, sequence: first.sequence, contentDigest: `sha256:${'f'.repeat(64)}` },
        reason: { kind: 'adjustment', text: 'Adjusted plan', basisRefs: [] },
      })),
      JournalIntegrityError,
    );
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal(await recordCount(file), count);
  } finally {
    await cleanup();
  }
});

test('fresh replay rejects a well-formed record whose typed revision skips a sequence', async () => {
  const { file, cleanup } = await fixture();
  try {
    const rawJournal = new JsonlOrganJournal(file);
    const first = await new JsonlTaskPlanRevisionJournal(rawJournal).append(input());
    const skipped = createPublishedTaskPlanRevision({
      ...input({
        revisionId: 'plan-v3', sequence: 3,
        predecessor: { revisionId: first.revisionId, sequence: first.sequence, contentDigest: first.contentDigest },
        reason: { kind: 'adjustment', text: 'Skipped v2', basisRefs: [] },
      }),
      journalCommitRef: 'jsonl:typed-corrupt-chain',
    });
    await rawJournal.append({
      commitId: 'typed-corrupt-chain', kind: 'event', scope,
      payload: { type: 'task-plan-revision.published', revision: skipped as unknown as Record<string, unknown> },
    });

    // Failure mode: a valid outer Journal record carrying an out-of-order typed revision is trusted on replay.
    await assert.rejects(() => new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file)).replay(), JournalIntegrityError);
  } finally {
    await cleanup();
  }
});

test('fresh replay rejects a non-adjacent duplicate publication identity within one task', async () => {
  const { file, cleanup } = await fixture();
  try {
    const rawJournal = new JsonlOrganJournal(file);
    const first = createPublishedTaskPlanRevision({
      ...input(),
      journalCommitRef: 'jsonl:typed-replay-duplicate-a1',
    });
    const second = createPublishedTaskPlanRevision({
      ...input({
        revisionId: 'plan-v2', sequence: 2,
        predecessor: { revisionId: first.revisionId, sequence: first.sequence, contentDigest: first.contentDigest },
        reason: { kind: 'adjustment', text: 'Intermediate revision', basisRefs: [] },
      }),
      journalCommitRef: 'jsonl:typed-replay-duplicate-b',
    });
    const duplicate = createPublishedTaskPlanRevision({
      ...input({
        sequence: 3,
        predecessor: { revisionId: second.revisionId, sequence: second.sequence, contentDigest: second.contentDigest },
        snapshot: { ...snapshot, summary: 'Republished under a previously used identity.' },
        reason: { kind: 'adjustment', text: 'Reused identity', basisRefs: [] },
      }),
      journalCommitRef: 'jsonl:typed-replay-duplicate-a2',
    });
    await rawJournal.append({
      commitId: 'typed-replay-duplicate-a1', kind: 'event', scope,
      payload: { type: 'task-plan-revision.published', revision: first as unknown as Record<string, unknown> },
    });
    await rawJournal.append({
      commitId: 'typed-replay-duplicate-b', kind: 'event', scope,
      payload: { type: 'task-plan-revision.published', revision: second as unknown as Record<string, unknown> },
    });
    await rawJournal.append({
      commitId: 'typed-replay-duplicate-a2', kind: 'event', scope,
      payload: { type: 'task-plan-revision.published', revision: duplicate as unknown as Record<string, unknown> },
    });

    // Failure mode: replay accepts A -> B -> A as a valid history even though publication identity repeats.
    await assert.rejects(
      async () => {
        await new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file)).replay();
        throw new Error('replay unexpectedly accepted a duplicate revision identity');
      },
      JournalIntegrityError,
    );

  } finally {
    await cleanup();
  }
});

test('fresh replay allows the same revisionId on another task', async () => {
  const { file, cleanup } = await fixture();
  try {
    const store = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    const otherTask = { ...scope, taskId: { scope: 'task' as const, value: 'other-task' } };
    const first = await store.append(input());
    const otherFirst = await store.append(input({ scope: otherTask }));
    validatePublishedTaskPlanRevision(first);
    validatePublishedTaskPlanRevision(otherFirst);

    // Failure mode: duplicate identity tracking is global instead of scoped to one task.
    const restarted = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    assert.deepEqual(await restarted.replay(), [first, otherFirst]);
    assert.deepEqual(await restarted.replay(scope), [first]);
    assert.deepEqual(await restarted.replay(otherTask), [otherFirst]);
  } finally {
    await cleanup();
  }
});

test('append rejects a Date on a non-definition snapshot field before durable bytes or records change', async () => {
  const { file, cleanup } = await fixture();
  try {
    const store = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    const bytes = await readFile(file, 'utf8').catch(() => '');
    const count = await recordCount(file);
    const datedSnapshot = {
      ...snapshot,
      capturedAt: new Date('2026-10-11T12:00:00.000Z'),
    };

    // Failure mode: a non-JSON Date reaches the durable journal instead of being rejected at the contract boundary.
    await assert.rejects(() => store.append(input({ snapshot: datedSnapshot as unknown as typeof snapshot })), ContractError);
    assert.equal(await readFile(file, 'utf8').catch(() => ''), bytes);
    assert.equal(await recordCount(file), count);
  } finally {
    await cleanup();
  }
});

test('append rejects a definition array with custom toJSON before durable bytes or records change', async () => {
  const { file, cleanup } = await fixture();
  try {
    const store = new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file));
    const bytes = await readFile(file, 'utf8').catch(() => '');
    const count = await recordCount(file);
    const steps = ['build'];
    Object.assign(steps, { toJSON: () => ['changed'] });
    const toJsonSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => ({ ...node, definition: { owner: 'orchestration', steps } })),
    };

    // Failure mode: a custom array toJSON changes persistence semantics after the contract accepts the snapshot.
    await assert.rejects(() => store.append(input({ snapshot: toJsonSnapshot as unknown as typeof snapshot })), ContractError);
    assert.equal(await readFile(file, 'utf8').catch(() => ''), bytes);
    assert.equal(await recordCount(file), count);
  } finally {
    await cleanup();
  }
});

test('fresh replay rejects a well-formed record whose typed digest was altered', async () => {
  const { file, cleanup } = await fixture();
  try {
    const rawJournal = new JsonlOrganJournal(file);
    const first = await new JsonlTaskPlanRevisionJournal(rawJournal).append(input());
    const second = createPublishedTaskPlanRevision({
      ...input({
        revisionId: 'plan-v2', sequence: 2,
        predecessor: { revisionId: first.revisionId, sequence: first.sequence, contentDigest: first.contentDigest },
        reason: { kind: 'adjustment', text: 'Altered digest fixture', basisRefs: [] },
      }),
      journalCommitRef: 'jsonl:typed-corrupt-digest',
    });
    await rawJournal.append({
      commitId: 'typed-corrupt-digest', kind: 'event', scope,
      payload: {
        type: 'task-plan-revision.published',
        revision: { ...second, contentDigest: `sha256:${'0'.repeat(64)}` } as unknown as Record<string, unknown>,
      },
    });

    // Failure mode: a typed revision whose contentDigest does not match its snapshot is trusted on replay.
    await assert.rejects(() => new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file)).replay(), JournalIntegrityError);
  } finally {
    await cleanup();
  }
});
