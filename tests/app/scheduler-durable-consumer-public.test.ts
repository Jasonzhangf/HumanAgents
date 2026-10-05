import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import {
  id,
  occurrenceExecutionAdmissionCommitId,
  occurrenceTerminalReceiptCommitId,
  type Checkpoint,
  type EvidenceRef,
  type ExecutionPolicyDefinition,
  type Occurrence,
  type OccurrenceTaskBinding,
  type ServeTaskTerminalReceipt,
} from '../../packages/contracts/src/index.js';
import { acquireDaemonLease } from '../../packages/app/src/supervisor/index.js';
import { DurableOccurrenceConsumer } from '../../packages/app/src/ui-runtime/occurrence-consumer.js';
import { FileCheckpointStore } from '../../packages/app/src/ui-runtime/index.js';
import { SubscriptionControlPort } from '../../packages/runtime/src/subscriptions/index.js';
import type { OccurrenceClaimRecord } from '../../packages/runtime/src/subscriptions/ports.js';

const taskId = id('task', 'task-scheduler-public');
const operationId = id('operation', 'operation-scheduler-public');
const schedulerScope = {
  organId: id('organ', 'organ-scheduler-public'),
  taskId,
};
const assetScope = {
  ...schedulerScope,
  cycleId: id('cycle', 'cycle-scheduler-public'),
  operationId,
};

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `scheduler-public-${label}`),
    kind: 'operation',
    source: 'humanagent.tests.scheduler-public',
    locator: `test://scheduler-public/${label}`,
    scope: assetScope,
  };
}

function terminalReceipt(call: number): ServeTaskTerminalReceipt {
  return {
    taskId,
    operationId,
    executionEpoch: 1,
    inputArtifactDigest: 'sha256:input-scheduler-public',
    verification: {
      taskId,
      operationId,
      executionEpoch: 1,
      attempt: 1,
      inputArtifactDigest: 'sha256:input-scheduler-public',
      policyRef: 'task-verification/v1:policy-scheduler-public',
      policyDigest: 'sha256:policy-scheduler-public',
      status: 'success',
      checks: [{
        checkId: `check-scheduler-public-${call}`,
        kind: 'native',
        status: 'succeeded',
        decisionRef: `task-verification/v1:${call}`,
        decisionDigest: `sha256:${call}`,
        artifactDigests: ['sha256:input-scheduler-public'],
        evidenceRefs: [evidence(String(call))],
      }],
      evidenceRefs: [evidence(String(call))],
    },
    terminalCheckpointRef: `checkpoint:scheduler-public:${call}`,
    settlementReceiptRef: `receipt:scheduler-public:${call}`,
  };
}

function production(receipt: ServeTaskTerminalReceipt): {
  readonly checkpoint: Checkpoint;
  readonly verification: ServeTaskTerminalReceipt['verification'];
  readonly settlementReceiptRef: string;
} {
  return {
    checkpoint: {
      id: id('checkpoint', 'terminal-scheduler-public'),
      scope: assetScope,
      cycleId: assetScope.cycleId,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: receipt.executionEpoch,
      outcome: 'succeeded',
      summary: 'terminal success',
      recoveryStateRef: receipt.verification.evidenceRefs[0]!,
      evidenceRefs: receipt.verification.evidenceRefs,
      next: { kind: 'continue', ref: receipt.verification.evidenceRefs[0]!.locator },
    },
    verification: receipt.verification,
    settlementReceiptRef: receipt.settlementReceiptRef,
  };
}

function policy(): ExecutionPolicyDefinition {
  return {
    policyId: 'policy-scheduler-public',
    policyRevision: 1,
    timezone: 'UTC',
    canonicalInstant: '2026-10-05T00:00:00.000Z',
    dstMode: 'wall',
    dstMissedPolicy: 'shift-forward',
    dstAmbiguousPolicy: 'earlier-offset',
    latePolicy: 'run-once',
    busyPolicy: 'skip',
    executionMode: 'scheduled',
    startAt: '2026-10-05T00:00:00.000Z',
  } as ExecutionPolicyDefinition;
}

