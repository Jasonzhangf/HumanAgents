import {
  assertExecutionEpoch, canonicalJsonStringify,
  type ScopeRef, type WorkAssignment,
} from '../../../contracts/src/index.js';
import type { ActiveTurnInitialSegmentCapture, ActiveTurnSegmentPredecessorRef,
  ResumedTurnSegmentOpened } from '../../../contracts/src/active-turn-segments.js';
import { AgentLoopRuntime, type RecoverTurnResult } from '../agent-loop/runtime.js';
import type { ContextHistoryPort } from '../checkpoints/ports.js';
import type { ReentryCurrentFacts } from '../checkpoints/conditional-reentry.js';
import type { NativeSaveKey } from '../checkpoints/native-save-contract.js';
import type { ActiveTurnSegmentJournalPort } from '../context/active-turn-journal.js';
import { resumeActiveTurnSegment, type ResumeActiveTurnSegmentInput } from '../context/active-turn-segments.js';
import type { RetryCycleControlRecord } from '../orchestration/retry-cycle.js';
import type { RuntimePoolAcquireResult } from '../orchestration/runtime-pool.js';
import type { TaskExecutionHandle } from '../orchestration/types.js';
import { RuntimeTaskControlError, type OperationRecord, type TaskRecord,
  type RuntimeExecutionAllocation, type RuntimeExecutionDriver,
  type RuntimeExecutionRelease, type RuntimeTaskAssembly } from './coordinator.js';

export interface RuntimeColdExecutionResumeRequest {
  readonly businessTurnId: ResumeActiveTurnSegmentInput['businessTurnId'];
  readonly predecessor: ActiveTurnSegmentPredecessorRef;
}

/** Only the existing typed C facts consumed here; its App DTO stays App-owned. */
export interface RuntimeColdExecutionFacts {
  readonly allocation: RuntimeExecutionAllocation;
  readonly initial: ActiveTurnInitialSegmentCapture;
  readonly assignment: WorkAssignment;
  readonly scope: ScopeRef;
  readonly segments: readonly ResumedTurnSegmentOpened[];
  readonly tail: ActiveTurnSegmentPredecessorRef;
  readonly current: ReentryCurrentFacts;
  readonly durableEpochs: readonly { readonly executionEpoch: number }[];
  readonly retryCycle: RetryCycleControlRecord | null;
  readonly segmentJournal: ActiveTurnSegmentJournalPort;
}

type StandardTurnLifecycle = NonNullable<RuntimeExecutionDriver['standardTurn']>;
type ColdPhysicalExecution = Pick<RuntimeExecutionAllocation, 'runtimeId' | 'executionEpoch'>;
type AcquiredColdExecution = Extract<RuntimePoolAcquireResult<TaskExecutionHandle>, { status: 'acquired' }>;

interface ColdBoundaryPreparation {
  readonly execution: ColdPhysicalExecution;
  readonly key: NativeSaveKey;
  readonly standardTurn: StandardTurnLifecycle;
  /** Bound shared owner helper; completes retained phases without generation. */
  finishBoundary(): Promise<void>;
}

export type RuntimeColdTurnPreparation =
  | { readonly kind: 'generation-ready'; readonly turnId: string }
  | ({ readonly kind: 'exact-pending-boundary' } & ColdBoundaryPreparation)
  | ({ readonly kind: 'committed-close-alignment';
      readonly stage: 'closure-committed-alignment-absent' | 'alignment-committed';
    } & ColdBoundaryPreparation)
  | { readonly kind: 'unknown-held'; readonly turnId: string;
      readonly reason: string; readonly recovery: RecoverTurnResult };

/** Bound by the real App composition. None of these are public resume inputs. */
export interface RuntimeColdExecutionProducer {
  readColdExecutionSource(input: {
    readonly allocation: RuntimeExecutionAllocation;
    readonly request: RuntimeColdExecutionResumeRequest;
  }): Promise<RuntimeColdExecutionFacts>;
  readonly admitSegment: ResumeActiveTurnSegmentInput['admit'];
  readIncarnationBinding(source: RuntimeColdExecutionFacts): Promise<{
    readonly request: Parameters<typeof AgentLoopRuntime.resumeIncarnation>[0];
    readonly contextHistory: ContextHistoryPort;
  }>;
  /** Positively classify the original durable turn before any new incarnation. */
  recoverOriginalTurn(input: {
    readonly source: RuntimeColdExecutionFacts;
  }): Promise<RuntimeColdTurnPreparation>;
  createResumedExecutionDriver(input: {
    readonly source: RuntimeColdExecutionFacts;
    readonly allocation: RuntimeExecutionAllocation;
    readonly segment: ResumedTurnSegmentOpened;
    readonly loop: AgentLoopRuntime;
  }): Promise<RuntimeExecutionDriver & { readonly standardTurn: StandardTurnLifecycle }>;
}

