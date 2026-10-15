import type { JournalCommitRef } from '../../contracts/src/i2-history.js';
import type {
  ConfirmedContextCorrectionBasis,
  ContextCorrectionBasisFacts,
  ContextCorrectionRef,
  CorrectionTaskScope,
} from '../../contracts/src/context-correction.js';
import { CoreError } from './errors.js';

/** Explicit failure for an inconsistent or unresolved correction basis. */
export class ContextCorrectionError extends CoreError {
  constructor(message: string) {
    super(message);
    this.name = 'ContextCorrectionError';
  }
}

function sameScopedValue(
  left: { readonly scope: string; readonly value: string },
  right: { readonly scope: string; readonly value: string },
): boolean {
  return left.scope === right.scope && left.value === right.value;
}

/** Task scope equality: organ identity and task identity must both match. */
export function sameCorrectionTaskScope(left: CorrectionTaskScope, right: CorrectionTaskScope): boolean {
  return sameScopedValue(left.organId, right.organId) && sameScopedValue(left.taskId, right.taskId);
}

/** Journal receipt equality: commitId, journalSeq and recordDigest must all match. */
export function sameJournalCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

/** Exact Context business ref equality: same Task scope and the exact string value. */
export function sameContextCorrectionRef(left: ContextCorrectionRef, right: ContextCorrectionRef): boolean {
  return sameCorrectionTaskScope(left.taskScope, right.taskScope) && left.ref === right.ref;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new ContextCorrectionError(`${label} is required`);
}

function assertTaskScope(scope: CorrectionTaskScope, label: string): void {
  if (scope.organId.scope !== 'organ' || scope.organId.value.trim() === '') {
    throw new ContextCorrectionError(`${label} organ id is invalid`);
  }
  if (scope.taskId.scope !== 'task' || scope.taskId.value.trim() === '') {
    throw new ContextCorrectionError(`${label} task id is invalid`);
  }
}

function freezeTaskScope(scope: CorrectionTaskScope): CorrectionTaskScope {
  assertTaskScope(scope, 'correction task scope');
  return Object.freeze({
    organId: Object.freeze({ scope: scope.organId.scope, value: scope.organId.value }),
    taskId: Object.freeze({ scope: scope.taskId.scope, value: scope.taskId.value }),
  });
}

function copyReceipt(receipt: JournalCommitRef, label: string): JournalCommitRef {
  requireNonEmpty(receipt.commitId, `${label} commit id`);
  requireNonEmpty(receipt.recordDigest, `${label} record digest`);
  if (!Number.isSafeInteger(receipt.journalSeq) || receipt.journalSeq < 0) {
    throw new ContextCorrectionError(`${label} journal sequence is invalid`);
  }
  return Object.freeze({
    commitId: receipt.commitId,
    journalSeq: receipt.journalSeq,
    recordDigest: receipt.recordDigest,
  });
}

/**
 * Build one immutable correction basis from confirmed command facts and the
 * owner-resolved source, current and wrong-ref facts. Core rejects mismatched
 * scope, mismatched source or expected receipts, a mismatched expected epoch, an
 * unresolved wrong ref and an empty wrong-ref set. It does not re-validate
 * external authority and it does not mutate its input.
 */
