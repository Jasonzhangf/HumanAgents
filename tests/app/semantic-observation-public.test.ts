import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ScopeRef,
  type AnyProviderExecutionIdentityRef,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionTurnIdentity,
  type ProviderStartInput,
} from '../../packages/contracts/src/index.js';
import { prepareAgentProvider } from '../../packages/app/src/agent-driver-composition.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { uiRuntimeControlJournalPath } from '../../packages/app/src/ui-runtime/journal.js';
import { filesystemProviderEvidenceSink } from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import {
  ensureControlLayout,
  resolveRuntimePaths,
  type AgentRole,
  type EffectiveAgentProviderBinding,
} from '../../packages/config/src/index.js';
import { acquireDaemonLease } from '../../packages/app/src/supervisor/index.js';
import {
  buildFakeExecutionPort,
  FakeReplayExecutionRuntimePort,
  startUiRuntime as startUiRuntimeOwner,
} from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { projectRuntimeSemanticObservation } from '../../packages/ui/projection/runtime.js';
import type { RuntimeSemanticObservationEnvelope } from '../../packages/ui/contracts/runtime.js';

const organId = id('organ', 'semantic-public-organ');
const binding = {
  bindingId: 'binding-semantic-public',
  providerId: 'provider-semantic-public',
  protocol: 'responses' as const,
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-semantic-public',
  configDigest: 'sha256:semantic-public-config',
  capabilityDigest: 'sha256:semantic-public-capability',
};

