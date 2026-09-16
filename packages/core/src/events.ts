import type { EventConsumerCursor, EventConsumerReceipt, EventRetryObligation } from '../../contracts/src/index.js';
import { validateEventConsumerCursor, validateEventConsumerReceipt, validateEventRetryObligation } from '../../contracts/src/index.js';
import { CoreError } from './errors.js';

export interface RetryPolicy {
  readonly maxAttempts: number;
}

export function advanceConsumerCursor(current: EventConsumerCursor, receipt: EventConsumerReceipt): EventConsumerCursor {
  validateEventConsumerCursor(current);
  validateEventConsumerReceipt(receipt);
  if (current.streamId !== receipt.streamId) throw new CoreError('consumer cursor stream mismatch');
  if (current.consumerKey !== receipt.consumerKey) throw new CoreError('consumer cursor key mismatch');
  if (receipt.handledSequence <= current.lastHandledSequence) return current;
  if (receipt.handledSequence !== current.lastHandledSequence + 1) {
    throw new CoreError(`consumer cursor sequence gap: expected ${current.lastHandledSequence + 1}, received ${receipt.handledSequence}`);
  }
  return { ...current, lastHandledSequence: receipt.handledSequence };
}

export function isRetryPending(obligation: EventRetryObligation): boolean {
  validateEventRetryObligation(obligation);
  return obligation.state === 'pending';
}

export function canRetryNow(obligation: EventRetryObligation, policy: RetryPolicy, now = new Date()): boolean {
  validateEventRetryObligation(obligation);
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new CoreError('retry maxAttempts must be a positive safe integer');
  }
  return obligation.state === 'pending'
    && obligation.attempt < policy.maxAttempts
    && Date.parse(obligation.nextAttemptAt) <= now.getTime();
}

export function assertRetryNotExhausted(obligation: EventRetryObligation, policy: RetryPolicy): void {
  if (!canRetryNow(obligation, policy)) {
    throw new CoreError(`retry obligation cannot be retried: attempt=${obligation.attempt} state=${obligation.state}`);
  }
}
