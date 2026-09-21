import type {
  EvidenceRef,
  MemoryCandidateCategory,
  MemoryKind,
  MemoryNamespace,
  OperationId,
  ScopeRef,
} from './index.js';
import { assertEvidenceRef } from './index.js';
import { ContractError } from './errors.js';
import { MEMORY_KINDS, MEMORY_NAMESPACES } from './framework.js';

export const EXPLICIT_BRAIN_TEMPLATE_REF = 'builtin/interaction@1.1.0' as const;

export const EXPLICIT_BRAIN_MODEL_TOOLS = [
  'task.query',
  'task.match',
  'runtime.status',
  'queue.inspect',
  'resource.query',
  'workspace.list',
  'file.read',
  'file.search',
  'agent.query',
  'agent.message',
  'bug.query',
  'bug.inspect',
  'channel.query',
  'memory.search',
  'memory.inspect',
  'memory.compare',
  'memory.save_candidate',
  'memory.operation.status',
  'interaction.ask',
  'interaction.propose',
  'interaction.approve',
  'channel.reply',
  'channel.notify',
  'requirement.submit',
  'trigger.submit',
  'route.submit',
  'resource.request',
  'subscription.request',
  'attention.list',
  'attention.inspect',
  'attention.triage',
  'attention.ack',
  'attention.defer',
  'attention.notify',
  'attention.resolve',
  'bug.report',
  'bug.propose-update',
  'bug.resolve',
  'bug.reopen',
] as const;
export type ExplicitBrainModelTool = (typeof EXPLICIT_BRAIN_MODEL_TOOLS)[number];

export const EXPLICIT_BRAIN_FORBIDDEN_TOOLS = [
  'coding',
  'search',
  'test',
  'build',
  'worker.execute',
  'assignment.create',
  'assignment.execute',
  'resource.allocate',
  'runtime.spawn',
  'provider.select',
  'lease.mint',
  'journal.append',
  'checkpoint.commit',
  'memory.approve',
  'memory.promote',
  'skill.publish',
  'file.write',
  'file.edit',
  'file.delete',
  'shell.exec',
] as const;

export const EXPLICIT_BRAIN_SKILLS = [
  'input-normalization',
  'channel-routing',
  'task-matching',
  'status-explanation',
  'confirmation',
  'attention-triage',
  'priority-classification',
  'async-memory-feedback',
  'error-notification',
] as const;
export type ExplicitBrainSkill = (typeof EXPLICIT_BRAIN_SKILLS)[number];

const CHANNEL_KINDS = [
  'user',
  'external-event',
  'bug-event',
  'health-event',
  'manual-route',
  'automatic-route',
] as const;
const CHANNEL_REPLY_MODES = ['reply', 'notify', 'record-only'] as const;
const CHANNEL_ERROR_POLICIES = ['attention', 'reject', 'retry'] as const;
const ATTENTION_KINDS = [
  'operation-failure',
  'owner-resolution',
  'notification-failure',
  'resource-waiting',
  'health',
  'integrity',
  'other',
] as const;
const ATTENTION_IMPACTS = ['none', 'low', 'medium', 'high', 'critical'] as const;
const ATTENTION_URGENCIES = ['none', 'low', 'medium', 'high', 'immediate'] as const;
const ATTENTION_BLOCKING = ['none', 'local', 'task', 'system'] as const;
const BUG_SEVERITY_PROPOSALS = ['low', 'medium', 'high', 'critical'] as const;
const BUG_STATES = ['created', 'assigned', 'resolved', 'closed', 'reopened'] as const;

function includesValue<T extends string>(
  values: readonly T[],
  value: unknown,
  label: string,
): asserts value is T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new ContractError(`invalid ${label}`);
  }
}

export type ChannelKind =
  | 'user'
  | 'external-event'
  | 'bug-event'
  | 'health-event'
  | 'manual-route'
  | 'automatic-route';

export interface ChannelBinding {
  readonly channelId: string;
  readonly kind: ChannelKind;
  readonly scopeRef: string;
  readonly skillRef: ExplicitBrainSkill;
  readonly inputSchemaRef: string;
  readonly replyMode: 'reply' | 'notify' | 'record-only';
  readonly errorPolicy: 'attention' | 'reject' | 'retry';
}

