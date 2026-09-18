import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type Attention,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderSettlement,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderSubmitResult,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
import { ProviderAdapterError } from '../../packages/adapters/provider/src/index.js';
import { AgentRuntime, bindAgentDriver, executeStopControl, type AttentionPort } from '../../packages/runtime/src/index.js';
import { checkpointCommitId } from '../../packages/runtime/src/checkpoints/coordinator.js';
import { createHookRegistry, type AgentHookRegistry } from '../../packages/runtime/src/hooks/index.js';
import {
  RuntimeTaskControlError,
  RuntimeTaskCoordinator,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';
import {
  FileCheckpointStore,
  FakeReplayExecutionRuntimePort,
  UiRuntimeJournal,
  UiRuntimeApiError,
  UiRuntimeService,
  buildFakeExecutionPort,
  startUiRuntime,
} from '../../packages/app/src/ui-runtime/index.js';

const organId = id('organ', 'organ-ui-test');
const binding: ProviderBinding = {
  bindingId: 'binding-ui-test',
  providerId: 'provider-ui-test',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-ui-test',
  configDigest: 'sha256:ui-test-config',
  capabilityDigest: 'sha256:ui-test-capability',
};

function appendCheckpoint(store: FileCheckpointStore, checkpoint: Checkpoint): Promise<unknown> {
  return store.append({ ownerId: 'app-test', commitId: checkpointCommitId(checkpoint), checkpoint });
}

function evidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `ui-test-${label}`),
    kind: 'operation',
    source: 'ui-runtime-test',
    locator: `test://${label}`,
    scope,
  };
}

function attentionPort(): AttentionPort & { readonly published: Attention[]; readonly resolved: Attention[] } {
  const published: Attention[] = [];
  const resolved: Attention[] = [];
  return {
    published,
    resolved,
    async publish(input) {
      published.push(structuredClone(input));
      return { attentionId: input.attentionId, delivered: true };
    },
    async resolve(input) {
      resolved.push(structuredClone(input));
      return { attentionId: input.attentionId, delivered: true };
    },
  };
}

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (last instanceof Error) throw last;
  assertion();
}

function serviceFor(
  root: string,
  port: ExecutionRuntimePort,
  mode: 'fake' | 'rcc' = 'fake',
  providerState = 'ready',
  journal?: UiRuntimeJournal,
  now?: () => Date,
  hookRegistry?: AgentHookRegistry,
): UiRuntimeService {
  return new UiRuntimeService({
    mode,
    organId,
    binding,
    port,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    providerState,
    journal: journal ?? new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    ...(now ? { now } : {}),
    ...(hookRegistry ? { hookRegistry } : {}),
  });
}

test('fake execution completes through Runtime projection with SSE, output, checkpoint, and read-only observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-fake-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const task = service.createTask({ title: 'fake lifecycle', directive: 'verify fake replay' });
  const started = service.startExecution(task.taskId, { prompt: 'run fake replay' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.mode, 'fake');
  assert.equal(dashboard.taskTitle, 'fake lifecycle');
  assert.match(dashboard.output, /fake replay: draft output chunk 1/);
  assert.match(dashboard.output, /fake replay: final output chunk 2/);
  assert.equal(dashboard.output.includes('fake://output/1'), false);
  assert.equal(dashboard.checkpoint?.outcome, 'succeeded');
  assert.equal(dashboard.error, undefined);
  assert.deepEqual(dashboard.allowedActions, ['start']);

  const events = service.eventsSince(started.operationId);
  assert.deepEqual(events.map((event) => event.kind), [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.output',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ]);
  assert.deepEqual(
    events.filter((event) => event.kind === 'execution.terminal').map((event) => event.terminalPhase),
    ['provider', 'final'],
  );
  assert.equal(events.at(-1)?.summary.includes('provider closed'), true);
  assert.equal(events.at(-1)?.evidenceRefs.some((ref) => ref.locator === 'fake/close'), true);
  assert.equal(events.every((event) => event.executionEpoch === 1), true);
  assert.equal(events.every((event) => event.taskId.value === task.taskId.value), true);

  const observation = service.observation(task.taskId, 'provider.execute');
  assert.equal(observation.surface, 'runtime-observation');
  assert.equal(observation.selectedNode?.nodeId, 'provider.execute');
  const checkpointNode = observation.nodes.find((node) => node.nodeId === 'checkpoint.commit');
  if (!checkpointNode) throw new Error('expected checkpoint observation node');
  assert.equal(checkpointNode.evidenceRefs.length > 0, true);
  assert.equal(checkpointNode.evidenceRefs.every((ref) => ref.source === 'humanagent.runtime'), true);
  const childScope = observation.nodes.find((node) => node.nodeId === 'provider.execute')?.childScopeRef;
  assert.ok(childScope);
  const child = service.observation(task.taskId, undefined, childScope);
  assert.equal(child.scopeRef, childScope);
  assert.equal(child.nodes.length > 0, true);
  assert.equal(child.canReturn, true);
  assert.throws(() => service.observation(task.taskId, 'unknown-node'));
  assert.throws(
    () => service.observation(task.taskId, undefined, `task://${task.taskId.value}/observation/foreign`),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'observation.scope.not-found'
      && error.httpStatus === 404,
  );

  const journal = await readFile(join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`), 'utf8');
  assert.match(journal, /"kind":"checkpoint"/);
  assert.match(journal, /"outcome":"succeeded"/);
  assert.match(journal, /"source":"humanagent.runtime"/);
  assert.equal(journal.includes('"source":"humanagent.fake-provider"'), false);
});

test('explicit brain confirmation is the only path from input to FIFO execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-brain-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'summarize the current task evidence',
    channel: 'business',
  });

  assert.equal(service.listTasks().counts.total, 0);
  const awaiting = await service.inspectExplicitInteraction(interactionId);
  assert.equal(awaiting.state, 'received');
  assert.equal(awaiting.draft, undefined);

  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'summarize the current task evidence',
    matchedTasks: [],
    knownFacts: ['no matching task'],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create a task for the confirmed evidence request',
  });

  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.equal(proposed.state, 'awaiting-confirmation');
  assert.ok(proposed.draft);
  assert.equal(service.listTasks().counts.total, 0);

  await assert.rejects(
    () => service.confirmExplicitRequirement({
      draftId: proposed.draft!.draftId,
      inputRevision: 1,
      confirmationRef: 'confirmation:explicit-brain',
      confirmedBy: '',
      confirmedAt: '2026-09-17T00:00:00.000Z',
      payloadRef: 'asset://requirements/explicit-brain',
    }),
    (error: unknown) => error instanceof UiRuntimeApiError
      && error.code === 'ExplicitIntakeError'
      && error.httpStatus === 409,
  );
  assert.equal(service.listTasks().counts.total, 0);

  const receipt = await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:explicit-brain',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/explicit-brain',
  });
  assert.equal(receipt.requirement.requirementId, 'requirement:draft-1:1');
  assert.equal(receipt.requirement.status, 'submitted');
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');

  const dispatched = await service.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.fifoSeq, 1);
  assert.equal(dispatched.taskId.value.startsWith('ui-task-'), true);
  assert.equal(dispatched.executionEpoch, 1);
  await waitFor(() => assert.equal(service.taskDashboard(dispatched.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(dispatched.taskId).input, 'asset://requirements/explicit-brain');
  assert.match(service.taskDashboard(dispatched.taskId).output, /fake replay/);
  const events = service.eventsSince(dispatched.operationId);
  assert.deepEqual(events.map((event) => event.kind), [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.output',
    'execution.terminal',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ]);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'dispatched');
});

test('explicit brain status query never creates a task or FIFO entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-status-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'what is the current status?',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  const receipt = await service.completeExplicitStatusQuery(interactionId);

  assert.deepEqual(receipt, {
    kind: 'status-only',
    interactionId,
    owner: 'explicit-intake',
    nextAction: 'present-status',
  });
  assert.equal(service.listTasks().counts.total, 0);
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'status-only');
});

test('explicit brain confirmation retry is idempotent after a submission failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-retry-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'retry a confirmed requirement',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'retry a confirmed requirement',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the retry requirement',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  const confirmation = {
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:retry',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/retry',
  };

  const first = await service.confirmExplicitRequirement(confirmation);
  const second = await service.confirmExplicitRequirement(confirmation);
  assert.equal(first.requirement.requirementId, second.requirement.requirementId);
  assert.equal(second.requirement.status, 'duplicate');
  assert.equal((await service.inspectExplicitInteraction(interactionId)).state, 'confirmed');
});

test('concurrent explicit dispatch starts exactly one execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-dispatch-race-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await service.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'dispatch exactly once',
    channel: 'business',
  });
  await service.beginExplicitMatching(interactionId);
  await service.recordExplicitMatch(interactionId, {
    normalizedInput: 'dispatch exactly once',
    matchedTasks: [],
    knownFacts: [],
  });
  await service.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the dispatch race requirement',
  });
  const proposed = await service.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await service.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:dispatch-race',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/dispatch-race',
  });

  const results = await Promise.allSettled([
    service.dispatchNextExplicitRequirement(),
    service.dispatchNextExplicitRequirement(),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (!rejected) throw new Error('expected one rejected dispatch');
  assert.equal(rejected.reason instanceof UiRuntimeApiError, true);
  assert.equal((rejected.reason as UiRuntimeApiError).code, 'explicit-brain.inbox.empty');
});

test('restart restores confirmed interaction and pending explicit inbox state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-restart-'));
  const first = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const interactionId = await first.receiveExplicitInput({
    sourceRef: 'ui:task-detail',
    rawInput: 'survive restart',
    channel: 'business',
  });
  await first.beginExplicitMatching(interactionId);
  await first.recordExplicitMatch(interactionId, {
    normalizedInput: 'survive restart',
    matchedTasks: [],
    knownFacts: [],
  });
  await first.proposeExplicitRequirement(interactionId, {
    proposedIntent: 'create',
    proposal: 'create the restart requirement',
  });
  const proposed = await first.inspectExplicitInteraction(interactionId);
  assert.ok(proposed.draft);
  await first.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:restart',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/restart',
  });

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await second.hydrate();
  const restored = await second.inspectExplicitInteraction(interactionId);
  assert.equal(restored.state, 'confirmed');
  assert.equal(restored.rawInput, 'survive restart');
  const duplicateConfirmation = await second.confirmExplicitRequirement({
    draftId: proposed.draft!.draftId,
    inputRevision: 1,
    confirmationRef: 'confirmation:restart',
    confirmedBy: 'human:operator',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    payloadRef: 'asset://requirements/restart',
  });
  assert.equal(duplicateConfirmation.requirement.status, 'duplicate');
  const dispatched = await second.dispatchNextExplicitRequirement();
  assert.equal(dispatched.requirement.requirementId, 'requirement:draft-1:1');
  assert.equal(dispatched.requirement.fifoSeq, 1);
});

test('explicit brain HTTP routes reach typed service operations and expose typed errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-explicit-http-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages/ui/static'),
  });
  try {
    const inputResponse = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:http',
        rawInput: 'route through HTTP',
        channel: 'business',
        inputRevision: 4,
      }),
    });
    assert.equal(inputResponse.status, 201);
    const input = await inputResponse.json() as { readonly interactionId: string };

    const inspectResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}`);
    assert.equal(inspectResponse.status, 200);
    const inspected = await inspectResponse.json() as { readonly state: string; readonly draft?: { readonly inputRevision: number } };
    assert.equal(inspected.state, 'received');
    assert.equal(inspected.draft, undefined);

    const staleResponse = await fetch(`${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(input.interactionId)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: 'draft-missing',
        inputRevision: 4,
        confirmationRef: 'confirmation:http-stale',
        confirmedBy: 'human:operator',
        confirmedAt: '2026-09-17T00:00:00.000Z',
        payloadRef: 'asset://requirements/http-stale',
      }),
    });
    assert.equal(staleResponse.status, 409);
    const stale = await staleResponse.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(stale.error.code, 'ExplicitIntakeError');
    assert.equal(stale.error.ownerId, 'explicit-intake');

    const controlResponse = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:http',
        rawInput: 'stop the current task',
        channel: 'control',
        controlCommand: 'stop',
      }),
    });
    assert.equal(controlResponse.status, 501);
    const control = await controlResponse.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(control.error.code, 'explicit-brain.control.unsupported');
    assert.equal(control.error.ownerId, 'humanagent.app');
  } finally {
    await runtime.server.close();
  }
});

test('runtime output concatenates repeated provider deltas without suffix dedupe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-output-dedupe-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      { kind: 'output', state: 'output', summary: 'a', outputRefs: ['fake://output/1'] },
      { kind: 'output', state: 'output', summary: 'a', outputRefs: ['fake://output/2'] },
      { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
    ],
  }));
  const task = service.createTask({ title: 'repeated output deltas' });
  service.startExecution(task.taskId, { prompt: 'run repeated deltas' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(task.taskId).output, 'aa');
});

test('responses delta and completion replay projects output text exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-responses-output-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [
      { kind: 'output', state: 'output', summary: 'hello ', outputRefs: ['fake://text/item-1'] },
      { kind: 'output', state: 'output', summary: 'world', outputRefs: ['fake://text/item-1'] },
      { kind: 'terminal', state: 'succeeded', summary: 'execution succeeded', terminalState: 'succeeded' },
    ],
  }));
  const task = service.createTask({ title: 'responses output projection' });
  service.startExecution(task.taskId, { prompt: 'run responses replay' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  assert.equal(service.taskDashboard(task.taskId).output, 'hello world');
});

test('observation preserves waiting and blocked terminal states instead of reporting success', async () => {
  for (const terminalState of ['waiting', 'blocked'] as const) {
    const root = await mkdtemp(join(tmpdir(), `humanagent-ui-observation-${terminalState}-`));
    const port = new FakeReplayExecutionRuntimePort({
      binding,
      stepDelayMs: 1,
      replay: [
        { kind: 'model', state: 'model', summary: 'model accepted the request' },
        { kind: 'terminal', state: terminalState, summary: `execution ${terminalState}`, terminalState },
      ],
    });
    const service = serviceFor(root, port);
    const task = service.createTask({ title: `observation ${terminalState}` });
    service.startExecution(task.taskId, { prompt: `observe ${terminalState}` });
    await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, terminalState));
    assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, terminalState);

    const child = service.observation(task.taskId, undefined, `task://${task.taskId.value}/observation/provider.execute`);
    const terminalNode = child.nodes.find((node) => node.summary === `execution ${terminalState}`);
    assert.equal(terminalNode?.state, terminalState);
  }
});

test('fake replay terminal state drives settlement instead of defaulting to success', async () => {
  for (const terminalState of ['failed', 'blocked', 'waiting'] as const) {
    const root = await mkdtemp(join(tmpdir(), `humanagent-ui-fake-terminal-${terminalState}-`));
    const port = new FakeReplayExecutionRuntimePort({
      binding,
      stepDelayMs: 1,
      replay: [
        { kind: 'model', state: 'model', summary: 'model accepted the request' },
        { kind: 'terminal', state: terminalState, summary: `execution ${terminalState}`, terminalState },
      ],
    });
    const service = serviceFor(root, port);
    const task = service.createTask({ title: `fake ${terminalState}` });
    service.startExecution(task.taskId, { prompt: `run ${terminalState}` });

    await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, terminalState));
    assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, terminalState);
  }
});

