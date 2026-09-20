import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoreError,
  CheckpointError,
  EpochError,
  HealthError,
  LifecycleError,
  PermissionError,
  advanceConsumerCursor,
  assertExecutionEventFence,
  assertAgentBindingMatchesRuntime,
  assertAgentLoopBudgetAvailable,
  assertAgentModeTransitionCurrent,
  assertContextReplacementCurrent,
  assertOperationEventFence,
  assertModeCapabilityGranted,
  assertModeLeaseCurrent,
  assertObservationBatchFresh,
  assertObservationDeltaCurrent,
  assertOperationFailureMatchesStatus,
  assertOperationLifecycleProjection,
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
  assertTerminalOperationStatus,
  assertTransitionOperationStatus,
  assertVerifyOnlyRecovery,
  canRetryNow,
  canTransitionLifecycle,
  canTransitionOrgan,
  canTransitionOperationStatus,
  classifyErrorPolicy,
  classifyHealth,
  classifyHealthSnapshot,
  fenceExecutionEvent,
  fenceOperationEvent,
  isLateEventRejection,
  isRetryPending,
  isTerminalLifecycleState,
  isTerminalOperationStatus,
  operationStatusToLifecycleState,
  planBlockedRecovery,
  planOperationCancellation,
  planReconcileRequiredResolution,
  planStopRequest,
  planStopSettle,
  stopRequestIsStopped,
  transitionLifecycle,
  transitionOperationStatus,
  classifyAgentLoopBudget,
  type ExecutionEventFence,
} from '../../packages/core/src/index.js';
import {
  ContractError, consumerKey, id,
  type AgentLoopBudget, type AgentLoopBudgetUsage, type AgentLoopCheckpointRef, type AgentModeCapabilityProfile, type AgentModeState,
  type AgentModeTransition, type ContextReplacement, type ModeLease, type ObservationBatch, type ObservationDelta,
  type OperationEvent,
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

test('agent loop fences stale leases, epochs, checkpoints, events, deltas, and capabilities', () => {
  const checkpoint: AgentLoopCheckpointRef = { checkpointId: id('checkpoint', 'loop-cp-1'), digest: 'sha256:loop-cp-1' };
  const profile: AgentModeCapabilityProfile = {
    profileId: 'execution-profile',
    role: 'execution',
    mode: 'observation',
    observationScopes: ['self', 'task', 'evidence'],
    observationCapabilities: ['read-assignment', 'read-evidence'],
    orchestrationScope: 'local',
    orchestrationCapabilities: ['schedule-self'],
    capabilityDigest: 'sha256:execution-profile',
  };
  const lease: ModeLease = {
    leaseId: 'lease-a',
    agentRuntimeId: 'runtime-a',
    role: 'execution',
    mode: 'observation',
    profileId: profile.profileId,
    executionEpoch: 4,
    checkpoint,
    observationScopeId: 'observation-a',
    permissionRevision: 'permission-r1',
    capabilityDigest: profile.capabilityDigest,
    state: 'active',
    issuedAt: '2026-09-19T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
  };
  const leaseFence = {
    agentRuntimeId: 'runtime-a',
    mode: 'observation' as const,
    executionEpoch: 4,
    checkpoint,
    observationScopeId: 'observation-a',
    leaseId: 'lease-a',
  };
  assert.doesNotThrow(() => assertModeLeaseCurrent(lease, leaseFence, new Date('2026-09-19T00:00:00Z')));
  assert.throws(() => assertModeLeaseCurrent({ ...lease, state: 'released' }, leaseFence), PermissionError);
  assert.throws(() => assertModeLeaseCurrent({ ...lease, leaseId: 'lease-old' }, leaseFence), PermissionError);
  assert.throws(() => assertModeLeaseCurrent({ ...lease, executionEpoch: 3 }, leaseFence), EpochError);
  assert.throws(() => assertModeLeaseCurrent({ ...lease, checkpoint: { ...checkpoint, digest: 'sha256:old' } }, leaseFence), CheckpointError);

  const modeState: AgentModeState = {
    agentRuntimeId: 'runtime-a',
    mode: 'observation',
    executionEpoch: 4,
    checkpoint,
    observationScopeId: 'observation-a',
    contextViewRef: 'context://view-a',
    leaseId: 'lease-a',
    transitionSeq: 1,
  };
  const transition: AgentModeTransition = {
    transitionId: 'transition-a',
    fromMode: 'observation',
    toMode: 'orchestration',
    executionEpoch: 4,
    baseCheckpoint: checkpoint,
    successorCheckpointId: id('checkpoint', 'loop-cp-2'),
    contextReplacementId: 'replacement-a',
    leaseId: 'lease-a',
    transitionSeq: 2,
    reason: 'observation-complete',
  };
  assert.doesNotThrow(() => assertAgentModeTransitionCurrent(transition, modeState, lease, new Date('2026-09-19T00:00:00Z')));
  assert.throws(() => assertAgentModeTransitionCurrent({ ...transition, executionEpoch: 3 }, modeState, lease), EpochError);
  assert.throws(() => assertAgentModeTransitionCurrent({ ...transition, transitionSeq: 1 }, modeState, lease), CoreError);

  const batch: ObservationBatch = {
    batchId: 'batch-a',
    observationScopeId: 'observation-a',
    executionEpoch: 4,
    baseCheckpoint: checkpoint,
    eventClass: 'observation',
    priority: 'normal',
    watermark: { streamId: 'events-a', sequence: 5 },
    eventIds: ['event-5'],
    eventSequences: [5],
    correlationRefs: ['assignment-a'],
    idempotencyKey: 'batch-key-5',
  };
  const inboxState = {
    streamId: 'events-a',
    executionEpoch: 4,
    checkpoint,
    observationScopeId: 'observation-a',
    watermark: 4,
    handledEventIds: ['event-4'],
    handledBatchKeys: ['batch-key-4'],
  };
  const advancedInbox = assertObservationBatchFresh(inboxState, batch);
  assert.equal(advancedInbox.watermark, 5);
  assert.throws(() => assertObservationBatchFresh(advancedInbox, batch), CoreError);
  assert.throws(() => assertObservationBatchFresh(advancedInbox, {
    ...batch,
    batchId: 'batch-b',
    eventIds: ['event-5'],
    idempotencyKey: 'batch-key-b',
  }), CoreError);
  assert.throws(() => assertObservationBatchFresh(inboxState, { ...batch, executionEpoch: 3 }), EpochError);
  assert.throws(() => assertObservationBatchFresh(inboxState, {
    ...batch,
    baseCheckpoint: { ...checkpoint, digest: 'sha256:old' },
  }), CheckpointError);
  assert.throws(() => assertObservationBatchFresh(inboxState, { ...batch, observationScopeId: 'observation-old' }), PermissionError);
  assert.throws(() => assertObservationBatchFresh(inboxState, {
    ...batch,
    watermark: { streamId: 'events-a', sequence: 100 },
    eventIds: ['event-100'],
    eventSequences: [100],
    idempotencyKey: 'batch-key-gap',
  }), CoreError);
  assert.throws(() => assertObservationBatchFresh(advancedInbox, {
    ...batch,
    batchId: 'batch-c',
    watermark: { streamId: 'events-a', sequence: 5 },
    eventIds: ['event-c'],
    idempotencyKey: 'batch-key-c',
  }), CoreError);

  const delta: ObservationDelta = {
    deltaId: 'delta-a',
    idempotencyKey: 'delta-key-a',
    deltaDigest: 'sha256:delta-a',
    observationScopeId: 'observation-a',
    executionEpoch: 4,
    baseCheckpoint: checkpoint,
    watermark: { streamId: 'events-a', sequence: 6 },
    observationRefs: ['event-6'],
    eventSequences: [6],
    summaryRef: 'asset://delta-a',
  };
  const deltaState = {
    executionEpoch: 4,
    checkpoint,
    observationScopeId: 'observation-a',
    watermark: { streamId: 'events-a', sequence: 5 },
    appliedDeltaIds: ['delta-old'],
    appliedDeltaKeys: ['delta-key-old'],
  };
  const advancedDelta = assertObservationDeltaCurrent(deltaState, delta);
  assert.equal(advancedDelta.watermark.sequence, 6);
  assert.throws(() => assertObservationDeltaCurrent(advancedDelta, delta), CoreError);
  assert.throws(() => assertObservationDeltaCurrent(advancedDelta, {
    ...delta,
    deltaId: 'delta-b',
    idempotencyKey: 'delta-key-a',
    watermark: { streamId: 'events-a', sequence: 7 },
    eventSequences: [7],
  }), CoreError);
  assert.throws(() => assertObservationDeltaCurrent(deltaState, { ...delta, executionEpoch: 3 }), EpochError);
  assert.throws(() => assertObservationDeltaCurrent(deltaState, {
    ...delta,
    baseCheckpoint: { ...checkpoint, digest: 'sha256:old' },
  }), CheckpointError);
  assert.throws(() => assertObservationDeltaCurrent(deltaState, {
    ...delta,
    watermark: { streamId: 'events-a', sequence: 5 },
    eventSequences: [5],
  }), CoreError);
  assert.throws(() => assertObservationDeltaCurrent(deltaState, {
    ...delta,
    watermark: { streamId: 'events-a', sequence: 100 },
    observationRefs: ['event-100'],
    eventSequences: [100],
    idempotencyKey: 'delta-key-gap',
  }), CoreError);

  assert.doesNotThrow(() => assertModeCapabilityGranted(profile, { kind: 'observation', scope: 'task', capability: 'read-assignment' }));
  assert.throws(
    () => assertModeCapabilityGranted(profile, { kind: 'orchestration', scope: 'project', capability: 'create-assignment' }),
    PermissionError,
  );
  assert.throws(
    () => assertModeCapabilityGranted(profile, { kind: 'observation', scope: 'project', capability: 'read-assignment' }),
    PermissionError,
  );
  assert.throws(
    () => assertModeCapabilityGranted(profile, { kind: 'observation', scope: 'task', capability: 'write-file' }),
    PermissionError,
  );
  const orchestrationProfile: AgentModeCapabilityProfile = {
    ...profile,
    profileId: 'orchestration-profile',
    role: 'orchestration',
    mode: 'orchestration',
    orchestrationScope: 'project',
    orchestrationCapabilities: ['create-assignment'],
    capabilityDigest: 'sha256:orchestration-profile',
  };
  assert.doesNotThrow(() => assertModeCapabilityGranted(orchestrationProfile, {
    kind: 'orchestration',
    scope: 'project',
    capability: 'create-assignment',
  }));

  const replacement: ContextReplacement = {
    replacementId: 'replacement-a',
    executionEpoch: 4,
    baseCheckpoint: checkpoint,
    successorCheckpoint: { checkpointId: id('checkpoint', 'loop-cp-2'), digest: 'sha256:loop-cp-2' },
    fromContextViewRef: 'context://view-a',
    toContextViewRef: 'context://view-b',
    toContextDigest: 'sha256:context-b',
    deltaIds: ['delta-a'],
    reason: 'observation',
    replacementDigest: 'sha256:replacement-a',
  };
  assert.doesNotThrow(() => assertContextReplacementCurrent(replacement, checkpoint, 4));
  assert.throws(() => assertContextReplacementCurrent(replacement, checkpoint, 5), EpochError);
  assert.throws(() => assertContextReplacementCurrent(replacement, { ...checkpoint, digest: 'sha256:old' }, 4), CheckpointError);

  const budget: AgentLoopBudget = {
    maxModeTransitions: 2,
    maxObservationScopes: 2,
    maxContextReplacements: 2,
    maxDeferredEvents: 1,
  };
  const usage: AgentLoopBudgetUsage = {
    modeTransitions: 1,
    observationScopes: 1,
    contextReplacements: 1,
    deferredEvents: 0,
  };
  assert.deepEqual(classifyAgentLoopBudget(budget, usage), { state: 'allowed' });
  assert.deepEqual(classifyAgentLoopBudget(budget, { ...usage, deferredEvents: 1 }), {
    state: 'blocked',
    reason: 'maxDeferredEvents',
    nextAction: { kind: 'wait', ref: 'agent-loop-budget:maxDeferredEvents' },
  });
  assert.throws(() => assertAgentLoopBudgetAvailable(budget, { ...usage, contextReplacements: 2 }), CoreError);
});

test('operation lifecycle maps to core state and fences stale epochs', () => {
  assert.equal(operationStatusToLifecycleState('accepted'), 'admitted');
  assert.equal(operationStatusToLifecycleState('queued'), 'waiting');
  assert.equal(operationStatusToLifecycleState('leased'), 'running');
  assert.equal(operationStatusToLifecycleState('verifying'), 'settling');
  assert.equal(operationStatusToLifecycleState('reconcile_required'), 'unknown');
  assert.equal(canTransitionOperationStatus('running', 'succeeded'), false);
  assert.equal(canTransitionOperationStatus('running', 'failed'), false);
  assert.equal(canTransitionOperationStatus('running', 'settling'), true);
  assert.equal(transitionOperationStatus('accepted', 'queued'), 'queued');
  assert.throws(() => assertTransitionOperationStatus('running', 'succeeded'), LifecycleError);
  assert.throws(() => assertOperationLifecycleProjection('running', 'succeeded'), LifecycleError);
  assert.doesNotThrow(() => assertTerminalOperationStatus('succeeded'));
  assert.throws(() => assertTerminalOperationStatus('blocked'), LifecycleError);
  assert.equal(isTerminalOperationStatus('failed'), true);
  assert.equal(isTerminalOperationStatus('blocked'), false);

  const verifyOnly = {
    status: 'verifying',
    executionMode: 'verify-only',
    requiresExecutor: false,
    requiresVerifier: true,
  } as const;
  assert.deepEqual(planBlockedRecovery({
    blockedAfter: 'admission',
    sideEffectState: 'none',
    retryAllowed: false,
  }), {
    status: 'queued',
    executionMode: 'execute',
    requiresExecutor: true,
    requiresVerifier: true,
  });
  assert.deepEqual(planBlockedRecovery({
    blockedAfter: 'execution',
    sideEffectState: 'none',
    retryAllowed: false,
  }), verifyOnly);
  assert.doesNotThrow(() => assertVerifyOnlyRecovery(verifyOnly));
  assert.deepEqual(planOperationCancellation('cancel_requested', {
    stopped: true,
    sideEffectState: 'none',
    evidenceRefs: [evidence('cancel')],
  }), { status: 'cancelled', reason: 'stopped' });
  assert.deepEqual(planReconcileRequiredResolution('reconcile_required', 'recovered'), {
    status: 'blocked',
    blockedAfter: 'reconcile',
  });

  const operationEvent: OperationEvent = {
    eventId: 'operation-event-a',
    schemaVersion: 1,
    kind: 'operation.started',
    operationId: operation,
    taskId: task,
    executionEpoch: 4,
    status: 'running',
    occurredAt: '2026-09-20T00:00:00Z',
    evidenceRefs: [evidence('operation-event')],
  };
  const current = { taskId: task, operationId: operation, executionEpoch: 4 };
  assert.doesNotThrow(() => assertOperationEventFence(current, operationEvent));
  assert.equal(isLateEventRejection(fenceOperationEvent(current, { ...operationEvent, executionEpoch: 3 })), true);
  assert.throws(() => assertOperationEventFence(current, { ...operationEvent, executionEpoch: 3 }), EpochError);
  assert.throws(() => assertOperationFailureMatchesStatus('running', {
    errorId: 'error-a',
    operationId: operation,
    owner: 'owner-a',
    phase: 'execution',
    failureClass: 'executor',
    message: 'failed',
    observedAt: '2026-09-20T00:00:00Z',
    impact: 'none',
    protectiveAction: 'stop',
    nextAction: { kind: 'stop' },
    evidenceRefs: [evidence('failure')],
  }), LifecycleError);
});
