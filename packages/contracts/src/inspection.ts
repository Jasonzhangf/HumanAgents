import { ContractError } from './errors.js';
import { assertEvidenceRef, assertScope } from './index.js';
import type { EvidenceRef, ScopeRef, TaskId } from './index.js';

/**
 * Inspection comparison contract (UX I/C4).
 *
 * Two compatible occurrences are compared by check-item ID. Ordering of check
 * items inside the two definitions is not identity, and no execution, retry or
 * append happens anywhere in this contract. The read-only consumer that loads
 * the two occurrences is a runtime adapter; this module only defines provider
 * and adapter neutral shapes.
 */

export type InspectionCheckId = string;
export type InspectionOccurrenceId = string;
export type InspectionDefinitionId = string;
export type InspectionDefinitionVersion = string;
export type InspectionJudgment = string;

export const INSPECTION_ITEM_STATES = ['completed', 'failed', 'missing'] as const;
export type InspectionItemState = (typeof INSPECTION_ITEM_STATES)[number];

export interface InspectionCheckItem {
  readonly checkId: InspectionCheckId;
}

/** Stable identity of one inspection definition generation. */
export interface InspectionCheckDefinitionRef {
  readonly definitionId: InspectionDefinitionId;
  readonly definitionVersion: InspectionDefinitionVersion;
}

export interface InspectionTargetRef {
  readonly targetRef: string;
  readonly sourceRef: string;
}

export interface InspectionCheckDefinition extends InspectionCheckDefinitionRef {
  readonly target: InspectionTargetRef;
  readonly checkItems: readonly InspectionCheckItem[];
}

/**
 * Identity of one inspection occurrence. It is task-level and is separate from
 * execution attempts and retries; retry identity is not part of this ref.
 */
export interface InspectionOccurrenceRef {
  readonly scope: ScopeRef & { readonly taskId: NonNullable<ScopeRef['taskId']> };
  readonly occurrenceId: InspectionOccurrenceId;
}

