import {
  canonicalJsonStringify,
  id,
  validateTaskIdentityRecord,
  validateTurnClosureReference,
  type AgentEvent,
  type BusinessPayload,
  type EvidenceRef,
  type PlannerAlignmentDecision,
  type ProviderSettlement,
  type Task,
  type TaskPlanRevisionReason,
  type TaskPlanSnapshot,
  type TurnClosureReference,
  type TurnSummarySection,
} from '../../../contracts/src/index.js';
import {
  createPublishedTaskPlanRevision,
  validatePublishedTaskPlanRevision,
  validateTaskPlanRevisionTransition,
} from '../../../core/src/task-plan-revision.js';
import { ProviderAgentDriver } from '../../../adapters/provider/src/index.js';
import type { AgentRole } from '../../../config/src/index.js';
import type { TaskFlowRefinedResult } from '../../../runtime/src/orchestration/task-flow-selector.js';
import type { TaskPlanRevisionPublishInput } from '../../../runtime/src/orchestration/task-plan-revisions.js';
import {
  closedTurnPlannerOutputContract,
  deriveClosedTurnPlannerDuty,
  type ClosedTurnPlannerPlanBasis,
  type PreparedClosedTurnPlannerCall,
} from '../../../runtime/src/orchestration/closed-turn-planner-call.js';
import { closeAgentProvider, type AgentProviderComposition } from '../agent-driver-composition.js';
import { AppLifecycleError } from '../errors.js';

export const INDEPENDENT_TURN_PLANNER_OWNER = 'humanagent.app.ui-runtime.turn-planner';

/**
 * The planning duty is served by the existing `orchestration` configured agent
 * role. This adapter adds no new role enum and never chooses an ambient default:
 * the actual configured selection owner (`prepareAgentProvider`) resolves the
 * Provider, protocol, binding and model for this role.
 */
const PLANNER_ROLE: AgentRole = 'orchestration';

const ALIGNMENT_DECISIONS: readonly PlannerAlignmentDecision[] = ['continue', 'complete', 'failed'];

/** Explicit failure for the Planner adapter. It never fabricates an aligned success. */
export class IndependentTurnPlannerError extends AppLifecycleError {
  constructor(code: string, message: string, nextAction: string, cause?: unknown) {
    super(code, message, nextAction, INDEPENDENT_TURN_PLANNER_OWNER, cause);
    this.name = 'IndependentTurnPlannerError';
  }
}

/**
 * C3 seam: the Runtime closed-turn Planner duty issues one typed
 * `PreparedClosedTurnPlannerCall` after real grant admission, pool lease and
 * durable preparation readback. The adapter consumes that exact projection and
 * cannot manufacture it: a missing or lookalike call must fail closed, so no
 * independent admission is auto-granted.
 */
export type PreparedPlannerCall = PreparedClosedTurnPlannerCall;

export type IndependentTurnPlannerInput = {
  readonly task: Task;
  readonly closure: TurnClosureReference;
  readonly refinedResults: readonly TaskFlowRefinedResult[];
  readonly preparedCall: PreparedClosedTurnPlannerCall;
} & ClosedTurnPlannerPlanBasis;

export interface IndependentTurnPlannerResult {
  readonly publication: TaskPlanRevisionPublishInput;
  readonly decision: PlannerAlignmentDecision;
}

/**
 * Composition port for one independent turn Planner call. It returns a
 * validated publication input and the alignment decision. It does not publish
 * the revision, align or close the turn, or complete the Task.
 */
export interface IndependentTurnPlannerPort {
  plan(input: IndependentTurnPlannerInput): Promise<IndependentTurnPlannerResult>;
}

export interface IndependentTurnPlannerDeps {
  /** The existing configured agent/provider selection owner. */
  readonly prepareAgentProvider: (selection: {
    readonly roleId: AgentRole;
    readonly configuredAgentId?: string;
  }) => Promise<AgentProviderComposition>;
  readonly now?: () => Date;
}

interface PlannerModelResponse {
  readonly decision: PlannerAlignmentDecision;
  readonly snapshot: TaskPlanSnapshot;
  readonly reasonText?: string;
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IndependentTurnPlannerError('planner.input.invalid', `${label} must be a non-empty string`, 'supply the exact committed Planner input');
  }
}

function sameScopedId(left: { readonly value: string } | undefined, right: { readonly value: string }): boolean {
  return left !== undefined && left.value === right.value;
}

