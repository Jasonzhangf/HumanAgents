import type { BusinessPayload, CheckpointId, ProviderExecutionIdentityRef } from '../../../contracts/src/index.js';

export type ProviderProtocol = 'responses' | 'anthropic' | 'openai' | 'other-explicit';

export interface ResponsesWireRequest {
  readonly protocol: 'responses';
  readonly type: 'responses.request';
  readonly route: string;
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly ResponsesWireInputItem[];
  readonly tools?: readonly ResponsesWireTool[];
  readonly execution: ProviderExecutionIdentityRef;
  readonly checkpointId?: CheckpointId;
}

export type ResponsesWireInputItem =
  | { readonly type: 'message'; readonly role: 'user' | 'system'; readonly content: string }
  | { readonly type: 'function_call'; readonly call_id: string; readonly name: string; readonly arguments: string }
  | { readonly type: 'function_call_output'; readonly call_id: string; readonly output: string };

export interface ResponsesWireTool {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: BusinessPayload;
}

export type ResponsesWireEvent =
  | { readonly protocol: 'responses'; readonly type: 'response.created'; readonly response: { readonly id: string; readonly model?: string } }
  | { readonly protocol: 'responses'; readonly type: 'response.in_progress'; readonly response: { readonly id: string } }
  | { readonly protocol: 'responses'; readonly type: 'response.output_item.added'; readonly output_index: number; readonly item: ResponsesWireOutputItem }
  | { readonly protocol: 'responses'; readonly type: 'response.output_text.delta'; readonly item_id: string; readonly output_index?: number; readonly content_index?: number; readonly delta: string }
  | { readonly protocol: 'responses'; readonly type: 'response.output_text.done'; readonly item_id: string; readonly output_index?: number; readonly content_index?: number; readonly text: string }
  | { readonly protocol: 'responses'; readonly type: 'response.content_part.added'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly part: { readonly type: 'output_text'; readonly text: string; readonly annotations?: readonly unknown[] } }
  | { readonly protocol: 'responses'; readonly type: 'response.content_part.done'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly part: { readonly type: 'output_text'; readonly text: string; readonly annotations?: readonly unknown[] } }
  | { readonly protocol: 'responses'; readonly type: 'response.output_item.done'; readonly output_index: number; readonly item: ResponsesWireOutputItem }
  | { readonly protocol: 'responses'; readonly type: 'response.reasoning_summary_part.added'; readonly item_id: string; readonly output_index?: number; readonly content_index?: number; readonly part: ResponsesWireReasoningSummaryPart }
  | { readonly protocol: 'responses'; readonly type: 'response.reasoning_summary_part.delta'; readonly item_id: string; readonly output_index?: number; readonly content_index?: number; readonly delta: ResponsesWireReasoningSummaryDelta }
  | { readonly protocol: 'responses'; readonly type: 'response.reasoning_summary_part.done'; readonly item_id: string; readonly output_index?: number; readonly content_index?: number; readonly part: ResponsesWireReasoningSummaryPart }
  | { readonly protocol: 'responses'; readonly type: 'response.reasoning_summary_text.delta'; readonly item_id: string; readonly output_index?: number; readonly content_index?: number; readonly delta: string }
  | { readonly protocol: 'responses'; readonly type: 'response.reasoning_summary_text.done'; readonly item_id: string; readonly output_index?: number; readonly content_index?: number; readonly text: string }
  // Live providers may omit `item_id` and identify the call by call_id.
  | { readonly protocol: 'responses'; readonly type: 'response.function_call_arguments.delta'; readonly item_id?: string; readonly call_id?: string; readonly output_index?: number; readonly delta: string }
  | { readonly protocol: 'responses'; readonly type: 'response.function_call_arguments.done'; readonly item_id?: string; readonly call_id?: string; readonly output_index?: number; readonly arguments: string }
  | { readonly protocol: 'responses'; readonly type: 'response.completed'; readonly response: { readonly id: string } }
  | { readonly protocol: 'responses'; readonly type: 'response.incomplete'; readonly response: { readonly id: string; readonly incomplete_details?: { readonly reason: string } } }
  | { readonly protocol: 'responses'; readonly type: 'response.failed'; readonly response: { readonly id: string; readonly error: ResponsesWireError } }
  | { readonly protocol: 'responses'; readonly type: 'error'; readonly error: ResponsesWireError };

export type ResponsesWireOutputItem =
  | {
      readonly type: 'message';
      readonly id: string;
      readonly role: 'assistant';
      readonly content: readonly { readonly type: 'output_text'; readonly text: string }[];
    }
  // Responses providers may omit `id` on function_call output items; call_id
  // is the required identity (see the codecs function_call branches).
  | { readonly type: 'function_call'; readonly id?: string; readonly call_id: string; readonly name: string; readonly arguments: string };

export type ResponsesWireReasoningSummaryPart =
  | { readonly type: 'reasoning_summary'; readonly summary?: readonly { readonly type?: 'summary_text'; readonly text?: string }[]; readonly text?: string }
  | { readonly type?: 'summary_text'; readonly text?: string };

