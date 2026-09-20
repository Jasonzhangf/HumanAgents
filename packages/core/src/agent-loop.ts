import type {
  AgentLoopBudget,
  AgentLoopBudgetUsage,
  AgentLoopCheckpointRef,
  AgentLoopEventWatermark,
  AgentMode,
  AgentModeCapabilityProfile,
  AgentModeState,
  AgentModeTransition,
  ContextReplacement,
  ModeLease,
  ObservationBatch,
  ObservationDelta,
  ObservationScopeKind,
  OrchestrationScope,
} from '../../contracts/src/index.js';
import {
  validateAgentLoopBudget,
  validateAgentLoopBudgetUsage,
  validateAgentLoopCheckpointRef,
  validateAgentModeState,
  validateAgentModeTransition,
  validateContextReplacement,
  validateModeCapabilityProfile,
  validateModeLease,
  validateObservationBatch,
  validateObservationDelta,
} from '../../contracts/src/index.js';
import { CheckpointError, CoreError, EpochError, PermissionError } from './errors.js';

export interface AgentLoopLeaseFence {
  readonly agentRuntimeId: string;
  readonly mode: AgentMode;
  readonly executionEpoch: number;
  readonly checkpoint: AgentLoopCheckpointRef;
  readonly observationScopeId?: string;
  readonly leaseId: string;
}

export interface AgentLoopDeltaState {
  readonly executionEpoch: number;
  readonly checkpoint: AgentLoopCheckpointRef;
  readonly observationScopeId: string;
  readonly watermark: AgentLoopEventWatermark;
  readonly appliedDeltaIds: readonly string[];
  readonly appliedDeltaKeys: readonly string[];
}

export interface AgentLoopInboxState {
  readonly streamId: string;
  readonly executionEpoch: number;
  readonly checkpoint: AgentLoopCheckpointRef;
  readonly observationScopeId: string;
  readonly watermark: number;
  readonly handledEventIds: readonly string[];
  readonly handledBatchKeys: readonly string[];
}

export type ModeCapabilityUse =
  | {
      readonly kind: 'observation';
      readonly scope: ObservationScopeKind;
      readonly capability: string;
    }
  | {
      readonly kind: 'orchestration';
      readonly scope: OrchestrationScope;
      readonly capability: string;
    };

export type AgentLoopBudgetDecision =
  | { readonly state: 'allowed' }
  | {
      readonly state: 'blocked';
      readonly reason: 'maxModeTransitions' | 'maxObservationScopes' | 'maxContextReplacements' | 'maxDeferredEvents';
      readonly nextAction: { readonly kind: 'wait'; readonly ref: string };
    };

function nonEmpty(value: string | undefined, label: string): asserts value is string {
  if (!value || !value.trim()) throw new CoreError(`${label} is required`);
}

function sameCheckpoint(left: AgentLoopCheckpointRef, right: AgentLoopCheckpointRef): boolean {
  return left.checkpointId.scope === right.checkpointId.scope
    && left.checkpointId.value === right.checkpointId.value
    && left.digest === right.digest;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(value, label);
    if (seen.has(value)) throw new CoreError(`${label} contains a duplicate`);
    seen.add(value);
  }
}

function validateDeltaState(state: AgentLoopDeltaState): void {
  if (!Number.isSafeInteger(state.executionEpoch) || state.executionEpoch < 1) {
    throw new EpochError('observation delta state execution epoch must be a positive safe integer');
  }
  validateAgentLoopCheckpointRef(state.checkpoint, 'observation delta state checkpoint');
  nonEmpty(state.observationScopeId, 'observation delta state scopeId');
  if (!state.watermark.streamId.trim() || !Number.isSafeInteger(state.watermark.sequence) || state.watermark.sequence < 0) {
    throw new CoreError('observation delta state watermark is invalid');
  }
  assertUnique(state.appliedDeltaIds, 'applied delta ids');
  assertUnique(state.appliedDeltaKeys, 'applied delta keys');
}

function validateInboxState(state: AgentLoopInboxState): void {
  nonEmpty(state.streamId, 'observation inbox streamId');
  if (!Number.isSafeInteger(state.executionEpoch) || state.executionEpoch < 1) {
    throw new EpochError('observation inbox execution epoch must be a positive safe integer');
  }
  validateAgentLoopCheckpointRef(state.checkpoint, 'observation inbox checkpoint');
  nonEmpty(state.observationScopeId, 'observation inbox scopeId');
  if (!Number.isSafeInteger(state.watermark) || state.watermark < 0) {
    throw new CoreError('observation inbox watermark must be a non-negative safe integer');
  }
  assertUnique(state.handledEventIds, 'handled event ids');
  assertUnique(state.handledBatchKeys, 'handled batch keys');
}

