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
  type EvidenceRef,
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
  type InteractionDecision,
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
import {
  ADMISSION_QUEUE_KINDS,
  RequirementAdmissionError,
  admitRequirement,
  classifyConfirmedRequirement,
  defaultAdmissionQueueConfig,
  type RequirementAdmissionReceipt,
} from '../../../runtime/src/admission/index.js';
import type { RequirementEnvelope } from '../../../contracts/src/index.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  type RuntimeCheckpointBoundaryPort,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeExplicitBrainJournalState,
  type RuntimeExecutionCapabilities,
  type RuntimeTaskAssembly,
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
import { DecisionTraceJournal, ExplicitBrainDecisionError } from '../../../runtime/src/explicit-brain/index.js';
import type { ExplicitBrainAgentTarget, ExplicitBrainInputInterpreter } from '../explicit-brain-runtime.js';
import type { MemoryReviewState } from '../memory-runtime.js';
import { DeterministicMemoryBackend } from '../../../adapters/memory/src/index.js';
import type { AgentHookRegistry } from '../../../runtime/src/hooks/index.js';
import {
  ProviderAgentDriver,
  ProviderAdapterError,
} from '../../../adapters/provider/src/index.js';
import {
  type RuntimeDashboardProjection,
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
  projectRuntimeStatus,
  projectRuntimeTaskDashboard,
  projectRuntimeTaskList,
} from '../../../ui/projection/runtime.js';
import {
  projectMemoryInteraction,
  projectPipelineObservation,
  projectTaskDetail,
  type ObservationAgentFrameSource,
  type ObservationHandoffSource,
  type ObservationNodeSource,
  type ObservationNodeToolStepSource,
  type ObservationScopeSource,
} from '../../../ui/projection/index.js';
import { UiProjectionError, type PipelineObservationProjection } from '../../../ui/contracts/models.js';
import type { RuntimeTaskSnapshotInput } from '../../../ui/projection/runtime.js';
import { nodeRegistry, type PipelineNodeDefinition } from '../../../runtime/src/nodes/node-registry.js';
import type { AgentRoleDisplay, LifecycleState } from '../../../contracts/src/index.js';
import { UiRuntimeApiError } from './errors.js';
import type { UiRuntimeJournal } from './journal.js';
import type { ExecutionAgentPort } from '../../../runtime/src/orchestration/index.js';
import {
  createExplicitBrainRuntime,
  type ExplicitBrainRuntime,
} from '../explicit-brain-runtime.js';

const APP_OWNER = 'humanagent.app';
const RUNTIME_OWNER = 'humanagent.runtime';
const PROVIDER_EXECUTION_CAPABILITY = 'provider.execution';

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
  readonly reviewState?: () => Promise<MemoryReviewState>;
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
  readonly interactionJournal?: UiRuntimeJournal;
  readonly closurePort: CheckpointClosurePort;
  readonly now?: () => Date;
  readonly projectKey?: string;
  readonly workspaceRoot?: string;
  readonly explicitBrainAgentMessage?: (input: {
    readonly recipientRef: string;
    readonly messageRef: string;
    readonly messageClass: 'control' | 'data' | 'observation';
  }) => Promise<unknown>;
  readonly explicitBrainAgentQuery?: (input: { readonly agentRef: string; readonly scopeRef: string }) => Promise<unknown>;
  readonly explicitBrainAgentTargets?: readonly ExplicitBrainAgentTarget[];
  readonly explicitBrainInterpreter: ExplicitBrainInputInterpreter;
  readonly memory: UiRuntimeMemoryComposition;
  readonly runtimeComposition?: {
    readonly createTaskAssembly?: (input: {
      readonly task: import('../../../contracts/src/index.js').Task;
      readonly scope: import('../../../contracts/src/index.js').ScopeRef;
      readonly checkpointJournal: TaskCheckpointStore;
      readonly executionAgent?: ExecutionAgentPort;
      readonly maxAttempts?: number;
    }) => RuntimeTaskAssembly;
  };
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
  readonly executionEpoch?: number;
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

function observationNodeState(state: string): LifecycleState {
  if (LIFECYCLE_STATES.has(state)) return state as RuntimeTaskSnapshot['state'];
  return 'unknown';
}

/** A pipeline node plus whether the runtime actually reported a fact for it. */
interface ObservationNodeFacts {
  readonly node: Omit<ObservationNodeSource, 'childScopeRef'>;
  readonly projected: boolean;
}

/**
 * Observation facts are derived from `RuntimeTaskSnapshot` only. A node the runtime reports no fact
 * for stays `created` with an explicit unprojected summary and zero evidence: the observation
 * surface never invents queue depth, admission outcome, memory curation or tool content.
 */
