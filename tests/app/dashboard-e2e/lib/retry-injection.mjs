/**
 * Deterministic corrective-retry injection — real implementation.
 *
 * Purpose: make the *real* dashboard E2E entrance observe the merged bounded
 * corrective-retry loop (`coordinator.ts` `execution.retry` / `retrying`) when
 * attempt 1 fails retryably and attempt 2 succeeds. The loop itself is product
 * code and is not touched here; this module only makes the provider-side
 * failure deterministic.
 *
 * Why a transport-level failure is the right seam
 * -----------------------------------------------
 * The corrective loop re-dispatches only when all of these hold
 * (`packages/runtime/src/ui-runtime/coordinator.ts`, `shouldRetry`):
 *   1. the error policy disposition is `retry`,
 *   2. recovery mode is `execute`,
 *   3. `attemptNumber < maxAttempts` (product `maxAttempts` is 2),
 *   4. the manager returned a `remediation` assignment, and
 *   5. `committedSideEffects === false`.
 * Condition 5 excludes every tool-side-effect failure: a `file.search` /
 * `file.read` result is a committed side effect, so a tool-level error can never
 * reach the retry branch. The only remaining real producer of
 * "clean, retryable, no side effect" is a provider-level settle failure on the
 * first attempt, i.e. the model request itself failing before any tool ran.
 *
 * A failing HTTP attempt surfaces from `RccV3ProviderTransport.start` as a
 * `ProviderAdapterError` (`send()` throws on non-2xx), which the execution agent
 * reports as a failed attempt with no tool event and no produced file. That is
 * exactly the clean-failure shape, and it is induced here without touching
 * `packages/**`.
 *
 * Discrimination
 * --------------
 * The same serve process also drives the explicit-brain interpretation request
 * through the same binding/base URL. Failing that request would break intake
 * instead of the execution attempt. The two requests are distinguishable from
 * the wire body, because they expose disjoint tool sets: the interpretation turn
 * carries `interaction.propose` / `interaction.ask` / `task.match`, while the
 * execution turn carries `file.search` / `file.read` and never carries an
 * `interaction.*` tool. The proxy fails only requests that look like the
 * execution turn, and only once.
 */

import { createServer } from 'node:http';

/**
 * Provider tool names, as they appear on the Responses wire.
 *
 * `codecs.ts` maps canonical tool ids to wire names (`file.search` ->
 * `file_search`), so the body carries the underscored form. The interpretation
 * turn instead declares `dispatch_helper` / `accept_helper` (see
 * `explicit-brain-runtime.ts`), which are disjoint from every execution tool.
 */
const INTERPRETATION_TOOL_MARKERS = Object.freeze([
  'dispatch_helper',
  'accept_helper',
  'interaction_propose',
  'interaction_ask',
  'interaction_approve',
  'task_match',
]);

/** Wire names the real execution turn exposes. */
const EXECUTION_TOOL_MARKERS = Object.freeze(['file_search', 'file_read']);

/**
 * Decide whether one provider request body is the task-execution turn that must
 * fail once. Pure so the contract test can lock the discrimination without a
 * socket. A body that cannot be parsed, or that carries no tool definition at
 * all, is never treated as the execution turn.
 */
export function isExecutionTurnBody(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== 'object') return false;
  const tools = Array.isArray(payload.tools) ? payload.tools : null;
  if (tools === null) return false;
  const names = tools
    .map((tool) => (tool && typeof tool === 'object' ? tool.name : undefined))
    .filter((name) => typeof name === 'string');
  if (names.length === 0) return false;
  if (names.some((name) => INTERPRETATION_TOOL_MARKERS.includes(name))) return false;
  return names.some((name) => EXECUTION_TOOL_MARKERS.includes(name));
}

/** One HTTP status that makes the transport throw instead of streaming. */
export const INJECTED_FAILURE_STATUS = 503;

/**
 * Start an attempt-aware proxy in front of the real RCC endpoint.
 *
 * The first request that matches `isExecutionTurnBody` is answered with
 * `INJECTED_FAILURE_STATUS` and never forwarded, so the real provider is not
 * asked to serve a request the harness intends to fail. Every other request is
 * forwarded byte-for-byte, including the `text/event-stream` response, so the
 * corrective attempt and every interpretation turn are genuinely served by the
 * real RCC provider.
 */
export async function startRetryInjectionProxy(options) {
  const upstream = options.upstream.replace(/\/$/, '');
  const record = {
    upstream,
    injectedCount: 0,
    injectedPaths: [],
    forwardedCount: 0,
    forwardedPaths: [],
    errors: [],
  };

  const server = createServer(async (request, response) => {
    const chunks = [];
    try {
      for await (const chunk of request) chunks.push(chunk);
    } catch (error) {
      record.errors.push(`request body read failed: ${error.message}`);
      response.writeHead(400).end('request body read failed');
      return;
    }
    const body = Buffer.concat(chunks);
    const path = request.url ?? '/';
    const injectionAvailable = record.injectedCount === 0
      && request.method === 'POST'
      && isExecutionTurnBody(body.toString('utf8'));

    if (injectionAvailable) {
      record.injectedCount += 1;
      record.injectedPaths.push(path);
      // A non-2xx makes the transport throw before it ever tries to read a
      // stream body, which is the clean-failure shape the retry branch needs.
      response.writeHead(INJECTED_FAILURE_STATUS, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          type: 'harness_injected_retryable_failure',
          message: `deterministic attempt-1 failure injected by ${'retry-injection.mjs'} at the transport boundary`,
        },
      }));
      return;
    }

    record.forwardedCount += 1;
    record.forwardedPaths.push(path);
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(`${upstream}${path}`, {
        method: request.method,
        headers: { ...request.headers, host: new URL(upstream).host },
        body: body.length > 0 ? body : undefined,
      });
    } catch (error) {
      record.errors.push(`upstream ${path} failed: ${error.message}`);
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'harness_proxy_upstream_failure', message: error.message } }));
      return;
    }
    const headers = {};
    for (const [name, value] of upstreamResponse.headers) {
      if (name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding') continue;
      headers[name] = value;
    }
    response.writeHead(upstreamResponse.status, headers);
    if (!upstreamResponse.body) {
      response.end();
      return;
    }
    for await (const chunk of upstreamResponse.body) {
      if (response.writableEnded) break;
      response.write(chunk);
    }
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('retry injection proxy did not bind a TCP port');
  }
  record.port = address.port;
  record.baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    record,
    baseUrl: record.baseUrl,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
