import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AgentCapabilities,
  AgentDriver,
  AgentMemoryContextInjectionPort,
  ExecutionRuntimePort,
  HarnessPlugin,
  HarnessPluginContext,
  HarnessPluginManifest,
  MemoryOperationsPort,
} from '../../contracts/src/index.js';

export const FIXED_HARNESS_KERNEL_PLUGIN_ID = 'humanagent.harness-kernel';

export type CordisHostState = 'loaded' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
export type CordisHostPhase = 'manifest' | 'load' | 'register' | 'start' | 'readiness' | 'dispose';
export type CordisExtensionPlugin = HarnessPlugin;

export interface CordisHostManifest {
  readonly schemaVersion: 1;
  readonly plugins: readonly HarnessPluginManifest[];
}

export interface CordisHostSnapshot {
  readonly state: CordisHostState;
  readonly pluginIds: readonly string[];
  readonly capabilities: Readonly<Record<string, string>>;
  readonly startedPluginIds: readonly string[];
}

export interface CordisReadinessReport {
  readonly pluginId: string;
  readonly driverKind: string;
  readonly ready: true;
  readonly capabilities: readonly string[];
  readonly version: string;
}

export class CordisHostError extends Error {
  readonly code: string;
  readonly ownerId: string;
  readonly nextAction: string;
  readonly phase: CordisHostPhase;
  readonly cause?: unknown;

  constructor(
    code: string,
    message: string,
    input: {
      readonly ownerId: string;
      readonly nextAction: string;
      readonly phase: CordisHostPhase;
      readonly cause?: unknown;
    },
  ) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'CordisHostError';
    this.code = code;
    this.ownerId = input.ownerId;
    this.nextAction = input.nextAction;
    this.phase = input.phase;
    this.cause = input.cause;
  }
}

function fail(
  code: string,
  message: string,
  ownerId: string,
  phase: CordisHostPhase,
  nextAction: string,
  cause?: unknown,
): CordisHostError {
  return new CordisHostError(code, message, { ownerId, phase, nextAction, ...(cause === undefined ? {} : { cause }) });
}

function nonEmpty(value: unknown, label: string, ownerId: string, phase: CordisHostPhase): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail('plugin-manifest-invalid', `${label} is required`, ownerId, phase, 'repair-manifest');
  }
}

function stringArray(value: unknown, label: string, ownerId: string, phase: CordisHostPhase): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw fail('plugin-manifest-invalid', `${label} must be an array`, ownerId, phase, 'repair-manifest');
  const seen = new Set<string>();
  for (const item of value) {
    nonEmpty(item, label, ownerId, phase);
    if (seen.has(item)) throw fail('plugin-manifest-invalid', `duplicate ${label}: ${item}`, ownerId, phase, 'remove-duplicate-manifest-entry');
    seen.add(item);
  }
}

export function assertHarnessPluginManifest(
  value: unknown,
  phase: CordisHostPhase = 'manifest',
): asserts value is HarnessPluginManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail('plugin-manifest-invalid', 'plugin manifest must be an object', 'cordis-host', phase, 'repair-manifest');
  }
  const manifest = value as Partial<HarnessPluginManifest>;
  const ownerId = typeof manifest.pluginId === 'string' && manifest.pluginId ? manifest.pluginId : 'unknown-plugin';
  if (manifest.kind !== 'humanagent.plugin') throw fail('plugin-manifest-invalid', 'invalid plugin manifest kind', ownerId, phase, 'repair-manifest-kind');
  nonEmpty(manifest.pluginId, 'plugin id', ownerId, phase);
  if (manifest.apiVersion !== 1) throw fail('plugin-api-incompatible', `unsupported plugin api version: ${String(manifest.apiVersion)}`, ownerId, phase, 'upgrade-plugin-api');
  nonEmpty(manifest.version, 'plugin version', ownerId, phase);
  nonEmpty(manifest.entry, 'plugin entry', ownerId, phase);
  nonEmpty(manifest.digest, 'plugin digest', ownerId, phase);
  stringArray(manifest.dependencies, 'plugin dependency', ownerId, phase);
  stringArray(manifest.provides, 'provided capability', ownerId, phase);
  stringArray(manifest.consumes, 'consumed capability', ownerId, phase);
  stringArray(manifest.permissions, 'plugin permission', ownerId, phase);
}

