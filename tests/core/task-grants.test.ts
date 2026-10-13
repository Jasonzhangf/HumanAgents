import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTaskGrantIntent,
  grantCheckpointControl,
  revokeCheckpointControl,
  validateTaskGrantAdmission,
  validateTaskGrantSnapshot,
  type TaskBusinessAdmission,
  type TaskGrantDecision,
} from '../../packages/core/src/task-controls.js';
import type {
  CheckpointControlBusinessRequest,
  CheckpointControlCapabilityRef,
  CheckpointControlGrant,
  CheckpointControlGrantRequest,
  CheckpointControlIntentConfirmation,
  CheckpointControlRevokeRequest,
} from '../../packages/contracts/src/checkpoint-controls.js';
import { id } from '../../packages/contracts/src/index.js';

const organId = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const taskIdB = id('task', 'task-b');
const scope = { organId, taskId };
const capability: CheckpointControlCapabilityRef = {
  actionId: 'checkpoint.save',
  capabilities: ['checkpoint.save'],
  scope,
};

const confirmation: CheckpointControlIntentConfirmation = {
  confirmationId: 'confirm-a',
  taskId,
  inputIdentity: { requestRef: 'request-a', digest: 'sha256:request-a' },
  confirmedBy: 'user-a',
};

const grantRequest: CheckpointControlGrantRequest = {
  requestId: 'grant-request-a',
  taskId,
  owner: 'owner-a',
  capability,
  expectedRevision: 0,
};

const revokeRequest: CheckpointControlRevokeRequest = {
  requestId: 'revoke-request-a',
  taskId,
  owner: 'owner-a',
  expectedRevision: 1,
};

const businessRequest: CheckpointControlBusinessRequest = {
  requestRef: 'business-a',
  taskId,
  owner: 'owner-a',
  capability,
  inputIdentity: { requestRef: 'request-a', digest: 'sha256:request-a' },
};

const currentGrant: CheckpointControlGrant = {
  revision: 1,
  requestId: 'grant-request-a',
  task: taskId,
  owner: 'owner-a',
  capability,
  state: 'granted',
  updatedAt: '2026-10-12T00:00:00.000Z',
};

function assertDenied(decision: TaskBusinessAdmission, reason: string): void {
  assert.equal(decision.allowed, false);
  assert.equal(decision.outcome, 'business-denied');
  assert.equal(decision.outcome === 'business-denied' ? decision.reason : '', reason);
}

test('intent confirmation creates no grant and missing grant denies new business', () => {
  const intent = classifyTaskGrantIntent(confirmation);
  assert.deepEqual(intent, {
    outcome: 'intent-confirmed-only',
    taskId,
    createsGrant: false,
  });
  assertDenied(validateTaskGrantAdmission({ request: businessRequest, current: null }), 'missing-grant');
});

test('grant and revoke revisions are monotonic; stale commands do not advance authority', () => {
  const granted = grantCheckpointControl({ request: grantRequest, updatedAt: '2026-10-12T00:00:00.000Z' });
  assert.equal(granted.outcome, 'granted');
  assert.equal(granted.outcome === 'granted' ? granted.grant.revision : -1, 1);
  assert.equal(granted.outcome === 'granted' ? granted.grant.state : '', 'granted');

  const staleGrant = grantCheckpointControl({
    request: { ...grantRequest, requestId: 'grant-request-b', expectedRevision: 0 },
    current: currentGrant,
    updatedAt: '2026-10-12T00:00:01.000Z',
  });
  assert.deepEqual(staleGrant, { outcome: 'denied', reason: 'stale-revision' });

  const revoked = revokeCheckpointControl({
    request: revokeRequest,
    current: currentGrant,
    updatedAt: '2026-10-12T00:00:02.000Z',
  });
  assert.equal(revoked.outcome, 'revoked');
  assert.equal(revoked.outcome === 'revoked' ? revoked.grant.state : '', 'revoked');
  assert.equal(revoked.outcome === 'revoked' ? revoked.grant.revision : -1, 2);

  const staleRevoke = revokeCheckpointControl({
    request: { ...revokeRequest, requestId: 'revoke-request-b', expectedRevision: 1 },
    current: revoked.outcome === 'revoked' ? revoked.grant : currentGrant,
    updatedAt: '2026-10-12T00:00:03.000Z',
  });
  assert.deepEqual(staleRevoke, { outcome: 'denied', reason: 'revoked' });
});

