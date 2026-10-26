/**
 * Taskless interaction helper contract.
 *
 * This module owns only the narrow handoff identity, taskless assignment/result
 * shapes, explicit interaction history shapes, and append-only handoff facts.
 * Runtime/Intake remains responsible for allocating the identity and composing
 * context. The Organ Journal remains responsible for authoritative persistence.
 *
 * No TaskId is required or synthesized. Work fields are reused by field type,
 * not by widening the existing Task-bound contracts.
 */

import {
  ContractError,
  assertAgentRuntimeId,
  assertExecutionEpoch,
  assertEvidenceRef,
  assertScope,
  type AgentRuntimeId,
  type EvidenceRef,
  type OrganId,
  type OperationId,
  type ProviderProtocol,
  type RawAsset,
  type SemanticClaim,
  type WorkAssignment,
  type WorkResult,
} from './index.js';

export interface InteractionIdentity {
  readonly organId: OrganId;
  readonly interactionScopeId: string;
  readonly interactionId: string;
  readonly inputRevision: number;
}

export interface InteractionTurnIdentity extends InteractionIdentity {
  readonly turnId: string;
}

/** Exact identity allocated by Runtime/Intake before a helper call is dispatched. */
export interface InteractionHelperIdentity
  extends InteractionIdentity,
    Pick<WorkAssignment, 'assignmentId' | 'attempt'> {
  readonly parentTurnId: string;
  readonly helperCallId: string;
}

/** Real execution and provider binding identity acquired before dispatch. */
export interface InteractionHelperIncarnation extends InteractionHelperIdentity {
  readonly runtimeId: AgentRuntimeId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly bindingId: string;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly modelRef: string;
  readonly capabilityDigest: string;
}

export type InteractionHelperAssignmentFields = Pick<
  WorkAssignment,
  | 'objective'
  | 'targetRefs'
  | 'expectedOutputRefs'
  | 'successCriteria'
  | 'failureCriteria'
  | 'incompleteCriteria'
  | 'requiredCapabilities'
  | 'mergeGate'
>;

export interface InteractionHelperAssignment
  extends InteractionHelperIdentity,
    InteractionHelperAssignmentFields {}

export type InteractionHelperResultFields = Pick<
  WorkResult,
  | 'agentId'
  | 'producedArtifactRefs'
  | 'producedArtifactBodies'
  | 'status'
  | 'summary'
  | 'outputRefs'
  | 'evidenceRefs'
  | 'nextAction'
  | 'conditionRef'
  | 'failureRef'
>;

export interface InteractionHelperResult
  extends InteractionHelperIdentity,
    InteractionHelperResultFields {}

/**
 * Historical interaction context is a committed semantic ref, not a raw turn.
 * The optional claims/constraints use the existing semantic value type. Complex
 * task turns keep their existing four-part Task-bound checkpoint contract.
 */
