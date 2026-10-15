import type { CheckpointId, JsonValue, ScopeRef } from './index.js';
import { ContractError } from './errors.js';
import { validateJournalCommitRef, type JournalCommitRef } from './i2-history.js';

export type AgentMode = 'observation' | 'orchestration';
export type AgentLoopRole = 'interaction' | 'orchestration' | 'execution' | 'review' | 'memory';
export type OrchestrationScope = 'local' | 'project';
export type ObservationScopeKind = 'self' | 'task' | 'project' | 'evidence' | 'memory';
export type ModeLeaseState = 'active' | 'expired' | 'released';
export type AgentLoopEventClass = 'data' | 'observation';
export type ObservationBatchPriority = 'normal' | 'deferred';
export type ContextReplacementReason = 'observation' | 'compaction' | 'recovery';

export interface AgentLoopCheckpointRef {
  readonly checkpointId: CheckpointId;
  readonly digest: string;
}

export interface AgentLoopEventWatermark {
  readonly streamId: string;
  readonly sequence: number;
}

export interface AgentLoopCheckpoint {
  readonly checkpointId: CheckpointId;
  readonly sequence: number;
  readonly predecessor: AgentLoopCheckpointRef | null;
  readonly digest: string;
  readonly executionEpoch: number;
  readonly eventWatermark: AgentLoopEventWatermark;
  readonly observationScopeId: string;
  readonly contextViewRef: string;
}

export interface AgentModeState {
  readonly agentRuntimeId: string;
  readonly mode: AgentMode;
  readonly executionEpoch: number;
  readonly checkpoint: AgentLoopCheckpointRef;
  readonly observationScopeId: string;
  readonly contextViewRef: string;
  readonly leaseId: string;
  readonly transitionSeq: number;
}

export interface AgentModeTransition {
  readonly transitionId: string;
  readonly fromMode: AgentMode;
  readonly toMode: AgentMode;
  readonly executionEpoch: number;
  readonly baseCheckpoint: AgentLoopCheckpointRef;
  readonly successorCheckpointId: CheckpointId;
  readonly contextReplacementId: string;
  readonly leaseId: string;
  readonly transitionSeq: number;
  readonly reason: 'observation-complete' | 'orchestration-complete' | 'interruption' | 'recovery';
}

export interface ModeCapabilityProfile {
  readonly profileId: string;
  readonly role: AgentLoopRole;
  readonly mode: AgentMode;
  readonly observationScopes: readonly ObservationScopeKind[];
  readonly observationCapabilities: readonly string[];
  readonly orchestrationScope: OrchestrationScope;
  readonly orchestrationCapabilities: readonly string[];
  readonly capabilityDigest: string;
}

export type AgentModeCapabilityProfile = ModeCapabilityProfile;

