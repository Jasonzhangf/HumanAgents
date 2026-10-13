import {
  validateActiveTurnCaptureBody,
  type AcceptedChildDelivery,
  type AcceptedRawFact,
  type ActiveTurnBinding,
  type ActiveTurnCaptureBody,
  type ActiveTurnProviderRequestIdentityRef,
  type ChildInvocationRecord,
  type CompletionRef,
  type ContentUnitChannel,
  type ProviderRawFact,
  type RawAsset,
  type RawContentReadPort,
  type RawFactEnvelope,
  type RuntimeRequestRecord,
  type ScopeRef,
  type TurnCaptureCut,
} from '../../../contracts/src/index.js';
import { RuntimeActiveTurnError } from './active-turn-context.js';

/**
 * Runtime-local materialization of one already-captured active turn. It reads
 * exactly the raw assets the supplied capture body references and folds them
 * into typed units. It makes no claim about producer drain: the documented
 * guarantee is "resolve the supplied captured body exactly, or fail
 * explicitly". A `producersDrained` boolean on the cut is not re-certified here.
 */

type ContentFact = Extract<ProviderRawFact, { kind: 'content' }>;
type ContentCompleteFact = Extract<ProviderRawFact, { kind: 'content-complete' }>;
type ToolCallFact = Extract<ProviderRawFact, { kind: 'tool-call' }>;
type ToolResultFact = Extract<ProviderRawFact, { kind: 'tool-result' }>;
type RequestCompleteFact = Extract<ProviderRawFact, { kind: 'request-complete' }>;

/** An accepted raw fact narrowed to one existing `ProviderRawFact` variant. */
type AcceptedFactOf<F extends ProviderRawFact> = AcceptedRawFact & {
  readonly envelope: RawFactEnvelope & { readonly fact: F };
};

export type ResolvedProviderFact =
  | {
      readonly kind: 'content';
      readonly accepted: AcceptedFactOf<ContentFact>;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'content-complete';
      readonly accepted: AcceptedFactOf<ContentCompleteFact>;
    }
  | {
      readonly kind: 'tool-call';
      readonly accepted: AcceptedFactOf<ToolCallFact>;
      readonly rawArguments: Uint8Array;
    }
  | {
      readonly kind: 'tool-result';
      readonly accepted: AcceptedFactOf<ToolResultFact>;
      readonly rawOutput: Uint8Array;
    }
  | {
      readonly kind: 'request-complete';
      readonly accepted: AcceptedFactOf<RequestCompleteFact>;
    };

export interface ResolvedAdoptedChildDelivery {
  readonly kind: 'adopted-child-delivery';
  readonly accepted: AcceptedChildDelivery;
  readonly invocation: ChildInvocationRecord;
  readonly bytes: Uint8Array;
}

export type ResolvedActiveTurnEntry =
  | ResolvedProviderFact
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

export interface ResolvedActiveTurn {
  readonly version: 1;
  readonly binding: ActiveTurnBinding;
  readonly cut: TurnCaptureCut;
  readonly initialInput: {
    readonly content: RawAsset;
    readonly bytes: Uint8Array;
  };
  readonly entries: readonly ResolvedActiveTurnEntry[];
  readonly contentUnits: readonly ResolvedContentUnit[];
  readonly requests: readonly RuntimeRequestRecord[];
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly checkpointPath: readonly string[];
  readonly completionRefs: readonly CompletionRef[];
}

