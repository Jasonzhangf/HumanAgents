import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContext,
  ContextCache,
  ContextCacheError,
  ContextCommitError,
  ContextCommitter,
  ContextIndex,
  ContextIndexError,
  ContextPrepareError,
  ContextPublishError,
  groupToolMessages,
  mapToolResult,
  pruneEffectivePath,
} from '../../../packages/runtime/src/context/index.js';

test('ContextIndex bounds entries and refreshes recently used keys', () => {
  const index = new ContextIndex<string>(2);
  index.set('a', 'first');
  index.set('b', 'second');
  assert.equal(index.get('a'), 'first');
  index.set('c', 'third');

  assert.equal(index.size, 2);
  assert.equal(index.has('a'), true);
  assert.equal(index.has('b'), false);
  assert.deepEqual(index.keys(), ['a', 'c']);
  assert.deepEqual(index.snapshot(), [
    { key: 'a', value: 'first' },
    { key: 'c', value: 'third' },
  ]);
  assert.throws(() => new ContextIndex(0), ContextIndexError);
});

test('ContextCache separates binding fingerprints and permission revisions', () => {
  const cache = new ContextCache<string>();
  cache.set('binding-a', 1, 'one');
  cache.set('binding-a', 2, 'two');
  cache.set('binding-b', 1, 'other');

  assert.equal(cache.get('binding-a', 1), 'one');
  assert.equal(cache.get('binding-a', 2), 'two');
  assert.equal(cache.get('binding-b', 1), 'other');
  assert.equal(cache.delete('binding-a', 1), true);
  assert.equal(cache.get('binding-a', 1), undefined);
  assert.equal(cache.size, 2);
  assert.throws(() => cache.get('', 1), ContextCacheError);
});

test('ContextCache key encoding does not collide on embedded separators', () => {
  const cache = new ContextCache<string>();
  cache.set('a\u0000b', 'c', 'first');
  cache.set('a', 'b\u0000c', 'second');

  assert.notEqual(
    ContextCache.key('a\u0000b', 'c'),
    ContextCache.key('a', 'b\u0000c'),
  );
  assert.equal(cache.get('a\u0000b', 'c'), 'first');
  assert.equal(cache.get('a', 'b\u0000c'), 'second');
  assert.equal(cache.size, 2);
});

test('buildContext keeps stable, indexed, dynamic, and repair layers ordered', () => {
  const built = buildContext({
    stablePrefix: ['system'],
    indexRefs: ['index-1'],
    dynamicHead: ['user'],
    repairRefs: ['repair'],
  });

  assert.deepEqual(built.messages, ['system', 'index-1', 'user', 'repair']);
  assert.deepEqual(built.stablePrefix, ['system']);
  assert.deepEqual(built.indexRefs, ['index-1']);
  assert.deepEqual(built.dynamicHead, ['user']);
  assert.deepEqual(built.repairRefs, ['repair']);
});

test('pruneEffectivePath removes failed subtrees and keeps successful paths', () => {
  assert.deepEqual(
    pruneEffectivePath(
      ['/repo/a', '/repo/a/file.ts', '/repo/b', '/repo/b/file.ts', '/repo/c'],
      ['/repo/a'],
      ['/repo/b'],
    ),
    ['/repo/b', '/repo/b/file.ts'],
  );

  assert.deepEqual(
    pruneEffectivePath(['/repo/a', '/repo/b'], ['/repo/a/file.ts'], []),
    ['/repo/a', '/repo/b'],
  );
  assert.deepEqual(
    pruneEffectivePath(['/repo/a', '/repo/b'], [], ['/repo/a/file.ts']),
    ['/repo/a'],
  );
  assert.throws(
    () => pruneEffectivePath(['relative'], [], []),
    ContextIndexError,
  );
});

test('groupToolMessages pairs calls and results and preserves unmatched entries', () => {
  const callA = { toolCallId: 'a', name: 'read' };
  const callB = { id: 'b', name: 'write' };
  const resultB = { toolCallId: 'b', content: 'ok' };
  const resultC = { id: 'c', content: 'orphan' };

  assert.deepEqual(groupToolMessages([callA, callB], [resultB, resultC]), [
    { id: 'a', call: callA },
    { id: 'b', call: callB, result: resultB },
    { id: 'c', result: resultC },
  ]);
  assert.throws(
    () => groupToolMessages([callA, callA], []),
    ContextIndexError,
  );
});