export type ResponsesWireReasoningSummaryDelta =
  | { readonly type: 'reasoning_summary_text'; readonly text: string }
  | { readonly type?: 'summary_text'; readonly text: string };

export interface ResponsesWireError {
  readonly code: string;
  readonly message: string;
  readonly param?: string;
}

export interface ResponsesWireCancelRequest {
  readonly protocol: 'responses';
  readonly type: 'responses.cancel';
  readonly route: string;
  readonly model: string;
  readonly reason: string;
  readonly execution: ProviderExecutionIdentityRef;
}

export interface OpenAIChatWireRequest {
  readonly protocol: 'openai';
  readonly type: 'openai.chat.request';
  readonly route: string;
  readonly model: string;
  readonly messages: readonly OpenAIChatWireMessage[];
  readonly tools?: readonly OpenAIChatWireTool[];
  readonly execution: ProviderExecutionIdentityRef;
  readonly checkpointId?: CheckpointId;
}

export interface OpenAIChatWireMessage {
  readonly role: 'user' | 'system' | 'assistant';
  readonly content: string;
}

export interface OpenAIChatWireTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: BusinessPayload;
  };
}

export interface OpenAIChatWireToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: 'function';
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

export type OpenAIChatWireEvent =
  | {
      readonly protocol: 'openai';
      readonly type: 'openai.chat.completion';
      readonly id: string;
      readonly object?: 'chat.completion.chunk';
      readonly model?: string;
      readonly choices: readonly {
        readonly index: number;
        readonly delta?: {
          readonly role?: 'assistant';
          readonly content?: string | null;
          readonly tool_calls?: readonly OpenAIChatWireToolCallDelta[];
        };
        readonly finish_reason?: string | null;
      }[];
    }
  | { readonly protocol: 'openai'; readonly type: 'error'; readonly error: OpenAIChatWireError };

export interface OpenAIChatWireError {
  readonly code?: string;
  readonly type?: string;
  readonly message: string;
}

export interface OpenAIChatCancelRequest {
  readonly protocol: 'openai';
  readonly type: 'openai.cancel';
  readonly route: string;
  readonly model: string;
  readonly reason: string;
  readonly execution: ProviderExecutionIdentityRef;
}

export interface AnthropicWireRequest {
  readonly protocol: 'anthropic';
  readonly type: 'anthropic.request';
  readonly route: string;
  readonly model: string;
  readonly max_tokens: number;
  readonly system: string;
  readonly messages: readonly AnthropicWireMessage[];
  readonly tools?: readonly AnthropicWireTool[];
  readonly execution: ProviderExecutionIdentityRef;
  readonly checkpointId?: CheckpointId;
}

export interface AnthropicWireMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly AnthropicWireContentBlock[];
}

export type AnthropicWireContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: BusinessPayload }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string };

export interface AnthropicWireTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: BusinessPayload;
}

export type AnthropicWireEvent =
  | { readonly protocol: 'anthropic'; readonly type: 'message_start'; readonly message: { readonly id: string; readonly model: string; readonly role: 'assistant' } }
  | { readonly protocol: 'anthropic'; readonly type: 'content_block_start'; readonly index: number; readonly content_block: AnthropicWireContentBlockStart }
  | { readonly protocol: 'anthropic'; readonly type: 'content_block_delta'; readonly index: number; readonly delta: AnthropicWireDelta }
  | { readonly protocol: 'anthropic'; readonly type: 'content_block_stop'; readonly index: number }
  | { readonly protocol: 'anthropic'; readonly type: 'message_delta'; readonly delta: { readonly stop_reason?: string } }
  | { readonly protocol: 'anthropic'; readonly type: 'message_stop' }
  | { readonly protocol: 'anthropic'; readonly type: 'ping' }
  | { readonly protocol: 'anthropic'; readonly type: 'error'; readonly error: AnthropicWireError };

export type AnthropicWireContentBlockStart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: BusinessPayload };
export type AnthropicWireDelta =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'thinking_delta'; readonly thinking: string }
  | { readonly type: 'signature_delta'; readonly signature: string }
  | { readonly type: 'input_json_delta'; readonly partial_json: string };

export interface AnthropicWireError {
  readonly type: string;
  readonly message: string;
}

export interface AnthropicWireCancelRequest {
  readonly protocol: 'anthropic';
  readonly type: 'anthropic.cancel';
  readonly route: string;
  readonly model: string;
  readonly reason: string;
  readonly execution: ProviderExecutionIdentityRef;
}

export type ProviderWireRequest = ResponsesWireRequest | OpenAIChatWireRequest | AnthropicWireRequest;
export type ProviderWireStopRequest = ResponsesWireCancelRequest | OpenAIChatCancelRequest | AnthropicWireCancelRequest;
export type ProviderWireEvent = ResponsesWireEvent | OpenAIChatWireEvent | AnthropicWireEvent;
