import {
  ContractError,
  id,
  validateWorkAssignment,
  validateWorkResult,
  validateTaskIdentityScope,
  type EvidenceRef,
  type JournalCommitRef,
  type NextAction,
  type TaskId,
  type WorkAssignment,
  type WorkResult,
} from '../../../contracts/src/index.js';
import type { ReviewResult } from '../review/index.js';
import { AssignmentGraphError } from './errors.js';
import type {
  AssignmentGraphSnapshot,
  AssignmentGraphAction,
  AssignmentGraphChange,
  AssignmentGraphFact,
  AssignmentGraphStream,
  AssignmentKey,
  AssignmentRecord,
  AssignmentRuntimeBinding,
  AssignmentStageNode,
  AssignmentStatus,
  CommittedAssignmentGraphFact,
  WorkCriterionEvaluation,
} from './types.js';

type AssignmentGraphTransitionAction = AssignmentGraphAction;

export interface CreateStageInput {
  readonly nodeId: string;
  readonly taskId: TaskId;
  readonly parentNodeId?: string | null;
}

export interface AssignmentResultInput {
  readonly result: WorkResult;
  readonly expectedAgentId: string;
  readonly criteria?: WorkCriterionEvaluation;
  readonly maxAttempts?: number;
  readonly ownerId?: string;
  readonly runtimeBinding?: AssignmentRuntimeBinding;
}

export type AssignmentResultRejectionCode =
  | 'unknown-assignment'
  | 'stale-epoch'
  | 'stale-lease'
  | 'wrong-agent'
  | 'contract-invalid'
  | 'duplicate-conflict'
  | 'criteria-mismatch';

export type AssignmentResultAcceptance =
  | {
      readonly accepted: true;
      readonly record: AssignmentRecord;
      readonly duplicate: boolean;
    }
  | {
      readonly accepted: false;
      readonly code: AssignmentResultRejectionCode;
      readonly ownerId: string;
      readonly reason: string;
      readonly nextAction: NextAction;
      readonly evidenceRefs: readonly EvidenceRef[];
    };

export interface AssignmentGraphOptions {
  readonly ownerId: string;
  readonly stream?: AssignmentGraphStream;
}

export interface PreparedGraphChange<T> {
  readonly change: AssignmentGraphChange | null;
  readonly value: T;
}

export type GraphMutation<T> =
  | {
      readonly kind: 'declare-stage';
      readonly apply: (graph: AssignmentGraph) => T;
    }
  | {
      readonly kind: 'assignment-transition';
      readonly action: AssignmentGraphTransitionAction;
      readonly apply: (graph: AssignmentGraph) => T;
    }
  | {
      readonly kind: 'resume-binding';
      readonly segmentOpenedCommitRef: JournalCommitRef;
      readonly apply: (graph: AssignmentGraph) => T;
    };

function cloneAssignment(assignment: WorkAssignment): WorkAssignment {
  return {
    ...assignment,
    taskId: { ...assignment.taskId },
    targetRefs: [...assignment.targetRefs],
    expectedOutputRefs: [...assignment.expectedOutputRefs],
    successCriteria: [...assignment.successCriteria],
    failureCriteria: [...assignment.failureCriteria],
    incompleteCriteria: [...assignment.incompleteCriteria],
    requiredCapabilities: [...assignment.requiredCapabilities],
  };
}

function cloneRecord(record: AssignmentRecord): AssignmentRecord {
  return {
    ...record,
    key: { ...record.key },
    assignment: cloneAssignment(record.assignment),
    ...(record.runtimeBinding ? { runtimeBinding: { ...record.runtimeBinding } } : {}),
    ...(record.result ? { result: structuredClone(record.result) } : {}),
    reviewResults: structuredClone(record.reviewResults),
    evidenceRefs: structuredClone(record.evidenceRefs),
    nextAction: { ...record.nextAction },
  };
}

function cloneStage(stage: AssignmentStageNode): AssignmentStageNode {
  return {
    ...stage,
    taskId: { ...stage.taskId },
    assignmentKeys: [...stage.assignmentKeys],
  };
}

export function assignmentKey(input: AssignmentKey): string {
  return `${input.assignmentId}:${input.attempt}:${input.executionEpoch}`;
}

function sameStream(left: AssignmentGraphStream, right: AssignmentGraphStream): boolean {
  return left.ownerId === right.ownerId
    && left.taskScope.organId.value === right.taskScope.organId.value
    && left.taskScope.taskId.value === right.taskScope.taskId.value;
}

function sameAssignment(left: WorkAssignment, right: WorkAssignment): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameResult(left: WorkResult, right: WorkResult): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function evidence(taskId: TaskId | undefined, locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `assignment-graph-${locator}`),
    kind: 'operation',
    source: 'assignment-graph',
    locator,
    scope: {
      organId: id('organ', 'assignment-graph'),
      ...(taskId ? { taskId } : {}),
    },
  };
}

function rejection(
  code: AssignmentResultRejectionCode,
  ownerId: string,
  reason: string,
  nextAction: NextAction,
  evidenceRefs: readonly EvidenceRef[],
): AssignmentResultAcceptance {
  return {
    accepted: false,
    code,
    ownerId,
    reason,
    nextAction,
    evidenceRefs: [...evidenceRefs],
  };
}

function criteriaRejection(
  ownerId: string,
  reason: string,
  result: WorkResult,
): AssignmentResultAcceptance {
  return rejection(
    'criteria-mismatch',
    ownerId,
    reason,
    { kind: 'recover', ref: `assignment.criteria.${result.assignmentId}` },
    result.evidenceRefs,
  );
}

