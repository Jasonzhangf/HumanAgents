import type {
  AcceptedChildDelivery,
  AcceptedRawFact,
  ActiveTurnBinding,
  ChildInvocationRecord,
  CompletionReadback,
  CompletionReadInput,
  RawAsset,
  RuntimeRequestRecord,
} from '../../../contracts/src/index.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type {
  ActiveTurnInitialOpenAnchor,
  ActiveTurnInitialSegmentCapture,
  ActiveTurnSegmentInterruptedAnchor,
  ActiveTurnSegmentPredecessorRef,
  ActiveTurnSegmentRecoveryReceiptRead,
  PreparedActiveTurnSegmentCaptureV2,
  ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import type {
  ActiveTurnSegmentAppendPort,
  ActiveTurnSegmentReadPort,
} from './active-turn-segments.js';
import type { ActiveTurnLivePrefix, ActiveTurnSegmentLivePrefix } from './active-turn-live-prefix.js';

/**
 * Narrow durable boundary for the Runtime-owned active turn. The logical owner
 * of these facts is the Runtime; the physical commit/replay owner is the
 * injected journal adapter (the App assembles it). Records carry typed control
 * facts only. They never mirror a business payload, summary, metadata or log.
 *
 * Every record is idempotent by `commitId`: re-committing the same identity
 * with identical content returns the stored receipt; the same identity with
 * different content is a conflict.
 */
export type ActiveTurnJournalRecord =
  | { readonly kind: 'binding-opened'; readonly binding: ActiveTurnBinding; readonly currentTurnRef: string }
  | { readonly kind: 'initial-input'; readonly content: import('../../../contracts/src/index.js').RawAsset }
  | { readonly kind: 'request'; readonly record: RuntimeRequestRecord }
  | { readonly kind: 'accepted-fact'; readonly entry: AcceptedRawFact }
  | { readonly kind: 'child-invocation'; readonly record: ChildInvocationRecord }
  | { readonly kind: 'child-delivery'; readonly entry: AcceptedChildDelivery };

export interface ActiveTurnJournalAppendRequest {
  readonly commitId: string;
  readonly record: ActiveTurnJournalRecord;
}

export interface ActiveTurnJournalPort {
  append(input: ActiveTurnJournalAppendRequest): Promise<void>;
  replay(): Promise<readonly ActiveTurnJournalRecord[]>;
}

/** Durable commit identity for one active-turn record. */
export function activeTurnCommitId(turnId: string, discriminator: string): string {
  return `active-turn:${turnId}:${discriminator}`;
}

/**
 * Durable record inside one resumed execution segment. A segment reuses the
 * existing request / accepted-fact / child-invocation / child-delivery record
 * kinds; the explicit segment envelope (`segment-opened`) carries the new
 * execution ownership. This is an extraction of the existing union, not a clone.
 * A resumed segment never writes a second `initial-input` or a fake
 * `binding-opened`.
 */
export type ActiveTurnSegmentJournalRecord = Extract<
  ActiveTurnJournalRecord,
  { kind: 'request' | 'accepted-fact' | 'child-invocation' | 'child-delivery' }
>;

export interface ActiveTurnSegmentRecordAppendRequest {
  readonly businessTurnId: string;
  readonly segmentId: string;
  /** `activeTurnSegmentCommitId(segmentId, discriminatorOf(record))`. */
  readonly commitId: string;
  readonly record: ActiveTurnSegmentJournalRecord;
}

/**
 * Exact v2 recovery-assets receipt for one resumed segment. The commit lives on
 * the Journal; the capture stays in the immutable asset store. Distinct from the
 * v1 receipt, which carries a `turnId` and no `segmentId`.
 */
export interface ActiveTurnSegmentRecoveryAssetsReceipt {
  readonly commitIdentity: string;
  readonly journalReceiptRef: string;
  readonly commitFactDigest: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly boundaryId: string;
  readonly capture: RawAsset;
}

