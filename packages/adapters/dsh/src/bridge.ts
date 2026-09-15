import type {
  ExecutionRuntimePort,
  EvidenceRef,
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
  ScopeRef,
} from '../../../contracts/src/index.js';
import {
  assertSameScope,
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

function requireTransportWithSeam(
  inputs: DshBridgeInputs,
  phase: ProviderErrorPhase,
  identity: ProviderExecutionIdentityRef,
): DshTransport {
  try {
    return requireTransport(inputs);
  } catch (error) {
    throw dshSeamError('transport-failure', error, { phase, ownerId: inputs.ownerId, identity });
  }
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

function scopeSnapshot(input: ScopeRef): ScopeRef {
  return {
    organId: { scope: input.organId.scope, value: input.organId.value },
    ...(input.taskId ? { taskId: { scope: input.taskId.scope, value: input.taskId.value } } : {}),
    ...(input.cycleId ? { cycleId: { scope: input.cycleId.scope, value: input.cycleId.value } } : {}),
    ...(input.operationId ? { operationId: { scope: input.operationId.scope, value: input.operationId.value } } : {}),
  };
}

function cloneDetached<T>(input: T): T {
  return structuredClone(input);
}

function cloneRawResult<T>(
  input: T,
  phase: ProviderErrorPhase,
  ownerId: string,
  options: { readonly binding?: ProviderBinding; readonly identity?: ProviderExecutionIdentityRef },
): T {
  try {
    return cloneDetached(input);
  } catch (error) {
    throw dshSeamError('transport-failure', error, {
      phase,
      ownerId,
      binding: options.binding,
      identity: options.identity,
    });
  }
}

function executionScopeFromInput(input: ProviderStartInput | ProviderResumeInput, phase: ProviderErrorPhase, ownerId: string): ScopeRef {
  const ref = input.evidenceRefs[0];
  if (!ref) {
    throw new DshAdapterError('configuration-invalid', 'DSH execution requires evidence scope before binding a provider execution', ownerId, { kind: 'recover', ref: ownerId }, {
      phase,
      identity: input,
    });
  }
  return scopeSnapshot({ ...ref.scope, taskId: input.taskId, operationId: input.operationId });
}

function isFinalSettlement(settlement: ProviderSettlement): boolean {
  return settlement.resourceRelease.state === 'released'
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
    evidenceRefs: input.evidenceRefs ? cloneDetached(input.evidenceRefs) : undefined,
  };
}

export function createDshExecutionRuntimePort(inputs: DshBridgeInputs): ExecutionRuntimePort {
  assertDshLockDescriptor(inputs.lock);
  interface ExecutionFence {
    readonly scope: ScopeRef;
    readonly evidenceRefs: readonly EvidenceRef[];
  }
  const inFlightInstances = new Map<string, ExecutionFence>();
  const activeInstances = new Map<string, ExecutionFence>();
  let closeInFlight = false;
  let closed = false;

  function assertScopeMatch(expected: ScopeRef, actual: ScopeRef, phase: ProviderErrorPhase, identity: ProviderExecutionIdentityRef, label: string): void {
    try {
      assertSameScope(expected, actual);
    } catch (error) {
      throw new DshAdapterError('identity-mismatch', `DSH ${label} does not match current execution scope`, inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
        phase,
        identity,
        cause: error,
      });
    }
  }

  function assertEvidenceScopeMatches(expected: ScopeRef, ref: EvidenceRef, phase: ProviderErrorPhase, identity: ProviderExecutionIdentityRef, label: string): void {
    assertScopeMatch(expected, ref.scope, phase, identity, label);
  }

  function assertInputEvidenceScopeMatches(input: { readonly evidenceRefs: readonly EvidenceRef[] }, expected: ScopeRef, phase: ProviderErrorPhase): void {
    for (const ref of input.evidenceRefs) assertEvidenceScopeMatches(expected, ref, phase, input as unknown as ProviderExecutionIdentityRef, 'input evidence');
  }

  function assertActive(identity: ProviderExecutionIdentityRef, phase: ProviderErrorPhase, evidenceRefs: readonly EvidenceRef[] = []): ExecutionFence {
    const active = activeInstances.get(executionKey(identity));
    if (!active) {
      throw new DshAdapterError('identity-mismatch', 'DSH execution is not active; start or resume must open the instance first', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
        phase,
        identity,
      });
    }
    for (const ref of evidenceRefs) assertEvidenceScopeMatches(active.scope, ref, phase, identity, 'active execution evidence');
    return active;
  }

  function assertNotInFlight(identity: ProviderExecutionIdentityRef, phase: ProviderErrorPhase): void {
    if (!inFlightInstances.has(executionKey(identity))) return;
    throw new DshAdapterError('identity-mismatch', 'DSH execution is already in flight; concurrent lifecycle operation is rejected', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
      phase,
      identity,
    });
  }

  function assertOpenable(identity: ProviderExecutionIdentityRef, phase: ProviderErrorPhase): void {
    if (!closeInFlight && !closed) return;
    throw new DshAdapterError('identity-mismatch', closed ? 'DSH transport is closed; execution cannot become active' : 'DSH transport close is in progress; execution cannot open', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
      phase,
      identity,
    });
  }

  function currentFence(): ExecutionFence | undefined {
    return inFlightInstances.values().next().value as ExecutionFence | undefined
      ?? activeInstances.values().next().value as ExecutionFence | undefined;
  }

  function pendingClose(binding: ProviderBinding, fence: ExecutionFence): ProviderCloseResult {
    const result: ProviderCloseResult = {
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'pending',
      evidenceRefs: cloneDetached(fence.evidenceRefs),
      ownerId: inputs.ownerId,
      nextAction: { kind: 'recover', ref: inputs.ownerId },
    };
    validateSeamResult(result, 'close', validateProviderCloseResult, { binding });
    return result;
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
      const scope = executionScopeFromInput(input, 'start', inputs.ownerId);
      assertInputEvidenceScopeMatches(input, scope, 'start');
      assertOpenable(snapshot, 'start');
      const active = activeInstances.get(executionKey(snapshot));
      if (active) {
        assertScopeMatch(active.scope, scope, 'start', snapshot, 'active execution');
        throw new DshAdapterError('identity-mismatch', 'DSH execution is already active; concurrent start is rejected', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
          phase: 'start',
          identity: snapshot,
        });
      }
      assertNotInFlight(snapshot, 'start');
      const transport = requireTransportWithSeam(inputs, 'start', snapshot);
      const fence: ExecutionFence = { scope: scopeSnapshot(scope), evidenceRefs: cloneDetached(input.evidenceRefs) };
      inFlightInstances.set(executionKey(snapshot), fence);
      try {
        const transportInput = cloneDetached({ ...input, ...snapshot });
        const rawReceipt: ProviderStartReceipt = await runDsh('start', inputs.ownerId, { identity: snapshot }, async () => transport.start(transportInput));
        const receipt = cloneRawResult(rawReceipt, 'start', inputs.ownerId, { identity: snapshot });
        validateSeamResult(receipt, 'start', validateProviderStartReceipt, { identity: snapshot });
        assertDshExecutionResult(receipt, snapshot, 'start', inputs.ownerId);
        for (const ref of receipt.evidenceRefs) assertEvidenceScopeMatches(scope, ref, 'start', snapshot, 'start evidence');
        if (!receipt.externalExecutionRef) {
          throw new DshAdapterError('configuration-invalid', 'DSH start receipt must carry an external execution evidence ref', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
            phase: 'start',
            identity: snapshot,
          });
        }
        assertEvidenceScopeMatches(scope, receipt.externalExecutionRef, 'start', snapshot, 'external execution evidence');
        try {
          assertDshExternalSession({ evidenceRef: receipt.externalExecutionRef }, snapshot.runtimeId);
        } catch (error) {
          throw dshSeamError('identity-mismatch', error, { phase: 'start', ownerId: inputs.ownerId, identity: snapshot });
        }
        activeInstances.set(executionKey(snapshot), { scope: scopeSnapshot(scope), evidenceRefs: cloneDetached(receipt.evidenceRefs) });
        return cloneDetached(receipt);
      } finally {
        if (inFlightInstances.get(executionKey(snapshot)) === fence) inFlightInstances.delete(executionKey(snapshot));
      }
    },
    async resume(input) {
      validateSeamInput(input, 'resume', validateProviderResumeInput);
      const snapshot = resumeSnapshot(input);
      const scope = executionScopeFromInput(input, 'resume', inputs.ownerId);
      assertInputEvidenceScopeMatches(input, scope, 'resume');
      assertOpenable(snapshot, 'resume');
      assertNotInFlight(snapshot, 'resume');
      const active = activeInstances.get(executionKey(snapshot));
      if (active) {
        assertScopeMatch(active.scope, scope, 'resume', snapshot, 'active execution');
      }
      const transport = requireTransportWithSeam(inputs, 'resume', snapshot);
      const fence: ExecutionFence = { scope: scopeSnapshot(scope), evidenceRefs: cloneDetached(input.evidenceRefs) };
      inFlightInstances.set(executionKey(snapshot), fence);
      try {
        const transportInput = cloneDetached({ ...input, ...snapshot });
        const rawResult: ProviderRecoveryResult = await runDsh('resume', inputs.ownerId, { identity: snapshot }, async () => transport.resume(transportInput));
        const result = cloneRawResult(rawResult, 'resume', inputs.ownerId, { identity: snapshot });
        validateSeamResult(result, 'resume', validateProviderRecoveryResult, { identity: snapshot });
        assertDshExecutionResult(result, snapshot, 'resume', inputs.ownerId);
        if (result.checkpointId.value !== snapshot.checkpointId.value || result.checkpointId.scope !== snapshot.checkpointId.scope) {
          throw new DshAdapterError('identity-mismatch', 'DSH resume checkpoint mismatch', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
            phase: 'resume',
            identity: snapshot,
          });
        }
        assertEvidenceScopeMatches(scope, result.recoveryStateRef, 'resume', snapshot, 'recovery state evidence');
        for (const ref of result.evidenceRefs) assertEvidenceScopeMatches(scope, ref, 'resume', snapshot, 'recovery evidence');
        try {
          assertDshExternalSession({ evidenceRef: result.recoveryStateRef }, snapshot.runtimeId);
        } catch (error) {
          throw dshSeamError('identity-mismatch', error, { phase: 'resume', ownerId: inputs.ownerId, identity: snapshot });
        }
        if (result.recovered && !result.staleRejected) {
          assertOpenable(snapshot, 'resume');
          activeInstances.set(executionKey(snapshot), { scope: scopeSnapshot(scope), evidenceRefs: cloneDetached(result.evidenceRefs) });
        }
        return cloneDetached(result);
      } finally {
        if (inFlightInstances.get(executionKey(snapshot)) === fence) inFlightInstances.delete(executionKey(snapshot));
      }
    },
    async submit(input) {
      validateSeamInput(input, 'submit', validateProviderSubmitInput);
      const snapshot = executionSnapshot(input);
      assertActive(snapshot, 'submit', input.evidenceRefs);
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
      assertActive(snapshot, 'stop', input.evidenceRefs ?? []);
      const transportInput = { ...input, ...snapshot };
      const receipt: ProviderStopReceipt = await runDsh('stop', inputs.ownerId, { identity: snapshot }, async () => requireTransport(inputs).requestStop(transportInput));
      validateSeamResult(receipt, 'stop', validateProviderStopReceipt, { identity: snapshot });
      assertDshExecutionResult(receipt, snapshot, 'stop', inputs.ownerId);
      return receipt;
    },
    async settle(input) {
      validateSeamInput(input, 'settle', validateProviderSettleInput);
      const snapshot = settleSnapshot(input);
      assertNotInFlight(snapshot, 'settle');
      const active = assertActive(snapshot, 'settle', input.evidenceRefs ?? []);
      const key = executionKey(snapshot);
      const fence: ExecutionFence = { scope: scopeSnapshot(active.scope), evidenceRefs: cloneDetached(active.evidenceRefs) };
      inFlightInstances.set(key, fence);
      try {
        const transportInput = cloneDetached({ ...input, ...snapshot });
        const rawSettlement: ProviderSettlement = await runDsh('settle', inputs.ownerId, { identity: snapshot }, async () => requireTransport(inputs).settle(transportInput));
        const settlement = cloneRawResult(rawSettlement, 'settle', inputs.ownerId, { identity: snapshot });
        validateSeamResult(settlement, 'settle', validateProviderSettlement, { identity: snapshot });
        assertDshExecutionResult(settlement, snapshot, 'settle', inputs.ownerId);
        for (const ref of settlement.evidenceRefs) assertEvidenceScopeMatches(active.scope, ref, 'settle', snapshot, 'settlement evidence');
        for (const ref of settlement.resourceRelease.evidenceRefs) assertEvidenceScopeMatches(active.scope, ref, 'settle', snapshot, 'resource release evidence');
        for (const ref of settlement.persistence.evidenceRefs) assertEvidenceScopeMatches(active.scope, ref, 'settle', snapshot, 'persistence evidence');
        if (isFinalSettlement(settlement) && activeInstances.get(key) === active && inFlightInstances.get(key) === fence) {
          activeInstances.delete(key);
        }
        return cloneDetached(settlement);
      } finally {
        if (inFlightInstances.get(key) === fence) inFlightInstances.delete(key);
      }
    },
    async close(binding) {
      validateSeamBinding(binding, 'close');
      if (closeInFlight) {
        throw new DshAdapterError('identity-mismatch', 'DSH transport close is already in progress; concurrent close is rejected', inputs.ownerId, { kind: 'recover', ref: inputs.ownerId }, {
          phase: 'close',
          binding,
        });
      }
      const fence = currentFence();
      if (fence) return pendingClose(binding, fence);
      closeInFlight = true;
      try {
        const rawResult: ProviderCloseResult = await runDsh('close', inputs.ownerId, { binding }, async () => requireTransport(inputs).close(contextFor(inputs, binding)));
        const result = cloneRawResult(rawResult, 'close', inputs.ownerId, { binding });
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
        if (result.state === 'closed') closed = true;
        return cloneDetached(result);
      } finally {
        closeInFlight = false;
      }
    },
  };
}