function validateCriteria(
  assignment: WorkAssignment,
  result: WorkResult,
  criteria: WorkCriterionEvaluation | undefined,
): string | null {
  if (criteria) {
    const knownCriteria = new Set([
      ...assignment.successCriteria,
      ...assignment.failureCriteria,
      ...assignment.incompleteCriteria,
    ]);
    for (const value of [...criteria.satisfied, ...criteria.failed, ...criteria.incomplete]) {
      if (!knownCriteria.has(value)) return `criterion is not part of the assignment: ${value}`;
    }
  }
  if (result.status === 'succeeded') {
    if (assignment.successCriteria.length === 0) return 'success result has no success criteria';
    if (criteria) {
      if (!sameStringSet(criteria.satisfied, assignment.successCriteria)) return 'success criteria were not all satisfied';
      if (criteria.failed.length > 0 || criteria.incomplete.length > 0) return 'success result also matched failure or incomplete criteria';
    }
    return null;
  }
  if (result.status === 'failed') {
    if (assignment.failureCriteria.length === 0) return 'failed result has no failure criteria';
    if (criteria && criteria.failed.length === 0) return 'failed result did not match a failure criterion';
    return null;
  }
  if (result.status === 'incomplete') {
    if (assignment.incompleteCriteria.length === 0) return 'incomplete result has no incomplete criteria';
    if (criteria && criteria.incomplete.length === 0) return 'incomplete result did not match an incomplete criterion';
  }
  return null;
}

export class AssignmentGraph {
  private readonly stages = new Map<string, AssignmentStageNode>();
  private readonly assignments = new Map<string, AssignmentRecord>();
  private revisionValue = 0;
  readonly ownerId: string;
  readonly stream?: AssignmentGraphStream;

  constructor(options: AssignmentGraphOptions) {
    if (!options.ownerId.trim()) {
      throw new AssignmentGraphError('assignment graph owner is required', {
        ownerId: options.ownerId,
        reason: 'assignment.owner.required',
        nextAction: { kind: 'recover', ref: 'assignment.owner' },
        evidenceRefs: [evidence(undefined, 'assignment.owner.required')],
      });
    }
    this.ownerId = options.ownerId;
    if (options.stream) {
      validateTaskIdentityScope(options.stream.taskScope);
      if (options.stream.ownerId !== options.ownerId) {
        throw new AssignmentGraphError('assignment graph stream owner does not match graph owner', {
          ownerId: options.ownerId,
          reason: 'assignment.stream.owner.mismatch',
          nextAction: { kind: 'recover', ref: 'assignment.stream.owner' },
          evidenceRefs: [evidence(options.stream.taskScope.taskId, 'assignment.stream.owner.mismatch')],
        });
      }
      this.stream = {
        taskScope: { ...options.stream.taskScope },
        ownerId: options.stream.ownerId,
      };
    }
  }

  get revision(): number {
    return this.revisionValue;
  }

  prepare<T>(mutation: GraphMutation<T>): PreparedGraphChange<T> {
    const draft = this.fork();
    const value = mutation.apply(draft);
    const changedStages = this.changedStages(draft);
    const changedAssignments = this.changedAssignments(draft);

    if (changedStages.length === 0 && changedAssignments.length === 0) {
      return { change: null, value };
    }

    if (mutation.kind === 'declare-stage') {
      if (changedAssignments.length !== 0 || changedStages.length !== 1) {
        throw new AssignmentGraphError('stage declaration must change exactly one stage and no assignment', {
          ownerId: this.ownerId,
          reason: 'assignment.graph.prepare.stage',
          nextAction: { kind: 'recover', ref: 'assignment.graph.prepare' },
          evidenceRefs: [evidence(undefined, 'assignment.graph.prepare.stage')],
        });
      }
      const stage = changedStages[0]!;
      const previous = this.stages.get(stage.nodeId);
      if (previous || stage.assignmentKeys.length !== 0) {
        throw new AssignmentGraphError('stage declaration must add one empty stage', {
          ownerId: this.ownerId,
          reason: 'assignment.graph.prepare.stage',
          nextAction: { kind: 'recover', ref: `assignment.stage.${stage.nodeId}` },
          evidenceRefs: [evidence(stage.taskId, 'assignment.graph.prepare.stage')],
        });
      }
      return {
        change: { kind: 'stage-declared', stage: cloneStage(stage) },
        value,
      };
    }

    if (changedAssignments.length !== 1 || changedStages.length > 1) {
      throw new AssignmentGraphError('assignment transition must change exactly one assignment and at most one stage', {
        ownerId: this.ownerId,
        reason: 'assignment.graph.prepare.transition',
        nextAction: { kind: 'recover', ref: 'assignment.graph.prepare' },
        evidenceRefs: [evidence(undefined, 'assignment.graph.prepare.transition')],
      });
    }
    const assignment = draft.assignments.get(changedAssignments[0]!)!;
    const stage = draft.stages.get(assignment.stageNodeId);
    if (!stage) {
      throw new AssignmentGraphError('prepared assignment has no stage', {
        ownerId: this.ownerId,
        reason: 'assignment.graph.prepare.missing-stage',
        nextAction: { kind: 'recover', ref: `assignment.stage.${assignment.stageNodeId}` },
        evidenceRefs: assignment.evidenceRefs,
      });
    }
    if (changedStages.length === 1 && changedStages[0]!.nodeId !== stage.nodeId) {
      throw new AssignmentGraphError('assignment transition changed an unrelated stage', {
        ownerId: this.ownerId,
        reason: 'assignment.graph.prepare.stage-mismatch',
        nextAction: { kind: 'recover', ref: `assignment.stage.${stage.nodeId}` },
        evidenceRefs: assignment.evidenceRefs,
      });
    }

    const base = {
      kind: 'assignment-transition' as const,
      assignment: cloneRecord(assignment),
      stage: cloneStage(stage),
    };
    return {
      change: mutation.kind === 'resume-binding'
        ? {
            ...base,
            action: 'resume-binding',
            segmentOpenedCommitRef: mutation.segmentOpenedCommitRef,
          }
        : {
            ...base,
            action: mutation.action,
          },
      value,
    };
  }

