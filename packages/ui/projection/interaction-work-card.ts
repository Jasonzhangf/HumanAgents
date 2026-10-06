import {
  validateInteractionHistoryQuery,
  validateInteractionHistoryResult,
  validateInteractionTraceEntry,
  validateInteractionWorkCard,
  type EvidenceRef,
  type InteractionHistoryFailure,
  type InteractionHistoryFilter,
  type InteractionHistoryQuery,
  type InteractionHistoryResult,
  type InteractionTraceEntry,
  type InteractionTraceLastBusiness,
  type InteractionTraceProvider,
  type InteractionTraceSettlement,
  type InteractionTraceTransport,
  type InteractionWorkCard,
  type LifecycleState,
  type ScopedId,
  type TaskId,
} from '@humanagent/contracts';
import { UiProjectionError, type UiDataSource } from '../contracts/models.js';

const INTERACTION_CARD_SURFACE = 'interaction-work-card' as const;

export type InteractionCardSurface = typeof INTERACTION_CARD_SURFACE;

export type InteractionActionAvailability = 'executable' | 'unsupported';

export type InteractionDescriptorKind = 'reading' | 'link' | 'output' | 'artifact';

export interface InteractionArtifactDescriptor {
  readonly kind?: InteractionDescriptorKind;
  readonly ref: string;
  readonly label?: string;
  readonly mediaType?: string;
  readonly digest?: string;
}

