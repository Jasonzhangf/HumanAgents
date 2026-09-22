import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  ContractError,
  id,
  type CanonicalMemoryScope,
  type MemoryActorContext,
  type MemoryQueryRequest,
  type MemoryScope,
  type MemorySubmission,
} from '../../../packages/contracts/src/index.js';
import { ImmutableAssetStore } from '../../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import {
  DeterministicMemoryBackend,
  FilesystemMemoryPersistence,
  MemoryPersistenceError,
  RootedMemoryPersistence,
  type MemoryRebuildJournalRecord,
  type MemoryRebuildSource,
  type MemoryPersistencePort,
  type MemoryPersistenceSnapshot,
} from '../../../packages/adapters/memory/src/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const taskScope: MemoryScope = { kind: 'task', organId: organ, taskId: task };
const canonicalTaskScope: CanonicalMemoryScope = {
  namespace: 'project',
  projectKey: 'project-a',
  organId: organ,
  taskId: task,
};
const globalScope: MemoryScope = { kind: 'approved-global', organId: id('organ', 'global') };
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

test('memory backend rebuilds a deleted index from journal records and immutable assets', async () => {
  const sourceRef = 'journal://task-a/rebuild-source';
  const assetRef = 'asset://memory/rebuild-source';
  const assetText = 'rebuilt source content';
  const sourceDigest = `sha256:${createHash('sha256').update(assetText).digest('hex')}`;
  const journal: MemoryRebuildJournalRecord[] = [
    {
      seq: 1,
      memoryScope: {
        namespace: 'project',
        projectKey: 'project-a',
        organId: organ,
        taskId: task,
      },
      memorySource: {
        sourceRef,
        sourceDigest,
        projectKey: 'project-a',
        taskId: task,
        occurredAt: '2026-09-18T00:00:00Z',
        kind: 'checkpoint',
        payloadRef: assetRef,
      },
    },
  ];
  const sources: MemoryRebuildSource[] = [
    {
      sourceRef: assetRef,
      sourceDigest,
      text: assetText,
    },
  ];

  const memory = new DeterministicMemoryBackend();
  const rebuilt = await memory.rebuild({
    scope: taskScope,
    journal,
    sources,
  });

  assert.deepEqual(rebuilt, {
    scope: taskScope,
    rebuilt: 1,
    sourceRefs: [sourceRef],
    seqs: [1],
    digests: [sourceDigest],
  });
  assert.deepEqual(await memory.search({ scope: taskScope, query: 'rebuilt source', limit: 10 }), [
    { sourceRef, summary: assetText },
  ]);
  assert.deepEqual(await memory.inspect({ sourceRef }), {
    sourceRef,
    sourceDigest,
    text: assetText,
  });
  assert.deepEqual(await memory.compare({ leftRef: sourceRef, rightRef: sourceRef }), {
    relation: 'same',
  });
});

test('memory backend rebuilds an approved-global index with source provenance', async () => {
  const sourceRef = 'journal://global/rebuild-source';
  const assetRef = 'asset://memory/global-rebuild-source';
  const assetText = 'rebuilt global source content';
  const sourceDigest = `sha256:${createHash('sha256').update(assetText).digest('hex')}`;
  const rebuilt = await new DeterministicMemoryBackend().rebuild({
    scope: globalScope,
    journal: [{
      seq: 4,
      scope: { organId: organ },
      memoryScope: {
        namespace: 'global',
        globalId: 'global',
        sourceProjectKey: 'project-a',
        sourceOrganId: organ,
      },
      memorySource: {
        sourceRef,
        sourceDigest,
        projectKey: 'project-a',
        occurredAt: '2026-09-18T00:00:00Z',
        kind: 'checkpoint',
        payloadRef: assetRef,
      },
    }],
    sources: [{ sourceRef: assetRef, sourceDigest, text: assetText }],
  });

  assert.deepEqual(rebuilt, {
    scope: globalScope,
    rebuilt: 1,
    sourceRefs: [sourceRef],
    seqs: [4],
    digests: [sourceDigest],
  });
});

test('memory rebuild rejects global source provenance mismatches', async () => {
  const sourceRef = 'journal://global/rebuild-mismatch';
  const assetRef = 'asset://memory/global-rebuild-mismatch';
  const assetText = 'global mismatch source';
  const sourceDigest = `sha256:${createHash('sha256').update(assetText).digest('hex')}`;
  const journal = {
    seq: 5,
    scope: { organId: organ },
    memoryScope: {
      namespace: 'global' as const,
      globalId: 'global' as const,
      sourceProjectKey: 'project-a',
      sourceOrganId: organ,
    },
    memorySource: {
      sourceRef,
      sourceDigest,
      projectKey: 'project-a',
      occurredAt: '2026-09-18T00:00:00Z',
      kind: 'checkpoint' as const,
      payloadRef: assetRef,
    },
  };
  const sources = [{ sourceRef: assetRef, sourceDigest, text: assetText }];

  await assert.rejects(
    new DeterministicMemoryBackend().rebuild({
      scope: globalScope,
      journal: [{
        ...journal,
        memorySource: { ...journal.memorySource, projectKey: 'project-b' },
      }],
      sources,
    }),
    ContractError,
  );
  await assert.rejects(
    new DeterministicMemoryBackend().rebuild({
      scope: globalScope,
      journal: [{
        ...journal,
        scope: { organId: id('organ', 'organ-b') },
      }],
      sources,
    }),
    ContractError,
  );
});

test('memory rebuild rejects a source ref that belongs to another scope without changing persisted state', async () => {
  const otherTask = id('task', 'task-b');
  const otherScope: MemoryScope = { kind: 'task', organId: organ, taskId: otherTask };
  const sourceRef = 'journal://shared/source';
  const existingText = 'scope a source';
  const existingDigest = `sha256:${createHash('sha256').update(existingText).digest('hex')}`;
  const rebuildText = 'scope b source';
  const rebuildDigest = `sha256:${createHash('sha256').update(rebuildText).digest('hex')}`;
  const snapshots: MemoryPersistenceSnapshot[] = [];
  const persistence: MemoryPersistencePort = {
    async load() {
      return undefined;
    },
    async save(snapshot) {
      snapshots.push(snapshot);
    },
  };
  const memory = new DeterministicMemoryBackend(persistence);
  await memory.ingest({
    scope: taskScope,
    sourceRef,
    sourceDigest: existingDigest,
    text: existingText,
  });
  const before = snapshots.at(-1);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(before?.records, [{
    scope: taskScope,
    sourceRef,
    sourceDigest: existingDigest,
    text: existingText,
  }]);
  assert.deepEqual(before?.sourceLocks, [{
    sourceRef,
    sourceDigest: existingDigest,
    scope: taskScope,
  }]);

  await assert.rejects(
    memory.rebuild({
      scope: otherScope,
      journal: [{
        seq: 1,
        memoryScope: {
          namespace: 'project',
          projectKey: 'project-a',
          organId: organ,
          taskId: otherTask,
        },
        memorySource: {
          sourceRef,
          sourceDigest: rebuildDigest,
          projectKey: 'project-a',
          taskId: otherTask,
          occurredAt: '2026-09-18T00:00:00Z',
          kind: 'checkpoint',
          payloadRef: 'asset://memory/shared-source',
        },
      }],
      sources: [{
        sourceRef: 'asset://memory/shared-source',
        sourceDigest: rebuildDigest,
        text: rebuildText,
      }],
    }),
    ContractError,
  );

  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], before);
  assert.deepEqual(await memory.inspect({ sourceRef }), {
    sourceRef,
    sourceDigest: existingDigest,
    text: existingText,
  });
  assert.deepEqual(await memory.search({ scope: taskScope, query: 'scope a', limit: 10 }), [{
    sourceRef,
    summary: existingText,
  }]);
  assert.deepEqual(await memory.search({ scope: otherScope, query: 'scope b', limit: 10 }), []);
});

