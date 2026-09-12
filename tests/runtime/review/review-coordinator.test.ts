import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  type EvidenceRef,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../packages/contracts/src/index.js';
import {
  REVIEW_CAPABILITIES,
  ReviewCoordinator,
  ReviewCoordinatorError,
  assertCompleteReviewResults,
  assertReviewAssignment,
  assertReviewResult,
  createReviewAssignments,
  decideReviewGate,
  type ReviewAssignment,
  type ReviewResult,
  type ReviewSeverity,
} from '../../../packages/runtime/src/review/index.js';

const organ = id('organ', 'organ-a');
const task = id('task', 'task-a');
const scope: ScopeRef = { organId: organ, taskId: task };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `evidence-${label}`),
    kind: 'operation',
    source: 'test',
    locator: label,
    scope,
  };
}

function assignment(overrides: Partial<WorkAssignment> = {}): WorkAssignment {
  return {
    assignmentId: 'assignment-a',
    taskId: task,
    pipelineNodeId: 'node-a',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective: 'implement review coordinator',
    targetRefs: ['subject-a'],
    expectedOutputRefs: ['out-a'],
    expectedArtifactDigests: ['sha256:artifact-a'],
    acceptanceCriteriaDigest: 'sha256:criteria-a',
    successCriteria: ['review coordinates'],
    failureCriteria: ['missing evidence'],
    incompleteCriteria: ['remediation'],
    requiredCapabilities: ['worker.execute', 'test'],
    mergeGate: 'not-required',
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
    producedArtifactRefs: ['artifact-a'],
    producedArtifactDigests: ['sha256:artifact-a'],
    status: 'succeeded',
    summary: 'worker completed',
    outputRefs: ['out-a'],
    evidenceRefs: [evidence('worker')],
    nextAction: 'settle',
    ...overrides,
  };
}

function reviewAssignments(count = 3): readonly ReviewAssignment[] {
  const created = createReviewAssignments({
    workerAssignment: assignment(),
    workerResult: result(),
    subjectRefs: ['subject-a'],
    subjectDigests: ['sha256:subject-a'],
  });
  return count === 3 ? created : created.slice(0, count);
}

function reviewResult(
  reviewAssignment: ReviewAssignment,
  overrides: Partial<ReviewResult> = {},
): ReviewResult {
  return {
    resultId: `result-${reviewAssignment.assignmentId}`,
    assignmentId: reviewAssignment.assignmentId,
    taskId: reviewAssignment.taskId,
    workerAgentId: reviewAssignment.workerAgentId,
    reviewKind: reviewAssignment.reviewKind,
    attempt: reviewAssignment.attempt,
    executionEpoch: reviewAssignment.executionEpoch,
    inputRevision: reviewAssignment.inputRevision,
    acceptanceCriteriaDigest: reviewAssignment.acceptanceCriteriaDigest,
    subjectRefs: [...reviewAssignment.subjectRefs],
    subjectDigests: [...reviewAssignment.subjectDigests],
    status: 'passed',
    findings: [],
    evidenceRefs: [evidence('review')],
    ...overrides,
  };
}

function failedReviewResult(
  reviewAssignment: ReviewAssignment,
  severity: ReviewSeverity,
): ReviewResult {
  return reviewResult(reviewAssignment, {
    resultId: `result-${reviewAssignment.assignmentId}-${severity}`,
    status: 'failed',
    findings: [
      {
        findingId: `finding-${severity}`,
        severity,
        locationRef: 'src/review/index.ts',
        problem: 'blocking finding',
        expected: 'no remediation severity finding',
        evidenceRefs: [evidence(severity)],
      },
    ],
  });
}

test('creates all review assignments bound to the worker contract', () => {
  const created = reviewAssignments();
  assert.deepEqual(created.map((item) => item.reviewKind), [
    'architecture',
    'baseline',
    'quality',
    'security',
    'delivery',
  ]);
  assert.deepEqual(created.map((item) => item.requiredCapabilities), [
    ['architecture.review'],
    ['baseline.review'],
    ['quality.review'],
    ['security.review'],
    ['delivery.review'],
  ]);
  for (const review of created) {
    assert.ok(review.requiredCapabilities.every((capability) => REVIEW_CAPABILITIES.includes(capability)));
  }
  for (const review of created) {
    assertReviewAssignment(review);
    assert.equal(review.taskId, task.value);
    assert.equal(review.workerAgentId, 'agent-a');
    assert.equal(review.attempt, 1);
    assert.equal(review.executionEpoch, 1);
    assert.equal(review.inputRevision, 1);
    assert.equal(review.acceptanceCriteriaDigest, 'sha256:criteria-a');
    assert.deepEqual(review.subjectRefs, ['subject-a']);
    assert.deepEqual(review.subjectDigests, ['sha256:subject-a']);
    assert.deepEqual(review.workerCapabilities, ['worker.execute', 'test']);
  }
});

