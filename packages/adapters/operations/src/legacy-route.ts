import {
  assertEvidenceRef,
  assertScopeWithin,
  type ArtifactRef,
  type EvidenceRef,
  type OperationId,
  type Scope,
} from '../../../contracts/src/index.js';
import { OperationAdapterError, failureEvidence, operationFailure } from './errors.js';

import type {
  LegacyInternalExecutionResult,
  LegacyInternalExecutionContext,
  LegacyInternalToolEntry,
  OperationExecutionObservation,
  OperationExecutionRequest,
  OperationExecutorPort,
} from './types.js';

export class LegacyInternalRouteAdapter implements OperationExecutorPort {
  readonly routeId = 'legacy/internal';
  readonly mode = 'legacy' as const;

  constructor(private readonly entry: LegacyInternalToolEntry) {
    if (!entry.entryId || entry.entryId.trim() === '') {
      throw new TypeError('LegacyInternalRouteAdapter requires a non-empty entryId');
    }
  }

  async execute(input: OperationExecutionRequest): Promise<OperationExecutionObservation> {
    assertScopeWithin(input.effectiveScope, input.intent.requestedScope);
    const context: LegacyInternalExecutionContext = {
      entryId: this.entry.entryId,
      operationId: input.intent.operationId,
      scope: input.effectiveScope,
      inputRef: input.intent.inputRef,
    };

    const output = await this.entry.execute(context);
    const legacy = legacyExecutionResult(output);
    if (legacy.outputRef === undefined || legacy.outputDigest === undefined || legacy.evidenceRefs === undefined || legacy.evidenceRefs.length === 0) {
      throw legacyFailure(input, 'legacy tool did not return a complete output and evidence contract', 'incomplete-output');
    }
    for (const evidenceRef of legacy.evidenceRefs) {
      try {
        assertEvidenceRef(evidenceRef);
        assertScopeWithin(input.effectiveScope, evidenceRef.scope);
      } catch (error) {
        throw legacyFailure(
          input,
          error instanceof Error ? error.message : 'legacy evidence is invalid or outside operation scope',
          'invalid-evidence',
          error,
        );
      }
    }
    return {
      operationId: input.intent.operationId,
      outputRef: legacy.outputRef,
      outputDigest: legacy.outputDigest,
      evidenceRefs: legacy.evidenceRefs,
    };
  }
}

function legacyFailure(
  input: OperationExecutionRequest,
  message: string,
  label: string,
  cause?: unknown,
): OperationAdapterError {
  return new OperationAdapterError(operationFailure({
    errorId: `legacy-execution-${input.intent.operationId.value}-${label}`,
    operationId: input.intent.operationId,
    phase: 'execution',
    failureClass: 'contract',
    message,
    observedAt: new Date().toISOString(),
    impact: 'legacy operation output cannot be accepted as a trusted observation',
    protectiveAction: 'reject the unverified legacy output',
    nextAction: { kind: 'recover', ref: 'legacy/internal' },
    evidenceRefs: [failureEvidence(input.intent.operationId, input.effectiveScope, label)],
  }), cause);
}

function legacyExecutionResult(output: unknown): LegacyInternalExecutionResult {
  if (output === null || typeof output !== 'object') return {};
  const value = output as {
    readonly outputRef?: unknown;
    readonly outputDigest?: unknown;
    readonly evidenceRefs?: unknown;
  };
  return {
    ...(typeof value.outputRef === 'string' ? { outputRef: value.outputRef } : {}),
    ...(typeof value.outputDigest === 'string' ? { outputDigest: value.outputDigest } : {}),
    ...(Array.isArray(value.evidenceRefs) ? { evidenceRefs: value.evidenceRefs as readonly EvidenceRef[] } : {}),
  };
}

function legacyEvidence(entryId: string, operationId: OperationId, scope: Scope): EvidenceRef {
  return {
    evidenceId: {
      scope: 'evidence',
      value: `legacy-${entryId}-${operationId.value}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128),
    },
    kind: 'tool',
    source: `legacy/internal/${entryId}`,
    locator: `legacy://${entryId}/operations/${operationId.value}`,
    scope,
  };
}

export function legacyOutputRef(entryId: string, operationId: OperationId): ArtifactRef {
  return `artifact://legacy/${entryId}/${operationId.value}`;
}
