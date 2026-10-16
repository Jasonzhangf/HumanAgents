import {
  validateActiveTurnCaptureBody,
  validateAcceptedChildDelivery,
  validateAcceptedRawFact,
  type AcceptedChildDelivery,
  type AcceptedRawFact,
  type AcceptedTurnEntry,
  type ActiveTurnBinding,
  type ActiveTurnCaptureBody,
  type ActiveTurnProviderExecutionIdentityRef,
  type ActiveTurnProviderRequestIdentityRef,
  type AnyProviderExecutionIdentityRef,
  type ChildInvocationRecord,
  type CompletionRef,
  type ContentUnitChannel,
  type ProviderExecutionIdentityRef,
  type ProviderRawFact,
  type RawAsset,
  type RawContentReadPort,
  type RawFactEnvelope,
  type RuntimeRequestRecord,
  type ScopeRef,
  type TurnCaptureCut,
} from '../../../contracts/src/index.js';
import { RuntimeActiveTurnError } from './active-turn-context.js';
import { sameActiveTurnScope } from './active-turn-live-prefix.js';

/**
 * Runtime-local materialization of one already-captured active turn. It reads
 * exactly the raw assets the supplied capture body references and folds them
 * into typed units. It makes no claim about producer drain: the documented
 * guarantee is "resolve the supplied captured body exactly, or fail
 * explicitly". A `producersDrained` boolean on the cut is not re-certified here.
 */

type ContentFactOf<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef> = Extract<
  ProviderRawFact<TIdentity>,
  { kind: 'content' }
>;
type ContentCompleteFactOf<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef> = Extract<
  ProviderRawFact<TIdentity>,
  { kind: 'content-complete' }
>;
type ToolCallFactOf<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef> = Extract<
  ProviderRawFact<TIdentity>,
  { kind: 'tool-call' }
>;
type ToolResultFactOf<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef> = Extract<
  ProviderRawFact<TIdentity>,
  { kind: 'tool-result' }
>;
type RequestCompleteFactOf<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef> = Extract<
  ProviderRawFact<TIdentity>,
  { kind: 'request-complete' }
>;

/**
 * An accepted raw fact narrowed to one existing `ProviderRawFact` variant. The
 * execution identity stays generic so the same fold serves a Task turn, a
 * taskless helper call and a neutral interaction-parent turn; the default is
 * the Task-bound identity, so no existing consumer changes shape.
 */
type AcceptedFactOf<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
  F extends ProviderRawFact<TIdentity> = ProviderRawFact<TIdentity>,
> = AcceptedRawFact<TIdentity> & {
  readonly envelope: RawFactEnvelope<TIdentity> & { readonly fact: F };
};

export type ResolvedProviderFact<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> =
  | {
      readonly kind: 'content';
      readonly accepted: AcceptedFactOf<TIdentity, ContentFactOf<TIdentity>>;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'content-complete';
      readonly accepted: AcceptedFactOf<TIdentity, ContentCompleteFactOf<TIdentity>>;
    }
  | {
      readonly kind: 'tool-call';
      readonly accepted: AcceptedFactOf<TIdentity, ToolCallFactOf<TIdentity>>;
      readonly rawArguments: Uint8Array;
    }
  | {
      readonly kind: 'tool-result';
      readonly accepted: AcceptedFactOf<TIdentity, ToolResultFactOf<TIdentity>>;
      readonly rawOutput: Uint8Array;
    }
  | {
      readonly kind: 'request-complete';
      readonly accepted: AcceptedFactOf<TIdentity, RequestCompleteFactOf<TIdentity>>;
    };

export interface ResolvedAdoptedChildDelivery {
  readonly kind: 'adopted-child-delivery';
  readonly accepted: AcceptedChildDelivery;
  readonly invocation: ChildInvocationRecord;
  readonly bytes: Uint8Array;
}

export type ResolvedActiveTurnEntry<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> =
  | ResolvedProviderFact<TIdentity>
  | ResolvedAdoptedChildDelivery;

export interface ResolvedContentUnit {
  readonly request: ActiveTurnProviderRequestIdentityRef;
  readonly contentUnitId: string;
  readonly channel: ContentUnitChannel;
  readonly bytes: Uint8Array;
  readonly complete: boolean;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly sourceSeqs: readonly number[];
  readonly supersededBy?: {
    readonly contentUnitId: string;
    readonly seq: number;
  };
}

/**
 * Narrow binding facts shared by a v1 active turn and a v2 resumed segment.
 * The folding path only needs the real execution identity and scope; it must
 * never fabricate a v1 `AdmittedTurn` just to reuse the shared fold.
 */
export interface ActiveTurnFoldBinding {
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
}

