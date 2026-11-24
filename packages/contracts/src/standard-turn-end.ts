import {
  assertEvidenceRef,
  assertProviderExecutionIdentity,
  assertSameScope,
  type ActiveTurnProviderExecutionIdentityRef,
  type EvidenceRef,
  type InteractionParentProviderExecutionIdentityRef,
  type ScopeRef,
} from './index.js';
import { validateAdmittedTurnIdentity, type AdmittedTurnIdentity } from './native-reasoning.js';
import { validateInspectionExecutionOutcome, type InspectionExecutionOutcome } from './i2-history.js';
import { validateTaskFlowBinding, type TaskFlowBinding } from './task-flow.js';
import { ContractError } from './errors.js';

/**
 * Advertised Provider tool id for the bound standard-turn end action. The model
 * reaches for this action to end one task turn; the action carries semantic
 * summary/delivery input only.
 */
export const STANDARD_TURN_END_TOOL_ID = 'humanagent.turn.end' as const;

/**
 * Advertised Provider tool id for the same bound standard-turn end action.
 * The Provider Responses codec can only declare and decode function names
 * matching [A-Za-z0-9_-], so the canonical dotted id is mirrored to this
 * transport-legal id on the model surface. Both ids denote exactly one action.
 */
export const STANDARD_TURN_END_WIRE_TOOL_ID = 'humanagent_turn_end' as const;

/**
 * True for either identity of the one standard-turn end action: the canonical
 * control-event id and the advertised Provider wire id.
 */
export function isStandardTurnEndToolId(toolId: string): boolean {
  return toolId === STANDARD_TURN_END_TOOL_ID || toolId === STANDARD_TURN_END_WIRE_TOOL_ID;
}

/**
 * The trusted identity of the actual accepted end call. The App captures it at
 * the end control edge from the real Provider request/call/scope; it is never
 * taken from model arguments or metadata. The Runtime binds the publication to
 * this exact call instead of selecting a call by tool name.
 */
export interface StandardTurnEndCallReference {
  readonly requestId: string;
  readonly callId: string;
  /**
   * The real Provider execution instance that carried the accepted call. It is
   * taken from the typed Provider execution of the end control edge and is the
   * minimum that separates two attempts that reuse a request/call id; the
   * Runtime proves it against the accepted fact's own envelope execution.
   */
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
}

export type StandardTurnEndOutcome = 'completed' | 'continue' | 'blocked' | 'input-required';
export type StandardTurnEndResultStatus = 'completed' | 'partial' | 'blocked';

/**
 * The model-owned semantic fact required to relay a question to the user. The
 * Runtime still generates the public request id, binds it to the task and the
 * exact execution, and owns the monotonic answer revision.
 */
export interface StandardTurnInputRequest {
  readonly question: string;
  readonly schemaRef: string;
  readonly reason: string;
  readonly impact: string;
  readonly options?: readonly string[];
  readonly expiresAt?: string;
}

/**
 * The canonical public result. `summary.result.text` is the only canonical
 * public result text field. `outcome` and `result.status` remain separate typed
 * decision fields and must not be derived from one another.
 */
export interface StandardTurnEndSummary {
  readonly goal: string;
  readonly actions: readonly string[];
  readonly result: {
    readonly status: StandardTurnEndResultStatus;
    readonly text: string;
  };
  readonly nextStep: string;
  /** Measured inspection judgment; present only when an inspection execution ran. */
  readonly inspectionOutcome?: InspectionExecutionOutcome;
}

/**
 * The canonical standard-turn-end payload accepted at the control boundary.
 *
 * `deliveryRefs` is optional and asset-only. A completed result may use a
 * non-empty `summary.result.text`, an asset reference, or both. It must not use
 * a second text field or an alias for `summary.result.text`.
 */
export interface StandardTurnEndPayload {
  readonly outcome: StandardTurnEndOutcome;
  readonly summary: StandardTurnEndSummary;
  /** Required only for `input-required`; forbidden on every other outcome. */
  readonly inputRequest?: StandardTurnInputRequest;
  readonly deliveryRefs?: readonly string[];
}

