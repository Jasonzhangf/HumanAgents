#!/usr/bin/env node
/**
 * Real intake-failure-recovery black box.
 *
 * Starts the production UI runtime assembly (`startUiRuntime`, the same entry
 * the `serve` command mounts) on an isolated control root, workspace and
 * ephemeral port, and drives it over its own HTTP API:
 *
 *   1. the first explicit input is interpreted and the Provider SSE stream dies
 *      mid-flight after one durable reasoning unit, so the interpret fails and
 *      the provider close cannot complete;
 *   2. without any restart, a second explicit input is created and interpreted
 *      on the same daemon and must succeed;
 *   3. the on-disk control journal must show the failed epoch closed by its own
 *      committed failure record instead of staying pending.
 *
 * The only controlled piece is the external Provider upstream: a local SSE
 * server that breaks exactly one stream. The Provider adapter, the HTTP
 * transport, the journals, the daemon lease and the HTTP API are the real ones.
 *
 * Nothing here touches the shared production instance on 10086: the control
 * root, workspace, lease and port all belong to this run.
 *
 * Usage: node tests/app/intake-failure-recovery-blackbox.mjs
 */

import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist/app');
const { startUiRuntime } = await import(join(dist, 'app/src/ui-runtime/index.js'));
const { AccessControlService } = await import(join(dist, 'app/src/ui-runtime/access-control.js'));
const { acquireDaemonLease } = await import(join(dist, 'app/src/supervisor/index.js'));
const { ensureControlLayout, resolveRuntimePaths } = await import(join(dist, 'config/src/index.js'));
const { MemoryCoordinator } = await import(join(dist, 'runtime/src/memory/index.js'));
const { DeterministicMemoryBackend } = await import(join(dist, 'adapters/memory/src/index.js'));
const { ImmutableAssetStore } = await import(join(dist, 'adapters/filesystem/src/index.js'));
const { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } =
  await import(join(dist, 'adapters/provider/src/index.js'));
const { id } = await import(join(dist, 'contracts/src/index.js'));

const root = await mkdtemp(join(tmpdir(), 'humanagent-intake-failure-'));
const workspace = join(root, 'workspace');
const controlRoot = join(root, 'control');
await mkdir(workspace, { recursive: true });
await mkdir(controlRoot, { recursive: true });

const sse = (frames) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
const decision = JSON.stringify({
  kind: 'answer',
  normalizedInput: '黑盒输入',
  knownFacts: [],
  answer: '黑盒恢复成功',
  decisionRefs: [],
});

