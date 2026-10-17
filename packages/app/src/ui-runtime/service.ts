import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderTransportSource } from '../../../adapters/provider/src/index.js';
import { providerRawContentReader } from '../../../adapters/provider/src/evidence.js';
import {
  assertNotExpired,
  ContractError,
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
  validateCodeSearchReport,
  type Checkpoint,
  type Occurrence,
  type OccurrenceTaskBinding,
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
  type RawAsset,
  type ScopeRef,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderReadiness,
  type ProviderEvent,
  type StopRequestReceipt,
  type TaskId,
  type TaskFlowBinding,
  canonicalJsonStringify,
  type AuthorizedRequirement,
  type DraftRevision,
  type DraftRevisionInput,
  type DraftRejectClosure,
  type ExecutionPolicyDefinition,
  type Subscription,
  type SubscriptionControlReceipt,
  type SubscriptionControlRequest,
  type SubscriptionState,
  type InteractionDecision,
  type InteractionHistoryQuery,
  type InteractionHistoryResult,
  type WorkResult,
  type ContextReplacement,
  type ContextView,
  type JournalCommitRef,
  type TaskIdentityScope,
  type TaskIdentityRecord,
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
  nextPolicySlotAfter,
  SubscriptionControlError,
  type SubscriptionControlPort,
  type SubscriptionSnapshot,
} from '../../../runtime/src/subscriptions/index.js';
import type { OccurrenceClaimRecord } from '../../../runtime/src/subscriptions/ports.js';
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
import type { TaskGrantPort } from '../../../runtime/src/admission/task-grant.js';
import type { RequirementEnvelope } from '../../../contracts/src/index.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
  RuntimeTaskEvent,
  projectDurableTaskInventory,
  producedArtifactBody,
  producedArtifactPaths,
  type RuntimeCheckpointBoundaryPort,
  type DurableTaskInventoryEntry,
  type RuntimeExecutionDriver,
  type RuntimeExecutionDriverInput,
  type RuntimeExecutionRelease,
  type RuntimeExplicitBrainJournalState,
  type RuntimeExecutionCapabilities,
  type RuntimeTaskCoordinatorOptions,
  type RuntimeTaskAssembly,
  type RuntimeTaskSnapshot,
} from '../../../runtime/src/ui-runtime/coordinator.js';
import type { RuntimeColdExecutionResumeRequest } from '../../../runtime/src/ui-runtime/cold-execution-resume.js';
import { createDefaultExecutionComposition,
  type ServiceCheckpointReentryRequest,
  type ServiceContextCorrectionRequest,
} from './execution-composition.js';
import type {
  CommittedTaskCheckpointReentryReceipt,
  CommittedTaskContextCorrectionReceipt,
} from './reentry-current-facts.js';
import type { OrchestrationManager } from '../../../runtime/src/orchestration/manager.js';
import { TaskIdentityConsumer } from '../../../runtime/src/orchestration/task-identity.js';
import { TaskPlanRevisionConsumer } from '../../../runtime/src/orchestration/task-plan-revisions.js';
import { JsonlTaskPlanRevisionJournal } from '../../../adapters/jsonl/src/task-plan-revisions.js';
import { JsonlTaskIdentityJournal } from '../../../adapters/jsonl/src/task-identities.js';
import { createJsonlActiveTurnJournal, createJsonlActiveTurnSegmentJournal } from '../../../adapters/jsonl/src/active-turn.js';
import { JsonlOperationCompletionJournal } from '../../../adapters/jsonl/src/operation-completion.js';
import { ImmutableAssetStore } from '../../../adapters/filesystem/src/index.js';
import { createNativeRecoveryAssets } from '../native-recovery-assets.js';
import { createCheckpointHistoryReader, type CheckpointHistoryReadInput } from './checkpoint-history.js';
import type {
  RuntimeCheckpointAssetBodyProjection,
  RuntimeCheckpointAssetSelector,
  RuntimeCheckpointAssetTarget,
  RuntimeCheckpointDetailProjection,
  RuntimeCheckpointReadProjection,
} from '../../../ui/contracts/checkpoint-history.js';
import type { CheckpointHistoryReader } from './checkpoint-history.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../runtime-current-state-journal.js';
import { createTaskPlanHistoryReader, type TaskPlanHistoryCurrentRead } from './task-plan-history.js';
import type { RuntimeTaskPlanHistoryProjection } from '../../../ui/contracts/task-plan-history.js';
// The declared silence budget is owned by the agent-io policy. The dashboard
// reports it as the budget it was measured against; it is never restated here.
import { DEFAULT_AGENT_IO_POLICY } from '../../../runtime/src/agent-io/types.js';
import { projectRuntimeTaskHistory } from './turn-history.js';
import { buildSemanticObservation } from '../../../context-events/src/index.js';
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
import { validatePersistedToolExecutionFact } from './tool-fact-validation.js';
import {
  ProviderAgentDriver,
  ProviderAdapterError,
  filesystemProviderEvidenceSink,
  type ProviderToolExecutionPort,
  type ProviderEvidenceSink,
} from '../../../adapters/provider/src/index.js';
import {
  type RuntimeDashboardProjection,
  type PublicOutputPublicationProjection,
  type RuntimeLivenessInput,
  type RuntimeSseEvent,
  type RuntimeStatusProjection,
  type RuntimeTaskDashboardProjection,
  type RuntimeTaskErrorProjection,
  type RuntimeTaskEventProjection,
  type RuntimeTaskListProjection,
  type RuntimeProjectReadProjection,
  type RuntimeProjectTaskReadRow,
  type RuntimeRawEventProjection,
  type RuntimeRawRecordBody,
  type RuntimeRawRecordProjection,
  type RuntimeStoredRecordRef,
  type RuntimeSystemReadProjection,
  type RuntimeTaskRecordsProjection,
  type RuntimeTaskRowProjection,
  type RuntimeReadResult,
  type RuntimeMode,
  type RuntimeReadScope,
  type RuntimeReadFailure,
  type RuntimeContextHistoryProjection,
  type RuntimeCommitRefProjection,
  type RuntimeContextReplacementProjection,
  type RuntimeBusinessCycleHistoryProjection,
  type RuntimeBusinessCycleEntryProjection,
  type RuntimeInspectionOccurrenceHistoryProjection,
  type RuntimeInspectionOccurrenceEntryProjection,
  type RuntimeInspectionComparisonProjection,
  type RuntimeMilestoneReviewHistoryProjection,
  type RuntimePoolAvailabilityProjection,
  type TaskDetailProjection,
  type OrganHealthProjection,
  type OrganHealthDimensionProjection,
} from '../../../ui/contracts/runtime.js';
import {
  projectRuntimeDashboard,
  projectRuntimeStatus,
  projectRuntimeSemanticObservation,
  projectRuntimeContextHistory,
  projectRuntimeTaskDashboard,
  projectRuntimeTaskWaitingStatus,
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
import type { RuntimeSemanticObservationEnvelope } from '../../../ui/contracts/runtime.js';
import { nodeRegistry, type PipelineNodeDefinition } from '../../../runtime/src/nodes/node-registry.js';
import type {
  AgentRoleDisplay,
  LifecycleState,
  PublicOutputBinding,
  PublicOutputJournalPort,
  PublicOutputPublication,
} from '../../../contracts/src/index.js';
import { UiRuntimeApiError, type UiRuntimeApiErrorBody } from './errors.js';
import { canStartProviderRequest } from '../provider-admission.js';
import { readProducedArtifacts, RESPONSES_FILE_SEARCH_TOOL } from '../provider-tool-execution.js';
import { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import {
  FileCheckpointStore,
  readUiRuntimeTaskJournal,
  uiRuntimeControlJournalPath,
  uiRuntimeModeRoot,
  uiRuntimeTaskCheckpointPath,
  type UiRuntimeJournal,
  type UiRuntimeJournalRecord,
} from './journal.js';
import {
  createI2HistoryReader,
  type I2HistoryReadPorts,
  type I2HistoryReader,
} from './i2-history.js';
import { createJsonlI2JournalPort } from '../i2-journal.js';
import { readTaskAgentActivity, type DecodedTaskAgentActivitySelectionQuery,
  type AssembleTaskAgentActivityRemainingSourcesOptions } from './agent-activity-read.js';
import type {
  ConfiguredProjectCatalog,
  ConfiguredProjectReadSource,
  RuntimePaths,
} from '../../../config/src/index.js';
import { digestOf, type ExecutionAgentPort, type RetryCycleConfigSet } from '../../../runtime/src/orchestration/index.js';
import { createJsonlRetryCycleJournalPort, retryCycleJournalFilePath } from '../retry-cycle-journal.js';
import { createJsonlCheckpointJournal, createJsonlContextHistoryPort, createJsonlSemanticHistoryReader } from '../checkpoint-journal.js';
import { AppLifecycleError } from '../errors.js';
import {
  createExplicitBrainRuntime,
  type ExplicitBrainRuntime,
} from '../explicit-brain-runtime.js';
import {
  occurrenceTerminalProduction,
  OccurrenceTerminalError,
  type CommittedExecutionCheckpoint,
} from './occurrence-terminal.js';
import type { OccurrenceTerminalProduction } from './occurrence-consumer.js';

const APP_OWNER = 'humanagent.app';
const CHECKPOINT_ASSET_OWNER = 'humanagent.app.ui-runtime.checkpoint-asset';
const TASK_PLAN_HISTORY_OWNER = 'humanagent.app.ui-runtime.task-plan-history';
const RUNTIME_OWNER = 'humanagent.runtime';
const PROVIDER_EXECUTION_CAPABILITY = 'provider.execution';
// Keep the confirmed FIFO entry observable through real HTTP reads (status and
// task list) before the background drain starts consuming it. A macrotask-only
// delay is too short for a second localhost request to sample the queued state.
const QUEUED_VISIBILITY_WINDOW_MS = 100;

export type RuntimeExecutionMode = 'once' | 'scheduled' | 'recurring';

/**
 * Read-only display projection of one persisted execution plan.
 *
 * `state` is the durable `SubscriptionState` verbatim; the projection never
 * invents a second vocabulary, so a terminal plan keeps its real cause.
 *
 * `canPause`/`canResume`/`canCancelFuture` restate the guards the control owner
 * enforces in `decideSubscriptionControl`: pause requires `active`, resume
 * requires `suspended`, and cancel-future is refused only when the plan is
 * already `cancelled`. They are advisory display facts; the port re-checks them
 * inside its own transaction, so a stale client action still gets the durable
 * typed rejection and this projection never becomes a control truth.
 *
 * `nextDueAt` is the next committed policy slot after the durable
 * `currentOccurrenceOrdinal`, named by the same slot owner `dueTimes`/`schedule`
 * use. It is omitted when the committed schedule has no further slot.
 */
export interface RuntimeTaskPlanProjection {
  readonly subscriptionId: string;
  readonly state: SubscriptionState;
  readonly executionMode: RuntimeExecutionMode;
  readonly nextDueAt?: string;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canCancelFuture: boolean;
}

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
  /** The persisted plan this task belongs to; absent when the task has no plan. */
  readonly plan?: RuntimeTaskPlanProjection;
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

/**
 * The task/cycle Organ Journal store the app assembles. It carries checkpoints
 * and durable public-output records on the same file, so the public-output
 * port is resolved from the same store rather than a second journal.
 */
export type PublicOutputCheckpointStore = TaskCheckpointStore & PublicOutputJournalPort;

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
  readonly reconcileTaskScope?: (input: { readonly taskScope: ScopeRef }) => Promise<void>;
}

/**
 * The five execution ports the single Runtime coordinator consumes. The native
 * launch assembly supplies them from one `createDefaultExecutionComposition`;
 * a pure-library fixture supplies only `admitExecution`.
 */
type ServiceExecutionPorts = Pick<
  RuntimeTaskCoordinatorOptions,
  'admitExecution' | 'createDriver' | 'coldExecution' | 'currentStatePort' | 'currentStateFacts' | 'preparedExecutionStop'
> & {
  /**
   * The one canonical cold-resume selector. The launch execution composition
   * binds it from the retained allocation and the canonical source owners, so
   * the public consumer never supplies a business turn or a predecessor. It is
   * an App adapter port, not a Runtime coordinator option.
   */
  readonly resolveColdExecutionResumeRequest?: (input: {
    readonly taskId: TaskId;
    readonly operationId: OperationId;
  }) => Promise<RuntimeColdExecutionResumeRequest>;
  /**
   * The two confirmed-control facades bound to the physical owners. The
   * assembly owns `filePath`, `journal` and `principalOwner`; the public
   * consumer supplies only the confirmed business intent and reads the real
   * C1 receipt back.
   */
  readonly executeConfirmedTaskContextCorrection?: (
    request: ServiceContextCorrectionRequest,
  ) => Promise<CommittedTaskContextCorrectionReceipt>;
  readonly executeConfirmedTaskCheckpointReentry?: (
    request: ServiceCheckpointReentryRequest,
  ) => Promise<CommittedTaskCheckpointReentryReceipt>;
};

/**
 * The original coordinator callbacks the native composition needs. They are
 * captured before the coordinator exists and only delegate lazily, so the
 * composition never executes a callback during construction.
 */
type ServiceCoordinatorCallbacks = Pick<
  RuntimeTaskCoordinator,
  'publishCurrentTurnState' | 'closedTurnPlannerPool' | 'recordProviderRequestIdentity'
>;

/**
 * The public cold-resume receipt. It carries only the identities the bound
 * selector and the Runtime snapshot actually read back; it never invents a
 * capture, receipt or control field.
 */
export interface UiRuntimeExecutionResumeReceipt {
  readonly state: RuntimeExecutionRelease['state'];
  readonly taskId: string;
  readonly operationId: string;
  readonly businessTurnId: string;
  readonly executionEpoch?: number;
}

type CurrentExecutionView = Pick<RuntimeTaskSnapshot,
  'taskId' | 'operationId' | 'executionEpoch' | 'state' | 'allowedActions' | 'nextStep' | 'error'>;

export interface UiRuntimeGrantExecutionReceipt {
  readonly state: 'not-applicable' | 'current' | 'released' | 'blocked';
  readonly selector?: Pick<RuntimeTaskSnapshot, 'taskId' | 'operationId' | 'executionEpoch'>;
  readonly current?: CurrentExecutionView;
  readonly apiError?: UiRuntimeApiErrorBody;
}

export interface UiRuntimeTaskControlTarget {
  readonly projectKey: string;
  readonly mode: RuntimeMode;
}

export interface UiRuntimeServiceOptions {
  readonly mode: 'fake' | 'rcc';
  readonly maxConcurrentTasks?: number;
  readonly organId: OrganId;
  readonly binding: ProviderBinding;
  readonly port: ExecutionRuntimePort;
  readonly checkpointStoreFor: (taskId: TaskId, cycleId: CycleId) => PublicOutputCheckpointStore;
  readonly attentionPort: AttentionPort;
  readonly providerState: string;
  readonly providerReadiness?: ProviderReadiness;
  /**
   * The single task-scoped execution authority. When bound, a confirmed Task is
   * only materialized and acknowledged: execution auto-starts only after the
   * verified origin holds a `granted` task grant. The explicit `fake` launch
   * binds none and keeps its fixture simulation.
   */
  readonly taskGrantPort?: TaskGrantPort;
  readonly providerSource?: ProviderTransportSource;
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
  /**
   * The existing Task identity owner over the same control Organ Journal the
   * runtime already persists. The service never opens its own journal or mints
   * identity from snapshot/log/model metadata; it only binds the confirmed
   * typed requirement source to the Task it just created or reused. Absent on
   * a genuine typed new-task create, the dispatch fails instead of fabricating
   * an identity.
   */
  readonly taskIdentity?: TaskIdentityConsumer;
  readonly memory: UiRuntimeMemoryComposition;
  /**
   * The single owner of persisted execution plans (subscriptions). The app
   * assembly injects the durable port; the service only wires the confirmed
   * revision's execution policy into it.
   */
  readonly subscriptionControl?: SubscriptionControlPort;
  /** Canonical RuntimePaths for the serve-bound project. */
  readonly runtimePaths?: RuntimePaths;
  /** Declared physical native Journal for the bound runtime's readonly history. */
  readonly executionJournalPath?: string;
  /** Read-only I2 history authority; absent reports explicit unavailable. */
  readonly i2History?: I2HistoryReadPorts;
  /** Config-owned resolver for declared projects in the current control root. */
  readonly projectCatalog?: () => Promise<ConfiguredProjectCatalog>;
  readonly providerRetryConfig?: {
    readonly config: RetryCycleConfigSet;
    readonly journalRoot: string;
  };
  readonly runtimeComposition?: {
    readonly hydrateReadFor?: RuntimeTaskCoordinatorOptions['hydrateReadFor'];
    readonly createTaskAssembly?: (input: {
      readonly task: import('../../../contracts/src/index.js').Task;
      readonly scope: import('../../../contracts/src/index.js').ScopeRef;
      readonly checkpointJournal: TaskCheckpointStore;
      readonly executionAgent?: ExecutionAgentPort;
      readonly maxAttempts?: number;
      readonly childCallPort?: import('../../../runtime/src/orchestration/types.js').ChildCallPort;
    }) => RuntimeTaskAssembly;
    /**
     * Pure-library fixtures and fake contracts bind the real admission owner
     * directly on the original coordinator. Production launch uses
     * `createExecutionPorts` instead so it never opens a second coordinator.
     */
    readonly admitExecution?: RuntimeTaskCoordinatorOptions['admitExecution'];
    /**
     * Launch assembly of the full native execution ports. It is called exactly
     * once, before the coordinator is constructed; the supplied callbacks only
     * delegate lazily to that same coordinator.
     */
    readonly createExecutionPorts?: (coordinator: ServiceCoordinatorCallbacks) => ServiceExecutionPorts;
    /**
     * The configured native Provider selection the launch composition needs to
     * build its real execution driver. Absent for fake mode and pure fixtures.
     */
    readonly prepareAgentProvider?: Parameters<typeof createDefaultExecutionComposition>[0]['prepareAgentProvider'];
  };
  /**
   * Narrow durable boundary for the Runtime-owned active turn. The App
   * assembles the port; the Runtime owns the facts. When absent the prior
   * behaviour is unchanged.
   */
  readonly activeTurnJournal?: import('../../../runtime/src/context/active-turn-journal.js').ActiveTurnJournalPort;
  readonly activeTurnJournalFor?: import('../../../runtime/src/ui-runtime/coordinator.js').RuntimeTaskCoordinatorOptions['activeTurnJournalFor'];
  readonly initialInputStore?: import('../../../runtime/src/ui-runtime/coordinator.js').RuntimeTaskCoordinatorOptions['initialInputStore'];
  readonly recoveryReferencesFor?: import('../../../runtime/src/ui-runtime/coordinator.js').RuntimeTaskCoordinatorOptions['recoveryReferencesFor'];
  /** Native raw writes and acceptance must refer to the same actual execution. */
  readonly rawEvidence?: ProviderEvidenceSink;
  /**
   * Real Runtime permission/binding snapshot used to open the active turn.
   * Required whenever `activeTurnJournal` is bound; a missing snapshot stops
   * the active turn open instead of fabricating a permission revision.
   */
  readonly permissionSnapshot?: import('../../../runtime/src/admission/admitted-turn.js').RuntimeBindingSnapshot;
  /**
   * Durable store for refined child delivery assets. Required when the active
   * turn journal is bound so a cold read can resolve a child delivery.
   */
  readonly refinedDeliveryStore?: import('../../../runtime/src/ui-runtime/coordinator.js').RefinedDeliveryStore;
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
  readonly requestKind?: 'new-task-create' | 'existing-task-change';
  readonly taskRef?: TaskId;
  readonly executionPolicy?: ExecutionPolicyDefinition;
  readonly taskFlow?: TaskFlowBinding;
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
  readonly operationId?: OperationId;
  readonly executionEpoch?: number;
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
            // The provider binding's own turn identity. `requestIdentity` is the
            // request the binding reported before the first event arrived; the
            // newest event turn id is the durable record of the same identity.
            ...(latestTurnId(task) === undefined ? {} : { turnId: latestTurnId(task)! }),
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
 * The real provider turn identity of a task, taken from the runtime events the
 * provider binding stamped, or from the identity the binding reported for the
 * in-flight request. It is undefined when the provider never reported one.
 */
function latestTurnId(task: RuntimeTaskSnapshot): string | undefined {
  const fromEvents = task.events.reduce<string | undefined>((found, event) => event.turnId ?? found, undefined);
  return fromEvents ?? task.requestIdentity?.turnId;
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
      ...(call.turnId === undefined ? {} : { turnId: call.turnId }),
    });
  }
  return steps;
}

