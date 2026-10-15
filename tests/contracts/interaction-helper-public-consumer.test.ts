import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  assertProviderExecutionIdentityMatch,
  validateProviderSettlement,
  validateProviderStartInput,
  type EvidenceRef,
  type ProviderSettlement,
  type ProviderStartInput,
  type RawAsset,
  type ScopeRef,
  type AgentStartRequest,
  type TaskId,
  type TasklessProviderExecutionIdentityRef,
} from '../../packages/contracts/src/index.js';
import {
  matchesInteractionHelperAssignment,
  validateInteractionHelperAssignment,
  validateInteractionHelperHandoffFact,
  validateInteractionHelperIncarnation,
  validateInteractionHelperResult,
  validateInteractionLatestTurn,
  validateInteractionSemanticCheckpoint,
  type InteractionHelperAssignment,
  type InteractionHelperDispatchAcceptedFact,
  type InteractionHelperIncarnation,
  type InteractionHelperOwnerAcceptedFact,
  type InteractionHelperResult,
  type InteractionHelperReturnedFact,
  type InteractionHelperRunningFact,
  type InteractionLatestTurn,
  type InteractionSemanticCheckpoint,
} from '../../packages/contracts/src/interaction-helper.js';

const organId = id('organ', 'organ-a');
const scope: ScopeRef = { organId };

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'runtime-intake',
    locator: `interaction://${label}`,
    digest: `sha256:${'a'.repeat(64)}`,
    scope,
  };
}

function tasklessProviderEvidence(label: string, operationId = id('operation', 'operation-helper-a')): EvidenceRef {
  return {
    ...evidence(label),
    scope: { organId, operationId },
  };
}

function rawAsset(label: string): RawAsset {
  return {
    ref: evidence(label),
    view: { kind: 'utf8-text' },
  };
}

// A real Task in the same Organ is a legitimate evidence source for helper
// results, refined results, and committed semantic checkpoints. The helper
// identity itself stays taskless; only the referenced evidence is Task-scoped.
const taskScope: ScopeRef = { organId, taskId: id('task', 'task-a') };

function taskEvidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'runtime-intake',
    locator: `task://task-a/${label}`,
    digest: `sha256:${'a'.repeat(64)}`,
    scope: taskScope,
  };
}

function taskRawAsset(label: string): RawAsset {
  return {
    ref: taskEvidence(label),
    view: { kind: 'utf8-text' },
  };
}

const assignment: InteractionHelperAssignment = {
  organId,
  interactionScopeId: 'interaction-scope-a',
  interactionId: 'interaction-a',
  inputRevision: 3,
  parentTurnId: 'turn-a',
  assignmentId: 'assignment-a',
  helperCallId: 'call-a',
  attempt: 1,
  objective: 'Answer the bounded helper request',
  targetRefs: ['interaction://interaction-a'],
  expectedOutputRefs: ['output://helper-a'],
  expectedArtifactDigests: ['sha256:helper-a'],
  acceptanceCriteriaDigest: 'sha256:criteria-a',
  successCriteria: ['Return the bounded result'],
  failureCriteria: ['Return no result'],
  incompleteCriteria: ['Return a partial result'],
  requiredCapabilities: ['text-generation'],
  mergeGate: 'not-required',
};

const result: InteractionHelperResult = {
  organId,
  interactionScopeId: assignment.interactionScopeId,
  interactionId: assignment.interactionId,
  inputRevision: assignment.inputRevision,
  parentTurnId: assignment.parentTurnId,
  assignmentId: assignment.assignmentId,
  helperCallId: assignment.helperCallId,
  attempt: assignment.attempt,
  agentId: 'agent-helper-a',
  producedArtifactRefs: ['artifact://helper-a'],
  producedArtifactDigests: ['sha256:helper-a'],
  status: 'succeeded',
  summary: 'The bounded helper result',
  outputRefs: ['output://helper-a'],
  evidenceRefs: [evidence('helper-result'), taskEvidence('task-scoped-helper-result')],
  nextAction: 'settle',
};

type HasRequiredTaskId<T> = T extends { readonly taskId: TaskId } ? true : false;
const taskBoundIdentityHasTaskId: HasRequiredTaskId<AgentStartRequest> = true;
const tasklessIdentityHasTaskId: HasRequiredTaskId<
  AgentStartRequest<TasklessProviderExecutionIdentityRef>