export interface ModeLease {
  readonly leaseId: string;
  readonly agentRuntimeId: string;
  readonly role: AgentLoopRole;
  readonly mode: AgentMode;
  readonly profileId: string;
  readonly executionEpoch: number;
  readonly checkpoint: AgentLoopCheckpointRef;
  readonly observationScopeId?: string;
  readonly permissionRevision: string;
  readonly capabilityDigest: string;
  readonly state: ModeLeaseState;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type AgentModeLease = ModeLease;

export interface ObservationScope {
  readonly observationScopeId: string;
  readonly agentRuntimeId: string;
  readonly executionEpoch: number;
  readonly checkpoint: AgentLoopCheckpointRef;
  readonly kind: ObservationScopeKind;
  readonly scope: ScopeRef;
  readonly readableRefs: readonly string[];
  readonly capabilities: readonly string[];
  readonly openedAt: string;
}

export interface ObservationBatch {
  readonly batchId: string;
  readonly observationScopeId: string;
  readonly executionEpoch: number;
  readonly baseCheckpoint: AgentLoopCheckpointRef;
  readonly eventClass: AgentLoopEventClass;
  readonly priority: ObservationBatchPriority;
  readonly watermark: AgentLoopEventWatermark;
  readonly eventIds: readonly string[];
  readonly eventSequences: readonly number[];
  readonly correlationRefs: readonly string[];
  readonly idempotencyKey: string;
}

export interface ObservationDelta {
  readonly deltaId: string;
  readonly idempotencyKey: string;
  readonly deltaDigest: string;
  readonly observationScopeId: string;
  readonly executionEpoch: number;
  readonly baseCheckpoint: AgentLoopCheckpointRef;
  readonly watermark: AgentLoopEventWatermark;
  readonly observationRefs: readonly string[];
  readonly eventSequences: readonly number[];
  readonly summaryRef: string;
}

/**
 * Four-category durable window. The arrays preserve category and entry order; the
 * ordered concatenation is the message stream. Runtime owns assembly; this contract
 * only fixes the shared shape so a durable body is not flattened into a single array.
 */
export interface ContextBuildInput<T> {
  readonly stablePrefix: readonly T[];
  readonly indexRefs: readonly T[];
  readonly dynamicHead: readonly T[];
  readonly repairRefs: readonly T[];
}

export interface ContextView {
  readonly contextViewRef: string;
  readonly executionEpoch: number;
  readonly checkpoint: AgentLoopCheckpointRef;
  readonly contextDigest: string;
  readonly activeRefs: readonly string[];
  readonly omittedRefs: readonly string[];
}

export interface ContextReplacement {
  readonly replacementId: string;
  readonly executionEpoch: number;
  readonly baseCheckpoint: AgentLoopCheckpointRef;
  readonly successorCheckpoint: AgentLoopCheckpointRef;
  readonly fromContextViewRef: string;
  readonly toContextViewRef: string;
  readonly toContextDigest: string;
  readonly deltaIds: readonly string[];
  readonly reason: ContextReplacementReason;
  readonly replacementDigest: string;
}

/**
 * Typed successor processing position carried with a context-history record. It is
 * explicit control data, never a JSON control envelope, and it excludes lease
 * identity, permission revisions and credentials. Inbox and delta watermarks are
 * independent of the loop checkpoint watermark: a merged batch may await delta
 * application.
 */
export interface ContextLoopControl {
  readonly mode: AgentMode;
  readonly transitionSeq: number;
  readonly observationScopeId: string;
  readonly observationScope: ObservationScope | null;
  readonly inboxStreamId: string;
  readonly inboxExecutionEpoch: number;
  readonly inboxCheckpoint: AgentLoopCheckpointRef;
  readonly inboxObservationScopeId: string;
  readonly inboxWatermark: number;
  readonly handledEventIds: readonly string[];
  readonly handledBatchKeys: readonly string[];
  readonly deltaExecutionEpoch: number;
  readonly deltaCheckpoint: AgentLoopCheckpointRef;
  readonly deltaObservationScopeId: string;
  readonly deltaWatermark: AgentLoopEventWatermark;
  readonly appliedDeltaIds: readonly string[];
  readonly appliedDeltaKeys: readonly string[];
  readonly closedObservationScopeIds: readonly string[];
  readonly budgetUsage: AgentLoopBudgetUsage;
}

/**
 * Durable pre-transient context publication. `durableContext` carries the complete
 * four-part body (JSON entries); `durableContextDigest` covers that full body
 * separately from the refs-only `contextView.contextDigest`. `previousContextCommitRef`
 * binds successive control publications of one view to the actual predecessor receipt.
 */
export interface ContextHistoryRecord {
  readonly kind: 'context-history';
  readonly schemaVersion: 1;
  readonly scope: ScopeRef;
  readonly agentRuntimeId: string;
  readonly contextView: ContextView;
  readonly loopCheckpoint: AgentLoopCheckpoint;
  readonly replacement: ContextReplacement | null;
  readonly previousContextCommitRef: JournalCommitRef | null;
  readonly durableContext: ContextBuildInput<JsonValue>;
  readonly durableContextDigest: string;
  readonly loopControl: ContextLoopControl;
}

export interface AgentLoopBudget {
  readonly maxModeTransitions: number;
  readonly maxObservationScopes: number;
  readonly maxContextReplacements: number;
  readonly maxDeferredEvents: number;
}

export interface AgentLoopBudgetUsage {
  readonly modeTransitions: number;
  readonly observationScopes: number;
  readonly contextReplacements: number;
  readonly deferredEvents: number;
}

const AGENT_MODES: readonly AgentMode[] = ['observation', 'orchestration'];
const AGENT_LOOP_ROLES: readonly AgentLoopRole[] = ['interaction', 'orchestration', 'execution', 'review', 'memory'];
const ORCHESTRATION_SCOPES: readonly OrchestrationScope[] = ['local', 'project'];
const OBSERVATION_SCOPE_KINDS: readonly ObservationScopeKind[] = ['self', 'task', 'project', 'evidence', 'memory'];
const MODE_LEASE_STATES: readonly ModeLeaseState[] = ['active', 'expired', 'released'];
const EVENT_CLASSES: readonly AgentLoopEventClass[] = ['data', 'observation'];
const BATCH_PRIORITIES: readonly ObservationBatchPriority[] = ['normal', 'deferred'];
const CONTEXT_REPLACEMENT_REASONS: readonly ContextReplacementReason[] = ['observation', 'compaction', 'recovery'];

function nonEmpty(value: string | undefined, label: string): asserts value is string {
  if (!value || !value.trim()) throw new ContractError(`${label} is required`);
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ContractError(`${label} must be a positive safe integer`);
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContractError(`${label} must be a non-negative safe integer`);
}

function validTime(value: string, label: string): void {
  nonEmpty(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new ContractError(`${label} must be a valid timestamp`);
}

function uniqueRefs(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    nonEmpty(value, label);
    if (seen.has(value)) throw new ContractError(`${label} must not contain duplicates`);
    seen.add(value);
  }
}

function assertMember<T extends string>(value: T, allowed: readonly T[], label: string): void {
  if (!allowed.includes(value)) throw new ContractError(`${label} is invalid`);
}

function sameCheckpointId(left: CheckpointId, right: CheckpointId): boolean {
  return left.scope === right.scope && left.value === right.value;
}

export function validateAgentLoopScopeRef(input: ScopeRef, label = 'observation scope'): void {
  if (input.organId.scope !== 'organ' || !input.organId.value.trim()) throw new ContractError(`${label} organ id is invalid`);
  const optional = [
    ['task', input.taskId],
    ['cycle', input.cycleId],
    ['operation', input.operationId],
  ] as const;
  for (const [kind, value] of optional) {
    if (value !== undefined && (value.scope !== kind || !value.value.trim())) {
      throw new ContractError(`${label} ${kind} id is invalid`);
    }
  }
}

export function validateAgentLoopCheckpointRef(input: AgentLoopCheckpointRef, label = 'checkpoint reference'): void {
  if (input.checkpointId.scope !== 'checkpoint' || !input.checkpointId.value.trim()) {
    throw new ContractError(`${label} checkpoint id must be checkpoint scoped`);
  }
  nonEmpty(input.digest, `${label} digest`);
}

export function validateAgentLoopEventWatermark(input: AgentLoopEventWatermark): void {
  nonEmpty(input.streamId, 'event watermark streamId');
  nonNegativeSafeInteger(input.sequence, 'event watermark sequence');
}

function validateAgentLoopCheckpointShape(input: AgentLoopCheckpoint): void {
  if (input.checkpointId.scope !== 'checkpoint' || !input.checkpointId.value.trim()) {
    throw new ContractError('agent loop checkpoint id must be checkpoint scoped');
  }
  positiveSafeInteger(input.sequence, 'agent loop checkpoint sequence');
  positiveSafeInteger(input.executionEpoch, 'agent loop checkpoint executionEpoch');
  nonEmpty(input.digest, 'agent loop checkpoint digest');
  nonEmpty(input.observationScopeId, 'agent loop checkpoint observationScopeId');
  nonEmpty(input.contextViewRef, 'agent loop checkpoint contextViewRef');
  validateAgentLoopEventWatermark(input.eventWatermark);
  if (input.predecessor !== null) {
    validateAgentLoopCheckpointRef(input.predecessor, 'agent loop checkpoint predecessor');
    if (sameCheckpointId(input.predecessor.checkpointId, input.checkpointId)) {
      throw new ContractError('agent loop checkpoint cannot reference itself as predecessor');
    }
  }
  if (input.sequence === 1 && input.predecessor !== null) throw new ContractError('root checkpoint cannot have a predecessor');
  if (input.sequence > 1 && input.predecessor === null) throw new ContractError('non-root checkpoint requires a predecessor');
}

export function validateAgentLoopCheckpoint(input: AgentLoopCheckpoint, previous?: AgentLoopCheckpoint | null): void {
  validateAgentLoopCheckpointShape(input);
  if (input.sequence === 1) {
    if (previous !== undefined && previous !== null) throw new ContractError('root checkpoint cannot validate against a predecessor');
    return;
  }
  if (previous === undefined) throw new ContractError('non-root checkpoint validation requires its predecessor record');
  assertAgentLoopCheckpointLink(input, previous);
}

export function assertAgentLoopCheckpointLink(current: AgentLoopCheckpoint, previous: AgentLoopCheckpoint | null): void {
  validateAgentLoopCheckpointShape(current);
  if (previous === null) {
    if (current.predecessor !== null || current.sequence !== 1) throw new ContractError('invalid root agent loop checkpoint');
    return;
  }
  validateAgentLoopCheckpointShape(previous);
  if (current.predecessor === null) throw new ContractError('agent loop checkpoint predecessor is missing');
  if (!sameCheckpointId(current.predecessor.checkpointId, previous.checkpointId)) {
    throw new ContractError('agent loop checkpoint predecessor id mismatch');
  }
  if (current.predecessor.digest !== previous.digest) throw new ContractError('agent loop checkpoint predecessor digest mismatch');
  if (current.sequence !== previous.sequence + 1) throw new ContractError('agent loop checkpoint sequence mismatch');
  if (current.executionEpoch < previous.executionEpoch) throw new ContractError('agent loop checkpoint execution epoch moved backwards');
  if (current.eventWatermark.streamId !== previous.eventWatermark.streamId
    || current.eventWatermark.sequence < previous.eventWatermark.sequence) {
    throw new ContractError('agent loop checkpoint event watermark moved backwards');
  }
}

export function validateAgentModeState(input: AgentModeState): void {
  nonEmpty(input.agentRuntimeId, 'agent mode runtimeId');
  assertMember(input.mode, AGENT_MODES, 'agent mode');
  positiveSafeInteger(input.executionEpoch, 'agent mode executionEpoch');
  validateAgentLoopCheckpointRef(input.checkpoint, 'agent mode checkpoint');
  nonEmpty(input.observationScopeId, 'agent mode observationScopeId');
  nonEmpty(input.contextViewRef, 'agent mode contextViewRef');
  nonEmpty(input.leaseId, 'agent mode leaseId');
  positiveSafeInteger(input.transitionSeq, 'agent mode transitionSeq');
}

export function validateAgentModeTransition(input: AgentModeTransition): void {
  nonEmpty(input.transitionId, 'agent mode transitionId');
  assertMember(input.fromMode, AGENT_MODES, 'agent mode transition fromMode');
  assertMember(input.toMode, AGENT_MODES, 'agent mode transition toMode');
  if (input.fromMode === input.toMode) throw new ContractError('agent mode transition must change mode');
  positiveSafeInteger(input.executionEpoch, 'agent mode transition executionEpoch');
  validateAgentLoopCheckpointRef(input.baseCheckpoint, 'agent mode transition base checkpoint');
  if (input.successorCheckpointId.scope !== 'checkpoint' || !input.successorCheckpointId.value.trim()) {
    throw new ContractError('agent mode transition successor checkpoint id must be checkpoint scoped');
  }
  if (sameCheckpointId(input.successorCheckpointId, input.baseCheckpoint.checkpointId)) {
    throw new ContractError('agent mode transition successor checkpoint must advance');
  }
  nonEmpty(input.contextReplacementId, 'agent mode transition contextReplacementId');
  nonEmpty(input.leaseId, 'agent mode transition leaseId');
  positiveSafeInteger(input.transitionSeq, 'agent mode transition sequence');
  assertMember(input.reason, ['observation-complete', 'orchestration-complete', 'interruption', 'recovery'] as const, 'agent mode transition reason');
}

export function validateModeCapabilityProfile(input: ModeCapabilityProfile): void {
  nonEmpty(input.profileId, 'mode capability profileId');
  assertMember(input.role, AGENT_LOOP_ROLES, 'mode capability role');
  assertMember(input.mode, AGENT_MODES, 'mode capability mode');
  assertMember(input.orchestrationScope, ORCHESTRATION_SCOPES, 'mode capability orchestration scope');
  if (input.role !== 'orchestration' && input.orchestrationScope === 'project') {
    throw new ContractError('project orchestration requires the orchestration role');
  }
  uniqueRefs(input.observationScopes, 'observation scopes');
  for (const scope of input.observationScopes) assertMember(scope, OBSERVATION_SCOPE_KINDS, 'observation scope');
  uniqueRefs(input.observationCapabilities, 'observation capabilities');
  uniqueRefs(input.orchestrationCapabilities, 'orchestration capabilities');
  nonEmpty(input.capabilityDigest, 'mode capability digest');
}

export function validateModeLease(input: ModeLease): void {
  nonEmpty(input.leaseId, 'mode leaseId');
  nonEmpty(input.agentRuntimeId, 'mode lease runtimeId');
  assertMember(input.role, AGENT_LOOP_ROLES, 'mode lease role');
  assertMember(input.mode, AGENT_MODES, 'mode lease mode');
  nonEmpty(input.profileId, 'mode lease profileId');
  positiveSafeInteger(input.executionEpoch, 'mode lease executionEpoch');
  validateAgentLoopCheckpointRef(input.checkpoint, 'mode lease checkpoint');
  if (input.observationScopeId !== undefined) nonEmpty(input.observationScopeId, 'mode lease observationScopeId');
  nonEmpty(input.permissionRevision, 'mode lease permissionRevision');
  nonEmpty(input.capabilityDigest, 'mode lease capabilityDigest');
  assertMember(input.state, MODE_LEASE_STATES, 'mode lease state');
  validTime(input.issuedAt, 'mode lease issuedAt');
  validTime(input.expiresAt, 'mode lease expiresAt');
  if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) throw new ContractError('mode lease expiresAt must be later than issuedAt');
}