interface PreparedColdGeneration {
  readonly kind: 'generation-ready';
  readonly source: RuntimeColdExecutionFacts;
  readonly assembly: RuntimeTaskAssembly;
  readonly acquired: AcquiredColdExecution;
  readonly segment: ResumedTurnSegmentOpened;
  readonly loop: AgentLoopRuntime;
  readonly driver: RuntimeExecutionDriver & { readonly standardTurn: StandardTurnLifecycle };
}

export type PreparedColdExecution =
  | PreparedColdGeneration
  | ({ readonly source: RuntimeColdExecutionFacts } & Extract<RuntimeColdTurnPreparation,
      { kind: 'exact-pending-boundary' | 'committed-close-alignment' }>);

/** Internal coordinator binding; uses its original Maps and assembly factory. */
export interface ColdExecutionResumeOwner {
  readonly tasks: Map<string, TaskRecord>;
  readonly operations: Map<string, OperationRecord>;
  readonly producer: RuntimeColdExecutionProducer | undefined;
  readonly lifecycle: ColdExecutionLifecycleBinding | undefined;
}

/** Coordinator owns the same actual lifecycle and resource transfer. */
export interface ColdExecutionLifecycleBinding {
  assemblyFor(record: TaskRecord, operation: OperationRecord, scope: ScopeRef): RuntimeTaskAssembly;
  releaseToLifecycle(record: TaskRecord, operation: OperationRecord, prepared: PreparedColdExecution): Promise<RuntimeExecutionRelease>;
}

