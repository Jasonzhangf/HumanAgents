import type {
  EvidenceRef,
  NextAction,
  TaskId,
  WorkAssignment,
  WorkResult,
} from './index.js';
import type { JournalCommitRef } from './i2-history.js';
import type { ReviewResult } from './review-data.js';
import type {
  ActiveTurnInitialSegmentSource,
  ResumedTurnSegmentOpened,
} from './active-turn-segments.js';
import type { TaskIdentityScope } from './task-identity.js';

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

/** Stable graph stream identity. It is not a mode, plan revision or incarnation. */
export interface AssignmentGraphStream {
  readonly taskScope: TaskIdentityScope;
  readonly ownerId: string;
}

export type AssignmentGraphAction =
  | 'create-assignment'
  | 'assign'
  | 'start'
  | 'accept-result'
  | 'record-review-result'
  | 'mark-retryable'
  | 'mark-blocked'
  | 'mark-escalated'
  | 'mark-succeeded'
  | 'mark-merged';

export type AssignmentGraphChange =
  | {
      readonly kind: 'stage-declared';
      readonly stage: AssignmentStageNode;
    }
  | {
      readonly kind: 'assignment-transition';
      readonly action: AssignmentGraphAction;
      readonly assignment: AssignmentRecord;
      readonly stage: AssignmentStageNode;
    }
  | {
      readonly kind: 'assignment-transition';
      readonly action: 'resume-binding';
      readonly assignment: AssignmentRecord;
      readonly stage: AssignmentStageNode;
      readonly segmentOpenedCommitRef: JournalCommitRef;
    };

export interface AssignmentGraphFact {
  readonly version: 1;
  readonly stream: AssignmentGraphStream;
  readonly revision: number;
  readonly change: AssignmentGraphChange;
}

export interface CommittedAssignmentGraphFact {
  readonly fact: AssignmentGraphFact;
  readonly commitRef: JournalCommitRef;
}

export interface AssignmentGraphCommitRequest {
  readonly commitId: string;
  readonly expectedRevision: number;
  readonly fact: AssignmentGraphFact;
}

export interface AssignmentGraphResumeSource {
  readonly openedCommitRef: JournalCommitRef;
  readonly opened: ResumedTurnSegmentOpened;
  readonly initial: ActiveTurnInitialSegmentSource;
  readonly segments: readonly ResumedTurnSegmentOpened[];
}
