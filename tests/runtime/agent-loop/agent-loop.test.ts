import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  id,
  type AgentLoopCheckpointRef,
  type AgentModeCapabilityProfile,
  type ObservationBatch,
  type ObservationDelta,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import { AgentLoopRuntime, type AgentLoopActor, type AgentLoopStartRequest } from '../../../packages/runtime/src/agent-loop/runtime.js';
import { AgentLoopRuntimeError } from '../../../packages/runtime/src/agent-loop/errors.js';

const scope: ScopeRef = {
  organId: id('organ', 'organ-agent-loop'),
  taskId: id('task', 'task-agent-loop'),
  cycleId: id('cycle', 'cycle-agent-loop'),
};

const observationProfile: AgentModeCapabilityProfile = {
  profileId: 'orchestration-observation-1',
  role: 'orchestration',
  mode: 'observation',
  observationScopes: ['task', 'evidence'],
  observationCapabilities: ['read-task', 'read-evidence'],
  orchestrationScope: 'project',
  orchestrationCapabilities: [],
  capabilityDigest: 'sha256:observation-profile',
};

const orchestrationProfile: AgentModeCapabilityProfile = {
  profileId: 'orchestration-orchestration-1',
  role: 'orchestration',
  mode: 'orchestration',
  observationScopes: ['task', 'evidence'],
  observationCapabilities: ['read-task', 'read-evidence'],
  orchestrationScope: 'project',
  orchestrationCapabilities: ['plan-project', 'assign-work'],
  capabilityDigest: 'sha256:orchestration-profile',
};

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function createRuntimeRequest(): AgentLoopStartRequest {
  return {
    agentRuntimeId: 'runtime-agent-loop',
    role: 'orchestration',
    mode: 'observation',
    profiles: [observationProfile, orchestrationProfile],
    budget: {
      maxModeTransitions: 2,
      maxObservationScopes: 2,
      maxContextReplacements: 4,
      maxDeferredEvents: 2,
    },
    scope,
    executionEpoch: 3,
    permissionRevision: 'permissions-1',
    observationStreamId: 'stream-agent-loop',
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  };
}

function createRuntime(): AgentLoopRuntime {
  return new AgentLoopRuntime(createRuntimeRequest());
}

function actor(runtime: AgentLoopRuntime): AgentLoopActor {
  return {
    agentRuntimeId: runtime.snapshot().modeState.agentRuntimeId,
    leaseId: runtime.snapshot().lease.leaseId,
  };
}

