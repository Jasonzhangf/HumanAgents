import { createHash } from 'node:crypto';
import { validateNativeSegmentSaveSourceV2 } from '../../../contracts/src/active-turn-segments.js';
import { projectAdmittedTurnIdentityV1 as projectSegmentIdentity } from '../context/semantic-history.js';
import {
  id,
  canonicalJsonStringify,
  validateTurnClosureReference,
  validateTaskIdentityRecord,
  type Checkpoint,
  type CycleId,
  type EvidenceRef,
  type JournalCommitRef,
  type NextAction,
  type OperationId,
  type PlannerAlignmentDecision,
  type ProviderExecutionIdentityRef,
  type PublishedTaskPlanRevision,
  type ScopeRef,
  type Task,
  type TaskId,
  type TaskIdentityRecord,
  type TaskRuntimeIncarnation,
  type TurnClosureReference,
  type TurnSummaryEvidenceContext,
} from '../../../contracts/src/index.js';
import { createPublishedTaskPlanRevision, validateTaskPlanRevisionTransition } from '../../../core/src/task-plan-revision.js';
import type {
  CheckpointControlBusinessRequest,
  CheckpointControlCapabilityRef,
  CheckpointControlInputIdentity,
} from '../../../contracts/src/checkpoint-controls.js';
import {
  admitTaskGrantBusiness,
  TaskGrantDeniedError,
  type TaskGrantPort,
} from '../admission/task-grant.js';
import { AdmissionError } from '../admission/errors.js';
import type { CheckpointJournalPort, CommittedCheckpointRecord } from '../checkpoints/ports.js';
import { OrchestrationError } from './errors.js';
import {
  AgentRuntimePoolManager,
  type RuntimePoolAcquireResult,
} from './runtime-pool.js';
import type {
  OrchestrationIssue,
  RuntimeInstanceCreateContext,
  RuntimeInstanceRequest,
  RuntimePoolLease,
  TaskInstanceHandle,
} from './types.js';
import type { TaskPlanRevisionPublishInput } from './task-plan-revisions.js';
import type { TaskFlowRefinedResult } from './task-flow-selector.js';

/**
 * Narrow Runtime owner for the closed-turn independent Planner call.
 *
 * A closed turn already committed its four-part summary, checkpoint, closure and
 * recovery fact. This duty turns that exact closed turn into one real, admitted,
 * pool-leased, checkpoint-anchored Planner call. It never reopens the raw turn,
 * never fabricates a parent turn, and never calls a model itself: the caller
 * supplies the actual Provider invocation through `invoke`.
 *
 * The typed records here are control truth in the same Organ Journal. Runtime
 * owns the record shape; the App codec owns serialization.
 */

export const CLOSED_TURN_PLANNER_CALL_OWNER = 'humanagent.runtime.orchestration.closed-turn-planner-call';

/** Explicit failure for the duty. It never fabricates an admitted or aligned success. */
export class ClosedTurnPlannerCallError extends OrchestrationError {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    input: {
      readonly scope: ScopeRef;
      readonly nextAction: NextAction;
      readonly cause?: unknown;
      readonly conditionRef?: string;
    },
  ) {
    super(message, {
      ownerId: CLOSED_TURN_PLANNER_CALL_OWNER,
      reason: code,
      nextAction: input.nextAction,
      evidenceRefs: [dutyEvidence(input.scope, code)],
      ...(input.conditionRef === undefined ? {} : { conditionRef: input.conditionRef }),
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    });
    this.name = 'ClosedTurnPlannerCallError';
    this.code = code;
  }
}

function dutyEvidence(scope: ScopeRef, locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `closed-turn-planner-call-${locator}`),
    kind: 'operation',
    source: CLOSED_TURN_PLANNER_CALL_OWNER,
    locator,
    scope,
  };
}

function issue(
  code: string,
  reason: string,
  nextAction: NextAction,
  scope: ScopeRef,
  conditionRef?: string,
): OrchestrationIssue {
  return {
    code,
    ownerId: CLOSED_TURN_PLANNER_CALL_OWNER,
    reason,
    nextAction,
    evidenceRefs: [dutyEvidence(scope, code)],
    ...(conditionRef === undefined ? {} : { conditionRef }),
  };
}

