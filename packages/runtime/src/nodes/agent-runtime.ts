import {
  assertBusinessPayload,
  assertExecutionEpoch,
  assertEvidenceRef,
  assertSameScope,
  type AgentClosure,
  type AgentDriver,
  type AgentEvent,
  type AgentHandle,
  type Attention,
  type AgentOutput,
  type BusinessPayload,
  type CheckpointId,
  type Checkpoint,
  type EvidenceRef,
  type LifecycleState,
  type NextAction,
  type OperationId,
  type StopRequestReceipt,
  type ScopeRef,
  type TaskId,
} from '../../../contracts/src/index.js';
import { fenceExecutionEvent, type LateEventRejection } from '../../../core/src/epoch.js';
import { assertTransitionLifecycle } from '../../../core/src/lifecycle.js';
import { requireReference, RuntimeError } from './errors.js';

export interface AgentRuntimeBinding {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly ownerRef: string;
  readonly waitConditionRef?: string;
  readonly recoveryRef?: string;
}

export interface AgentRuntimeClosure extends AgentClosure {
  readonly ownerRef: string;
  readonly nextAction?: NextAction;
  readonly conditionRef?: string;
  readonly failureRef?: string;
}

export type AgentRuntimeObservation =
  | { readonly accepted: true; readonly event: AgentEvent }
  | { readonly accepted: false; readonly rejection: LateEventRejection };

export interface AgentRuntimeSnapshot {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly state: LifecycleState;
  readonly handle?: AgentHandle;
  readonly closure?: AgentRuntimeClosure;
}

interface StopAttentionRecord {
  readonly operationId: OperationId;
  readonly attention: Attention;
  readonly phase: 'publishing' | 'publication-in-flight' | 'published' | 'resolution-pending';
  readonly originalResolved: boolean;
  readonly resolutionInFlight?: boolean;
  readonly resolutionAttention?: {
    readonly attention: Attention;
    readonly published: boolean;
    readonly publicationPhase: 'pending' | 'in-flight' | 'published';
    readonly originalFailure?: unknown;
    readonly publicationFailure?: unknown;
  };
  readonly originalFailure?: unknown;
  readonly publicationFailure?: unknown;
}

interface StopControlBinding {
  readonly runtimeId: string;
  readonly executionEpoch: number;
  readonly ownerId: string;
  readonly scope: ScopeRef;
}

function sameEvidence(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.evidenceId.value === right.evidenceId.value
    && left.kind === right.kind
    && left.source === right.source
    && left.locator === right.locator
    && left.digest === right.digest
    && left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId?.value === right.scope.taskId?.value
    && left.scope.cycleId?.value === right.scope.cycleId?.value
    && left.scope.operationId?.value === right.scope.operationId?.value;
}

export interface PendingStopSettlement {
  readonly runtimeId: string;
  readonly executionEpoch: number;
  readonly operationId: OperationId;
  readonly ownerId: string;
  readonly stopReceipt: StopRequestReceipt;
  readonly closure: AgentClosure;
  readonly checkpoint: Checkpoint;
  readonly checkpointCommitted: boolean;
}

type StopSettlementInput = Omit<PendingStopSettlement, 'checkpointCommitted'>;

const DRIVER_BINDINGS = new WeakMap<AgentDriver, AgentRuntime>();

export function bindAgentDriver(runtime: AgentRuntime, driver: AgentDriver): AgentDriver {
  if (driver !== runtime.driver) DRIVER_BINDINGS.set(driver, runtime);
  return driver;
}

export class AgentRuntime {
  private state: LifecycleState = 'created';
  private handle: AgentHandle | undefined;
  private closure: AgentRuntimeClosure | undefined;
  private readonly stale: LateEventRejection[] = [];
  private stopControlOperationId: OperationId | undefined;
  private stopControlPhase: 'active' | 'retryable' | undefined;
  private stopControlBinding: StopControlBinding | undefined;
  private stopAttentionRecord: StopAttentionRecord | undefined;
  private stopSettlement: PendingStopSettlement | undefined;
  private initializationInFlight = false;
  private submitInFlight = false;

