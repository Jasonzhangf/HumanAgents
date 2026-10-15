import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_FLOW_DEFINITION_VERSION,
  TASK_FLOW_KINDS,
  ContractError,
  validateDraftRevision,
  validateRequirementEnvelope,
  validateTaskFlowBinding,
  type DraftRevision,
  type RequirementEnvelope,
  type TaskFlowBinding,
} from '@humanagent/contracts';

const triggerMode = 'once' as const;

function draft(overrides: Partial<DraftRevision> = {}): DraftRevision {
  return {
    draftId: 'draft-a',
    revisionVersion: 1,
    inputRevision: 1,
    goal: 'inspect a service',
    scope: 'service health',
    constraints: [],
    deliverables: [],
    normalizedInput: 'inspect a service',
    proposedIntent: 'create',
    proposal: 'Create a task',
    matchedTasks: [],
    knownFacts: [],
    decisionRefs: [],
    state: 'draft',
    history: [],
    revisionHash: 'sha256:placeholder',
    immutableOriginalRef: 'input-a',
    ...overrides,
  };
}

test('task flow kinds are a public identity separate from trigger policy', () => {
  assert.deepEqual(TASK_FLOW_KINDS, ['one-shot', 'inspection', 'long-running']);
  const inspection: TaskFlowBinding = { kind: 'inspection', definitionVersion: TASK_FLOW_DEFINITION_VERSION };
  validateTaskFlowBinding(inspection);
  assert.equal(triggerMode, 'once');
  assert.equal(inspection.kind, 'inspection');
});

test('task flow binding rejects unknown kind and unsupported definition version', () => {
  assert.throws(() => validateTaskFlowBinding({ kind: 'continuous', definitionVersion: 1 } as never), ContractError);
  assert.throws(() => validateTaskFlowBinding({ kind: 'one-shot', definitionVersion: 2 } as never), ContractError);
});

test('legacy draft without task flow remains undeclared while a typed binding is validated', () => {
  const legacy = draft();
  assert.doesNotThrow(() => validateDraftRevision(legacy));
  assert.equal(Object.hasOwn(legacy, 'taskFlow'), false);
  assert.doesNotThrow(() => validateDraftRevision(draft({
    taskFlow: { kind: 'one-shot', definitionVersion: 1 },
  })));
  assert.throws(() => validateDraftRevision(draft({ taskFlow: { kind: 'one-shot', definitionVersion: 3 } as never })), ContractError);
});

test('requirement envelope carries only a validated optional task flow binding', () => {
  const legacy: RequirementEnvelope = {
    requirementId: 'requirement-legacy', draftId: 'draft-legacy', inputRevision: 1, intent: 'create',
    normalizedInput: 'legacy task', confirmedBy: 'human', confirmedAt: '2026-10-11T00:00:00Z',
    fifoSeq: 1, payloadRef: 'asset://requirements/legacy',
  };
  assert.doesNotThrow(() => validateRequirementEnvelope(legacy));
  assert.equal(Object.hasOwn(legacy, 'taskFlow'), false);

  const typed: RequirementEnvelope = {
    ...legacy,
    requirementId: 'requirement-typed', draftId: 'draft-typed', fifoSeq: 2,
    taskFlow: { kind: 'inspection', definitionVersion: 1 },
  };
  assert.doesNotThrow(() => validateRequirementEnvelope(typed));
  assert.throws(() => validateRequirementEnvelope({ ...typed, taskFlow: { kind: 'other', definitionVersion: 1 } as never }), ContractError);
  assert.throws(() => validateRequirementEnvelope({ ...typed, taskFlow: { kind: 'inspection', definitionVersion: 2 } as never }), ContractError);
});
