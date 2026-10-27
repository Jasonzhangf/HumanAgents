import {
  canonicalJsonStringify,
  id,
  type AnyProviderExecutionIdentityRef,
  type BusinessPayload,
  type ContentUnitChannel,
  type EvidenceRef,
  type InteractionParentProviderExecutionIdentityRef,
  type NextAction,
  type ProviderBinding,
  type ProviderError,
  type ProviderEvent,
  type ProviderExecutionIdentityRef,
  type ProviderRawFact,
  type ProviderResumeInput,
  type ProviderStartInput,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ProviderToolCall,
  type ProviderTerminalState,
  type RawAsset,
  type RawAssetView,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  ProviderRequestContext,
  RequestScopedInstructions,
  RequestToolSurfaceUse,
} from '../../../contracts/src/provider-request-context.js';
import { ProviderAdapterError } from './errors.js';
import type { ProviderEvidenceSink } from './evidence.js';
import { mapOpenAIFinishReason } from './openai-finish-reason.js';
import type {
  AnthropicWireCancelRequest,
  AnthropicWireContentBlock,
  AnthropicWireContentBlockStart,
  AnthropicWireDelta,
  AnthropicWireEvent,
  AnthropicWireMessage,
  AnthropicWireRequest,
  AnthropicWireTool,
  OpenAIChatCancelRequest,
  OpenAIChatWireEvent,
  OpenAIChatWireMessage,
  OpenAIChatWireRequest,
  OpenAIChatWireTool,
  ProviderWireEvent,
  ProviderWireRequest,
  ProviderWireStopRequest,
  ResponsesWireCancelRequest,
  ResponsesWireEvent,
  ResponsesWireInputItem,
  ResponsesWireRequest,
  ResponsesWireTool,
} from './wire.js';

const SOURCE = 'humanagent.provider-adapter';
const OWNER = SOURCE;

/** The Harness owns tool execution. A provider backend that also runs its own
 *  agent harness (for example a coding route that exposes `exec_command`) must
 *  not hand the model tools this Harness does not execute: a call to one is not
 *  executable and only burns the tool round budget. Declaring the exact tool
 *  surface keeps the model on the Harness-owned functions. Requests without
 *  tools keep the empty instructions they had before.
 *
 *  The task framing travels with the same statement. An intake decision is not
 *  task execution: telling that request to execute a task and to finish with a
 *  plain-text answer contradicts the decision contract it also receives. A real
 *  Responses batch then echoed that framing back as a second, invented
 *  `requirement` decision. So the framing follows the caller's declared use; only
 *  the tool surface itself is unconditional. */
function harnessToolSurfaceInstructions(
  tools: readonly { readonly toolId: string }[] | undefined,
  use: RequestToolSurfaceUse = 'task-execution',
): string {
  if (tools === undefined || tools.length === 0) return '';
  const names = tools.map((tool) => responsesWireToolName(tool.toolId)).join(', ');
  const framing = use === 'intake-decision'
    ? [
      'This request is one intake decision, not one turn of task execution: produce exactly one decision object for the current input and claim no task execution.',
      'Dispatch a helper only when the decision itself needs one, and never restate the request instructions as a requirement.',
    ]
    : [
      'You are executing one turn of a HumanAgent task.',
      'When the requirement is satisfied, reply with your final answer as plain text and call no further tool: an external checker validates the result, so do not re-verify a completed deliverable by rewriting or re-reading it.',
    ];
  return [
    ...framing,
    'This Harness owns tool execution: the function tools declared in this request are the complete tool surface.',
    'A backend harness tool such as exec_command, a shell, or a server-side servertool is not available in this Harness and always fails.',
    `Only these function tools can be called: ${names}.`,
    'Every round re-sends the complete tool history of this execution, so earlier calls and their results are still available to you.',
    'Call a tool only when it makes concrete progress; a tool call with missing or empty arguments is a failed round.',
  ].join(' ');
}

/**
 * The wire `instructions`/`system` text for one request: the stable harness
 * tool-surface guidance followed by the transient request-scoped orientation.
 * The transient text is request-local and is never persisted as canonical
 * context or inherited by the next request.
 */
function requestInstructions(
  tools: readonly { readonly toolId: string }[] | undefined,
  instructions: RequestScopedInstructions | undefined,
): string {
  return [harnessToolSurfaceInstructions(tools, instructions?.toolSurface), instructions?.text ?? '']
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/**
 * The model-visible evidence footer for one accepted tool result.
 *
 * The model submits delivery references at standard turn end, and the existing
 * resolver matches a reference against `evidenceId.value` or `locator` of real
 * accepted evidence. Without the accepted refs on the wire the model can only
 * guess, and its guess is rejected. The footer renders the refs of exactly the
 * result it is attached to, and returns an empty string when there are none so
 * a result without accepted evidence keeps its original output byte for byte.
 * It never carries control state, and it is only ever produced for the wire:
 * `result.output`, the raw asset, the report and every digest input stay on the
 * original bytes.
 */
function evidenceFooter(refs: readonly EvidenceRef[] | undefined): string {
  if (refs === undefined || refs.length === 0) return '';
  const entries = refs.map((ref) => {
    const fields = [
      `evidenceId=${ref.evidenceId.value}`,
      `kind=${ref.kind}`,
      `locator=${ref.locator}`,
      ...(ref.digest === undefined ? [] : [`digest=${ref.digest}`]),
    ];
    return `- ${fields.join(' ')}`;
  });
  return [
    '',
    '[HumanAgent evidence refs]',
    'Cite one exact evidenceId value below when you finish the turn.',
    ...entries,
    '[/HumanAgent evidence refs]',
  ].join('\n');
}

/** The wire text of one tool result: the original output, plus its evidence footer when it has refs. */
function wireToolResultOutput(output: string, refs: readonly EvidenceRef[] | undefined): string {
  const footer = evidenceFooter(refs);
  return footer === '' ? output : `${output}${footer}`;
}

/** Maps canonical units to Responses input items. Tool units keep their real call identity. */
function responsesContextInput(context: ProviderRequestContext): readonly ResponsesWireInputItem[] {
  return context.units.map((unit): ResponsesWireInputItem => {
    switch (unit.kind) {
      case 'message':
        return { type: 'message', role: unit.role, content: unit.text };
      case 'tool-call':
        return {
          type: 'function_call',
          call_id: unit.callId,
          name: responsesWireToolName(unit.toolId),
          arguments: JSON.stringify(unit.arguments),
        };
      case 'tool-result':
        return { type: 'function_call_output', call_id: unit.callId, output: wireToolResultOutput(unit.output, unit.evidenceRefs) };
    }
  });
}

/**
 * Maps canonical units to Anthropic messages. Consecutive same-role units fold
 * into one message so tool blocks stay valid; no reasoning/signature block is
 * fabricated.
 */
function anthropicContextMessages(context: ProviderRequestContext): readonly AnthropicWireMessage[] {
  const messages: AnthropicWireMessage[] = [];
  const append = (role: AnthropicWireMessage['role'], block: AnthropicWireContentBlock): void => {
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === role) {
      messages[messages.length - 1] = { role, content: [...last.content, block] };
      return;
    }
    messages.push({ role, content: [block] });
  };
  for (const unit of context.units) {
    switch (unit.kind) {
      case 'message':
        append(unit.role, { type: 'text', text: unit.text });
        break;
      case 'tool-call':
        append('assistant', { type: 'tool_use', id: unit.callId, name: unit.toolId, input: unit.arguments });
        break;
      case 'tool-result':
        append('user', { type: 'tool_result', tool_use_id: unit.callId, content: wireToolResultOutput(unit.output, unit.evidenceRefs) });
        break;
    }
  }
  return messages;
}

/**
 * Maps canonical units to OpenAI Chat messages. Consecutive tool-call units
 * fold into one assistant `tool_calls` group so the wire never emits an invalid
 * assistant-call / assistant-call / tool-result ordering; a message or
 * tool-result unit closes the open group. Tool result output is preserved
 * exactly, with no status wrapper or non-standard field.
 */
function openaiChatContextMessages(context: ProviderRequestContext): readonly OpenAIChatWireMessage[] {
  const messages: OpenAIChatWireMessage[] = [];
  let pendingToolCalls: {
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }[] | undefined;
  const flushToolCalls = (): void => {
    if (pendingToolCalls === undefined) return;
    messages.push({ role: 'assistant', content: '', tool_calls: pendingToolCalls });
    pendingToolCalls = undefined;
  };
  for (const unit of context.units) {
    switch (unit.kind) {
      case 'message':
        flushToolCalls();
        messages.push(unit.role === 'user'
          ? { role: 'user', content: unit.text }
          : { role: 'assistant', content: unit.text });
        break;
      case 'tool-call':
        if (pendingToolCalls === undefined) pendingToolCalls = [];
        pendingToolCalls.push({
          id: unit.callId,
          type: 'function',
          function: { name: responsesWireToolName(unit.toolId), arguments: JSON.stringify(unit.arguments) },
        });
        break;
      case 'tool-result':
        flushToolCalls();
        messages.push({ role: 'tool', tool_call_id: unit.callId, content: wireToolResultOutput(unit.output, unit.evidenceRefs) });
        break;
    }
  }
  flushToolCalls();
  return messages;
}

/**
 * The wire `execution` field is identity only. The request input, business
 * payload and request-scoped context never belong on it, so the codec emits a
 * plain identity ref instead of the whole execution input object.
 */
function isInteractionParentIdentity(
  execution: AnyProviderExecutionIdentityRef,
): execution is InteractionParentProviderExecutionIdentityRef {
  return 'interactionTurn' in execution && execution.interactionTurn !== undefined;
}

function executionIdentity<TIdentity extends AnyProviderExecutionIdentityRef>(execution: TIdentity): TIdentity {
  // A taskless helper execution is keyed by its full helper identity, so the
  // wire identity carries `helper` and never a `taskId`/`cycleId`. The input may
  // be a wider request object (identity plus request fields), so this normalises
  // it back to the canonical identity the caller passed.
  const identity: AnyProviderExecutionIdentityRef = 'helper' in execution && execution.helper !== undefined
    ? {
        runtimeId: execution.runtimeId,
        organId: execution.organId,
        operationId: execution.operationId,
        executionEpoch: execution.executionEpoch,
        helper: execution.helper,
      }
    : isInteractionParentIdentity(execution)
      ? {
          runtimeId: execution.runtimeId,
          organId: execution.organId,
          operationId: execution.operationId,
          executionEpoch: execution.executionEpoch,
          interactionTurn: execution.interactionTurn,
        }
    : {
        runtimeId: execution.runtimeId,
        taskId: execution.taskId,
        operationId: execution.operationId,
        ...(execution.organId === undefined ? {} : { organId: execution.organId }),
        ...(execution.cycleId === undefined ? {} : { cycleId: execution.cycleId }),
        executionEpoch: execution.executionEpoch,
      };
  // Construction boundary: `identity` is the canonical form of the caller's
  // identity. It is validated by assertProviderExecutionIdentity before any
  // control use, so the generic narrowing carries no unchecked field.
  return identity as TIdentity;
}