export function validateObservationScope(input: ObservationScope): void {
  nonEmpty(input.observationScopeId, 'observation scopeId');
  nonEmpty(input.agentRuntimeId, 'observation scope runtimeId');
  positiveSafeInteger(input.executionEpoch, 'observation scope executionEpoch');
  validateAgentLoopCheckpointRef(input.checkpoint, 'observation scope checkpoint');
  validateAgentLoopScopeRef(input.scope);
  assertMember(input.kind, OBSERVATION_SCOPE_KINDS, 'observation scope kind');
  uniqueRefs(input.readableRefs, 'observation readableRefs');
  uniqueRefs(input.capabilities, 'observation capabilities');
  validTime(input.openedAt, 'observation scope openedAt');
}

export function validateObservationBatch(input: ObservationBatch): void {
  nonEmpty(input.batchId, 'observation batchId');
  nonEmpty(input.observationScopeId, 'observation batch scopeId');
  positiveSafeInteger(input.executionEpoch, 'observation batch executionEpoch');
  validateAgentLoopCheckpointRef(input.baseCheckpoint, 'observation batch base checkpoint');
  assertMember(input.eventClass, EVENT_CLASSES, 'observation batch eventClass');
  assertMember(input.priority, BATCH_PRIORITIES, 'observation batch priority');
  validateAgentLoopEventWatermark(input.watermark);
  if (input.eventIds.length === 0) throw new ContractError('observation batch requires events');
  uniqueRefs(input.eventIds, 'observation batch eventIds');
  if (input.eventSequences.length !== input.eventIds.length) throw new ContractError('observation batch event sequence count mismatch');
  for (let index = 0; index < input.eventSequences.length; index += 1) {
    positiveSafeInteger(input.eventSequences[index], 'observation batch event sequence');
    if (index > 0 && input.eventSequences[index] !== input.eventSequences[index - 1] + 1) {
      throw new ContractError('observation batch event sequences must be contiguous');
    }
  }
  if (input.eventSequences[input.eventSequences.length - 1] !== input.watermark.sequence) {
    throw new ContractError('observation batch watermark must equal its last event sequence');
  }
  uniqueRefs(input.correlationRefs, 'observation batch correlationRefs');
  nonEmpty(input.idempotencyKey, 'observation batch idempotencyKey');
}

