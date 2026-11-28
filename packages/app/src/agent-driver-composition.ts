import type {
  AgentConfig,
  AgentRole,
  AcpExecutionConfig,
  EffectiveAgentProviderBinding,
  ProviderConfig,
  ProviderSource,
  RuntimePaths,
} from '../../config/src/index.js';
import { FakeAgentDriver } from '../../adapters/testing/src/index.js';
import { ProviderAgentDriver } from '../../adapters/provider/src/index.js';
import { assembleProviderExecutionPort, type ProviderAssemblyInput } from './provider-assembly.js';
import {
  createAcpClientDriver,
  createAntigravityRuntime,
  createDshRuntime,
  createOpencodeRuntime,
  DSH_DEFAULT_ARGS,
  OPENCODE_DEFAULT_ARGS,
  type AcpRuntimeAdaptor,
} from '../../adapters/acp/index.js';
import {
  id,
  type AnyProviderExecutionIdentityRef,
  type AgentDriver,
  type ExecutionBinding,
  type ExecutionRuntimePort,
  type OperationId,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderExecutionIdentityRef,
  type ScopeRef,
  type TaskId,
} from '../../contracts/src/index.js';
import { AppLifecycleError } from './errors.js';
import { admitAgentProvider } from './agent-provider-admission.js';
import { createHash } from 'node:crypto';
import type {
  PreparedExecutionStop,
  PreparedExecutionStopPreparationLease,
} from './ui-runtime/prepared-execution-stop.js';

const AGENT_PROVIDER_OWNER = 'humanagent.app.agent-provider-binding';

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export interface AgentProviderPortFactoryInput {
  readonly provider: ProviderConfig;
  readonly binding: ProviderBinding;
}

export type AgentProviderPortFactory<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> = (input: AgentProviderPortFactoryInput) => ExecutionRuntimePort<TIdentity>;

export interface AgentProviderComposition<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly configuredAgentId?: string;
  readonly roleId: AgentRole;
  readonly provider: ProviderConfig;
  readonly source: ProviderSource;
  readonly binding: ProviderBinding;
  readonly port: ExecutionRuntimePort<TIdentity>;
}

export interface AgentProviderSelectionInput<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly roleId: AgentRole;
  readonly agentId?: string;
  readonly agentProviderBindings: readonly EffectiveAgentProviderBinding[];
  readonly legacyProvider?: ProviderConfig;
  readonly legacyBindingOverrides?: Partial<Pick<ProviderBinding, 'endpointRef' | 'configDigest' | 'capabilityDigest'>>;
  readonly createPort: AgentProviderPortFactory<TIdentity>;
}

/**
 * Builds the canonical ProviderBinding for one compiled effective provider
 * config. The config is already validated and compiled by Config; the App
 * layer never re-parses TOML or environment here.
 *
 * Endpoint provenance stays source-aware: an HTTP binding is never labelled
 * with the RCC-only `rcc-v3:` scheme. The capability digest is an honest
 * identity label for this exact config, never a borrowed default binding value
 * or a bare unhashed string.
 */
export function providerBindingFromConfig(provider: ProviderConfig): ProviderBinding {
  const source = provider.source ?? 'rcc';
  const endpointHost = provider.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    bindingId: provider.binding,
    providerId: provider.provider,
    protocol: provider.protocol,
    endpointRef: source === 'http' ? `http:${endpointHost}` : `rcc-v3:${endpointHost}`,
    modelRef: provider.model,
    configDigest: digest(JSON.stringify({
      source,
      binding: provider.binding,
      provider: provider.provider,
      protocol: provider.protocol,
      model: provider.model,
      route: provider.route,
      baseUrl: provider.baseUrl,
    })),
    capabilityDigest: digest(JSON.stringify({
      binding: provider.binding,
      provider: provider.provider,
      protocol: provider.protocol,
      model: provider.model,
      route: provider.route,
      baseUrl: provider.baseUrl,
      source,
    })),
  };
}

interface ResolvedAgentProviderSelection {
  readonly configuredAgentId?: string;
  readonly roleId: AgentRole;
  readonly provider: ProviderConfig;
  /** True only when the resolved provider is the serve-level legacy provider. */
  readonly fromLegacyFallback?: true;
}