test('default explicit parent persists raw tool loop and explicitly accepts an independent helper', async () => {
  // Confirmed old default wiring omitted the parent owner and helper session.
  // Impact: fabricated Task identity and lost continuation context. Bounded
  // cost: three parent requests and one child, on one local HTTP server.
  const fixtureBase = process.env.HUMANAGENT_TEST_ROOT ?? '/Users/fanzhang/.humanagent/test-fixtures/provider-explicit-parent-wiring-20261016';
  await mkdir(fixtureBase, { recursive: true });
  const root = await mkdtemp(join(fixtureBase, 'default-parent-'));
  const checkpointRoot = join(root, 'checkpoints');
  const evidenceRoot = join(root, 'assets');
  const journalPath = uiRuntimeControlJournalPath(join(checkpointRoot, 'fake'));
  const controlJournal = new JsonlOrganJournal(journalPath);
  const parentJournal = new JsonlInteractionParentTurnJournal(controlJournal);
  const helperJournal = new JsonlInteractionHelperJournal(controlJournal);
  const rawContent = providerRawContentReader(filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot)));
  const parentStarts: ProviderStartInput<InteractionParentProviderExecutionIdentityRef>[] = [];
  const childStarts: AnyProviderExecutionIdentityRef[] = [];
  const requests: any[] = [];
  const lifecycle: string[] = [];
  let turn: InteractionTurnIdentity | undefined;
  let helperCallId = '';
  const refinedText = '精炼后采纳的正文，保留 helper 的 incomplete 判断。';
  const answer = `父最终回答：${'完整语义与字节。'.repeat(120)}`;
  const finalText = JSON.stringify({ kind: 'answer', normalizedInput: 'bounded parent question',
    knownFacts: ['accepted refined helper'], answer, decisionRefs: ['final-parent'] });
  const fields = {
    objective: 'bounded helper question', targetRefs: [], expectedOutputRefs: [],
    expectedArtifactDigests: [], acceptanceCriteriaDigest: `sha256:${'a'.repeat(64)}`,
    successCriteria: ['complete conclusion'], failureCriteria: ['no conclusion'],
    incompleteCriteria: ['partial conclusion'], requiredCapabilities: ['text-generation'], mergeGate: 'not-required',
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(request.url?.includes('models')
          ? { data: [{ id: 'parent-model' }, { id: 'child-model' }] } : { status: 'ok' }));
        return;
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const frames: unknown[] = [{ type: 'response.created', response: { id: `local-${requests.length}` } }];
      if (body.model === 'child-model') {
        assert.equal(JSON.stringify(body).includes('parent-private-input'), false, 'helper must not inherit parent transcript');
        assert.ok(JSON.stringify(body).includes('bounded-only-input'));
        frames.push({ type: 'response.output_text.done', item_id: 'child-final', text: JSON.stringify({
          agentId: 'configured-child', producedArtifactRefs: [], producedArtifactDigests: [],
          status: 'incomplete', summary: 'child-summary-is-not-parent-json-or-refined-text', outputRefs: [],
          evidenceRefs: [], nextAction: 'wait', conditionRef: 'condition:more-evidence',
        }) });
      } else {
        assert.equal(body.model, 'parent-model');
        const results = body.input.filter((item: any) => item.type === 'function_call_output');
        if (parentStarts.length === 2) {
          const wire = JSON.stringify(body);
          assert.ok(wire.includes('second-current-input'));
          assert.ok(wire.includes('second-source'));
          assert.ok(wire.includes(refinedText), 'second outbound must contain accepted refined helper semantics');
          for (const part of ['goal:', 'what-done', 'outcome(', 'next:']) assert.ok(wire.includes(part), part);
          for (const raw of ['parent-private-input', finalText, 'dispatch-call', 'accept-call', 'child-summary-is-not-parent-json-or-refined-text']) {
            assert.equal(wire.includes(raw), false, `prior raw must not enter history: ${raw}`);
          }
          assert.deepEqual(lifecycle, ['parent:closed']);
          assert.ok(await helperJournal.readSemanticCheckpointExact(parentStarts[0].interactionTurn));
          frames.push({ type: 'response.output_text.done', item_id: 'second-final', text: JSON.stringify({
            kind: 'answer', normalizedInput: 'second question', knownFacts: [], answer: 'second answer', decisionRefs: [],
          }) });
        } else if (results.length === 0) {
          assert.ok(turn);
          const snapshot = await parentJournal.readTurnSnapshot(turn!);
          assert.ok(snapshot.turnInput, 'initial input must be durable before external parent start');
          assert.equal(snapshot.requests[0].fact.phase, 'dispatching');
          const initial = await rawContent.read({ scope: snapshot.turnInput!.fact.scope, content: snapshot.turnInput!.fact.initialInput });
          assert.ok(new TextDecoder().decode(initial).includes('parent-private-input'));
          // A prior-request JSON-looking output must never enter final parsing.
          frames.push({ type: 'response.output_text.done', item_id: 'parent-draft', text: '{"kind":"not-final"}' });
          frames.push({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call',
            id: 'dispatch-item', call_id: 'dispatch-call', name: 'dispatch_helper',
            arguments: JSON.stringify({ selection: { roleId: 'review', configuredAgentId: 'configured-child' },
              assignmentFields: fields, inputs: { question: 'bounded-only-input' }, evidenceRefs: [] }) } });
        } else if (results.length === 1) {
          assert.equal(results[0].call_id, 'dispatch-call');
          const dispatched = JSON.parse(results[0].output);
          helperCallId = dispatched.identity.helperCallId;
          const handoff = await helperJournal.readExact(dispatched.identity);
          assert.ok(handoff.returned);
          assert.equal(handoff.ownerAccepted, null, 'returned must not be automatically accepted');
          assert.equal(handoff.returned!.fact.result.status, 'incomplete');
          frames.push({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call',
            id: 'accept-item', call_id: 'accept-call', name: 'accept_helper',
            arguments: JSON.stringify({ helperCallId, refinedText, acceptanceRef: 'acceptance:explicit-parent', evidenceRefs: [] }) } });
        } else {
          assert.deepEqual(results.map((item: any) => item.call_id), ['dispatch-call', 'accept-call']);
          const calls = body.input.filter((item: any) => item.type === 'function_call');
          assert.deepEqual(calls.map((item: any) => item.call_id), ['dispatch-call', 'accept-call']);
          const accepted = JSON.parse(results[1].output);
          assert.equal(accepted.latestTurnEntry.result.status, 'incomplete');
          const asset = accepted.latestTurnEntry.refinedResult;
          assert.equal(new TextDecoder().decode(await rawContent.read({ scope: asset.ref.scope, content: asset })), refinedText);
          const handoff = await helperJournal.readExact(accepted.latestTurnEntry.result);
          assert.ok(handoff.ownerAccepted);
          frames.push({ type: 'response.output_text.delta', item_id: 'parent-final', delta: '{"incorrect":"partial"}' });
          frames.push({ type: 'response.output_text.done', item_id: 'parent-final', text: finalText });
        }
      }
      frames.push({ type: 'response.completed', response: { id: `local-${requests.length}` } });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch((error: unknown) => { response.writeHead(500); response.end(String(error)); });
  });
  let runtime: Awaited<ReturnType<typeof startUiRuntimeOwner>> | undefined;
  let lease: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing local server address');
    const entries: EffectiveAgentProviderBinding[] = [
      { agentId: 'configured-parent', roleId: 'interaction', source: 'agent', provider: {
        source: 'http', provider: 'http', binding: 'local-parent', protocol: 'responses', model: 'parent-model',
        route: 'parent-route', baseUrl: `http://127.0.0.1:${address.port}` } },
      { agentId: 'configured-child', roleId: 'review', source: 'agent', provider: {
        source: 'http', provider: 'http', binding: 'local-child', protocol: 'responses', model: 'child-model',
        route: 'child-route', baseUrl: `http://127.0.0.1:${address.port}` } },
    ];
    const prepare = async <T extends AnyProviderExecutionIdentityRef>(selection: { roleId: AgentRole; configuredAgentId?: string }) => {
      const owned = await prepareAgentProvider<T>({ ...selection, agentProviderBindings: entries, evidenceRoot });
      const start = owned.port.start.bind(owned.port);
      owned.port.start = async (input) => {
        if ('interactionTurn' in input && input.interactionTurn) {
          assert.equal('taskId' in input, false); assert.equal('helper' in input, false);
          turn = input.interactionTurn;
          parentStarts.push(input as ProviderStartInput<InteractionParentProviderExecutionIdentityRef>);
        } else {
          assert.equal('taskId' in input, false); assert.ok('helper' in input);
          childStarts.push(input);
        }
        return start(input);
      };
      const close = owned.port.close.bind(owned.port);
      owned.port.close = async (binding) => {
        const receipt = await close(binding);
        if (selection.roleId === 'interaction') lifecycle.push('parent:closed');
        return receipt;
      };
      return owned;
    };
    const auth = await testAccessControl(root);
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const paths = await resolveRuntimePaths({
      controlRoot: join(root, 'control'),
      workspace,
    });
    await ensureControlLayout(paths);
    lease = await acquireDaemonLease(paths, { ownerId: 'semantic-observation-public' });
    runtime = await startUiRuntimeOwner({
      mode: 'fake', organId, binding, port: buildFakeExecutionPort(binding, 0), checkpointRoot, evidenceRoot,
      uiRoot: join(process.cwd(), 'docs', 'ui'), portNumber: 0, memory: memory('default-parent'),
      accessControl: auth.accessControl, explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      runtimeComposition: { prepareAgentProvider: prepare }, explicitBrainHelperProviderPreparer: prepare, lease,
    });
    testSessionByOrigin.set(new URL(runtime.server.url).origin, auth.cookie);
    const received = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'business', sourceRef: 'test:default-parent', rawInput: 'parent-private-input' }),
    });
    assert.equal(received.status, 201);
    const interactionId = ((await received.json()) as { interactionId: string }).interactionId;
    const interpreted = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, { method: 'POST' });
    const receipt = await interpreted.text();
    assert.equal(interpreted.status, 200, receipt);
    assert.ok(receipt.includes(answer), receipt);
    assert.equal(parentStarts.length, 1); assert.equal(childStarts.length, 1);
    assert.deepEqual(requests.map((body) => body.model), ['parent-model', 'child-model', 'parent-model', 'parent-model']);
    const snapshot = await parentJournal.readTurnSnapshot(turn!);
    const calls = snapshot.acceptedFacts.filter(({ fact }) => fact.envelope.fact.kind === 'tool-call');
    const results = snapshot.acceptedFacts.filter(({ fact }) => fact.envelope.fact.kind === 'tool-result');
    assert.equal(calls.length, 2); assert.equal(results.length, 2);
    for (const { fact } of results) {
      if (fact.envelope.fact.kind !== 'tool-result') throw new Error('expected tool-result');
      const callId = fact.envelope.fact.callId;
      const stored = await rawContent.read({ scope: fact.envelope.scope, content: fact.envelope.fact.rawOutput });
      const wireResult = requests.at(-1).input.find((item: any) => item.type === 'function_call_output' && item.call_id === callId);
      assert.equal(new TextDecoder().decode(stored), wireResult.output, 'tool continuation must preserve exact committed output bytes');
    }
    assert.ok(helperCallId);
    // Observed missing default checkpoint wiring loses cross-turn history.
    // One added parent request below checks the actual wire, not assembly args.
    const firstCommit = await helperJournal.readSemanticCheckpointExact(turn!);
    assert.ok(firstCommit, 'default parent must publish semantic closure');
    if (firstCommit === null) throw new Error('missing semantic commit');
    const claims = firstCommit.checkpoint.claims.map((claim) => claim.fact).join('\n');
    for (const part of ['goal:', 'what-done', 'outcome(', 'next:', refinedText]) assert.ok(claims.includes(part), part);
    const nextInput = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'business', sourceRef: 'second-source', rawInput: 'second-current-input' }),
    });
    assert.equal(nextInput.status, 201);
    const secondId = ((await nextInput.json()) as { interactionId: string }).interactionId;
    const next = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(secondId)}/interpret`, { method: 'POST' });
    const nextReceipt = await next.text();
    assert.equal(next.status, 200, nextReceipt);
    assert.ok(nextReceipt.includes('second answer'));
    assert.equal(parentStarts.length, 2); assert.equal(childStarts.length, 1);
    assert.equal(parentStarts[1].interactionTurn.interactionId, secondId);
    assert.ok(parentStarts[0].interactionTurn.turnId !== parentStarts[1].interactionTurn.turnId);
    assert.ok(await helperJournal.readSemanticCheckpointExact(parentStarts[1].interactionTurn));
  } finally {
    if (runtime) { testSessionByOrigin.delete(new URL(runtime.server.url).origin); await runtime.close(); }
    if (lease) await lease.release();
    server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
const rawFetch = globalThis.fetch.bind(globalThis);
const testSessionByOrigin = new Map<string, string>();

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const origin = new URL(url).origin;
  const cookie = testSessionByOrigin.get(origin);
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('cookie', cookie);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') headers.set('origin', origin);
  return rawFetch(input, { ...init, headers });
}) as typeof fetch;

function memory(projectKey: string) {
  return {
    coordinator: new MemoryCoordinator(),
    backend: new DeterministicMemoryBackend(),
    projectKey,
    roleId: 'execution',
  };
}

class CountingFakeReplayExecutionRuntimePort extends FakeReplayExecutionRuntimePort {
  startCount = 0;

  override async start(input: Parameters<FakeReplayExecutionRuntimePort['start']>[0]) {
    this.startCount += 1;
    return await super.start(input);
  }
}

class SecondObserveGatedReplayExecutionRuntimePort extends FakeReplayExecutionRuntimePort {
  private observed = 0;
  private readonly secondGate: Promise<void>;
  private releaseSecond!: () => void;
  readonly secondObserveStarted: Promise<void>;
  private markSecondObserveStarted!: () => void;

  constructor(options: ConstructorParameters<typeof FakeReplayExecutionRuntimePort>[0]) {
    super(options);
    this.secondGate = new Promise<void>((resolve) => { this.releaseSecond = resolve; });
    this.secondObserveStarted = new Promise<void>((resolve) => { this.markSecondObserveStarted = resolve; });
  }

  releaseSecondOperation(): void {
    this.releaseSecond();
  }

  override async *observe(input: Parameters<FakeReplayExecutionRuntimePort['observe']>[0]) {
    this.observed += 1;
    if (this.observed === 2) {
      this.markSecondObserveStarted();
      await this.secondGate;
    }
    yield* super.observe(input);
  }
}

async function startUiRuntime(
  options: Parameters<typeof startUiRuntimeOwner>[0],
  interpreter: Parameters<typeof startUiRuntimeOwner>[0]['explicitBrainInterpreter'] = {
    async interpret() { throw new Error('semantic consumer does not interpret explicit brain inputs'); },
  },
) {
  const auth = await testAccessControl(options.checkpointRoot);
  const runtime = await startUiRuntimeOwner({
    ...options,
    accessControl: auth.accessControl,
    explicitBrainInterpreter: interpreter,
  });
  testSessionByOrigin.set(new URL(runtime.server.url).origin, auth.cookie);
  return runtime;
}

async function testAccessControl(root: string) {
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = accessControl.createPairingChallenge('semantic-public-lease', 1);
  const session = await accessControl.consumePairingCode(challenge.code);
  return { accessControl, cookie: accessControl.sessionCookie(session).split(';')[0]! };
}

function scope(organValue: string, taskValue: string, operationValue = 'operation-1'): ScopeRef {
  return {
    organId: id('organ', organValue),
    taskId: id('task', taskValue),
    operationId: id('operation', operationValue),
  };
}

async function readPublicTaskGrant(baseUrl: string, taskId: string): Promise<any> {
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/control/grant`);
  assert.equal(response.status, 200);
  return await response.json() as any;
}

