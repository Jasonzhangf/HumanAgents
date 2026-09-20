import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type AgentModeCapabilityProfile, type ScopeRef } from '../../../packages/contracts/src/index.js';
import { AgentLoopRuntime } from '../../../packages/runtime/src/index.js';

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

test('runtime package entry exposes the agent loop primitive', () => {
  const runtime = new AgentLoopRuntime({
    agentRuntimeId: 'runtime-agent-loop-integration',
    role: 'interaction',
    mode: 'observation',
    profiles: [profile],
    budget: { maxModeTransitions: 0, maxObservationScopes: 1, maxContextReplacements: 1, maxDeferredEvents: 0 },
    scope,
    executionEpoch: 1,
    permissionRevision: 'integration-permissions',
    observationStreamId: 'integration-stream',
    now: () => new Date('2026-09-20T00:00:00.000Z'),
  });
  const actor = {
    agentRuntimeId: runtime.snapshot().modeState.agentRuntimeId,
    leaseId: runtime.snapshot().lease.leaseId,
  };
  const opened = runtime.openObservationScope({
    actor,
    kind: 'task',
    scope,
    readableRefs: ['task:state'],
    capabilities: ['read-task'],
  });
  assert.equal(opened.agentRuntimeId, 'runtime-agent-loop-integration');
  assert.equal(runtime.snapshot().modeState.mode, 'observation');
});