function resolveSelectedInstance<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(input: AgentProviderSelectionInput<TIdentity>): ResolvedAgentProviderSelection {
  if (input.agentId !== undefined) {
    const match = input.agentProviderBindings.find((candidate) => candidate.agentId === input.agentId);
    if (match === undefined) {
      throw new AppLifecycleError(
        'agent-provider-binding.unknown',
        `no configured agent matches the selected id ${input.agentId}`,
        'select a configured agentId from the compiled roster',
        AGENT_PROVIDER_OWNER,
      );
    }
    if (match.roleId !== input.roleId) {
      throw new AppLifecycleError(
        'agent-provider-binding.role-mismatch',
        `selected agent ${input.agentId} has role ${match.roleId}, not ${input.roleId}`,
        'select an agent whose role matches the requested instance role',
        AGENT_PROVIDER_OWNER,
      );
    }
    if (match.provider === undefined) {
      if (input.legacyProvider === undefined) {
        throw new AppLifecycleError(
          'agent-provider-binding.unconfigured',
          `selected agent ${input.agentId} has no effective provider`,
          'configure a provider block for the selected agent or its shared top-level provider',
          AGENT_PROVIDER_OWNER,
        );
      }
      return {
        configuredAgentId: match.agentId,
        roleId: match.roleId,
        provider: input.legacyProvider,
        fromLegacyFallback: true,
      };
    }
    return { configuredAgentId: match.agentId, roleId: match.roleId, provider: match.provider };
  }
  const matches = input.agentProviderBindings.filter((candidate) => candidate.roleId === input.roleId);
  if (matches.length === 0) {
    if (input.legacyProvider === undefined) {
      throw new AppLifecycleError(
        'agent-provider-binding.unconfigured-role',
        `no roster instance is configured for role ${input.roleId} and no legacy provider is available`,
        'configure an agent for the role or provide the legacy top-level provider',
        AGENT_PROVIDER_OWNER,
      );
    }
    return {
      roleId: input.roleId,
      provider: input.legacyProvider,
      fromLegacyFallback: true,
    };
  }
  if (matches.length > 1) {
    throw new AppLifecycleError(
      'agent-provider-binding.ambiguous',
      `role ${input.roleId} matches ${matches.length} roster instances`,
      'select the intended instance by its stable agentId',
      AGENT_PROVIDER_OWNER,
    );
  }
  const selected = matches[0]!;
  if (selected.provider === undefined) {
    if (input.legacyProvider === undefined) {
      throw new AppLifecycleError(
        'agent-provider-binding.unconfigured',
        `agent ${selected.agentId} for role ${input.roleId} has no effective provider`,
        'configure a provider block for the selected agent or its shared top-level provider',
        AGENT_PROVIDER_OWNER,
      );
    }
    return {
      configuredAgentId: selected.agentId,
      roleId: selected.roleId,
      provider: input.legacyProvider,
      fromLegacyFallback: true,
    };
  }
  return { configuredAgentId: selected.agentId, roleId: selected.roleId, provider: selected.provider };
}

/**
 * Selects one effective provider composition for a configured agent instance.
 * Exact agentId is the only explicit instance selector; a role-only selection
 * must be unique across the full roster, including unconfigured members.
 *
 * A resolved instance without its own effective provider falls back to the
 * serve-level legacy provider. The legacy fallback keeps the resolved instance
 * identity, so the roster's configured agent still owns the execution, and the
 * legacy binding overrides align the port with the serve-selected provider.
 * Every rejection happens before any provider port is constructed.
 */
export function selectAgentProvider<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(input: AgentProviderSelectionInput<TIdentity>): AgentProviderComposition<TIdentity> {
  const selected = resolveSelectedInstance(input);
  const provider = selected.provider;
  const binding = {
    ...providerBindingFromConfig(provider),
    ...(selected.fromLegacyFallback === true ? input.legacyBindingOverrides : {}),
  };
  return {
    configuredAgentId: selected.configuredAgentId,
    roleId: selected.roleId,
    provider,
    source: provider.source ?? 'rcc',
    binding,
    port: input.createPort({ provider, binding }),
  };
}

/**
 * Actual default provider port producer. Every selected execution instance
 * gets a freshly assembled port from its own effective provider config. The
 * source, route and base URL always come from the passed provider, never from
 * a closure or shared default.
 */
