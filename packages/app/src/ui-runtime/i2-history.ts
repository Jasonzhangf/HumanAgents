import type {
  InspectionCheckDefinition,
  InspectionItemResult,
  InspectionOccurrenceRecord,
  InspectionOccurrenceRef,
} from '../../../contracts/src/inspection.js';
import { validateInspectionOccurrenceRecord } from '../../../contracts/src/inspection.js';
import { compareInspectionOccurrences } from '../../../core/src/inspection.js';
import type {
  BusinessCycleClosedRecord,
  BusinessCycleOpenedRecord,
  DurableInspectionDefinition,
  I2JournalPort,
  I2Record,
  InspectionDefinitionContent,
  InspectionItemResultRecord,
  InspectionOccurrenceOpenedRecord,
  InspectionOccurrenceSettledRecord,
  JournalCommitRef,
  MilestoneReviewAlignedRecord,
  MilestoneReviewResultRecord,
} from '../../../contracts/src/i2-history.js';
import type { EvidenceRef, ScopeRef } from '../../../contracts/src/index.js';
import type {
  RuntimeBusinessCycleEntryProjection,
  RuntimeBusinessCycleHistoryProjection,
  RuntimeBusinessCycleProjection,
  RuntimeCommitRefProjection,
  RuntimeI2CurrentPosition,
  RuntimeInspectionComparisonProjection,
  RuntimeInspectionItemComparisonProjection,
  RuntimeInspectionItemProjection,
  RuntimeInspectionOccurrenceEntryProjection,
  RuntimeInspectionOccurrenceHistoryProjection,
  RuntimeInspectionOccurrenceProjection,
  RuntimeMilestoneReviewHistoryProjection,
  RuntimeMilestoneReviewProjection,
  RuntimeReadScope,
  RuntimeReviewFindingProjection,
  RuntimeScheduleOccurrenceProjection,
  RuntimeTaskScopeProjection,
} from '../../../ui/contracts/runtime.js';
import {
  projectRuntimeBusinessCycle,
  projectRuntimeBusinessCycles,
  projectRuntimeInspectionComparison,
  projectRuntimeInspectionOccurrence,
  projectRuntimeInspectionOccurrences,
  projectRuntimeMilestoneReviews,
} from '../../../ui/projection/runtime.js';
import { UiRuntimeApiError } from './errors.js';

const I2_OWNER = 'humanagent.app.ui-runtime';
const I2_ENUMERATION_LIMIT = 10_000;

export type I2TaskReadScope = Extract<RuntimeReadScope, { readonly kind: 'task' }>;

/**
 * Owner-provided current execution position for an I2 history read. The reader
 * never infers it from committed history, event counts or the latest record.
 * `unknown` is explicit so a runtime assembled without this owner reports an
 * honest gap instead of a known-empty `{ cycleId: null }`.
 */
export type I2CurrentPositionRead =
  | {
      readonly state: 'known';
      readonly cycleId: string | null;
      readonly planRevisionCommitRef: JournalCommitRef | null;
    }
  | { readonly state: 'unknown'; readonly reason: string };

export interface I2CurrentPositionPort {
  read(taskScope: ScopeRef): Promise<I2CurrentPositionRead>;
}

/**
 * Read-only I2 history authority. The assembly injects the same Organ Journal
 * port the producers commit through. The current-position resolver is optional:
 * when it is absent the read stays usable and reports `current: unknown`.
 */
export interface I2HistoryReadPorts {
  readonly journal: I2JournalPort;
  readonly currentPosition?: I2CurrentPositionPort;
}

export interface I2HistoryListQuery {
  readonly taskScope: ScopeRef;
  readonly scope?: I2TaskReadScope;
  readonly limit: number;
  readonly cursor?: string;
}

export interface I2HistoryViewedQuery extends I2HistoryListQuery {
  readonly viewed?: string;
}

export interface I2HistoryReviewQuery extends I2HistoryListQuery {
  readonly cycleId?: string;
  readonly milestoneId?: string;
}

export interface I2HistoryEntryQuery {
  readonly taskScope: ScopeRef;
  readonly scope?: I2TaskReadScope;
}

