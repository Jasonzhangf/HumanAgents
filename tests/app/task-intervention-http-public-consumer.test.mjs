import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRuntimeApi } from '../../docs/ui/runtime-api.js';
import { id } from '../../dist/app/contracts/src/index.js';
import { UiRuntimeApiError } from '../../dist/app/app/src/ui-runtime/errors.js';
import { AccessControlService } from '../../dist/app/app/src/ui-runtime/access-control.js';
import { createUiRuntimeRequestDispatcher } from '../../dist/app/app/src/ui-runtime/server.js';

const scope = { projectKey: 'project-a', mode: 'fake' };

function captureApi() {
  const calls = [];
  const api = createRuntimeApi({
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? 'GET',
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
  });
  return { api, calls };
}

function writes(calls) {
  return calls.filter((call) => call.method !== 'GET');
}

// Same dispatcher as the TCP listener, without binding a socket. The worker
// sandbox denies listen(2); V still runs the real-loopback consumer after S.
function dispatch(listener, { method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.url = url;
    request.headers = headers;
    const chunks = [];
    const response = {
      status: undefined,
      writableEnded: false,
      writeHead(status) {
        this.status = status;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        this.writableEnded = true;
        resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') });
      },
    };
    try {
      listener(request, response);
    } catch (error) {
      reject(error);
    }
  });
}

test('formal intervention API maps approve/reject to grant/revoke and never forwards actor authority', async () => {
  const { api, calls } = captureApi();
  const forged = {
    requestId: 'request-grant',
    expectedRevision: 0,
    owner: 'forged-owner',
    principalOwner: 'forged-principal',
    confirmedBy: 'forged-owner',
    hasStopPermission: true,
    authority: { owner: 'forged-owner', grant: null },
  };

  const read = await api.readTaskDecision('task-1', scope);
  assert.deepEqual(read, { accepted: true });
  assert.equal(calls.at(-1).method, 'GET');
  assert.match(calls.at(-1).url, /\/api\/tasks\/task-1\/control\/grant\?projectKey=project-a&mode=fake$/);

  const approved = await api.interveneTask('task-1', {
    ...forged,
    action: 'grant',
    capability: { actionId: 'task.execute', capabilities: ['provider.execution'] },
  }, scope);
  assert.deepEqual(approved, { accepted: true });
  const grantCall = calls.at(-1);
  assert.equal(grantCall.method, 'POST');
  assert.match(grantCall.url, /\/api\/tasks\/task-1\/control\/grant\?projectKey=project-a&mode=fake$/);
  assert.deepEqual(grantCall.body, {
    requestId: 'request-grant',
    expectedRevision: 0,
    capability: { actionId: 'task.execute', capabilities: ['provider.execution'] },
  });

  const rejected = await api.interveneTask('task-1', {
    ...forged,
    action: 'revoke',
    requestId: 'request-revoke',
    expectedRevision: 1,
  }, scope);
  assert.deepEqual(rejected, { accepted: true });
  const revokeCall = calls.at(-1);
  assert.equal(revokeCall.method, 'POST');
  assert.match(revokeCall.url, /\/api\/tasks\/task-1\/control\/revoke\?projectKey=project-a&mode=fake$/);
  assert.deepEqual(revokeCall.body, { requestId: 'request-revoke', expectedRevision: 1 });

  await api.interveneTask('task-1', { action: 'stop', requestId: 'request-stop', owner: 'forged-owner' }, scope);
  const stopCall = calls.at(-1);
  assert.equal(stopCall.method, 'POST');
  assert.match(stopCall.url, /\/api\/tasks\/task-1\/stop\?projectKey=project-a&mode=fake$/);
  assert.equal(stopCall.body, undefined);

  assert.throws(
    () => api.interveneTask('task-1', { action: 'grant', requestId: 'missing-scope', expectedRevision: 0 }),
    TypeError,
  );
  await assert.rejects(
    () => api.interveneTask('task-1', { action: 'approve', requestId: 'not-a-server-action', expectedRevision: 0 }, scope),
    TypeError,
  );

  const writesBeforeReads = writes(calls).length;
  await api.readTaskDecision('task-1', scope);
  await api.taskDashboard('task-1');
  await api.taskDetail('task-1');
  assert.equal(writes(calls).length, writesBeforeReads,
    'closing or refreshing the pending decision must read only and issue zero decision writes');
});

