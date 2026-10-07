/**
 * Standard Agent Client Protocol (ACP) v1 wire contract.
 *
 * This module is the single wire vocabulary shared by every ACP runtime
 * adaptor in this package. `protocolVersion` is locked at `1`: a runtime that
 * reports anything else fails closed at `initialize`.
 *
 * Every type here is transport-level. Nothing in this file is a HumanAgent
 * domain identity: `sessionId`, `messageId`, `toolCallId` and `cursor` values
 * are correlation/evidence only and never replace `TaskId`, `OperationId`,
 * `CheckpointId` or `AgentRuntimeId`.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC error codes used by ACP v1. */
export const ACP_JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32800,
  CANCELLED: -32002,
} as const;

export type AcpJsonRpcError = {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
};

export type AcpJsonRpcRequest = {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
};

export type AcpJsonRpcNotification = {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
};

export type AcpJsonRpcResponse = {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: AcpJsonRpcError;
};

export type AcpContentBlock =
  | { readonly type: 'text'; readonly text: string; readonly annotations?: readonly unknown[] }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string; readonly annotations?: readonly unknown[] }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name?: string; readonly title?: string; readonly mimeType?: string }
  | { readonly type: 'resource'; readonly resource: AcpEmbeddedResource };

export interface AcpEmbeddedResource {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
}

export interface AcpInitializeRequest {
  readonly protocolVersion: number;
  readonly clientCapabilities?: AcpClientCapabilities;
  readonly clientInfo?: AcpImplementationInfo;
}

export interface AcpClientCapabilities {
  readonly auth?: { readonly terminal?: boolean };
  readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean };
  readonly terminal?: boolean;
  readonly positionEncodings?: readonly AcpPositionEncoding[];
}

export type AcpPositionEncoding = 'utf-8' | 'utf-16' | 'utf-32';

export interface AcpImplementationInfo {
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}

export interface AcpAgentCapabilities {
  readonly loadSession?: boolean;
  readonly mcpCapabilities?: { readonly http?: boolean; readonly sse?: boolean };
  readonly promptCapabilities?: { readonly audio?: boolean; readonly embeddedContext?: boolean; readonly image?: boolean };
  readonly sessionCapabilities?: {
    readonly close?: Record<string, unknown>;
    readonly fork?: Record<string, unknown>;
    readonly list?: Record<string, unknown>;
    readonly resume?: Record<string, unknown>;
  };
}

export interface AcpAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities?: AcpAgentCapabilities;
  readonly agentInfo?: AcpImplementationInfo;
  readonly authMethods?: readonly AcpAuthMethod[];
}

export interface AcpMcpServerConfig {
  readonly name: string;
  readonly type?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly headers?: Record<string, string>;
}

export interface AcpNewSessionRequest {
  readonly cwd: string;
  readonly mcpServers?: readonly AcpMcpServerConfig[];
}

export interface AcpConfigOption {
  readonly id: string;
  readonly name: string;
  readonly type: 'select' | 'boolean';
  readonly category?: string;
  readonly description?: string;
  readonly options?: readonly { readonly value: string; readonly name: string; readonly description?: string }[];
  readonly currentValue?: string | boolean;
}

export interface AcpNewSessionResult {
  readonly sessionId: string;
  readonly configOptions?: readonly AcpConfigOption[];
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpPromptRequest {
  readonly sessionId: string;
  readonly messageId?: string;
  readonly prompt: readonly AcpContentBlock[];
}

export interface AcpTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly thoughtTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
}

export interface AcpPromptResult {
  readonly stopReason: AcpStopReason;
  readonly usage?: AcpTokenUsage;
  readonly userMessageId?: string;
}

export interface AcpCancelRequest {
  readonly sessionId: string;
}

export interface AcpCloseSessionRequest {
  readonly sessionId: string;
}

export type AcpSessionUpdateKind =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'session_info_update'
  | 'usage_update';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface AcpToolCallContentItem {
  readonly type: 'content' | 'diff' | 'terminal';
  readonly content?: { readonly type: string; readonly text?: string };
  readonly output?: string;
  readonly truncated?: boolean;
}

