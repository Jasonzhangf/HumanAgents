import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  validateTurnCloseSummary,
  validateTurnClosureReference,
  validateStandardTurnEndCommand,
  validateStandardTurnEndInput,
  type AdmittedTurnIdentity,
  type EvidenceRef,
  type JournalCommitRef,
  type ScopeRef,
  type StandardTurnEndCommand,
  type TurnCloseSummary,
  type TurnSummaryEvidenceContext,
} from '@humanagent/contracts';

const organId = id('organ', 'organ-a');
const taskId = id('task', 'task-a');
const cycleId = id('cycle', 'cycle-a');
const parentScope: ScopeRef = { organId, taskId, cycleId, operationId: id('operation', 'ui-operation-2') };
const childScope: ScopeRef = {
  organId,
  taskId,
  cycleId,
  operationId: id('operation', 'provider-tool-ui-operation-2-call-native-write'),
};

/** The real child file-write evidence, kept at the child's own scope. */
const childEvidence: EvidenceRef = {
  evidenceId: id('evidence', 'child-file-write'),
  kind: 'tool',
  source: 'native-process',
  locator: 'file://native-process-result.txt',
  scope: childScope,
};

const parentEvidence: EvidenceRef = {
  evidenceId: id('evidence', 'parent-admission'),
  kind: 'operation',
  source: 'native-process',
  locator: 'turn://turn-2',
  scope: parentScope,
};

const identity: AdmittedTurnIdentity = {
  turnId: 'turn-2',
  workAssignmentRef: 'assignment-2',
  taskRef: taskId,
  scopeRef: parentScope,
  cycleRef: cycleId,
  inputRevision: 1,
  directiveRevision: 1,
  executionEpoch: 1,
  runtimeBindingRef: 'binding-2',
  permissionRevision: 'permission-r1',
};

const registrationCommit: JournalCommitRef = {
  commitId: 'commit-child-registration',
  journalSeq: 7,
  recordDigest: 'sha256:child-registration',
};

const context: TurnSummaryEvidenceContext = {
  identity,
  children: [{
    evidenceRef: childEvidence,
    businessRegistrationCommitRef: registrationCommit,
    providerRequestId: 'request-2',
    toolCallId: 'call-native-write',
  }],
};

function summaryWith(ref: EvidenceRef): TurnCloseSummary {
  const section = (text: string) => ({ text, evidenceRefs: [ref] });
  return {
    goal: section('Run the native CLI task'),
    actions: section('Wrote the native process result'),
    result: section('Physical file readback is available'),
    expectedNextStep: section('Close this turn'),
  };
}

function summaryWithInspectionOutcome(inspectionOutcome: unknown): TurnCloseSummary {
  return { ...summaryWith(parentEvidence), inspectionOutcome } as TurnCloseSummary;
}