export function createAgentProviderPort<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(
  input: AgentProviderPortFactoryInput,
  evidenceRoot: string,
  maxTokens?: ProviderAssemblyInput['maxTokens'],
): ExecutionRuntimePort<TIdentity> {
  return assembleProviderExecutionPort<TIdentity>({
    binding: input.binding,
    routeRef: input.provider.route,
    baseUrl: input.provider.baseUrl,
    source: input.provider.source ?? 'rcc',
    credentialRef: input.provider.credentialRef,
    maxTokens,
  }, evidenceRoot);
}

/**
 * Close an owned composition and require an actual closed receipt.
 *
 * The default signature keeps returning `void` for the existing
 * `close`/`release` consumers. Passing `{ returnReceipt: true }` returns the
 * one real receipt object from the same single `port.close` call; it is a
 * return-value overload, never a second close path.
 */
export async function closeAgentProvider<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(composition: AgentProviderComposition<TIdentity>): Promise<void>;
export async function closeAgentProvider<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(
  composition: AgentProviderComposition<TIdentity>,
  options: { readonly returnReceipt: true },
): Promise<ProviderCloseResult>;
export async function closeAgentProvider<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(
  composition: AgentProviderComposition<TIdentity>,
  options?: { readonly returnReceipt?: boolean },
): Promise<void | ProviderCloseResult> {
  const receipt = await composition.port.close(composition.binding);
  if (receipt.state !== 'closed') {
    throw new AppLifecycleError(
      'agent-provider-close-incomplete',
      `provider ${composition.binding.bindingId} close returned ${receipt.state}`,
      'complete the selected provider close before releasing its ownership',
      AGENT_PROVIDER_OWNER,
      receipt.error,
    );
  }
  return options?.returnReceipt === true ? receipt : undefined;
}

/** Prepare one fresh execution instance and admit only its own provider. */
export async function prepareAgentProvider<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(input: {
  readonly roleId: AgentRole;
  readonly configuredAgentId?: string;
  readonly agentProviderBindings: readonly EffectiveAgentProviderBinding[];
  readonly legacyProvider?: ProviderConfig;
  readonly legacyBindingOverrides?: AgentProviderSelectionInput['legacyBindingOverrides'];
  readonly maxTokens?: ProviderAssemblyInput['maxTokens'];
  readonly evidenceRoot: string;
}): Promise<AgentProviderComposition<TIdentity>> {
  const composition = selectAgentProvider<TIdentity>({
    roleId: input.roleId,
    ...(input.configuredAgentId === undefined ? {} : { agentId: input.configuredAgentId }),
    agentProviderBindings: input.agentProviderBindings,
    ...(input.legacyProvider === undefined ? {} : { legacyProvider: input.legacyProvider }),
    ...(input.legacyBindingOverrides === undefined ? {} : { legacyBindingOverrides: input.legacyBindingOverrides }),
    createPort: (selected) => createAgentProviderPort<TIdentity>(selected, input.evidenceRoot, input.maxTokens),
  });
  try {
    await admitAgentProvider<TIdentity>(composition);
  } catch (error) {
    try {
      await closeAgentProvider<TIdentity>(composition);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'selected provider admission and cleanup failed');
    }
    throw error;
  }
  return composition;
}

/**
 * Prepares one fresh execution instance under an active prepared-stop
 * preparation. It selects the real composition, transfers the actual Provider
 * custody to the producer before the fallible acquisition append, and admits
 * the Provider only after that custody exists. It owns no cleanup path of its
 * own: every acquisition or admission failure propagates to the single
 * `withPreparation` cleanup owner, so a failed append can never be followed by
 * admission or a second close.
 */
export async function prepareExecutionAgentProvider<
  TIdentity extends ProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(
  input: AgentProviderSelectionInput<TIdentity>,
  owner: PreparedExecutionStop,
  lease: PreparedExecutionStopPreparationLease,
): Promise<AgentProviderComposition<TIdentity>> {
  const composition = selectAgentProvider<TIdentity>(input);
  await owner.takeProvider(lease, composition);
  await admitAgentProvider<TIdentity>(composition);
  return composition;
}

export interface ComposedAgentDriver {
  readonly driver: AgentDriver;
  readonly execution?: ExecutionBinding;
}

export interface DshCompositionInput {
  readonly agent: AgentConfig;
  readonly paths: RuntimePaths;
  readonly opencode?: AcpExecutionConfig;
  readonly antigravity?: AcpExecutionConfig;
  readonly dshAcp?: AcpExecutionConfig;
  /**
   * Serve-owned RCC port binding. It is required for an `rcc` agent so the
   * provider stream of a memory role cannot borrow the main operation's
   * execution identity or silently fall back to another driver.
   */
  readonly rcc?: RccCompositionInput;
  readonly runtimeId: string;
  readonly workspace: string;
}