test('fake replay without a terminal event fails explicitly instead of reporting success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-fake-missing-terminal-'));
  const port = new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    replay: [{ kind: 'model', state: 'model', summary: 'model accepted the request' }],
  });
  const service = serviceFor(root, port);
  const task = service.createTask({ title: 'fake missing terminal' });
  service.startExecution(task.taskId, { prompt: 'run without terminal' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  assert.equal(service.taskDashboard(task.taskId).checkpoint?.outcome, 'failed');
});

test('provider identity mismatch fails the execution without surfacing a foreign event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-observation-stale-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const stalePort: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: async function* observe(input) {
      yield {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch + 1,
        eventId: 'stale-output',
        kind: 'output',
        outputRefs: ['stale://output'],
        evidenceRefs: [evidence('stale-output', { organId, taskId: input.taskId, operationId: input.operationId })],
      };
      yield {
        runtimeId: input.runtimeId,
        taskId: input.taskId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
        eventId: 'terminal-output',
        kind: 'terminal',
        terminalState: 'succeeded',
        evidenceRefs: [evidence('terminal-output', { organId, taskId: input.taskId, operationId: input.operationId })],
      };
    },
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, stalePort);
  const task = service.createTask({ title: 'observation stale' });
  service.startExecution(task.taskId, { prompt: 'observe stale event' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.output, '');
  assert.equal(dashboard.error?.ownerId, 'humanagent.provider-adapter');
  const child = service.observation(task.taskId, undefined, `task://${task.taskId.value}/observation/provider.execute`);
  assert.equal(child.nodes.some((node) => node.summary.includes('foreign-task')), false);
  assert.equal(child.nodes.some((node) => node.summary.includes('another execution')), true);
});

test('operation-scoped hydration restores an operation-less business checkpoint after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-restart-'));
  const first = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const firstTask = first.createTask({ title: 'first process' });
  const firstStarted = first.startExecution(firstTask.taskId, { prompt: 'first process' });
  await waitFor(() => assert.equal(first.taskDashboard(firstTask.taskId).state, 'succeeded'));
  const firstEvents = first.eventsSince(firstStarted.operationId);

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await second.hydrate();
  const reconstructedDashboard = second.taskDashboard(firstTask.taskId);
  assert.equal(reconstructedDashboard.state, 'succeeded');
  assert.equal(reconstructedDashboard.checkpoint?.outcome, 'succeeded');
  const reconstructed = await new FileCheckpointStore(
    join(root, `task-${firstTask.taskId.value}-cycle-ui-cycle-1.jsonl`),
  ).readLatest({
    organId,
    taskId: firstTask.taskId,
    cycleId: id('cycle', 'ui-cycle-1'),
    operationId: firstStarted.operationId,
  });
  if (!reconstructed) throw new Error('expected reconstructed checkpoint');
  assert.equal(reconstructed.checkpoint.outcome, 'succeeded');
  assert.equal(reconstructed.checkpoint.scope.operationId, undefined);
  assert.deepEqual(second.eventsSince(firstStarted.operationId).map((event) => event.eventId), firstEvents.map((event) => event.eventId));

  const secondTask = second.createTask({ title: 'second process' });
  assert.equal(secondTask.taskId.value === firstTask.taskId.value, false);
  second.startExecution(secondTask.taskId, { prompt: 'second process' });
  await waitFor(() => assert.equal(second.taskDashboard(secondTask.taskId).state, 'succeeded'));
  assert.equal(second.taskDashboard(secondTask.taskId).error, undefined);

  const third = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await third.hydrate();
  assert.equal(third.taskDashboard(firstTask.taskId).state, 'succeeded');
  assert.equal(third.taskDashboard(secondTask.taskId).state, 'succeeded');
  const resumed = third.startExecution(firstTask.taskId, { prompt: 'new epoch after restart' });
  assert.equal(resumed.executionEpoch, 2);
  await waitFor(() => assert.equal(third.taskDashboard(firstTask.taskId).state, 'succeeded'));
});