function uniqueEvidence(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const seen = new Set<string>();
  const unique: EvidenceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.evidenceId.value)) continue;
    seen.add(ref.evidenceId.value);
    unique.push(ref);
  }
  return unique;
}

function plannerBasisRefs(input: IndependentTurnPlannerInput): readonly EvidenceRef[] {
  const { summary } = input.closure;
  return uniqueEvidence([
    ...summary.goal.evidenceRefs,
    ...summary.actions.evidenceRefs,
    ...summary.result.evidenceRefs,
    ...summary.expectedNextStep.evidenceRefs,
    ...input.refinedResults.flatMap((result) => result.evidenceRefs),
    ...(input.priorPlan === null ? taskIdentityEvidence(input) : []),
  ]);
}

function outputText(events: readonly AgentEvent[]): string {
  return events
    .filter((event) => event.kind === 'provider.output')
    .map((event) => event.summary ?? '')
    .join('');
}

function parseModelResponse(text: string): PlannerModelResponse {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new IndependentTurnPlannerError(
      'planner.response.missing',
      'the independent Planner model returned no structured publication',
      'resume the alignment stage with a Planner response that carries a decision and a whole-task snapshot',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (cause) {
    throw new IndependentTurnPlannerError(
      'planner.response.invalid',
      'the independent Planner model response is not valid JSON',
      'resume the alignment stage with a valid structured publication',
      cause,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IndependentTurnPlannerError(
      'planner.response.invalid',
      'the independent Planner model response is not a JSON object',
      'resume the alignment stage with a valid structured publication',
    );
  }
  const record = parsed as Record<string, unknown>;
  const decision = record.decision;
  if (typeof decision !== 'string' || !(ALIGNMENT_DECISIONS as readonly string[]).includes(decision)) {
    throw new IndependentTurnPlannerError(
      'planner.response.decision-missing',
      'the independent Planner model response carries no valid alignment decision',
      'resume the alignment stage; a missing decision must not fabricate an aligned success',
    );
  }
  if (typeof record.snapshot !== 'object' || record.snapshot === null || Array.isArray(record.snapshot)) {
    throw new IndependentTurnPlannerError(
      'planner.response.publication-missing',
      'the independent Planner model response carries no plan snapshot',
      'resume the alignment stage; a missing publication must not fabricate an aligned success',
    );
  }
  return {
    decision: decision as PlannerAlignmentDecision,
    snapshot: record.snapshot as TaskPlanSnapshot,
    ...(typeof record.reasonText === 'string' && record.reasonText.trim().length > 0 ? { reasonText: record.reasonText } : {}),
  };
}

function taskIdentityEvidence(input: IndependentTurnPlannerInput & { readonly priorPlan: null }): readonly EvidenceRef[] {
  return [{
    evidenceId: id('evidence', `task-plan-source-${input.task.id.value}`),
    kind: 'operation',
    source: 'humanagent.runtime.orchestration.task-identity',
    locator: input.identity.journalCommitRef,
    scope: input.identity.scope,
  }];
}

/** Model-readable evidence keeps its identity and locator; scope remains typed control input. */
function plannerEvidenceRef(ref: EvidenceRef) {
  return {
    evidenceId: ref.evidenceId,
    kind: ref.kind,
    source: ref.source,
    locator: ref.locator,
    ...(ref.digest === undefined ? {} : { digest: ref.digest }),
  };
}

function plannerSummarySection(section: TurnSummarySection) {
  return { text: section.text, evidenceRefs: section.evidenceRefs.map(plannerEvidenceRef) };
}

function plannerRequestPayload(input: IndependentTurnPlannerInput): BusinessPayload {
  const payload = {
    role: 'planner',
    task: {
      taskId: input.task.id,
      organId: input.task.organId,
      title: input.task.title,
      directive: input.task.directive,
      directiveRevision: input.task.directiveRevision,
      state: input.task.state,
      memoryScope: input.task.memoryScope,
    },
    closure: {
      turnId: input.closure.identity.turnId,
      checkpointId: input.closure.checkpointId,
      closureRef: input.closure.closureRef,
      summary: {
        goal: plannerSummarySection(input.closure.summary.goal),
        actions: plannerSummarySection(input.closure.summary.actions),
        result: plannerSummarySection(input.closure.summary.result),
        expectedNextStep: plannerSummarySection(input.closure.summary.expectedNextStep),
      },
      recoveryStateRef: plannerEvidenceRef(input.closure.recoveryStateRef),
      closedAt: input.closure.closedAt,
    },
    priorPlan: input.priorPlan === null ? null : {
      revisionId: input.priorPlan.revisionId,
      sequence: input.priorPlan.sequence,
      contentDigest: input.priorPlan.contentDigest,
      snapshot: input.priorPlan.snapshot,
    },
    ...(input.priorPlan === null ? {
      confirmedSource: { ...input.identity.source, evidenceRefs: taskIdentityEvidence(input).map(plannerEvidenceRef) },
    } : {}),
    refinedResults: input.refinedResults.map((result) => ({
      role: result.role,
      assignmentId: result.assignmentId,
      attempt: result.attempt,
      status: result.status,
      summary: result.summary,
      outputRefs: result.outputRefs,
      evidenceRefs: result.evidenceRefs.map(plannerEvidenceRef),
    })),
    // The closed-turn Planner output contract is owned by the Runtime duty
    // template, not re-declared here. The adapter serializes the exact template
    // the Contracts validator enforces.
    instruction: closedTurnPlannerOutputContract(),
  };
  return payload as unknown as BusinessPayload;
}

/**
 * Runs one real model call on the prepared independent execution. The request
 * context is built only from the exact committed Planner input; no parent
 * transcript, transient orientation or ambient model enters the request.
 */
async function invokePlannerModel(
  input: {
    readonly preparedCall: PreparedClosedTurnPlannerCall;
    readonly inputRefs: readonly string[];
    readonly payload: BusinessPayload;
  },
  composition: AgentProviderComposition,
): Promise<{ readonly text: string; readonly settlement: ProviderSettlement }> {
  const { execution } = input.preparedCall;
  const runtimeId = execution.runtimeId;
  const driver = new ProviderAgentDriver({
    port: composition.port,
    binding: composition.binding,
    runtimeId,
    taskId: execution.taskId,
    operationId: execution.operationId,
    executionEpoch: execution.executionEpoch,
    assignmentId: input.preparedCall.assignmentId,
    scope: input.preparedCall.scope,
    inputRefs: [...input.inputRefs],
    ownerId: INDEPENDENT_TURN_PLANNER_OWNER,
  });
  const events: AgentEvent[] = [];
  let started = false;
  try {
    await driver.start({
      runtimeId,
      taskId: execution.taskId,
      executionEpoch: execution.executionEpoch,
      assignmentId: input.preparedCall.assignmentId,
      ...(execution.organId === undefined ? {} : { organId: execution.organId }),
      ...(execution.cycleId === undefined ? {} : { cycleId: execution.cycleId }),
      operationId: execution.operationId,
    });
    started = true;
    await driver.submit({
      taskId: execution.taskId,
      executionEpoch: execution.executionEpoch,
      assignmentId: input.preparedCall.assignmentId,
      payload: input.payload,
    });
    for await (const event of driver.observe({ runtimeId })) {
      events.push(event);
      if (event.terminalState !== undefined) break;
    }
  } catch (error) {
    if (started) {
      try {
        await driver.settle({ runtimeId, executionEpoch: execution.executionEpoch });
      } catch (settleError) {
        throw new AggregateError([error, settleError], 'independent Planner call failed and its own settlement also failed');
      }
    }
    throw error;
  }
  await driver.settle({ runtimeId, executionEpoch: execution.executionEpoch });
  const settlement = driver.settlement();
  if (!settlement) {
    throw new IndependentTurnPlannerError(
      'planner.settlement.missing',
      'the independent Planner call exposed no Provider settlement',
      'resume the alignment stage; an unconfirmed settlement must not read as success',
    );
  }
  return { text: outputText(events), settlement };
}

function assertPreparedCallBound(input: IndependentTurnPlannerInput): void {
  const preparedCall = (input as { preparedCall?: PreparedClosedTurnPlannerCall }).preparedCall;
  if (preparedCall === undefined || preparedCall === null) {
    throw new IndependentTurnPlannerError(
      'planner.call.missing',
      'the independent Planner call requires a caller-admitted child call; no admission is auto-granted',
      'admit the Planner child call through the existing child/budget/lease admission owner',
    );
  }
  const { task, closure, priorPlan } = input;
  if (closure.identity.taskRef.value !== task.id.value) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'turn closure task does not match the Planner task', 'supply the exact committed closure for this task');
  }
  if (closure.identity.scopeRef.organId.value !== task.organId.value) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'turn closure organ does not match the Planner task', 'supply the exact committed closure for this task');
  }
  const planScope = priorPlan === null ? input.identity.scope : priorPlan.scope;
  if (planScope.taskId.value !== task.id.value || planScope.organId.value !== task.organId.value) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'prior plan revision belongs to a different task', 'supply the actual predecessor revision for this task');
  }
  assertPreparedExecutionBound(task, preparedCall);
  const expected = deriveClosedTurnPlannerDuty({
    ...input,
    allocation: { operationId: preparedCall.execution.operationId,
      cycleId: closure.identity.cycleRef, executionEpoch: preparedCall.execution.executionEpoch },
  }, preparedCall.checkpoint.commitRef);
  if (preparedCall.duty.dutyKey !== expected.dutyKey
    || preparedCall.duty.inputDigest !== expected.inputDigest
    || preparedCall.duty.closureRef !== closure.closureRef
    || preparedCall.duty.predecessorRevisionId !== (priorPlan === null ? null : priorPlan.revisionId)
    || preparedCall.duty.checkpointId.value !== closure.checkpointId.value
    || preparedCall.checkpoint.checkpoint.id.value !== closure.checkpointId.value
    || canonicalJsonStringify(preparedCall.duty.checkpointCommitRef) !== canonicalJsonStringify(preparedCall.checkpoint.commitRef)
    || (priorPlan === null && (preparedCall.duty.predecessorRevisionId !== null
      || canonicalJsonStringify(preparedCall.duty.identity) !== canonicalJsonStringify(input.identity)))) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'Planner input differs from its committed closed-turn preparation',
      'pass the exact retained closure, source and plan basis for this duty');
  }
}

