import type {
  AcceptedTurnEntry,
  ActiveTurnBinding,
  ChildInvocationRecord,
  RawAsset,
  RawContentReadPort,
  RuntimeRequestLifecyclePhase,
  RuntimeRequestRecord,
  ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  ActiveTurnSegmentBinding,
  ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import { RuntimeActiveTurnError } from './active-turn-context.js';
import { foldActiveTurn, type ResolvedActiveTurnCore } from './active-turn-materializer.js';

/**
 * A live read boundary over the committed active-turn projection.
 *
 * The prefix is not a capture. It carries no `pauseId`, `frozenAt` or
 * `producersDrained` field. It names the last committed accepted sequence and
 * the committed control record count that the read observed. A later append
 * never mutates a returned prefix.
 */
export interface ActiveTurnLivePrefixWatermark {
  readonly lastAcceptedSeq: number;
  readonly controlRecordCount: number;
}

/**
 * A typed reference to work the live prefix still owes. Each reference points
 * at an existing request or child-invocation record. There is no second
 * registry and no model outcome is inferred from a pending promise.
 */
export type ActiveTurnProductionObligationRef =
  | {
      readonly kind: 'request';
      readonly requestId: string;
      readonly phase: RuntimeRequestLifecyclePhase;
    }
  | {
      readonly kind: 'child-invocation';
      readonly invocationId: string;
      readonly phase: 'pending';
    };

/**
 * The live accepted-prefix shape. `source` is an opaque Runtime segment
 * identity. The initial segment uses the active turn's current turn reference;
 * D-S supplies a resumed-segment identity through the same field.
 */
export interface ActiveTurnLivePrefix {
  readonly kind: 'live-accepted-prefix';
  readonly source: string;
  readonly binding: ActiveTurnBinding;
  readonly initialInput?: RawAsset;
  readonly entries: readonly AcceptedTurnEntry[];
  readonly requests: readonly RuntimeRequestRecord[];
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly watermark: ActiveTurnLivePrefixWatermark;
  readonly obligations: readonly ActiveTurnProductionObligationRef[];
}

/** The live materialization result, distinguished by its live watermark cut. */
export interface ResolvedLiveAcceptedPrefix extends ResolvedActiveTurnCore {
  readonly kind: 'live-accepted-prefix';
  readonly cut: ActiveTurnLivePrefixWatermark;
}

/**
 * A live read over one resumed segment's committed projection. It is a distinct
 * type from the v1 `ActiveTurnLivePrefix` so existing initial-turn consumers are
 * not widened. The actual opened segment record carries the current binding and
 * incarnation, and the unique original input asset is referenced rather than
 * copied. The type deliberately has no `frozenAt`, `pauseId` or
 * `producersDrained` field.
 */
export interface ActiveTurnSegmentLivePrefix {
  readonly kind: 'segment-live-accepted-prefix';
  readonly segment: ResumedTurnSegmentOpened;
  readonly binding: ActiveTurnSegmentBinding;
  readonly initialInput: RawAsset;
  readonly entries: readonly AcceptedTurnEntry[];
  readonly requests: readonly RuntimeRequestRecord[];
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly watermark: ActiveTurnLivePrefixWatermark;
  readonly obligations: readonly ActiveTurnProductionObligationRef[];
}

/** The materialized resumed-segment prefix, distinguished by its live cut. */
export interface ResolvedActiveTurnSegmentLivePrefix extends ResolvedActiveTurnCore<ActiveTurnSegmentBinding> {
  readonly kind: 'segment-live-accepted-prefix';
  readonly segment: ResumedTurnSegmentOpened;
  readonly cut: ActiveTurnLivePrefixWatermark;
}

export function sameActiveTurnScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

/**
 * Resolves a live prefix through the shared active-turn folding. It reads the
 * exact raw assets the prefix references and keeps the prefix watermark as the
 * cut. It never closes admission, drains producers or fabricates a capture.
 */
export async function materializeLiveAcceptedPrefix(input: {
  readonly prefix: ActiveTurnLivePrefix;
  readonly rawContent: RawContentReadPort;
}): Promise<ResolvedLiveAcceptedPrefix> {
  const { prefix, rawContent } = input;
  if (!prefix.initialInput) {
    throw new RuntimeActiveTurnError(
      'active-turn.live-prefix.input-missing',
      'live prefix has no committed initial input',
    );
  }
  const core = await foldActiveTurn({
    binding: prefix.binding,
    initialInput: prefix.initialInput,
    entries: prefix.entries,
    requests: prefix.requests,
    childInvocations: prefix.childInvocations,
    cut: prefix.watermark,
    checkpointPath: [],
    completionRefs: [],
    rawContent,
  });
  return { kind: 'live-accepted-prefix', ...core };
}

/**
 * Resolves a resumed segment through the same shared folding, raw reader, tool
 * pairing and adoption selection as the v1 live prefix. The narrow fold input
 * carries the real segment execution identity and scope; it never constructs a
 * fake v1 capture or `AdmittedTurn`.
 */
export async function materializeActiveTurnSegmentLivePrefix(input: {
  readonly prefix: ActiveTurnSegmentLivePrefix;
  readonly rawContent: RawContentReadPort;
}): Promise<ResolvedActiveTurnSegmentLivePrefix> {
  const { prefix, rawContent } = input;
  const core = await foldActiveTurn<ActiveTurnLivePrefixWatermark, ActiveTurnSegmentBinding>({
    binding: prefix.binding,
    initialInput: prefix.initialInput,
    entries: prefix.entries,
    requests: prefix.requests,
    childInvocations: prefix.childInvocations,
    cut: prefix.watermark,
    checkpointPath: [],
    completionRefs: [],
    rawContent,
  });
  return {
    kind: 'segment-live-accepted-prefix',
    segment: structuredClone(prefix.segment),
    ...core,
  };
}
