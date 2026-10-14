import { createHash } from 'node:crypto';
import { JsonlOrganJournal, type JournalRecord } from '../../adapters/jsonl/src/index.js';
import {
  assertScope,
  canonicalJsonStringify,
  validateBusinessCycleOpenedRecord,
  validateI2Record,
  validateJournalCommitRef,
  type BusinessCycleOpenedRecord,
  type DurableInspectionDefinition,
  type I2JournalPort,
  type I2Record,
  type InspectionItemResultRecord,
  type InspectionOccurrenceOpenedRecord,
  type InspectionOccurrenceSettledRecord,
  type JournalCommitRef,
  type MilestoneReviewAlignedRecord,
  type MilestoneReviewResultRecord,
  type ScopeRef,
} from '../../contracts/src/index.js';
import {
  assertBusinessCycleClosedRecord,
  assertDurableInspectionDefinition,
  assertInspectionDefinitionUnchanged,
  assertInspectionItemResultRecord,
  assertInspectionOccurrenceOpened,
  assertInspectionOccurrenceSettled,
  assertMilestoneReviewAlignedRecord,
  assertMilestoneReviewResultRecord,
  inspectionDefinitionIdentity,
} from '../../core/src/index.js';
import { scopeContains } from '../../runtime/src/events/index.js';
import { AppLifecycleError } from './errors.js';

/**
 * Typed payload marker for the I2 product-history records that live in the
 * existing Organ Journal event carrier. The marker keeps I2 control authority
 * separate from business payloads, UI event logs and unrelated Journal events.
 */
export const I2_JOURNAL_PAYLOAD_KIND = 'i2-history';

function i2Error(code: string, message: string, nextAction: string): AppLifecycleError {
  return new AppLifecycleError(code, message, nextAction, 'app-i2-journal');
}

function i2Failure(error: unknown): never {
  if (error instanceof AppLifecycleError) throw error;
  throw i2Error(
    'i2-journal-record-invalid',
    error instanceof Error ? error.message : 'invalid i2 history record',
    'repair the record or its referenced authority before committing I2 history',
  );
}

function assertTaskScope(scope: ScopeRef, label: string): void {
  if (scope === null || typeof scope !== 'object') {
    throw i2Error('i2-journal-task-scope-required', `${label} must be a scope object`, 'provide the exact product task scope');
  }
  assertScope(scope.organId, 'organ');
  if (scope.taskId === undefined) {
    throw i2Error('i2-journal-task-scope-required', `${label} must be task-level`, 'provide the exact product task scope');
  }
  assertScope(scope.taskId, 'task');
}

function canonicalScope(scope: ScopeRef): Record<string, unknown> {
  return {
    organId: { scope: scope.organId.scope, value: scope.organId.value },
    taskId: scope.taskId ? { scope: scope.taskId.scope, value: scope.taskId.value } : null,
  };
}

/** Product task-level authority scope. Cycle/operation detail is not identity here. */
function taskScopeOf(scope: ScopeRef, label: string): ScopeRef {
  if (scope.taskId === undefined) {
    throw i2Error('i2-journal-task-scope-required', `${label} requires a task scope`, 'provide the exact product task scope');
  }
  return { organId: scope.organId, taskId: scope.taskId };
}

function i2RecordFromJournalRecord(record: JournalRecord): I2Record | null {
  const payload = record.payload;
  if (payload?.['kind'] !== I2_JOURNAL_PAYLOAD_KIND) return null;
  const value = payload['record'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw i2Error(
      'i2-journal-record-corrupt',
      `journal record ${record.seq} carries a malformed I2 history body`,
      'preserve the Organ Journal and repair the committed I2 record',
    );
  }
  return value as I2Record;
}

function journalCommitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) {
    throw i2Error(
      'i2-journal-record-uncommitted',
      `journal record ${record.seq} carries no commit id`,
      'commit the I2 record through its typed identity before reading its reference',
    );
  }
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

async function verifiedJournalRecords(journal: JsonlOrganJournal): Promise<readonly JournalRecord[]> {
  const verification = await journal.verify();
  if (!verification.valid) {
    throw i2Error(
      'i2-journal-corrupt',
      verification.error ?? 'I2 journal is invalid',
      'preserve the Organ Journal and repair its committed history before reading I2 history',
    );
  }
  return verification.records;
}