export interface I2HistoryComparisonQuery {
  readonly taskScope: ScopeRef;
  readonly scope?: I2TaskReadScope;
  readonly left: string;
  readonly right: string;
}

export interface I2HistoryReader {
  listInspectionOccurrences(query: I2HistoryViewedQuery): Promise<RuntimeInspectionOccurrenceHistoryProjection>;
  readInspectionOccurrence(query: I2HistoryEntryQuery & { readonly occurrenceId: string }): Promise<RuntimeInspectionOccurrenceEntryProjection>;
  listMilestoneReviews(query: I2HistoryReviewQuery): Promise<RuntimeMilestoneReviewHistoryProjection>;
  listBusinessCycles(query: I2HistoryViewedQuery): Promise<RuntimeBusinessCycleHistoryProjection>;
  readBusinessCycle(query: I2HistoryEntryQuery & { readonly cycleId: string }): Promise<RuntimeBusinessCycleEntryProjection>;
  compareInspections(query: I2HistoryComparisonQuery): Promise<RuntimeInspectionComparisonProjection>;
}

interface LoadedOccurrence {
  readonly opening: InspectionOccurrenceOpenedRecord;
  readonly openingCommitRef: JournalCommitRef;
  readonly definition: InspectionCheckDefinition;
  readonly criteria: ReadonlyMap<string, string>;
  readonly results: readonly InspectionItemResultRecord[];
  readonly settlement: { readonly record: InspectionOccurrenceSettledRecord; readonly commitRef: JournalCommitRef } | null;
}

interface LoadedCycle {
  readonly opening: BusinessCycleOpenedRecord;
  readonly openingCommitRef: JournalCommitRef;
  readonly closure: { readonly record: BusinessCycleClosedRecord; readonly commitRef: JournalCommitRef } | null;
  readonly reviews: readonly LoadedReview[];
}

interface LoadedReview {
  readonly result: MilestoneReviewResultRecord;
  readonly resultCommitRef: JournalCommitRef;
  readonly aligned: { readonly record: MilestoneReviewAlignedRecord; readonly commitRef: JournalCommitRef } | null;
}

interface I2Cursor {
  readonly i: number;
  readonly fp: string;
}

function i2Failure(code: string, message: string, nextAction: string): UiRuntimeApiError {
  return new UiRuntimeApiError(code, I2_OWNER, message, nextAction, 404);
}

function requireTaskId(scope: ScopeRef): NonNullable<ScopeRef['taskId']> {
  if (scope.taskId === undefined) {
    throw new UiRuntimeApiError('read.scope.invalid', I2_OWNER, 'I2 history reads require a task scope', 'select an exact task scope', 400);
  }
  return scope.taskId;
}

function toRuntimeCommitRef(ref: JournalCommitRef): RuntimeCommitRefProjection {
  return { commitId: ref.commitId, journalSeq: ref.journalSeq, recordDigest: ref.recordDigest };
}

function toTaskScopeProjection(scope: ScopeRef): RuntimeTaskScopeProjection {
  return { organId: scope.organId, taskId: requireTaskId(scope) };
}

function toScheduleOccurrenceProjection(
  ref: { readonly subscriptionId: string; readonly scheduleRevision: number; readonly ordinal: number; readonly occurrenceId: string } | null,
): RuntimeScheduleOccurrenceProjection | null {
  return ref === null ? null : { ...ref };
}

function fingerprint(parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

function scopeFingerprintParts(scope: I2TaskReadScope | undefined): readonly string[] {
  return scope === undefined ? [] : [scope.projectKey, scope.mode];
}

function encodeCursor(cursor: I2Cursor): string {
  return JSON.stringify({ v: 1, i: cursor.i, fp: cursor.fp });
}

function decodeCursor(value: string): I2Cursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const candidate = parsed as { readonly i?: unknown; readonly fp?: unknown };
  if (!Number.isSafeInteger(candidate.i) || (candidate.i as number) < 0) return undefined;
  if (typeof candidate.fp !== 'string') return undefined;
  return { i: candidate.i as number, fp: candidate.fp };
}

