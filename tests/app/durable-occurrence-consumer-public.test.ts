// Public durable occurrence consumer acceptance harness.
//
// The cases drive the real DurableOccurrenceConsumer entry over real on-disk
// JsonlOrganJournal/FileCheckpointStore files and a real SupervisorLease. The
// dispatch port performs a real file side effect. Cross-process cases use real
// OS child processes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureControlLayout, resolveRuntimePaths, type RuntimePaths } from '../../packages/config/src/index.js';
import { acquireDaemonLease, readDaemonLease, type SupervisorLease } from '../../packages/app/src/supervisor/index.js';
import {
  DurableOccurrenceConsumer,
  DurableOccurrenceConsumerError,
  type OccurrenceDispatchInput,
  type OccurrenceDispatchPort,
  type OccurrenceTerminalProduction,
} from '../../packages/app/src/ui-runtime/occurrence-consumer.js';
import { FileCheckpointStore } from '../../packages/app/src/ui-runtime/index.js';
import {
  JsonlOrganJournal,
  JournalCommitConflictError,
  type JournalRecord,
} from '../../packages/adapters/jsonl/src/index.js';
import {
  id,
  occurrenceTerminalReceiptCommitId,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionPolicyDefinition,
  type Occurrence,
  type OccurrenceTaskBinding,
  type ScopeRef,
  type ServeTaskTerminalReceipt,
  type TaskCheckEvidence,
  type TaskVerificationResult,
  type TaskVerificationStatus,
} from '../../packages/contracts/src/index.js';
import { executionPolicyHash } from '../../packages/core/src/subscription.js';
import type { OccurrenceClaimRecord } from '../../packages/runtime/src/subscriptions/ports.js';

type ChildProcess = ReturnType<typeof spawn>;

const configModule = new URL('../../packages/config/src/index.js', import.meta.url).href;
const supervisorModule = new URL('../../packages/app/src/supervisor/index.js', import.meta.url).href;
const consumerModule = new URL('../../packages/app/src/ui-runtime/occurrence-consumer.js', import.meta.url).href;
const journalModule = new URL('../../packages/adapters/jsonl/src/index.js', import.meta.url).href;
const checkpointStoreModule = new URL('../../packages/app/src/ui-runtime/index.js', import.meta.url).href;

const ORGAN_ID = id('organ', 'organ-durable-consumer-public');
const POLICY: ExecutionPolicyDefinition = {
  policyId: 'policy-durable-consumer',
  policyRevision: 1,
  timezone: 'UTC',
  canonicalInstant: '2026-10-05T00:00:00.000Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'run-once',
  busyPolicy: 'skip',
  executionMode: 'once',
  dueAt: '2026-10-05T00:00:00.000Z',
};

interface Fixture {
  readonly root: string;
  readonly paths: RuntimePaths;
  cleanup(): Promise<void>;
}

// Test-only hook for proving that cleanup failures fail the public suite.
const INJECT_LEASE_RELEASE_FAILURE =
  process.env.HUMANAGENT_PUBLIC_TEST_INJECT_LEASE_RELEASE_FAILURE === '1';

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-durable-consumer-'));
  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  };
  try {
    const controlRoot = join(root, 'control');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const paths = await resolveRuntimePaths({ controlRoot, workspace });
    await ensureControlLayout(paths);
    return { root, paths, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture setup and cleanup failed');
    }
    throw error;
  }
}

async function releaseLease(lease: SupervisorLease): Promise<void> {
  if (INJECT_LEASE_RELEASE_FAILURE) {
    throw new Error('injected public harness lease release failure');
  }
  await lease.release();
}

function releaseOnce(lease: SupervisorLease): () => Promise<void> {
  let release: Promise<void> | undefined;
  return () => {
    release ??= releaseLease(lease);
    return release;
  };
}

async function runCleanups(...cleanups: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'durable occurrence public harness cleanup failed');
  }
}

async function cleanupFixture(fx: Fixture | undefined, release?: () => Promise<void>): Promise<void> {
  await runCleanups(
    async () => {
      if (release !== undefined) await release();
    },
    async () => {
      if (fx !== undefined) await fx.cleanup();
    },
  );
}

function bindingFor(suffix: string, overrides: Partial<OccurrenceTaskBinding> = {}): OccurrenceTaskBinding {
  const subscriptionId = `subscription-${suffix}`;
  const scheduleRevision = 1;
  const occurrenceOrdinal = 1;
  return {
    occurrenceId: `${subscriptionId}::${scheduleRevision}::${occurrenceOrdinal}`,
    subscriptionId,
    scheduleRevision,
    occurrenceOrdinal,
    taskId: id('task', `task-${suffix}`),
    operationId: id('operation', `operation-${suffix}`),
    executionEpoch: 1,
    inputArtifactDigest: `sha256:input-${suffix}`,
    ...overrides,
  };
}

