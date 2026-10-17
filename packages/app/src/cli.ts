#!/usr/bin/env node
import {
  ConfigurationError,
  ensureControlLayout,
  listConfiguredProjects,
  loadConfiguration,
  resolveRuntimePaths,
  resolveWebSearchBackendConfig,
  type LoadedConfiguration,
  type RuntimePaths,
} from '../../config/src/index.js';
import {
  id,
  type Attention,
  type Checkpoint,
  type CycleId,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type HarnessPlugin,
  type ProviderBinding,
  type TaskId,
  type ScopeRef,
  type AnyProviderExecutionIdentityRef,
  type ProviderExecutionIdentityRef,
  type TasklessProviderExecutionIdentityRef,
} from '../../contracts/src/index.js';
import { AppLifecycleError } from './errors.js';
import {
  closeRuntime,
  composeAgentDriver,
  composeMemoryRuntime,
  configureBuiltinPromptRoot,
  filesystemTaskEvidence,
  openRuntime,
  readCheckpointEvidence,
  readCommittedCheckpoint,
  readRunManifest,
  resumeAgentOperation,
  resumeRuntime,
  runAgentOperation,
  settleSessionOutcome,
} from './index.js';
import { SessionStore } from './session-store.js';
import { startUiRuntime } from './ui-runtime/index.js';
import { assembleProviderExecutionPort } from './provider-assembly.js';
import { closeAgentProvider, createAgentProviderPort, prepareAgentProvider, prepareExecutionAgentProvider,
  providerBindingFromConfig, type AgentProviderComposition } from './agent-driver-composition.js';
import type { MemoryAgentOptions } from '../../runtime/src/memory/agent.js';
import { AccessControlService, deriveSupervisorToken } from './ui-runtime/access-control.js';
import type { ProductPrincipalVerification, VerifiedProductPrincipal } from './ui-runtime/access-control.js';
import { providerRetryConfigFromEffective } from './retry-config.js';
import {
  createFakeExecutionPort,
  FakeProviderAgentDriver,
  fakeExecutionBinding,
  type FakeExecutionScenario,
} from './fake-execution.js';
import {
  entryCompositionInventory,
  FAKE_SERVE_PROVIDER_PLUGIN,
  RCC_SERVE_PROVIDER_PLUGIN,
  SERVE_COMPOSITION_PLUGINS,
  serveCompositionComplete,
  serveCompositionManifestMatches,
} from './entry-composition.js';
import { createCordisHost } from './cordis-host.js';
import { readDaemonLease, runSupervisorStartup, waitForDaemonLeaseHandoff, type SupervisorStartup } from './supervisor/supervisor.js';
import {
  captureLoadedSourceReceipt,
  restartDaemonWithCodeHandoff,
  startDaemonCodeHandoff,
  type DaemonCodeHandoff,
  type SupervisorStartupDeclaration,
} from './supervisor/restart-client.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServeRuntimeComposition, type ServeRuntimeComposition } from './serve-runtime.js';
import { createDeterministicServeOrchestrationPorts, createRccServeOrchestrationPorts } from './serve-orchestration.js';
import { PROVIDERS, type ProviderConfig, type ProviderSource } from '../../config/src/index.js';
import { createTaskExecutionPreparation } from './task-execution-preparation.js';
import { createPreparedOperationBoundary } from './prepared-operation-boundary.js';
import { createJsonlI2JournalPort } from './i2-journal.js';
import { JsonlTaskIdentityJournal } from '../../adapters/jsonl/src/task-identities.js';
import { JsonlOrganJournal } from '../../adapters/jsonl/src/index.js';
import { TaskIdentityConsumer } from '../../runtime/src/orchestration/task-identity.js';
import { UiRuntimeJournal, uiRuntimeControlJournalPath } from './ui-runtime/journal.js';
import { ServiceExecutionCheckpointStore } from './ui-runtime/execution-composition.js';
import type { AttentionPort } from '../../runtime/src/control/attention.js';
import { createJournalCheckpointEvidencePort, reconcileCommittedReentryMemoryBoundaries, type MemoryRuntime } from './memory-runtime.js';
import { createJsonlAttentionPort, readJsonlAttentions } from './attention-journal.js';
import type { UiRuntimeMemoryComposition } from './ui-runtime/service.js';
import type { RuntimeTaskEvent } from '../../runtime/src/ui-runtime/coordinator.js';
import {
  RESPONSES_BASH_TOOL,
  RESPONSES_CREATE_GOAL_TOOL,
  RESPONSES_FILE_EDIT_TOOL,
  RESPONSES_FILE_LIST_TOOL,
  RESPONSES_FILE_READ_TOOL,
  RESPONSES_FILE_SEARCH_TOOL,
  RESPONSES_FILE_WRITE_TOOL,
  RESPONSES_GET_GOAL_TOOL,
  RESPONSES_PRESENT_TOOL,
  RESPONSES_TODO_WRITE_TOOL,
  RESPONSES_UPDATE_GOAL_TOOL,
  RESPONSES_WEB_SEARCH_TOOL,
} from './provider-tool-execution.js';

// Options that consume the following argument as their value. `--help`/`-h`
// appearing in such a value position is payload (for example
// `run --plan default --prompt -h`), not a help request.
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--binding',
  '--capability-digest',
  '--config-digest',
  '--control-session-file',
  '--control-root',
  '--endpoint',
  '--fake-scenario',
  '--fake-step-delay-ms',
  '--host',
  '--max-tokens',
  '--memory',
  '--mode',
  '--model',
  '--plan',
  '--port',
  '--prompt',
  '--protocol',
  '--provider',
  '--rcc-base-url',
  '--route',
  '--session',
  '--task',
  '--ui-root',
  '--workspace',
]);

const SERVE_STARTUP_OPTIONS: ReadonlySet<string> = new Set([
  '--binding',
  '--capability-digest',
  '--config-digest',
  '--control-root',
  '--endpoint',
  '--fake-scenario',
  '--fake-step-delay-ms',
  '--host',
  '--max-tokens',
  '--mode',
  '--model',
  '--port',
  '--protocol',
  '--provider',
  '--rcc-base-url',
  '--route',
  '--ui-root',
  '--workspace',
]);

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function startupOptionMap(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (!SERVE_STARTUP_OPTIONS.has(name)) continue;
    const value = args[index + 1];
    if (value === undefined) continue;
    values.set(name, value);
    index += 1;
  }
  return values;
}

function mergeStartupArgs(base: readonly string[], overrides: readonly string[]): readonly string[] {
  const merged = startupOptionMap(base);
  for (const [name, value] of startupOptionMap(overrides)) merged.set(name, value);
  return [...merged.entries()].flatMap(([name, value]) => [name, value]);
}

function assertLegacyRestartOptions(args: readonly string[]): void {
  const values = startupOptionMap(args);
  const missing = ['--provider', '--port'].filter((name) => !values.has(name));
  if (missing.length === 0) return;
  throw new AppLifecycleError(
    'daemon-restart.startup-incomplete',
    `legacy serve owner has no startup declaration; missing explicit restart input: ${missing.join(', ')}`,
    'retry restart with the original serve startup options, including --provider and --port',
    'humanagent.app.serve',
  );
}

function helpRequested(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') return true;
  }
  return false;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error('missing ' + name);
  return value;
}

function requiredPrompt(value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new AppLifecycleError(
      'execution.input.required',
      'request field prompt is required',
      'provide a non-empty prompt',
      'humanagent.app',
    );
  }
  return value;
}

function packageVersion(): string {
  const configured = process.env.HUMANAGENT_RELEASE_VERSION?.trim();
  if (configured) return configured;
  let current = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index += 1) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const value = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
        if (typeof value.version === 'string' && value.version.trim()) return value.version;
      } catch {
        // Continue walking; a package.json outside the runtime root is not authoritative.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '0.1.0';
}

async function currentStartupDeclaration(
  args: readonly string[],
  baseArgs: readonly string[] = [],
): Promise<SupervisorStartupDeclaration> {
  const entryPath = fileURLToPath(import.meta.url);
  let launcherPath = entryPath;
  if (process.argv[1]) {
    try {
      launcherPath = realpathSync(process.argv[1]);
    } catch {
      // Keep the loaded module path when the launcher path is no longer present.
    }
  }
  const releaseVersion = process.env.HUMANAGENT_RELEASE_VERSION?.trim();
  return {
    launcherPath,
    cwd: process.cwd(),
    args: mergeStartupArgs(baseArgs, args),
    source: await captureLoadedSourceReceipt({
      entryPath,
      packageVersion: packageVersion(),
      ...(releaseVersion === undefined || releaseVersion.length === 0 ? {} : { releaseVersion }),
    }),
  };
}

function defaultUiRoot(): string {
  const configured = process.env.HUMANAGENT_UI_ROOT?.trim();
  if (configured) return configured;
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const packaged = join(moduleRoot, '../../ui');
  if (existsSync(join(packaged, 'index.html'))) return packaged;
  const source = join(moduleRoot, '../../../../docs/ui');
  if (existsSync(join(source, 'index.html'))) return source;
  return join(process.cwd(), 'docs', 'ui');
}

function fakeScenario(args: readonly string[]): FakeExecutionScenario | undefined {
  const value = option(args, '--fake-scenario');
  if (value === undefined) return undefined;
  if (
    value !== 'success'
    && value !== 'tool'
    && value !== 'error'
    && value !== 'cancel'
    && value !== 'unknown'
    && value !== 'close-failure'
  ) {
    throw new Error('--fake-scenario must be success, tool, error, cancel, unknown, or close-failure');
  }
  return value;
}

type ServeHost = '0.0.0.0' | '::' | '127.0.0.1' | '::1';

function serveHost(value: string): ServeHost {
  if (value !== '0.0.0.0' && value !== '::' && value !== '127.0.0.1' && value !== '::1') {
    throw new AppLifecycleError(
      'serve.host.invalid',
      `serve --host must be 0.0.0.0, ::, 127.0.0.1, or ::1: ${value}`,
      'choose a supported listener wildcard or loopback host; interface addresses and hostnames are not accepted',
      'humanagent.app.serve',
    );
  }
  return value;
}