> = false;

test('taskless interaction helper contract keeps exact identity and append-only facts', () => {
  validateInteractionHelperAssignment(assignment);
  validateInteractionHelperResult(result, assignment);
  assert.equal(matchesInteractionHelperAssignment(result, assignment), true);
  assert.equal('taskId' in assignment, false);
  assert.equal('taskId' in result, false);

  const wrongRevision = { ...result, inputRevision: assignment.inputRevision + 1 };
  const wrongCall = { ...result, helperCallId: 'call-b' };
  const wrongAttempt = { ...result, attempt: assignment.attempt + 1 };
  assert.equal(matchesInteractionHelperAssignment(wrongRevision, assignment), false);
  assert.equal(matchesInteractionHelperAssignment(wrongCall, assignment), false);
  assert.equal(matchesInteractionHelperAssignment(wrongAttempt, assignment), false);
  assert.throws(
    () => validateInteractionHelperResult(wrongRevision, assignment),
    ContractError,
  );
  assert.throws(
    () => validateInteractionHelperResult(wrongCall, assignment),
    ContractError,
  );
  assert.throws(
    () => validateInteractionHelperResult(wrongAttempt, assignment),
    ContractError,
  );

  const foreignEvidence: EvidenceRef = {
    ...evidence('foreign-helper-result'),
    scope: { organId: id('organ', 'organ-b') },
  };
  assert.throws(
    () => validateInteractionHelperResult({ ...result, evidenceRefs: [foreignEvidence] }, assignment),
    ContractError,
  );

  const checkpoint: InteractionSemanticCheckpoint = {
    kind: 'semantic-checkpoint',
    organId,
    interactionScopeId: assignment.interactionScopeId,
    interactionId: assignment.interactionId,
    inputRevision: assignment.inputRevision - 1,
    turnId: 'turn-prior',
    committedAt: '2026-10-15T00:00:00.000Z',
    claims: [{ fact: 'The prior answer was accepted', certainty: 'confirmed', sourceRefs: ['evidence://prior'] }],
    constraints: [],
    evidenceRefs: [evidence('semantic-checkpoint'), taskEvidence('task-scoped-semantic-checkpoint')],
    semanticAssetRefs: [evidence('semantic-checkpoint-asset')],
  };
  validateInteractionSemanticCheckpoint(checkpoint);

  const latestTurn: InteractionLatestTurn = {
    organId,
    interactionScopeId: assignment.interactionScopeId,
    interactionId: assignment.interactionId,
    inputRevision: assignment.inputRevision,
    turnId: assignment.parentTurnId,
    entries: [
      { kind: 'user-input', content: rawAsset('user-input') },
      { kind: 'clarification', question: rawAsset('clarification-question'), answer: rawAsset('clarification-answer') },
      { kind: 'assistant-output', content: rawAsset('assistant-output') },
      { kind: 'helper-result', result, refinedResult: taskRawAsset('task-scoped-refined-helper-result') },
    ],
  };
  validateInteractionLatestTurn(latestTurn);

  const dispatchAccepted: InteractionHelperDispatchAcceptedFact = {
    kind: 'dispatch-accepted',
    assignment,
    dispatchAcceptedAt: '2026-10-15T00:00:01.000Z',
    evidenceRefs: [evidence('dispatch-accepted')],
  };
  const running: InteractionHelperRunningFact = {
    kind: 'running',
    identity: assignment,
    startedAt: '2026-10-15T00:00:02.000Z',
    evidenceRefs: [evidence('running')],
  };
  const returned: InteractionHelperReturnedFact = {
    kind: 'returned',
    result,
    returnedAt: '2026-10-15T00:00:03.000Z',
    evidenceRefs: [evidence('returned')],
  };
  const ownerAccepted: InteractionHelperOwnerAcceptedFact = {
    kind: 'owner-accepted',
    result,
    acceptedBy: 'runtime-intake-owner',
    acceptanceRef: 'acceptance://helper-a',
    acceptedAt: '2026-10-15T00:00:04.000Z',
    evidenceRefs: [evidence('owner-accepted')],
  };

  assert.equal(returned.kind, 'returned');
  assert.equal(ownerAccepted.kind, 'owner-accepted');
  validateInteractionHelperHandoffFact(dispatchAccepted);
  validateInteractionHelperHandoffFact(running);
  validateInteractionHelperHandoffFact(returned);
  validateInteractionHelperHandoffFact(ownerAccepted);
});

