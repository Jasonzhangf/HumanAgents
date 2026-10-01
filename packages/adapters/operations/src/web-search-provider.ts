/**
 * Shared `WebSearchProvider` adapter — design skeleton.
 *
 * Design: docs/architecture/hand-search-websearch-plan.md
 * Graph:  docs/dagpipe/hand-search-websearch.graph.json (node `backend_search`)
 *
 * Single provider-invocation owner for web search. It binds the injected
 * `WebSearchProvider` port to the Agent Reach route, which forwards the query to
 * Monid TinyFish (`monid run -p tinyfish -e /search`). It is shared by the Hand
 * gateway `web.search` service and the Dashboard `web.search` Provider tool;
 * neither of them re-implements provider invocation, and neither of them writes
 * the other's report.
 *
 * Per the plan, this adapter returns every validated match and does not apply
 * `maxResults`; the caller applies the result bound so it can still compute the
 * pre-bound match count and the truncation signal.
 *
 * Behavior is implemented only after the design DAG passes independent review;
 * until then every entry throws, so no caller can observe a fabricated result.
 */

export interface WebSearchProviderSearchInput {
  readonly query: string;
  readonly domains: readonly string[];
  readonly recency: 'day' | 'week' | 'month' | 'year' | 'any';
  readonly signal: AbortSignal;
}

export interface WebSearchProviderSearchOutput {
  readonly results: readonly {
    readonly url: string;
    readonly title: string;
    readonly snippet: string;
    readonly publishedAt?: string;
  }[];
  readonly complete: boolean;
  readonly unresolvedSources: readonly string[];
}

export async function searchWithAgentReach(
  _input: WebSearchProviderSearchInput,
): Promise<WebSearchProviderSearchOutput> {
  throw notImplemented('searchWithAgentReach');
}

function notImplemented(name: string): Error {
  return new Error(
    `web-search provider adapter ${name} is not implemented yet; see docs/architecture/hand-search-websearch-plan.md`,
  );
}
