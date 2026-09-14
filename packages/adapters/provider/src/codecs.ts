import {
  id,
  type EvidenceRef,
  type NextAction,
  type ProviderBinding,
  type ProviderError,
  type ProviderEvent,
  type ProviderExecutionIdentityRef,
  type ProviderResumeInput,
  type ProviderStartInput,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { ProviderAdapterError } from './errors.js';
import type {
  AnthropicWireCancelRequest,
  AnthropicWireContentBlock,
  AnthropicWireContentBlockStart,
  AnthropicWireDelta,
  AnthropicWireEvent,
  AnthropicWireMessage,
  AnthropicWireRequest,
  AnthropicWireTool,
  ProviderWireEvent,
  ProviderWireRequest,
  ProviderWireStopRequest,
  ResponsesWireCancelRequest,
  ResponsesWireEvent,
  ResponsesWireRequest,
  ResponsesWireTool,
} from './wire.js';

const SOURCE = 'humanagent.provider-adapter';
const OWNER = SOURCE;

export interface DecodeContext {
  readonly execution: ProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
}

export interface ProviderDecodedEvent {
  readonly events: readonly ProviderEvent[];
}

export interface ProviderCodec<W extends ProviderWireRequest = ProviderWireRequest> {
  readonly protocol: 'responses' | 'anthropic';
  encodeStart(input: ProviderStartInput, binding: ProviderBinding, routeRef: string): W;
  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): W;
  encodeSubmit(input: ProviderSubmitInput, binding: ProviderBinding, routeRef: string): W;
  encodeStop(input: ProviderStopRequest, binding: ProviderBinding, routeRef: string): ProviderWireStopRequest;
  decodeEvent(raw: ProviderWireEvent, context: DecodeContext): ProviderDecodedEvent;
}

function evidence(scope: ScopeRef, label: string, kind: EvidenceRef['kind'] = 'execution'): EvidenceRef {
  return {
    evidenceId: id('evidence', `provider-${label.replace(/[^A-Za-z0-9._-]/g, '-')}`),
    kind,
    source: SOURCE,
    locator: label,
    scope,
  };
}

function providerError(
  execution: ProviderExecutionIdentityRef,
  scope: ScopeRef,
  code: string,
  message: string,
  category: ProviderError['category'] = 'provider',
): ProviderError {
  return {
    errorId: `provider.observe.${code}`,
    code,
    category,
    phase: 'observe',
    message,
    ownerId: OWNER,
    retryable: 'manual',
    attention: 'foreground',
    evidenceRefs: [evidence(scope, `error-${code}`)],
    nextAction: { kind: 'recover', ref: OWNER },
  };
}

function eventBase(
  execution: ProviderExecutionIdentityRef,
  scope: ScopeRef,
  type: string,
  eventId: string,
  label: string,
): Omit<ProviderEvent, 'kind'> {
  return {
    runtimeId: execution.runtimeId,
    taskId: execution.taskId,
    operationId: execution.operationId,
    executionEpoch: execution.executionEpoch,
    eventId,
    evidenceRefs: [evidence(scope, label)],
  };
}

function modelEvent(execution: ProviderExecutionIdentityRef, scope: ScopeRef, type: string, eventId: string): ProviderEvent {
  return { ...eventBase(execution, scope, type, eventId, type), kind: 'model' };
}

function outputEvent(execution: ProviderExecutionIdentityRef, scope: ScopeRef, type: string, eventId: string, outputRefs: readonly string[]): ProviderEvent {
  return { ...eventBase(execution, scope, type, eventId, type), kind: 'output', outputRefs };
}

function ownedEvent(
  execution: ProviderExecutionIdentityRef,
  scope: ScopeRef,
  kind: ProviderEvent['kind'],
  type: string,
  eventId: string,
  label: string,
  nextAction: NextAction,
  extra: { readonly terminalState?: ProviderEvent['terminalState']; readonly error?: ProviderError; readonly outputRefs?: readonly string[] } = {},
): ProviderEvent {
  return {
    ...eventBase(execution, scope, type, eventId, label),
    kind,
    ownerId: OWNER,
    nextAction,
    ...(extra.terminalState === undefined ? {} : { terminalState: extra.terminalState }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
    ...(extra.outputRefs === undefined ? {} : { outputRefs: extra.outputRefs }),
  };
}

function routeFor(binding: ProviderBinding, routeRef: string): string {
  return `${binding.providerId}:${routeRef}`;
}

function requireString(record: Record<string, unknown>, key: string, execution: ProviderExecutionIdentityRef, type: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProviderAdapterError({
      code: 'missing.field',
      category: 'protocol',
      phase: 'observe',
      message: `${type} event missing ${key}`,
      scope: execution,
    });
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, execution: ProviderExecutionIdentityRef, type: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProviderAdapterError({
      code: 'missing.field',
      category: 'protocol',
      phase: 'observe',
      message: `${type} event missing ${key}`,
      scope: execution,
    });
  }
  return value;
}