  constructor(
    readonly driver: AgentDriver,
    readonly binding: AgentRuntimeBinding,
  ) {
    requireReference(binding.runtimeId, 'runtimeId');
    requireReference(binding.assignmentId, 'assignmentId');
    requireReference(binding.ownerRef, 'agent runtime ownerRef');
    assertExecutionEpoch(binding.executionEpoch);
  }

  async start(): Promise<AgentHandle> {
    this.beginInitialization();
    try {
      const handle = await this.driver.start({
        runtimeId: this.binding.runtimeId,
        taskId: this.binding.taskId,
        executionEpoch: this.binding.executionEpoch,
        assignmentId: this.binding.assignmentId,
      });
      this.completeInitialization(handle);
      return handle;
    } catch (error) {
      this.initializationInFlight = false;
      throw error;
    }
  }

  async resume(checkpointId: CheckpointId): Promise<AgentHandle> {
    this.beginInitialization();
    try {
      const handle = await this.driver.resume({
        runtimeId: this.binding.runtimeId,
        taskId: this.binding.taskId,
        executionEpoch: this.binding.executionEpoch,
        assignmentId: this.binding.assignmentId,
        checkpointId,
      });
      this.completeInitialization(handle);
      return handle;
    } catch (error) {
      this.initializationInFlight = false;
      throw error;
    }
  }

  async submit(payload: BusinessPayload): Promise<AgentOutput> {
    this.requireRunning();
    if (this.submitInFlight) throw new RuntimeError('agent runtime already has a business submit in flight', this.errorContext());
    this.submitInFlight = true;
    try {
      assertBusinessPayload(payload);
      const output = await this.driver.submit({
        taskId: this.binding.taskId,
        executionEpoch: this.binding.executionEpoch,
        assignmentId: this.binding.assignmentId,
        payload,
      });
      this.requireRunning();
      if (
        output.taskId.value !== this.binding.taskId.value
        || output.executionEpoch !== this.binding.executionEpoch
        || output.assignmentId !== this.binding.assignmentId
      ) {
        throw new RuntimeError('agent output is not bound to the current runtime', this.errorContext());
      }
      return structuredClone(output);
    } finally {
      this.submitInFlight = false;
    }
  }

  async *observe(): AsyncIterable<AgentRuntimeObservation> {
    if (!this.handle) throw new RuntimeError('agent runtime has not started', this.errorContext());
    this.requireRunning();
    for await (const event of this.driver.observe({ runtimeId: this.binding.runtimeId })) {
      this.requireRunning();
      const decision = fenceExecutionEvent(
        { taskId: this.binding.taskId, executionEpoch: this.binding.executionEpoch },
        event,
      );
      if (decision.accepted) {
        yield { accepted: true, event };
      } else {
        this.stale.push(decision);
        yield { accepted: false, rejection: decision };
      }
    }
  }

  async settle(): Promise<AgentRuntimeClosure> {
    if (this.stopControlOperationId) {
      throw new RuntimeError('agent runtime is settling through stop control', this.errorContext());
    }
    this.requireRunning();
    if (!this.handle) throw new RuntimeError('agent runtime has not started', this.errorContext());
    this.state = this.advance('running', 'settling');
    let closure: AgentClosure;
    try {
      closure = await this.driver.settle({
        runtimeId: this.handle.runtimeId,
        executionEpoch: this.binding.executionEpoch,
      });
    } catch (cause) {
      this.state = this.advance('settling', 'running');
      throw new RuntimeError(
        cause instanceof Error ? `agent settle failed: ${cause.message}` : 'agent settle failed',
        { ...this.errorContext(), cause, failureRef: this.binding.recoveryRef ?? `agent-settle:${this.binding.runtimeId}:${this.binding.executionEpoch}` },
      );
    }
    if (this.stopControlOperationId) {
      throw new RuntimeError('agent runtime is settling through stop control', this.errorContext());
    }
    const bounded = this.bindClosure(closure);
    if (bounded.state === 'stopped') {
      this.state = 'running';
      throw new RuntimeError('ordinary agent settle cannot complete stopped; use stop control', this.errorContext());
    }
    if (this.state !== 'settling') throw new RuntimeError(`agent runtime is no longer settling: ${this.state}`, this.errorContext());
    this.state = this.advance('settling', bounded.state);
    this.closure = bounded;
    return structuredClone(bounded);
  }