export function assertModeLeaseCurrent(lease: ModeLease, current: AgentLoopLeaseFence, now = new Date()): void {
  validateModeLease(lease);
  if (lease.state !== 'active') throw new PermissionError(`mode lease is ${lease.state}`);
  if (Date.parse(lease.expiresAt) <= now.getTime()) throw new PermissionError('mode lease is expired');
  if (lease.leaseId !== current.leaseId) throw new PermissionError('mode lease is stale');
  if (lease.agentRuntimeId !== current.agentRuntimeId) throw new PermissionError('mode lease runtime mismatch');
  if (lease.mode !== current.mode) throw new PermissionError('mode lease mode mismatch');
  if (lease.executionEpoch !== current.executionEpoch) throw new EpochError('mode lease execution epoch is stale');
  if (!sameCheckpoint(lease.checkpoint, current.checkpoint)) throw new CheckpointError('mode lease checkpoint is stale');
  if (lease.observationScopeId !== current.observationScopeId) throw new PermissionError('mode lease observation scope mismatch');
}

export function assertAgentModeTransitionCurrent(
  transition: AgentModeTransition,
  current: AgentModeState,
  lease: ModeLease,
  now = new Date(),
): void {
  validateAgentModeTransition(transition);
  validateAgentModeState(current);
  assertModeLeaseCurrent(lease, {
    agentRuntimeId: current.agentRuntimeId,
    mode: current.mode,
    executionEpoch: current.executionEpoch,
    checkpoint: current.checkpoint,
    observationScopeId: current.observationScopeId,
    leaseId: current.leaseId,
  }, now);
  if (transition.executionEpoch !== current.executionEpoch) throw new EpochError('agent mode transition execution epoch is stale');
  if (!sameCheckpoint(transition.baseCheckpoint, current.checkpoint)) throw new CheckpointError('agent mode transition base checkpoint is stale');
  if (transition.fromMode !== current.mode) throw new PermissionError('agent mode transition source mode mismatch');
  if (transition.leaseId !== current.leaseId) throw new PermissionError('agent mode transition lease is stale');
  if (transition.transitionSeq !== current.transitionSeq + 1) throw new CoreError('agent mode transition sequence is stale');
}

export function assertObservationBatchFresh(state: AgentLoopInboxState, batch: ObservationBatch): AgentLoopInboxState {
  validateInboxState(state);
  validateObservationBatch(batch);
  if (batch.watermark.streamId !== state.streamId) throw new CoreError('observation batch stream mismatch');
  if (batch.executionEpoch !== state.executionEpoch) throw new EpochError('observation batch execution epoch is stale');
  if (!sameCheckpoint(batch.baseCheckpoint, state.checkpoint)) throw new CheckpointError('observation batch base checkpoint is stale');
  if (batch.observationScopeId !== state.observationScopeId) throw new PermissionError('observation batch scope mismatch');
  if (batch.eventSequences[0] !== state.watermark + 1) throw new CoreError('observation batch has an unaccounted event gap');
  if (state.handledBatchKeys.includes(batch.idempotencyKey)) throw new CoreError('duplicate observation batch');
  for (const eventId of batch.eventIds) {
    if (state.handledEventIds.includes(eventId)) throw new CoreError(`duplicate observation event: ${eventId}`);
  }
  if (batch.watermark.sequence <= state.watermark) throw new CoreError('observation event watermark is stale');
  return {
    streamId: state.streamId,
    executionEpoch: state.executionEpoch,
    checkpoint: state.checkpoint,
    observationScopeId: state.observationScopeId,
    watermark: batch.watermark.sequence,
    handledEventIds: [...state.handledEventIds, ...batch.eventIds],
    handledBatchKeys: [...state.handledBatchKeys, batch.idempotencyKey],
  };
}

