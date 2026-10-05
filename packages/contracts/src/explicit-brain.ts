import type {
  EvidenceRef,
  MemoryCandidateCategory,
  MemoryKind,
  MemoryNamespace,
  OperationId,
  RequirementIntent,
  ScopeRef,
  TaskId,
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

export type InteractionRequestKind =
  | 'new-task-create'
  | 'new-task-preview'
  | 'existing-task-change'
  | 'status-query'
  | 'clarification'
  | 'refinement';

export interface InteractionInput {
  readonly interactionId: string;
  readonly sourceRef: string;
  readonly channelId: string;
  readonly inputRevision: number;
  readonly idempotencyKey: string;
  readonly rawInputRef: string;
  readonly occurredAt: string;
  readonly requestKind?: InteractionRequestKind;
}

export interface InteractionRequest extends InteractionInput {
  readonly requestKind: InteractionRequestKind;
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

export type ExecutionMode = 'once' | 'scheduled' | 'recurring';
export type ExecutionFrequency = 'interval' | 'daily' | 'weekly';
export type DstMode = 'wall' | 'absolute';
export type DstMissedPolicy = 'shift-forward';
export type DstAmbiguousPolicy = 'earlier-offset';
export type LatePolicy = 'run-once' | 'skip';
export type BusyPolicy = 'skip' | 'idle-reminder';

export interface ExecutionPolicyBase {
  readonly policyId: string;
  readonly policyRevision: number;
  readonly verificationProfileRef?: string;
  readonly timezone: string;
  readonly canonicalInstant: string;
  readonly dstMode: DstMode;
  readonly dstMissedPolicy: DstMissedPolicy;
  readonly dstAmbiguousPolicy: DstAmbiguousPolicy;
  readonly latePolicy: LatePolicy;
  readonly busyPolicy: BusyPolicy;
}

export type ExecutionPolicyDefinition =
  | (ExecutionPolicyBase & {
      readonly executionMode: 'once';
      readonly dueAt: string;
    })
  | (ExecutionPolicyBase & {
      readonly executionMode: 'scheduled';
      readonly startAt: string;
      readonly endAt?: string;
      readonly maxOccurrences?: number;
    })
  | (ExecutionPolicyBase & {
      readonly executionMode: 'recurring';
      readonly startAt: string;
      readonly endAt?: string;
      readonly maxOccurrences?: number;
      readonly frequency: ExecutionFrequency;
      readonly intervalMinutes?: number;
      readonly timeOfDay?: string;
      readonly weekDays?: readonly number[];
    });

export interface SubscriptionControlBase {
  readonly subscriptionId: string;
  readonly expectedPolicyRevision: number;
  readonly expectedScheduleRevision?: number;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface ModifySubscriptionControlRequest extends SubscriptionControlBase {
  readonly action: 'modify';
  readonly expectedScheduleRevision: number;
  readonly newPolicy: ExecutionPolicyDefinition;
  readonly newPolicyHash: string;
  readonly confirmationRef: string;
}

export interface PauseSubscriptionControlRequest extends SubscriptionControlBase {
  readonly action: 'pause';
}

export interface ResumeSubscriptionControlRequest extends SubscriptionControlBase {
  readonly action: 'resume';
}

export interface CancelFutureSubscriptionControlRequest extends SubscriptionControlBase {
  readonly action: 'cancel-future';
}

export type SubscriptionControlRequest =
  | ModifySubscriptionControlRequest
  | PauseSubscriptionControlRequest
  | ResumeSubscriptionControlRequest
  | CancelFutureSubscriptionControlRequest;

export interface SubscriptionControlReceipt {
  readonly subscriptionId: string;
  readonly action: SubscriptionControlRequest['action'];
  readonly status: 'applied' | 'duplicate' | 'stale' | 'conflict';
  readonly policyRevision: number;
  readonly scheduleRevision: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly supersededUnclaimedOccurrences: readonly string[];
  readonly controlRef: string;
}

export interface ConfirmedRequirementRevision {
  readonly draftId: string;
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly confirmationRef: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

export type DraftRevisionState = 'draft' | 'confirmed' | 'submitted' | 'rejected' | 'stale';

export interface DraftRevisionRef {
  readonly draftId: string;
  readonly revisionVersion: number;
  readonly revisionHash: string;
}

export interface DraftRevision {
  readonly draftId: string;
  readonly revisionVersion: number;
  readonly inputRevision: number;
  readonly goal: string;
  readonly scope: string;
  readonly constraints: readonly string[];
  readonly deliverables: readonly string[];
  readonly normalizedInput: string;
  readonly proposedIntent: RequirementIntent;
  readonly proposal: string;
  readonly matchedTasks: readonly string[];
  readonly knownFacts: readonly string[];
  readonly executionControlRef?: string;
  readonly decisionRefs: readonly string[];
  readonly supersededBy?: string;
  readonly staleReason?: string;
  readonly state: DraftRevisionState;
  readonly history: readonly DraftRevisionRef[];
  readonly revisionHash: string;
  readonly immutableOriginalRef: string;
  readonly previousRevisionRef?: string;
}

export interface DraftRevisionInput {
  readonly draftId: string;
  readonly baseRevisionVersion: number;
  readonly requestedRevisionHash: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly instructionRef: string;
  readonly idempotencyKey: string;
}

export interface PreviewContext {
  readonly requestKind: 'new-task-preview';
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly authorized: false;
}

export interface DraftPreviewReceipt {
  readonly previewId: string;
  readonly interactionId: string;
  readonly draftId: string;
  readonly revisionVersion: number;
  readonly revisionHash: string;
  readonly createdAt: string;
  readonly authorized: false;
  readonly context: PreviewContext;
}

export interface DraftConfirmation {
  readonly confirmationRef: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly payloadRef: string;
  readonly draftId: string;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
  readonly interactionId: string;
}

export interface FinalSubmit {
  readonly interactionId: string;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
  readonly confirmationRef: string;
  readonly idempotencyKey: string;
  readonly requestKind: 'new-task-create';
}

export interface AuthorizedRequirement {
  readonly requirementId: string;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
  readonly confirmationRef: string;
  readonly fifoSeq: number;
  readonly payloadRef: string;
}

export interface ExistingTaskChangeSubmit {
  readonly interactionId: string;
  readonly taskId: TaskId;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
  readonly confirmationRef: string;
  readonly idempotencyKey: string;
  readonly requestKind: 'existing-task-change';
}

export interface DraftRejectClosure {
  readonly rejectionId: string;
  readonly reason: string;
  readonly closedAt: string;
  readonly durable: true;
  readonly draftId: string;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
}

export type DraftRevisionFailureCode =
  | 'stale-revision'
  | 'revision-hash-mismatch'
  | 'confirmation-stale'
  | 'unauthorized-final-submit'
  | 'duplicate-submit'
  | 'invalid-refinement';

export interface DraftRevisionFailure {
  readonly code: DraftRevisionFailureCode;
  readonly message: string;
  readonly draftId: string;
  readonly expectedRevisionVersion?: number;
  readonly expectedRevisionHash?: string;
  readonly actualRevisionVersion?: number;
  readonly actualRevisionHash?: string;
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

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

function stringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new ContractError(`${label} must be a non-empty string array`);
  }
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  return Number.isFinite(Date.parse(value));
}

function canonicalInstant(value: unknown, label: string): asserts value is string {
  if (!isCanonicalInstant(value)) throw new ContractError(`${label} must be a canonical UTC instant`);
}

function assertNoField(value: Record<string, unknown>, field: string, label: string): void {
  if (value[field] !== undefined) throw new ContractError(`${label} does not accept ${field}`);
}

export function canonicalJsonStringify(value: unknown): string {
  const visit = (candidate: unknown): string => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new ContractError('canonical JSON does not accept non-finite numbers');
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) return `[${candidate.map(visit).join(',')}]`;
    if (typeof candidate === 'object') {
      const entries = Object.entries(candidate as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${visit(nested)}`).join(',')}}`;
    }
    throw new ContractError('canonical JSON only accepts JSON values');
  };
  return visit(value);
}

export function validateExecutionPolicyDefinition(input: ExecutionPolicyDefinition): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractError('execution policy must be an object');
  }
  const value = input as unknown as Record<string, unknown>;
  nonEmpty(typeof value.policyId === 'string' ? value.policyId : undefined, 'execution policy policyId');
  positiveInteger(value.policyRevision, 'execution policy policyRevision');
  if (value.verificationProfileRef !== undefined) {
    nonEmpty(
      typeof value.verificationProfileRef === 'string' ? value.verificationProfileRef : undefined,
      'execution policy verificationProfileRef',
    );
  }
  const timezone = typeof value.timezone === 'string' ? value.timezone : '';
  nonEmpty(timezone, 'execution policy timezone');
  if (!isIanaTimeZone(timezone)) throw new ContractError(`execution policy timezone is not a valid IANA zone: ${timezone}`);
  canonicalInstant(value.canonicalInstant, 'execution policy canonicalInstant');
  includesValue(['wall', 'absolute'] as const, value.dstMode, 'execution policy dstMode');
  includesValue(['shift-forward'] as const, value.dstMissedPolicy, 'execution policy dstMissedPolicy');
  includesValue(['earlier-offset'] as const, value.dstAmbiguousPolicy, 'execution policy dstAmbiguousPolicy');
  includesValue(['run-once', 'skip'] as const, value.latePolicy, 'execution policy latePolicy');
  includesValue(['skip', 'idle-reminder'] as const, value.busyPolicy, 'execution policy busyPolicy');
  includesValue(['once', 'scheduled', 'recurring'] as const, value.executionMode, 'execution policy executionMode');

  if (value.executionMode === 'once') {
    assertNoField(value, 'startAt', 'once policy');
    assertNoField(value, 'endAt', 'once policy');
    assertNoField(value, 'maxOccurrences', 'once policy');
    assertNoField(value, 'frequency', 'once policy');
    assertNoField(value, 'intervalMinutes', 'once policy');
    assertNoField(value, 'timeOfDay', 'once policy');
    assertNoField(value, 'weekDays', 'once policy');
    canonicalInstant(value.dueAt, 'once policy dueAt');
    return;
  }

  canonicalInstant(value.startAt, `${value.executionMode} policy startAt`);
  if (value.endAt !== undefined) {
    canonicalInstant(value.endAt, `${value.executionMode} policy endAt`);
    if (Date.parse(value.endAt) <= Date.parse(value.startAt as string)) {
      throw new ContractError(`${value.executionMode} policy endAt must be later than startAt`);
    }
  }
  if (value.maxOccurrences !== undefined) {
    positiveInteger(value.maxOccurrences, 'execution policy maxOccurrences');
  }

  if (value.executionMode === 'scheduled') {
    assertNoField(value, 'frequency', 'scheduled policy');
    assertNoField(value, 'intervalMinutes', 'scheduled policy');
    assertNoField(value, 'timeOfDay', 'scheduled policy');
    assertNoField(value, 'weekDays', 'scheduled policy');
    return;
  }

  includesValue(['interval', 'daily', 'weekly'] as const, value.frequency, 'recurring policy frequency');
  if (value.frequency === 'interval') {
    positiveInteger(value.intervalMinutes, 'recurring intervalMinutes');
    assertNoField(value, 'timeOfDay', 'interval policy');
    assertNoField(value, 'weekDays', 'interval policy');
    return;
  }
  assertNoField(value, 'intervalMinutes', `${value.frequency} policy`);
  const timeOfDay = typeof value.timeOfDay === 'string' ? value.timeOfDay : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)) {
    throw new ContractError(`${value.frequency} policy timeOfDay must be HH:mm`);
  }
  if (value.frequency === 'weekly') {
    if (!Array.isArray(value.weekDays) || value.weekDays.length === 0) {
      throw new ContractError('weekly policy weekDays must be a non-empty array');
    }
    const weekDays = value.weekDays as readonly unknown[];
    if (weekDays.some((day) => !Number.isSafeInteger(day) || (day as number) < 0 || (day as number) > 6)
      || new Set(weekDays).size !== weekDays.length) {
      throw new ContractError('weekly policy weekDays must contain unique integers from 0 to 6');
    }
  } else {
    assertNoField(value, 'weekDays', 'daily policy');
  }
}

