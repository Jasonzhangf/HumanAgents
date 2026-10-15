import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  type EvidenceRef,
  type RawAsset,
  type ScopeRef,
} from '../../../packages/contracts/src/index.js';
import type {
  InteractionLatestTurn,
  InteractionSemanticCheckpoint,
  InteractionTurnIdentity,
} from '../../../packages/contracts/src/interaction-helper.js';
import {
  buildInteractionSemanticContext,
  InteractionSemanticContextError,
  type InteractionCurrentClarification,
  type InteractionSemanticContextInput,
} from '../../../packages/runtime/src/context/interaction-semantic-context.js';

const organId = id('organ', 'interaction-organ-a');
const scope: ScopeRef = { organId };
// A real Task in the same Organ is a legitimate evidence source. The helper
// identity itself stays taskless; only the referenced evidence is Task-scoped.
const taskScope: ScopeRef = { organId, taskId: id('task', 'task-a') };

function evidence(label: string, refScope: ScopeRef = scope): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'runtime-intake',
    locator: `interaction://${label}`,
    digest: `sha256:${'a'.repeat(64)}`,
    scope: refScope,
  };
}

function rawAsset(label: string, refScope: ScopeRef = scope): RawAsset {
  return { ref: evidence(label, refScope), view: { kind: 'utf8-text' } };
}

const identity: InteractionTurnIdentity = {
  organId,
  interactionScopeId: 'interaction-scope-a',
  interactionId: 'interaction-a',
  inputRevision: 4,
  turnId: 'turn-current',
};

const HISTORICAL_RAW_SENTINEL = 'HISTORICAL-RAW-SENTINEL-MUST-NOT-LEAK';

// The checkpoint carries an extra raw field that is NOT part of the contract.
// Projection is by field, so this raw sentinel must not reach the result.
const priorGoalSourceRefs = ['evidence://prior-goal'];
const checkpoint = {
  kind: 'semantic-checkpoint',
  organId,
  interactionScopeId: identity.interactionScopeId,
  interactionId: identity.interactionId,
  inputRevision: 1,
  turnId: 'turn-prior',
  committedAt: '2026-10-15T00:00:00.000Z',
  claims: [
    { fact: 'The prior goal was to answer the bounded question', certainty: 'confirmed', sourceRefs: priorGoalSourceRefs },
    { fact: 'An open condition from the prior turn is still unknown', certainty: 'unknown', sourceRefs: ['evidence://prior-condition'] },
  ],
  constraints: [
    { fact: 'Keep the correction recorded in the prior turn', certainty: 'corrected', sourceRefs: ['evidence://prior-correction'] },
  ],
  evidenceRefs: [evidence('history-semantic-evidence'), evidence('history-task-evidence', taskScope)],
  semanticAssetRefs: [evidence('history-semantic-asset')],
  rawHistory: HISTORICAL_RAW_SENTINEL,
} as InteractionSemanticCheckpoint & { readonly rawHistory: string };

const helperResult = {
  organId,
  interactionScopeId: identity.interactionScopeId,
  interactionId: identity.interactionId,
  inputRevision: identity.inputRevision,
  parentTurnId: identity.turnId,
  assignmentId: 'assignment-a',
  helperCallId: 'call-a',
  attempt: 1,
  agentId: 'agent-helper-a',
  producedArtifactRefs: ['artifact://helper-a'],
  producedArtifactDigests: ['sha256:helper-a'],
  status: 'succeeded' as const,
  summary: 'The bounded helper result',
  outputRefs: ['output://helper-a'],
  evidenceRefs: [evidence('helper-result-evidence')],
  nextAction: 'settle' as const,
};

const latestUserInput = rawAsset('latest-user-input');
const latestQuestion = rawAsset('latest-clarification-question');
const latestAnswer = rawAsset('latest-clarification-answer');
const latestAssistantOutput = rawAsset('latest-assistant-output');
const latestRefinedResult = rawAsset('latest-refined-result', taskScope);

const latestTurn: InteractionLatestTurn = {
  organId,
  interactionScopeId: identity.interactionScopeId,
  interactionId: identity.interactionId,
  inputRevision: identity.inputRevision,
  turnId: identity.turnId,
  entries: [
    { kind: 'user-input', content: latestUserInput },
    { kind: 'clarification', question: latestQuestion, answer: latestAnswer },
    { kind: 'assistant-output', content: latestAssistantOutput },
    { kind: 'helper-result', result: helperResult, refinedResult: latestRefinedResult },
  ],
};

const currentInput = rawAsset('current-input');
const currentQuestion = rawAsset('current-clarification-question');
const currentAnswer = rawAsset('current-clarification-answer');
const clarifications: readonly InteractionCurrentClarification[] = [
  { question: currentQuestion, answer: currentAnswer },
];

