import {
  assertBusinessPayload,
  assertEvidenceRef,
} from '../../../contracts/src/index.js';
import {
  assertConsumerKey,
  assertPublisherCanPublish,
  decideConsumerDelivery,
  scopeContains,
  validateEventEnvelope,
} from './acl.js';
import { EventBusError, EventConsumerError, EventPublisherError } from './errors.js';
import type {
  EventConsumerRegistryPort,
  AppendEventRequest,
  EventJournalPort,
  EventPublisherRegistryPort,
  EventExternalOperationPort,
} from './ports.js';
import type {
  ConsumerCommitRequest,
  ConsumerCursor,
  ConsumeEventsInput,
  ConsumerProcessResult,
  EventConsumerBinding,
  EventConsumerHandler,
  EventConsumerReceipt,
  EventDlqRecord,
  EventEnvelope,
  EventExternalOperation,
  EventHandlerCommit,
  EventHandlerCommitIntent,
  EventHandlerRetryIntent,
  EventOperationBlocked,
  EventRecord,
  EventRetryObligation,
} from './types.js';

export interface EventBusPorts {
  readonly journal: EventJournalPort;
  readonly publishers: EventPublisherRegistryPort;
  readonly consumers: EventConsumerRegistryPort;
  readonly externalOperations: EventExternalOperationPort;
}

export interface PublishEventInput {
  readonly publisherId: string;
  readonly event: EventEnvelope;
}

export interface PublishedEvent {
  readonly event: EventRecord;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new EventBusError(`${label} is required`);
}

function nowIso(input?: string): string {
  if (input !== undefined) {
    if (!Number.isFinite(Date.parse(input))) throw new EventConsumerError('consumer now timestamp is invalid');
    return input;
  }
  return new Date().toISOString();
}

function assertEvidence(event: EventEnvelope): void {
  for (const evidenceRef of event.evidenceRefs) {
    assertEvidenceRef(evidenceRef);
    if (!scopeContains(event.scope, evidenceRef.scope)) {
      throw new EventPublisherError('event evidence scope exceeds event scope');
    }
  }
}

function assertEventPayload(event: EventEnvelope): void {
  if (event.payload) assertBusinessPayload(event.payload);
}

function identityKey(streamId: string, consumerKey: string, messageId: string): string {
  return `${streamId.length}:${streamId}${consumerKey.length}:${consumerKey}${messageId.length}:${messageId}`;
}

function receiptKey(streamId: string, consumerKey: string, messageId: string): string {
  return identityKey(streamId, consumerKey, messageId);
}

function retryKey(streamId: string, consumerKey: string, messageId: string): string {
  return identityKey(streamId, consumerKey, messageId);
}

function uniqueRefs(refs: readonly string[]): readonly string[] {
  return [...new Set(refs)];
}

function effectRefs(intent: EventHandlerCommitIntent): readonly string[] {
  return uniqueRefs([...intent.internalEffectFacts, ...intent.externalOperationRefs]);
}

function isRetryIntent(commit: EventHandlerCommit): commit is EventHandlerRetryIntent {
  return 'retryObligation' in commit;
}

function assertExternalOperationSettled(
  operation: EventExternalOperation | null,
  ref: string,
): asserts operation is EventExternalOperation {
  if (!operation) throw new EventConsumerError(`external operation is not settled or reconciled: ${ref}`);
  if (operation.operationRef !== ref) throw new EventConsumerError('external operation ref mismatch');
}

function externalOperationBlocked(
  operation: EventExternalOperation,
  consumerKey: string,
  messageId: string,
  streamId: string,
): EventOperationBlocked {
  return {
    consumerKey,
    messageId,
    streamId,
    operationRef: operation.operationRef,
    reason: 'unknown-side-effect',
    action: 'reconcile',
  };
}

