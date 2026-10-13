import type {
  AcceptedChildDelivery,
  AcceptedRawFact,
  ActiveTurnBinding,
  ChildInvocationRecord,
  RuntimeRequestRecord,
} from '../../../contracts/src/index.js';

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
