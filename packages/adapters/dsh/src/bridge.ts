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
import { classifyDshProfile, probeDshReadiness, type DshProbeEvidence } from './probe.js';
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
  readonly probeEvidence?: DshProbeEvidence;
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

function executionSnapshot(input: ProviderExecutionIdentityRef): ProviderExecutionIdentityRef {
  return {
    runtimeId: input.runtimeId,
    taskId: { scope: input.taskId.scope, value: input.taskId.value },
    operationId: { scope: input.operationId.scope, value: input.operationId.value },
    executionEpoch: input.executionEpoch,
  };
}

function isFinalSettlement(settlement: ProviderSettlement): boolean {
  return (settlement.state === 'succeeded' || settlement.state === 'stopped' || settlement.state === 'cancelled')
    && settlement.resourceRelease.state === 'released'
    && settlement.persistence.state === 'committed';
}

function resumeSnapshot(input: ProviderResumeInput): ProviderExecutionIdentityRef & {
  readonly checkpointId: ProviderResumeInput['checkpointId'];
  readonly checkpointExecutionEpoch: number;
} {
  return {
    ...executionSnapshot(input),
    checkpointId: { scope: input.checkpointId.scope, value: input.checkpointId.value },
    checkpointExecutionEpoch: input.checkpointExecutionEpoch,
  };
}

function settleSnapshot(input: ProviderSettleInput): ProviderExecutionIdentityRef & {
  readonly evidenceRefs?: ProviderSettleInput['evidenceRefs'];
} {
  return {
    ...executionSnapshot(input),
    evidenceRefs: input.evidenceRefs,
  };
}

