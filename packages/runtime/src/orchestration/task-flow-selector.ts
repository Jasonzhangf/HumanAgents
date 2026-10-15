import {
  id,
  type Checkpoint,
  type CycleId,
  type EvidenceRef,
  type PublishedTaskPlanRevision,
  type ScopeRef,
  type TaskFlowGuidance,
  type TaskIdentityRecord,
  type TaskIdentityScope,
  type WorkAssignment,
  type WorkResult,
} from '../../../contracts/src/index.js';
import { resolveTaskFlowGuidanceFromBinding } from '../../../core/src/index.js';
import type {
  AdvanceTurnResult,
  AlignTurnInput,
  CloseTurnInput,
  TurnAlignmentResult,
  TurnCloseResult,
} from '../agent-loop/runtime.js';
import type { CheckpointClosurePort, CheckpointJournalPort } from '../checkpoints/ports.js';
import { submitCheckpoint } from '../checkpoints/submission.js';
import { OrchestrationError } from './errors.js';
import type { OrchestrationManager } from './manager.js';
import { acceptanceCriteriaContent, digestOf } from './review-material.js';
import type { TaskIdentityConsumer } from './task-identity.js';
import type { TaskPlanRevisionConsumerPort } from './task-plan-revisions.js';
import type { AssignmentStatus } from './types.js';

const OWNER_ID = 'runtime.orchestration.task-flow-selector';

export type TaskFlowSelectorErrorCode =
  | 'missing-task-identity'
  | 'missing-task-plan-revision';

/**
 * Explicit failure for the selector's required inputs. It carries the owner, the
 * reason code and a recovery next action instead of silently defaulting a task flow
 * kind, a legacy binding or a missing publication.
 */
export class TaskFlowSelectorError extends OrchestrationError {
  readonly code: TaskFlowSelectorErrorCode;

  constructor(code: TaskFlowSelectorErrorCode, message: string, scope: ScopeRef) {
    super(message, {
      ownerId: OWNER_ID,
      reason: code,
      nextAction: { kind: 'recover', ref: `task-flow-selector.${code}` },
      evidenceRefs: [{
        evidenceId: id('evidence', `task-flow-selector-${code}`),
        kind: 'operation',
        source: OWNER_ID,
        locator: `task-flow-selector://${code}`,
        scope,
      }],
    });
    this.name = 'TaskFlowSelectorError';
    this.code = code;
  }
}

/**
 * The refined, bounded result of one accepted child call. It carries only the
 * summary and the references the next selection may inspect. Child transcripts and
 * produced artifact bodies are deliberately excluded.
 */
export interface TaskFlowRefinedResult {
  readonly role: string;
  readonly assignmentId: string;
  readonly attempt: number;
  readonly status: AssignmentStatus;
  readonly summary: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * Distinct typed inputs for one selection. Guidance, the exact published revision
 * and the accepted refined results are supplied separately so the selector never
 * turns guidance display groups, node kinds or array order into a fixed role chain.
 */
export interface TaskFlowSelectionContext {
  readonly identity: TaskIdentityRecord;
  readonly guidance: TaskFlowGuidance | undefined;
  readonly revision: PublishedTaskPlanRevision;
  readonly refinedResults: readonly TaskFlowRefinedResult[];
  readonly callOrdinal: number;
}

/** The bounded work one child call performs. The consumer assigns its own identity. */
export interface TaskFlowChildCall {
  readonly role: string;
  readonly objective: string;
  readonly targetRefs: readonly string[];
  readonly expectedOutputRefs: readonly string[];
  readonly expectedArtifactDigests?: readonly string[];
  readonly successCriteria: readonly string[];
  readonly failureCriteria: readonly string[];
  readonly incompleteCriteria: readonly string[];
  readonly requiredCapabilities: readonly string[];
}

/**
 * One typed decision. None of these carry a naked task-success or task-failure
 * authorization: terminal decisions stay with the T2 parent-turn admission gate.
 */
export type TaskFlowSelection =
  | { readonly kind: 'child-call'; readonly call: TaskFlowChildCall }
  | { readonly kind: 'reason'; readonly reason: string }
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'close-parent'; readonly close: CloseTurnInput }
  | { readonly kind: 'align-parent'; readonly align: AlignTurnInput };

/** The orchestrator's selection port. It decides the next bounded action per call. */
export interface TaskFlowSelectionPort {
  select(context: TaskFlowSelectionContext): Promise<TaskFlowSelection>;
}

/**
 * The existing T2 parent-turn controller. The selector delegates every parent
 * close, Planner alignment and turn admission to these methods unchanged.
 */
export interface TaskFlowTurnPort {
  closeTurn(input: CloseTurnInput): Promise<TurnCloseResult>;
  alignTurn(input: AlignTurnInput): Promise<TurnAlignmentResult>;
  advanceTurn(): AdvanceTurnResult;
}

