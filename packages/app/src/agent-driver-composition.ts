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
import type { AgentConfig, DshExecutionConfig, RuntimePaths } from '../../config/src/index.js';
import { FakeAgentDriver } from '../../adapters/testing/src/index.js';
import {
  id,
  type AgentDriver,
  type ExecutionBinding,
  type ProviderBinding,
} from '../../contracts/src/index.js';
import { AppLifecycleError } from './errors.js';

const DSH_OWNER = 'humanagent.app.dsh-composition';
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
  readonly runtimeId: string;
  readonly workspace: string;
}

/**
 * Explicitly composes the configured driver. There is no fallback: an unknown
 * driverRef or a DSH agent without DSH execution config fails closed.
 */
export function composeAgentDriver(input: DshCompositionInput): ComposedAgentDriver {
  if (input.agent.driverRef === 'fake') {
    return { driver: new FakeAgentDriver() };
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
