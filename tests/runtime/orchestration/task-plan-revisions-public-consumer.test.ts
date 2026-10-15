import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  JsonlOrganJournal,
  JsonlTaskPlanRevisionJournal,
  JournalIntegrityError,
} from '../../../packages/adapters/jsonl/src/index.js';
import type { ScopeRef, TaskId, TaskPlanSnapshot } from '../../../packages/contracts/src/index.js';
import {
  OrchestrationPortError,
} from '../../../packages/runtime/src/orchestration/errors.js';
import {
  TaskPlanRevisionConsumer,
  type TaskPlanRevisionPublishInput,
} from '../../../packages/runtime/src/orchestration/task-plan-revisions.js';

const scope: ScopeRef & { readonly taskId: TaskId } = {
  organId: { scope: 'organ', value: 'organ-t1' },
  taskId: { scope: 'task', value: 'task-t1' },
};

const source = {
  requirementId: 'req-t1',
  inputRevision: 1,
  draftId: 'draft-t1',
  draftRevisionVersion: 1,
  draftRevisionHash: 'draft-hash-t1',
  confirmationRef: 'confirm-t1',
  evidenceRefs: [],
} as const;

const snapshot: TaskPlanSnapshot = {
  title: 'Deliver the requested task',
  summary: 'Plan and verify the requested outcome.',
  completeness: { scope: 'whole-task', status: 'complete' },
  acceptanceCriteria: [{ criterionId: 'deliverable-verified', description: 'The requested deliverable exists and passes its focused verification.' }],
  nodes: [{ nodeId: 'build', kind: 'work', title: 'Build', intent: 'Implement the requested work', definition: { owner: 'runtime' }, phaseId: 'implementation' }],
  phases: [{ phaseId: 'implementation', title: 'Implementation', memberNodeIds: ['build'] }],
  relations: [],
};

function publishInput(overrides: Partial<TaskPlanRevisionPublishInput> = {}): TaskPlanRevisionPublishInput {
  return {
    scope,
    revisionId: 'plan-v1',
    sequence: 1,
    predecessor: null,
    snapshot,
    reason: { kind: 'initial', basisRefs: [] },
    source,
    historyCoverage: 'prior-history-unavailable',
    publishedAt: '2026-10-12T00:00:00.000Z',
    publishedBy: 'runtime-task-plan-consumer',
    ...overrides,
  };
}