export function buildConfirmedContextCorrectionBasis(
  facts: ContextCorrectionBasisFacts,
): ConfirmedContextCorrectionBasis {
  requireNonEmpty(facts.commandId, 'correction command id');
  requireNonEmpty(facts.repairText, 'correction repair text');
  requireNonEmpty(facts.confirmationRef, 'correction confirmation ref');
  requireNonEmpty(facts.principalOwner, 'correction principal owner');
  const taskScope = freezeTaskScope(facts.taskScope);
  if (!sameCorrectionTaskScope(facts.source.taskScope, taskScope)) {
    throw new ContextCorrectionError('source checkpoint task scope does not match the correction task scope');
  }
  if (!sameCorrectionTaskScope(facts.current.taskScope, taskScope)) {
    throw new ContextCorrectionError('current position task scope does not match the correction task scope');
  }
  if (!sameJournalCommitRef(facts.sourceCheckpointReceipt, facts.source.checkpointReceipt)) {
    throw new ContextCorrectionError('source checkpoint receipt does not match the resolved source facts');
  }
  if (!sameJournalCommitRef(facts.expectedControlReceipt, facts.current.controlReceipt)) {
    throw new ContextCorrectionError('expected control receipt does not match the authoritative current control receipt');
  }
  if (!sameJournalCommitRef(facts.expectedContextReceipt, facts.current.contextReceipt)) {
    throw new ContextCorrectionError('expected context receipt does not match the authoritative current context receipt');
  }
  if (!Number.isSafeInteger(facts.expectedExecutionEpoch) || facts.expectedExecutionEpoch < 1) {
    throw new ContextCorrectionError('expected execution epoch must be a positive safe integer');
  }
  if (facts.expectedExecutionEpoch !== facts.current.executionEpoch) {
    throw new ContextCorrectionError('expected execution epoch does not match the authoritative current epoch');
  }
  if (facts.wrongRefs.length === 0) {
    throw new ContextCorrectionError('a confirmed correction requires at least one resolved wrong ref');
  }
  for (const resolvedRef of facts.resolvedBusinessRefs) {
    if (!sameCorrectionTaskScope(resolvedRef.taskScope, taskScope)) {
      throw new ContextCorrectionError('an owner-resolved business ref does not belong to the correction task scope');
    }
    requireNonEmpty(resolvedRef.ref, 'owner-resolved business ref');
  }
  const wrongRefs = facts.wrongRefs.map((wrongRef) => {
    if (!sameCorrectionTaskScope(wrongRef.taskScope, taskScope)) {
      throw new ContextCorrectionError('a resolved wrong ref does not belong to the correction task scope');
    }
    requireNonEmpty(wrongRef.ref, 'resolved wrong ref');
    if (!facts.resolvedBusinessRefs.some((resolvedRef) => sameContextCorrectionRef(wrongRef, resolvedRef))) {
      throw new ContextCorrectionError(
        'a confirmed wrong ref has no matching owner-resolved committed business ref',
      );
    }
    return Object.freeze({ taskScope, ref: wrongRef.ref });
  });
  return Object.freeze({
    commandId: facts.commandId,
    taskScope,
    sourceCheckpointReceipt: copyReceipt(facts.sourceCheckpointReceipt, 'source checkpoint receipt'),
    expectedControlReceipt: copyReceipt(facts.expectedControlReceipt, 'expected control receipt'),
    expectedContextReceipt: copyReceipt(facts.expectedContextReceipt, 'expected context receipt'),
    expectedExecutionEpoch: facts.expectedExecutionEpoch,
    wrongRefs: Object.freeze(wrongRefs),
    repairText: facts.repairText,
    confirmationRef: facts.confirmationRef,
    principalOwner: facts.principalOwner,
  });
}

/**
 * Exact set subtraction: `effectiveAfter = effectiveBefore - acceptedWrongRefs`,
 * order preserved. The same function serves current effective refs, future
 * assembly candidates and historical replay candidates. It compares the exact ref
 * string within the same Task scope only, so it never removes prefixes,
 * descendants or similar names. It returns a fresh array and never mutates or
 * shares the accepted arrays.
 */
export function applyContextCorrectionExclusions(
  basis: ConfirmedContextCorrectionBasis,
  candidateRefs: readonly ContextCorrectionRef[],
): readonly ContextCorrectionRef[] {
  const excluded = basis.wrongRefs;
  return Object.freeze(
    candidateRefs.filter((candidate) => !excluded.some((wrong) => sameContextCorrectionRef(candidate, wrong))),
  );
}
