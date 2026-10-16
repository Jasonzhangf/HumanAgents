import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  validateAcceptedChildDelivery,
  validateAcceptedRawFact,
  validateActiveTurnCaptureBody,
  validateRawFactEnvelope,
  validatePreparedRecoveryCapture,
  type PreparedRecoveryCapture,
  type AcceptedChildDelivery,
  type AcceptedReviewChildDelivery,
  type ActiveTurnProviderExecutionIdentityRef,
  type ActiveTurnProviderRequestIdentityRef,
  type ActiveTurnCaptureBody,
  type AdmittedTurn,
  type BusinessPayload,
  type EvidenceRef,
  type ProviderRawFact,
  type ProviderExecutionIdentityRef,
  type ProviderRequestIdentityRef,
  type ProviderToolResult,
  type RawAsset,
  type RawFactEnvelope,
  type ReviewAssignment,
  type ReviewFinding,
  type ReviewResult,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '@humanagent/contracts';
import { validateActiveTurnSegmentPredecessorRef } from '../../packages/contracts/src/active-turn-segments.js';
import { ContractError as SourceContractError } from '../../packages/contracts/src/errors.js';

const organId = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const cycleId = id('cycle', 'cycle-a');
const operationId = id('operation', 'operation-a');
const scope: ScopeRef = { organId, taskId, cycleId, operationId };
const assignment: WorkAssignment = {
  assignmentId: 'assignment-a', taskId, pipelineNodeId: 'node-a', attempt: 1, executionEpoch: 3, inputRevision: 1,
  objective: 'inspect fixture', targetRefs: [], expectedOutputRefs: [], acceptanceCriteriaDigest: 'sha256:a',
  successCriteria: ['done'], failureCriteria: ['bad'], incompleteCriteria: ['partial'], requiredCapabilities: [], mergeGate: 'not-required',
};
const admittedTurn: AdmittedTurn = {
  turnId: 'turn-a', workAssignmentRef: 'assignment-a', taskRef: taskId, scopeRef: scope, cycleRef: cycleId,
  inputRevision: 1, directiveRevision: 1, executionEpoch: 3, runtimeBindingRef: 'runtime-binding-a', permissionRevision: 'p1',
  admissionEvidenceRefs: [], currentTurnRef: 'turn-a', recoveryStateRef: 'recovery-a',
};
const execution = { runtimeId: 'runtime-a', executionEpoch: 3 } as const;

function evidence(label: string, digest = `sha256:${'a'.repeat(64)}`): EvidenceRef {
  return { evidenceId: id('evidence', label), kind: 'execution', source: 'fixture', locator: label, digest, scope };
}

function rawAsset(label: string): RawAsset {
  return { ref: evidence(label), view: { kind: 'utf8-text' } };
}

function envelope(producerSeq: number, fact: ProviderRawFact, overrides: Partial<RawFactEnvelope> = {}): RawFactEnvelope {
  return {
    execution,
    scope,
    request: { turnId: 'provider-turn-a', requestId: 'request-a' },
    producerSeq,
    fact,
    ...overrides,
  };
}

const assistantDelta = envelope(1, {
  kind: 'content', contentUnitId: 'unit-text', channel: 'assistant-text', update: 'delta', content: rawAsset('text-delta'), complete: false,
});
const assistantFull = envelope(2, {
  kind: 'content', contentUnitId: 'unit-text', channel: 'assistant-text', update: 'full', content: rawAsset('text-full'), complete: true,
});
const toolCall = envelope(3, {
  kind: 'tool-call', contentUnitId: 'unit-call', call: { callId: 'call-a', toolId: 'tool-a', arguments: { x: 1 }, continuationRef: 'cont-a' }, rawArguments: rawAsset('call-args'), complete: true,
});

function toolResult(overrides: Partial<ProviderToolResult> = {}): ProviderToolResult {
  return {
    runtimeId: execution.runtimeId, taskId, operationId, executionEpoch: execution.executionEpoch,
    toolId: 'tool-a', callId: 'call-a', status: 'succeeded', outputRefs: ['tool-output-a'], evidenceRefs: [evidence('tool-result')],
    ...overrides,
  };
}
const toolResultFact = envelope(4, {
  kind: 'tool-result', contentUnitId: 'unit-result', callId: 'call-a', continuationRef: 'cont-a',
  result: toolResult(), rawOutput: rawAsset('raw-output'), complete: true,
});
const requestComplete = envelope(5, { kind: 'request-complete', terminal: 'completed' });

