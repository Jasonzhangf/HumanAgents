# Hand Search Services: Requirements, DAG, and Delivery Plan

Status: design candidate — Agent Reach / Monid TinyFish provider enabled, with
the Dashboard tool registration and invoke / cancel / result / report / cleanup
lifecycle included. This is the Agent Reach / Monid TinyFish-enabled candidate
for the network-search acceptance class; it awaits independent design review
before coding.

Baseline: `cc5f3f0d49d98a4148abcdc7f7bcc814c80cdbb2`

Graph artifact: [`docs/dagpipe/hand-search-websearch.graph.json`](../dagpipe/hand-search-websearch.graph.json)

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

This version additionally covers the Dashboard `web.search` Provider tool and
its invoke / cancel / result / report / cleanup lifecycle (see "Dashboard tool
lifecycle"). The Dashboard tool and the Hand gateway `web.search` service share
the same real provider backend but have separate owners and separate result
semantics.

## Non-goals

- No new general Task Gateway lifecycle is introduced in this change.
- The real external provider is scoped to the Agent Reach / Monid TinyFish
  `/search` route only. No provider discovery, no multi-provider routing, no
  paid fallback provider, no built-in search substitution, and no generic
  network scraping adapter is added.
- Provider credentials, endpoints, CLI flags, and route names are not stored in
  this repository and are not copied into business payloads; they are read from
  the then-current source of truth at execution time.
- No DSH integration is added.
- Provider/model bindings remain control-plane configuration and are not copied
  into request or report business payloads.
- No changes are made to the existing low-level agent tools.

The earlier non-goal that excluded a real external web provider, credentials,
provider discovery, and a network adapter is superseded by the scope above: the
Agent Reach / Monid TinyFish backend is now the production provider binding.

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
not the provider, owns URL validation, de-duplication, rank normalization and
applying the result bound; the completeness value is the provider's own
`complete` signal, which the service records and, together with
`requireComplete`, turns into the success/failure decision (see the exact field
relationships at the provider boundary below). `domains` and `recency` are passed
to the provider as search constraints; this MVP does not claim to independently
verify provider-side recency or domain filtering.

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

The provider boundary is control-plane injected. The provider returns **every
validated match it found for the requested scope**; it does not apply
`maxResults`, because a provider-side bound would make the pre-bound match count
unrecoverable and the service could not compute `resultsFound` or
`resultsTruncated`:

```ts
interface WebSearchProvider {
  search(input: {
    query: string;
    domains: readonly string[];
    recency: 'day' | 'week' | 'month' | 'year' | 'any';
    signal: AbortSignal;
  }): Promise<{
    results: readonly WebSearchResult[];
    complete: boolean;
    unresolvedSources: readonly string[];
  }>;
}
```

The exact relationship between the provider output and the report fields is:

- `validMatches` is the provider's `results` after the service's URL validation,
  de-duplication and rank normalization; it is never bounded by `maxResults`.
- `resultsFound = validMatches.length` — the number of valid matches before the
  requested bound is applied.
- `results = validMatches.slice(0, maxResults)`; therefore
  `results.length === Math.min(resultsFound, maxResults)`.
- `resultsTruncated === resultsFound > maxResults` — a pure bound signal, and the
  only thing that sets it.
- `searchComplete === provider.complete` — whether the provider covered the whole
  requested scope. It is independent of `maxResults`: a search can be complete
  and truncated at the same time, and incomplete without being truncated.
- `unresolvedSources` is copied verbatim from the provider and lists the sources
  the provider could not cover; it is not a truncation signal.

A provider that cannot return an unbounded match list cannot satisfy this
contract and must fail with `provider-failed` rather than silently applying its
own bound.

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

Superseded: the earlier statement that "the first implementation uses a
deterministic injected provider in focused tests only" and that a live service
without a production provider binding "remains explicitly unavailable" no
longer describes this version. A real Agent Reach / Monid TinyFish provider
binding is now in scope (see below). A deterministic injected provider remains
valid for focused unit tests, but it is not live-search evidence and must never
be presented as live web search.

## Real external provider backend: Agent Reach / Monid TinyFish

The production `WebSearchProvider` binding is the Agent Reach route, which
forwards web search to Monid TinyFish. A search is invoked as:

```sh
monid run -p tinyfish -e /search --query '{"query":"<query>","purpose":"<purpose>"}' -w
```

The backend is read-only and free (price 0). It returns real result sources
(`url`, `title`, `snippet`), which the service validates and normalizes before
any report is written.

Failure semantics are explicit and never fabricating:

- When the backend is unavailable, unreachable, or refuses the call, the result
  is an explicit `provider-unavailable` failure. A backend error after a
  successful invocation is `provider-failed`.
- The service MUST NOT fall back to a paid provider, a built-in search, model
  knowledge, or a fabricated empty success. A missing backend is never reported
  as a successful zero-result search.
- `provider-unavailable` stays distinguishable from a valid complete zero-result
  search: only a provider that actually answered may produce an empty complete
  report.
- A missing live provider binding is an explicit provider failure or an
  `INCOMPLETE` acceptance result, never a successful live-search result.

Credentials, endpoints, CLI flags, and model/route names are read from the
then-current source of truth at execution time. They are never inferred from
memory, from this document, or from a previous run, and they are never copied
into request or report business payloads.

This backend is the single provider-invocation owner for web search. It is
consumed through the control-plane-injected `WebSearchProvider` port; neither
the Dashboard tool layer nor the UI re-implements provider invocation.

## Dashboard tool lifecycle (SESE DAG)

The Dashboard exposes web search as a Provider tool call, not as the Hand
gateway service object. The two share the same provider backend but keep
distinct owners and semantics:

- the Hand gateway `web.search` service owns operation intent, the typed
  `WebSearchReport`, the artifact, and the verifier (above);
- the Dashboard `web.search` Provider tool owns tool registration, the typed
  tool result, report persistence/digest, and the tool-output retrieval edge.

The lifecycle is a single-entry/single-exit DAG, and it is a **single chain**:
every node has exactly one input and one output, so the graph contains no
conjunctive (AND) join anywhere. Each stage emits a typed attempt record that is
either a success or an explicit error, and passes it to the next stage; a failure
at any stage therefore still reaches the closure tail. Its project graph artifact
is
[`docs/dagpipe/hand-search-websearch.graph.json`](../dagpipe/hand-search-websearch.graph.json),
validated by `pnpm dagpipe:validate`. Nodes, in order:

1. tool registration / capability exposure: register `web.search` in the
   Provider tool table and expose it to the Responses and Anthropic protocol
   projections.
2. provider tool-call projection: project `ProviderEvent.toolCall`
   (`callId`, `toolId`, arguments) into the runtime task event / journal from the
   original call context.
3. invoke: dispatch the call through the operations web-search route to the
   injected Agent Reach / Monid TinyFish provider.
4. backend search: run the real read-only TinyFish `/search` call. An unavailable
   or failing backend records an explicit `provider-unavailable` /
   `provider-failed` error in the attempt record instead of aborting the chain.
5. typed result: validate and normalize the provider output into a typed result;
   failure and cancellation produce a typed failure/cancel result with the same
   `callId`, never a fabricated success and never a `toolCall` masquerading as a
   result. A provider failure is never converted into a complete zero-result
   report.
6. report persistence (success only): the Dashboard tool writes the report to the
   immutable asset store and attaches the unique typed descriptor
   `{ outputRef, outputDigest }`, where `outputDigest` is
   `sha256:<64 lowercase hex>`; the digest is recomputed on read. On failure or
   cancellation this stage passes the attempt record through unchanged. The
   descriptor must exist before projection, because projection renders it.
7. journal projection: `packages/runtime/src/ui-runtime/coordinator.ts` is the
   single projector that turns the tool call and the persisted typed result —
   success, provider failure, and cancellation alike — into `RuntimeTaskEvent` /
   Journal records, so the Dashboard can render the call, the typed result, the
   failure or cancellation status, and the descriptor through GET / SSE / DOM. A
   result that is never projected is not observable evidence, so this stage is on
   the chain rather than optional.
8. report retrieval (success only): the task-scoped read endpoint
   `GET /api/tasks/{taskId}/operations/{operationId}/executions/{executionEpoch}/events/{seq}/tool-output`
   validates task/operation/epoch/seq and the descriptor digest, then returns the
   report. It never exposes artifact file paths and never looks up by `callId`
   alone. On failure or cancellation this stage passes the record through.
9. outcome selection: the single explicit terminal selector. It reads the attempt
   record and emits exactly one terminal — success, explicit provider failure, or
   cancellation. It never emits two, and it is the only node whose output is a
   terminal.
10. terminal settlement: settle the selected terminal. For a cancellation a
    task-scoped stop reaches the route, aborts the operation-scoped controller,
    drains the provider call, and settles; a stop that cannot prove drain reaches
    `failed` or `reconcile_required`, is never reported as `cancelled`, and never
    yields a false `cancelled` terminal. For success and failure it confirms the
    operation is settled before cleanup.
11. cleanup closure: release this attempt's resources (isolated
    workspace/control root, server PID/port, temporary files) and record the
    release evidence; an unsettled run stays `INCOMPLETE` and keeps the recovery
    resources.

