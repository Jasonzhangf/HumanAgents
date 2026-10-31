import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type EvidenceRef, type ScopeRef } from '../../packages/contracts/src/index.js';
import { StandardTurnEndError } from '../../packages/app/src/ui-runtime/standard-turn-control.js';
import { matchStandardTurnDeliveryReferences } from '../../packages/app/src/ui-runtime/execution-composition.js';

const organId = id('organ', 'humanagent-ui');
const taskId = id('task', 'ui-task-implicit-draft-2');
const cycleId = id('cycle', 'ui-cycle-1');
const operationId = id('operation', 'ui-operation-implicit-draft-2');
const scope: ScopeRef = { organId, taskId, cycleId, operationId };

// The real tool-result-output evidence a file.list call wrote. The provider
// renders this on the evidence footer, and the model cites that exact token.
const rawOutputRef: EvidenceRef = {
  evidenceId: id('evidence',
    'provider-d6f3cbd8df9cbd04-tool-result-output-provider-tool-result-call_00_fUm3zYTmC1nZPPq1wZdV8573'),
  kind: 'tool',
  source: 'humanagent.provider-adapter',
  locator: '/artifacts/ui-provider-evidence/'
    + 'provider-d6f3cbd8df9cbd04-tool-result-output-provider-tool-result-call_00_fUm3zYTmC1nZPPq1wZdV8573',
  scope,
};

function match(deliveryRefs: readonly string[]): EvidenceRef[] {
  return matchStandardTurnDeliveryReferences({
    deliveryRefs,
    candidates: [rawOutputRef],
    producingTool: new Map([[rawOutputRef.evidenceId.value, { toolId: 'file.list', conflict: false }]]),
    carryingTool: new Map([[rawOutputRef.evidenceId.value, 'file.list']]),
    allocationScope: scope,
  });
}

test('standard-turn-end resolves the bare evidenceId the model cites', () => {
  assert.deepEqual(match([rawOutputRef.evidenceId.value]), [rawOutputRef]);
});

test('standard-turn-end resolves the footer-labelled evidenceId token the model copies', () => {
  // The evidence footer renders `- evidenceId=<value> kind=<kind> locator=<locator>`.
  // A model citing that exact first token must resolve to the same evidence; the
  // literal `evidenceId=` label is not a scope and must not block the match.
  assert.deepEqual(match([`evidenceId=${rawOutputRef.evidenceId.value}`]), [rawOutputRef]);
});

test('standard-turn-end still rejects a reference that resolves to no scoped evidence', () => {
  assert.throws(
    () => match(['evidenceId=provider-does-not-exist']),
    (error: unknown) => error instanceof StandardTurnEndError
      && error.code === 'standard-turn-end.delivery-unresolved',
  );
});
