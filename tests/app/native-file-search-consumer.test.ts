import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  CODE_SEARCH_CONTRACT_VERSION,
  CODE_SEARCH_SERVICE_ID,
  id,
  validateCodeSearchReport,
  type CodeSearchReport,
  type InteractionHistoryResult,
  type InteractionTraceEntry,
  type OperationId,
  type ProviderBinding,
  type TaskId,
  type ToolExecutionFact,
} from '../../packages/contracts/src/index.js';
import {
  ProviderAdapter,
  ResponsesProviderCodec,
  createV3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
  type V3ProviderFetch,
  type V3ProviderFetchResponse,
} from '../../packages/adapters/provider/src/index.js';
import type { ProviderWireEvent } from '../../packages/adapters/provider/src/wire.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import {
  createResponsesFileToolExecutor,
  RESPONSES_FILE_SEARCH_TOOL,
} from '../../packages/app/src/provider-tool-execution.js';
import {
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../packages/app/src/ui-runtime/index.js';
import { validatePersistedToolExecutionFact } from '../../packages/app/src/ui-runtime/tool-fact-validation.js';
import { AccessControlService as FileAccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { startUiRuntimeServer } from '../../packages/app/src/ui-runtime/server.js';
import { UiRuntimeApiError } from '../../packages/app/src/ui-runtime/errors.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import {
  deriveFileSearchObservation,
  type FileSearchSemanticInput,
} from '../../packages/runtime/src/context/index.js';

const organId = id('organ', 'native-file-search-organ');
const taskRuntimeRoot = '/Users/fanzhang/.humanagent/s-r2-typed-history-verification-20261009';
const fileSearchCallId = 'call-file-search';
const binding: ProviderBinding = {
  bindingId: 'native-file-search-binding',
  providerId: 'scripted-responses-provider',
  protocol: 'responses',
  endpointRef: 'endpoint://scripted-responses',
  modelRef: 'scripted-model',
  configDigest: 'sha256:native-file-search-config',
  capabilityDigest: 'sha256:native-file-search-capabilities',
};

const persistedEvent: {
  eventId: string;
  seq: number;
  occurredAt: string;
  taskId: { readonly scope: 'task'; readonly value: string };
  operationId: string;
  executionEpoch: number;
  kind: string;
  state: string;
  summary: string;
  evidenceRefs: readonly {
    readonly evidenceId: { readonly scope: 'evidence'; readonly value: string };
    readonly kind: string;
    readonly source: string;
    readonly locator: string;
    readonly scope: { readonly organId: typeof organId; readonly taskId: typeof persistedEvent['taskId'] };
  }[];
  requestId: string;
  callId: string;
  toolId: string;
  status: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';
  outputRef: string;
  outputDigest: string;
} = {
  eventId: 'event-persisted-tool-result',
  seq: 3,
  occurredAt: '2026-10-09T00:00:00.000Z',
  taskId: id('task', 'task-persisted-tool-result'),
  operationId: 'operation-persisted-tool-result',
  executionEpoch: 1,
  kind: 'provider.tool-result',
  state: 'succeeded',
  summary: 'persisted tool result',
  evidenceRefs: [{
    evidenceId: id('evidence', 'evidence-persisted-tool-result'),
    kind: 'operation',
    source: 'test',
    locator: 'journal://persisted-tool-result',
    scope: {
      organId,
      taskId: id('task', 'task-persisted-tool-result'),
    },
  }],
  requestId: 'request-persisted-tool-result',
  callId: 'call-persisted-tool-result',
  toolId: 'file.search',
  status: 'succeeded',
  outputRef: 'asset://provider-tool/output/persisted-tool-result',
  outputDigest: `sha256:${'a'.repeat(64)}`,
} as const;

function persistedFact(): Record<string, unknown> {
  return {
    identity: {
      surface: 'responses',
      toolId: persistedEvent.toolId,
      bindingRef: binding.bindingId,
      route: 'app.file-search.local',
    },
    requestRef: persistedEvent.requestId,
    callRef: persistedEvent.callId,
    operationRef: persistedEvent.operationId,
    state: persistedEvent.status,
    rawEvidenceRefs: [persistedEvent.outputRef],
    resultRef: persistedEvent.outputRef,
    resultDigest: persistedEvent.outputDigest,
  };
}

function operationStartedRecord(
  operationIdValue = persistedEvent.operationId,
  taskIdValue = persistedEvent.taskId.value,
): unknown {
  const operationId = id('operation', operationIdValue);
  const taskId = id('task', taskIdValue);
  return {
    kind: 'operation.started',
    operationId,
    taskId,
    cycleId: id('cycle', 'cycle-persisted-tool-result'),
    scope: {
      organId,
      taskId,
      cycleId: id('cycle', 'cycle-persisted-tool-result'),
      operationId,
    },
    executionEpoch: persistedEvent.executionEpoch,
    operationCounter: 1,
    cycleCounter: 1,
    startedAt: persistedEvent.occurredAt,
    input: 'persisted tool result',
  };
}

function persistedEventRecord(event: Record<string, unknown>, operationIdValue = persistedEvent.operationId): unknown {
  return {
    kind: 'operation.event',
    operationId: id('operation', operationIdValue),
    event,
  };
}

function writeJournalRecords(root: string, records: readonly unknown[]): Promise<string> {
  const filePath = join(root, 'projection', 'ui-runtime-journal.jsonl');
  return mkdir(join(root, 'projection'), { recursive: true }).then(() => writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  )).then(() => filePath);
}

function sse(events: readonly ProviderWireEvent[]): V3ProviderFetchResponse {
  const body = (async function* () {
    for (const event of events) yield new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  })();
  return { status: 200, body, text: async () => '' };
}

