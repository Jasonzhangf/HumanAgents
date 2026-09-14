import type { ProviderBinding, ProviderCapabilities } from '../../../contracts/src/index.js';
import { validateProviderBinding } from '../../../contracts/src/index.js';
import { DshAdapterError, dshSeamError } from './errors.js';
import { assertDshCapabilitiesForBinding, classifyDshProfile, type DshReadinessInputs } from './probe.js';
import { assertDshLockDescriptor } from './types.js';

export type DshCapabilitiesInputs = DshReadinessInputs;

function missingCapability(error: DshAdapterError): never {
  throw error;
}

export async function capabilitiesDsh(inputs: DshCapabilitiesInputs): Promise<ProviderCapabilities> {
  assertDshLockDescriptor(inputs.lock);
  validateProviderBinding(inputs.binding);
  const status = classifyDshProfile(inputs.profile);
  if (status.kind === 'missing-profile') {
    return missingCapability(new DshAdapterError('dependency-missing', 'DSH profile is missing; capabilities unavailable', inputs.ownerId));
  }
  if (status.kind === 'missing-bundle') {
    return missingCapability(new DshAdapterError('capability-unavailable', 'Approved HumanAgent DSH plugin/bundle is missing; capabilities unavailable', inputs.ownerId));
  }
  if (status.kind === 'invalid') {
    return missingCapability(new DshAdapterError('dependency-missing', `DSH profile is invalid: ${status.error.message}`, inputs.ownerId));
  }
  if (!inputs.transport) {
    return missingCapability(new DshAdapterError('dependency-missing', 'DSH transport is not available; capabilities unavailable', inputs.ownerId));
  }

  let capabilities: ProviderCapabilities;
  try {
    capabilities = await inputs.transport.capabilities({
      binding: inputs.binding,
      lock: inputs.lock,
      profile: status.profile,
    });
  } catch (error) {
    throw dshSeamError('transport-failure', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
  }
  assertDshCapabilitiesForBinding(capabilities, inputs.binding, inputs.ownerId);
  const missing = inputs.requiredCapabilities.filter((capability) => !capabilities.capabilities.includes(capability));
  if (missing.length > 0) {
    return missingCapability(new DshAdapterError('capability-unavailable', `DSH provider is missing required capability: ${missing.join(', ')}`, inputs.ownerId));
  }
  return capabilities;
}