async function assertCommitIntent(
  ports: EventBusPorts,
  consumer: EventConsumerBinding,
  event: EventRecord,
  commit: EventHandlerCommitIntent,
): Promise<EventOperationBlocked | null> {
  if (commit.consumerKey !== consumer.consumerKey) throw new EventConsumerError('handler commit consumer key mismatch');
  if (commit.messageId !== event.messageId) throw new EventConsumerError('handler commit message id mismatch');
  if (commit.completionMode === 'journal-atomic' && commit.externalOperationRefs.length > 0) {
    throw new EventConsumerError('journal-atomic handler commit cannot carry external operations');
  }
  if (commit.completionMode === 'operation-barrier' && commit.externalOperationRefs.length === 0) {
    throw new EventConsumerError('operation-barrier handler commit requires settled external operations');
  }
  if (commit.completionMode === 'operation-barrier') {
    const refs = uniqueRefs(commit.externalOperationRefs);
    const operations = await Promise.all(refs.map((ref) => ports.externalOperations.readExternalOperation({
      operationRef: ref,
      consumerKey: consumer.consumerKey,
      messageId: event.messageId,
    })));
    for (const [index, operation] of operations.entries()) {
      const ref = refs[index];
      if (!ref?.trim()) throw new EventConsumerError('external operation ref is required');
      assertExternalOperationSettled(operation, ref);
      if (operation.consumerKey !== consumer.consumerKey) throw new EventConsumerError('external operation consumer key mismatch');
      if (operation.messageId !== event.messageId) throw new EventConsumerError('external operation message id mismatch');
    }
    const unknown = operations.find((operation) => operation?.state === 'unknown');
    if (unknown) return externalOperationBlocked(unknown, consumer.consumerKey, event.messageId, event.streamId);
    for (const [index, operation] of operations.entries()) {
      const ref = refs[index];
      if (operation?.state !== 'settled' && operation?.state !== 'reconciled') {
        throw new EventConsumerError(`external operation is not settled or reconciled: ${ref}`);
      }
    }
  }
  return null;
}

function assertRetryIntent(
  consumer: EventConsumerBinding,
  event: EventRecord,
  retry: EventHandlerRetryIntent,
  expectedAttempt: number,
): void {
  if (retry.consumerKey !== consumer.consumerKey) throw new EventConsumerError('retry intent consumer key mismatch');
  if (retry.messageId !== event.messageId) throw new EventConsumerError('retry intent message id mismatch');
  const obligation = retry.retryObligation;
  if (obligation.consumerKey !== consumer.consumerKey) throw new EventConsumerError('retry obligation consumer key mismatch');
  if (obligation.messageId !== event.messageId) throw new EventConsumerError('retry obligation message id mismatch');
  if (obligation.streamId !== event.streamId) throw new EventConsumerError('retry obligation stream id mismatch');
  if (obligation.failedSequence !== event.sequence) throw new EventConsumerError('retry obligation sequence mismatch');
  if (obligation.attempt !== expectedAttempt) throw new EventConsumerError('retry obligation attempt is not coordinator-owned');
  if (!Number.isFinite(Date.parse(obligation.nextAttemptAt))) {
    throw new EventConsumerError('retry obligation nextAttemptAt is invalid');
  }
  if (!obligation.ownerRef.trim()) throw new EventConsumerError('retry obligation owner ref is required');
  if (!obligation.failureRef.trim()) throw new EventConsumerError('retry obligation failure ref is required');
  if (obligation.retryKey !== retryKey(event.streamId, consumer.consumerKey, event.messageId)) {
    throw new EventConsumerError('retry obligation key mismatch');
  }
}

export async function publishEvent(
  ports: EventBusPorts,
  input: PublishEventInput,
): Promise<PublishedEvent> {
  assertNonEmpty(input.publisherId, 'publisher id');
  validateEventEnvelope(input.event);
  assertEventPayload(input.event);
  assertEvidence(input.event);

  const publisher = await ports.publishers.resolvePublisher(input.publisherId);
  if (!publisher) throw new EventPublisherError('publisher is not trusted');
  if (publisher.publisherId !== input.publisherId) throw new EventPublisherError('publisher identity mismatch');
  assertPublisherCanPublish(publisher, input.event);

  const event = await ports.journal.appendEvent({
    event: input.event,
    publisherId: publisher.publisherId,
  });
  if (event.messageId !== input.event.messageId || event.streamId !== input.event.streamId) {
    throw new EventPublisherError('journal append identity mismatch');
  }
  return { event };
}

async function readConsumer(
  ports: EventBusPorts,
  consumerKey: string,
): Promise<EventConsumerBinding> {
  const consumer = await ports.consumers.resolveConsumer(consumerKey);
  if (!consumer) throw new EventConsumerError('consumer is not registered');
  assertConsumerKey(consumer, consumerKey);
  return consumer;
}

async function readCursor(
  ports: EventBusPorts,
  streamId: string,
  consumerKey: string,
): Promise<ConsumerCursor | null> {
  return ports.journal.readCursor({ streamId, consumerKey });
}

