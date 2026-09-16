import type {
  AgentCapabilities,
  AgentClosure,
  AgentStartRequest,
  CheckpointId,
  EvidenceRef,
  NextAction,
  OperationId,
  ScopeRef,
  TaskId,
} from './index.js';
import { assertEvidenceRef, assertNextAction } from './index.js';
import { ContractError } from './errors.js';

export type AgentMessageClass = 'control' | 'data' | 'observation';
export type PermissionRevision = string;

export function isAgentMessageClass(value: unknown): value is AgentMessageClass {
  return value === 'control' || value === 'data' || value === 'observation';
}

export interface RuntimeBinding {
  readonly runtimeId: string;
  readonly agentInstanceId: string;
  readonly roleId: string;
  readonly taskId?: TaskId;
  readonly assignmentId?: string;
  readonly interactionScopeId?: string;
  readonly executionEpoch: number;
  readonly scopeRef: string;
  readonly permissionRevision: string;
  readonly capabilityDigest: string;
  readonly providerBindingId: string;
  readonly providerBindingDigest: string;
  readonly bindingDigest: string;
}

export interface AgentProviderBinding {
  readonly bindingId: string;
  readonly providerId: string;
  readonly protocol: string;
  readonly endpointRef: string;
  readonly modelRef: string;
  readonly configDigest: string;
  readonly capabilityDigest: string;
  readonly bindingDigest: string;
  readonly owner: string;
  readonly selectionReason?: string;
}

export type AgentBinding =
  | {
      readonly kind: 'interaction';
      readonly interactionScopeId: string;
      readonly bindingFingerprint: string;
    }
  | {
      readonly kind: 'task';
      readonly taskId: TaskId;
      readonly assignmentId: string;
      readonly executionEpoch: number;
      readonly bindingFingerprint: string;
    };

export interface AgentRequestControl {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly attemptId: string;
  readonly binding: AgentBinding;
  readonly providerBinding: AgentProviderBinding;
  readonly contextViewRef: string;
  readonly permissionRevision: string;
  readonly idempotencyKey: string;
  readonly replyMode: 'terminal' | 'stream';
}

export interface AgentRequestEnvelope {
  readonly version: 1;
  readonly control: AgentRequestControl;
  readonly data: {
    readonly inputRefs: readonly string[];
    readonly outputContractRef: string;
    readonly capabilitySetRef: string;
    readonly memoryRecallRefs?: readonly string[];
  };
}

export type AgentDriverReceiptStatus = 'accepted' | 'rejected' | 'unknown';

export interface AgentDriverRequestIdentity {
  readonly requestId: string;
  readonly attemptId: string;
  readonly runtimeId: string;
  readonly executionEpoch: number;
}

