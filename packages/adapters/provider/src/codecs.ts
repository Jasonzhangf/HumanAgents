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
  type ProviderTerminalState,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { ProviderAdapterError } from './errors.js';
import type { ProviderEvidenceSink } from './evidence.js';
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
  readonly evidence: ProviderEvidenceSink;
  readonly nextEventId: (type: string, locator: string) => string;
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
  decodeEvent(raw: ProviderWireEvent, context: DecodeContext): Promise<ProviderDecodedEvent>;
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

function sanitizeRefPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

function artifactRef(type: string, locator: string, digest?: string): string {
  return `${SOURCE}:${type}:${sanitizeRefPart(locator)}${digest ? `:${digest.slice(0, 12)}` : ''}`;
}

async function captureEvidence(context: DecodeContext, type: string, locator: string, value?: unknown, kind: EvidenceRef['kind'] = 'execution'): Promise<EvidenceRef> {
  return context.evidence.write({
    scope: context.scope,
    kind,
    type,
    locator,
    content: value ?? `${type}:${locator}`,
  });
}

function providerError(
  execution: ProviderExecutionIdentityRef,
  scope: ScopeRef,
  code: string,
  message: string,
  category: ProviderError['category'] = 'provider',
  evidenceRefs?: readonly EvidenceRef[],
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
    evidenceRefs: evidenceRefs ?? [evidence(scope, `error-${code}`)],
    nextAction: { kind: 'recover', ref: OWNER },
  };
}

function eventId(context: DecodeContext, type: string, locator: string): string {
  return context.nextEventId(type, locator);
}

function eventBase(
  execution: ProviderExecutionIdentityRef,
  scope: ScopeRef,
  type: string,
  eventId: string,
  label: string,
  evidenceRefs?: readonly EvidenceRef[],
): Omit<ProviderEvent, 'kind'> {
  return {
    runtimeId: execution.runtimeId,
    taskId: execution.taskId,
    operationId: execution.operationId,
    executionEpoch: execution.executionEpoch,
    eventId,
    evidenceRefs: evidenceRefs ?? [evidence(scope, label)],
  };
}

function modelEvent(execution: ProviderExecutionIdentityRef, scope: ScopeRef, type: string, eventId: string, evidenceRefs?: readonly EvidenceRef[]): ProviderEvent {
  return { ...eventBase(execution, scope, type, eventId, type, evidenceRefs), kind: 'model' };
}

function outputEvent(execution: ProviderExecutionIdentityRef, scope: ScopeRef, type: string, eventId: string, outputRefs: readonly string[], evidenceRefs?: readonly EvidenceRef[]): ProviderEvent {
  return { ...eventBase(execution, scope, type, eventId, type, evidenceRefs), kind: 'output', outputRefs };
}

