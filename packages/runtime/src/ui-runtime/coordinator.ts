import { createHash } from 'node:crypto';
import {
  id,
  type AgentDriver,
  type AgentEvent,
  type AgentHandle,
  type Attention,
  type AgentOutput,
  type Checkpoint,
  type CycleId,
  type DecisionTraceRecord,
  type EvidenceRef,
  type LifecycleState,
  type NextAction,
  type OperationId,
  type OrganId,
  type ProviderCloseResult,
  type ProviderError,
  type ProviderEvent,
  type ScopeRef,
  type Task,
  type TaskId,
  type WorkAssignment,
  type WorkResult,
} from '../../../contracts/src/index.js';
import { completeCheckpoint, recallCheckpoint } from '../checkpoints/coordinator.js';
import { computeReentryDecision, type CheckpointReentryDecision } from '../checkpoints/closure.js';
import type { CheckpointJournalPort } from '../checkpoints/ports.js';
import type { InteractionClosureRecord } from '../checkpoints/closure.js';
import type { AttentionPort } from '../control/attention.js';
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
import type { OrchestrationManager } from '../orchestration/manager.js';
import { acceptanceCriteriaContent, digestOf, type AgentRuntimePoolManager, type ExecutionAgentPort } from '../orchestration/index.js';
import type { ExplicitIntakeState } from '../intake/explicit-intake.js';
import type { RequirementInboxState } from '../intake/requirement-inbox.js';
import type { ConfirmationLedgerState, PersistedSubmittedReceipt } from '../explicit-brain/router.js';

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
  readonly ownerId?: string;
  readonly retryable?: boolean;
  readonly nextAction?: string;
  readonly terminalPhase?: 'provider' | 'final';
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
  readonly error?: RuntimeTaskError;
}

export interface RuntimeExecutionDriver extends AgentDriver {
  close(): Promise<ProviderCloseResult>;
}

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

export type RuntimeExecutionDriverFactory = (input: RuntimeExecutionDriverInput) => RuntimeExecutionDriver;

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
  readonly checkpointStoreFor: (taskId: TaskId, cycleId: CycleId) => TaskCheckpointStore;
  readonly attentionPort: AttentionPort;
  readonly journal?: RuntimeTaskJournalPort;
  readonly hookRegistry?: AgentHookRegistry;
  readonly taskIdPrefix?: string;
  readonly now?: () => Date;
  readonly checkpointBoundary?: RuntimeCheckpointBoundaryPort;
  readonly createTaskAssembly?: (input: {
    readonly task: Task;
    readonly scope: ScopeRef;
    readonly checkpointJournal: TaskCheckpointStore;
    readonly executionAgent?: ExecutionAgentPort;
    readonly maxAttempts?: number;
  }) => RuntimeTaskAssembly;
}

