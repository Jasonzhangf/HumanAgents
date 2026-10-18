import {
  assertEvidenceRef,
  assertProviderExecutionIdentityMatch,
  canonicalJsonStringify,
  id,
  validateJournalCommitRef,
  validateWorkAssignment,
  validateWorkResult,
  validateMilestoneReviewResultRecord,
  validateReviewDelivery,
  type EvidenceRef,
  type I2JournalPort,
  type I2Record,
  type JournalCommitRef,
  type MilestoneReviewResultRecord,
  type NextAction,
  type ReviewDelivery,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../contracts/src/index.js';
import {
  assertReviewResultMatchesAssignment,
  createReviewAssignments,
  decideReviewGate,
  type ReviewAssignment,
  type ReviewDecision,
  type ReviewResult,
} from '../review/index.js';
import { AssignmentGraph, assignmentKey, type AssignmentResultAcceptance } from './assignment-graph.js';
import { OrchestrationError } from './errors.js';
import { assertReviewMaterial, type ExecutorReviewEvidence, type ReviewMaterial, resolveReviewMaterial } from './review-material.js';
import { AgentRuntimePoolManager, type RuntimePoolAcquireResult } from './runtime-pool.js';
import { scopeContains } from '../events/acl.js';
import type {
  AssignmentRecord,
  ChildCallPort,
  PreparedChildCall,
  DispatchInput,
  ExecutionAgentPort,
  ExecutionDelivery,
  ExecutionInstanceAcquireInput,
  IndependentChildCallInput,
  IndependentChildCallResult,
  MilestoneReviewBinding,
  TaskRuntimeIncarnation,
  TaskExecutionHandle,
  MergeCoordinatorPort,
  MergeOutcome,
  OrchestrationDispatchResult,
  OrchestrationFeedbackPort,
  OrchestrationIssue,
  ReviewAgentPort,
  ReviewInstanceRequest,
  RuntimePoolLease,
  TaskReviewHandle,
} from './types.js';

export interface OrchestrationManagerOptions {
  readonly ownerId: string;
  readonly runtimePool: AgentRuntimePoolManager;
  readonly executionAgent?: ExecutionAgentPort;
  readonly reviewAgent?: ReviewAgentPort;
  /**
   * Durable Journal port for declared I2 milestone reviews. Absent, a declared
   * I2 review fails explicitly instead of falling back to the in-memory gate.
   */
  readonly reviewJournal?: I2JournalPort;
  readonly mergeCoordinator?: MergeCoordinatorPort;
  readonly feedback?: OrchestrationFeedbackPort;
  readonly graph?: AssignmentGraph;
  readonly maxAttempts?: number;
  /**
   * Runtime child-call port. When bound, the manager persists the call
   * checkpoint and invocation/checkpoint association before every real
   * execution/review port call, and records return/adoption separately. When
   * absent the manager keeps the prior behaviour unchanged.
   */
  readonly childCallPort?: ChildCallPort;
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100);
  return normalized || 'orchestration';
}

function evidence(scope: ScopeRef, locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `orchestration-${safeId(locator)}`),
    kind: 'operation',
    source: 'orchestration-manager',
    locator,
    scope,
  };
}

function issue(
  code: string,
  ownerId: string,
  reason: string,
  nextAction: NextAction,
  evidenceRefs: readonly EvidenceRef[],
  conditionRef?: string,
): OrchestrationIssue {
  const refs = evidenceRefs.length > 0
    ? evidenceRefs
    : [evidence({ organId: id('organ', 'orchestration-manager') }, conditionRef ?? code)];
  return {
    code,
    ownerId,
    reason,
    nextAction,
    evidenceRefs: [...refs],
    ...(conditionRef ? { conditionRef } : {}),
  };
}

function issueFromUnknown(
  error: unknown,
  fallback: {
    readonly code: string;
    readonly ownerId: string;
    readonly scope: ScopeRef;
    readonly conditionRef: string;
    readonly evidenceRefs?: readonly EvidenceRef[];
  },
): OrchestrationIssue {
  if (error instanceof OrchestrationError) {
    return issue(
      fallback.code,
      error.ownerId,
      error.reason,
      error.nextAction,
      error.evidenceRefs.length > 0 ? error.evidenceRefs : fallback.evidenceRefs ?? [evidence(fallback.scope, fallback.conditionRef)],
      error.conditionRef ?? fallback.conditionRef,
    );
  }
  return issue(
    fallback.code,
    fallback.ownerId,
    error instanceof Error ? error.message : String(error),
    { kind: 'recover', ref: fallback.conditionRef },
    fallback.evidenceRefs ?? [evidence(fallback.scope, fallback.conditionRef)],
    fallback.conditionRef,
  );
}

function normalizeDelivery(delivery: WorkResult | ExecutionDelivery): ExecutionDelivery {
  if ('result' in delivery) return delivery;
  return { result: delivery };
}

function assertExecutionDelivery(delivery: ExecutionDelivery, assignment: WorkAssignment, agentId: string): void {
  validateWorkResult(delivery.result, assignment);
  if (delivery.result.agentId !== agentId) throw new Error('work result agent does not match the selected agent');
  for (const ref of delivery.result.evidenceRefs) assertEvidenceRef(ref);
  const criteria = delivery.criteria;
  if (criteria) {
    const known = new Set([...assignment.successCriteria, ...assignment.failureCriteria, ...assignment.incompleteCriteria]);
    for (const value of [...criteria.satisfied, ...criteria.failed, ...criteria.incomplete]) {
      if (!known.has(value)) throw new Error(`criterion is not part of the assignment: ${value}`);
    }
    if (delivery.result.status === 'succeeded'
      && (new Set(criteria.satisfied).size !== new Set(assignment.successCriteria).size
        || assignment.successCriteria.some((value) => !criteria.satisfied.includes(value))
        || criteria.failed.length > 0 || criteria.incomplete.length > 0)) {
      throw new Error('success criteria were not all satisfied or also matched failure/incomplete criteria');
    }
  }
  if (delivery.result.status === 'failed'
    && (assignment.failureCriteria.length === 0 || (criteria && criteria.failed.length === 0))) {
    throw new Error('failed result did not match a failure criterion');
  }
  if (delivery.result.status === 'incomplete'
    && (assignment.incompleteCriteria.length === 0 || (criteria && criteria.incomplete.length === 0))) {
    throw new Error('incomplete result did not match an incomplete criterion');
  }
}

function uniqueEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.evidenceId.value)) return false;
    seen.add(ref.evidenceId.value);
    return true;
  });
}

function scopedEvidenceRefs(scope: ScopeRef, refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return uniqueEvidenceRefs(refs.map((ref) => (scopeContains(scope, ref.scope) ? ref : { ...ref, scope })));
}

function leaseBinding(lease: RuntimePoolLease) {
  return {
    runtimeId: lease.runtimeId,
    generation: lease.generation,
    leaseId: lease.leaseId,
    assignmentId: lease.assignmentId,
    executionEpoch: lease.executionEpoch,
  };
}

function sameIncarnation(a: TaskRuntimeIncarnation, b: TaskRuntimeIncarnation): boolean {
  return a.runtimeId === b.runtimeId
    && a.generation === b.generation
    && a.agentInstanceId === b.agentInstanceId
    && a.roleId === b.roleId
    && a.taskId.value === b.taskId.value
    && a.assignmentId === b.assignmentId
    && a.executionEpoch === b.executionEpoch;
}

function retryAssignment(
  assignment: WorkAssignment,
  remediation: {
    readonly reason: string;
    readonly requiredCapabilities?: readonly string[];
  },
): WorkAssignment {
  const attempt = assignment.attempt + 1;
  return {
    ...assignment,
    attempt,
    requiredCapabilities: [...(remediation.requiredCapabilities ?? assignment.requiredCapabilities)],
  };
}

function allReviewsPassed(results: readonly ReviewResult[]): boolean {
  return results.length > 0 && results.every((result) => result.status === 'passed');
}

function reviewWaitingForMerge(decision: ReviewDecision, assignment: WorkAssignment): boolean {
  return decision.status === 'waiting'
    && decision.nextAction.kind === 'wait'
    && decision.nextAction.ref === `merge:${assignment.assignmentId}`;
}