// A child refined delivery has no Provider envelope. It reuses the real child
// WorkAssignment/WorkResult identity and the persisted refined asset.
const childAssignment: WorkAssignment = { ...assignment, assignmentId: 'assignment-child', pipelineNodeId: 'node-child' };
const childResult: WorkResult = {
  taskId, pipelineNodeId: 'node-child', agentId: 'agent-child', assignmentId: 'assignment-child', attempt: 1, executionEpoch: 3, inputRevision: 1,
  producedArtifactRefs: [], producedArtifactDigests: [], status: 'succeeded', summary: 'refined child delivery',
  outputRefs: [], evidenceRefs: [evidence('child-result')], nextAction: 'settle',
};
const childDelivery: AcceptedChildDelivery = {
  kind: 'execution',
  seq: 6,
  invocationId: 'invocation-b',
  refinedDelivery: rawAsset('refined-delivery'),
  assignment: childAssignment,
  result: childResult,
};

const baseBody: ActiveTurnCaptureBody = {
  version: 1,
  binding: { admittedTurn, assignment, execution, scope },
  initialInput: { ref: evidence('initial-input'), view: { kind: 'text-field', field: 'text' } },
  entries: [
    { seq: 1, envelope: assistantDelta },
    { seq: 2, envelope: assistantFull },
    { seq: 3, envelope: toolCall },
    { seq: 4, envelope: toolResultFact },
    { seq: 5, envelope: requestComplete },
    childDelivery,
  ],
  requests: [{ request: { turnId: 'provider-turn-a', requestId: 'request-a' }, scope, phase: 'settled' }],
  childInvocations: [
    // Dispatch checkpoint receipt, no adopted result yet.
    { invocationId: 'invocation-a', childTurnId: 'turn-child', checkpointReceiptRef: 'checkpoint-receipt-a', binding: { kind: 'execution', assignment } },
    // Parent received the refined delivery at seq 6 and adopted it.
    { invocationId: 'invocation-b', childTurnId: 'turn-child-b', checkpointReceiptRef: 'checkpoint-receipt-b', binding: { kind: 'execution', assignment: childAssignment }, adoptedResultSeq: 6 },
  ],
  checkpointPath: ['checkpoint-a', 'checkpoint-b'],
  cut: { pauseId: 'pause-a', lastSeq: 6, producersDrained: true, frozenAt: '2026-10-12T00:00:00.000Z' },
  completionRefs: [{ requestId: 'request-a', producerSeq: 4, effectRef: 'effect-a' }],
};

test('production capture proof binds the actual producer boundary and durable raw sequence', () => {
  const prepared: PreparedRecoveryCapture = {
    body: baseBody,
    controlRecordCount: 10,
    producerDrains: [{ execution, boundaryId: 'pause-a', requests: [{ request: assistantDelta.request, lastProducerSeq: 5 }] }],
    completionLookups: [],
    recovery: { commitIdentity: 'capture-a', rawTurnRefs: [], laterErrorRefs: [], unresolvedOperationRefs: [], stages: [], durablePhases: [], durableReceiptRefs: [], recoveryResponsibilityRef: 'recovery-a' },
  };
  assert.doesNotThrow(() => validatePreparedRecoveryCapture(prepared));
  assert.throws(() => validatePreparedRecoveryCapture({ ...prepared, producerDrains: [] }), ContractError);
  assert.throws(() => validatePreparedRecoveryCapture({
    ...prepared,
    producerDrains: [{ ...prepared.producerDrains[0]!, boundaryId: 'another-boundary' }],
  }), ContractError);
  assert.throws(() => validatePreparedRecoveryCapture({
    ...prepared,
    producerDrains: [{ ...prepared.producerDrains[0]!, requests: [{ request: assistantDelta.request, lastProducerSeq: 6 }] }],
  }), ContractError);
});

