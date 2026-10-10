import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODE_SEARCH_CONTRACT_VERSION,
  CODE_SEARCH_SERVICE_ID,
  id,
  type CodeSearchReport,
  type InteractionTraceEntry,
  type ToolExecutionFact,
  type ToolIdentity,
  type ToolTraceDescriptor,
} from '../../../packages/contracts/src/index.js';
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
  deriveFileSearchObservation,
  groupToolMessages,
  mapToolResult,
  pruneEffectivePath,
  type FileSearchSemanticInput,
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

const semanticOrganId = id('organ', 'semantic-organ');
const semanticTaskId = id('task', 'semantic-task');
const semanticOperationId = id('operation', 'semantic-operation');
const semanticEvidenceRef: InteractionTraceEntry['evidenceRefs'][number] = {
  evidenceId: id('evidence', 'semantic-evidence'),
  kind: 'tool',
  source: 'semantic-test',
  locator: 'evidence://semantic-execution',
  scope: {
    organId: semanticOrganId,
    taskId: semanticTaskId,
    operationId: semanticOperationId,
  },
};

function semanticReport(overrides: Partial<CodeSearchReport> = {}): CodeSearchReport {
  return {
    serviceId: CODE_SEARCH_SERVICE_ID,
    contractVersion: CODE_SEARCH_CONTRACT_VERSION,
    status: 'succeeded',
    workspaceRef: 'workspace://semantic',
    path: 'src',
    query: 'needle',
    queryKind: 'literal',
    matches: [{
      path: 'src/a.ts',
      line: 1,
      column: 1,
      text: 'RAW_MATCH_SENTINEL',
      contextBefore: ['RAW_CONTEXT_SENTINEL'],
      contextAfter: ['RAW_CONTEXT_SENTINEL_AFTER'],
    }],
    filesDiscovered: 2,
    filesSearched: 2,
    matchesFound: 1,
    resultsTruncated: false,
    searchComplete: true,
    unresolvedPaths: [],
    summary: 'RAW_SUMMARY_SENTINEL',
    ...overrides,
  };
}

function semanticInput(report: CodeSearchReport = semanticReport()): FileSearchSemanticInput {
  const outputRef = 'asset://semantic-report';
  const outputDigest = `sha256:${'a'.repeat(64)}`;
  const toolIdentity: ToolIdentity = {
    surface: 'responses',
    toolId: 'file.search',
    bindingRef: 'binding-semantic',
    route: 'app.file-search.local',
  };
  const result: ToolTraceDescriptor = {
    callId: 'call-semantic',
    toolId: 'file.search',
    status: 'succeeded',
    paired: true,
    outputRef,
    outputDigest,
  };
  const fact: ToolExecutionFact = {
    identity: toolIdentity,
    requestRef: 'request-semantic',
    callRef: 'call-semantic',
    operationRef: 'semantic-operation',
    state: 'succeeded',
    rawEvidenceRefs: ['evidence://execution-semantic'],
    resultRef: outputRef,
    resultDigest: outputDigest,
  };
  const trace: InteractionTraceEntry = {
    turnId: 'turn-semantic',
    requestId: 'request-semantic',
    seq: 7,
    occurredAt: '2026-10-10T00:00:00.000Z',
    kind: 'tool-result',
    taskId: semanticTaskId,
    operationId: semanticOperationId,
    executionEpoch: 1,
    tool: result,
    evidenceRefs: [semanticEvidenceRef],
    state: 'succeeded',
  };
  return {
    invocation: {
      trace,
      expectedToolIdentity: toolIdentity,
      request: {
        workspaceRef: 'workspace://semantic',
        path: 'src',
        query: 'needle',
        queryKind: 'literal',
      },
    },
    result,
    fact,
    report: {
      report,
      outputRef,
      outputDigest,
    },
  };
}