function reviewNextAction(
  decision: Pick<ReviewDecision, 'nextAction'>,
): NextAction {
  switch (decision.nextAction.kind) {
    case 'stop':
      return { kind: 'stop', ref: decision.nextAction.ref };
    case 'wait':
      return { kind: 'wait', ref: decision.nextAction.ref };
    case 'remediate':
    case 'review':
      return { kind: 'recover', ref: decision.nextAction.ref };
    case 'settle':
      return { kind: 'continue', ref: decision.nextAction.ref };
  }
}

function hasIncarnationPort(port: ExecutionAgentPort | undefined): port is ExecutionAgentPort {
  return !!port && typeof port.createInstance === 'function'
    && typeof port.roleId === 'string' && port.roleId.trim().length > 0;
}

function hasReviewIncarnationPort(port: ReviewAgentPort | undefined): port is ReviewAgentPort {
  return !!port && typeof port.createInstance === 'function'
    && typeof port.roleId === 'string' && port.roleId.trim().length > 0;
}

type DurableReviewOutcome =
  | { readonly ok: true; readonly delivery: ReviewDelivery; readonly commitRef: JournalCommitRef }
  | { readonly ok: false; readonly issue: OrchestrationIssue };

type ReturnedChildCall = Extract<IndependentChildCallResult, { readonly state: 'returned' }>;
interface ChildCallAttempt {
  readonly canonicalInput: string;
  inFlight?: Promise<IndependentChildCallResult>;
  returned?: ReturnedChildCall;
  terminal?: IndependentChildCallResult;
  invoked: boolean;
}

/** The readback must resolve the exact record that was committed. */
function assertMilestoneReviewReadback(record: I2Record, expected: MilestoneReviewResultRecord): void {
  if (record.kind !== 'milestone-review-result') {
    throw new Error('milestone review readback is not a milestone review result');
  }
  if (JSON.stringify(record) !== JSON.stringify(expected)) {
    throw new Error('milestone review readback does not match the committed record');
  }
}

export class OrchestrationManager {
  readonly ownerId: string;
  readonly graph: AssignmentGraph;
  private readonly runtimePool: AgentRuntimePoolManager;
  private readonly executionAgent?: ExecutionAgentPort;
  private readonly reviewAgent?: ReviewAgentPort;
  private readonly reviewJournal?: I2JournalPort;
  private readonly mergeCoordinator?: MergeCoordinatorPort;
  private readonly feedback?: OrchestrationFeedbackPort;
  private readonly childCallPort?: ChildCallPort;
  private readonly maxAttempts: number;
  private readonly inFlightDispatches = new Map<string, Promise<OrchestrationDispatchResult>>();
  private readonly childCalls = new Map<string, ChildCallAttempt>();

  constructor(options: OrchestrationManagerOptions) {
    if (!options.ownerId.trim()) throw new OrchestrationError('orchestration owner is required', {
      ownerId: options.ownerId,
      reason: 'orchestration.owner.required',
      nextAction: { kind: 'recover', ref: 'orchestration.owner' },
      evidenceRefs: [evidence({ organId: id('organ', 'orchestration-manager') }, 'orchestration.owner.required')],
    });
    if (options.maxAttempts !== undefined && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1)) {
      throw new OrchestrationError('max attempts must be a positive safe integer', {
        ownerId: options.ownerId,
        reason: 'orchestration.attempts.invalid',
        nextAction: { kind: 'recover', ref: 'orchestration.attempts' },
        evidenceRefs: [evidence({ organId: id('organ', 'orchestration-manager') }, 'orchestration.attempts.invalid')],
      });
    }
    this.ownerId = options.ownerId;
    this.runtimePool = options.runtimePool;
    this.executionAgent = options.executionAgent;
    this.reviewAgent = options.reviewAgent;
    this.reviewJournal = options.reviewJournal;
    this.mergeCoordinator = options.mergeCoordinator;
    this.feedback = options.feedback;
    this.childCallPort = options.childCallPort;
    if (options.graph && options.graph.ownerId !== this.ownerId) {
      throw new OrchestrationError('assignment graph owner does not match orchestration owner', {
        ownerId: this.ownerId,
        reason: 'orchestration.graph.owner-mismatch',
        nextAction: { kind: 'recover', ref: 'orchestration.graph.owner' },
        evidenceRefs: [evidence({ organId: id('organ', 'orchestration-manager') }, 'orchestration.graph.owner-mismatch')],
      });
    }
    this.graph = options.graph ?? new AssignmentGraph({ ownerId: this.ownerId });
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  planStage(input: Parameters<AssignmentGraph['addStage']>[0]) {
    return this.graph.addStage(input);
  }

  createAssignment(stageNodeId: string, assignment: WorkAssignment): AssignmentRecord {
    return this.graph.createAssignment(stageNodeId, assignment);
  }

  async acquireExecutionInstance(input: ExecutionInstanceAcquireInput): Promise<RuntimePoolAcquireResult<TaskExecutionHandle>> {
    return this.acquireBoundExecutionInstance(input, this.executionAgent);
  }

  private async acquireBoundExecutionInstance(
    input: ExecutionInstanceAcquireInput,
    agent: ExecutionAgentPort | undefined,
  ): Promise<RuntimePoolAcquireResult<TaskExecutionHandle>> {
    if (!hasIncarnationPort(agent)) {
      return {
        status: 'blocked',
        issue: issue(
          'execution-incarnation-unavailable',
          this.ownerId,
          'execution agent cannot construct a task-scoped instance (roleId/createInstance missing)',
          { kind: 'recover', ref: 'orchestration.execution.incarnation' },
          [evidence(input.scope, 'orchestration.execution.incarnation')],
          'orchestration.execution.incarnation',
        ),
      };
    }
    return this.runtimePool.acquire({
      requiredCapabilities: input.assignment.requiredCapabilities,
      ownerId: this.ownerId,
      executionEpoch: input.executionEpoch,
      taskId: input.assignment.taskId,
      roleId: agent.roleId,
      agentId: input.agentId,
      assignment: input.assignment,
      creator: (createInput) => agent.createInstance(createInput),
      scope: input.scope,
    });
  }