function scopeFor(binding: OccurrenceTaskBinding): ScopeRef {
  return {
    organId: ORGAN_ID,
    taskId: binding.taskId,
    cycleId: id('cycle', `cycle-${binding.taskId.value}`),
    operationId: binding.operationId,
  };
}

function journalPathFor(paths: RuntimePaths, binding: OccurrenceTaskBinding): string {
  return join(paths.journalRoot, `task-${binding.taskId.value}-cycle-cycle-${binding.taskId.value}.jsonl`);
}

function occurrenceFor(binding: OccurrenceTaskBinding, overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    occurrenceId: binding.occurrenceId,
    subscriptionId: binding.subscriptionId,
    scheduleRevision: binding.scheduleRevision,
    occurrenceOrdinal: binding.occurrenceOrdinal,
    state: 'due',
    dueAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

function claimFor(binding: OccurrenceTaskBinding, overrides: Partial<OccurrenceClaimRecord> = {}): OccurrenceClaimRecord {
  return {
    occurrenceId: binding.occurrenceId,
    subscriptionId: binding.subscriptionId,
    scheduleRevision: binding.scheduleRevision,
    occurrenceOrdinal: binding.occurrenceOrdinal,
    claimedBy: 'scheduler-durable-consumer-test',
    leaseId: 'scheduler-lease-1',
    schedulerInstanceId: 'scheduler-instance-1',
    generation: 1,
    executionEpoch: binding.executionEpoch,
    acquiredAt: '2026-10-05T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    policyRevision: POLICY.policyRevision,
    policyHash: executionPolicyHash(POLICY),
    policy: POLICY,
    taskId: binding.taskId,
    operationId: binding.operationId,
    inputArtifactDigest: binding.inputArtifactDigest,
    ...overrides,
  };
}

function evidenceFor(binding: OccurrenceTaskBinding, scope: ScopeRef, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `durable-consumer-${label}-${binding.operationId.value}`),
    kind: 'operation',
    source: 'humanagent.tests.durable-consumer',
    locator: `test://durable-consumer/${label}/${encodeURIComponent(binding.occurrenceId)}`,
    digest: `sha256:${label}-${binding.operationId.value}`,
    scope,
  };
}

function successCheck(binding: OccurrenceTaskBinding, evidence: EvidenceRef): TaskCheckEvidence {
  return {
    checkId: 'check-terminal',
    kind: 'native',
    status: 'succeeded',
    decisionRef: 'task-verification/v1:terminal',
    decisionDigest: 'sha256:terminal-check',
    artifactDigests: [binding.inputArtifactDigest],
    evidenceRefs: [evidence],
  };
}

function verificationFor(
  binding: OccurrenceTaskBinding,
  status: TaskVerificationStatus,
  evidence: EvidenceRef,
): TaskVerificationResult {
  const base = {
    taskId: binding.taskId,
    operationId: binding.operationId,
    executionEpoch: binding.executionEpoch,
    attempt: 1,
    inputArtifactDigest: binding.inputArtifactDigest,
    policyRef: 'task-verification/v1:policy-durable-consumer',
    policyDigest: 'sha256:policy-durable-consumer',
    status,
    checks: [] as readonly TaskCheckEvidence[],
    evidenceRefs: [evidence],
  } satisfies TaskVerificationResult;
  if (status === 'success') {
    return { ...base, checks: [successCheck(binding, evidence)] };
  }
  if (status === 'rejected') {
    return { ...base, rejectionCode: 'checker-rejected' };
  }
  return base;
}

function checkpointOutcomeFor(status: TaskVerificationStatus): Checkpoint['outcome'] {
  if (status === 'success') return 'succeeded';
  if (status === 'failed' || status === 'rejected') return 'failed';
  if (status === 'missing' || status === 'blocked') return 'blocked';
  return 'cancelled';
}

function terminalProduction(
  binding: OccurrenceTaskBinding,
  scope: ScopeRef,
  status: TaskVerificationStatus,
): OccurrenceTerminalProduction {
  const evidence = evidenceFor(binding, scope, `terminal-${status}`);
  const outcome = checkpointOutcomeFor(status);
  const nextKind = outcome === 'succeeded' ? 'continue' : outcome === 'cancelled' ? 'stop' : 'recover';
  const checkpoint: Checkpoint = {
    id: id('checkpoint', `terminal-${binding.operationId.value}`),
    scope,
    cycleId: scope.cycleId as NonNullable<ScopeRef['cycleId']>,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: binding.executionEpoch,
    outcome,
    summary: `terminal ${status}`,
    recoveryStateRef: evidence,
    evidenceRefs: [evidence],
    next: { kind: nextKind, ref: evidence.locator },
  };
  return {
    checkpoint,
    verification: verificationFor(binding, status, evidence),
    settlementReceiptRef: `occurrence-settlement/v1:${binding.operationId.value}:${binding.executionEpoch}`,
    ...(outcome === 'succeeded'
      ? {}
      : {
          recoveryResponsibility: {
            providerEffectState: 'confirmed-released' as const,
            resourceInventory: [evidence],
            releaseProofs: [evidence],
          },
        }),
  };
}