function providerAdapter(root: string, failSearch = false): ProviderAdapter {
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'provider-evidence')));
  let responseCount = 0;
  const fetch: V3ProviderFetch = async (url) => {
    if (url.endsWith('/health')) return { status: 200, body: null, text: async () => '{"status":"ok","version":"fixture"}' };
    if (url.endsWith('/v1/models')) return { status: 200, body: null, text: async () => '{"data":[{"id":"scripted-model"}]}' };
    if (!url.endsWith('/v1/responses')) throw new Error(`unexpected scripted provider URL: ${url}`);
    responseCount += 1;
    if (responseCount === 1) {
      return sse([
        { protocol: 'responses', type: 'response.created', response: { id: 'response-search-call' } },
        {
          protocol: 'responses', type: 'response.output_item.added', output_index: 0,
          item: { type: 'function_call', call_id: fileSearchCallId, name: 'file_search', arguments: '' },
        },
        {
          protocol: 'responses', type: 'response.output_item.done', output_index: 0,
          item: {
            type: 'function_call', call_id: fileSearchCallId, name: 'file_search',
            arguments: JSON.stringify(failSearch
              ? { path: '', query: 'semantic-needle', queryKind: 'literal' }
              : { path: '.', query: 'semantic-needle', queryKind: 'literal' }),
          },
        },
        { protocol: 'responses', type: 'response.completed', response: { id: 'response-search-call' } },
      ]);
    }
    if (responseCount === 2) {
      return sse([
        { protocol: 'responses', type: 'response.created', response: { id: 'response-search-final' } },
        { protocol: 'responses', type: 'response.output_text.done', item_id: 'message-final', text: 'Search completed.' },
        { protocol: 'responses', type: 'response.completed', response: { id: 'response-search-final' } },
      ]);
    }
    throw new Error(`unexpected extra scripted Responses request ${responseCount}`);
  };
  const transport = createV3ProviderHttpTransport({ binding, baseUrl: 'http://127.0.0.1:4444', evidence, fetch });
  return new ProviderAdapter({ binding, routeRef: 'fixture-route', codec: new ResponsesProviderCodec(), transport, evidence });
}

function service(input: {
  root: string;
  adapter: ProviderAdapter;
  journal: UiRuntimeJournal;
  executor: ReturnType<typeof createResponsesFileToolExecutor>['executor'];
  toolOutputs: ReturnType<typeof createResponsesFileToolExecutor>['toolOutputs'];
  workspaceRoot: string;
  projectKey: string;
}): UiRuntimeService {
  return new UiRuntimeService({
    mode: 'rcc',
    organId,
    binding,
    port: input.adapter,
    checkpointStoreFor: (taskId, _cycleId) => new FileCheckpointStore(join(input.root, `checkpoint-${taskId.value}.jsonl`)),
    attentionPort: {
      async publish(value) { return { attentionId: value.attentionId, delivered: true }; },
      async resolve(value) { return { attentionId: value.attentionId, delivered: true }; },
    },
    providerState: 'ready',
    journal: input.journal,
    closurePort: input.journal,
    workspaceRoot: input.workspaceRoot,
    projectKey: input.projectKey,
    providerTools: [RESPONSES_FILE_SEARCH_TOOL],
    providerToolExecutor: input.executor,
    toolOutputStore: input.toolOutputs,
    providerToolRoundLimit: 4,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: input.projectKey,
      roleId: 'execution',
    },
    explicitBrainInterpreter: {
      async interpret() {
        return { kind: 'clarification', normalizedInput: '', knownFacts: [], question: 'unused', decisionRefs: [] };
      },
    },
  });
}

async function waitForTerminal(runtime: UiRuntimeService, taskId: TaskId): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = runtime.taskDashboard(taskId).state;
    if (state === 'succeeded' || state === 'failed' || state === 'blocked') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`runtime did not finish; state=${runtime.taskDashboard(taskId).state}`);
}

function reportAssetPath(artifactRoot: string, outputRef: string, outputDigest: string): string {
  const outputId = decodeURIComponent(outputRef.slice('asset://provider-tool/output/'.length));
  const safeOutputId = outputId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);
  return join(artifactRoot, 'tool-output', `provider-tool-output-${safeOutputId}-${outputDigest.slice(-12)}`);
}

