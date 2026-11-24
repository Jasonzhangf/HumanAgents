import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
import {
  ProviderAdapterError,
} from '../../packages/adapters/provider/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import type { RuntimeExecutionAllocation } from '../../packages/runtime/src/ui-runtime/coordinator.js';
import {
  prepareAgentProvider,
  prepareExecutionAgentProvider,
} from '../../packages/app/src/agent-driver-composition.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import { readPreparedExecutionInput } from '../../packages/app/src/prepared-execution-input.js';
import {
  FakeReplayExecutionRuntimePort,
  startUiRuntime,
  UiRuntimeJournal,
  uiRuntimeControlJournalPath,
  type UiRuntime,
} from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { createExecutionAdmission } from '../../packages/app/src/ui-runtime/execution-admission.js';
import { PreparedExecutionStop } from '../../packages/app/src/ui-runtime/prepared-execution-stop.js';
import { createToolExecutionGateway } from '../../packages/app/src/tool-execution-gateway.js';
import { TASK_EXECUTION_ACTION_ID, TASK_EXECUTION_CAPABILITY } from '../../packages/app/src/ui-runtime/task-control.js';
import type { AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import type { EffectiveAgentProviderBinding, ProviderConfig } from '../../packages/config/src/index.js';

const organId = id('organ', 'transient-retry-stop-production-organ');
const binding: ProviderBinding = {
  bindingId: 'transient-retry-stop-production-binding',
  providerId: 'transient-retry-stop-production-provider',
  protocol: 'responses',
  endpointRef: 'fixture:unused',
  modelRef: 'transient-retry-stop-production-model',
  configDigest: 'sha256:fixture',
  capabilityDigest: 'sha256:fixture',
};

function evidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'execution',
    source: 'humanagent.app.test',
    locator: label,
    scope,
  };
}

function allocation(): RuntimeExecutionAllocation {
  const taskId = id('task', 'transient-retry-stop-production-task');
  const cycleId = id('cycle', 'transient-retry-stop-production-cycle');
  const operationId = id('operation', 'transient-retry-stop-production-operation');
  return {
    runtimeId: 'transient-retry-stop-production-runtime',
    taskId,
    operationId,
    executionEpoch: 1,
    assignmentId: 'transient-retry-stop-production-assignment',
    scope: { organId, taskId, cycleId, operationId },
    inputRefs: ['asset://transient-retry-stop-production/input'],
    ownerId: 'humanagent.runtime',
    directiveRevision: 1,
    inputRevision: 1,
    orchestrated: false,
  };
}

function providerConfig(): ProviderConfig {
  return {
    source: 'http',
    provider: 'rcc',
    binding: binding.bindingId,
    protocol: 'responses',
    model: binding.modelRef,
    route: 'transient-retry-stop-production-route',
    baseUrl: 'http://127.0.0.1:4444',
  };
}

function providerBindings(): EffectiveAgentProviderBinding[] {
  return [
    { agentId: 'transient-retry-stop-agent', roleId: 'execution', source: 'agent', provider: providerConfig() },
    { agentId: 'transient-retry-stop-planner', roleId: 'orchestration', source: 'agent', provider: providerConfig() },
  ];
}

class ControlledTransientStopPort extends FakeReplayExecutionRuntimePort {
  readonly starts: ProviderStartInput[] = [];
  closeCount = 0;
  closeFailuresRemaining: number;

  constructor(options: { readonly closeFailuresRemaining?: number } = {}) {
    super({ binding, stepDelayMs: 1 });
    this.closeFailuresRemaining = options.closeFailuresRemaining ?? 0;
  }

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.starts.push(structuredClone(input));
    if (this.starts.length === 1) {
      const scope: ScopeRef = { organId, taskId: input.taskId, operationId: input.operationId };
      throw new ProviderAdapterError({
        code: 'http.503',
        category: 'provider',
        phase: 'start',
        message: 'controlled HTTP 503 before any retry request',
        retryable: 'retryable',
        evidenceRefs: [evidence('transient-retry-start-503', scope)],
        scope: input,
      });
    }
    return super.start(input);
  }

  override async close(value: ProviderBinding): Promise<ProviderCloseResult> {
    this.closeCount += 1;
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error('controlled original Provider close failure');
    }
    return super.close(value);
  }
}