test('journal replay fails explicitly instead of silently dropping corrupted projection records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-journal-corrupt-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  await writeFile(journalPath, '{"kind":"task.created","taskId":{"scope":"task","value":"broken"}}\n', 'utf8');

  const journal = new UiRuntimeJournal(journalPath);
  assert.throws(
    () => journal.replay(),
    (error: unknown) => error instanceof Error
      && error.message.includes('ui-runtime-journal.jsonl:1')
      && error.message.includes('title is required'),
  );
});

test('journal replay rejects a projection event that cross-links another operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-journal-cross-link-'));
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const createdAt = '2026-01-01T00:00:00.000Z';
  const taskId = id('task', 'task-cross-link');
  const operationId = id('operation', 'operation-cross-link');
  const scope = {
    organId: id('organ', 'organ-cross-link'),
    taskId,
    cycleId: id('cycle', 'cycle-cross-link'),
    operationId,
  };
  await writeFile(journalPath, `${[
    JSON.stringify({
      kind: 'task.created',
      taskId,
      title: 'cross link',
      directive: 'cross link',
      directiveRevision: 1,
      createdAt,
      taskCounter: 1,
    }),
    JSON.stringify({
      kind: 'operation.started',
      operationId,
      taskId,
      cycleId: scope.cycleId,
      scope,
      executionEpoch: 1,
      operationCounter: 1,
      cycleCounter: 1,
      startedAt: createdAt,
      input: 'cross link',
    }),
    JSON.stringify({
      kind: 'operation.event',
      operationId,
      event: {
        eventId: 'event-cross-link',
        seq: 1,
        occurredAt: createdAt,
        taskId,
        operationId: 'operation-somewhere-else',
        executionEpoch: 1,
        kind: 'execution.started',
        state: 'running',
        summary: 'foreign event',
        evidenceRefs: [],
      },
    }),
  ].join('\n')}\n`, 'utf8');

  assert.throws(
    () => new RuntimeTaskCoordinator({
      organId,
      createDriver: () => {
        throw new Error('createDriver must not run while replaying a corrupt journal');
      },
      checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
      attentionPort: attentionPort(),
      journal: new UiRuntimeJournal(journalPath),
    }),
    (error: unknown) => error instanceof RuntimeTaskControlError
      && error.code === 'journal.corrupt'
      && error.message.includes('operation-cross-link'),
  );
});

test('task snapshot keeps the stored directive instead of substituting the execution input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-directive-'));
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `task-${task.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
  });
  const task = coordinator.createTask({ title: 'directive title', directive: 'directive objective' });

  assert.equal(coordinator.taskSnapshot(task.taskId).directive, 'directive objective');
  assert.equal(coordinator.taskSnapshot(task.taskId).directiveRevision, 1);
  assert.equal(coordinator.taskSnapshot(task.taskId).input, '');

  const restarted = new RuntimeTaskCoordinator({
    organId,
    createDriver: () => { throw new Error('no execution in this test'); },
    checkpointStoreFor: (taskId, cycle) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycle.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
  });
  assert.equal(restarted.taskSnapshot(task.taskId).directive, 'directive objective');
});

test('restart restores a failed task error owner and next action from the app journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-failure-restart-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: async () => {
      throw new ProviderAdapterError({
        code: 'provider.unavailable',
        category: 'provider',
        phase: 'start',
        message: 'provider is unavailable',
        retryable: 'retryable',
        nextAction: { kind: 'recover', ref: 'provider-owner' },
      });
    },
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const first = serviceFor(root, failing);
  const task = first.createTask({ title: 'failure restart' });
  first.startExecution(task.taskId, { prompt: 'fail' });
  await waitFor(() => assert.equal(first.taskDashboard(task.taskId).state, 'failed'));
  assert.equal(first.taskDashboard(task.taskId).error?.ownerId, 'humanagent.provider-adapter');

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await second.hydrate();
  const restored = second.taskDashboard(task.taskId);
  assert.equal(restored.state, 'failed');
  assert.equal(restored.error?.code, 'provider.unavailable');
  assert.equal(restored.error?.ownerId, 'humanagent.provider-adapter');
  assert.match(restored.error?.nextAction ?? '', /provider-owner/);
});

test('restart projects an orphaned running execution as blocked instead of pretending it still has a live handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-orphan-'));
  const base = new FakeReplayExecutionRuntimePort({ binding });
  const hanging: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: async function* observe() {
      await new Promise<void>(() => {});
    },
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const first = serviceFor(root, hanging);
  const task = first.createTask({ title: 'orphaned execution' });
  const started = first.startExecution(task.taskId, { prompt: 'leave this running' });
  assert.equal(first.taskDashboard(task.taskId).state, 'running');
  assert.equal(first.eventsSince(started.operationId).length, 1);

  const restarted = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await restarted.hydrate();
  const dashboard = restarted.taskDashboard(task.taskId);
  assert.equal(dashboard.state, 'blocked');
  assert.deepEqual(dashboard.allowedActions, []);
  const waiting = restarted.listTasks().waiting.find((row) => row.taskId.value === task.taskId.value);
  assert.ok(waiting?.currentState.match(/进程已重启或缺少终态 checkpoint/));
  assert.deepEqual(restarted.eventsSince(started.operationId).map((event) => event.kind), ['execution.started']);
});

test('one completed task does not close the shared provider while another task is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-concurrent-'));
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 60 });
  const service = serviceFor(root, port);
  const first = service.createTask({ title: 'first concurrent task' });
  const second = service.createTask({ title: 'second concurrent task' });

  service.startExecution(first.taskId, { prompt: 'first' });
  service.startExecution(second.taskId, { prompt: 'second' });
  await waitFor(() => assert.equal(service.taskDashboard(first.taskId).state, 'succeeded'));
  await waitFor(() => assert.equal(service.taskDashboard(second.taskId).state, 'succeeded'));

  assert.equal(service.taskDashboard(first.taskId).error, undefined);
  assert.equal(service.taskDashboard(second.taskId).error, undefined);
});

test('stopping one task does not close the shared provider while another task is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-concurrent-stop-'));
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 80 });
  const service = serviceFor(root, port);
  const stoppedTask = service.createTask({ title: 'stop concurrent task' });
  const continuingTask = service.createTask({ title: 'continue concurrent task' });

  service.startExecution(stoppedTask.taskId, { prompt: 'stop this task' });
  service.startExecution(continuingTask.taskId, { prompt: 'finish this task' });
  const stopped = await service.stop(stoppedTask.taskId);
  assert.equal(stopped.state, 'stopped');
  await waitFor(() => assert.equal(service.taskDashboard(continuingTask.taskId).state, 'succeeded'));

  assert.equal(service.taskDashboard(stoppedTask.taskId).error, undefined);
  assert.equal(service.taskDashboard(continuingTask.taskId).error, undefined);
});

test('second execution starts a new checkpoint cycle for the same task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-second-cycle-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const task = service.createTask({ title: 'second cycle' });

  const first = service.startExecution(task.taskId, { prompt: 'first cycle' });
  assert.equal(first.executionEpoch, 1);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const second = service.startExecution(task.taskId, { prompt: 'second cycle' });
  assert.equal(second.executionEpoch, 2);
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.error, undefined);
  assert.equal(dashboard.checkpoint?.seq, 1);
});

test('stop goes through the formal stop operation and only reports stopped after a stopped checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 }));
  const task = service.createTask({ title: 'stop lifecycle' });
  const started = service.startExecution(task.taskId, { prompt: 'stop this execution' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  const result = await service.stop(task.taskId);
  assert.equal(result.state, 'stopped');

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.state, 'stopped');
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.equal(dashboard.error, undefined);
  assert.deepEqual(dashboard.allowedActions, ['start']);

  const events = service.eventsSince(started.operationId);
  const settlingIndex = events.findIndex((event) => event.kind === 'execution.settling');
  const checkpointIndex = events.findIndex((event) => event.kind === 'checkpoint.committed' && event.state === 'stopped');
  const terminalIndex = events.findIndex((event) => event.kind === 'execution.terminal' && event.state === 'stopped');
  assert.ok(settlingIndex >= 0);
  assert.ok(checkpointIndex > settlingIndex);
  assert.ok(terminalIndex > checkpointIndex);

  const journal = await readFile(join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`), 'utf8');
  assert.match(journal, /"outcome":"stopped"/);
});

test('a stopped task remains stopped after restart hydration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stopped-restart-'));
  const first = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 }));
  const task = first.createTask({ title: 'stopped restart' });
  first.startExecution(task.taskId, { prompt: 'stop before restart' });
  assert.equal((await first.stop(task.taskId)).state, 'stopped');

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await second.hydrate();
  const dashboard = second.taskDashboard(task.taskId);
  assert.equal(dashboard.state, 'stopped');
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.deepEqual(dashboard.allowedActions, ['start']);
});

