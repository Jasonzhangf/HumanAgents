import { randomUUID } from 'node:crypto';
import {
  assertEvidenceRef,
  assertScope,
  effectiveOperationScope,
  operationIdempotencyKey,
  operationSemanticFingerprint,
  operationSemanticFingerprintKey,
  scopeContains,
  validateOperationEvent,
  validateOperationFailure,
  validateOperationIntent,
  validateOperationResult,
  validateRouteSelection,
  type EvidenceRef,
  type OperationEvent,
  type OperationFailure,
  type OperationId,
  type OperationIntent,
  type OperationLease,
  type OperationResult,
  type OperationStatus,
  type RouteSelection,
  type Scope,
  type ScopeRef,
  type ToolRegistration,
} from '../../../contracts/src/index.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import {
  assertTransitionOperationStatus,
  planBlockedRecovery,
  planOperationCancellation,
  planReconcileRequiredResolution,
} from '../../../core/src/index.js';
import { GatewayError, OperationNotificationError } from './errors.js';
import { HandRuntime, type HandEmitSettlement } from './hand-runtime.js';
import type {
  OperationBlockedState,
  OperationChildAdmission,
  OperationControlBinding,
  OperationControlReadback,
  OperationControlRecord,
  OperationControlSelector,
  OperationCoverageInitialization,
  OperationExecutorObservation,
  OperationExecutorPort,
  OperationJournalPort,
  OperationPermissionPort,
  OperationReconcileState,
  OperationSnapshot,
  OperationStopSettlementPort,
  OperationStopSettlementReceipt,
  OperationSubmissionResult,
  OperationTaskBoundaryPort,
  OperationVerifierPort,
  ExternalOperationLifecycle,
  ResolveReconcileInput,
  ResumeOperationInput,
} from './ports.js';
import { ToolRegistry, type ResolvedToolRegistration } from './registry.js';

export interface GatewayOptions {
  readonly registry: ToolRegistry;
  readonly permissions: OperationPermissionPort;
  readonly taskBoundaries: OperationTaskBoundaryPort;
  readonly executor: OperationExecutorPort;
  readonly stopSettlement?: OperationStopSettlementPort;
  readonly verifier: OperationVerifierPort;
  readonly journal: OperationJournalPort;
  readonly now?: () => Date;
  readonly leaseDurationMs?: number;
}

interface OperationRecord {
  readonly binding: OperationControlBinding;
  readonly childAdmission?: OperationChildAdmission;
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  readonly namespaceKey: string;
  readonly fingerprintKey: string;
  status: OperationStatus;
  executionEpoch: number;
  lease?: OperationLease;
  observation?: OperationExecutorObservation;
  result?: OperationResult;
  failure?: OperationFailure;
  blocked?: OperationBlockedState;
  reconcile?: OperationReconcileState;
  executionInvalidated?: boolean;
}

interface PendingSubmission {
  readonly fingerprintKey: string;
  readonly promise: Promise<OperationRecord>;
}

function resultRef(operationId: OperationIntent['operationId']): string {
  return `operation-result:${operationId.value}`;
}

function operationKey(operationId: OperationIntent['operationId']): string {
  return `${operationId.scope.length}:${operationId.scope}${operationId.value.length}:${operationId.value}`;
}

/**
 * Copy the full mutable operation state, including optional fields, so a
 * successor can be committed before it is published to the cache. Spreading a
 * record omits never-assigned optional keys; this explicit copy keeps every
 * field so a successor can clear previously set lease/blocked/reconcile state.
 */
function cloneRecord(record: OperationRecord): OperationRecord {
  return {
    binding: record.binding,
    childAdmission: record.childAdmission,
    intent: record.intent,
    registration: record.registration,
    route: record.route,
    namespaceKey: record.namespaceKey,
    fingerprintKey: record.fingerprintKey,
    status: record.status,
    executionEpoch: record.executionEpoch,
    lease: record.lease,
    observation: record.observation,
    result: record.result,
    failure: record.failure,
    blocked: record.blocked,
    reconcile: record.reconcile,
    executionInvalidated: record.executionInvalidated,
  };
}

function isTerminalOperationStatus(status: OperationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string },
  right: { readonly scope: string; readonly value: string },
): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function assertCommitRef(value: JournalCommitRef, label: string): void {
  if (typeof value.commitId !== 'string' || value.commitId.trim().length === 0
    || !Number.isSafeInteger(value.journalSeq)
    || typeof value.recordDigest !== 'string' || value.recordDigest.trim().length === 0) {
    throw new GatewayError('invalid-state', `${label} must be a real journal commit receipt`);
  }
}

function sameCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function sameScopeRef(left: ScopeRef, right: ScopeRef): boolean {
  return sameScopedId(left.organId, right.organId)
    && (left.taskId?.value ?? null) === (right.taskId?.value ?? null)
    && (left.cycleId?.value ?? null) === (right.cycleId?.value ?? null)
    && (left.operationId?.value ?? null) === (right.operationId?.value ?? null);
}

function sameControlBinding(left: OperationControlBinding, right: OperationControlBinding): boolean {
  return sameScopeRef(left.scope, right.scope)
    && left.agentRuntimeId === right.agentRuntimeId
    && left.harnessExecutionEpoch === right.harnessExecutionEpoch
    && sameScopedId(left.parentOperationId, right.parentOperationId)
    && sameCommitRef(left.admissionCommitRef, right.admissionCommitRef);
}

function sameChildAdmission(
  left: OperationChildAdmission | undefined,
  right: OperationChildAdmission | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameCommitRef(left.authorityCommitRef, right.authorityCommitRef)
    && sameCommitRef(left.businessRegistrationCommitRef, right.businessRegistrationCommitRef)
    && sameCommitRef(left.coverageCommitRef, right.coverageCommitRef);
}

/**
 * A parent permits new child effects only while it is a live, non-stopped,
 * non-terminal operation. Terminal, blocked, cancel-requested and
 * reconcile-required parents never authorize child IO.
 */
function isPermittingParentStatus(status: OperationStatus): boolean {
  return status === 'accepted'
    || status === 'queued'
    || status === 'leased'
    || status === 'running'
    || status === 'settling'
    || status === 'verifying';
}