test('valid raw fact envelopes and a frozen capture body validate', () => {
  for (const item of [assistantDelta, assistantFull, toolCall, toolResultFact, requestComplete]) {
    assert.doesNotThrow(() => validateRawFactEnvelope(item));
  }
  assert.doesNotThrow(() => validateAcceptedRawFact({ seq: 1, envelope: assistantDelta }));
  assert.doesNotThrow(() => validateActiveTurnCaptureBody(baseBody));
});

test('raw fact envelope rejects non-positive producerSeq and missing request identity', () => {
  assert.throws(() => validateRawFactEnvelope({ ...assistantDelta, producerSeq: 0 }), ContractError);
  assert.throws(() => validateRawFactEnvelope({ ...assistantDelta, producerSeq: 1.5 }), ContractError);
  assert.throws(() => validateRawFactEnvelope({ ...assistantDelta, request: { turnId: '', requestId: 'request-a' } }), ContractError);
  assert.throws(() => validateRawFactEnvelope({ ...assistantDelta, request: { turnId: 'provider-turn-a', requestId: 'request-a', parentRequestId: 'request-a' } }), ContractError);
});

test('delta, full and complete stay distinct in the content fact', () => {
  assert.throws(
    () => validateRawFactEnvelope(envelope(1, {
      kind: 'content', contentUnitId: 'unit-text', channel: 'assistant-text', update: 'delta', content: rawAsset('text-delta'), complete: false, replacesUnitIds: ['unit-other'],
    })),
    ContractError,
  );
  assert.doesNotThrow(() => validateRawFactEnvelope(envelope(2, {
    kind: 'content', contentUnitId: 'unit-text', channel: 'assistant-text', update: 'full', content: rawAsset('text-full'), complete: true, replacesUnitIds: ['unit-part-0'],
  })));
  assert.throws(
    () => validateRawFactEnvelope({ ...assistantDelta, fact: { ...assistantDelta.fact, complete: 'yes' } } as unknown as RawFactEnvelope),
    ContractError,
  );
  // A completion boundary with no new content carries no asset.
  assert.doesNotThrow(() => validateRawFactEnvelope(envelope(6, { kind: 'content-complete', contentUnitId: 'unit-text' })));
});

test('tool result keeps exact call identity and a raw output asset', () => {
  assert.throws(
    () => validateRawFactEnvelope({ ...toolResultFact, fact: { ...toolResultFact.fact, callId: 'call-other' } }),
    ContractError,
  );
  assert.throws(
    () => validateRawFactEnvelope({ ...toolResultFact, fact: { ...toolResultFact.fact, rawOutput: { ref: evidence('raw-output') } } }),
    ContractError,
  );
  assert.throws(
    () => validateRawFactEnvelope({ ...toolResultFact, fact: { ...toolResultFact.fact, result: { ...toolResult(), callId: 'call-other' } } }),
    ContractError,
  );
});

test('request terminal is a provider boundary and never a business turn closure', () => {
  assert.doesNotThrow(() => validateRawFactEnvelope(requestComplete));
  assert.throws(
    () => validateRawFactEnvelope({ ...requestComplete, fact: { kind: 'request-complete', terminal: 'done' } }),
    ContractError,
  );
  assert.throws(
    () => validateRawFactEnvelope({ ...requestComplete, fact: { kind: 'request-complete', terminal: 'failed', error: { code: '' } } }),
    ContractError,
  );
});

test('capture body rejects non-monotonic seq and a cut that does not match the last accepted fact', () => {
  assert.throws(
    () => validateActiveTurnCaptureBody({ ...baseBody, entries: [{ seq: 2, envelope: assistantDelta }, { seq: 1, envelope: assistantFull }] }),
    ContractError,
  );
  assert.throws(
    () => validateActiveTurnCaptureBody({ ...baseBody, cut: { ...baseBody.cut, lastSeq: 4 } }),
    ContractError,
  );
  assert.throws(
    () => validateActiveTurnCaptureBody({ ...baseBody, cut: { ...baseBody.cut, pauseId: '' } }),
    ContractError,
  );
});

test('capture cut must be a drained producer', () => {
  assert.throws(
    () => validateActiveTurnCaptureBody({ ...baseBody, cut: { ...baseBody.cut, producersDrained: false } }),
    ContractError,
  );
});

