import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  id,
  TASK_FLOW_DEFINITION_VERSION,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ExecutionPolicyDefinition,
  type JournalCommitRef,
  type ProviderExecutionIdentityRef,
  type ProviderBinding,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ScopeRef,
  type Task,
  type TaskId,
  type TaskFlowBinding,
  type TaskIdentityAppendInput,
  type TaskIdentityRecord,
  type TaskPlanSnapshot,
  type TaskRuntimeIncarnation,
  type TurnClosureReference,
} from '../../packages/contracts/src/index.js';
import {
  JsonlOrganJournal,
  JsonlTaskPlanRevisionJournal,
} from '../../packages/adapters/jsonl/src/index.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { MemoryCoordinator, RuntimeTaskCoordinator } from '../../packages/runtime/src/index.js';
import { TaskPlanRevisionConsumer } from '../../packages/runtime/src/orchestration/task-plan-revisions.js';
import { TaskIdentityConsumer, type TaskIdentityPort } from '../../packages/runtime/src/orchestration/task-identity.js';
import { SubscriptionControlPort } from '../../packages/runtime/src/subscriptions/index.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import {
  FakeReplayExecutionRuntimePort,
  startUiRuntime,
  UiRuntimeJournal,
  type UiRuntimeLaunchOptions,
} from '../../packages/app/src/ui-runtime/index.js';
import { assembleProviderExecutionPort } from '../../packages/app/src/provider-assembly.js';
import {
  prepareAgentProvider as assembleAgentProvider,
  createAgentProviderPort,
  prepareExecutionAgentProvider,
  type AgentProviderComposition,
} from '../../packages/app/src/agent-driver-composition.js';
import { createIndependentTurnPlanner } from '../../packages/app/src/ui-runtime/turn-planner.js';
import { deriveClosedTurnPlannerDuty } from '../../packages/runtime/src/orchestration/closed-turn-planner-call.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import {
  uiRuntimeCheckpointRoot,
  uiRuntimeControlJournalPath,
  uiRuntimeModeRoot,
} from '../../packages/app/src/ui-runtime/journal.js';
import { TASK_EXECUTION_ACTION_ID, TASK_EXECUTION_CAPABILITY } from '../../packages/app/src/ui-runtime/task-control.js';
import type { ExplicitBrainInputInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import type {
  RuntimeTaskDashboardProjection,
  RuntimeTaskListProjection,
} from '../../packages/ui/contracts/runtime.js';
import {
  ensureControlLayout,
  resolveRuntimePaths,
  type EffectiveAgentProviderBinding,
  type ProviderConfig,
} from '../../packages/config/src/index.js';

// A real public new-task submission must bind the confirmed typed requirement
// source to the Task it creates before execution starts. The current product
// wiring had no such edge, so a genuine Task reached the native closed-turn
// Planner without identity. This one local consumer exercises the actual
// HTTP/intake/confirmation owners and the existing Organ Journal identity owner
// instead of a scenario matrix.

const ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-production-task-identity-r1-20261014');

const organId = id('organ', 'organ-task-identity-consumer');
const gaHttpBinding: ProviderBinding = {
  bindingId: 'binding-ga-http-source',
  // The local label is unrelated to the source strategy, exactly as in the
  // existing source consumer. Only the typed source selects the transport.
  providerId: 'rcc',
  protocol: 'responses',
  endpointRef: 'http:127.0.0.1:4599',
  modelRef: 'ga.http.model',
  configDigest: 'sha256:ga-http-config',
  capabilityDigest: 'sha256:ga-http-capability',
};

const binding: ProviderBinding = {
  bindingId: 'binding-task-identity',
  providerId: 'provider-task-identity',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-task-identity',
  configDigest: 'sha256:task-identity-config',
  capabilityDigest: 'sha256:task-identity-capability',
};

const rawFetch = globalThis.fetch.bind(globalThis);
const sessionByOrigin = new Map<string, string>();

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const origin = new URL(url).origin;
  const cookie = sessionByOrigin.get(origin);
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('cookie', cookie);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') headers.set('origin', origin);
  return rawFetch(input, { ...init, headers });
}) as typeof fetch;

/**
 * One authenticated request that deliberately carries NO Origin header.
 *
 * The Origin guard was deleted, so this must now succeed. The module-level fetch
 * wrapper above always adds an Origin for mutations, so the no-Origin proof has
 * to use the raw fetch with the cookie set explicitly.
 */
async function rawNoOrigin(
  url: string,
  method: 'GET' | 'PUT' | 'DELETE',
  cookie: string,
  body?: unknown,
): Promise<Response> {
  return rawFetch(url, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface CapturedUpstreamRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

function sseResponse(frames: readonly unknown[]): Response {
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Intercepts only the configured non-RCC upstream origin. The real HTTP
 * transport still builds the request URL, headers and body; only the OS socket
 * is replaced. Every other origin (the local UI API) delegates to the existing
 * wrapper, so the public submission path stays real.
 */
function captureUpstream(origin: string) {
  const requests: CapturedUpstreamRequest[] = [];
  const original = globalThis.fetch;
  const capture = (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).origin !== origin) return original(input, init);
    requests.push({
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      body: typeof init.body === 'string' ? init.body : '',
    });
    return sseResponse([
      { type: 'response.created', response: { id: 'response-ga-http' } },
      { type: 'response.output_text.done', item_id: 'message-final', text: 'GA_HTTP_SOURCE_OK' },
      { type: 'response.completed', response: { id: 'response-ga-http' } },
    ]);
  }) as typeof fetch;
  globalThis.fetch = capture;
  return { requests, restore: () => { globalThis.fetch = original; } };
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

function memoryFor(projectKey: string) {
  return {
    coordinator: new MemoryCoordinator(),
    backend: new DeterministicMemoryBackend(),
    projectKey,
    roleId: 'execution',
  };
}

const createInterpreter: ExplicitBrainInputInterpreter = {
  async interpret(input) {
    const existing = input.rawInput.startsWith('change ')
      ? input.taskCandidates.find((task) => task.title === 'existing task-flow target')
      : undefined;
    return {
      kind: 'requirement',
      normalizedInput: input.rawInput,
      ...(existing === undefined ? {} : { matchedTaskId: existing.taskId }),
      knownFacts: [],
      intent: existing === undefined ? 'create' : 'change',
      proposal: `${existing === undefined ? 'create a task for' : 'change'} ${input.rawInput}`,
      structuredProposal: {
        revision: input.inputRevision,
        intent: existing === undefined ? 'create' : 'change',
        title: input.rawInput,
        objective: input.rawInput,
        deliverable: `${existing === undefined ? 'create a task for' : 'change'} ${input.rawInput}`,
        deliveryConditions: [],
        evidenceRefs: [],
        blockingGaps: [],
      },
      decisionRefs: [],
    };
  },
};

// The execution port is the first real boundary that observes a started
// execution. Reading the actual identity Journal here proves the identity is
// committed before any execution start, not merely present later.
class IdentityBeforeStartPort extends FakeReplayExecutionRuntimePort {
  readonly identitiesAtStart: Array<TaskIdentityRecord | undefined> = [];

  constructor(
    private readonly taskControlPath: string,
    options: ConstructorParameters<typeof FakeReplayExecutionRuntimePort>[0],
  ) {
    super(options);
  }

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    const identities = await new JsonlTaskIdentityJournal(new JsonlOrganJournal(this.taskControlPath)).replay();
    this.identitiesAtStart.push(identities.find((identity) => identity.scope.taskId.value === input.taskId.value));
    return super.start(input);
  }
}

class FailOnceIdentityJournal extends JsonlTaskIdentityJournal {
  failNextAppend = false;

  override async append(input: TaskIdentityAppendInput): Promise<TaskIdentityRecord> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('task identity journal unavailable');
    }
    return super.append(input);
  }
}

class TaskFlowPreparingIdentityJournal implements TaskIdentityPort {
  constructor(
    private readonly inner: TaskIdentityPort,
    private readonly taskFlow: TaskFlowBinding,
  ) {}

  append(input: TaskIdentityAppendInput): Promise<TaskIdentityRecord> {
    return this.inner.append({ ...input, taskFlow: this.taskFlow });
  }

  replay(scope?: ScopeRef): Promise<readonly TaskIdentityRecord[]> {
    return this.inner.replay(scope);
  }
}

/** Counts real execution starts so a pure resource mount can prove none happened. */
class CountingStartPort extends FakeReplayExecutionRuntimePort {
  startCount = 0;
  readonly starts: ProviderStartInput[] = [];

