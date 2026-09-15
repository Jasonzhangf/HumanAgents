import type { EvidenceRef } from '../../../contracts/src/index.js';

export interface UiRuntimeApiErrorBody {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

// Typed API error. Every failure response exposes code, owner, message and next
// action so the browser can render an explicit error instead of a silent one.
export class UiRuntimeApiError extends Error {
  readonly code: string;
  readonly ownerId: string;
  readonly nextAction: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly httpStatus: number;

  constructor(code: string, ownerId: string, message: string, nextAction: string, httpStatus = 400, evidenceRefs?: readonly EvidenceRef[]) {
    super(message);
    this.name = 'UiRuntimeApiError';
    this.code = code;
    this.ownerId = ownerId;
    this.nextAction = nextAction;
    this.httpStatus = httpStatus;
    this.evidenceRefs = evidenceRefs;
  }

  toBody(): UiRuntimeApiErrorBody {
    return {
      code: this.code,
      ownerId: this.ownerId,
      message: this.message,
      nextAction: this.nextAction,
      ...(this.evidenceRefs === undefined ? {} : { evidenceRefs: this.evidenceRefs }),
    };
  }
}
