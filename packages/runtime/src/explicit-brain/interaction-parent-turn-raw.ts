import {
  ContractError,
  assertProviderExecutionIdentity,
  assertSameScope,
  canonicalJsonStringify,
  validateAcceptedRawFact,
  validateInteractionSemanticCheckpoint,
  validateInteractionLatestTurn,
  validateInteractionProviderSettlementReceipt,
  validateInteractionTurnIdentity,
  validateOccurrenceExecutionOwner,
  validateProviderBinding,
  validateProviderCloseResult,
  validateRawFactEnvelope,
  type AcceptedRawFact,
  type EvidenceRef,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionProviderSettlementReceipt,
  type InteractionSemanticCheckpoint,
  type InteractionTurnIdentity,
  type JournalCommitRef,
  type NativeRequestRegistration,
  type OrganId,
  type OccurrenceExecutionOwner,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderRequestIdentityRef,
  type RawAsset,
  type RawContentReadPort,
  type RawFactEnvelope,
  type RuntimeRequestRecord,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  MaterializedRequestInput,
  ProviderRequestContextHook,
  ProviderRequestContextHookInput,
  ProviderRequestContextUnit,
  RequestScopedInstructions,
} from '../../../contracts/src/provider-request-context.js';
import {
  foldActiveTurn,
  type ResolvedActiveTurnEntry,
  type ResolvedContentUnit,
} from '../context/active-turn-materializer.js';

/**
 * Runtime-owned durable raw history of one neutral interaction parent turn.
 *
 * This is the parent twin of the taskless helper owner. It owns exactly one
 * real `InteractionTurnIdentity` and accepts the parent provider's own raw facts
 * (assistant text, tool calls, tool results) under the parent
 * `InteractionParentProviderExecutionIdentityRef`. It never synthesizes a Task,
 * a cycle or a helper identity, and it never reads a refined child delivery back
 * as parent raw history: the durable child helper journal stays the child's own
 * record.
 *
 * Ownership boundaries held here:
 *   - the Runtime owns request registration, raw-fact acceptance sequence,
 *     request-context materialization and the unsettled-request inspection;
 *   - the injected Journal port is the only store, lock and transaction owner;
 *     this owner holds no registry, cache or mirrored state;
 *   - raw bytes are resolved through the injected `RawContentReadPort`; the
 *     owner never parses wire JSON and never fabricates an asset.
 *
 * It depends on the contracts and the shared active-turn fold only, never on an
 * adapter and never on the App.
 */

/** The immutable committed input of one neutral interaction parent turn. */
export interface InteractionParentTurnInputFact {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  /** The parent raw scope: organ plus operation, with no task or cycle. */
  readonly scope: ScopeRef;
  readonly initialInput: RawAsset;
  /** Present only when the opening caller has authenticated a physical owner. */
  readonly executionOwner?: OccurrenceExecutionOwner;
  /**
   * The actual Provider binding the original owner used for this turn. It is
   * optional only so older Journal records without it stay honestly readable;
   * every new turn commits the real binding, and a resource close can never be
   * recorded for a legacy turn that is missing it.
   */
  readonly providerBinding?: ProviderBinding;
  /** Caller-selected committed semantic checkpoints of completed prior turns. */
  readonly priorCheckpoints: readonly InteractionSemanticCheckpoint[];
}

/** A durable fact together with the Journal commit that published it. */
export interface InteractionParentCommittedFact<TFact> {
  readonly fact: TFact;
  readonly commit: JournalCommitRef;
}

/**
 * The durable fact that the original parent Provider owner returned an actual
 * `closed` receipt for the original turn binding, and that the fact committed
 * to the Journal. This proves physical resource release only: it never claims a
 * semantic success, and it is separate from the terminal settled output.
 */
export interface InteractionParentResourceCloseFact {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly providerBinding: ProviderBinding;
  readonly result: ProviderCloseResult;
  readonly closedAt: string;
}

/**
 * The durable fact that a committed replacement owner reconciled the original
 * parent turn before any physical provider close. It records only the local
 * owner transition and the remote provider state stays honestly `unknown`.
 */
export interface InteractionParentOwnerReconciliationFact {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly providerBinding: ProviderBinding;
  readonly previousOwner: OccurrenceExecutionOwner;
  readonly replacementOwner: OccurrenceExecutionOwner;
  readonly mode: 'terminal-output' | 'continue';
  readonly effectiveExecutionEpoch: number;
  readonly unsettledRequestIds: readonly string[];
  readonly remoteProviderState: 'unknown';
  readonly reconciledAt: string;
}

/** The consistent durable read of exactly one parent turn. */
export interface InteractionParentTurnSnapshot {
  readonly turnInput: InteractionParentCommittedFact<InteractionParentTurnInputFact> | null;
  readonly requests: readonly InteractionParentCommittedFact<RuntimeRequestRecord>[];
  readonly acceptedFacts: readonly InteractionParentCommittedFact<
    AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>
  >[];
  readonly ownerReconciliations: readonly InteractionParentCommittedFact<
    InteractionParentOwnerReconciliationFact
  >[];
  readonly providerSettlements: readonly InteractionParentCommittedFact<
    InteractionProviderSettlementReceipt
  >[];
  readonly resourceClose: InteractionParentCommittedFact<InteractionParentResourceCloseFact> | null;
  /**
   * The single committed discharge of an interrupted epoch, or null. A
   * discharged turn can never be recovered, replayed or continued: it left no
   * terminal output and no business side effect.
   */
  readonly abandonment: InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact> | null;
  /**
   * The single committed failure-closing fact, or null. It records only that the
   * provider returned a real terminal output but the runtime could not parse it
   * into any decision, so the turn is durably closed as unusable instead of
   * being left pending forever. It is distinct from abandonment (no terminal
   * output) and never claims a settled answer, route, close or settlement.
   */
  readonly parseFailure: InteractionParentCommittedFact<InteractionParentTurnParseFailureFact> | null;
}

/**
 * The durable fact that one interrupted parent turn was explicitly discharged
 * as unrecoverable.
 *
 * It records only that the provider stream stopped before any terminal output
 * and before any business side effect, so the turn cannot be recovered and
 * must not keep blocking its interaction scope. It never claims a settled
 * output, a semantic success, a provider close or a remote provider state.
 */
export interface InteractionParentTurnAbandonmentFact {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly providerBinding: ProviderBinding;
  /** The only shape this fact may describe: a truly interrupted stream. */
  readonly reason: 'provider-interrupted-without-terminal-output';
  readonly abandonedAt: string;
}

/**
 * The durable fact that one interpreted turn committed its input and a real
 * provider resource close, but the terminal output could not be parsed into any
 * decision.
 *
 * The turn is therefore closed as unusable: it is distinct from abandonment (no
 * terminal output) and never claims a settled answer, route, close or
 * settlement. The exact offending request and epoch are recorded so a retry in
 * the same interaction scope can recognize the committed failure and reuse it
 * instead of re-bricking.
 */
export interface InteractionParentTurnParseFailureFact {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly providerBinding: ProviderBinding;
  /** The terminal request whose output could not be parsed. */
  readonly terminalRequestId: string;
  /** The execution epoch that produced the unparseable output. */
  readonly executionEpoch: number;
  /** When the failure-closing fact was committed. */
  readonly failedAt: string;
}

/**
 * The conservative decision of whether one interrupted parent turn may be
 * discharged. A held decision carries the exact durable reason so the caller
 * can keep failing with the original explicit boundary instead of guessing.
 */
export type InteractionParentTurnAbandonmentEligibility =
  | { readonly abandonable: true }
  | { readonly abandonable: false; readonly heldReason: string };

/**
 * The conservative decision of whether one interpreted turn may be closed as
 * unusable. A held decision carries the exact durable reason, so a caller that
 * meets a shape it must not close keeps its original explicit error instead of
 * writing an unfounded fact.
 */
export type InteractionParentTurnParseFailureEligibility =
  | { readonly closeable: true; readonly terminalRequestId: string; readonly executionEpoch: number }
  | { readonly closeable: false; readonly heldReason: string };

/** The single append a transactional turn plan may stage. */
export type InteractionParentTurnAppend =
  | {
      readonly kind: 'turn-input';
      readonly fact: InteractionParentTurnInputFact;
    }
  | {
      readonly kind: 'request';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly record: RuntimeRequestRecord;
    }
  | {
      readonly kind: 'accepted-fact';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly entry: AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>;
    }
  | {
      readonly kind: 'resource-close';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionParentResourceCloseFact;
    }
  | {
      readonly kind: 'owner-reconciliation';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionParentOwnerReconciliationFact;
    }
  | {
      readonly kind: 'provider-settlement';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionProviderSettlementReceipt;
    }
  | {
      /**
       * The terminal discharge of an interrupted epoch. It is appendable only
       * for the conservative interrupted shape and freezes the turn: no
       * request or raw fact may follow it.
       */
      readonly kind: 'turn-abandonment';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionParentTurnAbandonmentFact;
    }
  | {
      /**
       * The failure-closing of an interpreted epoch whose terminal output could
       * not be parsed. It freezes the turn: no request, raw fact, close,
       * settlement or abandonment may follow it.
       */
      readonly kind: 'turn-parse-failure';
      readonly turn: InteractionTurnIdentity;
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly fact: InteractionParentTurnParseFailureFact;
    };

/**
 * The only persistence seam. The implementation owns the atomic read plus
 * append; the Runtime owner only stages a plan against the consistent snapshot.
 */
export interface InteractionParentTurnRawJournalPort {
  transactTurn<TResult>(
    turn: InteractionTurnIdentity,
    plan: (snapshot: InteractionParentTurnSnapshot) => {
      readonly append?: InteractionParentTurnAppend;
      readonly result: TResult;
    },
  ): Promise<{ readonly committed?: JournalCommitRef; readonly result: TResult }>;
  readTurnSnapshot(turn: InteractionTurnIdentity): Promise<InteractionParentTurnSnapshot>;
}

/**
 * Narrow scoped-read capability over the committed parent turn inputs.
 *
 * It is intentionally separate from `InteractionParentTurnRawJournalPort`: the
 * register/append path does not need it, so only the storage that serves
 * next-turn history selection must implement it.
 */