function observationNodeFacts(
  definition: PipelineNodeDefinition,
  task: RuntimeTaskSnapshot,
  toolSteps: readonly ObservationNodeToolStepSource[],
): ObservationNodeFacts {
  const inputRef = `task://${task.taskId.value}/input`;
  const base = {
    nodeId: definition.nodeId,
    title: definition.title,
    kind: definition.kind,
    owner: agentIdForRole(definition.ownerRole),
    ownerAgentRole: definition.ownerRole,
    iteration: task.executionEpoch ?? 1,
    updatedAt: task.updatedAt,
    inputRefs: [] as readonly string[],
    outputRefs: [] as readonly string[],
    evidenceRefs: task.events.flatMap((event) => event.evidenceRefs),
  };
  const unprojected = {
    ...base,
    state: 'created' as const,
    summary: `运行时尚未投影「${definition.title}」的事实。`,
    inputRefs: [] as readonly string[],
    outputRefs: [] as readonly string[],
    evidenceRefs: [] as readonly EvidenceRef[],
  };
  switch (definition.nodeId) {
    case 'sensory.inbox':
      return task.input
        ? { node: { ...base, state: 'succeeded', summary: task.input, inputRefs: [inputRef] }, projected: true }
        : { node: unprojected, projected: false };
    case 'explicit.normalize':
      return task.input
        ? {
          node: { ...base, state: 'succeeded', summary: task.directive, inputRefs: [inputRef], outputRefs: [`task://${task.taskId.value}/directive@${task.directiveRevision}`] },
          projected: true,
        }
        : { node: unprojected, projected: false };
    case 'task.correlate-or-create':
      return task.input
        ? {
          node: { ...base, state: 'succeeded', summary: `已关联任务 ${task.taskId.value}`, outputRefs: [`task://${task.taskId.value}`] },
          projected: true,
        }
        : { node: unprojected, projected: false };
    case 'resource.admission':
      return task.state === 'created'
        ? { node: unprojected, projected: false }
        : { node: { ...base, state: 'succeeded', summary: `任务状态 ${task.state}，已越过准入` }, projected: true };
    case 'pipeline.execute':
      return task.operationId === undefined
        ? { node: unprojected, projected: false }
        : {
          node: {
            ...base,
            state: task.state,
            summary: task.output || task.currentState,
            inputRefs: [`operation://${task.operationId}/input`],
            outputRefs: task.output ? [`operation://${task.operationId}/output`] : [],
            evidenceRefs: task.events.flatMap((event) => event.evidenceRefs).slice(-5),
            toolSteps,
          },
          projected: true,
        };
    case 'settle':
      return task.checkpoint
        ? {
          node: {
            ...base,
            state: observationNodeState(task.checkpoint.outcome),
            summary: task.checkpoint.summary,
            outputRefs: [`checkpoint://${task.checkpoint.checkpointId}`],
            evidenceRefs: task.checkpoint.evidenceRefs,
          },
          projected: true,
        }
        : { node: unprojected, projected: false };
    case 'task.output':
      return task.output
        ? {
          node: { ...base, state: task.state, summary: task.output, outputRefs: [`task://${task.taskId.value}/output`] },
          projected: true,
        }
        : { node: unprojected, projected: false };
    case 'memory.agent':
      return task.orchestrated && task.state !== 'created'
        ? {
          node: { ...base, state: task.state, summary: '由任务编排在 checkpoint 之后唤起的经验整理请求已发出。' },
          projected: true,
        }
        : { node: unprojected, projected: false };
    default:
      // The four routing queues and implicit classification have no runtime observable yet.
      return { node: unprojected, projected: false };
  }
}

function agentIdForRole(role: AgentRoleDisplay): string {
  return `agent-${role}`;
}

/**
 * One ownership frame per registry owner role. Frames carry no invented state: a frame declares which
 * agent owns which nodes, the display string states exactly where the ownership comes from, and the
 * iteration is the round counter of the nodes it owns (`executionEpoch`, `1` before any execution).
 */
function agentFrames(roles: readonly AgentRoleDisplay[], iteration: number): ObservationAgentFrameSource[] {
  return [...new Set(roles)].map((role) => ({
    agentId: agentIdForRole(role),
    role,
    stateDisplay: '归属来自流水线注册表',
    iteration,
  }));
}

/**
 * The node the runtime reports as current, translated to the registry node that carries the same
 * fact. `provider.tool`/`provider.model` are provider sub-steps of `pipeline.execute`.
 */
function currentNodeOfPipeline(task: RuntimeTaskSnapshot): string | undefined {
  switch (task.currentNode) {
    case 'input.received':
      return 'sensory.inbox';
    case 'provider.execute':
    case 'provider.tool':
    case 'provider.model':
    case 'orchestration.plan':
      return 'pipeline.execute';
    case 'checkpoint.commit':
      return 'settle';
    default:
      return undefined;
  }
}

