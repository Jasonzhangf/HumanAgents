import {
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

  private readonly sessions = new Map<string, ScopeRef>();

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
    const receipt = await this.options.transport.start(input, request);
    validateProviderStartReceipt(receipt);
    assertProviderExecutionIdentityMatch(receipt, input);
    this.sessions.set(input.runtimeId, scope);
    return receipt;
  }

  async resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
    validateProviderResumeInput(input);
    const existing = this.sessions.get(input.runtimeId);
    if (existing) {
      if (existing.taskId?.value !== input.taskId.value || existing.operationId?.value !== input.operationId.value) {
        throw new ProviderAdapterError({
          code: 'resume.scope.mismatch',
          category: 'protocol',
          phase: 'resume',
          message: 'provider resume input does not match active execution scope',
          scope: input,
        });
      }
    }
    const scope = scopeFromEvidence(input);
    const request = this.options.codec.encodeResume(input, this.options.binding, this.options.routeRef);
    const result = await this.options.transport.resume(input, request);
    validateProviderRecoveryResult(result);
    assertProviderExecutionIdentityMatch(result, input);
    if (result.recovered) this.sessions.set(input.runtimeId, scope);
    return result;
  }

  async submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> {
    validateProviderSubmitInput(input);
    this.requireScope(input);
    const request = this.options.codec.encodeSubmit(input, this.options.binding, this.options.routeRef);
    const result = await this.options.transport.submit(input, request);
    validateProviderSubmitResult(result);
    assertProviderExecutionIdentityMatch(result, input);
    return result;
  }

  async *observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent> {
    validateProviderObserveInput(input);
    const scope = this.requireScope(input);
    if (!this.options.transport.observe) {
      throw new ProviderAdapterError({
        code: 'missing.observe',
        category: 'validation',
        phase: 'observe',
        message: 'provider transport does not expose an event stream',
        scope: input,
      });
    }
    for await (const raw of this.options.transport.observe(input)) {
      const decoded: ProviderDecodedEvent = this.options.codec.decodeEvent(raw, { execution: input, scope });
      for (const event of decoded.events) {
        validateProviderEvent(event);
        assertProviderEventEpoch(event, input.executionEpoch);
        assertProviderExecutionIdentityMatch(event, input);
        yield event;
      }
    }
  }

  async requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt> {
    validateProviderStopRequest(input);
    this.requireScope(input);
    const request = this.options.codec.encodeStop(input, this.options.binding, this.options.routeRef);
    const receipt = await this.options.transport.requestStop(input, request);
    validateProviderStopReceipt(receipt);
    assertProviderExecutionIdentityMatch(receipt, input);
    return receipt;
  }

  async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
    validateProviderSettleInput(input);
    this.requireScope(input);
    const result = await this.options.transport.settle(input);
    validateProviderSettlement(result);
    assertProviderExecutionIdentityMatch(result, input);
    this.sessions.delete(input.runtimeId);
    return result;
  }

  async close(binding: ProviderBinding): Promise<ProviderCloseResult> {
    this.assertSameBinding(binding, 'close');
    const result = await this.options.transport.close(binding);
    validateProviderCloseResult(result);
    return result;
  }

  private requireScope(input: ProviderExecutionIdentityRef): ScopeRef {
    const scope = this.sessions.get(input.runtimeId);
    if (!scope) {
      throw new ProviderAdapterError({
        code: 'missing.active.execution',
        category: 'runtime',
        phase: 'observe',
        message: 'provider operation has no active execution scope',
        scope: input,
      });
    }
    return scope;
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
