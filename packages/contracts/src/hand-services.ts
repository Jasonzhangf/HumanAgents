import { ContractError } from './errors.js';

export const CODE_SEARCH_SERVICE_ID = 'code.search' as const;
export const CODE_SEARCH_CONTRACT_VERSION = '1.0.0' as const;
export type CodeSearchQueryKind = 'literal' | 'regex' | 'symbol';

export interface CodeSearchRequest {
  readonly serviceId: typeof CODE_SEARCH_SERVICE_ID;
  readonly contractVersion: typeof CODE_SEARCH_CONTRACT_VERSION;
  readonly workspaceRef: string;
  readonly path: string;
  readonly query: string;
  readonly queryKind: CodeSearchQueryKind;
  readonly contextLines?: number;
  readonly maxResults?: number;
  readonly requireComplete?: boolean;
}

export interface CodeSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
}

export interface CodeSearchPathTreeNode {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly fileCount: number;
  readonly children: readonly CodeSearchPathTreeNode[];
  readonly truncated: boolean;
}

export type CodeSearchFailureCode = 'invalid-request' | 'path-not-found' | 'path-escape' | 'read-failed' | 'search-incomplete' | 'scope-too-large';
export interface CodeSearchFailure {
  readonly code: CodeSearchFailureCode;
  readonly message: string;
  readonly path?: string;
}

export interface CodeSearchReport {
  readonly serviceId: typeof CODE_SEARCH_SERVICE_ID;
  readonly contractVersion: typeof CODE_SEARCH_CONTRACT_VERSION;
  readonly status: 'succeeded' | 'failed';
  readonly workspaceRef: string;
  readonly path: string;
  readonly query: string;
  readonly queryKind: CodeSearchQueryKind;
  readonly matches: readonly CodeSearchMatch[];
  readonly filesDiscovered: number;
  readonly filesSearched: number;
  readonly matchesFound: number;
  readonly resultsTruncated: boolean;
  readonly searchComplete: boolean;
  readonly unresolvedPaths: readonly string[];
  /** Bounded path tree returned when the requested scope is too large. */
  readonly pathTree?: CodeSearchPathTreeNode;
  readonly summary: string;
  readonly failure?: CodeSearchFailure;
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new ContractError(`${label} must be non-empty`);
}

function reportRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ContractError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ContractError(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function reportExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new ContractError(`${label} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ContractError(`${label} does not accept ${key}`);
}

function reportNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError(`${label} must be a non-empty string`);
}

function reportString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new ContractError(`${label} must be a string`);
}

function reportSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ContractError(`${label} must be a safe integer`);
}

function reportStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new ContractError(`${label} must be an array`);
  for (const entry of value) reportNonEmpty(entry, `${label} entry`);
}

function reportBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new ContractError(`${label} must be a boolean`);
}

function reportMember<T extends string>(value: unknown, values: readonly T[], label: string): asserts value is T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw new ContractError(`${label} is invalid`);
}

function validateCodeSearchMatch(value: unknown, label: string): void {
  const input = reportRecord(value, label);
  reportExactKeys(input, ['path', 'line', 'column', 'text', 'contextBefore', 'contextAfter'], [], label);
  reportNonEmpty(input.path, `${label}.path`);
  reportSafeInteger(input.line, `${label}.line`);
  if ((input.line as number) < 1) throw new ContractError(`${label}.line must be at least 1`);
  reportSafeInteger(input.column, `${label}.column`);
  if ((input.column as number) < 1) throw new ContractError(`${label}.column must be at least 1`);
  reportString(input.text, `${label}.text`);
  const before = input.contextBefore;
  if (!Array.isArray(before)) throw new ContractError(`${label}.contextBefore must be an array`);
  for (const line of before) {
    if (typeof line !== 'string') throw new ContractError(`${label}.contextBefore entry must be a string`);
  }
  const after = input.contextAfter;
  if (!Array.isArray(after)) throw new ContractError(`${label}.contextAfter must be an array`);
  for (const line of after) {
    if (typeof line !== 'string') throw new ContractError(`${label}.contextAfter entry must be a string`);
  }
}

function validateCodeSearchPathTreeNode(value: unknown, label: string): void {
  const input = reportRecord(value, label);
  reportExactKeys(input, ['path', 'kind', 'fileCount', 'children', 'truncated'], [], label);
  reportNonEmpty(input.path, `${label}.path`);
  reportMember(input.kind, ['directory', 'file'], `${label}.kind`);
  reportSafeInteger(input.fileCount, `${label}.fileCount`);
  if ((input.fileCount as number) < 1) throw new ContractError(`${label}.fileCount must be at least 1`);
  if (!Array.isArray(input.children)) throw new ContractError(`${label}.children must be an array`);
  for (const child of input.children as unknown[]) validateCodeSearchPathTreeNode(child, `${label}.children entry`);
  reportBoolean(input.truncated, `${label}.truncated`);
}

function validateCodeSearchFailure(value: unknown, label: string): void {
  const input = reportRecord(value, label);
  reportExactKeys(input, ['code', 'message'], ['path'], label);
  reportMember(input.code, ['invalid-request', 'path-not-found', 'path-escape', 'read-failed', 'search-incomplete', 'scope-too-large'], `${label}.code`);
  reportNonEmpty(input.message, `${label}.message`);
  if (Object.hasOwn(input, 'path')) reportNonEmpty(input.path, `${label}.path`);
}

export function validateCodeSearchRequest(input: CodeSearchRequest): void {
  if (input.serviceId !== CODE_SEARCH_SERVICE_ID) throw new ContractError('invalid code search service id');
  if (input.contractVersion !== CODE_SEARCH_CONTRACT_VERSION) throw new ContractError('unsupported code search contract version');
  nonEmpty(input.workspaceRef, 'workspaceRef');
  nonEmpty(input.path, 'search path');
  const normalized = input.path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new ContractError('search path must stay inside the workspace');
  }
  nonEmpty(input.query, 'search query');
  if (!['literal', 'regex', 'symbol'].includes(input.queryKind)) throw new ContractError('invalid code search query kind');
  if (input.contextLines !== undefined && (!Number.isSafeInteger(input.contextLines) || input.contextLines < 0)) {
    throw new ContractError('contextLines must be a non-negative safe integer');
  }
  if (input.maxResults !== undefined && (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1)) {
    throw new ContractError('maxResults must be a positive safe integer');
  }
}

export function validateCodeSearchReport(value: unknown): asserts value is CodeSearchReport {
  const input = reportRecord(value, 'code search report');
  reportExactKeys(input,
    ['serviceId', 'contractVersion', 'status', 'workspaceRef', 'path', 'query', 'queryKind', 'matches', 'filesDiscovered', 'filesSearched', 'matchesFound', 'resultsTruncated', 'searchComplete', 'unresolvedPaths', 'summary'],
    ['pathTree', 'failure'],
    'code search report');
  if (input.serviceId !== CODE_SEARCH_SERVICE_ID) throw new ContractError('invalid code search report service id');
  if (input.contractVersion !== CODE_SEARCH_CONTRACT_VERSION) throw new ContractError('unsupported code search report contract version');
  reportMember(input.status, ['succeeded', 'failed'], 'code search report status');
  reportMember(input.queryKind, ['literal', 'regex', 'symbol'], 'code search report queryKind');
  const hasFailureField = Object.hasOwn(input, 'failure');
  const hasFailure = hasFailureField && input.failure !== undefined;
  if (hasFailure) validateCodeSearchFailure(input.failure, 'code search report failure');
  const invalidRequestEcho = input.status === 'failed' && hasFailure && (input.failure as Record<string, unknown>).code === 'invalid-request';
  if (invalidRequestEcho) {
    reportString(input.workspaceRef, 'code search report workspaceRef');
    reportString(input.path, 'code search report path');
    reportString(input.query, 'code search report query');
  } else {
    reportNonEmpty(input.workspaceRef, 'code search report workspaceRef');
    reportNonEmpty(input.path, 'code search report path');
    reportNonEmpty(input.query, 'code search report query');
  }
  if (!Array.isArray(input.matches)) throw new ContractError('code search report matches must be an array');
  const matches = input.matches as unknown[];
  for (let index = 0; index < matches.length; index += 1) validateCodeSearchMatch(matches[index], `code search report matches[${index}]`);
  reportSafeInteger(input.filesDiscovered, 'code search report filesDiscovered');
  if ((input.filesDiscovered as number) < 0) throw new ContractError('code search report filesDiscovered must be non-negative');
  reportSafeInteger(input.filesSearched, 'code search report filesSearched');
  if ((input.filesSearched as number) < 0) throw new ContractError('code search report filesSearched must be non-negative');
  reportSafeInteger(input.matchesFound, 'code search report matchesFound');
  if ((input.matchesFound as number) < 0) throw new ContractError('code search report matchesFound must be non-negative');
  reportBoolean(input.resultsTruncated, 'code search report resultsTruncated');
  reportBoolean(input.searchComplete, 'code search report searchComplete');
  reportStringArray(input.unresolvedPaths, 'code search report unresolvedPaths');
  reportNonEmpty(input.summary, 'code search report summary');
  if (Object.hasOwn(input, 'pathTree')) validateCodeSearchPathTreeNode(input.pathTree, 'code search report pathTree');

  const unresolvedPaths = input.unresolvedPaths as readonly string[];
  const filesDiscovered = input.filesDiscovered as number;
  const filesSearched = input.filesSearched as number;
  const matchesFound = input.matchesFound as number;
  const resultsTruncated = input.resultsTruncated as boolean;
  const searchComplete = input.searchComplete as boolean;

  if (filesSearched > filesDiscovered) throw new ContractError('code search report filesSearched exceeds filesDiscovered');
  if (matchesFound < matches.length) throw new ContractError('code search report matchesFound is smaller than returned matches');
  if (resultsTruncated !== (matchesFound > matches.length)) throw new ContractError('code search report truncation state is inconsistent');
  if (searchComplete && unresolvedPaths.length > 0) {
    throw new ContractError('code search report completeness is inconsistent with unresolved paths');
  }
  if (input.status === 'failed' && !hasFailure) {
    throw new ContractError('failed code search report requires failure');
  }
  if (input.status === 'succeeded' && hasFailureField) throw new ContractError('succeeded code search report cannot carry failure');
}
