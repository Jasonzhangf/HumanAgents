// Black-box acceptance for the production scheduled-occurrence DAG:
// persisted active plan -> due-time patrol under a live supervisor lease ->
// schedule/claim -> durable consumer -> real coordinator execution -> verified
// terminal -> settlement, observed through the public HTTP surface only.
//
// The wall clock is the production clock: nothing here injects or freezes time.
// The lease, the occurrence consumer, its journal, the subscription control port
// and the execution coordinator are the real objects. Only the provider port is
// the fake replay runtime that the rest of the app test suite uses, because the
// real RCC provider path is exercised by the separate E2E entry.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  id,
  occurrenceExecutionAdmissionCommitId,
  occurrenceTerminalReceiptCommitId,
  type ExecutionPolicyDefinition,
  type ExecutionRuntimePort,
  type OccurrenceTaskBinding,
  type ProviderBinding,
  type ProviderCapabilities,
  type ProviderCloseResult,
  type ProviderEvent,
  type ProviderObserveInput,
  type ProviderReadiness,
  type ProviderRecoveryResult,
  type ProviderResumeInput,
  type ProviderSettleInput,
  type ProviderSettlement,
  type ProviderStartInput,
  type ProviderStartReceipt,
  type ProviderStopReceipt,
  type ProviderStopRequest,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
} from '../../packages/contracts/src/index.js';
import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { acquireDaemonLease } from '../../packages/app/src/supervisor/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import {
  FakeReplayExecutionRuntimePort,
  startUiRuntime,
  type UiRuntime,
} from '../../packages/app/src/ui-runtime/index.js';
import { DurableOccurrenceConsumer } from '../../packages/app/src/ui-runtime/occurrence-consumer.js';
import { occurrenceExecutionIdentity } from '../../packages/app/src/ui-runtime/scheduler.js';
import { executionPolicyHash } from '../../packages/runtime/src/subscriptions/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import type { ExplicitBrainInputInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';

const organId = id('organ', 'organ-scheduler-production');
const binding: ProviderBinding = {
  bindingId: 'binding-scheduler-production',
  providerId: 'provider-scheduler-production',
  protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444',
  modelRef: 'model-scheduler-production',
  configDigest: 'sha256:scheduler-production-config',
  capabilityDigest: 'sha256:scheduler-production-capability',
};

const policyBase = {
  policyRevision: 1,
  timezone: 'UTC',
  canonicalInstant: '2026-10-06T00:00:00.000Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'run-once',
  busyPolicy: 'skip',
} as const;

function scheduledPolicy(startAt: string): ExecutionPolicyDefinition {
  return { ...policyBase, policyId: 'policy-scheduler-production-scheduled', executionMode: 'scheduled', startAt };
}

function recurringPolicy(startAt: string, intervalMinutes: number): ExecutionPolicyDefinition {
  return {
    ...policyBase,
    policyId: 'policy-scheduler-production-recurring',
    executionMode: 'recurring',
    startAt,
    frequency: 'interval',
    intervalMinutes,
  };
}

function requirementInterpreter(): ExplicitBrainInputInterpreter {
  return {
    async interpret(input) {
      return {
        kind: 'requirement',
        normalizedInput: input.rawInput,
        knownFacts: [],
        intent: 'create',
        proposal: `create:${input.rawInput}`,
        decisionRefs: ['decision:scheduler-production'],
      };
    },
  };
}

/** Counts real provider starts, which is the side-effect boundary of one execution. */
class CountingExecutionPort implements ExecutionRuntimePort {
  readonly kind = 'humanagent.execution-runtime-port' as const;
  readonly starts: ProviderStartInput[] = [];
  private holdStarts = false;
  private releaseHold: (() => void) | undefined;
  private readonly holdGate: Promise<void>;
  constructor(private readonly inner: ExecutionRuntimePort) {
    this.holdGate = new Promise<void>((resolve) => { this.releaseHold = resolve; });
  }
  /**
   * Hold every provider start open. The runtime then really has a running task,
   * which is the only way the patrol can observe a busy organ.
   */
  hold(): void { this.holdStarts = true; }
  release(): void { this.holdStarts = false; this.releaseHold?.(); }
  probe(binding: ProviderBinding): Promise<ProviderReadiness> { return this.inner.probe(binding); }
  capabilities(binding: ProviderBinding): Promise<ProviderCapabilities> { return this.inner.capabilities(binding); }
  async start(input: ProviderStartInput): Promise<ProviderStartReceipt> {
    this.starts.push(structuredClone(input));
    if (this.holdStarts) await this.holdGate;
    return await this.inner.start(input);
  }
  resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult> { return this.inner.resume(input); }
  submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> { return this.inner.submit(input); }
  observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent> { return this.inner.observe(input); }
  requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt> { return this.inner.requestStop(input); }
  settle(input: ProviderSettleInput): Promise<ProviderSettlement> { return this.inner.settle(input); }
  close(binding: ProviderBinding): Promise<ProviderCloseResult> { return this.inner.close(binding); }
}

