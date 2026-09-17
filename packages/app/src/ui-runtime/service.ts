import { randomUUID } from 'node:crypto';
import {
  type Attention,
  type CycleId,
  type ExecutionRuntimePort,
  type OperationId,
  type OrganId,
  type ProviderBinding,
  type TaskId,
} from '../../../contracts/src/index.js';
import type { AttentionPort } from '../../../runtime/src/control/attention.js';
import type { CheckpointJournalPort } from '../../../runtime/src/checkpoints/ports.js';
import type { CheckpointCommitPort } from '../../../runtime/src/control/steering.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  type RuntimeExecutionCapabilities,
  type RuntimeTaskSnapshot,
} from '../../../runtime/src/ui-runtime/coordinator.js';
import type { AgentHookRegistry } from '../../../runtime/src/hooks/index.js';
import {
  ProviderAgentDriver,
  ProviderAdapterError,
} from '../../../adapters/provider/src/index.js';
import {
  RuntimeProjectionError,
  type RuntimeDashboardProjection,
  type RuntimeObservationProjection,
  type RuntimeSseEvent,
  type RuntimeStatusProjection,
  type RuntimeTaskDashboardProjection,
  type RuntimeTaskErrorProjection,
  type RuntimeTaskListProjection,
  type TaskDetailProjection,
} from '../../../ui/contracts/runtime.js';
import {
  projectRuntimeDashboard,
  projectRuntimeObservation,
  projectRuntimeStatus,
  projectRuntimeTaskDashboard,
  projectRuntimeTaskList,
} from '../../../ui/projection/runtime.js';
import { projectTaskDetail } from '../../../ui/projection/index.js';
import type { RuntimeObservationNodeInput, RuntimeTaskSnapshotInput } from '../../../ui/projection/runtime.js';
import { UiRuntimeApiError } from './errors.js';
import type { UiRuntimeJournal } from './journal.js';

const APP_OWNER = 'humanagent.app';
const RUNTIME_OWNER = 'humanagent.runtime';

const LIFECYCLE_STATES = new Set([
  'created',
  'admitted',
  'running',
  'settling',
  'succeeded',
  'waiting',
  'blocked',
  'failed',
  'cancelled',
  'stopped',
  'unknown',
  'stale',
]);

export interface TaskCheckpointStore extends CheckpointJournalPort, CheckpointCommitPort {}

export interface UiRuntimeServiceOptions {
  readonly mode: 'fake' | 'rcc';
  readonly organId: OrganId;
  readonly binding: ProviderBinding;
  readonly port: ExecutionRuntimePort;
  readonly checkpointStoreFor: (taskId: TaskId, cycleId: CycleId) => TaskCheckpointStore;
  readonly attentionPort: AttentionPort;
  readonly providerState: string;
  readonly providerError?: RuntimeTaskErrorProjection;
  readonly hookRegistry?: AgentHookRegistry;
  readonly journal?: UiRuntimeJournal;
  readonly now?: () => Date;
}

function observationNodeState(state: string): RuntimeTaskSnapshot['state'] {
  if (LIFECYCLE_STATES.has(state)) return state as RuntimeTaskSnapshot['state'];
  if (state === 'model' || state === 'output' || state === 'tool') return 'succeeded';
  return 'unknown';
}

function apiError(error: unknown): UiRuntimeApiError {
  if (error instanceof UiRuntimeApiError) return error;
  if (error instanceof RuntimeTaskControlError) {
    const status = error.code.endsWith('.not.found') ? 404 : error.code === 'execution.input.required' ? 400 : 409;
    return new UiRuntimeApiError(error.code, error.ownerId, error.message, error.nextAction, status);
  }
  if (error instanceof ProviderAdapterError) {
    const providerError = error.providerError;
    return new UiRuntimeApiError(
      providerError.code,
      providerError.ownerId,
      providerError.message,
      providerError.nextAction ? `${providerError.nextAction.kind}${providerError.nextAction.ref ? `:${providerError.nextAction.ref}` : ''}` : 'inspect provider evidence',
      409,
      providerError.evidenceRefs,
    );
  }
  return new UiRuntimeApiError(
    'ui-runtime.unexpected',
    APP_OWNER,
    error instanceof Error ? error.message : String(error),
    'inspect the runtime error and retry from a new operation',
    500,
  );
}

export class UiRuntimeService {
  private readonly mode: 'fake' | 'rcc';
  private readonly coordinator: RuntimeTaskCoordinator;
  private connected = true;

  constructor(private readonly options: UiRuntimeServiceOptions) {
    this.mode = options.mode;
    this.coordinator = new RuntimeTaskCoordinator({
      organId: options.organId,
      checkpointStoreFor: options.checkpointStoreFor,
      attentionPort: options.attentionPort,
      journal: options.journal,
      hookRegistry: options.hookRegistry,
      taskIdPrefix: randomUUID(),
      now: options.now,
      createDriver: (input) => new ProviderAgentDriver({
        port: options.port,
        binding: options.binding,
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        assignmentId: input.assignmentId,
        scope: input.scope,
        inputRefs: input.inputRefs,
        ownerId: input.ownerId,
      }),
    });
  }

