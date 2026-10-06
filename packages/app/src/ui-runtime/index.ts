import { join } from 'node:path';
import type {
  Attention,
  CycleId,
  ExecutionRuntimePort,
  OrganId,
  ProviderBinding,
  ProviderReadiness,
  ScopeRef,
  TaskId,
} from '../../../contracts/src/index.js';
import type { AttentionPort } from '../../../runtime/src/control/attention.js';
import type { RetryCycleConfigSet } from '../../../runtime/src/orchestration/index.js';
import {
  AnthropicProviderCodec,
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ResponsesProviderCodec,
  V3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
} from '../../../adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../../adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { SubscriptionControlPort } from '../../../runtime/src/subscriptions/index.js';
import type { WebSearchBackendConfig } from '../../../config/src/index.js';
import { FileCheckpointStore, UiRuntimeJournal } from './journal.js';
import { UiRuntimeApiError } from './errors.js';
import { createFakeExecutionPort } from '../fake-execution.js';
import {
  UiRuntimeService,
  type TaskCheckpointStore,
  type UiRuntimeMemoryComposition,
  type UiRuntimeServiceOptions,
} from './service.js';
import { startUiRuntimeServer, type UiRuntimeServer } from './server.js';
import type { DaemonRestartReceipt } from '../supervisor/restart-client.js';
import { AccessControlService } from './access-control.js';
import {
  createProviderExplicitBrainInterpreter,
  type ExplicitBrainAgentTarget,
  type ExplicitBrainInputInterpreter,
} from '../explicit-brain-runtime.js';
import { AppLifecycleError } from '../errors.js';
import {
  createResponsesFileToolExecutor,
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
} from '../provider-tool-execution.js';

export interface RccModeConfig {
  readonly binding: ProviderBinding;
  readonly routeRef: string;
  readonly baseUrl: string;
  readonly maxTokens?: number;
}

export interface UiRuntimeLaunchOptions {
  readonly mode: 'fake' | 'rcc';
  readonly accessControl?: AccessControlService;
  readonly organId: OrganId;
  readonly binding: ProviderBinding;
  readonly port: ExecutionRuntimePort;
  readonly checkpointRoot: string;
  readonly interactionRoot?: string;
  readonly evidenceRoot: string;
  readonly uiRoot: string;
  readonly providerState?: string;
  readonly host?: string;
  readonly portNumber?: number;
  readonly projectKey?: string;
  readonly workspaceRoot?: string;
  /**
   * Control-plane binding for the external web-search backend. It is injected by
   * the entry that owns configuration, so the runtime assembly never hardcodes a
   * provider route; without it the web.search tool is not wired at all.
   */
  readonly webSearchProviderConfig?: WebSearchBackendConfig;
  readonly providerRetryConfig?: {
    readonly config: RetryCycleConfigSet;
    readonly journalRoot: string;
  };
  readonly explicitBrainAgentQuery?: (input: { readonly agentRef: string; readonly scopeRef: string }) => Promise<unknown>;
  readonly explicitBrainAgentMessage?: (input: {
    readonly recipientRef: string;
    readonly messageRef: string;
    readonly messageClass: 'control' | 'data' | 'observation';
  }) => Promise<unknown>;
  readonly explicitBrainAgentTargets?: readonly ExplicitBrainAgentTarget[];
  readonly explicitBrainInterpreter?: ExplicitBrainInputInterpreter;
  readonly explicitBrainTemplateRoot?: string;
  readonly memory: UiRuntimeMemoryComposition;
  readonly runtimeComposition?: UiRuntimeServiceOptions['runtimeComposition'];
  readonly restart?: (input: {
    readonly leaseId: string;
    readonly generation: number;
  }) => DaemonRestartReceipt;
  readonly identity?: () => {
    readonly leaseId: string;
    readonly generation: number;
    readonly pid: number;
    readonly processStartToken: string;
  };
}

function providerStateFromReadiness(readiness: ProviderReadiness): string {
  return readiness.state;
}