export interface AgentDriverReceipt extends AgentDriverRequestIdentity {
  readonly driverRef: string;
  readonly providerSessionRef?: string;
  readonly operationRef?: string;
  readonly status: AgentDriverReceiptStatus;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AgentDriverStartRequest extends AgentStartRequest, AgentDriverRequestIdentity {
  readonly mode?: 'fresh' | 'resume';
  readonly checkpointId?: CheckpointId;
}

export interface AgentDispatchReceipt extends AgentDriverRequestIdentity {
  readonly driverRef: string;
  readonly operationRef?: string;
  readonly status: AgentDriverReceiptStatus;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AgentObserveRequest {
  readonly runtimeId: string;
  readonly cursor?: string;
}

export interface AgentObservationEvent {
  readonly requestId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly kind: string;
  readonly evidenceRefs: readonly string[];
}

export interface AgentResultRequest {
  readonly runtimeId: string;
  readonly requestId: string;
  readonly attemptId: string;
}

export interface AgentResult {
  readonly status: AgentClosure['state'];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AgentStopRequest extends AgentDriverStartRequest {
  readonly reason: string;
  readonly ownerId: string;
}

export interface AgentStopReceipt extends AgentDriverReceipt {}

export interface AgentReconcileRequest extends AgentDriverRequestIdentity {
  readonly operationRef: string;
}

export interface AgentReconcileResult extends AgentDriverReceipt {
  readonly operationRef: string;
  readonly reconciled: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AgentSettleRequest extends AgentDriverRequestIdentity {}

export interface AgentSettleReceipt extends AgentDriverReceipt {
  readonly state: AgentClosure['state'];
}

export interface AgentCloseRequest extends AgentDriverRequestIdentity {
  readonly reason: string;
}

export interface AgentCloseReceipt extends AgentDriverReceipt {
  readonly closed: boolean;
}

export interface AgentDriverV1 {
  readonly protocolVersion: 1;
  readonly kind: string;
  capabilities(): Promise<AgentCapabilities>;
  start(input: AgentDriverStartRequest): Promise<AgentDriverReceipt>;
  send(input: AgentRequestEnvelope): Promise<AgentDispatchReceipt>;
  observe(input: AgentObserveRequest): AsyncIterable<AgentObservationEvent>;
  readResult(input: AgentResultRequest): Promise<AgentResult>;
  requestStop(input: AgentStopRequest): Promise<AgentStopReceipt>;
  reconcile(input: AgentReconcileRequest): Promise<AgentReconcileResult>;
  settle(input: AgentSettleRequest): Promise<AgentSettleReceipt>;
  close(input: AgentCloseRequest): Promise<AgentCloseReceipt>;
}

export interface AgentMessageCorrelation {
  readonly taskId?: TaskId;
  readonly assignmentId?: string;
  readonly requestId?: string;
  readonly operationId?: OperationId;
  readonly parentMessageId?: string;
  readonly inputRevision?: string;
}

export interface AgentMessageEnvelope {
  readonly schemaVersion: 1;
  readonly messageId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly class: AgentMessageClass;
  readonly kind: string;
  readonly publisherBindingRef: string;
  readonly scopeRef: string;
  readonly targetRef?: string;
  readonly correlation: AgentMessageCorrelation;
  readonly payloadRef: string;
  readonly sourceFactRef: string;
  readonly capabilityRef?: string;
  readonly emittedAt: string;
}

export interface ScopeAcl {
  readonly scopeRef: string;
  readonly principalRef: string;
  readonly permissionRevision: string;
  readonly allowedCapabilities: readonly string[];
  readonly allowedMessages?: readonly AgentMessageClass[];
}

export type ScopeAclSubject = {
  readonly principalRef: string;
  readonly scopeRef: string;
  readonly permissionRevision: string;
  readonly requestedCapability?: string;
  readonly messageClass?: AgentMessageClass;
};

export type ScopeAclDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'scope-mismatch' | 'permission-revoked' | 'principal-denied' | 'capability-denied' | 'message-class-denied';
      readonly missingCapabilities?: readonly string[];
    };

export interface EventConsumerKeyInput {
  readonly consumerOwner: string;
  readonly scopeRef: string;
  readonly contractVersion: string;
}

export interface EventConsumerCursor {
  readonly consumerKey: string;
  readonly streamId: string;
  readonly lastHandledSequence: number;
}

export type EventConsumerReceiptDisposition = 'applied' | 'duplicate' | 'stale' | 'rejected' | 'terminal-failure';

export interface EventConsumerReceipt {
  readonly consumerKey: string;
  readonly messageId: string;
  readonly streamId: string;
  readonly handledSequence: number;
  readonly disposition: EventConsumerReceiptDisposition;
  readonly effectRefs: readonly string[];
  readonly failureRef?: string;
}

export interface EventHandlerCommitIntent {
  readonly consumerKey: string;
  readonly messageId: string;
  readonly disposition: EventConsumerReceiptDisposition;
  readonly completionMode: 'journal-atomic' | 'operation-barrier';
  readonly internalEffectFacts: readonly string[];
  readonly externalOperationRefs: readonly string[];
  readonly failureRef?: string;
}

export type EventRetryObligationState = 'pending' | 'exhausted' | 'cancelled';

export interface EventRetryObligation {
  readonly retryKey: string;
  readonly consumerKey: string;
  readonly messageId: string;
  readonly streamId: string;
  readonly failedSequence: number;
  readonly attempt: number;
  readonly nextAttemptAt: string;
  readonly ownerRef: string;
  readonly failureRef: string;
  readonly state: EventRetryObligationState;
}

export interface EventHandlerRetryIntent {
  readonly consumerKey: string;
  readonly messageId: string;
  readonly retryObligation: EventRetryObligation;
}

export type EventHandlerCommit = EventHandlerCommitIntent | EventHandlerRetryIntent;

export type CheckpointSource = 'agent-tool' | 'harness-control' | 'recovery';

export interface CheckpointClosureRecord {
  readonly checkpointId: CheckpointId;
  readonly source: CheckpointSource;
  readonly closureReason: string;
  readonly executionEpoch: number;
  readonly committed: boolean;
  readonly reentryAllowed: boolean;
  readonly pendingOperations: readonly string[];
  readonly unknownOperations: readonly string[];
  readonly recoveryStateRef: EvidenceRef;
  readonly nextAction: NextAction;
  readonly closedAt: string;
}

export interface CheckpointReentryRecord {
  readonly checkpointId: CheckpointId;
  readonly reentryId: string;
  readonly executionEpoch: number;
  readonly fencedEpochs: readonly number[];
  readonly permissionRevision: string;
  readonly contextViewRef: string;
  readonly entryPhase: string;
  readonly nextAction: string;
  readonly reentryRef: string;
}

export type InteractionClosureDisposition = 'confirmed' | 'rejected' | 'cancelled' | 'failed';

export interface InteractionClosure {
  readonly interactionScopeId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly disposition: InteractionClosureDisposition;
  readonly inputRefs: readonly string[];
  readonly feedbackRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly closureRef: string;
  readonly closedAt: string;
}

export type ControlProbePoint =
  | 'request-start'
  | 'after-tool-result'
  | 'before-wait'
  | 'before-checkpoint'
  | 'before-completion'
  | 'after-n-turns'
  | 'on-no-progress';

export interface ControlWatchdogPolicy {
  readonly maxSilentDurationMs: number;
  readonly maxTurnDurationMs: number;
  readonly maxTotalTurns: number;
  readonly maxTurnsBetweenProbes: number;
  readonly maxNoProgressTurns: number;
  readonly maxControlRepairAttempts: number;
}

export interface ControlProbeRecord {
  readonly runtimeRef: string;
  readonly requestRef: string;
  readonly turnRef: string;
  readonly probePoint: ControlProbePoint;
  readonly triggeredAt: string;
  readonly requiredSummary: true;
}

export type GoalStatus = 'active' | 'completed' | 'cancelled' | 'suspended';

export interface GoalRecord {
  readonly goalId: string;
  readonly scopeRef: string;
  readonly acceptedRevision: string;
  readonly status: GoalStatus;
  readonly statusReason?: string;
}
export type Goal = GoalRecord;

export type SubscriptionState = 'active' | 'completed' | 'exhausted' | 'cancelled' | 'suspended';
export type SubscriptionBusyPolicy = 'skip' | 'idle-reminder';

export interface Subscription {
  readonly subscriptionId: string;
  readonly goalId: string;
  readonly scheduleRevision: number;
  readonly state: SubscriptionState;
  readonly busyPolicy: SubscriptionBusyPolicy;
  readonly currentOccurrenceOrdinal: number;
}

export type OccurrenceState = 'due' | 'skipped-busy' | 'reminder-pending' | 'claimed' | 'consumed' | 'invalidated';

export interface Occurrence {
  readonly subscriptionId: string;
  readonly scheduleRevision: number;
  readonly occurrenceOrdinal: number;
  readonly state: OccurrenceState;
  readonly dueAt: string;
}

export type ReminderState = 'pending' | 'consumed' | 'invalidated';

export interface Reminder {
  readonly reminderId: string;
  readonly subscriptionId: string;
  readonly scheduleRevision: number;
  readonly occurrenceOrdinal: number;
  readonly state: ReminderState;
  readonly dueAt: string;
}

export type LeaseState = 'active' | 'expired' | 'released';

export interface SchedulerLease {
  readonly leaseId: string;
  readonly schedulerInstanceId: string;
  readonly generation: number;
  readonly scopeRef: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly state: LeaseState;
}
export type Lease = SchedulerLease;

export type AcpAllowedSessionKind = 'interaction' | 'task';

export interface AcpServerBinding {
  readonly bindingRef: string;
  readonly principalRef: string;
  readonly scopeRef: string;
  readonly allowedSessionKinds: readonly AcpAllowedSessionKind[];
  readonly allowedCapabilities: readonly string[];
  readonly permissionRevision: string;
  readonly bindingDigest: string;
}

export interface AcpDriverBinding {
  readonly bindingRef: string;
  readonly externalPeerRef: string;
  readonly taskId?: TaskId;
  readonly assignmentId?: string;
  readonly executionEpoch: number;
  readonly delegatedCapabilities: readonly string[];
  readonly delegationProofRef: string;
  readonly permissionRevision: string;
}

const MESSAGE_CLASSES: readonly AgentMessageClass[] = ['control', 'data', 'observation'];
const RECEIPT_DISPOSITIONS: readonly EventConsumerReceiptDisposition[] = ['applied', 'duplicate', 'stale', 'rejected', 'terminal-failure'];
const RETRY_OBLIGATION_STATES: readonly EventRetryObligationState[] = ['pending', 'exhausted', 'cancelled'];
const CHECKPOINT_SOURCES: readonly CheckpointSource[] = ['agent-tool', 'harness-control', 'recovery'];
const GOAL_STATUSES: readonly GoalStatus[] = ['active', 'completed', 'cancelled', 'suspended'];
const SUBSCRIPTION_STATES: readonly SubscriptionState[] = ['active', 'completed', 'exhausted', 'cancelled', 'suspended'];
const SUBSCRIPTION_BUSY_POLICIES: readonly SubscriptionBusyPolicy[] = ['skip', 'idle-reminder'];
const OCCURRENCE_STATES: readonly OccurrenceState[] = ['due', 'skipped-busy', 'reminder-pending', 'claimed', 'consumed', 'invalidated'];
const REMINDER_STATES: readonly ReminderState[] = ['pending', 'consumed', 'invalidated'];
const LEASE_STATES: readonly LeaseState[] = ['active', 'expired', 'released'];
const ACP_SESSION_KINDS: readonly AcpAllowedSessionKind[] = ['interaction', 'task'];
const INTERACTION_CLOSURE_DISPOSITIONS: readonly InteractionClosureDisposition[] = ['confirmed', 'rejected', 'cancelled', 'failed'];
const DRIVER_RECEIPT_STATUSES: readonly AgentDriverReceiptStatus[] = ['accepted', 'rejected', 'unknown'];
const AGENT_SETTLE_STATES: readonly AgentClosure['state'][] = [
  'succeeded',
  'waiting',
  'blocked',
  'failed',
  'cancelled',
  'stopped',
  'unknown',
];
const CONTROL_PROBE_POINTS: readonly ControlProbePoint[] = [
  'request-start',
  'after-tool-result',
  'before-wait',
  'before-checkpoint',
  'before-completion',
  'after-n-turns',
  'on-no-progress',
];

function nonEmpty(value: string | undefined, label: string): asserts value is string {
  if (!value || !value.trim()) throw new ContractError(`${label} is required`);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ContractError(`${label} must be a positive safe integer`);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContractError(`${label} must be a non-negative safe integer`);
}

function assertValidTime(value: string, label: string): void {
  nonEmpty(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new ContractError(`${label} must be a valid timestamp`);
}

function assertRefList(refs: readonly string[], label: string): void {
  for (const ref of refs) nonEmpty(ref, label);
}

function assertEvidenceRefs(refs: readonly EvidenceRef[]): void {
  for (const ref of refs) assertEvidenceRef(ref);
}

function hasTaskId(taskId: TaskId | undefined): boolean {
  return taskId !== undefined && Boolean(taskId.value.trim());
}

function assertScopedTask(taskId: TaskId | undefined, label: string): void {
  if (taskId === undefined) throw new ContractError(`${label} is required`);
  if (taskId.scope !== 'task' || !taskId.value.trim()) throw new ContractError(`${label} must be a non-empty task scoped id`);
}

export function validateRuntimeBinding(input: RuntimeBinding): void {
  nonEmpty(input.runtimeId, 'runtimeId');
  nonEmpty(input.agentInstanceId, 'agentInstanceId');
  nonEmpty(input.roleId, 'roleId');
  assertPositiveSafeInteger(input.executionEpoch, 'executionEpoch');
  nonEmpty(input.scopeRef, 'scopeRef');
  nonEmpty(input.permissionRevision, 'permissionRevision');
  nonEmpty(input.capabilityDigest, 'capabilityDigest');
  nonEmpty(input.providerBindingId, 'providerBindingId');
  nonEmpty(input.providerBindingDigest, 'providerBindingDigest');
  nonEmpty(input.bindingDigest, 'bindingDigest');

  const taskBound = hasTaskId(input.taskId) || Boolean(input.assignmentId?.trim());
  if (taskBound) {
    assertScopedTask(input.taskId, 'taskId');
    nonEmpty(input.assignmentId, 'assignmentId');
    if (input.interactionScopeId?.trim()) throw new ContractError('task-bound runtime cannot declare an interaction scope');
    return;
  }

  nonEmpty(input.interactionScopeId, 'interactionScopeId');
  if (input.taskId !== undefined || input.assignmentId !== undefined) {
    throw new ContractError('interaction-bound runtime cannot declare task or assignment identities');
  }
}

export function validateAgentProviderBinding(input: AgentProviderBinding): void {
  nonEmpty(input.bindingId, 'bindingId');
  nonEmpty(input.providerId, 'providerId');
  nonEmpty(input.protocol, 'protocol');
  nonEmpty(input.endpointRef, 'endpointRef');
  nonEmpty(input.modelRef, 'modelRef');
  nonEmpty(input.configDigest, 'configDigest');
  nonEmpty(input.capabilityDigest, 'capabilityDigest');
  nonEmpty(input.bindingDigest, 'bindingDigest');
  nonEmpty(input.owner, 'owner');
}

export function validateAgentBinding(binding: AgentBinding): void {
  if (binding.kind === 'interaction') {
    nonEmpty(binding.interactionScopeId, 'interactionScopeId');
    nonEmpty(binding.bindingFingerprint, 'bindingFingerprint');
    return;
  }
  assertScopedTask(binding.taskId, 'taskId');
  nonEmpty(binding.assignmentId, 'assignmentId');
  assertPositiveSafeInteger(binding.executionEpoch, 'executionEpoch');
  nonEmpty(binding.bindingFingerprint, 'bindingFingerprint');
}

export function validateAgentRequestControl(input: AgentRequestControl): void {
  if (input.protocolVersion !== 1) throw new ContractError('protocolVersion must be 1');
  nonEmpty(input.requestId, 'requestId');
  nonEmpty(input.attemptId, 'attemptId');
  validateAgentBinding(input.binding);
  validateAgentProviderBinding(input.providerBinding);
  nonEmpty(input.contextViewRef, 'contextViewRef');
  nonEmpty(input.permissionRevision, 'permissionRevision');
  nonEmpty(input.idempotencyKey, 'idempotencyKey');
  if (input.replyMode !== 'terminal' && input.replyMode !== 'stream') throw new ContractError('replyMode must be terminal or stream');
}

export function validateAgentRequestEnvelope(input: AgentRequestEnvelope): void {
  if (input.version !== 1) throw new ContractError('AgentRequestEnvelope version must be 1');
  validateAgentRequestControl(input.control);
  assertRefList(input.data.inputRefs, 'data.inputRefs');
  nonEmpty(input.data.outputContractRef, 'data.outputContractRef');
  nonEmpty(input.data.capabilitySetRef, 'data.capabilitySetRef');
  if (input.data.memoryRecallRefs !== undefined) assertRefList(input.data.memoryRecallRefs, 'data.memoryRecallRefs');
}

export function validateAgentDriverReceipt(input: AgentDriverReceipt): void {
  nonEmpty(input.requestId, 'requestId');
  nonEmpty(input.attemptId, 'attemptId');
  nonEmpty(input.runtimeId, 'runtimeId');
  assertPositiveSafeInteger(input.executionEpoch, 'executionEpoch');
  nonEmpty(input.driverRef, 'driverRef');
  if (input.providerSessionRef !== undefined) nonEmpty(input.providerSessionRef, 'providerSessionRef');
  if (input.operationRef !== undefined) nonEmpty(input.operationRef, 'operationRef');
  if (!DRIVER_RECEIPT_STATUSES.includes(input.status)) throw new ContractError(`unknown driver receipt status: ${input.status}`);
  validateEvidenceRefs(input.evidenceRefs, 'evidenceRefs');
  if (input.status === 'unknown' && input.operationRef === undefined) {
    throw new ContractError('unknown driver receipt requires an operation reference for reconcile');
  }
}

export function validateAgentDispatchReceipt(input: AgentDispatchReceipt): void {
  nonEmpty(input.requestId, 'requestId');
  nonEmpty(input.attemptId, 'attemptId');
  nonEmpty(input.runtimeId, 'runtimeId');
  assertPositiveSafeInteger(input.executionEpoch, 'executionEpoch');
  nonEmpty(input.driverRef, 'driverRef');
  if (input.operationRef !== undefined) nonEmpty(input.operationRef, 'operationRef');
  if (!DRIVER_RECEIPT_STATUSES.includes(input.status)) throw new ContractError(`unknown driver receipt status: ${input.status}`);
  assertEvidenceRefs(input.evidenceRefs);
  if (input.status === 'unknown' && input.operationRef === undefined) {
    throw new ContractError('unknown dispatch receipt requires an operation reference for reconcile');
  }
}

export function validateAgentObservationEvent(input: AgentObservationEvent): void {
  nonEmpty(input.requestId, 'requestId');
  nonEmpty(input.attemptId, 'attemptId');
  assertPositiveSafeInteger(input.sequence, 'sequence');
  nonEmpty(input.cursor, 'cursor');
  nonEmpty(input.kind, 'kind');
  assertRefList(input.evidenceRefs, 'evidenceRefs');
}

export function validateAgentResult(input: AgentResult): void {
  if (!AGENT_SETTLE_STATES.includes(input.status)) throw new ContractError(`unknown agent result status: ${input.status}`);
  assertEvidenceRefs(input.evidenceRefs);
}

export function validateAgentStopReceipt(input: AgentStopReceipt): void {
  validateAgentDriverReceipt(input);
  if (typeof input.accepted !== 'boolean') throw new ContractError('accepted must be a boolean');
}

export function validateAgentReconcileResult(input: AgentReconcileResult): void {
  validateAgentDriverReceipt(input);
  nonEmpty(input.operationRef, 'operationRef');
  assertEvidenceRefs(input.evidenceRefs);
}

export function validateAgentSettleReceipt(input: AgentSettleReceipt): void {
  validateAgentDriverReceipt(input);
  if (!AGENT_SETTLE_STATES.includes(input.state)) throw new ContractError(`unknown agent settle state: ${input.state}`);
  assertEvidenceRefs(input.evidenceRefs);
}

export function validateAgentCloseReceipt(input: AgentCloseReceipt): void {
  validateAgentDriverReceipt(input);
  if (typeof input.closed !== 'boolean') throw new ContractError('closed must be a boolean');
  assertEvidenceRefs(input.evidenceRefs);
}

export function validateAgentMessageEnvelope(input: AgentMessageEnvelope): void {
  if (input.schemaVersion !== 1) throw new ContractError('AgentMessageEnvelope schemaVersion must be 1');
  nonEmpty(input.messageId, 'messageId');
  nonEmpty(input.streamId, 'streamId');
  assertPositiveSafeInteger(input.sequence, 'sequence');
  if (!MESSAGE_CLASSES.includes(input.class)) throw new ContractError(`unknown agent message class: ${input.class as string}`);
  nonEmpty(input.kind, 'kind');
  nonEmpty(input.publisherBindingRef, 'publisherBindingRef');
  nonEmpty(input.scopeRef, 'scopeRef');
  nonEmpty(input.payloadRef, 'payloadRef');
  nonEmpty(input.sourceFactRef, 'sourceFactRef');
  assertValidTime(input.emittedAt, 'emittedAt');
  if (input.targetRef !== undefined) nonEmpty(input.targetRef, 'targetRef');
  if (input.capabilityRef !== undefined) nonEmpty(input.capabilityRef, 'capabilityRef');
  if (input.correlation.assignmentId !== undefined) nonEmpty(input.correlation.assignmentId, 'correlation.assignmentId');
  if (input.correlation.requestId !== undefined) nonEmpty(input.correlation.requestId, 'correlation.requestId');
  if (input.correlation.parentMessageId !== undefined) nonEmpty(input.correlation.parentMessageId, 'correlation.parentMessageId');
  if (input.correlation.inputRevision !== undefined) nonEmpty(input.correlation.inputRevision, 'correlation.inputRevision');
  if (input.correlation.taskId !== undefined) assertScopedTask(input.correlation.taskId, 'correlation.taskId');
  if (input.correlation.operationId !== undefined) {
    if (input.correlation.operationId.scope !== 'operation' || !input.correlation.operationId.value.trim()) {
      throw new ContractError('correlation.operationId must be a non-empty operation scoped id');
    }
  }
}

export function validateScopeAcl(input: ScopeAcl): void {
  nonEmpty(input.scopeRef, 'scopeRef');
  nonEmpty(input.principalRef, 'principalRef');
  nonEmpty(input.permissionRevision, 'permissionRevision');
  for (const capability of input.allowedCapabilities) nonEmpty(capability, 'allowedCapabilities entry');
  if (input.allowedMessages !== undefined) {
    for (const messageClass of input.allowedMessages) {
      if (!MESSAGE_CLASSES.includes(messageClass)) throw new ContractError(`unknown ACL message class: ${messageClass}`);
    }
  }
}

export function checkScopeAcl(acl: ScopeAcl, subject: ScopeAclSubject): ScopeAclDecision {
  validateScopeAcl(acl);
  nonEmpty(subject.principalRef, 'subject principalRef');
  nonEmpty(subject.scopeRef, 'subject scopeRef');
  nonEmpty(subject.permissionRevision, 'subject permissionRevision');
  if (acl.principalRef !== subject.principalRef) {
    return { allowed: false, reason: 'principal-denied' };
  }
  if (acl.scopeRef !== subject.scopeRef) {
    return { allowed: false, reason: 'scope-mismatch' };
  }
  if (acl.permissionRevision !== subject.permissionRevision) {
    return { allowed: false, reason: 'permission-revoked' };
  }
  if (subject.requestedCapability !== undefined && !acl.allowedCapabilities.includes(subject.requestedCapability)) {
    return { allowed: false, reason: 'capability-denied', missingCapabilities: [subject.requestedCapability] };
  }
  if (subject.messageClass !== undefined && acl.allowedMessages !== undefined && !acl.allowedMessages.includes(subject.messageClass)) {
    return { allowed: false, reason: 'message-class-denied' };
  }
  return { allowed: true };
}

export function assertScopeAcl(acl: ScopeAcl, subject: ScopeAclSubject): void {
  const decision = checkScopeAcl(acl, subject);
  if (!decision.allowed) {
    throw new ContractError(`scope ACL denied: ${decision.reason}`);
  }
}

export function assertPermissionRevisionMatches(current: string, expected: string): void {
  nonEmpty(current, 'current permissionRevision');
  nonEmpty(expected, 'expected permissionRevision');
  if (current !== expected) throw new ContractError(`permission revision mismatch: ${expected} expected, received ${current}`);
}

export function consumerKey(input: EventConsumerKeyInput): string {
  nonEmpty(input.consumerOwner, 'consumerOwner');
  nonEmpty(input.scopeRef, 'scopeRef');
  nonEmpty(input.contractVersion, 'contractVersion');
  return `${input.consumerOwner}::${input.scopeRef}::${input.contractVersion}`;
}

export function validateEventConsumerCursor(input: EventConsumerCursor): void {
  nonEmpty(input.consumerKey, 'consumerKey');
  nonEmpty(input.streamId, 'streamId');
  assertNonNegativeSafeInteger(input.lastHandledSequence, 'lastHandledSequence');
}

export function validateEventConsumerReceipt(input: EventConsumerReceipt): void {
  nonEmpty(input.consumerKey, 'consumerKey');
  nonEmpty(input.messageId, 'messageId');
  nonEmpty(input.streamId, 'streamId');
  assertPositiveSafeInteger(input.handledSequence, 'handledSequence');
  if (!RECEIPT_DISPOSITIONS.includes(input.disposition)) throw new ContractError(`unknown consumer receipt disposition: ${input.disposition}`);
  assertRefList(input.effectRefs, 'effectRefs');
  if (input.disposition === 'applied' && input.effectRefs.length === 0) throw new ContractError('applied consumer receipt requires effect refs');
  if (input.disposition === 'terminal-failure') nonEmpty(input.failureRef, 'failureRef');
}

export function validateEventRetryObligation(input: EventRetryObligation): void {
  nonEmpty(input.retryKey, 'retryKey');
  nonEmpty(input.consumerKey, 'consumerKey');
  nonEmpty(input.messageId, 'messageId');
  nonEmpty(input.streamId, 'streamId');
  assertPositiveSafeInteger(input.failedSequence, 'failedSequence');
  assertPositiveSafeInteger(input.attempt, 'attempt');
  assertValidTime(input.nextAttemptAt, 'nextAttemptAt');
  nonEmpty(input.ownerRef, 'ownerRef');
  nonEmpty(input.failureRef, 'failureRef');
  if (!RETRY_OBLIGATION_STATES.includes(input.state)) throw new ContractError(`unknown retry obligation state: ${input.state}`);
}

export function validateEventHandlerCommit(input: EventHandlerCommit): void {
  nonEmpty(input.consumerKey, 'consumerKey');
  nonEmpty(input.messageId, 'messageId');
  if ('retryObligation' in input) {
    validateEventRetryObligation(input.retryObligation);
    if (input.retryObligation.consumerKey !== input.consumerKey || input.retryObligation.messageId !== input.messageId) {
      throw new ContractError('retry obligation must match handler commit identity');
    }
    if (input.retryObligation.state !== 'pending') {
      throw new ContractError('retry intent requires a pending retry obligation');
    }
    return;
  }
  if (!RECEIPT_DISPOSITIONS.includes(input.disposition)) throw new ContractError(`unknown handler commit disposition: ${input.disposition}`);
  if (input.completionMode !== 'journal-atomic' && input.completionMode !== 'operation-barrier') {
    throw new ContractError('completionMode must be journal-atomic or operation-barrier');
  }
  assertRefList(input.internalEffectFacts, 'internalEffectFacts');
  assertRefList(input.externalOperationRefs, 'externalOperationRefs');
  if (input.completionMode === 'journal-atomic' && input.externalOperationRefs.length !== 0) {
    throw new ContractError('journal-atomic commit cannot carry external operation refs');
  }
  if (input.completionMode === 'operation-barrier' && input.externalOperationRefs.length === 0) {
    throw new ContractError('operation-barrier commit requires external operation refs');
  }
  if (input.disposition === 'terminal-failure') nonEmpty(input.failureRef, 'failureRef');
}

export function validateCheckpointClosureRecord(input: CheckpointClosureRecord): void {
  if (input.checkpointId.scope !== 'checkpoint' || !input.checkpointId.value.trim()) throw new ContractError('checkpointId must be a non-empty checkpoint scoped id');
  if (!CHECKPOINT_SOURCES.includes(input.source)) throw new ContractError(`unknown checkpoint source: ${input.source}`);
  nonEmpty(input.closureReason, 'closureReason');
  assertPositiveSafeInteger(input.executionEpoch, 'executionEpoch');
  assertValidTime(input.closedAt, 'closedAt');
  assertRefList(input.pendingOperations, 'pendingOperations');
  assertRefList(input.unknownOperations, 'unknownOperations');
  if (input.reentryAllowed && !input.committed) {
    throw new ContractError('uncommitted closure cannot allow reentry');
  }
  if (input.unknownOperations.length > 0 && input.reentryAllowed) {
    throw new ContractError('unknown operations block reentry');
  }
  if (!input.recoveryStateRef.source.trim() || !input.recoveryStateRef.locator.trim()) {
    throw new ContractError('recoveryStateRef must identify source and locator');
  }
  assertNextAction(input.nextAction);
  if (!input.nextAction.ref?.trim() && input.nextAction.kind !== 'continue') {
    throw new ContractError('closure next action requires a reference for non-continue actions');
  }
}

export function validateCheckpointReentryRecord(input: CheckpointReentryRecord): void {
  if (input.checkpointId.scope !== 'checkpoint' || !input.checkpointId.value.trim()) throw new ContractError('checkpointId must be a non-empty checkpoint scoped id');
  nonEmpty(input.reentryId, 'reentryId');
  assertPositiveSafeInteger(input.executionEpoch, 'executionEpoch');
  nonEmpty(input.permissionRevision, 'permissionRevision');
  nonEmpty(input.contextViewRef, 'contextViewRef');
  nonEmpty(input.entryPhase, 'entryPhase');
  nonEmpty(input.nextAction, 'nextAction');
  nonEmpty(input.reentryRef, 'reentryRef');
  for (const epoch of input.fencedEpochs) {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch >= input.executionEpoch) {
      throw new ContractError('fencedEpochs must precede the reentry execution epoch');
    }
  }
}

export function validateInteractionClosure(input: InteractionClosure): void {
  nonEmpty(input.interactionScopeId, 'interactionScopeId');
  nonEmpty(input.requestId, 'requestId');
  nonEmpty(input.attemptId, 'attemptId');
  if (!INTERACTION_CLOSURE_DISPOSITIONS.includes(input.disposition)) {
    throw new ContractError(`unknown interaction closure disposition: ${input.disposition}`);
  }
  assertRefList(input.inputRefs, 'inputRefs');
  assertRefList(input.feedbackRefs, 'feedbackRefs');
  validateEvidenceRefs(input.evidenceRefs, 'evidenceRefs');
  nonEmpty(input.closureRef, 'closureRef');
  assertValidTime(input.closedAt, 'closedAt');
}

export function validateControlWatchdogPolicy(input: ControlWatchdogPolicy): void {
  assertPositiveSafeInteger(input.maxSilentDurationMs, 'maxSilentDurationMs');
  assertPositiveSafeInteger(input.maxTurnDurationMs, 'maxTurnDurationMs');
  assertPositiveSafeInteger(input.maxTotalTurns, 'maxTotalTurns');
  assertPositiveSafeInteger(input.maxTurnsBetweenProbes, 'maxTurnsBetweenProbes');
  assertPositiveSafeInteger(input.maxNoProgressTurns, 'maxNoProgressTurns');
  assertPositiveSafeInteger(input.maxControlRepairAttempts, 'maxControlRepairAttempts');
}

export function validateControlProbeRecord(input: ControlProbeRecord): void {
  nonEmpty(input.runtimeRef, 'runtimeRef');
  nonEmpty(input.requestRef, 'requestRef');
  nonEmpty(input.turnRef, 'turnRef');
  if (!CONTROL_PROBE_POINTS.includes(input.probePoint)) throw new ContractError(`unknown control probe point: ${input.probePoint}`);
  assertValidTime(input.triggeredAt, 'triggeredAt');
  if (input.requiredSummary !== true) throw new ContractError('control probe requires summary');
}

export function validateGoalRecord(input: GoalRecord): void {
  nonEmpty(input.goalId, 'goalId');
  nonEmpty(input.scopeRef, 'scopeRef');
  nonEmpty(input.acceptedRevision, 'acceptedRevision');
  if (!GOAL_STATUSES.includes(input.status)) throw new ContractError(`unknown goal status: ${input.status}`);
  if (input.status !== 'active') nonEmpty(input.statusReason, 'statusReason');
}

export function validateSubscription(input: Subscription): void {
  nonEmpty(input.subscriptionId, 'subscriptionId');
  nonEmpty(input.goalId, 'goalId');
  assertPositiveSafeInteger(input.scheduleRevision, 'scheduleRevision');
  if (!SUBSCRIPTION_STATES.includes(input.state)) throw new ContractError(`unknown subscription state: ${input.state}`);
  if (!SUBSCRIPTION_BUSY_POLICIES.includes(input.busyPolicy)) throw new ContractError(`unknown subscription busy policy: ${input.busyPolicy}`);
  assertNonNegativeSafeInteger(input.currentOccurrenceOrdinal, 'currentOccurrenceOrdinal');
}

export function validateOccurrence(input: Occurrence): void {
  nonEmpty(input.subscriptionId, 'subscriptionId');
  assertPositiveSafeInteger(input.scheduleRevision, 'scheduleRevision');
  assertPositiveSafeInteger(input.occurrenceOrdinal, 'occurrenceOrdinal');
  if (!OCCURRENCE_STATES.includes(input.state)) throw new ContractError(`unknown occurrence state: ${input.state}`);
  assertValidTime(input.dueAt, 'dueAt');
}

export function validateReminder(input: Reminder): void {
  nonEmpty(input.reminderId, 'reminderId');
  nonEmpty(input.subscriptionId, 'subscriptionId');
  assertPositiveSafeInteger(input.scheduleRevision, 'scheduleRevision');
  assertPositiveSafeInteger(input.occurrenceOrdinal, 'occurrenceOrdinal');
  if (!REMINDER_STATES.includes(input.state)) throw new ContractError(`unknown reminder state: ${input.state}`);
  assertValidTime(input.dueAt, 'dueAt');
}

export function validateSchedulerLease(input: SchedulerLease): void {
  nonEmpty(input.leaseId, 'leaseId');
  nonEmpty(input.schedulerInstanceId, 'schedulerInstanceId');
  assertPositiveSafeInteger(input.generation, 'generation');
  nonEmpty(input.scopeRef, 'scopeRef');
  assertValidTime(input.acquiredAt, 'acquiredAt');
  assertValidTime(input.expiresAt, 'expiresAt');
  if (Date.parse(input.expiresAt) <= Date.parse(input.acquiredAt)) throw new ContractError('lease expiresAt must be later than acquiredAt');
  if (!LEASE_STATES.includes(input.state)) throw new ContractError(`unknown lease state: ${input.state}`);
}

export function validateAcpServerBinding(input: AcpServerBinding): void {
  nonEmpty(input.bindingRef, 'bindingRef');
  nonEmpty(input.principalRef, 'principalRef');
  nonEmpty(input.scopeRef, 'scopeRef');
  nonEmpty(input.permissionRevision, 'permissionRevision');
  nonEmpty(input.bindingDigest, 'bindingDigest');
  if (input.allowedSessionKinds.length === 0) throw new ContractError('allowedSessionKinds cannot be empty');
  for (const kind of input.allowedSessionKinds) {
    if (!ACP_SESSION_KINDS.includes(kind)) throw new ContractError(`unknown allowed session kind: ${kind}`);
  }
  assertRefList(input.allowedCapabilities, 'allowedCapabilities');
}

export function validateAcpDriverBinding(input: AcpDriverBinding): void {
  nonEmpty(input.bindingRef, 'bindingRef');
  nonEmpty(input.externalPeerRef, 'externalPeerRef');
  assertPositiveSafeInteger(input.executionEpoch, 'executionEpoch');
  nonEmpty(input.delegationProofRef, 'delegationProofRef');
  nonEmpty(input.permissionRevision, 'permissionRevision');
  assertRefList(input.delegatedCapabilities, 'delegatedCapabilities');
  if (input.taskId !== undefined || input.assignmentId !== undefined) {
    assertScopedTask(input.taskId, 'taskId');
    nonEmpty(input.assignmentId, 'assignmentId');
  }
}

export function occurrenceIdempotencyKey(occurrence: Pick<Occurrence, 'subscriptionId' | 'scheduleRevision' | 'occurrenceOrdinal'>): string {
  validateOccurrence({ ...occurrence, state: 'due', dueAt: '2099-01-01T00:00:00Z' });
  return `${occurrence.subscriptionId}::${occurrence.scheduleRevision}::${occurrence.occurrenceOrdinal}`;
}
