import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type AgentModeCapabilityProfile,
  type ContextHistoryRecord,
  type JournalCommitRef,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import {
  AgentLoopRuntime,
  type ContextHistoryPort,
  type ContextHistoryReadQuery,
  type ContextHistoryReadResult,
} from '../../../packages/runtime/src/index.js';

const scope: ScopeRef = {
  organId: id('organ', 'organ-agent-loop-integration'),
  taskId: id('task', 'task-agent-loop-integration'),
  cycleId: id('cycle', 'cycle-agent-loop-integration'),
};

const profile: AgentModeCapabilityProfile = {
  profileId: 'integration-observation-profile',
  role: 'interaction',
  mode: 'observation',
  observationScopes: ['task'],
  observationCapabilities: ['read-task'],
  orchestrationScope: 'local',
  orchestrationCapabilities: [],
  capabilityDigest: 'sha256:integration-profile',
};

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
      recordDigest: record.durableContextDigest,
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

test('runtime package entry exposes the agent loop primitive', async () => {
  const runtime = await AgentLoopRuntime.start({
    agentRuntimeId: 'runtime-agent-loop-integration',
    role: 'interaction',
    mode: 'observation',
    profiles: [profile],
    budget: { maxModeTransitions: 0, maxObservationScopes: 1, maxContextReplacements: 1, maxDeferredEvents: 0 },
    scope,
    executionEpoch: 1,
    permissionRevision: 'integration-permissions',
    observationStreamId: 'integration-stream',
    durableContext: durableContext(),
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  }, new MemoryContextHistory());
  const actor = {
    agentRuntimeId: runtime.snapshot().modeState.agentRuntimeId,
    leaseId: runtime.snapshot().lease.leaseId,
  };
  const opened = await runtime.openObservationScope({
    actor,
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  assert.equal(opened.agentRuntimeId, 'runtime-agent-loop-integration');
  assert.equal(runtime.snapshot().modeState.mode, 'observation');
});
