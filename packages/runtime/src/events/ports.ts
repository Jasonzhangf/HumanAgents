import type {
  ConsumerCommitRequest,
  ConsumerCommitResult,
  ConsumerCursor,
  EventConsumerBinding,
  EventConsumerReceipt,
  EventDlqRecord,
  EventEnvelope,
  EventExternalOperation,
  EventRecord,
  EventRetryObligation,
  TrustedEventPublisher,
} from './types.js';

export interface EventPublisherRegistryPort {
  resolvePublisher(publisherId: string): Promise<TrustedEventPublisher | null>;
}

export interface EventConsumerRegistryPort {
  resolveConsumer(consumerKey: string): Promise<EventConsumerBinding | null>;
}

export interface ReadEventsInput {
  readonly streamId: string;
  readonly afterSequence: number;
  readonly limit: number;
}

export interface ReadEventInput {
  readonly streamId: string;
  readonly messageId: string;
}

export interface ReadCursorInput {
  readonly streamId: string;
  readonly consumerKey: string;
}

export interface ReadReceiptInput {
  readonly consumerKey: string;
  readonly messageId: string;
}

export interface ReadRetryObligationInput extends ReadReceiptInput {}

export interface ReadExternalOperationInput {
  readonly operationRef: string;
  readonly consumerKey: string;
  readonly messageId: string;
}

export interface EventExternalOperationPort {
  readExternalOperation(input: ReadExternalOperationInput): Promise<EventExternalOperation | null>;
}

export interface ListPendingRetryObligationsInput {
  readonly streamId: string;
  readonly consumerKey: string;
  readonly limit: number;
}

export interface AppendEventRequest {
  readonly event: EventEnvelope;
  readonly publisherId: string;
}

export interface EventJournalPort {
  appendEvent(input: AppendEventRequest): Promise<EventRecord>;
  readEvents(input: ReadEventsInput): Promise<readonly EventRecord[]>;
  readEvent(input: ReadEventInput): Promise<EventRecord | null>;
  readCursor(input: ReadCursorInput): Promise<ConsumerCursor | null>;
  commitConsumerCommit(input: ConsumerCommitRequest): Promise<ConsumerCommitResult>;
  readReceipt(input: ReadReceiptInput): Promise<EventConsumerReceipt | null>;
  commitRetryObligation(obligation: EventRetryObligation): Promise<EventRetryObligation>;
  readRetryObligation(input: ReadRetryObligationInput): Promise<EventRetryObligation | null>;
  listPendingRetryObligations(input: ListPendingRetryObligationsInput): Promise<readonly EventRetryObligation[]>;
  commitDlq(record: EventDlqRecord): Promise<EventDlqRecord>;
  readDlq(input: ReadRetryObligationInput): Promise<EventDlqRecord | null>;
}