export interface RuntimeTaskAssembly {
  readonly orchestration: OrchestrationManager;
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

interface TaskRecord {
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
  allowedActions: string[];
  runtime?: AgentRuntime;
  driver?: RuntimeExecutionDriver;
  composition?: RuntimeExecutionComposition;
  checkpointBoundary?: ContextCheckpointBoundary;
  taskAssembly?: RuntimeTaskAssembly;
  events: RuntimeTaskEvent[];
  checkpoint?: Checkpoint;
  checkpointSeq: number;
  error?: RuntimeTaskError;
  orchestrated: boolean;
  running: boolean;
  stopping: boolean;
  postCommitRecoveryPending?: boolean;
  executionReady?: Promise<boolean>;
  resolveExecutionReady?: (ready: boolean) => void;
}

interface OperationRecord {
  readonly operationId: OperationId;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly input: string;
  readonly orchestrated: boolean;
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

function sameCheckpointBusinessScope(requested: ScopeRef, checkpoint: ScopeRef): boolean {
  return sameId(requested.organId, checkpoint.organId)
    && sameId(requested.taskId, checkpoint.taskId)
    && sameId(requested.cycleId, checkpoint.cycleId)
    && (!checkpoint.operationId || sameId(requested.operationId, checkpoint.operationId));
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

function providerEventSummary(event: ProviderEvent): string {
  if (event.kind === 'terminal') return `execution ${event.terminalState ?? 'unknown'}`;
  if (event.kind === 'error') return event.error?.message ?? 'provider error';
  if (event.summary) return event.summary;
  if (event.outputRefs && event.outputRefs.length > 0) return `${event.kind}: ${event.outputRefs.join(', ')}`;
  return event.kind;
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
      currentNode: 'input.received',
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
    if (record.stopping || record.state === 'running' || record.state === 'settling') {
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
    if (record.stopping || record.state === 'running' || record.state === 'settling') {
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

  startExecution(taskId: TaskId, input: {
    readonly prompt: string;
    readonly orchestrate?: boolean;
    readonly operationId?: OperationId;
  }): { readonly operationId: OperationId; readonly executionEpoch: number } {
    const record = this.requireTask(taskId);
    if (record.running) throw new RuntimeTaskControlError('task.busy', RUNTIME_OWNER, 'task already has a running execution', 'stop the current execution first');
    if (!record.allowedActions.includes('start')) {
      throw new RuntimeTaskControlError('task.not.startable', RUNTIME_OWNER, 'task is not in a state that allows starting an execution', record.nextStep);
    }
    const prompt = input.prompt.trim();
    if (!prompt) throw new RuntimeTaskControlError('execution.input.required', RUNTIME_OWNER, 'execution input is required', 'provide a non-empty prompt');
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
    if (operation) {
      if (
        operation.events.length > 0
        || operation.taskId.value !== taskId.value
        || operation.executionEpoch !== expectedExecutionEpoch
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
    } else {
      const operationCounter = this.operationCounter + 1;
      const cycleCounter = this.cycleCounter + 1;
      const operationId = input.operationId ?? id('operation', `ui-operation-${operationCounter}`);
      const cycleId = id('cycle', `ui-cycle-${cycleCounter}`);
      const executionEpoch = expectedExecutionEpoch;
      scope = { organId: this.options.organId, taskId, cycleId, operationId };
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

    const startedEvent: RuntimeTaskEvent = {
      eventId: `${operation.operationId.value}-1`,
      seq: 1,
      occurredAt: this.now().toISOString(),
      taskId,
      operationId: operation.operationId.value,
      executionEpoch: operation.executionEpoch,
      kind: 'execution.started',
      state: 'running',
      summary: 'execution started',
      evidenceRefs: [],
    };
    this.journal?.append({
      kind: 'operation.event',
      operationId: operation.operationId,
      event: startedEvent,
    });
    operation.seq = startedEvent.seq;
    operation.events.push(startedEvent);
    this.activeExecutions.add(operation.operationId.value);

    record.running = true;
    record.stopping = false;
    record.executionReady = new Promise<boolean>((resolve) => {
      record.resolveExecutionReady = resolve;
    });
    record.state = 'running';
    record.currentState = '运行中';
    record.currentNode = 'provider.execute';
    record.input = operation.input;
    record.output = '';
    record.operationId = operation.operationId;
    record.executionEpoch = operation.executionEpoch;
    record.checkpoint = undefined;
    record.checkpointSeq = 0;
    record.composition = undefined;
    record.checkpointBoundary = undefined;
    record.taskAssembly = undefined;
    record.nextStep = '等待 Provider 事件';
    record.allowedActions = ['stop'];
    record.error = undefined;
    record.orchestrated = operation.orchestrated;
    record.events.push(startedEvent);
    record.updatedAt = startedEvent.occurredAt;
    this.listeners.emit(operation.operationId.value, startedEvent);

    void this.runExecution(record, operation, scope, operation.input);
    return { operationId: operation.operationId, executionEpoch: operation.executionEpoch };
  }

  async stop(taskId: TaskId): Promise<{ readonly state: string; readonly operationId?: string }> {
    const record = this.requireTask(taskId);
    if (!record.running || record.stopping || !record.operationId || !record.executionEpoch) {
      throw new RuntimeTaskControlError('task.not.running', RUNTIME_OWNER, 'task has no running execution to stop', 'start an execution first');
    }
    record.stopping = true;
    const executionReady = await record.executionReady;
    if (!executionReady) {
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

  attentionAudit(): { readonly published: readonly Attention[]; readonly resolved: readonly Attention[] } {
    return { published: this.publishedAttentions, resolved: this.resolvedAttentions };
  }

  private readonly scopes = new Map<string, ScopeRef>();
  private readonly listeners = new OperationListeners();

  private async runExecution(record: TaskRecord, operation: OperationRecord, scope: ScopeRef, prompt: string): Promise<void> {
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
    try {
      const checkpointBoundary = new ContextCheckpointBoundary(
        this.options.checkpointStoreFor(record.taskId, scope.cycleId!),
      );
      record.checkpointBoundary = checkpointBoundary;
      driver = this.options.createDriver({
        runtimeId,
        taskId: record.taskId,
        operationId: operation.operationId,
        executionEpoch: operation.executionEpoch,
        assignmentId: `assignment-${operation.operationId.value}`,
        scope,
        inputRefs: [`task://${record.taskId.value}/input/${operation.seq}`],
        ownerId: RUNTIME_OWNER,
      });
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
      let closure: AgentRuntimeClosure | undefined;
      if (record.orchestrated && this.options.createTaskAssembly) {
        const outputRef = `operation://${operation.operationId.value}/output`;
        const coordinator = this;
        // The review gate receives the text this execution actually produced,
        // so an empty run blocks instead of passing on identity alone.
        let producedOutput = '';
        const providerExecutionAgent: ExecutionAgentPort = {
          async execute(input): Promise<WorkResult> {
            await composition!.start();
            await composition!.submit(prompt);
            record.resolveExecutionReady?.(true);
            record.resolveExecutionReady = undefined;
            if (record.stopping || record.postCommitRecoveryPending) {
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
                summary: 'provider execution was stopped before observation completed',
                outputRefs: [],
                evidenceRefs: [],
                nextAction: 'settle',
              };
            }
            for await (const observation of composition!.observe()) {
              if (record.postCommitRecoveryPending) return {
                taskId: input.assignment.taskId,
                pipelineNodeId: input.assignment.pipelineNodeId,
                agentId: input.agentId,
                assignmentId: input.assignment.assignmentId,
                attempt: input.assignment.attempt,
                executionEpoch: input.assignment.executionEpoch,
                inputRevision: input.assignment.inputRevision,
                producedArtifactRefs: [],
                producedArtifactDigests: [],
                status: 'blocked',
                summary: 'provider execution reached post-commit recovery',
                outputRefs: [],
                evidenceRefs: [],
                nextAction: 'attention',
                conditionRef: `operation://${operation.operationId.value}/recovery`,
              };
              if (!observation.accepted) {
                coordinator.pushEvent(record, operation, 'provider.error', 'stale', `late event rejected: ${observation.rejection.reason}`, [], RUNTIME_OWNER, false, 'ignore stale execution event');
                continue;
              }
              const event = observation.event as AgentEvent & { readonly providerEvent?: ProviderEvent };
              if (!event.providerEvent) continue;
              if (event.providerEvent.kind === 'output' && event.providerEvent.summary) {
                producedOutput = `${producedOutput}${event.providerEvent.summary}`;
              }
              coordinator.recordProviderEvent(record, operation, event.providerEvent);
            }
            if (record.postCommitRecoveryPending) {
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
                status: 'blocked',
                summary: 'provider execution reached post-commit recovery',
                outputRefs: [],
                evidenceRefs: [],
                nextAction: 'attention',
                conditionRef: `operation://${operation.operationId.value}/recovery`,
              };
            }
            if (runtime!.snapshot().state === 'stopped' || record.stopping) {
              closure = runtime!.snapshot().closure;
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
                summary: 'provider execution was stopped during observation',
                outputRefs: [],
                evidenceRefs: closure?.evidenceRefs ?? [],
                nextAction: 'settle',
              };
            }
            coordinator.pushEvent(record, operation, 'execution.settling', 'settling', 'execution settling', []);
            record.state = 'settling';
            record.currentState = '收拢中';
            record.nextStep = '等待编排审查和 checkpoint';
            record.allowedActions = [];
            closure = await composition!.settle();
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
            return {
              taskId: input.assignment.taskId,
              pipelineNodeId: input.assignment.pipelineNodeId,
              agentId: input.agentId,
              assignmentId: input.assignment.assignmentId,
              attempt: input.assignment.attempt,
              executionEpoch: input.assignment.executionEpoch,
              inputRevision: input.assignment.inputRevision,
              producedArtifactRefs: [outputRef],
              // The digest of what this attempt produced, not of shared
              // mutable state that a later attempt may already have reset.
              producedArtifactDigests: [digestOf(producedOutput)],
              producedArtifactBodies: [producedOutput],
              status,
              summary: `provider execution ${closure.state}`,
              outputRefs: [outputRef],
              evidenceRefs: closure.evidenceRefs,
              nextAction,
              ...(nextAction === 'wait'
                ? { conditionRef: closure.conditionRef ?? `operation://${operation.operationId.value}/waiting` }
                : {}),
              ...(status === 'failed'
                ? { failureRef: closure.failureRef ?? `operation://${operation.operationId.value}/failed` }
                : {}),
            };
          },
        };
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
        });
        const stageNodeId = `stage-${operation.operationId.value}`;
        // The acceptance criteria digest is derived from the criteria content
        // itself, so the review gate can re-verify the content it receives
        // instead of trusting a label.
        const acceptanceCriteria = acceptanceCriteriaContent({
          objective: prompt,
          successCriteria: ['provider execution settles successfully'],
          failureCriteria: ['provider execution fails'],
          incompleteCriteria: ['provider execution requires waiting or recovery'],
        });
        const assignment: WorkAssignment = {
          assignmentId: `assignment-${operation.operationId.value}`,
          taskId: record.taskId,
          pipelineNodeId: stageNodeId,
          attempt: 1,
          executionEpoch: operation.executionEpoch,
          inputRevision: record.directiveRevision,
          objective: prompt,
          targetRefs: [outputRef],
          expectedOutputRefs: [outputRef],
          acceptanceCriteriaDigest: digestOf(acceptanceCriteria),
          successCriteria: ['provider execution settles successfully'],
          failureCriteria: ['provider execution fails'],
          incompleteCriteria: ['provider execution requires waiting or recovery'],
          requiredCapabilities: ['provider.execution'],
          mergeGate: 'required',
        };
        record.currentNode = 'orchestration.plan';
        record.nextStep = '编排执行、审查并合并';
        record.taskAssembly.orchestration.planStage({ nodeId: stageNodeId, taskId: record.taskId });
        const dispatched = await record.taskAssembly.orchestration.dispatch({
          stageNodeId,
          assignment,
          agentId: 'humanagent.provider-execution',
          scope,
          reviewKinds: ['quality'],
        });
        if (record.stopping || record.postCommitRecoveryPending) return;
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
        if (!closure) throw new RuntimeTaskControlError('orchestration.execution.closure.missing', RUNTIME_OWNER, 'orchestration completed without a provider closure', 'inspect the execution agent result');
      } else {
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
        }
        await composition.start();
        await composition.submit(prompt);
        record.resolveExecutionReady?.(true);
        record.resolveExecutionReady = undefined;
        if (record.stopping || record.postCommitRecoveryPending) return;
        for await (const observation of composition.observe()) {
          if (record.postCommitRecoveryPending) return;
          if (!observation.accepted) {
            this.pushEvent(record, operation, 'provider.error', 'stale', `late event rejected: ${observation.rejection.reason}`, [], RUNTIME_OWNER, false, 'ignore stale execution event');
            continue;
          }
          const event = observation.event as AgentEvent & { readonly providerEvent?: ProviderEvent };
          if (!event.providerEvent) continue;
          this.recordProviderEvent(record, operation, event.providerEvent);
        }
        if (record.postCommitRecoveryPending) return;
        if (runtime.snapshot().state === 'stopped') {
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
        closure = await composition.settle();
      }
      if (record.postCommitRecoveryPending || !closure) return;
      record.running = false;
      record.currentState = '收拢中';
      record.nextStep = '等待 checkpoint';
      record.allowedActions = [];
      await this.commitBusinessCheckpoint(record, scope, closure.state);
      const close = await this.closeForExecution(operation.operationId, driver, closure.evidenceRefs);
      if (close.state !== 'closed') {
        throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER, `provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'inspect provider close evidence');
      }
      this.pushEvent(record, operation, 'execution.terminal', closure.state, close.retained ? `execution ${closure.state}; provider retained for active executions` : `execution ${closure.state}; provider closed`, [...closure.evidenceRefs, ...close.evidenceRefs], undefined, undefined, undefined, undefined, 'final');
      this.finalize(record, closure.state);
    } catch (error) {
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
      const projection = errorFromUnknown(error);
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
      const providerMayBeActive = runtimeState === 'running'
        || runtimeState === 'settling'
        || runtimeState === 'admitted'
        || runtimeState === 'waiting'
        || runtimeState === 'blocked';
      let cleanupEvidenceRefs: readonly EvidenceRef[] = [];
      let cleanupFailure: unknown;
      if (composition && runtimeState === 'running') {
        try {
          const closure = await composition.settle();
          cleanupEvidenceRefs = closure.evidenceRefs;
        } catch (settleError) {
          cleanupFailure = settleError;
        }
      }
      if (driver) {
        try {
          const close = await this.closeForExecution(operation.operationId, driver, [...errorEvidenceRefs, ...cleanupEvidenceRefs]);
          cleanupEvidenceRefs = [...cleanupEvidenceRefs, ...close.evidenceRefs];
          if (close.state !== 'closed') {
            throw new RuntimeTaskControlError('provider.close.failed', close.ownerId ?? RUNTIME_OWNER, `provider close is ${close.state}`, toNextActionText(close.nextAction) ?? 'inspect provider close evidence');
          }
          cleanupFailure = undefined;
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
        const cleanupProjection = errorFromUnknown(cleanupFailure);
        record.error = cleanupProjection;
        record.state = 'blocked';
        record.running = providerMayBeActive;
        record.stopping = providerMayBeActive;
        record.currentState = '失败收拢未完成';
        record.nextStep = cleanupProjection.nextAction;
        record.allowedActions = providerMayBeActive ? ['retry-stop'] : [];
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
          { error: cleanupProjection },
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

  private recordProviderEvent(record: TaskRecord, operation: OperationRecord, event: ProviderEvent): void {
    const kind = mapProviderEventKind(event.kind);
    const state = event.terminalState ?? (event.error ? 'failed' : event.kind);
    const summary = providerEventSummary(event);
    const error = event.kind === 'error' && event.error ? providerErrorProjection(event.error) : undefined;
    let taskOutput: string | undefined;
    if (event.kind === 'output') {
      const text = event.summary ?? event.outputRefs?.join(', ') ?? summary;
      record.output = appendOutput(record.output, text);
      taskOutput = record.output;
      record.updatedAt = this.now().toISOString();
    }
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
      { taskOutput, error },
      event.kind === 'terminal' ? 'provider' : undefined,
    );
    if (event.kind === 'tool') record.currentNode = 'provider.tool';
    if (event.kind === 'model') record.currentNode = 'provider.model';
    if (error) record.error = error;
  }

  private async commitBusinessCheckpoint(record: TaskRecord, executionScope: ScopeRef, outcome: string, extraEvidenceRefs: readonly EvidenceRef[] = []): Promise<void> {
    const checkpointOutcome = (['succeeded', 'waiting', 'blocked', 'failed', 'cancelled', 'unknown'] as const).find((candidate) => candidate === outcome) ?? 'unknown';
    const businessScope: ScopeRef = { organId: this.options.organId, taskId: record.taskId, cycleId: executionScope.cycleId };
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
    const evidence: readonly EvidenceRef[] = [checkpointRef, ...extraEvidenceRefs];
    const next: NextAction = checkpointOutcome === 'waiting'
      ? { kind: 'wait', ref: `recovery-${record.operationId?.value ?? 'none'}` }
      : checkpointOutcome === 'failed' || checkpointOutcome === 'blocked' || checkpointOutcome === 'unknown'
        ? { kind: 'recover', ref: `task://${record.taskId.value}/recovery` }
        : checkpointOutcome === 'cancelled'
          ? { kind: 'stop', ref: `task://${record.taskId.value}/terminal` }
          : { kind: 'continue', ref: `task://${record.taskId.value}/next` };
    const checkpoint: Checkpoint = {
      id: id('checkpoint', `checkpoint-${record.taskId.value}-${record.checkpointSeq + 1}`),
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
    record.currentNode = 'checkpoint.commit';
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
    record.currentNode = state === 'stopped' ? 'checkpoint.commit' : record.currentNode;
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
    details?: { readonly taskOutput?: string; readonly error?: RuntimeTaskError },
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
    for (const record of this.journal?.replay() ?? []) {
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
            currentNode: 'input.received',
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
        case 'operation.started': {
          this.operationCounter = Math.max(this.operationCounter, record.operationCounter);
          this.cycleCounter = Math.max(this.cycleCounter, record.cycleCounter);
          const operation = this.operations.get(record.operationId.value) ?? {
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
          if (record.event.operationId !== record.operationId.value || record.event.taskId.value !== operation.taskId.value) {
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
            task.currentNode = 'provider.execute';
          }
          if (record.taskOutput !== undefined) task.output = record.taskOutput;
          if (record.error) task.error = record.error;
          if (record.event.kind === 'provider.tool') task.currentNode = 'provider.tool';
          if (record.event.kind === 'provider.model') task.currentNode = 'provider.model';
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
        task.state = checkpoint.outcome;
        task.running = false;
        task.stopping = false;
        task.currentState = lifecycleStateLabel(checkpoint.outcome);
        task.nextStep = checkpoint.next.kind === 'continue'
          ? '可发起新的执行'
          : `${checkpoint.next.kind}${checkpoint.next.ref ? `:${checkpoint.next.ref}` : ''}`;
        task.allowedActions = checkpoint.outcome === 'succeeded'
          || checkpoint.outcome === 'stopped'
          || checkpoint.outcome === 'failed'
          || checkpoint.outcome === 'cancelled'
          ? ['start']
          : [];
        task.currentNode = checkpoint.outcome === 'stopped' ? 'checkpoint.commit' : task.currentNode;
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
      orchestrated: record.orchestrated,
      allowedActions: record.allowedActions,
      recentEvents: record.events.slice(-20),
      events: record.events,
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