function pageOf<T>(
  entries: readonly T[],
  query: { readonly limit: number; readonly cursor?: string },
  fp: string,
): { readonly page: readonly T[]; readonly nextCursor?: string } {
  let start = 0;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    if (cursor === undefined) {
      throw new UiRuntimeApiError('i2.cursor-invalid', I2_OWNER, 'I2 history cursor is not a decoded cursor', 'request the first page without a cursor', 400);
    }
    if (cursor.fp !== fp) {
      throw new UiRuntimeApiError('i2.cursor-scope-mismatch', I2_OWNER, 'I2 history cursor belongs to a different task or filter set', 'use a cursor returned for the same I2 read', 400);
    }
    if (cursor.i > entries.length) {
      throw new UiRuntimeApiError('i2.cursor-not-found', I2_OWNER, 'I2 history cursor does not point at a current entry', 'request the first page again', 404);
    }
    start = cursor.i;
  }
  const page = entries.slice(start, start + query.limit);
  const next = start + page.length;
  return {
    page,
    ...(next < entries.length ? { nextCursor: encodeCursor({ i: next, fp }) } : {}),
  };
}

function evidenceRefsOf(records: readonly InspectionItemResultRecord[]): readonly EvidenceRef[] {
  return records.flatMap((record) => record.delivery.evidenceRefs);
}

function itemStateOf(status: InspectionItemResultRecord['delivery']['outcome']['status']): RuntimeInspectionItemProjection['state'] {
  return status === 'completed' ? 'completed' : 'failed';
}

function itemOutcomeOf(
  status: InspectionItemResultRecord['delivery']['outcome']['status'] | 'missing',
): RuntimeInspectionItemProjection['outcome'] {
  return status;
}

function missingItem(checkId: string, criterion: string): RuntimeInspectionItemProjection {
  return {
    checkId,
    criterion,
    state: 'missing',
    outcome: 'missing',
    judgment: null,
    reason: null,
    resultRef: null,
    completedAt: null,
    evidenceRefs: [],
  };
}

function toItemProjection(
  checkId: string,
  criterion: string,
  record: InspectionItemResultRecord | undefined,
): RuntimeInspectionItemProjection {
  if (record === undefined) return missingItem(checkId, criterion);
  const { outcome } = record.delivery;
  return {
    checkId,
    criterion,
    state: itemStateOf(outcome.status),
    outcome: itemOutcomeOf(outcome.status),
    judgment: outcome.status === 'completed' ? outcome.judgment : (outcome.judgment ?? null),
    reason: outcome.status === 'completed' ? null : outcome.reason,
    resultRef: record.delivery.resultId,
    completedAt: record.delivery.completedAt,
    evidenceRefs: record.delivery.evidenceRefs,
  };
}

function toItemResult(
  checkId: string,
  record: InspectionItemResultRecord | undefined,
): InspectionItemResult {
  if (record === undefined) return { checkId, state: 'missing', evidenceRefs: [] };
  const { outcome } = record.delivery;
  if (outcome.status === 'completed') {
    return { checkId, state: 'completed', judgment: outcome.judgment, resultRef: record.delivery.resultId, evidenceRefs: record.delivery.evidenceRefs };
  }
  return {
    checkId,
    state: 'failed',
    ...(outcome.judgment === undefined ? {} : { judgment: outcome.judgment }),
    resultRef: record.delivery.resultId,
    evidenceRefs: record.delivery.evidenceRefs,
  };
}

function toOccurrenceRecord(loaded: LoadedOccurrence): InspectionOccurrenceRecord {
  const byCheckId = new Map(loaded.results.map((record) => [record.delivery.checkId, record]));
  const record: InspectionOccurrenceRecord = {
    occurrence: loaded.opening.occurrence,
    definition: loaded.definition,
    results: loaded.definition.checkItems.map((item) => toItemResult(item.checkId, byCheckId.get(item.checkId))),
    evidenceRefs: evidenceRefsOf(loaded.results),
  };
  validateInspectionOccurrenceRecord(record);
  return record;
}