/**
 * Handoffs only exist between agents whose downstream node already carries a runtime fact, and they
 * carry the evidence the upstream node projected.
 */
function observationHandoffs(
  nodes: readonly ObservationNodeSource[],
  projectedNodeIds: ReadonlySet<string>,
): ObservationHandoffSource[] {
  const byNodeId = new Map(nodes.map((node) => [node.nodeId, node]));
  const handoff = (handoffId: string, fromNodeId: string, toNodeId: string): ObservationHandoffSource => {
    const from = byNodeId.get(fromNodeId);
    const to = byNodeId.get(toNodeId);
    return {
      handoffId,
      fromNodeId,
      toNodeId,
      carrySummary: from?.summary ?? '',
      payloadPreview: `${fromNodeId} → ${toNodeId}：携带 ${from?.evidenceRefs.length ?? 0} 条 evidence`,
      notCarried: `${fromNodeId} 未投影的事实不传递给 ${toNodeId}`,
      occurredAt: from?.updatedAt,
    };
  };
  const carried = (nodeId: string): boolean => projectedNodeIds.has(nodeId);
  const handoffs: ObservationHandoffSource[] = [];
  if (carried('explicit.normalize') && carried('sensory.inbox')) {
    handoffs.push(handoff(`handoff-sensory-inbox-to-normalize`, 'sensory.inbox', 'explicit.normalize'));
  }
  if (carried('explicit.normalize') && carried('pipeline.execute')) {
    handoffs.push(handoff(`handoff-normalize-to-pipeline`, 'explicit.normalize', 'pipeline.execute'));
  }
  if (carried('pipeline.execute') && carried('settle')) {
    handoffs.push(handoff(`handoff-pipeline-to-settle`, 'pipeline.execute', 'settle'));
  }
  if (carried('settle') && carried('task.output')) {
    handoffs.push(handoff(`handoff-settle-to-output`, 'settle', 'task.output'));
  }
  if (carried('settle') && carried('memory.agent')) {
    handoffs.push(handoff(`handoff-settle-to-memory`, 'settle', 'memory.agent'));
  }
  return handoffs;
}

/**
 * Tool-call history from `provider.tool` events only: the step id, the owner that reported the call,
 * its status and the returned content. Model-private reasoning is never part of an event, so it can
 * never reach this projection.
 */
function observationToolSteps(task: RuntimeTaskSnapshot): ObservationNodeToolStepSource[] {
  return task.events
    .filter((event) => event.kind === 'provider.tool')
    .flatMap((event) => {
      const stepId = event.evidenceRefs[0]?.locator ?? event.eventId;
      const name = event.ownerId ?? event.evidenceRefs[0]?.source ?? '未标注工具';
      const returned = event.summary.trim() || event.evidenceRefs.map((ref) => ref.locator).join(', ');
      if (!stepId.trim() || !name.trim() || !returned.trim()) return [];
      return [{
        stepId,
        name,
        status: event.state === 'succeeded' || event.state === 'failed' || event.state === 'blocked' || event.state === 'cancelled'
          ? event.state
          : 'unknown',
        returned,
        occurredAt: event.occurredAt,
      }];
    });
}