function providerErrorFromReadiness(readiness: ProviderReadiness): {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextAction: string;
} | undefined {
  if (readiness.state === 'ready') return undefined;
  const failure = readiness.failure;
  if (failure) {
    return {
      code: failure.code,
      ownerId: failure.ownerId,
      message: failure.message,
      retryable: failure.retryable === 'retryable',
      nextAction: failure.nextAction
        ? `${failure.nextAction.kind}${failure.nextAction.ref ? `:${failure.nextAction.ref}` : ''}`
        : 'inspect provider readiness',
    };
  }
  return {
    code: `provider.readiness.${readiness.state}`,
    ownerId: readiness.ownerId ?? 'humanagent.provider-adapter',
    message: `provider readiness is ${readiness.state}`,
    retryable: readiness.state === 'degraded' || readiness.state === 'unknown',
    nextAction: readiness.nextAction
      ? `${readiness.nextAction.kind}${readiness.nextAction.ref ? `:${readiness.nextAction.ref}` : ''}`
      : 'inspect provider readiness',
  };
}

/**
 * Upper bound on provider tool rounds per execution. A real long-horizon task
 * legitimately inspects, writes and verifies, so the bound must leave room for
 * that while still terminating a runaway round loop.
 */
const PROVIDER_TOOL_ROUND_LIMIT = 32;

export function buildRccExecutionPort(config: RccModeConfig, evidenceRoot: string): ExecutionRuntimePort {
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot));
  const transport = new V3ProviderHttpTransport({ binding: config.binding, baseUrl: config.baseUrl, evidence });
  const codec = config.binding.protocol === 'anthropic'
    ? new AnthropicProviderCodec(config.maxTokens ?? 4096)
    : config.binding.protocol === 'openai'
      ? new OpenAIChatProviderCodec()
      : new ResponsesProviderCodec();
  return new ProviderAdapter({ binding: config.binding, routeRef: config.routeRef, codec, transport, evidence });
}

export function buildFakeExecutionPort(binding: ProviderBinding, stepDelayMs?: number): ExecutionRuntimePort {
  return createFakeExecutionPort(binding, stepDelayMs);
}

class InMemoryAttentionPort implements AttentionPort {
  readonly published: Attention[] = [];
  readonly resolved: Attention[] = [];

  async publish(input: Attention): Promise<{ readonly attentionId: string; readonly delivered: true }> {
    this.published.push(structuredClone(input));
    return { attentionId: input.attentionId, delivered: true };
  }

  async resolve(input: Attention): Promise<{ readonly attentionId: string; readonly delivered: true }> {
    this.resolved.push(structuredClone(input));
    return { attentionId: input.attentionId, delivered: true };
  }
}

export interface UiRuntime {
  readonly service: UiRuntimeService;
  readonly server: UiRuntimeServer;
  close(): Promise<void>;
}