test('stop racing a startup failure leaves a terminal failed task instead of retry-stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-startup-stop-race-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new ProviderAdapterError({
        code: 'provider.unavailable',
        category: 'provider',
        phase: 'start',
        message: 'provider start failed before submit',
        retryable: 'retryable',
        nextAction: { kind: 'recover', ref: 'provider-owner' },
      });
    },
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, failing);
  const task = service.createTask({ title: 'startup failure during stop' });
  const started = service.startExecution(task.taskId, { prompt: 'fail while stopping' });

  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.running',
  );
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  assert.deepEqual(service.taskDashboard(task.taskId).allowedActions, ['start']);
  assert.equal(service.eventsSince(started.operationId).some((event) => event.state === 'blocked'), false);
});

test('driver construction failure releases startup waiters and leaves the task terminally failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-driver-factory-'));
  const coordinator = new RuntimeTaskCoordinator({
    organId,
    checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`)),
    attentionPort: attentionPort(),
    journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
    createDriver: () => {
      throw new Error('driver assembly failed');
    },
  });
  const task = coordinator.createTask({ title: 'driver factory failure' });
  const started = coordinator.startExecution(task.taskId, { prompt: 'construct driver' });

  await waitFor(() => assert.equal(coordinator.taskSnapshot(task.taskId).state, 'failed'));
  const dashboard = coordinator.taskSnapshot(task.taskId);
  assert.equal(dashboard.error?.ownerId, 'humanagent.runtime');
  assert.equal(dashboard.error?.message, 'driver assembly failed');
  assert.deepEqual(dashboard.allowedActions, ['start']);
  await assert.rejects(
    () => coordinator.stop(task.taskId),
    (error: unknown) => error instanceof RuntimeTaskControlError && error.code === 'task.not.running',
  );
  assert.deepEqual(coordinator.eventsSince(started.operationId).map((event) => event.kind), [
    'execution.started',
    'provider.error',
    'checkpoint.committed',
    'execution.terminal',
  ]);
  assert.equal(coordinator.taskSnapshot(task.taskId).checkpoint?.outcome, 'failed');
});

test('restart hydration rejects a checkpoint copied under another task scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-checkpoint-scope-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: async () => {
      throw new ProviderAdapterError({
        code: 'provider.unavailable',
        category: 'provider',
        phase: 'start',
        message: 'provider is unavailable',
        nextAction: { kind: 'recover', ref: 'provider-owner' },
      });
    },
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const first = serviceFor(root, failing);
  const failedTask = first.createTask({ title: 'failed source' });
  first.startExecution(failedTask.taskId, { prompt: 'fail source' });
  await waitFor(() => assert.equal(first.taskDashboard(failedTask.taskId).state, 'failed'));
  const failedCheckpointFile = join(root, `task-${failedTask.taskId.value}-cycle-ui-cycle-1.jsonl`);

  const second = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await second.hydrate();
  const targetTask = second.createTask({ title: 'scope mismatch target' });
  second.startExecution(targetTask.taskId, { prompt: 'succeed target' });
  await waitFor(() => assert.equal(second.taskDashboard(targetTask.taskId).state, 'succeeded'));
  const targetCheckpointFile = join(root, `task-${targetTask.taskId.value}-cycle-ui-cycle-2.jsonl`);
  await writeFile(targetCheckpointFile, await readFile(failedCheckpointFile, 'utf8'), 'utf8');

  const restarted = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  await restarted.hydrate();
  assert.equal(restarted.taskDashboard(targetTask.taskId).state, 'blocked');
});

test('checkpoint latest reads prefer exact operation chains and fall back to business checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-checkpoint-operation-scope-'));
  const store = new FileCheckpointStore(join(root, 'checkpoints.jsonl'));
  const taskId = id('task', 'shared-task');
  const cycleId = id('cycle', 'shared-cycle');
  const businessScope: ScopeRef = {
    organId,
    taskId,
    cycleId,
  };
  const scopeA: ScopeRef = {
    organId,
    taskId,
    cycleId,
    operationId: id('operation', 'operation-a'),
  };
  const scopeB: ScopeRef = {
    organId,
    taskId,
    cycleId,
    operationId: id('operation', 'operation-b'),
  };

  const checkpoint = (
    scope: ScopeRef,
    seq: number,
    previousCheckpointId: Checkpoint['previousCheckpointId'],
  ): Checkpoint => {
    const label = scope.operationId?.value ?? 'business';
    return {
      id: id('checkpoint', `${label}-${seq}`),
      scope,
      cycleId,
      seq,
      previousCheckpointId,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'succeeded',
      summary: `${label} checkpoint ${seq}`,
      recoveryStateRef: evidence(`${label}-${seq}-recovery`, scope),
      evidenceRefs: [evidence(`${label}-${seq}-completion`, scope)],
      next: { kind: 'continue', ref: 'retry-closure' },
    };
  };

  const checkpointA1 = checkpoint(scopeA, 1, null);
  const checkpointB1 = checkpoint(scopeB, 1, null);
  const checkpointA2 = checkpoint(scopeA, 2, checkpointA1.id);
  const business1 = checkpoint(businessScope, 1, null);
  const business2 = checkpoint(businessScope, 2, business1.id);
  const checkpointB2 = checkpoint(scopeB, 2, checkpointB1.id);
  await appendCheckpoint(store, checkpointA1);
  await appendCheckpoint(store, checkpointB1);
  await appendCheckpoint(store, checkpointA2);
  await appendCheckpoint(store, business1);
  await appendCheckpoint(store, business2);
  await appendCheckpoint(store, checkpointB2);

  const retryReadA = await store.readLatest(scopeA);
  assert.equal(retryReadA?.checkpoint.id.value, checkpointA2.id.value);
  assert.equal(retryReadA?.previous?.id.value, checkpointA1.id.value);

  const retryReadB = await store.readLatest(scopeB);
  assert.equal(retryReadB?.checkpoint.id.value, checkpointB2.id.value);
  assert.equal(retryReadB?.previous?.id.value, checkpointB1.id.value);

  const businessRead = await store.readLatest(businessScope);
  assert.equal(businessRead?.checkpoint.id.value, business2.id.value);
  assert.equal(businessRead?.previous?.id.value, business1.id.value);

  const missingOperationRead = await store.readLatest({
    organId,
    taskId,
    cycleId,
    operationId: id('operation', 'operation-missing'),
  });
  assert.equal(missingOperationRead?.checkpoint.id.value, business2.id.value);
  assert.equal(missingOperationRead?.previous?.id.value, business1.id.value);
});

test('hydration restores a business predecessor for an operation-scoped stopped checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-checkpoint-stopped-predecessor-'));
  const taskId = id('task', 'ui-task-checkpoint-hydrate-1');
  const cycleId = id('cycle', 'ui-cycle-1');
  const operationId = id('operation', 'ui-operation-1');
  const businessScope: ScopeRef = {
    organId,
    taskId,
    cycleId,
  };
  const operationScope: ScopeRef = {
    organId,
    taskId,
    cycleId,
    operationId,
  };
  const businessCheckpoint: Checkpoint = {
    id: id('checkpoint', 'hydrate-business-1'),
    scope: businessScope,
    cycleId,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'succeeded',
    summary: 'business checkpoint before stop',
    recoveryStateRef: evidence('hydrate-business-recovery', businessScope),
    evidenceRefs: [evidence('hydrate-business-evidence', businessScope)],
    next: { kind: 'continue', ref: 'task://hydrate/next' },
  };
  const stoppedCheckpoint: Checkpoint = {
    id: id('checkpoint', 'hydrate-stopped-1'),
    scope: operationScope,
    cycleId,
    seq: 2,
    previousCheckpointId: businessCheckpoint.id,
    directiveRevision: 1,
    executionEpoch: 1,
    outcome: 'stopped',
    summary: 'stopped checkpoint with business predecessor',
    recoveryStateRef: evidence('hydrate-stopped-recovery', operationScope),
    evidenceRefs: [evidence('hydrate-stopped-evidence', operationScope)],
    next: { kind: 'stop', ref: 'operator-stop' },
  };
  const checkpointFile = join(root, `task-${taskId.value}-cycle-${cycleId.value}.jsonl`);
  const store = new FileCheckpointStore(checkpointFile);
  await appendCheckpoint(store, businessCheckpoint);
  await appendCheckpoint(store, stoppedCheckpoint);

  const latest = await store.readLatest(operationScope);
  if (!latest) throw new Error('expected latest operation-scoped stopped checkpoint');
  assert.equal(latest.checkpoint.id.value, stoppedCheckpoint.id.value);
  assert.equal(latest.previous?.id.value, businessCheckpoint.id.value);
  assert.equal(latest.previous?.scope.operationId, undefined);

  const createdAt = '2026-01-01T00:00:00.000Z';
  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  await writeFile(journalPath, `${[
    JSON.stringify({
      kind: 'task.created',
      taskId,
      title: 'hydrate stopped predecessor',
      directive: 'hydrate stopped predecessor',
      directiveRevision: 1,
      createdAt,
      taskCounter: 1,
    }),
    JSON.stringify({
      kind: 'operation.started',
      operationId,
      taskId,
      cycleId,
      scope: operationScope,
      executionEpoch: 1,
      operationCounter: 1,
      cycleCounter: 1,
      startedAt: createdAt,
      input: 'hydrate stopped predecessor',
    }),
  ].join('\n')}\n`, 'utf8');

  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    new UiRuntimeJournal(journalPath),
  );
  await service.hydrate();
  const dashboard = service.taskDashboard(taskId);
  assert.equal(dashboard.state, 'stopped');
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.equal(dashboard.checkpoint?.checkpointId, stoppedCheckpoint.id.value);
});

test('stop during provider observation keeps the stopped projection free of late errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-observed-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 60 }));
  const task = service.createTask({ title: 'stop during observation' });
  const started = service.startExecution(task.taskId, { prompt: 'observe before stop' });

  await waitFor(() => assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'provider.model'), true));
  const result = await service.stop(task.taskId);
  assert.equal(result.state, 'stopped');
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'stopped'));

  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.equal(dashboard.error, undefined);
  assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'provider.error' && event.state === 'failed'), false);
});

test('stop immediately after start waits for provider readiness and settles through stop control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-startup-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 }));
  const task = service.createTask({ title: 'immediate stop' });
  const started = service.startExecution(task.taskId, { prompt: 'stop before first event' });

  const result = await service.stop(task.taskId);
  assert.equal(result.state, 'stopped');
  assert.equal(service.taskDashboard(task.taskId).state, 'stopped');
  assert.equal(service.taskDashboard(task.taskId).error, undefined);
  assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'checkpoint.committed' && event.state === 'stopped'), true);
});

test('SSE replay honors Last-Event-ID without returning already delivered events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-replay-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const task = service.createTask({ title: 'replay lifecycle' });
  const started = service.startExecution(task.taskId, { prompt: 'replay' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const all = service.eventsSince(started.operationId);
  assert.ok(all.length > 2);
  const replay = service.eventsSince(started.operationId, all[1]!.eventId);
  assert.deepEqual(replay.map((event) => event.eventId), all.slice(2).map((event) => event.eventId));
  assert.deepEqual(service.eventsSince(started.operationId, 'unknown-event'), all);
});

test('ui runtime server refuses to bind the unauthenticated control API outside loopback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-host-guard-'));
  await assert.rejects(async () => {
    await startUiRuntime({
      mode: 'fake',
      organId,
      binding,
      port: buildFakeExecutionPort(binding),
      checkpointRoot: join(root, 'checkpoints'),
      evidenceRoot: join(root, 'evidence'),
      uiRoot: join(process.cwd(), 'docs', 'ui'),
      providerState: 'ready',
      host: '0.0.0.0',
      portNumber: 0,
    });
  }, /loopback/);
});

test('ui runtime server formats IPv6 loopback URLs with brackets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-ipv6-host-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    host: '::1',
    portNumber: 0,
  });
  try {
    assert.match(runtime.server.url, /^http:\/\/\[::1\]:\d+$/);
    const response = await fetch(`${runtime.server.url}/api/runtime/status`);
    assert.equal(response.status, 200);
  } finally {
    await runtime.server.close();
  }
});

test('ui runtime server rejects static files that resolve outside the UI root through symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-static-root-'));
  const uiRoot = join(root, 'ui');
  await mkdir(uiRoot);
  const secret = join(root, 'secret.txt');
  await writeFile(secret, 'secret');
  await symlink(secret, join(uiRoot, 'leak.txt'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot,
    providerState: 'ready',
    portNumber: 0,
  });
  try {
    const response = await fetch(`${runtime.server.url}/leak.txt`);
    assert.equal(response.status, 403);
  } finally {
    await runtime.server.close();
  }
});

test('unknown execution events return a typed JSON error without crashing the server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-sse-error-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
  });
  try {
    const response = await fetch(`${runtime.server.url}/api/executions/unknown-operation/events`);
    assert.equal(response.status, 404);
    const body = await response.json() as { readonly error: { readonly code: string; readonly ownerId: string } };
    assert.equal(body.error.code, 'operation.not.found');
    assert.equal(body.error.ownerId, 'humanagent.runtime');

    const status = await fetch(`${runtime.server.url}/api/runtime/status`);
    assert.equal(status.status, 200);
  } finally {
    await runtime.server.close();
  }
});

test('runtime API rejects a mode mismatch and exposes dsh as disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-api-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
  });
  try {
    const status = await fetch(`${runtime.server.url}/api/runtime/status`);
    assert.equal(status.status, 200);
    const statusBody = await status.json() as { readonly mode: string; readonly modes: readonly { readonly mode: string; readonly state: string }[] };
    assert.equal(statusBody.mode, 'fake');
    assert.equal(statusBody.modes.find((mode) => mode.mode === 'dsh')?.state, 'disabled');

    const created = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'api task' }),
    });
    assert.equal(created.status, 201);
    const task = await created.json() as { readonly taskId: { readonly value: string } };

    const mismatch = await fetch(`${runtime.server.url}/api/tasks/${task.taskId.value}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'rcc', prompt: 'must not silently switch modes' }),
    });
    assert.equal(mismatch.status, 400);
    const mismatchBody = await mismatch.json() as { readonly error: { readonly code: string; readonly ownerId: string; readonly nextAction: string } };
    assert.equal(mismatchBody.error.code, 'execution.mode.mismatch');
    assert.equal(mismatchBody.error.ownerId, 'humanagent.app');
    assert.match(mismatchBody.error.nextAction, /restart/);
  } finally {
    await runtime.server.close();
  }
});

