import {
  type ActiveTurnProviderRequestIdentityRef,
  type BusinessPayload,
  type ContentUnitChannel,
  type EvidenceRef,
  type ProviderToolStatus,
  type RawAsset,
  type RawContentReadPort,
  type ScopeRef,
  type WorkAssignment,
} from '../../../contracts/src/index.js';
import {
  validateActiveTurnSegmentChainRead,
  validatePreparedActiveTurnSegmentCaptureV2,
  type ActiveTurnSegmentChainInitial,
  type ActiveTurnSegmentChainRead,
  type ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import { canonicalJsonStringify } from '../../../contracts/src/explicit-brain.js';
import type { SemanticHistoryPersistencePort } from '../checkpoints/ports.js';
import {
  validateSemanticHistoryExactLookupV1,
  type CommittedSemanticCheckpoint,
  type SemanticHistoryExactLookupV1,
} from './semantic-history.js';
import {
  materializeLiveAcceptedPrefix,
  materializeActiveTurnSegmentLivePrefix,
  type ActiveTurnSegmentLivePrefix,
  type ActiveTurnLivePrefix,
  type ActiveTurnLivePrefixWatermark,
  type ActiveTurnProductionObligationRef,
  type ResolvedLiveAcceptedPrefix,
} from './active-turn-live-prefix.js';
import {
  foldActiveTurn,
  materializeActiveTurn,
  type ActiveTurnFoldBinding,
  type ResolvedActiveTurnCore,
  type ResolvedAdoptedChildDelivery,
} from './active-turn-materializer.js';
import type {
  ActiveTurnInitialOpenExactRead,
  ActiveTurnSegmentCaptureExactRead,
  ActiveTurnSegmentJournalPort,
} from './active-turn-journal.js';
import {
  buildSemanticTurnContext,
  type CommittedSemanticCheckpointProjection,
  type RefinedChildSemanticDelivery,
  type SemanticTurnContext,
  type SemanticTurnInputEntry,
} from './semantic-turn-context.js';

/**
 * D-M semantic turn context reader.
 *
 * It resolves the real request input for one model boundary from three sources:
 *
 * 1. The exact committed semantic checkpoints of completed prior business
 *    turns, addressed by the lookup refs T-a/A selected. It reads history by
 *    exact ref only and never treats the current business turn's checkpoint as
 *    completed prior history.
 * 2. The live accepted prefix of the current business turn, materialized from
 *    the committed projection without closing admission or draining producers.
 * 3. The current assignment, rules and request-scoped orientation.
 *
 * It holds no store, no latest selector and no mutable shared context. Two
 * reader calls share nothing but the injected ports.
 */
export class SemanticTurnContextReaderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SemanticTurnContextReaderError';
  }
}

/**
 * One ordered current-turn unit. It preserves the real accepted bytes and the
 * originating request/call identity so a later codec can encode the wire shape
 * without re-deriving selectors or synthesizing output.
 */
export type SemanticCurrentTurnUnit =
  | {
      readonly kind: 'initial-input';
      readonly content: RawAsset;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'content';
      readonly request: ActiveTurnProviderRequestIdentityRef;
      readonly contentUnitId: string;
      readonly channel: ContentUnitChannel;
      readonly bytes: Uint8Array;
      readonly complete: boolean;
    }
  | {
      readonly kind: 'tool-call';
      readonly request: ActiveTurnProviderRequestIdentityRef;
      readonly callId: string;
      readonly toolId: string;
      readonly continuationRef: string;
      readonly arguments: BusinessPayload;
      readonly rawArguments: Uint8Array;
    }
  | {
      readonly kind: 'tool-result';
      readonly request: ActiveTurnProviderRequestIdentityRef;
      readonly callId: string;
      readonly toolId: string;
      readonly continuationRef: string;
      readonly status: ProviderToolStatus;
      readonly rawOutput: Uint8Array;
      /** The accepted result refs, cloned from the fact so the reader shares no mutable reference. */
      readonly evidenceRefs: readonly EvidenceRef[];
      /** The parent-scoped accepted raw-output citation. Its scope is the accepted envelope's own scope, so it is the citation the model may legally use in a parent-scoped summary. */
      readonly rawOutputRef: EvidenceRef;
    };