  /**
   * One parent-selected genuine child. Returns only; adoption and the next
   * choice belong to the parent. Durable restart lookup belongs to the
   * registered tool producer, not this task-local in-flight/known-return cache.
   */
  async callChild(input: IndependentChildCallInput): Promise<IndependentChildCallResult> {
    const invocationId = input.call.invocationId;
    const blocked = (error: unknown): IndependentChildCallResult => ({
      state: 'blocked', invocationId,
      issue: issueFromUnknown(error, {
        code: 'orchestration.child-call-failed', ownerId: this.ownerId,
        scope: input.scope, conditionRef: invocationId,
      }),
    });
    let canonicalInput: string;
    try {
      for (const value of [invocationId, input.call.providerRequestId, input.call.toolCallId, input.agentId]) {
        if (!value.trim()) throw new Error('registered child call identity is required');
      }
      assertProviderExecutionIdentityMatch(input.call.parentExecution, input.call.parentExecution);
      validateJournalCommitRef(input.call.businessRegistrationCommitRef);
      const worker = input.kind === 'execution' ? input.assignment : input.input.workerAssignment;
      validateWorkAssignment(worker);
      if (input.call.parentExecution.taskId.value !== worker.taskId.value
        || input.scope.taskId?.value !== worker.taskId.value) {
        throw new Error('child call task must match its registered parent and scope');
      }
      if (input.kind === 'review') {
        validateWorkResult(input.input.workerResult, worker);
        assertReviewMaterial(input.input.reviewMaterial);
        const material = resolveReviewMaterial({
          workerAssignment: worker, workerResult: input.input.workerResult,
          subjects: input.input.reviewMaterial.subjects,
          executorEvidence: input.input.reviewMaterial.executorEvidence,
        });
        if (material.acceptanceCriteria !== input.input.reviewMaterial.acceptanceCriteria
          || canonicalJsonStringify(material.subjects) !== canonicalJsonStringify(input.input.reviewMaterial.subjects)
          || canonicalJsonStringify(input.input.scope) !== canonicalJsonStringify(input.scope)) {
          throw new Error('review material or scope does not match the real worker');
        }
        const expected = createReviewAssignments({
          workerAssignment: worker, workerResult: input.input.workerResult,
          reviewKinds: [input.input.reviewAssignment.reviewKind],
          subjectRefs: worker.targetRefs,
        })[0];
        if (canonicalJsonStringify(expected) !== canonicalJsonStringify(input.input.reviewAssignment)) {
          throw new Error('review assignment does not match the real worker');
        }
        if (!hasReviewIncarnationPort(input.reviewAgent)) throw new Error('review incarnation creator is required');
        if (input.milestoneReview) {
          if (!this.reviewJournal) throw new Error('a declared I2 review requires an injected I2 journal port');
          if (!input.milestoneReview.milestoneId.trim()
            || input.milestoneReview.reviewerAgentId !== input.agentId
            || input.milestoneReview.taskScope.taskId.value !== worker.taskId.value
            || input.milestoneReview.taskScope.cycleId || input.milestoneReview.taskScope.operationId
            || canonicalJsonStringify(input.milestoneReview.executionScope) !== canonicalJsonStringify(input.scope)) {
            throw new Error('milestone binding does not match the selected reviewer and scope');
          }
          validateJournalCommitRef(input.milestoneReview.planRevisionCommitRef);
        }
      }
      canonicalInput = canonicalJsonStringify({
        call: input.call, kind: input.kind, agentId: input.agentId, scope: input.scope,
        roleId: input.kind === 'execution' ? input.executionAgent.roleId : input.reviewAgent.roleId,
        request: input.kind === 'execution' ? input.assignment : { ...input.input, signal: undefined },
        inspection: input.kind === 'execution' ? input.inspection ?? null : null,
        milestoneReview: input.kind === 'review' ? input.milestoneReview ?? null : null,
      });
    } catch (error) { return blocked(error); }
    let attempt = this.childCalls.get(invocationId);
    if (attempt && attempt.canonicalInput !== canonicalInput) return blocked(new Error('registered invocation already binds different child input'));
    if (attempt?.inFlight) return attempt.inFlight;
    if (attempt?.terminal) return attempt.terminal;
    if (!attempt) {
      attempt = { canonicalInput, invoked: false };
      this.childCalls.set(invocationId, attempt);
    }
    const current = attempt;
    const pending = this.runChildCall(input, current).catch(blocked);
    current.inFlight = pending;
    try { return await pending; }
    finally { current.inFlight = undefined; }
  }

  private async runChildCall(
    input: IndependentChildCallInput,
    attempt: ChildCallAttempt,
  ): Promise<IndependentChildCallResult> {
    const invocationId = input.call.invocationId;
    let lease: RuntimePoolLease | undefined;
    let outcome: IndependentChildCallResult;
    try {
      input.signal.throwIfAborted();
      if (!attempt.returned) {
        const acquired = input.kind === 'execution'
          ? await this.acquireBoundExecutionInstance({
              assignment: input.assignment, scope: input.scope, agentId: input.agentId,
              executionEpoch: input.assignment.executionEpoch,
            }, input.executionAgent)
          : await this.runtimePool.acquire<ReviewInstanceRequest, TaskReviewHandle>({
              requiredCapabilities: input.input.reviewAssignment.requiredCapabilities,
              ownerId: this.ownerId, executionEpoch: input.input.reviewAssignment.executionEpoch,
              taskId: input.input.workerAssignment.taskId, roleId: input.reviewAgent.roleId,
              agentId: input.agentId, scope: input.scope,
              assignment: {
                // The pool assignment identity is the real subject-bound review
                // assignment. The registered parent invocation travels beside it
                // so the reviewer creator binds the real registered call.
                assignmentId: input.input.reviewAssignment.assignmentId, invocationId,
                taskId: input.input.workerAssignment.taskId,
                attempt: input.input.reviewAssignment.attempt,
                reviewAssignment: input.input.reviewAssignment, workerAssignment: input.input.workerAssignment,
              },
              creator: (create) => input.reviewAgent.createInstance(create),
            });
        if (acquired.status !== 'acquired') return { state: acquired.status, invocationId, issue: acquired.issue };
        lease = acquired.lease;
        const assignment = input.kind === 'execution' ? input.assignment : input.input.reviewAssignment;
        const prepared = input.kind === 'execution'
          ? await input.childCallPort.prepare({
              kind: 'execution', invocationId, assignment: input.assignment, agentId: input.agentId,
              attempt: input.assignment.attempt, executionEpoch: input.assignment.executionEpoch,
              scope: input.scope, inspection: input.inspection, lease,
            })
          : await input.childCallPort.prepare({
              kind: 'review', invocationId, assignment: input.input.reviewAssignment, agentId: input.agentId,
              attempt: input.input.reviewAssignment.attempt,
              executionEpoch: input.input.reviewAssignment.executionEpoch,
              scope: input.scope, lease,
            });
        if (prepared.invocationId !== invocationId || !prepared.checkpointReceiptRef.trim()) {
          throw new Error('prepared child call must retain the exact invocation and checkpoint receipt');
        }
        input.signal.throwIfAborted();
        attempt.invoked = true;
        if (input.kind === 'execution') {
          const delivery = normalizeDelivery(await (acquired.handle as TaskExecutionHandle).execute({
            assignment: input.assignment, agentId: input.agentId,
            executionEpoch: input.assignment.executionEpoch, attempt: input.assignment.attempt,
            lease, scope: input.scope, inspection: input.inspection, signal: input.signal,
          }));
          assertExecutionDelivery(delivery, input.assignment, input.agentId);
          attempt.returned = {
            state: 'returned', kind: 'execution', invocationId, incarnation: acquired.incarnation,
            result: { ...delivery.result, evidenceRefs: scopedEvidenceRefs(input.scope, delivery.result.evidenceRefs) },
            ...(delivery.inspectionDelivery ? { inspectionDelivery: delivery.inspectionDelivery } : {}),
          };
        } else {
          const delivery = await this.invokeReviewHandle(acquired.handle as TaskReviewHandle, {
            ...input.input, signal: input.signal,
          });
          attempt.returned = { state: 'returned', kind: 'review', invocationId, incarnation: acquired.incarnation, delivery };
        }
      }
      outcome = await this.persistChildReturn(input, attempt.returned!);
      attempt.returned = outcome;
      attempt.terminal = outcome;
    } catch (error) {
      outcome = {
        state: 'blocked', invocationId,
        issue: issueFromUnknown(error, {
          code: 'orchestration.child-call-failed', ownerId: this.ownerId,
          scope: input.scope, conditionRef: invocationId,
        }),
      };
      // A possibly invoked external call with no validated return is unknown.
      // It cannot be replayed merely by retrying the same registered tool call.
      if (attempt.invoked && !attempt.returned) attempt.terminal = outcome;
    }
    if (lease) {
      const released = await this.runtimePool.release(lease, { scope: input.scope });
      if (released.status === 'blocked') {
        outcome = outcome.state === 'returned'
          ? { state: 'blocked', invocationId, issue: released.issue }
          : { ...outcome, releaseIssue: released.issue };
        attempt.terminal = outcome;
      }
    }
    return outcome;
  }

  private async persistChildReturn(input: IndependentChildCallInput, returned: ReturnedChildCall): Promise<ReturnedChildCall> {
    if (input.kind === 'execution' && returned.kind === 'execution') {
      await input.childCallPort.recordReturn({
        kind: 'execution', invocationId: returned.invocationId, assignment: input.assignment,
        agentId: input.agentId, attempt: input.assignment.attempt,
        executionEpoch: input.assignment.executionEpoch, scope: input.scope, result: returned.result,
        ...(returned.inspectionDelivery ? { inspectionDelivery: returned.inspectionDelivery } : {}),
      });
      return returned;
    }
    if (input.kind !== 'review' || returned.kind !== 'review') throw new Error('child return kind mismatch');
    let reviewCommitRef = returned.reviewCommitRef;
    if (input.milestoneReview && !reviewCommitRef) {
      const committed = await this.commitMilestoneReviewDelivery(
        input.milestoneReview, input.input.reviewAssignment, returned.delivery, this.reviewJournal!, input.scope,
      );
      if (!committed.ok) throw new OrchestrationError(committed.issue.reason, committed.issue);
      reviewCommitRef = committed.commitRef;
    }
    await input.childCallPort.recordReturn({
      kind: 'review', invocationId: returned.invocationId, assignment: input.input.reviewAssignment,
      agentId: input.agentId, attempt: input.input.reviewAssignment.attempt,
      executionEpoch: input.input.reviewAssignment.executionEpoch, scope: input.scope, result: returned.delivery.result,
    });
    return { ...returned, ...(reviewCommitRef ? { reviewCommitRef } : {}) };
  }