test('memory rebuild rejects journal and asset drift explicitly', async () => {
  const sourceRef = 'journal://task-a/rebuild-drift';
  const assetRef = 'asset://memory/rebuild-drift';
  const assetText = 'drifted';
  const sourceDigest = `sha256:${createHash('sha256').update(assetText).digest('hex')}`;
  const memory = new DeterministicMemoryBackend();

  await assert.rejects(
    memory.rebuild({
      scope: taskScope,
      journal: [{
        seq: 1,
        memoryScope: {
          namespace: 'project',
          projectKey: 'project-a',
          organId: organ,
          taskId: task,
        },
        memorySource: {
          sourceRef,
          sourceDigest,
          projectKey: 'project-a',
          taskId: task,
          occurredAt: '2026-09-18T00:00:00Z',
          kind: 'checkpoint',
          payloadRef: assetRef,
        },
      }],
      sources: [{
        sourceRef: assetRef,
        sourceDigest: 'sha256:different',
        text: 'drifted',
      }],
    }),
    ContractError,
  );

  await assert.rejects(
    memory.rebuild({
      scope: taskScope,
      journal: [{
        seq: 2,
        memoryScope: {
          namespace: 'project',
          projectKey: 'project-a',
          organId: organ,
          taskId: task,
        },
        memorySource: {
          sourceRef,
          sourceDigest,
          projectKey: 'project-a',
          taskId: task,
          occurredAt: '2026-09-18T00:00:00Z',
          kind: 'checkpoint',
          payloadRef: assetRef,
        },
      }],
      sources: [],
    }),
    ContractError,
  );
});

test('memory rebuild reconstructs a deleted persisted index from real journal and immutable asset files', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-rebuild-'));
  const journalFile = join(root, 'journal', 'memory.jsonl');
  const assetRoot = join(root, 'assets');
  const snapshotFile = join(root, 'memory', 'snapshot.json');
  const assetText = 'journal backed rebuild content';
  const assetRef = 'asset://memory/journal-backed';
  const sourceRef = 'journal://task-a/journal-backed';
  const sourceDigest = `sha256:${createHash('sha256').update(assetText).digest('hex')}`;

  const assets = new ImmutableAssetStore(assetRoot);
  const asset = await assets.write('journal-backed', new TextEncoder().encode(assetText));
  const journal = new JsonlOrganJournal(journalFile);
  const record = await journal.append({
    kind: 'event',
    scope: { organId: organ, taskId: task },
    memoryScope: {
      namespace: 'project',
      projectKey: 'project-a',
      organId: organ,
      taskId: task,
    },
    memorySource: {
      sourceRef,
      sourceDigest,
      projectKey: 'project-a',
      taskId: task,
      occurredAt: '2026-09-18T00:00:00Z',
      kind: 'checkpoint',
      payloadRef: assetRef,
    },
    payload: { observed: true },
  });
  const journalBefore = await readFile(journalFile, 'utf8');
  const assetBefore = await readFile(asset.locator);

  const persistence = new FilesystemMemoryPersistence(snapshotFile);
  const first = new DeterministicMemoryBackend(persistence);
  await first.rebuild({
    scope: taskScope,
    journal: await journal.replayMemory({
      namespace: 'project',
      projectKey: 'project-a',
      organId: organ,
      taskId: task,
    }),
    sources: [{
      sourceRef: assetRef,
      sourceDigest,
      text: new TextDecoder().decode(await assets.read({
        assetId: asset.assetId,
        digest: asset.digest,
        locator: asset.locator,
        size: asset.size,
      })),
    }],
  });
  assert.deepEqual(await first.inspect({ sourceRef }), {
    sourceRef,
    sourceDigest,
    text: assetText,
  });

  await rm(snapshotFile, { force: true });
  const restarted = await DeterministicMemoryBackend.fromPersistence(persistence);
  assert.deepEqual(await restarted.search({ scope: taskScope, query: 'journal backed', limit: 10 }), []);

  const rebuilt = await restarted.rebuild({
    scope: taskScope,
    journal: await journal.replayMemory({
      namespace: 'project',
      projectKey: 'project-a',
      organId: organ,
      taskId: task,
    }),
    sources: [{
      sourceRef: assetRef,
      sourceDigest,
      text: new TextDecoder().decode(await assets.read({
        assetId: asset.assetId,
        digest: asset.digest,
        locator: asset.locator,
        size: asset.size,
      })),
    }],
  });
  assert.deepEqual(rebuilt, {
    scope: taskScope,
    rebuilt: 1,
    sourceRefs: [sourceRef],
    seqs: [record.seq],
    digests: [sourceDigest],
  });
  assert.deepEqual(await restarted.search({ scope: taskScope, query: 'journal backed', limit: 10 }), [{
    sourceRef,
    summary: assetText,
  }]);
  assert.deepEqual(await restarted.inspect({ sourceRef }), {
    sourceRef,
    sourceDigest,
    text: assetText,
  });
  assert.equal(await readFile(journalFile, 'utf8'), journalBefore);
  assert.deepEqual(await readFile(asset.locator), assetBefore);
  await rm(root, { recursive: true, force: true });
});

test('memory rebuild persistence failure leaves the existing index unchanged', async () => {
  const sourceText = 'existing source';
  const sourceDigest = `sha256:${createHash('sha256').update(sourceText).digest('hex')}`;
  const memory = new DeterministicMemoryBackend();
  await memory.ingest({
    scope: taskScope,
    sourceRef: 'journal://task-a/existing',
    sourceDigest,
    text: sourceText,
  });

  let failSave = true;
  const persistence: MemoryPersistencePort = {
    async load() {
      return undefined;
    },
    async save() {
      if (failSave) throw new MemoryPersistenceError(
        'memory-persistence-io-failure',
        'injected rebuild save failure',
        { kind: 'recover', ref: 'memory-persistence-adapter' },
      );
    },
  };
  const failing = new DeterministicMemoryBackend(persistence);
  await failing.ingest({
    scope: taskScope,
    sourceRef: 'journal://task-a/existing',
    sourceDigest,
    text: sourceText,
  }).catch(() => undefined);
  await failing.ingest({
    scope: taskScope,
    sourceRef: 'journal://task-a/existing',
    sourceDigest,
    text: sourceText,
  }).catch(() => undefined);
  failSave = false;
  await failing.ingest({
    scope: taskScope,
    sourceRef: 'journal://task-a/existing',
    sourceDigest,
    text: sourceText,
  });
  failSave = true;

  const rebuildText = 'rebuild replacement';
  const rebuildDigest = `sha256:${createHash('sha256').update(rebuildText).digest('hex')}`;
  await assert.rejects(
    failing.rebuild({
      scope: taskScope,
      journal: [{
        seq: 1,
        memoryScope: {
          namespace: 'project',
          projectKey: 'project-a',
          organId: organ,
          taskId: task,
        },
        memorySource: {
          sourceRef: 'journal://task-a/replacement',
          sourceDigest: rebuildDigest,
          projectKey: 'project-a',
          taskId: task,
          occurredAt: '2026-09-18T00:00:00Z',
          kind: 'checkpoint',
          payloadRef: 'asset://memory/replacement',
        },
      }],
      sources: [{
        sourceRef: 'asset://memory/replacement',
        sourceDigest: rebuildDigest,
        text: rebuildText,
      }],
    }),
    MemoryPersistenceError,
  );
  assert.deepEqual(await failing.search({ scope: taskScope, query: 'existing', limit: 10 }), [{
    sourceRef: 'journal://task-a/existing',
    summary: sourceText,
  }]);
  await assert.rejects(failing.inspect({ sourceRef: 'journal://task-a/replacement' }), ContractError);
});

