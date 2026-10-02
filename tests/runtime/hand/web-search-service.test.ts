import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WEB_SEARCH_CONTRACT_VERSION,
  WEB_SEARCH_SERVICE_ID,
  type WebSearchRequest,
} from '../../../packages/contracts/src/index.js';
import { WebSearchHarnessError, WebSearchService, type WebSearchProvider, type WebSearchProviderInput } from '../../../packages/runtime/src/hand/index.js';

function request(overrides: Partial<WebSearchRequest> = {}): WebSearchRequest {
  return { serviceId: WEB_SEARCH_SERVICE_ID, contractVersion: WEB_SEARCH_CONTRACT_VERSION, query: 'hand gateway', ...overrides };
}

function entry(url: string, title: string, snippet: string) {
  return { url, title, snippet, site_name: new URL(url).hostname };
}

class FixtureProvider implements WebSearchProvider {
  readonly inputs: WebSearchProviderInput[] = [];
  constructor(private readonly output: { readonly entries: unknown[]; readonly pagesFetched: number; readonly exhausted: boolean; readonly pageErrors?: readonly string[] }) {}
  async search(input: WebSearchProviderInput) { this.inputs.push(input); return { ...this.output, pageErrors: this.output.pageErrors ?? [] }; }
}

test('web.search normalizes constraints, de-duplicates results, and reports truncation', async () => {
  const provider = new FixtureProvider({ entries: [entry('https://example.com/a', 'A2', 'Snippet A2'), entry('https://example.com/a', 'A1', 'Snippet A1'), entry('https://example.com/b', 'B3', 'Snippet B3')], pagesFetched: 1, exhausted: true });
  const report = await new WebSearchService(provider).execute(request({ domains: ['Example.COM', 'example.com'], maxResults: 1 }));
  assert.equal(report.status, 'succeeded');
  assert.deepEqual(report.domains, ['example.com']);
  assert.equal(report.maxResults, 1);
  assert.equal(report.requireComplete, false);
  assert.equal(report.resultsFound, 2);
  assert.equal(report.resultsScope, 'provider-pages');
  assert.equal(report.providerPagesFetched, 1);
  assert.equal(report.resultsTruncated, true);
  assert.deepEqual(report.results.map((item) => item.url), ['https://example.com/a']);
  assert.deepEqual(provider.inputs[0]?.domains, ['example.com']);
  assert.equal('maxResults' in (provider.inputs[0] ?? {}), false);
});

test('web.search distinguishes partial success from strict incomplete failure', async () => {
  const provider = new FixtureProvider({ entries: [entry('https://example.com/a', 'A', 'Snippet A')], pagesFetched: 1, exhausted: false, pageErrors: ['provider-b'] });
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

test('web.search reports a rejected entry as a partial result and keeps provider unavailability explicit', async () => {
  const partial = await new WebSearchService(new FixtureProvider({
    entries: [entry('https://example.com/ok', 'OK', 'Snippet OK'), entry('file:///secret', 'Secret', 'Snippet')],
    pagesFetched: 1,
    exhausted: true,
  })).execute(request());
  assert.equal(partial.status, 'succeeded');
  assert.equal(partial.searchComplete, false);
  assert.deepEqual(partial.results.map((item) => item.url), ['https://example.com/ok']);
  assert.equal(partial.unresolvedSources.length, 1);
  assert.match(String(partial.unresolvedSources[0]), /file:\/\/\/secret/);

  const strictPartial = await new WebSearchService(new FixtureProvider({
    entries: [entry('file:///secret', 'Secret', 'Snippet')],
    pagesFetched: 1,
    exhausted: true,
  })).execute(request({ requireComplete: true }));
  assert.equal(strictPartial.status, 'failed');
  assert.equal(strictPartial.failure?.code, 'search-incomplete');

  const unavailable = await new WebSearchService({ async search() { throw new WebSearchHarnessError('provider-unavailable', 'no web provider is configured'); } }).execute(request());
  assert.equal(unavailable.status, 'failed');
  assert.equal(unavailable.failure?.code, 'provider-unavailable');
});

test('web.search rejects malformed provider completion metadata instead of escaping the service contract', async () => {
  const malformedErrors: WebSearchProvider = {
    async search() {
      return { entries: [], pagesFetched: 1, exhausted: true, pageErrors: null as unknown as readonly string[] };
    },
  };
  const malformedExhausted: WebSearchProvider = {
    async search() {
      return { entries: [], pagesFetched: 1, exhausted: 'yes' as unknown as boolean, pageErrors: [] };
    },
  };
  const errorsReport = await new WebSearchService(malformedErrors).execute(request());
  const exhaustedReport = await new WebSearchService(malformedExhausted).execute(request());
  assert.equal(errorsReport.status, 'failed');
  assert.equal(errorsReport.failure?.code, 'invalid-result');
  assert.equal(exhaustedReport.status, 'failed');
  assert.equal(exhaustedReport.failure?.code, 'invalid-result');
});

test('web.search preserves requireComplete in the report identity', async () => {
  const provider = new FixtureProvider({ entries: [], pagesFetched: 1, exhausted: true });
  const report = await new WebSearchService(provider).execute(request({ requireComplete: true }));
  assert.equal(report.status, 'succeeded');
  assert.equal(report.requireComplete, true);
  assert.equal(report.providerPagesFetched, 1);
});

test('web.search keeps provider-unsettled distinct from provider failures and cancellation', async () => {
  const report = await new WebSearchService({
    async search() {
      throw new WebSearchHarnessError('provider-unsettled', 'provider run did not settle within the stop window');
    },
  }).execute(request());
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.failure, {
    code: 'provider-unsettled',
    message: 'provider run did not settle within the stop window',
  });
});