function recordKind(record: I2Record): I2Record['kind'] {
  return record.kind;
}

function recordCycleId(record: I2Record): string | undefined {
  switch (record.kind) {
    case 'business-cycle-opened': return record.cycle.id.value;
    case 'inspection-occurrence-opened': return record.cycleId;
    case 'inspection-item-result': return record.binding.cycleId;
    case 'milestone-review-result': return record.cycleId.value;
    case 'milestone-review-aligned': return record.cycleId.value;
    case 'business-cycle-closed': return record.cycleId.value;
    default: return undefined;
  }
}

function recordInspectionOccurrenceId(record: I2Record): string | undefined {
  switch (record.kind) {
    case 'business-cycle-opened': return record.inspectionOccurrenceId;
    case 'inspection-occurrence-opened': return record.occurrence.occurrenceId;
    case 'inspection-item-result': return record.binding.occurrence.occurrenceId;
    case 'inspection-occurrence-settled': return record.occurrence.occurrenceId;
    default: return undefined;
  }
}

function recordDefinitionIdentity(record: I2Record): { readonly definitionId: string; readonly definitionVersion: string } | undefined {
  switch (record.kind) {
    case 'inspection-definition':
      return {
        definitionId: record.content.definition.definitionId,
        definitionVersion: record.content.definition.definitionVersion,
      };
    case 'inspection-occurrence-opened':
      return { definitionId: record.definition.definitionId, definitionVersion: record.definition.definitionVersion };
    case 'inspection-item-result':
      return { definitionId: record.binding.definition.definitionId, definitionVersion: record.binding.definition.definitionVersion };
    case 'inspection-occurrence-settled':
      return { definitionId: record.definition.definitionId, definitionVersion: record.definition.definitionVersion };
    default: return undefined;
  }
}

/**
 * Canonical scoped identity hashed into a bounded Journal commit key. The key
 * carries identity only; altered facts under the same identity conflict through
 * the existing Journal commit-fact digest.
 */
function recordIdentity(record: I2Record): unknown {
  switch (record.kind) {
    case 'inspection-definition':
      return { kind: record.kind, identity: inspectionDefinitionIdentity(record) };
    case 'inspection-occurrence-opened':
      return {
        kind: record.kind,
        scope: canonicalScope(record.occurrence.scope),
        occurrenceId: record.occurrence.occurrenceId,
      };
    case 'inspection-item-result':
      return {
        kind: record.kind,
        scope: canonicalScope(record.binding.occurrence.scope),
        occurrenceId: record.binding.occurrence.occurrenceId,
        resultId: record.delivery.resultId,
      };
    case 'inspection-occurrence-settled':
      return { kind: record.kind, opening: record.openingCommitRef.commitId };
    case 'business-cycle-opened':
      return { kind: record.kind, scope: canonicalScope(record.cycle.scope), cycleId: record.cycle.id.value };
    case 'milestone-review-result':
      return {
        kind: record.kind,
        scope: canonicalScope(record.taskScope),
        milestoneId: record.milestoneId,
        cycleId: record.cycleId.value,
        assignmentId: record.reviewAssignment.assignmentId,
        attempt: record.reviewAssignment.attempt,
        reviewer: record.delivery.reviewer,
      };
    case 'milestone-review-aligned':
      return { kind: record.kind, review: record.reviewCommitRef.commitId };
    case 'business-cycle-closed':
      return { kind: record.kind, opening: record.openedCommitRef.commitId };
  }
}

function commitIdOf(record: I2Record): string {
  return `i2-history:${createHash('sha256').update(canonicalJsonStringify(recordIdentity(record))).digest('hex')}`;
}

interface ResolvedRecord {
  readonly journalRecord: JournalRecord;
  readonly record: I2Record;
}

/**
 * Resolve one referenced commit ref against the actual committed records. The
 * receipt seq/digest, the record kind and (when supplied) the task scope must
 * match exactly; a missing or conflicting mandatory reference stays explicit.
 */