  applyCommitted(entry: CommittedAssignmentGraphFact): void {
    if (!this.stream) {
      throw new AssignmentGraphError('assignment graph stream is required to apply committed facts', {
        ownerId: this.ownerId,
        reason: 'assignment.stream.required',
        nextAction: { kind: 'recover', ref: 'assignment.stream' },
        evidenceRefs: [evidence(undefined, 'assignment.stream.required')],
      });
    }
    if (!sameStream(entry.fact.stream, this.stream)) {
      throw new AssignmentGraphError('committed assignment fact stream does not match the graph', {
        ownerId: this.ownerId,
        reason: 'assignment.stream.mismatch',
        nextAction: { kind: 'recover', ref: 'assignment.stream' },
        evidenceRefs: [evidence(this.stream.taskScope.taskId, 'assignment.stream.mismatch')],
      });
    }
    if (entry.fact.revision !== this.revisionValue + 1) {
      throw new AssignmentGraphError('committed assignment fact revision is not contiguous', {
        ownerId: this.ownerId,
        reason: 'assignment.revision.noncontiguous',
        nextAction: { kind: 'recover', ref: `assignment.revision.${this.revisionValue + 1}` },
        evidenceRefs: [evidence(this.stream.taskScope.taskId, 'assignment.revision.noncontiguous')],
      });
    }

    this.validateCommittedChange(entry.fact);
    const change = entry.fact.change;
    if (change.kind === 'stage-declared') {
      this.stages.set(change.stage.nodeId, cloneStage(change.stage));
    } else {
      this.stages.set(change.stage.nodeId, cloneStage(change.stage));
      this.assignments.set(assignmentKey(change.assignment.key), cloneRecord(change.assignment));
    }
    this.revisionValue = entry.fact.revision;
  }

  addStage(input: CreateStageInput): AssignmentStageNode {
    if (!input.nodeId.trim()) throw new AssignmentGraphError('stage node id is required', {
      ownerId: this.ownerId,
      reason: 'assignment.stage.id.required',
      nextAction: { kind: 'recover', ref: 'assignment.stage.id' },
      evidenceRefs: [evidence(input.taskId, 'assignment.stage.id.required')],
    });
    const existing = this.stages.get(input.nodeId);
    if (existing) {
      if (existing.taskId.value !== input.taskId.value || existing.parentNodeId !== (input.parentNodeId ?? null)) {
        throw new AssignmentGraphError('stage node identity conflicts with an existing node', {
          ownerId: this.ownerId,
          reason: 'assignment.stage.conflict',
          nextAction: { kind: 'recover', ref: `assignment.stage.${input.nodeId}` },
          evidenceRefs: [evidence(input.taskId, 'assignment.stage.conflict')],
        });
      }
      return cloneStage(existing);
    }
    const stage: AssignmentStageNode = {
      nodeId: input.nodeId,
      taskId: { ...input.taskId },
      parentNodeId: input.parentNodeId ?? null,
      state: 'planned',
      assignmentKeys: [],
    };
    this.stages.set(stage.nodeId, stage);
    return cloneStage(stage);
  }

  createAssignment(stageNodeId: string, assignment: WorkAssignment): AssignmentRecord {
    const stage = this.stages.get(stageNodeId);
    if (!stage) throw new AssignmentGraphError('assignment stage does not exist', {
      ownerId: this.ownerId,
      reason: 'assignment.stage.missing',
      nextAction: { kind: 'recover', ref: `assignment.stage.${stageNodeId}` },
      evidenceRefs: [evidence(assignment.taskId, 'assignment.stage.missing')],
    });
    validateWorkAssignment(assignment);
    if (assignment.taskId.value !== stage.taskId.value) {
      throw new AssignmentGraphError('assignment task does not match its stage', {
        ownerId: this.ownerId,
        reason: 'assignment.task.mismatch',
        nextAction: { kind: 'recover', ref: `assignment.${assignment.assignmentId}` },
        evidenceRefs: [evidence(assignment.taskId, 'assignment.task.mismatch')],
      });
    }
    const key = assignmentKey(assignment);
    const existing = this.assignments.get(key);
    if (existing) {
      if (existing.stageNodeId !== stageNodeId) {
        throw new AssignmentGraphError('assignment key already belongs to a different stage', {
          ownerId: existing.ownerId,
          reason: 'assignment.stage.conflict',
          nextAction: { kind: 'recover', ref: `assignment.stage.${stageNodeId}` },
          evidenceRefs: existing.evidenceRefs,
        });
      }
      if (!sameAssignment(existing.assignment, assignment)) {
        throw new AssignmentGraphError('assignment identity conflicts with existing content', {
          ownerId: existing.ownerId,
          reason: 'assignment.idempotency-conflict',
          nextAction: { kind: 'recover', ref: `assignment.${assignment.assignmentId}` },
          evidenceRefs: existing.evidenceRefs,
        });
      }
      return cloneRecord(existing);
    }
    const record: AssignmentRecord = {
      key: {
        assignmentId: assignment.assignmentId,
        attempt: assignment.attempt,
        executionEpoch: assignment.executionEpoch,
      },
      stageNodeId,
      assignment: cloneAssignment(assignment),
      status: 'planned',
      ownerId: this.ownerId,
      reviewResults: [],
      reason: 'assignment planned',
      nextAction: { kind: 'continue', ref: assignment.assignmentId },
      evidenceRefs: [evidence(assignment.taskId, 'assignment.planned')],
    };
    this.assignments.set(key, record);
    this.stages.set(stage.nodeId, {
      ...stage,
      assignmentKeys: [...stage.assignmentKeys, key],
    });
    return cloneRecord(record);
  }