function makeReceipt(
  consumerKey: string,
  event: EventRecord,
  disposition: EventConsumerReceipt['disposition'],
  refs: readonly string[],
  failureRef?: string,
): EventConsumerReceipt {
  return {
    consumerKey,
    messageId: event.messageId,
    streamId: event.streamId,
    handledSequence: event.sequence,
    disposition,
    effectRefs: refs,
    failureRef,
  };
}

function cursorFor(
  event: EventRecord,
  consumerKey: string,
  updatedAt: string,
): ConsumerCursor {
  return {
    streamId: event.streamId,
    consumerKey,
    lastHandledSequence: event.sequence,
    updatedAt,
  };
}

function assertCommittedReceipt(
  result: { readonly receipt: EventConsumerReceipt; readonly cursor: ConsumerCursor },
  consumerKey: string,
  event: EventRecord,
): EventConsumerReceipt {
  if (result.receipt.consumerKey !== consumerKey || result.receipt.messageId !== event.messageId) {
    throw new EventConsumerError('journal consumer receipt identity mismatch');
  }
  if (result.receipt.streamId !== event.streamId || result.receipt.handledSequence !== event.sequence) {
    throw new EventConsumerError('journal consumer receipt delivery mismatch');
  }
  if (result.cursor.consumerKey !== consumerKey || result.cursor.streamId !== event.streamId) {
    throw new EventConsumerError('journal consumer cursor identity mismatch');
  }
  return result.receipt;
}

function assertCanonicalReceipt(
  receipt: EventConsumerReceipt,
  canonical: EventConsumerReceipt,
): void {
  if (
    receipt.consumerKey !== canonical.consumerKey
    || receipt.messageId !== canonical.messageId
    || receipt.streamId !== canonical.streamId
    || receipt.handledSequence !== canonical.handledSequence
    || receipt.disposition !== canonical.disposition
    || receipt.failureRef !== canonical.failureRef
    || receipt.effectRefs.length !== canonical.effectRefs.length
    || receipt.effectRefs.some((ref, index) => ref !== canonical.effectRefs[index])
  ) {
    throw new EventConsumerError('journal consumer receipt canonical mismatch');
  }
}

function assertCommittedCursor(
  result: { readonly cursor: ConsumerCursor },
  consumerKey: string,
  event: EventRecord,
): void {
  if (result.cursor.consumerKey !== consumerKey || result.cursor.streamId !== event.streamId) {
    throw new EventConsumerError('journal consumer cursor identity mismatch');
  }
  if (result.cursor.lastHandledSequence < event.sequence) {
    throw new EventConsumerError('journal consumer cursor did not advance');
  }
}

async function commitTerminalReceipt(
  ports: EventBusPorts,
  consumerKey: string,
  event: EventRecord,
  disposition: 'stale' | 'rejected' | 'terminal-failure',
  updatedAt: string,
  failureRef: string,
  canonical?: EventConsumerReceipt,
): Promise<ConsumerProcessResult['committed'][number]> {
  const receipt = makeReceipt(consumerKey, event, disposition, [], failureRef);
  const commit: ConsumerCommitRequest = {
    receipt: canonical ?? receipt,
    cursor: cursorFor(event, consumerKey, updatedAt),
    completionMode: 'journal-atomic',
    internalEffectFacts: [],
    externalOperationRefs: [],
  };
  const result = await ports.journal.commitConsumerCommit(commit);
  if (canonical) {
    assertCanonicalReceipt(result.receipt, canonical);
    assertCommittedCursor(result, consumerKey, event);
    return receipt;
  }
  return assertCommittedReceipt(result, consumerKey, event);
}

async function commitDuplicateReceipt(
  ports: EventBusPorts,
  consumerKey: string,
  event: EventRecord,
  existing: EventConsumerReceipt,
  updatedAt: string,
): Promise<ConsumerProcessResult['committed'][number]> {
  const receipt = makeReceipt(consumerKey, event, 'duplicate', existing.effectRefs, existing.failureRef);
  const commit: ConsumerCommitRequest = {
    receipt: existing,
    cursor: cursorFor(event, consumerKey, updatedAt),
    completionMode: 'journal-atomic',
    internalEffectFacts: [],
    externalOperationRefs: [],
  };
  const result = await ports.journal.commitConsumerCommit(commit);
  assertCanonicalReceipt(result.receipt, existing);
  assertCommittedCursor(result, consumerKey, event);
  return receipt;
}

