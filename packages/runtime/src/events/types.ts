import type {
  BusinessPayload,
  EvidenceRef,
  NextAction,
  ScopeRef,
} from '../../../contracts/src/index.js';

export const EVENT_CLASSES = ['control', 'data', 'observation'] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export const EVENT_CONSUMER_DISPOSITIONS = [
  'applied',
  'duplicate',
  'stale',
  'rejected',
  'terminal-failure',
] as const;
export type EventConsumerDisposition = (typeof EVENT_CONSUMER_DISPOSITIONS)[number];

export const CONSUMER_COMMIT_MODES = ['journal-atomic', 'operation-barrier'] as const;
export type ConsumerCommitMode = (typeof CONSUMER_COMMIT_MODES)[number];

export type EventPublisherKind = 'harness' | 'agent' | 'external';

export interface EventEnvelope {
  readonly messageId: string;
  readonly streamId: string;
  readonly class: EventClass;
  readonly scope: ScopeRef;
  readonly occurredAt: string;
  readonly summary: string;
  readonly payload?: BusinessPayload;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly executionEpoch?: number;
  readonly attempt?: number;
  readonly inputRevision?: number;
}

export interface EventRecord extends EventEnvelope {
  readonly publisherId: string;
  readonly sequence: number;
  readonly committedAt: string;
}

export interface TrustedEventPublisher {
  readonly publisherId: string;
  readonly kind: EventPublisherKind;
  readonly ownerId: string;
  readonly scope: ScopeRef;
  readonly allowedClasses: readonly EventClass[];
  readonly capabilities: readonly string[];
}

export interface EventConsumerBinding {
  readonly consumerKey: string;
  readonly consumerOwner: string;
  readonly scopeRef: string;
  readonly contractVersion: string;
  readonly scope: ScopeRef;
  readonly streamIds: readonly string[];
  readonly allowedClasses: readonly EventClass[];
  readonly retryLimit: number;
  readonly currentEpoch?: number;
  readonly revoked?: boolean;
}

export interface ConsumerCursor {
  readonly streamId: string;
  readonly consumerKey: string;
  readonly lastHandledSequence: number;
  readonly updatedAt: string;
}

export interface EventConsumerReceipt {
  readonly consumerKey: string;
  readonly messageId: string;
  readonly streamId: string;
  readonly handledSequence: number;
  readonly disposition: EventConsumerDisposition;
  readonly effectRefs: readonly string[];
  readonly failureRef?: string;
}

export interface EventHandlerCommitIntent {
  readonly consumerKey: string;
  readonly messageId: string;
  readonly disposition: Exclude<EventConsumerDisposition, 'terminal-failure'>;
  readonly completionMode: ConsumerCommitMode;
  readonly internalEffectFacts: readonly string[];
  readonly externalOperationRefs: readonly string[];
  readonly failureRef?: string;
}

export interface EventRetryObligation {
  readonly retryKey: string;
  readonly consumerKey: string;
  readonly messageId: string;
  readonly streamId: string;
  readonly failedSequence: number;
  readonly attempt: number;
  readonly nextAttemptAt: string;
  readonly ownerRef: string;
  readonly failureRef: string;
  readonly state: 'pending' | 'exhausted' | 'cancelled';
}

export const EXTERNAL_OPERATION_STATES = ['pending', 'settled', 'reconciled', 'failed', 'unknown'] as const;
export type ExternalOperationState = (typeof EXTERNAL_OPERATION_STATES)[number];

export interface EventExternalOperation {
  readonly operationRef: string;
  readonly consumerKey: string;
  readonly messageId: string;
  readonly state: ExternalOperationState;
}

export interface EventOperationBlocked {
  readonly consumerKey: string;
  readonly messageId: string;
  readonly streamId: string;
  readonly operationRef: string;
  readonly reason: 'unknown-side-effect';
  readonly action: 'reconcile';
}

export interface EventHandlerRetryIntent {
  readonly consumerKey: string;
  readonly messageId: string;
  readonly retryObligation: EventRetryObligation;
}

export type EventHandlerCommit = EventHandlerCommitIntent | EventHandlerRetryIntent;

export interface EventDlqRecord {
  readonly retryKey: string;
  readonly consumerKey: string;
  readonly messageId: string;
  readonly streamId: string;
  readonly failedSequence: number;
  readonly attempt: number;
  readonly ownerRef: string;
  readonly failureRef: string;
  readonly state: 'open';
  readonly recordedAt: string;
  readonly nextAction: NextAction;
}

export interface EventDelivery {
  readonly event: EventRecord;
  readonly attempt: number;
  readonly retryKey?: string;
}

export type EventConsumerHandler = (
  delivery: EventDelivery,
) => EventHandlerCommit | Promise<EventHandlerCommit>;

export interface ConsumeEventsInput {
  readonly consumerKey: string;
  readonly limit: number;
  readonly now?: string;
}

export interface ConsumerProcessResult {
  readonly consumerKey: string;
  readonly committed: readonly EventConsumerReceipt[];
  readonly retries: readonly EventRetryObligation[];
  readonly dlq: readonly EventDlqRecord[];
  readonly blocked: readonly EventOperationBlocked[];
  readonly cursors: readonly ConsumerCursor[];
}

export interface ConsumerCommitRequest {
  readonly receipt: EventConsumerReceipt;
  readonly cursor: ConsumerCursor;
  readonly completionMode: ConsumerCommitMode;
  readonly internalEffectFacts: readonly string[];
  readonly externalOperationRefs: readonly string[];
}

export interface ConsumerCommitResult {
  readonly receipt: EventConsumerReceipt;
  readonly cursor: ConsumerCursor;
}