export interface InteractionInput {
  readonly interactionId: string;
  readonly sourceRef: string;
  readonly channelId: string;
  readonly inputRevision: number;
  readonly idempotencyKey: string;
  readonly rawInputRef: string;
  readonly occurredAt: string;
}

export interface NormalizedInteractionInput {
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly normalizedRef: string;
  readonly classification:
    | 'business-requirement'
    | 'status-query'
    | 'clarification'
    | 'control'
    | 'external-event'
    | 'bug-event'
    | 'health-event';
  readonly skillRef: ExplicitBrainSkill;
  readonly evidenceRefs: readonly string[];
}

export interface ToolIntent<TArguments = Readonly<Record<string, unknown>>> {
  readonly toolIntentId: string;
  readonly interactionId?: string;
  readonly toolRef: string;
  readonly arguments: TArguments;
  readonly argumentsDigest: string;
  readonly reasonRefs: readonly string[];
  readonly selectedBecause: string;
}

export interface InteractionDecision {
  readonly decisionId: string;
  readonly interactionId: string;
  readonly kind:
    | 'input-classification'
    | 'task-match'
    | 'intent'
    | 'attention-triage'
    | 'priority-proposal'
    | 'route-selection'
    | 'notification-policy'
    | 'memory-trigger';
  readonly selectedAction:
    | 'answer'
    | 'ask-user'
    | 'create-attention'
    | 'update-attention'
    | 'submit-requirement'
    | 'submit-trigger'
    | 'report-bug'
    | 'request-memory'
    | 'notify'
    | 'wait'
    | 'reject';
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly toolIntents: readonly ToolIntent[];
}

const INTERACTION_DECISION_KINDS = [
  'input-classification',
  'task-match',
  'intent',
  'attention-triage',
  'priority-proposal',
  'route-selection',
  'notification-policy',
  'memory-trigger',
] as const;

const INTERACTION_DECISION_ACTIONS = [
  'answer',
  'ask-user',
  'create-attention',
  'update-attention',
  'submit-requirement',
  'submit-trigger',
  'report-bug',
  'request-memory',
  'notify',
  'wait',
  'reject',
] as const;

export interface RequirementSubmitArguments {
  readonly interactionId: string;
  readonly draftId: string;
  readonly confirmationRef: string;
  readonly inputRevision: number;
  readonly routeHints?: {
    readonly queueClass?: string;
    readonly requiredCapabilityRefs?: readonly string[];
    readonly priorityProposalRef?: string;
  };
}

export interface TriggerSubmitArguments {
  readonly triggerRef: string;
  readonly source: 'schedule' | 'bug' | 'health' | 'channel-event' | 'attention';
  readonly policyRef: string;
  readonly policyRevision: number;
  readonly skillRef: string;
  readonly skillDigest: string;
  readonly idempotencyKey: string;
  readonly priorityProposalRef?: string;
  readonly targetRef?: string;
  readonly payloadRef: string;
}

export interface SubscriptionRequestArguments {
  readonly goalId: string;
  readonly scheduleRevision: number;
  readonly busyPolicy: 'skip' | 'idle-reminder';
  readonly triggerRef: string;
  readonly policyRef: string;
  readonly skillRef: string;
  readonly skillDigest: string;
}

