import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  id,
  type EvidenceRef,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import {
  AgentRuntimePoolManager,
  OrchestrationManager,
  acceptanceCriteriaContent,
  digestOf,
  resolveReviewMaterial,
  type ExecutionAgentInput,
  type ExecutionAgentPort,
  type OrchestrationRuntimeFactoryPort,
  type ReviewAgentInput,
  type ReviewAgentPort,
} from '../../../packages/runtime/src/orchestration/index.js';
import type { ReviewResult } from '../../../packages/runtime/src/review/index.js';

const organ = id('organ', 'organ-review-material');
const task = id('task', 'task-review-material');
const scope: ScopeRef = { organId: organ, taskId: task };

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `review-material-${label}`),
    kind: 'operation',
    source: 'test',
    locator: label,
    scope,
  };
}

const subjectBody = 'the produced artifact body that the reviewer must evaluate';
const criteriaDigest = 'sha256:156b02b3e7f32a21f1265237b26e5242a9aebf38c341054d6cb2641951c855fe';

function assignment(overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  const base = {
    assignmentId: 'assignment-a',
    taskId: task,
    pipelineNodeId: 'node-a',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'produce one reviewed subject',
    targetRefs: ['subject-a'],
    expectedOutputRefs: ['output-a'],
    expectedArtifactDigests: [digest(subjectBody)],
    successCriteria: ['subject matches the acceptance criteria'],
    failureCriteria: ['subject violates the acceptance criteria'],
    incompleteCriteria: ['subject evidence is incomplete'],
    requiredCapabilities: ['execute'],
    mergeGate: 'required',
  } as const;
  return {
    ...base,
    acceptanceCriteriaDigest: digestOf(acceptanceCriteriaContent(base)),
    ...overrides,
  };
}

function result(overrides: Partial<WorkResult> = {}): WorkResult {
  const base = assignment();
  return {
    taskId: base.taskId,
    pipelineNodeId: base.pipelineNodeId,
    agentId: 'agent-a',
    assignmentId: base.assignmentId,
    attempt: base.attempt,
    executionEpoch: base.executionEpoch,
    inputRevision: base.inputRevision,
    producedArtifactRefs: ['subject-a'],
    producedArtifactDigests: [digest(subjectBody)],
    status: 'succeeded',
    summary: 'worker says the work succeeded',
    outputRefs: ['output-a'],
    evidenceRefs: [evidence('worker')],
    nextAction: 'review',
    ...overrides,
  };
}

class FakeRuntimeFactory implements OrchestrationRuntimeFactoryPort {
  async start(input: Parameters<OrchestrationRuntimeFactoryPort['start']>[0]) {
    return {
      runtimeId: input.runtimeId,
      generation: input.generation,
      capabilities: [...input.requiredCapabilities],
    };
  }

  async dispose(): Promise<void> {}
}

function pool(): AgentRuntimePoolManager {
  return new AgentRuntimePoolManager({
    maxRuntimes: 1,
    factory: new FakeRuntimeFactory(),
    ownerId: 'orchestration-manager',
    initialRuntimes: [{ runtimeId: 'runtime-a', capabilities: ['execute', 'quality.review'] }],
  });
}

class StaticExecutionAgent implements ExecutionAgentPort {
  constructor(private readonly delivery: WorkResult | { readonly result: WorkResult }) {}

  async execute(_input: ExecutionAgentInput): Promise<WorkResult> {
    return 'result' in this.delivery ? this.delivery.result : this.delivery;
  }

}

class RecordingReviewAgent implements ReviewAgentPort {
  readonly inputs: Array<Parameters<ReviewAgentPort['review']>[0]> = [];
  readonly results: ReviewResult[] = [];

