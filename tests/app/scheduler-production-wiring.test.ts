// Black-box acceptance for the production scheduled-occurrence DAG:
// persisted active plan -> due-time patrol under a live supervisor lease ->
// schedule/claim -> durable consumer -> real coordinator execution -> verified
// terminal -> settlement, observed through the public HTTP surface only.
//
// The harness (real runtime, real lease, real subscription control port, real
// occurrence consumer, real coordinator, fake replay provider) lives in
// ./scheduler-production-harness.ts so the plan-control acceptance file drives
// the same production entry instead of a second copy.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  occurrenceExecutionAdmissionCommitId,
  occurrenceTerminalReceiptCommitId,
} from '../../packages/contracts/src/index.js';
import { FakeReplayExecutionRuntimePort } from '../../packages/app/src/ui-runtime/index.js';
import {
  binding,
  bindingFor,
  controlPlan,
  CountingExecutionPort,
  issueText,
  persistPlan,
  planFor,
  readConsumerJournal,
  recurringPolicy,
  scheduledPolicy,
  startHarness,
  waitFor,
  type ControlReceiptView,
  type SchedulerStatusView,
  type TaskDashboardView,
  type TaskListView,
} from './scheduler-production-harness.js';

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

test('cancel-future inside the claim grace window still drives the persisted claim to settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-scheduler-production-cancel-grace-'));
  const harness = await startHarness({ root, intervalMs: 100 });
  try {
    const startAt = new Date(Date.now() + 5_000).toISOString();
    const policy = scheduledPolicy(startAt);
    const requirementId = await persistPlan(harness, 'cancel the grace-window claim', policy);
    const subscriptionId = `subscription:${requirementId}`;
    const occurrenceId = `${subscriptionId}::1::1`;

    // The patrol claims the slot up to one second before its due time and then
    // deliberately defers the real execution until the slot time.
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      const occurrence = planFor(status, requirementId).occurrences[0];
      assert.equal(occurrence?.state, 'claimed');
      assert.equal(occurrence?.occurrenceId, occurrenceId);
    }, 5_500);
    assert.ok(Date.now() < Date.parse(startAt), 'the claim is inside the grace window');
    assert.equal(harness.port.starts.length, 0, 'nothing executed before the slot time');

    // cancel-future lands while the claim is persisted but not yet due. The
    // claim is already committed, so it is not one of the unclaimed slots the
    // control supersedes.
    const cancelled = await controlPlan(harness, subscriptionId, 'cancel-future', `cancel-grace:${occurrenceId}`);
    const cancelledText = await cancelled.text();
    assert.equal(cancelled.status, 200, cancelledText);
    const receipt = JSON.parse(cancelledText) as ControlReceiptView;
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.action, 'cancel-future');
    assert.equal(
      receipt.supersededUnclaimedOccurrences.includes(occurrenceId),
      false,
      'a claimed occurrence is not superseded by the control',
    );
    assert.ok(Date.now() < Date.parse(startAt), 'the control landed inside the grace window');

    const afterControl = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(afterControl, requirementId).state, 'cancelled');

    // The plan is no longer active, so it must never receive a new slot. The
    // persisted claim, however, is already committed and must still reach a
    // terminal settlement instead of staying `claimed` forever.
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      const plan = planFor(status, requirementId);
      assert.equal(
        plan.settlements.length,
        1,
        `occurrence=${plan.occurrences[0]?.state ?? 'absent'} executed=${status.executed} ${issueText(status)}`,
      );
    }, Math.max(1_000, Date.parse(startAt) - Date.now()) + 15_000);

    const settled = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    const plan = planFor(settled, requirementId);
    assert.equal(plan.state, 'cancelled', 'the cancellation remains the durable plan state');
    assert.equal(plan.occurrences[0]?.state, 'consumed', 'the persisted claim reached its terminal state');
    assert.equal(plan.settlements[0]?.occurrenceId, occurrenceId);
    assert.equal(plan.settlements[0]?.verificationStatus, 'success');
    assert.equal(harness.port.starts.length, 1, 'the committed claim ran exactly one real execution');
    assert.equal(settled.executed, 1);

    // The settlement is durable: one admission and one terminal receipt for the
    // exact binding the patrol claimed.
    const expectedBinding = bindingFor(occurrenceId, policy, startAt);
    const admissionCommitId = await occurrenceExecutionAdmissionCommitId(expectedBinding);
    const receiptCommitId = await occurrenceTerminalReceiptCommitId(expectedBinding);
    const journal = await readConsumerJournal(harness, occurrenceId);
    assert.equal(journal.filter((record) => record.commitId === admissionCommitId).length, 1);
    assert.equal(journal.filter((record) => record.commitId === receiptCommitId).length, 1);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});
