import {
  id,
  type NextAction,
  type OperationFailure,
  type OperationId,
  type Scope,
} from '../../../contracts/src/index.js';

export const OPERATIONS_ADAPTER_OWNER = 'humanagent.operations-adapter';

export class OperationAdapterError extends Error {
  readonly failure: OperationFailure;

  constructor(failure: OperationFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = 'OperationAdapterError';
    this.failure = failure;
  }
}

export function operationFailure(input: {
  readonly errorId: string;
  readonly operationId: OperationId;
  readonly owner?: string;
  readonly phase: OperationFailure['phase'];
  readonly failureClass: OperationFailure['failureClass'];
  readonly message: string;
  readonly observedAt: string;
  readonly impact: string;
  readonly protectiveAction: string;
  readonly nextAction: NextAction;
  readonly recoveryCondition?: string;
  readonly evidenceRefs: OperationFailure['evidenceRefs'];
}): OperationFailure {
  return {
    errorId: input.errorId,
    operationId: input.operationId,
    owner: input.owner ?? OPERATIONS_ADAPTER_OWNER,
    phase: input.phase,
    failureClass: input.failureClass,
    message: input.message,
    observedAt: input.observedAt,
    impact: input.impact,
    protectiveAction: input.protectiveAction,
    nextAction: input.nextAction,
    ...(input.recoveryCondition === undefined ? {} : { recoveryCondition: input.recoveryCondition }),
    evidenceRefs: input.evidenceRefs,
  };
}

export function failureEvidence(
  operationId: OperationId,
  scope: Scope,
  label: string,
  digest?: string,
): OperationFailure['evidenceRefs'][number] {
  const evidenceId = `operations-${sanitizeEvidenceId(operationId.value)}-${sanitizeEvidenceId(label)}`
    .slice(0, 128);
  return {
    evidenceId: id('evidence', evidenceId),
    kind: 'operation',
    source: OPERATIONS_ADAPTER_OWNER,
    locator: `operations://failure/${encodeURIComponent(operationId.value)}/${sanitizeLocator(label)}`,
    ...(digest === undefined ? {} : { digest }),
    scope,
  };
}

function sanitizeEvidenceId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128) || 'failure';
}

function sanitizeLocator(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}