test('memory query can resolve a canonical record by exact source ref', async () => {
  const memory = new DeterministicMemoryBackend();
  await memory.ingest({
    scope: taskScope,
    sourceRef: 'journal://task-a/source',
    sourceDigest: 'sha256:source',
    text: 'source content',
  });
  await memory.addCanonicalRecord({
    memoryId: 'memory-source',
    namespace: 'project',
    projectKey: 'project-a',
    kind: 'semantic',
    state: 'approved',
    summary: 'summary does not contain the source ref',
    sourceRefs: ['journal://task-a/source'],
    sourceDigests: ['sha256:source'],
    taskId: task,
    sourceScopeRef: 'task:organ-a:task-a',
    relevanceReason: 'exact source',
  });

  const queried = await memory.query(memoryQuery({ query: 'journal://task-a/source' }));
  assert.equal(queried.entries.length, 1);
  assert.equal(queried.entries[0]?.memoryId, 'memory-source');
});

test('memory backend search, inspect, and context failures are explicit', async () => {
  const memory = new DeterministicMemoryBackend();
  await assert.rejects(memory.search({ scope: taskScope, query: '', limit: 1 }), ContractError);
  await assert.rejects(memory.search({ scope: taskScope, query: 'alpha', limit: 0 }), ContractError);
  await assert.rejects(memory.inspect({ sourceRef: 'missing' }), ContractError);
  await assert.rejects(memory.recall({ agentRuntimeId: 'runtime-a', roleId: 'memory', taskId: task, scope: canonicalTaskScope, layers: ['current'], tokenBudget: -1, executionEpoch: 1, evidenceRequired: true }), ContractError);
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

  const current = await memory.recall({ agentRuntimeId: 'runtime-a', roleId: 'execution', taskId: task, scope: canonicalTaskScope, layers: ['current'], query: 'directive', tokenBudget: 100, executionEpoch: 2, evidenceRequired: true });
  assert.equal(current.entries.length, 1);
  assert.equal(current.entries[0].layer, 'current');
  assert.equal(current.contextId, await memory.recall({ agentRuntimeId: 'runtime-a', roleId: 'execution', taskId: task, scope: canonicalTaskScope, layers: ['current'], query: 'directive', tokenBudget: 100, executionEpoch: 2, evidenceRequired: true }).then((context) => context.contextId));

  const bounded = await memory.recall({ agentRuntimeId: 'runtime-a', roleId: 'execution', taskId: task, scope: canonicalTaskScope, layers: ['current', 'task-recent'], tokenBudget: 3, executionEpoch: 2, evidenceRequired: true });
  assert.ok(bounded.entries.length >= 1);
  assert.ok(bounded.entries.reduce((total, entry) => total + entry.tokenCost, 0) <= 3);
  assert.ok(bounded.omitted.some((omitted) => omitted.reason === 'token-budget'));

  const attach = await memory.attach({ agentRuntimeId: 'runtime-a', context: bounded });
  assert.deepEqual(attach, { contextId: bounded.contextId, attached: true });
  await assert.rejects(memory.attach({ agentRuntimeId: 'runtime-a', context: { ...current, executionEpoch: 1 } }), ContractError);
});

test('approved canonical memory is recalled into the approved-long-term layer of a later task', async () => {
  const memory = new DeterministicMemoryBackend();
  const laterTask = id('task', 'task-later');
  const laterScope: CanonicalMemoryScope = { namespace: 'project', projectKey: 'project-a', organId: organ, taskId: laterTask };
  await memory.ingest({
    scope: taskScope,
    sourceRef: 'journal://task-a/approved-fact',
    sourceDigest: 'sha256:approved-fact',
    text: 'approved long-term fact',
  });
  await memory.addCanonicalRecord({
    memoryId: 'memory-approved-fact',
    namespace: 'project',
    projectKey: 'project-a',
    kind: 'semantic',
    state: 'approved',
    summary: 'approved long-term fact',
    sourceRefs: ['journal://task-a/approved-fact'],
    sourceDigests: ['sha256:approved-fact'],
    taskId: task,
    sourceScopeRef: 'project-a:task-a',
    relevanceReason: 'approved in an earlier task',
  });
  await memory.addCanonicalRecord({
    memoryId: 'memory-other-project',
    namespace: 'project',
    projectKey: 'project-b',
    kind: 'semantic',
    state: 'approved',
    summary: 'approved long-term fact',
    sourceRefs: ['journal://task-a/approved-fact'],
    sourceDigests: ['sha256:approved-fact'],
    taskId: laterTask,
    sourceScopeRef: 'project-b:task-later',
    relevanceReason: 'belongs to another project',
  });

  const withoutLayer = await memory.recall({ agentRuntimeId: 'runtime-later', roleId: 'execution', taskId: laterTask, scope: laterScope, layers: ['current'], tokenBudget: 100, executionEpoch: 1, evidenceRequired: true });
  assert.equal(withoutLayer.entries.length, 0);

  const recalled = await memory.recall({ agentRuntimeId: 'runtime-later', roleId: 'execution', taskId: laterTask, scope: laterScope, layers: ['current', 'approved-long-term'], tokenBudget: 100, executionEpoch: 1, evidenceRequired: true });
  assert.deepEqual(recalled.entries, [{
    layer: 'approved-long-term',
    summary: 'approved long-term fact',
    sourceRef: 'memory-approved-fact',
    sourceDigest: `sha256:${createHash('sha256').update('approved long-term fact').digest('hex')}`,
    scope: `project:project-a:${organ.value}:${laterTask.value}`,
    tokenCost: 3,
  }]);
  assert.deepEqual(await memory.attach({ agentRuntimeId: 'runtime-later', context: recalled }), { contextId: recalled.contextId, attached: true });
});