function claimRequest() {
  return {
    subscriptionId: 'subscription-scheduler-public',
    scheduleRevision: 1,
    occurrenceOrdinal: 1,
    dueAt: '2026-10-05T00:00:00.000Z',
    taskId,
    operationId,
    inputArtifactDigest: 'sha256:input-scheduler-public',
    schedulerInstanceId: 'scheduler-public',
    leaseId: 'lease-scheduler-public',
    generation: 1,
    executionEpoch: 1,
    nowAt: '2026-10-05T00:00:00.000Z',
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}

function bindingFor(claim: OccurrenceClaimRecord): OccurrenceTaskBinding {
  return {
    occurrenceId: claim.occurrenceId,
    subscriptionId: claim.subscriptionId,
    scheduleRevision: claim.scheduleRevision,
    occurrenceOrdinal: claim.occurrenceOrdinal,
    taskId: claim.taskId,
    operationId: claim.operationId,
    executionEpoch: claim.executionEpoch,
    inputArtifactDigest: claim.inputArtifactDigest,
  };
}

test('scheduler and real durable consumer dispatch once across duplicate, concurrent, and restart calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-app-'));
  const workspace = join(root, 'workspace');
  const controlRoot = join(root, 'control');
  const subscriptionFile = join(root, 'subscriptions.jsonl');
  const occurrenceJournal = join(root, 'occurrence.jsonl');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const lease = await acquireDaemonLease(paths, { ownerId: 'scheduler-app-public' });
  let dispatches = 0;
  const consumer = new DurableOccurrenceConsumer({
    lease,
    scope: assetScope,
    journal: new JsonlOrganJournal(occurrenceJournal),
    checkpoints: new FileCheckpointStore(occurrenceJournal),
    dispatch: {
      async dispatch() {
        dispatches += 1;
        return production(terminalReceipt(dispatches));
      },
    },
  });

  try {
    const firstPort = new SubscriptionControlPort(
      new JsonlOrganJournal(subscriptionFile),
      schedulerScope,
      subscriptionFile,
      consumer,
    );
    await firstPort.create({
      subscriptionId: 'subscription-scheduler-public',
      goalId: 'goal-scheduler-public',
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    }, policy());
    await firstPort.schedule({
      occurrence: {
        subscriptionId: 'subscription-scheduler-public',
        scheduleRevision: 1,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt: '2026-10-05T00:00:00.000Z',
      },
      nowAt: '2026-10-05T00:00:00.000Z',
    });
    const claim = await firstPort.claim(claimRequest());

    const first = await firstPort.consumeExecution(claim.occurrenceId, claim);
    const duplicate = await firstPort.consumeExecution(claim.occurrenceId, claim);
    const replayConsumer = new DurableOccurrenceConsumer({
      lease,
      scope: assetScope,
      journal: new JsonlOrganJournal(occurrenceJournal),
      checkpoints: new FileCheckpointStore(occurrenceJournal),
      dispatch: {
        async dispatch() {
          dispatches += 1;
          throw new Error('replay must not dispatch');
        },
      },
    });
    const restarted = new SubscriptionControlPort(
      new JsonlOrganJournal(subscriptionFile),
      schedulerScope,
      subscriptionFile,
      replayConsumer,
    );
    const afterRestart = await restarted.consumeExecution(claim.occurrenceId, claim);
    const [firstConcurrent, secondConcurrent] = await Promise.all([
      restarted.consumeExecution(claim.occurrenceId, claim),
      restarted.consumeExecution(claim.occurrenceId, claim),
    ]);

    assert.deepEqual(duplicate, first);
    assert.deepEqual(afterRestart, first);
    assert.deepEqual(firstConcurrent, first);
    assert.deepEqual(secondConcurrent, first);
    assert.equal(dispatches, 1);

    const records = await new JsonlOrganJournal(occurrenceJournal).replay();
    const binding = bindingFor(claim);
    const admissionCommitId = await occurrenceExecutionAdmissionCommitId(binding);
    const receiptCommitId = await occurrenceTerminalReceiptCommitId(binding);
    assert.equal(records.filter((record) => record.commitId === admissionCommitId).length, 1);
    assert.equal(records.filter((record) => record.commitId === receiptCommitId).length, 1);
    assert.equal(records.filter((record) => record.kind === 'checkpoint').length, 1);
  } finally {
    await lease.release();
    await rm(root, { recursive: true, force: true });
  }
});
