import {
  id,
  validateInteractionHistoryQuery,
  type InteractionHistoryQuery,
  type InteractionHistoryResult,
  type InteractionTraceEntry,
  type InteractionTraceKind,
} from '../../../contracts/src/index.js';
import type { RuntimeTaskEvent, RuntimeTaskSnapshot } from '../../../runtime/src/ui-runtime/coordinator.js';

/**
 * The public trace of one task, projected only from real runtime/provider facts.
 *
 * Every entry carries the identity and the occurrence time the provider binding
 * itself reported. When the source reported no turn id, the entry simply has no
 * `turnId`; this projection never mints one, and it never substitutes a render
 * time for an event time.
 */

const RUNTIME_TRACE_KIND: Readonly<Record<RuntimeTaskEvent['kind'], InteractionTraceKind>> = {
  'execution.started': 'status',
  'provider.model': 'status',
  'provider.output': 'assistant',
  'provider.tool': 'tool-call',
  'provider.tool-result': 'tool-result',
  'provider.error': 'failure',
  'execution.settling': 'status',
  'checkpoint.committed': 'status',
  'execution.terminal': 'status',
  'attention.opened': 'decision',
  'attention.resolved': 'decision',
};

function traceKind(event: RuntimeTaskEvent): InteractionTraceKind {
  if (event.kind === 'execution.terminal') {
    if (event.state === 'failed') return 'failure';
    if (event.state === 'stopped' || event.state === 'cancelled') return 'cancel';
  }
  return RUNTIME_TRACE_KIND[event.kind];
}

function toolDescriptor(event: RuntimeTaskEvent): InteractionTraceEntry['tool'] {
  if (event.kind !== 'provider.tool' && event.kind !== 'provider.tool-result') return undefined;
  const callId = event.callId;
  const toolId = event.toolId;
  if (!callId || !toolId) return undefined;
  const status = event.status ?? (event.kind === 'provider.tool' ? 'running' : 'unknown');
  const outputRef = event.outputRef;
  const outputDigest = event.outputDigest;
  const hasPairedRefs = (outputRef === undefined) === (outputDigest === undefined);
  return {
    callId,
    toolId,
    status,
    ...(hasPairedRefs && outputRef !== undefined ? { outputRef, outputDigest } : {}),
    ...(event.error === undefined ? {} : {
      error: {
        code: event.error.code,
        message: event.error.message,
        ownerId: event.error.ownerId,
        evidenceRefs: event.error.evidenceRefs,
      },
    }),
  };
}

function toTraceEntry(event: RuntimeTaskEvent): InteractionTraceEntry {
  const tool = toolDescriptor(event);
  return {
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(event.parentRequestId === undefined ? {} : { parentRequestId: event.parentRequestId }),
    seq: event.seq,
    // The provider-reported occurrence time is the real event time; the runtime
    // receipt time is used only when the provider reported none.
    occurredAt: event.providerOccurredAt ?? event.occurredAt,
    kind: traceKind(event),
    summary: event.summary,
    taskId: event.taskId,
    operationId: id('operation', event.operationId),
    executionEpoch: event.executionEpoch,
    ...(tool === undefined ? {} : { tool }),
    evidenceRefs: event.evidenceRefs,
    state: event.state,
  };
}

function matchesQuery(entry: InteractionTraceEntry, query: InteractionHistoryQuery): boolean {
  const filter = query.filter;
  if (!filter) return true;
  if (filter.kinds !== undefined && !filter.kinds.includes(entry.kind)) return false;
  if (filter.taskId !== undefined && (filter.taskId.scope !== entry.taskId.scope || filter.taskId.value !== entry.taskId.value)) return false;
  if (filter.operationId !== undefined && (filter.operationId.scope !== entry.operationId.scope || filter.operationId.value !== entry.operationId.value)) return false;
  if (filter.executionEpoch !== undefined && filter.executionEpoch !== entry.executionEpoch) return false;
  if (filter.callId !== undefined && filter.callId !== entry.tool?.callId) return false;
  if (filter.fromSeq !== undefined && entry.seq < filter.fromSeq) return false;
  if (filter.toSeq !== undefined && entry.seq > filter.toSeq) return false;
  return true;
}

function matchesSearch(entry: InteractionTraceEntry, search: string): boolean {
  const needle = search.toLowerCase();
  return (entry.summary ?? '').toLowerCase().includes(needle)
    || entry.state.toLowerCase().includes(needle)
    || (entry.turnId ?? '').toLowerCase().includes(needle)
    || (entry.requestId ?? '').toLowerCase().includes(needle)
    || (entry.tool?.callId ?? '').toLowerCase().includes(needle)
    || (entry.tool?.toolId ?? '').toLowerCase().includes(needle);
}

export function projectRuntimeTaskHistory(
  task: RuntimeTaskSnapshot,
  query: InteractionHistoryQuery,
): InteractionHistoryResult {
  validateInteractionHistoryQuery(query);
  const all = task.events
    .map(toTraceEntry)
    .filter((entry) => matchesQuery(entry, query))
    .filter((entry) => (query.search === undefined ? true : matchesSearch(entry, query.search)))
    .sort((left, right) => left.seq - right.seq);
  if (query.cursor !== undefined) {
    const cursor = Number(query.cursor);
    if (!Number.isSafeInteger(cursor)) {
      return {
        ok: false,
        failure: {
          code: 'stale-cursor',
          message: `history cursor ${query.cursor} is not a runtime event sequence`,
          retryable: false,
        },
      };
    }
    const older = all.filter((entry) => entry.seq < cursor);
    const page = older.slice(-query.limit);
    return {
      ok: true,
      page: {
        cursor: page.length === older.length ? undefined : String(page[0]!.seq),
        hasMore: page.length !== older.length,
        items: page,
        ...(query.filter === undefined ? {} : { filter: query.filter }),
        ...(query.replay === undefined ? {} : { replay: query.replay }),
      },
    };
  }
  const page = all.slice(-query.limit);
  return {
    ok: true,
    page: {
      cursor: page.length === all.length ? undefined : String(page[0]!.seq),
      hasMore: page.length !== all.length,
      items: page,
      ...(query.filter === undefined ? {} : { filter: query.filter }),
      ...(query.replay === undefined ? {} : { replay: query.replay }),
    },
  };
}
