import { ContractError } from './errors.js';
import { assertEvidenceRef, assertNextAction, assertScope } from './index.js';
import type {
  Cycle,
  CycleId,
  EvidenceRef,
  NextAction,
  ScopeRef,
  WorkAssignment,
  WorkResult,
} from './index.js';
import { validateTaskFlowBinding } from './task-flow.js';
import type { TaskFlowBinding } from './task-flow.js';
import type { TaskRuntimeIncarnation } from './framework.js';
import type {
  InspectionCheckDefinition,
  InspectionCheckDefinitionRef,
  InspectionCheckId,
  InspectionDefinitionVersion,
  InspectionJudgment,
  InspectionOccurrenceRef,
} from './inspection.js';
import { validateInspectionCheckDefinition, validateInspectionOccurrenceRef } from './inspection.js';
import type { ReviewAssignment, ReviewResult } from './review-data.js';

/** Accepted common Journal commit receipt. Later Journal consumers import this. */
export interface JournalCommitRef {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
}

/** Scheduled slot reference kept separate from the product task occurrence. */
export interface ScheduleOccurrenceRef {
  readonly subscriptionId: string;
  readonly scheduleRevision: number;
  readonly ordinal: number;
  readonly occurrenceId: string;
}

export interface InspectionExecutableCheck {
  readonly checkId: InspectionCheckId;
  readonly criterion: string;
  readonly inputRefs: readonly string[];
}

export interface InspectionDefinitionContent {
  readonly definition: InspectionCheckDefinition;
  readonly checks: readonly InspectionExecutableCheck[];
}

export interface DurableInspectionDefinition {
  readonly kind: 'inspection-definition';
  readonly schemaVersion: 1;
  readonly taskScope: InspectionOccurrenceRef['scope'];
  readonly content: InspectionDefinitionContent;
  readonly definitionDigest: string;
  readonly planRevisionCommitRef: JournalCommitRef;
  readonly createdAt: string;
}

export type InspectionExecutionOutcome =
  | {
      readonly status: 'completed';
      readonly judgment: InspectionJudgment;
    }
  | {
      readonly status: 'failed' | 'blocked' | 'cancelled' | 'unknown';
      readonly reason: string;
      readonly judgment?: InspectionJudgment;
    };

export interface InspectionItemDelivery {
  readonly checkId: InspectionCheckId;
  readonly resultId: string;
  readonly attempt: number;
  readonly outcome: InspectionExecutionOutcome;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly completedAt: string;
}

export interface InspectionExecutionBinding {
  readonly occurrence: InspectionOccurrenceRef;
  readonly executionScope: ScopeRef;
  readonly cycleId: string;
  readonly executionEpoch: number;
  readonly definition: InspectionCheckDefinitionRef;
  readonly definitionCommitRef: JournalCommitRef;
  readonly definitionDigest: string;
  readonly cycleOpenedCommitRef: JournalCommitRef;
  readonly scheduleOccurrenceRef: ScheduleOccurrenceRef | null;
}

export interface InspectionItemResultRecord {
  readonly kind: 'inspection-item-result';
  readonly schemaVersion: 1;
  readonly binding: InspectionExecutionBinding;
  readonly delivery: InspectionItemDelivery;
}

export interface InspectionOccurrenceOpenedRecord {
  readonly kind: 'inspection-occurrence-opened';
  readonly schemaVersion: 1;
  readonly logicalTurnId?: string;
  readonly occurrence: InspectionOccurrenceRef;
  readonly executionScope: ScopeRef;
  readonly cycleId: string;
  readonly executionEpoch: number;
  readonly definition: InspectionCheckDefinitionRef;
  readonly definitionCommitRef: JournalCommitRef;
  readonly definitionDigest: string;
  readonly planRevisionCommitRef: JournalCommitRef;
  readonly cycleOpenedCommitRef: JournalCommitRef;
  readonly scheduleOccurrenceRef: ScheduleOccurrenceRef | null;
  readonly openedAt: string;
}

export interface InspectionOccurrenceSettledRecord {
  readonly kind: 'inspection-occurrence-settled';
  readonly schemaVersion: 1;
  readonly openingCommitRef: JournalCommitRef;
  readonly occurrence: InspectionOccurrenceRef;
  readonly definition: InspectionCheckDefinitionRef;
  readonly itemResultCommitRefs: readonly JournalCommitRef[];
  readonly outcome: InspectionExecutionOutcome;
  readonly checkpointCommitRef: JournalCommitRef;
  readonly settledAt: string;
}

