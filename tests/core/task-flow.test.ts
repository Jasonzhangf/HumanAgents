import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DraftRevisionError,
  assertDraftRevisionCurrent,
  createDraftRevision,
  draftRevisionDiff,
  refineDraftRevision,
  resolveTaskFlowGuidance,
  resolveTaskFlowGuidanceFromBinding,
} from '../../packages/core/src/index.js';
import {
  TaskFlowIdentityConflictError,
  assertTaskFlowBindingCompatible,
} from '../../packages/core/src/task-flow.js';
import {
  id,
  type DraftRevisionInput,
  type TaskFlowBinding,
  type TaskFlowGuidance,
  type TaskFlowKind,
} from '../../packages/contracts/src/index.js';

const taskId = id('task', 'task-a');
const oneShot: TaskFlowBinding = { kind: 'one-shot', definitionVersion: 1 };
const inspection: TaskFlowBinding = { kind: 'inspection', definitionVersion: 1 };

function guidanceFor(kind: TaskFlowKind): TaskFlowGuidance {
  return resolveTaskFlowGuidance({ kind, definitionVersion: 1 });
}

function skeletonView(guidance: TaskFlowGuidance) {
  const dynamicStage = guidance.stages?.find((stage) => stage.role === 'dynamic-choice-region');
  const hasDependency = (fromStageId: string, toStageId: string) =>
    guidance.dependencies.some(
      (dependency) => dependency.fromStageId === fromStageId && dependency.toStageId === toStageId,
    );
  const hasLoop = (kind: string, fromStageId: string, toStageId: string) =>
    guidance.loops.some(
      (loop) => loop.kind === kind && loop.fromStageId === fromStageId && loop.toStageId === toStageId,
    );
  return {
    displayGroups: guidance.displayGroups,
    layout: guidance.layout,
    dynamicStageId: dynamicStage?.stageId ?? null,
    dynamicChoices: dynamicStage?.dynamicChoices ?? [],
    hasCheckpoint: guidance.stages.some((stage) => stage.role === 'mandatory-turn-checkpoint'),
    hasPlanner: guidance.stages.some((stage) => stage.role === 'mandatory-planner-alignment'),
    hasOccurrenceTrigger: guidance.stages.some((stage) => stage.role === 'occurrence-trigger'),
    dynamicToCheckpoint: hasDependency('dynamic-work', 'turn-checkpoint'),
    checkpointToPlanner: hasDependency('turn-checkpoint', 'planner-alignment'),
    occurrenceToDynamic: hasDependency('occurrence-trigger', 'dynamic-work'),
    turnLoop: hasLoop('turn-iteration', 'planner-alignment', 'dynamic-work'),
    occurrenceLoop: hasLoop('occurrence-repetition', 'planner-alignment', 'occurrence-trigger'),
  };
}

function create(taskFlow?: TaskFlowBinding) {
  return createDraftRevision({
    draftId: 'draft-a',
    inputRevision: 1,
    goal: 'inspect a service',
    scope: 'service health',
    normalizedInput: 'inspect a service',
    proposedIntent: 'create',
    proposal: 'Create a task',
    immutableOriginalRef: 'input-a',
    ...(taskFlow === undefined ? {} : { taskFlow }),
  });
}

function refinement(current: ReturnType<typeof create>, fields: Readonly<Record<string, unknown>>): DraftRevisionInput {
  return {
    draftId: current.draftId,
    baseRevisionVersion: current.revisionVersion,
    requestedRevisionHash: current.revisionHash,
    fields,
    instructionRef: 'instruction-a',
    idempotencyKey: `refine-${current.revisionVersion}`,
  };
}

test('task flow is part of confirmation hash and changing it stales the prior confirmation', () => {
  const initial = create(oneShot);
  const revised = refineDraftRevision(initial, refinement(initial, { taskFlow: inspection }));

  assert.notEqual(revised.revisionHash, initial.revisionHash);
  assert.deepEqual(draftRevisionDiff(initial, revised), ['taskFlow']);
  let staleError: unknown;
  try {
    assertDraftRevisionCurrent(revised, { revisionVersion: revised.revisionVersion, revisionHash: initial.revisionHash });
  } catch (error) {
    staleError = error;
  }
  assert.equal(staleError instanceof DraftRevisionError, true);
  assert.equal((staleError as DraftRevisionError).code, 'confirmation-stale');
});