function manifestMatches(left: HarnessPluginManifest, right: HarnessPluginManifest): boolean {
  return left.kind === right.kind
    && left.pluginId === right.pluginId
    && left.version === right.version
    && left.apiVersion === right.apiVersion
    && left.entry === right.entry
    && left.digest === right.digest
    && left.dependencies.join('\u0000') === right.dependencies.join('\u0000')
    && left.provides.join('\u0000') === right.provides.join('\u0000')
    && left.consumes.join('\u0000') === right.consumes.join('\u0000')
    && left.permissions.join('\u0000') === right.permissions.join('\u0000');
}

export function assertPluginManifestMatches(
  declared: HarnessPluginManifest,
  actual: unknown,
  source: string,
): asserts actual is HarnessPluginManifest {
  assertHarnessPluginManifest(actual, 'load');
  if (!manifestMatches(declared, actual)) {
    throw fail('plugin-manifest-mismatch', `loaded plugin manifest does not match ${source}`, declared.pluginId, 'load', 'align-manifest-and-plugin-entry');
  }
}

function asHostError(error: unknown, fallback: { readonly code: string; readonly message: string; readonly ownerId: string; readonly nextAction: string; readonly phase: CordisHostPhase }): CordisHostError {
  if (error instanceof CordisHostError) return error;
  return fail(fallback.code, error instanceof Error ? error.message : fallback.message, fallback.ownerId, fallback.phase, fallback.nextAction, error);
}