/**
 * Build the liveness facts from real runtime signals only.
 *
 * The newest real activity instant is the latest of
 *   - the request identity the provider binding itself reported for this task,
 *     and
 *   - the newest runtime event's own occurrence time.
 * `record.updatedAt` is deliberately not a source: the UI-driven paths also
 * write it, so it would let a browser refresh reset a real silence measurement.
 *
 * `active` comes from the lifecycle state, not from any internal running flag.
 * A task whose lifecycle still says `running` is exactly the stalled case this
 * projection must surface.
 */
function runtimeLivenessInput(
  task: RuntimeTaskSnapshot,
  observedAt: string,
): RuntimeLivenessInput {
  const requestIdentityAt = task.requestIdentity?.occurredAt;
  const newestEvent = task.events.length === 0 ? undefined : task.events[task.events.length - 1];
  let lastActivityAt = requestIdentityAt;
  let lastActivitySource = requestIdentityAt === undefined ? undefined : 'provider.request-identity';
  // The runtime's own record of the newest event wins a tie, because that is the
  // instant the runtime observed the activity it recorded.
  if (newestEvent !== undefined && (lastActivityAt === undefined || Date.parse(newestEvent.occurredAt) >= Date.parse(lastActivityAt))) {
    lastActivityAt = newestEvent.occurredAt;
    lastActivitySource = `runtime.event.${newestEvent.kind}`;
  }
  return {
    active: task.state === 'running' || task.state === 'settling',
    ...(lastActivityAt === undefined ? {} : { lastActivityAt, lastActivitySource }),
    silenceBudgetMs: DEFAULT_AGENT_IO_POLICY.maxSilentDurationMs,
    observedAt,
  };
}

/**
 * The runtime snapshot carries the contracts publication; the UI projection
 * consumes the flattened shape. This is the single boundary converting between
 * them, so no raw runtime type leaks into the projection.
 */
function toPublicOutputProjection(
  publication: PublicOutputPublication | undefined,
): PublicOutputPublicationProjection | undefined {
  if (publication === undefined) return undefined;
  return {
    state: publication.state,
    commits: publication.commits.map((commit) => ({
      commitId: commit.ref.commitId,
      journalSeq: commit.ref.journalSeq,
      recordDigest: commit.ref.recordDigest,
      text: commit.text,
    })),
    ...(publication.publicCommitWatermark === undefined ? {} : { publicCommitWatermark: publication.publicCommitWatermark }),
  };
}

/**
 * The runtime snapshot carries the contracts publication; the UI projection
 * consumes the flattened shape. This is the single boundary that converts
 * between them so no raw runtime type leaks into the projection.
 */
function toRuntimeTaskSnapshotInput(task: RuntimeTaskSnapshot): RuntimeTaskSnapshotInput {
  return { ...task, publicOutput: toPublicOutputProjection(task.publicOutput) };
}

/**
 * The current operation/epoch binding for a task, or `undefined` when the task
 * has no active operation. `harnessTurnId` stays absent because this legacy
 * execution slice never claims a Harness turn.
 */
/**
 * The coordinator ABI owner lands `readonly cycleId?: string` on the runtime
 * snapshot. This reader dereferences it through the structural extension so
 * the app tree stays buildable before that runtime ABI composes.
 */
type RuntimeTaskSnapshotWithCycle = RuntimeTaskSnapshot & { readonly cycleId?: string };

function publicOutputBindingFor(task: RuntimeTaskSnapshotWithCycle, organId: OrganId): PublicOutputBinding | undefined {
  if (task.operationId === undefined || task.cycleId === undefined || task.executionEpoch === undefined) {
    return undefined;
  }
  return {
    scope: {
      organId,
      taskId: task.taskId,
      cycleId: id('cycle', task.cycleId),
      operationId: id('operation', task.operationId),
    },
    executionEpoch: task.executionEpoch,
  };
}

function runtimeTaskDashboard(
  task: RuntimeTaskSnapshot,
  mode: 'fake' | 'rcc',
  liveness?: RuntimeLivenessInput,
  authoritativePublication?: PublicOutputPublicationProjection,
): RuntimeTaskDashboardView {
  // Public result availability is derived from committed publication only; the
  // internal execution output is not publication evidence.
  const projected = projectRuntimeTaskDashboard({
    ...toRuntimeTaskSnapshotInput(task),
    ...(authoritativePublication === undefined ? {} : { publicOutput: authoritativePublication }),
    ...(liveness === undefined ? {} : { liveness }),
  }, mode);
  const history = task.events;
  const omitted = Math.max(0, history.length - task.recentEvents.length);
  const stateLabel = projected.stateLabel;
  const hasCheckpoint = task.checkpoint !== undefined;
  const resultAvailable = projected.publicOutput !== undefined && projected.publicOutput.commits.length > 0;
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
      waiting: projectRuntimeTaskWaitingStatus(projected),
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
  if (error instanceof AppLifecycleError) {
    // App lifecycle refusals (for example a missing cold-execution source) are
    // typed conflicts: the durable recovery responsibility is retained and the
    // original cause is preserved so the caller can inspect the exact truth.
    return new UiRuntimeApiError(
      error.code,
      error.ownerId,
      error.message,
      error.nextAction,
      409,
      undefined,
      error.cause,
    );
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
      // The adapter's own message states the phase that failed; the failure it
      // wrapped is the original error the human needs. It is passed through
      // unchanged and stays absent when the adapter reported no original error.
      error.cause,
    );
  }
  return new UiRuntimeApiError(
    'ui-runtime.unexpected',
    APP_OWNER,
    error instanceof Error ? error.message : String(error),
    'inspect the runtime error and retry from a new operation',
    500,
    undefined,
    error instanceof Error ? error.cause : undefined,
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

/**
 * The single owner of the confirmed-execution-plan subscription id convention.
 * `persistAuthorizedExecutionPlan` mints the id and the scheduled occurrence
 * dispatch resolves the requirement back from it.
 */
function subscriptionIdForRequirement(requirementId: string): string {
  return `subscription:${requirementId}`;
}

/**
 * Read-only display projection of one persisted execution plan.
 *
 * `state` is the durable `SubscriptionState` verbatim: the projection never
 * invents a second vocabulary, so a terminal plan keeps its real cause.
 *
 * `canPause`/`canResume`/`canCancelFuture` restate the guards the control owner
 * enforces in `decideSubscriptionControl`: pause requires `active`, resume
 * requires `suspended`, and cancel-future is refused only when the plan is
 * already `cancelled`. They are advisory display facts; the port re-checks them
 * inside its own transaction, so a stale client action still gets the durable
 * typed rejection and this projection never becomes a control truth.
 *
 * `nextDueAt` is the next committed policy slot after the durable
 * `currentOccurrenceOrdinal`, named by the same slot owner `dueTimes`/`schedule`
 * use. It is omitted when the committed schedule has no further slot.
 */
function projectExecutionPlan(snapshot: SubscriptionSnapshot): RuntimeTaskPlanProjection {
  const subscription = snapshot.subscription;
  const next = nextPolicySlotAfter(snapshot.policy, subscription.currentOccurrenceOrdinal);
  return {
    subscriptionId: subscription.subscriptionId,
    state: subscription.state,
    executionMode: snapshot.policy.executionMode,
    ...(next === undefined ? {} : { nextDueAt: next.dueAt }),
    canPause: subscription.state === 'active',
    canResume: subscription.state === 'suspended',
    canCancelFuture: subscription.state !== 'cancelled',
  };
}

function requirementIdForSubscription(subscriptionId: string): string {
  const prefix = 'subscription:';
  if (!subscriptionId.startsWith(prefix) || subscriptionId.length === prefix.length) {
    throw new UiRuntimeApiError(
      'scheduled-occurrence.plan-identity-invalid',
      RUNTIME_OWNER,
      `execution plan id is not a requirement subscription: ${subscriptionId}`,
      'inspect the persisted execution plan identity before dispatching it',
      409,
    );
  }
  return subscriptionId.slice(prefix.length);
}

/**
 * Upper bound on how long the scheduled-occurrence dispatch waits for the real
 * execution terminal. A provider that never terminates must not pin the patrol
 * forever; the wait fails explicitly and the occurrence stays claimed with its
 * durable recovery responsibility instead of being reported as settled.
 */
const SCHEDULED_OCCURRENCE_TERMINAL_TIMEOUT_MS = 30 * 60_000;

export interface TaskContextHistoryQuery {
  readonly projectKey: string;
  readonly mode: RuntimeMode;
  readonly limit: number;
  readonly cursor?: string;
  readonly agentRuntimeId?: string;
  readonly contextViewRef?: string;
}

export interface TaskCheckpointHistoryQuery {
  readonly projectKey: string;
  readonly mode: RuntimeMode;
  readonly limit: number;
  readonly cursor?: string;
  readonly viewed?: CheckpointHistoryReadInput['viewed'];
  readonly directiveRevision?: number;
  readonly executionEpoch?: number;
  readonly cycleId?: CycleId;
  readonly occurrenceRef?: string;
}

/**
 * Exact checkpoint and asset role a body read addresses. The caller never
 * supplies a descriptor, locator, digest or scope; those come from the
 * canonical committed checkpoint.
 */
export interface TaskCheckpointAssetBodyQuery {
  readonly projectKey: TaskCheckpointHistoryQuery['projectKey'];
  readonly mode: TaskCheckpointHistoryQuery['mode'];
  readonly viewed: RuntimeCheckpointAssetTarget;
  readonly selector: RuntimeCheckpointAssetSelector;
}

/** Read-only I2 history queries. Scope is the exact task; there is no write path. */
export interface I2HistoryScopeInput {
  readonly projectKey?: string;
  readonly mode?: RuntimeMode;
}

export interface I2HistoryListQuery extends I2HistoryScopeInput {
  readonly limit: number;
  readonly cursor?: string;
}

export interface I2HistoryViewedQuery extends I2HistoryListQuery {
  readonly viewed?: string;
}

export interface I2HistoryReviewQuery extends I2HistoryListQuery {
  readonly cycleId?: string;
  readonly milestoneId?: string;
}

interface ResolvedTaskHistoryJournals {
  readonly source: ConfiguredProjectReadSource;
  readonly organId: OrganId;
  readonly files: readonly string[];
}

function unknownProjectFailure(projectKey: string): RuntimeReadFailure {
  return {
    code: 'project.unknown',
    ownerId: APP_OWNER,
    message: `no configured project: ${projectKey}`,
    nextAction: 'list configured projects and retry with a declared projectKey',
  };
}

function unknownTaskFailure(taskId: TaskId, projectKey: string, mode: RuntimeMode): RuntimeReadFailure {
  return {
    code: 'task.not-found',
    ownerId: APP_OWNER,
    message: `no durable task ${taskId.value} in ${projectKey}/${mode}`,
    nextAction: 'select an existing task scope',
  };
}

/**
 * Reasoning plan history answers only for a task whose committed typed identity
 * names its Organ in the source/mode's canonical control Journal. When no
 * identity is committed the caller sees this typed failure; it never receives
 * an empty history, the latest publication, or the scheduling plan.
 */
function taskIdentityAuthorityFailure(
  taskId: TaskId,
  projectKey: string,
  mode: RuntimeMode,
  conflict: boolean,
): RuntimeReadFailure {
  return conflict
    ? {
      code: 'task-plan-history.identity-conflict',
      ownerId: TASK_PLAN_HISTORY_OWNER,
      message: `task ${taskId.value} in ${projectKey}/${mode} has conflicting committed Task identity Organ authority`,
      nextAction: 'resolve the conflicting Task identity records before reading plan history for this scope',
    }
    : {
      code: 'task-plan-history.scope-unavailable',
      ownerId: TASK_PLAN_HISTORY_OWNER,
      message: `task ${taskId.value} in ${projectKey}/${mode} has no committed Task identity scope in its canonical Journal`,
      nextAction: 'establish the Task identity before reading reasoning plan history for this scope',
    };
}

function taskPlanHistoryReadFailure(taskId: TaskId, message: string): RuntimeReadFailure {
  return {
    code: 'task-plan-history.read-failed',
    ownerId: TASK_PLAN_HISTORY_OWNER,
    message,
    nextAction: 'restore the canonical task control Journal read for this task scope',
  };
}

function readFailureFromError(error: unknown): RuntimeReadFailure {
  if (error instanceof UiRuntimeApiError) {
    return { code: error.code, ownerId: error.ownerId, message: error.message, nextAction: error.nextAction };
  }
  if (error instanceof RuntimeTaskControlError) {
    return { code: error.code, ownerId: error.ownerId, message: error.message, nextAction: error.nextAction };
  }
  if (error instanceof AppLifecycleError) {
    return { code: error.code, ownerId: error.ownerId, message: error.message, nextAction: error.nextAction };
  }
  return {
    code: 'read.failed',
    ownerId: APP_OWNER,
    message: error instanceof Error ? error.message : String(error),
    nextAction: 'inspect the runtime read failure and retry',
  };
}

function i2UnavailableFailure(): RuntimeReadFailure {
  return {
    code: 'i2.history.unavailable',
    ownerId: APP_OWNER,
    message: 'no I2 history authority is bound to this runtime',
    nextAction: 'assemble the runtime with the Organ Journal I2 history port',
  };
}

const HISTORY_ENUMERATION_LIMIT = 10_000;

/**
 * Opaque cursor for the task-scoped context/checkpoint history reads. `f` is the
 * resolved cycle-journal index, `i` the item position inside that journal, and
 * `fp` a fingerprint of the project/mode/task/filter identity so a cursor can
 * never be replayed against a different scope or filter set.
 */
interface HistoryCursor {
  readonly f: number;
  readonly i: number;
  readonly fp: string;
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return JSON.stringify({ v: 1, f: cursor.f, i: cursor.i, fp: cursor.fp });
}

function decodeHistoryCursor(value: string): HistoryCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const candidate = parsed as { readonly f?: unknown; readonly i?: unknown; readonly fp?: unknown };
  if (!Number.isSafeInteger(candidate.f) || (candidate.f as number) < 0) return undefined;
  if (!Number.isSafeInteger(candidate.i) || (candidate.i as number) < 0) return undefined;
  if (typeof candidate.fp !== 'string') return undefined;
  return { f: candidate.f as number, i: candidate.i as number, fp: candidate.fp };
}

