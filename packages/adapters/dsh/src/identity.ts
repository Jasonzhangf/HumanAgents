import {
  id,
  type OperationId,
  type OrganId,
  type ProviderBinding,
} from '../../../contracts/src/index.js';

/**
 * Single owner for the HumanAgent-facing identity the DSH adapter exposes.
 *
 * HumanAgent owns the organ and operation identity; DSH only supplies the
 * execution backend. The organ id is derived from the provider binding so the
 * driver, the real transport, and the app composition all agree on the same
 * scope, which the bridge enforces when it fences an execution.
 */
export function dshExecutionOrganId(binding: ProviderBinding): OrganId {
  return id('organ', `dsh-${binding.bindingId}`);
}

/**
 * Deterministic operation id for one runtime epoch. `AgentStartRequest` carries
 * no operation id, so the driver mints it here and the app must use this same
 * function when it builds stop control; otherwise the stop identity will not
 * match the active execution.
 */
export function dshOperationIdFor(input: {
  readonly runtimeId: string;
  readonly executionEpoch: number;
}): OperationId {
  return id('operation', `runtime-${input.runtimeId}-epoch-${input.executionEpoch}`);
}
