import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandOperationRuntime } from '../../packages/app/src/index.js';
import { CodeSearchRoute, WebSearchRoute, webSearchRegistration, type CodeSearchArtifactStore, type WebSearchArtifactStore } from '../../packages/adapters/operations/src/index.js';
import { id, type EvidenceRef, type OperationEvent, type OperationIntent, type Scope, type WebSearchReport, type WebSearchRequest } from '../../packages/contracts/src/index.js';
import type { OperationJournalPort } from '../../packages/runtime/src/gateway/index.js';
import type { CodeSearchFunctions, WebSearchProvider } from '../../packages/runtime/src/hand/index.js';

const organ = id('organ', 'web-search-app-organ');
const task = id('task', 'web-search-app-task');
const cycle = id('cycle', 'web-search-app-cycle');
const operation = id('operation', 'web-search-app-operation');
const scope: Scope = { organId: organ, taskId: task, cycleId: cycle };
const evidence = (label: string): EvidenceRef => ({ evidenceId: id('evidence', `web-search-${label}`), kind: 'operation', source: 'web-search-test', locator: `test://${label}`, scope });
const journal: OperationJournalPort = { async commit(_event: OperationEvent) {}, async publishCommitted(_event: OperationEvent) {} };

test('app assembly registers web.search as one provider-backed gateway operation', async () => {
  const request: WebSearchRequest = { serviceId: 'web.search', contractVersion: '1.0.0', query: 'gateway', domains: ['example.com'], maxResults: 2 };
  const reports = new Map<string, WebSearchReport>();
  const artifacts: WebSearchArtifactStore = {
    async readRequest() { return request; },
    async writeReport(input) { const outputRef = `artifact://web-search/${input.operationId.value}`; reports.set(outputRef, input.report); return { outputRef, outputDigest: 'sha256:web-search-report' }; },
    async readReport(input) { const report = reports.get(input.outputRef); if (!report || input.outputDigest !== 'sha256:web-search-report') throw new Error('missing web search report'); return report; },
  };
  const provider: WebSearchProvider = {
    async search(input) { assert.deepEqual(input.domains, ['example.com']); return { complete: true, unresolvedSources: [], results: [{ url: 'https://example.com/result', title: 'Result', snippet: 'Snippet', rank: 1 }] }; },
  };
  const route = new WebSearchRoute({ provider, artifacts, now: () => '2026-09-20T00:00:00.000Z' });
  const hand = createHandOperationRuntime({
    webSearchRoute: route,
    permissions: { async readGrant() { return { scope, revoked: false, evidenceRefs: [evidence('permission')] }; } },
    taskBoundaries: { async readBoundary() { return { scope, evidenceRefs: [evidence('boundary')] }; } },
    journal,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });
  const intent: OperationIntent = {
    operationId: operation,
    taskId: task,
    cycleId: cycle,
    requestedBy: 'web-search-test',
    intentRevision: 'revision-1',
    kind: 'inspect',
    toolName: 'web.search',
    inputRef: 'artifact://input/web-search',
    inputDigest: 'sha256:web-search-input',
    requestedScope: scope,
    idempotencyKey: 'web-search-idempotency',
    expectedOutput: { schemaRef: 'schema://web.search.report/v1', requiredEvidenceKinds: ['tool'] },
  };
  const result = await hand.execute({ intent });
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.route?.routeId, 'web-search');
  const outputRef = 'artifact://web-search/web-search-app-operation';
  const report = reports.get(outputRef)!;
  assert.equal(report.domains[0], 'example.com');
  reports.set(outputRef, { ...report, results: [...report.results, { url: 'https://example.com/forged', title: 'Forged', snippet: 'Forged', rank: 2 }, { url: 'https://example.com/forged-2', title: 'Forged 2', snippet: 'Forged 2', rank: 3 }], resultsFound: 3 });
  const forged = await route.verify({
    intent,
    effectiveScope: scope,
    observation: { operationId: intent.operationId, outputRef, outputDigest: 'sha256:web-search-report', evidenceRefs: [evidence('forged')] },
  });
  assert.equal(forged.status, 'failed');
});

