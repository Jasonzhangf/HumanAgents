import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createJsonlEventPublicationJournal,
  JsonlOrganJournal,
  JournalCommitConflictError,
  JournalIntegrityError,
} from '../../../packages/adapters/jsonl/src/index.js';
import { id, type Checkpoint, type ScopeRef } from '@humanagent/contracts';
import {
  OperationEventPublicationError,
  publishOperationEvent,
  queryOperationEvents,
  replayOperationEventNotifications,
  type EventRecord,
  type OperationEventNotificationAck,
  type OperationEventNotificationPort,
  type TrustedEventPublisher,
} from '../../../packages/runtime/src/events/index.js';

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

const receiptLossWriterCode = [
  "const [url, file, inputJson] = process.argv.slice(1);",
  "try {",
  "  const { JsonlOrganJournal } = await import(url);",
  "  await new JsonlOrganJournal(file).append(JSON.parse(inputJson));",
  "  process.kill(process.pid, 'SIGKILL');",
  "} catch (error) {",
  "  process.stderr.write(String(error?.stack ?? error));",
  "  process.exitCode = 1;",
  "}",
].join('\n');

const receiptLossConsumerCode = [
  "import assert from 'node:assert/strict';",
  "const [url, file, expectedJson] = process.argv.slice(1);",
  "const expected = JSON.parse(expectedJson);",
  "const { JsonlOrganJournal, JournalCommitConflictError } = await import(url);",
  "const journal = new JsonlOrganJournal(file);",
  "const recovered = await journal.recover();",
  "assert.equal(recovered.valid, true);",
  "assert.deepEqual(recovered.records.map((record) => record.seq), [1, 2]);",
  "assert.deepEqual(JSON.parse(JSON.stringify(recovered.records[0])), expected.predecessor);",
  "assert.equal(recovered.records[0].recordDigest, expected.predecessorDigest);",
  "const committed = recovered.records[1];",
  "assert.equal(committed.commitId, expected.commitId);",
  "assert.deepEqual(committed.scope, expected.input.scope);",
  "assert.deepEqual(committed.payload, expected.input.payload);",
  "assert.equal(committed.previousRecordDigest, expected.predecessorDigest);",
  "assert.deepEqual(await journal.findByCommitId(expected.commitId), committed);",
  "const committedBytes = await (await import('node:fs/promises')).readFile(file, 'utf8');",
  "const retry = await journal.append(expected.input);",
  "assert.deepEqual(retry, committed);",
  "assert.equal(await (await import('node:fs/promises')).readFile(file, 'utf8'), committedBytes);",
  "await assert.rejects(() => journal.append({ ...expected.input, payload: { ...expected.input.payload, corrected: true } }), JournalCommitConflictError);",
  "assert.equal(await (await import('node:fs/promises')).readFile(file, 'utf8'), committedBytes);",
  "const nextInput = { commitId: expected.nextCommitId, kind: 'event', scope: expected.input.scope, payload: expected.nextPayload };",
  "const next = await journal.append(nextInput);",
  "assert.equal(next.seq, 3);",
  "assert.equal(next.previousRecordDigest, committed.recordDigest);",
  "const replay = await journal.replay();",
  "assert.deepEqual(replay.map((record) => record.commitId ?? null), [null, expected.commitId, expected.nextCommitId]);",
  "assert.deepEqual(replay.map((record) => record.seq), [1, 2, 3]);",
  "const repeatedRecovery = await journal.recover();",
  "assert.equal(repeatedRecovery.valid, true);",
  "assert.deepEqual(repeatedRecovery.records, replay);",
  "process.stdout.write(JSON.stringify({ recoveredValid: recovered.valid, recoveredSequences: recovered.records.map((record) => record.seq), predecessorRecord: recovered.records[0], commitId: committed.commitId, scope: committed.scope, payload: committed.payload, predecessorDigest: committed.previousRecordDigest, committedDigest: committed.recordDigest, foundByCommitId: true, identicalRetry: true, idempotentBytesUnchanged: true, conflictName: 'JournalCommitConflictError', conflictBytesUnchanged: true, nextSequence: next.seq, nextPreviousDigest: next.previousRecordDigest, replayCommitIds: replay.map((record) => record.commitId ?? null), repeatedRecoveryValid: repeatedRecovery.valid, replayCount: repeatedRecovery.records.length }));",
].join('\n');