function resolveReference(
  records: readonly JournalRecord[],
  ref: JournalCommitRef,
  expectedKind: I2Record['kind'],
  taskScope: ScopeRef | undefined,
): ResolvedRecord {
  validateJournalCommitRef(ref);
  const journalRecord = records.find((candidate) => candidate.commitId === ref.commitId);
  if (!journalRecord) {
    throw i2Error(
      'i2-journal-reference-missing',
      `I2 ${expectedKind} reference is not committed: ${ref.commitId}`,
      'commit the referenced I2 record before referencing it',
    );
  }
  if (journalRecord.seq !== ref.journalSeq || journalRecord.recordDigest !== ref.recordDigest) {
    throw i2Error(
      'i2-journal-reference-receipt-mismatch',
      `I2 ${expectedKind} reference receipt does not match the committed record: ${ref.commitId}`,
      'use the exact receipt returned by the durable I2 commit',
    );
  }
  const record = i2RecordFromJournalRecord(journalRecord);
  if (record === null || recordKind(record) !== expectedKind) {
    throw i2Error(
      'i2-journal-reference-kind-mismatch',
      `I2 reference ${ref.commitId} is not a committed ${expectedKind} record`,
      'reference the exact committed I2 record kind',
    );
  }
  if (taskScope !== undefined && !scopeContains(taskScope, journalRecord.scope)) {
    throw i2Error(
      'i2-journal-reference-scope-mismatch',
      `I2 ${expectedKind} reference ${ref.commitId} is outside the record task scope`,
      'reference only I2 records from the same product task',
    );
  }
  return { journalRecord, record };
}

function assertSameCycle(actual: string | undefined, expected: string, label: string): void {
  if (actual !== expected) {
    throw i2Error('i2-journal-relation-mismatch', `${label} does not match the declared cycle`, 'bind the record to its actual committed cycle');
  }
}

/**
 * Validate one I2 record against its declared relations and return the exact
 * task-level Journal scope for the append. It resolves only references this
 * module owns (other I2 records in the same Journal). Plan, checkpoint, context
 * and turn-closure refs are carried as committed facts, never inferred.
 */
function resolveRecordScope(records: readonly JournalRecord[], record: I2Record): ScopeRef {
  try {
    validateI2Record(record);
    switch (record.kind) {
      case 'inspection-definition': {
        assertDurableInspectionDefinition(record);
        return taskScopeOf(record.taskScope, 'inspection definition');
      }
      case 'inspection-occurrence-opened': {
        const taskScope = taskScopeOf(record.occurrence.scope, 'inspection occurrence');
        const definition = resolveReference(records, record.definitionCommitRef, 'inspection-definition', taskScope)
          .record as DurableInspectionDefinition;
        assertInspectionOccurrenceOpened(record, definition);
        const cycle = resolveReference(records, record.cycleOpenedCommitRef, 'business-cycle-opened', taskScope)
          .record as BusinessCycleOpenedRecord;
        assertSameCycle(cycle.cycle.id.value, record.cycleId, 'inspection occurrence cycle reference');
        return taskScope;
      }
      case 'inspection-item-result': {
        const taskScope = taskScopeOf(record.binding.occurrence.scope, 'inspection item result');
        const definition = resolveReference(records, record.binding.definitionCommitRef, 'inspection-definition', taskScope)
          .record as DurableInspectionDefinition;
        assertInspectionItemResultRecord(record, definition);
        const cycle = resolveReference(records, record.binding.cycleOpenedCommitRef, 'business-cycle-opened', taskScope)
          .record as BusinessCycleOpenedRecord;
        assertSameCycle(cycle.cycle.id.value, record.binding.cycleId, 'inspection item result cycle reference');
        return taskScope;
      }
      case 'inspection-occurrence-settled': {
        const taskScope = taskScopeOf(record.occurrence.scope, 'inspection settlement');
        const opened = resolveReference(records, record.openingCommitRef, 'inspection-occurrence-opened', taskScope)
          .record as InspectionOccurrenceOpenedRecord;
        assertInspectionOccurrenceSettled(record, opened);
        for (const ref of record.itemResultCommitRefs) {
          const item = resolveReference(records, ref, 'inspection-item-result', taskScope).record as InspectionItemResultRecord;
          if (item.binding.occurrence.occurrenceId !== record.occurrence.occurrenceId) {
            throw i2Error(
              'i2-journal-relation-mismatch',
              'inspection settlement references an item result from a different occurrence',
              'reference only item results of the settled occurrence',
            );
          }
        }
        return taskScope;
      }
      case 'business-cycle-opened': {
        validateBusinessCycleOpenedRecord(record);
        const taskScope = taskScopeOf(record.cycle.scope, 'business cycle');
        if (record.previousCycleCommitRef !== null) {
          resolveReference(records, record.previousCycleCommitRef, 'business-cycle-opened', taskScope);
        }
        return taskScope;
      }
      case 'milestone-review-result': {
        assertMilestoneReviewResultRecord(record);
        return taskScopeOf(record.taskScope, 'milestone review result');
      }
      case 'milestone-review-aligned': {
        const review = resolveReference(records, record.reviewCommitRef, 'milestone-review-result', undefined)
          .record as MilestoneReviewResultRecord;
        const taskScope = taskScopeOf(review.taskScope, 'milestone review alignment');
        assertMilestoneReviewAlignedRecord(record, review);
        return taskScope;
      }
      case 'business-cycle-closed': {
        const opened = resolveReference(records, record.openedCommitRef, 'business-cycle-opened', undefined)
          .record as BusinessCycleOpenedRecord;
        const taskScope = taskScopeOf(opened.cycle.scope, 'business cycle closure');
        assertBusinessCycleClosedRecord(record, opened);
        for (const ref of record.milestoneAlignmentCommitRefs) {
          const aligned = resolveReference(records, ref, 'milestone-review-aligned', taskScope)
            .record as MilestoneReviewAlignedRecord;
          assertSameCycle(aligned.cycleId.value, record.cycleId.value, 'business cycle closure alignment reference');
        }
        if (record.inspectionSettlementCommitRef !== undefined) {
          resolveReference(records, record.inspectionSettlementCommitRef, 'inspection-occurrence-settled', taskScope);
        }
        return taskScope;
      }
    }
  } catch (error) {
    i2Failure(error);
  }
}

