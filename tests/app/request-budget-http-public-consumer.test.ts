import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ScopeRef,
  type TaskIdentityAppendInput,
  type TaskIdentityRecord,
} from '../../packages/contracts/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { TaskIdentityConsumer, type TaskIdentityPort } from '../../packages/runtime/src/orchestration/task-identity.js';
import {
  FakeReplayExecutionRuntimePort,
  startUiRuntime,
  UiRuntimeJournal,
} from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { TASK_EXECUTION_ACTION_ID, TASK_EXECUTION_CAPABILITY } from '../../packages/app/src/ui-runtime/task-control.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import type { ExplicitBrainInputInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import type { RuntimeTaskListProjection } from '../../packages/ui/contracts/runtime.js';

const organId = id('organ', 'organ-request-budget-http');
const ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'request-budget-http-20261025');
const binding: ProviderBinding = {
  bindingId: 'binding-request-budget-http',
  providerId: 'provider-request-budget-http',
  protocol: 'responses',
  endpointRef: 'fake://request-budget',
  modelRef: 'model-request-budget-http',
  configDigest: 'sha256:request-budget-http-config',
  capabilityDigest: 'sha256:request-budget-http-capability',
};

interface JsonResponse {
  readonly status: number;
  readonly payload: unknown;
}

async function httpJson(
  runtime: Awaited<ReturnType<typeof startUiRuntime>>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<JsonResponse> {
  const response = await fetch(`${runtime.server.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(method === 'POST' ? { origin: runtime.server.url } : {}),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, payload: text.length === 0 ? undefined : JSON.parse(text) };
}

/**
 * The real execution port replays one content unit as continuous `model`
 * delta events that never complete on their own. Only the harness stop brings
 * the session to a closed settlement, exactly like the recorded production
 * defect (same contentUnit, no done).
 */
class NeverCompletingDeltaPort extends FakeReplayExecutionRuntimePort {
  constructor(binding: ProviderBinding) {
    super({
      binding,
      stepDelayMs: 2,
      replay: Array.from({ length: 400 }, (_, index) => ({
        kind: 'model' as const,
        state: 'model',
        summary: `fake replay: delta ${index} accepted the request`,
      })),
    });
  }
}

async function accessControlFor(root: string) {
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  return { accessControl, cookie: accessControl.sessionCookie(session).split(';')[0]! };
}

const createInterpreter: ExplicitBrainInputInterpreter = {
  async interpret(input) {
    return {
      kind: 'requirement',
      normalizedInput: input.rawInput,
      knownFacts: [],
      intent: 'create',
      proposal: `create a task for ${input.rawInput}`,
      structuredProposal: {
        revision: input.inputRevision,
        intent: 'create',
        title: input.rawInput,
        objective: input.rawInput,
        deliverable: `create a task for ${input.rawInput}`,
        deliveryConditions: [],
        evidenceRefs: [],
        blockingGaps: [],
      },
      decisionRefs: [],
      blockingGaps: [],
    };
  },
};

/**
 * Admission rejects any execution without a current TaskGrant. The fixture
 * commits the real identity through the real journal, then grants exactly the
 * returned task scope to the actual product principal owner.
 */
class GrantPreparingIdentityJournal implements TaskIdentityPort {
  constructor(
    private readonly inner: TaskIdentityPort,
    private readonly grants: JsonlTaskGrantJournal,
    private readonly principalOwner: string,
  ) {}

  async append(input: TaskIdentityAppendInput): Promise<TaskIdentityRecord> {
    const record = await this.inner.append(input);
    const existing = await this.grants.readTaskGrant(record.scope.taskId);
    if (existing.grant === null) {
      await this.grants.grant({
        requestId: `request-budget-fixture-grant:${record.scope.taskId.value}`,
        taskId: record.scope.taskId,
        owner: this.principalOwner,
        capability: {
          actionId: TASK_EXECUTION_ACTION_ID,
          capabilities: [TASK_EXECUTION_CAPABILITY],
          scope: { organId: record.scope.organId, taskId: record.scope.taskId },
        },
        expectedRevision: 0,
      });
    }
    return record;
  }

  replay(scope?: ScopeRef): Promise<readonly TaskIdentityRecord[]> {
    return this.inner.replay(scope);
  }
}

async function startRuntimeForBudget(root: string, port: ExecutionRuntimePort) {
  const auth = await accessControlFor(root);
  const taskControlPath = join(root, 'checkpoints', 'fake', 'task-control.jsonl');
  const taskIdentity = new TaskIdentityConsumer(new GrantPreparingIdentityJournal(
    new JsonlTaskIdentityJournal(new JsonlOrganJournal(taskControlPath)),
    new JsonlTaskGrantJournal(new JsonlOrganJournal(taskControlPath)),
    auth.accessControl.readProductPrincipalOwner(),
  ));
  const wallStart = Date.now();
  // The budget clock is accelerated so the declared 90s no-progress budget
  // elapses in a couple of real seconds. The provider stream, the HTTP
  // dispatcher and the journal are all real.
  const now = () => new Date(wallStart + (Date.now() - wallStart) * 200);
  const runtime = await startUiRuntime({
    mode: 'fake',
    productRoot: root,
    organId,
    binding,
    port,
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages', 'ui', 'static'),
    projectKey: 'request-budget-http',
    workspaceRoot: root,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'request-budget-http',
      roleId: 'execution',
    },
    accessControl: auth.accessControl,
    explicitBrainInterpreter: createInterpreter,
    taskIdentity,
    now,
  });
  return { runtime, cookie: auth.cookie };
}

async function submitNewTask(
  runtime: Awaited<ReturnType<typeof startUiRuntime>>,
  cookie: string,
  suffix: string,
) {
  const receive = await httpJson(runtime, 'POST', '/api/explicit/inputs', {
    sourceRef: `ui:${suffix}`,
    rawInput: `create the ${suffix} task`,
    channel: 'business',
    requestKind: 'new-task-create' as const,
  }, cookie);
  assert.equal(receive.status, 201);
  const interactionId = (receive.payload as { readonly interactionId: string }).interactionId;
  const interpret = await httpJson(
    runtime,
    'POST',
    `/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`,
    {},
    cookie,
  );
  assert.equal(interpret.status, 200);
  const inspected = (await httpJson(
    runtime,
    'GET',
    `/api/explicit/interactions/${encodeURIComponent(interactionId)}`,
    undefined,
    cookie,
  )).payload as {
    readonly draft?: { readonly draftId: string };
    readonly revision?: { readonly revisionVersion: number; readonly revisionHash: string };
  };
  assert.ok(inspected.draft);
  assert.ok(inspected.revision);
  const confirmation = await httpJson(runtime, 'POST', `/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`, {
    interactionId,
    draftId: inspected.draft!.draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-25T00:00:00.000Z',
    payloadRef: `asset://requirements/${suffix}`,
    requestKind: 'new-task-create',
    draftRevisionVersion: inspected.revision!.revisionVersion,
    draftRevisionHash: inspected.revision!.revisionHash,
  }, cookie);
  assert.equal(confirmation.status, 200);
}