test('mapToolResult separates business and control values', () => {
  const success = mapToolResult({ business: { text: 'ok' }, control: { retry: false } });
  assert.deepEqual(success, {
    business: { text: 'ok' },
    control: { retry: false },
    reason: undefined,
    failed: false,
  });

  const failure = mapToolResult({
    business: { text: 'denied' },
    control: { retry: true },
    reason: 'permission denied',
  });
  assert.equal(failure.failed, true);
  assert.equal(failure.reason, 'permission denied');
  assert.throws(() => mapToolResult({ business: 'x', reason: ' ' }), ContextIndexError);
});

test('ContextCommitter enforces prepare, commit, publish order', async () => {
  const events: string[] = [];
  const committer = new ContextCommitter<string>({
    commit: (context) => {
      events.push(`commit:${context.id}`);
    },
    publish: (context) => events.push(`publish:${context.id}`),
  });

  const prepared = committer.prepare({ id: 'view-1', revision: 7, value: 'view' });
  assert.deepEqual(prepared, {
    id: 'view-1',
    revision: 7,
    value: 'view',
    state: 'prepared',
  });
  assert.equal(committer.state('view-1'), 'prepared');

  const committed = await committer.commit(prepared);
  assert.equal(committed.state, 'committed');
  assert.equal(committer.state('view-1'), 'committed');
  assert.deepEqual(await committer.commit('view-1'), committed);
  assert.deepEqual(await committer.commit(prepared), committed);
  assert.equal(committer.state('view-1'), 'committed');

  const published = committer.publish('view-1');
  assert.equal(published.state, 'published');
  assert.equal(committer.state('view-1'), 'published');
  await assert.rejects(() => committer.commit('view-1'), ContextCommitError);
  assert.equal(committer.state('view-1'), 'published');
  assert.throws(() => committer.publish('view-1'), ContextPublishError);
  assert.deepEqual(events, ['commit:view-1', 'publish:view-1']);
});

test('ContextCommitter rejects duplicate and unknown contexts', async () => {
  const committer = new ContextCommitter<number>();
  committer.prepare({ id: 'view-1', value: 1 });
  assert.throws(() => committer.prepare({ id: 'view-1', value: 2 }), ContextPrepareError);
  await assert.rejects(() => committer.commit('missing'), ContextCommitError);
  assert.throws(() => committer.publish('missing'), ContextPublishError);
});

test('ContextCommitter keeps a prepared context retryable when commit fails', async () => {
  let attempts = 0;
  const committer = new ContextCommitter<string>({
    commit: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('commit failed');
    },
  });
  const prepared = committer.prepare({ id: 'view-1', value: 'view' });

  await assert.rejects(() => committer.commit(prepared), Error);
  assert.equal(committer.state('view-1'), 'prepared');

  const committed = await committer.commit(prepared);
  assert.equal(committed.state, 'committed');
  assert.equal(committer.state('view-1'), 'committed');
  assert.equal(attempts, 2);
});

test('ContextCommitter returns the existing committed result for the same identity', async () => {
  let attempts = 0;
  const committer = new ContextCommitter<string>({
    commit: () => {
      attempts += 1;
    },
  });
  const prepared = committer.prepare({ id: 'view-1', revision: 7, value: 'view' });

  const committed = await committer.commit(prepared);
  assert.deepEqual(await committer.commit('view-1'), committed);
  assert.deepEqual(await committer.commit(prepared), committed);
  assert.equal(committer.state('view-1'), 'committed');
  assert.equal(attempts, 1);
});

test('ContextCommitter rejects conflicting values on an idempotent retry', async () => {
  const committer = new ContextCommitter<string>();
  const prepared = committer.prepare({ id: 'view-1', revision: 7, value: 'view' });
  await committer.commit(prepared);

  await assert.rejects(
    () => committer.commit({ id: 'view-1', revision: 8, value: 'view', state: 'prepared' }),
    ContextCommitError,
  );
  await assert.rejects(
    () => committer.commit({ id: 'view-1', revision: 7, value: 'other', state: 'prepared' }),
    ContextCommitError,
  );
  assert.equal(committer.state('view-1'), 'committed');
});

