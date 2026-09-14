import { ContractError } from '../../../contracts/src/index.js';
import type { ProviderBinding, ProviderErrorPhase, ProviderExecutionIdentityRef } from '../../../contracts/src/index.js';

export type DshAdapterErrorCode =
  | 'dependency-missing'
  | 'capability-unavailable'
  | 'configuration-invalid'
  | 'identity-mismatch'
  | 'transport-failure';

export type DshAdapterNextAction = { readonly kind: 'continue' | 'wait' | 'stop' | 'recover'; readonly ref?: string };

export interface DshAdapterErrorOptions {
  readonly cause?: unknown;
  readonly phase?: ProviderErrorPhase;
  readonly binding?: ProviderBinding;
  readonly identity?: ProviderExecutionIdentityRef;
}

export class DshAdapterError extends ContractError {
  readonly code: DshAdapterErrorCode;
  readonly ownerId: string;
  readonly nextAction: DshAdapterNextAction;
  readonly cause?: unknown;
  readonly phase?: ProviderErrorPhase;
  readonly binding?: ProviderBinding;
  readonly identity?: ProviderExecutionIdentityRef;

  constructor(
    code: DshAdapterErrorCode,
    message: string,
    ownerId: string,
    nextAction: DshAdapterNextAction = { kind: 'recover', ref: ownerId },
    options: DshAdapterErrorOptions = {},
  ) {
    super(message);
    this.name = 'DshAdapterError';
    this.code = code;
    this.ownerId = ownerId;
    this.nextAction = nextAction;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.phase !== undefined) this.phase = options.phase;
    if (options.binding !== undefined) this.binding = options.binding;
    if (options.identity !== undefined) this.identity = options.identity;
  }
}

export function dshSeamError(
  code: DshAdapterErrorCode,
  error: unknown,
  options: {
    readonly phase: ProviderErrorPhase;
    readonly ownerId: string;
    readonly binding?: ProviderBinding;
    readonly identity?: ProviderExecutionIdentityRef;
  },
): DshAdapterError {
  if (error instanceof DshAdapterError) {
    return new DshAdapterError(error.code, error.message, options.ownerId, error.nextAction, {
      cause: error.cause ?? error,
      phase: error.phase ?? options.phase,
      binding: error.binding ?? options.binding,
      identity: error.identity ?? options.identity,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DshAdapterError(code, message, options.ownerId, { kind: 'recover', ref: options.ownerId }, {
    cause: error,
    phase: options.phase,
    binding: options.binding,
    identity: options.identity,
  });
}
