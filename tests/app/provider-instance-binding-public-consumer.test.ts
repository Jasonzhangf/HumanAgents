import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProviderConfig, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { prepareAgentProvider, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import { ProviderAgentDriver } from '../../packages/adapters/provider/src/index.js';
import { id, type ScopeRef } from '../../packages/contracts/src/index.js';

// Confirmed gap: shared global port/default-only probe can route a selected
// actor to the wrong source/model. Numeric probability UNKNOWN; local cost
// moderate. One continuous socket consumer catches that failure, without a
// protocol matrix. Provider request completion is not task business success.
const fixtureRoot = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures');

interface Wire { method: string; path: string; body: string; }

async function upstream(model: string) {
  const wires: Wire[] = [];
  let ready = true;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const path = request.url ?? '';
      wires.push({ method: request.method ?? '', path, body: Buffer.concat(chunks).toString('utf8') });
      if (path === '/health' || path === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(path === '/health'
          ? { status: ready ? 'ok' : 'not-ready', version: 's4-local' }
          : { data: [{ id: model }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { type: 'response.created', response: { id: `response-${model}` } },
        { type: 'response.output_text.done', item_id: 'message-final', text: `output-${model}` },
        { type: 'response.completed', response: { id: `response-${model}` } },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing socket address');
  return {
    wires, baseUrl: `http://127.0.0.1:${address.port}`,
    deny: () => { ready = false; },
    close: async () => {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.address(), null);
    },
  };
}

test('selected public default factory preserves each actor wire, own admission and fresh lifecycle', async () => {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'selected-s4-'));
  const listeners: Awaited<ReturnType<typeof upstream>>[] = [];
  const drivers: ProviderAgentDriver[] = [];
  const receipts: string[] = [];
  let primaryError: unknown;
  try {
    const http = await upstream('http.actor.model');
    listeners.push(http);
    const rcc = await upstream('rcc.actor.model');
    listeners.push(rcc);
    const httpProvider: ProviderConfig = {
      source: 'http', provider: 'http', binding: 'http-binding',
      protocol: 'responses', model: 'http.actor.model', route: 'http-route', baseUrl: http.baseUrl,
    };
    const rccProvider: ProviderConfig = {
      source: 'rcc', provider: 'rcc', binding: 'rcc-binding',
      protocol: 'responses', model: 'rcc.actor.model', route: 'rcc-route', baseUrl: rcc.baseUrl,
    };
    const entries: EffectiveAgentProviderBinding[] = [
      { agentId: 'configured-http', roleId: 'execution', source: 'agent', provider: httpProvider },
      { agentId: 'configured-rcc', roleId: 'execution', source: 'agent', provider: rccProvider },
    ];
    const prepare = (configuredAgentId: string) => prepareAgentProvider({
      roleId: 'execution', configuredAgentId, agentProviderBindings: entries,
      legacyProvider: httpProvider,
      evidenceRoot: root,
    });
    const httpActor = await prepare('configured-http');
    const rccActor = await prepare('configured-rcc');
    const repeated = await prepare('configured-rcc');
    assert.equal(httpActor.configuredAgentId, 'configured-http');
    assert.equal(rccActor.configuredAgentId, 'configured-rcc');
    assert.equal(repeated.configuredAgentId, 'configured-rcc');
    assert.ok(repeated.port !== rccActor.port, 'each selected instance must own a fresh port');
    assert.ok(httpActor.port !== rccActor.port, 'actors must not share the default port');

    const execute = async (actor: AgentProviderComposition, runtimeId: string) => {
      const scope: ScopeRef = {
        organId: id('organ', 'selected-s4'), taskId: id('task', runtimeId), operationId: id('operation', runtimeId),
      };
      const driver = new ProviderAgentDriver({
        port: actor.port, binding: actor.binding, runtimeId, taskId: scope.taskId!,
        operationId: scope.operationId!, executionEpoch: 1, assignmentId: runtimeId,
        scope, inputRefs: [`task://${runtimeId}/input/1`],
      });
      drivers.push(driver);
      await driver.start({ runtimeId, taskId: scope.taskId!, executionEpoch: 1 });
      await driver.submit({ taskId: scope.taskId!, executionEpoch: 1, assignmentId: runtimeId, payload: { prompt: 'selected actor wire consumer' } });
      const events = [];
      for await (const event of driver.observe({ runtimeId })) events.push(event);
      const settled = await driver.settle({ runtimeId, executionEpoch: 1 });
      assert.equal(settled.state, 'succeeded');
      assert.equal(events.find((event) => event.kind === 'provider.output')?.summary, `output-${actor.provider.model}`);
      assert.equal(events.at(-1)?.terminalState, 'succeeded');
      receipts.push(`${runtimeId}:request-settled`);
      await driver.close();
      receipts.push(`${runtimeId}:closed`);
    };

    await execute(httpActor, 'http-first');
    // Consumer-boundary counterexample: replacing the selected pair with the
    // actual default pair must fail these unchanged wire/identity assertions.
    const selectedRcc = rccActor;
    await execute(selectedRcc, 'rcc-first');
    await execute(repeated, 'rcc-repeat');
    const assertWire = (wires: Wire[], model: string, count: number) => {
      const posts = wires.filter((wire) => wire.method === 'POST');
      assert.equal(posts.length, count);
      for (const wire of posts) {
        assert.equal(wire.path, '/v1/responses');
        const sent = JSON.parse(wire.body) as { model?: string; input?: unknown; stream?: boolean };
        assert.equal(sent.model, model);
        assert.ok(Array.isArray(sent.input));
        assert.equal(sent.stream, true);
      }
    };
    assertWire(http.wires, httpProvider.model, 1);
    assertWire(rcc.wires, rccProvider.model, 2);
    assert.deepEqual(http.wires.map((wire) => wire.method), ['POST']);
    assert.deepEqual(rcc.wires.filter((wire) => wire.method === 'GET').map((wire) => wire.path), [
      '/health', '/v1/models', '/health', '/v1/models',
    ]);

    rcc.deny();
    const postsBefore = rcc.wires.filter((wire) => wire.method === 'POST').length;
    await assert.rejects(() => prepare('configured-rcc'), /health endpoint did not report status ok/);
    assert.equal(rcc.wires.filter((wire) => wire.method === 'POST').length, postsBefore);
    await execute(await prepare('configured-http'), 'http-after-reject');
    assertWire(http.wires, httpProvider.model, 2);
    assertWire(rcc.wires, rccProvider.model, 2);
    assert.deepEqual(receipts, [
      'http-first:request-settled', 'http-first:closed', 'rcc-first:request-settled', 'rcc-first:closed',
      'rcc-repeat:request-settled', 'rcc-repeat:closed', 'http-after-reject:request-settled', 'http-after-reject:closed',
    ]);
    console.log(JSON.stringify({ root, http: http.baseUrl, rcc: rcc.baseUrl, receipts, httpWire: http.wires, rccWire: rcc.wires }));
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    const closedDrivers = await Promise.allSettled(drivers.map((driver) => driver.close()));
    const closedListeners = await Promise.allSettled(listeners.map((listener) => listener.close()));
    const cleanupErrors = [...closedDrivers, ...closedListeners]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (cleanupErrors.length > 0) {
      if (primaryError !== undefined) console.error('S4 cleanup failure; original failure preserved', cleanupErrors);
      else throw new AggregateError(cleanupErrors, 'S4 driver/listener cleanup failed');
    } else {
      try {
        await rm(root, { recursive: true, force: true });
        assert.equal((await readdir(fixtureRoot)).includes(root.slice(root.lastIndexOf('/') + 1)), false);
        console.log(`S4 cleanup: ${drivers.length} drivers closed; ${listeners.length} listeners closed; owned evidence root removed`);
      } catch (cleanupError: unknown) {
        if (primaryError !== undefined) console.error('S4 evidence cleanup failure; original failure preserved', cleanupError);
        else throw cleanupError;
      }
    }
  }
});
