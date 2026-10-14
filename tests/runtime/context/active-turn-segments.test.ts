import assert from 'node:assert/strict';
import test from 'node:test';
import { id } from '../../../packages/contracts/src/index.js';
import type {
  AcceptedRawFact,
  AcceptedChildDelivery,
  ActiveTurnBinding,
  ActiveTurnCaptureBody,
  CompletionReadInput,
  ProviderProducerDrainResult,
  RawAsset,
  RawFactEnvelope,
  RecoveryHoldFacts,
  ScopeRef,
  WorkAssignment,
  WorkResult,
} from '../../../packages/contracts/src/index.js';
import type { JournalCommitRef } from '../../../packages/contracts/src/i2-history.js';
import type { TaskRuntimeIncarnation } from '../../../packages/contracts/src/framework.js';
import type {
  ActiveTurnInitialSegmentCapture,
  ActiveTurnSegmentCaptureV2,
  ActiveTurnSegmentOpenIntent,
  ActiveTurnSegmentRecoveryReceiptRead,
  PreparedActiveTurnSegmentCaptureV2,
  ResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import {
  activeTurnSegmentCommitId,
  originalBusinessTurnRef,
  validateActiveTurnSegmentCaptureV2,
  validateActiveTurnSegmentChainRead,
  validateActiveTurnSegmentOpenIntent,
  validatePreparedActiveTurnSegmentCaptureV2,
  validateResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import {
  ActiveTurnContext,
  ActiveTurnSegmentContext,
  type ActiveTurnSegmentRecord,
  type ActiveTurnSegmentRecordPort,
} from '../../../packages/runtime/src/context/active-turn-context.js';
import type { ActiveTurnJournalPort, ActiveTurnJournalRecord } from '../../../packages/runtime/src/context/active-turn-journal.js';
import {
  ActiveTurnRecoveryCapture,
  type ActiveTurnProviderProducer,
} from '../../../packages/runtime/src/context/recovery-assets.js';
import {
  resumeActiveTurnSegment,
  type ActiveTurnSegmentAdmission,
  type ActiveTurnSegmentAppendPort,
  type ActiveTurnSegmentReadPort,
} from '../../../packages/runtime/src/context/active-turn-segments.js';

function expectThrows(fn: () => unknown, substring: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected a throw containing "${substring}"`);
  assert.ok((caught as Error).message.includes(substring), `expected "${(caught as Error).message}" to contain "${substring}"`);
}

async function expectRejects(fn: () => Promise<unknown>, substring: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected a rejection containing "${substring}"`);
  assert.ok((caught as Error).message.includes(substring), `expected "${(caught as Error).message}" to contain "${substring}"`);
}

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

async function buildInitialCapture(): Promise<ActiveTurnCaptureBody> {
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
  return prepared.body;
}

function incarnationFor(executionEpoch: number): TaskRuntimeIncarnation {
  return {
    runtimeId: 'runtime-a',
    generation: executionEpoch,
    agentInstanceId: `agent-instance-${executionEpoch}`,
    roleId: 'role-executor',
    taskId,
    assignmentId: 'assignment',
    executionEpoch,
  };
}

interface SegmentWorld {
  readonly body: ActiveTurnCaptureBody;
  readonly bindingCommitRef: JournalCommitRef;
  readonly read: ActiveTurnSegmentReadPort;
  readonly append: ActiveTurnSegmentAppendPort;
  readonly admit: (intent: ActiveTurnSegmentOpenIntent) => Promise<ActiveTurnSegmentAdmission>;
  readonly counters: { appends: number; admitCalls: number };
  readonly segments: ResumedTurnSegmentOpened[];
  lastIntent(): ActiveTurnSegmentOpenIntent | undefined;
  setReceipt(segmentId: string, receipt: ActiveTurnSegmentRecoveryReceiptRead): void;
  setAdmitMode(mode: 'authorize' | 'deny'): void;
}

async function makeWorld(): Promise<SegmentWorld> {
  const body = await buildInitialCapture();
  const bindingCommitRef: JournalCommitRef = { commitId: 'binding-commit-1', journalSeq: 3, recordDigest: digestC };

  const segments: ResumedTurnSegmentOpened[] = [];
  const receipts = new Map<string, ActiveTurnSegmentRecoveryReceiptRead>();
  receipts.set(businessTurnId, { status: 'exact', recoveryAssetsReceiptRef: 'receipt-initial' });
  const commitBytes = new Map<string, string>();
  const commitReceipts = new Map<string, JournalCommitRef>();
  const counters = { appends: 0, admitCalls: 0 };
  let admitMode: 'authorize' | 'deny' = 'authorize';
  let lastIntent: ActiveTurnSegmentOpenIntent | undefined;

  const read: ActiveTurnSegmentReadPort = {
    async readInitialSegmentCapture(turnId): Promise<ActiveTurnInitialSegmentCapture | null> {
      return turnId === businessTurnId ? { bindingCommitRef, body } : null;
    },
    async readSegments(turnId) {
      return turnId === businessTurnId ? structuredClone(segments) : [];
    },
    async readSegmentRecoveryReceipt(segmentId) {
      return receipts.get(segmentId) ?? { status: 'unknown', reason: `no receipt for ${segmentId}` };
    },
  };

  const append: ActiveTurnSegmentAppendPort = {
    async appendSegmentOpened({ commitId, record }) {
      const bytes = JSON.stringify(record);
      const previous = commitBytes.get(commitId);
      if (previous !== undefined) {
        if (previous !== bytes) throw new Error('journal commit conflict');
        return commitReceipts.get(commitId)!;
      }
      commitBytes.set(commitId, bytes);
      const receipt: JournalCommitRef = { commitId, journalSeq: 10 + commitBytes.size, recordDigest: digestB };
      commitReceipts.set(commitId, receipt);
      segments.push(structuredClone(record));
      counters.appends += 1;
      return receipt;
    },
  };

  const admit = async (intent: ActiveTurnSegmentOpenIntent): Promise<ActiveTurnSegmentAdmission> => {
    counters.admitCalls += 1;
    lastIntent = intent;
    if (admitMode === 'deny') return { authorized: false, reason: 'no current grant' };
    const requestRef = `segment-open:${intent.businessTurnRef.businessTurnId}:${intent.segmentId}`;
    return {
      authorized: true,
      authorityCommitRef: { commitId: `grant-${intent.segmentId}`, journalSeq: 5, recordDigest: digestC },
      businessRegistrationCommitRef: { commitId: `registration-${intent.segmentId}`, journalSeq: 6, recordDigest: digestC },
      requestRef,
      inputIdentity: { requestRef, digest: digestA },
    };
  };

  return {
    body,
    bindingCommitRef,
    read,
    append,
    admit,
    counters,
    segments,
    lastIntent: () => lastIntent,
    setReceipt: (segmentId, receipt) => { receipts.set(segmentId, receipt); },
    setAdmitMode: (mode) => { admitMode = mode; },
  };
}

function resumeInput(world: SegmentWorld, input: {
  readonly segmentId: string;
  readonly executionEpoch: number;
  readonly assignment?: ActiveTurnBinding['assignment'];
  readonly scope?: ScopeRef;
  readonly agentInstanceId?: string;
}) {
  const incarnation = { ...incarnationFor(input.executionEpoch), agentInstanceId: input.agentInstanceId ?? `agent-instance-${input.executionEpoch}` };
  return {
    businessTurnId,
    segmentId: input.segmentId,
    assignment: input.assignment ?? binding.assignment,
    scope: input.scope ?? scope,
    incarnation,
    ports: { read: world.read, append: world.append },
    admit: world.admit,
  };
}

test('cold resume chains initial -> S1 -> S2 with real distinct receipts and the original input', async () => {
  const world = await makeWorld();
  const initialBytes = JSON.stringify(world.body);

  const s1 = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2 }));
  assert.equal(s1.status, 'resumed');
  if (s1.status !== 'resumed') return;

  assert.equal(world.counters.appends, 1, 'a valid cold resume appends exactly one segment');
  assert.equal(s1.segment.predecessor.segmentId, businessTurnId);
  assert.equal(s1.segment.predecessor.recoveryAssetsReceiptRef, 'receipt-initial', 'the first segment links the real initial receipt, not the binding commit');
  assert.notEqual(s1.segment.businessRegistrationCommitRef.commitId, s1.segment.authorityCommitRef.commitId, 'the registration and grant commits are distinct');
  assert.equal(s1.segment.requestRef, 'segment-open:business-turn:segment-e2');
  assert.equal(s1.segment.inputIdentity.requestRef, s1.segment.requestRef);
  assert.equal(s1.segment.binding.execution.executionEpoch, 2);
  assert.equal(s1.segment.binding.incarnation.agentInstanceId, 'agent-instance-2');
  assert.equal(
    JSON.stringify(s1.segment.businessTurnRef),
    JSON.stringify(originalBusinessTurnRef(world.bindingCommitRef, world.body)),
  );
  assert.equal(s1.appendReceipt.commitId, activeTurnSegmentCommitId('segment-e2', 'segment-opened'));

  // The admission saw the real chain-tail predecessor and the unique original input.
  const intent1 = world.lastIntent();
  assert.ok(intent1);
  assert.equal(intent1.predecessor.segmentId, businessTurnId);
  assert.equal(intent1.predecessor.recoveryAssetsReceiptRef, 'receipt-initial');
  assert.equal(JSON.stringify(intent1.initialInput), JSON.stringify(initialInput));

  // The immutable first capture is unchanged and still holds epoch E raw.
  assert.equal(JSON.stringify(world.body), initialBytes);
  assert.equal(s1.chain.initial.binding.execution.executionEpoch, 1);
  assert.equal(s1.chain.initial.entries[0]!.seq, 1);
  assert.equal(s1.chain.segments.length, 1);
  assert.equal(JSON.stringify(s1.chain.initial.initialInput), JSON.stringify(initialInput));

  // Second resumption: predecessor is the real S1 and its real receipt.
  world.setReceipt('segment-e2', { status: 'exact', recoveryAssetsReceiptRef: 'receipt-s1' });
  const s2 = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e3', executionEpoch: 3 }));
  assert.equal(s2.status, 'resumed');
  if (s2.status !== 'resumed') return;

  assert.equal(world.counters.appends, 2);
  assert.equal(s2.segment.predecessor.segmentId, 'segment-e2');
  assert.equal(s2.segment.predecessor.recoveryAssetsReceiptRef, 'receipt-s1', 'the second segment links the real S1 receipt');
  assert.equal(s2.segment.binding.execution.executionEpoch, 3);
  assert.deepEqual(s2.chain.segments.map((segment) => segment.segmentId), ['segment-e2', 'segment-e3']);
  assert.equal(s2.chain.initial.binding.execution.executionEpoch, 1);
});