  override async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.startCount += 1;
    this.starts.push(structuredClone(input));
    return super.start(input);
  }
}

// The real admission owner rejects any execution without a current TaskGrant.
// The fixture therefore commits the real identity first and only then grants
// exactly the returned Task scope to the actual product principal owner. It
// reuses the same physical control Organ Journal and never grants in production;
// a failed identity append (case B) throws before any grant is written.
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
        requestId: `task-identity-fixture-grant:${record.scope.taskId.value}`,
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

function identityWithFixtureGrant(
  principalOwner: string,
  taskControlPath: string,
  inner: TaskIdentityPort = new JsonlTaskIdentityJournal(new JsonlOrganJournal(taskControlPath)),
  taskFlow?: TaskFlowBinding,
): TaskIdentityConsumer {
  const identityJournal = taskFlow === undefined
    ? inner
    : new TaskFlowPreparingIdentityJournal(inner, taskFlow);
  return new TaskIdentityConsumer(new GrantPreparingIdentityJournal(
    identityJournal,
    new JsonlTaskGrantJournal(new JsonlOrganJournal(taskControlPath)),
    principalOwner,
  ));
}

function taskControlPathFor(root: string, mode: 'fake' | 'rcc' = 'fake'): string {
  return join(root, 'checkpoints', mode, 'task-control.jsonl');
}

async function startRuntime(root: string, port: ExecutionRuntimePort, extra: {
  readonly projectKey: string;
  readonly mode?: 'fake' | 'rcc';
  readonly providerSource?: 'rcc' | 'http';
  readonly binding?: ProviderBinding;
  readonly explicitBrainInterpreter?: ExplicitBrainInputInterpreter;
  readonly runtimeComposition?: UiRuntimeLaunchOptions['runtimeComposition'];
  readonly taskIdentity?: (principalOwner: string, taskControlPath: string) => TaskIdentityConsumer;
}) {
  const mode = extra.mode ?? 'fake';
  const auth = await accessControlFor(root);
  const principalOwner = auth.accessControl.readProductPrincipalOwner();
  const taskControlPath = taskControlPathFor(root, mode);
  const taskIdentity = extra.taskIdentity?.(principalOwner, taskControlPath);
  const runtime = await startUiRuntime({
    mode,
    productRoot: root,
    organId,
    binding: extra.binding ?? binding,
    port,
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages', 'ui', 'static'),
    projectKey: extra.projectKey,
    workspaceRoot: root,
    memory: memoryFor(extra.projectKey),
    accessControl: auth.accessControl,
    explicitBrainInterpreter: extra.explicitBrainInterpreter ?? createInterpreter,
    ...(extra.providerSource === undefined ? {} : { providerSource: extra.providerSource }),
    ...(extra.runtimeComposition === undefined ? {} : { runtimeComposition: extra.runtimeComposition }),
    ...(taskIdentity === undefined ? {} : { taskIdentity }),
  });
  sessionByOrigin.set(new URL(runtime.server.url).origin, auth.cookie);
  return runtime;
}

async function submitNewTask(runtime: Awaited<ReturnType<typeof startUiRuntime>>, suffix: string) {
  const post = async (path: string, body: unknown): Promise<Response> => fetch(`${runtime.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const receive = await post('/api/explicit/inputs', {
    sourceRef: `ui:${suffix}`,
    rawInput: `create the ${suffix} task`,
    channel: 'business',
    requestKind: 'new-task-create' as const,
  });
  assert.equal(receive.status, 201);
  const { interactionId } = await receive.json() as { readonly interactionId: string };
  const interpret = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {});
  assert.equal(interpret.status, 200);
  const inspected = await (await fetch(
    `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}`,
  )).json() as {
    readonly draft?: { readonly draftId: string };
    readonly revision?: { readonly revisionVersion: number; readonly revisionHash: string };
  };
  assert.ok(inspected.draft);
  assert.ok(inspected.revision);
  const confirmation = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`, {
    interactionId,
    draftId: inspected.draft!.draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-14T00:00:00.000Z',
    payloadRef: `asset://requirements/${suffix}`,
    requestKind: 'new-task-create',
    draftRevisionVersion: inspected.revision!.revisionVersion,
    draftRevisionHash: inspected.revision!.revisionHash,
  });
  assert.equal(confirmation.status, 200);
  const receipt = await confirmation.json() as { readonly requirement: { readonly requirementId: string; readonly draftId: string } };
  const confirmationParams = {
    interactionId,
    draftId: inspected.draft!.draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: '2026-10-14T00:00:00.000Z',
    payloadRef: `asset://requirements/${suffix}`,
    requestKind: 'new-task-create' as const,
    draftRevisionVersion: inspected.revision!.revisionVersion,
    draftRevisionHash: inspected.revision!.revisionHash,
  };
  return {
    interactionId,
    draftId: inspected.draft!.draftId,
    revisionVersion: inspected.revision!.revisionVersion,
    revisionHash: inspected.revision!.revisionHash,
    receipt,
    confirmationParams,
  };
}

async function prepareNewTaskConfirmation(
  runtime: Awaited<ReturnType<typeof startUiRuntime>>,
  suffix: string,
  taskFlow?: TaskFlowBinding,
) {
  const post = async (path: string, body?: unknown): Promise<Response> => fetch(`${runtime.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const receive = await post('/api/explicit/inputs', {
    sourceRef: `ui:${suffix}`,
    rawInput: `create the ${suffix} task`,
    channel: 'business',
    requestKind: 'new-task-create' as const,
  });
  assert.equal(receive.status, 201);
  const { interactionId } = await receive.json() as { readonly interactionId: string };
  const interpret = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {});
  assert.equal(interpret.status, 200);
  const inspected = await (await fetch(
    `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}`,
  )).json() as {
    readonly draft?: { readonly draftId: string; readonly inputRevision: number };
    readonly revision?: { readonly revisionVersion: number; readonly revisionHash: string };
  };
  assert.ok(inspected.draft);
  assert.ok(inspected.revision);
  return {
    interactionId,
    draftId: inspected.draft!.draftId,
    inputRevision: inspected.draft!.inputRevision,
    revisionVersion: inspected.revision!.revisionVersion,
    revisionHash: inspected.revision!.revisionHash,
    confirmationParams: {
      interactionId,
      draftId: inspected.draft!.draftId,
      inputRevision: inspected.draft!.inputRevision,
      confirmationRef: `confirmation:${suffix}`,
      confirmedBy: 'human:operator',
      confirmedAt: '2026-10-14T00:00:00.000Z',
      payloadRef: `asset://requirements/${suffix}`,
      requestKind: 'new-task-create' as const,
      draftRevisionVersion: inspected.revision!.revisionVersion,
      draftRevisionHash: inspected.revision!.revisionHash,
      ...(taskFlow === undefined ? {} : { taskFlow }),
    },
  };
}

async function replayConfirmation(
  runtime: Awaited<ReturnType<typeof startUiRuntime>>,
  confirmationParams: {
    readonly interactionId: string;
    readonly draftId: string;
    readonly inputRevision: number;
    readonly confirmationRef: string;
    readonly confirmedBy: string;
    readonly confirmedAt: string;
    readonly payloadRef: string;
    readonly requestKind: 'new-task-create';
    readonly draftRevisionVersion: number;
    readonly draftRevisionHash: string;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const replay = await fetch(
    `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(confirmationParams.interactionId)}/confirmation`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(confirmationParams),
    },
  );
  return { status: replay.status, body: await replay.json() };
}

async function waitFor(assertion: () => void, timeoutMs = 4000): Promise<void> {
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
  throw new Error('waitFor timed out');
}

async function waitForAsync(assertion: () => Promise<void>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (last instanceof Error) throw last;
  throw new Error('waitForAsync timed out');
}

async function identityRecords(taskControlPath: string): Promise<readonly TaskIdentityRecord[]> {
  return new JsonlTaskIdentityJournal(new JsonlOrganJournal(taskControlPath)).replay();
}

async function createdTaskIds(runtime: Awaited<ReturnType<typeof startUiRuntime>>): Promise<readonly string[]> {
  const tasks = runtime.service.listTasks();
  return [
    ...tasks.running,
    ...tasks.waiting,
    ...tasks.completed,
    ...tasks.stopped,
    ...tasks.draft,
    ...tasks.failed,
  ].map((row) => row.taskId.value);
}