test('title is optional hash-bound revision content and a title-only refinement preserves task flow', () => {
  const initial = create(inspection);
  const titled = refineDraftRevision(initial, refinement(initial, { title: 'Inspect service' }));

  assert.equal(titled.title, 'Inspect service');
  assert.equal(titled.normalizedInput, initial.normalizedInput);
  assert.deepEqual(titled.taskFlow, inspection);
  assert.notEqual(titled.revisionHash, initial.revisionHash);
  assert.deepEqual(draftRevisionDiff(initial, titled), ['title']);
  let staleError: unknown;
  try {
    assertDraftRevisionCurrent(titled, {
      revisionVersion: titled.revisionVersion,
      revisionHash: initial.revisionHash,
    });
  } catch (error) {
    staleError = error;
  }
  assert.equal(staleError instanceof DraftRevisionError, true);
  assert.equal((staleError as DraftRevisionError).code, 'confirmation-stale');
});

test('same task identity accepts the same binding and rejects a conflicting or newly inferred binding', () => {
  assert.doesNotThrow(() => assertTaskFlowBindingCompatible(taskId, oneShot, { ...oneShot }));
  assert.throws(
    () => assertTaskFlowBindingCompatible(taskId, oneShot, inspection),
    TaskFlowIdentityConflictError,
  );
  assert.throws(
    () => assertTaskFlowBindingCompatible(taskId, undefined, oneShot),
    TaskFlowIdentityConflictError,
  );
});

test('task flow guidance exposes the accepted static template skeleton', () => {
  const oneShotGuidance = guidanceFor('one-shot');
  assert.deepEqual(
    {
      oneShot: skeletonView(oneShotGuidance),
      inspection: skeletonView(guidanceFor('inspection')),
      longRunning: skeletonView(guidanceFor('long-running')),
    },
    {
      oneShot: {
        displayGroups: ['Dynamic Work', 'Turn Checkpoint', 'Planner Alignment'],
        layout: 'turn-closure-loop',
        dynamicStageId: 'dynamic-work',
        dynamicChoices: ['探索', '规划', '审查', '执行'],
        hasCheckpoint: true,
        hasPlanner: true,
        hasOccurrenceTrigger: false,
        dynamicToCheckpoint: true,
        checkpointToPlanner: true,
        occurrenceToDynamic: false,
        turnLoop: true,
        occurrenceLoop: false,
      },
      inspection: {
        displayGroups: ['Occurrence Trigger', 'Dynamic Work', 'Turn Checkpoint', 'Planner Alignment'],
        layout: 'occurrence-and-turn-closure-loop',
        dynamicStageId: 'dynamic-work',
        dynamicChoices: ['探索', '规划', '审查', '执行'],
        hasCheckpoint: true,
        hasPlanner: true,
        hasOccurrenceTrigger: true,
        dynamicToCheckpoint: true,
        checkpointToPlanner: true,
        occurrenceToDynamic: true,
        turnLoop: true,
        occurrenceLoop: true,
      },
      longRunning: {
        displayGroups: ['Dynamic Work', 'Turn Checkpoint', 'Planner Alignment'],
        layout: 'turn-closure-loop',
        dynamicStageId: 'dynamic-work',
        dynamicChoices: ['探索', '规划', '审查', '执行'],
        hasCheckpoint: true,
        hasPlanner: true,
        hasOccurrenceTrigger: false,
        dynamicToCheckpoint: true,
        checkpointToPlanner: true,
        occurrenceToDynamic: false,
        turnLoop: true,
        occurrenceLoop: false,
      },
    },
  );

  const mutable = oneShotGuidance as unknown as {
    displayGroups: string[];
    stages: Array<{ title: string; dynamicChoices?: string[] }>;
    dependencies: Array<{ fromStageId: string }>;
    loops: Array<{ title: string }>;
  };
  mutable.displayGroups[0] = 'Changed';
  mutable.stages[0]!.title = 'Changed';
  mutable.stages[0]!.dynamicChoices![0] = 'Changed';
  mutable.dependencies[0]!.fromStageId = 'Changed';
  mutable.loops[0]!.title = 'Changed';
  const cloned = guidanceFor('one-shot');
  assert.deepEqual(cloned.displayGroups, ['Dynamic Work', 'Turn Checkpoint', 'Planner Alignment']);
  assert.notEqual(cloned.stages?.[0]?.title, 'Changed');
  assert.notEqual(cloned.stages?.[0]?.dynamicChoices?.[0], 'Changed');
  assert.notEqual(cloned.dependencies?.[0]?.fromStageId, 'Changed');
  assert.notEqual(cloned.loops?.[0]?.title, 'Changed');
});

test('drafts without a task flow stay undeclared and are not defaulted', () => {
  const legacy = create();
  assert.equal(Object.hasOwn(legacy, 'taskFlow'), false);
  assert.equal(legacy.taskFlow, undefined);
  assert.equal(resolveTaskFlowGuidanceFromBinding(undefined), undefined);
});