export interface BusinessCycleOpenedRecord {
  readonly kind: 'business-cycle-opened';
  readonly schemaVersion: 1;
  readonly cycle: Cycle;
  readonly taskFlow: TaskFlowBinding;
  readonly planRevisionCommitRef: JournalCommitRef;
  readonly previousCycleCommitRef: JournalCommitRef | null;
  readonly openedAt: string;
  readonly openingReason: string;
  readonly scheduleOccurrenceRef?: ScheduleOccurrenceRef;
  readonly inspectionOccurrenceId?: string;
}

export type SelectedReviewer = TaskRuntimeIncarnation;

export interface ReviewOutput {
  readonly text: string;
  readonly artifactRef: string | null;
  readonly artifactDigest: string | null;
}

export interface ReviewDelivery {
  readonly result: ReviewResult;
  readonly reviewer: SelectedReviewer;
  readonly output: ReviewOutput;
  readonly completedAt: string;
}

export interface MilestoneReviewResultRecord {
  readonly kind: 'milestone-review-result';
  readonly schemaVersion: 1;
  readonly milestoneId: string;
  readonly cycleId: CycleId;
  readonly taskScope: InspectionOccurrenceRef['scope'];
  readonly executionScope: ScopeRef;
  readonly planRevisionCommitRef: JournalCommitRef;
  readonly reviewAssignment: ReviewAssignment;
  readonly delivery: ReviewDelivery;
  readonly completedAt: string;
}

export interface MilestoneReviewAlignedRecord {
  readonly kind: 'milestone-review-aligned';
  readonly schemaVersion: 1;
  readonly reviewCommitRef: JournalCommitRef;
  readonly milestoneId: string;
  readonly cycleId: CycleId;
  readonly checkpointCommitRef: JournalCommitRef;
  readonly turnClosureRef: string;
  readonly contextCommitRef: JournalCommitRef;
  readonly alignmentRef: string;
  readonly alignedPlanRevisionCommitRef: JournalCommitRef;
}

/** Business-cycle outcome classification. It is not task completion and reuses NextAction kinds. */
export type BusinessCycleOutcome = NextAction['kind'];

export interface BusinessCycleClosedRecord {
  readonly kind: 'business-cycle-closed';
  readonly schemaVersion: 1;
  readonly openedCommitRef: JournalCommitRef;
  readonly cycleId: CycleId;
  readonly outcome: BusinessCycleOutcome;
  readonly checkpointCommitRef: JournalCommitRef;
  readonly milestoneAlignmentCommitRefs: readonly JournalCommitRef[];
  readonly inspectionSettlementCommitRef?: JournalCommitRef;
  readonly next: NextAction;
  readonly closedAt: string;
}

export type I2Record =
  | DurableInspectionDefinition
  | InspectionItemResultRecord
  | InspectionOccurrenceOpenedRecord
  | InspectionOccurrenceSettledRecord
  | BusinessCycleOpenedRecord
  | MilestoneReviewResultRecord
  | MilestoneReviewAlignedRecord
  | BusinessCycleClosedRecord;

export interface InspectionCheckPort {
  run(input: {
    readonly binding: InspectionExecutionBinding;
    readonly check: InspectionExecutableCheck;
    readonly assignment: WorkAssignment;
  }): Promise<InspectionItemDelivery>;
}

export interface InspectionAcceptedCheckPort extends InspectionCheckPort {
  accept(input: {
    readonly binding: InspectionExecutionBinding;
    readonly check: InspectionExecutableCheck;
    readonly assignment: WorkAssignment;
    readonly result: WorkResult;
    readonly delivery: InspectionItemDelivery;
  }): Promise<InspectionItemDelivery>;
}

