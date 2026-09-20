import { randomUUID } from 'node:crypto';
import {
  assertEvidenceRef,
  validateOperationFailure,
  validateOperationResult,
  type EvidenceRef,
  type NextAction,
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
import { scopeContains } from '../../../contracts/src/index.js';
import {
  assertExecutionEventFence,
  assertTransitionOperationStatus,
} from '../../../core/src/index.js';
import { GatewayError } from './errors.js';
import type {
  OperationBlockedState,
  OperationExecutorObservation,
  OperationExecutorPort,
  OperationReconcileState,
  OperationVerifierPort,
} from './ports.js';

export type EmitOperationEvent = (
  event: Omit<OperationEvent, 'eventId' | 'schemaVersion' | 'occurredAt'>,
) => Promise<void>;

export type CreateOperationEvidence = (label: string, scope: Scope) => EvidenceRef;

export interface HandRuntimeDependencies {
  readonly executor: OperationExecutorPort;
  readonly verifier: OperationVerifierPort;
  readonly emit: EmitOperationEvent;
  readonly createEvidence: CreateOperationEvidence;
  readonly now: () => Date;
}

export interface ExecuteHandInput {
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  readonly lease: OperationLease;
}

export interface VerifyOnlyHandInput {
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  readonly lease?: OperationLease;
  readonly observation: OperationExecutorObservation;
  readonly verificationStartedAlready?: boolean;
}

export interface HandRunResult {
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'reconcile_required';
  readonly observation?: OperationExecutorObservation;
  readonly result?: OperationResult;
  readonly failure?: OperationFailure;
  readonly blocked?: OperationBlockedState;
  readonly reconcile?: OperationReconcileState;
}

interface FailureInput {
  readonly intent: OperationIntent;
  readonly registration: ToolRegistration;
  readonly route: RouteSelection;
  readonly phase: OperationFailure['phase'];
  readonly failureClass: OperationFailure['failureClass'];
  readonly message: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly nextAction: NextAction;
  readonly recoveryCondition?: string;
}

export class HandRuntime {
  constructor(private readonly dependencies: HandRuntimeDependencies) {}

  async execute(input: ExecuteHandInput): Promise<HandRunResult> {
    assertTransitionOperationStatus('leased', 'running');

    let observation: OperationExecutorObservation;
    try {
      observation = await this.dependencies.executor.execute(input);
    } catch (error) {
      return await this.failExecution(input, error);
    }

    try {
      this.assertEpoch(input.intent, input.lease.executionEpoch, observation.executionEpoch, 'running');
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== 'stale-epoch') throw error;
      return this.blockStale(input, 'execution', observation, error);
    }

    if (observation.status === 'blocked') {
      assertTransitionOperationStatus('running', 'settling');
      assertTransitionOperationStatus('settling', 'blocked');
      const blocked: OperationBlockedState = {
        blockedAfter: 'execution',
        sideEffectState: observation.sideEffectState,
        retryAllowed: false,
        owner: observation.owner,
        nextAction: observation.nextAction ?? { kind: 'recover', ref: 'verify-or-retry' },
        ...(observation.conditionRef ? { conditionRef: observation.conditionRef } : {}),
        evidenceRefs: this.ensureEvidence(observation.evidenceRefs, 'execution-blocked', input.route.effectiveScope),
      };
      await this.emitStatus(input, 'operation.blocked', 'blocked', blocked.evidenceRefs);
      return { status: 'blocked', observation, blocked };
    }

    if (observation.status === 'reconcile_required') {
      assertTransitionOperationStatus('running', 'settling');
      assertTransitionOperationStatus('settling', 'reconcile_required');
      const reconcile: OperationReconcileState = {
        owner: observation.owner,
        reason: observation.message ?? 'executor outcome requires reconcile',
        sideEffectState: observation.sideEffectState,
        nextAction: observation.nextAction ?? { kind: 'recover', ref: 'reconcile' },
        evidenceRefs: this.ensureEvidence(observation.evidenceRefs, 'execution-reconcile', input.route.effectiveScope),
      };
      await this.emitStatus(input, 'operation.reconcile_required', 'reconcile_required', reconcile.evidenceRefs);
      return { status: 'reconcile_required', observation, reconcile };
    }

    if ((observation.outputRef === undefined) !== (observation.outputDigest === undefined)) {
      return await this.failExecution(
        input,
        new Error('executor outputRef and outputDigest must be provided together'),
        observation,
        'integrity',
      );
    }

    assertTransitionOperationStatus('running', 'settling');
    return this.verify({
      intent: input.intent,
      registration: input.registration,
      route: input.route,
      lease: input.lease,
      observation,
    });
  }

  async verifyOnly(input: VerifyOnlyHandInput): Promise<HandRunResult> {
    return this.verify(input);
  }

  private async verify(input: VerifyOnlyHandInput): Promise<HandRunResult> {
    assertTransitionOperationStatus('settling', 'verifying');
    if (!input.verificationStartedAlready) {
      await this.dependencies.emit({
        kind: 'operation.verification_started',
        operationId: input.intent.operationId,
        taskId: input.intent.taskId,
        executionEpoch: input.observation.executionEpoch,
        status: 'verifying',
        evidenceRefs: this.ensureEvidence(input.observation.evidenceRefs, 'verification-started', input.route.effectiveScope),
      });
    }

    let decision;
    try {
      decision = await this.dependencies.verifier.verify({
        intent: input.intent,
        registration: input.registration,
        route: input.route,
        ...(input.lease ? { lease: input.lease } : {}),
        observation: input.observation,
      });
    } catch (error) {
      return await this.failVerification(input, error);
    }

    try {
      this.assertEpoch(input.intent, input.observation.executionEpoch, decision.executionEpoch, 'verifying');
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== 'stale-epoch') throw error;
      return this.blockStale(input, 'verification', input.observation, error);
    }
    if (!decision.accepted) {
      const failure = this.failure({
        intent: input.intent,
        registration: input.registration,
        route: input.route,
        phase: 'verification',
        failureClass: 'verifier',
        message: decision.message ?? `verifier rejected output: ${decision.decision}`,
        evidenceRefs: this.ensureEvidence(
          [...input.observation.evidenceRefs, ...decision.evidenceRefs],
          'verification-failed',
          input.route.effectiveScope,
        ),
        nextAction: { kind: 'recover', ref: 'reconcile' },
      });
      assertTransitionOperationStatus('verifying', 'failed');
      await this.emitStatus(input, 'operation.failed', 'failed', failure.evidenceRefs, undefined, failure);
      return {
        status: 'failed',
        observation: input.observation,
        failure,
        result: this.failedResult(input, failure, decision.decision),
      };
    }

    assertTransitionOperationStatus('verifying', 'succeeded');
    const result = this.succeededResult(input, decision.decision, decision.evidenceRefs);
    await this.emitStatus(input, 'operation.completed', 'succeeded', result.evidenceRefs, this.resultRef(input.intent));
    return { status: 'succeeded', observation: input.observation, result };
  }

  private async failExecution(
    input: ExecuteHandInput,
    error: unknown,
    observation?: OperationExecutorObservation,
    failureClass: OperationFailure['failureClass'] = 'executor',
  ): Promise<HandRunResult> {
    assertTransitionOperationStatus('running', 'settling');
    assertTransitionOperationStatus('settling', 'failed');
    const evidenceRefs = this.ensureEvidence(
      observation?.evidenceRefs ?? [],
      'execution-failed',
      input.route.effectiveScope,
    );
    const failure = this.failure({
      intent: input.intent,
      registration: input.registration,
      route: input.route,
      phase: 'execution',
      failureClass,
      message: error instanceof Error ? error.message : 'executor failed',
      evidenceRefs,
      nextAction: { kind: 'recover', ref: 'reconcile' },
    });
    const result = this.failedResult(
      { intent: input.intent, registration: input.registration, route: input.route, observation },
      failure,
      failure.failureClass,
    );
    await this.emitStatus(input, 'operation.failed', 'failed', failure.evidenceRefs, undefined, failure);
    return { status: 'failed', ...(observation ? { observation } : {}), failure, result };
  }

  private async failVerification(input: VerifyOnlyHandInput, error: unknown): Promise<HandRunResult> {
    assertTransitionOperationStatus('verifying', 'failed');
    const failure = this.failure({
      intent: input.intent,
      registration: input.registration,
      route: input.route,
      phase: 'verification',
      failureClass: 'verifier',
      message: error instanceof Error ? error.message : 'verifier failed',
      evidenceRefs: this.ensureEvidence(input.observation.evidenceRefs, 'verification-failed', input.route.effectiveScope),
      nextAction: { kind: 'recover', ref: 'reconcile' },
    });
    const result = this.failedResult(input, failure, 'verifier-error');
    await this.emitStatus(input, 'operation.failed', 'failed', failure.evidenceRefs, undefined, failure);
    return { status: 'failed', observation: input.observation, failure, result };
  }

  private failure(input: FailureInput): OperationFailure {
    const failure: OperationFailure = {
      errorId: `runtime-gateway-error-${randomUUID()}`,
      operationId: input.intent.operationId,
      owner: input.registration.owner,
      phase: input.phase,
      failureClass: input.failureClass,
      message: input.message,
      observedAt: this.dependencies.now().toISOString(),
      impact: 'operation cannot advance to a trusted terminal result',
      protectiveAction: 'preserve operation identity and evidence for explicit recovery',
      nextAction: input.nextAction,
      ...(input.recoveryCondition ? { recoveryCondition: input.recoveryCondition } : {}),
      evidenceRefs: input.evidenceRefs,
    };
    validateOperationFailure(failure);
    return failure;
  }

  private succeededResult(
    input: VerifyOnlyHandInput,
    verifierDecision: string,
    verifierEvidenceRefs: readonly EvidenceRef[],
  ): OperationResult {
    const result: OperationResult = {
      operationId: input.intent.operationId,
      status: 'succeeded',
      outputRef: input.observation.outputRef!,
      outputDigest: input.observation.outputDigest!,
      evidenceRefs: this.ensureEvidence(
        [...input.observation.evidenceRefs, ...verifierEvidenceRefs],
        'operation-succeeded',
        input.route.effectiveScope,
      ),
      verifier: {
        name: input.registration.verifier,
        version: input.registration.routeVersion,
        decision: verifierDecision,
      },
      completedAt: this.dependencies.now().toISOString(),
    };
    validateOperationResult(result);
    return result;
  }

  private failedResult(
    input: {
      readonly intent: OperationIntent;
      readonly registration: ToolRegistration;
      readonly route: RouteSelection;
      readonly observation?: OperationExecutorObservation;
    },
    failure: OperationFailure,
    verifierDecision: string,
  ): OperationResult {
    const outputRef = input.observation?.outputRef;
    const outputDigest = input.observation?.outputDigest;
    const result: OperationResult = {
      operationId: input.intent.operationId,
      status: 'failed',
      ...(outputRef !== undefined && outputDigest !== undefined ? { outputRef, outputDigest } : {}),
      evidenceRefs: this.ensureEvidence(
        [...(input.observation?.evidenceRefs ?? []), ...failure.evidenceRefs],
        'operation-failed',
        input.route.effectiveScope,
      ),
      verifier: {
        name: input.registration.verifier,
        version: input.registration.routeVersion,
        decision: verifierDecision,
      },
      failure,
      completedAt: this.dependencies.now().toISOString(),
    };
    validateOperationResult(result);
    return result;
  }

  private async emitStatus(
    input: VerifyOnlyHandInput | ExecuteHandInput,
    kind: OperationEvent['kind'],
    status: OperationStatus,
    evidenceRefs: readonly EvidenceRef[],
    resultRef?: string,
    failure?: OperationFailure,
  ): Promise<void> {
    const executionEpoch = input.lease
      ? input.lease.executionEpoch
      : 'observation' in input
        ? input.observation.executionEpoch
        : 1;
    await this.dependencies.emit({
      kind,
      operationId: input.intent.operationId,
      taskId: input.intent.taskId,
      executionEpoch,
      status,
      evidenceRefs,
      ...(resultRef ? { resultRef } : {}),
      ...(failure ? { failure } : {}),
    });
  }

  private async blockStale(
    input: ExecuteHandInput | VerifyOnlyHandInput,
    blockedAfter: 'execution' | 'verification',
    observation: OperationExecutorObservation,
    error: GatewayError,
  ): Promise<HandRunResult> {
    if (blockedAfter === 'execution') {
      assertTransitionOperationStatus('running', 'settling');
      assertTransitionOperationStatus('settling', 'blocked');
    } else {
      assertTransitionOperationStatus('verifying', 'blocked');
    }
    const blocked: OperationBlockedState = {
      blockedAfter,
      sideEffectState: 'possible',
      retryAllowed: false,
      owner: observation.owner,
      nextAction: { kind: 'recover', ref: 'reconcile' },
      evidenceRefs: this.ensureEvidence(
        [...observation.evidenceRefs, ...error.evidenceRefs],
        `stale-${blockedAfter}`,
        input.route.effectiveScope,
      ),
    };
    await this.emitStatus(input, 'operation.blocked', 'blocked', blocked.evidenceRefs);
    return { status: 'blocked', observation, blocked };
  }

  private assertEpoch(
    intent: OperationIntent,
    expectedExecutionEpoch: number,
    actualExecutionEpoch: number,
    operationStatus: OperationStatus,
  ): void {
    try {
      assertExecutionEventFence(
        {
          taskId: intent.taskId,
          executionEpoch: expectedExecutionEpoch,
        },
        {
          taskId: intent.taskId,
          operationId: intent.operationId,
          executionEpoch: actualExecutionEpoch,
        },
      );
    } catch (error) {
      throw new GatewayError('stale-epoch', error instanceof Error ? error.message : 'stale execution epoch', {
        operationStatus,
        cause: error,
      });
    }
  }

  private evidence(label: string, scope: Scope): EvidenceRef {
    return this.dependencies.createEvidence(label, scope);
  }

  private ensureEvidence(
    evidenceRefs: readonly EvidenceRef[],
    label: string,
    scope: Scope,
  ): readonly EvidenceRef[] {
    const resolved = evidenceRefs.length > 0 ? evidenceRefs : [this.evidence(label, scope)];
    for (const evidenceRef of resolved) {
      try {
        assertEvidenceRef(evidenceRef);
      } catch (error) {
        throw new GatewayError(
          'invalid-state',
          error instanceof Error ? error.message : 'operation evidence is invalid',
          { cause: error },
        );
      }
      if (!scopeContains(scope, evidenceRef.scope)) {
        throw new GatewayError(
          'invalid-state',
          'operation evidence exceeds route scope',
          { evidenceRefs: resolved },
        );
      }
    }
    return resolved;
  }

  private resultRef(intent: OperationIntent): string {
    return `operation-result:${intent.operationId.value}`;
  }
}