function assertPreparedExecutionBound(task: Task, preparedCall: PreparedClosedTurnPlannerCall): void {
  if (!preparedCall) {
    throw new IndependentTurnPlannerError('planner.call.missing', 'the Planner requires its actual Runtime preparation', 'pass the admitted and committed Planner preparation');
  }
  if (!sameScopedId(preparedCall.scope.taskId, task.id) || preparedCall.scope.organId.value !== task.organId.value) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'prepared Planner call belongs to a different task scope', 'admit the Planner child call in the same task scope');
  }
  if (preparedCall.execution.taskId.value !== task.id.value) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'prepared Planner execution belongs to a different task', 'admit the Planner child call for this task');
  }
  nonEmpty(preparedCall.execution.runtimeId, 'prepared Planner execution runtimeId');
  nonEmpty(preparedCall.assignmentId, 'prepared Planner assignmentId');
  nonEmpty(preparedCall.invocationId, 'prepared Planner invocationId');
  nonEmpty(preparedCall.incarnation.agentInstanceId, 'prepared Planner incarnation agentInstanceId');
  if (!Number.isSafeInteger(preparedCall.incarnation.generation) || preparedCall.incarnation.generation < 1) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'prepared Planner incarnation generation is invalid', 'admit the Planner child call on a fresh pool incarnation');
  }
  if (preparedCall.incarnation.taskId.value !== task.id.value) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'prepared Planner incarnation belongs to a different task', 'admit the Planner child call for this task');
  }
  if (preparedCall.incarnation.roleId !== PLANNER_ROLE) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'prepared Planner incarnation is not the configured orchestration duty', 'admit the Planner child call on the configured orchestration role');
  }
  if (preparedCall.incarnation.assignmentId !== preparedCall.assignmentId) {
    throw new IndependentTurnPlannerError('planner.input.invalid', 'prepared Planner incarnation does not match its assignment', 'admit the Planner child call with its exact pool assignment');
  }
  // Independence is proven from the owner-issued fresh incarnation, not from a
  // slot id. The pool legitimately reuses one runtime slot at capacity one after
  // the parent handle is settled, so a reused slot is allowed while the parent
  // handle itself must never be reused. The Provider execution identity must be
  // the exact freshly leased incarnation, never an arbitrary or parent runtime.
  const { execution, incarnation, lease } = preparedCall;
  if (execution.runtimeId !== incarnation.runtimeId || execution.executionEpoch !== incarnation.executionEpoch) {
    throw new IndependentTurnPlannerError(
      'planner.call.not-independent',
      'the Provider execution identity is not the freshly leased Planner incarnation',
      'run the Planner on the exact pool-leased incarnation instead of the parent turn handle',
    );
  }
  if (lease.runtimeId !== incarnation.runtimeId
    || lease.executionEpoch !== incarnation.executionEpoch
    || lease.assignmentId !== preparedCall.assignmentId
    || lease.incarnation.runtimeId !== incarnation.runtimeId
    || lease.incarnation.generation !== incarnation.generation
    || lease.incarnation.agentInstanceId !== incarnation.agentInstanceId) {
    throw new IndependentTurnPlannerError(
      'planner.call.not-independent',
      'the prepared Planner lease does not match its fresh incarnation',
      'admit the Planner child call through the existing pool lease and pass its exact incarnation',
    );
  }
}

