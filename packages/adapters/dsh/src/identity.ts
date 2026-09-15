import {
  id,
  type OrganId,
  type ProviderBinding,
} from '../../../contracts/src/index.js';

/**
 * Provider-root scope used only for DSH transport-level probe/close evidence.
 *
 * It is not a HumanAgent execution identity. HumanAgent owns the organ and
 * operation identity supplied to execution; the adapter validates and
 * forwards those values unchanged.
 */
export function dshExecutionOrganId(binding: ProviderBinding): OrganId {
  return id('organ', `dsh-${binding.bindingId}`);
}
