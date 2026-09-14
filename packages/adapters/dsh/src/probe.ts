import type {
  EvidenceRef,
  ProviderBinding,
  ProviderError,
  ProviderReadiness,
  ScopeRef,
} from '../../../contracts/src/index.js';
import {
  assertEvidenceRef,
  assertNotExpired,
  assertProviderBindingMatch,
  assertProviderReadinessBinding,
  assertSameScope,
  validateProviderBinding,
  validateProviderCapabilities,
  validateProviderReadiness,
} from '../../../contracts/src/index.js';
import type { ProviderCapabilities } from '../../../contracts/src/index.js';
import { DshAdapterError, dshSeamError } from './errors.js';
import type { DshTransport } from './transport.js';
import {
  assertDshLockDescriptor,
  assertDshProfileDescriptor,
  type DshLockDescriptor,
  type DshProfileDescriptor,
} from './types.js';

export interface DshReadinessInputs {
  readonly binding: ProviderBinding;
  readonly lock: DshLockDescriptor;
  readonly profile?: DshProfileDescriptor;
  readonly transport: DshTransport | null;
  readonly requiredCapabilities: readonly string[];
  readonly ownerId: string;
  readonly probeEvidence?: DshProbeEvidence | null;
}

export interface DshProbeEvidence {
  readonly scope: ScopeRef;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type DshProfileStatus =
  | { readonly kind: 'missing-profile' }
  | { readonly kind: 'missing-bundle' }
  | { readonly kind: 'invalid'; readonly error: DshAdapterError }
  | { readonly kind: 'ready'; readonly profile: DshProfileDescriptor };

export function classifyDshProfile(profile: DshProfileDescriptor | undefined): DshProfileStatus {
  if (!profile) return { kind: 'missing-profile' };
  if (!profile.plugin || !profile.plugin.bundleRef.trim() || !profile.plugin.digest.trim() || !profile.plugin.entry.trim()) {
    return { kind: 'missing-bundle' };
  }
  try {
    assertDshProfileDescriptor(profile);
    return { kind: 'ready', profile };
  } catch (error) {
    if (error instanceof DshAdapterError) return { kind: 'invalid', error };
    throw error;
  }
}

function probeValidity(): { readonly checkedAt: string; readonly expiresAt: string } {
  const now = Date.now();
  return {
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
}

function assertDshProbeEvidence(inputs: DshReadinessInputs): DshProbeEvidence | null {
  const evidence = inputs.probeEvidence ?? null;
  if (!evidence) return null;
  try {
    if (evidence.evidenceRefs.length === 0) {
      throw new DshAdapterError('dependency-missing', 'DSH probe evidence was provided without evidence refs', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
        phase: 'probe',
        binding: inputs.binding,
      });
    }
    for (const ref of evidence.evidenceRefs) assertEvidenceRef(ref);
    assertSameScope(evidence.scope, ...evidence.evidenceRefs.map((ref) => ref.scope));
    return evidence;
  } catch (error) {
    throw dshSeamError('configuration-invalid', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
  }
}

export function assertDshCapabilitiesForBinding(capabilities: ProviderCapabilities, binding: ProviderBinding, ownerId: string): void {
  try {
    validateProviderCapabilities(capabilities);
  } catch (error) {
    throw dshSeamError('transport-failure', error, { phase: 'probe', ownerId, binding });
  }
  try {
    assertProviderBindingMatch(binding, {
      bindingId: capabilities.bindingId,
      providerId: capabilities.providerId,
      protocol: capabilities.protocol,
    });
    if (capabilities.digest !== binding.capabilityDigest) {
      throw new DshAdapterError('identity-mismatch', 'DSH capability digest mismatch', ownerId, { kind: 'recover', ref: ownerId }, {
        phase: 'probe',
        binding,
      });
    }
  } catch (error) {
    throw dshSeamError('identity-mismatch', error, { phase: 'probe', ownerId, binding });
  }
  try {
    assertNotExpired(capabilities.expiresAt);
  } catch (error) {
    throw dshSeamError('configuration-invalid', error, { phase: 'probe', ownerId, binding });
  }
}

function failureFor(state: 'dependency-missing' | 'capability-unavailable', message: string, inputs: DshReadinessInputs): ProviderError {
  const evidence = assertDshProbeEvidence(inputs);
  if (!evidence) {
    throw new DshAdapterError('dependency-missing', `DSH probe evidence is missing: ${message}`, inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
      phase: 'probe',
      binding: inputs.binding,
    });
  }
  return {
    errorId: `dsh.${state}.probe`,
    code: `dsh.${state}`,
    category: state === 'dependency-missing' ? 'configuration' : 'capability',
    phase: 'probe',
    message,
    ownerId: inputs.ownerId,
    retryable: 'manual',
    attention: 'foreground',
    evidenceRefs: evidence.evidenceRefs,
    nextAction: { kind: 'recover', ref: inputs.ownerId },
  };
}

export function readinessForMissing(
  state: 'dependency-missing' | 'capability-unavailable',
  message: string,
  inputs: DshReadinessInputs,
): ProviderReadiness {
  validateProviderBinding(inputs.binding);
  const failure = failureFor(state, message, inputs);
  const validity = probeValidity();
  return {
    bindingId: inputs.binding.bindingId,
    providerId: inputs.binding.providerId,
    protocol: inputs.binding.protocol,
    state,
    capabilityDigest: inputs.binding.capabilityDigest,
    checkedAt: validity.checkedAt,
    expiresAt: validity.expiresAt,
    evidenceRefs: failure.evidenceRefs,
    failure,
    ownerId: inputs.ownerId,
    nextAction: { kind: 'recover', ref: inputs.ownerId },
  };
}

export async function probeDshReadiness(inputs: DshReadinessInputs): Promise<ProviderReadiness> {
  assertDshLockDescriptor(inputs.lock);
  validateProviderBinding(inputs.binding);
  assertDshProbeEvidence(inputs);
  const status = classifyDshProfile(inputs.profile);
  if (status.kind === 'missing-profile') {
    return readinessForMissing('dependency-missing', 'DSH profile is missing; cannot probe readiness', inputs);
  }
  if (status.kind === 'missing-bundle') {
    return readinessForMissing('capability-unavailable', 'Approved HumanAgent DSH plugin/bundle is missing; cannot probe readiness', inputs);
  }
  if (status.kind === 'invalid') {
    return readinessForMissing('dependency-missing', `DSH profile is invalid: ${status.error.message}`, inputs);
  }
  if (!inputs.transport) {
    return readinessForMissing('dependency-missing', 'DSH transport is not available; cannot probe readiness', inputs);
  }

  const context = { binding: inputs.binding, lock: inputs.lock, profile: status.profile };
  let readiness: ProviderReadiness;
  try {
    readiness = await inputs.transport.probe(context);
  } catch (error) {
    throw dshSeamError('transport-failure', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
  }
  try {
    validateProviderReadiness(readiness);
    assertProviderReadinessBinding(readiness, inputs.binding);
  } catch (error) {
    throw dshSeamError('identity-mismatch', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
  }
  try {
    assertNotExpired(readiness.expiresAt);
  } catch (error) {
    throw dshSeamError('configuration-invalid', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
  }
  if (readiness.state !== 'ready') return readiness;

  let capabilities;
  try {
    capabilities = await inputs.transport.capabilities(context);
  } catch (error) {
    throw dshSeamError('transport-failure', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
  }
  assertDshCapabilitiesForBinding(capabilities, inputs.binding, inputs.ownerId);
  try {
    assertNotExpired(readiness.expiresAt);
  } catch (error) {
    throw dshSeamError('configuration-invalid', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
  }
  const missing = inputs.requiredCapabilities.filter((capability) => !capabilities.capabilities.includes(capability));
  if (missing.length > 0) {
    try {
      assertNotExpired(readiness.expiresAt);
      assertDshCapabilitiesForBinding(capabilities, inputs.binding, inputs.ownerId);
    } catch (error) {
      throw dshSeamError('configuration-invalid', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
    }
    const message = `DSH provider is missing required capability: ${missing.join(', ')}`;
    const failure: ProviderError = {
      errorId: 'dsh.capability-missing',
      code: 'dsh.capability-missing',
      category: 'capability',
      phase: 'probe',
      message,
      ownerId: inputs.ownerId,
      retryable: 'manual',
      attention: 'foreground',
      evidenceRefs: capabilities.evidenceRefs,
      nextAction: { kind: 'recover', ref: inputs.ownerId },
    };
    return {
      ...readiness,
      state: 'capability-unavailable',
      failure,
      ownerId: inputs.ownerId,
      nextAction: { kind: 'recover', ref: inputs.ownerId },
    };
  }
  try {
    assertNotExpired(readiness.expiresAt);
    assertDshCapabilitiesForBinding(capabilities, inputs.binding, inputs.ownerId);
  } catch (error) {
    throw dshSeamError('configuration-invalid', error, { phase: 'probe', ownerId: inputs.ownerId, binding: inputs.binding });
  }
  return readiness;
}
