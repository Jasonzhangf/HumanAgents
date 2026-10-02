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
  readonly signal: AbortSignal;
}

export interface WebSearchProviderOutput {
  readonly entries: unknown[];
  readonly pagesFetched: number;
  readonly exhausted: boolean;
  readonly pageErrors: readonly string[];
}

export interface WebSearchProvider {
  search(input: WebSearchProviderInput): Promise<WebSearchProviderOutput>;
}

export class WebSearchHarnessError extends Error {
  constructor(
    readonly code: 'provider-unavailable' | 'provider-failed' | 'provider-unsettled',
    message: string,
  ) {
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
      providerOutput = await this.provider.search({
        query: normalized.query,
        domains: normalized.domains,
        recency: normalized.recency,
        signal: options.signal ?? new AbortController().signal,
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw abortError();
      const code = error instanceof WebSearchHarnessError ? error.code : 'provider-failed';
      return this.failedReport(input, normalizeFailure(code, error));
    }
    if (options.signal?.aborted) throw abortError();

    let entries: unknown[];
    let exhausted: boolean;
    let pagesFetched: number;
    let pageErrors: string[];
    try {
      if (!providerOutput || typeof providerOutput !== 'object' || !Array.isArray(providerOutput.entries)) {
        throw new Error('provider returned an invalid entry list');
      }
      if (!Number.isSafeInteger(providerOutput.pagesFetched) || providerOutput.pagesFetched < 0) {
        throw new Error('provider returned an invalid page count');
      }
      if (typeof providerOutput.exhausted !== 'boolean') {
        throw new Error('provider returned an invalid exhaustion flag');
      }
      if (!Array.isArray(providerOutput.pageErrors)
        || providerOutput.pageErrors.some((source) => typeof source !== 'string' || !source.trim())) {
        throw new Error('provider returned invalid page errors');
      }
      entries = providerOutput.entries;
      pagesFetched = providerOutput.pagesFetched;
      exhausted = providerOutput.exhausted;
      pageErrors = providerOutput.pageErrors.map((source) => source.trim());
    } catch (error) {
      return this.failedReport(input, normalizeFailure('invalid-result', error));
    }
    // A single unusable entry is a partial result, not a malformed envelope: it
    // is rejected and reported as an unresolved source so the search stays
    // visibly incomplete instead of collapsing into invalid-result.
    const normalizedEntries = normalizeResults(entries);
    const results = normalizedEntries.results;
    const unresolvedSources = [...new Set([...pageErrors, ...normalizedEntries.rejected])].sort();
    const resultsFound = results.length;
    const resultsTruncated = resultsFound > normalized.maxResults;
    const boundedResults = results.slice(0, normalized.maxResults);
    const searchComplete = exhausted && unresolvedSources.length === 0;
    const base = this.baseReport(normalized, boundedResults, resultsFound, pagesFetched, resultsTruncated, searchComplete, unresolvedSources);
    if (normalized.requireComplete && !searchComplete) {
      return { ...base, status: 'failed', summary: `search incomplete: ${unresolvedSources.length} unresolved source(s)`, failure: {
        code: 'search-incomplete',
        message: 'the requested web search was not fully completed',
      } };
    }
    return { ...base, status: 'succeeded', summary: searchComplete
      ? `searched web sources, found ${resultsFound} result(s) from ${pagesFetched} provider page(s)`
      : `partial web search: found ${resultsFound} result(s) from ${pagesFetched} provider page(s)` };
  }

  private baseReport(
    request: NormalizedWebSearchRequest,
    results: readonly WebSearchResult[],
    resultsFound: number,
    providerPagesFetched: number,
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
      resultsScope: 'provider-pages',
      providerPagesFetched,
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
      resultsScope: 'provider-pages',
      providerPagesFetched: 0,
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

interface NormalizedEntries {
  readonly results: WebSearchResult[];
  /** Rejected entries, verbatim as received, so the search stays visibly partial. */
  readonly rejected: string[];
}

function normalizeResults(entries: readonly unknown[]): NormalizedEntries {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    const value = isRecord(entry) ? entry : {};
    const url = stringField(value, 'url');
    const title = stringField(value, 'title');
    const snippet = stringField(value, 'snippet');
    if (!url || !title || !snippet) {
      rejected.push(JSON.stringify(entry));
      continue;
    }
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { rejected.push(JSON.stringify(entry)); continue; }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      rejected.push(JSON.stringify(entry));
      continue;
    }
    const canonicalUrl = parsedUrl.toString();
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    results.push({
      url: canonicalUrl,
      title,
      snippet,
      ...(stringField(value, 'site_name') ? { sourceName: stringField(value, 'site_name')! } : {}),
      ...(stringField(value, 'publishedAt') ? { publishedAt: stringField(value, 'publishedAt')! } : {}),
      rank: results.length + 1,
    });
  }
  return { results, rejected };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeFailure(code: WebSearchFailure['code'], error: unknown): WebSearchFailure {
  return { code, message: error instanceof Error ? error.message : 'web search failed' };
}

function abortError(): Error { return Object.assign(new Error('web search execution aborted'), { name: 'AbortError' }); }
function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }
