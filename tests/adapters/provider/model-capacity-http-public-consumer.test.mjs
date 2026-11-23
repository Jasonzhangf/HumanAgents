import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Isolated compilation; never consume another repairer's shared dist output.
const build = resolve(process.env.CAPACITY_TEST_BUILD ?? 'dist/capacity-review-b');
const load = path => import(pathToFileURL(join(build, 'packages', path)));
const { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, createRccModelCatalog,
  filesystemProviderEvidenceSink } = await load('adapters/provider/src/index.js');
const { ImmutableAssetStore } = await load('adapters/filesystem/src/index.js');
const { id } = await load('contracts/src/index.js');

// Reachable failure: the model has completed but optional catalog I/O stalls.
// Impact: no terminal/continuation/settlement. Cost: isolated local HTTP only.
for (const mode of ['normal', 'unmatched', 'failure', 'headers-hang', 'body-hang', 'cancel', 'oversize', 'tool-body-hang']) {
  test(`production provider HTTP consumer: capacity ${mode}`, { timeout: 8000 }, async () => {
    const base = join(homedir(), '.humanagent', 'test-fixtures');
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'capacity-review-b-'));
    let catalogActive = 0;
    let catalogSeen;
    const seen = new Promise(resolve => { catalogSeen = resolve; });
    const catalogReleases = [];
    const sockets = new Set();
    let posts = 0;
    let continuation;
    const server = createServer(async (request, response) => {
      if (request.url === '/v1/models') {
        catalogActive++;
        catalogReleases.push(new Promise(resolve => response.on('close', () => { catalogActive--; resolve(); })));
        catalogSeen();
        if (mode === 'headers-hang') return;
        if (mode === 'failure') { response.writeHead(503); response.end('unavailable'); return; }
        response.writeHead(200, { 'content-type': 'application/json' });
        if (mode === 'body-hang' || mode === 'cancel' || mode === 'tool-body-hang') { response.write('{"data":['); return; }
        if (mode === 'oversize') { response.write(' '.repeat(2048)); return; }
        response.end(JSON.stringify({ data: [
          { id: 'requested-alias', context_window: 999 },
          { id: mode === 'unmatched' ? 'another-model' : 'actual-model', context_window: 128000 },
        ] }));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      posts++;
      if (posts > 1) continuation = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { type: 'response.created', response: { id: 'capacity-response', model: 'actual-model' } },
        ...(mode === 'tool-body-hang' && posts === 1
          ? [{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'tool-item',
            call_id: 'capacity-tool', name: 'file.read', arguments: '{"path":"example"}' } }]
          : [{ type: 'response.output_text.done', item_id: 'answer', text: 'completed answer' }]),
        { type: 'response.completed', response: { id: 'capacity-response', model: 'actual-model',
          usage: { input_tokens: 10, output_tokens: 2 } } },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const binding = { bindingId: 'capacity-b', providerId: 'capacity-b', protocol: 'responses',
      endpointRef: url, modelRef: 'requested-alias', configDigest: 'fixture', capabilityDigest: 'fixture' };
    const scope = { organId: id('organ', 'capacity-b'), taskId: id('task', 'capacity-b'), operationId: id('operation', 'capacity-b') };
    const identity = { runtimeId: 'capacity-b', taskId: scope.taskId, operationId: scope.operationId, executionEpoch: 1 };
    const evidenceRefs = [{ evidenceId: id('evidence', 'capacity-b'), kind: 'execution', source: 'capacity-b', locator: 'capacity-b', scope }];
    const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
    const port = new ProviderAdapter({ binding, routeRef: 'capacity-b', codec: new ResponsesProviderCodec(), evidence,
      transport: new V3ProviderHttpTransport({ binding, baseUrl: url, source: 'http', evidence }),
      modelCapacitySource: createRccModelCatalog({ baseUrl: url,
        readTimeoutMs: ['cancel', 'oversize'].includes(mode) ? 10000 : 150, maxBytes: 1024 }),
    });
    const facts = [];
    let observed;
    let watchdog;
    try {
      const tools = [{ toolId: 'file.read', description: 'read example', inputSchema: { type: 'object' } }];
      await port.start({ ...identity, inputRefs: ['input'], evidenceRefs, payload: { prompt: 'answer' },
        ...(mode === 'tool-body-hang' ? { tools } : {}) });
      const started = Date.now();
      observed = (async () => {
        const events = [];
        for await (const event of port.observe({ ...identity, onRawFacts: async batch => { facts.push(...batch); } })) events.push(event);
        return events;
      })();
      await Promise.race([seen, observed]);
      // A long catalog budget distinguishes cancellation from the deadline.
      const stopping = mode === 'cancel'
        ? port.requestStop({ ...identity, reason: 'capacity consumer cancellation', ownerId: 'capacity-b', evidenceRefs })
        : undefined;
      const events = await Promise.race([observed, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`capacity ${mode} blocked the completed model terminal`)), 1200);
      })]);
      if (stopping) await stopping;
      assert.ok(Date.now() - started < 1000, 'optional capacity must finish within the diagnostic boundary');
      assert.ok(events.some(event => event.kind === 'terminal'), 'real model terminal must be observable');
      const usage = facts.find(fact => fact.kind === 'usage');
      assert.ok(usage, 'usage is emitted even when capacity is unavailable');
      assert.equal(usage.responseModel, 'actual-model');
      assert.equal(usage.outputTokens, 2);
      assert.deepEqual(usage.capacity, mode === 'normal'
        ? { state: 'known', source: 'rcc-models', contextWindow: 128000 }
        : { state: 'unknown', reason: mode === 'unmatched' ? 'model-not-in-catalog' : 'catalog-unavailable' });
      if (mode === 'tool-body-hang') {
        assert.equal(events.at(-1).terminalState, 'waiting');
        assert.equal(events.find(event => event.kind === 'tool')?.toolCall?.callId, 'capacity-tool');
        const submitted = await port.submit({ ...identity, inputRefs: ['tool-output'], evidenceRefs,
          payload: { toolResultRef: 'tool-output' }, tools,
          toolContinuations: [{ callId: 'capacity-tool', toolId: 'file.read', arguments: { path: 'example' },
            continuationRef: 'capacity-response', output: 'actual tool output' }] });
        assert.equal(submitted.status, 'accepted');
        const nextEvents = [];
        for await (const event of port.observe(identity)) nextEvents.push(event);
        assert.equal(nextEvents.at(-1).terminalState, 'succeeded');
        assert.equal(posts, 2, 'only one paired continuation');
        assert.ok(continuation.input.some(item => item.type === 'function_call_output'
          && item.call_id === 'capacity-tool' && item.output === 'actual tool output'));
      }
      const settlement = await port.settle(identity);
      assert.equal(settlement.resourceRelease.state, 'released');
      assert.ok(['succeeded', 'stopped'].includes(settlement.state));
      assert.equal((await port.close(binding)).state, 'closed');
      const released = Promise.all(catalogReleases);
      await Promise.race([released, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('catalog request was not released')), 500);
        released.finally(() => clearTimeout(timer));
      })]);
      assert.equal(catalogActive, 0, 'catalog request released before fixture cleanup');
      console.log(JSON.stringify({ mode, terminal: true, capacity: usage.capacity, settlement: settlement.state,
        resourceRelease: settlement.resourceRelease.state, catalogActive, elapsedMs: Date.now() - started }));
    } finally {
      clearTimeout(watchdog);
      // Failure cleanup is separate from the assertions above.
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      if (observed) await observed.catch(() => {});
      await rm(root, { recursive: true, force: true });
      assert.equal(server.listening, false);
      assert.equal(sockets.size, 0);
    }
  });
}
