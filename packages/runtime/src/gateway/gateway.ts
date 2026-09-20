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
  type OperationIntent,
  type OperationLease,
  type OperationResult,
  type OperationStatus,
  type RouteSelection,
  type Scope,
  type ToolRegistration,
} from '../../../contracts/src/index.js';
import {
  assertTransitionOperationStatus,
  planBlockedRecovery,
  planOperationCancellation,
  planReconcileRequiredResolution,
} from '../../../core/src/index.js';
import { GatewayError, OperationNotificationError } from './errors.js';
import { HandRuntime } from './hand-runtime.js';
import type {
  OperationBlockedState,
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
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  status: OperationStatus;
  executionEpoch: number;
  lease?: OperationLease;
  observation?: OperationExecutorObservation;
  result?: OperationResult;
  failure?: OperationFailure;
  blocked?: OperationBlockedState;
  reconcile?: OperationReconcileState;
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
      emit: (event) => this.emit(event),
      createEvidence: (label, scope) => this.createEvidence(label, scope),
      now: this.now,
    });
  }

  async submit(intent: OperationIntent): Promise<OperationSubmissionResult> {
    validateOperationIntent(intent);
    const resolved = this.registry.resolve(intent);
    const namespaceKey = operationIdempotencyKey(intent);
    const fingerprintKey = operationSemanticFingerprintKey(
      operationSemanticFingerprint(intent, resolved.registration),
    );

    const existing = this.idempotency.get(namespaceKey);
    if (existing) {
      return this.replayOrConflict(existing, fingerprintKey);
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
      this.throwPendingNotificationFailure(intent.operationId);
      return { decision: 'replay', operation: this.snapshot(operation) };
    }

    const promise = this.acceptNew(intent, resolved, namespaceKey, fingerprintKey);
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
      if (record.status === 'cancel_requested' || record.status === 'cancelled') {
        return this.snapshot(record);
      }
      return this.applyHandOutcome(record, outcome);
    });
  }

  async resume(operationId: OperationIntent['operationId'], input: ResumeOperationInput = {}): Promise<OperationSnapshot> {
    return this.withOperationLock(operationId, async () => {
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
        await this.transition(record, 'queued', 'operation.queued', input.evidenceRefs ?? record.blocked.evidenceRefs);
        record.blocked = undefined;
        return this.leaseAndExecute(record);
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
      ]);
      const outcome = await this.hand.verifyOnly({
        intent: record.intent,
        registration: record.registration,
        route: record.route,
        ...(record.lease ? { lease: record.lease } : {}),
        observation: record.observation,
        verificationStartedAlready: true,
      });
      record.blocked = undefined;
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
        await this.transition(record, 'reconcile_required', 'operation.reconcile_required', settlement.evidenceRefs);
        record.reconcile = {
          owner: record.registration.owner,
          reason: decision.reason,
          sideEffectState: settlement.sideEffectState,
          nextAction: { kind: 'recover', ref: 'reconcile' },
          evidenceRefs: settlement.evidenceRefs,
        };
        record.lease = record.lease ? { ...record.lease, state: 'released' } : undefined;
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
        await this.transition(record, 'failed', 'operation.failed', failure.evidenceRefs, undefined, failure);
        record.failure = failure;
        record.result = this.failedResult(record, failure, 'cancellation-failed');
        record.lease = record.lease ? { ...record.lease, state: 'released' } : undefined;
        return this.snapshot(record);
      }

      await this.transition(record, 'cancelled', 'operation.cancelled', settlement.evidenceRefs, resultRef(record.intent.operationId));
      record.result = this.cancelledResult(record, settlement.evidenceRefs);
      record.lease = record.lease ? { ...record.lease, state: 'released' } : undefined;
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
        await this.transition(record, 'blocked', 'operation.blocked', input.evidenceRefs);
        record.reconcile = undefined;
        record.blocked = {
          blockedAfter: 'reconcile',
          sideEffectState,
          retryAllowed: false,
          owner: record.registration.owner,
          nextAction: { kind: 'recover', ref: 'verify-only' },
          evidenceRefs: input.evidenceRefs,
        };
        return this.snapshot(record);
      }

      if (decision.status === 'cancelled') {
        await this.transition(record, 'cancelled', 'operation.cancelled', input.evidenceRefs, resultRef(record.intent.operationId));
        record.result = this.cancelledResult(record, input.evidenceRefs);
        record.reconcile = undefined;
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
      await this.transition(record, 'failed', 'operation.failed', failure.evidenceRefs, undefined, failure);
      record.failure = failure;
      record.result = this.failedResult(record, failure, 'reconcile-failed');
      record.reconcile = undefined;
      return this.snapshot(record);
    });
  }

  get(operationId: OperationIntent['operationId']): OperationSnapshot {
    return this.snapshot(this.requireOperation(operationId));
  }

  private async acceptNew(
    intent: OperationIntent,
    resolved: ResolvedToolRegistration,
    namespaceKey: string,
    fingerprintKey: string,
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
      intent,
      registration: resolved.registration,
      route,
      status: 'accepted',
      executionEpoch: 1,
    };
    await this.emit(
      {
        kind: 'operation.accepted',
        operationId: intent.operationId,
        taskId: intent.taskId,
        executionEpoch: record.executionEpoch,
        status: 'accepted',
        evidenceRefs: [...grant.evidenceRefs, ...boundary.evidenceRefs],
      },
      () => {
        this.operations.set(operationKeyValue, record);
        this.idempotency.set(namespaceKey, {
          namespaceKey,
          fingerprintKey,
          operationId: operationKeyValue,
        });
      },
    );
    return record;
  }

  private replayOrConflict(
    existing: { readonly namespaceKey: string; readonly fingerprintKey: string; readonly operationId: string },
    fingerprintKey: string,
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
    return { decision: 'replay', operation: this.snapshot(operation) };
  }

  private async leaseAndExecute(record: OperationRecord): Promise<OperationSnapshot> {
    const lease = await this.leaseAndPrepare(record);
    if (!lease) return this.snapshot(record);
    const outcome = await this.executePrepared(record, lease);
    return this.applyHandOutcome(record, outcome);
  }

  private async leaseAndPrepare(record: OperationRecord): Promise<OperationLease | undefined> {
    const grant = await this.permissions.readGrant({
      intent: record.intent,
      registration: record.registration,
    });
    if (!grant || grant.revoked || !scopeContains(grant.scope, record.route.effectiveScope)) {
      const failure = this.failure(
        record,
        'admission',
        'permission',
        grant?.revoked ? 'permission was revoked before lease' : 'permission no longer covers effective scope',
        grant?.evidenceRefs ?? [],
        { kind: 'recover', ref: 'grant-permission' },
      );
      await this.transition(record, 'failed', 'operation.failed', failure.evidenceRefs, undefined, failure);
      record.failure = failure;
      record.result = this.failedResult(record, failure, 'permission-denied');
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
      undefined,
      undefined,
      lease.executionEpoch,
      () => {
        record.lease = lease;
        record.executionEpoch = lease.executionEpoch;
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
    outcome: Awaited<ReturnType<HandRuntime['execute']>>,
  ): Promise<OperationSnapshot> {
    record.lease = record.lease ? { ...record.lease, state: 'released' } : undefined;
    if (outcome.observation) record.observation = outcome.observation;
    if (outcome.result) record.result = outcome.result;
    if (outcome.failure) record.failure = outcome.failure;
    if (outcome.blocked) record.blocked = outcome.blocked;
    if (outcome.reconcile) record.reconcile = outcome.reconcile;
    return this.snapshot(record);
  }

  private async transition(
    record: OperationRecord,
    to: OperationStatus,
    kind: OperationEvent['kind'],
    evidenceRefs: readonly EvidenceRef[],
    result?: string,
    failure?: OperationFailure,
    executionEpoch = record.executionEpoch,
    afterCommit?: () => void,
  ): Promise<void> {
    assertTransitionOperationStatus(record.status, to);
    await this.emit({
      kind,
      operationId: record.intent.operationId,
      taskId: record.intent.taskId,
      executionEpoch,
      status: to,
      evidenceRefs,
      ...(result ? { resultRef: result } : {}),
      ...(failure ? { failure } : {}),
    }, afterCommit);
  }

  private async emit(
    input: Omit<OperationEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
    afterCommit?: () => void,
  ): Promise<void> {
    const event: OperationEvent = {
      eventId: `runtime-gateway-event-${randomUUID()}`,
      schemaVersion: 1,
      occurredAt: this.now().toISOString(),
      ...input,
    };
    validateOperationEvent(event);
    const current = this.operations.get(operationKey(event.operationId));
    const settlingCancellation = current?.status === 'cancel_requested'
      && ['cancelled', 'reconcile_required', 'failed'].includes(event.status);
    if (current && (current.status === 'cancel_requested' || current.status === 'cancelled')
      && event.status !== current.status && !settlingCancellation) {
      return;
    }
    await this.journal.commit(event);
    afterCommit?.();
    const record = this.operations.get(operationKey(event.operationId));
    if (record) {
      record.status = event.status;
      if (event.failure) record.failure = event.failure;
    }
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