function orderPlugins(plugins: readonly HarnessPlugin[]): readonly HarnessPlugin[] {
  const byId = new Map<string, HarnessPlugin>();
  for (const plugin of plugins) {
    assertHarnessPluginManifest(plugin.manifest);
    if (byId.has(plugin.manifest.pluginId)) {
      throw fail('plugin-duplicate-owner', `duplicate plugin owner: ${plugin.manifest.pluginId}`, plugin.manifest.pluginId, 'manifest', 'remove-duplicate-plugin');
    }
    byId.set(plugin.manifest.pluginId, plugin);
  }

  const providerByCapability = new Map<string, string>();
  for (const plugin of plugins) {
    for (const capability of plugin.manifest.provides) {
      const prior = providerByCapability.get(capability);
      if (prior) throw fail('plugin-duplicate-capability-owner', `duplicate capability owner: ${capability} (${prior}, ${plugin.manifest.pluginId})`, 'cordis-host', 'manifest', 'retain-one-capability-owner');
      providerByCapability.set(capability, plugin.manifest.pluginId);
    }
  }

  for (const plugin of plugins) {
    const declaredDependencies = new Set(plugin.manifest.dependencies);
    for (const capability of plugin.manifest.consumes) {
      const provider = providerByCapability.get(capability);
      if (!provider) throw fail('plugin-missing-capability-provider', `missing declared capability provider: ${capability}`, plugin.manifest.pluginId, 'manifest', 'declare-capability-provider');
      if (provider !== plugin.manifest.pluginId && !declaredDependencies.has(provider)) {
        throw fail('plugin-capability-dependency-missing', `plugin consumes ${capability} without depending on provider ${provider}`, plugin.manifest.pluginId, 'manifest', 'declare-provider-dependency');
      }
    }
    for (const dependency of plugin.manifest.dependencies) {
      if (!byId.has(dependency)) throw fail('plugin-dependency-missing', `missing plugin dependency: ${dependency}`, plugin.manifest.pluginId, 'manifest', 'install-or-remove-dependency');
    }
  }

  const ordered: HarnessPlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (pluginId: string): void => {
    if (visited.has(pluginId)) return;
    if (visiting.has(pluginId)) throw fail('plugin-dependency-cycle', `cyclic plugin dependency: ${pluginId}`, pluginId, 'manifest', 'break-dependency-cycle');
    const plugin = byId.get(pluginId);
    if (!plugin) throw fail('plugin-dependency-missing', `missing plugin dependency: ${pluginId}`, 'cordis-host', 'manifest', 'install-or-remove-dependency');
    visiting.add(pluginId);
    for (const dependency of [...plugin.manifest.dependencies].sort()) visit(dependency);
    visiting.delete(pluginId);
    visited.add(pluginId);
    ordered.push(plugin);
  };
  const ids = [...byId.keys()].sort((left, right) => {
    if (left === FIXED_HARNESS_KERNEL_PLUGIN_ID) return -1;
    if (right === FIXED_HARNESS_KERNEL_PLUGIN_ID) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const pluginId of ids) visit(pluginId);
  return ordered;
}

export class HarnessPluginRegistry {
  private readonly capabilityOwners = new Map<string, string>();
  private readonly registeredCapabilities = new Set<string>();
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly driverOwners = new Map<string, string>();
  private readonly executionRuntimePorts = new Map<string, ExecutionRuntimePort>();
  private readonly memoryOperations = new Map<string, MemoryOperationsPort>();
  private readonly memoryContextInjections = new Map<string, AgentMemoryContextInjectionPort>();

  constructor(readonly plugins: readonly HarnessPlugin[]) {
    for (const plugin of plugins) {
      for (const capability of plugin.manifest.provides) {
        const prior = this.capabilityOwners.get(capability);
        if (prior) throw fail('plugin-duplicate-capability-owner', `duplicate capability owner: ${capability} (${prior}, ${plugin.manifest.pluginId})`, 'cordis-host', 'manifest', 'retain-one-capability-owner');
        this.capabilityOwners.set(capability, plugin.manifest.pluginId);
      }
    }
  }

  contextFor(plugin: HarnessPlugin): HarnessPluginContext {
    const ownerId = plugin.manifest.pluginId;
    const declared = new Set(plugin.manifest.provides);
    const declaredPermissions = new Set(plugin.manifest.permissions);
    const registerCapability = (capability: string): void => {
      if (!declared.has(capability)) throw fail('plugin-capability-undeclared', `plugin ${ownerId} registered undeclared capability: ${capability}`, ownerId, 'register', 'declare-capability-in-manifest');
      if (this.capabilityOwners.get(capability) !== ownerId) throw fail('plugin-capability-owner-mismatch', `plugin ${ownerId} does not own capability: ${capability}`, ownerId, 'register', 'retain-one-capability-owner');
      this.registeredCapabilities.add(capability);
    };
    return {
      registerCapability,
      registerPermission: (permission) => {
        nonEmpty(permission, 'plugin permission', ownerId, 'register');
        if (!declaredPermissions.has(permission)) throw fail('plugin-permission-undeclared', `plugin ${ownerId} registered undeclared permission: ${permission}`, ownerId, 'register', 'declare-permission-in-manifest');
      },
      registerAgentDriver: (driver) => {
        registerCapability('agent.driver');
        nonEmpty(driver.kind, 'agent driver kind', ownerId, 'register');
        if (this.drivers.has(ownerId) || this.driverOwners.has(driver.kind)) throw fail('plugin-agent-driver-duplicate-owner', `duplicate agent driver owner: ${driver.kind}`, ownerId, 'register', 'retain-one-agent-driver');
        this.drivers.set(ownerId, driver);
        this.driverOwners.set(driver.kind, ownerId);
      },
      registerExecutionRuntimePort: (port) => {
        registerCapability('provider.execution');
        if (this.executionRuntimePorts.has(ownerId)) throw fail('plugin-execution-runtime-port-duplicate-owner', 'duplicate execution runtime port owner', ownerId, 'register', 'retain-one-execution-runtime-port-owner');
        this.executionRuntimePorts.set(ownerId, port);
      },
      registerMemoryOperations: (port) => {
        registerCapability('memory.operations');
        if (this.memoryOperations.has(ownerId)) throw fail('plugin-memory-operations-duplicate-owner', 'duplicate memory operations owner', ownerId, 'register', 'retain-one-memory-operations-owner');
        this.memoryOperations.set(ownerId, port);
      },
      registerAgentMemoryContextInjection: (port) => {
        registerCapability('memory.context');
        if (this.memoryContextInjections.has(ownerId)) throw fail('plugin-memory-context-duplicate-owner', 'duplicate memory context injection owner', ownerId, 'register', 'retain-one-memory-context-owner');
        this.memoryContextInjections.set(ownerId, port);
      },
    };
  }

  assertDeclaredCapabilitiesRegistered(): void {
    for (const plugin of this.plugins) {
      for (const capability of plugin.manifest.provides) {
        if (!this.registeredCapabilities.has(capability)) throw fail('plugin-capability-unregistered', `plugin ${plugin.manifest.pluginId} did not register declared capability: ${capability}`, plugin.manifest.pluginId, 'register', 'register-declared-capability');
      }
    }
  }

  snapshotCapabilities(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.capabilityOwners);
  }

  getAgentDriver(kind?: string): AgentDriver {
    if (kind !== undefined) {
      const owner = this.driverOwners.get(kind);
      const driver = owner === undefined ? undefined : this.drivers.get(owner);
      if (!driver) throw fail('plugin-agent-driver-missing', `agent driver is not registered: ${kind}`, 'cordis-host', 'register', 'load-agent-driver-plugin');
      return driver;
    }
    return this.requireOne(this.drivers, 'agent driver');
  }

  agentDriverEntries(): readonly { readonly pluginId: string; readonly driver: AgentDriver }[] {
    return [...this.drivers.entries()].map(([pluginId, driver]) => ({ pluginId, driver }));
  }

  getExecutionRuntimePort(): ExecutionRuntimePort { return this.requireOne(this.executionRuntimePorts, 'execution runtime port'); }
  getMemoryOperations(): MemoryOperationsPort { return this.requireOne(this.memoryOperations, 'memory operations port'); }
  getAgentMemoryContextInjection(): AgentMemoryContextInjectionPort { return this.requireOne(this.memoryContextInjections, 'agent memory context injection port'); }

  private requireOne<T>(values: ReadonlyMap<string, T>, label: string): T {
    const value = values.values().next().value as T | undefined;
    if (value === undefined) throw fail('plugin-required-port-missing', `${label} is not registered`, 'cordis-host', 'register', 'load-required-plugin');
    return value;
  }
}

