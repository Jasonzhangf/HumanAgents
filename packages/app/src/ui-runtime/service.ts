import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  type ScopeRef,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderEvent,
  type StopRequestReceipt,
  type TaskId,
  canonicalJsonStringify,
  type AuthorizedRequirement,
  type DraftRevision,
  type DraftRevisionInput,
  type DraftRejectClosure,
  type ExecutionPolicyDefinition,
  type Subscription,
  type InteractionDecision,
  type WorkResult,
} from '../../../contracts/src/index.js';
import { DraftRevisionError } from '../../../core/src/draft-revision.js';
import type { AttentionPort } from '../../../runtime/src/control/attention.js';
import { loadBuiltinAgentTemplate, type MemoryContextPolicy } from '../../../agent-templates/src/index.js';
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
  type RequirementTerminalOutcome,
} from '../../../runtime/src/intake/requirement-inbox.js';
import {
  type ConfirmationLedgerState,
  ConfirmationLedger,
  ExecutionPolicyCompiler,
  ExplicitBrainRouterError,
  type PersistedSubmittedReceipt,
  type PersistedFinalSubmitReceipt,
  RequirementSubmissionOwner,
  type RequirementSubmitReceipt,
} from '../../../runtime/src/explicit-brain/router.js';
import {
  SubscriptionControlError,
  type SubscriptionControlPort,
  type SubscriptionSnapshot,
} from '../../../runtime/src/subscriptions/index.js';
import { ExplicitIntakeError, IntakeError } from '../../../runtime/src/intake/errors.js';
import {
  ADMISSION_QUEUE_KINDS,
  ImplicitBrainFifo,
  RequirementAdmissionError,
  admitRequirement,
  classifyConfirmedRequirement,
  defaultAdmissionQueueConfig,
  type AdmissionQueueKind,
  type RequirementAdmissionReceipt,
} from '../../../runtime/src/admission/index.js';
import type { RequirementEnvelope } from '../../../contracts/src/index.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  RuntimeTaskEvent,
  producedArtifactBody,
  producedArtifactPaths,
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
  type ProviderToolExecutionPort,
} from '../../../adapters/provider/src/index.js';
import {
  type RuntimeDashboardProjection,
  type RuntimeSseEvent,
  type RuntimeStatusProjection,
  type RuntimeTaskDashboardProjection,
  type RuntimeTaskErrorProjection,
  type RuntimeTaskEventProjection,
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
import { readProducedArtifacts } from '../provider-tool-execution.js';
import type { UiRuntimeJournal } from './journal.js';
import { digestOf, type ExecutionAgentPort, type RetryCycleConfigSet } from '../../../runtime/src/orchestration/index.js';
import { createJsonlRetryCycleJournalPort, retryCycleJournalFilePath } from '../retry-cycle-journal.js';
import {
  createExplicitBrainRuntime,
  type ExplicitBrainRuntime,
} from '../explicit-brain-runtime.js';

const APP_OWNER = 'humanagent.app';
const RUNTIME_OWNER = 'humanagent.runtime';
const PROVIDER_EXECUTION_CAPABILITY = 'provider.execution';
// Keep the confirmed FIFO entry observable through real HTTP reads (status and
// task list) before the background drain starts consuming it. A macrotask-only
// delay is too short for a second localhost request to sample the queued state.
const QUEUED_VISIBILITY_WINDOW_MS = 100;

type RuntimeTaskDashboardView = RuntimeTaskDashboardProjection & {
  readonly history: {
    readonly events: readonly RuntimeTaskEventProjection[];
    readonly hasMore: boolean;
    readonly total: number;
    readonly omitted: number;
    readonly gap: boolean;
  };
  readonly statusSections: {
    readonly business: string;
    readonly waiting: string;
    readonly connection: string;
  };
};

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
  readonly providerTools?: import('../../../contracts/src/index.js').ProviderToolDefinition[];
  readonly providerToolExecutor?: ProviderToolExecutionPort;
  /**
   * Upper bound on provider tool rounds per execution. Real long-horizon tasks
   * need more than a couple of rounds, so the bound is an explicit assembly
   * decision rather than an adapter default.
   */
  readonly providerToolRoundLimit?: number;
  readonly toolOutputStore?: import('../provider-tool-execution.js').UiRuntimeToolOutputStore;
  readonly explicitBrainAgentMessage?: (input: {
    readonly recipientRef: string;
    readonly messageRef: string;
    readonly messageClass: 'control' | 'data' | 'observation';
  }) => Promise<unknown>;
  readonly explicitBrainAgentQuery?: (input: { readonly agentRef: string; readonly scopeRef: string }) => Promise<unknown>;
  readonly explicitBrainAgentTargets?: readonly ExplicitBrainAgentTarget[];
  readonly explicitBrainInterpreter: ExplicitBrainInputInterpreter;
  readonly memory: UiRuntimeMemoryComposition;
  /**
   * The single owner of persisted execution plans (subscriptions). The app
   * assembly injects the durable port; the service only wires the confirmed
   * revision's execution policy into it.
   */
  readonly subscriptionControl?: SubscriptionControlPort;
  readonly providerRetryConfig?: {
    readonly config: RetryCycleConfigSet;
    readonly journalRoot: string;
  };
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

/**
 * The new-task form's single authorization submit. When it carries an
 * execution policy the runtime takes the typed draft-revision path: it creates
 * or refines the exact revision, confirms it, and submits it once. Without an
 * execution policy the legacy confirmation path is unchanged.
 */
export interface ConfirmExplicitRequirementInput extends ConfirmRequirementDraft {
  readonly executionPolicy?: ExecutionPolicyDefinition;
  readonly goal?: string;
  readonly scope?: string;
  readonly constraints?: readonly string[];
  readonly deliverables?: readonly string[];
  readonly idempotencyKey?: string;
  readonly draftRevisionVersion?: number;
  readonly draftRevisionHash?: string;
}

export interface RefineExplicitDraftInput {
  readonly draftId: string;
  readonly baseRevisionVersion: number;
  readonly requestedRevisionHash: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly instructionRef?: string;
  readonly idempotencyKey?: string;
}

export interface ExplicitBrainDispatchReceipt {
  readonly requirement: InboxReceipt;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
}

type ExplicitBrainDispatchAttempt =
  | { readonly kind: 'dispatched'; readonly receipt: ExplicitBrainDispatchReceipt }
  | { readonly kind: 'retired'; readonly outcome: RequirementTerminalOutcome }
  | { readonly kind: 'empty' };

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

interface RequirementAdmissionObservation {
  readonly taskId: TaskId;
  readonly queue: AdmissionQueueKind;
  readonly receipt: RequirementAdmissionReceipt;
}

interface QueuedRequirementObservation {
  readonly requirementId: string;
  readonly draftId: string;
  readonly fifoSeq: number;
  readonly normalizedInput: string;
  readonly queue: AdmissionQueueKind;
}

function validateRequirementAdmissionReceipt(value: unknown): RequirementAdmissionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UiRuntimeApiError(
      'ui-runtime.journal.invalid-admission',
      APP_OWNER,
      'persisted requirement admission receipt is not an object',
      'repair the UI runtime journal before restoring the requirement admission projection',
      500,
    );
  }
  const receipt = value as Partial<RequirementAdmissionReceipt>;
  const classified = receipt.classified;
  const decision = receipt.decision;
  if (
    !classified
    || !ADMISSION_QUEUE_KINDS.includes(classified.queue)
    || !decision
    || !['admitted', 'waiting', 'blocked'].includes(decision.status)
    || decision.queue !== classified.queue
  ) {
    throw new UiRuntimeApiError(
      'ui-runtime.journal.invalid-admission',
      APP_OWNER,
      'persisted requirement admission receipt has an invalid classified queue or decision',
      'repair the UI runtime journal before restoring the requirement admission projection',
      500,
    );
  }
  return receipt as RequirementAdmissionReceipt;
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
  admission: RequirementAdmissionObservation | undefined,
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
    case 'implicit.classify':
      return admission
        ? {
          node: {
            ...base,
            state: 'succeeded',
            summary: `已分类为 ${admission.queue} 队列（${admission.receipt.decision.condition}）。`,
            outputRefs: [`task://${task.taskId.value}/queue/${admission.queue}`],
            activity: [{
              activityRef: `task://${task.taskId.value}/admission/${admission.receipt.decision.queue}`,
              summary: admission.receipt.decision.reason,
              occurredAt: task.updatedAt,
            }],
          },
          projected: true,
        }
        : { node: unprojected, projected: false };
    case 'interactive.queue':
    case 'execution.queue':
    case 'research.queue':
    case 'maintenance.queue': {
      const queue = definition.nodeId.slice(0, -'.queue'.length) as AdmissionQueueKind;
      if (!admission) return { node: unprojected, projected: false };
      const selected = admission.queue === queue;
      return {
        node: {
          ...base,
          state: selected ? 'admitted' : 'created',
          summary: selected
            ? `已选择 ${queue} 队列并完成准入：${admission.receipt.decision.reason}`
            : `本次需求分类为 ${admission.queue}，未选择 ${queue} 队列。`,
          outputRefs: selected ? [`task://${task.taskId.value}/queue/${queue}`] : [],
          activity: [{
            activityRef: `task://${task.taskId.value}/queue/${queue}/classification`,
            summary: selected
              ? `selected=${queue}; condition=${admission.receipt.decision.condition}`
              : `selected=${admission.queue}; condition=${admission.receipt.decision.condition}`,
            occurredAt: task.updatedAt,
          }],
        },
        projected: true,
      };
    }
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
      // Memory analysis has its own durable owner and projection. A task or
      // orchestration state alone does not prove that this task's Memory
      // operation was requested, running, or completed.
      return { node: unprojected, projected: false };
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
  const calls = new Map<string, RuntimeTaskEvent>();
  for (const event of task.events.filter((item) => item.kind === 'provider.tool')) {
    const key = event.callId ?? `${event.eventId}`;
    if (!calls.has(key)) calls.set(key, event);
  }
  const resultsByCall = new Map<string, RuntimeTaskEvent>();
  for (const event of task.events.filter((item) => item.kind === 'provider.tool-result')) {
    const key = event.callId ?? event.eventId;
    if (!resultsByCall.has(key)) resultsByCall.set(key, event);
  }
  const steps: ObservationNodeToolStepSource[] = [];
  for (const [key, call] of calls) {
    const result = resultsByCall.get(key);
    const status = result ? resultStatus(result) : 'unknown';
    const name = result?.toolId ?? call.toolId ?? '未标注工具';
    const stepId = call.callId ?? result?.callId ?? call.eventId;
    const durationMs = result
      ? Math.max(0, Date.parse(result.occurredAt) - Date.parse(call.occurredAt))
      : undefined;
    const returned = result
      ? [
          `status=${status}`,
          result.outputRef ? `outputRef=${result.outputRef}` : result.outputDigest ? `outputDigest=${result.outputDigest}` : 'output=missing',
          call.arguments === undefined ? '' : `arguments=${JSON.stringify(call.arguments)}`,
          result.error ? `error=${result.error.code}: ${result.error.message}` : '',
          Number.isFinite(durationMs) ? `durationMs=${durationMs}` : '',
          result.evidenceRefs.length > 0 ? `evidenceRefs=${result.evidenceRefs.length}` : '',
        ].filter(Boolean).join(' · ')
      : [
          'status=unknown',
          `call=${call.summary.trim() || call.eventId}`,
          call.arguments === undefined ? '' : `arguments=${JSON.stringify(call.arguments)}`,
        ].filter(Boolean).join(' · ');
    if (!stepId.trim() || !name.trim()) continue;
    steps.push({
      stepId,
      name,
      status,
      returned,
      occurredAt: call.occurredAt,
    });
  }
  return steps;
}