export interface InteractionParentOpenedTurnScopeReadPort {
  readScopeOpenedTurns(scope: {
    readonly organId: OrganId;
    readonly interactionScopeId: string;
  }): Promise<readonly InteractionParentCommittedFact<InteractionParentTurnInputFact>[]>;
  /**
   * The committed discharges of interrupted turns in one interaction scope.
   * Scope-level readiness reads this beside the opened-turn and checkpoint
   * reads so a discharged turn stops blocking and never enters history.
   */
  readScopeAbandonedTurns(scope: {
    readonly organId: OrganId;
    readonly interactionScopeId: string;
  }): Promise<readonly InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact>[]>;
  /**
   * The committed failure-closings of interpreted turns in one interaction
   * scope. Scope-level readiness and the pending-turn read consume this beside
   * the abandonment read: a turn closed as unusable stops blocking, and it
   * never enters semantic history because it produced no decision.
   */
  readScopeParseFailures(scope: {
    readonly organId: OrganId;
    readonly interactionScopeId: string;
  }): Promise<readonly InteractionParentCommittedFact<InteractionParentTurnParseFailureFact>[]>;
}

/**
 * The exact folded final output of one settled parent turn.
 *
 * The bytes are decoded from the durable accepted facts through the shared
 * active-turn fold; the Runtime never synthesizes a whole-output asset or
 * parses wire JSON. `requestCompleteCommit` is the durable completion fact, so
 * a semantic close idempotency check can freeze the real final request.
 */
export interface InteractionParentFinalTurnOutput {
  readonly turnInput: InteractionParentCommittedFact<InteractionParentTurnInputFact>;
  readonly initialInputText: string;
  readonly terminalRequest: RuntimeRequestRecord;
  readonly requestCompleteCommit: JournalCommitRef;
  readonly assistantText: string;
  readonly assistantContentRefs: readonly EvidenceRef[];
}

export interface InteractionParentUnsettledRequests {
  readonly requests: readonly RuntimeRequestRecord[];
  readonly unsettledRequests: readonly RuntimeRequestRecord[];
}

/**
 * The single durable reconciliation decision of one turn.
 *
 * `terminal-output` means the turn already has a real settled final output and
 * is delivered without an executor; `continue` means the business turn must
 * resume in a new physical epoch under the same identity. Held shapes
 * (cancelled, partial failed, unpaired tool, unknown side effect) surface as the
 * existing typed `ContractError`.
 */
export interface InteractionParentReconciliationEligibility {
  readonly mode: 'terminal-output' | 'continue';
  readonly unsettledRequestIds: readonly string[];
  readonly effectiveExecutionEpoch: number;
}

export interface InteractionParentTurnRawOwner {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  /** Commit the turn input exactly once. A repeat returns the committed fact. */
  openTurnInput(): Promise<InteractionParentCommittedFact<InteractionParentTurnInputFact>>;
  registerRequest(registration: NativeRequestRegistration): Promise<RuntimeRequestRecord>;
  acceptRawFact(
    envelope: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef>,
  ): Promise<AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>>;
  readFinalTurnOutput(): Promise<InteractionParentFinalTurnOutput>;
  /**
   * Commit one local, distinct-owner reconciliation of this turn. The caller
   * attests that the replacement owner was actually committed, and the method
   * holds when the old owner is unattested, the turn is already closed, or an
   * unknown tool side effect is unpaired. It never fabricates a provider close.
   */
  reconcileTurnOwner(input: {
    readonly previousOwner: OccurrenceExecutionOwner;
    readonly replacementOwner: OccurrenceExecutionOwner;
    readonly isCommittedReplacement: boolean;
    readonly reconciledAt: string;
  }): Promise<InteractionParentCommittedFact<InteractionParentOwnerReconciliationFact>>;
  /**
   * Read the reconciled output of this turn. A `continue` reconciliation also
   * requires the new effective epoch's real provider close.
   */
  readReconciledTurnOutput(): Promise<
    InteractionParentFinalTurnOutput & {
      readonly reconciliation: InteractionParentCommittedFact<InteractionParentOwnerReconciliationFact>;
      readonly resourceClose: InteractionParentCommittedFact<InteractionParentResourceCloseFact> | null;
    }
  >;
  /**
   * Read the settled request identity that a reconciled `continue` epoch must
   * chain its first request from, or `undefined` when no settled request exists
   * prior to the continuation.
   */
  readContinuationParentRequest(): Promise<ProviderRequestIdentityRef | undefined>;
  /**
   * Commit the original owner's actual `closed` Provider receipt exactly once.
   * It does not require a successful semantic output: a real close during error
   * cleanup is already enough. An exact repeat returns the first committed fact.
   */
  recordProviderClose(input: {
    readonly providerBinding: ProviderBinding;
    readonly result: ProviderCloseResult;
    readonly closedAt: string;
  }): Promise<InteractionParentCommittedFact<InteractionParentResourceCloseFact>>;
  readResourceClose(): Promise<InteractionParentCommittedFact<InteractionParentResourceCloseFact> | null>;
  /**
   * The terminal settled output only when an exact durable resource close also
   * exists for this turn. It reads one consistent snapshot, so a close and an
   * output from different moments can never be combined into a false success.
   */
  readClosedTurnOutput(): Promise<
    InteractionParentFinalTurnOutput & {
      readonly resourceClose: InteractionParentCommittedFact<InteractionParentResourceCloseFact>;
    }
  >;
  readonly requestContext: ProviderRequestContextHook<InteractionParentProviderExecutionIdentityRef>;
  inspectTurnRequests(): Promise<InteractionParentUnsettledRequests>;
  /**
   * Read this turn's single durable reconciliation decision from one snapshot.
   * The App consumes this decision instead of re-deriving request state, so the
   * eligibility, ignored-request and continuation rules keep one owner.
   */
  readReconciliationEligibility(): Promise<InteractionParentReconciliationEligibility>;
  /**
   * Decide whether this interrupted turn can be durably discharged. The read is
   * deliberately conservative: only the crash-left shape with committed input,
   * binding and execution owner, no close, settlement or reconciliation, only
   * running request phases, no terminal output and no unknown tool side effect
   * may be discharged.
   */
  readAbandonmentEligibility(): Promise<InteractionParentTurnAbandonmentEligibility>;
  /**
   * Durably record that this interrupted turn can never be recovered: the
   * Provider stream stopped before any terminal output and before any business
   * side effect. The append is validated against one snapshot inside the same
   * transaction that writes it, so eligibility cannot drift. It is idempotent
   * and never claims a success, a close or a recovered output.
   */
  abandonInterruptedTurn(input: {
    readonly reason: InteractionParentTurnAbandonmentFact['reason'];
    readonly abandonedAt: string;
  }): Promise<InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact>>;
  /**
   * Decide whether this interpreted turn can be closed as unusable. Only a turn
   * that already holds a real terminal output (a settled terminal request with
   * its completion and complete assistant text) qualifies: the output exists but
   * no decision could be parsed from it.
   */
  readParseFailureEligibility(): Promise<InteractionParentTurnParseFailureEligibility>;
  /**
   * Durably close a turn whose terminal output cannot be parsed into any
   * decision. It never claims an answer, a route, an abandonment, a close or a
   * settlement; it only records that this exact terminal output is unusable, so
   * the interaction scope stops blocking on an unrecoverable turn. It is
   * idempotent: an exact repeat returns the first committed fact.
   */
  closeUnparseableTurn(input: {
    readonly failedAt: string;
  }): Promise<InteractionParentCommittedFact<InteractionParentTurnParseFailureFact>>;
}

export interface InteractionParentTurnRawOwnerInput {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly initialInput: RawAsset;
  /** The physical owner authenticated by the caller when this turn is opened. */
  readonly executionOwner?: OccurrenceExecutionOwner;
  /** The actual Provider binding this turn uses; it is committed with the input. */
  readonly providerBinding: ProviderBinding;
  readonly priorCheckpoints?: readonly InteractionSemanticCheckpoint[];
  readonly journal: InteractionParentTurnRawJournalPort;
  readonly rawContent: RawContentReadPort;
  readonly instructions?: (
    input: ProviderRequestContextHookInput<InteractionParentProviderExecutionIdentityRef>,
  ) => Promise<RequestScopedInstructions | undefined>;
}

const UNSETTLED_PHASES = ['dispatching', 'dispatched', 'waiting'] as const;

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameTurnIdentity(left: InteractionTurnIdentity, right: InteractionTurnIdentity): boolean {
  return sameScopedId(left.organId, right.organId)
    && left.interactionScopeId === right.interactionScopeId
    && left.interactionId === right.interactionId
    && left.inputRevision === right.inputRevision
    && left.turnId === right.turnId;
}

function sameRequestIdentity(
  left: ProviderRequestIdentityRef,
  right: ProviderRequestIdentityRef,
): boolean {
  return left.turnId === right.turnId
    && left.requestId === right.requestId
    && left.parentRequestId === right.parentRequestId;
}

function cloneScope(scope: ScopeRef): ScopeRef {
  return {
    organId: { scope: scope.organId.scope, value: scope.organId.value },
    ...(scope.taskId === undefined ? {} : { taskId: { scope: scope.taskId.scope, value: scope.taskId.value } }),
    ...(scope.cycleId === undefined ? {} : { cycleId: { scope: scope.cycleId.scope, value: scope.cycleId.value } }),
    ...(scope.operationId === undefined ? {} : {
      operationId: { scope: scope.operationId.scope, value: scope.operationId.value },
    }),
  };
}

function cloneTurnIdentity(turn: InteractionTurnIdentity): InteractionTurnIdentity {
  return {
    organId: { scope: turn.organId.scope, value: turn.organId.value },
    interactionScopeId: turn.interactionScopeId,
    interactionId: turn.interactionId,
    inputRevision: turn.inputRevision,
    turnId: turn.turnId,
  };
}

function cloneExecution(
  execution: InteractionParentProviderExecutionIdentityRef,
): InteractionParentProviderExecutionIdentityRef {
  return {
    runtimeId: execution.runtimeId,
    organId: { scope: execution.organId.scope, value: execution.organId.value },
    operationId: { scope: execution.operationId.scope, value: execution.operationId.value },
    executionEpoch: execution.executionEpoch,
    interactionTurn: cloneTurnIdentity(execution.interactionTurn),
  };
}

function cloneExecutionOwner(owner: OccurrenceExecutionOwner): OccurrenceExecutionOwner {
  return {
    daemonLeaseId: owner.daemonLeaseId,
    daemonGeneration: owner.daemonGeneration,
    processStartToken: owner.processStartToken,
  };
}

function isInteractionParentExecution(
  execution: object,
): execution is InteractionParentProviderExecutionIdentityRef {
  return 'interactionTurn' in execution && execution.interactionTurn !== undefined;
}