interface ChildResult {
  pid: number | undefined;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

function runBoundedChild(code: string, args: string[]): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result: ChildResult = { pid: child.pid, code: null, signal: null, stdout: '', stderr: '', timedOut: false };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { result.stdout += chunk; });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => { result.stderr += chunk; });
    child.on('error', (error) => { result.spawnError = error; });
    let settled = false;
    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill('SIGKILL');
    }, 10_000);
    child.on('close', (codeValue, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.code = codeValue;
      result.signal = signal;
      resolve(result);
    });
  });
}

test('append, latest, replay and verify checkpoint chain across events', async () => { const { journal } = await fixture(); const first = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(1, null) }); await journal.append({ kind: 'event', scope: { organId: organ, taskId: task }, payload: { observed: true } }); const second = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(2, first.checkpoint!.id) }); assert.equal((await journal.latest())!.seq, 3); assert.equal((await journal.replay()).length, 3); assert.equal((await journal.verify()).valid, true); assert.equal(second.checkpoint!.previousCheckpointId!.value, 'cp-1'); });
test('rejects duplicate and broken sequence records', async () => { const { journal, file } = await fixture(); const first = await journal.append({ kind: 'checkpoint', scope: { organId: organ, taskId: task }, checkpoint: checkpoint(1, null) }); await journal.append({ kind: 'event', scope: { organId: organ, taskId: task }, payload: { observed: true } }); const raw = await readFile(file, 'utf8'); const [a, b] = raw.trim().split('\n').map((line) => JSON.parse(line) as { seq: number; previousRecordDigest: string | null }); await writeFile(file, `${JSON.stringify(a)}\n${JSON.stringify({ ...b, seq: a.seq })}\n`, 'utf8'); let result = await journal.verify(); assert.equal(result.valid, false); assert.match(result.error!, /duplicate/); await writeFile(file, `${JSON.stringify(a)}\n${JSON.stringify({ ...b, previousRecordDigest: 'sha256:wrong' })}\n`, 'utf8'); result = await journal.verify(); assert.equal(result.valid, false); assert.match(result.error!, /predecessor/); });
test('commitId is idempotent for the same facts and conflicts for different facts', async () => { const { journal, file } = await fixture(); const scope = { organId: organ, taskId: task }; const first = await journal.append({ commitId: 'job-1', kind: 'event', scope, payload: { step: 1 } }); const replay = await journal.append({ commitId: 'job-1', kind: 'event', scope, payload: { step: 1 } }); assert.equal(replay.seq, first.seq); assert.equal(replay.commitId, 'job-1'); assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1); await assert.rejects(() => journal.append({ commitId: 'job-1', kind: 'event', scope, payload: { step: 2 } }), JournalCommitConflictError); const second = await journal.append({ commitId: 'job-2', kind: 'event', scope, payload: { step: 2 } }); assert.equal(second.seq, 2); assert.equal((await journal.findByCommitId('job-1'))!.seq, 1); assert.equal((await journal.findByCommitId('job-2'))!.seq, 2); });
test('recovers a committed journal fact after writer termination without an outer receipt', async () => {
  const fixtureRoot = '/Users/fanzhang/.humanagent/test-fixtures/native-reasoning-f1-j-a2';
  await mkdir(fixtureRoot, { recursive: true });
  const fixturePath = await mkdtemp(join(fixtureRoot, 'receipt-loss-'));
  const file = join(fixturePath, 'organ.jsonl');
  const moduleUrl = new URL('../../../packages/adapters/jsonl/src/index.js', import.meta.url).href;
  const scope = { organId: organ, taskId: task };
  const input = { commitId: 'f1-j-a2-committed-c', kind: 'event' as const, scope, payload: { observation: 'committed-before-writer-termination' } };
  const nextCommitId = 'f1-j-a2-next-d';
  const nextPayload = { observation: 'appended-by-fresh-consumer' };
  let writer: ChildResult | null = null;
  let consumer: ChildResult | null = null;
  try {
    const journal = new JsonlOrganJournal(file);
    const predecessor = await journal.append({ kind: 'event', scope, payload: { predecessor: true } });
    const predecessorBytes = await readFile(file);
    const expected = { input, commitId: input.commitId, nextCommitId, nextPayload, predecessorDigest: predecessor.recordDigest, predecessor };

    writer = await runBoundedChild(receiptLossWriterCode, [moduleUrl, file, JSON.stringify(input)]);
    assert.equal(writer.timedOut, false, `writer timed out (pid ${writer.pid ?? 'unknown'}): ${writer.stderr}`);
    assert.equal(writer.spawnError, undefined, `writer setup failed: ${writer.spawnError?.message}`);
    assert.equal(writer.signal, 'SIGKILL', `writer did not terminate itself with SIGKILL: ${writer.stderr}`);
    assert.equal(writer.code, null);
    assert.equal(writer.stdout, '', 'writer sent an application-level receipt');
    assert.equal(writer.stderr, '', `writer setup/append error: ${writer.stderr}`);
    const afterWriterBytes = await readFile(file);
    assert.equal(predecessorBytes.every((byte, index) => afterWriterBytes[index] === byte), true, 'writer changed predecessor bytes');

    consumer = await runBoundedChild(receiptLossConsumerCode, [moduleUrl, file, JSON.stringify(expected)]);
    assert.equal(consumer.timedOut, false, `consumer timed out (pid ${consumer.pid ?? 'unknown'}): ${consumer.stderr}`);
    assert.equal(consumer.spawnError, undefined, `consumer setup failed: ${consumer.spawnError?.message}`);
    assert.equal(consumer.signal, null, `consumer was signaled: ${consumer.signal}`);
    assert.equal(consumer.code, 0, `consumer assertions failed: ${consumer.stderr}`);
    const report = JSON.parse(consumer.stdout) as {
      recoveredValid: boolean; recoveredSequences: number[]; commitId: string; scope: ScopeRef;
      predecessorRecord: unknown; payload: { observation: string }; predecessorDigest: string; committedDigest: string; foundByCommitId: boolean; identicalRetry: boolean;
      idempotentBytesUnchanged: boolean; conflictName: string; conflictBytesUnchanged: boolean;
      nextSequence: number; nextPreviousDigest: string; replayCommitIds: (string | null)[];
      repeatedRecoveryValid: boolean; replayCount: number;
    };
    assert.equal(report.recoveredValid, true);
    assert.deepEqual(report.recoveredSequences, [1, 2]);
    assert.deepEqual(report.predecessorRecord, JSON.parse(JSON.stringify(predecessor)));
    assert.equal(report.commitId, input.commitId);
    assert.deepEqual(report.scope, scope);
    assert.deepEqual(report.payload, input.payload);
    assert.equal(report.predecessorDigest, predecessor.recordDigest);
    assert.ok(report.committedDigest.length > 0);
    assert.equal(report.foundByCommitId, true);
    assert.equal(report.identicalRetry, true);
    assert.equal(report.idempotentBytesUnchanged, true);
    assert.equal(report.conflictName, 'JournalCommitConflictError');
    assert.equal(report.conflictBytesUnchanged, true);
    assert.equal(report.nextSequence, 3);
    assert.equal(report.nextPreviousDigest, report.committedDigest);
    assert.deepEqual(report.replayCommitIds, [null, input.commitId, nextCommitId]);
    assert.equal(report.repeatedRecoveryValid, true);
    assert.equal(report.replayCount, 3);
    console.log(JSON.stringify({ fixturePath, writer: { pid: writer.pid, code: writer.code, signal: writer.signal, stdout: writer.stdout, stderr: writer.stderr }, consumer: { pid: consumer.pid, code: consumer.code, signal: consumer.signal }, result: report }));
  } finally {
    try {
      assert.ok(writer, 'writer child was never started');
      assert.equal(writer.signal === 'SIGKILL' || (writer.signal === null && writer.code !== null), true, 'writer child exit was not confirmed');
      if (consumer) assert.equal(consumer.signal === null && consumer.code !== null, true, 'consumer child exit was not confirmed');
    } finally {
      await rm(fixturePath, { recursive: true, force: true });
    }
  }
});
test('legacy v1 commit facts remain replayable after memory envelope support', async () => {
  const { journal, file } = await fixture();
  const scope = { organId: organ, taskId: task };
  const first = await journal.append({ commitId: 'legacy-job', kind: 'event', scope, payload: { step: 1 } });
  const legacyDigest = (await import('node:crypto')).createHash('sha256').update(JSON.stringify({
    kind: 'event',
    scope,
    checkpoint: null,
    payload: { step: 1 },
  })).digest('hex');
  const raw = JSON.parse(await readFile(file, 'utf8')) as { commitFactDigest: string };
  assert.equal(raw.commitFactDigest, `sha256:${legacyDigest}`);
  const replay = await journal.append({ commitId: 'legacy-job', kind: 'event', scope, payload: { step: 1 } });
  assert.equal(replay.seq, first.seq);
  assert.equal((await journal.verify()).valid, true);
});
test('memory envelope rejects cross-scope provenance before append', async () => {
  const { journal } = await fixture();
  const otherProject = 'project-b';
  const otherOrgan = id('organ', 'organ-b');
  const otherTask = id('task', 'task-b');
  const otherCycle = id('cycle', 'cycle-b');
  const source = {
    sourceRef: 'journal://project-b/source',
    sourceDigest: 'sha256:source-b',
    projectKey: otherProject,
    taskId: otherTask,
    cycleId: otherCycle,
    occurredAt: '2026-09-17T00:00:00Z',
    kind: 'checkpoint' as const,
    payloadRef: 'asset://payload-b',
  };

  await assert.rejects(
    journal.append({
      kind: 'event',
      scope: { organId: organ, taskId: task },
      memoryScope: { namespace: 'global', globalId: 'global' },
      memorySource: source,
      payload: { observed: true },
    }),
    JournalIntegrityError,
  );
  await assert.rejects(
    journal.append({
      kind: 'event',
      scope: { organId: organ, taskId: task },
      memoryScope: {
        namespace: 'global',
        globalId: 'global',
        sourceProjectKey: otherProject,
        sourceOrganId: otherOrgan,
      },
      memorySource: source,
      payload: { observed: true },
    }),
    JournalIntegrityError,
  );
});
test('global memory envelope permits omitted source project provenance', async () => {
  const { journal } = await fixture();
  const record = await journal.append({
    kind: 'event',
    scope: { organId: organ, taskId: task },
    memoryScope: { namespace: 'global', globalId: 'global' },
    memorySource: {
      sourceRef: 'journal://project-a/global-source',
      sourceDigest: 'sha256:global-source',
      projectKey: 'project-a',
      taskId: task,
      occurredAt: '2026-09-17T00:00:00Z',
      kind: 'checkpoint',
      payloadRef: 'asset://global-payload',
    },
    payload: { observed: true },
  });
  assert.deepEqual((await journal.replayMemory({ namespace: 'global', globalId: 'global' })).map((entry) => entry.seq), [record.seq]);
});
test('memory envelope rejects mismatched task and cycle scope kinds before append and verify', async () => {
  const { journal, file } = await fixture();
  const scope = { organId: organ, taskId: task, cycleId: cycle };
  const invalidTaskSource = {
    sourceRef: 'journal://project-a/invalid-task-scope',
    sourceDigest: 'sha256:invalid-task-scope',
    projectKey: 'project-a',
    taskId: { scope: 'organ', value: task.value },
    occurredAt: '2026-09-17T00:00:00Z',
    kind: 'checkpoint' as const,
    payloadRef: 'asset://invalid-task-scope',
  };
  await assert.rejects(
    journal.append({
      kind: 'event',
      scope,
      memoryScope: { namespace: 'global', globalId: 'global' },
      memorySource: invalidTaskSource as never,
      payload: { observed: true },
    }),
    JournalIntegrityError,
  );

  const valid = await journal.append({
    kind: 'event',
    scope,
    memoryScope: { namespace: 'global', globalId: 'global' },
    memorySource: {
      ...invalidTaskSource,
      taskId: task,
      cycleId: cycle,
      sourceRef: 'journal://project-a/valid-scope',
      sourceDigest: 'sha256:valid-scope',
    },
    payload: { observed: true },
  });
  const raw = JSON.parse(await readFile(file, 'utf8')) as {
    memorySource: { cycleId: { scope: string; value: string } };
    recordDigest: string;
  };
  raw.memorySource.cycleId = { scope: 'organ', value: cycle.value };
  const digest = (await import('node:crypto')).createHash('sha256').update(JSON.stringify({ ...raw, recordDigest: undefined })).digest('hex');
  await writeFile(file, `${JSON.stringify({ ...raw, recordDigest: `sha256:${digest}` })}\n`, 'utf8');
  const verified = await journal.verify();
  assert.equal(verified.valid, false);
  assert.match(verified.error!, /episodic cycleId|memory source cycle/);
  assert.equal(valid.seq, 1);
});
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

