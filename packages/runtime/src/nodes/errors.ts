import type { NextAction } from '../../../contracts/src/index.js';
import type { EvidenceRef } from '../../../contracts/src/index.js';
import { CoreError } from '../../../core/src/errors.js';

export interface RuntimeErrorContext {
  readonly ownerRef?: string;
  readonly nextAction?: NextAction;
  readonly conditionRef?: string;
  readonly failureRef?: string;
  readonly cause?: unknown;
}

export class RuntimeError extends CoreError {
  readonly ownerRef?: string;
  readonly nextAction?: NextAction;
  readonly conditionRef?: string;
  readonly failureRef?: string;
  readonly cause?: unknown;

  constructor(message: string, context: RuntimeErrorContext = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.ownerRef = context.ownerRef;
    this.nextAction = context.nextAction;
    this.conditionRef = context.conditionRef;
    this.failureRef = context.failureRef;
    this.cause = context.cause;
  }
}

export class NodeDispatchError extends RuntimeError {
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly cause: unknown;

  constructor(
    message: string,
    context: RuntimeErrorContext & { readonly failureRef: string },
    details: { readonly outputRefs: readonly string[]; readonly evidenceRefs: readonly EvidenceRef[]; readonly cause: unknown },
  ) {
    super(message, context);
    this.name = 'NodeDispatchError';
    this.outputRefs = [...details.outputRefs];
    this.evidenceRefs = [...details.evidenceRefs];
    this.cause = details.cause;
  }
}

export function requireReference(value: string | undefined, label: string): string {
  if (!value || !value.trim()) throw new RuntimeError(`${label} is required`);
  return value;
}
