import { createHash } from 'node:crypto';
import {
  assertExecutionEpoch,
  id,
  type AgentLoopBudget,
  type AgentLoopBudgetUsage,
  type AgentLoopCheckpoint,
  type AgentLoopCheckpointRef,
  type AgentLoopEventWatermark,
  type AgentMode,
  type AgentModeCapabilityProfile,
  type AgentModeState,
  type AgentModeTransition,
  type ContextReplacement,
  type ContextReplacementReason,
  type ContextView,
  type ObservationBatch,
  type ObservationDelta,
  type ObservationScope,
  type ObservationScopeKind,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import {
  assertAgentModeTransitionCurrent,
  assertContextReplacementCurrent,
  assertModeCapabilityGranted,
  assertModeLeaseCurrent,
  assertObservationBatchFresh,
  assertObservationDeltaCurrent,
  classifyAgentLoopBudget,
  type AgentLoopDeltaState,
  type AgentLoopInboxState,
} from '../../../core/src/index.js';
import {
  validateAgentLoopBudget,
  validateAgentLoopCheckpoint,
  validateModeCapabilityProfile,
} from '../../../contracts/src/agent-loop.js';
import { RuntimeError } from '../nodes/errors.js';
import { AgentLoopRuntimeError } from './errors.js';

export interface AgentLoopActor {
  readonly agentRuntimeId: string;
  readonly leaseId: string;
}

export interface AgentLoopStartRequest {
  readonly agentRuntimeId: string;
  readonly role: AgentModeCapabilityProfile['role'];
  readonly mode: AgentMode;
  readonly profiles: readonly AgentModeCapabilityProfile[];
  readonly budget: AgentLoopBudget;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly permissionRevision: string;
  readonly observationStreamId: string;
  readonly activeRefs?: readonly string[];
  readonly omittedRefs?: readonly string[];
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
}

export interface OpenObservationScopeRequest {
  readonly actor: AgentLoopActor;
  readonly kind: ObservationScopeKind;
  readonly scope: ScopeRef;
  readonly readableRefs: readonly string[];
  readonly capabilities: readonly string[];
}

export interface TransitionModeRequest {
  readonly actor: AgentLoopActor;
  readonly toMode: AgentMode;
  readonly reason: AgentModeTransition['reason'];
  readonly deltaIds: readonly string[];
  readonly summary: string;
  readonly contextViewRef: string;
  readonly contextDigest: string;
  readonly activeRefs: readonly string[];
  readonly omittedRefs: readonly string[];
  readonly replacementReason?: ContextReplacementReason;
}

export interface AgentLoopSnapshot {
  readonly modeState: AgentModeState;
  readonly checkpoint: AgentLoopCheckpoint;
  readonly contextView: ContextView;
  readonly lease: import('../../../contracts/src/index.js').ModeLease;
  readonly budgetUsage: AgentLoopBudgetUsage;
  readonly observationScope?: ObservationScope;
  readonly checkpointHistory: readonly AgentLoopCheckpoint[];
  readonly appliedDeltaIds: readonly string[];
  readonly handledBatchKeys: readonly string[];
}

export interface ObservationDeltaResult {
  readonly delta: ObservationDelta;
  readonly replacement: ContextReplacement;
  readonly checkpoint: AgentLoopCheckpoint;
  readonly contextView: ContextView;
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new RuntimeError(`${label} is required`);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function sameCheckpoint(left: AgentLoopCheckpointRef, right: AgentLoopCheckpointRef): boolean {
  return left.checkpointId.scope === right.checkpointId.scope
    && left.checkpointId.value === right.checkpointId.value
    && left.digest === right.digest;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

function refOf(checkpoint: AgentLoopCheckpoint): AgentLoopCheckpointRef {
  return { checkpointId: checkpoint.checkpointId, digest: checkpoint.digest };
}

function unique(values: readonly string[], label: string): string[] {
  const result = [...values];
  if (new Set(result).size !== result.length) throw new AgentLoopRuntimeError('conflict', `${label} contains duplicates`);
  for (const value of result) nonEmpty(value, label);
  return result;
}

function nextContextDigest(activeRefs: readonly string[], omittedRefs: readonly string[]): string {
  return digest({ activeRefs, omittedRefs });
}

export class AgentLoopRuntime {
  private readonly profiles: ReadonlyMap<AgentMode, AgentModeCapabilityProfile>;
  private readonly checkpointRecords = new Map<string, AgentLoopCheckpoint>();
  private readonly closedObservationScopes = new Set<string>();
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private leaseOrdinal = 0;
  private usage: AgentLoopBudgetUsage = {
    modeTransitions: 0,
    observationScopes: 0,
    contextReplacements: 0,
    deferredEvents: 0,
  };
  private checkpoint: AgentLoopCheckpoint;
  private contextView: ContextView;
  private modeState: AgentModeState;
  private lease: import('../../../contracts/src/index.js').ModeLease;
  private observationScope: ObservationScope | undefined;
  private inboxState: AgentLoopInboxState;
  private deltaState: AgentLoopDeltaState;

  constructor(private readonly request: AgentLoopStartRequest) {
    nonEmpty(request.agentRuntimeId, 'agent runtime id');
    nonEmpty(request.permissionRevision, 'permission revision');
    nonEmpty(request.observationStreamId, 'observation stream id');
    assertExecutionEpoch(request.executionEpoch);
    if (request.profiles.length === 0) throw new AgentLoopRuntimeError('invalid-state', 'at least one mode profile is required');
    try {
      validateAgentLoopBudget(request.budget);
      for (const profile of request.profiles) validateModeCapabilityProfile(profile);
    } catch (error) {
      throw new AgentLoopRuntimeError('invalid-state', error instanceof Error ? error.message : 'invalid agent loop configuration');
    }
    const profileMap = new Map<AgentMode, AgentModeCapabilityProfile>();
    for (const profile of request.profiles) {
      if (profile.role !== request.role) throw new AgentLoopRuntimeError('conflict', 'mode profile role does not match runtime role');
      if (profileMap.has(profile.mode)) throw new AgentLoopRuntimeError('conflict', `duplicate mode profile: ${profile.mode}`);
      profileMap.set(profile.mode, profile);
    }
    const currentProfile = profileMap.get(request.mode);
    if (!currentProfile) throw new AgentLoopRuntimeError('invalid-state', `missing profile for mode: ${request.mode}`);
    this.profiles = profileMap;
    this.now = request.now ?? (() => new Date());
    this.leaseDurationMs = request.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1) {
      throw new AgentLoopRuntimeError('invalid-state', 'lease duration must be a positive safe integer');
    }

    const scopeId = `${request.agentRuntimeId}:observation:0`;
    const contextRef = `${request.agentRuntimeId}:context:0`;
    const activeRefs = unique(request.activeRefs ?? [], 'context active refs');
    const omittedRefs = unique(request.omittedRefs ?? [], 'context omitted refs');
    if (activeRefs.some((ref) => omittedRefs.includes(ref))) {
      throw new AgentLoopRuntimeError('conflict', 'context active refs and omitted refs overlap');
    }
    const contextDigest = nextContextDigest(activeRefs, omittedRefs);
    this.checkpoint = this.createRootCheckpoint(scopeId, contextRef, contextDigest);
    this.contextView = {
      contextViewRef: contextRef,
      executionEpoch: request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      contextDigest,
      activeRefs,
      omittedRefs,
    };
    this.modeState = {
      agentRuntimeId: request.agentRuntimeId,
      mode: request.mode,
      executionEpoch: request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      observationScopeId: scopeId,
      contextViewRef: contextRef,
      leaseId: '',
      transitionSeq: 1,
    };
    this.lease = this.issueLease(currentProfile, scopeId);
    this.modeState = { ...this.modeState, leaseId: this.lease.leaseId };
    this.inboxState = {
      streamId: request.observationStreamId,
      executionEpoch: request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      observationScopeId: scopeId,
      watermark: 0,
      handledEventIds: [],
      handledBatchKeys: [],
    };
    this.deltaState = {
      executionEpoch: request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      observationScopeId: scopeId,
      watermark: { streamId: request.observationStreamId, sequence: 0 },
      appliedDeltaIds: [],
      appliedDeltaKeys: [],
    };
  }

  snapshot(): AgentLoopSnapshot {
    return {
      modeState: { ...this.modeState, checkpoint: { ...this.modeState.checkpoint } },
      checkpoint: { ...this.checkpoint, predecessor: this.checkpoint.predecessor ? { ...this.checkpoint.predecessor } : null, eventWatermark: { ...this.checkpoint.eventWatermark } },
      contextView: { ...this.contextView, checkpoint: { ...this.contextView.checkpoint }, activeRefs: [...this.contextView.activeRefs], omittedRefs: [...this.contextView.omittedRefs] },
      lease: { ...this.lease, checkpoint: { ...this.lease.checkpoint } },
      budgetUsage: { ...this.usage },
      ...(this.observationScope ? { observationScope: { ...this.observationScope, checkpoint: { ...this.observationScope.checkpoint }, scope: { ...this.observationScope.scope }, readableRefs: [...this.observationScope.readableRefs], capabilities: [...this.observationScope.capabilities] } } : {}),
      checkpointHistory: [...this.checkpointRecords.values()].map((record) => ({ ...record, predecessor: record.predecessor ? { ...record.predecessor } : null, eventWatermark: { ...record.eventWatermark } })),
      appliedDeltaIds: [...this.deltaState.appliedDeltaIds],
      handledBatchKeys: [...this.inboxState.handledBatchKeys],
    };
  }

  openObservationScope(input: OpenObservationScopeRequest): ObservationScope {
    this.requireActor(input.actor);
    if (this.modeState.mode !== 'observation') throw new AgentLoopRuntimeError('invalid-state', 'observation scope requires observation mode');
    if (this.observationScope) throw new AgentLoopRuntimeError('conflict', 'an observation scope is already open');
    if (!sameScope(input.scope, this.request.scope)) throw new AgentLoopRuntimeError('conflict', 'observation scope is outside the runtime scope');
    this.assertBudget('observationScopes', 1);
    const profile = this.requireProfile('observation');
    if (!profile.observationScopes.includes(input.kind)) throw new AgentLoopRuntimeError('invalid-state', `observation scope kind is not granted: ${input.kind}`);
    for (const capability of input.capabilities) {
      assertModeCapabilityGranted(profile, { kind: 'observation', scope: input.kind, capability });
    }
    if (!sameCheckpoint(this.modeState.checkpoint, refOf(this.checkpoint))) throw new AgentLoopRuntimeError('conflict', 'mode state checkpoint is stale');
    let scopeId = this.modeState.observationScopeId;
    if (this.closedObservationScopes.has(scopeId)) {
      scopeId = `${this.request.agentRuntimeId}:observation:${this.checkpoint.sequence}:${this.usage.observationScopes + 1}`;
    }
    const readableRefs = unique(input.readableRefs, 'observation readable refs');
    const capabilities = unique(input.capabilities, 'observation capabilities');
    const scope: ObservationScope = {
      observationScopeId: scopeId,
      agentRuntimeId: this.request.agentRuntimeId,
      executionEpoch: this.request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      kind: input.kind,
      scope: input.scope,
      readableRefs,
      capabilities,
      openedAt: this.now().toISOString(),
    };
    if (this.closedObservationScopes.has(this.modeState.observationScopeId)) {
      const nextLease = this.issueLease(profile, scopeId);
      this.modeState = { ...this.modeState, observationScopeId: scopeId, leaseId: nextLease.leaseId };
      this.lease = nextLease;
      this.inboxState = { ...this.inboxState, observationScopeId: scopeId };
      this.deltaState = { ...this.deltaState, observationScopeId: scopeId };
    }
    this.observationScope = scope;
    this.usage = { ...this.usage, observationScopes: this.usage.observationScopes + 1 };
    return { ...scope, readableRefs: [...scope.readableRefs], capabilities: [...scope.capabilities] };
  }

  closeObservationScope(actor: AgentLoopActor, observationScopeId = this.modeState.observationScopeId): ObservationScope {
    this.requireActor(actor);
    if (!this.observationScope || this.observationScope.observationScopeId !== observationScopeId) {
      throw new AgentLoopRuntimeError('invalid-state', `unknown observation scope: ${observationScopeId}`);
    }
    const closed = this.observationScope;
    this.observationScope = undefined;
    this.closedObservationScopes.add(observationScopeId);
    return { ...closed, readableRefs: [...closed.readableRefs], capabilities: [...closed.capabilities] };
  }

  mergeObservationBatch(actor: AgentLoopActor, batch: ObservationBatch): AgentLoopInboxState {
    this.requireActor(actor);
    this.requireOpenObservationScope(batch.observationScopeId);
    if (batch.priority === 'deferred') this.assertBudget('deferredEvents', batch.eventIds.length);
    const next = assertObservationBatchFresh(this.inboxState, batch);
    this.inboxState = next;
    if (batch.priority === 'deferred') this.usage = { ...this.usage, deferredEvents: this.usage.deferredEvents + batch.eventIds.length };
    return { ...next, handledEventIds: [...next.handledEventIds], handledBatchKeys: [...next.handledBatchKeys] };
  }

  applyObservationDelta(actor: AgentLoopActor, delta: ObservationDelta): ObservationDeltaResult {
    this.requireActor(actor);
    this.requireOpenObservationScope(delta.observationScopeId);
    if (delta.watermark.sequence !== this.inboxState.watermark) throw new AgentLoopRuntimeError('conflict', 'observation delta must consume the current observed batch watermark');
    const nextDeltaState = assertObservationDeltaCurrent(this.deltaState, delta);
    const activeRefs = unique([...this.contextView.activeRefs, ...delta.observationRefs], 'context active refs');
    const result = this.commitReplacement({
      deltaIds: [delta.deltaId],
      reason: 'observation',
      summary: `observation delta ${delta.deltaId}`,
      contextViewRef: `${this.request.agentRuntimeId}:context:${this.checkpoint.sequence + 1}`,
      contextDigest: nextContextDigest(activeRefs, this.contextView.omittedRefs),
      activeRefs,
      omittedRefs: this.contextView.omittedRefs,
      watermark: delta.watermark,
      observationScopeId: this.modeState.observationScopeId,
    });
    this.deltaState = { ...nextDeltaState, checkpoint: refOf(result.checkpoint) };
    this.inboxState = { ...this.inboxState, checkpoint: refOf(result.checkpoint), observationScopeId: this.modeState.observationScopeId };
    this.observationScope = undefined;
    this.closedObservationScopes.add(delta.observationScopeId);
    return { delta, ...result };
  }

  transitionMode(input: TransitionModeRequest): AgentModeTransition {
    this.requireActor(input.actor);
    if (input.toMode === this.modeState.mode) throw new AgentLoopRuntimeError('invalid-state', 'mode transition must change mode');
    this.assertBudget('modeTransitions', 1);
    this.assertBudget('contextReplacements', 1);
    if (this.inboxState.watermark !== this.checkpoint.eventWatermark.sequence
      || this.deltaState.watermark.sequence !== this.checkpoint.eventWatermark.sequence
      || !sameCheckpoint(this.deltaState.checkpoint, this.modeState.checkpoint)) {
      throw new AgentLoopRuntimeError('invalid-state', 'mode transition has pending observation events');
    }
    const targetProfile = this.requireProfile(input.toMode);
    const oldObservationScopeId = this.modeState.observationScopeId;
    const activeRefs = unique(input.activeRefs, 'context active refs');
    const omittedRefs = unique(input.omittedRefs, 'context omitted refs');
    if (activeRefs.some((ref) => omittedRefs.includes(ref))) throw new AgentLoopRuntimeError('conflict', 'context active refs and omitted refs overlap');
    const replacement = this.commitReplacement({
      deltaIds: unique(input.deltaIds, 'context replacement delta ids'),
      reason: input.replacementReason ?? (input.reason === 'recovery' ? 'recovery' : 'compaction'),
      summary: input.summary,
      contextViewRef: input.contextViewRef,
      contextDigest: input.contextDigest,
      activeRefs,
      omittedRefs,
      watermark: this.checkpoint.eventWatermark,
      observationScopeId: `${this.request.agentRuntimeId}:observation:${this.modeState.transitionSeq + 1}`,
    }, false, false);
    const transition: AgentModeTransition = {
      transitionId: `${this.request.agentRuntimeId}:transition:${this.modeState.transitionSeq + 1}`,
      fromMode: this.modeState.mode,
      toMode: input.toMode,
      executionEpoch: this.request.executionEpoch,
      baseCheckpoint: this.modeState.checkpoint,
      successorCheckpointId: replacement.checkpoint.checkpointId,
      contextReplacementId: replacement.replacement.replacementId,
      leaseId: input.actor.leaseId,
      transitionSeq: this.modeState.transitionSeq + 1,
      reason: input.reason,
    };
    assertAgentModeTransitionCurrent(transition, this.modeState, this.lease, this.now());
    this.checkpointRecords.set(replacement.checkpoint.checkpointId.value, replacement.checkpoint);
    this.usage = {
      ...this.usage,
      modeTransitions: this.usage.modeTransitions + 1,
      contextReplacements: this.usage.contextReplacements + 1,
    };
    this.checkpoint = replacement.checkpoint;
    this.contextView = replacement.contextView;
    this.modeState = {
      ...this.modeState,
      mode: input.toMode,
      checkpoint: refOf(replacement.checkpoint),
      contextViewRef: replacement.contextView.contextViewRef,
      observationScopeId: replacement.checkpoint.observationScopeId,
      leaseId: '',
      transitionSeq: transition.transitionSeq,
    };
    this.lease = this.issueLease(targetProfile, replacement.checkpoint.observationScopeId);
    this.modeState = { ...this.modeState, leaseId: this.lease.leaseId };
    this.observationScope = undefined;
    this.closedObservationScopes.add(oldObservationScopeId);
    this.inboxState = { ...this.inboxState, checkpoint: refOf(replacement.checkpoint), observationScopeId: replacement.checkpoint.observationScopeId };
    this.deltaState = { ...this.deltaState, checkpoint: refOf(replacement.checkpoint), observationScopeId: replacement.checkpoint.observationScopeId };
    return transition;
  }

  replaceContext(actor: AgentLoopActor, input: Omit<TransitionModeRequest, 'actor' | 'toMode' | 'reason'> & { readonly reason?: ContextReplacementReason }): ContextReplacement {
    this.requireActor(actor);
    const result = this.commitReplacement({
      deltaIds: unique(input.deltaIds, 'context replacement delta ids'),
      reason: input.reason ?? 'compaction',
      summary: input.summary,
      contextViewRef: input.contextViewRef,
      contextDigest: input.contextDigest,
      activeRefs: unique(input.activeRefs, 'context active refs'),
      omittedRefs: unique(input.omittedRefs, 'context omitted refs'),
      watermark: this.checkpoint.eventWatermark,
      observationScopeId: this.modeState.observationScopeId,
    });
    return result.replacement;
  }

  private commitReplacement(input: {
    readonly deltaIds: readonly string[];
    readonly reason: ContextReplacementReason;
    readonly summary: string;
    readonly contextViewRef: string;
    readonly contextDigest: string;
    readonly activeRefs: readonly string[];
    readonly omittedRefs: readonly string[];
    readonly watermark: AgentLoopEventWatermark;
    readonly observationScopeId: string;
  }, countBudget = true, updateState = true): { readonly replacement: ContextReplacement; readonly checkpoint: AgentLoopCheckpoint; readonly contextView: ContextView } {
    if (countBudget) this.assertBudget('contextReplacements', 1);
    nonEmpty(input.summary, 'checkpoint summary');
    nonEmpty(input.contextViewRef, 'context view ref');
    nonEmpty(input.contextDigest, 'context digest');
    const activeRefs = unique(input.activeRefs, 'context active refs');
    const omittedRefs = unique(input.omittedRefs, 'context omitted refs');
    if (activeRefs.some((ref) => omittedRefs.includes(ref))) throw new AgentLoopRuntimeError('conflict', 'context active refs and omitted refs overlap');
    const previous = this.checkpoint;
    const successorContextRef = input.contextViewRef;
    const contextView: ContextView = {
      contextViewRef: successorContextRef,
      executionEpoch: this.request.executionEpoch,
      checkpoint: { checkpointId: id('checkpoint', `${this.request.agentRuntimeId}-${previous.sequence + 1}`), digest: '' },
      contextDigest: input.contextDigest,
      activeRefs,
      omittedRefs,
    };
    const checkpoint = this.createSuccessorCheckpoint(input.observationScopeId, successorContextRef, input.watermark, input.summary);
    const finalizedContext = { ...contextView, checkpoint: refOf(checkpoint) };
    const replacement: ContextReplacement = {
      replacementId: `${this.request.agentRuntimeId}:replacement:${checkpoint.sequence}`,
      executionEpoch: this.request.executionEpoch,
      baseCheckpoint: refOf(previous),
      successorCheckpoint: refOf(checkpoint),
      fromContextViewRef: this.contextView.contextViewRef,
      toContextViewRef: successorContextRef,
      toContextDigest: input.contextDigest,
      deltaIds: unique(input.deltaIds, 'context replacement delta ids'),
      reason: input.reason,
      replacementDigest: digest({ base: refOf(previous), successor: refOf(checkpoint), context: finalizedContext, deltaIds: input.deltaIds, reason: input.reason }),
    };
    assertContextReplacementCurrent(replacement, this.modeState.checkpoint, this.request.executionEpoch);
    if (countBudget) this.usage = { ...this.usage, contextReplacements: this.usage.contextReplacements + 1 };
    if (updateState) {
      this.checkpointRecords.set(checkpoint.checkpointId.value, checkpoint);
      this.checkpoint = checkpoint;
      this.contextView = finalizedContext;
      this.modeState = { ...this.modeState, checkpoint: refOf(checkpoint), contextViewRef: successorContextRef };
      this.inboxState = { ...this.inboxState, checkpoint: refOf(checkpoint), observationScopeId: this.modeState.observationScopeId };
      this.deltaState = { ...this.deltaState, checkpoint: refOf(checkpoint), observationScopeId: this.modeState.observationScopeId };
      if (this.observationScope) this.observationScope = { ...this.observationScope, checkpoint: refOf(checkpoint) };
      this.lease = this.issueLease(this.requireProfile(this.modeState.mode), this.modeState.observationScopeId);
      this.modeState = { ...this.modeState, leaseId: this.lease.leaseId };
    }
    return { replacement, checkpoint, contextView: finalizedContext };
  }

  private createRootCheckpoint(observationScopeId: string, contextViewRef: string, contextDigest: string): AgentLoopCheckpoint {
    const base = {
      checkpointId: id('checkpoint', `${this.request.agentRuntimeId}-1`),
      sequence: 1,
      predecessor: null,
      executionEpoch: this.request.executionEpoch,
      eventWatermark: { streamId: this.request.observationStreamId, sequence: 0 },
      observationScopeId,
      contextViewRef,
    };
    const checkpoint: AgentLoopCheckpoint = { ...base, digest: digest({ ...base, contextDigest }) };
    this.checkpointRecords.set(checkpoint.checkpointId.value, checkpoint);
    return checkpoint;
  }

  private createSuccessorCheckpoint(observationScopeId: string, contextViewRef: string, watermark: AgentLoopEventWatermark, summary: string): AgentLoopCheckpoint {
    if (watermark.streamId !== this.request.observationStreamId || watermark.sequence < this.checkpoint.eventWatermark.sequence) {
      throw new AgentLoopRuntimeError('conflict', 'successor checkpoint watermark is stale');
    }
    const previous = this.checkpoint;
    const base = {
      checkpointId: id('checkpoint', `${this.request.agentRuntimeId}-${previous.sequence + 1}`),
      sequence: previous.sequence + 1,
      predecessor: refOf(previous),
      executionEpoch: this.request.executionEpoch,
      eventWatermark: watermark,
      observationScopeId,
      contextViewRef,
    };
    const checkpoint: AgentLoopCheckpoint = { ...base, digest: digest({ ...base, summary }) };
    validateAgentLoopCheckpoint(checkpoint, previous);
    return checkpoint;
  }

  private issueLease(profile: AgentModeCapabilityProfile, observationScopeId: string): import('../../../contracts/src/index.js').ModeLease {
    const issuedAt = this.now();
    const lease = {
      leaseId: `${this.request.agentRuntimeId}:lease:${this.leaseOrdinal += 1}`,
      agentRuntimeId: this.request.agentRuntimeId,
      role: this.request.role,
      mode: profile.mode,
      profileId: profile.profileId,
      executionEpoch: this.request.executionEpoch,
      checkpoint: refOf(this.checkpoint),
      observationScopeId,
      permissionRevision: this.request.permissionRevision,
      capabilityDigest: profile.capabilityDigest,
      state: 'active' as const,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.leaseDurationMs).toISOString(),
    };
    return lease;
  }

  private requireProfile(mode: AgentMode): AgentModeCapabilityProfile {
    const profile = this.profiles.get(mode);
    if (!profile) throw new AgentLoopRuntimeError('invalid-state', `missing mode profile: ${mode}`);
    return profile;
  }

  private requireOpenObservationScope(scopeId: string): void {
    if (!this.observationScope || this.observationScope.observationScopeId !== scopeId) {
      if (this.closedObservationScopes.has(scopeId)) throw new AgentLoopRuntimeError('invalid-state', `observation scope is closed: ${scopeId}`);
      throw new AgentLoopRuntimeError('invalid-state', `unknown observation scope: ${scopeId}`);
    }
  }

  private requireActor(actor: AgentLoopActor): void {
    if (actor.agentRuntimeId !== this.request.agentRuntimeId) throw new AgentLoopRuntimeError('unknown-owner', 'agent runtime owner does not match');
    assertModeLeaseCurrent(this.lease, {
      agentRuntimeId: this.modeState.agentRuntimeId,
      mode: this.modeState.mode,
      executionEpoch: this.modeState.executionEpoch,
      checkpoint: this.modeState.checkpoint,
      observationScopeId: this.modeState.observationScopeId,
      leaseId: this.modeState.leaseId,
    }, this.now());
    if (actor.leaseId !== this.lease.leaseId) throw new AgentLoopRuntimeError('conflict', 'agent loop lease is stale');
  }

  private assertBudget(kind: keyof AgentLoopBudgetUsage, increment: number): void {
    const current = this.usage[kind];
    const limitKey = kind === 'modeTransitions' ? 'maxModeTransitions'
      : kind === 'observationScopes' ? 'maxObservationScopes'
        : kind === 'contextReplacements' ? 'maxContextReplacements' : 'maxDeferredEvents';
    const limit = this.request.budget[limitKey];
    if (current + increment > limit) {
      const decision = classifyAgentLoopBudget(this.request.budget, { ...this.usage, [kind]: limit });
      throw new AgentLoopRuntimeError('budget-exhausted', `agent loop budget exhausted: ${decision.state === 'blocked' ? decision.reason : limitKey}`);
    }
  }
}
