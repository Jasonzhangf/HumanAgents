import {
  ContractError,
  id,
  validateWorkAssignment,
  validateWorkResult,
  type EvidenceRef,
  type NextAction,
  type TaskId,
  type WorkAssignment,
  type WorkResult,
} from '../../../contracts/src/index.js';
import type { ReviewResult } from '../review/index.js';
import { AssignmentGraphError } from './errors.js';
import type {
  AssignmentGraphSnapshot,
  AssignmentKey,
  AssignmentRecord,
  AssignmentRuntimeBinding,
  AssignmentStageNode,
  AssignmentStatus,
  WorkCriterionEvaluation,
} from './types.js';

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
}

function cloneAssignment(assignment: WorkAssignment): WorkAssignment {
  return {
    ...assignment,
    taskId: { ...assignment.taskId },
    targetRefs: [...assignment.targetRefs],
    expectedOutputRefs: [...assignment.expectedOutputRefs],
    ...(assignment.expectedArtifactDigests
      ? { expectedArtifactDigests: [...assignment.expectedArtifactDigests] }
      : {}),
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
  readonly ownerId: string;

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
      status = 'succeeded';
      reason = 'work result satisfied success criteria';
      nextAction = { kind: 'continue', ref: `review.${key.assignmentId}` };
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
