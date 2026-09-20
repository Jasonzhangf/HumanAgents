import type { CordisHostSnapshot } from './cordis-host.js';

export type EntryComponentState = 'composed' | 'unavailable';

export interface EntryComponentEvidence {
  readonly component: string;
  readonly state: EntryComponentState;
  readonly ownerId: string;
  readonly code?: string;
  readonly message: string;
  readonly nextAction?: string;
}
export interface EntryCompositionInventory {
  readonly ownerId: 'humanagent.app.entry-composition';
  readonly complete: boolean;
  readonly components: readonly EntryComponentEvidence[];
}

export const FAKE_SERVE_PROVIDER_PLUGIN = {
  pluginId: 'humanagent.fake-provider',
  capabilities: ['provider.execution'],
} as const;

export const RCC_SERVE_PROVIDER_PLUGIN = {
  pluginId: 'humanagent.rcc-provider',
  capabilities: ['provider.execution'],
} as const;

export const SERVE_COMPOSITION_PLUGINS = {
  fake: [
    { pluginId: 'humanagent.harness-kernel', capabilities: ['harness.kernel'] },
    FAKE_SERVE_PROVIDER_PLUGIN,
    { pluginId: 'humanagent.agent-templates', capabilities: ['agent.templates'] },
    { pluginId: 'humanagent.memory', capabilities: ['memory.operations', 'memory.context'] },
    { pluginId: 'humanagent.ui', capabilities: ['ui.projection'] },
  ],
  rcc: [
    { pluginId: 'humanagent.harness-kernel', capabilities: ['harness.kernel'] },
    RCC_SERVE_PROVIDER_PLUGIN,
    { pluginId: 'humanagent.agent-templates', capabilities: ['agent.templates'] },
    { pluginId: 'humanagent.memory', capabilities: ['memory.operations', 'memory.context'] },
    { pluginId: 'humanagent.ui', capabilities: ['ui.projection'] },
  ],
} as const;

export function serveCompositionManifestMatches(
  plugins: readonly Pick<import('./cordis-host.js').CordisExtensionPlugin, 'manifest'>[],
  mode: keyof typeof SERVE_COMPOSITION_PLUGINS,
): boolean {
  const expected = SERVE_COMPOSITION_PLUGINS[mode];
  const actual = new Map(plugins.map((plugin) => [plugin.manifest.pluginId, plugin.manifest.provides]));
  return plugins.length === expected.length - 1
    && expected.every((plugin) =>
      plugin.pluginId === 'humanagent.harness-kernel'
        ? !actual.has(plugin.pluginId)
        : actual.get(plugin.pluginId)?.length === plugin.capabilities.length
          && plugin.capabilities.every((capability) => actual.get(plugin.pluginId)?.includes(capability)));
}

/**
 * Projects the live serve composition boundary. Components not owned by the
 * serve entry are outside this inventory.
 */