async function pendingRequirementCount(taskControlPath: string): Promise<number> {
  const records = new UiRuntimeJournal(join(dirname(taskControlPath), 'ui-runtime-journal.jsonl')).replay();
  const state = records
    .filter((record): record is Extract<(typeof records)[number], { readonly kind: 'explicit-brain.state' }> => (
      record.kind === 'explicit-brain.state'
    ))
    .at(-1)?.state;
  return state?.inbox.pendingDraftIds.length ?? 0;
}

function taskPlanEvidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `app-read-mount-${label}`),
    kind: 'execution',
    source: 'humanagent.tests.app-read-mounts',
    locator: `test://app-read-mounts/${label}`,
    scope,
  };
}

function taskPlanSnapshot(label: string): TaskPlanSnapshot {
  return {
    title: `Reasoning plan ${label}`,
    summary: `Published reasoning plan ${label}.`,
    completeness: { scope: 'whole-task', status: 'complete' },
    acceptanceCriteria: [{
      criterionId: `${label}-criterion`,
      description: `Verify the ${label} reasoning plan.`,
    }],
    nodes: [
      {
        nodeId: `${label}-work`,
        kind: 'work',
        title: `Do ${label}`,
        intent: `Complete the ${label} work.`,
        definition: { owner: 'runtime' },
        phaseId: `${label}-phase`,
      },
      {
        nodeId: `${label}-check`,
        kind: 'check',
        title: `Check ${label}`,
        intent: `Verify the ${label} result.`,
        definition: { owner: 'runtime' },
        phaseId: `${label}-phase`,
      },
    ],
    phases: [{
      phaseId: `${label}-phase`,
      title: `Phase ${label}`,
      memberNodeIds: [`${label}-work`, `${label}-check`],
    }],
    relations: [{
      fromNodeId: `${label}-work`,
      toNodeId: `${label}-check`,
      kind: 'depends-on',
    }],
  };
}

function taskPlanSource(
  revision: number,
  label: string,
  scope: ScopeRef,
): {
  readonly requirementId: string;
  readonly inputRevision: number;
  readonly draftId: string;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
  readonly confirmationRef: string;
  readonly evidenceRefs: readonly EvidenceRef[];
} {
  return {
    requirementId: `requirement-${label}`,
    inputRevision: revision,
    draftId: `draft-${label}`,
    draftRevisionVersion: revision,
    draftRevisionHash: `draft-hash-${label}`,
    confirmationRef: `confirmation-${label}`,
    evidenceRefs: [taskPlanEvidence(`source-${label}`, scope)],
  };
}

function dashboardSchedulePolicy(): ExecutionPolicyDefinition {
  return {
    policyId: 'policy-app-read-mount-dashboard',
    policyRevision: 1,
    timezone: 'UTC',
    canonicalInstant: '2026-10-15T00:00:00.000Z',
    dstMode: 'wall',
    dstMissedPolicy: 'shift-forward',
    dstAmbiguousPolicy: 'earlier-offset',
    latePolicy: 'run-once',
    busyPolicy: 'skip',
    executionMode: 'recurring',
    startAt: '2026-10-15T00:00:00.000Z',
    frequency: 'interval',
    intervalMinutes: 60,
  };
}

const onceExecutionPolicy: ExecutionPolicyDefinition = {
  policyId: 'policy-once',
  policyRevision: 1,
  executionMode: 'once',
  timezone: 'America/Los_Angeles',
  canonicalInstant: '2026-11-01T17:00:00Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'skip',
  busyPolicy: 'skip',
  dueAt: '2026-11-01T17:00:00Z',
};

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { readonly code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function currentTaskPlanReceipt(
  consumer: TaskPlanRevisionConsumer,
  scope: ScopeRef,
  revisionId: string,
): Promise<JournalCommitRef> {
  const receipt = await consumer.getCommitRef(scope, revisionId);
  if (receipt === null) throw new Error(`fixture lost the physical receipt for ${revisionId}`);
  return receipt;
}

test('public new-task submit binds the real typed source and cold-reads before and after execution', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'case-a-'));
  const committedTaskFlow: TaskFlowBinding = {
    kind: 'long-running',
    definitionVersion: TASK_FLOW_DEFINITION_VERSION,
  };
  const taskControlPath = taskControlPathFor(root);
  const port = new IdentityBeforeStartPort(taskControlPath, { binding, stepDelayMs: 1 });
  const runtime = await startRuntime(root, port, {
    projectKey: 'project-task-identity-a',
    taskIdentity: (owner, path) => identityWithFixtureGrant(owner, path, undefined, committedTaskFlow),
  });
  let submission: Awaited<ReturnType<typeof submitNewTask>> | undefined;
  try {
    submission = await submitNewTask(runtime, 'public-identity-a');

    // The public GET projects the exact committed Task identity source for the
    // row of the same task scope. This is the released read-only linkage; it
    // proves projection only, not that the native execution chain ran.
    await waitForAsync(async () => {
      const records = await identityRecords(taskControlPath);
      assert.equal(records.length, 1);
    });
    const committedIdentity = (await identityRecords(taskControlPath))[0]!;
    const listResponse = await fetch(`${runtime.server.url}/api/tasks`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as RuntimeTaskListProjection;
    const allRows = [
      ...list.running, ...list.waiting, ...list.completed,
      ...list.stopped, ...list.draft, ...list.failed,
    ];
    const projectedRow = allRows.find((row) => row.taskId.value === committedIdentity.scope.taskId.value);
    assert.ok(projectedRow, 'the public task row for the committed identity must be present');
    assert.deepEqual(projectedRow!.identitySource, committedIdentity.source);
    assert.deepEqual(projectedRow!.taskFlow, committedTaskFlow);
    assert.deepEqual(
      Object.keys(committedIdentity.source).sort(),
      ['confirmationRef', 'draftId', 'draftRevisionHash', 'draftRevisionVersion', 'inputRevision', 'requirementId'].sort(),
    );

    await waitFor(() => assert.equal(port.identitiesAtStart.length, 1));

    const identities = await identityRecords(taskControlPath);
    assert.equal(identities.length, 1);
    const identity = identities[0]!;
    const beforeExecution = port.identitiesAtStart[0];
    assert.ok(beforeExecution, 'identity must be readable at the first execution start');
    assert.equal(beforeExecution!.scope.organId.value, organId.value);
    assert.equal(identity.scope.taskId.value, port.identitiesAtStart[0]!.scope.taskId.value);
    assert.equal(identity.source.requirementId, submission.receipt.requirement.requirementId);
    assert.equal(identity.source.draftId, submission.draftId);
    assert.equal(identity.source.inputRevision, 1);
    assert.equal(identity.source.draftRevisionVersion, submission.revisionVersion);
    assert.equal(identity.source.draftRevisionHash, submission.revisionHash);
    assert.equal(identity.source.confirmationRef, 'confirmation:public-identity-a');
    assert.match(identity.journalCommitRef, /^jsonl:/);

    // One real Task, one identity, one execution.
    assert.equal(runtime.service.listTasks().counts.total, 1);
    assert.equal(port.identitiesAtStart.length, 1);
  } finally {
    await runtime.close();
  }

  // A fresh reader over the same physical Journal resolves the same identity.
  const cold = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(new JsonlOrganJournal(taskControlPath)));
  const coldIdentity = await cold.read({ organId, taskId: id('task', (await identityRecords(taskControlPath))[0]!.scope.taskId.value) });
  assert.ok(coldIdentity);
  assert.deepEqual(coldIdentity!.taskFlow, committedTaskFlow);

  const replayPort = new IdentityBeforeStartPort(taskControlPath, { binding, stepDelayMs: 1 });
  const replayed = await startRuntime(root, replayPort, {
    projectKey: 'project-task-identity-a',
    taskIdentity: (owner, path) => identityWithFixtureGrant(owner, path, undefined, committedTaskFlow),
  });
  try {
    // Replaying the same final submission must not create a second Task,
    // identity, or FIFO consumption.
    const duplicate = await replayConfirmation(replayed, submission!.confirmationParams);
    assert.equal(duplicate.status, 200);
    assert.equal((duplicate.body as { readonly requirement: { readonly status: string } }).requirement.status, 'duplicate');
    assert.equal((await identityRecords(taskControlPath)).length, 1);
    assert.equal(replayPort.identitiesAtStart.length, 0, 'a duplicate submit must not start a second execution');
    assert.equal(replayed.service.listTasks().counts.total, 1, 'a duplicate submit must not create a second Task');

    // A real task without a committed identity remains unbound: the public row
    // must omit taskFlow instead of defaulting a legacy row to one-shot.
    const legacy = replayed.service.createTask({ title: 'legacy task', directive: 'legacy task' });
    const legacyResponse = await fetch(`${replayed.server.url}/api/tasks`);
    assert.equal(legacyResponse.status, 200);
    const legacyList = await legacyResponse.json() as RuntimeTaskListProjection;
    const legacyRow = [
      ...legacyList.running, ...legacyList.waiting, ...legacyList.completed,
      ...legacyList.stopped, ...legacyList.draft, ...legacyList.failed,
    ].find((row) => row.taskId.value === legacy.taskId.value);
    assert.ok(legacyRow, 'the identityless task must still appear in the public task list');
    assert.equal(Object.prototype.hasOwnProperty.call(legacyRow, 'taskFlow'), false);
  } finally {
    await replayed.close();
  }

  await rm(root, { recursive: true, force: true });
});