interface SchedulerPlanView {
  readonly subscriptionId: string;
  readonly goalId: string;
  readonly scheduleRevision: number;
  readonly state: string;
  readonly currentOccurrenceOrdinal: number;
  readonly occurrences: readonly {
    readonly occurrenceId?: string;
    readonly occurrenceOrdinal: number;
    readonly state: string;
    readonly dueAt: string;
  }[];
  readonly settlements: readonly {
    readonly occurrenceId?: string;
    readonly occurrenceOrdinal: number;
    readonly verificationStatus: string;
    readonly settlementReceiptRef: string;
  }[];
}

interface SchedulerStatusView {
  readonly state: string;
  readonly ticks: number;
  readonly claimed: number;
  readonly executed: number;
  readonly settled: number;
  readonly skipped: number;
  readonly plans: readonly SchedulerPlanView[];
  /** Present only on the fail-closed projection when no patrol was armed. */
  readonly reason?: { readonly code: string; readonly message: string };
  readonly issue?: { readonly code: string; readonly message: string; readonly nextAction: string };
}

function issueText(status: SchedulerStatusView): string {
  return status.issue === undefined ? 'no patrol issue' : `patrol issue ${status.issue.code}: ${status.issue.message}`;
}

interface TaskListRow {
  readonly taskId: { readonly value: string };
  readonly state: string;
  readonly title: string;
}

interface TaskListView {
  readonly running: readonly TaskListRow[];
  readonly completed: readonly TaskListRow[];
  readonly failed: readonly TaskListRow[];
  readonly stopped: readonly TaskListRow[];
  readonly waiting: readonly TaskListRow[];
}

interface TaskDashboardView {
  readonly state: string;
  readonly checkpoint?: { readonly outcome: string };
}

interface Harness {
  readonly runtime: UiRuntime;
  readonly root: string;
  readonly port: CountingExecutionPort;
  readonly origin: string;
  readonly modeRoot: string;
  call(path: string, body?: unknown): Promise<Response>;
  json<T>(path: string): Promise<T>;
  close(): Promise<void>;
}

async function startHarness(input: {
  readonly root: string;
  readonly intervalMs?: number;
  readonly replayTerminal?: 'succeeded' | 'blocked';
  readonly port?: CountingExecutionPort;
  /**
   * `unleased` builds a real runtime without the supervisor lease option, which
   * is the production entry's fail-closed path when no lease can be resolved.
   */
  readonly leaseMode?: 'leased' | 'unleased';
  /** Distinct credential roots keep sequential runtimes in one test root isolated. */
  readonly credentialKey?: string;
}): Promise<Harness> {
  const checkpointRoot = join(input.root, 'checkpoints');
  const workspace = join(input.root, 'workspace');
  const controlRoot = join(input.root, 'control');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const lease = await acquireDaemonLease(paths, { ownerId: 'scheduler-production-wiring' });
  const port = input.port ?? new CountingExecutionPort(new FakeReplayExecutionRuntimePort({
    binding,
    stepDelayMs: 1,
    ...(input.replayTerminal === undefined || input.replayTerminal === 'succeeded'
      ? {}
      : {
          replay: [
            { kind: 'model' as const, state: 'model', summary: 'model accepted the request' },
            { kind: 'terminal' as const, state: input.replayTerminal, summary: `execution ${input.replayTerminal}`, terminalState: input.replayTerminal },
          ],
        }),
  }));
  const accessControl = await AccessControlService.open({
    credentialPath: join(input.root, 'security', input.credentialKey ?? 'primary', 'web-access.json'),
    create: true,
  });
  const challenge = accessControl.createPairingChallenge('scheduler-production', 1);
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  const runtime = await startUiRuntime({
    mode: 'fake',
    accessControl,
    organId,
    binding,
    port,
    checkpointRoot,
    evidenceRoot: join(input.root, 'evidence'),
    uiRoot: join(process.cwd(), 'docs', 'ui'),
    providerState: 'ready',
    portNumber: 0,
    explicitBrainInterpreter: requirementInterpreter(),
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'project-scheduler-production',
      roleId: 'execution',
    },
    ...(input.intervalMs === undefined ? {} : { schedulerIntervalMs: input.intervalMs }),
    ...(input.leaseMode === 'unleased' ? {} : { lease: () => lease }),
  });
  const origin = new URL(runtime.server.url).origin;
  const call = (path: string, body?: unknown): Promise<Response> => fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    runtime,
    root: input.root,
    port,
    origin,
    modeRoot: join(checkpointRoot, 'fake'),
    call,
    async json<T>(path: string): Promise<T> {
      const response = await call(path);
      const text = await response.text();
      assert.equal(response.status, 200, `${path} must be readable: ${text}`);
      return JSON.parse(text) as T;
    },
    async close() {
      await runtime.close();
      await lease.release();
    },
  };
}

