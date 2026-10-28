import assert from 'node:assert/strict';
import test from 'node:test';
import { AppLifecycleError } from '../../packages/app/src/errors.js';

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureControlLayout,
  loadConfiguration,
  resolveRuntimePaths,
} from '../../packages/config/src/index.js';
import { resolveCliAgentProviderBindings } from '../../packages/app/src/cli.js';

import type { AgentConfig, AgentRole, EffectiveAgentProviderBinding, ProviderConfig } from '../../packages/config/src/index.js';
import type { ExecutionRuntimePort, ProviderBinding } from '../../packages/contracts/src/index.js';
import {
  createAgentProviderPort,
  providerBindingFromConfig,
  selectAgentProvider,
} from '../../packages/app/src/agent-driver-composition.js';

function effective(
  agentId: string,
  roleId: AgentRole,
  provider?: ProviderConfig,
): EffectiveAgentProviderBinding {
  return {
    agentId,
    roleId,
    source: provider === undefined ? 'unconfigured' : 'agent',
    ...(provider === undefined ? {} : { provider }),
  };
}

function config(binding: string, model: string, source: ProviderConfig['source'] = 'rcc'): ProviderConfig {
  return {
    provider: 'rcc',
    ...(source === undefined ? {} : { source }),
    binding,
    protocol: 'responses',
    model,
    route: `route-${binding}`,
    baseUrl: `http://127.0.0.1:${binding.length * 1000 + 1}`,
  };
}

function fail(code: string): (error: unknown) => boolean {
  return (error) => (error instanceof AppLifecycleError) && error.code === code;
}

class RecordingPort implements ExecutionRuntimePort {
  readonly kind = 'humanagent.execution-runtime-port' as const;
  constructor(readonly binding: ProviderBinding, readonly expected: ProviderBinding) {}

  async probe(): Promise<never> {
    throw new Error('unit selection consumer does not probe');
  }

  async capabilities(): Promise<never> {
    throw new Error('unit selection consumer does not probe');
  }

  async start(): Promise<never> {
    throw new Error('unit selection consumer does not start');
  }

  async resume(): Promise<never> {
    throw new Error('unit selection consumer does not resume');
  }

  async submit(): Promise<never> {
    throw new Error('unit selection consumer does not submit');
  }

  observe(): AsyncIterable<never> {
    throw new Error('unit selection consumer does not observe');
  }

  async requestStop(): Promise<never> {
    throw new Error('unit selection consumer does not stop');
  }

  async settle(): Promise<never> {
    throw new Error('unit selection consumer does not settle');
  }

  async close(): Promise<never> {
    throw new Error('unit selection consumer does not close');
  }
}

