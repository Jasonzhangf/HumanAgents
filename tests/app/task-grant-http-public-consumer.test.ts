import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  ensureControlLayout,
  resolveRuntimePaths,
  type AgentRole,
  type EffectiveAgentProviderBinding,
} from '../../packages/config/src/index.js';
import type { AnyProviderExecutionIdentityRef, ProviderExecutionIdentityRef } from '../../packages/contracts/src/index.js';
import { prepareAgentProvider, prepareExecutionAgentProvider, createAgentProviderPort } from '../../packages/app/src/agent-driver-composition.js';
import { startUiRuntime, type UiRuntime, uiRuntimeControlJournalPath } from '../../packages/app/src/ui-runtime/index.js';
import { uiRuntimeJournalPath, uiRuntimeModeRoot } from '../../packages/app/src/ui-runtime/journal.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import { createServeRuntimeComposition } from '../../packages/app/src/serve-runtime.js';
import { createRccServeOrchestrationPorts } from '../../packages/app/src/serve-orchestration.js';
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

test('scoped task control rejects a different bound target before grant or release', async () => {
  const base = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'task-grant-scoped-target-http-'));
  let server: UiRuntimeServer | undefined;
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
    await ensureControlLayout(paths);
    const organId = id('organ', 'scoped-target-organ');
    const binding: ProviderBinding = {
      bindingId: 'scoped-target-binding', providerId: 'scoped-target-provider', protocol: 'responses',
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
      mode: 'fake',
      organId,
      binding,
      port,
      providerState: 'ready',
      journal: runtimeJournal,
      closurePort: runtimeJournal,
      checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `${taskId.value}-${cycleId.value}.jsonl`)),
      attentionPort: {
        async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
        async resolve(input) { return { attentionId: input.attentionId, delivered: true }; },
      },
      memory: {
        coordinator: new MemoryCoordinator(),
        backend: new DeterministicMemoryBackend(),
        projectKey: paths.projectKey,
        roleId: 'execution',
      },
      explicitBrainInterpreter: { async interpret() { throw new Error('not used by control flow'); } },
      projectKey: paths.projectKey,
      runtimePaths: paths,
    });
    const task = service.createTask({ title: 'scoped HTTP grant fixture' });
    const journal = new JsonlOrganJournal(uiRuntimeControlJournalPath(uiRuntimeModeRoot(paths.checkpointsRoot, 'fake')));
    const grants = new JsonlTaskGrantJournal(journal);
    const taskControl = new UiTaskGrantControl({
      journal,
      organId,
      capability: { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY] },
      now: () => new Date(),
      taskScope(taskId) {
        return { organId, taskId: service.taskDetail(taskId).taskId };
      },
      stopTask: (taskId) => service.stop(taskId),
    });
    const accessControl = await AccessControlService.open({
      credentialPath: join(root, 'security', 'web-access.json'),
      create: true,
    });
    const session = await accessControl.consumePairingCode(accessControl.createPairingChallenge('scoped-target-lease', 1).code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    server = await startUiRuntimeServer({ service, accessControl, taskControl, uiRoot: join(process.cwd(), 'docs', 'ui'), port: 0 });
    const path = `/api/tasks/${encodeURIComponent(task.taskId.value)}/control`;
    const request = async (suffix: string, body?: unknown, query = '') => {
      const response = await fetch(`${server!.url}${path}/${suffix}${query}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, origin: server!.url, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await response.json() as TaskGrantControlReceipt & {
          readonly targetScope?: { readonly projectKey: string; readonly mode: 'fake' | 'rcc' };
          readonly error?: { readonly code: string };
          readonly execution?: { readonly state: string };
        },
      };
    };

    const unscopedRead = await request('grant');
    assert.equal(unscopedRead.status, 200);
    assert.equal(unscopedRead.body.targetScope, undefined);
    const unscopedGrant = await request('grant', { requestId: 'unscoped-grant', expectedRevision: 0 });
    assert.equal(unscopedGrant.status, 200);
    assert.equal(unscopedGrant.body.targetScope, undefined);
    assert.equal(unscopedGrant.body.readback.grant?.state, 'granted');
    const unscopedRevoke = await request('revoke', {
      requestId: 'unscoped-revoke',
      expectedRevision: unscopedGrant.body.readback.grant!.revision,
    });
    assert.equal(unscopedRevoke.status, 200);
    assert.equal(unscopedRevoke.body.readback.grant?.state, 'revoked');
    const baseline = (await journal.verify()).records.length;
    const expectedRevision = unscopedRevoke.body.readback.grant!.revision;
    const baselineGrant = unscopedRevoke.body.readback.grant;

    const wrongProject = await request('grant', { requestId: 'wrong-project-grant', expectedRevision },
      `?projectKey=${encodeURIComponent(`${paths.projectKey}-other`)}&mode=fake`);
    assert.deepEqual({
      status: wrongProject.status,
      errorCode: wrongProject.body.error?.code,
      journalRecords: (await journal.verify()).records.length,
      providerStarts: port.starts.length,
      grant: (await grants.readTaskGrant(task.taskId)).grant,
    }, {
      status: 409,
      errorCode: 'task-control.target.not-bound',
      journalRecords: baseline,
      providerStarts: 0,
      grant: baselineGrant,
    });

    const wrongMode = await request('grant', { requestId: 'wrong-mode-grant', expectedRevision },
      `?projectKey=${encodeURIComponent(paths.projectKey)}&mode=rcc`);
    assert.deepEqual({
      status: wrongMode.status,
      errorCode: wrongMode.body.error?.code,
      journalRecords: (await journal.verify()).records.length,
      providerStarts: port.starts.length,
      grant: (await grants.readTaskGrant(task.taskId)).grant,
    }, {
      status: 409,
      errorCode: 'task-control.target.not-bound',
      journalRecords: baseline,
      providerStarts: 0,
      grant: baselineGrant,
    });

    for (const [label, query] of [
      ['partial', `?projectKey=${encodeURIComponent(paths.projectKey)}`],
      ['invalid', `?projectKey=${encodeURIComponent(paths.projectKey)}&mode=dsh`],
    ] as const) {
      const rejected = await request('grant', { requestId: `${label}-scope-grant`, expectedRevision }, query);
      assert.deepEqual({
        status: rejected.status,
        errorCode: rejected.body.error?.code,
        journalRecords: (await journal.verify()).records.length,
        providerStarts: port.starts.length,
        grant: (await grants.readTaskGrant(task.taskId)).grant,
      }, {
        status: 400,
        errorCode: 'task-control.scope.invalid',
        journalRecords: baseline,
        providerStarts: 0,
        grant: baselineGrant,
      });
    }

    const scopedRead = await request('grant', undefined,
      `?projectKey=${encodeURIComponent(paths.projectKey)}&mode=fake`);
    assert.equal(scopedRead.status, 200);
    assert.deepEqual(scopedRead.body.targetScope, { projectKey: paths.projectKey, mode: 'fake' });
    const scopedGrant = await request('grant', { requestId: 'scoped-grant', expectedRevision },
      `?projectKey=${encodeURIComponent(paths.projectKey)}&mode=fake`);
    assert.equal(scopedGrant.status, 200);
    assert.deepEqual(scopedGrant.body.targetScope, { projectKey: paths.projectKey, mode: 'fake' });
    assert.equal(scopedGrant.body.readback.grant?.state, 'granted');
    assert.equal(scopedGrant.body.execution?.state, 'not-applicable');
    const scopedRevoke = await request('revoke', {
      requestId: 'scoped-revoke',
      expectedRevision: scopedGrant.body.readback.grant!.revision,
    }, `?projectKey=${encodeURIComponent(paths.projectKey)}&mode=fake`);
    assert.equal(scopedRevoke.status, 200);
    assert.deepEqual(scopedRevoke.body.targetScope, { projectKey: paths.projectKey, mode: 'fake' });
    assert.equal(scopedRevoke.body.readback.grant?.state, 'revoked');
    assert.equal(port.starts.length, 0);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
      return { status: response.status, body: await response.json() as TaskGrantControlReceipt & { error?: { code: string }; execution?: { state: string } } };
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
    assert.equal(grant.body.execution?.state, 'not-applicable');
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

test('restart blocks a prepared allocation with committed preparation entry before active turn', async () => {
  const base = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'task-grant-prepared-entry-http-'));
  let runtime: UiRuntime | undefined;
  let orchestration: ReturnType<typeof createServeRuntimeComposition> | undefined;
  let posts = 0;
  let factories = 0;
  let passed = false;
  const controlJournal = new JsonlOrganJournal(uiRuntimeControlJournalPath(uiRuntimeModeRoot(root, 'rcc')));
  const provider = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'grant-model' }] }));
      return;
    }
    posts += 1;
    response.writeHead(500);
    response.end('unexpected Provider POST');
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('fixture provider address missing');
    const bindings: EffectiveAgentProviderBinding[] = [{ agentId: 'grant-agent', roleId: 'execution', source: 'agent',
      provider: { source: 'http', provider: 'rcc', binding: 'grant-binding', protocol: 'responses',
        model: 'grant-model', route: 'grant-model', baseUrl: `http://127.0.0.1:${address.port}` } },
      { agentId: 'grant-planner', roleId: 'orchestration', source: 'agent', provider: { source: 'http', provider: 'rcc',
        binding: 'grant-planner-binding', protocol: 'responses', model: 'grant-model', route: 'grant-model',
        baseUrl: `http://127.0.0.1:${address.port}` } }];
    const select = <T extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(selection: { roleId: AgentRole; configuredAgentId?: string }) =>
      prepareAgentProvider<T>({ ...selection, agentProviderBindings: bindings, evidenceRoot: join(root, 'assets') });
    const startFresh = async () => {
      const launch = await select({ roleId: 'execution' });
      const eventJournal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
      const publishers = { async resolvePublisher() { return null; } };
      const nextOrchestration = createServeRuntimeComposition({
        eventBusPorts: { journal: eventJournal, publishers, consumers: { async resolveConsumer() { return null; } },
          externalOperations: eventJournal, barrierIntents: eventJournal },
        feedbackPorts: { journal: eventJournal, publishers }, feedbackPublisherId: 'grant-http-orchestration',
        ...createRccServeOrchestrationPorts({ port: launch.port, binding: launch.binding, prepareAgentProvider: select,
          promptSegments: { review: [] } }),
      });
      const accessControl = await AccessControlService.open({ credentialPath: join(root, 'web-access.json'), create: true });
      const nextRuntime = await startUiRuntime({ mode: 'rcc', organId: id('organ', 'grant-prepared'), accessControl,
        binding: launch.binding, port: launch.port, providerSource: launch.source, checkpointRoot: join(root, 'ui-runtime'),
        evidenceRoot: join(root, 'assets'), uiRoot: join(process.cwd(), 'docs', 'ui'), portNumber: 0,
        memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'grant-http', roleId: 'execution' },
        explicitBrainInterpreter: { async interpret() { return { kind: 'requirement', intent: 'create',
          normalizedInput: 'deliver controlled result', proposal: 'deliver controlled result', knownFacts: [], decisionRefs: [],
          structuredProposal: { revision: 1, intent: 'create', title: 'HTTP grant task', objective: 'deliver controlled result',
            deliverable: 'controlled result', deliveryConditions: ['deliver controlled result'], evidenceRefs: [], blockingGaps: [] } }; } },
        runtimeComposition: { prepareAgentProvider: select, createTaskAssembly: nextOrchestration.createTaskAssembly,
          prepareTaskAgentProvider: (selection, owner, lease) => {
            factories += 1;
            return prepareExecutionAgentProvider({ roleId: selection.roleId,
              ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
              agentProviderBindings: bindings, createPort: (binding) => createAgentProviderPort(binding, join(root, 'assets')) }, owner, lease);
          } },
      });
      await nextRuntime.service.quiesceImplicitConsumption();
      runtime = nextRuntime;
      orchestration = nextOrchestration;
      return { runtime: nextRuntime, orchestration: nextOrchestration, accessControl };
    };
    let active = await startFresh();
    const interactionId = await active.runtime.service.receiveExplicitInput({ sourceRef: 'ui:new-task-create', rawInput: 'deliver controlled result',
      channel: 'business', requestKind: 'new-task-preview' });
    await active.runtime.service.interpretExplicitInput({ interactionId });
    const preview = await active.runtime.service.inspectExplicitInteraction(interactionId);
    await active.runtime.service.confirmExplicitRequirement({ interactionId, draftId: preview.draft!.draftId,
      inputRevision: preview.draft!.inputRevision, confirmationRef: 'confirmation:grant-http', confirmedBy: 'human:operator',
      confirmedAt: new Date().toISOString(), payloadRef: 'asset://grant-http', requestKind: 'new-task-create' });
    const prepared = await active.runtime.service.dispatchNextExplicitRequirement();
    const preparedOperationId = prepared.operationId;
    if (preparedOperationId === undefined) throw new Error('prepared operation is missing');
    assert.equal(posts, 0);
    assert.equal(factories, 0);
    const firstDetail = active.runtime.service.taskDashboard(prepared.taskId);
    assert.equal(firstDetail.state, 'waiting');
    const preparedInput = active.runtime.service.taskDetail(prepared.taskId).priorInput;
    assert.equal(preparedInput, 'deliver controlled result');
    const preparedRecord = new UiRuntimeJournal(uiRuntimeJournalPath(root, 'rcc')).replay()
      .find((record) => record.kind === 'operation.prepared'
        && record.allocation.operationId.value === preparedOperationId.value
        && record.allocation.executionEpoch === prepared.executionEpoch);
    if (preparedRecord?.kind !== 'operation.prepared') throw new Error('original prepared allocation is missing');
    await controlJournal.append({
      commitId: `prepared-entry:${preparedOperationId.value}:${prepared.executionEpoch}`,
      kind: 'event',
      scope: preparedRecord.allocation.scope,
      payload: {
        kind: 'prepared-execution-stop/v1',
        fact: { kind: 'preparation-entered', allocation: preparedRecord.allocation },
      },
    });

    await active.runtime.close();
    await active.orchestration.dispose();
    runtime = undefined;
    orchestration = undefined;
    active = await startFresh();
    const hydrated = active.runtime.service.taskDashboard(prepared.taskId);
    assert.equal(hydrated.state, 'blocked', JSON.stringify(hydrated));
    assert.equal(hydrated.operationId, preparedOperationId.value);
    assert.equal(hydrated.executionEpoch, prepared.executionEpoch);
    assert.equal(active.runtime.service.taskDetail(prepared.taskId).priorInput, preparedInput);
    assert.equal(posts, 0);
    assert.equal(factories, 0);
    assert.equal(active.runtime.service.eventsSince(preparedOperationId).some((event) => event.kind === 'execution.started'), false);
    passed = true;
  } finally {
    await runtime?.close();
    await orchestration?.dispose();
    provider.closeIdleConnections?.();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (passed) await rm(root, { recursive: true, force: true });
    else console.log(JSON.stringify({ retainedFailureFixture: root }));
  }
});

