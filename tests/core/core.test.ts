import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoreError,
  CheckpointError,
  EpochError,
  HealthError,
  PermissionError,
  advanceConsumerCursor,
  assertExecutionEventFence,
  assertAgentBindingMatchesRuntime,
  assertCheckpointClosureCanReenter,
  assertCheckpointClosureCommitted,
  assertHarnessHealthPublisher,
  assertHealthSnapshotOwnership,
  assertCheckpointOutcome,
  assertCheckpointRecoveryStateRef,
  assertCheckpointRecoveryResponsibility,
  assertRetryNotExhausted,
  assertRuntimeBindingEpoch,
  assertRuntimeBindingPermission,
  assertRuntimeProviderBindingLocked,
  assertSteerPermission,
  canRetryNow,
  canTransitionLifecycle,
  canTransitionOrgan,
  classifyErrorPolicy,
  classifyHealth,
  classifyHealthSnapshot,
  fenceExecutionEvent,
  isLateEventRejection,
  isRetryPending,
  isTerminalLifecycleState,
  planStopRequest,
  planStopSettle,
  stopRequestIsStopped,
  transitionLifecycle,
  type ExecutionEventFence,
} from '../../packages/core/src/index.js';
import {
  ContractError, consumerKey, id,
  type AgentProviderBinding, type Checkpoint, type CheckpointClosureRecord, type CheckpointReentryRecord,
  type EventConsumerCursor, type EventConsumerReceipt, type EventRetryObligation, type EvidenceRef, type OrganHealthSnapshot, type RuntimeBinding, type ScopeRef,
} from '../../packages/contracts/src/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: ScopeRef = { organId: organ, taskId: task };
const operation = id('operation', 'operation-a');

function evidence(label: string, scopeRef: ScopeRef = scope): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: label,
    scope: scopeRef,
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
  assert.throws(() => assertExecutionEventFence(current, { ...matching, executionEpoch: 3 }), EpochError);
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

  const operationScope: ScopeRef = { ...scope, operationId: operation };
  const businessFirst = checkpoint(1, null);
  const stoppedAfterBusiness = checkpoint(2, businessFirst.id, {
    scope: operationScope,
    outcome: 'stopped',
    recoveryStateRef: evidence('recovery-stopped', operationScope),
    evidenceRefs: [evidence('settle-stopped', operationScope)],
    next: { kind: 'stop', ref: 'stopped' },
  });
  assert.doesNotThrow(() => assertCheckpointRecoveryResponsibility({ checkpoint: stoppedAfterBusiness, previous: businessFirst, ownerId: 'task-owner' }));
  assert.throws(() => assertCheckpointRecoveryResponsibility({ checkpoint: { ...stoppedAfterBusiness, recoveryStateRef: evidence('recovery-mismatch') }, previous: businessFirst, ownerId: 'task-owner' }), CheckpointError);
  assert.throws(() => assertCheckpointRecoveryResponsibility({ checkpoint: { ...stoppedAfterBusiness, evidenceRefs: [evidence('evidence-mismatch')] }, previous: businessFirst, ownerId: 'task-owner' }), CheckpointError);
  assert.throws(() => assertCheckpointRecoveryResponsibility({
    checkpoint: checkpoint(3, stoppedAfterBusiness.id, {
      scope: operationScope,
      outcome: 'succeeded',
      recoveryStateRef: evidence('recovery-after-stopped', operationScope),
      next: { kind: 'continue', ref: 'next-node' },
    }),
    previous: stoppedAfterBusiness,
    ownerId: 'task-owner',
  }), CheckpointError);
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