  assign(
    key: AssignmentKey,
    agentId: string,
    runtimeBinding: AssignmentRuntimeBinding,
  ): AssignmentRecord {
    const record = this.requireRecord(key);
    if (!agentId.trim()) throw new AssignmentGraphError('assignment agent id is required', {
      ownerId: record.ownerId,
      reason: 'assignment.agent.required',
      nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
      evidenceRefs: record.evidenceRefs.length > 0
        ? record.evidenceRefs
        : [evidence(record.assignment.taskId, 'assignment.agent.required')],
    });
    if (record.agentId && record.agentId !== agentId) {
      throw new AssignmentGraphError('assignment is already bound to another agent', {
        ownerId: record.ownerId,
        reason: 'assignment.agent.fenced',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs.length > 0
          ? record.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.agent.fenced')],
      });
    }
    if (record.runtimeBinding && JSON.stringify(record.runtimeBinding) !== JSON.stringify(runtimeBinding)) {
      throw new AssignmentGraphError('assignment is already bound to another runtime', {
        ownerId: record.ownerId,
        reason: 'assignment.runtime.fenced',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs.length > 0
          ? record.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.runtime.fenced')],
      });
    }
    if (record.status !== 'planned' && record.status !== 'assigned') return cloneRecord(record);
    const updated: AssignmentRecord = {
      ...record,
      status: 'assigned',
      agentId,
      runtimeBinding: { ...runtimeBinding },
      reason: 'assignment assigned to runtime',
      nextAction: { kind: 'continue', ref: `assignment.${record.assignment.assignmentId}` },
    };
    this.assignments.set(assignmentKey(key), updated);
    this.updateStage(record.stageNodeId, 'assigned');
    return cloneRecord(updated);
  }

  start(
    key: AssignmentKey,
    agentId: string,
    runtimeBinding: AssignmentRuntimeBinding,
  ): AssignmentRecord {
    const record = this.requireRecord(key);
    if (record.agentId !== agentId) {
      throw new AssignmentGraphError('assignment start agent does not match its binding', {
        ownerId: record.ownerId,
        reason: 'assignment.agent.fenced',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs.length > 0
          ? record.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.agent.fenced')],
      });
    }
    if (!record.runtimeBinding || JSON.stringify(record.runtimeBinding) !== JSON.stringify(runtimeBinding)) {
      throw new AssignmentGraphError('assignment start runtime does not match its binding', {
        ownerId: record.ownerId,
        reason: 'assignment.runtime.fenced',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs.length > 0
          ? record.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.runtime.fenced')],
      });
    }
    if (record.status === 'running') return cloneRecord(record);
    if (record.status !== 'assigned') {
      throw new AssignmentGraphError(`assignment cannot start from ${record.status}`, {
        ownerId: record.ownerId,
        reason: 'assignment.status.invalid',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs.length > 0
          ? record.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.status.invalid')],
      });
    }
    const updated: AssignmentRecord = {
      ...record,
      status: 'running',
      reason: 'assignment running',
      nextAction: { kind: 'continue', ref: `assignment.${record.assignment.assignmentId}` },
    };
    this.assignments.set(assignmentKey(key), updated);
    this.updateStage(record.stageNodeId, 'running');
    return cloneRecord(updated);
  }

  /**
   * Bind one hydrated cold-resumed assignment to the real acquired execution.
   * The Manager validates the committed segment source; this draft mutation
   * only installs that binding without resetting business history or status.
   */
  resumeBinding(
    key: AssignmentKey,
    agentId: string,
    runtimeBinding: AssignmentRuntimeBinding,
  ): AssignmentRecord {
    const record = this.requireRecord(key);
    if (record.status !== 'planned' && record.status !== 'assigned' && record.status !== 'running') {
      throw new AssignmentGraphError('assignment resume binding requires a pre-terminal record', {
        ownerId: record.ownerId,
        reason: 'assignment.resume-binding.status',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs,
      });
    }
    if (record.result !== undefined || record.reviewResults.length > 0) {
      throw new AssignmentGraphError('assignment resume binding cannot replace accepted history', {
        ownerId: record.ownerId,
        reason: 'assignment.resume-binding.history',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs,
      });
    }
    if (!agentId.trim()) {
      throw new AssignmentGraphError('assignment resume binding agent is required', {
        ownerId: record.ownerId,
        reason: 'assignment.agent.required',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs,
      });
    }
    if (record.agentId && record.agentId !== agentId) {
      throw new AssignmentGraphError('assignment resume binding cannot replace the bound agent', {
        ownerId: record.ownerId,
        reason: 'assignment.agent.fenced',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs,
      });
    }
    if (runtimeBinding.assignmentId !== record.assignment.assignmentId) {
      throw new AssignmentGraphError('assignment resume binding does not match its work assignment', {
        ownerId: record.ownerId,
        reason: 'assignment.runtime.assignment',
        nextAction: { kind: 'recover', ref: `assignment.${record.assignment.assignmentId}` },
        evidenceRefs: record.evidenceRefs,
      });
    }
    const updated: AssignmentRecord = {
      ...record,
      agentId,
      runtimeBinding: { ...runtimeBinding },
    };
    this.assignments.set(assignmentKey(key), updated);
    return cloneRecord(updated);
  }

