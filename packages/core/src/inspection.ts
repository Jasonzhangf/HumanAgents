import { ContractError } from '../../contracts/src/errors.js';
import {
  validateInspectionOccurrenceRecord,
  validateInspectionOccurrenceRef,
} from '../../contracts/src/inspection.js';
import type {
  InspectionCheckItem,
  InspectionComparisonReason,
  InspectionComparisonResult,
  InspectionItemChange,
  InspectionItemComparison,
  InspectionItemResult,
  InspectionOccurrenceRecord,
  InspectionOccurrenceRef,
  InspectionOccurrenceSource,
} from '../../contracts/src/inspection.js';

export interface InspectionComparisonInput {
  readonly before: InspectionOccurrenceRecord | null;
  readonly after: InspectionOccurrenceRecord | null;
  readonly beforeRef: InspectionOccurrenceRef;
  readonly afterRef: InspectionOccurrenceRef;
}

function sameTaskScope(left: InspectionOccurrenceRef, right: InspectionOccurrenceRef): boolean {
  return left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId.value === right.scope.taskId.value;
}

function sourceFor(
  record: InspectionOccurrenceRecord | null,
  ref: InspectionOccurrenceRef,
): InspectionOccurrenceSource {
  if (record === null) return { occurrence: ref, definition: null, evidenceRefs: [] };
  return {
    occurrence: record.occurrence,
    definition: {
      definitionId: record.definition.definitionId,
      definitionVersion: record.definition.definitionVersion,
    },
    evidenceRefs: record.evidenceRefs,
  };
}

function assertRecordMatchesRef(record: InspectionOccurrenceRecord, ref: InspectionOccurrenceRef): void {
  if (record.occurrence.occurrenceId !== ref.occurrenceId || !sameTaskScope(record.occurrence, ref)) {
    throw new ContractError('inspection occurrence record does not match the requested occurrence ref');
  }
}

function sameCheckIdSet(
  left: readonly InspectionCheckItem[],
  right: readonly InspectionCheckItem[],
): boolean {
  const leftIds = left.map((item) => item.checkId).sort();
  const rightIds = right.map((item) => item.checkId).sort();
  return leftIds.length === rightIds.length && leftIds.every((checkId, index) => checkId === rightIds[index]);
}

function missingResult(checkId: string): InspectionItemResult {
  return { checkId, state: 'missing', evidenceRefs: [] };
}

function itemChange(before: InspectionItemResult, after: InspectionItemResult): InspectionItemChange {
  if (before.state !== 'completed' || after.state !== 'completed') return 'not-compared';
  return before.judgment === after.judgment ? 'unchanged' : 'changed';
}

function compareItems(
  before: InspectionOccurrenceRecord,
  after: InspectionOccurrenceRecord,
): readonly InspectionItemComparison[] {
  const beforeResults = new Map(before.results.map((result) => [result.checkId, result]));
  const afterResults = new Map(after.results.map((result) => [result.checkId, result]));
  const checkIds = before.definition.checkItems
    .map((item) => item.checkId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return checkIds.map((checkId) => {
    const beforeResult = beforeResults.get(checkId) ?? missingResult(checkId);
    const afterResult = afterResults.get(checkId) ?? missingResult(checkId);
    return {
      checkId,
      before: beforeResult,
      after: afterResult,
      change: itemChange(beforeResult, afterResult),
    };
  });
}

function notComparable(
  reason: InspectionComparisonReason,
  before: InspectionOccurrenceSource,
  after: InspectionOccurrenceSource,
): InspectionComparisonResult {
  return { comparable: false, reason, before, after, items: [] };
}

/**
 * Pure comparison rule. It never reads, executes, retries, or writes history;
 * the caller supplies both occurrences (or null when one is missing).
 */
export function compareInspectionOccurrences(input: InspectionComparisonInput): InspectionComparisonResult {
  validateInspectionOccurrenceRef(input.beforeRef);
  validateInspectionOccurrenceRef(input.afterRef);
  if (input.before !== null) {
    validateInspectionOccurrenceRecord(input.before);
    assertRecordMatchesRef(input.before, input.beforeRef);
  }
  if (input.after !== null) {
    validateInspectionOccurrenceRecord(input.after);
    assertRecordMatchesRef(input.after, input.afterRef);
  }

  const beforeSource = sourceFor(input.before, input.beforeRef);
  const afterSource = sourceFor(input.after, input.afterRef);
  if (!sameTaskScope(input.beforeRef, input.afterRef)) {
    return notComparable('task-scope-mismatch', beforeSource, afterSource);
  }
  if (input.before === null) {
    return notComparable('before-occurrence-missing', beforeSource, afterSource);
  }
  if (input.after === null) {
    return notComparable('after-occurrence-missing', beforeSource, afterSource);
  }

  const beforeDefinition = input.before.definition;
  const afterDefinition = input.after.definition;
  if (
    beforeDefinition.definitionId !== afterDefinition.definitionId
    || beforeDefinition.definitionVersion !== afterDefinition.definitionVersion
  ) {
    return notComparable('definition-mismatch', beforeSource, afterSource);
  }
  if (
    beforeDefinition.target.targetRef !== afterDefinition.target.targetRef
    || beforeDefinition.target.sourceRef !== afterDefinition.target.sourceRef
  ) {
    return notComparable('target-mismatch', beforeSource, afterSource);
  }
  if (!sameCheckIdSet(beforeDefinition.checkItems, afterDefinition.checkItems)) {
    return notComparable('definition-mismatch', beforeSource, afterSource);
  }

  return {
    comparable: true,
    before: beforeSource,
    after: afterSource,
    basis: {
      taskId: input.beforeRef.scope.taskId,
      definition: {
        definitionId: beforeDefinition.definitionId,
        definitionVersion: beforeDefinition.definitionVersion,
      },
      target: beforeDefinition.target,
    },
    items: compareItems(input.before, input.after),
  };
}