export interface SemanticTurnContextReaderInput {
  /** The exact committed-history read seam. It is never a store or a mirror. */
  readonly history: Pick<SemanticHistoryPersistencePort, 'readCommittedSemanticCheckpoint'>;
  /** The exact prior-completed-turn lookups T-a/A selected. Order is history order. */
  readonly priorCompletedTurns: readonly SemanticHistoryExactLookupV1[];
  /** The current business turn's live read boundary and its raw reader. */
  readonly live: {
    readonly prefix: ActiveTurnLivePrefix;
    readonly rawContent: RawContentReadPort;
  };
  readonly runtimeId: string;
  readonly scope: ScopeRef;
  readonly assignment: WorkAssignment;
  readonly rules?: readonly string[];
  /** Request-scoped orientation. It is transient and never enters canonical history. */
  readonly orientation?: string;
}

/**
 * The resumed-segment reader input. It keeps the v1 reader input unchanged and
 * makes the multi-segment sources explicit: the ordered S chain (including the
 * original immutable v1 capture), the exact J1 capture reader for earlier
 * segments, and the L live prefix for the current segment.
 */
export interface SemanticTurnSegmentContextReaderInput {
  /** The exact committed-history read seam. It is never a store or a mirror. */
  readonly history: Pick<SemanticHistoryPersistencePort, 'readCommittedSemanticCheckpoint'>;
  /** The exact prior-completed-turn lookups T-a/A selected. Order is history order. */
  readonly priorCompletedTurns: readonly SemanticHistoryExactLookupV1[];
  /**
   * The resumed current business turn. The chain is in append order and its
   * final segment is the live segment. The exact reader supplies only earlier
   * segment captures; the live prefix is never read back as a frozen capture.
   */
  readonly segment: {
    readonly chain: ActiveTurnSegmentChainRead;
    readonly exactReads: Pick<ActiveTurnSegmentJournalPort, 'readSegmentCaptureExact' | 'readSegmentInterruptedExact' | 'readInitialOpenExact'>;
    readonly live: {
      readonly prefix: ActiveTurnSegmentLivePrefix;
      readonly rawContent: RawContentReadPort;
    };
  };
  readonly runtimeId: string;
  readonly scope: ScopeRef;
  readonly assignment: WorkAssignment;
  readonly rules?: readonly string[];
  /** Request-scoped orientation. It is transient and never enters canonical history. */
  readonly orientation?: string;
}

export interface ResolvedSemanticTurnContext {
  readonly context: SemanticTurnContext<SemanticCurrentTurnUnit>;
  readonly watermark: ActiveTurnLivePrefixWatermark;
  readonly obligations: readonly ActiveTurnProductionObligationRef[];
  readonly instructions?: { readonly text: string };
}

function cloneScope(scope: ScopeRef): ScopeRef {
  return {
    organId: { scope: scope.organId.scope, value: scope.organId.value },
    ...(scope.taskId === undefined ? {} : {
      taskId: { scope: scope.taskId.scope, value: scope.taskId.value },
    }),
    ...(scope.cycleId === undefined ? {} : {
      cycleId: { scope: scope.cycleId.scope, value: scope.cycleId.value },
    }),
    ...(scope.operationId === undefined ? {} : {
      operationId: { scope: scope.operationId.scope, value: scope.operationId.value },
    }),
  };
}

function cloneEvidenceRef(ref: EvidenceRef): EvidenceRef {
  return {
    evidenceId: { scope: ref.evidenceId.scope, value: ref.evidenceId.value },
    kind: ref.kind,
    source: ref.source,
    locator: ref.locator,
    ...(ref.digest === undefined ? {} : { digest: ref.digest }),
    scope: cloneScope(ref.scope),
  };
}

function cloneRawAsset(asset: RawAsset): RawAsset {
  return { ref: cloneEvidenceRef(asset.ref), view: { ...asset.view } };
}

function cloneRequest(
  request: ActiveTurnProviderRequestIdentityRef,
): ActiveTurnProviderRequestIdentityRef {
  return {
    turnId: request.turnId,
    requestId: request.requestId,
    ...(request.parentRequestId === undefined ? {} : { parentRequestId: request.parentRequestId }),
  };
}

