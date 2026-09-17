import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  type MemoryActorContext,
  type MemoryQueryRequest,
  type MemoryScope,
  type MemorySubmission,
} from '../../../packages/contracts/src/index.js';
import { DeterministicMemoryBackend } from '../../../packages/adapters/memory/src/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const taskScope: MemoryScope = { kind: 'task', organId: organ, taskId: task };
const actor: MemoryActorContext = {
  actorId: 'actor-a',
  roleId: 'memory',
  permissions: ['memory.read', 'memory.propose', 'memory.review', 'memory.promote', 'memory.forget'],
  projectKey: 'project-a',
};

function memoryQuery(overrides: Partial<MemoryQueryRequest> = {}): MemoryQueryRequest {
  return {
    requestId: 'query-a',
    operationId: id('operation', 'query-a'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    namespace: 'project',
    taskId: task,
    query: 'fact',
    kinds: ['semantic'],
    states: ['approved', 'active'],
    limit: 10,
    tokenBudget: 100,
    inputDigest: 'sha256:query-a',
    ...overrides,
  };
}

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

test('memory backend filters task ids exactly and keeps forgetting atomic', async () => {
  const memory = new DeterministicMemoryBackend();
  const taskAB = id('task', 'task-ab');
  memory.addCanonicalRecord({
    memoryId: 'memory-a',
    namespace: 'project',
    projectKey: 'project-a',
    kind: 'semantic',
    state: 'approved',
    summary: 'fact a',
    sourceRefs: ['journal://project-a/1'],
    sourceDigests: ['sha256:a'],
    taskId: task,
    sourceScopeRef: 'project-a:task-a',
    relevanceReason: 'test',
  });
  memory.addCanonicalRecord({
    memoryId: 'memory-ab',
    namespace: 'project',
    projectKey: 'project-a',
    kind: 'semantic',
    state: 'approved',
    summary: 'fact ab',
    sourceRefs: ['journal://project-a/2'],
    sourceDigests: ['sha256:ab'],
    taskId: taskAB,
    sourceScopeRef: 'project-a:task-ab',
    relevanceReason: 'test',
  });

  const queried = await memory.query(memoryQuery());
  assert.deepEqual(queried.entries.map((entry) => entry.memoryId), ['memory-a']);

  const plan = {
    planId: 'forget-a',
    namespace: 'project' as const,
    projectKey: 'project-a',
    actions: [
      { memoryId: 'memory-a', action: 'archive' as const, reason: 'retention', sourceRefs: ['journal://project-a/1'] },
      { memoryId: 'missing-memory', action: 'archive' as const, reason: 'retention', sourceRefs: ['journal://project-a/3'] },
    ],
    protectedRefs: [],
    createdAt: '2026-09-17T00:00:00Z',
  };
  await assert.rejects(
    memory.planForgetting({ actor, plan }),
    ContractError,
  );
  const unchanged = await memory.query(memoryQuery());
  assert.equal(unchanged.entries[0].state, 'approved');
});

test('approved and promoted records preserve per-reference provenance digests', async () => {
  const memory = new DeterministicMemoryBackend();
  const contentRef = 'asset://memory/candidate-a';
  const evidenceRef = 'journal://project-a/evidence';
  const promotionRef = 'journal://project-a/promotion-approval';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:candidate-a', text: 'checkpoint commit is durable' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:evidence-a', text: 'checkpoint evidence' });
  await memory.ingest({ scope: taskScope, sourceRef: promotionRef, sourceDigest: 'sha256:promotion-a', text: 'global promotion approval' });

  const submission: MemorySubmission = {
    submissionId: 'submission-a',
    requestId: 'request-a',
    operationId: id('operation', 'submission-a'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    contentRef,
    contentDigest: 'sha256:candidate-a',
    evidenceRefs: [evidenceRef],
    observation: 'checkpoint commit is durable',
    desiredScope: 'project',
    reason: 'observed at a lifecycle boundary',
    inputDigest: 'sha256:submission-a',
  };
  const submitted = await memory.submitCandidate(submission);
  assert.equal(submitted.candidateId, 'submission-a');

  await memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'evidence is complete',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  });
  const approved = await memory.query(memoryQuery({ query: 'checkpoint commit is durable' }));
  assert.deepEqual(approved.entries[0]?.sourceRefs, [contentRef, evidenceRef]);
  assert.deepEqual(approved.entries[0]?.sourceDigests, ['sha256:candidate-a', 'sha256:evidence-a']);

  await memory.promoteCandidate({
    candidateId: submitted.candidateId!,
    from: 'project',
    to: 'global',
    actor: { ...actor, roleId: 'review' },
    reason: 'stable across projects',
    impactScope: 'all projects',
    approvalRef: 'approval://global-promotion',
    sourceRefs: [promotionRef],
    promotedAt: '2026-09-17T00:00:00Z',
  });
  const promoted = await memory.query(memoryQuery({
    actor: { ...actor, crossProjectGrantRef: 'grant://global-read' },
    namespace: 'global',
    taskId: undefined,
    states: ['active'],
    query: 'checkpoint commit is durable',
  }));
  assert.deepEqual(promoted.entries[0]?.sourceRefs, [contentRef, evidenceRef, promotionRef]);
  assert.deepEqual(promoted.entries[0]?.sourceDigests, ['sha256:candidate-a', 'sha256:evidence-a', 'sha256:promotion-a']);
});

test('approval rejects evidence without a resolvable digest', async () => {
  const memory = new DeterministicMemoryBackend();
  const submitted = await memory.submitCandidate({
    submissionId: 'submission-missing-evidence',
    requestId: 'request-missing-evidence',
    operationId: id('operation', 'submission-missing-evidence'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    contentRef: 'asset://memory/candidate-missing-evidence',
    contentDigest: 'sha256:candidate-missing-evidence',
    evidenceRefs: ['journal://project-a/missing'],
    observation: 'unverified observation',
    desiredScope: 'project',
    reason: 'missing evidence must not become canonical',
    inputDigest: 'sha256:submission-missing-evidence',
  });

  await assert.rejects(memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'invalid approval attempt',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: ['journal://project-a/missing'],
  }), ContractError);
  const queried = await memory.query(memoryQuery({ query: 'unverified observation' }));
  assert.deepEqual(queried.entries, []);
});
