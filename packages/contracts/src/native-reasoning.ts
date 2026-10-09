import type { CycleId, ScopeRef, TaskId } from './index.js';
import { ContractError } from './errors.js';
import { isCanonicalInstant } from './time.js';

export type EffectState =
  | 'not-started' | 'accepted' | 'running' | 'succeeded' | 'failed'
  | 'blocked' | 'cancelled' | 'unknown' | 'stale';

export interface AdmittedTurn {
  readonly turnId: string;
  readonly workAssignmentRef: string;
  readonly taskRef: TaskId;
  readonly scopeRef: ScopeRef;
  readonly cycleRef: CycleId;
  readonly inputRevision: number;
  readonly directiveRevision: number;
  readonly executionEpoch: number;
  readonly runtimeBindingRef: string;
  readonly permissionRevision: string;
  readonly admissionEvidenceRefs: readonly string[];
  readonly currentTurnRef: string;
  readonly recoveryStateRef: string;
}

export type AdmittedTurnIdentity = Pick<AdmittedTurn,
  | 'turnId' | 'workAssignmentRef' | 'taskRef' | 'scopeRef' | 'cycleRef'
  | 'inputRevision' | 'directiveRevision' | 'executionEpoch'
  | 'runtimeBindingRef' | 'permissionRevision'>;

export interface ToolIdentity {
  readonly surface: string;
  readonly toolId: string;
  readonly bindingRef: string;
  readonly route: string;
}

export interface ToolExecutionFact {
  readonly identity: ToolIdentity;
  readonly requestRef: string;
  readonly callRef?: string;
  readonly operationRef?: string;
  readonly state: EffectState;
  readonly rawEvidenceRefs: readonly string[];
  readonly resultRef?: string;
  readonly resultDigest?: string;
  readonly errorRef?: string;
}

export interface TurnExecutionFacts {
  readonly turnId: string;
  readonly dispatchState: 'not-dispatched' | 'accepted' | 'running' | 'returned' | 'failed' | 'unknown' | 'cancelled';
  readonly assignmentRef: string;
  readonly childResultRef?: string;
  readonly workResultState?: 'reported' | 'accepted' | 'rejected' | 'incomplete' | 'unknown';
  readonly toolFacts: readonly ToolExecutionFact[];
  readonly operationRefs: readonly string[];
  readonly acceptanceEvidenceRefs: readonly string[];
  readonly firstErrorRef?: string;
  readonly unresolvedOperationRefs: readonly string[];
  readonly rawTurnRefs: readonly string[];
}

export type SemanticCertainty = 'confirmed' | 'partial' | 'unknown' | 'corrected';

export interface SemanticClaim {
  readonly fact: string;
  readonly certainty: SemanticCertainty;
  readonly sourceRefs: readonly string[];
}

export interface SemanticClosureCandidate {
  readonly turnId: string;
  readonly checkpointSummary: string;
  readonly ruleVersion: string;
  readonly claims: readonly SemanticClaim[];
  readonly constraints: readonly SemanticClaim[];
  readonly unresolvedQuestions: readonly string[];
  readonly semanticArtifactRefs: readonly string[];
  readonly rawTurnRefs: readonly string[];
  readonly requestedOutcome: 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'stopped' | 'unknown';
}

export interface NativeStageError {
  readonly code: string;
  readonly message: string;
  readonly errorRef: string;
}

export type StageResult<T> =
  | { readonly stageId: string; readonly state: 'succeeded'; readonly value: T; readonly evidenceRefs: readonly string[] }
  | { readonly stageId: string; readonly state: 'failed'; readonly error: NativeStageError; readonly recoveryRef: string; readonly evidenceRefs: readonly string[] }
  | { readonly stageId: string; readonly state: 'not-executed'; readonly blockedByStage: string; readonly causeRef: string; readonly firstErrorRef?: string; readonly recoveryRef: string };

export type DurablePhase = 'recovery-assets' | 'checkpoint' | 'closure' | 'context-view' | 'history-publication';

export type DurablePhaseOutcome =
  | { readonly phase: DurablePhase; readonly state: 'committed'; readonly receiptRef: string }
  | { readonly phase: DurablePhase; readonly state: 'failed' | 'unknown'; readonly receiptRef?: string }
  | { readonly phase: DurablePhase; readonly state: 'not-executed' };

export interface DurableCheckpointReceipt {
  readonly commitIdentity: string;
  readonly checkpointRef: string;
  readonly journalReceiptRef: string;
  /** Canonical UTC instant assigned by the Harness checkpoint owner on first durable commit. */
  readonly committedAt: string;
  readonly timeAuthority: {
    readonly source: 'harness';
    readonly owner: 'runtime-checkpoint-control-owner';
    readonly authorityRef: string;
  };
}

export type DurableCheckpointReceiptIdentity = Pick<DurableCheckpointReceipt, 'commitIdentity' | 'checkpointRef'>;

export interface CheckpointBoundaryOutcome {
  readonly commitIdentity: string;
  readonly stages: readonly StageResult<unknown>[];
  readonly durablePhases: readonly DurablePhaseOutcome[];
  readonly checkpointReceipt?: DurableCheckpointReceipt;
  readonly closureReceiptRef?: string;
  readonly contextViewReceiptRef?: string;
  readonly historyReceiptRef?: string;
  readonly firstErrorRef?: string;
  readonly laterErrorRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
  readonly rawTurnRefs: readonly string[];
  readonly recoveryRef?: string;
}