test('create review assignments rejects duplicate worker assignment target refs', () => {
  assert.throws(
    () => createReviewAssignments({
      workerAssignment: assignment({ targetRefs: ['subject-a', 'subject-a'] }),
      workerResult: result(),
      subjectRefs: ['subject-a', 'subject-b'],
      subjectDigests: ['sha256:subject-a', 'sha256:subject-b'],
    }),
    ReviewCoordinatorError,
  );
});

test('create review assignments rejects missing and extra worker assignment target refs', () => {
  assert.throws(
    () => createReviewAssignments({
      workerAssignment: assignment({ targetRefs: ['subject-a'] }),
      workerResult: result(),
      subjectRefs: ['subject-a', 'subject-b'],
      subjectDigests: ['sha256:subject-a', 'sha256:subject-b'],
    }),
    ReviewCoordinatorError,
  );
  assert.throws(
    () => createReviewAssignments({
      workerAssignment: assignment({ targetRefs: ['subject-a', 'subject-b'] }),
      workerResult: result(),
      subjectRefs: ['subject-a'],
      subjectDigests: ['sha256:subject-a'],
    }),
    ReviewCoordinatorError,
  );
});

test('rejects unregistered runtime review kinds before assignment validation', () => {
  const [review] = reviewAssignments(1);
  const arbitraryAssignment: ReviewAssignment = {
    ...review,
    reviewKind: 'arbitrary' as ReviewAssignment['reviewKind'],
    requiredCapabilities: ['arbitrary.review'],
  };
  assert.throws(
    () => assertReviewAssignment(arbitraryAssignment),
    ReviewCoordinatorError,
  );

  assert.throws(
    () => createReviewAssignments({
      workerAssignment: assignment(),
      workerResult: result(),
      reviewKinds: ['arbitrary'] as unknown as readonly ReviewAssignment['reviewKind'][],
      subjectRefs: ['subject-a'],
      subjectDigests: ['sha256:subject-a'],
    }),
    ReviewCoordinatorError,
  );
});

test('asserts runtime review result kind status and finding severity whitelists', () => {
  const [review] = reviewAssignments(1);
  assert.throws(
    () => assertReviewResult({
      ...reviewResult(review),
      reviewKind: 'arbitrary' as unknown as ReviewResult['reviewKind'],
    }),
    ReviewCoordinatorError,
  );
  assert.throws(
    () => assertReviewResult({
      ...reviewResult(review),
      status: 'unknown' as unknown as ReviewResult['status'],
    }),
    ReviewCoordinatorError,
  );
  assert.throws(
    () => assertReviewResult(reviewResult(review, {
      status: 'inconclusive',
      findings: [{
        findingId: 'finding-unknown-severity',
        severity: 'arbitrary' as unknown as ReviewSeverity,
        locationRef: 'src/review/index.ts',
        problem: 'unknown severity',
        expected: 'registered severity',
        evidenceRefs: [evidence('unknown-severity')],
      }],
    })),
    ReviewCoordinatorError,
  );
});

test('asserts review finding ids are non-empty and unique', () => {
  const [review] = reviewAssignments(1);
  assert.throws(
    () => assertReviewResult(reviewResult(review, {
      status: 'failed',
      findings: [{
        findingId: '   ',
        severity: 'P1',
        locationRef: 'src/review/index.ts',
        problem: 'missing identity',
        expected: 'stable finding identity',
        evidenceRefs: [evidence('empty-finding-id')],
      }],
    })),
    ReviewCoordinatorError,
  );
  assert.throws(
    () => assertReviewResult(reviewResult(review, {
      status: 'failed',
      findings: [
        {
          findingId: 'finding-duplicate',
          severity: 'P1',
          locationRef: 'src/review/index.ts',
          problem: 'first duplicate',
          expected: 'unique finding identity',
          evidenceRefs: [evidence('duplicate-1')],
        },
        {
          findingId: 'finding-duplicate',
          severity: 'important',
          locationRef: 'src/review/index.ts',
          problem: 'second duplicate',
          expected: 'unique finding identity',
          evidenceRefs: [evidence('duplicate-2')],
        },
      ],
    })),
    ReviewCoordinatorError,
  );
});

