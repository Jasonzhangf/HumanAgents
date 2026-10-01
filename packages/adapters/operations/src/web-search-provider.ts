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
 * Bounded collection contract. It pages `page` 0..10 and stops at the first
 * page shorter than the per-page bound (observed bound: 10), returning the
 * validated matches collected from those pages together with `pagesFetched` and
 * `exhausted`. It makes no claim of returning every match on the web, because
 * the provider exposes neither a global match count nor a completeness flag. If
 * it stops at the page ceiling with full pages, `exhausted` is false so the
 * caller knows more pages may exist. Callers apply the result bound themselves;
 * this adapter never applies `maxResults`.
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