export interface InteractionSemanticCheckpoint extends InteractionTurnIdentity {
  readonly kind: 'semantic-checkpoint';
  readonly committedAt: string;
  readonly claims: readonly SemanticClaim[];
  readonly constraints: readonly SemanticClaim[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly semanticAssetRefs: readonly EvidenceRef[];
}

export type InteractionLatestTurnEntry =
  | {
      readonly kind: 'user-input';
      readonly content: RawAsset;
    }
  | {
      readonly kind: 'assistant-output';
      readonly content: RawAsset;
    }
  | {
      readonly kind: 'clarification';
      readonly question: RawAsset;
      readonly answer?: RawAsset;
    }
  | {
      readonly kind: 'helper-result';
      readonly result: InteractionHelperResult;
      readonly refinedResult: RawAsset;
    };

/** The only full raw turn retained by the explicit interaction context. */
export interface InteractionLatestTurn extends InteractionTurnIdentity {
  readonly entries: readonly InteractionLatestTurnEntry[];
}

export interface InteractionHelperDispatchAcceptedFact {
  readonly kind: 'dispatch-accepted';
  readonly assignment: InteractionHelperAssignment;
  readonly incarnation?: InteractionHelperIncarnation;
  readonly dispatchAcceptedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface InteractionHelperRunningFact {
  readonly kind: 'running';
  readonly identity: InteractionHelperIdentity;
  readonly startedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface InteractionHelperReturnedFact {
  readonly kind: 'returned';
  readonly result: InteractionHelperResult;
  readonly returnedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface InteractionHelperOwnerAcceptedFact {
  readonly kind: 'owner-accepted';
  readonly result: InteractionHelperResult;
  readonly refinedResult: RawAsset;
  readonly acceptedBy: string;
  readonly acceptanceRef: string;
  readonly acceptedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type InteractionHelperHandoffFact =
  | InteractionHelperDispatchAcceptedFact
  | InteractionHelperRunningFact
  | InteractionHelperReturnedFact
  | InteractionHelperOwnerAcceptedFact;

const HELPER_RESULT_STATUSES = ['succeeded', 'failed', 'incomplete', 'blocked', 'cancelled'] as const;
const HELPER_NEXT_ACTIONS = ['continue', 'wait', 'attention', 'review', 'settle', 'remediate'] as const;
const SEMANTIC_CERTAINTIES = ['confirmed', 'partial', 'unknown', 'corrected'] as const;
const HELPER_PROVIDER_PROTOCOLS = new Set<ProviderProtocol>([
  'responses',
  'anthropic',
  'openai',
  'other-explicit',
]);

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

function assertValidTimestamp(value: string, label: string): void {
  assertNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new ContractError(`${label} must be a valid timestamp`);
  }
}

function assertStringArray(value: readonly string[], label: string): void {
  if (!Array.isArray(value)) throw new ContractError(`${label} must be an array`);
  for (const entry of value) assertNonEmptyString(entry, label);
}

function sameOrganId(left: OrganId, right: OrganId): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function sameInteractionIdentity(left: InteractionIdentity, right: InteractionIdentity): boolean {
  return sameOrganId(left.organId, right.organId)
    && left.interactionScopeId === right.interactionScopeId
    && left.interactionId === right.interactionId
    && left.inputRevision === right.inputRevision;
}

function sameHelperIdentity(
  left: InteractionHelperIdentity,
  right: InteractionHelperIdentity,
): boolean {
  return sameInteractionIdentity(left, right)
    && left.parentTurnId === right.parentTurnId
    && left.assignmentId === right.assignmentId
    && left.helperCallId === right.helperCallId
    && left.attempt === right.attempt;
}

function assertHelperEvidenceRef(
  ref: EvidenceRef,
  organId: OrganId,
  label: string,
): void {
  assertEvidenceRef(ref);
  if (!sameOrganId(ref.scope.organId, organId)) {
    throw new ContractError(`${label} has a foreign organ scope`);
  }
}

function assertHelperEvidenceRefs(
  refs: readonly EvidenceRef[],
  organId: OrganId,
  label: string,
): void {
  if (!Array.isArray(refs)) throw new ContractError(`${label} must be an array`);
  refs.forEach((ref, index) => assertHelperEvidenceRef(ref, organId, `${label}[${index}]`));
}

function assertRawAsset(asset: RawAsset, organId: OrganId, label: string): void {
  assertHelperEvidenceRef(asset.ref, organId, `${label}.ref`);
  if (asset.view === null || typeof asset.view !== 'object') {
    throw new ContractError(`${label}.view must be an object`);
  }
  switch (asset.view.kind) {
    case 'utf8-text':
    case 'arguments':
      return;
    case 'content-part':
      if (!Number.isSafeInteger(asset.view.partIndex) || asset.view.partIndex < 0) {
        throw new ContractError(`${label}.view.partIndex must be a non-negative safe integer`);
      }
      return;
    case 'text-field':
      if (asset.view.field !== 'text' && asset.view.field !== 'delta') {
        throw new ContractError(`${label}.view.field is invalid`);
      }
      return;
    case 'thinking-field':
      if (asset.view.field !== 'thinking' && asset.view.field !== 'signature') {
        throw new ContractError(`${label}.view.field is invalid`);
      }
      return;
    case 'reasoning-item':
      if (asset.view.selector !== 'item-text' && asset.view.selector !== 'summary') {
        throw new ContractError(`${label}.view.selector is invalid`);
      }
      return;
    default:
      throw new ContractError(`${label}.view.kind is invalid`);
  }
}

function assertSemanticClaim(claim: SemanticClaim, label: string): void {
  assertNonEmptyString(claim.fact, `${label}.fact`);
  if (!SEMANTIC_CERTAINTIES.includes(claim.certainty)) {
    throw new ContractError(`${label}.certainty is invalid`);
  }
  if (!Array.isArray(claim.sourceRefs) || claim.sourceRefs.length === 0) {
    throw new ContractError(`${label}.sourceRefs must be a non-empty array`);
  }
  assertStringArray(claim.sourceRefs, `${label}.sourceRefs`);
  if (new Set(claim.sourceRefs).size !== claim.sourceRefs.length) {
    throw new ContractError(`${label}.sourceRefs must not contain duplicates`);
  }
}

function assertSemanticClaims(claims: readonly SemanticClaim[], label: string): void {
  if (!Array.isArray(claims)) throw new ContractError(`${label} must be an array`);
  claims.forEach((claim, index) => assertSemanticClaim(claim, `${label}[${index}]`));
}

export function validateInteractionIdentity(input: InteractionIdentity): void {
  assertScope(input.organId, 'organ');
  assertNonEmptyString(input.organId.value, 'interaction organId');
  assertNonEmptyString(input.interactionScopeId, 'interactionScopeId');
  assertNonEmptyString(input.interactionId, 'interactionId');
  assertPositiveSafeInteger(input.inputRevision, 'interaction inputRevision');
}

export function validateInteractionTurnIdentity(input: InteractionTurnIdentity): void {
  validateInteractionIdentity(input);
  assertNonEmptyString(input.turnId, 'interaction turnId');
}

export function validateInteractionHelperIdentity(input: InteractionHelperIdentity): void {
  validateInteractionIdentity(input);
  assertNonEmptyString(input.parentTurnId, 'helper parentTurnId');
  assertNonEmptyString(input.assignmentId, 'helper assignmentId');
  assertNonEmptyString(input.helperCallId, 'helper callId');
  assertPositiveSafeInteger(input.attempt, 'helper attempt');
}

export function validateInteractionHelperIncarnation(
  input: InteractionHelperIncarnation,
  assignment: InteractionHelperAssignment,
): void {
  validateInteractionHelperAssignment(assignment);
  validateInteractionHelperIdentity(input);
  if (!sameHelperIdentity(input, assignment)) {
    throw new ContractError('helper incarnation does not match assignment');
  }
  assertAgentRuntimeId(input.runtimeId);
  assertScope(input.operationId, 'operation');
  assertNonEmptyString(input.operationId.value, 'helper incarnation operationId');
  assertExecutionEpoch(input.executionEpoch);
  assertNonEmptyString(input.bindingId, 'helper incarnation bindingId');
  assertNonEmptyString(input.providerId, 'helper incarnation providerId');
  if (!HELPER_PROVIDER_PROTOCOLS.has(input.protocol)) {
    throw new ContractError('helper incarnation protocol is invalid');
  }
  assertNonEmptyString(input.modelRef, 'helper incarnation modelRef');
  assertNonEmptyString(input.capabilityDigest, 'helper incarnation capabilityDigest');
}

export function validateInteractionHelperAssignment(input: InteractionHelperAssignment): void {
  validateInteractionHelperIdentity(input);
  validateInteractionHelperAssignmentFields(input);
}

/**
 * The assignment-field rules without the runtime-allocated identity. Callers
 * that only hold model-supplied fields can reject an invalid assignment before
 * the runtime allocates an identity or a provider binding, using the same rules
 * as the durable assignment contract.
 */
export function validateInteractionHelperAssignmentFields(input: InteractionHelperAssignmentFields): void {
  assertNonEmptyString(input.objective, 'helper assignment objective');
  assertStringArray(input.targetRefs, 'helper assignment targetRefs');
  assertStringArray(input.expectedOutputRefs, 'helper assignment expectedOutputRefs');
  if (!Array.isArray(input.successCriteria) || input.successCriteria.length === 0) {
    throw new ContractError('helper assignment successCriteria must be a non-empty array');
  }
  assertStringArray(input.successCriteria, 'helper assignment successCriteria');
  assertStringArray(input.failureCriteria, 'helper assignment failureCriteria');
  assertStringArray(input.incompleteCriteria, 'helper assignment incompleteCriteria');
  assertStringArray(input.requiredCapabilities, 'helper assignment requiredCapabilities');
  if (input.mergeGate !== 'required' && input.mergeGate !== 'not-required') {
    throw new ContractError('helper assignment mergeGate is invalid');
  }
}

export function matchesInteractionHelperAssignment(
  result: InteractionHelperResult,
  assignment: InteractionHelperAssignment,
): boolean {
  return sameHelperIdentity(result, assignment);
}

export function validateInteractionHelperResult(
  input: InteractionHelperResult,
  assignment?: InteractionHelperAssignment,
): void {
  validateInteractionHelperIdentity(input);
  if (assignment !== undefined) {
    validateInteractionHelperAssignment(assignment);
    if (!matchesInteractionHelperAssignment(input, assignment)) {
      throw new ContractError('helper result does not match assignment');
    }
  }

  assertNonEmptyString(input.agentId, 'helper result agentId');
  if (!HELPER_RESULT_STATUSES.includes(input.status)) {
    throw new ContractError('helper result status is invalid');
  }
  assertNonEmptyString(input.summary, 'helper result summary');
  assertStringArray(input.producedArtifactRefs, 'helper result producedArtifactRefs');
  assertStringArray(input.outputRefs, 'helper result outputRefs');
  assertHelperEvidenceRefs(input.evidenceRefs, input.organId, 'helper result evidenceRefs');
  if (!HELPER_NEXT_ACTIONS.includes(input.nextAction)) {
    throw new ContractError('helper result nextAction is invalid');
  }
  if (input.nextAction === 'wait') assertNonEmptyString(input.conditionRef ?? '', 'helper result conditionRef');
  if (input.status === 'failed') assertNonEmptyString(input.failureRef ?? '', 'helper result failureRef');
  if (input.producedArtifactBodies !== undefined) {
    if (input.producedArtifactBodies.length !== input.producedArtifactRefs.length) {
      throw new ContractError('helper result artifact bodies must match artifact refs');
    }
    assertStringArray(input.producedArtifactBodies, 'helper result producedArtifactBodies');
  }

  if (assignment !== undefined && input.status === 'succeeded') {
    const expected = new Set(assignment.expectedOutputRefs);
    const delivered = new Set(input.outputRefs);
    if (expected.size !== delivered.size || ![...expected].every((ref) => delivered.has(ref))) {
      throw new ContractError('helper result outputs must match expected outputs');
    }
  }
}

export function validateInteractionSemanticCheckpoint(
  input: InteractionSemanticCheckpoint,
): void {
  validateInteractionTurnIdentity(input);
  assertValidTimestamp(input.committedAt, 'semantic checkpoint committedAt');
  assertSemanticClaims(input.claims, 'semantic checkpoint claims');
  assertSemanticClaims(input.constraints, 'semantic checkpoint constraints');
  assertHelperEvidenceRefs(input.evidenceRefs, input.organId, 'semantic checkpoint evidenceRefs');
  assertHelperEvidenceRefs(
    input.semanticAssetRefs,
    input.organId,
    'semantic checkpoint semanticAssetRefs',
  );
}

export function validateInteractionLatestTurn(input: InteractionLatestTurn): void {
  validateInteractionTurnIdentity(input);
  if (!Array.isArray(input.entries)) {
    throw new ContractError('latest interaction turn entries must be an array');
  }
  input.entries.forEach((entry, index) => {
    const label = `latest interaction turn entries[${index}]`;
    switch (entry.kind) {
      case 'user-input':
      case 'assistant-output':
        assertRawAsset(entry.content, input.organId, `${label}.content`);
        return;
      case 'clarification':
        assertRawAsset(entry.question, input.organId, `${label}.question`);
        if (entry.answer !== undefined) {
          assertRawAsset(entry.answer, input.organId, `${label}.answer`);
        }
        return;
      case 'helper-result':
        validateInteractionHelperResult(entry.result);
        if (!sameInteractionIdentity(entry.result, input) || entry.result.parentTurnId !== input.turnId) {
          throw new ContractError(`${label} helper result does not belong to the latest turn`);
        }
        assertRawAsset(entry.refinedResult, input.organId, `${label}.refinedResult`);
        return;
      default:
        throw new ContractError(`${label}.kind is invalid`);
    }
  });
}

export function validateInteractionHelperHandoffFact(
  input: InteractionHelperHandoffFact,
): void {
  switch (input.kind) {
    case 'dispatch-accepted':
      validateInteractionHelperAssignment(input.assignment);
      if (input.incarnation !== undefined) {
        validateInteractionHelperIncarnation(input.incarnation, input.assignment);
      }
      assertValidTimestamp(input.dispatchAcceptedAt, 'helper dispatch acceptedAt');
      assertHelperEvidenceRefs(
        input.evidenceRefs,
        input.assignment.organId,
        'helper dispatch accepted evidenceRefs',
      );
      return;
    case 'running':
      validateInteractionHelperIdentity(input.identity);
      assertValidTimestamp(input.startedAt, 'helper running startedAt');
      assertHelperEvidenceRefs(input.evidenceRefs, input.identity.organId, 'helper running evidenceRefs');
      return;
    case 'returned':
      validateInteractionHelperResult(input.result);
      assertValidTimestamp(input.returnedAt, 'helper returned returnedAt');
      assertHelperEvidenceRefs(input.evidenceRefs, input.result.organId, 'helper returned evidenceRefs');
      return;
    case 'owner-accepted':
      validateInteractionHelperResult(input.result);
      assertRawAsset(input.refinedResult, input.result.organId, 'helper owner accepted refinedResult');
      assertNonEmptyString(input.acceptedBy, 'helper owner acceptedBy');
      assertNonEmptyString(input.acceptanceRef, 'helper owner acceptanceRef');
      assertValidTimestamp(input.acceptedAt, 'helper owner acceptedAt');
      assertHelperEvidenceRefs(
        input.evidenceRefs,
        input.result.organId,
        'helper owner accepted evidenceRefs',
      );
      return;
    default:
      throw new ContractError('helper handoff fact kind is invalid');
  }
}