test('review coordinator rejects malformed review results', () => {
  const coordinator = new ReviewCoordinator();
  const [review] = reviewAssignments(1);
  coordinator.addReviewAssignment(review);
  assert.throws(
    () => coordinator.addReviewResult({
      ...reviewResult(review),
      reviewKind: 'arbitrary' as unknown as ReviewResult['reviewKind'],
    }),
    ReviewCoordinatorError,
  );
  assert.equal(coordinator.listReviewResults().length, 0);
});

test('review coordinator rejects duplicate assignment and result ids without overwriting', () => {
  const coordinator = new ReviewCoordinator();
  const [review] = reviewAssignments(1);
  coordinator.addReviewAssignment(review);
  assert.throws(() => coordinator.addReviewAssignment(review), ReviewCoordinatorError);
  assert.equal(coordinator.listReviewAssignments().length, 1);

  coordinator.addReviewResult(reviewResult(review));
  assert.throws(() => coordinator.addReviewResult(reviewResult(review)), ReviewCoordinatorError);
  assert.equal(coordinator.listReviewResults().length, 1);
});

test('review coordinator addReviewAssignments is atomic on conflict and invalid input', () => {
  const coordinator = new ReviewCoordinator();
  const [existing, incoming] = reviewAssignments(2);
  coordinator.addReviewAssignment(existing);

  const assignmentsBeforeConflict = coordinator.listReviewAssignments();
  const resultsBeforeConflict = coordinator.listReviewResults();
  assert.throws(
    () => coordinator.addReviewAssignments([incoming, existing]),
    ReviewCoordinatorError,
  );
  assert.deepEqual(coordinator.listReviewAssignments(), assignmentsBeforeConflict);
  assert.deepEqual(coordinator.listReviewResults(), resultsBeforeConflict);

  const invalid = {
    ...incoming,
    reviewKind: 'arbitrary' as unknown as ReviewAssignment['reviewKind'],
  };
  const assignmentsBeforeInvalid = coordinator.listReviewAssignments();
  assert.throws(
    () => coordinator.addReviewAssignments([incoming, invalid]),
    ReviewCoordinatorError,
  );
  assert.deepEqual(coordinator.listReviewAssignments(), assignmentsBeforeInvalid);
  assert.equal(coordinator.listReviewAssignments().length, 1);
});

test('success gate requires complete review results and merge evidence for merge-required work', () => {
  const reviews = reviewAssignments(1);
  const [review] = reviews;
  const work = assignment({ mergeGate: 'required' });
  const workResult = result();
  const decisions = [
    decideReviewGate({
      workerAssignment: work,
      workerResult: workResult,
      reviewAssignments: reviews,
      reviewResults: [reviewResult(review)],
      mergeEvidenceRefs: [evidence('merge')],
      orchestrationManagerId: 'orchestration-manager',
    }),
  ];
  assert.equal(decisions[0].status, 'succeeded');
  assert.equal(decisions[0].nextAction.kind, 'settle');

  const withoutMerge = decideReviewGate({
    workerAssignment: work,
    workerResult: workResult,
    reviewAssignments: reviews,
    reviewResults: [reviewResult(review)],
    orchestrationManagerId: 'orchestration-manager',
  });
  assert.equal(withoutMerge.status, 'waiting');
  assert.equal(withoutMerge.nextAction.kind, 'wait');
  assert.equal(withoutMerge.nextAction.ref, `merge:${workResult.assignmentId}`);
});