The DAG has one source (tool registration) and one sink (cleanup closure), and
success, provider failure and cancellation are mutually exclusive terminals
selected by node 9, so each of the three outcomes is a complete
single-entry/single-exit path and no node ever requires two of them at once.

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
  -> injected WebSearchProvider (production: Agent Reach / Monid TinyFish)
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
- `packages/adapters/operations/src/web-search-route.ts`: the Hand gateway
  `web.search` service's artifact-backed operation route, verifier, abort/drain
  adapter, and filesystem boundary checks. It keeps the Hand gateway service's own
  report/artifact and verifier semantics.
- `packages/adapters/operations/src/web-search-provider.ts`: the real Agent Reach
  / Monid TinyFish `WebSearchProvider` adapter, and the single
  provider-invocation owner for web search. It returns every validated match and
  does not apply `maxResults`. It is the shared boundary that both the Hand
  gateway `web.search` service and the Dashboard `web.search` Provider tool call;
  neither of them re-implements provider invocation.
- `packages/app`: explicit route registration, execution-epoch forwarding, and
  route-specific stop settlement. Existing `code.search` registration is
  reused; this work does not add another dispatcher. A non-cancellable route
  receives a stop receipt with `stopped=false` and `sideEffectState='possible'`,
  which the existing gateway maps to recovery rather than false cancellation.
