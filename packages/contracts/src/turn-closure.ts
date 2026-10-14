import { assertEvidenceRef, assertSameScope, type CheckpointId, type EvidenceRef, type ScopeRef } from './index.js';
import { validateJournalCommitRef, type JournalCommitRef } from './i2-history.js';
import { validateAdmittedTurnIdentity, type AdmittedTurnIdentity } from './native-reasoning.js';
import { isCanonicalInstant } from './time.js';
import { ContractError } from './errors.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ALIGNMENT_DECISIONS = ['continue', 'complete', 'failed'] as const;

export type PlannerAlignmentDecision = (typeof ALIGNMENT_DECISIONS)[number];

/** One part of the turn summary. The text is for semantic reading; the refs bind it to evidence. */
export interface TurnSummarySection {
  readonly text: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

/** The four semantic parts the user requires before a complex task turn can close. */
export interface TurnCloseSummary {
  readonly goal: TurnSummarySection;
  readonly actions: TurnSummarySection;
  readonly result: TurnSummarySection;
  readonly expectedNextStep: TurnSummarySection;
}

/** Durable closure relationship for exactly one admitted turn: identity, checkpoint, and closure commit. */
export interface TurnClosureReference {
  readonly identity: AdmittedTurnIdentity;
  readonly checkpointId: CheckpointId;
  readonly closureRef: string;
  readonly summary: TurnCloseSummary;
  readonly recoveryStateRef: EvidenceRef;
  readonly closedAt: string;
}

/** Planner alignment binds one published plan revision to the same turn, checkpoint, and closure. */
export interface PlannerAlignmentReference {
  readonly identity: AdmittedTurnIdentity;
  readonly checkpointId: CheckpointId;
  readonly closureRef: string;
  readonly planRevisionId: string;
  readonly planRevisionSequence: number;
  readonly planContentDigest: `sha256:${string}`;
  readonly decision: PlannerAlignmentDecision;
  readonly alignedAt: string;
}

/** Same-turn recovery responsibility. It preserves the logical turn while closure or alignment is incomplete. */
export interface TurnRecoveryReference {
  readonly identity: AdmittedTurnIdentity;
  readonly recoveryStateRef: EvidenceRef;
  readonly contextRef: string;
  readonly unfinishedRef: string;
  readonly unreturnedCallRefs: readonly string[];
  readonly unresolvedOperationRefs: readonly string[];
  readonly firstErrorRef?: string;
}

/**
 * One real child tool operation whose evidence a parent turn may cite in its
 * summary or delivery. `evidenceRef` is the actual child evidence reference,
 * kept at the child's own scope; the remaining fields tie it to the durable
 * business registration and to the concrete provider request/tool call.
 */
export interface TurnSummaryEvidenceChild {
  readonly evidenceRef: EvidenceRef;
  readonly businessRegistrationCommitRef: JournalCommitRef;
  readonly providerRequestId: string;
  readonly toolCallId: string;
}

/**
 * Trusted control context for one parent turn's summary/delivery evidence.
 *
 * A trusted owner (the App readback over registration provenance and child
 * admission) builds it from real journal reads. Contracts only checks structure
 * and consistency: it never treats the context as source proof and never derives
 * it from model args, summary text or metadata. The context is a separate
 * control parameter, never a business field.
 */
export interface TurnSummaryEvidenceContext {
  readonly identity: AdmittedTurnIdentity;
  readonly children: readonly TurnSummaryEvidenceChild[];
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError(`${label} must be a non-empty string`);
}

function checkpointScopedId(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null) throw new ContractError(`${label} must be a checkpoint scoped id`);
  const scoped = value as { scope?: unknown; value?: unknown };
  if (scoped.scope !== 'checkpoint' || typeof scoped.value !== 'string' || !scoped.value.trim()) {
    throw new ContractError(`${label} must be a checkpoint scoped id`);
  }
}

function sameScopedId(left?: { readonly scope: string; readonly value: string }, right?: { readonly scope: string; readonly value: string }): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function identicalScopeRef(left: ScopeRef, right: ScopeRef): boolean {
  return sameScopedId(left.organId, right.organId)
    && sameScopedId(left.taskId, right.taskId)
    && sameScopedId(left.cycleId, right.cycleId)
    && sameScopedId(left.operationId, right.operationId);
}

/** Canonical full-value key of an evidence reference, including its own scope. */
function evidenceRefKey(ref: EvidenceRef): string {
  const scope = ref.scope;
  return JSON.stringify([
    ref.evidenceId.scope, ref.evidenceId.value, ref.kind, ref.source, ref.locator, ref.digest ?? null,
    scope.organId.scope, scope.organId.value,
    scope.taskId?.value ?? null, scope.cycleId?.value ?? null, scope.operationId?.value ?? null,
  ]);
}