test('an empty capture accepts lastSeq 0', () => {
  assert.doesNotThrow(() => validateActiveTurnCaptureBody({
    ...baseBody,
    entries: [],
    childInvocations: [],
    cut: { ...baseBody.cut, lastSeq: 0 },
  }));
});

test('capture body rejects foreign scope, mismatched epoch, and an unresolved child binding', () => {
  assert.throws(
    () => validateActiveTurnCaptureBody({ ...baseBody, binding: { ...baseBody.binding, execution: { runtimeId: 'runtime-a', executionEpoch: 4 } } }),
    ContractError,
  );
  assert.throws(
    () => validateActiveTurnCaptureBody({ ...baseBody, requests: [{ ...baseBody.requests[0]!, scope: { organId: id('organ', 'organ-b'), taskId } }] }),
    ContractError,
  );
  assert.throws(
    () => validateActiveTurnCaptureBody({ ...baseBody, childInvocations: [{ invocationId: 'invocation-a', childTurnId: 'turn-child', checkpointReceiptRef: '' }] }),
    ContractError,
  );
});

test('capture body rejects a binding whose admitted turn and assignment disagree', () => {
  const foreignAssignment: WorkAssignment = { ...assignment, assignmentId: 'assignment-b' };
  assert.throws(
    () => validateActiveTurnCaptureBody({ ...baseBody, binding: { ...baseBody.binding, assignment: foreignAssignment } }),
    ContractError,
  );
});

test('business payload separation: no control key is accepted as a business field', () => {
  const payload = { continuation: 'x' } as unknown as BusinessPayload;
  // The raw boundary holds only assets and identities, never a business payload.
  assert.equal(Object.prototype.hasOwnProperty.call(assistantDelta.fact, 'payload'), false);
  assert.throws(() => validateRawFactEnvelope({ ...assistantDelta, payload } as unknown as RawFactEnvelope), ContractError);
});

test('public consumer names the active-turn raw identity apart from the Provider-wide identity', () => {
  // The Provider-wide identity keeps its full scope shape.
  const providerExecution: ProviderExecutionIdentityRef = { runtimeId: 'runtime-a', taskId, operationId, executionEpoch: 3 };
  const providerRequest: ProviderRequestIdentityRef = { turnId: 'provider-turn-a', requestId: 'request-a' };

  // A public consumer must be able to name the narrow raw-fact identity, not the Provider-wide one.
  const rawExecution: ActiveTurnProviderExecutionIdentityRef = assistantDelta.execution;
  const rawRequest: ActiveTurnProviderRequestIdentityRef = assistantDelta.request;

  assert.equal(rawExecution.executionEpoch, providerExecution.executionEpoch);
  assert.equal(rawRequest.requestId, providerRequest.requestId);

  // @ts-expect-error the narrow raw fact identity cannot satisfy the Provider-wide identity
  const rawIsNotProviderWide: ProviderExecutionIdentityRef = rawExecution;
  void rawIsNotProviderWide;
});

test('active turn segment predecessor accepts captured or interrupted and rejects invalid unions', () => {
  const interruptedAnchor = {
    openedCommitRef: { commitId: 'commit-opened-a', journalSeq: 1, recordDigest: 'sha256:' + 'a'.repeat(64) },
    recordsThroughCommitRef: { commitId: 'commit-records-a', journalSeq: 2, recordDigest: 'sha256:' + 'a'.repeat(64) },
  };
  assert.doesNotThrow(() => validateActiveTurnSegmentPredecessorRef({
    segmentId: 'segment-a',
    recoveryAssetsReceiptRef: 'receipt-a',
  }));
  assert.doesNotThrow(() => validateActiveTurnSegmentPredecessorRef({
    segmentId: 'segment-a',
    interrupted: interruptedAnchor,
  }));
  assert.throws(() => validateActiveTurnSegmentPredecessorRef({
    segmentId: 'segment-a',
    recoveryAssetsReceiptRef: 'receipt-a',
    interrupted: interruptedAnchor,
  }), SourceContractError);
  assert.throws(() => validateActiveTurnSegmentPredecessorRef({ segmentId: 'segment-a' }), SourceContractError);
  assert.throws(() => validateActiveTurnSegmentPredecessorRef({
    segmentId: 'segment-a',
    interrupted: { openedCommitRef: {}, recordsThroughCommitRef: interruptedAnchor.recordsThroughCommitRef },
  }), SourceContractError);
});