test('rejected and superseded canonical records never enter the approved-long-term recall', async () => {
  const memory = new DeterministicMemoryBackend();
  await memory.ingest({
    scope: taskScope,
    sourceRef: 'journal://task-a/rejected-fact',
    sourceDigest: 'sha256:rejected-fact',
    text: 'rejected long-term fact',
  });
  for (const [memoryId, state] of [['memory-rejected', 'rejected'], ['memory-superseded', 'superseded']] as const) {
    await memory.addCanonicalRecord({
      memoryId,
      namespace: 'project',
      projectKey: 'project-a',
      kind: 'semantic',
      state,
      summary: 'rejected long-term fact',
      sourceRefs: ['journal://task-a/rejected-fact'],
      sourceDigests: ['sha256:rejected-fact'],
      taskId: task,
      sourceScopeRef: 'project-a:task-a',
      relevanceReason: 'must not take effect',
    });
  }

  const recalled = await memory.recall({ agentRuntimeId: 'runtime-later', roleId: 'execution', taskId: task, scope: canonicalTaskScope, layers: ['current', 'approved-long-term'], tokenBudget: 100, executionEpoch: 1, evidenceRequired: true });
  assert.deepEqual(recalled.entries, []);
});

test('memory backend filters task ids exactly and keeps forgetting atomic', async () => {
  const memory = new DeterministicMemoryBackend();
  const taskAB = id('task', 'task-ab');
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://project-a/1', sourceDigest: 'sha256:a', text: 'fact a' });
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://project-a/2', sourceDigest: 'sha256:ab', text: 'fact ab' });
  await memory.addCanonicalRecord({
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
  await memory.addCanonicalRecord({
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
  const approvalRef = 'approval://global-promotion';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:candidate-a', text: 'checkpoint commit is durable' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:evidence-a', text: 'checkpoint evidence' });
  await memory.ingest({ scope: taskScope, sourceRef: promotionRef, sourceDigest: 'sha256:promotion-a', text: 'global promotion approval' });
  await memory.ingest({ scope: taskScope, sourceRef: approvalRef, sourceDigest: 'sha256:approval-a', text: 'global promotion approval receipt' });

  const submission: MemorySubmission = {
    submissionId: 'submission-a',
    requestId: 'request-a',
    operationId: id('operation', 'submission-a'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
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
    approvalRef,
    approvalDigest: 'sha256:approval-a',
    sourceRefs: [promotionRef],
    sourceDigests: ['sha256:promotion-a'],
    promotedAt: '2026-09-17T00:00:00Z',
  });
  const promoted = await memory.query(memoryQuery({
    actor: { ...actor, crossProjectGrantRef: 'grant://global-read' },
    namespace: 'global',
    taskId: undefined,
    states: ['active'],
    query: 'checkpoint commit is durable',
  }));
  assert.deepEqual(promoted.entries[0]?.sourceRefs, [contentRef, evidenceRef, approvalRef, promotionRef]);
  assert.deepEqual(promoted.entries[0]?.sourceDigests, ['sha256:candidate-a', 'sha256:evidence-a', 'sha256:approval-a', 'sha256:promotion-a']);
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
    candidateCategory: 'project-fact',
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

  await assert.rejects(memory.promoteCandidate({
    candidateId: submitted.candidateId!,
    from: 'project',
    to: 'global',
    actor: { ...actor, roleId: 'review' },
    reason: 'failed approval must not become promotable',
    impactScope: 'all projects',
    approvalRef: 'approval://missing',
    approvalDigest: 'sha256:missing',
    sourceRefs: [],
    sourceDigests: [],
    promotedAt: '2026-09-17T00:00:00Z',
  }), ContractError);
});

test('approval deduplicates content provenance repeated in evidence refs', async () => {
  const memory = new DeterministicMemoryBackend();
  const contentRef = 'asset://memory/candidate-deduplicated';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:candidate-deduplicated', text: 'deduplicated approval source' });
  const submitted = await memory.submitCandidate({
    submissionId: 'submission-deduplicated',
    requestId: 'request-deduplicated',
    operationId: id('operation', 'submission-deduplicated'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef,
    contentDigest: 'sha256:candidate-deduplicated',
    evidenceRefs: [contentRef],
    observation: 'deduplicated approval source',
    desiredScope: 'project',
    reason: 'producer must match persistence invariants',
    inputDigest: 'sha256:submission-deduplicated',
  });
  await memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'content and evidence share one source',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [contentRef],
  });
  const queried = await memory.query(memoryQuery({ query: 'deduplicated approval source' }));
  assert.deepEqual(queried.entries[0]?.sourceRefs, [contentRef]);
  assert.deepEqual(queried.entries[0]?.sourceDigests, ['sha256:candidate-deduplicated']);
});

test('promotion rejects an unresolvable approval source without changing canonical state', async () => {
  const memory = new DeterministicMemoryBackend();
  const contentRef = 'asset://memory/candidate-approval';
  const evidenceRef = 'journal://project-a/evidence-approval';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:candidate-approval', text: 'promotion requires approval evidence' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:evidence-approval', text: 'promotion evidence' });
  const submitted = await memory.submitCandidate({
    submissionId: 'submission-approval',
    requestId: 'request-approval',
    operationId: id('operation', 'submission-approval'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef,
    contentDigest: 'sha256:candidate-approval',
    evidenceRefs: [evidenceRef],
    observation: 'promotion requires approval evidence',
    desiredScope: 'project',
    reason: 'test missing approval source',
    inputDigest: 'sha256:submission-approval',
  });
  await memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'project evidence is complete',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  });

  await assert.rejects(memory.promoteCandidate({
    candidateId: submitted.candidateId!,
    from: 'project',
    to: 'global',
    actor: { ...actor, roleId: 'review' },
    reason: 'invalid promotion attempt',
    impactScope: 'all projects',
    approvalRef: 'approval://missing',
    approvalDigest: 'sha256:missing',
    sourceRefs: [],
    sourceDigests: [],
    promotedAt: '2026-09-17T00:00:00Z',
  }), ContractError);

  const project = await memory.query(memoryQuery({ query: 'promotion requires approval evidence' }));
  assert.equal(project.entries[0]?.state, 'approved');
  const global = await memory.query(memoryQuery({
    actor: { ...actor, crossProjectGrantRef: 'grant://global-read' },
    namespace: 'global',
    taskId: undefined,
    states: ['active'],
    query: 'promotion requires approval evidence',
  }));
  assert.deepEqual(global.entries, []);
});

test('final reviews cannot overwrite approved canonical state', async () => {
  const memory = new DeterministicMemoryBackend();
  const contentRef = 'asset://memory/candidate-final-review';
  const evidenceRef = 'journal://project-a/evidence-final-review';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:candidate-final-review', text: 'review is final' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:evidence-final-review', text: 'final review evidence' });
  const submitted = await memory.submitCandidate({
    submissionId: 'submission-final-review',
    requestId: 'request-final-review',
    operationId: id('operation', 'submission-final-review'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef,
    contentDigest: 'sha256:candidate-final-review',
    evidenceRefs: [evidenceRef],
    observation: 'review is final',
    desiredScope: 'project',
    reason: 'test final review state',
    inputDigest: 'sha256:submission-final-review',
  });
  const approve = {
    candidateId: submitted.candidateId!,
    decision: 'approve' as const,
    actor: { ...actor, roleId: 'review' as const },
    decisionReason: 'evidence is complete',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  };
  await memory.reviewCandidate(approve);
  await assert.rejects(memory.reviewCandidate({
    ...approve,
    decision: 'reject',
    decisionReason: 'attempt to overwrite final review',
  }), ContractError);

  const queried = await memory.query(memoryQuery({ query: 'review is final' }));
  assert.equal(queried.entries[0]?.state, 'approved');
});