export interface ActiveTurnSegmentCompletionReadback {
  readonly lookup: CompletionReadInput;
  readonly readback: CompletionReadback;
}

/**
 * Immutable cold read of one resumed segment's prepared v2 capture. It returns
 * the real frozen body, the receipt and the exact completion readbacks; an
 * unknown completion keeps the recovery responsibility and is never rewritten.
 */
export interface ActiveTurnSegmentCaptureExactRead {
  readonly receipt: ActiveTurnSegmentRecoveryAssetsReceipt;
  readonly prepared: PreparedActiveTurnSegmentCaptureV2;
  readonly completions: readonly ActiveTurnSegmentCompletionReadback[];
}

/**
 * Exact cold read of one opened-but-unsaved predecessor segment. The
 * `predecessor` is the interrupted anchor that names the real `segment-opened`
 * commit and the last committed record; the `prefix` is the committed live
 * prefix cut at that anchor. It is not a frozen capture and carries no pause,
 * drain or save fact.
 */
export interface ActiveTurnSegmentInterruptedExactRead {
  readonly predecessor: Extract<
    ActiveTurnSegmentPredecessorRef,
    { readonly interrupted: ActiveTurnSegmentInterruptedAnchor }
  >;
  readonly prefix: ActiveTurnSegmentLivePrefix;
}

/**
 * Exact cold read of an original turn that opened in v1 and never committed a
 * v1 capture. The `anchor` is the real `binding-opened` commit plus the last
 * committed `active-turn:<businessTurnId>:*` record; the `prefix` is the
 * committed v1 live prefix cut at that anchor. It is not a frozen capture and
 * carries no pause, drain or save fact.
 */
export interface ActiveTurnInitialOpenExactRead {
  readonly anchor: ActiveTurnInitialOpenAnchor;
  readonly prefix: ActiveTurnLivePrefix;
}

/**
 * The named segment-journal port. It extends the Runtime read/append ports that
 * `resumeActiveTurnSegment` consumes with the exact segment-record and capture
 * reads that D-L/D-M consume. The physical commit and immutable-asset backing
 * stay with the J1 owner; this port adds no second store.
 */
export interface ActiveTurnSegmentJournalPort extends ActiveTurnSegmentReadPort, ActiveTurnSegmentAppendPort {
  appendSegmentRecord(input: ActiveTurnSegmentRecordAppendRequest): Promise<JournalCommitRef>;
  readSegmentRecords(input: {
    readonly businessTurnId: string;
    readonly segmentId: string;
  }): Promise<readonly ActiveTurnSegmentJournalRecord[]>;
  readSegmentCaptureExact(input: {
    readonly businessTurnId: string;
    readonly segmentId: string;
    readonly recoveryAssetsReceiptRef: string;
  }): Promise<ActiveTurnSegmentCaptureExactRead>;
  readSegmentInterruptedExact(input: {
    readonly businessTurnId: string;
    readonly predecessor: ActiveTurnSegmentInterruptedExactRead['predecessor'];
  }): Promise<ActiveTurnSegmentInterruptedExactRead>;
  /**
   * The durable anchor of the original turn when it opened but never captured,
   * or null when no binding-opened record exists for the bound business turn.
   */
  readInitialOpenAnchor(): Promise<ActiveTurnInitialOpenAnchor | null>;
  /**
   * Exact cold read of the original turn's committed v1 live prefix, re-checked
   * against the supplied anchor so a stale or forged anchor fails instead of
   * reading a changed tail. The original input is referenced, never copied.
   */
  readInitialOpenExact(input: {
    readonly businessTurnId: string;
    readonly anchor: ActiveTurnInitialOpenAnchor;
  }): Promise<ActiveTurnInitialOpenExactRead>;
}

/** Re-exported so consumers can name the exact opened record without a deep import. */
export type { ResumedTurnSegmentOpened, ActiveTurnInitialSegmentCapture, ActiveTurnSegmentRecoveryReceiptRead };