export function entryCompositionInventory(
  host: Pick<CordisHostSnapshot, 'state' | 'pluginIds' | 'capabilities' | 'startedPluginIds'>,
  mode: keyof typeof SERVE_COMPOSITION_PLUGINS,
): EntryCompositionInventory {
  const pluginIds = new Set(host.pluginIds);
  const startedPluginIds = new Set(host.startedPluginIds);
  const hostState = host.state === 'ready' ? 'composed' : 'unavailable';
  const pluginState = (pluginId: string, capabilities: readonly string[]): EntryComponentState =>
    host.state === 'ready'
      && pluginIds.has(pluginId)
      && startedPluginIds.has(pluginId)
      && capabilities.every((capability) => host.capabilities[capability] === pluginId)
      ? 'composed'
      : 'unavailable';
  const provider = mode === 'fake' ? FAKE_SERVE_PROVIDER_PLUGIN : RCC_SERVE_PROVIDER_PLUGIN;
  const components: EntryComponentEvidence[] = [
    {
      component: 'configuration',
      state: 'composed',
      ownerId: 'humanagent.config',
      message: 'configuration and control roots are loaded by the app entry',
    },
    {
      component: 'memory',
      state: 'composed',
      ownerId: 'humanagent.app.memory-composition',
      message: 'memory coordinator, backend, and checkpoint boundary are composed by serve',
    },
    {
      component: 'provider-execution',
      state: 'composed',
      ownerId: 'humanagent.provider-adapter',
      message: 'the selected provider execution port is composed by the explicit mode',
    },
    {
      component: 'ui-runtime',
      state: 'composed',
      ownerId: 'humanagent.runtime.ui',
      message: 'task coordinator, journal, checkpoint store, and loopback server are composed by serve',
    },
    {
      component: 'cordis-host',
      state: hostState,
      ownerId: 'humanagent.app.cordis-host',
      ...(host.state !== 'ready' ? {
        code: 'entry.component.not-composed',
        message: 'CordisHost has not reached the ready lifecycle state',
        nextAction: 'compose, start, and ready the CordisHost',
      } : {
        message: 'CordisHost is composed and exposes the live plugin inventory',
      }),
    },
    {
      component: 'fixed-harness-kernel',
      state: pluginState('humanagent.harness-kernel', ['harness.kernel']),
      ownerId: 'humanagent.harness-kernel',
      ...(pluginState('humanagent.harness-kernel', ['harness.kernel']) === 'composed' ? {
        message: 'CordisHost unconditionally loaded the fixed Harness Kernel manifest',
      } : {
        code: 'entry.component.not-composed',
        message: 'the fixed Harness Kernel plugin is absent from the live CordisHost',
        nextAction: 'repair CordisHost fixed-kernel composition',
      }),
    },
    {
      component: mode === 'fake' ? 'fake-plugin' : 'rcc-plugin',
      state: pluginState(provider.pluginId, provider.capabilities),
      ownerId: provider.pluginId,
      ...(pluginState(provider.pluginId, provider.capabilities) === 'composed' ? {
        message: `the explicit ${mode} execution port is loaded as a Cordis plugin`,
      } : {
        code: 'entry.component.not-composed',
        message: `the ${mode} execution plugin is missing its provider execution capability owner`,
        nextAction: `repair ${mode} provider plugin composition`,
      }),
    },
    {
      component: 'template-plugin',
      state: pluginState('humanagent.agent-templates', ['agent.templates']),
      ownerId: 'humanagent.agent-templates',
      ...(pluginState('humanagent.agent-templates', ['agent.templates']) === 'composed' ? {
        message: 'the agent template registry is loaded as a Cordis plugin',
      } : {
        code: 'entry.component.not-composed',
        message: 'the agent template plugin is absent from the live CordisHost',
        nextAction: 'compose the agent template plugin',
      }),
    },
    {
      component: 'memory-plugin',
      state: pluginState('humanagent.memory', ['memory.operations', 'memory.context']),
      ownerId: 'humanagent.memory',
      ...(pluginState('humanagent.memory', ['memory.operations', 'memory.context']) === 'composed' ? {
        message: 'memory operations and context injection are loaded as a Cordis plugin',
      } : {
        code: 'entry.component.not-composed',
        message: 'the memory plugin is absent from the live CordisHost',
        nextAction: 'compose the memory plugin',
      }),
    },
    {
      component: 'ui-plugin',
      state: pluginState('humanagent.ui', ['ui.projection']),
      ownerId: 'humanagent.ui',
      ...(pluginState('humanagent.ui', ['ui.projection']) === 'composed' ? {
        message: 'the UI runtime projection is loaded as a Cordis plugin',
      } : {
        code: 'entry.component.not-composed',
        message: 'the UI plugin is absent from the live CordisHost',
        nextAction: 'compose the UI plugin',
      }),
    },
    {
      component: 'supervisor-lease-startup-dispose',
      state: 'composed',
      ownerId: 'humanagent.app.supervisor',
      message: 'serve acquires a daemon lease and runs staged startup/dispose with reverse cleanup',
    },
    {
      component: 'rejected-interaction-closure',
      state: 'composed',
      ownerId: 'humanagent.runtime.explicit-intake',
      message: 'serve exposes typed rejection and commits InteractionClosure to the UI runtime journal',
    },
  ];
  return {
    ownerId: 'humanagent.app.entry-composition',
    complete: components.every((component) => component.state === 'composed'),
    components,
  };
}

export function serveCompositionComplete(
  host: Pick<CordisHostSnapshot, 'state' | 'pluginIds' | 'capabilities' | 'startedPluginIds'>,
  mode: keyof typeof SERVE_COMPOSITION_PLUGINS,
): boolean {
  const pluginIds = new Set(host.pluginIds);
  const startedPluginIds = new Set(host.startedPluginIds);
  return host.state === 'ready'
    && SERVE_COMPOSITION_PLUGINS[mode].every((plugin) =>
      pluginIds.has(plugin.pluginId)
      && startedPluginIds.has(plugin.pluginId)
      && plugin.capabilities.every((capability) => host.capabilities[capability] === plugin.pluginId));
}