test('an unadopted child invocation keeps a real checkpoint receipt without a fabricated adopted seq', () => {
  // Dispatch checkpoint committed; the child has not returned or been adopted yet.
  const inFlight: ActiveTurnCaptureBody = {
    ...baseBody,
    entries: [{ seq: 1, envelope: assistantDelta }],
    childInvocations: [{ invocationId: 'invocation-a', childTurnId: 'turn-child', checkpointReceiptRef: 'checkpoint-receipt-a', binding: { kind: 'execution', assignment } }],
    cut: { ...baseBody.cut, lastSeq: 1 },
  };
  assert.doesNotThrow(() => validateActiveTurnCaptureBody(inFlight));
  assert.equal(inFlight.childInvocations[0]!.adoptedResultSeq, undefined);
});

test('a refined child delivery with no Provider envelope is accepted and links adoption by seq', () => {
  assert.doesNotThrow(() => validateActiveTurnCaptureBody(baseBody));
  const adopted = baseBody.entries.find((entry) => entry.seq === 6);
  assert.notEqual(adopted, undefined);
  assert.equal('envelope' in adopted!, false);
  assert.equal((adopted as AcceptedChildDelivery).invocationId, 'invocation-b');
  assert.equal(baseBody.cut.lastSeq, 6);
});

test('an adopted result seq pointing at another invocation is rejected', () => {
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...baseBody,
      childInvocations: [
        { invocationId: 'invocation-a', childTurnId: 'turn-child', checkpointReceiptRef: 'checkpoint-receipt-a', binding: { kind: 'execution', assignment } },
        { invocationId: 'invocation-c', childTurnId: 'turn-child-c', checkpointReceiptRef: 'checkpoint-receipt-c', binding: { kind: 'execution', assignment: childAssignment }, adoptedResultSeq: 6 },
      ],
    }),
    ContractError,
  );
});

test('a child delivery referencing an unknown invocation is rejected', () => {
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...baseBody,
      childInvocations: [{ invocationId: 'invocation-a', childTurnId: 'turn-child', checkpointReceiptRef: 'checkpoint-receipt-a', binding: { kind: 'execution', assignment } }],
    }),
    ContractError,
  );
});

// A review child call keeps the real ReviewAssignment/ReviewResult identity. The
// reviewer return is never converted to a WorkResult, and the shared review
// types are the Contracts-owned definitions.
const reviewAssignment: ReviewAssignment = {
  assignmentId: 'assignment-a:review:quality',
  taskId: taskId.value,
  workerAgentId: 'reviewer-1',
  reviewKind: 'quality',
  attempt: 1,
  executionEpoch: 3,
  inputRevision: 1,
  acceptanceCriteriaDigest: 'sha256:a',
  subjectRefs: ['ref-a'],
  subjectDigests: ['sha256:b'],
  workerCapabilities: ['provider.execution'],
  requiredCapabilities: ['quality.review'],
  mergeGate: 'not-required',
};
const reviewFinding: ReviewFinding = {
  findingId: 'finding-1',
  severity: 'advisory',
  locationRef: 'packages/runtime/src/review/index.ts',
  problem: 'review evidence is thin',
  expected: 'attach the raw subject digest',
  evidenceRefs: [evidence('review-finding')],
};
const reviewResult: ReviewResult = {
  resultId: 'review-result-a',
  assignmentId: 'assignment-a:review:quality',
  taskId: 'task-a',
  workerAgentId: 'reviewer-1',
  reviewKind: 'quality',
  attempt: 1,
  executionEpoch: 3,
  inputRevision: 1,
  acceptanceCriteriaDigest: 'sha256:a',
  subjectRefs: ['ref-a'],
  subjectDigests: ['sha256:b'],
  status: 'inconclusive',
  findings: [reviewFinding],
  evidenceRefs: [evidence('review-result')],
};
const reviewDelivery: AcceptedReviewChildDelivery = {
  kind: 'review',
  seq: 7,
  invocationId: 'invocation-review',
  refinedDelivery: rawAsset('refined-review'),
  assignment: reviewAssignment,
  result: reviewResult,
};
const reviewBody: ActiveTurnCaptureBody = {
  ...baseBody,
  entries: [...baseBody.entries, reviewDelivery],
  childInvocations: [
    ...baseBody.childInvocations,
    {
      invocationId: 'invocation-review',
      childTurnId: 'turn-child-review',
      checkpointReceiptRef: 'checkpoint-receipt-review-pre',
      binding: { kind: 'review', assignment: reviewAssignment },
      adoptedResultSeq: 7,
      postReviewCheckpointRef: 'checkpoint-receipt-review-post',
    },
  ],
  cut: { ...baseBody.cut, lastSeq: 7 },
};