test('exact retry reuses the original receipt and content; a changed intent conflicts', async () => {
  const world = await makeWorld();
  const first = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2 }));
  assert.equal(first.status, 'resumed');
  if (first.status !== 'resumed') return;
  const appendsAfterFirst = world.counters.appends;
  const admitsAfterFirst = world.counters.admitCalls;

  const retry = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2 }));
  assert.equal(retry.status, 'resumed');
  if (retry.status !== 'resumed') return;
  assert.equal(world.counters.appends, appendsAfterFirst, 'an exact retry does not duplicate the durable record');
  assert.equal(world.counters.admitCalls, admitsAfterFirst, 'an exact retry does not re-register');
  assert.equal(retry.appendReceipt.commitId, first.appendReceipt.commitId, 'an exact retry reuses the original receipt');
  assert.equal(retry.segment.businessRegistrationCommitRef.commitId, first.segment.businessRegistrationCommitRef.commitId);
  assert.equal(JSON.stringify(retry.segment), JSON.stringify(first.segment), 'an exact retry reuses the original content');

  // A different real handle is a different intent and must conflict.
  await expectRejects(
    () => resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2, agentInstanceId: 'agent-instance-9' })),
    'already committed with different content',
  );
  assert.equal(world.counters.appends, appendsAfterFirst, 'a conflicting retry writes nothing');
  assert.equal(world.counters.admitCalls, admitsAfterFirst, 'a conflicting retry does not re-register');
});