function businessText(
  execution: AnyProviderExecutionIdentityRef,
  payload: ProviderStartInput['payload'],
): string {
  if (payload === undefined) {
    throw new ProviderAdapterError({
      code: 'input.payload.missing',
      category: 'validation',
      phase: 'start',
      message: 'provider request requires business payload text',
      scope: execution,
    });
  }
  return JSON.stringify(payload);
}

const RESPONSES_TOOL_ID_TO_WIRE_NAME = new Map<string, string>([
  ['file.read', 'file_read'],
  ['file.list', 'file_list'],
  ['file.search', 'file_search'],
  ['file.write', 'file_write'],
  ['file.edit', 'file_edit'],
  ['web.search', 'web_search'],
  ['bash', 'bash'],
  ['todo_write', 'todo_write'],
  ['get_goal', 'get_goal'],
  ['create_goal', 'create_goal'],
  ['update_goal', 'update_goal'],
  ['present', 'present'],
  ['child.call', 'child_call'],
  ['child.adopt', 'child_adopt'],
  ['child.not_select', 'child_not_select'],
]);
const RESPONSES_WIRE_NAME_TO_TOOL_ID = new Map<string, string>([
  ['file_read', 'file.read'],
  ['file_list', 'file.list'],
  ['file_search', 'file.search'],
  ['file_write', 'file.write'],
  ['file_edit', 'file.edit'],
  ['web_search', 'web.search'],
  ['bash', 'bash'],
  ['todo_write', 'todo_write'],
  ['get_goal', 'get_goal'],
  ['create_goal', 'create_goal'],
  ['update_goal', 'update_goal'],
  ['present', 'present'],
  ['child_call', 'child.call'],
  ['child_adopt', 'child.adopt'],
  ['child_not_select', 'child.not_select'],
]);

/** Server-side tools the backend harness may invoke on the model's behalf. */
function responsesWireToolName(toolId: string): string {  const name = RESPONSES_TOOL_ID_TO_WIRE_NAME.get(toolId) ?? toolId;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new ProviderAdapterError({
      code: 'tool.name.unsupported',
      category: 'validation',
      phase: 'tool',
      message: `provider tool id has no registered Responses wire name: ${toolId}`,
    });
  }
  return name;
}

function responsesToolId(wireName: string): string {
  return RESPONSES_WIRE_NAME_TO_TOOL_ID.get(wireName) ?? wireName;
}

export interface DecodeContext<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly execution: TIdentity;
  readonly scope: ScopeRef;
  readonly evidence: ProviderEvidenceSink;
  readonly nextEventId: (type: string, locator: string) => string;
  readonly responsesOutputText: Map<string, string>;
  readonly responsesCurrentResponseId?: Map<string, string>;
  readonly responsesPendingToolCalls?: Set<string>;
  readonly responsesRequestStartEmitted: Map<string, boolean>;
  /** How many model rounds this one response stream has opened so far. A
   *  Responses request owns exactly one model round as its terminal output;
   *  rounds RCC opens by itself come from instructions the client never sent. */
  readonly responsesStreamRound: { count: number };
}

const REQUEST_START_SUMMARY = 'provider requested model work';
const RESPONSES_ADDITIONAL_ROUND_SUMMARY = 'provider opened an additional response round in this request; that round is not this request terminal output';

/** True once the stream has opened a second model round for the same request. */
function responsesAdditionalRound<TIdentity extends AnyProviderExecutionIdentityRef>(
  context: DecodeContext<TIdentity>,
): boolean {
  return context.responsesStreamRound.count > 1;
}

/** The turn facts one wire element contributes. A provider-initiated additional
 *  round contributes its tool control and the request outcome, but not its
 *  content: that text answers instructions this client never sent, so it must
 *  stay out of the terminal output instead of being appended to the real
 *  answer. Only the first round states what this request asked for. */
function turnContentFacts<TIdentity extends AnyProviderExecutionIdentityRef>(
  context: DecodeContext<TIdentity>,
  facts: readonly ProviderRawFact<TIdentity>[],
): readonly ProviderRawFact<TIdentity>[] {
  return responsesAdditionalRound(context) ? facts.filter((fact) => fact.kind !== 'content') : facts;
}

export interface ProviderDecodedEvent<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly events: readonly ProviderEvent<TIdentity>[];
  /**
   * Ordered typed raw facts produced from the same wire decode. The Runtime
   * (W1-3) assigns the exact-request `producerSeq` and acceptance order; the
   * codec only emits the fact content.
   */
  readonly rawFacts: readonly ProviderRawFact<TIdentity>[];
}

/**
 * Internal decode shape. Branches that carry raw content return `rawFacts`;
 * branches without raw content leave it undefined. `decodeEvent` normalises the
 * public shape so `rawFacts` is always present.
 */
interface DecodedWire<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly events: readonly ProviderEvent<TIdentity>[];
  readonly rawFacts?: readonly ProviderRawFact<TIdentity>[];
}

/** Request-local Anthropic block state used to close declared units on block stop. */
interface AnthropicBlockState {
  readonly type: 'text' | 'thinking' | 'tool_use';
  readonly channels: readonly ContentUnitChannel[];
  readonly callId?: string;
  readonly toolId?: string;
  readonly startArgumentsJson?: string;
  argumentsDelta: string;
}

/** Request-local Chat tool-call state assembled across streaming chunks. */
interface OpenAIChatPendingToolCall {
  readonly id?: string;
  readonly name?: string;
  readonly arguments: string;
}

/** Request-local Responses tool-argument stream. A stream stays open until its
 *  arguments.done or output_item.done closes it, so an item-less argument delta
 *  can only be a duplicate tail once no other argument stream is still open. */
interface ResponsesToolArgumentRun {
  closed: boolean;
}

interface CompletedResponsesToolArguments {
  readonly callId: string;
  readonly rawArgumentsJson: string;
  duplicateTailConsumed: boolean;
}

/** Task-bound and taskless-helper requests share one codec/wire path. */
type AnyProviderStartInput = ProviderStartInput<AnyProviderExecutionIdentityRef>;
type AnyProviderSubmitInput = ProviderSubmitInput<AnyProviderExecutionIdentityRef>;
type AnyProviderStopRequest = ProviderStopRequest<AnyProviderExecutionIdentityRef>;
type AnyProviderRequestInput = AnyProviderStartInput | ProviderResumeInput | AnyProviderSubmitInput;

export interface ProviderCodec<W extends ProviderWireRequest = ProviderWireRequest> {
  readonly protocol: 'responses' | 'anthropic' | 'openai';
  encodeStart(input: AnyProviderStartInput, binding: ProviderBinding, routeRef: string): W;
  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): W;
  encodeSubmit(input: AnyProviderSubmitInput, binding: ProviderBinding, routeRef: string): W;
  encodeStop(input: AnyProviderStopRequest, binding: ProviderBinding, routeRef: string): ProviderWireStopRequest;
  decodeEvent<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(
    raw: ProviderWireEvent,
    context: DecodeContext<TIdentity>,
  ): Promise<ProviderDecodedEvent<TIdentity>>;
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

function responsesTextSummary<TIdentity extends AnyProviderExecutionIdentityRef>(context: DecodeContext<TIdentity>, itemId: string, text: string, kind: 'delta' | 'snapshot'): string | undefined {
  if (text.length === 0) return undefined;
  const seen = context.responsesOutputText.get(itemId) ?? '';
  if (kind === 'delta') {
    context.responsesOutputText.set(itemId, `${seen}${text}`);
    return text;
  }
  const delta = text.startsWith(seen) ? text.slice(seen.length) : text;
  context.responsesOutputText.set(itemId, text);
  return delta.length > 0 ? delta : undefined;
}

// Reasoning content parts expose provider chain-of-thought. They are projected
// as model-class events (never business output) so a real provider stream that
// interleaves reasoning with output text cannot abort the execution.
const RESPONSES_REASONING_CONTENT_PART = 'reasoning_text';

function responsesReasoningSummaryText(record: Record<string, unknown>): string {
  if (typeof record.text === 'string') return record.text;
  const summary = record.summary;
  if (Array.isArray(summary)) {
    const text = summary
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .filter((entry) => typeof entry.text === 'string')
      .map((entry) => entry.text as string)
      .join('');
    if (text.length > 0) return text;
  }
  return '';
}

async function captureEvidence<TIdentity extends AnyProviderExecutionIdentityRef>(context: DecodeContext<TIdentity>, type: string, locator: string, value?: unknown, kind: EvidenceRef['kind'] = 'execution'): Promise<EvidenceRef> {
  return context.evidence.write({
    scope: context.scope,
    kind,
    type,
    locator,
    content: value ?? `${type}:${locator}`,
  });
}

function unitId(protocol: 'responses' | 'anthropic' | 'openai', channel: ContentUnitChannel, locator: string): string {
  return `${protocol}:${channel}:${locator}`;
}

function rawAsset(ref: EvidenceRef, view: RawAssetView): RawAsset {
  return { ref, view };
}

/**
 * The raw-fact kinds a codec emits never carry an execution identity. The
 * `tool-result` fact, which does, is produced by the driver from the real
 * `ProviderToolResult<TIdentity>`. So a codec fact is assignable to
 * `ProviderRawFact` for any identity generic.
 */
type ProviderRawFactContent = Extract<
  ProviderRawFact<AnyProviderExecutionIdentityRef>,
  { kind: 'content' | 'content-complete' | 'tool-call' | 'request-complete' }
>;

function contentFact(input: {
  readonly contentUnitId: string;
  readonly channel: ContentUnitChannel;
  readonly update: 'delta' | 'full';
  readonly content: RawAsset;
  readonly complete: boolean;
  readonly replacesUnitIds?: readonly string[];
}): ProviderRawFactContent {
  return {
    kind: 'content',
    contentUnitId: input.contentUnitId,
    channel: input.channel,
    update: input.update,
    content: input.content,
    complete: input.complete,
    ...(input.replacesUnitIds === undefined ? {} : { replacesUnitIds: input.replacesUnitIds }),
  };
}