/**
 * The actual retained Runtime call allocation for the Planner call. Operation and
 * epoch come from this retained identity, never from a Provider binding, model
 * text, route or session. The caller reads it from the same Runtime owner that
 * admitted the closed turn.
 */
export interface ClosedTurnPlannerCallAllocation {
  readonly operationId: OperationId;
  readonly cycleId: CycleId;
  readonly executionEpoch: number;
}

/**
 * Exact committed inputs for one closed-turn Planner duty. `closure` is the
 * already committed four-part turn closure. The basis is the exact accepted
 * predecessor, or explicit null plus actual identity after firstness is known.
 */
export type ClosedTurnPlannerPlanBasis =
  | { readonly priorPlan: PublishedTaskPlanRevision }
  | { readonly priorPlan: null; readonly identity: TaskIdentityRecord };

export type ClosedTurnPlannerCallInput = {
  readonly task: Task;
  readonly closure: TurnClosureReference;
  readonly summaryEvidenceContext?: TurnSummaryEvidenceContext;
  readonly refinedResults: readonly TaskFlowRefinedResult[];
  readonly allocation: ClosedTurnPlannerCallAllocation;
  /**
   * Exact declared authority scope of the current Task grant. It is distinct
   * from the physical closure scope: the grant declares the organ/task the
   * principal may act in, while the closure scope also names the cycle and
   * operation. The actual grant owner supplies it; a missing value falls back
   * to the physical scope for callers that carry no separate declaration.
   */
  readonly capabilityScope?: ScopeRef;
  readonly segmentSource?: import('../../../contracts/src/active-turn-segments.js').NativeSegmentSaveSourceV2;
} & ClosedTurnPlannerPlanBasis;

/** Stable identity of one Planner duty. An identical retry reuses it; changed input under it conflicts. */
export type ClosedTurnPlannerCallDuty = {
  readonly dutyKey: string;
  readonly taskId: TaskId;
  readonly scope: ScopeRef;
  readonly closureRef: string;
  readonly checkpointId: Checkpoint['id'];
  readonly checkpointCommitRef: JournalCommitRef;
  readonly inputDigest: string;
} & (
  | { readonly predecessorRevisionId: string }
  | { readonly predecessorRevisionId: null; readonly identity: TaskIdentityRecord }
);

export type ClosedTurnPlannerCallStage = 'prepared' | 'invoked' | 'returned';

/** The real pool resource decision, kept verbatim from the existing pool. */
export type ClosedTurnPlannerAcquireDecision =
  Extract<RuntimePoolAcquireResult<TaskInstanceHandle>, { readonly status: 'acquired' }>['decision'];

/**
 * Durable preparation record. It is committed before any Provider callback and
 * anchors the call to the exact already-committed closing checkpoint.
 */
export interface ClosedTurnPlannerCallPreparationRecord {
  readonly kind: 'closed-turn-planner-call';
  readonly stage: 'prepared';
  readonly duty: ClosedTurnPlannerCallDuty;
  readonly invocationId: string;
  readonly execution: ProviderExecutionIdentityRef;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly lease: RuntimePoolLease;
  readonly decision: ClosedTurnPlannerAcquireDecision;
  readonly grantCommitRef: JournalCommitRef;
  readonly admissionCommitRef: JournalCommitRef;
  readonly checkpoint: CommittedCheckpointRecord;
  readonly preparedAt: string;
  readonly configuredAgentId?: string;
}

/** Durable invocation stage, committed before the Provider callback starts. */
export interface ClosedTurnPlannerCallInvocationRecord {
  readonly kind: 'closed-turn-planner-call';
  readonly stage: 'invoked';
  readonly duty: ClosedTurnPlannerCallDuty;
  readonly invocationId: string;
  readonly preparationCommitRef: JournalCommitRef;
  readonly invokedAt: string;
}

/** Durable refined return, committed before the caller acknowledges it. */
export interface ClosedTurnPlannerCallReturnRecord {
  readonly kind: 'closed-turn-planner-call';
  readonly stage: 'returned';
  readonly duty: ClosedTurnPlannerCallDuty;
  readonly invocationId: string;
  readonly publication: TaskPlanRevisionPublishInput;
  readonly decision: PlannerAlignmentDecision;
  readonly returnedAt: string;
}