function ownedEvent(
  execution: ProviderExecutionIdentityRef,
  scope: ScopeRef,
  kind: ProviderEvent['kind'],
  type: string,
  eventId: string,
  label: string,
  nextAction: NextAction,
  extra: { readonly terminalState?: ProviderEvent['terminalState']; readonly error?: ProviderError; readonly outputRefs?: readonly string[]; readonly evidenceRefs?: readonly EvidenceRef[] } = {},
): ProviderEvent {
  return {
    ...eventBase(execution, scope, type, eventId, label),
    kind,
    ownerId: OWNER,
    nextAction,
    ...(extra.terminalState === undefined ? {} : { terminalState: extra.terminalState }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
    ...(extra.outputRefs === undefined ? {} : { outputRefs: extra.outputRefs }),
    ...(extra.evidenceRefs === undefined ? {} : { evidenceRefs: extra.evidenceRefs }),
  };
}

function routeFor(binding: ProviderBinding, routeRef: string): string {
  return `${binding.providerId}:${routeRef}`;
}

function mapAnthropicStopReason(stopReason: string | undefined): { readonly state: ProviderTerminalState; readonly nextAction: NextAction } {
  switch (stopReason) {
    case 'end_turn':
      return { state: 'succeeded', nextAction: { kind: 'continue' } };
    case 'stop_sequence':
      return { state: 'succeeded', nextAction: { kind: 'continue' } };
    case 'tool_use':
      return { state: 'waiting', nextAction: { kind: 'continue', ref: 'anthropic-tool-use' } };
    case 'max_tokens':
      return { state: 'waiting', nextAction: { kind: 'wait', ref: 'anthropic-max-tokens' } };
    case 'pause_turn':
      return { state: 'waiting', nextAction: { kind: 'wait', ref: 'anthropic-pause-turn' } };
    default:
      return { state: 'unknown', nextAction: { kind: 'recover', ref: OWNER } };
  }
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

function requireStringOrGenerated(
  record: Record<string, unknown>,
  key: string,
  execution: ProviderExecutionIdentityRef,
  type: string,
  generated: string,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new ProviderAdapterError({
      code: 'missing.field',
      category: 'protocol',
      phase: 'observe',
      message: `${type} event missing ${key}`,
      scope: execution,
    });
  }
  return value.trim() === '' ? generated : value;
}

function stringOrGenerated(record: Record<string, unknown>, key: string, generated: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : generated;
}

function requireStringValue(record: Record<string, unknown>, key: string, execution: ProviderExecutionIdentityRef, type: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
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
    return this.encodeRequest(binding, routeRef, input, input.inputRefs, input.payload);
  }

  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): ResponsesWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.inputRefs, input.payload, input.checkpointId);
  }

  encodeSubmit(input: ProviderSubmitInput, binding: ProviderBinding, routeRef: string): ResponsesWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.inputRefs, input.payload);
  }

  encodeStop(input: ProviderStopRequest, binding: ProviderBinding, routeRef: string): ResponsesWireCancelRequest {
    return {
      protocol: 'responses',
      type: 'responses.cancel',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      reason: input.reason,
      execution: input,
    };
  }

  async decodeEvent(raw: ProviderWireEvent, context: DecodeContext): Promise<ProviderDecodedEvent> {
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
      case 'response.in_progress': {
        const response = requireObject(record, 'response', context.execution, raw.type);
        const responseId = requireStringOrGenerated(response, 'id', context.execution, raw.type, `rcc-response-${context.execution.executionEpoch}`);
        const evidenceRefs = [await captureEvidence(context, raw.type, `response/${responseId}`)];
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `response/${responseId}`), evidenceRefs)] };
      }
      case 'response.output_item.added': {
        requireNumber(record, 'output_index', context.execution, raw.type);
        const item = requireObject(record, 'item', context.execution, raw.type);
        const itemType = requireString(item, 'type', context.execution, raw.type);
        if (itemType === 'function_call') {
          const callId = requireString(item, 'call_id', context.execution, raw.type);
          requireString(item, 'id', context.execution, raw.type);
          const name = requireString(item, 'name', context.execution, raw.type);
          const argumentsJson = requireStringValue(item, 'arguments', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `tool/${callId}`, { name, arguments: argumentsJson })];
          return {
            events: [
              ownedEvent(
                context.execution,
                context.scope,
                'tool',
                raw.type,
                eventId(context, raw.type, `tool/${callId}`),
                `tool-${callId}`,
                { kind: 'continue' },
                { outputRefs: [artifactRef(raw.type, `tool/${callId}`, evidenceRefs[0].digest)], evidenceRefs },
              ),
            ],
          };
        }
        const itemId = stringOrGenerated(item, 'id', `rcc-output-${record.output_index}`);
        const evidenceRefs = [await captureEvidence(context, raw.type, `output/${itemId}`, item)];
        return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `output/${itemId}`), [artifactRef(raw.type, `output/${itemId}`, evidenceRefs[0].digest)], evidenceRefs)] };
      }
      case 'response.output_text.delta': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const delta = requireStringValue(record, 'delta', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `text/${itemId}`, delta)];
        return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `text/${itemId}`), [artifactRef(raw.type, `text/${itemId}`, evidenceRefs[0].digest)], evidenceRefs)] };
      }
      case 'response.output_text.done': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const text = requireStringValue(record, 'text', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `text/${itemId}`, text)];
        return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `text/${itemId}`), [artifactRef(raw.type, `text/${itemId}`, evidenceRefs[0].digest)], evidenceRefs)] };
      }
      case 'response.content_part.added': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        requireNumber(record, 'output_index', context.execution, raw.type);
        requireNumber(record, 'content_index', context.execution, raw.type);
        const part = requireObject(record, 'part', context.execution, raw.type);
        const partType = requireString(part, 'type', context.execution, raw.type);
        if (partType !== 'output_text') {
          throw new ProviderAdapterError({
            code: 'unknown.content.part',
            category: 'protocol',
            phase: 'observe',
            message: `unknown responses content part type ${partType}`,
            scope: context.execution,
          });
        }
        const text = requireStringValue(part, 'text', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `part/${itemId}`, { type: partType, text })];
        return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `part/${itemId}`), [artifactRef(raw.type, `part/${itemId}`, evidenceRefs[0].digest)], evidenceRefs)] };
      }
      case 'response.content_part.done': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        requireNumber(record, 'output_index', context.execution, raw.type);
        requireNumber(record, 'content_index', context.execution, raw.type);
        const part = requireObject(record, 'part', context.execution, raw.type);
        const partType = requireString(part, 'type', context.execution, raw.type);
        const text = requireStringValue(part, 'text', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `part/${itemId}`, { type: partType, text })];
        return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `part/${itemId}`), [artifactRef(raw.type, `part/${itemId}`, evidenceRefs[0].digest)], evidenceRefs)] };
      }
      case 'response.output_item.done': {
        requireNumber(record, 'output_index', context.execution, raw.type);
        const item = requireObject(record, 'item', context.execution, raw.type);
        const itemType = requireString(item, 'type', context.execution, raw.type);
        if (itemType === 'function_call') {
          const callId = requireString(item, 'call_id', context.execution, raw.type);
          requireString(item, 'id', context.execution, raw.type);
          const name = requireString(item, 'name', context.execution, raw.type);
          const argumentsJson = requireStringValue(item, 'arguments', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `tool/${callId}`, { name, arguments: argumentsJson })];
          return {
            events: [
              ownedEvent(
                context.execution,
                context.scope,
                'tool',
                raw.type,
                eventId(context, raw.type, `tool/${callId}`),
                `tool-${callId}`,
                { kind: 'continue' },
                { outputRefs: [artifactRef(raw.type, `tool/${callId}`, evidenceRefs[0].digest)], evidenceRefs },
              ),
            ],
          };
        }
        const itemId = stringOrGenerated(item, 'id', `rcc-output-${record.output_index}`);
        const evidenceRefs = [await captureEvidence(context, raw.type, `output/${itemId}`, item)];
        return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `output/${itemId}`), [artifactRef(raw.type, `output/${itemId}`, evidenceRefs[0].digest)], evidenceRefs)] };
      }
      case 'response.function_call_arguments.delta': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const delta = requireStringValue(record, 'delta', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `arguments/${itemId}`, delta)];
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `arguments/${itemId}`), evidenceRefs)] };
      }
      case 'response.function_call_arguments.done': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const args = requireStringValue(record, 'arguments', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `arguments/${itemId}`, args)];
        return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `arguments/${itemId}`), [artifactRef(raw.type, `arguments/${itemId}`, evidenceRefs[0].digest)], evidenceRefs)] };
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = requireObject(record, 'response', context.execution, raw.type);
        const responseId = requireStringOrGenerated(response, 'id', context.execution, raw.type, `rcc-response-${context.execution.executionEpoch}`);
        const incompleteDetails = raw.type === 'response.incomplete'
          ? requireObject(response, 'incomplete_details', context.execution, raw.type)
          : undefined;
        const reason = incompleteDetails === undefined ? undefined : requireString(incompleteDetails, 'reason', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `response/${responseId}`, reason)];
        const next = raw.type === 'response.incomplete'
          ? { kind: 'wait' as const, ref: `provider-incomplete-${reason ?? 'unknown'}` }
          : { kind: 'continue' as const };
        return {
          events: [
            ownedEvent(
              context.execution,
              context.scope,
              'terminal',
              raw.type,
              eventId(context, raw.type, `response/${responseId}`),
              raw.type,
              next,
              { terminalState: raw.type === 'response.incomplete' ? 'waiting' : 'succeeded', evidenceRefs },
            ),
          ],
        };
      }
      case 'response.failed': {
        const response = requireObject(record, 'response', context.execution, raw.type);
        const responseId = requireString(response, 'id', context.execution, raw.type);
        const errorRecord = requireObject(response, 'error', context.execution, raw.type);
        const code = requireString(errorRecord, 'code', context.execution, raw.type);
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const errorEvidence = await captureEvidence(context, raw.type, `error/${responseId}`, errorRecord);
        const error = providerError(context.execution, context.scope, code, message, 'provider', [errorEvidence]);
        return {
          events: [
            ownedEvent(context.execution, context.scope, 'error', raw.type, eventId(context, raw.type, `error/${responseId}`), `error-${responseId}`, { kind: 'recover', ref: OWNER }, { error }),
            ownedEvent(context.execution, context.scope, 'terminal', raw.type, eventId(context, raw.type, `terminal/${responseId}`), `terminal-${responseId}`, { kind: 'recover', ref: OWNER }, { terminalState: 'failed' }),
          ],
        };
      }
      case 'error': {
        const errorRecord = requireObject(record, 'error', context.execution, raw.type);
        const code = requireString(errorRecord, 'code', context.execution, raw.type);
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const param = typeof errorRecord.param === 'string' ? errorRecord.param : undefined;
        const errorEvidence = await captureEvidence(context, raw.type, `error/${code}`, { code, message, ...(param === undefined ? {} : { param }) });
        const error = providerError(context.execution, context.scope, code, message, 'protocol', [errorEvidence]);
        return {
          events: [ownedEvent(context.execution, context.scope, 'error', raw.type, eventId(context, raw.type, `error/${code}`), `error-${code}`, { kind: 'recover', ref: OWNER }, { error })],
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
    execution: ProviderExecutionIdentityRef,
    inputRefs: readonly string[],
    payload: ProviderStartInput['payload'],
    checkpointId?: { readonly scope: 'checkpoint'; readonly value: string },
  ): ResponsesWireRequest {
    const requestBody = { inputRefs, payload: payload ?? {} };
    const input: ResponsesWireRequest['input'] = [{ type: 'message', role: 'user', content: JSON.stringify(requestBody) }];
    const tools: ResponsesWireTool[] = [];
    return {
      protocol: 'responses',
      type: 'responses.request',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      instructions: inputRefs.join('\n'),
      input,
      execution,
      ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(tools.length === 0 ? {} : { tools }),
    };
  }
}

