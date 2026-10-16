import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  createDshAgentDriver,
  createDshExecutionRuntimePort,
  createRealDshTransport,
  dshBaselineLock,
  type DshProfileDescriptor,
} from '../../adapters/dsh/src/index.js';
import type {
  AgentConfig,
  AgentRole,
  AcpExecutionConfig,
  DshExecutionConfig,
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
  type ProviderExecutionIdentityRef,
  type ScopeRef,
  type TaskId,
} from '../../contracts/src/index.js';
import { AppLifecycleError } from './errors.js';
import { admitAgentProvider } from './agent-provider-admission.js';
import type {
  PreparedExecutionStop,
  PreparedExecutionStopPreparationLease,
} from './ui-runtime/prepared-execution-stop.js';

const DSH_OWNER = 'humanagent.app.dsh-composition';
const AGENT_PROVIDER_OWNER = 'humanagent.app.agent-provider-binding';
const DSH_SETTINGS_FILE = 'settings.yaml';
const DSH_RCC_BASE_URL = 'http://127.0.0.1:4444/v1';
const DSH_REQUIRED_PATCHES = [
  {
    ref: 'apps/cli/src/sdk-source.cordis.patch.yml',
    digest: 'sha256:f62a5f47337fe3d241d650db43bd93c867fbec9d32d7a5cc9c89c1be6bbcddee',
  },
] as const;

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(prefix);
}

/**
 * The DSH home is persistent runtime state, so it must live below the single
 * HumanAgent control root. A project workspace or arbitrary user path would
 * create a second persistence source and is rejected here.
 */
export function resolveDshHome(input: { readonly paths: RuntimePaths; readonly configuredHome: string }): string {
  const expanded = input.configuredHome === '~/.humanagent'
    ? input.paths.controlRoot
    : input.configuredHome.startsWith('~/.humanagent/')
      ? join(input.paths.controlRoot, input.configuredHome.slice('~/.humanagent/'.length))
      : input.configuredHome === '~'
        ? homedir()
        : input.configuredHome.startsWith('~/')
          ? join(homedir(), input.configuredHome.slice(2))
      : isAbsolute(input.configuredHome)
        ? resolve(input.configuredHome)
        : resolve(input.paths.controlRoot, input.configuredHome);
  const controlRootReal = realpathSync(input.paths.controlRoot);
  let existing = expanded;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const candidateReal = join(realpathSync(existing), ...missing);
  if (!isWithin(controlRootReal, candidateReal)) {
    throw new AppLifecycleError(
      'dsh-home-outside-control-root',
      'DSH home must remain below the HumanAgent control root',
      'configure execution.dsh.home as ~/.humanagent/dsh/home',
      DSH_OWNER,
    );
  }
  return candidateReal;
}

function dshProfile(
  config: DshExecutionConfig,
  lock: typeof dshBaselineLock,
  sourceRoot: string,
  patchRefs: readonly string[],
  patchDigests: readonly string[],
): DshProfileDescriptor {
  return {
    profileName: config.profile,
    homeRef: 'env:DSH_HOME',
    plugin: {
      bundleRef: `humanagent-dsh-bundle:${config.profile}`,
      digest: digest(`${lock.commit}:${lock.tree}:${sourceRoot}:${config.profile}:${config.provider}:${patchDigests.join('|')}`),
      entry: 'apps/cli/src/bin.ts',
    },
    routeRef: `explicit/dsh/${config.provider}`,
    patchRefs: [...patchRefs],
  };
}

