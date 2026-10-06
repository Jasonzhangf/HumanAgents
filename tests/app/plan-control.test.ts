// Black-box acceptance for the persisted execution plan control path:
// a scheduled/recurring plan has a real production stop path that reaches it
// before any occurrence task exists, a deleted task's plan is not left
// dispatching, and the task dashboard projects the durable plan state without
// becoming a second control truth.
//
// Every observation goes through the public HTTP surface of a real runtime: the
// real supervisor lease, the real subscription control port, the real occurrence
// consumer and the real execution coordinator. Only the provider port is the
// fake replay runtime the rest of the app suite uses.
//
// `stale` is structurally unreachable through this entry, so it is deliberately
// not manufactured here: the client cannot declare a revision, the service reads
// `expectedPolicyRevision` from the authoritative snapshot inside the same
// request, and the port re-checks it inside its own transaction. A `stale`
// receipt would need `policyRevision` to move between those two points, and the
// only action that moves it is `modify`, which has no production entry. `stale`
// stays reachable and covered at the port level in tests/runtime/subscriptions.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  bindingFor,
  controlPlan,
  issueText,
  persistPlan,
  planFor,
  recurringPolicy,
  scheduledPolicy,
  startHarness,
  waitFor,
  type ControlReceiptView,
  type SchedulerStatusView,
  type TaskDashboardView,
  type TaskListView,
} from './scheduler-production-harness.js';

function controlPath(subscriptionId: string): string {
  return `/api/plans/${encodeURIComponent(subscriptionId)}/control`;
}

function taskPath(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}

async function receiptOf(response: Response): Promise<ControlReceiptView> {
  const text = await response.text();
  assert.equal(response.status, 200, `the control route must answer with the durable receipt: ${text}`);
  return JSON.parse(text) as ControlReceiptView;
}

async function errorCodeOf(response: Response): Promise<{ readonly code: string; readonly status: number }> {
  const text = await response.text();
  const parsed = JSON.parse(text) as { readonly error?: { readonly code: string } };
  return { code: parsed.error?.code ?? '', status: response.status };
}

function taskCount(view: TaskListView): number {
  return view.running.length + view.completed.length + view.failed.length + view.stopped.length + view.waiting.length;
}