export class AnthropicProviderCodec implements ProviderCodec<AnthropicWireRequest> {
  readonly protocol = 'anthropic' as const;

  private readonly stopReasons = new Map<string, string>();

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
    return this.encodeRequest(binding, routeRef, input, input.inputRefs, input.payload);
  }

  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): AnthropicWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.inputRefs, input.payload, input.checkpointId);
  }

  encodeSubmit(input: ProviderSubmitInput, binding: ProviderBinding, routeRef: string): AnthropicWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.inputRefs, input.payload);
  }

  encodeStop(input: ProviderStopRequest, binding: ProviderBinding, routeRef: string): AnthropicWireCancelRequest {
    return {
      protocol: 'anthropic',
      type: 'anthropic.cancel',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      reason: input.reason,
      execution: input,
    };
  }

  async decodeEvent(raw: ProviderWireEvent, context: DecodeContext): Promise<ProviderDecodedEvent> {
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
      {
        const message = requireObject(record, 'message', context.execution, raw.type);
        const messageId = requireString(message, 'id', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `message/${messageId}`)];
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `message/${messageId}`), evidenceRefs)] };
      }
      case 'content_block_start': {
        requireNumber(record, 'index', context.execution, raw.type);
        const blockRecord = requireObject(record, 'content_block', context.execution, raw.type);
        const blockType = requireString(blockRecord, 'type', context.execution, raw.type);
        if (blockType === 'tool_use') {
          const callId = requireString(blockRecord, 'id', context.execution, raw.type);
          const name = requireString(blockRecord, 'name', context.execution, raw.type);
          const input = requireObject(blockRecord, 'input', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `tool/${callId}`, { name, input })];
          return {
            events: [
              ownedEvent(
                context.execution,
                context.scope,
                'tool',
                raw.type,
                eventId(context, raw.type, `tool/${callId}`),
                `tool-${callId}`,
                { kind: 'continue' },
                { outputRefs: [artifactRef(raw.type, `tool/${callId}`, evidenceRefs[0].digest)], evidenceRefs },
              ),
            ],
          };
        }
        if (blockType === 'text') {
          const text = requireStringValue(blockRecord, 'text', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `block/${String(record.index)}`, text)];
          return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `block/${String(record.index)}`), [artifactRef(raw.type, `block/${String(record.index)}`, evidenceRefs[0].digest)], evidenceRefs)] };
        }
        if (blockType === 'thinking') {
          const thinking = requireStringValue(blockRecord, 'thinking', context.execution, raw.type);
          const signature = typeof blockRecord.signature === 'string' ? blockRecord.signature : undefined;
          const evidenceRefs = [await captureEvidence(context, raw.type, `thinking/${String(record.index)}`, { thinking, ...(signature === undefined ? {} : { signature }) })];
          return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `thinking/${String(record.index)}`), evidenceRefs)] };
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
          const text = requireStringValue(deltaRecord, 'text', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `text/${String(record.index)}`, text)];
          return { events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `text/${String(record.index)}`), [artifactRef(raw.type, `text/${String(record.index)}`, evidenceRefs[0].digest)], evidenceRefs)] };
        }
        if (deltaType === 'thinking_delta') {
          const thinking = requireStringValue(deltaRecord, 'thinking', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `thinking/${String(record.index)}`, thinking)];
          return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `thinking/${String(record.index)}`), evidenceRefs)] };
        }
        if (deltaType === 'signature_delta') {
          const signature = requireStringValue(deltaRecord, 'signature', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `signature/${String(record.index)}`, signature)];
          return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `signature/${String(record.index)}`), evidenceRefs)] };
        }
        if (deltaType === 'input_json_delta') {
          const partialJson = requireStringValue(deltaRecord, 'partial_json', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `input-json/${String(record.index)}`, partialJson)];
          return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `input-json/${String(record.index)}`), evidenceRefs)] };
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
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `block/${String(record.index)}`), [await captureEvidence(context, raw.type, `block/${String(record.index)}`)])] };
      case 'message_delta':
      {
        const delta = requireObject(record, 'delta', context.execution, raw.type);
        const stopReason = typeof delta.stop_reason === 'string' ? delta.stop_reason : undefined;
        if (stopReason) this.stopReasons.set(this.stopReasonKey(context.execution), stopReason);
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `delta/${stopReason ?? 'none'}`), [await captureEvidence(context, raw.type, `delta/${stopReason ?? 'none'}`)])] };
      }
      case 'message_stop': {
        const stopReason = this.stopReasons.get(this.stopReasonKey(context.execution));
        this.stopReasons.delete(this.stopReasonKey(context.execution));
        const mapped = mapAnthropicStopReason(stopReason);
        const evidenceRefs = [await captureEvidence(context, raw.type, `stop/${stopReason ?? 'unknown'}`, stopReason)];
        return {
          events: [
            ownedEvent(
              context.execution,
              context.scope,
              'terminal',
              raw.type,
              eventId(context, raw.type, `stop/${stopReason ?? 'unknown'}`),
              raw.type,
              mapped.nextAction,
              { terminalState: mapped.state, evidenceRefs },
            ),
          ],
        };
      }
      case 'ping': {
        const evidenceRefs = [await captureEvidence(context, raw.type, 'ping')];
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, 'ping'), evidenceRefs)] };
      }
      case 'error': {
        const errorRecord = requireObject(record, 'error', context.execution, raw.type);
        const code = requireString(errorRecord, 'type', context.execution, raw.type);
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const errorEvidence = await captureEvidence(context, raw.type, `error/${code}`, errorRecord);
        const error = providerError(context.execution, context.scope, code, message, 'provider', [errorEvidence]);
        return {
          events: [ownedEvent(context.execution, context.scope, 'error', raw.type, eventId(context, raw.type, `error/${code}`), `error-${code}`, { kind: 'recover', ref: OWNER }, { error })],
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

  private stopReasonKey(execution: ProviderExecutionIdentityRef): string {
    return `${execution.runtimeId}:${execution.taskId.value}:${execution.operationId.value}:${execution.executionEpoch}`;
  }

  private encodeRequest(
    binding: ProviderBinding,
    routeRef: string,
    execution: ProviderExecutionIdentityRef,
    inputRefs: readonly string[],
    payload: ProviderStartInput['payload'],
    checkpointId?: { readonly scope: 'checkpoint'; readonly value: string },
  ): AnthropicWireRequest {
    const requestBody = { inputRefs, payload: payload ?? {} };
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
      execution,
      ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(tools.length === 0 ? {} : { tools }),
    };
  }
}

export type { AnthropicWireContentBlock, AnthropicWireContentBlockStart, AnthropicWireDelta, AnthropicWireEvent, AnthropicWireRequest, ResponsesWireEvent, ResponsesWireRequest };