test('waiting requires owner evidence conditionRef and terminal failures never become waiting', () => {
  const waiting = decideReviewGate({
    workerAssignment: assignment(),
    workerResult: result({
      nextAction: 'wait',
      conditionRef: 'condition-a',
    }),
    orchestrationManagerId: 'orchestration-manager',
  });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.ownerId, 'orchestration-manager');
  assert.ok(waiting.evidenceRefs.length > 0);
  assert.equal(waiting.nextAction.kind, 'wait');
  assert.equal(waiting.nextAction.ref, 'condition-a');

  assert.throws(
    () =>
      decideReviewGate({
        workerAssignment: assignment(),
        workerResult: result({
          nextAction: 'wait',
        } as Partial<WorkResult>),
        orchestrationManagerId: 'orchestration-manager',
      }),
    ContractError,
  );

  for (const status of ['failed', 'incomplete', 'blocked', 'cancelled'] as const) {
    const decided = decideReviewGate({
      workerAssignment: assignment(),
      workerResult: result({
        status,
        nextAction: 'wait',
        conditionRef: 'condition-a',
        outputRefs: status === 'failed' ? [] : [],
        failureRef: status === 'failed' ? 'failure-a' : undefined,
      } as Partial<WorkResult>),
      orchestrationManagerId: 'orchestration-manager',
    });
    assert.equal(decided.status, status);
    assert.equal(decided.ownerId, 'orchestration-manager');
    assert.ok(decided.evidenceRefs.length > 0);
    assert.ok(decided.nextAction.ref.length > 0);
  }
});

test('P0, P1, blocker, and important findings require remediation owned by the orchestration manager', () => {
  const [review] = reviewAssignments(1);
  for (const severity of ['P0', 'P1', 'blocker', 'important'] as const) {
    const decided = decideReviewGate({
      workerAssignment: assignment(),
      workerResult: result({ nextAction: 'review' }),
      reviewAssignments: [review],
      reviewResults: [failedReviewResult(review, severity)],
      orchestrationManagerId: 'orchestration-manager',
    });
    assert.equal(decided.status, 'remediation');
    assert.equal(decided.ownerId, 'orchestration-manager');
    assert.equal(decided.nextAction.kind, 'remediate');
    assert.ok(decided.remediation);
    assert.equal(decided.remediation?.ownerId, 'orchestration-manager');
    assert.deepEqual(decided.remediation?.requiredCapabilities, ['worker.execute', 'test']);
    assert.deepEqual(decided.remediation?.excludedReviewCapabilities, []);
    assert.equal(decided.remediation?.findingIds.length, 1);
  }
});

test('rejects stale mismatch contradictory and missing evidence review results', () => {
  const [review] = reviewAssignments(1);
  assert.throws(
    () => decideReviewGate({
      workerAssignment: assignment(),
      workerResult: result({ nextAction: 'review' }),
      reviewAssignments: [review],
      reviewResults: [reviewResult(review, { executionEpoch: 2 })],
      orchestrationManagerId: 'orchestration-manager',
    }),
    ReviewCoordinatorError,
  );
  assert.throws(
    () => decideReviewGate({
      workerAssignment: assignment(),
      workerResult: result({ nextAction: 'review' }),
      reviewAssignments: [review],
      reviewResults: [reviewResult(review, { subjectRefs: ['subject-b'] })],
      orchestrationManagerId: 'orchestration-manager',
    }),
    ReviewCoordinatorError,
  );
  assert.throws(
    () => decideReviewGate({
      workerAssignment: assignment(),
      workerResult: result({ nextAction: 'review' }),
      reviewAssignments: [review],
      reviewResults: [reviewResult(review, {
        status: 'passed',
        findings: [{
          findingId: 'finding-contradiction',
          severity: 'blocker',
          locationRef: 'src/review/index.ts',
          problem: 'contradictory pass',
          expected: 'no blocker finding',
          evidenceRefs: [evidence('contradiction')],
        }],
      })],
      orchestrationManagerId: 'orchestration-manager',
    }),
    ReviewCoordinatorError,
  );
  assert.throws(
    () => decideReviewGate({
      workerAssignment: assignment(),
      workerResult: result({ nextAction: 'review' }),
      reviewAssignments: [review],
      reviewResults: [reviewResult(review, { evidenceRefs: [] })],
      orchestrationManagerId: 'orchestration-manager',
    }),
    ReviewCoordinatorError,
  );
  assert.throws(
    () => decideReviewGate({
      workerAssignment: assignment(),
      workerResult: result({ nextAction: 'review' }),
      reviewAssignments: [review],
      reviewResults: [reviewResult(review, {
        status: 'failed',
        findings: [{
          findingId: 'finding-no-evidence',
          severity: 'important',
          locationRef: 'src/review/index.ts',
          problem: 'missing evidence',
          expected: 'evidence present',
          evidenceRefs: [],
        }],
      })],
      orchestrationManagerId: 'orchestration-manager',
    }),
    ReviewCoordinatorError,
  );
});