function countingDispatch(
  run: (input: OccurrenceDispatchInput) => Promise<OccurrenceTerminalProduction>,
): { readonly port: OccurrenceDispatchPort; count(): number } {
  let count = 0;
  return {
    port: {
      async dispatch(input) {
        count += 1;
        return run(input);
      },
    },
    count: () => count,
  };
}

function consumerFor(options: {
  readonly lease: SupervisorLease;
  readonly scope: ScopeRef;
  readonly journalPath: string;
  readonly dispatch: OccurrenceDispatchPort;
  readonly journal?: JsonlOrganJournal;
}): DurableOccurrenceConsumer {
  return new DurableOccurrenceConsumer({
    lease: options.lease,
    scope: options.scope,
    journal: options.journal ?? new JsonlOrganJournal(options.journalPath),
    checkpoints: new FileCheckpointStore(options.journalPath),
    dispatch: options.dispatch,
  });
}

async function replayJournal(path: string): Promise<readonly JournalRecord[]> {
  return new JsonlOrganJournal(path).replay();
}

async function runChild(script: string): Promise<{
  readonly pid: number | undefined;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk); });
  const { code } = await new Promise<{ code: number | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve({ code: exitCode }));
  });
  return { pid: child.pid, code, stdout, stderr };
}

function startChild(script: string): { readonly child: ChildProcess; readonly line: Promise<string> } {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk); });
  const line = new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (chunk: unknown) => {
      stdout += String(chunk);
      const newline = stdout.indexOf('\n');
      if (newline >= 0) resolve(stdout.slice(0, newline));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`child exited before ready: ${code}; stderr=${stderr}`)));
  });
  return { child, line };
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForExit(child);
}

function childInputs(input: {
  readonly paths: RuntimePaths;
  readonly journalPath: string;
  readonly scope: ScopeRef;
  readonly binding: OccurrenceTaskBinding;
  readonly occurrence: Occurrence;
  readonly claim: OccurrenceClaimRecord;
  readonly ownerId: string;
}): string {
  return JSON.stringify({
    controlRoot: input.paths.controlRoot,
    workspace: input.paths.workspaceCwd,
    journalPath: input.journalPath,
    scope: input.scope,
    binding: input.binding,
    occurrence: input.occurrence,
    policy: POLICY,
    claim: input.claim,
    ownerId: input.ownerId,
  });
}

test('first admission dispatches exactly once and commits a paired checkpoint + typed receipt', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    fx = await fixture();
    const lease = await acquireDaemonLease(fx.paths, { ownerId: 'durable-consumer-A' });
    release = releaseOnce(lease);
    const binding = bindingFor('success');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const sideEffect = join(fx.root, 'dispatch-side-effect.json');
    const counter = countingDispatch(async ({ owner, binding: dispatched }) => {
      await writeFile(sideEffect, `${JSON.stringify({ owner, occurrenceId: dispatched.occurrenceId })}\n`, 'utf8');
      return terminalProduction(dispatched, scope, 'success');
    });
    const consumer = consumerFor({ lease, scope, journalPath, dispatch: counter.port });

    const first = await consumer.executeOccurrence({
      occurrence: occurrenceFor(binding),
      policy: POLICY,
      claim: claimFor(binding),
      binding,
    });

    assert.equal(counter.count(), 1);
    assert.equal(first.verification.status, 'success');
    assert.equal(
      first.terminalCheckpointRef,
      `checkpoint:${ORGAN_ID.value}:${binding.taskId.value}:cycle-${binding.taskId.value}:${binding.operationId.value}:terminal-${binding.operationId.value}`,
    );
    assert.equal(existsSync(sideEffect), true);
    assert.deepEqual(JSON.parse(await readFile(sideEffect, 'utf8')), {
      owner: {
        daemonLeaseId: lease.record.leaseId,
        daemonGeneration: lease.record.generation,
        processStartToken: lease.record.processStartToken,
      },
      occurrenceId: binding.occurrenceId,
    });

    const records = await replayJournal(journalPath);
    assert.equal(records.filter((record) => record.kind === 'checkpoint').length, 1);
    assert.equal(records.filter((record) => record.payload?.kind === 'occurrence-terminal-receipt').length, 1);
    const admissions = records.filter((record) => record.payload?.kind === 'occurrence-execution-admission');
    assert.equal(admissions.length, 1);
    assert.equal(
      (admissions[0]!.payload as { admittedExecutionOwner: { daemonLeaseId: string } }).admittedExecutionOwner.daemonLeaseId,
      lease.record.leaseId,
    );
  } finally {
    await cleanupFixture(fx, release);
  }
});

