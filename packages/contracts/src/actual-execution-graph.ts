import type {
  AssignmentGraphSnapshot,
  AssignmentGraphStream,
  CommittedAssignmentGraphFact,
} from './assignment-graph.js';
import type { TaskFlowGuidance } from './task-flow.js';
import type { TaskIdentityScope } from './task-identity.js';

export interface RecordedAssignmentGraphStream {
  readonly stream: AssignmentGraphStream;
  readonly facts: readonly CommittedAssignmentGraphFact[];
  readonly snapshot: AssignmentGraphSnapshot;
}

export type TaskActualExecutionGraphHistory =
  | {
      readonly status: 'recorded';
      readonly streams: readonly RecordedAssignmentGraphStream[];
    }
  | {
      readonly status: 'not-recorded';
      readonly reason: 'no-recorded-facts';
    };

/**
 * Contracts-owned source for the actual execution graph read carrier.
 * Task plan snapshots keep their existing carrier and are not copied here.
 */
export interface TaskActualExecutionGraphSnapshot {
  readonly taskScope: TaskIdentityScope;
  readonly guidance?: TaskFlowGuidance;
  readonly history: TaskActualExecutionGraphHistory;
}