export interface ConfirmedRequirementRevision {
  readonly draftId: string;
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly confirmationRef: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

export type AttentionImpact = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type AttentionUrgency = 'none' | 'low' | 'medium' | 'high' | 'immediate';
export type AttentionBlocking = 'none' | 'local' | 'task' | 'system';
export type AttentionKind =
  | 'operation-failure'
  | 'owner-resolution'
  | 'notification-failure'
  | 'resource-waiting'
  | 'health'
  | 'integrity'
  | 'other';

export interface AttentionTriageArguments {
  readonly sourceRef: string;
  readonly existingAttentionId?: string;
  readonly kind: AttentionKind;
  readonly impact: AttentionImpact;
  readonly urgency: AttentionUrgency;
  readonly blocking: AttentionBlocking;
  readonly userDecisionRequired: boolean;
  readonly recurrenceSignal?: {
    readonly rootCauseRef: string;
    readonly observedAt: string;
  };
  readonly consecutiveFailureCount?: number;
  readonly retryExhausted?: boolean;
  readonly affectedRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly reasonRefs: readonly string[];
  readonly proposedNextAction: string;
  readonly proposedCondition?: string;
}

export interface PriorityPolicyDecision {
  readonly priorityClass:
    | 'safety-data-integrity'
    | 'system-blocking'
    | 'task-blocking'
    | 'user-decision-blocking'
    | 'hard-deadline'
    | 'user-visible-impact'
    | 'recurrence'
    | 'aging';
  readonly reasons: readonly string[];
  readonly serviceClass: 'interactive' | 'normal' | 'blocker' | 'background';
  readonly preemptsActiveExecution: boolean;
}

export type MemoryOperationState =
  | 'accepted'
  | 'queued'
  | 'analyzing'
  | 'review-required'
  | 'applied'
  | 'failed';

export interface MemoryOperationStatus {
  readonly operationId: OperationId;
  readonly state: MemoryOperationState;
  readonly nextAction: string;
  readonly resultRefs: readonly string[];
  readonly attentionRefs: readonly string[];
}

export const MEMORY_BOUNDARY_WAKEUPS = [
  'blocked-attention',
  'checkpoint-rewind',
  'task-cycle-completion',
  'explicit-memory-submission',
] as const;
export type MemoryBoundaryWakeup = (typeof MEMORY_BOUNDARY_WAKEUPS)[number];

export interface MemoryOperationRequestedEvent {
  readonly operationId: OperationId;
  readonly trigger:
    | 'human-correction'
    | 'human-emotion'
    | 'explicit-memory-request'
    | 'skill-revision-request'
    | 'process-feedback'
    | 'rewind'
    | 'task-completion'
    | 'attention-blocked';
  readonly boundary: MemoryBoundaryWakeup;
  readonly sourceRefs: readonly string[];
  readonly scopeRef: string;
  readonly requestedOutputs: readonly string[];
  readonly userVisible: boolean;
}

export interface MemorySaveCandidateArguments {
  readonly submissionId: string;
  readonly requestedKind: MemoryKind;
  readonly candidateCategory: MemoryCandidateCategory;
  readonly contentRef: string;
  readonly evidenceRefs: readonly string[];
  readonly desiredScope: MemoryNamespace;
  readonly reason: string;
}

export interface BugReportArguments {
  readonly sourceFactRef: string;
  readonly submissionId: string;
  readonly observedResultRef: string;
  readonly expectedResultRef: string;
  readonly reproductionRefs: readonly string[];
  readonly componentHint?: string;
  readonly severityProposal: 'low' | 'medium' | 'high' | 'critical';
  readonly impactProposal: string;
  readonly correlationRef: string;
}

export interface BugProposeUpdateArguments {
  readonly bugId: string;
  readonly sourceFactRef: string;
  readonly proposedState: BugState;
  readonly resolutionEvidenceRefs: readonly string[];
  readonly validationEvidenceRefs: readonly string[];
  readonly reason: string;
}

export interface BugTransitionArguments {
  readonly bugId: string;
  readonly expectedRevision: string;
  readonly resolutionEvidenceRefs: readonly string[];
  readonly validationEvidenceRefs: readonly string[];
  readonly reason: string;
}

export type BugState = 'created' | 'assigned' | 'resolved' | 'closed' | 'reopened';

export interface BugRecord {
  readonly bugId: string;
  readonly submissionId: string;
  readonly state: BugState;
  readonly ownerRef?: string;
  readonly sourceFactRef: string;
  readonly gitBugRevision: string;
}

export interface OwnerRegistryEntry {
  readonly componentRef: string;
  readonly ownerRef: string;
  readonly active: boolean;
}

export interface NotificationRecord {
  readonly notificationId: string;
  readonly bugId: string;
  readonly gitBugRevision: string;
  readonly transition: BugState;
  readonly recipientRef: string;
  readonly kind: 'owner' | 'reporter';
  readonly state: 'queued' | 'sending' | 'sent' | 'duplicate' | 'waiting' | 'failed';
  readonly attentionRef?: string;
}

export type DecisionTraceAdmission =
  | 'accepted'
  | 'rejected'
  | 'stale'
  | 'duplicate'
  | 'capability-denied'
  | 'permission-denied'
  | 'resource-unavailable'
  | 'waiting'
  | 'blocked'
  | 'unknown-operation'
  | 'external-effect-unknown';

export interface SemanticDecisionTrace {
  readonly traceId: string;
  readonly scopeRef: string;
  readonly runtimeBindingRef: string;
  readonly interactionRef?: string;
  readonly attentionRef?: string;
  readonly bugRef?: string;
  readonly taskRef?: string;
  readonly operationRef?: string;
  readonly decisionKind: InteractionDecision['kind'];
  readonly decisionSummary: string;
  readonly selectedAction: InteractionDecision['selectedAction'];
  readonly evidenceRefs: readonly string[];
  readonly inputDigest: string;
  readonly contextDigest?: string;
  readonly skillRef?: string;
  readonly skillDigest?: string;
  readonly createdAt: string;
}

export interface ToolDecisionTrace {
  readonly traceId: string;
  readonly parentDecisionTraceId: string;
  readonly toolIntentId: string;
  readonly toolRef: string;
  readonly argumentsRef: string;
  readonly argumentsDigest: string;
  readonly reasonRefs: readonly string[];
  readonly selectedBecause: string;
  readonly bindingRef: string;
  readonly capabilityDigest: string;
  readonly permissionRevision: string;
  readonly executionEpoch: number;
  readonly createdAt: string;
}

export interface FrameworkExecutionTrace {
  readonly traceId: string;
  readonly toolIntentId: string;
  readonly admission: DecisionTraceAdmission;
  readonly operationId?: OperationId;
  readonly ownerRef: string;
  readonly effectRefs: readonly string[];
  readonly resultRef?: string;
  readonly eventRefs: readonly string[];
  readonly notificationOperationRefs: readonly string[];
  readonly failureRef?: string;
  readonly settlement:
    | {
        readonly state: 'pending' | 'waiting' | 'blocked' | 'unknown';
        readonly recoveryRef: string;
      }
    | {
        readonly state: 'completed' | 'failed';
        readonly completedAt: string;
      };
  readonly stateTransitionRef?: string;
  readonly downstreamRouteRef?: string;
  readonly finalReceiptRef?: string;
}

export interface DecisionTraceRecord {
  readonly semantic: SemanticDecisionTrace;
  readonly tool?: ToolDecisionTrace;
  readonly execution?: FrameworkExecutionTrace;
}

function nonEmpty(value: string | undefined, label: string): asserts value is string {
  if (!value?.trim()) throw new ContractError(`${label} is required`);
}

function validTime(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new ContractError(`${label} must be a valid timestamp`);
}

export function validateToolIntent(input: ToolIntent): void {
  nonEmpty(input.toolIntentId, 'toolIntentId');
  nonEmpty(input.toolRef, 'toolRef');
  nonEmpty(input.argumentsDigest, 'tool arguments digest');
  nonEmpty(input.selectedBecause, 'tool selectedBecause');
  if (!(EXPLICIT_BRAIN_MODEL_TOOLS as readonly string[]).includes(input.toolRef)) {
    throw new ContractError(`tool is not registered for explicit brain: ${input.toolRef}`);
  }
}

export function validateInteractionDecision(input: unknown): asserts input is InteractionDecision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractError('interaction decision must be an object');
  }
  const value = input as Record<string, unknown>;
  nonEmpty(typeof value.decisionId === 'string' ? value.decisionId : undefined, 'decisionId');
  nonEmpty(typeof value.interactionId === 'string' ? value.interactionId : undefined, 'interactionId');
  if (!INTERACTION_DECISION_KINDS.includes(value.kind as typeof INTERACTION_DECISION_KINDS[number])) {
    throw new ContractError('interaction decision kind is invalid');
  }
  if (!INTERACTION_DECISION_ACTIONS.includes(value.selectedAction as typeof INTERACTION_DECISION_ACTIONS[number])) {
    throw new ContractError('interaction decision selectedAction is invalid');
  }
  nonEmpty(typeof value.summary === 'string' ? value.summary : undefined, 'decision summary');
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    throw new ContractError('interaction decision evidenceRefs must be a string array');
  }
  if (!Array.isArray(value.toolIntents)) {
    throw new ContractError('interaction decision toolIntents must be an array');
  }
  for (const candidate of value.toolIntents) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ContractError('interaction decision toolIntents entries must be objects');
    }
    validateToolIntent(candidate as ToolIntent);
  }
}