export function validateObservationDelta(input: ObservationDelta): void {
  nonEmpty(input.deltaId, 'observation deltaId');
  nonEmpty(input.idempotencyKey, 'observation delta idempotencyKey');
  nonEmpty(input.deltaDigest, 'observation delta digest');
  nonEmpty(input.observationScopeId, 'observation delta scopeId');
  positiveSafeInteger(input.executionEpoch, 'observation delta executionEpoch');
  validateAgentLoopCheckpointRef(input.baseCheckpoint, 'observation delta base checkpoint');
  validateAgentLoopEventWatermark(input.watermark);
  if (input.observationRefs.length === 0) throw new ContractError('observation delta requires observation refs');
  uniqueRefs(input.observationRefs, 'observation delta refs');
  if (input.eventSequences.length !== input.observationRefs.length) throw new ContractError('observation delta event sequence count mismatch');
  for (let index = 0; index < input.eventSequences.length; index += 1) {
    positiveSafeInteger(input.eventSequences[index], 'observation delta event sequence');
    if (index > 0 && input.eventSequences[index] !== input.eventSequences[index - 1] + 1) {
      throw new ContractError('observation delta event sequences must be contiguous');
    }
  }
  if (input.eventSequences[input.eventSequences.length - 1] !== input.watermark.sequence) {
    throw new ContractError('observation delta watermark must equal its last event sequence');
  }
  nonEmpty(input.summaryRef, 'observation delta summaryRef');
}