function apiError(error: unknown): UiRuntimeApiError {
  if (error instanceof UiRuntimeApiError) return error;
  if (error instanceof IntakeError) {
    return new UiRuntimeApiError(error.name, error.owner, error.message, error.nextAction, 409);
  }
  if (error instanceof RequirementAdmissionError) {
    const { decision } = error;
    return new UiRuntimeApiError(
      `implicit-admission.${decision.status}`,
      decision.ownerId,
      decision.reason,
      `${decision.nextAction.kind}${decision.nextAction.ref ? `:${decision.nextAction.ref}` : ''}`,
      409,
    );
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
  if (error instanceof ExplicitBrainDecisionError) {
    return new UiRuntimeApiError(
      'explicit-brain.decision-rejected',
      'humanagent.runtime.explicit-brain',
      error.message,
      'inspect the explicit brain tool admission and scoped runtime owner',
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
  private readonly explicitBrainRuntime?: ExplicitBrainRuntime;
  private readonly explicitBrainInterpreter: ExplicitBrainInputInterpreter;
  private readonly explicitBrainTraceRecords: import('../../../contracts/src/index.js').DecisionTraceRecord[] = [];
  private readonly explicitBrainTraceJournal: DecisionTraceJournal;
  private dispatchTail: Promise<void> = Promise.resolve();
  private implicitConsumerEnabled = false;
  private implicitConsumerScheduled = false;
  private implicitConsumerIssue: UiRuntimeApiError | undefined;
  private implicitConsumerRequirement: Pick<RequirementEnvelope, 'requirementId' | 'draftId' | 'fifoSeq'> | undefined;
  private readonly implicitWatchedOperations = new Set<string>();
  private connected = true;

  constructor(private readonly options: UiRuntimeServiceOptions) {
    this.memory = options.memory;
    this.explicitBrainInterpreter = options.explicitBrainInterpreter;
    this.explicitBrainTraceJournal = new DecisionTraceJournal({
      load: () => this.explicitBrainTraceRecords,
      persist: (record) => {
        this.explicitBrainTraceRecords.push(structuredClone(record));
        this.persistExplicitBrainState();
      },
    });
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
      ...(options.runtimeComposition === undefined ? {} : {
        ...(options.runtimeComposition.createTaskAssembly === undefined ? {} : {
          createTaskAssembly: (input) => options.runtimeComposition!.createTaskAssembly!(input),
        }),
      }),
      ...(this.memory.checkpointBoundary === undefined ? {} : { checkpointBoundary: this.memory.checkpointBoundary }),
    });
    if (options.workspaceRoot !== undefined && options.projectKey !== undefined) {
      this.explicitBrainRuntime = createExplicitBrainRuntime({
        workspaceRoot: options.workspaceRoot,
        projectKey: options.projectKey,
        traces: this.explicitBrainTraceJournal,
        ...(options.explicitBrainAgentTargets === undefined ? {} : { agentTargets: options.explicitBrainAgentTargets }),
        ...(options.explicitBrainAgentQuery === undefined ? {} : { queryAgent: options.explicitBrainAgentQuery }),
        ...(options.explicitBrainAgentMessage === undefined ? {} : { sendAgentMessage: options.explicitBrainAgentMessage }),
      });
    }
  }

  async executeExplicitDecision(decision: InteractionDecision): Promise<readonly unknown[]> {
    if (this.explicitBrainRuntime === undefined) {
      throw new UiRuntimeApiError(
        'explicit-brain.runtime-unavailable',
        'humanagent.runtime.explicit-brain',
        'explicit brain operational tools are not connected to a workspace runtime',
        'start the UI runtime with a project workspace binding',
        503,
      );
    }
    try {
      return await this.explicitBrainRuntime.execute(decision);
    } catch (error) {
      throw apiError(error);
    }
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
      const reviewState = await this.memory.reviewState?.();
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
        skillCandidates: (reviewState?.candidates ?? []).map((candidate) => ({
          candidateId: candidate.candidateId,
          pattern: `${candidate.category} · ${candidate.kind}`,
          proposedRule: candidate.summary,
          uniqueness: 'pending-review',
          repeatability: 'observed',
          value: candidate.namespace,
          state: candidate.state,
          evidenceRefs: [],
          namespace: candidate.namespace,
          projectKey: candidate.projectKey,
          taskId: candidate.taskId,
          sourceRefs: candidate.sourceRefs,
          sourceDigests: candidate.sourceDigests,
        })),
        inspectEnabled: true,
        compareEnabled: true,
        analysis: reviewState?.analysis ?? { mode: 'deterministic', state: 'idle' },
        autoUpdate: reviewState?.autoUpdate ?? false,
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
      implicitScheduling: this.implicitSchedulingProjection(),
    });
  }

  createTask(input: { readonly title?: string; readonly directive?: string }): RuntimeTaskSnapshotInput {
    return this.coordinator.createTask(input);
  }

  updateTask(taskId: TaskId, input: { readonly title?: string; readonly directive?: string }): RuntimeTaskSnapshotInput {
    try {
      return this.coordinator.updateTask(taskId, input);
    } catch (error) {
      throw apiError(error);
    }
  }

  deleteTask(taskId: TaskId): { readonly taskId: string; readonly deleted: true } {
    try {
      return { taskId: this.coordinator.deleteTask(taskId).taskId.value, deleted: true };
    } catch (error) {
      throw apiError(error);
    }
  }

  async bulkTaskAction(taskIds: readonly TaskId[], action: 'delete' | 'stop'): Promise<{
    readonly action: 'delete' | 'stop';
    readonly results: readonly {
      readonly taskId: string;
      readonly state: 'succeeded' | 'failed';
      readonly error?: { readonly code: string; readonly ownerId: string; readonly message: string; readonly nextAction: string };
    }[];
  }> {
    const results: {
      readonly taskId: string;
      readonly state: 'succeeded' | 'failed';
      readonly error?: { readonly code: string; readonly ownerId: string; readonly message: string; readonly nextAction: string };
    }[] = [];
    for (const taskId of taskIds) {
      try {
        if (action === 'delete') this.deleteTask(taskId);
        else await this.stop(taskId);
        results.push({ taskId: taskId.value, state: 'succeeded' });
      } catch (error) {
        const projected = apiError(error);
        results.push({
          taskId: taskId.value,
          state: 'failed',
          error: {
            code: projected.code,
            ownerId: projected.ownerId,
            message: projected.message,
            nextAction: projected.nextAction,
          },
        });
      }
    }
    return { action, results };
  }

  executionCapabilities(): RuntimeExecutionCapabilities {
    return this.coordinator.executionCapabilities();
  }

  runtimeComposition(): UiRuntimeServiceOptions['runtimeComposition'] {
    return this.options.runtimeComposition;
  }

  taskAssembly(taskId: TaskId): RuntimeTaskAssembly {
    return this.coordinator.taskAssembly(taskId);
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

  observation(taskId: TaskId, selectedNodeId?: string, scopeRef?: string): PipelineObservationProjection {
    try {
      const task = this.coordinator.taskSnapshot(taskId);
      const rootScopeRef = `task://${taskId.value}/observation`;
      const providerScopeRef = `${rootScopeRef}/pipeline.execute`;
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
      const toolSteps = observationToolSteps(task);
      const registry = nodeRegistry();
      const projectedNodeIds = new Set<string>();
      const nodes: ObservationNodeSource[] = registry.map((definition) => {
        const facts = observationNodeFacts(definition, task, toolSteps);
        if (facts.projected) projectedNodeIds.add(definition.nodeId);
        return definition.nodeId === 'pipeline.execute'
          ? { ...facts.node, childScopeRef: providerScopeRef }
          : facts.node;
      });
      const providerNodes: ObservationNodeSource[] = task.events.map((event) => ({
        nodeId: `event-${event.seq}`,
        title: `${event.kind} #${event.seq}`,
        kind: 'provider.event',
        state: observationNodeState(event.state),
        owner: agentIdForRole('execution'),
        ownerAgentRole: 'execution',
        summary: event.summary,
        inputRefs: [],
        outputRefs: event.kind === 'provider.output' ? event.evidenceRefs.map((ref) => ref.locator) : [],
        evidenceRefs: event.evidenceRefs,
        updatedAt: event.occurredAt,
      }));
      const scopes: Record<string, ObservationScopeSource> = {
        [rootScopeRef]: {
          scopeRef: rootScopeRef,
          title: '任务处理流水',
          summary: '十三个流水线节点的只读记录；无运行时事实的节点保持未投影。',
          projectionSeq: String(task.events.length),
          currentNodeId: currentNodeOfPipeline(task),
          agents: agentFrames(registry.map((definition) => definition.ownerRole), task.executionEpoch ?? 1),
          handoffs: observationHandoffs(nodes, projectedNodeIds),
          nodes,
        },
        [providerScopeRef]: {
          scopeRef: providerScopeRef,
          title: '流水线执行事件',
          summary: 'Provider 执行期间的规范化事件，不包含原始 transport frame。',
          projectionSeq: String(task.events.length),
          agents: agentFrames(['execution'], task.executionEpoch ?? 1),
          nodes: providerNodes,
        },
      };
      return projectPipelineObservation({
        source: {
          state: task.state === 'failed' || task.state === 'blocked'
            ? 'error'
            : task.state === 'running' || task.state === 'settling'
              ? 'running'
              : task.state === 'stale'
                ? 'stale'
                : task.state === 'waiting'
                  ? 'waiting'
                  : 'ready',
          label: task.currentState,
          detail: task.nextStep,
          updatedAt: task.updatedAt,
        },
        scopes,
        scopeStack: inProviderScope ? [rootScopeRef, providerScopeRef] : [rootScopeRef],
        selectedNodeId,
      });
    } catch (error) {
      if (error instanceof UiProjectionError) {
        const unknownScope = error.message.startsWith('unknown observation scope');
        throw new UiRuntimeApiError(
          unknownScope ? 'observation.scope.not-found' : 'observation.node.not-found',
          APP_OWNER,
          error.message,
          unknownScope ? 'select an existing observation scope' : 'select an existing observation node',
          404,
        );
      }
      throw apiError(error);
    }
  }

  startExecution(taskId: TaskId, input: { readonly prompt: string; readonly orchestrate?: boolean }): { readonly operationId: OperationId; readonly executionEpoch: number } {
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
      const started = this.coordinator.startExecution(taskId, input);
      this.watchExecutionForImplicitWakeup(started.operationId);
      return started;
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
    this.scheduleImplicitConsumption();
  }

  attentionAudit(): { readonly published: readonly Attention[]; readonly resolved: readonly Attention[] } {
    return this.coordinator.attentionAudit();
  }

  async hydrate(): Promise<void> {
    await this.coordinator.hydrate();
    const records = (this.options.interactionJournal ?? this.options.journal)?.replay() ?? [];
    const state = records
      .filter((record): record is Extract<typeof record, { readonly kind: 'explicit-brain.state' }> => record.kind === 'explicit-brain.state')
      .at(-1)?.state;
    if (!state) return;
    const restored = state as RuntimeExplicitBrainJournalState;
    this.explicitIntake.restoreState(restored.intake);
    this.requirementInbox.restoreState(restored.inbox);
    this.confirmationLedger.restoreState(restored.confirmationLedger);
    this.requirementSubmissions.restoreSubmittedReceipts(restored.submittedSubmissions ?? []);
    this.explicitBrainTraceRecords.length = 0;
    this.explicitBrainTraceRecords.push(...(restored.decisionTraces ?? []).map((record) => structuredClone(record)));
    this.dispatchLedger.clear();
    for (const entry of restored.dispatchLedger ?? []) {
      this.dispatchLedger.set(entry.draftId, structuredClone(entry));
    }
  }

  startImplicitConsumer(): void {
    this.implicitConsumerEnabled = true;
    for (const task of this.coordinator.taskSnapshots()) {
      if ((task.state === 'running' || task.state === 'settling') && task.operationId) {
        this.watchExecutionForImplicitWakeup(id('operation', task.operationId));
      }
    }
    this.scheduleImplicitConsumption();
  }

  implicitSchedulingIssue(): UiRuntimeApiError | undefined {
    return this.implicitConsumerIssue;
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

  async interpretExplicitInput(input: { readonly interactionId: string }): Promise<ExplicitInteractionSnapshot> {
    try {
      let snapshot = await this.explicitIntake.inspect(input.interactionId);
      if (snapshot.state === 'received') {
        await this.explicitIntake.beginMatching(input.interactionId);
        this.persistExplicitBrainState();
        snapshot = await this.explicitIntake.inspect(input.interactionId);
      }
      if (snapshot.state !== 'matching') {
        throw new UiRuntimeApiError(
          'explicit-brain.interpretation-state-invalid',
          'humanagent.runtime.explicit-brain',
          `explicit input cannot be interpreted from ${snapshot.state}`,
          'inspect the current interaction state before retrying interpretation',
          409,
        );
      }
      const taskCandidates = this.coordinator.taskSnapshots().map((task) => ({
        taskId: task.taskId.value,
        title: task.title,
        status: task.state,
        currentInput: task.input || task.directive,
      }));
      const interpreted = await this.explicitBrainInterpreter.interpret({
        interactionId: snapshot.interactionId,
        inputRevision: this.explicitIntake.inputRevision(snapshot.interactionId),
        sourceRef: snapshot.sourceRef,
        rawInput: snapshot.rawInput,
        clarifications: snapshot.clarifications ?? [],
        taskCandidates,
      });
      if (interpreted.kind === 'clarification') {
        await this.explicitIntake.requestClarification(snapshot.interactionId, interpreted.question);
        this.persistExplicitBrainState();
        return await this.explicitIntake.inspect(snapshot.interactionId);
      }
      const matched = interpreted.matchedTaskId === undefined
        ? undefined
        : this.coordinator.taskSnapshots().find((task) => task.taskId.value === interpreted.matchedTaskId);
      if (interpreted.matchedTaskId !== undefined && matched === undefined) {
        throw new UiRuntimeApiError(
          'explicit-brain.task-match-invalid',
          'humanagent.runtime.explicit-brain',
          `interaction agent selected an unknown task: ${interpreted.matchedTaskId}`,
          'retry interpretation using one of the current task candidates',
          409,
        );
      }
      if (interpreted.kind === 'requirement' && interpreted.intent === 'create' && matched !== undefined) {
        throw new UiRuntimeApiError(
          'explicit-brain.task-match-conflict',
          'humanagent.runtime.explicit-brain',
          'create cannot select an existing task',
          'retry interpretation as append or change, or omit the existing task match for a new task',
          409,
        );
      }
      if (interpreted.kind === 'requirement'
        && (interpreted.intent === 'append' || interpreted.intent === 'change')
        && matched === undefined) {
        throw new UiRuntimeApiError(
          'explicit-brain.task-match-required',
          'humanagent.runtime.explicit-brain',
          `${interpreted.intent} requires a current task match`,
          'retry interpretation with a current task or clarify the intended task',
          409,
        );
      }
      await this.explicitIntake.recordMatch(snapshot.interactionId, {
        normalizedInput: interpreted.normalizedInput,
        matchedTasks: matched === undefined ? [] : [{ taskId: matched.taskId, relation: 'current', status: matched.state }],
        knownFacts: interpreted.knownFacts,
      });
      if (interpreted.kind === 'status-query') {
        await this.explicitIntake.beginStatusCheck(snapshot.interactionId);
        await this.explicitIntake.completeStatusOnly(snapshot.interactionId, interpreted.answer);
      } else {
        await this.explicitIntake.propose(snapshot.interactionId, {
          proposedIntent: interpreted.intent,
          proposal: interpreted.proposal,
          decisionRefs: interpreted.decisionRefs,
        });
      }
      this.persistExplicitBrainState();
      return await this.explicitIntake.inspect(snapshot.interactionId);
    } catch (error) {
      throw apiError(error);
    }
  }

  async answerExplicitClarification(input: {
    readonly interactionId: string;
    readonly answer: string;
  }): Promise<ExplicitInteractionSnapshot> {
    try {
      await this.explicitIntake.answerClarification(input.interactionId, input.answer);
      this.persistExplicitBrainState();
      return await this.explicitIntake.inspect(input.interactionId);
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
      this.scheduleImplicitConsumption();
      return { requirement };
    } catch (error) {
      throw apiError(error);
    }
  }

  async dispatchNextExplicitRequirement(): Promise<ExplicitBrainDispatchReceipt> {
    const dispatched = await this.dispatchNextExplicitRequirementInternal();
    if (dispatched) return dispatched;
    throw new UiRuntimeApiError(
      'explicit-brain.inbox.empty',
      RUNTIME_OWNER,
      'requirement inbox has no pending entry',
      'wait for a confirmed requirement',
      409,
    );
  }

  private async dispatchNextExplicitRequirementInternal(): Promise<ExplicitBrainDispatchReceipt | null> {
    let release!: () => void;
    const previous = this.dispatchTail;
    this.dispatchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let consumed: RequirementEnvelope | null = null;
    let dispatchEntry: DispatchLedgerEntry | undefined;
    try {
      consumed = await this.requirementInbox.peekNext({ consumerId: RUNTIME_OWNER });
      if (!consumed) return null;
      this.implicitConsumerRequirement = {
        requirementId: consumed.requirementId,
        draftId: consumed.draftId,
        fifoSeq: consumed.fifoSeq,
      };
      const existingDispatch = this.dispatchLedger.get(consumed.draftId);
      if (existingDispatch) dispatchEntry = existingDispatch;
      else {
        this.classifyAndAdmitConfirmedRequirement(consumed);
        dispatchEntry = {
          draftId: consumed.draftId,
          taskId: consumed.taskRef ?? id('task', `ui-task-implicit-${consumed.draftId}`),
          operationId: id('operation', `ui-operation-implicit-${consumed.draftId}`),
        };
        this.dispatchLedger.set(consumed.draftId, dispatchEntry);
        this.persistExplicitBrainState();
      }
      return await this.completePreparedDispatch(consumed, dispatchEntry);
    } catch (error) {
      if (consumed) {
        this.requirementInbox.restoreAcknowledged({
          consumerId: RUNTIME_OWNER,
          requirementId: consumed.requirementId,
        });
        if (dispatchEntry) this.dispatchLedger.set(consumed.draftId, dispatchEntry);
      }
      throw apiError(error);
    } finally {
      release();
    }
  }

  private async completePreparedDispatch(
    consumed: RequirementEnvelope,
    prepared: DispatchLedgerEntry,
  ): Promise<ExplicitBrainDispatchReceipt> {
    const existingTask = this.coordinator.taskSnapshots().find((task) => task.taskId.value === prepared.taskId.value);
    const task = existingTask ?? (consumed.taskRef
      ? this.coordinator.taskSnapshot(consumed.taskRef)
      : this.coordinator.createTask({
          taskId: prepared.taskId,
          title: consumed.normalizedInput,
          directive: consumed.normalizedInput,
        }));
    const operationId = prepared.operationId;
    let executionEpoch = prepared.executionEpoch;
    if (executionEpoch === undefined) {
      if (task.operationId === operationId.value && task.executionEpoch !== undefined) {
        executionEpoch = task.executionEpoch;
      } else {
        const execution = this.coordinator.startExecution(task.taskId, {
          prompt: consumed.normalizedInput,
          ...(this.options.runtimeComposition?.createTaskAssembly === undefined ? {} : { orchestrate: true }),
          operationId,
        });
        executionEpoch = execution.executionEpoch;
      }
      const started: DispatchLedgerEntry = {
        ...prepared,
        operationId,
        executionEpoch,
      };
      this.dispatchLedger.set(consumed.draftId, started);
      this.persistExplicitBrainState();
    }
    this.watchExecutionForImplicitWakeup(operationId);
    await this.explicitIntake.markDraftDispatched(consumed.draftId);
    this.persistExplicitBrainState();
    const requirement = await this.requirementInbox.acknowledge({
      consumerId: RUNTIME_OWNER,
      requirementId: consumed.requirementId,
    });
    this.persistExplicitBrainState();
    this.dispatchLedger.delete(consumed.draftId);
    this.persistExplicitBrainState();
    this.implicitConsumerRequirement = undefined;
    return {
      requirement,
      taskId: task.taskId,
      operationId,
      executionEpoch,
    };
  }

  private classifyAndAdmitConfirmedRequirement(envelope: RequirementEnvelope): RequirementAdmissionReceipt {
    const status = this.status();
    const health = status.state === 'ready'
      ? 'healthy'
      : status.state === 'degraded'
        ? 'degraded'
        : status.state === 'unknown'
          ? 'unknown'
          : 'unhealthy';
    const availableCapabilities = status.state === 'ready' || status.state === 'degraded'
      ? [PROVIDER_EXECUTION_CAPABILITY]
      : [];
    const queue = classifyConfirmedRequirement(envelope);
    const tasks = this.coordinator.taskSnapshots();
    return admitRequirement({
      envelope,
      queue: defaultAdmissionQueueConfig(queue),
      registeredQueues: ADMISSION_QUEUE_KINDS,
      queueLoad: {
        running: tasks.filter((task) => task.state === 'running' || task.state === 'settling').length,
        queued: tasks.filter((task) => task.state === 'created' || task.state === 'admitted').length,
      },
      requiredCapabilities: [PROVIDER_EXECUTION_CAPABILITY],
      availableCapabilities,
      health,
      requiredInputRefs: [envelope.payloadRef],
      providedInputRefs: [envelope.payloadRef],
      checkpoint: { recoverable: true },
      ownerId: 'runtime-coordinator',
    });
  }

  private scheduleImplicitConsumption(): void {
    if (!this.implicitConsumerEnabled || this.implicitConsumerScheduled) return;
    this.implicitConsumerScheduled = true;
    queueMicrotask(() => {
      this.implicitConsumerScheduled = false;
      void this.consumePendingRequirements().catch((error) => {
        this.implicitConsumerIssue = apiError(error);
      });
    });
  }

  private async consumePendingRequirements(): Promise<void> {
    while (this.implicitConsumerEnabled) {
      try {
        const dispatched = await this.dispatchNextExplicitRequirementInternal();
        if (!dispatched) {
          this.implicitConsumerIssue = undefined;
          this.implicitConsumerRequirement = undefined;
          return;
        }
        this.implicitConsumerIssue = undefined;
      } catch (error) {
        const issue = apiError(error);
        this.implicitConsumerIssue = issue;
        if (issue.code === 'implicit-admission.waiting' || issue.code === 'implicit-admission.blocked') return;
        throw issue;
      }
    }
  }

  private watchExecutionForImplicitWakeup(operationId: OperationId): void {
    if (this.implicitWatchedOperations.has(operationId.value)) return;
    this.implicitWatchedOperations.add(operationId.value);
    let unsubscribe: () => void = () => {};
    const finish = (): void => {
      if (!this.implicitWatchedOperations.delete(operationId.value)) return;
      unsubscribe();
      this.scheduleImplicitConsumption();
    };
    const subscription = this.coordinator.subscribeReplay(operationId, undefined, (event) => {
      if (event.kind !== 'execution.terminal' || event.terminalPhase !== 'final') return;
      finish();
    });
    unsubscribe = subscription.unsubscribe;
    if (subscription.replay.some((event) => event.kind === 'execution.terminal' && event.terminalPhase === 'final')) finish();
  }

  private implicitSchedulingProjection(): import('../../../ui/contracts/runtime.js').RuntimeStatusProjection['implicitScheduling'] {
    if (!this.implicitConsumerIssue) return undefined;
    const pendingState = this.requirementInbox.exportState();
    const pendingDraftId = pendingState.pendingDraftIds[0];
    const pending = pendingDraftId
      ? pendingState.envelopes.find((envelope) => envelope.draftId === pendingDraftId)
      : undefined;
    const requirement = this.implicitConsumerRequirement ?? pending;
    if (!requirement) return undefined;
    return {
      state: this.implicitConsumerIssue.code === 'implicit-admission.waiting'
        ? 'waiting'
        : this.implicitConsumerIssue.code === 'implicit-admission.blocked'
          ? 'blocked'
          : 'failed',
      code: this.implicitConsumerIssue.code,
      ownerId: this.implicitConsumerIssue.ownerId,
      message: this.implicitConsumerIssue.message,
      nextAction: this.implicitConsumerIssue.nextAction,
      requirementId: requirement.requirementId,
      draftId: requirement.draftId,
      fifoSeq: requirement.fifoSeq,
    };
  }

  private persistExplicitBrainState(): void {
    (this.options.interactionJournal ?? this.options.journal)?.append({
      kind: 'explicit-brain.state',
      state: {
        intake: this.explicitIntake.exportState(),
        inbox: this.requirementInbox.exportState(),
        confirmationLedger: this.confirmationLedger.exportState(),
        dispatchLedger: [...this.dispatchLedger.values()].map((entry) => structuredClone(entry)),
        submittedSubmissions: this.requirementSubmissions.submittedReceipts() as readonly PersistedSubmittedReceipt[],
        decisionTraces: this.explicitBrainTraceRecords.map((record) => structuredClone(record)),
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
