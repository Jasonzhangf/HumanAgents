import {
  ContractError,
  assertProviderExecutionIdentity,
  assertSameScope,
  canonicalJsonStringify,
  validateAcceptedRawFact,
  validateInteractionSemanticCheckpoint,
  validateInteractionLatestTurn,
  validateInteractionTurnIdentity,
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
import { foldActiveTurn } from '../context/active-turn-materializer.js';

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

/** The consistent durable read of exactly one parent turn. */
export interface InteractionParentTurnSnapshot {
  readonly turnInput: InteractionParentCommittedFact<InteractionParentTurnInputFact> | null;
  readonly requests: readonly InteractionParentCommittedFact<RuntimeRequestRecord>[];
  readonly acceptedFacts: readonly InteractionParentCommittedFact<
    AcceptedRawFact<InteractionParentProviderExecutionIdentityRef>
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
}

export interface InteractionParentTurnRawOwnerInput {
  readonly turn: InteractionTurnIdentity;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly initialInput: RawAsset;
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

function isInteractionParentExecution(
  execution: { readonly interactionTurn?: InteractionTurnIdentity },
): execution is InteractionParentProviderExecutionIdentityRef {
  return execution.interactionTurn !== undefined;
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
   * The shared, snapshot-based final-output reader. Both `readFinalTurnOutput`
   * and `readClosedTurnOutput` use it, so a closed-output read never combines a
   * close and an output from two different moments.
   */
  async function finalOutputFromSnapshot(
    snapshot: InteractionParentTurnSnapshot,
  ): Promise<InteractionParentFinalTurnOutput> {
    if (snapshot.turnInput === null) {
      throw new ContractError('interaction parent final output requires the committed turn input');
    }
    const latest = new Map<string, RuntimeRequestRecord>();
    for (const committed of snapshot.requests) {
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
      sameRequestIdentity(committed.fact.envelope.request, terminalRequest.request)
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

    const folded = await foldActiveTurn<
      { readonly requestId: string },
      { readonly execution: InteractionParentProviderExecutionIdentityRef; readonly scope: ScopeRef },
      InteractionParentProviderExecutionIdentityRef
    >({
      binding: { execution, scope },
      initialInput: snapshot.turnInput.fact.initialInput,
      entries: snapshot.acceptedFacts.map((committed) => committed.fact),
      requests: snapshot.requests.map((committed) => committed.fact),
      childInvocations: [],
      cut: { requestId: terminalRequest.request.requestId },
      checkpointPath: [],
      completionRefs: [],
      rawContent,
    });

    const finalUnits = folded.contentUnits.filter((unit) =>
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
    for (const entry of folded.entries) {
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
      initialInputText: decodeUtf8(folded.initialInput.bytes),
      terminalRequest,
      requestCompleteCommit,
      assistantText,
      assistantContentRefs,
    };
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
          throw new ContractError('interaction parent turn input conflicts with the committed turn input');
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
          || canonicalJsonStringify(snapshot.turnInput.fact.execution) !== canonicalJsonStringify(execution)) {
          throw new ContractError('interaction parent resource close requires the original parent execution');
        }
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
      const folded = await foldActiveTurn<
        { readonly requestId: string },
        { readonly execution: InteractionParentProviderExecutionIdentityRef; readonly scope: ScopeRef },
        InteractionParentProviderExecutionIdentityRef
      >({
        binding: { execution, scope },
        initialInput: snapshot.turnInput.fact.initialInput,
        entries: snapshot.acceptedFacts.map((committed) => committed.fact),
        requests: snapshot.requests.map((committed) => committed.fact),
        childInvocations: [],
        cut: { requestId: hookInput.request.requestId },
        checkpointPath: [],
        completionRefs: [],
        rawContent,
      });
      const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const units: ProviderRequestContextUnit[] = [];
      // Historical semantic checkpoints enter as messages only. The prior raw
      // turn and the current turn never leak through this seam.
      for (const checkpoint of snapshot.turnInput.fact.priorCheckpoints) {
        units.push({
          kind: 'message',
          role: 'assistant',
          text: canonicalJsonStringify({ claims: checkpoint.claims, constraints: checkpoint.constraints }),
        });
      }
      units.push({ kind: 'message', role: 'user', text: decode(folded.initialInput.bytes) });
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
        latest.set(committed.fact.request.requestId, committed.fact);
      }
      const requests = [...latest.values()];
      return {
        requests,
        unsettledRequests: requests.filter((record) =>
          (UNSETTLED_PHASES as readonly string[]).includes(record.phase)),
      };
    },
  };
}
