import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  type ScopeRef,
  type TaskId,
  id,
} from '../../packages/contracts/src/index.js';
import { JsonlOrganJournal, type JournalRecord } from '../../packages/adapters/jsonl/src/index.js';
import { readColdCurrentFromJournal, readCurrentFromRecords } from '../../packages/app/src/ui-runtime/reentry-current-facts.js';

// Failure modes, cost and rationale are recorded in the accepted plan §6 and the
// r4 note. The source-selection case uses a read-only copy of the observed live
// fixture; no model, provider, daemon or HTTP endpoint is started.
const fixtureRoot = join(homedir(), '.humanagent', 'test-fixtures', 'provider-cold-current-foundation-20261015');
const sourceJournalPath = join(fixtureRoot, 'source', 'checkpoints', 'ui-runtime', 'rcc', 'task-control.jsonl');

const organId = id('organ', 'humanagent-ui');
const taskId: TaskId = id('task', 'ui-task-implicit-draft-2');
const cycleId = id('cycle', 'ui-cycle-1');
const operationId = id('operation', 'ui-operation-1');
const businessTurnId = 'active-turn-ui-operation-1';
const principalOwner = 'product-principal:v1:2M546aZ8abemI_wVq0horZZEoHaOyRTNT_MSzAKmlwo';
const scope: ScopeRef = { organId, taskId, cycleId, operationId };
const runtimeId = 'ui-runtime-ui-operation-1';

const allocation = {
  runtimeId,
  taskId,
  operationId,
  executionEpoch: 1,
  assignmentId: 'assignment-ui-operation-1',
  scope,
  inputRefs: ['task://ui-task-implicit-draft-2/input/1'],
  ownerId: principalOwner,
  directiveRevision: 1,
  inputRevision: 1,
  orchestrated: false,
};

const input = { allocation, businessTurnId };

// Only the retained allocation's cycle id differs from the observed open turn.
const wrongCycleInput = {
  allocation: { ...allocation, scope: { ...scope, cycleId: id('cycle', 'ui-cycle-other') } },
  businessTurnId,
};

/** Rewrites the digest chain so a mutated journal still verifies as intact. */
function rechain(records: readonly JournalRecord[]): readonly JournalRecord[] {
  let previousRecordDigest: string | null = null;
  const output: JournalRecord[] = [];
  let seq = 0;
  for (const record of records) {
    seq += 1;
    const withoutDigest: Omit<JournalRecord, 'recordDigest'> = {
      version: 1 as const,
      seq,
      kind: record.kind,
      scope: record.scope,
      memoryScope: record.memoryScope,
      memorySource: record.memorySource,
      commitId: record.commitId,
      commitFactDigest: record.commitFactDigest,
      checkpoint: record.checkpoint,
      nativeCheckpointEnvelope: record.nativeCheckpointEnvelope,
      payload: record.payload,
      previousRecordDigest,
    };
    const recordDigest: string = `sha256:${createHash('sha256').update(JSON.stringify(withoutDigest)).digest('hex')}`;
    const chained: JournalRecord = { ...withoutDigest, recordDigest };
    output.push(chained);
    previousRecordDigest = recordDigest;
  }
  return output;
}

function commitFactDigest(record: JournalRecord): string {
  const fact: Record<string, unknown> = {
    kind: record.kind,
    scope: record.scope,
    checkpoint: record.checkpoint ?? null,
    payload: record.payload ?? null,
  };
  if (record.memoryScope !== undefined) fact.memoryScope = record.memoryScope;
  if (record.memorySource !== undefined) fact.memorySource = record.memorySource;
  if (record.nativeCheckpointEnvelope !== undefined) fact.nativeCheckpointEnvelope = record.nativeCheckpointEnvelope;
  return `sha256:${createHash('sha256').update(JSON.stringify(fact)).digest('hex')}`;
}