function historyFingerprint(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function toRuntimeCommitRef(ref: JournalCommitRef): RuntimeCommitRefProjection {
  return { commitId: ref.commitId, journalSeq: ref.journalSeq, recordDigest: ref.recordDigest };
}

function toRuntimeReplacement(replacement: ContextReplacement): RuntimeContextReplacementProjection {
  return {
    replacementId: replacement.replacementId,
    executionEpoch: replacement.executionEpoch,
    fromContextViewRef: replacement.fromContextViewRef,
    toContextViewRef: replacement.toContextViewRef,
    toContextDigest: replacement.toContextDigest,
    deltaIds: [...replacement.deltaIds],
    reason: replacement.reason,
    replacementDigest: replacement.replacementDigest,
  };
}

function historyCursorFailure(family: 'context-history' | 'checkpoints', kind: 'invalid' | 'scope' | 'not-found'): RuntimeReadFailure {
  if (kind === 'invalid') {
    return {
      code: `${family}.cursor-invalid`,
      ownerId: APP_OWNER,
      message: 'history cursor is not a decoded history cursor',
      nextAction: `request the first ${family} page without a cursor`,
    };
  }
  if (kind === 'scope') {
    return {
      code: `${family}.cursor-scope-mismatch`,
      ownerId: APP_OWNER,
      message: 'history cursor belongs to a different project/mode/task scope or filter set',
      nextAction: `use a cursor returned for the same ${family} scope`,
    };
  }
  return {
    code: `${family}.cursor-not-found`,
    ownerId: APP_OWNER,
    message: 'history cursor does not point at a current entry in this task scope',
    nextAction: `request the first ${family} page again`,
  };
}

function journalRecordTaskId(record: UiRuntimeJournalRecord): string | undefined {
  switch (record.kind) {
    case 'task.created':
    case 'task.updated':
    case 'task.deleted':
    case 'operation.started':
      return record.taskId.value;
    case 'operation.event':
      return record.event.taskId.value;
    default:
      return undefined;
  }
}

/** Modes with a real UI runtime Journal layout. `dsh` has no durable reader here. */
const READABLE_RUNTIME_MODES: readonly RuntimeMode[] = ['fake', 'rcc'];

function taskRowOf(input: RuntimeTaskSnapshotInput, mode: RuntimeMode): RuntimeTaskRowProjection {
  const list = projectRuntimeTaskList({ mode, tasks: [input] });
  const row = [...list.running, ...list.waiting, ...list.completed, ...list.stopped, ...list.draft, ...list.failed][0];
  if (row === undefined) throw new Error('task row projection returned no row');
  return row;
}

interface RecordsCursor {
  readonly view: 'actions' | 'raw';
  readonly ref: RuntimeStoredRecordRef;
}

function encodeRecordsCursor(cursor: RecordsCursor): string {
  return JSON.stringify(cursor);
}

function decodeRecordsCursor(value: string): RecordsCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const candidate = parsed as { readonly view?: unknown; readonly ref?: unknown };
  if (candidate.view !== 'actions' && candidate.view !== 'raw') return undefined;
  if (!candidate.ref || typeof candidate.ref !== 'object' || Array.isArray(candidate.ref)) return undefined;
  return candidate as RecordsCursor;
}

function sameStoredRef(left: RuntimeStoredRecordRef, right: RuntimeStoredRecordRef): boolean {
  return left.projectKey === right.projectKey
    && left.mode === right.mode
    && left.taskId.scope === right.taskId.scope
    && left.taskId.value === right.taskId.value
    && left.source === right.source
    && left.ordinal === right.ordinal
    && left.operationId === right.operationId
    && left.executionEpoch === right.executionEpoch
    && left.checkpointId === right.checkpointId;
}

function rawEventProjection(event: RuntimeTaskEvent): RuntimeRawEventProjection {
  return {
    seq: event.seq,
    kind: event.kind,
    state: event.state,
    summary: event.summary,
    occurredAt: event.occurredAt,
    evidenceRefs: event.evidenceRefs,
    ...(event.callId === undefined ? {} : { callId: event.callId }),
    ...(event.toolId === undefined ? {} : { toolId: event.toolId }),
    ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
    ...(event.status === undefined ? {} : { status: event.status }),
    ...(event.error === undefined ? {} : { error: event.error }),
    ...(event.outputRef === undefined ? {} : { outputRef: event.outputRef }),
    ...(event.outputDigest === undefined ? {} : { outputDigest: event.outputDigest }),
    ...(event.ownerId === undefined ? {} : { ownerId: event.ownerId }),
    ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
    ...(event.nextAction === undefined ? {} : { nextAction: event.nextAction }),
    ...(event.terminalPhase === undefined ? {} : { terminalPhase: event.terminalPhase }),
    eventId: event.eventId,
    operationId: event.operationId,
    executionEpoch: event.executionEpoch,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(event.parentRequestId === undefined ? {} : { parentRequestId: event.parentRequestId }),
    ...(event.providerOccurredAt === undefined ? {} : { providerOccurredAt: event.providerOccurredAt }),
  };
}

interface RawRecordBuild {
  readonly body: RuntimeRawRecordBody;
  readonly occurredAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly operationId?: string;
  readonly executionEpoch?: number;
}

function rawBuildForJournalRecord(record: UiRuntimeJournalRecord): RawRecordBuild | undefined {
  switch (record.kind) {
    case 'task.created':
      return {
        body: { kind: 'task.created', title: record.title, directive: record.directive, directiveRevision: record.directiveRevision },
        occurredAt: record.createdAt,
        evidenceRefs: [],
      };
    case 'task.updated':
      return {
        body: { kind: 'task.updated', title: record.title, directive: record.directive, directiveRevision: record.directiveRevision },
        occurredAt: record.updatedAt,
        evidenceRefs: [],
      };
    case 'task.deleted':
      return { body: { kind: 'task.deleted', deletedAt: record.deletedAt }, occurredAt: record.deletedAt, evidenceRefs: [] };
    case 'operation.started':
      return {
        body: {
          kind: 'operation.started',
          operationId: record.operationId.value,
          executionEpoch: record.executionEpoch,
          input: record.input,
          orchestrated: record.orchestrated === true,
        },
        occurredAt: record.startedAt,
        evidenceRefs: [],
        operationId: record.operationId.value,
        executionEpoch: record.executionEpoch,
      };
    case 'operation.event':
      return {
        body: { kind: 'operation.event', event: rawEventProjection(record.event) },
        occurredAt: record.event.occurredAt,
        evidenceRefs: record.event.evidenceRefs,
        operationId: record.operationId.value,
        executionEpoch: record.event.executionEpoch,
      };
    default:
      return undefined;
  }
}

interface PagedRecords<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly failure?: RuntimeReadFailure;
}

function paginateRecords<T extends { readonly ref: RuntimeStoredRecordRef }>(
  all: readonly T[],
  cursor: RecordsCursor | undefined,
  limit: number,
  view: 'actions' | 'raw',
): PagedRecords<T> {
  let start = 0;
  if (cursor !== undefined) {
    const index = all.findIndex((item) => sameStoredRef(item.ref, cursor.ref));
    if (index < 0) {
      return {
        items: [],
        hasMore: false,
        failure: {
          code: 'records.cursor-not-found',
          ownerId: APP_OWNER,
          message: 'records cursor does not point at a current record in this task scope',
          nextAction: 'request the first records page again',
        },
      };
    }
    start = index + 1;
  }
  const items = all.slice(start, start + limit);
  const hasMore = start + items.length < all.length;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    ...(hasMore && last !== undefined ? { nextCursor: encodeRecordsCursor({ view, ref: last.ref }) } : {}),
  };
}

/**
 * Assemble the canonical checkpoint history reader for one project source and
 * mode. History reads and asset body reads share this single assembly so both
 * resolve committed checkpoints and evidence through the same owners.
 */
function checkpointHistoryReaderAssembly(
  runtimePaths: RuntimePaths | undefined,
  source: ConfiguredProjectReadSource,
  mode: RuntimeMode,
  journal: JsonlOrganJournal,
): CheckpointHistoryReader {
  const filePath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, mode));
  const checkpoints = createJsonlCheckpointJournal({ filePath, journal });
  // Match the native launch/CLI evidence root beneath the Config-owned project root.
  const artifactsRoot = join(source.projectRoot, 'artifacts', 'ui-provider-evidence');
  const assets = new ImmutableAssetStore(artifactsRoot);
  return createCheckpointHistoryReader({
    checkpoints, native: checkpoints,
    contexts: createJsonlContextHistoryPort({ filePath, journal }),
    semantic: createJsonlSemanticHistoryReader({ filePath, journal, artifactsRoot,
      activeTurnJournalFor: (turnId) => createJsonlActiveTurnJournal({ journal, turnId }),
      segmentJournalFor: (businessTurnId) => createJsonlActiveTurnSegmentJournal({ journal, businessTurnId }),
      rawContent: providerRawContentReader(filesystemProviderEvidenceSink(assets)),
    }),
    capture: createNativeRecoveryAssets({ journalPath: filePath, journal, assetRoot: artifactsRoot,
      completionJournal: new JsonlOperationCompletionJournal({ journal }) }),
  });
}

function sameTypedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

/**
 * Select the exact committed asset a body read addresses. A capture read needs
 * the committed capture descriptor; an adopted-child read needs exactly one
 * committed delivery matching the full triple. Zero or multiple matches are an
 * explicit failure, never a first-item or latest-delivery substitution.
 */
function checkpointAssetForSelector(
  viewed: RuntimeCheckpointDetailProjection,
  selector: RuntimeCheckpointAssetSelector,
  taskScope: TaskIdentityScope,
): RuntimeReadResult<RawAsset> {
  if (selector.kind === 'capture') {
    if (viewed.capture.state !== 'known') {
      return { ok: false, failure: {
        code: 'checkpoint-asset.unavailable',
        ownerId: CHECKPOINT_ASSET_OWNER,
        message: `checkpoint has no committed capture asset: ${viewed.capture.reason}`,
        nextAction: 'read a checkpoint that has a committed capture',
      } };
    }
    return { ok: true, value: viewed.capture.capture };
  }
  if (viewed.semantic.state !== 'known') {
    return { ok: false, failure: {
      code: 'checkpoint-asset.unavailable',
      ownerId: CHECKPOINT_ASSET_OWNER,
      message: `checkpoint has no committed adopted children: ${viewed.semantic.reason}`,
      nextAction: 'read a checkpoint with committed semantic publication',
    } };
  }
  const matches = viewed.semantic.adoptedChildren.filter((child) => child.invocationId === selector.invocationId
    && child.childTurnId === selector.childTurnId && child.deliverySeq === selector.deliverySeq);
  if (matches.length !== 1) {
    return { ok: false, failure: {
      code: matches.length === 0 ? 'checkpoint-asset.not-found' : 'checkpoint-asset.ambiguous',
      ownerId: CHECKPOINT_ASSET_OWNER,
      message: matches.length === 0
        ? `no committed adopted delivery for invocation ${selector.invocationId}, child turn ${selector.childTurnId}, delivery ${selector.deliverySeq} in task ${taskScope.taskId.value}`
        : `${matches.length} committed adopted deliveries match invocation ${selector.invocationId}, child turn ${selector.childTurnId}, delivery ${selector.deliverySeq} in task ${taskScope.taskId.value}`,
      nextAction: 'supply the exact committed invocation, child turn and delivery sequence of one adopted delivery',
    } };
  }
  return { ok: true, value: matches[0]!.refinedDelivery };
}

export class UiRuntimeService {
  private readResources?: { readonly runtimePaths: RuntimePaths; readonly projectCatalog: () => Promise<ConfiguredProjectCatalog> };

  bindReadResources(input: { readonly runtimePaths: RuntimePaths; readonly projectCatalog: () => Promise<ConfiguredProjectCatalog> }): void {
    this.readResources = input;
  }

  async taskPlanHistory(taskId: TaskId, projectKey: string, mode: RuntimeMode): Promise<RuntimeReadResult<RuntimeTaskPlanHistoryProjection>> {
    const source = await this.findProjectSource(projectKey);
    if (source === undefined) return { ok: false, failure: unknownProjectFailure(projectKey) };
    return this.taskPlanHistoryFor(source, mode, taskId);
  }