export function validateChannelBinding(input: ChannelBinding): void {
  nonEmpty(input.channelId, 'channelId');
  nonEmpty(input.scopeRef, 'channel scopeRef');
  nonEmpty(input.inputSchemaRef, 'channel input schema ref');
  includesValue(CHANNEL_KINDS, input.kind, 'channel kind');
  includesValue(CHANNEL_REPLY_MODES, input.replyMode, 'channel reply mode');
  includesValue(CHANNEL_ERROR_POLICIES, input.errorPolicy, 'channel error policy');
  if (!EXPLICIT_BRAIN_SKILLS.includes(input.skillRef)) {
    throw new ContractError(`channel skill is not registered for explicit brain: ${input.skillRef}`);
  }
}

export function validateAttentionTriage(input: AttentionTriageArguments): void {
  nonEmpty(input.sourceRef, 'attention sourceRef');
  nonEmpty(input.proposedNextAction, 'attention proposedNextAction');
  includesValue(ATTENTION_KINDS, input.kind, 'attention kind');
  includesValue(ATTENTION_IMPACTS, input.impact, 'attention impact');
  includesValue(ATTENTION_URGENCIES, input.urgency, 'attention urgency');
  includesValue(ATTENTION_BLOCKING, input.blocking, 'attention blocking');
  if (typeof input.userDecisionRequired !== 'boolean') {
    throw new ContractError('attention userDecisionRequired must be boolean');
  }
  if (input.affectedRefs.length === 0) throw new ContractError('attention affectedRefs cannot be empty');
  if (input.evidenceRefs.length === 0) throw new ContractError('attention evidenceRefs cannot be empty');
  for (const evidenceRef of input.evidenceRefs) assertEvidenceRef(evidenceRef);
  if (input.reasonRefs.length === 0) throw new ContractError('attention reasonRefs cannot be empty');
  if (input.recurrenceSignal) {
    nonEmpty(input.recurrenceSignal.rootCauseRef, 'attention recurrence rootCauseRef');
    validTime(input.recurrenceSignal.observedAt, 'attention recurrence observedAt');
  }
  if (input.consecutiveFailureCount !== undefined
    && (!Number.isSafeInteger(input.consecutiveFailureCount) || input.consecutiveFailureCount < 0)) {
    throw new ContractError('attention consecutiveFailureCount must be a non-negative safe integer');
  }
}

