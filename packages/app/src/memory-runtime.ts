import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { RuntimePaths, LoadedConfiguration } from '../../config/src/index.js';
import type {
  EventConsumerBinding,
  EventBusPorts,
  TrustedEventPublisher,
} from '../../runtime/src/events/index.js';
import { consumeEvents, publishEvent } from '../../runtime/src/events/index.js';
import { id, type Checkpoint, type EvidenceRef, type ScopeRef } from '../../contracts/src/index.js';
import {
  createMemoryAnalysisRequestedEvent,
  createMemoryProjectSourceUpdatedEvent,
  type MemoryAnalysisTrigger,
  type MemoryAnalysisWakeBinding,
} from '../../runtime/src/memory/index.js';
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
  readonly checkpointEvidence?: MemoryRuntimeCheckpointEvidencePort;
}

export interface MemoryRuntimeCheckpointEvidencePort {
  readCommitted(input: {
    readonly checkpoint: Checkpoint;
  }): Promise<{ readonly checkpoint: Checkpoint; readonly recordDigest: string }>;
  readEvidence(input: {
    readonly evidence: EvidenceRef;
  }): Promise<{ readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }>;
}

export interface MemoryRuntimeBoundaryPublisher {
  publish(input: {
    readonly checkpoint: Checkpoint;
    readonly recordDigest: string;
    readonly trigger: MemoryAnalysisTrigger;
    readonly relatedCheckpoints?: readonly Checkpoint[];
  }): Promise<void>;
}

export interface MemoryRuntimeEventConsumer {
  consume(input?: { readonly limit?: number }): Promise<Awaited<ReturnType<typeof consumeEvents>>>;
}

