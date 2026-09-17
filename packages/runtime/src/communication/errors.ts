import type {
  EvidenceRef,
  NextAction,
} from '../../../contracts/src/index.js';

export type CommunicationErrorReason =
  | 'communication-failure'
  | 'registration-invalid'
  | 'duplicate-capability-id'
  | 'duplicate-capability-identity'
  | 'capability-not-found'
  | 'capability-revoked'
  | 'capability-ref-mismatch'
  | 'scope-denied'
  | 'permission-denied'
  | 'epoch-denied'
  | 'caller-denied'
  | 'private-session-access-forbidden'
  | 'invalid-capability-call'
  | 'event-envelope-invalid'
  | 'feedback-class-mismatch'
  | 'control-requires-harness-publisher'
  | 'publisher-not-trusted'
  | 'publisher-denied'
  | 'control-truth-in-payload'
  | 'evidence-scope-denied'
  | 'journal-append-failed'
  | 'journal-identity-mismatch';

export interface AgentCommunicationErrorOptions {
  readonly ownerRef?: string;
  readonly reason?: CommunicationErrorReason;
  readonly nextAction?: NextAction;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly cause?: unknown;
}

export class AgentCommunicationError extends Error {
  readonly ownerRef: string;
  readonly reason: CommunicationErrorReason;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  override readonly cause?: unknown;

  constructor(message: string, options: AgentCommunicationErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentCommunicationError';
    this.ownerRef = options.ownerRef ?? 'runtime.agent-communication';
    this.reason = options.reason ?? 'communication-failure';
    this.nextAction = options.nextAction ?? { kind: 'recover', ref: this.ownerRef };
    this.evidenceRefs = [...(options.evidenceRefs ?? [])];
    this.cause = options.cause;
  }
}

export class CapabilityRegistryError extends AgentCommunicationError {
  constructor(message: string, options: AgentCommunicationErrorOptions = {}) {
    super(message, options);
    this.name = 'CapabilityRegistryError';
  }
}

export class CapabilityCallError extends AgentCommunicationError {
  constructor(message: string, options: AgentCommunicationErrorOptions = {}) {
    super(message, options);
    this.name = 'CapabilityCallError';
  }
}

export class FeedbackPublicationError extends AgentCommunicationError {
  constructor(message: string, options: AgentCommunicationErrorOptions = {}) {
    super(message, options);
    this.name = 'FeedbackPublicationError';
  }
}
