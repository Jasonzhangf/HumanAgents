import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonlOrganJournal, JournalCommitConflictError, JournalIntegrityError } from '../../../packages/adapters/jsonl/src/index.js';
import { id, type Checkpoint, type ScopeRef } from '@humanagent/contracts';

const organ = id('organ', 'organ-a'); const task = id('task', 'task-a'); const cycle = id('cycle', 'cycle-a');
const checkpoint = (seq: number, previousCheckpointId: Checkpoint['previousCheckpointId']): Checkpoint => ({ id: id('checkpoint', `cp-${seq}`), scope: { organId: organ, taskId: task }, cycleId: cycle, seq, previousCheckpointId, directiveRevision: 1, executionEpoch: 1, outcome: 'waiting', summary: `cp-${seq}`, recoveryStateRef: { evidenceId: id('evidence', `ev-${seq}`), kind: 'operation', source: 'test', locator: `state-${seq}`, scope: { organId: organ, taskId: task } }, evidenceRefs: [], next: { kind: 'wait', ref: 'condition' } });
async function fixture(): Promise<{ journal: JsonlOrganJournal; file: string }> { const dir = await mkdtemp(join(tmpdir(), 'humanagent-journal-')); const file = join(dir, 'organ.jsonl'); return { journal: new JsonlOrganJournal(file), file }; }

const childCode = [
  "const url = process.argv[1];",
  "const file = process.argv[2];",
  "const commitId = process.argv[3];",
  "const scope = JSON.parse(process.argv[4]);",
  "const payload = JSON.parse(process.argv[5]);",
  "const { JsonlOrganJournal } = await import(url);",
  "await new JsonlOrganJournal(file).append({ commitId, kind: 'event', scope, payload });",
].join('\n');

