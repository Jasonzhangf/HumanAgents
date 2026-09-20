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
  return sameScopedId(pattern.organId, scope.organId)
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
