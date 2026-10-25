/// <reference path="./node-modules.d.ts" />
import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  validateTaskIdentityAppendInput,
  validateTaskIdentityRecord,
  type TaskIdentityAppendInput,
  type TaskIdentityRecord,
  type TaskIdentitySource,
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

/**
 * The confirmed source of a Task the human created directly through the public
 * new-task entry, with no explicit-Brain draft behind it.
 *
 * The project rule is that submitting the new-task form is the user's
 * confirmation for the new Task. The confirmed requirement revision is therefore
 * the committed create input at its own directive revision: the requirement,
 * draft and confirmation identifiers name that one confirmed create submission,
 * and the revision hash digests the exact submitted title and directive, so the
 * binding can be re-derived from the committed task input instead of trusting a
 * stored copy. Nothing here claims an explicit-Brain draft revision that does
 * not exist.
 */
export interface DirectTaskCreateInput {
  readonly taskId: string;
  readonly title: string;
  readonly directive: string;
  readonly directiveRevision: number;
}

export function directTaskCreateIdentitySource(input: DirectTaskCreateInput): TaskIdentitySource {
  if (input.taskId.trim().length === 0) {
    throw new CoreError('direct task create identity requires the created Task identity');
  }
  if (input.directive.trim().length === 0) {
    throw new CoreError('direct task create identity requires the confirmed task directive');
  }
  const revision = input.directiveRevision;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new CoreError(`direct task create identity requires a positive directive revision, received ${String(revision)}`);
  }
  const locator = `${input.taskId}@${revision}`;
  return {
    requirementId: `requirement:direct-task-create:${locator}`,
    inputRevision: revision,
    draftId: `draft:direct-task-create:${locator}`,
    draftRevisionVersion: revision,
    draftRevisionHash: `sha256:${createHash('sha256')
      .update(canonicalJsonStringify({ kind: 'direct-task-create-input.v1', title: input.title, directive: input.directive }))
      .digest('hex')}`,
    confirmationRef: `confirmation:direct-task-create:${locator}`,
  };
}
