import {
  assertEvidenceRef,
  assertSameScope,
  type ActiveTurnProviderExecutionIdentityRef,
  type EvidenceRef,
  type ScopeRef,
} from './index.js';
import { validateAdmittedTurnIdentity, type AdmittedTurnIdentity } from './native-reasoning.js';
import { validateInspectionExecutionOutcome, type InspectionExecutionOutcome } from './i2-history.js';
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

export type StandardTurnEndOutcome = 'completed' | 'continue' | 'blocked';
export type StandardTurnEndResultStatus = 'completed' | 'partial' | 'blocked';

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
  if (outcome !== 'completed' && outcome !== 'continue' && outcome !== 'blocked') {
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
