import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoreError,
  CheckpointError,
  EpochError,
  HealthError,
  PermissionError,
  assertExecutionEventFence,
  assertHarnessHealthPublisher,
  assertHealthSnapshotOwnership,
  assertCheckpointOutcome,
  assertCheckpointRecoveryStateRef,
  assertCheckpointRecoveryResponsibility,
  assertSteerPermission,
  canTransitionLifecycle,
  canTransitionOrgan,
  classifyErrorPolicy,
  classifyHealth,
  classifyHealthSnapshot,
  fenceExecutionEvent,
  isLateEventRejection,
  isTerminalLifecycleState,
  planStopRequest,
  planStopSettle,
  stopRequestIsStopped,
  transitionLifecycle,
  type ExecutionEventFence,
} from '../../packages/core/src/index.js';
import { ContractError, id, type Checkpoint, type EvidenceRef, type OrganHealthSnapshot, type ScopeRef } from '../../packages/contracts/src/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: ScopeRef = { organId: organ, taskId: task };
const operation = id('operation', 'operation-a');

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: label,
    scope,
  };
}

function checkpoint(seq: number, previousCheckpointId: Checkpoint['previousCheckpointId'], overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: id('checkpoint', `checkpoint-${seq}`),
    scope,
    cycleId: id('cycle', 'cycle-a'),
    seq,
    previousCheckpointId,
    directiveRevision: 1,
    executionEpoch: 4,
    outcome: 'waiting',
    summary: `checkpoint ${seq}`,
    recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [],
    next: { kind: 'wait', ref: 'condition-a' },
    ...overrides,
  };
}

test('lifecycle allows only explicit work and organ transitions', () => {
  assert.equal(canTransitionLifecycle('created', 'admitted'), true);
  assert.equal(transitionLifecycle('admitted', 'running'), 'running');
  assert.equal(canTransitionLifecycle('running', 'settling'), true);
  assert.equal(canTransitionLifecycle('settling', 'running'), true);
  assert.equal(canTransitionLifecycle('running', 'succeeded'), false);
  assert.equal(canTransitionLifecycle('running', 'stopped'), false);
  assert.equal(canTransitionLifecycle('settling', 'stopped'), true);
  assert.equal(isTerminalLifecycleState('stopped'), true);
  assert.equal(isTerminalLifecycleState('unknown'), false);
  assert.throws(() => transitionLifecycle('succeeded', 'running'), CoreError);

  assert.equal(canTransitionOrgan('starting', 'ready'), true);
  assert.equal(canTransitionOrgan('ready', 'stopped'), false);
  assert.equal(canTransitionOrgan('ready', 'stopping'), true);
  assert.equal(canTransitionOrgan('stopping', 'stopped'), true);
});

test('checkpoint recovery references reject equal values with mismatched scope kinds', () => {
  const malformedCheckpointScope = {
    ...scope,
    taskId: { scope: 'organ', value: task.value } as never,
  };
  assert.throws(() => assertCheckpointRecoveryStateRef(malformedCheckpointScope, evidence('malformed-scope')), CheckpointError);
});

test('epoch fence accepts the current execution only and marks late events stale', () => {
  const current = { taskId: task, executionEpoch: 4, attempt: 2, inputRevision: 7 };
  const matching: ExecutionEventFence = { taskId: task, executionEpoch: 4, attempt: 2, inputRevision: 7 };
  assert.deepEqual(fenceExecutionEvent(current, matching), { accepted: true });
  assert.doesNotThrow(() => assertExecutionEventFence(current, matching));

  const oldEpoch = fenceExecutionEvent(current, { ...matching, executionEpoch: 3 });
  assert.equal(isLateEventRejection(oldEpoch), true);
  assert.deepEqual(oldEpoch, {
    accepted: false,
    stale: true,
    reason: 'epoch-mismatch',
    sourceEpoch: 3,
    currentEpoch: 4,
  });
  assert.throws(() => assertExecutionEventFence(current, { ...matching, attempt: 1 }), EpochError);
  assert.throws(() => assertExecutionEventFence(current, { ...matching, inputRevision: 6 }), EpochError);
  assert.throws(() => assertExecutionEventFence(current, { ...matching, taskId: id('task', 'task-b') }), EpochError);
  assert.throws(() => fenceExecutionEvent(current, { ...matching, executionEpoch: 0 }), ContractError);
});

