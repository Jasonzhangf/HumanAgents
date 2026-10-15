import { createHash } from 'node:crypto';
import {
  id,
  type AgentDriver,
  type AgentRoleDisplay,
  type AgentEvent,
  type AgentHandle,
  type Attention,
  type AgentOutput,
  type AdmittedTurn,
  type Checkpoint,
  type CycleId,
  type DecisionTraceRecord,
  type EvidenceRef,
  type JournalCommitRef,
  type LifecycleState,
  type NextAction,
  type OperationId,
  type OrganId,
  type RawAsset,
  type RawFactEnvelope,
  type ProviderCloseResult,
  type ProviderError,
  type ProviderEvent,
  type ProviderRequestLifecycleEvent,
  type PreparedRecoveryCapture,
  type ProviderToolCall,
  type ToolExecutionFact,
  type ScopeRef,
  type Task,
  type TaskId,
  type RequirementEnvelope,
  type WorkAssignment,
  type WorkResult,
  canonicalJsonStringify,
  validateProviderEvent,
  type PublicOutputBinding,
  type PublicOutputCandidate,
  type PublicOutputJournalPort,
  type PublicOutputPublication,
} from '../../../contracts/src/index.js';
import {
  bindAssignmentDelivery,
  type StandardTurnDeliveryBinding,
  type StandardTurnDeliveryReadback,
} from './standard-turn-delivery.js';
import { completeCheckpoint, recallCheckpoint } from '../checkpoints/coordinator.js';
import type { CommittedCheckpointRecord, LatestCheckpointRecord } from '../checkpoints/ports.js';
import type { AdvanceTurnResult } from '../agent-loop/runtime.js';
import { selectRuntimeTaskCurrentState } from './current-state.js';
import type { RuntimeTaskCurrentState, RuntimeTaskCurrentStateFacts, RuntimeTaskCurrentStateFactsPort,
  RuntimeTaskCurrentStatePort, RuntimeTaskCurrentStateRead, RuntimeTaskCurrentStateSelection,
  RuntimeTaskProcessingState, RuntimeTaskCurrentPlan } from './current-state.js';
import { computeReentryDecision, type CheckpointReentryDecision } from '../checkpoints/closure.js';
import type { CheckpointJournalPort } from '../checkpoints/ports.js';
import type { InteractionClosureRecord } from '../checkpoints/closure.js';
import { produceAdmittedTurn, newActiveTurnId, type RuntimeBindingSnapshot } from '../admission/admitted-turn.js';
import { ActiveTurnContext, RuntimeActiveTurnError, childInvocationId } from '../context/active-turn-context.js';
import type { ActiveTurnJournalPort } from '../context/active-turn-journal.js';
import { ActiveTurnRecoveryCapture, type ActiveTurnProviderProducer, type RecoveryCaptureReferences } from '../context/recovery-assets.js';
import type {
  ChildCallAdoptionInput,
  ChildCallPort,
  ChildCallPrepareInput,
  ChildCallReturnInput,
  ChildCallReviewCheckpointInput,
  ChildCallReviewCheckpointReceipt,
  PreparedChildCall,
} from '../orchestration/types.js';
import { publishRequiredAttention, type AttentionPort } from '../control/attention.js';
import type { RequestStopCommand } from '../control/control-command.js';
import { executeStopControl } from '../control/runtime-stop.js';
import {
  StopSettlementCommitError,
  type CheckpointCommitPort,
  type StopSettlementRecovery,
} from '../control/steering.js';
import type { AgentHookStage } from '../agent-io/events.js';
import { ContextCommitter, type PublishedContext } from '../context/index.js';
import { createHookRegistry, type AgentHookRegistry } from '../hooks/index.js';
import { AgentRuntime, bindAgentDriver, type AgentRuntimeObservation, type AgentRuntimeClosure } from '../nodes/agent-runtime.js';
import { RUNTIME_NODE_MARKERS } from '../nodes/node-registry.js';
import {
  appendTaskRevision,
  type TaskRevision,
  type TaskRevisionState,
  type TaskUpdateDecision,
  type ImplicitExecutorPlanInput,
  type RequirementAdmissionReceipt,
} from '../admission/index.js';
import type { OrchestrationManager } from '../orchestration/manager.js';
import {
  acceptanceCriteriaContent,
  createRetryCycleManager,
  digestOf,
  type AgentRuntimePoolManager,
  type ExecutionAgentPort,
  type ExecutorReviewEvidence,
  type RetryCycleConfigSet,
  type RetryCycleIssue,
  type RetryCycleJournalPort,
} from '../orchestration/index.js';
import type { ExplicitIntakeState } from '../intake/explicit-intake.js';
import type { RequirementInboxState } from '../intake/requirement-inbox.js';
import type { ConfirmationLedgerState, PersistedSubmittedReceipt } from '../explicit-brain/router.js';
import type { DispatchInput } from '../orchestration/types.js';
import { resumeColdExecution, type ColdExecutionLifecycleBinding, type PreparedColdExecution,
  type RuntimeColdExecutionProducer, type RuntimeColdExecutionResumeRequest } from './cold-execution-resume.js';

export type RuntimeTaskError = {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextAction: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly cleanupError?: RuntimeTaskError;
};

type MutableRuntimeTaskError = Omit<RuntimeTaskError, 'evidenceRefs' | 'cleanupError'> & {
  evidenceRefs?: readonly EvidenceRef[];
  cleanupError?: RuntimeTaskError;
};

export type RuntimeTaskEventKind =
  | 'execution.started'
  | 'provider.model'
  | 'provider.output'
  | 'provider.tool'
  | 'provider.tool-result'
  | 'provider.error'
  | 'execution.settling'
  | 'checkpoint.committed'
  | 'execution.terminal'
  | 'attention.opened'
  | 'attention.resolved';

export interface RuntimeTaskEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly occurredAt: string;
  readonly taskId: TaskId;
  readonly operationId: string;
  readonly executionEpoch: number;
  readonly kind: RuntimeTaskEventKind;
  readonly state: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  /**
   * Real provider-reported turn identity. Only present when the provider
   * reported one; the runtime never synthesizes a turn id.
   */
  readonly turnId?: string;
  readonly requestId?: string;
  readonly parentRequestId?: string;
  /** Provider-reported occurrence time, when the provider reported one. */
  readonly providerOccurredAt?: string;
  readonly ownerId?: string;
  readonly retryable?: boolean;
  readonly nextAction?: string;
  readonly terminalPhase?: 'provider' | 'final';
  readonly callId?: string;
  readonly toolId?: string;
  readonly arguments?: unknown;
  readonly status?: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';
  readonly error?: RuntimeTaskError;
  /**
   * Provider wire identity, when the provider reported one. This is diagnostic
   * provenance only and never substitutes for the operation identity above.
   */
  readonly externalResponseId?: string;
  /** Provider-reported response model, when the provider reported one. */
  readonly responseModel?: string;
  /** All provider-reported output refs, in provider order. */
  readonly outputRefs?: readonly string[];
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly executionFact?: ToolExecutionFact;
}

/**
 * Provider-reported request identity for one request attempt of a task. Every
 * field comes from the provider binding's own lifecycle report.
 */
export interface RuntimeTaskRequestIdentity {
  readonly turnId: string;
  readonly requestId: string;
  readonly parentRequestId?: string;
  readonly phase: string;
  readonly occurredAt: string;
}

export interface RuntimeTaskSnapshot {
  readonly taskId: TaskId;
  readonly title: string;
  readonly directive: string;
  readonly directiveRevision: number;
  readonly state: LifecycleState;
  readonly currentState: string;
  readonly nextStep: string;
  readonly updatedAt: string;
  readonly input: string;
  readonly output: string;
  readonly currentNode: string;
  readonly operationId?: string;
  readonly executionEpoch?: number;
  readonly cycleId?: string;
  /** Rebuildable committed public-output projection for the current operation/epoch. */
  readonly publicOutput?: PublicOutputPublication;
  readonly orchestrated: boolean;
  readonly allowedActions: readonly string[];
  readonly recentEvents: readonly RuntimeTaskEvent[];
  readonly events: readonly RuntimeTaskEvent[];
  readonly checkpoint?: {
    readonly checkpointId: string;
    readonly seq: number;
    readonly outcome: string;
    readonly summary: string;
    readonly committedAt: string;
    readonly evidenceRefs: readonly EvidenceRef[];
  };
  /**
   * The most recent request identity the provider binding itself reported for
   * this task. It is absent until the binding reports one; the runtime never
   * synthesizes a turn or request id.
   */
  readonly requestIdentity?: RuntimeTaskRequestIdentity;
  readonly error?: RuntimeTaskError;
}

export interface RuntimeExecutionDriver extends AgentDriver {
  close(): Promise<ProviderCloseResult>;
  /**
   * Hands this execution the typed child-call manager that already exists on
   * the task assembly. The coordinator calls it after `createTaskAssembly`
   * returns and before the root model request starts, passing the manager
   * straight from that typed owner: never through business args or metadata.
   * It stays optional so an existing driver with no child capability keeps
   * compiling and running unchanged; the coordinator never mints a manager,
   * driver, pool or assembly just to bind one.
   */
  bindChildCallManager?(manager: Pick<OrchestrationManager, 'callChild'>): void;
  /** Canonical turn owner; a transport or projection checkpoint cannot replace it. */
  readonly standardTurn?: {
    acceptReviews(refs: readonly JournalCommitRef[]): Promise<void>;
    readCheckpoint(): Promise<CommittedCheckpointRecord>;
    align(): Promise<AdvanceTurnResult>;
    /**
     * Reads the accepted standard-end delivery bundle for the retained
     * assignment. Native succeeded-result assembly requires this capability;
     * a missing reader is an explicit stop, never a fallback to operation refs
     * or drain text.
     */
    readDelivery?(): Promise<StandardTurnDeliveryReadback>;
  };
}

/**
 * The typed execution identity the coordinator allocates for one operation.
 * Everything here is produced by the coordinator's own task execution owner
 * (scope, runtime id, operation, cycle, Harness epoch, assignment, directive
 * input revision) before any external effect, so an execution can be prepared
 * and registered while still unreleased. `role` and `configuredAgentId` are the
 * typed control selection the actual owner supplies; they are never derived
 * from a dispatch label, transcript, task payload or metadata.
 */
export interface RuntimeExecutionAllocation {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly ownerId: string;
  readonly directiveRevision: number;
  readonly inputRevision: number;
  readonly orchestrated: boolean;
  /**
   * The configured control selection for this execution, when the actual owner
   * bound one. Absent means no selection was supplied, which is not the same as
   * a default selection: the producer resolves it, and a same-role ambiguity
   * stays an explicit failure instead of a substituted route. This is the same
   * role vocabulary as the canonical Config `AgentRole`; contracts carry their
   * own equivalent copy so control-side consumers need not import Config.
   */
  readonly role?: AgentRoleDisplay;
  readonly configuredAgentId?: string;
}

/**
 * The exact input the driver factory receives: the allocated identity, plus
 * the binding/epoch this particular attempt selected. A Retry-10 attempt
 * selects its own binding and epoch, so those two are per-attempt while the
 * rest of the allocation stays the operation's own identity.
 */
export interface RuntimeExecutionPreparationInput extends RuntimeExecutionAllocation {
  readonly attemptBindingId?: string;
  readonly attemptExecutionEpoch: number;
}

/**
 * The release state of an allocated execution. `prepared` is the durable
 * identity that exists before any Provider runs; `released` means the actual
 * admission for that allocation completed and the driver may start. An
 * unreleased allocation must never be reported as a running Provider.
 */
export type RuntimeExecutionRelease =
  | { readonly state: 'prepared' }
  | { readonly state: 'released' };

/** The caller completes real registration/coverage here, outside Provider waits. */
export type RuntimeExecutionAdmission = (allocation: RuntimeExecutionAllocation) => Promise<void>;

export interface RuntimeExecutionDriverInput {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly ownerId: string;
}

/**
 * The execution driver factory. The returned driver may be produced
 * synchronously, or asynchronously when the producer must resolve the actual
 * Provider for this execution first (configured selection, own probe, own
 * admission). The coordinator awaits the factory exactly once, before the
 * driver starts, so an unresolved selection can never dispatch a late request
 * to a Provider this execution never admitted. A factory that returns a plain
 * driver keeps the existing synchronous behavior.
 */
export type RuntimeExecutionDriverFactory = (
  input: RuntimeExecutionPreparationInput,
) => RuntimeExecutionDriver | Promise<RuntimeExecutionDriver>;

/**
 * The Retry-10 selected-binding driver factory. It is the same seam as
 * `RuntimeExecutionDriverFactory`: a retry attempt selects its own binding and
 * may produce that binding's driver asynchronously before the attempt starts.
 */
export type RuntimeExecutionDriverForBindingFactory = (
  bindingId: string,
  input: RuntimeExecutionPreparationInput,
) => RuntimeExecutionDriver | Promise<RuntimeExecutionDriver>;

export interface RuntimeExecutionCapabilities {
  readonly providerNeutralHarness: {
    readonly state: 'available';
    readonly ownerId: 'humanagent.runtime';
  };
  readonly requestResponseHooks: {
    readonly state: 'available';
    readonly ownerId: 'humanagent.runtime.hooks';
  };
  readonly agentIoRequestLifecycle: {
    readonly state: 'unavailable';
    readonly ownerId: 'humanagent.runtime.agent-io';
    readonly reason: string;
  };
  readonly contextCommitReentry: {
    readonly state: 'available';
    readonly ownerId: 'humanagent.runtime.checkpoints';
  };
  readonly checkpointSettlementCancellation: {
    readonly state: 'available';
    readonly ownerId: 'humanagent.runtime.control';
  };
  readonly eventBus: {
    readonly state: 'unavailable';
    readonly ownerId: 'humanagent.runtime.events';
    readonly reason: string;
  };
}

export interface RuntimeContextCommitResult {
  readonly checkpoint: Checkpoint;
  readonly context: PublishedContext<Checkpoint>;
  readonly reentry: CheckpointReentryDecision;
  readonly recordDigest?: string;
}

export interface RuntimeExecutionComposition {
  readonly driver: RuntimeExecutionDriver;
  readonly runtime: AgentRuntime;
  readonly capabilities: RuntimeExecutionCapabilities;
  start(): Promise<AgentHandle>;
  submit(prompt: string): Promise<AgentOutput>;
  observe(): AsyncIterable<AgentRuntimeObservation>;
  settle(): Promise<AgentRuntimeClosure>;
  commitCheckpoint(checkpoint: Checkpoint, previous: Checkpoint | null): Promise<RuntimeContextCommitResult>;
  checkpointCommitPort(previous: Checkpoint | null): CheckpointCommitPort;
}

export interface RuntimeTaskJournalPort {
  append(record: RuntimeTaskJournalRecord): void;
  replay(): readonly RuntimeTaskJournalRecord[];
}

export interface RuntimeExplicitBrainJournalState {
  readonly intake: ExplicitIntakeState;
  readonly inbox: RequirementInboxState;
  readonly confirmationLedger: ConfirmationLedgerState;
  readonly dispatchLedger: readonly {
    readonly draftId: string;
    readonly taskId: TaskId;
    readonly operationId: OperationId;
    readonly executionEpoch?: number;
  }[];
  readonly requirementAdmissions?: readonly {
    readonly taskId: TaskId;
    readonly queue: 'interactive' | 'execution' | 'research' | 'maintenance';
    readonly receipt: unknown;
  }[];
  readonly submittedSubmissions: readonly PersistedSubmittedReceipt[];
  readonly decisionTraces?: readonly DecisionTraceRecord[];
  readonly taskInputRevisions?: readonly {
    readonly taskId: TaskId;
    readonly state: TaskRevisionState;
    readonly consumedInputRevision?: number;
  }[];
}

export type RuntimeTaskJournalRecord =
  | {
      readonly kind: 'task.created';
      readonly taskId: TaskId;
      readonly title: string;
      readonly directive: string;
      readonly directiveRevision: number;
      readonly createdAt: string;
      readonly taskCounter: number;
    }
  | {
      readonly kind: 'task.updated';
      readonly taskId: TaskId;
      readonly title: string;
      readonly directive: string;
      readonly directiveRevision: number;
      readonly updatedAt: string;
    }
  | {
      readonly kind: 'task.deleted';
      readonly taskId: TaskId;
      readonly deletedAt: string;
    }
  | {
      readonly kind: 'operation.started';
      readonly operationId: OperationId;
      readonly taskId: TaskId;
      readonly cycleId: CycleId;
      readonly scope: ScopeRef;
      readonly executionEpoch: number;
      readonly operationCounter: number;
      readonly cycleCounter: number;
      readonly startedAt: string;
      readonly input: string;
      readonly orchestrated?: boolean;
    }
  | {
      /**
       * The coordinator-owned execution allocation, persisted before any
       * external effect. It is the durable prepared identity an exact retry
       * reuses, and the exact input the bounded async preparation consumes.
       * `role`/`configuredAgentId` are the typed control selection the actual
       * owner supplied; they are never re-derived from a label or metadata.
       */
      readonly kind: 'operation.prepared';
      readonly allocation: RuntimeExecutionAllocation;
      readonly input: string;
      readonly operationCounter: number;
      readonly cycleCounter: number;
    }
  | {
      readonly kind: 'operation.event';
      readonly operationId: OperationId;
      readonly event: RuntimeTaskEvent;
      readonly taskOutput?: string;
      readonly error?: RuntimeTaskError;
    }
  | {
      readonly kind: 'explicit-brain.state';
      readonly state: RuntimeExplicitBrainJournalState;
    }
  | {
      readonly kind: 'interaction.closure';
      readonly closure: InteractionClosureRecord;
    };

export class RuntimeTaskControlError extends Error {
  constructor(
    readonly code: string,
    readonly ownerId: string,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = 'RuntimeTaskControlError';
  }
}

const RUNTIME_OWNER = 'humanagent.runtime';

export interface TaskCheckpointStore extends CheckpointJournalPort, CheckpointCommitPort {}

export interface RuntimeTaskCoordinatorOptions {
  readonly organId: OrganId;
  readonly createDriver: RuntimeExecutionDriverFactory;
  /**
   * Same App composition's mandatory cold owners (source, grant, incarnation
   * config, original-turn recovery and native v2 composition). Absence keeps a
   * cold resume held; it never fabricates an empty producer.
   */
  readonly coldExecution?: RuntimeColdExecutionProducer;
  readonly admitExecution?: RuntimeExecutionAdmission;
  /**
   * Reads back the files an execution produced, so the quality reviewer is
   * handed the artifact itself. A provider text summary cannot be verified
   * against acceptance criteria that describe file content, which leaves every
   * file-producing assignment stuck on an inconclusive review.
   */
  readonly producedArtifacts?: ProducedArtifactPort;
  /**
   * Optional Retry-10 provider avoidance. When present, provider execution is
   * chosen through a durable retry cycle before each attempt and the selected
   * binding drives the actual provider runtime. Absent config keeps the
   * existing single-binding behavior and never synthesizes an alternate route.
   */
  readonly providerRetry?: {
    readonly config: RetryCycleConfigSet;
    readonly journal: RetryCycleJournalPort;
    readonly createDriverForBinding: RuntimeExecutionDriverForBindingFactory;
  };
  readonly checkpointStoreFor: (taskId: TaskId, cycleId: CycleId) => TaskCheckpointStore;
  readonly attentionPort: AttentionPort;
  readonly journal?: RuntimeTaskJournalPort;
  readonly currentStatePort?: RuntimeTaskCurrentStatePort;
  /** Actual AgentLoop and native-save facts; unknown never becomes an empty recovery. */
  readonly currentStateFacts?: RuntimeTaskCurrentStateFactsPort;
  readonly publicOutputStoreFor?: (taskId: TaskId, cycleId: CycleId) => PublicOutputJournalPort;
  readonly hookRegistry?: AgentHookRegistry;
  readonly taskIdPrefix?: string;
  readonly now?: () => Date;
  readonly checkpointBoundary?: RuntimeCheckpointBoundaryPort;
  /**
   * Narrow durable boundary for the Runtime-owned active turn. When bound, the
   * coordinator opens a durable admitted turn at admission, registers the real
   * Provider request chain, and records child invocation/delivery facts. When
   * absent the prior behaviour is unchanged.
   */
  readonly activeTurnJournal?: ActiveTurnJournalPort;
  readonly activeTurnJournalFor?: (binding: import('../../../contracts/src/index.js').ActiveTurnBinding) => ActiveTurnJournalPort;
  readonly initialInputStore?: {
    store(input: { readonly binding: import('../../../contracts/src/index.js').ActiveTurnBinding; readonly bytes: Uint8Array }): Promise<RawAsset>;
  };
  readonly recoveryReferencesFor?: (binding: import('../../../contracts/src/index.js').ActiveTurnBinding) => Promise<Pick<RecoveryCaptureReferences, 'completionLookups' | 'recovery'>>;
  /**
   * Runtime permission/binding snapshot used to open the active turn. It must
   * come from real assembled Runtime inputs. It is required whenever an
   * orchestrated execution is admitted; a missing snapshot stops the active
   * turn open instead of fabricating a permission revision.
   */
  readonly permissionSnapshot?: RuntimeBindingSnapshot;
  /**
   * Stores the refined child delivery asset so a cold read can resolve it. The
   * App assembles the durable store; the Runtime only references it.
   */
  readonly refinedDeliveryStore?: RefinedDeliveryStore;
  readonly createTaskAssembly?: (input: {
    readonly task: Task;
    readonly scope: ScopeRef;
    readonly checkpointJournal: TaskCheckpointStore;
    readonly executionAgent?: ExecutionAgentPort;
    readonly maxAttempts?: number;
    readonly childCallPort?: ChildCallPort;
  }) => RuntimeTaskAssembly;
}

/**
 * Durable store for refined child delivery assets. `store` returns a read
 * descriptor; `read` resolves the stored bytes by that descriptor.
 */
export interface RefinedDeliveryStore {
  store(input: {
    readonly scope: ScopeRef;
    readonly invocationId: string;
    readonly bytes: Uint8Array;
  }): Promise<RawAsset>;
  read(asset: RawAsset): Promise<Uint8Array>;
}

/** One file an execution wrote, as the reviewer must see it. */
export interface ProducedArtifactFile {
  readonly path: string;
  readonly content: string;
}

export interface ProducedArtifactReadRequest {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  /** Workspace-relative paths the execution wrote, in tool-call order. */
  readonly paths: readonly string[];
}

/**
 * Reads produced files back for review. The runtime owns which paths count as
 * produced; the assembly owns how they are resolved and bounded.
 */
export interface ProducedArtifactPort {
  read(request: ProducedArtifactReadRequest): Promise<readonly ProducedArtifactFile[]>;
}

export interface RuntimeTaskAssembly {  readonly orchestration: OrchestrationManager;
  readonly runtimePool: AgentRuntimePoolManager;
}

export interface RuntimeCheckpointBoundary {
  readonly checkpoint: Checkpoint;
  readonly previous: Checkpoint | null;
  readonly recordDigest?: string;
}

export interface RuntimeCheckpointBoundaryPort {
  publish(input: RuntimeCheckpointBoundary): Promise<void>;
}

export interface TaskRecord {
  readonly taskId: TaskId;
  title: string;
  directive: string;
  directiveRevision: number;
  state: LifecycleState;
  currentState: string;
  nextStep: string;
  input: string;
  output: string;
  currentNode: string;
  createdAt: string;
  updatedAt: string;
  operationId?: OperationId;
  executionEpoch?: number;
  cycleId?: CycleId;
  /**
   * Confirmed `append`/`change` input revisions for this task. `appendTaskRevision`
   * is the single owner of the append-without-overwrite rule; this record only
   * retains its decision and how far the execution cycles have consumed it.
   */
  inputRevisionState?: TaskRevisionState;
  consumedInputRevision?: number;
  allowedActions: string[];
  runtime?: AgentRuntime;
  driver?: RuntimeExecutionDriver;
  /**
   * The durable execution allocation for the current operation, and its
   * release state. `running` only becomes true after the actual admission
   * released the prepared identity, so a task held during preparation is never
   * reported as an executing Provider.
   */
  allocation?: RuntimeExecutionAllocation;
  release?: RuntimeExecutionRelease;
  releasePending?: Promise<RuntimeExecutionRelease>;
  resolveRelease?: (release: RuntimeExecutionRelease) => void;
  rejectRelease?: (error: unknown) => void;
  composition?: RuntimeExecutionComposition;
  /** Settled closure of the retained cold execution, read by the generation lane. */
  resumedClosure?: AgentRuntimeClosure;
  checkpointBoundary?: ContextCheckpointBoundary;
  taskAssembly?: RuntimeTaskAssembly;
  /** Live Runtime-owned active turn for the current orchestrated execution. */
  activeTurn?: ActiveTurnContext;
  captureOwner?: ActiveTurnRecoveryCapture;
  preparedCapture?: PreparedRecoveryCapture;
  childTurns?: Map<string, { readonly context: ActiveTurnContext; readonly capture: ActiveTurnRecoveryCapture }>;
  originalInput?: string;
  /** The single Runtime-built assignment for the current orchestrated execution. */
  assignment?: WorkAssignment;
  implicitRequirement?: {
    readonly envelope: RequirementEnvelope;
    readonly admission: RequirementAdmissionReceipt;
  };
  events: RuntimeTaskEvent[];
  requestIdentity?: RuntimeTaskRequestIdentity;
  publicOutput?: PublicOutputPublication;
  checkpoint?: Checkpoint;
  checkpointSeq: number;
  currentStateCommitRef?: JournalCommitRef;
  currentPlan?: RuntimeTaskCurrentPlan;
  error?: RuntimeTaskError;
  orchestrated: boolean;
  running: boolean;
  stopping: boolean;
  postCommitRecoveryPending?: boolean;
  executionReady?: Promise<boolean>;
  resolveExecutionReady?: (ready: boolean) => void;
}

export interface OperationRecord {
  readonly operationId: OperationId;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly input: string;
  readonly orchestrated: boolean;
  /**
   * The coordinator-owned allocation for this operation, once it has been
   * persisted. An exact retry of the same operation reuses this identity
   * instead of minting a second scope, runtime id or Harness epoch.
   */
  allocation?: RuntimeExecutionAllocation;
  readonly events: RuntimeTaskEvent[];
  seq: number;
}

function sameId(left: { readonly scope: string; readonly value: string } | undefined, right: { readonly scope: string; readonly value: string } | undefined): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return sameId(left.organId, right.organId)
    && sameId(left.taskId, right.taskId)
    && sameId(left.cycleId, right.cycleId)
    && sameId(left.operationId, right.operationId);
}