test('file.search semantic mapper derives a bounded complete-hit observation', () => {
  const output = deriveFileSearchObservation(semanticInput());

  assert.equal(output.state, 'resolved');
  assert.equal(output.code, 'file-search.complete');
  assert.equal(output.executorState, 'succeeded');
  assert.equal(output.reportStatus, 'succeeded');
  assert.deepEqual(output.query, { value: 'needle', kind: 'literal' });
  assert.deepEqual(output.scope, { workspaceRef: 'workspace://semantic', path: 'src' });
  assert.deepEqual(output.counts, {
    filesDiscovered: 2,
    filesSearched: 2,
    matchesFound: 1,
    returnedMatches: 1,
    resultsTruncated: false,
    searchComplete: true,
  });
  assert.deepEqual(output.unresolvedPaths, []);
  assert.deepEqual(output.reportEvidence, {
    outputRef: 'asset://semantic-report',
    outputDigest: `sha256:${'a'.repeat(64)}`,
    serviceId: CODE_SEARCH_SERVICE_ID,
    contractVersion: CODE_SEARCH_CONTRACT_VERSION,
  });
  assert.equal(output.claim?.certainty, 'confirmed');
  assert.equal(/records 1 match\(es\)/.test(output.claim?.fact ?? ''), true);
  assert.deepEqual(output.sourceRefs, ['asset://semantic-report', 'evidence://execution-semantic']);
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes('RAW_MATCH_SENTINEL'), false);
  assert.equal(serialized.includes('RAW_CONTEXT_SENTINEL'), false);
  assert.equal(serialized.includes('RAW_SUMMARY_SENTINEL'), false);
});

test('file.search semantic mapper distinguishes complete zero-hit, partial scan, and truncation', () => {
  const zeroHit = deriveFileSearchObservation(semanticInput(semanticReport({
    matches: [],
    matchesFound: 0,
    summary: 'RAW_SUMMARY_SENTINEL',
  })));
  assert.equal(zeroHit.state, 'resolved');
  assert.equal(/records zero matches/.test(zeroHit.claim?.fact ?? ''), true);
  assert.equal((zeroHit.claim?.fact ?? '').includes('does not exist'), false);

  const partial = deriveFileSearchObservation(semanticInput(semanticReport({
    filesSearched: 1,
    searchComplete: false,
    unresolvedPaths: ['src/broken.ts'],
  })));
  assert.equal(partial.state, 'partial');
  assert.equal(partial.claim?.certainty, 'partial');
  assert.deepEqual(partial.unresolvedPaths, ['src/broken.ts']);
  assert.equal(/unresolvedPaths/.test(partial.claim?.fact ?? ''), true);

  const truncated = deriveFileSearchObservation(semanticInput(semanticReport({
    matchesFound: 3,
    resultsTruncated: true,
  })));
  assert.equal(truncated.state, 'partial');
  assert.equal(truncated.counts?.resultsTruncated, true);
  assert.equal(truncated.counts?.returnedMatches, 1);
  assert.equal(/returnedMatches=1/.test(truncated.claim?.fact ?? ''), true);
});

test('file.search semantic mapper preserves business failure without copying failure text', () => {
  const output = deriveFileSearchObservation(semanticInput(semanticReport({
    status: 'failed',
    matches: [],
    filesDiscovered: 0,
    filesSearched: 0,
    matchesFound: 0,
    searchComplete: false,
    failure: {
      code: 'path-not-found',
      message: 'RAW_FAILURE_SENTINEL',
      path: 'src/missing.ts',
    },
    summary: 'RAW_FAILURE_SENTINEL',
  })));

  assert.equal(output.state, 'unresolved');
  assert.equal(output.code, 'file-search.business-failed');
  assert.equal(output.executorState, 'succeeded');
  assert.equal(output.reportStatus, 'failed');
  assert.deepEqual(output.failure, { code: 'path-not-found', path: 'src/missing.ts' });
  assert.equal(output.claim, undefined);
  assert.equal(JSON.stringify(output).includes('RAW_FAILURE_SENTINEL'), false);
});

test('file.search semantic mapper returns explicit unresolved outcomes for missing evidence', () => {
  assert.equal(deriveFileSearchObservation({}).code, 'file-search.invocation-missing');

  const withoutResult: FileSearchSemanticInput = { ...semanticInput(), result: undefined };
  assert.equal(deriveFileSearchObservation(withoutResult).code, 'file-search.result-missing');

  const withoutFact: FileSearchSemanticInput = { ...semanticInput(), fact: undefined };
  assert.equal(deriveFileSearchObservation(withoutFact).code, 'file-search.fact-missing');

  const withoutReport: FileSearchSemanticInput = { ...semanticInput(), report: undefined };
  assert.equal(deriveFileSearchObservation(withoutReport).code, 'file-search.report-missing');

  const base = semanticInput();
  const withoutIdentity = {
    ...base,
    invocation: { ...base.invocation!, request: undefined },
  } as unknown as FileSearchSemanticInput;
  assert.equal(deriveFileSearchObservation(withoutIdentity).code, 'file-search.request-missing');
});

