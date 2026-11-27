import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type AnyProviderExecutionIdentityRef, type ProviderExecutionIdentityRef } from '../../packages/contracts/src/index.js';
import type { AgentRole, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { createAgentProviderPort, prepareAgentProvider, prepareExecutionAgentProvider } from '../../packages/app/src/agent-driver-composition.js';
import { startUiRuntime, type UiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { uiRuntimeModeRoot, uiRuntimeControlJournalPath } from '../../packages/app/src/ui-runtime/journal.js';
import { acquireDaemonLease } from '../../packages/app/src/supervisor/index.js';

// Public HTTP -> service -> default explicit interpreter -> actual HTTP
// Provider. A mock interpreter would miss composition budget wiring entirely.
// Reachable continuous-delta defect, high impact; short budgets keep cost low.
test('explicit HTTP composition completes legal streams and aborts budget exhaustion', async () => {
  const base = process.env.HUMANAGENT_TEST_ROOT ?? join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'explicit-budget-http-'));
  let runtime: UiRuntime | undefined;
  let endless = false;
  let produced = 0;
  let producerClosed = false;
  let stops = 0;
  const schedulerWorkspace = join(root, 'scheduler-workspace');
  await mkdir(schedulerWorkspace, { recursive: true });
  const schedulerPaths = await resolveRuntimePaths({
    controlRoot: join(root, 'scheduler-control'),
    workspace: schedulerWorkspace,
  });
  await ensureControlLayout(schedulerPaths);
  const evidenceRoot = join(schedulerPaths.artifactsRoot, 'ui-provider-evidence');
  const schedulerLease = await acquireDaemonLease(schedulerPaths, { ownerId: 'explicit-budget-http' });
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.end('{}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { readonly tools?: unknown };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    if (!endless && wire.tools === undefined) {
      frame({ type: 'response.created', response: { id: 'controlled-explicit-drain' } });
      frame({ type: 'response.output_text.done', item_id: 'drain-answer', text: 'transport drained' });
      frame({ type: 'response.completed', response: { id: 'controlled-explicit-drain' } });
      response.end();
      return;
    }
    frame({ type: 'response.created', response: { id: 'controlled-explicit' } });
    let count = 0;
    const timer = setInterval(() => {
      produced += 1;
      frame({ type: 'response.reasoning_summary_text.delta', item_id: 'reasoning', delta: 'thinking' });
      count += 1;
      if (!endless && count === 4) {
        frame({ type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call',
          id: 'controlled-explicit-end-item',
          call_id: 'controlled-explicit-end-call',
          name: 'humanagent_turn_end',
          arguments: JSON.stringify({
            kind: 'simple',
            decision: { kind: 'answer', normalizedInput: 'hello', knownFacts: [], decisionRefs: [], answer: 'hello' },
            checkpointRecord: { index: { action: '回答用户问题', result: '已回答' } },
          }),
        } });
        frame({ type: 'response.completed', response: { id: 'controlled-explicit' } });
        clearInterval(timer);
        response.end();
      }
    }, 20);
    (response as typeof response & { on(event: 'close', listener: () => void): void })
      .on('close', () => { clearInterval(timer); producerClosed = true; });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('missing Provider port');
    const bindings: EffectiveAgentProviderBinding[] = [{ agentId: 'explicit-budget', roleId: 'interaction', source: 'agent',
      provider: { source: 'http', provider: 'http', binding: 'explicit-budget', protocol: 'responses',
        model: 'controlled', route: 'controlled', baseUrl: `http://127.0.0.1:${address.port}` } }];
    const prepare = async <T extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(selection: { roleId: AgentRole; configuredAgentId?: string }) => {
      const composition = await prepareAgentProvider<T>({ ...selection, agentProviderBindings: bindings, evidenceRoot });
      const stop = composition.port.requestStop.bind(composition.port);
      composition.port.requestStop = async (request) => { stops += 1; return stop(request); };
      return composition;
    };
    const launch = await prepare({ roleId: 'interaction' });
    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'security/web-access.json'), create: true });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    runtime = await startUiRuntime({ mode: 'rcc', organId: id('organ', 'explicit-budget-http'),
      binding: launch.binding, port: launch.port, providerSource: launch.source,
      productRoot: schedulerPaths.controlRoot,
      checkpointRoot: join(schedulerPaths.checkpointsRoot, 'ui-runtime'),
      evidenceRoot,
      interactionRoot: schedulerPaths.mainRoot, workspaceRoot: schedulerPaths.workspaceCwd,
      projectKey: schedulerPaths.projectKey,
      uiRoot: join(process.cwd(), 'packages/ui/static'), portNumber: 0, accessControl,
      explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      executionBudget: { maxSilentDurationMs: 3000, noProgressAtMs: 1500, maxTurnDurationMs: 5000 },
      lease: () => schedulerLease,
      runtimePaths: schedulerPaths,
      runtimeComposition: { prepareAgentProvider: prepare,
        prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({
          roleId: selection.roleId,
          ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
          agentProviderBindings: bindings,
          createPort: (selected) => createAgentProviderPort(selected, evidenceRoot),
        }, owner, lease) },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: schedulerPaths.projectKey },
    });
    await runtime.service.quiesceImplicitConsumption();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${runtime!.server.url}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: runtime!.server.url }, body: JSON.stringify(body) });
      return { status: response.status, text: await response.text() };
    };
    const receive = async (source: string) => {
      const response = await post('/api/explicit/inputs', { sourceRef: source, rawInput: 'hello', channel: 'business' });
      assert.equal(response.status, 201);
      return (JSON.parse(response.text) as { interactionId: string }).interactionId;
    };
    const first = await receive('ui:legal');
    const legal = await post(`/api/explicit/interactions/${first}/interpret`, {});
    assert.equal(legal.status, 200, legal.text);
    assert.ok(legal.text.includes('hello'));
    assert.equal(stops, 0, 'legal continuous partials are not stopped');
    endless = true;
    producerClosed = false;
    const second = await receive('ui:budget');
    const failed = await post(`/api/explicit/interactions/${second}/interpret`, {});
    assert.ok(failed.status >= 400, failed.text);
    assert.ok(failed.text.includes('no completed content unit'), failed.text);
    assert.equal(stops, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(producerClosed, true, 'the actual Provider connection was closed');
    // The runtime writes its control journal at <checkpointRoot>/<mode>/task-control.jsonl,
    // where checkpointRoot already includes the ui-runtime root in this fixture.
    const controlJournalPath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(schedulerPaths.checkpointsRoot, 'rcc'));
    const parent = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(controlJournalPath));
    const opened = await parent.readScopeOpenedTurns({ organId: id('organ', 'explicit-budget-http'),
      interactionScopeId: `runtime:${schedulerPaths.projectKey}` });
    const turn = opened.find(({ fact }) => fact.turn.interactionId === second)?.fact.turn;
    assert.ok(turn);
    if (turn === undefined) throw new Error('missing budget execution turn');
    const settled = await parent.readTurnSnapshot(turn);
    assert.equal(settled.resourceClose?.fact.result.state, 'closed');
    assert.ok(settled.executionFailure, 'the eligible stopped epoch was durably discharged');
    const after = produced;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(produced, after, 'the producer stopped, rather than events being ignored');
    assert.deepEqual(await parent.readTurnSnapshot(turn), settled, 'no late execution facts arrive after cleanup');
  } finally {
    await runtime?.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await schedulerLease.release();
    await rm(root, { recursive: true, force: true });
  }
});