/** The model-visible semantic arguments are exactly the canonical payload. */
export type StandardTurnEndInput = StandardTurnEndPayload;

/**
 * The accepted control event the App adapter routes to the caller. It binds the
 * validated canonical payload to the trusted admitted-turn identity and to the
 * delivery evidence the owner resolved.
 *
 * It is a request, not a completion: it carries no terminal decision and no
 * lifecycle receipt. The caller still owns request drain, capture, `closeTurn`
 * and next-turn admission. This module never marks a Task complete.
 */
export interface StandardTurnEndCommand extends StandardTurnEndPayload {
  readonly kind: 'standard-turn-end';
  readonly identity: AdmittedTurnIdentity;
  /** The actual accepted end call captured from the trusted end control edge. */
  readonly acceptedEndCall?: StandardTurnEndCallReference;
  /** Optional resolved evidence for asset-only delivery refs. */
  readonly resolvedEvidenceRefs?: readonly EvidenceRef[];
}

/**
 * The explicit Brain end protocol is intentionally separate from the Task
 * standard-turn payload.  The explicit interpreter owns intake decisions;
 * this shape only carries the already classified decision to its end owner.
 */
export type ExplicitTurnEndDecision =
  | {
      readonly kind: 'answer';
      readonly normalizedInput: string;
      readonly knownFacts: readonly string[];
      readonly decisionRefs: readonly string[];
      readonly answer: string;
    }
  | {
      readonly kind: 'status-query';
      readonly normalizedInput: string;
      readonly knownFacts: readonly string[];
      readonly decisionRefs: readonly string[];
      readonly answer: string;
      readonly matchedTaskId?: string;
    }
  | {
      readonly kind: 'clarification';
      readonly normalizedInput: string;
      readonly knownFacts: readonly string[];
      readonly decisionRefs: readonly string[];
      readonly question: string;
      readonly options?: readonly string[];
    }
  | {
      readonly kind: 'requirement';
      readonly normalizedInput: string;
      readonly knownFacts: readonly string[];
      readonly decisionRefs: readonly string[];
      readonly proposal: ExplicitRequirementProposal;
      readonly matchedTaskId?: string;
      readonly taskFlow?: TaskFlowBinding;
    };

export interface ExplicitRequirementProposal {
  readonly revision: number;
  readonly intent: 'append' | 'change' | 'create';
  readonly title: string;
  readonly objective: string;
  readonly deliverable: string;
  readonly deliveryConditions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly blockingGaps: readonly string[];
}

export interface ExplicitTurnEndCapsule {
  readonly summary: string;
  readonly goal: string;
  readonly process: readonly string[];
  readonly findings: readonly string[];
  readonly nextStep: string;
  readonly detailRefs?: readonly string[];
}

/** First-layer checkpoint index submitted with the end call. */
export interface ExplicitTurnEndCheckpointIndex {
  readonly action: string;
  readonly result: string;
}

/** Input carried by the explicit Brain end tool. */
export interface ExplicitTurnEndInput {
  readonly kind: 'simple' | 'complex';
  readonly decision: ExplicitTurnEndDecision;
  readonly checkpointRecord: { readonly index: ExplicitTurnEndCheckpointIndex };
  readonly capsule?: ExplicitTurnEndCapsule;
}

export interface ExplicitTurnEndAcceptedResult {
  readonly kind: 'accepted';
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly turnId: string;
  readonly decision: ExplicitTurnEndDecision;
  /** Absent from receipts persisted before leaf indexing. New end calls require it. */
  readonly checkpointRecord?: ExplicitTurnEndInput['checkpointRecord'];
  readonly capsule?: ExplicitTurnEndCapsule;
  readonly acceptedEndCall?: ExplicitTurnEndCallReference;
}

