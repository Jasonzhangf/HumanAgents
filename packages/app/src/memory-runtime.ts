import { join } from 'node:path';
import type { RuntimePaths, LoadedConfiguration } from '../../config/src/index.js';
import type {
  EventConsumerBinding,
  EventBusPorts,
  TrustedEventPublisher,
} from '../../runtime/src/events/index.js';
import { consumeEvents, publishEvent } from '../../runtime/src/events/index.js';
import type { Checkpoint, EvidenceRef, ScopeRef } from '../../contracts/src/index.js';
import type { MemoryAnalysisWakeBinding } from '../../runtime/src/memory/index.js';
import { createJsonlEventJournal, type JsonlEventJournal } from './event-journal.js';
import {
  checkpointEvidenceDigest,
  checkpointEvidenceLocator,
  readCheckpointEvidence,
  readCommittedCheckpoint,
} from './checkpoint-journal.js';
import { composeMemory, type MemoryComposition, type MemoryCompositionInput } from './memory-composition.js';
import { AppLifecycleError } from './errors.js';

const OWNER = 'humanagent.app.memory-runtime';
const PUBLISHER_ID = 'memory-boundary-publisher';

export interface MemoryRuntimeInput extends Omit<MemoryCompositionInput, 'paths' | 'projectKey'> {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
}

export interface MemoryRuntime {
  readonly composition: MemoryComposition;
  readonly journal: JsonlEventJournal;
  readonly ports: EventBusPorts;
  readonly publisher: {
    publish(input: {
      readonly event: ReturnType<typeof import('../../runtime/src/memory/index.js').createMemoryAnalysisRequestedEvent>;
      readonly checkpoint: Checkpoint;
      readonly recordDigest: string;
    }): Promise<void>;
  };
  consume(input?: { readonly limit?: number }): Promise<Awaited<ReturnType<typeof consumeEvents>>>;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

function sameEvidence(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.locator === right.locator
    && left.digest === right.digest
    && sameScope(left.scope, right.scope);
}

function validateMemoryBoundary(input: {
  readonly event: ReturnType<typeof import('../../runtime/src/memory/index.js').createMemoryAnalysisRequestedEvent>;
  readonly recordDigest: string;
  readonly committed: { readonly checkpoint: Checkpoint; readonly recordDigest: string };
}): void {
  const expectedEvidence: EvidenceRef = {
    evidenceId: input.event.evidenceRefs[0]!.evidenceId,
    kind: 'operation',
    source: 'humanagent.app.run-operation',
    locator: checkpointEvidenceLocator(input.committed.checkpoint),
    digest: checkpointEvidenceDigest(input.committed.checkpoint),
    scope: input.committed.checkpoint.scope,
  };
  if (!sameScope(input.event.scope, input.committed.checkpoint.scope)) {
    throw new AppLifecycleError(
      'memory-boundary-scope-mismatch',
      'memory analysis event scope does not match the committed checkpoint',
      'publish the boundary from the authoritative checkpoint owner',
      OWNER,
    );
  }
  if (input.event.evidenceRefs.length !== 1 || !sameEvidence(input.event.evidenceRefs[0]!, expectedEvidence)) {
    throw new AppLifecycleError(
      'memory-boundary-evidence-mismatch',
      'memory analysis event evidence does not match the committed checkpoint',
      'rebuild the event from the committed checkpoint evidence',
      OWNER,
    );
  }
  if (input.recordDigest !== input.committed.recordDigest) {
    throw new AppLifecycleError(
      'memory-boundary-digest-mismatch',
      'memory analysis record digest does not match the committed checkpoint record',
      'publish the boundary with the authoritative checkpoint record digest',
      OWNER,
    );
  }
}

function consumerBinding(binding: MemoryAnalysisWakeBinding): EventConsumerBinding {
  const scopeRef = binding.interactionScopeId === undefined
    ? `memory:${binding.projectKey}:${binding.scope.organId.value}:${binding.taskId!.value}`
    : `memory:${binding.projectKey}:interaction:${binding.interactionScopeId}`;
  const streamId = binding.interactionScopeId === undefined
    ? `memory-boundaries:${binding.taskId!.value}`
    : `memory-boundaries:interaction:${binding.interactionScopeId}`;
  return {
    consumerKey: binding.bindingRef,
    consumerOwner: 'memory-agent',
    scopeRef,
    contractVersion: 'memory-analysis-v1',
    scope: {
      organId: binding.scope.organId,
      ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }),
    },
    streamIds: [streamId],
    allowedClasses: ['data'],
    retryLimit: 3,
    currentEpoch: binding.executionEpoch,
  };
}

function publisherBinding(binding: MemoryAnalysisWakeBinding): TrustedEventPublisher {
  return {
    publisherId: PUBLISHER_ID,
    kind: 'harness',
    ownerId: OWNER,
    scope: {
      organId: binding.scope.organId,
      ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }),
    },
    allowedClasses: ['data'],
    capabilities: ['memory.analysis.requested'],
  };
}

export async function composeMemoryRuntime(input: MemoryRuntimeInput): Promise<MemoryRuntime> {
  const checkpointFile = join(input.paths.journalRoot, 'checkpoints.jsonl');
  const journal = createJsonlEventJournal({
    filePath: join(input.paths.journalRoot, 'events.jsonl'),
  });
  const composition = await composeMemory({
    ...input,
    paths: input.paths,
    projectKey: input.paths.projectKey,
    evidenceSource: input.evidenceSource ?? {
      read: async ({ evidence }) => readCheckpointEvidence({
        filePath: checkpointFile,
        scope: evidence.scope,
        evidence,
      }),
    },
    externalOperations: journal,
    state: journal,
  });
  const publisher = publisherBinding(input.binding);
  const consumer = consumerBinding(input.binding);
  const registry = {
    resolvePublisher: async (publisherId: string) => publisherId === publisher.publisherId ? publisher : null,
    resolveConsumer: async (consumerKey: string) => consumerKey === consumer.consumerKey ? consumer : null,
  };
  const ports: EventBusPorts = {
    journal,
    publishers: registry,
    consumers: registry,
    externalOperations: journal,
    barrierIntents: journal,
  };
  return {
    composition,
    journal,
    ports,
    publisher: {
      publish: async ({ event, checkpoint, recordDigest }) => {
        const committed = await readCommittedCheckpoint({
          filePath: checkpointFile,
          scope: checkpoint.scope,
          checkpointId: checkpoint.id,
        });
        validateMemoryBoundary({ event, recordDigest, committed });
        await publishEvent(ports, { publisherId: PUBLISHER_ID, event });
      },
    },
    consume: async (consumeInput = {}) => consumeEvents(
      ports,
      {
        consumerKey: input.binding.bindingRef,
        limit: consumeInput.limit ?? 10,
      },
      composition.eventHandler,
      composition.barrierDriver,
    ),
  };
}