test('ContextCommitter rejects commit retries after publish without changing state', async () => {
  const committer = new ContextCommitter<string>();
  const prepared = committer.prepare({ id: 'published-id', revision: 7, value: 'view' });
  await committer.commit(prepared);
  committer.publish(prepared.id);

  await assert.rejects(() => committer.commit('published-id'), ContextCommitError);
  assert.equal(committer.state('published-id'), 'published');
  await assert.rejects(() => committer.commit(prepared), ContextCommitError);
  assert.equal(committer.state('published-id'), 'published');
});

test('ContextCommitter keeps a committed context retryable when publish fails', async () => {
  let attempts = 0;
  const committer = new ContextCommitter<string>({
    publish: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('publish failed');
    },
  });
  const prepared = committer.prepare({ id: 'view-1', value: 'view' });
  await committer.commit(prepared);

  assert.throws(() => committer.publish('view-1'), Error);
  assert.equal(committer.state('view-1'), 'committed');

  const published = committer.publish('view-1');
  assert.equal(published.state, 'published');
  assert.equal(committer.state('view-1'), 'published');
  assert.equal(attempts, 2);
});

test('ContextCommitter waits for the durable journal receipt before committed/publish', async () => {
  const events: string[] = [];
  let resolveDurable!: () => void;
  const durable = new Promise<void>((resolve) => {
    resolveDurable = resolve;
  });
  const committer = new ContextCommitter<string>({
    commit: (context) => {
      events.push(`commit-start:${context.id}`);
      return durable.then(() => {
        events.push(`commit-receipt:${context.id}`);
      });
    },
    publish: (context) => events.push(`publish:${context.id}`),
  });
  const prepared = committer.prepare({ id: 'view-1', revision: 7, value: 'view' });

  const committedPromise = committer.commit(prepared);
  assert.equal(committer.state('view-1'), 'prepared');
  assert.throws(() => committer.publish('view-1'), ContextPublishError);
  assert.deepEqual(events, ['commit-start:view-1']);

  const sameAttempt = committer.commit('view-1');
  assert.equal(committer.state('view-1'), 'prepared');
  assert.deepEqual(events, ['commit-start:view-1']);

  resolveDurable();
  const committed = await committedPromise;
  assert.deepEqual(await sameAttempt, committed);
  assert.equal(committed.state, 'committed');
  assert.equal(committer.state('view-1'), 'committed');
  assert.deepEqual(events, ['commit-start:view-1', 'commit-receipt:view-1']);

  const published = committer.publish('view-1');
  assert.equal(published.state, 'published');
  assert.equal(committer.state('view-1'), 'published');
  assert.deepEqual(events, ['commit-start:view-1', 'commit-receipt:view-1', 'publish:view-1']);
});

test('ContextCommitter keeps a prepared/commit-intent state when the durable journal rejects', async () => {
  const events: string[] = [];
  let durableAttempts = 0;
  let rejectDurable!: (error: Error) => void;
  const firstDurable = new Promise<void>((_, reject) => {
    rejectDurable = reject;
  });
  const committer = new ContextCommitter<string>({
    commit: (context) => {
      durableAttempts += 1;
      events.push(`commit-start:${context.id}:${durableAttempts}`);
      if (durableAttempts === 1) {
        return firstDurable;
      }
      return Promise.resolve();
    },
  });
  const prepared = committer.prepare({ id: 'view-1', revision: 7, value: 'view' });

  const firstAttempt = committer.commit(prepared);
  assert.equal(committer.state('view-1'), 'prepared');
  rejectDurable(new Error('journal unavailable'));

  await assert.rejects(firstAttempt, Error);
  assert.equal(committer.state('view-1'), 'prepared');
  assert.throws(() => committer.publish('view-1'), ContextPublishError);
  assert.deepEqual(events, ['commit-start:view-1:1']);

  const committed = await committer.commit(prepared);
  assert.equal(committed.state, 'committed');
  assert.equal(committer.state('view-1'), 'committed');
  assert.deepEqual(events, ['commit-start:view-1:1', 'commit-start:view-1:2']);

  assert.equal(await committer.commit(prepared), committed);
  assert.equal(durableAttempts, 2);
});