export function createDshExecutionRuntimePort(inputs: DshBridgeInputs): ExecutionRuntimePort {
  assertDshLockDescriptor(inputs.lock);
  const activeInstances = new Set<string>();

  function assertActive(identity: ProviderExecutionIdentityRef, phase: ProviderErrorPhase): void {
    if (!activeInstances.has(executionKey(identity))) {
      throw new DshAdapterError('identity-mismatch', 'DSH execution is not active; start or resume must open the instance first', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
        phase,
        identity,
      });
    }
  }

  function validateSeamBinding(binding: ProviderBinding, phase: ProviderErrorPhase): void {
    try {
      validateProviderBinding(binding);
    } catch (error) {
      throw dshSeamError('configuration-invalid', error, { phase, ownerId: inputs.ownerId, binding });
    }
  }

  function validateSeamInput<T>(input: T, phase: ProviderErrorPhase, validate: (value: T) => void, binding?: ProviderBinding): void {
    try {
      validate(input);
    } catch (error) {
      throw dshSeamError('configuration-invalid', error, {
        phase,
        ownerId: inputs.ownerId,
        binding,
        identity: input && typeof input === 'object' ? input as unknown as ProviderExecutionIdentityRef : undefined,
      });
    }
  }

  function validateSeamResult<T>(result: T, phase: ProviderErrorPhase, validate: (value: T) => void, options: { readonly binding?: ProviderBinding; readonly identity?: ProviderExecutionIdentityRef } = {}): void {
    try {
      validate(result);
    } catch (error) {
      throw dshSeamError('transport-failure', error, { phase, ownerId: inputs.ownerId, binding: options.binding, identity: options.identity });
    }
  }

  return {
    kind: 'humanagent.execution-runtime-port',
    async probe(binding) {
      validateSeamBinding(binding, 'probe');
      return probeDshReadiness({
        binding,
        lock: inputs.lock,
        profile: inputs.profile,
        transport: inputs.transport,
        requiredCapabilities: inputs.requiredCapabilities,
        ownerId: inputs.ownerId,
        probeEvidence: inputs.probeEvidence,
      });
    },
    async capabilities(binding) {
      validateSeamBinding(binding, 'probe');
      return capabilitiesDsh({
        binding,
        lock: inputs.lock,
        profile: inputs.profile,
        transport: inputs.transport,
        requiredCapabilities: inputs.requiredCapabilities,
        ownerId: inputs.ownerId,
        probeEvidence: inputs.probeEvidence,
      });
    },
    async start(input) {
      validateSeamInput(input, 'start', validateProviderStartInput);
      const snapshot = executionSnapshot(input);
      const transportInput = { ...input, ...snapshot };
      const receipt: ProviderStartReceipt = await runDsh('start', inputs.ownerId, { identity: snapshot }, async () => requireTransport(inputs).start(transportInput));
      validateSeamResult(receipt, 'start', validateProviderStartReceipt, { identity: snapshot });
      assertDshExecutionResult(receipt, snapshot, 'start', inputs.ownerId);
      if (!receipt.externalExecutionRef) {
        throw new DshAdapterError('configuration-invalid', 'DSH start receipt must carry an external execution evidence ref', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
          phase: 'start',
          identity: snapshot,
        });
      }
      try {
        assertDshExternalSession({ evidenceRef: receipt.externalExecutionRef }, snapshot.runtimeId);
      } catch (error) {
        throw dshSeamError('identity-mismatch', error, { phase: 'start', ownerId: inputs.ownerId, identity: snapshot });
      }
      activeInstances.add(executionKey(snapshot));
      return receipt;
    },
    async resume(input) {
      validateSeamInput(input, 'resume', validateProviderResumeInput);
      const snapshot = resumeSnapshot(input);
      const transportInput = { ...input, ...snapshot };
      const result: ProviderRecoveryResult = await runDsh('resume', inputs.ownerId, { identity: snapshot }, async () => requireTransport(inputs).resume(transportInput));
      validateSeamResult(result, 'resume', validateProviderRecoveryResult, { identity: snapshot });
      assertDshExecutionResult(result, snapshot, 'resume', inputs.ownerId);
      if (result.checkpointId.value !== snapshot.checkpointId.value || result.checkpointId.scope !== snapshot.checkpointId.scope) {
        throw new DshAdapterError('identity-mismatch', 'DSH resume checkpoint mismatch', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
          phase: 'resume',
          identity: snapshot,
        });
      }
      try {
        assertDshExternalSession({ evidenceRef: result.recoveryStateRef }, snapshot.runtimeId);
      } catch (error) {
        throw dshSeamError('identity-mismatch', error, { phase: 'resume', ownerId: inputs.ownerId, identity: snapshot });
      }
      if (result.recovered && !result.staleRejected) activeInstances.add(executionKey(snapshot));
      return result;
    },
    async submit(input) {
      validateSeamInput(input, 'submit', validateProviderSubmitInput);
      const snapshot = executionSnapshot(input);
      assertActive(snapshot, 'submit');
      const transportInput = { ...input, ...snapshot };
      const result: ProviderSubmitResult = await runDsh('submit', inputs.ownerId, { identity: snapshot }, async () => requireTransport(inputs).submit(transportInput));
      validateSeamResult(result, 'submit', validateProviderSubmitResult, { identity: snapshot });
      assertDshExecutionResult(result, snapshot, 'submit', inputs.ownerId);
      return result;
    },
    async *observe(input) {
      validateSeamInput(input, 'observe', validateProviderObserveInput);
      const snapshot = executionSnapshot(input);
      assertActive(snapshot, 'observe');
      try {
        const events = requireTransport(inputs).observe({ ...input, ...snapshot });
        for await (const event of events) {
          validateSeamResult(event, 'observe', validateProviderEvent, { identity: snapshot });
          assertDshExecutionResult(event, snapshot, 'observe', inputs.ownerId);
          yield event;
        }
      } catch (error) {
        throw dshSeamError('transport-failure', error, { phase: 'observe', ownerId: inputs.ownerId, identity: snapshot });
      }
    },
    async requestStop(input) {
      validateSeamInput(input, 'stop', validateProviderStopRequest);
      const snapshot = executionSnapshot(input);
      assertActive(snapshot, 'stop');
      const transportInput = { ...input, ...snapshot };
      const receipt: ProviderStopReceipt = await runDsh('stop', inputs.ownerId, { identity: snapshot }, async () => requireTransport(inputs).requestStop(transportInput));
      validateSeamResult(receipt, 'stop', validateProviderStopReceipt, { identity: snapshot });
      assertDshExecutionResult(receipt, snapshot, 'stop', inputs.ownerId);
      return receipt;
    },
    async settle(input) {
      validateSeamInput(input, 'settle', validateProviderSettleInput);
      const snapshot = settleSnapshot(input);
      assertActive(snapshot, 'settle');
      const transportInput = { ...input, ...snapshot };
      const settlement: ProviderSettlement = await runDsh('settle', inputs.ownerId, { identity: snapshot }, async () => requireTransport(inputs).settle(transportInput));
      validateSeamResult(settlement, 'settle', validateProviderSettlement, { identity: snapshot });
      assertDshExecutionResult(settlement, snapshot, 'settle', inputs.ownerId);
      if (isFinalSettlement(settlement)) activeInstances.delete(executionKey(snapshot));
      return settlement;
    },
    async close(binding) {
      validateSeamBinding(binding, 'close');
      const result: ProviderCloseResult = await runDsh('close', inputs.ownerId, { binding }, async () => requireTransport(inputs).close(contextFor(inputs, binding)));
      validateSeamResult(result, 'close', validateProviderCloseResult, { binding });
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
