import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type InteractionHistoryQuery,
  type InteractionHistoryResult,
  type InteractionTraceEntry,
  type InteractionWorkCard,
  type ScopeRef,
} from '@humanagent/contracts';
import {
  projectInteractionWorkCard,
  type InteractionCardConversationSource,
  type InteractionCardHistorySource,
  type InteractionCardNodeInput,
  type InteractionCardSource,
} from '../../packages/ui/index.js';
import { UiProjectionError } from '../../packages/ui/contracts/models.js';

const organ = id('organ', 'organ-ui-projection');
const task = id('task', 'task-ui-projection');
const operation = id('operation', 'operation-ui-projection');
const scope: ScopeRef = { organId: organ, taskId: task, operationId: operation };

function evidence(ref: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${ref}`),
    kind: 'tool',
    source: 'public-consumer',
    locator: `interaction-projection-public.test.ts#${ref}`,
    digest: `sha256:${ref}`,
    scope,
  };
}

function traceEntry(seq: number, kind: InteractionTraceEntry['kind']): InteractionTraceEntry {
  const callId = `call-${seq}`;
  return {
    turnId: `turn-${seq}`,
    requestId: `request-${seq}`,
    seq,
    occurredAt: '2026-11-01T16:00:00Z',
    kind,
    modelRef: 'model-public',
    taskId: task,
    operationId: operation,
    executionEpoch: 1,
    tool: kind === 'tool-call' || kind === 'tool-result'
      ? {
          callId,
          toolId: kind === 'tool-call' ? 'artifact.read' : 'artifact.write',
          argumentsRef: `asset://${callId}/arguments`,
          argumentsDigest: `sha256:${callId}-args`,
          status: kind === 'tool-result' ? 'succeeded' : 'running',
          outputRef: kind === 'tool-result' ? `asset://${callId}/output` : undefined,
          outputDigest: kind === 'tool-result' ? `sha256:${callId}-output` : undefined,
          startedAt: '2026-11-01T15:59:59Z',
          durationMs: kind === 'tool-result' ? 25 : undefined,
        }
      : undefined,
    authorization: {
      scope,
      taskId: task,
      operationId: operation,
      executionEpoch: 1,
      requestedCapabilities: [kind],
      permissionRefs: ['permission://task-ui'],
      toolOutputRef: kind === 'tool-result' ? `asset://${callId}/output` : `trace://no-output-${seq}`,
    },
    dependencyEdge: { source: `turn-${seq}`, target: `turn-${seq + 1}`, ref: callId, reason: 'continuation' },
    evidenceRefs: [evidence(`trace-${seq}`)],
    state: 'running',
    allowedActions: ['review-trace'],
    provider: { state: 'ready', lastEventAt: '2026-11-01T15:59:59Z' },
    transport: { connected: true, lastSyncedAt: '2026-11-01T16:00:00Z' },
    settlement: { providerStopped: false, checkpointCommitted: false },
    lastBusiness: { kind, at: '2026-11-01T16:00:00Z', ref: callId },
  };
}

const conversation: InteractionCardConversationSource = {
  goal: { text: 'Produce the report' },
  scope: { text: 'Only authorized descriptors' },
  constraints: [{ text: 'Do not fetch raw payload', sourceKind: 'user' }],
  deliverables: [{ text: 'Trace and result card' }],
  turns: [
    { sourceKind: 'user', occurredAt: '2026-11-01T16:00:01Z', markdown: 'Please run #tool-secret' },
    { sourceKind: 'assistant', occurredAt: '2026-11-01T16:00:02Z', markdown: 'Done: **result**' },
    { sourceKind: 'progress', occurredAt: '2026-11-01T16:00:03Z', markdown: 'Reading report.md' },
    {
      sourceKind: 'error',
      occurredAt: '2026-11-01T16:00:05Z',
      markdown: 'Provider stopped',
      error: {
        headline: 'Provider stopped',
        nextStep: 'Wait for checkpoint',
        details: { code: 'E_STOPPED', nextStep: 'Wait for checkpoint' },
      },
    },
    { sourceKind: 'result', occurredAt: '2026-11-01T16:00:06Z', markdown: 'Final result', artifacts: [{ kind: 'link', ref: 'asset://result', label: 'result.md', digest: 'sha256:result', mediaType: 'text/markdown' }] },
  ],
};

