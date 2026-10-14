import {
  canonicalJsonStringify,
  validateTaskIdentityAppendInput,
  validateTaskIdentityRecord,
  type TaskIdentityAppendInput,
  type TaskIdentityRecord,
} from '../../contracts/src/index.js';
import { CoreError } from './errors.js';
import { assertTaskFlowBindingCompatible } from './task-flow.js';

export { validateTaskIdentityAppendInput, validateTaskIdentityRecord } from '../../contracts/src/index.js';

export class TaskIdentityConflictError extends CoreError {
  readonly scope: TaskIdentityRecord['scope'];

  constructor(scope: TaskIdentityRecord['scope'], message = 'task identity is immutable') {
    super(`${message} for ${scope.organId.value}/${scope.taskId.value}`);
    this.name = 'TaskIdentityConflictError';
    this.scope = scope;
  }
}

function establishmentFact(identity: TaskIdentityAppendInput): unknown {
  return {
    scope: identity.scope,
    taskFlow: identity.taskFlow ?? null,
    source: identity.source,
  };
}

export function assertTaskIdentityEstablishmentMatches(
  existing: TaskIdentityRecord,
  retry: TaskIdentityAppendInput,
): void {
  validateTaskIdentityRecord(existing);
  validateTaskIdentityAppendInput(retry);
  assertTaskFlowBindingCompatible(existing.scope.taskId, existing.taskFlow, retry.taskFlow);
  if (canonicalJsonStringify(establishmentFact(existing)) !== canonicalJsonStringify(establishmentFact(retry))) {
    throw new TaskIdentityConflictError(existing.scope, 'task identity establishment retry conflicts with committed identity');
  }
}

export function createTaskIdentityRecord(
  input: TaskIdentityAppendInput,
  journalCommitRef: string,
): TaskIdentityRecord {
  validateTaskIdentityAppendInput(input);
  const record: TaskIdentityRecord = { ...input, journalCommitRef };
  validateTaskIdentityRecord(record);
  return record;
}