test('a review delivery is bound to its review invocation and keeps findings, subject and evidence', () => {
  assert.doesNotThrow(() => validateActiveTurnCaptureBody(reviewBody));
  const adopted = reviewBody.entries.find((entry) => entry.seq === 7) as AcceptedReviewChildDelivery;
  assert.equal(adopted.kind, 'review');
  assert.equal(adopted.result.status, 'inconclusive');
  assert.equal(adopted.result.findings[0]!.findingId, 'finding-1');
  assert.equal(adopted.result.findings[0]!.severity, 'advisory');
  assert.deepEqual(adopted.result.subjectRefs, ['ref-a']);
  assert.deepEqual(adopted.result.subjectDigests, ['sha256:b']);
  assert.equal(adopted.result.evidenceRefs[0]!.evidenceId.value, 'review-result');
  const invocation = reviewBody.childInvocations.find((candidate) => candidate.invocationId === 'invocation-review')!;
  assert.equal(invocation.binding.kind, 'review');
  assert.notEqual(invocation.postReviewCheckpointRef, invocation.checkpointReceiptRef);
});

test('a review result whose subject digests do not match its assignment is rejected', () => {
  assert.throws(
    () => validateAcceptedChildDelivery({ ...reviewDelivery, result: { ...reviewResult, subjectDigests: ['sha256:other'] } }),
    ContractError,
  );
});

test('an execution delivery cannot bind to a review invocation', () => {
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...baseBody,
      entries: [...baseBody.entries.slice(0, -1), { ...childDelivery, invocationId: 'invocation-review' }],
      childInvocations: [
        { invocationId: 'invocation-a', childTurnId: 'turn-child', checkpointReceiptRef: 'checkpoint-receipt-a', binding: { kind: 'execution', assignment } },
        { invocationId: 'invocation-review', childTurnId: 'turn-child-review', checkpointReceiptRef: 'checkpoint-receipt-review-pre', binding: { kind: 'review', assignment: reviewAssignment } },
      ],
    }),
    ContractError,
  );
});

test('a review delivery cannot bind to an execution invocation', () => {
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...reviewBody,
      entries: [...baseBody.entries, { ...reviewDelivery, invocationId: 'invocation-b' }],
    }),
    ContractError,
  );
});

test('a review delivery whose assignment identity differs from its invocation binding is rejected', () => {
  const foreignAssignment: ReviewAssignment = { ...reviewAssignment, assignmentId: 'assignment-a:review:security' };
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...reviewBody,
      childInvocations: reviewBody.childInvocations.map((invocation) => (
        invocation.invocationId === 'invocation-review'
          ? { ...invocation, binding: { kind: 'review', assignment: foreignAssignment } }
          : invocation
      )),
    }),
    ContractError,
  );
});

test('a post-review checkpoint is review-only and never the pre-call checkpoint', () => {
  // An execution invocation cannot carry a post-review checkpoint.
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...baseBody,
      childInvocations: baseBody.childInvocations.map((invocation) => (
        invocation.invocationId === 'invocation-a'
          ? { ...invocation, postReviewCheckpointRef: 'checkpoint-other' }
          : invocation
      )),
    }),
    ContractError,
  );
  // A review invocation cannot reuse the pre-call checkpoint as its result checkpoint.
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...reviewBody,
      childInvocations: reviewBody.childInvocations.map((invocation) => (
        invocation.invocationId === 'invocation-review'
          ? { ...invocation, postReviewCheckpointRef: invocation.checkpointReceiptRef }
          : invocation
      )),
    }),
    ContractError,
  );
});