test('a mismatched requested occurrence cannot mutate or dispatch against the authoritative claim', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    fx = await fixture();
    const lease = await acquireDaemonLease(fx.paths, { ownerId: 'durable-consumer-A' });
    release = releaseOnce(lease);
    const binding = bindingFor('authoritative-mismatch');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const counter = countingDispatch(async () => {
      throw new Error('mismatched request must not dispatch');
    });
    const consumer = consumerFor({ lease, scope, journalPath, dispatch: counter.port });
    const mismatchedOccurrence = occurrenceFor(binding, {
      occurrenceOrdinal: 2,
      occurrenceId: `${binding.subscriptionId}::${binding.scheduleRevision}::2`,
    });

    await assert.rejects(
      () => consumer.executeOccurrence({
        occurrence: mismatchedOccurrence,
        policy: POLICY,
        claim: claimFor(binding),
        binding,
      }),
      (error: unknown) => error instanceof DurableOccurrenceConsumerError && error.code === 'invalid-binding',
    );
    assert.equal(counter.count(), 0);
    assert.equal(existsSync(journalPath), false);
  } finally {
    await cleanupFixture(fx, release);
  }
});

test('replay on the same port, a new port, and a new OS process never dispatches again', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  let committed: ServeTaskTerminalReceipt | undefined;
  try {
    fx = await fixture();
    const binding = bindingFor('replay');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const lease = await acquireDaemonLease(fx.paths, { ownerId: 'durable-consumer-A' });
    release = releaseOnce(lease);
    const counter = countingDispatch(async ({ binding: dispatched }) => terminalProduction(dispatched, scope, 'success'));
    const consumer = consumerFor({ lease, scope, journalPath, dispatch: counter.port });
    committed = await consumer.executeOccurrence({
      occurrence: occurrenceFor(binding),
      policy: POLICY,
      claim: claimFor(binding),
      binding,
    });
    assert.equal(counter.count(), 1);

    const samePort = await consumer.executeOccurrence({
      occurrence: occurrenceFor(binding),
      policy: POLICY,
      claim: claimFor(binding),
      binding,
    });
    assert.equal(counter.count(), 1);
    assert.deepEqual(samePort, committed);

    const second = consumerFor({ lease, scope, journalPath, dispatch: counter.port });
    const newPort = await second.executeOccurrence({
      occurrence: occurrenceFor(binding),
      policy: POLICY,
      claim: claimFor(binding),
      binding,
    });
    assert.equal(counter.count(), 1);
    assert.deepEqual(newPort, committed);

    await release();
    const inputs = join(fx.root, 'replay-inputs.json');
    await writeFile(inputs, childInputs({
      paths: fx.paths,
      journalPath,
      scope,
      binding,
      occurrence: occurrenceFor(binding),
      claim: claimFor(binding),
      ownerId: 'durable-consumer-B',
    }), 'utf8');
    const result = await runChild(`
      import { readFile } from 'node:fs/promises';
      import { resolveRuntimePaths } from ${JSON.stringify(configModule)};
      import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
      import { DurableOccurrenceConsumer } from ${JSON.stringify(consumerModule)};
      import { JsonlOrganJournal } from ${JSON.stringify(journalModule)};
      import { FileCheckpointStore } from ${JSON.stringify(checkpointStoreModule)};
      const input = JSON.parse(await readFile(${JSON.stringify(inputs)}, 'utf8'));
      const paths = await resolveRuntimePaths({ controlRoot: input.controlRoot, workspace: input.workspace });
      const lease = await acquireDaemonLease(paths, { ownerId: input.ownerId });
      let dispatches = 0;
      const consumer = new DurableOccurrenceConsumer({
        lease,
        scope: input.scope,
        journal: new JsonlOrganJournal(input.journalPath),
        checkpoints: new FileCheckpointStore(input.journalPath),
        dispatch: { async dispatch() { dispatches += 1; throw new Error('replay must not dispatch'); } },
      });
      const receipt = await consumer.executeOccurrence({ occurrence: input.occurrence, policy: input.policy, claim: input.claim, binding: input.binding });
      await lease.release();
      console.log(JSON.stringify({ dispatches, receipt }));
    `);
    assert.equal(result.code, 0, result.stderr);
    const observed = JSON.parse(result.stdout.trim()) as { readonly dispatches: number; readonly receipt: ServeTaskTerminalReceipt };
    assert.equal(observed.dispatches, 0);
    assert.deepEqual(observed.receipt, committed);
  } finally {
    await cleanupFixture(fx, release);
  }
});