  /**
   * Resolve the exact serve-bound Task from Config-owned RuntimePaths and the
   * live coordinator snapshot. A scope from the request is only compared here;
   * it never becomes the source of the returned project/mode.
   */
  async verifyControllableTaskTarget(
    taskId: TaskId,
    projectKey: string,
    mode: RuntimeMode,
  ): Promise<UiRuntimeTaskControlTarget> {
    const source = this.boundProjectSource();
    if (source === undefined || !this.isBoundScope(projectKey, mode)) {
      throw new UiRuntimeApiError(
        'task-control.target.not-bound',
        APP_OWNER,
        `task control target ${projectKey}/${mode} is outside the serve-bound scope`,
        'open the formal task navigation for the active project and mode',
        409,
      );
    }
    try {
      const task = this.taskDetail(taskId);
      if (task.taskId.value !== taskId.value) {
        throw new UiRuntimeApiError(
          'task-control.target.not-bound',
          APP_OWNER,
          `task control target ${taskId.value} is not the live Task`,
          'open the formal task navigation for the active live Task',
          409,
        );
      }
    } catch (error) {
      if (error instanceof UiRuntimeApiError) throw error;
      throw new UiRuntimeApiError(
        'task-control.target.not-bound',
        APP_OWNER,
        `task control target ${taskId.value} is not a live Task in ${source.projectKey}/${this.mode}`,
        'open the formal task navigation for the active live Task',
        409,
        undefined,
        error,
      );
    }
    return { projectKey: source.projectKey, mode: this.mode };
  }

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
  private readonly i2Reader?: I2HistoryReader;
  private readonly resolveColdExecutionResumeRequest?: ServiceExecutionPorts['resolveColdExecutionResumeRequest'];
  private readonly contextCorrectionPort?: ServiceExecutionPorts['executeConfirmedTaskContextCorrection'];
  private readonly checkpointReentryPort?: ServiceExecutionPorts['executeConfirmedTaskCheckpointReentry'];
  private readonly nativeDriverBound: boolean;
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
    // The native launch assembly builds its execution ports once, before this
    // coordinator exists. The callbacks it receives only delegate lazily to the
    // coordinator assigned below, so nothing runs during construction.
    const executionPorts = options.runtimeComposition?.createExecutionPorts?.({
      publishCurrentTurnState: (taskId) => this.coordinator.publishCurrentTurnState(taskId),
      closedTurnPlannerPool: (taskId) => this.coordinator.closedTurnPlannerPool(taskId),
      recordProviderRequestIdentity: (event) => this.coordinator.recordProviderRequestIdentity(event),
    });
    this.resolveColdExecutionResumeRequest = executionPorts?.resolveColdExecutionResumeRequest;
    this.contextCorrectionPort = executionPorts?.executeConfirmedTaskContextCorrection;
    this.checkpointReentryPort = executionPorts?.executeConfirmedTaskCheckpointReentry;
    const nativeDriverBound = executionPorts?.createDriver !== undefined;
    this.nativeDriverBound = nativeDriverBound;
    this.coordinator = new RuntimeTaskCoordinator({
      organId: options.organId,
      checkpointStoreFor: options.checkpointStoreFor,
      publicOutputStoreFor: options.checkpointStoreFor,
      attentionPort: options.attentionPort,
      journal: options.journal,
      hookRegistry: options.hookRegistry,
      taskIdPrefix: randomUUID(),
      now: options.now,
      createDriver: (input) => this.createMemoryBoundDriver(input),
      ...(options.providerRetryConfig === undefined || executionPorts !== undefined
        ? {}
        : {
            providerRetry: {
              config: options.providerRetryConfig.config,
              journal: createJsonlRetryCycleJournalPort({
                filePath: retryCycleJournalFilePath({ journalRoot: options.providerRetryConfig.journalRoot }),
              }),
              createDriverForBinding: (bindingId, input) => nativeDriverBound
                ? this.nativeRetryBindingSelectionUnavailable(bindingId)
                : this.createMemoryBoundDriverForBinding(bindingId, input),
            },
          }),
      ...(options.runtimeComposition === undefined ? {} : {
        ...(options.runtimeComposition.hydrateReadFor === undefined ? {} : {
          hydrateReadFor: options.runtimeComposition.hydrateReadFor,
        }),
        ...(options.runtimeComposition.createTaskAssembly === undefined ? {} : {
          createTaskAssembly: (input) => options.runtimeComposition!.createTaskAssembly!({
            task: input.task,
            scope: input.scope,
            checkpointJournal: input.checkpointJournal,
            ...(input.executionAgent === undefined ? {} : { executionAgent: input.executionAgent }),
            ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
            ...(input.childCallPort === undefined ? {} : { childCallPort: input.childCallPort }),
          }),
        }),
      }),
      ...(executionPorts === undefined ? {} : executionPorts),
      ...(options.runtimeComposition?.admitExecution === undefined ? {} : {
        admitExecution: options.runtimeComposition.admitExecution,
      }),
      ...(options.workspaceRoot === undefined ? {} : {
        producedArtifacts: {
          read: (request) => readProducedArtifacts(options.workspaceRoot!, request.paths),
        },
      }),
      ...(this.memory.checkpointBoundary === undefined ? {} : { checkpointBoundary: this.memory.checkpointBoundary }),
      ...(options.activeTurnJournal === undefined ? {} : { activeTurnJournal: options.activeTurnJournal }),
      ...(options.activeTurnJournalFor === undefined ? {} : { activeTurnJournalFor: options.activeTurnJournalFor }),
      ...(options.initialInputStore === undefined ? {} : { initialInputStore: options.initialInputStore }),
      ...(options.recoveryReferencesFor === undefined ? {} : { recoveryReferencesFor: options.recoveryReferencesFor }),
      ...(options.permissionSnapshot === undefined ? {} : { permissionSnapshot: options.permissionSnapshot }),
      ...(options.refinedDeliveryStore === undefined ? {} : { refinedDeliveryStore: options.refinedDeliveryStore }),
    });
    this.implicitBrain = new ImplicitBrainFifo({
      inbox: this.requirementInbox,
      maxConcurrentTasks: options.maxConcurrentTasks,
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
    this.i2Reader = options.i2History === undefined ? undefined : createI2HistoryReader(options.i2History);
  }

  semanticObservation(taskId: TaskId): RuntimeSemanticObservationEnvelope {
    try {
      const task = this.coordinatorOrQueuedTaskSnapshot(taskId);
      const semantic = buildSemanticObservation({
        scope: {
          organId: this.options.organId,
          taskId: task.taskId,
          ...(task.operationId === undefined || task.executionEpoch === undefined ? {} : { operationId: id('operation', task.operationId) }),
        },
        projectionVersion: 'runtime-semantic-v1',
        sourceWatermark: task.events.length,
        events: task.events,
        capabilities: [{ capability: 'runtime-task-events', state: task.events.length > 0 ? 'available' : 'unavailable', ...(task.events.length > 0 ? {} : { reason: 'task has no runtime task events yet' }) }],
      });
      return projectRuntimeSemanticObservation({ taskId, semantic });
    } catch (error) {
      throw apiError(error);
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
    try {
      validatePersistedToolExecutionFact(event, { taskId, operationId, executionEpoch });
    } catch (error) {
      throw new UiRuntimeApiError(
        'tool-output.fact-integrity',
        RUNTIME_OWNER,
        error instanceof Error ? error.message : 'the persisted tool execution fact is not related to the selected event',
        'repair or discard the UI runtime journal before restarting',
        409,
        undefined,
        error,
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
    let report: unknown;
    try {
      report = await this.options.toolOutputStore.readReport({
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
    if (event.toolId === RESPONSES_FILE_SEARCH_TOOL.toolId && event.executionFact !== undefined) {
      try {
        validateCodeSearchReport(report);
      } catch (error) {
        throw new UiRuntimeApiError(
          'tool-output.report-unqualified',
          RUNTIME_OWNER,
          error instanceof Error ? error.message : 'the file.search report is not qualified',
          'inspect the persisted file.search report contract',
          409,
          undefined,
          error,
        );
      }
    }
    return report;
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
      const boundaryMessages = [
        ...(reviewState?.boundaryAttentions ?? [])
          .filter((attention) => attention.state !== 'resolved')
          .map((attention) => `${attention.message}; ${attention.nextAction?.ref ?? 'review the canonical task Journal'}`),
        ...(reviewState?.boundaryError === undefined ? [] : [
          `Memory diagnostic was not persisted/read: ${reviewState.boundaryError.code}: ${reviewState.boundaryError.message}; ${reviewState.boundaryError.nextAction}`,
        ]),
      ];
      const boundaryDetail = boundaryMessages.join('\n');
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
          state: boundaryMessages.length > 0 ? 'degraded' : 'ready',
          label: 'Memory Interaction',
          detail: boundaryDetail || 'typed projection from the deterministic memory backend',
        },
        scope: this.memory.projectKey,
        summary: boundaryDetail || (query
          ? view.entries.length === 0
            ? '当前没有匹配的长期记忆'
            : `当前有 ${view.entries.length} 条匹配记录`
          : '未指定过滤条件'),
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

  /**
   * The native execution factory selects its Provider through the configured
   * `prepareAgentProvider` rather than a Retry-10 binding id, so the legacy
   * per-binding driver cannot serve a configured retry path without bypassing
   * native. Surface that exact gap instead of silently ignoring the declared
   * retry config or falling back to the old driver.
   */
  private nativeRetryBindingSelectionUnavailable(bindingId: string): never {
    throw new RuntimeTaskControlError(
      'execution.retry.native-binding-selection-unavailable',
      'humanagent.app.ui-runtime',
      `the configured native execution factory has no binding-selection entry for retry candidate ${bindingId}`,
      'select the declared retry candidate through the native Provider factory before dispatch',
    );
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
      onRequestLifecycle: (event) => this.coordinator.recordProviderRequestIdentity(event),
      ...(this.options.rawEvidence === undefined ? {} : {
        rawEvidence: this.options.rawEvidence,
        registerRequest: (registration: Parameters<RuntimeTaskCoordinator['registerNativeProviderRequest']>[1]) =>
          this.coordinator.registerNativeProviderRequest(input.taskId, registration),
        acceptRawFact: (envelope: import('../../../contracts/src/index.js').RawFactEnvelope) =>
          this.coordinator.acceptNativeProviderRawFact(input.taskId, envelope),
      }),
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
    const execute = async (input: Parameters<ExecutionAgentPort['execute']>[0]): Promise<WorkResult> => {
        const runtimeId = `implicit-executor-${input.assignment.assignmentId}-${input.attempt}-${input.executionEpoch}`;
        const operationId = id('operation', `implicit-${input.assignment.assignmentId}-${input.attempt}`);
        const scope = { ...input.scope, operationId };
        const nativeTurn = this.options.rawEvidence === undefined ? undefined : await this.coordinator.openNativeChildTurn({
          assignment: input.assignment, scope, runtimeId,
        });
        const driver = new ProviderAgentDriver({
          port: this.options.port,
          binding: this.options.binding,
          runtimeId,
          taskId: input.assignment.taskId,
          operationId,
          executionEpoch: input.executionEpoch,
          assignmentId: input.assignment.assignmentId,
          scope,
          inputRefs: [...input.assignment.targetRefs, input.assignment.objective],
          ownerId: RUNTIME_OWNER,
          onRequestLifecycle: (event) => this.coordinator.recordProviderRequestIdentity(event),
          ...(nativeTurn === undefined ? {} : {
            rawEvidence: this.options.rawEvidence!,
            registerRequest: (registration: Parameters<RuntimeTaskCoordinator['registerNativeProviderRequest']>[1]) =>
              nativeTurn.context.registerProviderRequest(registration),
            acceptRawFact: (envelope: import('../../../contracts/src/index.js').RawFactEnvelope) =>
              nativeTurn.context.acceptRawFact(envelope),
          }),
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
    };
    return {
      roleId: 'ui-runtime-implicit-executor',
      createInstance: (create) => ({ incarnation: create.incarnation, execute, dispose: async () => {} }),
      execute,
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
    return toRuntimeTaskSnapshotInput(this.coordinator.createTask(input));
  }

  updateTask(taskId: TaskId, input: { readonly title?: string; readonly directive?: string }): RuntimeTaskSnapshotInput {
    try {
      return toRuntimeTaskSnapshotInput(this.coordinator.updateTask(taskId, input));
    } catch (error) {
      throw apiError(error);
    }
  }

  async deleteTask(taskId: TaskId): Promise<{ readonly taskId: string; readonly deleted: true }> {
    // Resolve the durable plan link before the delete removes the task record.
    const snapshot = await this.executionPlanSnapshotForTask(taskId);
    let deleted: { readonly taskId: string; readonly deleted: true };
    try {
      deleted = { taskId: this.coordinator.deleteTask(taskId).taskId.value, deleted: true };
    } catch (error) {
      throw apiError(error);
    }
    if (snapshot !== undefined) await this.cancelOrphanedExecutionPlan(taskId, snapshot);
    return deleted;
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
        if (action === 'delete') await this.deleteTask(taskId);
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

  /** The Runtime-owned active-turn id for a task, once the turn is opened. */
  activeTurnId(taskId: TaskId): string | undefined {
    return this.coordinator.activeTurnId(taskId);
  }

  /**
   * Read-only capture of the Runtime-owned active turn from durable facts. It
   * never dispatches a child or replays a side effect.
   */
  activeTurnCapture(
    taskId: TaskId,
    pauseId: string,
  ): import('../../../contracts/src/index.js').ActiveTurnCaptureBody | undefined {
    return this.coordinator.activeTurnCapture(taskId, pauseId);
  }

  prepareRecoveryCapture(taskId: TaskId, boundaryId: string, childRuntimeId?: string): Promise<import('../../../contracts/src/index.js').PreparedRecoveryCapture> {
    return this.coordinator.prepareRecoveryCapture(taskId, boundaryId, childRuntimeId);
  }

  private withRequirementAdmission(task: RuntimeTaskSnapshot): RuntimeTaskSnapshotInput {
    const admission = this.requirementAdmissions.get(task.taskId.value);
    if (!admission) return toRuntimeTaskSnapshotInput(task);
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
      ...toRuntimeTaskSnapshotInput(task),
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
      tasks: this.taskListSnapshots(),
    });
  }

  private taskListSnapshots(): readonly RuntimeTaskSnapshotInput[] {
    return [
      ...this.queuedTaskSnapshots(),
      ...this.coordinator.taskSnapshots().map((task) => this.withRequirementAdmission(task)),
    ];
  }

  /**
   * Public task-list read composition. The synchronous `listTasks` stays free of
   * Journal I/O for internal callers (for example admission counts); the HTTP
   * read boundary composes the exact committed Task identity per row here. A row
   * without a committed identity omits `identitySource`. A failed identity read
   * keeps its typed error instead of degrading into an omitted (matching) row.
   */
  async listTasksWithIdentitySource(): Promise<RuntimeTaskListProjection> {
    const snapshots = this.taskListSnapshots();
    const taskIdentity = this.options.taskIdentity;
    if (taskIdentity === undefined || snapshots.length === 0) {
      return projectRuntimeTaskList({ mode: this.mode, tasks: snapshots });
    }
    const enriched = await Promise.all(snapshots.map(async (snapshot): Promise<RuntimeTaskSnapshotInput> => {
      const identity = await taskIdentity.read({ organId: this.options.organId, taskId: snapshot.taskId });
      return identity === undefined
        ? snapshot
        : {
          ...snapshot,
          identitySource: identity.source,
          ...(identity.taskFlow === undefined ? {} : { taskFlow: identity.taskFlow }),
        };
    }));
    return projectRuntimeTaskList({ mode: this.mode, tasks: enriched });
  }

  dashboard(): RuntimeDashboardProjection {
    const tasks = this.coordinator.taskSnapshots().map(toRuntimeTaskSnapshotInput);
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

  taskDashboard(taskId: TaskId, authoritativePublication?: PublicOutputPublicationProjection): RuntimeTaskDashboardView {
    try {
      const task = this.coordinatorOrQueuedTaskSnapshot(taskId);
      return runtimeTaskDashboard(task, this.mode, runtimeLivenessInput(task, this.now().toISOString()), authoritativePublication);
    } catch (error) {
      throw apiError(error);
    }
  }

  /**
   * The task dashboard plus the persisted plan this task belongs to, when it has
   * one. The plan is a durable read, so the HTTP read model is composed here and
   * the synchronous `taskDashboard` stays free of journal I/O for the internal
   * callers that only need task state.
   */
  async taskDashboardWithPlan(taskId: TaskId, agentSelection?: DecodedTaskAgentActivitySelectionQuery): Promise<RuntimeTaskDashboardView> {
    const dashboard = this.taskDashboard(taskId);
    const plan = await this.executionPlanForTask(taskId);
    const publicOutput = await this.authoritativePublicOutputForTask(taskId);
    // Re-run the same pure dashboard projection with the authoritative
    // publication so the output/narrative are computed from committed records.
    const withPublication = publicOutput === undefined ? dashboard : this.taskDashboard(taskId, publicOutput);
    return {
      ...withPublication,
      ...(plan === undefined ? {} : { plan }),
      taskPlanHistory: await this.boundTaskPlanHistory(taskId),
      agentActivity: await this.taskAgentActivityFor(this.boundProjectSource(), this.mode, taskId, agentSelection),
    };
  }

  private async taskAgentActivityFor(
    source: ConfiguredProjectReadSource | undefined,
    mode: RuntimeMode,
    taskId: TaskId,
    selection?: DecodedTaskAgentActivitySelectionQuery,
  ): ReturnType<typeof readTaskAgentActivity> {
    if (selection !== undefined && !selection.ok) return { ok: false, failure: selection.failure };
    if (source === undefined) return { ok: false, failure: {
      code: 'agent-activity.scope-unavailable', ownerId: 'humanagent.app.ui-runtime.agent-activity',
      message: 'the serve-bound project has no configured runtime paths',
      nextAction: 'bind the canonical project runtime paths',
    } };
    const filePath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, mode));
    const controlJournal = new JsonlOrganJournal(filePath);
    const bound = this.isBoundScope(source.projectKey, mode);
    const live: AssembleTaskAgentActivityRemainingSourcesOptions['live'] = bound ? {
      snapshot: this.coordinatorOrQueuedTaskSnapshot(taskId),
      inspectPool: () => this.coordinator.inspectTaskRuntimePool(taskId),
      currentLocations: this.coordinator.readTaskCurrentActivityLocations(taskId),
    } : undefined;
    return readTaskAgentActivity({
      taskId, query: selection?.ok ? selection.value : { taskId },
      taskJournal: readUiRuntimeTaskJournal(source.checkpointsRoot, mode), controlJournal,
      i2Journal: bound && this.options.i2History !== undefined
        ? this.options.i2History.journal : createJsonlI2JournalPort({ filePath, journal: controlJournal }),
      ...(live === undefined ? {} : { live }),
    });
  }

  /**
   * Reasoning plan history for the serve-bound project/mode. The bound
   * Dashboard GET carries no project/mode query, so the source is the
   * Config-derived bound source rather than a request value.
   */
  private async boundTaskPlanHistory(
    taskId: TaskId,
  ): Promise<RuntimeReadResult<RuntimeTaskPlanHistoryProjection>> {
    const source = this.boundProjectSource();
    if (source === undefined) {
      return { ok: false, failure: taskPlanHistoryReadFailure(taskId, 'the serve-bound project has no configured runtime paths') };
    }
    return this.taskPlanHistoryFor(source, this.mode, taskId);
  }

  /**
   * Reasoning plan history and the exact Runtime-accepted current selection for
   * one declared task scope.
   *
   * The Organ authority is the committed typed Task identity in that
   * source/mode's one canonical control Journal. It is never borrowed from this
   * instance's Organ, a workspace name, or another project's Journal. When that
   * authority is absent or conflicting the read returns a typed failure; it
   * never degrades to the latest publication, the scheduling plan, or an empty
   * history. `current` comes from the committed Runtime current-state, so a
   * task that accepted v2 reports v2 even after v3 is published.
   */
  private async taskPlanHistoryFor(
    source: ConfiguredProjectReadSource,
    mode: RuntimeMode,
    taskId: TaskId,
  ): Promise<RuntimeReadResult<RuntimeTaskPlanHistoryProjection>> {
    const scope = { kind: 'task' as const, projectKey: source.projectKey, mode, taskId };
    const journal = new JsonlOrganJournal(
      uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, mode)),
    );
    let taskScope: TaskIdentityScope;
    try {
      const identities = await new JsonlTaskIdentityJournal(journal).replay();
      const matches = identities.filter((identity) => identity.scope.taskId.value === taskId.value);
      const organIds = new Set(matches.map((identity) => identity.scope.organId.value));
      if (matches.length === 0 || organIds.size !== 1) {
        return {
          ok: false,
          failure: taskIdentityAuthorityFailure(taskId, source.projectKey, mode, organIds.size > 1),
        };
      }
      taskScope = matches[0]!.scope;
    } catch (error) {
      return {
        ok: false,
        failure: taskPlanHistoryReadFailure(
          taskId,
          `committed Task identity read failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      };
    }
    const plans = new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(journal));
    let current: TaskPlanHistoryCurrentRead;
    try {
      const accepted = await createJsonlRuntimeTaskCurrentStateJournal({ journal }).read(taskScope);
      current = accepted.state === 'unknown'
        ? { state: 'unknown', reason: accepted.reason }
        : accepted.value.currentPlan === undefined
          ? {
            state: 'unknown',
            reason: 'the committed Runtime current-state has no accepted TaskPlan selection',
          }
          : { state: 'known', value: accepted.value.currentPlan };
    } catch (error) {
      return {
        ok: false,
        failure: taskPlanHistoryReadFailure(
          taskId,
          `committed Runtime current-state read failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      };
    }
    return createTaskPlanHistoryReader(plans).read({ scope, taskScope, current });
  }

  /**
   * Reads the committed public publication for a task's current operation from
   * the authoritative task/cycle Organ Journal. The synchronous `taskDashboard`
   * stays free of journal I/O for internal callers, so the async HTTP read model
   * composes the durable read here. A read failure degrades to `unknown` with an
   * empty commit list rather than hiding a published result.
   */
  private async authoritativePublicOutputForTask(taskId: TaskId): Promise<PublicOutputPublicationProjection | undefined> {
    const task = this.coordinatorOrQueuedTaskSnapshot(taskId);
    const binding = publicOutputBindingFor(task, this.options.organId);
    if (binding === undefined || binding.scope.cycleId === undefined) return undefined;
    try {
      const publication = await this.options.checkpointStoreFor(task.taskId, binding.scope.cycleId).readPublicOutputs(binding);
      return toPublicOutputProjection(publication);
    } catch {
      return { state: 'unknown', commits: [] };
    }
  }

  /**
   * The persisted plan a task belongs to, as a read-only display projection.
   * Absent when the task has no persisted plan.
   */
  async executionPlanForTask(taskId: TaskId): Promise<RuntimeTaskPlanProjection | undefined> {
    const snapshot = await this.executionPlanSnapshotForTask(taskId);
    return snapshot === undefined ? undefined : projectExecutionPlan(snapshot);
  }

  /**
   * The single production caller of the persisted plan control edge.
   *
   * The caller names the plan and the intent; `expectedPolicyRevision` is read
   * from the authoritative snapshot here and is never declared by the caller, and
   * the port re-checks it inside its own transaction. `expectedScheduleRevision`
   * is deliberately NOT sent: it is optional for these actions, and the schedule
   * revision moves on every applied control, so sending the freshly read value
   * would make an honest retry of the same request look like a `conflict`
   * instead of the durable `duplicate` the port already knows how to report. The
   * state guards inside the transaction (`invalid-state`) still decide whether the
   * transition is legal.
   */
  async controlExecutionPlan(
    subscriptionId: string,
    input: {
      readonly action: 'pause' | 'resume' | 'cancel-future';
      readonly idempotencyKey: string;
      readonly requestedAt: string;
    },
  ): Promise<SubscriptionControlReceipt> {
    const port = this.subscriptionControl;
    if (!port) {
      throw new UiRuntimeApiError(
        'execution-plan.control-unavailable',
        RUNTIME_OWNER,
        'execution plan control is not wired to the UI runtime',
        'start the UI runtime with the durable subscription control port',
        503,
      );
    }
    const snapshot = await this.subscriptionSnapshot(port, subscriptionId);
    if (snapshot === undefined) {
      throw new UiRuntimeApiError(
        'execution-plan.not-found',
        RUNTIME_OWNER,
        `no persisted execution plan: ${subscriptionId}`,
        'read the persisted execution plans before controlling one',
        404,
      );
    }
    try {
      return await port.control({
        subscriptionId,
        action: input.action,
        expectedPolicyRevision: snapshot.policy.policyRevision,
        idempotencyKey: input.idempotencyKey,
        requestedAt: input.requestedAt,
      });
    } catch (error) {
      if (error instanceof ContractError) {
        throw new UiRuntimeApiError(
          'execution-plan.invalid-request',
          RUNTIME_OWNER,
          error.message,
          'send a supported action, a non-empty idempotencyKey and a canonical requestedAt instant',
          400,
        );
      }
      throw apiError(error);
    }
  }

  /**
   * Resolve the persisted plan a task belongs to from durable links only. Two
   * links exist and no third registry is added:
   *   - a scheduled occurrence task is bound by the `OccurrenceClaimRecord.taskId`
   *     the scheduler claimed it with;
   *   - a confirmed requirement's own task is bound by the dispatch ledger entry,
   *     whose requirement id names the plan.
   */
  private async executionPlanSnapshotForTask(taskId: TaskId): Promise<SubscriptionSnapshot | undefined> {
    const port = this.subscriptionControl;
    if (!port) return undefined;
    for (const entry of this.dispatchLedger.values()) {
      if (entry.taskId.value !== taskId.value) continue;
      const envelope = this.requirementInbox.find(entry.draftId);
      if (!envelope) continue;
      const snapshot = await this.subscriptionSnapshot(port, subscriptionIdForRequirement(envelope.requirementId));
      if (snapshot !== undefined) return snapshot;
    }
    for (const snapshot of await port.list()) {
      if (snapshot.claims.some((claim) => claim.taskId.value === taskId.value)) return snapshot;
    }
    return undefined;
  }

  /**
   * A deleted task must not leave a plan behind that keeps dispatching. The
   * mechanism is the plan's own control edge (`cancel-future`), not a second
   * lifecycle: a plan that is not `active` or `suspended` cannot dispatch, since
   * `assertOccurrenceClaimable` requires `active`, so those states are left as
   * they are and their durable cause is not overwritten.
   *
   * The task is deleted first, so a rejected delete (`task.busy`,
   * `task.not.found`) never destroys a schedule. The two journals have no shared
   * transaction, so a control failure after a successful delete is reported
   * explicitly instead of being swallowed.
   */
  private async cancelOrphanedExecutionPlan(taskId: TaskId, snapshot: SubscriptionSnapshot): Promise<void> {
    const port = this.subscriptionControl;
    if (!port) return;
    if (snapshot.subscription.state !== 'active' && snapshot.subscription.state !== 'suspended') return;
    const idempotencyKey = `plan-orphan-cancel:${taskId.value}`;
    try {
      await port.control({
        subscriptionId: snapshot.subscription.subscriptionId,
        action: 'cancel-future',
        expectedPolicyRevision: snapshot.policy.policyRevision,
        idempotencyKey,
        requestedAt: this.now().toISOString(),
      });
    } catch (error) {
      throw new UiRuntimeApiError(
        'execution-plan.orphan-cancel-failed',
        RUNTIME_OWNER,
        `task ${taskId.value} was deleted but its execution plan ${snapshot.subscription.subscriptionId} is still live: ${error instanceof Error ? error.message : String(error)}`,
        `cancel the orphaned plan through POST /api/plans/${encodeURIComponent(snapshot.subscription.subscriptionId)}/control`,
        409,
        undefined,
        error,
      );
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
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
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

  /**
   * The public trace of one task. It projects the runtime's own events, so every
   * entry carries the turn identity and occurrence time the provider binding
   * reported; a task with no provider event yet returns an empty real page
   * instead of a synthesized trace.
   */
  history(taskId: TaskId, query: InteractionHistoryQuery): InteractionHistoryResult {
    try {
      const task = this.coordinatorOrQueuedTaskSnapshot(taskId);
      return projectRuntimeTaskHistory(task, query);
    } catch (error) {
      if (error instanceof ContractError) {
        throw new UiRuntimeApiError(
          'history.query.invalid',
          APP_OWNER,
          error.message,
          'send a valid history query',
          400,
        );
      }
      throw apiError(error);
    }
  }

  // ---- Public scoped history reads (I4/I5) ----------------------------------

  private async resolveProjectCatalog(): Promise<ConfiguredProjectCatalog> {
    const resolver = this.readResources?.projectCatalog ?? this.options.projectCatalog;
    if (resolver === undefined) {
      throw new UiRuntimeApiError(
        'read.catalog-unavailable',
        APP_OWNER,
        'the UI runtime was started without a configured project catalog',
        'start the runtime through the serve entry that resolves configuration',
        503,
      );
    }
    return resolver();
  }

  private async findProjectSource(projectKey: string): Promise<ConfiguredProjectReadSource | undefined> {
    const catalog = await this.resolveProjectCatalog();
    const declared = catalog.projects.find((project) => project.projectKey === projectKey);
    if (declared !== undefined) return declared;
    const bound = this.boundProjectSource();
    return bound?.projectKey === projectKey ? bound : undefined;
  }

  /**
   * Canonical source for the serve-bound project, derived from Config-owned
   * RuntimePaths. It keeps the bound project readable even if the manifest
   * catalog fails; it never scans a workspace for persistent state.
   */
  private boundProjectSource(): ConfiguredProjectReadSource | undefined {
    const paths = this.readResources?.runtimePaths ?? this.options.runtimePaths;
    if (paths === undefined || this.options.projectKey === undefined || paths.projectKey !== this.options.projectKey) return undefined;
    return {
      projectKey: paths.projectKey,
      workspaceCwd: paths.workspaceCwd,
      projectRoot: paths.projectRoot,
      checkpointsRoot: paths.checkpointsRoot,
    };
  }

  private isBoundScope(projectKey: string, mode: RuntimeMode): boolean {
    return this.options.projectKey === projectKey && this.mode === mode;
  }

  /**
   * The committed Task identities for one declared project/mode scope, read from
   * that scope's own canonical control Journal. A row in this scope never
   * borrows another instance's Organ: the replay is resolved from the same
   * `checkpointsRoot`/mode as the row. A missing identity leaves the row
   * unbound (absence, not a claim); a corrupt/unreadable identity Journal is
   * surfaced as a typed failure so it never degrades into a default binding.
   */
  private async scopeCommittedIdentities(
    source: ConfiguredProjectReadSource,
    mode: RuntimeMode,
  ): Promise<{ readonly byTaskId: ReadonlyMap<string, TaskIdentityRecord>; readonly failure?: RuntimeReadFailure }> {
    try {
      const journal = new JsonlOrganJournal(
        uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, mode)),
      );
      const identities = await new JsonlTaskIdentityJournal(journal).replay();
      return { byTaskId: new Map(identities.map((identity) => [identity.scope.taskId.value, identity])) };
    } catch (error) {
      return {
        byTaskId: new Map(),
        failure: {
          code: 'read.identity-failed',
          ownerId: TASK_PLAN_HISTORY_OWNER,
          message: `committed Task identity read failed for ${source.projectKey}/${mode}: ${error instanceof Error ? error.message : String(error)}`,
          nextAction: 'restore the canonical task control Journal read for this scope',
        },
      };
    }
  }

  /** Row snapshot enriched with this scope's own committed identity and task-flow binding. */
  private snapshotWithScopeIdentity(
    snapshot: RuntimeTaskSnapshot,
    identity: TaskIdentityRecord | undefined,
  ): RuntimeTaskSnapshotInput {
    return {
      ...toRuntimeTaskSnapshotInput(snapshot),
      ...(identity === undefined
        ? {}
        : {
          identitySource: identity.source,
          ...(identity.taskFlow === undefined ? {} : { taskFlow: identity.taskFlow }),
        }),
    };
  }

  private async liveProjectRows(source: ConfiguredProjectReadSource, mode: RuntimeMode): Promise<{
    readonly rows: RuntimeProjectTaskReadRow[];
    readonly failure?: RuntimeReadFailure;
  }> {
    const { byTaskId, failure } = await this.scopeCommittedIdentities(source, mode);
    const rows = this.coordinator.taskSnapshots().map((snapshot) => ({
      scope: { kind: 'task' as const, projectKey: source.projectKey, mode, taskId: snapshot.taskId },
      task: taskRowOf(this.snapshotWithScopeIdentity(snapshot, byTaskId.get(snapshot.taskId.value)), mode),
      basis: 'live-runtime' as const,
    }));
    return failure === undefined ? { rows } : { rows, failure };
  }

  private async readDurableInventory(
    source: ConfiguredProjectReadSource,
    mode: RuntimeMode,
  ): Promise<{ entries: readonly DurableTaskInventoryEntry[]; failures: readonly RuntimeReadFailure[] }> {
    const read = readUiRuntimeTaskJournal(source.checkpointsRoot, mode);
    if (read.failure !== undefined) return { entries: [], failures: [read.failure] };
    const inventory = await projectDurableTaskInventory({
      records: read.records,
      checkpointFor: (taskId, cycleId) => new FileCheckpointStore(
        uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, mode)),
      ),
      currentStateFor: () => createJsonlRuntimeTaskCurrentStateJournal({
        journal: new JsonlOrganJournal(uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, mode))),
      }),
    });
    return { entries: inventory.entries, failures: inventory.failures };
  }

  private async projectReadRows(
    source: ConfiguredProjectReadSource,
  ): Promise<{ rows: RuntimeProjectTaskReadRow[]; failures: RuntimeReadFailure[] }> {
    const rows: RuntimeProjectTaskReadRow[] = [];
    const failures: RuntimeReadFailure[] = [];
    for (const mode of READABLE_RUNTIME_MODES) {
      if (this.isBoundScope(source.projectKey, mode)) {
        const live = await this.liveProjectRows(source, mode);
        rows.push(...live.rows);
        if (live.failure !== undefined) failures.push(live.failure);
        continue;
      }
      const inventory = await this.readDurableInventory(source, mode);
      for (const failure of inventory.failures) failures.push(failure);
      const { byTaskId, failure: identityFailure } = await this.scopeCommittedIdentities(source, mode);
      if (identityFailure !== undefined) failures.push(identityFailure);
      for (const entry of inventory.entries) {
        rows.push({
          scope: { kind: 'task', projectKey: source.projectKey, mode, taskId: entry.snapshot.taskId },
          task: taskRowOf(
            this.snapshotWithScopeIdentity(entry.snapshot, byTaskId.get(entry.snapshot.taskId.value)),
            mode,
          ),
          basis: 'durable-history',
        });
      }
    }
    return { rows, failures };
  }

  private projectProjection(
    source: ConfiguredProjectReadSource,
    rows: readonly RuntimeProjectTaskReadRow[],
    failures: readonly RuntimeReadFailure[],
  ): RuntimeProjectReadProjection {
    return {
      surface: 'runtime-project',
      scope: { kind: 'project', projectKey: source.projectKey },
      label: basename(source.workspaceCwd),
      observedAt: this.now().toISOString(),
      tasks: rows,
      taskCount: rows.length,
      complete: failures.length === 0,
      failures,
    };
  }

  /** Public project read: one declared project's saved task inventory across modes. */
  async projectRead(projectKey: string): Promise<RuntimeReadResult<RuntimeProjectReadProjection>> {
    const source = await this.findProjectSource(projectKey);
    if (source === undefined) return { ok: false, failure: unknownProjectFailure(projectKey) };
    const { rows, failures } = await this.projectReadRows(source);
    return { ok: true, value: this.projectProjection(source, rows, failures) };
  }

  /**
   * Public system read: every configured project in the current control root.
   * `taskCount` is the sum of the returned project rows, never the current
   * instance `listTasks()` total, so a bound project cannot masquerade as the
   * whole installation.
   */
  async systemRead(): Promise<RuntimeSystemReadProjection> {
    const catalog = await this.resolveProjectCatalog();
    const failures: RuntimeReadFailure[] = catalog.failures.map((failure) => ({
      code: failure.code,
      ownerId: failure.ownerId,
      message: failure.message,
      nextAction: failure.nextAction,
    }));
    const projects: RuntimeProjectReadProjection[] = [];
    const sources = [...catalog.projects];
    const bound = this.boundProjectSource();
    if (bound !== undefined && !sources.some((source) => source.projectKey === bound.projectKey)) sources.push(bound);
    for (const source of sources) {
      const { rows, failures: projectFailures } = await this.projectReadRows(source);
      projects.push(this.projectProjection(source, rows, projectFailures));
      failures.push(...projectFailures);
    }
    return {
      surface: 'runtime-system',
      scope: { kind: 'system' },
      observedAt: this.now().toISOString(),
      runtime: this.status(),
      coverage: 'configured-projects-in-current-control-root',
      projects,
      taskCount: projects.reduce((total, project) => total + project.taskCount, 0),
      complete: failures.length === 0,
      failures,
    };
  }

  /**
   * Scoped task dashboard. The serve-bound project/mode uses the live runtime
   * facts; any other scope reads only durable history, so a persisted running
   * event is never reported as the current live execution.
   */
  async scopedTaskDashboard(
    taskId: TaskId,
    projectKey: string,
    mode: 'fake' | 'rcc',
    agentSelection?: DecodedTaskAgentActivitySelectionQuery,
  ): Promise<RuntimeReadResult<RuntimeTaskDashboardView>> {
    if (this.isBoundScope(projectKey, mode)) {
      try {
        return { ok: true, value: await this.taskDashboardWithPlan(taskId, agentSelection) };
      } catch (error) {
        return { ok: false, failure: readFailureFromError(error) };
      }
    }
    const source = await this.findProjectSource(projectKey);
    if (source === undefined) return { ok: false, failure: unknownProjectFailure(projectKey) };
    const inventory = await this.readDurableInventory(source, mode);
    const entry = inventory.entries.find((candidate) => candidate.snapshot.taskId.value === taskId.value);
    if (entry === undefined) {
      if (inventory.failures.length > 0) return { ok: false, failure: inventory.failures[0]! };
      return { ok: false, failure: unknownTaskFailure(taskId, projectKey, mode) };
    }
    return {
      ok: true,
      value: {
        ...runtimeTaskDashboard(entry.snapshot, mode),
        taskPlanHistory: await this.taskPlanHistoryFor(source, mode, taskId),
        agentActivity: await this.taskAgentActivityFor(source, mode, taskId, agentSelection),
      },
    };
  }

  private async rawRecordsForTask(
    source: ConfiguredProjectReadSource,
    mode: RuntimeMode,
    taskId: TaskId,
    records: readonly UiRuntimeJournalRecord[],
  ): Promise<RuntimeRawRecordProjection[]> {
    const taskRecords = records
      .map((record, ordinal) => ({ record, ordinal }))
      .filter(({ record }) => journalRecordTaskId(record) === taskId.value);
    const raw: RuntimeRawRecordProjection[] = [];
    const checkpointCommittedAt = new Map<string, string>();
    let taskUpdatedAt: string | undefined;
    for (const { record } of taskRecords) {
      if (record.kind === 'task.created') taskUpdatedAt = record.createdAt;
      else if (record.kind === 'task.updated') taskUpdatedAt = record.updatedAt;
      else if (record.kind === 'operation.event') {
        taskUpdatedAt = record.event.occurredAt;
        if (record.event.kind === 'checkpoint.committed') checkpointCommittedAt.set(record.operationId.value, record.event.occurredAt);
      }
    }
    for (const { record, ordinal } of taskRecords) {
      const built = rawBuildForJournalRecord(record);
      if (built === undefined) continue;
      raw.push({
        ref: {
          projectKey: source.projectKey,
          mode,
          taskId,
          source: 'task-journal',
          ordinal,
          ...(built.operationId === undefined ? {} : { operationId: built.operationId }),
          ...(built.executionEpoch === undefined ? {} : { executionEpoch: built.executionEpoch }),
        },
        occurredAt: built.occurredAt,
        body: built.body,
        evidenceRefs: built.evidenceRefs,
      });
    }
    // The request's canonical control Journal is replayed once. It carries
    // every task's checkpoints, public output, grants and identity records, so
    // ordinals are taken from that replay before filtering and only checkpoint
    // records whose real scope matches this task/operation/epoch are projected.
    const controlJournal = await new JsonlOrganJournal(
      uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, mode)),
    ).replay();
    const taskOperations = new Map<string, { readonly scope: ScopeRef; readonly executionEpoch: number }>();
    for (const { record } of taskRecords) {
      if (record.kind !== 'operation.started') continue;
      taskOperations.set(record.operationId.value, { scope: record.scope, executionEpoch: record.executionEpoch });
    }
    controlJournal.forEach((checkpointRecord, ordinal) => {
      if (checkpointRecord.kind !== 'checkpoint' || checkpointRecord.checkpoint === undefined) return;
      const checkpoint = checkpointRecord.checkpoint;
      if (checkpoint.scope.taskId === undefined || checkpoint.scope.taskId.value !== taskId.value) return;
      const operation = taskOperations.get(checkpoint.scope.operationId?.value ?? '');
      if (operation === undefined) return;
      if (checkpoint.scope.cycleId?.value !== operation.scope.cycleId?.value) return;
      if (checkpoint.executionEpoch !== operation.executionEpoch) return;
      const operationId = operation.scope.operationId?.value ?? '';
      const occurredAt = checkpointCommittedAt.get(operationId) ?? taskUpdatedAt;
      if (occurredAt === undefined) return;
      raw.push({
        ref: {
          projectKey: source.projectKey,
          mode,
          taskId,
          source: 'checkpoint-journal',
          ordinal,
          operationId,
          executionEpoch: checkpoint.executionEpoch,
          checkpointId: checkpoint.id.value,
        },
        occurredAt,
        body: {
          kind: 'checkpoint',
          checkpointId: checkpoint.id.value,
          seq: checkpoint.seq,
          outcome: checkpoint.outcome,
          summary: checkpoint.summary,
          evidenceRefs: checkpoint.evidenceRefs,
        },
        evidenceRefs: checkpoint.evidenceRefs,
      });
    });
    return raw;
  }

  private actionRecordsForTask(
    snapshot: RuntimeTaskSnapshot,
    projectKey: string,
    mode: RuntimeMode,
    taskId: TaskId,
    records: readonly UiRuntimeJournalRecord[],
  ): RuntimeTaskRecordsProjection['actions'] {
    const refByEvent = new Map<string, RuntimeStoredRecordRef>();
    records.forEach((record, ordinal) => {
      if (record.kind !== 'operation.event') return;
      refByEvent.set(`${record.operationId.value}:${record.event.seq}`, {
        projectKey,
        mode,
        taskId,
        source: 'task-journal',
        ordinal,
        operationId: record.operationId.value,
        executionEpoch: record.event.executionEpoch,
      });
    });
    const history = projectRuntimeTaskHistory(snapshot, { limit: Math.min(Math.max(snapshot.events.length, 1), 500) });
    if (!history.ok) return [];
    const actions: RuntimeTaskRecordsProjection['actions'][number][] = [];
    for (const entry of history.page.items) {
      const rawRef = refByEvent.get(`${entry.operationId.value}:${entry.seq}`);
      if (rawRef === undefined) continue;
      actions.push({ entry, rawRef });
    }
    return actions;
  }

  /**
   * Public scoped records read. `raw` returns the durable record bodies in
   * replay order with a stable per-source ordinal; `actions` returns the typed
   * interaction trace with the same `rawRef` origin. The cursor binds the exact
   * project/mode/task/view scope and the last returned record, so filtering
   * never renumbers the prefix and a foreign cursor is rejected.
   */
  async taskRecords(taskId: TaskId, input: {
    readonly projectKey: string;
    readonly mode: RuntimeMode;
    readonly view: 'actions' | 'raw';
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<RuntimeReadResult<RuntimeTaskRecordsProjection>> {
    const source = await this.findProjectSource(input.projectKey);
    if (source === undefined) return { ok: false, failure: unknownProjectFailure(input.projectKey) };
    if (input.view !== 'actions' && input.view !== 'raw') {
      return {
        ok: false,
        failure: {
          code: 'records.view.invalid',
          ownerId: APP_OWNER,
          message: `records view must be actions or raw: ${String(input.view)}`,
          nextAction: 'request view=actions or view=raw',
        },
      };
    }
    let cursor: RecordsCursor | undefined;
    if (input.cursor !== undefined) {
      cursor = decodeRecordsCursor(input.cursor);
      if (cursor === undefined) {
        return {
          ok: false,
          failure: {
            code: 'records.cursor-invalid',
            ownerId: APP_OWNER,
            message: 'records cursor is not a decoded stored-record ref',
            nextAction: 'request the first records page without a cursor',
          },
        };
      }
      if (cursor.view !== input.view) {
        return {
          ok: false,
          failure: {
            code: 'records.cursor-scope-mismatch',
            ownerId: APP_OWNER,
            message: `records cursor belongs to the ${cursor.view} view`,
            nextAction: 'use a cursor returned for the same view',
          },
        };
      }
      const ref = cursor.ref;
      if (ref.projectKey !== input.projectKey || ref.mode !== input.mode || ref.taskId.scope !== 'task' || ref.taskId.value !== taskId.value) {
        return {
          ok: false,
          failure: {
            code: 'records.cursor-scope-mismatch',
            ownerId: APP_OWNER,
            message: 'records cursor belongs to a different project/mode/task scope',
            nextAction: 'use a cursor returned for the same task scope',
          },
        };
      }
    }
    const read = readUiRuntimeTaskJournal(source.checkpointsRoot, input.mode);
    if (read.failure !== undefined) return { ok: false, failure: read.failure };
    const scope = { kind: 'task' as const, projectKey: input.projectKey, mode: input.mode, taskId };
    if (input.view === 'raw') {
      const raw = await this.rawRecordsForTask(source, input.mode, taskId, read.records);
      if (raw.length === 0) return { ok: false, failure: unknownTaskFailure(taskId, input.projectKey, input.mode) };
      const page = paginateRecords(raw.map((record) => ({ ref: record.ref, record })), cursor, input.limit, 'raw');
      if (page.failure !== undefined) return { ok: false, failure: page.failure };
      return {
        ok: true,
        value: {
          surface: 'runtime-task-records',
          scope,
          observedAt: this.now().toISOString(),
          actions: [],
          raw: page.items.map((item) => item.record),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          hasMore: page.hasMore,
        },
      };
    }
    const inventory = await this.readDurableInventory(source, input.mode);
    const entry = inventory.entries.find((candidate) => candidate.snapshot.taskId.value === taskId.value);
    const actions = entry === undefined
      ? []
      : this.actionRecordsForTask(entry.snapshot, input.projectKey, input.mode, taskId, read.records);
    if (actions.length === 0 && entry === undefined && inventory.failures.length > 0) {
      return { ok: false, failure: inventory.failures[0]! };
    }
    const page = paginateRecords(actions.map((action) => ({ ref: action.rawRef, action })), cursor, input.limit, 'actions');
    if (page.failure !== undefined) return { ok: false, failure: page.failure };
    return {
      ok: true,
      value: {
        surface: 'runtime-task-records',
        scope,
        observedAt: this.now().toISOString(),
        actions: page.items.map((item) => item.action),
        raw: [],
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        hasMore: page.hasMore,
      },
    };
  }

  /**
   * Resolves one task's durable history scope: the declared project source, the
   * task's own cycle journals (from its real operation records) and the organ
   * identity recorded there. A task that never existed fails explicitly; a task
   * that exists but has no committed cycle is a legal empty history.
   */
  private async resolveTaskHistoryJournals(
    taskId: TaskId,
    projectKey: string,
    mode: RuntimeMode,
  ): Promise<({ ok: true } & ResolvedTaskHistoryJournals) | { ok: false; failure: RuntimeReadFailure }> {
    const source = await this.findProjectSource(projectKey);
    if (source === undefined) return { ok: false, failure: unknownProjectFailure(projectKey) };
    const read = readUiRuntimeTaskJournal(source.checkpointsRoot, mode);
    if (read.failure !== undefined) return { ok: false, failure: read.failure };
    const taskRecords = read.records.filter((record) => journalRecordTaskId(record) === taskId.value);
    const live = this.isBoundScope(projectKey, mode)
      && this.coordinator.taskSnapshots().some((snapshot) => snapshot.taskId.value === taskId.value);
    const exists = taskRecords.some((record) => record.kind === 'task.created') || live;
    if (!exists) return { ok: false, failure: unknownTaskFailure(taskId, projectKey, mode) };
    const cycles: { readonly cycleId: CycleId; readonly organId: OrganId }[] = [];
    for (const record of taskRecords) {
      if (record.kind !== 'operation.started' || record.cycleId === undefined) continue;
      if (cycles.some((entry) => entry.cycleId.value === record.cycleId!.value)) continue;
      cycles.push({ cycleId: record.cycleId, organId: record.scope.organId });
    }
    const files = cycles.map((entry) => uiRuntimeTaskCheckpointPath(source.checkpointsRoot, mode, taskId, entry.cycleId));
    if (this.isBoundScope(projectKey, mode) && this.options.executionJournalPath !== undefined) {
      files.push(this.options.executionJournalPath);
    }
    // The App-owned task identity, plan history, and cold record reads all use
    // this canonical control Journal. It stays last in the read order so its
    // committed head stays authoritative, while the native cycle files keep
    // their existing per-cycle history.
    files.push(uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, mode)));
    return { ok: true, source, organId: cycles[0]?.organId ?? this.options.organId, files };
  }

  /**
   * Public scoped context history read. It resolves the task's own cycle
   * journals from the durable UI runtime journal and reads each through the
   * same JSONL context-history port the producer commits to. `currentContextCommitRef`
   * is the actual typed context head; a `contextViewRef` selects an older view
   * without moving the head. A read never appends or advances control state.
   */
  async taskContextHistory(
    taskId: TaskId,
    input: TaskContextHistoryQuery,
  ): Promise<RuntimeReadResult<RuntimeContextHistoryProjection>> {
    const resolved = await this.resolveTaskHistoryJournals(taskId, input.projectKey, input.mode);
    if (!resolved.ok) return { ok: false, failure: resolved.failure };
    const fingerprint = historyFingerprint([
      'context-history',
      input.projectKey,
      input.mode,
      taskId.value,
      input.agentRuntimeId ?? '',
      input.contextViewRef ?? '',
    ]);
    let cursor: HistoryCursor | undefined;
    if (input.cursor !== undefined) {
      cursor = decodeHistoryCursor(input.cursor);
      if (cursor === undefined) return { ok: false, failure: historyCursorFailure('context-history', 'invalid') };
      if (cursor.fp !== fingerprint) return { ok: false, failure: historyCursorFailure('context-history', 'scope') };
    }
    try {
      const scope: ScopeRef = { organId: resolved.organId, taskId };
      const ordered: {
        readonly f: number;
        readonly i: number;
        readonly view: ContextView;
        readonly replacement: ContextReplacement | null;
      }[] = [];
      let head: JournalCommitRef | null = null;
      for (let f = 0; f < resolved.files.length; f += 1) {
        const port = createJsonlContextHistoryPort({ filePath: resolved.files[f]! });
        const result = await port.readContextHistory({
          scope,
          limit: HISTORY_ENUMERATION_LIMIT,
          ...(input.agentRuntimeId === undefined ? {} : { agentRuntimeId: input.agentRuntimeId }),
        });
        if (result.currentContextCommitRef) head = result.currentContextCommitRef;
        const replacementByView = new Map(
          result.replacements.map((replacement) => [replacement.toContextViewRef, replacement]),
        );
        result.views.forEach((view, i) => {
          ordered.push({ f, i, view, replacement: replacementByView.get(view.contextViewRef) ?? null });
        });
      }
      const selected = input.contextViewRef === undefined
        ? ordered
        : ordered.filter((entry) => entry.view.contextViewRef === input.contextViewRef);
      let start = 0;
      if (cursor !== undefined) {
        const index = selected.findIndex((entry) => entry.f === cursor!.f && entry.i === cursor!.i);
        if (index < 0) return { ok: false, failure: historyCursorFailure('context-history', 'not-found') };
        start = index + 1;
      }
      const page = selected.slice(start, start + input.limit);
      const hasMore = start + page.length < selected.length;
      const last = page.at(-1);
      const value = projectRuntimeContextHistory({
        mode: input.mode,
        taskId,
        ...(head ? { currentContextCommitRef: toRuntimeCommitRef(head) } : {}),
        views: page.map((entry) => ({
          contextViewRef: entry.view.contextViewRef,
          executionEpoch: entry.view.executionEpoch,
          contextDigest: entry.view.contextDigest,
          checkpointId: entry.view.checkpoint.checkpointId.value,
          activeRefs: [...entry.view.activeRefs],
          omittedRefs: [...entry.view.omittedRefs],
        })),
        replacements: page
          .filter((entry) => entry.replacement !== null)
          .map((entry) => toRuntimeReplacement(entry.replacement as ContextReplacement)),
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeHistoryCursor({ f: last.f, i: last.i, fp: fingerprint }) }
          : {}),
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, failure: readFailureFromError(error) };
    }
  }

