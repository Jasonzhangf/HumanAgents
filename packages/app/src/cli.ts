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
import { buildFakeExecutionPort, buildRccExecutionPort, startUiRuntime } from './ui-runtime/index.js';
import { FakeProviderAgentDriver, fakeExecutionBinding } from './fake-execution.js';
import {
  entryCompositionInventory,
  FAKE_SERVE_PROVIDER_PLUGIN,
  RCC_SERVE_PROVIDER_PLUGIN,
  SERVE_COMPOSITION_PLUGINS,
  serveCompositionComplete,
  serveCompositionManifestMatches,
} from './entry-composition.js';
import { createCordisHost } from './cordis-host.js';
import { runSupervisorStartup } from './supervisor/supervisor.js';
import { join } from 'node:path';

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

function loopbackHost(value: string): string {
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

async function composeTaskMemory(input: {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly sessionId: string;
  readonly bindingRef: string;
  readonly executionEpoch: number;
  readonly driverFor?: (input: {
    readonly taskId: import('../../contracts/src/index.js').TaskId;
    readonly operationId: import('../../contracts/src/index.js').OperationId;
    readonly executionEpoch: number;
    readonly assignmentId: string;
  }) => import('../../contracts/src/index.js').AgentDriver;
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
        kind: 'task',
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

/**
 * Provider-backed memory analysis must use an explicitly configured
 * `roleId === 'memory'` agent, never the main operation driver. A fresh driver
 * is composed for each admitted memory operation so its runtime/operation
 * identity cannot leak into the main task execution.
 */
export function memoryDriverFactory(input: {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly workspace: string;
}): ((request: {
  readonly taskId: import('../../contracts/src/index.js').TaskId;
  readonly operationId: import('../../contracts/src/index.js').OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
}) => import('../../contracts/src/index.js').AgentDriver) | undefined {
  const memoryAgent = input.configuration.agentRoster.find((agent) => agent.roleId === 'memory');
  if (memoryAgent === undefined) return undefined;
  return ({ assignmentId }) => {
    const composed = composeAgentDriver({
      agent: memoryAgent,
      paths: input.paths,
      ...(input.configuration.effective.execution?.dsh === undefined
        ? {}
        : { dsh: input.configuration.effective.execution.dsh }),
      runtimeId: assignmentId,
      workspace: input.workspace,
    });
    return composed.driver;
  };
}

type UiProviderProtocol = 'responses' | 'openai' | 'anthropic';

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

function providerBindingFromOptions(
  args: readonly string[],
  protocol: UiProviderProtocol,
  mode: 'fake' | 'rcc',
): ProviderBinding & { readonly protocol: UiProviderProtocol } {
  const fake = mode === 'fake';
  return {
    bindingId: fake ? (option(args, '--binding') ?? 'fake-default') : required(option(args, '--binding'), '--binding'),
    providerId: fake ? (option(args, '--provider') ?? 'fake-provider') : required(option(args, '--provider'), '--provider'),
    protocol,
    endpointRef: option(args, '--endpoint') ?? (fake ? 'fake:replay' : 'rcc-v3:127.0.0.1:4444'),
    modelRef: fake ? (option(args, '--model') ?? 'fake.model') : required(option(args, '--model'), '--model'),
    configDigest: option(args, '--config-digest') ?? (fake ? 'sha256:fake-ui-config' : 'sha256:ui-runtime-config'),
    capabilityDigest: option(args, '--capability-digest') ?? (fake ? 'sha256:fake-ui-capability' : 'sha256:ui-runtime-capability'),
  };
}

export async function main(args: readonly string[]): Promise<void> {
  configureBuiltinPromptRoot();
  const command = args[0] ?? 'help';
  const workspace = option(args, '--workspace') ?? process.cwd();
  const controlRoot = option(args, '--control-root');
  if (command === '--version' || command === 'version') {
    console.log('0.1.0');
    return;
  }
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
      if (memory && recovered.recovered && recovered.execution) {
        const committed = await readCommittedCheckpoint({
          filePath: join(runtime.paths.journalRoot, 'checkpoints.jsonl'),
          scope: recovered.recovered.checkpoint.scope,
          checkpointId: recovered.recovered.checkpoint.id,
        });
        await memory.boundaryPublisher.publish({
          checkpoint: committed.checkpoint,
          recordDigest: committed.recordDigest,
          trigger: 'rewind',
          relatedCheckpoints: [recovered.execution.checkpoint],
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
  if (command === 'serve') {
    const mode = option(args, '--mode');
    if (mode === undefined) {
      throw new AppLifecycleError('execution.mode.required', 'serve requires an explicit --mode', 'choose --mode fake or --mode rcc', 'humanagent.app');
    }
    if (mode !== 'fake' && mode !== 'rcc') {
      throw new Error('serve --mode must be fake or rcc (dsh is not open in this phase)');
    }
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    const configuration = await loadConfiguration(paths);
    const protocol = (option(args, '--protocol') ?? 'responses') as UiProviderProtocol;
    if (protocol !== 'responses' && protocol !== 'openai' && protocol !== 'anthropic') {
      throw new Error('serve --protocol must be responses, openai, or anthropic');
    }
    const binding = providerBindingFromOptions(args, protocol, mode);
    const uiRoot = option(args, '--ui-root') ?? join(process.cwd(), 'docs', 'ui');
    const checkpointRoot = join(paths.checkpointsRoot, 'ui-runtime');
    const evidenceRoot = join(paths.artifactsRoot, 'ui-provider-evidence');
    const portNumber = option(args, '--port') ? Number(required(option(args, '--port'), '--port')) : 0;
    const memoryRoot = paths.memoryRoot;
    const memoryRuntime = await composeMemoryRuntime({
      paths,
      configuration,
      workspaceCwd: paths.workspaceCwd,
      sessionsRoot: paths.sessionsRoot,
      runNotesRoot: paths.runNotesRoot,
      auditPromptRoot: join(paths.controlRoot, 'memory-audit'),
      auditPromptRef: configuration.effective.memory?.audit.promptRef ?? 'project-memory-audit',
      autoUpdate: false,
      binding: {
        bindingRef: `memory-ui:${paths.projectKey}`,
        projectKey: paths.projectKey,
        executionEpoch: 1,
        scope: { kind: 'organ', organId: id('organ', 'humanagent-ui') },
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
    const port = mode === 'rcc'
      ? buildRccExecutionPort({
          binding,
          routeRef: required(option(args, '--route'), '--route'),
          baseUrl: option(args, '--rcc-base-url') ?? 'http://127.0.0.1:4444',
          maxTokens: option(args, '--max-tokens') ? Number(option(args, '--max-tokens')) : undefined,
        }, evidenceRoot)
      : buildFakeExecutionPort(binding, option(args, '--fake-step-delay-ms') ? Number(option(args, '--fake-step-delay-ms')) : undefined);
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
    const supervisor = await runSupervisorStartup(paths, [
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
            evidenceRoot,
            uiRoot,
            memory: {
              coordinator: memoryRuntime.composition.coordinator,
              backend: memoryRuntime.composition.backend,
              projectKey: paths.projectKey,
              interaction: memoryRuntime.composition.interaction,
              bindingRef: memoryRuntime.composition.bindingRef,
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
                  await memoryRuntime.boundaryPublisher.publish({ checkpoint, recordDigest, trigger });
                  await memoryRuntime.consume();
                },
              },
            },
            host: loopbackHost(option(args, '--host') ?? '127.0.0.1'),
            portNumber,
          });
        },
        dispose: async () => {
          if (runtime) await runtime.server.close();
        },
      },
    ], { lease: { ownerId: 'humanagent.app.serve' } });
    if (!runtime) throw new AppLifecycleError('ui-runtime.startup.missing', 'serve startup completed without a UI runtime', 'repair the serve composition', 'humanagent.app');
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void supervisor.dispose().catch((error: unknown) => {
        console.error(formatCliError(error));
        process.exitCode = 1;
      });
    };
    const signalProcess = process as unknown as { once(signal: string, listener: () => void): void };
    signalProcess.once('SIGTERM', shutdown);
    signalProcess.once('SIGINT', shutdown);
    console.log(JSON.stringify({
      command,
      mode,
      url: runtime.server.url,
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      uiRoot,
      checkpointRoot,
      memoryRoot,
      eventJournal: join(paths.journalRoot, 'events.jsonl'),
      supervisor: {
        leasePath: join(paths.projectRoot, 'daemon', 'lease.json'),
        readyAt: supervisor.readyAt,
        stages: supervisor.stages,
      },
      plugins: cordisHost.snapshot().pluginIds,
      composition: entryCompositionInventory(cordisHost.snapshot(), mode),
    }, null, 2));
    return;
  }
  throw new Error('usage: humanagent init|doctor|run|resume|session|serve --workspace <path> [--plan <name>] [--session <id>]');
}

export function formatCliError(error: unknown): string {
  if (error instanceof AppLifecycleError || error instanceof ConfigurationError) {
    return JSON.stringify({ error: { code: error.code, ownerId: error.ownerId, nextAction: error.nextAction, message: error.message } });
  }
  return JSON.stringify({
    error: {
      code: 'host-error',
      ownerId: 'host',
      nextAction: 'inspect the host error and retry after correcting the runtime environment',
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
}
