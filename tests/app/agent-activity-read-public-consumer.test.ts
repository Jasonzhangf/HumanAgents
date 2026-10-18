import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type ActiveTurnBinding,
  type AdmittedTurn,
  type EvidenceRef,
  type RawAsset,
  type ScopeRef,
  type TaskRuntimeIncarnation,
  type WorkAssignment,
  type ReviewAssignment,
  type MilestoneReviewResultRecord,
  type I2JournalPort,
} from '../../packages/contracts/src/index.js';
import { activeTurnSegmentCommitId, originalBusinessTurnRefFromBinding } from '../../packages/contracts/src/active-turn-segments.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import {
  activeTurnCommitId,
} from '../../packages/runtime/src/context/active-turn-journal.js';
import {
  createJsonlActiveTurnJournal,
  createJsonlActiveTurnSegmentJournal,
} from '../../packages/adapters/jsonl/src/active-turn.js';
import {
  JsonlTaskGrantJournal,
} from '../../packages/adapters/jsonl/src/task-grants.js';
import type {
  TaskGrantAuthority,
  TaskGrantRegistrationPort,
} from '../../packages/runtime/src/admission/task-grant.js';
import { createJsonlCheckpointClosurePort } from '../../packages/app/src/checkpoint-journal.js';
import { closureFromRecord } from '../../packages/app/src/checkpoint-journal.js';
import {
  readUiRuntimeTaskJournal,
  uiRuntimeJournalPath,
  UiRuntimeJournal,
} from '../../packages/app/src/ui-runtime/journal.js';
import {
  assembleTaskAgentActivityCoreSources,
  decodeTaskAgentActivitySelectionQuery,
  readTaskAgentActivityCore,
  readTaskAgentActivity,
} from '../../packages/app/src/ui-runtime/agent-activity-read.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import { createJsonlClosedTurnPlannerCallJournal } from '../../packages/app/src/ui-runtime/planner-call-journal.js';
import type { ClosedTurnPlannerCallPreparationRecord } from '../../packages/runtime/src/orchestration/closed-turn-planner-call.js';

// Failure modes and cost are recorded in the accepted r2 note before this test.
// The fixture writes real UI/control JSONL through the owning public writers.
const fixtureRoot = '/private/tmp/humanagent-agent-activity-reader-finish';

const organId = id('organ', 'agent-activity-organ');
const taskId = id('task', 'ui-task-implicit-draft-2');
const cycleId = id('cycle', 'ui-cycle-1');
const operationId = id('operation', 'ui-operation-1');
const scope: ScopeRef = { organId, taskId, cycleId, operationId };
const turnId = 'active-turn-ui-operation-1';
const runtimeId = 'ui-runtime-ui-operation-1';
const assignmentId = 'assignment-ui-operation-1';
const owner = 'agent-activity-reader-consumer';

const assignment: WorkAssignment = {
  assignmentId,
  taskId,
  pipelineNodeId: 'node-1',
  attempt: 1,
  executionEpoch: 1,
  inputRevision: 1,
  objective: 'read the original task assignment',
  targetRefs: ['operation://ui-operation-1'],
  expectedOutputRefs: ['operation://ui-operation-1/output'],
  successCriteria: ['activity reads the real assignment'],
  failureCriteria: ['activity invents an assignment epoch'],
  incompleteCriteria: ['activity source is unverified'],
  requiredCapabilities: ['provider.execution'],
  mergeGate: 'not-required',
};

const admittedTurn: AdmittedTurn = {
  turnId,
  workAssignmentRef: assignmentId,
  taskRef: taskId,
  scopeRef: scope,
  cycleRef: cycleId,
  inputRevision: 1,
  directiveRevision: 1,
  executionEpoch: 1,
  runtimeBindingRef: runtimeId,
  permissionRevision: 'permission-1',
  admissionEvidenceRefs: [],
  currentTurnRef: `active-turn://${turnId}`,
  recoveryStateRef: `recovery://${turnId}`,
};

const binding: ActiveTurnBinding = {
  admittedTurn,
  assignment,
  execution: { runtimeId, executionEpoch: 1 },
  scope,
};

function rawInitialInput(): RawAsset {
  const digest = `sha256:${createHash('sha256').update('read agent activity').digest('hex')}`;
  const ref: EvidenceRef = {
    evidenceId: id('evidence', 'agent-activity-initial-input'),
    kind: 'operation',
    source: owner,
    locator: 'humanagent://agent-activity/initial-input',
    digest,
    scope,
  };
  return { ref, view: { kind: 'utf8-text' } };
}

