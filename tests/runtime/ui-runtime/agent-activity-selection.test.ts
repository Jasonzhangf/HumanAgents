import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type AcceptedChildDelivery,
  type ActiveTurnBinding,
  type ChildInvocationRecord,
  type EvidenceRef,
  type JournalCommitRef,
  type ScopeRef,
  type TaskActualExecutionActiveTurnNode,
  type TaskActualExecutionChildInvocationNode,
  type TaskActualExecutionGraphNode,
  type TaskActualExecutionGraphSnapshot,
  type TaskActualExecutionOrphanChildDeliveryNode,
  type TaskActualExecutionResumedSegmentNode,
  type TaskId,
  type TaskRuntimeIncarnation,
  type TurnClosureReference,
  type WorkAssignment,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import type {
  ActiveTurnSegmentBinding,
  OriginalBusinessTurnRef,
  ResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import {
  selectTaskActualExecutionGraph,
  type AgentActivityActiveSource,
  type AgentActivityGraphChildDeliverySource,
  type AgentActivityGraphChildInvocationSource,
  type AgentActivityNativeSource,
  type AgentActivityResumedSource,
  type SelectTaskActualExecutionGraphInput,
} from '../../../packages/runtime/src/observation/agent-activity.js';

const ORGAN = id('organ', 'organ-native-graph');
const TASK: TaskId = id('task', 'task-native-graph');
const CYCLE = id('cycle', 'cycle-native-graph');
const OPERATION = id('operation', 'operation-native-graph');
const SCOPE: ScopeRef = { organId: ORGAN, taskId: TASK, cycleId: CYCLE, operationId: OPERATION };
const TASK_SCOPE = { organId: ORGAN, taskId: TASK };

function commit(commitId: string, journalSeq: number): JournalCommitRef {
  return { commitId, journalSeq, recordDigest: `sha256:${'a'.repeat(64)}` };
}

function evidence(locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', locator),
    kind: 'execution',
    source: 'native-graph-selector-test',
    locator: `fixture:${locator}`,
    scope: SCOPE,
  };
}

function workAssignment(assignmentId: string, overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  return {
    assignmentId,
    taskId: TASK,
    pipelineNodeId: 'node-implement',
    attempt: 1,
    executionEpoch: 2,
    inputRevision: 1,
    objective: `objective:${assignmentId}`,
    targetRefs: [],
    expectedOutputRefs: [],
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
    ...overrides,
  };
}

function workResult(assignment: WorkAssignment): WorkResult {
  return {
    taskId: assignment.taskId,
    pipelineNodeId: assignment.pipelineNodeId,
    agentId: 'agent-child',
    assignmentId: assignment.assignmentId,
    attempt: assignment.attempt,
    executionEpoch: assignment.executionEpoch,
    inputRevision: assignment.inputRevision,
    producedArtifactRefs: [],
    status: 'succeeded',
    summary: 'child delivered',
    outputRefs: [],
    evidenceRefs: [evidence('child-result')],
    nextAction: 'continue',
  };
}

function incarnation(
  runtimeId: string,
  generation: number,
  agentInstanceId: string,
  assignmentId: string,
  executionEpoch: number,
): TaskRuntimeIncarnation {
  return { runtimeId, generation, agentInstanceId, roleId: 'implementer', taskId: TASK, assignmentId, executionEpoch };
}

const allocationCommit = commit('commit-native-allocation', 1);
const nativeSource: AgentActivityNativeSource = {
  sourceId: 'native-allocation-1',
  ownerId: 'runtime-coordinator',
  commitRefs: [allocationCommit],
  evidenceRefs: [evidence('native-allocation')],
  boundLive: false,
  terminalCommitRefs: [],
  objective: 'deliver the native task',
  allocation: {
    runtimeId: 'native-runtime-1',
    taskId: TASK,
    operationId: OPERATION,
    executionEpoch: 1,
    assignmentId: 'assignment-native-1',
    scope: SCOPE,
    inputRefs: [],
    ownerId: 'runtime-coordinator',
    directiveRevision: 1,
    inputRevision: 1,
    orchestrated: false,
  },
};