function toOccurrenceProjection(loaded: LoadedOccurrence): RuntimeInspectionOccurrenceProjection {
  const byCheckId = new Map(loaded.results.map((record) => [record.delivery.checkId, record]));
  const settlement = loaded.settlement?.record ?? null;
  return {
    occurrenceId: loaded.opening.occurrence.occurrenceId,
    cycleId: loaded.opening.cycleId,
    executionEpoch: loaded.opening.executionEpoch,
    definitionId: loaded.definition.definitionId,
    definitionVersion: loaded.definition.definitionVersion,
    definitionDigest: loaded.opening.definitionDigest,
    definitionCommitRef: toRuntimeCommitRef(loaded.opening.definitionCommitRef),
    openingCommitRef: toRuntimeCommitRef(loaded.openingCommitRef),
    settlementCommitRef: loaded.settlement === null ? null : toRuntimeCommitRef(loaded.settlement.commitRef),
    openedAt: loaded.opening.openedAt,
    settledAt: settlement?.settledAt ?? null,
    state: settlement === null ? 'open' : 'settled',
    outcome: settlement?.outcome.status ?? 'pending',
    outcomeReason: settlement !== null && settlement.outcome.status !== 'completed' ? settlement.outcome.reason : null,
    scheduleOccurrenceRef: toScheduleOccurrenceProjection(loaded.opening.scheduleOccurrenceRef),
    items: loaded.definition.checkItems.map((item) => toItemProjection(item.checkId, loaded.criteria.get(item.checkId) ?? '', byCheckId.get(item.checkId))),
    evidenceRefs: evidenceRefsOf(loaded.results),
  };
}

function toReviewProjection(loaded: LoadedReview): RuntimeMilestoneReviewProjection {
  const { result, resultCommitRef, aligned } = loaded;
  const findings: RuntimeReviewFindingProjection[] = result.delivery.result.findings.map((finding) => ({
    findingId: finding.findingId,
    severity: finding.severity,
    locationRef: finding.locationRef,
    problem: finding.problem,
    expected: finding.expected,
    evidenceRefs: finding.evidenceRefs,
  }));
  return {
    milestoneId: result.milestoneId,
    cycleId: result.cycleId.value,
    status: result.delivery.result.status,
    reviewKind: result.delivery.result.reviewKind,
    findings,
    outputText: result.delivery.output.text,
    artifactRef: result.delivery.output.artifactRef,
    artifactDigest: result.delivery.output.artifactDigest,
    reviewer: {
      runtimeId: result.delivery.reviewer.runtimeId,
      generation: result.delivery.reviewer.generation,
      agentInstanceId: result.delivery.reviewer.agentInstanceId,
      roleId: result.delivery.reviewer.roleId,
      assignmentId: result.delivery.reviewer.assignmentId,
      executionEpoch: result.delivery.reviewer.executionEpoch,
    },
    completedAt: result.delivery.completedAt,
    reviewCommitRef: toRuntimeCommitRef(resultCommitRef),
    planRevisionCommitRef: toRuntimeCommitRef(result.planRevisionCommitRef),
    alignment: aligned === null ? 'pending' : 'aligned',
    alignmentCommitRef: aligned === null ? null : toRuntimeCommitRef(aligned.commitRef),
    alignedPlanRevisionCommitRef: aligned === null ? null : toRuntimeCommitRef(aligned.record.alignedPlanRevisionCommitRef),
    checkpointCommitRef: aligned === null ? null : toRuntimeCommitRef(aligned.record.checkpointCommitRef),
    evidenceRefs: result.delivery.result.evidenceRefs,
  };
}

