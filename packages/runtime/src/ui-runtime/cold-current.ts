import type {
  ContextHistoryRecord,
  NextAction,
  Task,
  TaskIdentityRecord,
} from '../../../contracts/src/index.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import type {
  ReentryCurrentFacts,
  ReentryFence,
  RetainedReentryDuty,
} from '../checkpoints/conditional-reentry.js';
import type { TaskGrantAuthority } from '../admission/task-grant.js';
import type { OperationControlReadback } from '../gateway/ports.js';
import type { RuntimeExecutionAllocation } from './coordinator.js';
import type { ActiveTurnJournalRecord } from '../context/active-turn-journal.js';
import type { ActiveTurnBinding } from '../../../contracts/src/active-turn-context.js';

/**
 * Cold-only current-facts ABI, frozen before any App producer implements it.
 *
 * The Runtime owns the shape of what a caller may learn about the current turn
 * without a committed checkpoint closure. These facts describe what the
 * verified Organ Journal already holds. They never authorize a resume, never
 * fabricate a capture, and never replace the existing checkpoint-bound reader.
 *
 * `ColdInitialOpenSource` is a read of committed records: the physical binding
 * carrier, the committed records through that turn, and the authoritative
 * physical operation-control namespace. `producersDrained` and `cut` have no
 * meaning without a capture, so they are absent. Every field here is an
 * observation, not a permission.
 */
export interface ColdInitialOpenSource {
  /** The committed active-turn binding for this business turn. */
  readonly binding: ActiveTurnBinding;
  /** Exact Journal commit ref of that binding-opened carrier. */
  readonly bindingCommitRef: JournalCommitRef;
  /** Exact Journal commit ref of the last committed carrier of this turn. */
  readonly recordsThroughCommitRef: JournalCommitRef;
  /** All validated active-turn records of this turn, in commit order. */
  readonly records: readonly ActiveTurnJournalRecord[];
}

/**
 * Physical position facts of the initial incarnation. Deliberately no
 * checkpoint ref and no synthetic control receipt: neither exists, and a
 * placeholder would fabricate authority.
 */
export interface ColdInitialOpenPosition {
  readonly contextCommitRef: JournalCommitRef;
  readonly executionEpoch: number;
}

/** Known initial-turn-open current facts, read from verified Journal records. */
export interface ColdInitialOpenCurrentFacts {
  readonly state: 'known';
  readonly kind: 'initial-turn-open';
  readonly stateCommitRef: JournalCommitRef;
  readonly task: Task;
  readonly identity: TaskIdentityRecord;
  readonly grant: TaskGrantAuthority;
  readonly initial: ColdInitialOpenSource;
  readonly position: ColdInitialOpenPosition;
  readonly context: ContextHistoryRecord;
  readonly operationControl: Extract<
    OperationControlReadback,
    { readonly state: 'complete' }
  >;
  readonly entryPhase: string;
  readonly nextAction: NextAction;
  readonly fencedBindings: readonly ReentryFence[];
  readonly retainedDuties: readonly RetainedReentryDuty[];
  readonly unresolvedDisplacedRefs: readonly string[];
}

/** Discriminated known facts. The `checkpoint-bound` branch is unchanged. */
export type ColdCurrentFacts =
  | {
      readonly state: 'known';
      readonly kind: 'checkpoint-bound';
      readonly current: ReentryCurrentFacts;
    }
  | ColdInitialOpenCurrentFacts;

/** Cold current facts read, or an explicit unknown with a concrete reason. */
export type ColdCurrentRead =
  | ColdCurrentFacts
  | { readonly state: 'unknown'; readonly reason: string };

/** Input to a cold current-facts read. */
export interface ColdCurrentReadInput {
  readonly allocation: RuntimeExecutionAllocation;
  readonly businessTurnId: string;
}

/**
 * Port implemented by the App cold reader over the authoritative Journal.
 * The physical journal and authenticated principal are bound once by
 * composition; a resume caller cannot supply them.
 */
export interface ColdCurrentReadPort {
  readColdCurrent(input: ColdCurrentReadInput): Promise<ColdCurrentRead>;
}
