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

export type CodeSearchFailureCode = 'invalid-request' | 'path-not-found' | 'path-escape' | 'read-failed' | 'search-incomplete';
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
  readonly summary: string;
  readonly failure?: CodeSearchFailure;
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new ContractError(`${label} must be non-empty`);
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
