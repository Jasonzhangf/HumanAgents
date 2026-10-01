/**
 * Shared `WebSearchProvider` adapter — design skeleton.
 *
 * Design:  docs/architecture/hand-search-websearch-plan.md
 * Evidence: docs/architecture/evidence/tinyfish-search-capability.md
 * Graph:   docs/dagpipe/hand-search-websearch.graph.json (node `backend_search`)
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
 * Bounded collection contract. It pages `page` 0..10 and stops at the first page
 * shorter than the per-page bound (observed bound: 10), returning the raw page
 * entries it collected together with `pagesFetched`, `exhausted` and
 * `pageErrors`. It makes no claim of returning every match on the web, because
 * the provider exposes neither a global match count nor a completeness flag. If
 * it stops at the page ceiling with full pages, `exhausted` is false so the
 * caller knows more pages may exist. The entries are raw and unvalidated: the
 * single validator is `WebSearchService`, which owns URL validation,
 * de-duplication, rank normalization and applying `maxResults`.
 *
 * Cancellation. Aborting a local promise does not prove the remote run stopped,
 * so the adapter keeps the `runId` printed by the non-waiting `monid run` start,
 * calls `monid runs stop -r <runId>` on abort, and polls `monid runs get` to a
 * terminal status. A run that never settles within `pollTimeoutMs` becomes a
 * typed `provider-unsettled` failure mapped to `failed`/`reconcile_required`;
 * it is never reported as `cancelled`.
 *
 * Backend configuration is injected from the control plane — provider slug, CLI
 * path, endpoint, page ceiling and poll bounds are read from the then-current
 * source of truth at execution time and are never copied into this repository or
 * into business payloads.
 *
 * Behavior is implemented only after the design DAG passes independent review;
 * until then the factory throws, so no caller can observe a fabricated result.
 */

import type { WebSearchProvider } from '../../../runtime/src/hand/index.js';

/** Control-plane-injected backend configuration; never a business payload. */
export interface WebSearchProviderBackendConfig {
  readonly provider: string;
  readonly command: string;
  readonly endpoint: string;
  readonly pageCeiling: number;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
}

export function createAgentReachWebSearchProvider(
  _config: WebSearchProviderBackendConfig,
): WebSearchProvider {
  throw notImplemented('createAgentReachWebSearchProvider');
}

function notImplemented(name: string): Error {
  return new Error(
    `web-search provider adapter ${name} is not implemented yet; see docs/architecture/hand-search-websearch-plan.md`,
  );
}