export function assertDshSourceMatchesLock(sourceRoot: string, lock: typeof dshBaselineLock = dshBaselineLock): void {
  try {
    const head = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    const describe = execFileSync('git', ['-C', sourceRoot, 'describe', '--tags', '--always'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
    if (head !== lock.commit || tree !== lock.tree || describe !== lock.describe || dirty !== '') {
      throw new Error(`DSH source does not match lock: HEAD=${head} tree=${tree} describe=${describe}`);
    }
  } catch (error) {
    throw new AppLifecycleError(
      'dsh-source-lock-mismatch',
      `DSH source is not the locked commit/tree: ${error instanceof Error ? error.message : String(error)}`,
      'point execution.dsh.sourceRoot at the clean locked DSH worktree and reinstall its dependencies',
      DSH_OWNER,
    );
  }
}

interface DshPatchVerification {
  readonly refs: readonly string[];
  readonly files: readonly string[];
  readonly digests: readonly string[];
}

export function verifyDshPatches(
  sourceRoot: string,
  patchRefs: readonly string[],
  approved: readonly { readonly ref: string; readonly digest: string }[] = DSH_REQUIRED_PATCHES,
): DshPatchVerification {
  const expected = new Map(approved.map((patch) => [patch.ref, patch.digest]));
  const provided = new Set(patchRefs);
  const missing = [...expected.keys()].filter((ref) => !provided.has(ref));
  if (provided.size !== patchRefs.length || patchRefs.length !== expected.size || missing.length > 0) {
    throw new AppLifecycleError(
      'dsh-patch-set-mismatch',
      `DSH patch set must contain exactly ${expected.size} approved patch(es), received ${patchRefs.length}`,
      'configure the locked DSH source entry patch',
      DSH_OWNER,
    );
  }
  const sourceRootReal = realpathSync(sourceRoot);
  const files: string[] = [];
  const digests: string[] = [];
  for (const patchRef of patchRefs) {
    const expectedDigest = expected.get(patchRef);
    if (!expectedDigest) {
      throw new AppLifecycleError(
        'dsh-patch-not-approved',
        `DSH patch is not approved for the locked source: ${patchRef}`,
        'remove unapproved patches and use the locked source patch',
        DSH_OWNER,
      );
    }
    const candidate = resolve(sourceRoot, patchRef);
    if (!existsSync(candidate)) {
      throw new AppLifecycleError(
        'dsh-patch-missing',
        `DSH patch does not exist: ${patchRef}`,
        'restore the locked DSH source patch',
        DSH_OWNER,
      );
    }
    const file = realpathSync(candidate);
    if (!isWithin(sourceRootReal, file)) {
      throw new AppLifecycleError(
        'dsh-patch-outside-source',
        `DSH patch resolves outside the locked source tree: ${patchRef}`,
        'configure a patch contained by execution.dsh.sourceRoot',
        DSH_OWNER,
      );
    }
    let patchContent: string;
    try {
      patchContent = readFileSync(file);
    } catch {
      throw new AppLifecycleError(
        'dsh-patch-invalid',
        `DSH patch is not a regular file: ${patchRef}`,
        'restore the locked DSH source patch',
        DSH_OWNER,
      );
    }
    const actualDigest = digest(patchContent);
    if (actualDigest !== expectedDigest) {
      throw new AppLifecycleError(
        'dsh-patch-digest-mismatch',
        `DSH patch content does not match the locked digest: ${patchRef}`,
        'restore the locked DSH source patch',
        DSH_OWNER,
      );
    }
    files.push(file);
    digests.push(actualDigest);
  }
  return { refs: [...patchRefs], files, digests };
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
      throw new AppLifecycleError(
        'agent-provider-binding.unconfigured',
        `selected agent ${input.agentId} has no effective provider`,
        'configure a provider block for the selected agent or its shared top-level provider',
        AGENT_PROVIDER_OWNER,
      );
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
    throw new AppLifecycleError(
      'agent-provider-binding.unconfigured',
      `agent ${selected.agentId} for role ${input.roleId} has no effective provider`,
      'configure a provider block for the selected agent or its shared top-level provider',
      AGENT_PROVIDER_OWNER,
    );
  }
  return { configuredAgentId: selected.agentId, roleId: selected.roleId, provider: selected.provider };
}

/**
 * Selects one effective provider composition for a configured agent instance.
 * Exact agentId is the only explicit instance selector; a role-only selection
 * must be unique across the full roster, including unconfigured members.
 * Every rejection happens before any provider port is constructed.
 */
export function selectAgentProvider<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(input: AgentProviderSelectionInput<TIdentity>): AgentProviderComposition<TIdentity> {
  const selected = resolveSelectedInstance(input);
  const provider = selected.provider;
  const binding = {
    ...providerBindingFromConfig(provider),
    ...(selected.configuredAgentId === undefined ? input.legacyBindingOverrides : {}),
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

/** Close an owned composition and require an actual closed receipt. */
export async function closeAgentProvider<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
>(composition: AgentProviderComposition<TIdentity>): Promise<void> {
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

function providerBinding(
  config: DshExecutionConfig,
  profile: DshProfileDescriptor,
  patchDigests: readonly string[],
): ProviderBinding {
  const configDigest = digest(JSON.stringify({
    profile: config.profile,
    provider: config.provider,
    model: config.model,
    sourceRoot: config.sourceRoot,
    patchDigests,
    permissionMode: config.permissionMode ?? null,
  }));
  return {
    bindingId: `dsh-${config.profile}-${config.provider}`,
    providerId: 'dsh',
    protocol: 'other-explicit',
    endpointRef: `local:dsh-stdio:${profile.profileName}`,
    modelRef: `${config.provider}/${config.model}`,
    configDigest,
    capabilityDigest: digest(`${dshBaselineLock.commit}:${config.provider}:${config.model}`),
  };
}

/**
 * `llm-pi-ai` provider routes live in the DSH home, not in RCC. HumanAgent
 * writes the one route it was configured with and refuses to silently replace
 * a different existing document: the DSH home is persistent runtime state.
 */
function settingsDocument(config: DshExecutionConfig): string {
  const yamlScalar = (value: string): string => JSON.stringify(value);
  return [
    'llm-pi-ai:',
    '  providers:',
    `    ${yamlScalar(config.provider)}:`,
    `      displayName: ${yamlScalar(`${config.provider} route`)}`,
    '      api: openai-completions',
    `      baseURL: ${DSH_RCC_BASE_URL}`,
    '      apiKeyEnv: RCC_LOCAL_API_KEY',
    '      models:',
    `        - id: ${yamlScalar(config.model)}`,
    '          contextWindow: 272000',
    '          maxTokens: 32768',
    '',
  ].join('\n');
}

export async function ensureDshSettings(home: string, config: DshExecutionConfig): Promise<void> {
  await mkdir(home, { recursive: true });
  const file = join(home, DSH_SETTINGS_FILE);
  const document = settingsDocument(config);
  let existing: string | undefined;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  if (existing === undefined) {
    await writeFile(file, document, 'utf8');
    return;
  }
  if (existing.trim() !== document.trim()) {
    throw new AppLifecycleError(
      'dsh-settings-conflict',
      `DSH home settings already exist and do not match the configured ${config.provider}/${config.model} route`,
      `inspect or move ${file} before running this agent`,
      DSH_OWNER,
    );
  }
}

export interface ComposedAgentDriver {
  readonly driver: AgentDriver;
  readonly execution?: ExecutionBinding;
}

export interface DshCompositionInput {
  readonly agent: AgentConfig;
  readonly paths: RuntimePaths;
  readonly dsh?: DshExecutionConfig;
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
  if (input.agent.driverRef !== 'dsh') {
    throw new AppLifecycleError(
      'agent-driver-unsupported',
      `agent driver is not enabled: ${input.agent.driverRef}`,
      'choose an explicitly supported driverRef',
      'app-agent-driver-composition',
    );
  }
  const config = input.dsh;
  if (!config) {
    throw new AppLifecycleError(
      'dsh-config-missing',
      'agent uses the dsh driver but execution.dsh is not configured',
      'configure execution.dsh in the user config before running the agent',
      DSH_OWNER,
    );
  }
  const sourceRoot = resolve(config.sourceRoot);
  assertDshSourceMatchesLock(sourceRoot);
  const patches = verifyDshPatches(sourceRoot, config.patchFiles ?? []);
  const home = resolveDshHome({ paths: input.paths, configuredHome: config.home });
  const profile = dshProfile(config, dshBaselineLock, sourceRoot, patches.refs, patches.digests);
  const binding = providerBinding(config, profile, patches.digests);
  const transport = createRealDshTransport({
    binding,
    lock: dshBaselineLock,
    profile,
    sourceRoot,
    home,
    workspace: config.workspace ?? input.workspace,
    provider: config.provider,
    model: config.model,
    patchFiles: patches.files,
    ...(config.permissionMode === undefined ? {} : { env: { DSH_PERMISSION_MODE: config.permissionMode } }),
    ...(config.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: config.turnTimeoutMs }),
    ...(config.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: config.shutdownTimeoutMs }),
  });
  const runtime = createDshExecutionRuntimePort({
    lock: dshBaselineLock,
    profile,
    transport,
    requiredCapabilities: ['dsh.session', 'dsh.model', 'dsh.tool', 'dsh.continuation'],
    ownerId: DSH_OWNER,
  });
  return {
    driver: createDshAgentDriver({ runtime, binding }),
    execution: { runtimeId: input.runtimeId, provider: binding },
  };
}