export interface ExplicitTurnEndCallReference {
  readonly requestId: string;
  readonly callId: string;
  readonly execution: InteractionParentProviderExecutionIdentityRef;
}

export interface ExplicitTurnEndValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ExplicitTurnPartialResult {
  readonly kind: 'partial';
  readonly partialRef: string;
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly turnId: string;
  readonly failedAttempt: number;
  readonly maxAttempts: number;
  readonly errors: readonly ExplicitTurnEndValidationIssue[];
  readonly userMessage: string;
  readonly recoverable: true;
  readonly resumePartialRef?: string;
  readonly lastCheckpointRef?: string;
}

export type ExplicitTurnEndResult = ExplicitTurnEndAcceptedResult | ExplicitTurnPartialResult;

function validateExplicitDecision(decision: unknown): asserts decision is ExplicitTurnEndDecision {
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) {
    throw new ContractError('explicit-turn-end.decision');
  }
  const value = decision as Record<string, unknown>;
  if (value.kind !== 'answer' && value.kind !== 'status-query'
    && value.kind !== 'clarification' && value.kind !== 'requirement') {
    throw new ContractError('explicit-turn-end.decision.kind');
  }
  requireNonEmptyString(value.normalizedInput, 'explicit-turn-end.decision.normalized-input');
  requireStringArray(value.knownFacts, 'explicit-turn-end.decision.known-facts');
  requireStringArray(value.decisionRefs, 'explicit-turn-end.decision.refs');
  if (value.kind === 'answer' || value.kind === 'status-query') {
    requireNonEmptyString(value.answer, 'explicit-turn-end.decision.answer');
  } else if (value.kind === 'clarification') {
    requireNonEmptyString(value.question, 'explicit-turn-end.decision.question');
    if (value.options !== undefined) requireStringArray(value.options, 'explicit-turn-end.decision.options');
  } else {
    const proposalValue = value.proposal;
    if (typeof proposalValue !== 'object' || proposalValue === null || Array.isArray(proposalValue)) {
      throw new ContractError('explicit-turn-end.decision.proposal');
    }
    const proposal = proposalValue as Record<string, unknown>;
    const revision = proposal.revision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      throw new ContractError('explicit-turn-end.decision.proposal.revision');
    }
    if (proposal.intent !== 'append' && proposal.intent !== 'change' && proposal.intent !== 'create') {
      throw new ContractError('explicit-turn-end.decision.proposal.intent');
    }
    requireNonEmptyString(proposal.title, 'explicit-turn-end.decision.proposal.title');
    requireNonEmptyString(proposal.objective, 'explicit-turn-end.decision.proposal.objective');
    requireNonEmptyString(proposal.deliverable, 'explicit-turn-end.decision.proposal.deliverable');
    requireStringArray(proposal.deliveryConditions, 'explicit-turn-end.decision.proposal.delivery-conditions');
    requireStringArray(proposal.evidenceRefs, 'explicit-turn-end.decision.proposal.evidence-refs');
    requireStringArray(proposal.blockingGaps, 'explicit-turn-end.decision.proposal.blocking-gaps');
    if (value.taskFlow !== undefined) {
      if (typeof value.taskFlow !== 'object' || value.taskFlow === null || Array.isArray(value.taskFlow)) {
        throw new ContractError('explicit-turn-end.decision.task-flow');
      }
      validateTaskFlowBinding(value.taskFlow as TaskFlowBinding);
    }
  }
}

export function validateExplicitTurnEndInput(input: ExplicitTurnEndInput): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ContractError('explicit-turn-end.input');
  }
  if (input.kind !== 'simple' && input.kind !== 'complex') {
    throw new ContractError('explicit-turn-end.input.kind');
  }
  validateExplicitDecision(input.decision);
  if ((input.kind === 'complex') !== (input.decision.kind === 'requirement')) {
    throw new ContractError('explicit-turn-end.input-kind-decision');
  }
  const decision = input.decision as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(decision, 'matchedTaskId')) {
    if (input.decision.kind !== 'status-query' && input.decision.kind !== 'requirement') {
      throw new ContractError('explicit-turn-end.decision.matched-task-id-not-applicable');
    }
    requireNonEmptyString(decision.matchedTaskId, 'explicit-turn-end.decision.matched-task-id');
    if (input.decision.kind === 'requirement' && input.decision.proposal.intent === 'create') {
      throw new ContractError('explicit-turn-end.decision.matched-task-id-create');
    }
  }
  validateEndCheckpointIndex(input.checkpointRecord);
  validateEndCapsule(input.kind, input.capsule);
}

