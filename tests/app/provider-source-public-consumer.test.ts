import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assembleProviderExecutionPort } from '../../packages/app/src/provider-assembly.js';
import { canStartProviderRequest } from '../../packages/app/src/provider-admission.js';
import { ProviderAgentDriver } from '../../packages/adapters/provider/src/index.js';
import { id, type EvidenceRef, type ProviderBinding, type ScopeRef } from '../../packages/contracts/src/index.js';

/**
 * Component failure basis for this focused consumer.
 *
 * Failure mode: `assembleProviderExecutionPort` ignores its validated `source`
 * and always builds the RCC transport. A configured `source: 'http'` binding
 * then silently runs RCC discovery and never reaches the direct endpoint over
 * the real socket or its continuation loop.
 * Impact: high; wrong-source routing and spurious `/health` + `/v1/models`
 * probes.
 * Probability: unknown until this real-socket continuation runs.
 * Cost: unknown; one local `127.0.0.1` socket consumer with the existing two
 * cases. Restoring a forced `source: 'rcc'` in the assembler turns the HTTP
 * assertions below red.
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

interface RecordedHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
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
 * The RCC comparison keeps the fetch-boundary capture so it stays independent
 * from the real HTTP socket used by the HTTP source case. The transport still
 * builds the URL, headers and body exactly as it would for a real endpoint.
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

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeSse(response: ServerResponse, frames: readonly unknown[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end();
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeIdleConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const scope: ScopeRef = {
  organId: id('organ', 'g-source-assembly'),
  taskId: id('task', 'g-http-task'),
  operationId: id('operation', 'g-http-op'),
};

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `g-http-${label}`),
    kind: 'execution',
    source: 'test',
    locator: label,
    scope,
  };
}

const httpBinding: ProviderBinding = {
  bindingId: 'g-http-binding',
  // The local label is unrelated to the source strategy.
  providerId: 'http',
  protocol: 'responses',
  endpointRef: 'http:127.0.0.1:0',
  modelRef: 'http.model',
  configDigest: 'sha256:g-http-config',
  capabilityDigest: 'sha256:g-http-capability',
};

test('G source-aware assembly uses the HTTP source without RCC discovery', async () => {
  const recorded: RecordedHttpRequest[] = [];
  const executedCalls: Array<{
    readonly callId: string;
    readonly toolId: string;
    readonly arguments: unknown;
    readonly aborted: boolean;
  }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      recorded.push({
        method: request.method ?? 'GET',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      if (request.method === 'POST' && request.url === '/v1/responses') {
        const responseCount = recorded.filter((entry) => entry.method === 'POST' && entry.url === '/v1/responses').length;
        if (responseCount === 1) {
          writeSse(response, [
            { type: 'response.created', response: { id: 'response-http-consumer-1' } },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                type: 'function_call',
                call_id: 'call_g_http_1',
                name: 'file_read',
                arguments: '{"path":"README.md"}',
              },
            },
            { type: 'response.completed', response: { id: 'response-http-consumer-1' } },
          ]);
          return;
        }
        writeSse(response, [
          { type: 'response.created', response: { id: 'response-http-consumer-2' } },
          { type: 'response.output_text.done', item_id: 'message-final', text: 'HTTP_SOURCE_CONSUMER_OK' },
          { type: 'response.completed', response: { id: 'response-http-consumer-2' } },
        ]);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', data: [] }));
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing socket address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const liveBinding: ProviderBinding = {
    ...httpBinding,
    endpointRef: `http:127.0.0.1:${address.port}`,
  };
  const previousCredential = process.env.HUMANAGENT_TEST_G_HTTP_TOKEN;
  process.env.HUMANAGENT_TEST_G_HTTP_TOKEN = 'test-only-g-http-token';
  let evidenceRoot: string | undefined;
  try {
    evidenceRoot = await createEvidenceRoot('http');
    const port = assembleProviderExecutionPort({
      binding: liveBinding,
      routeRef: 'http-route',
      baseUrl,
      source: 'http',
      credentialRef: 'env:HUMANAGENT_TEST_G_HTTP_TOKEN',
    }, evidenceRoot);
    assert.equal(port.kind, 'humanagent.execution-runtime-port');

    // The HTTP source has no RCC discovery contract: readiness is an honest
    // unknown with the http owner, and no probe reaches the network.
    const readiness = await port.probe(liveBinding);
    assert.equal(readiness.state, 'unknown');
    assert.equal(readiness.ownerId, 'humanagent.provider-adapter.http');
    assert.equal(readiness.nextAction?.ref, 'http.start');
    assert.deepEqual(recorded, []);

    // The expected no-discovery HTTP `unknown` is requestable. An arbitrary
    // `unknown` without that typed next action is not, and the same readiness
    // is not requestable under the RCC source.
    assert.equal(canStartProviderRequest('http', readiness), true);
    assert.equal(canStartProviderRequest('http', { ...readiness, nextAction: undefined }), false);
    assert.equal(canStartProviderRequest('rcc', readiness), false);

    // The resolved binding identity is preserved, not re-derived here.
    await assert.rejects(() => port.probe({ ...liveBinding, bindingId: 'g-other-binding' }));
    assert.deepEqual(recorded, []);

    const driver = new ProviderAgentDriver({
      port,
      binding: liveBinding,
      runtimeId: 'g-http-runtime',
      taskId: scope.taskId!,
      operationId: scope.operationId!,
      executionEpoch: 1,
      assignmentId: 'g-http-assignment',
      scope,
      inputRefs: ['task://g-http/input/1'],
      tools: [{
        toolId: 'file.read',
        description: 'Read a fixture through the real HTTP tool loop',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
      executeTool: {
        async execute(input) {
          executedCalls.push({
            callId: input.call.callId,
            toolId: input.call.toolId,
            arguments: input.call.arguments,
            aborted: input.signal.aborted,
          });
          return {
            output: 'G_HTTP_TOOL_RESULT',
            outputRefs: [],
            evidenceRefs: [evidence('tool-result')],
            status: 'succeeded' as const,
          };
        },
      },
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

    assert.deepEqual(executedCalls, [{
      callId: 'call_g_http_1',
      toolId: 'file.read',
      arguments: { path: 'README.md' },
      aborted: false,
    }]);

    // Two real socket requests: the initial tool call and its exact result
    // continuation. No `/health` and no `/v1/models`.
    assert.equal(recorded.length, 2);
    assert.deepEqual(recorded.map((request) => [request.method, request.url]), [
      ['POST', '/v1/responses'],
      ['POST', '/v1/responses'],
    ]);
    assert.equal(recorded.some((request) => request.url.endsWith('/health') || request.url.endsWith('/v1/models')), false);

    const initialBody = JSON.parse(recorded[0]!.body) as {
      model?: string;
      tools?: Array<{ type?: string; name?: string }>;
      input?: unknown;
      stream?: boolean;
    };
    assert.equal(initialBody.model, liveBinding.modelRef);
    assert.equal(initialBody.stream, true);
    assert.equal(initialBody.tools?.some((tool) => tool.type === 'function' && tool.name === 'file_read'), true);
    assert.equal(Array.isArray(initialBody.input), true);
    assert.equal(recorded[0]!.headers.authorization, 'Bearer test-only-g-http-token');
    assert.equal(recorded[0]!.headers.accept, 'text/event-stream');

    const continuationBody = JSON.parse(recorded[1]!.body) as {
      model?: string;
      input?: Array<Record<string, unknown>>;
    };
    assert.equal(continuationBody.model, liveBinding.modelRef);
    const functionOutputs = (continuationBody.input ?? []).filter((item) => item.type === 'function_call_output');
    assert.equal(functionOutputs.length, 1);
    assert.equal(functionOutputs[0]?.call_id, 'call_g_http_1');
    assert.equal(String(functionOutputs[0]?.output).includes('G_HTTP_TOOL_RESULT'), true);
    assert.equal(recorded[1]!.headers.authorization, 'Bearer test-only-g-http-token');
  } finally {
    if (previousCredential === undefined) delete process.env.HUMANAGENT_TEST_G_HTTP_TOKEN;
    else process.env.HUMANAGENT_TEST_G_HTTP_TOKEN = previousCredential;
    await closeServer(server);
    if (evidenceRoot !== undefined) await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('G source-aware assembly keeps the RCC source discovery contract', async () => {
  const capture = captureFetch();
  const evidenceRoot = await createEvidenceRoot('rcc');
  const rccBinding: ProviderBinding = {
    ...httpBinding,
    bindingId: 'g-rcc-binding',
    providerId: 'rcc',
    endpointRef: 'rcc-v3:127.0.0.1:4599',
  };
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