export function assertObservationDeltaCurrent(state: AgentLoopDeltaState, delta: ObservationDelta): AgentLoopDeltaState {
  validateDeltaState(state);
  validateObservationDelta(delta);
  if (delta.executionEpoch !== state.executionEpoch) throw new EpochError('observation delta execution epoch is stale');
  if (!sameCheckpoint(delta.baseCheckpoint, state.checkpoint)) throw new CheckpointError('observation delta base checkpoint is stale');
  if (delta.observationScopeId !== state.observationScopeId) throw new PermissionError('observation delta scope mismatch');
  if (state.appliedDeltaIds.includes(delta.deltaId) || state.appliedDeltaKeys.includes(delta.idempotencyKey)) {
    throw new CoreError('duplicate observation delta');
  }
  if (delta.watermark.streamId !== state.watermark.streamId) throw new CoreError('observation delta watermark stream mismatch');
  if (delta.eventSequences[0] !== state.watermark.sequence + 1) throw new CoreError('observation delta has an unaccounted event gap');
  if (delta.watermark.sequence <= state.watermark.sequence) throw new CoreError('observation delta event watermark is stale');
  return {
    executionEpoch: state.executionEpoch,
    checkpoint: state.checkpoint,
    observationScopeId: state.observationScopeId,
    watermark: delta.watermark,
    appliedDeltaIds: [...state.appliedDeltaIds, delta.deltaId],
    appliedDeltaKeys: [...state.appliedDeltaKeys, delta.idempotencyKey],
  };
}

export function assertModeCapabilityGranted(profile: AgentModeCapabilityProfile, use: ModeCapabilityUse): void {
  validateModeCapabilityProfile(profile);
  nonEmpty(use.capability, 'mode capability');
  if (use.kind === 'observation') {
    if (profile.mode !== 'observation') throw new PermissionError('observation capability requires observation mode');
    if (!profile.observationScopes.includes(use.scope)) throw new PermissionError('observation scope is not granted');
    if (!profile.observationCapabilities.includes(use.capability)) throw new PermissionError('observation capability is not granted');
    return;
  }

  if (profile.mode !== 'orchestration') throw new PermissionError('orchestration capability requires orchestration mode');
  if (profile.role !== 'orchestration' && use.scope === 'project') {
    throw new PermissionError('project orchestration requires the orchestration role');
  }
  if (profile.orchestrationScope === 'local' && use.scope === 'project') {
    throw new PermissionError('project orchestration capability is not granted');
  }
  if (!profile.orchestrationCapabilities.includes(use.capability)) {
    throw new PermissionError('orchestration capability is not granted');
  }
}

export function assertContextReplacementCurrent(replacement: ContextReplacement, checkpoint: AgentLoopCheckpointRef, executionEpoch: number): void {
  validateContextReplacement(replacement);
  if (replacement.executionEpoch !== executionEpoch) throw new EpochError('context replacement execution epoch is stale');
  if (!sameCheckpoint(replacement.baseCheckpoint, checkpoint)) throw new CheckpointError('context replacement base checkpoint is stale');
}

export function classifyAgentLoopBudget(budget: AgentLoopBudget, usage: AgentLoopBudgetUsage): AgentLoopBudgetDecision {
  validateAgentLoopBudget(budget);
  validateAgentLoopBudgetUsage(usage);
  if (usage.modeTransitions >= budget.maxModeTransitions) {
    return { state: 'blocked', reason: 'maxModeTransitions', nextAction: { kind: 'wait', ref: 'agent-loop-budget:maxModeTransitions' } };
  }
  if (usage.observationScopes >= budget.maxObservationScopes) {
    return { state: 'blocked', reason: 'maxObservationScopes', nextAction: { kind: 'wait', ref: 'agent-loop-budget:maxObservationScopes' } };
  }
  if (usage.contextReplacements >= budget.maxContextReplacements) {
    return { state: 'blocked', reason: 'maxContextReplacements', nextAction: { kind: 'wait', ref: 'agent-loop-budget:maxContextReplacements' } };
  }
  if (usage.deferredEvents >= budget.maxDeferredEvents) {
    return { state: 'blocked', reason: 'maxDeferredEvents', nextAction: { kind: 'wait', ref: 'agent-loop-budget:maxDeferredEvents' } };
  }
  return { state: 'allowed' };
}

export function assertAgentLoopBudgetAvailable(budget: AgentLoopBudget, usage: AgentLoopBudgetUsage): void {
  const decision = classifyAgentLoopBudget(budget, usage);
  if (decision.state === 'blocked') throw new CoreError(`agent loop budget exhausted: ${decision.reason}`);
}