async function freshJournal(mutate?: (records: JournalRecord[]) => void): Promise<string> {
  const dir = await mkdtemp(join(fixtureRoot, 'consumer-'));
  const filePath = join(dir, 'task-control.jsonl');
  const records: JournalRecord[] = (JSON.parse(
    `[${(await readFile(sourceJournalPath, 'utf8')).trim().split('\n').join(',')}]`,
  ) as JournalRecord[]);
  if (mutate !== undefined) mutate(records);
  const updated = records.map((record) =>
    record.commitId === undefined ? record : { ...record, commitFactDigest: commitFactDigest(record) });
  const chained = rechain(updated);
  await writeFile(filePath, `${chained.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return filePath;
}

async function verifiedRecordCount(filePath: string): Promise<number> {
  const verification = await new JsonlOrganJournal(filePath).verify();
  if (!verification.valid) throw new Error(`fixture journal must verify: ${verification.error ?? 'unknown'}`);
  return verification.records.length;
}

test('cold current facts recognize the original open turn without a checkpoint closure or v1 capture', async () => {
  const filePath = await freshJournal();
  const recordCount = await verifiedRecordCount(filePath);
  const journal = new JsonlOrganJournal(filePath);
  const bytes = await readFile(filePath, 'utf8');

  const read = await readColdCurrentFromJournal(journal, input, principalOwner);
  if (read.state !== 'known') throw new Error(`cold current facts are unknown: ${read.reason}`);
  if (read.kind !== 'initial-turn-open') throw new Error(`cold current facts kind is ${read.kind}`);

  // Same task, operation, business turn and physical epoch as the observed run.
  assert.equal(read.task.id.value, 'ui-task-implicit-draft-2');
  assert.equal(read.task.organId.value, 'humanagent-ui');
  assert.equal(read.task.state, 'blocked');
  assert.equal(read.entryPhase, 'open');
  assert.deepEqual(read.nextAction, { kind: 'continue' });
  assert.equal(read.position.executionEpoch, 1);
  assert.equal(read.context.agentRuntimeId, runtimeId);
  assert.equal(read.context.loopCheckpoint.executionEpoch, 1);
  assert.equal(read.context.previousContextCommitRef, null);
  assert.equal(read.operationControl.state, 'complete');
  assert.equal(read.operationControl.scope.taskId?.value, 'ui-task-implicit-draft-2');

  // Canonical identity and grant are the real durable records of the same task
  // and principal, read through their own owners.
  assert.equal(read.identity.scope.taskId.value, 'ui-task-implicit-draft-2');
  assert.equal(read.identity.scope.organId.value, 'humanagent-ui');
  assert.equal(read.grant.grant.task.value, 'ui-task-implicit-draft-2');
  assert.equal(read.grant.grant.state, 'granted');
  assert.equal(read.grant.owner, principalOwner);
  assert.equal(read.grant.permissionRevision, '1');

  // The initial source carries the committed binding, its exact carrier, and
  // the committed records through that turn. It is not a capture.
  assert.equal(read.initial.binding.admittedTurn.turnId, businessTurnId);
  assert.equal(read.initial.binding.assignment.assignmentId, 'assignment-ui-operation-1');
  assert.equal(read.initial.binding.execution.runtimeId, runtimeId);
  assert.equal(read.initial.binding.execution.executionEpoch, 1);
  assert.equal(read.initial.bindingCommitRef.commitId, `active-turn:${businessTurnId}:binding-opened`);
  assert.equal(read.initial.bindingCommitRef.journalSeq, 6);
  assert.equal(read.initial.recordsThroughCommitRef.journalSeq, 112);
  assert.equal(read.initial.records.length > 0, true);
  const bindingCarrier = read.initial.records.find((record) => record.kind === 'binding-opened');
  assert.equal(bindingCarrier !== undefined, true);

  // Position and context receipts are the real committed records.
  assert.equal(read.position.contextCommitRef.journalSeq, 8);
  assert.equal(read.position.contextCommitRef.commitId,
    'context-history:8037838f09e6aec583e20fce924577d1568043c95b4cab58153d8d748497a794');
  assert.equal(read.stateCommitRef.journalSeq, 113);

  // Pending provider work stays pending; it is never invented as settled.
  assert.equal(read.unresolvedDisplacedRefs.length > 0, true);
  assert.equal(read.retainedDuties.length, 0);

  // A fact read is not an authorization, and it never mutates the Journal.
  assert.equal(await readFile(filePath, 'utf8'), bytes);
  assert.equal(await verifiedRecordCount(filePath), recordCount);
});

test('cold current facts keep the checkpoint-bound branch delegating to the unchanged reader', async () => {
  const filePath = await freshJournal();
  const journal = new JsonlOrganJournal(filePath);
  const current = readCurrentFromRecords(await journal.replay(), { organId, taskId });
  // The observed no-closure sample must still be unknown for the unchanged
  // checkpoint reader. This guard fails if a base position is ever fabricated.
  assert.equal(current.state, 'unknown');
  if (current.state === 'unknown') {
    assert.equal(current.reason,
      'no committed bound checkpoint closure establishes a related execution position for this task');
  }
});

test('cold current facts stay unknown when the canonical task identity record is missing', async () => {
  const filePath = await freshJournal((records) => {
    records.splice(0, 1);
  });
  const read = await readColdCurrentFromJournal(new JsonlOrganJournal(filePath), input, principalOwner);
  assert.equal(read.state, 'unknown');
  if (read.state === 'unknown') {
    assert.match(read.reason, /identity/);
  }
  assert.equal(await verifiedRecordCount(filePath), 112);
});

test('cold current facts stay unknown when the canonical task identity record is malformed', async () => {
  const filePath = await freshJournal((records) => {
    const identityRecord = records[0]!;
    const payload = identityRecord.payload as { readonly identity: Record<string, unknown> };
    const identity = payload.identity;
    const source = identity.source as Record<string, unknown>;
    delete source.confirmationRef;
  });
  const read = await readColdCurrentFromJournal(new JsonlOrganJournal(filePath), input, principalOwner);
  assert.equal(read.state, 'unknown');
  if (read.state === 'unknown') {
    assert.match(read.reason, /identity/);
  }
  assert.equal(await verifiedRecordCount(filePath), 113);
});

test('cold current facts stay unknown when the retained allocation belongs to another cycle', async () => {
  // Same copied initial Journal, one call, only the cycle id differs: the open
  // facts of this turn must not be admitted for a different cycle.
  const filePath = await freshJournal();
  const read = await readColdCurrentFromJournal(new JsonlOrganJournal(filePath), wrongCycleInput, principalOwner);
  assert.equal(read.state, 'unknown');
  if (read.state === 'unknown') {
    assert.match(read.reason, /binding scope/);
  }
  assert.equal(await verifiedRecordCount(filePath), 113);
});
