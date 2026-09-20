import { randomUUID } from 'node:crypto';
import {
  assertNotExpired,
  id,
  type Attention,
  type AgentMemoryContext,
  type AgentMemoryContextInjectionPort,
  type AgentMemoryContextRequest,
  type AgentCapabilities,
  type AgentClosure,
  type AgentDriver,
  type AgentEvent,
  type AgentHandle,
  type AgentInput,
  type AgentOutput,
  type AgentResumeRequest,
  type AgentStartRequest,
  type CycleId,
  type ExecutionRuntimePort,
  type MemoryActorContext,
  type CanonicalMemoryScope,
  type MemoryComparisonView,
  type MemoryDetailView,
  type MemoryInteractionPort,
  type MemoryNamespace,
  type MemoryReviewReceipt,
  type MemoryView,
  type MemoryScope,
  type OrganHealthSnapshot,
  type OperationId,
  type OrganId,
  type ProviderBinding,
  type ProviderCloseResult,
  type StopRequestReceipt,
  type TaskId,
} from '../../../contracts/src/index.js';
import type { AttentionPort } from '../../../runtime/src/control/attention.js';
import type { CheckpointJournalPort } from '../../../runtime/src/checkpoints/ports.js';
import type { CheckpointCommitPort } from '../../../runtime/src/control/steering.js';
import { submitInteractionClosure, type SubmittedInteractionClosure } from '../../../runtime/src/checkpoints/submission.js';
import type { CheckpointClosurePort } from '../../../runtime/src/checkpoints/ports.js';
import {
  ExplicitIntake,
  type ConfirmRequirementDraft,
  type ConfirmedRequirementDraft,
  type ExplicitInput,
  type ExplicitIntakeState,
  type ExplicitInteractionSnapshot,
  type MatchResult,
  type Proposal,
  type StatusQueryReceipt,
} from '../../../runtime/src/intake/explicit-intake.js';
import {
  RequirementInbox,
  type InboxReceipt,
  type RequirementInboxState,
} from '../../../runtime/src/intake/requirement-inbox.js';
import {
  type ConfirmationLedgerState,
  ConfirmationLedger,
  ExplicitBrainRouterError,
  type PersistedSubmittedReceipt,
  RequirementSubmissionOwner,
  type RequirementSubmitReceipt,
} from '../../../runtime/src/explicit-brain/router.js';
import { IntakeError } from '../../../runtime/src/intake/errors.js';
import type { RequirementEnvelope } from '../../../contracts/src/index.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  type RuntimeCheckpointBoundaryPort,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeExplicitBrainJournalState,
  type RuntimeExecutionCapabilities,
  type RuntimeTaskSnapshot,
} from '../../../runtime/src/ui-runtime/coordinator.js';
import {
  MemoryCoordinator,
  MemoryCoordinatorError,
  createMemoryInteractionPort,
  type MemoryContextReceipt,
  type MemoryIssue,
} from '../../../runtime/src/memory/index.js';
import {
  OrganHealthManager,
  OrganHealthError,
  healthEvidenceRefs,
} from '../../../runtime/src/health/index.js';
import { DeterministicMemoryBackend } from '../../../adapters/memory/src/index.js';
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
  type OrganHealthProjection,
  type OrganHealthDimensionProjection,
} from '../../../ui/contracts/runtime.js';
import {
  projectRuntimeDashboard,
  projectRuntimeObservation,
  projectRuntimeStatus,
  projectRuntimeTaskDashboard,
  projectRuntimeTaskList,
} from '../../../ui/projection/runtime.js';
import { projectMemoryInteraction, projectTaskDetail } from '../../../ui/projection/index.js';
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

export interface UiRuntimeMemoryComposition {
  readonly coordinator: MemoryCoordinator;
  readonly backend: DeterministicMemoryBackend;
  readonly projectKey: string;
  readonly roleId?: string;
  readonly tokenBudget?: number;
  readonly interaction?: MemoryInteractionPort;
  readonly bindingRef?: string;
  readonly checkpointBoundary?: RuntimeCheckpointBoundaryPort;
}

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
  readonly closurePort: CheckpointClosurePort;
  readonly now?: () => Date;
  readonly projectKey?: string;
  readonly memory: UiRuntimeMemoryComposition;
}