  /** Resolve only the committed Task identity in this source's canonical control Journal. */
  private async canonicalTaskIdentityScope(
    journal: JsonlOrganJournal,
    taskId: TaskId,
    family: 'checkpoint-history' | 'i2-history' = 'checkpoint-history',
  ): Promise<RuntimeReadResult<TaskIdentityScope>> {
    try {
      const identities = (await new JsonlTaskIdentityJournal(journal).replay())
        .filter((identity) => identity.scope.taskId.value === taskId.value);
      if (identities.length === 0 || new Set(identities.map((identity) => identity.scope.organId.value)).size !== 1) {
        const targetLabel = family === 'i2-history' ? 'I2 history' : 'checkpoint history';
        return { ok: false, failure: {
          code: identities.length === 0 ? `${family}.scope-unavailable` : `${family}.scope-mismatch`,
          ownerId: APP_OWNER,
          message: `task ${taskId.value} has no unique committed Task identity in this canonical Journal`,
          nextAction: `restore the canonical Task identity before reading this task ${targetLabel}`,
        } };
      }
      return { ok: true, value: identities[0]!.scope };
    } catch (error) {
      return { ok: false, failure: readFailureFromError(error) };
    }
  }

  /**
   * Canonical readonly checkpoint composition. The canonical committed Journal
   * stays the only source of checkpoint identity and asset descriptors; the
   * reader never derives them from a UI request.
   */
  async taskCheckpointHistory(
    taskId: TaskId,
    input: TaskCheckpointHistoryQuery,
  ): Promise<RuntimeReadResult<RuntimeCheckpointReadProjection>> {
    const source = await this.findProjectSource(input.projectKey);
    if (source === undefined) return { ok: false, failure: unknownProjectFailure(input.projectKey) };
    const filePath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, input.mode));
    const journal = new JsonlOrganJournal(filePath);
    const identity = await this.canonicalTaskIdentityScope(journal, taskId);
    if (!identity.ok) return identity;
    try {
      return await checkpointHistoryReaderAssembly(this.options.runtimePaths, source, input.mode, journal).read({
        scope: { kind: 'task', projectKey: input.projectKey, mode: input.mode, taskId },
        taskScope: identity.value,
        list: { limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.directiveRevision === undefined ? {} : { directiveRevision: input.directiveRevision }),
          ...(input.executionEpoch === undefined ? {} : { executionEpoch: input.executionEpoch }),
          ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
          ...(input.occurrenceRef === undefined ? {} : { occurrenceRef: input.occurrenceRef }),
        },
        ...(input.viewed === undefined ? {} : { viewed: input.viewed }),
      });
    } catch (error) {
      return { ok: false, failure: readFailureFromError(error) };
    }
  }

  /**
   * Read the actual body of one committed checkpoint asset. The method reads the
   * canonical committed checkpoint first and only then reads the exact asset the
   * committed descriptor names, so no caller can select an arbitrary file.
   */
  async taskCheckpointAssetBody(
    taskId: TaskId,
    input: TaskCheckpointAssetBodyQuery,
  ): Promise<RuntimeReadResult<RuntimeCheckpointAssetBodyProjection>> {
    const source = await this.findProjectSource(input.projectKey);
    if (source === undefined) return { ok: false, failure: unknownProjectFailure(input.projectKey) };
    const filePath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, input.mode));
    const journal = new JsonlOrganJournal(filePath);
    const identity = await this.canonicalTaskIdentityScope(journal, taskId);
    if (!identity.ok) return identity;
    const artifactsRoot = join(source.projectRoot, 'artifacts', 'ui-provider-evidence');
    try {
      const history = await checkpointHistoryReaderAssembly(this.options.runtimePaths, source, input.mode, journal).read({
        scope: { kind: 'task', projectKey: input.projectKey, mode: input.mode, taskId },
        taskScope: identity.value,
        list: { limit: 1 },
        viewed: {
          checkpointId: input.viewed.checkpointId,
          commitRef: { ...input.viewed.commitRef },
        },
      });
      if (!history.ok) return history;
      const viewed = history.value.viewed;
      if (viewed === null) {
        return { ok: false, failure: {
          code: 'checkpoint-asset.viewed-unavailable',
          ownerId: CHECKPOINT_ASSET_OWNER,
          message: `checkpoint ${input.viewed.checkpointId.value} has no canonical committed detail in this task`,
          nextAction: 'supply the exact committed checkpoint receipt and restore the canonical checkpoint detail reader',
        } };
      }
      const scope: Extract<RuntimeReadScope, { readonly kind: 'task' }> = {
        kind: 'task', projectKey: input.projectKey, mode: input.mode, taskId,
      };
      const asset = checkpointAssetForSelector(viewed, input.selector, identity.value);
      if (!asset.ok) return asset;
      // Reject a descriptor whose own task scope is not the canonical identity of
      // this task. The scope kept on the descriptor is the authority for the read.
      const assetTaskScope = asset.value.ref.scope;
      if (!sameTypedId(assetTaskScope.organId, identity.value.organId)
        || !sameTypedId(assetTaskScope.taskId, identity.value.taskId)) {
        return { ok: false, failure: {
          code: 'checkpoint-asset.scope-mismatch',
          ownerId: CHECKPOINT_ASSET_OWNER,
          message: `checkpoint asset belongs to task ${assetTaskScope.taskId?.value ?? '(unscoped)'} in ${assetTaskScope.organId.value}, not to ${taskId.value} in ${identity.value.organId.value}`,
          nextAction: 'read the asset from the task scope that owns it',
        } };
      }
      const bytes = await providerRawContentReader(filesystemProviderEvidenceSink(new ImmutableAssetStore(artifactsRoot))).read({
        scope: assetTaskScope, content: asset.value,
      });
      return { ok: true, value: {
        surface: 'runtime-checkpoint-asset-body',
        scope,
        checkpoint: viewed.identity,
        selector: input.selector,
        asset: asset.value,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      } };
    } catch (error) {
      return { ok: false, failure: readFailureFromError(error) };
    }
  }

  /**
   * Read-only I2 history reads. Every method resolves the exact task scope and
   * reads the injected I2 authority; none of them commit, publish, retry, steer
   * or advance the current position. `current` comes only from the
   * owner-provided resolver, never from committed history or an event count.
   */
  async taskBusinessCycles(
    taskId: TaskId,
    input: I2HistoryViewedQuery,
  ): Promise<RuntimeReadResult<RuntimeBusinessCycleHistoryProjection>> {
    return this.readI2(taskId, input, (reader, taskScope, scope) => reader.listBusinessCycles({
      taskScope,
      ...(scope === undefined ? {} : { scope }),
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.viewed === undefined ? {} : { viewed: input.viewed }),
    }));
  }

  async taskBusinessCycle(
    taskId: TaskId,
    cycleId: string,
    scopeInput?: I2HistoryScopeInput,
  ): Promise<RuntimeReadResult<RuntimeBusinessCycleEntryProjection>> {
    return this.readI2(taskId, scopeInput, (reader, taskScope, scope) => reader.readBusinessCycle({
      taskScope,
      ...(scope === undefined ? {} : { scope }),
      cycleId,
    }));
  }

  async taskMilestoneReviews(
    taskId: TaskId,
    input: I2HistoryReviewQuery,
  ): Promise<RuntimeReadResult<RuntimeMilestoneReviewHistoryProjection>> {
    return this.readI2(taskId, input, (reader, taskScope, scope) => reader.listMilestoneReviews({
      taskScope,
      ...(scope === undefined ? {} : { scope }),
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
      ...(input.milestoneId === undefined ? {} : { milestoneId: input.milestoneId }),
    }));
  }

  async taskInspectionOccurrences(
    taskId: TaskId,
    input: I2HistoryViewedQuery,
  ): Promise<RuntimeReadResult<RuntimeInspectionOccurrenceHistoryProjection>> {
    return this.readI2(taskId, input, (reader, taskScope, scope) => reader.listInspectionOccurrences({
      taskScope,
      ...(scope === undefined ? {} : { scope }),
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.viewed === undefined ? {} : { viewed: input.viewed }),
    }));
  }

  async taskInspectionOccurrence(
    taskId: TaskId,
    occurrenceId: string,
    scopeInput?: I2HistoryScopeInput,
  ): Promise<RuntimeReadResult<RuntimeInspectionOccurrenceEntryProjection>> {
    return this.readI2(taskId, scopeInput, (reader, taskScope, scope) => reader.readInspectionOccurrence({
      taskScope,
      ...(scope === undefined ? {} : { scope }),
      occurrenceId,
    }));
  }

  async taskInspectionComparison(
    taskId: TaskId,
    left: string,
    right: string,
    scopeInput?: I2HistoryScopeInput,
  ): Promise<RuntimeReadResult<RuntimeInspectionComparisonProjection>> {
    return this.readI2(taskId, scopeInput, (reader, taskScope, scope) => reader.compareInspections({
      taskScope,
      ...(scope === undefined ? {} : { scope }),
      left,
      right,
    }));
  }

  private async readI2<T>(
    taskId: TaskId,
    scopeInput: I2HistoryScopeInput | undefined,
    run: (
      reader: I2HistoryReader,
      taskScope: ScopeRef,
      scope: Extract<RuntimeReadScope, { readonly kind: 'task' }> | undefined,
    ) => Promise<T>,
  ): Promise<RuntimeReadResult<T>> {
    const rawProjectKey = scopeInput?.projectKey;
    const rawMode = scopeInput?.mode;
    if (rawProjectKey === undefined && rawMode === undefined) {
      const reader = this.i2Reader;
      if (reader === undefined) return { ok: false, failure: i2UnavailableFailure() };
      const taskScope: ScopeRef = { organId: this.options.organId, taskId };
      try {
        return { ok: true, value: await run(reader, taskScope, undefined) };
      } catch (error) {
        return { ok: false, failure: readFailureFromError(error) };
      }
    }
    const projectKey = rawProjectKey?.trim();
    if (!projectKey || (rawMode !== 'fake' && rawMode !== 'rcc')) {
      return {
        ok: false,
        failure: {
          code: 'read.scope.invalid',
          ownerId: APP_OWNER,
          message: 'scoped I2 history requires both projectKey and mode=fake|rcc',
          nextAction: 'send projectKey=<declared projectKey>&mode=fake|rcc, or omit both for the legacy route',
        },
      };
    }
    try {
      const source = await this.findProjectSource(projectKey);
      if (source === undefined) return { ok: false, failure: unknownProjectFailure(projectKey) };
      const canonicalProjectKey = source.projectKey;
      const filePath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(source.checkpointsRoot, rawMode));
      const journal = new JsonlOrganJournal(filePath);
      const identity = await this.canonicalTaskIdentityScope(journal, taskId, 'i2-history');
      if (!identity.ok) return identity;
      const currentPosition = this.isBoundScope(canonicalProjectKey, rawMode)
        ? this.options.i2History?.currentPosition
        : undefined;
      const reader = createI2HistoryReader({
        journal: createJsonlI2JournalPort({ filePath, journal }),
        ...(currentPosition === undefined ? {} : { currentPosition }),
      });
      const scope: Extract<RuntimeReadScope, { readonly kind: 'task' }> = {
        kind: 'task',
        projectKey: canonicalProjectKey,
        mode: rawMode,
        taskId,
      };
      return { ok: true, value: await run(reader, identity.value, scope) };
    } catch (error) {
      return { ok: false, failure: readFailureFromError(error) };
    }
  }

  private canStartProviderExecution(status: RuntimeStatusProjection): boolean {
    if (!this.connected) return false;
    const readiness = this.options.providerReadiness;
    if (readiness !== undefined) {
      return canStartProviderRequest(this.options.providerSource ?? 'rcc', readiness);
    }
    return status.state === 'ready' || status.state === 'degraded';
  }

  async releaseExecution(taskId: TaskId, operationId: OperationId): ReturnType<RuntimeTaskCoordinator['releaseExecution']> {
    // Waiting for an independent grant must retain the prepared allocation.
    // The coordinator still performs the full TG1 admission on actual release.
    if (!await this.executionAutoStartAllowed(taskId)) {
      throw new UiRuntimeApiError('execution-composition.owner-source-missing', APP_OWNER,
        'verified TG1 owner is absent; no Provider factory can run',
        'grant this Task before releasing its prepared operation', 409);
    }
    const released = await this.coordinator.releaseExecution(taskId, operationId);
    this.watchExecutionForImplicitWakeup(operationId);
    return released;
  }

  async releaseGrantedTaskExecution(taskId: TaskId): Promise<UiRuntimeGrantExecutionReceipt> {
    const view = (snapshot: RuntimeTaskSnapshot): CurrentExecutionView => {
      const { taskId, operationId, executionEpoch, state, allowedActions, nextStep, error } = snapshot;
      return { taskId, operationId, executionEpoch, state, allowedActions, nextStep, error };
    };
    let before: RuntimeTaskSnapshot;
    try {
      before = this.coordinator.taskSnapshot(taskId);
    } catch (error) {
      return { state: 'blocked', apiError: apiError(error).toBody() };
    }
    if (before.operationId === undefined) return { state: 'not-applicable' };
    const selector = { taskId, operationId: before.operationId, executionEpoch: before.executionEpoch };
    if (before.error !== undefined || before.state === 'blocked' || before.state === 'failed') {
      return { state: 'blocked', selector, current: view(before) };
    }
    if (before.state !== 'waiting') return { state: 'current', selector, current: view(before) };
    // Snapshot selects the current allocation; only the coordinator can decide
    // whether it is prepared and releasable. Never prepare or retry here.
    let state: 'released' | 'blocked' = 'released';
    let failure: UiRuntimeApiErrorBody | undefined;
    try {
      await this.releaseExecution(taskId, id('operation', before.operationId));
    } catch (error) {
      state = 'blocked';
      failure = apiError(error).toBody();
    }
    let after: RuntimeTaskSnapshot;
    try {
      after = this.coordinator.taskSnapshot(taskId);
    } catch (error) {
      return { state: 'blocked', selector, apiError: failure ?? apiError(error).toBody() };
    }
    if (after.operationId !== selector.operationId || after.executionEpoch !== selector.executionEpoch) {
      return { state: 'blocked', selector, apiError: failure ?? new UiRuntimeApiError(
        'execution.operation.changed', APP_OWNER, 'current execution changed while releasing the selected allocation',
        'read the current Task before issuing another control request', 409,
      ).toBody() };
    }
    return { state, selector, current: view(after), ...(failure === undefined ? {} : { apiError: failure }) };
  }

  async startExecution(taskId: TaskId, input: { readonly prompt: string; readonly orchestrate?: boolean }): Promise<{ readonly operationId: OperationId; readonly executionEpoch: number }> {
    try {
      const status = this.status();
      if (!this.canStartProviderExecution(status)) {
        const providerError = this.options.providerError;
        throw new UiRuntimeApiError(
          providerError?.code ?? `provider.readiness.${status.providerState}`,
          providerError?.ownerId ?? 'humanagent.provider-adapter',
          providerError?.message ?? `provider readiness is ${status.providerState}`,
          providerError?.nextAction ?? 'inspect provider readiness',
          409,
        );
      }
      // Wait for the real admission/release edge before reporting the start, so
      // a denied start returns its typed error instead of a false 202. The
      // driver/Provider factory is created only after admission authorizes.
      const allocation = this.coordinator.prepareExecution(taskId, input);
      await this.coordinator.releaseExecution(taskId, allocation.operationId);
      this.watchExecutionForImplicitWakeup(allocation.operationId);
      return { operationId: allocation.operationId, executionEpoch: allocation.executionEpoch };
    } catch (error) {
      throw apiError(error);
    }
  }

  /**
   * Public confirmed-control facade for a Context correction. The bound App
   * assembly owns the journal path and principal; the caller supplies only the
   * confirmed business intent. After the real committed receipt is read back,
   * the Coordinator advances its live execution-epoch floor so the next fresh
   * allocation sits strictly above the committed transition.
   */
  async executeConfirmedTaskContextCorrection(
    request: ServiceContextCorrectionRequest,
  ): Promise<CommittedTaskContextCorrectionReceipt> {
    const callback = this.contextCorrectionPort;
    if (callback === undefined) {
      throw new RuntimeTaskControlError(
        'confirmed-control.context-correction-unbound',
        RUNTIME_OWNER,
        'the confirmed Context correction facade is not bound',
        'bind the launch execution composition before committing a confirmed correction',
      );
    }
    const receipt = await callback(request);
    this.synchronizeCommittedExecutionEpoch(request.taskScope.taskId, receipt.record.newExecutionEpoch);
    return receipt;
  }

  /**
   * Public confirmed-control facade for a checkpoint reentry (rewind or
   * forward). It mirrors the Context correction: the assembly owns the journal
   * path and principal, and the committed receipt advances the live epoch floor.
   */
  async executeConfirmedTaskCheckpointReentry(
    request: ServiceCheckpointReentryRequest,
  ): Promise<CommittedTaskCheckpointReentryReceipt> {
    const callback = this.checkpointReentryPort;
    if (callback === undefined) {
      throw new RuntimeTaskControlError(
        'confirmed-control.checkpoint-reentry-unbound',
        RUNTIME_OWNER,
        'the confirmed checkpoint reentry facade is not bound',
        'bind the launch execution composition before committing a confirmed reentry',
      );
    }
    const receipt = await callback(request);
    this.synchronizeCommittedExecutionEpoch(request.taskScope.taskId, receipt.record.newExecutionEpoch);
    return receipt;
  }

  private synchronizeCommittedExecutionEpoch(taskId: TaskId | undefined, committedExecutionEpoch: number): void {
    if (taskId === undefined) {
      throw new RuntimeTaskControlError(
        'confirmed-control.task-scope-missing',
        RUNTIME_OWNER,
        'the committed confirmed control carries no task scope',
        'supply the confirmed organ and task scope',
      );
    }
    this.coordinator.synchronizeCommittedExecutionEpoch(taskId, committedExecutionEpoch);
  }

  /**
   * Public cold-resume selector for one retained operation. The App adapter
   * checks Provider readiness and that the retained task exists, then delegates
   * business identity to the one canonical source selector. Runtime retains the
   * task-scoped admission/grant decision and the recovery responsibility on
   * every refusal: this method never mints a task, operation, effect or
   * fabricated capture, and reports success only after an actual release.
   */
  async resumeExecution(
    taskId: TaskId,
    input: { readonly operationId: OperationId },
  ): Promise<UiRuntimeExecutionResumeReceipt> {
    try {
      const status = this.status();
      if (!this.canStartProviderExecution(status)) {
        const providerError = this.options.providerError;
        throw new UiRuntimeApiError(
          providerError?.code ?? `provider.readiness.${status.providerState}`,
          providerError?.ownerId ?? 'humanagent.provider-adapter',
          providerError?.message ?? `provider readiness is ${status.providerState}`,
          providerError?.nextAction ?? 'inspect provider readiness',
          409,
        );
      }
      // The retained task must exist before any selector runs; a missing task is
      // an explicit refusal, not a new allocation.
      this.coordinator.taskSnapshot(taskId);
      const resolveRequest = this.resolveColdExecutionResumeRequest;
      if (resolveRequest === undefined) {
        throw new RuntimeTaskControlError(
          'cold-execution.selector-unbound',
          RUNTIME_OWNER,
          'the canonical cold execution resume selector is not bound',
          'bind resolveColdExecutionResumeRequest in the launch execution composition before resuming',
        );
      }
      const request = await resolveRequest({ taskId, operationId: input.operationId });
      this.watchExecutionForImplicitWakeup(input.operationId);
      const release = await this.coordinator.resumeExecution(taskId, input.operationId, request);
      if (release.state !== 'released') {
        throw new RuntimeTaskControlError(
          'cold-execution.resume-not-released',
          RUNTIME_OWNER,
          'the retained operation was not released; no Provider may start',
          'retain the recovery responsibility and resolve the original owner binding before resuming',
        );
      }
      const snapshot = this.coordinator.taskSnapshot(taskId);
      return {
        state: release.state,
        taskId: snapshot.taskId.value,
        operationId: input.operationId.value,
        businessTurnId: request.businessTurnId,
        ...(snapshot.executionEpoch === undefined ? {} : { executionEpoch: snapshot.executionEpoch }),
      };
    } catch (error) {
      throw apiError(error);
    }
  }

  /**
   * The production seam between the durable occurrence consumer and the real
   * execution coordinator. It creates or reuses the task for the immutable
   * occurrence binding, starts exactly the operation the occurrence was claimed
   * with, waits for the real terminal, and returns the durable terminal
   * production for the consumer's own lifecycle scope.
   *
   * There is no second verification truth: the returned verification and
   * checkpoint are derived from the checkpoint the coordinator really committed.
   */
  async executeScheduledOccurrence(input: {
    readonly occurrence: Occurrence;
    readonly policy: ExecutionPolicyDefinition;
    readonly claim: OccurrenceClaimRecord;
    readonly binding: OccurrenceTaskBinding;
    readonly scope: ScopeRef;
    readonly previousCheckpoint: Checkpoint | null;
  }): Promise<OccurrenceTerminalProduction> {
    try {
      const status = this.status();
      if (!this.canStartProviderExecution(status)) {
        const providerError = this.options.providerError;
        throw new UiRuntimeApiError(
          providerError?.code ?? `provider.readiness.${status.providerState}`,
          providerError?.ownerId ?? 'humanagent.provider-adapter',
          providerError?.message ?? `provider readiness is ${status.providerState}`,
          providerError?.nextAction ?? 'inspect provider readiness',
          409,
        );
      }
      const prompt = this.scheduledOccurrencePrompt(input.binding);
      const title = `计划执行 ${input.binding.occurrenceId}`;
      const existing = this.coordinator.taskSnapshots().find((task) => task.taskId.value === input.binding.taskId.value);
      if (existing !== undefined && (existing.title !== title || existing.directive !== prompt)) {
        throw new UiRuntimeApiError(
          'scheduled-occurrence.task-identity-conflict',
          RUNTIME_OWNER,
          `occurrence task ${input.binding.taskId.value} already belongs to different task content`,
          'inspect the persisted occurrence task identity before dispatching it',
          409,
        );
      }
      const task = existing ?? this.coordinator.createTask({ taskId: input.binding.taskId, title, directive: prompt });
      const started = this.coordinator.prepareExecution(task.taskId, {
        prompt,
        operationId: input.binding.operationId,
        ...this.defaultOrchestrate(),
      });
      if (started.operationId.value !== input.binding.operationId.value || started.executionEpoch !== input.binding.executionEpoch) {
        throw new UiRuntimeApiError(
          'scheduled-occurrence.execution-identity-conflict',
          RUNTIME_OWNER,
          `started execution ${started.operationId.value}@${started.executionEpoch} does not match occurrence binding ${input.binding.operationId.value}@${input.binding.executionEpoch}`,
          'inspect the persisted occurrence claim before dispatching it',
          409,
        );
      }
      await this.coordinator.releaseExecution(task.taskId, started.operationId);
      await this.awaitScheduledOccurrenceTerminal(started.operationId);
      const snapshot = this.coordinator.taskSnapshot(task.taskId);
      const committed = snapshot.checkpoint;
      if (committed === undefined) {
        throw new UiRuntimeApiError(
          'scheduled-occurrence.checkpoint-missing',
          RUNTIME_OWNER,
          `execution ${started.operationId.value} terminated without a committed checkpoint`,
          'inspect the execution terminal evidence before retrying the occurrence',
          409,
        );
      }
      return occurrenceTerminalProduction({
        binding: input.binding,
        claim: input.claim,
        policy: input.policy,
        scope: input.scope,
        previousCheckpoint: input.previousCheckpoint,
        committed: committed as CommittedExecutionCheckpoint,
      });
    } catch (error) {
      if (error instanceof OccurrenceTerminalError) {
        throw new UiRuntimeApiError(error.code, RUNTIME_OWNER, error.message, 'inspect the committed execution checkpoint', 409);
      }
      throw apiError(error);
    }
  }

  /**
   * The real business input for one execution plan. The plan carries only the
   * requirement identity, so the confirmed requirement envelope is the single
   * source of the prompt; a plan whose requirement is gone fails closed instead
   * of running a synthetic prompt.
   */
  private scheduledOccurrencePrompt(binding: OccurrenceTaskBinding): string {
    const requirementId = requirementIdForSubscription(binding.subscriptionId);
    const envelope = this.requirementInbox
      .exportState()
      .envelopes
      .find((candidate) => candidate.requirementId === requirementId);
    if (envelope === undefined || !envelope.normalizedInput.trim()) {
      throw new UiRuntimeApiError(
        'scheduled-occurrence.requirement-missing',
        RUNTIME_OWNER,
        `no confirmed requirement is retained for execution plan ${binding.subscriptionId}`,
        'inspect the persisted execution plan before dispatching it',
        409,
      );
    }
    return envelope.normalizedInput;
  }

  private awaitScheduledOccurrenceTerminal(operationId: OperationId): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new UiRuntimeApiError(
          'scheduled-occurrence.terminal-timeout',
          RUNTIME_OWNER,
          `execution ${operationId.value} did not reach a terminal state within ${SCHEDULED_OCCURRENCE_TERMINAL_TIMEOUT_MS}ms`,
          'inspect the running execution and the provider before retrying the occurrence',
          504,
        ));
      }, SCHEDULED_OCCURRENCE_TERMINAL_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      const isFinalTerminal = (event: RuntimeSseEvent): boolean =>
        event.kind === 'execution.terminal' && event.terminalPhase === 'final';
      try {
        const subscription = this.coordinator.subscribeReplay(operationId, undefined, (event) => {
          if (isFinalTerminal(event)) finish();
        });
        unsubscribe = subscription.unsubscribe;
        if (subscription.replay.some(isFinalTerminal)) finish();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
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
      if (this.isTaskOccupyingExecutionSlot(task) && task.operationId) {
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
      // A general answer ends before task matching or requirement recording.
      if (interpreted.kind === 'answer') {
        await this.explicitIntake.completeAnswer(snapshot.interactionId, interpreted.answer);
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
      // A typed draft revision, an execution policy that requests one, or an
      // explicit typed request kind must final-submit through the exact revision
      // path. The legacy path stays for interactions that do not declare one.
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
    if (input.requestKind === 'new-task-create' || input.requestKind === 'existing-task-change') return true;
    if (input.executionPolicy !== undefined) return true;
    if (input.taskFlow !== undefined) return true;
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
    const requestKind = input.requestKind ?? 'new-task-create';
    const existingTaskChange = requestKind === 'existing-task-change';
    if (existingTaskChange && input.taskRef === undefined) {
      throw new UiRuntimeApiError(
        'explicit-brain.missing-existing-task-target',
        RUNTIME_OWNER,
        'existing-task-change requires the explicit selected taskRef',
        'select and pass the task target before confirming the change',
        400,
      );
    }
    if (existingTaskChange) {
      // Validate the exact selected target against the interaction-arrival
      // draft before any revision mint, registration, confirmation, or
      // enqueue. A wrong target fails closed with no side effect and leaves
      // the same draft resubmittable with the exact target.
      const draftTaskRef = arrivalDraft?.matchedTasks.find((task) => task.relation === 'current')?.taskId;
      if (draftTaskRef === undefined || draftTaskRef.value !== input.taskRef!.value) {
        throw new UiRuntimeApiError(
          'explicit-brain.task-target-mismatch',
          RUNTIME_OWNER,
          `existing-task-change target ${input.taskRef!.value} does not match the confirmed draft revision target ${draftTaskRef?.value ?? 'missing'}`,
          'select the task that owns the confirmed draft revision before submitting the change',
          409,
        );
      }
      if (input.draftRevisionVersion === undefined || input.draftRevisionHash === undefined) {
        throw new UiRuntimeApiError(
          'explicit-brain.missing-draft-revision-binding',
          RUNTIME_OWNER,
          'existing-task-change requires both draftRevisionVersion and draftRevisionHash',
          'reload the reviewable revision and pass both its version and hash',
          400,
        );
      }
    }
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
    if (existingTaskChange && revision === undefined) {
      throw new UiRuntimeApiError(
        'explicit-brain.typed-revision-required',
        'humanagent.runtime.explicit-intake',
        `interaction has no reviewable typed draft revision to confirm: ${interactionId}`,
        'generate the reviewable draft before final submission',
        409,
      );
    }
    if (existingTaskChange
      && (revision!.revisionVersion !== input.draftRevisionVersion
        || revision!.revisionHash !== input.draftRevisionHash)) {
      throw new DraftRevisionError({
        code: 'confirmation-stale',
        message: 'confirmation is not bound to the current draft revision',
        draftId: revision!.draftId,
        expectedRevisionVersion: input.draftRevisionVersion,
        expectedRevisionHash: input.draftRevisionHash,
        actualRevisionVersion: revision!.revisionVersion,
        actualRevisionHash: revision!.revisionHash,
      });
    }
    if (!existingTaskChange && revision === undefined) {
      revision = await this.ensureTypedDraftRevision(interactionId, {
        executionPolicy: input.executionPolicy,
        taskFlow: input.taskFlow,
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
    let bindExecutionPolicy = false;
    if (input.executionPolicy !== undefined) {
      if (existingTaskChange && revision.executionPolicy === undefined) {
        throw new UiRuntimeApiError(
          'explicit-brain.existing-task-change-revision-immutable',
          RUNTIME_OWNER,
          'existing-task-change cannot mint a policy revision after the caller confirmed the exact revision',
          'refine the reviewable draft before confirmation or omit the execution policy',
          409,
        );
      }
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
      bindExecutionPolicy = revision.executionPolicy === undefined;
    }
    let bindTaskFlow = false;
    if (input.taskFlow !== undefined) {
      if (existingTaskChange && revision.taskFlow === undefined) {
        throw new UiRuntimeApiError(
          'explicit-brain.existing-task-change-revision-immutable',
          RUNTIME_OWNER,
          'existing-task-change cannot mint a task flow revision after the caller confirmed the exact revision',
          'refine the reviewable draft before confirmation or omit the task flow',
          409,
        );
      }
      if (revision.taskFlow !== undefined
        && (revision.taskFlow.kind !== input.taskFlow.kind
          || revision.taskFlow.definitionVersion !== input.taskFlow.definitionVersion)) {
        throw new UiRuntimeApiError(
          'explicit-brain.task-flow-binding-conflict',
          RUNTIME_OWNER,
          `draft revision already carries a different task flow: ${revision.draftId}`,
          'refine the reviewable draft to the intended task flow before final submission',
          409,
        );
      }
      bindTaskFlow = revision.taskFlow === undefined;
    }
    if (bindExecutionPolicy || bindTaskFlow) {
      // Interpretation mints the reviewable draft before confirmation. Bind
      // only the missing typed inputs in one revision; an omitted input keeps
      // the value already carried by the draft.
      revision = await this.refineDraftWithConfirmationBindings(
        interactionId,
        revision,
        input,
        bindExecutionPolicy ? input.executionPolicy : undefined,
        bindTaskFlow ? input.taskFlow : undefined,
      );
      this.persistExplicitBrainState();
    }

    const draftRevisionVersion = existingTaskChange ? input.draftRevisionVersion! : revision.revisionVersion;
    const draftRevisionHash = existingTaskChange ? input.draftRevisionHash! : revision.revisionHash;
    this.confirmationLedger.registerRevision({
      interactionId,
      draftId: revision.draftId,
      inputRevision: revision.inputRevision,
      draftRevisionVersion,
      draftRevisionHash,
      normalizedInput: revision.normalizedInput,
      intent: revision.proposedIntent,
      payloadRef: input.payloadRef,
      requestKind,
      ...(input.taskRef === undefined ? {} : { taskRef: input.taskRef }),
      ...(revision.taskFlow === undefined ? {} : { taskFlow: revision.taskFlow }),
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

    // Making the confirmed requirement visible to the FIFO consumer and
    // persisting the execution plan it owns must be one step for that consumer.
    // Otherwise a drain can observe the requirement while its plan is still
    // missing, read the missing plan as "this requirement owns no future
    // execution", and dispatch a scheduled requirement immediately. The
    // dispatch lock is the single owner of FIFO consumption, so holding it
    // across both writes keeps the requirement out of the immediate path.
    const submitted = await this.withDispatchLock(async () => {
      const idempotencyKey = input.idempotencyKey ?? `final-submit:${revision.draftId}:${draftRevisionVersion}:${input.confirmationRef}`;
      const receipt = await this.requirementSubmissions.submitFinal(requestKind === 'existing-task-change'
        ? {
            interactionId,
            taskId: input.taskRef!,
            draftId: revision.draftId,
            inputRevision: revision.inputRevision,
            draftRevisionVersion,
            draftRevisionHash,
            confirmationRef: input.confirmationRef,
            idempotencyKey,
            requestKind: 'existing-task-change',
          }
        : {
            interactionId,
            draftId: revision.draftId,
            inputRevision: revision.inputRevision,
            draftRevisionVersion,
            draftRevisionHash,
            confirmationRef: input.confirmationRef,
            idempotencyKey,
            requestKind: 'new-task-create',
          });
      if (revision.executionPolicy !== undefined) {
        await this.persistAuthorizedExecutionPlan(receipt.requirement, revision.executionPolicy);
      }
      return receipt;
    });
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
  private async refineDraftWithConfirmationBindings(
    interactionId: string,
    current: DraftRevision,
    input: ConfirmExplicitRequirementInput,
    executionPolicy?: ExecutionPolicyDefinition,
    taskFlow?: TaskFlowBinding,
  ): Promise<DraftRevision> {
    const fields: Record<string, unknown> = {
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
      ...(input.deliverables === undefined ? {} : { deliverables: input.deliverables }),
      ...(executionPolicy === undefined ? {} : { executionPolicy }),
      ...(taskFlow === undefined ? {} : { taskFlow }),
    };
    const idempotencyKey = `final-submit-binding:${interactionId}:${current.draftId}:${current.revisionVersion}:${canonicalJsonStringify({
      ...(executionPolicy === undefined ? {} : { executionPolicy }),
      ...(taskFlow === undefined ? {} : { taskFlow }),
    })}`;
    return await this.explicitIntake.refineDraft(interactionId, {
      draftId: current.draftId,
      baseRevisionVersion: current.revisionVersion,
      requestedRevisionHash: current.revisionHash,
      fields,
      instructionRef: `final-submit-binding:${interactionId}`,
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
      readonly taskFlow?: TaskFlowBinding;
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
        ...(options.taskFlow === undefined ? {} : { taskFlow: options.taskFlow }),
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
    const subscriptionId = subscriptionIdForRequirement(requirement.requirementId);
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
    const subscriptionId = subscriptionIdForRequirement(envelope.requirementId);
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
        inputRevision,
        taskId: dispatchEntry.taskId,
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
      ...(receipt.executionEpoch === undefined ? {} : { executionEpoch: receipt.executionEpoch }),
      inputRevision,
      taskId: receipt.taskId,
      ...(receipt.operationId === undefined ? {} : { operationId: receipt.operationId.value }),
      evidenceRefs: [],
    };
  }

  /**
   * A real Task submission only confirms intent, so the task-scoped grant is
   * the single execution authority: an ungranted Task retains its prepared
   * operation without auto-starting. The explicit `fake` launch binds no
   * real grant port and keeps its historical fixture simulation.
   */
  private async executionAutoStartAllowed(taskId: TaskId): Promise<boolean> {
    const port = this.options.taskGrantPort;
    if (port === undefined) return true;
    const readback = await port.readTaskGrant(taskId);
    return readback.grant?.state === 'granted';
  }

  /**
   * Default prepareExecution wrapping. A native driver already owns the real
   * pipeline.execute assignment, so only non-native assemblies orchestrate.
   */
  private defaultOrchestrate(): { orchestrate?: true } {
    return !this.nativeDriverBound && this.options.runtimeComposition?.createTaskAssembly !== undefined
      ? { orchestrate: true }
      : {};
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
    // A genuine new-task create binds the confirmed typed requirement source to
    // the Task before any execution may start. Existing-task append/change keeps
    // the Task's original immutable identity; legacy non-typed submits have no
    // typed final receipt and receive no fabricated identity.
    if (!isTaskInputUpdate && consumed.intent === 'create') {
      await this.establishNewTaskIdentity(consumed, task.taskId);
    }
    // Confirmation only confirms intent. Execution auto-starts only when the
    // bound task-scoped grant already authorizes the verified origin; otherwise
    // the materialized Task waits for an independent, granted start.
    const autoStart = await this.executionAutoStartAllowed(task.taskId);
    if (isTaskInputUpdate) {
      // Route `append`/`change` intents to this task's input mailbox instead of
      // overwriting its directive with a fresh execution. `appendTaskRevision`
      // is the single owner of the append-without-overwrite rule; the revision
      // is retained and consumed by the next execution cycle.
      this.coordinator.appendTaskInput(task.taskId, consumed);
      this.persistExplicitBrainState();
      const current = this.coordinator.taskSnapshot(task.taskId);
      if (executionEpoch === undefined) {
        if (this.isTaskOccupyingExecutionSlot(current)) {
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
        if (autoStart) {
          const execution = this.coordinator.prepareExecution(task.taskId, {
            prompt,
            ...this.defaultOrchestrate(),
            operationId,
            ...(implicitRequirement === undefined ? {} : { implicitRequirement }),
          });
          await this.coordinator.releaseExecution(task.taskId, execution.operationId);
          if (pending) this.coordinator.consumeTaskInput(task.taskId, pending.inputRevision);
          executionEpoch = execution.executionEpoch;
        }
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
        const execution = this.coordinator.prepareExecution(task.taskId, {
          prompt: consumed.normalizedInput,
          ...this.defaultOrchestrate(),
          operationId,
          ...(implicitRequirement === undefined ? {} : { implicitRequirement }),
        });
        executionEpoch = execution.executionEpoch;
      }
      // A retained operation epoch proves allocation, not durable startup.
      // Retry its release before recording dispatch completion or acknowledging.
      if (autoStart && executionEpoch !== undefined) {
        await this.coordinator.releaseExecution(task.taskId, operationId);
      }
      const started: DispatchLedgerEntry = {
        ...prepared,
        operationId,
        executionEpoch,
      };
      this.dispatchLedger.set(consumed.draftId, started);
      this.persistExplicitBrainState();
    }
    // Allocation alone does not start execution. Only a released operation is watched.
    if (autoStart && executionEpoch !== undefined) this.watchExecutionForImplicitWakeup(operationId);
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
      ...(executionEpoch === undefined ? {} : { operationId, executionEpoch }),
    };
  }

  /**
   * Bind the exact typed final-submit source to a genuine new-task create.
   *
   * The requirement envelope does not carry the typed revision hash or
   * confirmation reference, so the source can only come from the existing
   * `RequirementSubmissionOwner` typed receipt. The match is bound to the
   * requirement's FIFO identity, so a retry that reuses the same Task and the
   * same source resolves the same receipt. A legacy non-typed submit has no
   * typed receipt and keeps its prior scope with no identity.
   */
  private async establishNewTaskIdentity(consumed: RequirementEnvelope, taskId: TaskId): Promise<void> {
    const source = this.typedFinalRequirementFor(consumed);
    if (source === undefined) return;
    const taskIdentity = this.options.taskIdentity;
    if (taskIdentity === undefined) {
      throw new UiRuntimeApiError(
        'explicit-brain.task-identity-owner-missing',
        APP_OWNER,
        `typed new-task requirement ${consumed.requirementId} cannot be established without the Task identity owner`,
        'assemble the Task identity consumer over the runtime control journal',
        500,
      );
    }
    await taskIdentity.establish({
      scope: { organId: this.options.organId, taskId },
      source: {
        requirementId: source.requirementId,
        inputRevision: source.inputRevision,
        draftId: source.draftId,
        draftRevisionVersion: source.draftRevisionVersion,
        draftRevisionHash: source.draftRevisionHash,
        confirmationRef: source.confirmationRef,
      },
      ...(consumed.taskFlow === undefined ? {} : { taskFlow: consumed.taskFlow }),
    });
  }

  /**
   * The exact typed final-submit receipt for this consumed requirement, or
   * `undefined` when this is a legacy non-typed submission. The receipt is the
   * only owner of the revision hash and confirmation reference, so a partial
   * identity match is an explicit source conflict rather than a silent default.
   */
  private typedFinalRequirementFor(consumed: RequirementEnvelope): AuthorizedRequirement | undefined {
    const candidates = this.requirementSubmissions.finalReceipts()
      .map((receipt) => receipt.requirement)
      .filter((requirement) => requirement.requirementId === consumed.requirementId
        && requirement.draftId === consumed.draftId
        && requirement.inputRevision === consumed.inputRevision);
    if (candidates.length === 0) {
      if (this.options.taskIdentity === undefined) return undefined;
      throw new UiRuntimeApiError(
        'explicit-brain.task-identity-source-missing', APP_OWNER,
        `requirement ${consumed.requirementId} has no exact typed final-submit source for this FIFO entry`,
        'inspect the final-submit receipt before retrying dispatch', 409,
      );
    }
    const exact = candidates.find((requirement) => requirement.fifoSeq === consumed.fifoSeq
      && requirement.payloadRef === consumed.payloadRef);
    if (exact === undefined) {
      throw new UiRuntimeApiError(
        'explicit-brain.task-identity-source-conflict',
        APP_OWNER,
        `requirement ${consumed.requirementId} has no exact typed final-submit source for this FIFO entry`,
        'inspect the persisted final-submit receipt before retrying dispatch',
        409,
      );
    }
    return exact;
  }

  private providerAdmissionInputs() {
    const status = this.status();
    const providerRequestable = this.canStartProviderExecution(status);
    const health = status.state === 'ready'
      ? 'healthy' as const
      : status.state === 'degraded'
        ? 'degraded' as const
        : status.state === 'unknown'
          ? 'unknown' as const
          : 'unhealthy' as const;
    const availableCapabilities = providerRequestable
      ? [PROVIDER_EXECUTION_CAPABILITY]
      : [];
    const unknownHealthRequestable = status.state === 'unknown' && providerRequestable;
    return { health, availableCapabilities, unknownHealthRequestable };
  }

  private isTaskOccupyingExecutionSlot(task: RuntimeTaskSnapshot): boolean {
    return task.state === 'running' || task.state === 'settling' || task.executionRelease === 'releasing';
  }

  private classifyAndAdmitConfirmedRequirement(envelope: RequirementEnvelope): RequirementAdmissionReceipt {
    const { health, availableCapabilities, unknownHealthRequestable } = this.providerAdmissionInputs();
    const queue = classifyConfirmedRequirement(envelope);
    const tasks = this.coordinator.taskSnapshots();
    const isTaskInputUpdate = envelope.taskRef !== undefined
      && (envelope.intent === 'append' || envelope.intent === 'change');
    const runningTasks = tasks.filter((task) => this.isTaskOccupyingExecutionSlot(task));
    return admitRequirement({
      envelope,
      queue: defaultAdmissionQueueConfig(queue, this.options.maxConcurrentTasks),
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
      unknownHealthRequestable,
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
        const { health, availableCapabilities, unknownHealthRequestable } = this.providerAdmissionInputs();
        // Share the explicit dispatch mutex so a manual /api/explicit/dispatch-next
        // cannot interleave with the background FIFO drain on the same head.
        const attempt = await this.withDispatchLock(() => this.implicitBrain.drainNext({
          queueLoad: {
            running: this.coordinator.taskSnapshots().filter((task) => this.isTaskOccupyingExecutionSlot(task)).length,
            queued: this.coordinator.taskSnapshots().filter((task) => task.state === 'created' || task.state === 'admitted').length,
          },
          requiredCapabilities: [PROVIDER_EXECUTION_CAPABILITY],
          availableCapabilities,
          health,
          unknownHealthRequestable,
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
      const taskId = this.coordinator.operationTask(operationId);
      const task = this.coordinator.taskSnapshot(taskId);
      if (task.operationId !== undefined && task.operationId !== operationId.value
        && this.isTaskOccupyingExecutionSlot(task)) {
        this.watchExecutionForImplicitWakeup(id('operation', task.operationId));
        return;
      }
      // A same-operation final may arrive just before finalize clears its
      // running state. Keep its normal deferred FIFO wake.
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

  /**
   * Hands the inner driver the child-call manager that already exists on this
   * task's assembly. This wrapper only forwards the typed manager; it never
   * builds a manager, pool, driver or assembly of its own.
   */
  bindChildCallManager(manager: Pick<OrchestrationManager, 'callChild'>): void {
    (this.driver as Partial<RuntimeExecutionDriver & { bindChildCallManager?: (manager: Pick<OrchestrationManager, 'callChild'>) => void }>)
      .bindChildCallManager?.(manager);
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