  async review(input: Parameters<ReviewAgentPort['review']>[0]): Promise<ReviewResult> {
    this.inputs.push(input);
    const reviewResult: ReviewResult = {
      resultId: `review-result-${input.reviewAssignment.assignmentId}`,
      assignmentId: input.reviewAssignment.assignmentId,
      taskId: input.reviewAssignment.taskId,
      workerAgentId: input.reviewAssignment.workerAgentId,
      reviewKind: input.reviewAssignment.reviewKind,
      attempt: input.reviewAssignment.attempt,
      executionEpoch: input.reviewAssignment.executionEpoch,
      inputRevision: input.reviewAssignment.inputRevision,
      acceptanceCriteriaDigest: input.reviewAssignment.acceptanceCriteriaDigest,
      subjectRefs: [...input.reviewAssignment.subjectRefs],
      subjectDigests: [...input.reviewAssignment.subjectDigests],
      status: 'passed',
      findings: [],
      evidenceRefs: [evidence('review')],
    };
    this.results.push(reviewResult);
    return reviewResult;
  }
}

const merge = {
  async merge() {
    return { status: 'merged' as const, evidenceRefs: [evidence('merge')] };
  },
};

test('resolveReviewMaterial carries acceptance criteria content matching its digest', () => {
  const workerAssignment = assignment();
  assert.equal(digestOf(acceptanceCriteriaContent(workerAssignment)), criteriaDigest);
  const material = resolveReviewMaterial({
    workerAssignment,
    workerResult: result(),
    subjects: [{ ref: 'subject-a', body: subjectBody }],
  });
  assert.equal(
    digest(material.acceptanceCriteria),
    criteriaDigest,
    'acceptance criteria content must hash to the declared acceptanceCriteriaDigest',
  );
  assert.equal(material.subjects.length, 1);
  assert.equal(material.subjects[0]?.ref, 'subject-a');
  assert.equal(material.subjects[0]?.body, subjectBody);
  assert.equal(material.subjects[0]?.digest, digest(subjectBody));
});

test('resolveReviewMaterial carries executor tool evidence additively from the worker result', () => {
  const executorEvidence = [
    { summary: 'provider.tool search matched 3 files', evidenceRefs: [evidence('executor-tool')] },
  ];
  const workerResult = { ...result(), executorEvidence } as WorkResult & {
    readonly executorEvidence: typeof executorEvidence;
  };
  const material = resolveReviewMaterial({
    workerAssignment: assignment(),
    workerResult,
    subjects: [{ ref: 'subject-a', body: subjectBody }],
  });
  // Evidence is additional material; the artifact body and its digest mapping
  // must stay intact.
  assert.deepEqual(material.executorEvidence, executorEvidence);
  assert.equal(material.subjects[0]?.body, subjectBody);
  assert.equal(material.subjects[0]?.digest, digest(subjectBody));
});

test('resolveReviewMaterial leaves executor evidence empty when the worker result carries none', () => {
  const material = resolveReviewMaterial({
    workerAssignment: assignment(),
    workerResult: result(),
    subjects: [{ ref: 'subject-a', body: subjectBody }],
  });
  // No tool evidence exists, so none may be invented; the reviewer must judge
  // only from the artifact body it was handed.
  assert.deepEqual(material.executorEvidence, []);
});

test('resolveReviewMaterial fails closed on missing, empty, or drifted material', () => {
  const workerAssignment = assignment();
  const workerResult = result();
  assert.throws(
    () => resolveReviewMaterial({ workerAssignment, workerResult, subjects: [] }),
    /must cover every assignment target ref/,
  );
  assert.throws(() => resolveReviewMaterial({
    workerAssignment,
    workerResult,
    subjects: [{ ref: 'subject-a', body: '' }],
  }), /body is empty/);
  assert.throws(
    () => resolveReviewMaterial({
      workerAssignment: assignment({ acceptanceCriteriaDigest: 'sha256:drifted-criteria' }),
      workerResult,
      subjects: [{ ref: 'subject-a', body: subjectBody }],
    }),
    /acceptanceCriteriaDigest/,
  );
  assert.throws(() => resolveReviewMaterial({
    workerAssignment,
    workerResult,
    subjects: [{ ref: 'subject-a', body: 'drifted body' }],
  }), /must match the (declared|produced) artifact digest/);
  assert.throws(() => resolveReviewMaterial({
    workerAssignment,
    workerResult,
    subjects: [{ ref: 'other-subject', body: subjectBody }],
  }), /must match assignment target refs/);
});