export interface ResolvedActiveTurnCore<
  Binding extends ActiveTurnFoldBinding = ActiveTurnBinding,
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly version: 1;
  readonly binding: Binding;
  readonly initialInput: {
    readonly content: RawAsset;
    readonly bytes: Uint8Array;
  };
  readonly entries: readonly ResolvedActiveTurnEntry<TIdentity>[];
  readonly contentUnits: readonly ResolvedContentUnit[];
  readonly requests: readonly RuntimeRequestRecord[];
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly checkpointPath: readonly string[];
  readonly completionRefs: readonly CompletionRef[];
}

export interface ResolvedActiveTurn extends ResolvedActiveTurnCore<ActiveTurnBinding> {
  readonly cut: TurnCaptureCut;
}

/**
 * Shared live/capture input. Both entries are already durable accepted records;
 * the caller owns the cut and validates its own boundary before calling.
 */
export interface ActiveTurnFoldInput<
  Cut,
  Binding extends ActiveTurnFoldBinding = ActiveTurnBinding,
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly binding: Binding;
  readonly initialInput: RawAsset;
  readonly entries: readonly AcceptedTurnEntry<TIdentity>[];
  readonly requests: readonly RuntimeRequestRecord[];
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly cut: Cut;
  readonly checkpointPath: readonly string[];
  readonly completionRefs: readonly CompletionRef[];
  readonly rawContent: RawContentReadPort;
}

/**
 * The common result fields of a live prefix and a drained capture. Both
 * materializers share this shape and differ only by their cut.
 */
export type ResolvedActiveTurnFold<
  Cut,
  Binding extends ActiveTurnFoldBinding = ActiveTurnBinding,
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> = ResolvedActiveTurnCore<Binding, TIdentity> & {
  readonly cut: Cut;
};


function fail(code: string, message: string): never {
  throw new RuntimeActiveTurnError(code, message);
}

function requestKey(request: ActiveTurnProviderRequestIdentityRef): string {
  return JSON.stringify([request.turnId, request.requestId, request.parentRequestId ?? null]);
}

function unitKey(
  request: ActiveTurnProviderRequestIdentityRef,
  channel: ContentUnitChannel,
  contentUnitId: string,
): string {
  return JSON.stringify([request.turnId, request.requestId, request.parentRequestId ?? null, channel, contentUnitId]);
}

function requestUnitKey(request: ActiveTurnProviderRequestIdentityRef, contentUnitId: string): string {
  return JSON.stringify([request.turnId, request.requestId, request.parentRequestId ?? null, contentUnitId]);
}