test('steer requires a control-channel permission bound to the target epoch', () => {
  const input = {
    source: 'control' as const,
    actorKind: 'human-operator' as const,
    hasStopPermission: true,
    targetEpoch: 4,
    currentEpoch: 4,
    targetOrganId: organ,
    currentOrganId: organ,
    targetTaskId: task,
    currentTaskId: task,
    currentState: 'running' as const,
  };
  assert.doesNotThrow(() => assertSteerPermission(input));
  assert.deepEqual(planStopRequest(input), { intent: 'request-stop', state: 'settling' });
  assert.throws(() => assertSteerPermission({ ...input, source: 'business-payload' }), PermissionError);
  assert.throws(() => assertSteerPermission({ ...input, actorKind: 'agent' }), PermissionError);
  assert.throws(() => assertSteerPermission({ ...input, hasStopPermission: false }), PermissionError);
  assert.throws(() => assertSteerPermission({ ...input, targetEpoch: 5 }), PermissionError);
  assert.throws(() => assertSteerPermission({ ...input, targetOrganId: id('organ', 'organ-b') }), PermissionError);
  assert.throws(() => assertSteerPermission({ ...input, targetTaskId: id('task', 'task-b') }), PermissionError);
  assert.throws(() => planStopRequest({ ...input, currentState: 'stopped' }), PermissionError);
});

test('stop is complete only after standard settle and stopped checkpoint evidence', () => {
  const settle = {
    currentState: 'settling' as const,
    operationId: operation,
    evidenceRefs: [evidence('settle')],
  };
  assert.deepEqual(planStopSettle(settle), {
    intent: 'settle-stop',
    state: 'stopped',
    operationId: operation,
    evidenceRefs: settle.evidenceRefs,
  });
  assert.throws(() => planStopSettle({ ...settle, evidenceRefs: [] }), PermissionError);
  assert.throws(() => planStopSettle({ ...settle, currentState: 'running' }), CoreError);
  assert.equal(stopRequestIsStopped(), false);
});

test('background error policy retries within a bound and foreground errors require attention first', () => {
  const retry = classifyErrorPolicy({
    layer: 'background',
    attempt: 1,
    maxAttempts: 3,
    sameCondition: false,
    affectsUserPromise: false,
    requiresUserInput: false,
    recoverable: true,
    ownerId: 'operation-owner',
  });
  assert.equal(retry.disposition, 'retry');
  assert.equal(retry.retryAllowed, true);
  assert.deepEqual(retry.nextAction, { kind: 'recover', ref: 'retry' });

  const bounded = classifyErrorPolicy({
    layer: 'background',
    attempt: 3,
    maxAttempts: 3,
    sameCondition: true,
    conditionRef: 'dependency-ready',
    affectsUserPromise: false,
    requiresUserInput: false,
    recoverable: true,
    ownerId: 'operation-owner',
  });
  assert.equal(bounded.disposition, 'wait');
  assert.equal(bounded.retryAllowed, false);
  assert.deepEqual(bounded.nextAction, { kind: 'wait', ref: 'dependency-ready' });

  const foreground = classifyErrorPolicy({
    layer: 'background',
    attempt: 1,
    maxAttempts: 3,
    sameCondition: false,
    affectsUserPromise: true,
    requiresUserInput: false,
    recoverable: true,
    ownerId: 'task-owner',
    escalationTarget: 'task-attention',
  });
  assert.equal(foreground.layer, 'foreground');
  assert.equal(foreground.disposition, 'attention');
  assert.equal(foreground.mustPublishAttentionBeforeSettle, true);
  assert.throws(() => classifyErrorPolicy({
    layer: 'background',
    attempt: 1,
    maxAttempts: 1,
    sameCondition: true,
    affectsUserPromise: false,
    requiresUserInput: false,
    recoverable: false,
    ownerId: 'operation-owner',
  }), CoreError);
});

