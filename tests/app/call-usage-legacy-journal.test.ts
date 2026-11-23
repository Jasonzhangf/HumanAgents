import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonlOrganJournal, type JournalRecord } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { createJournalCallUsageReader } from '../../packages/app/src/ui-runtime/call-usage-journal-read.js';
import { projectCallUsage } from '../../packages/app/src/ui-runtime/call-usage-read.js';
import { id } from '../../packages/contracts/src/index.js';

// Observed failure: old lifecycle closure blocks accounting. One in-memory
// consumer covers the dependency and scope boundary; original-file replay is
// recorded in 定稿复验/旧Journal计量绿测.json. No runtime resources are opened.
test('usage reads committed facts independently of lifecycle and isolates invalid accounting facts', async () => {
  const organId = id('organ', 'usage-organ');
  const turn = { organId, interactionScopeId: 'usage-scope', interactionId: 'one', inputRevision: 1, turnId: 'logical-turn' };
  const scope = { organId, operationId: id('operation', 'usage-operation') };
  const execution = { ...scope, runtimeId: 'usage-runtime', executionEpoch: 1, interactionTurn: turn };
  const request = { turnId: 'physical-turn', requestId: 'usage-request' };
  const records: JournalRecord[] = [];
  const push = (payload: Record<string, unknown>) => records.push({
    version: 1, seq: records.length + 1, kind: 'event', scope,
    commitId: `usage-test-${records.length}`, previousRecordDigest: null, recordDigest: 'fixture',
    payload: { kind: 'interaction-parent.turn-raw.v1', turn, execution, ...payload },
  });
  push({ discriminant: 'request', record: { request, scope, phase: 'dispatching' } });
  push({ discriminant: 'request', record: { request, scope, phase: 'settled' } });
  push({ discriminant: 'turn-execution-failure', fact: { legacy: true } });
  const journal = { replay: async () => records } as unknown as JsonlOrganJournal;
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const reader = createJournalCallUsageReader({ organId, interactionScopeId: turn.interactionScopeId, controlJournal: journal, parentJournal });
  const input = { projectKey: 'usage-project', mode: 'rcc' as const, interactionId: 'one' };
  const first = await reader.read(input);
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error(first.failure.message);
  assert.deepEqual(first.value, [{ callId: request.requestId, turnId: request.turnId }]);
  assert.equal(projectCallUsage(first.value).calls[0]?.inputTokens, null);
  assert.deepEqual(await reader.read(input), first, 'request phases and rereads do not double count');
  await assert.rejects(() => parentJournal.readTurnSnapshot(turn), /interaction parent/);

  push({ discriminant: 'accepted-fact', entry: { seq: 1, envelope: {
    execution: { runtimeId: execution.runtimeId, executionEpoch: 1 }, scope, request, producerSeq: 1,
    fact: { kind: 'usage', protocol: 'responses', inputTokens: -1,
      capacity: { state: 'unknown' }, timing: { startedAt: '2026-11-23T00:00:00Z', endedAt: '2026-11-23T00:00:01Z', scope: 'stream-observe-to-terminal' } },
  } } });
  const failed = await reader.read(input);
  assert.equal(failed.ok, false, 'invalid accounting facts must not become unknown or success');
  if (failed.ok) throw new Error('expected accounting failure');
  assert.equal(failed.failure.code, 'call-usage.journal-read-failed');
  assert.deepEqual(await reader.read({ ...input, interactionId: 'other' }), { ok: true, value: [] });
  assert.deepEqual(await reader.read({ ...input, interactionId: undefined, taskId: 'other-task' }), { ok: true, value: [] });
  const otherOrgan = createJournalCallUsageReader({ organId: id('organ', 'other'), interactionScopeId: turn.interactionScopeId, controlJournal: journal, parentJournal });
  assert.deepEqual(await otherOrgan.read(input), { ok: true, value: [] });
  const otherScope = createJournalCallUsageReader({ organId, interactionScopeId: 'other', controlJournal: journal, parentJournal });
  assert.deepEqual(await otherScope.read(input), { ok: true, value: [] });
});
