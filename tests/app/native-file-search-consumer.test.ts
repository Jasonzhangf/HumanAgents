import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type ProviderBinding,
  type TaskId,
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

const organId = id('organ', 'native-file-search-organ');
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

function operationStartedRecord(operationIdValue = persistedEvent.operationId): unknown {
  const operationId = id('operation', operationIdValue);
  return {
    kind: 'operation.started',
    operationId,
    taskId: persistedEvent.taskId,
    cycleId: id('cycle', 'cycle-persisted-tool-result'),
    scope: {
      organId,
      taskId: persistedEvent.taskId,
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
          item: { type: 'function_call', call_id: 'call-file-search', name: 'file_search', arguments: '' },
        },
        {
          protocol: 'responses', type: 'response.output_item.done', output_index: 0,
          item: {
            type: 'function_call', call_id: 'call-file-search', name: 'file_search',
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

test('local Responses file.search fact and report survive disk projection reconstruction', async () => {
  const taskDataRoot = '/private/tmp/humanagent-native-file-search-runs';
  await mkdir(taskDataRoot, { recursive: true });
  const root = await mkdtemp(join(taskDataRoot, 'native-file-search-'));
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
    const toolEventRecord = firstJournal.replay().find((record) => record.kind === 'operation.event' && record.operationId.value === started.operationId.value && record.event.kind === 'provider.tool-result');
    if (!toolEventRecord || toolEventRecord.kind !== 'operation.event') throw new Error('real local app file.search should yield a journaled runtime tool result');
    const toolEvent = toolEventRecord.event;
    assert.equal(toolEvent.toolId, 'file.search');
    const executionFact = toolEvent.executionFact;
    if (!executionFact) throw new Error('real local app file.search should produce a typed execution fact');
    assert.equal(executionFact.identity.surface, 'responses');
    assert.equal(executionFact.identity.toolId, 'file.search');
    assert.equal(executionFact.identity.bindingRef, binding.bindingId);
    assert.equal(executionFact.identity.route, 'app.file-search.local');
    assert.equal(executionFact.state, 'succeeded');
    assert.equal(executionFact.requestRef, toolEvent.requestId);
    assert.equal(executionFact.callRef, toolEvent.callId);
    assert.equal(executionFact.operationRef, started.operationId.value);
    assert.equal(executionFact.resultRef, toolEvent.outputRef);
    assert.equal(executionFact.resultDigest, toolEvent.outputDigest);
    const eventIdentity = { taskId: task.taskId, operationId: started.operationId, executionEpoch: toolEvent.executionEpoch, seq: toolEvent.seq };
    assert.ok(toolEvent.outputRef);
    assert.ok(toolEvent.outputDigest);
    const report = await firstService.toolOutput(eventIdentity.taskId, eventIdentity.operationId, eventIdentity.executionEpoch, eventIdentity.seq) as Record<string, unknown>;
    assert.equal(report.status, 'succeeded', JSON.stringify(report));
    assert.equal(report.searchComplete, true);
    assert.equal(report.resultsTruncated, false);
    assert.deepEqual(report.unresolvedPaths, []);
    assert.equal(Array.isArray(report.matches), true);

    await firstService.quiesceImplicitConsumption();
    const secondJournal = new UiRuntimeJournal(journalPath);
    const secondExecutor = createResponsesFileToolExecutor({ workspaceRoot, projectKey, artifactRoot: evidenceRoot });
    const secondService = service({ root, adapter, journal: secondJournal, executor: secondExecutor.executor, toolOutputs: secondExecutor.toolOutputs, workspaceRoot, projectKey });
    await secondService.hydrate();
    const restoredEventRecord = secondJournal.replay().find((record) => record.kind === 'operation.event' && record.operationId.value === started.operationId.value && record.event.kind === 'provider.tool-result');
    if (!restoredEventRecord || restoredEventRecord.kind !== 'operation.event') throw new Error('reconstructed journal should contain the runtime tool result');
    const restoredEvent = restoredEventRecord.event;
    assert.deepEqual(restoredEvent?.executionFact, toolEvent.executionFact);
    assert.equal(restoredEvent?.outputRef, toolEvent.outputRef);
    assert.equal(restoredEvent?.outputDigest, toolEvent.outputDigest);
    assert.deepEqual(await secondService.toolOutput(task.taskId, started.operationId, toolEvent.executionEpoch, toolEvent.seq), report);
    const secondAccessControl = await FileAccessControlService.open({ credentialPath, create: false });
    await (async () => {
      let secondServer: Awaited<ReturnType<typeof startUiRuntimeServer>> | undefined;
      try {
        secondServer = await startUiRuntimeServer({ service: secondService, accessControl: secondAccessControl, uiRoot: join(process.cwd(), 'docs', 'ui'), port: 0 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EPERM' && /listen EPERM/.test(error.message))) throw error;
        diagnostics.httpReadback = 'SKIPPED-loopback-listen-EPERM';
      }
      if (secondServer === undefined) return;
      try {
        const response = await fetch(`${secondServer.url}/api/tasks/${task.taskId.value}/operations/${started.operationId.value}/executions/${toolEvent.executionEpoch}/events/${toolEvent.seq}/tool-output`, {
          headers: { cookie },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), report);
        diagnostics.httpReadback = 'PASS';
      } finally {
        await secondServer.close();
      }
    })();

    const expectApiCode = (code: string) => (error: unknown) => error instanceof UiRuntimeApiError && error.code === code;
    await assert.rejects(() => secondService.toolOutput(task.taskId, started.operationId, toolEvent.executionEpoch + 1, toolEvent.seq), expectApiCode('tool-output.event-not-found'));
    await assert.rejects(() => secondService.toolOutput(id('task', 'wrong-task'), started.operationId, toolEvent.executionEpoch, toolEvent.seq), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'task.not.found');
    await assert.rejects(() => secondService.toolOutput(task.taskId, id('operation', 'wrong-operation'), toolEvent.executionEpoch, toolEvent.seq), expectApiCode('tool-output.event-not-found'));

    const outputId = decodeURIComponent(toolEvent.outputRef!.slice('asset://provider-tool/output/'.length));
    const artifactId = `provider-tool-output-${outputId}-${toolEvent.outputDigest!.slice(-12)}`;
    const artifactPath = join(evidenceRoot, 'tool-output', artifactId);
    const originalArtifact = await readFile(artifactPath);
    await rm(artifactPath);
    await assert.rejects(() => secondService.toolOutput(task.taskId, started.operationId, toolEvent.executionEpoch, toolEvent.seq), expectApiCode('tool-output.report-missing-or-changed'));
    await writeFile(artifactPath, 'tampered report bytes', 'utf8');
    await assert.rejects(() => secondService.toolOutput(task.taskId, started.operationId, toolEvent.executionEpoch, toolEvent.seq), expectApiCode('tool-output.report-missing-or-changed'));
    await writeFile(artifactPath, new TextDecoder().decode(originalArtifact), 'utf8');
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
