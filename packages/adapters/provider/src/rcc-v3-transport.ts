import {
  id,
  type EvidenceRef,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderError,
  type ProviderExecutionIdentityRef,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderObserveInput,
  type ProviderResumeInput,
  type ProviderSettleInput,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { ProviderAdapterError } from './errors.js';
import type { ProviderEvidenceSink } from './evidence.js';
import type {
  AnthropicWireRequest,
  ProviderWireEvent,
  ProviderWireRequest,
  ProviderWireStopRequest,
  ResponsesWireRequest,
} from './wire.js';
import type { ProviderProbeResult, ProviderTransport } from './adapter.js';

const OWNER = 'humanagent.provider-adapter.rcc-v3';
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROBE_TTL_MS = 5 * 60 * 1000;

export interface RccV3FetchInit {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface RccV3FetchResponse {
  readonly status: number;
  readonly headers?: { readonly get: (name: string) => string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
  readonly text: () => Promise<string>;
}

export type RccV3Fetch = (url: string, init: RccV3FetchInit) => Promise<RccV3FetchResponse>;

export interface RccV3ProviderTransportOptions {
  readonly binding: ProviderBinding;
  readonly baseUrl: string;
  readonly evidence: ProviderEvidenceSink;
  readonly fetch?: RccV3Fetch;
  readonly maxEventBytes?: number;
  readonly maxBufferBytes?: number;
  readonly probeTtlMs?: number;
  readonly now?: () => Date;
}

interface ActiveExecution {
  readonly identity: ProviderExecutionIdentityRef;
  readonly controller: AbortController;
  readonly body: AsyncIterable<Uint8Array>;
  readonly protocol: 'responses' | 'anthropic';
  readonly route: string;
  readonly model: string;
  readonly evidenceScope: ScopeRef;
  stopRequested: boolean;
  stopCause?: unknown;
  observed: boolean;
  streamDone: boolean;
  resourceReleased: boolean;
  terminalState?: 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'stopped' | 'unknown';
  terminalError?: ProviderError;
}

interface SseFrame {
  readonly event?: string;
  readonly data: string;
}

function defaultFetch(url: string, init: RccV3FetchInit): Promise<RccV3FetchResponse> {
  return globalThis.fetch(url, init as RequestInit).then(async (response) => ({
    status: response.status,
    headers: response.headers,
    body: response.body ? readableStreamToAsyncIterable(response.body) : null,
    text: () => response.text(),
  }));
}

async function* readableStreamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    try {
      if (!completed) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

function executionKey(execution: ProviderExecutionIdentityRef): string {
  return `${execution.runtimeId}:${execution.taskId.value}:${execution.operationId.value}:${execution.executionEpoch}`;
}

function scopeFor(execution: ProviderExecutionIdentityRef, scope?: ScopeRef): ScopeRef {
  return {
    ...(scope ?? { organId: id('organ', 'provider-adapter') }),
    taskId: execution.taskId,
    operationId: execution.operationId,
  };
}

function protocolOf(request: ProviderWireRequest): 'responses' | 'anthropic' {
  if (request.protocol === 'responses' || request.protocol === 'anthropic') return request.protocol;
  throw new ProviderAdapterError({
    code: 'capability.unavailable',
    category: 'capability',
    phase: 'start',
    message: 'RCC v3 does not implement the requested provider protocol',
  });
}

function endpointPath(protocol: 'responses' | 'anthropic'): string {
  return protocol === 'responses' ? '/v1/responses' : '/v1/messages';
}

function requestRoute(request: ProviderWireRequest): string {
  const route = request.route;
  if (typeof route !== 'string' || route.trim() === '') {
    throw new ProviderAdapterError({
      code: 'missing.route',
      category: 'configuration',
      phase: 'start',
      message: 'RCC v3 transport requires an explicit provider route binding on the wire request',
    });
  }
  return route;
}

function errorEvidence(scope: ScopeRef, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `rcc-v3-${label.replace(/[^A-Za-z0-9._-]/g, '-')}`),
    kind: 'external',
    source: OWNER,
    locator: `rcc-v3://${label}`,
    scope,
  };
}

function providerError(
  scope: ScopeRef,
  phase: ProviderError['phase'],
  code: string,
  message: string,
  category: ProviderError['category'] = 'transport',
  nextAction: ProviderError['nextAction'] = { kind: 'recover', ref: OWNER },
): ProviderError {
  return {
    errorId: `provider.${phase}.${code}`,
    code,
    category,
    phase,
    message,
    ownerId: OWNER,
    retryable: category === 'transport' || category === 'timeout' ? 'retryable' : 'manual',
    attention: 'foreground',
    evidenceRefs: [errorEvidence(scope, `${phase}-${code}`)],
    nextAction,
  };
}

function isTerminalEvent(protocol: 'responses' | 'anthropic', type: string): boolean {
  return protocol === 'responses'
    ? ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(type)
    : ['message_stop', 'error'].includes(type);
}

// The provider protocol owns the terminal state. RCC transport only records the
// already-decoded terminal fact and never rewrites a provider waiting/blocked
// outcome into succeeded.
function terminalStateFor(
  protocol: 'responses' | 'anthropic',
  type: string,
  stopReason: string | undefined,
  stopRequested: boolean,
): ActiveExecution['terminalState'] {
  if (protocol === 'responses') {
    if (type === 'response.incomplete') return 'waiting';
    return stopRequested ? 'stopped' : 'succeeded';
  }
  const providerState = stopReason === 'tool_use' || stopReason === 'max_tokens' || stopReason === 'pause_turn'
    ? 'waiting'
    : stopReason === 'end_turn' || stopReason === 'stop_sequence' ? 'succeeded' : 'unknown';
  if (providerState === 'waiting') return 'waiting';
  return stopRequested ? 'stopped' : providerState;
}

function isExpectedStopAbort(cause: unknown, active: ActiveExecution): boolean {
  if (!active.stopRequested || !active.controller.signal.aborted) return false;
  if (cause === active.stopCause || cause === active.controller.signal.reason) return true;
  return cause instanceof DOMException && cause.name === 'AbortError';
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RCC v3 SSE data must be a JSON object');
  }
  return value as Record<string, unknown>;
}

async function* parseSse(
  body: AsyncIterable<Uint8Array>,
  maxEventBytes: number,
  maxBufferBytes: number,
): AsyncIterable<SseFrame> {
  const decoder = new TextDecoder();
  const iterator = body[Symbol.asyncIterator]();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  const emit = (): SseFrame | undefined => {
    if (event === undefined && data.length === 0) return undefined;
    const frame = { event, data: data.join('\n') };
    event = undefined;
    data = [];
    return frame;
  };

  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (buffer.length > maxBufferBytes) throw new Error('RCC v3 SSE buffer exceeded limit');
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0) {
        let line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const frame = emit();
          if (frame) yield frame;
        } else if (!line.startsWith(':')) {
          const separator = line.indexOf(':');
          const field = separator < 0 ? line : line.slice(0, separator);
          let value = separator < 0 ? '' : line.slice(separator + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') event = value;
          if (field === 'data') {
            data.push(value);
            if (data.join('\n').length > maxEventBytes) throw new Error('RCC v3 SSE event exceeded limit');
          }
        }
        boundary = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > maxBufferBytes) throw new Error('RCC v3 SSE buffer exceeded limit');
    if (buffer.length > 0) throw new Error('RCC v3 SSE stream ended with an incomplete frame');
    const frame = emit();
    if (frame) yield frame;
  } finally {
    await iterator.return?.();
  }
}

