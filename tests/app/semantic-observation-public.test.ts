import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
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
    const started = runtime.service.startExecution(task.taskId, { prompt: 'semantic public lifecycle' });

    await waitFor(() => runtime.service.taskDashboard(task.taskId).state === 'succeeded');
    const semantic = await (await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}/semantic`)).json() as RuntimeSemanticObservationEnvelope;

    assert.equal(semantic.projectionVersion, 'runtime-semantic-v1');
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
    assert.equal(frames.at(-1)?.events.some((event) => event.type === 'operation.completed'), true);
    assert.equal(frames.at(-1)?.pairing.some((group) => group.kind === 'operation' && group.state === 'closed'), true);
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
    const first = runtime.service.startExecution(task.taskId, { prompt: 'first semantic operation' });
    await waitFor(() => runtime.service.taskDashboard(task.taskId).state === 'succeeded');

    const second = runtime.service.startExecution(task.taskId, { prompt: 'second semantic operation' });
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
