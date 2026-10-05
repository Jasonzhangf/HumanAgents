#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const RCC_BASE_URL = (process.env.HUMANAGENT_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const MODEL = process.env.HUMANAGENT_RCC_MODEL ?? 'gpt-5.5';
const OUTPUT_PATH = process.env.HUMANAGENT_RCC_TURN_RECEIPT_PATH;

const providerModule = new URL('../../../dist/tests-provider/packages/adapters/provider/src/index.js', import.meta.url).href;
const contractsModule = new URL('../../../dist/tests-provider/packages/contracts/src/index.js', import.meta.url).href;
const filesystemModule = new URL('../../../dist/tests-provider/packages/adapters/filesystem/src/index.js', import.meta.url).href;
const { ProviderAgentDriver, ProviderAdapter, ResponsesProviderCodec, createV3ProviderHttpTransport, filesystemProviderEvidenceSink } = await import(providerModule);
const { ImmutableAssetStore } = await import(filesystemModule);
const { id } = await import(contractsModule);

function sourceDigest() {
  const entries = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.includes('docs/evidence/interaction-provider-turns/'))
    .sort();
  return `sha256:${createHash('sha256').update(`${entries.join('\n')}\n`).digest('hex')}`;
}

async function health() {
  const response = await fetch(`${RCC_BASE_URL}/health`);
  if (!response.ok) throw new Error(`RCC health failed with HTTP ${response.status}`);
  return response.json();
}

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-rcc-turn-proof-'));
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const artifactRoot = await realpath(join(root, 'artifacts'));
  const runId = randomUUID();
  const runTaskId = id('task', `rcc-turn-proof-${runId}`);
  const runOperationId = id('operation', `operation-rcc-turn-proof-${runId}`);
  const runtimeId = `rcc-turn-proof-${runId}`;
  const scope = {
    organId: id('organ', 'rcc-turn-proof'),
    taskId: runTaskId,
    operationId: runOperationId,
  };
  const evidenceRef = {
    evidenceId: id('evidence', `rcc-turn-proof-${runId}`),
    kind: 'operation',
    source: 'rcc-turn-proof',
    locator: `operation/${runOperationId.value}`,
    scope,
  };
  const binding = {
    bindingId: `rcc-turn-proof-${runId}`,
    providerId: 'rcc',
    protocol: 'responses',
    endpointRef: RCC_BASE_URL,
    modelRef: MODEL,
    configDigest: `sha256:rcc-turn-proof-config-${runId}`,
    capabilityDigest: `sha256:rcc-turn-proof-capability-${runId}`,
  };
  const port = new ProviderAdapter({
    binding,
    routeRef: `rcc/turn-proof-${runId}`,
    codec: new ResponsesProviderCodec(),
    transport: createV3ProviderHttpTransport({
      binding,
      baseUrl: RCC_BASE_URL,
      evidence: filesystemProviderEvidenceSink(new ImmutableAssetStore(artifactRoot)),
    }),
    evidence: filesystemProviderEvidenceSink(new ImmutableAssetStore(artifactRoot)),
  });
  const lifecycle = [];
  const observed = [];
  const driver = new ProviderAgentDriver({
    port,
    binding,
    runtimeId,
    taskId: runTaskId,
    operationId: runOperationId,
    executionEpoch: 1,
    assignmentId: `assignment-${runId}`,
    scope,
    inputRefs: [evidenceRef.evidenceId.value],
    ownerId: 'humanagent.rcc-turn-proof',
    onRequestLifecycle(event) {
      lifecycle.push(event);
    },
  });

  await driver.start({ runtimeId, taskId: runTaskId, executionEpoch: 1 });
  await driver.submit({
    taskId: runTaskId,
    executionEpoch: 1,
    assignmentId: `assignment-${runId}`,
    payload: { prompt: 'Reply with the single word OK.' },
  });
  for await (const event of driver.observe({ runtimeId })) observed.push(event);
  const closure = await driver.settle({ runtimeId, executionEpoch: 1 });
  await driver.close();

  const turnIds = [...new Set([...lifecycle.map((event) => event.turnId), ...observed.map((event) => event.providerEvent.turnId)])];
  assert.equal(turnIds.length, 1, 'real request lifecycle must expose one stable turnId');
  assert.equal(lifecycle.length, observed.length > 0 ? lifecycle.length : 0);
  assert.deepEqual(lifecycle.at(-1)?.phase, 'settled');
  assert.equal(closure.state, 'succeeded');
  assert.ok(observed.some((event) => event.kind === 'provider.output' || event.kind === 'provider.terminal'));

  const receipt = {
    schemaVersion: 1,
    kind: 'humanagent.rcc-turn-proof',
    generatedAt: new Date().toISOString(),
    candidate: {
      head: process.env.HUMANAGENT_RCC_TURN_HEAD ?? 'not-set',
      sourceDigest: process.env.HUMANAGENT_RCC_TURN_SOURCE_DIGEST ?? sourceDigest(),
      statusShort: process.env.HUMANAGENT_RCC_TURN_STATUS_SHORT ?? 'not-set',
    },
    rcc: {
      baseUrl: RCC_BASE_URL,
      health: await health(),
    },
    request: {
      endpoint: `${RCC_BASE_URL}/v1/responses`,
      protocol: 'responses',
      model: MODEL,
      prompt: 'Reply with the single word OK.',
    },
    readPath: 'ProviderAgentDriver.observe().providerEvent.turnId and onRequestLifecycle().turnId',
    turnId: turnIds[0],
    lifecycle: lifecycle.map((event) => ({
      phase: event.phase,
      turnId: event.turnId,
      requestId: event.requestId,
      parentRequestId: event.parentRequestId,
      externalResponseId: event.externalResponseId,
      occurredAt: event.occurredAt,
    })),
    observed: observed.map((event) => ({
      kind: event.kind,
      terminalState: event.terminalState,
      summary: event.summary,
      turnId: event.providerEvent.turnId,
      requestId: event.providerEvent.requestId,
      parentRequestId: event.providerEvent.parentRequestId,
      occurredAt: event.providerEvent.occurredAt,
    })),
    settlement: closure.state,
    artifactRoot,
  };

  if (OUTPUT_PATH) {
    await writeFile(resolve(OUTPUT_PATH), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  await rm(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
  console.log(JSON.stringify({ ok: true, turnId: receipt.turnId, lifecycle: receipt.lifecycle, observedCount: observed.length, receiptPath: OUTPUT_PATH ?? null }));
}

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