export async function startUiRuntime(options: UiRuntimeLaunchOptions): Promise<UiRuntime> {
  if (!options.accessControl) {
    throw new AppLifecycleError(
      'ui-runtime.access-control.missing',
      'UI runtime startup requires an access-control service',
      'initialize web access control before starting the UI runtime',
      'humanagent.app.ui-runtime',
    );
  }
  const explicitBrainInterpreter = options.explicitBrainInterpreter ?? (() => {
    const templateRoot = options.explicitBrainTemplateRoot?.trim();
    if (!templateRoot) {
      throw new AppLifecycleError(
        'explicit-brain-prompt-unavailable',
        'builtin interaction prompt root is not configured',
        'configure the locked builtin template root before starting the UI runtime',
        'humanagent.app.ui-runtime',
      );
    }
    return createProviderExplicitBrainInterpreter({
      port: options.port,
      binding: options.binding,
      templateRoot,
    });
  })();
  const readiness = options.mode === 'rcc' ? await options.port.probe(options.binding) : undefined;
  const providerState = readiness ? providerStateFromReadiness(readiness) : options.providerState ?? 'ready';
  const providerError = readiness ? providerErrorFromReadiness(readiness) : undefined;
  const attentionPort = new InMemoryAttentionPort();
  const modeRoot = join(options.checkpointRoot, options.mode);
  const journal = new UiRuntimeJournal(join(modeRoot, 'ui-runtime-journal.jsonl'));
  const subscriptionJournalPath = join(modeRoot, 'subscriptions.jsonl');
  const subscriptionControl = new SubscriptionControlPort(
    new JsonlOrganJournal(subscriptionJournalPath),
    { organId: options.organId },
    subscriptionJournalPath,
  );
  const interactionJournal = options.interactionRoot
    ? new UiRuntimeJournal(join(options.interactionRoot, 'sessions', 'explicit-brain.jsonl'))
    : undefined;
  const checkpointStoreFor = (taskId: TaskId, cycleId: CycleId): TaskCheckpointStore => new FileCheckpointStore(join(modeRoot, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`));
  const providerToolExecutor = options.mode === 'rcc'
    && options.binding.protocol === 'responses'
    && options.workspaceRoot !== undefined
    && options.projectKey !== undefined
    ? (() => {
        const built = createResponsesFileToolExecutor({
          workspaceRoot: options.workspaceRoot,
          projectKey: options.projectKey,
          artifactRoot: join(options.evidenceRoot, 'provider-tools'),
          ...(options.webSearchProviderConfig === undefined ? {} : { webSearchProviderConfig: options.webSearchProviderConfig }),
        });
        return { executor: built.executor, toolOutputs: built.toolOutputs };
      })()
    : undefined;
  const service = new UiRuntimeService({
    mode: options.mode,
    organId: options.organId,
    binding: options.binding,
    port: options.port,
    checkpointStoreFor,
    attentionPort,
    providerState,
    providerError,
    journal,
    closurePort: interactionJournal ?? journal,
    ...(options.projectKey ? { projectKey: options.projectKey } : {}),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.providerRetryConfig === undefined ? {} : { providerRetryConfig: options.providerRetryConfig }),
    ...(providerToolExecutor === undefined ? {} : {
      providerTools: [
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
      ],
      providerToolExecutor: providerToolExecutor.executor,
      toolOutputStore: providerToolExecutor.toolOutputs,
      providerToolRoundLimit: PROVIDER_TOOL_ROUND_LIMIT,
    }),
    ...(options.explicitBrainAgentQuery === undefined ? {} : { explicitBrainAgentQuery: options.explicitBrainAgentQuery }),
    ...(options.explicitBrainAgentMessage === undefined ? {} : { explicitBrainAgentMessage: options.explicitBrainAgentMessage }),
    ...(options.explicitBrainAgentTargets === undefined ? {} : { explicitBrainAgentTargets: options.explicitBrainAgentTargets }),
    explicitBrainInterpreter,
    ...(interactionJournal === undefined ? {} : { interactionJournal }),
    memory: options.memory,
    subscriptionControl,
    ...(options.runtimeComposition === undefined ? {} : { runtimeComposition: options.runtimeComposition }),
  });
  await service.hydrate();
  service.startImplicitConsumer();
  const server = await startUiRuntimeServer({
    service,
    accessControl: options.accessControl,
    uiRoot: options.uiRoot,
    host: options.host,
    port: options.portNumber,
    ...(options.restart === undefined ? {} : { restart: options.restart }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  });
  return {
    service,
    server,
    async close() {
      await service.quiesceImplicitConsumption();
      let serverCloseFailure: unknown;
      try {
        await server.close();
      } catch (error) {
        serverCloseFailure = error;
      }
      const active = service.listTasks().running.filter((task) => task.requirementAdmission !== 'queued');
      const stopped = await Promise.allSettled(
        active.map(async (task) => {
          try {
            await service.stop(task.taskId);
          } catch (error) {
            const stillActive = service.listTasks().running.some(
              (candidate) => candidate.taskId.value === task.taskId.value && candidate.requirementAdmission !== 'queued',
            );
            // A task can settle between the running snapshot and stop admission.
            // That is a completed stop, not a shutdown failure; all other stop
            // errors remain explicit.
            if (error instanceof UiRuntimeApiError && error.code === 'task.not.running' && !stillActive) return;
            throw error;
          }
        }),
      );
      const failures: unknown[] = [];
      if (serverCloseFailure !== undefined) failures.push(serverCloseFailure);
      for (const result of stopped) {
        if (result.status === 'rejected') failures.push(result.reason);
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'UI runtime close failed while settling active executions');
      }
    },
  };
}

export { UiRuntimeApiError } from './errors.js';
export { MemoryBoundExecutionDriver, MemoryContextCapture, UiRuntimeService } from './service.js';
export type { TaskCheckpointStore, UiRuntimeMemoryComposition } from './service.js';
export { FileCheckpointStore, UiRuntimeJournal } from './journal.js';
export { FakeReplayExecutionRuntimePort } from './fake-port.js';
export type { UiRuntimeServer } from './server.js';