/** Create one confirmed execution plan through the real HTTP explicit-brain entry. */
async function persistPlan(
  harness: Harness,
  rawInput: string,
  policy: ExecutionPolicyDefinition | undefined,
): Promise<string> {
  const created = await harness.call('/api/explicit/inputs', {
    sourceRef: `ui:${rawInput}`,
    rawInput,
    channel: 'business',
    requestKind: 'new-task-preview',
  });
  assert.equal(created.status, 201, 'the explicit input route accepts the request');
  const { interactionId } = await created.json() as { readonly interactionId: string };
  const route = `/api/explicit/interactions/${encodeURIComponent(interactionId)}`;
  assert.equal((await harness.call(`${route}/matching`, {})).status, 202);
  assert.equal((await harness.call(`${route}/match`, {
    normalizedInput: rawInput,
    matchedTasks: [],
    knownFacts: [],
  })).status, 202);
  assert.equal((await harness.call(`${route}/proposal`, {
    proposedIntent: 'create',
    proposal: `create:${rawInput}`,
  })).status, 202);
  const snapshot = await (await harness.call(route)).json() as { readonly draft?: { readonly draftId: string } };
  assert.ok(snapshot.draft, 'the explicit flow produced a reviewable draft');
  const confirmed = await harness.call(`${route}/confirmation`, {
    draftId: snapshot.draft!.draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${rawInput}`,
    confirmedBy: 'human:operator',
    confirmedAt: new Date().toISOString(),
    payloadRef: `asset://requirements/${rawInput}`,
    executionPolicy: policy,
  });
  const confirmedText = await confirmed.text();
  assert.equal(confirmed.status, 200, `the confirmation must persist the plan: ${confirmedText}`);
  const receipt = JSON.parse(confirmedText) as { readonly requirement: { readonly requirementId: string } };
  return receipt.requirement.requirementId;
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (last instanceof Error) throw last;
  await assertion();
}

function planFor(status: SchedulerStatusView, requirementId: string): SchedulerPlanView {
  const plan = status.plans.find((candidate) => candidate.subscriptionId === `subscription:${requirementId}`);
  if (plan === undefined) throw new Error(`the patrol does not report the persisted plan for ${requirementId}`);
  return plan;
}

interface ConsumerJournalView {
  readonly kind: string | undefined;
  readonly commitId: string | undefined;
}

async function readConsumerJournal(harness: Harness, occurrenceId: string): Promise<readonly ConsumerJournalView[]> {
  const journalPath = join(
    harness.modeRoot,
    'occurrence-consumer',
    DurableOccurrenceConsumer.journalFileNameForOccurrence(occurrenceId),
  );
  const records = await new JsonlOrganJournal(journalPath).replay();
  return records.map((record) => ({ kind: record.kind, commitId: record.commitId }));
}

/**
 * The exact binding the production patrol must have claimed for a slot. It is
 * rebuilt here from the persisted plan identity plus the policy hash, so the
 * journal assertions cannot pass against a differently derived execution.
 */
function bindingFor(occurrenceId: string, policy: ExecutionPolicyDefinition, dueAt: string): OccurrenceTaskBinding {
  const parsed = /^(.*)::(\d+)::(\d+)$/.exec(occurrenceId);
  if (!parsed) throw new Error(`occurrence id is not well formed: ${occurrenceId}`);
  const identity = occurrenceExecutionIdentity(occurrenceId, executionPolicyHash(policy), dueAt);
  return {
    occurrenceId,
    subscriptionId: parsed[1]!,
    scheduleRevision: Number(parsed[2]),
    occurrenceOrdinal: Number(parsed[3]),
    taskId: identity.taskId,
    operationId: identity.operationId,
    executionEpoch: 1,
    inputArtifactDigest: identity.inputArtifactDigest,
  };
}