test('runtime API task detail uses the task-detail projection surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-task-detail-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
  });
  try {
    const created = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'task detail surface' }),
    });
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    const detail = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(task.taskId.value)}`);
    assert.equal(detail.status, 200);
    const body = await detail.json() as { readonly surface: string; readonly taskId: { readonly value: string } };
    assert.equal(body.surface, 'task-detail');
    assert.equal(body.taskId.value, task.taskId.value);
  } finally {
    await runtime.server.close();
  }
});

test('runtime HTTP API reconstructs task state and SSE replay after a server restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-http-restart-'));
  const checkpointRoot = join(root, 'checkpoints');
  const first = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 1),
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
  });
  let taskId: string;
  let operationId: string;
  try {
    const created = await fetch(`${first.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'http restart task' }),
    });
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    taskId = task.taskId.value;
    const started = await fetch(`${first.server.url}/api/tasks/${encodeURIComponent(taskId)}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fake', prompt: 'persist this' }),
    });
    const operation = await started.json() as { readonly operationId: string };
    operationId = operation.operationId;
    await waitFor(() => assert.equal(first.service.taskDashboard(id('task', taskId)).state, 'succeeded'));
  } finally {
    await first.server.close();
  }

  const second = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 1),
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
  });
  try {
    const tasks = await fetch(`${second.server.url}/api/tasks`);
    const body = await tasks.json() as { readonly completed: readonly { readonly taskId: { readonly value: string }; readonly state: string }[] };
    assert.equal(body.completed.some((task) => task.taskId.value === taskId && task.state === 'succeeded'), true);

    const events = await fetch(`${second.server.url}/api/executions/${encodeURIComponent(operationId)}/events`);
    const text = await events.text();
    assert.match(text, /event: execution\.terminal/);
    assert.match(text, /event: checkpoint\.committed/);
  } finally {
    await second.server.close();
  }
});

test('HTTP SSE keeps the first connection open through settling, checkpoint, and final terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-http-sse-lifecycle-'));
  const runtime = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 30),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
  });
  try {
    const task = runtime.service.createTask({ title: 'http sse lifecycle' });
    const started = runtime.service.startExecution(task.taskId, { prompt: 'stream the full lifecycle' });
    const events = await fetch(`${runtime.server.url}/api/executions/${encodeURIComponent(started.operationId.value)}/events`);
    assert.equal(events.status, 200);
    const text = await events.text();
    const kinds = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(kinds.slice(-3), [
      'execution.settling',
      'checkpoint.committed',
      'execution.terminal',
    ]);
    const payloads = [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]!) as { readonly kind: string; readonly terminalPhase?: string });
    assert.equal(payloads.at(-1)?.kind, 'execution.terminal');
    assert.equal(payloads.at(-1)?.terminalPhase, 'final');
  } finally {
    await runtime.server.close();
  }
});

test('checkpoint committedAt binds to the checkpoint event instead of later terminal updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-checkpoint-time-'));
  let tick = 0;
  const service = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  );
  const task = service.createTask({ title: 'checkpoint timestamp' });
  const started = service.startExecution(task.taskId, { prompt: 'timestamp' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const events = service.eventsSince(started.operationId);
  const checkpointEvent = events.find((event) => event.kind === 'checkpoint.committed');
  const terminalEvent = events.at(-1);
  if (!checkpointEvent || !terminalEvent) throw new Error('expected checkpoint and terminal events');
  assert.equal(checkpointEvent.kind, 'checkpoint.committed');
  assert.equal(terminalEvent.kind, 'execution.terminal');
  assert.equal(checkpointEvent.occurredAt === terminalEvent.occurredAt, false);
  assert.equal(service.taskDashboard(task.taskId).checkpoint?.committedAt, checkpointEvent.occurredAt);
});

test('fake and rcc modes do not hydrate each other through a shared checkpoint root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-mode-isolation-'));
  const checkpointRoot = join(root, 'checkpoints');
  const fake = await startUiRuntime({
    mode: 'fake',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 1),
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
  });
  try {
    const created = await fetch(`${fake.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'fake-only task' }),
    });
    assert.equal(created.status, 201);
  } finally {
    await fake.server.close();
  }

  const rcc = await startUiRuntime({
    mode: 'rcc',
    organId,
    binding,
    port: buildFakeExecutionPort(binding, 1),
    checkpointRoot,
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    portNumber: 0,
  });
  try {
    const tasks = await fetch(`${rcc.server.url}/api/tasks`);
    const body = await tasks.json() as { readonly counts: { readonly total: number } };
    assert.equal(body.counts.total, 0);
  } finally {
    await rcc.server.close();
  }
});

