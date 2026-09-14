import type {
  EvidenceRef,
  ProviderBinding,
  ProviderError,
  ProviderReadiness,
  ScopeRef,
} from '../../../contracts/src/index.js';
import { createHash } from 'node:crypto';
import {
  assertNotExpired,
  assertProviderBindingMatch,
  assertProviderReadinessBinding,
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

function evidenceToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'probe';
}

function probeValidity(): { readonly checkedAt: string; readonly expiresAt: string } {
  const now = Date.now();
  return {
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
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

function probeScope(inputs: DshReadinessInputs): ScopeRef {
  const bindingToken = evidenceToken(inputs.binding.bindingId);
  return {
    organId: { scope: 'organ', value: `dsh-probe:${bindingToken}` },
    taskId: { scope: 'task', value: `dsh-probe:${bindingToken}` },
    operationId: { scope: 'operation', value: `dsh-probe:${inputs.binding.protocol}` },
  };
}

function probeEvidence(label: string, message: string, inputs: DshReadinessInputs): EvidenceRef {
  const bindingToken = evidenceToken(inputs.binding.bindingId);
  const now = Date.now();
  const digest = createHash('sha256').update(`${label}|${message}|${inputs.binding.bindingId}|${now}`).digest('hex');
  return {
    evidenceId: {
      scope: 'evidence',
      value: `dsh-probe-${bindingToken}-${label}-${now}`,
    },
    kind: 'external',
    source: `dsh-bridge:${inputs.ownerId}`,
    locator: `humanagent://dsh-probe/${encodeURIComponent(inputs.ownerId)}/${encodeURIComponent(inputs.binding.bindingId)}/${now}`,
    digest: `sha256:${digest}`,
    scope: probeScope(inputs),
  };
}

function failureFor(state: 'dependency-missing' | 'capability-unavailable', message: string, inputs: DshReadinessInputs): ProviderError {
  return {
    errorId: `dsh.${state}.probe`,
    code: `dsh.${state}`,
    category: state === 'dependency-missing' ? 'configuration' : 'capability',
    phase: 'probe',
    message,
    ownerId: inputs.ownerId,
    retryable: 'manual',
    attention: 'foreground',
    evidenceRefs: [probeEvidence(state, message, inputs)],
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
  const missing = inputs.requiredCapabilities.filter((capability) => !capabilities.capabilities.includes(capability));
  if (missing.length > 0) {
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
  return readiness;
}