function sha256Digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function sha256Bytes(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function selectToolResult(
  runtime: UiRuntimeService,
  taskId: TaskId,
  input: {
    readonly operationId: OperationId;
    readonly executionEpoch: number;
    readonly callId: string;
    readonly outputRef: string;
    readonly outputDigest: string;
  },
): InteractionTraceEntry {
  const history: InteractionHistoryResult = runtime.history(taskId, {
    filter: {
      taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      kinds: ['tool-result'],
      callId: input.callId,
    },
    limit: 50,
  });
  assert.equal(history.ok, true, JSON.stringify(history));
  if (!history.ok) throw new Error(`typed history did not return a page: ${JSON.stringify(history)}`);
  assert.equal(history.page.hasMore, false, JSON.stringify(history.page));
  assert.equal(history.page.cursor, undefined, JSON.stringify(history.page));
  assert.equal(history.page.items.length, 1, JSON.stringify(history.page));
  const entry = history.page.items[0]!;
  assert.deepEqual(entry.taskId, taskId);
  assert.deepEqual(entry.operationId, input.operationId);
  assert.equal(entry.executionEpoch, input.executionEpoch);
  assert.equal(entry.kind, 'tool-result');
  assert.equal(entry.tool?.callId, input.callId);
  assert.equal(entry.tool?.toolId, 'file.search');
  assert.equal(entry.tool?.status, 'succeeded');
  assert.equal(entry.tool?.paired, true);
  assert.equal(entry.tool?.outputRef, input.outputRef);
  assert.equal(entry.tool?.outputDigest, input.outputDigest);
  assert.equal(Number.isSafeInteger(entry.seq) && entry.seq > 0, true);
  return entry;
}

async function assertToolOutputBytes(
  runtime: UiRuntimeService,
  entry: InteractionTraceEntry,
  expectedBytes: string,
  expectedDigest: string,
): Promise<CodeSearchReport> {
  const report: unknown = await runtime.toolOutput(
    entry.taskId,
    entry.operationId,
    entry.executionEpoch,
    entry.seq,
  );
  assert.equal(JSON.stringify(report), expectedBytes);
  assert.equal(sha256Digest(JSON.stringify(report)), expectedDigest);
  validateCodeSearchReport(report);
  assert.deepEqual(report, JSON.parse(expectedBytes));
  return report;
}

function findPersistedFileSearchEvent(
  journal: UiRuntimeJournal,
  operationId: OperationId,
  kind: 'provider.tool' | 'provider.tool-result',
) {
  const record = journal.replay().find((candidate) => (
    candidate.kind === 'operation.event'
    && candidate.operationId.value === operationId.value
    && candidate.event.kind === kind
    && candidate.event.callId === fileSearchCallId
  ));
  if (!record || record.kind !== 'operation.event') {
    throw new Error(`persisted ${kind} event is missing for ${operationId.value}`);
  }
  return record.event;
}

function fileSearchSemanticInput(input: {
  readonly entry: InteractionTraceEntry;
  readonly fact: ToolExecutionFact;
  readonly report: CodeSearchReport;
  readonly workspaceRef: string;
  readonly arguments: unknown;
}): FileSearchSemanticInput {
  const result = input.entry.tool;
  if (result === undefined) throw new Error('history entry has no tool result descriptor');
  if (input.arguments === null || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    throw new Error('persisted file.search arguments are not an object');
  }
  const args = input.arguments as Record<string, unknown>;
  const { path, query, queryKind } = args;
  if (
    typeof path !== 'string'
    || typeof query !== 'string'
    || (queryKind !== 'literal' && queryKind !== 'regex' && queryKind !== 'symbol')
  ) {
    throw new Error('persisted file.search arguments are incomplete');
  }
  return {
    invocation: {
      trace: input.entry,
      expectedToolIdentity: input.fact.identity,
      request: {
        workspaceRef: input.workspaceRef,
        path,
        query,
        queryKind,
      },
    },
    result,
    fact: input.fact,
    report: {
      report: input.report,
      outputRef: result.outputRef!,
      outputDigest: result.outputDigest!,
    },
  };
}

async function writeQualifiedReportAsset(
  artifactRoot: string,
  outputId: string,
  report: unknown,
): Promise<{ readonly outputRef: string; readonly outputDigest: string }> {
  const content = JSON.stringify(report);
  const outputDigest = sha256Digest(content);
  const digestSuffix = outputDigest.slice(-12);
  await new ImmutableAssetStore(join(artifactRoot, 'tool-output')).write(
    `provider-tool-output-${outputId}-${digestSuffix}`,
    new TextEncoder().encode(content),
  );
  return {
    outputRef: `asset://provider-tool/output/${encodeURIComponent(outputId)}`,
    outputDigest,
  };
}

async function executeAndReadSearchReport(input: {
  readonly root: string;
  readonly projectKey: string;
  readonly callId: string;
  readonly arguments: { readonly path: string; readonly query: string; readonly queryKind: 'literal'; readonly contextLines?: number; readonly maxResults?: number };
  readonly taskId: string;
  readonly operationId: string;
}): Promise<Record<string, unknown>> {
  const workspaceRoot = join(input.root, 'workspace');
  const artifactRoot = join(input.root, 'evidence');
  const executor = createResponsesFileToolExecutor({ workspaceRoot, projectKey: input.projectKey, artifactRoot });
  const result = await executor.executor.execute({
    execution: {
      runtimeId: `runtime-${input.callId}`,
      taskId: id('task', input.taskId),
      operationId: id('operation', input.operationId),
      executionEpoch: 1,
    },
    scope: {
      organId,
      taskId: id('task', input.taskId),
      cycleId: id('cycle', `cycle-${input.operationId}`),
      operationId: id('operation', input.operationId),
    },
    call: {
      callId: input.callId,
      toolId: 'file.search',
      arguments: input.arguments,
      continuationRef: `response-${input.callId}`,
    },
    signal: new AbortController().signal,
  });
  if (result.outputRef === undefined || result.outputDigest === undefined) throw new Error('file.search report descriptor is missing');
  const persisted = JSON.parse(await readFile(reportAssetPath(artifactRoot, result.outputRef, result.outputDigest), 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.contractVersion, CODE_SEARCH_CONTRACT_VERSION);
  return persisted;
}

test('persisted execution facts fail closed on every outer relation mismatch', () => {
  const outer = {
    taskId: persistedEvent.taskId,
    operationId: { scope: 'operation' as const, value: persistedEvent.operationId },
    executionEpoch: persistedEvent.executionEpoch,
  };
  validatePersistedToolExecutionFact({ ...persistedEvent, executionFact: persistedFact() }, outer);

  const badFact = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...persistedFact(), ...patch });
  const expectIntegrityFailure = (label: string, event: Record<string, unknown>, expected = outer): void => {
    assert.throws(() => validatePersistedToolExecutionFact(event as never, expected), /tool execution fact|operation\.event record|requires|identity/);
  };

  expectIntegrityFailure('malformed fact', { ...persistedEvent, executionFact: { ...persistedFact(), rawEvidenceRefs: 'not-array' } });
  expectIntegrityFailure('missing request', { ...persistedEvent, requestId: undefined, executionFact: persistedFact() });
  expectIntegrityFailure('missing call', { ...persistedEvent, callId: undefined, executionFact: persistedFact() });
  expectIntegrityFailure('wrong request', { ...persistedEvent, executionFact: badFact({ requestRef: 'request-other' }) });
  expectIntegrityFailure('wrong call', { ...persistedEvent, executionFact: badFact({ callRef: 'call-other' }) });
  expectIntegrityFailure('wrong operation', { ...persistedEvent, executionFact: badFact({ operationRef: 'operation-other' }) });
  expectIntegrityFailure('wrong tool', { ...persistedEvent, executionFact: badFact({ identity: { ...persistedFact().identity as object, toolId: 'file.read' } }) });
  expectIntegrityFailure('wrong state', { ...persistedEvent, executionFact: badFact({ state: 'failed' }) });
  expectIntegrityFailure('wrong status', { ...persistedEvent, status: 'failed', executionFact: persistedFact() });
  expectIntegrityFailure('wrong ref', { ...persistedEvent, executionFact: badFact({ resultRef: 'asset://provider-tool/output/other' }) });
  expectIntegrityFailure('wrong digest', { ...persistedEvent, executionFact: badFact({ resultDigest: `sha256:${'b'.repeat(64)}` }) });
  expectIntegrityFailure('record operation mismatch', { ...persistedEvent, executionFact: persistedFact() }, { ...outer, operationId: { scope: 'operation', value: 'operation-record-other' } });
  expectIntegrityFailure('event task mismatch', { ...persistedEvent, taskId: id('task', 'task-event-other'), executionFact: persistedFact() });
  expectIntegrityFailure('event epoch mismatch', { ...persistedEvent, executionEpoch: 2, executionFact: persistedFact() });
  expectIntegrityFailure('event kind mismatch', { ...persistedEvent, kind: 'provider.tool', executionFact: persistedFact() });
  validatePersistedToolExecutionFact({ ...persistedEvent, taskId: undefined, operationId: undefined, executionFact: undefined } as never, outer);
});