  snapshot(): AgentRuntimeSnapshot {
    return {
      runtimeId: this.binding.runtimeId,
      taskId: this.binding.taskId,
      assignmentId: this.binding.assignmentId,
      executionEpoch: this.binding.executionEpoch,
      state: this.state,
      handle: this.handle ? structuredClone(this.handle) : undefined,
      closure: this.closure ? structuredClone(this.closure) : undefined,
    };
  }

  staleEvents(): readonly LateEventRejection[] {
    return structuredClone(this.stale);
  }

  assertStopTarget(runtimeId: string, taskId: TaskId, executionEpoch: number): void {
    if (
      this.binding.runtimeId !== runtimeId
      || this.binding.taskId.value !== taskId.value
      || this.binding.executionEpoch !== executionEpoch
    ) {
      throw new RuntimeError('agent runtime stop target does not match stop control', this.errorContext());
    }
    if (!['admitted', 'running', 'waiting', 'blocked'].includes(this.state)) {
      throw new RuntimeError(`agent runtime cannot be stopped: ${this.state}`, this.errorContext());
    }
  }

  assertDriverBinding(driver: AgentDriver): void {
    if (driver !== this.driver && DRIVER_BINDINGS.get(driver) !== this) {
      throw new RuntimeError('stop driver is not bound to agent runtime', this.errorContext());
    }
  }

  isStopRetryable(operationId: OperationId): boolean {
    return this.stopControlOperationId?.value === operationId.value && this.stopControlPhase === 'retryable';
  }

  recordStopAttention(operationId: OperationId, attention: Attention, originalFailure?: unknown): void {
    this.assertStopControlOwner(operationId);
    this.stopAttentionRecord = { operationId, attention: structuredClone(attention), phase: 'publishing', originalResolved: false, originalFailure };
  }

  pendingStopAttention(operationId: OperationId): Attention | undefined {
    if (this.stopAttentionRecord?.operationId.value !== operationId.value || this.stopAttentionRecord.phase !== 'publishing') return undefined;
    return structuredClone(this.stopAttentionRecord.attention);
  }