export type ClosedTurnPlannerCallRecord =
  | ClosedTurnPlannerCallPreparationRecord
  | ClosedTurnPlannerCallInvocationRecord
  | ClosedTurnPlannerCallReturnRecord;

export interface ClosedTurnPlannerCallCommittedRecord {
  readonly record: ClosedTurnPlannerCallRecord;
  readonly commitRef: JournalCommitRef;
}

/**
 * Same-Organ-Journal codec port owned by App. `read` returns the furthest
 * committed stage for the duty, never a synthetic empty state.
 */
export interface ClosedTurnPlannerCallJournalPort {
  append(record: ClosedTurnPlannerCallRecord): Promise<JournalCommitRef>;
  read(scope: ScopeRef, dutyKey: string): Promise<ClosedTurnPlannerCallCommittedRecord | null>;
}

/**
 * The Runtime-issued value handed to the caller's Provider adapter. It is a
 * projection of real owner records, not a bearer grant any caller can
 * manufacture. Runtime keeps the pool handle private.
 */
export interface PreparedClosedTurnPlannerCall {
  readonly duty: ClosedTurnPlannerCallDuty;
  readonly invocationId: string;
  readonly execution: ProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly assignmentId: string;
  readonly configuredAgentId?: string;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly lease: RuntimePoolLease;
  readonly decision: ClosedTurnPlannerAcquireDecision;
  readonly grantCommitRef: JournalCommitRef;
  readonly admissionCommitRef: JournalCommitRef;
  readonly checkpoint: CommittedCheckpointRecord;
  readonly preparationCommitRef: JournalCommitRef;
}

/** Validated publication plus the alignment decision the existing `alignTurn` consumer accepts. */
export interface ClosedTurnPlannerResult {
  readonly publication: TaskPlanRevisionPublishInput;
  readonly decision: PlannerAlignmentDecision;
}

export type ClosedTurnPlannerCallOutcome =
  | {
      readonly state: 'returned';
      readonly result: ClosedTurnPlannerResult;
      readonly returnCommitRef: JournalCommitRef;
    }
  | {
      readonly state: 'waiting' | 'recovering' | 'paused';
      readonly issue: OrchestrationIssue;
    };

export interface ClosedTurnPlannerCallPort {
  run(
    input: ClosedTurnPlannerCallInput,
    invoke: (call: PreparedClosedTurnPlannerCall) => Promise<ClosedTurnPlannerResult>,
  ): Promise<ClosedTurnPlannerCallOutcome>;
}