/**
 * The existing checkpoint durability surface for one child call. The consumer
 * builds the typed checkpoint from the accepted result and the independent call
 * scope, then submits it through the shared `submitCheckpoint` owner.
 */
export interface TaskFlowCallCheckpointAssembly {
  readonly ownerId: string;
  readonly journal: CheckpointJournalPort;
  readonly closurePort: CheckpointClosurePort;
  readonly directiveRevision: number;
  readonly callScope: (input: {
    readonly identity: TaskIdentityRecord;
    readonly ordinal: number;
  }) => ScopeRef & { readonly cycleId: CycleId };
}

export interface TaskFlowSelectorDeps {
  readonly identity: TaskIdentityConsumer;
  readonly revisions: TaskPlanRevisionConsumerPort;
  readonly manager: OrchestrationManager;
  readonly selection: TaskFlowSelectionPort;
  readonly turn: TaskFlowTurnPort;
  readonly checkpoints: TaskFlowCallCheckpointAssembly;
}

export interface TaskFlowStepRequest {
  readonly scope: TaskIdentityScope;
  readonly revisionId: string;
  readonly executionEpoch: number;
}

export interface TaskFlowCallFailure {
  readonly callOrdinal: number;
  readonly assignmentId: string;
  readonly failureRef: string;
  readonly refined: TaskFlowRefinedResult;
}

export type TaskFlowStepResult =
  | {
    readonly state: 'dispatched';
    readonly callOrdinal: number;
    readonly refined: TaskFlowRefinedResult;
    readonly checkpointId: string;
  }
  | {
    readonly state: 'checkpoint-failed';
    readonly callOrdinal: number;
    readonly refined: TaskFlowRefinedResult;
    readonly failureRef: string;
  }
  | { readonly state: 'blocked'; readonly reason: string; readonly failure?: TaskFlowCallFailure }
  | { readonly state: 'reasoning'; readonly reason: string }
  | { readonly state: 'wait'; readonly reason: string }
  | { readonly state: 'closed'; readonly close: TurnCloseResult; readonly advance: AdvanceTurnResult }
  | { readonly state: 'aligned'; readonly alignment: TurnAlignmentResult; readonly advance: AdvanceTurnResult };

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return cleaned || 'call';
}

/**
 * Public Runtime consumer for dynamic task-flow action selection.
 *
 * It is bounded to one action per `step` call. Repeated calls re-enter the same
 * consumer: it accumulates refined results and re-asks the selection port, but it
 * adds no persistent loop, revision store, checkpoint store or turn controller.
 */
export class TaskFlowSelectorConsumer {
  private readonly identity: TaskIdentityConsumer;
  private readonly revisions: TaskPlanRevisionConsumerPort;
  private readonly manager: OrchestrationManager;
  private readonly selection: TaskFlowSelectionPort;
  private readonly turn: TaskFlowTurnPort;
  private readonly checkpoints: TaskFlowCallCheckpointAssembly;
  private readonly refinedResults: TaskFlowRefinedResult[] = [];
  private pendingFailure: TaskFlowCallFailure | undefined;

  constructor(deps: TaskFlowSelectorDeps) {
    this.identity = deps.identity;
    this.revisions = deps.revisions;
    this.manager = deps.manager;
    this.selection = deps.selection;
    this.turn = deps.turn;
    this.checkpoints = deps.checkpoints;
  }

  /**
   * Read authoritative identity and the explicitly requested committed revision,
   * ask the selection port for the next bounded action, and perform only that one
   * action. A next selection can proceed only after the previous call checkpoint
   * was acknowledged.
   */
  async step(request: TaskFlowStepRequest): Promise<TaskFlowStepResult> {
    if (this.pendingFailure) {
      return {
        state: 'blocked',
        reason: 'the previous child call checkpoint is not acknowledged',
        failure: this.pendingFailure,
      };
    }

    const identity = await this.identity.read(request.scope);
    if (!identity) {
      throw new TaskFlowSelectorError(
        'missing-task-identity',
        `no authoritative task identity exists for ${request.scope.organId.value}/${request.scope.taskId.value}`,
        request.scope,
      );
    }
    const revision = await this.revisions.get(request.scope, request.revisionId);
    if (!revision) {
      throw new TaskFlowSelectorError(
        'missing-task-plan-revision',
        `published plan revision ${request.revisionId} does not exist for task ${request.scope.taskId.value}`,
        request.scope,
      );
    }

    const guidance = resolveTaskFlowGuidanceFromBinding(identity.taskFlow);
    const selection = await this.selection.select({
      identity,
      guidance,
      revision,
      refinedResults: [...this.refinedResults],
      callOrdinal: this.refinedResults.length + 1,
    });

    switch (selection.kind) {
      case 'child-call':
        return this.runChildCall(request, identity, selection.call);
      case 'reason':
        return { state: 'reasoning', reason: selection.reason };
      case 'wait':
        return { state: 'wait', reason: selection.reason };
      case 'close-parent': {
        const close = await this.turn.closeTurn(selection.close);
        return { state: 'closed', close, advance: this.turn.advanceTurn() };
      }
      case 'align-parent': {
        const alignment = await this.turn.alignTurn(selection.align);
        return { state: 'aligned', alignment, advance: this.turn.advanceTurn() };
      }
    }
  }