test('a not-selected child invocation keeps the retained delivery and records the terminal decision', () => {
  const notSelected: ActiveTurnCaptureBody = {
    ...baseBody,
    childInvocations: baseBody.childInvocations.map((invocation) => (
      invocation.invocationId === 'invocation-b'
        ? {
            invocationId: 'invocation-b', childTurnId: 'turn-child-b', checkpointReceiptRef: 'checkpoint-receipt-b',
            binding: { kind: 'execution', assignment: childAssignment }, notSelectedResultSeq: 6,
          }
        : invocation
    )),
  };
  assert.doesNotThrow(() => validateActiveTurnCaptureBody(notSelected));
  const invocation = notSelected.childInvocations.find((candidate) => candidate.invocationId === 'invocation-b')!;
  assert.equal(invocation.adoptedResultSeq, undefined);
  assert.equal(invocation.notSelectedResultSeq, 6);
  // The retained delivery stays exact evidence after the terminal decision.
  const retained = notSelected.entries.find((entry) => entry.seq === 6) as AcceptedChildDelivery;
  assert.equal(retained.invocationId, 'invocation-b');
  assert.equal('envelope' in retained, false);
});

test('a child invocation cannot both adopt and not select the same delivery', () => {
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...baseBody,
      childInvocations: baseBody.childInvocations.map((invocation) => (
        invocation.invocationId === 'invocation-b'
          ? { ...invocation, notSelectedResultSeq: 6 }
          : invocation
      )),
    }),
    ContractError,
  );
});

test('a not-selected seq must reference a retained delivery of the same invocation and kind', () => {
  const notSelectedInvocation = (overrides: Record<string, unknown>) => ({
    invocationId: 'invocation-b', childTurnId: 'turn-child-b', checkpointReceiptRef: 'checkpoint-receipt-b',
    binding: { kind: 'execution', assignment: childAssignment }, ...overrides,
  });
  // Missing entry.
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...baseBody,
      childInvocations: [baseBody.childInvocations[0]!, notSelectedInvocation({ notSelectedResultSeq: 99 })],
    }),
    ContractError,
  );
  // A raw Provider envelope is not a refined child delivery.
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...baseBody,
      childInvocations: baseBody.childInvocations.map((invocation) => (
        invocation.invocationId === 'invocation-a'
          ? { ...invocation, notSelectedResultSeq: 1 }
          : invocation
      )),
    }),
    ContractError,
  );
  // The retained delivery belongs to another invocation.
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...baseBody,
      childInvocations: [
        baseBody.childInvocations[0]!,
        baseBody.childInvocations[1]!,
        { invocationId: 'invocation-c', childTurnId: 'turn-child-c', checkpointReceiptRef: 'checkpoint-receipt-c', binding: { kind: 'execution', assignment: childAssignment }, notSelectedResultSeq: 6 },
      ],
    }),
    ContractError,
  );
  // A review invocation cannot not-select an execution delivery.
  assert.throws(
    () => validateActiveTurnCaptureBody({
      ...reviewBody,
      childInvocations: reviewBody.childInvocations.map((invocation) => (
        invocation.invocationId === 'invocation-review'
          ? { ...invocation, notSelectedResultSeq: 6 }
          : invocation
      )),
    }),
    ContractError,
  );
});

test('a completed review keeps its post-review checkpoint without adoption and can be terminally not selected', () => {
  const reviewNotSelected: ActiveTurnCaptureBody = {
    ...reviewBody,
    childInvocations: reviewBody.childInvocations.map((invocation) => (
      invocation.invocationId === 'invocation-review'
        ? {
            invocationId: 'invocation-review', childTurnId: 'turn-child-review',
            checkpointReceiptRef: 'checkpoint-receipt-review-pre',
            binding: { kind: 'review', assignment: reviewAssignment },
            postReviewCheckpointRef: 'checkpoint-receipt-review-post', notSelectedResultSeq: 7,
          }
        : invocation
    )),
  };
  assert.doesNotThrow(() => validateActiveTurnCaptureBody(reviewNotSelected));
  const invocation = reviewNotSelected.childInvocations.find((candidate) => candidate.invocationId === 'invocation-review')!;
  assert.equal(invocation.adoptedResultSeq, undefined);
  assert.equal(invocation.notSelectedResultSeq, 7);
  assert.equal(invocation.postReviewCheckpointRef, 'checkpoint-receipt-review-post');
});
