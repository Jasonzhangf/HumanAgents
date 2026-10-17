import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createExplicitBrainRuntime,
  createProviderExplicitBrainInterpreter,
} from '../../packages/app/src/explicit-brain-runtime.js';
import { DecisionTraceJournal, DecisionTraceStore } from '../../packages/runtime/src/explicit-brain/index.js';
import { FakeReplayExecutionRuntimePort } from '../../packages/app/src/ui-runtime/fake-port.js';
import type { ProviderBinding } from '../../packages/contracts/src/index.js';
import type { AgentRole, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { prepareAgentProvider, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { id } from '../../packages/contracts/src/index.js';
import { FileCheckpointStore, UiRuntimeJournal, UiRuntimeService, startUiRuntime, type UiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import type { TaskGrantControlReceipt } from '../../packages/app/src/ui-runtime/task-control.js';
import type { PersistedFinalSubmitReceipt } from '../../packages/runtime/src/explicit-brain/router.js';

for (const source of ['rcc', 'http'] as const) {
test(`default App composition admits the retained Task only after real HTTP grant and releases native Provider (${source})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-default-native-consumer-'));
  let runtime: UiRuntime | undefined;
  let posts = 0;
  let onPost: (() => void) | undefined;
  const posted = new Promise<void>((resolve) => { onPost = resolve; });
  const provider = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"ok","data":[{"id":"controlled-native"}]}'); return; }
    posts += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'controlled-native-request' } })}\n\n`);
    // A real open HTTP stream lets the original revoke/stop owner settle it.
    onPost?.();
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('missing controlled Provider address');
    const entries: EffectiveAgentProviderBinding[] = [{ agentId: 'controlled-execution', roleId: 'execution', source: 'agent',
      provider: { source, provider: 'rcc', binding: 'controlled-native', protocol: 'responses',
        model: 'controlled-native', route: 'controlled-native', baseUrl: `http://127.0.0.1:${address.port}` } }];
    let selections = 0;
    const select = async (selection: { readonly roleId: AgentRole; readonly configuredAgentId?: string }) => {
      selections += 1;
      return prepareAgentProvider({ ...selection, agentProviderBindings: entries, evidenceRoot: join(root, 'assets') });
    };
    const launch = await select({ roleId: 'execution' });
    const readiness = await launch.port.probe(launch.binding);
    if (source === 'http') {
      assert.equal(readiness.state, 'unknown');
      assert.equal(readiness.nextAction?.kind, 'continue');
      assert.equal(readiness.nextAction?.ref, 'http.start');
    }
    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'security', 'web-access.json'), create: true });
    runtime = await startUiRuntime({ mode: 'rcc', accessControl, organId: id('organ', 'default-native-consumer'),
      binding: launch.binding, port: launch.port, providerSource: launch.source, checkpointRoot: root,
      evidenceRoot: join(root, 'assets'), uiRoot: join(process.cwd(), 'docs', 'ui'), portNumber: 0,
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'default-native', roleId: 'execution' },
      explicitBrainInterpreter: { async interpret() { return { kind: 'requirement', intent: 'create',
        normalizedInput: 'hold this controlled native task', proposal: 'hold this controlled native task', knownFacts: [], decisionRefs: [] }; } },
      runtimeComposition: { prepareAgentProvider: select },
    });
    await runtime.service.quiesceImplicitConsumption();
    const interactionId = await runtime.service.receiveExplicitInput({ sourceRef: 'ui:new-task-create', rawInput: 'hold this controlled native task',
      channel: 'business', requestKind: 'new-task-preview' });
    await runtime.service.interpretExplicitInput({ interactionId });
    const preview = await runtime.service.inspectExplicitInteraction(interactionId);
    const confirmed = await runtime.service.confirmExplicitRequirement({ interactionId, draftId: preview.draft!.draftId,
      inputRevision: preview.draft!.inputRevision, confirmationRef: 'confirmation:default-native', confirmedBy: 'human:operator',
      confirmedAt: '2026-10-17T00:00:00.000Z', payloadRef: 'asset://default-native', requestKind: 'new-task-create' });
    const dispatched = await runtime.service.dispatchNextExplicitRequirement().catch((error: unknown) => {
      console.log(JSON.stringify({ source, readiness, posts, selections, admissionError: error }));
      throw error;
    });
    assert.equal(runtime.service.status().providerState, readiness.state);
    await assert.rejects(() => runtime!.service.releaseExecution(dispatched.taskId, dispatched.operationId), /verified TG1 owner is absent/);
    assert.equal(posts, 0, 'typed confirmation and TaskIdentity are not execution authority');
    assert.equal(selections, 1, 'no target execution Provider may be selected before grant');
    const session = await accessControl.consumePairingCode(accessControl.createPairingChallenge('controlled-lease', 1).code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const controlPath = `${runtime.server.url}/api/tasks/${dispatched.taskId.value}/control`;
    const initial = await fetch(`${controlPath}/grant`, { headers: { cookie } });
    const read = await initial.json() as TaskGrantControlReceipt;
    assert.equal(initial.status, 200, 'default startup must inject the actual grant controller');
    const grantResponse = await fetch(`${controlPath}/grant`, { method: 'POST', headers: { cookie, origin: runtime.server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'controlled-native-grant', expectedRevision: read.readback.grant?.revision ?? 0 }) });
    const grant = await grantResponse.json() as TaskGrantControlReceipt;
    assert.equal(grantResponse.status, 200);
    assert.equal(grant.readback.grant?.state, 'granted');
    const released = await runtime.service.releaseExecution(dispatched.taskId, dispatched.operationId);
    assert.equal(released.state, 'released');
    await Promise.race([posted, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('native Provider POST not reached')), 5000); timer.unref?.(); })]);
    assert.equal(posts, 1);
    assert.equal(selections, 2, 'same prepared allocation must select the native Provider exactly once after grant');
    const revokeResponse = await fetch(`${controlPath}/revoke`, { method: 'POST', headers: { cookie, origin: runtime.server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'controlled-native-revoke', expectedRevision: grant.readback.grant!.revision }) });
    const revoked = await revokeResponse.json() as TaskGrantControlReceipt;
    assert.equal(revokeResponse.status, 200);
    assert.equal(revoked.readback.grant?.state, 'revoked');
    assert.ok(revoked.stop, 'revoke must delegate to the standard stop owner');
    const runtimeOwner = accessControl.readRuntimeProductIdentity().owner;
    await accessControl.logout();
    assert.ok((await accessControl.verifyProductPrincipal(cookie)).state !== 'valid');
    assert.equal(accessControl.readRuntimeProductIdentity().owner, runtimeOwner);
    assert.equal(runtime.service.taskDetail(dispatched.taskId).taskId.value, dispatched.taskId.value);
    assert.equal(posts, 1, 'revoke may not start new Provider business');
    assert.equal(runtime.service.status().providerState, readiness.state);
    console.log(JSON.stringify({ source, readiness, confirmed, dispatched, released, posts, selections, revoke: revoked.stop }));
  } finally {
    try { await runtime?.close(); } finally {
      provider.closeIdleConnections?.();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});
}

