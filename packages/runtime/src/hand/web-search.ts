import {
  validateWebSearchRequest,
  WEB_SEARCH_CONTRACT_VERSION,
  WEB_SEARCH_SERVICE_ID,
  type WebSearchFailure,
  type WebSearchReport,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchRecency,
} from '../../../contracts/src/index.js';

export interface WebSearchProviderInput {
  readonly query: string;
  readonly domains: readonly string[];
  readonly recency: WebSearchRecency;
  readonly maxResults: number;
  readonly signal: AbortSignal;
}

export interface WebSearchProviderOutput {
  readonly results: readonly WebSearchResult[];
  readonly complete: boolean;
  readonly unresolvedSources: readonly string[];
}

export interface WebSearchProvider {
  search(input: WebSearchProviderInput): Promise<WebSearchProviderOutput>;
}

export class WebSearchHarnessError extends Error {
  constructor(readonly code: 'provider-unavailable' | 'provider-failed', message: string) {
    super(message);
    this.name = 'WebSearchHarnessError';
  }
}

export interface NormalizedWebSearchRequest {
  readonly query: string;
  readonly domains: readonly string[];
  readonly recency: WebSearchRecency;
  readonly maxResults: number;
  readonly requireComplete: boolean;
}

export class WebSearchService {
  constructor(private readonly provider: WebSearchProvider) {}

  async execute(input: WebSearchRequest, options: { readonly signal?: AbortSignal } = {}): Promise<WebSearchReport> {
    let normalized: NormalizedWebSearchRequest;
    try {
      validateWebSearchRequest(input);
      normalized = normalizeRequest(input);
    } catch (error) {
      return this.failedReport(input, normalizeFailure('invalid-request', error));
    }
    if (options.signal?.aborted) throw abortError();
    let providerOutput: WebSearchProviderOutput;
    try {
      providerOutput = await this.provider.search({ ...normalized, signal: options.signal ?? new AbortController().signal });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw abortError();
      const code = error instanceof WebSearchHarnessError ? error.code : 'provider-failed';
      return this.failedReport(input, normalizeFailure(code, error));
    }
    if (options.signal?.aborted) throw abortError();

    let results: WebSearchResult[];
    let complete: boolean;
    let unresolvedSources: string[];
    try {
      if (!providerOutput || typeof providerOutput !== 'object' || !Array.isArray(providerOutput.results)) {
        throw new Error('provider returned an invalid result list');
      }
      if (typeof providerOutput.complete !== 'boolean') {
        throw new Error('provider returned an invalid completion flag');
      }
      if (!Array.isArray(providerOutput.unresolvedSources)
        || providerOutput.unresolvedSources.some((source) => typeof source !== 'string' || !source.trim())) {
        throw new Error('provider returned invalid unresolved sources');
      }
      results = normalizeResults(providerOutput.results);
      complete = providerOutput.complete;
      unresolvedSources = [...new Set(providerOutput.unresolvedSources.map((source) => source.trim()))].sort();
    } catch (error) {
      return this.failedReport(input, normalizeFailure('invalid-result', error));
    }
    const resultsFound = results.length;
    const resultsTruncated = resultsFound > normalized.maxResults;
    const boundedResults = results.slice(0, normalized.maxResults);
    const searchComplete = complete && unresolvedSources.length === 0;
    const base = this.baseReport(normalized, boundedResults, resultsFound, resultsTruncated, searchComplete, unresolvedSources);
    if (normalized.requireComplete && !searchComplete) {
      return { ...base, status: 'failed', summary: `search incomplete: ${unresolvedSources.length} source(s) unresolved`, failure: {
        code: 'search-incomplete',
        message: 'the requested web search was not fully completed',
      } };
    }
    return { ...base, status: 'succeeded', summary: searchComplete
      ? `searched web sources, found ${resultsFound} result(s)`
      : `partial web search: found ${resultsFound} result(s)` };
  }

  private baseReport(
    request: NormalizedWebSearchRequest,
    results: readonly WebSearchResult[],
    resultsFound: number,
    resultsTruncated: boolean,
    searchComplete: boolean,
    unresolvedSources: readonly string[],
  ): Omit<WebSearchReport, 'status' | 'summary' | 'failure'> {
    return {
      serviceId: WEB_SEARCH_SERVICE_ID,
      contractVersion: WEB_SEARCH_CONTRACT_VERSION,
      query: request.query,
      domains: request.domains,
      recency: request.recency,
      maxResults: request.maxResults,
      requireComplete: request.requireComplete,
      results,
      resultsFound,
      resultsTruncated,
      searchComplete,
      unresolvedSources,
    };
  }

  private failedReport(input: WebSearchRequest, failure: WebSearchFailure): WebSearchReport {
    const normalized = normalizeRequestForFailure(input);
    return {
      serviceId: WEB_SEARCH_SERVICE_ID,
      contractVersion: WEB_SEARCH_CONTRACT_VERSION,
      status: 'failed',
      query: input.query ?? '',
      domains: normalized.domains,
      recency: normalized.recency,
      maxResults: normalized.maxResults,
      requireComplete: normalized.requireComplete,
      results: [],
      resultsFound: 0,
      resultsTruncated: false,
      searchComplete: false,
      unresolvedSources: [],
      summary: failure.message,
      failure,
    };
  }
}

function normalizeRequest(input: WebSearchRequest): NormalizedWebSearchRequest {
  return {
    query: input.query.trim(),
    domains: [...new Set((input.domains ?? []).map((domain) => domain.trim().toLowerCase()))].sort(),
    recency: input.recency ?? 'any',
    maxResults: input.maxResults ?? 10,
    requireComplete: input.requireComplete ?? false,
  };
}

function normalizeRequestForFailure(input: WebSearchRequest): NormalizedWebSearchRequest {
  return {
    query: input.query ?? '',
    domains: [...new Set((input.domains ?? []).filter((domain): domain is string => typeof domain === 'string').map((domain) => domain.trim().toLowerCase()))].sort(),
    recency: input.recency && ['day', 'week', 'month', 'year', 'any'].includes(input.recency) ? input.recency : 'any',
    maxResults: Number.isSafeInteger(input.maxResults) && (input.maxResults ?? 0) > 0 ? input.maxResults! : 10,
    requireComplete: input.requireComplete === true,
  };
}

function normalizeResults(results: readonly WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const normalized: WebSearchResult[] = [];
  for (const result of [...results].sort((left, right) => left.rank - right.rank || left.url.localeCompare(right.url))) {
    if (!Number.isSafeInteger(result.rank) || result.rank < 1) throw new Error('provider returned an invalid result rank');
    let url: URL;
    try { url = new URL(result.url); } catch { throw new Error('provider returned an invalid URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('provider returned a URL with an unsupported protocol');
    const canonicalUrl = url.toString();
    if (seen.has(canonicalUrl)) continue;
    if (!result.title.trim() || !result.snippet.trim()) throw new Error('provider returned an empty result title or snippet');
    seen.add(canonicalUrl);
    normalized.push({
      url: canonicalUrl,
      title: result.title.trim(),
      snippet: result.snippet.trim(),
      ...(result.sourceName?.trim() ? { sourceName: result.sourceName.trim() } : {}),
      ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
      rank: normalized.length + 1,
    });
  }
  return normalized;
}

function normalizeFailure(code: WebSearchFailure['code'], error: unknown): WebSearchFailure {
  return { code, message: error instanceof Error ? error.message : 'web search failed' };
}

function abortError(): Error { return Object.assign(new Error('web search execution aborted'), { name: 'AbortError' }); }
function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }
