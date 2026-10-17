import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type ActiveTurnBinding,
  type ChildInvocationRecord,
  type EvidenceRef,
  type JournalCommitRef,
  type MilestoneReviewResultRecord,
  type ReviewAssignment,
  type ScopeRef,
  type TaskExecutionInstanceIdentity,
  type TaskAgentActivityOwnershipRecord,
  type TaskId,
  type TaskRuntimeIncarnation,
  type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import type {
  ActiveTurnSegmentBinding,
  OriginalBusinessTurnRef,
  ResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import {
  selectTaskAgentActivity,
  type AgentActivityActiveSource,
  type AgentActivityChildSource,
  type AgentActivityCurrentAuthority,
  type AgentActivityNativeSource,
  type AgentActivityPoolSource,
  type AgentActivityReviewSource,
  type AgentActivityResumedSource,
  type SelectTaskAgentActivityInput,
} from '../../../packages/runtime/src/index.js';

// The combined root program resolves node:assert/strict to an ambient module
// with a narrow surface; add the two members this consumer needs.
declare module 'node:assert/strict' {
  interface Assert {
    doesNotMatch(actual: string, expected: RegExp, message?: string): void;
    strictEqual<T>(actual: unknown, expected: T, message?: string): void;
  }
}

const SELECTOR_OWNER_ID = 'runtime.observation.agent-activity';

const ORGAN_ID = id('organ', 'organ-agent-activity');
const TASK: TaskId = id('task', 'task-agent-activity');
const OTHER_TASK: TaskId = id('task', 'task-agent-activity-other');
const CYCLE = id('cycle', 'cycle-agent-activity');
const SCOPE: ScopeRef = { organId: ORGAN_ID, taskId: TASK };
const TASK_SCOPE: ScopeRef & { taskId: TaskId } = { organId: ORGAN_ID, taskId: TASK };

function commit(commitId: string, journalSeq: number): JournalCommitRef {
  return { commitId, journalSeq, recordDigest: `sha256:${'0'.repeat(64)}` };
}

function evidenceRef(evidenceId: string): EvidenceRef {
  return {
    evidenceId: id('evidence', evidenceId),
    kind: 'execution',
    source: 'agent-activity-fixture',
    locator: `fixture:${evidenceId}`,
    scope: SCOPE,
  };
}

function nativeInstance(runtimeId: string, executionEpoch: number): TaskExecutionInstanceIdentity {
  return { kind: 'native-execution', execution: { runtimeId, executionEpoch } };
}

function incarnationInstance(incarnation: TaskRuntimeIncarnation): TaskExecutionInstanceIdentity {
  return { kind: 'incarnation', incarnation };
}

function workAssignment(assignmentId: string, overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  return {
    assignmentId,
    taskId: TASK,
    pipelineNodeId: 'node-implement',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: `objective:${assignmentId}`,
    targetRefs: [],
    expectedOutputRefs: [],
    acceptanceCriteriaDigest: `sha256:${'1'.repeat(64)}`,
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
    ...overrides,
  };
}

function incarnation(
  runtimeId: string,
  generation: number,
  agentInstanceId: string,
  assignmentId: string,
  executionEpoch: number,
  roleId = 'implementer',
): TaskRuntimeIncarnation {
  return { runtimeId, generation, agentInstanceId, roleId, taskId: TASK, assignmentId, executionEpoch };
}

const allocationCommit = commit('commit-allocation', 1);
const allocationTerminalCommit = commit('commit-allocation-terminal', 2);
const allocationEvidence = evidenceRef('evidence-allocation');
const activeCommit = commit('commit-active', 3);
const activeEvidence = evidenceRef('evidence-active');
const resumedOpenedCommit = commit('commit-resumed-opened', 4);
const resumedEvidence = evidenceRef('evidence-resumed');
const childCommit = commit('commit-child', 5);
const childEvidence = evidenceRef('evidence-child');
const poolCommit = commit('commit-pool', 6);
const poolEvidence = evidenceRef('evidence-pool');
const reviewCommit = commit('commit-review', 7);
const reviewEvidence = evidenceRef('evidence-review');

// epoch 1 native allocation, superseded by the epoch 2 authority.
const nativeSource: AgentActivityNativeSource = {
  sourceId: 'native-allocation-1',
  ownerId: 'runtime-coordinator',
  commitRefs: [allocationCommit],
  evidenceRefs: [allocationEvidence],
  boundLive: false,
  terminalCommitRefs: [allocationTerminalCommit],
  objective: 'deliver epoch one',
  allocation: {
    runtimeId: 'native-runtime-1',
    taskId: TASK,
    operationId: id('operation', 'operation-agent-activity'),
    executionEpoch: 1,
    assignmentId: 'assignment-1',
    scope: SCOPE,
    inputRefs: [],
    ownerId: 'runtime-coordinator',
    directiveRevision: 1,
    inputRevision: 1,
    orchestrated: false,
  },
};

const activeAssignment = workAssignment('assignment-active', {
  pipelineNodeId: 'node-implement',
  attempt: 2,
  executionEpoch: 2,
  objective: 'deliver epoch two',
});
const activeBinding: ActiveTurnBinding = {
  admittedTurn: {
    turnId: 'turn-2',
    workAssignmentRef: 'assignment-active',
    taskRef: TASK,
    scopeRef: SCOPE,
    cycleRef: CYCLE,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: 2,
    runtimeBindingRef: 'runtime-binding-2',
    permissionRevision: 'permission-1',
    admissionEvidenceRefs: [],
    currentTurnRef: 'turn-2',
    recoveryStateRef: 'recovery-2',
  },
  assignment: activeAssignment,
  execution: { runtimeId: 'native-runtime-2', executionEpoch: 2 },
  scope: SCOPE,
};
const activeSource: AgentActivityActiveSource = {
  sourceId: 'active-turn-2',
  ownerId: 'runtime-active-turn',
  commitRefs: [],
  evidenceRefs: [activeEvidence],
  boundLive: true,
  terminalCommitRefs: [],
  binding: activeBinding,
  bindingCommitRef: activeCommit,
};

// A live-looking binding that the authoritative location does not confirm.
const orphanActiveAssignment = workAssignment('assignment-orphan-active', {
  pipelineNodeId: 'node-orphan',
  attempt: 1,
  executionEpoch: 2,
  objective: 'unconfirmed live turn',
});
const orphanActiveSource: AgentActivityActiveSource = {
  sourceId: 'active-turn-orphan',
  ownerId: 'runtime-active-turn',
  commitRefs: [],
  evidenceRefs: [],
  boundLive: undefined,
  terminalCommitRefs: [],
  binding: {
    admittedTurn: {
      turnId: 'turn-orphan',
      workAssignmentRef: 'assignment-orphan-active',
      taskRef: TASK,
      scopeRef: SCOPE,
      cycleRef: CYCLE,
      inputRevision: 1,
      directiveRevision: 1,
      executionEpoch: 2,
      runtimeBindingRef: 'runtime-binding-orphan',
      permissionRevision: 'permission-1',
      admissionEvidenceRefs: [],
      currentTurnRef: 'turn-orphan',
      recoveryStateRef: 'recovery-orphan',
    },
    assignment: orphanActiveAssignment,
    execution: { runtimeId: 'native-runtime-orphan', executionEpoch: 2 },
    scope: SCOPE,
  },
  bindingCommitRef: commit('commit-active-orphan', 11),
};

const resumedIncarnation = incarnation('native-runtime-2', 2, 'agent-instance-resumed', 'assignment-resumed', 2);
const resumedAssignment = workAssignment('assignment-resumed', {
  pipelineNodeId: 'node-resumed',
  attempt: 2,
  executionEpoch: 2,
  objective: 'resume epoch two',
});
const resumedBusinessTurnRef: OriginalBusinessTurnRef = {
  businessTurnId: 'turn-2',
  bindingCommitRef: activeCommit,
  execution: { runtimeId: 'native-runtime-2', executionEpoch: 2 },
};
const resumedBinding: ActiveTurnSegmentBinding = {
  businessTurnRef: resumedBusinessTurnRef,
  assignment: resumedAssignment,
  execution: { runtimeId: 'native-runtime-2', executionEpoch: 2 },
  incarnation: resumedIncarnation,
  scope: SCOPE,
};
const resumedOpened: ResumedTurnSegmentOpened = {
  kind: 'segment-opened',
  segmentId: 'segment-2',
  businessTurnRef: resumedBusinessTurnRef,
  predecessor: { segmentId: 'segment-1', recoveryAssetsReceiptRef: 'receipt-1' },
  binding: resumedBinding,
  authorityCommitRef: commit('commit-resumed-authority', 8),
  businessRegistrationCommitRef: commit('commit-resumed-registration', 9),
  requestRef: 'request-resumed-2',
  inputIdentity: { requestRef: 'request-resumed-2', digest: `sha256:${'2'.repeat(64)}` },
};
const resumedSource: AgentActivityResumedSource = {
  sourceId: 'resumed-segment-2',
  ownerId: 'runtime-context',
  commitRefs: [],
  evidenceRefs: [resumedEvidence],
  boundLive: true,
  terminalCommitRefs: [],
  opened: resumedOpened,
  openedCommitRef: resumedOpenedCommit,
};

const childIncarnation = incarnation('native-runtime-2', 3, 'agent-instance-child', 'assignment-child', 2);
const childAssignment = workAssignment('assignment-child', {
  pipelineNodeId: 'node-child',
  attempt: 1,
  executionEpoch: 2,
  objective: 'child deliverable',
});
const childRecord: ChildInvocationRecord = {
  invocationId: 'invocation-child',
  childTurnId: 'child-turn-1',
  checkpointReceiptRef: 'child-checkpoint-1',
  binding: { kind: 'execution', assignment: childAssignment },
  incarnation: childIncarnation,
  adoptedResultSeq: 1,
};
const childSource: AgentActivityChildSource = {
  sourceId: 'child-invocation-acquired',
  ownerId: 'runtime-child',
  commitRefs: [],
  evidenceRefs: [childEvidence],
  boundLive: true,
  terminalCommitRefs: [],
  record: childRecord,
  commitRef: childCommit,
  assignment: childAssignment,
  objective: childAssignment.objective,
  parentLocation: { instance: nativeInstance('native-runtime-2', 2), assignmentId: 'assignment-active' },
};

const orphanChildAssignment = workAssignment('assignment-orphan-child', {
  pipelineNodeId: 'node-child',
  attempt: 1,
  executionEpoch: 2,
  objective: 'orphan child deliverable',
});
const orphanChildRecord: ChildInvocationRecord = {
  invocationId: 'invocation-orphan-child',
  childTurnId: 'child-turn-2',
  checkpointReceiptRef: 'child-checkpoint-2',
  binding: { kind: 'execution', assignment: orphanChildAssignment },
};
const orphanChildSource: AgentActivityChildSource = {
  sourceId: 'child-invocation-orphan',
  ownerId: 'runtime-child',
  commitRefs: [],
  evidenceRefs: [],
  boundLive: undefined,
  terminalCommitRefs: [],
  record: orphanChildRecord,
  commitRef: commit('commit-child-orphan', 12),
  assignment: orphanChildAssignment,
  objective: orphanChildAssignment.objective,
  parentLocation: { instance: nativeInstance('native-runtime-2', 2), assignmentId: 'assignment-active' },
};

const poolIncarnation = incarnation('native-runtime-2', 4, 'agent-instance-pool', 'assignment-pool', 2);
const poolSource: AgentActivityPoolSource = {
  sourceId: 'pool-lease-1',
  ownerId: 'orchestration-runtime-manager',
  commitRefs: [poolCommit],
  evidenceRefs: [poolEvidence],
  boundLive: true,
  terminalCommitRefs: [],
  runtime: {
    runtimeId: 'native-runtime-2',
    generation: 4,
    state: 'running',
    capabilities: [],
    incarnation: poolIncarnation,
  },
  objective: 'pool deliverable',
};

const reviewIncarnation = incarnation('native-runtime-review', 1, 'agent-instance-review', 'review-assignment-1', 2, 'reviewer');
const reviewAssignment: ReviewAssignment = {
  assignmentId: 'review-assignment-1',
  taskId: TASK.value,
  workerAgentId: 'reviewer-agent',
  reviewKind: 'delivery',
  attempt: 3,
  executionEpoch: 2,
  inputRevision: 1,
  acceptanceCriteriaDigest: `sha256:${'3'.repeat(64)}`,
  subjectRefs: [],
  subjectDigests: [],
  workerCapabilities: [],
  requiredCapabilities: [],
  mergeGate: 'not-required',
};
const reviewRecord: MilestoneReviewResultRecord = {
  kind: 'milestone-review-result',
  schemaVersion: 1,
  milestoneId: 'milestone-1',
  cycleId: CYCLE,
  taskScope: TASK_SCOPE,
  executionScope: SCOPE,
  planRevisionCommitRef: commit('commit-plan-revision', 10),
  reviewAssignment,
  delivery: {
    result: {
      resultId: 'review-result-1',
      assignmentId: reviewAssignment.assignmentId,
      taskId: TASK.value,
      workerAgentId: 'reviewer-agent',
      reviewKind: 'delivery',
      attempt: 3,
      executionEpoch: 2,
      inputRevision: 1,
      acceptanceCriteriaDigest: reviewAssignment.acceptanceCriteriaDigest,
      subjectRefs: [],
      subjectDigests: [],
      status: 'passed',
      findings: [],
      evidenceRefs: [reviewEvidence],
    },
    reviewer: reviewIncarnation,
    output: { text: 'approved', artifactRef: null, artifactDigest: null },
    completedAt: '2026-10-16T00:00:00.000Z',
  },
  completedAt: '2026-10-16T00:00:00.000Z',
};
const reviewSource: AgentActivityReviewSource = {
  sourceId: 'milestone-review-1',
  ownerId: 'runtime-review',
  commitRefs: [],
  evidenceRefs: [reviewEvidence],
  boundLive: false,
  terminalCommitRefs: [],
  record: reviewRecord,
  commitRef: reviewCommit,
  objective: 'reviewed deliverable',
};

// Only the real live handles are authoritative current locations.
const authority: AgentActivityCurrentAuthority = {
  taskId: TASK,
  executionEpoch: 2,
  locations: [
    {
      instance: nativeInstance('native-runtime-2', 2),
      assignmentId: 'assignment-active',
      businessTurnId: 'turn-2',
      nodeId: 'node-implement',
    },
    {
      instance: incarnationInstance(resumedIncarnation),
      assignmentId: 'assignment-resumed',
      businessTurnId: 'turn-2',
      segmentId: 'segment-2',
      nodeId: 'node-resumed',
    },
    { instance: incarnationInstance(childIncarnation), assignmentId: 'assignment-child' },
    { instance: incarnationInstance(poolIncarnation), assignmentId: 'assignment-pool' },
  ],
};

function baseInput(query: SelectTaskAgentActivityInput['query']): SelectTaskAgentActivityInput {
  return {
    taskId: TASK,
    query,
    currentAuthority: authority,
    nativeAllocations: [nativeSource],
    activeTurns: [activeSource, orphanActiveSource],
    resumedSegments: [resumedSource],
    childInvocations: [childSource, orphanChildSource],
    runtimePoolLeases: [poolSource],
    milestoneReviews: [reviewSource],
    unavailableSources: [],
  };
}

function recordOf(
  records: readonly TaskAgentActivityOwnershipRecord[],
  sourceKind: TaskAgentActivityOwnershipRecord['sourceKind'],
): TaskAgentActivityOwnershipRecord {
  for (const record of records) if (record.sourceKind === sourceKind) return record;
  throw new Error(`expected a ${sourceKind} record`);
}

test('catalog keeps the epoch 1 allocation historical and the live handles current', () => {
  const outcome = selectTaskAgentActivity(baseInput({ taskId: TASK }));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.value.mode, 'catalog');

  // Terminal/superseded sources are history: the epoch 1 allocation and the
  // completed milestone review.
  assert.equal(outcome.value.historical.length, 2);
  const allocationRecord = recordOf(outcome.value.historical, 'native-allocation');
  assert.equal(allocationRecord.executionEpoch, 1);
  assert.ok(allocationRecord.instance.kind === 'native-execution');
  if (allocationRecord.instance.kind === 'native-execution') {
    assert.equal(allocationRecord.instance.execution.executionEpoch, 1);
    assert.equal(allocationRecord.instance.execution.runtimeId, 'native-runtime-1');
  }
  assert.ok(allocationRecord.commitRefs.includes(allocationCommit));
  assert.ok(allocationRecord.evidenceRefs.includes(allocationEvidence));

  const reviewReport = recordOf(outcome.value.historical, 'milestone-review');
  assert.equal(reviewReport.attempt, 3);
  assert.ok(reviewReport.instance.kind === 'incarnation');
  if (reviewReport.instance.kind === 'incarnation') {
    assert.equal(reviewReport.instance.incarnation.agentInstanceId, 'agent-instance-review');
  }
  assert.ok(reviewReport.commitRefs.includes(reviewCommit));

  // Live authoritative handles are current.
  assert.equal(outcome.value.current.length, 4);
  const currentKinds = outcome.value.current.map((record) => record.sourceKind).sort();
  assert.deepEqual(currentKinds, ['active-turn', 'child-invocation', 'resumed-segment', 'runtime-pool-lease']);
  const activeRecord = recordOf(outcome.value.current, 'active-turn');
  assert.equal(activeRecord.executionEpoch, 2);
  assert.equal(activeRecord.attempt, 2);
  assert.equal(activeRecord.businessTurnId, 'turn-2');
  assert.equal(activeRecord.nodeId, 'node-implement');

  // The acquired child keeps its own identity and never becomes its parent.
  const childCatalogRecord = recordOf(outcome.value.current, 'child-invocation');
  assert.ok(childCatalogRecord.instance.kind === 'incarnation');
  if (childCatalogRecord.instance.kind === 'incarnation') {
    assert.equal(childCatalogRecord.instance.incarnation.agentInstanceId, 'agent-instance-child');
    assert.equal(childCatalogRecord.instance.incarnation.assignmentId, 'assignment-child');
  }
  assert.ok(childCatalogRecord.commitRefs[0] === childCommit);
  assert.ok(childCatalogRecord.evidenceRefs[0] === childEvidence);

  // A live-looking binding the authority does not confirm is unknown with gap.
  assert.equal(outcome.value.unknown.length, 1);
  assert.equal(outcome.value.unknown[0]!.sourceKind, 'active-turn');
  assert.equal(outcome.value.unknown[0]!.missingSource, 'live-or-terminal-evidence');

  // A child with no acquired incarnation is an explicit gap, not a fabricated
  // parent identity.
  assert.equal(outcome.value.unavailableSources.length, 1);
  assert.equal(outcome.value.unavailableSources[0]!.sourceId, 'invocation-orphan-child');
});

test('selected matches one exact instance and does not trim the catalog', () => {
  const outcome = selectTaskAgentActivity(baseInput({
    taskId: TASK,
    instance: nativeInstance('native-runtime-2', 2),
    assignmentId: 'assignment-active',
    attempt: 2,
    businessTurnId: 'turn-2',
    nodeId: 'node-implement',
  }));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.value.mode, 'selected');
  assert.equal(outcome.value.selected?.length, 1);
  assert.equal(outcome.value.selected?.[0]?.sourceKind, 'active-turn');
  assert.ok(outcome.value.selectedInstance !== undefined);
  if (outcome.value.selectedInstance?.kind === 'native-execution') {
    assert.equal(outcome.value.selectedInstance.execution.runtimeId, 'native-runtime-2');
  }
  // The three catalog arrays stay complete.
  assert.equal(outcome.value.current.length, 4);
  assert.equal(outcome.value.historical.length, 2);
  assert.equal(outcome.value.unknown.length, 1);
  assert.equal(outcome.value.unavailableSources.length, 1);

  const resumedSelected = selectTaskAgentActivity(baseInput({
    taskId: TASK,
    instance: incarnationInstance(resumedIncarnation),
    segmentId: 'segment-2',
  }));
  assert.equal(resumedSelected.ok, true);
  if (!resumedSelected.ok) return;
  assert.equal(resumedSelected.value.selected?.length, 1);
  assert.equal(resumedSelected.value.selected?.[0]?.sourceKind, 'resumed-segment');
  assert.equal(resumedSelected.value.selected?.[0]?.segmentId, 'segment-2');
});

