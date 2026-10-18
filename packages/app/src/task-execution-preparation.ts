import {
  RuntimeTaskCoordinator,
  type RuntimeExecutionAllocation,
  type RuntimeTaskJournalPort,
} from '../../runtime/src/ui-runtime/coordinator.js';
import { readPreparedExecutionInput } from './prepared-execution-input.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from './runtime-current-state-journal.js';
import { createDefaultExecutionComposition } from './ui-runtime/execution-composition.js';

/**
 * The exact prepared-execution handle the thin consumer returns: the actual
 * coordinator allocation, the immutable admitted input read from the same
 * prepared Journal, and the release closure that delegates back to the
 * coordinator's own public release method. Every field is typed from the
 * actual owner, so no parallel DTO hierarchy can drift from the runtime.
 */
export type PreparedExecutionHandle = {
  readonly allocation: RuntimeExecutionAllocation;
  readonly input: ReturnType<typeof readPreparedExecutionInput>;
  readonly release: () => ReturnType<RuntimeTaskCoordinator['releaseExecution']>;
};

type PrepareExecutionArgs = Parameters<RuntimeTaskCoordinator['prepareExecution']>;

type CompositionInput = Parameters<typeof createDefaultExecutionComposition>[0];
type CoordinatorInput = ConstructorParameters<typeof RuntimeTaskCoordinator>[0];

/**
 * The preparation handle the CLI caller consumes: the exact prepared-execution
 * consumer plus a narrow typed access to the same coordinator instance for Task
 * selection and completion readback. `Pick` exposes only the read/subscribe
 * surface; `createTask`, grant, stop and a second release stay unexposed, so the
 * caller cannot mint identity or re-drive the execution through this handle.
 */
export type TaskExecutionPreparation =
  ReturnType<typeof createPreparedExecutionConsumer> & {
    readonly coordinator: Pick<
      RuntimeTaskCoordinator,
      'taskSnapshots' | 'taskSnapshot' | 'subscribeReplay'
    >;
  };

export type TaskExecutionPreparationInput = {
  readonly principalOwner: CompositionInput['principalOwner'];
  readonly composition: Omit<
    CompositionInput,
    'principalOwner' | 'currentState' | 'publishCurrentTurnState' | 'closedTurnPlannerPool'
  >;
  readonly coordinator: Omit<
    CoordinatorInput,
    | 'journal'
    | 'admitExecution'
    | 'createDriver'
    | 'currentStatePort'
    | 'currentStateFacts'
  >;
};

/** Bind production owners once; execution stays behind the original release edge. */
export function createTaskExecutionPreparation(
  input: TaskExecutionPreparationInput,
): TaskExecutionPreparation {
  const currentState = createJsonlRuntimeTaskCurrentStateJournal({
    journal: input.composition.journal,
  });
  const composition = createDefaultExecutionComposition({
    ...input.composition,
    principalOwner: input.principalOwner,
    currentState,
    publishCurrentTurnState: (taskId) => coordinator.publishCurrentTurnState(taskId),
    closedTurnPlannerPool: (taskId) => coordinator.closedTurnPlannerPool(taskId),
  });
  const coordinator = new RuntimeTaskCoordinator({
    ...input.coordinator,
    journal: input.composition.preparedJournal,
    currentStatePort: currentState,
    currentStateFacts: composition.currentStateFacts,
    admitExecution: composition.admitExecution,
    createDriver: composition.createExecutionDriver,
  });
  return {
    ...createPreparedExecutionConsumer({
      coordinator,
      preparedJournal: input.composition.preparedJournal,
    }),
    coordinator,
  };
}

/**
 * Binds one actual coordinator to the same prepared Journal. `prepareRun`
 * allocates through the coordinator and reads the immutable prepared input
 * through the app-owned reader. It performs no admission, driver construction,
 * Provider selection, generation or tool IO; those stay with the coordinator's
 * own release path, which `release` calls exactly once per prepared execution.
 */
export function createPreparedExecutionConsumer(input: {
  readonly coordinator: Pick<
    RuntimeTaskCoordinator,
    'prepareExecution' | 'releaseExecution'
  >;
  readonly preparedJournal: RuntimeTaskJournalPort;
}): {
  prepareRun(...args: PrepareExecutionArgs): PreparedExecutionHandle;
} {
  return {
    prepareRun(...args: PrepareExecutionArgs): PreparedExecutionHandle {
      const allocation = input.coordinator.prepareExecution(...args);
      const preparedInput = readPreparedExecutionInput(
        input.preparedJournal,
        allocation,
      );
      return {
        allocation,
        input: preparedInput,
        release: () =>
          input.coordinator.releaseExecution(
            allocation.taskId,
            allocation.operationId,
          ),
      };
    },
  };
}