export interface RccCompositionInput {
  readonly port: ExecutionRuntimePort;
  readonly binding: ProviderBinding;
  readonly scope: ScopeRef;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly inputRefs: readonly string[];
}

const ACP_OWNER = 'humanagent.app.acp-composition';

/**
 * Builds the one shared ACP client driver for a configured ACP runtime. The
 * runtime adaptor owns how to reach the engine (a real ACP server or a
 * shim over a native CLI); the client driver owns the session lifecycle and
 * the AgentDriver mapping so the runtimes cannot diverge.
 *
 * Evidence scope comes from HumanAgent, not from the runtime: the ACP session
 * id stays inside the adaptor and never becomes an AgentRuntimeId.
 */
function composeAcpDriver(input: {
  readonly runtime: AcpRuntimeAdaptor;
  readonly workspace: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}): ComposedAgentDriver {
  return {
    driver: createAcpClientDriver({
      runtime: input.runtime,
      workspace: input.workspace,
      command: input.command,
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }),
  };
}

/**
 * Explicitly composes the configured driver. There is no fallback: an unknown
 * driverRef, a DSH agent without DSH execution config, an ACP agent without
 * its ACP execution config, or an RCC agent without a serve-owned RCC port
 * fails closed.
 */
export function composeAgentDriver(input: DshCompositionInput): ComposedAgentDriver {
  if (input.agent.driverRef === 'fake') {
    return { driver: new FakeAgentDriver() };
  }
  if (input.agent.driverRef === 'opencode') {
    const config = input.opencode;
    if (!config) {
      throw new AppLifecycleError(
        'acp-config-missing',
        'agent uses the opencode driver but execution.opencode is not configured',
        'configure execution.opencode in the user config before running the agent',
        ACP_OWNER,
      );
    }
    const args = config.args ?? OPENCODE_DEFAULT_ARGS;
    return composeAcpDriver({
      runtime: createOpencodeRuntime({ args, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) }),
      workspace: input.workspace,
      command: config.command,
      args,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    });
  }
  if (input.agent.driverRef === 'antigravity') {
    const config = input.antigravity;
    if (!config) {
      throw new AppLifecycleError(
        'acp-config-missing',
        'agent uses the antigravity driver but execution.antigravity is not configured',
        'configure execution.antigravity in the user config before running the agent',
        ACP_OWNER,
      );
    }
    return composeAcpDriver({
      runtime: createAntigravityRuntime({
        ...(config.args === undefined ? {} : { args: config.args }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      }),
      workspace: input.workspace,
      command: config.command,
      ...(config.args === undefined ? {} : { args: config.args }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    });
  }
  if (input.agent.driverRef === 'acp-dsh') {
    const config = input.dshAcp;
    if (!config) {
      throw new AppLifecycleError(
        'acp-config-missing',
        'agent uses the acp-dsh driver but execution.dshAcp is not configured',
        'configure execution.dshAcp in the user config before running the agent',
        ACP_OWNER,
      );
    }
    const args = config.args ?? DSH_DEFAULT_ARGS;
    return composeAcpDriver({
      runtime: createDshRuntime({ args, ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) }),
      workspace: input.workspace,
      command: config.command,
      args,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    });
  }
  if (input.agent.driverRef === 'rcc') {
    const config = input.rcc;
    if (!config) {
      throw new AppLifecycleError(
        'rcc-config-missing',
        'agent uses the rcc driver but no serve RCC port is bound to this composition',
        'compose the agent from the serve RCC port and provider binding before running it',
        'app-agent-driver-composition',
      );
    }
    return {
      driver: new ProviderAgentDriver({
        port: config.port,
        binding: config.binding,
        runtimeId: input.runtimeId,
        taskId: config.taskId,
        operationId: config.operationId,
        executionEpoch: config.executionEpoch,
        assignmentId: config.assignmentId,
        scope: config.scope,
        inputRefs: config.inputRefs,
        ownerId: 'humanagent.app.agent-driver-composition',
      }),
    };
  }
  throw new AppLifecycleError(
    'agent-driver-unsupported',
    `agent driver is not enabled: ${input.agent.driverRef}`,
    'choose an explicitly supported driverRef',
    'app-agent-driver-composition',
  );
}