function requireObject(record: Record<string, unknown>, key: string, execution: ProviderExecutionIdentityRef, type: string): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== 'object') {
    throw new ProviderAdapterError({
      code: 'missing.field',
      category: 'protocol',
      phase: 'observe',
      message: `${type} event missing ${key}`,
      scope: execution,
    });
  }
  return value as Record<string, unknown>;
}

function asRecord(raw: ProviderWireEvent): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    throw new ProviderAdapterError({
      code: 'malformed.event',
      category: 'protocol',
      phase: 'observe',
      message: 'provider wire event must be an object',
    });
  }
  return raw as unknown as Record<string, unknown>;
}

export class ResponsesProviderCodec implements ProviderCodec<ResponsesWireRequest> {
  readonly protocol = 'responses' as const;

  encodeStart(input: ProviderStartInput, binding: ProviderBinding, routeRef: string): ResponsesWireRequest {
    return this.encodeRequest(binding, routeRef, input.inputRefs, input.payload);
  }

  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): ResponsesWireRequest {
    return this.encodeRequest(binding, routeRef, input.inputRefs, input.payload, { checkpoint: input.checkpointId.value });
  }

  encodeSubmit(input: ProviderSubmitInput, binding: ProviderBinding, routeRef: string): ResponsesWireRequest {
    return this.encodeRequest(binding, routeRef, input.inputRefs, input.payload);
  }

  encodeStop(input: ProviderStopRequest, binding: ProviderBinding, routeRef: string): ResponsesWireCancelRequest {
    return {
      protocol: 'responses',
      type: 'responses.cancel',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      reason: input.reason,
    };
  }

  decodeEvent(raw: ProviderWireEvent, context: DecodeContext): ProviderDecodedEvent {
    if (raw.protocol !== 'responses') {
      throw new ProviderAdapterError({
        code: 'protocol.mismatch',
        category: 'protocol',
        phase: 'observe',
        message: 'responses codec received non-responses wire event',
        scope: context.execution,
      });
    }
    const record = asRecord(raw);
    switch (raw.type) {
      case 'response.created':
        requireString(record, 'response_id', context.execution, raw.type);
        return { events: [modelEvent(context.execution, context.scope, raw.type, `event-${raw.type}`)] };
      case 'response.in_progress':
        requireString(record, 'response_id', context.execution, raw.type);
        return { events: [modelEvent(context.execution, context.scope, raw.type, `event-${raw.type}`)] };
      case 'response.output_item.added': {
        requireNumber(record, 'output_index', context.execution, raw.type);
        const item = requireObject(record, 'item', context.execution, raw.type);
        const itemType = requireString(item, 'type', context.execution, raw.type);
        if (itemType === 'function_call') {
          const callId = requireString(item, 'call_id', context.execution, raw.type);
          return {
            events: [
              ownedEvent(
                context.execution,
                context.scope,
                'tool',
                raw.type,
                `event-tool-${callId}`,
                `tool-${callId}`,
                { kind: 'continue' },
                { outputRefs: [`wire://tool/${callId}`] },
              ),
            ],
          };
        }
        requireString(item, 'id', context.execution, raw.type);
        return { events: [outputEvent(context.execution, context.scope, raw.type, `event-${raw.type}`, [`wire://output/${String(item.id)}`])] };
      }
      case 'response.output_text.delta': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        requireString(record, 'delta', context.execution, raw.type);
        return { events: [outputEvent(context.execution, context.scope, raw.type, `event-${raw.type}`, [`wire://output/${itemId}`])] };
      }
      case 'response.function_call_arguments.delta': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        requireString(record, 'delta', context.execution, raw.type);
        return { events: [modelEvent(context.execution, context.scope, raw.type, `event-${raw.type}`)] };
      }
      case 'response.completed':
        requireString(record, 'response_id', context.execution, raw.type);
        return {
          events: [
            ownedEvent(
              context.execution,
              context.scope,
              'terminal',
              raw.type,
              `event-${raw.type}`,
              raw.type,
              { kind: 'continue' },
              { terminalState: 'succeeded' },
            ),
          ],
        };
      case 'response.incomplete': {
        requireString(record, 'response_id', context.execution, raw.type);
        requireString(record, 'reason', context.execution, raw.type);
        return {
          events: [
            ownedEvent(
              context.execution,
              context.scope,
              'terminal',
              raw.type,
              `event-${raw.type}`,
              raw.type,
              { kind: 'wait', ref: 'provider-incomplete' },
              { terminalState: 'waiting' },
            ),
          ],
        };
      }
      case 'response.failed': {
        const responseId = requireString(record, 'response_id', context.execution, raw.type);
        const errorRecord = requireObject(record, 'error', context.execution, raw.type);
        const code = requireString(errorRecord, 'code', context.execution, raw.type);
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const error = providerError(context.execution, context.scope, code, message, 'provider');
        return {
          events: [
            ownedEvent(context.execution, context.scope, 'error', raw.type, `event-error-${responseId}`, `error-${responseId}`, { kind: 'recover', ref: OWNER }, { error }),
            ownedEvent(context.execution, context.scope, 'terminal', raw.type, `event-terminal-${responseId}`, `terminal-${responseId}`, { kind: 'recover', ref: OWNER }, { terminalState: 'failed' }),
          ],
        };
      }
      case 'error': {
        const errorRecord = requireObject(record, 'error', context.execution, raw.type);
        const code = requireString(errorRecord, 'code', context.execution, raw.type);
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const error = providerError(context.execution, context.scope, code, message, 'protocol');
        return {
          events: [ownedEvent(context.execution, context.scope, 'error', raw.type, `event-error`, `error-${code}`, { kind: 'recover', ref: OWNER }, { error })],
        };
      }
      default:
        throw new ProviderAdapterError({
          code: 'unknown.event',
          category: 'protocol',
          phase: 'observe',
          message: `unknown responses wire event type`,
          scope: context.execution,
        });
    }
  }

  private encodeRequest(
    binding: ProviderBinding,
    routeRef: string,
    inputRefs: readonly string[],
    payload: ProviderStartInput['payload'],
    resumeExtra?: { readonly checkpoint: string },
  ): ResponsesWireRequest {
    const requestBody = resumeExtra ? { inputRefs, payload: payload ?? {}, resumeExtra } : { inputRefs, payload: payload ?? {} };
    const input: ResponsesWireRequest['input'] = [{ type: 'message', role: 'user', content: JSON.stringify(requestBody) }];
    const tools: ResponsesWireTool[] = [];
    return {
      protocol: 'responses',
      type: 'responses.request',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      instructions: inputRefs.join('\n'),
      input,
      ...(tools.length === 0 ? {} : { tools }),
    };
  }
}