export interface InteractionErrorDetailDescriptor {
  readonly headline: string;
  readonly nextStep?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type InteractionConversationKind =
  | 'user'
  | 'assistant'
  | 'progress'
  | 'draft'
  | 'decision'
  | 'error'
  | 'result';

export interface InteractionConversationTurnInput {
  readonly sourceKind: InteractionConversationKind;
  readonly occurredAt?: string;
  readonly markdown?: string;
  readonly artifacts?: readonly InteractionArtifactDescriptor[];
  readonly error?: InteractionErrorDetailDescriptor;
}

export interface InteractionTextFact {
  readonly text: string;
  readonly sourceKind?: InteractionConversationKind;
  readonly sourceRef?: string;
}

export interface InteractionCardSummaryInput {
  readonly goal?: InteractionTextFact;
  readonly scope?: InteractionTextFact;
  readonly constraints?: readonly InteractionTextFact[];
  readonly deliverables?: readonly InteractionTextFact[];
}

export type InteractionCardSummaryProjection =
  | InteractionCardSummaryInput
  | { readonly missing: true };

export interface InteractionCardConversationInput extends InteractionCardSummaryInput {
  readonly turns: readonly InteractionConversationTurnInput[];
}

export interface InteractionCardActionInput {
  readonly id: string;
  readonly label: string;
  readonly executable: boolean;
  readonly unavailableReason?: string;
}

export interface InteractionCardNodeInput {
  readonly nodeId: string;
  readonly title: string;
  readonly state?: LifecycleState;
  readonly stateLabel?: string;
  readonly readOnly: true;
  readonly summary?: string;
  readonly inputDescriptors?: readonly InteractionArtifactDescriptor[];
  readonly outputDescriptors?: readonly InteractionArtifactDescriptor[];
}

export interface InteractionHistorySource {
  readonly query: InteractionHistoryQuery;
  readonly result: InteractionHistoryResult;
}

export interface InteractionCardInput {
  readonly taskState: LifecycleState;
  readonly source: UiDataSource;
  readonly card: InteractionWorkCard;
  readonly conversation?: InteractionCardConversationInput;
  readonly actions?: readonly InteractionCardActionInput[];
  readonly history?: InteractionHistorySource;
  readonly nodeCards?: readonly InteractionCardNodeInput[];
}

export type InteractionCardConversationSource = InteractionCardConversationInput;
export type InteractionCardHistorySource = InteractionHistorySource;
export type InteractionCardSource = InteractionCardInput;

export interface InteractionCardMetadataProjection {
  readonly source: InteractionWorkCard['source'];
  readonly currentNode: string;
  readonly ownerId: string;
  readonly nextStep: string;
  readonly nextAction: string;
  readonly waitingOn?: string;
  readonly startedAt: string;
  readonly provider: InteractionTraceProvider;
  readonly transport: InteractionTraceTransport;
  readonly settlement: InteractionTraceSettlement;
  readonly lastBusiness: InteractionTraceLastBusiness;
}

export interface InteractionConversationTurnProjection {
  readonly sourceKind: InteractionConversationKind;
  readonly occurredAt?: string;
  readonly markdown?: string;
  readonly artifacts?: readonly InteractionArtifactDescriptor[];
  readonly error?: InteractionErrorDetailDescriptor;
}

export interface InteractionConversationProjection {
  readonly summary: InteractionCardSummaryProjection;
  readonly turns: readonly InteractionConversationTurnProjection[];
}

export interface InteractionActionProjection {
  readonly id: string;
  readonly label: string;
  readonly availability: InteractionActionAvailability;
  readonly unavailableReason?: string;
}

export interface InteractionTraceProjection {
  readonly count: number;
  readonly items: readonly InteractionTraceEntry[];
}

export interface InteractionHistoryProjection {
  readonly query: InteractionHistoryQuery;
  readonly cursor?: string;
  readonly hasMore: boolean;
  readonly filter?: InteractionHistoryFilter;
  readonly replay?: boolean;
  readonly count: number;
  readonly items: readonly InteractionTraceEntry[];
}

export interface InteractionHistoryFailureProjection {
  readonly code: InteractionHistoryFailure['code'];
  readonly message: string;
  readonly retryable: boolean;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface InteractionHistoryMissingProjection {
  readonly result: 'missing';
  readonly count: 0;
  readonly items: readonly [];
}

export interface InteractionNodeCardProjection {
  readonly nodeId: string;
  readonly title: string;
  readonly state?: LifecycleState;
  readonly stateLabel?: string;
  readonly readOnly: true;
  readonly summary?: string;
  readonly inputDescriptors?: readonly InteractionArtifactDescriptor[];
  readonly outputDescriptors?: readonly InteractionArtifactDescriptor[];
}

export interface InteractionWorkCardProjection {
  readonly surface: InteractionCardSurface;
  readonly taskState: LifecycleState;
  readonly statusbar: UiDataSource;
  readonly cardMetadata: InteractionCardMetadataProjection;
  readonly conversation: InteractionConversationProjection;
  readonly actions: readonly InteractionActionProjection[];
  readonly trace: InteractionTraceProjection;
  readonly history:
    | (InteractionHistoryProjection & { readonly result: 'ok' })
    | ({ readonly result: 'failed'; readonly query: InteractionHistoryQuery } & InteractionHistoryFailureProjection)
    | InteractionHistoryMissingProjection;
  readonly nodeCards: readonly InteractionNodeCardProjection[];
}

export function projectInteractionWorkCard(input: InteractionCardInput): InteractionWorkCardProjection {
  validateWithUiError(() => validateInteractionWorkCard(input.card), 'work card');

  const history = input.history;
  if (history) {
    validateWithUiError(() => validateInteractionHistoryQuery(history.query), 'history query');
    validateWithUiError(() => validateInteractionHistoryResult(history.result), 'history result');
  }
  const page = history?.result.ok === true ? history.result.page : undefined;
  const pageItems = (page?.items ?? []).map((entry, index) => {
    validateWithUiError(() => validateInteractionTraceEntry(entry), `history[${index}]`);
    assertHistoryScope(entry, history?.query, `history[${index}]`);
    return entry;
  });

  return {
    surface: INTERACTION_CARD_SURFACE,
    taskState: input.taskState,
    statusbar: input.source,
    cardMetadata: {
      source: input.card.source,
      currentNode: input.card.currentNode,
      ownerId: input.card.ownerId,
      nextStep: input.card.nextStep,
      nextAction: input.card.nextAction,
      waitingOn: input.card.waitingOn,
      startedAt: input.card.startedAt,
      provider: input.card.provider,
      transport: input.card.transport,
      settlement: input.card.settlement,
      lastBusiness: input.card.lastBusiness,
    },
    conversation: {
      summary: toConversationSummary(input.conversation),
      turns: (input.conversation?.turns ?? []).map((turn) => ({
        sourceKind: turn.sourceKind,
        occurredAt: turn.occurredAt,
        markdown: turn.markdown,
        artifacts: turn.artifacts,
        error: turn.error,
      })),
    },
    actions: (input.actions ?? []).map(toAction),
    trace: { count: pageItems.length, items: pageItems },
    history: history === undefined
      ? { result: 'missing', count: 0, items: [] }
      : history.result.ok === false
        ? { result: 'failed', query: history.query, ...history.result.failure }
        : { result: 'ok', query: history.query, cursor: page?.cursor, hasMore: page?.hasMore ?? false, filter: page?.filter, replay: page?.replay, count: pageItems.length, items: pageItems },
    nodeCards: input.nodeCards ?? [],
  };
}

function validateWithUiError(validate: () => void, label: string): void {
  try {
    validate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UiProjectionError(`${label}: ${message}`);
  }
}

function toConversationSummary(
  conversation: InteractionCardConversationInput | undefined,
): InteractionCardSummaryProjection {
  if (!conversation) return { missing: true };
  const summary: InteractionCardSummaryInput = {
    goal: conversation.goal,
    scope: conversation.scope,
    constraints: conversation.constraints,
    deliverables: conversation.deliverables,
  };
  if (summary.goal === undefined
    && summary.scope === undefined
    && (summary.constraints === undefined || summary.constraints.length === 0)
    && (summary.deliverables === undefined || summary.deliverables.length === 0)) {
    return { missing: true };
  }
  return summary;
}

function toAction(source: InteractionCardActionInput): InteractionActionProjection {
  return {
    id: source.id,
    label: source.label,
    availability: source.executable ? 'executable' : 'unsupported',
    unavailableReason: source.unavailableReason,
  };
}

function assertSameScopedId(actual: ScopedId, expected: { readonly scope: string; readonly value: string }, label: string): void {
  if (actual.scope !== expected.scope || actual.value !== expected.value) {
    throw new UiProjectionError(`${label} ${expected.scope}Id ${expected.value} does not match actual ${actual.value}`);
  }
}

function assertHistoryScope(entry: InteractionTraceEntry, query: InteractionHistoryQuery | undefined, label: string): void {
  const filter = query?.filter;
  if (filter?.kinds && !filter.kinds.includes(entry.kind)) {
    throw new UiProjectionError(`${label} kind ${entry.kind} does not match filter`);
  }
  if (filter?.taskId) assertSameScopedId(entry.taskId, filter.taskId, label);
  if (filter?.operationId) assertSameScopedId(entry.operationId, filter.operationId, label);
  if (filter?.executionEpoch !== undefined && entry.executionEpoch !== filter.executionEpoch) {
    throw new UiProjectionError(`${label} executionEpoch ${entry.executionEpoch} does not match filter ${filter.executionEpoch}`);
  }
  if (filter?.callId && entry.tool?.callId !== filter.callId) {
    throw new UiProjectionError(`${label} callId ${entry.tool?.callId ?? '<missing>'} does not match filter ${filter.callId}`);
  }
  if (filter?.fromSeq !== undefined && entry.seq < filter.fromSeq) {
    throw new UiProjectionError(`${label} seq ${entry.seq} is before filter fromSeq ${filter.fromSeq}`);
  }
  if (filter?.toSeq !== undefined && entry.seq > filter.toSeq) {
    throw new UiProjectionError(`${label} seq ${entry.seq} is after filter toSeq ${filter.toSeq}`);
  }
}

export type { TaskId };
