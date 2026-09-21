import { ContractError } from './errors.js';

export const WEB_SEARCH_SERVICE_ID = 'web.search' as const;
export const WEB_SEARCH_CONTRACT_VERSION = '1.0.0' as const;
export type WebSearchRecency = 'day' | 'week' | 'month' | 'year' | 'any';

export interface WebSearchRequest {
  readonly serviceId: typeof WEB_SEARCH_SERVICE_ID;
  readonly contractVersion: typeof WEB_SEARCH_CONTRACT_VERSION;
  readonly query: string;
  readonly domains?: readonly string[];
  readonly recency?: WebSearchRecency;
  readonly maxResults?: number;
  readonly requireComplete?: boolean;
}

export interface WebSearchResult {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly sourceName?: string;
  readonly publishedAt?: string;
  readonly rank: number;
}

export type WebSearchFailureCode =
  | 'invalid-request'
  | 'provider-unavailable'
  | 'provider-failed'
  | 'invalid-result'
  | 'search-incomplete';

export interface WebSearchFailure {
  readonly code: WebSearchFailureCode;
  readonly message: string;
}

export interface WebSearchReport {
  readonly serviceId: typeof WEB_SEARCH_SERVICE_ID;
  readonly contractVersion: typeof WEB_SEARCH_CONTRACT_VERSION;
  readonly status: 'succeeded' | 'failed';
  readonly query: string;
  readonly domains: readonly string[];
  readonly recency: WebSearchRecency;
  readonly maxResults: number;
  readonly requireComplete: boolean;
  readonly results: readonly WebSearchResult[];
  readonly resultsFound: number;
  readonly resultsTruncated: boolean;
  readonly searchComplete: boolean;
  readonly unresolvedSources: readonly string[];
  readonly summary: string;
  readonly failure?: WebSearchFailure;
}

const RECENCY_VALUES = new Set<WebSearchRecency>(['day', 'week', 'month', 'year', 'any']);

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new ContractError(`${label} must be non-empty`);
}

export function validateWebSearchRequest(input: WebSearchRequest): void {
  if (input.serviceId !== WEB_SEARCH_SERVICE_ID) throw new ContractError('invalid web search service id');
  if (input.contractVersion !== WEB_SEARCH_CONTRACT_VERSION) throw new ContractError('unsupported web search contract version');
  nonEmpty(input.query, 'search query');
  if (input.domains !== undefined) {
    for (const domain of input.domains) nonEmpty(domain, 'search domain');
  }
  if (input.recency !== undefined && !RECENCY_VALUES.has(input.recency)) throw new ContractError('invalid search recency');
  if (input.maxResults !== undefined && (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1)) {
    throw new ContractError('maxResults must be a positive safe integer');
  }
  if (input.requireComplete !== undefined && typeof input.requireComplete !== 'boolean') {
    throw new ContractError('requireComplete must be a boolean');
  }
}

export function validateWebSearchReport(input: WebSearchReport): void {
  if (input.serviceId !== WEB_SEARCH_SERVICE_ID) throw new ContractError('invalid web search report service id');
  if (input.contractVersion !== WEB_SEARCH_CONTRACT_VERSION) throw new ContractError('unsupported web search report contract version');
  nonEmpty(input.query, 'reported search query');
  validateWebSearchRequest({
    serviceId: input.serviceId,
    contractVersion: input.contractVersion,
    query: input.query,
    domains: input.domains,
    recency: input.recency,
    maxResults: input.maxResults,
    requireComplete: input.requireComplete,
  });
  if (!Number.isSafeInteger(input.resultsFound) || input.resultsFound < 0) throw new ContractError('reported result count is invalid');
  if (input.results.length > input.maxResults) throw new ContractError('reported results exceed maxResults');
  if (input.resultsFound < input.results.length) throw new ContractError('reported result count is smaller than returned results');
  if (input.resultsTruncated !== (input.resultsFound > input.maxResults)) throw new ContractError('reported truncation state is inconsistent');
  if (input.searchComplete && input.unresolvedSources.length > 0) throw new ContractError('complete web search cannot have unresolved sources');
  const urls = new Set<string>();
  for (let index = 0; index < input.results.length; index += 1) {
    const result = input.results[index]!;
    if (!Number.isSafeInteger(result.rank) || result.rank !== index + 1) throw new ContractError('reported result ranks are not normalized');
    let url: URL;
    try { url = new URL(result.url); } catch { throw new ContractError('reported result URL is invalid'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ContractError('reported result URL protocol is invalid');
    if (urls.has(url.toString())) throw new ContractError('reported results contain duplicate URLs');
    urls.add(url.toString());
    nonEmpty(result.title, 'reported result title');
    nonEmpty(result.snippet, 'reported result snippet');
  }
  if (input.status === 'failed' && !input.failure) throw new ContractError('failed web search report requires failure');
  if (input.status === 'succeeded' && input.failure) throw new ContractError('succeeded web search report cannot carry failure');
}
