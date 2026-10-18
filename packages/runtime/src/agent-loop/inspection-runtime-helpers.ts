import type {
  AcceptedExecutionChildDelivery,
  AcceptedTurnEntry,
  AdmittedTurnIdentity,
  ActiveTurnBinding,
  BusinessCycleClosedRecord,
  BusinessCycleOpenedRecord,
  ChildInvocationRecord,
  DurableInspectionDefinition,
  I2JournalPort,
  I2Record,
  InspectionAcceptedCheckPort,
  InspectionExecutionBinding,
  InspectionItemDelivery,
  InspectionItemResultRecord,
  InspectionOccurrenceOpenedRecord,
  InspectionOccurrenceRef,
  InspectionOccurrenceSettledRecord,
  JournalCommitRef,
  PublishedTaskPlanRevision,
  ScopeRef,
  TaskIdentityRecord,
  WorkAssignment,
} from '../../../contracts/src/index.js';
import {
  validateBusinessCycleOpenedRecord,
  validateInspectionExecutionBinding,
  validateInspectionItemDelivery,
} from '../../../contracts/src/i2-history.js';
import {
  assertDurableInspectionDefinition,
  assertInspectionDefinitionUnchanged,
  assertInspectionOccurrenceOpened,
  computeInspectionDefinitionDigest,
} from '../../../core/src/i2-history.js';
import type {
  ActiveTurnInitialSegmentSource,
  ActiveTurnSegmentPredecessorRef,
  NativeSegmentSaveSourceV2,
} from '../../../contracts/src/active-turn-segments.js';
import type {
  ActiveTurnJournalRecord,
  ActiveTurnJournalPort,
  ActiveTurnSegmentJournalRecord,
  ActiveTurnSegmentJournalPort,
} from '../context/active-turn-journal.js';
import type { CheckpointRecoveryBinding, CommittedCheckpointRecord } from '../checkpoints/ports.js';
import {
  readCurrentTaskPlan,
  type TaskPlanRevisionConsumerPort,
} from '../orchestration/task-plan-revisions.js';
import { projectAdmittedTurnIdentityV1 } from '../context/semantic-history.js';
import { validatePublishedTaskPlanRevision } from '../../../core/src/task-plan-revision.js';
import { AgentLoopRuntimeError } from './errors.js';
import type {
  InspectionAcceptedDeliveryPort,
  InspectionAcceptedDeliveryReader,
  InspectionClock,
  InspectionOccurrenceFacts,
  InspectionOccurrenceOpeningPort,
  InspectionOccurrenceReadPort,
  InspectionSelectionContext,
  InspectionSelectionReader,
} from './inspection-turn-boundary.js';
import type {
  ReviewedBoundaryRecoveryAssetsPort,
} from './reviewed-milestone-boundary.js';

/** Exact typed child records from one capture or one committed segment. */
export interface InspectionTurnExactRecords {
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly entries: readonly AcceptedExecutionChildDelivery[];
}

/**
 * Physical resources for one logical turn. The App locates the real Journal
 * handles by turn or invocation; it does not choose a plan, occurrence or
 * recovery strategy for the Runtime.
 */
export interface InspectionTurnResources {
  readonly logicalTurnId: string;
  readonly identity: TaskIdentityRecord;
  readonly journal: Pick<ActiveTurnJournalPort, 'replay'>;
  readonly segments: Pick<ActiveTurnSegmentJournalPort,
    'readInitialSegmentSource' | 'readSegments' | 'readSegmentRecords'>;
}

export interface InspectionStopCaptureSource {
  readonly turn: AdmittedTurnIdentity;
  readonly boundaryId: string;
  readonly segmentSource?: NativeSegmentSaveSourceV2;
  /** Committed receipt for this frozen capture, distinct from its prepared selector. */
  readonly recoveryAssetsReceiptRef: string;
  readonly assets: ReviewedBoundaryRecoveryAssetsPort;
  readonly segments: Pick<
    ActiveTurnSegmentJournalPort,
    'readInitialOpenExact' | 'readSegmentInterruptedExact'
  >;
}

export interface InspectionRuntimeResourceReader {
  forTurn(logicalTurnId: string): Promise<InspectionTurnResources | null>;
  forInvocation(invocationId: string): Promise<InspectionTurnResources | null>;
  forCheckpoint(checkpoint: CommittedCheckpointRecord): Promise<InspectionStopCaptureSource | null>;
}

export interface InspectionRuntimeHelperDependencies {
  readonly resources: InspectionRuntimeResourceReader;
  readonly journal: I2JournalPort;
  readonly plans: Pick<TaskPlanRevisionConsumerPort, 'get' | 'getCommitRef' | 'list'>;
  readonly checkpoints: {
    readCommitted(
      scope: ScopeRef,
      checkpointId: CommittedCheckpointRecord['checkpoint']['id'],
    ): Promise<CommittedCheckpointRecord | null>;
    readCheckpointRecoveryBinding(
      scope: ScopeRef,
      checkpointCommitRef: JournalCommitRef,
    ): Promise<CheckpointRecoveryBinding | null>;
  };
  readonly acceptedCheck: Pick<InspectionAcceptedCheckPort, 'accept'>;
  readonly clock: InspectionClock;
}

export interface InspectionRuntimeHelpers {
  readonly selectionReader: InspectionSelectionReader;
  readonly occurrenceOpening: InspectionOccurrenceOpeningPort;
  readonly acceptedDeliveryReader: InspectionAcceptedDeliveryReader;
  readonly acceptedDelivery: InspectionAcceptedDeliveryPort;
  readonly occurrences: InspectionOccurrenceReadPort;
}

interface TurnState {
  readonly resources: InspectionTurnResources;
  readonly binding: ActiveTurnBinding;
  readonly records: readonly InspectionTurnExactRecords[];
}

interface CommittedRecord<T> {
  readonly record: T;
  readonly commitRef: JournalCommitRef;
}

interface ActiveTurnCaptureRecordsSource {
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly entries: readonly AcceptedTurnEntry[];
}

const PAGE_LIMIT = 100;

function fail(code: 'invalid-state' | 'conflict', message: string): AgentLoopRuntimeError {
  return new AgentLoopRuntimeError(code, message);
}

function sameRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

function sameTaskScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value && left.taskId?.value === right.taskId?.value;
}

function taskScopeOf(scope: ScopeRef): InspectionOccurrenceRef['scope'] {
  if (scope.organId === undefined || scope.taskId === undefined) {
    throw fail('invalid-state', 'inspection requires an exact task scope');
  }
  return { organId: scope.organId, taskId: scope.taskId };
}

function commitKey(ref: JournalCommitRef): string {
  return `${ref.commitId}\u0000${ref.journalSeq}\u0000${ref.recordDigest}`;
}

function mergeExact<T>(label: string, values: readonly T[], keyOf: (value: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    const previous = merged.get(key);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) {
      throw fail('conflict', `${label} has conflicting durable records for ${key}`);
    }
    if (previous === undefined) merged.set(key, value);
  }
  return [...merged.values()];
}

function initialBinding(source: ActiveTurnInitialSegmentSource): ActiveTurnBinding {
  return source.kind === 'captured' ? source.body.binding : source.binding;
}

function executionEntries(entries: readonly AcceptedTurnEntry[]): AcceptedExecutionChildDelivery[] {
  return entries.filter((entry): entry is AcceptedExecutionChildDelivery =>
    !('envelope' in entry) && entry.kind === 'execution');
}

function exactCaptureRecords(body: ActiveTurnCaptureRecordsSource): InspectionTurnExactRecords {
  return {
    childInvocations: body.childInvocations,
    entries: executionEntries(body.entries),
  };
}

function fromActiveTurnRecords(
  records: readonly ActiveTurnJournalRecord[],
): InspectionTurnExactRecords {
  return {
    childInvocations: records.flatMap((record) => record.kind === 'child-invocation' ? [record.record] : []),
    entries: records.flatMap((record) => record.kind === 'child-delivery' && record.entry.kind === 'execution'
      ? [record.entry] : []),
  };
}

function fromSegmentRecords(records: readonly ActiveTurnSegmentJournalRecord[]): InspectionTurnExactRecords {
  return {
    childInvocations: records.flatMap((record) => record.kind === 'child-invocation' ? [record.record] : []),
    entries: records.flatMap((record) => record.kind === 'child-delivery' && record.entry.kind === 'execution'
      ? [record.entry] : []),
  };
}

function mergeRecords(records: readonly InspectionTurnExactRecords[]): InspectionTurnExactRecords {
  return {
    childInvocations: mergeExact('inspection child invocation', records.flatMap((item) => item.childInvocations),
      (item) => item.invocationId),
    entries: mergeExact('inspection child delivery', records.flatMap((item) => item.entries),
      (item) => item.invocationId),
  };
}

function occurrenceIdentity(logicalTurnId: string, definition: DurableInspectionDefinition): string {
  return [
    'inspection-occurrence',
    logicalTurnId,
    definition.content.definition.definitionId,
    definition.content.definition.definitionVersion,
  ].join(':');
}

function sameCycle(idValue: string, record: BusinessCycleOpenedRecord): boolean {
  return record.cycle.id.value === idValue;
}

function validateExactCheckpoint(
  expected: CommittedCheckpointRecord,
  actual: CommittedCheckpointRecord | null,
): CommittedCheckpointRecord {
  if (actual === null
    || !sameRef(actual.commitRef, expected.commitRef)
    || JSON.stringify(actual.checkpoint) !== JSON.stringify(expected.checkpoint)) {
    throw fail('invalid-state', 'inspection helper requires the exact committed checkpoint');
  }
  return actual;
}

function definitionEntry(
  record: DurableInspectionDefinition,
  commitRef: JournalCommitRef,
): CommittedRecord<DurableInspectionDefinition> {
  return { record, commitRef };
}

function openingEntry(
  record: InspectionOccurrenceOpenedRecord,
  commitRef: JournalCommitRef,
): CommittedRecord<InspectionOccurrenceOpenedRecord> {
  return { record, commitRef };
}

function inspectionCheck(
  definition: DurableInspectionDefinition,
  checkId: string,
): NonNullable<import('../../../contracts/src/index.js').ExecutionChildCallBinding['inspection']>['check'] {
  const check = definition.content.checks.find((candidate) => candidate.checkId === checkId);
  if (check === undefined) {
    throw fail('invalid-state', `inspection check ${checkId} is not declared by the durable definition`);
  }
  return check;
}

function executionBinding(
  opening: InspectionOccurrenceOpenedRecord,
): InspectionExecutionBinding {
  return {
    occurrence: opening.occurrence,
    executionScope: opening.executionScope,
    cycleId: opening.cycleId,
    executionEpoch: opening.executionEpoch,
    definition: opening.definition,
    definitionCommitRef: opening.definitionCommitRef,
    definitionDigest: opening.definitionDigest,
    cycleOpenedCommitRef: opening.cycleOpenedCommitRef,
    scheduleOccurrenceRef: opening.scheduleOccurrenceRef,
  };
}

type OpenInspectionInvocation = ChildInvocationRecord & {
  readonly binding: Extract<ChildInvocationRecord['binding'], { kind: 'execution' }> & {
    readonly inspection: NonNullable<Extract<ChildInvocationRecord['binding'], { kind: 'execution' }>['inspection']>;
  };
};

function requireOpenInspection(invocation: ChildInvocationRecord): OpenInspectionInvocation {
  if (invocation.binding.kind !== 'execution' || invocation.binding.inspection === undefined) {
    throw fail('invalid-state', `child invocation ${invocation.invocationId} is not an inspection execution`);
  }
  return invocation as OpenInspectionInvocation;
}

function exactAssignment(left: WorkAssignment, right: WorkAssignment): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactResultIdentity(result: AcceptedExecutionChildDelivery, assignment: WorkAssignment): boolean {
  return result.assignment.taskId.value === assignment.taskId.value
    && result.assignment.pipelineNodeId === assignment.pipelineNodeId
    && result.assignment.assignmentId === assignment.assignmentId
    && result.assignment.attempt === assignment.attempt
    && result.assignment.executionEpoch === assignment.executionEpoch
    && result.assignment.inputRevision === assignment.inputRevision
    && result.result.taskId.value === assignment.taskId.value
    && result.result.pipelineNodeId === assignment.pipelineNodeId
    && result.result.assignmentId === assignment.assignmentId
    && result.result.attempt === assignment.attempt
    && result.result.executionEpoch === assignment.executionEpoch
    && result.result.inputRevision === assignment.inputRevision;
}

