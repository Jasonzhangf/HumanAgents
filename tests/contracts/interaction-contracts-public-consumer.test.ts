import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  validateInteractionHistoryQuery,
  validateInteractionHistoryResult,
  validateInteractionTraceEntry,
  validateInteractionWorkCard,
  type EvidenceRef,
  type InteractionHistoryQuery,
  type InteractionHistoryResult,
  type InteractionTraceEntry,
  type InteractionWorkCard,
  type ScopeRef,
} from '@humanagent/contracts';

const task = id('task', 'task-interaction-contract');
const operation = id('operation', 'operation-interaction-contract');
const scope: ScopeRef = { organId: id('organ', 'organ-interaction-contract'), taskId: task, operationId: operation };
const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'evidence-interaction-contract'),
  kind: 'tool',
  source: 'interaction-contracts-public-consumer',
  locator: 'interaction-contracts-public-consumer.test.ts',
  scope,
};

function traceEntry(overrides: Partial<InteractionTraceEntry> = {}): InteractionTraceEntry {
  return {
    turnId: 'turn-a',
    requestId: 'request-a',
    seq: 1,
    occurredAt: '2026-11-01T16:00:00Z',
    kind: 'tool-result',
    modelRef: 'model-a',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    tool: {
      callId: 'call-a',
      toolId: 'file.read',
      argumentsRef: 'asset://call-a/arguments',
      argumentsDigest: 'sha256:call-a-arguments',
      status: 'succeeded',
      outputRef: 'asset://call-a/output',
      outputDigest: 'sha256:call-a-output',
      startedAt: '2026-11-01T15:59:59Z',
      durationMs: 1000,
    },
    authorization: {
      scope,
      taskId: task,
      operationId: operation,
      executionEpoch: 1,
      requestedCapabilities: ['file.read'],
      permissionRefs: ['permission://task-a'],
      toolOutputRef: 'asset://call-a/output',
    },
    dependencyEdge: { source: 'turn-a', target: 'turn-b', ref: 'call-a', reason: 'tool-result' },
    evidenceRefs: [evidence],
    state: 'running',
    allowedActions: ['stop'],
    provider: { state: 'ready', lastEventAt: '2026-11-01T15:59:59Z' },
    transport: { connected: true, lastSyncedAt: '2026-11-01T16:00:00Z' },
    settlement: { providerStopped: false, checkpointCommitted: false },
    lastBusiness: { kind: 'tool-result', at: '2026-11-01T16:00:00Z', ref: 'call-a' },
    ...overrides,
  };
}

const historyQuery: InteractionHistoryQuery = {
  cursor: 'cursor-a',
  filter: { taskId: task, operationId: operation, executionEpoch: 1, callId: 'call-a' },
  search: 'call-a',
  replay: true,
  limit: 50,
};

const historyResult: InteractionHistoryResult = {
  ok: true,
  page: { cursor: 'cursor-a', hasMore: false, items: [traceEntry()], filter: historyQuery.filter, replay: true },
};

const workCard: InteractionWorkCard = {
  source: { taskId: task, operationId: operation, executionEpoch: 1, requestId: 'request-a', turnId: 'turn-a' },
  currentNode: 'provider.tool',
  ownerId: 'runtime-a',
  nextStep: 'read tool output',
  nextAction: 'continue',
  waitingOn: 'provider',
  startedAt: '2026-11-01T15:59:59Z',
  provider: { state: 'ready', lastEventAt: '2026-11-01T15:59:59Z' },
  transport: { connected: true, lastSyncedAt: '2026-11-01T16:00:00Z' },
  settlement: { providerStopped: false, checkpointCommitted: false },
  lastBusiness: { kind: 'tool-result', at: '2026-11-01T16:00:00Z', ref: 'call-a' },
};

test('interaction contract public consumer accepts valid trace, history, and work card', () => {
  assert.doesNotThrow(() => validateInteractionTraceEntry(traceEntry()));
  assert.doesNotThrow(() => validateInteractionHistoryQuery(historyQuery));
  assert.doesNotThrow(() => validateInteractionHistoryResult(historyResult));
  assert.doesNotThrow(() => validateInteractionWorkCard(workCard));
});

test('interaction contract rejects tool-call without a typed descriptor', () => {
  assert.throws(() => validateInteractionTraceEntry(traceEntry({ kind: 'tool-call', tool: undefined })), ContractError);
});

test('interaction contract rejects succeeded tool descriptor without output evidence', () => {
  assert.throws(() => validateInteractionTraceEntry(traceEntry({ tool: { ...traceEntry().tool!, outputRef: undefined, outputDigest: undefined } })), ContractError);
});

test('interaction contract rejects authorization output reference conflicts', () => {
  assert.throws(() => validateInteractionTraceEntry(traceEntry({ authorization: { ...traceEntry().authorization, toolOutputRef: 'asset://call-a/other-output' } })), ContractError);
});

test('interaction contract accepts legal assistant and running tool-call entries', () => {
  assert.doesNotThrow(() => validateInteractionTraceEntry(traceEntry({ kind: 'assistant', tool: undefined })));
  assert.doesNotThrow(() => validateInteractionTraceEntry(traceEntry({
    kind: 'tool-call',
    tool: {
      callId: 'call-a',
      toolId: 'file.read',
      argumentsRef: 'asset://call-a/arguments',
      argumentsDigest: 'sha256:call-a-arguments',
      status: 'running',
    },
  })));
});

test('interaction contract accepts broader and matching authorization scopes', () => {
  assert.doesNotThrow(() => validateInteractionTraceEntry(traceEntry({ authorization: { ...traceEntry().authorization, scope: { organId: scope.organId } } })));
  assert.doesNotThrow(() => validateInteractionTraceEntry(traceEntry()));
});

test('interaction contract rejects incomplete history pages and missing work card identity', () => {
  assert.throws(() => validateInteractionHistoryResult({ ok: true, page: { hasMore: false, items: [traceEntry({ tool: undefined })] } }), ContractError);
  assert.throws(() => validateInteractionWorkCard({ ...workCard, source: { ...workCard.source, turnId: '' } }), ContractError);
});
