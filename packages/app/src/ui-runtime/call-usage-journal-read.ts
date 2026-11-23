import type { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import {
  createJsonlActiveTurnSegmentJournal,
  decodeActiveTurnRecords,
  listTaskActiveTurnBindings,
} from '../../../adapters/jsonl/src/active-turn.js';
import { activeTurnCommitId, type ActiveTurnJournalRecord } from '../../../runtime/src/context/active-turn-journal.js';
import type { JsonlInteractionParentTurnJournal } from '../../../adapters/jsonl/src/interaction-parent-turn-journal.js';
import type {
  AcceptedRawFact,
  AnyProviderExecutionIdentityRef,
  ProductReadMode,
  OrganId,
  ProviderRawFact,
  RuntimeRequestRecord,
  TaskId,
} from '../../../contracts/src/index.js';
import { id } from '../../../contracts/src/index.js';
import { activeTurnSegmentCommitId } from '../../../contracts/src/active-turn-segments.js';
import type { RuntimeReadFailure, RuntimeReadResult } from '../../../ui/contracts/runtime.js';
import type { CallUsageInput } from './call-usage-read.js';

type UsageFact = Extract<ProviderRawFact, { readonly kind: 'usage' }>;

export interface JournalCallUsageReaderOptions {
  readonly organId: OrganId;
  readonly interactionScopeId: string;
  readonly controlJournal: JsonlOrganJournal;
  readonly parentJournal: Pick<JsonlInteractionParentTurnJournal, 'readInteractionUsage'>;
}

export interface JournalCallUsageReadInput {
  readonly projectKey: string;
  readonly mode: ProductReadMode;
  readonly interactionId?: string;
  readonly taskId?: string;
  readonly occurrenceTaskIds?: readonly string[];
}

class CallUsageFold {
  private readonly requests = new Map<string, { turnId: string; seq: number }>();
  private readonly usage = new Map<string, UsageFact>();

  acceptRequest(record: RuntimeRequestRecord, seq: number, turnId = record.request.turnId): void {
    const existing = this.requests.get(record.request.requestId);
    if (existing === undefined) {
      this.requests.set(record.request.requestId, { turnId, seq });
      return;
    }
    if (existing.turnId !== turnId) {
      throw new Error(`call usage request identity is reused by another turn: ${record.request.requestId}`);
    }
  }

  acceptFact(entry: AcceptedRawFact<AnyProviderExecutionIdentityRef>): void {
    if (entry.envelope.fact.kind !== 'usage') return;
    const requestId = entry.envelope.request.requestId;
    const existing = this.usage.get(requestId);
    if (existing !== undefined) {
      throw new Error(`call usage has more than one usage fact for request: ${requestId}`);
    }
    this.usage.set(requestId, entry.envelope.fact);
  }

  rows(): readonly CallUsageInput[] {
    return [...this.requests].sort((a, b) => a[1].seq - b[1].seq).map(([callId, { turnId }]): CallUsageInput => {
      const fact = this.usage.get(callId);
      return fact === undefined
        ? { callId, turnId }
        : {
            callId, turnId,
            ...usageFields(fact),
          };
    });
  }
}

function usageFields(fact: UsageFact): Pick<
  CallUsageInput,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'contextLimit' | 'elapsedMs'
> {
  const cacheRead = fact.cacheReadInputTokens;
  const cacheWrite = fact.cacheCreationInputTokens;
  const inputTokens = fact.protocol === 'anthropic'
    ? fact.inputTokens === undefined || cacheRead === undefined || cacheWrite === undefined
      ? undefined
      : fact.inputTokens + cacheRead + cacheWrite
    : fact.inputTokens;
  const elapsed = Math.max(
    0,
    Math.round(Date.parse(fact.timing.endedAt) - Date.parse(fact.timing.startedAt)),
  );
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(fact.outputTokens === undefined ? {} : { outputTokens: fact.outputTokens }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(fact.capacity.state === 'known' ? { contextLimit: effectiveContextLimit(fact) } : {}),
    ...(Number.isSafeInteger(elapsed) && elapsed > 0 ? { elapsedMs: elapsed } : {}),
  };
}

function effectiveContextLimit(fact: UsageFact): number {
  if (fact.capacity.state !== 'known') throw new Error('call usage capacity must be known');
  const effective = fact.capacity.effectiveContextWindowPercent === undefined
    ? fact.capacity.contextWindow
    : Math.floor(fact.capacity.contextWindow * fact.capacity.effectiveContextWindowPercent / 100);
  if (!Number.isSafeInteger(effective) || effective <= 0) {
    throw new Error(`call usage capacity is not a positive token limit: ${fact.responseModel ?? 'unknown model'}`);
  }
  return effective;
}

function readFailure(message: string, nextAction: string): { readonly ok: false; readonly failure: RuntimeReadFailure } {
  return {
    ok: false,
    failure: {
      code: 'call-usage.journal-read-failed',
      ownerId: 'humanagent.app.ui-runtime.call-usage',
      message,
      nextAction,
    },
  };
}

export function createJournalCallUsageReader(
  options: JournalCallUsageReaderOptions,
): { readonly read: (input: JournalCallUsageReadInput) => Promise<RuntimeReadResult<readonly CallUsageInput[]>> } {
  return {
    read: async (input) => {
      try {
        if (input.taskId !== undefined) {
          const ids = new Set([input.taskId, ...input.occurrenceTaskIds ?? []]);
          return { ok: true, value: await taskRows(options, [...ids].map(value => id('task', value))) };
        }
        if (input.interactionId !== undefined) {
          return { ok: true, value: await interactionRows(options, input.interactionId) };
        }
        return { ok: true, value: [] };
      } catch (error) {
        return readFailure(
          error instanceof Error ? error.message : 'committed call usage facts could not be read',
          'repair the committed Provider request and usage facts before reading call usage',
        );
      }
    },
  };
}

async function interactionRows(
  options: JournalCallUsageReaderOptions,
  interactionId: string,
): Promise<readonly CallUsageInput[]> {
  const snapshot = await options.parentJournal.readInteractionUsage({
    organId: options.organId,
    interactionScopeId: options.interactionScopeId,
    interactionId,
  });
  const fold = new CallUsageFold();
  for (const request of snapshot.requests) fold.acceptRequest(request.fact, request.commit.journalSeq);
  for (const accepted of snapshot.acceptedFacts) fold.acceptFact(accepted.fact);
  return fold.rows();
}

async function taskRows(options: JournalCallUsageReaderOptions, taskIds: readonly TaskId[]): Promise<readonly CallUsageInput[]> {
  const records = await options.controlJournal.replay();
  const bindings = (await Promise.all(taskIds.map(taskId => listTaskActiveTurnBindings({
    journal: { replay: async () => records },
    scope: { organId: options.organId, taskId },
  })))).flat();
  const sequences = new Map(records.map(record => [record.commitId, record.seq]));
  const fold = new CallUsageFold();
  function accept(record: ActiveTurnJournalRecord, turnId: string, commitId: (suffix: string) => string) {
    if (record.kind === 'accepted-fact') fold.acceptFact(record.entry);
    if (record.kind !== 'request') return;
    const request = record.record;
    const seq = sequences.get(commitId(`request:${request.request.requestId}:${request.phase}`));
    if (seq !== undefined) fold.acceptRequest(request, seq, turnId);
  }
  for (const binding of [...bindings].sort((left, right) => left.commitRef.journalSeq - right.commitRef.journalSeq)) {
    const businessTurnId = binding.binding.admittedTurn.turnId;
    const segmentJournal = createJsonlActiveTurnSegmentJournal({ journal: options.controlJournal, businessTurnId });
    for (const record of decodeActiveTurnRecords(records, businessTurnId)) {
      accept(record, businessTurnId, suffix => activeTurnCommitId(businessTurnId, suffix));
    }
    const segments = await segmentJournal.readSegments(businessTurnId);
    for (const segment of segments) {
      const recordsForSegment = await segmentJournal.readSegmentRecords({ businessTurnId, segmentId: segment.segmentId });
      for (const record of recordsForSegment) {
        accept(record, businessTurnId, suffix => activeTurnSegmentCommitId(segment.segmentId, suffix));
      }
    }
  }
  return fold.rows();
}