export interface RecoveryHoldFacts {
  readonly commitIdentity: string;
  readonly firstErrorRef?: string;
  readonly laterErrorRefs: readonly string[];
  readonly rawTurnRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
  readonly stages: readonly StageResult<unknown>[];
  readonly durablePhases: readonly DurablePhaseOutcome[];
  readonly durableReceiptRefs: readonly string[];
  readonly recoveryResponsibilityRef: string;
}

export type SuccessPathProjection =
  | { readonly path: 'success'; readonly active: true; readonly durableTurnReceiptRef: string; readonly checkpointReceiptRef: string; readonly historyReceiptRef: string }
  | { readonly path: 'success'; readonly active: false; readonly reasonRef: string };

export type RecoveryHoldProjection =
  | { readonly path: 'recovery-hold'; readonly active: true; readonly facts: RecoveryHoldFacts }
  | { readonly path: 'recovery-hold'; readonly active: false; readonly reasonRef: string };

export type TurnDisposition =
  | { readonly state: 'ready-next'; readonly durableTurnReceiptRef: string; readonly checkpointReceiptRef: string; readonly historyReceiptRef: string; readonly nextActionRef: string }
  | { readonly state: 'waiting-recovery'; readonly recoveryRef: string; readonly firstErrorRef?: string }
  | { readonly state: 'waiting-reconcile'; readonly operationRefs: readonly string[]; readonly recoveryRef: string }
  | { readonly state: 'waiting-correction'; readonly rawTurnRefs: readonly string[]; readonly correctionRef: string }
  | { readonly state: 'stopped'; readonly stopOperationRef: string; readonly settleEvidenceRefs: readonly string[]; readonly checkpointReceiptRef: string }
  | { readonly state: 'save-incomplete'; readonly commitIdentity: string; readonly durablePhases: readonly DurablePhaseOutcome[]; readonly recoveryRef: string; readonly firstErrorRef?: string }
  | { readonly state: 'stale'; readonly evidenceRef: string; readonly currentEpoch: number };

export interface NativeTurnBoundary {
  readonly outcome: CheckpointBoundaryOutcome;
  readonly success: SuccessPathProjection;
  readonly recovery: RecoveryHoldProjection;
  readonly disposition: TurnDisposition;
}