const taskRuntimeBinding = (overrides: Partial<RuntimeBinding> = {}): RuntimeBinding => ({
  runtimeId: 'runtime-a', agentInstanceId: 'agent-a', roleId: 'executor', taskId: task, assignmentId: 'assignment-a',
  executionEpoch: 4, scopeRef: 'organ-a::task-a', permissionRevision: 'permission-r1', capabilityDigest: 'sha256:capability-a',
  providerBindingId: 'binding-a', providerBindingDigest: 'sha256:provider-binding-a', bindingDigest: 'sha256:binding-a', ...overrides,
});
const providerBinding = (overrides: Partial<AgentProviderBinding> = {}): AgentProviderBinding => ({
  bindingId: 'binding-a', providerId: 'cc-local', protocol: 'responses', endpointRef: 'local-config', modelRef: 'model-a',
  configDigest: 'sha256:config-a', capabilityDigest: 'sha256:capability-a', bindingDigest: 'sha256:provider-binding-a',
  owner: 'harness', ...overrides,
});
const coreConsumerCursor = (overrides: Partial<EventConsumerCursor> = {}): EventConsumerCursor => ({
  consumerKey: consumerKey({ consumerOwner: 'event-owner', scopeRef: 'organ-a::task-a', contractVersion: 'v1' }),
  streamId: 'stream-a', lastHandledSequence: 2, ...overrides,
});
const coreConsumerReceipt = (overrides: Partial<EventConsumerReceipt> = {}): EventConsumerReceipt => ({
  consumerKey: coreConsumerCursor().consumerKey, messageId: 'message-a', streamId: 'stream-a', handledSequence: 3,
  disposition: 'applied', effectRefs: ['asset://effect-a'], ...overrides,
});
const coreRetryObligation = (overrides: Partial<EventRetryObligation> = {}): EventRetryObligation => ({
  retryKey: 'retry-a', consumerKey: coreConsumerCursor().consumerKey, messageId: 'message-a', streamId: 'stream-a',
  failedSequence: 3, attempt: 1, nextAttemptAt: '2020-01-01T00:00:00Z', ownerRef: 'event-owner', failureRef: 'fact://failure-a',
  state: 'pending', ...overrides,
});
const coreClosure = (overrides: Partial<CheckpointClosureRecord> = {}): CheckpointClosureRecord => ({
  checkpointId: id('checkpoint', 'checkpoint-a'), source: 'harness-control', closureReason: 'stop settled', executionEpoch: 4,
  committed: true, reentryAllowed: false, pendingOperations: [], unknownOperations: [], recoveryStateRef: evidence('recovery'),
  nextAction: { kind: 'stop', ref: 'stopped' }, closedAt: '2099-01-01T00:00:00Z', ...overrides,
});
const coreReentry = (overrides: Partial<CheckpointReentryRecord> = {}): CheckpointReentryRecord => ({
  checkpointId: id('checkpoint', 'checkpoint-a'), reentryId: 'reentry-a', executionEpoch: 5, fencedEpochs: [4],
  permissionRevision: 'permission-r2', contextViewRef: 'context://view-a', entryPhase: 'recovery', nextAction: 'continue',
  reentryRef: 'fact://reentry-a', ...overrides,
});

test('runtime bindings enforce task/interaction shape, permission revision, and epoch fence', () => {
  assert.doesNotThrow(() => assertRuntimeBindingPermission(taskRuntimeBinding(), 'permission-r1'));
  assert.doesNotThrow(() => assertRuntimeBindingEpoch(taskRuntimeBinding(), 4));
  assert.throws(() => assertRuntimeBindingPermission(taskRuntimeBinding(), 'permission-r2'), PermissionError);
  assert.throws(() => assertRuntimeBindingEpoch(taskRuntimeBinding(), 5), EpochError);

  assert.doesNotThrow(() => assertAgentBindingMatchesRuntime(taskRuntimeBinding(), {
    kind: 'task', taskId: task, assignmentId: 'assignment-a', executionEpoch: 4, bindingFingerprint: 'sha256:binding-a',
  }));
  assert.throws(() => assertAgentBindingMatchesRuntime(taskRuntimeBinding(), {
    kind: 'task', taskId: id('task', 'task-b'), assignmentId: 'assignment-a', executionEpoch: 4, bindingFingerprint: 'sha256:binding-a',
  }), PermissionError);
  assert.throws(() => assertAgentBindingMatchesRuntime(taskRuntimeBinding(), {
    kind: 'task', taskId: task, assignmentId: 'assignment-b', executionEpoch: 4, bindingFingerprint: 'sha256:binding-a',
  }), PermissionError);
  assert.throws(() => assertAgentBindingMatchesRuntime(taskRuntimeBinding(), {
    kind: 'task', taskId: task, assignmentId: 'assignment-a', executionEpoch: 5, bindingFingerprint: 'sha256:binding-a',
  }), PermissionError);
  assert.throws(() => assertAgentBindingMatchesRuntime(taskRuntimeBinding(), {
    kind: 'task', taskId: task, assignmentId: 'assignment-a', executionEpoch: 4, bindingFingerprint: 'sha256:binding-b',
  }), PermissionError);
  assert.doesNotThrow(() => assertAgentBindingMatchesRuntime(
    taskRuntimeBinding({ taskId: undefined, assignmentId: undefined, interactionScopeId: 'interaction-a', bindingDigest: 'sha256:binding-i' }),
    { kind: 'interaction', interactionScopeId: 'interaction-a', bindingFingerprint: 'sha256:binding-i' },
  ));
  assert.throws(() => assertAgentBindingMatchesRuntime(taskRuntimeBinding(), {
    kind: 'interaction', interactionScopeId: 'interaction-a', bindingFingerprint: 'sha256:binding-a',
  }), PermissionError);
  assert.doesNotThrow(() => assertRuntimeProviderBindingLocked(taskRuntimeBinding(), providerBinding()));
  assert.throws(() => assertRuntimeProviderBindingLocked(taskRuntimeBinding(), providerBinding({ bindingId: 'binding-b' })), PermissionError);
  assert.throws(() => assertRuntimeProviderBindingLocked(taskRuntimeBinding(), providerBinding({ bindingDigest: 'sha256:provider-binding-b' })), PermissionError);
  assert.throws(() => assertRuntimeProviderBindingLocked(taskRuntimeBinding(), providerBinding({ capabilityDigest: 'sha256:capability-b' })), PermissionError);
});