function cloneObligation(
  obligation: ActiveTurnProductionObligationRef,
): ActiveTurnProductionObligationRef {
  return obligation.kind === 'request'
    ? { kind: 'request', requestId: obligation.requestId, phase: obligation.phase,
        ...(obligation.segmentId === undefined ? {} : { segmentId: obligation.segmentId }) }
    : { kind: 'child-invocation', invocationId: obligation.invocationId, phase: obligation.phase,
        ...(obligation.segmentId === undefined ? {} : { segmentId: obligation.segmentId }) };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function failSegment(code: string, message: string): never {
  throw new SemanticTurnContextReaderError(code, message);
}

function assertSameSegmentValue(label: string, actual: unknown, expected: unknown): void {
  if (!sameCanonical(actual, expected)) {
    failSegment('semantic-turn-context.segment.identity-mismatch', `${label} does not match`);
  }
}

/**
 * The unique original input asset of one business turn's initial segment,
 * whether it was captured (`kind: 'captured'`) or is only an initial-open
 * source. Both branches reference the same immutable asset; this never copies
 * or relabels it.
 */
function chainInitialInput(initial: ActiveTurnSegmentChainInitial): RawAsset {
  return initial.kind === 'captured' ? initial.body.initialInput : initial.initialInput;
}

/**
 * Projects a committed checkpoint into cross-turn history by field. It takes
 * only the four semantics, description, trusted time and evidence refs. The
 * committed checkpoint carries no separate claims/constraints, so none are
 * added; its recovery, save receipts, native commit identity and turn control
 * fields never enter the projection.
 */
function projectCommittedCheckpoint(
  committed: CommittedSemanticCheckpoint,
): CommittedSemanticCheckpointProjection {
  const checkpointId = committed.save.checkpoint.checkpoint.id;
  return {
    checkpointId: { scope: checkpointId.scope, value: checkpointId.value },
    scope: cloneScope(committed.scope),
    executionEpoch: committed.turn.executionEpoch,
    description: committed.description,
    committedAt: committed.time,
    goal: committed.semantics.goal,
    did: committed.semantics.actions,
    result: committed.semantics.result,
    next: committed.semantics.nextStep,
    claims: [],
    constraints: [],
    evidenceRefs: committed.evidenceRefs.map(cloneEvidenceRef),
  };
}

function mapAdoptedDelivery(entry: ResolvedAdoptedChildDelivery): RefinedChildSemanticDelivery {
  const accepted = entry.accepted;
  return {
    childTurnId: entry.invocation.childTurnId,
    scope: cloneScope(accepted.refinedDelivery.ref.scope),
    assignmentId: accepted.assignment.assignmentId,
    executionEpoch: accepted.assignment.executionEpoch,
    evidenceRefs: accepted.result.evidenceRefs.map(cloneEvidenceRef),
    content: cloneRawAsset(accepted.refinedDelivery),
    bytes: new Uint8Array(entry.bytes),
  };
}

/**
 * Maps a resolved live prefix into ordered current-turn entries. The initial
 * input is first; folded content units and tool call/result entries follow in
 * acceptance order; only an actually adopted child delivery becomes a refined
 * child entry. `request-complete` and `content-complete` are control facts and
 * are not request content.
 */
function mapActiveTurnCore(
  resolved: ResolvedActiveTurnCore<ActiveTurnFoldBinding>,
  includeInitialInput: boolean,
): readonly SemanticTurnInputEntry<SemanticCurrentTurnUnit>[] {
  const items: Array<{ readonly seq: number; readonly entry: SemanticTurnInputEntry<SemanticCurrentTurnUnit> }> = [];
  if (includeInitialInput) {
    items.push({
      seq: Number.MIN_SAFE_INTEGER,
      entry: {
        kind: 'message',
        message: {
          kind: 'initial-input',
          content: cloneRawAsset(resolved.initialInput.content),
          bytes: new Uint8Array(resolved.initialInput.bytes),
        },
      },
    });
  }
  for (const unit of resolved.contentUnits) {
    // A replaced unit is superseded in its request and channel. The fold keeps
    // its raw fact and bytes, but the canonical current turn must exclude the
    // stale text so only the replacement reaches the provider request.
    if (unit.supersededBy !== undefined) continue;
    items.push({
      seq: unit.firstSeq,
      entry: {
        kind: 'message',
        message: {
          kind: 'content',
          request: cloneRequest(unit.request),
          contentUnitId: unit.contentUnitId,
          channel: unit.channel,
          bytes: new Uint8Array(unit.bytes),
          complete: unit.complete,
        },
      },
    });
  }
  for (const entry of resolved.entries) {
    if (entry.kind === 'tool-call') {
      const fact = entry.accepted.envelope.fact;
      items.push({
        seq: entry.accepted.seq,
        entry: {
          kind: 'message',
          message: {
            kind: 'tool-call',
            request: cloneRequest(entry.accepted.envelope.request),
            callId: fact.call.callId,
            toolId: fact.call.toolId,
            continuationRef: fact.call.continuationRef,
            arguments: structuredClone(fact.call.arguments),
            rawArguments: new Uint8Array(entry.rawArguments),
          },
        },
      });
    } else if (entry.kind === 'tool-result') {
      const fact = entry.accepted.envelope.fact;
      items.push({
        seq: entry.accepted.seq,
        entry: {
          kind: 'message',
          message: {
            kind: 'tool-result',
            request: cloneRequest(entry.accepted.envelope.request),
            callId: fact.callId,
            toolId: fact.result.toolId,
            continuationRef: fact.continuationRef,
            status: fact.result.status,
            evidenceRefs: fact.result.evidenceRefs.map(cloneEvidenceRef),
            rawOutput: new Uint8Array(entry.rawOutput),
            rawOutputRef: cloneEvidenceRef(fact.rawOutput.ref),
          },
        },
      });
    } else if (entry.kind === 'adopted-child-delivery') {
      items.push({
        seq: entry.accepted.seq,
        entry: { kind: 'refined-child', delivery: mapAdoptedDelivery(entry) },
      });
    }
  }
  items.sort((left, right) => left.seq - right.seq);
  return items.map((item) => item.entry);
}

function mapActiveTurn(
  resolved: ResolvedLiveAcceptedPrefix,
): readonly SemanticTurnInputEntry<SemanticCurrentTurnUnit>[] {
  return mapActiveTurnCore(resolved, true);
}

async function resolvePriorCompletedTurns(
  history: Pick<SemanticHistoryPersistencePort, 'readCommittedSemanticCheckpoint'>,
  lookups: readonly SemanticHistoryExactLookupV1[],
  currentTurnId: string,
): Promise<readonly CommittedSemanticCheckpointProjection[]> {
  const semanticCheckpoints: CommittedSemanticCheckpointProjection[] = [];
  for (const lookup of lookups) {
    validateSemanticHistoryExactLookupV1(lookup);
    const committed = await history.readCommittedSemanticCheckpoint(lookup);
    if (committed === null) {
      throw new SemanticTurnContextReaderError(
        'semantic-turn-context.history.missing',
        `exact committed checkpoint ${lookup.publicationReceiptRef} was not found`,
      );
    }
    if (committed.turn.turnId === currentTurnId) {
      throw new SemanticTurnContextReaderError(
        'semantic-turn-context.history.current-turn',
        `checkpoint ${lookup.publicationReceiptRef} belongs to the current business turn and is not completed prior history`,
      );
    }
    semanticCheckpoints.push(projectCommittedCheckpoint(committed));
  }
  return semanticCheckpoints;
}

function buildResolvedSemanticTurnContext(input: {
  readonly runtimeId: string;
  readonly scope: ScopeRef;
  readonly assignment: WorkAssignment;
  readonly rules?: readonly string[];
  readonly orientation?: string;
}, contextInput: {
  readonly semanticCheckpoints: readonly CommittedSemanticCheckpointProjection[];
  readonly activeTurn: readonly SemanticTurnInputEntry<SemanticCurrentTurnUnit>[];
  readonly watermark: ActiveTurnLivePrefixWatermark;
  readonly obligations: readonly ActiveTurnProductionObligationRef[];
}): ResolvedSemanticTurnContext {
  const context = buildSemanticTurnContext<SemanticCurrentTurnUnit>({
    runtimeId: input.runtimeId,
    scope: input.scope,
    assignment: input.assignment,
    ...(input.rules === undefined ? {} : { rules: input.rules }),
    semanticCheckpoints: contextInput.semanticCheckpoints,
    activeTurn: contextInput.activeTurn,
  });

  return {
    context,
    watermark: {
      lastAcceptedSeq: contextInput.watermark.lastAcceptedSeq,
      controlRecordCount: contextInput.watermark.controlRecordCount,
    },
    obligations: contextInput.obligations.map(cloneObligation),
    ...(input.orientation === undefined ? {} : { instructions: { text: input.orientation } }),
  };
}

function validateSegmentExactCapture(input: {
  readonly chain: ActiveTurnSegmentChainRead;
  readonly segment: ResumedTurnSegmentOpened;
  readonly exact: ActiveTurnSegmentCaptureExactRead;
}): void {
  validatePreparedActiveTurnSegmentCaptureV2(input.exact.prepared);
  const body = input.exact.prepared.body;
  assertSameSegmentValue('exact segment capture segment id', body.segmentId, input.segment.segmentId);
  assertSameSegmentValue('exact segment capture business turn', body.businessTurnRef, input.chain.businessTurnRef);
  assertSameSegmentValue('exact segment capture binding', body.binding, input.segment.binding);
  assertSameSegmentValue('exact segment capture predecessor', body.predecessor, input.segment.predecessor);
  assertSameSegmentValue('exact segment capture original input', body.initialInput, chainInitialInput(input.chain.initial));
  assertSameSegmentValue('exact segment capture receipt business turn', input.exact.receipt.businessTurnId, input.chain.businessTurnRef.businessTurnId);
  assertSameSegmentValue('exact segment capture receipt segment id', input.exact.receipt.segmentId, input.segment.segmentId);
  assertSameSegmentValue('exact segment capture receipt boundary', input.exact.receipt.boundaryId, body.cut.pauseId);
}

/** One prior segment resolution, kept with its segment identity for obligations. */
interface PriorSegmentResolution {
  readonly segmentId: string;
  readonly core: ResolvedActiveTurnCore<ActiveTurnFoldBinding>;
}

/**
 * The outstanding production duties of one folded segment: dispatching,
 * dispatched and waiting requests, plus child invocations whose decision duty
 * is still open. It mirrors the live segment's own projection so a historical
 * segment keeps exactly the duties its committed records still owe.
 */
function segmentObligations(core: ResolvedActiveTurnCore<ActiveTurnFoldBinding>): ActiveTurnProductionObligationRef[] {
  const obligations: ActiveTurnProductionObligationRef[] = [];
  for (const record of core.requests) {
    if (record.phase === 'dispatching' || record.phase === 'dispatched' || record.phase === 'waiting') {
      obligations.push({ kind: 'request', requestId: record.request.requestId, phase: record.phase });
    }
  }
  const returned = new Set(core.entries
    .filter((entry): entry is ResolvedAdoptedChildDelivery => entry.kind === 'adopted-child-delivery')
    .map((entry) => entry.invocation.invocationId));
  for (const invocation of core.childInvocations) {
    const decided = invocation.adoptedResultSeq !== undefined || invocation.notSelectedResultSeq !== undefined;
    const openReview = invocation.binding.kind === 'review' && invocation.postReviewCheckpointRef === undefined;
    if (!returned.has(invocation.invocationId) || !decided || openReview) {
      obligations.push({ kind: 'child-invocation', invocationId: invocation.invocationId, phase: 'pending' });
    }
  }
  return obligations;
}

/**
 * Merge per-segment obligations in chain order, tagging each duty with the
 * segment that still owes it and de-duplicating by segment and identity. No
 * duty is settled, cancelled or re-issued by a new epoch.
 */
function mergeSegmentObligations(groups: readonly {
  readonly segmentId: string;
  readonly obligations: readonly ActiveTurnProductionObligationRef[];
}[]): ActiveTurnProductionObligationRef[] {
  const merged: ActiveTurnProductionObligationRef[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const obligation of group.obligations) {
      const entry: ActiveTurnProductionObligationRef = obligation.kind === 'request'
        ? { kind: 'request', requestId: obligation.requestId, phase: obligation.phase, segmentId: group.segmentId }
        : { kind: 'child-invocation', invocationId: obligation.invocationId, phase: 'pending', segmentId: group.segmentId };
      const key = canonicalJsonStringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

async function resolvePriorSegmentCores(input: {
  readonly chain: ActiveTurnSegmentChainRead;
  readonly live: {
    readonly prefix: ActiveTurnSegmentLivePrefix;
    readonly rawContent: RawContentReadPort;
  };
  readonly exactReads: Pick<ActiveTurnSegmentJournalPort, 'readSegmentCaptureExact' | 'readSegmentInterruptedExact'>;
}): Promise<readonly PriorSegmentResolution[]> {
  const { chain } = input;
  validateActiveTurnSegmentChainRead(chain);

  const liveSegment = input.live.prefix.segment;
  const tail = chain.segments[chain.segments.length - 1];
  if (tail === undefined) {
    failSegment(
      'semantic-turn-context.segment.live-missing',
      'resumed segment reader requires at least one committed segment in the chain',
    );
  }
  assertSameSegmentValue('live segment record', liveSegment, tail);
  assertSameSegmentValue('live segment binding', input.live.prefix.binding, tail.binding);
  assertSameSegmentValue('live segment original input', input.live.prefix.initialInput, chainInitialInput(chain.initial));

  const resolved: PriorSegmentResolution[] = [];
  for (let index = 0; index < chain.segments.length - 1; index += 1) {
    const segment = chain.segments[index]!;
    const successor = chain.segments[index + 1]!;
    if (successor.predecessor.segmentId !== segment.segmentId) {
      failSegment(
        'semantic-turn-context.segment.predecessor-mismatch',
        `segment ${successor.segmentId} does not precede-link ${segment.segmentId}`,
      );
    }
    const predecessor = successor.predecessor;
    if (predecessor.interrupted !== undefined) {
      // The predecessor was opened and appended records but never committed a
      // receipt. Read its committed live prefix at the exact anchor; it is a
      // live cut, not a frozen capture, and claims no save.
      const interrupted = await input.exactReads.readSegmentInterruptedExact({
        businessTurnId: chain.businessTurnRef.businessTurnId,
        predecessor: { segmentId: segment.segmentId, interrupted: predecessor.interrupted },
      });
      assertSameSegmentValue('interrupted segment record', interrupted.prefix.segment, segment);
      assertSameSegmentValue('interrupted segment binding', interrupted.prefix.binding, segment.binding);
      assertSameSegmentValue('interrupted segment original input', interrupted.prefix.initialInput, chainInitialInput(chain.initial));
      resolved.push({ segmentId: segment.segmentId, core: await materializeActiveTurnSegmentLivePrefix({
        prefix: interrupted.prefix, rawContent: input.live.rawContent,
      }) });
    } else if (predecessor.recoveryAssetsReceiptRef !== undefined) {
      const exact = await input.exactReads.readSegmentCaptureExact({
        businessTurnId: chain.businessTurnRef.businessTurnId,
        segmentId: segment.segmentId,
        recoveryAssetsReceiptRef: predecessor.recoveryAssetsReceiptRef,
      });
      validateSegmentExactCapture({ chain, segment, exact });
      resolved.push({ segmentId: segment.segmentId, core: await foldActiveTurn({
        binding: exact.prepared.body.binding,
        initialInput: exact.prepared.body.initialInput,
        entries: exact.prepared.body.entries,
        requests: exact.prepared.body.requests,
        childInvocations: exact.prepared.body.childInvocations,
        cut: exact.prepared.body.cut,
        checkpointPath: [],
        completionRefs: [],
        rawContent: input.live.rawContent,
      }) });
    } else {
      // Only the first resumed segment may precede-link the original
      // initial-open anchor; a later segment always links a committed segment.
      failSegment(
        'semantic-turn-context.segment.predecessor-invalid',
        `segment ${segment.segmentId} has neither an exact receipt nor an interrupted anchor`,
      );
    }
  }
  return resolved;
}

export async function readSemanticTurnContext(
  input: SemanticTurnContextReaderInput,
): Promise<ResolvedSemanticTurnContext> {
  const currentTurnId = input.live.prefix.binding.admittedTurn.turnId;
  const semanticCheckpoints = await resolvePriorCompletedTurns(
    input.history,
    input.priorCompletedTurns,
    currentTurnId,
  );

  const resolved = await materializeLiveAcceptedPrefix({
    prefix: input.live.prefix,
    rawContent: input.live.rawContent,
  });
  const activeTurn = mapActiveTurn(resolved);

  return buildResolvedSemanticTurnContext(input, {
    semanticCheckpoints,
    activeTurn,
    watermark: {
      lastAcceptedSeq: resolved.cut.lastAcceptedSeq,
      controlRecordCount: resolved.cut.controlRecordCount,
    },
    obligations: input.live.prefix.obligations,
  });
}

/**
 * Resolves the current logical turn across an ordered segment chain. Earlier
 * resumed segments come from exact J1 captures; the current segment comes from
 * the L live prefix. Every segment is folded with the shared active-turn fold,
 * then appended in chain order with segment-local sequence sorting. The unique
 * original input is emitted once, before the first segment's current content.
 */
export async function readResumedSegmentSemanticTurnContext(
  input: SemanticTurnSegmentContextReaderInput,
): Promise<ResolvedSemanticTurnContext> {
  const { chain } = input.segment;
  const currentTurnId = chain.businessTurnRef.businessTurnId;
  const semanticCheckpoints = await resolvePriorCompletedTurns(
    input.history,
    input.priorCompletedTurns,
    currentTurnId,
  );

  // The original segment is either the immutable v1 capture or the committed
  // initial-open live prefix. The initial-open branch is folded through the same
  // live-prefix materializer and keeps the original turn's open obligations.
  const initialGroups: PriorSegmentResolution[] = [];
  let initialCore: ResolvedActiveTurnCore<ActiveTurnFoldBinding>;
  if (chain.initial.kind === 'captured') {
    initialCore = await materializeActiveTurn({
      capture: chain.initial.body,
      rawContent: input.segment.live.rawContent,
    });
  } else {
    const exactOpen: ActiveTurnInitialOpenExactRead = await input.segment.exactReads.readInitialOpenExact({
      businessTurnId: chain.businessTurnRef.businessTurnId,
      anchor: chain.initial.anchor,
    });
    assertSameSegmentValue('initial-open anchor', exactOpen.anchor, chain.initial.anchor);
    assertSameSegmentValue('initial-open prefix binding', exactOpen.prefix.binding, chain.initial.binding);
    assertSameSegmentValue('initial-open prefix original input', exactOpen.prefix.initialInput, chain.initial.initialInput);
    initialCore = await materializeLiveAcceptedPrefix({
      prefix: exactOpen.prefix,
      rawContent: input.segment.live.rawContent,
    });
    initialGroups.push({ segmentId: chain.businessTurnRef.businessTurnId, core: initialCore });
  }
  const priorSegments = await resolvePriorSegmentCores({
    chain,
    live: input.segment.live,
    exactReads: input.segment.exactReads,
  });
  const live = await materializeActiveTurnSegmentLivePrefix({
    prefix: input.segment.live.prefix,
    rawContent: input.segment.live.rawContent,
  });

  const activeTurn: SemanticTurnInputEntry<SemanticCurrentTurnUnit>[] = [];
  activeTurn.push(...mapActiveTurnCore(initialCore, true));
  for (const segment of priorSegments) {
    activeTurn.push(...mapActiveTurnCore(segment.core, false));
  }
  activeTurn.push(...mapActiveTurnCore(live, false));

  return buildResolvedSemanticTurnContext(input, {
    semanticCheckpoints,
    activeTurn,
    watermark: {
      lastAcceptedSeq: live.cut.lastAcceptedSeq,
      controlRecordCount: live.cut.controlRecordCount,
    },
    obligations: mergeSegmentObligations([
      ...initialGroups.map((group) => ({ segmentId: group.segmentId, obligations: segmentObligations(group.core) })),
      ...priorSegments.map((segment) => ({ segmentId: segment.segmentId, obligations: segmentObligations(segment.core) })),
      { segmentId: live.segment.segmentId, obligations: input.segment.live.prefix.obligations },
    ]),
  });
}