  private async runChildCall(
    request: TaskFlowStepRequest,
    identity: TaskIdentityRecord,
    call: TaskFlowChildCall,
  ): Promise<TaskFlowStepResult> {
    const advance = this.turn.advanceTurn();
    if (advance.state !== 'open') {
      return {
        state: 'blocked',
        reason: `parent turn is ${advance.state}; a new-turn action cannot start`,
      };
    }

    const ordinal = this.refinedResults.length + 1;
    const scope = this.checkpoints.callScope({ identity, ordinal });
    const stageNodeId = `call-stage-${ordinal}`;
    const assignmentId = `${sanitize(call.role)}-call-${ordinal}`;
    const assignment: WorkAssignment = {
      assignmentId,
      taskId: identity.scope.taskId,
      pipelineNodeId: stageNodeId,
      attempt: 1,
      executionEpoch: request.executionEpoch,
      inputRevision: identity.source.inputRevision,
      objective: call.objective,
      targetRefs: [...call.targetRefs],
      expectedOutputRefs: [...call.expectedOutputRefs],
      ...(call.expectedArtifactDigests ? { expectedArtifactDigests: [...call.expectedArtifactDigests] } : {}),
      acceptanceCriteriaDigest: digestOf(acceptanceCriteriaContent(call)),
      successCriteria: [...call.successCriteria],
      failureCriteria: [...call.failureCriteria],
      incompleteCriteria: [...call.incompleteCriteria],
      requiredCapabilities: [...call.requiredCapabilities],
      mergeGate: 'not-required',
    };

    this.manager.planStage({ nodeId: stageNodeId, taskId: identity.scope.taskId });
    const dispatched = await this.manager.dispatch({
      stageNodeId,
      assignment,
      agentId: `call-${ordinal}`,
      scope,
    });
    const record = dispatched.assignment;
    const result = record.result;
    if (record.status !== 'succeeded' || !result || result.status !== 'succeeded') {
      return {
        state: 'blocked',
        reason: `bounded call ${assignmentId} did not succeed: ${dispatched.status}`,
      };
    }

    const refined: TaskFlowRefinedResult = {
      role: call.role,
      assignmentId: record.assignment.assignmentId,
      attempt: record.assignment.attempt,
      status: record.status,
      summary: result.summary,
      outputRefs: [...result.outputRefs],
      evidenceRefs: [...result.evidenceRefs],
    };
    const failureRef = `task-flow-selector.call-checkpoint.${assignmentId}`;

    try {
      const submitted = await submitCheckpoint({
        source: 'harness-control',
        ownerId: this.checkpoints.ownerId,
        checkpoint: this.buildCallCheckpoint(ordinal, scope, result, refined),
        previous: null,
        journal: this.checkpoints.journal,
        closurePort: this.checkpoints.closurePort,
      });
      this.refinedResults.push(refined);
      return { state: 'dispatched', callOrdinal: ordinal, refined, checkpointId: submitted.checkpoint.id.value };
    } catch {
      // Keep the accepted assignment/result and the original turn for recovery. Do not
      // redispatch completed work merely because the call checkpoint was not acknowledged.
      const failure: TaskFlowCallFailure = { callOrdinal: ordinal, assignmentId, failureRef, refined };
      this.pendingFailure = failure;
      return { state: 'checkpoint-failed', callOrdinal: ordinal, refined, failureRef };
    }
  }

  private buildCallCheckpoint(
    ordinal: number,
    scope: ScopeRef & { readonly cycleId: CycleId },
    result: WorkResult,
    refined: TaskFlowRefinedResult,
  ): Checkpoint {
    const recoveryStateRef: EvidenceRef = {
      evidenceId: id('evidence', `call-recovery-${ordinal}`),
      kind: 'execution',
      source: OWNER_ID,
      locator: `task-flow-selector://call/${ordinal}/recovery`,
      scope,
    };
    const evidenceRefs = result.evidenceRefs.length > 0 ? [...result.evidenceRefs] : [recoveryStateRef];
    return {
      id: id('checkpoint', `call-${ordinal}-1`),
      scope,
      cycleId: scope.cycleId,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: this.checkpoints.directiveRevision,
      executionEpoch: result.executionEpoch,
      outcome: 'succeeded',
      summary: `call ${ordinal} (${refined.role}): ${refined.summary}`,
      recoveryStateRef,
      evidenceRefs,
      next: { kind: 'continue', ref: `call.${ordinal}.checkpoint` },
    };
  }
}