let providerRequests = 0;
const upstream = createServer(async (request, response) => {
  for await (const _discard of request) { /* drain the request body */ }
  providerRequests += 1;
  if (providerRequests === 1) {
    // The first physical stream: one durable reasoning unit, then an abrupt
    // transport death with no terminal frame. The Runtime accepts the first
    // unit and loses the stream, which is the live failure under proof.
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(sse([
      { type: 'response.created', response: { id: 'intake-failure-1' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs-intake', delta: '第一段' },
    ]));
    await new Promise((settle) => setTimeout(settle, 200));
    response.socket.destroy();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(sse([
    { type: 'response.created', response: { id: `intake-failure-${providerRequests}` } },
    { type: 'response.output_text.done', item_id: 'final', text: decision },
    { type: 'response.completed', response: { id: `intake-failure-${providerRequests}` } },
  ]));
  response.end();
});
const upstreamUrl = await new Promise((settle, fail) => {
  upstream.once('error', fail);
  upstream.listen(0, '127.0.0.1', () => settle(`http://127.0.0.1:${upstream.address().port}`));
});

const paths = await resolveRuntimePaths({ controlRoot, workspace });
await ensureControlLayout(paths);
const lease = await acquireDaemonLease(paths);
const evidenceRoot = join(root, 'assets');
const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot));
const binding = {
  bindingId: 'binding-intake-failure-blackbox',
  providerId: 'provider-intake-failure-blackbox',
  protocol: 'responses',
  endpointRef: 'http://intake-failure-upstream',
  modelRef: 'model-intake-failure-blackbox',
  configDigest: 'sha256:intake-failure-blackbox-config',
  capabilityDigest: 'sha256:intake-failure-blackbox-capability',
};
// A direct HTTP source has no RCC discovery probe, so the startup readiness
// read never claims a fabricated remote state and never calls the upstream.
const composition = () => ({
  roleId: 'interaction',
  source: 'http',
  provider: {
    source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
    model: binding.modelRef, route: 'intake/failure-blackbox', baseUrl: upstreamUrl,
  },
  binding,
  port: new ProviderAdapter({
    binding,
    routeRef: 'intake/failure-blackbox',
    codec: new ResponsesProviderCodec(),
    transport: new V3ProviderHttpTransport({ binding, baseUrl: upstreamUrl, source: 'http', evidence }),
    evidence,
  }),
});

const accessControl = await AccessControlService.open({
  credentialPath: join(root, 'security/web-access.json'),
  create: true,
});
const runtime = await startUiRuntime({
  mode: 'rcc',
  organId: id('organ', 'intake-failure-blackbox'),
  binding,
  port: composition().port,
  providerSource: 'http',
  productRoot: root,
  checkpointRoot: join(root, 'checkpoints'),
  evidenceRoot,
  uiRoot: join(process.cwd(), 'docs/ui'),
  portNumber: 0,
  lease,
  accessControl,
  explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
  memory: {
    coordinator: new MemoryCoordinator(),
    backend: new DeterministicMemoryBackend(),
    projectKey: 'intake-failure-blackbox',
  },
  runtimeComposition: {
    prepareAgentProvider: async () => composition(),
    prepareTaskAgentProvider: async () => { throw new Error('a simple answer must not prepare a Task'); },
  },
});

const origin = runtime.server.url;
const challenge = await accessControl.issuePairingChallenge();
const paired = await fetch(`${origin}/api/auth/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: challenge.code }),
});
if (paired.status !== 200) throw new Error(`pairing failed: ${paired.status} ${await paired.text()}`);
const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0];

const call = async (path, body) => {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
};
const createInput = async (label) => {
  const created = await call('/api/explicit/inputs', {
    channel: 'business',
    sourceRef: `blackbox:${label}`,
    rawInput: '黑盒输入',
  });
  return { status: created.status, interactionId: created.body?.interactionId };
};

const receipt = { instance: origin, provider: upstreamUrl, controlRoot, workspace };
try {
  const first = await createInput('first');
  const firstInterpret = await call(`/api/explicit/interactions/${encodeURIComponent(first.interactionId)}/interpret`, {});
  receipt.first = {
    interactionId: first.interactionId,
    createStatus: first.status,
    interpretStatus: firstInterpret.status,
    errorCode: firstInterpret.body?.error?.code,
    errorMessage: firstInterpret.body?.error?.message,
  };

  // No restart and no reinstall: the same daemon must serve the next input.
  const second = await createInput('second');
  const secondInterpret = await call(`/api/explicit/interactions/${encodeURIComponent(second.interactionId)}/interpret`, {});
  receipt.second = {
    interactionId: second.interactionId,
    createStatus: second.status,
    interpretStatus: secondInterpret.status,
    state: secondInterpret.body?.state,
    reply: secondInterpret.body?.reply,
    errorCode: secondInterpret.body?.error?.code,
    errorMessage: secondInterpret.body?.error?.message,
  };

  const journals = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (entry.name.endsWith('.jsonl')) journals.push(path);
    }
  };
  // Both the control root and the run's checkpoint root own journals.
  await walk(root).catch(() => {});
  let executionFailures = 0;
  let abandonmentRecords = 0;
  for (const path of journals) {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (line.trim() === '') continue;
      if (line.includes('turn-execution-failure')) executionFailures += 1;
      if (line.includes('turn-abandonment')) abandonmentRecords += 1;
    }
  }
  receipt.durable = {
    journals: journals.map((path) => path.slice(root.length + 1)),
    executionFailures,
    abandonmentRecords,
  };
  receipt.providerRequests = providerRequests;
  if (receipt.first.interpretStatus === 200) throw new Error('the first interpret was expected to fail');
  if (receipt.second.interpretStatus !== 200) throw new Error('the second interpret did not succeed');
  if (receipt.durable.executionFailures !== 1) throw new Error('the failed epoch is not durably closed');
  console.log(JSON.stringify({ ...receipt, outcome: 'recovered-without-restart' }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error(JSON.stringify({ ...receipt, failure: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await runtime.close().catch(() => {});
  await lease.release().catch(() => {});
  await new Promise((settle) => upstream.close(settle));
}