const history: InteractionCardHistorySource = {
  query: {
    cursor: 'cursor-1',
    filter: { taskId: task, operationId: operation, executionEpoch: 1 },
    search: 'artifact',
    replay: true,
    limit: 30,
  } satisfies InteractionHistoryQuery,
  result: {
    ok: true,
    page: {
      cursor: 'cursor-2',
      hasMore: true,
      filter: { kinds: ['status'] },
      replay: true,
      items: [traceEntry(1, 'status'), traceEntry(2, 'tool-call'), traceEntry(3, 'tool-result')],
    },
  } satisfies InteractionHistoryResult,
};

const card: InteractionWorkCard = {
  source: { taskId: task, operationId: operation, executionEpoch: 2, requestId: 'request-2', turnId: 'turn-2' },
  currentNode: 'provider.tool',
  ownerId: 'runtime-projection',
  nextStep: 'read authorized output descriptor',
  nextAction: 'review-trace',
  waitingOn: 'provider',
  startedAt: '2026-11-01T15:59:59Z',
  provider: { state: 'ready', lastEventAt: '2026-11-01T15:59:59Z' },
  transport: { connected: true, lastSyncedAt: '2026-11-01T16:00:00Z', cursor: 'cursor-2' },
  settlement: { providerStopped: false, checkpointCommitted: false },
  lastBusiness: { kind: 'tool-result', at: '2026-11-01T16:00:00Z', ref: 'call-3' },
};

const nodeCards: InteractionCardNodeInput[] = [{
  nodeId: 'memory.curation',
  title: 'Memory curation',
  readOnly: true,
  inputDescriptors: [{ kind: 'reading', ref: 'asset://memory-input', label: 'input.md', digest: 'sha256:memory-input' }],
  outputDescriptors: [],
}];

const cardSource: InteractionCardSource = {
  source: { state: 'ready', label: '交互卡片' },
  taskState: 'running',
  conversation,
  actions: [
    { id: 'review-trace', label: '轨迹', executable: true },
    { id: 'unsupported-control', label: 'Control', executable: false, unavailableReason: 'not authorized by source' },
  ],
  card,
  history,
  nodeCards,
};

test('interaction work card public export separates human summary from technical trace', () => {
  const projection = projectInteractionWorkCard(cardSource);

  assert.equal(projection.surface, 'interaction-work-card');
  assert.deepEqual(projection.statusbar, { state: 'ready', label: '交互卡片' });
  assert.equal(projection.taskState, 'running');
  assert.equal(projection.conversation.turns.some((turn) => turn.sourceKind === 'error'), true);
  assert.equal(projection.conversation.turns.every((turn) => !('tool' in turn)), true);
  assert.equal(projection.trace.items.length, 3);
  assert.deepEqual(projection.actions.map((action) => action.availability), ['executable', 'unsupported']);
  assert.equal(projection.nodeCards[0].readOnly, true);
});

test('interaction projection keeps technical metadata in cardMetadata and trace details', () => {
  const projection = projectInteractionWorkCard(cardSource);

  assert.deepEqual(projection.cardMetadata.source, card.source);
  assert.equal(projection.cardMetadata.currentNode, 'provider.tool');
  assert.equal(projection.history.result, 'ok');
  assert.equal(projection.history.result === 'ok' && projection.history.hasMore, true);
  assert.equal(projection.trace.items[2].tool?.callId, 'call-3');
});

test('interaction projection rejects entries that violate typed history scope', () => {
  assert.throws(() => projectInteractionWorkCard({
    ...cardSource,
    history: {
      query: { filter: { taskId: task, operationId: operation, executionEpoch: 1, kinds: ['tool-call'] }, limit: 30 },
      result: { ok: true, page: { hasMore: false, items: [traceEntry(4, 'status')] } },
    },
  }), UiProjectionError);
});
