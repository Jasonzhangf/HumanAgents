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
import type { ProviderEvidenceSink } from './evidence.js';
import { ProviderAdapterError } from './errors.js';
import type { ProviderWireEvent, ProviderWireRequest, ProviderWireStopRequest } from './wire.js';

export interface ProviderTransport {
  readonly readiness?: ProviderReadiness;
  readonly capabilities?: ProviderCapabilities;
  readonly probe?: (binding: ProviderBinding) => Promise<ProviderProbeResult>;
  start(input: ProviderStartInput, request: ProviderWireRequest): Promise<ProviderStartReceipt>;
  resume(input: ProviderResumeInput, request: ProviderWireRequest): Promise<ProviderRecoveryResult>;
  submit(input: ProviderSubmitInput, request: ProviderWireRequest): Promise<ProviderSubmitResult>;
  observe(input: ProviderObserveInput): AsyncIterable<ProviderWireEvent>;
  requestStop(input: ProviderStopRequest, request: ProviderWireStopRequest): Promise<ProviderStopReceipt>;
  settle(input: ProviderSettleInput): Promise<ProviderSettlement>;
  close(binding: ProviderBinding): Promise<ProviderCloseResult>;
}

export interface ProviderProbeResult {
  readonly readiness: ProviderReadiness;
  readonly capabilities?: ProviderCapabilities;
}

export interface ProviderAdapterOptions {
  readonly binding: ProviderBinding;
  readonly routeRef: string;
  readonly codec: ProviderCodec;
  readonly transport: ProviderTransport;
  readonly evidence: ProviderEvidenceSink;
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

function executionKey(execution: ProviderExecutionIdentityRef): string {
  return `${execution.runtimeId}:${execution.taskId.value}:${execution.operationId.value}:${execution.executionEpoch}`;
}

function probeExpired(result: ProviderProbeResult): boolean {
  try {
    assertNotExpired(result.readiness.expiresAt);
    if (result.capabilities) assertNotExpired(result.capabilities.expiresAt);
    return false;
  } catch {
    return true;
  }
}

interface ActiveExecution {
  readonly identity: ProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly externalExecutionRef?: EvidenceRef;
}

function scopeFromEvidence(input: ProviderStartInput | ProviderResumeInput, phase: ProviderErrorPhase): ScopeRef {
  const ref = input.evidenceRefs[0];
  if (!ref) {
    throw new ProviderAdapterError({
      code: 'missing.scope.evidence',
      category: 'validation',
      phase,
      message: 'provider execution requires evidence scope for operation projection',
      scope: input,
    });
  }
  return { ...ref.scope, taskId: input.taskId, operationId: input.operationId };
}

export class ProviderAdapter implements ExecutionRuntimePort {
  readonly kind = 'humanagent.execution-runtime-port' as const;

  private readonly sessions = new Map<string, ActiveExecution>();
  private lastProbe?: { readonly binding: ProviderBinding; readonly result: ProviderProbeResult };