async function commitExhaustedReceipt(
  ports: EventBusPorts,
  consumer: EventConsumerBinding,
  event: EventRecord,
  obligation: EventRetryObligation,
  updatedAt: string,
): Promise<{
  readonly receipt: ConsumerProcessResult['committed'][number];
  readonly dlq: EventDlqRecord;
}> {
  const existingDlq = await ports.journal.readDlq({
    streamId: event.streamId,
    consumerKey: consumer.consumerKey,
    messageId: event.messageId,
  });
  const dlq = existingDlq ?? await ports.journal.commitDlq({
    retryKey: obligation.retryKey,
    consumerKey: obligation.consumerKey,
    messageId: obligation.messageId,
    streamId: obligation.streamId,
    failedSequence: obligation.failedSequence,
    attempt: obligation.attempt,
    ownerRef: obligation.ownerRef,
    failureRef: obligation.failureRef,
    state: 'open',
    recordedAt: updatedAt,
    nextAction: { kind: 'recover', ref: obligation.ownerRef },
  });
  const receipt = await commitTerminalReceipt(
    ports,
    consumer.consumerKey,
    event,
    'terminal-failure',
    updatedAt,
    obligation.failureRef,
  );
  return { receipt, dlq };
}

async function commitHandlerIntent(
  ports: EventBusPorts,
  consumerKey: string,
  event: EventRecord,
  intent: EventHandlerCommitIntent,
  updatedAt: string,
): Promise<ConsumerProcessResult['committed'][number]> {
  const receipt = makeReceipt(consumerKey, event, intent.disposition, effectRefs(intent), intent.failureRef);
  const commit: ConsumerCommitRequest = {
    receipt,
    cursor: cursorFor(event, consumerKey, updatedAt),
    completionMode: intent.completionMode,
    internalEffectFacts: intent.internalEffectFacts,
    externalOperationRefs: intent.externalOperationRefs,
  };
  const result = await ports.journal.commitConsumerCommit(commit);
  return assertCommittedReceipt(result, consumerKey, event);
}

async function commitRetry(
  ports: EventBusPorts,
  consumer: EventConsumerBinding,
  event: EventRecord,
  retry: EventHandlerRetryIntent,
  updatedAt: string,
): Promise<{
  readonly retry?: EventRetryObligation;
  readonly receipt?: EventConsumerReceipt;
  readonly dlq?: EventDlqRecord;
}> {
  const obligation = retry.retryObligation;
  if (obligation.attempt < consumer.retryLimit) {
    const saved = await ports.journal.commitRetryObligation({
      ...obligation,
      state: 'pending',
    });
    return { retry: saved };
  }

  const exhausted = await ports.journal.commitRetryObligation({
    ...obligation,
    state: 'exhausted',
  });
  const existingDlq = await ports.journal.readDlq({
    streamId: event.streamId,
    consumerKey: consumer.consumerKey,
    messageId: event.messageId,
  });
  const dlq = existingDlq ?? await ports.journal.commitDlq({
    retryKey: exhausted.retryKey,
    consumerKey: exhausted.consumerKey,
    messageId: exhausted.messageId,
    streamId: exhausted.streamId,
    failedSequence: exhausted.failedSequence,
    attempt: exhausted.attempt,
    ownerRef: exhausted.ownerRef,
    failureRef: exhausted.failureRef,
    state: 'open',
    recordedAt: updatedAt,
    nextAction: { kind: 'recover', ref: exhausted.ownerRef },
  });
  const receipt = await commitTerminalReceipt(
    ports,
    consumer.consumerKey,
    event,
    'terminal-failure',
    updatedAt,
    exhausted.failureRef,
  );
  return { receipt, dlq };
}

async function deliverToHandler(
  ports: EventBusPorts,
  consumer: EventConsumerBinding,
  event: EventRecord,
  attempt: number,
  retryKeyValue: string | undefined,
  handler: EventConsumerHandler,
  updatedAt: string,
): Promise<{
  readonly receipt?: ConsumerProcessResult['committed'][number];
  readonly retry?: EventRetryObligation;
  readonly dlq?: EventDlqRecord;
  readonly blocked?: EventOperationBlocked;
}> {
  const commit = await handler({ event, attempt, retryKey: retryKeyValue });
  if (isRetryIntent(commit)) {
    assertRetryIntent(consumer, event, commit, attempt);
    return commitRetry(ports, consumer, event, commit, updatedAt);
  }
  const blocked = await assertCommitIntent(ports, consumer, event, commit);
  if (blocked) return { blocked };
  return { receipt: await commitHandlerIntent(ports, consumer.consumerKey, event, commit, updatedAt) };
}