function controlEndpointFor(host: ServeHost, port: number): { readonly host: '127.0.0.1' | '::1'; readonly port: number } {
  return { host: host === '::1' ? '::1' : '127.0.0.1', port };
}

function reachableIpv4Address(): string | undefined {
  const addresses = networkInterfaces();
  for (const entries of Object.values(addresses)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function reachableIpv6Address(): string | undefined {
  const addresses = networkInterfaces();
  for (const entries of Object.values(addresses)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv6' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function displayOrigin(bound: { readonly listenAddress: string; readonly port: number }): string {
  const address = bound.listenAddress === '0.0.0.0'
    ? reachableIpv4Address() ?? '127.0.0.1'
    : bound.listenAddress === '::'
      ? reachableIpv6Address() ?? '::1'
    : bound.listenAddress;
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${bound.port}`;
}

function controlEndpointUrl(endpoint: { readonly host: '127.0.0.1' | '::1'; readonly port: number }, path: string): string {
  const host = endpoint.host === '::1' ? '[::1]' : endpoint.host;
  return `http://${host}:${endpoint.port}${path}`;
}

function memoryTrigger(outcome: Checkpoint['outcome']): 'completion' | 'blocked' | 'rewind' | null {
  if (outcome === 'succeeded') return 'completion';
  if (outcome === 'failed' || outcome === 'waiting' || outcome === 'blocked' || outcome === 'unknown') return 'blocked';
  return null;
}

export function composeUiMemoryHooks(input: {
  readonly memory: MemoryRuntime;
  readonly checkpointJournalPath: string;
  readonly attentionPort: AttentionPort;
  readonly readAttentions: () => Promise<readonly Attention[]>;
}): Pick<UiRuntimeMemoryComposition, 'checkpointBoundary' | 'reconcileTaskScope' | 'reviewState'> {
  const ownerId = 'humanagent.app.memory';
  let boundaryError: AppLifecycleError | undefined;
  let diagnosticBoundaryId: string | undefined;
  const reason = (error: unknown): string => {
    const own = error instanceof Error
      ? `${'code' in error ? String(error.code) + ': ' : ''}${error.message}` : String(error);
    if (error instanceof AggregateError) return `${own}; ${error.errors.map(reason).join('; ')}`;
    return error instanceof Error && 'cause' in error && error.cause !== undefined
      ? `${own}; caused by ${reason(error.cause)}` : own;
  };
  const attentionId = (scope: ScopeRef, phase: string, boundary: string) =>
    `memory:${scope.organId.value}:${scope.taskId?.value ?? 'organ'}:${phase}:${boundary}`;
  async function diagnose(scope: ScopeRef, phase: string, boundary: string, error: unknown,
    evidenceRefs: readonly EvidenceRef[] = []): Promise<void> {
    const attention: Attention = {
      attentionId: attentionId(scope, phase, boundary), scope, ownerId, severity: 'info', state: 'open',
      message: `${phase}: ${reason(error)}`,
      nextAction: { kind: 'recover', ref: `review canonical task Journal ${input.checkpointJournalPath} for task ${scope.taskId?.value ?? 'organ'}; boundary ${boundary}` },
      evidenceRefs,
    };
    try {
      const existing = (await input.readAttentions()).find((entry) => entry.attentionId === attention.attentionId);
      if (existing?.state !== 'open' || existing.message !== attention.message) await input.attentionPort.publish(attention);
      if (diagnosticBoundaryId === attention.attentionId) boundaryError = undefined;
    } catch (diagnosticError) {
      diagnosticBoundaryId = attention.attentionId;
      boundaryError = new AppLifecycleError('memory-boundary-diagnostic-failed',
        `${attention.message}; diagnostic storage: ${reason(diagnosticError)}`,
        attention.nextAction!.ref!, ownerId, new AggregateError([error, diagnosticError], 'Memory boundary and diagnostic storage failed'));
    }
  }
  async function resolve(scope: ScopeRef, phase: string, boundary: string): Promise<void> {
    try {
      const existing = (await input.readAttentions()).find((entry) => entry.attentionId === attentionId(scope, phase, boundary));
      if (existing && existing.state !== 'resolved') await input.attentionPort.resolve({ ...existing, state: 'resolved' });
      if (diagnosticBoundaryId === attentionId(scope, phase, boundary)) boundaryError = undefined;
    } catch (error) {
      diagnosticBoundaryId = attentionId(scope, phase, boundary);
      boundaryError = new AppLifecycleError('memory-boundary-diagnostic-failed', reason(error),
        `read Memory diagnostics and the canonical task Journal ${input.checkpointJournalPath}`, ownerId, error);
    }
  }
  async function reconcileTaskScope({ taskScope }: { readonly taskScope: ScopeRef }): Promise<void> {
    try {
      const result = await reconcileCommittedReentryMemoryBoundaries({
        memory: input.memory, checkpointJournalPath: input.checkpointJournalPath, taskScope,
      });
      for (const issue of result.issues) {
        await diagnose(taskScope, 'reentry', issue.reentryClosureIds.join(','),
          new AppLifecycleError(issue.code, issue.message, 'review the canonical reentry boundary', ownerId));
      }
      for (const group of result.groups) await resolve(taskScope, 'reentry', group.reentryClosureIds.join(','));
      if (result.groups.length > 0 && result.issues.length === 0) await resolve(taskScope, 'reconcile', 'history');
    } catch (error) {
      await diagnose(taskScope, 'reconcile', 'history', error);
    }
  }
  return {
    reconcileTaskScope,
    async reviewState() {
      // The actual consumer read is required; only optional hook diagnostics are isolated.
      const review = await input.memory.reviewState();
      let boundaryAttentions: readonly Attention[] = [];
      try {
        boundaryAttentions = (await input.readAttentions()).filter((entry) => entry.ownerId === ownerId);
        if (boundaryError?.code === 'memory-boundary-diagnostic-read-failed') boundaryError = undefined;
      } catch (error) {
        if (boundaryError === undefined) boundaryError = new AppLifecycleError('memory-boundary-diagnostic-read-failed',
          reason(error),
          `read Memory diagnostics and the canonical task Journal ${input.checkpointJournalPath}`, ownerId,
          error);
      }
      return { ...review, boundaryAttentions, ...(boundaryError === undefined ? {} : { boundaryError }) };
    },
    checkpointBoundary: {
      async publish({ checkpoint, recordDigest }) {
        if (checkpoint.scope.taskId !== undefined) await reconcileTaskScope({ taskScope: {
          organId: checkpoint.scope.organId, taskId: checkpoint.scope.taskId,
        } });
        const trigger = memoryTrigger(checkpoint.outcome);
        if (!trigger) return;
        try {
          if (!recordDigest) throw new AppLifecycleError('memory-boundary-digest-missing',
            `checkpoint ${checkpoint.id.value} is committed without a journal record digest`,
            'recover the committed checkpoint record before publishing the memory boundary', 'humanagent.cli');
          if (checkpoint.scope.taskId !== undefined) {
            await input.memory.boundaryPublisher.publishTask({ checkpoint, recordDigest, trigger });
          } else {
            await input.memory.boundaryPublisher.publish({ checkpoint, recordDigest, trigger });
          }
          await input.memory.consume();
          await resolve(checkpoint.scope, 'publication', checkpoint.id.value);
        } catch (error) {
          await diagnose(checkpoint.scope, 'publication', checkpoint.id.value, error, checkpoint.evidenceRefs);
        }
      },
    },
  };
}

function uiMemoryEvidence(checkpointRoot: string, mode: 'fake' | 'rcc') {
  const filePathFor = (scope: Checkpoint['scope']) => join(
    checkpointRoot,
    mode,
    `task-${scope.taskId!.value}-cycle-${scope.cycleId!.value}.jsonl`,
  );
  return createJournalCheckpointEvidencePort({
    filePath: uiRuntimeControlJournalPath(join(checkpointRoot, mode)), fallbackFilePathFor: filePathFor,
  });
}

async function composeTaskMemory(input: {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly sessionId: string;
  readonly bindingRef: string;
  readonly executionEpoch: number;
  readonly driverFor?: MemoryAgentOptions['driverFor'];
}) {
  const localSkill = input.configuration.projectSourceManifest.sources?.localSkill;
  const mainAgentId = input.configuration.effective.project?.defaultAgent
    ?? input.configuration.agentRoster[0]!.agentId;
  return composeMemoryRuntime({
    paths: input.paths,
    configuration: input.configuration,
    workspaceCwd: input.paths.workspaceCwd,
    sessionsRoot: input.paths.sessionsRoot,
    runNotesRoot: input.paths.runNotesRoot,
    ...(localSkill === undefined ? {} : {
      localSkillRoot: localSkill.root,
      localSkillName: localSkill.name,
    }),
    auditPromptRoot: join(input.paths.controlRoot, 'memory-audit'),
    auditPromptRef: input.configuration.effective.memory?.audit.promptRef ?? 'project-memory-audit',
    autoUpdate: input.configuration.effective.memory?.update.auto ?? false,
    binding: {
      bindingRef: input.bindingRef,
      projectKey: input.paths.projectKey,
      executionEpoch: input.executionEpoch,
      scope: {
        namespace: 'project',
        projectKey: input.paths.projectKey,
        organId: id('organ', `agent-${mainAgentId}`),
        taskId: id('task', input.sessionId),
      },
      taskId: id('task', input.sessionId),
      mainAgentId,
      actor: {
        actorId: `memory:${input.paths.projectKey}`,
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: input.paths.projectKey,
      },
    },
    mainAgentId,
    ...(input.driverFor === undefined ? {} : { driverFor: input.driverFor }),
  });
}

export interface ServeRccDriverBinding {
  readonly port: ExecutionRuntimePort;
  readonly binding: ProviderBinding;
  readonly inputRefs: readonly string[];
}

/**
 * Provider-backed memory analysis must use an explicitly configured
 * `roleId === 'memory'` agent, never the main operation driver. A fresh driver
 * is composed for each admitted memory operation so its runtime/operation
 * identity cannot leak into the main task execution.
 *
 * Each RCC operation prepares its configured memory provider and hands off
 * that same pair with a release callback. Explicit controlled consumers can
 * supply their own pair when no preparation callback is present.
 */
export function memoryDriverFactory(input: {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly workspace: string;
  readonly rcc?: ServeRccDriverBinding;
  readonly inputRefs?: readonly string[];
  readonly prepareAgentProvider?: (input: {
    readonly roleId: import('../../config/src/index.js').AgentRole;
    readonly configuredAgentId?: string;
  }) => Promise<AgentProviderComposition>;
}): MemoryAgentOptions['driverFor'] {
  const memoryAgent = input.configuration.agentRoster.find((agent) => agent.roleId === 'memory');
  if (memoryAgent === undefined) return undefined;
  return ({ assignmentId, scope, operationId, taskId, executionEpoch }) => {
    if (scope.namespace !== 'project') {
      throw new AppLifecycleError(
        'memory-driver-scope-unsupported',
        'memory analysis driver requires a project-scoped analysis request',
        'admit the memory analysis with a project scope before composing its driver',
        'humanagent.app.entry-composition',
      );
    }
    const compose = (pair: ServeRccDriverBinding | undefined) => {
      const rcc = pair === undefined
        ? undefined
        : {
            port: pair.port,
            binding: pair.binding,
            scope: {
              organId: scope.organId,
              taskId,
              operationId,
            },
            taskId,
            operationId,
            executionEpoch,
            assignmentId,
            inputRefs: pair.inputRefs,
          };
      const composed = composeAgentDriver({
        agent: memoryAgent,
        paths: input.paths,
        ...(input.configuration.effective.execution?.dsh === undefined
          ? {}
          : { dsh: input.configuration.effective.execution.dsh }),
        ...(input.configuration.effective.execution?.opencode === undefined
          ? {}
          : { opencode: input.configuration.effective.execution.opencode }),
        ...(input.configuration.effective.execution?.antigravity === undefined
          ? {}
          : { antigravity: input.configuration.effective.execution.antigravity }),
        ...(input.configuration.effective.execution?.dshAcp === undefined
          ? {}
          : { dshAcp: input.configuration.effective.execution.dshAcp }),
        ...(rcc === undefined ? {} : { rcc }),
        runtimeId: assignmentId,
        workspace: input.workspace,
      });
      return composed.driver;
    };
    if (memoryAgent.driverRef === 'rcc' && input.prepareAgentProvider !== undefined) {
      const prepare = input.prepareAgentProvider;
      return (async () => {
        const composition = await prepare({ roleId: 'memory', configuredAgentId: memoryAgent.agentId });
        try {
          const driver = compose({
            port: composition.port,
            binding: composition.binding,
            inputRefs: input.inputRefs ?? input.rcc?.inputRefs ?? [],
          });
          return { driver, release: () => closeAgentProvider(composition) };
        } catch (error) {
          try {
            await closeAgentProvider(composition);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'memory driver construction and cleanup failed');
          }
          throw error;
        }
      })();
    }
    return compose(input.rcc);
  };
}

type UiProviderProtocol = 'responses' | 'openai' | 'anthropic';
type ServeProvider = 'fake' | 'rcc';

function servePlugins(mode: 'fake' | 'rcc', input: {
  readonly memory: Parameters<typeof startUiRuntime>[0]['memory'];
  readonly executionPort: ExecutionRuntimePort;
}): readonly HarnessPlugin[] {
  const dependencies = ['humanagent.harness-kernel'];
  const memoryBackend = input.memory.backend;
  const provider = mode === 'fake' ? FAKE_SERVE_PROVIDER_PLUGIN : RCC_SERVE_PROVIDER_PLUGIN;
  const providerPlugin: HarnessPlugin = {
    manifest: {
      kind: 'humanagent.plugin',
      pluginId: provider.pluginId,
      version: '1.0.0',
      apiVersion: 1,
      entry: `builtin:${provider.pluginId}`,
      dependencies,
      provides: [...provider.capabilities],
      consumes: ['harness.kernel'],
      permissions: [],
      digest: `builtin:${provider.pluginId}:v1`,
    },
    register(context) {
      context.registerExecutionRuntimePort(input.executionPort);
    },
  };
  return [
    providerPlugin,
    {
      manifest: {
        kind: 'humanagent.plugin',
        pluginId: 'humanagent.agent-templates',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'builtin:humanagent.agent-templates',
        dependencies,
        provides: ['agent.templates'],
        consumes: ['harness.kernel'],
        permissions: [],
        digest: 'builtin:humanagent.agent-templates:v1',
      },
      register(context) {
        context.registerCapability('agent.templates');
      },
    },
    {
      manifest: {
        kind: 'humanagent.plugin',
        pluginId: 'humanagent.memory',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'builtin:humanagent.memory',
        dependencies,
        provides: ['memory.operations', 'memory.context'],
        consumes: ['harness.kernel'],
        permissions: [],
        digest: 'builtin:humanagent.memory:v1',
      },
      register(context) {
        context.registerMemoryOperations(memoryBackend);
        context.registerAgentMemoryContextInjection(memoryBackend);
      },
    },
    {
      manifest: {
        kind: 'humanagent.plugin',
        pluginId: 'humanagent.ui',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'builtin:humanagent.ui',
        dependencies,
        provides: ['ui.projection'],
        consumes: ['harness.kernel'],
        permissions: [],
        digest: 'builtin:humanagent.ui:v1',
      },
      register(context) {
        context.registerCapability('ui.projection');
      },
    },
  ];
}

const DEFAULT_RCC_PROVIDER: ProviderConfig = {
  provider: 'rcc',
  binding: 'rcc-entry',
  protocol: 'responses',
  model: 'MiniMax-M3',
  route: 'default',
  baseUrl: 'http://127.0.0.1:4444',
};

function resolveServeProvider(
  args: readonly string[],
  configured: ProviderConfig | undefined,
): { readonly provider: ServeProvider; readonly providerIdOverride?: string } {
  const requested = option(args, '--provider');
  const legacyMode = option(args, '--mode');
  if (legacyMode !== undefined && legacyMode !== 'fake' && legacyMode !== 'rcc') {
    throw new AppLifecycleError(
      'provider.invalid',
      `unknown legacy mode: ${legacyMode}`,
      'choose fake or rcc for --mode, or omit the deprecated option',
      'humanagent.config',
    );
  }
  if (requested === 'fake' || requested === 'rcc') {
    if (legacyMode !== undefined && requested !== legacyMode) {
      throw new AppLifecycleError(
        'provider.invalid',
        `conflicting provider options: --mode ${legacyMode} and --provider ${requested}`,
        'use one provider selection, or make --mode and --provider agree',
        'humanagent.config',
      );
    }
    return { provider: requested };
  }
  if (legacyMode === 'fake' || legacyMode === 'rcc') {
    return {
      provider: legacyMode,
      ...(requested === undefined ? {} : { providerIdOverride: requested }),
    };
  }
  // The configured/selected `provider` is a finite local binding label
  // (`rcc`/`http`); it never selects the serve backend. Any real label keeps
  // the finite serve mode `rcc` and only reaches the provider binding, which
  // preserves the source/label separation. Unknown labels stay invalid.
  if (requested !== undefined && !(PROVIDERS as readonly string[]).includes(requested)) {
    throw new AppLifecycleError(
      'provider.invalid',
      `unknown provider: ${requested}`,
      'choose a configured provider such as rcc or http, or use fake only for internal tests',
      'humanagent.config',
    );
  }
  return {
    provider: 'rcc',
    ...(requested === undefined ? {} : { providerIdOverride: requested }),
  };
}

function providerBindingFromOptions(
  args: readonly string[],
  configured: ProviderConfig | undefined,
  protocol: UiProviderProtocol,
  provider: ServeProvider,
  baseUrl: string,
  source: ProviderSource,
  providerIdOverride?: string,
): ProviderBinding & { readonly protocol: UiProviderProtocol } {
  const fake = provider === 'fake';
  const defaults = configured ?? DEFAULT_RCC_PROVIDER;
  if (!fake) {
    const providerId = providerIdOverride === undefined
      ? defaults.provider
      : PROVIDERS.find((candidate) => candidate === providerIdOverride);
    if (providerId === undefined) {
      throw new AppLifecycleError('provider.invalid', `unknown provider: ${providerIdOverride}`,
        'choose a configured provider such as rcc or http', 'humanagent.config');
    }
    const binding = providerBindingFromConfig({
      ...defaults,
      source,
      binding: option(args, '--binding') ?? defaults.binding,
      provider: providerId,
      protocol,
      model: option(args, '--model') ?? defaults.model,
      route: option(args, '--route') ?? defaults.route,
      baseUrl,
    });
    return {
      ...binding,
      protocol,
      endpointRef: option(args, '--endpoint') ?? binding.endpointRef,
      configDigest: option(args, '--config-digest') ?? binding.configDigest,
      capabilityDigest: option(args, '--capability-digest') ?? binding.capabilityDigest,
    };
  }
  return {
    bindingId: option(args, '--binding') ?? 'fake-default',
    providerId: providerIdOverride ?? 'fake-provider',
    protocol,
    endpointRef: option(args, '--endpoint') ?? 'fake:replay',
    modelRef: option(args, '--model') ?? 'fake.model',
    configDigest: option(args, '--config-digest') ?? 'sha256:fake-ui-config',
    capabilityDigest: option(args, '--capability-digest') ?? 'sha256:fake-ui-capability',
  };
}

function helpText(): string {
  return [
    'HumanAgent',
    '',
    '用法：humanagent [serve 选项]',
    '',
    '默认启动 WebUI，workspace 为当前目录，端口为 10086。',
    '',
    '常用选项：',
    '  --workspace <path>       项目 workspace（默认当前目录）',
    '  --provider <name>        provider（默认读取 ~/.humanagent/config.toml）',
    '  --port <number>          WebUI 端口（默认 10086）',
    '  --protocol <name>        responses、openai 或 anthropic',
    '  humanagent restart       使用原 serve owner 的启动声明完成一次代码交接',
    '  --help                   显示帮助',
    '  --json                   以机器可读 JSON 输出错误',
    '',
    '内部测试 provider fake 仅供测试，不是人类运行模式。',
  ].join('\n');
}

function servePromptSegments(
  configuration: LoadedConfiguration,
  role: 'review',
): readonly string[] {
  const loaded = configuration.promptCatalog[role];
  if (!loaded || loaded.segments.length === 0) {
    throw new AppLifecycleError(
      'serve.agent-prompt.missing',
      `serve ${role} agent prompt segments are not loaded`,
      'restore the locked builtin agent template resources before starting RCC orchestration',
      'humanagent.app.serve-orchestration',
    );
  }
  return loaded.segments.map((segment) => segment.content);
}

function taskAgentProviderPreparer(
  args: readonly string[],
  configuration: LoadedConfiguration,
  evidenceRoot: string,
) {
  return async (input: {
    readonly roleId: import('../../config/src/index.js').AgentRole;
    readonly configuredAgentId?: string;
  }) => {
    const configured = configuration.effective.provider ?? DEFAULT_RCC_PROVIDER;
    const protocol = option(args, '--protocol') ?? configured.protocol;
    if (protocol !== 'responses' && protocol !== 'openai' && protocol !== 'anthropic') {
      throw new Error('--protocol must be responses, openai, or anthropic');
    }
    const source = configured.source ?? 'rcc';
    const selected = resolveServeProvider(args, configuration.effective.provider);
    const baseUrl = option(args, '--rcc-base-url') ?? configured.baseUrl;
    const binding = providerBindingFromOptions(args, configured, protocol, selected.provider, baseUrl, source, selected.providerIdOverride);
    const legacyProvider: ProviderConfig = {
      ...configured,
      source,
      binding: binding.bindingId,
      provider: binding.providerId === 'rcc' || binding.providerId === 'http' ? binding.providerId : configured.provider,
      protocol,
      model: binding.modelRef,
      route: option(args, '--route') ?? configured.route,
      baseUrl,
    };
    return prepareAgentProvider({
      ...input,
      agentProviderBindings: configuration.agentProviderBindings,
      legacyProvider,
      legacyBindingOverrides: {
        endpointRef: binding.endpointRef,
        configDigest: binding.configDigest,
        capabilityDigest: binding.capabilityDigest,
      },
      maxTokens: option(args, '--max-tokens') ? Number(option(args, '--max-tokens')) : undefined,
      evidenceRoot,
    });
  };
}

const NATIVE_PROVIDER_TOOLS = [
  RESPONSES_FILE_READ_TOOL,
  RESPONSES_FILE_LIST_TOOL,
  RESPONSES_FILE_SEARCH_TOOL,
  RESPONSES_FILE_WRITE_TOOL,
  RESPONSES_FILE_EDIT_TOOL,
  RESPONSES_BASH_TOOL,
  RESPONSES_TODO_WRITE_TOOL,
  RESPONSES_GET_GOAL_TOOL,
  RESPONSES_CREATE_GOAL_TOOL,
  RESPONSES_UPDATE_GOAL_TOOL,
  RESPONSES_PRESENT_TOOL,
  RESPONSES_WEB_SEARCH_TOOL,
] as const;

function stderrWrite(line: string): Promise<void> {
  // The app `process` shim exposes no `stderr` stream; `console.error` is the
  // CLI's stderr channel. Awaiting the returned promise keeps the delivered
  // receipt ordered after the write, not before it.
  console.error(line);
  return Promise.resolve();
}

/**
 * Real CLI attention delivery owner. The coordinator remains the only publisher
 * and resolver of Attention; this port writes each published/resolved Attention
 * to the CLI stderr stream and only acknowledges `delivered` after that write
 * resolves. It is not an immediate-delivered stub and adds no control authority.
 */
function nativeAttentionPort(): AttentionPort {
  const deliver = async (event: string, attention: Attention) => {
    await stderrWrite(JSON.stringify({
      event,
      attentionId: attention.attentionId,
      state: attention.state,
      severity: attention.severity,
      ownerId: attention.ownerId,
      message: attention.message,
      scope: attention.scope,
    }));
    return { attentionId: attention.attentionId, delivered: true as const };
  };
  return {
    publish: (attention) => deliver('attention.published', attention),
    resolve: (attention) => deliver('attention.resolved', attention),
  };
}

/**
 * Native RCC run. The CLI caller binds the same production owners the serve
 * runtime uses (the prepared UI journal, the Organ Journal control records, the
 * Runtime current state, I2, Task identity, the selected RCC provider and the
 * shared Task pool) and drives one retained Task through the coordinator's own
 * prepare/subscribe/release edge. It never creates a Task, identity, session or
 * grant; it selects an existing replay entity and reads the real completion
 * state back from the same owner after the final execution event.
 */
async function runNativeTask(input: {
  readonly args: readonly string[];
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly principal: VerifiedProductPrincipal;
  readonly taskSelector: string | undefined;
  readonly prompt: string;
}): Promise<void> {
  const { args, paths, configuration, principal, prompt } = input;
  const configuredProvider = configuration.effective.provider ?? DEFAULT_RCC_PROVIDER;
  const resolvedSource = configuredProvider.source ?? 'rcc';
  const selected = resolveServeProvider(args, configuration.effective.provider);
  if (selected.provider !== 'rcc') {
    throw new AppLifecycleError(
      'native-run.provider-unsupported',
      'the native run entry requires the rcc provider',
      'run with the configured rcc provider, or use fake only for internal tests',
      'humanagent.app.cli',
    );
  }
  const protocol = (option(args, '--protocol') ?? configuredProvider.protocol) as UiProviderProtocol;
  if (protocol !== 'responses' && protocol !== 'openai' && protocol !== 'anthropic') {
    throw new Error('run --protocol must be responses, openai, or anthropic');
  }
  const baseUrl = option(args, '--rcc-base-url') ?? configuredProvider.baseUrl;
  const binding = providerBindingFromOptions(args, configuredProvider, protocol, 'rcc', baseUrl, resolvedSource, selected.providerIdOverride);
  const evidenceRoot = join(paths.artifactsRoot, 'ui-provider-evidence');
  // Same real prepared journal startUiRuntime writes, so a retained Task created
  // by serve is selectable here instead of a second, invisible store.
  const checkpointRoot = join(paths.checkpointsRoot, 'ui-runtime');
  const modeRoot = join(checkpointRoot, 'rcc');
  const preparedJournalPath = join(modeRoot, 'ui-runtime-journal.jsonl');
  const preparedJournal = new UiRuntimeJournal(preparedJournalPath);
  // The control Organ Journal is the same physical file startUiRuntime writes:
  // mode root = <checkpointRoot>/<mode>, so task-control.jsonl sits beside the
  // prepared ui-runtime journal, not under a second journalRoot authority.
  const controlJournalPath = uiRuntimeControlJournalPath(modeRoot);
  const journal = new JsonlOrganJournal(controlJournalPath);
  const now = () => new Date();
  const prepareAgentProvider = taskAgentProviderPreparer(args, configuration, evidenceRoot);
  const port = assembleProviderExecutionPort({
    binding,
    routeRef: option(args, '--route') ?? configuredProvider.route,
    baseUrl,
    source: resolvedSource,
    maxTokens: option(args, '--max-tokens') ? Number(option(args, '--max-tokens')) : undefined,
  }, evidenceRoot);
  const memoryDriverFor = memoryDriverFactory({
    paths,
    configuration,
    workspace: paths.workspaceCwd,
    inputRefs: [`humanagent://memory/project/${paths.projectKey}`],
    prepareAgentProvider,
  });
  const memoryRuntime = await composeMemoryRuntime({
    paths,
    configuration,
    workspaceCwd: paths.workspaceCwd,
    sessionsRoot: paths.sessionsRoot,
    runNotesRoot: paths.runNotesRoot,
    auditPromptRoot: join(paths.controlRoot, 'memory-audit'),
    auditPromptRef: configuration.effective.memory?.audit.promptRef ?? 'project-memory-audit',
    autoUpdate: configuration.effective.memory?.update.auto ?? false,
    ...(memoryDriverFor === undefined ? {} : { driverFor: memoryDriverFor }),
    binding: {
      bindingRef: `memory-ui:${paths.projectKey}`,
      projectKey: paths.projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey: paths.projectKey,
        organId: id('organ', 'humanagent-ui'),
      },
      interactionScopeId: `runtime:${paths.projectKey}`,
      mainAgentId: 'humanagent-ui',
      actor: {
        actorId: 'memory-agent',
        roleId: 'memory',
        permissions: ['memory.read', 'memory.propose'],
        projectKey: paths.projectKey,
      },
    },
    checkpointEvidence: uiMemoryEvidence(checkpointRoot, 'rcc'),
    taskEvidence: filesystemTaskEvidence({ journalPath: preparedJournalPath }),
  });
  const orchestrationPorts = createRccServeOrchestrationPorts({
    port,
    binding,
    prepareAgentProvider,
    promptSegments: {
      review: servePromptSegments(configuration, 'review'),
    },
  });
  const serveRuntime = createServeRuntimeComposition({
    maxRuntimes: configuration.effective.execution?.maxConcurrentTasks,
    eventBusPorts: memoryRuntime.ports,
    feedbackPorts: {
      journal: memoryRuntime.ports.journal,
      publishers: memoryRuntime.ports.publishers,
    },
    feedbackPublisherId: 'serve-orchestration-publisher',
    ...orchestrationPorts,
  });
  const canonicalCheckpointStoreFor = (_taskId: TaskId, _cycleId: CycleId) =>
    new ServiceExecutionCheckpointStore(controlJournalPath, journal, now);
  try {
    const preparation = createTaskExecutionPreparation({
      principalOwner: principal.owner,
      composition: {
        agentRoster: configuration.agentRoster,
        journal,
        filePath: controlJournalPath,
        artifactsRoot: evidenceRoot,
        preparedJournal,
        resourceBoundary: createPreparedOperationBoundary(preparedJournal),
        prepareAgentProvider,
        providerOptions: {},
        providerToolScope: {
          workspaceRoot: paths.workspaceCwd,
          projectKey: paths.projectKey,
          artifactRoot: join(evidenceRoot, 'provider-tools'),
          tools: [...NATIVE_PROVIDER_TOOLS],
          webSearchProviderConfig: resolveWebSearchBackendConfig(),
        },
        now,
        taskIdentity: new TaskIdentityConsumer(new JsonlTaskIdentityJournal(journal)),
        i2Journal: createJsonlI2JournalPort({ filePath: controlJournalPath, journal }),
      },
      coordinator: {
        organId: id('organ', 'humanagent-ui'),
        // Same canonical native checkpoint owner as the UI-runtime index: the
        // public-output checkpoint store commits into the shared control Organ
        // Journal, not a per-task legacy file store.
        checkpointStoreFor: canonicalCheckpointStoreFor,
        // The public-output producer resolves its store from the same factory as
        // checkpoints and the public GET, so a committed delivery lands on the
        // one canonical `task-control.jsonl` instead of a parallel journal.
        publicOutputStoreFor: canonicalCheckpointStoreFor,
        attentionPort: nativeAttentionPort(),
        createTaskAssembly: serveRuntime.createTaskAssembly,
      },
    });
    if (input.taskSelector === undefined) {
      throw new AppLifecycleError(
        'native-control.task-required',
        'the native run entry requires an explicit --task selector',
        'pass --task with the retained task id',
        'humanagent.app.cli',
      );
    }
    const selectedTask = preparation.coordinator.taskSnapshots()
      .find((snapshot) => snapshot.taskId.value === input.taskSelector);
    if (selectedTask === undefined) {
      throw new AppLifecycleError(
        'native-control.task-not-found',
        `no retained task matches --task ${input.taskSelector}`,
        'select a task that already exists in the retained runtime journal',
        'humanagent.app.cli',
      );
    }
    // The actual configured default agent is the typed control selection for
    // this execution. It comes from the loaded roster, never from a dispatch
    // label, task payload or the legacy top-level provider fallback.
    const configuredAgentId = input.configuration.effective.project?.defaultAgent
      ?? input.configuration.agentRoster[0]!.agentId;
    const configuredAgent = input.configuration.agentRoster.find((agent) => agent.agentId === configuredAgentId);
    if (configuredAgent === undefined) {
      throw new AppLifecycleError(
        'native-control.agent-not-found',
        `no configured agent matches the selected default ${configuredAgentId}`,
        'select a defaultAgent that exists in the configured roster',
        'humanagent.app.cli',
      );
    }
    const handle = preparation.prepareRun(selectedTask.taskId, {
      prompt,
      role: configuredAgent.roleId,
      configuredAgentId: configuredAgent.agentId,
    });
    // Subscribe to the exact operation before release. Only the Runtime
    // execution.terminal/final event is a completion candidate; a Provider
    // phase terminal or the release receipt is never completion.
    let unsubscribe: (() => void) | undefined;
    const finalEvent = new Promise<RuntimeTaskEvent>((resolve) => {
      const subscription = preparation.coordinator.subscribeReplay(
        handle.allocation.operationId,
        undefined,
        (event) => {
          if (event.kind === 'execution.terminal' && event.terminalPhase === 'final') resolve(event);
        },
      );
      unsubscribe = subscription.unsubscribe;
      for (const event of subscription.replay) {
        if (event.kind === 'execution.terminal' && event.terminalPhase === 'final') resolve(event);
      }
    });
    let releaseState: string;
    try {
      releaseState = (await handle.release()).state;
    } catch (error) {
      unsubscribe?.();
      throw error;
    }
    const terminal = await finalEvent;
    unsubscribe?.();
    // The event only notifies; the same owner reads the actual Task state back
    // after finalize. The receipt keeps waiting/blocked truth instead of
    // reporting a synthetic success.
    const snapshot = preparation.coordinator.taskSnapshot(handle.allocation.taskId);
    console.log(JSON.stringify({
      command: 'run',
      entry: 'native',
      taskId: snapshot.taskId.value,
      operationId: handle.allocation.operationId.value,
      executionEpoch: snapshot.executionEpoch ?? handle.allocation.executionEpoch,
      release: releaseState,
      state: snapshot.state,
      currentState: snapshot.currentState,
      nextStep: snapshot.nextStep,
      output: snapshot.output,
      checkpoint: snapshot.checkpoint,
      error: snapshot.error,
      terminal: {
        kind: terminal.kind,
        phase: terminal.terminalPhase,
        status: terminal.status,
        summary: terminal.summary,
      },
    }, null, 2));
  } finally {
    // Provider close belongs to the native coordinator; the caller disposes only
    // its own ServeRuntime composition once, after the normal end point.
    await serveRuntime.dispose();
  }
}

export async function main(args: readonly string[]): Promise<void> {
  configureBuiltinPromptRoot();
  const requestedCommand = args[0];
  if (requestedCommand === '--version' || requestedCommand === '-v' || requestedCommand === 'version') {
    console.log(packageVersion());
    return;
  }
  if (helpRequested(args) || requestedCommand === 'help') {
    console.log(helpText());
    return;
  }
  const command = requestedCommand === undefined || requestedCommand.startsWith('-')
    ? 'serve'
    : requestedCommand;
  const workspace = option(args, '--workspace') ?? process.cwd();
  const controlRoot = option(args, '--control-root');
  if (command === 'init' || command === 'doctor') {
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    const config = await loadConfiguration(paths);
    console.log(JSON.stringify({ command, controlRoot: paths.controlRoot, agentCwd: paths.agentCwd, workspaceCwd: paths.workspaceCwd, projectKey: paths.projectKey, agents: config.agentRoster.map((agent) => agent.agentId) }, null, 2));
    return;
  }
  if (command === 'run') {
    const plan = required(option(args, '--plan'), '--plan');
    const prompt = requiredPrompt(option(args, '--prompt'));
    const sessionId = option(args, '--session') ?? 'session-' + Date.now();
    // Resolve the configured agent before the legacy openRuntime/session-task
    // path. An RCC-configured run uses the native task-bound entry and never
    // creates a legacy session, session-derived Task or run-manifest Task; fake
    // and other drivers keep the unchanged legacy path.
    const nativePaths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(nativePaths);
    const nativeConfiguration = await loadConfiguration(nativePaths);
    const nativeAgentId = nativeConfiguration.effective.project?.defaultAgent ?? nativeConfiguration.agentRoster[0]!.agentId;
    const nativeAgent = nativeConfiguration.agentRoster.find((agent) => agent.agentId === nativeAgentId);
    if (nativeAgent?.driverRef === 'rcc') {
      const control = await resolveNativeControlInput(nativePaths, args);
      if (control === undefined) {
        throw new AppLifecycleError(
          'native-control.session-missing',
          'the native rcc run entry requires --control-session-file',
          'pair the control session file with the active serve credential and pass it with --control-session-file',
          'humanagent.app.cli',
        );
      }
      await runNativeTask({
        args,
        paths: nativePaths,
        configuration: nativeConfiguration,
        principal: control.principal,
        taskSelector: control.task,
        prompt,
      });
      return;
    }
    const runtime = await openRuntime({ workspace, controlRoot, plan, sessionId });
    try {
      const configuredAgentId = runtime.configuration.effective.project?.defaultAgent ?? runtime.configuration.agentRoster[0]!.agentId;
      const configuredAgent = runtime.configuration.agentRoster.find((agent) => agent.agentId === configuredAgentId);
      if (configuredAgent?.driverRef === 'rcc') {
        const control = await resolveNativeControlInput(runtime.paths, args);
        requireNativeControlInput(control, undefined);
      }
      const memoryRef = option(args, '--memory');
      const memoryDriverFor = memoryDriverFactory({
        paths: runtime.paths,
        configuration: runtime.configuration,
        workspace: runtime.paths.workspaceCwd,
        inputRefs: [`humanagent://session/${sessionId}/input/1`],
        prepareAgentProvider: taskAgentProviderPreparer(args, runtime.configuration, join(runtime.paths.artifactsRoot, 'provider-evidence')),
      });
      const memory = memoryRef === undefined
        ? undefined
        : await composeTaskMemory({
            paths: runtime.paths,
            configuration: runtime.configuration,
            sessionId,
            bindingRef: memoryRef,
            executionEpoch: 1,
            ...(memoryDriverFor === undefined ? {} : { driverFor: memoryDriverFor }),
          });
      const running = await new SessionStore(runtime.paths).append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
      const runtimeId = `runtime-${sessionId}`;
      const taskId = id('task', sessionId);
      const operationId = id('operation', `runtime-${runtimeId}-epoch-1`);
      const cycleId = id('cycle', `${sessionId}-cycle-1`);
      const composed = configuredAgent?.driverRef === 'fake'
        ? {
            driver: new FakeProviderAgentDriver({
              binding: fakeExecutionBinding(),
              runtimeId,
              taskId,
              operationId,
              executionEpoch: 1,
              assignmentId: `${sessionId}-assignment`,
              scope: {
                organId: id('organ', `agent-${configuredAgent.agentId}`),
                taskId,
                cycleId,
                operationId,
              },
              inputRefs: [`humanagent://session/${sessionId}/input/1`],
              ...(fakeScenario(args) === undefined ? {} : { scenario: fakeScenario(args) }),
              ...(option(args, '--fake-step-delay-ms') === undefined ? {} : { stepDelayMs: Number(option(args, '--fake-step-delay-ms')) }),
            }),
          }
        : undefined;
      const result = await runAgentOperation({
        paths: runtime.paths,
        configuration: runtime.configuration,
        workspace: runtime.paths.workspaceCwd,
        sessionId,
        plan,
        prompt,
        ...(composed === undefined ? {} : { composed }),
        ...(memory === undefined ? {} : { memoryBoundaryPublisher: memory.publisher }),
      });
      const memoryResult = memory === undefined ? undefined : await memory.consume();
      const settled = await settleSessionOutcome(runtime, result.checkpoint.outcome, result.checkpoint.id.value);
      console.log(JSON.stringify({
        command,
        plan,
        sessionId,
        controlCwd: runtime.paths.controlRoot,
        workspaceCwd: runtime.paths.workspaceCwd,
        projectKey: runtime.paths.projectKey,
        state: settled,
        taskId: result.taskId.value,
        operationId: result.operationId.value,
        executionEpoch: result.executionEpoch,
        outcome: result.checkpoint.outcome,
        checkpointId: result.checkpoint.id.value,
        driverRef: result.driverRef,
        semanticEvents: result.semanticEvents,
        observedKinds: result.receipt.observedKinds,
        observedEvents: result.receipt.observedEvents,
        output: result.receipt.output.payload,
        providerClose: result.receipt.providerClose,
        memoryAnalysis: memoryResult?.committed.length ?? 0,
      }, null, 2));
      void running;
    } catch (error) {
      try { await runtime.lock.release(); } catch { /* preserve the execution failure */ }
      throw error;
    }
    return;
  }
  if (command === 'resume') {
    const sessionId = required(option(args, '--session'), '--session');
    const prompt = required(option(args, '--prompt'), '--prompt');
    const runtime = await resumeRuntime({ workspace, controlRoot, sessionId });
    try {
      const manifest = await readRunManifest(runtime.paths, sessionId);
      if (manifest.driverRef === 'rcc') {
        const control = await resolveNativeControlInput(runtime.paths, args);
        requireNativeControlInput(control, manifest.taskId.value);
      }
      const store = new SessionStore(runtime.paths);
      if (runtime.session.state !== 'ready' && runtime.session.state !== 'running') {
        throw new Error(`session cannot resume from state: ${runtime.session.state}`);
      }
      const running = runtime.session.state === 'running'
        ? runtime.session
        : await store.append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
      const memoryRef = option(args, '--memory');
      const memoryDriverFor = memoryDriverFactory({
        paths: runtime.paths,
        configuration: runtime.configuration,
        workspace: runtime.paths.workspaceCwd,
        inputRefs: [`humanagent://session/${sessionId}/input/1`],
        prepareAgentProvider: taskAgentProviderPreparer(args, runtime.configuration, join(runtime.paths.artifactsRoot, 'provider-evidence')),
      });
      const memory = memoryRef === undefined
        ? undefined
        : await composeTaskMemory({
            paths: runtime.paths,
            configuration: runtime.configuration,
            sessionId,
            bindingRef: memoryRef,
            executionEpoch: manifest.executionEpoch,
            ...(memoryDriverFor === undefined ? {} : { driverFor: memoryDriverFor }),
          });
      const recovered = await resumeAgentOperation({
        paths: runtime.paths,
        configuration: runtime.configuration,
        workspace: runtime.paths.workspaceCwd,
        sessionId,
        plan: runtime.session.records[0].plan,
        prompt,
        taskId: manifest.taskId,
        cycleId: manifest.cycleId,
        scope: manifest.scope,
        executionEpoch: manifest.executionEpoch,
        directiveRevision: manifest.directiveRevision,
        agentId: manifest.agentId,
        driverRef: manifest.driverRef,
      });
      let memoryResult: Awaited<ReturnType<NonNullable<typeof memory>['consume']>> | undefined;
      if (memory && recovered.recovered && recovered.execution && recovered.reentry) {
        const failed = await readCommittedCheckpoint({
          filePath: join(runtime.paths.journalRoot, 'checkpoints.jsonl'),
          scope: recovered.recovered.checkpoint.scope,
          checkpointId: recovered.recovered.checkpoint.id,
        });
        const recovery = await readCommittedCheckpoint({
          filePath: join(runtime.paths.journalRoot, 'checkpoints.jsonl'),
          scope: recovered.execution.checkpoint.scope,
          checkpointId: recovered.execution.checkpoint.id,
        });
        await memory.boundaryPublisher.publish({
          checkpoint: recovery.checkpoint,
          recordDigest: recovery.recordDigest,
          trigger: 'rewind',
          relatedCheckpoints: [failed.checkpoint],
          rewind: {
            failedCheckpoint: failed.checkpoint,
            failedCheckpointRecordDigest: failed.recordDigest,
            recoveryCheckpoint: recovery.checkpoint,
            recoveryCheckpointRecordDigest: recovery.recordDigest,
            reentry: recovered.reentry.record,
          },
        });
        memoryResult = await memory.consume();
      }
      let state: string;
      if (!recovered.execution) {
        state = (await store.append(sessionId, { type: 'session.state', state: 'ready' }, runtime.lock)).state;
        await runtime.lock.release();
      } else if (recovered.execution.checkpoint.outcome === 'failed') {
        await store.append(sessionId, {
          type: 'session.failed',
          state: 'failed',
          checkpointRef: recovered.execution.checkpoint.id.value,
          errorCode: 'agent-operation-failed',
          nextAction: 'resume from the failed checkpoint or start a new operation',
        }, runtime.lock);
        state = 'failed';
        await runtime.lock.release();
      } else {
        const closed = await closeRuntime(runtime, recovered.execution.checkpoint.id.value);
        state = closed.state;
      }
      console.log(JSON.stringify({
        command,
        sessionId,
        state,
        recoveredCheckpointId: recovered.recovered?.checkpoint.id.value,
        checkpointId: recovered.execution?.checkpoint.id.value,
        waitingReason: recovered.waitingReason,
        resumedExecutionEpoch: recovered.execution?.executionEpoch,
        resumedOutcome: recovered.execution?.checkpoint.outcome,
        rewindMemoryAnalysis: memoryResult?.committed.length ?? 0,
      }, null, 2));
      void running;
    } catch (error) {
      try { await runtime.lock.release(); } catch { /* preserve the recovery failure */ }
      throw error;
    }
    return;
  }
  if (command === 'session') {
    const action = args[1] ?? 'list';
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    await loadConfiguration(paths);
    const store = new SessionStore(paths);
    if (action === 'list') {
      const sessions = await store.list();
      console.log(JSON.stringify(sessions.map((session) => ({ sessionId: session.sessionId, state: session.state, path: session.path, recoverableTail: session.recoverableTail })), null, 2));
      return;
    }
    if (action === 'inspect') {
      const sessionId = required(option(args, '--session'), '--session');
      console.log(JSON.stringify(await store.open(sessionId), null, 2));
      return;
    }
    throw new Error('usage: humanagent session list|inspect --session <id> --workspace <path>');
  }
  if (command === 'restart') {
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    const lease = await readDaemonLease(paths);
    if (lease === undefined || lease.ownerId !== 'humanagent.app.serve' || lease.disposedAt) {
      throw new AppLifecycleError(
        'daemon-restart.owner-missing',
        'no active serve owner was found for this workspace',
        'start humanagent serve before requesting restart',
        'humanagent.app.serve',
      );
    }
    if (lease.startup === undefined) assertLegacyRestartOptions(args.slice(1));
    const startup = await currentStartupDeclaration(args.slice(1), lease.startup?.args ?? []);
    const completion = await restartDaemonWithCodeHandoff(paths, {
      expected: lease,
      startup,
    });
    console.log(JSON.stringify({ command, ...completion }, null, 2));
    return;
  }
  if (command === 'pair') {
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    const lease = await readDaemonLease(paths);
    if (!lease || lease.ownerId !== 'humanagent.app.serve' || lease.disposedAt) {
      throw new AppLifecycleError(
        'auth.pair.owner-missing',
        'no active serve owner was found for this workspace',
        'start humanagent serve before requesting a pairing code',
        'humanagent.app.serve',
      );
    }
    const endpoint = lease.controlEndpoint;
    if (!endpoint) {
      throw new AppLifecycleError(
        'auth.pair.endpoint-missing',
        'the active serve owner has not published its control endpoint',
        'restart the serve owner once and retry pairing',
        'humanagent.app.serve',
      );
    }
    const token = await deriveSupervisorToken(paths.webAccessCredentialPath, lease.leaseId, lease.generation);
    let response: Response;
    try {
      response = await fetch(controlEndpointUrl(endpoint, '/api/auth/pair/challenge'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ leaseId: lease.leaseId, generation: lease.generation }),
      });
    } catch (error) {
      throw new AppLifecycleError(
        'auth.pair.request-failed',
        `could not reach the active serve owner: ${error instanceof Error ? error.message : String(error)}`,
        'confirm the original serve CLI is still running and retry pairing',
        'humanagent.app.serve',
      );
    }
    const payload = await response.json().catch(() => ({})) as { readonly code?: unknown; readonly expiresAt?: unknown; readonly error?: unknown };
    if (!response.ok) {
      throw new AppLifecycleError(
        'auth.pair.rejected',
        `serve owner rejected pairing (${response.status})`,
        'inspect the original serve CLI output and retry pairing',
        'humanagent.app.serve',
      );
    }
    if (typeof payload.code !== 'string' || typeof payload.expiresAt !== 'string') {
      throw new AppLifecycleError(
        'auth.pair.response-invalid',
        'serve owner returned an invalid pairing challenge',
        'restart the serve owner and retry pairing',
        'humanagent.app.serve',
      );
    }
    console.log(JSON.stringify({ command, code: payload.code, expiresAt: payload.expiresAt }));
    return;
  }
  if (command === 'serve') {
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    const configuration = await loadConfiguration(paths);
    const configuredProvider = configuration.effective.provider ?? DEFAULT_RCC_PROVIDER;
    const resolvedSource = configuredProvider.source ?? 'rcc';
    const selected = resolveServeProvider(args, configuration.effective.provider);
    const mode = selected.provider;
    const protocol = (option(args, '--protocol') ?? configuredProvider.protocol) as UiProviderProtocol;
    if (protocol !== 'responses' && protocol !== 'openai' && protocol !== 'anthropic') {
      throw new Error('serve --protocol must be responses, openai, or anthropic');
    }
    const baseUrl = option(args, '--rcc-base-url') ?? configuredProvider.baseUrl;
    const binding = providerBindingFromOptions(args, configuredProvider, protocol, mode, baseUrl, resolvedSource, selected.providerIdOverride);
    const uiRoot = option(args, '--ui-root') ?? defaultUiRoot();
    const checkpointRoot = join(paths.checkpointsRoot, 'ui-runtime');
    const evidenceRoot = join(paths.artifactsRoot, 'ui-provider-evidence');
    const effectiveLegacyProvider: ProviderConfig = {
      ...configuredProvider,
      source: resolvedSource,
      binding: binding.bindingId,
      provider: binding.providerId === 'rcc' || binding.providerId === 'http'
        ? binding.providerId : configuredProvider.provider,
      protocol,
      model: binding.modelRef,
      route: option(args, '--route') ?? configuredProvider.route,
      baseUrl,
    };
    const prepareSelectedAgentProvider = <
      TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
    >(input: {
      readonly roleId: import('../../config/src/index.js').AgentRole;
      readonly configuredAgentId?: string;
    }) => prepareAgentProvider<TIdentity>({
      ...input,
      agentProviderBindings: configuration.agentProviderBindings,
      legacyProvider: effectiveLegacyProvider,
      legacyBindingOverrides: {
        endpointRef: binding.endpointRef,
        configDigest: binding.configDigest,
        capabilityDigest: binding.capabilityDigest,
      },
      maxTokens: option(args, '--max-tokens') ? Number(option(args, '--max-tokens')) : undefined,
      evidenceRoot,
    });
    const portNumber = option(args, '--port') ? Number(required(option(args, '--port'), '--port')) : 10086;
    let boundPortNumber = portNumber;
    const host = serveHost(option(args, '--host') ?? '127.0.0.1');
    const accessControl = await AccessControlService.open({
      credentialPath: paths.webAccessCredentialPath,
      create: true,
    });
    const memoryRoot = paths.memoryRoot;
    const port = mode === 'rcc'
      ? assembleProviderExecutionPort({
          binding,
          routeRef: option(args, '--route') ?? configuredProvider.route,
          baseUrl,
          source: resolvedSource,
          maxTokens: option(args, '--max-tokens') ? Number(option(args, '--max-tokens')) : undefined,
        }, evidenceRoot)
      : createFakeExecutionPort(
          binding,
          option(args, '--fake-step-delay-ms') ? Number(option(args, '--fake-step-delay-ms')) : undefined,
          fakeScenario(args),
        );
    const memoryDriverFor = memoryDriverFactory({
      paths,
      configuration,
      workspace: paths.workspaceCwd,
      inputRefs: [`humanagent://memory/project/${paths.projectKey}`],
      prepareAgentProvider: prepareSelectedAgentProvider,
    });
    const memoryRuntime = await composeMemoryRuntime({
      paths,
      configuration,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot: join(paths.controlRoot, 'memory-audit'),
      auditPromptRef: configuration.effective.memory?.audit.promptRef ?? 'project-memory-audit',
      autoUpdate: configuration.effective.memory?.update.auto ?? false,
      ...(memoryDriverFor === undefined ? {} : { driverFor: memoryDriverFor }),
      binding: {
        bindingRef: `memory-ui:${paths.projectKey}`,
        projectKey: paths.projectKey,
        executionEpoch: 1,
        scope: {
          namespace: 'project',
          projectKey: paths.projectKey,
          organId: id('organ', 'humanagent-ui'),
        },
        interactionScopeId: `runtime:${paths.projectKey}`,
        mainAgentId: 'humanagent-ui',
        actor: {
          actorId: 'memory-agent',
          roleId: 'memory',
          permissions: ['memory.read', 'memory.propose'],
          projectKey: paths.projectKey,
        },
      },
      checkpointEvidence: uiMemoryEvidence(checkpointRoot, mode),
      taskEvidence: filesystemTaskEvidence({
        journalPath: join(checkpointRoot, mode, 'ui-runtime-journal.jsonl'),
      }),
    });
    const plugins = servePlugins(mode, {
      executionPort: port,
      memory: {
        coordinator: memoryRuntime.composition.coordinator,
        backend: memoryRuntime.composition.backend,
        projectKey: paths.projectKey,
        interaction: memoryRuntime.composition.interaction,
        bindingRef: memoryRuntime.composition.bindingRef,
      },
    });
    if (!serveCompositionManifestMatches(plugins, mode)) {
      throw new AppLifecycleError(
        'serve.composition.manifest-mismatch',
        `serve ${mode} plugin manifests do not match the declared composition contract`,
        'repair the Cordis serve plugin manifests before retrying',
        'humanagent.app.entry-composition',
      );
    }
    const cordisHost = createCordisHost(plugins);
    cordisHost.assertLoadedPlugins(SERVE_COMPOSITION_PLUGINS[mode].map((plugin) => plugin.pluginId));
    const startup = await currentStartupDeclaration(args);
    let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
    let serveRuntime: ServeRuntimeComposition | undefined;
    let supervisor: SupervisorStartup | undefined;
    let restartInFlight: DaemonCodeHandoff | undefined;
    const requestRestart = (input: { readonly leaseId: string; readonly generation: number }) => {
      if (supervisor === undefined) {
        throw new AppLifecycleError(
          'daemon-restart.owner-not-ready',
          'serve owner has not completed startup',
          'wait for the original serve CLI to report ready and retry restart',
          'humanagent.app.serve',
        );
      }
      const activeLease = supervisor.lease.record;
      if (input.leaseId !== activeLease.leaseId || input.generation !== activeLease.generation) {
        throw new AppLifecycleError(
          'daemon-restart.owner-fence',
          'restart request does not match the active serve owner lease',
          'read the current daemon lease and retry from the active serve owner',
          'humanagent.app.serve',
        );
      }
      if (restartInFlight !== undefined) return restartInFlight.receipt;
      if (activeLease.startup === undefined) {
        throw new AppLifecycleError(
          'daemon-restart.startup-missing',
          'the active serve owner did not publish a restart startup declaration',
          'restart through the official CLI with the original serve startup options',
          'humanagent.app.serve',
        );
      }
      const handoff = startDaemonCodeHandoff(paths, {
        expected: activeLease,
        startup: activeLease.startup,
      });
      restartInFlight = handoff;
      const requestId = handoff.receipt.requestId;
      void handoff.completion.catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'restart.failed', ...handoff.receipt, error: cliErrorPayload(error) }, null, 2));
      }).finally(() => {
        if (restartInFlight?.receipt.requestId === requestId) restartInFlight = undefined;
      });
      console.log(JSON.stringify({ event: 'restart.accepted', ...handoff.receipt }, null, 2));
      return handoff.receipt;
    };
    const orchestrationPorts = mode === 'fake'
      ? createDeterministicServeOrchestrationPorts()
      : createRccServeOrchestrationPorts({
            port,
            binding,
            prepareAgentProvider: prepareSelectedAgentProvider,
            promptSegments: {
              review: servePromptSegments(configuration, 'review'),
            },
        });
    supervisor = await runSupervisorStartup(paths, [
      {
        name: 'cordis-host',
        ownerId: 'humanagent.app.cordis-host',
        nextAction: 'repair Cordis host startup before retrying serve',
        start: async () => {
          await cordisHost.start();
          if (!serveCompositionComplete(cordisHost.snapshot(), mode)) {
            throw new AppLifecycleError(
              'serve.composition.incomplete',
              `serve ${mode} composition does not match the declared plugin contract`,
              'repair the Cordis serve plugin composition before retrying',
              'humanagent.app.entry-composition',
            );
          }
        },
        dispose: async () => { await cordisHost.dispose(); },
      },
      {
        name: 'serve-runtime',
        ownerId: 'humanagent.app.serve-runtime',
        nextAction: 'repair the serve runtime composition before retrying',
        start: async () => {
          serveRuntime = createServeRuntimeComposition({
            maxRuntimes: configuration.effective.execution?.maxConcurrentTasks,
            eventBusPorts: memoryRuntime.ports,
            feedbackPorts: {
              journal: memoryRuntime.ports.journal,
              publishers: memoryRuntime.ports.publishers,
            },
            feedbackPublisherId: 'serve-orchestration-publisher',
            ...(orchestrationPorts === undefined ? {} : orchestrationPorts),
          });
        },
        dispose: async () => {
          if (serveRuntime) await serveRuntime.dispose();
        },
      },
      {
        name: 'ui-runtime',
        ownerId: 'humanagent.runtime.ui',
        nextAction: 'repair UI runtime startup before retrying serve',
        start: async () => {
          runtime = await startUiRuntime({
            agentRoster: configuration.agentRoster,
            mode,
            accessControl,
            organId: id('organ', 'humanagent-ui'),
            binding,
            providerSource: resolvedSource,
            port: cordisHost.getExecutionRuntimePort(),
            checkpointRoot,
            interactionRoot: paths.mainRoot,
            evidenceRoot,
            ...(providerRetryConfigFromEffective(configuration) === undefined ? {} : {
              providerRetryConfig: {
                config: providerRetryConfigFromEffective(configuration)!,
                journalRoot: join(paths.journalRoot, 'ui-runtime'),
              },
            }),
            uiRoot,
            // The provider route binding is control-plane configuration: it is
            // resolved here, at the entry that owns configuration, and injected
            // into the runtime assembly instead of being hardcoded there.
            webSearchProviderConfig: resolveWebSearchBackendConfig(),
            ...(process.env.HUMANAGENT_TEMPLATE_ROOT === undefined ? {} : {
              explicitBrainTemplateRoot: process.env.HUMANAGENT_TEMPLATE_ROOT,
            }),
            memory: {
              coordinator: memoryRuntime.composition.coordinator,
              backend: memoryRuntime.composition.backend,
              projectKey: paths.projectKey,
              interaction: memoryRuntime.composition.interaction,
              bindingRef: memoryRuntime.composition.bindingRef,
              roleId: 'review',
              ...composeUiMemoryHooks({
                memory: memoryRuntime,
                checkpointJournalPath: uiRuntimeControlJournalPath(join(checkpointRoot, mode)),
                attentionPort: createJsonlAttentionPort({ paths, filePath: join(paths.journalRoot, 'memory-attention.jsonl') }),
                readAttentions: () => readJsonlAttentions({ filePath: join(paths.journalRoot, 'memory-attention.jsonl') }),
              }),
            },
            runtimeComposition: {
              ...(mode === 'fake' ? {} : {
                prepareAgentProvider: prepareSelectedAgentProvider,
                // The Task-scoped preparer hands the selected execution
                // composition's custody to the prepared-stop owner before the
                // fallible acquisition append. It reuses the same compiled
                // bindings, effective legacy provider and port factory as the
                // neutral preparer; it never re-parses config or substitutes
                // the default Provider.
                prepareTaskAgentProvider: (
                  selection: { readonly roleId: import('../../config/src/index.js').AgentRole; readonly configuredAgentId?: string },
                  owner: import('./ui-runtime/prepared-execution-stop.js').PreparedExecutionStop,
                  lease: import('./ui-runtime/prepared-execution-stop.js').PreparedExecutionStopPreparationLease,
                ) => prepareExecutionAgentProvider({
                  roleId: selection.roleId,
                  ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
                  agentProviderBindings: configuration.agentProviderBindings,
                  legacyProvider: effectiveLegacyProvider,
                  legacyBindingOverrides: {
                    endpointRef: binding.endpointRef,
                    configDigest: binding.configDigest,
                    capabilityDigest: binding.capabilityDigest,
                  },
                  createPort: (selected) => createAgentProviderPort(
                    selected,
                    evidenceRoot,
                    option(args, '--max-tokens') ? Number(option(args, '--max-tokens')) : undefined,
                  ),
                }, owner, lease),
              }),
              ...(orchestrationPorts === undefined ? {} : {
                createTaskAssembly: serveRuntime!.createTaskAssembly,
              }),
            },
            ...(mode === 'fake' ? {} : {
              explicitBrainHelperProviderPreparer: (selection: {
                readonly roleId: import('../../config/src/index.js').AgentRole;
                readonly configuredAgentId?: string;
              }) => prepareSelectedAgentProvider<TasklessProviderExecutionIdentityRef>(selection),
            }),
            host,
            portNumber: boundPortNumber,
            projectKey: paths.projectKey,
            workspaceRoot: paths.workspaceCwd,
            // Project identity comes only from the Config-owned manifest
            // catalog; the read model derives each project/mode journal path
            // from these canonical paths instead of scanning workspaces.
            runtimePaths: paths,
            projectCatalog: () => listConfiguredProjects(paths),
            restart: requestRestart,
            // The scheduled-occurrence patrol may only dispatch under the live
            // supervisor lease. The stage starts before `runSupervisorStartup`
            // returns, so the lease is read lazily at tick time; an unresolved
            // lease fails the patrol closed with a typed reason.
            lease: () => supervisor?.lease,
            identity: () => {
              if (supervisor === undefined) {
                throw new AppLifecycleError(
                  'daemon-identity.owner-not-ready',
                  'serve owner has not completed startup',
                  'wait for the original serve CLI to report ready and retry identity inspection',
                  'humanagent.app.serve',
                );
              }
              const activeLease = supervisor.lease.record;
              return {
                leaseId: activeLease.leaseId,
                generation: activeLease.generation,
                pid: activeLease.pid,
                processStartToken: activeLease.processStartToken,
              };
            },
          });
        },
        dispose: async () => {
          try {
            if (runtime) await runtime.close();
          } finally {
            // Pairing challenges are process-lifetime credentials. A restart
            // or stop must retire them without invalidating persistent
            // browser-session generations.
            accessControl.closeChallengeStore();
          }
        },
      },
    ], {
      lease: {
        ownerId: 'humanagent.app.serve',
        startup,
        takeover: {
          reason: 'new hm serve process takes over the previous daemon',
          stop: {},
        },
      },
    });
    if (!runtime || supervisor === undefined) throw new AppLifecycleError('ui-runtime.startup.missing', 'serve startup completed without a UI runtime', 'repair the serve composition', 'humanagent.app');
    boundPortNumber = runtime.server.port;
    await supervisor.lease.setControlEndpoint(controlEndpointFor(host, runtime.server.port));
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      const previousLease = supervisor!.lease.record;
      void supervisor!.dispose()
        .then((receipt) => {
          if (!receipt.cleanupFailure) return;
          console.error(formatCliError(
            new AppLifecycleError(
              'supervisor-dispose.cleanup-failed',
              receipt.cleanupFailure.message,
              'repair the failed stage disposal before relying on the released daemon lease',
              receipt.cleanupFailure.ownerId,
            ),
            process.argv.slice(2),
          ));
          process.exitCode = 1;
        })
        .catch(async (error: unknown) => {
          // A transition guard alone is not a handoff receipt. Suppress this
          // expected race only after the replacement lease is durable and live.
          if (
            error instanceof AppLifecycleError
            && error.code === 'daemon-lease-transition-in-progress'
            && await waitForDaemonLeaseHandoff(paths, previousLease)
          ) return;
          console.error(formatCliError(error, process.argv.slice(2)));
          process.exitCode = 1;
        });
    };
    const signalProcess = process as unknown as { once(signal: string, listener: () => void): void };
    signalProcess.once('SIGTERM', shutdown);
    signalProcess.once('SIGINT', shutdown);
    console.log(JSON.stringify({
      command,
      provider: mode,
      // Kept for the current UI runtime projection; it is not a user configuration concept.
      mode,
      driverRef: mode,
      url: displayOrigin({ listenAddress: runtime.server.listenAddress, port: runtime.server.port }),
      listenAddress: runtime.server.listenAddress,
      listenPort: runtime.server.port,
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      endpointRef: binding.endpointRef,
      protocol: binding.protocol,
      uiRoot,
      checkpointRoot,
      memoryRoot,
      projectKey: paths.projectKey,
      eventJournal: join(paths.journalRoot, 'events.jsonl'),
      supervisor: {
        leasePath: join(paths.projectRoot, 'daemon', 'lease.json'),
        controlEndpoint: supervisor.lease.record.controlEndpoint,
        readyAt: supervisor.readyAt,
        stages: supervisor.stages,
      },
      plugins: cordisHost.snapshot().pluginIds,
      composition: entryCompositionInventory(cordisHost.snapshot(), mode),
      memoryAnalysisMode: (await memoryRuntime.reviewState()).analysis.mode,
    }, null, 2));
    return;
  }
  throw new AppLifecycleError(
    'cli.command.invalid',
    `unknown command: ${command}`,
    'run humanagent --help to see available commands',
    'humanagent.cli',
  );
}