test('identical grant/revoke retries return the first result; same-revision conflicting intent is rejected', () => {
  const retried = grantCheckpointControl({
    request: grantRequest,
    current: currentGrant,
    updatedAt: '2026-10-12T00:00:01.000Z',
  });
  assert.equal(retried.outcome, 'replayed');
  assert.equal(retried.outcome === 'replayed' ? retried.grant : null, currentGrant);

  const conflicting = grantCheckpointControl({
    request: { ...grantRequest, owner: 'other-owner' },
    current: currentGrant,
    updatedAt: '2026-10-12T00:00:01.000Z',
  });
  assert.deepEqual(conflicting, { outcome: 'denied', reason: 'conflicting-intent' });

  const revoked: TaskGrantDecision = revokeCheckpointControl({
    request: revokeRequest,
    current: currentGrant,
    updatedAt: '2026-10-12T00:00:02.000Z',
  });
  assert.equal(revoked.outcome, 'revoked');
  if (revoked.outcome !== 'revoked') throw new Error('unreachable');
  const revokeRetried = revokeCheckpointControl({
    request: revokeRequest,
    current: revoked.grant,
    updatedAt: '2026-10-12T00:00:03.000Z',
  });
  assert.equal(revokeRetried.outcome, 'replayed');
});

test('new business denies revoked, stale, wrong task, scope, action, capability and owner authority', () => {
  const revokedGrant: CheckpointControlGrant = { ...currentGrant, revision: 2, state: 'revoked', updatedAt: '2026-10-12T00:01:00.000Z' };
  assertDenied(validateTaskGrantAdmission({ request: businessRequest, current: revokedGrant }), 'revoked');
  assertDenied(validateTaskGrantAdmission({
    request: { ...businessRequest, taskId: taskIdB, capability: { ...capability, scope: { organId, taskId: taskIdB } } },
    current: currentGrant,
  }), 'wrong-task');
  assertDenied(validateTaskGrantAdmission({
    request: { ...businessRequest, capability: { ...capability, scope: { organId: id('organ', 'organ-b'), taskId } } },
    current: currentGrant,
  }), 'wrong-scope');
  assertDenied(validateTaskGrantAdmission({
    request: { ...businessRequest, capability: { ...capability, actionId: 'action.read' } },
    current: currentGrant,
  }), 'wrong-action');
  assertDenied(validateTaskGrantAdmission({
    request: { ...businessRequest, capability: { ...capability, capabilities: ['checkpoint.read'] } },
    current: currentGrant,
  }), 'wrong-capability');
  assertDenied(validateTaskGrantAdmission({ request: { ...businessRequest, owner: 'other-owner' }, current: currentGrant }), 'wrong-owner');

  const admitted = validateTaskGrantAdmission({ request: businessRequest, current: currentGrant });
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.outcome, 'business-admitted');
  if (admitted.outcome !== 'business-admitted') throw new Error('expected business-admitted');
  assert.equal(admitted.grantRevision, 1);
  assert.equal(admitted.grantRevisionString, '1');
  assert.equal(admitted.grantOwner, 'owner-a');
});

test('unknown current grant is a hold, not absence or cache permission', () => {
  assertDenied(validateTaskGrantAdmission({ request: businessRequest, current: undefined }), 'current-unknown');
});

test('authority snapshot requires an active grant owned by the verified principal', () => {
  const authority = validateTaskGrantSnapshot({ grant: currentGrant, principalOwner: 'owner-a' });
  assert.equal(authority.grant, currentGrant);
  assert.equal(authority.permissionRevision, '1');
  assert.throws(() => validateTaskGrantSnapshot({ grant: currentGrant, principalOwner: 'other-owner' }));
  assert.throws(() => validateTaskGrantSnapshot({ grant: null, principalOwner: 'owner-a' }));
  assert.throws(() => validateTaskGrantSnapshot({
    grant: { ...currentGrant, state: 'revoked' },
    principalOwner: 'owner-a',
  }));
});