test('disk journal replay rejects present facts that do not match their outer operation identity', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-native-file-search-replay-');
  try {
    const event = { ...persistedEvent, executionFact: persistedFact() };
    const cases: readonly [string, readonly unknown[]][] = [
      ['event task mismatch', [operationStartedRecord(), persistedEventRecord({ ...event, taskId: id('task', 'task-event-other') })]],
      ['event operation mismatch', [operationStartedRecord(), persistedEventRecord({ ...event, operationId: 'operation-event-other' })]],
      ['event epoch mismatch', [operationStartedRecord(), persistedEventRecord({ ...event, executionEpoch: 2 })]],
    ];
    for (const [label, records] of cases) {
      const filePath = await writeJournalRecords(join(root, label.replaceAll(' ', '-')), records);
      assert.throws(
        () => new UiRuntimeJournal(filePath).replay(),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'tool.execution-fact.integrity',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('disk journal replay rejects malformed and mismatched facts before exposing them', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-native-file-search-replay-fact-');
  try {
    const event = { ...persistedEvent, executionFact: persistedFact() };
    const malformedFact = { ...persistedFact(), rawEvidenceRefs: 'not-array' };
    const cases: readonly [string, readonly unknown[]][] = [
      ['malformed-fact', [operationStartedRecord(), persistedEventRecord({ ...event, executionFact: malformedFact })]],
      ['missing-request', [operationStartedRecord(), persistedEventRecord({ ...event, requestId: undefined })]],
      ['missing-call', [operationStartedRecord(), persistedEventRecord({ ...event, callId: undefined })]],
      ['wrong-request-ref', [operationStartedRecord(), persistedEventRecord({ ...event, executionFact: { ...persistedFact(), requestRef: 'request-other' } })]],
      ['wrong-call-ref', [operationStartedRecord(), persistedEventRecord({ ...event, executionFact: { ...persistedFact(), callRef: 'call-other' } })]],
      ['wrong-operation-ref', [operationStartedRecord(), persistedEventRecord({ ...event, executionFact: { ...persistedFact(), operationRef: 'operation-other' } })]],
      ['wrong-tool-identity', [operationStartedRecord(), persistedEventRecord({ ...event, executionFact: { ...persistedFact(), identity: { ...persistedFact().identity as object, toolId: 'file.read' } } })]],
      ['wrong-fact-state', [operationStartedRecord(), persistedEventRecord({ ...event, executionFact: { ...persistedFact(), state: 'failed' } })]],
      ['wrong-event-status', [operationStartedRecord(), persistedEventRecord({ ...event, status: 'failed' })]],
      ['wrong-result-ref', [operationStartedRecord(), persistedEventRecord({ ...event, executionFact: { ...persistedFact(), resultRef: 'asset://provider-tool/output/other' } })]],
      ['wrong-result-digest', [operationStartedRecord(), persistedEventRecord({ ...event, executionFact: { ...persistedFact(), resultDigest: `sha256:${'b'.repeat(64)}` } })]],
    ];
    for (const [label, records] of cases) {
      const filePath = await writeJournalRecords(join(root, label), records);
      assert.throws(
        () => new UiRuntimeJournal(filePath).replay(),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'tool.execution-fact.integrity',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy provider tool results without an execution fact keep replay and direct readback semantics', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-native-file-search-legacy-');
  try {
    const journalPath = await writeJournalRecords(root, [
      operationStartedRecord(),
      persistedEventRecord({ ...persistedEvent, executionFact: undefined }),
    ]);
    const journal = new UiRuntimeJournal(journalPath);
    const records = journal.replay();
    assert.equal(records.some((record) => record.kind === 'operation.event' && record.event.executionFact === undefined), true);
    validatePersistedToolExecutionFact({ ...persistedEvent, executionFact: undefined }, {
      taskId: persistedEvent.taskId,
      operationId: id('operation', persistedEvent.operationId),
      executionEpoch: persistedEvent.executionEpoch,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public readback rejects correctly digested malformed and unversioned file.search reports', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-native-file-search-unqualified-');
  const workspaceRoot = join(root, 'workspace');
  const artifactRoot = join(root, 'evidence');
  const projectKey = 'native-file-search-unqualified-project';
  await mkdir(workspaceRoot, { recursive: true });
  const validReport = {
    serviceId: CODE_SEARCH_SERVICE_ID,
    contractVersion: CODE_SEARCH_CONTRACT_VERSION,
    status: 'succeeded',
    workspaceRef: `workspace:${projectKey}`,
    path: '.',
    query: 'semantic-needle',
    queryKind: 'literal',
    matches: [{
      path: 'source.txt',
      line: 1,
      column: 1,
      text: 'semantic-needle',
      contextBefore: [],
      contextAfter: [],
    }],
    filesDiscovered: 1,
    filesSearched: 1,
    matchesFound: 1,
    resultsTruncated: false,
    searchComplete: true,
    unresolvedPaths: [],
    summary: 'searched 1 file(s), found 1 match(es)',
  };
  const cases: readonly [string, unknown][] = [
    ['malformed-json-object', { ...validReport, matches: 'not-array' }],
    ['unversioned', { ...validReport, contractVersion: undefined }],
    ['failed-without-failure', { ...validReport, status: 'failed' }],
    ['truncated-inconsistent', { ...validReport, resultsTruncated: true }],
    ['complete-with-unresolved', { ...validReport, searchComplete: true, unresolvedPaths: ['source.txt'] }],
  ];
  try {
    for (const [label, report] of cases) {
      const outputId = `unqualified-${label}`;
      const taskId = `task-${label}`;
      const descriptor = await writeQualifiedReportAsset(artifactRoot, outputId, report);
      const journalPath = await writeJournalRecords(join(root, label), [
        {
          kind: 'task.created',
          taskId: id('task', taskId),
          title: `task-${label}`,
          directive: `task-${label}`,
          directiveRevision: 1,
          createdAt: persistedEvent.occurredAt,
          taskCounter: 1,
        },
        operationStartedRecord(`operation-${label}`, taskId),
        persistedEventRecord({
          ...persistedEvent,
          eventId: `event-${label}`,
          operationId: `operation-${label}`,
          taskId: id('task', taskId),
          outputRef: descriptor.outputRef,
          outputDigest: descriptor.outputDigest,
          executionFact: {
            ...persistedFact(),
            operationRef: `operation-${label}`,
            resultRef: descriptor.outputRef,
            resultDigest: descriptor.outputDigest,
          },
        }, `operation-${label}`),
      ]);
      const journal = new UiRuntimeJournal(journalPath);
      const executor = createResponsesFileToolExecutor({ workspaceRoot, projectKey, artifactRoot });
      const runtime = service({
        root,
        adapter: providerAdapter(root),
        journal,
        executor: executor.executor,
        toolOutputs: executor.toolOutputs,
        workspaceRoot,
        projectKey,
      });
      await runtime.hydrate();
      await assert.rejects(
        () => runtime.toolOutput(id('task', taskId), id('operation', `operation-${label}`), persistedEvent.executionEpoch, persistedEvent.seq),
        (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'tool-output.report-unqualified',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local Responses file.search fact and report survive disk projection reconstruction', async () => {
  await mkdir(taskRuntimeRoot, { recursive: true });
  const root = await mkdtemp(join(taskRuntimeRoot, 'native-file-search-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'source.txt'), 'before semantic-needle after\n', 'utf8');
  const journalPath = join(root, 'projection', 'ui-runtime-journal.jsonl');
  const evidenceRoot = join(root, 'evidence');
  const credentialPath = join(root, 'security', 'web-access.json');
  const projectKey = 'native-file-search-project';
  const adapter = providerAdapter(root);
  const firstJournal = new UiRuntimeJournal(journalPath);
  const firstExecutor = createResponsesFileToolExecutor({ workspaceRoot, projectKey, artifactRoot: evidenceRoot });
  const firstService = service({ root, adapter, journal: firstJournal, executor: firstExecutor.executor, toolOutputs: firstExecutor.toolOutputs, workspaceRoot, projectKey });
  const diagnostics: Record<string, unknown> = {};
  const accessControl = await FileAccessControlService.open({ credentialPath, create: true });
  const session = await accessControl.consumePairingCode(accessControl.createPairingChallenge('file-search-test', 1).code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  try {
    const task = firstService.createTask({ title: 'local file search', directive: 'find semantic-needle' });
    const started = firstService.startExecution(task.taskId, { prompt: 'search for semantic-needle' });
    await waitForTerminal(firstService, task.taskId);
    assert.equal(firstService.taskDashboard(task.taskId).state, 'succeeded');
    const toolEvent = firstJournal.replay().find((record) => (
      record.kind === 'operation.event'
      && record.operationId.value === started.operationId.value
      && record.event.kind === 'provider.tool-result'
      && record.event.toolId === 'file.search'
      && record.event.executionFact !== undefined
      && record.event.status === 'succeeded'
      && record.event.outputRef !== undefined
    ));
    if (!toolEvent || toolEvent.kind !== 'operation.event') throw new Error('real local app file.search should yield a journaled runtime tool result');
    const toolResult = toolEvent.event;
    assert.equal(toolResult.toolId, 'file.search');
    assert.equal(toolResult.status, 'succeeded', JSON.stringify(toolResult));
    const executionFact = toolResult.executionFact;
    if (!executionFact) throw new Error('real local app file.search should produce a typed execution fact');
    assert.equal(executionFact.identity.surface, 'responses');
    assert.equal(executionFact.identity.toolId, 'file.search');
    assert.equal(executionFact.identity.bindingRef, binding.bindingId);
    assert.equal(executionFact.identity.route, 'app.file-search.local');
    assert.equal(executionFact.state, 'succeeded');
    assert.equal(executionFact.requestRef, toolResult.requestId);
    assert.equal(executionFact.callRef, toolResult.callId);
    assert.equal(toolResult.callId, fileSearchCallId);
    assert.equal(executionFact.operationRef, started.operationId.value);
    assert.equal(executionFact.resultRef, toolResult.outputRef);
    assert.equal(executionFact.resultDigest, toolResult.outputDigest);
    const outputRef = toolResult.outputRef;
    const outputDigest = toolResult.outputDigest;
    if (outputRef === undefined || outputDigest === undefined) throw new Error('file.search report descriptor is missing');
    const toolCallEvent = findPersistedFileSearchEvent(firstJournal, started.operationId, 'provider.tool');
    const persistedBytes = await readFile(reportAssetPath(evidenceRoot, outputRef, outputDigest), 'utf8');
    const persistedArtifact = new TextEncoder().encode(persistedBytes);
    assert.equal(persistedArtifact.byteLength, new TextEncoder().encode(persistedBytes).byteLength);
    assert.equal(sha256Bytes(persistedArtifact), outputDigest);
    assert.equal(sha256Digest(persistedBytes), outputDigest);
    const startReceipt = {
      taskId: task.taskId.value,
      operationId: started.operationId.value,
      executionEpoch: started.executionEpoch,
      callId: fileSearchCallId,
      outputRef,
      outputDigest,
      assetByteLength: persistedArtifact.byteLength,
    };
    diagnostics.startReceipt = startReceipt;

    const liveEntry = selectToolResult(firstService, task.taskId, {
      operationId: started.operationId,
      executionEpoch: started.executionEpoch,
      callId: fileSearchCallId,
      outputRef,
      outputDigest,
    });
    diagnostics.liveEntry = liveEntry;
    const liveReport = await assertToolOutputBytes(firstService, liveEntry, persistedBytes, outputDigest);
    diagnostics.liveReportDigest = sha256Digest(JSON.stringify(liveReport));
    const liveObservation = deriveFileSearchObservation(fileSearchSemanticInput({
      entry: liveEntry,
      fact: executionFact,
      report: liveReport,
      workspaceRef: `workspace:${projectKey}`,
      arguments: toolCallEvent.arguments,
    }));
    diagnostics.liveObservation = liveObservation;
    assert.equal(liveObservation.state, 'resolved');
    assert.equal(liveObservation.executorState, 'succeeded');
    assert.equal(liveObservation.reportStatus, 'succeeded');
    assert.equal(liveObservation.invocation?.seq, liveEntry.seq);
    assert.equal(liveObservation.invocation?.requestRef, liveEntry.requestId);
    assert.equal(liveObservation.invocation?.callRef, fileSearchCallId);
    assert.equal(liveObservation.reportEvidence?.outputDigest, outputDigest);
    assert.equal(JSON.stringify(liveObservation).includes('before semantic-needle after'), false);
    assert.equal(JSON.stringify(liveObservation).includes(String(liveReport.summary)), false);

    await firstService.quiesceImplicitConsumption();
    const postQuiesceLiveEntry = selectToolResult(firstService, task.taskId, {
      operationId: started.operationId,
      executionEpoch: started.executionEpoch,
      callId: fileSearchCallId,
      outputRef,
      outputDigest,
    });
    diagnostics.postQuiesceLiveEntry = postQuiesceLiveEntry;
    assert.deepEqual(postQuiesceLiveEntry, liveEntry);
    assert.equal(JSON.stringify(await assertToolOutputBytes(firstService, postQuiesceLiveEntry, persistedBytes, outputDigest)), persistedBytes);

    const secondJournal = new UiRuntimeJournal(journalPath);
    const secondExecutor = createResponsesFileToolExecutor({ workspaceRoot, projectKey, artifactRoot: evidenceRoot });
    const secondService = service({ root, adapter, journal: secondJournal, executor: secondExecutor.executor, toolOutputs: secondExecutor.toolOutputs, workspaceRoot, projectKey });
    await secondService.hydrate();
    const hydratedEntry = selectToolResult(secondService, task.taskId, {
      operationId: started.operationId,
      executionEpoch: started.executionEpoch,
      callId: fileSearchCallId,
      outputRef,
      outputDigest,
    });
    diagnostics.hydratedEntry = hydratedEntry;
    const hydratedToolCallEvent = findPersistedFileSearchEvent(secondJournal, started.operationId, 'provider.tool');
    const hydratedToolResultEvent = findPersistedFileSearchEvent(secondJournal, started.operationId, 'provider.tool-result');
    const hydratedFact = hydratedToolResultEvent.executionFact;
    if (hydratedFact === undefined) throw new Error('hydrated file.search execution fact is missing');
    const report = await assertToolOutputBytes(secondService, hydratedEntry, persistedBytes, outputDigest);
    assert.deepEqual(report, liveReport);
    const replayedObservation = deriveFileSearchObservation(fileSearchSemanticInput({
      entry: hydratedEntry,
      fact: hydratedFact,
      report,
      workspaceRef: `workspace:${projectKey}`,
      arguments: hydratedToolCallEvent.arguments,
    }));
    diagnostics.replayedObservation = replayedObservation;
    assert.deepEqual(replayedObservation, liveObservation);
    assert.equal(report.serviceId, CODE_SEARCH_SERVICE_ID);
    assert.equal(report.contractVersion, CODE_SEARCH_CONTRACT_VERSION);
    assert.equal(report.status, 'succeeded', JSON.stringify(report));
    assert.equal(report.workspaceRef, `workspace:${projectKey}`);
    assert.equal(report.path, '.');
    assert.equal(report.query, 'semantic-needle');
    assert.equal(report.queryKind, 'literal');
    assert.equal(report.searchComplete, true);
    assert.equal(report.resultsTruncated, false);
    assert.deepEqual(report.unresolvedPaths, []);
    assert.equal(Array.isArray(report.matches), true);
    assert.match(String(report.summary), /^searched 1 file\(s\), found 1 match\(es\)$/);
    const secondAccessControl = await FileAccessControlService.open({ credentialPath, create: false });
    const secondServer = await startUiRuntimeServer({ service: secondService, accessControl: secondAccessControl, uiRoot: join(process.cwd(), 'docs', 'ui'), port: 0 });
    try {
      const httpUrl = `${secondServer.url}/api/tasks/${task.taskId.value}/operations/${started.operationId.value}/executions/${hydratedEntry.executionEpoch}/events/${hydratedEntry.seq}/tool-output`;
      const response = await fetch(httpUrl, { headers: { cookie } });
      const body = await response.text();
      diagnostics.httpReadback = {
        url: httpUrl,
        status: response.status,
        bodyDigest: sha256Digest(body),
      };
      assert.equal(response.status, 200);
      assert.equal(body, persistedBytes);
      assert.deepEqual(JSON.parse(body), report);
    } finally {
      await secondServer.close();
    }

    const expectApiCode = (code: string) => (error: unknown) => error instanceof UiRuntimeApiError && error.code === code;
    await assert.rejects(() => secondService.toolOutput(task.taskId, started.operationId, hydratedEntry.executionEpoch + 1, hydratedEntry.seq), expectApiCode('tool-output.event-not-found'));
    await assert.rejects(() => secondService.toolOutput(id('task', 'wrong-task'), started.operationId, hydratedEntry.executionEpoch, hydratedEntry.seq), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'task.not.found');
    await assert.rejects(() => secondService.toolOutput(task.taskId, id('operation', 'wrong-operation'), hydratedEntry.executionEpoch, hydratedEntry.seq), expectApiCode('tool-output.event-not-found'));
    const wrongEpochHistory = secondService.history(task.taskId, {
      filter: {
        taskId: task.taskId,
        operationId: started.operationId,
        executionEpoch: hydratedEntry.executionEpoch + 1,
        kinds: ['tool-result'],
        callId: fileSearchCallId,
      },
      limit: 50,
    });
    assert.equal(wrongEpochHistory.ok, true);
    if (!wrongEpochHistory.ok) throw new Error(JSON.stringify(wrongEpochHistory));
    assert.equal(wrongEpochHistory.page.items.length, 0);

    const outputId = decodeURIComponent(outputRef.slice('asset://provider-tool/output/'.length));
    const artifactId = `provider-tool-output-${outputId}-${outputDigest.slice(-12)}`;
    const artifactPath = join(evidenceRoot, 'tool-output', artifactId);
    const originalArtifact = await readFile(artifactPath);
    await rm(artifactPath);
    await assert.rejects(() => secondService.toolOutput(task.taskId, started.operationId, hydratedEntry.executionEpoch, hydratedEntry.seq), expectApiCode('tool-output.report-missing-or-changed'));
    await writeFile(artifactPath, 'tampered report bytes', 'utf8');
    await assert.rejects(() => secondService.toolOutput(task.taskId, started.operationId, hydratedEntry.executionEpoch, hydratedEntry.seq), expectApiCode('tool-output.report-missing-or-changed'));
    await writeFile(artifactPath, new TextDecoder().decode(originalArtifact), 'utf8');

    const readOutputId = 'other-tool-read-output';
    const otherReport = { path: 'source.txt', content: 'semantic-needle' };
    const otherDescriptor = await writeQualifiedReportAsset(evidenceRoot, readOutputId, otherReport);
    const otherSeq = secondJournal.replay().reduce((maxSeq, record) => (
      record.kind === 'operation.event'
      && record.event.taskId.scope === task.taskId.scope
      && record.event.taskId.value === task.taskId.value
      && record.event.operationId === started.operationId.value
      && record.event.executionEpoch === hydratedEntry.executionEpoch
        ? Math.max(maxSeq, record.event.seq)
        : maxSeq
    ), hydratedEntry.seq) + 1;
    secondJournal.append(persistedEventRecord({
      ...toolResult,
      eventId: 'event-other-tool-result',
      seq: otherSeq,
      toolId: 'file.read',
      status: 'succeeded',
      outputRef: otherDescriptor.outputRef,
      outputDigest: otherDescriptor.outputDigest,
      executionFact: {
        ...executionFact,
        identity: { ...executionFact.identity, toolId: 'file.read' },
        rawEvidenceRefs: [otherDescriptor.outputRef],
        resultRef: otherDescriptor.outputRef,
        resultDigest: otherDescriptor.outputDigest,
      },
    }, started.operationId.value) as Parameters<UiRuntimeJournal['append']>[0]);
    const otherService = service({ root, adapter, journal: secondJournal, executor: secondExecutor.executor, toolOutputs: secondExecutor.toolOutputs, workspaceRoot, projectKey });
    await otherService.hydrate();
    assert.deepEqual(
      await otherService.toolOutput(task.taskId, started.operationId, hydratedEntry.executionEpoch, otherSeq),
      otherReport,
    );
  } finally {
    await firstService.quiesceImplicitConsumption().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('a real local file.search tool failure does not create a succeeded execution fact', async () => {
  const taskDataRoot = '/private/tmp/humanagent-native-file-search-runs';
  await mkdir(taskDataRoot, { recursive: true });
  const root = await mkdtemp(join(taskDataRoot, 'native-file-search-failure-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'source.txt'), 'semantic-needle\n', 'utf8');
  const projectKey = 'native-file-search-failure-project';
  const journal = new UiRuntimeJournal(join(root, 'projection', 'ui-runtime-journal.jsonl'));
  const executor = createResponsesFileToolExecutor({ workspaceRoot, projectKey, artifactRoot: join(root, 'evidence') });
  const runtime = service({ root, adapter: providerAdapter(root, true), journal, executor: executor.executor, toolOutputs: executor.toolOutputs, workspaceRoot, projectKey });
  try {
    const task = runtime.createTask({ title: 'invalid local file search', directive: 'search with invalid path' });
    const started = runtime.startExecution(task.taskId, { prompt: 'search for semantic-needle' });
    await waitForTerminal(runtime, task.taskId);
    assert.equal(runtime.taskDashboard(task.taskId).state, 'failed');
    const result = journal.replay().find((record) => record.kind === 'operation.event'
      && record.operationId.value === started.operationId.value
      && record.event.kind === 'provider.tool-result');
    if (!result || result.kind !== 'operation.event') throw new Error('failed real file.search should be journaled as a tool result');
    assert.equal(result.event.toolId, 'file.search');
    assert.equal(result.event.status, 'failed');
    assert.equal(result.event.executionFact, undefined);
  } finally {
    await runtime.quiesceImplicitConsumption().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed service report is persisted unchanged with its original failure fields', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-native-file-search-failed-report-');
  const workspaceRoot = join(root, 'workspace');
  const artifactRoot = join(root, 'evidence');
  const projectKey = 'native-file-search-failed-report-project';
  await mkdir(workspaceRoot, { recursive: true });
  const executor = createResponsesFileToolExecutor({ workspaceRoot, projectKey, artifactRoot });
  try {
    const result = await executor.executor.execute({
      execution: {
        runtimeId: 'runtime-failed-search-report',
        taskId: id('task', 'task-failed-search-report'),
        operationId: id('operation', 'operation-failed-search-report'),
        executionEpoch: 1,
      },
      scope: {
        organId,
        taskId: id('task', 'task-failed-search-report'),
        cycleId: id('cycle', 'cycle-failed-search-report'),
        operationId: id('operation', 'operation-failed-search-report'),
      },
      call: {
        callId: 'call-failed-search-report',
        toolId: 'file.search',
        arguments: { path: 'missing-file.txt', query: 'semantic-needle', queryKind: 'literal' },
        continuationRef: 'response-failed-search-report',
      },
      signal: new AbortController().signal,
    });
    if (result.outputRef === undefined || result.outputDigest === undefined) {
      throw new Error('failed file.search report must still carry its immutable descriptor');
    }
    const persisted = await executor.toolOutputs.readReport({
      outputRef: result.outputRef,
      outputDigest: result.outputDigest,
    }) as Record<string, unknown>;
    assert.equal(persisted.status, 'failed');
    assert.equal((persisted.failure as Record<string, unknown>).code, 'path-not-found');
    assert.equal(persisted.summary, (persisted.failure as Record<string, unknown>).message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an incomplete search keeps its partial scope and failure fields after persistence', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-native-file-search-incomplete-');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'readable.txt'), 'semantic-needle\n', 'utf8');
  const artifactRoot = join(root, 'evidence');
  const projectKey = 'native-file-search-incomplete-project';
  const executor = createResponsesFileToolExecutor({ workspaceRoot, projectKey, artifactRoot });
  try {
    const result = await executor.executor.execute({
      execution: {
        runtimeId: 'runtime-incomplete-search',
        taskId: id('task', 'task-incomplete-search'),
        operationId: id('operation', 'operation-incomplete-search'),
        executionEpoch: 1,
      },
      scope: {
        organId,
        taskId: id('task', 'task-incomplete-search'),
        cycleId: id('cycle', 'cycle-incomplete-search'),
        operationId: id('operation', 'operation-incomplete-search'),
      },
      call: {
        callId: 'call-incomplete-search',
        toolId: 'file.search',
        arguments: { path: 'missing-file.txt', query: 'semantic-needle', queryKind: 'literal', requireComplete: true },
        continuationRef: 'response-incomplete-search',
      },
      signal: new AbortController().signal,
    });
    if (result.outputRef === undefined || result.outputDigest === undefined) throw new Error('incomplete file.search report descriptor is missing');
    const persisted = await executor.toolOutputs.readReport({
      outputRef: result.outputRef,
      outputDigest: result.outputDigest,
    }) as Record<string, unknown>;
    assert.equal(persisted.status, 'failed');
    assert.equal(persisted.searchComplete, false);
    assert.equal(persisted.resultsTruncated, false);
    assert.deepEqual(persisted.unresolvedPaths, ['missing-file.txt']);
    assert.equal((persisted.failure as Record<string, unknown>).code, 'path-not-found');
    assert.equal(persisted.summary, (persisted.failure as Record<string, unknown>).message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('truncated successful search reports remain distinct after persistence', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-native-file-search-partial-truncated-');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'readable.txt'), 'semantic-needle\nsemantic-needle\nsemantic-needle\n', 'utf8');
  try {
    const truncated = await executeAndReadSearchReport({
      root,
      projectKey: 'native-file-search-truncated-project',
      callId: 'call-truncated-search',
      arguments: { path: '.', query: 'semantic-needle', queryKind: 'literal', maxResults: 1 },
      taskId: 'task-truncated-search',
      operationId: 'operation-truncated-search',
    });
    assert.equal(truncated.status, 'succeeded');
    assert.equal(truncated.searchComplete, true);
    assert.equal(truncated.resultsTruncated, true);
    assert.equal(truncated.matchesFound, 3);
    assert.equal((truncated.matches as readonly unknown[]).length, 1);
    assert.equal(truncated.summary, 'searched 1 file(s), found 3 match(es)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