export function validateSubscriptionControlRequest(input: unknown): asserts input is SubscriptionControlRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractError('subscription control request must be an object');
  }
  const value = input as Record<string, unknown>;
  nonEmpty(typeof value.subscriptionId === 'string' ? value.subscriptionId : undefined, 'subscription control subscriptionId');
  positiveInteger(value.expectedPolicyRevision, 'subscription control expectedPolicyRevision');
  if (value.expectedScheduleRevision !== undefined) {
    positiveInteger(value.expectedScheduleRevision, 'subscription control expectedScheduleRevision');
  }
  nonEmpty(typeof value.idempotencyKey === 'string' ? value.idempotencyKey : undefined, 'subscription control idempotencyKey');
  canonicalInstant(value.requestedAt, 'subscription control requestedAt');
  includesValue(['modify', 'pause', 'resume', 'cancel-future'] as const, value.action, 'subscription control action');

  if (value.action !== 'modify') {
    assertNoField(value, 'newPolicy', `${value.action} control`);
    assertNoField(value, 'newPolicyHash', `${value.action} control`);
    assertNoField(value, 'confirmationRef', `${value.action} control`);
    return;
  }

  positiveInteger(value.expectedScheduleRevision, 'modify control expectedScheduleRevision');
  nonEmpty(typeof value.newPolicyHash === 'string' ? value.newPolicyHash : undefined, 'modify control newPolicyHash');
  nonEmpty(typeof value.confirmationRef === 'string' ? value.confirmationRef : undefined, 'modify control confirmationRef');
  validateExecutionPolicyDefinition(value.newPolicy as ExecutionPolicyDefinition);
}