test('admission append failure leaves no admission and dispatches zero times', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    fx = await fixture();
    const lease = await acquireDaemonLease(fx.paths, { ownerId: 'durable-consumer-A' });
    release = releaseOnce(lease);
    const binding = bindingFor('admission-failure');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const counter = countingDispatch(async ({ binding: dispatched }) => terminalProduction(dispatched, scope, 'success'));
    class FailingAdmissionJournal extends JsonlOrganJournal {
      override async transaction<T, R>(
        read: (context: any) => T | Promise<T>,
        apply: (input: T, append: any) => Promise<R>,
      ): Promise<R> {
        return super.transaction(read, async (input, append) => apply(input, async () => {
          throw new Error('simulated admission append failure');
        }));
      }
    }
    const consumer = consumerFor({
      lease,
      scope,
      journalPath,
      dispatch: counter.port,
      journal: new FailingAdmissionJournal(journalPath),
    });

    await assert.rejects(
      () => consumer.executeOccurrence({ occurrence: occurrenceFor(binding), policy: POLICY, claim: claimFor(binding), binding }),
      /simulated admission append failure/,
    );
    assert.equal(counter.count(), 0);
    assert.equal((await replayJournal(journalPath)).length, 0);
  } finally {
    await cleanupFixture(fx, release);
  }
});

test('receipt append failure stays durable-unverified-recovery-pending and never verified success', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    fx = await fixture();
    const lease = await acquireDaemonLease(fx.paths, { ownerId: 'durable-consumer-A' });
    release = releaseOnce(lease);
    const binding = bindingFor('receipt-failure');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const receiptCommitId = await occurrenceTerminalReceiptCommitId(binding);
    const counter = countingDispatch(async ({ binding: dispatched }) => terminalProduction(dispatched, scope, 'success'));
    class FailingReceiptJournal extends JsonlOrganJournal {
      override async append(input: Parameters<JsonlOrganJournal['append']>[0]) {
        if (input.commitId === receiptCommitId) throw new Error('simulated receipt append failure');
        return super.append(input);
      }
    }
    const consumer = consumerFor({
      lease,
      scope,
      journalPath,
      dispatch: counter.port,
      journal: new FailingReceiptJournal(journalPath),
    });

    await assert.rejects(
      () => consumer.executeOccurrence({ occurrence: occurrenceFor(binding), policy: POLICY, claim: claimFor(binding), binding }),
      /simulated receipt append failure/,
    );
    assert.equal(counter.count(), 1);
    const records = await replayJournal(journalPath);
    assert.equal(records.filter((record) => record.kind === 'checkpoint').length, 1);
    assert.equal(records.filter((record) => record.payload?.kind === 'occurrence-terminal-receipt').length, 0);

    await assert.rejects(
      () => consumer.executeOccurrence({ occurrence: occurrenceFor(binding), policy: POLICY, claim: claimFor(binding), binding }),
      (error: unknown) => error instanceof DurableOccurrenceConsumerError
        && error.code === 'durable-unverified-recovery-pending',
    );
    assert.equal(counter.count(), 1);
  } finally {
    await cleanupFixture(fx, release);
  }
});

test('a different receipt fact under the same binding key is rejected by the journal', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    fx = await fixture();
    const lease = await acquireDaemonLease(fx.paths, { ownerId: 'durable-consumer-A' });
    release = releaseOnce(lease);
    const binding = bindingFor('conflict');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const counter = countingDispatch(async ({ binding: dispatched }) => terminalProduction(dispatched, scope, 'success'));
    const consumer = consumerFor({ lease, scope, journalPath, dispatch: counter.port });
    const committed = await consumer.executeOccurrence({
      occurrence: occurrenceFor(binding),
      policy: POLICY,
      claim: claimFor(binding),
      binding,
    });
    assert.equal(counter.count(), 1);

    const receiptCommitId = await occurrenceTerminalReceiptCommitId(binding);
    const records = await replayJournal(journalPath);
    const existing = records.find((record) => record.commitId === receiptCommitId);
    if (existing === undefined || existing.payload === undefined) {
      throw new Error('expected an existing receipt record');
    }
    const conflicting = structuredClone(existing.payload) as Record<string, unknown>;
    (conflicting.verification as Record<string, unknown>).evidenceRefs = [];

    await assert.rejects(
      () => new JsonlOrganJournal(journalPath).append({
        commitId: receiptCommitId,
        kind: 'event',
        scope,
        payload: conflicting,
      }),
      (error: unknown) => error instanceof JournalCommitConflictError,
    );
    assert.equal((await replayJournal(journalPath)).filter((record) => record.commitId === receiptCommitId).length, 1);
    const replayed = await consumer.executeOccurrence({
      occurrence: occurrenceFor(binding),
      policy: POLICY,
      claim: claimFor(binding),
      binding,
    });
    assert.equal(counter.count(), 1);
    assert.deepEqual(replayed, committed);
  } finally {
    await cleanupFixture(fx, release);
  }
});