function validateEndCheckpointIndex(checkpointRecord: ExplicitTurnEndInput['checkpointRecord']): void {
  if (typeof checkpointRecord !== 'object' || checkpointRecord === null || Array.isArray(checkpointRecord)) {
    throw new ContractError('explicit-turn-end.checkpoint-record');
  }
  const index = checkpointRecord.index;
  if (typeof index !== 'object' || index === null || Array.isArray(index)) {
    throw new ContractError('explicit-turn-end.checkpoint.index');
  }
  requireNonEmptyString(index.action, 'explicit-turn-end.checkpoint.index.action');
  requireNonEmptyString(index.result, 'explicit-turn-end.checkpoint.index.result');
}

function validateEndCapsule(kind: ExplicitTurnEndInput['kind'], capsule: ExplicitTurnEndInput['capsule']): void {
  if (kind === 'complex') {
    if (typeof capsule !== 'object' || capsule === null || Array.isArray(capsule)) {
      throw new ContractError('explicit-turn-end.capsule');
    }
    requireNonEmptyString(capsule.summary, 'explicit-turn-end.capsule.summary');
    requireNonEmptyString(capsule.goal, 'explicit-turn-end.capsule.goal');
    requireStringArray(capsule.process, 'explicit-turn-end.capsule.process');
    requireStringArray(capsule.findings, 'explicit-turn-end.capsule.findings');
    requireNonEmptyString(capsule.nextStep, 'explicit-turn-end.capsule.next-step');
    if (capsule.detailRefs !== undefined) requireStringArray(capsule.detailRefs, 'explicit-turn-end.capsule.detail-refs');
  } else if (capsule !== undefined) {
    throw new ContractError('explicit-turn-end.simple-capsule');
  }
}

export function validateExplicitTurnPartialResult(result: ExplicitTurnPartialResult): void {
  if (typeof result !== 'object' || result === null || Array.isArray(result) || result.kind !== 'partial') {
    throw new ContractError('explicit-turn-end.partial');
  }
  requireNonEmptyString(result.partialRef, 'explicit-turn-end.partial-ref');
  requireNonEmptyString(result.interactionId, 'explicit-turn-end.interaction-id');
  if (!Number.isInteger(result.inputRevision) || result.inputRevision < 0) {
    throw new ContractError('explicit-turn-end.input-revision');
  }
  requireNonEmptyString(result.turnId, 'explicit-turn-end.turn-id');
  if (!Number.isInteger(result.failedAttempt) || result.failedAttempt < 1) {
    throw new ContractError('explicit-turn-end.failed-attempt');
  }
  if (!Number.isInteger(result.maxAttempts) || result.maxAttempts < result.failedAttempt) {
    throw new ContractError('explicit-turn-end.max-attempts');
  }
  if (result.recoverable !== true) throw new ContractError('explicit-turn-end.recoverable');
  if (!Array.isArray(result.errors)) throw new ContractError('explicit-turn-end.errors');
  for (const issue of result.errors) {
    if (typeof issue !== 'object' || issue === null || Array.isArray(issue)) {
      throw new ContractError('explicit-turn-end.error');
    }
    requireNonEmptyString(issue.path, 'explicit-turn-end.error.path');
    requireNonEmptyString(issue.message, 'explicit-turn-end.error.message');
  }
  requireNonEmptyString(result.userMessage, 'explicit-turn-end.user-message');
  if (result.resumePartialRef !== undefined) requireNonEmptyString(result.resumePartialRef, 'explicit-turn-end.resume-partial-ref');
  if (result.lastCheckpointRef !== undefined) requireNonEmptyString(result.lastCheckpointRef, 'explicit-turn-end.last-checkpoint-ref');
}

