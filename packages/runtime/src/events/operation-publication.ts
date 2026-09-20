import {
  validateOperationEvent,
  type OperationEvent,
  type OperationId,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { assertEventScope } from './acl.js';
import {
  publishEvent,
  type EventPublishPorts,
} from './coordinator.js';
import { EventPublisherError } from './errors.js';
import type {
  EventEnvelope,
  EventOperationMetadata,
  EventRecord,
} from './types.js';

export type OperationEventPublicationFailure =
  | 'invalid-operation-event'
  | 'stale-operation-event'
  | 'identity-conflict'
  | 'journal-read-failed'
  | 'journal-commit-failed'
  | 'notification-failed';

export interface OperationEventCursor {
  readonly streamId: string;
  readonly sequence: number;
}

export interface OperationEventNotificationAck {
  readonly ackRef: string;
  readonly acknowledgedAt: string;
}

export interface OperationEventNotificationPort {
  notify(input: {
    readonly event: EventRecord;
    readonly cursor: OperationEventCursor;
  }): Promise<OperationEventNotificationAck>;
}

export interface PublishOperationEventInput {
  readonly publisherId: string;
  readonly streamId: string;
  readonly scope: ScopeRef;
  readonly event: OperationEvent;
  readonly currentEpoch: number;
}

export interface OperationEventPublicationReceipt {
  readonly eventId: string;
  readonly operationId: OperationId;
  readonly event: EventRecord;
  readonly cursor: OperationEventCursor;
  readonly ack: OperationEventNotificationAck;
  readonly duplicate: boolean;
}

export interface QueryOperationEventsInput {
  readonly streamId: string;
  readonly operationId?: OperationId;
  readonly afterSequence?: number;
  readonly limit: number;
}

export interface ReplayOperationEventNotificationsInput extends QueryOperationEventsInput {
  readonly currentEpoch?: number;
}

export class OperationEventPublicationError extends EventPublisherError {
  constructor(
    message: string,
    public readonly code: OperationEventPublicationFailure,
    public readonly committed: boolean,
    public readonly event?: EventRecord,
    public readonly cursor?: OperationEventCursor,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OperationEventPublicationError';
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new OperationEventPublicationError(`${label} is required`, 'invalid-operation-event', false);
}

function assertPositiveEpoch(epoch: number, label: string): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new OperationEventPublicationError(`${label} must be a positive safe integer`, 'invalid-operation-event', false);
  }
}