test('stop and grant control derive the principal from the session and refuse a wrong target before any effect', async () => {
  const base = join(tmpdir(), 'humanagent-test-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'task-intervention-http-'));
  try {
    const accessControl = await AccessControlService.open({
      credentialPath: join(root, 'security', 'web-access.json'),
      create: true,
    });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0];
    const principalOwner = accessControl.readProductPrincipalOwner();

    const stops = [];
    const verifies = [];
    const releases = [];
    const grantInputs = [];
    const service = {
      async stop(taskId) {
        stops.push(taskId.value);
        return { state: 'settled', operationId: 'operation-stop-1' };
      },
      async verifyControllableTaskTarget(taskId, projectKey, mode) {
        verifies.push({ taskId: taskId.value, projectKey, mode });
        if (projectKey !== scope.projectKey || mode !== scope.mode) {
          throw new UiRuntimeApiError(
            'task-control.target.not-bound',
            'humanagent.app',
            `task control target ${projectKey}/${mode} is outside the serve-bound scope`,
            'open the formal task navigation for the active project and mode',
            409,
          );
        }
        return { projectKey: scope.projectKey, mode: scope.mode };
      },
      async releaseGrantedTaskExecution(taskId) {
        releases.push(taskId.value);
        return { state: 'released', current: { operationId: 'operation-grant-1', state: 'running' } };
      },
    };
    const taskControl = {
      async read(taskId, owner) {
        return {
          taskId,
          owner,
          readback: { grant: null, commit: null },
          authority: null,
          receivedAt: new Date().toISOString(),
        };
      },
      async grant(input) {
        grantInputs.push(input);
        return {
          taskId: input.taskId,
          owner: input.principalOwner,
          readback: {
            grant: { state: 'granted', owner: input.principalOwner, revision: 1 },
            commit: null,
          },
          authority: null,
          receivedAt: new Date().toISOString(),
        };
      },
      async revoke(input) {
        grantInputs.push(input);
        return {
          taskId: input.taskId,
          owner: input.principalOwner,
          readback: {
            grant: { state: 'revoked', owner: input.principalOwner, revision: 2 },
            commit: null,
          },
          authority: null,
          receivedAt: new Date().toISOString(),
        };
      },
    };
    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: root,
      uiRoot: root,
      isClosing: () => false,
      taskControl,
    });
    const origin = 'http://runtime.test';
    const api = createRuntimeApi({
      baseUrl: origin,
      fetchImpl: async (url, init = {}) => {
        const parsed = new URL(String(url));
        const headers = {};
        new Headers(init.headers || {}).forEach((value, key) => { headers[key] = value; });
        headers.cookie = cookie;
        headers.origin = origin;
        const result = await dispatch(listener, {
          method: init.method ?? 'GET',
          url: `${parsed.pathname}${parsed.search}`,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        });
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => (result.text ? JSON.parse(result.text) : {}),
          text: async () => result.text,
        };
      },
    });

    const unauthenticated = await dispatch(listener, {
      method: 'POST',
      url: '/api/tasks/task-a/stop',
      headers: { origin, 'content-type': 'application/json' },
      body: { owner: 'forged-owner' },
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(stops.length, 0);

    await assert.rejects(
      () => api.interveneTask('task-a', { action: 'stop' }, { projectKey: 'project-b', mode: 'fake' }),
      (error) => error?.status === 409 && error?.code === 'task-control.target.not-bound',
    );
    assert.deepEqual(verifies.at(-1), { taskId: 'task-a', projectKey: 'project-b', mode: 'fake' });
    assert.equal(stops.length, 0, 'a wrong stop target must not start a stop operation');

    const stopped = await api.interveneTask('task-a', {
      action: 'stop',
      requestId: 'stop-a',
      owner: 'forged-owner',
      authority: { owner: 'forged-owner' },
    }, scope);
    assert.equal(stopped.state, 'settled');
    assert.equal(stopped.operationId, 'operation-stop-1');
    assert.equal(stopped.principalOwner, principalOwner,
      'the server session principal is the only actor, even when the request body forges one');
    assert.deepEqual(stopped.targetScope, scope);
    assert.equal(stops.length, 1);
    assert.deepEqual(verifies.at(-1), { taskId: 'task-a', projectKey: scope.projectKey, mode: scope.mode });

    await assert.rejects(
      () => api.interveneTask('task-a', { action: 'grant', requestId: 'wrong-target-grant', expectedRevision: 0 },
        { projectKey: 'project-b', mode: 'fake' }),
      (error) => error?.status === 409 && error?.code === 'task-control.target.not-bound',
    );
    assert.equal(grantInputs.length, 0, 'a wrong grant target must not reach grant control');
    assert.equal(releases.length, 0, 'a wrong grant target must not release execution');

    const granted = await api.interveneTask('task-a', {
      action: 'grant',
      requestId: 'grant-a',
      expectedRevision: 0,
      owner: 'forged-owner',
      confirmedBy: 'forged-owner',
      hasStopPermission: true,
      authority: { owner: 'forged-owner' },
    }, scope);
    assert.equal(granted.owner, principalOwner);
    assert.equal(granted.readback.grant.state, 'granted');
    assert.equal(granted.readback.grant.owner, principalOwner);
    assert.equal(granted.execution.state, 'released');
    assert.equal(granted.execution.current.operationId, 'operation-grant-1');
    assert.deepEqual(granted.targetScope, scope);
    assert.equal(grantInputs.length, 1);
    assert.equal(grantInputs[0].principalOwner, principalOwner);
    assert.equal(grantInputs[0].owner, undefined);
    assert.equal(grantInputs[0].confirmedBy, undefined);
    assert.equal(releases.length, 1);
    assert.equal(releases[0], 'task-a');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
