import { readFile } from 'node:fs/promises';
import {
  assertEvidenceRef,
  assertNextAction,
  validateActiveTurnCaptureBody,
  validateReviewResult,
  validateTaskIdentityScope,
  validateWorkAssignment,
  validateWorkResult,
  type TaskIdentityScope,
} from '../../../contracts/src/index.js';
import { canonicalJsonStringify } from '../../../contracts/src/explicit-brain.js';
import {
  validateActiveTurnSegmentChainRead,
  validateResumedTurnSegmentOpened,
  type ActiveTurnInitialSegmentSource,
  type ActiveTurnSegmentChainInitial,
  type ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import {
  validateJournalCommitRef,
  type JournalCommitRef,
} from '../../../contracts/src/i2-history.js';
import type {
  AssignmentGraphAction,
  AssignmentGraphCommitRequest,
  AssignmentGraphFact,
  AssignmentGraphJournalPort,
  AssignmentGraphResumeSource,
  AssignmentGraphStream,
  AssignmentRecord,
  AssignmentStageNode,
  CommittedAssignmentGraphFact,
} from '../../../runtime/src/orchestration/types.js';
import {
  JournalCommitConflictError,
  JournalIntegrityError,
  JsonlOrganJournal,
  type JournalAppendInput,
  type JournalRecord,
} from './index.js';
import { createJsonlActiveTurnSegmentJournal } from './active-turn.js';

const GRAPH_PAYLOAD_TYPE = 'assignment-graph.fact';
const ACTIVE_TURN_SEGMENT_PAYLOAD_TYPE = 'active-turn.segment-record';
const RECOVERY_ASSETS_PAYLOAD_TYPE = 'recovery-assets.phase';
const ASSIGNMENT_STATUSES: ReadonlySet<string> = new Set([
  'planned', 'assigned', 'running', 'succeeded', 'failed', 'incomplete',
  'blocked', 'retryable', 'escalated', 'merged',
]);
const ASSIGNMENT_ACTIONS: ReadonlySet<string> = new Set([
  'create-assignment', 'assign', 'start', 'accept-result', 'record-review-result',
  'mark-retryable', 'mark-blocked', 'mark-escalated', 'mark-succeeded', 'mark-merged',
]);

type UnknownRecord = Record<string, unknown>;

function journalContract<T>(assertion: () => T): T {
  try {
    return assertion();
  } catch (error) {
    if (error instanceof JournalIntegrityError) throw error;
    throw new JournalIntegrityError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

function plainObject(value: unknown, label: string): asserts value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JournalIntegrityError(`${label} must be an object`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JournalIntegrityError(`${label} is required`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new JournalIntegrityError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new JournalIntegrityError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function sameStream(left: AssignmentGraphStream, right: AssignmentGraphStream): boolean {
  return left.ownerId === right.ownerId
    && left.taskScope.organId.scope === right.taskScope.organId.scope
    && left.taskScope.organId.value === right.taskScope.organId.value
    && left.taskScope.taskId.scope === right.taskScope.taskId.scope
    && left.taskScope.taskId.value === right.taskScope.taskId.value;
}

function sameTaskScope(left: TaskIdentityScope, right: TaskIdentityScope): boolean {
  return left.organId.scope === right.organId.scope
    && left.organId.value === right.organId.value
    && left.taskId.scope === right.taskId.scope
    && left.taskId.value === right.taskId.value;
}

function validateStream(value: unknown): AssignmentGraphStream {
  plainObject(value, 'assignment graph stream');
  const ownerId = nonEmpty(value.ownerId, 'assignment graph stream ownerId');
  const taskScope = value.taskScope as TaskIdentityScope;
  journalContract(() => validateTaskIdentityScope(taskScope));
  return { taskScope, ownerId };
}

function assertStage(value: unknown, stream: AssignmentGraphStream): AssignmentStageNode {
  plainObject(value, 'assignment graph stage');
  const nodeId = nonEmpty(value.nodeId, 'assignment graph stage nodeId');
  const taskId = value.taskId as AssignmentStageNode['taskId'];
  plainObject(taskId, 'assignment graph stage taskId');
  if (taskId.scope !== 'task' || taskId.value !== stream.taskScope.taskId.value) {
    throw new JournalIntegrityError('assignment graph stage task does not match its stream');
  }
  if (value.parentNodeId !== null && (typeof value.parentNodeId !== 'string' || value.parentNodeId.trim() === '')) {
    throw new JournalIntegrityError('assignment graph stage parentNodeId is invalid');
  }
  if (typeof value.state !== 'string' || !ASSIGNMENT_STATUSES.has(value.state)) {
    throw new JournalIntegrityError('assignment graph stage state is invalid');
  }
  if (!Array.isArray(value.assignmentKeys)
    || value.assignmentKeys.some((key) => typeof key !== 'string' || key.trim() === '')) {
    throw new JournalIntegrityError('assignment graph stage assignmentKeys are invalid');
  }
  return value as unknown as AssignmentStageNode;
}

function assertAssignment(
  value: unknown,
  stage: AssignmentStageNode,
  stream: AssignmentGraphStream,
): AssignmentRecord {
  plainObject(value, 'assignment graph record');
  plainObject(value.key, 'assignment graph record key');
  const assignmentId = nonEmpty(value.key.assignmentId, 'assignment graph record assignmentId');
  const attempt = positiveInteger(value.key.attempt, 'assignment graph record attempt');
  const executionEpoch = positiveInteger(value.key.executionEpoch, 'assignment graph record executionEpoch');
  const stageNodeId = nonEmpty(value.stageNodeId, 'assignment graph record stageNodeId');
  if (stageNodeId !== stage.nodeId) {
    throw new JournalIntegrityError('assignment graph record names another stage');
  }
  const assignment = value.assignment as AssignmentRecord['assignment'];
  journalContract(() => validateWorkAssignment(assignment));
  if (assignment.assignmentId !== assignmentId
    || assignment.attempt !== attempt
    || assignment.executionEpoch !== executionEpoch
    || assignment.taskId.value !== stage.taskId.value) {
    throw new JournalIntegrityError('assignment graph record key or task does not match its work assignment');
  }
  if (typeof value.status !== 'string' || !ASSIGNMENT_STATUSES.has(value.status)) {
    throw new JournalIntegrityError('assignment graph record status is invalid');
  }
  if (value.ownerId !== stream.ownerId) {
    throw new JournalIntegrityError('assignment graph record owner does not match its stream');
  }
  if (value.agentId !== undefined) nonEmpty(value.agentId, 'assignment graph record agentId');
  if (value.runtimeBinding !== undefined) {
    plainObject(value.runtimeBinding, 'assignment graph record runtimeBinding');
    nonEmpty(value.runtimeBinding.runtimeId, 'assignment graph record runtimeId');
    positiveInteger(value.runtimeBinding.generation, 'assignment graph record generation');
    nonEmpty(value.runtimeBinding.leaseId, 'assignment graph record leaseId');
    nonEmpty(value.runtimeBinding.assignmentId, 'assignment graph record binding assignmentId');
    positiveInteger(value.runtimeBinding.executionEpoch, 'assignment graph record binding executionEpoch');
  }
  if (value.result !== undefined) {
    journalContract(() => validateWorkResult(value.result as AssignmentRecord['result'] & object, assignment));
  }
  if (!Array.isArray(value.reviewResults)) {
    throw new JournalIntegrityError('assignment graph record reviewResults must be an array');
  }
  for (const review of value.reviewResults) journalContract(() => validateReviewResult(review));
  nonEmpty(value.reason, 'assignment graph record reason');
  journalContract(() => assertNextAction(value.nextAction as AssignmentRecord['nextAction']));
  if (!Array.isArray(value.evidenceRefs)) {
    throw new JournalIntegrityError('assignment graph record evidenceRefs must be an array');
  }
  for (const evidence of value.evidenceRefs) journalContract(() => assertEvidenceRef(evidence as never));
  return value as unknown as AssignmentRecord;
}

function assertFact(value: unknown, expectedStream?: AssignmentGraphStream): AssignmentGraphFact {
  plainObject(value, 'assignment graph fact');
  if (value.version !== 1) throw new JournalIntegrityError('assignment graph fact version must be 1');
  const stream = validateStream(value.stream);
  if (expectedStream !== undefined && !sameStream(stream, expectedStream)) {
    throw new JournalIntegrityError('assignment graph fact stream does not match the bound stream');
  }
  const revision = positiveInteger(value.revision, 'assignment graph fact revision');
  const change = value.change;
  plainObject(change, 'assignment graph change');
  const stage = assertStage(change.stage, stream);
  if (change.kind === 'stage-declared') {
    return value as unknown as AssignmentGraphFact;
  }
  if (change.kind !== 'assignment-transition'
    || typeof change.action !== 'string'
    || (!ASSIGNMENT_ACTIONS.has(change.action) && change.action !== 'resume-binding')) {
    throw new JournalIntegrityError('assignment graph change is invalid');
  }
  assertAssignment(change.assignment, stage, stream);
  if (change.action === 'resume-binding') {
    journalContract(() => validateJournalCommitRef(change.segmentOpenedCommitRef as JournalCommitRef));
  } else if (change.segmentOpenedCommitRef !== undefined) {
    throw new JournalIntegrityError('only a resume-binding change carries a segmentOpenedCommitRef');
  }
  return { ...value, revision } as unknown as AssignmentGraphFact;
}

function commitRef(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) {
    throw new JournalIntegrityError('assignment graph journal record is not committed');
  }
  return {
    commitId: record.commitId,
    journalSeq: record.seq,
    recordDigest: record.recordDigest,
  };
}

function decodeGraphCarrier(record: JournalRecord): CommittedAssignmentGraphFact | null {
  if (record.kind !== 'event' || record.payload?.type !== GRAPH_PAYLOAD_TYPE) return null;
  if (record.commitId === undefined) {
    throw new JournalIntegrityError('assignment graph carrier has no commit id');
  }
  const fact = assertFact(record.payload.fact);
  if (record.scope.organId.value !== fact.stream.taskScope.organId.value
    || record.scope.taskId?.value !== fact.stream.taskScope.taskId.value) {
    throw new JournalIntegrityError('assignment graph carrier scope does not match its stream');
  }
  return { fact, commitRef: commitRef(record) };
}

function graphPayload(fact: AssignmentGraphFact): UnknownRecord {
  return { type: GRAPH_PAYLOAD_TYPE, fact };
}

function validateCommitId(commitId: unknown): string {
  const value = nonEmpty(commitId, 'assignment graph commitId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new JournalIntegrityError('invalid journal commitId');
  }
  return value;
}

function sameCommitRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function openedSegmentOf(record: JournalRecord): ResumedTurnSegmentOpened {
  if (record.kind !== 'event' || record.payload?.type !== ACTIVE_TURN_SEGMENT_PAYLOAD_TYPE) {
    throw new JournalIntegrityError('segmentOpenedCommitRef does not name an active-turn segment record');
  }
  const typed = record.payload.record;
  plainObject(typed, 'active-turn segment record');
  if (typed.kind !== 'segment-opened') {
    throw new JournalIntegrityError('segmentOpenedCommitRef does not name a segment-opened record');
  }
  journalContract(() => validateResumedTurnSegmentOpened(typed));
  return typed as unknown as ResumedTurnSegmentOpened;
}

function exactOpenedRecord(records: readonly JournalRecord[], ref: JournalCommitRef): {
  readonly record: JournalRecord;
  readonly opened: ResumedTurnSegmentOpened;
} {
  journalContract(() => validateJournalCommitRef(ref));
  const record = records.find((candidate) => candidate.commitId === ref.commitId);
  if (record === undefined) {
    throw new JournalIntegrityError(`segment-opened record is not committed: ${ref.commitId}`);
  }
  if (record.seq !== ref.journalSeq || record.recordDigest !== ref.recordDigest) {
    throw new JournalIntegrityError('segmentOpenedCommitRef does not match its committed record');
  }
  return { record, opened: openedSegmentOf(record) };
}

function assertCurrentSegmentTail(records: readonly JournalRecord[], ref: JournalCommitRef): void {
  const target = exactOpenedRecord(records, ref);
  let tail: ResumedTurnSegmentOpened | undefined;
  for (const record of records) {
    if (record.kind !== 'event' || record.payload?.type !== ACTIVE_TURN_SEGMENT_PAYLOAD_TYPE) continue;
    plainObject(record.payload.record, 'active-turn segment record');
    if (record.payload.record.kind !== 'segment-opened') continue;
    const opened = openedSegmentOf(record);
    if (opened.businessTurnRef.businessTurnId === target.opened.businessTurnRef.businessTurnId) tail = opened;
  }
  if (tail?.segmentId !== target.opened.segmentId) {
    throw new JournalIntegrityError('segmentOpenedCommitRef is not the current segment tail');
  }
}

function recoveryReceiptCaptureRef(record: JournalRecord): {
  readonly turnId: string;
  readonly locator: string;
} | null {
  if (record.kind !== 'event'
    || record.payload?.type !== RECOVERY_ASSETS_PAYLOAD_TYPE
    || (record.payload.version ?? 1) !== 1) return null;
  plainObject(record.payload.receipt, 'recovery-assets receipt');
  const receipt = record.payload.receipt;
  const turnId = nonEmpty(receipt.turnId, 'recovery-assets receipt turnId');
  plainObject(receipt.captureRef, 'recovery-assets captureRef');
  const locator = nonEmpty(receipt.captureRef.locator, 'recovery-assets captureRef locator');
  return { turnId, locator };
}

async function readInitialSource(
  records: readonly JournalRecord[],
  journal: JsonlOrganJournal,
  stream: AssignmentGraphStream,
  businessTurnId: string,
): Promise<ActiveTurnInitialSegmentSource> {
  const receipts = records
    .map(recoveryReceiptCaptureRef)
    .filter((receipt): receipt is NonNullable<ReturnType<typeof recoveryReceiptCaptureRef>> =>
      receipt !== null && receipt.turnId === businessTurnId);
  if (receipts.length > 1) {
    throw new JournalIntegrityError('multiple v1 recovery receipts exist for the business turn');
  }
  const segmentJournal = createJsonlActiveTurnSegmentJournal({ journal, businessTurnId });
  if (receipts.length === 1) {
    let capture: unknown;
    try {
      capture = JSON.parse(await readFile(receipts[0]!.locator, 'utf8'));
    } catch (error) {
      throw new JournalIntegrityError('initial capture asset is not readable JSON', { cause: error });
    }
    journalContract(() => validateActiveTurnCaptureBody(capture));
    const body = capture as Extract<ActiveTurnInitialSegmentSource, { kind: 'captured' }>['body'];
    if (body.binding.admittedTurn.turnId !== businessTurnId
      || body.binding.scope.organId.value !== stream.taskScope.organId.value
      || body.binding.scope.taskId?.value !== stream.taskScope.taskId.value) {
      throw new JournalIntegrityError('initial capture does not match its business turn and stream');
    }
    return {
      kind: 'captured',
      bindingCommitRef: await segmentJournal.readInitialBindingCommit(),
      body,
    };
  }

  const anchor = await segmentJournal.readInitialOpenAnchor();
  if (anchor === null) {
    throw new JournalIntegrityError(`initial segment source is not committed: ${businessTurnId}`);
  }
  const exact = await segmentJournal.readInitialOpenExact({ businessTurnId, anchor });
  if (exact.prefix.initialInput === undefined) {
    throw new JournalIntegrityError(`initial-open turn has no initial input asset: ${businessTurnId}`);
  }
  if (exact.prefix.binding.scope.organId.value !== stream.taskScope.organId.value
    || exact.prefix.binding.scope.taskId?.value !== stream.taskScope.taskId.value) {
    throw new JournalIntegrityError('initial-open source does not match its stream');
  }
  return {
    kind: 'initial-open',
    anchor,
    binding: exact.prefix.binding,
    initialInput: exact.prefix.initialInput,
  };
}

export function decodeAssignmentGraphRecords(
  records: readonly JournalRecord[],
): readonly CommittedAssignmentGraphFact[] {
  const facts: CommittedAssignmentGraphFact[] = [];
  for (const record of records) {
    const decoded = decodeGraphCarrier(record);
    if (decoded !== null) facts.push(decoded);
  }
  return facts;
}

export function createJsonlAssignmentGraphJournal(input: {
  readonly filePath: string;
  readonly stream: AssignmentGraphStream;
}): AssignmentGraphJournalPort {
  const filePath = nonEmpty(input.filePath, 'assignment graph journal path');
  const stream = validateStream(input.stream);
  const journal = new JsonlOrganJournal(filePath);

  async function replay(): Promise<readonly CommittedAssignmentGraphFact[]> {
    return decodeAssignmentGraphRecords(await journal.replay())
      .filter((entry) => sameStream(entry.fact.stream, stream));
  }

  async function commit(request: AssignmentGraphCommitRequest): Promise<CommittedAssignmentGraphFact> {
    plainObject(request, 'assignment graph commit request');
    const commitId = validateCommitId(request.commitId);
    const expectedRevision = nonNegativeInteger(request.expectedRevision, 'assignment graph expectedRevision');
    const fact = assertFact(request.fact, stream);
    if (fact.revision !== expectedRevision + 1) {
      throw new JournalIntegrityError('assignment graph fact revision must be expectedRevision plus one');
    }

    const record = await journal.transaction<JournalAppendInput, JournalRecord>(
      ({ records }) => {
        const existing = records.find((record) => record.commitId === commitId);
        if (existing !== undefined) {
          const stored = decodeGraphCarrier(existing);
          if (stored === null
            || canonicalJsonStringify(stored.fact) !== canonicalJsonStringify(fact)) {
            throw new JournalCommitConflictError(commitId, existing);
          }
          return {
            commitId,
            kind: 'event',
            scope: existing.scope,
            memoryScope: existing.memoryScope,
            memorySource: existing.memorySource,
            payload: existing.payload,
          };
        }

        const sameStreamFacts = decodeAssignmentGraphRecords(records)
          .filter((entry) => sameStream(entry.fact.stream, stream));
        const latestRevision = sameStreamFacts.at(-1)?.fact.revision ?? 0;
        if (latestRevision !== expectedRevision) {
          throw new JournalIntegrityError(
            `assignment graph revision conflict: expected ${expectedRevision}, committed ${latestRevision}`,
          );
        }
        if (fact.change.kind === 'assignment-transition' && fact.change.action === 'resume-binding') {
          assertCurrentSegmentTail(records, fact.change.segmentOpenedCommitRef);
        }
        return {
          commitId,
          kind: 'event',
          scope: stream.taskScope,
          payload: graphPayload(fact),
        };
      },
      async (next, append) => await append(next),
    );

    const stored = decodeGraphCarrier(record);
    if (stored === null) throw new JournalIntegrityError('assignment graph commit was not decoded after append');
    return stored;
  }

  async function readResumeSource(openedCommitRef: JournalCommitRef): Promise<AssignmentGraphResumeSource> {
    const records = await journal.replay();
    const target = exactOpenedRecord(records, openedCommitRef);
    const businessTurnId = target.opened.businessTurnRef.businessTurnId;
    const segmentJournal = createJsonlActiveTurnSegmentJournal({ journal, businessTurnId });
    const segments = await segmentJournal.readSegments(businessTurnId);
    const opened = segments.find((segment) => segment.segmentId === target.opened.segmentId);
    if (opened === undefined
      || canonicalJsonStringify(opened) !== canonicalJsonStringify(target.opened)) {
      throw new JournalIntegrityError('segmentOpenedCommitRef does not match the committed segment chain');
    }
    if (segments.at(-1)?.segmentId !== opened.segmentId) {
      throw new JournalIntegrityError('segmentOpenedCommitRef is not the current segment tail');
    }
    const initial = await readInitialSource(records, journal, stream, businessTurnId);
    const chainInitial: ActiveTurnSegmentChainInitial = initial.kind === 'captured'
      ? { kind: 'captured', body: initial.body }
      : initial;
    journalContract(() => validateActiveTurnSegmentChainRead({
      businessTurnRef: opened.businessTurnRef,
      initial: chainInitial,
      segments,
    }));
    return { openedCommitRef: { ...openedCommitRef }, opened, initial, segments };
  }

  return { replay, readResumeSource, commit };
}