export interface AcpToolCall {
  readonly toolCallId?: string;
  readonly title?: string;
  readonly kind?: AcpToolKind;
  readonly status?: AcpToolCallStatus;
  readonly content?: readonly AcpToolCallContentItem[];
  readonly locations?: readonly { readonly path: string; readonly line?: number }[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export type AcpSessionUpdate =
  | { readonly sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; readonly messageId?: string; readonly content: AcpContentBlock }
  | { readonly sessionUpdate: 'tool_call'; readonly toolCallId?: string; readonly title?: string; readonly kind?: AcpToolKind; readonly status?: AcpToolCallStatus; readonly content?: readonly AcpToolCallContentItem[]; readonly locations?: readonly { readonly path: string; readonly line?: number }[]; readonly rawInput?: unknown; readonly rawOutput?: unknown }
  | { readonly sessionUpdate: 'tool_call_update'; readonly toolCallId?: string; readonly title?: string; readonly kind?: AcpToolKind; readonly status?: AcpToolCallStatus; readonly content?: readonly AcpToolCallContentItem[]; readonly locations?: readonly { readonly path: string; readonly line?: number }[]; readonly rawInput?: unknown; readonly rawOutput?: unknown }
  | { readonly sessionUpdate: 'plan'; readonly entries: readonly { readonly content: string; readonly priority: 'high' | 'medium' | 'low'; readonly status: 'pending' | 'in_progress' | 'completed' }[] }
  | { readonly sessionUpdate: 'available_commands_update'; readonly availableCommands: readonly { readonly name: string; readonly description?: string; readonly input?: unknown }[] }
  | { readonly sessionUpdate: 'current_mode_update'; readonly currentModeId: string }
  | { readonly sessionUpdate: 'config_option_update'; readonly configOptions?: readonly AcpConfigOption[] }
  | { readonly sessionUpdate: 'session_info_update'; readonly title?: string; readonly updatedAt?: string }
  | { readonly sessionUpdate: 'usage_update'; readonly used: number; readonly size: number; readonly cost?: { readonly amount: number; readonly currency: string } };

export interface AcpSessionUpdateNotification {
  readonly sessionId: string;
  readonly update: AcpSessionUpdate;
}

function fail(method: string, problem: string): never {
  throw new Error(`invalid ACP ${method} payload: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, method: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) return fail(method, `missing string ${key}`);
  return value;
}

/** Validates a parsed `initialize` response and enforces the locked protocol version. */
export function assertAcpInitializeResult(value: unknown, method = 'initialize'): AcpInitializeResult {
  if (!isRecord(value)) return fail(method, 'result must be an object');
  if (value.protocolVersion !== ACP_PROTOCOL_VERSION) {
    return fail(method, `unsupported protocolVersion ${String(value.protocolVersion)}`);
  }
  return value as unknown as AcpInitializeResult;
}

/** Validates a parsed `session/new` response. */
export function assertAcpNewSessionResult(value: unknown, method = 'session/new'): AcpNewSessionResult {
  if (!isRecord(value)) return fail(method, 'result must be an object');
  return { sessionId: requireString(value, 'sessionId', method) };
}

const STOP_REASONS = new Set<string>(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

/** Validates a parsed `session/prompt` response. */
export function assertAcpPromptResult(value: unknown, method = 'session/prompt'): AcpPromptResult {
  if (!isRecord(value)) return fail(method, 'result must be an object');
  const stopReason = value.stopReason;
  if (typeof stopReason !== 'string' || !STOP_REASONS.has(stopReason)) {
    return fail(method, `invalid stopReason ${String(stopReason)}`);
  }
  return { stopReason: stopReason as AcpStopReason };
}

const UPDATE_KINDS = new Set<string>([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
]);

/** Validates a parsed `session/update` notification. Unknown kinds are rejected, not dropped. */
export function assertAcpSessionUpdateNotification(value: unknown, method = 'session/update'): AcpSessionUpdateNotification {
  if (!isRecord(value)) return fail(method, 'params must be an object');
  const sessionId = requireString(value, 'sessionId', method);
  const update = value.update;
  if (!isRecord(update)) return fail(method, 'missing update object');
  const kind = update.sessionUpdate;
  if (typeof kind !== 'string' || !UPDATE_KINDS.has(kind)) {
    return fail(method, `unknown sessionUpdate kind ${String(kind)}`);
  }
  return { sessionId, update: update as unknown as AcpSessionUpdate };
}

/** Serializes a JSON-RPC request as a newline-delimited frame. */
export function encodeAcpRequest(method: string, id: string | number, params?: unknown): string {
  const frame = params === undefined
    ? { jsonrpc: '2.0' as const, id, method }
    : { jsonrpc: '2.0' as const, id, method, params };
  return `${JSON.stringify(frame)}\n`;
}

/** Serializes a JSON-RPC notification as a newline-delimited frame. */
export function encodeAcpNotification(method: string, params?: unknown): string {
  const frame = params === undefined
    ? { jsonrpc: '2.0' as const, method }
    : { jsonrpc: '2.0' as const, method, params };
  return `${JSON.stringify(frame)}\n`;
}

/** Parses one NDJSON frame and rejects non-object or malformed payloads. */
export function decodeAcpFrame(frame: string): AcpJsonRpcResponse | AcpJsonRpcNotification | AcpJsonRpcRequest {
  const trimmed = frame.trim();
  if (trimmed.length === 0) return null as unknown as never;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error(`invalid ACP frame: not JSON (${trimmed.slice(0, 120)})`);
  }
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    throw new Error(`invalid ACP frame: missing jsonrpc 2.0`);
  }
  return value as unknown as AcpJsonRpcResponse | AcpJsonRpcNotification | AcpJsonRpcRequest;
}

export function isAcpResponse(frame: AcpJsonRpcResponse | AcpJsonRpcNotification | AcpJsonRpcRequest): frame is AcpJsonRpcResponse {
  return 'id' in frame && frame.id !== undefined;
}

/** Builds the evidence locator for a wire frame without leaking secrets into ids. */
export function acpEvidenceLocator(ownerId: string, frame: 'request' | 'response' | 'notification', method: string, index: number): string {
  return `acp/${ownerId}/${frame}/${method}/${index}`;
}