function toCycleProjection(loaded: LoadedCycle): RuntimeBusinessCycleProjection {
  const closure = loaded.closure?.record ?? null;
  const reviews = loaded.reviews.map(toReviewProjection);
  return {
    cycleId: loaded.opening.cycle.id.value,
    state: loaded.opening.cycle.state,
    directiveRevision: loaded.opening.cycle.directiveRevision,
    executionEpoch: loaded.opening.cycle.executionEpoch,
    taskFlow: { kind: loaded.opening.taskFlow.kind, definitionVersion: loaded.opening.taskFlow.definitionVersion },
    openedAt: loaded.opening.openedAt,
    openingReason: loaded.opening.openingReason,
    openedCommitRef: toRuntimeCommitRef(loaded.openingCommitRef),
    planRevisionCommitRef: toRuntimeCommitRef(loaded.opening.planRevisionCommitRef),
    previousCycleCommitRef: loaded.opening.previousCycleCommitRef === null ? null : toRuntimeCommitRef(loaded.opening.previousCycleCommitRef),
    scheduleOccurrenceRef: toScheduleOccurrenceProjection(loaded.opening.scheduleOccurrenceRef ?? null),
    inspectionOccurrenceId: loaded.opening.inspectionOccurrenceId ?? null,
    progress: closure === null ? 'open' : 'closed',
    outcome: closure?.outcome ?? null,
    next: closure === null ? null : { kind: closure.next.kind, ref: closure.next.ref ?? null },
    closedAt: closure?.closedAt ?? null,
    closureCommitRef: loaded.closure === null ? null : toRuntimeCommitRef(loaded.closure.commitRef),
    checkpointCommitRef: closure === null ? null : toRuntimeCommitRef(closure.checkpointCommitRef),
    inspectionSettlementCommitRef: closure?.inspectionSettlementCommitRef === undefined
      ? null
      : toRuntimeCommitRef(closure.inspectionSettlementCommitRef),
    reviews,
    alignmentPending: reviews.filter((review) => review.alignment === 'pending').length,
  };
}

async function readDefinition(
  journal: I2JournalPort,
  taskScope: ScopeRef,
  opening: InspectionOccurrenceOpenedRecord,
): Promise<InspectionDefinitionContent> {
  const record: I2Record = await journal.read(taskScope, opening.definitionCommitRef);
  if (record.kind !== 'inspection-definition') {
    throw new UiRuntimeApiError('i2.definition.kind-mismatch', I2_OWNER, 'inspection definition reference is not an inspection-definition record', 'repair the committed inspection definition', 409);
  }
  const definition: DurableInspectionDefinition = record;
  const checkDefinition = definition.content.definition;
  if (
    checkDefinition.definitionId !== opening.definition.definitionId
    || checkDefinition.definitionVersion !== opening.definition.definitionVersion
    || definition.definitionDigest !== opening.definitionDigest
  ) {
    throw new UiRuntimeApiError('i2.definition.identity-mismatch', I2_OWNER, 'inspection definition identity or digest does not match the occurrence opening', 'repair the committed inspection definition reference', 409);
  }
  return definition.content;
}

async function loadOccurrences(
  journal: I2JournalPort,
  taskScope: ScopeRef,
): Promise<readonly LoadedOccurrence[]> {
  const openings = await journal.list({ taskScope, kinds: ['inspection-occurrence-opened'], limit: I2_ENUMERATION_LIMIT });
  const loaded: LoadedOccurrence[] = [];
  for (const entry of openings.entries) {
    if (entry.record.kind !== 'inspection-occurrence-opened') continue;
    const opening = entry.record;
    const occurrenceId = opening.occurrence.occurrenceId;
    const itemResults = await journal.list({
      taskScope,
      kinds: ['inspection-item-result'],
      inspectionOccurrenceId: occurrenceId,
      limit: I2_ENUMERATION_LIMIT,
    });
    const results: InspectionItemResultRecord[] = [];
    for (const item of itemResults.entries) {
      if (item.record.kind !== 'inspection-item-result') continue;
      if (item.record.binding.occurrence.occurrenceId !== occurrenceId || item.record.binding.cycleId !== opening.cycleId) {
        throw new UiRuntimeApiError('i2.occurrence.item-mismatch', I2_OWNER, 'inspection item result does not belong to its occurrence opening', 'repair the committed inspection item result', 409);
      }
      results.push(item.record);
    }
    const settlements = await journal.list({
      taskScope,
      kinds: ['inspection-occurrence-settled'],
      inspectionOccurrenceId: occurrenceId,
      limit: I2_ENUMERATION_LIMIT,
    });
    const settlementEntry = settlements.entries.find((candidate) => candidate.record.kind === 'inspection-occurrence-settled');
    const settlement = settlementEntry !== undefined && settlementEntry.record.kind === 'inspection-occurrence-settled'
      ? { record: settlementEntry.record, commitRef: settlementEntry.commitRef }
      : null;
    if (settlement !== null && settlement.record.openingCommitRef.commitId !== entry.commitRef.commitId) {
      throw new UiRuntimeApiError('i2.occurrence.settlement-mismatch', I2_OWNER, 'inspection settlement references a different occurrence opening', 'repair the committed inspection settlement', 409);
    }
    const content = await readDefinition(journal, taskScope, opening);
    loaded.push({
      opening,
      openingCommitRef: entry.commitRef,
      definition: content.definition,
      criteria: new Map(content.checks.map((check) => [check.checkId, check.criterion])),
      results,
      settlement,
    });
  }
  return loaded;
}

