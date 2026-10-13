import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assembleProviderExecutionPort } from '../../packages/app/src/provider-assembly.js';
import { canStartProviderRequest } from '../../packages/app/src/provider-admission.js';
import { ProviderAgentDriver } from '../../packages/adapters/provider/src/index.js';
import { id, type ProviderBinding, type ScopeRef } from '../../packages/contracts/src/index.js';

/**
 * Component failure basis for this focused consumer.
 *
 * Failure mode: `assembleProviderExecutionPort` ignores its validated `source`
 * and always builds the RCC transport. A configured `source: 'http'` binding
 * then silently runs RCC discovery and never reaches the direct endpoint.
 * Impact: wrong-source routing and spurious `/health` + `/v1/models` probes.
 * Cost: one unit test with a captured `globalThis.fetch`; no sockets, live
 * endpoints or transport matrix. Restoring a forced `source: 'rcc'` in the
 * assembler turns the HTTP assertions below red.
 */

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

interface FetchCapture {
  readonly requests: CapturedRequest[];
  restore(): void;
}

const encoder = new TextEncoder();

/**
 * Every durable artifact must live under `~/.humanagent`. `HUMANAGENT_TEST_ROOT`
 * exists only so a sandboxed worker can exercise this same consumer locally;
 * the formal default stays the `~/.humanagent` root.
 */
const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures');

async function createEvidenceRoot(name: string): Promise<string> {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  return mkdtemp(join(PERSISTENCE_ROOT, `humanagent-g-source-assembly-${name}-`));
}