export function validateMemoryOperationStatus(input: MemoryOperationStatus): void {
  nonEmpty(input.operationId.value, 'memory operation id');
  nonEmpty(input.nextAction, 'memory operation nextAction');
}

export function validateTriggerSubmit(input: TriggerSubmitArguments): void {
  nonEmpty(input.triggerRef, 'trigger triggerRef');
  includesValue(
    ['schedule', 'bug', 'health', 'channel-event', 'attention'] as const,
    input.source,
    'trigger source',
  );
  nonEmpty(input.policyRef, 'trigger policyRef');
  if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) {
    throw new ContractError('trigger policyRevision must be a positive safe integer');
  }
  nonEmpty(input.skillRef, 'trigger skillRef');
  nonEmpty(input.skillDigest, 'trigger skillDigest');
  nonEmpty(input.idempotencyKey, 'trigger idempotencyKey');
  nonEmpty(input.payloadRef, 'trigger payloadRef');
}

export function validateSubscriptionRequest(input: SubscriptionRequestArguments): void {
  nonEmpty(input.goalId, 'subscription goalId');
  if (!Number.isSafeInteger(input.scheduleRevision) || input.scheduleRevision < 1) {
    throw new ContractError('subscription scheduleRevision must be a positive safe integer');
  }
  includesValue(['skip', 'idle-reminder'] as const, input.busyPolicy, 'subscription busyPolicy');
  nonEmpty(input.triggerRef, 'subscription triggerRef');
  nonEmpty(input.policyRef, 'subscription policyRef');
  nonEmpty(input.skillRef, 'subscription skillRef');
  nonEmpty(input.skillDigest, 'subscription skillDigest');
}