test('final promotions cannot overwrite global provenance', async () => {
  const memory = new DeterministicMemoryBackend();
  const contentRef = 'asset://memory/candidate-final-promotion';
  const evidenceRef = 'journal://project-a/evidence-final-promotion';
  const firstApprovalRef = 'approval://global-final-promotion-first';
  const secondApprovalRef = 'approval://global-final-promotion-second';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:candidate-final-promotion', text: 'promotion is final' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:evidence-final-promotion', text: 'promotion evidence' });
  await memory.ingest({ scope: taskScope, sourceRef: firstApprovalRef, sourceDigest: 'sha256:approval-first', text: 'first approval' });
  await memory.ingest({ scope: taskScope, sourceRef: secondApprovalRef, sourceDigest: 'sha256:approval-second', text: 'second approval' });
  const submitted = await memory.submitCandidate({
    submissionId: 'submission-final-promotion',
    requestId: 'request-final-promotion',
    operationId: id('operation', 'submission-final-promotion'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef,
    contentDigest: 'sha256:candidate-final-promotion',
    evidenceRefs: [evidenceRef],
    observation: 'promotion is final',
    desiredScope: 'project',
    reason: 'test final promotion state',
    inputDigest: 'sha256:submission-final-promotion',
  });
  await memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'project evidence is complete',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  });
  const promotion = {
    candidateId: submitted.candidateId!,
    from: 'project' as const,
    to: 'global' as const,
    actor: { ...actor, roleId: 'review' as const },
    reason: 'stable across projects',
    impactScope: 'all projects',
    approvalRef: firstApprovalRef,
    approvalDigest: 'sha256:approval-first',
    sourceRefs: [],
    sourceDigests: [],
    promotedAt: '2026-09-17T00:00:00Z',
  };
  await memory.promoteCandidate(promotion);
  await assert.rejects(memory.promoteCandidate({
    ...promotion,
    approvalRef: secondApprovalRef,
    approvalDigest: 'sha256:approval-second',
    reason: 'attempt to replace global provenance',
  }), ContractError);

  const promoted = await memory.query(memoryQuery({
    actor: { ...actor, crossProjectGrantRef: 'grant://global-read' },
    namespace: 'global',
    taskId: undefined,
    states: ['active'],
    query: 'promotion is final',
  }));
  assert.deepEqual(promoted.entries[0]?.sourceRefs, [contentRef, evidenceRef, firstApprovalRef]);
});

test('promotion creates an independent global record and preserves the project record', async () => {
  const memory = new DeterministicMemoryBackend();
  const contentRef = 'asset://memory/candidate-independent';
  const evidenceRef = 'journal://project-a/evidence-independent';
  const approvalRef = 'approval://global-independent';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:candidate-independent', text: 'independent global record' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:evidence-independent', text: 'independent evidence' });
  await memory.ingest({ scope: taskScope, sourceRef: approvalRef, sourceDigest: 'sha256:approval-independent', text: 'independent approval' });

  const submitted = await memory.submitCandidate({
    submissionId: 'submission-independent',
    requestId: 'request-independent',
    operationId: id('operation', 'submission-independent'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef,
    contentDigest: 'sha256:candidate-independent',
    evidenceRefs: [evidenceRef],
    observation: 'independent global record',
    desiredScope: 'project',
    reason: 'test independent promotion',
    inputDigest: 'sha256:submission-independent',
  });
  await memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'project record approved',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  });
  await memory.promoteCandidate({
    candidateId: submitted.candidateId!,
    from: 'project',
    to: 'global',
    actor: { ...actor, roleId: 'review' },
    reason: 'independent global promotion',
    impactScope: 'all projects',
    approvalRef,
    approvalDigest: 'sha256:approval-independent',
    sourceRefs: [],
    sourceDigests: [],
    promotedAt: '2026-09-17T00:00:00Z',
  });

  const project = await memory.query(memoryQuery({ query: 'independent global record', states: ['approved'] }));
  const global = await memory.query(memoryQuery({
    actor: { ...actor, crossProjectGrantRef: 'grant://global-read' },
    namespace: 'global',
    taskId: undefined,
    states: ['active'],
    query: 'independent global record',
  }));
  assert.equal(project.entries.length, 1);
  assert.equal(global.entries.length, 1);
  assert.equal(project.entries[0]?.memoryId, `memory-candidate:${submitted.candidateId}`);
  assert.equal(global.entries[0]?.memoryId, `global:memory-candidate:${submitted.candidateId}`);
  assert.notEqual(project.entries[0]?.memoryId, global.entries[0]?.memoryId);
});

test('memory backend persists and reloads canonical state without losing review or provenance', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-restart-'));
  const persistence = new FilesystemMemoryPersistence(join(root, 'memory.json'));
  const memory = new DeterministicMemoryBackend(persistence);
  const contentRef = 'asset://memory/persisted';
  const evidenceRef = 'journal://project-a/persisted-evidence';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:persisted', text: 'persisted memory fact' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:persisted-evidence', text: 'persisted evidence' });
  const submitted = await memory.submitCandidate({
    submissionId: 'submission-persisted',
    requestId: 'request-persisted',
    operationId: id('operation', 'submission-persisted'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef,
    contentDigest: 'sha256:persisted',
    evidenceRefs: [evidenceRef],
    observation: 'persisted memory fact',
    desiredScope: 'project',
    reason: 'restart recovery test',
    inputDigest: 'sha256:submission-persisted',
  });
  await memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'approved before restart',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  });

  const restarted = await DeterministicMemoryBackend.fromPersistence(persistence);
  const queried = await restarted.query(memoryQuery({ query: 'persisted memory fact' }));
  assert.equal(queried.entries.length, 1);
  assert.equal(queried.entries[0]?.state, 'approved');
  assert.deepEqual(queried.entries[0]?.sourceDigests, ['sha256:persisted', 'sha256:persisted-evidence']);
  assert.deepEqual(await restarted.inspect({ sourceRef: contentRef }), {
    sourceRef: contentRef,
    sourceDigest: 'sha256:persisted',
    text: 'persisted memory fact',
  });
  await rm(root, { recursive: true, force: true });
});

test('memory persistence preserves submission cycle identity across restart', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-cycle-'));
  const persistence = new FilesystemMemoryPersistence(join(root, 'memory.json'));
  const cycle = id('cycle', 'cycle-a');
  const memory = new DeterministicMemoryBackend(persistence);
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/cycle-source', sourceDigest: 'sha256:cycle-source', text: 'cycle scoped source' });
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/cycle-evidence', sourceDigest: 'sha256:cycle-evidence', text: 'cycle scoped evidence' });
  await memory.submitCandidate({
    submissionId: 'submission-cycle',
    requestId: 'request-cycle',
    operationId: id('operation', 'submission-cycle'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    cycleId: cycle,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef: 'journal://task-a/cycle-source',
    contentDigest: 'sha256:cycle-source',
    evidenceRefs: ['journal://task-a/cycle-evidence'],
    observation: 'cycle scoped source',
    desiredScope: 'project',
    reason: 'cycle identity persistence test',
    inputDigest: 'sha256:submission-cycle',
  });

  const restarted = await DeterministicMemoryBackend.fromPersistence(persistence);
  await restarted.reviewCandidate({
    candidateId: 'submission-cycle',
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'cycle identity remains intact',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: ['journal://task-a/cycle-evidence'],
  });
  const snapshot = await persistence.load();
  assert.deepEqual(snapshot?.candidates[0]?.submission.cycleId, cycle);
  await rm(root, { recursive: true, force: true });
});

