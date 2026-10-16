import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  id,
  type AgentLoopCheckpointRef,
  type AgentModeCapabilityProfile,
  type ContextHistoryRecord,
  type JournalCommitRef,
  type ObservationBatch,
  type ObservationDelta,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import { AgentLoopRuntime, type AgentLoopActor, type AgentLoopStartRequest } from '../../../packages/runtime/src/agent-loop/runtime.js';
import { AgentLoopRuntimeError } from '../../../packages/runtime/src/agent-loop/errors.js';
import type {
  ContextHistoryPort,
  ContextHistoryReadQuery,
  ContextHistoryReadResult,
} from '../../../packages/runtime/src/checkpoints/ports.js';

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

function durableContext() {
  return {
    stablePrefix: [{ ref: 'stable:goal' }],
    indexRefs: [{ ref: 'index:task' }],
    dynamicHead: [{ ref: 'head:latest-turn' }],
    repairRefs: [{ responsibility: 'recover:original' }],
  };
}

/**
 * Real in-memory ContextHistoryPort. `commit` mints a physical receipt and stores the
 * record; `readContextCommit` returns the exact committed body so the runtime readback
 * check runs against genuine state instead of a stubbed value.
 */
class MemoryContextHistory implements ContextHistoryPort {
  private sequence = 0;
  private readonly committed = new Map<string, { readonly ref: JournalCommitRef; readonly record: ContextHistoryRecord }>();

  async commit(record: ContextHistoryRecord, _expected: JournalCommitRef | null): Promise<JournalCommitRef> {
    this.sequence += 1;
    const ref: JournalCommitRef = {
      commitId: `context:${record.agentRuntimeId}:${this.sequence}`,
      journalSeq: this.sequence,
      recordDigest: digest(record),
    };
    this.committed.set(ref.commitId, { ref, record });
    return ref;
  }

  async readContextCommit(_scope: ScopeRef, ref: JournalCommitRef): Promise<ContextHistoryRecord> {
    const entry = this.committed.get(ref.commitId);
    if (!entry) throw new Error('exact context commit is missing');
    return entry.record;
  }

  async readContextHistory(query: ContextHistoryReadQuery): Promise<ContextHistoryReadResult> {
    const entries = [...this.committed.values()].filter(
      (entry) => query.agentRuntimeId === undefined || entry.record.agentRuntimeId === query.agentRuntimeId,
    );
    const tail = entries.at(-1);
    return {
      views: entries.map((entry) => entry.record.contextView),
      replacements: entries.flatMap((entry) => (entry.record.replacement ? [entry.record.replacement] : [])),
      currentContextCommitRef: tail ? tail.ref : null,
    };
  }
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
    durableContext: durableContext(),
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  };
}

async function createRuntime(): Promise<AgentLoopRuntime> {
  return AgentLoopRuntime.start(createRuntimeRequest(), new MemoryContextHistory());
}

function actor(runtime: AgentLoopRuntime): AgentLoopActor {
  return {
    agentRuntimeId: runtime.snapshot().modeState.agentRuntimeId,
    leaseId: runtime.snapshot().lease.leaseId,
  };
}