function responsesPayload(request: ResponsesWireRequest): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.instructions,
    input: request.input.map((item) => item.type === 'message'
      ? { type: 'message', role: item.role, content: [{ type: 'input_text', text: item.content }] }
      : { type: 'function_call_output', call_id: item.call_id, output: item.output }),
    ...(request.tools ? {
      tools: request.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    } : {}),
    stream: true,
  };
}

function anthropicPayload(request: AnthropicWireRequest): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: request.max_tokens,
    ...(request.system ? { system: request.system } : {}),
    messages: request.messages,
    ...(request.tools ? { tools: request.tools } : {}),
    stream: true,
  };
}

function requestPayload(request: ProviderWireRequest): Record<string, unknown> {
  return request.protocol === 'responses' ? responsesPayload(request) : anthropicPayload(request);
}

function urlFor(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/$/, '')}/`).toString();
}

export class RccV3ProviderTransport implements ProviderTransport {
  readonly readiness?: ProviderReadiness;
  readonly capabilities?: ProviderCapabilities;
  private readonly fetcher: RccV3Fetch;
  private readonly maxEventBytes: number;
  private readonly maxBufferBytes: number;
  private readonly probeTtlMs: number;
  private readonly now: () => Date;
  private readonly executions = new Map<string, ActiveExecution>();
  private readonly stopReasons = new Map<ProviderExecutionIdentityRef, string>();

  constructor(private readonly options: RccV3ProviderTransportOptions) {
    if (options.binding.protocol !== 'responses' && options.binding.protocol !== 'anthropic') {
      throw new ProviderAdapterError({
        code: 'capability.unavailable',
        category: 'capability',
        phase: 'start',
        message: `RCC v3 transport does not support ${options.binding.protocol}`,
        scope: options.binding,
      });
    }
    try {
      new URL(`${options.baseUrl.replace(/\/$/, '')}/`);
    } catch (cause) {
      throw new ProviderAdapterError({
        code: 'configuration.invalid.endpoint',
        category: 'configuration',
        phase: 'start',
        message: 'RCC v3 transport requires an absolute base URL',
        scope: options.binding,
        cause,
      });
    }
    if (!options.evidence) {
      throw new ProviderAdapterError({
        code: 'missing.evidence',
        category: 'validation',
        phase: 'start',
        message: 'RCC v3 transport requires an immutable evidence sink',
        scope: options.binding,
      });
    }
    this.fetcher = options.fetch ?? defaultFetch;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.probeTtlMs = options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  async probe(binding: ProviderBinding): Promise<ProviderProbeResult> {
    this.assertBinding(binding);
    const checkedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.probeTtlMs).toISOString();
    const health = await this.probeHealth(binding);
    if (!health.ok) {
      return { readiness: readiness(binding, health.state, checkedAt, expiresAt, [health.evidence], health.error, health.version) };
    }

    const models = await this.probeModels(binding);
    let evidenceRefs = [health.evidence, models.evidence];
    if (models.ok && !models.models.includes(binding.modelRef)) {
      const ref = await this.writeEvidence(scopeForBinding(binding), 'probe-model-unavailable', { model: binding.modelRef, models: models.models });
      evidenceRefs = [...evidenceRefs, ref];
    }

    return { readiness: readiness(binding, 'ready', checkedAt, expiresAt, evidenceRefs, undefined, health.version) };
  }

  async start(input: ProviderStartInput, request: ProviderWireRequest): Promise<ProviderStartReceipt> {
    const key = executionKey(input);
    if (this.executions.has(key)) {
      throw new ProviderAdapterError({ code: 'runtime.already.started', category: 'runtime', phase: 'start', message: 'RCC v3 execution is already active', scope: input });
    }
    const protocol = protocolOf(request);
    this.assertProtocol(protocol);
    const route = requestRoute(request);
    const controller = new AbortController();
    const response = await this.send(protocol, request, controller);
    const body = response.body;
    if (!body) {
      controller.abort('RCC v3 start returned no streaming body');
      throw new ProviderAdapterError({ code: 'transport.empty.body', category: 'transport', phase: 'start', message: 'RCC v3 returned no streaming body', scope: input });
    }
    const evidenceScope = scopeFor(input, input.evidenceRefs[0]?.scope);
    const execution: ActiveExecution = {
      identity: { ...input },
      controller,
      body,
      protocol,
      route,
      model: request.model,
      evidenceScope,
      stopRequested: false,
      observed: false,
      streamDone: false,
      resourceReleased: false,
    };
    let ref: EvidenceRef;
    try {
      ref = await this.writeEvidence(evidenceScope, 'start', {
        status: response.status,
        endpoint: endpointPath(protocol),
        protocol,
        model: request.model,
        route,
      });
    } catch (cause) {
      controller.abort('RCC v3 start evidence persistence failed');
      throw cause;
    }
    this.executions.set(key, execution);
    return { ...input, startedAt: new Date().toISOString(), evidenceRefs: [ref] };
  }

  async resume(input: ProviderResumeInput, _request: ProviderWireRequest): Promise<ProviderRecoveryResult> {
    const scope = scopeFor(input, input.evidenceRefs[0]?.scope);
    const error = providerError(scope, 'resume', 'resume.unsupported', 'RCC v3 HTTP transport cannot resume a provider stream from a HumanAgent checkpoint', 'capability', { kind: 'recover', ref: OWNER });
    const ref = await this.writeEvidence(scope, 'resume-unsupported', error);
    return {
      ...input,
      checkpointId: input.checkpointId,
      recovered: false,
      staleRejected: false,
      recoveryStateRef: ref,
      evidenceRefs: [ref],
      error: { ...error, evidenceRefs: [ref] },
      ownerId: OWNER,
      nextAction: { kind: 'recover', ref: OWNER },
    };
  }

  async submit(input: ProviderSubmitInput, _request: ProviderWireRequest): Promise<ProviderSubmitResult> {
    const scope = scopeFor(input, input.evidenceRefs[0]?.scope);
    const error = providerError(scope, 'submit', 'submit.unsupported', 'RCC v3 transport has no provider-neutral tool submit endpoint', 'capability');
    const ref = await this.writeEvidence(scope, 'submit-unsupported', error);
    return { ...input, status: 'blocked', outputRefs: [], evidenceRefs: [ref], error: { ...error, evidenceRefs: [ref] }, ownerId: OWNER, nextAction: { kind: 'recover', ref: OWNER } };
  }

  async *observe(input: ProviderObserveInput): AsyncIterable<ProviderWireEvent> {
    const active = this.active(input);
    if (active.observed) throw new ProviderAdapterError({ code: 'runtime.observe.repeated', category: 'runtime', phase: 'observe', message: 'RCC v3 stream can only be observed once', scope: input });
    active.observed = true;
    let completed = false;
    let failed = false;
    try {
      for await (const frame of parseSse(active.body, this.maxEventBytes, this.maxBufferBytes)) {
        if (!frame.data || frame.data === '[DONE]') continue;
        let record: Record<string, unknown>;
        try {
          record = readRecord(JSON.parse(frame.data));
        } catch (cause) {
          const error = providerError(active.evidenceScope, 'observe', 'protocol.invalid-sse-json', cause instanceof Error ? cause.message : 'RCC v3 returned invalid SSE JSON', 'protocol');
          active.terminalError = error;
          active.terminalState = 'failed';
          throw new ProviderAdapterError({ code: error.code, category: 'protocol', phase: 'observe', message: error.message, scope: input, cause });
        }
        const type = typeof record.type === 'string' ? record.type : frame.event;
        if (!type) throw new ProviderAdapterError({ code: 'protocol.missing-event-type', category: 'protocol', phase: 'observe', message: 'RCC v3 SSE event has no type', scope: input });
        if (active.protocol === 'responses' && type === 'response.done') continue;
        const raw = { protocol: active.protocol, ...record, type } as unknown as ProviderWireEvent;
        if (isTerminalEvent(active.protocol, type)) {
          if (type === 'error' || type.endsWith('.failed')) {
            const errorRecord = type.endsWith('.failed')
              ? (readRecord(record.response).error ?? {})
              : (record.error ?? {});
            const providerCode = typeof errorRecord === 'object' && errorRecord && typeof (errorRecord as Record<string, unknown>).code === 'string'
              ? (errorRecord as Record<string, unknown>).code as string
              : typeof errorRecord === 'object' && errorRecord && typeof (errorRecord as Record<string, unknown>).type === 'string'
                ? (errorRecord as Record<string, unknown>).type as string
                : 'provider.failed';
            const providerMessage = typeof errorRecord === 'object' && errorRecord && typeof (errorRecord as Record<string, unknown>).message === 'string'
              ? (errorRecord as Record<string, unknown>).message as string
              : 'RCC v3 provider reported a failure';
            active.terminalError = providerError(active.evidenceScope, 'observe', providerCode, providerMessage, 'provider');
            active.terminalState = 'failed';
          } else {
            const stopReason = active.protocol === 'anthropic' && type === 'message_stop'
              ? this.anthropicStopReason(active)
              : undefined;
            active.terminalState = terminalStateFor(active.protocol, type, stopReason, active.stopRequested);
          }
        }
        if (active.protocol === 'anthropic' && type === 'message_delta') {
          const delta = readRecord(record.delta);
          if (typeof delta.stop_reason === 'string') this.stopReasons.set(active.identity, delta.stop_reason);
        }
        yield raw;
      }
      if (!active.terminalState) {
        const error = providerError(active.evidenceScope, 'observe', 'stream.missing-terminal', 'RCC v3 SSE stream ended without a terminal event', 'protocol');
        active.terminalError = error;
        active.terminalState = 'failed';
        throw new ProviderAdapterError({ code: error.code, category: 'protocol', phase: 'observe', message: error.message, scope: input });
      }
      active.streamDone = true;
      active.resourceReleased = true;
      completed = true;
    } catch (cause) {
      active.streamDone = true;
      if (isExpectedStopAbort(cause, active)) {
        if (!active.terminalError) active.terminalState = 'stopped';
        active.resourceReleased = true;
        return;
      } else if (!active.terminalError) {
        const errorMessage = cause instanceof Error ? cause.message : 'RCC v3 stream failed';
        active.terminalError = providerError(active.evidenceScope, 'observe', 'transport.failure', errorMessage, 'transport');
        active.terminalState = 'failed';
      }
      failed = true;
      throw cause;
    } finally {
      if (!completed) {
        if (!failed) {
          if (!active.controller.signal.aborted) {
            active.controller.abort(new DOMException('RCC v3 observe consumer stopped before stream completion', 'AbortError'));
          }
          active.resourceReleased = true;
        }
        active.streamDone = true;
        if (!active.terminalState && !active.terminalError) {
          active.terminalState = 'blocked';
          active.terminalError = providerError(
            active.evidenceScope,
            'observe',
            'observe.consumer-returned-early',
            'RCC v3 stream was cancelled before it reached a provider terminal state',
            'runtime',
          );
        }
      }
    }
  }

  async requestStop(input: ProviderStopRequest, _request: ProviderWireStopRequest): Promise<ProviderStopReceipt> {
    const active = this.active(input);
    const scope = active.evidenceScope;
    if (active.streamDone) {
      const error = providerError(scope, 'stop', 'stop.after-terminal', 'RCC v3 stream is already settled', 'runtime');
      const ref = await this.writeEvidence(scope, 'stop-rejected', error);
      return { ...input, status: 'rejected', receivedAt: new Date().toISOString(), evidenceRefs: [ref], error: { ...error, evidenceRefs: [ref] }, ownerId: OWNER, nextAction: { kind: 'continue' } };
    }
    active.stopRequested = true;
    active.stopCause = new DOMException(input.reason, 'AbortError');
    active.controller.abort(active.stopCause);
    const ref = await this.writeEvidence(scope, 'stop-requested', {
      remoteStopSupported: false,
      transportAbort: true,
      reason: input.reason,
      route: active.route,
      model: active.model,
    });
    return { ...input, status: 'accepted', receivedAt: new Date().toISOString(), evidenceRefs: [ref], ownerId: OWNER, nextAction: { kind: 'wait', ref: 'rcc-v3.settle' } };
  }

  async settle(input: ProviderSettleInput): Promise<ProviderSettlement> {
    const active = this.active(input);
    const scope = active.evidenceScope;
    const state = active.streamDone ? (active.terminalState ?? 'unknown') : 'waiting';
    const evidenceRef = await this.writeEvidence(scope, 'settle', {
      state,
      streamDone: active.streamDone,
      stopRequested: active.stopRequested,
      route: active.route,
      model: active.model,
    });
    if (state === 'waiting' && active.streamDone) {
      const error = await this.persistError(scope, providerError(
        scope,
        'settle',
        'capability.continuation-unavailable',
        'RCC v3 cannot continue a fully observed waiting execution: resume and submit are unsupported',
        'capability',
        { kind: 'recover', ref: OWNER },
      ));
      return {
        ...input,
        state: 'blocked',
        evidenceRefs: [evidenceRef],
        resourceRelease: { state: active.resourceReleased ? 'released' : 'pending', evidenceRefs: [evidenceRef] },
        persistence: { state: 'pending', evidenceRefs: [evidenceRef] },
        error,
        ownerId: OWNER,
        nextAction: { kind: 'recover' as const, ref: OWNER },
      };
    }
    if (state === 'waiting') {
      return {
        ...input,
        state,
        evidenceRefs: [evidenceRef],
        resourceRelease: { state: active.resourceReleased ? 'released' : 'pending', evidenceRefs: [evidenceRef] },
        persistence: { state: 'pending', evidenceRefs: [evidenceRef] },
        ownerId: OWNER,
        nextAction: { kind: 'continue', ref: 'rcc-v3.observe' },
      };
    }
    if (state === 'blocked' || state === 'failed' || state === 'unknown') {
      const error = await this.persistError(scope, active.terminalError ?? providerError(
        scope,
        'settle',
        'settle.requires-recovery',
        `RCC v3 settlement requires recovery for ${state}`,
        'runtime',
      ));
      return {
        ...input,
        state,
        evidenceRefs: [evidenceRef],
        resourceRelease: { state: active.resourceReleased ? 'released' : 'pending', evidenceRefs: [evidenceRef] },
        persistence: { state: 'pending', evidenceRefs: [evidenceRef] },
        error,
        ownerId: OWNER,
        nextAction: { kind: 'recover' as const, ref: OWNER },
      };
    }
    const settlement: ProviderSettlement = {
      ...input,
      state,
      evidenceRefs: [evidenceRef],
      resourceRelease: { state: 'released', evidenceRefs: [evidenceRef] },
      persistence: { state: 'committed', evidenceRefs: [evidenceRef] },
    };
    this.executions.delete(executionKey(input));
    return settlement;
  }

  async close(binding: ProviderBinding): Promise<ProviderCloseResult> {
    if (this.executions.size > 0) {
      const ref = errorEvidence({ organId: id('organ', 'provider-adapter') }, 'close-pending');
      return { bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol, state: 'pending', evidenceRefs: [ref], ownerId: OWNER, nextAction: { kind: 'continue', ref: 'rcc-v3.settle' } };
    }
    const scope = { organId: id('organ', 'provider-adapter') };
    const ref = await this.writeEvidence(scope, 'close', { endpoint: this.options.baseUrl, bindingId: binding.bindingId });
    return { bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol, state: 'closed', evidenceRefs: [ref] };
  }

  private active(input: ProviderExecutionIdentityRef): ActiveExecution {
    const active = this.executions.get(executionKey(input));
    if (!active) throw new ProviderAdapterError({ code: 'missing.active.execution', category: 'runtime', phase: 'observe', message: 'RCC v3 execution is not active', scope: input });
    return active;
  }

  private assertProtocol(protocol: 'responses' | 'anthropic'): void {
    if (protocol !== this.options.binding.protocol) throw new ProviderAdapterError({ code: 'protocol.mismatch', category: 'protocol', phase: 'start', message: 'RCC request protocol does not match binding', scope: this.options.binding });
  }

  private anthropicStopReason(active: ActiveExecution): string | undefined {
    const reason = this.stopReasons.get(active.identity);
    this.stopReasons.delete(active.identity);
    return reason;
  }

  private async send(protocol: 'responses' | 'anthropic', request: ProviderWireRequest, controller: AbortController): Promise<RccV3FetchResponse> {
    const response = await this.fetcher(urlFor(this.options.baseUrl, endpointPath(protocol)), {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify(requestPayload(request)),
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      const body = (await response.text()).slice(0, this.maxEventBytes);
      throw new ProviderAdapterError({ code: `http.${response.status}`, category: 'provider', phase: 'start', message: `RCC v3 returned HTTP ${response.status}${body ? `: ${body}` : ''}`, scope: this.options.binding });
    }
    return response;
  }

  private async writeEvidence(scope: ScopeRef, type: string, content: unknown): Promise<EvidenceRef> {
    return this.options.evidence.write({ scope, kind: 'external', type, locator: `rcc-v3://${type}`, content });
  }

  private async persistError(scope: ScopeRef, error: ProviderError): Promise<ProviderError> {
    const ref = await this.writeEvidence(scope, 'settle-error', { ...error, evidenceRefs: [] });
    return { ...error, evidenceRefs: [ref] };
  }

  private assertBinding(binding: ProviderBinding): void {
    if (binding.bindingId !== this.options.binding.bindingId
      || binding.providerId !== this.options.binding.providerId
      || binding.protocol !== this.options.binding.protocol
      || binding.endpointRef !== this.options.binding.endpointRef
      || binding.modelRef !== this.options.binding.modelRef
      || binding.configDigest !== this.options.binding.configDigest
      || binding.capabilityDigest !== this.options.binding.capabilityDigest) {
      throw new ProviderAdapterError({
        code: 'binding.identity.mismatch',
        category: 'protocol',
        phase: 'probe',
        message: 'RCC v3 probe binding does not match transport binding',
        scope: binding,
      });
    }
  }

  private async probeHealth(binding: ProviderBinding): Promise<ProbeHealthResult> {
    const scope = scopeForBinding(binding);
    try {
      const response = await this.fetcher(urlFor(this.options.baseUrl, '/health'), {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      const raw = (await response.text()).slice(0, this.maxEventBytes);
      if (response.status < 200 || response.status >= 300) {
        const ref = await this.writeEvidence(scope, 'probe-health', { status: response.status, body: raw });
        const error = providerError(scope, 'probe', `health.http.${response.status}`, `RCC v3 health returned HTTP ${response.status}`, 'provider');
        return { ok: false, state: 'not-ready', evidence: ref, error: { ...error, evidenceRefs: [ref] }, version: 'rcc-v3' };
      }
      let value: Record<string, unknown>;
      try {
        value = readRecord(JSON.parse(raw));
      } catch (cause) {
        const ref = await this.writeEvidence(scope, 'probe-health', { status: response.status, body: raw });
        const error = providerError(scope, 'probe', 'health.invalid-json', cause instanceof Error ? cause.message : 'RCC v3 health response is not valid JSON', 'protocol');
        return { ok: false, state: 'not-ready', evidence: ref, error: { ...error, evidenceRefs: [ref] }, version: 'rcc-v3' };
      }
      const version = typeof value.version === 'string' && value.version.trim() ? value.version : 'rcc-v3';
      const ref = await this.writeEvidence(scope, 'probe-health', { status: response.status, body: value });
      if (value.status !== 'ok') {
        const error = providerError(scope, 'probe', 'health.not-ready', 'RCC v3 health endpoint did not report status ok', 'provider');
        return { ok: false, state: 'degraded', evidence: ref, error: { ...error, evidenceRefs: [ref] }, version };
      }
      return { ok: true, state: 'ready', evidence: ref, version };
    } catch (cause) {
      const ref = await this.writeEvidence(scope, 'probe-health', { error: cause instanceof Error ? cause.message : 'RCC v3 health probe failed' });
      const error = providerError(scope, 'probe', 'health.transport-failure', cause instanceof Error ? cause.message : 'RCC v3 health probe failed', 'transport');
      return { ok: false, state: 'dependency-missing', evidence: ref, error: { ...error, evidenceRefs: [ref] }, version: 'rcc-v3' };
    }
  }

  private async probeModels(binding: ProviderBinding): Promise<ProbeModelsResult> {
    const scope = scopeForBinding(binding);
    try {
      const response = await this.fetcher(urlFor(this.options.baseUrl, '/v1/models'), {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      const raw = (await response.text()).slice(0, this.maxEventBytes);
      if (response.status < 200 || response.status >= 300) {
        const ref = await this.writeEvidence(scope, 'probe-models', { status: response.status });
        return { ok: false, evidence: ref, models: [] };
      }
      let value: Record<string, unknown>;
      try {
        value = readRecord(JSON.parse(raw));
      } catch {
        const ref = await this.writeEvidence(scope, 'probe-models', { status: response.status, invalid: 'json' });
        return { ok: false, evidence: ref, models: [] };
      }
      const candidates = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : [];
      const models = candidates.flatMap((candidate) => {
        if (typeof candidate === 'string') return [candidate];
        if (candidate && typeof candidate === 'object' && typeof (candidate as Record<string, unknown>).id === 'string') return [(candidate as Record<string, unknown>).id as string];
        return [];
      });
      const ref = await this.writeEvidence(scope, 'probe-models', { status: response.status, models });
      return { ok: true, evidence: ref, models };
    } catch {
      const ref = await this.writeEvidence(scope, 'probe-models', { error: 'transport-failure' });
      return { ok: false, evidence: ref, models: [] };
    }
  }
}

interface ProbeHealthResult {
  readonly ok: boolean;
  readonly state: ProviderReadiness['state'];
  readonly evidence: EvidenceRef;
  readonly error?: ProviderError;
  readonly version: string;
}

interface ProbeModelsResult {
  readonly ok: boolean;
  readonly evidence: EvidenceRef;
  readonly models: readonly string[];
}

function scopeForBinding(binding: ProviderBinding): ScopeRef {
  return { organId: id('organ', `provider-${binding.providerId}`) };
}

function readiness(
  binding: ProviderBinding,
  state: ProviderReadiness['state'],
  checkedAt: string,
  expiresAt: string,
  evidenceRefs: readonly EvidenceRef[],
  failure?: ProviderError,
  version?: string,
): ProviderReadiness {
  return {
    bindingId: binding.bindingId,
    providerId: binding.providerId,
    protocol: binding.protocol,
    state,
    capabilityDigest: binding.capabilityDigest,
    ...(version ? { version } : {}),
    checkedAt,
    expiresAt,
    evidenceRefs,
    ...(failure ? { failure: { ...failure, evidenceRefs }, ownerId: OWNER, nextAction: failure.nextAction } : {}),
  };
}

export function createRccV3ProviderTransport(options: RccV3ProviderTransportOptions): RccV3ProviderTransport {
  return new RccV3ProviderTransport(options);
}
