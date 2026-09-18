import { createHash } from 'node:crypto';
import {
  id,
  type BusinessPayload,
  type EvidenceRef,
  type MemoryActorContext,
  type MemoryScope,
  type ScopeRef,
  type TaskId,
} from '../../../contracts/src/index.js';
import {
  eventIdentityKey,
  type EventConsumerHandler,
  type EventEnvelope,
  type EventHandlerCommit,
  type EventRecord,
} from '../events/index.js';
import {
  MEMORY_AGENT_OWNER,
  memoryAgentIssue,
  type MemoryAgentIssue,
  type MemoryAgentOutcome,
  type MemoryAnalysisRequest,
} from './agent.js';

export const MEMORY_ANALYSIS_REQUESTED_KIND = 'memory.analysis.requested';

export const MEMORY_ANALYSIS_TRIGGERS = [
  'blocked',
  'rewind',
  'completion',
  'explicit-submission',
] as const;
export type MemoryAnalysisTrigger = (typeof MEMORY_ANALYSIS_TRIGGERS)[number];

export interface MemoryAnalysisWakeBinding {
  readonly bindingRef: string;
  readonly projectKey: string;
  readonly executionEpoch: number;
  readonly scope: MemoryScope;
  readonly taskId?: TaskId;
  readonly actor: MemoryActorContext;
}

export interface MemoryAnalysisAdmissionReceipt {
  readonly admissionRef: string;
  readonly effectRefs?: readonly string[];
}

export interface MemoryAnalysisAdmissionPort {
  admit(input: {
    readonly request: MemoryAnalysisRequest;
    readonly event: EventRecord;
  }): Promise<MemoryAgentOutcome<MemoryAnalysisAdmissionReceipt>>;
}

export interface MemoryAnalysisEventConsumerOptions {
  readonly binding: MemoryAnalysisWakeBinding;
  readonly admission: MemoryAnalysisAdmissionPort;
  readonly now?: () => string;
  readonly retryDelayMs?: number;
  readonly retryOwnerRef?: string;
}

const MEMORY_ADMISSION_ATTENTION_DISPOSITION: Record<MemoryAgentIssue['code'], 'retry' | 'reject'> = {
  'memory-agent-binding-missing': 'reject',
  'memory-agent-binding-mismatch': 'reject',
  'memory-agent-source-unavailable': 'retry',
  'memory-agent-source-invalid': 'reject',
  'memory-agent-source-scope-denied': 'reject',
  'memory-agent-prompt-unavailable': 'retry',
  'memory-agent-analysis-unavailable': 'retry',
  'memory-agent-follow-up-stale': 'reject',
  'memory-agent-follow-up-conflict': 'reject',
  'memory-agent-update-denied': 'reject',
  'memory-agent-update-conflict': 'reject',
  'memory-agent-update-validation-failed': 'reject',
  'memory-agent-event-unsupported': 'reject',
  'memory-agent-event-invalid': 'reject',
  'memory-agent-event-scope-mismatch': 'reject',
  'memory-agent-event-evidence-missing': 'reject',
};

export interface MemoryAnalysisRequestedEventInput {
  readonly messageId: string;
  readonly streamId: string;
  readonly scope: ScopeRef;
  readonly occurredAt: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly executionEpoch: number;
  readonly trigger: MemoryAnalysisTrigger;
  readonly requestedKind?: 'episodic' | 'semantic' | 'procedural';
  readonly sessionRef?: string;
  readonly inputRevision?: number;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value;
}

function safeOperationSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,96}$/.test(value);
}

function operationIdForEvent(event: EventRecord): string {
  const identity = `${event.streamId.length}:${event.streamId}${event.messageId.length}:${event.messageId}`;
  return `memory-analysis-${createHash('sha256').update(identity).digest('hex')}`;
}

function sameId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function isTrigger(value: unknown): value is MemoryAnalysisTrigger {
  return typeof value === 'string' && (MEMORY_ANALYSIS_TRIGGERS as readonly string[]).includes(value);
}