function sameTurnIdentity(left: AdmittedTurnIdentity, right: AdmittedTurnIdentity): boolean {
  return left.turnId === right.turnId
    && left.workAssignmentRef === right.workAssignmentRef
    && left.inputRevision === right.inputRevision
    && left.directiveRevision === right.directiveRevision
    && left.executionEpoch === right.executionEpoch
    && left.runtimeBindingRef === right.runtimeBindingRef
    && left.permissionRevision === right.permissionRevision
    && sameScopedId(left.taskRef, right.taskRef)
    && sameScopedId(left.cycleRef, right.cycleRef)
    && identicalScopeRef(left.scopeRef, right.scopeRef);
}

/**
 * Validates the summary evidence context structure and that its identity is the
 * parent turn being closed. Each child must be a real, well-formed evidence ref
 * whose scope stays inside the parent turn's task and cycle: a child operation
 * under the same turn, never a foreign task or an unrelated scope.
 */
export function validateTurnSummaryEvidenceContext(context: TurnSummaryEvidenceContext, scope: ScopeRef): void {
  if (typeof context !== 'object' || context === null) {
    throw new ContractError('turn summary evidence context must be an object');
  }
  validateAdmittedTurnIdentity(context.identity);
  assertSameScope(scope, context.identity.scopeRef);
  if (!Array.isArray(context.children)) {
    throw new ContractError('turn summary evidence context children must be an array');
  }
  for (const child of context.children) {
    if (typeof child !== 'object' || child === null) {
      throw new ContractError('turn summary evidence context child must be an object');
    }
    assertEvidenceRef(child.evidenceRef);
    validateJournalCommitRef(child.businessRegistrationCommitRef);
    nonEmpty(child.providerRequestId, 'turn summary evidence context child providerRequestId');
    nonEmpty(child.toolCallId, 'turn summary evidence context child toolCallId');
    const childScope = child.evidenceRef.scope;
    if (!sameScopedId(context.identity.scopeRef.organId, childScope.organId)
      || !sameScopedId(context.identity.scopeRef.taskId, childScope.taskId)
      || !sameScopedId(context.identity.scopeRef.cycleId, childScope.cycleId)
      || !childScope.operationId) {
      throw new ContractError('turn summary evidence context child must be an operation under the parent turn');
    }
  }
}

/** Allowlist of full-value child evidence keys for one validated parent turn. */
export function turnSummaryEvidenceAllowSet(context: TurnSummaryEvidenceContext, scope: ScopeRef): ReadonlySet<string> {
  validateTurnSummaryEvidenceContext(context, scope);
  const keys = new Set<string>();
  for (const child of context.children) keys.add(evidenceRefKey(child.evidenceRef));
  return keys;
}

/** True when the reference full-value matches an allowlisted real child evidence reference. */
export function isAllowlistedTurnSummaryEvidence(allow: ReadonlySet<string> | undefined, ref: EvidenceRef): boolean {
  return allow !== undefined && allow.has(evidenceRefKey(ref));
}

/** Throws when the context identity is not the admitted turn being closed. */
export function assertTurnSummaryContextIdentity(context: TurnSummaryEvidenceContext, identity: AdmittedTurnIdentity): void {
  if (!sameTurnIdentity(context.identity, identity)) {
    throw new ContractError('turn summary evidence context does not match the admitted turn identity');
  }
}

function uniqueStrings(values: unknown, label: string): void {
  if (!Array.isArray(values)) throw new ContractError(`${label} must be an array`);
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(value, label);
    if (seen.has(value)) throw new ContractError(`${label} must not contain duplicates`);
    seen.add(value);
  }
}

function scopeBoundEvidenceRef(ref: EvidenceRef, scope: AdmittedTurnIdentity['scopeRef'], label: string, allow?: ReadonlySet<string>): void {
  try {
    assertEvidenceRef(ref);
  } catch (error) {
    throw new ContractError(error instanceof Error ? `${label}: ${error.message}` : `${label} is invalid`);
  }
  try {
    assertSameScope(scope, ref.scope);
  } catch (error) {
    if (isAllowlistedTurnSummaryEvidence(allow, ref)) return;
    throw new ContractError(error instanceof Error ? `${label}: ${error.message}` : `${label} is invalid`);
  }
}