export class ToolExecutionGateway {
  private readonly registry: ToolRegistry;
  private readonly permissions: OperationPermissionPort;
  private readonly taskBoundaries: OperationTaskBoundaryPort;
  private readonly executor: OperationExecutorPort;
  private readonly stopSettlement?: OperationStopSettlementPort;
  private readonly verifier: OperationVerifierPort;
  private readonly journal: OperationJournalPort;
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;
  private readonly hand: HandRuntime;
  private readonly operations = new Map<string, OperationRecord>();
  private readonly executions = new Map<string, Promise<OperationSnapshot>>();
  private readonly idempotency = new Map<string, { readonly namespaceKey: string; readonly fingerprintKey: string; readonly operationId: string }>();
  private readonly pendingSubmissions = new Map<string, PendingSubmission>();
  private readonly operationLocks = new Map<string, Promise<void>>();
  private readonly notificationFailures = new Map<string, OperationNotificationError>();
  constructor(options: GatewayOptions) {
    this.registry = options.registry;
    this.permissions = options.permissions;
    this.taskBoundaries = options.taskBoundaries;
    this.executor = options.executor;
    this.stopSettlement = options.stopSettlement;
    this.verifier = options.verifier;
    this.journal = options.journal;
    this.now = options.now ?? (() => new Date());
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1) {
      throw new GatewayError('invalid-state', 'lease duration must be a positive safe integer');
    }
    this.hand = new HandRuntime({
      executor: this.executor,
      verifier: this.verifier,
      emit: (event, settlement) => this.emit(event, settlement),
      createEvidence: (label, scope) => this.createEvidence(label, scope),
      now: this.now,
    });
  }

  async submit(
    intent: OperationIntent,
    binding: OperationControlBinding,
    childAdmission?: OperationChildAdmission,
  ): Promise<OperationSubmissionResult> {
    validateOperationIntent(intent);
    this.assertControlBinding(binding, intent, childAdmission);
    if (childAdmission !== undefined) {
      await this.verifyChildAdmission(binding, intent, childAdmission);
    }
    const resolved = this.registry.resolve(intent);
    const namespaceKey = operationIdempotencyKey(intent);
    const fingerprintKey = operationSemanticFingerprintKey(
      operationSemanticFingerprint(intent, resolved.registration),
    );

    const existing = this.idempotency.get(namespaceKey);
    if (existing) {
      return this.replayOrConflict(existing, fingerprintKey, binding, childAdmission);
    }

    const pending = this.pendingSubmissions.get(namespaceKey);
    if (pending) {
      if (pending.fingerprintKey !== fingerprintKey) {
        throw new GatewayError(
          'idempotency-conflict',
          'idempotency key is already being accepted with a different semantic fingerprint',
          { ownerRef: resolved.registration.owner },
        );
      }
      const operation = await pending.promise;
      this.assertReplayIdentity(operation, binding, childAdmission);
      this.throwPendingNotificationFailure(intent.operationId);
      return { decision: 'replay', operation: this.snapshot(operation) };
    }

    const promise = this.acceptNew(intent, binding, resolved, namespaceKey, fingerprintKey, childAdmission);
    this.pendingSubmissions.set(namespaceKey, { fingerprintKey, promise });
    try {
      const operation = await promise;
      this.throwPendingNotificationFailure(intent.operationId);
      return { decision: 'new', operation: this.snapshot(operation) };
    } finally {
      const current = this.pendingSubmissions.get(namespaceKey);
      if (current?.promise === promise) this.pendingSubmissions.delete(namespaceKey);
    }
  }

  async execute(operationId: OperationIntent['operationId']): Promise<OperationSnapshot> {
    const key = operationKey(operationId);
    const existing = this.executions.get(key);
    if (existing) return existing;
    const execution = this.executeOnce(operationId);
    this.executions.set(key, execution);
    try {
      return await execution;
    } finally {
      if (this.executions.get(key) === execution) this.executions.delete(key);
    }
  }

  private async executeOnce(operationId: OperationIntent['operationId']): Promise<OperationSnapshot> {
    const prepared = await this.withOperationLock(operationId, async () => {
      const record = this.requireOperation(operationId);
      if (record.status === 'accepted') {
        await this.transition(
          record,
          'queued',
          'operation.queued',
          [this.createEvidence('operation-queued', record.route.effectiveScope)],
        );
      }
      if (record.status !== 'queued') {
        throw new GatewayError(
          'invalid-state',
          `operation ${operationId.value} cannot execute from ${record.status}`,
          { operationStatus: record.status },
        );
      }
      return {
        record,
        lease: await this.leaseAndPrepare(record),
      };
    });
    if (!prepared.lease) return this.snapshot(prepared.record);
    const outcome = await this.executePrepared(prepared.record, prepared.lease);
    return this.withOperationLock(operationId, async () => {
      const record = this.requireOperation(operationId);
      if (this.shouldIgnoreLateOutcome(record)) {
        return this.snapshot(record);
      }
      return this.applyHandOutcome(record, outcome);
    });
  }

  async resume(operationId: OperationIntent['operationId'], input: ResumeOperationInput = {}): Promise<OperationSnapshot> {
    const recovery = await this.withOperationLock(operationId, async () => {
      const record = this.requireOperation(operationId);
      if (record.status !== 'blocked' || !record.blocked) {
        throw new GatewayError(
          'invalid-state',
          `operation ${operationId.value} is not blocked`,
          { operationStatus: record.status },
        );
      }

      const blockedAfter = input.blockedAfter ?? record.blocked.blockedAfter;
      const sideEffectState = input.sideEffectState ?? record.blocked.sideEffectState;
      const retryAllowed = input.retryAllowed ?? record.blocked.retryAllowed;
      const decision = planBlockedRecovery({ blockedAfter, sideEffectState, retryAllowed });

      if (decision.status === 'queued' && decision.executionMode === 'execute') {
        await this.transition(record, 'queued', 'operation.queued', input.evidenceRefs ?? record.blocked.evidenceRefs, {
          mutate: (draft) => {
            draft.blocked = undefined;
          },
        });
        return {
          kind: 'execute' as const,
          record,
          lease: await this.leaseAndPrepare(record),
        };
      }

      if (decision.status !== 'verifying' || decision.executionMode !== 'verify-only' || decision.requiresExecutor) {
        throw new GatewayError('invalid-state', 'blocked recovery did not produce verify-only execution');
      }
      if (!record.observation) {
        throw new GatewayError(
          'invalid-state',
          'verify-only recovery requires a prior executor observation',
          { operationStatus: record.status },
        );
      }

      await this.transition(record, 'verifying', 'operation.verification_started', [
        ...(input.evidenceRefs ?? record.blocked.evidenceRefs),
        ...record.observation.evidenceRefs,
      ], {
        mutate: (draft) => {
          draft.blocked = undefined;
        },
      });
      const outcome = await this.hand.verifyOnly({
        intent: record.intent,
        registration: record.registration,
        route: record.route,
        ...(record.lease ? { lease: record.lease } : {}),
        observation: record.observation,
        verificationStartedAlready: true,
      });
      return {
        kind: 'snapshot' as const,
        snapshot: await this.applyHandOutcome(record, outcome),
      };
    });

    if (recovery.kind === 'snapshot') return recovery.snapshot;
    if (!recovery.lease) return this.snapshot(recovery.record);
    const outcome = await this.executePrepared(recovery.record, recovery.lease);
    return this.withOperationLock(operationId, async () => {
      const record = this.requireOperation(operationId);
      if (this.shouldIgnoreLateOutcome(record)) {
        return this.snapshot(record);
      }
      return this.applyHandOutcome(record, outcome);
    });
  }

  async requestCancel(operationId: OperationIntent['operationId']): Promise<OperationSnapshot> {
    return this.withOperationLock(operationId, async () => {
      const record = this.requireOperation(operationId);
      await this.transition(
        record,
        'cancel_requested',
        'operation.cancel_requested',
        [this.createEvidence('operation-cancel-requested', record.route.effectiveScope)],
      );
      return this.snapshot(record);
    });
  }

  async settleCancellation(operationId: OperationIntent['operationId']): Promise<OperationSnapshot> {
    return this.withOperationLock(operationId, async () => {
      const record = this.requireOperation(operationId);
      if (record.status !== 'cancel_requested') {
        throw new GatewayError(
          'invalid-state',
          `operation ${operationId.value} cannot settle cancellation from ${record.status}`,
          { operationStatus: record.status },
        );
      }
      if (!this.stopSettlement) {
        throw new GatewayError(
          'invalid-state',
          'cancellation settlement requires a trusted stop settlement port',
          { operationStatus: record.status },
        );
      }

      const receipt = await this.stopSettlement.settle({
        intent: record.intent,
        registration: record.registration,
        route: record.route,
        executionEpoch: record.executionEpoch,
        owner: record.registration.owner,
        ...(record.lease ? { lease: record.lease } : {}),
      });
      this.assertStopSettlementReceipt(record, receipt);
      const settlement = {
        stopped: receipt.stopped,
        sideEffectState: receipt.sideEffectState,
        evidenceRefs: receipt.evidenceRefs,
      };
      const decision = planOperationCancellation(record.status, settlement);
      if (decision.status === 'reconcile_required') {
        await this.transition(record, 'reconcile_required', 'operation.reconcile_required', settlement.evidenceRefs, {
          executionEpoch: record.executionEpoch,
          allowInvalidated: true,
          mutate: (draft) => {
            draft.executionInvalidated = true;
            draft.reconcile = {
              owner: record.registration.owner,
              reason: decision.reason,
              sideEffectState: settlement.sideEffectState,
              nextAction: { kind: 'recover', ref: 'reconcile' },
              evidenceRefs: settlement.evidenceRefs,
            };
            if (draft.lease) draft.lease = { ...draft.lease, state: 'released' };
          },
        });
        return this.snapshot(record);
      }

      if (decision.status === 'failed') {
        const failure = this.failure(
          record,
          'execution',
          'cancellation',
          'executor stop could not be confirmed',
          settlement.evidenceRefs,
          { kind: 'recover', ref: 'reconcile' },
        );
        await this.transition(record, 'failed', 'operation.failed', failure.evidenceRefs, {
          failure,
          executionEpoch: record.executionEpoch,
          allowInvalidated: true,
          mutate: (draft) => {
            draft.executionInvalidated = true;
            draft.failure = failure;
            draft.result = this.failedResult(draft, failure, 'cancellation-failed');
            if (draft.lease) draft.lease = { ...draft.lease, state: 'released' };
          },
        });
        return this.snapshot(record);
      }

      await this.transition(record, 'cancelled', 'operation.cancelled', settlement.evidenceRefs, {
        resultRef: resultRef(record.intent.operationId),
        executionEpoch: record.executionEpoch,
        allowInvalidated: true,
        mutate: (draft) => {
          draft.executionInvalidated = true;
          draft.result = this.cancelledResult(draft, settlement.evidenceRefs);
          if (draft.lease) draft.lease = { ...draft.lease, state: 'released' };
        },
      });
      return this.snapshot(record);
    });
  }

  async resolveReconcile(
    operationId: OperationIntent['operationId'],
    input: ResolveReconcileInput,
  ): Promise<OperationSnapshot> {
    return this.withOperationLock(operationId, async () => {
      const record = this.requireOperation(operationId);
      const decision = planReconcileRequiredResolution(record.status, input.outcome);
      if (decision.status === 'blocked') {
        if (!record.reconcile) {
          throw new GatewayError(
            'invalid-state',
            'reconcile recovery requires recorded reconcile state',
            { operationStatus: record.status },
          );
        }
        const sideEffectState = record.reconcile.sideEffectState;
        await this.transition(record, 'blocked', 'operation.blocked', input.evidenceRefs, {
          executionEpoch: record.executionEpoch,
          allowInvalidated: record.executionInvalidated === true,
          mutate: (draft) => {
            draft.reconcile = undefined;
            draft.blocked = {
              blockedAfter: 'reconcile',
              sideEffectState,
              retryAllowed: false,
              owner: record.registration.owner,
              nextAction: { kind: 'recover', ref: 'verify-only' },
              evidenceRefs: input.evidenceRefs,
            };
          },
        });
        return this.snapshot(record);
      }

      if (decision.status === 'cancelled') {
        await this.transition(record, 'cancelled', 'operation.cancelled', input.evidenceRefs, {
          resultRef: resultRef(record.intent.operationId),
          executionEpoch: record.executionEpoch,
          allowInvalidated: record.executionInvalidated === true,
          mutate: (draft) => {
            draft.result = this.cancelledResult(draft, input.evidenceRefs);
            draft.reconcile = undefined;
            if (draft.lease) draft.lease = { ...draft.lease, state: 'released' };
          },
        });
        return this.snapshot(record);
      }

      const failure = this.failure(
        record,
        'reconcile',
        'integrity',
        input.message ?? 'reconcile could not recover the operation',
        input.evidenceRefs,
        { kind: 'recover', ref: 'reconcile' },
      );
      await this.transition(record, 'failed', 'operation.failed', failure.evidenceRefs, {
        failure,
        executionEpoch: record.executionEpoch,
        allowInvalidated: record.executionInvalidated === true,
        mutate: (draft) => {
          draft.failure = failure;
          draft.result = this.failedResult(draft, failure, 'reconcile-failed');
          draft.reconcile = undefined;
        },
      });
      return this.snapshot(record);
    });
  }

  get(operationId: OperationIntent['operationId']): OperationSnapshot {
    return this.snapshot(this.requireOperation(operationId));
  }

  /**
   * Read complete or unknown operation-control state for one exact scope and
   * hydrate the cache from a complete read. Cold hydration never revives a
   * lease or replays an effect.
   */
  async readControl(input: OperationControlSelector): Promise<OperationControlReadback> {
    const readback = await this.journal.readControl(input);
    if (readback.state === 'complete') this.hydrate(readback.operations);
    return readback;
  }

  /**
   * Initialize durable task coverage at an actual new-task admission. A scope
   * without this fact reads as unknown rather than known-empty.
   */
  async initializeCoverage(input: OperationCoverageInitialization): Promise<JournalCommitRef> {
    if (typeof input.admissionCommitRef.commitId !== 'string'
      || input.admissionCommitRef.commitId.trim().length === 0) {
      throw new GatewayError('invalid-state', 'coverage initialization requires a real admission commit receipt');
    }
    return this.journal.initializeCoverage(input);
  }

  /**
   * Bounded externally driven lifecycle register/update for the existing parent
   * Provider controller. The Gateway commits the event and successor control
   * state atomically, then publishes the cache. It never invokes an executor or
   * model; the controller still owns the actual Provider start/settle call.
   */
  async applyExternalLifecycle(input: ExternalOperationLifecycle): Promise<OperationSnapshot> {
    const { event, control } = input;
    validateOperationEvent(event);
    this.assertControlRecord(event, control);
    const key = operationKey(control.intent.operationId);
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.fingerprintKey !== control.fingerprintKey) {
        throw new GatewayError(
          'idempotency-conflict',
          `external lifecycle conflicts with existing operation ${control.intent.operationId.value}`,
          { operationStatus: existing.status },
        );
      }
      if (control.executionEpoch < existing.executionEpoch) {
        throw new GatewayError(
          'stale-epoch',
          `external lifecycle execution epoch is stale for ${control.intent.operationId.value}`,
          { operationStatus: existing.status },
        );
      }
      if (isTerminalOperationStatus(existing.status) && control.status !== existing.status) {
        throw new GatewayError(
          'invalid-state',
          `external lifecycle cannot change terminal operation ${control.intent.operationId.value}`,
          { operationStatus: existing.status },
        );
      }
    }
    const record = this.fromControlRecord(control);
    await this.commitControl(event, record);
    this.operations.set(key, record);
    this.idempotency.set(control.namespaceKey, {
      namespaceKey: control.namespaceKey,
      fingerprintKey: control.fingerprintKey,
      operationId: key,
    });
    await this.publish(event);
    return this.snapshot(record);
  }

  private assertControlBinding(
    binding: OperationControlBinding,
    intent: OperationIntent,
    childAdmission?: OperationChildAdmission,
  ): void {
    if (typeof binding.agentRuntimeId !== 'string' || binding.agentRuntimeId.trim().length === 0) {
      throw new GatewayError('invalid-state', 'operation control binding requires a non-empty agent runtime id');
    }
    if (!Number.isSafeInteger(binding.harnessExecutionEpoch) || binding.harnessExecutionEpoch < 1) {
      throw new GatewayError(
        'invalid-state',
        'operation control binding requires a positive safe-integer harness execution epoch',
      );
    }
    if (binding.parentOperationId.scope !== 'operation' || binding.parentOperationId.value.trim().length === 0) {
      throw new GatewayError('invalid-state', 'operation control binding requires a real parent operation identity');
    }
    if (typeof binding.admissionCommitRef.commitId !== 'string'
      || binding.admissionCommitRef.commitId.trim().length === 0
      || !Number.isSafeInteger(binding.admissionCommitRef.journalSeq)) {
      throw new GatewayError('invalid-state', 'operation control binding requires an admission commit receipt');
    }
    if (childAdmission === undefined) {
      if (!scopeContains(binding.scope, intent.requestedScope)) {
        throw new GatewayError('scope-denied', 'operation control binding scope does not cover the requested scope');
      }
      return;
    }
    // Explicit child path: the binding names the actual admitted parent and
    // the child owns its own operation identity. The parent operation scope
    // must never be widened to contain the child operation.
    assertCommitRef(childAdmission.authorityCommitRef, 'child admission authority commit ref');
    assertCommitRef(childAdmission.businessRegistrationCommitRef, 'child admission business registration commit ref');
    assertCommitRef(childAdmission.coverageCommitRef, 'child admission coverage commit ref');
    if (intent.requestedScope.operationId === undefined
      || !sameScopedId(intent.requestedScope.operationId, intent.operationId)) {
      throw new GatewayError('scope-denied', 'child intent must name its own operation in the requested scope');
    }
    if (sameScopedId(intent.operationId, binding.parentOperationId)) {
      throw new GatewayError('scope-denied', 'child operation identity must differ from the parent operation identity');
    }
    if (binding.scope.organId === undefined
      || binding.scope.taskId === undefined
      || binding.scope.cycleId === undefined
      || intent.requestedScope.organId === undefined
      || intent.requestedScope.taskId === undefined
      || intent.requestedScope.cycleId === undefined
      || !sameScopedId(binding.scope.organId, intent.requestedScope.organId)
      || !sameScopedId(binding.scope.taskId, intent.requestedScope.taskId)
      || !sameScopedId(binding.scope.cycleId, intent.requestedScope.cycleId)) {
      throw new GatewayError('scope-denied', 'child intent requires an organ, task and cycle scope');
    }
  }

  /**
   * Physical child-admission verification. The Journal physically joins the
   * exact decoded registration, the parent control record and the coverage
   * fact. A missing lookup, unknown join or non-permitting parent denies the
   * child before any IO. The Gateway never trusts a caller-supplied receipt.
   */
  private async verifyChildAdmission(
    binding: OperationControlBinding,
    intent: OperationIntent,
    childAdmission: OperationChildAdmission,
  ): Promise<void> {
    const lookup = this.journal.readChildAdmission;
    if (lookup === undefined) {
      throw new GatewayError(
        'control-unknown',
        'child admission requires a journal that can physically verify the child registration',
      );
    }
    let readback;
    try {
      readback = await lookup.call(this.journal, { binding, intent, admission: childAdmission });
    } catch (error) {
      throw new GatewayError(
        'control-unknown',
        error instanceof Error ? error.message : 'child admission physical lookup failed',
        { cause: error },
      );
    }
    if (readback.state !== 'verified') {
      throw new GatewayError(
        'control-unknown',
        `child admission is not physically verified: ${readback.reason}`,
      );
    }
    if (!sameCommitRef(readback.registrationCommitRef, childAdmission.businessRegistrationCommitRef)
      || !sameCommitRef(readback.coverageCommitRef, childAdmission.coverageCommitRef)) {
      throw new GatewayError(
        'control-unknown',
        'child admission receipts do not match the durable business registration and coverage',
      );
    }
    if (!isPermittingParentStatus(readback.parentControl.status)) {
      throw new GatewayError(
        'permission-denied',
        `parent operation ${binding.parentOperationId.value} does not permit new child effects`,
        { operationStatus: readback.parentControl.status },
      );
    }
  }

  private assertReplayIdentity(
    operation: OperationRecord,
    binding: OperationControlBinding,
    childAdmission?: OperationChildAdmission,
  ): void {
    if (!sameControlBinding(operation.binding, binding)) {
      throw new GatewayError(
        'idempotency-conflict',
        `operation ${operation.intent.operationId.value} is already bound to a different parent control binding`,
        { operationStatus: operation.status },
      );
    }
    if (!sameChildAdmission(operation.childAdmission, childAdmission)) {
      throw new GatewayError(
        'idempotency-conflict',
        `operation ${operation.intent.operationId.value} is already bound to a different child admission provenance`,
        { operationStatus: operation.status },
      );
    }
  }

  private assertControlRecord(event: OperationEvent, control: OperationControlRecord): void {
    if (event.operationId.scope !== control.intent.operationId.scope
      || event.operationId.value !== control.intent.operationId.value) {
      throw new GatewayError('invalid-state', 'external control event operation does not match its control record');
    }
    if (event.taskId.scope !== control.intent.taskId.scope
      || event.taskId.value !== control.intent.taskId.value) {
      throw new GatewayError('invalid-state', 'external control event task does not match its control record');
    }
    if (event.status !== control.status) {
      throw new GatewayError('invalid-state', 'external control event status does not match its control record');
    }
    if (event.executionEpoch !== control.executionEpoch) {
      throw new GatewayError('invalid-state', 'external control event execution epoch does not match its control record');
    }
    this.assertControlBinding(control.binding, control.intent, control.childAdmission);
  }

  private async acceptNew(
    intent: OperationIntent,
    binding: OperationControlBinding,
    resolved: ResolvedToolRegistration,
    namespaceKey: string,
    fingerprintKey: string,
    childAdmission?: OperationChildAdmission,
  ): Promise<OperationRecord> {
    const operationKeyValue = operationKey(intent.operationId);
    if (this.operations.has(operationKeyValue)) {
      throw new GatewayError(
        'idempotency-conflict',
        `operation id already exists: ${intent.operationId.value}`,
        { ownerRef: resolved.registration.owner },
      );
    }

    const grant = await this.permissions.readGrant({ intent, registration: resolved.registration });
    if (!grant || grant.revoked) {
      throw this.rejection(
        intent,
        resolved.registration,
        'admission',
        'permission',
        grant?.revoked ? 'permission grant has been revoked' : 'permission grant is missing',
        grant?.evidenceRefs ?? [],
        { kind: 'recover', ref: 'grant-permission' },
      );
    }
    const boundary = await this.taskBoundaries.readBoundary({ intent, registration: resolved.registration });
    if (!boundary) {
      throw this.rejection(
        intent,
        resolved.registration,
        'admission',
        'permission',
        'task resource boundary is missing',
        grant.evidenceRefs,
        { kind: 'recover', ref: 'bind-task-boundary' },
      );
    }
    if (!scopeContains(grant.scope, intent.requestedScope)
      || !scopeContains(resolved.registrationLimit, intent.requestedScope)
      || !scopeContains(boundary.scope, intent.requestedScope)) {
      throw this.rejection(
        intent,
        resolved.registration,
        'admission',
        'permission',
        'operation requested scope exceeds permission, registration, or task boundary',
        [...grant.evidenceRefs, ...boundary.evidenceRefs],
        { kind: 'recover', ref: 'narrow-operation-scope' },
      );
    }

    let effectiveScope: Scope;
    try {
      effectiveScope = effectiveOperationScope(
        intent.requestedScope,
        grant.scope,
        resolved.registrationLimit,
        boundary.scope,
      );
    } catch (error) {
      throw this.rejection(
        intent,
        resolved.registration,
        'admission',
        'permission',
        error instanceof Error ? error.message : 'effective scope intersection is empty',
        [...grant.evidenceRefs, ...boundary.evidenceRefs],
        { kind: 'recover', ref: 'narrow-operation-scope' },
      );
    }

    const route: RouteSelection = {
      operationId: intent.operationId,
      routeId: resolved.registration.routeId,
      routeVersion: resolved.registration.routeVersion,
      mode: resolved.registration.mode,
      contractVersion: resolved.registration.contractVersion,
      effectiveScope,
      selectionReason: 'registered tool matched kind, permission grant, and task resource boundary',
      selectedAt: this.now().toISOString(),
    };
    validateRouteSelection(route, resolved.registration);

    const record: OperationRecord = {
      binding,
      childAdmission,
      intent,
      registration: resolved.registration,
      route,
      namespaceKey,
      fingerprintKey,
      status: 'accepted',
      executionEpoch: 1,
    };
    // Commit the exact accepted control state first, then publish the cache and
    // idempotency lookup. A failed commit must not expose a fabricated record.
    const event = this.buildEvent({
      kind: 'operation.accepted',
      operationId: intent.operationId,
      taskId: intent.taskId,
      executionEpoch: record.executionEpoch,
      status: 'accepted',
      evidenceRefs: [...grant.evidenceRefs, ...boundary.evidenceRefs],
    });
    await this.commitControl(event, record);
    this.operations.set(operationKeyValue, record);
    this.idempotency.set(namespaceKey, {
      namespaceKey,
      fingerprintKey,
      operationId: operationKeyValue,
    });
    await this.publish(event);
    return record;
  }

  private replayOrConflict(
    existing: { readonly namespaceKey: string; readonly fingerprintKey: string; readonly operationId: string },
    fingerprintKey: string,
    binding: OperationControlBinding,
    childAdmission?: OperationChildAdmission,
  ): OperationSubmissionResult {
    if (existing.fingerprintKey !== fingerprintKey) {
      const operation = this.operations.get(existing.operationId);
      throw new GatewayError(
        'idempotency-conflict',
        'idempotency key is already bound to a different semantic fingerprint',
        {
          ownerRef: operation?.registration.owner ?? 'runtime-gateway',
          ...(operation ? { operationStatus: operation.status } : {}),
        },
      );
    }
    const operation = this.operations.get(existing.operationId);
    if (!operation) {
      throw new GatewayError('invalid-state', 'idempotency record points to a missing operation');
    }
    this.assertReplayIdentity(operation, binding, childAdmission);
    return { decision: 'replay', operation: this.snapshot(operation) };
  }

  private async leaseAndPrepare(record: OperationRecord): Promise<OperationLease | undefined> {
    const grant = await this.permissions.readGrant({
      intent: record.intent,
      registration: record.registration,
    });
    const boundary = await this.taskBoundaries.readBoundary({
      intent: record.intent,
      registration: record.registration,
    });
    const grantDenied = !grant || grant.revoked || !scopeContains(grant.scope, record.route.effectiveScope);
    const boundaryDenied = !boundary || !scopeContains(boundary.scope, record.route.effectiveScope);
    if (grantDenied || boundaryDenied) {
      const message = grantDenied
        ? grant?.revoked
          ? 'permission was revoked before lease'
          : 'permission no longer covers effective scope'
        : 'task resource boundary no longer covers effective scope';
      const evidenceRefs = [
        ...(grant?.evidenceRefs ?? []),
        ...(boundary?.evidenceRefs ?? []),
      ];
      const failure = this.failure(
        record,
        'admission',
        'permission',
        message,
        evidenceRefs,
        { kind: 'recover', ref: grantDenied ? 'grant-permission' : 'bind-task-boundary' },
      );
      await this.transition(record, 'failed', 'operation.failed', failure.evidenceRefs, {
        failure,
        mutate: (draft) => {
          draft.failure = failure;
          draft.result = this.failedResult(draft, failure, 'permission-denied');
        },
      });
      return undefined;
    }

    const lease = this.issueLease(record);
    const grantEvidenceRefs = grant.evidenceRefs.length > 0
      ? grant.evidenceRefs
      : [this.createEvidence('permission-recheck', record.route.effectiveScope)];
    await this.transition(
      record,
      'leased',
      'operation.leased',
      [...grantEvidenceRefs, this.createEvidence('operation-leased', lease.effectiveScope)],
      {
        executionEpoch: lease.executionEpoch,
        mutate: (draft) => {
          draft.lease = lease;
          draft.executionEpoch = lease.executionEpoch;
        },
      },
    );
    await this.transition(record, 'running', 'operation.started', [this.createEvidence('operation-started', lease.effectiveScope)]);
    return lease;
  }

  private async executePrepared(
    record: OperationRecord,
    lease: OperationLease,
  ): Promise<Awaited<ReturnType<HandRuntime['execute']>>> {
    return this.hand.execute({
      intent: record.intent,
      registration: record.registration,
      route: record.route,
      lease,
    });
  }

  private issueLease(record: OperationRecord): OperationLease {
    const executionEpoch = record.lease ? record.executionEpoch + 1 : record.executionEpoch;
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.leaseDurationMs);
    const lease: OperationLease = {
      leaseId: `runtime-gateway-lease-${randomUUID()}`,
      operationId: record.intent.operationId,
      taskId: record.intent.taskId,
      executionEpoch,
      routeId: record.registration.routeId,
      routeVersion: record.registration.routeVersion,
      effectiveScope: record.route.effectiveScope,
      state: 'active',
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    return lease;
  }

  private async applyHandOutcome(
    record: OperationRecord,
    _outcome: Awaited<ReturnType<HandRuntime['execute']>>,
  ): Promise<OperationSnapshot> {
    // The Hand terminal emit already committed the exact successor control
    // state (including lease release and settlement). Nothing is applied here
    // after the durable commit.
    return this.snapshot(record);
  }

  private shouldIgnoreLateOutcome(record: OperationRecord): boolean {
    if (record.status === 'cancel_requested' || record.status === 'cancelled') return true;
    if (record.status === 'failed') return record.result !== undefined;
    if (record.status === 'blocked') return record.blocked !== undefined;
    if (record.status === 'reconcile_required') return record.reconcile !== undefined;
    return false;
  }

  private async transition(
    record: OperationRecord,
    to: OperationStatus,
    kind: OperationEvent['kind'],
    evidenceRefs: readonly EvidenceRef[],
    options: {
      readonly resultRef?: string;
      readonly failure?: OperationFailure;
      readonly executionEpoch?: number;
      readonly allowInvalidated?: boolean;
      readonly mutate?: (draft: OperationRecord) => void;
    } = {},
  ): Promise<void> {
    assertTransitionOperationStatus(record.status, to);
    const event = this.buildEvent({
      kind,
      operationId: record.intent.operationId,
      taskId: record.intent.taskId,
      executionEpoch: options.executionEpoch ?? record.executionEpoch,
      status: to,
      evidenceRefs,
      ...(options.resultRef ? { resultRef: options.resultRef } : {}),
      ...(options.failure ? { failure: options.failure } : {}),
    });
    const successor = cloneRecord(record);
    successor.status = to;
    if (options.executionEpoch !== undefined) successor.executionEpoch = options.executionEpoch;
    if (options.failure) successor.failure = options.failure;
    options.mutate?.(successor);
    await this.commitSuccessor(event, record, successor, options.allowInvalidated === true);
  }

  /**
   * Hand terminal-outcome emit. The Hand emitter passes the exact settlement
   * so the successor control state is committed atomically with its event.
   */
  private async emit(
    input: Omit<OperationEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
    settlement?: HandEmitSettlement,
    allowInvalidated = false,
  ): Promise<void> {
    const event = this.buildEvent(input);
    const current = this.operations.get(operationKey(event.operationId));
    if (!current) {
      throw new GatewayError(
        'invalid-state',
        `cannot commit control for an unadmitted operation: ${event.operationId.value}`,
        { operationStatus: event.status },
      );
    }
    const successor = cloneRecord(current);
    successor.status = event.status;
    if (event.failure) successor.failure = event.failure;
    if (settlement) this.applySettlement(successor, settlement);
    await this.commitSuccessor(event, current, successor, allowInvalidated);
  }

  private buildEvent(
    input: Omit<OperationEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
  ): OperationEvent {
    const event: OperationEvent = {
      eventId: `runtime-gateway-event-${randomUUID()}`,
      schemaVersion: 1,
      occurredAt: this.now().toISOString(),
      ...input,
    };
    validateOperationEvent(event);
    return event;
  }

  /**
   * Commit the successor control state and only then publish it to the cache
   * and notifications. Cancellation fencing and execution invalidation are
   * enforced before the commit so a fenced late outcome is never durable.
   */
  private async commitSuccessor(
    event: OperationEvent,
    record: OperationRecord,
    successor: OperationRecord,
    allowInvalidated: boolean,
  ): Promise<void> {
    if (record.executionInvalidated && !allowInvalidated) return;
    const settlingCancellation = record.status === 'cancel_requested'
      && (event.status === 'cancelled' || event.status === 'reconcile_required' || event.status === 'failed');
    if ((record.status === 'cancel_requested' || record.status === 'cancelled')
      && event.status !== record.status && !settlingCancellation) {
      return;
    }
    await this.commitControl(event, successor);
    Object.assign(record, successor);
    await this.publish(event);
  }

  private async commitControl(
    event: OperationEvent,
    successor: OperationRecord,
  ): Promise<JournalCommitRef> {
    return this.journal.commit(event, this.toControlRecord(successor));
  }

  private async publish(event: OperationEvent): Promise<void> {
    if (!this.journal.publishCommitted) return;
    try {
      await this.journal.publishCommitted(event);
    } catch (error) {
      const key = operationKey(event.operationId);
      if (!this.notificationFailures.has(key)) {
        this.notificationFailures.set(key, new OperationNotificationError(event, error));
      }
    }
  }

  private applySettlement(successor: OperationRecord, settlement: HandEmitSettlement): void {
    if (settlement.observation) successor.observation = settlement.observation;
    if (settlement.result) successor.result = settlement.result;
    if (settlement.failure) successor.failure = settlement.failure;
    if (settlement.blocked) successor.blocked = settlement.blocked;
    if (settlement.reconcile) successor.reconcile = settlement.reconcile;
    if (successor.lease) successor.lease = { ...successor.lease, state: 'released' };
  }

  private toControlRecord(record: OperationRecord): OperationControlRecord {
    return {
      binding: record.binding,
      ...(record.childAdmission ? { childAdmission: record.childAdmission } : {}),
      intent: record.intent,
      registration: record.registration,
      route: record.route,
      status: record.status,
      executionEpoch: record.executionEpoch,
      namespaceKey: record.namespaceKey,
      fingerprintKey: record.fingerprintKey,
      ...(record.lease ? { lease: record.lease } : {}),
      ...(record.observation ? { observation: record.observation } : {}),
      ...(record.result ? { result: record.result } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
      ...(record.blocked ? { blocked: record.blocked } : {}),
      ...(record.reconcile ? { reconcile: record.reconcile } : {}),
      ...(record.executionInvalidated ? { executionInvalidated: true } : {}),
    };
  }

  private fromControlRecord(control: OperationControlRecord): OperationRecord {
    return {
      binding: control.binding,
      childAdmission: control.childAdmission,
      intent: control.intent,
      registration: control.registration,
      route: control.route,
      namespaceKey: control.namespaceKey,
      fingerprintKey: control.fingerprintKey,
      status: control.status,
      executionEpoch: control.executionEpoch,
      lease: control.lease,
      observation: control.observation,
      result: control.result,
      failure: control.failure,
      blocked: control.blocked,
      reconcile: control.reconcile,
      executionInvalidated: control.executionInvalidated,
    };
  }

  /**
   * Hydrate the in-memory cache from committed control records. It never
   * revives a lease, replays an effect, or drops a blocked/reconcile
   * obligation; it only replaces cache entries with the committed state.
   */
  private hydrate(records: readonly OperationControlRecord[]): void {
    for (const control of records) {
      const key = operationKey(control.intent.operationId);
      this.operations.set(key, this.fromControlRecord(control));
      this.idempotency.set(control.namespaceKey, {
        namespaceKey: control.namespaceKey,
        fingerprintKey: control.fingerprintKey,
        operationId: key,
      });
    }
  }

  private async withOperationLock<T>(
    operationId: OperationIntent['operationId'],
    action: () => Promise<T>,
  ): Promise<T> {
    const key = operationKey(operationId);
    const previous = this.operationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.operationLocks.set(key, queued);
    await previous;
    let result: T;
    try {
      result = await action();
    } finally {
      release();
      if (this.operationLocks.get(key) === queued) this.operationLocks.delete(key);
    }
    this.throwPendingNotificationFailure(operationId);
    return result;
  }

  private throwPendingNotificationFailure(operationId: OperationIntent['operationId']): void {
    const key = operationKey(operationId);
    const failure = this.notificationFailures.get(key);
    if (!failure) return;
    this.notificationFailures.delete(key);
    throw failure;
  }

  private assertStopSettlementReceipt(
    record: OperationRecord,
    receipt: OperationStopSettlementReceipt,
  ): void {
    if (typeof receipt.receiptId !== 'string' || receipt.receiptId.trim().length === 0) {
      throw new GatewayError('invalid-state', 'stop settlement receipt id is required', {
        operationStatus: record.status,
      });
    }
    try {
      assertScope(receipt.operationId, 'operation');
      assertScope(receipt.taskId, 'task');
    } catch (error) {
      throw new GatewayError(
        'invalid-state',
        error instanceof Error ? error.message : 'stop settlement receipt identity is invalid',
        { operationStatus: record.status, cause: error },
      );
    }
    if (receipt.operationId.scope !== record.intent.operationId.scope
      || receipt.operationId.value !== record.intent.operationId.value) {
      throw new GatewayError('invalid-state', 'stop settlement receipt operation does not match', {
        operationStatus: record.status,
      });
    }
    if (receipt.taskId.scope !== record.intent.taskId.scope
      || receipt.taskId.value !== record.intent.taskId.value) {
      throw new GatewayError('invalid-state', 'stop settlement receipt task does not match', {
        operationStatus: record.status,
      });
    }
    if (!Number.isSafeInteger(receipt.executionEpoch) || receipt.executionEpoch < 1) {
      throw new GatewayError('invalid-state', 'stop settlement receipt execution epoch is invalid', {
        operationStatus: record.status,
      });
    }
    if (receipt.executionEpoch !== record.executionEpoch) {
      throw new GatewayError('stale-epoch', 'stop settlement receipt execution epoch is stale', {
        operationStatus: record.status,
      });
    }
    if (typeof receipt.owner !== 'string' || receipt.owner !== record.registration.owner) {
      throw new GatewayError('invalid-state', 'stop settlement receipt owner does not match', {
        operationStatus: record.status,
      });
    }
    if (record.lease && receipt.leaseId !== record.lease.leaseId) {
      throw new GatewayError('invalid-state', 'stop settlement receipt lease does not match', {
        operationStatus: record.status,
      });
    }
    if (typeof receipt.stopped !== 'boolean'
      || !['none', 'possible', 'confirmed'].includes(receipt.sideEffectState)) {
      throw new GatewayError('invalid-state', 'stop settlement receipt outcome is invalid', {
        operationStatus: record.status,
      });
    }
    if (!Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length === 0) {
      throw new GatewayError('invalid-state', 'stop settlement receipt requires evidence', {
        operationStatus: record.status,
      });
    }
    for (const evidenceRef of receipt.evidenceRefs) {
      try {
        assertEvidenceRef(evidenceRef);
      } catch (error) {
        throw new GatewayError(
          'invalid-state',
          error instanceof Error ? error.message : 'stop settlement receipt evidence is invalid',
          { operationStatus: record.status, cause: error },
        );
      }
      if (!scopeContains(record.route.effectiveScope, evidenceRef.scope)) {
        throw new GatewayError(
          'invalid-state',
          'stop settlement receipt evidence exceeds operation scope',
          { operationStatus: record.status, evidenceRefs: receipt.evidenceRefs },
        );
      }
    }
  }

  private createEvidence(label: string, scope: Scope): EvidenceRef {
    return {
      evidenceId: {
        scope: 'evidence',
        value: `runtime-gateway-evidence-${randomUUID()}`,
      },
      kind: 'operation',
      source: 'runtime-gateway',
      locator: label,
      scope,
    };
  }

  private rejection(
    intent: OperationIntent,
    registration: ToolRegistration,
    phase: OperationFailure['phase'],
    failureClass: OperationFailure['failureClass'],
    message: string,
    evidenceRefs: readonly EvidenceRef[],
    nextAction: OperationFailure['nextAction'],
  ): GatewayError {
    const failure = this.failureFor(
      intent,
      registration,
      phase,
      failureClass,
      message,
      evidenceRefs,
      nextAction,
    );
    return new GatewayError(
      failureClass === 'permission' ? 'permission-denied' : 'route-not-found',
      message,
      {
        ownerRef: registration.owner,
        failure,
        evidenceRefs: failure.evidenceRefs,
      },
    );
  }

  private failure(
    record: OperationRecord,
    phase: OperationFailure['phase'],
    failureClass: OperationFailure['failureClass'],
    message: string,
    evidenceRefs: readonly EvidenceRef[],
    nextAction: OperationFailure['nextAction'],
  ): OperationFailure {
    return this.failureFor(
      record.intent,
      record.registration,
      phase,
      failureClass,
      message,
      evidenceRefs,
      nextAction,
    );
  }

  private failureFor(
    intent: OperationIntent,
    registration: ToolRegistration,
    phase: OperationFailure['phase'],
    failureClass: OperationFailure['failureClass'],
    message: string,
    evidenceRefs: readonly EvidenceRef[],
    nextAction: OperationFailure['nextAction'],
  ): OperationFailure {
    const failure: OperationFailure = {
      errorId: `runtime-gateway-error-${randomUUID()}`,
      operationId: intent.operationId,
      owner: registration.owner,
      phase,
      failureClass,
      message,
      observedAt: this.now().toISOString(),
      impact: 'operation cannot advance to a trusted terminal result',
      protectiveAction: 'preserve operation identity and evidence for explicit recovery',
      nextAction,
      evidenceRefs: evidenceRefs.length > 0
        ? evidenceRefs
        : [this.createEvidence('operation-rejected', intent.requestedScope)],
    };
    validateOperationFailure(failure);
    return failure;
  }

  private failedResult(
    record: OperationRecord,
    failure: OperationFailure,
    verifierDecision: string,
  ): OperationResult {
    const result: OperationResult = {
      operationId: record.intent.operationId,
      status: 'failed',
      evidenceRefs: failure.evidenceRefs,
      verifier: {
        name: record.registration.verifier,
        version: record.registration.routeVersion,
        decision: verifierDecision,
      },
      failure,
      completedAt: this.now().toISOString(),
    };
    validateOperationResult(result);
    return result;
  }

  private cancelledResult(record: OperationRecord, evidenceRefs: readonly EvidenceRef[]): OperationResult {
    const result: OperationResult = {
      operationId: record.intent.operationId,
      status: 'cancelled',
      evidenceRefs,
      verifier: {
        name: record.registration.verifier,
        version: record.registration.routeVersion,
        decision: 'cancelled',
      },
      completedAt: this.now().toISOString(),
    };
    validateOperationResult(result);
    return result;
  }

  private requireOperation(operationId: OperationIntent['operationId']): OperationRecord {
    const record = this.operations.get(operationKey(operationId));
    if (!record) {
      throw new GatewayError(
        'invalid-state',
        `operation not found: ${operationId.value}`,
        { ownerRef: 'runtime-gateway' },
      );
    }
    return record;
  }

  private snapshot(record: OperationRecord): OperationSnapshot {
    return {
      operationId: record.intent.operationId,
      taskId: record.intent.taskId,
      status: record.status,
      executionEpoch: record.executionEpoch,
      route: record.route,
      ...(record.lease ? { lease: record.lease } : {}),
      ...(record.observation ? { observation: record.observation } : {}),
      ...(record.result ? { result: record.result } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
      ...(record.blocked ? { blocked: record.blocked } : {}),
      ...(record.reconcile ? { reconcile: record.reconcile } : {}),
    };
  }
}