test('typed final FIFO establishes exact TaskIdentity before execution and preserves write-failure retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-final-source-'));
  try {
    const organId = id('organ', 'typed-source-consumer');
    const binding: ProviderBinding = { bindingId: 'source-consumer', providerId: 'source-consumer',
      protocol: 'responses', endpointRef: 'fixture:source', modelRef: 'fixture:source',
      configDigest: 'fixture:source', capabilityDigest: 'fixture:source' };
    const journal = new UiRuntimeJournal(join(root, 'runtime.jsonl'));
    const identityJournal = new JsonlTaskIdentityJournal(new JsonlOrganJournal(join(root, 'control.jsonl')));
    let failAppend = true;
    const taskIdentity = new TaskIdentityConsumer({
      replay: (scope) => identityJournal.replay(scope),
      append: (input) => failAppend ? Promise.reject(new Error('controlled identity append failed')) : identityJournal.append(input),
    });
    let admissions = 0;
    let factories = 0;
    const serviceOptions: ConstructorParameters<typeof UiRuntimeService>[0] = {
      mode: 'fake', organId, binding, port: new FakeReplayExecutionRuntimePort({ binding }),
      providerState: 'ready', journal, closurePort: journal, taskIdentity,
      checkpointStoreFor: () => new FileCheckpointStore(join(root, 'checkpoint.jsonl')),
      attentionPort: {
        async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
        async resolve(input) { return { attentionId: input.attentionId, delivered: true }; },
      },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'typed-source', roleId: 'execution' },
      explicitBrainInterpreter: { async interpret() { return { kind: 'requirement', intent: 'create',
        normalizedInput: 'deliver the controlled task', proposal: 'deliver the controlled task', knownFacts: [], decisionRefs: [] }; } },
      runtimeComposition: { createExecutionPorts: () => ({
        admitExecution: async () => { admissions += 1; throw new Error('controlled missing grant'); },
        createDriver: async () => { factories += 1; throw new Error('unexpected execution factory'); },
      }) },
    };
    const service = new UiRuntimeService(serviceOptions);
    const interactionId = await service.receiveExplicitInput({ sourceRef: 'ui:new-task-create',
      rawInput: 'deliver the controlled task', channel: 'business', requestKind: 'new-task-preview' });
    await service.interpretExplicitInput({ interactionId });
    const preview = await service.inspectExplicitInteraction(interactionId);
    assert.ok(preview.draft);
    assert.ok(preview.revision);
    const confirmation: Parameters<UiRuntimeService['confirmExplicitRequirement']>[0] = { interactionId, draftId: preview.draft!.draftId,
      inputRevision: preview.draft!.inputRevision, confirmationRef: 'confirmation:source-consumer',
      confirmedBy: 'human:operator', confirmedAt: '2026-10-17T00:00:00.000Z',
      payloadRef: 'asset://source-consumer', requestKind: 'new-task-create' };
    const receipt = await service.confirmExplicitRequirement(confirmation);
    const alias = await service.confirmExplicitRequirement({ ...confirmation, idempotencyKey: 'source-consumer-alias' });
    assert.equal(alias.requirement.requirementId, receipt.requirement.requirementId);
    await assert.rejects(() => service.dispatchNextExplicitRequirement(), /controlled identity append failed/);
    assert.equal(admissions, 0, 'failed identity append must precede all execution preparation');
    assert.equal(factories, 0);
    assert.equal(service.listTasks().counts.total, 1);
    const taskId = service.listTasks().draft[0]!.taskId;
    assert.equal(await taskIdentity.read({ organId, taskId }), undefined);
    const persisted = journal.replay().filter((record) => record.kind === 'explicit-brain.state').at(-1)!;
    if (persisted.kind !== 'explicit-brain.state') throw new Error('missing actual explicit state');
    const state = persisted.state as typeof persisted.state & { readonly finalSubmissions: readonly PersistedFinalSubmitReceipt[] };
    for (const mismatch of ['fifoSeq', 'payloadRef', 'missing'] as const) {
      const mismatchedState = {
        ...state,
        finalSubmissions: mismatch === 'missing' ? [] : state.finalSubmissions.map((entry) => ({ ...entry,
          requirement: { ...entry.requirement,
            ...(mismatch === 'fifoSeq' ? { fifoSeq: entry.requirement.fifoSeq + 1 } : { payloadRef: 'asset://wrong-source' }),
          },
        })),
      };
      journal.append({ kind: 'explicit-brain.state', state: mismatchedState });
      const cold = new UiRuntimeService(serviceOptions);
      await cold.hydrate();
      await assert.rejects(() => cold.dispatchNextExplicitRequirement(), /no exact typed final-submit source/);
      assert.equal(admissions, 0, 'source mismatch must not prepare/release or acknowledge the pending requirement');
      assert.equal(factories, 0);
      await cold.quiesceImplicitConsumption();
      journal.append(persisted);
    }
    const conflictingIdentity = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(new JsonlOrganJournal(join(root, 'conflict-control.jsonl'))));
    await conflictingIdentity.establish({ scope: { organId, taskId }, source: {
      requirementId: receipt.requirement.requirementId, draftId: receipt.requirement.draftId,
      inputRevision: receipt.requirement.inputRevision, draftRevisionVersion: preview.revision!.revisionVersion,
      draftRevisionHash: preview.revision!.revisionHash, confirmationRef: 'confirmation:another-source',
    } });
    const conflict = new UiRuntimeService({ ...serviceOptions, taskIdentity: conflictingIdentity });
    await conflict.hydrate();
    await assert.rejects(() => conflict.dispatchNextExplicitRequirement(), /conflict|different|immutable/i);
    assert.equal(admissions, 0);
    assert.equal(factories, 0);
    await conflict.quiesceImplicitConsumption();
    journal.append(persisted);
    failAppend = false;
    const dispatched = await service.dispatchNextExplicitRequirement();
    assert.equal(dispatched.taskId.value, taskId.value, 'retry must retain the actual Task');
    const identity = await taskIdentity.read({ organId, taskId });
    assert.deepEqual(identity?.source, {
      requirementId: receipt.requirement.requirementId, draftId: receipt.requirement.draftId,
      inputRevision: receipt.requirement.inputRevision, draftRevisionVersion: preview.revision!.revisionVersion,
      draftRevisionHash: preview.revision!.revisionHash, confirmationRef: 'confirmation:source-consumer',
    });
    assert.equal(factories, 0, 'missing grant must not reach the target execution factory');
    assert.equal(admissions, 1, 'same coordinator must reach the injected execution admission');
    console.log(JSON.stringify({ receipt, taskId, source: identity?.source, factories, admissions }));
    await service.quiesceImplicitConsumption();
  } finally { await rm(root, { recursive: true, force: true }); }
});