function cloneProviderBinding(binding: ProviderBinding): ProviderBinding {
  return {
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    protocol: binding.protocol,
    endpointRef: binding.endpointRef,
    modelRef: binding.modelRef,
    configDigest: binding.configDigest,
    capabilityDigest: binding.capabilityDigest,
  };
}

function sameProviderBinding(left: ProviderBinding, right: ProviderBinding): boolean {
  return left.bindingId === right.bindingId
    && left.providerId === right.providerId
    && left.protocol === right.protocol
    && left.endpointRef === right.endpointRef
    && left.modelRef === right.modelRef
    && left.configDigest === right.configDigest
    && left.capabilityDigest === right.capabilityDigest;
}

function sameOccurrenceExecutionOwner(
  left: OccurrenceExecutionOwner,
  right: OccurrenceExecutionOwner,
): boolean {
  return left.daemonLeaseId === right.daemonLeaseId
    && left.daemonGeneration === right.daemonGeneration
    && left.processStartToken === right.processStartToken;
}

/**
 * The business identity a new physical epoch keeps. Only `executionEpoch` may
 * change across one turn; the runtime, organ, operation and business turn stay
 * the same, and the original turn input is never rewritten.
 */
function sameParentExecutionBusinessIdentity(
  left: InteractionParentProviderExecutionIdentityRef,
  right: InteractionParentProviderExecutionIdentityRef,
): boolean {
  return left.runtimeId === right.runtimeId
    && sameScopedId(left.organId, right.organId)
    && sameScopedId(left.operationId, right.operationId)
    && sameTurnIdentity(left.interactionTurn, right.interactionTurn);
}

function ownerReconciliationPair(
  left: OccurrenceExecutionOwner,
  right: OccurrenceExecutionOwner,
): string {
  return `${left.daemonGeneration}->${right.daemonGeneration}`;
}

/**
 * The exact commit set one snapshot exposes. A reconciliation stages its append
 * only against the same durable commit set it planned, so a concurrent write is
 * an explicit conflict instead of a silently recomputed mode.
 */
function snapshotCommitFingerprint(snapshot: InteractionParentTurnSnapshot): string {
  return canonicalJsonStringify({
    turnInput: snapshot.turnInput?.commit ?? null,
    requests: snapshot.requests.map((committed) => committed.commit),
    acceptedFacts: snapshot.acceptedFacts.map((committed) => committed.commit),
    ownerReconciliations: snapshot.ownerReconciliations.map((committed) => committed.commit),
    providerSettlements: snapshot.providerSettlements.map((committed) => committed.commit),
    resourceClose: snapshot.resourceClose?.commit ?? null,
    abandonment: snapshot.abandonment?.commit ?? null,
    parseFailure: snapshot.parseFailure?.commit ?? null,
  });
}

/**
 * The latest durable physical epoch and owner of this business turn. A
 * reconciliation only advances the epoch; a repeated crash keeps the latest
 * effective epoch instead of restarting at the opening epoch.
 */
function activeExecutionState(
  snapshot: InteractionParentTurnSnapshot,
): {
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly executionOwner: OccurrenceExecutionOwner | null;
} {
  if (snapshot.turnInput === null) {
    throw new ContractError('interaction parent reconciliation requires the committed turn input');
  }
  const latest = snapshot.ownerReconciliations.at(-1);
  if (latest === undefined) {
    return {
      execution: snapshot.turnInput.fact.execution,
      executionOwner: snapshot.turnInput.fact.executionOwner ?? null,
    };
  }
  return {
    execution: { ...snapshot.turnInput.fact.execution, executionEpoch: latest.fact.effectiveExecutionEpoch },
    executionOwner: latest.fact.replacementOwner,
  };
}

function ignoredRequests(snapshot: InteractionParentTurnSnapshot): readonly string[] {
  return [...new Set(snapshot.ownerReconciliations.flatMap((entry) => entry.fact.unsettledRequestIds))];
}

/**
 * The latest record of every request that the reconciliation has not already
 * abandoned. Both reconciliation eligibility and continuation-anchor reading
 * share this exact scope so they cannot disagree about which requests count.
 */
function nonIgnoredRequestRecords(
  snapshot: InteractionParentTurnSnapshot,
  ignored: ReadonlySet<string>,
): readonly RuntimeRequestRecord[] {
  const latest = new Map<string, RuntimeRequestRecord>();
  for (const committed of snapshot.requests) {
    if (ignored.has(committed.fact.request.requestId)) continue;
    latest.set(committed.fact.request.requestId, committed.fact);
  }
  return [...latest.values()];
}

function hasCommittedRequestCompletion(
  snapshot: InteractionParentTurnSnapshot,
  record: RuntimeRequestRecord,
): boolean {
  return snapshot.acceptedFacts.some((committed) =>
    sameRequestIdentity(committed.fact.envelope.request, record.request)
    && committed.fact.envelope.fact.kind === 'request-complete');
}

/**
 * Derive the one completed settled leaf request shared by final-output folding
 * and provider-settlement association. The label keeps existing final-output
 * diagnostics while the settlement path reports its own boundary.
 */
function completedTerminalRequest(
  snapshot: InteractionParentTurnSnapshot,
  ignoredRequestIds: readonly string[],
  label: string,
): {
  readonly terminalRequest: RuntimeRequestRecord;
  readonly requestCompleteCommit: JournalCommitRef;
} {
  const ignored = new Set(ignoredRequestIds);
  const requests = nonIgnoredRequestRecords(snapshot, ignored);
  if (requests.length === 0) {
    throw new ContractError(`${label} requires at least one registered request`);
  }
  const unsettled = requests.filter((record) =>
    (UNSETTLED_PHASES as readonly string[]).includes(record.phase));
  if (unsettled.length > 0) {
    throw new ContractError(
      `${label} requires every request to leave dispatching, dispatched and waiting`,
    );
  }
  const parentRequestIds = new Set(
    requests
      .map((record) => record.request.parentRequestId)
      .filter((parentRequestId): parentRequestId is string => parentRequestId !== undefined),
  );
  const terminals = requests.filter((record) =>
    record.phase === 'settled' && !parentRequestIds.has(record.request.requestId));
  if (terminals.length !== 1) {
    throw new ContractError(
      `${label} requires exactly one settled terminal request, found ${terminals.length}`,
    );
  }
  const terminalRequest = terminals[0]!;
  const completions = snapshot.acceptedFacts.filter((committed) =>
    !ignored.has(committed.fact.envelope.request.requestId)
    && sameRequestIdentity(committed.fact.envelope.request, terminalRequest.request)
    && committed.fact.envelope.fact.kind === 'request-complete');
  if (completions.length !== 1) {
    throw new ContractError(
      `${label} requires exactly one request-complete fact for ${terminalRequest.request.requestId}`,
    );
  }
  const completion = completions[0]!;
  if (completion.fact.envelope.fact.kind !== 'request-complete'
    || completion.fact.envelope.fact.terminal !== 'completed') {
    throw new ContractError(`${label} requires a completed terminal request`);
  }
  return { terminalRequest, requestCompleteCommit: completion.commit };
}

function toolPairKey(
  request: ProviderRequestIdentityRef,
  executionEpoch: number,
  callId: string,
  continuationRef: string,
): string {
  return canonicalJsonStringify([
    executionEpoch,
    request.turnId,
    request.requestId,
    request.parentRequestId ?? null,
    callId,
    continuationRef,
  ]);
}

/**
 * The idempotency core of a resource close: everything except the first
 * `closedAt`. An exact retry preserves the first time and commit; a different
 * binding or result is a conflict.
 */
function resourceCloseCore(fact: InteractionParentResourceCloseFact): unknown {
  return { turn: fact.turn, execution: fact.execution, providerBinding: fact.providerBinding, result: fact.result };
}

/**
 * Reuse the existing latest-turn validator to check the initial input asset, so
 * RawAsset, view and organ-scope rules keep a single owner instead of a second
 * copy here.
 */
function assertInitialInput(turn: InteractionTurnIdentity, initialInput: RawAsset): void {
  validateInteractionLatestTurn({
    organId: turn.organId,
    interactionScopeId: turn.interactionScopeId,
    interactionId: turn.interactionId,
    inputRevision: turn.inputRevision,
    turnId: turn.turnId,
    entries: [{ kind: 'user-input', content: initialInput }],
  });
}