function commandWith(ref: EvidenceRef): StandardTurnEndCommand {
  return {
    kind: 'standard-turn-end',
    identity,
    summary: summaryWith(ref),
    deliveryRefs: [ref.locator],
    resolvedEvidenceRefs: [ref],
  };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

// r16 confirmed this failure: direct text was rejected before its delivery asset
// could exist. One small public-consumer case guards the summary cardinality.
test('four semantic sections may have empty evidence arrays with a direct text delivery', () => {
  const section = (text: string) => ({ text, evidenceRefs: [] });
  assert.doesNotThrow(() => validateStandardTurnEndInput({
    summary: {
      goal: section('Complete reasoning from the current input'),
      actions: section('Formed an answer without external tools'),
      result: section('Submit the independent delivery text'),
      expectedNextStep: section('Let Planner align after standard closure'),
    },
    deliveryText: 'The independent delivery text.',
    deliveryRefs: [],
  }, parentScope));
});

test('inspection outcome stays optional and uses the existing outcome contract', () => {
  assert.doesNotThrow(() => validateTurnCloseSummary(summaryWith(parentEvidence), parentScope));
  assert.throws(
    () => validateTurnCloseSummary(summaryWithInspectionOutcome({ status: 'completed' }), parentScope),
    ContractError,
  );
  assert.throws(
    () => validateTurnCloseSummary(summaryWithInspectionOutcome({ status: 'unknown' }), parentScope),
    ContractError,
  );
});

test('without context the exact parent scope is still required', () => {
  assert.doesNotThrow(() => validateTurnCloseSummary(summaryWith(parentEvidence), parentScope));
  const error = captureError(() => validateTurnCloseSummary(summaryWith(childEvidence), parentScope));
  assert.equal(error instanceof ContractError, true);
  assert.match((error as Error).message, /^turn summary goal evidence: scope mismatch$/);
  assert.throws(() => validateStandardTurnEndCommand(commandWith(childEvidence)), ContractError);
});

test('a trusted context lets the parent turn cite its real child evidence at the child scope', () => {
  assert.doesNotThrow(() => validateTurnCloseSummary(summaryWith(childEvidence), parentScope, context));
  assert.doesNotThrow(() => validateTurnCloseSummary(summaryWith(parentEvidence), parentScope, context));
  assert.doesNotThrow(() => validateStandardTurnEndInput(
    { summary: summaryWith(childEvidence), deliveryRefs: [childEvidence.locator] },
    parentScope,
    context,
  ));
  assert.doesNotThrow(() => validateStandardTurnEndCommand(commandWith(childEvidence), context));
});

test('a changed child reference is not the real child evidence', () => {
  const changed = { ...childEvidence, locator: 'file://some-other-file.txt' };
  assert.throws(() => validateTurnCloseSummary(summaryWith(changed), parentScope, context), ContractError);
  // A malformed scope is a format failure, not a scope mismatch: the child allowlist must not swallow it.
  const malformed = {
    ...childEvidence,
    scope: { ...childScope, taskId: { scope: 'operation', value: taskId.value } },
  } as unknown as EvidenceRef;
  assert.throws(() => validateTurnCloseSummary(summaryWith(malformed), parentScope, context), ContractError);
  assert.throws(
    () => validateStandardTurnEndCommand({ ...commandWith(childEvidence), resolvedEvidenceRefs: [malformed] }, context),
    ContractError,
  );
});

test('an unrelated operation in the same task is not an allowlisted child', () => {
  const unrelated: EvidenceRef = { ...childEvidence, scope: { ...childScope, operationId: id('operation', 'ui-operation-9') } };
  assert.throws(() => validateTurnCloseSummary(summaryWith(unrelated), parentScope, context), ContractError);
  assert.throws(() => validateStandardTurnEndCommand(commandWith(unrelated), context), ContractError);
});

test('a foreign task child is rejected by the context itself', () => {
  const foreignScope: ScopeRef = { ...childScope, taskId: id('task', 'task-b') };
  const foreignContext: TurnSummaryEvidenceContext = {
    identity,
    children: [{ ...context.children[0]!, evidenceRef: { ...childEvidence, scope: foreignScope } }],
  };
  const error = captureError(
    () => validateTurnCloseSummary(summaryWith({ ...childEvidence, scope: foreignScope }), parentScope, foreignContext),
  );
  assert.equal(error instanceof ContractError, true);
  assert.match((error as Error).message, /turn summary evidence context child must be an operation under the parent turn/);
});

test('a context for another parent turn is rejected', () => {
  const otherIdentity: AdmittedTurnIdentity = { ...identity, scopeRef: { ...parentScope, operationId: id('operation', 'ui-operation-9') } };
  const wrongParentContext: TurnSummaryEvidenceContext = { identity: otherIdentity, children: context.children };
  assert.throws(() => validateTurnCloseSummary(summaryWith(childEvidence), parentScope, wrongParentContext), ContractError);
  assert.throws(() => validateStandardTurnEndCommand(commandWith(childEvidence), wrongParentContext), ContractError);
  assert.throws(
    () => validateTurnClosureReference({
      identity,
      checkpointId: id('checkpoint', 'checkpoint-2'),
      closureRef: 'turn-closure:2',
      summary: summaryWith(childEvidence),
      recoveryStateRef: parentEvidence,
      closedAt: '2026-10-14T00:00:00.000Z',
    }, wrongParentContext),
    ContractError,
  );
});

test('closure reference accepts the child with context but keeps recovery state exact', () => {
  const close = {
    identity,
    checkpointId: id('checkpoint', 'checkpoint-2'),
    closureRef: 'turn-closure:2',
    summary: summaryWith(childEvidence),
    recoveryStateRef: parentEvidence,
    closedAt: '2026-10-14T00:00:00.000Z',
  };
  assert.doesNotThrow(() => validateTurnClosureReference(close, context));
  assert.throws(() => validateTurnClosureReference({ ...close, recoveryStateRef: childEvidence }, context), ContractError);
  assert.throws(() => validateTurnClosureReference(close), ContractError);
});
