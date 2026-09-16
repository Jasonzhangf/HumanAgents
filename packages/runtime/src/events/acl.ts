import {
  assertExecutionEpoch,
  assertScope,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { EventConsumerError, EventPublisherError } from './errors.js';
import type {
  EventConsumerBinding,
  EventEnvelope,
  EventRecord,
  TrustedEventPublisher,
} from './types.js';

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new EventPublisherError(`${label} is required`);
}

export function assertEventScope(scope: ScopeRef): void {
  assertScope(scope.organId, 'organ');
  if (scope.taskId) assertScope(scope.taskId, 'task');
  if (scope.cycleId) assertScope(scope.cycleId, 'cycle');
  if (scope.operationId) assertScope(scope.operationId, 'operation');
}

export function scopeContains(container: ScopeRef, candidate: ScopeRef): boolean {
  if (!sameScopedId(container.organId, candidate.organId)) return false;
  if (container.taskId && !sameScopedId(container.taskId, candidate.taskId)) return false;
  if (container.cycleId && !sameScopedId(container.cycleId, candidate.cycleId)) return false;
  if (container.operationId && !sameScopedId(container.operationId, candidate.operationId)) return false;
  return true;
}

export function assertPublisherCanPublish(
  publisher: TrustedEventPublisher,
  event: EventEnvelope,
): void {
  assertNonEmpty(publisher.publisherId, 'publisher id');
  assertNonEmpty(publisher.ownerId, 'publisher owner');
  assertEventScope(publisher.scope);
  assertEventScope(event.scope);
  if (publisher.kind === 'external' && event.class === 'control') {
    throw new EventPublisherError('external publisher cannot publish control events');
  }
  if (event.class === 'control' && publisher.kind !== 'harness') {
    throw new EventPublisherError('control events require a trusted harness publisher');
  }
  if (!publisher.allowedClasses.includes(event.class)) {
    throw new EventPublisherError(`publisher cannot publish ${event.class} events`);
  }
  if (!scopeContains(publisher.scope, event.scope)) {
    throw new EventPublisherError('publisher scope does not contain event scope');
  }
}

export function validateEventEnvelope(event: EventEnvelope): void {
  assertNonEmpty(event.messageId, 'event message id');
  assertNonEmpty(event.streamId, 'event stream id');
  assertNonEmpty(event.summary, 'event summary');
  assertEventScope(event.scope);
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new EventPublisherError('event occurredAt is invalid');
  if (event.executionEpoch !== undefined) assertExecutionEpoch(event.executionEpoch);
  if (event.attempt !== undefined && (!Number.isSafeInteger(event.attempt) || event.attempt < 1)) {
    throw new EventPublisherError('event attempt must be a positive safe integer');
  }
  if (event.inputRevision !== undefined && (!Number.isSafeInteger(event.inputRevision) || event.inputRevision < 1)) {
    throw new EventPublisherError('event inputRevision must be a positive safe integer');
  }
}

export type ConsumerDeliveryDecision =
  | { readonly deliver: true }
  | {
      readonly deliver: false;
      readonly disposition: 'stale' | 'rejected';
      readonly failureRef: string;
    };

export function decideConsumerDelivery(
  consumer: EventConsumerBinding,
  event: EventRecord,
): ConsumerDeliveryDecision {
  if (consumer.revoked) {
    return { deliver: false, disposition: 'rejected', failureRef: 'consumer-permission-revoked' };
  }
  if (!consumer.streamIds.includes(event.streamId)) {
    return { deliver: false, disposition: 'rejected', failureRef: 'consumer-stream-not-subscribed' };
  }
  if (!consumer.allowedClasses.includes(event.class)) {
    return { deliver: false, disposition: 'rejected', failureRef: 'consumer-event-class-not-allowed' };
  }
  if (!scopeContains(consumer.scope, event.scope)) {
    return { deliver: false, disposition: 'rejected', failureRef: 'consumer-event-scope-not-allowed' };
  }
  if (
    consumer.currentEpoch !== undefined
    && event.executionEpoch !== undefined
    && consumer.currentEpoch !== event.executionEpoch
  ) {
    return { deliver: false, disposition: 'stale', failureRef: 'consumer-epoch-mismatch' };
  }
  return { deliver: true };
}

export function assertConsumerKey(consumer: EventConsumerBinding, expected: string): void {
  if (consumer.consumerKey !== expected) throw new EventConsumerError('consumer binding key mismatch');
  if (!Number.isSafeInteger(consumer.retryLimit) || consumer.retryLimit < 1) {
    throw new EventConsumerError('consumer retry limit must be a positive safe integer');
  }
  assertEventScope(consumer.scope);
}
