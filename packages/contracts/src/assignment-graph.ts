import type {
  EvidenceRef,
  NextAction,
  TaskId,
  WorkAssignment,
  WorkResult,
} from './index.js';
import type { ReviewResult } from './review-data.js';

export type AssignmentStatus =
  | 'planned'
  | 'assigned'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'incomplete'
  | 'blocked'
  | 'retryable'
  | 'escalated'
  | 'merged';

export interface AssignmentKey {
  readonly assignmentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
}

export interface AssignmentRuntimeBinding {
  readonly runtimeId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly assignmentId: string;
  readonly executionEpoch: number;
}

export interface AssignmentStageNode {
  readonly nodeId: string;
  readonly taskId: TaskId;
  readonly parentNodeId: string | null;
  readonly state: AssignmentStatus;
  readonly assignmentKeys: readonly string[];
}

export interface AssignmentRecord {
  readonly key: AssignmentKey;
  readonly stageNodeId: string;
  readonly assignment: WorkAssignment;
  readonly status: AssignmentStatus;
  readonly ownerId: string;
  readonly agentId?: string;
  readonly runtimeBinding?: AssignmentRuntimeBinding;
  readonly result?: WorkResult;
  readonly reviewResults: readonly ReviewResult[];
  readonly reason: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AssignmentGraphSnapshot {
  readonly stages: readonly AssignmentStageNode[];
  readonly assignments: readonly AssignmentRecord[];
}

/**
 * The candidate second-graph persistence DTOs (stream, action, change, fact,
 * commit, resume source) were removed from this contracts module. The native
 * execution graph reads committed active-turn, segment, review and Planner
 * records directly; it does not create a second durable assignment-graph fact
 * stream. Runtime/JSONL/App/UI consumers that referenced those DTOs are migrated
 * by their respective owners.
 */
