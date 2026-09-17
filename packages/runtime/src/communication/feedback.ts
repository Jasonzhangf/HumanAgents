import {
  assertBusinessPayload,
  assertEvidenceRef,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import {
  assertPublisherCanPublish,
  validateEventEnvelope,
} from '../events/acl.js';
import { FeedbackPublicationError } from './errors.js';
import {
  M3_FEEDBACK_CLASS_BY_KIND,
  type FeedbackHubPorts,
  type FeedbackPublication,
  type M3FeedbackKind,
  type PublishedFeedback,
} from './types.js';

function requireReference(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new FeedbackPublicationError(`${label} is required`, {
      reason: 'event-envelope-invalid',
      nextAction: { kind: 'stop', ref: 'invalid-feedback-publication' },
    });
  }
  return value;
}

function scopeContains(container: ScopeRef, candidate: ScopeRef): boolean {
  if (container.organId.value !== candidate.organId.value) return false;
  if (container.taskId && container.taskId.value !== candidate.taskId?.value) return false;
  if (container.cycleId && container.cycleId.value !== candidate.cycleId?.value) return false;
  if (container.operationId && container.operationId.value !== candidate.operationId?.value) return false;
  return true;
}

function assertFeedbackPublication(input: FeedbackPublication): void {
  requireReference(input.publisherId, 'publisherId');
  if (!M3_FEEDBACK_CLASS_BY_KIND[input.kind]) {
    throw new FeedbackPublicationError(`unknown M3 feedback kind: ${String(input.kind)}`, {
      reason: 'event-envelope-invalid',
      nextAction: { kind: 'stop', ref: 'invalid-feedback-publication' },
      evidenceRefs: input.event.evidenceRefs,
    });
  }
  const expectedClass = M3_FEEDBACK_CLASS_BY_KIND[input.kind];
  if (input.event.class !== expectedClass) {
    throw new FeedbackPublicationError(
      `feedback kind ${input.kind} requires ${expectedClass} event class`,
      {
        reason: 'feedback-class-mismatch',
        nextAction: { kind: 'stop', ref: 'feedback-class-mismatch' },
        evidenceRefs: input.event.evidenceRefs,
      },
    );
  }
  try {
    validateEventEnvelope(input.event);
  } catch (error) {
    throw new FeedbackPublicationError('feedback event envelope is invalid', {
      reason: 'event-envelope-invalid',
      nextAction: { kind: 'stop', ref: 'invalid-feedback-event-envelope' },
      evidenceRefs: input.event.evidenceRefs,
      cause: error,
    });
  }
  if (input.event.payload !== undefined) {
    try {
      assertBusinessPayload(input.event.payload);
    } catch (error) {
      throw new FeedbackPublicationError('control truth leaked into feedback payload', {
        reason: 'control-truth-in-payload',
        nextAction: { kind: 'stop', ref: 'control-truth-in-payload' },
        evidenceRefs: input.event.evidenceRefs,
        cause: error,
      });
    }
  }
  for (const evidenceRef of input.event.evidenceRefs) {
    try {
      assertEvidenceRef(evidenceRef);
    } catch (error) {
      throw new FeedbackPublicationError('feedback evidence is invalid', {
        reason: 'event-envelope-invalid',
        nextAction: { kind: 'stop', ref: 'invalid-feedback-event-envelope' },
        evidenceRefs: input.event.evidenceRefs,
        cause: error,
      });
    }
    if (!scopeContains(input.event.scope, evidenceRef.scope)) {
      throw new FeedbackPublicationError('feedback evidence exceeds event scope', {
        reason: 'evidence-scope-denied',
        nextAction: { kind: 'stop', ref: 'feedback-evidence-scope-denied' },
        evidenceRefs: input.event.evidenceRefs,
      });
    }
  }
}

export class FeedbackHub {
  constructor(private readonly ports: FeedbackHubPorts) {}

  async publish(input: FeedbackPublication): Promise<PublishedFeedback> {
    assertFeedbackPublication(input);
    const publisher = await this.ports.publishers.resolvePublisher(input.publisherId);
    if (!publisher || publisher.publisherId !== input.publisherId) {
      throw new FeedbackPublicationError('feedback publisher is not trusted', {
        ownerRef: input.publisherId,
        reason: 'publisher-not-trusted',
        nextAction: { kind: 'stop', ref: 'feedback-publisher-not-trusted' },
        evidenceRefs: input.event.evidenceRefs,
      });
    }
    try {
      assertPublisherCanPublish(publisher, input.event);
    } catch (error) {
      const controlDenied = input.event.class === 'control' && publisher.kind !== 'harness';
      throw new FeedbackPublicationError('publisher is not allowed to publish feedback event', {
        ownerRef: publisher.ownerId,
        reason: controlDenied ? 'control-requires-harness-publisher' : 'publisher-denied',
        nextAction: {
          kind: 'stop',
          ref: controlDenied ? 'feedback-control-publisher-denied' : 'feedback-publisher-denied',
        },
        evidenceRefs: input.event.evidenceRefs,
        cause: error,
      });
    }

    let record;
    try {
      record = await this.ports.journal.appendEvent({
        event: input.event,
        publisherId: publisher.publisherId,
      });
    } catch (error) {
      throw new FeedbackPublicationError('feedback event append failed', {
        ownerRef: publisher.ownerId,
        reason: 'journal-append-failed',
        nextAction: { kind: 'recover', ref: publisher.ownerId },
        evidenceRefs: input.event.evidenceRefs,
        cause: error,
      });
    }
    if (record.messageId !== input.event.messageId || record.streamId !== input.event.streamId) {
      throw new FeedbackPublicationError('feedback journal identity mismatch', {
        ownerRef: publisher.ownerId,
        reason: 'journal-identity-mismatch',
        nextAction: { kind: 'recover', ref: publisher.ownerId },
        evidenceRefs: input.event.evidenceRefs,
      });
    }
    return { kind: input.kind, event: record };
  }
}