test('a second process cannot turn copied readable owner fields into authority and writes nothing', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    fx = await fixture();
    const binding = bindingFor('copied-identity');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const lease = await acquireDaemonLease(fx.paths, { ownerId: 'durable-consumer-A' });
    release = releaseOnce(lease);
    const inputs = join(fx.root, 'copied-inputs.json');
    await writeFile(inputs, childInputs({
      paths: fx.paths,
      journalPath,
      scope,
      binding,
      occurrence: occurrenceFor(binding),
      claim: claimFor(binding),
      ownerId: 'durable-consumer-B',
    }), 'utf8');
    const result = await runChild(`
      import { readFile } from 'node:fs/promises';
      import { resolveRuntimePaths } from ${JSON.stringify(configModule)};
      import { acquireDaemonLease, readDaemonLease } from ${JSON.stringify(supervisorModule)};
      const input = JSON.parse(await readFile(${JSON.stringify(inputs)}, 'utf8'));
      const paths = await resolveRuntimePaths({ controlRoot: input.controlRoot, workspace: input.workspace });
      const copied = await readDaemonLease(paths);
      let acquireCode = null;
      try {
        const stolen = await acquireDaemonLease(paths, { ownerId: input.ownerId });
        await stolen.release();
      } catch (error) {
        acquireCode = error?.code ?? error?.message;
      }
      console.log(JSON.stringify({
        acquireCode,
        readableLeaseId: copied?.leaseId,
        readableGeneration: copied?.generation,
        readableToken: copied?.processStartToken,
      }));
    `);
    assert.equal(result.code, 0, result.stderr);
    const observed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(observed.acquireCode, 'daemon-lease-owned');
    assert.equal(observed.readableLeaseId, lease.record.leaseId);
    assert.equal(observed.readableGeneration, lease.record.generation);
    assert.equal(observed.readableToken, lease.record.processStartToken);
    assert.equal(existsSync(journalPath), false);
    const durable = await readDaemonLease(fx.paths);
    assert.equal(durable?.leaseId, lease.record.leaseId);
  } finally {
    await cleanupFixture(fx, release);
  }
});

test('a crashed owner is replaced and the committed replacement writes one blocked recovery without redispatch or rebind', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    fx = await fixture();
    const binding = bindingFor('crash-recovery');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const inputs = join(fx.root, 'crash-inputs.json');
    const dispatched = join(fx.root, 'crash-dispatch-started');
    await writeFile(inputs, childInputs({
      paths: fx.paths,
      journalPath,
      scope,
      binding,
      occurrence: occurrenceFor(binding),
      claim: claimFor(binding),
      ownerId: 'durable-consumer-A',
    }), 'utf8');
    const child = await runChild(`
      import { readFile, writeFile } from 'node:fs/promises';
      import { resolveRuntimePaths } from ${JSON.stringify(configModule)};
      import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
      import { DurableOccurrenceConsumer } from ${JSON.stringify(consumerModule)};
      import { JsonlOrganJournal } from ${JSON.stringify(journalModule)};
      import { FileCheckpointStore } from ${JSON.stringify(checkpointStoreModule)};
      const input = JSON.parse(await readFile(${JSON.stringify(inputs)}, 'utf8'));
      const paths = await resolveRuntimePaths({ controlRoot: input.controlRoot, workspace: input.workspace });
      const lease = await acquireDaemonLease(paths, { ownerId: input.ownerId });
      const consumer = new DurableOccurrenceConsumer({
        lease,
        scope: input.scope,
        journal: new JsonlOrganJournal(input.journalPath),
        checkpoints: new FileCheckpointStore(input.journalPath),
        dispatch: {
          async dispatch() {
            await writeFile(${JSON.stringify(dispatched)}, 'started\\n', 'utf8');
            process.exit(9);
          },
        },
      });
      await consumer.executeOccurrence({ occurrence: input.occurrence, policy: input.policy, claim: input.claim, binding: input.binding });
    `);
    assert.equal(child.code, 9, child.stderr);
    assert.equal(existsSync(dispatched), true);

    const admissionRecords = (await replayJournal(journalPath)).filter((record) => record.payload?.kind === 'occurrence-execution-admission');
    assert.equal(admissionRecords.length, 1);
    const ownerA = (admissionRecords[0]!.payload as { admittedExecutionOwner: Record<string, unknown> }).admittedExecutionOwner;
    assert.ok(ownerA.daemonLeaseId);

    const acquired = await acquireDaemonLease(fx.paths, {
      ownerId: 'durable-consumer-B',
      takeover: { reason: 'owner A crashed after admission without committing a terminal receipt' },
    });
    release = releaseOnce(acquired);
    assert.equal(acquired.record.generation, Number(ownerA.daemonGeneration) + 1);
    assert.equal(acquired.record.takeover?.previousLeaseId, ownerA.daemonLeaseId);

    const counter = countingDispatch(async () => {
      throw new Error('recovery must not dispatch');
    });
    const consumer = consumerFor({ lease: acquired, scope, journalPath, dispatch: counter.port });
    const recovered = await consumer.executeOccurrence({
      occurrence: occurrenceFor(binding),
      policy: POLICY,
      claim: claimFor(binding),
      binding,
    });
    assert.equal(counter.count(), 0);
    assert.equal(recovered.verification.status, 'blocked');
    const records = await replayJournal(journalPath);
    const admissionAfter = records.filter((record) => record.payload?.kind === 'occurrence-execution-admission');
    assert.equal(admissionAfter.length, 1);
    assert.deepEqual(
      (admissionAfter[0]!.payload as { admittedExecutionOwner: unknown }).admittedExecutionOwner,
      ownerA,
    );
    const receiptRecord = records.find((record) => record.payload?.kind === 'occurrence-terminal-receipt');
    assert.ok(receiptRecord);
    const recovery = (receiptRecord!.payload as {
      recoveryResponsibility?: { providerEffectState: string; resourceInventory: readonly unknown[] };
    }).recoveryResponsibility;
    assert.equal(recovery?.providerEffectState, 'possible');
    assert.ok((recovery?.resourceInventory.length ?? 0) >= 1);
  } finally {
    await cleanupFixture(fx, release);
  }
});