function payloadRecord(payload: BusinessPayload | undefined): Record<string, unknown> {
  return payload === undefined ? {} : payload as Record<string, unknown>;
}

function eventIssue(
  code:
    | 'memory-agent-event-unsupported'
    | 'memory-agent-event-invalid'
    | 'memory-agent-event-scope-mismatch'
    | 'memory-agent-event-evidence-missing',
  message: string,
  target: string,
): MemoryAgentOutcome<never> {
  return {
    status: 'attention',
    issue: memoryAgentIssue(code, 'attention', message, target),
  };
}

function validateBinding(binding: MemoryAnalysisWakeBinding): MemoryAgentOutcome<never> | null {
  if (!binding.bindingRef.trim()) return eventIssue('memory-agent-event-invalid', 'memory analysis binding ref is required', 'memory-binding');
  if (!binding.projectKey.trim()) return eventIssue('memory-agent-event-invalid', 'memory analysis project key is required', 'memory-binding');
  if (!Number.isSafeInteger(binding.executionEpoch) || binding.executionEpoch < 1) {
    return eventIssue('memory-agent-event-invalid', 'memory analysis binding execution epoch must be positive', 'memory-binding');
  }
  if (binding.actor.projectKey !== binding.projectKey) {
    return eventIssue('memory-agent-event-scope-mismatch', 'memory analysis actor belongs to another project', 'memory-permission');
  }
  if (!binding.actor.permissions.includes('memory.propose')) {
    return eventIssue('memory-agent-event-invalid', 'memory analysis actor lacks memory.propose permission', 'memory-permission');
  }
  if (binding.scope.kind === 'task' && binding.scope.taskId === undefined) {
    return eventIssue('memory-agent-event-invalid', 'task memory analysis binding requires a task id', 'memory-binding');
  }
  return null;
}

function scopeMatchesEvent(scope: MemoryScope, eventScope: ScopeRef): boolean {
  if (!sameId(scope.organId, eventScope.organId)) return false;
  if (scope.taskId !== undefined && !sameId(scope.taskId, eventScope.taskId)) return false;
  return true;
}

function evidenceSources(event: EventRecord): {
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
} | null {
  if (event.evidenceRefs.length === 0) return null;
  const sourceRefs: string[] = [];
  const sourceDigests: string[] = [];
  for (const evidence of event.evidenceRefs) {
    if (!evidence.locator.trim() || !evidence.digest?.trim()) return null;
    sourceRefs.push(evidence.locator);
    sourceDigests.push(evidence.digest);
  }
  return { sourceRefs, sourceDigests };
}

function requestedKind(payload: Record<string, unknown>, trigger: MemoryAnalysisTrigger): MemoryAnalysisRequest['requestedKind'] {
  if (payload.requestedKind === undefined) return trigger === 'rewind' ? 'procedural' : 'semantic';
  if (payload.requestedKind === 'episodic' || payload.requestedKind === 'semantic' || payload.requestedKind === 'procedural') {
    return payload.requestedKind;
  }
  return 'semantic';
}

export function createMemoryAnalysisRequestedEvent(
  input: MemoryAnalysisRequestedEventInput,
): EventEnvelope {
  nonEmpty(input.messageId, 'memory analysis message id');
  if (!safeOperationSegment(input.messageId)) {
    throw new Error('memory analysis message id cannot form a stable operation id');
  }
  nonEmpty(input.streamId, 'memory analysis stream id');
  nonEmpty(input.summary, 'memory analysis summary');
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error('memory analysis occurredAt is invalid');
  if (!Number.isSafeInteger(input.executionEpoch) || input.executionEpoch < 1) {
    throw new Error('memory analysis execution epoch must be positive');
  }
  if (!isTrigger(input.trigger)) throw new Error('memory analysis trigger is invalid');
  if (input.evidenceRefs.length === 0) throw new Error('memory analysis requires evidence refs');
  if (input.evidenceRefs.some((evidence) => !evidence.locator.trim() || !evidence.digest?.trim())) {
    throw new Error('memory analysis evidence refs require locators and digests');
  }
  const payload: BusinessPayload = {
    trigger: input.trigger,
    requestedKind: input.requestedKind ?? (input.trigger === 'rewind' ? 'procedural' : 'semantic'),
    ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
  };
  return {
    messageId: input.messageId,
    streamId: input.streamId,
    kind: MEMORY_ANALYSIS_REQUESTED_KIND,
    class: 'data',
    scope: input.scope,
    occurredAt: input.occurredAt,
    summary: input.summary,
    payload,
    evidenceRefs: input.evidenceRefs.map((evidence) => ({ ...evidence })),
    executionEpoch: input.executionEpoch,
    ...(input.inputRevision === undefined ? {} : { inputRevision: input.inputRevision }),
  };
}

