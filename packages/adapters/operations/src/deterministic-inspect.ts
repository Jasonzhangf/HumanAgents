import { createHash } from 'node:crypto';

import {
  assertEvidenceRef,
  assertScopeWithin,
  type ArtifactRef,
  type EvidenceRef,
  type OperationIntent,
  type OperationResult,
  type Scope,
} from '../../../contracts/src/index.js';

import { OperationAdapterError, failureEvidence, operationFailure } from './errors.js';
import type {
  OperationExecutionObservation,
  OperationExecutionRequest,
  OperationExecutorPort,
  OperationVerificationRequest,
  OperationVerifierPort,
} from './types.js';

export const DETERMINISTIC_INSPECT_TOOL_NAME = 'deterministic.inspect';
export const DETERMINISTIC_INSPECT_ROUTE_VERSION = 'deterministic-inspect.v1';

export interface DeterministicInspectOptions {
  readonly now?: () => string;
}

export class DeterministicInspectRoute implements OperationExecutorPort, OperationVerifierPort {
  readonly routeId = 'deterministic-inspect';
  readonly routeVersion = DETERMINISTIC_INSPECT_ROUTE_VERSION;
  readonly mode = 'gateway' as const;
  readonly toolName = DETERMINISTIC_INSPECT_TOOL_NAME;

  constructor(private readonly options: DeterministicInspectOptions = {}) {}

  async inspect(input: OperationExecutionRequest): Promise<OperationResult> {
    const observation = await this.execute(input);
    return this.verify({ ...input, observation });
  }

  async execute(input: OperationExecutionRequest): Promise<OperationExecutionObservation> {
    this.assertAdmissible(input.intent, input.effectiveScope);
    const outputDigest = deterministicInspectDigest(input.intent, input.effectiveScope);
    const outputRef: ArtifactRef = `artifact://operations/inspect/${input.intent.operationId.value}`;
    return {
      operationId: input.intent.operationId,
      outputRef,
      outputDigest,
      evidenceRefs: [
        inspectEvidence(input.intent, input.effectiveScope, 'input', input.intent.inputDigest),
        inspectEvidence(input.intent, input.effectiveScope, 'route', outputDigest),
      ],
    };
  }

  async verify(input: OperationVerificationRequest): Promise<OperationResult> {
    this.assertAdmissible(input.intent, input.effectiveScope);
    const completedAt = this.now();
    if (!sameOperationId(input.observation.operationId, input.intent.operationId)) {
      return this.failedVerification(
        input,
        completedAt,
        'inspect observation operation id does not match the operation intent',
        'operation-id-mismatch',
      );
    }
    try {
      for (const ref of input.observation.evidenceRefs) {
        assertEvidenceRef(ref);
      }
    } catch (error) {
      return this.failedVerification(
        input,
        completedAt,
        error instanceof Error ? error.message : 'inspect observation evidence is invalid',
        'invalid-evidence',
      );
    }
    if (!input.observation.evidenceRefs.every((ref) => sameScope(ref.scope, input.effectiveScope))) {
      return this.failedVerification(
        input,
        completedAt,
        'inspect observation evidence scope does not match the effective operation scope',
        'evidence-scope-mismatch',
      );
    }
    const requiredKinds = new Set(input.intent.expectedOutput.requiredEvidenceKinds);
    const presentKinds = new Set(input.observation.evidenceRefs.map((ref) => ref.kind));
    const missingKind = [...requiredKinds].find((kind) => !presentKinds.has(kind));
    if (input.observation.evidenceRefs.length === 0 || missingKind !== undefined) {
      return this.failedVerification(
        input,
        completedAt,
        missingKind === undefined
          ? 'inspect observation has no evidence refs'
          : `inspect observation is missing required ${missingKind} evidence`,
        'missing-evidence',
      );
    }

    const expectedOutputDigest = deterministicInspectDigest(input.intent, input.effectiveScope);
    const expectedOutputRef = `artifact://operations/inspect/${input.intent.operationId.value}`;
    if (input.observation.outputRef !== expectedOutputRef || input.observation.outputDigest !== expectedOutputDigest) {
      return this.failedVerification(
        input,
        completedAt,
        'inspect observation output does not match the deterministic route result',
        'output-mismatch',
      );
    }
    const expectedEvidence = [
      inspectEvidence(input.intent, input.effectiveScope, 'input', input.intent.inputDigest),
      inspectEvidence(input.intent, input.effectiveScope, 'route', expectedOutputDigest),
    ];
    const missingExpectedEvidence = expectedEvidence.find((expected) => !input.observation.evidenceRefs.some((actual) =>
      actual.evidenceId.scope === expected.evidenceId.scope
      && actual.evidenceId.value === expected.evidenceId.value
      && actual.digest === expected.digest
      && actual.locator === expected.locator));
    if (missingExpectedEvidence !== undefined) {
      return this.failedVerification(
        input,
        completedAt,
        'inspect observation is missing route-owned evidence',
        'route-evidence-mismatch',
      );
    }

    return {
      operationId: input.intent.operationId,
      status: 'succeeded',
      ...(input.observation.outputRef === undefined ? {} : { outputRef: input.observation.outputRef }),
      ...(input.observation.outputDigest === undefined ? {} : { outputDigest: input.observation.outputDigest }),
      evidenceRefs: input.observation.evidenceRefs,
      verifier: { name: this.routeId, version: this.routeVersion, decision: 'passed' },
      completedAt,
    };
  }

