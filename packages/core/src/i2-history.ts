/// <reference path="./node-modules.d.ts" />
import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  validateBusinessCycleClosedRecord,
  validateBusinessCycleOpenedRecord,
  validateDurableInspectionDefinition,
  validateInspectionDefinitionContent,
  validateInspectionItemResultRecord,
  validateInspectionOccurrenceOpenedRecord,
  validateInspectionOccurrenceSettledRecord,
  validateMilestoneReviewAlignedRecord,
  validateMilestoneReviewResultRecord,
  type BusinessCycleClosedRecord,
  type BusinessCycleOpenedRecord,
  type DurableInspectionDefinition,
  type InspectionDefinitionContent,
  type InspectionItemResultRecord,
  type InspectionOccurrenceOpenedRecord,
  type InspectionOccurrenceSettledRecord,
  type MilestoneReviewAlignedRecord,
  type MilestoneReviewResultRecord,
} from '../../contracts/src/index.js';
import { CoreError } from './errors.js';

export class I2HistoryError extends CoreError {
  constructor(message: string) {
    super(message);
    this.name = 'I2HistoryError';
  }
}

function i2Error(error: unknown): never {
  if (error instanceof I2HistoryError) throw error;
  throw new I2HistoryError(error instanceof Error ? error.message : 'invalid i2 history record');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Canonical immutable content. Check order is not identity for I, so checks and
 * declared check IDs are sorted; strings, criteria and input refs stay verbatim.
 */
export function canonicalInspectionDefinitionContent(content: InspectionDefinitionContent): unknown {
  const checkItems = [...content.definition.checkItems].map((item) => item.checkId).sort(compareText);
  const checks = [...content.checks]
    .map((check) => ({ checkId: check.checkId, criterion: check.criterion, inputRefs: [...check.inputRefs] }))
    .sort((left, right) => compareText(left.checkId, right.checkId));
  return {
    definition: {
      definitionId: content.definition.definitionId,
      definitionVersion: content.definition.definitionVersion,
      target: {
        targetRef: content.definition.target.targetRef,
        sourceRef: content.definition.target.sourceRef,
      },
      checkItems,
    },
    checks,
  };
}

/** Digest over exact ID/version, target/source, declared check IDs, criteria and input refs. */
export function computeInspectionDefinitionDigest(content: InspectionDefinitionContent): string {
  try {
    validateInspectionDefinitionContent(content);
  } catch (error) {
    i2Error(error);
  }
  const canonical = canonicalJsonStringify(canonicalInspectionDefinitionContent(content));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Unique identity `(product task scope, definitionId, definitionVersion)`. */
export function inspectionDefinitionIdentity(record: DurableInspectionDefinition): string {
  const { taskScope, content } = record;
  return [
    taskScope.organId.value,
    taskScope.taskId.value,
    content.definition.definitionId,
    content.definition.definitionVersion,
  ].join('\u0000');
}

/** The stored digest must cover the record's own immutable content. */
export function assertDurableInspectionDefinition(record: DurableInspectionDefinition): void {
  try {
    validateDurableInspectionDefinition(record);
  } catch (error) {
    i2Error(error);
  }
  const expected = computeInspectionDefinitionDigest(record.content);
  if (record.definitionDigest !== expected) {
    throw new I2HistoryError('inspection definition digest does not cover its immutable content');
  }
}

/** Replaying one identity with the same content is idempotent; changed content conflicts. */
export function assertInspectionDefinitionUnchanged(
  existing: DurableInspectionDefinition,
  incoming: DurableInspectionDefinition,
): void {
  assertDurableInspectionDefinition(existing);
  assertDurableInspectionDefinition(incoming);
  if (inspectionDefinitionIdentity(existing) !== inspectionDefinitionIdentity(incoming)) {
    throw new I2HistoryError('inspection definition identity mismatch');
  }
  if (existing.definitionDigest !== incoming.definitionDigest) {
    throw new I2HistoryError('inspection definition identity already binds different immutable content');
  }
}

/** Product task-level occurrence stays separate from the execution scope and cycle. */
export function assertInspectionOccurrenceOpened(
  record: InspectionOccurrenceOpenedRecord,
  definition: DurableInspectionDefinition,
): void {
  try {
    validateInspectionOccurrenceOpenedRecord(record);
  } catch (error) {
    i2Error(error);
  }
  assertDurableInspectionDefinition(definition);
  const { occurrence } = record;
  if (
    occurrence.scope.organId.value !== definition.taskScope.organId.value
    || occurrence.scope.taskId.value !== definition.taskScope.taskId.value
  ) {
    throw new I2HistoryError('inspection occurrence scope does not match the committed definition task scope');
  }
  if (
    record.definition.definitionId !== definition.content.definition.definitionId
    || record.definition.definitionVersion !== definition.content.definition.definitionVersion
  ) {
    throw new I2HistoryError('inspection occurrence definition identity does not match the committed definition');
  }
  if (record.definitionDigest !== definition.definitionDigest) {
    throw new I2HistoryError('inspection occurrence definition digest does not match the committed definition');
  }
  if (record.executionScope.cycleId !== undefined && record.executionScope.cycleId.value !== record.cycleId) {
    throw new I2HistoryError('inspection execution scope cycle does not match the occurrence cycle id');
  }
}

/** One committed item result binds to the occurrence's definition and a declared check. */
export function assertInspectionItemResultRecord(
  record: InspectionItemResultRecord,
  definition: DurableInspectionDefinition,
): void {
  try {
    validateInspectionItemResultRecord(record);
  } catch (error) {
    i2Error(error);
  }
  assertDurableInspectionDefinition(definition);
  const { binding, delivery } = record;
  if (
    binding.occurrence.scope.organId.value !== definition.taskScope.organId.value
    || binding.occurrence.scope.taskId.value !== definition.taskScope.taskId.value
  ) {
    throw new I2HistoryError('inspection item result occurrence scope does not match the definition task scope');
  }
  if (
    binding.definition.definitionId !== definition.content.definition.definitionId
    || binding.definition.definitionVersion !== definition.content.definition.definitionVersion
  ) {
    throw new I2HistoryError('inspection item result definition identity does not match the committed definition');
  }
  if (binding.definitionDigest !== definition.definitionDigest) {
    throw new I2HistoryError('inspection item result definition digest does not match the committed definition');
  }
  const declared = new Set(definition.content.checks.map((check) => check.checkId));
  if (!declared.has(delivery.checkId)) {
    throw new I2HistoryError('inspection delivery references an undeclared check id');
  }
  if (binding.executionScope.cycleId !== undefined && binding.executionScope.cycleId.value !== binding.cycleId) {
    throw new I2HistoryError('inspection execution scope cycle does not match the occurrence cycle id');
  }
}

/**
 * A settlement binds its opening occurrence and definition. Missing checks stay
 * absent: the record holds only accepted item results and never fabricates one.
 */
export function assertInspectionOccurrenceSettled(
  record: InspectionOccurrenceSettledRecord,
  opened: InspectionOccurrenceOpenedRecord,
): void {
  try {
    validateInspectionOccurrenceSettledRecord(record);
    validateInspectionOccurrenceOpenedRecord(opened);
  } catch (error) {
    i2Error(error);
  }
  if (
    record.occurrence.occurrenceId !== opened.occurrence.occurrenceId
    || record.occurrence.scope.organId.value !== opened.occurrence.scope.organId.value
    || record.occurrence.scope.taskId.value !== opened.occurrence.scope.taskId.value
  ) {
    throw new I2HistoryError('inspection settlement occurrence does not match the opening occurrence');
  }
  if (
    record.definition.definitionId !== opened.definition.definitionId
    || record.definition.definitionVersion !== opened.definition.definitionVersion
  ) {
    throw new I2HistoryError('inspection settlement definition does not match the opening definition');
  }
}

/** The selected reviewer incarnation is the actual invoked instance for this task/assignment/epoch. */
export function assertMilestoneReviewResultRecord(record: MilestoneReviewResultRecord): void {
  try {
    validateMilestoneReviewResultRecord(record);
  } catch (error) {
    i2Error(error);
  }
  const { delivery, reviewAssignment, taskScope } = record;
  const reviewer = delivery.reviewer;
  if (reviewer.taskId.value !== taskScope.taskId.value) {
    throw new I2HistoryError('selected reviewer incarnation task does not match the review task');
  }
  if (reviewer.assignmentId !== reviewAssignment.assignmentId) {
    throw new I2HistoryError('selected reviewer incarnation assignment does not match the review assignment');
  }
  if (reviewer.executionEpoch !== reviewAssignment.executionEpoch) {
    throw new I2HistoryError('selected reviewer incarnation epoch does not match the review assignment epoch');
  }
  if (record.executionScope.cycleId !== undefined && record.executionScope.cycleId.value !== record.cycleId.value) {
    throw new I2HistoryError('milestone review execution scope cycle does not match the record cycle');
  }
}

/** Alignment binds the committed review to its checkpoint, context and aligned plan. */
export function assertMilestoneReviewAlignedRecord(
  record: MilestoneReviewAlignedRecord,
  review: MilestoneReviewResultRecord,
): void {
  try {
    validateMilestoneReviewAlignedRecord(record);
    validateMilestoneReviewResultRecord(review);
  } catch (error) {
    i2Error(error);
  }
  if (record.milestoneId !== review.milestoneId) {
    throw new I2HistoryError('aligned review milestone does not match the committed review');
  }
  if (record.cycleId.value !== review.cycleId.value) {
    throw new I2HistoryError('aligned review cycle does not match the committed review');
  }
}

/** A cycle closure binds its opening cycle; it never proves the task is complete. */
export function assertBusinessCycleClosedRecord(
  record: BusinessCycleClosedRecord,
  opened: BusinessCycleOpenedRecord,
): void {
  try {
    validateBusinessCycleClosedRecord(record);
    validateBusinessCycleOpenedRecord(opened);
  } catch (error) {
    i2Error(error);
  }
  if (record.cycleId.value !== opened.cycle.id.value) {
    throw new I2HistoryError('business cycle closure does not match the opening cycle');
  }
}