function open(runtime: AgentLoopRuntime): AgentLoopActor {
  const currentActor = actor(runtime);
  runtime.openObservationScope({
    actor: currentActor,
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  return currentActor;
}

function batch(runtime: AgentLoopRuntime): ObservationBatch {
  const snapshot = runtime.snapshot();
  return {
    batchId: 'batch-1',
    observationScopeId: snapshot.modeState.observationScopeId,
    executionEpoch: snapshot.modeState.executionEpoch,
    baseCheckpoint: snapshot.modeState.checkpoint,
    eventClass: 'observation',
    priority: 'normal',
    watermark: { streamId: 'stream-agent-loop', sequence: 1 },
    eventIds: ['event-1'],
    eventSequences: [1],
    correlationRefs: ['task:state'],
    idempotencyKey: 'batch-key-1',
  };
}

function delta(runtime: AgentLoopRuntime): ObservationDelta {
  const snapshot = runtime.snapshot();
  return {
    deltaId: 'delta-1',
    idempotencyKey: 'delta-key-1',
    deltaDigest: digest('delta-1'),
    observationScopeId: snapshot.modeState.observationScopeId,
    executionEpoch: snapshot.modeState.executionEpoch,
    baseCheckpoint: snapshot.modeState.checkpoint,
    watermark: { streamId: 'stream-agent-loop', sequence: 1 },
    observationRefs: ['observation:task-state'],
    eventSequences: [1],
    summaryRef: 'summary:task-state',
  };
}

test('runtime loop performs observation batch, delta replacement, and checkpoint reentry', () => {
  const runtime = createRuntime();
  const currentActor = open(runtime);
  runtime.mergeObservationBatch(currentActor, batch(runtime));
  const result = runtime.applyObservationDelta(currentActor, delta(runtime));
  const snapshot = runtime.snapshot();

  assert.equal(result.checkpoint.sequence, 2);
  assert.equal(result.replacement.baseCheckpoint.checkpointId.value, 'runtime-agent-loop-1');
  assert.equal(snapshot.checkpoint.sequence, 2);
  assert.equal(snapshot.contextView.activeRefs.includes('observation:task-state'), true);
  assert.deepEqual(snapshot.appliedDeltaIds, ['delta-1']);
  assert.equal(snapshot.observationScope, undefined);
  assert.equal(snapshot.budgetUsage.observationScopes, 1);
  assert.equal(snapshot.budgetUsage.contextReplacements, 1);
  assert.equal(snapshot.checkpoint.predecessor?.checkpointId.value, 'runtime-agent-loop-1');
});

test('runtime loop transitions observation into orchestration with a new lease', () => {
  const runtime = createRuntime();
  const observationActor = open(runtime);
  runtime.mergeObservationBatch(observationActor, batch(runtime));
  runtime.applyObservationDelta(observationActor, delta(runtime));
  const before = runtime.snapshot();
  const transition = runtime.transitionMode({
    actor: actor(runtime),
    toMode: 'orchestration',
    reason: 'observation-complete',
    deltaIds: ['delta-1'],
    summary: 'observation is summarized for orchestration',
    contextViewRef: 'runtime-agent-loop:context:3',
    contextDigest: digest(['observation:task-state']),
    activeRefs: ['observation:task-state', 'plan:input'],
    omittedRefs: ['raw:event-1'],
  });
  const after = runtime.snapshot();

  assert.equal(transition.fromMode, 'observation');
  assert.equal(transition.toMode, 'orchestration');
  assert.equal(after.modeState.mode, 'orchestration');
  assert.notEqual(after.lease.leaseId, before.lease.leaseId);
  assert.equal(after.lease.profileId, orchestrationProfile.profileId);
  assert.equal(after.checkpoint.sequence, 3);
  assert.equal(after.budgetUsage.modeTransitions, 1);
});

test('runtime loop fences unknown owners, stale leases, duplicates, and closed scopes', () => {
  const runtime = createRuntime();
  const currentActor = open(runtime);
  assert.throws(
    () => runtime.mergeObservationBatch({ ...currentActor, agentRuntimeId: 'other-runtime' }, batch(runtime)),
    (error: unknown) => error instanceof AgentLoopRuntimeError && error.code === 'unknown-owner',
  );
  runtime.mergeObservationBatch(currentActor, batch(runtime));
  assert.throws(
    () => runtime.mergeObservationBatch(currentActor, batch(runtime)),
    /unaccounted event gap|duplicate observation batch/,
  );
  const result = runtime.applyObservationDelta(currentActor, delta(runtime));
  assert.equal(result.checkpoint.sequence, 2);
  assert.throws(
    () => runtime.closeObservationScope(currentActor),
    /stale/,
  );
  assert.throws(
    () => runtime.closeObservationScope(actor(runtime)),
    /unknown observation scope|observation scope is closed/,
  );
  assert.throws(
    () => runtime.replaceContext(currentActor, {
      deltaIds: ['delta-2'],
      summary: 'stale context replacement',
      contextViewRef: 'context:stale',
      contextDigest: 'digest:stale',
      activeRefs: ['x'],
      omittedRefs: [],
    }),
    /stale|expired|mismatch/,
  );
});

test('runtime loop enforces deferred-event and scope budgets', () => {
  const runtime = new AgentLoopRuntime({
    agentRuntimeId: 'runtime-budget',
    role: 'orchestration',
    mode: 'observation',
    profiles: [observationProfile],
    budget: { maxModeTransitions: 0, maxObservationScopes: 1, maxContextReplacements: 1, maxDeferredEvents: 1 },
    scope,
    executionEpoch: 1,
    permissionRevision: 'permissions-1',
    observationStreamId: 'stream-budget',
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });
  const currentActor = actor(runtime);
  runtime.openObservationScope({ actor: currentActor, kind: 'task', scope, readableRefs: [], capabilities: ['read-task'] });
  const batchInput = batch(runtime);
  const deferred = { ...batchInput, batchId: 'deferred', priority: 'deferred' as const, idempotencyKey: 'deferred-key' };
  assert.throws(() => runtime.mergeObservationBatch(currentActor, { ...deferred, eventIds: ['event-1', 'event-2'], eventSequences: [1, 2], watermark: { streamId: 'stream-budget', sequence: 2 } }), /budget exhausted/);
  assert.throws(() => runtime.openObservationScope({ actor: currentActor, kind: 'task', scope, readableRefs: [], capabilities: ['read-task'] }), /already open/);
});

test('runtime loop never reopens a closed scope identity', () => {
  const runtime = createRuntime();
  const firstActor = open(runtime);
  const closedScopeId = runtime.snapshot().modeState.observationScopeId;
  runtime.closeObservationScope(firstActor, closedScopeId);

  runtime.openObservationScope({
    actor: actor(runtime),
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  const reopened = runtime.snapshot();
  assert.notEqual(reopened.modeState.observationScopeId, closedScopeId);
  assert.throws(
    () => runtime.mergeObservationBatch(actor(runtime), {
      ...batch(runtime),
      observationScopeId: closedScopeId,
    }),
    /observation scope is closed/,
  );
});

test('runtime loop keeps observation cursors aligned after context replacement', () => {
  const runtime = createRuntime();
  const firstActor = open(runtime);
  runtime.replaceContext(firstActor, {
    deltaIds: ['manual-delta-1'],
    summary: 'compact observed context',
    contextViewRef: 'runtime-agent-loop:context:compact',
    contextDigest: digest(['task:state']),
    activeRefs: ['task:state'],
    omittedRefs: ['raw:event-0'],
  });

  const currentActor = actor(runtime);
  runtime.mergeObservationBatch(currentActor, batch(runtime));
  const nextDelta = { ...delta(runtime), deltaId: 'delta-after-replacement', idempotencyKey: 'delta-after-replacement-key' };
  const result = runtime.applyObservationDelta(currentActor, nextDelta);
  assert.equal(result.replacement.baseCheckpoint.checkpointId.value, 'runtime-agent-loop-2');
  assert.equal(runtime.snapshot().checkpoint.sequence, 3);
});

test('runtime loop rejects a delta that does not consume the complete observed batch', () => {
  const runtime = createRuntime();
  const currentActor = open(runtime);
  const observed = batch(runtime);
  runtime.mergeObservationBatch(currentActor, {
    ...observed,
    eventIds: ['event-1', 'event-2', 'event-3', 'event-4', 'event-5'],
    eventSequences: [1, 2, 3, 4, 5],
    watermark: { streamId: 'stream-agent-loop', sequence: 5 },
  });
  assert.throws(
    () => runtime.applyObservationDelta(currentActor, delta(runtime)),
    /current observed batch watermark/,
  );
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.checkpoint.sequence, 1);
  assert.equal(snapshot.checkpointHistory.length, 1);
  assert.equal(snapshot.budgetUsage.contextReplacements, 0);
});

test('runtime loop leaves no orphan checkpoint after a rejected replacement', () => {
  const runtime = createRuntime();
  const currentActor = open(runtime);
  const before = runtime.snapshot();
  assert.throws(
    () => runtime.replaceContext(currentActor, {
      deltaIds: ['invalid-replacement'],
      summary: 'invalid same context replacement',
      contextViewRef: before.contextView.contextViewRef,
      contextDigest: 'digest:invalid',
      activeRefs: ['task:state'],
      omittedRefs: [],
    }),
    /must change the active context view/,
  );
  const after = runtime.snapshot();
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.equal(after.checkpointHistory.length, before.checkpointHistory.length);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
});

test('runtime loop does not commit replacement state when transition validation fails', () => {
  const runtime = createRuntime();
  const currentActor = actor(runtime);
  const before = runtime.snapshot();
  assert.throws(
    () => runtime.transitionMode({
      actor: currentActor,
      toMode: 'orchestration',
      reason: 'invalid-reason' as 'observation-complete',
      deltaIds: ['transition-delta'],
      summary: 'invalid transition',
      contextViewRef: 'runtime-agent-loop:context:invalid',
      contextDigest: 'digest:invalid',
      activeRefs: ['plan:input'],
      omittedRefs: [],
    }),
    /agent mode transition reason is invalid/,
  );
  const after = runtime.snapshot();
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.equal(after.checkpointHistory.length, before.checkpointHistory.length);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
  assert.equal(after.modeState.mode, before.modeState.mode);
});

test('runtime loop validates profiles and budgets before issuing a lease', () => {
  assert.throws(
    () => new AgentLoopRuntime({
      ...createRuntimeRequest(),
      profiles: [{ ...observationProfile, capabilityDigest: '' }],
    }),
    /mode capability digest is required/,
  );
  assert.throws(
    () => new AgentLoopRuntime({
      ...createRuntimeRequest(),
      budget: { ...createRuntimeRequest().budget, maxModeTransitions: -1 },
    }),
    /maxModeTransitions must be a non-negative safe integer/,
  );
});

test('runtime loop authorizes scope kind even when no capability is requested', () => {
  const runtime = createRuntime();
  assert.throws(
    () => runtime.openObservationScope({
      actor: actor(runtime),
      kind: 'memory',
      scope,
      readableRefs: [],
      capabilities: [],
    }),
    /observation scope kind is not granted/,
  );
  assert.equal(runtime.snapshot().lease.leaseId, 'runtime-agent-loop:lease:1');
});

test('runtime loop does not rotate a lease when a reopened scope request is rejected', () => {
  const runtime = createRuntime();
  const firstActor = open(runtime);
  runtime.closeObservationScope(firstActor);
  const before = runtime.snapshot();
  assert.throws(
    () => runtime.openObservationScope({
      actor: actor(runtime),
      kind: 'task',
      scope,
      readableRefs: ['duplicate', 'duplicate'],
      capabilities: ['read-task'],
    }),
    /observation readable refs contains duplicates/,
  );
  const after = runtime.snapshot();
  assert.equal(after.lease.leaseId, before.lease.leaseId);
  assert.equal(after.observationScope, undefined);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
});

test('runtime loop rejects a mode transition with an unconsumed observation batch', () => {
  const runtime = createRuntime();
  const currentActor = open(runtime);
  runtime.mergeObservationBatch(currentActor, batch(runtime));
  const before = runtime.snapshot();
  assert.throws(
    () => runtime.transitionMode({
      actor: currentActor,
      toMode: 'orchestration',
      reason: 'observation-complete',
      deltaIds: ['pending-transition'],
      summary: 'must consume observation first',
      contextViewRef: 'runtime-agent-loop:context:pending',
      contextDigest: 'digest:pending',
      activeRefs: ['task:state'],
      omittedRefs: [],
    }),
    /pending observation events/,
  );
  const after = runtime.snapshot();
  assert.equal(after.modeState.mode, before.modeState.mode);
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
});