function runtimeTaskDashboard(
  task: RuntimeTaskSnapshot,
  mode: 'fake' | 'rcc',
): RuntimeTaskDashboardView {
  const projected = projectRuntimeTaskDashboard(task, mode);
  const history = task.events;
  const omitted = Math.max(0, history.length - task.recentEvents.length);
  const stateLabel = projected.stateLabel;
  const hasCheckpoint = task.checkpoint !== undefined;
  const resultAvailable = task.output.trim().length > 0;
  const requestedStopWithoutReceipt = (task.state === 'stopped' || task.state === 'cancelled') && !hasCheckpoint;
  return {
    ...projected,
    history: {
      events: history.slice(),
      hasMore: omitted > 0,
      total: history.length,
      omitted,
      gap: omitted > 0,
    },
    statusSections: {
      business: resultAvailable
        ? `${stateLabel} · 结果可用`
        : requestedStopWithoutReceipt
          ? '停止 / 取消请求已受理 · 尚未收拢'
        : task.state === 'succeeded'
          ? '已完成 · 结果不可用'
          : hasCheckpoint
            ? `${stateLabel} · checkpoint 已提交`
            : stateLabel,
      waiting: hasCheckpoint
        ? `已收拢：${task.checkpoint!.outcome} · checkpoint seq=${task.checkpoint!.seq}`
        : task.state === 'running'
          ? `等待执行结果：${task.currentNode}`
          : task.state === 'settling'
            ? `等待 checkpoint 收拢：${task.currentNode}`
            : task.state === 'blocked'
              ? '等待资源或人工处理后才能继续'
              : task.state === 'failed'
                ? '执行失败；等待错误证据和资源收拢'
                : task.state === 'stopped' || task.state === 'cancelled'
                  ? `停止/取消请求已受理；等待收拢 receipt（当前节点：${task.currentNode}）`
                  : `当前节点：${task.currentNode}`,
      connection: '由浏览器 SSE 连接状态呈现',
    },
  };
}

function resultStatus(event: RuntimeTaskEvent): ObservationNodeToolStepSource['status'] {
  if (event.status === 'succeeded' || event.status === 'failed' || event.status === 'blocked' || event.status === 'cancelled') return event.status;
  if (event.error) return 'failed';
  if (event.kind === 'provider.tool-result') return 'succeeded';
  return 'unknown';
}

/**
 * Build the execution input for a revision edit from the user-facing fields.
 * Callers that submit structured text fields (goal/scope/constraints/
 * deliverables) do not repeat the same content in a technical field. Policy
 * binding uses the core's policy-only refinement path instead.
 */
function normalizedInputForDraftFields(
  current: DraftRevision,
  fields: Readonly<Record<string, unknown>>,
): string {
  if (typeof fields.normalizedInput === 'string') return fields.normalizedInput;
  const goal = typeof fields.goal === 'string' ? fields.goal : current.goal;
  const scope = typeof fields.scope === 'string' ? fields.scope : current.scope;
  const constraints = Array.isArray(fields.constraints)
    ? fields.constraints.filter((entry): entry is string => typeof entry === 'string')
    : current.constraints;
  const deliverables = Array.isArray(fields.deliverables)
    ? fields.deliverables.filter((entry): entry is string => typeof entry === 'string')
    : current.deliverables;
  return canonicalJsonStringify({
    goal,
    scope,
    constraints,
    deliverables,
  });
}