export interface I2JournalPort {
  commit(record: I2Record): Promise<JournalCommitRef>;
  read(taskScope: ScopeRef, ref: JournalCommitRef): Promise<I2Record>;
  list(input: {
    readonly taskScope: ScopeRef;
    readonly kinds: readonly I2Record['kind'][];
    readonly cycleId?: string;
    readonly inspectionOccurrenceId?: string;
    readonly definitionId?: string;
    readonly definitionVersion?: InspectionDefinitionVersion;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly entries: readonly {
      readonly record: I2Record;
      readonly commitRef: JournalCommitRef;
    }[];
    readonly nextCursor?: string;
  }>;
}

export interface InspectionOccurrenceDetails {
  readonly openingCommitRef: JournalCommitRef;
  readonly definitionCommitRef: JournalCommitRef;
  readonly settlementCommitRef: JournalCommitRef | null;
  readonly deliveries: readonly InspectionItemDelivery[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

function assertEvidenceRefs(refs: readonly EvidenceRef[], label: string): void {
  if (!Array.isArray(refs)) throw new ContractError(`${label} must be an array`);
  for (const ref of refs) assertEvidenceRef(ref);
}

function assertTaskLevelScope(scope: ScopeRef, label: string): void {
  if (!isObject(scope.organId)) throw new ContractError(`${label} requires an organ scope`);
  assertScope(scope.organId, 'organ');
  if (!isObject(scope.taskId)) throw new ContractError(`${label} requires a task scope`);
  assertScope(scope.taskId, 'task');
  if (scope.cycleId !== undefined || scope.operationId !== undefined) {
    throw new ContractError(`${label} must be task-level`);
  }
}

function assertTaskScopedRef(scope: ScopeRef, label: string): void {
  if (!isObject(scope.organId)) throw new ContractError(`${label} requires an organ scope`);
  assertScope(scope.organId, 'organ');
  if (!isObject(scope.taskId)) throw new ContractError(`${label} requires a task scope`);
  assertScope(scope.taskId, 'task');
  if (scope.cycleId !== undefined) assertScope(scope.cycleId, 'cycle');
  if (scope.operationId !== undefined) assertScope(scope.operationId, 'operation');
}

export function validateJournalCommitRef(ref: JournalCommitRef): void {
  if (!isObject(ref)) throw new ContractError('journal commit ref must be an object');
  nonEmpty(ref.commitId, 'journal commit id');
  positiveInteger(ref.journalSeq, 'journal seq');
  nonEmpty(ref.recordDigest, 'journal record digest');
}

export function validateScheduleOccurrenceRef(ref: ScheduleOccurrenceRef): void {
  if (!isObject(ref)) throw new ContractError('schedule occurrence ref must be an object');
  nonEmpty(ref.subscriptionId, 'schedule subscription id');
  positiveInteger(ref.scheduleRevision, 'schedule revision');
  positiveInteger(ref.ordinal, 'schedule ordinal');
  nonEmpty(ref.occurrenceId, 'schedule occurrence id');
}

export function validateInspectionExecutableCheck(check: InspectionExecutableCheck): void {
  if (!isObject(check)) throw new ContractError('inspection executable check must be an object');
  nonEmpty(check.checkId, 'inspection check id');
  nonEmpty(check.criterion, 'inspection check criterion');
  if (!Array.isArray(check.inputRefs)) throw new ContractError('inspection check inputRefs must be an array');
  for (const ref of check.inputRefs) nonEmpty(ref, 'inspection check input ref');
}

/** Recipe check IDs must equal the declared check-ID set, once each. Strings stay verbatim. */
export function validateInspectionDefinitionContent(content: InspectionDefinitionContent): void {
  if (!isObject(content)) throw new ContractError('inspection definition content must be an object');
  validateInspectionCheckDefinition(content.definition);
  if (!Array.isArray(content.checks) || content.checks.length === 0) {
    throw new ContractError('inspection definition content must declare executable checks');
  }
  const declared = content.definition.checkItems.map((item) => item.checkId);
  const declaredSet = new Set(declared);
  const recipeIds: string[] = [];
  for (const check of content.checks) {
    validateInspectionExecutableCheck(check);
    if (!declaredSet.has(check.checkId)) {
      throw new ContractError('inspection recipe references an undeclared check id');
    }
    recipeIds.push(check.checkId);
  }
  if (recipeIds.length !== declared.length || new Set(recipeIds).size !== recipeIds.length) {
    throw new ContractError('inspection recipe checks must match the declared check-id set once each');
  }
}

/**
 * `completed` carries the actual observed judgment. Failure keeps its explicit
 * reason and may retain a judgment observed before failure. No status, reason,
 * summary, or serialized value is coerced into a judgment.
 */
export function validateInspectionExecutionOutcome(outcome: InspectionExecutionOutcome): void {
  if (!isObject(outcome)) throw new ContractError('inspection execution outcome must be an object');
  if (outcome.status === 'completed') {
    nonEmpty(outcome.judgment, 'completed inspection judgment');
    return;
  }
  if (
    outcome.status !== 'failed'
    && outcome.status !== 'blocked'
    && outcome.status !== 'cancelled'
    && outcome.status !== 'unknown'
  ) {
    throw new ContractError('inspection execution outcome status is invalid');
  }
  nonEmpty(outcome.reason, 'inspection execution failure reason');
  if (outcome.judgment !== undefined) nonEmpty(outcome.judgment, 'inspection observed judgment');
}

export function validateInspectionItemDelivery(delivery: InspectionItemDelivery): void {
  if (!isObject(delivery)) throw new ContractError('inspection item delivery must be an object');
  nonEmpty(delivery.checkId, 'inspection delivery check id');
  nonEmpty(delivery.resultId, 'inspection delivery result id');
  positiveInteger(delivery.attempt, 'inspection delivery attempt');
  validateInspectionExecutionOutcome(delivery.outcome);
  assertEvidenceRefs(delivery.evidenceRefs, 'inspection delivery evidenceRefs');
  nonEmpty(delivery.completedAt, 'inspection delivery completedAt');
}

export function validateDurableInspectionDefinition(record: DurableInspectionDefinition): void {
  if (!isObject(record)) throw new ContractError('durable inspection definition must be an object');
  if (record.kind !== 'inspection-definition') throw new ContractError('durable inspection definition kind is invalid');
  if (record.schemaVersion !== 1) throw new ContractError('durable inspection definition schemaVersion must be 1');
  assertTaskLevelScope(record.taskScope, 'durable inspection definition scope');
  validateInspectionDefinitionContent(record.content);
  nonEmpty(record.definitionDigest, 'inspection definition digest');
  validateJournalCommitRef(record.planRevisionCommitRef);
  nonEmpty(record.createdAt, 'inspection definition createdAt');
}

export function validateInspectionExecutionBinding(binding: InspectionExecutionBinding): void {
  if (!isObject(binding)) throw new ContractError('inspection execution binding must be an object');
  validateInspectionOccurrenceRef(binding.occurrence);
  assertTaskScopedRef(binding.executionScope, 'inspection execution scope');
  nonEmpty(binding.cycleId, 'inspection execution cycle id');
  positiveInteger(binding.executionEpoch, 'inspection execution epoch');
  nonEmpty(binding.definition.definitionId, 'inspection definition id');
  nonEmpty(binding.definition.definitionVersion, 'inspection definition version');
  validateJournalCommitRef(binding.definitionCommitRef);
  nonEmpty(binding.definitionDigest, 'inspection definition digest');
  validateJournalCommitRef(binding.cycleOpenedCommitRef);
  if (binding.scheduleOccurrenceRef !== null) validateScheduleOccurrenceRef(binding.scheduleOccurrenceRef);
}

export function validateInspectionItemResultRecord(record: InspectionItemResultRecord): void {
  if (!isObject(record)) throw new ContractError('inspection item result record must be an object');
  if (record.kind !== 'inspection-item-result') throw new ContractError('inspection item result kind is invalid');
  if (record.schemaVersion !== 1) throw new ContractError('inspection item result schemaVersion must be 1');
  validateInspectionExecutionBinding(record.binding);
  validateInspectionItemDelivery(record.delivery);
}

export function validateInspectionOccurrenceOpenedRecord(record: InspectionOccurrenceOpenedRecord): void {
  if (!isObject(record)) throw new ContractError('inspection occurrence opened record must be an object');
  if (record.kind !== 'inspection-occurrence-opened') throw new ContractError('inspection occurrence opened kind is invalid');
  if (record.schemaVersion !== 1) throw new ContractError('inspection occurrence opened schemaVersion must be 1');
  validateInspectionOccurrenceRef(record.occurrence);
  if (record.logicalTurnId !== undefined) nonEmpty(record.logicalTurnId, 'inspection logical turn id');
  assertTaskScopedRef(record.executionScope, 'inspection occurrence execution scope');
  nonEmpty(record.cycleId, 'inspection occurrence cycle id');
  positiveInteger(record.executionEpoch, 'inspection occurrence execution epoch');
  nonEmpty(record.definition.definitionId, 'inspection definition id');
  nonEmpty(record.definition.definitionVersion, 'inspection definition version');
  validateJournalCommitRef(record.definitionCommitRef);
  nonEmpty(record.definitionDigest, 'inspection definition digest');
  validateJournalCommitRef(record.planRevisionCommitRef);
  validateJournalCommitRef(record.cycleOpenedCommitRef);
  if (record.scheduleOccurrenceRef !== null) validateScheduleOccurrenceRef(record.scheduleOccurrenceRef);
  nonEmpty(record.openedAt, 'inspection occurrence openedAt');
}

export function validateInspectionOccurrenceSettledRecord(record: InspectionOccurrenceSettledRecord): void {
  if (!isObject(record)) throw new ContractError('inspection occurrence settled record must be an object');
  if (record.kind !== 'inspection-occurrence-settled') throw new ContractError('inspection occurrence settled kind is invalid');
  if (record.schemaVersion !== 1) throw new ContractError('inspection occurrence settled schemaVersion must be 1');
  validateJournalCommitRef(record.openingCommitRef);
  validateInspectionOccurrenceRef(record.occurrence);
  nonEmpty(record.definition.definitionId, 'inspection definition id');
  nonEmpty(record.definition.definitionVersion, 'inspection definition version');
  if (!Array.isArray(record.itemResultCommitRefs)) {
    throw new ContractError('inspection occurrence settled itemResultCommitRefs must be an array');
  }
  for (const ref of record.itemResultCommitRefs) validateJournalCommitRef(ref);
  validateInspectionExecutionOutcome(record.outcome);
  validateJournalCommitRef(record.checkpointCommitRef);
  nonEmpty(record.settledAt, 'inspection occurrence settledAt');
}

export function validateBusinessCycleOpenedRecord(record: BusinessCycleOpenedRecord): void {
  if (!isObject(record)) throw new ContractError('business cycle opened record must be an object');
  if (record.kind !== 'business-cycle-opened') throw new ContractError('business cycle opened kind is invalid');
  if (record.schemaVersion !== 1) throw new ContractError('business cycle opened schemaVersion must be 1');
  if (!isObject(record.cycle)) throw new ContractError('business cycle opened requires a cycle');
  assertScope(record.cycle.id, 'cycle');
  validateTaskFlowBinding(record.taskFlow);
  validateJournalCommitRef(record.planRevisionCommitRef);
  if (record.previousCycleCommitRef !== null) validateJournalCommitRef(record.previousCycleCommitRef);
  nonEmpty(record.openedAt, 'business cycle openedAt');
  nonEmpty(record.openingReason, 'business cycle opening reason');
  if (record.scheduleOccurrenceRef !== undefined) validateScheduleOccurrenceRef(record.scheduleOccurrenceRef);
  if (record.inspectionOccurrenceId !== undefined) nonEmpty(record.inspectionOccurrenceId, 'inspection occurrence id');
}

export function validateSelectedReviewer(reviewer: SelectedReviewer): void {
  if (!isObject(reviewer)) throw new ContractError('selected reviewer incarnation must be an object');
  nonEmpty(reviewer.runtimeId, 'reviewer runtime id');
  positiveInteger(reviewer.generation, 'reviewer generation');
  nonEmpty(reviewer.agentInstanceId, 'reviewer agent instance id');
  nonEmpty(reviewer.roleId, 'reviewer role id');
  assertScope(reviewer.taskId, 'task');
  nonEmpty(reviewer.assignmentId, 'reviewer assignment id');
  positiveInteger(reviewer.executionEpoch, 'reviewer execution epoch');
}

export function validateReviewOutput(output: ReviewOutput): void {
  if (!isObject(output)) throw new ContractError('review output must be an object');
  nonEmpty(output.text, 'review output text');
  const hasRef = output.artifactRef !== null;
  const hasDigest = output.artifactDigest !== null;
  if (hasRef !== hasDigest) throw new ContractError('review output artifact ref and digest must be paired');
  if (hasRef) nonEmpty(output.artifactRef, 'review output artifact ref');
  if (hasDigest) nonEmpty(output.artifactDigest, 'review output artifact digest');
}

export function validateReviewDelivery(delivery: ReviewDelivery): void {
  if (!isObject(delivery)) throw new ContractError('review delivery must be an object');
  if (!isObject(delivery.result)) throw new ContractError('review delivery result must be an object');
  validateSelectedReviewer(delivery.reviewer);
  validateReviewOutput(delivery.output);
  nonEmpty(delivery.completedAt, 'review delivery completedAt');
}

export function validateMilestoneReviewResultRecord(record: MilestoneReviewResultRecord): void {
  if (!isObject(record)) throw new ContractError('milestone review result record must be an object');
  if (record.kind !== 'milestone-review-result') throw new ContractError('milestone review result kind is invalid');
  if (record.schemaVersion !== 1) throw new ContractError('milestone review result schemaVersion must be 1');
  nonEmpty(record.milestoneId, 'milestone id');
  assertScope(record.cycleId, 'cycle');
  assertTaskLevelScope(record.taskScope, 'milestone review task scope');
  assertTaskScopedRef(record.executionScope, 'milestone review execution scope');
  validateJournalCommitRef(record.planRevisionCommitRef);
  if (!isObject(record.reviewAssignment)) throw new ContractError('milestone review requires a review assignment');
  validateReviewDelivery(record.delivery);
  nonEmpty(record.completedAt, 'milestone review completedAt');
}

export function validateMilestoneReviewAlignedRecord(record: MilestoneReviewAlignedRecord): void {
  if (!isObject(record)) throw new ContractError('milestone review aligned record must be an object');
  if (record.kind !== 'milestone-review-aligned') throw new ContractError('milestone review aligned kind is invalid');
  if (record.schemaVersion !== 1) throw new ContractError('milestone review aligned schemaVersion must be 1');
  validateJournalCommitRef(record.reviewCommitRef);
  nonEmpty(record.milestoneId, 'milestone id');
  assertScope(record.cycleId, 'cycle');
  validateJournalCommitRef(record.checkpointCommitRef);
  nonEmpty(record.turnClosureRef, 'turn closure ref');
  validateJournalCommitRef(record.contextCommitRef);
  nonEmpty(record.alignmentRef, 'alignment ref');
  validateJournalCommitRef(record.alignedPlanRevisionCommitRef);
}

export function validateBusinessCycleClosedRecord(record: BusinessCycleClosedRecord): void {
  if (!isObject(record)) throw new ContractError('business cycle closed record must be an object');
  if (record.kind !== 'business-cycle-closed') throw new ContractError('business cycle closed kind is invalid');
  if (record.schemaVersion !== 1) throw new ContractError('business cycle closed schemaVersion must be 1');
  validateJournalCommitRef(record.openedCommitRef);
  assertScope(record.cycleId, 'cycle');
  if (
    record.outcome !== 'continue'
    && record.outcome !== 'wait'
    && record.outcome !== 'stop'
    && record.outcome !== 'recover'
  ) {
    throw new ContractError('business cycle outcome is invalid');
  }
  validateJournalCommitRef(record.checkpointCommitRef);
  if (!Array.isArray(record.milestoneAlignmentCommitRefs)) {
    throw new ContractError('business cycle closed milestoneAlignmentCommitRefs must be an array');
  }
  for (const ref of record.milestoneAlignmentCommitRefs) validateJournalCommitRef(ref);
  if (record.inspectionSettlementCommitRef !== undefined) {
    validateJournalCommitRef(record.inspectionSettlementCommitRef);
  }
  assertNextAction(record.next);
  nonEmpty(record.closedAt, 'business cycle closedAt');
}

export function validateI2Record(record: I2Record): void {
  switch (record.kind) {
    case 'inspection-definition':
      return validateDurableInspectionDefinition(record);
    case 'inspection-item-result':
      return validateInspectionItemResultRecord(record);
    case 'inspection-occurrence-opened':
      return validateInspectionOccurrenceOpenedRecord(record);
    case 'inspection-occurrence-settled':
      return validateInspectionOccurrenceSettledRecord(record);
    case 'business-cycle-opened':
      return validateBusinessCycleOpenedRecord(record);
    case 'milestone-review-result':
      return validateMilestoneReviewResultRecord(record);
    case 'milestone-review-aligned':
      return validateMilestoneReviewAlignedRecord(record);
    case 'business-cycle-closed':
      return validateBusinessCycleClosedRecord(record);
  }
}
