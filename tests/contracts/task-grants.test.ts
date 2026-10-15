import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError } from '../../packages/contracts/src/errors.js';
import {
  validateCheckpointControlBusinessRequest,
  validateCheckpointControlCapabilityRef,
  validateCheckpointControlGrant,
  validateCheckpointControlGrantRequest,
  validateCheckpointControlIntentConfirmation,
  validateCheckpointControlRevokeRequest,
  type CheckpointControlGrant,
} from '../../packages/contracts/src/checkpoint-controls.js';
import { id } from '../../packages/contracts/src/index.js';

const organId = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const taskIdB = id('task', 'task-b');
const scope = { organId, taskId };
const capability = {
  actionId: 'checkpoint.save',
  capabilities: ['checkpoint.save'],
  scope,
} as const;

const grantRequest = {
  requestId: 'grant-request-a',
  taskId,
  owner: 'owner-a',
  capability,
  expectedRevision: 0,
} as const;

const grant: CheckpointControlGrant = {
  revision: 1,
  requestId: 'grant-request-a',
  task: taskId,
  owner: 'owner-a',
  capability,
  state: 'granted',
  updatedAt: '2026-10-12T00:00:00.000Z',
};

test('intent confirmation and grant/business requests validate their structural invariants', () => {
  assert.doesNotThrow(() => validateCheckpointControlCapabilityRef(capability));
  assert.doesNotThrow(() => validateCheckpointControlIntentConfirmation({
    confirmationId: 'confirm-a',
    taskId,
    inputIdentity: { requestRef: 'request-a', digest: 'sha256:request-a' },
    confirmedBy: 'user-a',
  }));
  assert.doesNotThrow(() => validateCheckpointControlGrantRequest(grantRequest));
  assert.doesNotThrow(() => validateCheckpointControlRevokeRequest({
    requestId: 'revoke-request-a',
    taskId,
    owner: 'owner-a',
    expectedRevision: 1,
  }));
  assert.doesNotThrow(() => validateCheckpointControlBusinessRequest({
    requestRef: 'business-a',
    taskId,
    owner: 'owner-a',
    capability,
    inputIdentity: { requestRef: 'request-a', digest: 'sha256:request-a' },
  }));
  assert.doesNotThrow(() => validateCheckpointControlGrant(grant));
});

test('capability and grant scope must be task-scoped and match the declared task', () => {
  assert.throws(() => validateCheckpointControlCapabilityRef({
    ...capability,
    scope: { organId },
  }), ContractError);
  assert.throws(() => validateCheckpointControlCapabilityRef({
    ...capability,
    capabilities: [],
  }), ContractError);
  assert.throws(() => validateCheckpointControlGrantRequest({
    ...grantRequest,
    capability: { ...capability, scope: { organId, taskId: taskIdB } },
  }), ContractError);
  assert.throws(() => validateCheckpointControlBusinessRequest({
    requestRef: 'business-a',
    taskId: taskIdB,
    owner: 'owner-a',
    capability,
    inputIdentity: { requestRef: 'request-a', digest: 'sha256:request-a' },
  }), ContractError);
});

test('a grant without its exact commit stays a valid structural fact and rejects bad state or timestamps', () => {
  // The structural grant carries no commit: the exact Journal commit is a
  // Runtime readback concern, so a grant-shaped value must not smuggle one.
  assert.equal(Object.hasOwn(grant, 'commit'), false);
  assert.throws(() => validateCheckpointControlGrant({ ...grant, state: 'paused' as never }), ContractError);
  assert.throws(() => validateCheckpointControlGrant({ ...grant, updatedAt: 'not-a-time' }), ContractError);
  assert.throws(() => validateCheckpointControlGrant({ ...grant, revision: -1 }), ContractError);
});