/**
 * Sanitizes a locator or invocation identity into the id charset, so a validated
 * Runtime id can be minted from a human-readable reference that carries slashes
 * or colons. The locator itself is preserved verbatim on the evidence ref.
 */
function activeTurnSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

function sameCheckpointBusinessScope(requested: ScopeRef, checkpoint: ScopeRef): boolean {
  return sameId(requested.organId, checkpoint.organId)
    && sameId(requested.taskId, checkpoint.taskId)
    && sameId(requested.cycleId, checkpoint.cycleId)
    && (!checkpoint.operationId || sameId(requested.operationId, checkpoint.operationId));
}

function nextActionForRuntimeState(state: LifecycleState): NextAction {
  switch (state) {
    case 'created':
    case 'waiting':
    case 'admitted':
      return { kind: 'wait' };
    case 'running':
      return { kind: 'continue' };
    case 'settling':
      return { kind: 'stop' };
    case 'blocked':
    case 'failed':
    case 'unknown':
    case 'stale':
      return { kind: 'recover' };
    default:
      return { kind: 'stop' };
  }
}

function toNextActionText(next: NextAction | undefined): string | undefined {
  return next ? `${next.kind}${next.ref ? `:${next.ref}` : ''}` : undefined;
}

function providerErrorProjection(error: ProviderError): RuntimeTaskError {
  return {
    code: error.code,
    ownerId: error.ownerId,
    message: error.message,
    retryable: error.retryable === 'retryable',
    nextAction: toNextActionText(error.nextAction) ?? RUNTIME_OWNER,
    evidenceRefs: error.evidenceRefs,
  };
}

function mapProviderEventKind(kind: ProviderEvent['kind']): RuntimeTaskEventKind {
  switch (kind) {
    case 'model': return 'provider.model';
    case 'output': return 'provider.output';
    case 'tool': return 'provider.tool';
    case 'error': return 'provider.error';
    case 'terminal': return 'execution.terminal';
    case 'attention': return 'attention.opened';
    case 'transport': return 'provider.error';
  }
}

function lifecycleStateLabel(state: LifecycleState): string {
  switch (state) {
    case 'created': return '已创建';
    case 'admitted': return '已准入';
    case 'running': return '运行中';
    case 'settling': return '收拢中';
    case 'succeeded': return '已完成';
    case 'waiting': return '等待决策';
    case 'blocked': return '受阻';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
    case 'stopped': return '已停止';
    case 'stale': return '过期';
    case 'unknown': return '未知';
  }
}

/**
 * Mutable projection state rebuilt from task Journal records. It is the exact
 * shape the coordinator's own replay writes, so a cold read-only consumer gets
 * the same inventory and event identity rules without owning a lifecycle.
 */
export interface TaskJournalReplayState {
  taskCounter: number;
  operationCounter: number;
  cycleCounter: number;
  tasks: Map<string, TaskRecord>;
  operations: Map<string, OperationRecord>;
  scopes: Map<string, ScopeRef>;
  deletedTaskIds: Set<string>;
}

/**
 * Folds task Journal records into projection state. This is the replay rule a
 * cold read-only reader reuses: it restores only identity, inventory, input,
 * output and events. It never claims live running state and never writes.
 */
export function replayTaskJournalRecords(
  state: TaskJournalReplayState,
  records: readonly RuntimeTaskJournalRecord[],
): void {
  for (const record of records) {
    switch (record.kind) {
      case 'task.created': {
        state.taskCounter = Math.max(state.taskCounter, record.taskCounter);
        if (state.tasks.has(record.taskId.value)) break;
        state.tasks.set(record.taskId.value, {
          taskId: record.taskId,
          title: record.title,
          directive: record.directive,
          directiveRevision: record.directiveRevision,
          state: 'created',
          currentState: '已创建',
          nextStep: '选择模式并发起执行',
          input: '',
          output: '',
          currentNode: RUNTIME_NODE_MARKERS.inputReceived,
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          allowedActions: ['start'],
          events: [],
          checkpointSeq: 0,
          orchestrated: false,
          running: false,
          stopping: false,
        });
        break;
      }
      case 'task.updated': {
        const task = state.tasks.get(record.taskId.value);
        if (task) {
          task.title = record.title;
          task.directive = record.directive;
          task.directiveRevision = record.directiveRevision;
          task.updatedAt = record.updatedAt;
        }
        break;
      }
      case 'task.deleted': {
        state.deletedTaskIds.add(record.taskId.value);
        state.tasks.delete(record.taskId.value);
        break;
      }
      case 'operation.prepared': {
        state.operationCounter = Math.max(state.operationCounter, record.operationCounter);
        state.cycleCounter = Math.max(state.cycleCounter, record.cycleCounter);
        const existing = state.operations.get(record.allocation.operationId.value);
        if (existing && existing.allocation !== undefined) {
          if (
            existing.allocation.taskId.value !== record.allocation.taskId.value
            || existing.allocation.operationId.value !== record.allocation.operationId.value
            || existing.allocation.executionEpoch !== record.allocation.executionEpoch
          ) {
            throw new RuntimeTaskControlError(
              'journal.corrupt',
              RUNTIME_OWNER,
              `journal prepared allocation ${record.allocation.operationId.value} does not match its first allocation`,
              'repair or discard the UI runtime journal before restarting',
            );
          }
          break;
        }
        const operation = existing ?? {
          operationId: record.allocation.operationId,
          taskId: record.allocation.taskId,
          executionEpoch: record.allocation.executionEpoch,
          input: record.input,
          orchestrated: record.allocation.orchestrated,
          events: [],
          seq: 0,
          allocation: record.allocation,
        };
        operation.allocation = record.allocation;
        state.operations.set(operation.operationId.value, operation);
        state.scopes.set(operation.operationId.value, record.allocation.scope);
        const task = state.tasks.get(record.allocation.taskId.value);
        if (task) {
          task.allocation = record.allocation;
          task.operationId = operation.operationId;
          task.executionEpoch = operation.executionEpoch;
          task.input = operation.input;
          task.orchestrated = operation.orchestrated;
          task.release = { state: 'prepared' };
        }
        break;
      }
      case 'operation.started': {
        state.operationCounter = Math.max(state.operationCounter, record.operationCounter);
        state.cycleCounter = Math.max(state.cycleCounter, record.cycleCounter);
        const existing = state.operations.get(record.operationId.value);
        if (
          existing
          && (existing.taskId.value !== record.taskId.value || existing.executionEpoch !== record.executionEpoch)
        ) {
          throw new RuntimeTaskControlError(
            'journal.corrupt',
            RUNTIME_OWNER,
            `journal operation ${record.operationId.value} identity does not match its first start`,
            'repair or discard the UI runtime journal before restarting',
          );
        }
        const operation = existing ?? {
          operationId: record.operationId,
          taskId: record.taskId,
          executionEpoch: record.executionEpoch,
          input: record.input,
          orchestrated: record.orchestrated === true,
          events: [],
          seq: 0,
        };
        state.operations.set(record.operationId.value, operation);
        state.scopes.set(record.operationId.value, record.scope);
        const startedTask = state.tasks.get(record.taskId.value);
        if (startedTask) startedTask.cycleId = record.scope.cycleId;
        break;
      }
      case 'operation.event': {
        const operation = state.operations.get(record.operationId.value);
        if (!operation) {
          throw new RuntimeTaskControlError(
            'journal.corrupt',
            RUNTIME_OWNER,
            `journal event ${record.event.eventId} references unknown operation ${record.operationId.value}`,
            'repair or discard the UI runtime journal before restarting',
          );
        }
        if (
          record.event.operationId !== record.operationId.value
          || record.event.taskId.value !== operation.taskId.value
          || record.event.executionEpoch !== operation.executionEpoch
        ) {
          throw new RuntimeTaskControlError(
            'journal.corrupt',
            RUNTIME_OWNER,
            `journal event ${record.event.eventId} identity does not match operation ${record.operationId.value}`,
            'repair or discard the UI runtime journal before restarting',
          );
        }
        const task = state.tasks.get(operation.taskId.value);
        if (!task) {
          if (state.deletedTaskIds.has(operation.taskId.value)) break;
          throw new RuntimeTaskControlError(
            'journal.corrupt',
            RUNTIME_OWNER,
            `journal event ${record.event.eventId} references unknown task ${operation.taskId.value}`,
            'repair or discard the UI runtime journal before restarting',
          );
        }
        operation.events.push(record.event);
        operation.seq = Math.max(operation.seq, record.event.seq);
        task.events.push(record.event);
        task.updatedAt = record.event.occurredAt;
        if (record.event.kind === 'execution.started') {
          task.operationId = operation.operationId;
          task.executionEpoch = operation.executionEpoch;
          task.input = operation.input;
          task.orchestrated = operation.orchestrated;
          task.currentNode = RUNTIME_NODE_MARKERS.providerExecute;
        }
        if (record.taskOutput !== undefined) task.output = record.taskOutput;
        if (record.error) task.error = record.error;
        if (record.event.kind === 'provider.tool') task.currentNode = RUNTIME_NODE_MARKERS.providerTool;
        if (record.event.kind === 'provider.model') task.currentNode = RUNTIME_NODE_MARKERS.providerModel;
        break;
      }
      case 'explicit-brain.state': {
        break;
      }
    }
  }
}

/** Durable task projection built only from persisted task Journal records. */
function taskSnapshotFromRecord(record: TaskRecord, scopes: ReadonlyMap<string, ScopeRef>): RuntimeTaskSnapshot {
  const checkpointEvent = record.events.slice().reverse().find((event) => event.kind === 'checkpoint.committed');
  return {
    taskId: record.taskId,
    title: record.title,
    directive: record.directive,
    directiveRevision: record.directiveRevision,
    state: record.state,
    currentState: record.currentState,
    nextStep: record.nextStep,
    updatedAt: record.updatedAt,
    input: record.input,
    output: record.output,
    currentNode: record.currentNode,
    operationId: record.operationId?.value,
    executionEpoch: record.executionEpoch,
    cycleId: record.cycleId?.value
      ?? (record.operationId === undefined ? undefined : scopes.get(record.operationId.value)?.cycleId?.value),
    publicOutput: record.publicOutput,
    orchestrated: record.orchestrated,
    allowedActions: record.allowedActions,
    recentEvents: record.events.slice(-20),
    events: record.events,
    requestIdentity: record.requestIdentity,
    checkpoint: record.checkpoint
      ? {
          checkpointId: record.checkpoint.id.value,
          seq: record.checkpoint.seq,
          outcome: record.checkpoint.outcome,
          summary: record.checkpoint.summary,
          committedAt: checkpointEvent?.occurredAt ?? record.updatedAt,
          evidenceRefs: record.checkpoint.evidenceRefs,
        }
      : undefined,
    error: record.error,
  };
}

export interface DurableTaskInventoryFailure {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
}

export interface DurableTaskInventoryEntry {
  readonly snapshot: RuntimeTaskSnapshot;
  /**
   * `checkpoint` means a real committed checkpoint confirmed the state.
   * `recovery-required` means the durable record alone cannot confirm a live
   * or terminal state; a persisted running event is never treated as live.
   */
  readonly durableState: 'checkpoint' | 'recovery-required';
}

export interface DurableTaskInventory {
  readonly entries: readonly DurableTaskInventoryEntry[];
  readonly failures: readonly DurableTaskInventoryFailure[];
}

/** Minimal read-only checkpoint surface a durable task read needs. */
export interface DurableTaskCheckpointReadPort {
  readLatest(scope: ScopeRef): Promise<LatestCheckpointRecord | null>;
  /**
   * Exact committed checkpoint by identity; supplies the Journal ordering
   * receipt the shared current-state selection uses. Absent means the caller
   * does not bind a current-state read and keeps checkpoint-only behavior.
   */
  readCommitted?(scope: ScopeRef, checkpointId: Checkpoint['id']): Promise<CommittedCheckpointRecord | null>;
}

/** Minimal read-only current-state surface the same shared selection can consume. */
export interface DurableTaskCurrentStateReadPort {
  read(taskScope: ScopeRef): Promise<RuntimeTaskCurrentStateRead>;
}

/**
 * Rebuilds task inventory from task Journal records and reconciles each task's
 * durable state with its authoritative checkpoint. It reuses the coordinator's
 * replay rule and checkpoint scope match but never constructs a coordinator,
 * starts/arms recovery, appends, subscribes or issues a control command. A task
 * whose checkpoint cannot confirm a terminal state stays explicitly
 * `recovery-required` instead of being reported as live running.
 */
export async function projectDurableTaskInventory(input: {
  readonly records: readonly RuntimeTaskJournalRecord[];
  readonly checkpointFor: (taskId: TaskId, cycleId: CycleId) => DurableTaskCheckpointReadPort;
  readonly currentStateFor?: (taskId: TaskId) => DurableTaskCurrentStateReadPort | undefined;
}): Promise<DurableTaskInventory> {
  const state: TaskJournalReplayState = {
    taskCounter: 0,
    operationCounter: 0,
    cycleCounter: 0,
    tasks: new Map(),
    operations: new Map(),
    scopes: new Map(),
    deletedTaskIds: new Set(),
  };
  try {
    replayTaskJournalRecords(state, input.records);
  } catch (error) {
    return {
      entries: [],
      failures: [{
        code: error instanceof RuntimeTaskControlError ? error.code : 'journal.corrupt',
        ownerId: RUNTIME_OWNER,
        message: error instanceof Error ? error.message : String(error),
        nextAction: 'repair or discard the UI runtime journal before reading it',
      }],
    };
  }
  const entries: DurableTaskInventoryEntry[] = [];
  const failures: DurableTaskInventoryFailure[] = [];
  for (const record of state.tasks.values()) {
    const operation = record.operationId === undefined ? undefined : state.operations.get(record.operationId.value);
    const scope = record.operationId === undefined ? undefined : state.scopes.get(record.operationId.value);
    if (!operation || !scope?.cycleId) {
      entries.push({ snapshot: taskSnapshotFromRecord(record, state.scopes), durableState: 'checkpoint' });
      continue;
    }
    try {
      const checkpointRead = input.checkpointFor(record.taskId, scope.cycleId);
      const latest = await checkpointRead.readLatest(scope);
      if (latest && sameCheckpointBusinessScope(scope, latest.checkpoint.scope)) {
        record.checkpoint = latest.checkpoint;
        record.checkpointSeq = latest.checkpoint.seq;
        const committed = checkpointRead.readCommitted
          ? await checkpointRead.readCommitted(latest.checkpoint.scope, latest.checkpoint.id)
          : null;
        const currentStatePort = input.currentStateFor?.(record.taskId);
        const currentStateRead = committed && currentStatePort
          ? await currentStatePort.read(scope)
          : { state: 'unknown' as const, reason: 'no current-state read is bound to this task' };
        const selection = committed && currentStatePort
          ? selectRuntimeTaskCurrentState({
              checkpointOutcome: latest.checkpoint.outcome,
              scope,
              checkpointCommitRef: committed.commitRef,
              currentState: currentStateRead,
            })
          : null;
        record.state = selection?.basis === 'terminal'
          ? selection.lifecycle
          : latest.checkpoint.outcome;
        record.running = false;
        record.stopping = false;
        record.currentState = lifecycleStateLabel(record.state);
        record.nextStep = selection?.basis === 'terminal'
          ? record.state === 'succeeded'
            ? '可发起新的执行或停止'
            : record.state === 'stopped'
              ? '已收拢；可发起新的执行'
              : '检查错误 owner 与 next action'
          : latest.checkpoint.next.kind === 'continue'
          ? '可发起新的执行'
          : `${latest.checkpoint.next.kind}${latest.checkpoint.next.ref ? `:${latest.checkpoint.next.ref}` : ''}`;
        record.allowedActions = record.state === 'succeeded'
          || record.state === 'stopped'
          || record.state === 'failed'
          || record.state === 'cancelled'
          ? ['start']
          : [];
        record.currentNode = record.state === 'stopped'
          ? RUNTIME_NODE_MARKERS.checkpointCommit
          : record.currentNode;
        if (selection?.basis === 'terminal' && currentStateRead.state === 'known') {
          record.currentStateCommitRef = currentStateRead.stateCommitRef;
          if (currentStateRead.value.currentPlan) record.currentPlan = currentStateRead.value.currentPlan;
        }
        record.updatedAt = record.events.at(-1)?.occurredAt ?? record.updatedAt;
        entries.push({ snapshot: taskSnapshotFromRecord(record, state.scopes), durableState: 'checkpoint' });
      } else {
        record.state = 'unknown';
        record.running = false;
        record.stopping = false;
        record.currentState = '需要恢复确认';
        record.nextStep = '从权威 checkpoint 恢复状态';
        record.allowedActions = [];
        entries.push({ snapshot: taskSnapshotFromRecord(record, state.scopes), durableState: 'recovery-required' });
      }
    } catch (error) {
      failures.push({
        code: 'checkpoint.unreadable',
        ownerId: RUNTIME_OWNER,
        message: error instanceof Error ? error.message : String(error),
        nextAction: 'inspect the task checkpoint journal before reading the task',
      });
      record.state = 'unknown';
      record.running = false;
      record.stopping = false;
      record.currentState = '需要恢复确认';
      record.nextStep = '从权威 checkpoint 恢复状态';
      record.allowedActions = [];
      entries.push({ snapshot: taskSnapshotFromRecord(record, state.scopes), durableState: 'recovery-required' });
    }
  }
  return { entries, failures };
}

function providerEventSummary(event: ProviderEvent): string {
  if (event.kind === 'terminal') return `execution ${event.terminalState ?? 'unknown'}`;
  if (event.kind === 'error') return event.error?.message ?? 'provider error';
  if (event.summary) return event.summary;
  if (event.kind === 'output') return '未投影';
  if (event.outputRefs && event.outputRefs.length > 0) return `${event.kind}: ${event.outputRefs.join(', ')}`;
  return event.kind;
}

/** Tools whose successful call writes a file into the bound workspace. */
const FILE_PRODUCING_TOOL_IDS = new Set<string>(['file.write', 'file.edit']);

/**
 * The workspace-relative path a file-producing tool call targets, or undefined
 * for any other call.
 */
function producedFilePath(call: ProviderToolCall | undefined): string | undefined {
  if (call === undefined || !FILE_PRODUCING_TOOL_IDS.has(call.toolId)) return undefined;
  const filePath = call.arguments.file_path;
  return typeof filePath === 'string' && filePath.trim() !== '' ? filePath : undefined;
}

/**
 * The workspace-relative paths an observed execution wrote, in call order and
 * without repeats. Only this narrow set counts as produced material: a read or
 * a search call must never be mistaken for the deliverable.
 */