test('the plan control route reaches a plan that has no task yet and applies pause, resume and cancel-future durably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-plan-control-route-'));
  // Far enough in the future that nothing can dispatch while the test controls it.
  const startAt = new Date(Date.now() + 120_000).toISOString();
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    const requirementId = await persistPlan(harness, 'control the plan before its first occurrence', scheduledPolicy(startAt));
    const subscriptionId = `subscription:${requirementId}`;

    // Reachability: the plan is listed by the existing scheduler projection and
    // no coordinator task exists yet, so a task-scoped control edge could not
    // have reached it.
    const before = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(before, requirementId).state, 'active');
    assert.equal(planFor(before, requirementId).scheduleRevision, 1);
    assert.equal(before.executed, 0);
    assert.equal(harness.port.starts.length, 0);
    assert.equal(taskCount(await harness.json<TaskListView>('/api/tasks')), 0, 'the plan has no task before its first occurrence');

    const requestedAt = new Date().toISOString();
    const paused = await receiptOf(await harness.send('POST', controlPath(subscriptionId), {
      action: 'pause',
      idempotencyKey: 'plan-control-pause-1',
      requestedAt,
    }));
    assert.equal(paused.status, 'applied');
    assert.equal(paused.action, 'pause');
    assert.equal(paused.subscriptionId, subscriptionId);
    // The receipt carries the durable numbers, not a restated projection.
    assert.equal(paused.policyRevision, 1);
    assert.equal(paused.scheduleRevision, 2);
    assert.equal(paused.idempotencyKey, 'plan-control-pause-1');
    assert.equal(paused.controlRef, `subscription-control:${subscriptionId}:plan-control-pause-1`);
    assert.equal(typeof paused.requestHash, 'string');
    assert.ok(paused.requestHash.length > 0, 'the durable receipt carries its request hash');
    assert.deepEqual(paused.supersededUnclaimedOccurrences, []);

    // Replaying the identical request is a durable duplicate, not a second action.
    const replay = await receiptOf(await harness.send('POST', controlPath(subscriptionId), {
      action: 'pause',
      idempotencyKey: 'plan-control-pause-1',
      requestedAt,
    }));
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.scheduleRevision, 2);

    // Reusing the key with different content is a durable conflict, not a silent apply.
    const conflict = await receiptOf(await harness.send('POST', controlPath(subscriptionId), {
      action: 'pause',
      idempotencyKey: 'plan-control-pause-1',
      requestedAt: new Date(Date.parse(requestedAt) + 1_000).toISOString(),
    }));
    assert.equal(conflict.status, 'conflict');

    const suspended = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(suspended, requirementId).state, 'suspended');
    assert.equal(planFor(suspended, requirementId).scheduleRevision, 2);

    const resumed = await receiptOf(await controlPlan(harness, subscriptionId, 'resume', 'plan-control-resume-1'));
    assert.equal(resumed.status, 'applied');
    assert.equal(resumed.scheduleRevision, 3);
    assert.equal(
      planFor(await harness.json<SchedulerStatusView>('/api/runtime/scheduler'), requirementId).state,
      'active',
    );

    const cancelled = await receiptOf(await controlPlan(harness, subscriptionId, 'cancel-future', 'plan-control-cancel-1'));
    assert.equal(cancelled.status, 'applied');
    assert.equal(cancelled.scheduleRevision, 4);
    const afterCancel = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(afterCancel, requirementId).state, 'cancelled');
    assert.equal(planFor(afterCancel, requirementId).scheduleRevision, 4);

    // A cancelled plan rejects further control with the durable typed error.
    const rejected = await errorCodeOf(await controlPlan(harness, subscriptionId, 'pause', 'plan-control-pause-2'));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.code, 'execution-plan.invalid-state');

    // An unknown plan is a typed 404, not an implicit create.
    const missing = await errorCodeOf(await controlPlan(harness, 'subscription:requirement:missing', 'pause', 'plan-control-missing-1'));
    assert.equal(missing.status, 404);
    assert.equal(missing.code, 'execution-plan.not-found');

    // `modify` has no production entry yet: it is refused explicitly.
    const modify = await errorCodeOf(await harness.send('POST', controlPath(subscriptionId), {
      action: 'modify',
      idempotencyKey: 'plan-control-modify-1',
      requestedAt: new Date().toISOString(),
    }));
    assert.equal(modify.status, 400);
    assert.equal(modify.code, 'execution-plan.action-unsupported');

    // A malformed instant is refused by the contract owner, surfaced as a typed 400.
    const invalid = await errorCodeOf(await harness.send('POST', controlPath(subscriptionId), {
      action: 'resume',
      idempotencyKey: 'plan-control-invalid-1',
      requestedAt: 'not-an-instant',
    }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.code, 'execution-plan.invalid-request');

    // Nothing about controlling the plan ever dispatched an execution.
    assert.equal(harness.port.starts.length, 0);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the task dashboard projects the durable plan and omits it for a task without one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-plan-control-projection-'));
  const startAt = new Date(Date.now() + 1_500).toISOString();
  const policy = recurringPolicy(startAt, 1);
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    const requirementId = await persistPlan(harness, 'project the recurring plan on its task', policy);
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1, issueText(status));
    });
    const occurrenceId = `subscription:${requirementId}::1::1`;
    const taskId = bindingFor(occurrenceId, policy, startAt).taskId.value;
    const dashboard = await harness.json<TaskDashboardView>(`${taskPath(taskId)}/dashboard`);
    assert.ok(dashboard.plan, 'the occurrence task dashboard projects the plan it belongs to');
    assert.equal(dashboard.plan!.subscriptionId, `subscription:${requirementId}`);
    // The durable SubscriptionState is exposed verbatim, with no mapping.
    assert.equal(dashboard.plan!.state, 'active');
    assert.equal(dashboard.plan!.executionMode, 'recurring');
    assert.equal(dashboard.plan!.canPause, true);
    assert.equal(dashboard.plan!.canResume, false);
    assert.equal(dashboard.plan!.canCancelFuture, true);
    assert.equal(
      dashboard.plan!.nextDueAt,
      new Date(Date.parse(startAt) + 60_000).toISOString(),
      'the projection names the next committed slot after the durable ordinal',
    );

    // A task with no persisted plan omits the field entirely.
    const created = await harness.call('/api/tasks', { title: 'plain task', directive: 'plain directive' });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const plain = JSON.parse(createdText) as { readonly taskId: { readonly value: string } };
    const plainDashboard = await harness.json<TaskDashboardView>(`${taskPath(plain.taskId.value)}/dashboard`);
    assert.equal(plainDashboard.plan, undefined);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deleting a task cancels the plan it orphans and never dispatches it again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-plan-control-delete-'));
  const startAt = new Date(Date.now() + 1_500).toISOString();
  const policy = scheduledPolicy(startAt);
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    const requirementId = await persistPlan(harness, 'delete the task that owns a live plan', policy);
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1, issueText(status));
    });
    const occurrenceId = `subscription:${requirementId}::1::1`;
    const taskId = bindingFor(occurrenceId, policy, startAt).taskId.value;
    assert.equal(planFor(await harness.json<SchedulerStatusView>('/api/runtime/scheduler'), requirementId).state, 'active');

    const deleted = await harness.send('DELETE', taskPath(taskId));
    const deletedText = await deleted.text();
    assert.equal(deleted.status, 200, deletedText);
    assert.deepEqual(JSON.parse(deletedText), { taskId, deleted: true });

    // The deleted task's plan is not left able to dispatch.
    const after = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(after, requirementId).state, 'cancelled');
    assert.equal(planFor(after, requirementId).scheduleRevision, 2);
    assert.equal(harness.port.starts.length, 1, 'a deleted task never starts another execution');
    assert.equal((await harness.call(`${taskPath(taskId)}/dashboard`)).status, 404);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('bulk delete cancels the orphaned plan through the same control edge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-plan-control-bulk-delete-'));
  const startAt = new Date(Date.now() + 1_500).toISOString();
  const policy = scheduledPolicy(startAt);
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    const requirementId = await persistPlan(harness, 'bulk delete the task that owns a live plan', policy);
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1, issueText(status));
    });
    const taskId = bindingFor(`subscription:${requirementId}::1::1`, policy, startAt).taskId.value;

    const bulk = await harness.call('/api/tasks/bulk', { action: 'delete', taskIds: [taskId] });
    const bulkText = await bulk.text();
    assert.equal(bulk.status, 200, bulkText);
    const result = JSON.parse(bulkText) as { readonly results: readonly { readonly taskId: string; readonly state: string }[] };
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.taskId, taskId);
    assert.equal(result.results[0]!.state, 'succeeded');

    const after = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(after, requirementId).state, 'cancelled');
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stopping one running occurrence leaves the recurring schedule intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-plan-control-stop-'));
  const startAt = new Date(Date.now() + 1_500).toISOString();
  const policy = scheduledPolicy(startAt);
  // A slow provider keeps the occurrence genuinely running while it is stopped.
  const harness = await startHarness({ root, intervalMs: 250, stepDelayMs: 3_000 });
  try {
    const requirementId = await persistPlan(harness, 'stop one run of the scheduled plan', policy);
    const taskId = bindingFor(`subscription:${requirementId}::1::1`, policy, startAt).taskId.value;
    await waitFor(async () => {
      const tasks = await harness.json<TaskListView>('/api/tasks');
      assert.equal(tasks.running.length, 1, 'the occurrence is really running');
    });

    const stopped = await harness.send('POST', `${taskPath(taskId)}/stop`);
    const stoppedText = await stopped.text();
    assert.equal(stopped.status, 202, stoppedText);

    // Execution control and plan control are different concerns: stopping one run
    // must not destroy the schedule.
    const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(status, requirementId).state, 'active');
    assert.equal(planFor(status, requirementId).scheduleRevision, 1);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a suspended plan dispatches nothing at its due time and resume re-arms the slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-plan-control-suspended-'));
  // Comfortably outside the patrol's one second due-time grace window, so the
  // suspension is committed before the slot can even be scheduled.
  const startAt = new Date(Date.now() + 5_000).toISOString();
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    const requirementId = await persistPlan(harness, 'pause the plan before its due time', scheduledPolicy(startAt));
    const subscriptionId = `subscription:${requirementId}`;
    const paused = await receiptOf(await controlPlan(harness, subscriptionId, 'pause', 'plan-control-before-due-pause'));
    assert.equal(paused.status, 'applied');

    // Let the due instant pass while the plan is suspended.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(startAt) - Date.now()) + 1_500));
    const during = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    const suspended = planFor(during, requirementId);
    assert.equal(suspended.state, 'suspended');
    assert.equal(suspended.occurrences.length, 0, 'a suspended plan never schedules its slot');
    assert.equal(during.claimed, 0);
    assert.equal(during.executed, 0);
    assert.equal(during.settled, 0);
    assert.equal(harness.port.starts.length, 0, 'a suspended plan dispatched nothing at its due time');

    // Resume re-arms the slot: the assertion is that it really dispatches and
    // settles, not merely that the state moved back to active.
    const resumed = await receiptOf(await controlPlan(harness, subscriptionId, 'resume', 'plan-control-before-due-resume'));
    assert.equal(resumed.status, 'applied');
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1, issueText(status));
    });
    const after = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(after, requirementId).settlements[0]!.verificationStatus, 'success');
    assert.equal(harness.port.starts.length, 1, 'resume re-armed the slot and it dispatched exactly once');
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel-future does not stop an already-claimed in-flight execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-plan-control-in-flight-'));
  const startAt = new Date(Date.now() + 2_500).toISOString();
  // Slow provider steps keep the claimed occurrence genuinely in flight while the
  // plan is cancelled: that is the window the graph's `linearization` rule covers
  // ("claim committed before control keeps the authorized immutable policy
  // snapshot for that executionEpoch").
  const harness = await startHarness({ root, intervalMs: 250, stepDelayMs: 600 });
  try {
    const requirementId = await persistPlan(harness, 'cancel the future while one run is in flight', scheduledPolicy(startAt));
    const subscriptionId = `subscription:${requirementId}`;
    await waitFor(async () => {
      assert.equal(harness.port.starts.length, 1, 'the claimed occurrence reached its real execution');
    });
    const inFlight = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(inFlight, requirementId).occurrences[0]?.state, 'claimed');

    const cancelled = await receiptOf(await controlPlan(harness, subscriptionId, 'cancel-future', 'plan-control-in-flight-cancel'));
    assert.equal(cancelled.status, 'applied');
    assert.deepEqual(
      cancelled.supersededUnclaimedOccurrences,
      [],
      'a claimed occurrence is not an unclaimed future slot and must not be superseded',
    );
    assert.equal(
      planFor(await harness.json<SchedulerStatusView>('/api/runtime/scheduler'), requirementId).state,
      'cancelled',
    );

    // The execution already authorized for this epoch still reaches its verified
    // terminal and settles through the durable port.
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).settlements.length, 1, issueText(status));
    });
    const settled = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(settled, requirementId).settlements[0]!.verificationStatus, 'success');
    assert.equal(harness.port.starts.length, 1, 'the control dispatched no replacement execution');
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancel-future on a claimed slot that has not started yet dispatches nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-plan-control-claimed-cancel-'));
  const startAt = new Date(Date.now() + 4_000).toISOString();
  const harness = await startHarness({ root, intervalMs: 250 });
  try {
    const requirementId = await persistPlan(harness, 'cancel the future inside the due-time grace window', scheduledPolicy(startAt));
    const subscriptionId = `subscription:${requirementId}`;
    // The patrol claims the slot inside its grace window, before the due instant.
    await waitFor(async () => {
      const status = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
      assert.equal(planFor(status, requirementId).occurrences[0]?.state, 'claimed');
    });
    assert.equal(harness.port.starts.length, 0, 'the claim happened before the real execution');

    const cancelled = await receiptOf(await controlPlan(harness, subscriptionId, 'cancel-future', 'plan-control-claimed-cancel'));
    assert.equal(cancelled.status, 'applied');
    assert.deepEqual(cancelled.supersededUnclaimedOccurrences, []);

    // Past the due instant the claimed slot must still not run: a cancelled plan
    // never dispatches.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(startAt) - Date.now()) + 1_500));
    const after = await harness.json<SchedulerStatusView>('/api/runtime/scheduler');
    assert.equal(planFor(after, requirementId).state, 'cancelled');
    assert.equal(after.executed, 0);
    assert.equal(harness.port.starts.length, 0, 'a cancelled plan dispatched nothing after the due instant');
    // Observed residual, NOT a desired end state: the patrol skips non-active
    // plans, so the claim taken in the grace window is never driven to a
    // settlement and stays `claimed` in the durable snapshot. This fence records
    // the current behaviour; if the residual is ever fixed, update this assertion.
    assert.equal(planFor(after, requirementId).occurrences[0]?.state, 'claimed');
    assert.equal(planFor(after, requirementId).settlements.length, 0);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});