test('file.search semantic mapper refuses identity, descriptor, version, malformed, and contradictory input', () => {
  const base = semanticInput();
  const wrongSurface = {
    ...base,
    invocation: {
      ...base.invocation!,
      expectedToolIdentity: { ...base.invocation!.expectedToolIdentity, surface: 'anthropic' },
    },
  } as FileSearchSemanticInput;
  assert.equal(deriveFileSearchObservation(wrongSurface).state, 'refused');

  const wrongInvocation = {
    ...base,
    invocation: {
      ...base.invocation!,
      trace: {
        ...base.invocation!.trace,
        tool: { ...base.invocation!.trace.tool!, callId: 'other-call' },
      },
    },
  } as FileSearchSemanticInput;
  assert.equal(deriveFileSearchObservation(wrongInvocation).code, 'file-search.result-mismatch');

  const mismatchedTool = {
    ...base,
    result: { ...base.result!, toolId: 'file.read' },
    invocation: {
      ...base.invocation!,
      trace: {
        ...base.invocation!.trace,
        tool: { ...base.invocation!.trace.tool!, toolId: 'file.read' },
      },
    },
  } as FileSearchSemanticInput;
  const mismatchedToolOutput = deriveFileSearchObservation(mismatchedTool);
  assert.equal(mismatchedToolOutput.state, 'refused');
  assert.equal(mismatchedToolOutput.code, 'file-search.identity-mismatch');
  assert.equal(mismatchedToolOutput.claim, undefined);

  const wrongDescriptor = {
    ...base,
    report: { ...base.report!, outputDigest: `sha256:${'b'.repeat(64)}` },
  } as FileSearchSemanticInput;
  assert.equal(deriveFileSearchObservation(wrongDescriptor).code, 'file-search.descriptor-mismatch');

  const wrongVersion = semanticInput(semanticReport({ contractVersion: '2.0.0' as never }));
  assert.equal(deriveFileSearchObservation(wrongVersion).code, 'file-search.report-invalid');

  const malformed = semanticInput(semanticReport({ matches: 'not-array' as never }));
  assert.equal(deriveFileSearchObservation(malformed).code, 'file-search.report-invalid');

  const contradictory = semanticInput(semanticReport({ filesSearched: 1 }));
  assert.equal(deriveFileSearchObservation(contradictory).code, 'file-search.counts-contradictory');
});

test('file.search semantic mapper does not promote nonterminal or non-success execution', () => {
  const executionInput = (
    executorState: ToolExecutionFact['state'],
    traceState: ToolTraceDescriptor['status'],
    seq: number,
  ): FileSearchSemanticInput => {
    const base = semanticInput();
    const requestRef = `request-execution-${seq}`;
    const callRef = `call-execution-${seq}`;
    return {
      ...base,
      result: { ...base.result!, callId: callRef, status: traceState },
      fact: { ...base.fact!, state: executorState, requestRef, callRef },
      invocation: {
        ...base.invocation!,
        trace: {
          ...base.invocation!.trace,
          requestId: requestRef,
          seq,
          tool: { ...base.invocation!.trace.tool!, callId: callRef, status: traceState },
        },
      },
    };
  };

  for (const [executorState, traceState, seq] of [
    ['accepted', 'running', 8],
    ['running', 'running', 9],
  ] as const) {
    const output = deriveFileSearchObservation(executionInput(executorState, traceState, seq));
    assert.equal(output.state, 'unresolved');
    assert.equal(output.code, 'file-search.execution-nonterminal');
    assert.equal(output.executorState, executorState);
    assert.equal(output.invocation?.seq, seq);
    assert.equal(output.invocation?.requestRef, `request-execution-${seq}`);
    assert.equal(output.invocation?.callRef, `call-execution-${seq}`);
    assert.equal(output.invocation?.toolIdentity.toolId, 'file.search');
    assert.equal(output.claim, undefined);
  }

  for (const [executorState, traceState, seq] of [
    ['failed', 'failed', 10],
    ['cancelled', 'cancelled', 11],
    ['blocked', 'blocked', 12],
    ['unknown', 'unknown', 13],
  ] as const) {
    const output = deriveFileSearchObservation(executionInput(executorState, traceState, seq));
    assert.equal(output.state, 'unresolved');
    assert.equal(output.code, 'file-search.execution-not-succeeded');
    assert.equal(output.executorState, executorState);
    assert.equal(output.invocation?.seq, seq);
    assert.equal(output.invocation?.requestRef, `request-execution-${seq}`);
    assert.equal(output.invocation?.callRef, `call-execution-${seq}`);
    assert.equal(output.invocation?.toolIdentity.toolId, 'file.search');
    assert.equal(output.claim, undefined);
  }
});