function validateSummarySection(section: TurnSummarySection, label: string, scope: AdmittedTurnIdentity['scopeRef'], allow?: ReadonlySet<string>): void {
  if (typeof section !== 'object' || section === null) throw new ContractError(`${label} must be an object`);
  nonEmpty(section.text, `${label} text`);
  if (!Array.isArray(section.evidenceRefs) || section.evidenceRefs.length === 0) {
    throw new ContractError(`${label} requires at least one evidence reference`);
  }
  const seen = new Set<string>();
  for (const ref of section.evidenceRefs) {
    scopeBoundEvidenceRef(ref, scope, `${label} evidence`, allow);
    if (seen.has(ref.evidenceId.value)) throw new ContractError(`${label} evidence references must be unique`);
    seen.add(ref.evidenceId.value);
  }
}

/**
 * When `context` is absent, evidence refs must sit at the exact parent turn
 * scope, as before. When present, evidence refs may also be real child
 * operations whose full-value reference is allowlisted by the context.
 */
export function validateTurnCloseSummary(
  summary: TurnCloseSummary,
  scope: AdmittedTurnIdentity['scopeRef'],
  context?: TurnSummaryEvidenceContext,
): void {
  if (typeof summary !== 'object' || summary === null) throw new ContractError('turn close summary must be an object');
  const allow = context === undefined ? undefined : turnSummaryEvidenceAllowSet(context, scope);
  validateSummarySection(summary.goal, 'turn summary goal', scope, allow);
  validateSummarySection(summary.actions, 'turn summary actions', scope, allow);
  validateSummarySection(summary.result, 'turn summary result', scope, allow);
  validateSummarySection(summary.expectedNextStep, 'turn summary expectedNextStep', scope, allow);
}

export function validateTurnClosureReference(close: TurnClosureReference, context?: TurnSummaryEvidenceContext): void {
  if (typeof close !== 'object' || close === null) throw new ContractError('turn closure reference must be an object');
  validateAdmittedTurnIdentity(close.identity);
  checkpointScopedId(close.checkpointId, 'turn closure checkpointId');
  nonEmpty(close.closureRef, 'turn closure closureRef');
  if (context !== undefined) assertTurnSummaryContextIdentity(context, close.identity);
  validateTurnCloseSummary(close.summary, close.identity.scopeRef, context);
  scopeBoundEvidenceRef(close.recoveryStateRef, close.identity.scopeRef, 'turn closure recoveryStateRef');
  if (!isCanonicalInstant(close.closedAt)) throw new ContractError('turn closure closedAt must be a canonical instant');
}

export function validatePlannerAlignmentReference(alignment: PlannerAlignmentReference): void {
  if (typeof alignment !== 'object' || alignment === null) throw new ContractError('planner alignment reference must be an object');
  validateAdmittedTurnIdentity(alignment.identity);
  checkpointScopedId(alignment.checkpointId, 'planner alignment checkpointId');
  nonEmpty(alignment.closureRef, 'planner alignment closureRef');
  nonEmpty(alignment.planRevisionId, 'planner alignment planRevisionId');
  if (!Number.isSafeInteger(alignment.planRevisionSequence) || alignment.planRevisionSequence < 1) {
    throw new ContractError('planner alignment planRevisionSequence must be a positive safe integer');
  }
  if (typeof alignment.planContentDigest !== 'string' || !SHA256.test(alignment.planContentDigest)) {
    throw new ContractError('planner alignment planContentDigest must be a lowercase sha256 digest');
  }
  if (!ALIGNMENT_DECISIONS.includes(alignment.decision)) throw new ContractError('planner alignment decision is invalid');
  if (!isCanonicalInstant(alignment.alignedAt)) throw new ContractError('planner alignment alignedAt must be a canonical instant');
}

export function validateTurnRecoveryReference(recovery: TurnRecoveryReference): void {
  if (typeof recovery !== 'object' || recovery === null) throw new ContractError('turn recovery reference must be an object');
  validateAdmittedTurnIdentity(recovery.identity);
  scopeBoundEvidenceRef(recovery.recoveryStateRef, recovery.identity.scopeRef, 'turn recovery recoveryStateRef');
  nonEmpty(recovery.contextRef, 'turn recovery contextRef');
  nonEmpty(recovery.unfinishedRef, 'turn recovery unfinishedRef');
  uniqueStrings(recovery.unreturnedCallRefs, 'turn recovery unreturnedCallRefs');
  uniqueStrings(recovery.unresolvedOperationRefs, 'turn recovery unresolvedOperationRefs');
  if (recovery.firstErrorRef !== undefined) nonEmpty(recovery.firstErrorRef, 'turn recovery firstErrorRef');
}
