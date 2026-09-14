import {
  assertNotExpired,
  assertProviderEventEpoch,
  assertProviderExecutionIdentityMatch,
  assertProviderReadinessBinding,
  validateProviderBinding,
  validateProviderCapabilities,
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
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type EvidenceRef,
  type ProviderExecutionIdentityRef,
  type ProviderObserveInput,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderResumeInput,
  type ProviderSettleInput,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
  type ProviderErrorPhase,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { type ProviderCodec, type ProviderDecodedEvent } from './codecs.js';
import { ProviderAdapterError } from './errors.js';
import type { ProviderWireEvent, ProviderWireRequest, ProviderWireStopRequest } from './wire.js';

export interface ProviderTransport {
  readonly readiness?: ProviderReadiness;
  readonly capabilities?: ProviderCapabilities;
  start(input: ProviderStartInput, request: ProviderWireRequest): Promise<ProviderStartReceipt>;
  resume(input: ProviderResumeInput, request: ProviderWireRequest): Promise<ProviderRecoveryResult>;
  submit(input: ProviderSubmitInput, request: ProviderWireRequest): Promise<ProviderSubmitResult>;
  observe(input: ProviderObserveInput): AsyncIterable<ProviderWireEvent>;
  requestStop(input: ProviderStopRequest, request: ProviderWireStopRequest): Promise<ProviderStopReceipt>;
  settle(input: ProviderSettleInput): Promise<ProviderSettlement>;
  close(binding: ProviderBinding): Promise<ProviderCloseResult>;
}

export interface ProviderAdapterOptions {
  readonly binding: ProviderBinding;
  readonly routeRef: string;
  readonly codec: ProviderCodec;
  readonly transport: ProviderTransport;
}

function sameProviderBinding(a: ProviderBinding, b: ProviderBinding): boolean {
  return a.bindingId === b.bindingId
    && a.providerId === b.providerId
    && a.protocol === b.protocol
    && a.endpointRef === b.endpointRef
    && a.modelRef === b.modelRef
    && a.configDigest === b.configDigest
    && a.capabilityDigest === b.capabilityDigest;
}

function sameExecutionIdentity(a: ProviderExecutionIdentityRef, b: ProviderExecutionIdentityRef): boolean {
  return a.runtimeId === b.runtimeId
    && a.taskId.value === b.taskId.value
    && a.operationId.value === b.operationId.value
    && a.executionEpoch === b.executionEpoch;
}

interface ActiveExecution {
  readonly identity: ProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly externalExecutionRef?: EvidenceRef;
}

function scopeFromEvidence(input: ProviderStartInput | ProviderResumeInput): ScopeRef {
  const ref = input.evidenceRefs[0];
  if (!ref) {
    throw new ProviderAdapterError({
      code: 'missing.scope.evidence',
      category: 'validation',
      phase: 'start',
      message: 'provider execution requires evidence scope for operation projection',
      scope: input,
    });
  }
  return { ...ref.scope, taskId: input.taskId, operationId: input.operationId };
}

export class ProviderAdapter implements ExecutionRuntimePort {
  readonly kind = 'humanagent.execution-runtime-port' as const;

  private readonly sessions = new Map<string, ActiveExecution>();

  constructor(private readonly options: ProviderAdapterOptions) {
    validateProviderBinding(options.binding);
    if (!options.routeRef || !options.routeRef.trim()) {
      throw new ProviderAdapterError({
        code: 'missing.route',
        category: 'validation',
        phase: 'start',
        message: 'provider adapter requires a non-empty route reference',
        scope: options.binding,
      });
    }
    if (options.codec.protocol !== options.binding.protocol) {
      throw new ProviderAdapterError({
        code: 'protocol.mismatch',
        category: 'protocol',
        phase: 'start',
        message: `binding protocol ${options.binding.protocol} does not match codec protocol ${options.codec.protocol}`,
        scope: options.binding,
      });
    }
    if (options.binding.protocol !== 'responses' && options.binding.protocol !== 'anthropic') {
      throw new ProviderAdapterError({
        code: 'capability.unavailable',
        category: 'capability',
        phase: 'start',
        message: 'provider adapter currently requires an explicit responses or anthropic binding',
        scope: options.binding,
      });
    }
    if (!options.transport) {
      throw new ProviderAdapterError({
        code: 'missing.transport',
        category: 'validation',
        phase: 'start',
        message: 'provider adapter requires an explicit transport',
        scope: options.binding,
      });
    }
  }

  async probe(binding: ProviderBinding): Promise<ProviderReadiness> {
    this.assertSameBinding(binding, 'probe');
    const readiness = this.options.transport.readiness;
    if (!readiness) {
      throw new ProviderAdapterError({
        code: 'missing.readiness.evidence',
        category: 'validation',
        phase: 'probe',
        message: 'provider readiness requires readiness evidence; none was provided',
        scope: binding,
      });
    }
    assertProviderReadinessBinding(readiness, binding);
    try {
      assertNotExpired(readiness.expiresAt);
    } catch {
      throw new ProviderAdapterError({
        code: 'readiness.expired',
        category: 'capability',
        phase: 'probe',
        message: 'provider readiness evidence expired',
        scope: binding,
      });
    }
    return readiness;
  }

  async capabilities(binding: ProviderBinding): Promise<ProviderCapabilities> {
    this.assertSameBinding(binding, 'probe');
    const capabilities = this.options.transport.capabilities;
    if (!capabilities) {
      throw new ProviderAdapterError({
        code: 'missing.capability.evidence',
        category: 'validation',
        phase: 'probe',
        message: 'provider capabilities require externally supplied evidence; none was provided',
        scope: binding,
      });
    }
    validateProviderCapabilities(capabilities);
    try {
      assertNotExpired(capabilities.expiresAt);
    } catch {
      throw new ProviderAdapterError({
        code: 'capability.expired',
        category: 'capability',
        phase: 'probe',
        message: 'provider capability evidence expired',
        scope: binding,
      });
    }
    if (capabilities.bindingId !== binding.bindingId
      || capabilities.providerId !== binding.providerId
      || capabilities.protocol !== binding.protocol
      || capabilities.digest !== binding.capabilityDigest) {
      throw new ProviderAdapterError({
        code: 'capability.mismatch',
        category: 'protocol',
        phase: 'probe',
        message: 'provider capabilities do not match binding identity',
        scope: binding,
      });
    }
    return capabilities;
  }

  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    validateProviderStartInput(input);
    if (this.sessions.has(input.runtimeId)) {
      throw new ProviderAdapterError({
        code: 'runtime.already.started',
        category: 'runtime',
        phase: 'start',
        message: 'provider runtime id is already bound to an active execution',
        scope: input,
      });
    }
    const scope = scopeFromEvidence(input);
    const request = this.options.codec.encodeStart(input, this.options.binding, this.options.routeRef);
    const receipt = await this.callTransport('start', input, () => this.options.transport.start(input, request));
    validateProviderStartReceipt(receipt);
    assertProviderExecutionIdentityMatch(receipt, input);
    if (receipt.externalExecutionRef) this.assertExternalEvidenceMatches(receipt.externalExecutionRef, input, scope, 'start');
    this.sessions.set(input.runtimeId, { identity: { ...input }, scope, externalExecutionRef: receipt.externalExecutionRef });
    return receipt;
  }

  async resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
    validateProviderResumeInput(input);
    const existing = this.sessions.get(input.runtimeId);
    if (existing) {
      if (!sameExecutionIdentity(existing.identity, input)) {
        throw new ProviderAdapterError({
          code: 'resume.identity.mismatch',
          category: 'protocol',
          phase: 'resume',
          message: 'provider resume input does not match active execution identity',
          scope: input,
        });
      }
    }
    const scope = scopeFromEvidence(input);
    const request = this.options.codec.encodeResume(input, this.options.binding, this.options.routeRef);
    const result = await this.callTransport('resume', input, () => this.options.transport.resume(input, request));
    validateProviderRecoveryResult(result);
    assertProviderExecutionIdentityMatch(result, input);
    if (result.staleRejected) {
      throw new ProviderAdapterError({
        code: 'resume.stale.rejected',
        category: 'protocol',
        phase: 'resume',
        message: result.error?.message ?? 'provider resume rejected stale execution',
        scope: input,
        cause: result.error,
      });
    }
    if (result.recovered) {
      const previous = this.sessions.get(input.runtimeId);
      this.sessions.set(input.runtimeId, { identity: { ...input }, scope, externalExecutionRef: previous?.externalExecutionRef });
    }
    return result;
  }

  async submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> {
    validateProviderSubmitInput(input);
    this.requireActive(input, 'submit');
    const request = this.options.codec.encodeSubmit(input, this.options.binding, this.options.routeRef);
    const result = await this.callTransport('submit', input, () => this.options.transport.submit(input, request));
    validateProviderSubmitResult(result);
    assertProviderExecutionIdentityMatch(result, input);
    return result;
  }

  async *observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent> {
    validateProviderObserveInput(input);
    const active = this.requireActive(input, 'observe');
    if (!this.options.transport.observe) {
      throw new ProviderAdapterError({
        code: 'missing.observe',
        category: 'validation',
        phase: 'observe',
        message: 'provider transport does not expose an event stream',
        scope: input,
      });
    }
    try {
      for await (const raw of this.options.transport.observe(input)) {
        const decoded: ProviderDecodedEvent = this.options.codec.decodeEvent(raw, { execution: active.identity, scope: active.scope });
        for (const event of decoded.events) {
          validateProviderEvent(event);
          assertProviderEventEpoch(event, input.executionEpoch);
          assertProviderExecutionIdentityMatch(event, input);
          yield event;
        }
      }
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError({
        code: 'transport.failure',
        category: 'transport',
        phase: 'observe',
        message: error instanceof Error ? error.message : 'provider transport observe failed',
        scope: active.scope ?? input,
        cause: error,
      });
    }
  }

  async requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt> {
    validateProviderStopRequest(input);
    this.requireActive(input, 'stop');
    const request = this.options.codec.encodeStop(input, this.options.binding, this.options.routeRef);
    const receipt = await this.callTransport('stop', input, () => this.options.transport.requestStop(input, request));
    validateProviderStopReceipt(receipt);
    assertProviderExecutionIdentityMatch(receipt, input);
    return receipt;
  }

  async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
    validateProviderSettleInput(input);
    this.requireActive(input, 'settle');
    const result = await this.callTransport('settle', input, () => this.options.transport.settle(input));
    validateProviderSettlement(result);
    assertProviderExecutionIdentityMatch(result, input);
    if (this.isFinalSettlement(result)) this.sessions.delete(input.runtimeId);
    return result;
  }

  async close(binding: ProviderBinding): Promise<ProviderCloseResult> {
    this.assertSameBinding(binding, 'close');
    const result = await this.callTransport('close', binding, () => this.options.transport.close(binding));
    validateProviderCloseResult(result);
    if (result.bindingId !== binding.bindingId || result.providerId !== binding.providerId || result.protocol !== binding.protocol) {
      throw new ProviderAdapterError({
        code: 'close.binding.mismatch',
        category: 'protocol',
        phase: 'close',
        message: 'provider close result does not match binding identity',
        scope: binding,
      });
    }
    if (result.state === 'closed') this.sessions.clear();
    return result;
  }

  private requireActive(input: ProviderExecutionIdentityRef, phase: ProviderErrorPhase): ActiveExecution {
    const active = this.sessions.get(input.runtimeId);
    if (!active) {
      throw new ProviderAdapterError({
        code: 'missing.active.execution',
        category: 'runtime',
        phase,
        message: 'provider operation has no active execution scope',
        scope: input,
      });
    }
    if (!sameExecutionIdentity(active.identity, input)) {
      throw new ProviderAdapterError({
        code: 'runtime.identity.mismatch',
        category: 'runtime',
        phase,
        message: 'provider operation does not match active execution identity',
        scope: input,
      });
    }
    return active;
  }

  private isFinalSettlement(result: ProviderSettlement): boolean {
    return (result.state === 'succeeded' || result.state === 'stopped' || result.state === 'cancelled')
      && result.resourceRelease.state === 'released'
      && result.persistence.state === 'committed';
  }

  private async callTransport<T>(
    phase: ProviderErrorPhase,
    scope: ProviderBinding | ProviderExecutionIdentityRef | ScopeRef,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError({
        code: 'transport.failure',
        category: 'transport',
        phase,
        message: error instanceof Error ? error.message : 'provider transport call failed',
        scope,
        cause: error,
      });
    }
  }

  private assertExternalEvidenceMatches(ref: EvidenceRef, execution: ProviderExecutionIdentityRef, scope: ScopeRef, phase: ProviderErrorPhase): void {
    if (ref.scope.organId.value !== scope.organId.value) {
      throw new ProviderAdapterError({
        code: 'external.binding.scope.mismatch',
        category: 'protocol',
        phase,
        message: 'provider external execution binding does not match organ',
        scope: execution,
      });
    }
    if (ref.scope.taskId && ref.scope.taskId.value !== execution.taskId.value) {
      throw new ProviderAdapterError({
        code: 'external.binding.scope.mismatch',
        category: 'protocol',
        phase,
        message: 'provider external execution binding does not match task',
        scope: execution,
      });
    }
    if (ref.scope.operationId && ref.scope.operationId.value !== execution.operationId.value) {
      throw new ProviderAdapterError({
        code: 'external.binding.scope.mismatch',
        category: 'protocol',
        phase,
        message: 'provider external execution binding does not match operation',
        scope: execution,
      });
    }
    if (ref.scope.cycleId && scope.cycleId && ref.scope.cycleId.value !== scope.cycleId.value) {
      throw new ProviderAdapterError({
        code: 'external.binding.scope.mismatch',
        category: 'protocol',
        phase,
        message: 'provider external execution binding does not match cycle',
        scope: execution,
      });
    }
  }

  private assertSameBinding(binding: ProviderBinding, phase: ProviderErrorPhase): void {
    validateProviderBinding(binding);
    if (!sameProviderBinding(binding, this.options.binding)) {
      throw new ProviderAdapterError({
        code: 'binding.mismatch',
        category: 'protocol',
        phase,
        message: 'provider binding identity does not match adapter binding',
        scope: binding,
      });
    }
  }
}