const activeCommit = commit('commit-active-binding', 2);
const activeAssignment = workAssignment('assignment-active', {
  pipelineNodeId: 'node-implement',
  attempt: 1,
  executionEpoch: 2,
  objective: 'deliver the active turn',
});
const activeBinding: ActiveTurnBinding = {
  admittedTurn: {
    turnId: 'turn-2',
    workAssignmentRef: activeAssignment.assignmentId,
    taskRef: TASK,
    scopeRef: SCOPE,
    cycleRef: CYCLE,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: 2,
    runtimeBindingRef: 'runtime-binding-active',
    permissionRevision: 'permission-1',
    admissionEvidenceRefs: [],
    currentTurnRef: 'turn-2',
    recoveryStateRef: 'recovery-active',
  },
  assignment: activeAssignment,
  execution: { runtimeId: 'native-runtime-2', executionEpoch: 2 },
  scope: SCOPE,
};
const activeSource: AgentActivityActiveSource = {
  sourceId: 'active-turn-2',
  ownerId: 'runtime-active-turn',
  commitRefs: [],
  evidenceRefs: [evidence('active-turn')],
  boundLive: true,
  terminalCommitRefs: [],
  binding: activeBinding,
  bindingCommitRef: activeCommit,
};

const closureCommit = commit('commit-business-closure', 20);
const businessClosure: TurnClosureReference = {
  identity: {
    turnId: 'turn-2',
    workAssignmentRef: activeAssignment.assignmentId,
    taskRef: TASK,
    scopeRef: SCOPE,
    cycleRef: CYCLE,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: 2,
    runtimeBindingRef: 'runtime-binding-active',
    permissionRevision: 'permission-1',
  },
  checkpointId: id('checkpoint', 'checkpoint-turn-2'),
  closureRef: 'closure-turn-2',
  summary: {
    goal: { text: 'deliver', evidenceRefs: [evidence('closure-goal')] },
    actions: { text: 'delivered', evidenceRefs: [evidence('closure-actions')] },
    result: { text: 'delivered', evidenceRefs: [evidence('closure-result')] },
    expectedNextStep: { text: 'plan', evidenceRefs: [evidence('closure-next')] },
  },
  recoveryStateRef: evidence('closure-recovery'),
  closedAt: '2026-10-18T00:00:00.000Z',
};

const originalBusinessTurnRef: OriginalBusinessTurnRef = {
  businessTurnId: 'turn-2',
  bindingCommitRef: activeCommit,
  execution: { runtimeId: 'native-runtime-1', executionEpoch: 1 },
};

function segment(
  segmentId: string,
  predecessorSegmentId: string,
  phase: number,
): { readonly opened: ResumedTurnSegmentOpened; readonly openedCommitRef: JournalCommitRef; readonly source: AgentActivityResumedSource } {
  const segmentIncarnation = incarnation(
    'native-runtime-2',
    phase,
    `agent-instance-${segmentId}`,
    `assignment-${segmentId}`,
    phase + 2,
  );
  const assignment = workAssignment(`assignment-${segmentId}`, {
    pipelineNodeId: 'node-resumed',
    attempt: phase,
    executionEpoch: 1,
    objective: `resume ${segmentId}`,
  });
  const binding: ActiveTurnSegmentBinding = {
    businessTurnRef: originalBusinessTurnRef,
    assignment,
    execution: { runtimeId: 'native-runtime-2', executionEpoch: segmentIncarnation.executionEpoch },
    incarnation: segmentIncarnation,
    scope: SCOPE,
  };
  const opened: ResumedTurnSegmentOpened = {
    kind: 'segment-opened',
    segmentId,
    businessTurnRef: originalBusinessTurnRef,
    predecessor: { segmentId: predecessorSegmentId, recoveryAssetsReceiptRef: `receipt:${predecessorSegmentId}` },
    binding,
    authorityCommitRef: commit(`commit-authority-${segmentId}`, 10 + phase),
    businessRegistrationCommitRef: commit(`commit-registration-${segmentId}`, 20 + phase),
    requestRef: `request-${segmentId}`,
    inputIdentity: { requestRef: `request-${segmentId}`, digest: `sha256:${String(phase).repeat(64)}` },
  };
  const openedCommitRef = commit(`commit-opened-${segmentId}`, 30 + phase);
  return {
    opened,
    openedCommitRef,
    source: {
      sourceId: `resumed-segment-${segmentId}`,
      ownerId: 'runtime-context',
      commitRefs: [],
      evidenceRefs: [evidence(`resumed-${segmentId}`)],
      boundLive: false,
      terminalCommitRefs: phase === 1 ? [closureCommit] : [],
      opened,
      openedCommitRef,
    },
  };
}

const firstSegment = segment('segment-1', 'segment-0', 1);
const secondSegment = segment('segment-2', 'segment-1', 2);