async function open(runtime: AgentLoopRuntime): Promise<AgentLoopActor> {
  const currentActor = actor(runtime);
  await runtime.openObservationScope({
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

test('runtime loop performs observation batch, delta replacement, and checkpoint reentry', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  const result = await runtime.applyObservationDelta(currentActor, delta(runtime), { durableContext: durableContext() });
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

test('runtime loop transitions observation into orchestration with a new lease', async () => {
  const runtime = await createRuntime();
  const observationActor = await open(runtime);
  await runtime.mergeObservationBatch(observationActor, batch(runtime));
  await runtime.applyObservationDelta(observationActor, delta(runtime), { durableContext: durableContext() });
  const before = runtime.snapshot();
  const transition = await runtime.transitionMode({
    actor: actor(runtime),
    toMode: 'orchestration',
    reason: 'observation-complete',
    deltaIds: ['delta-1'],
    summary: 'observation is summarized for orchestration',
    contextViewRef: 'runtime-agent-loop:context:3',
    contextDigest: digest(['observation:task-state']),
    activeRefs: ['observation:task-state', 'plan:input'],
    omittedRefs: ['raw:event-1'],
    durableContext: durableContext(),
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

test('runtime loop fences unknown owners, stale leases, duplicates, and closed scopes', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  await assert.rejects(
    () => runtime.mergeObservationBatch({ ...currentActor, agentRuntimeId: 'other-runtime' }, batch(runtime)),
    (error: unknown) => error instanceof AgentLoopRuntimeError && error.code === 'unknown-owner',
  );
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  await assert.rejects(
    () => runtime.mergeObservationBatch(currentActor, batch(runtime)),
    /unaccounted event gap|duplicate observation batch/,
  );
  const result = await runtime.applyObservationDelta(currentActor, delta(runtime), { durableContext: durableContext() });
  assert.equal(result.checkpoint.sequence, 2);
  await assert.rejects(
    () => runtime.closeObservationScope(currentActor),
    /stale/,
  );
  await assert.rejects(
    () => runtime.closeObservationScope(actor(runtime)),
    /unknown observation scope|observation scope is closed/,
  );
  await assert.rejects(
    () => runtime.replaceContext(currentActor, {
      deltaIds: ['delta-2'],
      summary: 'stale context replacement',
      contextViewRef: 'context:stale',
      contextDigest: 'digest:stale',
      activeRefs: ['x'],
      omittedRefs: [],
      durableContext: durableContext(),
    }),
    /stale|expired|mismatch/,
  );
});

test('runtime loop enforces deferred-event and scope budgets', async () => {
  const runtime = await AgentLoopRuntime.start({
    agentRuntimeId: 'runtime-budget',
    role: 'orchestration',
    mode: 'observation',
    profiles: [observationProfile],
    budget: { maxModeTransitions: 0, maxObservationScopes: 1, maxContextReplacements: 1, maxDeferredEvents: 1 },
    scope,
    executionEpoch: 1,
    permissionRevision: 'permissions-1',
    observationStreamId: 'stream-budget',
    durableContext: durableContext(),
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  }, new MemoryContextHistory());
  const currentActor = actor(runtime);
  await runtime.openObservationScope({ actor: currentActor, kind: 'task', scope, readableRefs: [], capabilities: ['read-task'] });
  const batchInput = batch(runtime);
  const deferred = { ...batchInput, batchId: 'deferred', priority: 'deferred' as const, idempotencyKey: 'deferred-key' };
  await assert.rejects(() => runtime.mergeObservationBatch(currentActor, { ...deferred, eventIds: ['event-1', 'event-2'], eventSequences: [1, 2], watermark: { streamId: 'stream-budget', sequence: 2 } }), /budget exhausted/);
  await assert.rejects(() => runtime.openObservationScope({ actor: currentActor, kind: 'task', scope, readableRefs: [], capabilities: ['read-task'] }), /already open/);
});

test('runtime loop never reopens a closed scope identity', async () => {
  const runtime = await createRuntime();
  const firstActor = await open(runtime);
  const closedScopeId = runtime.snapshot().modeState.observationScopeId;
  await runtime.closeObservationScope(firstActor, closedScopeId);

  await runtime.openObservationScope({
    actor: actor(runtime),
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  const reopened = runtime.snapshot();
  assert.notEqual(reopened.modeState.observationScopeId, closedScopeId);
  await assert.rejects(
    () => runtime.mergeObservationBatch(actor(runtime), {
      ...batch(runtime),
      observationScopeId: closedScopeId,
    }),
    /observation scope is closed/,
  );
});

test('runtime loop keeps observation cursors aligned after context replacement', async () => {
  const runtime = await createRuntime();
  const firstActor = await open(runtime);
  await runtime.replaceContext(firstActor, {
    deltaIds: ['manual-delta-1'],
    summary: 'compact observed context',
    contextViewRef: 'runtime-agent-loop:context:compact',
    contextDigest: digest(['task:state']),
    activeRefs: ['task:state'],
    omittedRefs: ['raw:event-0'],
    durableContext: durableContext(),
  });

  const currentActor = actor(runtime);
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  const nextDelta = { ...delta(runtime), deltaId: 'delta-after-replacement', idempotencyKey: 'delta-after-replacement-key' };
  const result = await runtime.applyObservationDelta(currentActor, nextDelta, { durableContext: durableContext() });
  assert.equal(result.replacement.baseCheckpoint.checkpointId.value, 'runtime-agent-loop-2');
  assert.equal(runtime.snapshot().checkpoint.sequence, 3);
});

test('runtime loop rejects a delta that does not consume the complete observed batch', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  const observed = batch(runtime);
  await runtime.mergeObservationBatch(currentActor, {
    ...observed,
    eventIds: ['event-1', 'event-2', 'event-3', 'event-4', 'event-5'],
    eventSequences: [1, 2, 3, 4, 5],
    watermark: { streamId: 'stream-agent-loop', sequence: 5 },
  });
  await assert.rejects(
    () => runtime.applyObservationDelta(currentActor, delta(runtime), { durableContext: durableContext() }),
    /current observed batch watermark/,
  );
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.checkpoint.sequence, 1);
  assert.equal(snapshot.checkpointHistory.length, 1);
  assert.equal(snapshot.budgetUsage.contextReplacements, 0);
});

test('runtime loop leaves no orphan checkpoint after a rejected replacement', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  const before = runtime.snapshot();
  await assert.rejects(
    () => runtime.replaceContext(currentActor, {
      deltaIds: ['invalid-replacement'],
      summary: 'invalid same context replacement',
      contextViewRef: before.contextView.contextViewRef,
      contextDigest: 'digest:invalid',
      activeRefs: ['task:state'],
      omittedRefs: [],
      durableContext: durableContext(),
    }),
    /must change the active context view/,
  );
  const after = runtime.snapshot();
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.equal(after.checkpointHistory.length, before.checkpointHistory.length);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
});

test('runtime loop does not commit replacement state when transition validation fails', async () => {
  const runtime = await createRuntime();
  const currentActor = actor(runtime);
  const before = runtime.snapshot();
  await assert.rejects(
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
      durableContext: durableContext(),
    }),
    /agent mode transition reason is invalid/,
  );
  const after = runtime.snapshot();
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.equal(after.checkpointHistory.length, before.checkpointHistory.length);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
  assert.equal(after.modeState.mode, before.modeState.mode);
});

test('runtime loop validates profiles and budgets before issuing a lease', async () => {
  await assert.rejects(
    () => AgentLoopRuntime.start({
      ...createRuntimeRequest(),
      profiles: [{ ...observationProfile, capabilityDigest: '' }],
    }, new MemoryContextHistory()),
    /mode capability digest is required/,
  );
  await assert.rejects(
    () => AgentLoopRuntime.start({
      ...createRuntimeRequest(),
      budget: { ...createRuntimeRequest().budget, maxModeTransitions: -1 },
    }, new MemoryContextHistory()),
    /maxModeTransitions must be a non-negative safe integer/,
  );
});

test('runtime loop validates scope identity and rejects close with pending observation events', async () => {
  await assert.rejects(
    () => AgentLoopRuntime.start({
      ...createRuntimeRequest(),
      scope: {
        ...scope,
        organId: { scope: 'task', value: 'malformed-organ' },
      } as unknown as ScopeRef,
    }, new MemoryContextHistory()),
    /runtime scope organ id is invalid/,
  );

  const runtime = await createRuntime();
  const currentActor = actor(runtime);
  await assert.rejects(
    () => runtime.openObservationScope({
      actor: currentActor,
      kind: 'task',
      scope: {
        ...scope,
        taskId: { scope: 'cycle', value: 'malformed-task' },
      } as unknown as ScopeRef,
      readableRefs: [],
      capabilities: ['read-task'],
    }),
    /observation scope task id is invalid/,
  );
  await runtime.openObservationScope({
    actor: currentActor,
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  await assert.rejects(
    () => runtime.closeObservationScope(currentActor),
    /pending observation events/,
  );
  assert.equal(runtime.snapshot().observationScope?.observationScopeId, runtime.snapshot().modeState.observationScopeId);
});

test('runtime loop authorizes scope kind even when no capability is requested', async () => {
  const runtime = await createRuntime();
  await assert.rejects(
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

test('runtime loop does not rotate a lease when a reopened scope request is rejected', async () => {
  const runtime = await createRuntime();
  const firstActor = await open(runtime);
  await runtime.closeObservationScope(firstActor);
  const before = runtime.snapshot();
  await assert.rejects(
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

test('runtime loop rejects a mode transition with an unconsumed observation batch', async () => {
  const runtime = await createRuntime();
  const currentActor = await open(runtime);
  await runtime.mergeObservationBatch(currentActor, batch(runtime));
  const before = runtime.snapshot();
  await assert.rejects(
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
      durableContext: durableContext(),
    }),
    /pending observation events/,
  );
  const after = runtime.snapshot();
  assert.equal(after.modeState.mode, before.modeState.mode);
  assert.equal(after.checkpoint.sequence, before.checkpoint.sequence);
  assert.deepEqual(after.budgetUsage, before.budgetUsage);
});
