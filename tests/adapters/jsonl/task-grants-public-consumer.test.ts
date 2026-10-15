import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  JsonlOrganJournal,
  JournalCommitConflictError,
} from '../../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskGrantJournal } from '../../../packages/adapters/jsonl/src/task-grants.js';
import type { CheckpointControlCapabilityRef } from '../../../packages/contracts/src/checkpoint-controls.js';
import { id } from '../../../packages/contracts/src/index.js';
import {
  TaskGrantDeniedError,
  type TaskGrantAuthority,
  type TaskGrantRegistrationPort,
} from '../../../packages/runtime/src/admission/task-grant.js';

const taskId = id('task', 'task-grant-public');
const scope = { organId: id('organ', 'organ-grant-public'), taskId };
const capability: CheckpointControlCapabilityRef = {
  actionId: 'checkpoint.save',
  capabilities: ['checkpoint.save'],
  scope,
};

async function fixture(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'humanagent-task-grant-'));
  return { file: join(dir, 'checkpoints.jsonl'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const JOURNAL_MODULE_URL = new URL('../../../packages/adapters/jsonl/src/index.js', import.meta.url).href;
const GRANT_MODULE_URL = new URL('../../../packages/adapters/jsonl/src/task-grants.js', import.meta.url).href;

const childReadCode = [
  'const [, journalUrl, grantUrl, file, taskValue] = process.argv;',
  'const { JsonlOrganJournal } = await import(journalUrl);',
  'const { JsonlTaskGrantJournal } = await import(grantUrl);',
  'const journal = new JsonlTaskGrantJournal(new JsonlOrganJournal(file));',
  'const readback = await journal.readTaskGrant({ scope: "task", value: taskValue });',
  'process.stdout.write(JSON.stringify(readback));',
].join('\n');

const childBusinessReadCode = [
  'const [, journalUrl, grantUrl, file, taskValue, requestRef] = process.argv;',
  'const { JsonlOrganJournal } = await import(journalUrl);',
  'const { JsonlTaskGrantJournal } = await import(grantUrl);',
  'const journal = new JsonlTaskGrantJournal(new JsonlOrganJournal(file));',
  'const readback = await journal.readBusinessRegistration({ taskId: { scope: "task", value: taskValue }, requestRef });',
  'process.stdout.write(JSON.stringify(readback));',
].join('\n');

function runChild(
  args: readonly string[],
  timeoutMs = 10_000,
  code = childReadCode,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = { code: null as number | null, stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { result.stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { result.stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); result.stderr += String(error); resolve(result); });
    child.on('close', (code) => { clearTimeout(timer); result.code = code; resolve(result); });
  });
}

test('G1: intent alone grants nothing; public grant/read/revoke survive a fresh-process cold read', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = new JsonlTaskGrantJournal(new JsonlOrganJournal(file));

    // Failure mode: a Task submit intent (no grant fact) is read as permission.
    assert.deepEqual(await journal.readTaskGrant(taskId), { grant: null, commit: null });

    const granted = await journal.grant({
      requestId: 'grant-1',
      taskId,
      owner: 'owner-a',
      capability,
      expectedRevision: 0,
    });
    assert.equal(granted.grant?.revision, 1);
    assert.equal(granted.grant?.state, 'granted');
    assert.equal(granted.grant?.owner, 'owner-a');
    assert.equal(granted.commit?.journalSeq, 1);
    assert.match(granted.commit?.commitId ?? '', /^task-grant:v1:[0-9a-f]{64}$/);

    const coldGrant = await runChild([JOURNAL_MODULE_URL, GRANT_MODULE_URL, file, taskId.value]);
    assert.equal(coldGrant.code, 0, coldGrant.stderr);
    const coldRead = JSON.parse(coldGrant.stdout) as { grant: { revision: number; state: string; owner: string } | null; commit: { commitId: string } | null };
    assert.equal(coldRead.grant?.revision, 1);
    assert.equal(coldRead.grant?.state, 'granted');
    assert.equal(coldRead.grant?.owner, 'owner-a');
    assert.equal(coldRead.commit?.commitId, granted.commit?.commitId);

    const revoked = await journal.revoke({ requestId: 'revoke-1', taskId, owner: 'owner-a', expectedRevision: 1 });
    assert.equal(revoked.grant?.revision, 2);
    assert.equal(revoked.grant?.state, 'revoked');
    assert.equal(revoked.commit?.journalSeq, 2);

    const coldRevoked = await runChild([JOURNAL_MODULE_URL, GRANT_MODULE_URL, file, taskId.value]);
    assert.equal(coldRevoked.code, 0, coldRevoked.stderr);
    const revokedRead = JSON.parse(coldRevoked.stdout) as { grant: { revision: number; state: string } | null };
    assert.equal(revokedRead.grant?.revision, 2);
    assert.equal(revokedRead.grant?.state, 'revoked');
  } finally {
    await cleanup();
  }
});