export function validateExplicitTurnEndAcceptedResult(result: ExplicitTurnEndAcceptedResult): void {
  if (typeof result !== 'object' || result === null || Array.isArray(result) || result.kind !== 'accepted') {
    throw new ContractError('explicit-turn-end.accepted');
  }
  requireNonEmptyString(result.interactionId, 'explicit-turn-end.interaction-id');
  if (!Number.isInteger(result.inputRevision) || result.inputRevision < 0) {
    throw new ContractError('explicit-turn-end.input-revision');
  }
  requireNonEmptyString(result.turnId, 'explicit-turn-end.turn-id');
  validateExplicitDecision(result.decision);
  if (result.checkpointRecord !== undefined) validateEndCheckpointIndex(result.checkpointRecord);
  validateEndCapsule(result.decision.kind === 'requirement' ? 'complex' : 'simple', result.capsule);
  if (result.acceptedEndCall !== undefined) {
    requireNonEmptyString(result.acceptedEndCall.requestId, 'explicit-turn-end.call.request-id');
    requireNonEmptyString(result.acceptedEndCall.callId, 'explicit-turn-end.call.call-id');
    assertProviderExecutionIdentity(result.acceptedEndCall.execution);
    if (result.acceptedEndCall.execution.interactionTurn.turnId !== result.turnId
      || result.acceptedEndCall.execution.interactionTurn.interactionId !== result.interactionId
      || result.acceptedEndCall.execution.interactionTurn.inputRevision !== result.inputRevision) {
      throw new ContractError('explicit-turn-end.call.turn-mismatch');
    }
  }
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function requireStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new ContractError(`${label} must be an array`);
  const seen = new Set<string>();
  for (const entry of value) {
    requireNonEmptyString(entry, `${label} entry`);
    if (seen.has(entry)) throw new ContractError(`${label} must not contain duplicates`);
    seen.add(entry);
  }
}

function validateOutcome(outcome: unknown): asserts outcome is StandardTurnEndOutcome {
  if (outcome !== 'completed' && outcome !== 'continue' && outcome !== 'blocked' && outcome !== 'input-required') {
    throw new ContractError('standard-turn-end.outcome');
  }
}

function validateResultStatus(status: unknown): asserts status is StandardTurnEndResultStatus {
  if (status !== 'completed' && status !== 'partial' && status !== 'blocked') {
    throw new ContractError('standard-turn-end.result-status');
  }
}

/**
 * Validates the canonical payload. The retired top-level field is rejected by
 * own property, so a runtime caller cannot silently revive it through an
 * untyped or legacy JSON payload.
 */