  claimStopAttentionPublication(operationId: OperationId): Attention {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'publishing') throw new RuntimeError('agent runtime stop attention publication is not pending', this.errorContext());
    this.stopAttentionRecord = { ...record, phase: 'publication-in-flight' };
    return structuredClone(record.attention);
  }

  markStopAttentionPublicationFailed(operationId: OperationId): void {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'publication-in-flight') throw new RuntimeError('agent runtime stop attention publication is not in flight', this.errorContext());
    this.stopAttentionRecord = { ...record, phase: 'publishing' };
  }

  recordStopAttentionPublicationFailure(operationId: OperationId, failure: unknown): void {
    const record = this.requireStopAttention(operationId);
    this.stopAttentionRecord = { ...record, publicationFailure: failure };
  }

  markStopAttentionPublished(operationId: OperationId): void {
    this.assertStopControlOwner(operationId);
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'publication-in-flight') throw new RuntimeError('agent runtime stop attention publication is not in flight', this.errorContext());
    this.stopAttentionRecord = { ...record, phase: 'published' };
  }

  stopAttention(operationId: OperationId): string | undefined {
    const record = this.stopAttentionRecord;
    if (record?.operationId.value !== operationId.value || record.phase !== 'resolution-pending') return undefined;
    return record.attention.attentionId;
  }

  stopAttentionForCompletion(operationId: OperationId): string | undefined {
    const record = this.stopAttentionRecord;
    if (record?.operationId.value !== operationId.value || record.phase === 'publishing' || record.phase === 'publication-in-flight') return undefined;
    return record.attention.attentionId;
  }

  beginStopAttentionResolution(operationId: OperationId, attention: Attention, originalFailure?: unknown): void {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending') throw new RuntimeError('agent runtime stop attention is not ready for resolution', this.errorContext());
    if (record.resolutionAttention) throw new RuntimeError('agent runtime already tracks stop resolution attention', this.errorContext());
    this.stopAttentionRecord = {
      ...record,
      resolutionAttention: {
        attention: structuredClone(attention),
        published: false,
        publicationPhase: 'pending',
        originalFailure,
      },
    };
  }

  pendingStopAttentionResolution(operationId: OperationId): Attention | undefined {
    const resolution = this.requireStopAttention(operationId).resolutionAttention;
    return resolution?.published || resolution?.publicationPhase !== 'pending' ? undefined : structuredClone(resolution.attention);
  }

  stopAttentionResolutionAttention(operationId: OperationId): Attention | undefined {
    const attention = this.requireStopAttention(operationId).resolutionAttention?.attention;
    return attention ? structuredClone(attention) : undefined;
  }

  assertStopAttentionResolutionBinding(
    operationId: OperationId,
    scope: Attention['scope'],
    ownerId: string,
    evidenceRefs: readonly EvidenceRef[],
  ): void {
    const record = this.requireStopAttention(operationId);
    const resolution = record.resolutionAttention;
    const bound = resolution?.attention ?? record.attention;
    try {
      assertSameScope(bound.scope, scope);
      if (bound.ownerId !== undefined && bound.ownerId !== ownerId) throw new RuntimeError('stop attention resolution owner does not match binding', this.errorContext());
      if (evidenceRefs.length === 0) throw new RuntimeError('stop attention resolution evidence is required', this.errorContext());
      for (const evidenceRef of evidenceRefs) {
        assertEvidenceRef(evidenceRef);
        assertSameScope(bound.scope, evidenceRef.scope);
      }
      if (resolution && (resolution.attention.ownerId !== ownerId || resolution.attention.evidenceRefs.length !== evidenceRefs.length || resolution.attention.evidenceRefs.some((evidence, index) => !sameEvidence(evidence, evidenceRefs[index]!)))) {
        throw new RuntimeError('stop attention resolution evidence does not match binding', this.errorContext());
      }
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(error instanceof Error ? error.message : 'stop attention resolution binding is invalid', this.errorContext());
    }
  }

  claimStopAttentionResolution(operationId: OperationId): string {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending' || record.resolutionInFlight) {
      throw new RuntimeError('agent runtime stop attention resolution is already in flight', this.errorContext());
    }
    this.stopAttentionRecord = { ...record, resolutionInFlight: true };
    return record.attention.attentionId;
  }

  releaseStopAttentionResolution(operationId: OperationId): void {
    const record = this.stopAttentionRecord;
    if (!record || record.operationId.value !== operationId.value) return;
    this.stopAttentionRecord = { ...record, resolutionInFlight: false };
  }

  markStopAttentionResolutionPublished(operationId: OperationId): void {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending' || !record.resolutionAttention || record.resolutionAttention.publicationPhase !== 'in-flight') {
      throw new RuntimeError('agent runtime stop resolution publication is not pending', this.errorContext());
    }
    this.stopAttentionRecord = {
      ...record,
      resolutionAttention: {
        ...record.resolutionAttention,
        published: true,
        publicationPhase: 'published',
      },
    };
  }

  claimStopAttentionResolutionPublication(operationId: OperationId): Attention {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending' || !record.resolutionAttention || record.resolutionAttention.publicationPhase !== 'pending') {
      throw new RuntimeError('agent runtime stop resolution publication is not pending', this.errorContext());
    }
    this.stopAttentionRecord = {
      ...record,
      resolutionAttention: { ...record.resolutionAttention, publicationPhase: 'in-flight' },
    };
    return structuredClone(record.resolutionAttention.attention);
  }

  markStopAttentionResolutionPublicationFailed(operationId: OperationId, failure: unknown): void {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending' || !record.resolutionAttention || record.resolutionAttention.publicationPhase !== 'in-flight') {
      throw new RuntimeError('agent runtime stop resolution publication is not in flight', this.errorContext());
    }
    this.stopAttentionRecord = {
      ...record,
      resolutionAttention: {
        ...record.resolutionAttention,
        publicationPhase: 'pending',
        publicationFailure: failure,
      },
    };
  }

  stopAttentionResolution(operationId: OperationId): string | undefined {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending') return undefined;
    return record.resolutionAttention?.published ? record.resolutionAttention.attention.attentionId : undefined;
  }

  markStopAttentionResolutionResolved(operationId: OperationId): void {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending' || !record.resolutionAttention?.published) {
      throw new RuntimeError('agent runtime has no pending resolution attention', this.errorContext());
    }
    this.stopAttentionRecord = { ...record, resolutionAttention: undefined };
  }

  stopAttentionResolutionFailure(operationId: OperationId): unknown {
    return this.requireStopAttention(operationId).resolutionAttention?.originalFailure;
  }

  stopAttentionOriginalFailure(operationId: OperationId): unknown {
    return this.requireStopAttention(operationId).originalFailure;
  }

  markStopAttentionResolved(operationId: OperationId): void {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending') throw new RuntimeError('agent runtime stop attention is not ready for resolution', this.errorContext());
    this.stopAttentionRecord = { ...record, originalResolved: true };
  }

  isStopAttentionResolved(operationId: OperationId): boolean {
    return this.requireStopAttention(operationId).originalResolved;
  }

  clearStopAttention(operationId: OperationId): void {
    const record = this.requireStopAttention(operationId);
    if (record.phase !== 'resolution-pending' || !record.originalResolved || record.resolutionAttention) {
      throw new RuntimeError('agent runtime stop attention resolution is incomplete', this.errorContext());
    }
    this.stopAttentionRecord = undefined;
  }

  recordStopSettlement(operationId: OperationId, settlement: StopSettlementInput, checkpointCommitted = false): void {
    this.assertStopControlOwner(operationId);
    this.stopSettlement = structuredClone({ ...settlement, checkpointCommitted });
  }

  pendingStopSettlement(operationId: OperationId): PendingStopSettlement | undefined {
    return this.stopControlOperationId?.value === operationId.value && this.stopSettlement
      ? structuredClone(this.stopSettlement)
      : undefined;
  }

  clearStopSettlement(operationId: OperationId): void {
    if (this.stopControlOperationId) {
      this.assertStopControlOwner(operationId);
    } else if (this.state !== 'stopped' || this.stopSettlement?.operationId.value !== operationId.value) {
      throw new RuntimeError('agent runtime stop settlement does not belong to operation', this.errorContext());
    }
    this.stopSettlement = undefined;
  }

  beginStop(runtimeId: string, executionEpoch: number, operationId: OperationId, ownerId: string, scope: ScopeRef): void {
    this.assertStopTarget(runtimeId, this.binding.taskId, executionEpoch);
    const requestedBinding = { runtimeId, executionEpoch, ownerId, scope: structuredClone(scope) };
    if (this.stopControlOperationId) {
      if (this.stopControlOperationId.value === operationId.value && this.stopControlPhase === 'retryable') {
        const binding = this.stopControlBinding;
        if (!binding || binding.runtimeId !== requestedBinding.runtimeId || binding.executionEpoch !== requestedBinding.executionEpoch || binding.ownerId !== requestedBinding.ownerId) {
          throw new RuntimeError('agent runtime stop retry binding does not match original stop control', this.errorContext());
        }
        try {
          assertSameScope(binding.scope, requestedBinding.scope);
        } catch {
          throw new RuntimeError('agent runtime stop retry scope does not match original stop control', this.errorContext());
        }
        this.stopControlPhase = 'active';
        return;
      }
      throw new RuntimeError('agent runtime already has an active stop control', this.errorContext());
    }
    this.stopControlOperationId = operationId;
    this.stopControlPhase = 'active';
    this.stopControlBinding = requestedBinding;
  }

  releaseStopClaim(operationId: OperationId): void {
    if (!this.stopControlOperationId) return;
    this.assertStopControlOwner(operationId);
    this.stopControlOperationId = undefined;
    this.stopControlPhase = undefined;
    this.stopControlBinding = undefined;
  }

  markStopRetryable(operationId: OperationId): void {
    this.assertStopControlOwner(operationId);
    this.stopControlPhase = 'retryable';
  }

  markStopped(operationId: OperationId, closure: AgentClosure): void {
    this.assertStopControlOwner(operationId);
    if (closure.state !== 'stopped') throw new RuntimeError(`agent runtime stop closure is not stopped: ${closure.state}`, this.errorContext());
    const bounded = this.bindClosure(closure);
    const attention = this.stopAttentionRecord;
    if (this.state === 'stopped') {
      this.closure = bounded;
      this.stopControlOperationId = undefined;
      this.stopControlPhase = undefined;
      this.stopControlBinding = undefined;
      return;
    }
    if (['admitted', 'running', 'waiting', 'blocked'].includes(this.state)) {
      this.state = this.advance(this.state, 'settling');
    }
    if (this.state === 'settling') {
      this.state = this.advance('settling', 'stopped');
      this.closure = bounded;
      this.stopControlOperationId = undefined;
      this.stopControlPhase = undefined;
      this.stopControlBinding = undefined;
      if (attention?.operationId.value === operationId.value && attention.phase === 'published') {
        this.stopAttentionRecord = { ...attention, phase: 'resolution-pending' };
      }
      return;
    }
    throw new RuntimeError(`agent runtime cannot be marked stopped: ${this.state}`, this.errorContext());
  }

  private assertStopControlOwner(operationId: OperationId): void {
    if (this.stopControlOperationId?.value !== operationId.value) {
      throw new RuntimeError('agent runtime stop control operation does not own active claim', this.errorContext());
    }
  }

  private requireStopAttention(operationId: OperationId): StopAttentionRecord {
    const record = this.stopAttentionRecord;
    if (!record || record.operationId.value !== operationId.value) {
      throw new RuntimeError('agent runtime stop attention does not belong to operation', this.errorContext());
    }
    return record;
  }

  private beginInitialization(): void {
    if (this.state !== 'created') throw new RuntimeError(`agent runtime already started: ${this.state}`, this.errorContext());
    if (this.initializationInFlight) throw new RuntimeError('agent runtime initialization is already in flight', this.errorContext());
    this.initializationInFlight = true;
  }

  private completeInitialization(handle: AgentHandle): void {
    this.assertHandle(handle);
    if (!this.initializationInFlight || this.state !== 'created') {
      throw new RuntimeError(`agent runtime initialization returned after state changed: ${this.state}`, this.errorContext());
    }
    this.state = this.advance('created', 'admitted');
    this.state = this.advance('admitted', 'running');
    this.handle = handle;
    this.initializationInFlight = false;
  }

  private bindClosure(closure: AgentClosure): AgentRuntimeClosure {
    let nextAction: NextAction | undefined;
    let conditionRef: string | undefined;
    let failureRef: string | undefined;
    if (closure.state === 'waiting') {
      conditionRef = requireReference(this.binding.waitConditionRef, 'agent waiting conditionRef');
      nextAction = { kind: 'wait', ref: conditionRef };
    } else if (closure.state === 'blocked' || closure.state === 'failed' || closure.state === 'unknown') {
      const recoveryRef = requireReference(this.binding.recoveryRef, 'agent recoveryRef');
      nextAction = { kind: 'recover', ref: recoveryRef };
      conditionRef = closure.state === 'blocked' ? recoveryRef : undefined;
      failureRef = closure.state === 'failed' ? recoveryRef : undefined;
    }
    return {
      ...closure,
      ownerRef: this.binding.ownerRef,
      nextAction,
      conditionRef,
      failureRef,
      evidenceRefs: structuredClone(closure.evidenceRefs),
    };
  }

  private assertHandle(handle: AgentHandle): void {
    if (handle.runtimeId !== this.binding.runtimeId || handle.executionEpoch !== this.binding.executionEpoch) {
      throw new RuntimeError('agent driver returned a handle for another runtime or epoch', this.errorContext());
    }
  }

  private requireRunning(): void {
    if (this.state !== 'running') throw new RuntimeError(`agent runtime is not running: ${this.state}`, this.errorContext());
    if (this.stopControlOperationId) throw new RuntimeError('agent runtime has an active stop control', this.errorContext());
  }

  private advance(from: LifecycleState, to: LifecycleState): LifecycleState {
    assertTransitionLifecycle(from, to);
    return to;
  }

  private errorContext(): RuntimeErrorContext {
    return { ownerRef: this.binding.ownerRef, nextAction: this.binding.recoveryRef ? { kind: 'recover', ref: this.binding.recoveryRef } : undefined };
  }
}

interface RuntimeErrorContext {
  readonly ownerRef?: string;
  readonly nextAction?: NextAction;
}