function apiError(error: unknown): UiRuntimeApiError {
  if (error instanceof UiRuntimeApiError) return error;
  if (error instanceof IntakeError) {
    return new UiRuntimeApiError(error.name, error.owner, error.message, error.nextAction, 409);
  }
  if (error instanceof DraftRevisionError) {
    // The draft-revision owner keeps the original failure code and message so a
    // stale revision is rejected with a readable, structured error instead of a
    // generic 500.
    return new UiRuntimeApiError(
      `explicit-draft.${error.code}`,
      'humanagent.core.draft-revision',
      error.message,
      error.code === 'stale-revision' || error.code === 'confirmation-stale' || error.code === 'revision-hash-mismatch'
        ? 'reload the current draft revision and confirm the exact version'
        : 'inspect the draft revision before retrying',
      409,
    );
  }
  if (error instanceof SubscriptionControlError) {
    return new UiRuntimeApiError(
      `execution-plan.${error.code}`,
      RUNTIME_OWNER,
      error.message,
      'inspect the persisted execution plan before resubmitting',
      error.code === 'not-found' ? 404 : 409,
    );
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
  private readonly subscriptionControl?: SubscriptionControlPort;
  private readonly dispatchLedger = new Map<string, DispatchLedgerEntry>();
  private readonly requirementAdmissions = new Map<string, RequirementAdmissionObservation>();
  private readonly queuedRequirements = new Map<string, QueuedRequirementObservation>();
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
  private implicitConsumerTimer: ReturnType<typeof setTimeout> | undefined;
  private implicitConsumptionRun: Promise<void> | undefined;
  private implicitConsumerIssue: UiRuntimeApiError | undefined;
  private implicitTerminalIssue: UiRuntimeApiError | undefined;
  private implicitTerminalRequirement: Pick<RequirementEnvelope, 'requirementId' | 'draftId' | 'fifoSeq'> | undefined;
  private implicitConsumerRequirement: Pick<RequirementEnvelope, 'requirementId' | 'draftId' | 'fifoSeq'> | undefined;
  private readonly implicitWatchedOperations = new Set<string>();
  private readonly implicitBrain: ImplicitBrainFifo;
  private connected = true;

  constructor(private readonly options: UiRuntimeServiceOptions) {
    this.memory = options.memory;
    this.subscriptionControl = options.subscriptionControl;
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
      ...(options.providerRetryConfig === undefined
        ? {}
        : {
            providerRetry: {
              config: options.providerRetryConfig.config,
              journal: createJsonlRetryCycleJournalPort({
                filePath: retryCycleJournalFilePath({ journalRoot: options.providerRetryConfig.journalRoot }),
              }),
              createDriverForBinding: (bindingId, input) => this.createMemoryBoundDriverForBinding(bindingId, input),
            },
          }),
      ...(options.runtimeComposition === undefined ? {} : {
        ...(options.runtimeComposition.createTaskAssembly === undefined ? {} : {
          createTaskAssembly: (input) => options.runtimeComposition!.createTaskAssembly!(input),
        }),
      }),
      implicitSubtaskExecutionAgent: this.createImplicitSubtaskExecutionAgent(),
      ...(options.workspaceRoot === undefined ? {} : {
        producedArtifacts: {
          read: (request) => readProducedArtifacts(options.workspaceRoot!, request.paths),
        },
      }),
      ...(this.memory.checkpointBoundary === undefined ? {} : { checkpointBoundary: this.memory.checkpointBoundary }),
    });
    this.implicitBrain = new ImplicitBrainFifo({
      inbox: this.requirementInbox,
      consumerId: RUNTIME_OWNER,
      ownerId: RUNTIME_OWNER,
      admit: (input) => {
        this.implicitConsumerRequirement = {
          requirementId: input.envelope.requirementId,
          draftId: input.envelope.draftId,
          fifoSeq: input.envelope.fifoSeq,
        };
        return this.classifyAndAdmitConfirmedRequirement(input.envelope);
      },
      retireHead: (input) => this.retireMissingTaskRefHead(input.envelope),
      dispatchRequirement: (input) => this.dispatchConfirmedRequirementThroughCoordinator(
        input.envelope,
        input.admission,
        input.scope,
        input.inputRevision,
      ),
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

  /**
   * Task-scoped tool output read. The descriptor is looked up through the
   * (taskId, operationId, executionEpoch, seq) event identity — never through a
   * bare callId — and the report is re-verified against its sha256 digest before
   * it is returned. The response carries only the report body, never artifact
   * file paths on the host.
   */
  async toolOutput(taskId: TaskId, operationId: OperationId, executionEpoch: number, seq: number): Promise<unknown> {
    const task = this.coordinatorOrQueuedTaskSnapshot(taskId);
    const event = task.events.find((candidate) => (
      candidate.operationId === operationId.value
      && candidate.executionEpoch === executionEpoch
      && candidate.seq === seq
    ));
    if (event === undefined) {
      throw new UiRuntimeApiError(
        'tool-output.event-not-found',
        RUNTIME_OWNER,
        `no event ${seq} on operation ${operationId.value} for task ${taskId.value}`,
        'select a recorded tool result event',
        404,
      );
    }
    if (event.toolId === undefined || event.status !== 'succeeded' || event.outputRef === undefined || event.outputDigest === undefined) {
      throw new UiRuntimeApiError(
        'tool-output.not-available',
        RUNTIME_OWNER,
        'the event is not a succeeded tool result with an immutable output descriptor',
        'select a succeeded file.search result event',
        409,
      );
    }
    if (this.options.toolOutputStore === undefined) {
      throw new UiRuntimeApiError(
        'tool-output.reader-unavailable',
        RUNTIME_OWNER,
        'the tool output report store is not bound',
        'restart the runtime with the provider tool report store',
        501,
      );
    }
    try {
      return await this.options.toolOutputStore.readReport({
        outputRef: event.outputRef,
        outputDigest: event.outputDigest,
      });
    } catch (error) {
      throw new UiRuntimeApiError(
        'tool-output.report-missing-or-changed',
        RUNTIME_OWNER,
        error instanceof Error ? error.message : 'the tool output report could not be verified against its digest',
        'inspect the report store for the descriptor',
        409,
      );
    }
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
    return this.createMemoryBoundDriverForBinding(this.options.binding.bindingId, input);
  }

  private findProviderRetryBinding(bindingId: string): ProviderBinding | undefined {
    return this.options.providerRetryConfig?.config.candidates.find((candidate) => candidate.binding.bindingId === bindingId)?.binding;
  }

  private createMemoryBoundDriverForBinding(bindingId: string, input: RuntimeExecutionDriverInput): RuntimeExecutionDriver {
    const binding = this.findProviderRetryBinding(bindingId) ?? this.options.binding;
    const driver = new ProviderAgentDriver({
      port: this.options.port,
      binding,
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      operationId: input.operationId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      scope: input.scope,
      inputRefs: input.inputRefs,
      ownerId: input.ownerId,
      ...(this.options.providerTools === undefined ? {} : { tools: this.options.providerTools }),
      ...(this.options.providerToolExecutor === undefined ? {} : { executeTool: this.options.providerToolExecutor }),
      ...(this.options.providerToolRoundLimit === undefined ? {} : { maxToolRounds: this.options.providerToolRoundLimit }),
    });
    return new MemoryBoundExecutionDriver(driver, input, this.memory, this.memoryInjection, (bound) => {
      this.memoryContexts.set(input.operationId.value, bound);
    });
  }

  private createImplicitSubtaskExecutionAgent(): ExecutionAgentPort {
    const activeDrivers = new Map<string, ProviderAgentDriver>();
    return {
      execute: async (input): Promise<WorkResult> => {
        const runtimeId = `implicit-executor-${input.assignment.assignmentId}-${input.attempt}-${input.executionEpoch}`;
        const operationId = id('operation', `implicit-${input.assignment.assignmentId}-${input.attempt}`);
        const driver = new ProviderAgentDriver({
          port: this.options.port,
          binding: this.options.binding,
          runtimeId,
          taskId: input.assignment.taskId,
          operationId,
          executionEpoch: input.executionEpoch,
          assignmentId: input.assignment.assignmentId,
          scope: { ...input.scope, operationId },
          inputRefs: [...input.assignment.targetRefs, input.assignment.objective],
          ownerId: RUNTIME_OWNER,
          ...(this.options.providerTools === undefined ? {} : { tools: this.options.providerTools }),
          ...(this.options.providerToolExecutor === undefined ? {} : { executeTool: this.options.providerToolExecutor }),
          ...(this.options.providerToolRoundLimit === undefined ? {} : { maxToolRounds: this.options.providerToolRoundLimit }),
        });
        activeDrivers.set(input.assignment.assignmentId, driver);
        let started = false;
        const events: Array<AgentEvent & { readonly providerEvent?: ProviderEvent }> = [];
        try {
          await driver.start({
            runtimeId,
            taskId: input.assignment.taskId,
            executionEpoch: input.executionEpoch,
            assignmentId: input.assignment.assignmentId,
            organId: input.scope.organId,
            ...(input.scope.cycleId === undefined ? {} : { cycleId: input.scope.cycleId }),
            operationId,
          });
          started = true;
          await driver.submit({
            taskId: input.assignment.taskId,
            executionEpoch: input.executionEpoch,
            assignmentId: input.assignment.assignmentId,
            payload: { prompt: input.assignment.objective },
          });
          for await (const event of driver.observe({ runtimeId })) {
            events.push(event);
            if (event.terminalState !== undefined) break;
          }
        } catch (error) {
          if (started) {
            try {
              await driver.settle({ runtimeId, executionEpoch: input.executionEpoch });
            } catch (settlementError) {
              throw new Error(
                `implicit executor failed and settlement also failed: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`,
                { cause: error },
              );
            }
          }
          throw error;
        }
        await driver.settle({ runtimeId, executionEpoch: input.executionEpoch });
        const settlement = driver.settlement();
        if (!settlement) throw new Error('implicit executor did not expose settlement');
        const producedOutput = events
          .filter((event) => event.providerEvent?.kind === 'output' && event.summary !== undefined)
          .map((event) => event.summary ?? '')
          .join('');
        const status: WorkResult['status'] = settlement.state === 'succeeded'
          ? 'succeeded'
          : settlement.state === 'waiting'
            ? 'incomplete'
            : settlement.state === 'blocked'
              ? 'blocked'
              : settlement.state === 'failed' || settlement.state === 'unknown'
                ? 'failed'
                : 'cancelled';
        const nextAction: WorkResult['nextAction'] = status === 'succeeded'
          ? 'review'
          : status === 'incomplete'
            ? 'wait'
            : status === 'blocked' || status === 'failed'
              ? 'attention'
              : 'settle';
        const evidenceRefs = [
          ...events.flatMap((event) => event.evidenceRefs),
          ...settlement.evidenceRefs,
        ];
        const scopedEvidenceRefs = [
          ...new Map(
            evidenceRefs.map((ref) => [ref.evidenceId.value, { ...ref, scope: { ...input.scope } }]),
          ).values(),
        ];
        const outputRefs = input.assignment.expectedOutputRefs.length > 0
          ? [...input.assignment.expectedOutputRefs]
          : [...input.assignment.targetRefs];
        const producedPaths = producedArtifactPaths(events);
        const producedFiles = this.options.workspaceRoot === undefined || producedPaths.length === 0
          ? []
          : await readProducedArtifacts(this.options.workspaceRoot, producedPaths);
        const artifactBody = producedArtifactBody(producedOutput, producedFiles);
        return {
          taskId: input.assignment.taskId,
          pipelineNodeId: input.assignment.pipelineNodeId,
          agentId: input.agentId,
          assignmentId: input.assignment.assignmentId,
          attempt: input.assignment.attempt,
          executionEpoch: input.executionEpoch,
          inputRevision: input.assignment.inputRevision,
          producedArtifactRefs: outputRefs,
          producedArtifactDigests: outputRefs.map(() => digestOf(artifactBody)),
          producedArtifactBodies: outputRefs.map(() => artifactBody),
          status,
          summary: producedOutput.trim() === ''
            ? `implicit executor ${input.agentId} ${status}`
            : `implicit executor ${input.agentId} ${status}: ${producedOutput.trim()}`,
          outputRefs,
          evidenceRefs: scopedEvidenceRefs,
          nextAction,
          ...(status === 'incomplete'
            ? { conditionRef: settlement.nextAction?.ref ?? `operation://${operationId.value}/waiting` }
            : {}),
          ...(status === 'failed'
            ? { failureRef: settlement.nextAction?.ref ?? `operation://${operationId.value}/failed` }
            : {}),
        };
      },
    };
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
      implicitScheduling: this.implicitSchedulingProjection() ?? this.queuedRequirementProjection(),
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

  private withRequirementAdmission(task: RuntimeTaskSnapshot): RuntimeTaskSnapshotInput {
    const admission = this.requirementAdmissions.get(task.taskId.value);
    if (!admission) return task;
    const state = task.state === 'created'
      ? 'queued'
      : task.state === 'admitted'
        ? 'admitted'
        : task.state === 'running' || task.state === 'settling'
          ? 'executing'
          : task.state === 'succeeded'
            ? 'completed'
            : task.state === 'blocked' || task.state === 'waiting' || task.state === 'failed'
              ? 'blocked'
              : 'queued';
    return {
      ...task,
      requirementQueue: admission.queue,
      requirementAdmission: state,
      requirementAdmissionLabel: `需求${state} · ${admission.queue} 队列`,
    };
  }

  private queuedRequirementProjection(): RuntimeStatusProjection['implicitScheduling'] {
    return this.projectQueuedRequirement(this.queuedPendingRequirements());
  }

  private queuedBacklogProjection(headIssue: UiRuntimeApiError | undefined): RuntimeStatusProjection['implicitScheduling'] {
    const headDraftId = this.implicitConsumerRequirement?.draftId;
    const queued = this.queuedPendingRequirements().filter((candidate) => candidate.draftId !== headDraftId);
    const projection = this.projectQueuedRequirement(queued);
    if (!projection) return undefined;
    const head = this.implicitConsumerRequirement;
    if (!headIssue || !head) return projection;
    return {
      ...projection,
      message: `${projection.message} 前序需求 ${head.requirementId} 状态：${headIssue.code}。`,
    };
  }

  private queuedPendingRequirements(): readonly QueuedRequirementObservation[] {
    const pendingState = this.requirementInbox.exportState();
    const queued: QueuedRequirementObservation[] = [];
    for (const draftId of pendingState.pendingDraftIds) {
      const observation = this.queuedRequirements.get(draftId);
      if (observation) queued.push(observation);
    }
    return queued;
  }

  private projectQueuedRequirement(queued: readonly QueuedRequirementObservation[]): RuntimeStatusProjection['implicitScheduling'] {
    const first = queued[0];
    if (!first) return undefined;
    return {
      state: 'queued',
      code: 'explicit-brain.requirement-queued',
      ownerId: RUNTIME_OWNER,
      message: `已确认需求正在 ${first.queue} 队列等待准入。`,
      nextAction: 'wait for implicit admission to dispatch the queued requirement',
      requirementId: first.requirementId,
      draftId: first.draftId,
      fifoSeq: first.fifoSeq,
    };
  }

  private queuedTaskSnapshots(): readonly RuntimeTaskSnapshotInput[] {
    const coordinatorTaskIds = new Set(this.coordinator.taskSnapshots().map((task) => task.taskId.value));
    return this.queuedPendingRequirements().flatMap((candidate) => {
      const taskId = id('task', `ui-task-implicit-${candidate.draftId}`);
      // Once dispatch materializes the coordinator task under the same stable id,
      // the real task supersedes the synthetic queued row so listTasks has no
      // duplicate and the row link resolves to the coordinator task.
      if (coordinatorTaskIds.has(taskId.value)) return [];
      const envelope = this.requirementInbox.find(candidate.draftId);
      return [{
        taskId,
        title: candidate.normalizedInput,
        state: 'created' as const,
        requirementQueue: candidate.queue,
        requirementAdmission: 'queued' as const,
        requirementAdmissionLabel: `需求排队中 · ${candidate.queue} 队列`,
        currentState: '排队中',
        nextStep: 'wait for implicit admission to dispatch the queued requirement',
        updatedAt: envelope?.confirmedAt ?? this.now().toISOString(),
        input: candidate.normalizedInput,
        output: '',
        currentNode: 'implicit.classify',
        allowedActions: [],
        recentEvents: [],
      }];
    });
  }

  private queuedTaskSnapshot(taskId: TaskId): RuntimeTaskSnapshotInput | undefined {
    return this.queuedTaskSnapshots().find((candidate) => candidate.taskId.value === taskId.value);
  }

  /**
   * A queued requirement has no coordinator task yet, so read surfaces that
   * need the coordinator snapshot shape get an explicit zero-fact projection:
   * the requirement exists, but nothing has been admitted or executed.
   */
  private queuedRuntimeTaskSnapshot(taskId: TaskId): RuntimeTaskSnapshot | undefined {
    const queued = this.queuedTaskSnapshot(taskId);
    if (!queued) return undefined;
    return {
      taskId: queued.taskId,
      title: queued.title,
      directive: queued.input,
      directiveRevision: 1,
      state: queued.state,
      currentState: queued.currentState,
      nextStep: queued.nextStep,
      updatedAt: queued.updatedAt,
      input: queued.input,
      output: queued.output,
      currentNode: queued.currentNode,
      orchestrated: false,
      allowedActions: queued.allowedActions,
      recentEvents: [],
      events: [],
    };
  }

  private coordinatorOrQueuedTaskSnapshot(taskId: TaskId): RuntimeTaskSnapshot {
    try {
      return this.coordinator.taskSnapshot(taskId);
    } catch (error) {
      if (error instanceof RuntimeTaskControlError && error.code === 'task.not.found') {
        const queued = this.queuedRuntimeTaskSnapshot(taskId);
        if (queued) return queued;
      }
      throw error;
    }
  }

  listTasks(): RuntimeTaskListProjection {
    return projectRuntimeTaskList({
      mode: this.mode,
      tasks: [
        ...this.queuedTaskSnapshots(),
        ...this.coordinator.taskSnapshots().map((task) => this.withRequirementAdmission(task)),
      ],
    });
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

  taskDashboard(taskId: TaskId): RuntimeTaskDashboardView {
    try {
      return runtimeTaskDashboard(this.coordinatorOrQueuedTaskSnapshot(taskId), this.mode);
    } catch (error) {
      throw apiError(error);
    }
  }

  taskDetail(taskId: TaskId): TaskDetailProjection {
    try {
      const task = this.coordinatorOrQueuedTaskSnapshot(taskId);
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
      const task = this.coordinatorOrQueuedTaskSnapshot(taskId);
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
      const admission = this.requirementAdmissions.get(task.taskId.value);
      const nodes: ObservationNodeSource[] = registry.map((definition) => {
        const facts = observationNodeFacts(definition, task, toolSteps, admission);
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
    this.requirementSubmissions.restoreFinalReceipts(
      (restored as RuntimeExplicitBrainJournalState & {
        readonly finalSubmissions?: readonly PersistedFinalSubmitReceipt[];
      }).finalSubmissions ?? [],
    );
    this.explicitBrainTraceRecords.length = 0;
    this.explicitBrainTraceRecords.push(...(restored.decisionTraces ?? []).map((record) => structuredClone(record)));
    this.dispatchLedger.clear();
    for (const entry of restored.dispatchLedger ?? []) {
      this.dispatchLedger.set(entry.draftId, structuredClone(entry));
    }
    this.requirementAdmissions.clear();
    for (const admission of restored.requirementAdmissions ?? []) {
      this.requirementAdmissions.set(admission.taskId.value, {
        taskId: admission.taskId,
        queue: admission.queue,
        receipt: validateRequirementAdmissionReceipt(admission.receipt),
      });
    }
    this.coordinator.restoreTaskInputRevisions(restored.taskInputRevisions ?? []);
    this.queuedRequirements.clear();
    const restoredInbox = this.requirementInbox.exportState();
    for (const draftId of restoredInbox.pendingDraftIds) {
      const envelope = restoredInbox.envelopes.find((candidate) => candidate.draftId === draftId);
      if (!envelope) continue;
      this.queuedRequirements.set(draftId, {
        requirementId: envelope.requirementId,
        draftId: envelope.draftId,
        fifoSeq: envelope.fifoSeq,
        normalizedInput: envelope.normalizedInput,
        queue: classifyConfirmedRequirement(envelope),
      });
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

  /**
   * Retires the runtime's background FIFO ownership: new implicit consumption is
   * disabled, the visibility timer is cancelled, and any already-running drain
   * cycle is awaited before the caller settles active executions.
   */
  async quiesceImplicitConsumption(): Promise<void> {
    this.implicitConsumerEnabled = false;
    if (this.implicitConsumerTimer !== undefined) {
      clearTimeout(this.implicitConsumerTimer);
      this.implicitConsumerTimer = undefined;
    }
    this.implicitConsumerScheduled = false;
    // A timer that already fired before the flag flipped can still be draining;
    // its loop observes the disabled flag and stops after the current dispatch.
    await this.implicitConsumptionRun;
    await this.dispatchTail;
  }

  implicitSchedulingIssue(): UiRuntimeApiError | undefined {
    return this.implicitConsumerIssue ?? this.implicitTerminalIssue;
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
        // The reviewable draft exists now, so mint the typed revision before
        // confirmation. The public GET can then project it for editing.
        await this.ensureTypedDraftRevision(snapshot.interactionId);
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

  /**
   * Apply a typed field edit to the current draft revision. The intake owns the
   * revision invariant: a stale base version/hash is rejected and the current
   * revision is left untouched. The app only validates and forwards.
   */
  async refineExplicitDraft(interactionId: string, input: RefineExplicitDraftInput): Promise<ExplicitInteractionSnapshot> {
    try {
      const instructionRef = input.instructionRef ?? 'user-edit';
      const current = this.explicitIntake.currentDraftRevision(interactionId);
      if (current === undefined) {
        throw new UiRuntimeApiError(
          'explicit-brain.typed-revision-required',
          'humanagent.runtime.explicit-intake',
          `interaction has no typed draft revision to refine: ${interactionId}`,
          'generate the reviewable draft before editing it',
          409,
        );
      }
      const fields = {
        ...input.fields,
        normalizedInput: normalizedInputForDraftFields(current, input.fields),
      };
      const idempotencyKey = input.idempotencyKey ?? `refine:${input.draftId}:${input.baseRevisionVersion}:${input.requestedRevisionHash}:${createHash('sha256').update(canonicalJsonStringify(fields)).digest('hex')}`;
      await this.explicitIntake.refineDraft(interactionId, {
        draftId: input.draftId,
        baseRevisionVersion: input.baseRevisionVersion,
        requestedRevisionHash: input.requestedRevisionHash,
        fields,
        instructionRef,
        idempotencyKey,
      });
      this.persistExplicitBrainState();
      return await this.explicitIntake.inspect(interactionId);
    } catch (error) {
      throw apiError(error);
    }
  }

  /**
   * Regenerate the reviewable draft ("重新整理"). Re-runs the explicit-brain
   * interpreter and applies the regenerated content to the current typed
   * revision as a refinement, so the caller observes a new revision identity.
   * When the interpreter returns the same execution input, the current revision
   * stays authoritative and no new revision is minted.
   */
  async regenerateExplicitDraft(interactionId: string, instruction?: string): Promise<ExplicitInteractionSnapshot> {
    try {
      const snapshot = await this.explicitIntake.inspect(interactionId);
      if (snapshot.state !== 'awaiting-confirmation' && snapshot.state !== 'awaiting-intent') {
        throw new UiRuntimeApiError(
          'explicit-brain.regeneration-state-invalid',
          'humanagent.runtime.explicit-brain',
          `explicit draft cannot be regenerated from ${snapshot.state}`,
          'inspect the current interaction state before regenerating the draft',
          409,
        );
      }
      const correction = instruction?.trim();
      const revision = this.explicitIntake.currentDraftRevision(interactionId);
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
        rawInput: correction === undefined || correction === ''
          ? snapshot.rawInput
          : `${snapshot.rawInput}\n\nUser correction: ${correction}`,
        clarifications: snapshot.clarifications ?? [],
        taskCandidates,
      });
      if (interpreted.kind !== 'requirement') {
        throw new UiRuntimeApiError(
          'explicit-brain.regeneration-not-a-requirement',
          'humanagent.runtime.explicit-brain',
          'regeneration only applies to requirement drafts',
          'answer the clarification or submit a new input instead',
          409,
        );
      }
      await this.explicitIntake.propose(interactionId, {
        proposedIntent: interpreted.intent,
        proposal: interpreted.proposal,
        decisionRefs: interpreted.decisionRefs,
      });
      if (revision !== undefined && interpreted.normalizedInput !== revision.normalizedInput) {
        await this.explicitIntake.refineDraft(interactionId, {
          draftId: revision.draftId,
          baseRevisionVersion: revision.revisionVersion,
          requestedRevisionHash: revision.revisionHash,
          fields: {
            goal: interpreted.proposal,
            scope: interpreted.normalizedInput,
            normalizedInput: interpreted.normalizedInput,
            proposal: interpreted.proposal,
            proposedIntent: interpreted.intent,
            knownFacts: interpreted.knownFacts,
          },
          instructionRef: `regenerate:${snapshot.sourceRef}`,
          idempotencyKey: `regenerate:${interactionId}:${revision.revisionVersion}:${canonicalJsonStringify(interpreted.normalizedInput)}`,
        });
      }
      this.persistExplicitBrainState();
      return await this.explicitIntake.inspect(interactionId);
    } catch (error) {
      throw apiError(error);
    }
  }

  /**
   * Formal draft rejection ("放弃"). Drives the typed reject through the router
   * owner so the closure is durable and the interaction can never be submitted,
   * and returns the closure receipt (reason + terminal revision identity).
   */
  async rejectExplicitDraftRevision(
    interactionId: string,
    input: { readonly reason: string; readonly rejectionId?: string; readonly closedAt?: string },
  ): Promise<DraftRejectClosure> {
    try {
      const closure = await this.requirementSubmissions.rejectDraftRevision(this.explicitIntake, {
        interactionId,
        reason: input.reason,
        ...(input.rejectionId === undefined ? {} : { rejectionId: input.rejectionId }),
        ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }),
      });
      this.persistExplicitBrainState();
      return closure;
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

  async confirmExplicitRequirement(input: ConfirmExplicitRequirementInput): Promise<ExplicitBrainReceipt> {
    try {
      // A typed draft revision (or an execution policy that requests one) must
      // final-submit through the exact revision path. The legacy path stays for
      // interactions that never created a typed revision.
      if (this.requiresTypedFinalSubmit(input)) {
        return await this.confirmTypedExplicitRequirement(input);
      }
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
      this.projectConfirmedRequirement(confirmed.draftId);
      this.persistExplicitBrainState();
      this.scheduleImplicitConsumption();
      return { requirement };
    } catch (error) {
      throw apiError(error);
    }
  }

  private requiresTypedFinalSubmit(input: ConfirmExplicitRequirementInput): boolean {
    if (input.executionPolicy !== undefined) return true;
    if (input.interactionId === undefined) return false;
    return this.explicitIntake.currentDraftRevision(input.interactionId) !== undefined;
  }

  /**
   * The typed final-submit path: exact revision confirmation plus one
   * `submitFinal` authorization. The execution policy, when present, is
   * compiled and persisted as exactly one subscription.
   */
  private async confirmTypedExplicitRequirement(
    input: ConfirmExplicitRequirementInput,
  ): Promise<ExplicitBrainReceipt> {
    const interactionId = input.interactionId;
    if (interactionId === undefined) {
      throw new UiRuntimeApiError(
        'explicit-brain.interaction-required',
        'humanagent.runtime.explicit-brain',
        'typed final submit requires the owning interaction identity',
        'confirm the exact interaction that owns the draft revision',
        409,
      );
    }
    // Bind the caller to the draft and input revision that existed when this
    // request arrived. Policy refinement may mint a typed revision with a new
    // internal draft id, but it must never replace the caller's identity before
    // this check.
    const arrivalSnapshot = await this.explicitIntake.inspect(interactionId);
    const arrivalDraft = arrivalSnapshot.draft;
    const arrivalMatches = arrivalDraft !== undefined
      && input.draftId === arrivalDraft.draftId
      && input.inputRevision === arrivalDraft.inputRevision;
    const confirmedReplayMatches = arrivalSnapshot.state === 'confirmed'
      && arrivalSnapshot.confirmation !== undefined
      && input.inputRevision === arrivalSnapshot.confirmation.inputRevision
      && input.confirmationRef === arrivalSnapshot.confirmation.confirmationRef
      && input.confirmedBy === arrivalSnapshot.confirmation.confirmedBy
      && input.confirmedAt === arrivalSnapshot.confirmation.confirmedAt
      && input.payloadRef === arrivalSnapshot.confirmation.payloadRef;
    if (!arrivalMatches && !confirmedReplayMatches) {
      throw new DraftRevisionError({
        code: 'confirmation-stale',
        message: `confirmation addresses draft ${input.draftId} input revision ${input.inputRevision}, but the interaction-arrival draft is ${arrivalDraft?.draftId ?? 'missing'} input revision ${arrivalDraft?.inputRevision ?? 'missing'}`,
        draftId: arrivalDraft?.draftId ?? input.draftId,
        expectedRevisionVersion: input.inputRevision,
        actualRevisionVersion: arrivalDraft?.inputRevision,
      });
    }
    // Read the request-arrival typed revision before any policy refinement.
    let revision = this.explicitIntake.currentDraftRevision(interactionId);
    if (revision === undefined) {
      revision = await this.ensureTypedDraftRevision(interactionId, {
        executionPolicy: input.executionPolicy,
        goal: input.goal,
        scope: input.scope,
        constraints: input.constraints,
        deliverables: input.deliverables,
      });
    }
    if (revision === undefined) {
      throw new UiRuntimeApiError(
        'explicit-brain.typed-revision-required',
        'humanagent.runtime.explicit-intake',
        `interaction has no reviewable typed draft revision to confirm: ${interactionId}`,
        'generate the reviewable draft before final submission',
        409,
      );
    }
    if ((input.draftRevisionVersion !== undefined && input.draftRevisionVersion !== revision.revisionVersion)
      || (input.draftRevisionHash !== undefined && input.draftRevisionHash !== revision.revisionHash)) {
      throw new DraftRevisionError({
        code: 'confirmation-stale',
        message: 'confirmation is not bound to the current draft revision',
        draftId: revision.draftId,
        ...(input.draftRevisionVersion === undefined ? {} : { expectedRevisionVersion: input.draftRevisionVersion }),
        ...(input.draftRevisionHash === undefined ? {} : { expectedRevisionHash: input.draftRevisionHash }),
        actualRevisionVersion: revision.revisionVersion,
        actualRevisionHash: revision.revisionHash,
      });
    }
    if (input.executionPolicy !== undefined) {
      if (revision.executionPolicy !== undefined
        && canonicalJsonStringify(revision.executionPolicy) !== canonicalJsonStringify(input.executionPolicy)) {
        // The execution type is part of the immutable revision. A revision that
        // already fixed a different policy cannot be silently rebound at submit
        // time; the caller must submit against a revision created with the policy.
        throw new UiRuntimeApiError(
          'execution-plan.policy-immutable',
          RUNTIME_OWNER,
          `draft revision already carries a different execution policy: ${revision.draftId}`,
          'create the reviewable draft with the intended execution policy before final submission',
          409,
        );
      }
      if (revision.executionPolicy === undefined) {
        // Interpretation mints the reviewable draft before confirmation, so a
        // submit that carries the execution policy must bind it through the
        // revision owner as a new version. The app only names the base revision
        // and the changed fields; the owner mints and persists the revision.
        revision = await this.refineDraftWithExecutionPolicy(interactionId, revision, input, input.executionPolicy);
        this.persistExplicitBrainState();
      }
    }

    const draftRevisionVersion = revision.revisionVersion;
    const draftRevisionHash = revision.revisionHash;
    this.confirmationLedger.registerRevision({
      interactionId,
      draftId: revision.draftId,
      inputRevision: revision.inputRevision,
      draftRevisionVersion,
      draftRevisionHash,
      normalizedInput: revision.normalizedInput,
      intent: revision.proposedIntent,
      payloadRef: input.payloadRef,
      requestKind: 'new-task-create',
    });
    const confirmation = await this.explicitIntake.confirmDraftRevision({
      interactionId,
      draftId: revision.draftId,
      draftRevisionVersion,
      draftRevisionHash,
      confirmationRef: input.confirmationRef,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt,
      payloadRef: input.payloadRef,
    });
    this.confirmationLedger.confirmRevision(confirmation);

    const submitted = await this.requirementSubmissions.submitFinal({
      interactionId,
      draftId: revision.draftId,
      inputRevision: revision.inputRevision,
      draftRevisionVersion,
      draftRevisionHash,
      confirmationRef: input.confirmationRef,
      idempotencyKey: input.idempotencyKey ?? `final-submit:${revision.draftId}:${draftRevisionVersion}:${input.confirmationRef}`,
      requestKind: 'new-task-create',
    });
    if (revision.executionPolicy !== undefined) {
      await this.persistAuthorizedExecutionPlan(submitted.requirement, revision.executionPolicy);
    }
    this.projectConfirmedRequirement(revision.draftId);
    this.persistExplicitBrainState();
    this.scheduleImplicitConsumption();
    return {
      requirement: {
        status: submitted.status,
        requirementId: submitted.requirement.requirementId,
        draftId: submitted.requirement.draftId,
        inputRevision: submitted.requirement.inputRevision,
      },
    };
  }

  /**
   * Bind the submit-time execution policy to the current typed revision. The
   * revision owner mints the new version; the app only names the base revision
   * and the changed policy, so the immutable revision structure stays with its
   * owner. The task body remains the human-readable normalized input.
   */
  private async refineDraftWithExecutionPolicy(
    interactionId: string,
    current: DraftRevision,
    input: ConfirmExplicitRequirementInput,
    executionPolicy: ExecutionPolicyDefinition,
  ): Promise<DraftRevision> {
    const fields: Record<string, unknown> = {
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
      ...(input.deliverables === undefined ? {} : { deliverables: input.deliverables }),
      executionPolicy,
    };
    const idempotencyKey = `final-submit-policy:${interactionId}:${current.draftId}:${current.revisionVersion}:${canonicalJsonStringify(executionPolicy)}`;
    return await this.explicitIntake.refineDraft(interactionId, {
      draftId: current.draftId,
      baseRevisionVersion: current.revisionVersion,
      requestedRevisionHash: current.revisionHash,
      fields,
      instructionRef: `final-submit-policy:${interactionId}`,
      idempotencyKey,
    });
  }

  /**
   * The single writer of a typed draft revision. The draft-generation path
   * calls this as soon as the reviewable draft exists, so the public surface
   * can project and edit the revision before confirmation. The final-submit
   * path reuses the same implementation only when no revision exists yet, so a
   * submit that carries the execution policy still bakes that policy into the
   * one immutable revision. `undefined` means the interaction is not a typed
   * draft (no draft requestKind), so the legacy draft path stays in force.
   */
  private async ensureTypedDraftRevision(
    interactionId: string,
    options: {
      readonly executionPolicy?: ExecutionPolicyDefinition;
      readonly goal?: string;
      readonly scope?: string;
      readonly constraints?: readonly string[];
      readonly deliverables?: readonly string[];
    } = {},
  ): Promise<DraftRevision | undefined> {
    const alreadyCreated = this.explicitIntake.currentDraftRevision(interactionId);
    if (alreadyCreated !== undefined) return alreadyCreated;
    const snapshot = await this.explicitIntake.inspect(interactionId);
    const draft = snapshot.draft;
    if (!draft) return undefined;
    try {
      await this.explicitIntake.createDraft(interactionId, {
        goal: options.goal ?? draft.proposal,
        scope: options.scope ?? draft.normalizedInput,
        constraints: options.constraints,
        deliverables: options.deliverables,
        normalizedInput: draft.normalizedInput,
        proposedIntent: draft.proposedIntent,
        proposal: draft.proposal,
        matchedTasks: draft.matchedTasks,
        knownFacts: draft.knownFacts,
        decisionRefs: draft.decisionRefs,
        ...(options.executionPolicy === undefined ? {} : { executionPolicy: options.executionPolicy }),
      });
    } catch (error) {
      // A concurrent caller may have created the revision first. Reuse that
      // exact revision instead of failing the racing caller.
      if (error instanceof ExplicitIntakeError && error.code === 'draft-already-created') {
        return this.explicitIntake.currentDraftRevision(interactionId);
      }
      // An untyped interaction keeps its legacy draft: the runtime refuses to
      // mint a typed revision without a typed draft requestKind.
      if (error instanceof ExplicitIntakeError && error.code === 'typed-request-kind-required') {
        return undefined;
      }
      throw error;
    }
    return this.explicitIntake.currentDraftRevision(interactionId);
  }

  /**
   * Compile the confirmed revision's execution policy and persist exactly one
   * subscription. Repeating or racing the same revision reuses the durable
   * subscription identity instead of creating a second plan.
   */
  private async persistAuthorizedExecutionPlan(
    requirement: AuthorizedRequirement,
    definition: ExecutionPolicyDefinition,
  ): Promise<void> {
    const port = this.subscriptionControl;
    if (!port) {
      throw new UiRuntimeApiError(
        'execution-plan.persist-unavailable',
        RUNTIME_OWNER,
        'execution plan persistence is not wired to the UI runtime',
        'start the UI runtime with the durable subscription control port',
        503,
      );
    }
    const compiled = new ExecutionPolicyCompiler().compile(requirement, definition);
    const subscriptionId = `subscription:${requirement.requirementId}`;
    const existing = await this.subscriptionSnapshot(port, subscriptionId);
    if (existing) {
      if (existing.policyHash !== compiled.policyHash) {
        throw new UiRuntimeApiError(
          'execution-plan.policy-conflict',
          RUNTIME_OWNER,
          `subscription already exists with a different policy: ${subscriptionId}`,
          'inspect the persisted execution plan before resubmitting',
          409,
        );
      }
      return;
    }
    const subscription: Subscription = {
      subscriptionId,
      goalId: requirement.requirementId,
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: definition.busyPolicy,
      currentOccurrenceOrdinal: 0,
    };
    try {
      await port.create(subscription, compiled.definition, subscriptionId);
    } catch (error) {
      if (error instanceof SubscriptionControlError && error.code === 'conflict') {
        const raced = await this.subscriptionSnapshot(port, subscriptionId);
        if (raced && raced.policyHash === compiled.policyHash) return;
      }
      throw error;
    }
  }

  private async subscriptionSnapshot(
    port: SubscriptionControlPort,
    subscriptionId: string,
  ): Promise<SubscriptionSnapshot | undefined> {
    try {
      return await port.snapshot(subscriptionId);
    } catch (error) {
      if (error instanceof SubscriptionControlError && error.code === 'not-found') return undefined;
      throw error;
    }
  }

  private projectConfirmedRequirement(draftId: string): void {
    const envelope = this.requirementInbox.find(draftId);
    if (!envelope) return;
    this.queuedRequirements.set(envelope.draftId, {
      requirementId: envelope.requirementId,
      draftId: envelope.draftId,
      fifoSeq: envelope.fifoSeq,
      normalizedInput: envelope.normalizedInput,
      queue: classifyConfirmedRequirement(envelope),
    });
  }

  /** Prevent future execution plans from entering the immediate FIFO path. */
  private async checkExecutionPolicyGate(
    envelope: RequirementEnvelope,
  ): Promise<boolean> {
    const port = this.subscriptionControl;
    if (port === undefined) return false;
    const subscriptionId = `subscription:${envelope.requirementId}`;
    let snapshot: SubscriptionSnapshot | undefined;
    try {
      snapshot = await port.snapshot(subscriptionId);
    } catch (error) {
      if (!(error instanceof SubscriptionControlError) || error.code !== 'not-found') throw error;
    }
    if (!snapshot || snapshot.policy.executionMode === 'once') return false;
    await this.requirementInbox.acknowledge({
      consumerId: RUNTIME_OWNER,
      requirementId: envelope.requirementId,
    });
    this.persistExplicitBrainState();
    return true;
  }

  async dispatchNextExplicitRequirement(): Promise<ExplicitBrainDispatchReceipt> {
    for (;;) {
      const attempt = await this.dispatchNextExplicitRequirementInternal();
      if (attempt.kind === 'dispatched') return attempt.receipt;
      if (attempt.kind === 'retired') {
        throw new UiRuntimeApiError(
          'explicit-brain.requirement-retired',
          RUNTIME_OWNER,
          attempt.outcome.message,
          `inspect retired requirement ${attempt.outcome.requirementId} draft ${attempt.outcome.draftId} and resubmit against a current task`,
          409,
        );
      }
      if (attempt.kind === 'empty') {
        throw new UiRuntimeApiError(
          'explicit-brain.inbox.empty',
          RUNTIME_OWNER,
          'requirement inbox has no pending entry',
          'wait for a confirmed requirement',
          409,
        );
      }
    }
  }

  private async withDispatchLock<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.dispatchTail;
    this.dispatchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async dispatchNextExplicitRequirementInternal(): Promise<ExplicitBrainDispatchAttempt> {
    return this.withDispatchLock(async () => {
    let consumed: RequirementEnvelope | null = null;
    let dispatchEntry: DispatchLedgerEntry | undefined;
    let inboxBeforeRetire: RequirementInboxState | undefined;
    let retired = false;
    try {
      consumed = await this.requirementInbox.peekNext({ consumerId: RUNTIME_OWNER });
      if (!consumed) return { kind: 'empty' };
      this.implicitConsumerRequirement = {
        requirementId: consumed.requirementId,
        draftId: consumed.draftId,
        fifoSeq: consumed.fifoSeq,
      };
      const taskRef = consumed.taskRef;
      if (taskRef && !this.coordinator.taskSnapshots().some((task) => task.taskId.value === taskRef.value)) {
        inboxBeforeRetire = this.requirementInbox.exportState();
        const outcome = await this.requirementInbox.retire({
          consumerId: RUNTIME_OWNER,
          requirementId: consumed.requirementId,
          code: 'task.not.found',
          message: `confirmed append target is not in the local task store: ${taskRef.value}`,
          retiredAt: this.now().toISOString(),
        });
        retired = true;
        this.persistExplicitBrainState();
        this.implicitTerminalRequirement = {
          requirementId: outcome.requirementId,
          draftId: outcome.draftId,
          fifoSeq: outcome.fifoSeq,
        };
        this.implicitTerminalIssue = new UiRuntimeApiError(
          'explicit-brain.requirement-retired',
          RUNTIME_OWNER,
          outcome.message,
          'inspect the retired requirement and resubmit against a current task',
          409,
        );
        return { kind: 'retired', outcome };
      }
      const existingDispatch = this.dispatchLedger.get(consumed.draftId);
      if (existingDispatch) dispatchEntry = existingDispatch;
      else {
        const admission = this.classifyAndAdmitConfirmedRequirement(consumed);
        dispatchEntry = {
          draftId: consumed.draftId,
          taskId: consumed.taskRef ?? id('task', `ui-task-implicit-${consumed.draftId}`),
          operationId: id('operation', `ui-operation-implicit-${consumed.draftId}`),
        };
        this.requirementAdmissions.set(dispatchEntry.taskId.value, {
          taskId: dispatchEntry.taskId,
          queue: admission.classified.queue,
          receipt: structuredClone(admission),
        });
        this.queuedRequirements.delete(consumed.draftId);
        this.dispatchLedger.set(consumed.draftId, dispatchEntry);
        this.persistExplicitBrainState();
      }
      if (await this.checkExecutionPolicyGate(consumed)) {
        return {
          kind: 'dispatched',
          receipt: {
            requirement: {
              requirementId: consumed.requirementId,
              draftId: consumed.draftId,
              fifoSeq: consumed.fifoSeq,
            },
            taskId: dispatchEntry.taskId,
            operationId: dispatchEntry.operationId,
            executionEpoch: 0,
          },
        };
      }
      return {
        kind: 'dispatched',
        receipt: await this.completePreparedDispatch(consumed, dispatchEntry),
      };
    } catch (error) {
      if (retired && inboxBeforeRetire) {
        this.requirementInbox.restoreState(inboxBeforeRetire);
      } else if (consumed) {
        this.requirementInbox.restoreAcknowledged({
          consumerId: RUNTIME_OWNER,
          requirementId: consumed.requirementId,
        });
        if (dispatchEntry) this.dispatchLedger.set(consumed.draftId, dispatchEntry);
      }
      throw apiError(error);
    }
    });
  }

  private async dispatchConfirmedRequirementThroughCoordinator(
    envelope: RequirementEnvelope,
    admission: RequirementAdmissionReceipt,
    scope: ScopeRef,
    inputRevision: number,
  ): Promise<import('../../../runtime/src/admission/index.js').ImplicitRequirementDispatchResult> {
    this.implicitConsumerRequirement = {
      requirementId: envelope.requirementId,
      draftId: envelope.draftId,
      fifoSeq: envelope.fifoSeq,
    };
    const existingDispatch = this.dispatchLedger.get(envelope.draftId);
    let dispatchEntry = existingDispatch;
    if (!dispatchEntry) {
      dispatchEntry = {
        draftId: envelope.draftId,
        taskId: envelope.taskRef ?? id('task', `ui-task-implicit-${envelope.draftId}`),
        operationId: id('operation', `ui-operation-implicit-${envelope.draftId}`),
      };
      this.requirementAdmissions.set(dispatchEntry.taskId.value, {
        taskId: dispatchEntry.taskId,
        queue: admission.classified.queue,
        receipt: structuredClone(admission),
      });
      this.queuedRequirements.delete(envelope.draftId);
      this.dispatchLedger.set(envelope.draftId, dispatchEntry);
      this.persistExplicitBrainState();
    }
    if (await this.checkExecutionPolicyGate(envelope)) {
      return {
        status: 'succeeded',
        envelope,
        admission,
        ownerId: RUNTIME_OWNER,
        scope,
        executionEpoch: 0,
        inputRevision,
        taskId: dispatchEntry.taskId,
        operationId: dispatchEntry.operationId.value,
        evidenceRefs: [],
      };
    }
    const receipt = await this.completePreparedDispatch(envelope, dispatchEntry, false);
    return {
      status: 'succeeded',
      envelope,
      admission,
      ownerId: RUNTIME_OWNER,
      scope,
      executionEpoch: receipt.executionEpoch,
      inputRevision,
      taskId: receipt.taskId,
      operationId: receipt.operationId.value,
      evidenceRefs: [],
    };
  }

  private async completePreparedDispatch(
    consumed: RequirementEnvelope,
    prepared: DispatchLedgerEntry,
    acknowledge = true,
  ): Promise<ExplicitBrainDispatchReceipt> {
    const existingTask = this.coordinator.taskSnapshots().find((task) => task.taskId.value === prepared.taskId.value);
    const task = existingTask ?? (consumed.taskRef
      ? this.coordinator.taskSnapshot(consumed.taskRef)
      : this.coordinator.createTask({
          taskId: prepared.taskId,
          title: consumed.normalizedInput,
          directive: consumed.normalizedInput,
        }));
    const admission = this.requirementAdmissions.get(prepared.taskId.value)?.receipt;
    const implicitRequirement = admission === undefined
      ? undefined
      : { envelope: consumed, admission };
    const operationId = prepared.operationId;
    let executionEpoch = prepared.executionEpoch;
    const isTaskInputUpdate = consumed.taskRef !== undefined
      && (consumed.intent === 'append' || consumed.intent === 'change');
    if (isTaskInputUpdate) {
      // Route `append`/`change` intents to this task's input mailbox instead of
      // overwriting its directive with a fresh execution. `appendTaskRevision`
      // is the single owner of the append-without-overwrite rule; the revision
      // is retained and consumed by the next execution cycle.
      this.coordinator.appendTaskInput(task.taskId, consumed);
      this.persistExplicitBrainState();
      const current = this.coordinator.taskSnapshot(task.taskId);
      if (executionEpoch === undefined) {
        if (current.state === 'running' || current.state === 'settling') {
          // The target is busy. Do not start a conflicting execution (that used
          // to surface as task.busy); keep the confirmed requirement pending in
          // the FIFO so the running task's terminal wake consumes the appended
          // input on the next execution cycle instead.
          throw new RequirementAdmissionError({
            status: 'waiting',
            queue: 'interactive',
            ownerId: 'runtime-coordinator',
            condition: 'task.input.pending',
            nextAction: { kind: 'wait', ref: 'task.input.pending' },
            reason: `append queued behind the running execution of task ${task.taskId.value}`,
          });
        }
        const pending = this.coordinator.pendingTaskInput(task.taskId);
        const prompt = pending ? pending.envelope.normalizedInput : consumed.normalizedInput;
        const execution = this.coordinator.startExecution(task.taskId, {
          prompt,
          ...(this.options.runtimeComposition?.createTaskAssembly === undefined ? {} : { orchestrate: true }),
          operationId,
          ...(implicitRequirement === undefined ? {} : { implicitRequirement }),
        });
        if (pending) this.coordinator.consumeTaskInput(task.taskId, pending.inputRevision);
        executionEpoch = execution.executionEpoch;
      }
      const started: DispatchLedgerEntry = {
        ...prepared,
        operationId,
        executionEpoch,
      };
      this.dispatchLedger.set(consumed.draftId, started);
      this.persistExplicitBrainState();
    } else if (executionEpoch === undefined) {
      if (task.operationId === operationId.value && task.executionEpoch !== undefined) {
        executionEpoch = task.executionEpoch;
      } else {
        const execution = this.coordinator.startExecution(task.taskId, {
          prompt: consumed.normalizedInput,
          ...(this.options.runtimeComposition?.createTaskAssembly === undefined ? {} : { orchestrate: true }),
          operationId,
          ...(implicitRequirement === undefined ? {} : { implicitRequirement }),
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
    const requirement: InboxReceipt = {
      requirementId: consumed.requirementId,
      draftId: consumed.draftId,
      fifoSeq: consumed.fifoSeq,
    };
    if (acknowledge) {
      await this.requirementInbox.acknowledge({
        consumerId: RUNTIME_OWNER,
        requirementId: consumed.requirementId,
      });
      this.persistExplicitBrainState();
      this.dispatchLedger.delete(consumed.draftId);
      this.persistExplicitBrainState();
      this.implicitConsumerRequirement = undefined;
    }
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
    const isTaskInputUpdate = envelope.taskRef !== undefined
      && (envelope.intent === 'append' || envelope.intent === 'change');
    const runningTasks = tasks.filter((task) => task.state === 'running' || task.state === 'settling');
    return admitRequirement({
      envelope,
      queue: defaultAdmissionQueueConfig(queue),
      registeredQueues: ADMISSION_QUEUE_KINDS,
      queueLoad: {
        // An append/change to an already-running task does not occupy a new
        // pipeline slot — it goes to that task's input mailbox and is consumed
        // on the task's next execution cycle. Exclude the target task's own
        // running status so it is admitted and deferral happens downstream;
        // other running/settling tasks still consume the shared pipeline slot.
        running: isTaskInputUpdate
          ? runningTasks.filter((task) => task.taskId.value !== envelope.taskRef!.value).length
          : runningTasks.length,
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
    // Drain after a short visibility window, not on the next macrotask, so the
    // confirming HTTP response is written and a following status/task read can
    // still observe the requirement as a genuine queued FIFO entry.
    this.implicitConsumerTimer = setTimeout(() => {
      this.implicitConsumerTimer = undefined;
      this.implicitConsumerScheduled = false;
      const run = this.consumePendingRequirements();
      this.implicitConsumptionRun = run;
      void run.then(
        () => {
          if (this.implicitConsumptionRun === run) this.implicitConsumptionRun = undefined;
        },
        (error: unknown) => {
          this.implicitConsumerIssue = apiError(error);
          if (this.implicitConsumptionRun === run) this.implicitConsumptionRun = undefined;
        },
      );
    }, QUEUED_VISIBILITY_WINDOW_MS);
  }

  private async consumePendingRequirements(): Promise<void> {
    while (this.implicitConsumerEnabled) {
      try {
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
        // Share the explicit dispatch mutex so a manual /api/explicit/dispatch-next
        // cannot interleave with the background FIFO drain on the same head.
        const attempt = await this.withDispatchLock(() => this.implicitBrain.drainNext({
          queueLoad: {
            running: this.coordinator.taskSnapshots().filter((task) => task.state === 'running' || task.state === 'settling').length,
            queued: this.coordinator.taskSnapshots().filter((task) => task.state === 'created' || task.state === 'admitted').length,
          },
          requiredCapabilities: [PROVIDER_EXECUTION_CAPABILITY],
          availableCapabilities,
          health,
          requiredInputRefs: ['task://pending'],
          providedInputRefs: ['task://pending'],
          checkpoint: { recoverable: true },
        }));
        if (attempt.kind === 'retired') {
          this.implicitConsumerIssue = undefined;
          continue;
        }
        if (attempt.kind === 'empty') {
          this.implicitConsumerIssue = undefined;
          this.implicitConsumerRequirement = undefined;
          return;
        }
        this.implicitConsumerIssue = undefined;
        if (attempt.kind === 'succeeded' && attempt.envelope) {
          this.dispatchLedger.delete(attempt.envelope.draftId);
          this.implicitConsumerRequirement = undefined;
          this.persistExplicitBrainState();
        }
      } catch (error) {
        const issue = apiError(error);
        this.implicitConsumerIssue = issue;
        if (issue.code === 'implicit-admission.waiting' || issue.code === 'implicit-admission.blocked') return;
        throw issue;
      }
    }
  }

  private async retireMissingTaskRefHead(head: RequirementEnvelope): Promise<boolean> {
    if (!head.taskRef || this.coordinator.taskSnapshots().some((task) => task.taskId.value === head.taskRef!.value)) {
      return false;
    }
    const outcome = await this.requirementInbox.retire({
      consumerId: RUNTIME_OWNER,
      requirementId: head.requirementId,
      code: 'task.not.found',
      message: `confirmed append target is not in the local task store: ${head.taskRef.value}`,
      retiredAt: this.now().toISOString(),
    });
    this.persistExplicitBrainState();
    this.implicitTerminalRequirement = {
      requirementId: outcome.requirementId,
      draftId: outcome.draftId,
      fifoSeq: outcome.fifoSeq,
    };
    this.implicitTerminalIssue = new UiRuntimeApiError(
      'explicit-brain.requirement-retired',
      RUNTIME_OWNER,
      outcome.message,
      'inspect the retired requirement and resubmit against a current task',
      409,
    );
    return true;
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
    const terminalOutcomeAtHead = this.requirementInbox.exportState().terminalOutcomes?.at(-1);
    const headIssue = this.implicitConsumerIssue ?? this.implicitTerminalIssue;
    // Requirements behind a blocked, waiting, or retired FIFO head are still
    // confirmed and undelivered; project that backlog instead of only the head.
    // Any other head issue (for example a dispatch or persistence failure) is a
    // real failure terminal: it must stay the primary projection with its own
    // code/message/nextAction so the failure is never hidden by the queued
    // projection of a later requirement, even when an earlier retirement left a
    // stale terminal outcome behind.
    const headIsBacklogTerminal = headIssue === undefined
      || headIssue.code === 'implicit-admission.waiting'
      || headIssue.code === 'implicit-admission.blocked'
      || headIssue.code === 'explicit-brain.requirement-retired';
    if (headIsBacklogTerminal && (headIssue || terminalOutcomeAtHead)) {
      const queuedBacklog = this.queuedBacklogProjection(headIssue);
      if (queuedBacklog) return queuedBacklog;
    }
    if (this.implicitConsumerIssue) {
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
    if (this.implicitTerminalIssue && this.implicitTerminalRequirement) {
      return {
        state: 'blocked',
        code: this.implicitTerminalIssue.code,
        ownerId: this.implicitTerminalIssue.ownerId,
        message: this.implicitTerminalIssue.message,
        nextAction: this.implicitTerminalIssue.nextAction,
        requirementId: this.implicitTerminalRequirement.requirementId,
        draftId: this.implicitTerminalRequirement.draftId,
        fifoSeq: this.implicitTerminalRequirement.fifoSeq,
      };
    }
    if (terminalOutcomeAtHead) {
      return {
        state: 'blocked',
        code: 'explicit-brain.requirement-retired',
        ownerId: RUNTIME_OWNER,
        message: terminalOutcomeAtHead.message,
        nextAction: 'inspect the retired requirement and resubmit against a current task',
        requirementId: terminalOutcomeAtHead.requirementId,
        draftId: terminalOutcomeAtHead.draftId,
        fifoSeq: terminalOutcomeAtHead.fifoSeq,
      };
    }
    return undefined;
  }

  private persistExplicitBrainState(): void {
    const state: RuntimeExplicitBrainJournalState & {
      readonly finalSubmissions?: readonly PersistedFinalSubmitReceipt[];
    } = {
      intake: this.explicitIntake.exportState(),
      inbox: this.requirementInbox.exportState(),
      confirmationLedger: this.confirmationLedger.exportState(),
      dispatchLedger: [...this.dispatchLedger.values()].map((entry) => structuredClone(entry)),
      requirementAdmissions: [...this.requirementAdmissions.values()].map((admission) => structuredClone(admission)),
      submittedSubmissions: this.requirementSubmissions.submittedReceipts() as readonly PersistedSubmittedReceipt[],
      finalSubmissions: this.requirementSubmissions.finalReceipts(),
      decisionTraces: this.explicitBrainTraceRecords.map((record) => structuredClone(record)),
      taskInputRevisions: this.coordinator.exportTaskInputRevisions().map((entry) => structuredClone(entry)),
    };
    (this.options.interactionJournal ?? this.options.journal)?.append({
      kind: 'explicit-brain.state',
      state,
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

function builtinTemplateRoot(): string {
  const configured = process.env.HUMANAGENT_TEMPLATE_ROOT?.trim();
  if (configured) return configured;
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleRoot, '../../../agent-templates/templates'),
    join(process.cwd(), 'packages', 'agent-templates', 'templates'),
  ];
  const root = candidates.find((candidate) => existsSync(join(candidate, 'builtin', 'prompt-registry.json')));
  if (!root) {
    throw new UiRuntimeApiError(
      'memory-context-policy-unavailable',
      APP_OWNER,
      'execution agent template root is not configured',
      'configure the locked builtin template root before starting an execution',
      409,
    );
  }
  return root;
}

async function loadExecutionMemoryContextPolicy(): Promise<MemoryContextPolicy> {
  try {
    const manifest = await loadBuiltinAgentTemplate(builtinTemplateRoot(), 'execution', '1.1.0');
    return manifest.memoryContextPolicy;
  } catch (error) {
    if (error instanceof UiRuntimeApiError) throw error;
    throw new UiRuntimeApiError(
      'memory-context-policy-unavailable',
      APP_OWNER,
      `execution agent template policy could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      'repair the locked builtin execution template before starting an execution',
      409,
    );
  }
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
    const policy = await loadExecutionMemoryContextPolicy();
    const request: AgentMemoryContextRequest = {
      agentRuntimeId: this.input.runtimeId,
      roleId: this.composition.roleId ?? 'execution',
      taskId: this.input.taskId,
      scope,
      layers: policy.allowedLayers,
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
