import {
  assertEvidenceRef,
  assertExecutionEpoch,
  assertNextAction,
  assertScope,
  validateOccurrenceExecutionOwner,
  type CycleId,
  type Checkpoint,
  type EvidenceRef,
  type NextAction,
  type OccurrenceExecutionOwner,
  type OperationId,
  type OrganId,
  type ScopeRef,
  type TaskId,
} from './index.js';
import { canonicalJsonStringify } from './explicit-brain.js';
import { ContractError } from './errors.js';

export type OperationKind = 'inspect' | 'apply' | 'run' | 'interact' | 'verify';
export type OperationMode = 'gateway' | 'legacy' | 'dual-observe' | 'legacy-forward' | 'retired';
export type ArtifactRef = string;
export type SchemaRef = string;
export type VerifierRef = string;
export type RetryPolicyRef = string;
export type Scope = ScopeRef;

export interface ScopePattern {
  readonly organId?: OrganId;
  readonly taskId?: TaskId;
  readonly cycleId?: CycleId;
  readonly operationId?: OperationId;
}

export interface OutputContract {
  readonly schemaRef: SchemaRef;
  readonly requiredEvidenceKinds: readonly EvidenceRef['kind'][];
}

export interface OperationIntent {
  readonly operationId: OperationId;
  readonly taskId: TaskId;
  readonly cycleId: CycleId;
  readonly requestedBy: string;
  readonly intentRevision: string;
  readonly kind: OperationKind;
  readonly toolName: string;
  readonly inputRef: ArtifactRef;
  readonly inputDigest: string;
  readonly requestedScope: Scope;
  readonly idempotencyKey: string;
  readonly deadline?: string;
  readonly expectedOutput: OutputContract;
}

export interface ToolRegistration {
  readonly toolName: string;
  readonly contractVersion: string;
  readonly supportedKinds: readonly OperationKind[];
  readonly routeId: string;
  readonly routeVersion: string;
  readonly mode: OperationMode;
  readonly acceptedScopes: readonly ScopePattern[];
  readonly inputContract: SchemaRef;
  readonly outputContract: SchemaRef;
  readonly verifier: VerifierRef;
  readonly capabilities: readonly string[];
  readonly retryPolicy: RetryPolicyRef;
  readonly owner: string;
}

export type OperationStatus =
  | 'accepted'
  | 'queued'
  | 'leased'
  | 'running'
  | 'settling'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancel_requested'
  | 'cancelled'
  | 'reconcile_required';

export type OperationFailurePhase = 'admission' | 'execution' | 'verification' | 'reconcile';
export type OperationFailureClass =
  | 'contract'
  | 'permission'
  | 'route'
  | 'executor'
  | 'verifier'
  | 'cancellation'
  | 'integrity'
  | 'unknown';