export function validateContextView(input: ContextView): void {
  nonEmpty(input.contextViewRef, 'context view ref');
  positiveSafeInteger(input.executionEpoch, 'context view executionEpoch');
  validateAgentLoopCheckpointRef(input.checkpoint, 'context view checkpoint');
  nonEmpty(input.contextDigest, 'context view digest');
  uniqueRefs(input.activeRefs, 'context view activeRefs');
  uniqueRefs(input.omittedRefs, 'context view omittedRefs');
  const active = new Set(input.activeRefs);
  for (const omitted of input.omittedRefs) {
    if (active.has(omitted)) throw new ContractError('context view activeRefs and omittedRefs must be disjoint');
  }
}

export function validateContextReplacement(input: ContextReplacement): void {
  nonEmpty(input.replacementId, 'context replacementId');
  positiveSafeInteger(input.executionEpoch, 'context replacement executionEpoch');
  validateAgentLoopCheckpointRef(input.baseCheckpoint, 'context replacement base checkpoint');
  validateAgentLoopCheckpointRef(input.successorCheckpoint, 'context replacement successor checkpoint');
  if (sameCheckpointId(input.baseCheckpoint.checkpointId, input.successorCheckpoint.checkpointId)) {
    throw new ContractError('context replacement requires a successor checkpoint');
  }
  nonEmpty(input.fromContextViewRef, 'context replacement fromContextViewRef');
  nonEmpty(input.toContextViewRef, 'context replacement toContextViewRef');
  if (input.fromContextViewRef === input.toContextViewRef) throw new ContractError('context replacement must change the active context view');
  nonEmpty(input.toContextDigest, 'context replacement toContextDigest');
  if (input.deltaIds.length === 0) throw new ContractError('context replacement requires observation deltas');
  uniqueRefs(input.deltaIds, 'context replacement deltaIds');
  assertMember(input.reason, CONTEXT_REPLACEMENT_REASONS, 'context replacement reason');
  nonEmpty(input.replacementDigest, 'context replacement digest');
}

