# Call usage input contract

The App projects committed requests and provider usage facts from the Organ Journal.

## Input row

`CallUsageInput` is one model request, ordered by the Journal's real request/call identity before `projectCallUsage` is called:

- `callId`: the real request identity, stable across protocols and unique within one task/session scope. Replay count must not mint a new ID.
- `turnId`: the owning business turn. One turn may contain multiple model calls.
- `inputTokens`, `outputTokens`: provider-reported final cumulative values. The collector normalizes streaming fragments first.
- `cacheReadTokens`, `cacheWriteTokens`: cache read and cache creation, kept separate. OpenAI cached input is a subset of input. For Anthropic, the collector supplies total input after combining ordinary input, cache creation, and cache read without counting cache read twice.
- `contextLimit`: the trusted capacity of the model actually bound to this request. Omit it when no exact model match exists; never select the first catalog row or hard-code a marketing limit.
- `elapsedMs`: measured full response time. Optional `measuredOutputMs` is a separately measured generation interval.

Omit an unknown field and pass an explicit zero as `0`. Never coerce missing values to zero. A repository adapter deduplicates repeated facts by real Journal identity before calling this pure projection; the projection rejects duplicate `callId` rows.

## Output semantics

`CallUsageRead` retains each call's input, output, cache read/write, context used/limit/percent, current-call cache hit rate, previous-call hit rate, previous-business-turn hit rate, task weighted hit rate, output speed and basis, plus input/cache-read coverage counts.

Every hit rate is cache-read tokens divided by input tokens over the same rows, token-weighted. It never averages percentages. A row missing either side is excluded from both numerator and denominator. A range with no known sample or a zero denominator returns `null`. Context percent is input tokens divided by context limit; missing input or capacity and zero capacity return `null`. Output speed is output tokens divided by elapsed seconds, preferring `measuredOutputMs` over `elapsedMs`; missing output, missing elapsed time, or zero elapsed time returns `null`.

## Read and refresh boundary

The authorized `GET /api/product/session` returns top-level `usage` alongside `messages` and `boardIndex`. Specify the bound project and mode, then select a session with `sessionId` or a task with `taskId`. A statistics source failure preserves messages and returns `usage: null` and `usageFailure`. The optional debug request field exposes the provider request.

Reads are stateless; reading the same committed records again returns the same result. The call-completion Journal/SSE refresh event remains pending collector wiring. Public fields are `callId`, `turnId`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `context.used|limit|percent`, `currentCallCacheHitRate`, `previousCallCacheHitRate`, `previousBusinessTurnCacheHitRate`, `taskCacheHitRate`, `outputSpeed.tokensPerSecond|basis`, and `coverage`.

The HTTP consumer regression in `tests/app/session-debug-current-request.test.ts` reads usage from the same committed requests that produced the paired end-tool result.
