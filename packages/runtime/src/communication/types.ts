import type {
  EvidenceRef,
  NextAction,
} from '../../../contracts/src/index.js';
import type {
  EventClass,
  EventEnvelope,
  EventRecord,
} from '../events/types.js';
import type {
  EventJournalPort,
  EventPublisherRegistryPort,
} from '../events/ports.js';

export const M3_FEEDBACK_KINDS = [
  'assignment-feedback',
  'work-result',
  'attention',
  'bug-report',
  'resource-notification',
  'review-feedback',
  'memory-feedback',
  'schedule-reminder',
] as const;

export type M3FeedbackKind = (typeof M3_FEEDBACK_KINDS)[number];

export const M3_FEEDBACK_CLASS_BY_KIND: Readonly<Record<M3FeedbackKind, EventClass>> = Object.freeze({
  'assignment-feedback': 'control',
  'work-result': 'data',
  attention: 'data',
  'bug-report': 'data',
  'resource-notification': 'observation',
  'review-feedback': 'data',
  'memory-feedback': 'data',
  'schedule-reminder': 'observation',
});

export interface CapabilityRegistrationIdentity {
  readonly capabilityId: string;
  readonly capabilityRef: string;
  readonly ownerRef: string;
  readonly scopeRef: string;
  readonly permissionRevision: string;
  readonly executionEpoch: number;
}

export interface CapabilityRegistration extends CapabilityRegistrationIdentity {
  readonly allowedCallerRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RegisteredCapability extends CapabilityRegistration {
  readonly registeredAt: string;
  readonly revoked: boolean;
}

export interface CapabilityAuthorizationRequest {
  readonly capabilityId: string;
  readonly capabilityRef: string;
  readonly callerRef: string;
  readonly scopeRef: string;
  readonly permissionRevision: string;
  readonly executionEpoch: number;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface CapabilityCallRequest {
  readonly requestId: string;
  readonly capabilityId: string;
  readonly capabilityRef: string;
  readonly callerRef: string;
  readonly scopeRef: string;
  readonly permissionRevision: string;
  readonly executionEpoch: number;
  readonly assignmentId?: string;
  readonly inputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly requestedAt: string;
}

export type CapabilityCallResult =
  | {
      readonly status: 'succeeded';
      readonly requestId: string;
      readonly capabilityId: string;
      readonly operationRef: string;
      readonly resultRef: string;
      readonly evidenceRefs: readonly EvidenceRef[];
      readonly nextAction: NextAction;
    }
  | {
      readonly status: 'failed';
      readonly requestId: string;
      readonly capabilityId: string;
      readonly ownerRef: string;
      readonly reason: string;
      readonly nextAction: NextAction;
      readonly evidenceRefs: readonly EvidenceRef[];
    };

export interface FeedbackPublication {
  readonly kind: M3FeedbackKind;
  readonly publisherId: string;
  readonly event: EventEnvelope;
}

export interface PublishedFeedback {
  readonly kind: M3FeedbackKind;
  readonly event: EventRecord;
}

export interface FeedbackHubPorts {
  readonly journal: EventJournalPort;
  readonly publishers: EventPublisherRegistryPort;
}
