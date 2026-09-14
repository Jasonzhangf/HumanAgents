import type {
  ExecutionRuntimePort,
  ProviderBinding,
  ProviderCloseResult,
  ProviderErrorPhase,
  ProviderExecutionIdentityRef,
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
  assertProviderBindingMatch,
  assertProviderExecutionIdentityMatch,
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
import { DshAdapterError, dshSeamError } from './errors.js';
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

async function runDsh<T>(
  phase: ProviderErrorPhase,
  ownerId: string,
  options: { readonly binding?: ProviderBinding; readonly identity?: ProviderExecutionIdentityRef },
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw dshSeamError('transport-failure', error, { phase, ownerId, binding: options.binding, identity: options.identity });
  }
}

function assertDshExecutionResult<T extends ProviderExecutionIdentityRef>(
  actual: T,
  expected: ProviderExecutionIdentityRef,
  phase: ProviderErrorPhase,
  ownerId: string,
  binding?: ProviderBinding,
): void {
  try {
    assertProviderExecutionIdentityMatch(actual, expected);
  } catch (error) {
    throw dshSeamError('identity-mismatch', error, { phase, ownerId, binding, identity: expected });
  }
}

function executionKey(input: ProviderExecutionIdentityRef): string {
  return `${input.runtimeId}:${input.taskId.value}:${input.operationId.value}:${input.executionEpoch}`;
}

export function createDshExecutionRuntimePort(inputs: DshBridgeInputs): ExecutionRuntimePort {
  assertDshLockDescriptor(inputs.lock);
  const stopRequests = new Set<string>();

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
      const receipt: ProviderStartReceipt = await runDsh('start', inputs.ownerId, { identity: input }, async () => requireTransport(inputs).start(input));
      validateProviderStartReceipt(receipt);
      assertDshExecutionResult(receipt, input, 'start', inputs.ownerId);
      if (!receipt.externalExecutionRef) {
        throw new DshAdapterError('configuration-invalid', 'DSH start receipt must carry an external execution evidence ref', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
          phase: 'start',
          identity: input,
        });
      }
      assertDshExternalSession({ evidenceRef: receipt.externalExecutionRef }, input.runtimeId);
      return receipt;
    },
    async resume(input) {
      validateProviderResumeInput(input);
      const result: ProviderRecoveryResult = await runDsh('resume', inputs.ownerId, { identity: input }, async () => requireTransport(inputs).resume(input));
      validateProviderRecoveryResult(result);
      assertDshExecutionResult(result, input, 'resume', inputs.ownerId);
      if (result.checkpointId.value !== input.checkpointId.value) {
        throw new DshAdapterError('identity-mismatch', 'DSH resume checkpoint mismatch', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
          phase: 'resume',
          identity: input,
        });
      }
      assertDshExternalSession({ evidenceRef: result.recoveryStateRef }, input.runtimeId);
      return result;
    },
    async submit(input) {
      validateProviderSubmitInput(input);
      const result: ProviderSubmitResult = await runDsh('submit', inputs.ownerId, { identity: input }, async () => requireTransport(inputs).submit(input));
      validateProviderSubmitResult(result);
      assertDshExecutionResult(result, input, 'submit', inputs.ownerId);
      return result;
    },
    async *observe(input) {
      validateProviderObserveInput(input);
      try {
        const events = requireTransport(inputs).observe(input);
        for await (const event of events) {
          validateProviderEvent(event);
          assertDshExecutionResult(event, input, 'observe', inputs.ownerId);
          yield event;
        }
      } catch (error) {
        throw dshSeamError('transport-failure', error, { phase: 'observe', ownerId: inputs.ownerId, identity: input });
      }
    },
    async requestStop(input) {
      validateProviderStopRequest(input);
      const receipt: ProviderStopReceipt = await runDsh('stop', inputs.ownerId, { identity: input }, async () => requireTransport(inputs).requestStop(input));
      validateProviderStopReceipt(receipt);
      assertDshExecutionResult(receipt, input, 'stop', inputs.ownerId);
      if (receipt.status !== 'rejected') stopRequests.add(executionKey(input));
      return receipt;
    },
    async settle(input) {
      validateProviderSettleInput(input);
      const settlement: ProviderSettlement = await runDsh('settle', inputs.ownerId, { identity: input }, async () => requireTransport(inputs).settle(input));
      validateProviderSettlement(settlement);
      assertDshExecutionResult(settlement, input, 'settle', inputs.ownerId);
      if (settlement.state === 'stopped' && !stopRequests.has(executionKey(input))) {
        throw new DshAdapterError('identity-mismatch', 'DSH settlement reports stopped without a prior non-rejected stop request', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
          phase: 'settle',
          identity: input,
        });
      }
      return settlement;
    },
    async close(binding) {
      validateProviderBinding(binding);
      const result: ProviderCloseResult = await runDsh('close', inputs.ownerId, { binding }, async () => requireTransport(inputs).close(contextFor(inputs, binding)));
      validateProviderCloseResult(result);
      try {
        assertProviderBindingMatch(binding, {
          bindingId: result.bindingId,
          providerId: result.providerId,
          protocol: result.protocol,
        });
      } catch (error) {
        throw dshSeamError('identity-mismatch', error, { phase: 'close', ownerId: inputs.ownerId, binding });
      }
      return result;
    },
  };
}
