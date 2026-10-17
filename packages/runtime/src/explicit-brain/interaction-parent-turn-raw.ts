import {
  ContractError,
  assertProviderExecutionIdentity,
  assertSameScope,
  canonicalJsonStringify,
  validateAcceptedRawFact,
  validateInteractionSemanticCheckpoint,
  validateInteractionLatestTurn,
  validateInteractionTurnIdentity,
  validateOccurrenceExecutionOwner,
  validateProviderBinding,
  validateProviderCloseResult,
  validateRawFactEnvelope,
  type AcceptedRawFact,
  type EvidenceRef,
  type InteractionParentProviderExecutionIdentityRef,
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
  readonly resourceClose: InteractionParentCommittedFact<InteractionParentResourceCloseFact> | null;
}

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
    resourceClose: snapshot.resourceClose?.commit ?? null,
  });
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
    const ignored = new Set(ignoredRequestIds);
    const latest = new Map<string, RuntimeRequestRecord>();
    for (const committed of snapshot.requests) {
      if (ignored.has(committed.fact.request.requestId)) continue;
      latest.set(committed.fact.request.requestId, committed.fact);
    }
    const requests = [...latest.values()];
    if (requests.length === 0) {
      throw new ContractError('interaction parent final output requires at least one registered request');
    }
    const unsettled = requests.filter((record) =>
      (UNSETTLED_PHASES as readonly string[]).includes(record.phase));
    if (unsettled.length > 0) {
      throw new ContractError(
        'interaction parent final output requires every request to leave dispatching, dispatched and waiting',
      );
    }
    // The terminal request is the settled request that no other registered
    // request continues. A settled parent that still has a live continuation
    // is not final, and two independent settled leaves are ambiguous.
    const parentRequestIds = new Set(
      requests
        .map((record) => record.request.parentRequestId)
        .filter((parentRequestId): parentRequestId is string => parentRequestId !== undefined),
    );
    const terminals = requests.filter((record) =>
      record.phase === 'settled' && !parentRequestIds.has(record.request.requestId));
    if (terminals.length !== 1) {
      throw new ContractError(
        `interaction parent final output requires exactly one settled terminal request, found ${terminals.length}`,
      );
    }
    const terminalRequest = terminals[0]!;
    const completions = snapshot.acceptedFacts.filter((committed) =>
      !ignored.has(committed.fact.envelope.request.requestId)
      && sameRequestIdentity(committed.fact.envelope.request, terminalRequest.request)
      && committed.fact.envelope.fact.kind === 'request-complete');
    if (completions.length !== 1) {
      throw new ContractError(
        `interaction parent final output requires exactly one request-complete fact for ${terminalRequest.request.requestId}`,
      );
    }
    const completion = completions[0]!;
    if (completion.fact.envelope.fact.kind !== 'request-complete'
      || completion.fact.envelope.fact.terminal !== 'completed') {
      throw new ContractError('interaction parent final output requires a completed terminal request');
    }
    const requestCompleteCommit = completion.commit;

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
  };
}
