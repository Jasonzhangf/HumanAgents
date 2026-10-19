import { assertScope, type ScopeRef } from './index.js';
import { ContractError } from './errors.js';
import { validateTaskFlowBinding, type TaskFlowBinding } from './task-flow.js';
import type { TaskPlanInputSource } from './task-plan-revision.js';

export type TaskIdentityScope = ScopeRef & {
  readonly taskId: NonNullable<ScopeRef['taskId']>;
};

export type TaskIdentitySource = Pick<
  TaskPlanInputSource,
  | 'requirementId'
  | 'inputRevision'
  | 'draftId'
  | 'draftRevisionVersion'
  | 'draftRevisionHash'
  | 'confirmationRef'
>;

export interface TaskIdentityRecord {
  readonly scope: TaskIdentityScope;
  readonly taskFlow?: TaskFlowBinding;
  readonly title?: string;
  readonly source: TaskIdentitySource;
  readonly journalCommitRef: string;
}

export type TaskIdentityAppendInput = Omit<TaskIdentityRecord, 'journalCommitRef'>;

const IDENTITY_KEYS = new Set(['scope', 'taskFlow', 'title', 'source', 'journalCommitRef']);
const SOURCE_KEYS = new Set([
  'requirementId',
  'inputRevision',
  'draftId',
  'draftRevisionVersion',
  'draftRevisionHash',
  'confirmationRef',
]);

function requireObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError(`${label} must be an object`);
  }
}

function requireOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new ContractError(`${label} does not accept ${key}`);
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function requirePositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

function validateTaskIdentityBinding(binding: TaskFlowBinding): void {
  validateTaskFlowBinding(binding);
  for (const key of Object.keys(binding)) {
    if (key !== 'kind' && key !== 'definitionVersion') {
      throw new ContractError(`task identity taskFlow does not accept ${key}`);
    }
  }
}

export function validateTaskIdentityScope(scope: TaskIdentityScope): void {
  requireObject(scope, 'task identity scope');
  requireOnlyKeys(scope, new Set(['organId', 'taskId']), 'task identity scope');
  assertScope(scope.organId, 'organ');
  assertScope(scope.taskId, 'task');
  requireText(scope.organId.value, 'task identity organId');
  requireText(scope.taskId.value, 'task identity taskId');
}

export function validateTaskIdentitySource(source: TaskIdentitySource): void {
  requireObject(source, 'task identity source');
  requireOnlyKeys(source, SOURCE_KEYS, 'task identity source');
  requireText(source.requirementId, 'task identity requirementId');
  requirePositiveInteger(source.inputRevision, 'task identity inputRevision');
  requireText(source.draftId, 'task identity draftId');
  requirePositiveInteger(source.draftRevisionVersion, 'task identity draftRevisionVersion');
  requireText(source.draftRevisionHash, 'task identity draftRevisionHash');
  requireText(source.confirmationRef, 'task identity confirmationRef');
}

export function validateTaskIdentityAppendInput(input: TaskIdentityAppendInput): void {
  requireObject(input, 'task identity input');
  requireOnlyKeys(input, new Set(['scope', 'taskFlow', 'title', 'source']), 'task identity input');
  validateTaskIdentityScope(input.scope);
  if (input.taskFlow !== undefined) validateTaskIdentityBinding(input.taskFlow);
  if (input.title !== undefined) requireText(input.title, 'task identity title');
  validateTaskIdentitySource(input.source);
}

export function validateTaskIdentityRecord(record: TaskIdentityRecord): void {
  requireObject(record, 'task identity record');
  requireOnlyKeys(record, IDENTITY_KEYS, 'task identity record');
  validateTaskIdentityAppendInput({
    scope: record.scope,
    taskFlow: record.taskFlow,
    title: record.title,
    source: record.source,
  });
  requireText(record.journalCommitRef, 'task identity journalCommitRef');
}