test('live stale A after a committed replacement cannot write, and B recovers without rebind or dispatch', async () => {
  let fx: Fixture | undefined;
  let releaseAcquired: (() => Promise<void>) | undefined;
  let child: ChildProcess | undefined;
  try {
    fx = await fixture();
    const binding = bindingFor('stale-a');
    const scope = scopeFor(binding);
    const journalPath = journalPathFor(fx.paths, binding);
    const inputs = join(fx.root, 'stale-a-inputs.json');
    const dispatched = join(fx.root, 'stale-a-dispatch-started');
    const release = join(fx.root, 'stale-a-release');
    const resultPath = join(fx.root, 'stale-a-result.json');
    await writeFile(inputs, childInputs({
      paths: fx.paths,
      journalPath,
      scope,
      binding,
      occurrence: occurrenceFor(binding),
      claim: claimFor(binding),
      ownerId: 'durable-consumer-A',
    }), 'utf8');
    const started = startChild(`
      import { existsSync } from 'node:fs';
      import { readFile, writeFile } from 'node:fs/promises';
      import { resolveRuntimePaths } from ${JSON.stringify(configModule)};
      import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
      import { DurableOccurrenceConsumer } from ${JSON.stringify(consumerModule)};
      import { JsonlOrganJournal } from ${JSON.stringify(journalModule)};
      import { FileCheckpointStore } from ${JSON.stringify(checkpointStoreModule)};
      const input = JSON.parse(await readFile(${JSON.stringify(inputs)}, 'utf8'));
      const paths = await resolveRuntimePaths({ controlRoot: input.controlRoot, workspace: input.workspace });
      const lease = await acquireDaemonLease(paths, { ownerId: input.ownerId });
      console.log(JSON.stringify({ pid: process.pid, leaseId: lease.record.leaseId }));
      const evidence = {
        evidenceId: { scope: 'evidence', value: 'stale-a-terminal' },
        kind: 'operation',
        source: 'humanagent.tests.durable-consumer',
        locator: 'test://durable-consumer/stale-a/terminal',
        digest: 'sha256:stale-a-terminal',
        scope: input.scope,
      };
      const consumer = new DurableOccurrenceConsumer({
        lease,
        scope: input.scope,
        journal: new JsonlOrganJournal(input.journalPath),
        checkpoints: new FileCheckpointStore(input.journalPath),
        dispatch: {
          async dispatch({ binding: dispatchedBinding }) {
            await writeFile(${JSON.stringify(dispatched)}, 'started\\n', 'utf8');
            while (!existsSync(${JSON.stringify(release)})) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            return {
              checkpoint: {
                id: { scope: 'checkpoint', value: 'terminal-' + dispatchedBinding.operationId.value },
                scope: input.scope,
                cycleId: input.scope.cycleId,
                seq: 1,
                previousCheckpointId: null,
                directiveRevision: 1,
                executionEpoch: dispatchedBinding.executionEpoch,
                outcome: 'succeeded',
                summary: 'terminal success',
                recoveryStateRef: evidence,
                evidenceRefs: [evidence],
                next: { kind: 'continue', ref: evidence.locator },
              },
              verification: {
                taskId: dispatchedBinding.taskId,
                operationId: dispatchedBinding.operationId,
                executionEpoch: dispatchedBinding.executionEpoch,
                attempt: 1,
                inputArtifactDigest: dispatchedBinding.inputArtifactDigest,
                policyRef: 'task-verification/v1:policy-durable-consumer',
                policyDigest: 'sha256:policy-durable-consumer',
                status: 'success',
                checks: [{
                  checkId: 'check-terminal',
                  kind: 'native',
                  status: 'succeeded',
                  decisionRef: 'task-verification/v1:terminal',
                  decisionDigest: 'sha256:terminal-check',
                  artifactDigests: [dispatchedBinding.inputArtifactDigest],
                  evidenceRefs: [evidence],
                }],
                evidenceRefs: [evidence],
              },
              settlementReceiptRef: 'occurrence-settlement/v1:' + dispatchedBinding.operationId.value + ':' + dispatchedBinding.executionEpoch,
            };
          },
        },
      });
      let code = null;
      try {
        await consumer.executeOccurrence({ occurrence: input.occurrence, policy: input.policy, claim: input.claim, binding: input.binding });
        code = 'committed';
      } catch (error) {
        code = error?.code ?? error?.message;
      }
      await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ code }) + '\\n', 'utf8');
    `);
    child = started.child;
    const ready = JSON.parse(await started.line) as { readonly pid: number; readonly leaseId: string };
    await waitForFile(dispatched);

    const acquired = await acquireDaemonLease(fx.paths, {
      ownerId: 'durable-consumer-B',
      takeover: { reason: 'supported takeover while stale A is still alive', allowed: () => true },
    });
    releaseAcquired = releaseOnce(acquired);
    assert.equal(acquired.record.generation, 2);
    assert.equal(acquired.record.takeover?.previousLeaseId, ready.leaseId);

    await writeFile(release, 'release\n', 'utf8');
    await waitForExit(child);
    const observed = JSON.parse(await readFile(resultPath, 'utf8')) as { readonly code: string };
    assert.equal(observed.code, 'daemon-lease-stale');
    assert.equal(existsSync(dispatched), true);

    const beforeRecovery = await replayJournal(journalPath);
    assert.equal(beforeRecovery.filter((record) => record.payload?.kind === 'occurrence-terminal-receipt').length, 0);
    const ownerA = (beforeRecovery.find((record) => record.payload?.kind === 'occurrence-execution-admission')!.payload as {
      admittedExecutionOwner: Record<string, unknown>;
    }).admittedExecutionOwner;

    const counter = countingDispatch(async () => {
      throw new Error('recovery must not dispatch');
    });
    const consumer = consumerFor({ lease: acquired, scope, journalPath, dispatch: counter.port });
    const recovered = await consumer.executeOccurrence({
      occurrence: occurrenceFor(binding),
      policy: POLICY,
      claim: claimFor(binding),
      binding,
    });
    assert.equal(counter.count(), 0);
    assert.equal(recovered.verification.status, 'blocked');

    const after = await replayJournal(journalPath);
    assert.equal(after.filter((record) => record.payload?.kind === 'occurrence-execution-admission').length, 1);
    assert.deepEqual(
      (after.find((record) => record.payload?.kind === 'occurrence-execution-admission')!.payload as {
        admittedExecutionOwner: unknown;
      }).admittedExecutionOwner,
      ownerA,
    );
    assert.equal(after.filter((record) => record.payload?.kind === 'occurrence-terminal-receipt').length, 1);
  } finally {
    await runCleanups(
      async () => {
        if (child !== undefined) await stopChild(child);
      },
      async () => {
        if (releaseAcquired !== undefined) await releaseAcquired();
      },
      async () => {
        if (fx !== undefined) await fx.cleanup();
      },
    );
  }
});

