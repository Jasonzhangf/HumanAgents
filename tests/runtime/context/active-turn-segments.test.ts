import assert from 'node:assert/strict';
import test from 'node:test';
import { id } from '../../../packages/contracts/src/index.js';
import type {
  AcceptedRawFact,
  ActiveTurnBinding,
  RawAsset,
  RawFactEnvelope,
  ScopeRef,
} from '../../../packages/contracts/src/index.js';
import type { TaskRuntimeIncarnation } from '../../../packages/contracts/src/framework.js';
import type {
  ActiveTurnInitialSegmentCapture,
  ActiveTurnSegmentCaptureV2,
  ActiveTurnSegmentRecoveryReceiptRead,
  ResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import {
  activeTurnSegmentCommitId,
  originalBusinessTurnRef,
  validateActiveTurnSegmentCaptureV2,
  validateActiveTurnSegmentChainRead,
} from '../../../packages/contracts/src/active-turn-segments.js';
import { ActiveTurnContext } from '../../../packages/runtime/src/context/active-turn-context.js';
import type { ActiveTurnJournalPort, ActiveTurnJournalRecord } from '../../../packages/runtime/src/context/active-turn-journal.js';
import {
  ActiveTurnRecoveryCapture,
  type ActiveTurnProviderProducer,
} from '../../../packages/runtime/src/context/recovery-assets.js';
import {
  resumeActiveTurnSegment,
  type ActiveTurnSegmentAppendPort,
  type ActiveTurnSegmentReadPort,
} from '../../../packages/runtime/src/context/active-turn-segments.js';

const organId = id('organ', 'segment-organ');
const taskId = id('task', 'segment-task');
const cycleId = id('cycle', 'segment-cycle');
const scope: ScopeRef = { organId, taskId, cycleId };
const businessTurnId = 'business-turn';
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const digestC = `sha256:${'c'.repeat(64)}`;

const binding: ActiveTurnBinding = {
  execution: { runtimeId: 'runtime-a', executionEpoch: 1 },
  scope,
  admittedTurn: {
    turnId: businessTurnId,
    workAssignmentRef: 'assignment',
    taskRef: taskId,
    scopeRef: scope,
    cycleRef: cycleId,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: 1,
    runtimeBindingRef: 'runtime-a',
    permissionRevision: 'grant-1',
    admissionEvidenceRefs: [],
    currentTurnRef: 'current',
    recoveryStateRef: 'recovery',
  },
  assignment: {
    assignmentId: 'assignment',
    taskId,
    pipelineNodeId: 'node',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'resume the same business turn on a new epoch',
    targetRefs: [],
    expectedOutputRefs: [],
    acceptanceCriteriaDigest: 'sha256:criteria',
    successCriteria: ['resumed'],
    failureCriteria: ['lost'],
    incompleteCriteria: ['pending'],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  },
};

const initialInput: RawAsset = {
  ref: {
    evidenceId: id('evidence', 'initial-input'),
    kind: 'execution',
    source: 'segment-fixture',
    locator: 'initial-input',
    digest: digestA,
    scope,
  },
  view: { kind: 'utf8-text' },
};

const request = { turnId: 'provider-turn-1', requestId: 'request-a' };
const requestRecord = { request, scope, phase: 'dispatching' as const };

function envelope(execution: ActiveTurnBinding['execution'], seq: number): RawFactEnvelope {
  return {
    execution,
    scope,
    request,
    producerSeq: seq,
    fact: { kind: 'request-complete', terminal: 'completed' },
  };
}

function memoryJournal(): ActiveTurnJournalPort {
  const records: ActiveTurnJournalRecord[] = [];
  const commits = new Map<string, string>();
  return {
    async append(input) {
      const bytes = JSON.stringify(input.record);
      const previous = commits.get(input.commitId);
      if (previous !== undefined && previous !== bytes) throw new Error('journal commit conflict');
      if (previous === undefined) {
        commits.set(input.commitId, bytes);
        records.push(structuredClone(input.record));
      }
    },
    async replay() {
      return structuredClone(records);
    },
  };
}

async function buildInitialCapture() {
  const journal = memoryJournal();
  const context = await ActiveTurnContext.open({ journal, binding, currentTurnRef: 'current' });
  await context.registerInitialInput(initialInput);
  await context.registerProviderRequest({ execution: binding.execution, record: requestRecord });
  await context.acceptRawFact(envelope(binding.execution, 1));

  const producer: ActiveTurnProviderProducer = {
    async closeProductionAndDrain({ boundaryId }) {
      return { execution: binding.execution, boundaryId, requests: [{ request, lastProducerSeq: 1 }] };
    },
  };
  const recovery = new ActiveTurnRecoveryCapture(context, async () => ({
    checkpointPath: [],
    completionRefs: [],
    completionLookups: [],
    recovery: {
      commitIdentity: 'recovery:segment-fixture',
      laterErrorRefs: [],
      rawTurnRefs: [],
      unresolvedOperationRefs: [],
      stages: [],
      durablePhases: [],
      durableReceiptRefs: [],
      recoveryResponsibilityRef: 'recovery:r1',
    },
  }));
  recovery.bindProvider(producer);
  const prepared = await recovery.prepare('boundary-1');
  return { context, body: prepared.body };
}

test('cold resume appends one new-epoch segment and keeps the original identity, input and raw', async () => {
  const { body } = await buildInitialCapture();
  const initialBytes = JSON.stringify(body);
  assert.equal(body.version, 1);
  assert.equal(body.binding.execution.executionEpoch, 1);
  assert.equal(body.entries.length, 1);

  const bindingCommitRef = { commitId: 'binding-commit-1', journalSeq: 3, recordDigest: digestC };
  const incarnation: TaskRuntimeIncarnation = {
    runtimeId: 'runtime-a',
    generation: 2,
    agentInstanceId: 'agent-instance-2',
    roleId: 'role-executor',
    taskId,
    assignmentId: 'assignment',
    executionEpoch: 2,
  };

  const appended: ResumedTurnSegmentOpened[] = [];
  const appends = { count: 0 };
  const initialReads = { count: 0 };
  let receipt: ActiveTurnSegmentRecoveryReceiptRead = {
    status: 'exact',
    recoveryAssetsReceiptRef: bindingCommitRef.commitId,
  };
  const read: ActiveTurnSegmentReadPort = {
    async readInitialSegmentCapture(turnId): Promise<ActiveTurnInitialSegmentCapture | null> {
      initialReads.count += 1;
      return turnId === businessTurnId ? { bindingCommitRef, body } : null;
    },
    async readSegments(turnId) {
      return turnId === businessTurnId ? appended.slice() : [];
    },
    async readSegmentRecoveryReceipt(segmentId) {
      return segmentId === businessTurnId ? receipt : { status: 'unknown', reason: 'unknown segment' };
    },
  };
  const append: ActiveTurnSegmentAppendPort = {
    async appendSegmentOpened({ commitId, record }) {
      appends.count += 1;
      appended.push(structuredClone(record));
      return { commitId, journalSeq: 10 + appends.count, recordDigest: digestB };
    },
  };
  let admitMode: 'authorize' | 'deny' = 'authorize';
  const admit = async () => (admitMode === 'deny'
    ? { authorized: false as const, reason: 'no current grant' }
    : { authorized: true as const, authorityCommitRef: { commitId: 'grant-commit-1', journalSeq: 5, recordDigest: digestC } });

  const result = await resumeActiveTurnSegment({
    businessTurnId,
    segmentId: 'segment-e2',
    assignment: binding.assignment,
    scope,
    incarnation,
    ports: { read, append },
    admit,
  });
  assert.equal(result.status, 'resumed');
  if (result.status !== 'resumed') return;

  assert.equal(appends.count, 1, 'a valid cold resume appends exactly one segment');
  assert.equal(initialReads.count, 1, 'the immutable first capture is read once');
  assert.equal(result.appendReceipt.commitId, activeTurnSegmentCommitId('segment-e2', 'segment-opened'));
  assert.equal(result.segment.businessTurnRef.businessTurnId, businessTurnId);
  assert.equal(result.segment.businessTurnRef.bindingCommitRef.commitId, bindingCommitRef.commitId);
  assert.equal(result.segment.predecessor.segmentId, businessTurnId);
  assert.equal(result.segment.predecessor.recoveryAssetsReceiptRef, bindingCommitRef.commitId);
  assert.equal(result.segment.binding.execution.executionEpoch, 2);
  assert.equal(result.segment.binding.incarnation.agentInstanceId, 'agent-instance-2');
  assert.equal(result.segment.authorityCommitRef.commitId, 'grant-commit-1');

  // Original immutable first capture is unchanged and still holds epoch E raw.
  assert.equal(JSON.stringify(body), initialBytes);
  assert.equal(result.chain.initial.binding.execution.executionEpoch, 1);
  assert.equal(result.chain.initial.entries[0]!.seq, 1);
  assert.equal(result.chain.segments.length, 1);
  assert.equal(result.chain.segments[0]!.binding.execution.executionEpoch, 2);
  // Same business turn and same unique input asset, never a second copy.
  assert.equal(JSON.stringify(result.chain.initial.initialInput), JSON.stringify(initialInput));
  assert.equal(
    JSON.stringify(result.chain.segments[0]!.binding.businessTurnRef),
    JSON.stringify(originalBusinessTurnRef(bindingCommitRef, body)),
  );

  // Segment capture v2 keeps the exact predecessor link and the unique input.
  const epoch2Fact = envelope({ runtimeId: 'runtime-a', executionEpoch: 2 }, 1);
  const epoch2Entry: AcceptedRawFact = { seq: 1, envelope: epoch2Fact };
  const v2: ActiveTurnSegmentCaptureV2 = {
    version: 2,
    businessTurnRef: result.segment.businessTurnRef,
    binding: result.segment.binding,
    initialInput,
    entries: [epoch2Entry],
    requests: [],
    childInvocations: [],
    cut: { pauseId: 'boundary-2', lastSeq: 1, producersDrained: true, frozenAt: '2026-10-13T00:00:00.000Z' },
    predecessor: result.segment.predecessor,
  };
  validateActiveTurnSegmentCaptureV2(v2);
  assert.equal(JSON.stringify(v2.initialInput), JSON.stringify(initialInput));

  // Epoch guard: rewriting the original capture to a new epoch is rejected.
  // v1 keeps the old raw at epoch E, so relabeling is impossible without a
  // capture-body epoch mismatch.
  const rewritten = { ...body, binding: { ...body.binding, execution: { runtimeId: 'runtime-a', executionEpoch: 2 } } };
  let rewrittenError: unknown;
  try {
    validateActiveTurnSegmentChainRead({ businessTurnRef: result.segment.businessTurnRef, initial: rewritten, segments: [] });
  } catch (error) {
    rewrittenError = error;
  }
  assert.ok(
    rewrittenError instanceof Error,
    'a rewritten original epoch must be rejected by the chain validator',
  );

  // Ordered chain guard: a segment that drops its predecessor link is rejected.
  const mislinked = { ...result.segment, predecessor: { ...result.segment.predecessor, segmentId: 'not-the-initial' } };
  let mislinkError: unknown;
  try {
    validateActiveTurnSegmentChainRead({ businessTurnRef: result.segment.businessTurnRef, initial: body, segments: [mislinked] });
  } catch (error) {
    mislinkError = error;
  }
  assert.ok(mislinkError instanceof Error, 'a broken predecessor link must be rejected by the chain validator');

  // Failed or unknown receipt holds the recovery obligation with no append.
  receipt = { status: 'failed', reason: 'save failed' };
  const failed = await resumeActiveTurnSegment({
    businessTurnId,
    segmentId: 'segment-e3',
    assignment: binding.assignment,
    scope,
    incarnation: { ...incarnation, executionEpoch: 3 },
    ports: { read, append },
    admit,
  });
  assert.equal(failed.status, 'receipt-held');
  assert.equal(appends.count, 1, 'a failed receipt must not append');
  receipt = { status: 'unknown', reason: 'save outcome unknown' };
  const unknown = await resumeActiveTurnSegment({
    businessTurnId,
    segmentId: 'segment-e3b',
    assignment: binding.assignment,
    scope,
    incarnation: { ...incarnation, executionEpoch: 3 },
    ports: { read, append },
    admit,
  });
  assert.equal(unknown.status, 'receipt-held');
  assert.equal(appends.count, 1, 'an unknown receipt must not append');
  receipt = { status: 'exact', recoveryAssetsReceiptRef: bindingCommitRef.commitId };

  // A denied current grant produces zero new registration.
  admitMode = 'deny';
  const denied = await resumeActiveTurnSegment({
    businessTurnId,
    segmentId: 'segment-e4',
    assignment: binding.assignment,
    scope,
    incarnation: { ...incarnation, executionEpoch: 4 },
    ports: { read, append },
    admit,
  });
  assert.equal(denied.status, 'grant-denied');
  assert.equal(appends.count, 1, 'a denied grant must not append or register');
  admitMode = 'authorize';

  // Epoch guard red: an incarnation that does not advance the epoch must not append.
  const before = appends.count;
  await assert.rejects(() => resumeActiveTurnSegment({
    businessTurnId,
    segmentId: 'segment-bad',
    assignment: binding.assignment,
    scope,
    incarnation: { ...incarnation, executionEpoch: 1 },
    ports: { read, append },
    admit,
  }));
  assert.equal(appends.count, before, 'an invalid resumed epoch must not append');
});