- `packages/app/src/provider-tool-execution.ts`: the Dashboard `web.search`
  Provider tool declaration, dispatch, typed tool result, and report
  persistence/digest (single owner). It is a different owner from the Hand
  gateway `web.search` service and must not reuse its report semantics: the
  Dashboard tool calls the shared provider adapter above and writes its own
  report, and it must not dispatch through `web-search-route.ts`, which would
  make the Hand route a second report writer for the same call.
- `packages/adapters/provider/src/agent-driver.ts`: projects tool calls and
  results from the original call context for the Responses and Anthropic
  protocols.
- `packages/runtime/src/ui-runtime/coordinator.ts`: projects calls and results
  into `RuntimeTaskEvent` / Journal.
- `packages/app/src/ui-runtime/service.ts` and `server.ts`: the task-scoped
  tool-output read endpoint and the task-scoped stop dispatch.
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

The network-search acceptance class additionally requires this version of the
plan and its SESE DAG to pass an independent design review before any coding.
Until then the class stays `INCOMPLETE`; after coding it is accepted only under
[`docs/ui/dashboard-e2e-acceptance.md`](../ui/dashboard-e2e-acceptance.md) with
the live evidence above.

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

## Evidence

Real live-search evidence for the network-search class is:

- a real Provider tool call (`ProviderEvent.toolCall`) for `web.search` with its
  `callId`, `toolId`, and arguments, projected into the runtime task event /
  journal;
- a real typed result event with the same `callId` and real result sources
  carrying `url` and `title` (plus snippet), together with the immutable
  descriptor `{ outputRef, outputDigest }` whose digest is re-verified on read;
- a verifiable terminal state (success, explicit provider failure, or a settled
  cancellation) bound to the same task/operation/execution epoch and visible in
  the Dashboard.

The following are NOT real live-search evidence:

- unit tests with an injected or deterministic provider;
- a mock or recorded provider;
- an API-only call without the Dashboard browser path;
- a `connected` provider status;
- a fabricated empty success when the backend is unavailable.

Superseded: the earlier closing statement that "a missing live provider binding
is a known explicit limitation" is replaced by the rule above — a missing live
provider binding is an explicit `provider-unavailable` failure or an
`INCOMPLETE` acceptance result, never a successful live-search result.