async function waitForAsync(assertion: () => Promise<void>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (last instanceof Error) throw last;
  throw new Error('waitForAsync timed out');
}

test('real HTTP task execution leaves running when deltas never complete and the budget stop lands', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'case-delta-never-completes-'));
  const port = new NeverCompletingDeltaPort(binding);
  const started = await startRuntimeForBudget(root, port);
  const { runtime, cookie } = started;
  try {
    await submitNewTask(runtime, cookie, 'b4-delta-no-done');

    const journal = new UiRuntimeJournal(join(root, 'checkpoints', 'fake', 'ui-runtime-journal.jsonl'));
    let taskId: string | undefined;
    await waitForAsync(async () => {
      const created = journal.replay().find((record) => record.kind === 'task.created');
      assert.ok(created?.kind === 'task.created', 'the durable journal must own the created task');
      if (created?.kind === 'task.created') taskId = created.taskId.value;
      assert.ok(taskId !== undefined);
    });

    await waitForAsync(async () => {
      const response = await httpJson(runtime, 'GET', '/api/tasks', undefined, cookie);
      assert.equal(response.status, 200);
      const list = response.payload as RuntimeTaskListProjection;
      const inAny = [...list.running, ...list.waiting, ...list.completed, ...list.stopped, ...list.draft, ...list.failed];
      const row = inAny.find((candidate) => candidate.taskId.value === taskId);
      assert.ok(row, 'the task must be visible over real HTTP');
    });

    let dashboard: any;
    await waitForAsync(async () => {
      const response = await httpJson(runtime, 'GET', `/api/tasks/${taskId}/dashboard`, undefined, cookie);
      assert.equal(response.status, 200);
      dashboard = response.payload;
      assert.equal(dashboard.state, 'stopped');
    });

    assert.equal(dashboard.state, 'stopped');
    assert.equal(dashboard.error?.code, 'execution.request-budget.exceeded');
    assert.match(dashboard.error?.message ?? '', /no completed content unit within/);
    assert.equal(dashboard.checkpoint?.outcome, 'stopped');
    assert.equal(dashboard.checkpoint?.summary, 'request-budget-exceeded');

    const records = journal.replay();
    const eventSummaries = records
      .filter((record) => record.kind === 'operation.event')
      .map((record) => (record as { readonly event: { readonly summary: string } }).event.summary);
    assert.ok(eventSummaries.some((summary) => summary.includes('request budget exceeded')));
    const terminal = records.filter((record) => record.kind === 'operation.event')
      .map((record) => record as { readonly event: { readonly state: string; readonly summary: string } })
      .find((entry) => entry.event.state === 'stopped');
    assert.ok(terminal, 'journal must own a stopped terminal fact');
    const stoppedCheckpoint = records.find((record) => {
      if (record.kind !== 'operation.event') return false;
      const candidate = record as { readonly event: { readonly state: string; readonly kind: string; readonly checkpoint?: unknown } };
      return candidate.event.kind === 'checkpoint.committed' && candidate.event.state === 'stopped';
    });
    assert.ok(stoppedCheckpoint);
    const stoppedEvent = stoppedCheckpoint as { readonly event: { readonly summary: string } };
    assert.equal(stoppedEvent.event.summary, 'stopped checkpoint committed');

    const receiptPath = join(root, 'b4-blackbox-receipt.json');
    await writeFile(receiptPath, JSON.stringify({
      root,
      taskId,
      state: dashboard.state,
      errorCode: dashboard.error?.code,
      checkpointSummary: dashboard.checkpoint?.summary,
      eventCount: records.filter((record) => record.kind === 'operation.event').length,
      hadBudgetStopEvent: eventSummaries.some((summary) => summary.includes('request budget exceeded')),
      hadStoppedTerminal: terminal !== undefined,
      hadStoppedCheckpoint: stoppedCheckpoint !== undefined,
    }, null, 2));
    console.error(`[b4-blackbox] receipt written to ${receiptPath}`);
  } finally {
    await runtime.close();
  }
});