function callKey(
  request: ActiveTurnProviderRequestIdentityRef,
  callId: string,
  continuationRef: string,
): string {
  return JSON.stringify([request.turnId, request.requestId, request.parentRequestId ?? null, callId, continuationRef]);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function acceptedAs<
  TIdentity extends AnyProviderExecutionIdentityRef,
  F extends ProviderRawFact<TIdentity>,
>(entry: AcceptedRawFact<TIdentity>): AcceptedFactOf<TIdentity, F> {
  return structuredClone(entry) as AcceptedFactOf<TIdentity, F>;
}

interface MutableUnit {
  request: ActiveTurnProviderRequestIdentityRef;
  contentUnitId: string;
  channel: ContentUnitChannel;
  bytes: Uint8Array;
  complete: boolean;
  firstSeq: number;
  lastSeq: number;
  sourceSeqs: number[];
  supersededBy?: { contentUnitId: string; seq: number };
}

/**
 * Resolves the supplied captured body against the injected raw reader. The
 * drained cut is the boundary; the body is validated at its original owner
 * before folding.
 */
export async function materializeActiveTurn(input: {
  readonly capture: ActiveTurnCaptureBody;
  readonly rawContent: RawContentReadPort;
}): Promise<ResolvedActiveTurn> {
  const { capture, rawContent } = input;
  validateActiveTurnCaptureBody(capture);
  return foldActiveTurn({
    binding: capture.binding,
    initialInput: capture.initialInput,
    entries: capture.entries,
    requests: capture.requests,
    childInvocations: capture.childInvocations,
    cut: capture.cut,
    checkpointPath: capture.checkpointPath,
    completionRefs: capture.completionRefs,
    rawContent,
  });
}

/**
 * Shared pure folding for a live prefix and a drained capture. Every referenced
 * asset is read through the reader; the Runtime never parses wire JSON, infers
 * selectors or inspects UI summaries. A missing asset, a mismatched
 * execution/scope/request, an unpaired tool result, an ambiguous
 * content-complete, a cross-channel replacement or a superseded-unit rewrite
 * all fail explicitly instead of returning a partial result.
 *
 * The caller owns validation of its own boundary (a drained v1 body or a live
 * committed prefix) and the cut it supplies. This function makes no drain claim.
 */
export async function foldActiveTurn<
  Cut,
  Binding extends ActiveTurnFoldBinding = ActiveTurnBinding,
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(
  input: ActiveTurnFoldInput<Cut, Binding, TIdentity>,
): Promise<ResolvedActiveTurnFold<Cut, Binding, TIdentity>> {
  const {
    binding,
    initialInput,
    entries: acceptedEntries,
    requests,
    childInvocations,
    cut,
    checkpointPath,
    completionRefs,
    rawContent,
  } = input;
  const execution = binding.execution;

  // A live prefix may come from a persisted read seam, so re-check each accepted
  // record before folding. A capture body is already validated at its owner; the
  // re-check is idempotent for it.
  for (const entry of acceptedEntries) {
    if ('envelope' in entry) validateAcceptedRawFact(entry);
    else validateAcceptedChildDelivery(entry);
  }

  const knownRequests = new Set(requests.map((record) => requestKey(record.request)));
  const requestById = new Map<string, RuntimeRequestRecord>();
  for (const record of requests) requestById.set(record.request.requestId, record);

  const invocationById = new Map<string, ChildInvocationRecord>();
  for (const invocation of childInvocations) invocationById.set(invocation.invocationId, invocation);

  // Captured tool calls, keyed by request identity + callId + continuationRef, so
  // an identical call id in a different request cannot pair across requests.
  const capturedCalls = new Set<string>();
  for (const entry of acceptedEntries) {
    if (!('envelope' in entry)) continue;
    const fact = entry.envelope.fact;
    if (fact.kind === 'tool-call') {
      capturedCalls.add(callKey(entry.envelope.request, fact.call.callId, fact.call.continuationRef));
    }
  }

  const readBytes = async (assetScope: ScopeRef, content: RawAsset): Promise<Uint8Array> => {
    const bytes = await rawContent.read({ scope: assetScope, content });
    if (!(bytes instanceof Uint8Array)) {
      fail('active-turn.materialize.read-invalid', 'raw content reader did not return bytes');
    }
    return new Uint8Array(bytes);
  };

  const resolvedEntries: ResolvedActiveTurnEntry<TIdentity>[] = [];
  const units: MutableUnit[] = [];
  const unitByKey = new Map<string, MutableUnit>();
  const unitsByRequestUnit = new Map<string, MutableUnit[]>();

  for (const entry of acceptedEntries) {
    if (!('envelope' in entry)) {
      const invocation = invocationById.get(entry.invocationId);
      if (!invocation) {
        fail('active-turn.materialize.invocation-unknown', `child delivery references unknown invocation ${entry.invocationId}`);
      }
      // Only a delivery the owner actually adopted enters the resolved turn.
      if (invocation.adoptedResultSeq !== entry.seq) continue;
      const bytes = await readBytes(entry.refinedDelivery.ref.scope, entry.refinedDelivery);
      resolvedEntries.push({
        kind: 'adopted-child-delivery',
        accepted: structuredClone(entry),
        invocation: structuredClone(invocation),
        bytes,
      });
      continue;
    }

    const envelope = entry.envelope;
    const request = envelope.request;
    const fact = envelope.fact;
    if (envelope.execution.runtimeId !== execution.runtimeId
      || envelope.execution.executionEpoch !== execution.executionEpoch) {
      fail('active-turn.materialize.execution-mismatch', 'raw fact execution does not match the captured binding');
    }
    if (!sameActiveTurnScope(envelope.scope, binding.scope)) {
      fail('active-turn.materialize.scope-mismatch', 'raw fact scope does not match the captured binding');
    }
    if (!knownRequests.has(requestKey(request))) {
      fail('active-turn.materialize.request-unknown', `raw fact references unregistered request ${request.requestId}`);
    }
    if (request.parentRequestId !== undefined) {
      const parent = requestById.get(request.parentRequestId);
      if (!parent || parent.request.turnId !== request.turnId) {
        fail('active-turn.materialize.request-chain', `continuation parent ${request.parentRequestId} is outside the captured request chain`);
      }
    }

    switch (fact.kind) {
      case 'content': {
        const key = unitKey(request, fact.channel, fact.contentUnitId);
        let unit = unitByKey.get(key);
        if (unit?.supersededBy) {
          fail('active-turn.materialize.content-conflict', `content unit ${fact.contentUnitId} was superseded and cannot receive more content`);
        }
        const bytes = await readBytes(binding.scope, fact.content);
        if (!unit) {
          unit = {
            request,
            contentUnitId: fact.contentUnitId,
            channel: fact.channel,
            bytes: new Uint8Array(0),
            complete: false,
            firstSeq: entry.seq,
            lastSeq: entry.seq,
            sourceSeqs: [],
          };
          unitByKey.set(key, unit);
          units.push(unit);
          const listKey = requestUnitKey(request, fact.contentUnitId);
          const list = unitsByRequestUnit.get(listKey);
          if (list) list.push(unit);
          else unitsByRequestUnit.set(listKey, [unit]);
        }
        // A delta appends; a full replaces the snapshot and never appends.
        unit.bytes = fact.update === 'delta' ? concat(unit.bytes, bytes) : bytes;
        unit.lastSeq = entry.seq;
        unit.sourceSeqs.push(entry.seq);
        if (fact.complete) unit.complete = true;
        if (fact.replacesUnitIds) {
          for (const targetId of fact.replacesUnitIds) {
            const targets = unitsByRequestUnit.get(requestUnitKey(request, targetId)) ?? [];
            for (const target of targets) {
              if (target.channel !== fact.channel) {
                fail('active-turn.materialize.replacement-channel', `replacement ${fact.contentUnitId} targets unit ${targetId} in a different channel`);
              }
              if (target === unit) continue;
              target.supersededBy = { contentUnitId: fact.contentUnitId, seq: entry.seq };
            }
          }
        }
        resolvedEntries.push({ kind: 'content', accepted: acceptedAs<TIdentity, ContentFactOf<TIdentity>>(entry), bytes });
        break;
      }
      case 'content-complete': {
        const targets = unitsByRequestUnit.get(requestUnitKey(request, fact.contentUnitId)) ?? [];
        if (targets.length === 0) {
          fail('active-turn.materialize.content-complete-unknown', `content-complete references unknown unit ${fact.contentUnitId}`);
        }
        if (targets.length > 1) {
          fail('active-turn.materialize.content-complete-ambiguous', `content-complete for ${fact.contentUnitId} matches multiple channels`);
        }
        const unit = targets[0]!;
        if (unit.supersededBy) {
          fail('active-turn.materialize.content-conflict', `content unit ${fact.contentUnitId} was superseded and cannot be completed`);
        }
        unit.complete = true;
        unit.lastSeq = entry.seq;
        unit.sourceSeqs.push(entry.seq);
        resolvedEntries.push({ kind: 'content-complete', accepted: acceptedAs<TIdentity, ContentCompleteFactOf<TIdentity>>(entry) });
        break;
      }
      case 'tool-call': {
        const rawArguments = await readBytes(binding.scope, fact.rawArguments);
        resolvedEntries.push({ kind: 'tool-call', accepted: acceptedAs<TIdentity, ToolCallFactOf<TIdentity>>(entry), rawArguments });
        break;
      }
      case 'tool-result': {
        if (!capturedCalls.has(callKey(request, fact.callId, fact.continuationRef))) {
          fail('active-turn.materialize.tool-result-unpaired', `tool result ${fact.callId} has no captured call in its request`);
        }
        const rawOutput = await readBytes(binding.scope, fact.rawOutput);
        resolvedEntries.push({ kind: 'tool-result', accepted: acceptedAs<TIdentity, ToolResultFactOf<TIdentity>>(entry), rawOutput });
        break;
      }
      case 'request-complete': {
        resolvedEntries.push({ kind: 'request-complete', accepted: acceptedAs<TIdentity, RequestCompleteFactOf<TIdentity>>(entry) });
        break;
      }
      default:
        fail('active-turn.materialize.fact-unknown', 'raw fact kind is not recognized');
    }
  }

  const initialBytes = await readBytes(binding.scope, initialInput);

  const contentUnits: ResolvedContentUnit[] = units.map((unit) => ({
    request: structuredClone(unit.request),
    contentUnitId: unit.contentUnitId,
    channel: unit.channel,
    bytes: new Uint8Array(unit.bytes),
    complete: unit.complete,
    firstSeq: unit.firstSeq,
    lastSeq: unit.lastSeq,
    sourceSeqs: [...unit.sourceSeqs],
    ...(unit.supersededBy === undefined ? {} : { supersededBy: { ...unit.supersededBy } }),
  }));

  return {
    version: 1,
    binding: structuredClone(binding),
    cut: structuredClone(cut),
    initialInput: { content: structuredClone(initialInput), bytes: initialBytes },
    entries: resolvedEntries,
    contentUnits,
    requests: requests.map((record) => structuredClone(record)),
    childInvocations: childInvocations.map((invocation) => structuredClone(invocation)),
    checkpointPath: [...checkpointPath],
    completionRefs: completionRefs.map((completion) => structuredClone(completion)),
  };
}