  private assertAdmissible(intent: OperationIntent, effectiveScope: Scope): void {
    try {
      if (intent.kind !== 'inspect') throw new Error('deterministic inspect route only supports inspect');
      if (intent.toolName !== DETERMINISTIC_INSPECT_TOOL_NAME) {
        throw new Error(`deterministic inspect route does not own tool '${intent.toolName}'`);
      }
      assertScopeWithin(effectiveScope, intent.requestedScope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = operationFailure({
        errorId: `inspect-admission-${intent.operationId.value}`,
        operationId: intent.operationId,
        phase: 'admission',
        failureClass: message.includes('scope') ? 'permission' : 'contract',
        message,
        observedAt: this.now(),
        impact: 'inspect operation was not admitted to the deterministic route',
        protectiveAction: 'keep the operation off the route and surface the structured failure',
        nextAction: { kind: 'recover', ref: this.routeId },
        evidenceRefs: [failureEvidence(intent.operationId, intent.requestedScope, 'admission')],
      });
      throw new OperationAdapterError(failure, error);
    }
  }

  private failedVerification(
    input: OperationVerificationRequest,
    completedAt: string,
    message: string,
    evidenceLabel: string,
  ): OperationResult {
    const failure = operationFailure({
      errorId: `inspect-verification-${input.intent.operationId.value}`,
      operationId: input.intent.operationId,
      phase: 'verification',
      failureClass: 'verifier',
      message,
      observedAt: completedAt,
      impact: 'inspect result cannot be accepted without contract evidence',
      protectiveAction: 'reject the unverified inspect result',
      nextAction: { kind: 'recover', ref: this.routeId },
      evidenceRefs: [failureEvidence(input.intent.operationId, input.effectiveScope, evidenceLabel)],
    });
    return {
      operationId: input.intent.operationId,
      status: 'failed',
      evidenceRefs: failure.evidenceRefs,
      verifier: { name: this.routeId, version: this.routeVersion, decision: 'failed' },
      failure,
      completedAt,
    };
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }
}

export function deterministicInspectDigest(intent: OperationIntent, effectiveScope: Scope): string {
  const digest = createHash('sha256').update(JSON.stringify([
    intent.operationId.scope,
    intent.operationId.value,
    intent.inputDigest,
    intent.intentRevision,
    effectiveScope.organId.scope,
    effectiveScope.organId.value,
    effectiveScope.taskId?.scope ?? null,
    effectiveScope.taskId?.value ?? null,
    effectiveScope.cycleId?.scope ?? null,
    effectiveScope.cycleId?.value ?? null,
    effectiveScope.operationId?.scope ?? null,
    effectiveScope.operationId?.value ?? null,
  ])).digest('hex');
  return `sha256:${digest}`;
}

function inspectEvidence(
  intent: OperationIntent,
  scope: Scope,
  label: string,
  digest: string,
): EvidenceRef {
  return {
    evidenceId: {
      scope: 'evidence',
      value: `inspect-${label}-${intent.operationId.value}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128),
    },
    kind: label === 'input' ? 'external' : 'tool',
    source: 'humanagent.operations.deterministic-inspect',
    locator: `operations://inspect/${intent.operationId.value}/${label}`,
    digest,
    scope,
  };
}

function sameOperationId(left: OperationIntent['operationId'], right: OperationIntent['operationId']): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function sameScope(left: Scope, right: Scope): boolean {
  return sameScopedId(left.organId, right.organId)
    && sameScopedId(left.taskId, right.taskId)
    && sameScopedId(left.cycleId, right.cycleId)
    && sameScopedId(left.operationId, right.operationId);
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.scope === right.scope && left.value === right.value;
}