test('a wrong node, attempt or generation fails loud instead of returning catalog', () => {
  const wrongNode = selectTaskAgentActivity(baseInput({
    taskId: TASK,
    instance: nativeInstance('native-runtime-2', 2),
    nodeId: 'node-does-not-exist',
  }));
  assert.equal(wrongNode.ok, false);
  if (!wrongNode.ok) {
    assert.equal(wrongNode.failure.code, 'agent-activity.selection-not-found');
    assert.equal(wrongNode.failure.ownerId, SELECTOR_OWNER_ID);
  }

  const wrongAttempt = selectTaskAgentActivity(baseInput({
    taskId: TASK,
    instance: nativeInstance('native-runtime-2', 2),
    attempt: 99,
  }));
  assert.equal(wrongAttempt.ok, false);
  if (!wrongAttempt.ok) assert.equal(wrongAttempt.failure.code, 'agent-activity.selection-not-found');

  // Same runtime id but a different incarnation generation is not a match.
  const otherGeneration = incarnation('native-runtime-2', 9, 'agent-instance-child', 'assignment-child', 2);
  const wrongGeneration = selectTaskAgentActivity(baseInput({
    taskId: TASK,
    instance: incarnationInstance(otherGeneration),
  }));
  assert.equal(wrongGeneration.ok, false);
  if (!wrongGeneration.ok) assert.equal(wrongGeneration.failure.code, 'agent-activity.selection-not-found');
});