test('operation event publication commits before notification and survives restart replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-operation-event-'));
  const filePath = join(root, 'events.jsonl');
  const operation = id('operation', 'operation-publication');
  const scope = { organId: organ, taskId: task, cycleId: cycle, operationId: operation };
  const streamId = 'operation-events:task-a';
  const occurredAt = '2026-09-20T12:00:00.000Z';
  const publisherId = 'operation-publisher';
  const publisher: TrustedEventPublisher = {
    publisherId,
    kind: 'harness',
    ownerId: 'operation-owner',
    scope: { organId: organ },
    allowedClasses: ['control'],
    capabilities: ['event.publish.control'],
  };
  const journal = createJsonlEventPublicationJournal({ filePath });
  const notifications: string[] = [];
  let failNotification = true;
  const notification: OperationEventNotificationPort = {
    async notify(input: { readonly event: EventRecord }): Promise<OperationEventNotificationAck> {
      notifications.push(input.event.messageId);
      if (failNotification) throw new Error('notification transport failed');
      return { ackRef: `ack:${input.event.messageId}`, acknowledgedAt: occurredAt };
    },
  };
  const ports = {
    journal,
    publishers: {
      async resolvePublisher(publisherIdValue: string): Promise<TrustedEventPublisher | null> {
        return publisherIdValue === publisher.publisherId ? publisher : null;
      },
    },
  };
  const event = {
    eventId: 'operation-publication-event',
    schemaVersion: 1 as const,
    kind: 'operation.started' as const,
    operationId: operation,
    taskId: task,
    executionEpoch: 2,
    status: 'running' as const,
    occurredAt,
    evidenceRefs: [{
      evidenceId: id('evidence', 'operation-publication-evidence'),
      kind: 'operation' as const,
      source: 'journal-test',
      locator: 'operation-publication/evidence',
      scope,
    }],
  };

  try {
    await assert.rejects(
      () => publishOperationEvent(ports, notification, {
        publisherId,
        streamId,
        scope,
        event,
        currentEpoch: 2,
      }),
      (error: unknown) => (error as OperationEventPublicationError).code === 'notification-failed',
    );
    assert.deepEqual(notifications, ['operation-publication-event']);

    const restarted = createJsonlEventPublicationJournal({ filePath });
    const restartedPorts = {
      ...ports,
      journal: restarted,
    };
    const queried = await queryOperationEvents(restartedPorts, {
      streamId,
      operationId: operation,
      limit: 10,
    });
    assert.equal(queried.length, 1);

    failNotification = false;
    notifications.length = 0;
    const replayed = await replayOperationEventNotifications(
      restartedPorts,
      notification,
      { streamId, operationId: operation, limit: 10, currentEpoch: 2 },
    );
    assert.equal(replayed.length, 1);
    assert.deepEqual(notifications, ['operation-publication-event']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('operation event publication ignores checkpoint and ordinary journal records during replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-operation-event-mixed-'));
  const filePath = join(root, 'events.jsonl');
  const operation = id('operation', 'operation-publication-mixed');
  const scope = { organId: organ, taskId: task, cycleId: cycle, operationId: operation };
  const journal = createJsonlEventPublicationJournal({ filePath });
  const publisher: TrustedEventPublisher = {
    publisherId: 'operation-publisher',
    kind: 'harness',
    ownerId: 'operation-owner',
    scope: { organId: organ },
    allowedClasses: ['control'],
    capabilities: ['event.publish.control'],
  };
  const event = {
    eventId: 'operation-publication-mixed-event',
    schemaVersion: 1 as const,
    kind: 'operation.completed' as const,
    operationId: operation,
    taskId: task,
    executionEpoch: 1,
    status: 'succeeded' as const,
    occurredAt: '2026-09-20T12:00:00.000Z',
    outputRef: 'artifact://operation/mixed',
    outputDigest: 'sha256:mixed',
    evidenceRefs: [],
  };
  try {
    const baseJournal = new JsonlOrganJournal(filePath);
    await baseJournal.append({
      kind: 'checkpoint',
      scope: { organId: organ, taskId: task },
      checkpoint: checkpoint(1, null),
    });
    await baseJournal.append({
      kind: 'event',
      scope: { organId: organ, taskId: task },
      payload: { observed: true },
    });
    const ports = {
      journal,
      publishers: {
        async resolvePublisher(publisherId: string): Promise<TrustedEventPublisher | null> {
          return publisherId === publisher.publisherId ? publisher : null;
        },
      },
    };
    const notification: OperationEventNotificationPort = {
      async notify(input: { readonly event: EventRecord }): Promise<OperationEventNotificationAck> {
        return { ackRef: `ack:${input.event.messageId}`, acknowledgedAt: event.occurredAt };
      },
    };
    await publishOperationEvent(ports, notification, {
      publisherId: publisher.publisherId,
      streamId: 'operation-events:task-a',
      scope,
      event,
      currentEpoch: 1,
    });
    const restarted = createJsonlEventPublicationJournal({ filePath });
    const records = await queryOperationEvents({ journal: restarted }, {
      streamId: 'operation-events:task-a',
      operationId: operation,
      limit: 10,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.operation?.outputRef, event.outputRef);
    assert.equal(records[0]?.operation?.outputDigest, event.outputDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