test('consumer cursor advances monotonically and retry obligations stay bounded', () => {
  const advanced = advanceConsumerCursor(coreConsumerCursor(), coreConsumerReceipt({ handledSequence: 3 }));
  assert.equal(advanced.lastHandledSequence, 3);
  const idempotent = advanceConsumerCursor(advanced, coreConsumerReceipt({ handledSequence: 3, disposition: 'duplicate', effectRefs: [] }));
  assert.equal(idempotent.lastHandledSequence, 3);
  const replayed = advanceConsumerCursor(advanced, coreConsumerReceipt({ handledSequence: 1 }));
  assert.equal(replayed.lastHandledSequence, 3);
  assert.throws(() => advanceConsumerCursor(coreConsumerCursor(), coreConsumerReceipt({ handledSequence: 4 })), CoreError);
  assert.throws(() => advanceConsumerCursor(coreConsumerCursor(), coreConsumerReceipt({ streamId: 'stream-b' })), CoreError);
  assert.throws(() => advanceConsumerCursor(coreConsumerCursor(), coreConsumerReceipt({ consumerKey: 'other-key' })), CoreError);

  const pending = coreRetryObligation();
  assert.equal(isRetryPending(pending), true);
  assert.equal(canRetryNow(pending, { maxAttempts: 3 }), true);
  assert.doesNotThrow(() => assertRetryNotExhausted(pending, { maxAttempts: 3 }));
  assert.equal(canRetryNow(pending, { maxAttempts: 1 }), false);
  assert.equal(canRetryNow(coreRetryObligation({ state: 'exhausted' }), { maxAttempts: 3 }), false);
  assert.throws(() => assertRetryNotExhausted(coreRetryObligation({ state: 'exhausted' }), { maxAttempts: 3 }), CoreError);
  assert.equal(isRetryPending(coreRetryObligation({ state: 'cancelled' })), false);
  assert.throws(() => assertRetryNotExhausted(coreRetryObligation({ state: 'cancelled' }), { maxAttempts: 3 }), CoreError);
  assert.throws(() => canRetryNow(pending, { maxAttempts: 0 }), CoreError);
});

test('checkpoint closure committed fact does not imply reentry permission', () => {
  assert.doesNotThrow(() => assertCheckpointClosureCommitted(coreClosure()));
  assert.throws(() => assertCheckpointClosureCommitted(coreClosure({ committed: false })), CheckpointError);
  assert.throws(() => assertCheckpointClosureCommitted(coreClosure({ committed: false, reentryAllowed: true })), CheckpointError);
  assert.doesNotThrow(() => assertCheckpointClosureCommitted(coreClosure({ pendingOperations: ['op://pending'], unknownOperations: ['op://unknown'] })));
  assert.throws(() => assertCheckpointClosureCanReenter(coreClosure({ reentryAllowed: false }), coreReentry()), CheckpointError);
  assert.throws(() => assertCheckpointClosureCanReenter(coreClosure({ committed: false, reentryAllowed: true }), coreReentry()), CheckpointError);
  assert.throws(() => assertCheckpointClosureCanReenter(coreClosure({ unknownOperations: ['op://unknown'], reentryAllowed: false }), coreReentry()), CheckpointError);
  assert.throws(() => assertCheckpointClosureCanReenter(coreClosure({ reentryAllowed: true }), coreReentry({ fencedEpochs: [] })), CheckpointError);
  assert.throws(() => assertCheckpointClosureCanReenter(coreClosure({ reentryAllowed: true }), coreReentry({ checkpointId: id('checkpoint', 'checkpoint-b') })), CheckpointError);
  assert.doesNotThrow(() => assertCheckpointClosureCanReenter(coreClosure({ reentryAllowed: true }), coreReentry()));
});
