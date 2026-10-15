import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CheckpointControlBusinessRequest,
  CheckpointControlCapabilityRef,
  CheckpointControlGrant,
} from '../../../packages/contracts/src/checkpoint-controls.js';
import { id } from '../../../packages/contracts/src/index.js';
import {
  decideTaskGrantAdmission,
  projectTaskGrantAuthority,
  type TaskGrantAuthority,
} from '../../../packages/runtime/src/admission/task-grant.js';

const organId = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const scope = { organId, taskId };
const capability: CheckpointControlCapabilityRef = {
  actionId: 'checkpoint.save',
  capabilities: ['checkpoint.save'],
  scope,
};
const grant: CheckpointControlGrant = {
  revision: 1,
  requestId: 'grant-request-a',
  task: taskId,
  owner: 'owner-a',
  capability,
  state: 'granted',
  updatedAt: '2026-10-12T00:00:00.000Z',
};
const commit = { commitId: 'task-grant:v1:abc', journalSeq: 7, recordDigest: 'sha256:def' } as const;
const businessRequest: CheckpointControlBusinessRequest = {
  requestRef: 'business-a',
  taskId,
  owner: 'owner-a',
  capability,
  inputIdentity: { requestRef: 'request-a', digest: 'sha256:request-a' },
};

test('a cache-free readback maps to actual owner and String(revision) authority', () => {
  const authority: TaskGrantAuthority = projectTaskGrantAuthority({
    readback: { grant, commit },
    principalOwner: 'owner-a',
  });
  assert.equal(authority.owner, 'owner-a');
  assert.equal(authority.permissionRevision, '1');
  assert.equal(authority.commit, commit);
  assert.equal(authority.grant.revision, 1);
  assert.throws(() => projectTaskGrantAuthority({ readback: { grant, commit }, principalOwner: 'other-owner' }));
});

test('readback must pair grant and commit; missing readback is a current-unknown hold', () => {
  assert.throws(() => projectTaskGrantAuthority({ readback: { grant: null, commit }, principalOwner: 'owner-a' }));
  assert.throws(() => projectTaskGrantAuthority({
    readback: { grant, commit: null },
    principalOwner: 'owner-a',
  }));
  const unknown = decideTaskGrantAdmission({ request: businessRequest, readback: undefined });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.outcome, 'business-denied');
});

test('new-business admission uses only the exact current readback and stays denied after revoke', () => {
  const admitted = decideTaskGrantAdmission({ request: businessRequest, readback: { grant, commit } });
  assert.equal(admitted.allowed, true);
  if (admitted.outcome !== 'business-admitted') throw new Error('expected admission');
  assert.equal(admitted.grantOwner, 'owner-a');
  assert.equal(admitted.grantRevisionString, '1');

  const denied = decideTaskGrantAdmission({
    request: businessRequest,
    readback: { grant: { ...grant, revision: 2, state: 'revoked' }, commit: { ...commit, commitId: 'revoke-commit' } },
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.outcome, 'business-denied');
});