const childAssignment = workAssignment('assignment-child', {
  pipelineNodeId: 'node-child',
  attempt: 1,
  executionEpoch: 2,
  objective: 'child deliverable',
});
const childInvocation: ChildInvocationRecord = {
  invocationId: 'invocation-child',
  childTurnId: 'child-turn-1',
  checkpointReceiptRef: 'child-checkpoint-1',
  binding: { kind: 'execution', assignment: childAssignment },
};
const childContainingLocation = {
  kind: 'active-turn' as const,
  businessTurnId: 'turn-2',
  bindingCommitRef: activeCommit,
};
const childInvocationSource: AgentActivityGraphChildInvocationSource = {
  sourceId: 'child-invocation-child',
  ownerId: 'runtime-child',
  commitRefs: [],
  evidenceRefs: [],
  boundLive: undefined,
  terminalCommitRefs: [],
  record: childInvocation,
  commitRef: commit('commit-child-invocation', 40),
  containingLocation: childContainingLocation,
  parentLocation: {
    instance: { kind: 'native-execution', execution: { runtimeId: 'native-runtime-2', executionEpoch: 2 } },
    assignmentId: activeAssignment.assignmentId,
    businessTurnId: 'turn-2',
    nodeId: activeAssignment.pipelineNodeId,
  },
};
const childDelivery: AcceptedChildDelivery = {
  kind: 'execution',
  seq: 1,
  invocationId: childInvocation.invocationId,
  refinedDelivery: { ref: evidence('child-refined'), view: { kind: 'utf8-text' } },
  assignment: childAssignment,
  result: workResult(childAssignment),
};
const childDeliverySource: AgentActivityGraphChildDeliverySource = {
  sourceId: 'child-delivery-child',
  ownerId: 'runtime-child',
  commitRefs: [],
  evidenceRefs: [],
  boundLive: undefined,
  terminalCommitRefs: [],
  delivery: childDelivery,
  commitRef: commit('commit-child-delivery', 41),
  containingLocation: childContainingLocation,
};
const orphanDelivery: AcceptedChildDelivery = {
  kind: 'execution',
  seq: 2,
  invocationId: 'invocation-orphan',
  refinedDelivery: { ref: evidence('orphan-refined'), view: { kind: 'utf8-text' } },
  assignment: workAssignment('assignment-orphan', { pipelineNodeId: 'node-child' }),
  result: workResult(workAssignment('assignment-orphan', { pipelineNodeId: 'node-child' })),
};
const orphanDeliverySource: AgentActivityGraphChildDeliverySource = {
  sourceId: 'child-delivery-orphan',
  ownerId: 'runtime-child',
  commitRefs: [],
  evidenceRefs: [],
  boundLive: undefined,
  terminalCommitRefs: [],
  delivery: orphanDelivery,
  commitRef: commit('commit-orphan-delivery', 42),
  containingLocation: childContainingLocation,
};

function baseInput(overrides: Partial<SelectTaskActualExecutionGraphInput> = {}): SelectTaskActualExecutionGraphInput {
  return {
    taskScope: TASK_SCOPE,
    nativeAllocations: [],
    activeTurns: [],
    resumedSegments: [],
    rawChildInvocations: [],
    childDeliveries: [],
    businessClosures: [],
    milestoneReviews: [],
    plannerCalls: [],
    currentAuthority: undefined,
    unavailableSources: [],
    ...overrides,
  };
}

function requireNode<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function nodesOf(snapshot: TaskActualExecutionGraphSnapshot): readonly TaskActualExecutionGraphNode[] {
  assert.equal(snapshot.history.status, 'recorded');
  if (snapshot.history.status !== 'recorded') return [];
  return snapshot.history.nodes;
}

test('native allocation facts produce a recorded graph without an assignment graph', () => {
  const snapshot = selectTaskActualExecutionGraph(baseInput({ nativeAllocations: [nativeSource] }));
  const nodes = nodesOf(snapshot);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.kind, 'native-allocation');
  if (snapshot.history.status === 'recorded') {
    assert.deepEqual(snapshot.history.edges, []);
    assert.deepEqual(snapshot.history.ungrouped, []);
  }
});