test('source locks reject drift after restart and persistence snapshots round-trip', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-lock-'));
  const file = join(root, 'memory.json');
  const persistence = new FilesystemMemoryPersistence(file);
  const memory = new DeterministicMemoryBackend(persistence);
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/locked', sourceDigest: 'sha256:locked', text: 'locked source' });
  await assert.rejects(
    memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/locked', sourceDigest: 'sha256:drift', text: 'drifted source' }),
    ContractError,
  );

  const restarted = await DeterministicMemoryBackend.fromPersistence(persistence);
  await assert.rejects(
    restarted.ingest({ scope: taskScope, sourceRef: 'journal://task-a/locked', sourceDigest: 'sha256:drift', text: 'drifted source' }),
    ContractError,
  );
  const raw = JSON.parse(await readFile(file, 'utf8')) as MemoryPersistenceSnapshot;
  assert.equal(raw.version, 1);
  assert.equal(raw.records[0]?.sourceRef, 'journal://task-a/locked');
  assert.equal(raw.sourceLocks[0]?.sourceDigest, 'sha256:locked');
  await rm(root, { recursive: true, force: true });
});

test('memory persistence loads legacy records without rebuild seq metadata', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-legacy-snapshot-'));
  const file = join(root, 'memory.json');
  const legacy = {
    version: 1,
    revision: 1,
    records: [{
      scope: taskScope,
      sourceRef: 'journal://task-a/legacy',
      sourceDigest: 'sha256:legacy',
      text: 'legacy source',
    }],
    canonicalRecords: [],
    candidates: [],
    candidateIds: [],
    forgettingPlans: [],
    sourceLocks: [{
      sourceRef: 'journal://task-a/legacy',
      sourceDigest: 'sha256:legacy',
      scope: taskScope,
    }],
    attachedEpochs: [],
    attachedContextIds: [],
  };
  await writeFile(file, `${JSON.stringify(legacy)}\n`, 'utf8');

  const persistence = new FilesystemMemoryPersistence(file);
  const memory = await DeterministicMemoryBackend.fromPersistence(persistence);
  assert.deepEqual(await memory.search({ scope: taskScope, query: 'legacy source', limit: 10 }), [{
    sourceRef: 'journal://task-a/legacy',
    summary: 'legacy source',
  }]);
  assert.equal((await persistence.load())?.records[0]?.seq, undefined);
  await rm(root, { recursive: true, force: true });
});

test('filesystem memory persistence rejects corrupt snapshots and atomically replaces prior state', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-persistence-'));
  const file = join(root, 'memory.json');
  const persistence = new FilesystemMemoryPersistence(file);
  await writeFile(file, '{"version":1,"records":[]}\n', 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  const store: MemoryPersistencePort = {
    snapshot: undefined,
    async load() { return this.snapshot; },
    async save(snapshot) { this.snapshot = snapshot; },
  } as MemoryPersistencePort & { snapshot?: MemoryPersistenceSnapshot };
  const backend = new DeterministicMemoryBackend(store);
  await backend.ingest({ scope: taskScope, sourceRef: 'journal://task-a/first', sourceDigest: 'sha256:first', text: 'first' });
  await backend.ingest({ scope: taskScope, sourceRef: 'journal://task-a/second', sourceDigest: 'sha256:second', text: 'second' });
  const snapshot = await store.load();
  assert.equal(snapshot?.records.length, 2);
  assert.equal(snapshot?.sourceLocks.length, 2);
  await rm(root, { recursive: true, force: true });
});

