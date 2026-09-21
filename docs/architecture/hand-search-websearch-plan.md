# Hand Search Services: Requirements, DAG, and Delivery Plan

Status: design candidate

## Scope

This change delivers two Hand Gateway services in order:

1. `code.search`: reuse the existing registration and search implementation,
   close its negative-path/security/cancellation acceptance gaps, and avoid
   duplicating the search implementation.
2. `web.search`: add a provider-injected semantic service and operation route.

The services are tasks submitted to Hand. They are not atomic file or network
tools exposed to the orchestrator. Each service owns the complete operation
from a high-level request to a bounded report, including validation,
verification, and explicit failure.

The existing `ToolExecutionGateway` remains the operation lifecycle owner. The
semantic service owns domain execution; the operation route adapts it to the
gateway's artifact and verifier contract; app assembly owns registration.

## Non-goals

- No new general Task Gateway lifecycle is introduced in this change.
- No real external web provider, credentials, provider discovery, or network
  scraping adapter is added.
- No DSH integration is added.
- Provider/model bindings remain control-plane configuration and are not copied
  into request or report business payloads.
- No changes are made to the existing low-level agent tools.

## `code.search` requirements

The public request is the existing `CodeSearchRequest`:

- `workspaceRef`, `path`, and `query` are required;
- `queryKind` is `literal`, `regex`, or `symbol`;
- `contextLines`, `maxResults`, and `requireComplete` are bounded controls;
- the request cannot escape the selected workspace.

The report must preserve the existing search evidence:

- matches and match counts;
- discovered/searched file counts;
- bounded `pathTree`;
- truncation and completeness state;
- unresolved paths;
- structured failure.

Acceptance requires that a registered `code.search` operation can be selected
through app assembly and that invalid scope, invalid regex, scope-too-large,
partial search, strict incomplete search, and verifier/identity failures reach
the gateway as explicit results.

## `web.search` requirements

The public request is:

```ts
type WebSearchRequest = {
  serviceId: 'web.search';
  contractVersion: '1.0.0';
  query: string;
  domains?: readonly string[];
  recency?: 'day' | 'week' | 'month' | 'year' | 'any';
  maxResults?: number;
  requireComplete?: boolean;
};
```

The report is intentionally simple and model-readable. `resultsFound` is the
number of valid provider matches before the requested result bound is applied;
`resultsTruncated` is true when that bound removes valid matches. The service,
not the provider, owns URL validation, de-duplication, rank normalization, and
the completeness decision. `domains` and `recency` are passed to the provider
as search constraints; this MVP does not claim to independently verify
provider-side recency or domain filtering.

```ts
type WebSearchReport = {
  serviceId: 'web.search';
  contractVersion: '1.0.0';
  status: 'succeeded' | 'failed';
  query: string;
  domains: readonly string[];
  recency: 'day' | 'week' | 'month' | 'year' | 'any';
  maxResults: number;
  requireComplete: boolean;
  results: readonly WebSearchResult[];
  resultsFound: number;
  resultsTruncated: boolean;
  searchComplete: boolean;
  unresolvedSources: readonly string[];
  summary: string;
  failure?: {
    code:
      | 'invalid-request'
      | 'provider-unavailable'
      | 'provider-failed'
      | 'invalid-result'
      | 'search-incomplete';
    message: string;
  };
};
```

`WebSearchResult` is fixed to:

```ts
type WebSearchResult = {
  url: string;
  title: string;
  snippet: string;
  rank: number;
  sourceName?: string;
  publishedAt?: string;
};
```

The request defaults are `domains=[]`, `recency='any'`, `maxResults=10`, and
`requireComplete=false`. `maxResults` must be a positive safe integer. A valid empty
provider result is a complete successful zero-result report; a bounded result
set with more valid provider matches is a successful truncated report. The
verifier binds `query`, normalized `domains`, normalized `recency`, and the
requested result bound, not only the query string.

The provider boundary is control-plane injected:

```ts
interface WebSearchProvider {
  search(input: {
    query: string;
    domains: readonly string[];
    recency: 'day' | 'week' | 'month' | 'year' | 'any';
    maxResults: number;
    signal: AbortSignal;
  }): Promise<{
    results: readonly WebSearchResult[];
    complete: boolean;
    unresolvedSources: readonly string[];
  }>;
}
```

The normalized business constraints are part of the report (`domains` and
`recency`) so the verifier can bind the complete request without copying any
provider/model control binding. The report also carries the normalized
`maxResults`, and `requireComplete`; these are request constraints, not
provider identity. The verifier binds all four normalized constraints plus
the query. A report created under `requireComplete=true` cannot be reused for
the same query under a different completeness policy, or vice versa.

The service must validate provider results before reporting success:

- URLs are `http` or `https`;
- title and snippet are non-empty;
- ranks are normalized and results are bounded and de-duplicated by URL;
- partial provider results remain visibly incomplete;
- `requireComplete=true` converts incomplete execution into
  `search-incomplete` failure;
