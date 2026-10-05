import {
  assertEvidenceRef,
  assertExecutionEpoch,
  assertNextAction,
  assertScope,
  type CycleId,
  type EvidenceRef,
  type NextAction,
  type OperationId,
  type OrganId,
  type ScopeRef,
  type TaskId,
} from './index.js';
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

export function validateInteractionHistoryQuery(input: InteractionHistoryQuery): void {
  if (input.cursor !== undefined) assertNonEmpty(input.cursor, 'history cursor');
  if (input.search !== undefined) assertNonEmpty(input.search, 'history search');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw new ContractError('history limit must be a safe integer from 1 to 500');
  }
  if (input.filter !== undefined) validateInteractionHistoryFilter(input.filter);
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
