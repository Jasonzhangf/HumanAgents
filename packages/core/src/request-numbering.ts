/// <reference path="./node-modules.d.ts" />
import { CoreError } from './errors.js';

/**
 * The authoritative user-facing request number rule for explicit interactions.
 * A number is allocated only on the first success commit of an interaction or
 * revision; a later exact retry returns the already-assigned number without
 * advancing the sequence. Receiving, matching, clarification, rejection and
 * response errors never call this rule, so failures consume no number.
 */
export interface RequestNumberAllocation {
  readonly requestNumber: number;
  readonly nextRequestNumber: number;
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CoreError(`${label} must be a positive safe integer`);
  }
}

export function allocateRequestNumber(
  nextRequestNumber: number,
  alreadyAssigned?: number,
): RequestNumberAllocation {
  positiveSafeInteger(nextRequestNumber, 'next request number');
  if (alreadyAssigned !== undefined) {
    positiveSafeInteger(alreadyAssigned, 'assigned request number');
    return { requestNumber: alreadyAssigned, nextRequestNumber };
  }
  return { requestNumber: nextRequestNumber, nextRequestNumber: nextRequestNumber + 1 };
}