interface CliErrorPayload {
  readonly code: string;
  readonly ownerId: string;
  readonly nextAction: string;
  readonly message: string;
}

interface NativeControlInput {
  readonly principal: VerifiedProductPrincipal;
  readonly task?: string;
}

function controlSessionError(verification: ProductPrincipalVerification): AppLifecycleError {
  if (verification.state === 'missing') {
    return new AppLifecycleError('native-control.session-missing', '--control-session-file does not contain a paired session cookie', 'pair this control file with the active serve credential', 'humanagent.app.cli');
  }
  if (verification.state === 'expired') {
    return new AppLifecycleError('native-control.session-expired', '--control-session-file contains an expired session', 'pair this control file with the active serve credential again', 'humanagent.app.cli');
  }
  if (verification.state === 'generation-mismatch') {
    return new AppLifecycleError('native-control.session-generation-mismatch', '--control-session-file belongs to a previous credential generation', 'pair this control file with the active serve credential again', 'humanagent.app.cli');
  }
  return new AppLifecycleError('auth.session.invalid', '--control-session-file contains an invalid session', 'pair this control file with the active serve credential again', 'humanagent.app.cli');
}

function formatControlTaskMismatch(manifestTask: string, requestedTask: string): AppLifecycleError {
  return new AppLifecycleError(
    'native-control.task-mismatch',
    `--task requests ${requestedTask} but the recovered session owns task ${manifestTask}`,
    'drop --task or pass the recovered task value',
    'humanagent.app.cli',
  );
}