function makeInput(): InteractionSemanticContextInput {
  return {
    identity,
    semanticHistory: [checkpoint],
    latestTurn,
    currentInput,
    clarifications,
  };
}

test('buildInteractionSemanticContext assembles committed history and the full latest turn', () => {
  const input = makeInput();
  const result = buildInteractionSemanticContext(input);

  assert.equal(result.kind, 'interaction-semantic-context');
  assert.deepEqual(result.identity, identity);

  // Historical raw is excluded by projection; historical semantic facts are present.
  assert.equal(JSON.stringify(result).includes(HISTORICAL_RAW_SENTINEL), false);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].kind, 'semantic-checkpoint');
  assert.equal(result.history[0].turnId, 'turn-prior');
  assert.equal(result.history[0].committedAt, '2026-10-15T00:00:00.000Z');
  assert.deepEqual(result.history[0].claims.map((claim) => claim.fact), [
    'The prior goal was to answer the bounded question',
    'An open condition from the prior turn is still unknown',
  ]);
  // Unknowns/conditions/corrections are not normalized away.
  assert.deepEqual(result.history[0].claims.map((claim) => claim.certainty), ['confirmed', 'unknown']);
  assert.deepEqual(result.history[0].constraints.map((claim) => claim.certainty), ['corrected']);
  assert.deepEqual(result.history[0].claims[0].sourceRefs, ['evidence://prior-goal']);
  // Same-Organ Task-scoped evidence is legitimate and is preserved.
  assert.equal(result.history[0].evidenceRefs.length, 2);
  assert.equal(result.history[0].evidenceRefs[1].scope.taskId?.value, 'task-a');
  assert.equal(result.history[0].semanticAssetRefs.length, 1);

  // The latest turn is complete and ordered; user/assistant/clarification/refined result.
  assert.deepEqual(result.latestTurn.map((entry) => entry.kind), [
    'user-input',
    'clarification',
    'assistant-output',
    'helper-result',
  ]);
  assert.deepEqual(result.latestTurn, latestTurn.entries);
  assert.deepEqual(result.currentInput, currentInput);
  assert.deepEqual(result.clarifications, clarifications);

  // Scope mismatch fails explicitly, and no fake Task wrapper is involved.
  assert.equal('taskId' in result.identity, false);
  assert.throws(
    () => buildInteractionSemanticContext({
      ...makeInput(),
      semanticHistory: [{ ...checkpoint, interactionScopeId: 'other-scope' }],
    }),
    InteractionSemanticContextError,
  );
  const foreignOrganId = id('organ', 'foreign-organ');
  assert.throws(
    () => buildInteractionSemanticContext({
      ...makeInput(),
      semanticHistory: [{
        ...checkpoint,
        organId: foreignOrganId,
        evidenceRefs: [evidence('foreign-checkpoint-evidence', { organId: foreignOrganId })],
        semanticAssetRefs: [evidence('foreign-checkpoint-asset', { organId: foreignOrganId })],
      }],
    }),
    InteractionSemanticContextError,
  );
  assert.throws(
    () => buildInteractionSemanticContext({
      ...makeInput(),
      latestTurn: {
        ...latestTurn,
        interactionScopeId: 'other-scope',
        entries: [
          latestTurn.entries[0],
          latestTurn.entries[1],
          latestTurn.entries[2],
          {
            kind: 'helper-result',
            result: { ...helperResult, interactionScopeId: 'other-scope' },
            refinedResult: latestRefinedResult,
          },
        ],
      },
    }),
    InteractionSemanticContextError,
  );
  assert.throws(
    () => buildInteractionSemanticContext({
      ...makeInput(),
      latestTurn: {
        ...latestTurn,
        inputRevision: identity.inputRevision - 1,
        turnId: 'turn-old',
        entries: [latestTurn.entries[0]],
      },
    }),
    InteractionSemanticContextError,
  );
  // A foreign-Organ ref is rejected by the reused T1 raw-asset validator.
  assert.throws(
    () => buildInteractionSemanticContext({
      ...makeInput(),
      currentInput: rawAsset('foreign-organ-input', { organId: foreignOrganId }),
    }),
    ContractError,
  );

  // The output does not share writable current context with the caller.
  const before = JSON.stringify(result);
  (latestUserInput.ref as { locator: string }).locator = 'mutated-latest-user-input';
  (currentInput.ref as { locator: string }).locator = 'mutated-current-input';
  (priorGoalSourceRefs as string[]).push('mutated-source-ref');
  assert.equal((latestUserInput.ref as { locator: string }).locator, 'mutated-latest-user-input');
  assert.equal(priorGoalSourceRefs.length, 2);
  assert.equal(JSON.stringify(result), before);
});
