import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type ActiveTurnBinding,
  type RawAsset,
  type RuntimeRequestRecord,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import type {
  CheckpointControlBusinessRequest,
  CheckpointControlCapabilityRef,
} from '../../../packages/contracts/src/checkpoint-controls.js';
import type { JournalCommitRef } from '../../../packages/contracts/src/i2-history.js';
import type { TaskRuntimeIncarnation } from '../../../packages/contracts/src/framework.js';
import {
  activeTurnSegmentCommitId,
  originalBusinessTurnRefFromBinding,
  type ActiveTurnInitialOpenAnchor,
  type ResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import { activeTurnCommitId } from '../../../packages/runtime/src/context/active-turn-journal.js';
import type { TaskGrantAuthority, TaskGrantRegistrationPort } from '../../../packages/runtime/src/admission/task-grant.js';
import {
  JournalIntegrityError,
  JsonlOrganJournal,
} from '../../../packages/adapters/jsonl/src/index.js';
import {
  createJsonlActiveTurnJournal,
  createJsonlActiveTurnSegmentJournal,
} from '../../../packages/adapters/jsonl/src/active-turn.js';
import { JsonlTaskGrantJournal } from '../../../packages/adapters/jsonl/src/task-grants.js';

/**
 * Real JSONL consumer for the initial-open recovery foundation. It drives the
 * actual shared Organ Journal and the actual adapter transaction/fence, so the
 * captured failure is a runtime rejection rather than a type error.
 */

const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-interrupted-segment-recovery-20261015');

const organId = id('organ', 'jsonl-initial-organ');
const taskId = id('task', 'jsonl-initial-task');
const cycleId = id('cycle', 'jsonl-initial-cycle');
const scope: ScopeRef = { organId, taskId, cycleId };
const turnId = 'jsonl-initial-turn';
const owner = 'jsonl-initial-owner';
const digestA = `sha256:${'a'.repeat(64)}`;
const capability: CheckpointControlCapabilityRef = {
  actionId: 'checkpoint.save',
  capabilities: ['provider.execution'],
  scope,
};

const binding: ActiveTurnBinding = {
  execution: { runtimeId: 'jsonl-runtime', executionEpoch: 1 },
  scope,
  admittedTurn: {
    turnId,
    workAssignmentRef: 'jsonl-assignment',
    taskRef: taskId,
    scopeRef: scope,
    cycleRef: cycleId,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: 1,
    runtimeBindingRef: 'jsonl-runtime',
    permissionRevision: 'grant-1',
    admissionEvidenceRefs: [],
    currentTurnRef: 'current',
    recoveryStateRef: 'recovery',
  },
  assignment: {
    assignmentId: 'jsonl-assignment',
    taskId,
    pipelineNodeId: 'jsonl-node',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'exercise initial-open anchor recovery',
    targetRefs: [],
    expectedOutputRefs: [],
    acceptanceCriteriaDigest: 'sha256:criteria',
    successCriteria: ['recovered'],
    failureCriteria: ['lost'],
    incompleteCriteria: ['pending'],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  },
};

const initialInput: RawAsset = {
  ref: {
    evidenceId: id('evidence', 'jsonl-initial-input'),
    kind: 'execution',
    source: 'jsonl-initial-fixture',
    locator: 'jsonl-initial-input',
    digest: digestA,
    scope,
  },
  view: { kind: 'utf8-text' },
};

const requestRecord: RuntimeRequestRecord = {
  request: { turnId, requestId: 'jsonl-request-1' },
  scope,
  phase: 'waiting',
};

async function withFixture(fn: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(PERSISTENCE_ROOT, 'jsonl-active-turn-'));
  const path = join(root, 'organ.jsonl');
  try {
    await fn(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function incarnationFor(epoch: number): TaskRuntimeIncarnation {
  return {
    runtimeId: 'jsonl-runtime',
    generation: epoch,
    agentInstanceId: `jsonl-agent-${epoch}`,
    roleId: 'role-executor',
    taskId,
    assignmentId: binding.assignment.assignmentId,
    executionEpoch: epoch,
  };
}

async function openInitialTurn(journal: JsonlOrganJournal): Promise<void> {
  const active = createJsonlActiveTurnJournal({ journal, turnId });
  await active.append({
    commitId: activeTurnCommitId(turnId, 'binding-opened'),
    record: { kind: 'binding-opened', binding, currentTurnRef: 'current' },
  });
  await active.append({
    commitId: activeTurnCommitId(turnId, 'initial-input'),
    record: { kind: 'initial-input', content: initialInput },
  });
  await active.append({
    commitId: activeTurnCommitId(turnId, `request:${requestRecord.request.requestId}:${requestRecord.phase}`),
    record: { kind: 'request', record: requestRecord },
  });
}

/**
 * Register one real TG1 business reservation under the held grant transaction
 * so the returned commits are the durable records the segment-opened append
 * re-verifies. The grant itself is committed once by the caller.
 */
async function registerSegment(
  grantJournal: JsonlTaskGrantJournal,
  segmentId: string,
): Promise<{ authorityCommitRef: JournalCommitRef; businessRegistrationCommitRef: JournalCommitRef; requestRef: string }> {
  const requestRef = `segment-open:${turnId}:${segmentId}`;
  const request: CheckpointControlBusinessRequest = {
    requestRef,
    taskId,
    owner,
    capability,
    inputIdentity: { requestRef, digest: digestA },
  };
  const businessRegistrationCommitRef = await grantJournal.withAuthorizedNewBusiness(
    request,
    async (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) => registration.registerBusiness({
      requestRef,
      taskId,
      owner,
      capability,
      inputIdentity: { requestRef, digest: digestA },
      grantRevision: authority.grant.revision,
    }),
  );
  const authorityCommitRef = (await grantJournal.readTaskGrant(taskId)).commit;
  if (authorityCommitRef === null) throw new Error('the grant readback is missing its commit');
  return { authorityCommitRef, businessRegistrationCommitRef, requestRef };
}

function segmentOpenedFor(input: {
  readonly segmentId: string;
  readonly anchor: ActiveTurnInitialOpenAnchor;
  readonly businessTurnRef: ReturnType<typeof originalBusinessTurnRefFromBinding>;
  readonly epoch: number;
  readonly authorityCommitRef: ResumedTurnSegmentOpened['authorityCommitRef'];
  readonly businessRegistrationCommitRef: ResumedTurnSegmentOpened['businessRegistrationCommitRef'];
  readonly requestRef: string;
}): ResumedTurnSegmentOpened {
  return {
    kind: 'segment-opened',
    segmentId: input.segmentId,
    businessTurnRef: input.businessTurnRef,
    predecessor: { segmentId: turnId, initialOpen: input.anchor },
    binding: {
      businessTurnRef: input.businessTurnRef,
      assignment: { ...binding.assignment, executionEpoch: input.epoch },
      execution: { runtimeId: 'jsonl-runtime', executionEpoch: input.epoch },
      incarnation: incarnationFor(input.epoch),
      scope,
    },
    authorityCommitRef: input.authorityCommitRef,
    businessRegistrationCommitRef: input.businessRegistrationCommitRef,
    requestRef: input.requestRef,
    inputIdentity: { requestRef: input.requestRef, digest: digestA },
  };
}

test('initial-open anchor exact read: real binding and record tail, then stale anchor rejects', async () => {
  await withFixture(async (journalPath) => {
    const journal = new JsonlOrganJournal(journalPath);
    await openInitialTurn(journal);

    const segmentJournal = createJsonlActiveTurnSegmentJournal({ journal, businessTurnId: turnId });
    const anchor = await segmentJournal.readInitialOpenAnchor();
    assert.ok(anchor, 'an opened v1 turn must expose its initial-open anchor');
    if (!anchor) return;
    assert.equal(anchor.bindingCommitRef.commitId, activeTurnCommitId(turnId, 'binding-opened'));
    assert.equal(
      anchor.recordsThroughCommitRef.commitId,
      activeTurnCommitId(turnId, `request:${requestRecord.request.requestId}:${requestRecord.phase}`),
    );

    const exact = await segmentJournal.readInitialOpenExact({ businessTurnId: turnId, anchor });
    assert.equal(exact.prefix.kind, 'live-accepted-prefix');
    assert.equal(exact.prefix.source, turnId);
    assert.deepEqual(exact.prefix.requests, [requestRecord]);
    assert.deepEqual(exact.prefix.initialInput, initialInput);

    // A stale anchor must fail instead of reading a changed tail.
    await assert.rejects(
      () => segmentJournal.readInitialOpenExact({
        businessTurnId: turnId,
        anchor: { ...anchor, recordsThroughCommitRef: { ...anchor.recordsThroughCommitRef, journalSeq: anchor.recordsThroughCommitRef.journalSeq - 1 } },
      }),
      (error: unknown) => error instanceof JournalIntegrityError
        && error.message.includes('initial-open anchor does not match'),
    );
  });
});

test('initial-open append rechecks the anchor under the lock and fences a later v1 writer', async () => {
  await withFixture(async (journalPath) => {
    const journal = new JsonlOrganJournal(journalPath);
    await openInitialTurn(journal);
    const active = createJsonlActiveTurnJournal({ journal, turnId });
    const oldRecord = {
      commitId: activeTurnCommitId(turnId, `request:${requestRecord.request.requestId}:${requestRecord.phase}`),
      record: { kind: 'request' as const, record: requestRecord },
    };
    const bytesAfterOld = await readFile(journalPath, 'utf8');

    // Exact old-commit retry: same identity and content returns without a new record.
    await active.append(oldRecord);
    assert.equal(await readFile(journalPath, 'utf8'), bytesAfterOld);

    const grantJournal = new JsonlTaskGrantJournal(journal);
    await grantJournal.grant({ requestId: 'grant-once', taskId, owner, capability, expectedRevision: 0 });
    const segmentJournal = createJsonlActiveTurnSegmentJournal({ journal, businessTurnId: turnId });
    const anchor = await segmentJournal.readInitialOpenAnchor();
    assert.ok(anchor);
    if (!anchor) return;
    const businessTurnRef = originalBusinessTurnRefFromBinding(anchor.bindingCommitRef, binding);

    // A stale initial-open anchor must be rejected before any commit is written.
    const staleAnchor: ActiveTurnInitialOpenAnchor = {
      ...anchor,
      recordsThroughCommitRef: { ...anchor.recordsThroughCommitRef, journalSeq: anchor.recordsThroughCommitRef.journalSeq - 1 },
    };
    const staleGrant = await registerSegment(grantJournal, 'jsonl-stale');
    await assert.rejects(
      () => segmentJournal.appendSegmentOpened({
        commitId: activeTurnSegmentCommitId('jsonl-stale', 'segment-opened'),
        record: segmentOpenedFor({ segmentId: 'jsonl-stale', anchor: staleAnchor, businessTurnRef, epoch: 2, ...staleGrant }),
      }),
      (error: unknown) => error instanceof JournalIntegrityError
        && error.message.includes('initial-open anchor does not match'),
    );

    // The exact anchor opens the successor segment under the shared Journal lock.
    const realGrant = await registerSegment(grantJournal, 'jsonl-segment-2');
    const opened = await segmentJournal.appendSegmentOpened({
      commitId: activeTurnSegmentCommitId('jsonl-segment-2', 'segment-opened'),
      record: segmentOpenedFor({ segmentId: 'jsonl-segment-2', anchor, businessTurnRef, epoch: 2, ...realGrant }),
    });
    assert.equal(opened.commitId, activeTurnSegmentCommitId('jsonl-segment-2', 'segment-opened'));
    const bytesAfterSuccessor = await readFile(journalPath, 'utf8');

    // A late epoch-1 writer with a new record is fenced by the retired original.
    await assert.rejects(
      () => active.append({
        commitId: activeTurnCommitId(turnId, `request:${requestRecord.request.requestId}:settled`),
        record: { kind: 'request', record: { ...requestRecord, phase: 'settled' } },
      }),
      (error: unknown) => error instanceof JournalIntegrityError
        && error.message.includes('active turn append is fenced'),
    );
    assert.equal(await readFile(journalPath, 'utf8'), bytesAfterSuccessor);
  });
});
