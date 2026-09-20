import { createHash } from 'node:crypto';
import {
  JsonlOrganJournal,
  JournalIntegrityError,
  type JournalRecord,
} from '../../adapters/jsonl/src/index.js';
import {
  eventIdentityKey,
  type AppendEventRequest,
  type ConsumerCommitRequest,
  type ConsumerCommitResult,
  type ConsumerCursor,
  type EventConsumerReceipt,
  type EventDlqRecord,
  type EventExternalOperation,
  type EventExternalOperationPort,
  type EventJournalPort,
  type EventRecord,
  type EventRetryObligation,
  type ReadEventInput,
  type ReadEventsInput,
  type ReadCursorInput,
  type ReadExternalOperationInput,
  type ReadReceiptInput,
  type ReadRetryObligationInput,
  type ListPendingRetryObligationsInput,
} from '../../runtime/src/events/index.js';
import { id, type MemoryAgentStatePort, type ScopeRef } from '../../contracts/src/index.js';
import type { EventBarrierIntent, EventBarrierIntentPort } from '../../runtime/src/events/coordinator.js';
import { publishOperationEvent, type OperationEventNotificationPort, type PublishOperationEventInput, type OperationEventPublicationReceipt } from '../../runtime/src/events/operation-publication.js';
import type { EventPublisherRegistryPort } from '../../runtime/src/events/ports.js';
import { AppLifecycleError } from './errors.js';

const OWNER = 'humanagent.app.event-journal';
const CONTROL_SCOPE: ScopeRef = { organId: id('organ', 'humanagent-event-bus') };

type PersistedKind =
  | 'event'
  | 'consumer-commit'
  | 'retry'
  | 'dlq'
  | 'external-operation'
  | 'barrier-intent'
  | 'memory-agent-state';

interface PersistedRecord {
  readonly type: PersistedKind;
  readonly event?: EventRecord;
  readonly commit?: ConsumerCommitRequest;
  readonly result?: ConsumerCommitResult;
  readonly retry?: EventRetryObligation;
  readonly dlq?: EventDlqRecord;
  readonly externalOperation?: EventExternalOperation;
  readonly barrierIntent?: EventBarrierIntent;
  readonly memoryAgentState?: unknown;
}

export interface JsonlEventJournal
  extends EventJournalPort, EventExternalOperationPort, EventBarrierIntentPort, MemoryAgentStatePort {
  commitExternalOperation(operation: EventExternalOperation): Promise<EventExternalOperation>;
}

export interface JsonlOperationEventPublicationInput {
  readonly journal: JsonlEventJournal;
  readonly publishers: EventPublisherRegistryPort;
  readonly notification: OperationEventNotificationPort;
}

/** Application entry for operation events; it reuses the existing shared event journal. */
export function publishJsonlOperationEvent(
  input: JsonlOperationEventPublicationInput,
  event: PublishOperationEventInput,
): Promise<OperationEventPublicationReceipt> {
  return publishOperationEvent(
    { journal: input.journal, publishers: input.publishers },
    input.notification,
    event,
  );
}

function commitId(kind: PersistedKind, identity: string): string {
  return `${kind}:${createHash('sha256').update(identity).digest('hex')}`;
}

function recordIdentity(record: Pick<EventRecord, 'streamId' | 'messageId'>): string {
  return eventIdentityKey(record.streamId, 'event', record.messageId);
}

function assertPersisted(value: unknown): PersistedRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JournalIntegrityError('event journal record payload is invalid');
  }
  const record = value as PersistedRecord;
  if (![
    'event',
    'consumer-commit',
    'retry',
    'dlq',
    'external-operation',
    'barrier-intent',
    'memory-agent-state',
  ].includes(record.type)) {
    throw new JournalIntegrityError('event journal record type is invalid');
  }
  if (record.type === 'event' && record.event === undefined) {
    throw new JournalIntegrityError('event journal event record is missing');
  }
  if (record.type === 'consumer-commit' && (record.commit === undefined || record.result === undefined)) {
    throw new JournalIntegrityError('event journal consumer commit is incomplete');
  }
  if (record.type === 'retry' && record.retry === undefined) {
    throw new JournalIntegrityError('event journal retry record is missing');
  }
  if (record.type === 'dlq' && record.dlq === undefined) {
    throw new JournalIntegrityError('event journal dlq record is missing');
  }
  if (record.type === 'external-operation' && record.externalOperation === undefined) {
    throw new JournalIntegrityError('event journal external operation is missing');
  }
  if (record.type === 'barrier-intent' && record.barrierIntent === undefined) {
    throw new JournalIntegrityError('event journal barrier intent is missing');
  }
  if (record.type === 'memory-agent-state' && record.memoryAgentState === undefined) {
    throw new JournalIntegrityError('event journal memory agent state is missing');
  }
  return record;
}