// Failure basis: a model can emit an overlong title, and a workspace-carrying
// input could otherwise be recorded in another project. Impact: misleading
// product title or cross-project intake. Cost: one isolated HTTP runtime and
// two provider rounds.
test('explicit HTTP public entry caps the task title and rejects a foreign workspace', async () => {
  const base = process.env.HUMANAGENT_TEST_ROOT ?? join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'explicit-title-http-'));
  let runtime: UiRuntime | undefined;
  const runtimeWorkspace = join(root, 'runtime-workspace');
  const foreignWorkspace = join(root, 'foreign-workspace');
  await mkdir(runtimeWorkspace, { recursive: true });
  await mkdir(foreignWorkspace, { recursive: true });
  const runtimePaths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: runtimeWorkspace });
  await ensureControlLayout(runtimePaths);
  const evidenceRoot = join(runtimePaths.artifactsRoot, 'ui-provider-evidence');
  const lease = await acquireDaemonLease(runtimePaths, { ownerId: 'explicit-title-http' });
  const body = '完整任务正文必须保留'.repeat(12);
  const longTitle = '超'.repeat(60) + '🙂';
  const expectedTitle = '超'.repeat(50);
  let modelRounds = 0;
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.end('{}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { readonly tools?: unknown; readonly input?: readonly any[] };
    const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const drain = () => {
      frame({ type: 'response.created', response: { id: 'title-drain' } });
      frame({ type: 'response.output_text.done', item_id: 'title-drain-text', text: 'transport drained' });
      frame({ type: 'response.completed', response: { id: 'title-drain' } });
      response.end();
    };
    if (wire.tools === undefined) { drain(); return; }
    modelRounds += 1;
    if (modelRounds > 1 || (wire.input ?? []).some((item) => item?.type === 'function_call_output')) {
      drain();
      return;
    }
    const endArguments = JSON.stringify({
      kind: 'complex',
      decision: {
        kind: 'requirement',
        normalizedInput: body,
        knownFacts: [],
        decisionRefs: [],
        taskFlow: { kind: 'one-shot', definitionVersion: 1 },
        proposal: {
          revision: 1,
          intent: 'create',
          title: longTitle,
          objective: body,
          deliverable: body,
          deliveryConditions: [],
          evidenceRefs: [],
          blockingGaps: [],
        },
      },
      checkpointRecord: { index: { action: '整理用户需求', result: '已准备好执行' } },
      capsule: { summary: '已整理需求', goal: body, process: ['识别用户需求'], findings: [], nextStep: '交给隐式大脑执行' },
    });
    frame({ type: 'response.created', response: { id: 'title-end' } });
    frame({ type: 'response.output_item.done', output_index: 0, item: {
      type: 'function_call', id: 'title-end-item', call_id: 'title-end-call',
      name: 'humanagent_turn_end', arguments: endArguments,
    } });
    frame({ type: 'response.completed', response: { id: 'title-end' } });
    response.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('missing Provider port');
    const bindings: EffectiveAgentProviderBinding[] = [{ agentId: 'explicit-title', roleId: 'interaction', source: 'agent',
      provider: { source: 'http', provider: 'http', binding: 'explicit-title', protocol: 'responses',
        model: 'controlled', route: 'controlled', baseUrl: `http://127.0.0.1:${address.port}` } }];
    const prepare = async <T extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(selection: { roleId: AgentRole; configuredAgentId?: string }) => {
      const composition = await prepareAgentProvider<T>({ ...selection, agentProviderBindings: bindings, evidenceRoot });
      return composition;
    };
    const launch = await prepare({ roleId: 'interaction' });
    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'security/web-access.json'), create: true });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    runtime = await startUiRuntime({ mode: 'rcc', organId: id('organ', 'explicit-title-http'),
      binding: launch.binding, port: launch.port, providerSource: launch.source,
      productRoot: runtimePaths.controlRoot,
      checkpointRoot: join(runtimePaths.checkpointsRoot, 'ui-runtime'),
      evidenceRoot,
      interactionRoot: runtimePaths.mainRoot, workspaceRoot: runtimePaths.workspaceCwd,
      projectKey: runtimePaths.projectKey,
      uiRoot: join(process.cwd(), 'packages/ui/static'), portNumber: 0, accessControl,
      explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      lease: () => lease,
      runtimePaths,
      runtimeComposition: { prepareAgentProvider: prepare,
        prepareTaskAgentProvider: (selection, owner, activeLease) => prepareExecutionAgentProvider({
          roleId: selection.roleId,
          ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
          agentProviderBindings: bindings,
          createPort: (selected) => createAgentProviderPort(selected, evidenceRoot),
        }, owner, activeLease) },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: runtimePaths.projectKey },
    });
    const post = async (path: string, payload: unknown) => {
      const response = await fetch(`${runtime!.server.url}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: runtime!.server.url }, body: JSON.stringify(payload) });
      return { status: response.status, text: await response.text() };
    };
    const receive = await post('/api/explicit/inputs', {
      sourceRef: 'ui:title-http', rawInput: body, channel: 'business', requestKind: 'new-task-create',
    });
    assert.equal(receive.status, 201, receive.text);
    const interactionId = (JSON.parse(receive.text) as { readonly interactionId: string }).interactionId;
    const interpreted = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {});
    assert.equal(interpreted.status, 200, interpreted.text);
    const snapshot = JSON.parse(interpreted.text) as {
      readonly rawInput: string;
      readonly draft?: { readonly proposal: string };
      readonly revision?: { readonly title?: string };
    };
    assert.equal(snapshot.rawInput, body);
    assert.equal(snapshot.revision?.title, expectedTitle);
    assert.equal(Array.from(snapshot.revision?.title ?? '').length, 50);
    assert.ok(snapshot.draft?.proposal.startsWith(expectedTitle));
    assert.ok(snapshot.draft?.proposal.includes(body));
    const readback = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}`, {
      headers: { cookie },
    });
    assert.equal(readback.status, 200);
    const readSnapshot = await readback.json() as { readonly revision?: { readonly title?: string } };
    assert.equal(readSnapshot.revision?.title, expectedTitle, 'persisted public title stays capped');
    const foreign = await post('/api/explicit/inputs', {
      sourceRef: 'ui:foreign', rawInput: 'foreign project request', channel: 'business', workspace: foreignWorkspace,
    });
    assert.equal(foreign.status, 409, foreign.text);
    assert.match(foreign.text, /workspace-outside-serve-scope/);
  } finally {
    await runtime?.close();
    const endpoint = provider.address();
    const port = endpoint !== null && typeof endpoint === 'object' ? endpoint.port : null;
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await lease.release();
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ titleHttpCleanup: { root, port,
      serverClosed: provider.address() === null, fixtureRemoved: true, leaseReleased: true } }));
  }
});