function digest(args: Readonly<Record<string, unknown>>): string {
  const stable = JSON.stringify(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${createHash('sha256').update(stable).digest('hex')}`;
}

async function runWorkspaceSearch(root: string, query: string, limit: number, scopeRef = 'scope:workspace:project-a') {
  const runtime = createExplicitBrainRuntime({
    workspaceRoot: await realpath(root),
    projectKey: 'project-a',
    traces: new DecisionTraceStore(),
  });
  const args = { scopeRef, query, limit };
  const [result] = await runtime.execute({
    decisionId: `decision:search-${query}-${limit}`,
    interactionId: `interaction:search-${query}-${limit}`,
    kind: 'intent',
    selectedAction: 'answer',
    summary: 'search the bound workspace',
    evidenceRefs: [],
    toolIntents: [{
      toolIntentId: `intent:search-${query}-${limit}`,
      toolRef: 'file.search',
      arguments: args,
      argumentsDigest: digest(args),
      reasonRefs: [],
      selectedBecause: 'workspace evidence is required',
    }],
  });
  return result as { readonly query: string; readonly matches: readonly { readonly path: string; readonly lines: readonly number[] }[]; readonly complete: boolean };
}

test('application explicit brain runtime reports whether file.search exhausted discovered candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-search-'));
  try {
    await writeFile(join(root, 'a-hit.txt'), 'needle\n', 'utf8');
    await writeFile(join(root, 'b-unscanned.txt'), 'other\n', 'utf8');
    const limited = await runWorkspaceSearch(root, 'needle', 1);
    assert.deepEqual(limited.matches, [{ path: 'a-hit.txt', lines: [1] }]);
    assert.equal(limited.complete, false);

    const fullScan = await runWorkspaceSearch(root, 'absent', 2);
    assert.deepEqual(fullScan.matches, []);
    assert.equal(fullScan.complete, true);

    await writeFile(join(root, 'c-last-hit.txt'), 'last-hit\n', 'utf8');
    const lastCandidate = await runWorkspaceSearch(root, 'last-hit', 1);
    assert.deepEqual(lastCandidate.matches, [{ path: 'c-last-hit.txt', lines: [1] }]);
    assert.equal(lastCandidate.complete, true);

    await assert.rejects(
      () => runWorkspaceSearch(root, 'needle', 1, 'scope:workspace:other-project'),
      /workspace scope is not registered/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application explicit brain runtime does not call an incomplete discovery complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-search-incomplete-'));
  try {
    await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(root, `${index.toString().padStart(3, '0')}.txt`), 'absent\n', 'utf8')));
    const result = await runWorkspaceSearch(root, 'needle', 1);
    assert.deepEqual(result.matches, []);
    assert.equal(result.complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application explicit brain runtime preserves file.search read failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-search-read-failure-'));
  const unreadableFile = join(root, 'unreadable.txt');
  try {
    await writeFile(unreadableFile, 'needle\n', 'utf8');
    await chmod(unreadableFile, 0o000);
    await assert.rejects(() => runWorkspaceSearch(root, 'needle', 1), /read-failed|permission denied|EACCES/i);
  } finally {
    await chmod(unreadableFile, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('application explicit brain runtime dispatches a read-only workspace tool through its real owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'README.md'), 'checkpoint owner\n', 'utf8');
  const workspaceRoot = await realpath(root);
  const runtime = createExplicitBrainRuntime({
    workspaceRoot,
    projectKey: 'project-a',
    traces: new DecisionTraceStore(),
  });
  const args = { scopeRef: 'scope:workspace:project-a', pathRef: 'src/README.md' };
  const [result] = await runtime.execute({
    decisionId: 'decision:app-runtime',
    interactionId: 'interaction:app-runtime',
    kind: 'intent',
    selectedAction: 'answer',
    summary: 'read the workspace evidence',
    evidenceRefs: [],
    toolIntents: [{
      toolIntentId: 'intent:file-read',
      toolRef: 'file.read',
      arguments: args,
      argumentsDigest: digest(args),
      reasonRefs: [],
      selectedBecause: 'workspace evidence is required',
    }],
  });
  assert.deepEqual(result, { path: 'src/README.md', content: 'checkpoint owner\n' });
});

test('application explicit brain runtime rejects a workspace scope outside its binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-scope-'));
  const runtime = createExplicitBrainRuntime({ workspaceRoot: await realpath(root), projectKey: 'project-a', traces: new DecisionTraceStore() });
  const args = { scopeRef: 'scope:workspace:other-project', pathRef: 'README.md' };
  await assert.rejects(
    () => runtime.execute({
      decisionId: 'decision:app-runtime-scope',
      interactionId: 'interaction:app-runtime-scope',
      kind: 'intent',
      selectedAction: 'answer',
      summary: 'read outside the workspace binding',
      evidenceRefs: [],
      toolIntents: [{
        toolIntentId: 'intent:file-read-scope',
        toolRef: 'file.read',
        arguments: args,
        argumentsDigest: digest(args),
        reasonRefs: [],
        selectedBecause: 'test',
      }],
    }),
    /workspace scope is not registered/,
  );
});

test('application explicit brain runtime lists a path within its registered workspace scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-list-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'README.md'), 'workspace list\n', 'utf8');
  const runtime = createExplicitBrainRuntime({
    workspaceRoot: await realpath(root),
    projectKey: 'project-a',
    traces: new DecisionTraceStore(),
  });
  const args = { scopeRef: 'scope:workspace:project-a', pathRef: 'src' };
  const [result] = await runtime.execute({
    decisionId: 'decision:app-runtime-list',
    interactionId: 'interaction:app-runtime-list',
    kind: 'intent',
    selectedAction: 'answer',
    summary: 'list workspace evidence',
    evidenceRefs: [],
    toolIntents: [{
      toolIntentId: 'intent:workspace-list',
      toolRef: 'workspace.list',
      arguments: args,
      argumentsDigest: digest(args),
      reasonRefs: [],
      selectedBecause: 'workspace evidence is required',
    }],
  });
  assert.deepEqual(
    {
      paths: (result as { readonly paths: readonly string[] }).paths,
      complete: (result as { readonly complete: boolean }).complete,
    },
    { paths: ['src/README.md'], complete: true },
  );
});

test('application explicit brain runtime requires registered agent identity and preserves decision traces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-explicit-brain-runtime-agent-'));
  const persisted: import('../../packages/contracts/src/index.js').DecisionTraceRecord[] = [];
  const traces = new DecisionTraceJournal({
    load: () => persisted,
    persist: (record) => persisted.push(record),
  });
  const queried: Array<{ readonly agentRef: string; readonly scopeRef: string }> = [];
  const runtime = createExplicitBrainRuntime({
    workspaceRoot: await realpath(root),
    projectKey: 'project-a',
    traces,
    agentTargets: [{
      agentRef: 'agent:orchestration-a',
      scopeRef: 'scope:task-a',
      queryable: true,
      messageClasses: ['control'],
    }],
    queryAgent: async (input) => {
      queried.push(input);
      return { state: 'idle' };
    },
    sendAgentMessage: async (input) => ({ delivered: input.recipientRef }),
  });
  const args = { agentRef: 'agent:orchestration-a', scopeRef: 'scope:task-a' };
  const [result] = await runtime.execute({
    decisionId: 'decision:agent-query',
    interactionId: 'interaction:agent-query',
    kind: 'intent',
    selectedAction: 'answer',
    summary: 'query the registered orchestrator',
    evidenceRefs: [],
    toolIntents: [{
      toolIntentId: 'intent:agent-query',
      toolRef: 'agent.query',
      arguments: args,
      argumentsDigest: digest(args),
      reasonRefs: [],
      selectedBecause: 'the registered orchestrator owns task state',
    }],
  });
  assert.deepEqual(result, { state: 'idle' });
  assert.deepEqual(queried, [{ agentRef: 'agent:orchestration-a', scopeRef: 'scope:task-a' }]);
  assert.equal(persisted.length, 1);
  await assert.rejects(
    () => runtime.ports.agent.message({
      binding: runtime.binding,
      recipientRef: 'agent:unknown',
      messageRef: 'message:unknown',
      messageClass: 'control',
    }),
    /agent target is not registered/,
  );

  const recreated = new DecisionTraceJournal({ load: () => persisted, persist: (record) => persisted.push(record) });
  assert.equal(recreated.query({ interactionRef: 'interaction:agent-query' }).length, 1);
  await assert.rejects(
    () => runtime.execute({
      decisionId: 'decision:unknown-agent',
      interactionId: 'interaction:unknown-agent',
      kind: 'intent',
      selectedAction: 'answer',
      summary: 'query an unregistered agent',
      evidenceRefs: [],
      toolIntents: [{
        toolIntentId: 'intent:unknown-agent',
        toolRef: 'agent.query',
        arguments: { agentRef: 'agent:unknown' },
        argumentsDigest: digest({ agentRef: 'agent:unknown' }),
        reasonRefs: [],
        selectedBecause: 'test',
      }],
    }),
    /agent target is not registered/,
  );
});

test('provider explicit brain interpreter loads the interaction template and validates typed intake output', async () => {
  const binding: ProviderBinding = {
    bindingId: 'binding-explicit-interpret',
    providerId: 'provider-explicit-interpret',
    protocol: 'responses',
    endpointRef: 'fake://explicit-interpret',
    modelRef: 'model-explicit-interpret',
    configDigest: 'sha256:explicit-interpret-config',
    capabilityDigest: 'sha256:explicit-interpret-capability',
  };
  const options = {
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new FakeReplayExecutionRuntimePort({
      binding,
      stepDelayMs: 0,
      replay: [
        {
          kind: 'output',
          state: 'output',
          summary: JSON.stringify({
            kind: 'requirement',
            normalizedInput: '整理启动步骤',
            knownFacts: ['README exists'],
            proposal: {
              revision: 1,
              intent: 'create',
              title: '整理启动步骤',
              objective: '整理项目启动步骤',
              deliverable: '可执行的启动步骤清单',
              owner: null,
              ownerNote: '运行时将在确认后决定执行 owner。',
              deliveryConditions: ['启动步骤完整并有证据'],
              evidenceRefs: ['README'],
              blockingGaps: [],
              lifecycle: 'draft -> awaiting-user-confirmation -> requirement.submit',
              requiresUserConfirmation: true,
              confirmationPrompt: '是否确认并提交该需求？',
            },
            decisionRefs: ['decision:provider-test'],
          }),
        },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  };

  // Confirmed shared-pair gap; probability unknown, wrong source/model has high
  // impact. Extend this consumer with one local selected wire, not a matrix.
  const posts: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.method === 'POST') posts.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { type: 'response.created', response: { id: `selected-${posts.length}` } },
        { type: 'response.output_text.done', item_id: 'message-final', text: JSON.stringify({
          kind: 'requirement', normalizedInput: '整理启动步骤', knownFacts: ['README exists'],
          proposal: {
            revision: 1, intent: 'create', title: '整理启动步骤', objective: '整理项目启动步骤',
            deliverable: '可执行的启动步骤清单', owner: null, ownerNote: '运行时决定 owner。',
            deliveryConditions: ['启动步骤完整并有证据'], evidenceRefs: ['README'], blockingGaps: [],
            lifecycle: 'draft -> awaiting-user-confirmation -> requirement.submit',
            requiresUserConfirmation: true, confirmationPrompt: '是否确认并提交该需求？',
          }, decisionRefs: ['decision:provider-test'],
        }) },
        { type: 'response.completed', response: { id: `selected-${posts.length}` } },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch((error: unknown) => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing socket address');
  const root = await mkdtemp(join(tmpdir(), 'interaction-selected-'));
  const entries: EffectiveAgentProviderBinding[] = [{
    agentId: 'configured-interaction', roleId: 'interaction', source: 'agent',
    provider: { source: 'http', provider: 'http', binding: 'selected-interaction', protocol: 'responses',
      model: 'selected.interaction.model', route: 'selected-route', baseUrl: `http://127.0.0.1:${address.port}` },
  }];
  const compositions: AgentProviderComposition[] = [];
  const lifecycle: string[] = [];
  const starts: Parameters<AgentProviderComposition['port']['start']>[0][] = [];
  const observations: Parameters<AgentProviderComposition['port']['observe']>[0][] = [];
  let borrowedStarts = 0;
  const primaryStart = options.port.start.bind(options.port);
  options.port.start = async (request) => { borrowedStarts += 1; return primaryStart(request); };
  const selectedOptions = {
    ...options,
    prepareAgentProvider: async (selection: { readonly roleId: AgentRole; readonly configuredAgentId?: string }) => {
      assert.deepEqual(selection, { roleId: 'interaction' });
      const own = await prepareAgentProvider({ ...selection, agentProviderBindings: entries, evidenceRoot: root });
      assert.equal(own.configuredAgentId, 'configured-interaction');
      assert.equal(own.source, 'http');
      assert.equal(own.binding.modelRef, 'selected.interaction.model');
      const index = compositions.length;
      compositions.push(own);
      const start = own.port.start.bind(own.port);
      const settle = own.port.settle.bind(own.port);
      const close = own.port.close.bind(own.port);
      const observe = own.port.observe.bind(own.port);
      own.port.start = async (request) => { starts.push(request); return start(request); };
      own.port.observe = (request) => { observations.push(request); return observe(request); };
      own.port.settle = async (request) => {
        assert.equal(request.runtimeId, starts[index].runtimeId);
        const receipt = await settle(request); lifecycle.push(`${index}:settled`); return receipt;
      };
      own.port.close = async (binding) => {
        assert.equal(binding, own.binding);
        const receipt = await close(binding); lifecycle.push(`${index}:closed`); return receipt;
      };
      return own;
    },
  };
  const interpreter = createProviderExplicitBrainInterpreter(selectedOptions);

  try {

  const result = await interpreter.interpret({
    interactionId: 'interaction-provider-test',
    inputRevision: 1,
    sourceRef: 'ui:new-task',
    rawInput: '帮我整理启动步骤',
    clarifications: [],
    taskCandidates: [],
  });

  assert.equal(result.kind, 'requirement');
  if (result.kind !== 'requirement') throw new Error('expected requirement interpretation');
  assert.equal(result.normalizedInput, '整理启动步骤');
  assert.equal(result.intent, 'create');
  assert.match(result.proposal, /可执行的启动步骤清单/);
  assert.equal(result.proposal.includes('awaiting-user-confirmation'), false);
  assert.equal(compositions.length, 1, 'selected interaction callback must run');
  assert.deepEqual(lifecycle, ['0:settled', '0:closed']);
  await interpreter.interpret({ interactionId: 'interaction-provider-second', inputRevision: 1,
    sourceRef: 'ui:second', rawInput: '第二次独立输入', clarifications: [], taskCandidates: [] });
  assert.equal(compositions.length, 2);
  assert.ok(compositions[0].port !== compositions[1].port);
  assert.ok(starts[0].runtimeId !== starts[1].runtimeId);
  assert.ok(starts[0].taskId.value !== starts[1].taskId.value);
  assert.ok(observations[0].requestId !== undefined);
  assert.ok(observations[1].requestId !== undefined);
  assert.ok(observations[0].requestId !== observations[1].requestId);
  assert.ok(observations[0].turnId !== observations[1].turnId);
  assert.deepEqual(starts.map((start) => start.inputRefs), [
    ['humanagent://interaction/interaction-provider-test/revision/1'],
    ['humanagent://interaction/interaction-provider-second/revision/1'],
  ]);
  assert.equal(borrowedStarts, 0);
  assert.equal(posts.length, 2);
  for (const body of posts) assert.equal(JSON.parse(body).model, 'selected.interaction.model');
  assert.ok(posts[0].includes('帮我整理启动步骤'));
  assert.ok(posts[1].includes('第二次独立输入'));
  assert.ok(posts[1].includes('ui:second'));
  assert.equal(posts[1].includes('帮我整理启动步骤'), false);
  assert.deepEqual(lifecycle, ['0:settled', '0:closed', '1:settled', '1:closed']);
  } finally {
    server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(server.address(), null);
    await rm(root, { recursive: true, force: true });
    await assert.rejects(() => realpath(root), /ENOENT/);
  }

  const malformedOptions = {
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new FakeReplayExecutionRuntimePort({
      binding,
      stepDelayMs: 0,
      replay: [
        {
          kind: 'output',
          state: 'output',
          summary: JSON.stringify({
            kind: 'requirement',
            normalizedInput: '整理启动步骤',
            knownFacts: [],
            proposal: { objective: '未经过 typed contract 的任意对象' },
            decisionRefs: [],
          }),
        },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  };
  const malformedLifecycle: string[] = [];
  const malformedSettle = malformedOptions.port.settle.bind(malformedOptions.port);
  const malformedClose = malformedOptions.port.close.bind(malformedOptions.port);
  malformedOptions.port.settle = async (request) => {
    malformedLifecycle.push('settle');
    return malformedSettle(request);
  };
  malformedOptions.port.close = async (binding) => {
    assert.equal(binding, malformedOptions.binding);
    malformedLifecycle.push('close');
    return malformedClose(binding);
  };
  const arbitraryProposal = createProviderExplicitBrainInterpreter({
    ...malformedOptions,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http',
      provider: entries[0].provider!, binding, port: malformedOptions.port }),
  });
  const malformedInput = {
    interactionId: 'interaction-arbitrary-proposal', inputRevision: 1, sourceRef: 'ui:new-task',
    rawInput: '帮我整理启动步骤', clarifications: [], taskCandidates: [],
  };
  await assert.rejects(
    () => arbitraryProposal.interpret(malformedInput),
    /does not match the structured proposal contract/,
  );
  assert.deepEqual(malformedLifecycle, ['settle', 'close']);

  // Driver.submit reaches start, not port.submit. An unaccepted request has
  // no invented settlement; original request and cleanup errors stay intact.
  const originalStart = malformedOptions.port.start.bind(malformedOptions.port);
  const startError = new Error('actual start rejection');
  const closeError = new Error('owned close rejection');
  malformedLifecycle.length = 0;
  malformedOptions.port.start = async () => { malformedLifecycle.push('start'); throw startError; };
  malformedOptions.port.close = async () => { malformedLifecycle.push('close'); throw closeError; };
  await assert.rejects(() => arbitraryProposal.interpret(malformedInput), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    assert.equal(error.errors[0], startError);
    assert.equal(error.errors[1], closeError);
    return true;
  });
  assert.deepEqual(malformedLifecycle, ['start', 'close']);

  // Fail observation after accepted start, with a real terminal fake session
  // available to settle. One required settle precedes the owned close.
  malformedOptions.port.start = originalStart;
  const originalObserve = malformedOptions.port.observe.bind(malformedOptions.port);
  const observationError = new Error('observation rejection');
  malformedOptions.port.observe = async function* (request) {
    for await (const event of originalObserve(request)) {
      if (event.terminalState !== undefined) throw observationError;
      yield event;
    }
  };
  malformedOptions.port.close = async (binding) => {
    malformedLifecycle.push('close'); return malformedClose(binding);
  };
  malformedLifecycle.length = 0;
  await assert.rejects(() => arbitraryProposal.interpret(malformedInput), (error: unknown) => error === observationError);
  assert.deepEqual(malformedLifecycle, ['settle', 'close']);

  const settleError = new Error('settlement rejection');
  malformedOptions.port.settle = async () => { malformedLifecycle.push('settle'); throw settleError; };
  malformedOptions.port.close = async (binding) => {
    malformedLifecycle.push('close'); await malformedClose(binding); throw closeError;
  };
  malformedLifecycle.length = 0;
  await assert.rejects(() => arbitraryProposal.interpret(malformedInput), (error: unknown) => {
    if (!(error instanceof AggregateError)) throw error;
    const executionError: unknown = error.errors[0];
    if (!(executionError instanceof AggregateError)) throw executionError;
    assert.equal(executionError.errors[0], observationError);
    assert.equal(executionError.errors[1], settleError);
    assert.equal(error.errors[1], closeError);
    return true;
  });
  assert.deepEqual(malformedLifecycle, ['settle', 'close']);

  // A normal settle rejection is not retried by error cleanup.
  malformedOptions.port.observe = originalObserve;
  malformedLifecycle.length = 0;
  await assert.rejects(() => arbitraryProposal.interpret(malformedInput), (error: unknown) => {
    if (!(error instanceof AggregateError)) throw error;
    assert.equal(error.errors[0], settleError);
    assert.equal(error.errors[1], closeError);
    return true;
  });
  assert.deepEqual(malformedLifecycle, ['settle', 'close']);
});

