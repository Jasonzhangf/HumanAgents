/**
 * Blackbox acceptance for the delete-task operation-binding retirement fix.
 *
 * Real entry: a real HTTP UI runtime listener (own control root, own port) built
 * from the shipped UiRuntimeService + UiRuntimeJournal. It asserts over public
 * HTTP only, and answers the two questions task-18 asks:
 *   1. does delete retire the operation binding of that task, and
 *   2. does a restart clear an already-persisted residual operation.
 *
 * Run: npx tsx tests/runtime/ui-runtime/delete-task-operation-binding.blackbox.ts
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { id, type ProviderBinding } from '../../../packages/contracts/src/index.js';
import { DeterministicMemoryBackend } from '../../../packages/adapters/memory/src/index.js';
import { JsonlTaskIdentityJournal } from '../../../packages/adapters/jsonl/src/index.js';
import { MemoryCoordinator } from '../../../packages/runtime/src/index.js';
import { TaskIdentityConsumer } from '../../../packages/runtime/src/orchestration/task-identity.js';
import { JsonlOrganJournal } from '../../../packages/adapters/jsonl/src/index.js';
import {
  FileCheckpointStore,
  FakeReplayExecutionRuntimePort,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../../packages/app/src/ui-runtime/index.js';
import { startUiRuntimeServer } from '../../../packages/app/src/ui-runtime/server.js';
import { AccessControlService } from '../../../packages/app/src/ui-runtime/access-control.js';

const organId = id('organ', 'delete-binding-blackbox-organ');
const binding: ProviderBinding = {
  bindingId: 'binding-delete-binding-blackbox',
  providerId: 'provider-delete-binding-blackbox',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-delete-binding-blackbox',
  configDigest: 'sha256:delete-binding-blackbox-config',
  capabilityDigest: 'sha256:delete-binding-blackbox-capability',
};

interface Started {
  readonly server: { readonly url: string; close(): Promise<unknown> };
  readonly cookie: string;
  readonly root: string;
}

async function startRoot(root: string, port = 0): Promise<Started> {
  const modeRoot = join(root, 'fake');
  await mkdir(modeRoot, { recursive: true });
  const journal = new UiRuntimeJournal(join(modeRoot, 'ui-runtime-journal.jsonl'));
  const identities = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(new JsonlOrganJournal(join(modeRoot, 'control.jsonl'))));
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(
      join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`),
    ),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true as const }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true as const }; },
    },
    providerState: 'ready',
    explicitBrainInterpreter: {
      async interpret() { throw new Error('explicit brain is not configured for this blackbox'); },
    },
    journal,
    closurePort: journal,
    runtimeComposition: { admitExecution: async () => {} },
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'delete-binding-blackbox',
      roleId: 'execution',
    },
    taskIdentity: identities,
  });
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  const server = await startUiRuntimeServer({
    service,
    accessControl,
    productRoot: root,
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    port,
  });
  return { server, cookie: accessControl.sessionCookie(session).split(';')[0]!, root };
}

function client(started: Started) {
  const origin = new URL(started.server.url).origin;
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set('cookie', started.cookie);
    if ((init.method ?? 'GET').toUpperCase() !== 'GET') headers.set('origin', origin);
    const response = await fetch(`${started.server.url}${path}`, { ...init, headers });
    const text = await response.text();
    let body: any;
    try { body = text === '' ? undefined : JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };
  return { call, origin };
}

async function waitForState(c: ReturnType<typeof client>, taskId: string, wanted: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const dashboard = await c.call(`/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
    if (dashboard.status === 200) {
      const state = dashboard.body?.state ?? dashboard.body?.task?.state;
      if (state === wanted) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const last = await c.call(`/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
  throw new Error(`task ${taskId} never reached ${wanted}; last=${JSON.stringify(last.body).slice(0, 400)}`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'delete-binding-blackbox-'));
  const evidence: string[] = [];
  try {
    // ---- Phase A: live delete over real HTTP ------------------------------
    let started = await startRoot(root);
    let c = client(started);
    const created = await c.call('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'delete binding blackbox', directive: 'report the durable root' }),
    });
    assert.equal(created.status, 201, `create task: ${JSON.stringify(created.body).slice(0, 300)}`);
    const taskId = String(created.body.taskId?.value ?? created.body.taskId);
    const startedExecution = await c.call(`/api/tasks/${encodeURIComponent(taskId)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'report the durable root' }),
    });
    assert.equal(startedExecution.status, 202, `start execution: ${JSON.stringify(startedExecution.body).slice(0, 300)}`);
    const operationId = String(startedExecution.body.operationId);
    evidence.push(`phaseA task=${taskId} operation=${operationId}`);
    await waitForState(c, taskId, 'succeeded');
    const beforeDelete = await c.call(`/api/executions/${encodeURIComponent(operationId)}/events`);
    assert.equal(beforeDelete.status, 200, 'before delete the operation must exist (SSE stream opens)');

    const deleted = await c.call(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200, `delete task: ${JSON.stringify(deleted.body).slice(0, 300)}`);
    assert.equal(deleted.body.deleted, true);
    const afterDeleteTask = await c.call(`/api/tasks/${encodeURIComponent(taskId)}`);
    assert.equal(afterDeleteTask.status, 404, 'the deleted task must be gone from the public task read model');
    const afterDeleteOperation = await c.call(`/api/executions/${encodeURIComponent(operationId)}/events`);
    assert.equal(afterDeleteOperation.status, 404, 'delete must retire the operation binding of that task');
    evidence.push(`phaseA afterDelete taskStatus=${afterDeleteTask.status} operationStatus=${afterDeleteOperation.status}`);

    // ---- Phase B: restart over the same journal ---------------------------
    await started.server.close();
    started = await startRoot(root);
    c = client(started);
    const afterRestartTask = await c.call(`/api/tasks/${encodeURIComponent(taskId)}`);
    assert.equal(afterRestartTask.status, 404, 'a deleted task must not come back after restart');
    const afterRestartOperation = await c.call(`/api/executions/${encodeURIComponent(operationId)}/events`);
    assert.equal(afterRestartOperation.status, 404, 'restart must not revive the deleted operation binding');
    evidence.push(`phaseB taskStatus=${afterRestartTask.status} operationStatus=${afterRestartOperation.status}`);
    await started.server.close();

    // ---- Phase C: production sequence replay ------------------------------
    // The exact persisted records of scheduled-task-b258bd97ecc762223c7a, whose
    // last two records are a delete and a same-taskId rebuild.
    const productionRoot = join(root, 'production');
    const productionModeRoot = join(productionRoot, 'fake');
    await mkdir(productionModeRoot, { recursive: true });
    await writeFile(join(productionModeRoot, 'ui-runtime-journal.jsonl'), `${productionRecords().map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    started = await startRoot(productionRoot);
    c = client(started);
    const rebuiltId = 'scheduled-task-b258bd97ecc762223c7a';
    const rebuiltDetail = await c.call(`/api/tasks/${encodeURIComponent(rebuiltId)}`);
    assert.equal(rebuiltDetail.status, 200, `the rebuilt task must replay: ${JSON.stringify(rebuiltDetail.body).slice(0, 300)}`);
    const rebuiltDashboard = await c.call(`/api/tasks/${encodeURIComponent(rebuiltId)}/dashboard`);
    assert.equal(rebuiltDashboard.body?.state, 'created', 'the rebuilt task replays as a fresh created task');
    const staleOperation = await c.call('/api/executions/scheduled-operation-b258bd97ecc762223c7a/events');
    assert.equal(staleOperation.status, 404, 'the deleted execution of the rebuilt task must not be resolvable');
    const restarted = await c.call(`/api/tasks/${encodeURIComponent(rebuiltId)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'report the durable root' }),
    });
    assert.equal(restarted.status, 202, `rebuild may start a fresh execution: ${JSON.stringify(restarted.body).slice(0, 300)}`);
    assert.notEqual(String(restarted.body.operationId), 'scheduled-operation-b258bd97ecc762223c7a',
      'the rebuild must mint a new operation instead of reusing the retired one');
    evidence.push(`phaseC rebuiltState=created staleOpStatus=${staleOperation.status} newOperation=${restarted.body.operationId}`);
    // Await the fresh execution's terminal so the journal settles before the
    // server closes and the fixture root is removed.
    await waitForState(c, rebuiltId, 'succeeded');
    await started.server.close();

    console.log(JSON.stringify({ ok: true, evidence }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function productionRecords(): unknown[] {
  const taskId = id('task', 'scheduled-task-b258bd97ecc762223c7a');
  const operationId = id('operation', 'scheduled-operation-b258bd97ecc762223c7a');
  const organ = id('organ', 'humanagent-ui');
  const scope = {
    organId: organ,
    taskId,
    cycleId: id('cycle', 'ui-cycle-10'),
    operationId,
  };
  const allocation = {
    runtimeId: 'ui-runtime-scheduled-operation-b258bd97ecc762223c7a',
    taskId,
    operationId,
    executionEpoch: 1,
    assignmentId: 'assignment-scheduled-operation-b258bd97ecc762223c7a',
    scope,
    inputRefs: ['task://scheduled-task-b258bd97ecc762223c7a/input/10'],
    ownerId: 'humanagent.runtime',
    directiveRevision: 1,
    inputRevision: 1,
    orchestrated: false,
  };
  const directive = 'report the durable root';
  return [
    {
      kind: 'task.created',
      taskId,
      title: '计划执行 subscription:requirement:draft-141:2::1::1',
      directive,
      directiveRevision: 1,
      createdAt: '2026-10-24T01:29:47.348Z',
      taskCounter: 13,
    },
    { kind: 'operation.prepared', allocation, input: directive, operationCounter: 10, cycleCounter: 10 },
    {
      kind: 'operation.started',
      operationId,
      taskId,
      cycleId: scope.cycleId,
      scope,
      executionEpoch: 1,
      operationCounter: 10,
      cycleCounter: 10,
      startedAt: '2026-10-24T01:29:47.400Z',
      input: directive,
    },
    {
      kind: 'operation.event',
      operationId,
      event: {
        eventId: 'checkpoint.committed/blackbox-1',
        seq: 1,
        occurredAt: '2026-10-26T14:40:41.000Z',
        taskId,
        operationId: operationId.value,
        executionEpoch: 1,
        kind: 'checkpoint.committed',
        state: 'stopped',
        summary: 'stopped',
        evidenceRefs: [],
      },
    },
    {
      kind: 'operation.event',
      operationId,
      event: {
        eventId: 'execution.terminal/blackbox-2',
        seq: 2,
        occurredAt: '2026-10-26T14:40:41.500Z',
        taskId,
        operationId: operationId.value,
        executionEpoch: 1,
        kind: 'execution.terminal',
        state: 'stopped',
        terminalPhase: 'final',
        summary: 'stopped',
        evidenceRefs: [],
      },
    },
    { kind: 'task.deleted', taskId, deletedAt: '2026-10-26T14:40:44.691Z' },
    {
      kind: 'task.created',
      taskId,
      title: '计划执行 subscription:requirement:draft-141:2::1::1',
      directive,
      directiveRevision: 1,
      createdAt: '2026-10-26T14:40:44.907Z',
      taskCounter: 14,
    },
  ];
}

await main();