test('web.search route aborts and drains an in-flight provider before confirming stop', async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const request: WebSearchRequest = { serviceId: 'web.search', contractVersion: '1.0.0', query: 'cancel' };
  const artifacts: WebSearchArtifactStore = {
    async readRequest() { return request; },
    async writeReport() { throw new Error('report must not be written after abort'); },
    async readReport() { throw new Error('not used'); },
  };
  const provider: WebSearchProvider = {
    async search(input) {
      started();
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw Object.assign(new Error('provider aborted'), { name: 'AbortError' });
    },
  };
  const route = new WebSearchRoute({ provider, artifacts, stopDrainTimeoutMs: 100 });
  const intent: OperationIntent = {
    operationId: id('operation', 'web-search-cancel-operation'), taskId: task, cycleId: cycle, requestedBy: 'test', intentRevision: '1', kind: 'inspect', toolName: 'web.search',
    inputRef: 'artifact://cancel', inputDigest: 'sha256:cancel', requestedScope: scope, idempotencyKey: 'cancel', expectedOutput: { schemaRef: 'schema://web.search.report/v1', requiredEvidenceKinds: [] },
  };
  const executing = route.execute({ intent, effectiveScope: scope, executionEpoch: 1 });
  await startedPromise;
  const stopped = await route.stop({
    intent,
    registration: webSearchRegistration(),
    route: { operationId: intent.operationId, routeId: 'web-search', routeVersion: 'web-search.v1', mode: 'gateway', contractVersion: '1.0.0', effectiveScope: scope, selectionReason: 'test', selectedAt: '2026-09-20T00:00:00.000Z' },
    executionEpoch: 1,
    owner: 'humanagent.operations.web-search',
  });
  assert.equal(stopped.stopped, true);
  await assert.rejects(() => executing, /aborted/);
});

test('code.search does not confirm stop while another read worker is still pending', async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let releasePending!: () => void;
  const pending = new Promise<void>((resolve) => { releasePending = resolve; });
  const request = { serviceId: 'code.search' as const, contractVersion: '1.0.0' as const, workspaceRef: 'workspace://fixture', path: '.', query: 'needle', queryKind: 'literal' as const };
  const functions: CodeSearchFunctions = {
    async findFiles() { return { paths: ['fast.ts', 'pending.ts'], complete: true, unresolvedPaths: [] }; },
    async readFile(input) {
      started();
      if (input.path === 'fast.ts') {
        await new Promise<void>((resolve, reject) => input.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      } else {
        await pending;
      }
      return { path: input.path, content: 'needle' };
    },
  };
  const artifacts: CodeSearchArtifactStore = {
    async readRequest() { return request; },
    async writeReport() { throw new Error('report must not be written'); },
    async readReport() { throw new Error('not used'); },
  };
  const route = new CodeSearchRoute({ functions, artifacts, stopDrainTimeoutMs: 20 });
  const intent: OperationIntent = {
    operationId: id('operation', 'code-search-cancel-operation'), taskId: task, cycleId: cycle, requestedBy: 'test', intentRevision: '1', kind: 'inspect', toolName: 'code.search',
    inputRef: 'artifact://code-cancel', inputDigest: 'sha256:code-cancel', requestedScope: scope, idempotencyKey: 'code-cancel', expectedOutput: { schemaRef: 'schema://code.search.report/v1', requiredEvidenceKinds: [] },
  };
  const executing = route.execute({ intent, effectiveScope: scope, executionEpoch: 1 });
  await startedPromise;
  const stopped = await route.stop({
    intent,
    registration: { toolName: 'code.search', contractVersion: '1.0.0', supportedKinds: ['inspect'], routeId: 'code-search', routeVersion: 'code-search.v1', mode: 'gateway', acceptedScopes: [{}], inputContract: 'schema://code.search.request/v1', outputContract: 'schema://code.search.report/v1', verifier: 'verifier://code.search/v1', capabilities: ['workspace.code-search'], retryPolicy: 'retry://read-only/v1', owner: 'humanagent.operations.code-search' },
    route: { operationId: intent.operationId, routeId: 'code-search', routeVersion: 'code-search.v1', mode: 'gateway', contractVersion: '1.0.0', effectiveScope: scope, selectionReason: 'test', selectedAt: '2026-09-20T00:00:00.000Z' },
    executionEpoch: 1,
    owner: 'humanagent.operations.code-search',
  });
  assert.equal(stopped.stopped, false);
  releasePending();
  await assert.rejects(() => executing, /aborted/);
});