export interface ExplicitBrainReceipt {
  readonly requirement: RequirementSubmitReceipt;
}

export interface ExplicitBrainDispatchReceipt {
  readonly requirement: InboxReceipt;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
}

interface DispatchLedgerEntry {
  readonly draftId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
}

interface BoundMemoryContext {
  readonly executionEpoch: number;
  readonly receipt: MemoryContextReceipt;
}

export interface MemoryContextPending {
  readonly state: 'pending';
  readonly operationId: string;
  readonly ownerId: string;
  readonly nextAction: string;
}

function observationNodeState(state: string): RuntimeTaskSnapshot['state'] {
  if (LIFECYCLE_STATES.has(state)) return state as RuntimeTaskSnapshot['state'];
  if (state === 'model' || state === 'output' || state === 'tool') return 'succeeded';
  return 'unknown';
}

function apiError(error: unknown): UiRuntimeApiError {
  if (error instanceof UiRuntimeApiError) return error;
  if (error instanceof IntakeError) {
    return new UiRuntimeApiError(error.name, error.owner, error.message, error.nextAction, 409);
  }
  if (error instanceof ExplicitBrainRouterError) {
    return new UiRuntimeApiError(
      error.code,
      'explicit-brain-router',
      error.message,
      error.code === 'confirmation-required' || error.code === 'confirmation-stale'
        ? 'confirm the current requirement draft'
        : 'inspect the explicit brain route or submission',
      409,
    );
  }
  if (error instanceof RuntimeTaskControlError) {
    const status = error.code.endsWith('.not.found') ? 404 : error.code === 'execution.input.required' ? 400 : 409;
    return new UiRuntimeApiError(error.code, error.ownerId, error.message, error.nextAction, status);
  }
  if (error instanceof MemoryCoordinatorError) {
    const bindingMissing = error.message.startsWith('memory-binding-missing')
      || error.message.startsWith('memory interaction binding is not registered');
    const sourceMissing = error.message.startsWith('memory source is unavailable')
      || error.message.includes('memory source is not visible in the bound scope');
    const code = bindingMissing
      ? 'memory-binding-missing'
      : sourceMissing
        ? 'memory-source-not-found'
        : /^memory-[a-z-]+/u.exec(error.message)?.[0] ?? 'memory-interaction.invalid';
    return new UiRuntimeApiError(
      code,
      'memory-coordinator',
      error.message,
      code === 'memory-binding-missing'
        ? 'refresh the memory binding'
        : code === 'memory-source-not-found'
          ? 'select an existing memory detail'
        : 'inspect the memory interaction request and retry',
      bindingMissing || sourceMissing ? 404 : 409,
    );
  }
  if (error instanceof OrganHealthError) {
    return new UiRuntimeApiError(
      error.code,
      error.ownerId,
      error.message,
      error.nextAction,
      409,
    );
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

function interactionClosurePersistenceError(error: unknown): UiRuntimeApiError {
  return new UiRuntimeApiError(
    'interaction-closure.persistence-failed',
    'humanagent.runtime.explicit-intake',
    `rejected interaction was not durably projected: ${error instanceof Error ? error.message : String(error)}`,
    'confirm the runtime journal is writable, then retry the rejection',
    503,
  );
}

export class UiRuntimeService {
  private readonly mode: 'fake' | 'rcc';
  private readonly coordinator: RuntimeTaskCoordinator;
  private readonly requirementInbox = new RequirementInbox();
  private readonly explicitIntake = new ExplicitIntake();
  private readonly confirmationLedger = new ConfirmationLedger();
  private readonly requirementSubmissions: RequirementSubmissionOwner;
  private readonly dispatchLedger = new Map<string, DispatchLedgerEntry>();
  private readonly memory: UiRuntimeMemoryComposition;
  private readonly memoryInjection: MemoryContextCapture;
  private readonly memoryInteraction: MemoryInteractionPort;
  private readonly healthManager: OrganHealthManager;
  private readonly memoryContexts = new Map<string, BoundMemoryContext>();
  private dispatchTail: Promise<void> = Promise.resolve();
  private connected = true;

  constructor(private readonly options: UiRuntimeServiceOptions) {
    this.memory = options.memory;
    this.memoryInjection = new MemoryContextCapture(this.memory.backend);
    this.healthManager = new OrganHealthManager({
      organId: options.organId,
      probe: {
        probe: () => options.port.probe(options.binding),
      },
      now: () => this.now(),
    });
    if (this.memory.interaction) {
      this.memoryInteraction = this.memory.interaction;
    } else {
      const interactionBinding = this.memory.coordinator.bindInteraction({
        interactionScopeId: `runtime:${this.memory.projectKey}`,
        projectKey: this.memory.projectKey,
        backendRef: 'memory://deterministic',
        indexVersion: this.memory.backend.indexVersion,
        operations: this.memory.backend,
        injection: this.memory.backend,
      });
      this.memoryInteraction = createMemoryInteractionPort({
        coordinator: this.memory.coordinator,
        bindingFor: ({ projectKey, namespace }) => (
          projectKey === this.memory.projectKey
            ? {
                projectKey,
                namespace,
                bindingRef: this.memory.bindingRef ?? interactionBinding.bindingId,
              }
            : undefined
        ),
        now: () => this.now().toISOString(),
      });
    }
    this.requirementSubmissions = new RequirementSubmissionOwner(
      this.confirmationLedger,
      this.requirementInbox,
      {
        submit: async (envelope) => ({ requirementId: envelope.requirementId }),
      },
      () => this.persistExplicitBrainState(),
      () => this.persistExplicitBrainState(),
    );
    this.mode = options.mode;
    this.coordinator = new RuntimeTaskCoordinator({
      organId: options.organId,
      checkpointStoreFor: options.checkpointStoreFor,
      attentionPort: options.attentionPort,
      journal: options.journal,
      hookRegistry: options.hookRegistry,
      taskIdPrefix: randomUUID(),
      now: options.now,
      createDriver: (input) => this.createMemoryBoundDriver(input),
      ...(this.memory.checkpointBoundary === undefined ? {} : { checkpointBoundary: this.memory.checkpointBoundary }),
    });
  }

  memoryContextReceipt(operationId: OperationId): MemoryContextReceipt {
    const context = this.memoryContexts.get(operationId.value);
    if (!context) {
      throw new UiRuntimeApiError(
        'memory-binding-missing',
        'memory-coordinator',
        `memory context is missing for operation: ${operationId.value}`,
        'start an execution before requesting memory context',
        404,
      );
    }
    const currentEpoch = this.coordinator.taskSnapshot(context.receipt.taskId).executionEpoch;
    if (currentEpoch !== undefined && currentEpoch !== context.executionEpoch) {
      throw new UiRuntimeApiError(
        'memory-binding-mismatch',
        'memory-coordinator',
        `memory context execution epoch ${context.executionEpoch} is stale for task ${context.receipt.taskId.value}`,
        'use the latest execution memory context',
        409,
      );
    }
    return structuredClone(context.receipt);
  }

  memoryContextStatus(operationId: OperationId): {
    readonly httpStatus: 200 | 202;
    readonly body: MemoryContextReceipt | MemoryContextPending;
  } {
    const receipt = this.memoryContexts.get(operationId.value);
    if (receipt) return { httpStatus: 200, body: this.memoryContextReceipt(operationId) };
    let task: RuntimeTaskSnapshot;
    try {
      task = this.coordinator.taskSnapshot(this.coordinator.operationTask(operationId));
    } catch {
      throw new UiRuntimeApiError(
        'memory-binding-missing',
        'memory-coordinator',
        `memory context is missing for operation: ${operationId.value}`,
        'start an execution before requesting memory context',
        404,
      );
    }
    let terminal: RuntimeTaskSnapshot['events'][number] | undefined;
    for (let index = task.events.length - 1; index >= 0; index -= 1) {
      const event = task.events[index]!;
      if (event.operationId === operationId.value && event.terminalPhase === 'final') {
        terminal = event;
        break;
      }
    }
    if (terminal && (terminal.state === 'failed' || terminal.state === 'blocked')) {
      throw new UiRuntimeApiError(
        terminal.state === 'blocked' ? 'memory-context-blocked' : 'memory-context-failed',
        terminal.ownerId ?? RUNTIME_OWNER,
        terminal.summary,
        terminal.nextAction ?? 'inspect the execution failure',
        terminal.state === 'blocked' ? 409 : 500,
        terminal.evidenceRefs,
      );
    }
    if (terminal) {
      throw new UiRuntimeApiError(
        'memory-context-unavailable',
        'memory-coordinator',
        `memory context is unavailable for terminal operation: ${operationId.value}`,
        'start a new execution and request its memory context',
        409,
      );
    }
    return {
      httpStatus: 202,
      body: {
        state: 'pending',
        operationId: operationId.value,
        ownerId: 'memory-coordinator',
        nextAction: 'wait for the execution memory binding to complete',
      },
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private memoryActor(): MemoryActorContext {
    const configuredRole = this.memory.roleId;
    const roleId: MemoryActorContext['roleId'] = configuredRole === 'review'
      || configuredRole === 'orchestration'
      || configuredRole === 'memory'
      || configuredRole === 'system'
      ? configuredRole
      : 'interaction';
    const permissions: MemoryActorContext['permissions'] = roleId === 'review'
      ? ['memory.read', 'memory.review']
      : ['memory.read'];
    return {
      actorId: 'ui-memory-interaction',
      roleId,
      permissions,
      projectKey: this.memory.projectKey,
    };
  }

  async memorySummary(input: {
    readonly namespace?: MemoryNamespace;
    readonly query?: string;
    readonly limit?: number;
  } = {}) {
    try {
      const namespace = input.namespace ?? 'project';
      const query = input.query?.trim();
      const view = query
        ? await this.memoryInteraction.query({
            actor: this.memoryActor(),
            projectKey: this.memory.projectKey,
            namespace,
            query,
            limit: input.limit ?? 20,
          })
        : {
            handle: await this.memoryInteraction.open({
              actor: this.memoryActor(),
              projectKey: this.memory.projectKey,
              namespace,
            }),
            entries: [],
            indexVersion: this.memory.backend.indexVersion,
            omitted: [],
          };
      return projectMemoryInteraction({
        source: {
          state: 'ready',
          label: 'Memory Interaction',
          detail: 'typed projection from the deterministic memory backend',
        },
        scope: this.memory.projectKey,
        summary: query
          ? view.entries.length === 0
            ? '当前没有匹配的长期记忆'
            : `当前有 ${view.entries.length} 条匹配记录`
          : '未指定过滤条件',
        indexState: view.indexVersion ?? this.memory.backend.indexVersion,
        entries: view.entries.map((entry) => ({
          id: entry.memoryId,
          sourceRef: entry.sourceRefs[0] ?? entry.memoryId,
          scope: entry.sourceScopeRef,
          summary: entry.summary,
          digest: entry.sourceDigests[0] ?? '',
          evidenceRefs: [],
        })),
        skillCandidates: [],
        inspectEnabled: true,
        compareEnabled: true,
      });
    } catch (error) {
      throw apiError(error);
    }
  }

  async memoryQuery(input: {
    readonly namespace?: MemoryNamespace;
    readonly query: string;
    readonly limit?: number;
  }): Promise<MemoryView> {
    try {
      return await this.memoryInteraction.query({
        actor: this.memoryActor(),
        projectKey: this.memory.projectKey,
        namespace: input.namespace ?? 'project',
        query: input.query,
        limit: input.limit ?? 20,
      });
    } catch (error) {
      throw apiError(error);
    }
  }

  async memoryInspect(input: {
    readonly sourceRef: string;
    readonly sourceDigest: string;
  }): Promise<MemoryDetailView> {
    try {
      return await this.memoryInteraction.inspect({
        actor: this.memoryActor(),
        sourceRef: input.sourceRef,
        sourceDigest: input.sourceDigest,
      });
    } catch (error) {
      throw apiError(error);
    }
  }

  async memoryCompare(input: {
    readonly leftRef: string;
    readonly rightRef: string;
  }): Promise<MemoryComparisonView> {
    try {
      return await this.memoryInteraction.compare({
        actor: this.memoryActor(),
        leftRef: input.leftRef,
        rightRef: input.rightRef,
      });
    } catch (error) {
      throw apiError(error);
    }
  }

  async reviewSkillCandidate(input: {
    readonly candidateId: string;
    readonly decision: 'approve' | 'reject' | 'defer';
    readonly decisionReason: string;
  }): Promise<MemoryReviewReceipt> {
    try {
      return await this.memoryInteraction.review({
        actor: this.memoryActor(),
        candidateId: input.candidateId,
        decision: input.decision,
        decisionReason: input.decisionReason,
      });
    } catch (error) {
      throw apiError(error);
    }
  }

  async healthProbe(): Promise<OrganHealthProjection> {
    try {
      return this.projectHealth(await this.healthManager.probe());
    } catch (error) {
      throw apiError(error);
    }
  }

  async healthSnapshot(): Promise<OrganHealthProjection> {
    try {
      return this.projectHealth(await this.healthManager.snapshot());
    } catch (error) {
      throw apiError(error);
    }
  }

  private projectHealth(snapshot: OrganHealthSnapshot): OrganHealthProjection {
    let stale = false;
    try {
      assertNotExpired(snapshot.expiresAt, this.now());
    } catch {
      stale = true;
    }
    return {
      surface: 'organ-health',
      organId: snapshot.organId,
      lifecycleState: this.status().state,
      healthState: snapshot.overall,
      checkedAt: snapshot.checkedAt,
      expiresAt: snapshot.expiresAt,
      stale,
      dimensions: snapshot.functions.map((fn) => ({
        dimension: 'readiness',
        status: fn.status,
        evidenceRefs: fn.evidenceRefs,
        measurements: fn.measurements,
      })),
      evidenceRefs: healthEvidenceRefs(snapshot),
    };
  }

  private createMemoryBoundDriver(input: RuntimeExecutionDriverInput): RuntimeExecutionDriver {
    const driver = new ProviderAgentDriver({
      port: this.options.port,
      binding: this.options.binding,
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      scope: input.scope,
      inputRefs: input.inputRefs,
      ownerId: input.ownerId,
    });
    return new MemoryBoundExecutionDriver(driver, input, this.memory, this.memoryInjection, (bound) => {
      this.memoryContexts.set(input.operationId.value, bound);
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
        output: task.output
          ? {
            taskId: task.taskId,
            state: task.state === 'succeeded' || task.state === 'failed' || task.state === 'waiting'
              ? task.state
              : 'partial',
            summary: task.output,
            result: {},
            artifactRefs: [],
            evidenceRefs: task.events.flatMap((event) => event.evidenceRefs),
          }
          : undefined,
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
    const records = this.options.journal?.replay() ?? [];
    const state = records
      .filter((record): record is Extract<typeof record, { readonly kind: 'explicit-brain.state' }> => record.kind === 'explicit-brain.state')
      .at(-1)?.state;
    if (!state) return;
    const restored = state as RuntimeExplicitBrainJournalState;
    this.explicitIntake.restoreState(restored.intake);
    this.requirementInbox.restoreState(restored.inbox);
    this.confirmationLedger.restoreState(restored.confirmationLedger);
    this.requirementSubmissions.restoreSubmittedReceipts(restored.submittedSubmissions ?? []);
    this.dispatchLedger.clear();
    for (const entry of restored.dispatchLedger ?? []) {
      this.dispatchLedger.set(entry.draftId, structuredClone(entry));
    }
  }

  async receiveExplicitInput(input: ExplicitInput, inputRevision = 1): Promise<string> {
    try {
      const interactionId = await this.explicitIntake.receive(input, inputRevision);
      this.persistExplicitBrainState();
      return interactionId;
    } catch (error) {
      throw apiError(error);
    }
  }

  async inspectExplicitInteraction(interactionId: string): Promise<ExplicitInteractionSnapshot> {
    try {
      return await this.explicitIntake.inspect(interactionId);
    } catch (error) {
      throw apiError(error);
    }
  }

  async rejectExplicitInteraction(interactionId: string, reason: string): Promise<SubmittedInteractionClosure> {
    const previousState = this.explicitIntake.exportState();
    let intakeTransitioned = false;
    try {
      await this.explicitIntake.reject(interactionId, reason);
      intakeTransitioned = true;
      const scope = { organId: id('organ', this.options.organId.value) };
      const submitted = await submitInteractionClosure({
        ownerId: 'humanagent.runtime.explicit-intake',
        closureId: `interaction-closure-${interactionId}`,
        scope,
        reason,
        evidenceRefs: [{
          evidenceId: id('evidence', `interaction-rejection-${interactionId}`),
          kind: 'operation',
          source: 'humanagent.runtime.explicit-intake',
          locator: `interaction/${interactionId}/rejection`,
          scope,
        }],
        closurePort: this.options.closurePort,
        next: { kind: 'wait', ref: 'rejected-interaction-closed' },
      });
      this.persistExplicitBrainState();
      return submitted;
    } catch (error) {
      if (intakeTransitioned) {
        this.explicitIntake.restoreState(previousState);
        throw interactionClosurePersistenceError(error);
      }
      throw apiError(error);
    }
  }

  async beginExplicitMatching(interactionId: string): Promise<void> {
    try {
      await this.explicitIntake.beginMatching(interactionId);
      this.persistExplicitBrainState();
    } catch (error) {
      throw apiError(error);
    }
  }

  async recordExplicitMatch(interactionId: string, result: MatchResult): Promise<void> {
    try {
      await this.explicitIntake.recordMatch(interactionId, result);
      this.persistExplicitBrainState();
    } catch (error) {
      throw apiError(error);
    }
  }

  async proposeExplicitRequirement(interactionId: string, proposal: Proposal): Promise<void> {
    try {
      await this.explicitIntake.propose(interactionId, proposal);
      this.persistExplicitBrainState();
    } catch (error) {
      throw apiError(error);
    }
  }

  async completeExplicitStatusQuery(interactionId: string): Promise<StatusQueryReceipt> {
    try {
      await this.explicitIntake.beginStatusCheck(interactionId);
      const receipt = await this.explicitIntake.completeStatusOnly(interactionId);
      this.persistExplicitBrainState();
      return receipt;
    } catch (error) {
      throw apiError(error);
    }
  }

  async confirmExplicitRequirement(input: ConfirmRequirementDraft): Promise<ExplicitBrainReceipt> {
    try {
      const confirmed: ConfirmedRequirementDraft = await this.explicitIntake.prepareConfirmation(input);
      this.confirmationLedger.registerDraft({
        interactionId: confirmed.interactionId,
        draftId: confirmed.draftId,
        inputRevision: confirmed.inputRevision,
        normalizedInput: confirmed.normalizedInput,
        intent: confirmed.intent,
        taskRef: confirmed.taskRef,
        payloadRef: confirmed.payloadRef,
      });
      this.confirmationLedger.confirm({
        interactionId: confirmed.interactionId,
        draftId: confirmed.draftId,
        inputRevision: confirmed.inputRevision,
        confirmationRef: confirmed.confirmationRef,
        confirmedBy: confirmed.confirmedBy,
        confirmedAt: confirmed.confirmedAt,
      });
      const requirement = await this.requirementSubmissions.submit({
        interactionId: confirmed.interactionId,
        draftId: confirmed.draftId,
        confirmationRef: confirmed.confirmationRef,
        inputRevision: confirmed.inputRevision,
      });
      this.persistExplicitBrainState();
      return { requirement };
    } catch (error) {
      throw apiError(error);
    }
  }

  async dispatchNextExplicitRequirement(): Promise<ExplicitBrainDispatchReceipt> {
    let release!: () => void;
    const previous = this.dispatchTail;
    this.dispatchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const consumed: RequirementEnvelope | null = await this.requirementInbox.peekNext({ consumerId: RUNTIME_OWNER });
      if (!consumed) {
        throw new UiRuntimeApiError(
          'explicit-brain.inbox.empty',
          RUNTIME_OWNER,
          'requirement inbox has no pending entry',
          'wait for a confirmed requirement',
          409,
        );
      }
      const existingDispatch = this.dispatchLedger.get(consumed.draftId);
      if (existingDispatch) {
        const requirement = await this.requirementInbox.acknowledge({
          consumerId: RUNTIME_OWNER,
          requirementId: consumed.requirementId,
        });
        await this.explicitIntake.markDraftDispatched(consumed.draftId);
        this.dispatchLedger.delete(consumed.draftId);
        this.persistExplicitBrainState();
        return {
          requirement,
          taskId: existingDispatch.taskId,
          operationId: existingDispatch.operationId,
          executionEpoch: existingDispatch.executionEpoch,
        };
      }
      const task = consumed.taskRef
        ? this.coordinator.taskSnapshot(consumed.taskRef)
        : this.coordinator.createTask({
            title: consumed.normalizedInput,
            directive: consumed.normalizedInput,
          });
      const started = this.coordinator.startExecution(task.taskId, { prompt: consumed.payloadRef });
      this.dispatchLedger.set(consumed.draftId, {
        draftId: consumed.draftId,
        taskId: task.taskId,
        operationId: started.operationId,
        executionEpoch: started.executionEpoch,
      });
      this.persistExplicitBrainState();
      const requirement = await this.requirementInbox.acknowledge({
        consumerId: RUNTIME_OWNER,
        requirementId: consumed.requirementId,
      });
      await this.explicitIntake.markDraftDispatched(consumed.draftId);
      this.dispatchLedger.delete(consumed.draftId);
      this.persistExplicitBrainState();
      return {
        requirement,
        taskId: task.taskId,
        operationId: started.operationId,
        executionEpoch: started.executionEpoch,
      };
    } catch (error) {
      throw apiError(error);
    } finally {
      release();
    }
  }

  private persistExplicitBrainState(): void {
    this.options.journal?.append({
      kind: 'explicit-brain.state',
      state: {
        intake: this.explicitIntake.exportState(),
        inbox: this.requirementInbox.exportState(),
        confirmationLedger: this.confirmationLedger.exportState(),
        dispatchLedger: [...this.dispatchLedger.values()].map((entry) => structuredClone(entry)),
        submittedSubmissions: this.requirementSubmissions.submittedReceipts() as readonly PersistedSubmittedReceipt[],
      },
    });
  }
}

function memoryFailure(error: MemoryIssue): UiRuntimeApiError {
  return new UiRuntimeApiError(
    error.code,
    error.ownerId,
    error.message,
    `${error.nextAction.kind}${error.nextAction.ref ? `:${error.nextAction.ref}` : ''}`,
    error.code === 'memory-binding-missing' ? 404 : 409,
  );
}

function memoryScope(input: RuntimeExecutionDriverInput, projectKey: string): CanonicalMemoryScope {
  return {
    namespace: 'project',
    projectKey,
    organId: input.scope.organId,
    taskId: input.taskId,
  };
}

export class MemoryContextCapture implements AgentMemoryContextInjectionPort {
  private readonly contexts = new Map<string, AgentMemoryContext>();

  constructor(private readonly backend: DeterministicMemoryBackend) {}

  async recall(input: AgentMemoryContextRequest): Promise<AgentMemoryContext> {
    const context = await this.backend.recall(input);
    this.contexts.set(`${input.agentRuntimeId}:${context.contextId}`, context);
    return context;
  }

  async attach(input: { readonly agentRuntimeId: string; readonly context: AgentMemoryContext }): Promise<{ readonly contextId: string; readonly attached: boolean }> {
    return this.backend.attach(input);
  }

  take(agentRuntimeId: string, contextId: string): AgentMemoryContext | undefined {
    const key = `${agentRuntimeId}:${contextId}`;
    const context = this.contexts.get(key);
    if (context) this.contexts.delete(key);
    return context;
  }
}

export class MemoryBoundExecutionDriver implements AgentDriver {
  readonly kind: string;
  private binding?: {
    readonly context: AgentMemoryContext;
    readonly receipt: MemoryContextReceipt;
  };

  constructor(
    private readonly driver: AgentDriver & { close(): Promise<ProviderCloseResult> },
    private readonly input: RuntimeExecutionDriverInput,
    private readonly composition: UiRuntimeMemoryComposition,
    private readonly injection: MemoryContextCapture,
    private readonly onBound: (bound: BoundMemoryContext) => void,
  ) {
    this.kind = driver.kind;
  }

  async capabilities(): Promise<AgentCapabilities> {
    return this.driver.capabilities();
  }

  async start(input: AgentStartRequest): Promise<AgentHandle> {
    await this.bindMemory();
    return this.driver.start(input);
  }

  async resume(input: AgentResumeRequest): Promise<AgentHandle> {
    await this.bindMemory();
    return this.driver.resume(input);
  }

  submit(input: AgentInput): Promise<AgentOutput> {
    return this.driver.submit(input);
  }

  observe(input: { readonly runtimeId: string }): AsyncIterable<AgentEvent> {
    return this.driver.observe(input);
  }

  requestStop(input: { readonly runtimeId: string; readonly executionEpoch: number; readonly operationId: OperationId }): Promise<StopRequestReceipt> {
    return this.driver.requestStop(input);
  }

  settle(input: { readonly runtimeId: string; readonly executionEpoch: number }): Promise<AgentClosure> {
    return this.driver.settle(input);
  }

  close(): Promise<ProviderCloseResult> {
    return this.driver.close();
  }

  private async bindMemory(): Promise<void> {
    if (this.binding) return;
    const backendRef = `memory://${this.composition.projectKey}`;
    const scope = memoryScope(this.input, this.composition.projectKey);
    try {
      this.composition.coordinator.bindTask({
        taskId: this.input.taskId,
        assignmentId: this.input.assignmentId,
        executionEpoch: this.input.executionEpoch,
        projectKey: this.composition.projectKey,
        scope,
        backendRef,
        indexVersion: this.composition.backend.indexVersion,
        operations: this.composition.backend,
        injection: this.injection,
        ownerId: APP_OWNER,
      });
    } catch (error) {
      if (error instanceof MemoryCoordinatorError) {
        throw new UiRuntimeApiError(
          'memory-binding-mismatch',
          'memory-coordinator',
          error.message,
          'start a new task or refresh memory binding',
          409,
        );
      }
      throw error;
    }
    const runtimeBinding = this.composition.coordinator.bindRuntime({
      agentRuntimeId: this.input.runtimeId,
      taskId: this.input.taskId,
      assignmentId: this.input.assignmentId,
      roleId: this.composition.roleId ?? 'execution',
      executionEpoch: this.input.executionEpoch,
    });
    if (runtimeBinding.status !== 'ready') throw memoryFailure(runtimeBinding.issue);
    const request: AgentMemoryContextRequest = {
      agentRuntimeId: this.input.runtimeId,
      roleId: this.composition.roleId ?? 'execution',
      taskId: this.input.taskId,
      scope,
      layers: ['current'],
      tokenBudget: this.composition.tokenBudget ?? 4096,
      executionEpoch: this.input.executionEpoch,
      evidenceRequired: true,
    };
    const recalled = await this.composition.coordinator.recall(request);
    if (recalled.status !== 'ready') throw memoryFailure(recalled.issue);
    const context = this.injection.take(this.input.runtimeId, recalled.value.contextId);
    if (!context) {
      throw new UiRuntimeApiError(
        'memory-context-unavailable',
        'memory-coordinator',
        'memory context was not captured from the bound injection port',
        'recall memory context before attaching it',
        409,
      );
    }
    const attached = await this.composition.coordinator.attach({
      agentRuntimeId: this.input.runtimeId,
      taskId: this.input.taskId,
      scope,
      executionEpoch: this.input.executionEpoch,
      context,
    });
    if (attached.status !== 'ready') throw memoryFailure(attached.issue);
    this.binding = {
      context,
      receipt: recalled.value,
    };
    this.onBound({
      executionEpoch: recalled.value.executionEpoch,
      receipt: recalled.value,
    });
  }

}