test('invalid pre-admission facts append nothing and never register', async () => {
  const world = await makeWorld();

  world.setReceipt(businessTurnId, { status: 'failed', reason: 'save failed' });
  const failed = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2 }));
  assert.equal(failed.status, 'receipt-held');
  if (failed.status === 'receipt-held') assert.equal(failed.segmentId, businessTurnId);
  assert.equal(world.counters.appends, 0);
  assert.equal(world.counters.admitCalls, 0, 'a failed predecessor receipt must not register');

  world.setReceipt(businessTurnId, { status: 'unknown', reason: 'save outcome unknown' });
  const unknown = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2 }));
  assert.equal(unknown.status, 'receipt-held');
  assert.equal(world.counters.appends, 0);
  assert.equal(world.counters.admitCalls, 0, 'an unknown predecessor receipt must not register');

  world.setReceipt(businessTurnId, { status: 'exact', recoveryAssetsReceiptRef: 'receipt-initial' });

  // Epoch guard runs before admission.
  await expectRejects(
    () => resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-bad', executionEpoch: 1 })),
    'advance to a new execution epoch',
  );
  assert.equal(world.counters.appends, 0);
  assert.equal(world.counters.admitCalls, 0, 'an invalid epoch must not register');

  // Assignment identity mismatch ends before registration.
  await expectRejects(
    () => resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-bad', executionEpoch: 2, assignment: { ...binding.assignment, attempt: 2 } })),
    'keeps the original work assignment identity',
  );
  assert.equal(world.counters.admitCalls, 0);

  // Incarnation that does not keep the original assignment identity ends before registration.
  await expectRejects(
    () => resumeActiveTurnSegment({
      ...resumeInput(world, { segmentId: 'segment-bad', executionEpoch: 2 }),
      incarnation: { ...incarnationFor(2), assignmentId: 'other-assignment' },
    }),
    'keep the original work assignment identity',
  );
  assert.equal(world.counters.admitCalls, 0);

  // A denied current grant registers nothing and appends nothing.
  world.setAdmitMode('deny');
  const denied = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2 }));
  assert.equal(denied.status, 'grant-denied');
  assert.equal(world.counters.appends, 0, 'a denied grant must not append');
  assert.equal(world.counters.admitCalls, 1, 'a denied grant reached the admission boundary');
});