test('G2: same-revision CAS admits one commit, identical retry is idempotent, conflicting intent rejects', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = new JsonlTaskGrantJournal(new JsonlOrganJournal(file));
    const request = { requestId: 'grant-1', taskId, owner: 'owner-a', capability, expectedRevision: 0 } as const;

    const first = await journal.grant(request);
    const bytesAfterFirst = await readFile(file, 'utf8');
    assert.equal(first.grant?.revision, 1);

    // Failure mode: identical retry re-samples time or appends a second record.
    const retry = await journal.grant(request);
    assert.deepEqual(retry, first);
    assert.equal(await readFile(file, 'utf8'), bytesAfterFirst);

    // Failure mode: a second request at the same expectedRevision advances authority.
    await assert.rejects(
      () => journal.grant({ ...request, requestId: 'grant-2' }),
      (error: unknown) => error instanceof TaskGrantDeniedError && error.reason === 'stale-revision',
    );

    // Failure mode: the same immutable request identity is reused for a different intent.
    await assert.rejects(
      () => journal.grant({ ...request, owner: 'other-owner' }),
      (error: unknown) => error instanceof JournalCommitConflictError,
    );
    assert.equal(await readFile(file, 'utf8'), bytesAfterFirst);
  } finally {
    await cleanup();
  }
});

test('G3: authorized business registration shares the held Journal transaction, survives cold read, and revoke only blocks new registration', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = new JsonlTaskGrantJournal(new JsonlOrganJournal(file));
    await journal.grant({
      requestId: 'grant-1',
      taskId,
      owner: 'owner-a',
      capability,
      expectedRevision: 0,
    });
    const business = {
      requestRef: 'business-b',
      taskId,
      owner: 'owner-a',
      capability,
      inputIdentity: { requestRef: 'request-b', digest: 'sha256:request-b' },
    } as const;
    const register = async (authority: TaskGrantAuthority, port: TaskGrantRegistrationPort) =>
      await port.registerBusiness({
        requestRef: business.requestRef,
        taskId: business.taskId,
        owner: business.owner,
        capability: business.capability,
        inputIdentity: business.inputIdentity,
        grantRevision: authority.grant.revision,
      });

    // Failure mode: the registration callback re-enters the public append path
    // and waits for the same Journal lock it already holds.
    const registration = await journal.withAuthorizedNewBusiness(business, async (authority, port) => {
      assert.equal(authority.owner, 'owner-a');
      assert.equal(authority.permissionRevision, '1');
      return await register(authority, port);
    });
    assert.equal(registration.journalSeq, 2);
    assert.match(registration.commitId, /^task-business:v1:[0-9a-f]{64}$/);

    // Failure mode: an identical registration retry duplicates the durable fact.
    const bytesAfterRegistration = await readFile(file, 'utf8');
    const retry = await journal.withAuthorizedNewBusiness(business, register);
    assert.deepEqual(retry, registration);
    assert.equal(await readFile(file, 'utf8'), bytesAfterRegistration);

    // Failure mode: the authorized business fact exists only in memory or in a
    // second store, so a fresh process cannot read it from the same Journal.
    const cold = await runChild(
      [JOURNAL_MODULE_URL, GRANT_MODULE_URL, file, taskId.value, business.requestRef],
      10_000,
      childBusinessReadCode,
    );
    assert.equal(cold.code, 0, cold.stderr);
    const coldRead = JSON.parse(cold.stdout) as {
      registration: { requestRef: string; owner: string; grantRevision: number } | null;
      commit: { commitId: string } | null;
    };
    assert.equal(coldRead.registration?.requestRef, business.requestRef);
    assert.equal(coldRead.registration?.owner, 'owner-a');
    assert.equal(coldRead.registration?.grantRevision, 1);
    assert.equal(coldRead.commit?.commitId, registration.commitId);

    await journal.revoke({ requestId: 'revoke-1', taskId, owner: 'owner-a', expectedRevision: 1 });
    let callbackRan = false;
    await assert.rejects(
      () => journal.withAuthorizedNewBusiness(
        {
          requestRef: 'business-c',
          taskId,
          owner: 'owner-a',
          capability,
          inputIdentity: { requestRef: 'request-c', digest: 'sha256:request-c' },
        },
        async () => {
          callbackRan = true;
          return 'unexpected';
        },
      ),
      (error: unknown) => error instanceof TaskGrantDeniedError && error.reason === 'revoked',
    );
    assert.equal(callbackRan, false);

    // The registered owner still owns the already-durable registration fact
    // after revoke; revoke blocks only the next registration.
    const afterRevoke = await runChild(
      [JOURNAL_MODULE_URL, GRANT_MODULE_URL, file, taskId.value, business.requestRef],
      10_000,
      childBusinessReadCode,
    );
    assert.equal(afterRevoke.code, 0, afterRevoke.stderr);
    const persisted = JSON.parse(afterRevoke.stdout) as { registration: { requestRef: string } | null };
    assert.equal(persisted.registration?.requestRef, business.requestRef);
  } finally {
    await cleanup();
  }
});