export function memoryAnalysisRequestFromEvent(
  event: EventRecord,
  binding: MemoryAnalysisWakeBinding,
): MemoryAgentOutcome<MemoryAnalysisRequest> {
  const bindingIssue = validateBinding(binding);
  if (bindingIssue) return bindingIssue;
  if (event.kind !== MEMORY_ANALYSIS_REQUESTED_KIND) {
    return eventIssue('memory-agent-event-unsupported', `unsupported memory analysis event: ${event.kind ?? 'missing'}`, 'memory-analysis-event');
  }
  if (event.class !== 'data') {
    return eventIssue('memory-agent-event-invalid', 'memory analysis request must be a data event', 'memory-analysis-event');
  }
  if (!safeOperationSegment(event.messageId)) {
    return eventIssue('memory-agent-event-invalid', 'memory analysis message id cannot form a stable operation id', 'memory-analysis-event');
  }
  if (event.executionEpoch === undefined) {
    return eventIssue('memory-agent-event-invalid', 'memory analysis event requires an execution epoch', 'memory-analysis-event');
  }
  if (event.executionEpoch !== binding.executionEpoch) {
    return eventIssue('memory-agent-event-invalid', 'memory analysis event execution epoch does not match the wake binding', 'memory-analysis-event');
  }
  if (!scopeMatchesEvent(binding.scope, event.scope)) {
    return eventIssue('memory-agent-event-scope-mismatch', 'memory analysis event scope does not match the wake binding', 'memory-analysis-scope');
  }
  const taskId = binding.taskId ?? event.scope.taskId;
  if (binding.scope.kind === 'task' && !sameId(binding.scope.taskId, taskId)) {
    return eventIssue('memory-agent-event-scope-mismatch', 'memory analysis event task does not match the wake binding', 'memory-analysis-scope');
  }
  const sources = evidenceSources(event);
  if (!sources) {
    return eventIssue('memory-agent-event-evidence-missing', 'memory analysis event requires evidence locators and digests', 'memory-analysis-evidence');
  }
  const payload = payloadRecord(event.payload);
  const allowed = new Set(['trigger', 'requestedKind', 'sessionRef']);
  const unknown = Object.keys(payload).find((key) => !allowed.has(key));
  if (unknown) {
    return eventIssue('memory-agent-event-invalid', `memory analysis event payload contains unsupported key: ${unknown}`, 'memory-analysis-event');
  }
  if (!isTrigger(payload.trigger)) {
    return eventIssue('memory-agent-event-invalid', 'memory analysis event trigger is invalid', 'memory-analysis-event');
  }
  if (payload.sessionRef !== undefined && (typeof payload.sessionRef !== 'string' || !payload.sessionRef.trim())) {
    return eventIssue('memory-agent-event-invalid', 'memory analysis session ref must be a non-empty string', 'memory-analysis-event');
  }
  const kind = requestedKind(payload, payload.trigger);
  if (payload.requestedKind !== undefined && payload.requestedKind !== kind) {
    return eventIssue('memory-agent-event-invalid', 'memory analysis requested kind is invalid', 'memory-analysis-event');
  }
  return {
    status: 'ready',
    value: {
      operationId: id('operation', operationIdForEvent(event)),
      bindingRef: binding.bindingRef,
      actor: {
        ...binding.actor,
        permissions: [...binding.actor.permissions],
      },
      projectKey: binding.projectKey,
      scope: {
        ...binding.scope,
        ...(binding.scope.taskId === undefined ? {} : { taskId: { ...binding.scope.taskId } }),
      },
      ...(taskId === undefined ? {} : { taskId: { ...taskId } }),
      ...(typeof payload.sessionRef === 'string' ? { sessionRef: payload.sessionRef } : {}),
      sourceRefs: [...sources.sourceRefs],
      sourceDigests: [...sources.sourceDigests],
      observation: event.summary,
      requestedKind: kind,
      executionEpoch: event.executionEpoch,
      trigger: payload.trigger,
    },
  };
}

