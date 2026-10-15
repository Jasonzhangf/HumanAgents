import { assertEvidenceRef, assertSameScope, type CheckpointId, type EvidenceRef } from './index.js';
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

function uniqueStrings(values: unknown, label: string): void {
  if (!Array.isArray(values)) throw new ContractError(`${label} must be an array`);
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(value, label);
    if (seen.has(value)) throw new ContractError(`${label} must not contain duplicates`);
    seen.add(value);
  }
}

function scopeBoundEvidenceRef(ref: EvidenceRef, scope: AdmittedTurnIdentity['scopeRef'], label: string): void {
  try {
    assertEvidenceRef(ref);
    assertSameScope(scope, ref.scope);
  } catch (error) {
    throw new ContractError(error instanceof Error ? `${label}: ${error.message}` : `${label} is invalid`);
  }
}

function validateSummarySection(section: TurnSummarySection, label: string, scope: AdmittedTurnIdentity['scopeRef']): void {
  if (typeof section !== 'object' || section === null) throw new ContractError(`${label} must be an object`);
  nonEmpty(section.text, `${label} text`);
  if (!Array.isArray(section.evidenceRefs) || section.evidenceRefs.length === 0) {
    throw new ContractError(`${label} requires at least one evidence reference`);
  }
  const seen = new Set<string>();
  for (const ref of section.evidenceRefs) {
    scopeBoundEvidenceRef(ref, scope, `${label} evidence`);
    if (seen.has(ref.evidenceId.value)) throw new ContractError(`${label} evidence references must be unique`);
    seen.add(ref.evidenceId.value);
  }
}

export function validateTurnCloseSummary(summary: TurnCloseSummary, scope: AdmittedTurnIdentity['scopeRef']): void {
  if (typeof summary !== 'object' || summary === null) throw new ContractError('turn close summary must be an object');
  validateSummarySection(summary.goal, 'turn summary goal', scope);
  validateSummarySection(summary.actions, 'turn summary actions', scope);
  validateSummarySection(summary.result, 'turn summary result', scope);
  validateSummarySection(summary.expectedNextStep, 'turn summary expectedNextStep', scope);
}

export function validateTurnClosureReference(close: TurnClosureReference): void {
  if (typeof close !== 'object' || close === null) throw new ContractError('turn closure reference must be an object');
  validateAdmittedTurnIdentity(close.identity);
  checkpointScopedId(close.checkpointId, 'turn closure checkpointId');
  nonEmpty(close.closureRef, 'turn closure closureRef');
  validateTurnCloseSummary(close.summary, close.identity.scopeRef);
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