test('taskFlow intake fidelity preserves inferred and refined bindings without a confirmation override', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'case-task-flow-intake-'));
  const taskControlPath = taskControlPathFor(root);
  const port = new CountingStartPort({ binding, stepDelayMs: 1 });
  const directTaskFlow: TaskFlowBinding = { kind: 'inspection', definitionVersion: TASK_FLOW_DEFINITION_VERSION };
  const runtime = await startRuntime(root, port, {
    projectKey: 'project-task-flow-intake',
    taskIdentity: (owner, path) => identityWithFixtureGrant(owner, path),
    explicitBrainInterpreter: {
      async interpret(input) {
        const interpreted = await createInterpreter.interpret(input);
        return interpreted.kind === 'requirement' && interpreted.intent === 'create'
          ? { ...interpreted, taskFlow: directTaskFlow } : interpreted;
      },
    },
  });
  try {
    const direct = await prepareNewTaskConfirmation(runtime, 'task-flow-direct');
    const directResponse = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(direct.interactionId)}/confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...direct.confirmationParams, taskFlow: { kind: 'long-running', definitionVersion: 1 } }),
      },
    );
    assert.equal(directResponse.status, 200);
    await waitForAsync(async () => assert.equal((await identityRecords(taskControlPath)).length, 1));
    const directIdentity = (await identityRecords(taskControlPath))[0]!;
    assert.deepEqual(directIdentity.taskFlow, directTaskFlow);

    const refined = await prepareNewTaskConfirmation(runtime, 'task-flow-refined');
    const refinedTaskFlow: TaskFlowBinding = {
      kind: 'one-shot',
      definitionVersion: TASK_FLOW_DEFINITION_VERSION,
    };
    const refinement = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(refined.interactionId)}/refine`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draftId: refined.draftId,
          baseRevisionVersion: refined.revisionVersion,
          requestedRevisionHash: refined.revisionHash,
          fields: { taskFlow: refinedTaskFlow },
          instructionRef: 'task-flow-intake-fidelity-refine',
        }),
      },
    );
    assert.equal(refinement.status, 200);
    const refinedSnapshot = await refinement.json() as {
      readonly revision: { readonly revisionVersion: number; readonly revisionHash: string };
    };
    const omittedResponse = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(refined.interactionId)}/confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...refined.confirmationParams,
          draftRevisionVersion: refinedSnapshot.revision.revisionVersion,
          draftRevisionHash: refinedSnapshot.revision.revisionHash,
        }),
      },
    );
    assert.equal(omittedResponse.status, 200);
    await waitForAsync(async () => assert.equal((await identityRecords(taskControlPath)).length, 2));
    const refinedIdentity = (await identityRecords(taskControlPath))[1]!;
    assert.deepEqual(refinedIdentity.taskFlow, refinedTaskFlow);

    const conflict = await prepareNewTaskConfirmation(runtime, 'task-flow-conflict');
    const conflictRefinement = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(conflict.interactionId)}/refine`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draftId: conflict.draftId,
          baseRevisionVersion: conflict.revisionVersion,
          requestedRevisionHash: conflict.revisionHash,
          fields: { taskFlow: refinedTaskFlow },
          instructionRef: 'task-flow-intake-fidelity-conflict',
        }),
      },
    );
    assert.equal(conflictRefinement.status, 200);
    const conflictSnapshot = await conflictRefinement.json() as {
      readonly revision: { readonly revisionVersion: number; readonly revisionHash: string };
    };
    const identitiesBeforeConflict = (await identityRecords(taskControlPath)).length;
    const conflictResponse = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(conflict.interactionId)}/confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...conflict.confirmationParams,
          draftRevisionVersion: conflictSnapshot.revision.revisionVersion,
          draftRevisionHash: conflictSnapshot.revision.revisionHash,
          taskFlow: directTaskFlow,
        }),
      },
    );
    assert.equal(conflictResponse.status, 200);
    await waitForAsync(async () => assert.equal((await identityRecords(taskControlPath)).length, identitiesBeforeConflict + 1));
    assert.deepEqual((await identityRecords(taskControlPath)).at(-1)?.taskFlow, refinedTaskFlow);

    const target = runtime.service.createTask({ title: 'existing task-flow target' });
    const targetGrant = await fetch(`${runtime.server.url}/api/tasks/${encodeURIComponent(target.taskId.value)}/control/grant`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'task-flow-existing-fixture-grant', expectedRevision: 0 }),
    });
    assert.equal(targetGrant.status, 200);
    const existingReceive = await fetch(`${runtime.server.url}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceRef: 'ui:task-flow-existing-target',
        rawInput: 'change the existing task-flow target',
        channel: 'business',
        requestKind: 'existing-task-change',
      }),
    });
    assert.equal(existingReceive.status, 201);
    const existingInteractionId = ((await existingReceive.json()) as { readonly interactionId: string }).interactionId;
    assert.equal((await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(existingInteractionId)}/interpret`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )).status, 200);
    const existingSnapshot = await (await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(existingInteractionId)}`,
    )).json() as {
      readonly draft: { readonly draftId: string; readonly inputRevision: number };
      readonly revision: { readonly revisionVersion: number; readonly revisionHash: string };
    };
    const tasksBeforeRejectedInjection = runtime.service.listTasks().counts.total;
    const identitiesBeforeRejectedInjection = (await identityRecords(taskControlPath)).length;
    const pendingBeforeRejectedInjection = await pendingRequirementCount(taskControlPath);
    const rejectedInjection = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(existingInteractionId)}/confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          draftId: existingSnapshot.draft.draftId,
          inputRevision: existingSnapshot.draft.inputRevision,
          confirmationRef: 'confirmation:task-flow-existing-rejected',
          confirmedBy: 'human:operator',
          confirmedAt: '2026-10-14T00:00:00.000Z',
          payloadRef: 'asset://requirements/task-flow-existing-rejected',
          requestKind: 'existing-task-change',
          taskRef: target.taskId,
          draftRevisionVersion: existingSnapshot.revision.revisionVersion,
          draftRevisionHash: existingSnapshot.revision.revisionHash,
          taskFlow: directTaskFlow,
        }),
      },
    );
    assert.equal(rejectedInjection.status, 200);
    await waitForAsync(async () => assert.equal(runtime.service.listTasks().counts.total, tasksBeforeRejectedInjection));
    assert.equal((await identityRecords(taskControlPath)).length, identitiesBeforeRejectedInjection);
    await waitForAsync(async () => assert.equal(await pendingRequirementCount(taskControlPath), pendingBeforeRejectedInjection));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * StageA failure basis for the M4 typed confirmation path.
 *
 * Failure mode: the HTTP confirmation accepts the four explicit fields and
 * taskFlow, but the confirmed revision's normalizedInput and the Task directive
 * can still collapse to the original one-line goal. Impact: the first executor
 * loses user scope and safety constraints before the closed-turn Planner sees
 * the directive. Probability: unknown; the loss occurred in the M4 run.
 * Cost: one continuous case in the existing HTTP consumer, with temp Journal,
 * real grant preparation, fake local Provider transport and finally cleanup.
 */
test('taskFlow intake fidelity preserves confirmed template through task directive', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'case-task-flow-confirmation-fidelity-'));
  const taskControlPath = taskControlPathFor(root);
  const port = new CountingStartPort({ binding, stepDelayMs: 1 });
  const taskFlow: TaskFlowBinding = { kind: 'one-shot', definitionVersion: TASK_FLOW_DEFINITION_VERSION };
  const runtime = await startRuntime(root, port, {
    projectKey: 'project-task-flow-confirmation-fidelity',
    taskIdentity: (owner, path) => identityWithFixtureGrant(owner, path),
    explicitBrainInterpreter: {
      async interpret(input) {
        const interpreted = await createInterpreter.interpret(input);
        return interpreted.kind === 'requirement' ? { ...interpreted, taskFlow } : interpreted;
      },
    },
  });
  try {
    const semanticTitle = 'create the task-flow-confirmation-fidelity task';
    const goal = 'Write one short paragraph containing M4-SCOPE-MARKER-PROJECT-B explaining project scope isolation.';
    const scope = 'workspace-b';
    const constraints = ['No child agents, no file edits'];
    const deliverables = ['Paragraph containing M4-SCOPE-MARKER-PROJECT-B'];
    const expectedTemplate = { goal, scope, constraints, deliverables };
    const prepared = await prepareNewTaskConfirmation(runtime, 'task-flow-confirmation-fidelity');

    const confirmed = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(prepared.interactionId)}/confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...prepared.confirmationParams,
          draftRevisionVersion: prepared.revisionVersion,
          draftRevisionHash: prepared.revisionHash,
          goal,
          scope,
          constraints,
          deliverables,
        }),
      },
    );
    assert.equal(confirmed.status, 200);

    const inspectedResponse = await fetch(
      `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(prepared.interactionId)}`,
    );
    assert.equal(inspectedResponse.status, 200);
    const inspected = await inspectedResponse.json() as {
      readonly revision?: {
        readonly goal: string;
        readonly scope: string;
        readonly constraints: readonly string[];
        readonly deliverables: readonly string[];
        readonly normalizedInput: string;
      };
    };
    if (!inspected.revision) throw new Error('the confirmation must expose its exact typed revision');
    const confirmedRevision = inspected.revision;
    assert.equal(confirmedRevision.goal, goal);
    assert.equal(confirmedRevision.scope, scope);
    assert.deepEqual(confirmedRevision.constraints, constraints);
    assert.deepEqual(confirmedRevision.deliverables, deliverables);
    assert.deepEqual(JSON.parse(confirmedRevision.normalizedInput), expectedTemplate);

    const records = new UiRuntimeJournal(
      join(dirname(taskControlPath), 'ui-runtime-journal.jsonl'),
    ).replay();
    const explicitState = records
      .filter((record): record is Extract<(typeof records)[number], { readonly kind: 'explicit-brain.state' }> => (
        record.kind === 'explicit-brain.state'
      ))
      .at(-1)?.state;
    if (!explicitState) throw new Error('the confirmed requirement must have a durable explicit-brain state');
    const confirmedState = explicitState;
    const envelope = confirmedState.inbox.envelopes.find((entry) => entry.draftId === prepared.draftId);
    if (!envelope) throw new Error('the confirmed draft must have one durable requirement envelope');
    assert.equal(envelope.normalizedInput, confirmedRevision.normalizedInput);

    await waitForAsync(async () => assert.equal((await identityRecords(taskControlPath)).length, 1));
    const identity = (await identityRecords(taskControlPath))[0]!;
    const taskResponse = await fetch(
      `${runtime.server.url}/api/tasks/${encodeURIComponent(identity.scope.taskId.value)}`,
    );
    assert.equal(taskResponse.status, 200);
    const task = await taskResponse.json() as {
      readonly title: string;
      readonly state: string;
      readonly nextStep: string;
      readonly error?: unknown;
    };
    assert.deepEqual(identity.taskFlow, taskFlow);
    assert.equal(identity.title, semanticTitle);
    const listResponse = await fetch(`${runtime.server.url}/api/tasks`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as RuntimeTaskListProjection;
    const visibleRow = [...list.running, ...list.waiting, ...list.completed, ...list.stopped, ...list.draft, ...list.failed]
      .find((row) => row.taskId.value === identity.scope.taskId.value);
    assert.equal(visibleRow?.semanticTitle, semanticTitle);
    assert.deepEqual(visibleRow?.taskFlow, taskFlow);
    assert.equal(task.title, semanticTitle);
    const taskJournalRecords = new UiRuntimeJournal(
      join(dirname(taskControlPath), 'ui-runtime-journal.jsonl'),
    ).replay();
    const createdRecord = taskJournalRecords.find((record) => record.kind === 'task.created'
      && record.taskId.value === identity.scope.taskId.value);
    assert.ok(createdRecord, 'the task journal must contain the durable task creation record');
    assert.equal(createdRecord!.kind === 'task.created' ? createdRecord!.title : undefined, semanticTitle);
    assert.deepEqual(
      JSON.parse(createdRecord!.kind === 'task.created' ? createdRecord!.directive : '{}'),
      expectedTemplate,
    );

    await waitFor(() => assert.equal(port.starts.length, 1, JSON.stringify(task)));
    const startedExecution = port.starts[0]!;
    assert.equal(startedExecution.taskId.value, identity.scope.taskId.value);
    const submittedPrompt = startedExecution.payload?.prompt;
    assert.equal(typeof submittedPrompt, 'string');
    assert.deepEqual(JSON.parse(submittedPrompt as string), expectedTemplate);

    const replayOnly = () => {
      throw new Error('the fixture may only replay and read the task snapshot');
    };
    const replayedTask = new RuntimeTaskCoordinator({
      organId: identity.scope.organId,
      createDriver: replayOnly,
      checkpointStoreFor: replayOnly,
      attentionPort: { publish: replayOnly, resolve: replayOnly },
      journal: { replay: () => taskJournalRecords, append: replayOnly },
    }).taskSnapshot(identity.scope.taskId);
    const currentTask: Task = {
      id: replayedTask.taskId,
      organId: identity.scope.organId,
      title: replayedTask.title,
      directive: replayedTask.directive,
      directiveRevision: replayedTask.directiveRevision,
      state: replayedTask.state,
      memoryScope: 'task',
    };
    assert.equal(currentTask.directive, confirmedRevision.normalizedInput);
    assert.equal(currentTask.title, semanticTitle);

    const cycleId = id('cycle', 'planner-capture-cycle');
    const operationId = id('operation', 'planner-capture-operation');
    const plannerScope: ScopeRef = {
      organId: identity.scope.organId,
      taskId: identity.scope.taskId,
      cycleId,
      operationId,
    };
    const checkpointCommitRef: JournalCommitRef = {
      commitId: 'planner-capture-checkpoint-commit',
      journalSeq: 1,
      recordDigest: `sha256:${'1'.repeat(64)}`,
    };
    const plannerEvidence = (label: string): EvidenceRef => ({
      evidenceId: id('evidence', `planner-capture-${label}`),
      kind: 'operation',
      source: 'new-task-identity-public-consumer',
      locator: `planner-capture/${label}`,
      scope: plannerScope,
    });
    const checkpointId = id('checkpoint', 'planner-capture-checkpoint');
    const checkpoint: Checkpoint = {
      id: checkpointId,
      scope: plannerScope,
      cycleId,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: currentTask.directiveRevision,
      executionEpoch: 1,
      outcome: 'succeeded',
      summary: 'The first execution turn closed.',
      recoveryStateRef: plannerEvidence('recovery'),
      evidenceRefs: [plannerEvidence('checkpoint')],
      next: { kind: 'continue', ref: 'planner:capture' },
    };
    const closure: TurnClosureReference = {
      identity: {
        turnId: 'planner-capture-turn',
        workAssignmentRef: 'planner-capture-assignment',
        taskRef: identity.scope.taskId,
        scopeRef: plannerScope,
        cycleRef: cycleId,
        inputRevision: identity.source.inputRevision,
        directiveRevision: currentTask.directiveRevision,
        executionEpoch: 1,
        runtimeBindingRef: 'planner-capture-runtime',
        permissionRevision: 'planner-capture-permission',
      },
      checkpointId,
      closureRef: 'planner-capture-closure',
      summary: {
        goal: { text: 'Preserve the confirmed requirement.', evidenceRefs: [plannerEvidence('goal')] },
        actions: { text: 'The first turn completed.', evidenceRefs: [plannerEvidence('actions')] },
        result: { text: 'The confirmed requirement is ready to plan.', evidenceRefs: [plannerEvidence('result')] },
        expectedNextStep: { text: 'Plan the next turn.', evidenceRefs: [plannerEvidence('next')] },
      },
      recoveryStateRef: plannerEvidence('closure-recovery'),
      closedAt: '2026-10-18T00:00:00.000Z',
    };
    const plannerIncarnation: TaskRuntimeIncarnation = {
      runtimeId: 'planner-capture-runtime',
      generation: 1,
      agentInstanceId: 'planner-capture-instance',
      roleId: 'orchestration',
      taskId: identity.scope.taskId,
      assignmentId: 'planner-capture-assignment',
      executionEpoch: 1,
    };
    const plannerExecution: ProviderExecutionIdentityRef = {
      runtimeId: plannerIncarnation.runtimeId,
      taskId: identity.scope.taskId,
      operationId,
      organId: identity.scope.organId,
      cycleId,
      executionEpoch: plannerIncarnation.executionEpoch,
    };
    const allocation = {
      operationId,
      cycleId,
      executionEpoch: plannerIncarnation.executionEpoch,
    };
    const plannerInput = {
      task: currentTask,
      closure,
      refinedResults: [],
      priorPlan: null,
      identity,
      allocation,
    };
    const duty = deriveClosedTurnPlannerDuty(plannerInput, checkpointCommitRef);
    const grantCommitRef: JournalCommitRef = {
      commitId: 'planner-capture-grant-commit',
      journalSeq: 2,
      recordDigest: `sha256:${'2'.repeat(64)}`,
    };
    const admissionCommitRef: JournalCommitRef = {
      commitId: 'planner-capture-admission-commit',
      journalSeq: 3,
      recordDigest: `sha256:${'3'.repeat(64)}`,
    };
    const plannerLease = {
      leaseId: 'planner-capture-lease',
      runtimeId: plannerIncarnation.runtimeId,
      generation: plannerIncarnation.generation,
      incarnation: plannerIncarnation,
      executionEpoch: plannerIncarnation.executionEpoch,
      ownerId: 'planner-capture-pool',
      assignmentId: plannerIncarnation.assignmentId,
      capabilities: ['provider.execution'],
    };
    const preparedCall = {
      duty,
      invocationId: 'planner-capture-invocation',
      execution: plannerExecution,
      scope: plannerScope,
      assignmentId: plannerIncarnation.assignmentId,
      incarnation: plannerIncarnation,
      lease: plannerLease,
      decision: {
        action: 'spawn' as const,
        ownerId: 'planner-capture-pool',
        condition: 'orchestration.runtime.capacity',
        nextAction: { kind: 'continue' as const, ref: plannerIncarnation.runtimeId },
        reason: 'planner capture capacity is available',
        runtimeId: plannerIncarnation.runtimeId,
      },
      grantCommitRef,
      admissionCommitRef,
      checkpoint: { checkpoint, previous: null, commitRef: checkpointCommitRef },
      preparationCommitRef: {
        commitId: 'planner-capture-preparation-commit',
        journalSeq: 4,
        recordDigest: `sha256:${'4'.repeat(64)}`,
      },
    };
    const plannerPort = new CountingStartPort({
      binding,
      replay: [
        {
          kind: 'output',
          state: 'output',
          summary: JSON.stringify({
            decision: 'continue',
            snapshot: taskPlanSnapshot('planner-capture'),
            reasonText: 'The confirmed requirement is represented in the plan.',
          }),
        },
        {
          kind: 'terminal',
          state: 'succeeded',
          summary: 'planner capture succeeded',
          terminalState: 'succeeded',
        },
      ],
      stepDelayMs: 1,
    });
    const planner = createIndependentTurnPlanner({
      prepareAgentProvider: async (selection): Promise<AgentProviderComposition> => ({
        roleId: selection.roleId,
        provider: {
          source: 'rcc',
          provider: 'rcc',
          binding: binding.bindingId,
          protocol: 'responses',
          model: binding.modelRef,
          route: 'planner-capture-route',
          baseUrl: 'http://127.0.0.1:4444',
        },
        source: 'rcc',
        binding,
        port: plannerPort,
      }),
      now: () => new Date('2026-10-18T00:00:01.000Z'),
    });
    const plannerResult = await planner.plan({
      ...plannerInput,
      preparedCall,
    });
    assert.equal(plannerResult.decision, 'continue');
    assert.equal(plannerPort.starts.length, 1);
    const plannerPayload = plannerPort.starts[0]!.payload as unknown as {
      readonly role: string;
      readonly task: { readonly title: string; readonly directive: string };
    };
    assert.equal(plannerPayload.role, 'planner');
    assert.equal(plannerPayload.task.title, semanticTitle);
    assert.equal(plannerPayload.task.directive, confirmedRevision.normalizedInput);
    assert.deepEqual(JSON.parse(plannerPayload.task.directive), expectedTemplate);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Component failure basis for this focused consumer.
 *
 * Failure mode: a validated `source: 'http'` binding whose real probe is the
 * honest `unknown` with `continue -> http.start` still fails Task admission,
 * because the readiness gate drops the source-aware requestability and the Task
 * is never created. Impact: an HTTP-configured Task can probe and submit but
 * never becomes an executable Task. Probability: unquantified. Cost: one
 * continuous case inside the existing consumer plus one type-safe source
 * counterexample; no new harness, matrix, credential or service.
 */
test('G-A HTTP source public Task admission', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'case-ga-'));
  const taskControlPath = taskControlPathFor(root, 'rcc');
  const evidenceRoot = join(root, 'evidence');
  const upstreamOrigin = 'http://127.0.0.1:4599';
  const committedTaskFlow: TaskFlowBinding = {
    kind: 'long-running',
    definitionVersion: TASK_FLOW_DEFINITION_VERSION,
  };
  const capture = captureUpstream(upstreamOrigin);
  // The probe owner is the real assembled HTTP-source port: it never performs
  // RCC discovery and returns the typed `unknown`/`http.start` readiness.
  const probePort = assembleProviderExecutionPort({
    binding: gaHttpBinding,
    routeRef: 'ga-http-route',
    baseUrl: upstreamOrigin,
    source: 'http',
  }, evidenceRoot);
  const httpProvider: ProviderConfig = {
    source: 'http',
    provider: 'http',
    binding: gaHttpBinding.bindingId,
    protocol: 'responses',
    model: gaHttpBinding.modelRef,
    route: 'ga-http-route',
    baseUrl: upstreamOrigin,
  };
  const entries: EffectiveAgentProviderBinding[] = [
    { agentId: 'ga-http-execution', roleId: 'execution', source: 'agent', provider: httpProvider },
    { agentId: 'ga-http-orchestration', roleId: 'orchestration', source: 'agent', provider: httpProvider },
  ];
  // The native launch requires both preparers. The neutral preparer keeps the
  // taskless parent/helper path; the Task-scoped preparer hands the selected
  // composition's custody to the prepared-stop owner exactly as the real serve
  // caller wires it, so the public Task path keeps its real custody. It starts
  // inside this try so a launch failure still releases the case's own capture.
  let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
  try {
    runtime = await startRuntime(root, probePort, {
      projectKey: 'project-ga-http',
      mode: 'rcc',
      providerSource: 'http',
      binding: gaHttpBinding,
      taskIdentity: (owner, path) => identityWithFixtureGrant(owner, path, undefined, committedTaskFlow),
      runtimeComposition: {
        prepareAgentProvider: async (selection) => assembleAgentProvider({
          roleId: selection.roleId,
          ...(selection.configuredAgentId === undefined ? {} : { configuredAgentId: selection.configuredAgentId }),
          agentProviderBindings: entries,
          legacyProvider: httpProvider,
          evidenceRoot,
        }),
        prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({
          roleId: selection.roleId,
          ...(selection.configuredAgentId === undefined ? {} : { configuredAgentId: selection.configuredAgentId }),
          agentProviderBindings: entries,
          legacyProvider: httpProvider,
          createPort: (selected) => createAgentProviderPort(selected, evidenceRoot),
        }, owner, lease),
      },
    });

    // The real probe reached no network and the runtime kept the honest unknown;
    // it must not be rewritten to degraded just to make the Task requestable.
    assert.deepEqual(capture.requests, []);
    assert.equal(runtime.service.status().providerState, 'unknown');
    assert.equal(runtime.service.status().state, 'unknown');

    const submission = await submitNewTask(runtime, 'public-ga-http');

    // The confirmed requirement flows through the real FIFO and the real Organ
    // Journal identity owner before execution, so the exact Task identity is the
    // one the submission confirmed.
    await waitForAsync(async () => {
      assert.equal((await identityRecords(taskControlPath)).length, 1);
    });
    const committed = (await identityRecords(taskControlPath))[0]!;
    assert.equal(committed.source.requirementId, submission.receipt.requirement.requirementId);
    assert.equal(committed.source.draftId, submission.draftId);

    // The public read returns that same Task, bound to the confirmed source.
    const listResponse = await fetch(`${runtime.server.url}/api/tasks`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as RuntimeTaskListProjection;
    const rows = [
      ...list.running, ...list.waiting, ...list.completed,
      ...list.stopped, ...list.draft, ...list.failed,
    ];
    const row = rows.find((candidate) => candidate.taskId.value === committed.scope.taskId.value);
    assert.ok(row, 'the admitted HTTP-source Task must appear in the public task list');
    assert.deepEqual(row!.identitySource, committed.source);
    assert.equal(runtime.service.status().providerState, 'unknown', 'unknown health stays unknown under the HTTP source');

    // The admission edge really released an execution, which reached the
    // configured origin exactly once through the Responses protocol. No RCC
    // discovery probe (`/health`, `/v1/models`) may have been sent.
    await waitFor(() => assert.equal(capture.requests.length, 1), 8000);
    assert.equal(capture.requests[0]!.method, 'POST');
    assert.equal(new URL(capture.requests[0]!.url).pathname, '/v1/responses');
    const sent = JSON.parse(capture.requests[0]!.body) as { readonly model?: string };
    assert.equal(sent.model, gaHttpBinding.modelRef);
    assert.equal(
      capture.requests.some((request) => request.url.endsWith('/health') || request.url.endsWith('/v1/models')),
      false,
      'the HTTP source must not run RCC discovery',
    );
  } finally {
    // The captured launch/admission error is only rethrown after this case's
    // own runtime, fetch capture and fixture root are all released; the error
    // is never swallowed here. A start failure must not leak the fixture the
    // same way it used to leak the process-wide capture.
    await runtime?.close();
    capture.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('a real identity append failure stops execution and retries the same Task and source', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'case-b-'));
  const taskControlPath = taskControlPathFor(root);
  const faultJournal = new FailOnceIdentityJournal(new JsonlOrganJournal(taskControlPath));
  const port = new IdentityBeforeStartPort(taskControlPath, { binding, stepDelayMs: 1 });
  const runtime = await startRuntime(root, port, {
    projectKey: 'project-task-identity-b',
    taskIdentity: (principalOwner, path) => identityWithFixtureGrant(principalOwner, path, faultJournal),
  });
  try {
    faultJournal.failNextAppend = true;
    await submitNewTask(runtime, 'public-identity-b');
    await waitFor(() => assert.equal(runtime.service.status().implicitScheduling?.state, 'failed'));
    assert.match(runtime.service.status().implicitScheduling?.message ?? '', /task identity journal unavailable/);
    assert.equal(port.identitiesAtStart.length, 0, 'no execution may start while identity is uncommitted');
    assert.equal((await identityRecords(taskControlPath)).length, 0);
    const taskIds = await createdTaskIds(runtime);
    assert.equal(taskIds.length, 1);

    // Retrying reuses the created Task and the same typed source.
    runtime.service.markConnected();
    await waitFor(() => assert.equal(port.identitiesAtStart.length, 1));
    const identities = await identityRecords(taskControlPath);
    assert.equal(identities.length, 1);
    assert.equal(identities[0]!.scope.taskId.value, taskIds[0]);
    assert.deepEqual(await createdTaskIds(runtime), taskIds, 'retry must reuse the same Task');
    assert.equal(port.identitiesAtStart.length, 1, 'identity is established exactly once before the retried start');
  } finally {
    await runtime.close();
  }

  await rm(root, { recursive: true, force: true });
});

test('app_read_mounts_preference_routes_dispatch_to_config_resource', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'case-pref-route-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ workspace, controlRoot });
  await ensureControlLayout(paths);
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  // The bound runtime uses Config-owned paths, so compare the exact canonical
  // Journal that the service resolves rather than a path guessed from the root.
  const taskControlPath = uiRuntimeControlJournalPath(
    uiRuntimeModeRoot(paths.checkpointsRoot, 'fake'),
  );
  const port = new CountingStartPort({ binding, stepDelayMs: 1 });
  const runtime = await startUiRuntime({
    mode: 'fake',
    accessControl,
    productRoot: paths.controlRoot,
    organId,
    binding,
    port,
    checkpointRoot: uiRuntimeCheckpointRoot(paths.checkpointsRoot),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages', 'ui', 'static'),
    projectKey: 'project-pref-route',
    workspaceRoot: root,
    memory: memoryFor('project-pref-route'),
    explicitBrainInterpreter: createInterpreter,
    runtimePaths: paths,
  });
  sessionByOrigin.set(new URL(runtime.server.url).origin, cookie);
  try {
    const controlBytesBefore = await readOptionalFile(taskControlPath);
    const url = `${runtime.server.url}/api/ui/display-preference`;

    const initial = await rawNoOrigin(url, 'GET', cookie);
    assert.equal(initial.status, 200);
    const initialDto = await initial.json() as {
      readonly preference: { readonly schemaVersion: number; readonly mode: string; readonly lastManual?: unknown };
      readonly defaultMode: string;
    };
    assert.equal(initialDto.preference.schemaVersion, 1);
    assert.equal(initialDto.defaultMode, 'current');

    const saved = await rawNoOrigin(url, 'PUT', cookie, {
      kind: 'set-default',
      mode: 'semantic',
    });
    assert.equal(saved.status, 200);
    const savedDto = await saved.json() as {
      readonly preference: { readonly schemaVersion: number; readonly mode: string };
      readonly defaultMode: string;
    };
    assert.equal(savedDto.preference.mode, 'semantic');
    assert.equal(savedDto.defaultMode, 'semantic');

    const afterSave = await rawNoOrigin(url, 'GET', cookie);
    assert.equal(afterSave.status, 200);
    const afterSaveDto = await afterSave.json() as {
      readonly preference: { readonly schemaVersion: number; readonly mode: string };
      readonly defaultMode: string;
    };
    assert.equal(afterSaveDto.preference.mode, 'semantic');

    const removed = await rawNoOrigin(url, 'DELETE', cookie);
    assert.equal(removed.status, 200);
    const removedDto = await removed.json() as {
      readonly preference: { readonly schemaVersion: number; readonly mode: string };
      readonly defaultMode: string;
    };
    assert.equal(removedDto.preference.mode, 'current');

    // One minimal invalid business field keeps a typed non-success and writes
    // neither Config nor the task/control Journal.
    const invalid = await rawNoOrigin(url, 'PUT', cookie, {
      kind: 'set-default',
      mode: 'not-a-mode',
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json() as { readonly error?: { readonly code: string } };
    assert.equal(invalidBody.error?.code, 'display-preference.invalid-mode');

    // An unauthenticated mutation keeps the session rejection and changes no
    // stored value.
    const unauth = await rawFetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'set-default', mode: 'actions' }),
    });
    assert.equal(unauth.status, 401);
    const afterInvalid = await rawNoOrigin(url, 'GET', cookie);
    const afterInvalidDto = await afterInvalid.json() as {
      readonly preference: { readonly schemaVersion: number; readonly mode: string };
      readonly defaultMode: string;
    };
    assert.equal(afterInvalidDto.preference.mode, 'current');

    // The mount is a pure read/save/reset resource: no task Journal record is
    // appended, and the execution port is never called (there is no task to
    // start, so the fake port keeps zero sessions).
    assert.equal(await readOptionalFile(taskControlPath), controlBytesBefore);
    assert.equal(runtime.service.listTasks().counts.total, 0);
    assert.equal(port.startCount, 0);
  } finally {
    await runtime.close();
  }
  await rm(root, { recursive: true, force: true });
});

test('app_read_mounts_dashboard_history_uses_accepted_current_and_scoped_identity', async () => {
  await mkdir(ROOT, { recursive: true });
  const root = await mkdtemp(join(ROOT, 'case-w1-dashboard-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ workspace, controlRoot: join(root, 'control') });
  await ensureControlLayout(paths);
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  const taskControlPath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(paths.checkpointsRoot, 'fake'));
  const taskControlJournal = new JsonlOrganJournal(taskControlPath);
  const taskIdentity = identityWithFixtureGrant(accessControl.readProductPrincipalOwner(), taskControlPath);
  const port = new CountingStartPort({ binding, stepDelayMs: 1 });
  const runtime = await startUiRuntime({
    mode: 'fake',
    accessControl,
    productRoot: paths.controlRoot,
    organId,
    binding,
    port,
    checkpointRoot: uiRuntimeCheckpointRoot(paths.checkpointsRoot),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages', 'ui', 'static'),
    projectKey: paths.projectKey,
    workspaceRoot: workspace,
    memory: memoryFor(paths.projectKey),
    explicitBrainInterpreter: createInterpreter,
    runtimePaths: paths,
    taskIdentity,
  });
  sessionByOrigin.set(new URL(runtime.server.url).origin, cookie);
  try {
    await submitNewTask(runtime, 'public-dashboard-w1');
    await waitForAsync(async () => assert.equal((await identityRecords(taskControlPath)).length, 1));
    const committedIdentity = (await identityRecords(taskControlPath))[0]!;
    // The committed identity (seq 1) is only the first write of an independent
    // real lifecycle. The runtime keeps appending admission, coverage and the
    // terminal business checkpoint to the same control Journal, so wait for the
    // genuine Task settlement before seeding plan/current facts and snapshotting.
    await waitFor(() => assert.equal(
      runtime.service.taskDashboard(committedIdentity.scope.taskId).state,
      'succeeded',
    ));
    const plans = new TaskPlanRevisionConsumer(
      new JsonlTaskPlanRevisionJournal(taskControlJournal),
    );
    const source = (revision: number) => ({
      ...committedIdentity.source,
      inputRevision: revision,
      draftRevisionVersion: revision,
      evidenceRefs: [taskPlanEvidence(`dashboard-source-${revision}`, committedIdentity.scope)],
    });
    const publish = async (
      revisionId: string,
      sequence: number,
      predecessor: { readonly revisionId: string; readonly sequence: number; readonly contentDigest: `sha256:${string}` } | null,
    ) => (await plans.publish({
      scope: committedIdentity.scope,
      revisionId,
      sequence,
      predecessor,
      snapshot: taskPlanSnapshot(`v${sequence}`),
      reason: sequence === 1
        ? { kind: 'initial' as const, basisRefs: [] }
        : { kind: 'adjustment' as const, text: `Publish reasoning plan v${sequence}`, basisRefs: [] },
      source: source(sequence),
      historyCoverage: 'complete-from-task-start',
      publishedAt: `2026-10-15T00:0${sequence}:00.000Z`,
      publishedBy: 'app-read-mount-fixture',
    })).revision;
    const v1 = await publish('plan-v1', 1, null);
    const v2 = await publish('plan-v2', 2, {
      revisionId: v1.revisionId,
      sequence: v1.sequence,
      contentDigest: v1.contentDigest,
    });
    const v3 = await publish('plan-v3', 3, {
      revisionId: v2.revisionId,
      sequence: v2.sequence,
      contentDigest: v2.contentDigest,
    });
    const v2Receipt = await currentTaskPlanReceipt(plans, committedIdentity.scope, v2.revisionId);

    const currentState = createJsonlRuntimeTaskCurrentStateJournal({ journal: taskControlJournal });
    const beforeCurrent = await currentState.read(committedIdentity.scope);
    assert.equal(beforeCurrent.state, 'unknown');
    await currentState.commit({
      transitionId: 'fixture-current-v2',
      taskScope: committedIdentity.scope,
      expectedStateCommitRef: null,
      state: {
        task: {
          id: committedIdentity.scope.taskId,
          organId: committedIdentity.scope.organId,
          title: 'Dashboard history fixture',
          directive: 'Read the accepted reasoning plan',
          directiveRevision: 1,
          state: 'succeeded',
          memoryScope: 'task',
        },
        processing: {
          entryPhase: 'succeeded',
          nextAction: { kind: 'stop' },
          hardBlockers: [],
          recoveryResponsibilityRef: 'fixture',
          laterErrorRefs: [],
          stages: [],
        },
        retainedDuties: [],
        sourceCommitRefs: [],
        currentPlan: {
          revisionId: v2.revisionId,
          revisionCommitRef: v2Receipt,
        },
      },
    });

    const subscriptionPath = join(paths.checkpointsRoot, 'ui-runtime', 'fake', 'subscriptions.jsonl');
    const subscriptions = new SubscriptionControlPort(
      new JsonlOrganJournal(subscriptionPath),
      { organId },
      subscriptionPath,
    );
    const subscriptionId = `subscription:${committedIdentity.source.requirementId}`;
    const existingSchedule = await subscriptions.snapshot(subscriptionId).catch((error: unknown) => {
      if ((error as { readonly code?: string }).code === 'not-found') return undefined;
      throw error;
    });
    const schedule = existingSchedule ?? await subscriptions.create({
      subscriptionId,
      goalId: committedIdentity.source.requirementId,
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    }, dashboardSchedulePolicy(), subscriptionId);
    const taskId = committedIdentity.scope.taskId;
    const scheduleDueAt = '2026-10-15T00:00:00.000Z';
    const occurrence = await subscriptions.schedule({
      occurrence: {
        subscriptionId,
        scheduleRevision: schedule.subscription.scheduleRevision,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: scheduleDueAt,
      },
      nowAt: scheduleDueAt,
    });
    assert.equal(occurrence.state, 'due');
    const claim = await subscriptions.claim({
      subscriptionId,
      scheduleRevision: schedule.subscription.scheduleRevision,
      occurrenceOrdinal: 1,
      dueAt: scheduleDueAt,
      taskId,
      operationId: id('operation', 'app-read-mount-dashboard-claim'),
      inputArtifactDigest: 'sha256:app-read-mount-dashboard-claim',
      schedulerInstanceId: 'app-read-mount-dashboard-fixture',
      leaseId: 'app-read-mount-dashboard-fixture',
      generation: 1,
      executionEpoch: 1,
      nowAt: scheduleDueAt,
      leaseUntil: '2026-10-15T01:00:00.000Z',
    });
    assert.equal(claim.taskId.value, taskId.value);
    const controlBytesBeforeRead = await readOptionalFile(taskControlPath);
    const dashboardResponse = await rawNoOrigin(
      `${runtime.server.url}/api/tasks/${encodeURIComponent(taskId.value)}/dashboard`,
      'GET',
      cookie,
    );
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json() as RuntimeTaskDashboardProjection & {
      readonly plan?: { readonly subscriptionId: string; readonly state: string };
    };
    assert.equal(dashboard.plan?.subscriptionId, subscriptionId);
    assert.equal(dashboard.plan?.state, schedule.subscription.state);
    assert.equal(dashboard.taskPlanHistory.ok, true);
    if (!dashboard.taskPlanHistory.ok) throw new Error(dashboard.taskPlanHistory.failure.message);
    const history = dashboard.taskPlanHistory.value;
    assert.deepEqual(history.revisions.map((revision) => revision.sequence), [1, 2, 3]);
    assert.equal(history.current.state, 'known');
    if (history.current.state !== 'known') throw new Error('accepted current must be known');
    assert.equal(history.current.value.revisionId, v2.revisionId);
    assert.deepEqual(history.current.value.revisionCommitRef, v2Receipt);
    assert.equal(await readOptionalFile(taskControlPath), controlBytesBeforeRead);

    const coldCurrent = await currentState.read(committedIdentity.scope);
    assert.equal(coldCurrent.state, 'known');
    if (coldCurrent.state !== 'known') throw new Error('cold current must be known');
    assert.deepEqual(coldCurrent.value.currentPlan, {
      revisionId: v2.revisionId,
      revisionCommitRef: v2Receipt,
    });
    const coldIdentity = await new TaskIdentityConsumer(
      new JsonlTaskIdentityJournal(new JsonlOrganJournal(taskControlPath)),
    ).read(committedIdentity.scope);
    assert.ok(coldIdentity);
    assert.deepEqual(coldIdentity!.source, committedIdentity.source);

    const scopedResponse = await rawNoOrigin(
      `${runtime.server.url}/api/tasks/${encodeURIComponent(taskId.value)}/dashboard`
        + `?projectKey=${encodeURIComponent(paths.projectKey)}&mode=fake`,
      'GET',
      cookie,
    );
    assert.equal(scopedResponse.status, 200);
    const scoped = await scopedResponse.json() as RuntimeTaskDashboardProjection;
    assert.equal(scoped.taskPlanHistory.ok, true);
    if (!scoped.taskPlanHistory.ok) throw new Error(scoped.taskPlanHistory.failure.message);
    assert.deepEqual(
      scoped.taskPlanHistory.value.revisions.map((revision) => revision.sequence),
      [1, 2, 3],
    );
    assert.equal(scoped.taskPlanHistory.value.current.state, 'known');
    if (scoped.taskPlanHistory.value.current.state !== 'known') {
      throw new Error('scoped accepted current must be known');
    }
    assert.deepEqual(scoped.taskPlanHistory.value.current.value, {
      revisionId: v2.revisionId,
      revisionCommitRef: v2Receipt,
    });
    assert.equal(v3.sequence, 3);
  } finally {
    await runtime.close();
  }
  await rm(root, { recursive: true, force: true });
});