function incarnationFor(executionEpoch: number): TaskRuntimeIncarnation {
  return {
    runtimeId: 'orchestration-runtime-1',
    generation: 1,
    agentInstanceId: 'd5b33ff4-ee6a-4b5b-bbff-bd5fe0eb0715',
    roleId: 'orchestration',
    taskId,
    assignmentId,
    executionEpoch,
  };
}

async function commitTurnClosure(journal: JsonlOrganJournal, journalPath: string): Promise<void> {
  const closurePort = createJsonlCheckpointClosurePort({ filePath: journalPath, journal });
  const recoveryStateRef: EvidenceRef = {
    evidenceId: id('evidence', 'agent-activity-turn-recovery'),
    kind: 'execution',
    source: owner,
    locator: `turn://${turnId}/recovery`,
    scope,
  };
  await closurePort.commit({
    closureKind: 'turn-closure',
    closureId: `turn-closure:${turnId}`,
    identity: {
      turnId,
      workAssignmentRef: assignmentId,
      taskRef: taskId,
      scopeRef: scope,
      cycleRef: cycleId,
      inputRevision: admittedTurn.inputRevision,
      directiveRevision: admittedTurn.directiveRevision,
      executionEpoch: admittedTurn.executionEpoch,
      runtimeBindingRef: admittedTurn.runtimeBindingRef,
      permissionRevision: admittedTurn.permissionRevision,
    },
    checkpointId: id('checkpoint', `turn-${turnId}-1`),
    closureRef: `turn-closure:${turnId}:1`,
    recoveryStateRef,
    summary: {
      goal: { text: 'read the original task assignment', evidenceRefs: [rawInitialInput().ref] },
      actions: { text: 'read the assigned activity sources', evidenceRefs: [rawInitialInput().ref] },
      result: { text: 'the original assignment was read', evidenceRefs: [rawInitialInput().ref] },
      expectedNextStep: { text: 'continue with the original assignment', evidenceRefs: [rawInitialInput().ref] },
    },
    closedAt: '2026-10-16T00:00:02.000Z',
  });
}

async function createControlJournal(journalPath: string, withResumedSegment: boolean,
  beforeResume?: (journal: JsonlOrganJournal) => Promise<void>): Promise<JsonlOrganJournal> {
  const journal = new JsonlOrganJournal(journalPath);
  const activeTurn = createJsonlActiveTurnJournal({ journal, turnId });
  await activeTurn.append({
    commitId: activeTurnCommitId(turnId, 'binding-opened'),
    record: { kind: 'binding-opened', binding, currentTurnRef: admittedTurn.currentTurnRef },
  });
  await activeTurn.append({
    commitId: activeTurnCommitId(turnId, 'initial-input'),
    record: { kind: 'initial-input', content: rawInitialInput() },
  });
  await beforeResume?.(journal);
  if (!withResumedSegment) {
    await commitTurnClosure(journal, journalPath);
    return journal;
  }

  const grantJournal = new JsonlTaskGrantJournal(journal);
  const capability = {
    actionId: 'checkpoint.save',
    capabilities: ['provider.execution'],
    scope,
  };
  await grantJournal.grant({
    requestId: `grant-${turnId}-1`,
    taskId,
    owner,
    capability,
    expectedRevision: 0,
  });

  const segmentId = 'resumed-orchestration-1';
  const requestRef = `segment-open:${turnId}:${segmentId}`;
  const intentDigest = `sha256:${createHash('sha256').update(`${requestRef}:epoch-3`).digest('hex')}`;
  const request = {
    requestRef,
    taskId,
    owner,
    capability,
    inputIdentity: { requestRef, digest: intentDigest },
  };
  const businessRegistrationCommitRef = await grantJournal.withAuthorizedNewBusiness(
    request,
    async (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) =>
      registration.registerBusiness({
        ...request,
        grantRevision: authority.grant.revision,
      }),
  );
  const authorityCommitRef = (await grantJournal.readTaskGrant(taskId)).commit;
  if (authorityCommitRef === null) throw new Error('grant readback is missing its commit');

  const segmentJournal = createJsonlActiveTurnSegmentJournal({ journal, businessTurnId: turnId });
  const anchor = await segmentJournal.readInitialOpenAnchor();
  const bindingCommitRef = await segmentJournal.readInitialBindingCommit();
  if (anchor === null) throw new Error('initial-open anchor is missing');
  const businessTurnRef = originalBusinessTurnRefFromBinding(bindingCommitRef, binding);
  const incarnation = incarnationFor(3);
  await segmentJournal.appendSegmentOpened({
    commitId: activeTurnSegmentCommitId(segmentId, 'segment-opened'),
    record: {
      kind: 'segment-opened',
      segmentId,
      businessTurnRef,
      predecessor: { segmentId: turnId, initialOpen: anchor },
      binding: {
        businessTurnRef,
        assignment,
        execution: { runtimeId: incarnation.runtimeId, executionEpoch: incarnation.executionEpoch },
        incarnation,
        scope,
      },
      authorityCommitRef,
      businessRegistrationCommitRef,
      requestRef,
      inputIdentity: { requestRef, digest: intentDigest },
    },
  });
  await commitTurnClosure(journal, journalPath);
  return journal;
}