  async dispatch(input: DispatchInput): Promise<OrchestrationDispatchResult> {
    const begun = this.beginDispatch(input);
    if ('result' in begun) return begun.result;
    const agent = input.executionAgentOverride ?? this.executionAgent;
    if (!agent) {
      const unavailable = issue(
        'execution-agent-unavailable',
        this.ownerId,
        'execution agent capability port is not bound',
        { kind: 'recover', ref: 'orchestration.execution.bind' },
        [evidence(input.scope, 'orchestration.execution.unavailable')],
        'orchestration.execution.unavailable',
      );
      return this.blockedResult(begun.planned, unavailable, input.scope);
    }
    return this.awaitDispatch(begun.key, this.dispatchWithLease(input, begun.planned));
  }

  /**
   * Retained-handle dispatch. The caller has already acquired the exact
   * execution instance; this path reuses the shared dispatch graph, in-flight
   * coalescing, execution, child-call, review and merge machinery, but neither
   * acquires a second instance nor releases the supplied lease. The owning
   * coordinator releases that lease through its real lifecycle endpoint.
   */
  async dispatchAcquired(
    input: DispatchInput,
    acquired: Extract<RuntimePoolAcquireResult<TaskExecutionHandle>, { status: 'acquired' }>,
  ): Promise<OrchestrationDispatchResult> {
    this.assertRetainedAcquisition(input, acquired);
    const begun = this.beginDispatch(input);
    if ('result' in begun) return begun.result;
    return this.awaitDispatch(
      begun.key,
      this.executeRetainedDispatch(input, begun.planned, acquired),
    );
  }

  private beginDispatch(input: DispatchInput):
    | { readonly result: OrchestrationDispatchResult }
    | { readonly planned: AssignmentRecord; readonly key: string } {
    const planned = this.graph.createAssignment(input.stageNodeId, input.assignment);
    const key = assignmentKey(input.assignment);
    if (this.inFlightDispatches.has(key)) {
      return { result: this.progressResult(planned) };
    }
    if (planned.status === 'running' && planned.result) {
      return { result: this.progressResult(planned) };
    }
    if (
      planned.status === 'succeeded'
      || planned.status === 'failed'
      || planned.status === 'incomplete'
      || planned.status === 'blocked'
      || planned.status === 'escalated'
      || planned.status === 'merged'
    ) {
      return {
        result: {
          status: planned.status,
          assignment: planned,
          ...(planned.status === 'blocked' || planned.status === 'escalated' || planned.status === 'failed' || planned.status === 'incomplete'
            ? {
                issue: issue(
                  `assignment-${planned.status}`,
                  planned.ownerId,
                  planned.reason,
                  planned.nextAction,
                  planned.evidenceRefs,
                ),
              }
            : {}),
          reviewResults: planned.reviewResults,
        },
      };
    }
    return { planned, key };
  }

