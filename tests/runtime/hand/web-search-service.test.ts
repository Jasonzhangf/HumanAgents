import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WEB_SEARCH_CONTRACT_VERSION,
  WEB_SEARCH_SERVICE_ID,
  type WebSearchRequest,
  type WebSearchResult,
} from '../../../packages/contracts/src/index.js';
import { WebSearchHarnessError, WebSearchService, type WebSearchProvider, type WebSearchProviderInput } from '../../../packages/runtime/src/hand/index.js';

function request(overrides: Partial<WebSearchRequest> = {}): WebSearchRequest {
  return { serviceId: WEB_SEARCH_SERVICE_ID, contractVersion: WEB_SEARCH_CONTRACT_VERSION, query: 'hand gateway', ...overrides };
}

function result(url: string, rank: number, overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return { url, title: `Title ${rank}`, snippet: `Snippet ${rank}`, rank, ...overrides };
}

class FixtureProvider implements WebSearchProvider {
  readonly inputs: WebSearchProviderInput[] = [];
  constructor(private readonly output: { readonly results: readonly WebSearchResult[]; readonly complete: boolean; readonly unresolvedSources?: readonly string[] }) {}
  async search(input: WebSearchProviderInput) { this.inputs.push(input); return { ...this.output, unresolvedSources: this.output.unresolvedSources ?? [] }; }
}

test('web.search normalizes constraints, de-duplicates results, and reports truncation', async () => {
  const provider = new FixtureProvider({ results: [result('https://example.com/a', 2), result('https://example.com/a', 1), result('https://example.com/b', 3)], complete: true });
  const report = await new WebSearchService(provider).execute(request({ domains: ['Example.COM', 'example.com'], maxResults: 1 }));
  assert.equal(report.status, 'succeeded');
  assert.deepEqual(report.domains, ['example.com']);
  assert.equal(report.maxResults, 1);
  assert.equal(report.requireComplete, false);
  assert.equal(report.resultsFound, 2);
  assert.equal(report.resultsTruncated, true);
  assert.deepEqual(report.results.map((item) => item.url), ['https://example.com/a']);
  assert.deepEqual(provider.inputs[0]?.domains, ['example.com']);
});

test('web.search distinguishes partial success from strict incomplete failure', async () => {
  const provider = new FixtureProvider({ results: [result('https://example.com/a', 1)], complete: false, unresolvedSources: ['provider-b'] });
  const service = new WebSearchService(provider);
  const partial = await service.execute(request());
  assert.equal(partial.status, 'succeeded');
  assert.equal(partial.searchComplete, false);
  assert.deepEqual(partial.unresolvedSources, ['provider-b']);
  const strict = await service.execute(request({ requireComplete: true }));
  assert.equal(strict.status, 'failed');
  assert.equal(strict.failure?.code, 'search-incomplete');
  assert.equal(strict.requireComplete, true);
});

test('web.search rejects invalid provider results and provider unavailability explicitly', async () => {
  const invalid = await new WebSearchService(new FixtureProvider({ results: [result('file:///secret', 1)], complete: true })).execute(request());
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.failure?.code, 'invalid-result');
  const unavailable = await new WebSearchService({ async search() { throw new WebSearchHarnessError('provider-unavailable', 'no web provider is configured'); } }).execute(request());
  assert.equal(unavailable.status, 'failed');
  assert.equal(unavailable.failure?.code, 'provider-unavailable');
});

test('web.search rejects malformed provider completion metadata instead of escaping the service contract', async () => {
  const malformedSources: WebSearchProvider = {
    async search() {
      return { results: [], complete: true, unresolvedSources: null as unknown as readonly string[] };
    },
  };
  const malformedComplete: WebSearchProvider = {
    async search() {
      return { results: [], complete: 'yes' as unknown as boolean, unresolvedSources: [] };
    },
  };
  const sourcesReport = await new WebSearchService(malformedSources).execute(request());
  const completeReport = await new WebSearchService(malformedComplete).execute(request());
  assert.equal(sourcesReport.status, 'failed');
  assert.equal(sourcesReport.failure?.code, 'invalid-result');
  assert.equal(completeReport.status, 'failed');
  assert.equal(completeReport.failure?.code, 'invalid-result');
});

test('web.search preserves requireComplete in the report identity', async () => {
  const provider = new FixtureProvider({ results: [], complete: true });
  const report = await new WebSearchService(provider).execute(request({ requireComplete: true }));
  assert.equal(report.status, 'succeeded');
  assert.equal(report.requireComplete, true);
});