  status(): RuntimeStatusProjection {
    const providerState = this.options.providerState;
    const runtimeState = !this.connected
      ? 'disconnected'
      : providerState === 'ready'
        ? 'ready'
        : providerState === 'degraded'
          ? 'degraded'
          : providerState === 'unknown'
            ? 'unknown'
            : 'unavailable';
    return projectRuntimeStatus({
      mode: this.mode,
      state: runtimeState,
      connected: this.connected,
      providerState,
      providerError: this.options.providerError,
      detail: this.mode === 'fake' ? '固定 replay，不访问 RCC' : '真实 RCC 4444 Provider 执行',
      modes: [
        { mode: 'fake', enabled: true, state: 'ready', detail: '固定 replay' },
        { mode: 'rcc', enabled: true, state: this.mode === 'rcc' ? runtimeState : 'ready', detail: 'RCC 4444' },
        { mode: 'dsh', enabled: false, state: 'disabled', detail: 'DSH 接入完成后开放' },
      ],
    });
  }

  createTask(input: { readonly title?: string; readonly directive?: string }): RuntimeTaskSnapshotInput {
    return this.coordinator.createTask(input);
  }

  executionCapabilities(): RuntimeExecutionCapabilities {
    return this.coordinator.executionCapabilities();
  }

  listTasks(): RuntimeTaskListProjection {
    return projectRuntimeTaskList({ mode: this.mode, tasks: this.coordinator.taskSnapshots() });
  }

  dashboard(): RuntimeDashboardProjection {
    const tasks = this.coordinator.taskSnapshots();
    return projectRuntimeDashboard({
      mode: this.mode,
      tasks,
      recentInputs: tasks
        .filter((task) => task.input.trim().length > 0)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((task) => ({
          text: task.input,
          receivedAt: task.updatedAt,
          taskId: task.taskId,
          taskTitle: task.title,
          source: 'human',
        })),
    });
  }

  taskDashboard(taskId: TaskId): RuntimeTaskDashboardProjection {
    try {
      return projectRuntimeTaskDashboard(this.coordinator.taskSnapshot(taskId), this.mode);
    } catch (error) {
      throw apiError(error);
    }
  }

  taskDetail(taskId: TaskId): TaskDetailProjection {
    try {
      const task = this.coordinator.taskSnapshot(taskId);
      return projectTaskDetail({
        source: {
          state: task.state === 'failed' || task.state === 'blocked'
            ? 'error'
            : task.state === 'waiting'
              ? 'waiting'
              : task.state === 'running' || task.state === 'settling'
                ? 'running'
                : task.state === 'stopped'
                  ? 'stopped'
                  : task.state === 'stale'
                    ? 'stale'
                    : 'ready',
          label: task.currentState,
          detail: task.nextStep,
          updatedAt: task.updatedAt,
        },
        task: {
          id: task.taskId,
          organId: this.options.organId,
          title: task.title,
          directive: task.directive,
          directiveRevision: task.directiveRevision,
          state: task.state,
          memoryScope: 'task',
        },
        currentState: task.currentState,
        priorInput: task.input,
        investigation: task.output ? [task.output] : [],
        proposal: task.nextStep,
        nextAction: task.nextStep,
        requiredDecisions: [],
        customInputAllowed: false,
        observationRef: `task://${task.taskId.value}/observation`,
      });
    } catch (error) {
      throw apiError(error);
    }
  }

  observation(taskId: TaskId, selectedNodeId?: string, scopeRef?: string): RuntimeObservationProjection {
    try {
      const task = this.coordinator.taskSnapshot(taskId);
      const rootScopeRef = `task://${taskId.value}/observation`;
      const providerScopeRef = `${rootScopeRef}/provider.execute`;
      if (scopeRef !== undefined && scopeRef !== rootScopeRef && scopeRef !== providerScopeRef) {
        throw new UiRuntimeApiError(
          'observation.scope.not-found',
          APP_OWNER,
          `unknown observation scope: ${scopeRef}`,
          'select an existing observation scope',
          404,
        );
      }
      const inProviderScope = scopeRef === providerScopeRef;
      const nodes: RuntimeObservationNodeInput[] = inProviderScope
        ? task.events.map((event) => ({
            nodeId: `event-${event.seq}`,
            title: `${event.kind} #${event.seq}`,
            kind: 'event',
            state: observationNodeState(event.state),
            owner: event.ownerId ?? 'humanagent.provider-adapter',
            summary: event.summary,
            inputRefs: [],
            outputRefs: event.kind === 'provider.output' ? event.evidenceRefs.map((ref) => ref.locator) : [],
            evidenceRefs: event.evidenceRefs,
          }))
        : [
            {
              nodeId: 'input.received',
              title: '输入',
              kind: 'interaction',
              state: task.input ? 'succeeded' : 'created',
              owner: APP_OWNER,
              summary: task.input || '等待输入',
              inputRefs: task.input ? [`task://${taskId.value}/input`] : [],
              outputRefs: [],
              evidenceRefs: [],
            },
            {
              nodeId: 'provider.execute',
              title: 'Provider 执行',
              kind: 'execution',
              state: task.state,
              owner: 'humanagent.provider-adapter',
              summary: task.output || task.currentState,
              inputRefs: task.operationId ? [`operation://${task.operationId}/input`] : [],
              outputRefs: task.output ? [`operation://${task.operationId ?? 'none'}/output`] : [],
              evidenceRefs: task.events.flatMap((event) => event.evidenceRefs).slice(-5),
              childScopeRef: providerScopeRef,
            },
            {
              nodeId: 'checkpoint.commit',
              title: 'Checkpoint',
              kind: 'orchestration',
              state: task.checkpoint ? observationNodeState(task.checkpoint.outcome) : 'created',
              owner: RUNTIME_OWNER,
              summary: task.checkpoint?.summary ?? '尚未提交 checkpoint',
              inputRefs: [],
              outputRefs: task.checkpoint ? [`checkpoint://${task.checkpoint.checkpointId}`] : [],
              evidenceRefs: task.checkpoint?.evidenceRefs ?? [],
            },
          ];
      return projectRuntimeObservation({
        mode: this.mode,
        taskId,
        scopeRef: inProviderScope ? providerScopeRef : rootScopeRef,
        title: inProviderScope ? 'Provider 执行事件' : '任务处理流水',
        summary: inProviderScope
          ? 'Provider 执行期间的规范化事件，不包含原始 transport frame。'
          : '从输入到 Provider 执行和 checkpoint 的只读记录。',
        projectionSeq: String(task.events.length),
        breadcrumbs: inProviderScope
          ? [{ ref: `task://${taskId.value}`, title: task.title }, { ref: rootScopeRef, title: '任务处理流水' }]
          : [{ ref: `task://${taskId.value}`, title: task.title }],
        nodes,
        selectedNodeId,
      });
    } catch (error) {
      if (error instanceof RuntimeProjectionError) {
        throw new UiRuntimeApiError('observation.node.not-found', APP_OWNER, error.message, 'select an existing observation node', 404);
      }
      throw apiError(error);
    }
  }

  startExecution(taskId: TaskId, input: { readonly prompt: string }): { readonly operationId: OperationId; readonly executionEpoch: number } {
    try {
      const status = this.status();
      if (status.state !== 'ready' && status.state !== 'degraded') {
        const providerError = this.options.providerError;
        throw new UiRuntimeApiError(
          providerError?.code ?? `provider.readiness.${status.providerState}`,
          providerError?.ownerId ?? 'humanagent.provider-adapter',
          providerError?.message ?? `provider readiness is ${status.providerState}`,
          providerError?.nextAction ?? 'inspect provider readiness',
          409,
        );
      }
      return this.coordinator.startExecution(taskId, input);
    } catch (error) {
      throw apiError(error);
    }
  }

  async stop(taskId: TaskId): Promise<{ readonly state: string; readonly operationId?: string }> {
    try {
      return await this.coordinator.stop(taskId);
    } catch (error) {
      throw apiError(error);
    }
  }

  async retryStop(taskId: TaskId): Promise<{ readonly state: string; readonly operationId?: string }> {
    try {
      return await this.coordinator.retryStop(taskId);
    } catch (error) {
      throw apiError(error);
    }
  }

  eventsSince(operationId: OperationId, lastEventId?: string): readonly RuntimeSseEvent[] {
    try {
      return this.coordinator.eventsSince(operationId, lastEventId);
    } catch (error) {
      throw apiError(error);
    }
  }

  operationTask(operationId: OperationId): TaskId {
    try {
      return this.coordinator.operationTask(operationId);
    } catch (error) {
      throw apiError(error);
    }
  }

  subscribe(operationId: OperationId, listener: (event: RuntimeSseEvent) => void): () => void {
    try {
      return this.coordinator.subscribe(operationId, listener);
    } catch (error) {
      throw apiError(error);
    }
  }

  subscribeReplay(
    operationId: OperationId,
    lastEventId: string | undefined,
    listener: (event: RuntimeSseEvent) => void,
  ): { readonly replay: readonly RuntimeSseEvent[]; readonly unsubscribe: () => void } {
    try {
      return this.coordinator.subscribeReplay(operationId, lastEventId, listener);
    } catch (error) {
      throw apiError(error);
    }
  }

  markDisconnected(): void {
    this.connected = false;
  }

  markConnected(): void {
    this.connected = true;
  }

  attentionAudit(): { readonly published: readonly Attention[]; readonly resolved: readonly Attention[] } {
    return this.coordinator.attentionAudit();
  }

  async hydrate(): Promise<void> {
    await this.coordinator.hydrate();
  }
}