export interface OperationFailure {
  readonly errorId: string;
  readonly operationId: OperationId;
  readonly owner: string;
  readonly phase: OperationFailurePhase;
  readonly failureClass: OperationFailureClass;
  readonly message: string;
  readonly observedAt: string;
  readonly impact: string;
  readonly protectiveAction: string;
  readonly nextAction: NextAction;
  readonly recoveryCondition?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface OperationResult {
  readonly operationId: OperationId;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly outputRef?: ArtifactRef;
  readonly outputDigest?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly verifier: {
    readonly name: string;
    readonly version: string;
    readonly decision: string;
  };
  readonly failure?: OperationFailure;
  readonly completedAt: string;
}

export interface TaskExecutionEvidence {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly inputArtifactDigest: string;
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type TaskCheckKind = 'process' | 'native';

export interface TaskProcessCheckPolicy {
  readonly checkId: string;
  readonly kind: 'process';
  readonly required: boolean;
  readonly executableRef: string;
  readonly executableDigest: string;
  readonly programRef: string;
  readonly programDigest: string;
  readonly argvSlots: readonly ('primary-artifact-path' | 'checker-evidence-dir')[];
  readonly cwdRef: 'workspace' | 'project' | 'control';
  readonly envAllowlist: readonly string[];
  readonly timeoutMs: number;
  readonly permissionRefs: readonly string[];
}

export interface TaskVisualCheckPolicy {
  readonly evaluator: 'aitest-visual-motion-v1';
  readonly providerBindingRef: string;
  readonly providerBindingDigest: string;
  readonly routeRef: string;
  readonly assertionPolicyRef: string;
  readonly assertionPolicyDigest: string;
  readonly timeoutMs: number;
  readonly permissionRefs: readonly string[];
}

export interface TaskNativeCheckPolicy {
  readonly checkId: string;
  readonly kind: 'native';
  readonly required: boolean;
  readonly evaluator:
    | 'default-task-output-v1'
    | 'web-search-report-v1'
    | 'local-file-search-report-v1'
    | 'aitest-visual-motion-v1';
  readonly evaluatorDigest: string;
  readonly timeoutMs: number;
  readonly permissionRefs: readonly string[];
  readonly visual?: TaskVisualCheckPolicy;
}

export type TaskCheckPolicy = TaskProcessCheckPolicy | TaskNativeCheckPolicy;

export interface TaskVerificationPolicy {
  readonly policyId: string;
  readonly policyRevision: number;
  readonly requirementId: string;
  readonly directiveRevision: number;
  readonly profileRef: string;
  readonly checks: readonly TaskCheckPolicy[];
  readonly compiledRef: string;
  readonly compiledDigest: string;
}

export interface TaskVerificationBinding {
  readonly bindingRef: string;
  readonly bindingDigest: string;
  readonly policyRef: string;
  readonly policyDigest: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly executionEvidenceRef: string;
  readonly executionEvidenceDigest: string;
  readonly artifacts: readonly {
    readonly role: 'primary' | 'supporting';
    readonly artifactRef: string;
    readonly artifactDigest: string;
  }[];
  readonly boundAt: string;
}

export interface TaskVisualObservationReceipt {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly bindingRef: string;
  readonly bindingDigest: string;
  readonly primaryArtifactRef: string;
  readonly primaryArtifactDigest: string;
  readonly screenshot: {
    readonly artifactRef: string;
    readonly artifactDigest: string;
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  };
  readonly motion: {
    readonly artifactRef: string;
    readonly artifactDigest: string;
    readonly firstSampleRef: string;
    readonly firstSampleDigest: string;
    readonly secondSampleRef: string;
    readonly secondSampleDigest: string;
  };
  readonly browserRelease: {
    readonly releaseRef: string;
    readonly released: true;
    readonly evidenceRefs: readonly EvidenceRef[];
  };
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly producedAt: string;
}

export type TaskObservationProductionErrorCode =
  | 'missing-primary-artifact'
  | 'missing-browser'
  | 'permission-denied'
  | 'capture-failed'
  | 'motion-sample-failed'
  | 'digest-mismatch'
  | 'browser-release-failed'
  | 'persist-failed'
  | 'receipt-persist-failed'
  | 'timeout'
  | 'cancelled';

export interface TaskObservationRetainedInventory {
  readonly resourceRefs: readonly string[];
  readonly assets: readonly {
    readonly artifactRef: string;
    readonly artifactDigest: string;
  }[];
}

export interface TaskObservationProductionError {
  readonly code: TaskObservationProductionErrorCode;
  readonly message: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly retryable: boolean;
  readonly recoveryOwner: string;
  readonly nextAction: string;
  readonly retained: TaskObservationRetainedInventory;
}

export interface TaskObservationProductionAbort {
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly reason: 'operator-stop' | 'task-abort' | 'timeout' | 'shutdown';
  readonly recoveryOwner: string;
  readonly nextAction: string;
  readonly retained: TaskObservationRetainedInventory;
}

export interface TaskObservationProductionResultBase {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly bindingRef: string;
  readonly bindingDigest: string;
  readonly primaryArtifactRef: string;
  readonly primaryArtifactDigest: string;
  readonly browserCreated: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly error?: TaskObservationProductionError;
  readonly abort?: TaskObservationProductionAbort;
  readonly browserRelease?: TaskVisualObservationReceipt['browserRelease'];
}

export interface TaskObservationProducedResult
  extends TaskObservationProductionResultBase {
  readonly status: 'produced';
  readonly browserCreated: true;
  readonly receipt: TaskVisualObservationReceipt;
  readonly browserRelease: TaskVisualObservationReceipt['browserRelease'];
}

export interface TaskObservationNotProducedResult
  extends TaskObservationProductionResultBase {
  readonly status: 'failed' | 'cancelled' | 'not-required';
  readonly receipt?: never;
  readonly error?: TaskObservationProductionError;
}

export type TaskObservationProductionResult =
  | TaskObservationProducedResult
  | TaskObservationNotProducedResult;

export interface TaskProcessCheckEvidence {
  readonly checkId: string;
  readonly kind: 'process';
  readonly status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled';
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly artifactDigests: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface TaskNativeCheckEvidence {
  readonly checkId: string;
  readonly kind: 'native';
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  readonly decisionRef: string;
  readonly decisionDigest: string;
  readonly artifactDigests: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type TaskCheckEvidence = TaskProcessCheckEvidence | TaskNativeCheckEvidence;

export interface VisualAssertionRequest {
  readonly imageArtifactRef: string;
  readonly imageArtifactDigest: string;
  readonly imageMediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly assertions: readonly (
    | 'visible-pelican-identity'
    | 'visible-pelican-pouch'
    | 'rider-feet-or-legs-connect-to-pedals'
  )[];
}

export type VisualVerdict = 'satisfied' | 'rejected' | 'unknown' | 'unavailable';

export interface VisualAssertionDecision {
  readonly assertion: VisualAssertionRequest['assertions'][number];
  readonly verdict: VisualVerdict;
  readonly evidenceText: string;
}

export type VisualProducerErrorCode =
  | 'capability-unavailable'
  | 'invalid-output'
  | 'response-identity-mismatch'
  | 'digest-mismatch'
  | 'timeout'
  | 'cancelled'
  | 'provider-failure';

export interface VisualProducerError {
  readonly code: VisualProducerErrorCode;
  readonly message: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly retryable: boolean;
  readonly recoveryOwner: string;
  readonly nextAction: string;
}

export interface VisualProducerAbort {
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly reason: 'operator-stop' | 'task-abort' | 'timeout' | 'shutdown';
}

export interface VisualProducerDrainReceipt {
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly providerSettlementRef?: string;
  readonly browserResourceReleaseRef?: string;
  readonly drained: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface VisualProducerResultBase {
  readonly checkId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly inputArtifactDigest: string;
  readonly status: 'satisfied' | 'rejected' | 'unknown' | 'unavailable' | 'cancelled';
  readonly assertions: readonly VisualAssertionDecision[];
  readonly capturedAt: string;
  readonly decisionRef: string;
  readonly decisionDigest: string;
  readonly error?: VisualProducerError;
  readonly abort?: VisualProducerAbort;
  readonly drain?: VisualProducerDrainReceipt;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface VisualProducerNotDispatchedResult extends VisualProducerResultBase {
  readonly phase: 'not-dispatched';
  readonly status: 'unavailable' | 'cancelled';
  readonly providerBindingId?: string;
  readonly providerBindingDigest?: string;
  readonly routeRef?: string;
  readonly error: VisualProducerError;
}

export interface VisualProducerDispatchedResult extends VisualProducerResultBase {
  readonly phase: 'dispatched';
  readonly status: 'unknown' | 'cancelled';
  readonly providerBindingId: string;
  readonly providerBindingDigest: string;
  readonly routeRef: string;
  readonly requestModel: string;
  readonly requestId: string;
  readonly responseModel?: string;
  readonly responseId?: string;
  readonly outputArtifactRef?: string;
  readonly outputArtifactDigest?: string;
  readonly settlementRef?: string;
  readonly settlementDigest?: string;
  readonly error: VisualProducerError;
}

export interface VisualProducerSettledResult extends VisualProducerResultBase {
  readonly phase: 'settled';
  readonly status: 'satisfied' | 'rejected' | 'unknown';
  readonly providerBindingId: string;
  readonly providerBindingDigest: string;
  readonly routeRef: string;
  readonly requestModel: string;
  readonly responseModel: string;
  readonly requestId: string;
  readonly responseId?: string;
  readonly outputArtifactRef: string;
  readonly outputArtifactDigest: string;
  readonly settlementRef: string;
  readonly settlementDigest: string;
  readonly error?: VisualProducerError;
}

export type VisualProducerResult =
  | VisualProducerNotDispatchedResult
  | VisualProducerDispatchedResult
  | VisualProducerSettledResult;

export type TaskVerificationStatus = 'success' | 'failed' | 'rejected' | 'missing' | 'blocked' | 'cancelled';
export type TaskVerificationRejectionCode = 'identity-mismatch' | 'stale-epoch' | 'checker-rejected';

export interface TaskVerificationResult {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly attempt: number;
  readonly inputArtifactDigest: string;
  readonly policyRef: string;
  readonly policyDigest: string;
  readonly status: TaskVerificationStatus;
  readonly rejectionCode?: TaskVerificationRejectionCode;
  readonly checks: readonly TaskCheckEvidence[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ServeTaskTerminalReceipt {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly inputArtifactDigest: string;
  readonly verification: TaskVerificationResult;
  readonly terminalCheckpointRef: string;
  readonly settlementReceiptRef: string;
  readonly recoveryResponsibility?: string;
}

export interface OccurrenceTaskBinding {
  readonly occurrenceId: string;
  readonly subscriptionId: string;
  readonly scheduleRevision: number;
  readonly occurrenceOrdinal: number;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly inputArtifactDigest: string;
}

export const OCCURRENCE_EXECUTION_ADMISSION_RECORD_VERSION = 1 as const;
export const OCCURRENCE_TERMINAL_RECEIPT_RECORD_VERSION = 1 as const;

export type ProviderEffectState = 'confirmed-released' | 'possible' | 'confirmed-present';

export interface RecoveryResponsibilityRecord {
  readonly providerEffectState: ProviderEffectState;
  readonly resourceInventory: readonly EvidenceRef[];
  readonly releaseProofs: readonly EvidenceRef[];
}

export interface OccurrenceExecutionAdmissionRecord {
  readonly kind: 'occurrence-execution-admission';
  readonly version: typeof OCCURRENCE_EXECUTION_ADMISSION_RECORD_VERSION;
  readonly binding: OccurrenceTaskBinding;
  readonly dispatchRef: string;
  readonly admittedAt: string;
  readonly admittedExecutionOwner: OccurrenceExecutionOwner;
  readonly recoveryResponsibility: RecoveryResponsibilityRecord;
}

export interface OccurrenceTerminalReceiptRecord {
  readonly kind: 'occurrence-terminal-receipt';
  readonly version: typeof OCCURRENCE_TERMINAL_RECEIPT_RECORD_VERSION;
  readonly binding: OccurrenceTaskBinding;
  readonly terminalCheckpointRef: string;
  readonly terminalOutcome: Checkpoint['outcome'];
  readonly verification: TaskVerificationResult;
  readonly recoveryResponsibility?: RecoveryResponsibilityRecord;
  readonly settlementReceiptRef: string;
}

export type OccurrenceSettlementOutcome = 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'skipped-busy';

export interface OccurrenceSettlementInput {
  readonly binding: OccurrenceTaskBinding;
  readonly terminalReceipt: ServeTaskTerminalReceipt;
  readonly outcome: OccurrenceSettlementOutcome;
}

export interface OccurrenceResult {
  readonly binding: OccurrenceTaskBinding;
  readonly outcome: OccurrenceSettlementOutcome;
  readonly terminalReceiptRef: string;
  readonly settlementReceiptRef: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly completedAt: string;
}

export type ToolTraceStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';

export interface ToolTraceError {
  readonly code: string;
  readonly message: string;
  readonly ownerId?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface ToolTraceDescriptor {
  readonly callId: string;
  readonly toolId: string;
  readonly argumentsRef?: string;
  readonly argumentsDigest?: string;
  readonly status: ToolTraceStatus;
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly error?: ToolTraceError;
  readonly startedAt?: string;
  readonly durationMs?: number;
}

export interface TraceDependencyEdge {
  readonly source: string;
  readonly target: string;
  readonly ref?: string;
  readonly reason?: string;
}

export interface InteractionTraceAuthorization {
  readonly scope: Scope;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly requestedCapabilities: readonly string[];
  readonly permissionRefs: readonly string[];
  readonly toolOutputRef: string;
}

export interface InteractionTraceProvider {
  readonly state: string;
  readonly lastEventAt: string;
}

export interface InteractionTraceTransport {
  readonly connected: boolean;
  readonly lastSyncedAt: string;
  readonly stale?: boolean;
  readonly replayed?: boolean;
  readonly cursor?: string;
}

export interface InteractionTraceSettlement {
  readonly providerStopped: boolean;
  readonly checkpointCommitted: boolean;
  readonly stoppedAt?: string;
  readonly resultRef?: string;
}

export interface InteractionTraceLastBusiness {
  readonly kind: string;
  readonly at: string;
  readonly ref: string;
}

export type InteractionTraceKind =
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  | 'status'
  | 'decision'
  | 'failure'
  | 'cancel';

export interface InteractionTraceEntry {
  readonly turnId: string;
  readonly requestId: string;
  readonly parentRequestId?: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly kind: InteractionTraceKind;
  readonly modelRef?: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly tool?: ToolTraceDescriptor;
  readonly authorization: InteractionTraceAuthorization;
  readonly dependencyEdge?: TraceDependencyEdge;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly state: string;
  readonly allowedActions: readonly string[];
  readonly provider: InteractionTraceProvider;
  readonly transport: InteractionTraceTransport;
  readonly settlement: InteractionTraceSettlement;
  readonly lastBusiness: InteractionTraceLastBusiness;
}

export interface InteractionHistoryFilter {
  readonly kinds?: readonly InteractionTraceKind[];
  readonly taskId?: TaskId;
  readonly operationId?: OperationId;
  readonly executionEpoch?: number;
  readonly callId?: string;
  readonly fromSeq?: number;
  readonly toSeq?: number;
}

export interface InteractionHistoryQuery {
  readonly cursor?: string;
  readonly filter?: InteractionHistoryFilter;
  readonly search?: string;
  readonly replay?: boolean;
  readonly limit: number;
}

export interface InteractionHistoryFailure {
  readonly code: 'stale-cursor' | 'scope-mismatch' | 'not-found' | 'unavailable';
  readonly message: string;
  readonly retryable: boolean;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface InteractionHistoryPage {
  readonly cursor?: string;
  readonly hasMore: boolean;
  readonly items: readonly InteractionTraceEntry[];
  readonly filter?: InteractionHistoryFilter;
  readonly replay?: boolean;
}

export type InteractionHistoryResult =
  | { readonly ok: true; readonly page: InteractionHistoryPage }
  | { readonly ok: false; readonly failure: InteractionHistoryFailure };

export interface InteractionWorkCard {
  readonly source: {
    readonly taskId: TaskId;
    readonly operationId: OperationId;
    readonly executionEpoch: number;
    readonly requestId: string;
    readonly turnId: string;
  };
  readonly currentNode: string;
  readonly ownerId: string;
  readonly nextStep: string;
  readonly nextAction: string;
  readonly waitingOn?: string;
  readonly startedAt: string;
  readonly provider: InteractionTraceProvider;
  readonly transport: InteractionTraceTransport;
  readonly settlement: InteractionTraceSettlement;
  readonly lastBusiness: InteractionTraceLastBusiness;
}

export interface RouteSelection {
  readonly operationId: OperationId;
  readonly routeId: string;
  readonly routeVersion: string;
  readonly mode: OperationMode;
  readonly contractVersion: string;
  readonly effectiveScope: Scope;
  readonly selectionReason: string;
  readonly selectedAt: string;
}

export type OperationLeaseState = 'active' | 'expired' | 'released';

export interface OperationLease {
  readonly leaseId: string;
  readonly operationId: OperationId;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly routeId: string;
  readonly routeVersion: string;
  readonly effectiveScope: Scope;
  readonly state: OperationLeaseState;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type OperationEventKind =
  | 'operation.accepted'
  | 'operation.queued'
  | 'operation.leased'
  | 'operation.started'
  | 'operation.progressed'
  | 'operation.verification_started'
  | 'operation.completed'
  | 'operation.failed'
  | 'operation.blocked'
  | 'operation.cancel_requested'
  | 'operation.cancelled'
  | 'operation.reconcile_required';

export interface OperationEvent {
  readonly eventId: string;
  readonly schemaVersion: 1;
  readonly kind: OperationEventKind;
  readonly operationId: OperationId;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly status: OperationStatus;
  readonly occurredAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly resultRef?: string;
  readonly outputRef?: ArtifactRef;
  readonly outputDigest?: string;
  readonly failure?: OperationFailure;
}

export interface OperationIdempotencyNamespace {
  readonly taskId: TaskId;
  readonly requestedBy: string;
  readonly toolName: string;
  readonly kind: OperationKind;
}

export interface OperationSemanticFingerprint {
  readonly taskId: TaskId;
  readonly cycleId: CycleId;
  readonly requestedBy: string;
  readonly toolName: string;
  readonly kind: OperationKind;
  readonly inputDigest: string;
  readonly requestedScope: Scope;
  readonly expectedOutputSchemaRef: SchemaRef;
  readonly contractVersion: string;
  readonly intentRevision: string;
}

export interface OperationIdempotencyRecord {
  readonly namespaceKey: string;
  readonly fingerprintKey: string;
  readonly operationId: OperationId;
}

export type OperationIdempotencyDecision = 'new' | 'replay' | 'conflict';

const OPERATION_KINDS: readonly OperationKind[] = ['inspect', 'apply', 'run', 'interact', 'verify'];
const OPERATION_MODES: readonly OperationMode[] = ['gateway', 'legacy', 'dual-observe', 'legacy-forward', 'retired'];
const OPERATION_STATUSES: readonly OperationStatus[] = [
  'accepted',
  'queued',
  'leased',
  'running',
  'settling',
  'verifying',
  'succeeded',
  'failed',
  'blocked',
  'cancel_requested',
  'cancelled',
  'reconcile_required',
];
const OPERATION_FAILURE_PHASES: readonly OperationFailurePhase[] = ['admission', 'execution', 'verification', 'reconcile'];
const OPERATION_FAILURE_CLASSES: readonly OperationFailureClass[] = [
  'contract',
  'permission',
  'route',
  'executor',
  'verifier',
  'cancellation',
  'integrity',
  'unknown',
];
const EVIDENCE_KINDS: readonly EvidenceRef['kind'][] = ['execution', 'tool', 'operation', 'external'];
const OPERATION_EVENT_STATUS: Readonly<Record<OperationEventKind, OperationStatus>> = {
  'operation.accepted': 'accepted',
  'operation.queued': 'queued',
  'operation.leased': 'leased',
  'operation.started': 'running',
  'operation.progressed': 'running',
  'operation.verification_started': 'verifying',
  'operation.completed': 'succeeded',
  'operation.failed': 'failed',
  'operation.blocked': 'blocked',
  'operation.cancel_requested': 'cancel_requested',
  'operation.cancelled': 'cancelled',
  'operation.reconcile_required': 'reconcile_required',
};

function assertNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) throw new ContractError(`${label} must be a non-empty reference`);
}

function assertValidTime(value: string, label: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) throw new ContractError(`${label} must be a valid timestamp`);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContractError(`${label} must be a non-negative safe integer`);
}

function assertOperationKind(value: OperationKind): void {
  if (!OPERATION_KINDS.includes(value)) throw new ContractError('operation kind is invalid');
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ContractError(`${label} must be a positive safe integer`);
}

function assertNonNegativeSafeIntegerOrZero(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContractError(`${label} must be a non-negative safe integer`);
}

function assertOperationMode(value: OperationMode): void {
  if (!OPERATION_MODES.includes(value)) throw new ContractError('operation mode is invalid');
}

function assertOperationStatus(value: OperationStatus): void {
  if (!OPERATION_STATUSES.includes(value)) throw new ContractError('operation status is invalid');
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.scope === right.scope && left.value === right.value;
}

export function validateScope(scope: Scope, label = 'scope'): void {
  assertScope(scope.organId, 'organ');
  assertNonEmpty(scope.organId.value, `${label} organId`);
  if (scope.taskId !== undefined) {
    assertScope(scope.taskId, 'task');
    assertNonEmpty(scope.taskId.value, `${label} taskId`);
  }
  if (scope.cycleId !== undefined) {
    assertScope(scope.cycleId, 'cycle');
    assertNonEmpty(scope.cycleId.value, `${label} cycleId`);
  }
  if (scope.operationId !== undefined) {
    assertScope(scope.operationId, 'operation');
    assertNonEmpty(scope.operationId.value, `${label} operationId`);
  }
}

export function validateScopePattern(pattern: ScopePattern, label = 'scope pattern'): void {
  if (pattern.organId !== undefined) {
    assertScope(pattern.organId, 'organ');
    assertNonEmpty(pattern.organId.value, `${label} organId`);
  }
  if (pattern.taskId !== undefined) {
    assertScope(pattern.taskId, 'task');
    assertNonEmpty(pattern.taskId.value, `${label} taskId`);
  }
  if (pattern.cycleId !== undefined) {
    assertScope(pattern.cycleId, 'cycle');
    assertNonEmpty(pattern.cycleId.value, `${label} cycleId`);
  }
  if (pattern.operationId !== undefined) {
    assertScope(pattern.operationId, 'operation');
    assertNonEmpty(pattern.operationId.value, `${label} operationId`);
  }
}

export function scopePatternMatches(pattern: ScopePattern, scope: Scope): boolean {
  validateScopePattern(pattern);
  validateScope(scope);
  return (pattern.organId === undefined || sameScopedId(pattern.organId, scope.organId))
    && (pattern.taskId === undefined || sameScopedId(pattern.taskId, scope.taskId))
    && (pattern.cycleId === undefined || sameScopedId(pattern.cycleId, scope.cycleId))
    && (pattern.operationId === undefined || sameScopedId(pattern.operationId, scope.operationId));
}

export function scopeContains(boundary: Scope, candidate: Scope): boolean {
  validateScope(boundary, 'scope boundary');
  validateScope(candidate, 'scope candidate');
  return sameScopedId(boundary.organId, candidate.organId)
    && (boundary.taskId === undefined || sameScopedId(boundary.taskId, candidate.taskId))
    && (boundary.cycleId === undefined || sameScopedId(boundary.cycleId, candidate.cycleId))
    && (boundary.operationId === undefined || sameScopedId(boundary.operationId, candidate.operationId));
}

export function assertScopeWithin(scope: Scope, boundary: Scope): void {
  if (!scopeContains(boundary, scope)) throw new ContractError('scope expansion is not allowed');
}

export function intersectScopes(...scopes: readonly Scope[]): Scope {
  if (scopes.length === 0) throw new ContractError('scope intersection requires at least one scope');
  for (const scope of scopes) validateScope(scope);

  const first = scopes[0];
  const result: {
    organId: OrganId;
    taskId?: TaskId;
    cycleId?: CycleId;
    operationId?: OperationId;
  } = { organId: first.organId };

  const merge = <K extends 'taskId' | 'cycleId' | 'operationId'>(key: K): void => {
    let selected: Scope[K] | undefined;
    for (const scope of scopes) {
      const value = scope[key];
      if (value === undefined) continue;
      if (selected !== undefined && !sameScopedId(selected, value)) {
        throw new ContractError(`scope intersection is empty: ${key} mismatch`);
      }
      selected = value;
    }
    if (selected !== undefined) result[key] = selected;
  };

  for (const scope of scopes) {
    if (!sameScopedId(result.organId, scope.organId)) {
      throw new ContractError('scope intersection is empty: organId mismatch');
    }
  }
  merge('taskId');
  merge('cycleId');
  merge('operationId');
  return result;
}

export function effectiveOperationScope(
  requestedScope: Scope,
  callerGrant: Scope,
  registrationLimit: Scope,
  taskResourceBoundary: Scope,
): Scope {
  return intersectScopes(requestedScope, callerGrant, registrationLimit, taskResourceBoundary);
}

export function validateOutputContract(output: OutputContract, label = 'output contract'): void {
  assertNonEmpty(output.schemaRef, `${label} schemaRef`);
  for (const kind of output.requiredEvidenceKinds) {
    if (!EVIDENCE_KINDS.includes(kind)) throw new ContractError(`${label} evidence kind is invalid`);
  }
}

export function validateOperationIntent(input: OperationIntent): void {
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'operationId');
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'taskId');
  assertScope(input.cycleId, 'cycle');
  assertNonEmpty(input.cycleId.value, 'cycleId');
  assertNonEmpty(input.requestedBy, 'requestedBy');
  assertNonEmpty(input.intentRevision, 'intentRevision');
  assertOperationKind(input.kind);
  assertNonEmpty(input.toolName, 'toolName');
  assertNonEmpty(input.inputRef, 'inputRef');
  assertNonEmpty(input.inputDigest, 'inputDigest');
  validateScope(input.requestedScope, 'requested scope');
  assertNonEmpty(input.idempotencyKey, 'idempotencyKey');
  if (input.deadline !== undefined) assertValidTime(input.deadline, 'deadline');
  validateOutputContract(input.expectedOutput);
  if (input.requestedScope.taskId !== undefined
    && !sameScopedId(input.requestedScope.taskId, input.taskId)) {
    throw new ContractError('requested scope taskId does not match intent');
  }
  if (input.requestedScope.cycleId !== undefined
    && !sameScopedId(input.requestedScope.cycleId, input.cycleId)) {
    throw new ContractError('requested scope cycleId does not match intent');
  }
  if (input.requestedScope.operationId !== undefined
    && !sameScopedId(input.requestedScope.operationId, input.operationId)) {
    throw new ContractError('requested scope operationId does not match intent');
  }
}

export function validateToolRegistration(input: ToolRegistration): void {
  assertNonEmpty(input.toolName, 'toolName');
  assertNonEmpty(input.contractVersion, 'contractVersion');
  if (input.supportedKinds.length === 0) throw new ContractError('tool registration requires supported kinds');
  for (const kind of input.supportedKinds) assertOperationKind(kind);
  if (new Set(input.supportedKinds).size !== input.supportedKinds.length) {
    throw new ContractError('tool registration supported kinds must be unique');
  }
  assertNonEmpty(input.routeId, 'routeId');
  assertNonEmpty(input.routeVersion, 'routeVersion');
  assertOperationMode(input.mode);
  if (input.acceptedScopes.length === 0) throw new ContractError('tool registration requires accepted scopes');
  for (const pattern of input.acceptedScopes) validateScopePattern(pattern);
  assertNonEmpty(input.inputContract, 'inputContract');
  assertNonEmpty(input.outputContract, 'outputContract');
  assertNonEmpty(input.verifier, 'verifier');
  for (const capability of input.capabilities) assertNonEmpty(capability, 'capability');
  if (new Set(input.capabilities).size !== input.capabilities.length) {
    throw new ContractError('tool registration capabilities must be unique');
  }
  assertNonEmpty(input.retryPolicy, 'retryPolicy');
  assertNonEmpty(input.owner, 'owner');
}

export function validateOperationIntentForRegistration(input: OperationIntent, registration: ToolRegistration): void {
  validateOperationIntent(input);
  validateToolRegistration(registration);
  if (registration.mode === 'retired') {
    throw new ContractError('retired registration cannot accept new operation submissions');
  }
  if (input.toolName !== registration.toolName) throw new ContractError('operation tool does not match registration');
  if (!registration.supportedKinds.includes(input.kind)) throw new ContractError('operation kind is not supported by registration');
  if (!registration.acceptedScopes.some((pattern) => scopePatternMatches(pattern, input.requestedScope))) {
    throw new ContractError('operation requested scope is outside registration limits');
  }
  if (input.expectedOutput.schemaRef !== registration.outputContract) {
    throw new ContractError('operation output contract does not match registration');
  }
}

export function operationIdempotencyNamespace(input: OperationIntent): OperationIdempotencyNamespace {
  validateOperationIntent(input);
  return {
    taskId: input.taskId,
    requestedBy: input.requestedBy,
    toolName: input.toolName,
    kind: input.kind,
  };
}

export function operationIdempotencyKey(input: OperationIntent): string {
  const namespace = operationIdempotencyNamespace(input);
  return JSON.stringify([
    namespace.taskId.scope,
    namespace.taskId.value,
    namespace.requestedBy,
    namespace.toolName,
    namespace.kind,
    input.idempotencyKey,
  ]);
}

export function operationSemanticFingerprint(
  input: OperationIntent,
  registration: ToolRegistration,
): OperationSemanticFingerprint {
  validateOperationIntentForRegistration(input, registration);
  return {
    taskId: input.taskId,
    cycleId: input.cycleId,
    requestedBy: input.requestedBy,
    toolName: input.toolName,
    kind: input.kind,
    inputDigest: input.inputDigest,
    requestedScope: input.requestedScope,
    expectedOutputSchemaRef: input.expectedOutput.schemaRef,
    contractVersion: registration.contractVersion,
    intentRevision: input.intentRevision,
  };
}

export function operationSemanticFingerprintKey(
  fingerprint: OperationSemanticFingerprint,
): string {
  return JSON.stringify([
    fingerprint.taskId.scope,
    fingerprint.taskId.value,
    fingerprint.cycleId.scope,
    fingerprint.cycleId.value,
    fingerprint.requestedBy,
    fingerprint.toolName,
    fingerprint.kind,
    fingerprint.inputDigest,
    fingerprint.requestedScope.organId.scope,
    fingerprint.requestedScope.organId.value,
    fingerprint.requestedScope.taskId?.scope ?? null,
    fingerprint.requestedScope.taskId?.value ?? null,
    fingerprint.requestedScope.cycleId?.scope ?? null,
    fingerprint.requestedScope.cycleId?.value ?? null,
    fingerprint.requestedScope.operationId?.scope ?? null,
    fingerprint.requestedScope.operationId?.value ?? null,
    fingerprint.expectedOutputSchemaRef,
    fingerprint.contractVersion,
    fingerprint.intentRevision,
  ]);
}

export function classifyOperationSubmission(
  existing: OperationIdempotencyRecord | undefined,
  input: OperationIntent,
  registration: ToolRegistration,
): OperationIdempotencyDecision {
  const namespaceKey = operationIdempotencyKey(input);
  const fingerprintKey = operationSemanticFingerprintKey(operationSemanticFingerprint(input, registration));
  if (existing === undefined) return 'new';
  if (existing.namespaceKey !== namespaceKey) throw new ContractError('idempotency namespace mismatch');
  return existing.fingerprintKey === fingerprintKey ? 'replay' : 'conflict';
}

export function validateRouteSelection(selection: RouteSelection, registration?: ToolRegistration): void {
  assertScope(selection.operationId, 'operation');
  assertNonEmpty(selection.operationId.value, 'route selection operationId');
  assertNonEmpty(selection.routeId, 'routeId');
  assertNonEmpty(selection.routeVersion, 'routeVersion');
  assertOperationMode(selection.mode);
  assertNonEmpty(selection.contractVersion, 'route selection contractVersion');
  validateScope(selection.effectiveScope, 'route selection effective scope');
  if (selection.effectiveScope.operationId !== undefined
    && !sameScopedId(selection.effectiveScope.operationId, selection.operationId)) {
    throw new ContractError('route selection scope operationId does not match selection');
  }
  assertNonEmpty(selection.selectionReason, 'selectionReason');
  assertValidTime(selection.selectedAt, 'selectedAt');
  if (registration === undefined) return;
  validateToolRegistration(registration);
  if (registration.mode === 'retired') {
    throw new ContractError('retired route cannot bind a new operation');
  }
  if (selection.routeId !== registration.routeId
    || selection.routeVersion !== registration.routeVersion
    || selection.mode !== registration.mode
    || selection.contractVersion !== registration.contractVersion) {
    throw new ContractError('route selection does not match registration');
  }
  if (!registration.acceptedScopes.some((pattern) => scopePatternMatches(pattern, selection.effectiveScope))) {
    throw new ContractError('route selection scope is outside registration limits');
  }
}

export function validateOperationLease(input: OperationLease): void {
  assertNonEmpty(input.leaseId, 'leaseId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'lease operationId');
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'lease taskId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonEmpty(input.routeId, 'lease routeId');
  assertNonEmpty(input.routeVersion, 'lease routeVersion');
  validateScope(input.effectiveScope, 'lease effective scope');
  if (input.effectiveScope.taskId !== undefined
    && !sameScopedId(input.effectiveScope.taskId, input.taskId)) {
    throw new ContractError('lease scope taskId does not match lease');
  }
  if (input.effectiveScope.operationId !== undefined
    && !sameScopedId(input.effectiveScope.operationId, input.operationId)) {
    throw new ContractError('lease scope operationId does not match lease');
  }
  if (!['active', 'expired', 'released'].includes(input.state)) throw new ContractError('operation lease state is invalid');
  assertValidTime(input.issuedAt, 'lease issuedAt');
  assertValidTime(input.expiresAt, 'lease expiresAt');
  if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) {
    throw new ContractError('operation lease expiresAt must follow issuedAt');
  }
}

export function validateOperationFailure(input: OperationFailure): void {
  assertNonEmpty(input.errorId, 'errorId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'failure operationId');
  assertNonEmpty(input.owner, 'failure owner');
  if (!OPERATION_FAILURE_PHASES.includes(input.phase)) throw new ContractError('operation failure phase is invalid');
  if (!OPERATION_FAILURE_CLASSES.includes(input.failureClass)) throw new ContractError('operation failure class is invalid');
  assertNonEmpty(input.message, 'failure message');
  assertValidTime(input.observedAt, 'failure observedAt');
  assertNonEmpty(input.impact, 'failure impact');
  assertNonEmpty(input.protectiveAction, 'failure protectiveAction');
  assertNextAction(input.nextAction);
  if (input.recoveryCondition !== undefined) assertNonEmpty(input.recoveryCondition, 'failure recoveryCondition');
  if (input.evidenceRefs.length === 0) throw new ContractError('operation failure requires evidence');
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
}

function assertOperationFailureMatchesStatus(
  status: OperationStatus,
  failure: OperationFailure | undefined,
  label: string,
): void {
  if (status === 'failed' && failure === undefined) {
    throw new ContractError(`failed ${label} requires failure`);
  }
  if (status !== 'failed' && failure !== undefined) {
    throw new ContractError(`${label} cannot carry failure unless status is failed`);
  }
}

export function validateOperationResult(input: OperationResult): void {
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'result operationId');
  if (!['succeeded', 'failed', 'cancelled'].includes(input.status)) throw new ContractError('operation result status is invalid');
  if ((input.outputRef === undefined) !== (input.outputDigest === undefined)) {
    throw new ContractError('operation result outputRef and outputDigest must be provided together');
  }
  if (input.outputRef !== undefined) assertNonEmpty(input.outputRef, 'result outputRef');
  if (input.outputDigest !== undefined) assertNonEmpty(input.outputDigest, 'result outputDigest');
  if (input.evidenceRefs.length === 0) throw new ContractError('operation result requires evidence');
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
  assertNonEmpty(input.verifier.name, 'verifier name');
  assertNonEmpty(input.verifier.version, 'verifier version');
  assertNonEmpty(input.verifier.decision, 'verifier decision');
  assertValidTime(input.completedAt, 'result completedAt');
  if (input.failure !== undefined) {
    validateOperationFailure(input.failure);
    if (!sameScopedId(input.failure.operationId, input.operationId)) {
      throw new ContractError('operation result failure identity mismatch');
    }
  }
  assertOperationFailureMatchesStatus(input.status, input.failure, 'operation result');
}

export function operationEventKindForStatus(status: OperationStatus): OperationEventKind {
  assertOperationStatus(status);
  const entry = (Object.entries(OPERATION_EVENT_STATUS) as readonly [OperationEventKind, OperationStatus][])
    .find(([, eventStatus]) => eventStatus === status);
  if (entry === undefined) throw new ContractError('operation status has no event kind');
  return entry[0];
}

export function validateOperationEvent(input: OperationEvent): void {
  assertNonEmpty(input.eventId, 'eventId');
  if (input.schemaVersion !== 1) throw new ContractError('operation event schemaVersion is invalid');
  if (!(input.kind in OPERATION_EVENT_STATUS)) throw new ContractError('operation event kind is invalid');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'event operationId');
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'event taskId');
  assertExecutionEpoch(input.executionEpoch);
  assertOperationStatus(input.status);
  assertValidTime(input.occurredAt, 'event occurredAt');
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
  if (OPERATION_EVENT_STATUS[input.kind] !== input.status) {
    throw new ContractError('operation event kind does not match status');
  }
  if (input.resultRef !== undefined) assertNonEmpty(input.resultRef, 'event resultRef');
  if ((input.outputRef === undefined) !== (input.outputDigest === undefined)) {
    throw new ContractError('operation event outputRef and outputDigest must be provided together');
  }
  if (input.outputRef !== undefined) assertNonEmpty(input.outputRef, 'event outputRef');
  if (input.outputDigest !== undefined) assertNonEmpty(input.outputDigest, 'event outputDigest');
  if (input.failure !== undefined) {
    validateOperationFailure(input.failure);
    if (!sameScopedId(input.failure.operationId, input.operationId)) {
      throw new ContractError('operation event failure identity mismatch');
    }
  }
  assertOperationFailureMatchesStatus(input.status, input.failure, 'operation event');
}

export function operationStatusForEventKind(kind: OperationEventKind): OperationStatus {
  if (!(kind in OPERATION_EVENT_STATUS)) throw new ContractError('operation event kind is invalid');
  return OPERATION_EVENT_STATUS[kind];
}

function sameExecutionIdentity(
  left: {
    readonly taskId: TaskId;
    readonly operationId: OperationId;
    readonly executionEpoch: number;
    readonly inputArtifactDigest: string;
  },
  right: {
    readonly taskId: TaskId;
    readonly operationId: OperationId;
    readonly executionEpoch: number;
    readonly inputArtifactDigest: string;
  },
): boolean {
  return sameScopedId(left.taskId, right.taskId)
    && sameScopedId(left.operationId, right.operationId)
    && left.executionEpoch === right.executionEpoch
    && left.inputArtifactDigest === right.inputArtifactDigest;
}

export function validateTaskExecutionEvidence(input: TaskExecutionEvidence): void {
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'task execution evidence taskId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'task execution evidence operationId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonEmpty(input.inputArtifactDigest, 'task execution evidence inputArtifactDigest');
  if (typeof input.stdout !== 'string') throw new ContractError('task execution evidence stdout must be a string');
  if (input.exitCode !== null && (!Number.isSafeInteger(input.exitCode) || input.exitCode < 0)) {
    throw new ContractError('task execution evidence exitCode must be a non-negative safe integer or null');
  }
  if (input.evidenceRefs.length === 0) throw new ContractError('task execution evidence requires evidence');
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
}

export const TASK_VERIFICATION_PROFILE_REFS = [
  'verification-profile://default/v1',
  'verification-profile://web-search/v1',
  'verification-profile://local-file-search/v1',
  'verification-profile://aitest/v1',
] as const;

export const TASK_NATIVE_EVALUATORS = [
  'default-task-output-v1',
  'web-search-report-v1',
  'local-file-search-report-v1',
  'aitest-visual-motion-v1',
] as const;

const TASK_OBSERVATION_ERROR_CODES: readonly TaskObservationProductionErrorCode[] = [
  'missing-primary-artifact',
  'missing-browser',
  'permission-denied',
  'capture-failed',
  'motion-sample-failed',
  'digest-mismatch',
  'browser-release-failed',
  'persist-failed',
  'receipt-persist-failed',
  'timeout',
  'cancelled',
];
const TASK_OBSERVATION_ABORT_REASONS: readonly TaskObservationProductionAbort['reason'][] = [
  'operator-stop',
  'task-abort',
  'timeout',
  'shutdown',
];
const VISUAL_ASSERTION_NAMES: readonly VisualAssertionRequest['assertions'][number][] = [
  'visible-pelican-identity',
  'visible-pelican-pouch',
  'rider-feet-or-legs-connect-to-pedals',
];
const VISUAL_VERDICTS: readonly VisualVerdict[] = ['satisfied', 'rejected', 'unknown', 'unavailable'];
const VISUAL_PRODUCER_ERROR_CODES: readonly VisualProducerErrorCode[] = [
  'capability-unavailable',
  'invalid-output',
  'response-identity-mismatch',
  'digest-mismatch',
  'timeout',
  'cancelled',
  'provider-failure',
];
const VISUAL_PRODUCER_ABORT_REASONS: readonly VisualProducerAbort['reason'][] = [
  'operator-stop',
  'task-abort',
  'timeout',
  'shutdown',
];
const VISUAL_PRODUCER_RESULT_STATUSES: readonly VisualProducerResult['status'][] = [
  'satisfied',
  'rejected',
  'unknown',
  'unavailable',
  'cancelled',
];

export function assertSha256Digest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ContractError(`${label} must be an actual sha256 digest`);
  }
}

export function validateTaskProcessCheckPolicy(input: TaskProcessCheckPolicy): void {
  assertNonEmpty(input.checkId, 'task process check checkId');
  if (input.kind !== 'process' || !input.required) {
    throw new ContractError('task process check shape is invalid');
  }
  assertNonEmpty(input.executableRef, 'task process check executableRef');
  assertSha256Digest(input.executableDigest, 'task process check executableDigest');
  assertNonEmpty(input.programRef, 'task process check programRef');
  assertSha256Digest(input.programDigest, 'task process check programDigest');
  if (input.argvSlots.length === 0) throw new ContractError('task process check requires an argv slot');
  if (new Set(input.argvSlots).size !== input.argvSlots.length) {
    throw new ContractError('task process check argv slots must be unique');
  }
  for (const slot of input.argvSlots) {
    if (slot !== 'primary-artifact-path' && slot !== 'checker-evidence-dir') {
      throw new ContractError('task process check argv slot is invalid');
    }
  }
  if (input.cwdRef !== 'workspace' && input.cwdRef !== 'project' && input.cwdRef !== 'control') {
    throw new ContractError('task process check cwdRef is invalid');
  }
  if (input.envAllowlist.length === 0) {
    throw new ContractError('task process check envAllowlist must not be empty');
  }
  for (const env of input.envAllowlist) assertNonEmpty(env, 'task process check envAllowlist entry');
  if (new Set(input.envAllowlist).size !== input.envAllowlist.length) {
    throw new ContractError('task process check envAllowlist must be unique');
  }
  assertPositiveSafeInteger(input.timeoutMs, 'task process check timeoutMs');
  if (input.permissionRefs.length === 0) {
    throw new ContractError('task process check permissionRefs must not be empty');
  }
  for (const permission of input.permissionRefs) assertNonEmpty(permission, 'task process check permissionRefs entry');
  if (new Set(input.permissionRefs).size !== input.permissionRefs.length) {
    throw new ContractError('task process check permissionRefs must be unique');
  }
}

export function validateTaskVisualCheckPolicy(input: TaskVisualCheckPolicy): void {
  if (input.evaluator !== 'aitest-visual-motion-v1') throw new ContractError('task visual check evaluator is invalid');
  assertNonEmpty(input.providerBindingRef, 'task visual check providerBindingRef');
  assertSha256Digest(input.providerBindingDigest, 'task visual check providerBindingDigest');
  assertNonEmpty(input.routeRef, 'task visual check routeRef');
  assertNonEmpty(input.assertionPolicyRef, 'task visual check assertionPolicyRef');
  assertSha256Digest(input.assertionPolicyDigest, 'task visual check assertionPolicyDigest');
  assertPositiveSafeInteger(input.timeoutMs, 'task visual check timeoutMs');
  if (input.permissionRefs.length === 0) throw new ContractError('task visual check permissionRefs must not be empty');
  for (const permission of input.permissionRefs) assertNonEmpty(permission, 'task visual check permissionRefs entry');
  if (new Set(input.permissionRefs).size !== input.permissionRefs.length) {
    throw new ContractError('task visual check permissionRefs must be unique');
  }
}

export function validateTaskNativeCheckPolicy(input: TaskNativeCheckPolicy): void {
  assertNonEmpty(input.checkId, 'task native check checkId');
  if (input.kind !== 'native' || !input.required) throw new ContractError('task native check shape is invalid');
  if (!TASK_NATIVE_EVALUATORS.includes(input.evaluator)) throw new ContractError('task native check evaluator is invalid');
  assertSha256Digest(input.evaluatorDigest, 'task native check evaluatorDigest');
  assertPositiveSafeInteger(input.timeoutMs, 'task native check timeoutMs');
  for (const permission of input.permissionRefs) assertNonEmpty(permission, 'task native check permissionRefs entry');
  if (new Set(input.permissionRefs).size !== input.permissionRefs.length) {
    throw new ContractError('task native check permissionRefs must be unique');
  }
  if (input.evaluator === 'aitest-visual-motion-v1') {
    validateTaskVisualCheckPolicy(input.visual ?? ({} as TaskVisualCheckPolicy));
    return;
  }
  if (input.visual !== undefined) throw new ContractError('only the AItest evaluator can carry visual control');
}

export function validateTaskCheckPolicy(input: TaskCheckPolicy): void {
  if (input.kind === 'process') validateTaskProcessCheckPolicy(input);
  else validateTaskNativeCheckPolicy(input);
}

export function validateTaskVerificationPolicy(input: TaskVerificationPolicy): void {
  assertNonEmpty(input.policyId, 'task verification policy policyId');
  assertPositiveSafeInteger(input.policyRevision, 'task verification policy policyRevision');
  assertNonEmpty(input.requirementId, 'task verification policy requirementId');
  assertPositiveSafeInteger(input.directiveRevision, 'task verification policy directiveRevision');
  if (!(TASK_VERIFICATION_PROFILE_REFS as readonly string[]).includes(input.profileRef)) {
    throw new ContractError('task verification policy profileRef is invalid');
  }
  if (input.checks.length === 0) throw new ContractError('task verification policy requires checks');
  const checkIds = new Set<string>();
  for (const check of input.checks) {
    validateTaskCheckPolicy(check);
    if (checkIds.has(check.checkId)) throw new ContractError('task verification policy checkId values must be unique');
    checkIds.add(check.checkId);
  }
  if (input.profileRef === 'verification-profile://default/v1') {
    const check = input.checks[0];
    if (input.checks.length !== 1
      || check?.kind !== 'native'
      || check.evaluator !== 'default-task-output-v1'
      || check.checkId !== 'native-default-task-output') {
      throw new ContractError('default verification profile shape is invalid');
    }
  }
  if (input.profileRef === 'verification-profile://web-search/v1'
    && !input.checks.some((check) => check.kind === 'native' && check.evaluator === 'web-search-report-v1')) {
    throw new ContractError('web-search verification profile requires its native evaluator');
  }
  if (input.profileRef === 'verification-profile://local-file-search/v1'
    && !input.checks.some((check) => check.kind === 'native' && check.evaluator === 'local-file-search-report-v1')) {
    throw new ContractError('local-file-search verification profile requires its native evaluator');
  }
  if (input.profileRef === 'verification-profile://aitest/v1'
    && !input.checks.some((check) => check.kind === 'native' && check.evaluator === 'aitest-visual-motion-v1' && check.visual !== undefined)) {
    throw new ContractError('aitest verification profile requires visual control');
  }
  assertNonEmpty(input.compiledRef, 'task verification policy compiledRef');
  assertSha256Digest(input.compiledDigest, 'task verification policy compiledDigest');
}

export function validateTaskVerificationBinding(input: TaskVerificationBinding): void {
  assertNonEmpty(input.bindingRef, 'task verification binding bindingRef');
  assertNonEmpty(input.bindingDigest, 'task verification binding bindingDigest');
  assertNonEmpty(input.policyRef, 'task verification binding policyRef');
  assertNonEmpty(input.policyDigest, 'task verification binding policyDigest');
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'task verification binding taskId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'task verification binding operationId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonNegativeSafeIntegerOrZero(input.attempt, 'task verification binding attempt');
  assertNonEmpty(input.executionEvidenceRef, 'task verification binding executionEvidenceRef');
  assertNonEmpty(input.executionEvidenceDigest, 'task verification binding executionEvidenceDigest');
  if (input.artifacts.length === 0) throw new ContractError('task verification binding requires artifacts');
  if (input.artifacts.filter((artifact) => artifact.role === 'primary').length !== 1) {
    throw new ContractError('task verification binding requires exactly one primary artifact');
  }
  for (const artifact of input.artifacts) {
    assertNonEmpty(artifact.artifactRef, 'task verification binding artifactRef');
    assertNonEmpty(artifact.artifactDigest, 'task verification binding artifactDigest');
  }
  assertValidTime(input.boundAt, 'task verification binding boundAt');
}

export function validateTaskVisualObservationReceipt(input: TaskVisualObservationReceipt): void {
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'task observation receipt taskId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'task observation receipt operationId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonNegativeSafeIntegerOrZero(input.attempt, 'task observation receipt attempt');
  assertNonEmpty(input.bindingRef, 'task observation receipt bindingRef');
  assertNonEmpty(input.bindingDigest, 'task observation receipt bindingDigest');
  assertNonEmpty(input.primaryArtifactRef, 'task observation receipt primaryArtifactRef');
  assertNonEmpty(input.primaryArtifactDigest, 'task observation receipt primaryArtifactDigest');
  assertNonEmpty(input.screenshot.artifactRef, 'task observation receipt screenshot artifactRef');
  assertNonEmpty(input.screenshot.artifactDigest, 'task observation receipt screenshot artifactDigest');
  assertNonEmpty(input.motion.artifactRef, 'task observation receipt motion artifactRef');
  assertNonEmpty(input.motion.artifactDigest, 'task observation receipt motion artifactDigest');
  assertNonEmpty(input.motion.firstSampleRef, 'task observation receipt firstSampleRef');
  assertNonEmpty(input.motion.firstSampleDigest, 'task observation receipt firstSampleDigest');
  assertNonEmpty(input.motion.secondSampleRef, 'task observation receipt secondSampleRef');
  assertNonEmpty(input.motion.secondSampleDigest, 'task observation receipt secondSampleDigest');
  if (input.browserRelease.released !== true) {
    throw new ContractError('task observation receipt requires completed browser release');
  }
  assertNonEmpty(input.browserRelease.releaseRef, 'task observation receipt releaseRef');
  if (input.browserRelease.evidenceRefs.length === 0) {
    throw new ContractError('task observation receipt release evidence is required');
  }
  for (const evidence of input.browserRelease.evidenceRefs) assertEvidenceRef(evidence);
  if (input.evidenceRefs.length === 0) throw new ContractError('task observation receipt requires evidence');
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
  assertValidTime(input.producedAt, 'task observation receipt producedAt');
}

function validateTaskObservationInventory(input: TaskObservationRetainedInventory): void {
  for (const resource of input.resourceRefs) assertNonEmpty(resource, 'task observation retained resourceRef');
  for (const asset of input.assets) {
    assertNonEmpty(asset.artifactRef, 'task observation retained asset artifactRef');
    assertNonEmpty(asset.artifactDigest, 'task observation retained asset artifactDigest');
  }
}

export function validateTaskObservationProductionResult(input: TaskObservationProductionResult): void {
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'task observation production taskId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'task observation production operationId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonNegativeSafeIntegerOrZero(input.attempt, 'task observation production attempt');
  assertNonEmpty(input.bindingRef, 'task observation production bindingRef');
  assertNonEmpty(input.bindingDigest, 'task observation production bindingDigest');
  assertNonEmpty(input.primaryArtifactRef, 'task observation production primaryArtifactRef');
  assertNonEmpty(input.primaryArtifactDigest, 'task observation production primaryArtifactDigest');
  if (typeof input.browserCreated !== 'boolean') throw new ContractError('task observation production browserCreated must be boolean');
  if (input.evidenceRefs.length === 0) throw new ContractError('task observation production requires evidence');
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
  if (input.error !== undefined) {
    if (!TASK_OBSERVATION_ERROR_CODES.includes(input.error.code)) throw new ContractError('task observation production error code is invalid');
    assertNonEmpty(input.error.message, 'task observation production error message');
    if (input.error.evidenceRefs.length === 0) throw new ContractError('task observation production error requires evidence');
    for (const ref of input.error.evidenceRefs) assertEvidenceRef(ref);
    if (typeof input.error.retryable !== 'boolean') throw new ContractError('task observation production error retryable must be boolean');
    assertNonEmpty(input.error.recoveryOwner, 'task observation production error recoveryOwner');
    assertNonEmpty(input.error.nextAction, 'task observation production error nextAction');
    validateTaskObservationInventory(input.error.retained);
  }
  if (input.abort !== undefined) {
    if (!TASK_OBSERVATION_ABORT_REASONS.includes(input.abort.reason)) throw new ContractError('task observation production abort reason is invalid');
    assertNonEmpty(input.abort.recoveryOwner, 'task observation production abort recoveryOwner');
    assertNonEmpty(input.abort.nextAction, 'task observation production abort nextAction');
    validateTaskObservationInventory(input.abort.retained);
  }
  if (input.browserCreated && input.browserRelease === undefined) {
    throw new ContractError('task observation production requires browserRelease when browserCreated');
  }
  if (!input.browserCreated && input.browserRelease !== undefined) {
    throw new ContractError('task observation production cannot carry browserRelease without browserCreated');
  }
  if (input.browserRelease !== undefined) {
    if (input.browserRelease.released !== true) throw new ContractError('task observation production browserRelease must be released');
    assertNonEmpty(input.browserRelease.releaseRef, 'task observation production browserRelease releaseRef');
    if (input.browserRelease.evidenceRefs.length === 0) throw new ContractError('task observation production browserRelease requires evidence');
    for (const ref of input.browserRelease.evidenceRefs) assertEvidenceRef(ref);
  }
  if (input.status === 'produced') {
    if (!input.browserCreated || input.receipt === undefined) {
      throw new ContractError('produced task observation requires browserCreated and receipt');
    }
    validateTaskVisualObservationReceipt(input.receipt);
    if (input.browserRelease === undefined || input.browserRelease.released !== true) {
      throw new ContractError('produced task observation requires released browserRelease');
    }
  } else {
    if (input.receipt !== undefined) throw new ContractError('non-produced task observation cannot carry a receipt');
  }
}

export function validateVisualProducerResult(input: VisualProducerResult): void {
  assertNonEmpty(input.checkId, 'visual producer checkId');
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'visual producer taskId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'visual producer operationId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonNegativeSafeIntegerOrZero(input.attempt, 'visual producer attempt');
  assertNonEmpty(input.inputArtifactDigest, 'visual producer inputArtifactDigest');
  assertNonEmpty(input.capturedAt, 'visual producer capturedAt');
  assertNonEmpty(input.decisionRef, 'visual producer decisionRef');
  assertNonEmpty(input.decisionDigest, 'visual producer decisionDigest');
  if (!VISUAL_PRODUCER_RESULT_STATUSES.includes(input.status)) throw new ContractError('visual producer status is invalid');
  if (input.error !== undefined) {
    if (!VISUAL_PRODUCER_ERROR_CODES.includes(input.error.code)) throw new ContractError('visual producer error code is invalid');
    assertNonEmpty(input.error.message, 'visual producer error message');
    if (input.error.evidenceRefs.length === 0) throw new ContractError('visual producer error requires evidence');
    for (const ref of input.error.evidenceRefs) assertEvidenceRef(ref);
    if (typeof input.error.retryable !== 'boolean') throw new ContractError('visual producer error retryable must be boolean');
    assertNonEmpty(input.error.recoveryOwner, 'visual producer error recoveryOwner');
    assertNonEmpty(input.error.nextAction, 'visual producer error nextAction');
  }
  if (input.abort !== undefined && !VISUAL_PRODUCER_ABORT_REASONS.includes(input.abort.reason)) {
    throw new ContractError('visual producer abort reason is invalid');
  }
  if (input.drain !== undefined && typeof input.drain.drained !== 'boolean') {
    throw new ContractError('visual producer drain drained must be boolean');
  }
  for (const assertion of input.assertions) {
    if (!VISUAL_ASSERTION_NAMES.includes(assertion.assertion)) throw new ContractError('visual producer assertion is invalid');
    if (!VISUAL_VERDICTS.includes(assertion.verdict)) throw new ContractError('visual producer assertion verdict is invalid');
    assertNonEmpty(assertion.evidenceText, 'visual producer assertion evidenceText');
  }
  if (input.evidenceRefs.length === 0) throw new ContractError('visual producer requires evidence');
  for (const ref of input.evidenceRefs) assertEvidenceRef(ref);
  if (input.phase === 'not-dispatched') {
    if (input.status !== 'unavailable' && input.status !== 'cancelled') throw new ContractError('not-dispatched visual producer status is invalid');
    if (input.assertions.length !== 0) throw new ContractError('not-dispatched visual producer cannot carry assertions');
    if (input.error === undefined) throw new ContractError('not-dispatched visual producer requires error');
    const phantom = input as unknown as Record<string, unknown>;
    if (phantom.requestModel !== undefined
      || phantom.requestId !== undefined
      || phantom.responseModel !== undefined
      || phantom.responseId !== undefined
      || phantom.outputArtifactRef !== undefined
      || phantom.outputArtifactDigest !== undefined
      || phantom.settlementRef !== undefined
      || phantom.settlementDigest !== undefined) {
      throw new ContractError('not-dispatched visual producer cannot carry provider request, response, output, or settlement facts');
    }
  } else if (input.phase === 'dispatched') {
    if (input.status !== 'unknown' && input.status !== 'cancelled') throw new ContractError('dispatched visual producer status is invalid');
    assertNonEmpty(input.providerBindingId, 'dispatched visual producer providerBindingId');
    assertNonEmpty(input.providerBindingDigest, 'dispatched visual producer providerBindingDigest');
    assertNonEmpty(input.routeRef, 'dispatched visual producer routeRef');
    assertNonEmpty(input.requestModel, 'dispatched visual producer requestModel');
    assertNonEmpty(input.requestId, 'dispatched visual producer requestId');
    if (input.error === undefined) throw new ContractError('dispatched visual producer requires error');
  } else if (input.phase === 'settled') {
    if (input.status !== 'satisfied' && input.status !== 'rejected' && input.status !== 'unknown') {
      throw new ContractError('settled visual producer status is invalid');
    }
    assertNonEmpty(input.providerBindingId, 'settled visual producer providerBindingId');
    assertNonEmpty(input.providerBindingDigest, 'settled visual producer providerBindingDigest');
    assertNonEmpty(input.routeRef, 'settled visual producer routeRef');
    assertNonEmpty(input.requestModel, 'settled visual producer requestModel');
    assertNonEmpty(input.responseModel, 'settled visual producer responseModel');
    assertNonEmpty(input.requestId, 'settled visual producer requestId');
    assertNonEmpty(input.outputArtifactRef, 'settled visual producer outputArtifactRef');
    assertNonEmpty(input.outputArtifactDigest, 'settled visual producer outputArtifactDigest');
    assertNonEmpty(input.settlementRef, 'settled visual producer settlementRef');
    assertNonEmpty(input.settlementDigest, 'settled visual producer settlementDigest');
    if (input.status === 'satisfied' && input.assertions.some((assertion) => assertion.verdict !== 'satisfied')) {
      throw new ContractError('satisfied visual producer requires every assertion to be satisfied');
    }
    if (input.status === 'unknown' && input.error === undefined) {
      throw new ContractError('settled unknown visual producer requires error');
    }
  } else {
    throw new ContractError('visual producer phase is invalid');
  }
}

function validateTaskCheckEvidence(input: TaskCheckEvidence): void {
  assertNonEmpty(input.checkId, 'task check evidence checkId');
  for (let index = 0; index < input.artifactDigests.length; index += 1) {
    assertNonEmpty(input.artifactDigests[index]!, `task check evidence artifactDigests[${index}]`);
  }
  if (input.evidenceRefs.length === 0) throw new ContractError('task check evidence requires evidence');
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
  if (input.kind === 'process') {
    if (!['succeeded', 'failed', 'timed-out', 'cancelled'].includes(input.status)) {
      throw new ContractError('task process check evidence status is invalid');
    }
    if (typeof input.stdout !== 'string' || typeof input.stderr !== 'string') {
      throw new ContractError('task process check evidence stdout and stderr must be strings');
    }
    if (input.exitCode !== null && (!Number.isSafeInteger(input.exitCode) || input.exitCode < 0)) {
      throw new ContractError('task process check evidence exitCode must be a non-negative safe integer or null');
    }
    if (input.status === 'succeeded' && input.exitCode !== 0) {
      throw new ContractError('successful task process check evidence requires exitCode 0');
    }
    if (input.status === 'succeeded') {
      try {
        const parsed = JSON.parse(input.stdout);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      } catch {
        throw new ContractError('successful task process check evidence requires a JSON object on stdout');
      }
    }
    return;
  }
  if (!['succeeded', 'failed', 'blocked', 'cancelled'].includes(input.status)) {
    throw new ContractError('task native check evidence status is invalid');
  }
  assertNonEmpty(input.decisionRef, 'task native check evidence decisionRef');
  assertNonEmpty(input.decisionDigest, 'task native check evidence decisionDigest');
}

export function validateTaskVerificationResult(input: TaskVerificationResult): void {
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'task verification taskId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'task verification operationId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonNegativeSafeIntegerOrZero(input.attempt, 'task verification attempt');
  assertNonEmpty(input.inputArtifactDigest, 'task verification inputArtifactDigest');
  assertNonEmpty(input.policyRef, 'task verification policyRef');
  assertNonEmpty(input.policyDigest, 'task verification policyDigest');
  if (!['success', 'failed', 'rejected', 'missing', 'blocked', 'cancelled'].includes(input.status)) {
    throw new ContractError('task verification status is invalid');
  }
  if (input.rejectionCode !== undefined) {
    if (!['identity-mismatch', 'stale-epoch', 'checker-rejected'].includes(input.rejectionCode)) {
      throw new ContractError('task verification rejectionCode is invalid');
    }
    if (input.status === 'success') throw new ContractError('successful task verification cannot carry rejectionCode');
  }
  if (input.status === 'success') {
    if (input.checks.length === 0) throw new ContractError('successful task verification requires check evidence');
    if (input.checks.some((check) => check.status !== 'succeeded')) {
      throw new ContractError('successful task verification requires every check to succeed');
    }
    if (input.evidenceRefs.length === 0) throw new ContractError('successful task verification requires evidence');
  }
  if (input.status === 'rejected' && input.rejectionCode === undefined) {
    throw new ContractError('rejected task verification requires rejectionCode');
  }
  for (const check of input.checks) validateTaskCheckEvidence(check);
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
}

export function validateServeTaskTerminalReceipt(input: ServeTaskTerminalReceipt): void {
  validateTaskVerificationResult(input.verification);
  if (!sameExecutionIdentity(input, input.verification)) {
    throw new ContractError('serve-task terminal receipt identity does not match verification');
  }
  assertNonEmpty(input.terminalCheckpointRef, 'serve-task terminalCheckpointRef');
  assertNonEmpty(input.settlementReceiptRef, 'serve-task settlementReceiptRef');
  if (input.recoveryResponsibility !== undefined) {
    assertNonEmpty(input.recoveryResponsibility, 'serve-task recoveryResponsibility');
  }
}

export function validateRecoveryResponsibilityRecord(input: RecoveryResponsibilityRecord): void {
  if (!['confirmed-released', 'possible', 'confirmed-present'].includes(input.providerEffectState)) {
    throw new ContractError('recovery responsibility providerEffectState is invalid');
  }
  for (const resource of input.resourceInventory) assertEvidenceRef(resource);
  for (const proof of input.releaseProofs) assertEvidenceRef(proof);
  if (input.providerEffectState === 'confirmed-released' && input.releaseProofs.length === 0) {
    throw new ContractError('confirmed-released recovery responsibility requires release proof');
  }
}

function occurrenceBindingIdentity(input: OccurrenceTaskBinding): Record<string, unknown> {
  return {
    occurrenceId: input.occurrenceId,
    subscriptionId: input.subscriptionId,
    scheduleRevision: input.scheduleRevision,
    occurrenceOrdinal: input.occurrenceOrdinal,
    taskId: { scope: input.taskId.scope, value: input.taskId.value },
    operationId: { scope: input.operationId.scope, value: input.operationId.value },
    executionEpoch: input.executionEpoch,
    inputArtifactDigest: input.inputArtifactDigest,
  };
}

async function occurrenceBindingKey(domain: string, binding: OccurrenceTaskBinding): Promise<string> {
  validateOccurrenceTaskBinding(binding);
  const bytes = new TextEncoder().encode(canonicalJsonStringify({ domain, binding: occurrenceBindingIdentity(binding) }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export async function occurrenceExecutionAdmissionCommitId(binding: OccurrenceTaskBinding): Promise<string> {
  return occurrenceBindingKey('occurrence-execution-admission/v1', binding);
}

export async function occurrenceTerminalReceiptCommitId(binding: OccurrenceTaskBinding): Promise<string> {
  return occurrenceBindingKey('occurrence-terminal-receipt/v1', binding);
}

export function occurrenceExecutionDispatchRef(binding: OccurrenceTaskBinding): string {
  validateOccurrenceTaskBinding(binding);
  return `occurrence-execution-dispatch/v1:${binding.operationId.value}:${binding.executionEpoch}`;
}

export function validateOccurrenceExecutionAdmissionRecord(input: OccurrenceExecutionAdmissionRecord): void {
  if (input.kind !== 'occurrence-execution-admission') throw new ContractError('occurrence admission kind is invalid');
  if (input.version !== OCCURRENCE_EXECUTION_ADMISSION_RECORD_VERSION) {
    throw new ContractError('occurrence admission version is invalid');
  }
  validateOccurrenceTaskBinding(input.binding);
  assertNonEmpty(input.dispatchRef, 'occurrence admission dispatchRef');
  if (input.dispatchRef !== occurrenceExecutionDispatchRef(input.binding)) {
    throw new ContractError('occurrence admission dispatchRef does not match binding');
  }
  assertValidTime(input.admittedAt, 'occurrence admission admittedAt');
  validateOccurrenceExecutionOwner(input.admittedExecutionOwner);
  validateRecoveryResponsibilityRecord(input.recoveryResponsibility);
}

export function validateOccurrenceTerminalReceiptRecord(input: OccurrenceTerminalReceiptRecord): void {
  if (input.kind !== 'occurrence-terminal-receipt') throw new ContractError('occurrence terminal receipt kind is invalid');
  if (input.version !== OCCURRENCE_TERMINAL_RECEIPT_RECORD_VERSION) {
    throw new ContractError('occurrence terminal receipt version is invalid');
  }
  validateOccurrenceTaskBinding(input.binding);
  assertNonEmpty(input.terminalCheckpointRef, 'occurrence terminal receipt terminalCheckpointRef');
  if (![
    'succeeded',
    'waiting',
    'blocked',
    'failed',
    'cancelled',
    'stopped',
    'unknown',
  ].includes(input.terminalOutcome)) {
    throw new ContractError('occurrence terminal receipt outcome is invalid');
  }
  validateTaskVerificationResult(input.verification);
  if (!sameExecutionIdentity(input.binding, input.verification)) {
    throw new ContractError('occurrence terminal receipt verification identity does not match binding');
  }
  if (input.recoveryResponsibility !== undefined) validateRecoveryResponsibilityRecord(input.recoveryResponsibility);
  assertNonEmpty(input.settlementReceiptRef, 'occurrence terminal receipt settlementReceiptRef');
}

export function validateOccurrenceTaskBinding(input: OccurrenceTaskBinding): void {
  assertNonEmpty(input.occurrenceId, 'occurrence binding occurrenceId');
  assertNonEmpty(input.subscriptionId, 'occurrence binding subscriptionId');
  assertExecutionEpoch(input.scheduleRevision);
  assertExecutionEpoch(input.occurrenceOrdinal);
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'occurrence binding taskId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'occurrence binding operationId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonEmpty(input.inputArtifactDigest, 'occurrence binding inputArtifactDigest');
  if (input.occurrenceId !== `${input.subscriptionId}::${input.scheduleRevision}::${input.occurrenceOrdinal}`) {
    throw new ContractError('occurrence binding id does not match subscription schedule identity');
  }
}

export function validateOccurrenceSettlementInput(input: OccurrenceSettlementInput): void {
  validateOccurrenceTaskBinding(input.binding);
  validateServeTaskTerminalReceipt(input.terminalReceipt);
  if (!sameExecutionIdentity(input.binding, input.terminalReceipt)) {
    throw new ContractError('occurrence settlement receipt identity does not match binding');
  }
  if (!['succeeded', 'failed', 'blocked', 'cancelled', 'skipped-busy'].includes(input.outcome)) {
    throw new ContractError('occurrence settlement outcome is invalid');
  }
  if (input.outcome === 'succeeded' && input.terminalReceipt.verification.status !== 'success') {
    throw new ContractError('occurrence success requires a successful verified terminal receipt');
  }
  if (input.outcome === 'cancelled' && input.terminalReceipt.verification.status !== 'cancelled') {
    throw new ContractError('occurrence cancellation requires a cancelled verified terminal receipt');
  }
  if (input.outcome === 'failed' && input.terminalReceipt.verification.status === 'success') {
    throw new ContractError('occurrence failure cannot consume a successful verified terminal receipt');
  }
}

export function validateOccurrenceResult(input: OccurrenceResult): void {
  validateOccurrenceTaskBinding(input.binding);
  if (!['succeeded', 'failed', 'blocked', 'cancelled', 'skipped-busy'].includes(input.outcome)) {
    throw new ContractError('occurrence result outcome is invalid');
  }
  assertNonEmpty(input.terminalReceiptRef, 'occurrence result terminalReceiptRef');
  assertNonEmpty(input.settlementReceiptRef, 'occurrence result settlementReceiptRef');
  if (input.evidenceRefs.length === 0) throw new ContractError('occurrence result requires evidence');
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
  assertValidTime(input.completedAt, 'occurrence result completedAt');
}

function validateToolTraceDescriptor(input: ToolTraceDescriptor): void {
  assertNonEmpty(input.callId, 'tool trace callId');
  assertNonEmpty(input.toolId, 'tool trace toolId');
  if (input.argumentsRef !== undefined) assertNonEmpty(input.argumentsRef, 'tool trace argumentsRef');
  if (input.argumentsDigest !== undefined) assertNonEmpty(input.argumentsDigest, 'tool trace argumentsDigest');
  if (!['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'unknown'].includes(input.status)) {
    throw new ContractError('tool trace status is invalid');
  }
  if ((input.outputRef === undefined) !== (input.outputDigest === undefined)) {
    throw new ContractError('tool trace outputRef and outputDigest must be provided together');
  }
  if (input.status === 'succeeded' && input.outputRef === undefined) {
    throw new ContractError('succeeded tool trace requires outputRef and outputDigest');
  }
  if (input.outputRef !== undefined) assertNonEmpty(input.outputRef, 'tool trace outputRef');
  if (input.outputDigest !== undefined) assertNonEmpty(input.outputDigest, 'tool trace outputDigest');
  if (input.error !== undefined) {
    assertNonEmpty(input.error.code, 'tool trace error code');
    assertNonEmpty(input.error.message, 'tool trace error message');
    if (input.status !== 'failed' && input.status !== 'blocked' && input.status !== 'cancelled') {
      throw new ContractError('tool trace error requires a non-success status');
    }
  }
  if (input.startedAt !== undefined) assertValidTime(input.startedAt, 'tool trace startedAt');
  if (input.durationMs !== undefined) assertNonNegativeSafeInteger(input.durationMs, 'tool trace durationMs');
}

export function validateInteractionTraceEntry(input: InteractionTraceEntry): void {
  assertNonEmpty(input.turnId, 'trace turnId');
  assertNonEmpty(input.requestId, 'trace requestId');
  if (input.parentRequestId !== undefined) assertNonEmpty(input.parentRequestId, 'trace parentRequestId');
  assertExecutionEpoch(input.seq);
  assertValidTime(input.occurredAt, 'trace occurredAt');
  if (![
    'user',
    'assistant',
    'tool-call',
    'tool-result',
    'status',
    'decision',
    'failure',
    'cancel',
  ].includes(input.kind)) {
    throw new ContractError('trace kind is invalid');
  }
  if (input.modelRef !== undefined) assertNonEmpty(input.modelRef, 'trace modelRef');
  assertScope(input.taskId, 'task');
  assertNonEmpty(input.taskId.value, 'trace taskId');
  assertScope(input.operationId, 'operation');
  assertNonEmpty(input.operationId.value, 'trace operationId');
  assertExecutionEpoch(input.executionEpoch);
  if ((input.kind === 'tool-call' || input.kind === 'tool-result') && input.tool === undefined) {
    throw new ContractError('tool trace kind requires a tool descriptor');
  }
  if (input.tool !== undefined) validateToolTraceDescriptor(input.tool);
  if (input.authorization.executionEpoch !== input.executionEpoch
    || !sameScopedId(input.authorization.taskId, input.taskId)
    || !sameScopedId(input.authorization.operationId, input.operationId)) {
    throw new ContractError('trace authorization identity does not match trace');
  }
  validateScope(input.authorization.scope, 'trace authorization scope');
  if (input.authorization.scope.taskId !== undefined
    && !sameScopedId(input.authorization.scope.taskId, input.taskId)) {
    throw new ContractError('trace authorization scope taskId does not match trace');
  }
  if (input.authorization.scope.operationId !== undefined
    && !sameScopedId(input.authorization.scope.operationId, input.operationId)) {
    throw new ContractError('trace authorization scope operationId does not match trace');
  }
  for (const capability of input.authorization.requestedCapabilities) {
    assertNonEmpty(capability, 'trace requested capability');
  }
  for (const permission of input.authorization.permissionRefs) {
    assertNonEmpty(permission, 'trace permissionRef');
  }
  assertNonEmpty(input.authorization.toolOutputRef, 'trace toolOutputRef');
  if (input.tool?.outputRef !== undefined && input.authorization.toolOutputRef !== input.tool.outputRef) {
    throw new ContractError('trace authorization toolOutputRef does not match tool outputRef');
  }
  if (input.dependencyEdge !== undefined) {
    assertNonEmpty(input.dependencyEdge.source, 'trace dependency source');
    assertNonEmpty(input.dependencyEdge.target, 'trace dependency target');
    if (input.dependencyEdge.ref !== undefined) assertNonEmpty(input.dependencyEdge.ref, 'trace dependency ref');
    if (input.dependencyEdge.reason !== undefined) assertNonEmpty(input.dependencyEdge.reason, 'trace dependency reason');
  }
  for (const evidence of input.evidenceRefs) assertEvidenceRef(evidence);
  assertNonEmpty(input.state, 'trace state');
  for (const action of input.allowedActions) assertNonEmpty(action, 'trace allowed action');
  assertNonEmpty(input.provider.state, 'trace provider state');
  assertValidTime(input.provider.lastEventAt, 'trace provider lastEventAt');
  if (typeof input.transport.connected !== 'boolean') throw new ContractError('trace transport connected must be boolean');
  assertValidTime(input.transport.lastSyncedAt, 'trace transport lastSyncedAt');
  if (input.transport.cursor !== undefined) assertNonEmpty(input.transport.cursor, 'trace transport cursor');
  if (input.settlement.stoppedAt !== undefined) assertValidTime(input.settlement.stoppedAt, 'trace settlement stoppedAt');
  if (input.settlement.resultRef !== undefined) assertNonEmpty(input.settlement.resultRef, 'trace settlement resultRef');
  assertNonEmpty(input.lastBusiness.kind, 'trace lastBusiness kind');
  assertValidTime(input.lastBusiness.at, 'trace lastBusiness at');
  assertNonEmpty(input.lastBusiness.ref, 'trace lastBusiness ref');
}

export function validateInteractionHistoryQuery(input: InteractionHistoryQuery): void {
  if (input.cursor !== undefined) assertNonEmpty(input.cursor, 'history cursor');
  if (input.search !== undefined) assertNonEmpty(input.search, 'history search');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new ContractError('history limit must be a safe integer from 1 to 500');
  }
  if (input.filter !== undefined) {
    validateInteractionHistoryFilter(input.filter);
  }
}

function validateInteractionHistoryFilter(input: InteractionHistoryFilter): void {
  if (input.kinds !== undefined) {
    if (input.kinds.length === 0) throw new ContractError('history filter kinds cannot be empty');
    for (const kind of input.kinds) {
      if (!['user', 'assistant', 'tool-call', 'tool-result', 'status', 'decision', 'failure', 'cancel'].includes(kind)) {
        throw new ContractError('history filter kind is invalid');
      }
    }
  }
  if (input.taskId !== undefined) {
    assertScope(input.taskId, 'task');
    assertNonEmpty(input.taskId.value, 'history filter taskId');
  }
  if (input.operationId !== undefined) {
    assertScope(input.operationId, 'operation');
    assertNonEmpty(input.operationId.value, 'history filter operationId');
  }
  if (input.executionEpoch !== undefined) assertExecutionEpoch(input.executionEpoch);
  if (input.callId !== undefined) assertNonEmpty(input.callId, 'history filter callId');
  if (input.fromSeq !== undefined) assertExecutionEpoch(input.fromSeq);
  if (input.toSeq !== undefined) assertExecutionEpoch(input.toSeq);
  if (input.fromSeq !== undefined && input.toSeq !== undefined && input.fromSeq > input.toSeq) {
    throw new ContractError('history filter fromSeq cannot exceed toSeq');
  }
}

export function validateInteractionHistoryResult(input: InteractionHistoryResult): void {
  if (input.ok) {
    if (!input.page || typeof input.page !== 'object') throw new ContractError('history result requires a page');
    if (input.page.cursor !== undefined) assertNonEmpty(input.page.cursor, 'history page cursor');
    if (typeof input.page.hasMore !== 'boolean') throw new ContractError('history page hasMore must be boolean');
    if (input.page.filter !== undefined) validateInteractionHistoryFilter(input.page.filter);
    for (const entry of input.page.items) validateInteractionTraceEntry(entry);
    return;
  }
  if (!input.failure || typeof input.failure !== 'object') throw new ContractError('history failure requires a typed failure');
  if (!['stale-cursor', 'scope-mismatch', 'not-found', 'unavailable'].includes(input.failure.code)) {
    throw new ContractError('history failure code is invalid');
  }
  assertNonEmpty(input.failure.message, 'history failure message');
  if (typeof input.failure.retryable !== 'boolean') throw new ContractError('history failure retryable must be boolean');
  for (const evidence of input.failure.evidenceRefs ?? []) assertEvidenceRef(evidence);
}

export function validateInteractionWorkCard(input: InteractionWorkCard): void {
  assertScope(input.source.taskId, 'task');
  assertNonEmpty(input.source.taskId.value, 'work card taskId');
  assertScope(input.source.operationId, 'operation');
  assertNonEmpty(input.source.operationId.value, 'work card operationId');
  assertExecutionEpoch(input.source.executionEpoch);
  assertNonEmpty(input.source.requestId, 'work card requestId');
  assertNonEmpty(input.source.turnId, 'work card turnId');
  assertNonEmpty(input.currentNode, 'work card currentNode');
  assertNonEmpty(input.ownerId, 'work card ownerId');
  assertNonEmpty(input.nextStep, 'work card nextStep');
  assertNonEmpty(input.nextAction, 'work card nextAction');
  if (input.waitingOn !== undefined) assertNonEmpty(input.waitingOn, 'work card waitingOn');
  assertValidTime(input.startedAt, 'work card startedAt');
  assertNonEmpty(input.provider.state, 'work card provider state');
  assertValidTime(input.provider.lastEventAt, 'work card provider lastEventAt');
  if (typeof input.transport.connected !== 'boolean') throw new ContractError('work card transport connected must be boolean');
  assertValidTime(input.transport.lastSyncedAt, 'work card transport lastSyncedAt');
  if (input.transport.cursor !== undefined) assertNonEmpty(input.transport.cursor, 'work card transport cursor');
  if (input.settlement.stoppedAt !== undefined) assertValidTime(input.settlement.stoppedAt, 'work card settlement stoppedAt');
  if (input.settlement.resultRef !== undefined) assertNonEmpty(input.settlement.resultRef, 'work card settlement resultRef');
  assertNonEmpty(input.lastBusiness.kind, 'work card lastBusiness kind');
  assertValidTime(input.lastBusiness.at, 'work card lastBusiness at');
  assertNonEmpty(input.lastBusiness.ref, 'work card lastBusiness ref');
}
