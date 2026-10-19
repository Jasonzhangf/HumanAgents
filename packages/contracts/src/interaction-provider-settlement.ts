import {
  ContractError,
  validateProviderSettlement,
  type InteractionParentProviderExecutionIdentityRef,
  type ProviderRequestIdentityRef,
  type ProviderSettlement,
} from './index.js';

/**
 * A complete provider settlement associated with one logical interaction
 * revision and its physical terminal request. The settlement remains the
 * original typed value; later Journal code owns request membership and epoch
 * association.
 */
export interface InteractionProviderSettlementReceipt {
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly request: ProviderRequestIdentityRef;
  readonly settlement: ProviderSettlement<InteractionParentProviderExecutionIdentityRef>;
}

export function validateInteractionProviderSettlementReceipt(
  input: InteractionProviderSettlementReceipt,
): void {
  validateProviderSettlement(input.settlement);
  if (input.interactionId !== input.settlement.interactionTurn.interactionId) {
    throw new ContractError('interaction provider settlement interaction id mismatch');
  }
  if (!Number.isSafeInteger(input.inputRevision) || input.inputRevision < 1) {
    throw new ContractError('interaction provider settlement inputRevision must be a positive safe integer');
  }
  if (input.inputRevision !== input.settlement.interactionTurn.inputRevision) {
    throw new ContractError('interaction provider settlement inputRevision mismatch');
  }
  const request = input.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ContractError('interaction provider settlement request must be an object');
  }
  if (typeof request.turnId !== 'string' || !request.turnId.trim()) {
    throw new ContractError('interaction provider settlement request turnId must be a non-empty reference');
  }
  if (typeof request.requestId !== 'string' || !request.requestId.trim()) {
    throw new ContractError('interaction provider settlement request requestId must be a non-empty reference');
  }
  if (request.parentRequestId !== undefined
    && (typeof request.parentRequestId !== 'string' || !request.parentRequestId.trim())) {
    throw new ContractError('interaction provider settlement request parentRequestId must be a non-empty reference');
  }
  if (request.parentRequestId === request.requestId) {
    throw new ContractError('interaction provider settlement request parentRequestId cannot equal requestId');
  }
}