async function grantTaskThroughPublicApi(baseUrl: string, taskId: string): Promise<void> {
  const before = await readPublicTaskGrant(baseUrl, taskId);
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/control/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: `grant:${taskId}`,
      expectedRevision: before.readback?.grant?.revision ?? 0,
    }),
  });
  assert.equal(response.status, 200);
}

function evidence(label: string, taskScope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `semantic-public-${label}`),
    kind: 'execution',
    source: 'semantic-public-test',
    locator: `semantic://${label}`,
    scope: taskScope,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (predicate()) return resolve();
      } catch (error) {
        if (Date.now() - startedAt > timeoutMs) return reject(error);
      }
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('timed out waiting for semantic observation'));
      setTimeout(() => void tick(), 25);
    };
    void tick();
  });
}

async function readSseText(url: string, timeoutMs = 3000): Promise<string> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (text.includes('\n\n') && Date.now() > deadline - timeoutMs / 2) break;
    if (Date.now() > deadline) throw new Error('semantic SSE stream did not finish');
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    if (chunk === null) continue;
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (text.includes('semantic.observation') && text.endsWith('\n\n')) break;
  }
  await reader.cancel();
  return text;
}

async function openSemanticStream(url: string): Promise<{
  readonly next: (timeoutMs?: number) => Promise<RuntimeSemanticObservationEnvelope | undefined>;
  readonly close: () => Promise<void>;
}> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  const takeFrame = (): RuntimeSemanticObservationEnvelope | null | undefined => {
    const separator = buffer.indexOf('\n\n');
    if (separator < 0) return undefined;
    const raw = buffer.slice(0, separator);
    buffer = buffer.slice(separator + 2);
    const event = raw.split('\n').find((line) => line.startsWith('event: '))?.slice('event: '.length);
    if (event !== 'semantic.observation') return null;
    const data = raw.split('\n').find((line) => line.startsWith('data: '))?.slice('data: '.length);
    assert.ok(data, 'semantic SSE frame must carry data');
    return JSON.parse(data!) as RuntimeSemanticObservationEnvelope;
  };

  return {
    async next(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frame = takeFrame();
        if (frame !== undefined) {
          if (frame !== null) return frame;
          continue;
        }
        if (done) return undefined;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('timed out waiting for semantic SSE frame');
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
        ]);
        if (chunk === null) throw new Error('timed out waiting for semantic SSE frame');
        if (chunk.done) {
          done = true;
          continue;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close() {
      await reader.cancel();
    },
  };
}