function assemblePublication(
  input: IndependentTurnPlannerInput,
  response: PlannerModelResponse,
  now: () => Date,
): TaskPlanRevisionPublishInput {
  const { priorPlan } = input;
  const sequence = priorPlan === null ? 1 : priorPlan.sequence + 1;
  const revisionId = `plan-revision:${input.task.id.value}:${sequence}`;
  const reason: TaskPlanRevisionReason = {
    kind: priorPlan === null ? 'initial' : 'adjustment',
    text: response.reasonText ?? 'independent turn planner alignment',
    basisRefs: plannerBasisRefs(input),
  };
  return {
    scope: priorPlan === null ? input.identity.scope : priorPlan.scope,
    revisionId,
    sequence,
    predecessor: priorPlan === null ? null : {
      revisionId: priorPlan.revisionId,
      sequence: priorPlan.sequence,
      contentDigest: priorPlan.contentDigest,
    },
    snapshot: response.snapshot,
    reason,
    source: priorPlan === null ? { ...input.identity.source, evidenceRefs: taskIdentityEvidence(input) } : priorPlan.source,
    historyCoverage: priorPlan === null ? 'complete-from-task-start' : priorPlan.historyCoverage,
    publishedAt: now().toISOString(),
    publishedBy: INDEPENDENT_TURN_PLANNER_OWNER,
  };
}