test('contract guards reject fabricated registration identity and mislinked chains', async () => {
  const world = await makeWorld();
  const ok = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2 }));
  assert.equal(ok.status, 'resumed');
  if (ok.status !== 'resumed') return;
  const segment = ok.segment;

  validateResumedTurnSegmentOpened(segment);
  expectThrows(
    () => validateResumedTurnSegmentOpened({ ...segment, businessRegistrationCommitRef: { ...segment.businessRegistrationCommitRef, commitId: segment.authorityCommitRef.commitId } }),
    'registration commit must be distinct',
  );
  expectThrows(
    () => validateResumedTurnSegmentOpened({ ...segment, inputIdentity: { ...segment.inputIdentity, requestRef: 'other' } }),
    'inputIdentity requestRef must match',
  );
  expectThrows(
    () => validateResumedTurnSegmentOpened({ ...segment, predecessor: { ...segment.predecessor, segmentId: segment.segmentId } }),
    'cannot precede itself',
  );

  // A consistently relabeled original epoch is rejected by the chain validator:
  // the derived business turn still keeps the original epoch.
  const rewritten: ActiveTurnCaptureBody = {
    ...world.body,
    binding: {
      ...world.body.binding,
      execution: { runtimeId: 'runtime-a', executionEpoch: 2 },
      assignment: { ...world.body.binding.assignment, executionEpoch: 2 },
      admittedTurn: { ...world.body.binding.admittedTurn, executionEpoch: 2 },
    },
    entries: [],
    cut: { ...world.body.cut, lastSeq: 0 },
  };
  expectThrows(
    () => validateActiveTurnSegmentChainRead({ businessTurnRef: segment.businessTurnRef, initial: rewritten, segments: [] }),
    'original execution does not match',
  );
  // A segment that drops its predecessor link is rejected.
  expectThrows(
    () => validateActiveTurnSegmentChainRead({ businessTurnRef: segment.businessTurnRef, initial: world.body, segments: [{ ...segment, predecessor: { ...segment.predecessor, segmentId: 'not-the-initial' } }] }),
    'precede-link the derived initial segment',
  );

  // The segment-open intent rejects a self-predecessor.
  const intent: ActiveTurnSegmentOpenIntent = {
    businessTurnRef: segment.businessTurnRef,
    segmentId: 'segment-e9',
    predecessor: { segmentId: 'segment-e9', recoveryAssetsReceiptRef: 'receipt-x' },
    binding: segment.binding,
    initialInput,
  };
  expectThrows(() => validateActiveTurnSegmentOpenIntent(intent), 'cannot precede itself');
});

