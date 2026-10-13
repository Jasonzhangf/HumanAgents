import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type ActiveTurnBinding,
  type AdmittedTurnIdentity,
  type ChildCallBinding,
  type ChildInvocationRecord,
  type EvidenceRef,
  type RawAsset,
  type ScopeRef,
  type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import {
  activeTurnCommitId,
  type ActiveTurnJournalRecord,
} from '../../../packages/runtime/src/context/active-turn-journal.js';
import {
  materializeAdoptedChildSource,
  SemanticHistoryAdoptionError,
  type AdoptedChildSourceV1,
} from '../../../packages/runtime/src/context/semantic-history-adoption.js';

const organId = id('organ', 'adoption-test-organ');
const taskId = id('task', 'adoption-test-task');
const cycleId = id('cycle', 'adoption-test-cycle');
const operationId = id('operation', 'adoption-test-operation');
const parentScope: ScopeRef = { organId, taskId, cycleId };
const assetScope: ScopeRef = { ...parentScope, operationId };
const childScope: ScopeRef = { organId, taskId, cycleId, operationId: id('operation', 'adoption-child-operation') };
const parentTurn: AdmittedTurnIdentity = {
  turnId: 'parent-turn-1',
  workAssignmentRef: 'assignment-parent-1',
  taskRef: taskId,
  scopeRef: parentScope,
  cycleRef: cycleId,
  inputRevision: 1,
  directiveRevision: 1,
  executionEpoch: 1,
  runtimeBindingRef: 'runtime-binding-1',
  permissionRevision: 'permission-revision-1',
};

function evidence(label: string, scope: ScopeRef): EvidenceRef {
  return {
    evidenceId: id('evidence', `adoption-${label}`),
    kind: 'operation',
    source: 'adoption-test',
    locator: `test://${label}`,
    scope,
  };
}

const parentAssignment: WorkAssignment = {
  assignmentId: parentTurn.workAssignmentRef,
  taskId,
  pipelineNodeId: 'node-parent',
  attempt: 1,
  executionEpoch: parentTurn.executionEpoch,
  inputRevision: parentTurn.inputRevision,
  objective: 'materialize the adopted child source',
  targetRefs: [],
  expectedOutputRefs: [],
  acceptanceCriteriaDigest: 'sha256:acceptance',
  successCriteria: ['replay is exact'],
  failureCriteria: [],
  incompleteCriteria: [],
  requiredCapabilities: [],
  mergeGate: 'not-required',
};

const binding: ActiveTurnBinding = {
  admittedTurn: {
    ...parentTurn,
    admissionEvidenceRefs: [],
    currentTurnRef: 'current-turn-1',
    recoveryStateRef: 'recovery-1',
  },
  assignment: parentAssignment,
  execution: { runtimeId: 'runtime-1', executionEpoch: parentTurn.executionEpoch },
  scope: parentScope,
};

const deliveryBytes = new TextEncoder().encode('{"summary":"exact adopted child refinement"}');
const digest = `sha256:${'a'.repeat(64)}`;
const refinedDelivery: RawAsset = {
  ref: {
    ...evidence('refined-delivery', assetScope),
    digest,
  },
  view: { kind: 'utf8-text' },
};
const childRaw: RawAsset = {
  ref: evidence('child-raw', childScope),
  view: { kind: 'utf8-text' },
};
const invocationId = 'invocation-1';
const childTurnId = 'child-turn-1';
const preCallCheckpointRef = 'checkpoint-pre-call-1';

function baseFixture() {
  const childAssignment: WorkAssignment = {
    ...parentAssignment,
    assignmentId: 'assignment-child-1',
    pipelineNodeId: 'node-child',
  };
  const childBinding: ChildCallBinding = {
    kind: 'execution',
    assignment: childAssignment,
  };
  const unadopted: ChildInvocationRecord = {
    invocationId,
    childTurnId,
    checkpointReceiptRef: preCallCheckpointRef,
    binding: childBinding,
  };
  const adopted: ChildInvocationRecord = { ...unadopted, adoptedResultSeq: 3 };
  const records: ActiveTurnJournalRecord[] = [
    { kind: 'binding-opened', binding, currentTurnRef: 'current-turn-1' },
    { kind: 'child-invocation', record: unadopted },
    {
      kind: 'child-delivery',
      entry: {
        kind: 'execution',
        seq: 3,
        invocationId,
        refinedDelivery,
        assignment: childAssignment,
        result: {
          taskId,
          pipelineNodeId: 'node-child',
          agentId: 'child-agent',
          assignmentId: 'assignment-child-1',
          attempt: 1,
          executionEpoch: parentTurn.executionEpoch,
          inputRevision: parentTurn.inputRevision,
          producedArtifactRefs: [],
          producedArtifactDigests: [],
          status: 'succeeded',
          summary: 'child refinement',
          outputRefs: ['asset://child-refinement'],
          evidenceRefs: [evidence('child-result', childScope)],
          nextAction: 'continue',
        },
      },
    },
    { kind: 'child-invocation', record: adopted },
  ];
  const source: AdoptedChildSourceV1 = {
    parentTurn,
    invocationId,
    childTurnId,
    deliverySeq: 3,
    adoptionCommitId: activeTurnCommitId(parentTurn.turnId, `adopted:${invocationId}`),
    deliveryCommitId: activeTurnCommitId(parentTurn.turnId, `delivery:${invocationId}`),
    kind: 'execution',
    refinedDelivery,
    preCallCheckpointRef,
  };
  return { records, source };
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof SemanticHistoryAdoptionError);
  assert.equal(captured.code, code);
}