function contentCompleteFact(contentUnitId: string): ProviderRawFactContent {
  return { kind: 'content-complete', contentUnitId };
}

function requestCompleteFact(
  terminal: 'completed' | 'incomplete' | 'failed' | 'cancelled',
  error?: ProviderError,
): ProviderRawFactContent {
  return { kind: 'request-complete', terminal, ...(error === undefined ? {} : { error }) };
}

function toolCallFact(contentUnitId: string, call: ProviderToolCall, rawArguments: RawAsset): ProviderRawFactContent {
  return { kind: 'tool-call', contentUnitId, call, rawArguments, complete: true };
}

function providerError(
  execution: AnyProviderExecutionIdentityRef,
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

function eventId<TIdentity extends AnyProviderExecutionIdentityRef>(context: DecodeContext<TIdentity>, type: string, locator: string): string {
  return context.nextEventId(type, locator);
}

/** Identity plus the fields every decoded Provider event carries before `kind`. */
type ProviderEventBase<TIdentity extends AnyProviderExecutionIdentityRef> = TIdentity & {
  readonly eventId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly externalResponseId?: string;
};

function eventBase<TIdentity extends AnyProviderExecutionIdentityRef>(
  execution: TIdentity,
  scope: ScopeRef,
  type: string,
  eventId: string,
  label: string,
  evidenceRefs?: readonly EvidenceRef[],
  externalResponseId?: string,
): ProviderEventBase<TIdentity> {
  return {
    ...executionIdentity(execution),
    eventId,
    evidenceRefs: evidenceRefs ?? [evidence(scope, label)],
    ...(externalResponseId === undefined ? {} : { externalResponseId }),
  };
}

function semanticModelSummary(type: string): string {
  switch (type) {
    case 'response.created':
    case 'response.in_progress':
    case 'message_start':
      return 'provider requested model work';
    case 'response.output_item.added':
    case 'response.output_item.done':
      return 'provider prepared model output';
    case 'response.reasoning_summary_part.added':
    case 'response.reasoning_summary_part.delta':
    case 'response.reasoning_summary_part.done':
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary_text.done':
    case 'response.reasoning_text.delta':
    case 'response.reasoning_text.done':
    case 'response.content_part.added':
    case 'response.content_part.done':
    case 'content_block_start':
      return 'provider provided model reasoning';
    case 'response.function_call_arguments.delta':
    case 'response.function_call_arguments.done':
    case 'content_block_delta':
      return 'provider completed tool request details';
    case 'message_delta':
      return 'provider completed model turn details';
    case 'ping':
      return 'provider sent heartbeat';
    default:
      return 'provider processed model event';
  }
}

function modelEvent<TIdentity extends AnyProviderExecutionIdentityRef>(
  execution: TIdentity,
  scope: ScopeRef,
  type: string,
  eventId: string,
  evidenceRefs?: readonly EvidenceRef[],
  summary?: string,
  externalResponseId?: string,
): ProviderEvent<TIdentity> {
  return {
    ...eventBase(execution, scope, type, eventId, type, evidenceRefs, externalResponseId),
    kind: 'model',
    summary: summary ?? semanticModelSummary(type),
  };
}

function outputEvent<TIdentity extends AnyProviderExecutionIdentityRef>(
  execution: TIdentity,
  scope: ScopeRef,
  type: string,
  eventId: string,
  outputRefs: readonly string[],
  evidenceRefs?: readonly EvidenceRef[],
  summary?: string,
  externalResponseId?: string,
): ProviderEvent<TIdentity> {
  return {
    ...eventBase(execution, scope, type, eventId, type, evidenceRefs, externalResponseId),
    kind: 'output',
    outputRefs,
    ...(summary === undefined ? {} : { summary }),
  };
}

function ownedEvent<TIdentity extends AnyProviderExecutionIdentityRef>(
  execution: TIdentity,
  scope: ScopeRef,
  kind: ProviderEvent['kind'],
  type: string,
  eventId: string,
  label: string,
  nextAction: NextAction,
  extra: {
    readonly terminalState?: ProviderEvent['terminalState'];
    readonly error?: ProviderError;
    readonly outputRefs?: readonly string[];
    readonly evidenceRefs?: readonly EvidenceRef[];
    readonly summary?: string;
    readonly toolCall?: ProviderEvent['toolCall'];
    readonly toolPhase?: ProviderEvent['toolPhase'];
    readonly externalResponseId?: string;
  } = {},
): ProviderEvent<TIdentity> {
  return {
    ...eventBase(execution, scope, type, eventId, label, undefined, extra.externalResponseId),
    kind,
    ownerId: OWNER,
    nextAction,
    ...(extra.terminalState === undefined ? {} : { terminalState: extra.terminalState }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
    ...(extra.outputRefs === undefined ? {} : { outputRefs: extra.outputRefs }),
    ...(extra.evidenceRefs === undefined ? {} : { evidenceRefs: extra.evidenceRefs }),
    ...(extra.summary === undefined ? {} : { summary: extra.summary }),
    ...(extra.toolCall === undefined ? {} : { toolCall: extra.toolCall }),
    ...(extra.toolPhase === undefined ? {} : { toolPhase: extra.toolPhase }),
    ...(extra.externalResponseId === undefined ? {} : { externalResponseId: extra.externalResponseId }),
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

function openAIFinishTerminal(reason: string): 'completed' | 'incomplete' | 'failed' {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
    case 'function_call':
      return 'completed';
    case 'length':
      return 'incomplete';
    default:
      return 'failed';
  }
}

function anthropicTerminal(stopReason: string | undefined): 'completed' | 'incomplete' | 'failed' {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
      return 'completed';
    case 'max_tokens':
    case 'pause_turn':
    case undefined:
      return 'incomplete';
    default:
      return 'failed';
  }
}

/**
 * Parses already-assembled fragmented tool-call arguments into a business
 * payload. Fragment assembly joins the real per-protocol fragments first; this
 * then fails closed on invalid JSON or a non-object shape, so a malformed call
 * never becomes an executable tool call.
 */
function parseToolArguments(json: string, execution: AnyProviderExecutionIdentityRef): BusinessPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || '{}');
  } catch (cause) {
    throw new ProviderAdapterError({
      code: 'tool.arguments.invalid-json',
      category: 'protocol',
      phase: 'tool',
      message: cause instanceof Error ? cause.message : 'provider tool arguments are invalid JSON',
      scope: execution,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderAdapterError({
      code: 'tool.arguments.invalid-shape',
      category: 'protocol',
      phase: 'tool',
      message: 'provider tool arguments must be a JSON object',
      scope: execution,
    });
  }
  return parsed as BusinessPayload;
}

/** One provider execution's request-local state key; shared by codec maps. */
function executionKey(execution: AnyProviderExecutionIdentityRef): string {
  if ('helper' in execution && execution.helper !== undefined) {
    // A taskless helper has no Task to key on. The full helper identity is the
    // collision-free key, so two helpers can never share request-local state.
    return canonicalJsonStringify([
      'taskless-helper',
      execution.runtimeId,
      execution.operationId.value,
      execution.executionEpoch,
      execution.helper.organId.scope,
      execution.helper.organId.value,
      execution.helper.interactionScopeId,
      execution.helper.interactionId,
      execution.helper.inputRevision,
      execution.helper.parentTurnId,
      execution.helper.assignmentId,
      execution.helper.helperCallId,
      execution.helper.attempt,
    ]);
  }
  if (isInteractionParentIdentity(execution)) {
    // A neutral interaction parent has no Task either; the real interaction turn
    // is the collision-free key.
    return canonicalJsonStringify([
      'interaction-parent',
      execution.runtimeId,
      execution.operationId.value,
      execution.executionEpoch,
      execution.organId.scope,
      execution.organId.value,
      execution.interactionTurn.interactionScopeId,
      execution.interactionTurn.interactionId,
      execution.interactionTurn.inputRevision,
      execution.interactionTurn.turnId,
    ]);
  }
  return `${execution.runtimeId}:${execution.taskId.value}:${execution.operationId.value}:${execution.executionEpoch}`;
}

function requireString(record: Record<string, unknown>, key: string, execution: AnyProviderExecutionIdentityRef, type: string): string {
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
  execution: AnyProviderExecutionIdentityRef,
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

function requireStringValue(record: Record<string, unknown>, key: string, execution: AnyProviderExecutionIdentityRef, type: string): string {
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

/**
 * Live Responses streams identify a function-call-scoped event by call_id and
 * may omit the item id entirely. Accept either, in that order, and still fail
 * closed when neither identity is present.
 */
function requireToolEventIdentity(record: Record<string, unknown>, execution: AnyProviderExecutionIdentityRef, type: string): string {
  for (const key of ['item_id', 'call_id'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  throw new ProviderAdapterError({
    code: 'missing.field',
    category: 'protocol',
    phase: 'observe',
    message: `${type} event missing item_id or call_id`,
    scope: execution,
  });
}

function requireNumber(record: Record<string, unknown>, key: string, execution: AnyProviderExecutionIdentityRef, type: string): number {
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

function requireObject(record: Record<string, unknown>, key: string, execution: AnyProviderExecutionIdentityRef, type: string): Record<string, unknown> {
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

function responseItemText(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object')
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
  return text.length > 0 ? text : undefined;
}

/**
 * The already-declared part-scoped assistant-text units a message item snapshot
 * covers. The item-level full snapshot supersedes those finer units.
 */
function responsesItemPartUnitIds(itemId: string, item: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(item.content)) return [];
  return item.content.map((_part, index) => unitId('responses', 'assistant-text', `${itemId}:${index}`));
}

function responsesReasoningLocator(itemId: string, record: Record<string, unknown>): string {
  const contentIndex = typeof record.content_index === 'number' ? record.content_index : undefined;
  return contentIndex === undefined ? itemId : `${itemId}:${contentIndex}`;
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
  private readonly toolArgumentRuns = new WeakMap<object, Map<string, ResponsesToolArgumentRun>>();
  private readonly completedToolArguments = new WeakMap<object, CompletedResponsesToolArguments>();

  private toolArgumentRunsFor<TIdentity extends AnyProviderExecutionIdentityRef>(
    context: DecodeContext<TIdentity>,
  ): Map<string, ResponsesToolArgumentRun> {
    let runs = this.toolArgumentRuns.get(context);
    if (runs === undefined) {
      runs = new Map();
      this.toolArgumentRuns.set(context, runs);
    }
    return runs;
  }

  private openToolArguments<TIdentity extends AnyProviderExecutionIdentityRef>(
    context: DecodeContext<TIdentity>,
    identities: readonly string[],
  ): void {
    const runs = this.toolArgumentRunsFor(context);
    const existing = identities.map((identity) => runs.get(identity)).find((run) => run !== undefined);
    if (existing !== undefined) {
      for (const identity of identities) runs.set(identity, existing);
      existing.closed = false;
      // Reopening a stream invalidates its previous completed window even when
      // the identity is reused: the old tail can no longer be proven current.
      this.completedToolArguments.delete(context);
      return;
    }
    // A brand-new tool-argument stream invalidates the previous completed window:
    // an item-less delta now has an ambiguous owner and must fail closed.
    this.completedToolArguments.delete(context);
    const run: ResponsesToolArgumentRun = { closed: false };
    for (const identity of identities) runs.set(identity, run);
  }

  private closeToolArguments<TIdentity extends AnyProviderExecutionIdentityRef>(
    context: DecodeContext<TIdentity>,
    identity: string,
  ): void {
    const runs = this.toolArgumentRunsFor(context);
    const run = runs.get(identity);
    if (run !== undefined) {
      run.closed = true;
      return;
    }
    // A completion for a stream the codec never saw is still a completed stream:
    // it must not make the completed-arguments window look like an open stream.
    runs.set(identity, { closed: true });
  }

  private rememberCompletedToolArguments<TIdentity extends AnyProviderExecutionIdentityRef>(
    context: DecodeContext<TIdentity>,
    identity: string,
    rawArgumentsJson: string,
  ): void {
    if (rawArgumentsJson.length === 0) return;
    this.completedToolArguments.set(context, { callId: identity, rawArgumentsJson, duplicateTailConsumed: false });
  }

  private hasOpenToolArguments<TIdentity extends AnyProviderExecutionIdentityRef>(
    context: DecodeContext<TIdentity>,
  ): boolean {
    for (const run of this.toolArgumentRunsFor(context).values()) {
      if (!run.closed) return true;
    }
    return false;
  }

  private consumeToolArgumentsTail<TIdentity extends AnyProviderExecutionIdentityRef>(
    context: DecodeContext<TIdentity>,
    delta: string,
  ): string | undefined {
    const completed = this.completedToolArguments.get(context);
    if (completed === undefined || this.hasOpenToolArguments(context)) return undefined;
    if (completed.duplicateTailConsumed) return undefined;
    if (delta.length === 0 || !completed.rawArgumentsJson.endsWith(delta)) return undefined;
    completed.duplicateTailConsumed = true;
    return completed.callId;
  }

  private clearToolArguments<TIdentity extends AnyProviderExecutionIdentityRef>(
    context: DecodeContext<TIdentity>,
  ): void {
    this.toolArgumentRuns.delete(context);
    this.completedToolArguments.delete(context);
  }

  encodeStart(input: AnyProviderStartInput, binding: ProviderBinding, routeRef: string): ResponsesWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.payload);
  }

  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): ResponsesWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.payload, input.checkpointId);
  }

  encodeSubmit(input: AnyProviderSubmitInput, binding: ProviderBinding, routeRef: string): ResponsesWireRequest {
    if (input.requestContext === undefined && input.toolContinuations !== undefined) {
      return {
        protocol: 'responses',
        type: 'responses.request',
        route: routeFor(binding, routeRef),
        model: binding.modelRef,
        instructions: harnessToolSurfaceInstructions(input.tools),
        input: [
          { type: 'message', role: 'user', content: businessText(input, input.payload) },
          ...input.toolContinuations.flatMap((continuation) => ([{
            type: 'function_call' as const,
            call_id: continuation.callId,
            name: responsesWireToolName(continuation.toolId),
            arguments: JSON.stringify(continuation.arguments),
          }, {
            type: 'function_call_output' as const,
            call_id: continuation.callId,
            output: wireToolResultOutput(continuation.output, continuation.evidenceRefs),
          }])),
        ],
        execution: executionIdentity(input),
        ...(input.tools === undefined || input.tools.length === 0 ? {} : {
          tools: input.tools.map((tool) => ({
            type: 'function' as const,
            name: responsesWireToolName(tool.toolId),
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }),
      };
    }
    return this.encodeRequest(binding, routeRef, input, input.payload);
  }

  encodeStop(input: AnyProviderStopRequest, binding: ProviderBinding, routeRef: string): ResponsesWireCancelRequest {
    return {
      protocol: 'responses',
      type: 'responses.cancel',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      reason: input.reason,
      execution: input,
    };
  }

  async decodeEvent<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(
    raw: ProviderWireEvent,
    context: DecodeContext<TIdentity>,
  ): Promise<ProviderDecodedEvent<TIdentity>> {
    const decoded = await this.decodeWire(raw, context);
    return { events: decoded.events, rawFacts: turnContentFacts(context, decoded.rawFacts ?? []) };
  }

  private async decodeWire<TIdentity extends AnyProviderExecutionIdentityRef>(
    raw: ProviderWireEvent,
    context: DecodeContext<TIdentity>,
  ): Promise<DecodedWire<TIdentity>> {
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
        if (raw.type === 'response.created') {
          context.responsesStreamRound.count += 1;
          this.clearToolArguments(context);
        }
        context.responsesCurrentResponseId?.set('current', responseId);
        const evidenceRefs = [await captureEvidence(context, raw.type, `response/${responseId}`, response)];
        if (responsesAdditionalRound(context)) {
          return raw.type === 'response.created'
            ? { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `response/${responseId}/round-${context.responsesStreamRound.count}`), evidenceRefs, RESPONSES_ADDITIONAL_ROUND_SUMMARY, responseId)] }
            : { events: [] };
        }
        const marked = context.responsesRequestStartEmitted.get(responseId);
        if (marked) return { events: [] };
        context.responsesRequestStartEmitted.set(responseId, true);
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `response/${responseId}`), evidenceRefs, REQUEST_START_SUMMARY, responseId)] };
      }
      case 'response.output_item.added': {
        requireNumber(record, 'output_index', context.execution, raw.type);
        const item = requireObject(record, 'item', context.execution, raw.type);
        const itemType = requireString(item, 'type', context.execution, raw.type);
        if (itemType === 'function_call') {
          const callId = requireString(item, 'call_id', context.execution, raw.type);
          this.openToolArguments(context, [callId]);
          const evidenceRefs = [await captureEvidence(context, raw.type, `tool/${callId}/started`, item)];
          return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `tool/${callId}/started`), evidenceRefs)] };
        }
        if (itemType === 'reasoning') {
          const itemId = stringOrGenerated(item, 'id', `rcc-reasoning-${record.output_index}`);
          const evidenceRefs = [await captureEvidence(context, raw.type, `reasoning/${itemId}`, item)];
          const summaryText = responsesReasoningSummaryText(item);
          return {
            events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
            rawFacts: summaryText.length === 0 ? [] : [contentFact({
              contentUnitId: unitId('responses', 'reasoning-summary', itemId),
              channel: 'reasoning-summary',
              update: 'full',
              content: rawAsset(evidenceRefs[0], { kind: 'reasoning-item', selector: 'summary' }),
              complete: false,
            })],
          };
        }
        if (itemType !== 'message') {
          throw new ProviderAdapterError({ code: 'unknown.output.item', category: 'protocol', phase: 'observe', message: `unknown responses output item type ${itemType}`, scope: context.execution });
        }
        const itemId = stringOrGenerated(item, 'id', `rcc-output-${record.output_index}`);
        const evidenceRefs = [await captureEvidence(context, raw.type, `output/${itemId}`, item)];
        const text = responseItemText(item);
        if (text === undefined || text === '') {
          return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `output/${itemId}`), evidenceRefs)] };
        }
        const replacesUnitIds = responsesItemPartUnitIds(itemId, item);
        return {
          events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `output/${itemId}`), [artifactRef(raw.type, `output/${itemId}`, evidenceRefs[0].digest)], evidenceRefs, responsesTextSummary(context, itemId, text, 'snapshot'))],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'assistant-text', itemId),
            channel: 'assistant-text',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'content-part', partIndex: 0 }),
            complete: false,
            ...(replacesUnitIds.length === 0 ? {} : { replacesUnitIds }),
          })],
        };
      }
      case 'response.output_text.delta': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const delta = requireStringValue(record, 'delta', context.execution, raw.type);
        const contentIndex = typeof record.content_index === 'number' ? record.content_index : undefined;
        const evidenceRefs = [await captureEvidence(context, raw.type, `text/${itemId}`, delta)];
        return {
          events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `text/${itemId}`), [artifactRef(raw.type, `text/${itemId}`, evidenceRefs[0].digest)], evidenceRefs, responsesTextSummary(context, itemId, delta, 'delta'))],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'assistant-text', contentIndex === undefined ? itemId : `${itemId}:${contentIndex}`),
            channel: 'assistant-text',
            update: 'delta',
            content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
            complete: false,
          })],
        };
      }
      case 'response.output_text.done': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const text = requireStringValue(record, 'text', context.execution, raw.type);
        const contentIndex = typeof record.content_index === 'number' ? record.content_index : undefined;
        const evidenceRefs = [await captureEvidence(context, raw.type, `text/${itemId}`, text)];
        return {
          events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `text/${itemId}`), [artifactRef(raw.type, `text/${itemId}`, evidenceRefs[0].digest)], evidenceRefs, responsesTextSummary(context, itemId, text, 'snapshot'))],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'assistant-text', contentIndex === undefined ? itemId : `${itemId}:${contentIndex}`),
            channel: 'assistant-text',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
            complete: true,
          })],
        };
      }
      case 'response.content_part.added': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        requireNumber(record, 'output_index', context.execution, raw.type);
        const contentIndex = requireNumber(record, 'content_index', context.execution, raw.type);
        const part = requireObject(record, 'part', context.execution, raw.type);
        const partType = requireString(part, 'type', context.execution, raw.type);
        const text = requireStringValue(part, 'text', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `part/${itemId}`, { type: partType, text })];
        if (partType === RESPONSES_REASONING_CONTENT_PART) {
          return {
            events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
            rawFacts: [contentFact({
              contentUnitId: unitId('responses', 'reasoning-text', `${itemId}:${contentIndex}`),
              channel: 'reasoning-text',
              update: 'full',
              content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'text' }),
              complete: false,
            })],
          };
        }
        if (partType !== 'output_text') {
          throw new ProviderAdapterError({
            code: 'unknown.content.part',
            category: 'protocol',
            phase: 'observe',
            message: `unknown responses content part type ${partType}`,
            scope: context.execution,
          });
        }
        return {
          events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `part/${itemId}`), [artifactRef(raw.type, `part/${itemId}`, evidenceRefs[0].digest)], evidenceRefs, responsesTextSummary(context, itemId, text, 'snapshot'))],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'assistant-text', `${itemId}:${contentIndex}`),
            channel: 'assistant-text',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'text' }),
            complete: false,
          })],
        };
      }
      case 'response.content_part.done': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        requireNumber(record, 'output_index', context.execution, raw.type);
        const contentIndex = requireNumber(record, 'content_index', context.execution, raw.type);
        const part = requireObject(record, 'part', context.execution, raw.type);
        const partType = requireString(part, 'type', context.execution, raw.type);
        const text = requireStringValue(part, 'text', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `part/${itemId}`, { type: partType, text })];
        if (partType === RESPONSES_REASONING_CONTENT_PART) {
          return {
            events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
            rawFacts: [contentFact({
              contentUnitId: unitId('responses', 'reasoning-text', `${itemId}:${contentIndex}`),
              channel: 'reasoning-text',
              update: 'full',
              content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'text' }),
              complete: true,
            })],
          };
        }
        return {
          events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `part/${itemId}`), [artifactRef(raw.type, `part/${itemId}`, evidenceRefs[0].digest)], evidenceRefs, responsesTextSummary(context, itemId, text, 'snapshot'))],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'assistant-text', `${itemId}:${contentIndex}`),
            channel: 'assistant-text',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'text' }),
            complete: true,
          })],
        };
      }
      case 'response.output_item.done': {
        requireNumber(record, 'output_index', context.execution, raw.type);
        const item = requireObject(record, 'item', context.execution, raw.type);
        const itemType = requireString(item, 'type', context.execution, raw.type);
        if (itemType === 'function_call') {
          const callId = requireString(item, 'call_id', context.execution, raw.type);
          const wireName = requireString(item, 'name', context.execution, raw.type);
          const name = responsesToolId(wireName);
          const argumentsJson = requireStringValue(item, 'arguments', context.execution, raw.type);
          this.closeToolArguments(context, callId);
          let args: unknown;
          try {
            args = JSON.parse(argumentsJson || '{}');
          } catch (cause) {
            throw new ProviderAdapterError({
              code: 'tool.arguments.invalid-json',
              category: 'protocol',
              phase: 'tool',
              message: cause instanceof Error ? cause.message : 'provider tool arguments are invalid JSON',
              scope: context.execution,
            });
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            throw new ProviderAdapterError({
              code: 'tool.arguments.invalid-shape',
              category: 'protocol',
              phase: 'tool',
              message: 'provider tool arguments must be a JSON object',
              scope: context.execution,
            });
          }
          const continuationRef = context.responsesCurrentResponseId?.get('current');
          if (!continuationRef) {
            throw new ProviderAdapterError({
              code: 'tool.continuation.missing',
              category: 'protocol',
              phase: 'tool',
              message: 'provider tool call is missing its response continuation identity',
              scope: context.execution,
            });
          }
          const evidenceRefs = [await captureEvidence(context, raw.type, `tool/${callId}`, { wireName, toolId: name, arguments: argumentsJson })];
          if (context.responsesPendingToolCalls?.has(callId)) {
            return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `tool/${callId}/duplicate`), evidenceRefs)] };
          }
          context.responsesPendingToolCalls?.add(callId);
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
                {
                  outputRefs: [artifactRef(raw.type, `tool/${callId}`, evidenceRefs[0].digest)],
                  evidenceRefs,
                  summary: `调用工具：${name}`,
                  toolCall: { callId, toolId: name, arguments: args as BusinessPayload, continuationRef },
                },
              ),
            ],
            rawFacts: [toolCallFact(
              unitId('responses', 'tool-arguments', callId),
              { callId, toolId: name, arguments: args as BusinessPayload, continuationRef },
              rawAsset(evidenceRefs[0], { kind: 'arguments' }),
            )],
          };
        }
        if (itemType === 'reasoning') {
          const itemId = stringOrGenerated(item, 'id', `rcc-reasoning-${record.output_index}`);
          const evidenceRefs = [await captureEvidence(context, raw.type, `reasoning/${itemId}`, item)];
          const summaryText = responsesReasoningSummaryText(item);
          return {
            events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
            rawFacts: summaryText.length === 0 ? [] : [contentFact({
              contentUnitId: unitId('responses', 'reasoning-summary', itemId),
              channel: 'reasoning-summary',
              update: 'full',
              content: rawAsset(evidenceRefs[0], { kind: 'reasoning-item', selector: 'summary' }),
              complete: true,
            })],
          };
        }
        if (itemType !== 'message') {
          throw new ProviderAdapterError({ code: 'unknown.output.item', category: 'protocol', phase: 'observe', message: `unknown responses output item type ${itemType}`, scope: context.execution });
        }
        const itemId = stringOrGenerated(item, 'id', `rcc-output-${record.output_index}`);
        const evidenceRefs = [await captureEvidence(context, raw.type, `output/${itemId}`, item)];
        const text = responseItemText(item);
        if (text === undefined || text === '') {
          return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `output/${itemId}`), evidenceRefs)] };
        }
        const replacesUnitIds = responsesItemPartUnitIds(itemId, item);
        return {
          events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `output/${itemId}`), [artifactRef(raw.type, `output/${itemId}`, evidenceRefs[0].digest)], evidenceRefs, responsesTextSummary(context, itemId, text, 'snapshot'))],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'assistant-text', itemId),
            channel: 'assistant-text',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'content-part', partIndex: 0 }),
            complete: true,
            ...(replacesUnitIds.length === 0 ? {} : { replacesUnitIds }),
          })],
        };
      }
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const part = requireObject(record, 'part', context.execution, raw.type);
        const text = responsesReasoningSummaryText(part);
        const evidenceRefs = [await captureEvidence(context, raw.type, `reasoning/${itemId}`, { type: raw.type, text })];
        return {
          events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'reasoning-summary', responsesReasoningLocator(itemId, record)),
            channel: 'reasoning-summary',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'text' }),
            complete: raw.type === 'response.reasoning_summary_part.done',
          })],
        };
      }
      case 'response.reasoning_summary_part.delta': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const delta = requireObject(record, 'delta', context.execution, raw.type);
        const text = responsesReasoningSummaryText(delta);
        const evidenceRefs = [await captureEvidence(context, raw.type, `reasoning/${itemId}`, { type: raw.type, text })];
        return {
          events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'reasoning-summary', responsesReasoningLocator(itemId, record)),
            channel: 'reasoning-summary',
            update: 'delta',
            content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'text' }),
            complete: false,
          })],
        };
      }
      case 'response.reasoning_summary_text.delta': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const delta = requireStringValue(record, 'delta', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `reasoning/${itemId}`, { type: raw.type, delta })];
        return {
          events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'reasoning-summary', responsesReasoningLocator(itemId, record)),
            channel: 'reasoning-summary',
            update: 'delta',
            content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'delta' }),
            complete: false,
          })],
        };
      }
      case 'response.reasoning_summary_text.done': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const text = requireStringValue(record, 'text', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `reasoning/${itemId}`, { type: raw.type, text })];
        return {
          events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'reasoning-summary', responsesReasoningLocator(itemId, record)),
            channel: 'reasoning-summary',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'text' }),
            complete: true,
          })],
        };
      }
      case 'response.reasoning_text.delta': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const delta = requireStringValue(record, 'delta', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `reasoning/${itemId}`, { type: raw.type, delta })];
        return {
          events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'reasoning-text', responsesReasoningLocator(itemId, record)),
            channel: 'reasoning-text',
            update: 'delta',
            content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'delta' }),
            complete: false,
          })],
        };
      }
      case 'response.reasoning_text.done': {
        const itemId = requireString(record, 'item_id', context.execution, raw.type);
        const text = requireStringValue(record, 'text', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `reasoning/${itemId}`, { type: raw.type, text })];
        return {
          events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `reasoning/${itemId}`), evidenceRefs)],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'reasoning-text', responsesReasoningLocator(itemId, record)),
            channel: 'reasoning-text',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'text-field', field: 'text' }),
            complete: true,
          })],
        };
      }
      case 'response.function_call_arguments.delta': {
        const delta = requireStringValue(record, 'delta', context.execution, raw.type);
        const hasItemIdentity = typeof record.item_id === 'string' && record.item_id.trim() !== '';
        const hasCallIdentity = typeof record.call_id === 'string' && record.call_id.trim() !== '';
        const completedTailCallId = !hasItemIdentity && !hasCallIdentity
          ? this.consumeToolArgumentsTail(context, delta)
          : undefined;
        if (completedTailCallId !== undefined) {
          const frame = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'protocol'));
          const evidenceRefs = [await captureEvidence(context, raw.type, `arguments/${completedTailCallId}/duplicate`, frame)];
          return {
            events: [modelEvent(
              context.execution,
              context.scope,
              raw.type,
              eventId(context, raw.type, `arguments/${completedTailCallId}/duplicate`),
              evidenceRefs,
            )],
          };
        }
        const unknownIdentity = !hasItemIdentity && !hasCallIdentity;
        if (unknownIdentity) {
          const frame = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'protocol'));
          const evidenceRefs = [await captureEvidence(context, raw.type, 'arguments/unidentified', frame)];
          const completed = this.completedToolArguments.get(context);
          if (completed === undefined) {
            throw new ProviderAdapterError({
              code: 'missing.field',
              category: 'protocol',
              phase: 'observe',
              message: `${raw.type} event missing item_id or call_id`,
              scope: context.execution,
              evidenceRefs,
            });
          }
          const reason = this.hasOpenToolArguments(context)
            ? 'another tool argument stream is still open'
            : delta.length === 0
              ? 'delta is empty'
              : !completed.rawArgumentsJson.endsWith(delta)
                ? 'delta is not an exact suffix of the completed arguments'
                : 'the completed arguments duplicate tail was already consumed';
          throw new ProviderAdapterError({
            code: 'protocol.duplicate-tail',
            category: 'protocol',
            phase: 'observe',
            message: `${raw.type} event missing item_id or call_id and ${reason}`,
            scope: context.execution,
            evidenceRefs,
          });
        }
        const itemId = requireToolEventIdentity(record, context.execution, raw.type);
        this.openToolArguments(context, [itemId]);
        const evidenceRefs = [await captureEvidence(context, raw.type, `arguments/${itemId}`, delta)];
        return {
          events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `arguments/${itemId}`), evidenceRefs)],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'tool-arguments', itemId),
            channel: 'tool-arguments',
            update: 'delta',
            content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
            complete: false,
          })],
        };
      }
      case 'response.function_call_arguments.done': {
        const itemId = requireToolEventIdentity(record, context.execution, raw.type);
        const args = requireStringValue(record, 'arguments', context.execution, raw.type);
        const evidenceRefs = [await captureEvidence(context, raw.type, `arguments/${itemId}`, args)];
        this.closeToolArguments(context, itemId);
        this.rememberCompletedToolArguments(context, itemId, args);
        return {
          events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `arguments/${itemId}`), [artifactRef(raw.type, `arguments/${itemId}`, evidenceRefs[0].digest)], evidenceRefs)],
          rawFacts: [contentFact({
            contentUnitId: unitId('responses', 'tool-arguments', itemId),
            channel: 'tool-arguments',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
            complete: true,
          })],
        };
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
        const waitingForTool = raw.type === 'response.completed' && (context.responsesPendingToolCalls?.size ?? 0) > 0;
        context.responsesPendingToolCalls?.clear();
        this.clearToolArguments(context);
        const next = raw.type === 'response.incomplete'
          ? { kind: 'wait' as const, ref: `provider-incomplete-${reason ?? 'unknown'}` }
          : waitingForTool
            ? { kind: 'continue' as const, ref: 'responses-tool-call' }
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
              { terminalState: raw.type === 'response.incomplete' || waitingForTool ? 'waiting' : 'succeeded', evidenceRefs, externalResponseId: responseId },
            ),
          ],
          rawFacts: [requestCompleteFact(raw.type === 'response.incomplete' ? 'incomplete' : 'completed')],
        };
      }
      case 'response.failed': {
        this.clearToolArguments(context);
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
          rawFacts: [requestCompleteFact('failed', error)],
        };
      }
      case 'error': {
        this.clearToolArguments(context);
        const errorRecord = requireObject(record, 'error', context.execution, raw.type);
        const code = requireString(errorRecord, 'code', context.execution, raw.type);
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const param = typeof errorRecord.param === 'string' ? errorRecord.param : undefined;
        const errorEvidence = await captureEvidence(context, raw.type, `error/${code}`, { code, message, ...(param === undefined ? {} : { param }) });
        const error = providerError(context.execution, context.scope, code, message, 'protocol', [errorEvidence]);
        return {
          events: [ownedEvent(context.execution, context.scope, 'error', raw.type, eventId(context, raw.type, `error/${code}`), `error-${code}`, { kind: 'recover', ref: OWNER }, { error })],
          rawFacts: [requestCompleteFact('failed', error)],
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
    execution: AnyProviderRequestInput,
    payload: ProviderStartInput['payload'],
    checkpointId?: { readonly scope: 'checkpoint'; readonly value: string },
  ): ResponsesWireRequest {
    const input: ResponsesWireRequest['input'] = execution.requestContext === undefined
      ? [{ type: 'message', role: 'user', content: businessText(execution, payload) }]
      : responsesContextInput(execution.requestContext);
    const tools: ResponsesWireTool[] = (execution.tools ?? []).map((tool) => ({
      type: 'function',
      name: responsesWireToolName(tool.toolId),
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    return {
      protocol: 'responses',
      type: 'responses.request',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      instructions: requestInstructions(execution.tools, execution.instructions),
      input,
      execution: executionIdentity(execution),
      ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(tools.length === 0 ? {} : { tools }),
    };
  }
}

export class OpenAIChatProviderCodec implements ProviderCodec<OpenAIChatWireRequest> {
  readonly protocol = 'openai' as const;

  /**
   * Fragmented assistant tool calls keyed by execution, chat completion id and
   * choice index, then by the wire tool index. Arguments arrive across several
   * chunks and the call id may arrive late; nothing is executable until the
   * finish_reason closes the call.
   */
  private readonly pendingToolCalls = new Map<string, Map<number, OpenAIChatPendingToolCall>>();

  encodeStart(input: AnyProviderStartInput, binding: ProviderBinding, routeRef: string): OpenAIChatWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.payload);
  }

  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): OpenAIChatWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.payload, input.checkpointId);
  }

  encodeSubmit(input: AnyProviderSubmitInput, binding: ProviderBinding, routeRef: string): OpenAIChatWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.payload);
  }

  encodeStop(input: AnyProviderStopRequest, binding: ProviderBinding, routeRef: string): OpenAIChatCancelRequest {
    return {
      protocol: 'openai',
      type: 'openai.cancel',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      reason: input.reason,
      execution: input,
    };
  }

  async decodeEvent<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(
    raw: ProviderWireEvent,
    context: DecodeContext<TIdentity>,
  ): Promise<ProviderDecodedEvent<TIdentity>> {
    const decoded = await this.decodeWire(raw, context);
    return { events: decoded.events, rawFacts: decoded.rawFacts ?? [] };
  }

  private async decodeWire<TIdentity extends AnyProviderExecutionIdentityRef>(
    raw: ProviderWireEvent,
    context: DecodeContext<TIdentity>,
  ): Promise<DecodedWire<TIdentity>> {
    if (raw.protocol !== 'openai') {
      throw new ProviderAdapterError({
        code: 'protocol.mismatch',
        category: 'protocol',
        phase: 'observe',
        message: 'openai codec received non-openai wire event',
        scope: context.execution,
      });
    }
    const record = asRecord(raw);
    switch (raw.type) {
      case 'openai.chat.completion': {
        const id = requireStringOrGenerated(record, 'id', context.execution, raw.type, `rcc-chat-${context.execution.executionEpoch}`);
        const choices = record.choices;
        if (!Array.isArray(choices)) {
          throw new ProviderAdapterError({
            code: 'missing.field',
            category: 'protocol',
            phase: 'observe',
            message: `${raw.type} event missing choices`,
            scope: context.execution,
          });
        }
        if (choices.length === 0) return { events: [], rawFacts: [] };
        const events: ProviderEvent<TIdentity>[] = [];
        const rawFacts: ProviderRawFact<TIdentity>[] = [];
        for (const candidate of choices) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new ProviderAdapterError({
              code: 'malformed.event',
              category: 'protocol',
              phase: 'observe',
              message: `${raw.type} choice must be an object`,
              scope: context.execution,
            });
          }
          const choice = candidate as Record<string, unknown>;
          const choiceIndex = requireNumber(choice, 'index', context.execution, raw.type);
          const delta = choice.delta;
          if (delta !== undefined && (!delta || typeof delta !== 'object' || Array.isArray(delta))) {
            throw new ProviderAdapterError({
              code: 'malformed.event',
              category: 'protocol',
              phase: 'observe',
              message: `${raw.type} delta must be an object`,
              scope: context.execution,
            });
          }
          const deltaRecord = (delta ?? {}) as Record<string, unknown>;
          const content = deltaRecord.content;
          if (content !== undefined && content !== null && typeof content !== 'string') {
            throw new ProviderAdapterError({
              code: 'malformed.event',
              category: 'protocol',
              phase: 'observe',
              message: `${raw.type} content must be a string or null`,
              scope: context.execution,
            });
          }
          if (typeof content === 'string' && content.length > 0) {
            const evidenceRefs = [await captureEvidence(context, raw.type, `text/${id}/${choiceIndex}`, content)];
            events.push(outputEvent(
              context.execution,
              context.scope,
              raw.type,
              eventId(context, raw.type, `text/${id}/${choiceIndex}`),
              [artifactRef(raw.type, `text/${id}/${choiceIndex}`, evidenceRefs[0].digest)],
              evidenceRefs,
              content,
            ));
            rawFacts.push(contentFact({
              contentUnitId: unitId('openai', 'assistant-text', `${id}:${choiceIndex}`),
              channel: 'assistant-text',
              update: 'delta',
              content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
              complete: false,
            }));
          }
          const toolCalls = deltaRecord.tool_calls;
          if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
            throw new ProviderAdapterError({
              code: 'malformed.event',
              category: 'protocol',
              phase: 'observe',
              message: `${raw.type} tool_calls must be an array`,
              scope: context.execution,
            });
          }
          const pendingKey = `${executionKey(context.execution)}:${id}:${choiceIndex}`;
          for (const toolCall of toolCalls ?? []) {
            if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
              throw new ProviderAdapterError({
                code: 'malformed.event',
                category: 'protocol',
                phase: 'observe',
                message: `${raw.type} tool call must be an object`,
                scope: context.execution,
              });
            }
            const toolRecord = toolCall as Record<string, unknown>;
            const toolIndex = requireNumber(toolRecord, 'index', context.execution, raw.type);
            const functionRecord = toolRecord.function;
            if (functionRecord !== undefined && (!functionRecord || typeof functionRecord !== 'object' || Array.isArray(functionRecord))) {
              throw new ProviderAdapterError({
                code: 'malformed.event',
                category: 'protocol',
                phase: 'observe',
                message: `${raw.type} tool function must be an object`,
                scope: context.execution,
              });
            }
            const functionValue = (functionRecord ?? {}) as Record<string, unknown>;
            const wireCallId = typeof toolRecord.id === 'string' && toolRecord.id.trim() ? toolRecord.id : undefined;
            const callId = wireCallId ?? `tool-${id}-${toolIndex}`;
            const name = typeof functionValue.name === 'string' && functionValue.name.trim() ? functionValue.name : undefined;
            const argumentsDelta = typeof functionValue.arguments === 'string' ? functionValue.arguments : undefined;
            if (name === undefined && argumentsDelta === undefined) continue;
            // Accumulate the real fragments; nothing is executable until the
            // finish_reason closes the call and the arguments parse.
            let pending = this.pendingToolCalls.get(pendingKey);
            if (pending === undefined) {
              pending = new Map();
              this.pendingToolCalls.set(pendingKey, pending);
            }
            const current = pending.get(toolIndex) ?? { arguments: '' };
            pending.set(toolIndex, {
              ...(wireCallId === undefined ? (current.id === undefined ? {} : { id: current.id }) : { id: wireCallId }),
              ...(name === undefined ? (current.name === undefined ? {} : { name: current.name }) : { name }),
              arguments: `${current.arguments}${argumentsDelta ?? ''}`,
            });
            const evidenceRefs = [await captureEvidence(context, raw.type, `tool/${callId}`, {
              ...(name === undefined ? {} : { name }),
              ...(argumentsDelta === undefined ? {} : { arguments: argumentsDelta }),
            })];
            if (argumentsDelta !== undefined) {
              rawFacts.push(contentFact({
                contentUnitId: unitId('openai', 'tool-arguments', `${id}:${choiceIndex}:${toolIndex}`),
                channel: 'tool-arguments',
                update: 'delta',
                content: rawAsset(evidenceRefs[0], { kind: 'arguments' }),
                complete: false,
              }));
            }
            events.push(ownedEvent(
              context.execution,
              context.scope,
              'tool',
              raw.type,
              eventId(context, raw.type, `tool/${callId}/${toolIndex}`),
              `tool-${callId}`,
              { kind: 'continue' },
              {
                outputRefs: [artifactRef(raw.type, `tool/${callId}`, evidenceRefs[0].digest)],
                evidenceRefs,
                ...(name === undefined ? {} : { summary: `调用工具：${name}` }),
                toolPhase: 'invoke',
              },
            ));
          }
          const finishReason = choice.finish_reason;
          if (finishReason !== undefined && finishReason !== null && typeof finishReason !== 'string') {
            throw new ProviderAdapterError({
              code: 'malformed.event',
              category: 'protocol',
              phase: 'observe',
              message: `${raw.type} finish_reason must be a string or null`,
              scope: context.execution,
            });
          }
          if (typeof finishReason === 'string') {
            const evidenceRefs = [await captureEvidence(context, raw.type, `finish/${id}/${choiceIndex}`, finishReason)];
            const mapping = mapOpenAIFinishReason(finishReason);
            const pending = this.pendingToolCalls.get(pendingKey);
            this.pendingToolCalls.delete(pendingKey);
            if (mapping.terminalState === 'waiting' && (finishReason === 'tool_calls' || finishReason === 'function_call')) {
              for (const [toolIndex, pendingCall] of [...(pending ?? new Map<number, OpenAIChatPendingToolCall>()).entries()].sort((left, right) => left[0] - right[0])) {
                if (pendingCall.name === undefined) {
                  throw new ProviderAdapterError({
                    code: 'missing.field',
                    category: 'protocol',
                    phase: 'tool',
                    message: `${raw.type} tool call missing function name`,
                    scope: context.execution,
                  });
                }
                const callId = pendingCall.id ?? `tool-${id}-${toolIndex}`;
                const toolId = responsesToolId(pendingCall.name);
                const argumentsValue = parseToolArguments(pendingCall.arguments, context.execution);
                const toolEvidenceRefs = [await captureEvidence(context, raw.type, `tool/${callId}/typed`, {
                  name: pendingCall.name,
                  arguments: pendingCall.arguments,
                })];
                events.push(ownedEvent(
                  context.execution,
                  context.scope,
                  'tool',
                  raw.type,
                  eventId(context, raw.type, `tool/${callId}/typed`),
                  `tool-${callId}`,
                  { kind: 'continue' },
                  {
                    outputRefs: [artifactRef(raw.type, `tool/${callId}/typed`, toolEvidenceRefs[0].digest)],
                    evidenceRefs: toolEvidenceRefs,
                    summary: `调用工具：${toolId}`,
                    toolCall: { callId, toolId, arguments: argumentsValue, continuationRef: id },
                  },
                ));
                rawFacts.push(toolCallFact(
                  unitId('openai', 'tool-arguments', `${id}:${choiceIndex}:${toolIndex}`),
                  { callId, toolId, arguments: argumentsValue, continuationRef: id },
                  rawAsset(toolEvidenceRefs[0], { kind: 'arguments' }),
                ));
              }
            }
            const error = mapping.errorCode
              ? providerError(
                  context.execution,
                  context.scope,
                  mapping.errorCode,
                  mapping.errorMessage ?? `OpenAI chat finish_reason ${finishReason} stopped the stream`,
                  'provider',
                  evidenceRefs,
                )
              : undefined;
            if (error) {
              events.push(ownedEvent(
                context.execution,
                context.scope,
                'error',
                raw.type,
                eventId(context, raw.type, `finish/${id}/${choiceIndex}/error`),
                mapping.errorCode ?? 'openai.finish_reason.error',
                mapping.nextAction,
                { error, evidenceRefs },
              ));
            }
            events.push(ownedEvent(
              context.execution,
              context.scope,
              'terminal',
              raw.type,
              eventId(context, raw.type, `finish/${id}/${choiceIndex}`),
              `finish-${finishReason}`,
              mapping.nextAction,
              { terminalState: mapping.terminalState, evidenceRefs },
            ));
            rawFacts.push(requestCompleteFact(openAIFinishTerminal(finishReason), error));
          }
        }
        return { events, rawFacts };
      }
      case 'error': {
        const errorRecord = requireObject(record, 'error', context.execution, raw.type);
        const code = typeof errorRecord.code === 'string' && errorRecord.code.trim()
          ? errorRecord.code
          : typeof errorRecord.type === 'string' && errorRecord.type.trim()
            ? errorRecord.type
            : 'provider.failed';
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const errorEvidence = await captureEvidence(context, raw.type, `error/${code}`, errorRecord);
        const error = providerError(context.execution, context.scope, code, message, 'provider', [errorEvidence]);
        return {
          events: [
            ownedEvent(context.execution, context.scope, 'error', raw.type, eventId(context, raw.type, `error/${code}`), `error-${code}`, { kind: 'recover', ref: OWNER }, { error }),
            ownedEvent(context.execution, context.scope, 'terminal', raw.type, eventId(context, raw.type, `terminal/${code}`), `terminal-${code}`, { kind: 'recover', ref: OWNER }, { terminalState: 'failed' }),
          ],
          rawFacts: [requestCompleteFact('failed', error)],
        };
      }
      default:
        throw new ProviderAdapterError({
          code: 'unknown.event',
          category: 'protocol',
          phase: 'observe',
          message: 'unknown openai wire event type',
          scope: context.execution,
        });
    }
  }

  private encodeRequest(
    binding: ProviderBinding,
    routeRef: string,
    execution: AnyProviderRequestInput,
    payload: ProviderStartInput['payload'],
    checkpointId?: { readonly scope: 'checkpoint'; readonly value: string },
  ): OpenAIChatWireRequest {
    // The transient orientation (with the harness tool-surface guidance) is a
    // request-local system message, never part of the canonical units. When a
    // typed context is bound, its units replace the legacy payload string.
    const messages: OpenAIChatWireMessage[] = [];
    if (execution.requestContext !== undefined) {
      const systemText = requestInstructions(execution.tools, execution.instructions);
      if (systemText.length > 0) messages.push({ role: 'system', content: systemText });
      messages.push(...openaiChatContextMessages(execution.requestContext));
    } else if (execution.instructions !== undefined) {
      const systemText = requestInstructions(execution.tools, execution.instructions);
      if (systemText.length > 0) messages.push({ role: 'system', content: systemText });
      messages.push({ role: 'user', content: businessText(execution, payload) });
    } else {
      messages.push({ role: 'user', content: businessText(execution, payload) });
    }
    const tools: OpenAIChatWireTool[] = execution.requestContext === undefined
      ? []
      : (execution.tools ?? []).map((tool) => ({
          type: 'function',
          function: { name: responsesWireToolName(tool.toolId), description: tool.description, parameters: tool.inputSchema },
        }));
    return {
      protocol: 'openai',
      type: 'openai.chat.request',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      messages,
      execution: executionIdentity(execution),
      ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(tools.length === 0 ? {} : { tools }),
    };
  }
}