test('prepared segment capture v2 validates real drains and rejects wrong epoch or boundary', async () => {
  const world = await makeWorld();
  const ok = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-e2', executionEpoch: 2 }));
  assert.equal(ok.status, 'resumed');
  if (ok.status !== 'resumed') return;
  const segment = ok.segment;

  const epoch2Entry: AcceptedRawFact = { seq: 1, envelope: envelope({ runtimeId: 'runtime-a', executionEpoch: 2 }, 1) };
  const body: ActiveTurnSegmentCaptureV2 = {
    version: 2,
    segmentId: 'segment-e2',
    businessTurnRef: segment.businessTurnRef,
    binding: segment.binding,
    initialInput,
    entries: [epoch2Entry],
    requests: [requestRecord],
    childInvocations: [],
    cut: { pauseId: 'boundary-2', lastSeq: 1, producersDrained: true, frozenAt: '2026-10-13T00:00:00.000Z' },
    predecessor: segment.predecessor,
  };
  validateActiveTurnSegmentCaptureV2(body);
  assert.equal(JSON.stringify(body.initialInput), JSON.stringify(initialInput));

  const drain: ProviderProducerDrainResult = {
    execution: { runtimeId: 'runtime-a', executionEpoch: 2 },
    boundaryId: 'boundary-2',
    requests: [{ request, lastProducerSeq: 1 }],
  };
  const recovery: RecoveryHoldFacts = {
    commitIdentity: 'recovery:segment-fixture',
    laterErrorRefs: [],
    rawTurnRefs: [],
    unresolvedOperationRefs: [],
    stages: [],
    durablePhases: [],
    durableReceiptRefs: [],
    recoveryResponsibilityRef: 'recovery:r1',
  };
  const lookup = (executionEpoch: number): CompletionReadInput => ({
    commitIdentity: 'completion-commit',
    binding: { execution: { runtimeId: 'runtime-a', executionEpoch, taskId } },
    effectId: `file-write-effect:v1:${'a'.repeat(64)}`,
  } as unknown as CompletionReadInput);

  const prepared: PreparedActiveTurnSegmentCaptureV2 = {
    body,
    controlRecordCount: 3,
    producerDrains: [drain],
    completionLookups: [lookup(2)],
    recovery,
  };
  validatePreparedActiveTurnSegmentCaptureV2(prepared);

  expectThrows(
    () => validatePreparedActiveTurnSegmentCaptureV2({ ...prepared, producerDrains: [{ ...drain, execution: { runtimeId: 'runtime-a', executionEpoch: 1 } }] }),
    'does not belong to this segment boundary and execution',
  );
  expectThrows(
    () => validatePreparedActiveTurnSegmentCaptureV2({ ...prepared, producerDrains: [{ ...drain, boundaryId: 'boundary-x' }] }),
    'does not belong to this segment boundary and execution',
  );
  expectThrows(
    () => validatePreparedActiveTurnSegmentCaptureV2({ ...prepared, producerDrains: [] }),
    'request has no producer drain',
  );
  expectThrows(
    () => validatePreparedActiveTurnSegmentCaptureV2({ ...prepared, completionLookups: [lookup(1)] }),
    'completion lookup does not belong to the captured segment execution',
  );

  // The v2 capture itself requires the locating segmentId and a real predecessor.
  expectThrows(() => validateActiveTurnSegmentCaptureV2({ ...body, segmentId: '' }), 'segmentId');
  expectThrows(
    () => validateActiveTurnSegmentCaptureV2({ ...body, predecessor: { ...body.predecessor, segmentId: body.segmentId } }),
    'cannot precede itself',
  );
});