  acceptResult(key: AssignmentKey, input: AssignmentResultInput): AssignmentResultAcceptance {
    const record = this.assignments.get(assignmentKey(key));
    const ownerId = input.ownerId ?? record?.ownerId ?? this.ownerId;
    if (!record) {
      return rejection(
        'unknown-assignment',
        ownerId,
        'work result has no matching assignment',
        { kind: 'recover', ref: `assignment.${key.assignmentId}` },
        input.result.evidenceRefs.length > 0
          ? input.result.evidenceRefs
          : [evidence(undefined, 'assignment.result.unknown')],
      );
    }
    if (record.result) {
      return sameResult(record.result, input.result)
        ? { accepted: true, record: cloneRecord(record), duplicate: true }
        : rejection(
            'duplicate-conflict',
            ownerId,
            'assignment already accepted a different result',
            { kind: 'recover', ref: `assignment.${key.assignmentId}` },
            record.evidenceRefs.length > 0
              ? record.evidenceRefs
              : input.result.evidenceRefs.length > 0
                ? input.result.evidenceRefs
                : [evidence(record.assignment.taskId, 'assignment.result.duplicate-conflict')],
          );
    }
    if (record.status !== 'running') {
      return rejection(
        'stale-lease',
        ownerId,
        'work result was accepted only while its assignment is running',
        { kind: 'recover', ref: `assignment.${key.assignmentId}` },
        input.result.evidenceRefs.length > 0
          ? input.result.evidenceRefs
          : record.evidenceRefs.length > 0
            ? record.evidenceRefs
            : [evidence(record.assignment.taskId, 'assignment.result.stale')],
      );
    }
    if (input.result.executionEpoch !== record.assignment.executionEpoch) {
      return rejection(
        'stale-epoch',
        ownerId,
        'work result execution epoch is stale',
        { kind: 'recover', ref: `assignment.${key.assignmentId}` },
        input.result.evidenceRefs.length > 0
          ? input.result.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.result.epoch')],
      );
    }
    if (
      !input.runtimeBinding
      || !record.runtimeBinding
      || input.runtimeBinding.runtimeId !== record.runtimeBinding.runtimeId
      || input.runtimeBinding.generation !== record.runtimeBinding.generation
      || input.runtimeBinding.leaseId !== record.runtimeBinding.leaseId
      || input.runtimeBinding.assignmentId !== record.runtimeBinding.assignmentId
      || input.runtimeBinding.executionEpoch !== record.runtimeBinding.executionEpoch
    ) {
      return rejection(
        'stale-lease',
        ownerId,
        'work result runtime lease is stale or does not match the running assignment',
        { kind: 'recover', ref: `assignment.${key.assignmentId}.lease` },
        input.result.evidenceRefs.length > 0
          ? input.result.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.result.lease')],
      );
    }
    if (record.agentId !== input.expectedAgentId || input.result.agentId !== input.expectedAgentId) {
      return rejection(
        'wrong-agent',
        ownerId,
        'work result agent does not match the assigned agent',
        { kind: 'recover', ref: `assignment.${key.assignmentId}` },
        input.result.evidenceRefs.length > 0
          ? input.result.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.result.agent')],
      );
    }
    try {
      validateWorkResult(input.result, record.assignment);
    } catch (error) {
      return rejection(
        'contract-invalid',
        ownerId,
        error instanceof ContractError ? error.message : String(error),
        { kind: 'recover', ref: `assignment.${key.assignmentId}` },
        input.result.evidenceRefs.length > 0
          ? input.result.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.result.contract')],
      );
    }
    const criteriaFailure = validateCriteria(record.assignment, input.result, input.criteria);
    if (criteriaFailure) return criteriaRejection(ownerId, criteriaFailure, input.result);

    let status: AssignmentStatus;
    let reason: string;
    let nextAction: NextAction;
    if (input.result.status === 'succeeded') {
      const reviewRequired = input.result.nextAction === 'review' || record.assignment.mergeGate === 'required';
      status = 'running';
      reason = reviewRequired
        ? 'work result satisfied success criteria; assignment awaits review or merge'
        : 'work result satisfied success criteria; assignment awaits completion';
      nextAction = {
        kind: 'continue',
        ref: reviewRequired ? `review.${key.assignmentId}` : `settle.${key.assignmentId}`,
      };
    } else if (input.result.status === 'failed' || input.result.status === 'incomplete') {
      const maxAttempts = input.maxAttempts ?? record.assignment.attempt;
      if (record.assignment.attempt < maxAttempts) {
        status = 'retryable';
        reason = input.result.status === 'failed'
          ? 'work result failed and retry budget remains'
          : 'work result is incomplete and retry budget remains';
        nextAction = { kind: 'recover', ref: `assignment.retry.${key.assignmentId}.${record.assignment.attempt + 1}` };
      } else {
        status = 'escalated';
        reason = 'work result retry budget is exhausted';
        nextAction = { kind: 'stop', ref: input.result.failureRef ?? `assignment.escalated.${key.assignmentId}` };
      }
    } else if (input.result.status === 'blocked') {
      status = 'blocked';
      reason = input.result.failureRef ?? 'work result is blocked';
      nextAction = { kind: 'recover', ref: input.result.conditionRef ?? `assignment.blocked.${key.assignmentId}` };
    } else {
      status = 'escalated';
      reason = 'work result was cancelled';
      nextAction = { kind: 'stop', ref: `assignment.cancelled.${key.assignmentId}` };
    }
    const updated: AssignmentRecord = {
      ...record,
      status,
      result: structuredClone(input.result),
      reason,
      nextAction,
      evidenceRefs: structuredClone(input.result.evidenceRefs),
    };
    this.assignments.set(assignmentKey(key), updated);
    this.updateStage(record.stageNodeId, status);
    return { accepted: true, record: cloneRecord(updated), duplicate: false };
  }

