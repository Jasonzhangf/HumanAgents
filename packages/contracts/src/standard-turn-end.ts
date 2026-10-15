import { assertEvidenceRef, assertSameScope, type ActiveTurnProviderExecutionIdentityRef,
  type EvidenceRef, type ScopeRef } from './index.js';
import { validateAdmittedTurnIdentity, type AdmittedTurnIdentity } from './native-reasoning.js';
import {
  assertTurnSummaryContextIdentity,
  isAllowlistedTurnSummaryEvidence,
  turnSummaryEvidenceAllowSet,
  validateTurnCloseSummary,
  type TurnCloseSummary,
  type TurnSummaryEvidenceContext,
} from './turn-closure.js';
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
 * taken from model arguments or metadata. The Runtime binds the text delivery
 * source to this exact call instead of selecting a call by tool name.
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

/**
 * The model-visible semantic arguments of the standard-turn end action.
 *
 * It reuses the existing four-part `TurnCloseSummary` and the delivery
 * references the model claims. It never carries authority, turn/request
 * identity, grants, epochs, checkpoint or alignment receipts, or a completion
 * flag: those come from the actual typed Provider request and the admitted turn.
 */
export interface StandardTurnEndInput {
  readonly summary: TurnCloseSummary;
  /**
   * The exact text body this turn delivers. It is a first-class material of the
   * delivery, independent of the four summary parts: it is never derived from
   * `summary.result.text` or from the last assistant message. A text-only
   * delivery leaves `deliveryRefs` empty; at least one of the two must carry
   * material.
   */
  readonly deliveryText?: string;
  readonly deliveryRefs: readonly string[];
}

/**
 * The accepted control event the App adapter routes to the caller. It binds the
 * validated semantic input to the trusted admitted-turn identity and to the
 * delivery evidence the owner resolved.
 *
 * It is a request, not a completion: it carries no terminal decision and no
 * lifecycle receipt. The caller still owns request drain, capture, `closeTurn`
 * and next-turn admission. This module never marks a Task complete.
 */
export interface StandardTurnEndCommand {
  readonly kind: 'standard-turn-end';
  readonly identity: AdmittedTurnIdentity;
  readonly summary: TurnCloseSummary;
  /** The exact delivery text accepted from the model arguments, if any. */
  readonly deliveryText?: string;
  /** The actual accepted end call captured from the trusted end control edge. */
  readonly acceptedEndCall?: StandardTurnEndCallReference;
  readonly deliveryRefs: readonly string[];
  readonly resolvedEvidenceRefs: readonly EvidenceRef[];
}

/**
 * Validates the model-supplied semantic input against the trusted admitted-turn
 * scope. The four-part summary and its evidence must be bound to that scope, and
 * the delivery must carry material: a non-empty delivery text, or at least one
 * unique, non-empty delivery reference. A malformed or foreign input is
 * rejected; nothing is silently repaired.
 */
export function validateStandardTurnEndInput(
  input: StandardTurnEndInput,
  scope: AdmittedTurnIdentity['scopeRef'],
  context?: TurnSummaryEvidenceContext,
): void {
  if (typeof input !== 'object' || input === null) {
    throw new ContractError('standard turn end input must be an object');
  }
  validateTurnCloseSummary(input.summary, scope, context);
  const hasDeliveryText = input.deliveryText !== undefined;
  if (hasDeliveryText && (typeof input.deliveryText !== 'string' || !input.deliveryText.trim())) {
    throw new ContractError('standard turn end deliveryText must be a non-empty string');
  }
  if (!Array.isArray(input.deliveryRefs)) {
    throw new ContractError('standard turn end delivery references must be an array');
  }
  if (!hasDeliveryText && input.deliveryRefs.length === 0) {
    throw new ContractError('standard turn end requires delivery text or at least one delivery reference');
  }
  const seen = new Set<string>();
  for (const reference of input.deliveryRefs) {
    if (typeof reference !== 'string' || !reference.trim()) {
      throw new ContractError('standard turn end delivery reference must be a non-empty string');
    }
    if (seen.has(reference)) throw new ContractError('standard turn end delivery references must be unique');
    seen.add(reference);
  }
}

/**
 * Validates the accepted command. The identity must be a real admitted-turn
 * identity, the semantic input must pass the same scope-bound validation, and
 * every resolved delivery evidence reference must be well formed and bound to
 * the admitted-turn scope. Resolved evidence is required only when the delivery
 * carries references; a text-only delivery resolves no external evidence.
 */
export function validateStandardTurnEndCommand(command: StandardTurnEndCommand, context?: TurnSummaryEvidenceContext): void {
  if (typeof command !== 'object' || command === null) {
    throw new ContractError('standard turn end command must be an object');
  }
  if (command.kind !== 'standard-turn-end') {
    throw new ContractError('standard turn end command kind is invalid');
  }
  validateAdmittedTurnIdentity(command.identity);
  if (context !== undefined) assertTurnSummaryContextIdentity(context, command.identity);
  validateStandardTurnEndInput(
    { summary: command.summary, deliveryText: command.deliveryText, deliveryRefs: command.deliveryRefs },
    command.identity.scopeRef,
    context,
  );
  if (!Array.isArray(command.resolvedEvidenceRefs)) {
    throw new ContractError('standard turn end command resolved delivery evidence must be an array');
  }
  if (command.deliveryRefs.length > 0 && command.resolvedEvidenceRefs.length === 0) {
    throw new ContractError('standard turn end command requires resolved delivery evidence for its references');
  }
  const allow = context === undefined ? undefined : turnSummaryEvidenceAllowSet(context, command.identity.scopeRef);
  for (const reference of command.resolvedEvidenceRefs) {
    assertEvidenceRef(reference);
    try {
      assertSameScope(command.identity.scopeRef, reference.scope);
    } catch (error) {
      if (isAllowlistedTurnSummaryEvidence(allow, reference)) continue;
      throw error;
    }
  }
}