async function processEvent(
  ports: EventBusPorts,
  consumer: EventConsumerBinding,
  event: EventRecord,
  handler: EventConsumerHandler,
  updatedAt: string,
): Promise<{
  readonly receipt?: ConsumerProcessResult['committed'][number];
  readonly retry?: EventRetryObligation;
  readonly dlq?: EventDlqRecord;
  readonly blocked?: EventOperationBlocked;
}> {
  const decision = decideConsumerDelivery(consumer, event);
  if (!decision.deliver) {
    const existingReceipt = await ports.journal.readReceipt({
      consumerKey: consumer.consumerKey,
      messageId: event.messageId,
    });
    return {
      receipt: await commitTerminalReceipt(
        ports,
        consumer.consumerKey,
        event,
        decision.disposition,
        updatedAt,
        decision.failureRef,
        existingReceipt ?? undefined,
      ),
    };
  }

  const existingReceipt = await ports.journal.readReceipt({
    consumerKey: consumer.consumerKey,
    messageId: event.messageId,
  });
  if (existingReceipt) {
    return {
      receipt: await commitDuplicateReceipt(ports, consumer.consumerKey, event, existingReceipt, updatedAt),
    };
  }

  const obligation = await ports.journal.readRetryObligation({
    streamId: event.streamId,
    consumerKey: consumer.consumerKey,
    messageId: event.messageId,
  });
  if (obligation?.state === 'exhausted') {
    return commitExhaustedReceipt(ports, consumer, event, obligation, updatedAt);
  }
  if (obligation?.state === 'cancelled') {
    return {
      receipt: await commitTerminalReceipt(
        ports,
        consumer.consumerKey,
        event,
        'rejected',
        updatedAt,
        obligation.failureRef,
      ),
    };
  }
  if (obligation && Date.parse(obligation.nextAttemptAt) > Date.parse(updatedAt)) {
    return { retry: obligation };
  }
  return deliverToHandler(
    ports,
    consumer,
    event,
    obligation ? obligation.attempt + 1 : 1,
    obligation?.retryKey,
    handler,
    updatedAt,
  );
}

export async function consumeEvents(
  ports: EventBusPorts,
  input: ConsumeEventsInput,
  handler: EventConsumerHandler,
): Promise<ConsumerProcessResult>;
export async function consumeEvents(
  ports: EventBusPorts,
  input: ConsumeEventsInput,
  handler: EventConsumerHandler,
): Promise<ConsumerProcessResult> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new EventConsumerError('consumer limit must be positive');
  const updatedAt = nowIso(input.now);
  const consumer = await readConsumer(ports, input.consumerKey);
  const committed: ConsumerProcessResult['committed'][number][] = [];
  const retries: EventRetryObligation[] = [];
  const dlq: EventDlqRecord[] = [];
  const blocked: EventOperationBlocked[] = [];
  const cursors: ConsumerCursor[] = [];
  const seen = new Set<string>();
  let remaining = input.limit;

  streamLoop: for (const streamId of consumer.streamIds) {
    if (remaining < 1) break;
    const cursor = await readCursor(ports, streamId, consumer.consumerKey);
    const events = await ports.journal.readEvents({
      streamId,
      afterSequence: cursor?.lastHandledSequence ?? 0,
      limit: remaining,
    });
    eventLoop: for (const event of events) {
      if (remaining < 1) break;
      const key = receiptKey(event.streamId, consumer.consumerKey, event.messageId);
      if (seen.has(key)) {
        const receipt = await ports.journal.readReceipt({
          consumerKey: consumer.consumerKey,
          messageId: event.messageId,
        });
        if (!receipt) continue;
        const duplicate = await commitDuplicateReceipt(ports, consumer.consumerKey, event, receipt, updatedAt);
        committed.push(duplicate);
        cursors.push(cursorFor(event, consumer.consumerKey, updatedAt));
        remaining -= 1;
        continue;
      }
      seen.add(key);
      const result = await processEvent(ports, consumer, event, handler, updatedAt);
      if (result.receipt) committed.push(result.receipt);
      if (result.retry) retries.push(result.retry);
      if (result.dlq) dlq.push(result.dlq);
      if (result.blocked) {
        blocked.push(result.blocked);
        break streamLoop;
      }
      if (!result.retry || result.receipt || result.dlq) {
        cursors.push(cursorFor(event, consumer.consumerKey, updatedAt));
        remaining -= 1;
      } else {
        break eventLoop;
      }
    }
  }

  return {
    consumerKey: consumer.consumerKey,
    committed,
    retries,
    dlq,
    blocked,
    cursors,
  };
}