test('canonical mapper derives source-aware binding with real SHA-256 digests', () => {
  const provider = config('worker-a', 'model-a', 'http');
  const binding = providerBindingFromConfig(provider);
  assert.equal(binding.bindingId, provider.binding);
  assert.equal(binding.providerId, provider.provider);
  assert.equal(binding.protocol, provider.protocol);
  assert.equal(binding.modelRef, provider.model);
  assert.match(binding.endpointRef, /^http:/);
  assert.match(binding.configDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(binding.capabilityDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(binding.configDigest !== binding.capabilityDigest);
});

test('selector builds a fresh port for an exact agentId with role consistency', () => {
  const configured = config('worker-a', 'model-a');
  const roster = [effective('worker-a', 'execution', configured), effective('worker-b', 'execution', config('worker-b', 'model-b'))];
  let calls = 0;
  let received: { readonly provider: ProviderConfig; readonly binding: ProviderBinding } | undefined;
  const composition = selectAgentProvider({
    roleId: 'execution',
    agentId: 'worker-a',
    agentProviderBindings: roster,
    createPort: (input) => {
      calls += 1;
      received = input;
      return new RecordingPort(input.binding, input.binding);
    },
  });
  assert.equal(calls, 1);
  assert.equal(composition.configuredAgentId, 'worker-a');
  assert.equal(composition.roleId, 'execution');
  assert.equal(composition.provider, configured);
  assert.equal(composition.source, 'rcc');
  assert.equal(composition.binding.bindingId, 'worker-a');
  assert.equal(received?.binding, composition.binding);
  assert.equal(received?.provider, configured);
});

test('selector rejects unknown agentId before creating a port', () => {
  assert.throws(
    () => selectAgentProvider({
      roleId: 'execution',
      agentId: 'missing',
      agentProviderBindings: [effective('worker-a', 'execution', config('worker-a', 'model-a'))],
      createPort: () => {
        throw new Error('createPort must not run');
      },
    }),
    fail('agent-provider-binding.unknown'),
  );
});

test('selector rejects role mismatch before creating a port', () => {
  assert.throws(
    () => selectAgentProvider({
      roleId: 'execution',
      agentId: 'review-a',
      agentProviderBindings: [effective('review-a', 'review', config('review-a', 'model-a'))],
      createPort: () => {
        throw new Error('createPort must not run');
      },
    }),
    fail('agent-provider-binding.role-mismatch'),
  );
});

test('role-only selection must count unconfigured members and reject ambiguous roles', () => {
  const roster = [
    effective('worker-a', 'execution', config('worker-a', 'model-a')),
    effective('worker-unconfigured', 'execution'),
  ];
  assert.throws(
    () => selectAgentProvider({
      roleId: 'execution',
      agentProviderBindings: roster,
      createPort: () => {
        throw new Error('createPort must not run');
      },
    }),
    fail('agent-provider-binding.ambiguous'),
  );
});

test('role-only selection rejects a single unconfigured member', () => {
  assert.throws(
    () => selectAgentProvider({
      roleId: 'execution',
      agentProviderBindings: [effective('worker-unconfigured', 'execution')],
      createPort: () => {
        throw new Error('createPort must not run');
      },
    }),
    fail('agent-provider-binding.unconfigured'),
  );
});

test('role-only selection with a single unconfigured member falls back to the legacy provider and keeps the instance identity', () => {
  const legacy = config('legacy-entry', 'legacy-model');
  const roster = [effective('worker-unconfigured', 'execution')];
  let receivedBinding: ProviderBinding | undefined;
  let receivedProvider: ProviderConfig | undefined;
  const overrides = {
    endpointRef: 'rcc-v3:serve-bound',
    configDigest: 'sha256:serve-bound-config',
    capabilityDigest: 'sha256:serve-bound-capability',
  } as const;
  const composition = selectAgentProvider({
    roleId: 'execution',
    agentProviderBindings: roster,
    legacyProvider: legacy,
    legacyBindingOverrides: overrides,
    createPort: (input) => {
      receivedBinding = input.binding;
      receivedProvider = input.provider;
      return new RecordingPort(input.binding, input.binding);
    },
  });
  assert.equal(composition.configuredAgentId, 'worker-unconfigured');
  assert.equal(composition.roleId, 'execution');
  assert.equal(composition.provider, legacy);
  assert.equal(composition.source, 'rcc');
  assert.equal(composition.binding.bindingId, 'legacy-entry');
  assert.equal(composition.binding.endpointRef, overrides.endpointRef);
  assert.equal(composition.binding.configDigest, overrides.configDigest);
  assert.equal(composition.binding.capabilityDigest, overrides.capabilityDigest);
  assert.equal(receivedBinding, composition.binding);
  assert.equal(receivedProvider, legacy);
});

test('exact agentId with an unconfigured member falls back to the legacy provider and keeps the instance identity', () => {
  const legacy = config('legacy-entry', 'legacy-model');
  const roster = [effective('worker-unconfigured', 'execution')];
  const composition = selectAgentProvider({
    roleId: 'execution',
    agentId: 'worker-unconfigured',
    agentProviderBindings: roster,
    legacyProvider: legacy,
    createPort: (input) => new RecordingPort(input.binding, input.binding),
  });
  assert.equal(composition.configuredAgentId, 'worker-unconfigured');
  assert.equal(composition.roleId, 'execution');
  assert.equal(composition.provider, legacy);
  assert.equal(composition.source, 'rcc');
  assert.equal(composition.binding.bindingId, 'legacy-entry');
});

test('exact agentId with an unconfigured member and no legacy provider still rejects', () => {
  assert.throws(
    () => selectAgentProvider({
      roleId: 'execution',
      agentId: 'worker-unconfigured',
      agentProviderBindings: [effective('worker-unconfigured', 'execution')],
      createPort: () => {
        throw new Error('createPort must not run');
      },
    }),
    fail('agent-provider-binding.unconfigured'),
  );
});

test('role without roster members uses legacy provider with a fresh port', () => {
  const legacy = config('legacy-entry', 'legacy-model');
  let receivedBinding: ProviderBinding | undefined;
  const composition = selectAgentProvider({
    roleId: 'review',
    agentProviderBindings: [],
    legacyProvider: legacy,
    createPort: (input) => {
      receivedBinding = input.binding;
      return new RecordingPort(input.binding, input.binding);
    },
  });
  assert.equal(composition.configuredAgentId, undefined);
  assert.equal(composition.roleId, 'review');
  assert.equal(composition.source, 'rcc');
  assert.equal(composition.binding.bindingId, 'legacy-entry');
  assert.equal(receivedBinding, composition.binding);
});

test('role without roster members and without legacy provider rejects before creating a port', () => {
  assert.throws(
    () => selectAgentProvider({
      roleId: 'execution',
      agentProviderBindings: [],
      createPort: () => {
        throw new Error('createPort must not run');
      },
    }),
    fail('agent-provider-binding.unconfigured-role'),
  );
});

test('default port producer constructs a port from complete provider and binding', () => {
  const provider = config('worker-a', 'model-a', 'http');
  const binding = providerBindingFromConfig(provider);
  const port = createAgentProviderPort({ provider, binding }, '/Users/fanzhang/.humanagent/test-fixtures/provider-g-selected-s1-r1-20261013');
  assert.ok(port);
});

test('CLI provider override is applied to inherited agent provider bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serve-inherited-override-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  try {
    const paths = await resolveRuntimePaths({ controlRoot, workspace });
    await ensureControlLayout(paths);
    const configuration = await loadConfiguration(paths);
    // defaultUserToml sets [provider] model = "MiniMax-M3"; interaction-default
    // and orchestration-default inherit it (source: 'inherited').
    assert.equal(configuration.effective.provider?.model, 'MiniMax-M3');

    const overrideProvider: ProviderConfig = {
      ...configuration.effective.provider!,
      model: 'gpt-5.5',
      binding: 'ui-dash-e2e',
      baseUrl: 'http://127.0.0.1:4444',
    };

    // Without the resolver the inherited binding keeps MiniMax-M3 even though
    // the CLI-supplied legacy provider requested gpt-5.5.
    const rawInteraction = selectAgentProvider({
      roleId: 'interaction',
      agentProviderBindings: configuration.agentProviderBindings,
      legacyProvider: overrideProvider,
      createPort: (input) => new RecordingPort(input.binding, input.binding),
    });
    assert.equal(rawInteraction.provider.model, 'MiniMax-M3');

    // With the resolver the CLI override wins for inherited bindings.
    const resolvedBindings = resolveCliAgentProviderBindings(configuration, overrideProvider);
    const interaction = selectAgentProvider({
      roleId: 'interaction',
      agentProviderBindings: resolvedBindings,
      legacyProvider: overrideProvider,
      createPort: (input) => new RecordingPort(input.binding, input.binding),
    });
    assert.equal(interaction.provider.model, 'gpt-5.5');
    assert.equal(interaction.provider.binding, 'ui-dash-e2e');

    const orchestration = selectAgentProvider({
      roleId: 'orchestration',
      agentProviderBindings: resolvedBindings,
      legacyProvider: overrideProvider,
      createPort: (input) => new RecordingPort(input.binding, input.binding),
    });
    assert.equal(orchestration.provider.model, 'gpt-5.5');
    assert.equal(orchestration.provider.binding, 'ui-dash-e2e');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI provider override preserves an agent with an explicit source: agent binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'serve-agent-explicit-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  try {
    const paths = await resolveRuntimePaths({ controlRoot, workspace });
    await ensureControlLayout(paths);
    const configuration = await loadConfiguration(paths);

    const overrideProvider: ProviderConfig = {
      ...configuration.effective.provider!,
      model: 'gpt-5.5',
      binding: 'ui-dash-e2e',
      baseUrl: 'http://127.0.0.1:4444',
    };
    const explicitProvider: ProviderConfig = {
      provider: 'rcc',
      binding: 'explicit-binding',
      protocol: 'responses',
      model: 'claude-opus',
      route: 'explicit-route',
      baseUrl: 'http://10.0.0.1:9000',
    };
    const explicitAgent: AgentConfig = {
      agentId: 'explicit-agent',
      roleId: 'execution',
      templateRef: 'builtin/execution@1.0.0',
      driverRef: 'fake',
      skills: [],
      tools: [],
      permissions: [],
      memoryScopes: [],
      resourceClass: 'background',
      provider: explicitProvider,
    };
    // The explicit agent carries its own provider block, so recompiling with
    // the CLI override must keep it as source: 'agent' rather than inheriting.
    const resolvedBindings = resolveCliAgentProviderBindings(
      {
        effective: {
          ...configuration.effective,
          agents: [...configuration.effective.agents, explicitAgent],
        },
        agentProviderBindings: configuration.agentProviderBindings,
      },
      overrideProvider,
    );
    const explicitBinding = resolvedBindings.find((binding) => binding.agentId === 'explicit-agent');
    assert.equal(explicitBinding?.source, 'agent');
    assert.deepEqual(explicitBinding?.provider, explicitProvider);

    const selected = selectAgentProvider({
      roleId: 'execution',
      agentId: 'explicit-agent',
      agentProviderBindings: resolvedBindings,
      legacyProvider: overrideProvider,
      createPort: (input) => new RecordingPort(input.binding, input.binding),
    });
    assert.equal(selected.provider.model, 'claude-opus');
    assert.equal(selected.provider.binding, 'explicit-binding');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
