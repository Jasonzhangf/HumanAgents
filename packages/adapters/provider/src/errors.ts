import {
  id,
  type AnyProviderExecutionIdentityRef,
  type EvidenceRef,
  type NextAction,
  type ProviderAttentionClass,
  type ProviderError,
  type ProviderErrorCategory,
  type ProviderErrorPhase,
  type ProviderBinding,
  type ProviderRetryability,
  type ScopeRef,
} from '../../../contracts/src/index.js';

const OWNER_ID = 'humanagent.provider-adapter';

function toScope(scopeOrExecution: ProviderBinding | AnyProviderExecutionIdentityRef | ScopeRef | undefined): ScopeRef {
  if (!scopeOrExecution) return { organId: id('organ', 'provider-adapter') };
  if ('providerId' in scopeOrExecution) return { organId: id('organ', 'provider-adapter') };
  if ('runtimeId' in scopeOrExecution) {
    // A taskless helper execution carries no Task identity, so its error scope
    // is the organ plus operation only. Emitting a synthetic taskId would mix
    // the helper error into a Task that never ran.
    if ('helper' in scopeOrExecution) {
      return { organId: scopeOrExecution.organId, operationId: scopeOrExecution.operationId };
    }
    return {
      organId: scopeOrExecution.organId ?? id('organ', 'provider-adapter'),
      taskId: scopeOrExecution.taskId,
      operationId: scopeOrExecution.operationId,
    };
  }
  return scopeOrExecution;
}

function errorEvidence(scopeOrExecution: ProviderBinding | AnyProviderExecutionIdentityRef | ScopeRef | undefined, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `provider-${label.replace(/[^A-Za-z0-9._-]/g, '-')}`),
    kind: 'external',
    source: OWNER_ID,
    locator: label,
    scope: toScope(scopeOrExecution),
  };
}

export interface ProviderAdapterErrorInput {
  readonly code: string;
  readonly category: ProviderErrorCategory;
  readonly phase: ProviderErrorPhase;
  readonly message: string;
  readonly scope?: ProviderBinding | AnyProviderExecutionIdentityRef | ScopeRef;
  readonly retryable?: ProviderRetryability;
  readonly attention?: ProviderAttentionClass;
  readonly nextAction?: NextAction;
  readonly cause?: unknown;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export class ProviderAdapterError extends Error {
  readonly providerError: ProviderError;

  constructor(input: ProviderAdapterErrorInput) {
    super(input.message);
    this.name = 'ProviderAdapterError';
    if (input.cause !== undefined) this.cause = input.cause;
    this.providerError = {
      errorId: `provider.${input.phase}.${input.code}`,
      code: input.code,
      category: input.category,
      phase: input.phase,
      message: input.message,
      ownerId: OWNER_ID,
      retryable: input.retryable ?? 'manual',
      attention: input.attention ?? 'foreground',
      evidenceRefs: input.evidenceRefs ?? [errorEvidence(input.scope, `${input.phase}-${input.code}`)],
      nextAction: input.nextAction ?? { kind: 'recover', ref: OWNER_ID },
    };
  }
}

export function providerAdapterOwnerId(): string {
  return OWNER_ID;
}