/**
 * Resolves the typed native control input from the CLI's own control-session
 * file. It reads the cookie-header file, opens the active serve credential
 * read-only and verifies the principal at the real A1 verifier. The result is
 * a verified principal and optional Task selector for the native control seam.
 * It is never written into business payloads, manifests, output or errors.
 * Downstream native admission is not composed at this boundary yet.
 */
async function resolveNativeControlInput(paths: RuntimePaths, args: readonly string[]): Promise<NativeControlInput | undefined> {
  const controlFile = option(args, '--control-session-file');
  if (controlFile === undefined) return undefined;
  const cookieHeader = (await readFile(controlFile, 'utf8')).trim();
  if (!cookieHeader) {
    throw new AppLifecycleError('native-control.session-missing', '--control-session-file is empty', 'provide the paired session cookie in --control-session-file', 'humanagent.app.cli');
  }
  const accessControl = await AccessControlService.open({ credentialPath: paths.webAccessCredentialPath, create: false });
  const verification = await accessControl.verifyProductPrincipal(cookieHeader);
  if (verification.state !== 'valid') throw controlSessionError(verification);
  const task = option(args, '--task');
  return { principal: verification.principal, ...(task === undefined ? {} : { task }) };
}

function requireNativeControlInput(
  control: NativeControlInput | undefined,
  manifestTask: string | undefined,
): void {
  if (control === undefined) return;
  if (control.task !== undefined && manifestTask !== undefined && control.task !== manifestTask) {
    throw formatControlTaskMismatch(manifestTask, control.task);
  }
}

function cliErrorPayload(error: unknown): CliErrorPayload {
  if (error instanceof AppLifecycleError || error instanceof ConfigurationError) {
    return { code: error.code, ownerId: error.ownerId, nextAction: error.nextAction, message: error.message };
  }
  return {
    code: 'host-error',
    ownerId: 'host',
    nextAction: 'inspect the host error and retry after correcting the runtime environment',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function formatCliError(error: unknown, args: readonly string[] = []): string {
  const payload = cliErrorPayload(error);
  if (args.includes('--json')) return JSON.stringify({ error: payload });
  return [
    'HumanAgent 无法完成请求',
    '',
    `原因：${payload.message}`,
    `错误：${payload.code}`,
    `归属：${payload.ownerId}`,
    '',
    `下一步：${payload.nextAction}`,
  ].join('\n');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatCliError(error, process.argv.slice(2)));
    process.exitCode = 1;
  });
}