export function fixedHarnessKernelPlugin(): HarnessPlugin {
  return {
    manifest: {
      kind: 'humanagent.plugin',
      pluginId: FIXED_HARNESS_KERNEL_PLUGIN_ID,
      version: '1.0.0',
      apiVersion: 1,
      entry: 'builtin:humanagent.harness-kernel',
      dependencies: [],
      provides: ['harness.kernel'],
      consumes: [],
      permissions: [],
      digest: 'builtin:humanagent.harness-kernel:v1',
    },
    register(context) { context.registerCapability('harness.kernel'); },
  };
}

export class CordisHost {
  private state: CordisHostState = 'loaded';
  private readonly plugins: readonly HarnessPlugin[];
  readonly registry: HarnessPluginRegistry;
  private readonly started: string[] = [];
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(extensionPlugins: readonly CordisExtensionPlugin[]) {
    if (extensionPlugins.some((plugin) => plugin.manifest.pluginId === FIXED_HARNESS_KERNEL_PLUGIN_ID)) {
      throw fail('plugin-reserved-owner', `plugin owner is reserved: ${FIXED_HARNESS_KERNEL_PLUGIN_ID}`, FIXED_HARNESS_KERNEL_PLUGIN_ID, 'manifest', 'remove-reserved-plugin-owner');
    }
    this.plugins = orderPlugins([fixedHarnessKernelPlugin(), ...extensionPlugins]);
    this.registry = new HarnessPluginRegistry(this.plugins);
    for (const plugin of this.plugins) {
      try {
        plugin.register(this.registry.contextFor(plugin));
      } catch (error) {
        throw asHostError(error, { code: 'plugin-registration-failed', message: 'plugin registration failed', ownerId: plugin.manifest.pluginId, nextAction: 'repair-plugin-registration', phase: 'register' });
      }
    }
    this.registry.assertDeclaredCapabilitiesRegistered();
  }

  async start(): Promise<CordisHostSnapshot> { return this.runLifecycle(() => this.performStart()); }
  async readiness(): Promise<readonly CordisReadinessReport[]> {
    return this.runLifecycle(async () => {
      try {
        return await this.performReadiness();
      } catch (error) {
        const failure = asHostError(error, { code: 'plugin-readiness-failed', message: 'provider readiness failed', ownerId: 'cordis-host', nextAction: 'restore-provider-readiness', phase: 'readiness' });
        if (this.state === 'ready') {
          this.state = 'failed';
          try { await this.disposeStarted(); } catch (disposeFailure) { throw fail('plugin-readiness-cleanup-failed', `${failure.message}; cleanup failed: ${disposeFailure instanceof Error ? disposeFailure.message : 'dispose failed'}`, 'cordis-host', 'readiness', 'repair-readiness-and-dispose-failures', [failure, disposeFailure]); }
        }
        throw failure;
      }
    });
  }
  async dispose(): Promise<CordisHostSnapshot> { return this.runLifecycle(() => this.performDispose()); }