function onlyMatching<T>(
  label: string,
  entries: readonly CommittedRecord<T>[],
  predicate: (entry: CommittedRecord<T>) => boolean,
): CommittedRecord<T> | null {
  const matches = entries.filter(predicate);
  if (matches.length === 0) return null;
  const first = matches[0]!;
  for (const match of matches.slice(1)) {
    if (JSON.stringify(match.record) !== JSON.stringify(first.record)) {
      throw fail('conflict', `${label} has conflicting durable records`);
    }
  }
  return first;
}

async function listAll(
  journal: I2JournalPort,
  input: Parameters<I2JournalPort['list']>[0],
): Promise<CommittedRecord<I2Record>[]> {
  const entries: CommittedRecord<I2Record>[] = [];
  let cursor = input.cursor;
  do {
    const page = await journal.list({ ...input, ...(cursor === undefined ? {} : { cursor }) });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return entries;
}

async function findCycleOpening(
  journal: I2JournalPort,
  taskScope: ScopeRef,
  cycleId: string,
): Promise<CommittedRecord<BusinessCycleOpenedRecord> | null> {
  const entries = await listAll(journal, {
    taskScope,
    kinds: ['business-cycle-opened'],
    cycleId,
    limit: PAGE_LIMIT,
  });
  const matches = entries
    .filter((entry): entry is CommittedRecord<BusinessCycleOpenedRecord> =>
      entry.record.kind === 'business-cycle-opened' && sameCycle(cycleId, entry.record))
    .map((entry) => ({ record: entry.record, commitRef: entry.commitRef }));
  const opening = onlyMatching(`business cycle ${cycleId}`, matches, () => true);
  if (opening === null) return null;
  const read = await journal.read(taskScope, opening.commitRef);
  if (read.kind !== 'business-cycle-opened' || JSON.stringify(read) !== JSON.stringify(opening.record)) {
    throw fail('conflict', `business cycle ${cycleId} opening does not match its exact receipt`);
  }
  return opening;
}

async function exactCycleOpening(
  journal: I2JournalPort,
  taskScope: ScopeRef,
  cycleId: string,
): Promise<CommittedRecord<BusinessCycleOpenedRecord>> {
  const opening = await findCycleOpening(journal, taskScope, cycleId);
  if (opening === null) {
    throw fail('invalid-state', `business cycle ${cycleId} has no durable opening`);
  }
  return opening;
}

async function latestCycleOpeningCommitRef(
  journal: I2JournalPort,
  taskScope: ScopeRef,
): Promise<JournalCommitRef | null> {
  const entries = await listAll(journal, {
    taskScope,
    kinds: ['business-cycle-opened'],
    limit: PAGE_LIMIT,
  });
  const openings = entries
    .filter((entry): entry is CommittedRecord<BusinessCycleOpenedRecord> =>
      entry.record.kind === 'business-cycle-opened')
    .sort((left, right) => left.commitRef.journalSeq - right.commitRef.journalSeq);
  return openings.at(-1)?.commitRef ?? null;
}

async function exactDefinitionForPlan(
  dependencies: InspectionRuntimeHelperDependencies,
  taskScope: InspectionOccurrenceRef['scope'],
  content: NonNullable<PublishedTaskPlanRevision['snapshot']['inspectionDefinition']>,
): Promise<CommittedRecord<DurableInspectionDefinition> | null> {
  const entries = await listAll(dependencies.journal, {
    taskScope,
    kinds: ['inspection-definition'],
    definitionId: content.definition.definitionId,
    definitionVersion: content.definition.definitionVersion,
    limit: PAGE_LIMIT,
  });
  const expected = computeInspectionDefinitionDigest(content);
  const matches = entries
    .filter((entry): entry is CommittedRecord<DurableInspectionDefinition> =>
      entry.record.kind === 'inspection-definition'
      && entry.record.taskScope.organId.value === taskScope.organId.value
      && entry.record.taskScope.taskId.value === taskScope.taskId.value
      && entry.record.content.definition.definitionId === content.definition.definitionId
      && entry.record.content.definition.definitionVersion === content.definition.definitionVersion)
    .map((entry) => ({ record: entry.record, commitRef: entry.commitRef }));
  if (matches.length === 0) return null;
  const incoming: DurableInspectionDefinition = {
    kind: 'inspection-definition',
    schemaVersion: 1,
    taskScope,
    content,
    definitionDigest: expected,
    planRevisionCommitRef: matches[0]!.record.planRevisionCommitRef,
    createdAt: matches[0]!.record.createdAt,
  };
  for (const match of matches) {
    assertInspectionDefinitionUnchanged(match.record, incoming);
    const read = await dependencies.journal.read(taskScope, match.commitRef);
    if (read.kind !== 'inspection-definition' || JSON.stringify(read) !== JSON.stringify(match.record)) {
      throw fail('conflict', 'durable inspection definition does not match its receipt');
    }
    const publications = await dependencies.plans.list(taskScope);
    const original = publications.find((plan) =>
      plan.journalCommitRef === `jsonl:${match.record.planRevisionCommitRef.commitId}`);
    if (original === undefined || original.snapshot.inspectionDefinition === undefined) {
      throw fail('invalid-state', 'inspection definition has no original plan publication');
    }
    validatePublishedTaskPlanRevision(original);
    const receipt = await dependencies.plans.getCommitRef(taskScope, original.revisionId);
    if (receipt === null || !sameRef(receipt, match.record.planRevisionCommitRef)) {
      throw fail('conflict', 'inspection definition original plan receipt conflicts');
    }
    assertInspectionDefinitionUnchanged(match.record, {
      ...match.record, content: original.snapshot.inspectionDefinition,
      definitionDigest: computeInspectionDefinitionDigest(original.snapshot.inspectionDefinition),
    });
  }
  return onlyMatching('inspection definition', matches, () => true);
}

async function commitDefinition(
  dependencies: InspectionRuntimeHelperDependencies,
  taskScope: InspectionOccurrenceRef['scope'],
  context: InspectionSelectionContext,
  content: NonNullable<PublishedTaskPlanRevision['snapshot']['inspectionDefinition']>,
): Promise<CommittedRecord<DurableInspectionDefinition>> {
  const existing = await exactDefinitionForPlan(dependencies, taskScope, content);
  if (existing !== null) return existing;
  const record: DurableInspectionDefinition = {
    kind: 'inspection-definition',
    schemaVersion: 1,
    taskScope,
    content,
    definitionDigest: computeInspectionDefinitionDigest(content),
    planRevisionCommitRef: context.planCommitRef,
    createdAt: dependencies.clock.now().toISOString(),
  };
  assertDurableInspectionDefinition(record);
  const commitRef = await dependencies.journal.commit(record);
  const read = await dependencies.journal.read(taskScope, commitRef);
  if (read.kind !== 'inspection-definition' || JSON.stringify(read) !== JSON.stringify(record)) {
    throw fail('conflict', 'new inspection definition does not match its durable receipt');
  }
  return definitionEntry(record, commitRef);
}

async function exactOrOpenOccurrence(input: {
  readonly dependencies: InspectionRuntimeHelperDependencies;
  readonly openingCommits: Map<string, Promise<CommittedRecord<InspectionOccurrenceOpenedRecord>>>;
  readonly context: InspectionSelectionContext;
  readonly definition: CommittedRecord<DurableInspectionDefinition>;
  readonly taskScope: InspectionOccurrenceRef['scope'];
  readonly logicalTurnId: string;
  readonly executionScope: ScopeRef;
}): Promise<CommittedRecord<InspectionOccurrenceOpenedRecord>> {
  const occurrenceId = occurrenceIdentity(input.logicalTurnId, input.definition.record);
  const entries = await listAll(input.dependencies.journal, {
    taskScope: input.taskScope,
    kinds: ['inspection-occurrence-opened'],
    inspectionOccurrenceId: occurrenceId,
    limit: PAGE_LIMIT,
  });
  const existing = entries
    .filter((entry): entry is CommittedRecord<InspectionOccurrenceOpenedRecord> =>
      entry.record.kind === 'inspection-occurrence-opened'
      && entry.record.occurrence.occurrenceId === occurrenceId)
    .map((entry) => ({ record: entry.record, commitRef: entry.commitRef }));
  if (existing.length > 0) {
    const opening = onlyMatching(`inspection occurrence ${occurrenceId}`, existing, () => true)!;
    assertInspectionOccurrenceOpened(opening.record, input.definition.record);
    const read = await input.dependencies.journal.read(input.taskScope, opening.commitRef);
    if (read.kind !== 'inspection-occurrence-opened' || JSON.stringify(read) !== JSON.stringify(opening.record)) {
      throw fail('conflict', 'inspection occurrence opening does not match its receipt');
    }
    return opening;
  }
  const key = [
    input.taskScope.organId.value,
    input.taskScope.taskId.value,
    occurrenceId,
    commitKey(input.context.planCommitRef),
  ].join('\u0000');
  const running = input.openingCommits.get(key);
  if (running !== undefined) return running;
  const pending = (async () => {
    const current = await exactDefinitionForPlan(input.dependencies, input.taskScope,
      input.context.plan.snapshot.inspectionDefinition!);
    if (current === null || !sameRef(current.commitRef, input.definition.commitRef)
      || JSON.stringify(current.record) !== JSON.stringify(input.definition.record)) {
      throw fail('conflict', 'inspection definition changed while opening the occurrence');
    }
    const record: InspectionOccurrenceOpenedRecord = {
      kind: 'inspection-occurrence-opened',
      schemaVersion: 1,
      logicalTurnId: input.logicalTurnId,
      occurrence: { scope: input.taskScope, occurrenceId },
      executionScope: input.executionScope,
      cycleId: input.context.cycleOpening.cycle.id.value,
      executionEpoch: input.context.turn.executionEpoch,
      definition: input.definition.record.content.definition,
      definitionCommitRef: input.definition.commitRef,
      definitionDigest: input.definition.record.definitionDigest,
      planRevisionCommitRef: input.context.planCommitRef,
      cycleOpenedCommitRef: input.context.cycleOpenedCommitRef,
      scheduleOccurrenceRef: input.context.cycleOpening.inspectionOccurrenceId === undefined
        ? null
        : input.context.cycleOpening.scheduleOccurrenceRef ?? null,
      openedAt: input.dependencies.clock.now().toISOString(),
    };
    assertInspectionOccurrenceOpened(record, input.definition.record);
    const commitRef = await input.dependencies.journal.commit(record);
    const read = await input.dependencies.journal.read(input.taskScope, commitRef);
    if (read.kind !== 'inspection-occurrence-opened' || JSON.stringify(read) !== JSON.stringify(record)) {
      throw fail('conflict', 'new inspection occurrence does not match its durable receipt');
    }
    return openingEntry(record, commitRef);
  })();
  input.openingCommits.set(key, pending);
  try {
    return await pending;
  } finally {
    if (input.openingCommits.get(key) === pending) input.openingCommits.delete(key);
  }
}

function assertInvocationDelivery(
  invocation: ChildInvocationRecord,
  delivery: AcceptedExecutionChildDelivery,
): void {
  const binding = requireOpenInspection(invocation).binding;
  if (delivery.invocationId !== invocation.invocationId
    || !exactAssignment(delivery.assignment, binding.assignment)
    || !exactResultIdentity(delivery, binding.assignment)
    || delivery.inspectionDelivery === undefined
    || delivery.inspectionDelivery.checkId !== binding.inspection.check.checkId
    || delivery.inspectionDelivery.resultId !== `inspection-result:${invocation.invocationId}`) {
    throw fail('conflict', `child invocation ${invocation.invocationId} conflicts with its accepted delivery`);
  }
  validateInspectionItemDelivery(delivery.inspectionDelivery);
}

async function readOccurrenceFactsForTurn(
  dependencies: InspectionRuntimeHelperDependencies,
  logicalTurnId: string,
  taskScope: InspectionOccurrenceRef['scope'],
  exact?: {
    readonly records: InspectionTurnExactRecords;
    readonly binding: ActiveTurnBinding | undefined;
  },
): Promise<InspectionOccurrenceFacts | null> {
  const turnOpenings = (await listAll(dependencies.journal, {
    taskScope,
    kinds: ['inspection-occurrence-opened'],
    limit: PAGE_LIMIT,
  })).filter((entry): entry is CommittedRecord<InspectionOccurrenceOpenedRecord> =>
    entry.record.kind === 'inspection-occurrence-opened'
    && entry.record.logicalTurnId === logicalTurnId)
    .map((entry) => ({ record: entry.record, commitRef: entry.commitRef }));
  const exactTurnOccurrenceIds = new Set(turnOpenings.map(({ record }) => record.occurrence.occurrenceId));
  if (exactTurnOccurrenceIds.size > 1) {
    throw fail('conflict', 'inspection logical turn has conflicting occurrence openings');
  }
  if (turnOpenings.length === 0) return null;
  if (exact !== undefined && exact.binding === undefined) {
    throw fail('invalid-state', 'inspection stop has unresolved required facts: exact original turn binding');
  }

  const resources = await dependencies.resources.forTurn(logicalTurnId);
  if (resources === null) {
    throw fail('invalid-state', `inspection turn ${logicalTurnId} has no durable active-turn resource`);
  }
  const source = exact === undefined ? await resources.segments.readInitialSegmentSource(logicalTurnId) : null;
  if (exact === undefined && source === null) {
    throw fail('invalid-state', `inspection turn ${logicalTurnId} has no durable initial binding`);
  }
  const binding = exact?.binding ?? initialBinding(source!);
  const acceptedPlan = binding.acceptedPlan;
  if (acceptedPlan === undefined) {
    throw fail('invalid-state', 'inspection stop has unresolved required facts: accepted plan binding');
  }
  const selected = await readCurrentTaskPlan({
    plans: dependencies.plans,
    identity: resources.identity,
    currentPlan: acceptedPlan,
  });
  const content = selected.revision.snapshot.inspectionDefinition;
  if (content === undefined) {
    throw fail('invalid-state', 'inspection turn has no durable plan inspection definition');
  }
  const definition = await exactDefinitionForPlan(dependencies, taskScope, content);
  if (definition === null) {
    throw fail('invalid-state', 'inspection turn has no durable inspection definition');
  }
  const occurrenceId = occurrenceIdentity(logicalTurnId, definition.record);
  const openings = turnOpenings.filter(({ record }) => record.occurrence.occurrenceId === occurrenceId);
  const opening = onlyMatching(`inspection occurrence ${occurrenceId}`, openings, () => true);
  if (opening === null) throw fail('conflict', 'inspection logical turn has conflicting occurrence openings');
  assertInspectionOccurrenceOpened(opening.record, definition.record);
  if (!sameRef(opening.record.planRevisionCommitRef, acceptedPlan.revisionCommitRef)
    || !sameRef(opening.record.definitionCommitRef, definition.commitRef)) {
    throw fail('conflict', 'inspection occurrence conflicts with its original accepted plan or definition receipt');
  }
  const cycleId = opening.record.cycleId;
  const cycleOpening = await exactCycleOpening(dependencies.journal, taskScope, cycleId);
  const itemEntries = await listAll(dependencies.journal, {
    taskScope,
    kinds: ['inspection-item-result'],
    inspectionOccurrenceId: occurrenceId,
    limit: PAGE_LIMIT,
  });
  const items = itemEntries
    .filter((entry): entry is CommittedRecord<InspectionItemResultRecord> =>
      entry.record.kind === 'inspection-item-result'
      && entry.record.binding.occurrence.occurrenceId === occurrenceId)
    .map((entry) => ({ record: entry.record, commitRef: entry.commitRef }));
  const settlementEntries = await listAll(dependencies.journal, {
    taskScope,
    kinds: ['inspection-occurrence-settled'],
    inspectionOccurrenceId: occurrenceId,
    limit: PAGE_LIMIT,
  });
  const settlements = settlementEntries
    .filter((entry): entry is CommittedRecord<InspectionOccurrenceSettledRecord> =>
      entry.record.kind === 'inspection-occurrence-settled'
      && entry.record.occurrence.occurrenceId === occurrenceId)
    .map((entry) => ({ record: entry.record, commitRef: entry.commitRef }));
  const settlement = onlyMatching(`inspection settlement ${occurrenceId}`, settlements, () => true);
  const closeEntries = await listAll(dependencies.journal, {
    taskScope,
    kinds: ['business-cycle-closed'],
    cycleId,
    limit: PAGE_LIMIT,
  });
  const closes = closeEntries
    .filter((entry): entry is CommittedRecord<BusinessCycleClosedRecord> =>
      entry.record.kind === 'business-cycle-closed'
      && sameRef(entry.record.openedCommitRef, cycleOpening.commitRef))
    .map((entry) => ({ record: entry.record, commitRef: entry.commitRef }));
  const close = onlyMatching(`business cycle close ${cycleId}`, closes, () => true);
  const segmentRecords: InspectionTurnExactRecords[] = [];
  for (const segment of exact === undefined ? await resources.segments.readSegments(logicalTurnId) : []) {
    segmentRecords.push(fromSegmentRecords(await resources.segments.readSegmentRecords({
      businessTurnId: logicalTurnId,
      segmentId: segment.segmentId,
    })));
  }
  const merged = exact?.records ?? mergeRecords([
    ...(source?.kind === 'captured' ? [exactCaptureRecords(source.body)] : []),
    fromActiveTurnRecords(await resources.journal.replay()),
    ...segmentRecords,
  ]);
  const deliveries = merged.entries.flatMap((delivery) => {
    const invocation = merged.childInvocations.find((candidate) => candidate.invocationId === delivery.invocationId);
    if (invocation === undefined && delivery.inspectionDelivery !== undefined) {
      throw fail('invalid-state', 'accepted inspection delivery has no durable child invocation');
    }
    if (invocation === undefined || invocation.binding.kind !== 'execution'
      || invocation.binding.inspection === undefined
      || invocation.binding.inspection.binding.occurrence.occurrenceId !== occurrenceId) return [];
    assertInvocationDelivery(invocation, delivery);
    return [{ invocation, delivery }];
  });
  return {
    logicalTurnId,
    opening,
    cycleOpening,
    deliveries,
    items,
    definition,
    ...(settlement === null ? {} : { settlement }),
    ...(close === null ? {} : { close }),
  };
}

async function readOccurrenceFactsForStop(
  dependencies: InspectionRuntimeHelperDependencies,
  checkpoint: CommittedCheckpointRecord,
): Promise<readonly InspectionOccurrenceFacts[]> {
  const committed = validateExactCheckpoint(
    checkpoint,
    await dependencies.checkpoints.readCommitted(checkpoint.checkpoint.scope, checkpoint.checkpoint.id),
  );
  const taskScope = taskScopeOf(committed.checkpoint.scope);
  const applicable = (await listAll(dependencies.journal, {
    taskScope,
    kinds: ['inspection-occurrence-opened'],
    cycleId: committed.checkpoint.cycleId.value,
    limit: PAGE_LIMIT,
  })).some((entry) => entry.record.kind === 'inspection-occurrence-opened'
    && sameScope(entry.record.executionScope, committed.checkpoint.scope));
  if (!applicable) return [];

  const recoveryBinding = await dependencies.checkpoints.readCheckpointRecoveryBinding(
    committed.checkpoint.scope,
    committed.commitRef,
  );
  const source = await dependencies.resources.forCheckpoint(committed);
  if (source === null) {
    throw fail('invalid-state', 'inspection stop capture relationship is recovery-required');
  }
  if (recoveryBinding !== null && source.recoveryAssetsReceiptRef !== recoveryBinding.turnRecoveryRef) {
    throw fail('conflict', 'inspection stop receipt does not match its checkpoint binding');
  }
  const reader = source.assets.readBoundaryRecoveryAssetsExact;
  if (reader === undefined) {
    throw fail('invalid-state', 'inspection stop has no exact typed recovery-assets reader');
  }
  const readback = await reader.call(source.assets, source.recoveryAssetsReceiptRef);
  let executionEpoch: number;
  let cut: InspectionTurnExactRecords;
  let originalBinding: ActiveTurnBinding | undefined;
  let currentSegmentId: string | undefined;
  let predecessor: ActiveTurnSegmentPredecessorRef | undefined;
  if (readback.version === 2) {
    const receipt = readback.assets.receipt;
    const body = readback.assets.prepared.body;
    if (receipt.commitIdentity !== source.recoveryAssetsReceiptRef
      || receipt.businessTurnId !== source.turn.turnId
      || receipt.segmentId !== body.segmentId
      || source.segmentSource === undefined
      || source.segmentSource.opened.segmentId !== body.segmentId
      || !sameRef(source.segmentSource.openedCommitRef, readback.source.openedCommitRef)
      || !sameScope(body.binding.scope, committed.checkpoint.scope)
      || receipt.boundaryId !== source.boundaryId
      || body.cut.pauseId !== receipt.boundaryId
      || JSON.stringify(source.segmentSource) !== JSON.stringify(readback.source)
      || body.binding.businessTurnRef.businessTurnId !== source.turn.turnId) {
      throw fail('conflict', 'inspection stop capture does not match its committed source');
    }
    executionEpoch = body.binding.execution.executionEpoch;
    originalBinding = undefined;
    currentSegmentId = body.segmentId;
    predecessor = body.predecessor;
    cut = exactCaptureRecords(body);
  } else {
    const receipt = readback.assets.receipt;
    const body = readback.assets.prepared.body;
    if (receipt.commitIdentity !== source.recoveryAssetsReceiptRef
      || receipt.turnId !== source.turn.turnId
      || source.segmentSource !== undefined
      || !sameScope(body.binding.scope, committed.checkpoint.scope)
      || receipt.boundaryId !== source.boundaryId
      || body.cut.pauseId !== receipt.boundaryId
      || body.binding.admittedTurn.turnId !== source.turn.turnId) {
      throw fail('conflict', 'inspection stop capture does not match its committed source');
    }
    executionEpoch = body.binding.execution.executionEpoch;
    originalBinding = body.binding;
    cut = exactCaptureRecords(body);
  }
  if (executionEpoch !== committed.checkpoint.executionEpoch) {
    throw fail('conflict', 'inspection stop capture execution does not match the committed checkpoint');
  }
  const prior: InspectionTurnExactRecords[] = [];
  if (currentSegmentId !== undefined) {
    const visited = new Set<string>([currentSegmentId]);
    while (predecessor !== undefined) {
      if (visited.has(predecessor.segmentId)) {
        throw fail('conflict', 'inspection stop predecessor chain contains a cycle');
      }
      visited.add(predecessor.segmentId);
      if (predecessor.recoveryAssetsReceiptRef !== undefined) {
        const exact = await reader.call(source.assets, predecessor.recoveryAssetsReceiptRef);
        if (exact.assets.receipt.commitIdentity !== predecessor.recoveryAssetsReceiptRef) {
          throw fail('conflict', 'inspection stop predecessor capture does not match its chain link');
        }
        if (exact.version === 1) {
          if (exact.assets.receipt.turnId !== source.turn.turnId
            || exact.assets.prepared.body.binding.admittedTurn.turnId !== source.turn.turnId) {
            throw fail('conflict', 'inspection stop original capture belongs to a different turn');
          }
          prior.push(exactCaptureRecords(exact.assets.prepared.body));
          originalBinding = exact.assets.prepared.body.binding;
          predecessor = undefined;
        } else {
          if (exact.assets.receipt.businessTurnId !== source.turn.turnId
            || exact.assets.receipt.segmentId !== predecessor.segmentId) {
            throw fail('conflict', 'inspection stop predecessor capture does not match its chain link');
          }
          prior.push(exactCaptureRecords(exact.assets.prepared.body));
          predecessor = exact.assets.prepared.body.predecessor;
        }
      } else if (predecessor.interrupted !== undefined) {
        const exact = await source.segments.readSegmentInterruptedExact({
          businessTurnId: source.turn.turnId,
          predecessor: { segmentId: predecessor.segmentId, interrupted: predecessor.interrupted },
        });
        prior.push({
          childInvocations: exact.prefix.childInvocations,
          entries: executionEntries(exact.prefix.entries),
        });
        predecessor = exact.prefix.segment.predecessor;
      } else {
        const exact = await source.segments.readInitialOpenExact({
          businessTurnId: source.turn.turnId,
          anchor: predecessor.initialOpen,
        });
        prior.push({
          childInvocations: exact.prefix.childInvocations,
          entries: executionEntries(exact.prefix.entries),
        });
        originalBinding = exact.prefix.binding;
        predecessor = undefined;
      }
    }
  }
  const merged = mergeRecords([...prior, cut]);
  const facts = await readOccurrenceFactsForTurn(dependencies, source.turn.turnId, taskScope,
    { records: merged, binding: originalBinding });
  if (facts === null) return [];
  const deliveries = merged.entries.flatMap((delivery) => {
    const invocation = merged.childInvocations.find((candidate) => candidate.invocationId === delivery.invocationId);
    if (invocation === undefined || invocation.binding.kind !== 'execution'
      || invocation.binding.inspection === undefined
      || invocation.binding.inspection.binding.occurrence.occurrenceId
        !== facts.opening.record.occurrence.occurrenceId) return [];
    assertInvocationDelivery(invocation, delivery);
    return [{ invocation, delivery }];
  });
  return [{ ...facts, deliveries,
    items: facts.items.filter((item) => deliveries.some(({ delivery }) =>
      delivery.inspectionDelivery?.resultId === item.record.delivery.resultId)),
  }];
}

/**
 * Production ports over the durable active-turn, plan and I2 journals.
 * Business choices such as plan selection, occurrence identity and definition
 * reuse stay here; callers supply physical resources only.
 */
export function createInspectionRuntimeHelpers(
  dependencies: InspectionRuntimeHelperDependencies,
): InspectionRuntimeHelpers {
  const definitionCommits = new Map<string, Promise<CommittedRecord<DurableInspectionDefinition>>>();
  const cycleOpeningCommits = new Map<string, Promise<CommittedRecord<BusinessCycleOpenedRecord>>>();
  const openingCommits = new Map<string, Promise<CommittedRecord<InspectionOccurrenceOpenedRecord>>>();

  async function resolveTurn(logicalTurnId: string): Promise<TurnState> {
    const resources = await dependencies.resources.forTurn(logicalTurnId);
    if (resources === null) {
      throw fail('invalid-state', `inspection turn ${logicalTurnId} has no durable active-turn resource`);
    }
    if (resources.logicalTurnId !== logicalTurnId) {
      throw fail('conflict', 'inspection resource reader returned a different logical turn');
    }
    const source = await resources.segments.readInitialSegmentSource(logicalTurnId);
    if (source === null) {
      throw fail('invalid-state', `inspection turn ${logicalTurnId} has no durable initial binding`);
    }
    const binding = initialBinding(source);
    if (binding.admittedTurn.turnId !== logicalTurnId) {
      throw fail('conflict', 'inspection initial binding does not belong to the requested turn');
    }
    if (!sameTaskScope(binding.scope, resources.identity.scope)) {
      throw fail('conflict', 'inspection initial binding does not match the Task identity scope');
    }
    const segments = await resources.segments.readSegments(logicalTurnId);
    const records: InspectionTurnExactRecords[] = [
      source.kind === 'captured'
        ? exactCaptureRecords(source.body)
        : { childInvocations: [], entries: [] },
      fromActiveTurnRecords(await resources.journal.replay()),
    ];
    for (const segment of segments) {
      records.push(fromSegmentRecords(await resources.segments.readSegmentRecords({
        businessTurnId: logicalTurnId,
        segmentId: segment.segmentId,
      })));
    }
    return { resources, binding, records };
  }

  async function ensureCycleOpening(
    turn: TurnState,
    planRevisionCommitRef: JournalCommitRef,
  ): Promise<CommittedRecord<BusinessCycleOpenedRecord>> {
    const taskScope = taskScopeOf(turn.binding.scope);
    const cycleId = turn.binding.admittedTurn.cycleRef.value;
    const existing = await findCycleOpening(dependencies.journal, taskScope, cycleId);
    if (existing !== null) return existing;
    const taskFlow = turn.resources.identity.taskFlow;
    if (taskFlow === undefined) {
      throw fail('invalid-state', 'inspection first opening requires TaskIdentity taskFlow');
    }
    const key = [taskScope.organId.value, taskScope.taskId.value, cycleId].join('\u0000');
    const running = cycleOpeningCommits.get(key);
    if (running !== undefined) return running;
    const pending = (async (): Promise<CommittedRecord<BusinessCycleOpenedRecord>> => {
      const committed = await findCycleOpening(dependencies.journal, taskScope, cycleId);
      if (committed !== null) return committed;
      const record: BusinessCycleOpenedRecord = {
        kind: 'business-cycle-opened',
        schemaVersion: 1,
        cycle: {
          id: turn.binding.admittedTurn.cycleRef,
          scope: turn.binding.scope,
          directiveRevision: turn.binding.admittedTurn.directiveRevision,
          executionEpoch: turn.binding.admittedTurn.executionEpoch,
          state: 'admitted',
        },
        taskFlow,
        planRevisionCommitRef,
        previousCycleCommitRef: await latestCycleOpeningCommitRef(dependencies.journal, taskScope),
        openedAt: dependencies.clock.now().toISOString(),
        openingReason: 'Runtime first inspection selection for admitted cycle',
      };
      validateBusinessCycleOpenedRecord(record);
      const commitRef = await dependencies.journal.commit(record);
      const read = await dependencies.journal.read(taskScope, commitRef);
      if (read.kind !== 'business-cycle-opened' || JSON.stringify(read) !== JSON.stringify(record)) {
        throw fail('conflict', `business cycle ${cycleId} new opening does not match its durable receipt`);
      }
      return { record, commitRef };
    })();
    cycleOpeningCommits.set(key, pending);
    try {
      return await pending;
    } finally {
      if (cycleOpeningCommits.get(key) === pending) cycleOpeningCommits.delete(key);
    }
  }

  async function readSelectionContext(logicalTurnId: string): Promise<InspectionSelectionContext> {
    const turn = await resolveTurn(logicalTurnId);
    const acceptedPlan = turn.binding.acceptedPlan;
    if (acceptedPlan === undefined) {
      throw fail('invalid-state', 'inspection turn has no durable accepted plan binding');
    }
    const selected = await readCurrentTaskPlan({
      plans: dependencies.plans,
      identity: turn.resources.identity,
      currentPlan: {
        revisionId: acceptedPlan.revisionId,
        revisionCommitRef: acceptedPlan.revisionCommitRef,
      },
    });
    const cycleOpening = await ensureCycleOpening(turn, selected.currentPlan.revisionCommitRef);
    const context: InspectionSelectionContext = {
      turn: projectAdmittedTurnIdentityV1(turn.binding.admittedTurn),
      plan: selected.revision,
      planCommitRef: selected.currentPlan.revisionCommitRef,
      cycleOpening: cycleOpening.record,
      cycleOpenedCommitRef: cycleOpening.commitRef,
    };
    await ensureDefinition(context);
    return context;
  }

  async function ensureDefinition(
    context: InspectionSelectionContext,
  ): Promise<CommittedRecord<DurableInspectionDefinition> | null> {
    const content = context.plan.snapshot.inspectionDefinition;
    if (content === undefined) return null;
    const taskScope = taskScopeOf(context.plan.scope);
    const existing = await exactDefinitionForPlan(dependencies, taskScope, content);
    if (existing !== null) return existing;
    const key = [
      taskScope.organId.value,
      taskScope.taskId.value,
      content.definition.definitionId,
      content.definition.definitionVersion,
    ].join('\u0000');
    const running = definitionCommits.get(key);
    if (running !== undefined) {
      const committed = await running;
      assertInspectionDefinitionUnchanged(committed.record, {
        ...committed.record, content, definitionDigest: computeInspectionDefinitionDigest(content),
      });
      return committed;
    }
    const pending = commitDefinition(dependencies, taskScope, context, content);
    definitionCommits.set(key, pending);
    try {
      return await pending;
    } finally {
      if (definitionCommits.get(key) === pending) definitionCommits.delete(key);
    }
  }

  async function openOccurrence(input: {
    readonly context: InspectionSelectionContext;
    readonly logicalTurnId: string;
    readonly executionScope: ScopeRef;
    readonly assignment: WorkAssignment;
    readonly checkId: string;
  }): Promise<NonNullable<import('../../../contracts/src/index.ts').ExecutionChildCallBinding['inspection']>> {
    const definition = await ensureDefinition(input.context);
    if (definition === null) {
      throw fail('invalid-state', 'inspection selection has no durable definition');
    }
    if (definition.record.content.definition.definitionId !== input.context.plan.snapshot.inspectionDefinition?.definition.definitionId
      || definition.record.content.definition.definitionVersion !== input.context.plan.snapshot.inspectionDefinition?.definition.definitionVersion) {
      throw fail('conflict', 'durable inspection definition does not match the accepted plan');
    }
    const check = inspectionCheck(definition.record, input.checkId);
    const taskScope = taskScopeOf(input.context.plan.scope);
    if (!sameTaskScope(input.executionScope, taskScope)) {
      throw fail('conflict', 'inspection execution scope does not belong to the selected task');
    }
    const opening = await exactOrOpenOccurrence({
      dependencies,
      openingCommits,
      context: input.context,
      definition,
      taskScope,
      logicalTurnId: input.logicalTurnId,
      executionScope: input.executionScope,
    });
    const binding = executionBinding(opening.record);
    validateInspectionExecutionBinding(binding);
    return { binding, check };
  }

  const acceptedDeliveryReader: InspectionAcceptedDeliveryReader = {
    async readAcceptedDelivery(invocationId: string): Promise<AcceptedExecutionChildDelivery | null> {
      const resources = await dependencies.resources.forInvocation(invocationId);
      if (resources === null) return null;
      const turn = await resolveTurn(resources.logicalTurnId);
      const merged = mergeRecords(turn.records);
      const invocation = merged.childInvocations.find((candidate) => candidate.invocationId === invocationId);
      const delivery = merged.entries.find((candidate) => candidate.invocationId === invocationId);
      if (invocation === undefined && delivery?.inspectionDelivery !== undefined) {
        throw fail('invalid-state', 'accepted inspection delivery has no durable child invocation');
      }
      if (invocation === undefined || delivery === undefined) return null;
      assertInvocationDelivery(invocation, delivery);
      return delivery;
    },
  };

  const acceptedDelivery: InspectionAcceptedDeliveryPort = {
    async accept(input): Promise<InspectionItemDelivery | null> {
      const invocation = requireOpenInspection(input.invocation);
      assertInvocationDelivery(invocation, input.delivery);
      const inspection = invocation.binding.inspection!;
      return dependencies.acceptedCheck.accept({
        binding: inspection.binding,
        check: inspection.check,
        assignment: invocation.binding.assignment,
        result: input.delivery.result,
        delivery: input.delivery.inspectionDelivery!,
      });
    },
  };

  const selectionReader: InspectionSelectionReader = { readSelectionContext };
  const occurrenceOpening: InspectionOccurrenceOpeningPort = { open: openOccurrence };
  const occurrences: InspectionOccurrenceReadPort = {
    async readOccurrenceForTurn(input): Promise<InspectionOccurrenceFacts | null> {
      return readOccurrenceFactsForTurn(dependencies, input.logicalTurnId, input.taskScope);
    },
    async readOccurrencesForStop(input): Promise<readonly InspectionOccurrenceFacts[]> {
      return readOccurrenceFactsForStop(dependencies, input.checkpoint);
    },
  };

  return { selectionReader, occurrenceOpening, acceptedDeliveryReader, acceptedDelivery, occurrences };
}
