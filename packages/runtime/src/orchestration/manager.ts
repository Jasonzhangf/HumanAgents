import {
  assertEvidenceRef,
  id,
  type EvidenceRef,
  type NextAction,
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
import { type ReviewMaterial, resolveReviewMaterial } from './review-material.js';
import { AgentRuntimePoolManager } from './runtime-pool.js';
import type {
  AssignmentRecord,
  DispatchInput,
  ExecutionAgentPort,
  ExecutionDelivery,
  MergeCoordinatorPort,
  MergeOutcome,
  OrchestrationDispatchResult,
  OrchestrationFeedbackPort,
  OrchestrationIssue,
  ReviewAgentPort,
  RuntimePoolLease,
} from './types.js';

export interface OrchestrationManagerOptions {
  readonly ownerId: string;
  readonly runtimePool: AgentRuntimePoolManager;
  readonly executionAgent?: ExecutionAgentPort;
  readonly reviewAgent?: ReviewAgentPort;
  readonly mergeCoordinator?: MergeCoordinatorPort;
  readonly feedback?: OrchestrationFeedbackPort;
  readonly graph?: AssignmentGraph;
  readonly maxAttempts?: number;
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

function leaseBinding(lease: RuntimePoolLease) {
  return {
    runtimeId: lease.runtimeId,
    generation: lease.generation,
    leaseId: lease.leaseId,
    assignmentId: lease.assignmentId,
    executionEpoch: lease.executionEpoch,
  };
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

export class OrchestrationManager {
  readonly ownerId: string;
  readonly graph: AssignmentGraph;
  private readonly runtimePool: AgentRuntimePoolManager;
  private readonly executionAgent?: ExecutionAgentPort;
  private readonly reviewAgent?: ReviewAgentPort;
  private readonly mergeCoordinator?: MergeCoordinatorPort;
  private readonly feedback?: OrchestrationFeedbackPort;
  private readonly maxAttempts: number;
  private readonly inFlightDispatches = new Map<string, Promise<OrchestrationDispatchResult>>();

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
    this.mergeCoordinator = options.mergeCoordinator;
    this.feedback = options.feedback;
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

  async dispatch(input: DispatchInput): Promise<OrchestrationDispatchResult> {
    const planned = this.graph.createAssignment(input.stageNodeId, input.assignment);
    const key = assignmentKey(input.assignment);
    if (this.inFlightDispatches.has(key)) {
      return this.progressResult(planned);
    }
    if (planned.status === 'running' && planned.result) {
      return this.progressResult(planned);
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
      };
    }
    if (!this.executionAgent) {
      const unavailable = issue(
        'execution-agent-unavailable',
        this.ownerId,
        'execution agent capability port is not bound',
        { kind: 'recover', ref: 'orchestration.execution.bind' },
        [evidence(input.scope, 'orchestration.execution.unavailable')],
        'orchestration.execution.unavailable',
      );
      return this.blockedResult(planned, unavailable, input.scope);
    }

    const pending = this.dispatchWithLease(input, planned);
    this.inFlightDispatches.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlightDispatches.get(key) === pending) {
        this.inFlightDispatches.delete(key);
      }
    }
  }

  private async dispatchWithLease(
    input: DispatchInput,
    planned: AssignmentRecord,
  ): Promise<OrchestrationDispatchResult> {
    const acquired = await this.runtimePool.acquire({
      requiredCapabilities: input.assignment.requiredCapabilities,
      ownerId: this.ownerId,
      executionEpoch: input.assignment.executionEpoch,
      assignmentId: input.assignment.assignmentId,
      scope: input.scope,
    });
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
      result = await this.executeWithLease(input, lease);
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
  ): Promise<OrchestrationDispatchResult> {
    this.graph.assign(input.assignment, input.agentId, leaseBinding(lease));
    this.graph.start(input.assignment, input.agentId, leaseBinding(lease));
    let rawDelivery: WorkResult | ExecutionDelivery;
    try {
      rawDelivery = await this.executionAgent!.execute({
        assignment: input.assignment,
        agentId: input.agentId,
        executionEpoch: input.assignment.executionEpoch,
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
    const accepted = this.graph.acceptResult(input.assignment, {
      result: delivery.result,
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
      result: delivery.result,
      ownerId: this.ownerId,
      scope: input.scope,
      evidenceRefs: delivery.result.evidenceRefs,
    });
    if (resultIssue) return this.blockedResult(accepted.record, resultIssue, input.scope);

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

    if (delivery.result.nextAction === 'attention') {
      const escalated = this.graph.markEscalated(
        input.assignment,
        delivery.result.conditionRef ?? delivery.result.failureRef ?? 'work result requires attention',
        { kind: 'recover', ref: delivery.result.conditionRef ?? `attention.${input.assignment.assignmentId}` },
        delivery.result.evidenceRefs,
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

    const reviewRequired = delivery.result.nextAction === 'review' || input.assignment.mergeGate === 'required';
    if (!reviewRequired) {
      return {
        status: 'succeeded',
        assignment: this.graph.markSucceeded(input.assignment, accepted.record.evidenceRefs),
        reviewResults: accepted.record.reviewResults,
      };
    }
    return this.reviewAndMerge(input, accepted.record, delivery.result);
  }

  private async reviewAndMerge(
    input: DispatchInput,
    record: AssignmentRecord,
    result: WorkResult,
  ): Promise<OrchestrationDispatchResult> {
    if (!this.reviewAgent) {
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

    const subjectDigests = input.reviewSubjectDigests ?? result.producedArtifactDigests;
    if (subjectDigests.length !== input.assignment.targetRefs.length) {
      return this.blockedResult(
        record,
        issue(
          'review-subject-invalid',
          this.ownerId,
          'review subject digests must match assignment target refs',
          { kind: 'recover', ref: 'orchestration.review.subject' },
          [evidence(input.scope, 'orchestration.review.subject')],
          'orchestration.review.subject',
        ),
        input.scope,
      );
    }

    let reviewMaterial: ReviewMaterial;
    try {
      reviewMaterial = resolveReviewMaterial({
        workerAssignment: input.assignment,
        workerResult: result,
        subjects: input.reviewSubjects ?? [],
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
        subjectDigests,
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
    for (const reviewAssignment of reviewAssignments) {
      let reviewResult: ReviewResult;
      try {
        reviewResult = await this.reviewAgent.review({
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
      if (feedbackIssue) return this.blockedResult(record, feedbackIssue, input.scope);
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
      if (feedbackIssue) return this.blockedResult(updated, feedbackIssue, input.scope);
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
      );
    }
    if (input.assignment.mergeGate !== 'required') {
      const completed = this.graph.markSucceeded(input.assignment, gate.evidenceRefs);
      return {
        status: 'succeeded',
        assignment: completed,
        reviewResults,
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
    if (mergeFeedbackIssue) return this.blockedResult(record, mergeFeedbackIssue, input.scope);

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
      );
    }
    return {
      status: 'merged',
      assignment: this.graph.markMerged(input.assignment, finalGate.evidenceRefs),
      reviewResults,
      mergeOutcome,
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
    try {
      await this.feedback.publish(event);
      return undefined;
    } catch (error) {
      return issueFromUnknown(error, {
        code: 'feedback-failed',
        ownerId: this.ownerId,
        scope: event.scope,
        conditionRef: 'orchestration.feedback',
        evidenceRefs: event.evidenceRefs,
      });
    }
  }

  private blockedResult(
    record: AssignmentRecord,
    orchestrationIssue: OrchestrationIssue,
    _scope: ScopeRef,
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