  snapshot(): CordisHostSnapshot {
    return { state: this.state, pluginIds: this.plugins.map((plugin) => plugin.manifest.pluginId), capabilities: this.registry.snapshotCapabilities(), startedPluginIds: [...this.started] };
  }
  getAgentDriver(kind?: string): AgentDriver { return this.registry.getAgentDriver(kind); }
  getExecutionRuntimePort(): ExecutionRuntimePort { return this.registry.getExecutionRuntimePort(); }
  getMemoryOperations(): MemoryOperationsPort { return this.registry.getMemoryOperations(); }
  getAgentMemoryContextInjection(): AgentMemoryContextInjectionPort { return this.registry.getAgentMemoryContextInjection(); }
  assertLoadedPlugins(pluginIds: readonly string[]): void {
    const loaded = new Set(this.snapshot().pluginIds);
    for (const pluginId of pluginIds) {
      if (!loaded.has(pluginId)) {
        throw fail(
          'plugin-required-not-loaded',
          `required plugin is not loaded: ${pluginId}`,
          pluginId,
          'manifest',
          'compose-the-required-plugin',
        );
      }
    }
  }

  private async performStart(): Promise<CordisHostSnapshot> {
    if (this.state === 'ready') return this.snapshot();
    if (this.state !== 'loaded' && this.state !== 'stopped') throw fail('plugin-host-state-invalid', `host cannot start from ${this.state}`, 'cordis-host', 'start', 'create-new-host-or-dispose');
    this.state = 'starting';
    this.started.length = 0;
    try {
      for (const plugin of this.plugins) {
        this.started.push(plugin.manifest.pluginId);
        if (plugin.start) {
          try { await plugin.start(); } catch (error) { throw asHostError(error, { code: 'plugin-start-failed', message: 'plugin start failed', ownerId: plugin.manifest.pluginId, nextAction: 'repair-plugin-start', phase: 'start' }); }
        }
      }
      await this.performReadiness();
      this.state = 'ready';
      return this.snapshot();
    } catch (error) {
      const failure = asHostError(error, { code: 'plugin-start-failed', message: 'host start failed', ownerId: 'cordis-host', nextAction: 'repair-plugin-start', phase: 'start' });
      this.state = 'failed';
      try { await this.disposeStarted(); } catch (disposeFailure) { throw fail('plugin-start-cleanup-failed', `${failure.message}; cleanup failed: ${disposeFailure instanceof Error ? disposeFailure.message : 'dispose failed'}`, 'cordis-host', 'start', 'repair-start-and-dispose-failures', [failure, disposeFailure]); }
      throw failure;
    }
  }

  private async performReadiness(): Promise<readonly CordisReadinessReport[]> {
    if (this.state !== 'starting' && this.state !== 'ready') throw fail('plugin-host-not-started', `host is not started: ${this.state}`, 'cordis-host', 'readiness', 'start-host-before-readiness');
    const reports: CordisReadinessReport[] = [];
    for (const { pluginId, driver } of this.registry.agentDriverEntries()) {
      let capabilities: AgentCapabilities;
      try { capabilities = await driver.capabilities(); } catch (error) { throw asHostError(error, { code: 'plugin-readiness-failed', message: 'provider readiness failed', ownerId: pluginId, nextAction: 'restore-provider-readiness', phase: 'readiness' }); }
      if (typeof capabilities !== 'object' || capabilities === null
        || capabilities.driverKind !== driver.kind
        || !Array.isArray(capabilities.capabilities)
        || capabilities.capabilities.length === 0
        || typeof capabilities.version !== 'string'
        || capabilities.version.trim() === '') {
        throw fail('plugin-readiness-failed', `agent driver ${driver.kind} reported invalid readiness`, pluginId, 'readiness', 'restore-provider-readiness');
      }
      reports.push({ pluginId, driverKind: driver.kind, ready: true, capabilities: [...capabilities.capabilities], version: capabilities.version });
    }
    return reports;
  }

  private async performDispose(): Promise<CordisHostSnapshot> {
    if (this.state === 'stopped') return this.snapshot();
    this.state = 'stopping';
    try { await this.disposeStarted(); } catch (error) { this.state = 'failed'; throw error; }
    this.state = 'stopped';
    return this.snapshot();
  }