function sseResponse(frames: readonly unknown[]): Response {
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * The sandbox blocks binding a loopback socket, so the capture happens at the
 * `globalThis.fetch` boundary. The transport still builds the URL, headers and
 * body exactly as it would for a real endpoint; only the OS socket is replaced.
 * It returns real `Response` objects so the transport SSE parsing and readiness
 * decoding run unchanged.
 */
function captureFetch(): FetchCapture {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  const capture = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    requests.push({ method, url, body: typeof init?.body === 'string' ? init.body : '' });
    if (method === 'GET' && url.endsWith('/health')) {
      return new Response(JSON.stringify({ status: 'ok', version: 'capture-fetch' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'GET' && url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'http.model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return sseResponse([
      { type: 'response.created', response: { id: 'response-http-consumer' } },
      { type: 'response.output_text.done', item_id: 'message-final', text: 'HTTP_SOURCE_CONSUMER_OK' },
      { type: 'response.completed', response: { id: 'response-http-consumer' } },
    ]);
  }) as typeof globalThis.fetch;
  globalThis.fetch = capture;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

const scope: ScopeRef = {
  organId: id('organ', 'g-source-assembly'),
  taskId: id('task', 'g-http-task'),
  operationId: id('operation', 'g-http-op'),
};

const httpBinding: ProviderBinding = {
  bindingId: 'g-http-binding',
  // The local label is unrelated to the source strategy.
  providerId: 'rcc',
  protocol: 'responses',
  endpointRef: 'http:127.0.0.1:4599',
  modelRef: 'http.model',
  configDigest: 'sha256:g-http-config',
  capabilityDigest: 'sha256:g-http-capability',
};

test('G source-aware assembly uses the HTTP source without RCC discovery', async () => {
  const capture = captureFetch();
  const evidenceRoot = await createEvidenceRoot('http');
  try {
    const port = assembleProviderExecutionPort({
      binding: httpBinding,
      routeRef: 'http-route',
      baseUrl: 'http://127.0.0.1:4599',
      source: 'http',
    }, evidenceRoot);
    assert.equal(port.kind, 'humanagent.execution-runtime-port');

    // The HTTP source has no RCC discovery contract: readiness is an honest
    // unknown with the http owner, and no probe reaches the network.
    const readiness = await port.probe(httpBinding);
    assert.equal(readiness.state, 'unknown');
    assert.equal(readiness.ownerId, 'humanagent.provider-adapter.http');
    assert.equal(readiness.nextAction?.ref, 'http.start');
    assert.deepEqual(capture.requests, []);

    // The expected no-discovery HTTP `unknown` is requestable. An arbitrary
    // `unknown` without that typed next action is not, and the same readiness
    // is not requestable under the RCC source.
    assert.equal(canStartProviderRequest('http', readiness), true);
    assert.equal(canStartProviderRequest('http', { ...readiness, nextAction: undefined }), false);
    assert.equal(canStartProviderRequest('rcc', readiness), false);

    // The resolved binding identity is preserved, not re-derived here.
    await assert.rejects(() => port.probe({ ...httpBinding, bindingId: 'g-other-binding' }));

    const driver = new ProviderAgentDriver({
      port,
      binding: httpBinding,
      runtimeId: 'g-http-runtime',
      taskId: scope.taskId!,
      operationId: scope.operationId!,
      executionEpoch: 1,
      assignmentId: 'g-http-assignment',
      scope,
      inputRefs: ['task://g-http/input/1'],
    });
    await driver.start({ runtimeId: 'g-http-runtime', taskId: scope.taskId!, executionEpoch: 1 });
    await driver.submit({
      taskId: scope.taskId!,
      executionEpoch: 1,
      assignmentId: 'g-http-assignment',
      payload: { prompt: 'run against the direct HTTP source' },
    });
    const events = [];
    for await (const event of driver.observe({ runtimeId: 'g-http-runtime' })) events.push(event);
    const settled = await driver.settle({ runtimeId: 'g-http-runtime', executionEpoch: 1 });
    await driver.close();

    assert.equal(settled.state, 'succeeded');
    assert.equal(events.find((event) => event.kind === 'provider.output')?.summary, 'HTTP_SOURCE_CONSUMER_OK');
    assert.equal(events.at(-1)?.terminalState, 'succeeded');

    // Exactly one request: the configured protocol endpoint encoded by the
    // binding-selected Responses codec. No `/health` and no `/v1/models`.
    assert.equal(capture.requests.length, 1);
    assert.equal(capture.requests[0]?.method, 'POST');
    assert.equal(capture.requests[0]?.url.endsWith('/v1/responses'), true);
    const sent = JSON.parse(capture.requests[0]!.body) as { model?: string; input?: unknown };
    assert.equal(sent.model, httpBinding.modelRef);
    assert.equal(Array.isArray(sent.input), true);
    assert.equal(capture.requests.some((request) => request.url.endsWith('/health') || request.url.endsWith('/v1/models')), false);
  } finally {
    capture.restore();
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('G source-aware assembly keeps the RCC source discovery contract', async () => {
  const capture = captureFetch();
  const evidenceRoot = await createEvidenceRoot('rcc');
  const rccBinding: ProviderBinding = { ...httpBinding, bindingId: 'g-rcc-binding', endpointRef: 'rcc-v3:127.0.0.1:4599' };
  try {
    const port = assembleProviderExecutionPort({
      binding: rccBinding,
      routeRef: 'rcc-route',
      baseUrl: 'http://127.0.0.1:4599',
      source: 'rcc',
    }, evidenceRoot);

    const readiness = await port.probe(rccBinding);
    assert.equal(readiness.state, 'ready');
    assert.equal(readiness.failure, undefined);
    assert.equal(canStartProviderRequest('rcc', readiness), true);
    // The RCC source performs the existing discovery probe; the HTTP branch
    // above proves the selector is meaningful in both directions.
    assert.deepEqual(capture.requests.map((request) => request.url), [
      'http://127.0.0.1:4599/health',
      'http://127.0.0.1:4599/v1/models',
    ]);
    assert.equal(capture.requests.some((request) => request.url.endsWith('/v1/responses')), false);
  } finally {
    capture.restore();
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});