async function loadReview(
  journal: I2JournalPort,
  taskScope: ScopeRef,
  entry: { readonly record: MilestoneReviewResultRecord; readonly commitRef: JournalCommitRef },
): Promise<LoadedReview> {
  const alignedEntries = await journal.list({
    taskScope,
    kinds: ['milestone-review-aligned'],
    cycleId: entry.record.cycleId.value,
    limit: I2_ENUMERATION_LIMIT,
  });
  const alignedEntry = alignedEntries.entries.find((candidate) => (
    candidate.record.kind === 'milestone-review-aligned'
    && candidate.record.reviewCommitRef.commitId === entry.commitRef.commitId
  ));
  const aligned = alignedEntry !== undefined && alignedEntry.record.kind === 'milestone-review-aligned'
    ? { record: alignedEntry.record, commitRef: alignedEntry.commitRef }
    : null;
  return { result: entry.record, resultCommitRef: entry.commitRef, aligned };
}

async function loadCycle(
  journal: I2JournalPort,
  taskScope: ScopeRef,
  entry: { readonly record: BusinessCycleOpenedRecord; readonly commitRef: JournalCommitRef },
): Promise<LoadedCycle> {
  const cycleId = entry.record.cycle.id.value;
  const closures = await journal.list({ taskScope, kinds: ['business-cycle-closed'], cycleId, limit: I2_ENUMERATION_LIMIT });
  const closureEntry = closures.entries.find((candidate) => (
    candidate.record.kind === 'business-cycle-closed'
    && candidate.record.openedCommitRef.commitId === entry.commitRef.commitId
  ));
  const closure = closureEntry !== undefined && closureEntry.record.kind === 'business-cycle-closed'
    ? { record: closureEntry.record, commitRef: closureEntry.commitRef }
    : null;
  const reviewEntries = await journal.list({ taskScope, kinds: ['milestone-review-result'], cycleId, limit: I2_ENUMERATION_LIMIT });
  const reviews: LoadedReview[] = [];
  for (const reviewEntry of reviewEntries.entries) {
    if (reviewEntry.record.kind !== 'milestone-review-result') continue;
    reviews.push(await loadReview(journal, taskScope, { record: reviewEntry.record, commitRef: reviewEntry.commitRef }));
  }
  return { opening: entry.record, openingCommitRef: entry.commitRef, closure, reviews };
}

function requireKnownOccurrenceId(occurrenceId: string): InspectionOccurrenceRef['occurrenceId'] {
  if (occurrenceId.trim().length === 0) {
    throw new UiRuntimeApiError('i2.occurrence.invalid', I2_OWNER, 'inspection occurrence id must be non-empty', 'select a committed occurrence', 400);
  }
  return occurrenceId;
}