export function subscriptionControlRequestFingerprint(input: SubscriptionControlRequest): string {
  validateSubscriptionControlRequest(input);
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as unknown as Record<string, unknown>)) {
    if (key !== 'idempotencyKey') content[key] = value;
  }
  return canonicalJsonStringify(content);
}

export function validateSubscriptionControlReceipt(input: SubscriptionControlReceipt): void {
  nonEmpty(input.subscriptionId, 'subscription control receipt subscriptionId');
  includesValue(['modify', 'pause', 'resume', 'cancel-future'] as const, input.action, 'subscription control receipt action');
  includesValue(['applied', 'duplicate', 'stale', 'conflict'] as const, input.status, 'subscription control receipt status');
  positiveInteger(input.policyRevision, 'subscription control receipt policyRevision');
  positiveInteger(input.scheduleRevision, 'subscription control receipt scheduleRevision');
  nonEmpty(input.idempotencyKey, 'subscription control receipt idempotencyKey');
  nonEmpty(input.requestHash, 'subscription control receipt requestHash');
  stringArray(input.supersededUnclaimedOccurrences, 'subscription control receipt supersededUnclaimedOccurrences');
  nonEmpty(input.controlRef, 'subscription control receipt controlRef');
}

export function validateDraftRevision(input: DraftRevision): void {
  nonEmpty(input.draftId, 'draftId');
  positiveInteger(input.revisionVersion, 'draft revisionVersion');
  positiveInteger(input.inputRevision, 'draft inputRevision');
  nonEmpty(input.goal, 'draft goal');
  nonEmpty(input.scope, 'draft scope');
  stringArray(input.constraints, 'draft constraints');
  stringArray(input.deliverables, 'draft deliverables');
  nonEmpty(input.normalizedInput, 'draft normalizedInput');
  includesValue(['append', 'change', 'create'] as const, input.proposedIntent, 'draft proposedIntent');
  nonEmpty(input.proposal, 'draft proposal');
  stringArray(input.matchedTasks, 'draft matchedTasks');
  stringArray(input.knownFacts, 'draft knownFacts');
  if (input.executionControlRef !== undefined) nonEmpty(input.executionControlRef, 'draft executionControlRef');
  stringArray(input.decisionRefs, 'draft decisionRefs');
  if (input.supersededBy !== undefined) nonEmpty(input.supersededBy, 'draft supersededBy');
  if (input.staleReason !== undefined) nonEmpty(input.staleReason, 'draft staleReason');
  includesValue(['draft', 'confirmed', 'submitted', 'rejected', 'stale'] as const, input.state, 'draft state');
  if (!Array.isArray(input.history)) throw new ContractError('draft history must be an array');
  for (const revision of input.history) validateDraftRevisionRef(revision);
  nonEmpty(input.revisionHash, 'draft revisionHash');
  nonEmpty(input.immutableOriginalRef, 'draft immutableOriginalRef');
  if (input.previousRevisionRef !== undefined) nonEmpty(input.previousRevisionRef, 'draft previousRevisionRef');
}

