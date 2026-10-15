import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DraftRevisionError,
  assertDraftRevisionCurrent,
  createDraftRevision,
  draftRevisionDiff,
  refineDraftRevision,
} from '../../packages/core/src/index.js';
import {
  TaskFlowIdentityConflictError,
  assertTaskFlowBindingCompatible,
} from '../../packages/core/src/task-flow.js';
import { id, type DraftRevisionInput, type TaskFlowBinding } from '../../packages/contracts/src/index.js';

const taskId = id('task', 'task-a');
const oneShot: TaskFlowBinding = { kind: 'one-shot', definitionVersion: 1 };
const inspection: TaskFlowBinding = { kind: 'inspection', definitionVersion: 1 };

function create(taskFlow?: TaskFlowBinding) {
  return createDraftRevision({
    draftId: 'draft-a',
    inputRevision: 1,
    goal: 'inspect a service',
    scope: 'service health',
    normalizedInput: 'inspect a service',
    proposedIntent: 'create',
    proposal: 'Create a task',
    immutableOriginalRef: 'input-a',
    ...(taskFlow === undefined ? {} : { taskFlow }),
  });
}

function refinement(current: ReturnType<typeof create>, fields: Readonly<Record<string, unknown>>): DraftRevisionInput {
  return {
    draftId: current.draftId,
    baseRevisionVersion: current.revisionVersion,
    requestedRevisionHash: current.revisionHash,
    fields,
    instructionRef: 'instruction-a',
    idempotencyKey: `refine-${current.revisionVersion}`,
  };
}

test('task flow is part of confirmation hash and changing it stales the prior confirmation', () => {
  const initial = create(oneShot);
  const revised = refineDraftRevision(initial, refinement(initial, { taskFlow: inspection }));

  assert.notEqual(revised.revisionHash, initial.revisionHash);
  assert.deepEqual(draftRevisionDiff(initial, revised), ['taskFlow']);
  let staleError: unknown;
  try {
    assertDraftRevisionCurrent(revised, { revisionVersion: revised.revisionVersion, revisionHash: initial.revisionHash });
  } catch (error) {
    staleError = error;
  }
  assert.equal(staleError instanceof DraftRevisionError, true);
  assert.equal((staleError as DraftRevisionError).code, 'confirmation-stale');
});

test('same task identity accepts the same binding and rejects a conflicting or newly inferred binding', () => {
  assert.doesNotThrow(() => assertTaskFlowBindingCompatible(taskId, oneShot, { ...oneShot }));
  assert.throws(
    () => assertTaskFlowBindingCompatible(taskId, oneShot, inspection),
    TaskFlowIdentityConflictError,
  );
  assert.throws(
    () => assertTaskFlowBindingCompatible(taskId, undefined, oneShot),
    TaskFlowIdentityConflictError,
  );
});

test('drafts without a task flow stay undeclared and are not defaulted', () => {
  const legacy = create();
  assert.equal(Object.hasOwn(legacy, 'taskFlow'), false);
  assert.equal(legacy.taskFlow, undefined);
});
