#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateUserConfig, compileAgentProviderBindings, resolveRuntimePaths } from '../../../dist/app/config/src/index.js';
import { selectAgentProvider, providerBindingFromConfig, createAgentProviderPort } from '../../../dist/app/app/src/agent-driver-composition.js';
import { admitAgentProvider } from '../../../dist/app/app/src/agent-provider-admission.js';
import { ProviderAgentDriver, filesystemProviderEvidenceSink } from '../../../dist/app/adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../../dist/app/adapters/filesystem/src/index.js';
import { id } from '../../../dist/app/contracts/src/index.js';

const BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_RCC_MODEL ?? 'gpt-5.5';
const PROTOCOL = process.env.HUMANAGENT_RCC_PROTOCOL ?? 'responses';
assert.ok(['responses', 'openai', 'anthropic'].includes(PROTOCOL), 'unsupported RCC proof protocol');
const ENDPOINT = { responses: '/v1/responses', openai: '/v1/chat/completions', anthropic: '/v1/messages' }[PROTOCOL];

// Known failure: old proof bypassed default composition and deleted evidence.
// Failure probability is unknown; cost is one short generation per invocation.
// Accepted fake/replay counterexamples are reused without another fault matrix.
function candidateIdentity() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const hash = createHash('sha256');
  for (const file of git('ls-files', '-z').split('\0').filter(Boolean).sort()) {
    hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  }
  return {
    head: git('rev-parse', 'HEAD').trim(),
    sourceDigest: `sha256:${hash.digest('hex')}`,
    statusShort: git('status', '--short'),
    proofDigest: `sha256:${createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')}`,
  };
}
function errorRecord(error) {
  if (!error || typeof error !== 'object') return String(error);
  return { ...error, name: error.name, message: error.message,
    ...(error.cause === undefined ? {} : { cause: errorRecord(error.cause) }) };
}
function bounded(work, milliseconds, label) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function run() {
  const paths = await resolveRuntimePaths({ workspace: process.cwd(), controlRoot: join(homedir(), '.humanagent') });
  const ownedRoot = join(paths.controlRoot, 'test-fixtures', 'provider-protocol-live-r1-20261013');
  await mkdir(ownedRoot, { recursive: true });
  const root = await mkdtemp(join(ownedRoot, `${PROTOCOL}-`));
  const artifactRoot = join(await realpath(root), 'assets');
  await mkdir(artifactRoot);
  const receiptPath = join(root, 'receipt.json');
  const runId = randomUUID();
  const taskId = id('task', `provider-consumer-${runId}`);
  const operationId = id('operation', `provider-consumer-${runId}`);
  const runtimeId = `provider-consumer-${runId}`;
  const scope = { organId: id('organ', 'provider-proof'), taskId, operationId };
  const user = validateUserConfig({
    schemaVersion: 1,
    agents: [{
      agentId: 'provider-proof', roleId: 'interaction', templateRef: 'builtin/interaction@1.0.0', driverRef: 'rcc',
      skills: ['input-normalization', 'task-matching', 'confirmation'],
      tools: ['input.receive', 'task.query', 'proposal.render'], permissions: ['task.read', 'task.propose'],
      memoryScopes: ['task', 'organ', 'approved-global'], resourceClass: 'foreground',
    }],
    provider: { provider: 'rcc', source: 'rcc', binding: `proof-${PROTOCOL}-${runId}`, protocol: PROTOCOL, model: MODEL, route: 'default', baseUrl: BASE_URL },
  });
  const composition = selectAgentProvider({
    roleId: 'interaction', agentId: 'provider-proof', agentProviderBindings: compileAgentProviderBindings(user),
    createPort: (selected) => createAgentProviderPort(selected, artifactRoot),
  });
  assert.deepEqual(composition.binding, providerBindingFromConfig(user.provider));
  const receipt = {
    schemaVersion: 2, kind: 'humanagent.provider-dependency-proof', generatedAt: new Date().toISOString(),
    candidate: candidateIdentity(), protocol: PROTOCOL, source: composition.source,
    provider: composition.provider, binding: composition.binding,
    composition: 'validateUserConfig → compileAgentProviderBindings → selectAgentProvider → createAgentProviderPort → admitAgentProvider → ProviderAgentDriver',
    request: { endpoint: `${BASE_URL}${ENDPOINT}`, protocol: PROTOCOL, model: MODEL, prompt: 'Reply with the single word OK.' },
    generationAttempts: 0, artifactRoot, receiptPath, lifecycle: [], observed: [], assets: [],
    rawOutboundBody: 'UNVERIFIED: public transport evidence does not expose actual outbound body',
    upstreamAttribution: 'UNVERIFIED: no correlated public RCC upstream request record',
    scopeClaim: 'Provider dependency consumer only; no Task/standard turn/native/UI/G5 claim',
  };
  const sink = filesystemProviderEvidenceSink(new ImmutableAssetStore(artifactRoot));
  const driver = new ProviderAgentDriver({
    port: composition.port, binding: composition.binding, runtimeId, taskId, operationId, executionEpoch: 1,
    assignmentId: `assignment-${runId}`, scope, inputRefs: [], ownerId: 'humanagent.provider-proof',
    onRequestLifecycle: (event) => receipt.lifecycle.push(event),
  });
  let active = false;
  let pendingStart = false;
  let expired = false;
  const save = () => writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await save();
  try {
    await bounded((async () => {
      receipt.admission = { state: 'admitting' };
      const readiness = await admitAgentProvider(composition);
      if (expired) throw new Error('admission completed after proof deadline; generation forbidden');
      receipt.admission = { state: 'admitted', readiness };
      assert.equal(readiness.bindingId, composition.binding.bindingId);
      assert.equal(readiness.protocol, composition.binding.protocol);
      assert.equal(readiness.capabilityDigest, composition.binding.capabilityDigest);
      await driver.start({ runtimeId, taskId, executionEpoch: 1 });
      if (expired) throw new Error('driver start completed after proof deadline; generation forbidden');
      receipt.generationAttempts = 1;
      pendingStart = true;
      receipt.submit = await driver.submit({ taskId, executionEpoch: 1, assignmentId: `assignment-${runId}`, payload: { prompt: receipt.request.prompt } });
      pendingStart = false;
      active = true;
      for await (const event of driver.observe({ runtimeId })) receipt.observed.push(event);
      receipt.closure = await driver.settle({ runtimeId, executionEpoch: 1 });
      receipt.settlement = driver.settlement();
    })(), 90_000, 'admission/generation');
  } catch (error) {
    expired = true;
    receipt.error = errorRecord(error);
    if (receipt.admission?.state === 'admitting') receipt.admission = { state: 'rejected-or-pending', error: errorRecord(error) };
  } finally {
    try {
      await bounded((async () => {
        try {
          if (active && !receipt.settlement) {
            receipt.stop = await driver.requestStop({ runtimeId, executionEpoch: 1, operationId });
            receipt.closure = await driver.settle({ runtimeId, executionEpoch: 1 });
            receipt.settlement = driver.settlement();
          }
        } finally {
          receipt.close = await driver.close();
        }
      })(), 10_000, 'cleanup');
    } catch (error) { receipt.cleanupError = errorRecord(error); }
    receipt.pendingStart = pendingStart;
    receipt.cleanup = receipt.close?.state === 'closed' && !pendingStart && !receipt.cleanupError ? 'closed' : 'INCOMPLETE';
  }
  try {
    const refs = new Map();
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      if (value.evidenceId && value.locator && value.digest) refs.set(value.locator, value);
      for (const item of Object.values(value)) collect(item);
    }
    collect(receipt);
    for (const ref of refs.values()) {
      assert.ok(ref.locator.startsWith(`${artifactRoot}/`));
      assert.equal(ref.source, 'humanagent.provider-adapter');
      const bytes = await sink.read(ref);
      const text = new TextDecoder().decode(bytes);
      let content;
      try { content = JSON.parse(text); } catch { content = text; }
      receipt.assets.push({ ref, size: bytes.length, content });
    }
    const starts = receipt.assets.filter(({ content }) => content?.endpoint === ENDPOINT && content?.status !== undefined);
    if (receipt.generationAttempts) {
      assert.equal(starts.length, 1, 'one real transport start asset');
      assert.equal(starts[0].content.protocol, PROTOCOL);
      assert.equal(starts[0].content.model, MODEL);
      assert.equal(starts[0].content.route, 'rcc:default');
      assert.ok(starts[0].content.status >= 200 && starts[0].content.status < 300);
      const identities = [...receipt.lifecycle, ...receipt.observed.map((event) => event.providerEvent)];
      assert.equal(new Set(identities.map((event) => event.turnId)).size, 1);
      assert.equal(new Set(identities.map((event) => event.requestId)).size, 1);
      assert.ok(identities.every((event) => event.parentRequestId === undefined));
      for (const event of receipt.lifecycle) {
        assert.equal(event.runtimeId, runtimeId);
        assert.deepEqual(event.taskId, taskId);
        assert.deepEqual(event.operationId, operationId);
        assert.equal(event.executionEpoch, 1);
      }
      assert.ok(receipt.observed.some((event) => event.kind === 'provider.output' && typeof event.summary === 'string' && event.summary.trim().length > 0), 'actual decoded text');
      assert.ok(receipt.observed.some((event) => event.kind === 'provider.terminal' && event.terminalState === 'succeeded'), 'protocol terminal');
      assert.equal(receipt.closure?.state, 'succeeded');
      assert.equal(receipt.settlement?.resourceRelease.state, 'released');
      assert.equal(receipt.lifecycle.at(-1)?.phase, 'settled');
    }
    assert.equal(receipt.close?.state, 'closed');
    assert.ok(receipt.close.evidenceRefs.some((ref) => receipt.assets.some((asset) => asset.ref.locator === ref.locator)), 'readable close evidence');
    receipt.result = receipt.error ? 'FAIL' : receipt.generationAttempts === 1 ? 'PASS' : 'BLOCKED';
  } catch (error) {
    receipt.assertionError = errorRecord(error);
    receipt.result = 'FAIL';
  }
  receipt.publicResponseIdentity = receipt.assets.flatMap(({ ref, content }) => {
    const record = content?.response ?? content?.message ?? content;
    return record && typeof record === 'object' && (typeof record.model === 'string' || typeof record.id === 'string')
      ? [{ locator: ref.locator, eventType: content.type, id: record.id, model: record.model }] : [];
  }).filter((record) => record.eventType || record.id);
  receipt.actualResponseModel = receipt.publicResponseIdentity.some((record) => record.model)
    ? receipt.publicResponseIdentity.filter((record) => record.model)
    : 'UNVERIFIED: default public codec evidence does not retain a returned model';
  await save();
  console.log(JSON.stringify({ result: receipt.result, protocol: PROTOCOL, generationAttempts: receipt.generationAttempts, receiptPath, closure: receipt.closure?.state, resourceRelease: receipt.settlement?.resourceRelease.state, close: receipt.close?.state, cleanup: receipt.cleanup, error: receipt.error?.message, assertionError: receipt.assertionError?.message }));
  // Pending HTTP start has no stoppable public driver identity: keep it unknown.
  // Exit only this owned proof process after bounded actual cleanup.
  process.exit(receipt.result === 'PASS' ? 0 : 1);
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