test('resolveReviewMaterial rejects a supplied body that disagrees with the carried result body', () => {
  // The digest is self-consistent with the supplied body, so only the
  // carried-body comparison can catch the disagreement.
  const suppliedBody = 'a supplied body that the result did not produce';
  assert.throws(
    () => resolveReviewMaterial({
      workerAssignment: assignment(),
      workerResult: result({
        producedArtifactDigests: [digest(suppliedBody)],
        producedArtifactBodies: [subjectBody],
      }),
      subjects: [{ ref: 'subject-a', body: suppliedBody }],
    }),
    /must match the produced artifact body/,
  );
});

test('manager takes the review subject body from the worker result when the caller supplies none', async () => {
  // The caller cannot know a body that only exists after the worker runs, so
  // the result-carried body must reach the reviewer on its own.
  const reviewer = new RecordingReviewAgent();
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool(),
    executionAgent: new StaticExecutionAgent({
      result: result({
        assignmentId: 'assignment-result-body',
        pipelineNodeId: 'node-result-body',
        producedArtifactBodies: [subjectBody],
      }),
    }),
    reviewAgent: reviewer,
    mergeCoordinator: merge,
  });
  manager.planStage({ nodeId: 'node-result-body', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-result-body',
    assignment: assignment({ assignmentId: 'assignment-result-body', pipelineNodeId: 'node-result-body' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
  });
  assert.equal(dispatched.status, 'merged');
  assert.equal(reviewer.inputs.length, 1);
  assert.equal(reviewer.inputs[0]?.reviewMaterial.subjects[0]?.body, subjectBody);
});

test('manager still blocks when the worker result carries no produced body', async () => {
  const reviewer = new RecordingReviewAgent();
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool(),
    executionAgent: new StaticExecutionAgent({
      result: result({
        assignmentId: 'assignment-empty-body',
        pipelineNodeId: 'node-empty-body',
      }),
    }),
    reviewAgent: reviewer,
    mergeCoordinator: merge,
  });
  manager.planStage({ nodeId: 'node-empty-body', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-empty-body',
    assignment: assignment({ assignmentId: 'assignment-empty-body', pipelineNodeId: 'node-empty-body' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
  });
  assert.equal(dispatched.status, 'blocked');
  assert.equal(dispatched.issue?.code, 'review-material-invalid');
  assert.equal(reviewer.inputs.length, 0, 'an empty body must never reach the reviewer');
});

test('manager passes verified review material to the reviewer and blocks before invocation when it is missing', async () => {
  const reviewer = new RecordingReviewAgent();
  const manager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool(),
    executionAgent: new StaticExecutionAgent({
      result: result(),
    }),
    reviewAgent: reviewer,
    mergeCoordinator: merge,
  });
  manager.planStage({ nodeId: 'node-a', taskId: task });
  const dispatched = await manager.dispatch({
    stageNodeId: 'node-a',
    assignment: assignment(),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: [digest(subjectBody)],
    reviewSubjects: [{ ref: 'subject-a', body: subjectBody }],
  });
  assert.equal(dispatched.status, 'merged');
  assert.equal(reviewer.inputs.length, 1);
  const material = reviewer.inputs[0]?.reviewMaterial;
  assert.ok(material, 'reviewer must receive review material');
  assert.equal(digest(material!.acceptanceCriteria), assignment().acceptanceCriteriaDigest);
  assert.equal(material!.subjects[0]?.body, subjectBody);

  const blockedReviewer = new RecordingReviewAgent();
  const blockedManager = new OrchestrationManager({
    ownerId: 'orchestration-manager',
    runtimePool: pool(),
    executionAgent: new StaticExecutionAgent(result()),
    reviewAgent: blockedReviewer,
    mergeCoordinator: merge,
  });
  blockedManager.planStage({ nodeId: 'node-b', taskId: task });
  const blocked = await blockedManager.dispatch({
    stageNodeId: 'node-b',
    assignment: assignment({ assignmentId: 'assignment-b', pipelineNodeId: 'node-b' }),
    agentId: 'agent-a',
    scope,
    reviewKinds: ['quality'],
    reviewSubjectDigests: [digest(subjectBody)],
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blockedReviewer.inputs.length, 0, 'reviewer must not be invoked without material');
});