test('a source for another task is a source conflict, not a missing selection', () => {
  const conflicting: AgentActivityActiveSource = {
    sourceId: 'active-turn-foreign',
    ownerId: 'runtime-active-turn',
    commitRefs: [],
    evidenceRefs: [],
    boundLive: true,
    terminalCommitRefs: [],
    binding: {
      ...activeBinding,
      admittedTurn: { ...activeBinding.admittedTurn, taskRef: OTHER_TASK },
      assignment: workAssignment('assignment-foreign', { taskId: OTHER_TASK, executionEpoch: 2 }),
    },
    bindingCommitRef: commit('commit-active-foreign', 13),
  };
  const input = baseInput({ taskId: TASK });
  const outcome = selectTaskAgentActivity({ ...input, activeTurns: [...input.activeTurns, conflicting] });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.code, 'agent-activity.source-conflict');
  assert.equal(outcome.failure.ownerId, SELECTOR_OWNER_ID);
});

test('a current authority for another task is a source conflict', () => {
  const input = baseInput({ taskId: TASK });
  const outcome = selectTaskAgentActivity({
    ...input,
    currentAuthority: {
      taskId: OTHER_TASK,
      executionEpoch: 3,
      locations: input.currentAuthority?.locations ?? [],
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.code, 'agent-activity.source-conflict');
  assert.equal(outcome.failure.ownerId, SELECTOR_OWNER_ID);
});

test('a half-narrowed selection query is rejected as invalid', () => {
  const outcome = selectTaskAgentActivity(baseInput({ taskId: TASK, nodeId: 'node-implement' }));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.failure.code, 'agent-activity.invalid-selection');
  assert.equal(outcome.failure.ownerId, SELECTOR_OWNER_ID);
});

test('a pool runtime without an incarnation contributes no record', () => {
  const input = baseInput({ taskId: TASK });
  const outcome = selectTaskAgentActivity({
    ...input,
    runtimePoolLeases: [{
      ...poolSource,
      runtime: { runtimeId: 'native-runtime-idle', generation: 1, state: 'idle', capabilities: [] },
    }],
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.current.some((record) => record.sourceKind === 'runtime-pool-lease'), false);
  assert.equal(outcome.value.unavailableSources.length, 1);
});

test('a live handle with terminal commits is history, not a source conflict', () => {
  const terminal = commit('commit-active-terminal', 20);
  const input: SelectTaskAgentActivityInput = {
    ...baseInput({ taskId: TASK }),
    currentAuthority: { taskId: TASK, executionEpoch: 2, locations: [] },
    nativeAllocations: [],
    activeTurns: [{ ...activeSource, boundLive: true, terminalCommitRefs: [terminal] }],
    resumedSegments: [],
    childInvocations: [],
    runtimePoolLeases: [],
    milestoneReviews: [],
    unavailableSources: [],
  };
  const outcome = selectTaskAgentActivity(input);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.current.length, 0);
  assert.equal(outcome.value.historical.length, 1);
  assert.equal(outcome.value.historical[0]!.sourceKind, 'active-turn');
  assert.equal(outcome.value.historical[0]!.currency, 'historical');
  assert.ok(outcome.value.historical[0]!.commitRefs.includes(activeCommit));
});