- unavailable/provider/validation failures are explicit and never fabricated
  as successful search results.

The first implementation uses a deterministic injected provider in focused
tests only. Without a production provider binding, the live service remains
explicitly unavailable; tests must not be presented as live web search.

## Implementation DAG

### `code.search`

```text
CodeSearchRequest
  -> request and scope validation
  -> resolve registered code.search route
  -> CodeSearchRoute.execute (operation-scoped abort controller and execution epoch)
  -> CodeSearchService
  -> CodeSearchFunctions discovery/read
  -> write report artifact
  -> CodeSearchRoute.verify
  -> identity/scope/completeness checks
  -> ToolExecutionGateway settlement
  -> Hand report
```

Terminal states:

- success: report is written, identity matches, and completeness requirements
  are met;
- partial success: reads failed but `requireComplete=false`, with
  `searchComplete=false` and unresolved paths;
- failure: invalid request, path escape/not-found, invalid regex,
  scope-too-large, strict incomplete search, artifact failure, or verifier
  mismatch;
- cancellation: app assembly dispatches the gateway's typed stop request to
  the selected route. The route checks operation and execution epoch, aborts
  its operation-scoped controller, waits for its function harness to settle,
  and returns a stop receipt bound to operation, task, epoch, owner, and lease;
  a late function result cannot be committed;
- recovery/resource release: the existing operation gateway owns the terminal
  state and lease release, while the route owns the abort-and-drain of its
  active harness call. Abort or drain failure reaches `failed` or
  `reconcile_required`, never `cancelled`.

### `web.search`

```text
WebSearchRequest
  -> request validation
  -> resolve registered web.search route
  -> WebSearchRoute.execute (operation-scoped abort controller and execution epoch)
  -> WebSearchService
  -> injected WebSearchProvider
  -> result validation/normalization
  -> write report artifact
  -> WebSearchRoute.verify
  -> identity/completeness checks
  -> ToolExecutionGateway settlement
  -> Hand report
```

Terminal states:

- success: provider results are valid and complete enough for the request;
- partial success: valid results exist but provider reports incomplete and
  `requireComplete=false`;
- failure: invalid request, unavailable provider, provider failure, invalid
  provider result, strict incomplete search, artifact failure, or verifier
  mismatch;
- cancellation: app assembly dispatches the gateway's typed stop request to
  the selected route. The route checks operation and execution epoch, aborts
  the provider with the operation-scoped signal, and waits for the provider
  promise to settle before issuing a trusted stop receipt;
- recovery/resource release: the existing operation gateway owns terminal
  state and lease release; provider abort/drain failure reaches `failed` or
  `reconcile_required`, never `cancelled`.

## Ownership and file plan

- `packages/contracts`: public request/report/result types and exports.
- `packages/runtime/src/hand`: semantic service validation, normalization, and
  provider port.
- `packages/adapters/operations`: artifact-backed operation route, verifier,
  abort/drain adapter, and filesystem boundary checks.
- `packages/app`: explicit route registration, execution-epoch forwarding, and
  route-specific stop settlement. Existing `code.search` registration is
  reused; this work does not add another dispatcher. A non-cancellable route
  receives a stop receipt with `stopped=false` and `sideEffectState='possible'`,
  which the existing gateway maps to recovery rather than false cancellation.
- `tests/runtime/hand`: service behavior and failure matrix.
- `tests/app`: registered gateway end-to-end assembly and report verification.

No other package may parse these service requests or recreate their failure
semantics.

## Verification and delivery gates

For each service, in order:

1. design review confirms the DAG has entry, owner, success, failure,
   cancellation/recovery, resource release, and evidence terminals;
2. implement only the missing link in the existing ownership chain;
3. run focused contract/runtime/route/assembly tests;
4. perform independent review on the candidate commit;
5. merge the candidate into clean `main`;
6. rebuild affected packages and rerun the same-entry focused tests;
7. push `origin/main`.

The filesystem boundary policy is explicit: the workspace root, every request
path component, and every file path read by the harness must resolve to the
same canonical path under the configured workspace root; symlinked request
roots, symlinked parent components, and symlinked files are rejected as
`path-escape`. Discovery skips symlinks, and reads re-check canonicality so a
post-discovery replacement is rejected or read only through the already
canonical target; it is never reported as an ordinary partial read.

The cancellation acceptance matrix is: cancel before execution starts,
cancel during function/provider execution, stop failure, late completion after
stop failure, and cancellation during report write. Every case verifies the
operation/epoch/lease binding, the absence of a false `cancelled` result, and
the gateway's `failed` or `reconcile_required` recovery terminal when the
route cannot prove drain.

Evidence must distinguish provider-port tests from a real external web
provider. A missing live provider binding is a known explicit limitation, not a
successful live-search result.
