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

/**
 * Records the real composition boundary of the CLI entry. MVP-scoped stages
 * are marked composed only when serve starts their owner; deferred runtime
 * capabilities remain explicit, typed scope evidence.
 */
export function entryCompositionInventory(): EntryCompositionInventory {
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
      state: 'composed',
      ownerId: 'humanagent.app.cordis-host',
      message: 'serve starts and disposes the CordisHost through supervisor stages',
    },
    {
      component: 'fixed-harness-kernel',
      state: 'composed',
      ownerId: 'humanagent.harness-kernel',
      message: 'CordisHost unconditionally registers the typed fixed Harness Kernel manifest',
    },
    {
      component: 'agent-io-eventbus',
      state: 'unavailable',
      ownerId: 'humanagent.runtime.agent-io',
      code: 'entry.component.not-composed',
      message: 'MVP serve exposes the provider-neutral UI runtime and memory EventBus; raw AgentIo request settlement and task EventBus capability are outside this entry contract',
      nextAction: 'open the AgentIo/task EventBus contract before adding it to serve',
    },
    {
      component: 'm3-orchestration',
      state: 'unavailable',
      ownerId: 'humanagent.app.m3-assembly',
      code: 'entry.component.not-composed',
      message: 'M3 assignment/review/merge orchestration is an offline assembly contract, outside the MVP serve entry',
      nextAction: 'define a real serve task-to-M3 ownership boundary before composing it',
    },
    {
      component: 'harness-node-runtime',
      state: 'unavailable',
      ownerId: 'humanagent.runtime.nodes',
      code: 'entry.component.not-composed',
      message: 'HarnessNodeRuntime is not part of the MVP UI provider execution contract',
      nextAction: 'define a real node admission boundary before composing it',
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