export interface InspectionItemResult {
  readonly checkId: InspectionCheckId;
  readonly state: InspectionItemState;
  readonly judgment?: InspectionJudgment;
  readonly resultRef?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface InspectionOccurrenceRecord {
  readonly occurrence: InspectionOccurrenceRef;
  readonly definition: InspectionCheckDefinition;
  readonly results: readonly InspectionItemResult[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

/** Occurrence as read from history, without resolved results. */
export interface InspectionOccurrenceSource {
  readonly occurrence: InspectionOccurrenceRef;
  readonly definition: InspectionCheckDefinitionRef | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface InspectionComparisonBasis {
  readonly taskId: TaskId;
  readonly definition: InspectionCheckDefinitionRef;
  readonly target: InspectionTargetRef;
}

export type InspectionComparisonReason =
  | 'task-scope-mismatch'
  | 'before-occurrence-missing'
  | 'after-occurrence-missing'
  | 'definition-mismatch'
  | 'target-mismatch';

export type InspectionItemChange = 'unchanged' | 'changed' | 'not-compared';

export interface InspectionItemComparison {
  readonly checkId: InspectionCheckId;
  readonly before: InspectionItemResult;
  readonly after: InspectionItemResult;
  readonly change: InspectionItemChange;
}

export type InspectionComparisonResult =
  | {
      readonly comparable: true;
      readonly before: InspectionOccurrenceSource;
      readonly after: InspectionOccurrenceSource;
      readonly basis: InspectionComparisonBasis;
      readonly items: readonly InspectionItemComparison[];
    }
  | {
      readonly comparable: false;
      readonly reason: InspectionComparisonReason;
      readonly before: InspectionOccurrenceSource;
      readonly after: InspectionOccurrenceSource;
      readonly items: readonly [];
    };

export interface InspectionComparisonRequest {
  readonly before: InspectionOccurrenceRef;
  readonly after: InspectionOccurrenceRef;
}

/** Read-only history source for inspection occurrences. */
export interface InspectionOccurrenceHistoryPort {
  readOccurrence(ref: InspectionOccurrenceRef): Promise<InspectionOccurrenceRecord | null>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new ContractError(`${label} must not contain duplicates`);
}

function assertEvidenceRefs(refs: readonly EvidenceRef[], label: string): void {
  if (!Array.isArray(refs)) throw new ContractError(`${label} must be an array`);
  for (const ref of refs) assertEvidenceRef(ref);
}

export function validateInspectionOccurrenceRef(ref: InspectionOccurrenceRef): void {
  if (!isObject(ref)) throw new ContractError('inspection occurrence ref must be an object');
  if (!isObject(ref.scope)) throw new ContractError('inspection occurrence scope must be an object');
  const scope = ref.scope as ScopeRef;
  if (!isObject(scope.organId)) throw new ContractError('inspection occurrence requires an organ scope');
  assertScope(scope.organId, 'organ');
  if (!isObject(scope.taskId)) throw new ContractError('inspection occurrence requires a task scope');
  assertScope(scope.taskId, 'task');
  if (scope.cycleId !== undefined || scope.operationId !== undefined) {
    throw new ContractError('inspection occurrence scope must be task-level');
  }
  requireText(ref.occurrenceId, 'inspection occurrence id');
}

export function validateInspectionCheckDefinition(definition: InspectionCheckDefinition): void {
  if (!isObject(definition)) throw new ContractError('inspection check definition must be an object');
  requireText(definition.definitionId, 'inspection definition id');
  requireText(definition.definitionVersion, 'inspection definition version');
  if (!isObject(definition.target)) throw new ContractError('inspection definition target must be an object');
  requireText(definition.target.targetRef, 'inspection target ref');
  requireText(definition.target.sourceRef, 'inspection target source ref');
  if (!Array.isArray(definition.checkItems) || definition.checkItems.length === 0) {
    throw new ContractError('inspection definition must declare check items');
  }
  const checkIds = definition.checkItems.map((item) => {
    if (!isObject(item)) throw new ContractError('inspection check item must be an object');
    requireText(item.checkId, 'inspection check id');
    return item.checkId;
  });
  requireUnique(checkIds, 'inspection check ids');
}

export function validateInspectionItemResult(result: InspectionItemResult): void {
  if (!isObject(result)) throw new ContractError('inspection item result must be an object');
  requireText(result.checkId, 'inspection result check id');
  if (!INSPECTION_ITEM_STATES.includes(result.state)) {
    throw new ContractError('inspection item state is invalid');
  }
  if (result.state === 'completed') {
    requireText(result.judgment, 'inspection completed result judgment');
  }
  if (result.state === 'missing' && (result.judgment !== undefined || result.resultRef !== undefined)) {
    throw new ContractError('inspection missing result cannot carry a judgment or result ref');
  }
  if (result.judgment !== undefined) requireText(result.judgment, 'inspection result judgment');
  if (result.resultRef !== undefined) requireText(result.resultRef, 'inspection result ref');
  assertEvidenceRefs(result.evidenceRefs, 'inspection item result evidenceRefs');
}

export function validateInspectionOccurrenceRecord(record: InspectionOccurrenceRecord): void {
  if (!isObject(record)) throw new ContractError('inspection occurrence record must be an object');
  validateInspectionOccurrenceRef(record.occurrence);
  validateInspectionCheckDefinition(record.definition);
  if (!Array.isArray(record.results)) throw new ContractError('inspection occurrence results must be an array');
  const declaredCheckIds = new Set(record.definition.checkItems.map((item) => item.checkId));
  const resultCheckIds: string[] = [];
  for (const result of record.results) {
    validateInspectionItemResult(result);
    if (!declaredCheckIds.has(result.checkId)) {
      throw new ContractError('inspection result references an undeclared check id');
    }
    resultCheckIds.push(result.checkId);
  }
  requireUnique(resultCheckIds, 'inspection result check ids');
  assertEvidenceRefs(record.evidenceRefs, 'inspection occurrence evidenceRefs');
}