  constructor(private readonly options: ProviderAdapterOptions) {
    try {
      validateProviderBinding(options.binding);
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError({
        code: 'provider.adapter.failure',
        category: 'validation',
        phase: 'start',
        message: error instanceof Error ? error.message : 'provider binding validation failed',
        scope: options.binding,
        cause: error,
      });
    }
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
    if (
      options.binding.protocol !== 'responses'
      && options.binding.protocol !== 'anthropic'
      && options.binding.protocol !== 'openai'
    ) {
      throw new ProviderAdapterError({
        code: 'capability.unavailable',
        category: 'capability',
        phase: 'start',
        message: 'provider adapter currently requires an explicit responses, openai, or anthropic binding',
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
    if (!options.evidence) {
      throw new ProviderAdapterError({
        code: 'missing.evidence',
        category: 'validation',
        phase: 'start',
        message: 'provider adapter requires an evidence sink for immutable wire content',
        scope: options.binding,
      });
    }
  }

  async probe(binding: ProviderBinding): Promise<ProviderReadiness> {
    return this.guard('probe', binding, async () => {
      this.assertSameBinding(binding, 'probe');
      const readiness = (await this.loadProbe(binding, true)).readiness;
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
    });
  }

  async capabilities(binding: ProviderBinding): Promise<ProviderCapabilities> {
    return this.guard('probe', binding, async () => {
      this.assertSameBinding(binding, 'probe');
      const capabilities = (await this.loadProbe(binding, false)).capabilities;
      if (!capabilities) {
        throw new ProviderAdapterError({
          code: 'capability.unavailable',
          category: 'capability',
          phase: 'probe',
          message: 'provider capabilities are unavailable for the current binding',
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
    });
  }

  private async loadProbe(binding: ProviderBinding, refresh: boolean): Promise<ProviderProbeResult> {
    if (this.options.transport.probe) {
      const cached = this.lastProbe;
      if (cached && sameProviderBinding(cached.binding, binding) && !refresh && !probeExpired(cached.result)) return cached.result;
      const result = await this.callTransport('probe', binding, () => this.options.transport.probe!(binding));
      this.lastProbe = { binding: { ...binding }, result };
      return result;
    }
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
    return { readiness, capabilities: this.options.transport.capabilities };
  }

  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    return this.guard('start', input, async () => {
      validateProviderStartInput(input);
      const key = executionKey(input);
      if (this.sessions.has(key)) {
        throw new ProviderAdapterError({
          code: 'runtime.already.started',
          category: 'runtime',
          phase: 'start',
          message: 'provider execution instance is already active',
          scope: input,
        });
      }
      const scope = scopeFromEvidence(input, 'start');
      const request = this.options.codec.encodeStart(input, this.options.binding, this.options.routeRef);
      const receipt = await this.callTransport('start', input, () => this.options.transport.start(input, request));
      validateProviderStartReceipt(receipt);
      assertProviderExecutionIdentityMatch(receipt, input);
      if (receipt.externalExecutionRef) this.assertExternalEvidenceMatches(receipt.externalExecutionRef, input, scope, 'start');
      if (this.sessions.has(key)) {
        throw new ProviderAdapterError({
          code: 'runtime.already.started',
          category: 'runtime',
          phase: 'start',
          message: 'provider execution instance activated concurrently',
          scope: input,
        });
      }
      this.sessions.set(key, { identity: { ...input }, scope, externalExecutionRef: receipt.externalExecutionRef });
      return receipt;
    });
  }

  async resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> {
    return this.guard('resume', input, async () => {
      validateProviderResumeInput(input);
      const existing = this.sessions.get(executionKey(input));
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
      const scope = scopeFromEvidence(input, 'resume');
      const request = this.options.codec.encodeResume(input, this.options.binding, this.options.routeRef);
      const result = await this.callTransport('resume', input, () => this.options.transport.resume(input, request));
      validateProviderRecoveryResult(result);
      assertProviderExecutionIdentityMatch(result, input);
      if (result.checkpointId.value !== input.checkpointId.value) {
        throw new ProviderAdapterError({
          code: 'resume.checkpoint.mismatch',
          category: 'protocol',
          phase: 'resume',
          message: 'provider recovery result checkpoint does not match resume request',
          scope: input,
        });
      }
      this.assertEvidenceScopeMatchesExecution(result.recoveryStateRef, input, scope, 'resume', 'recovery state');
      for (const ref of result.evidenceRefs) {
        this.assertEvidenceScopeMatchesExecution(ref, input, scope, 'resume', 'recovery evidence');
      }
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
        const previous = this.sessions.get(executionKey(input));
        this.sessions.set(executionKey(input), { identity: { ...input }, scope, externalExecutionRef: previous?.externalExecutionRef });
      }
      return result;
    });
  }

  async submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> {
    return this.guard('submit', input, async () => {
      validateProviderSubmitInput(input);
      this.requireActive(input, 'submit');
      const request = this.options.codec.encodeSubmit(input, this.options.binding, this.options.routeRef);
      const result = await this.callTransport('submit', input, () => this.options.transport.submit(input, request));
      validateProviderSubmitResult(result);
      assertProviderExecutionIdentityMatch(result, input);
      return result;
    });
  }

  async *observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent> {
    this.guardSync('observe', input, () => validateProviderObserveInput(input));
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
    let sequence = 0;
    const context = {
      execution: active.identity,
      scope: active.scope,
      evidence: this.options.evidence,
      responsesOutputText: new Map<string, string>(),
      nextEventId: (type: string, locator: string) => `event-${type}-${locator.replace(/[^A-Za-z0-9._-]/g, '-')}-${++sequence}`,
    };
    try {
      for await (const raw of this.options.transport.observe(input)) {
        const decoded: ProviderDecodedEvent = await this.guard('observe', active.identity, async () => this.options.codec.decodeEvent(raw, context));
        for (const event of decoded.events) {
          this.guardSync('observe', active.identity, () => {
            validateProviderEvent(event);
            assertProviderEventEpoch(event, input.executionEpoch);
            assertProviderExecutionIdentityMatch(event, input);
          });
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
    return this.guard('stop', input, async () => {
      validateProviderStopRequest(input);
      this.requireActive(input, 'stop');
      const request = this.options.codec.encodeStop(input, this.options.binding, this.options.routeRef);
      const receipt = await this.callTransport('stop', input, () => this.options.transport.requestStop(input, request));
      validateProviderStopReceipt(receipt);
      assertProviderExecutionIdentityMatch(receipt, input);
      return receipt;
    });
  }

  async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
    return this.guard('settle', input, async () => {
      validateProviderSettleInput(input);
      const active = this.requireActive(input, 'settle');
      const result = await this.callTransport('settle', input, () => this.options.transport.settle(input));
      validateProviderSettlement(result);
      assertProviderExecutionIdentityMatch(result, input);
      assertProviderExecutionIdentityMatch(result, active.identity);
      if (this.isFinalSettlement(result)) this.sessions.delete(executionKey(input));
      return result;
    });
  }

  async close(binding: ProviderBinding): Promise<ProviderCloseResult> {
    return this.guard('close', binding, async () => {
      this.assertSameBinding(binding, 'close');
      if (this.sessions.size > 0) {
        throw new ProviderAdapterError({
          code: 'close.pending.executions',
          category: 'runtime',
          phase: 'close',
          message: 'provider close rejected while active executions require settlement or recovery',
          scope: binding,
        });
      }
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
    });
  }

  private requireActive(input: ProviderExecutionIdentityRef, phase: ProviderErrorPhase): ActiveExecution {
    const active = this.sessions.get(executionKey(input));
    if (!active) {
      const hasRuntimeInstance = [...this.sessions.values()].some((candidate) => candidate.identity.runtimeId === input.runtimeId);
      if (hasRuntimeInstance) {
        throw new ProviderAdapterError({
          code: 'runtime.identity.mismatch',
          category: 'runtime',
          phase,
          message: 'provider operation does not match active execution identity',
          scope: input,
        });
      }
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

  private guardSync<T>(
    phase: ProviderErrorPhase,
    scope: ProviderBinding | ProviderExecutionIdentityRef | ScopeRef,
    fn: () => T,
  ): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError({
        code: 'provider.adapter.failure',
        category: 'validation',
        phase,
        message: error instanceof Error ? error.message : 'provider adapter operation failed',
        scope,
        cause: error,
      });
    }
  }

  private async guard<T>(
    phase: ProviderErrorPhase,
    scope: ProviderBinding | ProviderExecutionIdentityRef | ScopeRef,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError({
        code: 'provider.adapter.failure',
        category: 'validation',
        phase,
        message: error instanceof Error ? error.message : 'provider adapter operation failed',
        scope,
        cause: error,
      });
    }
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

  private assertEvidenceScopeMatchesExecution(
    ref: EvidenceRef,
    execution: ProviderExecutionIdentityRef,
    scope: ScopeRef,
    phase: ProviderErrorPhase,
    label: string,
  ): void {
    if (ref.scope.organId.value !== scope.organId.value) {
      throw new ProviderAdapterError({
        code: 'evidence.binding.scope.mismatch',
        category: 'protocol',
        phase,
        message: `${label} does not match organ scope`,
        scope: execution,
      });
    }
    if (ref.scope.taskId && ref.scope.taskId.value !== execution.taskId.value) {
      throw new ProviderAdapterError({
        code: 'evidence.binding.scope.mismatch',
        category: 'protocol',
        phase,
        message: `${label} does not match task scope`,
        scope: execution,
      });
    }
    if (ref.scope.operationId && ref.scope.operationId.value !== execution.operationId.value) {
      throw new ProviderAdapterError({
        code: 'evidence.binding.scope.mismatch',
        category: 'protocol',
        phase,
        message: `${label} does not match operation scope`,
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