function payloadRecord(record: JournalRecord): PersistedRecord {
  if (record.kind !== 'event' || record.payload === undefined) {
    throw new JournalIntegrityError('event journal contains a non-event record');
  }
  return assertPersisted(record.payload);
}

function trustedEvent(record: JournalRecord): EventRecord {
  const persisted = payloadRecord(record);
  if (persisted.type !== 'event' || persisted.event === undefined) {
    throw new AppLifecycleError(
      'event-journal-corrupt',
      'event journal transaction returned a non-event record',
      'preserve the event journal and inspect the committed record',
      OWNER,
    );
  }
  return persisted.event;
}

function wrapError(error: unknown): never {
  if (error instanceof JournalIntegrityError) {
    throw new AppLifecycleError(
      'event-journal-corrupt',
      error.message,
      'preserve the event journal and repair its committed history before retrying',
      OWNER,
    );
  }
  throw error;
}

export function createJsonlEventJournal(input: { readonly filePath: string }): JsonlEventJournal {
  if (!input.filePath.trim()) {
    throw new AppLifecycleError(
      'event-journal-path-invalid',
      'event journal path is required',
      'provide the event journal path under the HumanAgent control root',
      OWNER,
    );
  }
  const filePath = input.filePath;
  const journal = new JsonlOrganJournal(filePath);

  async function records(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new AppLifecycleError(
        'event-journal-corrupt',
        verification.error ?? 'event journal is invalid',
        'preserve the event journal and repair its committed history before retrying',
        OWNER,
      );
    }
    return verification.records;
  }

  async function appendPersisted(
    kind: PersistedKind,
    identity: string,
    payload: PersistedRecord,
    scope: ScopeRef = CONTROL_SCOPE,
  ): Promise<void> {
    try {
      await journal.append({
        commitId: commitId(kind, identity),
        kind: 'event',
        scope,
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (error) {
      wrapError(error);
    }
  }

  return {
    async readMemoryAgentState(): Promise<unknown | undefined> {
      const all = await records();
      for (const record of [...all].reverse()) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type === 'memory-agent-state') return persisted.memoryAgentState;
      }
      return undefined;
    },

    async appendMemoryAgentState(input): Promise<void> {
      await appendPersisted(
        'memory-agent-state',
        input.commitId,
        { type: 'memory-agent-state', memoryAgentState: input.state },
      );
    },

    async appendEvent(input: AppendEventRequest): Promise<EventRecord> {
      try {
        return await journal.transaction<
          { readonly event: EventRecord; readonly append: boolean },
          EventRecord
        >(({ records: all }) => {
          const existingRecord = all.find((record) =>
            record.kind === 'event'
            && payloadRecord(record).type === 'event'
            && payloadRecord(record).event?.streamId === input.event.streamId
            && payloadRecord(record).event?.messageId === input.event.messageId);
          if (existingRecord) {
            const existing = trustedEvent(existingRecord);
            const expected = {
              ...input.event,
              publisherId: input.publisherId,
              sequence: existing.sequence,
              committedAt: existing.committedAt,
            };
            if (existing.publisherId !== input.publisherId || JSON.stringify(existing) !== JSON.stringify(expected)) {
              throw new AppLifecycleError(
                'event-journal-conflict',
                `event identity conflicts with committed history: ${input.event.messageId}`,
                'use a new message id for a different event',
                OWNER,
              );
            }
            return { event: existing, append: false };
          }
          const prior = all
            .filter((record) => record.kind === 'event' && payloadRecord(record).type === 'event')
            .map((record) => trustedEvent(record))
            .filter((event) => event.streamId === input.event.streamId)
            .sort((left, right) => left.sequence - right.sequence);
          return {
            event: {
              ...input.event,
              publisherId: input.publisherId,
              sequence: (prior.at(-1)?.sequence ?? 0) + 1,
              committedAt: new Date().toISOString(),
            },
            append: true,
          };
        }, async (plan, append) => {
          if (!plan.append) return plan.event;
          const appended = await append({
            commitId: commitId('event', recordIdentity(plan.event)),
            kind: 'event',
            scope: plan.event.scope,
            payload: {
              type: 'event',
              event: plan.event,
            } as unknown as Record<string, unknown>,
          });
          return trustedEvent(appended);
        });
      } catch (error) {
        wrapError(error);
      }
    },

    async readEvents(input: ReadEventsInput): Promise<readonly EventRecord[]> {
      const all = await records();
      return all
        .filter((record) => record.kind === 'event' && payloadRecord(record).type === 'event')
        .map((record) => payloadRecord(record).event!)
        .filter((event) => event.streamId === input.streamId)
        .sort((left, right) => left.sequence - right.sequence)
        .filter((event) => event.sequence > input.afterSequence)
        .slice(0, input.limit);
    },

    async readEvent(input: ReadEventInput): Promise<EventRecord | null> {
      const events = await this.readEvents({
        streamId: input.streamId,
        afterSequence: 0,
        limit: Number.MAX_SAFE_INTEGER,
      });
      return events.find((event) => event.messageId === input.messageId) ?? null;
    },

    async readCursor(input: ReadCursorInput): Promise<ConsumerCursor | null> {
      const all = await records();
      for (const record of [...all].reverse()) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type !== 'consumer-commit' || persisted.result === undefined) continue;
        if (
          persisted.result.cursor.streamId === input.streamId
          && persisted.result.cursor.consumerKey === input.consumerKey
        ) {
          return persisted.result.cursor;
        }
      }
      return null;
    },

    async commitConsumerCommit(input: ConsumerCommitRequest): Promise<ConsumerCommitResult> {
      try {
        return await journal.transaction<
          { readonly result: ConsumerCommitResult; readonly append: boolean; readonly identity: string },
          ConsumerCommitResult
        >(({ records: all }) => {
          let existingReceipt: EventConsumerReceipt | null = null;
          let existingCursor: ConsumerCursor | null = null;
          for (const record of [...all].reverse()) {
            if (record.kind !== 'event') continue;
            const persisted = payloadRecord(record);
            if (persisted.type !== 'consumer-commit' || persisted.result === undefined) continue;
            if (
              existingReceipt === null
              && persisted.result.receipt.streamId === input.receipt.streamId
              && persisted.result.receipt.consumerKey === input.receipt.consumerKey
              && persisted.result.receipt.messageId === input.receipt.messageId
            ) {
              existingReceipt = persisted.result.receipt;
            }
            if (
              existingCursor === null
              && persisted.result.cursor.streamId === input.cursor.streamId
              && persisted.result.cursor.consumerKey === input.cursor.consumerKey
            ) {
              existingCursor = persisted.result.cursor;
            }
            if (existingReceipt !== null && existingCursor !== null) break;
          }
          if (existingReceipt !== null && existingCursor !== null && existingCursor.lastHandledSequence >= input.cursor.lastHandledSequence) {
            return { result: { receipt: existingReceipt, cursor: existingCursor }, append: false, identity: '' };
          }
          const cursor = existingCursor !== null && existingCursor.lastHandledSequence > input.cursor.lastHandledSequence
            ? existingCursor
            : input.cursor;
          return {
            result: {
              receipt: existingReceipt ?? input.receipt,
              cursor,
            },
            append: true,
            identity: existingReceipt === null
              ? `${input.receipt.streamId}:${input.receipt.consumerKey}:${input.receipt.messageId}`
              : `${input.receipt.streamId}:${input.receipt.consumerKey}:${input.receipt.messageId}:${input.cursor.lastHandledSequence}`,
          };
        }, async (plan, append) => {
          if (!plan.append) return plan.result;
          await append({
            commitId: commitId('consumer-commit', plan.identity),
            kind: 'event',
            scope: CONTROL_SCOPE,
            payload: {
              type: 'consumer-commit',
              commit: input,
              result: plan.result,
            } as unknown as Record<string, unknown>,
          });
          return plan.result;
        });
      } catch (error) {
        wrapError(error);
      }
    },

    async readReceipt(input: ReadReceiptInput): Promise<EventConsumerReceipt | null> {
      const all = await records();
      for (const record of [...all].reverse()) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type !== 'consumer-commit' || persisted.result === undefined) continue;
        const receipt = persisted.result.receipt;
        if (receipt.consumerKey === input.consumerKey && receipt.messageId === input.messageId) {
          return receipt;
        }
      }
      return null;
    },

    async commitRetryObligation(obligation: EventRetryObligation): Promise<EventRetryObligation> {
      await appendPersisted(
        'retry',
        `${obligation.streamId}:${obligation.consumerKey}:${obligation.messageId}:${obligation.attempt}:${obligation.state}`,
        { type: 'retry', retry: obligation },
      );
      return obligation;
    },

    async readRetryObligation(input: ReadRetryObligationInput): Promise<EventRetryObligation | null> {
      const all = await records();
      for (const record of [...all].reverse()) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type !== 'retry' || persisted.retry === undefined) continue;
        if (
          persisted.retry.streamId === input.streamId
          && persisted.retry.consumerKey === input.consumerKey
          && persisted.retry.messageId === input.messageId
        ) {
          return persisted.retry;
        }
      }
      return null;
    },

    async listPendingRetryObligations(input: ListPendingRetryObligationsInput): Promise<readonly EventRetryObligation[]> {
      const all = await records();
      const latest = new Map<string, EventRetryObligation>();
      for (const record of all) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type !== 'retry' || persisted.retry === undefined) continue;
        latest.set(
          `${persisted.retry.streamId.length}:${persisted.retry.streamId}`
          + `${persisted.retry.consumerKey.length}:${persisted.retry.consumerKey}`
          + `${persisted.retry.messageId.length}:${persisted.retry.messageId}`,
          persisted.retry,
        );
      }
      return [...latest.values()]
        .filter((obligation) =>
          obligation.state === 'pending'
          && obligation.streamId === input.streamId
          && obligation.consumerKey === input.consumerKey)
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
        .slice(0, input.limit);
    },

    async commitDlq(record: EventDlqRecord): Promise<EventDlqRecord> {
      await appendPersisted(
        'dlq',
        `${record.streamId}:${record.consumerKey}:${record.messageId}`,
        { type: 'dlq', dlq: record },
      );
      return record;
    },

    async readDlq(input: ReadRetryObligationInput): Promise<EventDlqRecord | null> {
      const all = await records();
      for (const record of [...all].reverse()) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type !== 'dlq' || persisted.dlq === undefined) continue;
        if (
          persisted.dlq.streamId === input.streamId
          && persisted.dlq.consumerKey === input.consumerKey
          && persisted.dlq.messageId === input.messageId
        ) {
          return persisted.dlq;
        }
      }
      return null;
    },

    async readExternalOperation(input: ReadExternalOperationInput): Promise<EventExternalOperation | null> {
      const all = await records();
      for (const record of [...all].reverse()) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type !== 'external-operation' || persisted.externalOperation === undefined) continue;
        if (
          persisted.externalOperation.operationRef === input.operationRef
          && persisted.externalOperation.consumerKey === input.consumerKey
          && persisted.externalOperation.messageId === input.messageId
        ) {
          return persisted.externalOperation;
        }
      }
      return null;
    },

    async commitExternalOperation(operation: EventExternalOperation): Promise<EventExternalOperation> {
      try {
        return await journal.transaction<
          { readonly operation: EventExternalOperation; readonly append: boolean },
          EventExternalOperation
        >(({ records: all }) => {
          let existing: EventExternalOperation | undefined;
          for (const record of [...all].reverse()) {
            if (record.kind !== 'event') continue;
            const persisted = payloadRecord(record);
            if (persisted.type !== 'external-operation' || persisted.externalOperation === undefined) continue;
            if (persisted.externalOperation.operationRef === operation.operationRef) {
              existing = persisted.externalOperation;
              break;
            }
          }
          if (!existing) {
            if (operation.state !== 'pending' && operation.state !== 'settled') {
              throw new AppLifecycleError(
                'event-journal-conflict',
                `external operation cannot start in state ${operation.state}: ${operation.operationRef}`,
                'persist pending or settled before recording a terminal operation state',
                OWNER,
              );
            }
            return { operation, append: true };
          }
          const sameIdentity = existing.consumerKey === operation.consumerKey
            && existing.messageId === operation.messageId;
          if (!sameIdentity) {
            throw new AppLifecycleError(
              'event-journal-conflict',
              `external operation identity conflicts with committed history: ${operation.operationRef}`,
              'reconcile the existing operation before retrying',
              OWNER,
            );
          }
          if (existing.state === operation.state) {
            if (JSON.stringify(existing) !== JSON.stringify(operation)) {
              throw new AppLifecycleError(
                'event-journal-conflict',
                `external operation state conflicts with committed history: ${operation.operationRef}`,
                'reconcile the existing operation before retrying',
                OWNER,
              );
            }
            return { operation: existing, append: false };
          }
          if (operation.state === 'failed' && !operation.failureRef?.trim()) {
            throw new AppLifecycleError(
              'event-journal-conflict',
              `failed external operation requires a failure ref: ${operation.operationRef}`,
              'record the terminal failure owner before retrying',
              OWNER,
            );
          }
          const allowed = existing.state === 'pending'
            ? operation.state === 'settled' || operation.state === 'failed' || operation.state === 'unknown'
            : (existing.state === 'settled' || existing.state === 'unknown') && operation.state === 'reconciled';
          if (!allowed) {
            throw new AppLifecycleError(
              'event-journal-conflict',
              `external operation state cannot advance from ${existing.state} to ${operation.state}: ${operation.operationRef}`,
              'reconcile the existing operation before retrying',
              OWNER,
            );
          }
          return { operation, append: true };
        }, async (plan, append) => {
          if (!plan.append) return plan.operation;
          await append({
            commitId: commitId('external-operation', `${operation.operationRef}:${operation.state}`),
            kind: 'event',
            scope: CONTROL_SCOPE,
            payload: {
              type: 'external-operation',
              externalOperation: plan.operation,
            } as unknown as Record<string, unknown>,
          });
          return plan.operation;
        });
      } catch (error) {
        wrapError(error);
      }
    },

    async commitBarrierIntent(intent: EventBarrierIntent): Promise<EventBarrierIntent> {
      const all = await records();
      for (const record of [...all].reverse()) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type !== 'barrier-intent' || persisted.barrierIntent === undefined) continue;
        if (
          persisted.barrierIntent.streamId === intent.streamId
          && persisted.barrierIntent.consumerKey === intent.consumerKey
          && persisted.barrierIntent.messageId === intent.messageId
        ) {
          if (JSON.stringify(persisted.barrierIntent) !== JSON.stringify(intent)) {
            throw new AppLifecycleError(
              'event-journal-conflict',
              `barrier intent conflicts with committed history: ${intent.messageId}`,
              'reconcile the existing barrier intent before retrying',
              OWNER,
            );
          }
          return persisted.barrierIntent;
        }
      }
      await appendPersisted(
        'barrier-intent',
        `${intent.streamId}:${intent.consumerKey}:${intent.messageId}`,
        { type: 'barrier-intent', barrierIntent: intent },
      );
      return intent;
    },

    async readBarrierIntent(input: {
      readonly streamId: string;
      readonly consumerKey: string;
      readonly messageId: string;
    }): Promise<EventBarrierIntent | null> {
      const all = await records();
      for (const record of [...all].reverse()) {
        if (record.kind !== 'event') continue;
        const persisted = payloadRecord(record);
        if (persisted.type !== 'barrier-intent' || persisted.barrierIntent === undefined) continue;
        if (
          persisted.barrierIntent.streamId === input.streamId
          && persisted.barrierIntent.consumerKey === input.consumerKey
          && persisted.barrierIntent.messageId === input.messageId
        ) {
          return persisted.barrierIntent;
        }
      }
      return null;
    },
  };
}