function appendInChild(url: string, file: string, commitId: string): Promise<void> {
  const scope = { organId: organ, taskId: task };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, url, file, commitId, JSON.stringify(scope), JSON.stringify({ from: commitId })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code: number | null, signal?: string) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `child exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

test('append, latest, replay and verify checkpoint chain across events', async () => { const { journal } = await fixture(); const first = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(1, null) }); await journal.append({ kind: 'event', scope: { organId: organ, taskId: task }, payload: { observed: true } }); const second = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(2, first.checkpoint!.id) }); assert.equal((await journal.latest())!.seq, 3); assert.equal((await journal.replay()).length, 3); assert.equal((await journal.verify()).valid, true); assert.equal(second.checkpoint!.previousCheckpointId!.value, 'cp-1'); });
test('rejects duplicate and broken sequence records', async () => { const { journal, file } = await fixture(); const first = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(1, null) }); await journal.append({ kind: 'event', scope: { organId: organ, taskId: task }, payload: { observed: true } }); const raw = await readFile(file, 'utf8'); const [a, b] = raw.trim().split('\n').map((line) => JSON.parse(line) as { seq: number; previousRecordDigest: string | null }); await writeFile(file, `${JSON.stringify(a)}\n${JSON.stringify({ ...b, seq: a.seq })}\n`, 'utf8'); let result = await journal.verify(); assert.equal(result.valid, false); assert.match(result.error!, /duplicate/); await writeFile(file, `${JSON.stringify(a)}\n${JSON.stringify({ ...b, previousRecordDigest: 'sha256:wrong' })}\n`, 'utf8'); result = await journal.verify(); assert.equal(result.valid, false); assert.match(result.error!, /predecessor/); });
test('commitId is idempotent for the same facts and conflicts for different facts', async () => { const { journal, file } = await fixture(); const scope = { organId: organ, taskId: task }; const first = await journal.append({ commitId: 'job-1', kind: 'event', scope, payload: { step: 1 } }); const replay = await journal.append({ commitId: 'job-1', kind: 'event', scope, payload: { step: 1 } }); assert.equal(replay.seq, first.seq); assert.equal(replay.commitId, 'job-1'); assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1); await assert.rejects(() => journal.append({ commitId: 'job-1', kind: 'event', scope, payload: { step: 2 } }), JournalCommitConflictError); const second = await journal.append({ commitId: 'job-2', kind: 'event', scope, payload: { step: 2 } }); assert.equal(second.seq, 2); assert.equal((await journal.findByCommitId('job-1'))!.seq, 1); assert.equal((await journal.findByCommitId('job-2'))!.seq, 2); });
test('serializes cross-process appends under the same journal ownership', async () => { const { journal, file } = await fixture(); const moduleUrl = new URL('../../../packages/adapters/jsonl/src/index.js', import.meta.url).href; await Promise.all([appendInChild(moduleUrl, file, 'child-a'), appendInChild(moduleUrl, file, 'child-b')]); const records = await journal.replay(); const byCommit = new Map(records.map((record) => [record.commitId, record] as const)); assert.equal(records.length, 2); assert.deepEqual(records.map((record) => record.seq), [1, 2]); assert.ok(byCommit.has('child-a')); assert.ok(byCommit.has('child-b')); assert.equal(records[0]!.previousRecordDigest, null); assert.equal(records[1]!.previousRecordDigest, records[0]!.recordDigest); });
test('creates a missing journal parent for first append and recover', async () => { const root = await mkdtemp(join(tmpdir(), 'humanagent-journal-parent-')); const appendJournal = new JsonlOrganJournal(join(root, 'append', 'nested', 'organ.jsonl')); const recoverJournal = new JsonlOrganJournal(join(root, 'recover', 'nested', 'organ.jsonl')); const record = await appendJournal.append({ kind: 'event', scope: { organId: organ, taskId: task }, payload: { first: true } }); const recovered = await recoverJournal.recover(); assert.equal(record.seq, 1); assert.deepEqual(recovered, { valid: true, records: [] }); });
test('rejects broken checkpoint predecessor links', async () => { const { journal } = await fixture(); const first = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(1, null) }); await assert.rejects(() => journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(3, first.checkpoint!.id) }), JournalIntegrityError); });
test('rejects invalid scope and invalid record/checkpoint relationships', async () => { const { journal } = await fixture(); await assert.rejects(() => journal.append({ kind: 'event', scope: { organId: { scope: 'task', value: 'bad' } }, payload: {} } as never), JournalIntegrityError); await assert.rejects(() => journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task } } as never), JournalIntegrityError); await assert.rejects(() => journal.append({ kind: 'event', scope: { organId: organ, taskId: task } } as never), JournalIntegrityError); });
test('rejects malformed checkpoint evidence before appending to the journal', async () => { const { journal } = await fixture(); const scope = { organId: organ, taskId: task }; const invalidRecovery = { ...checkpoint(1, null), recoveryStateRef: { ...checkpoint(1, null).recoveryStateRef, digest: 17 as unknown as string } }; await assert.rejects(() => journal.append({ kind: 'checkpoint', scope, checkpoint: invalidRecovery }), JournalIntegrityError); const invalidEvidence = { ...checkpoint(1, null), evidenceRefs: [{ evidenceId: id('evidence', 'invalid-evidence-digest'), kind: 'operation' as const, source: 'test', locator: 'invalid', digest: 17 as unknown as string, scope }] }; await assert.rejects(() => journal.append({ kind: 'checkpoint', scope, checkpoint: invalidEvidence }), JournalIntegrityError); });
test('rejects recovery state references outside the checkpoint scope before append and verify', async () => { const { journal, file } = await fixture(); const otherTask = id('task', 'task-b'); const invalid = { ...checkpoint(1, null), recoveryStateRef: { ...checkpoint(1, null).recoveryStateRef, scope: { organId: organ, taskId: otherTask } } }; await assert.rejects(() => journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: invalid }), JournalIntegrityError); const valid = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(1, null) }); const raw = JSON.parse(await readFile(file, 'utf8')) as { checkpoint: Checkpoint; recordDigest: string }; const tampered = { ...raw, checkpoint: invalid }; const digest = (await import('node:crypto')).createHash('sha256').update(JSON.stringify({ ...tampered, recordDigest: undefined })).digest('hex'); await writeFile(file, `${JSON.stringify({ ...tampered, recordDigest: `sha256:${digest}` })}\n`, 'utf8'); const result = await journal.verify(); assert.equal(result.valid, false); assert.match(result.error!, /scope mismatch/); assert.equal(valid.checkpoint!.scope.taskId!.value, task.value); });
test('append rejects an incomplete trailing line without truncating and recover repairs it explicitly', async () => { const { journal, file } = await fixture(); const first = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(1, null) }); const committed = await readFile(file, 'utf8'); await appendFile(file, committed.slice(0, -1), 'utf8'); const incomplete = await readFile(file, 'utf8'); let result = await journal.verify(); assert.equal(result.valid, false); assert.match(result.error!, /trailing/); await assert.rejects(() => journal.append({ kind: 'event', scope: { organId: organ, taskId: task }, payload: { ignored: true } }), JournalIntegrityError); assert.equal(await readFile(file, 'utf8'), incomplete); const recovered = await journal.recover(); assert.equal(recovered.valid, true); assert.equal(recovered.records.length, 1); assert.equal(await readFile(file, 'utf8'), committed); assert.equal((await journal.latest())!.seq, first.seq); await journal.append({ kind: 'event', scope: { organId: organ, taskId: task }, payload: { ignored: true } }); assert.equal((await journal.latest())!.seq, 2); });
test('does not evict a live owner lock during a long critical section', async () => { const { journal, file } = await fixture(); const lockPath = `${file}.lock`; await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 60_000).toISOString(), token: 'live-owner' }), 'utf8'); let settled = false; const append = journal.append({ kind: 'event', scope: { organId: organ, taskId: task }, payload: { liveOwner: true } }).finally(() => { settled = true; }); await new Promise((resolve) => setTimeout(resolve, 100)); assert.equal(settled, false); await rm(lockPath, { force: true }); const record = await append; assert.equal(record.seq, 1); });
test('appends and verifies an operation-scoped stopped checkpoint after a business predecessor', async () => {
  const { journal } = await fixture();
  const businessScope = { organId: organ, taskId: task, cycleId: cycle };
  const operationId = id('operation', 'operation-stop-a');
  const operationScope = { ...businessScope, operationId };
  const businessEvidence = (label: string) => ({
    evidenceId: id('evidence', `business-${label}`),
    kind: 'operation' as const,
    source: 'test',
    locator: label,
    scope: businessScope,
  });
  const operationEvidence = (label: string) => ({
    evidenceId: id('evidence', `operation-${label}`),
    kind: 'operation' as const,
    source: 'test',
    locator: label,
    scope: operationScope,
  });
  const first = await journal.append({
    kind: 'checkpoint',
    scope: businessScope,
    checkpoint: {
      id: id('checkpoint', 'business-before-stop'),
      scope: businessScope,
      cycleId: cycle,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'waiting',
      summary: 'business checkpoint before stop',
      recoveryStateRef: businessEvidence('recovery'),
      evidenceRefs: [],
      next: { kind: 'wait', ref: 'approval' },
    },
  });
  const stopped = await journal.append({
    kind: 'checkpoint',
    scope: operationScope,
    checkpoint: {
      id: id('checkpoint', 'operation-stop'),
      scope: operationScope,
      cycleId: cycle,
      seq: 2,
      previousCheckpointId: first.checkpoint!.id,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'stopped',
      summary: 'operation-scoped stopped checkpoint',
      recoveryStateRef: operationEvidence('recovery'),
      evidenceRefs: [operationEvidence('settle')],
      next: { kind: 'stop', ref: 'stopped' },
    },
  });
  const verified = await journal.verify();
  const replayed = await journal.replay();
  assert.equal(verified.valid, true);
  assert.equal(replayed.length, 2);
  assert.equal(stopped.scope.operationId?.value, operationId.value);
  assert.equal(stopped.checkpoint!.scope.operationId?.value, operationId.value);
  assert.equal(replayed[1]!.scope.operationId?.value, operationId.value);
  assert.equal(replayed[1]!.checkpoint!.scope.operationId?.value, operationId.value);
});

test('recovery appends a root checkpoint for a new operation chain after another chain', async () => {
  const { journal } = await fixture();
  const firstOperation = id('operation', 'operation-epoch-1');
  const secondOperation = id('operation', 'operation-epoch-2');
  const firstScope = { organId: organ, taskId: task, cycleId: cycle, operationId: firstOperation };
  const secondScope = { organId: organ, taskId: task, cycleId: cycle, operationId: secondOperation };
  const evidence = (label: string, scope: ScopeRef) => ({
    evidenceId: id('evidence', `chain-${label}`),
    kind: 'operation' as const,
    source: 'test',
    locator: label,
    scope,
  });
  await journal.append({
    kind: 'checkpoint',
    scope: firstScope,
    checkpoint: {
      id: id('checkpoint', 'chain-1'),
      scope: firstScope,
      cycleId: cycle,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'failed',
      summary: 'first chain root',
      recoveryStateRef: evidence('recovery-1', firstScope),
      evidenceRefs: [],
      next: { kind: 'recover', ref: 'recover-1' },
    },
  });
  const recovered = await journal.append({
    kind: 'checkpoint',
    scope: secondScope,
    checkpoint: {
      id: id('checkpoint', 'chain-2'),
      scope: secondScope,
      cycleId: cycle,
      // A recovered operation is a new HumanAgent chain, so it restarts at
      // seq 1 with no predecessor even though another chain already exists.
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 2,
      outcome: 'succeeded',
      summary: 'second chain root',
      recoveryStateRef: evidence('recovery-2', secondScope),
      evidenceRefs: [],
      next: { kind: 'continue', ref: 'continue-2' },
    },
  });
  const verified = await journal.verify();
  assert.equal(verified.valid, true);
  assert.equal(recovered.checkpoint!.seq, 1);
  assert.equal(recovered.checkpoint!.previousCheckpointId, null);
});