export function validateAgentLoopBudget(input: AgentLoopBudget): void {
  nonNegativeSafeInteger(input.maxModeTransitions, 'maxModeTransitions');
  nonNegativeSafeInteger(input.maxObservationScopes, 'maxObservationScopes');
  nonNegativeSafeInteger(input.maxContextReplacements, 'maxContextReplacements');
  nonNegativeSafeInteger(input.maxDeferredEvents, 'maxDeferredEvents');
}

export function validateAgentLoopBudgetUsage(input: AgentLoopBudgetUsage): void {
  nonNegativeSafeInteger(input.modeTransitions, 'mode transition usage');
  nonNegativeSafeInteger(input.observationScopes, 'observation scope usage');
  nonNegativeSafeInteger(input.contextReplacements, 'context replacement usage');
  nonNegativeSafeInteger(input.deferredEvents, 'deferred event usage');
}

function assertSerializableJsonValue(value: unknown, label: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ContractError(`${label} must contain only JSON values`);
    return;
  }
  if (typeof value !== 'object') throw new ContractError(`${label} must contain only JSON values`);
  if (ancestors.has(value)) throw new ContractError(`${label} must not contain cyclic references`);
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    throw new ContractError(`${label} must not contain custom toJSON`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSerializableJsonValue(item, label, ancestors);
  } else {
    for (const nested of Object.values(value)) assertSerializableJsonValue(nested, label, ancestors);
  }
  ancestors.delete(value);
}