function validateDraftRevisionRef(input: DraftRevisionRef): void {
  nonEmpty(input.draftId, 'draft history draftId');
  positiveInteger(input.revisionVersion, 'draft history revisionVersion');
  nonEmpty(input.revisionHash, 'draft history revisionHash');
}

export function validateDraftRevisionInput(input: DraftRevisionInput): void {
  nonEmpty(input.draftId, 'draft input draftId');
  positiveInteger(input.baseRevisionVersion, 'draft input baseRevisionVersion');
  nonEmpty(input.requestedRevisionHash, 'draft input requestedRevisionHash');
  if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) {
    throw new ContractError('draft input fields must be an object');
  }
  nonEmpty(input.instructionRef, 'draft input instructionRef');
  nonEmpty(input.idempotencyKey, 'draft input idempotencyKey');
}

function validatePreviewContext(input: PreviewContext): void {
  if (input.requestKind !== 'new-task-preview' || input.authorized !== false) {
    throw new ContractError('preview context must be unauthorized new-task-preview');
  }
  nonEmpty(input.interactionId, 'preview context interactionId');
  positiveInteger(input.inputRevision, 'preview context inputRevision');
  nonEmpty(input.sourceRef, 'preview context sourceRef');
  nonEmpty(input.channelId, 'preview context channelId');
  canonicalInstant(input.createdAt, 'preview context createdAt');
}