const OWNER = 'humanagent.runtime.cold-execution';
function hold(code: string, message: string): never {
  throw new RuntimeTaskControlError(code, OWNER, message,
    'resolve the original owner binding and retain the durable recovery responsibility');
}
function same(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

/** Runtime alone chooses a successor over all actual C floor facts. */
function successorEpoch(source: RuntimeColdExecutionFacts): number {
  const epochs = [source.allocation.executionEpoch,
    source.initial.body.binding.execution.executionEpoch,
    source.assignment.executionEpoch,
    source.current.position.executionEpoch,
    source.current.context.loopCheckpoint.executionEpoch,
    ...source.segments.map((segment) => segment.binding.execution.executionEpoch),
    ...source.current.fencedBindings.map((fence) => fence.executionEpoch),
    ...source.durableEpochs.map((fact) => fact.executionEpoch),
    ...(source.retryCycle?.attempts.map((attempt) => attempt.executionEpoch) ?? [])];
  let floor = 0;
  for (const epoch of epochs) {
    assertExecutionEpoch(epoch);
    floor = Math.max(floor, epoch);
  }
  assertExecutionEpoch(floor + 1);
  return floor + 1;
}

export async function resumeColdExecution(
  owner: ColdExecutionResumeOwner,
  taskId: RuntimeExecutionAllocation['taskId'],
  operationId: RuntimeExecutionAllocation['operationId'],
  request: RuntimeColdExecutionResumeRequest,
): Promise<RuntimeExecutionRelease> {
  const record = owner.tasks.get(taskId.value);
  const operation = owner.operations.get(operationId.value);
  const allocation = operation?.allocation;
  if (!record || !operation || !allocation
    || !same(record.taskId, taskId) || !same(operation.taskId, taskId)
    || !same(operation.operationId, operationId)
    || !same(record.operationId, operationId)
    || !same(allocation.taskId, taskId) || !same(allocation.operationId, operationId)
    || !same(record.allocation, allocation)) {
    hold('cold-execution.retained-identity-mismatch', 'selectors do not resolve the original retained task and operation allocation');
  }
  if (record.running || record.stopping || record.resolveRelease) {
    hold('cold-execution.execution-active', 'the original operation still has a live execution or release');
  }
  const producer = owner.producer;
  if (!producer) hold('cold-execution.producer-unbound',
    'the actual source, grant, incarnation config, original turn recovery and native v2 composition are not bound');
  const source = await producer.readColdExecutionSource({ allocation, request });
  const initial = source.initial.body.binding;
  if (!same(source.allocation, allocation) || !same(source.scope, allocation.scope)
    || !same(source.assignment, initial.assignment)
    || !same(source.scope, initial.scope)
    || !same(source.assignment.taskId, taskId)
    || source.assignment.assignmentId !== allocation.assignmentId
    || source.assignment.inputRevision !== allocation.inputRevision
    || initial.admittedTurn.turnId !== request.businessTurnId
    || !same(source.tail, request.predecessor)
    || !same(source.current.task.id, taskId)) {
    hold('cold-execution.source-identity-mismatch', 'verified source conflicts with the retained original business identity');
  }
  const preparation = await producer.recoverOriginalTurn({ source });
  if (preparation.kind === 'unknown-held') {
    hold('cold-execution.original-turn-held', preparation.reason);
  }
  if (preparation.kind === 'generation-ready' && preparation.turnId !== request.businessTurnId) {
    hold('cold-execution.original-turn-held', 'generation preparation does not name the original business turn');
  }
  const lifecycle = owner.lifecycle;
  if (!lifecycle) hold('cold-execution.lifecycle-unbound',
    'the accepted C3 native save/current/close lifecycle is absent; acquisition and segment commit remain held');
  if (preparation.kind !== 'generation-ready') {
    // No new physical identity or execution resource exists on this path.
    return lifecycle.releaseToLifecycle(record, operation, { source, ...preparation });
  }
  const assembly = lifecycle.assemblyFor(record, operation, source.scope);
  const binding = await producer.readIncarnationBinding(source);
  const executionEpoch = successorEpoch(source);
  const acquired = await assembly.orchestration.acquireExecutionInstance({
    assignment: source.assignment, scope: source.scope,
    agentId: allocation.configuredAgentId ?? 'humanagent.provider-execution', executionEpoch,
  });
  if (acquired.status !== 'acquired') {
    throw new RuntimeTaskControlError(acquired.issue.code, acquired.issue.ownerId,
      acquired.issue.reason, acquired.issue.nextAction.kind);
  }
  let transferred = false;
  let preparationError: unknown;
  try {
    const resumed = await resumeActiveTurnSegment({
      businessTurnId: request.businessTurnId,
      segmentId: `${request.businessTurnId}:instance:${acquired.incarnation.agentInstanceId}`,
      assignment: source.assignment, scope: source.scope, incarnation: acquired.incarnation,
      ports: { read: source.segmentJournal, append: source.segmentJournal },
      admit: (intent) => {
        if (!same(intent.predecessor, request.predecessor)) {
          hold('cold-execution.predecessor-changed', 'segment intent no longer names the selected exact predecessor');
        }
        return producer.admitSegment(intent);
      },
    });
    if (resumed.status !== 'resumed') {
      hold(`cold-execution.${resumed.status}`, resumed.status === 'grant-denied'
        ? resumed.reason : `exact predecessor recovery receipt is ${resumed.receipt.status}`);
    }
    if (!same(resumed.segment.predecessor, request.predecessor)) {
      hold('cold-execution.predecessor-changed', 'committed segment no longer names the selected exact predecessor');
    }
    const loop = await AgentLoopRuntime.resumeIncarnation(binding.request, binding.contextHistory, {
      segment: resumed.segment, sourceContextCommitRef: source.current.position.contextCommitRef,
    });
    const driver = await producer.createResumedExecutionDriver({ source, allocation, segment: resumed.segment, loop });
    const prepared: PreparedColdExecution = {
      kind: 'generation-ready', source, assembly, acquired, segment: resumed.segment, loop, driver,
    };
    const release = lifecycle.releaseToLifecycle(record, operation, prepared);
    transferred = true;
    return await release;
  } catch (error) {
    preparationError = error;
    throw error;
  } finally {
    if (!transferred) {
      try {
        const released = await assembly.runtimePool.release(acquired.lease, { scope: source.scope });
        if (released.status === 'blocked') {
          throw new RuntimeTaskControlError(released.issue.code, released.issue.ownerId,
            released.issue.reason, released.issue.nextAction.kind);
        }
      } catch (cleanup) {
        throw new AggregateError([preparationError, cleanup],
          'cold execution preparation failed and its dormant lease remains held');
      }
    }
  }
}