test('success, failed, rejected, missing, blocked, and cancelled terminals each persist a paired receipt', async () => {
  let fx: Fixture | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    fx = await fixture();
    const lease = await acquireDaemonLease(fx.paths, { ownerId: 'durable-consumer-A' });
    release = releaseOnce(lease);
    const statuses: readonly TaskVerificationStatus[] = ['success', 'failed', 'rejected', 'missing', 'blocked', 'cancelled'];
    for (const status of statuses) {
      const binding = bindingFor(`terminal-${status}`);
      const scope = scopeFor(binding);
      const journalPath = journalPathFor(fx.paths, binding);
      const counter = countingDispatch(async ({ binding: dispatched }) => terminalProduction(dispatched, scope, status));
      const consumer = consumerFor({ lease, scope, journalPath, dispatch: counter.port });
      const receipt = await consumer.executeOccurrence({
        occurrence: occurrenceFor(binding),
        policy: POLICY,
        claim: claimFor(binding),
        binding,
      });
      assert.equal(receipt.verification.status, status, status);
      assert.equal(counter.count(), 1, status);
      const records = await replayJournal(journalPath);
      assert.equal(records.filter((record) => record.kind === 'checkpoint').length, 1, status);
      assert.equal(records.filter((record) => record.payload?.kind === 'occurrence-terminal-receipt').length, 1, status);
      if (status !== 'success') {
        const record = records.find((candidate) => candidate.payload?.kind === 'occurrence-terminal-receipt');
        const recovery = (record!.payload as {
          recoveryResponsibility?: { providerEffectState: string; releaseProofs: readonly unknown[] };
        }).recoveryResponsibility;
        assert.equal(recovery?.providerEffectState, 'confirmed-released', status);
        assert.ok((recovery?.releaseProofs.length ?? 0) >= 1, status);
      }
    }
  } finally {
    await cleanupFixture(fx, release);
  }
});