function taskPreparer(
  port: ExecutionRuntimePort,
  factories: { readonly bump: () => void },
) {
  return (selection: { readonly roleId: 'execution' | 'orchestration' | 'interaction' | 'review' | 'memory';
    readonly configuredAgentId?: string }, owner: PreparedExecutionStop,
  lease: import('../../packages/app/src/ui-runtime/prepared-execution-stop.js').PreparedExecutionStopPreparationLease) => {
    factories.bump();
    return prepareExecutionAgentProvider({
      roleId: selection.roleId,
      ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
      agentProviderBindings: providerBindings(),
      legacyProvider: providerConfig(),
      createPort: () => port,
    }, owner, lease);
  };
}

async function waitFor(read: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      read();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  read();
}

async function waitForFilesystemQuiet(root: string): Promise<void> {
  let previous = '';
  let stableChecks = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const files = await filesUnder(root);
    const snapshot = (await Promise.all(files.map(async (relativePath) => {
      try {
        const value = await readFile(join(root, relativePath));
        return `${relativePath}:${value.byteLength}`;
      } catch {
        return relativePath;
      }
    }))).sort().join('\n');
    stableChecks = snapshot === previous ? stableChecks + 1 : 0;
    if (stableChecks >= 3) return;
    previous = snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function filesUnder(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative.length === 0 ? entry.name : join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, child));
    else files.push(child);
  }
  return files;
}