test('segment capture v2 shares child selection validation with the v1 capture', async () => {
  const world = await makeWorld();
  const ok = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-child', executionEpoch: 2 }));
  assert.equal(ok.status, 'resumed');
  if (ok.status !== 'resumed') return;
  const segment = ok.segment;

  const childAssignment: WorkAssignment = {
    ...binding.assignment,
    assignmentId: 'segment-child-assignment',
    pipelineNodeId: 'segment-child-node',
    executionEpoch: 2,
  };
  const childResult: WorkResult = {
    taskId, pipelineNodeId: 'segment-child-node', agentId: 'segment-child-agent', assignmentId: 'segment-child-assignment',
    attempt: 1, executionEpoch: 2, inputRevision: 1, producedArtifactRefs: [], producedArtifactDigests: [],
    status: 'succeeded', summary: 'segment child delivery', outputRefs: [],
    evidenceRefs: [{ evidenceId: id('evidence', 'segment-child-result'), kind: 'execution', source: 'segment-fixture', locator: 'segment-child-result', digest: digestA, scope }],
    nextAction: 'settle',
  };
  const childDelivery: AcceptedChildDelivery = {
    kind: 'execution', seq: 2, invocationId: 'segment-child-invocation',
    refinedDelivery: { ref: { evidenceId: id('evidence', 'segment-child-refined'), kind: 'execution', source: 'segment-fixture', locator: 'segment-child-refined', digest: digestB, scope }, view: { kind: 'utf8-text' } },
    assignment: childAssignment,
    result: childResult,
  };
  const epoch2Entry: AcceptedRawFact = { seq: 1, envelope: envelope({ runtimeId: 'runtime-a', executionEpoch: 2 }, 1) };
  const body: ActiveTurnSegmentCaptureV2 = {
    version: 2,
    segmentId: 'segment-child',
    businessTurnRef: segment.businessTurnRef,
    binding: segment.binding,
    initialInput,
    entries: [epoch2Entry, childDelivery],
    requests: [requestRecord],
    childInvocations: [{
      invocationId: 'segment-child-invocation', childTurnId: 'segment-child-turn', checkpointReceiptRef: 'segment-child-pre',
      binding: { kind: 'execution', assignment: childAssignment }, notSelectedResultSeq: 2,
    }],
    cut: { pauseId: 'boundary-child', lastSeq: 2, producersDrained: true, frozenAt: '2026-10-13T00:02:00.000Z' },
    predecessor: segment.predecessor,
  };
  validateActiveTurnSegmentCaptureV2(body);
  expectThrows(
    () => validateActiveTurnSegmentCaptureV2({ ...body, childInvocations: [{ ...body.childInvocations[0]!, adoptedResultSeq: 2 }] }),
    'cannot both adopt and not select',
  );
  expectThrows(
    () => validateActiveTurnSegmentCaptureV2({ ...body, childInvocations: [{ ...body.childInvocations[0]!, notSelectedResultSeq: 99 }] }),
    'must reference an accepted entry',
  );
});