function fail(code: string, message: string): never {
  throw new RuntimeActiveTurnError(code, message);
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
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

function acceptedAs<F extends ProviderRawFact>(entry: AcceptedRawFact): AcceptedFactOf<F> {
  return structuredClone(entry) as AcceptedFactOf<F>;
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
 * Resolves the supplied captured body against the injected raw reader. Every
 * referenced asset is read through the reader; the Runtime never parses wire
 * JSON, infers selectors or inspects UI summaries. A missing asset, a mismatched
 * execution/scope/request, an unpaired tool result, an ambiguous
 * content-complete, a cross-channel replacement or a superseded-unit rewrite
 * all fail explicitly instead of returning a partial result.
 */
export async function materializeActiveTurn(input: {
  readonly capture: ActiveTurnCaptureBody;
  readonly rawContent: RawContentReadPort;
}): Promise<ResolvedActiveTurn> {
  const { capture, rawContent } = input;
  validateActiveTurnCaptureBody(capture);

  const binding = capture.binding;
  const execution = binding.execution;

  const knownRequests = new Set(capture.requests.map((record) => requestKey(record.request)));
  const requestById = new Map<string, RuntimeRequestRecord>();
  for (const record of capture.requests) requestById.set(record.request.requestId, record);

  const invocationById = new Map<string, ChildInvocationRecord>();
  for (const invocation of capture.childInvocations) invocationById.set(invocation.invocationId, invocation);

  // Captured tool calls, keyed by request identity + callId + continuationRef, so
  // an identical call id in a different request cannot pair across requests.
  const capturedCalls = new Set<string>();
  for (const entry of capture.entries) {
    if (!('envelope' in entry)) continue;
    const fact = entry.envelope.fact;
    if (fact.kind === 'tool-call') {
      capturedCalls.add(callKey(entry.envelope.request, fact.call.callId, fact.call.continuationRef));
    }
  }

  const readBytes = async (scope: ScopeRef, content: RawAsset): Promise<Uint8Array> => {
    const bytes = await rawContent.read({ scope, content });
    if (!(bytes instanceof Uint8Array)) {
      fail('active-turn.materialize.read-invalid', 'raw content reader did not return bytes');
    }
    return new Uint8Array(bytes);
  };

  const entries: ResolvedActiveTurnEntry[] = [];
  const units: MutableUnit[] = [];
  const unitByKey = new Map<string, MutableUnit>();
  const unitsByRequestUnit = new Map<string, MutableUnit[]>();

  for (const entry of capture.entries) {
    if (!('envelope' in entry)) {
      const invocation = invocationById.get(entry.invocationId);
      if (!invocation) {
        fail('active-turn.materialize.invocation-unknown', `child delivery references unknown invocation ${entry.invocationId}`);
      }
      // Only a delivery the owner actually adopted enters the resolved turn.
      if (invocation.adoptedResultSeq !== entry.seq) continue;
      const bytes = await readBytes(entry.refinedDelivery.ref.scope, entry.refinedDelivery);
      entries.push({
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
    if (!sameScope(envelope.scope, binding.scope)) {
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
        entries.push({ kind: 'content', accepted: acceptedAs<ContentFact>(entry), bytes });
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
        entries.push({ kind: 'content-complete', accepted: acceptedAs<ContentCompleteFact>(entry) });
        break;
      }
      case 'tool-call': {
        const rawArguments = await readBytes(binding.scope, fact.rawArguments);
        entries.push({ kind: 'tool-call', accepted: acceptedAs<ToolCallFact>(entry), rawArguments });
        break;
      }
      case 'tool-result': {
        if (!capturedCalls.has(callKey(request, fact.callId, fact.continuationRef))) {
          fail('active-turn.materialize.tool-result-unpaired', `tool result ${fact.callId} has no captured call in its request`);
        }
        const rawOutput = await readBytes(binding.scope, fact.rawOutput);
        entries.push({ kind: 'tool-result', accepted: acceptedAs<ToolResultFact>(entry), rawOutput });
        break;
      }
      case 'request-complete': {
        entries.push({ kind: 'request-complete', accepted: acceptedAs<RequestCompleteFact>(entry) });
        break;
      }
      default:
        fail('active-turn.materialize.fact-unknown', 'raw fact kind is not recognized');
    }
  }

  const initialBytes = await readBytes(binding.scope, capture.initialInput);

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
    cut: structuredClone(capture.cut),
    initialInput: { content: structuredClone(capture.initialInput), bytes: initialBytes },
    entries,
    contentUnits,
    requests: capture.requests.map((record) => structuredClone(record)),
    childInvocations: capture.childInvocations.map((invocation) => structuredClone(invocation)),
    checkpointPath: [...capture.checkpointPath],
    completionRefs: capture.completionRefs.map((completion) => structuredClone(completion)),
  };
}