export function validateMemorySaveCandidateArguments(input: MemorySaveCandidateArguments): void {
  nonEmpty(input.submissionId, 'memory submissionId');
  if (!MEMORY_KINDS.includes(input.requestedKind)) throw new ContractError('invalid memory submission kind');
  includesValue([
    'project-fact',
    'project-experience',
    'global',
    'user-profile',
    'local-skill-update',
  ] as const, input.candidateCategory, 'memory submission candidateCategory');
  nonEmpty(input.contentRef, 'memory submission contentRef');
  if (input.evidenceRefs.length === 0) throw new ContractError('memory submission evidenceRefs cannot be empty');
  if (input.evidenceRefs.some((ref) => !ref.trim())) throw new ContractError('memory submission evidenceRefs cannot be empty');
  if (!MEMORY_NAMESPACES.includes(input.desiredScope)) throw new ContractError('invalid memory submission desiredScope');
  nonEmpty(input.reason, 'memory submission reason');
}

export function validateBugReport(input: BugReportArguments): void {
  nonEmpty(input.sourceFactRef, 'bug sourceFactRef');
  nonEmpty(input.submissionId, 'bug submissionId');
  nonEmpty(input.observedResultRef, 'bug observedResultRef');
  nonEmpty(input.expectedResultRef, 'bug expectedResultRef');
  nonEmpty(input.impactProposal, 'bug impactProposal');
  nonEmpty(input.correlationRef, 'bug correlationRef');
  includesValue(BUG_SEVERITY_PROPOSALS, input.severityProposal, 'bug severityProposal');
  if (input.reproductionRefs.length === 0) throw new ContractError('bug reproductionRefs cannot be empty');
}

export function validateBugProposeUpdate(input: BugProposeUpdateArguments): void {
  nonEmpty(input.bugId, 'bug update bugId');
  nonEmpty(input.sourceFactRef, 'bug update sourceFactRef');
  nonEmpty(input.reason, 'bug update reason');
  includesValue(BUG_STATES, input.proposedState, 'bug proposedState');
}

export function validateBugTransition(input: BugTransitionArguments): void {
  nonEmpty(input.bugId, 'bug transition bugId');
  nonEmpty(input.expectedRevision, 'bug transition expectedRevision');
  nonEmpty(input.reason, 'bug transition reason');
  if (input.resolutionEvidenceRefs.length === 0) {
    throw new ContractError('bug transition resolutionEvidenceRefs cannot be empty');
  }
  if (input.validationEvidenceRefs.length === 0) {
    throw new ContractError('bug transition validationEvidenceRefs cannot be empty');
  }
}

export function assertExplicitBrainScope(input: {
  readonly runtimeRoleId: string;
  readonly runtimeTemplateRef: string;
  readonly interactionScopeId: string;
}): void {
  if (input.runtimeRoleId !== 'interaction') throw new ContractError('explicit brain runtime role must be interaction');
  if (input.runtimeTemplateRef !== EXPLICIT_BRAIN_TEMPLATE_REF) {
    throw new ContractError(`explicit brain runtime template must be ${EXPLICIT_BRAIN_TEMPLATE_REF}`);
  }
  nonEmpty(input.interactionScopeId, 'interactionScopeId');
}

export function evidenceRefsInScope(refs: readonly EvidenceRef[], scope: ScopeRef): void {
  for (const evidence of refs) {
    if (evidence.scope.organId.value !== scope.organId.value) throw new ContractError('evidence scope does not match tool scope');
    if (scope.taskId && evidence.scope.taskId?.value !== scope.taskId.value) {
      throw new ContractError('evidence task scope does not match tool scope');
    }
  }
}
