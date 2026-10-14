import { assertEvidenceRef, assertSameScope, type EvidenceRef } from './index.js';
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
 * The model-visible semantic arguments of the standard-turn end action.
 *
 * It reuses the existing four-part `TurnCloseSummary` and the delivery
 * references the model claims. It never carries authority, turn/request
 * identity, grants, epochs, checkpoint or alignment receipts, or a completion
 * flag: those come from the actual typed Provider request and the admitted turn.
 */
export interface StandardTurnEndInput {
  readonly summary: TurnCloseSummary;
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
  readonly deliveryRefs: readonly string[];
  readonly resolvedEvidenceRefs: readonly EvidenceRef[];
}

/**
 * Validates the model-supplied semantic input against the trusted admitted-turn
 * scope. The four-part summary and its evidence must be bound to that scope, and
 * at least one unique, non-empty delivery reference is required. A malformed or
 * foreign input is rejected; nothing is silently repaired.
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
  if (!Array.isArray(input.deliveryRefs) || input.deliveryRefs.length === 0) {
    throw new ContractError('standard turn end requires at least one delivery reference');
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
 * the admitted-turn scope.
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
    { summary: command.summary, deliveryRefs: command.deliveryRefs },
    command.identity.scopeRef,
    context,
  );
  if (!Array.isArray(command.resolvedEvidenceRefs) || command.resolvedEvidenceRefs.length === 0) {
    throw new ContractError('standard turn end command requires resolved delivery evidence');
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