export interface MemoryRuntime {
  readonly composition: MemoryComposition;
  readonly journal: JsonlEventJournal;
  readonly ports: EventBusPorts;
  readonly publisher: {
    publish(input: {
      readonly event: ReturnType<typeof createMemoryAnalysisRequestedEvent>;
      readonly checkpoint: Checkpoint;
      readonly recordDigest: string;
    }): Promise<void>;
  };
  readonly boundaryPublisher: MemoryRuntimeBoundaryPublisher;
  readonly consume: MemoryRuntimeEventConsumer['consume'];
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

function checkpointEvidenceRef(checkpoint: Checkpoint): EvidenceRef {
  return {
    evidenceId: id('evidence', `checkpoint-${checkpoint.id.value}`),
    kind: 'operation',
    source: OWNER,
    locator: checkpointEvidenceLocator(checkpoint),
    digest: checkpointEvidenceDigest(checkpoint),
    scope: checkpoint.scope,
  };
}

function containsScope(container: ScopeRef, candidate: ScopeRef): boolean {
  return container.organId.value === candidate.organId.value
    && (container.taskId === undefined || container.taskId.value === candidate.taskId?.value)
    && (container.cycleId === undefined || container.cycleId.value === candidate.cycleId?.value)
    && (container.operationId === undefined || container.operationId.value === candidate.operationId?.value);
}

function validateMemoryBoundary(input: {
  readonly event: ReturnType<typeof createMemoryAnalysisRequestedEvent>;
  readonly recordDigest: string;
  readonly committed: { readonly checkpoint: Checkpoint; readonly recordDigest: string };
}): void {
  const expectedEvidence: EvidenceRef = {
    evidenceId: input.event.evidenceRefs[0]!.evidenceId,
    kind: 'operation',
    source: input.event.evidenceRefs[0]!.source,
    locator: checkpointEvidenceLocator(input.committed.checkpoint),
    digest: checkpointEvidenceDigest(input.committed.checkpoint),
    scope: input.committed.checkpoint.scope,
  };
  if (!sameScope(input.event.scope, input.committed.checkpoint.scope)
    && !containsScope(input.event.scope, input.committed.checkpoint.scope)) {
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
    ...(binding.interactionScopeId === undefined ? { currentEpoch: binding.executionEpoch } : {}),
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
    capabilities: ['memory.analysis.requested', 'memory.project-source.updated'],
  };
}

export async function composeMemoryRuntime(input: MemoryRuntimeInput): Promise<MemoryRuntime> {
  await mkdir(input.auditPromptRoot, { recursive: true });
  const checkpointFile = join(input.paths.journalRoot, 'checkpoints.jsonl');
  const checkpointEvidence: MemoryRuntimeCheckpointEvidencePort = input.checkpointEvidence ?? {
    readCommitted: ({ checkpoint }) => readCommittedCheckpoint({
      filePath: checkpointFile,
      scope: checkpoint.scope,
      checkpointId: checkpoint.id,
    }),
    readEvidence: ({ evidence }) => readCheckpointEvidence({
      filePath: checkpointFile,
      scope: evidence.scope,
      evidence,
    }),
  };
  const journal = createJsonlEventJournal({
    filePath: join(input.paths.journalRoot, 'events.jsonl'),
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
  const projectSourceUpdatePublisher = {
    publish: async (update: {
      readonly receipt: import('../../runtime/src/memory/index.js').MemorySourceUpdateReceipt;
      readonly scope: ScopeRef;
      readonly executionEpoch: number;
      readonly occurredAt: string;
    }) => {
      const identity = JSON.stringify({
        projectKey: input.paths.projectKey,
        target: update.receipt.target,
        previousDigest: update.receipt.previousDigest,
        nextDigest: update.receipt.nextDigest,
        patchRef: update.receipt.patchRef,
        patchDigest: update.receipt.patchDigest,
      });
      const messageId = `memory-project-source-update-${createHash('sha256').update(identity).digest('hex')}`;
      const event = createMemoryProjectSourceUpdatedEvent({
        messageId,
        streamId: `memory-project-source-updates:${input.paths.projectKey}`,
        scope: update.scope,
        occurredAt: update.occurredAt,
        executionEpoch: update.executionEpoch,
        target: update.receipt.target,
        sourceRef: update.receipt.sourceRef,
        previousRevision: update.receipt.previousRevision,
        previousDigest: update.receipt.previousDigest,
        nextRevision: update.receipt.nextRevision,
        nextDigest: update.receipt.nextDigest,
        patchRef: update.receipt.patchRef,
        patchDigest: update.receipt.patchDigest,
        sourceEvidenceRefs: update.receipt.evidenceRefs,
      });
      await publishEvent(ports, { publisherId: PUBLISHER_ID, event });
    },
  };
  const composition = await composeMemory({
    ...input,
    paths: input.paths,
    projectKey: input.paths.projectKey,
    evidenceSource: input.evidenceSource ?? {
      read: async ({ evidence }) => checkpointEvidence.readEvidence({ evidence }),
    },
    externalOperations: journal,
    state: journal,
    projectSourceUpdatePublisher,
  });
  return {
    composition,
    journal,
    ports,
    publisher: {
      publish: async ({ event, checkpoint, recordDigest }) => {
        const committed = await checkpointEvidence.readCommitted({ checkpoint });
        validateMemoryBoundary({ event, recordDigest, committed });
        await publishEvent(ports, { publisherId: PUBLISHER_ID, event });
      },
    },
    boundaryPublisher: {
      publish: async ({ checkpoint, recordDigest, trigger, relatedCheckpoints = [] }) => {
        const committed = await checkpointEvidence.readCommitted({ checkpoint });
        const related = await Promise.all(relatedCheckpoints.map((candidate) =>
          checkpointEvidence.readCommitted({ checkpoint: candidate })));
        const primaryEvidence = checkpointEvidenceRef(committed.checkpoint);
        const event = createMemoryAnalysisRequestedEvent({
          messageId: `checkpoint-${committed.checkpoint.id.value}-${trigger}`,
          streamId: consumer.streamIds[0]!,
          scope: consumer.scope,
          occurredAt: new Date().toISOString(),
          summary: trigger === 'rewind' && related.length > 0
            ? `checkpoint ${committed.checkpoint.id.value} reentered at ${related[0]!.checkpoint.id.value}`
            : `checkpoint ${committed.checkpoint.outcome} for task ${committed.checkpoint.scope.taskId?.value ?? 'unknown'}`,
          evidenceRefs: [
            primaryEvidence,
            ...related.map((candidate) => checkpointEvidenceRef(candidate.checkpoint)),
          ],
          executionEpoch: committed.checkpoint.executionEpoch,
          trigger,
          requestedKind: trigger === 'rewind' ? 'procedural' : 'semantic',
          candidateCategory: trigger === 'rewind' ? 'project-experience' : 'project-fact',
          ...(trigger !== 'rewind'
            && input.binding.interactionScopeId === undefined
            && committed.checkpoint.scope.taskId
            ? { sessionRef: committed.checkpoint.scope.taskId.value }
            : {}),
        });
        validateMemoryBoundary({
          event: { ...event, evidenceRefs: [primaryEvidence] },
          recordDigest,
          committed,
        });
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