test('filesystem memory persistence rejects malformed nested state and dangling references', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-invalid-state-'));
  const file = join(root, 'memory.json');
  const persistence = new FilesystemMemoryPersistence(file);
  const valid = {
    version: 1,
    revision: 1,
    records: [{
      scope: taskScope,
      sourceRef: 'journal://task-a/valid',
      sourceDigest: 'sha256:valid',
      text: 'valid source',
    }],
    canonicalRecords: [],
    candidates: [],
    candidateIds: [],
    forgettingPlans: [],
    sourceLocks: [{
      sourceRef: 'journal://task-a/valid',
      sourceDigest: 'sha256:valid',
      scope: taskScope,
    }],
    attachedEpochs: [],
    attachedContextIds: [],
  };

  await writeFile(file, `${JSON.stringify({ ...valid, records: [null] })}\n`, 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  await writeFile(file, `${JSON.stringify({
    ...valid,
    sourceLocks: [{
      sourceRef: 'journal://task-a/valid',
      sourceDigest: 'sha256:drifted',
      scope: taskScope,
    }],
  })}\n`, 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  await writeFile(file, `${JSON.stringify({
    ...valid,
    candidateIds: [{ candidateId: 'candidate-dangling', submissionId: 'missing-submission' }],
  })}\n`, 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  await writeFile(file, `${JSON.stringify({
    ...valid,
    attachedContextIds: [{ agentRuntimeId: 'runtime-without-epoch', contextId: 'context-a' }],
  })}\n`, 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  await writeFile(file, `${JSON.stringify({
    ...valid,
    canonicalRecords: [{
      memoryId: 'canonical-dangling-source',
      namespace: 'project',
      projectKey: 'project-a',
      kind: 'semantic',
      state: 'approved',
      summary: 'dangling canonical provenance',
      sourceRefs: ['journal://task-a/missing'],
      sourceDigests: ['sha256:missing'],
      taskId: task,
      sourceScopeRef: 'project-a:task-a',
      relevanceReason: 'snapshot invariant test',
    }],
  })}\n`, 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  await writeFile(file, `${JSON.stringify({
    ...valid,
    canonicalRecords: [{
      memoryId: 'canonical-duplicate-source',
      namespace: 'project',
      projectKey: 'project-a',
      kind: 'semantic',
      state: 'approved',
      summary: 'duplicate canonical provenance',
      sourceRefs: ['journal://task-a/valid', 'journal://task-a/valid'],
      sourceDigests: ['sha256:valid', 'sha256:valid'],
      taskId: task,
      sourceScopeRef: 'project-a:task-a',
      relevanceReason: 'snapshot invariant test',
    }],
  })}\n`, 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  await writeFile(file, `${JSON.stringify({
    ...valid,
    canonicalRecords: [{
      memoryId: 'canonical-digest-mismatch',
      namespace: 'project',
      projectKey: 'project-a',
      kind: 'semantic',
      state: 'approved',
      summary: 'mismatched canonical provenance',
      sourceRefs: ['journal://task-a/valid'],
      sourceDigests: ['sha256:tampered'],
      taskId: task,
      sourceScopeRef: 'project-a:task-a',
      relevanceReason: 'snapshot invariant test',
    }],
  })}\n`, 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  await writeFile(file, `${JSON.stringify({
    ...valid,
    candidates: [{
      submission: {
        submissionId: 'submission-inconsistent',
        requestId: 'request-inconsistent',
        operationId: id('operation', 'submission-inconsistent'),
        bindingRef: 'binding-a',
        actor,
        projectKey: 'project-a',
        taskId: task,
        requestedKind: 'semantic',
        candidateCategory: 'project-fact',
        contentRef: 'journal://task-a/valid',
        contentDigest: 'sha256:valid',
        evidenceRefs: ['journal://task-a/valid'],
        observation: 'invalid candidate state',
        desiredScope: 'project',
        reason: 'snapshot invariant test',
        inputDigest: 'sha256:submission-inconsistent',
      },
      candidateId: 'submission-inconsistent',
      state: 'approved',
    }],
    candidateIds: [{ candidateId: 'submission-inconsistent', submissionId: 'submission-inconsistent' }],
  })}\n`, 'utf8');
  await assert.rejects(
    persistence.load(),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-snapshot-invalid',
  );

  await rm(root, { recursive: true, force: true });
});

test('filesystem memory persistence rejects stale writers without losing the committed update', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-cas-'));
  const file = join(root, 'memory.json');
  const firstPersistence = new FilesystemMemoryPersistence(file);
  const secondPersistence = new FilesystemMemoryPersistence(file);
  const first = new DeterministicMemoryBackend(firstPersistence);
  const second = new DeterministicMemoryBackend(secondPersistence);

  await first.ingest({ scope: taskScope, sourceRef: 'journal://task-a/first', sourceDigest: 'sha256:first', text: 'first' });
  await second.reload();
  await second.ingest({ scope: taskScope, sourceRef: 'journal://task-a/second', sourceDigest: 'sha256:second', text: 'second' });
  await assert.rejects(
    first.ingest({ scope: taskScope, sourceRef: 'journal://task-a/stale', sourceDigest: 'sha256:stale', text: 'stale' }),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-conflict',
  );

  const committed = await firstPersistence.load();
  assert.deepEqual(committed?.records.map((record) => record.sourceRef), [
    'journal://task-a/first',
    'journal://task-a/second',
  ]);
  assert.equal(committed?.revision, 2);

  await first.ingest({ scope: taskScope, sourceRef: 'journal://task-a/recovered', sourceDigest: 'sha256:recovered', text: 'recovered' });
  const recovered = await firstPersistence.load();
  assert.deepEqual(recovered?.records.map((record) => record.sourceRef), [
    'journal://task-a/first',
    'journal://task-a/second',
    'journal://task-a/recovered',
  ]);
  assert.equal(recovered?.revision, 3);

  await rm(root, { recursive: true, force: true });
});

test('same backend serializes concurrent mutations without losing either update', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-concurrent-'));
  const persistence = new FilesystemMemoryPersistence(join(root, 'memory.json'));
  const memory = new DeterministicMemoryBackend(persistence);

  await Promise.all([
    memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/concurrent-first', sourceDigest: 'sha256:concurrent-first', text: 'first concurrent source' }),
    memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/concurrent-second', sourceDigest: 'sha256:concurrent-second', text: 'second concurrent source' }),
  ]);

  const snapshot = await persistence.load();
  assert.equal(snapshot?.revision, 2);
  assert.deepEqual(snapshot?.records.map((record) => record.sourceRef), [
    'journal://task-a/concurrent-first',
    'journal://task-a/concurrent-second',
  ]);
  await rm(root, { recursive: true, force: true });
});

test('rooted persistence isolates project and global partitions and recovers a transaction', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-rooted-'));
  const roots = {
    project: join(root, 'project'),
    global: join(root, 'global'),
  };
  const persistence = new RootedMemoryPersistence(roots);
  const memory = await DeterministicMemoryBackend.fromPersistence(persistence);
  const contentRef = 'asset://memory/rooted-candidate';
  const evidenceRef = 'journal://project-a/rooted-evidence';
  const approvalRef = 'approval://rooted-promotion';
  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:rooted-candidate', text: 'rooted project memory' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:rooted-evidence', text: 'rooted evidence' });
  const submitted = await memory.submitCandidate({
    submissionId: 'submission-rooted',
    requestId: 'request-rooted',
    operationId: id('operation', 'submission-rooted'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef,
    contentDigest: 'sha256:rooted-candidate',
    evidenceRefs: [evidenceRef],
    observation: 'rooted project memory',
    desiredScope: 'project',
    reason: 'root isolation test',
    inputDigest: 'sha256:submission-rooted',
  });
  await memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'approved before promotion',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  });

  const projectFile = join(roots.project, 'snapshot.json');
  const globalFile = join(roots.global, 'snapshot.json');
  const projectBeforePromotion = JSON.parse(await readFile(projectFile, 'utf8')) as MemoryPersistenceSnapshot;
  const globalBeforePromotion = JSON.parse(await readFile(globalFile, 'utf8')) as MemoryPersistenceSnapshot;
  assert.equal(projectBeforePromotion.canonicalRecords.length, 1);
  assert.equal(projectBeforePromotion.candidates.length, 1);
  assert.equal(globalBeforePromotion.canonicalRecords.length, 0);
  assert.equal(globalBeforePromotion.candidates.length, 0);

  await memory.ingest({ scope: taskScope, sourceRef: approvalRef, sourceDigest: 'sha256:rooted-promotion', text: 'rooted promotion approval' });
  await memory.promoteCandidate({
    candidateId: submitted.candidateId!,
    from: 'project',
    to: 'global',
    actor: { ...actor, roleId: 'review' },
    reason: 'rooted global promotion',
    impactScope: 'all projects',
    approvalRef,
    approvalDigest: 'sha256:rooted-promotion',
    sourceRefs: [],
    sourceDigests: [],
    promotedAt: '2026-09-17T00:00:00Z',
  });

  const projectAfterPromotion = JSON.parse(await readFile(projectFile, 'utf8')) as MemoryPersistenceSnapshot;
  const globalAfterPromotion = JSON.parse(await readFile(globalFile, 'utf8')) as MemoryPersistenceSnapshot;
  assert.equal(projectAfterPromotion.candidates.length, 1);
  assert.equal(projectAfterPromotion.records.some((record) => record.sourceRef === approvalRef), false);
  assert.equal(projectAfterPromotion.sourceLocks.some((lock) => lock.sourceRef === approvalRef), false);
  assert.equal(globalAfterPromotion.candidates.length, 0);
  assert.deepEqual(globalAfterPromotion.canonicalRecords.map((record) => record.namespace), ['global']);
  assert.equal(globalAfterPromotion.records.some((record) => record.sourceRef === approvalRef), true);

  const walRef = 'journal://task-a/rooted-wal';
  const projectRevision = projectAfterPromotion.revision + 1;
  const globalRevision = globalAfterPromotion.revision + 1;
  await writeFile(join(roots.project, 'snapshot.transaction.json'), `${JSON.stringify({
    version: 1,
    revision: Math.max(projectRevision, globalRevision),
    projectRevision,
    globalRevision,
    project: {
      ...projectAfterPromotion,
      revision: projectRevision,
      records: [...projectAfterPromotion.records, {
        scope: taskScope,
        sourceRef: walRef,
        sourceDigest: 'sha256:rooted-wal',
        text: 'rooted WAL source',
      }],
      sourceLocks: [...projectAfterPromotion.sourceLocks, {
        sourceRef: walRef,
        sourceDigest: 'sha256:rooted-wal',
        scope: taskScope,
      }],
    },
    global: {
      ...globalAfterPromotion,
      revision: globalRevision,
    },
  })}\n`, 'utf8');

  const recovered = await new RootedMemoryPersistence(roots).load();
  assert.equal(recovered?.records.some((record) => record.sourceRef === walRef), true);
  await assert.rejects(readFile(join(roots.project, 'snapshot.transaction.json'), 'utf8'), (error: unknown) => (error as { code?: string }).code === 'ENOENT');
  await rm(root, { recursive: true, force: true });
});