test('production patrol dispatches a scheduled occurrence only at its due time and settles it through the real runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-production-'));
  const startAt = new Date(Date.now() + 5_000).toISOString();
  const policy = scheduledPolicy(startAt);
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    const requirementId = await persistPlan(harness, 'run the scheduled production plan', policy);
    const occurrenceId = `subscription:${requirementId}::1::1`;

    // The plan is persisted and observable, but nothing may run before the due time.
    const before = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(before, requirementId).state, 'active');
    assert.equal(before.executed, 0);
    assert.equal(harness.port.starts.length, 0);

    // The patrol claims the slot inside the runtime's due-time grace window, and
    // the real execution still waits for the slot time.
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      const occurrence = planFor(status, requirementId).occurrences[0];
      assert.equal(occurrence?.state, 'claimed');
      assert.equal(occurrence?.occurrenceId, occurrenceId);
    }, 4_500);
    assert.ok(Date.now() < Date.parse(startAt), 'the claim must be observable before the due time');
    assert.equal(harness.port.starts.length, 0, 'no provider execution before startAt');

    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1, issueText(status));
    });
    const settledAt = Date.now();
    assert.ok(settledAt >= Date.parse(startAt), 'the occurrence settled no earlier than its due time');
    const settled = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    const settlement = planFor(settled, requirementId).settlements[0]!;
    assert.equal(settlement.verificationStatus, 'success');
    assert.equal(settlement.occurrenceId, occurrenceId);
    assert.equal(settled.executed, 1);
    assert.equal(harness.port.starts.length, 1, 'exactly one real provider execution');

    // The execution really ran through the coordinator for the deterministic
    // occurrence task, and its committed checkpoint is the success truth.
    const expectedBinding = bindingFor(occurrenceId, policy, startAt);
    const tasks = await harness.json<TaskListView>('/api/tasks');
    const scheduledTask = tasks.completed.find((task) => task.taskId.value === expectedBinding.taskId.value);
    assert.ok(scheduledTask, 'the deterministic occurrence task is completed in the public task list');
    const dashboard = await harness.json<TaskDashboardView>(
      `/api/tasks/${encodeURIComponent(expectedBinding.taskId.value)}/dashboard`,
    );
    assert.equal(dashboard.state, 'succeeded');
    assert.equal(dashboard.checkpoint?.outcome, 'succeeded');

    // Durability: one admission and one receipt for the binding.
    const journal = await readConsumerJournal(harness, occurrenceId);
    const admissionCommitId = await occurrenceExecutionAdmissionCommitId(expectedBinding);
    const receiptCommitId = await occurrenceTerminalReceiptCommitId(expectedBinding);
    assert.equal(journal.filter((record) => record.commitId === admissionCommitId).length, 1);
    assert.equal(journal.filter((record) => record.commitId === receiptCommitId).length, 1);
    assert.equal(journal.filter((record) => record.kind === 'checkpoint').length, 1);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('production patrol settles a non-success occurrence without weakening the success path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-production-blocked-'));
  const startAt = new Date(Date.now() + 500).toISOString();
  const policy = scheduledPolicy(startAt);
  const harness = await startHarness({ root, intervalMs: 250, replayTerminal: 'blocked' });
  try {
    const requirementId = await persistPlan(harness, 'run the blocked production plan', policy);
    const occurrenceId = `subscription:${requirementId}::1::1`;
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1);
    });
    const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(status, requirementId).settlements[0]!.verificationStatus, 'blocked');
    assert.equal(status.executed, 1);
    assert.equal(harness.port.starts.length, 1, 'the blocked occurrence still ran exactly one real execution');

    const expectedBinding = bindingFor(occurrenceId, policy, startAt);
    const dashboard = await harness.json<TaskDashboardView>(
      `/api/tasks/${encodeURIComponent(expectedBinding.taskId.value)}/dashboard`,
    );
    assert.equal(dashboard.state, 'blocked');
    assert.equal(dashboard.checkpoint?.outcome, 'blocked');
    const tasks = await harness.json<TaskListView>('/api/tasks');
    assert.equal(tasks.completed.length, 0, 'a blocked occurrence is never reported as a success');
    assert.equal(
      tasks.completed.length + tasks.failed.length + tasks.stopped.length + tasks.waiting.length + tasks.running.length,
      1,
    );
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('restart replays the settled occurrence and never dispatches a second execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-production-restart-'));
  const startAt = new Date(Date.now() + 500).toISOString();
  const policy = scheduledPolicy(startAt);
  const sharedPort = new CountingExecutionPort(new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }));
  const first = await startHarness({ root, intervalMs: 250, port: sharedPort });
  let requirementId = '';
  try {
    requirementId = await persistPlan(first, 'run the restart production plan', policy);
    await waitFor(async () => {
      const status = await first.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1);
    });
    assert.equal(sharedPort.starts.length, 1);
  } finally {
    await first.close();
  }
  assert.ok(requirementId !== '', 'the plan was persisted before the restart');

  const second = await startHarness({ root, intervalMs: 250, port: sharedPort, credentialKey: 'restart' });
  try {
    // A fresh process rebuilds the same plan and the same durable occurrence
    // journal, and must not dispatch the settled occurrence again.
    const status = await second.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(status, requirementId).settlements.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = await second.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(after, requirementId).settlements.length, 1);
    assert.equal(after.executed, 0);
    assert.equal(sharedPort.starts.length, 1, 'restart must not start a second provider execution');
    const occurrenceId = `subscription:${requirementId}::1::1`;
    const journal = await readConsumerJournal(second, occurrenceId);
    assert.equal(journal.filter((record) => record.kind === 'checkpoint').length, 1);
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a recurring plan executes more than one occurrence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-production-recurring-'));
  const startAt = new Date(Date.now() + 1_500).toISOString();
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    const requirementId = await persistPlan(harness, 'run the recurring production plan', recurringPolicy(startAt, 1));
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1);
    });
    // The next slot of a one-minute interval plan is one minute after startAt.
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 2);
    }, 90_000);
    const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    const plan = planFor(status, requirementId);
    assert.equal(plan.settlements.length, 2);
    assert.equal(new Set(plan.settlements.map((entry) => entry.occurrenceId)).size, 2, 'each occurrence settles once');
    assert.equal(status.executed, 2);
    assert.equal(harness.port.starts.length, 2, 'each occurrence is a separate real execution');
    assert.equal(plan.currentOccurrenceOrdinal, 2);
    for (const settlement of plan.settlements) {
      assert.equal(settlement.verificationStatus, 'success');
      const journal = await readConsumerJournal(harness, settlement.occurrenceId!);
      assert.equal(journal.filter((record) => record.kind === 'checkpoint').length, 1);
    }
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime started without a supervisor lease reports a typed fail-closed reason and dispatches nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-production-nolease-'));
  const startAt = new Date(Date.now() + 500).toISOString();
  const harness = await startHarness({ root, intervalMs: 250, leaseMode: 'unleased' });
  try {
    assert.equal(harness.runtime.scheduler, undefined, 'no patrol may run without a lease');
    const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(status.state, 'blocked');
    assert.equal(status.reason?.code, 'scheduler.lease.unavailable');
    await persistPlan(harness, 'run the unleased production plan', scheduledPolicy(startAt));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(harness.port.starts.length, 0, 'no execution without a lease');
    const after = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(after.reason?.code, 'scheduler.lease.unavailable');
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a busy runtime skips a due occurrence under busyPolicy skip and dispatches nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-production-busy-'));
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    // Occupy the runtime with a real running execution. The occupier is confirmed
    // through the same HTTP entry without an execution policy, so the implicit
    // consumer dispatches it and its provider start is held open.
    harness.port.hold();
    await persistPlan(harness, 'occupy the runtime with a running task', undefined);
    await waitFor(async () => {
      const tasks = await harness.json<TaskListView>('/api/tasks');
      assert.equal(tasks.running.length, 1, 'the occupier task is really running');
    });
    // The coordinator marks the task running before it calls the provider, so
    // wait for the held provider start instead of reading it immediately.
    await waitFor(async () => {
      assert.equal(harness.port.starts.length, 1, 'the occupier reached the provider');
    });

    // A scheduled plan becomes due while the runtime is busy. busyPolicy is skip.
    const startAt = new Date(Date.now() + 1_500).toISOString();
    const requirementId = await persistPlan(harness, 'run the busy production plan', scheduledPolicy(startAt));
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).occurrences[0]?.state, 'skipped-busy');
    });
    const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    const plan = planFor(status, requirementId);
    assert.equal(plan.settlements.length, 0, 'a skipped occurrence is never settled');
    assert.ok(status.skipped >= 1, 'the patrol recorded the skip decision');
    assert.equal(status.executed, 0, 'the patrol executed nothing for the busy plan');
    assert.equal(status.claimed, 0, 'a skipped occurrence is never claimed');
    assert.equal(harness.port.starts.length, 1, 'the busy plan dispatched no second execution');
  } finally {
    harness.port.release();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});