async function fixture(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const root = process.env.HUMANAGENT_TEST_ROOT ?? join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'humanagent-t1-plan-'));
  console.log(`TaskPlan receipt fixture: ${dir}`);
  return { file: join(dir, 'organ.jsonl'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function consumerFor(file: string): TaskPlanRevisionConsumer {
  return new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(new JsonlOrganJournal(file)));
}

test('the public Runtime consumer publishes through the authoritative JSONL port and reads the exact revision back', async () => {
  const { file, cleanup } = await fixture();
  try {
    // An unrelated event shifts the Journal seq away from the revision sequence, so a receipt that
    // copies revision.sequence or contentDigest cannot be mistaken for the real record triplet.
    await new JsonlOrganJournal(file).append({
      commitId: 't1-prior-unrelated-event',
      kind: 'event',
      scope,
      payload: { type: 'prior-owner.event', marker: 'unrelated' },
    });

    const consumer = consumerFor(file);
    const result = await consumer.publish(publishInput());

    // Failure mode: the consumer keeps a private store, so the committed revision is not the durable record.
    assert.equal(result.outcome, 'published');
    assert.equal(result.revision.sequence, 1);
    assert.equal(result.revision.predecessor, null);
    assert.equal(result.revision.scope.taskId.value, 'task-t1');
    const record = await new JsonlOrganJournal(file).findByCommitId(result.revision.journalCommitRef.slice('jsonl:'.length));
    if (record === null || record.commitId === undefined) {
      throw new Error('published revision did not resolve to a committed Journal record');
    }
    assert.equal(record.seq, 2);
    assert.equal((record?.payload?.revision as { revisionId: string }).revisionId, 'plan-v1');

    // Failure mode: the receipt is synthesized from the revision payload instead of the physical record.
    const ref = await consumer.getCommitRef(scope, 'plan-v1');
    assert.notEqual(ref, null, 'committed revision must expose its journal receipt');
    assert.deepEqual(ref, { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest });
    assert.notEqual(ref?.journalSeq, result.revision.sequence);
    assert.notEqual(ref?.recordDigest, result.revision.contentDigest);

    // Failure mode: a fresh consumer over a fresh adapter cannot read back the same revision (new/old replay drift).
    const reader = consumerFor(file);
    // Failure mode: the receipt survives only in process memory, or reading it writes to the Journal.
    const bytesBefore = await readFile(file, 'utf8');
    assert.deepEqual(await reader.getCommitRef(scope, 'plan-v1'), ref);
    assert.equal(await readFile(file, 'utf8'), bytesBefore);
    assert.deepEqual(await reader.get(scope, 'plan-v1'), result.revision);
    assert.deepEqual(await reader.list(scope), [result.revision]);
    assert.deepEqual(await reader.replay(scope), [result.revision]);
    assert.deepEqual(await reader.replay(), [result.revision]);
    assert.equal(await reader.get(scope, 'plan-missing'), null);
    // Failure mode: an absent or foreign revision yields a fabricated receipt instead of verified absence.
    assert.equal(await reader.getCommitRef(scope, 'plan-missing'), null);
    assert.equal(
      await reader.getCommitRef({ organId: scope.organId, taskId: { scope: 'task', value: 'task-other' } }, 'plan-v1'),
      null,
    );
  } finally {
    await cleanup();
  }
});

test('a second publication binds the exact predecessor identity, sequence, and digest', async () => {
  const { file, cleanup } = await fixture();
  try {
    const consumer = consumerFor(file);
    const first = await consumer.publish(publishInput());
    const second = await consumer.publish(publishInput({
      revisionId: 'plan-v2',
      sequence: 2,
      predecessor: { revisionId: first.revision.revisionId, sequence: first.revision.sequence, contentDigest: first.revision.contentDigest },
      snapshot: { ...snapshot, summary: 'Plan, verify, and document the requested outcome.' },
      reason: { kind: 'adjustment', text: 'Add a documentation step', basisRefs: [] },
      source: { ...source, inputRevision: 2, draftRevisionVersion: 2, confirmationRef: 'confirm-t1-v2' },
    }));

    // Failure mode: the published chain loses or rewrites the predecessor binding.
    assert.equal(second.outcome, 'published');
    assert.equal(second.revision.sequence, 2);
    assert.equal(second.revision.predecessor?.revisionId, first.revision.revisionId);
    assert.equal(second.revision.predecessor?.sequence, first.revision.sequence);
    assert.equal(second.revision.predecessor?.contentDigest, first.revision.contentDigest);
    assert.deepEqual((await consumer.replay(scope)).map((revision) => revision.sequence), [1, 2]);
  } finally {
    await cleanup();
  }
});

test('retrying the identical publication returns the committed revision without a second durable write', async () => {
  const { file, cleanup } = await fixture();
  try {
    const consumer = consumerFor(file);
    const first = await consumer.publish(publishInput());
    const bytes = await readFile(file, 'utf8');

    // Failure mode: a retry re-publishes because only journal metadata (publishedAt/publishedBy) changed.
    const retried = await consumer.publish(publishInput({ publishedAt: '2026-10-12T05:00:00.000Z', publishedBy: 'runtime-task-plan-consumer-again' }));
    assert.equal(retried.outcome, 'existing');
    assert.deepEqual(retried.revision, first.revision);
    assert.equal(retried.revision.journalCommitRef, first.revision.journalCommitRef);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal((await consumer.replay(scope)).length, 1);
  } finally {
    await cleanup();
  }
});

test('a predecessor digest mismatch is exposed as a port error and writes no durable record', async () => {
  const { file, cleanup } = await fixture();
  try {
    const consumer = consumerFor(file);
    const first = await consumer.publish(publishInput());
    const bytes = await readFile(file, 'utf8');

    // Failure mode: a predecessor that does not match the authoritative revision is accepted or silently swallowed.
    let captured: unknown;
    let rejected = false;
    try {
      await consumer.publish(publishInput({
        revisionId: 'plan-v2',
        sequence: 2,
        predecessor: { revisionId: first.revision.revisionId, sequence: first.revision.sequence, contentDigest: `sha256:${'f'.repeat(64)}` },
        reason: { kind: 'adjustment', text: 'Adjusted plan', basisRefs: [] },
      }));
    } catch (error) {
      rejected = true;
      captured = error;
    }
    assert.equal(rejected, true);
    if (!(captured instanceof OrchestrationPortError)) throw new Error('expected an OrchestrationPortError');
    assert.equal(captured.reason, 'task-plan-revision-port-failure');
    assert.ok(captured.cause instanceof JournalIntegrityError);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal((await consumer.replay(scope)).length, 1);
  } finally {
    await cleanup();
  }
});

test('a well-formed record whose typed revision scope disagrees with its record is surfaced on replay', async () => {
  const { file, cleanup } = await fixture();
  try {
    const consumer = consumerFor(file);
    const published = await consumer.publish(publishInput());
    const otherScope: ScopeRef = { organId: { scope: 'organ', value: 'organ-t1' }, taskId: { scope: 'task', value: 'task-other' } };
    await new JsonlOrganJournal(file).append({
      commitId: 't1-scope-mismatch',
      kind: 'event',
      scope: otherScope,
      payload: {
        type: 'task-plan-revision.published',
        revision: { ...published.revision, journalCommitRef: 'jsonl:t1-scope-mismatch' } as unknown as Record<string, unknown>,
      },
    });

    // Failure mode: replay fabricates a revision from a record whose typed scope does not match.
    let captured: unknown;
    let rejected = false;
    try {
      await consumer.replay(scope);
    } catch (error) {
      rejected = true;
      captured = error;
    }
    assert.equal(rejected, true);
    if (!(captured instanceof OrchestrationPortError)) throw new Error('expected an OrchestrationPortError');
    assert.ok(captured.cause instanceof JournalIntegrityError);

    // Failure mode: the receipt read swallows corruption or answers with a fabricated ref/null.
    let receiptError: unknown;
    try {
      await consumer.getCommitRef(scope, 'plan-v1');
    } catch (error) {
      receiptError = error;
    }
    if (!(receiptError instanceof OrchestrationPortError)) throw new Error('expected a receipt OrchestrationPortError');
    assert.equal(receiptError.reason, 'task-plan-revision-port-failure');
    assert.ok(receiptError.cause instanceof JournalIntegrityError);
  } finally {
    await cleanup();
  }
});