  recordReviewResult(key: AssignmentKey, result: ReviewResult): AssignmentRecord {
    const record = this.requireRecord(key);
    const existing = record.reviewResults.find((candidate) => candidate.resultId === result.resultId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(result)) {
        throw new AssignmentGraphError('review result id conflicts with existing content', {
          ownerId: record.ownerId,
          reason: 'review.result.idempotency-conflict',
          nextAction: { kind: 'recover', ref: `review.result.${result.resultId}` },
          evidenceRefs: result.evidenceRefs.length > 0
            ? result.evidenceRefs
            : record.evidenceRefs.length > 0
              ? record.evidenceRefs
              : [evidence(record.assignment.taskId, 'review.result.idempotency-conflict')],
        });
      }
      return cloneRecord(record);
    }
    const updated: AssignmentRecord = {
      ...record,
      reviewResults: [...record.reviewResults, structuredClone(result)],
    };
    this.assignments.set(assignmentKey(key), updated);
    return cloneRecord(updated);
  }

  markRetryable(key: AssignmentKey, reason: string, evidenceRefs: readonly EvidenceRef[]): AssignmentRecord {
    const record = this.requireRecord(key);
    const updated: AssignmentRecord = {
      ...record,
      status: 'retryable',
      agentId: undefined,
      runtimeBinding: undefined,
      result: undefined,
      reason,
      nextAction: { kind: 'recover', ref: `assignment.retry.${key.assignmentId}` },
      evidenceRefs: structuredClone(evidenceRefs),
    };
    this.assignments.set(assignmentKey(key), updated);
    this.updateStage(record.stageNodeId, 'retryable');
    return cloneRecord(updated);
  }

  markBlocked(key: AssignmentKey, reason: string, nextAction: NextAction, evidenceRefs: readonly EvidenceRef[]): AssignmentRecord {
    return this.updateStatus(key, 'blocked', reason, nextAction, evidenceRefs);
  }

  markEscalated(key: AssignmentKey, reason: string, nextAction: NextAction, evidenceRefs: readonly EvidenceRef[]): AssignmentRecord {
    return this.updateStatus(key, 'escalated', reason, nextAction, evidenceRefs);
  }

  markSucceeded(key: AssignmentKey, evidenceRefs: readonly EvidenceRef[]): AssignmentRecord {
    const record = this.requireRecord(key);
    if (record.status === 'succeeded') return cloneRecord(record);
    if (record.status !== 'running' || record.result?.status !== 'succeeded') {
      throw new AssignmentGraphError('assignment can only succeed after accepting a successful work result', {
        ownerId: record.ownerId,
        reason: 'assignment.succeeded.invalid',
        nextAction: { kind: 'recover', ref: `assignment.${key.assignmentId}` },
        evidenceRefs: record.evidenceRefs.length > 0
          ? record.evidenceRefs
          : [evidence(record.assignment.taskId, 'assignment.succeeded.invalid')],
      });
    }
    return this.updateStatus(
      key,
      'succeeded',
      'assignment completed after work result acceptance',
      { kind: 'continue', ref: `settle.${key.assignmentId}` },
      evidenceRefs,
    );
  }

  markMerged(key: AssignmentKey, evidenceRefs: readonly EvidenceRef[]): AssignmentRecord {
    return this.updateStatus(
      key,
      'merged',
      'review passed and merge completed',
      { kind: 'continue', ref: `settle.${key.assignmentId}` },
      evidenceRefs,
    );
  }

  get(key: AssignmentKey): AssignmentRecord | undefined {
    const record = this.assignments.get(assignmentKey(key));
    return record ? cloneRecord(record) : undefined;
  }

  getStage(nodeId: string): AssignmentStageNode | undefined {
    const stage = this.stages.get(nodeId);
    return stage ? cloneStage(stage) : undefined;
  }

  listAssignments(): readonly AssignmentRecord[] {
    return [...this.assignments.values()].map(cloneRecord);
  }

  listStages(): readonly AssignmentStageNode[] {
    return [...this.stages.values()].map(cloneStage);
  }

  snapshot(): AssignmentGraphSnapshot {
    return { stages: this.listStages(), assignments: this.listAssignments() };
  }

  private fork(): AssignmentGraph {
    const draft = new AssignmentGraph({
      ownerId: this.ownerId,
      ...(this.stream ? { stream: this.stream } : {}),
    });
    for (const [nodeId, stage] of this.stages) draft.stages.set(nodeId, cloneStage(stage));
    for (const [key, record] of this.assignments) draft.assignments.set(key, cloneRecord(record));
    draft.revisionValue = this.revisionValue;
    return draft;
  }

  private changedStages(draft: AssignmentGraph): readonly AssignmentStageNode[] {
    const nodeIds = new Set([...this.stages.keys(), ...draft.stages.keys()]);
    return [...nodeIds]
      .filter((nodeId) => {
        const before = this.stages.get(nodeId);
        const after = draft.stages.get(nodeId);
        return !before || !after || JSON.stringify(before) !== JSON.stringify(after);
      })
      .map((nodeId) => draft.stages.get(nodeId))
      .filter((stage): stage is AssignmentStageNode => stage !== undefined);
  }

  private changedAssignments(draft: AssignmentGraph): readonly string[] {
    const keys = new Set([...this.assignments.keys(), ...draft.assignments.keys()]);
    return [...keys].filter((key) => {
      const before = this.assignments.get(key);
      const after = draft.assignments.get(key);
      return !before || !after || JSON.stringify(before) !== JSON.stringify(after);
    });
  }

  private validateCommittedChange(fact: AssignmentGraphFact): void {
    const stream = this.stream;
    if (!stream) return;
    const change = fact.change;
    if (change.stage.taskId.value !== stream.taskScope.taskId.value) {
      throw new AssignmentGraphError('committed stage task does not match the graph stream', {
        ownerId: this.ownerId,
        reason: 'assignment.stage.task.mismatch',
        nextAction: { kind: 'recover', ref: `assignment.stage.${change.stage.nodeId}` },
        evidenceRefs: [evidence(stream.taskScope.taskId, 'assignment.stage.task.mismatch')],
      });
    }

    const existingStage = this.stages.get(change.stage.nodeId);
    if (change.kind === 'stage-declared') {
      if (existingStage || change.stage.state !== 'planned' || change.stage.assignmentKeys.length !== 0) {
        throw new AssignmentGraphError('committed stage declaration is inconsistent with the graph', {
          ownerId: this.ownerId,
          reason: 'assignment.stage.conflict',
          nextAction: { kind: 'recover', ref: `assignment.stage.${change.stage.nodeId}` },
          evidenceRefs: [evidence(stream.taskScope.taskId, 'assignment.stage.conflict')],
        });
      }
      return;
    }

    if (!existingStage) {
      throw new AssignmentGraphError('committed assignment stage does not exist', {
        ownerId: this.ownerId,
        reason: 'assignment.stage.missing',
        nextAction: { kind: 'recover', ref: `assignment.stage.${change.stage.nodeId}` },
        evidenceRefs: [evidence(stream.taskScope.taskId, 'assignment.stage.missing')],
      });
    }
    if (
      existingStage.taskId.value !== change.stage.taskId.value
      || existingStage.parentNodeId !== change.stage.parentNodeId
    ) {
      throw new AssignmentGraphError('committed assignment transition changed stage identity', {
        ownerId: this.ownerId,
        reason: 'assignment.stage.conflict',
        nextAction: { kind: 'recover', ref: `assignment.stage.${change.stage.nodeId}` },
        evidenceRefs: [evidence(stream.taskScope.taskId, 'assignment.stage.conflict')],
      });
    }

    const key = assignmentKey(change.assignment.key);
    const keyStage = [...this.stages.values()].find((stage) => stage.assignmentKeys.includes(key));
    if (keyStage && keyStage.nodeId !== change.stage.nodeId) {
      throw new AssignmentGraphError('assignment key already belongs to a different stage', {
        ownerId: this.ownerId,
        reason: 'assignment.stage.conflict',
        nextAction: { kind: 'recover', ref: `assignment.stage.${change.stage.nodeId}` },
        evidenceRefs: [evidence(stream.taskScope.taskId, 'assignment.stage.conflict')],
      });
    }
    if (change.stage.assignmentKeys.filter((candidate) => candidate === key).length !== 1) {
      throw new AssignmentGraphError('committed assignment stage membership is inconsistent', {
        ownerId: this.ownerId,
        reason: 'assignment.stage.membership',
        nextAction: { kind: 'recover', ref: `assignment.stage.${change.stage.nodeId}` },
        evidenceRefs: [evidence(stream.taskScope.taskId, 'assignment.stage.membership')],
      });
    }
    if (change.assignment.stageNodeId !== change.stage.nodeId) {
      throw new AssignmentGraphError('committed assignment record names another stage', {
        ownerId: this.ownerId,
        reason: 'assignment.stage.conflict',
        nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
        evidenceRefs: change.assignment.evidenceRefs,
      });
    }
    const work = change.assignment.assignment;
    if (
      change.assignment.key.assignmentId !== work.assignmentId
      || change.assignment.key.attempt !== work.attempt
      || change.assignment.key.executionEpoch !== work.executionEpoch
      || work.taskId.value !== change.stage.taskId.value
    ) {
      throw new AssignmentGraphError('committed assignment key or task does not match its work assignment', {
        ownerId: this.ownerId,
        reason: 'assignment.key.mismatch',
        nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
        evidenceRefs: change.assignment.evidenceRefs,
      });
    }

    const existing = this.assignments.get(key);
    if (!existing) {
      if (change.action !== 'create-assignment') {
        throw new AssignmentGraphError('committed assignment transition has no existing assignment', {
          ownerId: this.ownerId,
          reason: 'assignment.missing',
          nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
          evidenceRefs: change.assignment.evidenceRefs,
        });
      }
      const expectedKeys = [...existingStage.assignmentKeys, key];
      if (
        change.assignment.status !== 'planned'
        || change.assignment.ownerId !== this.ownerId
        || change.assignment.agentId !== undefined
        || change.assignment.runtimeBinding !== undefined
        || change.assignment.result !== undefined
        || change.assignment.reviewResults.length !== 0
        || change.stage.state !== existingStage.state
        || JSON.stringify(expectedKeys) !== JSON.stringify(change.stage.assignmentKeys)
      ) {
        throw new AssignmentGraphError('committed assignment creation is inconsistent with the stage', {
          ownerId: this.ownerId,
          reason: 'assignment.create.conflict',
          nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
          evidenceRefs: change.assignment.evidenceRefs,
        });
      }
      return;
    }

    if (
      change.action === 'create-assignment'
      || existing.stageNodeId !== change.stage.nodeId
      || existing.ownerId !== change.assignment.ownerId
      || JSON.stringify(existing.key) !== JSON.stringify(change.assignment.key)
      || !sameAssignment(existing.assignment, change.assignment.assignment)
      || JSON.stringify(existingStage.assignmentKeys) !== JSON.stringify(change.stage.assignmentKeys)
    ) {
      throw new AssignmentGraphError('committed assignment transition conflicts with existing membership', {
        ownerId: this.ownerId,
        reason: 'assignment.stage.conflict',
        nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
        evidenceRefs: existing.evidenceRefs,
      });
    }

    if (change.action === 'resume-binding') {
      const stageUnchanged = JSON.stringify(existingStage) === JSON.stringify(change.stage);
      const recordHistoryUnchanged = existing.status === change.assignment.status
        && JSON.stringify(existing.result) === JSON.stringify(change.assignment.result)
        && JSON.stringify(existing.reviewResults) === JSON.stringify(change.assignment.reviewResults)
        && existing.reason === change.assignment.reason
        && JSON.stringify(existing.nextAction) === JSON.stringify(change.assignment.nextAction)
        && JSON.stringify(existing.evidenceRefs) === JSON.stringify(change.assignment.evidenceRefs);
      const agentUnchangedOrFirstBound = existing.agentId === change.assignment.agentId
        || (existing.agentId === undefined
          && change.assignment.agentId !== undefined
          && change.assignment.agentId.trim().length > 0);
      if (
        !stageUnchanged
        || !recordHistoryUnchanged
        || !agentUnchangedOrFirstBound
        || !change.assignment.runtimeBinding
        || change.assignment.runtimeBinding.assignmentId !== change.assignment.assignment.assignmentId
      ) {
        throw new AssignmentGraphError('committed resume binding changed assignment history', {
          ownerId: this.ownerId,
          reason: 'assignment.resume-binding.conflict',
          nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
          evidenceRefs: change.assignment.evidenceRefs,
        });
      }
      return;
    }

    const expectedStatus: Partial<Record<AssignmentGraphTransitionAction, readonly AssignmentStatus[]>> = {
      assign: ['assigned'],
      start: ['running'],
      'accept-result': ['running', 'retryable', 'escalated', 'blocked'],
      'record-review-result': [existing.status],
      'mark-retryable': ['retryable'],
      'mark-blocked': ['blocked'],
      'mark-escalated': ['escalated'],
      'mark-succeeded': ['succeeded'],
      'mark-merged': ['merged'],
    };
    const allowedStatuses = expectedStatus[change.action] ?? [];
    if (!allowedStatuses.includes(change.assignment.status)) {
      throw new AssignmentGraphError('committed assignment action has an invalid status', {
        ownerId: this.ownerId,
        reason: 'assignment.status.invalid',
        nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
        evidenceRefs: change.assignment.evidenceRefs,
      });
    }
    if (change.action === 'record-review-result') {
      const prior = existing.reviewResults;
      const next = change.assignment.reviewResults;
      const appended = next.length === prior.length + 1
        && prior.every((result, index) => JSON.stringify(result) === JSON.stringify(next[index]));
      if (!appended) {
        throw new AssignmentGraphError('committed review result transition is not append-only', {
          ownerId: this.ownerId,
          reason: 'review.result.conflict',
          nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
          evidenceRefs: change.assignment.evidenceRefs,
        });
      }
    } else if (JSON.stringify(existing.reviewResults) !== JSON.stringify(change.assignment.reviewResults)) {
      throw new AssignmentGraphError('committed assignment transition changed review history', {
        ownerId: this.ownerId,
        reason: 'assignment.review.conflict',
        nextAction: { kind: 'recover', ref: `assignment.${change.assignment.key.assignmentId}` },
        evidenceRefs: change.assignment.evidenceRefs,
      });
    }
    const stageStateExpected = change.action === 'record-review-result'
      ? existingStage.state
      : change.assignment.status;
    if (change.stage.state !== stageStateExpected) {
      throw new AssignmentGraphError('committed stage state does not match its assignment transition', {
        ownerId: this.ownerId,
        reason: 'assignment.stage.state',
        nextAction: { kind: 'recover', ref: `assignment.stage.${change.stage.nodeId}` },
        evidenceRefs: change.assignment.evidenceRefs,
      });
    }
  }

  private requireRecord(key: AssignmentKey): AssignmentRecord {
    const record = this.assignments.get(assignmentKey(key));
    if (!record) throw new AssignmentGraphError('assignment does not exist', {
      ownerId: this.ownerId,
      reason: 'assignment.missing',
      nextAction: { kind: 'recover', ref: `assignment.${key.assignmentId}` },
      evidenceRefs: [evidence(undefined, 'assignment.missing')],
    });
    return record;
  }

  private updateStage(nodeId: string, state: AssignmentStatus): void {
    const stage = this.stages.get(nodeId);
    if (!stage) return;
    this.stages.set(nodeId, { ...stage, state });
  }

  private updateStatus(
    key: AssignmentKey,
    status: AssignmentStatus,
    reason: string,
    nextAction: NextAction,
    evidenceRefs: readonly EvidenceRef[],
  ): AssignmentRecord {
    const record = this.requireRecord(key);
    const updated: AssignmentRecord = {
      ...record,
      status,
      reason,
      nextAction: { ...nextAction },
      evidenceRefs: structuredClone(evidenceRefs),
    };
    this.assignments.set(assignmentKey(key), updated);
    this.updateStage(record.stageNodeId, status);
    return cloneRecord(updated);
  }
}

export function replayAssignmentGraph(
  stream: AssignmentGraphStream,
  entries: readonly CommittedAssignmentGraphFact[],
): AssignmentGraphSnapshot {
  const graph = new AssignmentGraph({ ownerId: stream.ownerId, stream });
  for (const entry of entries) graph.applyCommitted(entry);
  return graph.snapshot();
}