export function validateStandardTurnEndPayload(input: StandardTurnEndPayload): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ContractError('standard-turn-end.payload');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'deliveryText')) {
    throw new ContractError('standard-turn-end.retired-delivery-text');
  }
  validateOutcome(input.outcome);
  const summary = input.summary;
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    throw new ContractError('standard-turn-end.summary');
  }
  requireNonEmptyString(summary.goal, 'standard-turn-end.summary.goal');
  requireStringArray(summary.actions, 'standard-turn-end.summary.actions');
  requireNonEmptyString(summary.nextStep, 'standard-turn-end.summary.nextStep');
  if (typeof summary.result !== 'object' || summary.result === null || Array.isArray(summary.result)) {
    throw new ContractError('standard-turn-end.summary.result');
  }
  validateResultStatus(summary.result.status);
  if (typeof summary.result.text !== 'string') {
    throw new ContractError('standard-turn-end.summary.result.text');
  }
  const hasInputRequest = Object.prototype.hasOwnProperty.call(input, 'inputRequest');
  const inputRequest = input.inputRequest;
  if (input.outcome === 'input-required') {
    if (typeof inputRequest !== 'object' || inputRequest === null || Array.isArray(inputRequest)) {
      throw new ContractError('standard-turn-end.input-request');
    }
    requireNonEmptyString(inputRequest.question, 'standard-turn-end.input-request.question');
    requireNonEmptyString(inputRequest.schemaRef, 'standard-turn-end.input-request.schema-ref');
    requireNonEmptyString(inputRequest.reason, 'standard-turn-end.input-request.reason');
    requireNonEmptyString(inputRequest.impact, 'standard-turn-end.input-request.impact');
    if (inputRequest.options !== undefined) {
      requireStringArray(inputRequest.options, 'standard-turn-end.input-request.options');
      if (inputRequest.options.length < 1) {
        throw new ContractError('standard-turn-end.input-request-options-empty');
      }
    }
    if (inputRequest.expiresAt !== undefined) {
      requireNonEmptyString(inputRequest.expiresAt, 'standard-turn-end.input-request.expires-at');
    }
  } else if (hasInputRequest) {
    throw new ContractError('standard-turn-end.input-request-not-allowed');
  }
  if (summary.inspectionOutcome !== undefined) validateInspectionExecutionOutcome(summary.inspectionOutcome);
  const deliveryRefs = input.deliveryRefs;
  if (deliveryRefs !== undefined) requireStringArray(deliveryRefs, 'standard-turn-end.delivery-refs');
  const hasText = summary.result.text.trim().length > 0;
  const hasAsset = deliveryRefs !== undefined && deliveryRefs.length > 0;
  if (input.outcome === 'completed' && summary.result.status === 'completed' && !hasText && !hasAsset) {
    throw new ContractError('standard-turn-end.missing-public-deliverable');
  }
}

/** True only when the canonical payload may enter the public publication path. */
export function isStandardTurnEndPublicationEligible(input: StandardTurnEndPayload): boolean {
  validateStandardTurnEndPayload(input);
  return input.outcome === 'completed'
    && input.summary.result.status === 'completed'
    && (input.summary.result.text.trim().length > 0 || (input.deliveryRefs?.length ?? 0) > 0);
}

/** Rejects a payload that must not be published as a completed public result. */
export function assertStandardTurnEndPublicationEligible(input: StandardTurnEndPayload): void {
  validateStandardTurnEndPayload(input);
  if (!isStandardTurnEndPublicationEligible(input)) {
    throw new ContractError('standard-turn-end.non-completed-publication');
  }
}

/**
 * The one public result text of a standard-turn end: `summary.result.text`,
 * only when the model declared both `outcome` and `result.status` completed
 * and the text is non-empty. Anything else publishes no text.
 */
export function standardTurnEndPublicText(input: StandardTurnEndPayload): string | undefined {
  validateStandardTurnEndPayload(input);
  return input.outcome === 'completed'
    && input.summary.result.status === 'completed'
    && input.summary.result.text.trim().length > 0
    ? input.summary.result.text
    : undefined;
}

/**
 * Validates the accepted command. The identity must be a real admitted-turn
 * identity, the payload must be canonical, and any explicitly resolved delivery
 * evidence must be well formed and bound to the admitted-turn scope.
 */
export function validateStandardTurnEndCommand(command: StandardTurnEndCommand): void {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw new ContractError('standard turn end command must be an object');
  }
  if (command.kind !== 'standard-turn-end') {
    throw new ContractError('standard turn end command kind is invalid');
  }
  validateAdmittedTurnIdentity(command.identity);
  validateStandardTurnEndPayload(command);
  const resolved = command.resolvedEvidenceRefs;
  if (resolved === undefined) return;
  if (!Array.isArray(resolved)) {
    throw new ContractError('standard-turn-end.resolved-evidence-refs');
  }
  for (const reference of resolved) {
    assertEvidenceRef(reference);
    assertSameScope(command.identity.scopeRef, reference.scope);
  }
}