test('retains unacquired invocations and orphan deliveries instead of filtering them', () => {
  const snapshot = selectTaskActualExecutionGraph(baseInput({
    rawChildInvocations: [childInvocationSource],
    childDeliveries: [orphanDeliverySource],
  }));
  const nodes = nodesOf(snapshot);
  const invocation = nodes.find(
    (node): node is TaskActualExecutionChildInvocationNode => node.kind === 'child-invocation',
  );
  const orphan = nodes.find(
    (node): node is TaskActualExecutionOrphanChildDeliveryNode => node.kind === 'orphan-child-delivery',
  );
  const retainedInvocation = requireNode(invocation, 'unacquired invocation was not retained');
  const retainedOrphan = requireNode(orphan, 'orphan delivery was not retained');
  assert.equal(retainedInvocation.acquisition.status, 'unacquired');
  assert.equal(retainedInvocation.invocationId, childInvocation.invocationId);
  assert.equal(retainedOrphan.delivery.invocationId, 'invocation-orphan');
  assert.equal(
    retainedOrphan.nodeId,
    `child-delivery:${orphanDeliverySource.commitRef.commitId}:${orphanDelivery.seq}:${orphanDelivery.invocationId}`,
  );
  if (snapshot.history.status === 'recorded') {
    assert.equal(
      snapshot.history.unavailable.some((source) => source.message.includes('no acquired incarnation')),
      true,
    );
  }
});

test('maps exact turn and segment identities and only emits proven relations', () => {
  const snapshot = selectTaskActualExecutionGraph(baseInput({
    currentAuthority: {
      taskId: TASK,
      executionEpoch: 2,
      locations: [{
        instance: { kind: 'native-execution', execution: { runtimeId: 'native-runtime-2', executionEpoch: 2 } },
        assignmentId: activeAssignment.assignmentId,
        businessTurnId: 'turn-2',
        nodeId: activeAssignment.pipelineNodeId,
      }],
    },
    nativeAllocations: [nativeSource],
    activeTurns: [activeSource],
    resumedSegments: [firstSegment.source, secondSegment.source],
    rawChildInvocations: [childInvocationSource],
    childDeliveries: [childDeliverySource, orphanDeliverySource],
    businessClosures: [{ closure: businessClosure, commitRef: closureCommit }],
  }));
  const nodes = nodesOf(snapshot);
  const active = nodes.find(
    (node): node is TaskActualExecutionActiveTurnNode => node.kind === 'active-turn',
  );
  const activeNode = requireNode(active, 'active turn node missing');
  assert.equal(activeNode.businessTurnId, 'turn-2');
  assert.equal(activeNode.businessClosure.status, 'recorded');
  assert.equal(activeNode.currency, 'current');
  const nativeNode = requireNode(
    nodes.find((node) => node.kind === 'native-allocation'),
    'native allocation node missing',
  );
  assert.equal(nativeNode.currency, 'historical');
  const resumed = nodes.filter(
    (node): node is TaskActualExecutionResumedSegmentNode => node.kind === 'resumed-segment',
  );
  assert.deepEqual(resumed.map((node) => node.segmentId).sort(), ['segment-1', 'segment-2']);
  assert.equal(resumed.every((node) => node.segmentState.status === 'opened'), true);
  assert.equal(
    resumed.find((node) => node.segmentId === 'segment-1')!.terminalCommitRefs.length,
    0,
    'a business closure never becomes a physical segment terminal',
  );
  const invocation = nodes.find(
    (node): node is TaskActualExecutionChildInvocationNode => node.kind === 'child-invocation',
  );
  const invocationNode = requireNode(invocation, 'child invocation node missing');
  assert.equal(invocationNode.returnState.status, 'returned');
  if (invocationNode.returnState.status === 'returned') {
    assert.equal(invocationNode.returnState.delivery.kind, 'execution');
    assert.equal(invocationNode.returnState.deliveryCommitRef.commitId, childDeliverySource.commitRef.commitId);
  }
  assert.equal(invocationNode.linkage.status, 'linked');
  assert.equal(snapshot.history.status, 'recorded');
  if (snapshot.history.status !== 'recorded') return;
  const segmentOneId = resumed.find((node) => node.segmentId === 'segment-1')!.nodeId;
  const segmentTwoId = resumed.find((node) => node.segmentId === 'segment-2')!.nodeId;
  assert.equal(
    snapshot.history.edges.some((edge) =>
      edge.kind === 'precedes' && edge.fromNodeId === segmentOneId && edge.toNodeId === segmentTwoId),
    true,
  );
  assert.equal(
    snapshot.history.edges.some((edge) =>
      edge.kind === 'delegates-child'
      && edge.fromNodeId === activeNode.nodeId
      && edge.toNodeId === invocationNode.nodeId),
    true,
  );
  assert.equal(
    snapshot.history.edges.some((edge) => edge.kind === 'contains' && edge.toNodeId === segmentTwoId),
    true,
  );
});