test('the resumed segment shares the non-selection transition and obligation fold', async () => {
  const world = await makeWorld();
  const ok = await resumeActiveTurnSegment(resumeInput(world, { segmentId: 'segment-ns', executionEpoch: 2 }));
  assert.equal(ok.status, 'resumed');
  if (ok.status !== 'resumed') return;

  const childAssignment: WorkAssignment = {
    ...binding.assignment,
    assignmentId: 'segment-ns-assignment',
    pipelineNodeId: 'segment-ns-node',
    executionEpoch: 2,
  };
  const childResult: WorkResult = {
    taskId, pipelineNodeId: 'segment-ns-node', agentId: 'segment-ns-agent', assignmentId: 'segment-ns-assignment',
    attempt: 1, executionEpoch: 2, inputRevision: 1, producedArtifactRefs: [], producedArtifactDigests: [],
    status: 'succeeded', summary: 'segment non-selection delivery', outputRefs: [],
    evidenceRefs: [{ evidenceId: id('evidence', 'segment-ns-result'), kind: 'execution', source: 'segment-fixture', locator: 'segment-ns-result', digest: digestA, scope }],
    nextAction: 'settle',
  };
  const refinedDelivery: RawAsset = {
    ref: { evidenceId: id('evidence', 'segment-ns-refined'), kind: 'execution', source: 'segment-fixture', locator: 'segment-ns-refined', digest: digestB, scope },
    view: { kind: 'utf8-text' },
  };

  const records: ActiveTurnSegmentRecord[] = [];
  const commits: string[] = [];
  const port: ActiveTurnSegmentRecordPort = {
    async appendSegmentRecord({ commitId, record }) {
      commits.push(commitId);
      records.push(structuredClone(record));
      return { commitId, journalSeq: records.length, recordDigest: digestC };
    },
    async readSegmentRecords() { return structuredClone(records); },
  };
  const segment = await ActiveTurnSegmentContext.open({ segment: ok.segment, initialInput, port });
  await segment.openChildInvocation({
    invocationId: 'segment-ns-inv', childTurnId: 'segment-ns-turn', checkpointReceiptRef: 'segment-ns-pre',
    binding: { kind: 'execution', assignment: childAssignment },
  });
  let prefix = await segment.readLivePrefix();
  assert.deepEqual(prefix.obligations, [{ kind: 'child-invocation', invocationId: 'segment-ns-inv', phase: 'pending' }]);

  const delivery = await segment.recordChildReturn({
    kind: 'execution', invocationId: 'segment-ns-inv', assignment: childAssignment, result: childResult,
    refinedDelivery,
  });
  prefix = await segment.readLivePrefix();
  assert.deepEqual(prefix.obligations, [{ kind: 'child-invocation', invocationId: 'segment-ns-inv', phase: 'pending' }]);

  await segment.recordChildNonSelection('segment-ns-inv');
  assert.equal(segment.childInvocations()[0]!.notSelectedResultSeq, delivery.seq);
  prefix = await segment.readLivePrefix();
  assert.deepEqual(prefix.obligations, []);
  assert.equal(commits.at(-1), activeTurnSegmentCommitId('segment-ns', 'not-selected:segment-ns-inv'));
});