function retryCommit(
  event: EventRecord,
  consumerKey: string,
  attempt: number,
  now: string,
  delayMs: number,
  ownerRef: string,
  failureRef: string,
): EventHandlerCommit {
  const retryKey = eventIdentityKey(event.streamId, consumerKey, event.messageId);
  return {
    consumerKey,
    messageId: event.messageId,
    retryObligation: {
      retryKey,
      consumerKey,
      messageId: event.messageId,
      streamId: event.streamId,
      failedSequence: event.sequence,
      attempt,
      nextAttemptAt: new Date(Date.parse(now) + delayMs).toISOString(),
      ownerRef,
      failureRef,
      state: 'pending',
    },
  };
}

function rejectedCommit(
  event: EventRecord,
  consumerKey: string,
  failureRef: string,
): EventHandlerCommit {
  return {
    consumerKey,
    messageId: event.messageId,
    disposition: 'rejected',
    completionMode: 'journal-atomic',
    internalEffectFacts: [],
    externalOperationRefs: [],
    failureRef,
  };
}

export function createMemoryAnalysisEventHandler(
  options: MemoryAnalysisEventConsumerOptions,
): EventConsumerHandler {
  const now = options.now ?? (() => new Date().toISOString());
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
    throw new Error('memory analysis retry delay must be a positive safe integer');
  }
  const retryOwnerRef = options.retryOwnerRef ?? MEMORY_AGENT_OWNER;
  if (!retryOwnerRef.trim()) throw new Error('memory analysis retry owner is required');

  return async ({ event, attempt }) => {
    const requestOutcome = memoryAnalysisRequestFromEvent(event, options.binding);
    if (requestOutcome.status === 'attention') {
      return rejectedCommit(event, options.binding.bindingRef, requestOutcome.issue.code);
    }
    if (requestOutcome.status !== 'ready') {
      return retryCommit(
        event,
        options.binding.bindingRef,
        attempt,
        now(),
        retryDelayMs,
        retryOwnerRef,
        requestOutcome.issue.code,
      );
    }
    const request = requestOutcome.value;
    const admissionOutcome = await options.admission.admit({ request, event });
    if (
      admissionOutcome.status === 'attention'
      && MEMORY_ADMISSION_ATTENTION_DISPOSITION[admissionOutcome.issue.code] === 'reject'
    ) {
      return rejectedCommit(event, options.binding.bindingRef, admissionOutcome.issue.code);
    }
    if (admissionOutcome.status !== 'ready') {
      return retryCommit(
        event,
        options.binding.bindingRef,
        attempt,
        now(),
        retryDelayMs,
        retryOwnerRef,
        admissionOutcome.issue.code,
      );
    }
    const admitted = admissionOutcome.value;
    return {
      consumerKey: options.binding.bindingRef,
      messageId: event.messageId,
      disposition: 'applied',
      completionMode: 'journal-atomic',
      internalEffectFacts: [
        admitted.admissionRef,
        ...(admitted.effectRefs ?? []),
      ],
      externalOperationRefs: [],
    };
  };
}
