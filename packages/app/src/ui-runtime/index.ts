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
import {
  AnthropicProviderCodec,
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ResponsesProviderCodec,
  V3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
} from '../../../adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../../adapters/filesystem/src/index.js';
import { FileCheckpointStore, UiRuntimeJournal } from './journal.js';
import { createFakeExecutionPort } from '../fake-execution.js';
import {
  UiRuntimeService,
  type TaskCheckpointStore,
  type UiRuntimeMemoryComposition,
} from './service.js';
import { startUiRuntimeServer, type UiRuntimeServer } from './server.js';

export interface RccModeConfig {
  readonly binding: ProviderBinding;
  readonly routeRef: string;
  readonly baseUrl: string;
  readonly maxTokens?: number;
}

export interface UiRuntimeLaunchOptions {
  readonly mode: 'fake' | 'rcc';
  readonly organId: OrganId;
  readonly binding: ProviderBinding;
  readonly port: ExecutionRuntimePort;
  readonly checkpointRoot: string;
  readonly evidenceRoot: string;
  readonly uiRoot: string;
  readonly providerState?: string;
  readonly host?: string;
  readonly portNumber?: number;
  readonly projectKey?: string;
  readonly memory: UiRuntimeMemoryComposition;
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
}

export async function startUiRuntime(options: UiRuntimeLaunchOptions): Promise<UiRuntime> {
  const readiness = options.mode === 'rcc' ? await options.port.probe(options.binding) : undefined;
  const providerState = readiness ? providerStateFromReadiness(readiness) : options.providerState ?? 'ready';
  const providerError = readiness ? providerErrorFromReadiness(readiness) : undefined;
  const attentionPort = new InMemoryAttentionPort();
  const modeRoot = join(options.checkpointRoot, options.mode);
  const checkpointStoreFor = (taskId: TaskId, cycleId: CycleId): TaskCheckpointStore => new FileCheckpointStore(join(modeRoot, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`));
  const service = new UiRuntimeService({
    mode: options.mode,
    organId: options.organId,
    binding: options.binding,
    port: options.port,
    checkpointStoreFor,
    attentionPort,
    providerState,
    providerError,
    journal: new UiRuntimeJournal(join(modeRoot, 'ui-runtime-journal.jsonl')),
    ...(options.projectKey ? { projectKey: options.projectKey } : {}),
    memory: options.memory,
  });
  await service.hydrate();
  const server = await startUiRuntimeServer({
    service,
    uiRoot: options.uiRoot,
    host: options.host,
    port: options.portNumber,
  });
  return { service, server };
}

export { UiRuntimeApiError } from './errors.js';
export { MemoryBoundExecutionDriver, MemoryContextCapture, UiRuntimeService } from './service.js';
export type { TaskCheckpointStore, UiRuntimeMemoryComposition } from './service.js';
export { FileCheckpointStore, UiRuntimeJournal } from './journal.js';
export { FakeReplayExecutionRuntimePort } from './fake-port.js';
export type { UiRuntimeServer } from './server.js';