export function producedArtifactPaths(
  events: Iterable<{ readonly providerEvent?: ProviderEvent }>,
): readonly string[] {
  const paths: string[] = [];
  for (const event of events) {
    const path = producedFilePath(event.providerEvent?.toolCall);
    if (path !== undefined && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * Compose the artifact body handed to the reviewer: what the executor reported
 * plus the produced files themselves, so acceptance criteria about file content
 * can actually be checked.
 */
export function producedArtifactBody(output: string, files: readonly ProducedArtifactFile[]): string {
  if (files.length === 0) return output;
  const sections = files.map((file) => `--- file: ${file.path} ---\n${file.content}`);
  return `${output}\n\n--- produced files ---\n${sections.join('\n')}\n`;
}
function runtimeProviderEventKind(event: ProviderEvent): RuntimeTaskEventKind {
  if (event.kind === 'tool' && event.toolPhase === 'result') return 'provider.tool-result';
  return mapProviderEventKind(event.kind);
}

/**
 * Merges the bound delivery evidence with the existing closure evidence.
 * Evidence identity is the whole canonical ref, so the same source appears once
 * and every distinct source is retained.
 */
function mergeDeliveryEvidence(bound: readonly EvidenceRef[], closure: readonly EvidenceRef[]): EvidenceRef[] {
  const merged: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...bound, ...closure]) {
    const key = canonicalJsonStringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

function appendOutput(current: string, next: string): string {
  return `${current}${next}`;
}

function errorFromUnknown(error: unknown): RuntimeTaskError {
  if (error && typeof error === 'object' && 'providerError' in error) {
    const providerError = (error as { readonly providerError?: ProviderError }).providerError;
    if (providerError) return providerErrorProjection(providerError);
  }
  if (error instanceof RuntimeTaskControlError) {
    return { code: error.code, ownerId: error.ownerId, message: error.message, retryable: false, nextAction: error.nextAction };
  }
  return {
    code: 'runtime.execution.failure',
    ownerId: RUNTIME_OWNER,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    nextAction: 'inspect the runtime error and retry from a new operation',
  };
}

function recoveryProjection(recovery: StopSettlementRecovery): RuntimeTaskError {
  return {
    code: recovery.code,
    ownerId: recovery.ownerId,
    message: recovery.message,
    retryable: recovery.retryable,
    nextAction: recovery.nextAction,
  };
}

class RuntimeContextCommitError extends RuntimeTaskControlError {
  constructor(
    readonly committed: RuntimeContextCommitResult,
    cause: unknown,
  ) {
    const projection = errorFromUnknown(cause);
    super(
      'execution.context-commit-hook.blocked',
      projection.ownerId,
      projection.message,
      projection.nextAction,
    );
  }
}

interface RuntimeExecutionCompositionOptions {
  readonly driver: RuntimeExecutionDriver;
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly checkpointBoundary: ContextCheckpointBoundary;
  readonly now: () => Date;
  readonly hookRegistry?: AgentHookRegistry;
}

const EXECUTION_CAPABILITIES: RuntimeExecutionCapabilities = {
  providerNeutralHarness: { state: 'available', ownerId: RUNTIME_OWNER },
  requestResponseHooks: { state: 'available', ownerId: 'humanagent.runtime.hooks' },
  agentIoRequestLifecycle: {
    state: 'unavailable',
    ownerId: 'humanagent.runtime.agent-io',
    reason: 'UI execution drivers expose normalized provider events, not AgentIo raw response chunks, durable restart budgets, or settlement publication sinks',
  },
  contextCommitReentry: { state: 'available', ownerId: 'humanagent.runtime.checkpoints' },
  checkpointSettlementCancellation: { state: 'available', ownerId: 'humanagent.runtime.control' },
  eventBus: {
    state: 'unavailable',
    ownerId: 'humanagent.runtime.events',
    reason: 'UiRuntimeService does not provide the EventBusPorts journal, registry, or external-operation owner',
  },
};

class ContextCheckpointBoundary {
  constructor(private readonly checkpointStore: TaskCheckpointStore) {}

  async commit(checkpoint: Checkpoint, previous: Checkpoint | null): Promise<RuntimeContextCommitResult> {
    let recordDigest: string | undefined;
    const committer = new ContextCommitter<Checkpoint>({
      commit: async (prepared) => {
        const completed = await completeCheckpoint(this.checkpointStore, {
          ownerId: RUNTIME_OWNER,
          context: {
            scope: prepared.value.scope,
            cycleId: prepared.value.cycleId,
            executionEpoch: prepared.value.executionEpoch,
            directiveRevision: prepared.value.directiveRevision,
          },
          previous,
          checkpoint: prepared.value,
        });
        if (
          completed.receipt.checkpointId.value !== prepared.value.id.value
          || completed.receipt.seq !== prepared.value.seq
        ) {
          throw new RuntimeTaskControlError(
            'checkpoint.commit.receipt.mismatch',
            'humanagent.runtime.checkpoints',
            'checkpoint commit receipt does not match the prepared context',
            'inspect the checkpoint journal and retry the operation',
          );
        }
        recordDigest = completed.receipt.recordDigest;
      },
    });
    const prepared = committer.prepare({
      id: `context-${checkpoint.id.value}`,
      revision: checkpoint.executionEpoch,
      value: checkpoint,
    });
    const committed = await committer.commit(prepared);
    const published = committer.publish(committed);
    return {
      checkpoint: published.value,
      context: published,
      reentry: computeReentryDecision({ outcome: checkpoint.outcome }),
      ...(recordDigest === undefined ? {} : { recordDigest }),
    };
  }
}

class HarnessExecutionComposition implements RuntimeExecutionComposition {
  readonly runtime: AgentRuntime;
  readonly capabilities = EXECUTION_CAPABILITIES;
  private readonly hooks: AgentHookRegistry;

  constructor(private readonly options: RuntimeExecutionCompositionOptions) {
    this.runtime = new AgentRuntime(options.driver, {
      runtimeId: options.runtimeId,
      taskId: options.taskId,
      assignmentId: options.assignmentId,
      organId: options.scope.organId,
      cycleId: options.scope.cycleId,
      operationId: options.operationId,
      executionEpoch: options.executionEpoch,
      ownerRef: RUNTIME_OWNER,
      recoveryRef: `recovery-${options.operationId.value}`,
      waitConditionRef: `recovery-${options.operationId.value}`,
    });
    bindAgentDriver(this.runtime, options.driver);
    this.hooks = options.hookRegistry ?? createHookRegistry(() => undefined, () => options.now().getTime());
  }

  get driver(): RuntimeExecutionDriver {
    return this.options.driver;
  }

  async start(): Promise<AgentHandle> {
    await this.runHook('request.created', 'enter');
    await this.runHook('request.admitted', 'enter');
    await this.runHook('request.before-dispatch', 'enter');
    const handle = await this.runtime.start();
    if (handle.runtimeId !== this.options.runtimeId || handle.executionEpoch !== this.options.executionEpoch) {
      throw new RuntimeTaskControlError(
        'execution.handle.mismatch',
        RUNTIME_OWNER,
        'agent driver returned a handle for another runtime or epoch',
        'reject the adapter response and restart from the owning runtime',
      );
    }
    await this.runHook('request.created', 'exit');
    await this.runHook('request.admitted', 'exit');
    await this.runHook('request.before-dispatch', 'exit');
    await this.runHook('request.dispatched', 'enter');
    await this.runHook('request.dispatched', 'exit');
    return handle;
  }

  async submit(prompt: string): Promise<AgentOutput> {
    await this.runHook('attempt.started', 'enter');
    const output = await this.runtime.submit({ prompt });
    await this.runHook('attempt.started', 'exit');
    return output;
  }

  async *observe(): AsyncIterable<AgentRuntimeObservation> {
    for await (const observation of this.runtime.observe()) {
      if (!observation.accepted) {
        yield observation;
        continue;
      }
      await this.runHook('response.received', 'enter');
      await this.runHook('control.decoded', 'enter');
      yield observation;
      await this.runHook('response.received', 'exit');
      await this.runHook('control.decoded', 'exit');
      await this.runHook('response.decoded', 'enter');
      await this.runHook('response.decoded', 'exit');
    }
  }

  async settle(): Promise<AgentRuntimeClosure> {
    await this.runHook('request.settled', 'enter');
    const closure = await this.runtime.settle();
    await this.runHook('request.settled', 'exit');
    return closure;
  }

  async commitCheckpoint(checkpoint: Checkpoint, previous: Checkpoint | null): Promise<RuntimeContextCommitResult> {
    await this.runHook('result.mapped', 'enter');
    const committed = await this.options.checkpointBoundary.commit(checkpoint, previous);
    try {
      await this.runHook('context.committed', 'enter');
      await this.runHook('context.committed', 'exit');
      await this.runHook('result.mapped', 'exit');
    } catch (error) {
      throw new RuntimeContextCommitError(committed, error);
    }
    return committed;
  }

  checkpointCommitPort(previous: Checkpoint | null): CheckpointCommitPort {
    return {
      commit: async (checkpoint) => {
        try {
          const committed = await this.commitCheckpoint(checkpoint, previous);
          return {
            checkpointId: checkpoint.id,
            committed: true,
            ...(committed.recordDigest === undefined ? {} : { recordDigest: committed.recordDigest }),
          };
        } catch (error) {
          if (error instanceof RuntimeContextCommitError) {
            const recovery = errorFromUnknown(error);
            return {
              checkpointId: error.committed.checkpoint.id,
              committed: true,
              ...(error.committed.recordDigest === undefined ? {} : { recordDigest: error.committed.recordDigest }),
              recovery: {
                code: 'execution.context-commit-hook.blocked',
                ownerId: recovery.ownerId,
                message: recovery.message,
                retryable: recovery.retryable,
                nextAction: recovery.nextAction,
              },
            };
          }
          throw error;
        }
      },
    };
  }

  private async runHook(stage: AgentHookStage, phase: 'enter' | 'exit'): Promise<void> {
    const results = await this.hooks.runStage(stage, {
      requestId: this.options.operationId.value,
      attemptId: `attempt-${this.options.executionEpoch}`,
      sourceRef: `operation/${this.options.operationId.value}`,
      correlation: this.options.operationId.value,
    }, phase);
    const blocked = results.find((result) => result.blocked);
    if (!blocked) return;
    const nextAction = blocked.result.status === 'failed' || blocked.result.status === 'waiting'
      ? blocked.result.nextAction ?? `inspect hook ${blocked.hookId}`
      : `inspect hook ${blocked.hookId}`;
    throw new RuntimeTaskControlError(
      'execution.hook.blocked',
      blocked.result.ownerId ?? blocked.hookId,
      `execution hook ${blocked.hookId} blocked ${stage} ${phase}`,
      nextAction,
    );
  }
}

export class RuntimeTaskCoordinator {
  private readonly now: () => Date;
  private readonly journal?: RuntimeTaskJournalPort;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly operations = new Map<string, OperationRecord>();
  private readonly deletedTaskIds = new Set<string>();
  private readonly publishedAttentions: Attention[] = [];
  private readonly resolvedAttentions: Attention[] = [];
  private taskCounter = 0;
  private readonly taskIdPrefix: string;
  private operationCounter = 0;
  private cycleCounter = 0;
  private readonly activeExecutions = new Set<string>();

  constructor(private readonly options: RuntimeTaskCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.journal = options.journal;
    this.taskIdPrefix = options.taskIdPrefix ?? 'runtime';
    this.replayJournal();
  }

  executionCapabilities(): RuntimeExecutionCapabilities {
    return EXECUTION_CAPABILITIES;
  }

  createTask(input: { readonly title?: string; readonly directive?: string; readonly taskId?: TaskId }): RuntimeTaskSnapshot {
    const title = input.title?.trim() || `任务 ${this.taskCounter + 1}`;
    const directive = input.directive?.trim() || input.title?.trim() || `任务 ${this.taskCounter + 1}`;
    if (input.taskId) {
      const existing = this.tasks.get(input.taskId.value);
      if (existing) {
        if (existing.title !== title || existing.directive !== directive) {
          throw new RuntimeTaskControlError(
            'task.identity.conflict',
            RUNTIME_OWNER,
            'requested task identity already belongs to different task content',
            'inspect the durable requirement dispatch identity',
          );
        }
        return this.snapshot(existing);
      }
    }
    const taskCounter = this.taskCounter + 1;
    const taskId = input.taskId ?? id('task', `ui-task-${this.taskIdPrefix}-${taskCounter}`);
    const timestamp = this.now().toISOString();
    const record: TaskRecord = {
      taskId,
      title,
      directive,
      directiveRevision: 1,
      state: 'created',
      currentState: '已创建',
      nextStep: '选择模式并发起执行',
      input: '',
      output: '',
      currentNode: RUNTIME_NODE_MARKERS.inputReceived,
      createdAt: timestamp,
      updatedAt: timestamp,
      allowedActions: ['start'],
      events: [],
      checkpointSeq: 0,
      orchestrated: false,
      running: false,
      stopping: false,
    };
    this.journal?.append({
      kind: 'task.created',
      taskId,
      title: record.title,
      directive: record.directive,
      directiveRevision: record.directiveRevision,
      createdAt: record.createdAt,
      taskCounter,
    });
    this.taskCounter = taskCounter;
    this.tasks.set(taskId.value, record);
    return this.snapshot(record);
  }

  taskSnapshots(): readonly RuntimeTaskSnapshot[] {
    return [...this.tasks.values()].map((record) => this.snapshot(record));
  }

  updateTask(taskId: TaskId, input: { readonly title?: string; readonly directive?: string }): RuntimeTaskSnapshot {
    const record = this.requireTask(taskId);
    if (record.release?.state === 'prepared' || record.stopping || record.state === 'running' || record.state === 'settling') {
      throw new RuntimeTaskControlError('task.busy', RUNTIME_OWNER, 'running tasks cannot be edited', 'stop the current execution first');
    }
    const title = input.title?.trim() ?? record.title;
    const directive = input.directive?.trim() ?? record.directive;
    if (!title) throw new RuntimeTaskControlError('task.title.required', RUNTIME_OWNER, 'task title cannot be empty', 'provide a task title');
    if (!directive) throw new RuntimeTaskControlError('task.directive.required', RUNTIME_OWNER, 'task directive cannot be empty', 'provide a task directive');
    const updatedAt = this.now().toISOString();
    const directiveRevision = directive === record.directive ? record.directiveRevision : record.directiveRevision + 1;
    this.journal?.append({
      kind: 'task.updated',
      taskId,
      title,
      directive,
      directiveRevision,
      updatedAt,
    });
    record.title = title;
    record.directive = directive;
    record.directiveRevision = directiveRevision;
    record.updatedAt = updatedAt;
    return this.snapshot(record);
  }

  deleteTask(taskId: TaskId): { readonly taskId: TaskId; readonly deleted: true } {
    const record = this.requireTask(taskId);
    if (record.release?.state === 'prepared' || record.stopping || record.state === 'running' || record.state === 'settling') {
      throw new RuntimeTaskControlError('task.busy', RUNTIME_OWNER, 'running tasks cannot be deleted', 'stop the current execution first');
    }
    const deletedAt = this.now().toISOString();
    this.journal?.append({ kind: 'task.deleted', taskId, deletedAt });
    this.deletedTaskIds.add(taskId.value);
    this.tasks.delete(taskId.value);
    return { taskId, deleted: true };
  }

  taskSnapshot(taskId: TaskId): RuntimeTaskSnapshot {
    return this.snapshot(this.requireTask(taskId));
  }

  private taskScopeFor(record: TaskRecord): ScopeRef {
    const scope = record.operationId ? this.scopes.get(record.operationId.value) : undefined;
    if (scope) return { ...scope };
    return {
      organId: this.options.organId,
      taskId: record.taskId,
      ...(record.cycleId === undefined ? {} : { cycleId: record.cycleId }),
    };
  }

  private currentTaskFor(
    record: TaskRecord,
    override?: { readonly title?: string; readonly directive?: string; readonly directiveRevision?: number },
  ): Task {
    return {
      id: record.taskId,
      organId: this.options.organId,
      title: override?.title ?? record.title,
      directive: override?.directive ?? record.directive,
      directiveRevision: override?.directiveRevision ?? record.directiveRevision,
      state: record.state,
      memoryScope: 'task',
    };
  }

  private currentProcessingFor(
    record: TaskRecord,
    facts?: RuntimeTaskCurrentStateFacts,
  ): RuntimeTaskProcessingState {
    const errorRef = record.error ? `${record.error.code}@${record.error.ownerId}` : undefined;
    const firstErrorRef = facts?.turn.firstErrorRef ?? errorRef;
    const laterErrorRefs = [...(facts?.turn.laterErrorRefs ?? [])];
    if (errorRef !== undefined && errorRef !== firstErrorRef && !laterErrorRefs.includes(errorRef)) {
      laterErrorRefs.push(errorRef);
    }
    return {
      entryPhase: facts?.turn.phase ?? record.state,
      nextAction: facts?.turn.nextAction ?? record.checkpoint?.next ?? nextActionForRuntimeState(record.state),
      hardBlockers: record.state === 'blocked' && errorRef !== undefined ? [errorRef] : [],
      recoveryResponsibilityRef: facts?.turn.recoveryResponsibilityRef
        ?? record.error?.ownerId
        ?? facts?.turn.ownerRef
        ?? RUNTIME_OWNER,
      ...(firstErrorRef === undefined ? {} : { firstErrorRef }),
      laterErrorRefs,
      stages: facts?.stages.state === 'known' ? facts.stages.stages : [],
    };
  }

  private currentStateFor(
    record: TaskRecord,
    override?: { readonly title?: string; readonly directive?: string; readonly directiveRevision?: number },
    facts?: RuntimeTaskCurrentStateFacts,
  ): RuntimeTaskCurrentState {
    return {
      task: this.currentTaskFor(record, override),
      processing: this.currentProcessingFor(record, facts),
      // A bound turn recovery record is the actual retained-duty owner. A task
      // with no execution turn has a known-empty set because no turn exists.
      retainedDuties: facts === undefined
        ? []
        : facts.turn.unresolvedOperationRefs.map((operationRef) => ({
            operationRef,
            owner: facts.turn.ownerRef,
          })),
      // The transition is derived from the coordinator's own accepted control
      // state, not from other Journal records. An empty list is the owner's
      // actual known-empty source set and keeps the transition content stable
      // across an exact retry.
      sourceCommitRefs: [],
      ...((facts?.currentPlan ?? record.currentPlan) === undefined ? {} : { currentPlan: facts?.currentPlan ?? record.currentPlan }),
    };
  }

  /**
   * Commit one accepted current-state transition through the owner port. A cold
   * coordinator first recovers the exact committed predecessor from the same
   * Organ Journal instead of assuming there is none. On failure the prior
   * committed receipt stays on the record.
   */
  private async persistCurrentState(
    record: TaskRecord,
    transitionId: string,
    taskScope: ScopeRef,
    override?: { readonly title?: string; readonly directive?: string; readonly directiveRevision?: number },
    facts?: RuntimeTaskCurrentStateFacts,
  ): Promise<JournalCommitRef | undefined> {
    const port = this.options.currentStatePort;
    if (!port) return undefined;
    try {
      const ownerFacts = facts ?? await this.readCurrentStateFacts(record, taskScope);
      let expected = record.currentStateCommitRef ?? null;
      if (expected === null) {
        const current = await port.read(taskScope);
        if (current.state === 'known') {
          record.currentStateCommitRef = current.stateCommitRef;
          record.currentPlan = current.value.currentPlan;
          expected = current.stateCommitRef;
        }
      }
      const ref = await port.commit({
        transitionId,
        taskScope,
        expectedStateCommitRef: expected,
        state: this.currentStateFor(record, override, ownerFacts),
      });
      record.currentStateCommitRef = ref;
      if (ownerFacts?.currentPlan) record.currentPlan = ownerFacts.currentPlan;
      return ref;
    } catch (error) {
      const failure = errorFromUnknown(error);
      record.error = record.error
        ? { ...record.error, cleanupError: failure }
        : failure;
      throw error;
    }
  }

  /**
   * Publish a processing/error/recovery transition without failing the primary
   * control flow. A failed append keeps the prior committed state, stays
   * visible in the task error chain, and does not crash unrelated tasks.
   */
  private async tryPersistCurrentState(
    record: TaskRecord,
    transitionId: string,
    taskScope?: ScopeRef,
    override?: { readonly title?: string; readonly directive?: string; readonly directiveRevision?: number },
    facts?: RuntimeTaskCurrentStateFacts,
  ): Promise<RuntimeTaskError | undefined> {
    if (!this.options.currentStatePort) return undefined;
    try {
      await this.persistCurrentState(
        record,
        transitionId,
        taskScope ?? this.taskScopeFor(record),
        override,
        facts,
      );
      return undefined;
    } catch (error) {
      return errorFromUnknown(error);
    }
  }

  private requiresCurrentStateFacts(record: TaskRecord): boolean {
    return record.operationId !== undefined
      && record.executionEpoch !== undefined
      && record.state !== 'created'
      && (record.state !== 'waiting' || record.driver !== undefined);
  }

  private async readCurrentStateFacts(
    record: TaskRecord,
    taskScope: ScopeRef,
  ): Promise<RuntimeTaskCurrentStateFacts | undefined> {
    if (!this.requiresCurrentStateFacts(record)) return undefined;
    const source = this.options.currentStateFacts;
    if (!source) {
      throw new RuntimeTaskControlError(
        'runtime.current-state.facts-source-unknown',
        RUNTIME_OWNER,
        'the actual Runtime turn/recovery/stage owner is not bound for this execution',
        'bind the AgentLoop turn transition and native-save stage sources before releasing or acknowledging this transition',
      );
    }
    const read = await source.read({
      taskId: record.taskId,
      scope: taskScope,
      ...(record.executionEpoch === undefined ? {} : { executionEpoch: record.executionEpoch }),
    });
    if (read.state === 'unknown') {
      throw new RuntimeTaskControlError(
        'runtime.current-state.facts-unknown',
        RUNTIME_OWNER,
        read.reason,
        'bind the actual Runtime turn/recovery/stage owner before releasing or acknowledging this transition',
      );
    }
    if (read.value.stages.state === 'unknown') {
      throw new RuntimeTaskControlError(
        'runtime.current-state.stages-unknown',
        RUNTIME_OWNER,
        read.value.stages.reason,
        'bind the actual native-save stage owner before releasing or acknowledging this transition',
      );
    }
    return read.value;
  }

  /**
   * Publish the actual logical-turn transition after the AgentLoop owner
   * accepts it. OF3 supplies the `currentStateFacts` source that reads the
   * retained AgentLoop runtime and native-save progress owner.
   */
  async publishCurrentTurnState(taskId: TaskId): Promise<JournalCommitRef | undefined> {
    const record = this.requireTask(taskId);
    const taskScope = this.taskScopeFor(record);
    const facts = await this.readCurrentStateFacts(record, taskScope);
    if (!facts) {
      throw new RuntimeTaskControlError(
        'runtime.current-state.turn-absent',
        RUNTIME_OWNER,
        'task has no execution-backed logical turn to publish',
        'prepare and release an execution before publishing a turn transition',
      );
    }
    const transitionRef = facts.turn.nextAction.ref ?? facts.turn.recoveryResponsibilityRef ?? '';
    const stateDigest = createHash('sha256')
      .update(JSON.stringify(this.currentStateFor(record, undefined, facts))).digest('hex');
    return this.persistCurrentState(
      record,
      `turn:${record.taskId.value}:${record.executionEpoch ?? 0}:${facts.turn.phase}:${facts.turn.nextAction.kind}:${transitionRef}:${stateDigest}`,
      taskScope,
      undefined,
      facts,
    );
  }

  /**
   * Records the request identity the provider binding reported for one request
   * attempt. This is the provider's own report, so the runtime can expose the
   * current turn before the first provider event arrives. A lifecycle report for
   * a task this coordinator does not track is out of scope and is ignored; no
   * identity is ever minted here.
   */
  async recordProviderRequestIdentity(event: ProviderRequestLifecycleEvent): Promise<void> {
    const record = this.tasks.get(event.taskId.value);
    if (!record) return;
    record.requestIdentity = {
      turnId: event.turnId,
      requestId: event.requestId,
      ...(event.parentRequestId === undefined ? {} : { parentRequestId: event.parentRequestId }),
      phase: event.phase,
      occurredAt: event.occurredAt,
    };
  }

  /** Required native ingress, separate from best-effort UI lifecycle projection. */
  async registerNativeProviderRequest(taskId: TaskId, input: Parameters<ActiveTurnContext['registerProviderRequest']>[0]) {
    const context = this.requireActiveTurn(taskId, input.execution);
    if (!context.initialInput()) throw new RuntimeActiveTurnError('active-turn.input.missing', 'native dispatch requires a saved original input');
    return context.registerProviderRequest(input);
  }

  async acceptNativeProviderRawFact(taskId: TaskId, envelope: RawFactEnvelope) {
    return this.requireActiveTurn(taskId, envelope.execution).acceptRawFact(envelope);
  }

  bindNativeProviderProducer(taskId: TaskId, execution: { readonly runtimeId: string; readonly executionEpoch: number }, producer: ActiveTurnProviderProducer): void {
    this.requireActiveTurn(taskId, execution);
    const owner = this.tasks.get(taskId.value)?.captureOwner;
    if (!owner) throw new RuntimeActiveTurnError('active-turn.capture.owner-missing', 'native dispatch requires the Runtime capture owner');
    owner.bindProvider(producer);
  }

  /** Child execution receives only its assignment and its own durable context. */
  async openNativeChildTurn(input: {
    readonly assignment: WorkAssignment;
    readonly scope: ScopeRef;
    readonly runtimeId: string;
  }): Promise<{ readonly context: ActiveTurnContext; readonly capture: ActiveTurnRecoveryCapture }> {
    const record = this.requireTask(input.assignment.taskId);
    const parent = record.activeTurn;
    if (!parent || !this.options.activeTurnJournalFor || !this.options.initialInputStore) {
      throw new RuntimeActiveTurnError('active-turn.child.binding-missing', 'native child requires an admitted parent and a turn-scoped journal factory');
    }
    parent.assertProductionOpen();
    const invocation = parent.childInvocations().find((entry) => entry.invocationId === childInvocationId(input.assignment));
    if (!invocation || invocation.binding.kind !== 'execution'
      || JSON.stringify(invocation.binding.assignment) !== JSON.stringify(input.assignment)) {
      throw new RuntimeActiveTurnError('active-turn.child.invocation-missing', 'native child requires its committed invocation assignment');
    }
    const currentTurnRef = `active-turn://${invocation.childTurnId}/binding`;
    const admittedTurn = produceAdmittedTurn({
      runtime: {
        runtimeId: input.runtimeId,
        executionEpoch: input.assignment.executionEpoch,
        ownerRef: RUNTIME_OWNER,
        permissionRevision: parent.admittedTurn.permissionRevision,
      },
      taskId: input.assignment.taskId,
      scope: input.scope,
      assignment: input.assignment,
      directiveRevision: parent.admittedTurn.directiveRevision,
      turnId: invocation.childTurnId,
      currentTurnRef,
      admissionEvidence: [this.operationScopeEvidence(input.scope, invocation.checkpointReceiptRef)],
      recoveryStateRef: this.operationScopeEvidence(input.scope, `recovery/${invocation.childTurnId}`),
    });
    const binding = {
      admittedTurn, assignment: input.assignment,
      execution: { runtimeId: input.runtimeId, executionEpoch: input.assignment.executionEpoch },
      scope: input.scope,
    };
    const context = await ActiveTurnContext.open({ journal: this.options.activeTurnJournalFor(binding), binding, currentTurnRef });
    await context.registerInitialInput(await this.options.initialInputStore.store({
      binding, bytes: new TextEncoder().encode(input.assignment.objective),
    }));
    const capture = this.createRecoveryCaptureOwner(context);
    record.childTurns ??= new Map();
    record.childTurns.set(input.runtimeId, { context, capture });
    return { context, capture };
  }

  private requireActiveTurn(taskId: TaskId, execution: { readonly runtimeId: string; readonly executionEpoch: number }): ActiveTurnContext {
    const context = this.tasks.get(taskId.value)?.activeTurn;
    if (!context || context.executionIdentity().runtimeId !== execution.runtimeId
      || context.executionIdentity().executionEpoch !== execution.executionEpoch) {
      throw new RuntimeActiveTurnError('active-turn.binding.missing', 'native Provider ingress requires the exact admitted Runtime execution');
    }
    return context;
  }

  prepareExecution(taskId: TaskId, input: {
    readonly prompt: string;
    readonly orchestrate?: boolean;
    readonly operationId?: OperationId;
    /**
     * The typed control selection for this execution. It comes from the actual
     * App/configured selection; the runtime never derives role or agent from a
     * dispatch label, task payload, transcript or metadata. On an exact retry
     * the persisted allocation is the authority: no new identity is minted and
     * a caller-supplied selection must not replace the prepared one.
     */
    readonly role?: AgentRoleDisplay;
    readonly configuredAgentId?: string;
    readonly implicitRequirement?: {
      readonly envelope: RequirementEnvelope;
      readonly admission: RequirementAdmissionReceipt;
    };
  }): RuntimeExecutionAllocation {
    const record = this.requireTask(taskId);
    const prompt = input.prompt.trim();
    if (!prompt) throw new RuntimeTaskControlError('execution.input.required', RUNTIME_OWNER, 'execution input is required', 'provide a non-empty prompt');
    record.originalInput = input.prompt;
    if (input.orchestrate === true && !this.options.createTaskAssembly) {
      throw new RuntimeTaskControlError(
        'orchestration.unavailable',
        RUNTIME_OWNER,
        'orchestration was requested but no task assembly is bound',
        'bind execution, review, and merge orchestration ports before dispatching a confirmed requirement',
      );
    }
    const expectedExecutionEpoch = (record.executionEpoch ?? 0) + 1;
    let operation = input.operationId ? this.operations.get(input.operationId.value) : undefined;
    let scope = operation ? this.scopes.get(operation.operationId.value) : undefined;
    let allocation: RuntimeExecutionAllocation;
    if (operation) {
      if (
        operation.taskId.value !== taskId.value
        || operation.input !== prompt
        || operation.orchestrated !== (input.orchestrate === true)
        || !scope
      ) {
        throw new RuntimeTaskControlError(
          'operation.identity.conflict',
          RUNTIME_OWNER,
          'requested operation identity already belongs to an execution',
          'inspect the durable requirement dispatch identity',
        );
      }
      const persisted = operation.allocation;
      if (persisted === undefined) {
        throw new RuntimeTaskControlError(
          'operation.prepared.missing',
          RUNTIME_OWNER,
          'reused operation has no persisted execution allocation',
          'inspect the durable requirement dispatch identity',
        );
      }
      if (
        persisted.taskId.value !== taskId.value
        || persisted.operationId.value !== operation.operationId.value
        || persisted.executionEpoch !== operation.executionEpoch
        || persisted.scope.taskId?.value !== scope?.taskId?.value
        || persisted.scope.operationId?.value !== operation.operationId.value
        || persisted.directiveRevision !== record.directiveRevision
        || persisted.role !== input.role
        || persisted.configuredAgentId !== input.configuredAgentId
      ) {
        throw new RuntimeTaskControlError(
          'operation.identity.conflict',
          RUNTIME_OWNER,
          'persisted execution allocation does not match the reused operation',
          'inspect the durable requirement dispatch identity',
        );
      }
      allocation = persisted;
      return allocation;
    } else {
      if (record.running || record.release?.state === 'prepared') {
        throw new RuntimeTaskControlError('task.busy', RUNTIME_OWNER, 'task already has an active execution', 'stop the current execution first');
      }
      if (!record.allowedActions.includes('start')) {
        throw new RuntimeTaskControlError('task.not.startable', RUNTIME_OWNER, 'task is not in a state that allows starting an execution', record.nextStep);
      }
      const operationCounter = this.operationCounter + 1;
      const cycleCounter = this.cycleCounter + 1;
      const operationId = input.operationId ?? id('operation', `ui-operation-${operationCounter}`);
      const cycleId = id('cycle', `ui-cycle-${cycleCounter}`);
      const executionEpoch = expectedExecutionEpoch;
      const execScope: ScopeRef = Object.freeze({ organId: this.options.organId, taskId, cycleId, operationId });
      scope = execScope;
      const startedAt = this.now().toISOString();
      operation = {
        operationId,
        taskId,
        executionEpoch,
        input: prompt,
        orchestrated: input.orchestrate === true,
        events: [],
        seq: 0,
      };
      allocation = Object.freeze({
        runtimeId: this.runtimeId(operationId),
        taskId,
        operationId,
        executionEpoch,
        assignmentId: `assignment-${operationId.value}`,
        scope: execScope,
        inputRefs: Object.freeze([`task://${taskId.value}/input/${operationCounter}`]),
        ownerId: RUNTIME_OWNER,
        directiveRevision: record.directiveRevision,
        inputRevision: record.inputRevisionState?.revisions.at(-1)?.inputRevision ?? record.directiveRevision,
        orchestrated: input.orchestrate === true,
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.configuredAgentId === undefined ? {} : { configuredAgentId: input.configuredAgentId }),
      });
      operation.allocation = allocation;
      record.allocation = allocation;
      this.journal?.append({
        kind: 'operation.prepared',
        allocation,
        input: prompt,
        operationCounter,
        cycleCounter,
      });
      this.journal?.append({
        kind: 'operation.started',
        operationId,
        taskId,
        cycleId,
        scope,
        executionEpoch,
        operationCounter,
        cycleCounter,
        startedAt,
        input: prompt,
        ...(operation.orchestrated ? { orchestrated: true } : {}),
      });
      this.operationCounter = operationCounter;
      this.cycleCounter = cycleCounter;
      this.operations.set(operationId.value, operation);
      this.scopes.set(operationId.value, scope);
    }

    record.release = { state: 'prepared' };
    record.releasePending = undefined;
    record.runtime = undefined;
    record.driver = undefined;
    record.running = false;
    record.stopping = false;
    record.executionReady = new Promise<boolean>((resolve) => {
      record.resolveExecutionReady = resolve;
    });
    record.state = 'waiting';
    record.currentState = '等待执行准入';
    record.currentNode = RUNTIME_NODE_MARKERS.providerExecute;
    record.input = operation.input;
    record.output = '';
    record.publicOutput = undefined;
    record.operationId = operation.operationId;
    record.executionEpoch = operation.executionEpoch;
    record.cycleId = scope?.cycleId;
    record.checkpoint = undefined;
    record.checkpointSeq = 0;
    record.composition = undefined;
    record.checkpointBoundary = undefined;
    record.taskAssembly = undefined;
    record.implicitRequirement = input.implicitRequirement;
    record.nextStep = '完成执行注册与覆盖后释放';
    record.allowedActions = ['stop'];
    record.error = undefined;
    record.orchestrated = operation.orchestrated;
    record.updatedAt = this.now().toISOString();
    return allocation;
  }

  /** Compatibility entry: allocates synchronously; it does not acknowledge release. */
  startExecution(
    taskId: TaskId,
    input: Parameters<RuntimeTaskCoordinator['prepareExecution']>[1],
  ): { readonly operationId: OperationId; readonly executionEpoch: number } {
    const allocation = this.prepareExecution(taskId, input);
    void this.releaseExecution(taskId, allocation.operationId).catch(() => {});
    return { operationId: allocation.operationId, executionEpoch: allocation.executionEpoch };
  }

  /** Await this entry before reporting release. Admission and factory each run once. */
  releaseExecution(taskId: TaskId, operationId: OperationId): Promise<RuntimeExecutionRelease> {
    const record = this.requireTask(taskId);
    const operation = this.operations.get(operationId.value);
    if (!operation?.allocation || record.operationId?.value !== operationId.value
      || operation.taskId.value !== taskId.value) {
      throw new RuntimeTaskControlError('operation.prepared.missing', RUNTIME_OWNER, 'execution allocation is not current for this task', 'prepare this task execution first');
    }
    if (record.releasePending) return record.releasePending;
    if (record.stopping || record.release?.state !== 'prepared') {
      throw new RuntimeTaskControlError('execution.not.releasable', RUNTIME_OWNER, 'execution is no longer prepared for release', record.nextStep);
    }
    record.executionReady = new Promise<boolean>((resolve) => { record.resolveExecutionReady = resolve; });
    record.error = undefined;
    const pending = new Promise<RuntimeExecutionRelease>((resolve, reject) => {
      record.resolveRelease = resolve;
      record.rejectRelease = reject;
    });
    record.releasePending = pending;
    void this.runExecution(record, operation, operation.allocation.scope, operation.input, operation.allocation);
    return pending;
  }

  private markExecutionReleased(record: TaskRecord, operation: OperationRecord): void {
    record.release = { state: 'released' };
    record.running = true;
    record.state = 'running';
    record.currentState = '运行中';
    record.nextStep = '等待 Provider 事件';
    this.activeExecutions.add(operation.operationId.value);
    this.pushEvent(record, operation, 'execution.started', 'running', 'execution admitted and released', []);
    record.resolveRelease?.(record.release);
    record.resolveRelease = undefined;
    record.rejectRelease = undefined;
  }

  /**
   * Cold callers select retained business identity only; every control fact
   * (source, grant, incarnation config, original-turn stage, native composition)
   * is supplied by the bound owners. This is a selector, not a second prepare.
   */
  resumeExecution(
    taskId: RuntimeExecutionAllocation['taskId'],
    operationId: RuntimeExecutionAllocation['operationId'],
    request: RuntimeColdExecutionResumeRequest,
  ): Promise<RuntimeExecutionRelease> {
    return resumeColdExecution({
      tasks: this.tasks,
      operations: this.operations,
      producer: this.options.coldExecution,
      lifecycle: this.coldLifecycle(),
    }, taskId, operationId, request);
  }

  private createProviderExecutionAgent(
    execute: ExecutionAgentPort['execute'],
  ): ExecutionAgentPort {
    return {
      roleId: 'humanagent.ui-runtime.provider-execution',
      createInstance: (create) => ({ incarnation: create.incarnation, execute, dispose: async () => {} }),
      execute,
    };
  }

  /** Runtime owns the same actual lifecycle and resource transfer for cold resumes. */
  private coldLifecycle(): ColdExecutionLifecycleBinding {
    return {
      assemblyFor: (record, operation, scope) => this.coldAssemblyFor(record, operation, scope),
      releaseToLifecycle: (record, operation, prepared) => this.releaseColdToLifecycle(record, operation, prepared),
    };
  }

  /**
   * Reuses the retained assembly when it exists; otherwise builds one through
   * the same real factory and shared provider-execution executor. It never
   * mints a second pool or a hollow executor.
   */
  private coldAssemblyFor(record: TaskRecord, operation: OperationRecord, scope: ScopeRef): RuntimeTaskAssembly {
    if (record.taskAssembly) return record.taskAssembly;
    if (!this.options.createTaskAssembly) {
      throw new RuntimeTaskControlError(
        'orchestration.unavailable',
        RUNTIME_OWNER,
        'cold execution resume requires the task assembly factory',
        'bind execution, review, and merge orchestration ports before resuming',
      );
    }
    const assembly = this.options.createTaskAssembly({
      task: this.currentTaskFor(record),
      scope,
      checkpointJournal: this.options.checkpointStoreFor(record.taskId, scope.cycleId!),
      // The cold module acquires the retained instance from this assembly, and
      // the retained-handle dispatch executes through that acquired handle. So
      // the shared executor here is the real resumed-attempt driver, not a
      // hollow placeholder.
      executionAgent: this.createProviderExecutionAgent(
        (input) => this.executeResumedProviderAttempt(record, operation, scope, input),
      ),
      maxAttempts: 1,
    });
    record.taskAssembly = assembly;
    return assembly;
  }

  private releaseColdToLifecycle(
    record: TaskRecord,
    operation: OperationRecord,
    prepared: PreparedColdExecution,
  ): Promise<RuntimeExecutionRelease> {
    return prepared.kind === 'generation-ready'
      ? this.runResumedGeneration(record, operation, prepared)
      : this.finishColdBoundary(record, operation, prepared);
  }

  private coldScopeFor(operation: OperationRecord): ScopeRef {
    const scope = operation.allocation?.scope ?? this.scopes.get(operation.operationId.value);
    if (!scope) {
      throw new RuntimeTaskControlError(
        'operation.scope.missing',
        RUNTIME_OWNER,
        'cold resume has no retained execution scope',
        'resolve the exact retained operation allocation before resuming',
      );
    }
    this.scopes.set(operation.operationId.value, scope);
    return scope;
  }

  /**
   * Generation branch. It reuses the already-acquired handle/lease/incarnation
   * and the original business assignment, dispatches through the retained-handle
   * manager entry (no second acquire, no new assignment, no retry begin), then
   * runs the same canonical turn tail as the normal lane. The acquired lease is
   * released exactly once here, whatever the outcome.
   */
  private async runResumedGeneration(
    record: TaskRecord,
    operation: OperationRecord,
    prepared: Extract<PreparedColdExecution, { kind: 'generation-ready' }>,
  ): Promise<RuntimeExecutionRelease> {
    const scope = this.coldScopeFor(operation);
    const assembly = prepared.assembly;
    record.taskAssembly = assembly;
    // Bind the real resumed driver before dispatch: the retained handle the
    // cold module already acquired executes through the assembly's shared
    // executor, which resolves the driver from this record instead of a second
    // acquire or a stale placeholder.
    record.driver = prepared.driver;
    this.bindChildCallManager(prepared.driver, assembly);
    const assignment = prepared.source.assignment;
    const stageNodeId = `stage-${operation.operationId.value}`;
    record.currentNode = RUNTIME_NODE_MARKERS.orchestrationPlan;
    record.nextStep = '编排执行、审查并合并';
    this.markExecutionReleased(record, operation);
    let failure: unknown;
    try {
      assembly.orchestration.planStage({ nodeId: stageNodeId, taskId: record.taskId });
      const dispatchInput: DispatchInput = {
        stageNodeId,
        assignment,
        agentId: 'humanagent.provider-execution',
        scope,
        reviewKinds: ['quality'],
      };
      const dispatched = await assembly.orchestration.dispatchAcquired(dispatchInput, prepared.acquired);
      // C3 accepts the completed review receipts on the retained turn before
      // the native close. Late reviews that land after the close stay the first
      // error; the frozen closure is never rewritten to claim completion.
      await prepared.driver.standardTurn.acceptReviews(dispatched.reviewCommitRefs ?? []);
      if (record.stopping || record.postCommitRecoveryPending || record.state === 'stopped') {
        return { state: 'released' };
      }
      if (dispatched.status !== 'merged' && dispatched.status !== 'succeeded') {
        const problem = dispatched.issue;
        throw new RuntimeTaskControlError(
          'orchestration.dispatch.failed',
          problem?.ownerId ?? RUNTIME_OWNER,
          problem?.reason ?? `resumed orchestration dispatch ended as ${dispatched.status}`,
          problem ? `${problem.nextAction.kind}${problem.nextAction.ref ? `:${problem.nextAction.ref}` : ''}` : 'inspect orchestration assignment',
        );
      }
      record.running = false;
      record.currentState = '收拢中';
      record.nextStep = '等待 checkpoint';
      record.allowedActions = [];
      await this.completeStandardTurn({
        record,
        operation,
        scope,
        standardTurn: prepared.driver.standardTurn,
        expectedExecutionEpoch: prepared.acquired.lease.executionEpoch,
        closeOwned: async () => {
          const closure = record.resumedClosure;
          if (!closure) {
            throw new RuntimeTaskControlError('turn.closure.missing', RUNTIME_OWNER,
              'cold resume settled without a provider closure to close',
              'inspect the resumed provider execution');
          }
          const close = await this.closeForExecution(operation.operationId, prepared.driver, closure.evidenceRefs);
          if (close.state !== 'closed') {
            throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER,
              `provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'inspect provider close evidence');
          }
        },
      });
      return { state: 'released' };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await this.releaseColdLease(prepared, scope);
      } catch (cleanup) {
        if (failure !== undefined) {
          throw new AggregateError([failure, cleanup],
            'cold generation failed and its retained lease release also failed');
        }
        throw cleanup;
      }
    }
  }

  /**
   * Boundary branch. The historical boundary retains its exact physical
   * binding; only the real `finishBoundary` completes the remaining retained
   * phases, then the same canonical tail aligns and applies acceptance. No new
   * execution generation, driver, start/observe/settle is created.
   */
  private async finishColdBoundary(
    record: TaskRecord,
    operation: OperationRecord,
    prepared: Extract<PreparedColdExecution, { kind: 'exact-pending-boundary' | 'committed-close-alignment' }>,
  ): Promise<RuntimeExecutionRelease> {
    const scope = this.coldScopeFor(operation);
    await prepared.finishBoundary();
    record.running = false;
    record.currentState = '收拢中';
    record.nextStep = '等待 checkpoint';
    record.allowedActions = [];
    await this.completeStandardTurn({
      record,
      operation,
      scope,
      standardTurn: prepared.standardTurn,
      expectedExecutionEpoch: prepared.execution.executionEpoch,
      // `finishBoundary` already completed the once-owned native/Provider close.
      closeOwned: async () => {},
    });
    return { state: 'released' };
  }

  /**
   * The retained handle executes through the assembly's shared executor. It
   * binds the real resumed driver (installed by the generation lane before
   * dispatch) and runs the same provider attempt body as the normal lane, so
   * the physical report, checkpoint and context all use the real new binding.
   */
  private async executeResumedProviderAttempt(
    record: TaskRecord,
    operation: OperationRecord,
    scope: ScopeRef,
    input: Parameters<ExecutionAgentPort['execute']>[0],
  ): Promise<WorkResult> {
    const driver = record.driver;
    if (!driver) {
      throw new RuntimeTaskControlError(
        'execution.cold.driver.missing',
        RUNTIME_OWNER,
        'cold resume reached its retained handle without the resumed driver binding',
        'resume through the coordinator so the retained handle drives the execution',
      );
    }
    const lease = input.lease;
    const checkpointBoundary = new ContextCheckpointBoundary(
      this.options.checkpointStoreFor(record.taskId, scope.cycleId!),
    );
    record.checkpointBoundary = checkpointBoundary;
    const composition = new HarnessExecutionComposition({
      driver,
      runtimeId: lease.runtimeId,
      taskId: record.taskId,
      assignmentId: input.assignment.assignmentId,
      operationId: operation.operationId,
      executionEpoch: lease.executionEpoch,
      scope,
      checkpointBoundary,
      now: this.now,
      hookRegistry: this.options.hookRegistry,
    });
    record.composition = composition;
    record.driver = driver;
    record.runtime = composition.runtime;
    const outputRef = `operation://${operation.operationId.value}/output`;
    const attempt = await this.executePreparedProviderAttempt(
      record,
      operation,
      scope,
      operation.input,
      outputRef,
      input,
      this.providerAttemptReport(input, input.assignment.attempt, lease.executionEpoch),
      composition,
      composition.runtime,
    );
    record.resumedClosure = attempt.closure;
    return attempt.result;
  }

  /** Owned lease release runs exactly once at the cold endpoint. */
  private async releaseColdLease(
    prepared: Extract<PreparedColdExecution, { kind: 'generation-ready' }>,
    scope: ScopeRef,
  ): Promise<void> {
    const released = await prepared.assembly.runtimePool.release(prepared.acquired.lease, { scope });
    if (released.status === 'blocked') {
      throw new RuntimeTaskControlError(released.issue.code, released.issue.ownerId,
        released.issue.reason, released.issue.nextAction.kind);
    }
  }

  /**
   * The canonical turn tail shared by the normal executed lane and a cold
   * resumed lane. It adopts the real closing checkpoint (never a generic
   * business checkpoint), closes the once-owned Provider, aligns the retained
   * turn, applies acceptance/disposition, and admits the next standard turn only
   * when the retained turn advances.
   */
  private async completeStandardTurn(input: {
    readonly record: TaskRecord;
    readonly operation: OperationRecord;
    readonly scope: ScopeRef;
    readonly standardTurn: NonNullable<RuntimeExecutionDriver['standardTurn']>;
    readonly expectedExecutionEpoch: number;
    readonly closeOwned: () => Promise<void>;
  }): Promise<AdvanceTurnResult> {
    const { record, operation, scope, standardTurn } = input;
    const committed = await standardTurn.readCheckpoint();
    if (committed.checkpoint.scope.operationId?.value !== operation.operationId.value
      || committed.checkpoint.executionEpoch !== input.expectedExecutionEpoch) {
      throw new RuntimeTaskControlError('turn.checkpoint.conflict', RUNTIME_OWNER,
        'canonical closing checkpoint belongs to another execution', 'resolve the exact turn checkpoint');
    }
    record.checkpoint = committed.checkpoint;
    record.checkpointSeq = committed.checkpoint.seq;
    this.pushEvent(record, operation, 'checkpoint.committed', committed.checkpoint.outcome,
      committed.checkpoint.summary, committed.checkpoint.evidenceRefs);
    await input.closeOwned();
    const advance = await standardTurn.align();
    // The direct native lane owns its public result through the typed accepted
    // delivery. Commit and read it back through the same public-output owner
    // before the turn is accepted as succeeded, so a drain/empty turn can never
    // finish as a success with no delivered body. The orchestrated lane keeps
    // its existing WorkResult delivery binding (`bindAssignmentDelivery`).
    if (!operation.orchestrated && advance.state === 'terminal' && advance.decision === 'complete') {
      await this.commitStandardTurnDelivery(record, operation, scope, standardTurn);
    }
    await this.applyStandardTurnAdvance(record, operation, scope, advance);
    if (advance.state === 'advancing') await this.startNextStandardTurn(record, operation, advance);
    return advance;
  }

  /**
   * Accepts the delivery of a terminal `complete` native turn.
   *
   * A refs-only accepted end (no declared `deliveryText`) must bind its real
   * material bundle to the retained assignment through the existing
   * assignment-level binder: the bundle is non-empty and its business-turn
   * identity, artifact refs, digests, bodies and evidence all agree with the
   * original readback assignment. That binding is the whole delivery gate, so
   * the turn completes without synthesizing any public text.
   *
   * When the accepted end does declare a `deliveryText`, the exact accepted
   * text is published through the canonical public-output owner: the reader
   * exposes exactly one text material bound to this operation/epoch, the
   * immutable body equals the accepted text, and the committed publication
   * reads the exact text back. Only after that does the caller accept
   * succeeded/final. Any failure stops the turn with a specific typed error; it
   * never downgrades to a drain/summary fallback.
   */
  private async commitStandardTurnDelivery(
    record: TaskRecord,
    operation: OperationRecord,
    scope: ScopeRef,
    standardTurn: NonNullable<RuntimeExecutionDriver['standardTurn']>,
  ): Promise<void> {
    if (standardTurn.readDelivery === undefined) {
      throw new RuntimeTaskControlError('standard-turn-delivery.unavailable', RUNTIME_OWNER,
        'the native standard turn exposes no readDelivery capability to publish its exact body',
        'assemble the runtime delivery reader before accepting a terminal complete turn');
    }
    const readback = await standardTurn.readDelivery();
    // A refs-only accepted end declares no `deliveryText`. Bind its real
    // material bundle to the retained assignment through the existing
    // assignment-level binder (non-empty materials, business-turn identity,
    // artifact refs/digests/bodies and evidence) against the original readback
    // assignment; that binding is the whole gate and generates no public text.
    // The assignment is never rebuilt from the current physical epoch.
    if (readback.acceptedEnd.deliveryText === undefined) {
      bindAssignmentDelivery({ assignment: readback.assignment, readback });
      return;
    }
    const textMaterials = readback.materials.filter((material) => material.kind === 'delivery-text');
    if (textMaterials.length !== 1) {
      throw new RuntimeTaskControlError('standard-turn-delivery.text-unresolved', RUNTIME_OWNER,
        `the accepted turn exposes ${textMaterials.length} text deliveries, expected exactly one`,
        'resolve the single accepted text delivery before accepting a terminal complete turn');
    }
    const material = textMaterials[0]!;
    if (material.kind !== 'delivery-text') {
      throw new RuntimeTaskControlError('standard-turn-delivery.text-unresolved', RUNTIME_OWNER,
        'the accepted turn delivery is not a text delivery',
        'resolve the accepted text delivery before accepting a terminal complete turn');
    }
    const endCall = material.acceptedEndCall.envelope.fact;
    if (endCall.kind !== 'tool-call'
      || material.acceptedEndCall.envelope.execution.executionEpoch !== operation.executionEpoch
      || material.acceptedEndCall.envelope.request.requestId.length === 0
      || canonicalJsonStringify(material.acceptedEndCall.envelope.scope) !== canonicalJsonStringify(scope)) {
      throw new RuntimeTaskControlError('standard-turn-delivery.source-conflict', RUNTIME_OWNER,
        'the accepted delivery source does not belong to the completing execution',
        'resolve the delivery bound to this exact operation and epoch');
    }
    const exactText = new TextDecoder('utf-8', { fatal: true }).decode(material.bytes);
    if (exactText !== readback.acceptedEnd.deliveryText) {
      throw new RuntimeTaskControlError('standard-turn-delivery.text-mismatch', RUNTIME_OWNER,
        'the immutable delivery body does not equal the accepted delivery text',
        'resolve the immutable body bound to the accepted delivery text');
    }
    const storeFor = this.options.publicOutputStoreFor;
    if (storeFor === undefined) {
      throw new RuntimeTaskControlError('public-output.store-unbound', RUNTIME_OWNER,
        'the native standard turn exposes no canonical public-output store',
        'bind the canonical public-output store before accepting a terminal complete turn');
    }
    const cycleId = scope.cycleId;
    if (cycleId === undefined) {
      throw new RuntimeTaskControlError('public-output.cycle-missing', RUNTIME_OWNER,
        'the accepted delivery scope carries no cycle identity',
        'resolve the execution cycle before accepting a terminal complete turn');
    }
    const binding = this.publicOutputSelection(scope, operation.executionEpoch);
    const candidate: PublicOutputCandidate = {
      binding,
      sourceId: `standard-turn-delivery:${material.acceptedEndCall.envelope.request.requestId}:${endCall.call.callId}`,
      text: exactText,
    };
    record.publicOutput = this.pendingPublicOutput(record.publicOutput);
    const committedText = await (async (): Promise<string> => {
      const store = storeFor(record.taskId, cycleId);
      const committed = await store.commitPublicOutput(candidate);
      const publication = await store.readPublicOutputs(binding);
      record.publicOutput = publication;
      const match = publication.commits.find((commit) =>
        commit.ref.sourceId === candidate.sourceId && commit.text === exactText);
      if (match === undefined || match.ref.commitId !== committed.commitId) {
        throw new RuntimeTaskControlError('public-output.readback-mismatch', RUNTIME_OWNER,
          'the canonical public output did not read back the exact committed delivery text',
          'inspect the canonical public-output journal for this binding');
      }
      return exactText;
    })().catch((error: unknown) => {
      record.publicOutput = this.unknownPublicOutput(record.publicOutput);
      if (error instanceof RuntimeTaskControlError) throw error;
      throw new RuntimeTaskControlError('public-output.commit-failed', RUNTIME_OWNER,
        error instanceof Error ? error.message : String(error),
        'inspect the canonical public-output journal and retry the same accepted delivery');
    });
    // The user-visible output is the exact committed delivery body, not the
    // Provider drain/summary process text.
    record.output = committedText;
  }

  /**
   * Recovers the retained standard turn of a task that already settled: it
   * closes the owned Provider, aligns the frozen turn and applies the
   * acceptance/disposition. It reuses the same canonical tail body.
   */
  async recoverStandardTurn(taskId: TaskId): Promise<AdvanceTurnResult> {
    const record = this.requireTask(taskId);
    const driver = record.driver;
    const operation = record.operationId ? this.operations.get(record.operationId.value) : undefined;
    const scope = operation ? this.scopes.get(operation.operationId.value) : undefined;
    if (!driver?.standardTurn || !operation || !scope || record.running || record.stopping) {
      throw new RuntimeTaskControlError('turn.recovery.unavailable', RUNTIME_OWNER,
        'no settled retained standard turn is available', 'resolve the actual turn owner before recovery');
    }
    return this.completeStandardTurn({
      record,
      operation,
      scope,
      standardTurn: driver.standardTurn,
      expectedExecutionEpoch: operation.executionEpoch,
      closeOwned: async () => {
        const close = await this.closeForExecution(operation.operationId, driver, []);
        if (close.state !== 'closed') {
          throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER,
            `provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'inspect provider close evidence');
        }
      },
    });
  }

  private async applyStandardTurnAdvance(record: TaskRecord, operation: OperationRecord, scope: ScopeRef,
    advance: AdvanceTurnResult): Promise<void> {
    if (!advance.admission || !advance.alignment || (advance.state !== 'advancing' && advance.state !== 'terminal')) {
      throw new RuntimeTaskControlError('turn.alignment.pending', RUNTIME_OWNER,
        advance.reason, 'recover alignment on the same logical turn');
    }
    const state = advance.state === 'advancing' ? 'waiting' : advance.decision === 'complete' ? 'succeeded' : 'failed';
    record.state = state;
    record.running = false;
    record.error = undefined;
    await this.persistCurrentState(record,
      `turn-aligned:${record.taskId.value}:${operation.operationId.value}:${advance.alignment.planRevisionId}`, scope);
    this.pushEvent(record, operation, 'execution.terminal', state, advance.reason,
      record.checkpoint?.evidenceRefs ?? [], undefined, undefined, undefined, undefined, 'final');
    this.finalize(record, state);
    if (advance.state === 'advancing') {
      record.allowedActions = ['start'];
    }
  }

  private async startNextStandardTurn(record: TaskRecord, operation: OperationRecord, advance: AdvanceTurnResult) {
    if (advance.state !== 'advancing' || !advance.admission || advance.decision !== 'continue') {
      throw new RuntimeTaskControlError('turn.advance.denied', RUNTIME_OWNER,
        'next turn has no durable continue admission', 'resolve the existing turn admission');
    }
    try {
      // The old execution's release/finally must finish before normal prepare
      // installs the next operation's pending release on this same Task record.
      this.startExecution(record.taskId, { prompt: operation.input, orchestrate: operation.orchestrated,
        ...(operation.allocation?.role === undefined ? {} : { role: operation.allocation.role }),
        ...(operation.allocation?.configuredAgentId === undefined ? {} : { configuredAgentId: operation.allocation.configuredAgentId }) });
    } catch (error) {
      record.error = errorFromUnknown(error);
      record.state = 'blocked';
      record.running = false;
      record.allowedActions = [];
      record.nextStep = record.error.nextAction;
      await this.tryPersistCurrentState(record,
        `turn-advance-pending:${record.taskId.value}:${operation.operationId.value}:${record.error.code}`, this.taskScopeFor(record));
    }
  }

  /**
   * Appends a confirmed `append`/`change` requirement as this task's next input
   * revision. `appendTaskRevision` (packages/runtime/src/admission) is the single
   * owner of the append-without-overwrite rule; this method only supplies the
   * task-scoped monotonic revision (the interaction's `inputRevision` is
   * per-interaction, not per-task) and retains its decision. Re-dispatching the
   * same confirmed requirement is idempotent and never appends a second copy.
   */
  appendTaskInput(taskId: TaskId, envelope: RequirementEnvelope): TaskUpdateDecision {
    const record = this.requireTask(taskId);
    if (envelope.taskRef?.value !== taskId.value) {
      throw new RuntimeTaskControlError(
        'task.input.ref-mismatch',
        RUNTIME_OWNER,
        'confirmed intent does not name this task',
        `resubmit the append against task ${taskId.value}`,
      );
    }
    const existing = record.inputRevisionState?.revisions.find(
      (revision) => revision.envelope.requirementId === envelope.requirementId,
    );
    if (existing) {
      return {
        status: 'updated',
        taskId,
        task: record.inputRevisionState!,
        revision: existing.inputRevision,
        ownerId: RUNTIME_OWNER,
        condition: 'task.input.appended',
        nextAction: { kind: 'continue', ref: 'task.input.dispatch' },
        reason: 'task input revision already appended',
      };
    }
    const previous = record.inputRevisionState?.revisions.at(-1);
    const inputRevision = (previous?.inputRevision ?? 0) + 1;
    const decision = appendTaskRevision({
      ...(record.inputRevisionState ? { task: record.inputRevisionState } : {}),
      envelope: { ...envelope, inputRevision },
      ownerId: RUNTIME_OWNER,
    });
    if (decision.status !== 'updated') {
      throw new RuntimeTaskControlError(
        decision.condition ?? 'task.input.blocked',
        decision.ownerId,
        decision.reason,
        `${decision.nextAction.kind}${decision.nextAction.ref ? `:${decision.nextAction.ref}` : ''}`,
      );
    }
    record.inputRevisionState = decision.task;
    record.updatedAt = this.now().toISOString();
    return decision;
  }

  /**
   * The oldest appended input revision that an execution cycle has not consumed
   * yet, or `undefined` when the task's input mailbox is drained. Independent
   * of the interaction-level `inputRevision`, this reflects the task's own
   * input sequence so FIFO order is preserved across multiple appends.
   */
  pendingTaskInput(taskId: TaskId): TaskRevision | undefined {
    const record = this.requireTask(taskId);
    const consumed = record.consumedInputRevision ?? 0;
    return record.inputRevisionState?.revisions.find((revision) => revision.inputRevision > consumed);
  }

  consumeTaskInput(taskId: TaskId, inputRevision: number): void {
    const record = this.requireTask(taskId);
    if (inputRevision < (record.consumedInputRevision ?? 0)) return;
    record.consumedInputRevision = inputRevision;
  }

  exportTaskInputRevisions(): readonly {
    readonly taskId: TaskId;
    readonly state: TaskRevisionState;
    readonly consumedInputRevision?: number;
  }[] {
    return [...this.tasks.values()]
      .filter((record) => record.inputRevisionState !== undefined)
      .map((record) => ({
        taskId: record.taskId,
        state: structuredClone(record.inputRevisionState!),
        ...(record.consumedInputRevision === undefined ? {} : { consumedInputRevision: record.consumedInputRevision }),
      }));
  }

  restoreTaskInputRevisions(entries: readonly {
    readonly taskId: TaskId;
    readonly state: TaskRevisionState;
    readonly consumedInputRevision?: number;
  }[]): void {
    for (const entry of entries) {
      const record = this.tasks.get(entry.taskId.value);
      if (!record) continue;
      record.inputRevisionState = entry.state;
      if (entry.consumedInputRevision !== undefined) record.consumedInputRevision = entry.consumedInputRevision;
    }
  }

  async stop(taskId: TaskId): Promise<{ readonly state: string; readonly operationId?: string }> {
    const record = this.requireTask(taskId);
    if ((!record.running && record.release?.state !== 'prepared') || record.stopping || !record.operationId || !record.executionEpoch) {
      throw new RuntimeTaskControlError('task.not.running', RUNTIME_OWNER, 'task has no running execution to stop', 'start an execution first');
    }
    record.stopping = true;
    if (record.release?.state === 'prepared' && !record.releasePending) {
      await this.stopPreparedExecution(record, this.operations.get(record.operationId.value)!);
    }
    const executionReady = await record.executionReady;
    if (!executionReady) {
      if (record.state === 'stopped') return { state: 'stopped', operationId: record.operationId.value };
      throw new RuntimeTaskControlError('task.not.running', RUNTIME_OWNER, 'execution ended before stop control could start', 'start an execution first');
    }
    if (!record.running || !record.runtime || !record.driver || !record.composition || !record.operationId || !record.executionEpoch) {
      throw new RuntimeTaskControlError('task.not.running', RUNTIME_OWNER, 'execution ended before stop control could start', 'start an execution first');
    }
    const operation = this.operations.get(record.operationId.value);
    if (!operation) throw new RuntimeTaskControlError('operation.missing', RUNTIME_OWNER, 'running operation record is missing', 'start a new execution');
    // Recover the actual cycle id from the operation scope captured at start.
    const activeScope = this.scopes.get(record.operationId.value);
    if (!activeScope) throw new RuntimeTaskControlError('operation.scope.missing', RUNTIME_OWNER, 'running operation scope is missing', 'start a new execution');
    this.pushEvent(record, operation, 'execution.settling', 'settling', 'stop requested; settling', []);
    record.state = 'settling';
    record.currentState = '收拢中';
    record.nextStep = '等待 stopped checkpoint';
    record.allowedActions = [];

    const stopScope: ScopeRef = { ...activeScope };
    const recoveryStateRef: EvidenceRef = {
      evidenceId: id('evidence', `recovery-${record.operationId.value}`),
      kind: 'operation',
      source: RUNTIME_OWNER,
      locator: `operation/${record.operationId.value}/recovery`,
      scope: stopScope,
    };
    const command: RequestStopCommand = {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: this.options.organId,
      taskId,
      executionEpoch: record.executionEpoch,
      currentState: 'running',
      runtimeId: this.runtimeId(record.operationId),
    };
    try {
      const result = await executeStopControl({
        command,
        driver: record.driver,
        checkpointPort: record.composition.checkpointCommitPort(record.checkpoint ?? null),
        attentionPort: this.options.attentionPort,
        currentOrganId: this.options.organId,
        currentTaskId: taskId,
        currentEpoch: record.executionEpoch,
        operationId: record.operationId,
        scope: stopScope,
        cycleId: activeScope.cycleId!,
        ownerId: RUNTIME_OWNER,
        previousCheckpoint: record.checkpoint ?? null,
        checkpointSeq: record.checkpointSeq + 1,
        directiveRevision: record.directiveRevision,
        stopReason: 'operator-stop',
        recoveryStateRef,
        runtime: record.runtime,
      });
      if (result.state === 'stopped') {
        record.checkpoint = result.checkpoint;
        record.checkpointSeq = result.checkpoint.seq;
        this.pushEvent(record, operation, 'checkpoint.committed', 'stopped', 'stopped checkpoint committed', result.checkpoint.evidenceRefs);
        const close = await this.closeForExecution(operation.operationId, record.driver, result.closure.evidenceRefs);
        if (close.state !== 'closed') {
          throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER, `provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'inspect provider close evidence');
        }
        this.pushEvent(record, operation, 'execution.terminal', 'stopped', close.retained ? 'execution stopped; provider retained for active executions' : 'execution stopped; provider closed', [...result.closure.evidenceRefs, ...close.evidenceRefs], undefined, undefined, undefined, undefined, 'final');
        this.finalize(record, 'stopped');
        return { state: 'stopped', operationId: record.operationId.value };
      }
      this.pushEvent(record, operation, 'attention.opened', 'settling', 'stop is awaiting settlement', [], result.ownerId, true, toNextActionText(result.nextAction));
      record.state = 'settling';
      record.currentState = '停止待收拢';
      record.nextStep = toNextActionText(result.nextAction) ?? '重试 stop 收拢或检查错误 owner';
      record.allowedActions = ['retry-stop'];
      record.updatedAt = this.now().toISOString();
      return { state: 'settling', operationId: record.operationId.value };
    } catch (error) {
      if (error instanceof StopSettlementCommitError && error.checkpointCommitted && error.recovery) {
        await this.throwCommittedStopRecovery(record, operation, error, error.recovery);
      }
      const projection = errorFromUnknown(error);
      record.error = projection;
      this.pushEvent(record, operation, 'provider.error', 'failed', projection.message, [], projection.ownerId, projection.retryable, projection.nextAction);
      record.state = 'blocked';
      record.currentState = '停止失败，可重试收拢';
      record.nextStep = projection.nextAction;
      record.allowedActions = ['retry-stop'];
      record.updatedAt = this.now().toISOString();
      throw error instanceof RuntimeTaskControlError ? error : new RuntimeTaskControlError('stop.failed', projection.ownerId, projection.message, projection.nextAction);
    }
  }

  async retryStop(taskId: TaskId): Promise<{ readonly state: string; readonly operationId?: string }> {
    const record = this.requireTask(taskId);
    if (record.stopping && record.release?.state === 'prepared' && record.operationId) {
      const prepared = this.operations.get(record.operationId.value)!;
      await this.stopPreparedExecution(record, prepared, record.driver);
      return { state: 'stopped', operationId: record.operationId.value };
    }
    if (!record.stopping || !record.operationId || !record.driver || !record.runtime || !record.composition || !record.executionEpoch) {
      throw new RuntimeTaskControlError('task.not.recoverable', RUNTIME_OWNER, 'task has no pending stop recovery', 'start an execution first');
    }
    const operation = this.operations.get(record.operationId.value);
    const activeScope = this.scopes.get(record.operationId.value);
    if (!operation || !activeScope?.cycleId) throw new RuntimeTaskControlError('operation.recovery.missing', RUNTIME_OWNER, 'pending stop operation is missing', 'start a new execution');
    const stopScope: ScopeRef = { ...activeScope };
    const recoveryStateRef: EvidenceRef = {
      evidenceId: id('evidence', `recovery-${record.operationId.value}`),
      kind: 'operation',
      source: RUNTIME_OWNER,
      locator: `operation/${record.operationId.value}/recovery`,
      scope: stopScope,
    };
    const runtimeState = record.runtime.snapshot().state;
    const stopRequestState = runtimeState === 'admitted' || runtimeState === 'running' || runtimeState === 'waiting' || runtimeState === 'blocked'
      ? runtimeState
      : 'blocked';
    const command: RequestStopCommand = {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'human-operator',
      hasStopPermission: true,
      organId: this.options.organId,
      taskId,
      executionEpoch: record.executionEpoch,
      currentState: stopRequestState,
      runtimeId: this.runtimeId(record.operationId),
    };
    try {
      const result = await executeStopControl({
        command,
        driver: record.driver,
        checkpointPort: record.composition.checkpointCommitPort(record.checkpoint ?? null),
        attentionPort: this.options.attentionPort,
        currentOrganId: this.options.organId,
        currentTaskId: taskId,
        currentEpoch: record.executionEpoch,
        operationId: record.operationId,
        scope: stopScope,
        cycleId: activeScope.cycleId,
        ownerId: RUNTIME_OWNER,
        previousCheckpoint: record.checkpoint ?? null,
        checkpointSeq: record.checkpointSeq + 1,
        directiveRevision: record.directiveRevision,
        stopReason: 'operator-stop',
        recoveryStateRef,
        runtime: record.runtime,
      });
      if (result.state === 'stopped') {
        record.checkpoint = result.checkpoint;
        record.checkpointSeq = result.checkpoint.seq;
        this.pushEvent(record, operation, 'checkpoint.committed', 'stopped', 'stopped checkpoint committed', result.checkpoint.evidenceRefs);
        const close = await this.closeForExecution(operation.operationId, record.driver, result.closure.evidenceRefs);
        if (close.state !== 'closed') {
          throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER, `provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'inspect provider close evidence');
        }
        this.pushEvent(record, operation, 'execution.terminal', 'stopped', close.retained ? 'execution stopped; provider retained for active executions' : 'execution stopped; provider closed', [...result.closure.evidenceRefs, ...close.evidenceRefs], undefined, undefined, undefined, undefined, 'final');
        this.finalize(record, 'stopped');
        return { state: 'stopped', operationId: record.operationId.value };
      }
      this.pushEvent(record, operation, 'attention.opened', 'settling', 'stop recovery is awaiting settlement', [], result.ownerId, true, toNextActionText(result.nextAction));
      record.state = 'settling';
      record.currentState = '停止待收拢';
      record.nextStep = toNextActionText(result.nextAction) ?? '重试 stop 收拢或检查错误 owner';
      record.allowedActions = ['retry-stop'];
      record.updatedAt = this.now().toISOString();
      return { state: 'settling', operationId: record.operationId.value };
    } catch (error) {
      if (error instanceof StopSettlementCommitError && error.checkpointCommitted && error.recovery) {
        await this.throwCommittedStopRecovery(record, operation, error, error.recovery);
      }
      const projection = errorFromUnknown(error);
      record.error = projection;
      this.pushEvent(record, operation, 'provider.error', 'failed', projection.message, [], projection.ownerId, projection.retryable, projection.nextAction);
      record.state = 'blocked';
      record.currentState = '停止失败，可重试收拢';
      record.nextStep = projection.nextAction;
      record.allowedActions = ['retry-stop'];
      record.updatedAt = this.now().toISOString();
      throw error instanceof RuntimeTaskControlError ? error : new RuntimeTaskControlError('stop.retry.failed', projection.ownerId, projection.message, projection.nextAction);
    }
  }

  eventsSince(operationId: OperationId, lastEventId?: string): readonly RuntimeTaskEvent[] {
    const operation = this.operations.get(operationId.value);
    if (!operation) throw new RuntimeTaskControlError('operation.not.found', RUNTIME_OWNER, 'unknown operation', 'start an execution first');
    if (!lastEventId) return operation.events;
    const index = operation.events.findIndex((event) => event.eventId === lastEventId);
    if (index === -1) return operation.events;
    return operation.events.slice(index + 1);
  }

  operationTask(operationId: OperationId): TaskId {
    const operation = this.operations.get(operationId.value);
    if (!operation) throw new RuntimeTaskControlError('operation.not.found', RUNTIME_OWNER, 'unknown operation', 'start an execution first');
    return operation.taskId;
  }

  subscribe(operationId: OperationId, listener: (event: RuntimeTaskEvent) => void): () => void {
    const operation = this.operations.get(operationId.value);
    if (!operation) throw new RuntimeTaskControlError('operation.not.found', RUNTIME_OWNER, 'unknown operation', 'start an execution first');
    return this.listeners.add(operationId.value, listener);
  }

  subscribeReplay(operationId: OperationId, lastEventId: string | undefined, listener: (event: RuntimeTaskEvent) => void): { readonly replay: readonly RuntimeTaskEvent[]; readonly unsubscribe: () => void } {
    const operation = this.operations.get(operationId.value);
    if (!operation) throw new RuntimeTaskControlError('operation.not.found', RUNTIME_OWNER, 'unknown operation', 'start an execution first');
    const index = lastEventId ? operation.events.findIndex((event) => event.eventId === lastEventId) : -1;
    const replay = index === -1 ? operation.events : operation.events.slice(index + 1);
    const unsubscribe = this.listeners.add(operationId.value, listener);
    return { replay, unsubscribe };
  }

  /** Return the actual Task assembly pool for the independent closed-turn Planner. */
  closedTurnPlannerPool(taskId: TaskId): AgentRuntimePoolManager {
    return this.taskAssembly(taskId).runtimePool;
  }

  taskAssembly(taskId: TaskId): RuntimeTaskAssembly {
    const assembly = this.requireTask(taskId).taskAssembly;
    if (!assembly) {
      throw new RuntimeTaskControlError(
        'task.assembly.missing',
        RUNTIME_OWNER,
        `task ${taskId.value} has no live orchestration assembly`,
        'start the task through a serve composition that binds orchestration ports',
      );
    }
    return assembly;
  }

  /** The durable active-turn id for a task, once the turn has been opened. */
  activeTurnId(taskId: TaskId): string | undefined {
    return this.tasks.get(taskId.value)?.activeTurn?.admittedTurn.turnId;
  }

  /**
   * Reads the Runtime-owned capture body for a task from durable facts only.
   * This never dispatches a child or replays a side effect.
   */
  activeTurnCapture(taskId: TaskId, pauseId: string): import('../../../contracts/src/index.js').ActiveTurnCaptureBody | undefined {
    const prepared = this.tasks.get(taskId.value)?.preparedCapture;
    return prepared?.body.cut.pauseId === pauseId ? structuredClone(prepared.body) : undefined;
  }

  async prepareRecoveryCapture(taskId: TaskId, boundaryId: string, childRuntimeId?: string): Promise<PreparedRecoveryCapture> {
    const record = this.requireTask(taskId);
    if (childRuntimeId !== undefined) {
      const child = record.childTurns?.get(childRuntimeId);
      if (!child) throw new RuntimeActiveTurnError('active-turn.child.binding-missing', 'no native child capture owner matches this runtime');
      return child.capture.prepare(boundaryId);
    }
    if (!record.captureOwner) throw new RuntimeActiveTurnError('active-turn.capture.owner-missing', 'no native capture owner is assembled for this task');
    const prepared = await record.captureOwner.prepare(boundaryId);
    record.preparedCapture = prepared;
    return structuredClone(prepared);
  }

  attentionAudit(): { readonly published: readonly Attention[]; readonly resolved: readonly Attention[] } {
    return { published: this.publishedAttentions, resolved: this.resolvedAttentions };
  }

  private async publishRetryAttention(
    record: TaskRecord,
    operation: OperationRecord,
    scope: ScopeRef,
    issue: RetryCycleIssue,
  ): Promise<void> {
    const attention: Attention = {
      attentionId: `retry-cycle:${operation.operationId.value}:${issue.code}`,
      scope,
      severity: 'blocker',
      state: 'open',
      message: issue.reason,
      evidenceRefs: issue.evidenceRefs,
      ownerId: issue.ownerId,
      nextAction: issue.nextAction,
    };
    await publishRequiredAttention(this.options.attentionPort, attention);
    this.publishedAttentions.push(attention);
    record.error = {
      code: issue.code,
      ownerId: issue.ownerId,
      message: issue.reason,
      retryable: false,
      nextAction: toNextActionText(issue.nextAction) ?? 'recover retry cycle',
      evidenceRefs: issue.evidenceRefs,
    };
    record.nextStep = record.error.nextAction;
    this.pushEvent(
      record,
      operation,
      'attention.opened',
      'blocked',
      issue.reason,
      issue.evidenceRefs,
      issue.ownerId,
      false,
      record.error.nextAction,
      { error: record.error },
    );
  }

  private providerAttemptReport(input: Parameters<ExecutionAgentPort['execute']>[0], attempt: number, executionEpoch: number): {
    readonly taskId: import('../../../contracts/src/index.js').TaskId;
    readonly pipelineNodeId: string;
    readonly agentId: string;
    readonly assignmentId: string;
    readonly attempt: number;
    readonly executionEpoch: number;
    readonly inputRevision: number;
  } {
    return {
      taskId: input.assignment.taskId,
      pipelineNodeId: input.assignment.pipelineNodeId,
      agentId: input.agentId,
      assignmentId: input.assignment.assignmentId,
      attempt,
      executionEpoch,
      inputRevision: input.assignment.inputRevision,
    };
  }

  private async executePreparedProviderAttempt(
    record: TaskRecord,
    operation: OperationRecord,
    scope: ScopeRef,
    prompt: string,
    outputRef: string,
    input: Parameters<ExecutionAgentPort['execute']>[0],
    report: ReturnType<RuntimeTaskCoordinator['providerAttemptReport']>,
    composition: RuntimeExecutionComposition,
    runtime: AgentRuntime,
  ): Promise<{ readonly result: WorkResult & { readonly executorEvidence?: readonly ExecutorReviewEvidence[] }; readonly closure?: AgentRuntimeClosure }> {
    const coordinator = this;
    let producedOutput = '';
    const executorEvidence: ExecutorReviewEvidence[] = [];
    const producedPaths: string[] = [];
    await composition.start();
    await composition.submit(prompt);
    record.resolveExecutionReady?.(true);
    record.resolveExecutionReady = undefined;
    if (record.stopping || record.postCommitRecoveryPending) {
      return {
        result: {
          taskId: report.taskId,
          pipelineNodeId: report.pipelineNodeId,
          agentId: report.agentId,
          assignmentId: report.assignmentId,
          attempt: report.attempt,
          executionEpoch: input.assignment.executionEpoch,
          inputRevision: report.inputRevision,
          producedArtifactRefs: [],
          producedArtifactDigests: [],
          status: 'cancelled',
          summary: 'provider execution was stopped before observation completed',
          outputRefs: [],
          evidenceRefs: [],
          nextAction: 'settle',
        },
      };
    }
    for await (const observation of composition.observe()) {
      if (record.postCommitRecoveryPending) {
        return {
          result: {
            taskId: report.taskId,
            pipelineNodeId: report.pipelineNodeId,
            agentId: report.agentId,
            assignmentId: report.assignmentId,
            attempt: report.attempt,
            executionEpoch: input.assignment.executionEpoch,
            inputRevision: report.inputRevision,
            producedArtifactRefs: [],
            producedArtifactDigests: [],
            status: 'blocked',
            summary: 'provider execution reached post-commit recovery',
            outputRefs: [],
            evidenceRefs: [],
            nextAction: 'attention',
            conditionRef: `operation://${operation.operationId.value}/recovery`,
          },
        };
      }
      if (!observation.accepted) {
        coordinator.pushEvent(record, operation, 'provider.error', 'stale', `late event rejected: ${observation.rejection.reason}`, [], RUNTIME_OWNER, false, 'ignore stale execution event');
        continue;
      }
      const event = observation.event as AgentEvent & { readonly providerEvent?: ProviderEvent };
      if (!event.providerEvent) continue;
      if (event.providerEvent.kind === 'output' && event.providerEvent.summary) {
        producedOutput = `${producedOutput}${event.providerEvent.summary}`;
      }
      if (event.providerEvent.kind === 'tool') {
        executorEvidence.push({
          summary: providerEventSummary(event.providerEvent),
          evidenceRefs: [...event.providerEvent.evidenceRefs],
        });
        const producedPath = producedFilePath(event.providerEvent.toolCall);
        if (producedPath !== undefined && !producedPaths.includes(producedPath)) producedPaths.push(producedPath);
      }
      await coordinator.recordProviderEvent(record, operation, event.providerEvent);
    }
    if (record.postCommitRecoveryPending) {
      return {
        result: {
          taskId: report.taskId,
          pipelineNodeId: report.pipelineNodeId,
          agentId: report.agentId,
          assignmentId: report.assignmentId,
          attempt: report.attempt,
          executionEpoch: input.assignment.executionEpoch,
          inputRevision: report.inputRevision,
          producedArtifactRefs: [],
          producedArtifactDigests: [],
          status: 'blocked',
          summary: 'provider execution reached post-commit recovery',
          outputRefs: [],
          evidenceRefs: [],
          nextAction: 'attention',
          conditionRef: `operation://${operation.operationId.value}/recovery`,
        },
      };
    }
    if (runtime.snapshot().state === 'stopped' || record.stopping) {
      const closure = runtime.snapshot().closure;
      return {
        closure,
        result: {
          taskId: report.taskId,
          pipelineNodeId: report.pipelineNodeId,
          agentId: report.agentId,
          assignmentId: report.assignmentId,
          attempt: report.attempt,
          executionEpoch: input.assignment.executionEpoch,
          inputRevision: report.inputRevision,
          producedArtifactRefs: [],
          producedArtifactDigests: [],
          status: 'cancelled',
          summary: 'provider execution was stopped during observation',
          outputRefs: [],
          evidenceRefs: closure?.evidenceRefs ?? [],
          nextAction: 'settle',
        },
      };
    }
    coordinator.pushEvent(record, operation, 'execution.settling', 'settling', 'execution settling', []);
    record.state = 'settling';
    record.currentState = '收拢中';
    record.nextStep = '等待编排审查和 checkpoint';
    record.allowedActions = [];
    const closure = await composition.settle();
    const producedArtifacts = this.options.producedArtifacts !== undefined && producedPaths.length > 0
      ? await this.options.producedArtifacts.read({
          taskId: report.taskId,
          operationId: operation.operationId,
          executionEpoch: report.executionEpoch,
          paths: [...producedPaths],
        })
      : [];
    const artifactBody = producedArtifactBody(producedOutput, producedArtifacts);
    const status: WorkResult['status'] = closure.state === 'succeeded'
      ? 'succeeded'
      : closure.state === 'waiting'
        ? 'incomplete'
        : closure.state === 'blocked'
          ? 'blocked'
          : closure.state === 'failed' || closure.state === 'unknown'
            ? 'failed'
            : 'cancelled';
    const nextAction: WorkResult['nextAction'] = closure.state === 'succeeded'
      ? 'review'
      : closure.state === 'waiting'
        ? 'wait'
        : closure.state === 'blocked' || closure.state === 'failed' || closure.state === 'unknown'
          ? 'attention'
          : 'settle';
    const nativeDeliveryTurn = record.driver?.standardTurn;
    const deliveryBinding = closure.state === 'succeeded' && nativeDeliveryTurn !== undefined
      ? await this.bindNativeDelivery(input.assignment, nativeDeliveryTurn)
      : undefined;
    const workResult: WorkResult & { readonly executorEvidence?: readonly ExecutorReviewEvidence[] } = {
      taskId: report.taskId,
      pipelineNodeId: report.pipelineNodeId,
      agentId: report.agentId,
      assignmentId: report.assignmentId,
      attempt: report.attempt,
      executionEpoch: input.assignment.executionEpoch,
      inputRevision: report.inputRevision,
      producedArtifactRefs: deliveryBinding !== undefined ? [...deliveryBinding.producedArtifactRefs] : [outputRef],
      producedArtifactDigests: deliveryBinding !== undefined ? [...deliveryBinding.producedArtifactDigests] : [digestOf(artifactBody)],
      producedArtifactBodies: deliveryBinding !== undefined ? [...deliveryBinding.producedArtifactBodies] : [artifactBody],
      executorEvidence,
      status,
      summary: `provider execution ${closure.state}`,
      outputRefs: deliveryBinding !== undefined ? [...deliveryBinding.outputRefs] : [outputRef],
      evidenceRefs: deliveryBinding !== undefined
        ? mergeDeliveryEvidence(deliveryBinding.evidenceRefs, closure.evidenceRefs)
        : closure.evidenceRefs,
      nextAction,
      ...(nextAction === 'wait'
        ? { conditionRef: closure.conditionRef ?? `operation://${operation.operationId.value}/waiting` }
        : {}),
      ...(status === 'failed'
        ? { failureRef: closure.failureRef ?? `operation://${operation.operationId.value}/failed` }
        : {}),
    };
    return { closure, result: workResult };
  }

  /**
   * Reads and binds the accepted standard-end delivery on a native retained
   * turn. The capability must exist; an absent reader stops the succeeded
   * result instead of reusing the operation output ref or drain body.
   */
  private async bindNativeDelivery(
    assignment: WorkAssignment,
    standardTurn: NonNullable<RuntimeExecutionDriver['standardTurn']>,
  ): Promise<StandardTurnDeliveryBinding> {
    if (standardTurn.readDelivery === undefined) {
      throw new RuntimeTaskControlError(
        'standard-turn-delivery.unavailable',
        RUNTIME_OWNER,
        'the native standard turn exposes no readDelivery capability',
        'assemble the runtime delivery reader before native result binding',
      );
    }
    const readback = await standardTurn.readDelivery();
    return bindAssignmentDelivery({ assignment, readback });
  }

  private readonly scopes = new Map<string, ScopeRef>();
  private readonly listeners = new OperationListeners();

  private operationScopeEvidence(scope: ScopeRef, locator: string): EvidenceRef {
    return {
      evidenceId: id('evidence', `active-turn-${activeTurnSlug(locator)}`),
      kind: 'operation',
      source: RUNTIME_OWNER,
      locator,
      scope,
    };
  }

  /**
   * Opens the Runtime-owned durable active turn at admission. The Runtime
   * producer derives every identity from the real assignment, scope and binding
   * snapshot. A missing permission snapshot stops the open; it is never
   * defaulted to a placeholder string.
   */
  private async openActiveTurn(
    record: TaskRecord,
    operation: OperationRecord,
    scope: ScopeRef,
  ): Promise<ActiveTurnContext | undefined> {
    if (!this.options.activeTurnJournal && !this.options.activeTurnJournalFor) return undefined;
    if (record.activeTurn?.admittedTurn.turnId === newActiveTurnId(operation.operationId.value)) return record.activeTurn;
    const snapshot = this.options.permissionSnapshot;
    if (!snapshot) {
      throw new RuntimeTaskControlError(
        'active-turn.permission-snapshot.missing',
        'humanagent.runtime.binding',
        'no real Runtime permission/binding snapshot was assembled for this execution',
        'assemble the Runtime binding snapshot before admitting an orchestrated execution',
      );
    }
    if (!scope.cycleId) {
      throw new RuntimeTaskControlError(
        'active-turn.scope.incomplete',
        RUNTIME_OWNER,
        'active turn scope has no cycle identity',
        'start the execution through the standard operation/cycle owner',
      );
    }
    const assignment = this.buildWorkAssignment(record, operation, scope);
    const currentTurnRef = `active-turn://${operation.operationId.value}/binding`;
    const admittedTurn = produceAdmittedTurn({
      runtime: { ...snapshot, runtimeId: this.runtimeId(operation.operationId), executionEpoch: operation.executionEpoch },
      taskId: record.taskId,
      scope,
      assignment,
      directiveRevision: record.directiveRevision,
      turnId: newActiveTurnId(operation.operationId.value),
      currentTurnRef,
      admissionEvidence: [this.operationScopeEvidence(scope, `operation/${operation.operationId.value}/scope`)],
      recoveryStateRef: this.operationScopeEvidence(scope, `recovery/${operation.operationId.value}`),
    });
    const binding: import('../../../contracts/src/index.js').ActiveTurnBinding = {
      admittedTurn,
      assignment,
      execution: { runtimeId: this.runtimeId(operation.operationId), executionEpoch: operation.executionEpoch },
      scope,
    };
    const context = await ActiveTurnContext.open({
      journal: this.options.activeTurnJournalFor?.(binding) ?? this.options.activeTurnJournal!,
      binding,
      currentTurnRef,
    });
    record.activeTurn = context;
    delete record.childTurns;
    delete record.preparedCapture;
    record.assignment = assignment;
    if (this.options.initialInputStore) {
      const initialInput = await this.options.initialInputStore.store({
        binding,
        bytes: new TextEncoder().encode(record.originalInput ?? operation.input),
      });
      await context.registerInitialInput(initialInput);
      record.captureOwner = this.createRecoveryCaptureOwner(context);
    }
    return context;
  }

  private createRecoveryCaptureOwner(context: ActiveTurnContext): ActiveTurnRecoveryCapture {
    return new ActiveTurnRecoveryCapture(context, async () => {
        if (!this.options.recoveryReferencesFor) {
          throw new RuntimeActiveTurnError('active-turn.capture.references-missing', 'capture requires actual completion and recovery reference readers');
        }
        const references = await this.options.recoveryReferencesFor(context.activeBinding);
        const checkpointPath = [...new Set(context.childInvocations().flatMap((invocation) => [
          invocation.checkpointReceiptRef,
          ...(invocation.postReviewCheckpointRef ? [invocation.postReviewCheckpointRef] : []),
        ]))];
        const completionRefs = context.entries().flatMap((entry) => (
          'envelope' in entry && entry.envelope.fact.kind === 'tool-result'
            ? [{ requestId: entry.envelope.request.requestId, producerSeq: entry.envelope.producerSeq }]
            : []
        ));
        return { ...references, checkpointPath, completionRefs };
    }, this.now);
  }

  private buildWorkAssignment(
    record: TaskRecord,
    operation: OperationRecord,
    scope: ScopeRef,
  ): WorkAssignment {
    if (record.assignment) return record.assignment;
    const outputRef = `operation://${operation.operationId.value}/output`;
    const acceptanceCriteria = acceptanceCriteriaContent({
      objective: operation.input,
      successCriteria: ['provider execution settles successfully'],
      failureCriteria: ['provider execution fails'],
      incompleteCriteria: ['provider execution requires waiting or recovery'],
    });
    return {
      assignmentId: `assignment-${operation.operationId.value}`,
      taskId: record.taskId,
      pipelineNodeId: `stage-${operation.operationId.value}`,
      attempt: 1,
      executionEpoch: operation.executionEpoch,
      inputRevision: record.directiveRevision,
      objective: operation.input,
      targetRefs: [outputRef],
      expectedOutputRefs: [outputRef],
      acceptanceCriteriaDigest: digestOf(acceptanceCriteria),
      successCriteria: ['provider execution settles successfully'],
      failureCriteria: ['provider execution fails'],
      incompleteCriteria: ['provider execution requires waiting or recovery'],
      requiredCapabilities: ['provider.execution'],
      mergeGate: 'required',
    };
  }

  private createChildCallPort(
    record: TaskRecord,
    context: ActiveTurnContext,
    scope: ScopeRef,
  ): ChildCallPort {
    const coordinator = this;
    const store = this.options.checkpointStoreFor(record.taskId, scope.cycleId!);
    return {
      async prepare(input: ChildCallPrepareInput): Promise<PreparedChildCall> {
        context.assertProductionOpen();
        const committed = await coordinator.commitChildCallCheckpoint(context, store, input);
        await context.openChildInvocation({
          invocationId: input.invocationId,
          childTurnId: input.invocationId,
          checkpointReceiptRef: committed.receipt.checkpointId.value,
          binding: input.kind === 'execution'
            ? { kind: 'execution', assignment: input.assignment }
            : { kind: 'review', assignment: input.assignment },
        });
        return { invocationId: input.invocationId, checkpointReceiptRef: committed.receipt.checkpointId.value };
      },
      async recordReturn(input: ChildCallReturnInput): Promise<void> {
        const refinedDelivery = await coordinator.storeRefinedDelivery(context, input);
        if (input.kind === 'execution') {
          await context.recordChildReturn({
            kind: 'execution',
            invocationId: input.invocationId,
            refinedDelivery,
            assignment: input.assignment,
            result: input.result,
          });
        } else {
          await context.recordChildReturn({
            kind: 'review',
            invocationId: input.invocationId,
            refinedDelivery,
            assignment: input.assignment,
            result: input.result,
          });
        }
      },
      async recordAdoption(input: ChildCallAdoptionInput): Promise<void> {
        context.assertProductionOpen();
        const delivery = context.entries().find((entry) => (
          !('envelope' in entry) && entry.invocationId === input.invocationId && entry.kind === input.kind
        ));
        if (!delivery || 'envelope' in delivery) {
          throw new RuntimeActiveTurnError(
            'active-turn.adoption.unreturned',
            `child invocation ${input.invocationId} has no durable refined delivery to adopt`,
          );
        }
        await context.recordChildAdoption(input.invocationId, delivery);
      },
      async recordReviewCheckpoint(input: ChildCallReviewCheckpointInput): Promise<ChildCallReviewCheckpointReceipt> {
        const committed = await coordinator.commitReviewResultCheckpoint(context, store, input);
        await context.recordReviewCheckpoint(input.invocationId, committed.receipt.checkpointId.value);
        return { checkpointReceiptRef: committed.receipt.checkpointId.value };
      },
    };
  }

  private async commitChildCallCheckpoint(
    context: ActiveTurnContext,
    store: TaskCheckpointStore,
    input: ChildCallPrepareInput,
  ) {
    const latest = await recallCheckpoint(store, { ownerId: RUNTIME_OWNER, scope: context.scope() });
    const previous = latest?.checkpoint ?? null;
    const recoveryStateRef = this.operationScopeEvidence(context.scope(), `recovery/${input.invocationId}`);
    const checkpoint: Checkpoint = {
      id: id('checkpoint', `child-call-${activeTurnSlug(input.invocationId)}`),
      scope: context.scope(),
      cycleId: context.admittedTurn.cycleRef,
      seq: (previous?.seq ?? 0) + 1,
      previousCheckpointId: previous?.id ?? null,
      directiveRevision: context.admittedTurn.directiveRevision,
      executionEpoch: context.admittedTurn.executionEpoch,
      outcome: 'waiting',
      summary: `${input.kind} child call ${input.invocationId} dispatched after a durable recovery anchor`,
      recoveryStateRef,
      evidenceRefs: [
        this.operationScopeEvidence(context.scope(), `child-call/${input.invocationId}/intent`),
        this.operationScopeEvidence(context.scope(), `assignment/${input.assignment.assignmentId}`),
      ],
      next: { kind: 'wait', ref: `child-invocation:${input.invocationId}` },
    };
    return completeCheckpoint(store, {
      ownerId: RUNTIME_OWNER,
      context: {
        scope: context.scope(),
        cycleId: context.admittedTurn.cycleRef,
        executionEpoch: context.admittedTurn.executionEpoch,
        directiveRevision: context.admittedTurn.directiveRevision,
      },
      previous,
      checkpoint,
    });
  }

  private async commitReviewResultCheckpoint(
    context: ActiveTurnContext,
    store: TaskCheckpointStore,
    input: ChildCallReviewCheckpointInput,
  ) {
    const latest = await recallCheckpoint(store, { ownerId: RUNTIME_OWNER, scope: context.scope() });
    const previous = latest?.checkpoint ?? null;
    const recoveryStateRef = this.operationScopeEvidence(
      context.scope(),
      `recovery/${input.invocationId}/review-result`,
    );
    const checkpoint: Checkpoint = {
      id: id('checkpoint', `review-result-${activeTurnSlug(input.invocationId)}`),
      scope: context.scope(),
      cycleId: context.admittedTurn.cycleRef,
      seq: (previous?.seq ?? 0) + 1,
      previousCheckpointId: previous?.id ?? null,
      directiveRevision: context.admittedTurn.directiveRevision,
      executionEpoch: context.admittedTurn.executionEpoch,
      outcome: 'waiting',
      summary: `review result ${input.result.resultId} adopted for invocation ${input.invocationId}`,
      recoveryStateRef,
      evidenceRefs: [
        this.operationScopeEvidence(context.scope(), `review-result/${input.invocationId}/result`),
        this.operationScopeEvidence(context.scope(), `assignment/${input.assignment.assignmentId}`),
      ],
      next: { kind: 'wait', ref: `review-result:${input.result.resultId}` },
    };
    return completeCheckpoint(store, {
      ownerId: RUNTIME_OWNER,
      context: {
        scope: context.scope(),
        cycleId: context.admittedTurn.cycleRef,
        executionEpoch: context.admittedTurn.executionEpoch,
        directiveRevision: context.admittedTurn.directiveRevision,
      },
      previous,
      checkpoint,
    });
  }

  private async storeRefinedDelivery(
    context: ActiveTurnContext,
    input: ChildCallReturnInput,
  ): Promise<RawAsset> {
    const store = this.options.refinedDeliveryStore;
    if (!store) {
      throw new RuntimeActiveTurnError(
        'active-turn.delivery-store.missing',
        'no durable refined delivery store is assembled for child returns',
      );
    }
    const payload = input.kind === 'execution'
      ? {
          assignmentId: input.result.assignmentId,
          attempt: input.result.attempt,
          executionEpoch: input.result.executionEpoch,
          status: input.result.status,
          summary: input.result.summary,
          producedArtifactBodies: input.result.producedArtifactBodies ?? [],
        }
      : {
          resultId: input.result.resultId,
          assignmentId: input.result.assignmentId,
          taskId: input.result.taskId,
          workerAgentId: input.result.workerAgentId,
          reviewKind: input.result.reviewKind,
          attempt: input.result.attempt,
          executionEpoch: input.result.executionEpoch,
          inputRevision: input.result.inputRevision,
          acceptanceCriteriaDigest: input.result.acceptanceCriteriaDigest,
          subjectRefs: input.result.subjectRefs,
          subjectDigests: input.result.subjectDigests,
          status: input.result.status,
          findings: input.result.findings,
          evidenceRefs: input.result.evidenceRefs,
        };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return store.store({
      scope: context.scope(),
      invocationId: input.invocationId,
      bytes,
    });
  }

  private async stopPreparedExecution(
    record: TaskRecord,
    operation: OperationRecord,
    driver?: RuntimeExecutionDriver,
  ): Promise<void> {
    // This driver belongs to this preparation. Another task's execution does
    // not retain it, unlike the legacy shared-provider close path.
    const close = driver ? await driver.close() : undefined;
    if (close && close.state !== 'closed') {
      throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER,
        `prepared provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'release the prepared provider resource');
    }
    const error = new RuntimeTaskControlError('execution.preparation.stopped', RUNTIME_OWNER,
      'execution stopped before provider start', 'start a new execution');
    record.rejectRelease?.(error);
    record.rejectRelease = undefined;
    record.resolveRelease = undefined;
    record.resolveExecutionReady?.(false);
    record.resolveExecutionReady = undefined;
    record.release = undefined;
    this.pushEvent(record, operation, 'execution.terminal', 'stopped', error.message,
      close?.evidenceRefs ?? [], error.ownerId, false, error.nextAction, undefined, 'final');
    this.finalize(record, 'stopped');
  }

  /**
   * The single child-manager binding owner. It passes the assembly's already
   * constructed orchestration manager to the driver that is about to run the
   * root model request, and nothing else: a driver without the optional child
   * capability is left untouched, and no driver, pool or assembly is created
   * here. The boundary/readback lanes call nothing at all.
   */
  private bindChildCallManager(
    driver: RuntimeExecutionDriver | undefined,
    assembly: RuntimeTaskAssembly | undefined,
  ): void {
    if (driver === undefined || assembly === undefined) return;
    driver.bindChildCallManager?.(assembly.orchestration);
  }

  private async runExecution(
    record: TaskRecord,
    operation: OperationRecord,
    scope: ScopeRef,
    prompt: string,
    allocation: RuntimeExecutionAllocation,
  ): Promise<void> {
    this.scopes.set(operation.operationId.value, scope);
    const runtimeId = this.runtimeId(operation.operationId);
    const evidenceRef: EvidenceRef = {
      evidenceId: id('evidence', `operation-${operation.operationId.value}-scope`),
      kind: 'operation',
      source: RUNTIME_OWNER,
      locator: `operation/${operation.operationId.value}/scope`,
      scope,
    };
    let driver: RuntimeExecutionDriver | undefined;
    let runtime: AgentRuntime | undefined;
    let composition: RuntimeExecutionComposition | undefined;
    let selectedBindingId: string | undefined;
    let selectedExecutionEpoch: number | undefined;
    let retryCycle: ReturnType<typeof createRetryCycleManager> | undefined;
    const closedRetryDrivers = new Map<RuntimeExecutionDriver, ProviderCloseResult>();
    try {
      await this.openActiveTurn(record, operation, scope);
      if (!this.options.admitExecution) {
        throw new RuntimeTaskControlError('execution.admission.missing', RUNTIME_OWNER,
          'execution admission source is not bound', 'bind the actual task admission owner before release');
      }
      await this.options.admitExecution(allocation);
      if (record.stopping) {
        await this.stopPreparedExecution(record, operation);
        return;
      }
      if (this.options.providerRetry) {
        retryCycle = createRetryCycleManager({
          config: this.options.providerRetry.config,
          journal: this.options.providerRetry.journal,
        });
        const decision = await retryCycle.begin({
          assignmentId: `assignment-${operation.operationId.value}`,
          initialExecutionEpoch: operation.executionEpoch,
          scope,
        });
        if (decision.kind !== 'dispatch') {
          throw new RuntimeTaskControlError(
            'execution.retry.unavailable',
            decision.issue.ownerId,
            decision.issue.reason,
            decision.issue.nextAction.kind,
          );
        }
        selectedBindingId = decision.candidate.binding.bindingId;
        selectedExecutionEpoch = decision.executionEpoch;
      }
      if (!this.options.providerRetry) {
        const checkpointBoundary = new ContextCheckpointBoundary(
          this.options.checkpointStoreFor(record.taskId, scope.cycleId!),
        );
        record.checkpointBoundary = checkpointBoundary;
        const preparationInput: RuntimeExecutionPreparationInput = {
          ...allocation,
          attemptExecutionEpoch: allocation.executionEpoch,
        };
        /**
         * The bounded execution preparation seam. The driver factory may need
         * to resolve the actual Provider for this execution (configured
         * selection, own probe, own admission) before the driver exists, so
         * the coordinator awaits it exactly once before any driver start. A
         * stop that landed while this promise is pending must not start a
         * Provider after the stop.
         */
        const prepared = await this.options.createDriver(preparationInput);
        driver = prepared;
        record.driver = prepared;
        if (record.stopping) {
          await this.stopPreparedExecution(record, operation, prepared);
          return;
        }
        composition = new HarnessExecutionComposition({
          driver,
          runtimeId,
          taskId: record.taskId,
          assignmentId: `assignment-${operation.operationId.value}`,
          operationId: operation.operationId,
          executionEpoch: operation.executionEpoch,
          scope,
          checkpointBoundary,
          now: this.now,
          hookRegistry: this.options.hookRegistry,
        });
        runtime = composition.runtime;
        record.composition = composition;
        record.driver = driver;
        record.runtime = runtime;
        if (driver.standardTurn) {
          // A native standard turn closes through `readClosureFacts`, which
          // requires the Runtime-owned current state to be already committed.
          // The release boundary is the true owner of that publication: it is
          // the first point where the real loop/native facts are bound, and it
          // runs before the release acknowledgement and before start/submit.
          // A missing port or a failed commit keeps the release prepared, so
          // no Provider request and no model execution ever start.
          const releaseStateRef = await this.persistCurrentState(
            record,
            `execution-release:${record.taskId.value}:${operation.operationId.value}:${operation.executionEpoch}`,
            scope,
          );
          if (releaseStateRef === undefined) {
            throw new RuntimeTaskControlError(
              'runtime.current-state.release-port-unknown',
              RUNTIME_OWNER,
              'the native release boundary has no Runtime current-state port',
              'bind the Runtime current-state port before releasing a native execution',
            );
          }
        }
        this.markExecutionReleased(record, operation);
      }
      let closure: AgentRuntimeClosure | undefined;
      if (record.orchestrated && this.options.createTaskAssembly) {
        const outputRef = `operation://${operation.operationId.value}/output`;
        const coordinator = this;
        const activeTurn = await this.openActiveTurn(record, operation, scope);
        const childCallPort = activeTurn === undefined
          ? undefined
          : this.createChildCallPort(record, activeTurn, scope);
        const executeProviderAttempt = async (input: Parameters<ExecutionAgentPort['execute']>[0]): Promise<WorkResult> => {
            const assignmentId = `assignment-${operation.operationId.value}`;
            const initialExecutionEpoch = operation.executionEpoch;
            let attemptBindingId = selectedBindingId;
            let attemptEpoch = selectedExecutionEpoch ?? operation.executionEpoch;
            let attemptNumber = input.assignment.attempt;
            const blockedResult = async (workResult: WorkResult, issue: RetryCycleIssue): Promise<WorkResult> => {
              await coordinator.publishRetryAttention(record, operation, scope, issue);
              closure = {
                state: 'blocked',
                evidenceRefs: [...workResult.evidenceRefs, ...issue.evidenceRefs],
                ownerRef: issue.ownerId,
                nextAction: issue.nextAction,
                conditionRef: issue.nextAction.ref ?? `retry-cycle:${assignmentId}`,
              };
              return {
                ...workResult,
                attempt: input.assignment.attempt,
                executionEpoch: input.assignment.executionEpoch,
                status: 'blocked',
                nextAction: 'attention',
                summary: issue.reason,
                evidenceRefs: [...workResult.evidenceRefs, ...issue.evidenceRefs],
                conditionRef: issue.nextAction.ref ?? `retry-cycle:${assignmentId}`,
              };
            };
            while (true) {
              let attemptComposition: RuntimeExecutionComposition;
              let attemptRuntime: AgentRuntime;
              let attemptDriver: RuntimeExecutionDriver | undefined;
              if (coordinator.options.providerRetry && retryCycle && attemptBindingId) {
                const checkpointBoundary = new ContextCheckpointBoundary(
                  coordinator.options.checkpointStoreFor(record.taskId, scope.cycleId!),
                );
                record.checkpointBoundary = checkpointBoundary;
                const attemptPreparationInput: RuntimeExecutionPreparationInput = {
                  ...allocation,
                  runtimeId: `retry-${assignmentId}-${attemptEpoch}`,
                  operationId: operation.operationId,
                  executionEpoch: operation.executionEpoch,
                  assignmentId,
                  scope,
                  attemptBindingId,
                  attemptExecutionEpoch: attemptEpoch,
                };
                attemptDriver = await coordinator.options.providerRetry.createDriverForBinding(
                  attemptBindingId,
                  attemptPreparationInput,
                );
                record.driver = attemptDriver;
                coordinator.bindChildCallManager(attemptDriver, record.taskAssembly);
                if (record.stopping) {
                  await coordinator.stopPreparedExecution(record, operation, attemptDriver);
                  return {
                    taskId: input.assignment.taskId,
                    pipelineNodeId: input.assignment.pipelineNodeId,
                    agentId: input.agentId,
                    assignmentId: input.assignment.assignmentId,
                    attempt: input.assignment.attempt,
                    executionEpoch: input.assignment.executionEpoch,
                    inputRevision: input.assignment.inputRevision,
                    producedArtifactRefs: [],
                    producedArtifactDigests: [],
                    status: 'cancelled',
                    summary: 'provider execution was stopped before the retry attempt started',
                    outputRefs: [],
                    evidenceRefs: [],
                    nextAction: 'settle',
                  };
                }
                attemptComposition = new HarnessExecutionComposition({
                  driver: attemptDriver,
                  runtimeId: `retry-${assignmentId}-${attemptEpoch}`,
                  taskId: record.taskId,
                  assignmentId,
                  operationId: operation.operationId,
                  executionEpoch: attemptEpoch,
                  scope,
                  checkpointBoundary,
                  now: coordinator.now,
                  hookRegistry: coordinator.options.hookRegistry,
                });
                attemptRuntime = attemptComposition.runtime;
                record.composition = attemptComposition;
                record.driver = attemptDriver;
                record.runtime = attemptRuntime;
                if (record.release?.state === 'prepared') coordinator.markExecutionReleased(record, operation);
              } else {
                attemptComposition = composition!;
                attemptRuntime = runtime!;
                attemptDriver = driver;
              }
              const attempt = await coordinator.executePreparedProviderAttempt(
                record,
                operation,
                scope,
                prompt,
                outputRef,
                input,
                coordinator.providerAttemptReport(input, attemptNumber, attemptEpoch),
                attemptComposition,
                attemptRuntime,
              );
              closure = attempt.closure;
              let workResult = attempt.result;
              if (!coordinator.options.providerRetry || !retryCycle || !attemptBindingId) {
                return workResult;
              }
              if (workResult.status === 'succeeded') {
                await retryCycle.recordSuccess({
                  assignmentId,
                  initialExecutionEpoch,
                  attempt: attemptNumber,
                  executionEpoch: attemptEpoch,
                  bindingId: attemptBindingId,
                  evidenceRefs: workResult.evidenceRefs,
                });
                return {
                  ...workResult,
                  attempt: input.assignment.attempt,
                  executionEpoch: input.assignment.executionEpoch,
                };
              }
              if (workResult.status === 'failed' && closure?.state === 'failed') {
                if (!attemptDriver) {
                  throw new RuntimeTaskControlError(
                    'execution.retry.driver.missing',
                    RUNTIME_OWNER,
                    'settled retry attempt has no provider driver to close',
                    'inspect retry-cycle provider driver construction',
                  );
                }
                const closeResult = await attemptDriver.close();
                closedRetryDrivers.set(attemptDriver, closeResult);
                workResult = {
                  ...workResult,
                  evidenceRefs: [...workResult.evidenceRefs, ...closeResult.evidenceRefs],
                };
                if (closeResult.state !== 'closed') {
                  const unresolved = await retryCycle.recordFailure({
                    assignmentId,
                    initialExecutionEpoch,
                    attempt: attemptNumber,
                    executionEpoch: attemptEpoch,
                    bindingId: attemptBindingId,
                    failureRef: workResult.failureRef ?? `operation://${operation.operationId.value}/failed`,
                    evidenceRefs: workResult.evidenceRefs,
                    settleState: 'unsettled',
                  });
                  if (unresolved.kind === 'dispatch') {
                    throw new RuntimeTaskControlError(
                      'execution.retry.close.inconsistent',
                      RUNTIME_OWNER,
                      'retry cycle selected another binding after provider close was not confirmed',
                      'inspect retry-cycle journal and provider close evidence',
                    );
                  }
                  return blockedResult(workResult, unresolved.issue);
                }
                const failure = await retryCycle.recordFailure({
                  assignmentId,
                  initialExecutionEpoch,
                  attempt: attemptNumber,
                  executionEpoch: attemptEpoch,
                  bindingId: attemptBindingId,
                  failureRef: workResult.failureRef ?? `operation://${operation.operationId.value}/failed`,
                  evidenceRefs: workResult.evidenceRefs,
                  settleState: 'retry-safe',
                });
                if (failure.kind === 'dispatch') {
                  attemptBindingId = failure.candidate.binding.bindingId;
                  attemptEpoch = failure.executionEpoch;
                  attemptNumber = failure.attempt;
                  continue;
                }
                return blockedResult(workResult, failure.issue);
              }
              const failure = await retryCycle.recordFailure({
                assignmentId,
                initialExecutionEpoch,
                attempt: attemptNumber,
                executionEpoch: attemptEpoch,
                bindingId: attemptBindingId,
                failureRef: workResult.failureRef ?? `operation://${operation.operationId.value}/failed`,
                evidenceRefs: workResult.evidenceRefs,
                settleState: closure?.state === 'unknown' ? 'unknown' : closure?.state === 'cancelled' ? 'cancelled' : 'unsettled',
              });
              if (failure.kind === 'dispatch') {
                throw new RuntimeTaskControlError(
                  'execution.retry.unsettled.dispatch',
                  RUNTIME_OWNER,
                  'retry cycle selected a provider after an unsettled attempt',
                  'inspect retry-cycle journal before dispatching another provider',
                );
              }
              return blockedResult(workResult, failure.issue);
            }
        };
        const providerExecutionAgent = this.createProviderExecutionAgent(executeProviderAttempt);
        record.taskAssembly = this.options.createTaskAssembly({
          task: {
            id: record.taskId,
            organId: this.options.organId,
            title: record.title,
            directive: record.directive,
            directiveRevision: record.directiveRevision,
            state: record.state,
            memoryScope: 'task',
          },
          scope,
          checkpointJournal: this.options.checkpointStoreFor(record.taskId, scope.cycleId!),
          executionAgent: providerExecutionAgent,
          maxAttempts: 1,
          ...(childCallPort === undefined ? {} : { childCallPort }),
        });
        this.bindChildCallManager(driver, record.taskAssembly);
        const stageNodeId = `stage-${operation.operationId.value}`;
        // The acceptance criteria digest is derived from the criteria content
        // itself, so the review gate can re-verify the content it receives
        // instead of trusting a label.
        // Single Runtime assignment construction (shared with the admitted-turn
        // producer); never rebuilt per admission/composition/dispatch.
        const assignment: WorkAssignment = record.assignment ?? this.buildWorkAssignment(record, operation, scope);
        record.currentNode = RUNTIME_NODE_MARKERS.orchestrationPlan;
        record.nextStep = '编排执行、审查并合并';
        record.taskAssembly.orchestration.planStage({ nodeId: stageNodeId, taskId: record.taskId });
        const dispatch = () => record.taskAssembly!.orchestration.dispatch({
          stageNodeId,
          assignment,
          agentId: 'humanagent.provider-execution',
          scope,
          reviewKinds: ['quality'],
        });
        const dispatched = activeTurn ? await activeTurn.runProducer(dispatch) : await dispatch();
        // C3 accepts the completed review receipts on the retained turn before
        // the native close. Late reviews that land after the close stay the first
        // error; the frozen closure is never rewritten to claim completion.
        await driver?.standardTurn?.acceptReviews(dispatched.reviewCommitRefs ?? []);
        if (record.stopping || record.postCommitRecoveryPending || record.state === 'stopped') return;
        if (dispatched.status !== 'merged' && dispatched.status !== 'succeeded') {
          if (!closure) {
            const problem = dispatched.issue;
            throw new RuntimeTaskControlError(
              'orchestration.dispatch.failed',
              problem?.ownerId ?? RUNTIME_OWNER,
              problem?.reason ?? `orchestration dispatch ended as ${dispatched.status}`,
              problem ? `${problem.nextAction.kind}${problem.nextAction.ref ? `:${problem.nextAction.ref}` : ''}` : 'inspect orchestration assignment',
            );
          }
          if (closure.state === 'succeeded') {
            const problem = dispatched.issue;
            const evidenceRefs = [...closure.evidenceRefs, ...(problem?.evidenceRefs ?? [])];
            record.error = {
              code: problem?.code ?? 'orchestration.dispatch.failed',
              ownerId: problem?.ownerId ?? RUNTIME_OWNER,
              message: problem?.reason ?? `orchestration dispatch ended as ${dispatched.status}`,
              retryable: dispatched.status === 'retryable',
              nextAction: problem
                ? `${problem.nextAction.kind}${problem.nextAction.ref ? `:${problem.nextAction.ref}` : ''}`
                : 'inspect orchestration assignment',
              evidenceRefs,
            };
            closure = {
              ...closure,
              state: 'blocked',
              evidenceRefs,
              nextAction: problem?.nextAction ?? { kind: 'recover', ref: `assignment.${assignment.assignmentId}` },
              conditionRef: problem?.conditionRef ?? `assignment.${assignment.assignmentId}`,
            };
          }
        }
      } else {
        if (this.options.providerRetry) {
          throw new RuntimeTaskControlError(
            'execution.retry.wiring.invalid',
            RUNTIME_OWNER,
            'provider retry must use the orchestrated provider execution path',
            'bind a task assembly for retry-10 provider execution',
          );
        }
        if (this.options.createTaskAssembly) {
          record.taskAssembly = this.options.createTaskAssembly({
            task: {
              id: record.taskId,
              organId: this.options.organId,
              title: record.title,
              directive: record.directive,
              directiveRevision: record.directiveRevision,
              state: record.state,
              memoryScope: 'task',
            },
            scope,
            checkpointJournal: this.options.checkpointStoreFor(record.taskId, scope.cycleId!),
          });
          this.bindChildCallManager(driver, record.taskAssembly);
        }
        await composition!.start();
        await composition!.submit(prompt);
        record.resolveExecutionReady?.(true);
        record.resolveExecutionReady = undefined;
        if (record.stopping || record.postCommitRecoveryPending) return;
        for await (const observation of composition!.observe()) {
          if (record.postCommitRecoveryPending) return;
          if (!observation.accepted) {
            this.pushEvent(record, operation, 'provider.error', 'stale', `late event rejected: ${observation.rejection.reason}`, [], RUNTIME_OWNER, false, 'ignore stale execution event');
            continue;
          }
          const event = observation.event as AgentEvent & { readonly providerEvent?: ProviderEvent };
          if (!event.providerEvent) continue;
          await this.recordProviderEvent(record, operation, event.providerEvent);
        }
        if (record.postCommitRecoveryPending) return;
        if (runtime!.snapshot().state === 'stopped') {
          this.finalize(record, 'stopped');
          return;
        }
        if (record.stopping) return;
        this.pushEvent(record, operation, 'execution.settling', 'settling', 'execution settling', []);
        record.state = 'settling';
        record.running = false;
        record.currentState = '收拢中';
        record.nextStep = '等待 checkpoint';
        record.allowedActions = [];
        closure = await composition!.settle();
      }
      if (record.postCommitRecoveryPending || !closure) return;
      const settledClosure = closure;
      record.running = false;
      record.currentState = '收拢中';
      record.nextStep = '等待 checkpoint';
      record.allowedActions = [];
      const closeDriver = driver ?? record.driver;
      if (!closeDriver) {
        throw new RuntimeTaskControlError(
          'provider.close.driver.missing',
          RUNTIME_OWNER,
          'provider execution closed without a driver to release',
          'inspect the executed provider binding',
        );
      }
      const cachedRetryClose = closedRetryDrivers.get(closeDriver);
      const closeProvider = async (): Promise<Pick<ProviderCloseResult, 'state' | 'evidenceRefs' | 'ownerId' | 'nextAction'> & { readonly retained: boolean }> => {
        if (cachedRetryClose) {
          this.activeExecutions.delete(operation.operationId.value);
          return {
            state: cachedRetryClose.state,
            evidenceRefs: cachedRetryClose.evidenceRefs,
            retained: false,
            ownerId: cachedRetryClose.ownerId,
            nextAction: cachedRetryClose.nextAction,
          };
        }
        return this.closeForExecution(operation.operationId, closeDriver, settledClosure.evidenceRefs);
      };
      if (closeDriver.standardTurn) {
        // The same canonical tail the cold resumed lane runs: adopt the real
        // closing checkpoint, close the owned Provider, align, then apply the
        // acceptance/disposition and admit the next turn only when it advances.
        await this.completeStandardTurn({
          record,
          operation,
          scope,
          standardTurn: closeDriver.standardTurn,
          expectedExecutionEpoch: operation.executionEpoch,
          closeOwned: async () => {
            const closed = await closeProvider();
            if (closed.state !== 'closed') {
              throw new RuntimeTaskControlError('provider.close.failed', closed.ownerId ?? RUNTIME_OWNER, `provider close is ${closed.state}`, toNextActionText(closed.nextAction) ?? 'inspect provider close evidence');
            }
          },
        });
        return;
      }
      await this.commitBusinessCheckpoint(record, scope, closure.state);
      const close = await closeProvider();
      if (close.state !== 'closed') {
        throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER, `provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'inspect provider close evidence');
      }
      this.pushEvent(record, operation, 'execution.terminal', closure.state, close.retained ? `execution ${closure.state}; provider retained for active executions` : `execution ${closure.state}; provider closed`, [...closure.evidenceRefs, ...close.evidenceRefs], undefined, undefined, undefined, undefined, 'final');
      this.finalize(record, closure.state);
    } catch (error) {
      if (record.release?.state === 'prepared') {
        const projection = errorFromUnknown(error);
        // No model/tool has started. Keep the allocation and its typed duty;
        // a projection checkpoint cannot claim that admission completed.
        record.error = projection;
        record.state = 'blocked';
        record.running = false;
        record.currentState = '执行准入受阻';
        record.nextStep = projection.nextAction;
        record.allowedActions = record.stopping ? ['retry-stop'] : ['stop'];
        this.pushEvent(record, operation, 'execution.terminal', 'blocked', projection.message,
          [], projection.ownerId, projection.retryable, projection.nextAction, { error: projection }, 'final');
        record.rejectRelease?.(error);
        record.rejectRelease = undefined;
        record.resolveRelease = undefined;
        record.releasePending = undefined;
        return;
      }
      if (record.postCommitRecoveryPending) return;
      const startupFailureBeforeReady = record.resolveExecutionReady !== undefined;
      if (startupFailureBeforeReady) {
        record.resolveExecutionReady?.(false);
        record.resolveExecutionReady = undefined;
      }
      if (record.stopping && !startupFailureBeforeReady) return;
      if (record.state === 'stopped' || runtime?.snapshot().state === 'stopped') {
        this.finalize(record, 'stopped');
        return;
      }
      const projection: MutableRuntimeTaskError = errorFromUnknown(error);
      if (driver?.standardTurn) {
        // Canonical turn failure retains its own checkpoint/recovery stage. The
        // generic terminal path must not append a second projection checkpoint.
        record.error = projection;
        record.running = false;
        record.state = 'blocked';
        record.allowedActions = [];
        record.nextStep = projection.nextAction;
        try {
          await this.closeForExecution(operation.operationId, driver, []);
        } catch (cleanupError) {
          projection.cleanupError = errorFromUnknown(cleanupError);
        }
        await this.tryPersistCurrentState(record,
          `turn-pending:${record.taskId.value}:${operation.operationId.value}:${projection.code}`, scope);
        this.pushEvent(record, operation, 'execution.terminal', 'blocked', projection.message,
          [], projection.ownerId, true, projection.nextAction, { error: projection }, 'final');
        return;
      }
      const businessScope: ScopeRef = { organId: this.options.organId, taskId: record.taskId, cycleId: scope.cycleId };
      const errorEvidenceRef: EvidenceRef = {
        evidenceId: id('evidence', `error-${record.operationId?.value ?? 'none'}-${record.checkpointSeq + 1}`),
        kind: 'operation',
        source: RUNTIME_OWNER,
        locator: `operation/${record.operationId?.value ?? 'none'}/error`,
        scope: businessScope,
      };
      const errorEvidenceRefs = [...operation.events.filter((event) => event.kind === 'provider.error').flatMap((event) => event.evidenceRefs), errorEvidenceRef];
      const committedCheckpoint = record.checkpoint;
      const committedContext = error instanceof RuntimeContextCommitError && committedCheckpoint !== undefined;
      let committedProjection: MutableRuntimeTaskError | undefined;
      if (committedContext && committedCheckpoint) {
        committedProjection = projection;
        record.error = committedProjection;
        this.markCommittedCheckpointRecovery(record, committedProjection.nextAction);
        this.pushEvent(
          record,
          operation,
          'execution.terminal',
          'blocked',
          'checkpoint committed; post-commit lifecycle requires recovery',
          [...errorEvidenceRefs, ...committedCheckpoint.evidenceRefs],
          committedProjection.ownerId,
          true,
          committedProjection.nextAction,
          { error: committedProjection },
          'final',
        );
      } else {
        record.error = projection;
        this.pushEvent(record, operation, 'provider.error', 'failed', projection.message, [], projection.ownerId, projection.retryable, projection.nextAction);
      }
      const outcome: 'failed' | 'blocked' = 'failed';
      const runtimeState = runtime?.snapshot().state ?? 'failed';
      let cleanupEvidenceRefs: readonly EvidenceRef[] = [];
      let cleanupFailure: unknown;
      let abandonedProviderOperation = false;
      if (composition && runtimeState === 'running') {
        try {
          const closure = await composition.settle();
          cleanupEvidenceRefs = closure.evidenceRefs;
          // An ordinary settle cannot complete a fully observed waiting execution:
          // the adapter retains the provider session, so close() would reject with
          // close.pending.executions and mask the real failure. The only
          // contract-sanctioned release is the standard stop control.
          abandonedProviderOperation = closure.state === 'waiting' || closure.state === 'blocked';
        } catch (settleError) {
          cleanupFailure = settleError;
        }
      }
      if (abandonedProviderOperation && cleanupFailure === undefined) {
        try {
          const stopped = await this.stopAbandonedProviderExecution(record, operation, scope);
          cleanupEvidenceRefs = [...cleanupEvidenceRefs, ...stopped.evidenceRefs];
        } catch (stopError) {
          cleanupFailure = stopError;
        }
      }
      if (driver) {
        try {
          const close = await this.closeForExecution(operation.operationId, driver, [...errorEvidenceRefs, ...cleanupEvidenceRefs]);
          cleanupEvidenceRefs = [...cleanupEvidenceRefs, ...close.evidenceRefs];
          if (close.state !== 'closed') {
            throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER, `provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'inspect provider close evidence');
          }
          // A retained close means another execution still owns the shared
          // provider, so this task's provider was never actually closed. Any
          // pending cleanup failure must survive: the abandoned execution may
          // still be active, so the task stays blocked with retry-stop instead
          // of reporting a clean failure.
          if (!close.retained) cleanupFailure = undefined;
        } catch (cleanupError) {
          cleanupFailure = cleanupError;
        }
      }
      if (committedProjection && committedCheckpoint) {
        if (cleanupFailure) {
          const cleanupProjection: MutableRuntimeTaskError = errorFromUnknown(cleanupFailure);
          if (!cleanupProjection.evidenceRefs?.length && cleanupEvidenceRefs.length > 0) {
            cleanupProjection.evidenceRefs = cleanupEvidenceRefs;
          }
          committedProjection.cleanupError = cleanupProjection;
          record.error = committedProjection;
          this.pushEvent(
            record,
            operation,
            'provider.error',
            'blocked',
            cleanupProjection.message,
            cleanupEvidenceRefs,
            cleanupProjection.ownerId,
            true,
            cleanupProjection.nextAction,
            { error: committedProjection },
          );
        }
        return;
      }
      if (cleanupFailure) {
        const cleanupProjection: MutableRuntimeTaskError = errorFromUnknown(cleanupFailure);
        if (!cleanupProjection.evidenceRefs?.length && cleanupEvidenceRefs.length > 0) {
          cleanupProjection.evidenceRefs = cleanupEvidenceRefs;
        }
        // The runtime owns whether a stop control can still reach the provider
        // session: a `failed`/`unknown` runtime rejects stop (assertStopTarget),
        // RCC v3 rejects stop once the stream is terminal, and a fenced stop
        // claim left active by a failed attention publication is not retryable.
        // Ask the runtime instead of re-deriving admissibility from state, so we
        // never advertise a retry-stop that the stop lifecycle would refuse.
        const stopIsPossible = runtime?.canStartStopControl(operation.operationId) ?? false;
        projection.cleanupError = cleanupProjection;
        record.error = projection;
        record.state = 'blocked';
        record.running = stopIsPossible;
        record.stopping = stopIsPossible;
        record.currentState = '失败收拢未完成';
        record.nextStep = cleanupProjection.nextAction;
        record.allowedActions = stopIsPossible ? ['retry-stop'] : [];
        record.updatedAt = this.now().toISOString();
        this.pushEvent(
          record,
          operation,
          'provider.error',
          'blocked',
          cleanupProjection.message,
          cleanupEvidenceRefs,
          cleanupProjection.ownerId,
          true,
          cleanupProjection.nextAction,
          { error: projection },
        );
        try {
          await this.commitBusinessCheckpoint(record, scope, 'blocked', errorEvidenceRefs);
        } catch (checkpointError) {
          const checkpointProjection = errorFromUnknown(checkpointError);
          record.error = checkpointProjection;
          record.nextStep = checkpointProjection.nextAction;
        }
        return;
      }
      try {
        await this.commitBusinessCheckpoint(record, scope, outcome, errorEvidenceRefs);
      } catch (checkpointError) {
        const checkpointProjection = errorFromUnknown(checkpointError);
        record.error = checkpointProjection;
        this.pushEvent(
          record,
          operation,
          'provider.error',
          'blocked',
          checkpointProjection.message,
          [],
          checkpointProjection.ownerId,
          true,
          checkpointProjection.nextAction,
          { error: checkpointProjection },
        );
        this.finalize(record, 'blocked');
        return;
      }
      this.pushEvent(
        record,
        operation,
        'execution.terminal',
        outcome,
        projection.message,
        [...errorEvidenceRefs, ...cleanupEvidenceRefs],
        projection.ownerId,
        projection.retryable,
        projection.nextAction,
        { error: projection },
        'final',
      );
      this.finalize(record, outcome);
    } finally {
      record.rejectRelease?.(new RuntimeTaskControlError('execution.not.released', RUNTIME_OWNER,
        'execution ended without release', 'inspect execution admission responsibility'));
      record.rejectRelease = undefined;
      record.resolveRelease = undefined;
      record.resolveExecutionReady?.(false);
      record.resolveExecutionReady = undefined;
      this.activeExecutions.delete(operation.operationId.value);
    }
  }

  private async closeForExecution(
    operationId: OperationId,
    driver: RuntimeExecutionDriver,
    evidenceRefs: readonly EvidenceRef[],
  ): Promise<Pick<ProviderCloseResult, 'state' | 'evidenceRefs' | 'ownerId' | 'nextAction'> & { readonly retained: boolean }> {
    this.activeExecutions.delete(operationId.value);
    if (this.activeExecutions.size > 0) {
      return { state: 'closed', evidenceRefs, retained: true };
    }
    const result = await driver.close();
    return {
      state: result.state,
      evidenceRefs: result.evidenceRefs,
      retained: false,
      ownerId: result.ownerId,
      nextAction: result.nextAction,
    };
  }

  /**
   * Releases a provider execution that an ordinary settle left `waiting`/`blocked`.
   * The adapter keeps the session for a non-final settlement, so the failure
   * cleanup must drive the standard stop control (requestStop -> settle) to reach
   * a final `stopped` closure. The stop is resource release only; the task still
   * terminates as `failed` with its original error.
   */
  private async stopAbandonedProviderExecution(
    record: TaskRecord,
    operation: OperationRecord,
    executionScope: ScopeRef,
  ): Promise<{ readonly checkpoint: Checkpoint; readonly evidenceRefs: readonly EvidenceRef[] }> {
    if (!record.runtime || !record.driver || !record.composition || !record.operationId || !record.executionEpoch) {
      throw new RuntimeTaskControlError('task.not.recoverable', RUNTIME_OWNER, 'abandoned provider execution has no bound runtime', 'start a new execution');
    }
    const stopScope: ScopeRef = { ...executionScope };
    const recoveryStateRef: EvidenceRef = {
      evidenceId: id('evidence', `recovery-${record.operationId.value}`),
      kind: 'operation',
      source: RUNTIME_OWNER,
      locator: `operation/${record.operationId.value}/recovery`,
      scope: stopScope,
    };
    const runtimeState = record.runtime.snapshot().state;
    const stopRequestState = runtimeState === 'admitted' || runtimeState === 'running' || runtimeState === 'waiting' || runtimeState === 'blocked'
      ? runtimeState
      : 'blocked';
    const command: RequestStopCommand = {
      source: 'control',
      command: 'steer.request-stop',
      actorKind: 'harness-control',
      hasStopPermission: true,
      organId: this.options.organId,
      taskId: record.taskId,
      executionEpoch: record.executionEpoch,
      currentState: stopRequestState,
      runtimeId: this.runtimeId(record.operationId),
    };
    try {
      const result = await executeStopControl({
        command,
        driver: record.driver,
        checkpointPort: record.composition.checkpointCommitPort(record.checkpoint ?? null),
        attentionPort: this.options.attentionPort,
        currentOrganId: this.options.organId,
        currentTaskId: record.taskId,
        currentEpoch: record.executionEpoch,
        operationId: record.operationId,
        scope: stopScope,
        cycleId: executionScope.cycleId!,
        ownerId: RUNTIME_OWNER,
        previousCheckpoint: record.checkpoint ?? null,
        checkpointSeq: record.checkpointSeq + 1,
        directiveRevision: record.directiveRevision,
        stopReason: 'failure-cleanup',
        recoveryStateRef,
        runtime: record.runtime,
      });
      if (result.state !== 'stopped') {
        throw new RuntimeTaskControlError('stop.failed', result.ownerId, 'abandoned provider execution did not reach stopped', toNextActionText(result.nextAction) ?? 'retry stop settlement');
      }
      record.checkpoint = result.checkpoint;
      record.checkpointSeq = result.checkpoint.seq;
      this.pushEvent(record, operation, 'checkpoint.committed', 'stopped', 'failure cleanup released the abandoned provider execution', result.checkpoint.evidenceRefs);
      return { checkpoint: result.checkpoint, evidenceRefs: result.closure.evidenceRefs };
    } catch (error) {
      if (error instanceof StopSettlementCommitError && error.checkpointCommitted && error.recovery) {
        await this.throwCommittedStopRecovery(record, operation, error, error.recovery);
      }
      throw error instanceof RuntimeTaskControlError
        ? error
        : new RuntimeTaskControlError('stop.failed', RUNTIME_OWNER, error instanceof Error ? error.message : String(error), 'inspect the provider stop settlement');
    }
  }

  private async recordProviderEvent(record: TaskRecord, operation: OperationRecord, event: ProviderEvent): Promise<void> {
    const executionFact = event.toolResult?.executionFact;
    if (executionFact !== undefined) {
      const result = event.toolResult!;
      const invocation = operation.events.find((candidate) => (
        candidate.kind === 'provider.tool' && candidate.callId === result.callId
      ));
      if (event.taskId.value !== record.taskId.value
        || event.operationId.value !== operation.operationId.value
        || event.executionEpoch !== operation.executionEpoch
        || result.taskId.value !== record.taskId.value
        || result.operationId.value !== operation.operationId.value
        || result.executionEpoch !== operation.executionEpoch) {
        throw new Error('provider tool execution fact does not match the current operation identity');
      }
      if (invocation === undefined
        || invocation.toolId !== result.toolId
        || invocation.requestId === undefined
        || event.requestId !== invocation.requestId) {
        throw new Error('provider tool execution fact does not match its operation-owned request and call');
      }
      // Provider owns binding and route provenance; the invocation event owns
      // the request/call context. Validate the attached public shape and its
      // result envelope before adding the fact to this runtime projection.
      validateProviderEvent(event, executionFact.identity);
    }
    const kind = runtimeProviderEventKind(event);
    const state = event.terminalState ?? (event.error ? 'failed' : event.kind);
    const summary = providerEventSummary(event);
    const error = event.kind === 'error' && event.error ? providerErrorProjection(event.error) : undefined;
    let taskOutput: string | undefined;
    if (event.kind === 'output') {
      if (event.summary !== undefined) {
        record.output = appendOutput(record.output, event.summary);
        taskOutput = record.output;
      }
      record.updatedAt = this.now().toISOString();
    }
    await this.commitAcceptedPublicOutput(record, operation, event);
    const toolProjection = event.toolCall !== undefined
      ? {
        callId: event.toolCall.callId,
        toolId: event.toolCall.toolId,
        arguments: event.toolCall.arguments,
      }
      : event.toolResult !== undefined
        ? {
          callId: event.toolResult.callId,
          toolId: event.toolResult.toolId,
          status: event.toolResult.status,
          ...(event.toolResult.outputRef === undefined ? {} : { outputRef: event.toolResult.outputRef }),
          ...(event.toolResult.outputDigest === undefined ? {} : { outputDigest: event.toolResult.outputDigest }),
          ...(executionFact === undefined ? {} : { executionFact }),
          ...(event.toolResult.error === undefined ? {} : { error: providerErrorProjection(event.toolResult.error) }),
        }
        : undefined;
    const outputRefs = event.outputRefs;
    this.pushEvent(
      record,
      operation,
      kind,
      state,
      summary,
      event.evidenceRefs,
      event.ownerId,
      event.error ? event.error.retryable === 'retryable' : undefined,
      toNextActionText(event.nextAction),
      {
        taskOutput,
        error,
        // The provider binding reported this identity on the event itself. Carry
        // it verbatim; when the provider reported none, no turn id is added.
        turn: {
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          ...(event.parentRequestId === undefined ? {} : { parentRequestId: event.parentRequestId }),
          ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
        },
        tool: toolProjection,
        ...(event.externalResponseId === undefined ? {} : { externalResponseId: event.externalResponseId }),
        ...(event.responseModel === undefined ? {} : { responseModel: event.responseModel }),
        ...(outputRefs === undefined ? {} : { outputRefs }),
      },
      event.kind === 'terminal' ? 'provider' : undefined,
    );
    if (event.kind === 'tool') record.currentNode = RUNTIME_NODE_MARKERS.providerTool;
    if (event.kind === 'model') record.currentNode = RUNTIME_NODE_MARKERS.providerModel;
    if (error) record.error = error;
  }

  /**
   * Commits the canonical public output for one accepted Provider event.
   *
   * A native standard-turn execution owns its public result through the typed
   * accepted delivery, so its Provider output/drain stays process observation
   * and is never committed as the canonical body. The split is the real driver
   * lifecycle identity, never event text or metadata. Other execution kinds keep
   * the existing Provider output publication contract.
   */
  private async commitAcceptedPublicOutput(record: TaskRecord, operation: OperationRecord, event: ProviderEvent): Promise<void> {
    if (event.kind !== 'output') return;
    if (record.driver?.standardTurn !== undefined) return;
    const text = event.summary;
    if (text === undefined || text.trim().length === 0) return;
    const storeFor = this.options.publicOutputStoreFor;
    if (storeFor === undefined) return;
    const scope = this.scopes.get(operation.operationId.value);
    const cycleId = scope?.cycleId;
    if (!scope || !cycleId) {
      record.publicOutput = this.unknownPublicOutput(record.publicOutput);
      return;
    }
    const binding: PublicOutputBinding = {
      scope,
      executionEpoch: operation.executionEpoch,
      ...(event.turnId === undefined ? {} : { providerTurnId: event.turnId }),
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    };
    const candidate: PublicOutputCandidate = { binding, sourceId: event.eventId, text };
    record.publicOutput = this.pendingPublicOutput(record.publicOutput);
    try {
      const store = storeFor(record.taskId, cycleId);
      await store.commitPublicOutput(candidate);
      record.publicOutput = await store.readPublicOutputs(this.publicOutputSelection(scope, operation.executionEpoch));
    } catch (error) {
      record.publicOutput = this.unknownPublicOutput(record.publicOutput);
      if (record.error === undefined) {
        record.error = {
          code: 'public-output.commit.failed', ownerId: RUNTIME_OWNER,
          message: error instanceof Error ? error.message : String(error), retryable: false,
          nextAction: 'inspect the public-output journal and retry the same candidate',
        };
      }
    }
  }

  private unknownPublicOutput(current: PublicOutputPublication | undefined): PublicOutputPublication {
    return { state: 'unknown', commits: current?.commits ?? [],
      ...(current?.publicCommitWatermark === undefined ? {} : { publicCommitWatermark: current.publicCommitWatermark }) };
  }

  private pendingPublicOutput(current: PublicOutputPublication | undefined): PublicOutputPublication {
    return { state: 'pending', commits: current?.commits ?? [],
      ...(current?.publicCommitWatermark === undefined ? {} : { publicCommitWatermark: current.publicCommitWatermark }) };
  }

  private publicOutputSelection(scope: ScopeRef, executionEpoch: number): PublicOutputBinding {
    return { scope, executionEpoch };
  }

  private async hydratePublicOutput(task: TaskRecord, scope: ScopeRef): Promise<void> {
    const storeFor = this.options.publicOutputStoreFor;
    if (storeFor === undefined || !scope.cycleId) return;
    const executionEpoch = task.executionEpoch ?? this.operations.get(task.operationId!.value)?.executionEpoch;
    if (executionEpoch === undefined) {
      task.publicOutput = this.unknownPublicOutput(task.publicOutput);
      return;
    }
    const binding = this.publicOutputSelection(scope, executionEpoch);
    try {
      task.publicOutput = await storeFor(task.taskId, scope.cycleId).readPublicOutputs(binding);
    } catch {
      task.publicOutput = this.unknownPublicOutput(task.publicOutput);
    }
  }

  private async commitBusinessCheckpoint(record: TaskRecord, executionScope: ScopeRef, outcome: string, extraEvidenceRefs: readonly EvidenceRef[] = []): Promise<void> {
    const checkpointOutcome = (['succeeded', 'waiting', 'blocked', 'failed', 'cancelled', 'unknown'] as const).find((candidate) => candidate === outcome) ?? 'unknown';
    // Failure cleanup may commit a stop-control checkpoint before the business
    // terminal checkpoint. A non-stopped checkpoint must keep the same operation
    // identity as its predecessor, so inherit the operation id and align any
    // business-scoped evidence that predates the inheritance.
    const inheritedOperationId = record.checkpoint?.scope.operationId;
    const businessScope: ScopeRef = inheritedOperationId === undefined
      ? { organId: this.options.organId, taskId: record.taskId, cycleId: executionScope.cycleId }
      : { organId: this.options.organId, taskId: record.taskId, cycleId: executionScope.cycleId, operationId: inheritedOperationId };
    const alignEvidenceScope = (ref: EvidenceRef): EvidenceRef => {
      if (inheritedOperationId === undefined || ref.scope.operationId !== undefined) return ref;
      if (!sameId(ref.scope.organId, businessScope.organId)
        || !sameId(ref.scope.taskId, businessScope.taskId)
        || !sameId(ref.scope.cycleId, businessScope.cycleId)) return ref;
      return { ...ref, scope: businessScope };
    };
    const recoveryStateRef: EvidenceRef = {
      evidenceId: id('evidence', `recovery-${record.operationId?.value ?? 'none'}-${record.checkpointSeq + 1}`),
      kind: 'operation',
      source: RUNTIME_OWNER,
      locator: `operation/${record.operationId?.value ?? 'none'}/checkpoint-recovery`,
      scope: businessScope,
    };
    const checkpointRef: EvidenceRef = {
      evidenceId: id('evidence', `checkpoint-${record.operationId?.value ?? 'none'}-${record.checkpointSeq + 1}`),
      kind: 'operation',
      source: RUNTIME_OWNER,
      locator: `operation/${record.operationId?.value ?? 'none'}/checkpoint`,
      scope: businessScope,
    };
    const evidence: readonly EvidenceRef[] = [checkpointRef, ...extraEvidenceRefs.map(alignEvidenceScope)];
    const next: NextAction = checkpointOutcome === 'waiting'
      ? { kind: 'wait', ref: `recovery-${record.operationId?.value ?? 'none'}` }
      : checkpointOutcome === 'failed' || checkpointOutcome === 'blocked' || checkpointOutcome === 'unknown'
        ? { kind: 'recover', ref: `task://${record.taskId.value}/recovery` }
        : checkpointOutcome === 'cancelled'
          ? { kind: 'stop', ref: `task://${record.taskId.value}/terminal` }
          : { kind: 'continue', ref: `task://${record.taskId.value}/next` };
    const checkpoint: Checkpoint = {
      // The checkpoint sequence is per task, but execution epochs reuse the
      // same task id. Include the epoch so a later execution cannot commit
      // under the same checkpoint identity as an earlier epoch; each epoch
      // still keeps its own root sequence (seq 1, no predecessor).
      id: id('checkpoint', `checkpoint-${record.taskId.value}-${record.executionEpoch ?? 1}-${record.checkpointSeq + 1}`),
      scope: businessScope,
      cycleId: businessScope.cycleId!,
      seq: record.checkpointSeq + 1,
      previousCheckpointId: record.checkpoint?.id ?? null,
      directiveRevision: record.directiveRevision,
      executionEpoch: record.executionEpoch ?? 1,
      outcome: checkpointOutcome,
      summary: `execution ${outcome}`,
      recoveryStateRef,
      evidenceRefs: evidence,
      next,
    };
    if (!record.composition && !record.checkpointBoundary) {
      throw new RuntimeTaskControlError(
        'execution.composition.missing',
        RUNTIME_OWNER,
        'execution composition is missing at checkpoint commit boundary',
        'start a new execution through the UI runtime entry',
      );
    }
    let committed: RuntimeContextCommitResult;
    try {
      committed = record.composition
        ? await record.composition.commitCheckpoint(checkpoint, record.checkpoint ?? null)
        : await record.checkpointBoundary!.commit(checkpoint, record.checkpoint ?? null);
    } catch (error) {
      if (error instanceof RuntimeContextCommitError) {
        this.recordCommittedCheckpoint(record, error.committed, checkpointOutcome);
      }
      throw error;
    }
    const previousCheckpoint = record.checkpoint ?? null;
    this.recordCommittedCheckpoint(record, committed, checkpointOutcome);
    if (this.options.checkpointBoundary) {
      try {
        await this.options.checkpointBoundary.publish({
          checkpoint: committed.checkpoint,
          previous: previousCheckpoint,
          ...(committed.recordDigest === undefined ? {} : { recordDigest: committed.recordDigest }),
        });
      } catch (error) {
        throw new RuntimeContextCommitError(committed, error);
      }
    }
  }

  private recordCommittedCheckpoint(
    record: TaskRecord,
    committed: RuntimeContextCommitResult,
    outcome: Checkpoint['outcome'],
  ): void {
    record.checkpoint = committed.checkpoint;
    record.checkpointSeq = committed.checkpoint.seq;
    const operation = record.operationId ? this.operations.get(record.operationId.value) : undefined;
    if (operation) this.pushEvent(record, operation, 'checkpoint.committed', outcome, committed.checkpoint.summary, committed.checkpoint.evidenceRefs);
  }

  private markCommittedCheckpointRecovery(record: TaskRecord, nextAction: string): void {
    record.postCommitRecoveryPending = true;
    record.state = 'blocked';
    record.running = false;
    record.stopping = false;
    record.allowedActions = [];
    record.currentState = 'checkpoint 已提交，等待恢复';
    record.nextStep = nextAction;
    record.currentNode = RUNTIME_NODE_MARKERS.checkpointCommit;
    record.updatedAt = this.now().toISOString();
  }

  private async throwCommittedStopRecovery(
    record: TaskRecord,
    operation: OperationRecord,
    error: StopSettlementCommitError,
    recovery: StopSettlementRecovery,
  ): Promise<never> {
    const projection = recoveryProjection(recovery);
    const committedProjection: MutableRuntimeTaskError = projection;
    record.checkpoint = error.prepared.checkpoint;
    record.checkpointSeq = error.prepared.checkpoint.seq;
    record.error = committedProjection;
    this.markCommittedCheckpointRecovery(record, committedProjection.nextAction);
    this.pushEvent(
      record,
      operation,
      'execution.terminal',
      'blocked',
      'stopped checkpoint committed; post-commit lifecycle requires recovery',
      [...error.prepared.checkpoint.evidenceRefs, ...error.prepared.closure.evidenceRefs],
      committedProjection.ownerId,
      true,
      committedProjection.nextAction,
      { error: committedProjection },
      'final',
    );
    let cleanupError: RuntimeTaskError | undefined;
    if (record.driver) {
      try {
        const close = await this.closeForExecution(
          operation.operationId,
          record.driver,
          [...error.prepared.checkpoint.evidenceRefs, ...error.prepared.closure.evidenceRefs],
        );
        if (close.state !== 'closed') {
          cleanupError = {
            code: 'provider.close.failed',
            ownerId: close.ownerId ?? RUNTIME_OWNER,
            message: `provider close is ${close.state}`,
            retryable: false,
            nextAction: toNextActionText(close.nextAction) ?? 'inspect provider close evidence',
            evidenceRefs: close.evidenceRefs,
          };
        }
      } catch (failure) {
        cleanupError = errorFromUnknown(failure);
      }
    }
    if (cleanupError) committedProjection.cleanupError = cleanupError;
    if (cleanupError) {
      record.error = committedProjection;
      this.pushEvent(
        record,
        operation,
        'provider.error',
        'blocked',
        cleanupError.message,
        cleanupError.evidenceRefs ?? [],
        cleanupError.ownerId,
        true,
        cleanupError.nextAction,
        { error: committedProjection },
      );
    }
    throw new RuntimeTaskControlError(
      'execution.context-commit-hook.blocked',
      projection.ownerId,
      projection.message,
      projection.nextAction,
    );
  }

  private finalize(record: TaskRecord, state: LifecycleState): void {
    record.state = state;
    record.running = false;
    record.stopping = false;
    record.allowedActions = state === 'succeeded' || state === 'stopped' || state === 'failed' ? ['start'] : [];
    record.currentState = state === 'succeeded' ? '已完成' : state === 'stopped' ? '已停止' : state === 'failed' ? '失败' : state;
    record.currentNode = state === 'stopped' ? RUNTIME_NODE_MARKERS.checkpointCommit : record.currentNode;
    record.nextStep = state === 'succeeded'
      ? '可发起新的执行或停止'
      : state === 'stopped'
        ? '已收拢；可发起新的执行'
        : '检查错误 owner 与 next action';
    record.updatedAt = this.now().toISOString();
    if (record.operationId) this.scopes.delete(record.operationId.value);
  }

  private pushEvent(
    record: TaskRecord,
    operation: OperationRecord,
    kind: RuntimeTaskEventKind,
    state: string,
    summary: string,
    evidenceRefs: readonly EvidenceRef[],
    ownerId?: string,
    retryable?: boolean,
    nextAction?: string,
    details?: {
      readonly taskOutput?: string;
      readonly error?: RuntimeTaskError;
      /**
       * Real provider-reported request identity and occurrence time. Only the
       * provider binding may produce these; the runtime never invents them.
       */
      readonly turn?: {
        readonly turnId?: string;
        readonly requestId?: string;
        readonly parentRequestId?: string;
        readonly occurredAt?: string;
      };
      readonly tool?: {
        readonly callId: string;
        readonly toolId: string;
        readonly arguments?: unknown;
        readonly status?: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';
        readonly error?: RuntimeTaskError;
        readonly outputRef?: string;
        readonly outputDigest?: string;
        readonly executionFact?: ToolExecutionFact;
      };
      readonly externalResponseId?: string;
      readonly responseModel?: string;
      readonly outputRefs?: readonly string[];
    },
    terminalPhase?: 'provider' | 'final',
  ): void {
    operation.seq += 1;
    const event: RuntimeTaskEvent = {
      eventId: `${operation.operationId.value}-${operation.seq}`,
      seq: operation.seq,
      occurredAt: this.now().toISOString(),
      taskId: record.taskId,
      operationId: operation.operationId.value,
      executionEpoch: operation.executionEpoch,
      kind,
      state,
      summary,
      evidenceRefs,
      ownerId,
      retryable,
      nextAction,
      ...(terminalPhase === undefined ? {} : { terminalPhase }),
      ...(details?.turn?.turnId === undefined ? {} : { turnId: details.turn.turnId }),
      ...(details?.turn?.requestId === undefined ? {} : { requestId: details.turn.requestId }),
      ...(details?.turn?.parentRequestId === undefined ? {} : { parentRequestId: details.turn.parentRequestId }),
      ...(details?.turn?.occurredAt === undefined ? {} : { providerOccurredAt: details.turn.occurredAt }),
      ...(details?.tool === undefined ? {} : {
        callId: details.tool.callId,
        toolId: details.tool.toolId,
        ...(details.tool.arguments === undefined ? {} : { arguments: details.tool.arguments }),
        ...(details.tool.status === undefined ? {} : { status: details.tool.status }),
        ...(details.tool.error === undefined ? {} : { error: details.tool.error }),
        ...(details.tool.outputRef === undefined ? {} : { outputRef: details.tool.outputRef }),
        ...(details.tool.outputDigest === undefined ? {} : { outputDigest: details.tool.outputDigest }),
        ...(details.tool.executionFact === undefined ? {} : { executionFact: details.tool.executionFact }),
      }),
      ...(details?.externalResponseId === undefined ? {} : { externalResponseId: details.externalResponseId }),
      ...(details?.responseModel === undefined ? {} : { responseModel: details.responseModel }),
      ...(details?.outputRefs === undefined ? {} : { outputRefs: details.outputRefs }),
    };
    operation.events.push(event);
    record.events.push(event);
    record.updatedAt = event.occurredAt;
    this.journal?.append({
      kind: 'operation.event',
      operationId: operation.operationId,
      event,
      taskOutput: details?.taskOutput,
      error: details?.error,
    });
    this.listeners.emit(operation.operationId.value, event);
  }

  private replayJournal(): void {
    let records: readonly RuntimeTaskJournalRecord[];
    try {
      records = this.journal?.replay() ?? [];
    } catch (error) {
      if (
        error instanceof RuntimeTaskControlError
        || (error !== null && typeof error === 'object' && 'code' in error)
      ) {
        throw error;
      }
      throw new RuntimeTaskControlError(
        'journal.corrupt',
        RUNTIME_OWNER,
        error instanceof Error ? error.message : String(error),
        'repair or discard the UI runtime journal before restarting',
      );
    }
    for (const record of records) {
      switch (record.kind) {
        case 'task.created': {
          this.taskCounter = Math.max(this.taskCounter, record.taskCounter);
          if (this.tasks.has(record.taskId.value)) break;
          this.tasks.set(record.taskId.value, {
            taskId: record.taskId,
            title: record.title,
            directive: record.directive,
            directiveRevision: record.directiveRevision,
            state: 'created',
            currentState: '已创建',
            nextStep: '选择模式并发起执行',
            input: '',
            output: '',
            currentNode: RUNTIME_NODE_MARKERS.inputReceived,
            createdAt: record.createdAt,
            updatedAt: record.createdAt,
            allowedActions: ['start'],
            events: [],
            checkpointSeq: 0,
            orchestrated: false,
            running: false,
            stopping: false,
          });
          break;
        }
        case 'task.updated': {
          const task = this.tasks.get(record.taskId.value);
          if (task) {
            task.title = record.title;
            task.directive = record.directive;
            task.directiveRevision = record.directiveRevision;
            task.updatedAt = record.updatedAt;
          }
          break;
        }
        case 'task.deleted': {
          this.deletedTaskIds.add(record.taskId.value);
          this.tasks.delete(record.taskId.value);
          break;
        }
        case 'operation.prepared': {
          this.operationCounter = Math.max(this.operationCounter, record.operationCounter);
          this.cycleCounter = Math.max(this.cycleCounter, record.cycleCounter);
          const existing = this.operations.get(record.allocation.operationId.value);
          if (existing && existing.allocation !== undefined) {
            if (
              existing.allocation.taskId.value !== record.allocation.taskId.value
              || existing.allocation.operationId.value !== record.allocation.operationId.value
              || existing.allocation.executionEpoch !== record.allocation.executionEpoch
            ) {
              throw new RuntimeTaskControlError(
                'journal.corrupt',
                RUNTIME_OWNER,
                `journal prepared allocation ${record.allocation.operationId.value} does not match its first allocation`,
                'repair or discard the UI runtime journal before restarting',
              );
            }
            break;
          }
          const operation = existing ?? {
            operationId: record.allocation.operationId,
            taskId: record.allocation.taskId,
            executionEpoch: record.allocation.executionEpoch,
            input: record.input,
            orchestrated: record.allocation.orchestrated,
            events: [],
            seq: 0,
            allocation: record.allocation,
          };
          operation.allocation = record.allocation;
          this.operations.set(operation.operationId.value, operation);
          this.scopes.set(operation.operationId.value, record.allocation.scope);
          const task = this.tasks.get(record.allocation.taskId.value);
          if (task) {
            task.allocation = record.allocation;
            task.operationId = operation.operationId;
            task.executionEpoch = operation.executionEpoch;
            task.cycleId = record.allocation.scope.cycleId;
            task.input = operation.input;
            task.orchestrated = operation.orchestrated;
            task.release = { state: 'prepared' };
          }
          break;
        }
        case 'operation.started': {
          this.operationCounter = Math.max(this.operationCounter, record.operationCounter);
          this.cycleCounter = Math.max(this.cycleCounter, record.cycleCounter);
          const existing = this.operations.get(record.operationId.value);
          if (
            existing
            && (existing.taskId.value !== record.taskId.value || existing.executionEpoch !== record.executionEpoch)
          ) {
            throw new RuntimeTaskControlError(
              'journal.corrupt',
              RUNTIME_OWNER,
              `journal operation ${record.operationId.value} identity does not match its first start`,
              'repair or discard the UI runtime journal before restarting',
            );
          }
          const operation = existing ?? {
            operationId: record.operationId,
            taskId: record.taskId,
            executionEpoch: record.executionEpoch,
            input: record.input,
            orchestrated: record.orchestrated === true,
            events: [],
            seq: 0,
          };
          this.operations.set(record.operationId.value, operation);
          this.scopes.set(record.operationId.value, record.scope);
          const task = this.tasks.get(record.taskId.value);
          if (task) task.cycleId = record.scope.cycleId;
          break;
        }
        case 'operation.event': {
          const operation = this.operations.get(record.operationId.value);
          if (!operation) {
            throw new RuntimeTaskControlError(
              'journal.corrupt',
              RUNTIME_OWNER,
              `journal event ${record.event.eventId} references unknown operation ${record.operationId.value}`,
              'repair or discard the UI runtime journal before restarting',
            );
          }
          if (
            record.event.operationId !== record.operationId.value
            || record.event.taskId.value !== operation.taskId.value
            || record.event.executionEpoch !== operation.executionEpoch
          ) {
            throw new RuntimeTaskControlError(
              'journal.corrupt',
              RUNTIME_OWNER,
              `journal event ${record.event.eventId} identity does not match operation ${record.operationId.value}`,
              'repair or discard the UI runtime journal before restarting',
            );
          }
          const task = this.tasks.get(operation.taskId.value);
          if (!task) {
            if (this.deletedTaskIds.has(operation.taskId.value)) break;
            throw new RuntimeTaskControlError(
              'journal.corrupt',
              RUNTIME_OWNER,
              `journal event ${record.event.eventId} references unknown task ${operation.taskId.value}`,
              'repair or discard the UI runtime journal before restarting',
            );
          }
          operation.events.push(record.event);
          operation.seq = Math.max(operation.seq, record.event.seq);
          task.events.push(record.event);
          task.updatedAt = record.event.occurredAt;
          if (record.event.kind === 'execution.started') {
            task.operationId = operation.operationId;
            task.executionEpoch = operation.executionEpoch;
            task.input = operation.input;
            task.orchestrated = operation.orchestrated;
            task.currentNode = RUNTIME_NODE_MARKERS.providerExecute;
          }
          if (record.taskOutput !== undefined) task.output = record.taskOutput;
          if (record.error) task.error = record.error;
          if (record.event.kind === 'provider.tool') task.currentNode = RUNTIME_NODE_MARKERS.providerTool;
          if (record.event.kind === 'provider.model') task.currentNode = RUNTIME_NODE_MARKERS.providerModel;
          break;
        }
        case 'explicit-brain.state': {
          break;
        }
      }
    }
    // Journal replay restores only disposable projection facts. Lifecycle,
    // checkpoint truth, and allowed actions are reconciled from the
    // authoritative checkpoint journal by hydrate().
    for (const task of this.tasks.values()) {
      if (!task.operationId) continue;
      task.state = 'unknown';
      task.running = false;
      task.stopping = false;
      task.currentState = '需要恢复确认';
      task.nextStep = '从权威 checkpoint 恢复状态';
      task.allowedActions = [];
    }
  }

  async hydrate(): Promise<void> {
    for (const task of this.tasks.values()) {
      if (!task.operationId) continue;
      const scope = this.scopes.get(task.operationId.value);
      if (!scope?.cycleId) {
        this.markRecoveryRequired(task);
        continue;
      }
      await this.hydratePublicOutput(task, scope);
      try {
        const store = this.options.checkpointStoreFor(task.taskId, scope.cycleId);
        const businessScope: ScopeRef = {
          organId: this.options.organId,
          taskId: task.taskId,
          cycleId: scope.cycleId,
        };
        const latest = await store.readLatest(scope) ?? await store.readLatest(businessScope);
        if (!latest || !sameCheckpointBusinessScope(scope, latest.checkpoint.scope)) {
          this.markRecoveryRequired(task);
          continue;
        }
        const recalled = await recallCheckpoint(store, { ownerId: RUNTIME_OWNER, scope: latest.checkpoint.scope });
        if (
          !recalled
          || recalled.checkpoint.id.value !== latest.checkpoint.id.value
          || !sameCheckpointBusinessScope(scope, recalled.checkpoint.scope)
        ) {
          this.markRecoveryRequired(task);
          continue;
        }
        const checkpoint = recalled.checkpoint;
        task.checkpoint = checkpoint;
        task.checkpointSeq = checkpoint.seq;
        if (task.error?.code === 'execution.context-commit-hook.blocked') {
          this.markCommittedCheckpointRecovery(task, task.error.nextAction);
          continue;
        }
        const currentStatePort = this.options.currentStatePort;
        let selection: RuntimeTaskCurrentStateSelection | null = null;
        if (currentStatePort) {
          const committed = await store.readCommitted(latest.checkpoint.scope, latest.checkpoint.id);
          if (!committed || !sameCheckpointBusinessScope(scope, committed.checkpoint.scope)) {
            this.markRecoveryRequired(task);
            continue;
          }
          const readScope: ScopeRef = {
            organId: latest.checkpoint.scope.organId,
            taskId: latest.checkpoint.scope.taskId,
            cycleId: scope.cycleId,
            operationId: scope.operationId,
          };
          const currentStateRead = await currentStatePort.read(readScope);
          selection = selectRuntimeTaskCurrentState({
            checkpointOutcome: checkpoint.outcome,
            scope,
            checkpointCommitRef: committed.commitRef,
            currentState: currentStateRead,
          });
          if (selection.basis === 'terminal') {
            task.state = selection.lifecycle;
            task.currentStateCommitRef = currentStateRead.state === 'known'
              ? currentStateRead.stateCommitRef
              : task.currentStateCommitRef;
            if (selection.currentState.currentPlan) {
              task.currentPlan = selection.currentState.currentPlan;
            }
          } else {
            task.state = checkpoint.outcome;
          }
        } else {
          task.state = checkpoint.outcome;
        }
        task.running = false;
        task.stopping = false;
        task.currentState = lifecycleStateLabel(task.state);
        task.nextStep = selection?.basis === 'terminal'
          ? task.state === 'succeeded'
            ? '可发起新的执行或停止'
            : task.state === 'stopped'
              ? '已收拢；可发起新的执行'
              : '检查错误 owner 与 next action'
          : checkpoint.next.kind === 'continue'
          ? '可发起新的执行'
          : `${checkpoint.next.kind}${checkpoint.next.ref ? `:${checkpoint.next.ref}` : ''}`;
        task.allowedActions = task.state === 'succeeded'
          || task.state === 'stopped'
          || task.state === 'failed'
          || task.state === 'cancelled'
          ? ['start']
          : [];
        task.currentNode = task.state === 'stopped' ? RUNTIME_NODE_MARKERS.checkpointCommit : task.currentNode;
        task.updatedAt = task.events.at(-1)?.occurredAt ?? task.updatedAt;
      } catch {
        this.markRecoveryRequired(task);
        continue;
      }
    }
  }

  private markRecoveryRequired(task: TaskRecord): void {
    task.state = 'blocked';
    task.running = false;
    task.stopping = false;
    task.currentState = '进程已重启或缺少终态 checkpoint';
    task.nextStep = '确认 Provider 资源已释放后再发起新执行';
    task.allowedActions = [];
  }

  private snapshot(record: TaskRecord): RuntimeTaskSnapshot {
    const checkpointEvent = record.events.slice().reverse().find((event) => event.kind === 'checkpoint.committed');
    return {
      taskId: record.taskId,
      title: record.title,
      directive: record.directive,
      directiveRevision: record.directiveRevision,
      state: record.state,
      currentState: record.currentState,
      nextStep: record.nextStep,
      updatedAt: record.updatedAt,
      input: record.input,
      output: record.output,
      currentNode: record.currentNode,
      operationId: record.operationId?.value,
      executionEpoch: record.executionEpoch,
      cycleId: record.cycleId?.value,
      publicOutput: record.publicOutput,
      orchestrated: record.orchestrated,
      allowedActions: record.allowedActions,
      recentEvents: record.events.slice(-20),
      events: record.events,
      requestIdentity: record.requestIdentity,
      checkpoint: record.checkpoint
        ? {
            checkpointId: record.checkpoint.id.value,
            seq: record.checkpoint.seq,
            outcome: record.checkpoint.outcome,
            summary: record.checkpoint.summary,
            committedAt: checkpointEvent?.occurredAt ?? record.updatedAt,
            evidenceRefs: record.checkpoint.evidenceRefs,
          }
        : undefined,
      error: record.error,
    };
  }

  private requireTask(taskId: TaskId): TaskRecord {
    const record = this.tasks.get(taskId.value);
    if (!record) throw new RuntimeTaskControlError('task.not.found', RUNTIME_OWNER, `unknown task ${taskId.value}`, 'create or select a task');
    return record;
  }

  private runtimeId(operationId: OperationId): string {
    return `ui-runtime-${operationId.value}`;
  }
}

class OperationListeners {
  private readonly byOperation = new Map<string, Set<(event: RuntimeTaskEvent) => void>>();

  add(operationId: string, listener: (event: RuntimeTaskEvent) => void): () => void {
    const listeners = this.byOperation.get(operationId) ?? new Set();
    listeners.add(listener);
    this.byOperation.set(operationId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.byOperation.delete(operationId);
    };
  }

  emit(operationId: string, event: RuntimeTaskEvent): void {
    for (const listener of this.byOperation.get(operationId) ?? []) listener(event);
  }
}
