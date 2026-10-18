import type {
  AssignmentStatus,
  EvidenceRef,
  TaskFlowKind,
  TaskIdentityScope,
} from '@humanagent/contracts';

export type TaskActualExecutionStateTone =
  | 'neutral'
  | 'active'
  | 'success'
  | 'warning'
  | 'danger';

export interface TaskActualExecutionGuidanceProjection {
  readonly kind: TaskFlowKind;
  readonly kindLabel: string;
  readonly aim: string;
  readonly selectionGuidance: string;
  readonly displayGroups: readonly string[];
}

export interface TaskActualExecutionResultProjection {
  readonly status: 'succeeded' | 'failed' | 'incomplete' | 'blocked' | 'cancelled';
  readonly statusLabel: string;
  readonly summary: string;
}

export interface TaskActualExecutionReviewProjection {
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly statusLabel: string;
  readonly findingCount: number;
}

export interface TaskActualExecutionMemberTechnicalProjection {
  readonly assignmentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly pipelineNodeId: string;
  readonly agentId?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface TaskActualExecutionMemberProjection {
  readonly roleLabel: string;
  readonly objective: string;
  readonly status: AssignmentStatus;
  readonly statusLabel: string;
  readonly statusTone: TaskActualExecutionStateTone;
  readonly result?: TaskActualExecutionResultProjection;
  readonly reviews: readonly TaskActualExecutionReviewProjection[];
  readonly reason: string;
  readonly nextActionLabel: string;
  readonly technical: TaskActualExecutionMemberTechnicalProjection;
}

export type TaskActualExecutionStageParentProjection =
  | {
      readonly kind: 'none';
      readonly label: string;
    }
  | {
      readonly kind: 'recorded';
      readonly stageNodeId: string;
      readonly label: string;
    }
  | {
      readonly kind: 'missing';
      readonly parentNodeId: string;
      readonly label: string;
    };

export interface TaskActualExecutionStageProjection {
  readonly stageNodeId: string;
  readonly label: string;
  readonly state: AssignmentStatus;
  readonly stateLabel: string;
  readonly stateTone: TaskActualExecutionStateTone;
  readonly parent: TaskActualExecutionStageParentProjection;
  readonly members: readonly TaskActualExecutionMemberProjection[];
  readonly technical: {
    readonly parentNodeId: string | null;
    readonly assignmentKeys: readonly string[];
  };
}

export interface TaskActualExecutionStreamProjection {
  readonly ownerId: string;
  readonly ownerLabel: string;
  readonly stages: readonly TaskActualExecutionStageProjection[];
}

export type TaskActualExecutionGraphHistoryProjection =
  | {
      readonly status: 'recorded';
      readonly summary: string;
      readonly streamCount: number;
      readonly stageCount: number;
      readonly memberCount: number;
      readonly streams: readonly TaskActualExecutionStreamProjection[];
    }
  | {
      readonly status: 'not-recorded';
      readonly reason: 'no-recorded-facts';
      readonly label: string;
      readonly detail: string;
    };

/**
 * Read-only UI projection of `TaskActualExecutionGraphSnapshot`.
 *
 * Guidance, current plan revisions and recorded execution instances keep
 * separate carriers and meanings. Raw IDs are retained only for the deliberate
 * detail layer; the default renderer does not display them.
 */
export interface TaskActualExecutionGraphProjection {
  readonly surface: 'task-actual-execution-graph';
  readonly taskScope: TaskIdentityScope;
  readonly guidance?: TaskActualExecutionGuidanceProjection;
  readonly history: TaskActualExecutionGraphHistoryProjection;
}