function validateDurableContextBody(input: ContextBuildInput<JsonValue>): void {
  if (input === null || typeof input !== 'object') {
    throw new ContractError('context history durableContext must be an object');
  }
  const categories = [
    ['stablePrefix', input.stablePrefix],
    ['indexRefs', input.indexRefs],
    ['dynamicHead', input.dynamicHead],
    ['repairRefs', input.repairRefs],
  ] as const;
  for (const [label, entries] of categories) {
    if (!Array.isArray(entries)) throw new ContractError(`context history durableContext ${label} must be an array`);
    for (const entry of entries) assertSerializableJsonValue(entry, `context history durableContext ${label}`);
  }
}

export function validateContextLoopControl(input: ContextLoopControl): void {
  if (input === null || typeof input !== 'object') throw new ContractError('context loop control must be an object');
  assertMember(input.mode, AGENT_MODES, 'context loop control mode');
  positiveSafeInteger(input.transitionSeq, 'context loop control transitionSeq');
  nonEmpty(input.observationScopeId, 'context loop control observationScopeId');
  if (input.observationScope !== null) {
    validateObservationScope(input.observationScope);
    if (input.observationScope.observationScopeId !== input.observationScopeId) {
      throw new ContractError('context loop control observation scope must match its scope id');
    }
  }
  nonEmpty(input.inboxStreamId, 'context loop control inboxStreamId');
  positiveSafeInteger(input.inboxExecutionEpoch, 'context loop control inboxExecutionEpoch');
  validateAgentLoopCheckpointRef(input.inboxCheckpoint, 'context loop control inbox checkpoint');
  nonEmpty(input.inboxObservationScopeId, 'context loop control inboxObservationScopeId');
  nonNegativeSafeInteger(input.inboxWatermark, 'context loop control inbox watermark');
  uniqueRefs(input.handledEventIds, 'context loop control handledEventIds');
  uniqueRefs(input.handledBatchKeys, 'context loop control handledBatchKeys');
  positiveSafeInteger(input.deltaExecutionEpoch, 'context loop control deltaExecutionEpoch');
  validateAgentLoopCheckpointRef(input.deltaCheckpoint, 'context loop control delta checkpoint');
  nonEmpty(input.deltaObservationScopeId, 'context loop control deltaObservationScopeId');
  validateAgentLoopEventWatermark(input.deltaWatermark);
  uniqueRefs(input.appliedDeltaIds, 'context loop control appliedDeltaIds');
  uniqueRefs(input.appliedDeltaKeys, 'context loop control appliedDeltaKeys');
  uniqueRefs(input.closedObservationScopeIds, 'context loop control closedObservationScopeIds');
  validateAgentLoopBudgetUsage(input.budgetUsage);
}