test('taskless provider execution reuses the existing provider contracts without leaking Task identity', () => {
  const operationId = id('operation', 'operation-helper-a');
  const executionEpoch = 1;
  const tasklessIdentity: TasklessProviderExecutionIdentityRef = {
    runtimeId: 'runtime-helper-a',
    organId,
    operationId,
    executionEpoch,
    helper: assignment,
  };

  const startInput: ProviderStartInput<TasklessProviderExecutionIdentityRef> = {
    ...tasklessIdentity,
    inputRefs: ['interaction://interaction-a/helper-call-a'],
    evidenceRefs: [tasklessProviderEvidence('taskless-provider-start', operationId)],
  };
  validateProviderStartInput(startInput);

  const settlement: ProviderSettlement<TasklessProviderExecutionIdentityRef> = {
    ...tasklessIdentity,
    state: 'succeeded',
    evidenceRefs: [tasklessProviderEvidence('taskless-provider-settlement', operationId)],
    resourceRelease: {
      state: 'released',
      evidenceRefs: [tasklessProviderEvidence('taskless-provider-resource-release', operationId)],
    },
    persistence: {
      state: 'committed',
      evidenceRefs: [tasklessProviderEvidence('taskless-provider-persistence', operationId)],
    },
  };
  validateProviderSettlement(settlement);

  assertProviderExecutionIdentityMatch(tasklessIdentity, settlement);
  assert.throws(
    () => assertProviderExecutionIdentityMatch(tasklessIdentity, {
      ...tasklessIdentity,
      helper: { ...assignment, helperCallId: 'call-b' },
    }),
    ContractError,
  );

  const mismatchedOrganIdentity: TasklessProviderExecutionIdentityRef = {
    ...tasklessIdentity,
    helper: { ...assignment, organId: id('organ', 'organ-b') },
  };
  assert.throws(
    () => validateProviderStartInput({
      ...startInput,
      ...mismatchedOrganIdentity,
    }),
    ContractError,
  );

  const leakedTaskIdentity: TasklessProviderExecutionIdentityRef = { ...tasklessIdentity };
  Object.assign(leakedTaskIdentity, { taskId: id('task', 'task-leak') });
  assert.throws(
    () => validateProviderStartInput({
      ...startInput,
      ...leakedTaskIdentity,
    }),
    ContractError,
  );

  const leakedCycleIdentity: TasklessProviderExecutionIdentityRef = { ...tasklessIdentity };
  Object.assign(leakedCycleIdentity, { cycleId: id('cycle', 'cycle-leak') });
  assert.throws(
    () => validateProviderStartInput({
      ...startInput,
      ...leakedCycleIdentity,
    }),
    ContractError,
  );
});

test('helper incarnation binds dispatch facts to the real provider and execution identity', () => {
  const incarnation: InteractionHelperIncarnation = {
    ...assignment,
    runtimeId: 'runtime-helper-a',
    operationId: id('operation', 'operation-helper-a'),
    executionEpoch: 1,
    bindingId: 'binding-helper-a',
    providerId: 'provider-helper-a',
    protocol: 'responses',
    modelRef: 'model-helper-a',
    capabilityDigest: 'sha256:helper-capabilities',
  };
  validateInteractionHelperIncarnation(incarnation, assignment);

  const dispatchAccepted: InteractionHelperDispatchAcceptedFact = {
    kind: 'dispatch-accepted',
    assignment,
    incarnation,
    dispatchAcceptedAt: '2026-10-15T00:00:01.000Z',
    evidenceRefs: [evidence('dispatch-accepted-incarnation')],
  };
  validateInteractionHelperHandoffFact(dispatchAccepted);

  assert.throws(
    () => validateInteractionHelperIncarnation({ ...incarnation, helperCallId: 'call-b' }, assignment),
    ContractError,
  );
  assert.throws(
    () => validateInteractionHelperIncarnation({ ...incarnation, modelRef: '   ' }, assignment),
    ContractError,
  );
  assert.throws(
    () => validateInteractionHelperHandoffFact({
      ...dispatchAccepted,
      incarnation: { ...incarnation, bindingId: '' },
    }),
    ContractError,
  );
});