async function postJson(url: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { cookie, origin: new URL(url).origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function findCleanupError(
  error: { readonly code?: string; readonly cleanupError?: unknown } | undefined,
  code: string,
): { readonly code: string; readonly ownerId?: string; readonly message?: string; readonly nextAction?: string } | undefined {
  let current: { readonly code?: string; readonly ownerId?: string; readonly message?: string;
    readonly nextAction?: string; readonly cleanupError?: unknown } | undefined = error;
  while (current !== undefined) {
    if (current.code === code) return current as { readonly code: string; readonly ownerId?: string;
      readonly message?: string; readonly nextAction?: string };
    current = current.cleanupError as typeof current;
  }
  return undefined;
}

for (const recoveryMode of ['live', 'cold'] as const) {
test(`production ${recoveryMode} retry-stop recovers only the original Provider custody`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-transient-retry-stop-cold-close-'));
  const checkpointRoot = join(root, 'checkpoints');
  const evidenceRoot = join(root, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  let first: UiRuntime | undefined;
  let cold: UiRuntime | undefined;
  try {
    const originalPort = new ControlledTransientStopPort({ closeFailuresRemaining: 1 });
    const originalFactories = { value: 0, bump() { this.value += 1; } };
    let enteredBackoff!: () => void;
    const backoffEntered = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    const launchOptions = {
      mode: 'rcc' as const,
      organId,
      binding,
      checkpointRoot,
      evidenceRoot,
      uiRoot: join(root, 'ui'),
      productRoot: root,
      portNumber: 0,
      host: '127.0.0.1',
      accessControl,
      memory: {
        coordinator: new MemoryCoordinator(),
        backend: new DeterministicMemoryBackend(),
        projectKey: 'transient-retry-stop-production',
        roleId: 'execution' as const,
      },
      explicitBrainInterpreter: { async interpret() { throw new Error('explicit brain is not used'); } },
    };
    first = await startUiRuntime({
      ...launchOptions,
      port: new FakeReplayExecutionRuntimePort({ binding }),
      runtimeComposition: {
        transientRetryWaiter: async (input) => {
          enteredBackoff();
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
        prepareAgentProvider: (selection) => prepareAgentProvider({
          ...selection,
          agentProviderBindings: providerBindings(),
          legacyProvider: providerConfig(),
          evidenceRoot,
        }),
        prepareTaskAgentProvider: taskPreparer(originalPort, originalFactories),
      },
    });
    const createdResponse = await postJson(`${first.server.url}/api/tasks`, cookie, {
      title: 'production cold retry stop',
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { readonly taskId: { readonly value: string } };
    const taskId = id('task', created.taskId.value);
    const grants = new JsonlTaskGrantJournal(new JsonlOrganJournal(
      uiRuntimeControlJournalPath(join(checkpointRoot, 'rcc')),
    ));
    await grants.grant({
      requestId: `transient-retry-stop-production:${taskId.value}`,
      taskId,
      owner: accessControl.readProductPrincipalOwner(),
      capability: {
        actionId: TASK_EXECUTION_ACTION_ID,
        capabilities: [TASK_EXECUTION_CAPABILITY],
        scope: { organId, taskId },
      },
      expectedRevision: 0,
    });
    const startedResponse = await postJson(
      `${first.server.url}/api/tasks/${encodeURIComponent(taskId.value)}/executions`,
      cookie,
      { mode: 'rcc', prompt: 'produce one controlled failed request and retain its close duty' },
    );
    if (!startedResponse.ok) throw new Error(await startedResponse.text());
    const started = await startedResponse.json() as { readonly operationId: string; readonly executionEpoch: number };
    await backoffEntered;
    assert.equal(originalPort.starts.length, 1);

    const stopResponse = await postJson(
      `${first.server.url}/api/tasks/${encodeURIComponent(taskId.value)}/stop`,
      cookie,
    );
    await waitFor(() => assert.equal(first!.service.taskDashboard(taskId).state, 'blocked'));
    const failed = first.service.taskDashboard(taskId);
    assert.equal(stopResponse.status >= 400 || failed.state === 'blocked', true);
    assert.deepEqual(failed.allowedActions, ['retry-stop']);
    assert.equal(failed.operationId, started.operationId);
    assert.equal(originalPort.closeCount, 1);
    assert.equal(originalPort.starts.length, 1, 'the failed close must not send the retry request');

    if (recoveryMode === 'live') {
      const retried = await postJson(
        `${first.server.url}/api/tasks/${encodeURIComponent(taskId.value)}/stop/retry`, cookie,
      );
      assert.equal(retried.status, 202, await retried.text());
      const stopped = first.service.taskDashboard(taskId);
      assert.equal(stopped.state, 'stopped');
      assert.equal(stopped.operationId, started.operationId);
      assert.equal(stopped.executionEpoch, started.executionEpoch);
      assert.equal(originalFactories.value, 1, 'retry must retain the original preparation');
      assert.equal(originalPort.starts.length, 1, 'retry must not send a new model request');
      assert.equal(originalPort.closeCount, 2, 'retry must call the original close owner again');
      assert.equal(stopped.history.events.filter((event) =>
        event.kind === 'execution.terminal' && event.state === 'stopped').length, 1);
      const records = await new JsonlOrganJournal(
        uiRuntimeControlJournalPath(join(checkpointRoot, 'rcc')),
      ).replay();
      const facts = records.flatMap((record) => {
        const fact = (record.payload as { readonly fact?: { readonly kind: string } } | undefined)?.fact;
        return fact === undefined ? [] : [fact];
      });
      for (const kind of ['preparation-entered', 'resource-acquired', 'resource-closed']) {
        assert.equal(facts.filter((fact) => fact.kind === kind).length, 1, kind);
      }
      const repeated = await postJson(
        `${first.server.url}/api/tasks/${encodeURIComponent(taskId.value)}/stop/retry`, cookie,
      );
      await repeated.text();
      assert.equal(originalPort.closeCount, 2, 'completed stop must not close again');
      assert.equal(first.service.taskDashboard(taskId).history.events.filter((event) =>
        event.kind === 'execution.terminal' && event.state === 'stopped').length, 1);
      return;
    }

    await first.service.quiesceImplicitConsumption();
    await waitFor(() => assert.equal(first!.service.listTasks().running.length, 0));
    await first.close();
    first = undefined;
    await waitForFilesystemQuiet(root);
    const coldPort = new ControlledTransientStopPort();
    const coldFactories = { value: 0, bump() { this.value += 1; } };
    cold = await startUiRuntime({
      ...launchOptions,
      port: new FakeReplayExecutionRuntimePort({ binding }),
      runtimeComposition: {
        prepareAgentProvider: (selection) => prepareAgentProvider({
          ...selection,
          agentProviderBindings: providerBindings(),
          legacyProvider: providerConfig(),
          evidenceRoot,
        }),
        prepareTaskAgentProvider: taskPreparer(coldPort, coldFactories),
      },
    });
    assert.equal(coldFactories.value, 0, 'cold hydrate must not enter Task preparation');
    assert.equal(coldPort.starts.length, 0, 'cold hydrate must not start a model request');
    const beforeRetry = cold.service.taskDashboard(taskId);
    assert.equal(beforeRetry.operationId, started.operationId);
    assert.equal(beforeRetry.executionEpoch, started.executionEpoch);
    assert.deepEqual(beforeRetry.allowedActions, ['retry-stop']);

    const retryResponse = await postJson(
      `${cold.server.url}/api/tasks/${encodeURIComponent(taskId.value)}/stop/retry`,
      cookie,
    );
    assert.equal(retryResponse.status >= 400, true);
    const retryFailure = await retryResponse.json() as {
      readonly error: { readonly code: string; readonly ownerId: string; readonly message: string; readonly nextAction: string };
    };
    assert.equal(retryFailure.error.code, 'http.503', 'the original start error stays public and primary');
    assert.equal(coldFactories.value, 0, 'cold retry-stop must not re-enter withPreparation');
    assert.equal(coldPort.starts.length, 0, 'cold retry-stop must not create a model request');
    const unresolved = cold.service.taskDashboard(taskId);
    assert.equal(unresolved.state, 'blocked');
    assert.equal(unresolved.operationId, started.operationId);
    assert.equal(unresolved.executionEpoch, started.executionEpoch);
    assert.equal(unresolved.checkpoint?.outcome, 'stopped');
    assert.deepEqual(unresolved.allowedActions, ['retry-stop']);
    assert.equal(unresolved.error?.code, 'http.503', 'the original start error stays primary');
    const closeUnresolved = findCleanupError(unresolved.error, 'prepared-execution-stop.close-unresolved');
    assert.ok(closeUnresolved, 'the cold stop keeps the App close-unresolved classification in the cleanup chain');
    assert.equal(closeUnresolved?.ownerId, 'humanagent.app.prepared-execution-stop');
    assert.equal(closeUnresolved?.message, 'the live Provider composition is not owned by this producer instance');
    assert.equal(closeUnresolved?.nextAction,
      'join the original preparation owner or retain the unresolved resource responsibility');
    assert.equal(retryFailure.error.nextAction, closeUnresolved?.nextAction,
      'the public recovery action follows the current typed close owner');

    const control = new JsonlOrganJournal(uiRuntimeControlJournalPath(join(checkpointRoot, 'rcc')));
    const records = await control.replay();
    const facts = records.map((record) =>
      (record.payload as { readonly fact?: { readonly kind?: string } } | undefined)?.fact)
      .filter((fact): fact is { readonly kind: string } => fact !== undefined && typeof fact.kind === 'string');
    assert.equal(facts.filter((fact) => fact.kind === 'preparation-entered').length, 1,
      'the original preparation fact remains singular');
    assert.equal(facts.filter((fact) => fact.kind === 'resource-acquired').length, 1,
      'the cold call reads the original acquisition');
    assert.equal(facts.filter((fact) => fact.kind === 'resource-closed').length, 0,
      'an unavailable old custody must remain unresolved');
    assert.equal(records.some((record) =>
      (record.payload as { readonly fact?: { readonly kind?: string } } | undefined)?.fact?.kind === 'settled'), false);
    assert.equal(cold.service.taskDashboard(taskId).history.events.some((event) =>
      event.kind === 'execution.terminal' && event.state === 'stopped'), false,
    'unresolved close must not publish a false stopped terminal');
  } finally {
    await cold?.close().catch(() => undefined);
    await first?.close().catch(() => undefined);
    await accessControl.closeCredentialWatch().catch(() => undefined);
    await waitForFilesystemQuiet(root);
    await rm(root, { recursive: true, force: true });
  }
});
}

function preparedStopAdmission(journal: JsonlOrganJournal, taskJournal: UiRuntimeJournal) {
  return createExecutionAdmission({
    organJournal: journal,
    taskGrantPort: new JsonlTaskGrantJournal(journal),
    principalOwner: 'humanagent.transient-retry-stop-production-test',
    capabilityFor: ({ intent }) => ({
      actionId: TASK_EXECUTION_ACTION_ID,
      capabilities: [TASK_EXECUTION_CAPABILITY],
      scope: { organId: intent.requestedScope.organId, taskId: intent.taskId },
    }),
    resourceBoundary: createPreparedOperationBoundary(taskJournal),
    resolveAdmittedInput: async (value) => readPreparedExecutionInput(taskJournal, value),
    createGateway: (ports) => createToolExecutionGateway({
      ...ports,
      now: () => new Date('2026-11-24T00:00:00.000Z'),
    }),
  });
}

function composition(port: ExecutionRuntimePort): AgentProviderComposition {
  return {
    roleId: 'execution',
    provider: providerConfig(),
    source: 'http',
    binding,
    port,
  };
}

test('retained cold close owner closes the exact binding once and a cold producer reads the durable receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-transient-retry-stop-owner-'));
  try {
    const journalPath = join(root, 'organ.jsonl');
    const taskJournal = new UiRuntimeJournal(join(root, 'tasks.jsonl'));
    const journal = new JsonlOrganJournal(journalPath);
    const value = allocation();
    taskJournal.append({
      kind: 'operation.prepared',
      allocation: value,
      input: 'cold close retained input',
      operationCounter: 1,
      cycleCounter: 1,
    });
    const admission = preparedStopAdmission(journal, taskJournal);
    const producer = new PreparedExecutionStop({ journal, taskJournal, admission });
    const port = new ControlledTransientStopPort();
    await producer.withPreparation(value, async (lease) => producer.takeProvider(lease, composition(port)));

    const first = await producer.closeRetainedTransientRetryProvider(value);
    assert.equal(first.state, 'closed');
    assert.equal(first.bindingId, binding.bindingId);
    assert.equal(port.closeCount, 1);
    const closedFacts = (await journal.replay()).filter((record) =>
      (record.payload as { readonly fact?: { readonly kind?: string } } | undefined)?.fact?.kind === 'resource-closed');
    assert.equal(closedFacts.length, 1);

    const cold = new PreparedExecutionStop({ journal, taskJournal, admission });
    const reread = await cold.closeRetainedTransientRetryProvider(value);
    assert.deepEqual(reread, first, 'the cold producer returns the original durable close receipt');
    assert.equal(port.closeCount, 1, 'reading the durable closure must not run a second physical close');

    const mismatch = { ...value, executionEpoch: value.executionEpoch + 1 };
    await assert.rejects(() => cold.closeRetainedTransientRetryProvider(mismatch),
      (error: unknown) => (error as { readonly code?: unknown }).code === 'execution-composition.owner-source-missing');
    assert.equal(port.closeCount, 1, 'an allocation mismatch must not close the original binding');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
