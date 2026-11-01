/**
 * Contract + negative test for the deterministic corrective-retry injection.
 *
 * Owns graph node: retry_visual_proof_injection (in
 * dashboard-e2e-execution-retry.graph.json).
 *
 * The merged bounded corrective-retry loop only re-dispatches on a clean
 * provider failure with no committed side effect. Every existing runner outcome
 * commits a tool side effect or fails deterministically for the whole serve
 * lifetime, so no runner option reached the branch; see
 * `docs/evidence/execution-corrective-retry-review-rework-20261101.md`.
 *
 * These tests bind the replacement proof to a real HTTP boundary, so the
 * "first execution attempt fails, the corrective attempt succeeds" claim cannot
 * become a constant:
 *   1. the execution turn is discriminated from the interpretation turn, so a
 *      single failure cannot land on intake;
 *   2. a non-JSON / tool-less body is never failed, so the proxy cannot be
 *      satisfied by failing every request;
 *   3. exactly the first matching request is failed with a non-2xx status, and
 *      the corrective request is forwarded to the real upstream;
 *   4. the forwarded request really reaches upstream and its streamed body comes
 *      back byte-for-byte, so forwarding is not faked.
 *
 * No serve, browser or real RCC is started here; the upstream is a local
 * stand-in that records what it was asked.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  INJECTED_FAILURE_STATUS,
  isExecutionTurnBody,
  startRetryInjectionProxy,
} from './lib/retry-injection.mjs';

const INTERPRETATION_BODY = JSON.stringify({
  model: 'gpt-5.5',
  instructions: 'interpret the committed raw input',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '{"rawInput":"hello"}' }] }],
  tools: [
    { type: 'function', name: 'task_query' },
    { type: 'function', name: 'task_match' },
    { type: 'function', name: 'interaction_propose' },
  ],
  stream: true,
});

const EXECUTION_BODY = JSON.stringify({
  model: 'gpt-5.5',
  instructions: 'execute the confirmed requirement',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search the workspace' }] }],
  tools: [
    { type: 'function', name: 'file_search' },
    { type: 'function', name: 'file_read' },
  ],
  stream: true,
});

const servers = [];

async function startUpstream() {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const address = server.address();
  return { server, seen, baseUrl: `http://127.0.0.1:${address.port}` };
}

test.after(() => {
  for (const server of servers) server.close();
});

test('the execution turn is discriminated from the interpretation turn', () => {
  assert.equal(isExecutionTurnBody(EXECUTION_BODY), true, 'the file-tool turn is the execution turn');
  assert.equal(isExecutionTurnBody(INTERPRETATION_BODY), false, 'the interaction-tool turn is never the execution turn');
});

test('a body that is not a real provider request is never failed', () => {
  assert.equal(isExecutionTurnBody(''), false, 'an empty body is not the execution turn');
  assert.equal(isExecutionTurnBody('not json'), false, 'an unparsable body is not the execution turn');
  assert.equal(isExecutionTurnBody('null'), false, 'a null body is not the execution turn');
  assert.equal(isExecutionTurnBody('[1,2,3]'), false, 'an array body carries no provider request');
  assert.equal(isExecutionTurnBody(JSON.stringify({ model: 'gpt-5.5', input: [] })), false, 'a tool-less body is not the execution turn');
  assert.equal(isExecutionTurnBody(JSON.stringify({ tools: [] })), false, 'an empty tool list is not the execution turn');
  assert.equal(
    isExecutionTurnBody(JSON.stringify({ tools: [{ type: 'function', name: 'whatever' }] })),
    false,
    'a turn with no execution file tool is not the execution turn',
  );
});

test('only the first execution turn fails, and the corrective attempt reaches upstream', async () => {
  const upstream = await startUpstream();
  const proxy = await startRetryInjectionProxy({ upstream: upstream.baseUrl });
  try {
    const send = (body) => fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    // Intake must never be failed: it is forwarded, not failed.
    const interpretation = await send(INTERPRETATION_BODY);
    assert.equal(interpretation.status, 200, 'the interpretation turn must be served by upstream');
    await interpretation.text();

    // Attempt 1 of the execution turn is the injected failure.
    const first = await send(EXECUTION_BODY);
    assert.equal(first.status, INJECTED_FAILURE_STATUS, 'attempt 1 must fail with the injected non-2xx status');
    const firstBody = await first.json();
    assert.match(
      String(firstBody?.error?.type ?? ''),
      /harness_injected_retryable_failure/,
      'the injected failure must identify itself as harness-injected, not as an upstream fault',
    );
    assert.equal(upstream.seen.length, 1, 'the failed request must not be forwarded to upstream');

    // Attempt 2 is the corrective attempt and must be genuinely served.
    const second = await send(EXECUTION_BODY);
    assert.equal(second.status, 200, 'the corrective attempt must reach and be served by upstream');
    const secondBody = await second.text();
    assert.match(secondBody, /response\.output_text\.delta/, 'the corrective attempt must carry the real streamed body');
    assert.match(secondBody, /\[DONE\]/, 'the corrective attempt must carry the real stream terminator');

    // A third execution turn is no longer failed: the injection is one-shot, so
    // the proof cannot be satisfied by failing the whole serve lifetime.
    const third = await send(EXECUTION_BODY);
    assert.equal(third.status, 200, 'after the single injection every turn must be served');
    await third.text();

    assert.equal(upstream.seen.length, 3, 'upstream must have served intake plus both execution turns');
    assert.equal(upstream.seen[1].body, EXECUTION_BODY, 'the corrective attempt must be forwarded with its real body');
    assert.equal(proxy.record.injectedCount, 1, 'exactly one request may be injected');
    assert.equal(proxy.record.injectedPaths[0], '/v1/responses');
    assert.deepEqual(proxy.record.errors, [], 'the proxy must not report transport errors');
  } finally {
    await proxy.close();
  }
});
