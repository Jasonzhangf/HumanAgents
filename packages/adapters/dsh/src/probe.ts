import type {
  EvidenceRef,
  ProviderBinding,
  ProviderError,
  ProviderProtocol,
  ProviderReadiness,
} from '../../../contracts/src/index.js';
import { validateProviderBinding, validateProviderCapabilities, validateProviderReadiness } from '../../../contracts/src/index.js';
import { DshAdapterError } from './errors.js';
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

function dshEvidence(label: string, protocol: ProviderProtocol): EvidenceRef {
  return {
    evidenceId: {
      scope: 'evidence',
      value: `dsh-evidence-${label}`,
    },
    kind: 'external',
    source: 'dsh-bridge',
    locator: `dsh://evidence/${label}`,
    scope: {
      organId: { scope: 'organ', value: 'organ-unknown' },
      taskId: { scope: 'task', value: 'task-unknown' },
      operationId: { scope: 'operation', value: `op-${protocol}` },
    },
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
    evidenceRefs: [dshEvidence(state, inputs.binding.protocol)],
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
  return {
    bindingId: inputs.binding.bindingId,
    providerId: inputs.binding.providerId,
    protocol: inputs.binding.protocol,
    state,
    capabilityDigest: inputs.binding.capabilityDigest,
    checkedAt: '2026-09-13T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
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
  const readiness = await inputs.transport.probe(context);
  validateProviderReadiness(readiness);
  if (readiness.state !== 'ready') return readiness;

  const capabilities = await inputs.transport.capabilities(context);
  validateProviderCapabilities(capabilities);
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