async function fixture(withResumedSegment: boolean, beforeResume?: (journal: JsonlOrganJournal) => Promise<void>) {
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'reader-'));
  const checkpointsRoot = join(root, 'checkpoints');
  const uiJournalPath = uiRuntimeJournalPath(checkpointsRoot, 'rcc');
  const uiJournal = new UiRuntimeJournal(uiJournalPath);
  uiJournal.append({
    kind: 'task.created',
    taskId,
    title: 'Agent activity reader',
    directive: 'read the original task assignment',
    directiveRevision: 1,
    createdAt: '2026-10-16T00:00:00.000Z',
    taskCounter: 1,
  });
  uiJournal.append({
    kind: 'operation.prepared',
    allocation: {
      runtimeId,
      taskId,
      operationId,
      executionEpoch: 1,
      assignmentId,
      scope,
      inputRefs: ['operation://ui-operation-1/input'],
      ownerId: owner,
      directiveRevision: 1,
      inputRevision: 1,
      orchestrated: false,
    },
    input: 'read the original task assignment',
    operationCounter: 1,
    cycleCounter: 1,
  });
  // Counter-example: a later revision must not rewrite an older allocation.
  uiJournal.append({
    kind: 'task.updated',
    taskId,
    title: 'Agent activity reader',
    directive: 'updated directive that must not replace the original allocation',
    directiveRevision: 2,
    updatedAt: '2026-10-16T00:00:01.000Z',
  });
  const taskJournal = readUiRuntimeTaskJournal(checkpointsRoot, 'rcc');
  const controlJournal = await createControlJournal(join(root, 'task-control.jsonl'), withResumedSegment, beforeResume);
  return { root, taskJournal, controlJournal };
}

test('decodeTaskAgentActivitySelectionQuery rejects unknown, duplicate and half selections', () => {
  const unknown = decodeTaskAgentActivitySelectionQuery(new URLSearchParams('agentFoo=1'), taskId);
  assert.equal(unknown.ok, false);
  if (unknown.ok) return;
  assert.equal(unknown.failure.code, 'agent-activity.invalid-selection');
  assert.match(unknown.failure.message, /agentFoo/);

  const duplicate = decodeTaskAgentActivitySelectionQuery(
    new URLSearchParams('agentKind=native-execution&agentKind=incarnation'),
    taskId,
  );
  assert.equal(duplicate.ok, false);

  const half = decodeTaskAgentActivitySelectionQuery(
    new URLSearchParams('agentKind=incarnation&agentRuntimeId=runtime-1'),
    taskId,
  );
  assert.equal(half.ok, false);

  const selected = decodeTaskAgentActivitySelectionQuery(
    new URLSearchParams(
      'agentKind=incarnation'
      + '&agentRuntimeId=orchestration-runtime-1'
      + '&agentExecutionEpoch=3'
      + '&agentRoleId=orchestration'
      + '&agentGeneration=1'
      + '&agentInstanceId=d5b33ff4-ee6a-4b5b-bbff-bd5fe0eb0715'
      + `&agentAssignmentId=${assignmentId}`,
    ),
    taskId,
  );
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(selected.value.taskId.value, taskId.value);
  assert.equal(selected.value.instance?.kind, 'incarnation');
  if (selected.value.instance?.kind !== 'incarnation') return;
  assert.equal(selected.value.instance.incarnation.executionEpoch, 3);
  assert.equal(selected.value.instance.incarnation.assignmentId, assignmentId);

  const scoped = decodeTaskAgentActivitySelectionQuery(
    new URLSearchParams('task=untrusted-task&agentKind=native-execution&agentRuntimeId=runtime-1&agentExecutionEpoch=1'),
    taskId,
  );
  assert.equal(scoped.ok, true);
  if (!scoped.ok) return;
  assert.equal(scoped.value.taskId.value, taskId.value);
});

