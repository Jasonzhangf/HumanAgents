# TinyFish `/search` capability evidence (agent-reach route)

Owner: `packages/adapters/operations/src/web-search-provider.ts` (design owner).
Collected: 2026-10-01, read-only, from the real provider through `monid` 0.1.7 with
the free-only policy (`pricing: $0/call`, `cost: 0`). No product code was changed.

Purpose: fix the provider contract to what the provider actually returns, instead
of an unbounded "all matches on the web" claim it cannot support.

## Endpoint

```bash
# one-shot observation (waits for completion, so no run id is capturable in time)
monid run -p tinyfish -e /search --query '{"query":"...","purpose":"..."}' -w -j
# the form the adapter must use: start without -w, capture runId, then poll
monid run -p tinyfish -e /search --query '{"query":"...","purpose":"...","page":0}' -j
monid inspect -p tinyfish -e /search
```

`monid inspect` reports the endpoint as **Verified**, health **healthy**, pricing
`PER_CALL $0`, `additionalProperties: false` on the query-param schema.

### Query parameters (verified schema)

| Parameter | Type | Constraint |
| --- | --- | --- |
| `query` | string | required, minLength 1 |
| `purpose` | string | maxLength 2000 |
| `location` | string | country code |
| `language` | string | language code |
| `include_domains` / `exclude_domains` | string | comma separated |
| `recency_minutes` | integer | 1..5256000 |
| `after_date` / `before_date` | string | `YYYY-MM-DD` |
| `domain_type` | enum | `web` (default) \| `news` \| `research_paper` |
| `pub_year_min` / `pub_year_max` | integer | 0..9999 |
| `page` | integer | **0..10, zero-indexed** |

There is **no** `max_results` parameter and **no** total-available-count parameter.
The endpoint description documents "paging ('page', 0-10)" as the only way to reach
more than one page of results.

### Response body (observed)

```json
{
  "query": "HumanAgent long-horizon harness",
  "results": [
    { "position": 1, "site_name": "arxiv.org", "snippet": "...", "title": "...", "url": "https://arxiv.org/abs/2608.01964" }
  ],
  "total_results": 10,
  "page": 0
}
```

Result item keys observed: `position`, `site_name`, `snippet`, `title`, `url`.
`research_paper` adds `authors`, `venue`, `year`, `cited_by_count`, `pdf_url`;
`news` adds publisher and date fields. Snippets only — the endpoint never returns
page content.

### Paging is real, and `total_results` is per page

| Run | `page` | `results.length` | `total_results` | First three URLs |
| --- | --- | --- | --- | --- |
| `01M3W7MRR43D77FRS9HY37DJP0` | 0 | 10 | 10 | `arxiv.org`, `github.com`, `lh-harness.pages.dev` |
| `01M3W7MRR43D77FRS9HY37DJP0` (same query, `page:1`) | 1 | 10 | 10 | `youtube.com`, `skillsllm.com`, `reddit.com` |

Conclusions that constrain the contract:

1. `page` returns a different ranked window, so **more matches are reachable**;
   but each page restarts `position` at 1, so a caller must track
   `position + page * perPageBound` if it needs a global rank.
2. `total_results` equals the number of results returned **for that page**; it is
   not a global match count. No field reports how many matches exist in total.
3. The only observable completeness signal is a page that returns **fewer than the
   per-page bound** (observed bound: 10). Page 0..10 ⇒ at most 11 pages.
4. Every page is charged as a separate call; each observed call cost `0`.

Therefore the adapter, not the caller, owns result collection: it pages `0..10`,
stops at the first short page, and reports `providerPagesFetched` and
`providerExhausted = lastPageWasShort`. `resultsFound` is then the number of
validated matches actually collected, which is deterministic and replayable — it
is *not* a claim about everything on the web.

## Cancellation

```bash
monid runs get -r <runId> -j     # status and result of a run
monid runs stop -r <runId> -j    # stop an in-progress run
```

`monid run` without `-w` prints the run record immediately, including `runId` and
`status`, so the run id is capturable before the provider call finishes.

Observed `monid runs stop` on an already-finished run:

```json
{ "error": { "code": "CONFLICT", "message": "Run 01M3W7NXVC697KFRSCAMFG896P is already COMPLETED" } }
```

Conclusions:

1. Stop is only meaningful while the run is non-terminal; `CONFLICT` on a
   completed run is expected and must be surfaced as "already settled", not as a
   stop failure.
2. Aborting a local promise or killing the child process does **not** prove the
   remote run stopped. The adapter must keep the `runId`, call
   `monid runs stop`, then poll `monid runs get` until a terminal status.
3. If the run never reaches a terminal status within the bounded poll window, the
   attempt is `provider-unsettled`, which the settlement node maps to
   `failed`/`reconcile_required`. It is never reported as `cancelled`.
