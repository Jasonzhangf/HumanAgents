// Public acceptance harness for the app-owned occurrence consumer router.
//
// It drives the real `OccurrenceConsumerRouter` over real on-disk
// `JsonlOrganJournal` / `FileCheckpointStore` files and a real
// `SupervisorLease`, and proves two properties at once:
//
//   1. the router does not retain one consumer per occurrence slot forever: a
//      consumer is released once its execution has settled, and
//   2. the memoization that guarantees single dispatch is still intact while an
//      execution is in flight, so concurrent calls for one identity share one
//      consumer and still dispatch exactly once, and a settled occurrence that
//      is executed again replays its committed journal receipt instead of
//      forking a second execution.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureControlLayout, resolveRuntimePaths, type RuntimePaths } from '../../packages/config/src/index.js';
import { acquireDaemonLease, type SupervisorLease } from '../../packages/app/src/supervisor/index.js';
import { OccurrenceConsumerRouter } from '../../packages/app/src/ui-runtime/occurrence-router.js';
import {
  DurableOccurrenceConsumer,
  type OccurrenceDispatchInput,
  type OccurrenceTerminalProduction,
} from '../../packages/app/src/ui-runtime/occurrence-consumer.js';
import { JsonlOrganJournal, type JournalRecord } from '../../packages/adapters/jsonl/src/index.js';
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
} from '../../packages/contracts/src/index.js';
import { executionPolicyHash } from '../../packages/core/src/subscription.js';
import type { OccurrenceClaimRecord } from '../../packages/runtime/src/subscriptions/ports.js';

const ORGAN_ID = id('organ', 'organ-router-eviction');
const POLICY: ExecutionPolicyDefinition = {
  policyId: 'policy-router-eviction',
  policyRevision: 1,
  timezone: 'UTC',
  canonicalInstant: '2026-10-07T00:00:00.000Z',
  dstMode: 'wall',
  dstMissedPolicy: 'shift-forward',
  dstAmbiguousPolicy: 'earlier-offset',
  latePolicy: 'run-once',
  busyPolicy: 'skip',
  executionMode: 'once',
  dueAt: '2026-10-07T00:00:00.000Z',
};