test('checkpoint rules enforce chain, recovery responsibility, next action, and stop evidence', () => {
  const first = checkpoint(1, null);
  assert.doesNotThrow(() => assertCheckpointRecoveryResponsibility({ checkpoint: first, previous: null, ownerId: 'task-owner' }));
  assert.throws(() => assertCheckpointOutcome('running'), CoreError);
  assert.throws(
    () => assertCheckpointRecoveryResponsibility({
      checkpoint: { ...first, next: { kind: 'continue' } },
      previous: null,
      ownerId: 'task-owner',
    }),
    CoreError,
  );
  assert.throws(
    () => assertCheckpointRecoveryResponsibility({
      checkpoint: { ...first, outcome: 'stopped', next: { kind: 'stop', ref: 'stopped' } },
      previous: null,
      ownerId: 'task-owner',
    }),
    CoreError,
  );
  assert.throws(() => assertCheckpointNextActionForTest(), CoreError);
  assert.throws(
    () => assertCheckpointRecoveryResponsibility({
      checkpoint: checkpoint(2, first.id),
      previous: first,
      ownerId: '',
    }),
    CoreError,
  );

  const second = checkpoint(2, first.id, {
    outcome: 'succeeded',
    next: { kind: 'continue', ref: 'next-node' },
  });
  assert.doesNotThrow(() => assertCheckpointRecoveryResponsibility({ checkpoint: second, previous: first, ownerId: 'task-owner' }));
});

test('health classification is Harness-owned, dimensionally aggregated, and TTL-aware', () => {
  const healthy = classifyHealth({
    functions: [
      { functionId: 'heartbeat', dimension: 'liveness', status: 'healthy', evidenceRefs: [evidence('heartbeat')] },
      { functionId: 'storage', dimension: 'continuity', status: 'healthy', evidenceRefs: [evidence('storage')] },
    ],
  });
  assert.equal(healthy, 'healthy');
  assert.equal(classifyHealth({ functions: [{ functionId: 'stop', dimension: 'readiness', status: 'degraded', evidenceRefs: [evidence('stop')] }] }), 'degraded');
  assert.equal(classifyHealth({ functions: [{ functionId: 'stop', dimension: 'readiness', status: 'failed', evidenceRefs: [evidence('stop')] }] }), 'unhealthy');
  assert.equal(classifyHealth({ functions: [{ functionId: 'storage', dimension: 'continuity', status: 'unknown', evidenceRefs: [evidence('storage')] }] }), 'unknown');
  assert.equal(classifyHealth({ requiresAttention: true, functions: [{ functionId: 'heartbeat', dimension: 'liveness', status: 'healthy', evidenceRefs: [evidence('heartbeat')] }] }), 'attention');
  assert.throws(() => classifyHealth({ functions: [{ functionId: 'heartbeat', dimension: 'liveness', status: 'healthy', evidenceRefs: [] }] }), HealthError);

  const snapshot: OrganHealthSnapshot = {
    organId: organ,
    checkedAt: '2026-09-11T00:00:00.000Z',
    expiresAt: '2099-09-11T00:00:00.000Z',
    overall: 'healthy',
    functions: [{ functionId: 'heartbeat', status: 'healthy', measurements: [], evidenceRefs: [evidence('heartbeat')] }],
  };
  assert.equal(classifyHealthSnapshot({ snapshot }), 'healthy');
  assert.equal(classifyHealthSnapshot({ snapshot: { ...snapshot, expiresAt: '2000-01-01T00:00:00.000Z' } }), 'unknown');
  assert.doesNotThrow(() => assertHarnessHealthPublisher({ actorKind: 'harness-health-manager', source: 'harness' }));
  assert.doesNotThrow(() => assertHealthSnapshotOwnership(snapshot, { actorKind: 'harness-health-manager', source: 'harness' }));
  assert.throws(
    () => assertHealthSnapshotOwnership({ ...snapshot, overall: 'unhealthy' }, { actorKind: 'harness-health-manager', source: 'harness' }),
    HealthError,
  );
  assert.throws(() => assertHarnessHealthPublisher({ actorKind: 'agent', source: 'agent' }), HealthError);
});

function assertCheckpointNextActionForTest(): void {
  assertCheckpointRecoveryResponsibility({
    checkpoint: checkpoint(1, null, {
      outcome: 'stopped',
      evidenceRefs: [evidence('settle')],
      next: { kind: 'continue', ref: 'next' },
    }),
    previous: null,
    ownerId: 'task-owner',
  });
}