test('provider explicit brain interpreter accepts the live requirement contract with intent owned by proposal', async () => {
  const binding: ProviderBinding = {
    bindingId: 'binding-explicit-live-requirement',
    providerId: 'provider-explicit-live-requirement',
    protocol: 'responses',
    endpointRef: 'fake://explicit-live-requirement',
    modelRef: 'model-explicit-live-requirement',
    configDigest: 'sha256:explicit-live-requirement-config',
    capabilityDigest: 'sha256:explicit-live-requirement-capability',
  };
  const options = {
    binding,
    templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
    port: new FakeReplayExecutionRuntimePort({
      binding,
      stepDelayMs: 0,
      replay: [
        {
          kind: 'output',
          state: 'output',
          summary: JSON.stringify({
            kind: 'requirement',
            normalizedInput: '只读整理项目启动检查清单并提出待审核的项目记忆候选',
            knownFacts: ['输入来自 ui:new-task', '交付命令必须来自实际文件'],
            proposal: {
              revision: 1,
              intent: 'create',
              title: 'HumanAgent 项目中文启动检查清单',
              objective: '读取项目文档并整理有来源的启动检查清单',
              deliverable: '一份可查看的中文 Markdown 启动检查清单',
              owner: null,
              ownerNote: '运行时在需求确认后决定执行 owner。',
              deliveryConditions: ['每条命令和结论均标注文件路径与行号'],
              evidenceRefs: ['ui:new-task', 'interaction-1#inputRevision=1'],
              blockingGaps: ['尚未读取 README.md 与 package.json'],
              lifecycle: 'draft-awaiting-user-confirmation',
              requiresUserConfirmation: true,
              confirmationPrompt: '请确认 revision 1 的需求草案。',
            },
            decisionRefs: ['interaction-1#sourceRef=ui:new-task'],
          }),
        },
        { kind: 'terminal', state: 'succeeded', summary: 'done', terminalState: 'succeeded' },
      ],
    }),
  };
  let borrowedCloses = 0;
  const close = options.port.close.bind(options.port);
  options.port.close = async (binding) => { borrowedCloses += 1; return close(binding); };
  const interpreter = createProviderExplicitBrainInterpreter(options);

  const result = await interpreter.interpret({
    interactionId: 'interaction-1',
    inputRevision: 1,
    sourceRef: 'ui:new-task',
    rawInput: '整理项目启动检查清单',
    clarifications: [],
    taskCandidates: [],
  });

  assert.equal(result.kind, 'requirement');
  if (result.kind !== 'requirement') throw new Error('expected requirement interpretation');
  assert.equal(result.intent, 'create');
  assert.match(result.proposal, /HumanAgent 项目中文启动检查清单/);
  assert.equal(borrowedCloses, 0);

  // Successful-path close rejects directly and gets exactly one attempt.
  const closeError = new Error('successful interpretation close rejection');
  let ownCloses = 0;
  options.port.close = async (binding) => { ownCloses += 1; await close(binding); throw closeError; };
  const ownedInterpreter = createProviderExplicitBrainInterpreter({ ...options,
    prepareAgentProvider: async () => ({ roleId: 'interaction', source: 'http', binding, port: options.port,
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'existing-fixture', baseUrl: binding.endpointRef } }),
  });
  await assert.rejects(() => ownedInterpreter.interpret({ interactionId: 'interaction-close', inputRevision: 1,
    sourceRef: 'ui:new-task', rawInput: '整理项目启动检查清单', clarifications: [], taskCandidates: [] }),
  (error: unknown) => error === closeError);
  assert.equal(ownCloses, 1);
});