export function validateDraftPreviewReceipt(input: DraftPreviewReceipt): void {
  nonEmpty(input.previewId, 'previewId');
  nonEmpty(input.interactionId, 'preview interactionId');
  nonEmpty(input.draftId, 'preview draftId');
  positiveInteger(input.revisionVersion, 'preview revisionVersion');
  nonEmpty(input.revisionHash, 'preview revisionHash');
  canonicalInstant(input.createdAt, 'preview createdAt');
  if (input.authorized !== false) throw new ContractError('preview cannot carry authorization');
  validatePreviewContext(input.context);
}

export function validateDraftConfirmation(input: DraftConfirmation): void {
  nonEmpty(input.confirmationRef, 'confirmationRef');
  nonEmpty(input.confirmedBy, 'confirmedBy');
  canonicalInstant(input.confirmedAt, 'confirmedAt');
  nonEmpty(input.payloadRef, 'confirmation payloadRef');
  nonEmpty(input.draftId, 'confirmation draftId');
  positiveInteger(input.draftRevisionVersion, 'confirmation draftRevisionVersion');
  nonEmpty(input.draftRevisionHash, 'confirmation draftRevisionHash');
  nonEmpty(input.interactionId, 'confirmation interactionId');
}

export function validateFinalSubmit(input: FinalSubmit): void {
  if (input.requestKind !== 'new-task-create') throw new ContractError('new task final submit requires new-task-create');
  nonEmpty(input.interactionId, 'final submit interactionId');
  nonEmpty(input.draftId, 'final submit draftId');
  positiveInteger(input.inputRevision, 'final submit inputRevision');
  positiveInteger(input.draftRevisionVersion, 'final submit draftRevisionVersion');
  nonEmpty(input.draftRevisionHash, 'final submit draftRevisionHash');
  nonEmpty(input.confirmationRef, 'final submit confirmationRef');
  nonEmpty(input.idempotencyKey, 'final submit idempotencyKey');
}