test('review gate rejects assignments not bound to current task epoch worker or target', () => {
  const [review] = reviewAssignments(1);
  const externalTask = id('task', 'task-external');
  const cases: ReadonlyArray<{ name: string; review: ReviewAssignment }> = [
    {
      name: 'external task',
      review: { ...review, taskId: externalTask.value },
    },
    {
      name: 'old epoch',
      review: { ...review, executionEpoch: 2 },
    },
    {
      name: 'wrong worker',
      review: { ...review, workerAgentId: 'agent-b' },
    },
    {
      name: 'wrong target',
      review: { ...review, subjectRefs: ['subject-b'] },
    },
    {
      name: 'external worker assignment',
      review: { ...review, assignmentId: 'assignment-external:review:architecture' },
    },
  ];

  for (const { name, review: boundReview } of cases) {
    assert.throws(
      () => decideReviewGate({
        workerAssignment: assignment(),
        workerResult: result({ nextAction: 'review' }),
        reviewAssignments: [boundReview],
        reviewResults: [reviewResult(boundReview)],
        orchestrationManagerId: 'orchestration-manager',
      }),
      ReviewCoordinatorError,
    );
  }
});

test('review gate rejects duplicate missing and extra worker target refs at binding', () => {
  const [review] = reviewAssignments(1);
  const twoTargetReview: ReviewAssignment = {
    ...review,
    subjectRefs: ['subject-a', 'subject-b'],
    subjectDigests: ['sha256:subject-a', 'sha256:subject-b'],
  };
  const oneTargetReview: ReviewAssignment = {
    ...review,
    subjectRefs: ['subject-a'],
    subjectDigests: ['sha256:subject-a'],
  };
  const cases: ReadonlyArray<{ workerAssignment: WorkAssignment; boundReview: ReviewAssignment }> = [
    {
      workerAssignment: assignment({ targetRefs: ['subject-a', 'subject-a'] }),
      boundReview: twoTargetReview,
    },
    {
      workerAssignment: assignment({ targetRefs: ['subject-a'] }),
      boundReview: twoTargetReview,
    },
    {
      workerAssignment: assignment({ targetRefs: ['subject-a', 'subject-b'] }),
      boundReview: oneTargetReview,
    },
  ];

  for (const { workerAssignment, boundReview } of cases) {
    assert.throws(
      () => decideReviewGate({
        workerAssignment,
        workerResult: result(),
        reviewAssignments: [boundReview],
        reviewResults: [reviewResult(boundReview)],
        orchestrationManagerId: 'orchestration-manager',
      }),
      ReviewCoordinatorError,
    );
  }
});

test('rejects missing and extra review results at the gate', () => {
  const reviews = reviewAssignments(2);
  assert.throws(
    () => decideReviewGate({
      workerAssignment: assignment(),
      workerResult: result({ nextAction: 'review' }),
      reviewAssignments: reviews,
      reviewResults: [reviewResult(reviews[0])],
      orchestrationManagerId: 'orchestration-manager',
    }),
    ReviewCoordinatorError,
  );

  const extra = reviewResult(reviews[1], { resultId: 'result-extra' });
  assert.throws(
    () => assertCompleteReviewResults(reviews, [...reviews.map((item) => reviewResult(item)), extra]),
    ReviewCoordinatorError,
  );
});

test('review-required and inconclusive review block success', () => {
  const [review] = reviewAssignments(1);
  const withoutReviewAssignments = decideReviewGate({
    workerAssignment: assignment(),
    workerResult: result({ nextAction: 'review' }),
    orchestrationManagerId: 'orchestration-manager',
  });
  assert.equal(withoutReviewAssignments.status, 'waiting');
  assert.equal(withoutReviewAssignments.nextAction.kind, 'review');

  const inconclusive = decideReviewGate({
    workerAssignment: assignment(),
    workerResult: result({ nextAction: 'review' }),
    reviewAssignments: [review],
    reviewResults: [reviewResult(review, {
      status: 'inconclusive',
      findings: [{
        findingId: 'finding-inconclusive',
        severity: 'advisory',
        locationRef: 'src/review/index.ts',
        problem: 'not enough evidence',
        expected: 'clear verdict',
        evidenceRefs: [evidence('inconclusive')],
      }],
    })],
    orchestrationManagerId: 'orchestration-manager',
  });
  assert.equal(inconclusive.status, 'waiting');
  assert.equal(inconclusive.nextAction.kind, 'review');
});
