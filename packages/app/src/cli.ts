#!/usr/bin/env node
import {
  ConfigurationError,
  ensureControlLayout,
  loadConfiguration,
  resolveRuntimePaths,
  type LoadedConfiguration,
  type RuntimePaths,
} from '../../config/src/index.js';
import {
  id,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type HarnessPlugin,
  type ProviderBinding,
} from '../../contracts/src/index.js';
import { AppLifecycleError } from './errors.js';
import {
  closeRuntime,
  composeAgentDriver,
  composeMemoryRuntime,
  configureBuiltinPromptRoot,
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
import { buildRccExecutionPort, startUiRuntime } from './ui-runtime/index.js';
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
import { runSupervisorStartup, waitForDaemonLeaseHandoff, type SupervisorStartup } from './supervisor/supervisor.js';
import { requestDaemonRestart } from './supervisor/restart-client.js';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServeRuntimeComposition, type ServeRuntimeComposition } from './serve-runtime.js';
import { createDeterministicServeOrchestrationPorts, createRccServeOrchestrationPorts } from './serve-orchestration.js';
import type { ProviderConfig } from '../../config/src/index.js';

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
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

function loopbackHost(value: string): '127.0.0.1' | '::1' {
  if (value !== '127.0.0.1' && value !== '::1') {
    throw new Error('serve --host must be a loopback address (127.0.0.1 or ::1) until the control API has authentication');
  }
  return value;
}

function memoryTrigger(outcome: Checkpoint['outcome']): 'completion' | 'blocked' | 'rewind' | null {
  if (outcome === 'succeeded') return 'completion';
  if (outcome === 'failed' || outcome === 'waiting' || outcome === 'blocked' || outcome === 'unknown') return 'blocked';
  return null;
}

function uiMemoryEvidence(checkpointRoot: string, mode: 'fake' | 'rcc') {
  const filePathFor = (scope: Checkpoint['scope']) => join(
    checkpointRoot,
    mode,
    `task-${scope.taskId!.value}-cycle-${scope.cycleId!.value}.jsonl`,
  );
  return {
    async readCommitted({ checkpoint }: { readonly checkpoint: Checkpoint }) {
      return readCommittedCheckpoint({
        filePath: filePathFor(checkpoint.scope),
        scope: checkpoint.scope,
        checkpointId: checkpoint.id,
      });
    },
    async readEvidence({ evidence }: { readonly evidence: EvidenceRef }) {
      return readCheckpointEvidence({
        filePath: filePathFor(evidence.scope),
        scope: evidence.scope,
        evidence,
      });
    },
  };
}

/** Admitted memory operation identity passed to the memory-role driver factory. */
interface MemoryDriverRequest {
  readonly taskId: import('../../contracts/src/index.js').TaskId;
  readonly operationId: import('../../contracts/src/index.js').OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly scope: import('../../contracts/src/index.js').CanonicalMemoryScope;
}

