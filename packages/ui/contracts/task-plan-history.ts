import type {
  PublishedTaskPlanRevision,
  TaskPlanSnapshot,
} from '../../contracts/src/index.js';

import type {
  RuntimeCommitRefProjection,
  RuntimeReadScope,
} from './runtime.js';

/** Exact Runtime-accepted current revision and its full physical Journal receipt. */
export type RuntimeTaskPlanSelectionProjection = {
  readonly revisionId: string;
  readonly revisionCommitRef: RuntimeCommitRefProjection;
};

/**
 * Current mode is authoritative or explicitly unknown. It is never inferred from the history list,
 * and `unknown` is not an empty selection.
 */
export type RuntimeTaskPlanCurrentProjection =
  | {
      readonly state: 'known';
      readonly value: RuntimeTaskPlanSelectionProjection;
    }
  | {
      readonly state: 'unknown';
      readonly reason: string;
    };

/**
 * One retained published revision. `journalCommitRef` is the existing publication identity string.
 * Physical receipts stay with the current selection only; they are not manufactured per entry.
 */
export interface RuntimeTaskPlanRevisionProjection {
  readonly revisionId: string;
  readonly sequence: number;
  readonly journalCommitRef: string;
  readonly predecessor:
    | Pick<
        NonNullable<PublishedTaskPlanRevision['predecessor']>,
        'revisionId' | 'sequence'
      >
    | null;
  readonly snapshot: TaskPlanSnapshot;
  readonly reason: PublishedTaskPlanRevision['reason'];
  readonly evidenceRefs: PublishedTaskPlanRevision['source']['evidenceRefs'];
  readonly historyCoverage: PublishedTaskPlanRevision['historyCoverage'];
  readonly publishedAt: string;
}

/** Semantic history projection: complete returned order plus the exact current selection. */
export interface RuntimeTaskPlanHistoryProjection {
  readonly surface: 'runtime-task-plan-history';
  readonly scope: Extract<RuntimeReadScope, { readonly kind: 'task' }>;
  readonly current: RuntimeTaskPlanCurrentProjection;
  readonly revisions: readonly RuntimeTaskPlanRevisionProjection[];
}
