import type {
  EvidenceRef,
  JournalCommitRef,
  TaskActualExecutionGraphEdgeKind,
  TaskActualExecutionNodeKind,
  TaskExecutionInstanceIdentity,
  TaskFlowKind,
  TaskFlowLayoutMode,
  TaskFlowLoopKind,
  TaskFlowStageRole,
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
  readonly aimLabel: string;
  readonly layout: TaskFlowLayoutMode;
  readonly layoutLabel: string;
  readonly stages: readonly {
    readonly stageId: string;
    readonly title: string;
    readonly summary: string;
    readonly role: TaskFlowStageRole;
    readonly roleLabel: string;
    readonly groupLabel: string;
    readonly dynamicChoices?: readonly string[];
    readonly prerequisiteTitles: readonly string[];
  }[];
  readonly dependencies: readonly {
    readonly fromStageId: string;
    readonly toStageId: string;
    readonly fromTitle: string;
    readonly toTitle: string;
  }[];
  readonly loops: readonly {
    readonly kind: TaskFlowLoopKind;
    readonly kindLabel: string;
    readonly title: string;
    readonly fromStageId: string;
    readonly toStageId: string;
    readonly fromTitle: string;
    readonly toTitle: string;
    readonly summary: string;
    readonly stopCondition: string;
  }[];
}

/**
 * A native fact in human wording. It never contains raw identifiers, runtime
 * ids, commit refs, epochs, digests or node ids. Technical detail stays in
 * `technical`.
 */
export interface TaskActualExecutionNodeSummaryProjection {
  readonly roleLabel: string;
  readonly objective?: string;
  readonly stateLabel: string;
  readonly stateTone: TaskActualExecutionStateTone;
  readonly outcomeLabel?: string;
  readonly resultSummary?: string;
  readonly adoptionLabel?: string;
  readonly decisionLabel?: string;
  readonly reason?: string;
  readonly nextActionLabel?: string;
}

export interface TaskActualExecutionEdgeSummaryProjection {
  readonly edgeId: string;
  readonly kind: TaskActualExecutionGraphEdgeKind;
  readonly label: string;
  readonly detail: string;
}

export interface TaskActualExecutionNodeTechnicalProjection {
  readonly nodeId: string;
  readonly nodeKind: TaskActualExecutionNodeKind;
  readonly taskIdValue: string;
  readonly assignmentId: string;
  readonly instance?: TaskExecutionInstanceIdentity;
  readonly executionEpoch?: number;
  readonly businessTurnId?: string;
  readonly segmentId?: string;
  readonly pipelineNodeId?: string;
  readonly invocationId?: string;
  readonly childTurnId?: string;
  readonly checkpointReceiptRef?: string;
  readonly containingLocationKind?: 'active-turn' | 'resumed-segment';
  readonly containingLocationBusinessTurnId?: string;
  readonly containingLocationSegmentId?: string;
  readonly commitRefs: readonly JournalCommitRef[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly missingSource?: string;
  readonly message?: string;
}

export interface TaskActualExecutionNodeProjection {
  readonly nodeId: string;
  readonly kind: TaskActualExecutionNodeKind;
  readonly summary: TaskActualExecutionNodeSummaryProjection;
  readonly technical: TaskActualExecutionNodeTechnicalProjection;
}

export interface TaskActualExecutionGroupProjection {
  readonly groupId: string;
  readonly label: string;
  readonly purpose: string;
  readonly nodes: readonly TaskActualExecutionNodeProjection[];
}

export interface TaskActualExecutionUnavailableProjection {
  readonly sourceId: string;
  readonly label: string;
  readonly detail: string;
}

export interface TaskActualExecutionUngroupedProjection {
  readonly nodeId: string;
  readonly label: string;
  readonly detail: string;
}

export type TaskActualExecutionGraphHistoryProjection =
  | {
      readonly status: 'recorded';
      readonly summary: string;
      readonly groupCount: number;
      readonly nodeCount: number;
      readonly edgeCount: number;
      readonly groups: readonly TaskActualExecutionGroupProjection[];
      readonly edges: readonly TaskActualExecutionEdgeSummaryProjection[];
      readonly ungrouped: readonly TaskActualExecutionUngroupedProjection[];
      readonly unavailable: readonly TaskActualExecutionUnavailableProjection[];
      readonly recordCount: number;
      readonly deliveryCount: number;
    }
  | {
      readonly status: 'not-recorded';
      readonly reason: 'no-recorded-facts';
      readonly label: string;
      readonly detail: string;
      readonly unavailable?: readonly TaskActualExecutionUnavailableProjection[];
    };

/**
 * Read-only UI projection of `TaskActualExecutionGraphSnapshot`.
 *
 * Guidance, current plan revisions and recorded execution nodes keep separate
 * carriers and meanings. Raw IDs stay in the technical detail layer only; the
 * default renderer does not display them.
 */
export interface TaskActualExecutionGraphProjection {
  readonly surface: 'task-actual-execution-graph';
  readonly taskScope: TaskIdentityScope;
  readonly guidance?: TaskActualExecutionGuidanceProjection;
  readonly history: TaskActualExecutionGraphHistoryProjection;
}
