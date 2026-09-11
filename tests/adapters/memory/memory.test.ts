import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError, id, type MemoryScope } from '../../../packages/contracts/src/index.js';
import { DeterministicMemoryBackend } from '../../../packages/adapters/memory/src/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const taskScope: MemoryScope = { kind: 'task', organId: organ, taskId: task };

test('memory backend performs exact/full-text search, inspect, and compare', async () => {
  const memory = new DeterministicMemoryBackend();
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/1', sourceDigest: 'sha256:alpha', text: 'alpha protocol approved' });
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/2', sourceDigest: 'sha256:beta', text: 'beta protocol rejected' });

  assert.deepEqual(await memory.search({ scope: taskScope, query: 'alpha protocol approved', limit: 10 }), [{ sourceRef: 'journal://task-a/1', summary: 'alpha protocol approved' }]);
  assert.deepEqual(await memory.search({ scope: taskScope, query: 'protocol', limit: 10 }).then((rows) => rows.map((row) => row.sourceRef)), ['journal://task-a/1', 'journal://task-a/2']);
  assert.deepEqual(await memory.inspect({ sourceRef: 'journal://task-a/1' }), { sourceRef: 'journal://task-a/1', sourceDigest: 'sha256:alpha', text: 'alpha protocol approved' });
  assert.deepEqual(await memory.compare({ leftRef: 'journal://task-a/1', rightRef: 'journal://task-a/1' }), { relation: 'same' });
  assert.deepEqual(await memory.compare({ leftRef: 'journal://task-a/1', rightRef: 'journal://task-a/2' }), { relation: 'different' });
  assert.deepEqual(await memory.compare({ leftRef: 'journal://task-a/1', rightRef: 'missing' }), { relation: 'unknown' });
});

test('memory backend search, inspect, and context failures are explicit', async () => {
  const memory = new DeterministicMemoryBackend();
  await assert.rejects(memory.search({ scope: taskScope, query: '', limit: 1 }), ContractError);
  await assert.rejects(memory.search({ scope: taskScope, query: 'alpha', limit: 0 }), ContractError);
  await assert.rejects(memory.inspect({ sourceRef: 'missing' }), ContractError);
  await assert.rejects(memory.recall({ agentRuntimeId: 'runtime-a', roleId: 'memory', taskId: task, scope: taskScope, layers: ['current'], tokenBudget: -1, executionEpoch: 1, evidenceRequired: true }), ContractError);
});

test('memory backend detects novelty and recurrence', async () => {
  const memory = new DeterministicMemoryBackend();
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/known', sourceDigest: 'sha256:same', text: 'known failure mode' });
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/candidate-known', sourceDigest: 'sha256:same', text: 'known failure mode repeat' });
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/candidate-novel', sourceDigest: 'sha256:novel', text: 'brand new observation' });
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/recur-1', sourceDigest: 'sha256:r1', text: 'checkpoint settle timeout observed' });
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/recur-2', sourceDigest: 'sha256:r2', text: 'checkpoint settle timeout observed again' });

  assert.deepEqual(await memory.detectNovelty({ scope: taskScope, sourceRef: 'candidate-known', sourceDigest: 'sha256:same', candidateRef: 'journal://task-a/candidate-known', comparisonRefs: ['journal://task-a/known'], limit: 10 }), { classification: 'known', matchedRefs: ['journal://task-a/known'], reason: 'matching source digest' });
  assert.deepEqual(await memory.detectNovelty({ scope: taskScope, sourceRef: 'candidate-novel', sourceDigest: 'sha256:novel', candidateRef: 'journal://task-a/candidate-novel', comparisonRefs: ['journal://task-a/known'], limit: 10 }), { classification: 'novel', matchedRefs: [], reason: 'no matching source digest' });
  assert.deepEqual(await memory.detectNovelty({ scope: taskScope, sourceRef: 'missing', sourceDigest: 'sha256:missing', candidateRef: 'missing', comparisonRefs: ['journal://task-a/known'], limit: 10 }), { classification: 'unknown', matchedRefs: [], reason: 'candidate source unavailable' });
  assert.deepEqual(await memory.detectRecurrence({ scope: taskScope, patternRef: 'checkpoint settle timeout', windowRefs: ['journal://task-a/recur-1', 'journal://task-a/recur-2'], limit: 10 }).then((result) => result.classification), 'recurring');
  assert.deepEqual(await memory.detectRecurrence({ scope: taskScope, patternRef: 'missing pattern', windowRefs: ['journal://task-a/recur-1', 'journal://task-a/recur-2'], limit: 10 }), { classification: 'one-off', occurrences: [], reason: 'deterministic exact pattern count' });
});

test('context recall filters layers, enforces budget, and binds attach epoch', async () => {
  const memory = new DeterministicMemoryBackend();
  memory.addContextEntry({ scope: taskScope, sourceRef: 'journal://task-a/l0', sourceDigest: 'sha256:l0', text: 'directive', layer: 'current', summary: 'current summary' });
  memory.addContextEntry({ scope: taskScope, sourceRef: 'journal://task-a/l1', sourceDigest: 'sha256:l1', text: 'recent result', layer: 'task-recent', summary: 'recent summary' });
  memory.addContextEntry({ scope: taskScope, sourceRef: 'journal://task-a/l2', sourceDigest: 'sha256:l2', text: 'related history', layer: 'related', summary: 'related summary' });

  const current = await memory.recall({ agentRuntimeId: 'runtime-a', roleId: 'execution', taskId: task, scope: taskScope, layers: ['current'], query: 'directive', tokenBudget: 100, executionEpoch: 2, evidenceRequired: true });
  assert.equal(current.entries.length, 1);
  assert.equal(current.entries[0].layer, 'current');
  assert.equal(current.contextId, await memory.recall({ agentRuntimeId: 'runtime-a', roleId: 'execution', taskId: task, scope: taskScope, layers: ['current'], query: 'directive', tokenBudget: 100, executionEpoch: 2, evidenceRequired: true }).then((context) => context.contextId));

  const bounded = await memory.recall({ agentRuntimeId: 'runtime-a', roleId: 'execution', taskId: task, scope: taskScope, layers: ['current', 'task-recent'], tokenBudget: 3, executionEpoch: 2, evidenceRequired: true });
  assert.ok(bounded.entries.length >= 1);
  assert.ok(bounded.entries.reduce((total, entry) => total + entry.tokenCost, 0) <= 3);
  assert.ok(bounded.omitted.some((omitted) => omitted.reason === 'token-budget'));

  const attach = await memory.attach({ agentRuntimeId: 'runtime-a', context: bounded });
  assert.deepEqual(attach, { contextId: bounded.contextId, attached: true });
  await assert.rejects(memory.attach({ agentRuntimeId: 'runtime-a', context: { ...current, executionEpoch: 1 } }), ContractError);
});