export class AnthropicProviderCodec implements ProviderCodec<AnthropicWireRequest> {
  readonly protocol = 'anthropic' as const;

  constructor(private readonly maxTokens: number) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      throw new ProviderAdapterError({
        code: 'invalid.max_tokens',
        category: 'validation',
        phase: 'start',
        message: 'anthropic codec requires a positive max_tokens value',
      });
    }
  }

  encodeStart(input: ProviderStartInput, binding: ProviderBinding, routeRef: string): AnthropicWireRequest {
    return this.encodeRequest(binding, routeRef, input.inputRefs, input.payload);
  }

  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): AnthropicWireRequest {
    return this.encodeRequest(binding, routeRef, input.inputRefs, input.payload, { checkpoint: input.checkpointId.value });
  }

  encodeSubmit(input: ProviderSubmitInput, binding: ProviderBinding, routeRef: string): AnthropicWireRequest {
    return this.encodeRequest(binding, routeRef, input.inputRefs, input.payload);
  }

  encodeStop(input: ProviderStopRequest, binding: ProviderBinding, routeRef: string): AnthropicWireCancelRequest {
    return {
      protocol: 'anthropic',
      type: 'anthropic.cancel',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      reason: input.reason,
    };
  }

  decodeEvent(raw: ProviderWireEvent, context: DecodeContext): ProviderDecodedEvent {
    if (raw.protocol !== 'anthropic') {
      throw new ProviderAdapterError({
        code: 'protocol.mismatch',
        category: 'protocol',
        phase: 'observe',
        message: 'anthropic codec received non-anthropic wire event',
        scope: context.execution,
      });
    }
    const record = asRecord(raw);
    switch (raw.type) {
      case 'message_start':
        requireObject(record, 'message', context.execution, raw.type);
        return { events: [modelEvent(context.execution, context.scope, raw.type, `event-${raw.type}`)] };
      case 'content_block_start': {
        requireNumber(record, 'index', context.execution, raw.type);
        const blockRecord = requireObject(record, 'content_block', context.execution, raw.type);
        const blockType = requireString(blockRecord, 'type', context.execution, raw.type);
        if (blockType === 'tool_use') {
          const callId = requireString(blockRecord, 'id', context.execution, raw.type);
          return {
            events: [
              ownedEvent(
                context.execution,
                context.scope,
                'tool',
                raw.type,
                `event-tool-${callId}`,
                `tool-${callId}`,
                { kind: 'continue' },
                { outputRefs: [`wire://tool/${callId}`] },
              ),
            ],
          };
        }
        if (blockType === 'text') {
          requireString(blockRecord, 'text', context.execution, raw.type);
          return { events: [outputEvent(context.execution, context.scope, raw.type, `event-${raw.type}`, [`wire://block/${String(record.index)}`])] };
        }
        if (blockType === 'thinking') {
          requireString(blockRecord, 'thinking', context.execution, raw.type);
          requireString(blockRecord, 'signature', context.execution, raw.type);
          return { events: [modelEvent(context.execution, context.scope, raw.type, `event-${raw.type}`)] };
        }
        throw new ProviderAdapterError({
          code: 'unknown.event',
          category: 'protocol',
          phase: 'observe',
          message: 'unknown anthropic content block start type',
          scope: context.execution,
        });
      }
      case 'content_block_delta': {
        requireNumber(record, 'index', context.execution, raw.type);
        const deltaRecord = requireObject(record, 'delta', context.execution, raw.type);
        const deltaType = requireString(deltaRecord, 'type', context.execution, raw.type);
        if (deltaType === 'text_delta') {
          requireString(deltaRecord, 'text', context.execution, raw.type);
          return { events: [outputEvent(context.execution, context.scope, raw.type, `event-${raw.type}`, [`wire://delta/${String(record.index)}`])] };
        }
        if (deltaType === 'thinking_delta' || deltaType === 'signature_delta' || deltaType === 'input_json_delta') {
          return { events: [modelEvent(context.execution, context.scope, raw.type, `event-${raw.type}`)] };
        }
        throw new ProviderAdapterError({
          code: 'unknown.event',
          category: 'protocol',
          phase: 'observe',
          message: 'unknown anthropic content block delta type',
          scope: context.execution,
        });
      }
      case 'content_block_stop':
        requireNumber(record, 'index', context.execution, raw.type);
        return { events: [modelEvent(context.execution, context.scope, raw.type, `event-${raw.type}`)] };
      case 'message_delta':
        requireObject(record, 'delta', context.execution, raw.type);
        return { events: [modelEvent(context.execution, context.scope, raw.type, `event-${raw.type}`)] };
      case 'message_stop':
        return {
          events: [
            ownedEvent(
              context.execution,
              context.scope,
              'terminal',
              raw.type,
              `event-${raw.type}`,
              raw.type,
              { kind: 'continue' },
              { terminalState: 'succeeded' },
            ),
          ],
        };
      case 'error': {
        const errorRecord = requireObject(record, 'error', context.execution, raw.type);
        const code = requireString(errorRecord, 'type', context.execution, raw.type);
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const error = providerError(context.execution, context.scope, code, message, 'provider');
        return {
          events: [ownedEvent(context.execution, context.scope, 'error', raw.type, `event-error`, `error-${code}`, { kind: 'recover', ref: OWNER }, { error })],
        };
      }
      default:
        throw new ProviderAdapterError({
          code: 'unknown.event',
          category: 'protocol',
          phase: 'observe',
          message: 'unknown anthropic wire event type',
          scope: context.execution,
        });
    }
  }

  private encodeRequest(
    binding: ProviderBinding,
    routeRef: string,
    inputRefs: readonly string[],
    payload: ProviderStartInput['payload'],
    resumeExtra?: { readonly checkpoint: string },
  ): AnthropicWireRequest {
    const requestBody = resumeExtra ? { inputRefs, payload: payload ?? {}, resumeExtra } : { inputRefs, payload: payload ?? {} };
    const message: AnthropicWireMessage = {
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify(requestBody) }],
    };
    const tools: AnthropicWireTool[] = [];
    return {
      protocol: 'anthropic',
      type: 'anthropic.request',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      max_tokens: this.maxTokens,
      system: inputRefs.join('\n'),
      messages: [message],
      ...(tools.length === 0 ? {} : { tools }),
    };
  }
}

export type { AnthropicWireContentBlock, AnthropicWireContentBlockStart, AnthropicWireDelta, AnthropicWireEvent, AnthropicWireRequest, ResponsesWireEvent, ResponsesWireRequest };