test('materializeAdoptedChildSource returns the exact adopted refinement bytes', async () => {
  const { records, source } = baseFixture();
  const reads: Array<{ readonly scope: ScopeRef; readonly content: RawAsset }> = [];
  const result = await materializeAdoptedChildSource({
    source,
    records,
    rawContent: {
      async read(input) {
        reads.push(input);
        if (input.content === childRaw) throw new Error('child raw asset must not be read');
        return deliveryBytes;
      },
    },
  });

  assert.deepEqual(result.bytes, deliveryBytes);
  assert.equal(result.source, source);
  assert.equal(result.delivery.refinedDelivery.ref.digest, digest);
  assert.equal(result.invocation.adoptedResultSeq, source.deliverySeq);
  assert.deepEqual(reads, [{ scope: assetScope, content: refinedDelivery }]);
});

test('materializeAdoptedChildSource rejects missing parent binding', async () => {
  const { records, source } = baseFixture();
  await expectCode(
    () => materializeAdoptedChildSource({
      source,
      records: records.filter((record) => record.kind !== 'binding-opened'),
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.parent-turn.missing',
  );
});

test('materializeAdoptedChildSource rejects a projected parent identity mismatch', async () => {
  const { records, source } = baseFixture();
  await expectCode(
    () => materializeAdoptedChildSource({
      source: { ...source, parentTurn: { ...parentTurn, permissionRevision: 'permission-revision-2' } },
      records,
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.parent-turn.mismatch',
  );
});

test('materializeAdoptedChildSource rejects non-active-turn commit identities', async () => {
  const { records, source } = baseFixture();
  await expectCode(
    () => materializeAdoptedChildSource({
      source: { ...source, adoptionCommitId: 'active-turn:wrong:adopted' },
      records,
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.commit-identity.mismatch',
  );
});

test('materializeAdoptedChildSource rejects an unadopted invocation', async () => {
  const { records, source } = baseFixture();
  const unadoptedOnly = records.filter((record) => !(
    record.kind === 'child-invocation' && record.record.adoptedResultSeq !== undefined
  ));
  await expectCode(
    () => materializeAdoptedChildSource({
      source,
      records: unadoptedOnly,
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.invocation.unadopted',
  );
});

test('materializeAdoptedChildSource rejects invocation and delivery replay mismatches', async () => {
  const { records, source } = baseFixture();
  await expectCode(
    () => materializeAdoptedChildSource({
      source: { ...source, childTurnId: 'child-turn-2' },
      records,
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.invocation.mismatch',
  );
  await expectCode(
    () => materializeAdoptedChildSource({
      source,
      records: records.filter((record) => record.kind !== 'child-delivery'),
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.delivery.missing',
  );
  await expectCode(
    () => materializeAdoptedChildSource({
      source: {
        ...source,
        refinedDelivery: {
          ...refinedDelivery,
          ref: { ...refinedDelivery.ref, digest: `sha256:${'0'.repeat(64)}` },
        },
      },
      records,
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.delivery.mismatch',
  );
});

test('materializeAdoptedChildSource rejects review checkpoint replay mismatches', async () => {
  const { records, source } = baseFixture();
  await expectCode(
    () => materializeAdoptedChildSource({
      source: { ...source, postReviewCheckpointRef: 'checkpoint-review-2' },
      records,
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.invocation.mismatch',
  );
});

test('materializeAdoptedChildSource rejects invalid source shape', async () => {
  const { records } = baseFixture();
  await expectCode(
    () => materializeAdoptedChildSource({
      source: { ...baseFixture().source, invocationId: '' },
      records,
      rawContent: { async read() { return deliveryBytes; } },
    }),
    'semantic-history-adoption.source.invalid',
  );
});