function validateContextHistoryBindings(input: ContextHistoryRecord): void {
  if (input.contextView.executionEpoch !== input.loopCheckpoint.executionEpoch) {
    throw new ContractError('context history context view and loop checkpoint execution epochs must match');
  }
  if (input.contextView.checkpoint.checkpointId.value !== input.loopCheckpoint.checkpointId.value
    || input.contextView.checkpoint.digest !== input.loopCheckpoint.digest) {
    throw new ContractError('context history context view must reference the loop checkpoint');
  }
  if (input.loopCheckpoint.contextViewRef !== input.contextView.contextViewRef) {
    throw new ContractError('context history loop checkpoint must reference the context view');
  }
  if (input.loopControl.inboxExecutionEpoch !== input.loopCheckpoint.executionEpoch
    || input.loopControl.deltaExecutionEpoch !== input.loopCheckpoint.executionEpoch) {
    throw new ContractError('context history processing state execution epochs must match the loop checkpoint');
  }
  if (input.loopControl.observationScope !== null
    && input.loopControl.observationScope.executionEpoch !== input.loopCheckpoint.executionEpoch) {
    throw new ContractError('context history observation scope execution epoch must match the loop checkpoint');
  }
  if (input.replacement === null) return;
  if (input.replacement.executionEpoch !== input.loopCheckpoint.executionEpoch) {
    throw new ContractError('context history replacement execution epoch must match the loop checkpoint');
  }
  if (input.replacement.successorCheckpoint.checkpointId.value !== input.loopCheckpoint.checkpointId.value
    || input.replacement.successorCheckpoint.digest !== input.loopCheckpoint.digest) {
    throw new ContractError('context history replacement must advance to the loop checkpoint');
  }
  if (input.replacement.toContextViewRef !== input.contextView.contextViewRef
    || input.replacement.toContextDigest !== input.contextView.contextDigest) {
    throw new ContractError('context history replacement must link to the context view');
  }
  const predecessor = input.loopCheckpoint.predecessor;
  if (predecessor === null) throw new ContractError('context history replacement requires a predecessor checkpoint');
  if (input.replacement.baseCheckpoint.checkpointId.value !== predecessor.checkpointId.value
    || input.replacement.baseCheckpoint.digest !== predecessor.digest) {
    throw new ContractError('context history replacement must link to the loop checkpoint predecessor');
  }
}

export function validateContextHistoryRecord(input: ContextHistoryRecord): void {
  if (input === null || typeof input !== 'object') throw new ContractError('context history record must be an object');
  if (input.kind !== 'context-history') throw new ContractError('context history record kind is invalid');
  if (input.schemaVersion !== 1) throw new ContractError('context history record schemaVersion must be 1');
  validateAgentLoopScopeRef(input.scope, 'context history scope');
  nonEmpty(input.agentRuntimeId, 'context history agentRuntimeId');
  validateContextView(input.contextView);
  validateAgentLoopCheckpointShape(input.loopCheckpoint);
  if (input.previousContextCommitRef !== null) validateJournalCommitRef(input.previousContextCommitRef);
  if (input.replacement !== null) validateContextReplacement(input.replacement);
  validateDurableContextBody(input.durableContext);
  nonEmpty(input.durableContextDigest, 'context history durableContextDigest');
  validateContextLoopControl(input.loopControl);
  validateContextHistoryBindings(input);
}
