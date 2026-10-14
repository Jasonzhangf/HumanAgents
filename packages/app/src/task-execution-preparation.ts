import type {
  RuntimeExecutionAllocation,
  RuntimeTaskCoordinator,
  RuntimeTaskJournalPort,
} from '../../runtime/src/ui-runtime/coordinator.js';
import { readPreparedExecutionInput } from './prepared-execution-input.js';

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