export function validateAuthorizedRequirement(input: AuthorizedRequirement): void {
  nonEmpty(input.requirementId, 'authorized requirementId');
  nonEmpty(input.draftId, 'authorized draftId');
  positiveInteger(input.inputRevision, 'authorized inputRevision');
  positiveInteger(input.draftRevisionVersion, 'authorized draftRevisionVersion');
  nonEmpty(input.draftRevisionHash, 'authorized draftRevisionHash');
  nonEmpty(input.confirmationRef, 'authorized confirmationRef');
  positiveInteger(input.fifoSeq, 'authorized fifoSeq');
  nonEmpty(input.payloadRef, 'authorized payloadRef');
}

export function validateExistingTaskChangeSubmit(input: ExistingTaskChangeSubmit): void {
  if (input.requestKind !== 'existing-task-change') {
    throw new ContractError('existing task change requires existing-task-change');
  }
  nonEmpty(input.interactionId, 'existing change interactionId');
  if (input.taskId.scope !== 'task' || !input.taskId.value.trim()) {
    throw new ContractError('existing change taskId must be a non-empty task id');
  }
  nonEmpty(input.draftId, 'existing change draftId');
  positiveInteger(input.inputRevision, 'existing change inputRevision');
  positiveInteger(input.draftRevisionVersion, 'existing change draftRevisionVersion');
  nonEmpty(input.draftRevisionHash, 'existing change draftRevisionHash');
  nonEmpty(input.confirmationRef, 'existing change confirmationRef');
  nonEmpty(input.idempotencyKey, 'existing change idempotencyKey');
}

export function validateDraftRejectClosure(input: DraftRejectClosure): void {
  nonEmpty(input.rejectionId, 'rejectionId');
  nonEmpty(input.reason, 'rejection reason');
  canonicalInstant(input.closedAt, 'rejection closedAt');
  if (input.durable !== true) throw new ContractError('rejection closure must be durable');
  nonEmpty(input.draftId, 'rejection draftId');
  positiveInteger(input.draftRevisionVersion, 'rejection draftRevisionVersion');
  nonEmpty(input.draftRevisionHash, 'rejection draftRevisionHash');
}

export function validateDraftRevisionFailure(input: DraftRevisionFailure): void {
  includesValue([
    'stale-revision',
    'revision-hash-mismatch',
    'confirmation-stale',
    'unauthorized-final-submit',
    'duplicate-submit',
    'invalid-refinement',
  ] as const, input.code, 'draft revision failure code');
  nonEmpty(input.message, 'draft revision failure message');
  nonEmpty(input.draftId, 'draft revision failure draftId');
  if (input.expectedRevisionVersion !== undefined) positiveInteger(input.expectedRevisionVersion, 'failure expectedRevisionVersion');
  if (input.expectedRevisionHash !== undefined) nonEmpty(input.expectedRevisionHash, 'failure expectedRevisionHash');
  if (input.actualRevisionVersion !== undefined) positiveInteger(input.actualRevisionVersion, 'failure actualRevisionVersion');
  if (input.actualRevisionHash !== undefined) nonEmpty(input.actualRevisionHash, 'failure actualRevisionHash');
}

export function validateToolIntent(input: ToolIntent): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractError('tool intent must be an object');
  }
  const value = input as unknown as Record<string, unknown>;
  nonEmpty(typeof value.toolIntentId === 'string' ? value.toolIntentId : undefined, 'toolIntentId');
  nonEmpty(typeof value.toolRef === 'string' ? value.toolRef : undefined, 'toolRef');
  nonEmpty(typeof value.argumentsDigest === 'string' ? value.argumentsDigest : undefined, 'tool arguments digest');
  nonEmpty(typeof value.selectedBecause === 'string' ? value.selectedBecause : undefined, 'tool selectedBecause');
  if (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) {
    throw new ContractError('tool arguments must be an object');
  }
  if (!Array.isArray(value.reasonRefs) || value.reasonRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
    throw new ContractError('tool reasonRefs must be a string array');
  }
  if (!(EXPLICIT_BRAIN_MODEL_TOOLS as readonly string[]).includes(String(value.toolRef))) {
    throw new ContractError(`tool is not registered for explicit brain: ${String(value.toolRef)}`);
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