  private async awaitDispatch(
    key: string,
    pending: Promise<OrchestrationDispatchResult>,
  ): Promise<OrchestrationDispatchResult> {
    this.inFlightDispatches.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlightDispatches.get(key) === pending) {
        this.inFlightDispatches.delete(key);
      }
    }
  }

  private assertRetainedAcquisition(
    input: DispatchInput,
    acquired: Extract<RuntimePoolAcquireResult<TaskExecutionHandle>, { status: 'acquired' }>,
  ): void {
    const mismatch = (conditionRef: string) => new OrchestrationError(
      'retained dispatch acquisition does not match the requested assignment',
      {
        ownerId: this.ownerId,
        reason: conditionRef,
        nextAction: { kind: 'recover', ref: conditionRef },
        evidenceRefs: [evidence(input.scope, conditionRef)],
        conditionRef,
      },
    );
    const { lease, incarnation, handle } = acquired;
    if (lease.ownerId !== this.ownerId) throw mismatch('orchestration.dispatch.retained.owner');
    if (lease.assignmentId !== input.assignment.assignmentId
      || incarnation.assignmentId !== input.assignment.assignmentId) {
      throw mismatch('orchestration.dispatch.retained.assignment');
    }
    if (incarnation.taskId.value !== input.assignment.taskId.value) {
      throw mismatch('orchestration.dispatch.retained.task');
    }
    if (input.scope.taskId && input.scope.taskId.value !== input.assignment.taskId.value) {
      throw mismatch('orchestration.dispatch.retained.scope');
    }
    if (!sameIncarnation(handle.incarnation, incarnation) || !sameIncarnation(lease.incarnation, incarnation)) {
      throw mismatch('orchestration.dispatch.retained.instance');
    }
  }

  private async executeRetainedDispatch(
    input: DispatchInput,
    planned: AssignmentRecord,
    acquired: Extract<RuntimePoolAcquireResult<TaskExecutionHandle>, { status: 'acquired' }>,
  ): Promise<OrchestrationDispatchResult> {
    try {
      return await this.executeWithLease(input, acquired.lease, acquired.handle);
    } catch (error) {
      return this.blockedResult(
        planned,
        issueFromUnknown(error, {
          code: 'orchestration-dispatch-failed',
          ownerId: this.ownerId,
          scope: input.scope,
          conditionRef: 'orchestration.dispatch',
        }),
        input.scope,
      );
    }
  }

  private async dispatchWithLease(
    input: DispatchInput,
    planned: AssignmentRecord,
  ): Promise<OrchestrationDispatchResult> {
    const acquireInput: ExecutionInstanceAcquireInput = {
      assignment: input.assignment,
      executionEpoch: input.assignment.executionEpoch,
      agentId: input.agentId,
      scope: input.scope,
    };
    const acquired = input.executionAgentOverride
      ? await this.acquireBoundExecutionInstance(acquireInput, input.executionAgentOverride)
      : await this.acquireExecutionInstance(acquireInput);
    if (acquired.status !== 'acquired') {
      return {
        status: 'blocked',
        assignment: planned,
        issue: acquired.issue,
        reviewResults: planned.reviewResults,
      };
    }
    const lease = acquired.lease;
    let result: OrchestrationDispatchResult | undefined;
    try {
      result = await this.executeWithLease(input, lease, acquired.handle);
    } catch (error) {
      const unexpected = issueFromUnknown(error, {
        code: 'orchestration-dispatch-failed',
        ownerId: this.ownerId,
        scope: input.scope,
        conditionRef: 'orchestration.dispatch',
      });
      result = this.blockedResult(planned, unexpected, input.scope);
    } finally {
      const released = await this.runtimePool.release(lease, { scope: input.scope });
      if (released.status === 'blocked') {
        const current = this.graph.get(input.assignment);
        const blocked = current && current.status !== 'succeeded' && current.status !== 'merged'
          ? this.graph.markBlocked(
              input.assignment,
              released.issue.reason,
              released.issue.nextAction,
              released.issue.evidenceRefs,
            )
          : current ?? planned;
        result = {
          status: blocked.status,
          assignment: blocked,
          ...(blocked.status === 'succeeded' || blocked.status === 'merged'
            ? {}
            : { issue: released.issue }),
          reviewResults: blocked.reviewResults,
        };
      }
    }
    if (!result) throw new OrchestrationError('orchestration dispatch produced no result', {
      ownerId: this.ownerId,
      reason: 'orchestration.dispatch.no-result',
      nextAction: { kind: 'recover', ref: 'orchestration.dispatch' },
      evidenceRefs: [evidence(input.scope, 'orchestration.dispatch.no-result')],
    });
    return result;
  }

  private progressResult(record: AssignmentRecord): OrchestrationDispatchResult {
    return {
      status: 'running',
      assignment: record,
      issue: issue(
        'assignment-progress-pending',
        record.ownerId,
        record.reason,
        record.nextAction,
        record.evidenceRefs,
      ),
      reviewResults: record.reviewResults,
    };
  }

  private async executeWithLease(
    input: DispatchInput,
    lease: RuntimePoolLease,
    executionAgent: TaskExecutionHandle,
  ): Promise<OrchestrationDispatchResult> {
    this.graph.assign(input.assignment, input.agentId, leaseBinding(lease));
    const planned = this.graph.start(input.assignment, input.agentId, leaseBinding(lease));
    let preparedCall: PreparedChildCall | undefined;
    if (this.childCallPort) {
      try {
        preparedCall = await this.childCallPort.prepare({
          kind: 'execution',
          invocationId: `invocation:${input.assignment.assignmentId}:${input.assignment.attempt}:${input.assignment.executionEpoch}`,
          assignment: input.assignment,
          agentId: input.agentId,
          attempt: input.assignment.attempt,
          executionEpoch: input.assignment.executionEpoch,
          scope: input.scope,
          lease,
        });
      } catch (error) {
        // A failed call checkpoint must stop dispatch: the child port is never
        // invoked without a durable recovery anchor.
        return this.blockedResult(
          planned,
          issueFromUnknown(error, {
            code: 'orchestration.child-checkpoint-failed',
            ownerId: this.ownerId,
            scope: input.scope,
            conditionRef: 'orchestration.child.checkpoint',
          }),
          input.scope,
        );
      }
    }
    let rawDelivery: WorkResult | ExecutionDelivery;
    try {
      // Physical execution input comes from the acquired lease; the business
      // result identity stays with the assignment and is validated by the graph.
      rawDelivery = await executionAgent.execute({
        assignment: input.assignment,
        agentId: input.agentId,
        executionEpoch: lease.executionEpoch,
        attempt: input.assignment.attempt,
        lease,
        scope: input.scope,
      });
    } catch (error) {
      const executionIssue = issueFromUnknown(error, {
        code: 'execution-failed',
        ownerId: this.ownerId,
        scope: input.scope,
        conditionRef: 'orchestration.execution',
      });
      if (input.assignment.attempt < this.maxAttempts) {
        const record = this.graph.markRetryable(
          input.assignment,
          executionIssue.reason,
          executionIssue.evidenceRefs,
        );
        const remediation = retryAssignment(input.assignment, { reason: 'execution retry' });
        const feedbackIssue = await this.publish({
          kind: 'retry',
          assignment: input.assignment,
          nextAttempt: remediation.attempt,
          ownerId: this.ownerId,
          reason: executionIssue.reason,
          scope: input.scope,
          evidenceRefs: executionIssue.evidenceRefs,
        });
        if (feedbackIssue) return this.blockedResult(record, feedbackIssue, input.scope);
        return {
          status: 'retryable',
          assignment: record,
          issue: executionIssue,
          remediation,
          reviewResults: record.reviewResults,
        };
      }
      const exhausted = this.graph.markEscalated(
        input.assignment,
        executionIssue.reason,
        executionIssue.nextAction,
        executionIssue.evidenceRefs,
      );
      return this.blockedResult(exhausted, executionIssue, input.scope);
    }

    const delivery = normalizeDelivery(rawDelivery);
    const result = {
      ...delivery.result,
      evidenceRefs: scopedEvidenceRefs(input.scope, delivery.result.evidenceRefs),
    };
    if (this.childCallPort && preparedCall) {
      await this.childCallPort.recordReturn({
        kind: 'execution',
        invocationId: preparedCall.invocationId,
        assignment: input.assignment,
        agentId: input.agentId,
        attempt: input.assignment.attempt,
        executionEpoch: input.assignment.executionEpoch,
        scope: input.scope,
        result,
        ...(delivery.inspectionDelivery ? { inspectionDelivery: delivery.inspectionDelivery } : {}),
      });
    }
    const accepted = this.graph.acceptResult(input.assignment, {
      result,
      expectedAgentId: input.agentId,
      ...(delivery.criteria ? { criteria: delivery.criteria } : {}),
      maxAttempts: this.maxAttempts,
      ownerId: this.ownerId,
      runtimeBinding: leaseBinding(lease),
    });
    if (!accepted.accepted) return this.rejectedResult(input, accepted);
    if (accepted.duplicate) {
      return {
        status: accepted.record.status,
        assignment: accepted.record,
        reviewResults: accepted.record.reviewResults,
      };
    }

    const resultIssue = await this.publish({
      kind: 'work-result',
      assignment: input.assignment,
      result,
      ownerId: this.ownerId,
      scope: input.scope,
      evidenceRefs: result.evidenceRefs,
    });
    if (resultIssue) return this.blockedResult(accepted.record, resultIssue, input.scope);

    if (this.childCallPort && preparedCall) {
      // Owner adoption is a separate fact from the returned refined delivery.
      await this.childCallPort.recordAdoption({
        kind: 'execution',
        invocationId: preparedCall.invocationId,
        assignment: input.assignment,
        result,
        scope: input.scope,
      });
    }

    if (accepted.record.status === 'retryable' || accepted.record.status === 'escalated' || accepted.record.status === 'blocked') {
      const retry = accepted.record.status === 'retryable'
        ? retryAssignment(input.assignment, { reason: 'failed or incomplete result' })
        : undefined;
      const feedbackIssue = await this.publishFailureFeedback(
        input,
        accepted.record,
        accepted.record.status === 'retryable' ? 'retry' : 'attention',
        retry?.attempt,
      );
      if (feedbackIssue) return this.blockedResult(accepted.record, feedbackIssue, input.scope);
      return {
        status: accepted.record.status,
        assignment: accepted.record,
        ...(accepted.record.status === 'retryable' || accepted.record.status === 'escalated' || accepted.record.status === 'blocked'
          ? { issue: issue(
              `work-${accepted.record.status}`,
              accepted.record.ownerId,
              accepted.record.reason,
              accepted.record.nextAction,
              accepted.record.evidenceRefs,
            ) }
          : {}),
        ...(retry ? { remediation: retry } : {}),
        reviewResults: accepted.record.reviewResults,
      };
    }

    if (result.nextAction === 'attention') {
      const escalated = this.graph.markEscalated(
        input.assignment,
        result.conditionRef ?? result.failureRef ?? 'work result requires attention',
        { kind: 'recover', ref: result.conditionRef ?? `attention.${input.assignment.assignmentId}` },
        result.evidenceRefs,
      );
      const feedbackIssue = await this.publishFailureFeedback(input, escalated, 'attention');
      if (feedbackIssue) return this.blockedResult(escalated, feedbackIssue, input.scope);
      return {
        status: 'escalated',
        assignment: escalated,
        issue: issue(
          'work-attention',
          escalated.ownerId,
          escalated.reason,
          escalated.nextAction,
          escalated.evidenceRefs,
        ),
        reviewResults: escalated.reviewResults,
      };
    }

    const reviewRequired = result.nextAction === 'review' || input.assignment.mergeGate === 'required';
    if (!reviewRequired) {
      return {
        status: 'succeeded',
        assignment: this.graph.markSucceeded(input.assignment, accepted.record.evidenceRefs),
        reviewResults: accepted.record.reviewResults,
      };
    }
    return this.reviewAndMerge(input, accepted.record, result);
  }

  /**
   * Constructs a real reviewer instance, invokes its scope-bound handle, and
   * commits the milestone review result with an exact readback BEFORE the
   * caller records graph acceptance, publishes feedback, or decides the gate.
   * A missing port, an invalid delivery, or a failed commit/readback returns an
   * explicit issue; the reviewer identity is the constructed incarnation and is
   * never the reviewed worker.
   */
  private async runDurableMilestoneReview(
    input: DispatchInput,
    binding: MilestoneReviewBinding,
    reviewAssignment: ReviewAssignment,
    workerAssignment: WorkAssignment,
    workerResult: WorkResult,
    reviewMaterial: ReviewMaterial,
  ): Promise<DurableReviewOutcome> {
    const agent = input.reviewAgentOverride ?? this.reviewAgent;
    if (!agent) {
      return {
        ok: false,
        issue: issue(
          'review-agent-unavailable',
          this.ownerId,
          'review agent capability port is not bound',
          { kind: 'recover', ref: 'orchestration.review.bind' },
          [evidence(input.scope, 'orchestration.review.unavailable')],
          'orchestration.review.unavailable',
        ),
      };
    }
    if (!hasReviewIncarnationPort(agent)) {
      return {
        ok: false,
        issue: issue(
          'review-incarnation-unavailable',
          this.ownerId,
          'review agent cannot construct a task-scoped reviewer instance (roleId/createInstance missing)',
          { kind: 'recover', ref: 'orchestration.review.incarnation' },
          [evidence(input.scope, 'orchestration.review.incarnation')],
          'orchestration.review.incarnation',
        ),
      };
    }
    const journal = this.reviewJournal;
    if (!journal) {
      return {
        ok: false,
        issue: issue(
          'review-journal-unavailable',
          this.ownerId,
          'a declared I2 review requires an injected I2 journal port',
          { kind: 'recover', ref: 'orchestration.review.journal' },
          [evidence(input.scope, 'orchestration.review.journal')],
          'orchestration.review.journal',
        ),
      };
    }
    try {
      if (!binding.milestoneId.trim()) throw new Error('milestone review milestone id is required');
      if (!binding.reviewerAgentId.trim()) throw new Error('milestone review reviewer agent id is required');
      if (
        binding.taskScope.cycleId !== undefined
        || binding.taskScope.operationId !== undefined
      ) {
        throw new Error('milestone review task scope must be task-level');
      }
    } catch (error) {
      return {
        ok: false,
        issue: issueFromUnknown(error, {
          code: 'review-milestone-invalid',
          ownerId: this.ownerId,
          scope: input.scope,
          conditionRef: 'orchestration.review.milestone',
        }),
      };
    }

    const reviewRequest: ReviewInstanceRequest = {
      assignmentId: reviewAssignment.assignmentId,
      taskId: workerAssignment.taskId,
      attempt: reviewAssignment.attempt,
      reviewAssignment,
      workerAssignment,
    };
    const acquired = await this.runtimePool.acquire({
      requiredCapabilities: reviewAssignment.requiredCapabilities,
      ownerId: this.ownerId,
      executionEpoch: reviewAssignment.executionEpoch,
      taskId: workerAssignment.taskId,
      roleId: agent.roleId,
      agentId: binding.reviewerAgentId,
      assignment: reviewRequest,
      creator: (createInput) => agent.createInstance(createInput),
      scope: input.scope,
    });
    if (acquired.status !== 'acquired') return { ok: false, issue: acquired.issue };

    let outcome: DurableReviewOutcome;
    try {
      outcome = await this.invokeAndCommitMilestoneReview(
        acquired.handle,
        binding,
        reviewAssignment,
        workerAssignment,
        workerResult,
        reviewMaterial,
        journal,
        input.scope,
      );
    } catch (error) {
      outcome = {
        ok: false,
        issue: issueFromUnknown(error, {
          code: 'review-commit-failed',
          ownerId: this.ownerId,
          scope: input.scope,
          conditionRef: 'orchestration.review.commit',
        }),
      };
    }
    const released = await this.runtimePool.release(acquired.lease, { scope: input.scope });
    if (released.status === 'blocked') return { ok: false, issue: released.issue };
    return outcome;
  }

  private async invokeAndCommitMilestoneReview(
    handle: TaskReviewHandle,
    binding: MilestoneReviewBinding,
    reviewAssignment: ReviewAssignment,
    workerAssignment: WorkAssignment,
    workerResult: WorkResult,
    reviewMaterial: ReviewMaterial,
    journal: I2JournalPort,
    scope: ScopeRef,
  ): Promise<DurableReviewOutcome> {
    let delivery: ReviewDelivery;
    try {
      delivery = await this.invokeReviewHandle(handle, {
        reviewAssignment,
        workerAssignment,
        workerResult,
        reviewMaterial,
        scope,
      });
    } catch (error) {
      return {
        ok: false,
        issue: issueFromUnknown(error, {
          code: 'review-delivery-invalid',
          ownerId: this.ownerId,
          scope,
          conditionRef: 'orchestration.review.delivery',
        }),
      };
    }

    return this.commitMilestoneReviewDelivery(binding, reviewAssignment, delivery, journal, scope);
  }

  private async invokeReviewHandle(
    handle: TaskReviewHandle,
    input: Parameters<TaskReviewHandle['review']>[0],
  ): Promise<ReviewDelivery> {
    assertReviewMaterial(input.reviewMaterial);
    const delivered = await handle.review(input);
    assertReviewMaterial(input.reviewMaterial);
    assertReviewResultMatchesAssignment(input.reviewAssignment, delivered.result);
    const delivery: ReviewDelivery = {
      result: delivered.result, reviewer: handle.incarnation,
      output: delivered.output, completedAt: delivered.completedAt,
    };
    validateReviewDelivery(delivery);
    if (delivery.result.workerAgentId === delivery.reviewer.agentInstanceId) {
      throw new Error('reviewed worker identity must not equal the reviewer instance identity');
    }
    return delivery;
  }

  private async commitMilestoneReviewDelivery(
    binding: MilestoneReviewBinding,
    reviewAssignment: ReviewAssignment,
    delivery: ReviewDelivery,
    journal: I2JournalPort,
    scope: ScopeRef,
  ): Promise<DurableReviewOutcome> {
    const record: MilestoneReviewResultRecord = {
      kind: 'milestone-review-result',
      schemaVersion: 1,
      milestoneId: binding.milestoneId,
      cycleId: binding.cycleId,
      taskScope: binding.taskScope,
      executionScope: binding.executionScope,
      planRevisionCommitRef: binding.planRevisionCommitRef,
      reviewAssignment,
      delivery,
      completedAt: delivery.completedAt,
    };
    try {
      validateMilestoneReviewResultRecord(record);
      const commitRef = await journal.commit(record);
      const readBack = await journal.read(binding.taskScope, commitRef);
      assertMilestoneReviewReadback(readBack, record);
      return { ok: true, delivery, commitRef };
    } catch (error) {
      return {
        ok: false,
        issue: issueFromUnknown(error, {
          code: 'review-commit-failed',
          ownerId: this.ownerId,
          scope,
          conditionRef: 'orchestration.review.commit',
        }),
      };
    }
  }

  private async reviewAndMerge(
    input: DispatchInput,
    record: AssignmentRecord,
    result: WorkResult,
  ): Promise<OrchestrationDispatchResult> {
    const reviewAgent = input.reviewAgentOverride ?? this.reviewAgent;
    if (!reviewAgent) {
      const unavailable = issue(
        'review-agent-unavailable',
        this.ownerId,
        'review agent capability port is not bound',
        { kind: 'recover', ref: 'orchestration.review.bind' },
        [evidence(input.scope, 'orchestration.review.unavailable')],
        'orchestration.review.unavailable',
      );
      return this.blockedResult(record, unavailable, input.scope);
    }

    let reviewMaterial: ReviewMaterial;
    try {
      // The produced body is carried by the result: the caller cannot know a
      // body that only exists after the worker ran. A caller-supplied subject
      // remains an explicit override.
      const overrides = new Map((input.reviewSubjects ?? []).map((subject) => [subject.ref, subject.body]));
      const subjects = input.assignment.targetRefs.map((ref, index) => ({
        ref,
        body: overrides.get(ref) ?? result.producedArtifactBodies?.[index] ?? '',
      }));
      reviewMaterial = resolveReviewMaterial({
        workerAssignment: input.assignment,
        workerResult: result,
        subjects,
        executorEvidence: (result as WorkResult & { readonly executorEvidence?: readonly ExecutorReviewEvidence[] }).executorEvidence,
      });
    } catch (error) {
      return this.blockedResult(
        record,
        issueFromUnknown(error, {
          code: 'review-material-invalid',
          ownerId: this.ownerId,
          scope: input.scope,
          conditionRef: 'orchestration.review.material',
          evidenceRefs: result.evidenceRefs.length > 0
            ? result.evidenceRefs
            : [evidence(input.scope, 'orchestration.review.material')],
        }),
        input.scope,
      );
    }

    let reviewAssignments: readonly ReviewAssignment[];
    try {
      reviewAssignments = createReviewAssignments({
        workerAssignment: input.assignment,
        workerResult: result,
        ...(input.reviewKinds ? { reviewKinds: input.reviewKinds } : {}),
        subjectRefs: input.assignment.targetRefs,
      });
    } catch (error) {
      return this.blockedResult(
        record,
        issueFromUnknown(error, {
          code: 'review-assignment-invalid',
          ownerId: this.ownerId,
          scope: input.scope,
          conditionRef: 'orchestration.review.assignment',
          evidenceRefs: result.evidenceRefs.length > 0
            ? result.evidenceRefs
            : [evidence(input.scope, 'orchestration.review.assignment')],
        }),
        input.scope,
      );
    }

    const reviewResults: ReviewResult[] = [];
    const reviewCommitRefs: JournalCommitRef[] = [];
    const milestoneBinding = input.milestoneReview;
    for (const reviewAssignment of reviewAssignments) {
      const reviewInvocationId = `invocation:review:${reviewAssignment.assignmentId}:${reviewAssignment.attempt}`;
      const reviewerAgentId = milestoneBinding?.reviewerAgentId ?? reviewAssignment.workerAgentId;
      if (this.childCallPort) {
        try {
          // Persist the pre-call checkpoint and invocation association before the
          // real review port call. The invocation records the real review
          // assignment, never the parent WorkAssignment.
          await this.childCallPort.prepare({
            kind: 'review',
            invocationId: reviewInvocationId,
            assignment: reviewAssignment,
            agentId: reviewerAgentId,
            attempt: reviewAssignment.attempt,
            executionEpoch: reviewAssignment.executionEpoch,
            scope: input.scope,
          });
        } catch (error) {
          return this.blockedResult(
            record,
            issueFromUnknown(error, {
              code: 'orchestration.child-checkpoint-failed',
              ownerId: this.ownerId,
              scope: input.scope,
              conditionRef: 'orchestration.child.checkpoint',
            }),
            input.scope,
            reviewCommitRefs,
          );
        }
      }
      let reviewResult: ReviewResult;
      if (milestoneBinding) {
        const durable = await this.runDurableMilestoneReview(
          input,
          milestoneBinding,
          reviewAssignment,
          input.assignment,
          result,
          reviewMaterial,
        );
        // A failed durable step must still return the receipts already committed
        // by the earlier reviews in this loop.
        if (!durable.ok) return this.blockedResult(record, durable.issue, input.scope, reviewCommitRefs);
        reviewResult = durable.delivery.result;
        reviewCommitRefs.push(durable.commitRef);
      } else {
        try {
          reviewResult = await reviewAgent.review({
            reviewAssignment,
            workerAssignment: input.assignment,
            workerResult: result,
            reviewMaterial,
            scope: input.scope,
          });
        } catch (error) {
          return this.blockedResult(
            record,
            issueFromUnknown(error, {
              code: 'review-failed',
              ownerId: this.ownerId,
              scope: input.scope,
              conditionRef: `orchestration.review.${reviewAssignment.reviewKind}`,
            }),
            input.scope,
          );
        }
        try {
          assertReviewResultMatchesAssignment(reviewAssignment, reviewResult);
        } catch (error) {
          return this.blockedResult(
            record,
            issueFromUnknown(error, {
              code: 'review-result-invalid',
              ownerId: this.ownerId,
              scope: input.scope,
              conditionRef: 'orchestration.review.result',
              evidenceRefs: reviewResult.evidenceRefs,
            }),
            input.scope,
          );
        }
      }
      if (this.childCallPort) {
        try {
          await this.childCallPort.recordReturn({
            kind: 'review',
            invocationId: reviewInvocationId,
            assignment: reviewAssignment,
            agentId: reviewerAgentId,
            attempt: reviewAssignment.attempt,
            executionEpoch: reviewAssignment.executionEpoch,
            scope: input.scope,
            result: reviewResult,
          });
        } catch (error) {
          return this.blockedResult(
            record,
            issueFromUnknown(error, {
              code: 'review-return-failed',
              ownerId: this.ownerId,
              scope: input.scope,
              conditionRef: 'orchestration.review.return',
              evidenceRefs: reviewResult.evidenceRefs,
            }),
            input.scope,
            reviewCommitRefs,
          );
        }
        try {
          await this.childCallPort.recordAdoption({
            kind: 'review',
            invocationId: reviewInvocationId,
            assignment: reviewAssignment,
            result: reviewResult,
            scope: input.scope,
          });
        } catch (error) {
          return this.blockedResult(
            record,
            issueFromUnknown(error, {
              code: 'review-adoption-failed',
              ownerId: this.ownerId,
              scope: input.scope,
              conditionRef: 'orchestration.review.adoption',
              evidenceRefs: reviewResult.evidenceRefs,
            }),
            input.scope,
            reviewCommitRefs,
          );
        }
        try {
          await this.childCallPort.recordReviewCheckpoint({
            kind: 'review',
            invocationId: reviewInvocationId,
            assignment: reviewAssignment,
            result: reviewResult,
            scope: input.scope,
          });
        } catch (error) {
          return this.blockedResult(
            record,
            issueFromUnknown(error, {
              code: 'review-checkpoint-failed',
              ownerId: this.ownerId,
              scope: input.scope,
              conditionRef: 'orchestration.review.checkpoint',
              evidenceRefs: reviewResult.evidenceRefs,
            }),
            input.scope,
            reviewCommitRefs,
          );
        }
      }
      let recorded: AssignmentRecord;
      try {
        recorded = this.graph.recordReviewResult(input.assignment, reviewResult);
      } catch (error) {
        return this.blockedResult(
          record,
          issueFromUnknown(error, {
            code: 'review-result-conflict',
            ownerId: this.ownerId,
            scope: input.scope,
            conditionRef: 'orchestration.review.result',
            evidenceRefs: reviewResult.evidenceRefs,
          }),
          input.scope,
          reviewCommitRefs,
        );
      }
      const persistedReviewResult = recorded.reviewResults.find(
        (candidate) => candidate.resultId === reviewResult.resultId,
      );
      if (!persistedReviewResult) {
        return this.blockedResult(
          record,
          issue(
            'review-result-not-recorded',
            this.ownerId,
            'review result was not persisted in the assignment graph',
            { kind: 'recover', ref: 'orchestration.review.result' },
            reviewResult.evidenceRefs,
          ),
          input.scope,
          reviewCommitRefs,
        );
      }
      reviewResults.push(persistedReviewResult);
      const feedbackIssue = await this.publish({
        kind: 'review-feedback',
        assignment: input.assignment,
        reviewAssignment,
        reviewResult,
        ownerId: this.ownerId,
        scope: input.scope,
        evidenceRefs: reviewResult.evidenceRefs,
      });
      if (feedbackIssue) return this.blockedResult(record, feedbackIssue, input.scope, reviewCommitRefs);
    }

    let gate: ReviewDecision;
    try {
      gate = decideReviewGate({
        workerAssignment: input.assignment,
        workerResult: result,
        reviewAssignments,
        reviewResults,
        orchestrationManagerId: this.ownerId,
      });
    } catch (error) {
      return this.blockedResult(
        record,
        issueFromUnknown(error, {
          code: 'review-gate-invalid',
          ownerId: this.ownerId,
          scope: input.scope,
          conditionRef: 'orchestration.review.gate',
          evidenceRefs: result.evidenceRefs.length > 0
            ? result.evidenceRefs
            : [evidence(input.scope, 'orchestration.review.gate')],
        }),
        input.scope,
      );
    }

    if (gate.status === 'remediation') {
      const remediation = input.assignment.attempt < this.maxAttempts
        ? retryAssignment(input.assignment, {
            reason: 'review remediation',
            requiredCapabilities: gate.remediation?.requiredCapabilities,
          })
        : undefined;
      const updated = remediation
        ? this.graph.markRetryable(input.assignment, 'review requires remediation', gate.evidenceRefs)
        : this.graph.markEscalated(
            input.assignment,
            'review remediation budget is exhausted',
            reviewNextAction(gate),
            gate.evidenceRefs,
          );
      const feedbackIssue = await this.publishFailureFeedback(
        input,
        updated,
        remediation ? 'retry' : 'attention',
        remediation?.attempt,
      );
      if (feedbackIssue) return this.blockedResult(updated, feedbackIssue, input.scope, reviewCommitRefs);
      return {
        status: updated.status,
        assignment: updated,
        issue: issue(
          remediation ? 'review-remediation' : 'review-escalated',
          this.ownerId,
          updated.reason,
          updated.nextAction,
          updated.evidenceRefs,
        ),
        ...(remediation ? { remediation } : {}),
        reviewResults,
        ...(reviewCommitRefs.length > 0 ? { reviewCommitRefs } : {}),
      };
    }
    if (gate.status !== 'succeeded' && !reviewWaitingForMerge(gate, input.assignment)) {
      const blocked = this.graph.markBlocked(
        input.assignment,
        `review gate is ${gate.status}`,
        reviewNextAction(gate),
        gate.evidenceRefs,
      );
      return this.blockedResult(
        blocked,
        issue(
          `review-${gate.status}`,
          this.ownerId,
          blocked.reason,
          blocked.nextAction,
          blocked.evidenceRefs,
        ),
        input.scope,
        reviewCommitRefs,
      );
    }
    if (input.assignment.mergeGate !== 'required') {
      const completed = this.graph.markSucceeded(input.assignment, gate.evidenceRefs);
      return {
        status: 'succeeded',
        assignment: completed,
        reviewResults,
        ...(reviewCommitRefs.length > 0 ? { reviewCommitRefs } : {}),
      };
    }
    if (!allReviewsPassed(reviewResults)) {
      return this.blockedResult(
        record,
        issue(
          'review-not-passed',
          this.ownerId,
          'merge gate cannot run before every review passes',
          { kind: 'recover', ref: 'orchestration.review.gate' },
          reviewResults.flatMap((review) => review.evidenceRefs),
        ),
        input.scope,
        reviewCommitRefs,
      );
    }
    if (!this.mergeCoordinator) {
      return this.blockedResult(
        record,
        issue(
          'merge-coordinator-unavailable',
          this.ownerId,
          'merge coordinator capability port is not bound',
          { kind: 'recover', ref: 'orchestration.merge.bind' },
          [evidence(input.scope, 'orchestration.merge.unavailable')],
          'orchestration.merge.unavailable',
        ),
        input.scope,
        reviewCommitRefs,
      );
    }

    let mergeOutcome: MergeOutcome;
    try {
      mergeOutcome = await this.mergeCoordinator.merge({
        workerAssignment: input.assignment,
        workerResult: result,
        reviewAssignments,
        reviewResults,
        ownerId: this.ownerId,
        scope: input.scope,
      });
      for (const evidenceRef of mergeOutcome.evidenceRefs) assertEvidenceRef(evidenceRef);
    } catch (error) {
      return this.blockedResult(
        record,
        issueFromUnknown(error, {
          code: 'merge-failed',
          ownerId: this.ownerId,
          scope: input.scope,
          conditionRef: 'orchestration.merge',
        }),
        input.scope,
        reviewCommitRefs,
      );
    }
    const mergeFeedbackIssue = await this.publish({
      kind: 'merge-outcome',
      assignment: input.assignment,
      outcome: mergeOutcome,
      ownerId: this.ownerId,
      scope: input.scope,
      evidenceRefs: mergeOutcome.evidenceRefs,
    });
    if (mergeFeedbackIssue) return this.blockedResult(record, mergeFeedbackIssue, input.scope, reviewCommitRefs);

    if (mergeOutcome.status !== 'merged') {
      const mergeEvidenceRefs = mergeOutcome.evidenceRefs.length > 0
        ? mergeOutcome.evidenceRefs
        : [evidence(input.scope, 'orchestration.merge')];
      const blocked = this.graph.markBlocked(
        input.assignment,
        mergeOutcome.reason ?? `merge is ${mergeOutcome.status}`,
        mergeOutcome.nextAction ?? { kind: 'recover', ref: 'orchestration.merge' },
        mergeEvidenceRefs,
      );
      return {
        status: 'blocked',
        assignment: blocked,
        issue: issue(
          `merge-${mergeOutcome.status}`,
          this.ownerId,
          blocked.reason,
          blocked.nextAction,
          mergeEvidenceRefs,
        ),
        reviewResults,
        mergeOutcome,
        ...(reviewCommitRefs.length > 0 ? { reviewCommitRefs } : {}),
      };
    }

    const finalGate = decideReviewGate({
      workerAssignment: input.assignment,
      workerResult: result,
      reviewAssignments,
      reviewResults,
      mergeEvidenceRefs: mergeOutcome.evidenceRefs,
      orchestrationManagerId: this.ownerId,
    });
    if (finalGate.status !== 'succeeded') {
      return this.blockedResult(
        record,
        issue(
          `merge-gate-${finalGate.status}`,
          this.ownerId,
          `merge gate did not succeed: ${finalGate.status}`,
          reviewNextAction(finalGate),
          finalGate.evidenceRefs,
        ),
        input.scope,
        reviewCommitRefs,
      );
    }
    return {
      status: 'merged',
      assignment: this.graph.markMerged(input.assignment, finalGate.evidenceRefs),
      reviewResults,
      mergeOutcome,
      ...(reviewCommitRefs.length > 0 ? { reviewCommitRefs } : {}),
    };
  }

  private async publishFailureFeedback(
    input: DispatchInput,
    record: AssignmentRecord,
    kind: 'retry' | 'attention',
    nextAttempt?: number,
  ): Promise<OrchestrationIssue | undefined> {
    if (kind === 'retry') {
      return this.publish({
        kind: 'retry',
        assignment: input.assignment,
        nextAttempt: nextAttempt ?? input.assignment.attempt + 1,
        ownerId: this.ownerId,
        reason: record.reason,
        scope: input.scope,
        evidenceRefs: record.evidenceRefs.length > 0
          ? record.evidenceRefs
          : [evidence(input.scope, 'orchestration.retry')],
      });
    }
    const attentionId = `orchestration-${safeId(record.assignment.assignmentId)}`;
    return this.publish({
      kind: 'attention',
      assignment: input.assignment,
      attentionId,
      ownerId: record.ownerId,
      reason: record.reason,
      nextAction: record.nextAction,
      scope: input.scope,
      evidenceRefs: record.evidenceRefs.length > 0
        ? record.evidenceRefs
        : [evidence(input.scope, 'orchestration.attention')],
    });
  }

  private async publish(
    event: Parameters<OrchestrationFeedbackPort['publish']>[0],
  ): Promise<OrchestrationIssue | undefined> {
    if (!this.feedback) return undefined;
    const evidenceRefs = scopedEvidenceRefs(event.scope, event.evidenceRefs);
    try {
      await this.feedback.publish({ ...event, evidenceRefs });
      return undefined;
    } catch (error) {
      return issueFromUnknown(error, {
        code: 'feedback-failed',
        ownerId: this.ownerId,
        scope: event.scope,
        conditionRef: 'orchestration.feedback',
        evidenceRefs,
      });
    }
  }

  private blockedResult(
    record: AssignmentRecord,
    orchestrationIssue: OrchestrationIssue,
    _scope: ScopeRef,
    reviewCommitRefs: readonly JournalCommitRef[] = [],
  ): OrchestrationDispatchResult {
    const current = this.graph.get(record.assignment) ?? record;
    const terminal = current.status === 'escalated'
      ? this.graph.markEscalated(
          current.assignment,
          orchestrationIssue.reason,
          orchestrationIssue.nextAction,
          orchestrationIssue.evidenceRefs,
        )
      : this.graph.markBlocked(
          current.assignment,
          orchestrationIssue.reason,
          orchestrationIssue.nextAction,
          orchestrationIssue.evidenceRefs,
        );
    return {
      status: terminal.status,
      assignment: terminal,
      issue: orchestrationIssue,
      reviewResults: terminal.reviewResults,
      ...(reviewCommitRefs.length > 0 ? { reviewCommitRefs } : {}),
    };
  }

  private rejectedResult(
    input: DispatchInput,
    rejection: Extract<AssignmentResultAcceptance, { readonly accepted: false }>,
  ): OrchestrationDispatchResult {
    const record = this.graph.get(input.assignment);
    const blocked = record
      ? this.graph.markBlocked(
          input.assignment,
          rejection.reason,
          rejection.nextAction,
          rejection.evidenceRefs,
        )
      : this.graph.createAssignment(input.stageNodeId, input.assignment);
    return {
      status: 'blocked',
      assignment: blocked,
      issue: issue(
        rejection.code,
        rejection.ownerId,
        rejection.reason,
        rejection.nextAction,
        rejection.evidenceRefs,
      ),
      reviewResults: blocked.reviewResults,
    };
  }
}