test('rcc startup projects provider readiness failure instead of claiming ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-readiness-'));
  const base = new FakeReplayExecutionRuntimePort({ binding });
  const unavailable: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: async () => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'dependency-missing',
      capabilityDigest: binding.capabilityDigest,
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evidenceRefs: [evidence('readiness-failure', { organId })],
      ownerId: 'humanagent.provider-adapter.rcc-v3',
      nextAction: { kind: 'recover', ref: 'rcc-v3.health' },
    }),
    capabilities: (value) => base.capabilities(value),
    start: (input) => base.start(input),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const runtime = await startUiRuntime({
    mode: 'rcc',
    organId,
    binding,
    port: unavailable,
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    portNumber: 0,
  });
  try {
    const status = await fetch(`${runtime.server.url}/api/runtime/status`);
    const body = await status.json() as {
      readonly state: string;
      readonly providerState: string;
      readonly providerError?: { readonly ownerId: string; readonly nextAction: string };
    };
    assert.equal(body.state, 'unavailable');
    assert.equal(body.providerState, 'dependency-missing');
    assert.equal(body.providerError?.ownerId, 'humanagent.provider-adapter.rcc-v3');
    assert.match(body.providerError?.nextAction ?? '', /rcc-v3\.health/);

    const created = await fetch(`${runtime.server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'must not start while unavailable' }),
    });
    const task = await created.json() as { readonly taskId: { readonly value: string } };
    const start = await fetch(`${runtime.server.url}/api/tasks/${task.taskId.value}/executions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'rcc', prompt: 'must not create an operation' }),
    });
    assert.equal(start.status, 409);
    const startBody = await start.json() as {
      readonly error: { readonly code: string; readonly ownerId: string; readonly nextAction: string };
    };
    assert.equal(startBody.error.code, 'provider.readiness.dependency-missing');
    assert.equal(startBody.error.ownerId, 'humanagent.provider-adapter.rcc-v3');
    assert.match(startBody.error.nextAction, /rcc-v3\.health/);

    const dashboard = await fetch(`${runtime.server.url}/api/tasks/${task.taskId.value}/dashboard`);
    const dashboardBody = await dashboard.json() as { readonly state: string; readonly operationId?: string };
    assert.equal(dashboardBody.state, 'created');
    assert.equal(dashboardBody.operationId, undefined);
  } finally {
    await runtime.server.close();
  }
});