export class AnthropicProviderCodec implements ProviderCodec<AnthropicWireRequest> {
  readonly protocol = 'anthropic' as const;

  private readonly stopReasons = new Map<string, string>();
  private readonly messageIds = new Map<string, string>();
  private readonly blocks = new Map<string, AnthropicBlockState>();

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

  encodeStart(input: AnyProviderStartInput, binding: ProviderBinding, routeRef: string): AnthropicWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.payload);
  }

  encodeResume(input: ProviderResumeInput, binding: ProviderBinding, routeRef: string): AnthropicWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.payload, input.checkpointId);
  }

  encodeSubmit(input: AnyProviderSubmitInput, binding: ProviderBinding, routeRef: string): AnthropicWireRequest {
    return this.encodeRequest(binding, routeRef, input, input.payload);
  }

  encodeStop(input: AnyProviderStopRequest, binding: ProviderBinding, routeRef: string): AnthropicWireCancelRequest {
    return {
      protocol: 'anthropic',
      type: 'anthropic.cancel',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      reason: input.reason,
      execution: input,
    };
  }

  async decodeEvent<TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(
    raw: ProviderWireEvent,
    context: DecodeContext<TIdentity>,
  ): Promise<ProviderDecodedEvent<TIdentity>> {
    const decoded = await this.decodeWire(raw, context);
    return { events: decoded.events, rawFacts: decoded.rawFacts ?? [] };
  }

  private async decodeWire<TIdentity extends AnyProviderExecutionIdentityRef>(
    raw: ProviderWireEvent,
    context: DecodeContext<TIdentity>,
  ): Promise<DecodedWire<TIdentity>> {
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
        this.messageIds.set(this.stopReasonKey(context.execution), messageId);
        const evidenceRefs = [await captureEvidence(context, raw.type, `message/${messageId}`)];
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `message/${messageId}`), evidenceRefs, 'provider requested model work', messageId)] };
      }
      case 'content_block_start': {
        const index = requireNumber(record, 'index', context.execution, raw.type);
        const blockRecord = requireObject(record, 'content_block', context.execution, raw.type);
        const blockType = requireString(blockRecord, 'type', context.execution, raw.type);
        if (blockType === 'tool_use') {
          const callId = requireString(blockRecord, 'id', context.execution, raw.type);
          const name = requireString(blockRecord, 'name', context.execution, raw.type);
          const input = requireObject(blockRecord, 'input', context.execution, raw.type);
          const startArgumentsJson = JSON.stringify(input);
          this.blocks.set(this.blockKey(context.execution, index), {
            type: 'tool_use',
            channels: ['tool-arguments'],
            callId,
            toolId: name,
            startArgumentsJson,
            argumentsDelta: '',
          });
          const evidenceRefs = [await captureEvidence(context, raw.type, `tool/${callId}`, { name, input, arguments: startArgumentsJson })];
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
                { outputRefs: [artifactRef(raw.type, `tool/${callId}`, evidenceRefs[0].digest)], evidenceRefs, summary: `调用工具：${name}`, toolPhase: 'invoke' },
              ),
            ],
            rawFacts: [contentFact({
              contentUnitId: unitId('anthropic', 'tool-arguments', String(index)),
              channel: 'tool-arguments',
              update: 'full',
              content: rawAsset(evidenceRefs[0], { kind: 'arguments' }),
              complete: false,
            })],
          };
        }
        if (blockType === 'text') {
          const text = requireStringValue(blockRecord, 'text', context.execution, raw.type);
          this.blocks.set(this.blockKey(context.execution, index), { type: 'text', channels: ['assistant-text'], argumentsDelta: '' });
          const evidenceRefs = [await captureEvidence(context, raw.type, `block/${String(index)}`, text)];
          return {
            events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `block/${String(index)}`), [artifactRef(raw.type, `block/${String(index)}`, evidenceRefs[0].digest)], evidenceRefs, text)],
            rawFacts: [contentFact({
              contentUnitId: unitId('anthropic', 'assistant-text', String(index)),
              channel: 'assistant-text',
              update: 'full',
              content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
              complete: false,
            })],
          };
        }
        if (blockType === 'thinking') {
          const thinking = requireStringValue(blockRecord, 'thinking', context.execution, raw.type);
          const signature = typeof blockRecord.signature === 'string' ? blockRecord.signature : undefined;
          this.blocks.set(this.blockKey(context.execution, index), {
            type: 'thinking',
            channels: signature === undefined ? ['reasoning-text'] : ['reasoning-text', 'reasoning-signature'],
            argumentsDelta: '',
          });
          const evidenceRefs = [await captureEvidence(context, raw.type, `thinking/${String(index)}`, { thinking, ...(signature === undefined ? {} : { signature }) })];
          const rawFacts: ProviderRawFact<TIdentity>[] = [contentFact({
            contentUnitId: unitId('anthropic', 'reasoning-text', String(index)),
            channel: 'reasoning-text',
            update: 'full',
            content: rawAsset(evidenceRefs[0], { kind: 'thinking-field', field: 'thinking' }),
            complete: false,
          })];
          if (signature !== undefined) {
            rawFacts.push(contentFact({
              contentUnitId: unitId('anthropic', 'reasoning-signature', String(index)),
              channel: 'reasoning-signature',
              update: 'full',
              content: rawAsset(evidenceRefs[0], { kind: 'thinking-field', field: 'signature' }),
              complete: false,
            }));
          }
          return {
            events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `thinking/${String(index)}`), evidenceRefs)],
            rawFacts,
          };
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
        const index = requireNumber(record, 'index', context.execution, raw.type);
        const deltaRecord = requireObject(record, 'delta', context.execution, raw.type);
        const deltaType = requireString(deltaRecord, 'type', context.execution, raw.type);
        if (deltaType === 'text_delta') {
          const text = requireStringValue(deltaRecord, 'text', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `text/${String(index)}`, text)];
          return {
            events: [outputEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `text/${String(index)}`), [artifactRef(raw.type, `text/${String(index)}`, evidenceRefs[0].digest)], evidenceRefs, text)],
            rawFacts: [contentFact({
              contentUnitId: unitId('anthropic', 'assistant-text', String(index)),
              channel: 'assistant-text',
              update: 'delta',
              content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
              complete: false,
            })],
          };
        }
        if (deltaType === 'thinking_delta') {
          const thinking = requireStringValue(deltaRecord, 'thinking', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `thinking/${String(index)}`, thinking)];
          return {
            events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `thinking/${String(index)}`), evidenceRefs, 'provider provided model reasoning')],
            rawFacts: [contentFact({
              contentUnitId: unitId('anthropic', 'reasoning-text', String(index)),
              channel: 'reasoning-text',
              update: 'delta',
              content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
              complete: false,
            })],
          };
        }
        if (deltaType === 'signature_delta') {
          const signature = requireStringValue(deltaRecord, 'signature', context.execution, raw.type);
          const evidenceRefs = [await captureEvidence(context, raw.type, `signature/${String(index)}`, signature)];
          return {
            events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `signature/${String(index)}`), evidenceRefs, 'provider completed reasoning signature')],
            rawFacts: [contentFact({
              contentUnitId: unitId('anthropic', 'reasoning-signature', String(index)),
              channel: 'reasoning-signature',
              update: 'delta',
              content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
              complete: false,
            })],
          };
        }
        if (deltaType === 'input_json_delta') {
          const partialJson = requireStringValue(deltaRecord, 'partial_json', context.execution, raw.type);
          const block = this.blocks.get(this.blockKey(context.execution, index));
          if (block) block.argumentsDelta += partialJson;
          const evidenceRefs = [await captureEvidence(context, raw.type, `input-json/${String(index)}`, partialJson)];
          return {
            events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `input-json/${String(index)}`), evidenceRefs, 'provider completed tool request details')],
            rawFacts: [contentFact({
              contentUnitId: unitId('anthropic', 'tool-arguments', String(index)),
              channel: 'tool-arguments',
              update: 'delta',
              content: rawAsset(evidenceRefs[0], { kind: 'utf8-text' }),
              complete: false,
            })],
          };
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
      {
        const index = requireNumber(record, 'index', context.execution, raw.type);
        const blockKey = this.blockKey(context.execution, index);
        const block = this.blocks.get(blockKey);
        this.blocks.delete(blockKey);
        const rawFacts: ProviderRawFact<TIdentity>[] = [];
        const events: ProviderEvent<TIdentity>[] = [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `block/${String(index)}`), [await captureEvidence(context, raw.type, `block/${String(index)}`)])];
        if (block) {
          for (const channel of block.channels) rawFacts.push(contentCompleteFact(unitId('anthropic', channel, String(index))));
          if (block.type === 'tool_use' && block.callId !== undefined && block.toolId !== undefined) {
            const continuationRef = this.messageIds.get(this.stopReasonKey(context.execution));
            if (continuationRef === undefined) {
              throw new ProviderAdapterError({
                code: 'tool.continuation.missing',
                category: 'protocol',
                phase: 'tool',
                message: 'anthropic tool call is missing its message continuation identity',
                scope: context.execution,
              });
            }
            const argumentsJson = block.argumentsDelta.length > 0 ? block.argumentsDelta : block.startArgumentsJson ?? '';
            const parsed = parseToolArguments(argumentsJson, context.execution);
            const toolId = responsesToolId(block.toolId);
            const argumentsEvidence = await captureEvidence(context, raw.type, `tool/${block.callId}/arguments`, { arguments: argumentsJson });
            rawFacts.push(toolCallFact(
              unitId('anthropic', 'tool-arguments', String(index)),
              { callId: block.callId, toolId, arguments: parsed, continuationRef },
              rawAsset(argumentsEvidence, { kind: 'arguments' }),
            ));
            events.push(ownedEvent(
              context.execution,
              context.scope,
              'tool',
              raw.type,
              eventId(context, raw.type, `tool/${block.callId}/typed`),
              `tool-${block.callId}`,
              { kind: 'continue' },
              {
                outputRefs: [artifactRef(raw.type, `tool/${block.callId}/typed`, argumentsEvidence.digest)],
                evidenceRefs: [argumentsEvidence],
                summary: `调用工具：${toolId}`,
                toolCall: { callId: block.callId, toolId, arguments: parsed, continuationRef },
              },
            ));
          }
        }
        return {
          events,
          rawFacts,
        };
      }
      case 'message_delta':
      {
        const delta = requireObject(record, 'delta', context.execution, raw.type);
        const stopReason = typeof delta.stop_reason === 'string' ? delta.stop_reason : undefined;
        if (stopReason) this.stopReasons.set(this.stopReasonKey(context.execution), stopReason);
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, `delta/${stopReason ?? 'none'}`), [await captureEvidence(context, raw.type, `delta/${stopReason ?? 'none'}`)], 'provider completed model turn details')] };
      }
      case 'message_stop': {
        const stopReason = this.stopReasons.get(this.stopReasonKey(context.execution));
        this.stopReasons.delete(this.stopReasonKey(context.execution));
        this.messageIds.delete(this.stopReasonKey(context.execution));
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
          rawFacts: [requestCompleteFact(anthropicTerminal(stopReason))],
        };
      }
      case 'ping': {
        const evidenceRefs = [await captureEvidence(context, raw.type, 'ping')];
        return { events: [modelEvent(context.execution, context.scope, raw.type, eventId(context, raw.type, 'ping'), evidenceRefs, 'provider sent heartbeat')] };
      }
      case 'error': {
        const errorRecord = requireObject(record, 'error', context.execution, raw.type);
        const code = requireString(errorRecord, 'type', context.execution, raw.type);
        const message = requireString(errorRecord, 'message', context.execution, raw.type);
        const errorEvidence = await captureEvidence(context, raw.type, `error/${code}`, errorRecord);
        const error = providerError(context.execution, context.scope, code, message, 'provider', [errorEvidence]);
        return {
          events: [ownedEvent(context.execution, context.scope, 'error', raw.type, eventId(context, raw.type, `error/${code}`), `error-${code}`, { kind: 'recover', ref: OWNER }, { error })],
          rawFacts: [requestCompleteFact('failed', error)],
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

  private stopReasonKey(execution: AnyProviderExecutionIdentityRef): string {
    return executionKey(execution);
  }

  private blockKey(execution: AnyProviderExecutionIdentityRef, index: number): string {
    return `${this.stopReasonKey(execution)}:${index}`;
  }

  private encodeRequest(
    binding: ProviderBinding,
    routeRef: string,
    execution: AnyProviderRequestInput,
    payload: ProviderStartInput['payload'],
    checkpointId?: { readonly scope: 'checkpoint'; readonly value: string },
  ): AnthropicWireRequest {
    const messages: AnthropicWireMessage[] = execution.requestContext === undefined
      ? [{ role: 'user', content: [{ type: 'text', text: businessText(execution, payload) }] }]
      : [...anthropicContextMessages(execution.requestContext)];
    const tools: AnthropicWireTool[] = (execution.tools ?? []).map((tool) => ({
      name: tool.toolId,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    return {
      protocol: 'anthropic',
      type: 'anthropic.request',
      route: routeFor(binding, routeRef),
      model: binding.modelRef,
      max_tokens: this.maxTokens,
      system: execution.instructions?.text ?? '',
      messages,
      execution: executionIdentity(execution),
      ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(tools.length === 0 ? {} : { tools }),
    };
  }
}

export type { AnthropicWireContentBlock, AnthropicWireContentBlockStart, AnthropicWireDelta, AnthropicWireEvent, AnthropicWireRequest, OpenAIChatWireEvent, OpenAIChatWireRequest, ResponsesWireEvent, ResponsesWireRequest };