  private async disposeStarted(): Promise<void> {
    const byId = new Map(this.plugins.map((plugin) => [plugin.manifest.pluginId, plugin] as const));
    const failures: CordisHostError[] = [];
    for (const pluginId of [...this.started].reverse()) {
      const plugin = byId.get(pluginId);
      if (!plugin) continue;
      try {
        if (plugin.dispose) await plugin.dispose();
        const index = this.started.lastIndexOf(pluginId);
        if (index >= 0) this.started.splice(index, 1);
      } catch (error) {
        failures.push(asHostError(error, { code: 'plugin-dispose-failed', message: 'plugin dispose failed', ownerId: pluginId, nextAction: 'retry-plugin-dispose', phase: 'dispose' }));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw fail('plugin-dispose-failed', failures.map((failure) => failure.message).join('; '), 'cordis-host', 'dispose', 'retry-plugin-dispose', failures);
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createCordisHost(extensionPlugins: readonly CordisExtensionPlugin[]): CordisHost { return new CordisHost(extensionPlugins); }

function assertHostManifest(value: unknown): asserts value is CordisHostManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail('host-manifest-invalid', 'host manifest must be an object', 'cordis-host', 'manifest', 'repair-host-manifest');
  const manifest = value as Partial<CordisHostManifest>;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.plugins)) throw fail('host-manifest-invalid', 'host manifest schema or plugins are invalid', 'cordis-host', 'manifest', 'repair-host-manifest');
  for (const plugin of manifest.plugins) assertHarnessPluginManifest(plugin);
}

export async function readCordisHostManifest(manifestPath: string): Promise<CordisHostManifest> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown; } catch (error) { throw fail('host-manifest-read-failed', `failed to read host manifest: ${manifestPath}`, 'cordis-host', 'manifest', 'install-host-manifest', error); }
  assertHostManifest(parsed);
  return parsed;
}

async function resolvePluginEntry(manifestPath: string, entry: string, ownerId: string): Promise<string> {
  if (isAbsolute(entry) || !entry.startsWith('.')) throw fail('plugin-entry-specifier-invalid', `plugin entry ${entry} must be an explicit relative path`, ownerId, 'load', 'replace-with-approved-relative-plugin-entry');
  let root: string;
  let candidate: string;
  try {
    root = await realpath(dirname(manifestPath));
    candidate = await realpath(resolve(root, entry));
  } catch (error) {
    throw fail('plugin-entry-read-failed', `failed to resolve plugin entry ${entry}`, ownerId, 'load', 'repair-plugin-entry', error);
  }
  const candidateRelative = relative(root, candidate);
  if (!candidateRelative || candidateRelative === '..' || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) throw fail('plugin-entry-outside-approved-root', `plugin entry ${entry} resolves outside the approved plugin root`, ownerId, 'load', 'use-an-entry-inside-the-plugin-root');
  return candidate;
}

async function loadPlugin(manifestPath: string, declared: HarnessPluginManifest): Promise<HarnessPlugin> {
  const artifact = await resolvePluginEntry(manifestPath, declared.entry, declared.pluginId);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(artifact);
  } catch (error) {
    throw fail('plugin-entry-read-failed', `failed to read plugin entry ${declared.entry}`, declared.pluginId, 'load', 'repair-plugin-entry', error);
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (declared.digest !== digest) throw fail('plugin-digest-mismatch', `plugin entry digest does not match declared digest for ${declared.entry}`, declared.pluginId, 'load', 'restore-approved-plugin-artifact');
  let module: { readonly default?: unknown };
  try { module = await import(artifact) as { readonly default?: unknown }; } catch (error) { throw fail('plugin-entry-load-failed', `failed to load plugin entry ${declared.entry}`, declared.pluginId, 'load', 'repair-plugin-entry', error); }
  const plugin = module.default;
  if (typeof plugin !== 'object' || plugin === null || typeof (plugin as { readonly register?: unknown }).register !== 'function' || !('manifest' in plugin)) throw fail('plugin-entry-invalid', `plugin entry ${declared.entry} must default-export a HarnessPlugin`, declared.pluginId, 'load', 'export-default-harness-plugin');
  assertPluginManifestMatches(declared, (plugin as HarnessPlugin).manifest, declared.entry);
  return plugin as HarnessPlugin;
}

export async function loadCordisHost(manifestPath: string): Promise<CordisHost> {
  const manifest = await readCordisHostManifest(manifestPath);
  const plugins: HarnessPlugin[] = [];
  for (const declared of manifest.plugins) plugins.push(await loadPlugin(manifestPath, declared));
  return new CordisHost(plugins);
}
