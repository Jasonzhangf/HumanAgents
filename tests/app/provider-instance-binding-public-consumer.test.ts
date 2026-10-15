import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProviderConfig, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { ConfigurationError, validateUserConfig, compileAgentProviderBindings } from '../../packages/config/src/index.js';
import { prepareAgentProvider, providerBindingFromConfig, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import { ProviderAgentDriver } from '../../packages/adapters/provider/src/index.js';
import { id, type ScopeRef } from '../../packages/contracts/src/index.js';

// Confirmed gap: shared global port/default-only probe can route a selected
// actor to the wrong source/model. Numeric probability UNKNOWN; local cost
// moderate. One continuous socket consumer catches that failure, without a
// protocol matrix. Provider request completion is not task business success.
const fixtureRoot = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures');

interface Wire { method: string; path: string; body: string; }

async function upstream(model: string, authentication?: { value: string; protocol: 'responses' | 'anthropic' }) {
  const wires: Wire[] = [];
  const authenticationChecks: { bearer: boolean; key: boolean; version: boolean; hasBearer: boolean; hasKey: boolean }[] = [];
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
      if (authentication) authenticationChecks.push({
        bearer: request.headers.authorization === `Bearer ${authentication.value}`,
        key: request.headers['x-api-key'] === authentication.value,
        version: request.headers['anthropic-version'] === '2023-06-01',
        hasBearer: request.headers.authorization !== undefined,
        hasKey: request.headers['x-api-key'] !== undefined,
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const frames = authentication?.protocol === 'anthropic' ? [
        { type: 'message_start', message: { id: `message-${model}`, model, role: 'assistant' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: `output-${model}` } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ] : [
        { type: 'response.created', response: { id: `response-${model}` } },
        { type: 'response.output_text.done', item_id: 'message-final', text: `output-${model}` },
        { type: 'response.completed', response: { id: `response-${model}` } },
      ];
      response.end(frames.map((frame) => `${authentication?.protocol === 'anthropic' ? `event: ${frame.type}\n` : ''}data: ${JSON.stringify(frame)}\n\n`).join(''));
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
    wires, authenticationChecks, baseUrl: `http://127.0.0.1:${address.port}`,
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
  const drivenPorts = new Set<AgentProviderComposition['port']>();
  const compositions: AgentProviderComposition[] = [];
  const receipts: string[] = [];
  let primaryError: unknown;
  const credentialName = 'HUMANAGENT_COMPOSER_TEST_CREDENTIAL';
  const credentialRef = 'env:HUMANAGENT_COMPOSER_TEST_CREDENTIAL' as const;
  const credentialValue = 'composer-fake-credential';
  const priorCredential = process.env[credentialName];
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
    const prepare = async (configuredAgentId: string) => {
      const actor = await prepareAgentProvider({
      roleId: 'execution', configuredAgentId, agentProviderBindings: entries,
      legacyProvider: httpProvider,
      evidenceRoot: root,
      });
      compositions.push(actor);
      return actor;
    };
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
      drivenPorts.add(actor.port);
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
      drivers.splice(drivers.indexOf(driver), 1);
      receipts.push(`${runtimeId}:closed`);
    };

    // Confirmed missing App forwarding prevents authenticated endpoints.
    // Cost: two actual protocol requests and one missing-ref zero-I/O check.
    process.env[credentialName] = credentialValue;
    const authenticated = await upstream('credential.responses.model', { value: credentialValue, protocol: 'responses' });
    listeners.push(authenticated);
    const anthropic = await upstream('credential.anthropic.model', { value: credentialValue, protocol: 'anthropic' });
    listeners.push(anthropic);
    const config = validateUserConfig({
      schemaVersion: 1,
      agents: [{
        agentId: 'credential-selected', roleId: 'interaction', templateRef: 'builtin/interaction@1.0.0',
        driverRef: 'fake', skills: ['input-normalization'], tools: ['input.receive'],
        permissions: ['task.read'], memoryScopes: ['task'], resourceClass: 'foreground',
        provider: { ...httpProvider, model: 'credential.responses.model', baseUrl: authenticated.baseUrl, credentialRef },
      }, {
        agentId: 'credential-anthropic', roleId: 'interaction', templateRef: 'builtin/interaction@1.0.0',
        driverRef: 'fake', skills: ['input-normalization'], tools: ['input.receive'],
        permissions: ['task.read'], memoryScopes: ['task'], resourceClass: 'foreground',
        provider: { ...httpProvider, protocol: 'anthropic', model: 'credential.anthropic.model', baseUrl: anthropic.baseUrl, credentialRef },
      }],
    });
    const credentialEntries = compileAgentProviderBindings(config);
    const prepareCredential = async (configuredAgentId: string) => {
      const actor = await prepareAgentProvider({
        roleId: 'interaction', configuredAgentId, agentProviderBindings: credentialEntries,
        legacyProvider: httpProvider, evidenceRoot: root,
      });
      compositions.push(actor);
      return actor;
    };
    const credentialActor = await prepareCredential('credential-selected');
    await execute(credentialActor, 'credential-responses');
    assert.equal(authenticated.authenticationChecks[0]?.bearer, true, 'actual Responses request must carry the resolved Bearer header');
    assert.equal(authenticated.authenticationChecks[0]?.hasKey, false);
    assertWireCredential(authenticated.wires, '/v1/responses', 'credential.responses.model');
    const anthropicActor = await prepareCredential('credential-anthropic');
    await execute(anthropicActor, 'credential-anthropic');
    assert.equal(anthropic.authenticationChecks[0]?.key, true, 'actual Anthropic request must carry the resolved x-api-key header');
    assert.equal(anthropic.authenticationChecks[0]?.version, true);
    assert.equal(anthropic.authenticationChecks[0]?.hasBearer, false);
    assertWireCredential(anthropic.wires, '/v1/messages', 'credential.anthropic.model');
    function assertWireCredential(wires: Wire[], path: string, model: string) {
      assert.equal(wires.length, 1);
      assert.equal(wires[0]?.method, 'POST');
      assert.equal(wires[0]?.path, path);
      assert.equal(JSON.parse(wires[0]!.body).model, model);
      for (const token of [credentialRef, credentialValue]) assert.equal(wires[0]!.body.includes(token), false);
    }
    async function evidenceBytes(directory: string): Promise<string[]> {
      const bytes: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        bytes.push(entry.name);
        if (entry.isDirectory()) bytes.push(...await evidenceBytes(path));
        else bytes.push(await readFile(path, 'utf8'));
      }
      return bytes;
    }
    for (const bytes of [JSON.stringify(credentialActor.binding), JSON.stringify(anthropicActor.binding), ...await evidenceBytes(root)]) {
      for (const token of [credentialRef, credentialValue]) assert.equal(bytes.includes(token), false);
    }
    delete process.env[credentialName];
    const beforeMissing = await evidenceBytes(root);
    const requestsBeforeMissing = authenticated.wires.length + anthropic.wires.length;
    await assert.rejects(() => prepareCredential('credential-selected'), (error: unknown) => {
      if (!(error instanceof ConfigurationError)) throw error;
      assert.equal(error.code, 'config-credential-unavailable');
      for (const token of [credentialRef, credentialValue]) assert.equal(String(error).includes(token), false);
      return true;
    });
    assert.equal(authenticated.wires.length + anthropic.wires.length, requestsBeforeMissing, 'missing reference must cause zero new requests');
    assert.deepEqual(await evidenceBytes(root), beforeMissing, 'missing reference must create no evidence resources');
    console.log(JSON.stringify({ credentialRequests: 2, protocols: ['responses', 'anthropic'], missingReferenceRequests: 0, evidenceUnchanged: true, credentialLeak: false }));
    receipts.length = 0;

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
    // Only the changed option edges need new coverage: legal no-roster legacy
    // overrides, configured canonical isolation, and one Anthropic budget wire.
    const optionWires: Wire[] = [];
    const optionServer = createServer((request, response) => {
      void (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        optionWires.push({ method: request.method ?? '', path: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url === '/health') {
          response.end(JSON.stringify({ status: 'ok', version: 's4-options' }));
        } else if (request.url === '/v1/models') {
          response.end(JSON.stringify({ data: [{ id: 'legacy.model' }, { id: 'configured.model' }] }));
        } else {
          const sent: { model: string } = JSON.parse(body);
          response.end([
            { type: 'message_start', message: { id: `message-${sent.model}`, model: sent.model, role: 'assistant' } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: `output-${sent.model}` } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            { type: 'message_stop' },
          ].map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
        }
      })().catch((error: unknown) => { response.end(String(error)); });
    });
    await new Promise<void>((resolve, reject) => {
      optionServer.once('error', reject);
      optionServer.listen(0, '127.0.0.1', resolve);
    });
    const address = optionServer.address();
    if (address === null || typeof address === 'string') throw new Error('missing option socket address');
    const optionBaseUrl = `http://127.0.0.1:${address.port}`;
    listeners.push({
      wires: optionWires, authenticationChecks: [], baseUrl: optionBaseUrl, deny: () => {},
      close: async () => {
        optionServer.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => optionServer.close((error) => error ? reject(error) : resolve()));
        assert.equal(optionServer.address(), null);
      },
    });
    const legacyProvider: ProviderConfig = {
      source: 'rcc', provider: 'rcc', binding: 'legacy-binding', protocol: 'anthropic',
      model: 'legacy.model', route: 'legacy-route', baseUrl: optionBaseUrl,
    };
    const overrides = { endpointRef: 'legacy:explicit-endpoint', configDigest: 'sha256:legacy-config', capabilityDigest: 'sha256:legacy-capability' };
    const legacyActor = await prepareAgentProvider({
      roleId: 'memory', agentProviderBindings: [], legacyProvider,
      legacyBindingOverrides: overrides, maxTokens: 731, evidenceRoot: root,
    });
    compositions.push(legacyActor);
    assert.equal(legacyActor.configuredAgentId, undefined);
    assert.deepEqual(legacyActor.provider, legacyProvider);
    assert.equal(legacyActor.binding.endpointRef, overrides.endpointRef);
    assert.equal(legacyActor.binding.configDigest, overrides.configDigest);
    assert.equal(legacyActor.binding.capabilityDigest, overrides.capabilityDigest);
    await execute(legacyActor, 'legacy-options');
    const configuredProvider: ProviderConfig = { ...legacyProvider, binding: 'configured-binding', model: 'configured.model', route: 'configured-route' };
    const configuredActor = await prepareAgentProvider({
      roleId: 'memory', configuredAgentId: 'configured-options',
      agentProviderBindings: [{ agentId: 'configured-options', roleId: 'memory', source: 'inherited', provider: configuredProvider }],
      legacyProvider: httpProvider, legacyBindingOverrides: overrides, maxTokens: 731, evidenceRoot: root,
    });
    compositions.push(configuredActor);
    assert.deepEqual(configuredActor.provider, configuredProvider);
    assert.equal(configuredActor.binding.modelRef, configuredProvider.model);
    assert.equal(configuredActor.binding.endpointRef, `rcc-v3:127.0.0.1:${address.port}`);
    assert.deepEqual(configuredActor.binding, providerBindingFromConfig(configuredProvider));
    await execute(configuredActor, 'configured-options');
    assert.deepEqual(optionWires.filter((wire) => wire.method === 'GET').map((wire) => wire.path), ['/health', '/v1/models', '/health', '/v1/models']);
    const optionPosts = optionWires.filter((wire) => wire.method === 'POST');
    assert.equal(optionPosts.length, 2);
    assert.deepEqual(optionPosts.map((wire) => wire.path), ['/v1/messages', '/v1/messages']);
    assert.deepEqual(optionPosts.map((wire) => JSON.parse(wire.body).model), ['legacy.model', 'configured.model']);
    for (const wire of optionPosts) assert.equal(JSON.parse(wire.body).max_tokens, 731);
    console.log(JSON.stringify({ optionWires, optionReceipts: receipts.slice(-4) }));
    console.log(JSON.stringify({ root, http: http.baseUrl, rcc: rcc.baseUrl, receipts, httpWire: http.wires, rccWire: rcc.wires }));
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    if (priorCredential === undefined) delete process.env[credentialName];
    else process.env[credentialName] = priorCredential;
    const closedDrivers = await Promise.allSettled(drivers.map((driver) => driver.close()));
    const closedPorts = await Promise.allSettled(compositions.filter((actor) => !drivenPorts.has(actor.port)).map(async (actor) => {
      assert.equal((await actor.port.close(actor.binding)).state, 'closed');
    }));
    const closedListeners = await Promise.allSettled(listeners.map((listener) => listener.close()));
    const cleanupErrors = [...closedDrivers, ...closedPorts, ...closedListeners]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (cleanupErrors.length > 0) {
      if (primaryError !== undefined) console.error('S4 cleanup failure; original failure preserved', cleanupErrors);
      else throw new AggregateError(cleanupErrors, 'S4 driver/listener cleanup failed');
    } else {
      try {
        await rm(root, { recursive: true, force: true });
        assert.equal((await readdir(fixtureRoot)).includes(root.slice(root.lastIndexOf('/') + 1)), false);
        console.log(`S4 cleanup: ${drivenPorts.size} driver-owned ports closed; ${compositions.length - drivenPorts.size} unused ports closed; ${listeners.length} listeners closed; fake env restored; owned evidence root removed`);
      } catch (cleanupError: unknown) {
        if (primaryError !== undefined) console.error('S4 evidence cleanup failure; original failure preserved', cleanupError);
        else throw cleanupError;
      }
    }
  }
});