test('provider failures are projected with owner, retryability, and next action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-error-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const failing: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: async () => {
      throw new ProviderAdapterError({
        code: 'provider.unavailable',
        category: 'provider',
        phase: 'start',
        message: 'provider is unavailable',
        retryable: 'retryable',
        nextAction: { kind: 'recover', ref: 'provider-owner' },
      });
    },
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, failing);
  const task = service.createTask({ title: 'failure lifecycle' });
  service.startExecution(task.taskId, { prompt: 'fail explicitly' });

  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'failed'));
  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.error?.code, 'provider.unavailable');
  assert.equal(dashboard.error?.ownerId, 'humanagent.provider-adapter');
  assert.equal(dashboard.error?.retryable, true);
  assert.match(dashboard.error?.nextAction ?? '', /provider-owner/);
  assert.equal(service.dashboard().recentFailures[0]?.code, 'provider.unavailable');
  const journal = await readFile(join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`), 'utf8');
  assert.match(journal, /"outcome":"failed"/);
});

test('startExecution rejects a task that is not allowed to start after stop-control failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-start-guard-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 600 });
  const failingStop: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: async () => {
      throw new ProviderAdapterError({
        code: 'stop.failed',
        category: 'runtime',
        phase: 'stop',
        message: 'stop failed',
        nextAction: { kind: 'recover', ref: 'stop-owner' },
      });
    },
    settle: (input) => base.settle(input),
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, failingStop);
  const task = service.createTask({ title: 'start guard' });
  service.startExecution(task.taskId, { prompt: 'start guard' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  const stopResult = await service.stop(task.taskId);
  assert.equal(stopResult.state, 'settling');
  assert.equal(service.taskDashboard(task.taskId).state, 'settling');
  assert.deepEqual(service.taskDashboard(task.taskId).allowedActions, ['retry-stop']);
  const retryResult = await service.retryStop(task.taskId);
  assert.equal(retryResult.state, 'settling');
  assert.throws(
    () => service.startExecution(task.taskId, { prompt: 'should reject' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.busy',
  );
});

test('stop control rejects a second stop and preserves the original operation identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-race-'));
  const service = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 100 }));
  const task = service.createTask({ title: 'stop race' });
  service.startExecution(task.taskId, { prompt: 'stop race' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  const first = await service.stop(task.taskId);
  assert.equal(first.state, 'stopped');
  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.running',
  );
});

test('ordinary settlement removes stop eligibility before awaiting provider settle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-settle-stop-race-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  let releaseSettle!: () => void;
  const settleGate = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });
  const delayedSettle: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (input) => base.resume(input),
    submit: (input) => base.submit(input),
    observe: (input) => base.observe(input),
    requestStop: (input) => base.requestStop(input),
    settle: async (input) => {
      await settleGate;
      return base.settle(input);
    },
    close: (value) => base.close(value),
  };
  const service = serviceFor(root, delayedSettle);
  const task = service.createTask({ title: 'settle stop race' });
  service.startExecution(task.taskId, { prompt: 'settle stop race' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'settling'));
  assert.deepEqual(service.taskDashboard(task.taskId).allowedActions, []);
  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.running',
  );
  releaseSettle();
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));
});

test('UI admission and decoded-control core hooks gate the real execution entry', async () => {
  const admissionRoot = await mkdtemp(join(tmpdir(), 'humanagent-ui-admission-hook-'));
  let admissionStarts = 0;
  const admissionBase = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const admissionPort: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => admissionBase.probe(value),
    capabilities: (value) => admissionBase.capabilities(value),
    start: async (value) => {
      admissionStarts += 1;
      return admissionBase.start(value);
    },
    resume: (value) => admissionBase.resume(value),
    submit: (value) => admissionBase.submit(value),
    observe: (value) => admissionBase.observe(value),
    requestStop: (value) => admissionBase.requestStop(value),
    settle: (value) => admissionBase.settle(value),
    close: (value) => admissionBase.close(value),
  };
  const admissionHooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-admission-gate',
    version: '1',
    mode: 'core',
    stages: ['request.admitted'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['admission rejected'],
      ownerId: 'ui-admission-gate',
      nextAction: 'repair admission',
    }),
  }]);
  const admissionService = serviceFor(admissionRoot, admissionPort, 'fake', 'ready', undefined, undefined, admissionHooks);
  const admissionTask = admissionService.createTask({ title: 'admission gate' });
  const admissionStarted = admissionService.startExecution(admissionTask.taskId, { prompt: 'must not dispatch' });
  await waitFor(() => assert.equal(admissionService.taskDashboard(admissionTask.taskId).state, 'failed'));
  assert.equal(admissionStarts, 0);
  assert.equal(admissionService.taskDashboard(admissionTask.taskId).error?.ownerId, 'ui-admission-gate');
  assert.equal(admissionService.eventsSince(admissionStarted.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded'), false);

  const controlRoot = await mkdtemp(join(tmpdir(), 'humanagent-ui-control-hook-'));
  const controlHooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-control-gate',
    version: '1',
    mode: 'core',
    stages: ['control.decoded'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['decoded control rejected'],
      ownerId: 'ui-control-gate',
      nextAction: 'repair decoded control',
    }),
  }]);
  const controlService = serviceFor(
    controlRoot,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    controlHooks,
  );
  const controlTask = controlService.createTask({ title: 'control gate' });
  const controlStarted = controlService.startExecution(controlTask.taskId, { prompt: 'must not succeed' });
  await waitFor(() => assert.equal(controlService.taskDashboard(controlTask.taskId).state, 'failed'));
  assert.equal(controlService.taskDashboard(controlTask.taskId).error?.ownerId, 'ui-control-gate');
  assert.equal(controlService.eventsSince(controlStarted.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded'), false);
});

test('post-commit context hook failure preserves checkpoint identity and recovery after coordinator rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-context-commit-hook-'));
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['post-commit publication failed'],
      ownerId: 'ui-context-commit-gate',
      nextAction: 'reconcile committed checkpoint',
    }),
  }]);
  const failingService = serviceFor(
    root,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    hooks,
  );
  const task = failingService.createTask({ title: 'context commit recovery' });
  const started = failingService.startExecution(task.taskId, { prompt: 'commit once' });
  await waitFor(() => assert.equal(failingService.taskDashboard(task.taskId).state, 'blocked'));
  const failedDashboard = failingService.taskDashboard(task.taskId);
  if (!failedDashboard.checkpoint) throw new Error('expected durable checkpoint identity');
  assert.equal(failedDashboard.checkpoint.outcome, 'succeeded');
  assert.equal(failedDashboard.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(failedDashboard.error?.nextAction, 'reconcile committed checkpoint');
  const checkpointPath = join(root, `task-${task.taskId.value}-cycle-ui-cycle-1.jsonl`);
  const checkpointJournal = await readFile(checkpointPath, 'utf8');
  assert.equal(checkpointJournal.trim().split('\n').length, 1);
  assert.match(checkpointJournal, new RegExp(`checkpoint-${task.taskId.value}-1`));

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.equal(recovered.checkpoint?.checkpointId, failedDashboard.checkpoint.checkpointId);
  assert.equal(recovered.checkpoint?.seq, failedDashboard.checkpoint.seq);
  assert.equal(recovered.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile committed checkpoint');
  assert.equal(rebuilt.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded' && event.terminalPhase === 'final'), false);
});

test('post-commit context hook failure keeps non-succeeded checkpoints blocked after coordinator rebuild', async () => {
  for (const checkpointOutcome of ['failed', 'blocked', 'waiting', 'cancelled', 'unknown'] as const) {
    const root = await mkdtemp(join(tmpdir(), `humanagent-ui-context-commit-${checkpointOutcome}-`));
    const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
      hookId: 'ui-context-commit-gate',
      version: '1',
      mode: 'core',
      stages: ['context.committed'],
      onEnter: async () => ({
        status: 'failed' as const,
        diagnostics: ['post-commit publication failed'],
        ownerId: 'ui-context-commit-gate',
        nextAction: 'reconcile committed checkpoint',
      }),
    }]);
    const failingService = serviceFor(
      root,
      new FakeReplayExecutionRuntimePort({
        binding,
        stepDelayMs: 1,
        replay: [
          { kind: 'terminal', state: checkpointOutcome, summary: `execution ${checkpointOutcome}`, terminalState: checkpointOutcome },
        ],
      }),
      'fake',
      'ready',
      undefined,
      undefined,
      hooks,
    );
    const task = failingService.createTask({ title: `context commit recovery ${checkpointOutcome}` });
    const started = failingService.startExecution(task.taskId, { prompt: `commit ${checkpointOutcome}` });
    await waitFor(() => assert.equal(failingService.taskDashboard(task.taskId).state, 'blocked'));
    const failedDashboard = failingService.taskDashboard(task.taskId);
    if (!failedDashboard.checkpoint) throw new Error(`expected durable ${checkpointOutcome} checkpoint identity`);
    assert.equal(failedDashboard.checkpoint.outcome, checkpointOutcome);
    assert.equal(failedDashboard.error?.ownerId, 'ui-context-commit-gate');
    assert.equal(failedDashboard.error?.nextAction, 'reconcile committed checkpoint');

    const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
    await rebuilt.hydrate();
    const recovered = rebuilt.taskDashboard(task.taskId);
    assert.equal(recovered.state, 'blocked');
    assert.equal(recovered.checkpoint?.checkpointId, failedDashboard.checkpoint.checkpointId);
    assert.equal(recovered.checkpoint?.seq, failedDashboard.checkpoint.seq);
    assert.equal(recovered.checkpoint?.outcome, checkpointOutcome);
    assert.equal(recovered.error?.ownerId, 'ui-context-commit-gate');
    assert.equal(recovered.error?.nextAction, 'reconcile committed checkpoint');
    assert.deepEqual(recovered.allowedActions, []);
    assert.throws(
      () => rebuilt.startExecution(task.taskId, { prompt: 'must remain blocked' }),
      (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
    );
    assert.equal(
      rebuilt.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'blocked' && event.terminalPhase === 'final'),
      true,
    );
  }
});

test('post-commit context hook failure with provider close failure preserves hook recovery after coordinator rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-context-commit-close-failure-'));
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['post-commit publication failed'],
      ownerId: 'ui-context-commit-gate',
      nextAction: 'reconcile committed checkpoint',
    }),
  }]);
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const closeFailure: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (value) => base.resume(value),
    submit: (value) => base.submit(value),
    observe: (value) => base.observe(value),
    requestStop: (value) => base.requestStop(value),
    settle: (value) => base.settle(value),
    close: async () => ({
      bindingId: binding.bindingId,
      providerId: binding.providerId,
      protocol: binding.protocol,
      state: 'failed',
      evidenceRefs: [evidence('provider-close-failure', { organId })],
      ownerId: 'ui-provider-close-owner',
      nextAction: { kind: 'recover', ref: 'provider-close-recovery' },
    }),
  };
  const failingService = serviceFor(root, closeFailure, 'fake', 'ready', undefined, undefined, hooks);
  const task = failingService.createTask({ title: 'context commit close recovery' });
  const started = failingService.startExecution(task.taskId, { prompt: 'commit once with close failure' });
  await waitFor(() => assert.equal(failingService.taskDashboard(task.taskId).state, 'blocked'));
  const failedDashboard = failingService.taskDashboard(task.taskId);
  if (!failedDashboard.checkpoint) throw new Error('expected durable checkpoint identity');
  assert.equal(failedDashboard.checkpoint.outcome, 'succeeded');
  assert.equal(failedDashboard.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(failedDashboard.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(failedDashboard.error?.nextAction, 'reconcile committed checkpoint');
  assert.equal(failedDashboard.error?.cleanupError?.code, 'provider.close.failed');
  assert.equal(failedDashboard.error?.cleanupError?.ownerId, 'ui-provider-close-owner');
  assert.equal(failedDashboard.error?.cleanupError?.evidenceRefs?.[0]?.locator, 'test://provider-close-failure');
  const failureJournal = await readFile(join(root, 'ui-runtime-journal.jsonl'), 'utf8');
  assert.match(failureJournal, /"cleanupError":\{"code":"provider\.close\.failed","ownerId":"ui-provider-close-owner"/);
  assert.match(failureJournal, /ui-test-provider-close-failure/);

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.equal(recovered.checkpoint?.checkpointId, failedDashboard.checkpoint.checkpointId);
  assert.equal(recovered.checkpoint?.seq, failedDashboard.checkpoint.seq);
  assert.equal(recovered.checkpoint?.outcome, 'succeeded');
  assert.equal(recovered.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(recovered.error?.ownerId, 'ui-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile committed checkpoint');
  assert.deepEqual(recovered.allowedActions, []);
  assert.throws(
    () => rebuilt.startExecution(task.taskId, { prompt: 'must remain blocked' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
  );
  assert.equal(
    rebuilt.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'blocked' && event.terminalPhase === 'final'),
    true,
  );
});

test('formal stop with committed stopped checkpoint and context hook failure stays blocked after coordinator rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-context-commit-'));
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-stop-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['stopped checkpoint publication failed'],
      ownerId: 'ui-stop-context-commit-gate',
      nextAction: 'reconcile stopped checkpoint',
    }),
  }]);
  const stopBase = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 40 });
  let closeCalls = 0;
  const stopDriver: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => stopBase.probe(value),
    capabilities: (value) => stopBase.capabilities(value),
    start: (value) => stopBase.start(value),
    resume: (value) => stopBase.resume(value),
    submit: (value) => stopBase.submit(value),
    observe: (value) => stopBase.observe(value),
    requestStop: (value) => stopBase.requestStop(value),
    settle: (value) => stopBase.settle(value),
    close: async (value) => {
      closeCalls += 1;
      return stopBase.close(value);
    },
  };
  const service = serviceFor(
    root,
    stopDriver,
    'fake',
    'ready',
    undefined,
    undefined,
    hooks,
  );
  const task = service.createTask({ title: 'formal stop context recovery' });
  const started = service.startExecution(task.taskId, { prompt: 'stop with post-commit hook failure' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'running'));
  await assert.rejects(
    () => service.stop(task.taskId),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'execution.context-commit-hook.blocked',
  );
  const failedDashboard = service.taskDashboard(task.taskId);
  if (!failedDashboard.checkpoint) throw new Error('expected durable stopped checkpoint identity');
  assert.equal(failedDashboard.state, 'blocked');
  assert.equal(failedDashboard.checkpoint.outcome, 'stopped');
  assert.equal(failedDashboard.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(failedDashboard.error?.ownerId, 'ui-stop-context-commit-gate');
  assert.equal(failedDashboard.error?.nextAction, 'reconcile stopped checkpoint');
  assert.deepEqual(failedDashboard.allowedActions, []);
  assert.equal(closeCalls, 1);

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.equal(recovered.checkpoint?.checkpointId, failedDashboard.checkpoint.checkpointId);
  assert.equal(recovered.checkpoint?.seq, failedDashboard.checkpoint.seq);
  assert.equal(recovered.checkpoint?.outcome, 'stopped');
  assert.equal(recovered.error?.code, 'execution.context-commit-hook.blocked');
  assert.equal(recovered.error?.ownerId, 'ui-stop-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile stopped checkpoint');
  assert.deepEqual(recovered.allowedActions, []);
  assert.throws(
    () => rebuilt.startExecution(task.taskId, { prompt: 'must not start' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
  );
  assert.equal(
    rebuilt.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'blocked' && event.terminalPhase === 'final'),
    true,
  );
});

test('post-commit stop recovery fences a late observation and closes the provider once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-stop-late-observation-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-stop-late-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['stopped checkpoint publication failed'],
      ownerId: 'ui-stop-late-context-commit-gate',
      nextAction: 'reconcile stopped checkpoint',
    }),
  }]);
  let releaseLate!: () => void;
  const lateReady = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let markLateYielded!: () => void;
  const lateYielded = new Promise<void>((resolve) => {
    markLateYielded = resolve;
  });
  let releaseClose!: () => void;
  const closeReady = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let closeCalls = 0;
  const driver: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (value) => base.resume(value),
    submit: (value) => base.submit(value),
    observe: async function* (value) {
      const iterator = base.observe(value)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || !first.value) return;
      yield first.value;
      await lateReady;
      markLateYielded();
      yield {
        ...first.value,
        eventId: `${first.value.eventId}-late`,
        kind: 'output',
        summary: 'late output after stop recovery',
        outputRefs: ['fake://late-after-stop'],
      } as ProviderEvent;
    },
    requestStop: (value) => base.requestStop(value),
    settle: (value) => base.settle(value),
    close: async () => {
      closeCalls += 1;
      await closeReady;
      return base.close(binding);
    },
  };
  const service = serviceFor(root, driver, 'fake', 'ready', undefined, undefined, hooks);
  const task = service.createTask({ title: 'late observation fence' });
  const started = service.startExecution(task.taskId, { prompt: 'stop before late event' });
  await waitFor(() => assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'provider.model'), true));

  const stopping = service.stop(task.taskId);
  await waitFor(() => {
    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.state, 'blocked');
    assert.equal(dashboard.checkpoint?.outcome, 'stopped');
    assert.equal(dashboard.error?.ownerId, 'ui-stop-late-context-commit-gate');
    assert.equal(dashboard.error?.nextAction, 'reconcile stopped checkpoint');
    assert.deepEqual(dashboard.allowedActions, []);
    assert.equal(closeCalls, 1);
  });

  releaseLate();
  await lateYielded;
  assert.equal(service.eventsSince(started.operationId).some((event) => event.summary === 'late output after stop recovery'), false);

  releaseClose();
  await assert.rejects(
    () => stopping,
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'execution.context-commit-hook.blocked',
  );
  assert.equal(closeCalls, 1);
  const dashboard = service.taskDashboard(task.taskId);
  assert.equal(dashboard.checkpoint?.outcome, 'stopped');
  assert.equal(dashboard.error?.ownerId, 'ui-stop-late-context-commit-gate');
  assert.deepEqual(dashboard.allowedActions, []);
  assert.equal(service.eventsSince(started.operationId).filter((event) => event.kind === 'execution.terminal').length, 1);

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.equal(recovered.checkpoint?.outcome, 'stopped');
  assert.equal(recovered.checkpoint?.checkpointId, dashboard.checkpoint?.checkpointId);
  assert.equal(recovered.error?.ownerId, 'ui-stop-late-context-commit-gate');
  assert.deepEqual(recovered.allowedActions, []);
  assert.throws(
    () => rebuilt.startExecution(task.taskId, { prompt: 'must remain blocked after late event' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
  );
});

test('post-commit recovery is durable before a suspended provider close can finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-close-suspended-recovery-'));
  const base = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const hooks = createHookRegistry(() => undefined, () => Date.now(), [{
    hookId: 'ui-close-suspended-context-commit-gate',
    version: '1',
    mode: 'core',
    stages: ['context.committed'],
    onEnter: async () => ({
      status: 'failed' as const,
      diagnostics: ['post-commit publication failed'],
      ownerId: 'ui-close-suspended-context-commit-gate',
      nextAction: 'reconcile committed checkpoint',
    }),
  }]);
  let releaseClose!: () => void;
  const closeReady = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let markCloseFinished!: () => void;
  const closeFinished = new Promise<void>((resolve) => {
    markCloseFinished = resolve;
  });
  let closeCalls = 0;
  const driver: ExecutionRuntimePort = {
    kind: 'humanagent.execution-runtime-port',
    probe: (value) => base.probe(value),
    capabilities: (value) => base.capabilities(value),
    start: (value) => base.start(value),
    resume: (value) => base.resume(value),
    submit: (value) => base.submit(value),
    observe: (value) => base.observe(value),
    requestStop: (value) => base.requestStop(value),
    settle: (value) => base.settle(value),
    close: async () => {
      closeCalls += 1;
      await closeReady;
      const result = await base.close(binding);
      markCloseFinished();
      return result;
    },
  };
  const service = serviceFor(root, driver, 'fake', 'ready', undefined, undefined, hooks);
  const task = service.createTask({ title: 'close suspended recovery' });
  const started = service.startExecution(task.taskId, { prompt: 'persist recovery before close' });
  await waitFor(() => {
    const dashboard = service.taskDashboard(task.taskId);
    assert.equal(dashboard.state, 'blocked');
    assert.equal(dashboard.error?.ownerId, 'ui-close-suspended-context-commit-gate');
    assert.ok(dashboard.checkpoint);
    assert.equal(closeCalls, 1);
  });

  const journalPath = join(root, 'ui-runtime-journal.jsonl');
  const journalWhileCloseSuspended = await readFile(journalPath, 'utf8');
  assert.match(journalWhileCloseSuspended, /"state":"blocked"/);
  assert.match(journalWhileCloseSuspended, /ui-close-suspended-context-commit-gate/);

  const rebuilt = serviceFor(root, new FakeReplayExecutionRuntimePort({ binding }));
  await rebuilt.hydrate();
  const recovered = rebuilt.taskDashboard(task.taskId);
  assert.equal(recovered.state, 'blocked');
  assert.ok(recovered.checkpoint);
  assert.equal(recovered.error?.ownerId, 'ui-close-suspended-context-commit-gate');
  assert.equal(recovered.error?.nextAction, 'reconcile committed checkpoint');
  assert.deepEqual(recovered.allowedActions, []);
  assert.throws(
    () => rebuilt.startExecution(task.taskId, { prompt: 'must remain blocked while close is pending' }),
    (error: unknown) => error instanceof UiRuntimeApiError && error.code === 'task.not.startable',
  );

  releaseClose();
  await closeFinished;
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'blocked'));
  assert.equal(service.eventsSince(started.operationId).some((event) => event.kind === 'execution.terminal' && event.state === 'succeeded' && event.terminalPhase === 'final'), false);
});

test('actual UI entry follows the provider-neutral composition and keeps hook, context, settlement, and failure evidence visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-ui-composition-'));
  const hookEvents: string[] = [];
  const hooks = createHookRegistry(
    (event) => {
      hookEvents.push(`${event.kind}:${event.stage}:${event.hookPhase ?? 'none'}`);
    },
    () => Date.now(),
    [{
      hookId: 'ui-runtime-observation-hook',
      version: '1',
      mode: 'observation',
      stages: [
        'request.created',
        'request.before-dispatch',
        'request.dispatched',
        'attempt.started',
        'response.received',
        'response.decoded',
        'result.mapped',
        'context.committed',
        'request.settled',
      ],
    }],
  );
  const port = new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 });
  const service = serviceFor(root, port, 'fake', 'ready', undefined, undefined, hooks);
  const task = service.createTask({ title: 'composition' });
  const started = service.startExecution(task.taskId, { prompt: 'composition' });
  await waitFor(() => assert.equal(service.taskDashboard(task.taskId).state, 'succeeded'));

  const events = service.eventsSince(started.operationId);
  assert.equal(events.some((event) => event.evidenceRefs.some((ref) => ref.source === 'humanagent.fake-provider')), true);
  assert.equal(events.some((event) => event.kind === 'execution.settling'), true);
  assert.equal(events.some((event) => event.kind === 'checkpoint.committed'), true);
  assert.equal(events.at(-1)?.kind, 'execution.terminal');
  assert.equal(events.at(-1)?.terminalPhase, 'final');
  assert.equal(hookEvents.some((event) => event.endsWith(':request.created:enter')), true);
  assert.equal(hookEvents.some((event) => event.endsWith(':response.received:enter')), true);
  assert.equal(hookEvents.some((event) => event.endsWith(':response.decoded:exit')), true);
  assert.equal(hookEvents.some((event) => event.endsWith(':context.committed:exit')), true);
  assert.equal(hookEvents.some((event) => event.endsWith(':request.settled:exit')), true);

  const capabilities = service.executionCapabilities();
  assert.equal(capabilities.providerNeutralHarness.state, 'available');
  assert.equal(capabilities.requestResponseHooks.state, 'available');
  assert.equal(capabilities.agentIoRequestLifecycle.state, 'unavailable');
  assert.match(capabilities.agentIoRequestLifecycle.reason, /raw response chunks/);
  assert.equal(capabilities.contextCommitReentry.state, 'available');
  assert.equal(capabilities.checkpointSettlementCancellation.state, 'available');
  assert.equal(capabilities.eventBus.state, 'unavailable');
  assert.equal(capabilities.eventBus.ownerId, 'humanagent.runtime.events');

  const failureRoot = await mkdtemp(join(tmpdir(), 'humanagent-ui-composition-failure-'));
  const failingHooks = createHookRegistry(
    () => undefined,
    () => Date.now(),
    [{
      hookId: 'ui-runtime-blocking-hook',
      version: '1',
      mode: 'core',
      stages: ['request.before-dispatch'],
      onEnter: async () => ({
        status: 'failed' as const,
        diagnostics: ['request hook rejected execution'],
        ownerId: 'ui-runtime-blocking-hook',
        nextAction: 'inspect ui-runtime-blocking-hook',
      }),
    }],
  );
  const failingService = serviceFor(
    failureRoot,
    new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    'fake',
    'ready',
    undefined,
    undefined,
    failingHooks,
  );
  const failedTask = failingService.createTask({ title: 'composition failure' });
  const failedStart = failingService.startExecution(failedTask.taskId, { prompt: 'must fail visibly' });
  await waitFor(() => assert.equal(failingService.taskDashboard(failedTask.taskId).state, 'failed'));
  const failedEvents = failingService.eventsSince(failedStart.operationId);
  assert.equal(failedEvents.some((event) => event.kind === 'provider.error' && event.ownerId === 'ui-runtime-blocking-hook'), true);
  assert.equal(failedEvents.some((event) => event.kind === 'checkpoint.committed' && event.state === 'failed'), true);
  assert.equal(failedEvents.at(-1)?.kind, 'execution.terminal');
  assert.equal(failedEvents.at(-1)?.state, 'failed');
  assert.equal(failedEvents.at(-1)?.terminalPhase, 'final');

  assert.equal(typeof AgentRuntime, 'function');
  assert.equal(typeof bindAgentDriver, 'function');
  assert.equal(typeof executeStopControl, 'function');
});