async function composeTaskMemory(input: {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly sessionId: string;
  readonly bindingRef: string;
  readonly executionEpoch: number;
  readonly driverFor?: (request: MemoryDriverRequest) => import('../../contracts/src/index.js').AgentDriver;
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
 * `rcc` is the one driver whose execution identity must come from the admitted
 * memory operation: the serve RCC port and provider binding are supplied by the
 * caller, while task/operation/assignment identity is bound per request.
 */
export function memoryDriverFactory(input: {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly workspace: string;
  readonly rcc?: ServeRccDriverBinding;
}): ((request: MemoryDriverRequest) => import('../../contracts/src/index.js').AgentDriver) | undefined {
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
    const rcc = input.rcc === undefined
      ? undefined
      : {
          port: input.rcc.port,
          binding: input.rcc.binding,
          scope: {
            organId: scope.organId,
            taskId,
            operationId,
          },
          taskId,
          operationId,
          executionEpoch,
          assignmentId,
          inputRefs: input.rcc.inputRefs,
        };
    const composed = composeAgentDriver({
      agent: memoryAgent,
      paths: input.paths,
      ...(input.configuration.effective.execution?.dsh === undefined
        ? {}
        : { dsh: input.configuration.effective.execution.dsh }),
      ...(rcc === undefined ? {} : { rcc }),
      runtimeId: assignmentId,
      workspace: input.workspace,
    });
    return composed.driver;
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
  if (requested !== undefined) {
    throw new AppLifecycleError(
      'provider.invalid',
      `unknown provider: ${requested}`,
      'choose a configured provider such as rcc, or use fake only for internal tests',
      'humanagent.config',
    );
  }
  return { provider: configured?.provider ?? 'rcc' };
}

function providerBindingFromOptions(
  args: readonly string[],
  configured: ProviderConfig | undefined,
  protocol: UiProviderProtocol,
  provider: ServeProvider,
  baseUrl: string,
  providerIdOverride?: string,
): ProviderBinding & { readonly protocol: UiProviderProtocol } {
  const fake = provider === 'fake';
  const defaults = configured ?? DEFAULT_RCC_PROVIDER;
  return {
    bindingId: option(args, '--binding') ?? (fake ? 'fake-default' : defaults.binding),
    providerId: providerIdOverride ?? (fake ? 'fake-provider' : defaults.provider),
    protocol,
    endpointRef: option(args, '--endpoint') ?? (fake ? 'fake:replay' : `rcc-v3:${baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}`),
    modelRef: option(args, '--model') ?? (fake ? 'fake.model' : defaults.model),
    configDigest: option(args, '--config-digest') ?? (fake ? 'sha256:fake-ui-config' : 'sha256:ui-runtime-config'),
    capabilityDigest: option(args, '--capability-digest') ?? (fake ? 'sha256:fake-ui-capability' : 'sha256:ui-runtime-capability'),
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
    '  humanagent restart       请求原 serve owner 重启；当前 CLI 只观察，不接管显示',
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

export async function main(args: readonly string[]): Promise<void> {
  configureBuiltinPromptRoot();
  const requestedCommand = args[0];
  if (requestedCommand === '--version' || requestedCommand === '-v' || requestedCommand === 'version') {
    console.log(packageVersion());
    return;
  }
  if (requestedCommand === '--help' || requestedCommand === '-h' || requestedCommand === 'help') {
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
    const runtime = await openRuntime({ workspace, controlRoot, plan, sessionId });
    try {
      const memoryRef = option(args, '--memory');
      const memoryDriverFor = memoryDriverFactory({
        paths: runtime.paths,
        configuration: runtime.configuration,
        workspace: runtime.paths.workspaceCwd,
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
      const configuredAgentId = runtime.configuration.effective.project?.defaultAgent ?? runtime.configuration.agentRoster[0]!.agentId;
      const configuredAgent = runtime.configuration.agentRoster.find((agent) => agent.agentId === configuredAgentId);
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
    const receipt = await requestDaemonRestart(paths);
    console.log(JSON.stringify({ command, ...receipt }, null, 2));
    return;
  }
  if (command === 'serve') {
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    const configuration = await loadConfiguration(paths);
    const configuredProvider = configuration.effective.provider ?? DEFAULT_RCC_PROVIDER;
    const selected = resolveServeProvider(args, configuration.effective.provider);
    const mode = selected.provider;
    const protocol = (option(args, '--protocol') ?? configuredProvider.protocol) as UiProviderProtocol;
    if (protocol !== 'responses' && protocol !== 'openai' && protocol !== 'anthropic') {
      throw new Error('serve --protocol must be responses, openai, or anthropic');
    }
    const baseUrl = option(args, '--rcc-base-url') ?? configuredProvider.baseUrl;
    const binding = providerBindingFromOptions(args, configuredProvider, protocol, mode, baseUrl, selected.providerIdOverride);
    const uiRoot = option(args, '--ui-root') ?? defaultUiRoot();
    const checkpointRoot = join(paths.checkpointsRoot, 'ui-runtime');
    const evidenceRoot = join(paths.artifactsRoot, 'ui-provider-evidence');
    const portNumber = option(args, '--port') ? Number(required(option(args, '--port'), '--port')) : 10086;
    let boundPortNumber = portNumber;
    const host = loopbackHost(option(args, '--host') ?? '127.0.0.1');
    const memoryRoot = paths.memoryRoot;
    const port = mode === 'rcc'
      ? buildRccExecutionPort({
          binding,
          routeRef: option(args, '--route') ?? configuredProvider.route,
          baseUrl,
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
      rcc: {
        // A memory-role rcc agent must use its own provider transport even when
        // the serve UI runs the fake provider for the main execution path.
        port: mode === 'rcc'
          ? port
          : buildRccExecutionPort({
              binding: providerBindingFromOptions(args, configuredProvider, protocol, 'rcc', baseUrl, selected.providerIdOverride),
              routeRef: option(args, '--route') ?? configuredProvider.route,
              baseUrl,
              maxTokens: option(args, '--max-tokens') ? Number(option(args, '--max-tokens')) : undefined,
            }, evidenceRoot),
        binding,
        inputRefs: [`humanagent://memory/project/${paths.projectKey}`],
      },
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
    let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
    let serveRuntime: ServeRuntimeComposition | undefined;
    let supervisor: SupervisorStartup | undefined;
    let restartInFlight: { readonly requestId: string; readonly receipt: {
      readonly requestId: string;
      readonly acceptedAt: string;
      readonly ownerId: 'humanagent.app.serve';
      readonly leaseId: string;
      readonly generation: number;
      readonly observerOnly: true;
    }; readonly operation: Promise<void> } | undefined;
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
      const requestId = randomUUID();
      const receipt = {
        requestId,
        acceptedAt: new Date().toISOString(),
        ownerId: 'humanagent.app.serve' as const,
        leaseId: activeLease.leaseId,
        generation: activeLease.generation,
        observerOnly: true as const,
      };
      const operation = new Promise<void>((resolve) => {
        setTimeout(() => {
          void (async () => {
            console.log(JSON.stringify({ event: 'restart.stopping', ...receipt }, null, 2));
            try {
              const restarted = await supervisor!.restart();
              if (!runtime) throw new AppLifecycleError('daemon-restart.runtime-missing', 'serve restart completed without a UI runtime', 'inspect the original serve CLI startup failure', 'humanagent.app.serve');
              await supervisor!.lease.setControlEndpoint({ host, port: runtime.server.port });
              console.log(JSON.stringify({ event: 'restart.ready', ...receipt, readyAt: restarted.readyAt, url: runtime.server.url }, null, 2));
            } catch (error) {
              console.error(JSON.stringify({ event: 'restart.failed', ...receipt, error: cliErrorPayload(error) }, null, 2));
            } finally {
              resolve();
            }
          })();
        }, 0);
      });
      restartInFlight = { requestId, receipt, operation };
      void operation.finally(() => {
        if (restartInFlight?.requestId === requestId) restartInFlight = undefined;
      });
      console.log(JSON.stringify({ event: 'restart.accepted', ...receipt }, null, 2));
      return receipt;
    };
    const orchestrationPorts = mode === 'fake'
      ? createDeterministicServeOrchestrationPorts()
      : createRccServeOrchestrationPorts({
            port,
            binding,
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
            mode,
            organId: id('organ', 'humanagent-ui'),
            binding,
            port: cordisHost.getExecutionRuntimePort(),
            checkpointRoot,
            interactionRoot: paths.mainRoot,
            evidenceRoot,
            uiRoot,
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
              reviewState: memoryRuntime.reviewState,
              checkpointBoundary: {
                publish: async ({ checkpoint, recordDigest }) => {
                  const trigger = memoryTrigger(checkpoint.outcome);
                  if (!trigger) return;
                  if (!recordDigest) {
                    throw new AppLifecycleError(
                      'memory-boundary-digest-missing',
                      `checkpoint ${checkpoint.id.value} is committed without a journal record digest`,
                      'recover the committed checkpoint record before publishing the memory boundary',
                      'humanagent.cli',
                    );
                  }
                  if (checkpoint.scope.taskId !== undefined) {
                    await memoryRuntime.boundaryPublisher.publishTask({ checkpoint, recordDigest, trigger });
                  } else {
                    await memoryRuntime.boundaryPublisher.publish({ checkpoint, recordDigest, trigger });
                  }
                  await memoryRuntime.consume();
                },
              },
            },
            runtimeComposition: {
              ...(orchestrationPorts === undefined ? {} : {
                createTaskAssembly: serveRuntime!.createTaskAssembly,
              }),
            },
            host,
            portNumber: boundPortNumber,
            projectKey: paths.projectKey,
            workspaceRoot: paths.workspaceCwd,
            restart: requestRestart,
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
          if (runtime) await runtime.server.close();
        },
      },
    ], {
      lease: {
        ownerId: 'humanagent.app.serve',
        takeover: {
          reason: 'new hm serve process takes over the previous daemon',
          stop: {},
        },
      },
    });
    if (!runtime || supervisor === undefined) throw new AppLifecycleError('ui-runtime.startup.missing', 'serve startup completed without a UI runtime', 'repair the serve composition', 'humanagent.app');
    boundPortNumber = runtime.server.port;
    await supervisor.lease.setControlEndpoint({ host, port: runtime.server.port });
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      const previousLease = supervisor!.lease.record;
      void supervisor!.dispose().catch(async (error: unknown) => {
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
      url: runtime.server.url,
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
