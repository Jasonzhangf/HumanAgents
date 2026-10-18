import type {
  I2JournalPort,
  TaskIdentityScope,
} from '../../../contracts/src/index.js';
import type { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import type { TaskIdentityConsumer } from '../../../runtime/src/orchestration/task-identity.js';
import type { TaskPlanRevisionConsumer } from '../../../runtime/src/orchestration/task-plan-revisions.js';
import type {
  CommittedCheckpointRecord,
  NativeCheckpointJournalPort,
} from '../../../runtime/src/checkpoints/ports.js';
import {
  createInspectionRuntimeHelpers,
  type InspectionRuntimeHelpers,
  type InspectionRuntimeResourceReader,
} from '../../../runtime/src/agent-loop/inspection-runtime-helpers.js';
import {
  InspectionTurnBoundary,
  type InspectionTurnBoundaryDependencies,
} from '../../../runtime/src/agent-loop/inspection-turn-boundary.js';
import { createRuntimeInspectionStopSettlementPort } from '../../../runtime/src/agent-loop/inspection-stop-completion.js';
import type { RuntimeInspectionStopSettlementPort } from '../../../runtime/src/ui-runtime/coordinator.js';
import { createInspectionAcceptedCheckPort } from '../inspection-check.js';
import { createInspectionTurnResourceReader } from './inspection-resources.js';
import { createInspectionStopResourceReader } from '../inspection-stop-resources.js';

type InspectionTaskIdentity = Pick<TaskIdentityConsumer, 'read'>;
type InspectionPlans = Pick<TaskPlanRevisionConsumer, 'get' | 'getCommitRef' | 'list'>;
type InspectionCheckpoints = Pick<NativeCheckpointJournalPort,
  'readCommitted' | 'readCheckpointRecoveryBinding' | 'readNativeCheckpoint'>;

/**
 * Bind the accepted Runtime inspection APIs to their existing physical owners.
 * The caller supplies the exact Task-scoped readers, journals, plans and clock;
 * this module chooses no plan, occurrence, outcome, or stop action.
 */
export function createProductionInspectionPorts(input: {
  readonly resources: InspectionRuntimeResourceReader;
  readonly journal: I2JournalPort;
  readonly plans: InspectionPlans;
  readonly checkpoints: InspectionCheckpoints;
  readonly clock: InspectionTurnBoundaryDependencies['clock'];
}): {
  readonly helpers: InspectionRuntimeHelpers;
  readonly boundary: InspectionTurnBoundary;
  readonly stop: RuntimeInspectionStopSettlementPort;
} {
  const helpers = createInspectionRuntimeHelpers({
    resources: input.resources,
    journal: input.journal,
    plans: input.plans,
    checkpoints: input.checkpoints,
    acceptedCheck: createInspectionAcceptedCheckPort({ journal: input.journal }),
    clock: input.clock,
  });
  const boundary = new InspectionTurnBoundary({
    selectionReader: helpers.selectionReader,
    journal: input.journal,
    occurrenceOpening: helpers.occurrenceOpening,
    acceptedDeliveryReader: helpers.acceptedDeliveryReader,
    acceptedDelivery: helpers.acceptedDelivery,
    occurrences: helpers.occurrences,
    checkpoints: input.checkpoints,
    clock: input.clock,
  });
  return {
    helpers,
    boundary,
    stop: createRuntimeInspectionStopSettlementPort({
      boundary,
      occurrences: helpers.occurrences,
    }),
  };
}
/**
 * Bind the Runtime-owned stop port to one committed checkpoint at a time. The
 * checkpoint scope selects the exact Task identity and physical readers; the
 * App neither keeps a latest-task pointer nor chooses an occurrence/outcome.
 */
export function createProductionInspectionStopPort(input: {
  readonly journal: JsonlOrganJournal;
  readonly journalPath: string;
  readonly artifactRoot: string;
  readonly taskIdentity: InspectionTaskIdentity;
  readonly i2Journal: I2JournalPort;
  readonly plans: InspectionPlans;
  readonly checkpoints: InspectionCheckpoints;
  readonly clock: InspectionTurnBoundaryDependencies['clock'];
}): RuntimeInspectionStopSettlementPort {
  const ports = new Map<string, ReturnType<typeof createProductionInspectionPorts>['stop']>();

  async function forCheckpoint(checkpoint: CommittedCheckpointRecord) {
    const taskId = checkpoint.checkpoint.scope.taskId;
    if (taskId === undefined) {
      throw new Error('inspection stop checkpoint has no exact task scope');
    }
    const scope: TaskIdentityScope = { organId: checkpoint.checkpoint.scope.organId, taskId };
    const key = `${scope.organId.scope}:${scope.organId.value}:${scope.taskId.scope}:${scope.taskId.value}`;
    const existing = ports.get(key);
    if (existing !== undefined) return existing;
    const created = createProductionInspectionPorts({
      resources: {
        ...createInspectionTurnResourceReader({
          filePath: input.journalPath,
          journal: input.journal,
          artifactRoot: input.artifactRoot,
          taskIdentity: input.taskIdentity,
          scope,
        }),
        ...createInspectionStopResourceReader({
          journal: input.journal,
          journalPath: input.journalPath,
          assetRoot: input.artifactRoot,
        }),
      },
      journal: input.i2Journal,
      plans: input.plans,
      checkpoints: input.checkpoints,
      clock: input.clock,
    }).stop;
    ports.set(key, created);
    return created;
  }

  return {
    async settleStop({ checkpoint }) {
      return (await forCheckpoint(checkpoint)).settleStop({ checkpoint });
    },
    async readStopCompletion({ checkpoint }) {
      return (await forCheckpoint(checkpoint)).readStopCompletion({ checkpoint });
    },
  };
}
