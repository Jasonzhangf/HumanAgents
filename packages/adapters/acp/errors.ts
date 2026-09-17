import type {
  AcpDriverBinding,
  AcpServerBinding,
  EvidenceRef,
  NextAction,
} from '../../contracts/src/index.js';

export const ACP_SERVER_OWNER = 'humanagent.acp-server-adapter';
export const ACP_DRIVER_OWNER = 'humanagent.acp-driver-adapter';

export type AcpErrorCode =
  | 'binding-invalid'
  | 'identity-mismatch'
  | 'permission-denied'
  | 'capability-unavailable'
  | 'session-not-found'
  | 'session-kind-mismatch'
  | 'stale-execution'
  | 'transport-failure'
  | 'transport-closed'
  | 'protocol-error'
  | 'no-response';

export interface AcpErrorInput {
  readonly code: AcpErrorCode;
  readonly message: string;
  readonly ownerId: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly binding?: AcpServerBinding | AcpDriverBinding;
  readonly cause?: unknown;
}

export class AcpAdapterError extends Error {
  readonly code: AcpErrorCode;
  readonly ownerId: string;
  readonly nextAction: NextAction;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly binding?: AcpServerBinding | AcpDriverBinding;

  constructor(input: AcpErrorInput) {
    super(input.message);
    this.name = 'AcpAdapterError';
    this.code = input.code;
    this.ownerId = input.ownerId;
    this.nextAction = input.nextAction;
    this.evidenceRefs = [...input.evidenceRefs];
    if (input.binding !== undefined) this.binding = input.binding;
    if (input.cause !== undefined) this.cause = input.cause;
  }
}

export function acpError(
  code: AcpErrorCode,
  message: string,
  ownerId: string,
  nextAction: NextAction,
  evidenceRefs: readonly EvidenceRef[],
  options: {
    readonly binding?: AcpServerBinding | AcpDriverBinding;
    readonly cause?: unknown;
  } = {},
): AcpAdapterError {
  return new AcpAdapterError({
    code,
    message,
    ownerId,
    nextAction,
    evidenceRefs,
    ...options,
  });
}

export function capabilityUnavailable(
  message: string,
  ownerId: string,
  evidenceRefs: readonly EvidenceRef[],
  binding?: AcpServerBinding | AcpDriverBinding,
): AcpAdapterError {
  return acpError(
    'capability-unavailable',
    message,
    ownerId,
    { kind: 'recover', ref: ownerId },
    evidenceRefs,
    binding === undefined ? {} : { binding },
  );
}
