import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ProviderBinding, type ProviderStartInput } from '../../packages/contracts/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { TaskGrantDeniedError } from '../../packages/runtime/src/admission/task-grant.js';
import { FileCheckpointStore, FakeReplayExecutionRuntimePort, UiRuntimeJournal, UiRuntimeService } from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { startUiRuntimeServer, type UiRuntimeServer } from '../../packages/app/src/ui-runtime/server.js';
import { UiTaskGrantControl, TASK_EXECUTION_ACTION_ID, TASK_EXECUTION_CAPABILITY, type TaskGrantControlReceipt } from '../../packages/app/src/ui-runtime/task-control.js';

test('HTTP grant control uses verified owner and durable readback without releasing execution', async () => {
  const base = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'task-grant-http-'));
  let server: UiRuntimeServer | undefined;
  try {
    const organId = id('organ', 'http-grant-organ');
    const binding: ProviderBinding = {
      bindingId: 'http-grant-binding', providerId: 'http-grant-provider', protocol: 'responses',
      endpointRef: 'fixture:unused', modelRef: 'fixture', configDigest: 'sha256:fixture', capabilityDigest: 'sha256:fixture',
    };
    class CountingPort extends FakeReplayExecutionRuntimePort {
      readonly starts: ProviderStartInput[] = [];
      override async start(input: ProviderStartInput) {
        this.starts.push(input);
        return super.start(input);
      }
    }
    const port = new CountingPort({ binding, stepDelayMs: 1 });
    const runtimeJournal = new UiRuntimeJournal(join(root, 'runtime.jsonl'));
    const service = new UiRuntimeService({
      mode: 'fake', organId, binding, port, providerState: 'ready', journal: runtimeJournal, closurePort: runtimeJournal,
      checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `${taskId.value}-${cycleId.value}.jsonl`)),
      attentionPort: {
        async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
        async resolve(input) { return { attentionId: input.attentionId, delivered: true }; },
      },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'http-grant', roleId: 'execution' },
      explicitBrainInterpreter: { async interpret() { throw new Error('not used by control flow'); } },
    });
    const task = service.createTask({ title: 'owned HTTP grant fixture' });
    const journal = new JsonlOrganJournal(join(root, 'control.jsonl'));
    const grants = new JsonlTaskGrantJournal(journal);
    const taskControl = new UiTaskGrantControl({
      journal, organId, capability: { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY] },
      now: () => new Date(),
      taskScope(taskId) { return { organId, taskId: service.taskDetail(taskId).taskId }; },
      stopTask: (taskId) => service.stop(taskId),
    });
    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'security', 'web-access.json'), create: true });
    const session = await accessControl.consumePairingCode(accessControl.createPairingChallenge('fixture-lease', 1).code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const verified = await accessControl.verifyProductPrincipal(cookie);
    assert.equal(verified.state, 'valid');
    if (verified.state !== 'valid') throw new Error('fixture principal unavailable');
    const options = { service, accessControl, taskControl, uiRoot: join(process.cwd(), 'docs', 'ui'), port: 0 };
    server = await startUiRuntimeServer(options);
    const path = `/api/tasks/${encodeURIComponent(task.taskId.value)}/control`;
    const request = async (suffix: string, body?: unknown, authenticated = true) => {
      const response = await fetch(`${server!.url}${path}/${suffix}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(authenticated ? { cookie } : {}), origin: server!.url, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as TaskGrantControlReceipt & { error?: { code: string } } };
    };
    const initial = await request('grant');
    assert.equal(initial.status, 200, 'original public grant GET must exist');
    assert.equal(initial.body.readback.grant, null);
    assert.equal(initial.body.authority, null);
    assert.equal(port.starts.length, 0);
    assert.equal((await request('grant', undefined, false)).status, 401);
    const grant = await request('grant', {
      requestId: 'http-grant', expectedRevision: 0,
      owner: 'forged-owner', confirmedBy: 'forged-owner', hasStopPermission: true,
      capability: { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY] },
    });
    assert.equal(grant.status, 200);
    assert.equal(grant.body.owner, verified.principal.owner);
    assert.equal(grant.body.readback.grant?.owner, verified.principal.owner);
    assert.equal(grant.body.readback.grant?.state, 'granted');
    assert.ok(grant.body.authority);
    assert.deepEqual(grant.body.readback, await grants.readTaskGrant(task.taskId));
    assert.deepEqual((await request('grant')).body.readback, await grants.readTaskGrant(task.taskId));
    const revoked = await request('revoke', { requestId: 'http-revoke', expectedRevision: grant.body.readback.grant!.revision });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.readback.grant?.state, 'revoked');
    assert.equal(revoked.body.authority, null);
    assert.deepEqual((await request('grant')).body.readback, await grants.readTaskGrant(task.taskId));
    let registered = false;
    await assert.rejects(() => grants.withAuthorizedNewBusiness({
      requestRef: 'after-revoke', taskId: task.taskId, owner: verified.principal.owner,
      capability: { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY], scope: { organId, taskId: task.taskId } },
      inputIdentity: { requestRef: 'input-after-revoke', digest: 'sha256:fixture-input' },
    }, async () => { registered = true; }), (error: unknown) => error instanceof TaskGrantDeniedError && error.reason === 'revoked');
    assert.equal(registered, false);
    assert.equal(port.starts.length, 0);
    await server.close();
    server = await startUiRuntimeServer({ service, accessControl, uiRoot: options.uiRoot, port: 0 });
    const unavailable = await request('grant');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error?.code, 'task-control.source.unavailable');
    console.log(JSON.stringify({
      initialGrant: initial.body.readback.grant,
      grantState: grant.body.readback.grant?.state,
      grantRevision: grant.body.readback.grant?.revision,
      verifiedOwnerMatches: grant.body.owner === verified.principal.owner,
      authorityCommitMatchesJournal: grant.body.authority?.commit.commitId === grant.body.readback.commit?.commitId,
      revokeState: revoked.body.readback.grant?.state,
      revokeRevision: revoked.body.readback.grant?.revision,
      postRevokeRegistered: registered,
      targetExecutionRequests: port.starts.length,
      missingSource: unavailable.body.error?.code,
    }));
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
