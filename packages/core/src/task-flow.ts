import {
  canonicalJsonStringify,
  validateTaskFlowBinding,
  type TaskFlowBinding,
  type TaskId,
} from '../../contracts/src/index.js';
import { CoreError } from './errors.js';

export class TaskFlowIdentityConflictError extends CoreError {
  readonly taskId: TaskId;

  constructor(taskId: TaskId) {
    super(`task ${taskId.value} already has a different task flow binding`);
    this.name = 'TaskFlowIdentityConflictError';
    this.taskId = taskId;
  }
}

/**
 * A task identity may be replayed with the same binding, but never rebound.
 * Missing legacy bindings compare as an undeclared value and stay missing.
 */
export function assertTaskFlowBindingCompatible(
  taskId: TaskId,
  existing: TaskFlowBinding | undefined,
  incoming: TaskFlowBinding | undefined,
): void {
  if (existing !== undefined) validateTaskFlowBinding(existing);
  if (incoming !== undefined) validateTaskFlowBinding(incoming);
  if (canonicalJsonStringify(existing ?? null) !== canonicalJsonStringify(incoming ?? null)) {
    throw new TaskFlowIdentityConflictError(taskId);
  }
}