export interface ClosedTurnPlannerCallDeps {
  /** Owner id reported to the existing pool. */
  readonly ownerId: string;
  /** Verified principal the existing TaskGrant readback must match. */
  readonly principalOwner: string;
  /** Existing configured `orchestration` duty. */
  readonly roleId: string;
  readonly agentId: string;
  /** Existing configured orchestration assignment for this call. */
  readonly assignmentId: string;
  readonly requiredCapabilities: readonly string[];
  /** The SAME existing pool instance, never a second pool. */
  readonly pool: AgentRuntimePoolManager;
  /** Real handle creator bound to the actual orchestration assembly. */
  readonly createInstance: (input: RuntimeInstanceCreateContext<RuntimeInstanceRequest>) => TaskInstanceHandle;
  readonly taskGrant: TaskGrantPort;
  readonly checkpoints: CheckpointJournalPort;
  readonly journal: ClosedTurnPlannerCallJournalPort;
  readonly now?: () => Date;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function sameScopedId(left: { readonly value: string } | undefined, right: string): boolean {
  return left !== undefined && left.value === right;
}

/** Shared with the no-Provider durable-return preflight; legacy revision keys stay exact. */
export function closedTurnPlannerDutyKey(input: Pick<ClosedTurnPlannerCallInput, 'task' | 'closure' | 'priorPlan'>): string {
  return [
    'closed-turn-planner-call',
    input.task.id.value,
    input.closure.closureRef,
    input.closure.checkpointId.value,
    input.priorPlan === null ? 'first-publication' : input.priorPlan.revisionId,
  ].join(':');
}

export function deriveClosedTurnPlannerDuty(input: ClosedTurnPlannerCallInput, checkpointCommitRef: JournalCommitRef): ClosedTurnPlannerCallDuty {
  const scope = input.closure.identity.scopeRef;
  const dutyKey = closedTurnPlannerDutyKey(input);
  const inputDigest = digestOf({
    taskId: input.task.id.value,
    directiveRevision: input.closure.identity.directiveRevision,
    inputRevision: input.closure.identity.inputRevision,
    closureRef: input.closure.closureRef,
    checkpointId: input.closure.checkpointId.value,
    predecessorRevisionId: input.priorPlan === null ? null : input.priorPlan.revisionId,
    predecessorContentDigest: input.priorPlan === null ? null : input.priorPlan.contentDigest,
    refinedResults: input.refinedResults,
    ...(input.summaryEvidenceContext === undefined ? {} : { summaryEvidenceContext: input.summaryEvidenceContext }),
    ...(input.segmentSource === undefined ? {} : { segmentSource: input.segmentSource }),
    ...(input.priorPlan === null ? {
      identity: input.identity,
      directive: input.task.directive,
      taskDirectiveRevision: input.task.directiveRevision,
      checkpointCommitRef,
      allocation: input.allocation,
    } : {}),
  });
  return {
    dutyKey,
    taskId: input.task.id,
    scope,
    closureRef: input.closure.closureRef,
    checkpointId: input.closure.checkpointId,
    checkpointCommitRef,
    inputDigest,
    ...(input.priorPlan === null
      ? { predecessorRevisionId: null, identity: input.identity }
      : { predecessorRevisionId: input.priorPlan.revisionId }),
  };
}

function assertSameDuty(actual: ClosedTurnPlannerCallDuty, expected: ClosedTurnPlannerCallDuty, scope: ScopeRef): void {
  if (actual.dutyKey !== expected.dutyKey || actual.inputDigest !== expected.inputDigest) {
    throw new ClosedTurnPlannerCallError(
      'planner.call.input-conflict',
      'the committed Planner duty does not match this input',
      { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.input' }, conditionRef: 'closed-turn-planner-call.input' },
    );
  }
}

function assertInput(input: ClosedTurnPlannerCallInput): void {
  const scope = input.closure.identity.scopeRef;
  validateTurnClosureReference(input.closure, input.summaryEvidenceContext);
  if (input.closure.identity.taskRef.value !== input.task.id.value) {
    throw new ClosedTurnPlannerCallError(
      'planner.call.task-mismatch',
      'the turn closure does not name this task',
      { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.task' }, conditionRef: 'closed-turn-planner-call.task' },
    );
  }
  if (input.priorPlan === undefined) {
    throw new ClosedTurnPlannerCallError('planner.call.plan-missing', 'priorPlan must be explicit: the exact revision or null with the actual identity',
      { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.plan' } });
  }
  if (input.priorPlan === null) validateTaskIdentityRecord(input.identity);
  const planScope = input.priorPlan === null ? input.identity.scope : input.priorPlan.scope;
  if (!sameScopedId(planScope.taskId, input.task.id.value)
    || planScope.organId.value !== input.task.organId.value
    || scope.organId.value !== input.task.organId.value) {
    throw new ClosedTurnPlannerCallError(
      'planner.call.plan-mismatch',
      'the predecessor plan revision does not name this task',
      { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.plan' }, conditionRef: 'closed-turn-planner-call.plan' },
    );
  }
  if (input.segmentSource) {
    validateNativeSegmentSaveSourceV2(input.segmentSource);
    if (canonicalJsonStringify(projectSegmentIdentity(input.segmentSource.originalAdmittedTurn)) !== canonicalJsonStringify(input.closure.identity)) {
      throw new Error('closed Planner segment source does not retain the original business identity');
    }
  }
  if (input.capabilityScope) {
    const declared = input.capabilityScope;
    if (declared.organId.value !== scope.organId.value
      || (declared.taskId !== undefined && declared.taskId.value !== scope.taskId?.value)
      || (declared.cycleId !== undefined && declared.cycleId.value !== scope.cycleId?.value)
      || (declared.operationId !== undefined && declared.operationId.value !== scope.operationId?.value)) {
      throw new ClosedTurnPlannerCallError(
        'planner.call.capability-scope-mismatch',
        'the declared capability scope does not belong to this closed turn',
        { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.capability' }, conditionRef: 'closed-turn-planner-call.capability' },
      );
    }
  }
  if (input.closure.identity.executionEpoch !== input.allocation.executionEpoch) {
    throw new ClosedTurnPlannerCallError(
      'planner.call.epoch-mismatch',
      'the retained call allocation epoch does not match the closed turn',
      { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.epoch' }, conditionRef: 'closed-turn-planner-call.epoch' },
    );
  }
  if (input.closure.identity.scopeRef.operationId !== undefined
    && input.closure.identity.scopeRef.operationId.value !== input.allocation.operationId.value) {
    throw new ClosedTurnPlannerCallError(
      'planner.call.operation-mismatch',
      'the retained call allocation operation does not match the closed turn scope',
      { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.operation' }, conditionRef: 'closed-turn-planner-call.operation' },
    );
  }
  if (input.closure.identity.scopeRef.cycleId !== undefined
    && input.closure.identity.scopeRef.cycleId.value !== input.allocation.cycleId.value) {
    throw new ClosedTurnPlannerCallError(
      'planner.call.cycle-mismatch',
      'the retained call allocation cycle does not match the closed turn scope',
      { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.cycle' }, conditionRef: 'closed-turn-planner-call.cycle' },
    );
  }
}

function validateReturn(input: ClosedTurnPlannerCallInput, result: ClosedTurnPlannerResult): void {
  const publication = result.publication;
  const candidate = createPublishedTaskPlanRevision({ ...publication, journalCommitRef: `planner-candidate:${publication.revisionId}` });
  validateTaskPlanRevisionTransition(input.priorPlan, candidate);
  if (!['continue', 'complete', 'failed'].includes(result.decision)) {
    throw new ClosedTurnPlannerCallError('planner.call.decision-missing', 'the closed Planner return requires an alignment decision',
      { scope: publication.scope, nextAction: { kind: 'recover', ref: 'planner-call.return' } });
  }
  if (input.priorPlan === null) {
    const { evidenceRefs: _evidenceRefs, ...source } = publication.source;
    if (publication.reason.kind === 'initial'
      && publication.scope.organId.value === input.identity.scope.organId.value
      && publication.scope.taskId.value === input.identity.scope.taskId.value
      && publication.revisionId === `plan-revision:${input.task.id.value}:1`
      && publication.historyCoverage === 'complete-from-task-start'
      && stableStringify(source) === stableStringify(input.identity.source)) return;
  } else if (stableStringify(publication.source) === stableStringify(input.priorPlan.source)
    && publication.historyCoverage === input.priorPlan.historyCoverage
    && publication.reason.kind === 'adjustment') {
    return;
  }
  throw new ClosedTurnPlannerCallError('planner.call.return-mismatch',
    'the Planner return does not match its confirmed call input',
    { scope: publication.scope, nextAction: { kind: 'recover', ref: 'planner-call.return' } });
}

export function createClosedTurnPlannerCall(deps: ClosedTurnPlannerCallDeps): ClosedTurnPlannerCallPort {
  return new ClosedTurnPlannerCallOwner(deps);
}

interface AdmittedGrant {
  readonly grantCommitRef: JournalCommitRef;
  readonly admissionCommitRef: JournalCommitRef;
}

interface AcquiredInstance {
  readonly incarnation: TaskRuntimeIncarnation;
  readonly lease: RuntimePoolLease;
  readonly decision: ClosedTurnPlannerAcquireDecision;
}

class ClosedTurnPlannerCallOwner implements ClosedTurnPlannerCallPort {
  private readonly inFlight = new Map<string, { readonly input: string; readonly pending: Promise<ClosedTurnPlannerCallOutcome> }>();
  private readonly live = new Map<string, PreparedClosedTurnPlannerCall>();
  private readonly now: () => Date;

  constructor(private readonly deps: ClosedTurnPlannerCallDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async run(
    input: ClosedTurnPlannerCallInput,
    invoke: (call: PreparedClosedTurnPlannerCall) => Promise<ClosedTurnPlannerResult>,
  ): Promise<ClosedTurnPlannerCallOutcome> {
    // Retain the actual duty input before the first asynchronous owner read.
    const frozen = structuredClone(input);
    assertInput(frozen);
    const dutyKey = closedTurnPlannerDutyKey(frozen);
    const fingerprint = stableStringify(frozen);
    const existing = this.inFlight.get(dutyKey);
    if (existing) {
      if (existing.input !== fingerprint) {
        throw new ClosedTurnPlannerCallError('planner.call.input-conflict', 'the in-flight Planner duty has different retained inputs',
          { scope: frozen.closure.identity.scopeRef, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.input' } });
      }
      return existing.pending;
    }
    const pending = this.execute(frozen, invoke);
    this.inFlight.set(dutyKey, { input: fingerprint, pending });
    const settle = (): void => {
      if (this.inFlight.get(dutyKey)?.pending === pending) this.inFlight.delete(dutyKey);
    };
    void pending.then(settle, settle);
    return pending;
  }

  private async execute(
    input: ClosedTurnPlannerCallInput,
    invoke: (call: PreparedClosedTurnPlannerCall) => Promise<ClosedTurnPlannerResult>,
  ): Promise<ClosedTurnPlannerCallOutcome> {
    const scope = input.closure.identity.scopeRef;
    const anchor = await this.readAnchor(input, scope);
    const duty = deriveClosedTurnPlannerDuty(input, anchor.commitRef);
    const committed = await this.deps.journal.read(scope, duty.dutyKey);
    if (committed) assertSameDuty(committed.record.duty, duty, scope);

    if (committed?.record.stage === 'returned') {
      const result = { publication: committed.record.publication, decision: committed.record.decision };
      validateReturn(input, result);
      return {
        state: 'returned',
        result,
        returnCommitRef: committed.commitRef,
      };
    }
    if (committed?.record.stage === 'invoked') {
      return {
        state: 'recovering',
        issue: issue(
          'planner.call.submitted-unknown',
          'a Planner request was submitted but its settlement is unknown; do not duplicate it',
          { kind: 'wait', ref: 'closed-turn-planner-call.settlement' },
          scope,
          'closed-turn-planner-call.settlement',
        ),
      };
    }

    let prepared: PreparedClosedTurnPlannerCall;
    if (committed?.record.stage === 'prepared') {
      const live = this.live.get(duty.dutyKey);
      if (!live) {
        return {
          state: 'recovering',
          issue: issue(
            'planner.call.lease-not-revivable',
            'the committed preparation lease cannot be revived after reconstruction; reconcile the actual instance first',
            { kind: 'recover', ref: 'closed-turn-planner-call.lease' },
            scope,
            'closed-turn-planner-call.lease',
          ),
        };
      }
      prepared = live;
    } else {
      const admitted = await this.admitGrant(input, duty, scope);
      if (admitted.state === 'denied') return { state: 'paused', issue: admitted.issue };
      const acquired = await this.acquire(input, scope);
      if (acquired.state === 'unavailable') return acquired.outcome;
      try {
        prepared = await this.commitPreparation(input, duty, scope, anchor, admitted.grant, acquired.instance);
      } catch (error) {
        const cleanup = await this.release(undefined, acquired.instance.lease, scope);
        if (cleanup) throw new AggregateError([error, cleanup], 'Planner preparation failed and its lease cleanup also failed');
        throw error;
      }
      this.live.set(duty.dutyKey, prepared);
    }

    const invocation = {
      stage: 'invoked' as const,
      invocationId: prepared.invocationId,
      preparationCommitRef: prepared.preparationCommitRef,
      invokedAt: this.now().toISOString(),
    };
    let result: ClosedTurnPlannerResult;
    try {
      await this.deps.journal.append({ ...invocation, kind: 'closed-turn-planner-call', duty });
      result = await invoke(prepared);
      validateReturn(input, result);
    } catch (primary) {
      const cleanup = await this.release(duty.dutyKey, prepared.lease, scope);
      if (cleanup) throw new AggregateError([primary, cleanup], 'Planner call failed and its lease cleanup also failed');
      throw primary;
    }

    const returned = {
      stage: 'returned' as const,
      invocationId: prepared.invocationId,
      publication: result.publication,
      returnedAt: this.now().toISOString(),
    };
    let returnCommitRef: JournalCommitRef;
    try {
      returnCommitRef = await this.deps.journal.append({ ...returned, kind: 'closed-turn-planner-call', duty, decision: result.decision });
      const readback = await this.deps.journal.read(scope, duty.dutyKey);
      if (readback?.record.stage !== 'returned'
        || readback.commitRef.commitId !== returnCommitRef.commitId
        || readback.record.invocationId !== prepared.invocationId) {
        throw new ClosedTurnPlannerCallError(
          'planner.call.return-readback-failed',
          'the committed Planner return was not read back exactly',
          { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.return' }, conditionRef: 'closed-turn-planner-call.return' },
        );
      }
    } catch (primary) {
      const cleanup = await this.release(duty.dutyKey, prepared.lease, scope);
      if (cleanup) throw new AggregateError([primary, cleanup], 'Planner return failed and its lease cleanup also failed');
      throw primary;
    }

    const cleanup = await this.release(duty.dutyKey, prepared.lease, scope);
    if (cleanup) {
      throw new AggregateError(
        [
          new ClosedTurnPlannerCallError(
            'planner.call.released-after-return',
            'the Planner return is committed but its lease cleanup is still blocked',
            { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.lease' }, conditionRef: 'closed-turn-planner-call.lease' },
          ),
          cleanup,
        ],
        'Planner return committed; lease cleanup failed',
      );
    }
    return { state: 'returned', result, returnCommitRef };
  }

  private async readAnchor(input: ClosedTurnPlannerCallInput, scope: ScopeRef): Promise<CommittedCheckpointRecord> {
    const checkpointId = input.closure.checkpointId;
    const anchor = await this.deps.checkpoints.readCommitted(scope, checkpointId);
    if (!anchor) {
      throw new ClosedTurnPlannerCallError(
        'planner.call.checkpoint-missing',
        'the exact committed closing checkpoint is not readable',
        { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.checkpoint' }, conditionRef: 'closed-turn-planner-call.checkpoint' },
      );
    }
    if (anchor.checkpoint.id.value !== checkpointId.value
      || anchor.checkpoint.executionEpoch !== (input.segmentSource?.opened.binding.execution.executionEpoch ?? input.allocation.executionEpoch)) {
      throw new ClosedTurnPlannerCallError(
        'planner.call.checkpoint-mismatch',
        'the committed checkpoint does not match the closed turn anchor',
        { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.checkpoint' }, conditionRef: 'closed-turn-planner-call.checkpoint' },
      );
    }
    return anchor;
  }

  private async admitGrant(
    input: ClosedTurnPlannerCallInput,
    duty: ClosedTurnPlannerCallDuty,
    scope: ScopeRef,
  ): Promise<{ readonly state: 'admitted'; readonly grant: AdmittedGrant } | { readonly state: 'denied'; readonly issue: OrchestrationIssue }> {
    const capability: CheckpointControlCapabilityRef = {
      actionId: 'task.execute',
      capabilities: ['provider.execution'],
      scope: input.capabilityScope ?? scope,
    };
    const inputIdentity: CheckpointControlInputIdentity = { requestRef: duty.dutyKey, digest: duty.inputDigest };
    const request: CheckpointControlBusinessRequest = {
      requestRef: duty.dutyKey,
      taskId: input.task.id,
      owner: this.deps.principalOwner,
      capability,
      inputIdentity,
    };
    try {
      const admitted = await admitTaskGrantBusiness({
        port: this.deps.taskGrant,
        request,
        principalOwner: this.deps.principalOwner,
        register: async (authority, registration) => {
          const admissionCommitRef = await registration.registerBusiness({
            requestRef: duty.dutyKey,
            taskId: input.task.id,
            owner: authority.owner,
            capability,
            inputIdentity,
            grantRevision: authority.grant.revision,
          });
          return { grantCommitRef: authority.commit, admissionCommitRef };
        },
      });
      return { state: 'admitted', grant: admitted };
    } catch (error) {
      if (error instanceof TaskGrantDeniedError || error instanceof AdmissionError) {
        return {
          state: 'denied',
          issue: issue(
            'planner.call.admission-denied',
            error.message,
            { kind: 'recover', ref: 'closed-turn-planner-call.admission' },
            scope,
            'closed-turn-planner-call.admission',
          ),
        };
      }
      throw error;
    }
  }

  private async acquire(
    input: ClosedTurnPlannerCallInput,
    scope: ScopeRef,
  ): Promise<{ readonly state: 'acquired'; readonly instance: AcquiredInstance } | { readonly state: 'unavailable'; readonly outcome: Exclude<ClosedTurnPlannerCallOutcome, { readonly state: 'returned' }> }> {
    const acquired = await this.deps.pool.acquire<RuntimeInstanceRequest, TaskInstanceHandle>({
      requiredCapabilities: [...this.deps.requiredCapabilities],
      ownerId: this.deps.ownerId,
      executionEpoch: input.allocation.executionEpoch,
      taskId: input.task.id,
      roleId: this.deps.roleId,
      agentId: this.deps.agentId,
      assignment: { assignmentId: this.deps.assignmentId, taskId: input.task.id, attempt: 1 },
      creator: this.deps.createInstance,
      scope,
    });
    if (acquired.status !== 'acquired') {
      return {
        state: 'unavailable',
        outcome: {
          state: acquired.status === 'waiting' ? 'waiting' : 'paused',
          issue: acquired.issue,
        },
      };
    }
    return {
      state: 'acquired',
      instance: {
        incarnation: acquired.incarnation,
        lease: acquired.lease,
        decision: acquired.decision,
      },
    };
  }

  private async commitPreparation(
    input: ClosedTurnPlannerCallInput,
    duty: ClosedTurnPlannerCallDuty,
    scope: ScopeRef,
    anchor: CommittedCheckpointRecord,
    grant: AdmittedGrant,
    instance: AcquiredInstance,
  ): Promise<PreparedClosedTurnPlannerCall> {
    const execution: ProviderExecutionIdentityRef = {
      runtimeId: instance.incarnation.runtimeId,
      taskId: input.task.id,
      operationId: input.allocation.operationId,
      organId: scope.organId,
      cycleId: input.allocation.cycleId,
      executionEpoch: input.allocation.executionEpoch,
    };
    const invocationId = `closed-turn-planner-invocation:${duty.dutyKey}`;
    const preparation = {
      stage: 'prepared' as const,
      invocationId,
      execution,
      incarnation: instance.incarnation,
      lease: instance.lease,
      decision: instance.decision,
      grantCommitRef: grant.grantCommitRef,
      admissionCommitRef: grant.admissionCommitRef,
      checkpoint: anchor,
      preparedAt: this.now().toISOString(),
      configuredAgentId: this.deps.agentId,
    };
    const preparationCommitRef = await this.deps.journal.append({ ...preparation, kind: 'closed-turn-planner-call', duty });
    const prepared = {
      invocationId,
      execution,
      scope,
      assignmentId: instance.incarnation.assignmentId,
      configuredAgentId: this.deps.agentId,
      incarnation: instance.incarnation,
      lease: instance.lease,
      decision: instance.decision,
      grantCommitRef: grant.grantCommitRef,
      admissionCommitRef: grant.admissionCommitRef,
      checkpoint: anchor,
      preparationCommitRef,
    };
    return { ...prepared, duty };
  }

  private async release(dutyKey: string | undefined, lease: RuntimePoolLease, scope: ScopeRef): Promise<Error | undefined> {
    const result = await this.deps.pool.release(lease, { scope });
    if (dutyKey !== undefined) this.live.delete(dutyKey);
    if (result.status === 'released') return undefined;
    return new ClosedTurnPlannerCallError(
      'planner.call.release-blocked',
      result.issue.reason,
      { scope, nextAction: { kind: 'recover', ref: 'closed-turn-planner-call.lease' }, conditionRef: 'closed-turn-planner-call.lease' },
    );
  }
}