const DURABLE_PHASES: readonly DurablePhase[] = [
  'recovery-assets', 'checkpoint', 'closure', 'context-view', 'history-publication',
];
const EFFECT_STATES: readonly EffectState[] = [
  'not-started', 'accepted', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'unknown', 'stale',
];
const DISPATCH_STATES = ['not-dispatched', 'accepted', 'running', 'returned', 'failed', 'unknown', 'cancelled'] as const;
const WORK_RESULT_STATES = ['reported', 'accepted', 'rejected', 'incomplete', 'unknown'] as const;
const OUTCOMES = ['succeeded', 'waiting', 'blocked', 'failed', 'cancelled', 'stopped', 'unknown'] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContractError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ContractError(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new ContractError(`${label} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ContractError(`${label} does not accept ${key}`);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError(`${label} must be a non-empty string`);
}

function safePositive(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ContractError(`${label} must be a positive safe integer`);
}

function stringArray(value: unknown, label: string, minimum = 0): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new ContractError(`${label} must be an array with at least ${minimum} entries`);
  for (const entry of value) nonEmpty(entry, label);
}

function uniqueStringArray(value: unknown, label: string, minimum = 0): asserts value is readonly string[] {
  stringArray(value, label, minimum);
  if (new Set(value).size !== value.length) throw new ContractError(`${label} must not contain duplicates`);
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): asserts value is T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ContractError(`${label} is invalid`);
}

function scopedId(value: unknown, kind: 'organ' | 'task' | 'cycle' | 'operation' | 'checkpoint' | 'evidence', label: string): void {
  const input = record(value, label);
  exactKeys(input, ['scope', 'value'], [], label);
  if (input.scope !== kind) throw new ContractError(`${label} must use ${kind} scope`);
  if (typeof input.value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.value)) {
    throw new ContractError(`${label} value is invalid`);
  }
}

function validateScope(value: unknown, label: string): asserts value is ScopeRef {
  const input = record(value, label);
  exactKeys(input, ['organId'], ['taskId', 'cycleId', 'operationId'], label);
  scopedId(input.organId, 'organ', `${label}.organId`);
  if (Object.hasOwn(input, 'taskId')) scopedId(input.taskId, 'task', `${label}.taskId`);
  if (Object.hasOwn(input, 'cycleId')) scopedId(input.cycleId, 'cycle', `${label}.cycleId`);
  if (Object.hasOwn(input, 'operationId')) scopedId(input.operationId, 'operation', `${label}.operationId`);
}

function sameScopedId(left: unknown, right: unknown): boolean {
  const a = record(left, 'left scoped id');
  const b = record(right, 'right scoped id');
  return a.scope === b.scope && a.value === b.value;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  const sameOptional = (a: unknown, b: unknown): boolean => a === undefined
    ? b === undefined
    : b !== undefined && sameScopedId(a, b);
  return sameScopedId(left.organId, right.organId)
    && sameOptional(left.taskId, right.taskId)
    && sameOptional(left.cycleId, right.cycleId)
    && sameOptional(left.operationId, right.operationId);
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExpectedTurnIdentity(value: unknown): asserts value is AdmittedTurnIdentity {
  const input = record(value, 'expected admitted turn identity');
  exactKeys(input,
    ['turnId', 'workAssignmentRef', 'taskRef', 'scopeRef', 'cycleRef', 'inputRevision', 'directiveRevision', 'executionEpoch', 'runtimeBindingRef', 'permissionRevision'],
    [], 'expected admitted turn identity');
  nonEmpty(input.turnId, 'expected turnId');
  nonEmpty(input.workAssignmentRef, 'expected workAssignmentRef');
  scopedId(input.taskRef, 'task', 'expected taskRef');
  validateScope(input.scopeRef, 'expected scopeRef');
  scopedId(input.cycleRef, 'cycle', 'expected cycleRef');
  safePositive(input.inputRevision, 'expected inputRevision');
  safePositive(input.directiveRevision, 'expected directiveRevision');
  safePositive(input.executionEpoch, 'expected executionEpoch');
  nonEmpty(input.runtimeBindingRef, 'expected runtimeBindingRef');
  nonEmpty(input.permissionRevision, 'expected permissionRevision');
}

function validateExpectedIdentityMatches(actual: AdmittedTurn, expected: AdmittedTurnIdentity): void {
  if (actual.turnId !== expected.turnId
    || actual.workAssignmentRef !== expected.workAssignmentRef
    || !sameScopedId(actual.taskRef, expected.taskRef)
    || !sameScope(actual.scopeRef, expected.scopeRef)
    || !sameScopedId(actual.cycleRef, expected.cycleRef)
    || actual.inputRevision !== expected.inputRevision
    || actual.directiveRevision !== expected.directiveRevision
    || actual.executionEpoch !== expected.executionEpoch
    || actual.runtimeBindingRef !== expected.runtimeBindingRef
    || actual.permissionRevision !== expected.permissionRevision) {
    throw new ContractError('admitted turn does not match expected identity');
  }
}

export function validateAdmittedTurn(value: unknown, expectedIdentity?: AdmittedTurnIdentity): asserts value is AdmittedTurn {
  const input = record(value, 'admitted turn');
  exactKeys(input,
    ['turnId', 'workAssignmentRef', 'taskRef', 'scopeRef', 'cycleRef', 'inputRevision', 'directiveRevision', 'executionEpoch', 'runtimeBindingRef', 'permissionRevision', 'admissionEvidenceRefs', 'currentTurnRef', 'recoveryStateRef'],
    [], 'admitted turn');
  nonEmpty(input.turnId, 'turnId');
  nonEmpty(input.workAssignmentRef, 'workAssignmentRef');
  scopedId(input.taskRef, 'task', 'taskRef');
  validateScope(input.scopeRef, 'scopeRef');
  scopedId(input.cycleRef, 'cycle', 'cycleRef');
  const scope = input.scopeRef as ScopeRef;
  if (!scope.taskId || !sameScopedId(scope.taskId, input.taskRef)) throw new ContractError('scopeRef taskId must match taskRef');
  if (!scope.cycleId || !sameScopedId(scope.cycleId, input.cycleRef)) throw new ContractError('scopeRef cycleId must match cycleRef');
  safePositive(input.inputRevision, 'inputRevision');
  safePositive(input.directiveRevision, 'directiveRevision');
  safePositive(input.executionEpoch, 'executionEpoch');
  nonEmpty(input.runtimeBindingRef, 'runtimeBindingRef');
  nonEmpty(input.permissionRevision, 'permissionRevision');
  uniqueStringArray(input.admissionEvidenceRefs, 'admissionEvidenceRefs');
  nonEmpty(input.currentTurnRef, 'currentTurnRef');
  nonEmpty(input.recoveryStateRef, 'recoveryStateRef');
  if (expectedIdentity !== undefined) {
    validateExpectedTurnIdentity(expectedIdentity);
    validateExpectedIdentityMatches(value as AdmittedTurn, expectedIdentity);
  }
}

function validateToolIdentity(value: unknown, expected?: ToolIdentity): asserts value is ToolIdentity {
  const input = record(value, 'tool identity');
  exactKeys(input, ['surface', 'toolId', 'bindingRef', 'route'], [], 'tool identity');
  nonEmpty(input.surface, 'tool identity surface');
  nonEmpty(input.toolId, 'tool identity toolId');
  nonEmpty(input.bindingRef, 'tool identity bindingRef');
  nonEmpty(input.route, 'tool identity route');
  if (expected !== undefined) {
    const expectedInput = record(expected, 'expected tool identity');
    exactKeys(expectedInput, ['surface', 'toolId', 'bindingRef', 'route'], [], 'expected tool identity');
    if (input.surface !== expected.surface || input.toolId !== expected.toolId
      || input.bindingRef !== expected.bindingRef || input.route !== expected.route) {
      throw new ContractError('tool identity mismatch');
    }
  }
}

export function validateToolExecutionFact(value: unknown, expectedToolIdentity?: ToolIdentity): asserts value is ToolExecutionFact {
  const input = record(value, 'tool execution fact');
  exactKeys(input, ['identity', 'requestRef', 'state', 'rawEvidenceRefs'], ['callRef', 'operationRef', 'resultRef', 'resultDigest', 'errorRef'], 'tool execution fact');
  validateToolIdentity(input.identity, expectedToolIdentity);
  nonEmpty(input.requestRef, 'requestRef');
  member(input.state, EFFECT_STATES, 'tool effect state');
  stringArray(input.rawEvidenceRefs, 'rawEvidenceRefs');
  for (const field of ['callRef', 'operationRef', 'resultRef', 'resultDigest', 'errorRef'] as const) {
    if (Object.hasOwn(input, field)) nonEmpty(input[field], field);
  }
}

export function validateTurnExecutionFacts(value: unknown, admittedTurn: AdmittedTurn): asserts value is TurnExecutionFacts {
  validateAdmittedTurn(admittedTurn);
  const input = record(value, 'turn execution facts');
  exactKeys(input,
    ['turnId', 'dispatchState', 'assignmentRef', 'toolFacts', 'operationRefs', 'acceptanceEvidenceRefs', 'unresolvedOperationRefs', 'rawTurnRefs'],
    ['childResultRef', 'workResultState', 'firstErrorRef'], 'turn execution facts');
  nonEmpty(input.turnId, 'turnId');
  if (input.turnId !== admittedTurn.turnId) throw new ContractError('turn facts turnId mismatch');
  member(input.dispatchState, DISPATCH_STATES, 'dispatchState');
  nonEmpty(input.assignmentRef, 'assignmentRef');
  if (input.assignmentRef !== admittedTurn.workAssignmentRef) throw new ContractError('turn facts assignmentRef mismatch');
  if (Object.hasOwn(input, 'childResultRef')) nonEmpty(input.childResultRef, 'childResultRef');
  if (Object.hasOwn(input, 'workResultState')) member(input.workResultState, WORK_RESULT_STATES, 'workResultState');
  if (!Array.isArray(input.toolFacts)) throw new ContractError('toolFacts must be an array');
  for (const fact of input.toolFacts) validateToolExecutionFact(fact);
  uniqueStringArray(input.operationRefs, 'operationRefs');
  stringArray(input.acceptanceEvidenceRefs, 'acceptanceEvidenceRefs');
  if (Object.hasOwn(input, 'firstErrorRef')) nonEmpty(input.firstErrorRef, 'firstErrorRef');
  uniqueStringArray(input.unresolvedOperationRefs, 'unresolvedOperationRefs');
  const operationRefs = input.operationRefs as readonly string[];
  for (const ref of input.unresolvedOperationRefs as readonly string[]) {
    if (!operationRefs.includes(ref)) throw new ContractError('unresolved operation must be present in operationRefs');
  }
  stringArray(input.rawTurnRefs, 'rawTurnRefs');
}

function validateSemanticClaim(value: unknown, label: string): asserts value is SemanticClaim {
  const input = record(value, label);
  exactKeys(input, ['fact', 'certainty', 'sourceRefs'], [], label);
  nonEmpty(input.fact, `${label}.fact`);
  member(input.certainty, ['confirmed', 'partial', 'unknown', 'corrected'] as const, `${label}.certainty`);
  uniqueStringArray(input.sourceRefs, `${label}.sourceRefs`, 1);
}

export function validateSemanticClosureCandidate(value: unknown, admittedTurn: AdmittedTurn): asserts value is SemanticClosureCandidate {
  validateAdmittedTurn(admittedTurn);
  const input = record(value, 'semantic closure candidate');
  exactKeys(input,
    ['turnId', 'checkpointSummary', 'ruleVersion', 'claims', 'constraints', 'unresolvedQuestions', 'semanticArtifactRefs', 'rawTurnRefs', 'requestedOutcome'],
    [], 'semantic closure candidate');
  nonEmpty(input.turnId, 'candidate turnId');
  if (input.turnId !== admittedTurn.turnId) throw new ContractError('candidate turnId mismatch');
  nonEmpty(input.checkpointSummary, 'checkpointSummary');
  nonEmpty(input.ruleVersion, 'ruleVersion');
  if (!Array.isArray(input.claims)) throw new ContractError('claims must be an array');
  input.claims.forEach((claim, index) => validateSemanticClaim(claim, `claims[${index}]`));
  if (!Array.isArray(input.constraints)) throw new ContractError('constraints must be an array');
  input.constraints.forEach((claim, index) => validateSemanticClaim(claim, `constraints[${index}]`));
  stringArray(input.unresolvedQuestions, 'unresolvedQuestions');
  stringArray(input.semanticArtifactRefs, 'semanticArtifactRefs');
  stringArray(input.rawTurnRefs, 'rawTurnRefs');
  member(input.requestedOutcome, OUTCOMES, 'requestedOutcome');
}

export function validateStageResult(value: unknown): asserts value is StageResult<unknown> {
  const input = record(value, 'stage result');
  nonEmpty(input.stageId, 'stageId');
  member(input.state, ['succeeded', 'failed', 'not-executed'] as const, 'stage state');
  if (input.state === 'succeeded') {
    exactKeys(input, ['stageId', 'state', 'value', 'evidenceRefs'], [], 'succeeded stage result');
    stringArray(input.evidenceRefs, 'stage evidenceRefs');
    return;
  }
  if (input.state === 'failed') {
    exactKeys(input, ['stageId', 'state', 'error', 'recoveryRef', 'evidenceRefs'], [], 'failed stage result');
    const error = record(input.error, 'stage error');
    exactKeys(error, ['code', 'message', 'errorRef'], [], 'stage error');
    nonEmpty(error.code, 'stage error code');
    nonEmpty(error.message, 'stage error message');
    nonEmpty(error.errorRef, 'stage error errorRef');
    nonEmpty(input.recoveryRef, 'recoveryRef');
    stringArray(input.evidenceRefs, 'stage evidenceRefs');
    return;
  }
  exactKeys(input, ['stageId', 'state', 'blockedByStage', 'causeRef', 'recoveryRef'], ['firstErrorRef'], 'not-executed stage result');
  nonEmpty(input.blockedByStage, 'blockedByStage');
  nonEmpty(input.causeRef, 'causeRef');
  if (Object.hasOwn(input, 'firstErrorRef')) nonEmpty(input.firstErrorRef, 'firstErrorRef');
  nonEmpty(input.recoveryRef, 'recoveryRef');
}

function validateDurablePhaseOutcome(value: unknown, label: string): asserts value is DurablePhaseOutcome {
  const input = record(value, label);
  member(input.phase, DURABLE_PHASES, `${label}.phase`);
  member(input.state, ['committed', 'failed', 'unknown', 'not-executed'] as const, `${label}.state`);
  if (input.state === 'committed') {
    exactKeys(input, ['phase', 'state', 'receiptRef'], [], label);
    nonEmpty(input.receiptRef, `${label}.receiptRef`);
  } else if (input.state === 'failed' || input.state === 'unknown') {
    exactKeys(input, ['phase', 'state'], ['receiptRef'], label);
    if (Object.hasOwn(input, 'receiptRef')) nonEmpty(input.receiptRef, `${label}.receiptRef`);
  } else {
    exactKeys(input, ['phase', 'state'], [], label);
  }
}

function phaseAt(phases: readonly DurablePhaseOutcome[], phase: DurablePhase): DurablePhaseOutcome {
  const value = phases.find((entry) => entry.phase === phase);
  if (!value) throw new ContractError(`durable phase ${phase} is missing`);
  return value;
}

function validateTimeAuthority(value: unknown): void {
  const input = record(value, 'timeAuthority');
  exactKeys(input, ['source', 'owner', 'authorityRef'], [], 'timeAuthority');
  if (input.source !== 'harness') throw new ContractError('timeAuthority source must be harness');
  if (input.owner !== 'runtime-checkpoint-control-owner') throw new ContractError('timeAuthority owner is invalid');
  nonEmpty(input.authorityRef, 'timeAuthority authorityRef');
}

export function validateDurableCheckpointReceipt(value: unknown, expectedIdentity: DurableCheckpointReceiptIdentity): asserts value is DurableCheckpointReceipt {
  const input = record(value, 'durable checkpoint receipt');
  exactKeys(input, ['commitIdentity', 'checkpointRef', 'journalReceiptRef', 'committedAt', 'timeAuthority'], [], 'durable checkpoint receipt');
  nonEmpty(input.commitIdentity, 'commitIdentity');
  nonEmpty(input.checkpointRef, 'checkpointRef');
  nonEmpty(input.journalReceiptRef, 'journalReceiptRef');
  if (!isCanonicalInstant(input.committedAt)) throw new ContractError('committedAt must be a canonical UTC instant');
  validateTimeAuthority(input.timeAuthority);
  const expected = record(expectedIdentity, 'expected receipt identity');
  exactKeys(expected, ['commitIdentity', 'checkpointRef'], [], 'expected receipt identity');
  nonEmpty(expected.commitIdentity, 'expected commitIdentity');
  nonEmpty(expected.checkpointRef, 'expected checkpointRef');
  if (input.commitIdentity !== expected.commitIdentity || input.checkpointRef !== expected.checkpointRef) {
    throw new ContractError('checkpoint receipt identity mismatch');
  }
}

function validateDurablePhases(value: unknown): asserts value is readonly DurablePhaseOutcome[] {
  if (!Array.isArray(value) || value.length !== DURABLE_PHASES.length) throw new ContractError('durablePhases must contain exactly five phases');
  let halted = false;
  value.forEach((phase, index) => {
    validateDurablePhaseOutcome(phase, `durablePhases[${index}]`);
    if (phase.phase !== DURABLE_PHASES[index]) throw new ContractError('durablePhases must appear once in canonical order');
    if (halted && phase.state !== 'not-executed') {
      throw new ContractError('durable phases after the first incomplete phase must be not-executed');
    }
    if (phase.state !== 'committed') halted = true;
  });
}

function refsFromPhases(phases: readonly DurablePhaseOutcome[]): readonly string[] {
  return phases.flatMap((phase) => 'receiptRef' in phase && typeof phase.receiptRef === 'string' ? [phase.receiptRef] : []);
}

export function validateCheckpointBoundaryOutcome(value: unknown): asserts value is CheckpointBoundaryOutcome {
  const input = record(value, 'checkpoint boundary outcome');
  exactKeys(input,
    ['commitIdentity', 'stages', 'durablePhases', 'laterErrorRefs', 'unresolvedOperationRefs', 'rawTurnRefs'],
    ['checkpointReceipt', 'closureReceiptRef', 'contextViewReceiptRef', 'historyReceiptRef', 'firstErrorRef', 'recoveryRef'],
    'checkpoint boundary outcome');
  nonEmpty(input.commitIdentity, 'commitIdentity');
  if (!Array.isArray(input.stages) || input.stages.length === 0) throw new ContractError('stages must contain at least one stage result');
  input.stages.forEach((stage) => validateStageResult(stage));
  validateDurablePhases(input.durablePhases);
  uniqueStringArray(input.laterErrorRefs, 'laterErrorRefs');
  uniqueStringArray(input.unresolvedOperationRefs, 'unresolvedOperationRefs');
  stringArray(input.rawTurnRefs, 'rawTurnRefs');
  if (Object.hasOwn(input, 'firstErrorRef')) nonEmpty(input.firstErrorRef, 'firstErrorRef');
  if (Object.hasOwn(input, 'recoveryRef')) nonEmpty(input.recoveryRef, 'recoveryRef');

  const phases = input.durablePhases as readonly DurablePhaseOutcome[];
  const checkpointPhase = phaseAt(phases, 'checkpoint');
  if (checkpointPhase.state === 'committed') {
    if (!Object.hasOwn(input, 'checkpointReceipt')) throw new ContractError('committed checkpoint phase requires checkpointReceipt');
    validateDurableCheckpointReceipt(input.checkpointReceipt, {
      commitIdentity: input.commitIdentity as string,
      checkpointRef: (input.checkpointReceipt as DurableCheckpointReceipt).checkpointRef,
    });
    const receipt = input.checkpointReceipt as DurableCheckpointReceipt;
    if (checkpointPhase.receiptRef !== receipt.journalReceiptRef) throw new ContractError('checkpoint Journal receipt does not match durable phase receipt');
  } else if (Object.hasOwn(input, 'checkpointReceipt')) {
    throw new ContractError('checkpointReceipt requires committed checkpoint phase');
  }

  const receiptFields: readonly [DurablePhase, string][] = [
    ['closure', 'closureReceiptRef'],
    ['context-view', 'contextViewReceiptRef'],
    ['history-publication', 'historyReceiptRef'],
  ];
  for (const [phaseName, field] of receiptFields) {
    const phase = phaseAt(phases, phaseName);
    if (phase.state === 'committed') {
      if (!Object.hasOwn(input, field)) throw new ContractError(`${phaseName} committed phase requires ${field}`);
      if (phase.receiptRef !== input[field]) throw new ContractError(`${phaseName} receipt reference mismatch`);
    } else if (Object.hasOwn(input, field)) {
      throw new ContractError(`${field} requires committed ${phaseName} phase`);
    }
  }

  const stages = input.stages as readonly StageResult<unknown>[];
  const failedStages = stages.filter((stage): stage is Extract<StageResult<unknown>, { readonly state: 'failed' }> => stage.state === 'failed');
  const earliestFailedStage = failedStages[0];
  if (earliestFailedStage && input.firstErrorRef !== earliestFailedStage.error.errorRef) {
    throw new ContractError('firstErrorRef must match the earliest failed stage error');
  }
  // D0-G does not define a durable-phase-to-StageResult error foreign key. Keep a failed phase's
  // error responsibility visible, while validating source equality only for ordered failed stages.
  if (phases.some((phase) => phase.state === 'failed') && !Object.hasOwn(input, 'firstErrorRef')) {
    throw new ContractError('failed durable phase requires firstErrorRef');
  }
  const needsRecovery = phases.some((phase) => phase.state !== 'committed')
    || stages.some((stage) => stage.state !== 'succeeded')
    || (input.unresolvedOperationRefs as readonly string[]).length > 0
    || Object.hasOwn(input, 'firstErrorRef')
    || (input.laterErrorRefs as readonly string[]).length > 0;
  if (needsRecovery && !Object.hasOwn(input, 'recoveryRef')) throw new ContractError('incomplete boundary requires recoveryRef');
  if (earliestFailedStage && !Object.hasOwn(input, 'firstErrorRef')) {
    throw new ContractError('failed stage requires firstErrorRef');
  }
}

function validateRecoveryHoldFacts(value: unknown): asserts value is RecoveryHoldFacts {
  const input = record(value, 'recovery hold facts');
  exactKeys(input,
    ['commitIdentity', 'laterErrorRefs', 'rawTurnRefs', 'unresolvedOperationRefs', 'stages', 'durablePhases', 'durableReceiptRefs', 'recoveryResponsibilityRef'],
    ['firstErrorRef'], 'recovery hold facts');
  nonEmpty(input.commitIdentity, 'recovery commitIdentity');
  if (Object.hasOwn(input, 'firstErrorRef')) nonEmpty(input.firstErrorRef, 'recovery firstErrorRef');
  uniqueStringArray(input.laterErrorRefs, 'recovery laterErrorRefs');
  stringArray(input.rawTurnRefs, 'recovery rawTurnRefs');
  uniqueStringArray(input.unresolvedOperationRefs, 'recovery unresolvedOperationRefs');
  if (!Array.isArray(input.stages) || input.stages.length === 0) throw new ContractError('recovery stages must not be empty');
  input.stages.forEach((stage) => validateStageResult(stage));
  validateDurablePhases(input.durablePhases);
  uniqueStringArray(input.durableReceiptRefs, 'durableReceiptRefs');
  nonEmpty(input.recoveryResponsibilityRef, 'recoveryResponsibilityRef');
}

function validateSuccessProjection(value: unknown): asserts value is SuccessPathProjection {
  const input = record(value, 'success path projection');
  if (input.path !== 'success') throw new ContractError('success projection path is invalid');
  if (input.active === true) {
    exactKeys(input, ['path', 'active', 'durableTurnReceiptRef', 'checkpointReceiptRef', 'historyReceiptRef'], [], 'active success projection');
    nonEmpty(input.durableTurnReceiptRef, 'durableTurnReceiptRef');
    nonEmpty(input.checkpointReceiptRef, 'checkpointReceiptRef');
    nonEmpty(input.historyReceiptRef, 'historyReceiptRef');
  } else if (input.active === false) {
    exactKeys(input, ['path', 'active', 'reasonRef'], [], 'inactive success projection');
    nonEmpty(input.reasonRef, 'success inactive reasonRef');
  } else {
    throw new ContractError('success projection active must be boolean');
  }
}

function validateRecoveryProjection(value: unknown): asserts value is RecoveryHoldProjection {
  const input = record(value, 'recovery hold projection');
  if (input.path !== 'recovery-hold') throw new ContractError('recovery projection path is invalid');
  if (input.active === true) {
    exactKeys(input, ['path', 'active', 'facts'], [], 'active recovery projection');
    validateRecoveryHoldFacts(input.facts);
  } else if (input.active === false) {
    exactKeys(input, ['path', 'active', 'reasonRef'], [], 'inactive recovery projection');
    nonEmpty(input.reasonRef, 'recovery inactive reasonRef');
  } else {
    throw new ContractError('recovery projection active must be boolean');
  }
}

export function validateTurnDisposition(value: unknown): asserts value is TurnDisposition {
  const input = record(value, 'turn disposition');
  member(input.state, ['ready-next', 'waiting-recovery', 'waiting-reconcile', 'waiting-correction', 'stopped', 'save-incomplete', 'stale'] as const, 'turn disposition state');
  switch (input.state) {
    case 'ready-next':
      exactKeys(input, ['state', 'durableTurnReceiptRef', 'checkpointReceiptRef', 'historyReceiptRef', 'nextActionRef'], [], 'ready-next disposition');
      nonEmpty(input.durableTurnReceiptRef, 'durableTurnReceiptRef');
      nonEmpty(input.checkpointReceiptRef, 'checkpointReceiptRef');
      nonEmpty(input.historyReceiptRef, 'historyReceiptRef');
      nonEmpty(input.nextActionRef, 'nextActionRef');
      return;
    case 'waiting-recovery':
      exactKeys(input, ['state', 'recoveryRef'], ['firstErrorRef'], 'waiting-recovery disposition');
      nonEmpty(input.recoveryRef, 'recoveryRef');
      if (Object.hasOwn(input, 'firstErrorRef')) nonEmpty(input.firstErrorRef, 'firstErrorRef');
      return;
    case 'waiting-reconcile':
      exactKeys(input, ['state', 'operationRefs', 'recoveryRef'], [], 'waiting-reconcile disposition');
      uniqueStringArray(input.operationRefs, 'operationRefs', 1);
      nonEmpty(input.recoveryRef, 'recoveryRef');
      return;
    case 'waiting-correction':
      exactKeys(input, ['state', 'rawTurnRefs', 'correctionRef'], [], 'waiting-correction disposition');
      uniqueStringArray(input.rawTurnRefs, 'rawTurnRefs', 1);
      nonEmpty(input.correctionRef, 'correctionRef');
      return;
    case 'stopped':
      exactKeys(input, ['state', 'stopOperationRef', 'settleEvidenceRefs', 'checkpointReceiptRef'], [], 'stopped disposition');
      nonEmpty(input.stopOperationRef, 'stopOperationRef');
      uniqueStringArray(input.settleEvidenceRefs, 'settleEvidenceRefs', 1);
      nonEmpty(input.checkpointReceiptRef, 'checkpointReceiptRef');
      return;
    case 'save-incomplete':
      exactKeys(input, ['state', 'commitIdentity', 'durablePhases', 'recoveryRef'], ['firstErrorRef'], 'save-incomplete disposition');
      nonEmpty(input.commitIdentity, 'commitIdentity');
      validateDurablePhases(input.durablePhases);
      nonEmpty(input.recoveryRef, 'recoveryRef');
      if (Object.hasOwn(input, 'firstErrorRef')) nonEmpty(input.firstErrorRef, 'firstErrorRef');
      return;
    case 'stale':
      exactKeys(input, ['state', 'evidenceRef', 'currentEpoch'], [], 'stale disposition');
      nonEmpty(input.evidenceRef, 'evidenceRef');
      safePositive(input.currentEpoch, 'currentEpoch');
      return;
  }
}

function validateBoundaryRecoveryMatches(outcome: CheckpointBoundaryOutcome, recovery: RecoveryHoldFacts): void {
  if (recovery.commitIdentity !== outcome.commitIdentity
    || recovery.firstErrorRef !== outcome.firstErrorRef
    || !sameRefs(recovery.laterErrorRefs, outcome.laterErrorRefs)
    || !sameRefs(recovery.rawTurnRefs, outcome.rawTurnRefs)
    || !sameRefs(recovery.unresolvedOperationRefs, outcome.unresolvedOperationRefs)
    || !sameJson(recovery.stages, outcome.stages)
    || !sameJson(recovery.durablePhases, outcome.durablePhases)
    || !sameRefs(recovery.durableReceiptRefs, refsFromPhases(outcome.durablePhases))
    || recovery.recoveryResponsibilityRef !== outcome.recoveryRef) {
    throw new ContractError('recovery projection must preserve boundary facts');
  }
}

export function validateNativeTurnBoundary(value: unknown): asserts value is NativeTurnBoundary {
  const input = record(value, 'native turn boundary');
  exactKeys(input, ['outcome', 'success', 'recovery', 'disposition'], [], 'native turn boundary');
  validateCheckpointBoundaryOutcome(input.outcome);
  validateSuccessProjection(input.success);
  validateRecoveryProjection(input.recovery);
  validateTurnDisposition(input.disposition);
  const outcome = input.outcome as CheckpointBoundaryOutcome;
  const success = input.success as SuccessPathProjection;
  const recovery = input.recovery as RecoveryHoldProjection;
  const disposition = input.disposition as TurnDisposition;
  if (success.active === recovery.active) throw new ContractError('exactly one success or recovery projection must be active');

  if (success.active) {
    if (disposition.state !== 'ready-next' || recovery.active) throw new ContractError('active success projection requires ready-next disposition');
    const phases = outcome.durablePhases;
    if (phases.some((phase) => phase.state !== 'committed')
      || !outcome.checkpointReceipt || !outcome.closureReceiptRef || !outcome.contextViewReceiptRef || !outcome.historyReceiptRef
      || outcome.firstErrorRef || outcome.laterErrorRefs.length > 0 || outcome.unresolvedOperationRefs.length > 0
      || outcome.stages.some((stage) => stage.state !== 'succeeded')) {
      throw new ContractError('ready-next requires all durable receipts and no errors or unresolved work');
    }
    if (success.checkpointReceiptRef !== outcome.checkpointReceipt.checkpointRef
      || success.historyReceiptRef !== outcome.historyReceiptRef
      || disposition.durableTurnReceiptRef !== success.durableTurnReceiptRef
      || disposition.checkpointReceiptRef !== success.checkpointReceiptRef
      || disposition.historyReceiptRef !== success.historyReceiptRef) {
      throw new ContractError('success projection and ready-next disposition mismatch');
    }
    return;
  }

  if (recovery.active) {
    if (disposition.state === 'ready-next') throw new ContractError('active recovery projection cannot have ready-next disposition');
    validateBoundaryRecoveryMatches(outcome, recovery.facts);
    if (disposition.state === 'save-incomplete'
      && (disposition.commitIdentity !== outcome.commitIdentity
        || !sameJson(disposition.durablePhases, outcome.durablePhases)
        || disposition.recoveryRef !== recovery.facts.recoveryResponsibilityRef
        || disposition.firstErrorRef !== outcome.firstErrorRef)) {
      throw new ContractError('save-incomplete disposition and recovery facts mismatch');
    }
    if (disposition.state === 'waiting-recovery'
      && (disposition.recoveryRef !== recovery.facts.recoveryResponsibilityRef
        || disposition.firstErrorRef !== outcome.firstErrorRef)) {
      throw new ContractError('waiting-recovery disposition and recovery facts mismatch');
    }
    if (disposition.state === 'waiting-reconcile'
      && (disposition.recoveryRef !== recovery.facts.recoveryResponsibilityRef
        || !sameRefs(disposition.operationRefs, outcome.unresolvedOperationRefs))) {
      throw new ContractError('waiting-reconcile disposition and recovery facts mismatch');
    }
    if (disposition.state === 'waiting-correction' && !sameRefs(disposition.rawTurnRefs, outcome.rawTurnRefs)) {
      throw new ContractError('waiting-correction disposition and raw turn refs mismatch');
    }
    if (disposition.state === 'stopped'
      && (phaseAt(outcome.durablePhases, 'checkpoint').state !== 'committed'
        || phaseAt(outcome.durablePhases, 'closure').state !== 'committed'
        || !outcome.checkpointReceipt
        || !outcome.closureReceiptRef
        || disposition.checkpointReceiptRef !== outcome.checkpointReceipt.checkpointRef
        || outcome.unresolvedOperationRefs.length > 0)) {
      throw new ContractError('stopped disposition requires committed checkpoint and closure receipts with no unresolved operations');
    }
  }
}
