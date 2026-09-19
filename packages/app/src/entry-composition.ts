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
 * Records the real composition boundary of the CLI entry. Missing runtime
 * stages remain typed evidence; this inventory never upgrades an unavailable
 * stage to a fake success.
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
      state: 'unavailable',
      ownerId: 'humanagent.app.cordis-host',
      code: 'entry.component.not-composed',
      message: 'serve does not start a CordisHost lifecycle',
      nextAction: 'compose CordisHost startup and dispose around the live entry',
    },
    {
      component: 'fixed-harness-kernel',
      state: 'unavailable',
      ownerId: 'humanagent.harness-kernel',
      code: 'entry.component.not-composed',
      message: 'the fixed Harness Kernel plugin is not registered in the live serve host',
      nextAction: 'register the fixed Harness Kernel through CordisHost',
    },
    {
      component: 'agent-io-eventbus',
      state: 'unavailable',
      ownerId: 'humanagent.runtime.agent-io',
      code: 'entry.component.not-composed',
      message: 'AgentIo and EventBus are not part of the live UI provider composition',
      nextAction: 'compose AgentIo and EventBus request settlement into serve',
    },
    {
      component: 'm3-orchestration',
      state: 'unavailable',
      ownerId: 'humanagent.app.m3-assembly',
      code: 'entry.component.not-composed',
      message: 'M3 orchestration is implemented but not connected to the live serve entry',
      nextAction: 'compose M3 assignment, review, merge, and feedback ports',
    },
    {
      component: 'harness-node-runtime',
      state: 'unavailable',
      ownerId: 'humanagent.runtime.nodes',
      code: 'entry.component.not-composed',
      message: 'HarnessNodeRuntime is not connected to the live serve entry',
      nextAction: 'compose node admission, dispatch, observe, and settle around task execution',
    },
    {
      component: 'supervisor-lease-startup-dispose',
      state: 'unavailable',
      ownerId: 'humanagent.app.supervisor',
      code: 'entry.component.not-composed',
      message: 'serve does not acquire a supervisor lease or run staged startup/dispose',
      nextAction: 'compose supervisor lease and lifecycle around the live entry',
    },
    {
      component: 'rejected-interaction-closure',
      state: 'unavailable',
      ownerId: 'humanagent.runtime.explicit-intake',
      code: 'entry.component.not-composed',
      message: 'rejected interactions expose a next action but have no live durable closure endpoint',
      nextAction: 'connect rejected-interaction closure to the live entry journal',
    },
  ];
  return {
    ownerId: 'humanagent.app.entry-composition',
    complete: components.every((component) => component.state === 'composed'),
    components,
  };
}
