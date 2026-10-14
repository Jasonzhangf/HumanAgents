import {
  validateTaskIdentityScope,
  type ScopeRef,
  type TaskFlowBinding,
  type TaskIdentityAppendInput,
  type TaskIdentityRecord,
} from '../../../contracts/src/index.js';
import {
  assertTaskFlowBindingCompatible,
  validateTaskIdentityRecord,
} from '../../../core/src/index.js';

export interface TaskIdentityPort {
  append(input: TaskIdentityAppendInput): Promise<TaskIdentityRecord>;
  replay(scope?: ScopeRef): Promise<readonly TaskIdentityRecord[]>;
}

function sameTaskScope(scope: TaskIdentityRecord['scope'], filter: ScopeRef): boolean {
  return scope.organId.scope === filter.organId.scope
    && scope.organId.value === filter.organId.value
    && (!filter.taskId || (scope.taskId.scope === filter.taskId.scope && scope.taskId.value === filter.taskId.value));
}

/** Read-only compatibility surface for existing tasks. It never establishes identity. */
export class TaskIdentityConsumer {
  constructor(private readonly journal: TaskIdentityPort) {}

  async establish(input: TaskIdentityAppendInput): Promise<TaskIdentityRecord> {
    return this.journal.append(input);
  }

  async read(scope: ScopeRef): Promise<TaskIdentityRecord | undefined> {
    const taskScope = scope as TaskIdentityRecord['scope'];
    validateTaskIdentityScope(taskScope);
    const identities = await this.journal.replay(scope);
    const identity = identities.find((candidate) => sameTaskScope(candidate.scope, taskScope));
    if (identity !== undefined) validateTaskIdentityRecord(identity);
    return identity;
  }

  async assertCompatible(
    scope: ScopeRef,
    incomingBinding?: TaskFlowBinding,
  ): Promise<TaskIdentityRecord | undefined> {
    const existing = await this.read(scope);
    if (existing === undefined) {
      const taskScope = scope as TaskIdentityRecord['scope'];
      validateTaskIdentityScope(taskScope);
      assertTaskFlowBindingCompatible(taskScope.taskId, undefined, incomingBinding);
      return undefined;
    }
    assertTaskFlowBindingCompatible(existing.scope.taskId, existing.taskFlow, incomingBinding);
    return existing;
  }
}
