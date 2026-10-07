import type { EvidenceRef } from '../../../contracts/src/index.js';

/**
 * Bounded view of a real error chain. Runtime failures keep their original
 * cause in `Error.cause`; the API exposes enough of that chain for a human to
 * act on the original failure without leaking a stack or arbitrary properties.
 */
export interface UiRuntimeErrorCauseBody {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly ownerId?: string;
  readonly cause?: UiRuntimeErrorCauseBody;
}

export interface UiRuntimeApiErrorBody {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly cause?: UiRuntimeErrorCauseBody;
}

// The chain is reported as observed and stays bounded: at most three links, at
// most 512 characters per message, and only the named fields below. A stack
// would expose the process layout instead of the failure, and copying arbitrary
// properties would move control-plane data into a response payload.
const MAX_CAUSE_DEPTH = 3;
const MAX_CAUSE_MESSAGE_CHARS = 512;

function causeMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length <= MAX_CAUSE_MESSAGE_CHARS ? text : `${text.slice(0, MAX_CAUSE_MESSAGE_CHARS)}…`;
}

function namedString(source: object, key: 'code' | 'ownerId'): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function boundedErrorCause(error: unknown, depth = MAX_CAUSE_DEPTH): UiRuntimeErrorCauseBody | undefined {
  if (error === undefined || error === null || depth <= 0) return undefined;
  if (!(error instanceof Error)) return { name: 'Error', message: causeMessage(error) };
  const code = namedString(error, 'code');
  const ownerId = namedString(error, 'ownerId');
  const nested = boundedErrorCause(error.cause, depth - 1);
  return {
    name: error.name,
    message: causeMessage(error.message),
    ...(code === undefined ? {} : { code }),
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(nested === undefined ? {} : { cause: nested }),
  };
}

// Typed API error. Every failure response exposes code, owner, message and next
// action so the browser can render an explicit error instead of a silent one,
// plus the bounded chain of the original failure when one was reported.
export class UiRuntimeApiError extends Error {
  readonly code: string;
  readonly ownerId: string;
  readonly nextAction: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly httpStatus: number;
  readonly causeBody?: UiRuntimeErrorCauseBody;

  constructor(
    code: string,
    ownerId: string,
    message: string,
    nextAction: string,
    httpStatus = 400,
    evidenceRefs?: readonly EvidenceRef[],
    cause?: unknown,
  ) {
    super(message);
    this.name = 'UiRuntimeApiError';
    this.code = code;
    this.ownerId = ownerId;
    this.nextAction = nextAction;
    this.httpStatus = httpStatus;
    this.evidenceRefs = evidenceRefs;
    this.causeBody = boundedErrorCause(cause);
  }

  toBody(): UiRuntimeApiErrorBody {
    return {
      code: this.code,
      ownerId: this.ownerId,
      message: this.message,
      nextAction: this.nextAction,
      ...(this.evidenceRefs === undefined ? {} : { evidenceRefs: this.evidenceRefs }),
      ...(this.causeBody === undefined ? {} : { cause: this.causeBody }),
    };
  }
}