export function createInteractionParentTurnRawOwner(
  input: InteractionParentTurnRawOwnerInput,
): InteractionParentTurnRawOwner {
  validateInteractionTurnIdentity(input.turn);
  assertProviderExecutionIdentity(input.execution);
  if (!isInteractionParentExecution(input.execution)) {
    throw new ContractError('interaction parent turn owner requires a neutral interaction parent execution identity');
  }
  if (!sameTurnIdentity(input.execution.interactionTurn, input.turn)) {
    throw new ContractError('interaction parent execution turn does not match the owner turn');
  }
  assertSameScope(input.scope);
  if (input.scope.taskId !== undefined || input.scope.cycleId !== undefined) {
    throw new ContractError('interaction parent scope cannot carry a task or cycle');
  }
  if (!sameScopedId(input.scope.organId, input.turn.organId)) {
    throw new ContractError('interaction parent scope organ does not match the owner turn');
  }
  if (input.scope.operationId === undefined
    || !sameScopedId(input.scope.operationId, input.execution.operationId)) {
    throw new ContractError('interaction parent scope operation does not match the owner execution');
  }
  assertInitialInput(input.turn, input.initialInput);
  validateProviderBinding(input.providerBinding);
  if (input.executionOwner !== undefined) validateOccurrenceExecutionOwner(input.executionOwner);
  const priorCheckpoints = [...(input.priorCheckpoints ?? [])];
  for (const checkpoint of priorCheckpoints) validateInteractionSemanticCheckpoint(checkpoint);

  const turn = cloneTurnIdentity(input.turn);
  const execution = cloneExecution(input.execution);
  const scope = cloneScope(input.scope);
  const providerBinding = cloneProviderBinding(input.providerBinding);
  const journal = input.journal;
  const rawContent = input.rawContent;
  const turnInputFact: InteractionParentTurnInputFact = {
    turn: cloneTurnIdentity(turn),
    execution: cloneExecution(execution),
    scope: cloneScope(scope),
    initialInput: input.initialInput,
    ...(input.executionOwner === undefined
      ? {}
      : { executionOwner: cloneExecutionOwner(input.executionOwner) }),
    providerBinding: cloneProviderBinding(providerBinding),
    priorCheckpoints,
  };

  function assertOwnerExecution(candidate: { readonly runtimeId: string; readonly executionEpoch: number }): void {
    if (candidate.runtimeId !== execution.runtimeId
      || candidate.executionEpoch !== execution.executionEpoch) {
      throw new ContractError('interaction parent execution does not match the owner execution');
    }
  }

  function assertRegisteredRequest(
    snapshot: InteractionParentTurnSnapshot,
    request: ProviderRequestIdentityRef,
  ): RuntimeRequestRecord {
    const registered = snapshot.requests.find((committed) => sameRequestIdentity(committed.fact.request, request));
    if (registered === undefined) {
      throw new ContractError(`interaction parent raw history requires the registered request ${request.requestId}`);
    }
    return registered.fact;
  }

  /**
   * Fold confirmed history under its original physical epochs. Request identity
   * and original sequence remain unchanged across a local owner replacement.
   */
  async function foldSnapshot(
    snapshot: InteractionParentTurnSnapshot,
    requestId: string,
    ignoredRequestIds: readonly string[],
  ) {
    if (snapshot.turnInput === null) {
      throw new ContractError('interaction parent fold requires the committed turn input');
    }
    const ignored = new Set(ignoredRequestIds);
    const groups = new Map<number, {
      readonly execution: InteractionParentProviderExecutionIdentityRef;
      readonly entries: AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>[];
    }>();
    for (const committed of snapshot.acceptedFacts) {
      if (ignored.has(committed.fact.envelope.request.requestId)) continue;
      const entryExecution = committed.fact.envelope.execution;
      if (entryExecution.runtimeId !== execution.runtimeId
        || (isInteractionParentExecution(entryExecution)
          && !sameParentExecutionBusinessIdentity(entryExecution, execution))) {
        throw new ContractError('interaction parent raw fact has a foreign execution identity');
      }
      const group = groups.get(entryExecution.executionEpoch);
      if (group === undefined) {
        groups.set(entryExecution.executionEpoch, {
          execution: { ...snapshot.turnInput.fact.execution, executionEpoch: entryExecution.executionEpoch },
          entries: [committed.fact],
        });
      } else {
        group.entries.push(committed.fact);
      }
    }
    if (groups.size === 0) groups.set(execution.executionEpoch, { execution, entries: [] });
    const entries: ResolvedActiveTurnEntry<InteractionParentProviderExecutionIdentityRef>[] = [];
    const contentUnits: ResolvedContentUnit[] = [];
    let initialInputText = '';
    for (const group of groups.values()) {
      const folded = await foldActiveTurn<
        { readonly requestId: string },
        { readonly execution: InteractionParentProviderExecutionIdentityRef; readonly scope: ScopeRef },
        InteractionParentProviderExecutionIdentityRef
      >({
        binding: { execution: group.execution, scope },
        initialInput: snapshot.turnInput.fact.initialInput,
        entries: group.entries,
        requests: snapshot.requests.map((committed) => committed.fact),
        childInvocations: [],
        cut: { requestId },
        checkpointPath: [],
        completionRefs: [],
        rawContent,
      });
      initialInputText = decodeUtf8(folded.initialInput.bytes);
      entries.push(...folded.entries);
      contentUnits.push(...folded.contentUnits);
    }
    entries.sort((left, right) => left.accepted.seq - right.accepted.seq);
    contentUnits.sort((left, right) => left.firstSeq - right.firstSeq);
    return { entries, contentUnits, initialInputText };
  }

  /**
   * The shared, snapshot-based final-output reader. Both `readFinalTurnOutput`
   * and `readClosedTurnOutput` use it, so a closed-output read never combines a
   * close and an output from two different moments.
   */
  async function finalOutputFromSnapshot(
    snapshot: InteractionParentTurnSnapshot,
    ignoredRequestIds: readonly string[] = [],
  ): Promise<InteractionParentFinalTurnOutput> {
    if (snapshot.turnInput === null) {
      throw new ContractError('interaction parent final output requires the committed turn input');
    }
    const { terminalRequest, requestCompleteCommit } = completedTerminalRequest(
      snapshot,
      ignoredRequestIds,
      'interaction parent final output',
    );

    const { entries: mergedEntries, contentUnits: mergedUnits, initialInputText } = await foldSnapshot(
      snapshot, terminalRequest.request.requestId, ignoredRequestIds,
    );

    const finalUnits = mergedUnits.filter((unit) =>
      unit.request.requestId === terminalRequest.request.requestId
      && unit.request.turnId === terminalRequest.request.turnId
      && unit.channel === 'assistant-text'
      && unit.supersededBy === undefined);
    if (finalUnits.length === 0) {
      throw new ContractError('interaction parent final output requires at least one assistant-text unit');
    }
    for (const unit of finalUnits) {
      if (!unit.complete) {
        throw new ContractError('interaction parent final output requires every assistant-text unit to be complete');
      }
    }
    const sourceSeqs = new Set<number>();
    for (const unit of finalUnits) for (const seq of unit.sourceSeqs) sourceSeqs.add(seq);
    const assistantContentRefs: EvidenceRef[] = [];
    const seenRefs = new Set<string>();
    for (const entry of mergedEntries) {
      if (entry.kind !== 'content' || !sourceSeqs.has(entry.accepted.seq)) continue;
      const ref = entry.accepted.envelope.fact.content.ref;
      const key = canonicalJsonStringify(ref);
      if (seenRefs.has(key)) continue;
      seenRefs.add(key);
      assistantContentRefs.push(ref);
    }
    if (assistantContentRefs.length === 0) {
      throw new ContractError('interaction parent final output requires assistant content evidence refs');
    }
    const assistantText = decodeUtf8(concatBytes(finalUnits.map((unit) => unit.bytes)));
    if (assistantText.trim() === '') {
      throw new ContractError('interaction parent final output requires non-empty assistant text');
    }
    return {
      turnInput: snapshot.turnInput,
      initialInputText,
      terminalRequest,
      requestCompleteCommit,
      assistantText,
      assistantContentRefs,
    };
  }

  /**
   * Whether a request committed any raw fact. A failed request with zero
   * accepted facts left no partial output or tool side effect to replay, so it
   * is the only failed shape a closed epoch may abandon and retry.
   */
  function hasAcceptedFacts(
    snapshot: InteractionParentTurnSnapshot,
    record: RuntimeRequestRecord,
  ): boolean {
    return snapshot.acceptedFacts.some((committed) =>
      sameRequestIdentity(committed.fact.envelope.request, record.request));
  }

  function assertActiveOwner(snapshot: InteractionParentTurnSnapshot): void {
    const active = activeExecutionState(snapshot);
    if (canonicalJsonStringify(active.execution) !== canonicalJsonStringify(execution)
      || (active.executionOwner !== null
        && (input.executionOwner === undefined
          || !sameOccurrenceExecutionOwner(active.executionOwner, input.executionOwner)))) {
      throw new ContractError('interaction parent write requires the active execution owner');
    }
  }

  async function requestEligibility(
    snapshot: InteractionParentTurnSnapshot,
  ): Promise<{
    readonly mode: 'terminal-output' | 'continue';
    readonly unsettledRequestIds: readonly string[];
    readonly effectiveExecutionEpoch: number;
  }> {
    if (snapshot.turnInput === null) {
      throw new ContractError('interaction parent reconciliation requires the committed turn input');
    }
    const active = activeExecutionState(snapshot);
    const ignored = new Set(ignoredRequests(snapshot));
    const requests = nonIgnoredRequestRecords(snapshot, ignored);
    // The active epoch's provider is physically released only when its own
    // close is committed. A failed request in that closed epoch may resume in a
    // new epoch, but only when it left zero accepted facts.
    const hasActiveEpochClose = snapshot.resourceClose !== null
      && snapshot.resourceClose.fact.execution.executionEpoch === active.execution.executionEpoch;
    const failedClosedZeroFactRequests = hasActiveEpochClose
      ? requests.filter((record) => record.phase === 'failed' && !hasAcceptedFacts(snapshot, record))
      : [];
    const unsettledRequests = requests.filter((record) =>
      (UNSETTLED_PHASES as readonly string[]).includes(record.phase));
    const unsettledRequestIds = requests
      .filter((record) => (UNSETTLED_PHASES as readonly string[]).includes(record.phase)
        || (record.phase === 'settled' && !hasCommittedRequestCompletion(snapshot, record))
        || (hasActiveEpochClose && record.phase === 'failed' && !hasAcceptedFacts(snapshot, record)))
      .map((record) => record.request.requestId);

    // An unpaired tool call is an unknown physical side effect: it holds the
    // reconciliation instead of being replayed or silently dropped.
    const toolCalls = snapshot.acceptedFacts.filter((committed) =>
      committed.fact.envelope.fact.kind === 'tool-call');
    const toolResults = new Set(
      snapshot.acceptedFacts
        .filter((committed) => committed.fact.envelope.fact.kind === 'tool-result')
        .map((committed) => {
          const fact = committed.fact.envelope.fact;
          if (fact.kind !== 'tool-result') return '';
          return toolPairKey(committed.fact.envelope.request, committed.fact.envelope.execution.executionEpoch,
            fact.callId, fact.continuationRef);
        }),
    );
    for (const committed of toolCalls) {
      const fact = committed.fact.envelope.fact;
      if (fact.kind !== 'tool-call') continue;
      if (!toolResults.has(toolPairKey(committed.fact.envelope.request, committed.fact.envelope.execution.executionEpoch,
        fact.call.callId, fact.call.continuationRef))) {
        throw new ContractError(
          `interaction parent tool call ${fact.call.callId} has no committed result; its side effect is unknown`,
        );
      }
    }

    // Hold every cancelled request and every failed request that is not the
    // proven closed-failed-zero-fact shape: their side effects are unknown and
    // must never be replayed or silently dropped.
    if (requests.some((record) =>
      record.phase === 'cancelled'
      || (record.phase === 'failed' && (!hasActiveEpochClose || hasAcceptedFacts(snapshot, record))))) {
      throw new ContractError(
        'interaction parent continuation requires every non-ignored request to be settled',
      );
    }

    if (unsettledRequests.length > 0 || failedClosedZeroFactRequests.length > 0) {
      return {
        mode: 'continue',
        unsettledRequestIds,
        effectiveExecutionEpoch: active.execution.executionEpoch + 1,
      };
    }

    if (requests.length === 0) {
      return {
        mode: 'continue',
        unsettledRequestIds,
        effectiveExecutionEpoch: active.execution.executionEpoch + 1,
      };
    }

    // The settled leaf request is the settled request no registered request
    // continues. A settled request that produced tool calls is an intermediate
    // step awaiting continuation, never final output.
    const parentRequestIds = new Set(
      requests
        .map((record) => record.request.parentRequestId)
        .filter((parentRequestId): parentRequestId is string => parentRequestId !== undefined),
    );
    const leaves = requests.filter((record) =>
      record.phase === 'settled' && !parentRequestIds.has(record.request.requestId));
    if (leaves.length === 1) {
      const leaf = leaves[0]!;
      const leafToolCalls = toolCalls.filter((committed) =>
        sameRequestIdentity(committed.fact.envelope.request, leaf.request));
      const leafCompletion = snapshot.acceptedFacts.find((committed) =>
        sameRequestIdentity(committed.fact.envelope.request, leaf.request)
        && committed.fact.envelope.fact.kind === 'request-complete');
      if (leafToolCalls.length === 0
        && leafCompletion !== undefined
        && leafCompletion.fact.envelope.fact.kind === 'request-complete'
        && leafCompletion.fact.envelope.fact.terminal === 'completed') {
        const folded = await foldSnapshot(snapshot, leaf.request.requestId, [...ignored]);
        const finalUnits = folded.contentUnits.filter((unit) =>
          sameRequestIdentity(unit.request, leaf.request)
          && unit.channel === 'assistant-text' && unit.supersededBy === undefined);
        if (finalUnits.length > 0 && finalUnits.every((unit) => unit.complete)
          && decodeUtf8(concatBytes(finalUnits.map((unit) => unit.bytes))).trim() !== '') {
          return {
            mode: 'terminal-output',
            unsettledRequestIds,
            effectiveExecutionEpoch: active.execution.executionEpoch,
          };
        }
      }
    }

    return {
      mode: 'continue',
      unsettledRequestIds,
      effectiveExecutionEpoch: active.execution.executionEpoch + 1,
    };
  }

  /**
   * Commit one local owner reconciliation. The eligibility decision and the
   * append are staged in one transaction against one commit fingerprint, so the
   * mode is never recomputed after a concurrent write.
   */
  async function commitReconciliation(
    previousOwner: OccurrenceExecutionOwner,
    replacementOwner: OccurrenceExecutionOwner,
    isCommittedReplacement: boolean,
    reconciledAt: string,
  ): Promise<InteractionParentCommittedFact<InteractionParentOwnerReconciliationFact>> {
    if (reconciledAt.trim() === '') {
      throw new ContractError('interaction parent owner reconciliation requires a reconciledAt timestamp');
    }
    validateOccurrenceExecutionOwner(previousOwner);
    validateOccurrenceExecutionOwner(replacementOwner);
    const sameOwner = sameOccurrenceExecutionOwner(previousOwner, replacementOwner);
    // A distinct owner needs the authoritative committed-replacement proof. A
    // same owner is only the post-close failed-epoch re-entry below, so it is
    // authorized by the durable close and eligibility, never by this flag.
    if (!sameOwner && !isCommittedReplacement) {
      throw new ContractError('interaction parent owner reconciliation requires a committed replacement owner');
    }
    const planSnapshot = await journal.readTurnSnapshot(turn);
    if (planSnapshot.turnInput === null) {
      throw new ContractError('interaction parent owner reconciliation requires the committed turn input');
    }
    const active = activeExecutionState(planSnapshot);
    if (active.executionOwner === null) {
      throw new ContractError(
        'interaction parent owner reconciliation requires the authenticated original turn owner',
      );
    }
    const committedBinding = planSnapshot.turnInput.fact.providerBinding;
    if (committedBinding === undefined
      || !sameParentExecutionBusinessIdentity(planSnapshot.turnInput.fact.execution, execution)
      || !sameProviderBinding(committedBinding, providerBinding)) {
      throw new ContractError('interaction parent reconciliation requires the committed execution identity and provider');
    }
    const closedEpoch = planSnapshot.resourceClose !== null;
    if (closedEpoch) {
      // A committed close is the only way a same owner may open the next epoch.
      // The previous owner must be the active owner, and the closed epoch must
      // prove the failed-zero-fact continuation below.
      if (!sameOccurrenceExecutionOwner(active.executionOwner, previousOwner)) {
        throw new ContractError(
          'interaction parent owner reconciliation previous owner is not the committed turn owner',
        );
      }
    } else {
      if (sameOwner) {
        throw new ContractError('interaction parent owner reconciliation requires a distinct replacement owner');
      }
      const existingPair = planSnapshot.ownerReconciliations.find((entry) =>
        ownerReconciliationPair(entry.fact.previousOwner, entry.fact.replacementOwner)
          === ownerReconciliationPair(previousOwner, replacementOwner));
      if (existingPair !== undefined) {
        if (!sameOccurrenceExecutionOwner(existingPair.fact.previousOwner, previousOwner)
          || !sameOccurrenceExecutionOwner(existingPair.fact.replacementOwner, replacementOwner)) {
          throw new ContractError('interaction parent owner reconciliation conflicts with the committed owner pair');
        }
        return existingPair;
      }
      if (!sameOccurrenceExecutionOwner(active.executionOwner, previousOwner)) {
        throw new ContractError(
          'interaction parent owner reconciliation previous owner is not the committed turn owner',
        );
      }
    }
    const eligibility = await requestEligibility(planSnapshot);
    // A post-close reconciliation is only ever the failed-zero-fact
    // continuation; any other closed shape stays held on its own typed error.
    if (closedEpoch
      && (eligibility.mode !== 'continue' || eligibility.unsettledRequestIds.length === 0)) {
      throw new ContractError(
        'interaction parent owner reconciliation requires a turn without a committed resource close',
      );
    }
    if (eligibility.mode === 'terminal-output') {
      await finalOutputFromSnapshot(planSnapshot, ignoredRequests(planSnapshot));
    }
    const fact: InteractionParentOwnerReconciliationFact = {
      turn: cloneTurnIdentity(turn),
      execution: {
        ...cloneExecution(planSnapshot.turnInput.fact.execution),
        executionEpoch: eligibility.effectiveExecutionEpoch,
      },
      providerBinding: cloneProviderBinding(committedBinding),
      previousOwner: cloneExecutionOwner(previousOwner),
      replacementOwner: cloneExecutionOwner(replacementOwner),
      mode: eligibility.mode,
      effectiveExecutionEpoch: eligibility.effectiveExecutionEpoch,
      unsettledRequestIds: eligibility.unsettledRequestIds,
      remoteProviderState: 'unknown',
      reconciledAt,
    };
    const fingerprint = snapshotCommitFingerprint(planSnapshot);
    const { committed } = await journal.transactTurn(turn, (snapshot) => {
      if (snapshotCommitFingerprint(snapshot) !== fingerprint) {
        throw new ContractError(
          'interaction parent owner reconciliation conflicts with a concurrent durable write',
        );
      }
      return { append: { kind: 'owner-reconciliation', turn, execution: fact.execution, fact }, result: undefined };
    });
    if (committed === undefined) {
      throw new ContractError('interaction parent owner reconciliation append did not commit');
    }
    return { fact, commit: committed };
  }

  /**
   * Decide whether one interrupted parent turn may be durably discharged.
   *
   * The decision is deliberately conservative and explicit. Discharge is only
   * possible for the exact shape a process crash leaves behind: a committed
   * turn input with its Provider binding and execution owner; no committed
   * close, Provider settlement or owner reconciliation; every non-ignored
   * request still in a running phase; no terminal output (no request-complete
   * and no complete assistant text); and no unknown tool side effect (every
   * tool call has its committed result and every result has its call). Any
   * other shape keeps its own recovery path or its own explicit hold.
   */
  function abandonmentEligibility(
    snapshot: InteractionParentTurnSnapshot,
  ): InteractionParentTurnAbandonmentEligibility {
    const held = (heldReason: string): InteractionParentTurnAbandonmentEligibility => ({
      abandonable: false,
      heldReason,
    });
    if (snapshot.turnInput === null) return held('the committed turn input is missing');
    const committedInput = snapshot.turnInput.fact;
    if (committedInput.providerBinding === undefined) return held('the committed provider binding is missing');
    if (committedInput.executionOwner === undefined) return held('the authenticated execution owner is missing');
    if (snapshot.resourceClose !== null) return held('the provider resource close is already committed');
    if (snapshot.ownerReconciliations.length > 0) return held('an owner reconciliation is committed');
    if (snapshot.providerSettlements.length > 0) return held('a provider settlement is committed');
    const ignored = new Set(ignoredRequests(snapshot));
    const requests = nonIgnoredRequestRecords(snapshot, ignored);
    for (const record of requests) {
      if (record.phase !== 'dispatching' && record.phase !== 'dispatched' && record.phase !== 'waiting') {
        return held(`request ${record.request.requestId} is ${record.phase}, not interrupted`);
      }
    }
    if (snapshot.acceptedFacts.some((committed) =>
      committed.fact.envelope.fact.kind === 'request-complete')) {
      return held('a request completion is committed');
    }
    if (snapshot.acceptedFacts.some((committed) => {
      const fact = committed.fact.envelope.fact;
      return fact.kind === 'content' && fact.channel === 'assistant-text' && fact.complete;
    })) {
      return held('complete assistant text is committed');
    }
    const toolCalls = snapshot.acceptedFacts.filter((committed) =>
      committed.fact.envelope.fact.kind === 'tool-call');
    const toolResults = snapshot.acceptedFacts.filter((committed) =>
      committed.fact.envelope.fact.kind === 'tool-result');
    const resultKeys = new Set(toolResults.map((committed) => {
      const fact = committed.fact.envelope.fact;
      if (fact.kind !== 'tool-result') return '';
      return toolPairKey(committed.fact.envelope.request, committed.fact.envelope.execution.executionEpoch,
        fact.callId, fact.continuationRef);
    }));
    for (const committed of toolCalls) {
      const fact = committed.fact.envelope.fact;
      if (fact.kind !== 'tool-call') continue;
      if (!resultKeys.has(toolPairKey(committed.fact.envelope.request,
        committed.fact.envelope.execution.executionEpoch, fact.call.callId, fact.call.continuationRef))) {
        return held(`tool call ${fact.call.callId} has no committed result; its side effect is unknown`);
      }
    }
    const callKeys = new Set(toolCalls.map((committed) => {
      const fact = committed.fact.envelope.fact;
      if (fact.kind !== 'tool-call') return '';
      return toolPairKey(committed.fact.envelope.request, committed.fact.envelope.execution.executionEpoch,
        fact.call.callId, fact.call.continuationRef);
    }));
    for (const committed of toolResults) {
      const fact = committed.fact.envelope.fact;
      if (fact.kind !== 'tool-result') continue;
      if (!callKeys.has(toolPairKey(committed.fact.envelope.request,
        committed.fact.envelope.execution.executionEpoch, fact.callId, fact.continuationRef))) {
        return held(`tool result ${fact.callId} has no committed call; its side effect is unknown`);
      }
    }
    // A recorded tool result proves only that the result was recorded, never
    // that the business side effect did not happen. Any committed tool activity
    // keeps this turn in the recover/hold lane instead of terminal discharge.
    const firstCall = toolCalls[0];
    if (firstCall !== undefined) {
      const fact = firstCall.fact.envelope.fact;
      if (fact.kind === 'tool-call') {
        return held(`tool call ${fact.call.callId} is committed; a recorded result does not prove the absence of a business side effect`);
      }
    }
    const firstResult = toolResults[0];
    if (firstResult !== undefined) {
      const fact = firstResult.fact.envelope.fact;
      if (fact.kind === 'tool-result') {
        return held(`tool result ${fact.callId} is committed; a recorded result does not prove the absence of a business side effect`);
      }
    }
    return { abandonable: true };
  }

  async function commitAbandonment(input: {
    readonly reason: InteractionParentTurnAbandonmentFact['reason'];
    readonly abandonedAt: string;
  }): Promise<InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact>> {
    if (input.reason !== 'provider-interrupted-without-terminal-output') {
      throw new ContractError('interaction parent turn abandonment reason is invalid');
    }
    if (typeof input.abandonedAt !== 'string' || input.abandonedAt.trim() === '') {
      throw new ContractError('interaction parent turn abandonment requires an abandonedAt timestamp');
    }
    const { committed, result } = await journal.transactTurn<
      | {
          readonly kind: 'existing';
          readonly committed: InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact>;
        }
      | { readonly kind: 'new'; readonly fact: InteractionParentTurnAbandonmentFact }
    >(turn, (snapshot) => {
      if (snapshot.turnInput === null) {
        throw new ContractError('interaction parent turn abandonment requires the committed turn input');
      }
      const existing = snapshot.abandonment;
      if (existing !== null) {
        // An exact retry reuses the first durable discharge; a conflicting
        // reason or binding is a real conflict, never a silent rewrite.
        const core = (fact: InteractionParentTurnAbandonmentFact): unknown => ({
          turn: fact.turn, execution: fact.execution, providerBinding: fact.providerBinding, reason: fact.reason,
        });
        const requested = {
          turn,
          execution: snapshot.turnInput.fact.execution,
          providerBinding: snapshot.turnInput.fact.providerBinding,
          reason: input.reason,
        };
        if (canonicalJsonStringify(core(existing.fact)) !== canonicalJsonStringify(requested)) {
          throw new ContractError('interaction parent turn abandonment conflicts with the committed discharge');
        }
        return { result: { kind: 'existing', committed: existing } };
      }
      const eligibility = abandonmentEligibility(snapshot);
      if (!eligibility.abandonable) {
        throw new ContractError(`interaction parent turn cannot be abandoned: ${eligibility.heldReason}`);
      }
      const fact: InteractionParentTurnAbandonmentFact = {
        turn: cloneTurnIdentity(turn),
        execution: cloneExecution(snapshot.turnInput.fact.execution),
        providerBinding: cloneProviderBinding(snapshot.turnInput.fact.providerBinding!),
        reason: input.reason,
        abandonedAt: input.abandonedAt,
      };
      return {
        append: { kind: 'turn-abandonment', turn, execution: fact.execution, fact },
        result: { kind: 'new', fact },
      };
    });
    if (result.kind === 'existing') return result.committed;
    if (committed === undefined) {
      throw new ContractError('interaction parent turn abandonment append did not commit');
    }
    return { fact: result.fact, commit: committed };
  }

  /**
   * Decide whether one interpreted turn can be closed as unusable.
   *
   * The decision is the mirror image of abandonment: this turn did reach a real
   * terminal output (one settled terminal request, its `completed` completion
   * and its assistant text), so the only remaining reason it produced no
   * decision is that the output itself is unusable. Any shape without a real
   * terminal output keeps its own recovery path instead of being closed here.
   */
  async function parseFailureEligibility(
    snapshot: InteractionParentTurnSnapshot,
  ): Promise<InteractionParentTurnParseFailureEligibility> {
    const held = (heldReason: string): InteractionParentTurnParseFailureEligibility => ({
      closeable: false,
      heldReason,
    });
    if (snapshot.turnInput === null) return held('the committed turn input is missing');
    const committedInput = snapshot.turnInput.fact;
    if (committedInput.providerBinding === undefined) return held('the committed provider binding is missing');
    if (snapshot.abandonment !== null) return held('the turn is already discharged as interrupted without terminal output');
    if (snapshot.parseFailure !== null) return held('the turn is already closed as unparseable');
    try {
      // The same fold the two real output readers use, so a turn is only closed
      // when a genuine terminal output exists but yielded no usable decision.
      const output = await finalOutputFromSnapshot(snapshot, ignoredRequests(snapshot));
      return {
        closeable: true,
        terminalRequestId: output.terminalRequest.request.requestId,
        executionEpoch: activeExecutionState(snapshot).execution.executionEpoch,
      };
    } catch (error) {
      return held(`it has no real terminal output to close: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function commitParseFailure(input: {
    readonly failedAt: string;
  }): Promise<InteractionParentCommittedFact<InteractionParentTurnParseFailureFact>> {
    if (typeof input.failedAt !== 'string' || input.failedAt.trim() === '') {
      throw new ContractError('interaction parent turn parse failure requires a failedAt timestamp');
    }
    const planSnapshot = await journal.readTurnSnapshot(turn);
    const existing = planSnapshot.parseFailure;
    // An exact retry reuses the first committed closure, so a repeated interpret
    // never writes a second fact and never conflicts with itself.
    if (existing !== null) return existing;
    const eligibility = await parseFailureEligibility(planSnapshot);
    if (!eligibility.closeable) {
      throw new ContractError(`interaction parent turn cannot be closed as unparseable: ${eligibility.heldReason}`);
    }
    const active = activeExecutionState(planSnapshot);
    const fact: InteractionParentTurnParseFailureFact = {
      turn: cloneTurnIdentity(turn),
      execution: cloneExecution(active.execution),
      providerBinding: cloneProviderBinding(planSnapshot.turnInput!.fact.providerBinding!),
      terminalRequestId: eligibility.terminalRequestId,
      executionEpoch: eligibility.executionEpoch,
      failedAt: input.failedAt,
    };
    const fingerprint = snapshotCommitFingerprint(planSnapshot);
    const { committed, result } = await journal.transactTurn<
      | {
          readonly kind: 'existing';
          readonly committed: InteractionParentCommittedFact<InteractionParentTurnParseFailureFact>;
        }
      | { readonly kind: 'new'; readonly fact: InteractionParentTurnParseFailureFact }
    >(turn, (snapshot) => {
      const raced = snapshot.parseFailure;
      if (raced !== null) return { result: { kind: 'existing', committed: raced } };
      if (snapshotCommitFingerprint(snapshot) !== fingerprint) {
        throw new ContractError('interaction parent turn parse failure conflicts with a concurrent durable write');
      }
      return {
        append: { kind: 'turn-parse-failure', turn, execution: fact.execution, fact },
        result: { kind: 'new', fact },
      };
    });
    if (result.kind === 'existing') return result.committed;
    if (committed === undefined) {
      throw new ContractError('interaction parent turn parse failure append did not commit');
    }
    return { fact: result.fact, commit: committed };
  }

  return {
    turn: cloneTurnIdentity(turn),
    execution: cloneExecution(execution),
    scope: cloneScope(scope),

    async openTurnInput(): Promise<InteractionParentCommittedFact<InteractionParentTurnInputFact>> {
      const { committed, result } = await journal.transactTurn<
        | { readonly kind: 'existing'; readonly committed: InteractionParentCommittedFact<InteractionParentTurnInputFact> }
        | { readonly kind: 'new' }
      >(turn, (snapshot) => {
        if (snapshot.turnInput === null) {
          return { append: { kind: 'turn-input', fact: turnInputFact }, result: { kind: 'new' } };
        }
        if (canonicalJsonStringify(snapshot.turnInput.fact) !== canonicalJsonStringify(turnInputFact)) {
          const latest = snapshot.ownerReconciliations.at(-1);
          if (latest === undefined) {
            throw new ContractError('interaction parent turn input conflicts with the committed turn input');
          }
          assertActiveOwner(snapshot);
          const { execution: _execution, executionOwner: _owner, ...committedInput } = snapshot.turnInput.fact;
          const { execution: _newExecution, executionOwner: _newOwner, ...replacementInput } = turnInputFact;
          if (canonicalJsonStringify(committedInput) !== canonicalJsonStringify(replacementInput)) {
            throw new ContractError('interaction parent turn input conflicts with the committed turn input');
          }
        }
        return { result: { kind: 'existing', committed: snapshot.turnInput } };
      });
      if (result.kind === 'existing') return result.committed;
      if (committed === undefined) {
        throw new ContractError('interaction parent turn input append did not commit');
      }
      return { fact: turnInputFact, commit: committed };
    },

    async registerRequest(registration: NativeRequestRegistration): Promise<RuntimeRequestRecord> {
      const record = registration.record;
      assertOwnerExecution(registration.execution);
      assertSameScope(record.scope, scope);
      if (record.parentRequestId !== record.request.parentRequestId) {
        throw new ContractError('interaction parent request parentRequestId does not match its request identity');
      }
      const { result } = await journal.transactTurn<
        | { readonly kind: 'existing'; readonly record: RuntimeRequestRecord }
        | { readonly kind: 'new' }
      >(turn, (snapshot) => {
        const byId = snapshot.requests.find((committed) => committed.fact.request.requestId === record.request.requestId);
        if (byId !== undefined && !sameRequestIdentity(byId.fact.request, record.request)) {
          throw new ContractError(`interaction parent request ${record.request.requestId} identity is immutable`);
        }
        const samePhase = snapshot.requests.find((committed) =>
          sameRequestIdentity(committed.fact.request, record.request) && committed.fact.phase === record.phase);
        // The same request identity and phase is an idempotent replay only when
        // the whole record matches. A different payload under the same phase is
        // a conflict, not a silent overwrite.
        if (samePhase !== undefined) {
          if (canonicalJsonStringify(samePhase.fact) !== canonicalJsonStringify(record)) {
            throw new ContractError(
              `interaction parent request ${record.request.requestId}@${record.phase} conflicts with a different payload`,
            );
          }
          return { result: { kind: 'existing', record: samePhase.fact } };
        }
        // After a durable resource close the request history is frozen: only
        // exact replays above are allowed, because the physical owner is gone.
        if (snapshot.resourceClose !== null) {
          throw new ContractError(
            'interaction parent resource close is committed; a new request lifecycle record is rejected',
          );
        }
        assertActiveOwner(snapshot);
        if (ignoredRequests(snapshot).includes(record.request.requestId)) {
          throw new ContractError('interaction parent abandoned request cannot be resumed');
        }
        if (byId === undefined && record.phase !== 'dispatching') {
          throw new ContractError('a new interaction parent request must register as dispatching');
        }
        if (record.parentRequestId !== undefined
          && !snapshot.requests.some((committed) => committed.fact.request.requestId === record.parentRequestId)) {
          throw new ContractError(`interaction parent continuation parent ${record.parentRequestId} is not registered`);
        }
        return { append: { kind: 'request', turn, execution, record }, result: { kind: 'new' } };
      });
      return result.kind === 'existing' ? result.record : record;
    },

    async acceptRawFact(
      envelope: RawFactEnvelope<InteractionParentProviderExecutionIdentityRef>,
    ): Promise<AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>> {
      validateRawFactEnvelope(envelope);
      assertOwnerExecution(envelope.execution);
      assertSameScope(envelope.scope, scope);
      if (envelope.fact.kind === 'tool-result') {
        const candidate = envelope.fact.result as { readonly interactionTurn?: InteractionTurnIdentity };
        if (candidate.interactionTurn === undefined) {
          throw new ContractError('interaction parent tool result must carry the neutral interaction parent identity');
        }
        if (!sameTurnIdentity(candidate.interactionTurn, turn)) {
          throw new ContractError('interaction parent tool result interaction turn does not match the owner turn');
        }
      }
      const { committed, result } = await journal.transactTurn<
        | {
            readonly kind: 'existing';
            readonly entry: AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>;
          }
        | { readonly kind: 'new'; readonly entry: AcceptedRawFact<InteractionParentProviderExecutionIdentityRef> }
      >(turn, (snapshot) => {
        assertRegisteredRequest(snapshot, envelope.request);
        const duplicate = snapshot.acceptedFacts.find((committed) =>
          sameRequestIdentity(committed.fact.envelope.request, envelope.request)
          && committed.fact.envelope.producerSeq === envelope.producerSeq);
        if (duplicate !== undefined) {
          if (canonicalJsonStringify(duplicate.fact.envelope) !== canonicalJsonStringify(envelope)) {
            throw new ContractError(
              `interaction parent raw fact ${envelope.request.requestId}@${envelope.producerSeq} conflicts with a different payload`,
            );
          }
          return { result: { kind: 'existing', entry: duplicate.fact } };
        }
        // After a durable resource close the raw history is frozen: only the
        // exact replay above is allowed, never a new producer sequence.
        if (snapshot.resourceClose !== null) {
          throw new ContractError(
            'interaction parent resource close is committed; a new raw fact is rejected',
          );
        }
        assertActiveOwner(snapshot);
        if (ignoredRequests(snapshot).includes(envelope.request.requestId)) {
          throw new ContractError('interaction parent abandoned request cannot accept new facts');
        }
        const entry: AcceptedRawFact<InteractionParentProviderExecutionIdentityRef> = {
          seq: snapshot.acceptedFacts.length + 1,
          envelope,
        };
        validateAcceptedRawFact(entry);
        return { append: { kind: 'accepted-fact', turn, execution, entry }, result: { kind: 'new', entry } };
      });
      if (result.kind === 'existing') return result.entry;
      if (committed === undefined) {
        throw new ContractError('interaction parent raw fact append did not commit');
      }
      return result.entry;
    },

    async readFinalTurnOutput(): Promise<InteractionParentFinalTurnOutput> {
      return finalOutputFromSnapshot(await journal.readTurnSnapshot(turn));
    },

    reconcileTurnOwner: (input: {
      readonly previousOwner: OccurrenceExecutionOwner;
      readonly replacementOwner: OccurrenceExecutionOwner;
      readonly isCommittedReplacement: boolean;
      readonly reconciledAt: string;
    }): Promise<InteractionParentCommittedFact<InteractionParentOwnerReconciliationFact>> => commitReconciliation(
      input.previousOwner, input.replacementOwner, input.isCommittedReplacement, input.reconciledAt,
    ),

    async readReconciledTurnOutput(): Promise<
      InteractionParentFinalTurnOutput & {
        readonly reconciliation: InteractionParentCommittedFact<InteractionParentOwnerReconciliationFact>;
        readonly resourceClose: InteractionParentCommittedFact<InteractionParentResourceCloseFact> | null;
      }
    > {
      const snapshot = await journal.readTurnSnapshot(turn);
      const reconciliation = snapshot.ownerReconciliations.at(-1);
      if (reconciliation === undefined) {
        throw new ContractError('interaction parent reconciled output requires a committed owner reconciliation');
      }
      const ignoredRequestIds = ignoredRequests(snapshot);
      if (reconciliation.fact.mode === 'continue') {
        const resourceClose = snapshot.resourceClose;
        if (resourceClose === null) {
          throw new ContractError(
            'interaction parent continued reconciliation requires the effective epoch provider close',
          );
        }
        if (resourceClose.fact.execution.executionEpoch !== reconciliation.fact.effectiveExecutionEpoch) {
          throw new ContractError('interaction parent reconciled output requires the effective epoch provider close');
        }
        const output = await finalOutputFromSnapshot(snapshot, ignoredRequestIds);
        return { ...output, reconciliation, resourceClose };
      }
      const output = await finalOutputFromSnapshot(snapshot, ignoredRequestIds);
      return { ...output, reconciliation, resourceClose: null };
    },

    async readContinuationParentRequest(): Promise<ProviderRequestIdentityRef | undefined> {
      const snapshot = await journal.readTurnSnapshot(turn);
      if (snapshot.turnInput === null) {
        throw new ContractError('interaction parent continuation requires the committed turn input');
      }
      if (snapshot.resourceClose !== null) {
        throw new ContractError(
          'interaction parent resource close is committed; continuation parent is closed',
        );
      }
      const reconciliation = snapshot.ownerReconciliations.at(-1);
      if (reconciliation === undefined || reconciliation.fact.mode !== 'continue') {
        throw new ContractError(
          'interaction parent continuation parent requires a committed continue reconciliation',
        );
      }
      assertActiveOwner(snapshot);
      const requests = nonIgnoredRequestRecords(snapshot, new Set(ignoredRequests(snapshot)));
      const unsettled = requests.filter((record) =>
        (UNSETTLED_PHASES as readonly string[]).includes(record.phase)
        || !hasCommittedRequestCompletion(snapshot, record));
      if (unsettled.length > 0) {
        throw new ContractError(
          'interaction parent continuation requires every non-ignored request to be settled',
        );
      }
      if (requests.length === 0) return undefined;
      const parentRequestIds = new Set(
        requests
          .map((record) => record.request.parentRequestId)
          .filter((parentRequestId): parentRequestId is string => parentRequestId !== undefined),
      );
      const leaves = requests.filter((record) =>
        record.phase === 'settled' && !parentRequestIds.has(record.request.requestId));
      if (leaves.length !== 1) {
        throw new ContractError(
          `interaction parent continuation requires at most one settled terminal request, found ${leaves.length}`,
        );
      }
      const leaf = leaves[0]!.request;
      return {
        turnId: leaf.turnId,
        requestId: leaf.requestId,
        ...(leaf.parentRequestId === undefined ? {} : { parentRequestId: leaf.parentRequestId }),
      };
    },

    async recordProviderClose(input: {
      readonly providerBinding: ProviderBinding;
      readonly result: ProviderCloseResult;
      readonly closedAt: string;
    }): Promise<InteractionParentCommittedFact<InteractionParentResourceCloseFact>> {
      validateProviderBinding(input.providerBinding);
      validateProviderCloseResult(input.result);
      if (input.result.state !== 'closed') {
        throw new ContractError('interaction parent resource close requires an actual closed receipt');
      }
      if (input.closedAt.trim() === '') {
        throw new ContractError('interaction parent resource close requires a closedAt timestamp');
      }
      const { committed, result } = await journal.transactTurn<
        | {
            readonly kind: 'existing';
            readonly committed: InteractionParentCommittedFact<InteractionParentResourceCloseFact>;
          }
        | { readonly kind: 'new'; readonly fact: InteractionParentResourceCloseFact }
      >(turn, (snapshot) => {
        if (snapshot.turnInput === null) {
          throw new ContractError('interaction parent resource close requires the committed turn input');
        }
        const committedBinding = snapshot.turnInput.fact.providerBinding;
        if (committedBinding === undefined) {
          throw new ContractError(
            'interaction parent resource close requires the original committed provider binding',
          );
        }
        // The close must belong to the original turn and execution, and it must
        // match the full committed binding, never just the binding id.
        if (canonicalJsonStringify(snapshot.turnInput.fact.turn) !== canonicalJsonStringify(turn)
          || canonicalJsonStringify(activeExecutionState(snapshot).execution) !== canonicalJsonStringify(execution)) {
          throw new ContractError('interaction parent resource close requires the original parent execution');
        }
        assertActiveOwner(snapshot);
        if (!sameProviderBinding(committedBinding, input.providerBinding)) {
          throw new ContractError(
            'interaction parent resource close binding does not match the committed turn input binding',
          );
        }
        if (input.result.bindingId !== committedBinding.bindingId
          || input.result.providerId !== committedBinding.providerId
          || input.result.protocol !== committedBinding.protocol) {
          throw new ContractError('interaction parent resource close receipt does not match the original binding');
        }
        const fact: InteractionParentResourceCloseFact = {
          turn: cloneTurnIdentity(turn),
          execution: cloneExecution(execution),
          providerBinding: cloneProviderBinding(committedBinding),
          result: input.result,
          closedAt: input.closedAt,
        };
        if (snapshot.resourceClose !== null) {
          if (canonicalJsonStringify(resourceCloseCore(snapshot.resourceClose.fact))
            !== canonicalJsonStringify(resourceCloseCore(fact))) {
            throw new ContractError(
              'interaction parent resource close conflicts with the committed resource close',
            );
          }
          return { result: { kind: 'existing', committed: snapshot.resourceClose } };
        }
        return { append: { kind: 'resource-close', turn, execution, fact }, result: { kind: 'new', fact } };
      });
      if (result.kind === 'existing') return result.committed;
      if (committed === undefined) {
        throw new ContractError('interaction parent resource close append did not commit');
      }
      return { fact: result.fact, commit: committed };
    },

    async readResourceClose(): Promise<InteractionParentCommittedFact<InteractionParentResourceCloseFact> | null> {
      const snapshot = await journal.readTurnSnapshot(turn);
      return snapshot.resourceClose;
    },

    async readClosedTurnOutput(): Promise<
      InteractionParentFinalTurnOutput & {
        readonly resourceClose: InteractionParentCommittedFact<InteractionParentResourceCloseFact>;
      }
    > {
      const snapshot = await journal.readTurnSnapshot(turn);
      const resourceClose = snapshot.resourceClose;
      if (resourceClose === null) {
        throw new ContractError('interaction parent closed turn output requires the committed resource close');
      }
      const output = await finalOutputFromSnapshot(snapshot);
      return { ...output, resourceClose };
    },

    requestContext: async (hookInput) => {
      assertOwnerExecution(hookInput.execution);
      const snapshot = await journal.readTurnSnapshot(turn);
      if (snapshot.turnInput === null) {
        throw new ContractError('interaction parent request context requires the committed turn input');
      }
      assertRegisteredRequest(snapshot, hookInput.request);
      assertActiveOwner(snapshot);
      const folded = await foldSnapshot(snapshot, hookInput.request.requestId, ignoredRequests(snapshot));
      const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const units: ProviderRequestContextUnit[] = [];
      // Historical semantic checkpoints enter as messages only. The prior raw
      // turn and the current turn never leak through this seam.
      for (const checkpoint of snapshot.turnInput.fact.priorCheckpoints) {
        units.push({
          kind: 'message',
          role: 'assistant',
          text: canonicalJsonStringify({
            kind: checkpoint.kind,
            interactionId: checkpoint.interactionId,
            inputRevision: checkpoint.inputRevision,
            turnId: checkpoint.turnId,
            committedAt: checkpoint.committedAt,
            claims: checkpoint.claims,
            constraints: checkpoint.constraints,
          }),
        });
      }
      units.push({ kind: 'message', role: 'user', text: folded.initialInputText });
      const ordered: { readonly seq: number; readonly unit: ProviderRequestContextUnit }[] = [];
      for (const unit of folded.contentUnits) {
        if (unit.channel !== 'assistant-text' || unit.supersededBy !== undefined) continue;
        ordered.push({ seq: unit.firstSeq, unit: { kind: 'message', role: 'assistant', text: decode(unit.bytes) } });
      }
      for (const entry of folded.entries) {
        if (entry.kind === 'tool-call') {
          const call = entry.accepted.envelope.fact.call;
          ordered.push({
            seq: entry.accepted.seq,
            unit: { kind: 'tool-call', callId: call.callId, toolId: call.toolId, arguments: call.arguments },
          });
        } else if (entry.kind === 'tool-result') {
          const result = entry.accepted.envelope.fact.result;
          ordered.push({
            seq: entry.accepted.seq,
            unit: {
              kind: 'tool-result',
              callId: entry.accepted.envelope.fact.callId,
              toolId: result.toolId,
              output: decode(entry.rawOutput),
              status: result.status,
              evidenceRefs: result.evidenceRefs,
            },
          });
        }
      }
      ordered.sort((left, right) => left.seq - right.seq);
      units.push(...ordered.map((item) => item.unit));
      const instructions = input.instructions === undefined ? undefined : await input.instructions(hookInput);
      const materialized: MaterializedRequestInput = {
        canonical: { units },
        ...(instructions === undefined ? {} : { instructions }),
      };
      return materialized;
    },

    async inspectTurnRequests(): Promise<InteractionParentUnsettledRequests> {
      const snapshot = await journal.readTurnSnapshot(turn);
      const latest = new Map<string, RuntimeRequestRecord>();
      for (const committed of snapshot.requests) {
        if (ignoredRequests(snapshot).includes(committed.fact.request.requestId)) continue;
        latest.set(committed.fact.request.requestId, committed.fact);
      }
      const requests = [...latest.values()];
      return {
        requests,
        unsettledRequests: requests.filter((record) =>
          (UNSETTLED_PHASES as readonly string[]).includes(record.phase)),
      };
    },

    async readReconciliationEligibility(): Promise<InteractionParentReconciliationEligibility> {
      return requestEligibility(await journal.readTurnSnapshot(turn));
    },

    async readAbandonmentEligibility(): Promise<InteractionParentTurnAbandonmentEligibility> {
      return abandonmentEligibility(await journal.readTurnSnapshot(turn));
    },

    abandonInterruptedTurn(input: {
      readonly reason: InteractionParentTurnAbandonmentFact['reason'];
      readonly abandonedAt: string;
    }): Promise<InteractionParentCommittedFact<InteractionParentTurnAbandonmentFact>> {
      return commitAbandonment(input);
    },

    async readParseFailureEligibility(): Promise<InteractionParentTurnParseFailureEligibility> {
      return parseFailureEligibility(await journal.readTurnSnapshot(turn));
    },

    closeUnparseableTurn(input: {
      readonly failedAt: string;
    }): Promise<InteractionParentCommittedFact<InteractionParentTurnParseFailureFact>> {
      return commitParseFailure(input);
    },
  };
}

function settlementExecutionMatches(
  execution: InteractionParentProviderExecutionIdentityRef,
  receipt: InteractionProviderSettlementReceipt,
): boolean {
  const settlement = receipt.settlement;
  return execution.runtimeId === settlement.runtimeId
    && sameScopedId(execution.organId, settlement.organId)
    && sameScopedId(execution.operationId, settlement.operationId)
    && execution.executionEpoch === settlement.executionEpoch
    && sameTurnIdentity(execution.interactionTurn, settlement.interactionTurn);
}

function sameProviderSettlementKey(
  committed: InteractionProviderSettlementReceipt,
  execution: InteractionParentProviderExecutionIdentityRef,
  request: ProviderRequestIdentityRef,
): boolean {
  return committed.settlement.executionEpoch === execution.executionEpoch
    && settlementExecutionMatches(execution, committed)
    && sameRequestIdentity(committed.request, request);
}

/**
 * Publish one complete Provider settlement as control evidence on the existing
 * interaction-parent Journal. The settlement remains the exact typed value
 * produced by the Provider owner; this function validates its association but
 * never rebuilds or trims it.
 */
export async function publishInteractionProviderSettlement(input: {
  readonly journal: InteractionParentTurnRawJournalPort;
  readonly receipt: InteractionProviderSettlementReceipt;
}): Promise<InteractionParentCommittedFact<InteractionProviderSettlementReceipt>> {
  validateInteractionProviderSettlementReceipt(input.receipt);
  const turn = input.receipt.settlement.interactionTurn;
  const { committed, result } = await input.journal.transactTurn<
    | {
        readonly kind: 'existing';
        readonly committed: InteractionParentCommittedFact<InteractionProviderSettlementReceipt>;
      }
    | {
        readonly kind: 'new';
        readonly fact: InteractionProviderSettlementReceipt;
      }
  >(turn, (snapshot) => {
    if (snapshot.turnInput === null) {
      throw new ContractError(
        'interaction parent provider settlement requires the committed turn input',
      );
    }
    if (!sameTurnIdentity(snapshot.turnInput.fact.turn, turn)) {
      throw new ContractError('interaction parent provider settlement turn does not match the committed turn');
    }
    const active = activeExecutionState(snapshot);
    if (!settlementExecutionMatches(active.execution, input.receipt)) {
      throw new ContractError(
        'interaction parent provider settlement requires the active physical execution epoch',
      );
    }
    const { terminalRequest } = completedTerminalRequest(
      snapshot,
      ignoredRequests(snapshot),
      'interaction parent provider settlement',
    );
    if (!sameRequestIdentity(terminalRequest.request, input.receipt.request)) {
      throw new ContractError(
        'interaction parent provider settlement request is not the current terminal request',
      );
    }
    const existing = snapshot.providerSettlements.find((entry) =>
      sameProviderSettlementKey(entry.fact, active.execution, terminalRequest.request));
    if (existing !== undefined) {
      if (canonicalJsonStringify(existing.fact) !== canonicalJsonStringify(input.receipt)) {
        throw new ContractError(
          'interaction parent provider settlement conflicts with the committed receipt',
        );
      }
      return { result: { kind: 'existing', committed: existing } };
    }
    return {
      append: {
        kind: 'provider-settlement',
        turn,
        execution: active.execution,
        fact: input.receipt,
      },
      result: { kind: 'new', fact: input.receipt },
    };
  });
  if (result.kind === 'existing') return result.committed;
  if (committed === undefined) {
    throw new ContractError('interaction parent provider settlement append did not commit');
  }
  return { fact: result.fact, commit: committed };
}

/**
 * Read the committed Provider settlement for the current physical epoch's
 * actual terminal request. The read is exact and read-only: an older epoch
 * receipt never substitutes for the current one.
 */
export async function readInteractionProviderSettlement(input: {
  readonly journal: InteractionParentTurnRawJournalPort;
  readonly turn: InteractionTurnIdentity;
}): Promise<InteractionParentCommittedFact<InteractionProviderSettlementReceipt>> {
  validateInteractionTurnIdentity(input.turn);
  const snapshot = await input.journal.readTurnSnapshot(input.turn);
  if (snapshot.turnInput === null) {
    throw new ContractError(
      'interaction parent provider settlement requires the committed turn input',
    );
  }
  const active = activeExecutionState(snapshot);
  const { terminalRequest } = completedTerminalRequest(
    snapshot,
    ignoredRequests(snapshot),
    'interaction parent provider settlement',
  );
  const matches = snapshot.providerSettlements.filter((entry) =>
    sameProviderSettlementKey(entry.fact, active.execution, terminalRequest.request));
  if (matches.length === 0) {
    throw new ContractError(
      'interaction parent provider settlement is missing for the current terminal request',
    );
  }
  if (matches.length !== 1) {
    throw new ContractError(
      'interaction parent provider settlement has more than one receipt for the current terminal request',
    );
  }
  const committed = matches[0]!;
  validateInteractionProviderSettlementReceipt(committed.fact);
  return committed;
}
