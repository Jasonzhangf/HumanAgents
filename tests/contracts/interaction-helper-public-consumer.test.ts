import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  type EvidenceRef,
  type RawAsset,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
import {
  matchesInteractionHelperAssignment,
  validateInteractionHelperAssignment,
  validateInteractionHelperHandoffFact,
  validateInteractionHelperResult,
  validateInteractionLatestTurn,
  validateInteractionSemanticCheckpoint,
  type InteractionHelperAssignment,
  type InteractionHelperDispatchAcceptedFact,
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