// Actual gap: HTTP grant currently commits authority but never releases the
// retained allocation. Impact: no execution, or duplicate execution on retry.
// Cost: the existing local HTTP/native composition and one controlled refusal;
// Runtime cold/fault cases and native child delivery remain in their consumers.
for (const refuseRelease of [false, true]) {
test(`HTTP grant releases the typed prepared allocation once; refusal=${refuseRelease}`, async () => {
  const base = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'task-grant-prepared-http-'));
  let runtime: UiRuntime | undefined;
  let orchestration: ReturnType<typeof createServeRuntimeComposition> | undefined;
  let posts = 0;
  let factories = 0;
  let passed = false;
  let onPost!: () => void;
  const posted = new Promise<void>((resolve) => { onPost = resolve; });
  let finish!: () => void;
  const proceed = new Promise<void>((resolve) => { finish = resolve; });
  const controlJournal = new JsonlOrganJournal(uiRuntimeControlJournalPath(uiRuntimeModeRoot(root, 'rcc')));
  const provider = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'grant-model' }] }));
        return;
      }
      posts += 1;
      onPost();
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const wire = JSON.parse(raw) as { input?: { type?: string; role?: string; content?: { text?: string }[] }[] };
      const planner = wire.input?.flatMap((item) => item.role === 'user' ? item.content ?? [] : [])
        .map((part) => { try { return JSON.parse(part.text ?? '') as { role?: string }; } catch { return undefined; } })
        .find((value) => value?.role === 'planner');
      let frames: unknown[];
      if (planner) {
        frames = [{ type: 'response.output_text.done', item_id: 'plan-text', text: JSON.stringify({
          decision: 'complete', reasonText: 'the controlled task delivered its result',
          snapshot: { title: 'HTTP grant task', summary: 'Controlled task delivered',
            completeness: { scope: 'whole-task', status: 'complete' },
            acceptanceCriteria: [{ criterionId: 'delivered', description: 'deliver the controlled result' }],
            nodes: [{ nodeId: 'delivery', kind: 'task', title: 'Deliver', intent: 'deliver the controlled result', definition: {} }],
            phases: [], relations: [] },
        }) }];
      } else if (raw.includes('function_call_output')) {
        frames = [{ type: 'response.output_text.done', item_id: 'drain-text', text: 'drained' }];
      } else {
        await proceed;
        const records = (await controlJournal.verify()).records;
        const coverage = records.find((record) => record.payload?.['kind'] === 'operation-control-coverage/v1');
        const admission = (coverage?.payload as { admissionCommitRef?: { commitId?: string } } | undefined)?.admissionCommitRef?.commitId;
        if (!admission) throw new Error('real TG1 admission coverage missing');
        const section = (text: string) => ({ text, evidenceRefs: [admission] });
        frames = [{ type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', call_id: 'grant-end', name: 'humanagent_turn_end', arguments: JSON.stringify({
            summary: { goal: section('Deliver controlled result'), actions: section('Produce text'),
              result: section('Result ready'), expectedNextStep: section('Close task') },
            deliveryText: 'controlled HTTP grant result', deliveryRefs: [],
          }),
        } }];
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([{ type: 'response.created', response: { id: `grant-${posts}` } }, ...frames,
        { type: 'response.completed', response: { id: `grant-${posts}` } }]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch((error: unknown) => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('fixture provider address missing');
    const bindings: EffectiveAgentProviderBinding[] = [{ agentId: 'grant-agent', roleId: 'execution', source: 'agent',
      provider: { source: 'http', provider: 'rcc', binding: 'grant-binding', protocol: 'responses',
        model: 'grant-model', route: 'grant-model', baseUrl: `http://127.0.0.1:${address.port}` } },
      { agentId: 'grant-planner', roleId: 'orchestration', source: 'agent', provider: { source: 'http', provider: 'rcc',
        binding: 'grant-planner-binding', protocol: 'responses', model: 'grant-model', route: 'grant-model',
        baseUrl: `http://127.0.0.1:${address.port}` } }];
    const select = <T extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(selection: { roleId: AgentRole; configuredAgentId?: string }) =>
      prepareAgentProvider<T>({ ...selection, agentProviderBindings: bindings, evidenceRoot: join(root, 'assets') });
    const startFresh = async () => {
      const launch = await select({ roleId: 'execution' });
      const eventJournal = createJsonlEventJournal({ filePath: join(root, 'events.jsonl') });
      const publishers = { async resolvePublisher() { return null; } };
      const nextOrchestration = createServeRuntimeComposition({
        eventBusPorts: { journal: eventJournal, publishers, consumers: { async resolveConsumer() { return null; } },
          externalOperations: eventJournal, barrierIntents: eventJournal },
        feedbackPorts: { journal: eventJournal, publishers }, feedbackPublisherId: 'grant-http-orchestration',
        ...createRccServeOrchestrationPorts({ port: launch.port, binding: launch.binding, prepareAgentProvider: select,
          promptSegments: { review: [] } }),
      });
      const accessControl = await AccessControlService.open({ credentialPath: join(root, 'web-access.json'), create: true });
      const nextRuntime = await startUiRuntime({ mode: 'rcc', organId: id('organ', 'grant-prepared'), accessControl,
        binding: launch.binding, port: launch.port, providerSource: launch.source, checkpointRoot: join(root, 'ui-runtime'),
        evidenceRoot: join(root, 'assets'), uiRoot: join(process.cwd(), 'docs', 'ui'), portNumber: 0,
        memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'grant-http', roleId: 'execution' },
        explicitBrainInterpreter: { async interpret() { return { kind: 'requirement', intent: 'create',
          normalizedInput: 'deliver controlled result', proposal: 'deliver controlled result', knownFacts: [], decisionRefs: [],
          structuredProposal: { revision: 1, intent: 'create', title: 'HTTP grant task', objective: 'deliver controlled result',
            deliverable: 'controlled result', deliveryConditions: ['deliver controlled result'], evidenceRefs: [], blockingGaps: [] } }; } },
        runtimeComposition: { prepareAgentProvider: select, createTaskAssembly: nextOrchestration.createTaskAssembly,
          prepareTaskAgentProvider: (selection, owner, lease) => {
            factories += 1;
            if (refuseRelease) throw new Error('controlled release refusal');
            return prepareExecutionAgentProvider({ roleId: selection.roleId,
              ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
              agentProviderBindings: bindings, createPort: (binding) => createAgentProviderPort(binding, join(root, 'assets')) }, owner, lease);
          } },
      });
      await nextRuntime.service.quiesceImplicitConsumption();
      runtime = nextRuntime;
      orchestration = nextOrchestration;
      return { runtime: nextRuntime, orchestration: nextOrchestration, accessControl };
    };
    let active = await startFresh();
    const interactionId = await active.runtime.service.receiveExplicitInput({ sourceRef: 'ui:new-task-create', rawInput: 'deliver controlled result',
      channel: 'business', requestKind: 'new-task-preview' });
    await active.runtime.service.interpretExplicitInput({ interactionId });
    const preview = await active.runtime.service.inspectExplicitInteraction(interactionId);
    await active.runtime.service.confirmExplicitRequirement({ interactionId, draftId: preview.draft!.draftId,
      inputRevision: preview.draft!.inputRevision, confirmationRef: 'confirmation:grant-http', confirmedBy: 'human:operator',
      confirmedAt: new Date().toISOString(), payloadRef: 'asset://grant-http', requestKind: 'new-task-create' });
    const prepared = await active.runtime.service.dispatchNextExplicitRequirement();
    assert.ok(prepared.operationId);
    const preparedOperationId = prepared.operationId;
    if (preparedOperationId === undefined) throw new Error('prepared operation is missing');
    assert.equal(posts, 0);
    assert.equal(factories, 0);
    const firstDetail = active.runtime.service.taskDashboard(prepared.taskId);
    assert.equal(firstDetail.state, 'waiting');
    assert.equal(active.runtime.service.eventsSince(preparedOperationId).some((event) => event.kind === 'execution.started'), false);
    const preparedInput = active.runtime.service.taskDetail(prepared.taskId).priorInput;
    assert.equal(preparedInput, 'deliver controlled result');

    if (!refuseRelease) {
      await active.runtime.close();
      await active.orchestration.dispose();
      active = await startFresh();
      const hydrated = active.runtime.service.taskDashboard(prepared.taskId);
      assert.equal(hydrated.state, 'waiting', JSON.stringify(hydrated));
      assert.deepEqual(hydrated.allowedActions, ['stop']);
      assert.equal(hydrated.operationId, preparedOperationId.value);
      assert.equal(hydrated.executionEpoch, prepared.executionEpoch);
      assert.equal(active.runtime.service.taskDetail(prepared.taskId).priorInput, preparedInput);
      assert.equal(posts, 0);
      assert.equal(factories, 0);
      assert.equal(active.runtime.service.eventsSince(preparedOperationId).some((event) => event.kind === 'execution.started'), false);
    }
    const session = await active.accessControl.consumePairingCode(active.accessControl.createPairingChallenge('grant-lease', 1).code);
    const cookie = active.accessControl.sessionCookie(session).split(';')[0]!;
    const url = `${active.runtime.server.url}/api/tasks/${prepared.taskId.value}/control/grant`;
    const grant = async (body?: unknown) => {
      const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { cookie, origin: active.runtime.server.url,
        'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200);
      return await response.json() as TaskGrantControlReceipt & { execution?: { state: string; current?: {
        operationId?: string; executionEpoch?: number; state: string; error?: unknown }; apiError?: { message: string } } };
    };
    const input = { requestId: 'prepared-http-grant', expectedRevision: 0 };
    const receipt = await grant(input);
    assert.equal(receipt.readback.grant?.state, 'granted');
    assert.ok(receipt.execution, 'durable HTTP grant must report execution release of its retained prepared allocation');
    if (!receipt.execution) throw new Error('HTTP execution receipt missing');
    assert.equal(receipt.execution.current?.operationId, prepared.operationId!.value);
    assert.equal(receipt.execution.current?.executionEpoch, prepared.executionEpoch);
    if (refuseRelease) {
      assert.equal(receipt.execution.state, 'blocked');
      assert.match(receipt.execution.apiError!.message, /controlled release refusal/);
      assert.deepEqual((await grant()).readback, receipt.readback);
      const duplicate = await grant(input);
      assert.equal(duplicate.execution?.state, 'blocked');
      assert.equal(factories, 1, 'refusal must not automatically reprepare');
      assert.equal(posts, 0);
    } else {
      assert.equal(receipt.execution.state, 'released');
      await Promise.race([posted, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('released allocation made no Provider POST')), 5000);
        timer.unref?.();
      })]);
      const running = await grant(input);
      assert.equal(running.execution?.state, 'current');
      assert.equal(running.execution?.current?.state, 'running');
      assert.equal(factories, 1);
      assert.equal(posts, 1, 'duplicate running grant must not issue another Provider POST');
      finish();
      const deadline = Date.now() + 10_000;
      while (active.runtime.service.taskDashboard(prepared.taskId).state !== 'succeeded' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const detail = active.runtime.service.taskDashboard(prepared.taskId);
      assert.equal(detail.state, 'succeeded', JSON.stringify({ state: detail.state, error: detail.error }));
      assert.equal(detail.output, 'controlled HTTP grant result');
      const completedPosts = posts;
      const terminal = await grant(input);
      assert.equal(terminal.execution?.state, 'current');
      assert.equal(terminal.execution?.current?.state, 'succeeded');
      assert.equal(terminal.execution?.current?.operationId, prepared.operationId!.value);
      assert.equal(terminal.execution?.current?.executionEpoch, prepared.executionEpoch);
      assert.equal(active.runtime.service.taskDetail(prepared.taskId).priorInput, preparedInput);
      assert.equal(active.runtime.service.listTasks().waiting.some((row) => row.taskId.value === prepared.taskId.value), false);
      assert.equal(posts, completedPosts);
      assert.equal(factories, 1);
    }
    console.log(JSON.stringify({ refuseRelease, prepared, receipt, posts, factories }));
    passed = true;
  } finally {
    finish();
    await runtime?.close();
    await orchestration?.dispose();
    provider.closeIdleConnections?.();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (passed) await rm(root, { recursive: true, force: true });
    else console.log(JSON.stringify({ retainedFailureFixture: root }));
  }
});
}
