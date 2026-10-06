// Shared black-box harness for the production scheduled-occurrence and plan
// control acceptance tests.
//
// Everything here drives the real public HTTP surface: the real runtime, the
// real supervisor lease, the real subscription control port, the real occurrence
// consumer and the real execution coordinator. Only the provider port is the
// fake replay runtime that the rest of the app test suite uses, because the real
// RCC provider path is exercised by the separate E2E entry. The wall clock is
// the production clock; nothing here injects or freezes time.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  id,
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

export const organId = id('organ', 'organ-scheduler-production');
export const binding: ProviderBinding = {
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

export function scheduledPolicy(startAt: string): ExecutionPolicyDefinition {
  return { ...policyBase, policyId: 'policy-scheduler-production-scheduled', executionMode: 'scheduled', startAt };
}

export function recurringPolicy(startAt: string, intervalMinutes: number): ExecutionPolicyDefinition {
  return {
    ...policyBase,
    policyId: 'policy-scheduler-production-recurring',
    executionMode: 'recurring',
    startAt,
    frequency: 'interval',
    intervalMinutes,
  };
}

export function requirementInterpreter(): ExplicitBrainInputInterpreter {
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
export class CountingExecutionPort implements ExecutionRuntimePort {
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

export interface SchedulerPlanView {
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

export interface SchedulerStatusView {
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

export function issueText(status: SchedulerStatusView): string {
  return status.issue === undefined ? 'no patrol issue' : `patrol issue ${status.issue.code}: ${status.issue.message}`;
}

export interface TaskListRow {
  readonly taskId: { readonly value: string };
  readonly state: string;
  readonly title: string;
}

export interface TaskListView {
  readonly running: readonly TaskListRow[];
  readonly completed: readonly TaskListRow[];
  readonly failed: readonly TaskListRow[];
  readonly stopped: readonly TaskListRow[];
  readonly waiting: readonly TaskListRow[];
}

export interface PlanProjectionView {
  readonly subscriptionId: string;
  readonly state: string;
  readonly executionMode: string;
  readonly nextDueAt?: string;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canCancelFuture: boolean;
}

export interface TaskDashboardView {
  readonly state: string;
  readonly checkpoint?: { readonly outcome: string };
  /** Absent when the task has no persisted plan. */
  readonly plan?: PlanProjectionView;
}

export interface ControlReceiptView {
  readonly subscriptionId: string;
  readonly action: string;
  readonly status: string;
  readonly policyRevision: number;
  readonly scheduleRevision: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly supersededUnclaimedOccurrences: readonly string[];
  readonly controlRef: string;
}

export interface Harness {
  readonly runtime: UiRuntime;
  readonly root: string;
  readonly port: CountingExecutionPort;
  readonly origin: string;
  readonly modeRoot: string;
  call(path: string, body?: unknown): Promise<Response>;
  json<T>(path: string): Promise<T>;
  close(): Promise<void>;
}

export async function startHarness(input: {
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
export async function persistPlan(
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

/** Submit one plan-scoped control request through the production route. */
export async function controlPlan(
  harness: Harness,
  subscriptionId: string,
  action: 'pause' | 'resume' | 'cancel-future',
  idempotencyKey: string,
): Promise<Response> {
  return harness.call(`/api/plans/${encodeURIComponent(subscriptionId)}/control`, {
    action,
    idempotencyKey,
    requestedAt: new Date().toISOString(),
  });
}

export async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 20_000): Promise<void> {
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

export function planFor(status: SchedulerStatusView, requirementId: string): SchedulerPlanView {
  const plan = status.plans.find((candidate) => candidate.subscriptionId === `subscription:${requirementId}`);
  if (plan === undefined) throw new Error(`the patrol does not report the persisted plan for ${requirementId}`);
  return plan;
}

export interface ConsumerJournalView {
  readonly kind: string | undefined;
  readonly commitId: string | undefined;
}

export async function readConsumerJournal(harness: Harness, occurrenceId: string): Promise<readonly ConsumerJournalView[]> {
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
export function bindingFor(occurrenceId: string, policy: ExecutionPolicyDefinition, dueAt: string): OccurrenceTaskBinding {
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