test('core reader projects native and active sources through A2/A3', async () => {
  const value = await fixture(false);
  try {
    const query = decodeTaskAgentActivitySelectionQuery(new URLSearchParams(), taskId);
    assert.equal(query.ok, true);
    if (!query.ok) return;
    const read = await readTaskAgentActivityCore({
      taskId,
      query: query.value,
      taskJournal: value.taskJournal,
      controlJournal: value.controlJournal,
      currentAuthority: { taskId, executionEpoch: 4, locations: [] },
      remainingSources: { childInvocations: [], runtimePoolLeases: [], milestoneReviews: [] },
    });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value.mode, 'catalog');
    assert.equal(read.value.historical.length, 2);
    assert.deepEqual(
      read.value.historical.map((entry) => entry.sourceKind).sort(),
      ['active-turn', 'native-allocation'],
    );
    const nativeEntry = read.value.historical.find((entry) => entry.sourceKind === 'native-allocation');
    assert.equal(nativeEntry?.objective, 'read the original task assignment');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

// Probability unknown; failure loses instances or binds another work target.
// Extending the existing public-writer fixture has low execution/maintenance cost.
test('high-level reader retains child instances and original review commits across I2 pages, with explicit missing targets', async () => {
    const childAssignment = { ...assignment, assignmentId: 'child-work', objective: 'review this exact child work' };
    const childInstance = { ...incarnationFor(1), runtimeId: 'child-runtime',
      agentInstanceId: 'child-instance', assignmentId: childAssignment.assignmentId };
    const reviewAssignment: ReviewAssignment = { assignmentId: 'child-review', taskId: taskId.value,
      workerAgentId: 'actual-worker', reviewKind: 'quality', attempt: 1, executionEpoch: 1, inputRevision: 1,
      subjectRefs: ['artifact://exact-child-output'],
      workerCapabilities: [], requiredCapabilities: [], mergeGate: 'not-required' };
    const missing = { ...reviewAssignment, assignmentId: 'missing-review', workerAgentId: 'unrelated-worker' };
    const value = await fixture(true, async (journal) => {
    const active = createJsonlActiveTurnJournal({ journal, turnId });
    const invocation = { invocationId: 'work-call', childTurnId: 'child-turn', checkpointReceiptRef: 'pre-call-only',
      binding: { kind: 'execution' as const, assignment: childAssignment }, incarnation: childInstance };
    await active.append({ commitId: activeTurnCommitId(turnId, 'invocation:work-call'),
      record: { kind: 'child-invocation', record: invocation } });
    await active.append({ commitId: activeTurnCommitId(turnId, 'delivery:work-call'), record: {
      kind: 'child-delivery', entry: { kind: 'execution', seq: 1, invocationId: 'work-call',
        refinedDelivery: rawInitialInput(), assignment: childAssignment,
        result: { taskId, pipelineNodeId: childAssignment.pipelineNodeId, agentId: 'actual-worker',
          assignmentId: childAssignment.assignmentId, attempt: 1, executionEpoch: 1, inputRevision: 1,
          producedArtifactRefs: ['artifact://exact-child-output'],
          status: 'succeeded', summary: 'done', outputRefs: childAssignment.expectedOutputRefs, evidenceRefs: [], nextAction: 'review' } },
    } });
    await active.append({ commitId: activeTurnCommitId(turnId, 'invocation:missing-review'), record: {
      kind: 'child-invocation', record: { invocationId: 'missing-review', childTurnId: 'missing-review-turn',
        checkpointReceiptRef: 'pre-review-only', binding: { kind: 'review', assignment: missing },
        incarnation: { ...childInstance, assignmentId: missing.assignmentId, agentInstanceId: 'missing-instance' } },
    } });
    });
  try {
    const segmentId = 'resumed-orchestration-1';
    const segment = createJsonlActiveTurnSegmentJournal({ journal: value.controlJournal, businessTurnId: turnId });
    await segment.appendSegmentRecord({ businessTurnId: turnId, segmentId,
      commitId: activeTurnSegmentCommitId(segmentId, 'invocation:segment-review'), record: {
        kind: 'child-invocation', record: { invocationId: 'segment-review', childTurnId: 'review-turn',
          checkpointReceiptRef: 'pre-review-only', binding: { kind: 'review', assignment: reviewAssignment },
          incarnation: { ...childInstance, runtimeId: 'review-runtime', agentInstanceId: 'review-instance',
            assignmentId: reviewAssignment.assignmentId } },
      } });
    const journal = createJsonlI2JournalPort({ filePath: join(value.root, 'task-control.jsonl'), journal: value.controlJournal });
    const milestone = (milestoneId: string, reviewed: ReviewAssignment): MilestoneReviewResultRecord => ({
      kind: 'milestone-review-result', schemaVersion: 1, milestoneId, cycleId,
      taskScope: { organId, taskId }, executionScope: scope,
      planRevisionCommitRef: { commitId: 'external:plan', journalSeq: 1, recordDigest: `sha256:${'0'.repeat(64)}` },
      reviewAssignment: reviewed, delivery: {
        reviewer: { ...childInstance, runtimeId: 'milestone-reviewer', assignmentId: reviewed.assignmentId,
          agentInstanceId: `reviewer-${milestoneId}` },
        result: { ...reviewed, resultId: `result-${milestoneId}`, status: 'passed', findings: [], evidenceRefs: [] },
        output: { text: 'passed', artifactRef: null, artifactDigest: null }, completedAt: '2026-10-16T00:01:00.000Z',
      }, completedAt: '2026-10-16T00:01:00.000Z',
    });
    const firstCommit = await journal.commit(milestone('missing-target', missing));
    const lastCommit = await journal.commit(milestone('exact-target', reviewAssignment));
    const cursors: (string | undefined)[] = [];
    const paged: I2JournalPort = { ...journal, list: async (input) => {
      cursors.push(input.cursor);
      return journal.list({ ...input, limit: 1 });
    } };
    let inspected = 0;
    const read = await readTaskAgentActivity({ taskId, query: { taskId }, taskJournal: value.taskJournal,
      controlJournal: value.controlJournal, i2Journal: paged, live: { inspectPool: () => {
        inspected += 1;
        const known = { runtimeId: childInstance.runtimeId, generation: 1,
          state: 'running' as const, capabilities: [], incarnation: childInstance,
          lease: { leaseId: 'read-only-lease', runtimeId: childInstance.runtimeId, generation: 1,
            incarnation: childInstance, executionEpoch: 1, ownerId: owner,
            assignmentId: childInstance.assignmentId, capabilities: [] } };
        const unknownInstance = { ...childInstance, agentInstanceId: 'unrelated-pool-instance', assignmentId: 'unknown-pool-assignment' };
        return { disposed: false, runtimes: [known, { ...known, incarnation: unknownInstance,
          lease: { ...known.lease, leaseId: 'unknown-lease', incarnation: unknownInstance,
            assignmentId: unknownInstance.assignmentId } }] };
      } } });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(inspected, 1);
    assert.equal(cursors.length, 2);
    assert.equal(cursors[0], undefined);
    assert.equal(cursors[1], String(firstCommit.journalSeq));
    const records = [...read.value.historical, ...read.value.unknown, ...read.value.current];
    const child = records.find((entry) => entry.sourceKind === 'child-invocation'
      && entry.assignmentId === childAssignment.assignmentId);
    assert.equal(child?.objective, childAssignment.objective);
    assert.equal(child?.instance.kind, 'incarnation');
    assert.equal(child?.instance.runtimeId, childInstance.runtimeId);
    if (child?.instance.kind === 'incarnation') assert.equal(child.instance.agentInstanceId, childInstance.agentInstanceId);
    assert.equal(child?.commitRefs[0]?.commitId, activeTurnCommitId(turnId, 'invocation:work-call'));
    assert.ok(read.value.historical.includes(child!));
    const review = records.find((entry) => entry.sourceKind === 'milestone-review');
    assert.deepEqual(review?.commitRefs[0], lastCommit);
    assert.equal(review?.objective, childAssignment.objective);
    assert.equal(review?.instance.kind, 'incarnation');
    if (review?.instance.kind === 'incarnation') assert.equal(review.instance.agentInstanceId, 'reviewer-exact-target');
    const segmentChild = records.find((entry) => entry.sourceKind === 'child-invocation'
      && entry.assignmentId === reviewAssignment.assignmentId);
    assert.equal(segmentChild?.commitRefs[0]?.commitId, activeTurnSegmentCommitId(segmentId, 'invocation:segment-review'));
    assert.ok(read.value.unknown.includes(segmentChild!), 'pre-call checkpoint must not prove child completion');
    assert.ok(read.value.unavailableSources.some((entry) => entry.sourceId === 'child-invocation:missing-review'));
    assert.ok(records.some((entry) => entry.sourceKind === 'runtime-pool-lease' && entry.objective === childAssignment.objective));
    assert.ok(read.value.unavailableSources.some((entry) => entry.sourceId === 'runtime-pool-lease:unknown-lease'));
    assert.ok(read.value.unavailableSources.some((entry) => entry.sourceId === `milestone-review:${firstCommit.commitId}`));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

// Probability unknown; the seventh source was omitted. Failure hides Planner
// calls or makes them historical early. Extending this fixture has low cost.
test('high-level reader retains epoch 1 Planner stages under epoch 3 Task authority until its own return', async () => {
  const value = await fixture(true);
  try {
    const incarnation = { ...incarnationFor(1), runtimeId: 'planner-runtime',
      agentInstanceId: 'planner-instance', assignmentId: 'planner-assignment' };
    const anchor = { commitId: 'fixture:planner-anchor', journalSeq: 1, recordDigest: 'fixture-anchor' };
    const checkpointId = id('checkpoint', 'planner-checkpoint');
    // This operation differs from the task's active operation. Task filtering
    // must retain it without replacing its physical epoch with Task authority.
    const plannerScope = { ...scope, operationId: id('operation', 'planner-operation') };
    const prepared: ClosedTurnPlannerCallPreparationRecord = {
      kind: 'closed-turn-planner-call', stage: 'prepared',
      duty: { dutyKey: 'planner-duty', taskId, scope: plannerScope,
        closureRef: 'fixture:closed-turn', checkpointId, checkpointCommitRef: anchor,
        inputDigest: 'fixture:planner-input', predecessorRevisionId: 'plan-1' },
      invocationId: 'planner-call', incarnation,
      execution: { ...plannerScope, taskId, runtimeId: incarnation.runtimeId, executionEpoch: 1 },
      lease: { leaseId: 'planner-lease', runtimeId: incarnation.runtimeId, generation: 1,
        incarnation, executionEpoch: 1, ownerId: owner, assignmentId: incarnation.assignmentId,
        capabilities: ['provider.execution'] },
      decision: { action: 'spawn', ownerId: owner, condition: 'orchestration.runtime.capacity',
        nextAction: { kind: 'continue', ref: incarnation.runtimeId }, reason: 'fixture capacity',
        runtimeId: incarnation.runtimeId },
      grantCommitRef: anchor, admissionCommitRef: anchor,
      checkpoint: { checkpoint: { id: checkpointId, scope: plannerScope, cycleId, seq: 1,
        previousCheckpointId: null, directiveRevision: 1, executionEpoch: 3, outcome: 'succeeded',
        summary: 'fixture closed checkpoint', recoveryStateRef: rawInitialInput().ref,
        evidenceRefs: [], next: { kind: 'continue', ref: 'planner' } }, previous: null, commitRef: anchor },
      preparedAt: '2026-10-16T00:02:00.000Z',
    };
    const writer = createJsonlClosedTurnPlannerCallJournal({ journal: value.controlJournal });
    const preparationCommit = await writer.append(prepared);
    const read = () => readTaskAgentActivity({ taskId, query: { taskId }, taskJournal: value.taskJournal,
      controlJournal: new JsonlOrganJournal(join(value.root, 'task-control.jsonl')),
      i2Journal: createJsonlI2JournalPort({ filePath: join(value.root, 'task-control.jsonl') }),
      currentAuthority: { taskId, executionEpoch: 3, locations: [] } });
    const before = await read();
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const planner = before.value.unknown.find((entry) => entry.sourceKind === 'closed-turn-planner-call');
    assert.ok(planner, 'prepared Planner must be visible and unknown despite Task epoch 3');
    if (planner === undefined) throw new Error('prepared Planner missing');
    assert.equal(planner.executionEpoch, 1);
    assert.equal(planner.assignmentId, incarnation.assignmentId);
    assert.equal(planner.instance.kind, 'incarnation');
    if (planner.instance.kind === 'incarnation') assert.equal(planner.instance.agentInstanceId, incarnation.agentInstanceId);
    assert.equal(planner.objective, undefined);
    assert.equal('attempt' in planner, false);
    assert.deepEqual(planner.commitRefs[0], preparationCommit);
    assert.equal(before.value.historical.some((entry) => entry.sourceKind === 'closed-turn-planner-call'), false);
    const invocationCommit = await writer.append({ kind: prepared.kind, stage: 'invoked',
      duty: prepared.duty, invocationId: prepared.invocationId, preparationCommitRef: preparationCommit,
      invokedAt: '2026-10-16T00:02:01.000Z' });
    const invoked = await read();
    assert.equal(invoked.ok, true);
    if (!invoked.ok) return;
    const pending = invoked.value.unknown.find((entry) => entry.sourceKind === 'closed-turn-planner-call');
    assert.ok(pending, 'invoked Planner stays unknown until its own returned commit');
    if (pending === undefined) throw new Error('invoked Planner missing');
    assert.deepEqual(pending.commitRefs.slice(0, 2), [preparationCommit, invocationCommit]);
    const returnCommit = await writer.append({ kind: prepared.kind, stage: 'returned',
      duty: prepared.duty, invocationId: prepared.invocationId, decision: 'continue',
      returnedAt: '2026-10-16T00:02:02.000Z', publication: {
        scope: { organId, taskId }, revisionId: 'plan-2', sequence: 2,
        predecessor: { revisionId: 'plan-1', sequence: 1, contentDigest: 'sha256:fixture-prior-plan' },
        snapshot: { title: 'Planner result', summary: 'Continue work',
          completeness: { scope: 'whole-task', status: 'complete' },
          acceptanceCriteria: [{ criterionId: 'criterion', description: 'Return plan' }],
          nodes: [{ nodeId: 'work', kind: 'work', title: 'Work', intent: 'Continue', definition: {} }],
          phases: [], relations: [] },
        reason: { kind: 'adjustment', text: 'Planner returned', basisRefs: [] },
        source: { requirementId: 'requirement', inputRevision: 1, draftId: 'draft',
          draftRevisionVersion: 1, draftRevisionHash: 'fixture-draft', confirmationRef: 'confirmation', evidenceRefs: [] },
        historyCoverage: 'complete-from-task-start', publishedAt: '2026-10-16T00:02:02.000Z', publishedBy: 'planner',
      } });
    const after = await read();
    assert.equal(after.ok, true);
    if (!after.ok) return;
    const historical = after.value.historical.find((entry) => entry.sourceKind === 'closed-turn-planner-call');
    assert.ok(historical, 'only the Planner return makes its call historical');
    if (historical === undefined) throw new Error('returned Planner missing');
    assert.deepEqual(historical.instance, planner.instance);
    assert.deepEqual(historical.commitRefs.slice(0, 3), [preparationCommit, invocationCommit, returnCommit]);
    assert.equal(after.value.unknown.some((entry) => entry.sourceKind === 'closed-turn-planner-call'), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('core source assembly keeps original identity and physical epoch 3, and binds the real turn closure', async () => {
  const value = await fixture(true);
  try {
    const assembled = await assembleTaskAgentActivityCoreSources({
      taskId,
      taskJournal: value.taskJournal,
      controlJournal: value.controlJournal,
    });
    assert.equal(assembled.ok, true);
    if (!assembled.ok) return;
    assert.equal(assembled.value.nativeAllocations.length, 1);
    assert.equal(assembled.value.activeTurns.length, 1);
    assert.equal(assembled.value.resumedSegments.length, 1);
    assert.equal(assembled.value.unavailableSources.length, 0);

    const native = assembled.value.nativeAllocations[0];
    const active = assembled.value.activeTurns[0];
    const resumed = assembled.value.resumedSegments[0];

    // The later task.updated must not rewrite an older allocation objective.
    assert.equal(native.objective, 'read the original task assignment');
    assert.equal(active.binding.assignment.objective, 'read the original task assignment');
    assert.equal(resumed.opened.binding.assignment.objective, 'read the original task assignment');

    assert.equal(resumed.opened.binding.assignment.executionEpoch, 1);
    assert.equal(resumed.opened.binding.incarnation.executionEpoch, 3);
    assert.equal(resumed.opened.binding.incarnation.taskId.value, taskId.value);
    assert.equal(resumed.opened.binding.incarnation.assignmentId, assignmentId);
    assert.equal(resumed.opened.binding.incarnation.agentInstanceId, 'd5b33ff4-ee6a-4b5b-bbff-bd5fe0eb0715');
    assert.equal(
      resumed.openedCommitRef.commitId,
      activeTurnSegmentCommitId('resumed-orchestration-1', 'segment-opened'),
    );
    assert.ok(resumed.openedCommitRef.journalSeq > 0);
    assert.equal(
      resumed.openedCommitRef.recordDigest,
      (await value.controlJournal.findByCommitId(resumed.openedCommitRef.commitId))?.recordDigest,
    );

    // The canonical terminal fact is the real business-turn closure, not the
    // resumed physical epoch and not a generic checkpoint.
    const controlRecords = await value.controlJournal.replay();
    const turnClosureRecord = controlRecords.find((record) => {
      const closure = closureFromRecord(record);
      return closure !== null && 'closureKind' in closure && closure.closureKind === 'turn-closure';
    });
    if (turnClosureRecord === undefined || turnClosureRecord.commitId === undefined) {
      throw new Error('expected one committed turn closure');
    }
    const turnClosureCommitId = turnClosureRecord.commitId;
    const turnClosureRef = {
      commitId: turnClosureCommitId,
      journalSeq: turnClosureRecord.seq,
      recordDigest: turnClosureRecord.recordDigest,
    };
    assert.deepEqual(native.terminalCommitRefs, [turnClosureRef]);
    assert.deepEqual(active.terminalCommitRefs, [turnClosureRef]);
    assert.deepEqual(resumed.terminalCommitRefs, [turnClosureRef]);

    const query = decodeTaskAgentActivitySelectionQuery(new URLSearchParams(), taskId);
    assert.equal(query.ok, true);
    if (!query.ok) return;
    const remainingSources = { childInvocations: [], runtimePoolLeases: [], milestoneReviews: [] };
    const read = await readTaskAgentActivityCore({
      taskId,
      query: query.value,
      taskJournal: value.taskJournal,
      controlJournal: value.controlJournal,
      remainingSources,
    });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value.mode, 'catalog');
    assert.equal(read.value.current.length, 0);
    assert.equal(read.value.unknown.length, 0);
    assert.equal(read.value.historical.length, 3);
    assert.deepEqual(
      read.value.historical.map((entry) => entry.sourceKind).sort(),
      ['active-turn', 'native-allocation', 'resumed-segment'],
    );

    const nativeRecord = read.value.historical.find((entry) => entry.sourceKind === 'native-allocation');
    const activeRecord = read.value.historical.find((entry) => entry.sourceKind === 'active-turn');
    const resumedRecord = read.value.historical.find((entry) => entry.sourceKind === 'resumed-segment');
    if (nativeRecord === undefined || activeRecord === undefined || resumedRecord === undefined) {
      throw new Error('expected native, active and resumed historical records');
    }
    assert.equal(nativeRecord.instance.kind, 'native-execution');
    if (nativeRecord.instance.kind === 'native-execution') {
      assert.equal(nativeRecord.instance.runtimeId, runtimeId);
      assert.equal(nativeRecord.instance.executionEpoch, 1);
    }
    assert.equal(activeRecord.instance.kind, 'native-execution');
    if (activeRecord.instance.kind === 'native-execution') {
      assert.equal(activeRecord.instance.runtimeId, runtimeId);
      assert.equal(activeRecord.instance.executionEpoch, 1);
    }
    assert.equal(resumedRecord.instance.kind, 'incarnation');
    if (resumedRecord.instance.kind === 'incarnation') {
      assert.equal(resumedRecord.instance.runtimeId, 'orchestration-runtime-1');
      assert.equal(resumedRecord.instance.executionEpoch, 3);
      assert.equal(resumedRecord.instance.agentInstanceId, 'd5b33ff4-ee6a-4b5b-bbff-bd5fe0eb0715');
    }
    assert.equal(resumedRecord.assignmentId, assignmentId);
    assert.equal(nativeRecord.objective, 'read the original task assignment');
    assert.equal(resumedRecord.objective, 'read the original task assignment');

    // Exact selected acceptance follows the same owner facts as the catalog.
    const selectedQuery = decodeTaskAgentActivitySelectionQuery(
      new URLSearchParams(
        'agentKind=incarnation'
        + '&agentRuntimeId=orchestration-runtime-1'
        + '&agentExecutionEpoch=3'
        + '&agentRoleId=orchestration'
        + '&agentGeneration=1'
        + '&agentInstanceId=d5b33ff4-ee6a-4b5b-bbff-bd5fe0eb0715'
        + `&agentAssignmentId=${assignmentId}`
        + '&agentSegmentId=resumed-orchestration-1',
      ),
      taskId,
    );
    assert.equal(selectedQuery.ok, true);
    if (!selectedQuery.ok) return;
    const selected = await readTaskAgentActivityCore({
      taskId,
      query: selectedQuery.value,
      taskJournal: value.taskJournal,
      controlJournal: value.controlJournal,
      remainingSources,
    });
    assert.equal(selected.ok, true);
    if (!selected.ok) return;
    assert.equal(selected.value.mode, 'selected');
    assert.equal(selected.value.selected?.length, 1);
    assert.equal(selected.value.selected?.[0]?.segmentId, 'resumed-orchestration-1');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