/**
 * Builds the independent turn Planner adapter. The selected Provider is closed
 * by this adapter on every path; a primary failure and its own cleanup failure
 * are both preserved.
 */
export function createIndependentTurnPlanner(deps: IndependentTurnPlannerDeps): IndependentTurnPlannerPort {
  const now = deps.now ?? (() => new Date());
  async function invoke<R>(
    input: Parameters<typeof invokePlannerModel>[0],
    accept: (text: string) => R,
  ): Promise<R> {
    const composition = await deps.prepareAgentProvider({
      roleId: PLANNER_ROLE,
      ...(input.preparedCall.configuredAgentId === undefined ? {} : { configuredAgentId: input.preparedCall.configuredAgentId }),
    });
    let result: R;
    try {
      const { text, settlement } = await invokePlannerModel(input, composition);
      if (settlement.state !== 'succeeded') {
        throw new IndependentTurnPlannerError(
          'planner.settlement.failed',
          `independent Planner Provider settled ${settlement.state}`,
          'resume planning with its recovery owner; a non-succeeded settlement must not fabricate success',
        );
      }
      result = accept(text);
    } catch (primary) {
      try {
        await closeAgentProvider(composition);
      } catch (cleanupError) {
        throw new AggregateError([primary, cleanupError], 'independent Planner call failed and owned Provider close also failed');
      }
      throw primary;
    }
    await closeAgentProvider(composition);
    return result;
  }
  return {
    async plan(input: IndependentTurnPlannerInput): Promise<IndependentTurnPlannerResult> {
      input = structuredClone(input);
      validateTurnClosureReference(input.closure);
      if (input.priorPlan === undefined) {
        throw new IndependentTurnPlannerError('planner.input.invalid', 'priorPlan must be the exact revision or explicit null', 'supply the typed closed-turn plan basis');
      }
      if (input.priorPlan === null) validateTaskIdentityRecord(input.identity);
      else validatePublishedTaskPlanRevision(input.priorPlan);
      assertPreparedCallBound(input);

      return invoke({
        preparedCall: input.preparedCall,
        payload: plannerRequestPayload(input),
        inputRefs: [input.closure.closureRef, input.priorPlan === null ? input.identity.journalCommitRef : input.priorPlan.revisionId,
          ...input.refinedResults.map((result) => result.assignmentId)],
      }, (text) => {
        const response = parseModelResponse(text);
        const publication = assemblePublication(input, response, now);
        const candidate = createPublishedTaskPlanRevision({
          ...publication,
          journalCommitRef: `planner-candidate:${publication.revisionId}`,
        });
        validateTaskPlanRevisionTransition(input.priorPlan, candidate);
        return { publication, decision: response.decision };
      });
    },
  };
}