/**
 * App persistence owner for the I2 product-history authority. It adapts the
 * existing authoritative Organ Journal and reuses its append integrity,
 * idempotency and locked transaction. It never introduces a second store, a
 * nested lock, or a model wait, and it never reconstructs control authority
 * from labels, counters or the latest record.
 */
export function createJsonlI2JournalPort(input: {
  readonly filePath: string;
  readonly journal?: JsonlOrganJournal;
}): I2JournalPort {
  if (!input.filePath.trim()) {
    throw i2Error(
      'i2-journal-invalid',
      'I2 journal path is required',
      'provide the runtime Organ Journal path',
    );
  }
  const journal = input.journal ?? new JsonlOrganJournal(input.filePath);

  return {
    async commit(record: I2Record): Promise<JournalCommitRef> {
      const commitId = commitIdOf(record);
      return journal.transaction<
        { readonly scope: ScopeRef; readonly existing: JournalRecord | null },
        JournalCommitRef
      >(({ records }) => {
        const existing = records.find((candidate) => {
          if (candidate.commitId === commitId) return true;
          if (record.kind !== 'milestone-review-result' || candidate.commitId === undefined) return false;
          // Reuse the exact receipt of a call persisted before its key included
          // assignment/incarnation identity. Full facts still conflict below.
          const stored = i2RecordFromJournalRecord(candidate);
          return stored?.kind === 'milestone-review-result' && commitIdOf(stored) === commitId;
        }) ?? null;
        if (existing) {
          const stored = i2RecordFromJournalRecord(existing);
          if (stored !== null && stored.kind === 'inspection-definition' && record.kind === 'inspection-definition') {
            assertInspectionDefinitionUnchanged(stored, record);
          }
          if (stored === null || canonicalJsonStringify(stored) !== canonicalJsonStringify(record)) {
            throw i2Error(
              'i2-journal-commit-conflict',
              `I2 identity is already committed with different content: ${existing.commitId}`,
              'reconcile the existing I2 record before retrying',
            );
          }
          return { scope: existing.scope, existing };
        }
        return { scope: resolveRecordScope(records, record), existing: null };
      }, async (plan, append) => {
        if (plan.existing) return journalCommitRef(plan.existing);
        const appended = await append({
          commitId,
          kind: 'event',
          scope: plan.scope,
          payload: { kind: I2_JOURNAL_PAYLOAD_KIND, record },
        });
        return journalCommitRef(appended);
      });
    },

    async read(taskScope: ScopeRef, ref: JournalCommitRef): Promise<I2Record> {
      assertTaskScope(taskScope, 'I2 read scope');
      validateJournalCommitRef(ref);
      const records = await verifiedJournalRecords(journal);
      const journalRecord = records.find((candidate) => candidate.commitId === ref.commitId);
      if (!journalRecord) {
        throw i2Error(
          'i2-journal-record-missing',
          `I2 record is not present: ${ref.commitId}`,
          'read the exact receipt returned by the durable I2 commit',
        );
      }
      if (journalRecord.seq !== ref.journalSeq || journalRecord.recordDigest !== ref.recordDigest) {
        throw i2Error(
          'i2-journal-record-corrupt',
          `I2 record does not match its receipt: ${ref.commitId}`,
          'preserve the Organ Journal and repair the committed I2 record',
        );
      }
      const record = i2RecordFromJournalRecord(journalRecord);
      if (record === null) {
        throw i2Error(
          'i2-journal-record-kind-mismatch',
          `commit ${ref.commitId} is not an I2 history record`,
          'read an I2 history receipt from the same Organ Journal',
        );
      }
      if (!scopeContains(taskScope, journalRecord.scope)) {
        throw i2Error(
          'i2-journal-scope-mismatch',
          `I2 record ${ref.commitId} is outside the requested task scope`,
          'read the I2 record with its own product task scope',
        );
      }
      return structuredClone(record);
    },

    async list(query): Promise<{
      readonly entries: readonly { readonly record: I2Record; readonly commitRef: JournalCommitRef }[];
      readonly nextCursor?: string;
    }> {
      assertTaskScope(query.taskScope, 'I2 list scope');
      if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
        throw i2Error('i2-journal-limit-invalid', 'I2 list limit must be a positive safe integer', 'provide a positive list limit');
      }
      const kinds = new Set(query.kinds);
      const matches = (record: I2Record): boolean => {
        if (!kinds.has(record.kind)) return false;
        if (query.cycleId !== undefined && recordCycleId(record) !== query.cycleId) return false;
        if (query.inspectionOccurrenceId !== undefined && recordInspectionOccurrenceId(record) !== query.inspectionOccurrenceId) return false;
        if (query.definitionId !== undefined || query.definitionVersion !== undefined) {
          const identity = recordDefinitionIdentity(record);
          if (identity === undefined) return false;
          if (query.definitionId !== undefined && identity.definitionId !== query.definitionId) return false;
          if (query.definitionVersion !== undefined && identity.definitionVersion !== query.definitionVersion) return false;
        }
        return true;
      };
      const cursor = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || (query.cursor !== undefined && String(cursor) !== query.cursor)) {
        throw i2Error('i2-journal-cursor-invalid', 'I2 list cursor must be a journal sequence', 'restart the I2 list read without a cursor');
      }
      const records = await verifiedJournalRecords(journal);
      if (cursor > 0) {
        const cursorRecord = records.find((candidate) => candidate.seq === cursor);
        const cursorValue = cursorRecord ? i2RecordFromJournalRecord(cursorRecord) : null;
        if (!cursorRecord || cursorValue === null || !matches(cursorValue) || !scopeContains(query.taskScope, cursorRecord.scope)) {
          throw i2Error(
            'i2-journal-cursor-mismatch',
            `I2 list cursor ${cursor} does not match the requested filter`,
            'restart the I2 list read with the exact filter that produced the cursor',
          );
        }
      }
      const matching = records.filter((candidate) => {
        const record = i2RecordFromJournalRecord(candidate);
        return record !== null && scopeContains(query.taskScope, candidate.scope) && matches(record);
      });
      const afterCursor = matching.filter((candidate) => candidate.seq > cursor);
      const page = afterCursor.slice(0, query.limit);
      const entries = page.map((candidate) => ({
        record: structuredClone(i2RecordFromJournalRecord(candidate)!),
        commitRef: journalCommitRef(candidate),
      }));
      const last = page.at(-1);
      return {
        entries,
        ...(afterCursor.length > page.length && last ? { nextCursor: String(last.seq) } : {}),
      };
    },
  };
}