export function createI2HistoryReader(ports: I2HistoryReadPorts): I2HistoryReader {
  const { journal, currentPosition } = ports;

  async function current(taskScope: ScopeRef): Promise<RuntimeI2CurrentPosition> {
    if (currentPosition === undefined) {
      return { state: 'unknown', reason: 'no current-position resolver is bound to this runtime' };
    }
    const read = await currentPosition.read(taskScope);
    if (read.state === 'unknown') return { state: 'unknown', reason: read.reason };
    return {
      state: 'known',
      cycleId: read.cycleId,
      planRevisionCommitRef: read.planRevisionCommitRef === null ? null : toRuntimeCommitRef(read.planRevisionCommitRef),
    };
  }

  return {
    async listInspectionOccurrences(query): Promise<RuntimeInspectionOccurrenceHistoryProjection> {
      const taskScope = query.taskScope;
      const loaded = await loadOccurrences(journal, taskScope);
      const fp = fingerprint([
        'inspection-occurrences',
        ...scopeFingerprintParts(query.scope),
        taskScope.organId.value,
        requireTaskId(taskScope).value,
      ]);
      const { page, nextCursor } = pageOf(loaded, query, fp);
      let viewed: { readonly occurrenceId: string } | null = null;
      if (query.viewed !== undefined) {
        const target = loaded.find((entry) => entry.opening.occurrence.occurrenceId === query.viewed);
        if (target === undefined) {
          throw i2Failure('i2.occurrence.viewed-unknown', `no committed inspection occurrence ${query.viewed} in this task scope`, 'select a committed occurrence of this task');
        }
        viewed = { occurrenceId: target.opening.occurrence.occurrenceId };
      }
      return projectRuntimeInspectionOccurrences({
        taskScope: toTaskScopeProjection(taskScope),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        current: await current(taskScope),
        viewed,
        occurrences: page.map(toOccurrenceProjection),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
    },

    async readInspectionOccurrence(query): Promise<RuntimeInspectionOccurrenceEntryProjection> {
      const taskScope = query.taskScope;
      const occurrenceId = requireKnownOccurrenceId(query.occurrenceId);
      const loaded = await loadOccurrences(journal, taskScope);
      const target = loaded.find((entry) => entry.opening.occurrence.occurrenceId === occurrenceId);
      if (target === undefined) {
        throw i2Failure('i2.occurrence.unknown', `no committed inspection occurrence ${occurrenceId} in this task scope`, 'select a committed occurrence of this task');
      }
      return projectRuntimeInspectionOccurrence({
        taskScope: toTaskScopeProjection(taskScope),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        current: await current(taskScope),
        viewed: { occurrenceId: target.opening.occurrence.occurrenceId },
        occurrence: toOccurrenceProjection(target),
      });
    },

    async listMilestoneReviews(query): Promise<RuntimeMilestoneReviewHistoryProjection> {
      const taskScope = query.taskScope;
      const resultEntries = await journal.list({
        taskScope,
        kinds: ['milestone-review-result'],
        ...(query.cycleId === undefined ? {} : { cycleId: query.cycleId }),
        limit: I2_ENUMERATION_LIMIT,
      });
      const reviews: LoadedReview[] = [];
      for (const entry of resultEntries.entries) {
        if (entry.record.kind !== 'milestone-review-result') continue;
        if (query.milestoneId !== undefined && entry.record.milestoneId !== query.milestoneId) continue;
        reviews.push(await loadReview(journal, taskScope, { record: entry.record, commitRef: entry.commitRef }));
      }
      const fp = fingerprint([
        'milestone-reviews',
        ...scopeFingerprintParts(query.scope),
        taskScope.organId.value,
        requireTaskId(taskScope).value,
        query.cycleId ?? '',
        query.milestoneId ?? '',
      ]);
      const { page, nextCursor } = pageOf(reviews, query, fp);
      return projectRuntimeMilestoneReviews({
        taskScope: toTaskScopeProjection(taskScope),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        current: await current(taskScope),
        reviews: page.map(toReviewProjection),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
    },

    async listBusinessCycles(query): Promise<RuntimeBusinessCycleHistoryProjection> {
      const taskScope = query.taskScope;
      const openingEntries = await journal.list({ taskScope, kinds: ['business-cycle-opened'], limit: I2_ENUMERATION_LIMIT });
      const cycles: LoadedCycle[] = [];
      for (const entry of openingEntries.entries) {
        if (entry.record.kind !== 'business-cycle-opened') continue;
        cycles.push(await loadCycle(journal, taskScope, { record: entry.record, commitRef: entry.commitRef }));
      }
      const fp = fingerprint([
        'business-cycles',
        ...scopeFingerprintParts(query.scope),
        taskScope.organId.value,
        requireTaskId(taskScope).value,
      ]);
      const { page, nextCursor } = pageOf(cycles, query, fp);
      let viewed: { readonly cycleId: string } | null = null;
      if (query.viewed !== undefined) {
        const target = cycles.find((entry) => entry.opening.cycle.id.value === query.viewed);
        if (target === undefined) {
          throw i2Failure('i2.cycle.viewed-unknown', `no committed business cycle ${query.viewed} in this task scope`, 'select a committed cycle of this task');
        }
        viewed = { cycleId: target.opening.cycle.id.value };
      }
      return projectRuntimeBusinessCycles({
        taskScope: toTaskScopeProjection(taskScope),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        current: await current(taskScope),
        viewed,
        cycles: page.map(toCycleProjection),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
    },

    async readBusinessCycle(query): Promise<RuntimeBusinessCycleEntryProjection> {
      const taskScope = query.taskScope;
      const openingEntries = await journal.list({ taskScope, kinds: ['business-cycle-opened'], cycleId: query.cycleId, limit: I2_ENUMERATION_LIMIT });
      const entry = openingEntries.entries.find((candidate) => candidate.record.kind === 'business-cycle-opened');
      if (entry === undefined || entry.record.kind !== 'business-cycle-opened') {
        throw i2Failure('i2.cycle.unknown', `no committed business cycle ${query.cycleId} in this task scope`, 'select a committed cycle of this task');
      }
      const loaded = await loadCycle(journal, taskScope, { record: entry.record, commitRef: entry.commitRef });
      return projectRuntimeBusinessCycle({
        taskScope: toTaskScopeProjection(taskScope),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        current: await current(taskScope),
        viewed: { cycleId: loaded.opening.cycle.id.value },
        cycle: toCycleProjection(loaded),
      });
    },

    async compareInspections(query): Promise<RuntimeInspectionComparisonProjection> {
      const taskScope = query.taskScope;
      const loaded = await loadOccurrences(journal, taskScope);
      const left = loaded.find((entry) => entry.opening.occurrence.occurrenceId === query.left);
      const right = loaded.find((entry) => entry.opening.occurrence.occurrenceId === query.right);
      if (left === undefined || right === undefined) {
        const missing = left === undefined ? query.left : query.right;
        throw i2Failure('i2.comparison.occurrence.unknown', `no committed inspection occurrence ${missing} in this task scope`, 'select two committed occurrences of this task');
      }
      const comparison = compareInspectionOccurrences({
        before: toOccurrenceRecord(left),
        after: toOccurrenceRecord(right),
        beforeRef: left.opening.occurrence,
        afterRef: right.opening.occurrence,
      });
      const items: RuntimeInspectionItemComparisonProjection[] = comparison.items.map((item) => {
        const criterion = left.criteria.get(item.checkId) ?? '';
        return {
          checkId: item.checkId,
          criterion,
          change: item.change,
          before: toItemProjection(item.checkId, criterion, left.results.find((record) => record.delivery.checkId === item.checkId)),
          after: toItemProjection(item.checkId, criterion, right.results.find((record) => record.delivery.checkId === item.checkId)),
        };
      });
      return projectRuntimeInspectionComparison({
        taskScope: toTaskScopeProjection(taskScope),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        current: await current(taskScope),
        left: { occurrenceId: left.opening.occurrence.occurrenceId },
        right: { occurrenceId: right.opening.occurrence.occurrenceId },
        comparable: comparison.comparable,
        reason: comparison.comparable ? null : comparison.reason,
        definition: comparison.comparable
          ? { definitionId: comparison.basis.definition.definitionId, definitionVersion: comparison.basis.definition.definitionVersion }
          : null,
        items,
      });
    },
  };
}