test('public semantic HTTP/SSE preserves canonical pairing, unknown states, refs, and no cross-scope closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-semantic-public-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 25),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: memory('project-semantic-public'),
  });
  try {
    const task = runtime.service.createTask({ title: 'semantic public success' });
    await grantTaskThroughPublicApi(runtime.server.url, task.taskId.value);
    const started = await runtime.service.startExecution(task.taskId, { prompt: 'semantic public lifecycle' });

    await waitFor(() => runtime.service.taskDashboard(task.taskId).state === 'succeeded');
    const publication = runtime.service.taskDashboard(task.taskId).publicOutput;
    const expected = publication?.commits.at(-1)?.journalSeq;
    assert.ok(expected !== undefined, 'fixture must produce a public commit');
    assert.equal(publication?.publicCommitWatermark, expected);
    const semantic = await (await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/semantic`)).json() as RuntimeSemanticObservationEnvelope;

    assert.equal(semantic.projectionVersion, 'runtime-semantic-v1');
    assert.equal(semantic.publicCommitWatermark, expected);
    assert.equal(semantic.scope.organId.value, organId.value);
    assert.equal(semantic.scope.taskId?.value, task.taskId.value);
    assert.equal(semantic.scope.operationId?.value, started.operationId.value);
    assert.ok(semantic.sourceWatermark > 0);
    assert.equal(semantic.capabilities.some((capability) => capability.capability === 'runtime-task-events' && capability.state === 'available'), true);
    assert.equal(semantic.events.some((event) => event.type === 'operation.started'), true);
    assert.equal(semantic.events.some((event) => event.type === 'operation.completed'), true);
    assert.equal(semantic.events.every((event) => event.payloadRef === `context-event:${event.sourceId}`), true);
    assert.equal(semantic.events.every((event) => event.dataDigest.startsWith('sha256:')), true);
    assert.equal(semantic.pairing.some((group) => group.kind === 'operation' && group.state === 'closed' && group.scope.operationId?.value === started.operationId.value), true);
    // The fake provider includes high-noise and uncorrelated source facts;
    // public coverage must report them without turning them into canonical
    // events or hiding the successful operation pairing.
    assert.deepEqual(
      semantic.coverageIssues.map((issue) => issue.reason).sort(),
      [
        'correlation-unavailable',
        'correlation-unavailable',
        'unknown-kind',
        'unknown-kind',
        'unknown-kind',
        'unknown-kind',
      ],
    );
    assert.equal(semantic.coverageIssues.every((issue) => issue.eventRef === undefined), true);
    assert.equal(semantic.coverageIssues.every((issue) => issue.scope.taskId?.value === task.taskId.value), true);

    const sseText = await readSseText(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/semantic/stream`);
    assert.match(sseText, /id: semantic-/);
    assert.match(sseText, /event: semantic\.observation/);
    const frames = [...sseText.matchAll(/data: (.+)$/gm)].map((match) => JSON.parse(match[1]!) as RuntimeSemanticObservationEnvelope);
    assert.equal(frames.length >= 1, true);
    assert.equal(frames.at(-1)?.publicCommitWatermark, expected);
    assert.equal(frames.at(-1)?.events.some((event) => event.type === 'operation.completed'), true);
    assert.equal(frames.at(-1)?.pairing.some((group) => group.kind === 'operation' && group.state === 'closed'), true);

    // The same public control interface must revoke the durable grant, expose
    // the revoked readback, and invalidate further execution authorization.
    const grantRead = await readPublicTaskGrant(runtime.server.url, task.taskId.value);
    assert.ok(grantRead.readback?.grant, 'the granted task must expose a persisted readback');
    const revoke = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/control/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: `revoke:${task.taskId.value}`,
        expectedRevision: grantRead.readback.grant.revision,
      }),
    });
    assert.equal(revoke.status, 200);
    const revokedRead = await readPublicTaskGrant(runtime.server.url, task.taskId.value);
    assert.equal(revokedRead.readback?.grant?.state, 'revoked');
    const denied = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'semantic public denied after revoke' }),
    });
    assert.ok(denied.status >= 400);
    const deniedBody = (await denied.json()) as { readonly error?: { readonly message?: string } };
    assert.match(deniedBody.error?.message ?? '', /task grant denied/);
  } finally {
    await runtime.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('public semantic SSE stays bound to the active second operation and closes on its own terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-semantic-two-operation-'));
  const port = new SecondObserveGatedReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port,
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    memory: memory('project-semantic-two-operation'),
  });
  let released = false;
  const releaseSecond = () => {
    if (released) return;
    released = true;
    port.releaseSecondOperation();
  };
  let stream: Awaited<ReturnType<typeof openSemanticStream>> | undefined;
  try {
    const task = runtime.service.createTask({ title: 'two operation semantic stream' });
    await grantTaskThroughPublicApi(runtime.server.url, task.taskId.value);
    const first = await runtime.service.startExecution(task.taskId, { prompt: 'first semantic operation' });
    await waitFor(() => runtime.service.taskDashboard(task.taskId).state === 'succeeded');

    const second = await runtime.service.startExecution(task.taskId, { prompt: 'second semantic operation' });
    await port.secondObserveStarted;
    stream = await openSemanticStream(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/semantic/stream`);

    const active = await stream.next();
    assert.ok(active, 'the stream must expose the active operation');
    assert.equal(active!.scope.operationId?.value, second.operationId.value);
    assert.equal(active!.events.some((event) => event.scope.operationId?.value === first.operationId.value && event.type === 'operation.completed'), true);
    assert.equal(active!.events.some((event) => event.scope.operationId?.value === second.operationId.value && event.type === 'operation.started'), true);
    assert.equal(active!.events.some((event) => event.scope.operationId?.value === second.operationId.value && (event.type === 'operation.completed' || event.type === 'operation.failed')), false);
    assert.equal(active!.pairing.some((group) => group.kind === 'operation' && group.scope.operationId?.value === first.operationId.value && group.state === 'closed'), true);
    assert.equal(active!.pairing.some((group) => group.kind === 'operation' && group.scope.operationId?.value === second.operationId.value && group.state === 'open'), true);

    // A second frame while B is still gated proves the retained closure of A did
    // not terminate the stream. With the old predicate the stream would end
    // after the first frame.
    const stillActive = await stream.next();
    assert.ok(stillActive, 'the stream must stay open while the observed operation is active');
    assert.equal(stillActive!.scope.operationId?.value, second.operationId.value);
    assert.equal(stillActive!.events.some((event) => event.scope.operationId?.value === second.operationId.value && (event.type === 'operation.completed' || event.type === 'operation.failed')), false);

    releaseSecond();
    const frames: RuntimeSemanticObservationEnvelope[] = [];
    for (;;) {
      const frame = await stream.next(5000);
      if (frame === undefined) break;
      frames.push(frame);
    }
    assert.equal(frames.length > 0, true);
    const terminal = frames.at(-1)!;
    assert.equal(terminal.scope.operationId?.value, second.operationId.value);
    assert.equal(terminal.events.some((event) => event.scope.operationId?.value === second.operationId.value && (event.type === 'operation.completed' || event.type === 'operation.failed')), true);
    assert.equal(terminal.pairing.some((group) => group.kind === 'operation' && group.scope.operationId?.value === second.operationId.value && group.state === 'closed'), true);
    assert.equal(terminal.events.some((event) => event.scope.operationId?.value === first.operationId.value && event.type === 'operation.completed'), true);
  } finally {
    releaseSecond();
    await stream?.close();
    await runtime.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('semantic projection keeps unavailable and cross-scope states explicit instead of fabricating closure', () => {
  const taskScope = scope('organ-a', 'task-a');
  const otherScope = scope('organ-b', 'task-b');
  const semantic = projectRuntimeSemanticObservation({
    taskId: taskScope.taskId!,
    semantic: {
      scope: taskScope,
      projectionVersion: 'runtime-semantic-v1',
      sourceWatermark: 1,
      events: [{
        eventId: 'context-event:coverage-waiting',
        sourceId: 'coverage-waiting',
        type: 'operation.failed',
        scope: taskScope,
        occurredAt: '2026-10-10T00:00:00.000Z',
        status: 'failed',
        summary: 'waiting is not terminal',
        payloadRef: 'context-event:coverage-waiting',
        dataDigest: 'sha256:coverage-waiting',
        evidenceRefs: [evidence('waiting', taskScope)],
      }],
      coverageIssues: [{
        reason: 'waiting-is-not-terminal',
        scope: taskScope,
        sourceRef: evidence('waiting', taskScope),
      }],
      pairing: [],
      capabilities: [{ capability: 'runtime-task-events', state: 'unavailable', reason: 'no terminal event' }],
    },
  });

  assert.equal(semantic.coverageIssues[0]?.reason, 'waiting-is-not-terminal');
  assert.equal(semantic.capabilities[0]?.state, 'unavailable');
  assert.equal(semantic.pairing.length, 0);

  assert.throws(
    () => projectRuntimeSemanticObservation({
      taskId: taskScope.taskId!,
      semantic: { ...semantic, scope: otherScope },
    }),
    /task-b.*task-a/,
  );
});

test('public confirmation passes exact existing-task-change target and rejects stale/mismatched kind before enqueue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-semantic-confirm-'));
  const port = new CountingFakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const runtime = await startUiRuntime(
    {
      mode: 'fake',
      organId,
      binding,
      port,
      checkpointRoot: join(root, 'checkpoints'),
      evidenceRoot: join(root, 'evidence'),
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      providerState: 'ready',
      portNumber: 0,
      memory: memory('project-semantic-confirm'),
    },
    {
      async interpret(input) {
        return {
          kind: 'requirement',
          normalizedInput: 'change this task',
          matchedTaskId: input.taskCandidates[0]?.taskId,
          knownFacts: [],
          intent: 'change',
          proposal: 'change this task',
          structuredProposal: { revision: input.inputRevision, intent: 'change', title: 'change this task',
            objective: 'change this task', deliverable: 'changed task', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
          decisionRefs: [],
        };
      },
    },
  );
  try {
    const target = runtime.service.createTask({ title: 'existing target' });
    const input = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'business', sourceRef: 'semantic-public:change', rawInput: 'change this task', requestKind: 'existing-task-change' }),
    });
    assert.equal(input.status, 201);
    const interactionId = ((await input.json()) as { interactionId: string }).interactionId;
    const interpreted = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, { method: 'POST' });
    assert.equal(interpreted.status, 200);
    const inspected = await (await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}`)).json() as any;
    await runtime.service.quiesceImplicitConsumption();

    const tasksBefore = runtime.service.listTasks().counts.total;
    const confirmation = (overrides: Readonly<Record<string, unknown>>) => fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: inspected.draft.draftId,
        inputRevision: inspected.draft.inputRevision,
        confirmedBy: 'human:operator',
        confirmedAt: '2026-10-10T00:00:00.000Z',
        requestKind: 'existing-task-change',
        ...overrides,
      }),
    });
    const assertRejectedWithoutSideEffects = async (
      response: Response,
      expectedStatus: number,
      expectedCode: string,
    ) => {
      assert.equal(response.status, expectedStatus);
      assert.equal(((await response.json()) as any).error.code, expectedCode);
      assert.equal(runtime.service.listTasks().counts.total, tasksBefore);
      assert.equal(port.startCount, 0);
      assert.equal((await runtime.service.inspectExplicitInteraction(interactionId)).state, 'awaiting-confirmation');
    };

    await assertRejectedWithoutSideEffects(
      await confirmation({
        confirmationRef: 'semantic-confirm-missing-target',
        payloadRef: 'asset://semantic/missing-target',
        draftRevisionVersion: inspected.revision.revisionVersion,
        draftRevisionHash: inspected.revision.revisionHash,
      }),
      400,
      'explicit-brain.missing-existing-task-target',
    );
    await assertRejectedWithoutSideEffects(
      await confirmation({
        confirmationRef: 'semantic-confirm-omitted-pair',
        payloadRef: 'asset://semantic/omitted-pair',
        taskRef: { scope: 'task', value: target.taskId.value },
      }),
      400,
      'explicit-brain.missing-draft-revision-binding',
    );
    await assertRejectedWithoutSideEffects(
      await confirmation({
        confirmationRef: 'semantic-confirm-version-only',
        payloadRef: 'asset://semantic/version-only',
        taskRef: { scope: 'task', value: target.taskId.value },
        draftRevisionVersion: inspected.revision.revisionVersion,
      }),
      400,
      'explicit-brain.missing-draft-revision-binding',
    );
    await assertRejectedWithoutSideEffects(
      await confirmation({
        confirmationRef: 'semantic-confirm-hash-only',
        payloadRef: 'asset://semantic/hash-only',
        taskRef: { scope: 'task', value: target.taskId.value },
        draftRevisionHash: inspected.revision.revisionHash,
      }),
      400,
      'explicit-brain.missing-draft-revision-binding',
    );
    await assertRejectedWithoutSideEffects(
      await confirmation({
        confirmationRef: 'semantic-confirm-stale',
        payloadRef: 'asset://semantic/stale',
        taskRef: { scope: 'task', value: target.taskId.value },
        draftRevisionVersion: inspected.revision.revisionVersion + 1,
        draftRevisionHash: inspected.revision.revisionHash,
      }),
      409,
      'explicit-draft.confirmation-stale',
    );
    await assertRejectedWithoutSideEffects(
      await confirmation({
        confirmationRef: 'semantic-confirm-wrong-task',
        payloadRef: 'asset://semantic/wrong-task',
        taskRef: { scope: 'task', value: 'not-the-selected-task' },
        draftRevisionVersion: inspected.revision.revisionVersion,
        draftRevisionHash: inspected.revision.revisionHash,
      }),
      409,
      'explicit-brain.task-target-mismatch',
    );

    // A mismatched kind on the exact revision/target/hash is rejected by the
    // runtime registration owner before any confirmation or submission
    // mutation; the same provenance then succeeds with the correct kind below.
    const revisionBeforeMismatch = inspected.revision.revisionHash;
    await assertRejectedWithoutSideEffects(
      await confirmation({
        confirmationRef: 'semantic-confirm-exact',
        payloadRef: 'asset://semantic/exact',
        taskRef: { scope: 'task', value: target.taskId.value },
        idempotencyKey: 'semantic-confirm-exact-key',
        draftRevisionVersion: inspected.revision.revisionVersion,
        draftRevisionHash: inspected.revision.revisionHash,
        requestKind: 'new-task-create',
      }),
      409,
      'unauthorized-final-submit',
    );
    const afterMismatch = await runtime.service.inspectExplicitInteraction(interactionId);
    assert.equal(afterMismatch.state, 'awaiting-confirmation');
    assert.equal(afterMismatch.revision?.revisionHash, revisionBeforeMismatch);
    assert.equal(afterMismatch.confirmation, undefined);

    const exact = await confirmation({
      confirmationRef: 'semantic-confirm-exact',
      payloadRef: 'asset://semantic/exact',
      taskRef: { scope: 'task', value: target.taskId.value },
      idempotencyKey: 'semantic-confirm-exact-key',
      draftRevisionVersion: inspected.revision.revisionVersion,
      draftRevisionHash: inspected.revision.revisionHash,
    });
    assert.equal(exact.status, 200);
    const exactReceipt = (await exact.json()) as any;
    assert.equal(exactReceipt.requirement.status, 'submitted');
    assert.equal(exactReceipt.requirement.draftId, inspected.draft.draftId);
    assert.equal(exactReceipt.requirement.inputRevision, inspected.draft.inputRevision);
    assert.equal(runtime.service.listTasks().counts.total, tasksBefore + 1);
    assert.equal(port.startCount, 0);

    const replay = await confirmation({
      confirmationRef: 'semantic-confirm-exact',
      payloadRef: 'asset://semantic/exact',
      taskRef: { scope: 'task', value: target.taskId.value },
      idempotencyKey: 'semantic-confirm-exact-key',
      draftRevisionVersion: inspected.revision.revisionVersion,
      draftRevisionHash: inspected.revision.revisionHash,
    });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as any).requirement.status, 'duplicate');
    assert.equal(runtime.service.listTasks().counts.total, tasksBefore + 1);
    assert.equal(port.startCount, 0);
  } finally {
    await runtime.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
