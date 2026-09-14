import type {
  ExecutionRuntimePort,
  ProviderBinding,
  ProviderCloseResult,
  ProviderObserveInput,
  ProviderRecoveryResult,
  ProviderResumeInput,
  ProviderSettleInput,
  ProviderSettlement,
  ProviderStartInput,
  ProviderStartReceipt,
  ProviderStopReceipt,
  ProviderStopRequest,
  ProviderSubmitInput,
  ProviderSubmitResult,
} from '../../../contracts/src/index.js';
import {
  validateProviderBinding,
  validateProviderCloseResult,
  validateProviderEvent,
  validateProviderObserveInput,
  validateProviderRecoveryResult,
  validateProviderResumeInput,
  validateProviderSettleInput,
  validateProviderSettlement,
  validateProviderStartInput,
  validateProviderStartReceipt,
  validateProviderStopReceipt,
  validateProviderStopRequest,
  validateProviderSubmitInput,
  validateProviderSubmitResult,
} from '../../../contracts/src/index.js';
import { capabilitiesDsh } from './capabilities.js';
import { DshAdapterError } from './errors.js';
import { classifyDshProfile, probeDshReadiness } from './probe.js';
import type { DshTransport } from './transport.js';
import {
  assertDshExternalSession,
  assertDshLockDescriptor,
  type DshLockDescriptor,
  type DshProfileDescriptor,
} from './types.js';

export interface DshBridgeInputs {
  readonly lock: DshLockDescriptor;
  readonly profile?: DshProfileDescriptor;
  readonly transport: DshTransport | null;
  readonly requiredCapabilities: readonly string[];
  readonly ownerId: string;
}

function requireTransport(inputs: DshBridgeInputs): DshTransport {
  const status = classifyDshProfile(inputs.profile);
  if (status.kind === 'missing-profile') {
    throw new DshAdapterError('dependency-missing', 'DSH profile is missing; cannot execute provider operation', inputs.ownerId);
  }
  if (status.kind === 'missing-bundle') {
    throw new DshAdapterError('capability-unavailable', 'Approved HumanAgent DSH plugin/bundle is missing; cannot execute provider operation', inputs.ownerId);
  }
  if (status.kind === 'invalid') {
    throw new DshAdapterError('dependency-missing', `DSH profile is invalid: ${status.error.message}`, inputs.ownerId);
  }
  if (!inputs.transport) {
    throw new DshAdapterError('dependency-missing', 'DSH transport is not available; cannot execute provider operation', inputs.ownerId);
  }
  return inputs.transport;
}

function contextFor(inputs: DshBridgeInputs, binding: ProviderBinding): Parameters<DshTransport['probe']>[0] {
  const status = classifyDshProfile(inputs.profile);
  if (status.kind !== 'ready') throw new DshAdapterError('dependency-missing', 'DSH profile is not ready; cannot construct transport context', inputs.ownerId);
  return { binding, lock: inputs.lock, profile: status.profile };
}

export function createDshExecutionRuntimePort(inputs: DshBridgeInputs): ExecutionRuntimePort {
  assertDshLockDescriptor(inputs.lock);

  return {
    kind: 'humanagent.execution-runtime-port',
    async probe(binding) {
      validateProviderBinding(binding);
      return probeDshReadiness({
        binding,
        lock: inputs.lock,
        profile: inputs.profile,
        transport: inputs.transport,
        requiredCapabilities: inputs.requiredCapabilities,
        ownerId: inputs.ownerId,
      });
    },
    async capabilities(binding) {
      validateProviderBinding(binding);
      return capabilitiesDsh({
        binding,
        lock: inputs.lock,
        profile: inputs.profile,
        transport: inputs.transport,
        requiredCapabilities: inputs.requiredCapabilities,
        ownerId: inputs.ownerId,
      });
    },
    async start(input) {
      validateProviderStartInput(input);
      const receipt: ProviderStartReceipt = await requireTransport(inputs).start(input);
      validateProviderStartReceipt(receipt);
      if (!receipt.externalExecutionRef) {
        throw new DshAdapterError('configuration-invalid', 'DSH start receipt must carry an external execution evidence ref', inputs.ownerId);
      }
      assertDshExternalSession({ evidenceRef: receipt.externalExecutionRef }, input.runtimeId);
      return receipt;
    },
    async resume(input) {
      validateProviderResumeInput(input);
      const result: ProviderRecoveryResult = await requireTransport(inputs).resume(input);
      validateProviderRecoveryResult(result);
      assertDshExternalSession({ evidenceRef: result.recoveryStateRef }, input.runtimeId);
      return result;
    },
    async submit(input) {
      validateProviderSubmitInput(input);
      const result: ProviderSubmitResult = await requireTransport(inputs).submit(input);
      validateProviderSubmitResult(result);
      return result;
    },
    async *observe(input) {
      validateProviderObserveInput(input);
      const events = requireTransport(inputs).observe(input);
      for await (const event of events) {
        validateProviderEvent(event);
        yield event;
      }
    },
    async requestStop(input) {
      validateProviderStopRequest(input);
      const receipt: ProviderStopReceipt = await requireTransport(inputs).requestStop(input);
      validateProviderStopReceipt(receipt);
      return receipt;
    },
    async settle(input) {
      validateProviderSettleInput(input);
      const settlement: ProviderSettlement = await requireTransport(inputs).settle(input);
      validateProviderSettlement(settlement);
      return settlement;
    },
    async close(binding) {
      validateProviderBinding(binding);
      const result: ProviderCloseResult = await requireTransport(inputs).close(contextFor(inputs, binding));
      validateProviderCloseResult(result);
      return result;
    },
  };
}