test('rooted persistence rejects stale writers and filesystem roots', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-rooted-cas-'));
  const roots = {
    project: join(root, 'project'),
    global: join(root, 'global'),
  };
  const firstPersistence = new RootedMemoryPersistence(roots);
  const secondPersistence = new RootedMemoryPersistence(roots);
  const first = await DeterministicMemoryBackend.fromPersistence(firstPersistence);
  const second = await DeterministicMemoryBackend.fromPersistence(secondPersistence);

  await first.ingest({ scope: taskScope, sourceRef: 'journal://task-a/rooted-first', sourceDigest: 'sha256:rooted-first', text: 'first rooted source' });
  await second.reload();
  await second.ingest({ scope: taskScope, sourceRef: 'journal://task-a/rooted-second', sourceDigest: 'sha256:rooted-second', text: 'second rooted source' });
  await assert.rejects(
    first.ingest({ scope: taskScope, sourceRef: 'journal://task-a/rooted-stale', sourceDigest: 'sha256:rooted-stale', text: 'stale rooted source' }),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-conflict',
  );
  const committed = await firstPersistence.load();
  assert.deepEqual(committed?.records.map((record) => record.sourceRef), [
    'journal://task-a/rooted-first',
    'journal://task-a/rooted-second',
  ]);

  assert.throws(
    () => new RootedMemoryPersistence({ project: '/', global: roots.global }),
    (error: unknown) => error instanceof MemoryPersistenceError && error.code === 'memory-persistence-path-invalid',
  );
  await rm(root, { recursive: true, force: true });
});

test('canonical record insertion is durable across restart', async () => {
  const root = await mkdtemp(join('/private/tmp', 'humanagent-memory-canonical-'));
  const persistence = new FilesystemMemoryPersistence(join(root, 'memory.json'));
  const memory = new DeterministicMemoryBackend(persistence);
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/canonical', sourceDigest: 'sha256:canonical', text: 'canonical source' });
  await memory.addCanonicalRecord({
    memoryId: 'memory-canonical',
    namespace: 'project',
    projectKey: 'project-a',
    kind: 'semantic',
    state: 'approved',
    summary: 'canonical source',
    sourceRefs: ['journal://task-a/canonical'],
    sourceDigests: ['sha256:canonical'],
    taskId: task,
    sourceScopeRef: 'project-a:task-a',
    relevanceReason: 'canonical persistence test',
  });

  const restarted = await DeterministicMemoryBackend.fromPersistence(persistence);
  const queried = await restarted.query(memoryQuery({ query: 'canonical source' }));
  assert.equal(queried.entries.length, 1);
  assert.equal(queried.entries[0]?.memoryId, 'memory-canonical');
  await rm(root, { recursive: true, force: true });
});

test('canonical record insertion rejects missing or mismatched provenance in memory-only mode', async () => {
  const memory = new DeterministicMemoryBackend();
  await memory.ingest({ scope: taskScope, sourceRef: 'journal://task-a/canonical-valid', sourceDigest: 'sha256:canonical-valid', text: 'canonical valid source' });

  await assert.rejects(
    memory.addCanonicalRecord({
      memoryId: 'memory-missing-source',
      namespace: 'project',
      projectKey: 'project-a',
      kind: 'semantic',
      state: 'approved',
      summary: 'missing source',
      sourceRefs: ['journal://task-a/missing'],
      sourceDigests: ['sha256:missing'],
      taskId: task,
      sourceScopeRef: 'project-a:task-a',
      relevanceReason: 'provenance validation test',
    }),
    ContractError,
  );
  await assert.rejects(
    memory.addCanonicalRecord({
      memoryId: 'memory-mismatched-source',
      namespace: 'project',
      projectKey: 'project-a',
      kind: 'semantic',
      state: 'approved',
      summary: 'mismatched source',
      sourceRefs: ['journal://task-a/canonical-valid'],
      sourceDigests: ['sha256:mismatched'],
      taskId: task,
      sourceScopeRef: 'project-a:task-a',
      relevanceReason: 'provenance validation test',
    }),
    ContractError,
  );
  assert.deepEqual((await memory.query(memoryQuery({ query: 'missing source' }))).entries, []);
});

test('persistence failures do not expose uncommitted memory mutations', async () => {
  let snapshot: MemoryPersistenceSnapshot | undefined;
  let failNextSave = false;
  const persistence: MemoryPersistencePort = {
    async load() {
      return snapshot;
    },
    async save(next) {
      if (failNextSave) {
        failNextSave = false;
        throw new MemoryPersistenceError(
          'memory-persistence-io-failure',
          'injected memory persistence failure',
          { kind: 'recover', ref: 'memory-persistence-adapter' },
        );
      }
      snapshot = next;
    },
  };
  const memory = new DeterministicMemoryBackend(persistence);
  const contentRef = 'asset://memory/uncommitted';
  const evidenceRef = 'journal://project-a/uncommitted-evidence';

  failNextSave = true;
  await assert.rejects(
    memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:uncommitted', text: 'uncommitted source' }),
    MemoryPersistenceError,
  );
  await assert.rejects(memory.inspect({ sourceRef: contentRef }), ContractError);

  await memory.ingest({ scope: taskScope, sourceRef: contentRef, sourceDigest: 'sha256:uncommitted', text: 'uncommitted source' });
  await memory.ingest({ scope: taskScope, sourceRef: evidenceRef, sourceDigest: 'sha256:uncommitted-evidence', text: 'uncommitted evidence' });
  const submitted = await memory.submitCandidate({
    submissionId: 'submission-uncommitted',
    requestId: 'request-uncommitted',
    operationId: id('operation', 'submission-uncommitted'),
    bindingRef: 'binding-a',
    actor,
    projectKey: 'project-a',
    taskId: task,
    requestedKind: 'semantic',
    candidateCategory: 'project-fact',
    contentRef,
    contentDigest: 'sha256:uncommitted',
    evidenceRefs: [evidenceRef],
    observation: 'uncommitted source',
    desiredScope: 'project',
    reason: 'persistence failure test',
    inputDigest: 'sha256:submission-uncommitted',
  });

  failNextSave = true;
  await assert.rejects(memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'approve',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'must not persist after a failed save',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  }), MemoryPersistenceError);
  assert.deepEqual((await memory.query(memoryQuery({ query: 'uncommitted source' }))).entries, []);

  await memory.reload();
  await memory.reviewCandidate({
    candidateId: submitted.candidateId!,
    decision: 'reject',
    actor: { ...actor, roleId: 'review' },
    decisionReason: 'reloaded state remains a candidate',
    decidedAt: '2026-09-17T00:00:00Z',
    evidenceRefs: [evidenceRef],
  });
  assert.deepEqual((await memory.query(memoryQuery({ query: 'uncommitted source' }))).entries, []);
});
