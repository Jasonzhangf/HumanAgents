/**
 * Shared `WebSearchProvider` adapter — design skeleton.
 *
 * Design: docs/architecture/hand-search-websearch-plan.md
 * Graph:  docs/dagpipe/hand-search-websearch.graph.json (node `backend_search`)
 *
 * Single provider-invocation owner for web search. It implements the one
 * `WebSearchProvider` port owned by `packages/runtime/src/hand/web-search.ts`
 * (the same port `web-search-route.ts` already injects), and binds it to the
 * Agent Reach route, which forwards the query to Monid TinyFish
 * (`monid run -p tinyfish -e /search`). It is shared by the Hand gateway
 * `web.search` service and the Dashboard `web.search` Provider tool; neither of
 * them re-implements provider invocation, and neither of them writes the
 * other's report.
 *
 * This file defines no second contract: the input/output shapes come from the
 * port owner. The design also removes `maxResults` from `WebSearchProviderInput`
 * in that owner, because this adapter must return every validated match and the
 * caller must apply the result bound to keep the pre-bound match count and the
 * truncation signal recoverable.
 *
 * Behavior is implemented only after the design DAG passes independent review;
 * until then the factory throws, so no caller can observe a fabricated result.
 */

import type { WebSearchProvider } from '../../../runtime/src/hand/index.js';

export function createAgentReachWebSearchProvider(): WebSearchProvider {
  throw notImplemented('createAgentReachWebSearchProvider');
}

function notImplemented(name: string): Error {
  return new Error(
    `web-search provider adapter ${name} is not implemented yet; see docs/architecture/hand-search-websearch-plan.md`,
  );
}
