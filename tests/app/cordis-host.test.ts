import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentCapabilities, AgentDriver, HarnessPlugin } from '../../packages/contracts/src/index.js';
import {
  CordisHost,
  CordisHostError,
  loadCordisHost,
  type CordisExtensionPlugin,
} from '../../packages/app/src/index.js';

function plugin(input: {
  readonly id: string;
  readonly provides?: readonly string[];
  readonly consumes?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly register?: HarnessPlugin['register'];
  readonly start?: HarnessPlugin['start'];
  readonly dispose?: HarnessPlugin['dispose'];
}): CordisExtensionPlugin {
  return {
    manifest: {
      kind: 'humanagent.plugin',
      pluginId: input.id,
      version: '1.0.0',
      apiVersion: 1,
      entry: `test:${input.id}`,
      dependencies: input.dependencies ?? ['humanagent.harness-kernel'],
      provides: input.provides ?? [],
      consumes: input.consumes ?? ['harness.kernel'],
      permissions: [],
      digest: `test:${input.id}`,
    },
    register: input.register ?? ((context) => {
      for (const capability of input.provides ?? []) context.registerCapability(capability);
    }),
    ...(input.start === undefined ? {} : { start: input.start }),
    ...(input.dispose === undefined ? {} : { dispose: input.dispose }),
  };
}

function driver(capabilities: AgentCapabilities): AgentDriver {
  return {
    kind: capabilities.driverKind,
    capabilities: async () => capabilities,
    start: async () => ({ runtimeId: 'runtime', executionEpoch: 1 }),
    resume: async () => ({ runtimeId: 'runtime', executionEpoch: 1 }),
    submit: async () => { throw new Error('unused'); },
    async *observe() { /* unused */ },
    requestStop: async () => ({ requested: true, operationId: { scope: 'operation', value: 'stop' } }),
    settle: async () => ({ state: 'succeeded', evidenceRefs: [] }),
  } as unknown as AgentDriver;
}

test('Cordis host orders manifests deterministically and rejects duplicate owners and undeclared capabilities', () => {
  const ordered = new CordisHost([
    plugin({ id: 'plugin-b', provides: ['cap.b'] }),
    plugin({ id: 'plugin-a', provides: ['cap.a'] }),
  ]);
  assert.deepEqual(ordered.snapshot().pluginIds, ['humanagent.harness-kernel', 'plugin-a', 'plugin-b']);

  assert.throws(
    () => new CordisHost([plugin({ id: 'same' }), plugin({ id: 'same' })]),
    (error: unknown) => error instanceof CordisHostError && error.code === 'plugin-duplicate-owner',
  );
  assert.throws(
    () => new CordisHost([plugin({ id: 'undeclared', register: (context) => context.registerCapability('not-declared') })]),
    (error: unknown) => error instanceof CordisHostError && error.code === 'plugin-capability-undeclared',
  );
  assert.throws(
    () => new CordisHost([plugin({ id: 'humanagent.harness-kernel' })]),
    (error: unknown) => error instanceof CordisHostError
      && error.code === 'plugin-reserved-owner'
      && error.ownerId === 'humanagent.harness-kernel',
  );
});

test('Cordis host registers before start and disposes started plugins in reverse order after start failure', async () => {
  const events: string[] = [];
  const host = new CordisHost([
    plugin({ id: 'plugin-a', start: async () => { events.push('start:a'); }, dispose: async () => { events.push('dispose:a'); } }),
    plugin({ id: 'plugin-b', start: async () => { events.push('start:b'); throw new Error('start failed'); }, dispose: async () => { events.push('dispose:b'); } }),
  ]);
  await assert.rejects(() => host.start(), (error: unknown) => error instanceof CordisHostError && error.code === 'plugin-start-failed');
  assert.deepEqual(events, ['start:a', 'start:b', 'dispose:b', 'dispose:a']);
  assert.equal(host.snapshot().state, 'failed');
  assert.deepEqual(host.snapshot().startedPluginIds, []);
});

test('Cordis host exposes provider readiness failure explicitly', async () => {
  const failingProvider = plugin({
    id: 'provider',
    provides: ['agent.driver'],
    register: (context) => {
      context.registerAgentDriver(driver({ driverKind: 'test-provider', capabilities: [], version: '1' }));
    },
  });
  const host = new CordisHost([failingProvider]);
  await assert.rejects(
    () => host.start(),
    (error: unknown) => error instanceof CordisHostError
      && error.code === 'plugin-readiness-failed'
      && error.phase === 'readiness'
      && error.ownerId === 'provider',
  );
});

test('Cordis loader rejects an invalid artifact API digest before import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-cordis-host-'));
  try {
    const source = 'export default { manifest: {}, register() {} };\n';
    await writeFile(join(root, 'plugin.mjs'), source, 'utf8');
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        kind: 'humanagent.plugin',
        pluginId: 'invalid-digest',
        version: '1.0.0',
        apiVersion: 1,
        entry: './plugin.mjs',
        dependencies: [],
        provides: [],
        consumes: [],
        permissions: [],
        digest: `sha256:${'0'.repeat(64)}`,
      }],
    }), 'utf8');
    await assert.rejects(
      () => loadCordisHost(join(root, 'manifest.json')),
      (error: unknown) => error instanceof CordisHostError && error.code === 'plugin-digest-mismatch',
    );
    assert.equal(createHash('sha256').update(source).digest('hex').length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