interface Fixture {
  readonly root: string;
  readonly paths: RuntimePaths;
  readonly consumerRoot: string;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-router-eviction-'));
  const consumerRoot = join(root, 'occurrence-consumer');
  try {
    const controlRoot = join(root, 'control');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await mkdir(consumerRoot);
    const paths = await resolveRuntimePaths({ controlRoot, workspace });
    await ensureControlLayout(paths);
    return {
      root,
      paths,
      consumerRoot,
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

// One distinct immutable binding per occurrence slot, exactly like a recurring
// plan produces: a new occurrence id, task and operation for every slot.
function bindingFor(ordinal: number): OccurrenceTaskBinding {
  return {
    occurrenceId: `subscription-router-eviction::1::${ordinal}`,
    subscriptionId: 'subscription-router-eviction',
    scheduleRevision: 1,
    occurrenceOrdinal: ordinal,
    taskId: id('task', `task-router-eviction-${ordinal}`),
    operationId: id('operation', `operation-router-eviction-${ordinal}`),
    executionEpoch: 1,
    inputArtifactDigest: `sha256:input-router-eviction-${ordinal}`,
  };
}

function occurrenceFor(binding: OccurrenceTaskBinding): Occurrence {
  return {
    occurrenceId: binding.occurrenceId,
    subscriptionId: binding.subscriptionId,
    scheduleRevision: binding.scheduleRevision,
    occurrenceOrdinal: binding.occurrenceOrdinal,
    state: 'due',
    dueAt: '2026-10-07T00:00:00.000Z',
  };
}

function claimFor(binding: OccurrenceTaskBinding): OccurrenceClaimRecord {
  return {
    occurrenceId: binding.occurrenceId,
    subscriptionId: binding.subscriptionId,
    scheduleRevision: binding.scheduleRevision,
    occurrenceOrdinal: binding.occurrenceOrdinal,
    claimedBy: 'router-eviction-test',
    leaseId: 'scheduler-lease-1',
    schedulerInstanceId: 'scheduler-instance-1',
    generation: 1,
    executionEpoch: binding.executionEpoch,
    acquiredAt: '2026-10-07T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    policyRevision: POLICY.policyRevision,
    policyHash: executionPolicyHash(POLICY),
    policy: POLICY,
    taskId: binding.taskId,
    operationId: binding.operationId,
    inputArtifactDigest: binding.inputArtifactDigest,
  };
}

function successCheck(evidence: EvidenceRef): TaskCheckEvidence {
  return {
    checkId: 'check-router-eviction-terminal',
    kind: 'native',
    status: 'succeeded',
    decisionRef: 'task-verification/v1:router-eviction',
    decisionDigest: 'sha256:router-eviction-check',
    artifactDigests: [],
    evidenceRefs: [evidence],
  };
}

function successProduction(input: OccurrenceDispatchInput): OccurrenceTerminalProduction {
  const scope: ScopeRef = input.scope;
  const evidence: EvidenceRef = {
    evidenceId: id('evidence', `router-eviction-${input.binding.operationId.value}`),
    kind: 'operation',
    source: 'humanagent.tests.router-eviction',
    locator: `test://router-eviction/${encodeURIComponent(input.binding.occurrenceId)}`,
    digest: `sha256:router-eviction-${input.binding.operationId.value}`,
    scope,
  };
  const checkpoint: Checkpoint = {
    id: id('checkpoint', `router-eviction-${input.binding.operationId.value}`),
    scope,
    cycleId: scope.cycleId as NonNullable<ScopeRef['cycleId']>,
    seq: input.previousCheckpoint === null ? 1 : input.previousCheckpoint.seq + 1,
    previousCheckpointId: input.previousCheckpoint === null ? null : input.previousCheckpoint.id,
    directiveRevision: input.previousCheckpoint === null ? 1 : input.previousCheckpoint.directiveRevision,
    executionEpoch: input.binding.executionEpoch,
    outcome: 'succeeded',
    summary: 'router eviction acceptance terminal success',
    recoveryStateRef: evidence,
    evidenceRefs: [evidence],
    next: { kind: 'continue', ref: evidence.locator },
  };
  const verification: TaskVerificationResult = {
    taskId: input.binding.taskId,
    operationId: input.binding.operationId,
    executionEpoch: input.binding.executionEpoch,
    attempt: 1,
    inputArtifactDigest: input.binding.inputArtifactDigest,
    policyRef: 'task-verification/v1:router-eviction',
    policyDigest: 'sha256:router-eviction-policy',
    status: 'success',
    checks: [successCheck(evidence)],
    evidenceRefs: [evidence],
  };
  return {
    checkpoint,
    verification,
    settlementReceiptRef: `occurrence-settlement/v1:${input.binding.operationId.value}:${input.binding.executionEpoch}`,
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function execute(
  router: OccurrenceConsumerRouter,
  binding: OccurrenceTaskBinding,
): Promise<ServeTaskTerminalReceipt> {
  return router.executeOccurrence({
    occurrence: occurrenceFor(binding),
    policy: POLICY,
    claim: claimFor(binding),
    binding,
  });
}

async function journalRecords(consumerRoot: string, binding: OccurrenceTaskBinding): Promise<readonly JournalRecord[]> {
  const path = join(consumerRoot, DurableOccurrenceConsumer.journalFileNameForBinding(binding));
  return new JsonlOrganJournal(path).replay();
}

test('a settled occurrence does not leave a retained consumer behind', async () => {
  const fx = await fixture();
  const lease = await acquireDaemonLease(fx.paths, { ownerId: 'router-eviction-A' });
  const dispatched: string[] = [];
  const router = new OccurrenceConsumerRouter({
    organId: ORGAN_ID,
    root: fx.consumerRoot,
    lease: () => lease,
    dispatch: {
      async dispatch(input) {
        dispatched.push(input.binding.occurrenceId);
        return successProduction(input);
      },
    },
  });
  try {
    const slots = 8;
    for (let ordinal = 1; ordinal <= slots; ordinal += 1) {
      const receipt = await execute(router, bindingFor(ordinal));
      assert.equal(receipt.verification.status, 'success', `occurrence ${ordinal} must settle`);
      assert.equal(
        router.retainedConsumerCount,
        0,
        `a settled occurrence must not stay retained (slot ${ordinal}, retained ${router.retainedConsumerCount})`,
      );
    }
    assert.equal(dispatched.length, slots, 'every distinct occurrence must dispatch exactly once');
    assert.equal(router.retainedConsumerCount, 0, 'no consumer may be retained once every execution has settled');
  } finally {
    await lease.release();
    await fx.cleanup();
  }
});

test('an in-flight occurrence keeps its consumer and concurrent calls still dispatch once', async () => {
  const fx = await fixture();
  const lease = await acquireDaemonLease(fx.paths, { ownerId: 'router-eviction-B' });
  const started = deferred();
  const gate = deferred();
  let dispatches = 0;
  const router = new OccurrenceConsumerRouter({
    organId: ORGAN_ID,
    root: fx.consumerRoot,
    lease: () => lease,
    dispatch: {
      async dispatch(input) {
        dispatches += 1;
        started.resolve();
        await gate.promise;
        return successProduction(input);
      },
    },
  });
  try {
    const binding = bindingFor(1);
    const first = execute(router, binding);
    const second = execute(router, binding);
    await started.promise;
    assert.equal(
      router.retainedConsumerCount,
      1,
      'the consumer must stay retained while a dispatch is in flight',
    );
    assert.equal(dispatches, 1, 'concurrent calls for one identity must share one consumer and dispatch once');
    gate.resolve();
    const [left, right] = await Promise.all([first, second]);
    assert.deepEqual(left, right, 'concurrent calls must return the same terminal receipt');
    assert.equal(dispatches, 1, 'concurrent calls must not dispatch a second execution');
    assert.equal(router.retainedConsumerCount, 0, 'the consumer must be released once the last in-flight call settles');
  } finally {
    await lease.release();
    await fx.cleanup();
  }
});

test('a settled occurrence replays its committed journal receipt after eviction without dispatching again', async () => {
  const fx = await fixture();
  const lease = await acquireDaemonLease(fx.paths, { ownerId: 'router-eviction-C' });
  let dispatches = 0;
  const router = new OccurrenceConsumerRouter({
    organId: ORGAN_ID,
    root: fx.consumerRoot,
    lease: () => lease,
    dispatch: {
      async dispatch(input) {
        dispatches += 1;
        return successProduction(input);
      },
    },
  });
  try {
    const binding = bindingFor(1);
    const committed = await execute(router, binding);
    assert.equal(dispatches, 1);
    assert.equal(router.retainedConsumerCount, 0, 'the settled consumer must be released');

    const replayed = await execute(router, binding);
    assert.deepEqual(replayed, committed, 'a re-executed settled occurrence must replay the committed receipt');
    assert.equal(dispatches, 1, 'replay must not dispatch a second execution');
    assert.equal(router.retainedConsumerCount, 0, 'the rebuilt consumer must be released again');

    const receiptCommitId = await occurrenceTerminalReceiptCommitId(binding);
    const records = await journalRecords(fx.consumerRoot, binding);
    assert.equal(records.filter((record) => record.kind === 'checkpoint').length, 1, 'exactly one terminal checkpoint');
    assert.equal(
      records.filter((record) => record.commitId === receiptCommitId).length,
      1,
      'exactly one terminal receipt',
    );
  } finally {
    await lease.release();
    await fx.cleanup();
  }
});

test('a lease change rebuilds the consumer for a settled occurrence and still replays it', async () => {
  const fx = await fixture();
  let lease: SupervisorLease = await acquireDaemonLease(fx.paths, { ownerId: 'router-eviction-D1' });
  let dispatches = 0;
  const router = new OccurrenceConsumerRouter({
    organId: ORGAN_ID,
    root: fx.consumerRoot,
    lease: () => lease,
    dispatch: {
      async dispatch(input) {
        dispatches += 1;
        return successProduction(input);
      },
    },
  });
  try {
    const binding = bindingFor(1);
    const committed = await execute(router, binding);
    assert.equal(dispatches, 1);
    const firstLeaseId = lease.record.leaseId;
    await lease.release();

    const replacement = await acquireDaemonLease(fx.paths, { ownerId: 'router-eviction-D2' });
    lease = replacement;
    assert.ok(replacement.record.leaseId !== firstLeaseId, 'the replacement lease must be a new owner');
    assert.ok(replacement.record.generation > 1, 'the replacement lease must advance the generation');

    const replayed = await execute(router, binding);
    assert.deepEqual(replayed, committed, 'a new lease must replay the committed receipt for the same occurrence');
    assert.equal(dispatches, 1, 'a lease change must not dispatch a second execution');
    assert.equal(router.retainedConsumerCount, 0, 'the replacement consumer must be released once settled');
  } finally {
    await lease.release();
    await fx.cleanup();
  }
});