function assertCurrentEpoch(event: OperationEvent, currentEpoch: number): void {
  assertPositiveEpoch(currentEpoch, 'current epoch');
  if (event.executionEpoch !== currentEpoch) {
    throw new OperationEventPublicationError(
      `stale operation event: expected epoch ${currentEpoch}, got ${event.executionEpoch}`,
      'stale-operation-event',
      false,
    );
  }
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function operationScope(scope: ScopeRef, event: OperationEvent): ScopeRef {
  if (scope.taskId && !sameScopedId(scope.taskId, event.taskId)) {
    throw new OperationEventPublicationError(
      'operation event task identity does not match scope',
      'identity-conflict',
      false,
    );
  }
  if (scope.operationId && !sameScopedId(scope.operationId, event.operationId)) {
    throw new OperationEventPublicationError(
      'operation event operation identity does not match scope',
      'identity-conflict',
      false,
    );
  }
  const resolved = {
    ...scope,
    taskId: scope.taskId ?? event.taskId,
    operationId: scope.operationId ?? event.operationId,
  };
  assertEventScope(resolved);
  return resolved;
}

function operationMetadata(event: OperationEvent): EventOperationMetadata {
  return {
    operationId: event.operationId,
    status: event.status,
    outputRef: event.outputRef,
    outputDigest: event.outputDigest,
    resultRef: event.resultRef,
    failure: event.failure,
  };
}

function operationEnvelope(input: PublishOperationEventInput): EventEnvelope {
  const scope = operationScope(input.scope, input.event);
  return {
    eventId: input.event.eventId,
    schemaVersion: input.event.schemaVersion,
    messageId: input.event.eventId,
    streamId: input.streamId,
    kind: input.event.kind,
    class: 'control',
    scope,
    occurredAt: input.event.occurredAt,
    summary: `${input.event.kind}: ${input.event.status}`,
    evidenceRefs: input.event.evidenceRefs,
    executionEpoch: input.event.executionEpoch,
    operation: operationMetadata(input.event),
  };
}

function cursorFor(record: EventRecord): OperationEventCursor {
  return { streamId: record.streamId, sequence: record.sequence };
}

function assertCanonicalRecord(
  record: EventRecord,
  expected: EventEnvelope,
  publisherId: string,
): void {
  const canonical = {
    ...record,
    sequence: undefined,
    committedAt: undefined,
  };
  const requested = {
    ...expected,
    publisherId,
    sequence: undefined,
    committedAt: undefined,
  };
  if (JSON.stringify(canonical) !== JSON.stringify(requested)) {
    throw new OperationEventPublicationError(
      `operation event identity conflicts with committed history: ${expected.messageId}`,
      'identity-conflict',
      true,
      record,
      cursorFor(record),
    );
  }
}

function assertNotificationAck(
  ack: OperationEventNotificationAck,
  record: EventRecord,
): void {
  if (!ack.ackRef?.trim() || !Number.isFinite(Date.parse(ack.acknowledgedAt))) {
    throw new OperationEventPublicationError(
      'operation event notification returned an invalid acknowledgement',
      'notification-failed',
      true,
      record,
      cursorFor(record),
    );
  }
}

async function notifyCommitted(
  notification: OperationEventNotificationPort,
  record: EventRecord,
): Promise<OperationEventNotificationAck> {
  try {
    const ack = await notification.notify({ event: record, cursor: cursorFor(record) });
    assertNotificationAck(ack, record);
    return ack;
  } catch (error) {
    if (error instanceof OperationEventPublicationError) throw error;
    throw new OperationEventPublicationError(
      `operation event notification failed after journal commit: ${record.messageId}`,
      'notification-failed',
      true,
      record,
      cursorFor(record),
      { cause: error },
    );
  }
}

export async function publishOperationEvent(
  ports: EventPublishPorts,
  notification: OperationEventNotificationPort,
  input: PublishOperationEventInput,
): Promise<OperationEventPublicationReceipt> {
  assertNonEmpty(input.publisherId, 'publisher id');
  assertNonEmpty(input.streamId, 'event stream id');
  try {
    validateOperationEvent(input.event);
  } catch (error) {
    throw new OperationEventPublicationError(
      'operation event is invalid',
      'invalid-operation-event',
      false,
      undefined,
      undefined,
      { cause: error },
    );
  }
  assertCurrentEpoch(input.event, input.currentEpoch);
  const envelope = operationEnvelope(input);

  let existing: EventRecord | null;
  try {
    existing = await ports.journal.readEvent({
      streamId: input.streamId,
      messageId: input.event.eventId,
    });
  } catch (error) {
    throw new OperationEventPublicationError(
      `operation event journal read failed: ${input.event.eventId}`,
      'journal-read-failed',
      false,
      undefined,
      undefined,
      { cause: error },
    );
  }
  if (existing) assertCanonicalRecord(existing, envelope, input.publisherId);

  let record = existing;
  if (!record) {
    try {
      record = (await publishEvent(ports, {
        publisherId: input.publisherId,
        event: envelope,
      })).event;
    } catch (error) {
      if (error instanceof EventPublisherError) throw error;
      throw new OperationEventPublicationError(
        `operation event journal commit failed: ${input.event.eventId}`,
        'journal-commit-failed',
        false,
        undefined,
        undefined,
        { cause: error },
      );
    }
    assertCanonicalRecord(record, envelope, input.publisherId);
  }

  const ack = await notifyCommitted(notification, record);
  return {
    eventId: input.event.eventId,
    operationId: input.event.operationId,
    event: record,
    cursor: cursorFor(record),
    ack,
    duplicate: existing !== null,
  };
}

export async function queryOperationEvents(
  ports: Pick<EventPublishPorts, 'journal'>,
  input: QueryOperationEventsInput,
): Promise<readonly EventRecord[]> {
  assertNonEmpty(input.streamId, 'event stream id');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new OperationEventPublicationError('query limit must be a positive safe integer', 'invalid-operation-event', false);
  }
  if (input.afterSequence !== undefined && (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)) {
    throw new OperationEventPublicationError('afterSequence must be a non-negative safe integer', 'invalid-operation-event', false);
  }
  const operationRecords: EventRecord[] = [];
  let afterSequence = input.afterSequence ?? 0;
  const pageSize = input.operationId === undefined ? Math.max(input.limit, 64) : Number.MAX_SAFE_INTEGER;
  while (operationRecords.length < input.limit) {
    const page = await ports.journal.readEvents({
      streamId: input.streamId,
      afterSequence,
      limit: pageSize,
    });
    for (const record of page) {
      if (record.operation !== undefined
        && (input.operationId === undefined || sameScopedId(record.operation.operationId, input.operationId))) {
        operationRecords.push(record);
        if (operationRecords.length === input.limit) break;
      }
    }
    if (page.length < pageSize || page.length === 0 || operationRecords.length === input.limit) break;
    afterSequence = page[page.length - 1]!.sequence;
  }
  return operationRecords;
}

export async function replayOperationEventNotifications(
  ports: Pick<EventPublishPorts, 'journal'>,
  notification: OperationEventNotificationPort,
  input: ReplayOperationEventNotificationsInput,
): Promise<readonly OperationEventPublicationReceipt[]> {
  if (input.currentEpoch !== undefined && input.operationId === undefined) {
    throw new OperationEventPublicationError(
      'operation event replay epoch requires an operation id',
      'invalid-operation-event',
      false,
    );
  }
  const records = await queryOperationEvents(ports, input);
  if (input.currentEpoch !== undefined) {
    const stale = records.find((record) => record.executionEpoch !== input.currentEpoch);
    if (stale) {
      throw new OperationEventPublicationError(
        `stale operation event: expected epoch ${input.currentEpoch}, got ${stale.executionEpoch}`,
        'stale-operation-event',
        true,
        stale,
        cursorFor(stale),
      );
    }
  }
  const receipts: OperationEventPublicationReceipt[] = [];
  for (const record of records) {
    const operation = record.operation;
    if (!operation) continue;
    const ack = await notifyCommitted(notification, record);
    receipts.push({
      eventId: record.messageId,
      operationId: operation.operationId,
      event: record,
      cursor: cursorFor(record),
      ack,
      duplicate: true,
    });
  }
  return receipts;
}
