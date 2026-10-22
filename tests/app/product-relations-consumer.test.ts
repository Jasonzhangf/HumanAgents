import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  sameProductTargetRef,
  type EvidenceRef,
  type ProductBoardIndex,
  type ProductBoardItem,
  type ProductRelation,
  type ProductTargetRef,
  type TaskId,
  type TaskIdentitySource,
} from '../../packages/contracts/src/index.js';
import type { InspectionOccurrenceRecord } from '../../packages/contracts/src/inspection.js';
import type {
  RuntimeTaskExecutionLineage,
  RuntimeTaskListProjection,
  RuntimeTaskRowProjection,
} from '../../packages/ui/contracts/runtime.js';
import {
  composeProductSessionRead,
  type ProductReadSelection,
} from '../../packages/app/src/ui-runtime/product-session-read.js';
import {
  composeProductRelationList,
  composeProductRelations,
  productRelationRefKey,
  type ProductTaskRelationFact,
} from '../../packages/app/src/ui-runtime/product-relations.js';

const organId = id('organ', 'organ-a');
const parentTask = id('task', 'task-parent');
const childTask = id('task', 'task-child');
const unrelatedTask = id('task', 'task-unrelated');
const missingParentTask = id('task', 'task-missing-parent');
const absentParentTask = id('task', 'task-absent-parent');
const plainTask = id('task', 'task-plain');
const projectKey = 'project-a';
const observedAt = '2026-10-21T10:00:00.000Z';

function selection(): ProductReadSelection {
  return { projectKey, mode: 'fake' };
}

function taskScope(taskId: TaskId) {
  return { kind: 'task' as const, projectKey, mode: 'fake' as const, taskId };
}

function evidence(taskId: TaskId = childTask, token = 'default'): EvidenceRef {
  const safe = token.replace(/[^A-Za-z0-9._-]/g, '-');
  return {
    evidenceId: id('evidence', `evidence-${taskId.value}-${safe}`),
    kind: 'execution',
    source: 'journal',
    locator: `journal://${taskId.value}/${token}`,
    scope: { organId, taskId },
  };
}

function row(
  taskId: TaskId,
  title = 'Weekly report',
  lineage?: RuntimeTaskExecutionLineage,
): RuntimeTaskRowProjection {
  return {
    taskId,
    title,
    state: 'running',
    stateLabel: 'running',
    ...(lineage === undefined ? {} : { executionLineage: lineage }),
    currentState: 'running',
    nextStep: '',
    updatedAt: '2026-10-21T12:34:56.000Z',
    allowedActions: [],
    output: '',
    entry: 'task-dashboard',
  };
}

function taskList(rows: readonly RuntimeTaskRowProjection[]): RuntimeTaskListProjection {
  return {
    surface: 'runtime-task-list',
    mode: 'fake',
    running: rows,
    waiting: [],
    completed: [],
    stopped: [],
    draft: [],
    failed: [],
    counts: {
      running: rows.length,
      waiting: 0,
      completed: 0,
      stopped: 0,
      draft: 0,
      failed: 0,
      total: rows.length,
    },
  };
}

function identitySource(requirementId = 'requirement-1'): TaskIdentitySource {
  return {
    requirementId,
    inputRevision: 1,
    draftId: 'draft-1',
    draftRevisionVersion: 1,
    draftRevisionHash: 'hash-1',
    confirmationRef: 'confirmation-1',
  };
}

function inspectionOccurrence(taskId: TaskId, occurrenceId: string): InspectionOccurrenceRecord {
  return {
    occurrence: { scope: { organId, taskId }, occurrenceId },
    definition: {
      definitionId: 'definition-1',
      definitionVersion: '1',
      target: { targetRef: 'workspace', sourceRef: 'workspace' },
      checkItems: [{ checkId: 'check-1' }],
    },
    results: [{ checkId: 'check-1', state: 'completed', evidenceRefs: [evidence(taskId, 'inspection')] }],
    evidenceRefs: [evidence(taskId, 'inspection-record')],
  };
}

function allItems(index: ProductBoardIndex): readonly ProductBoardItem[] {
  return index.boards.flatMap((section) => [...section.live, ...section.history, ...section.unknown]);
}

function interactionRef(index: ProductBoardIndex, taskId: TaskId): Extract<ProductTargetRef, { kind: 'interaction' }> {
  const item = allItems(index).find(
    (candidate) => candidate.ref.kind === 'interaction' && candidate.ref.taskRef.value === taskId.value,
  );
  if (item === undefined || item.ref.kind !== 'interaction') {
    throw new Error(`the board index has no exact interaction ref for task ${taskId.value}`);
  }
  return item.ref;
}

function sessionRef(index: ProductBoardIndex, sourceKind: string, sourceRef: string): ProductTargetRef {
  const item = allItems(index).find(
    (candidate) => candidate.ref.kind === 'session'
      && candidate.ref.sessionRef.sourceKind === sourceKind
      && candidate.ref.sessionRef.sourceRef === sourceRef,
  );
  if (item === undefined) throw new Error(`the board index has no ${sourceKind} session ref ${sourceRef}`);
  return item.ref;
}

function readWith(rows: readonly RuntimeTaskRowProjection[], inspections: readonly InspectionOccurrenceRecord[] = []) {
  return composeProductSessionRead({
    selection: selection(),
    organId,
    observedAt,
    taskList: { ok: true, value: taskList(rows) },
    agentActivity: [],
    interactions: { ok: true, value: [] },
    inspections: { ok: true, value: inspections },
  });
}

test('T3 unrelated same-title records never gain an edge from typed lineage neighbours', () => {
  const lineage: RuntimeTaskExecutionLineage = {
    parentTaskId: parentTask,
    subscriptionId: 'subscription-1',
    occurrenceId: 'occurrence-1',
  };
  const read = readWith(
    [
      row(parentTask, 'Weekly report'),
      row(childTask, 'Weekly report', lineage),
      row(unrelatedTask, 'Weekly report'),
    ],
    [inspectionOccurrence(childTask, 'occurrence-1')],
  );

  const facts: readonly ProductTaskRelationFact[] = [
    { taskId: parentTask, identitySource: identitySource() },
    { taskId: childTask, executionLineage: lineage, evidenceRefs: [evidence(childTask, 'lineage')] },
    { taskId: unrelatedTask },
  ];
  const result = composeProductRelations({ read, tasks: facts });

  const parentRef = interactionRef(read.boardIndex, parentTask);
  const childRef = interactionRef(read.boardIndex, childTask);
  const unrelatedRef = interactionRef(read.boardIndex, unrelatedTask);

  const childEdges = result.relations.filter((relation) => relation.kind === 'child-execution');
  assert.equal(childEdges.length, 1, 'the typed lineage must produce exactly one parent to child edge');
  assert.ok(sameProductTargetRef(childEdges[0].source, parentRef));
  assert.ok(sameProductTargetRef(childEdges[0].target, childRef));

  const occurrenceEdges = result.relations.filter((relation) => relation.kind === 'occurrence');
  assert.equal(occurrenceEdges.length, 1, 'the committed occurrence must be linked once');
  assert.ok(sameProductTargetRef(occurrenceEdges[0].source, childRef));
  assert.ok(sameProductTargetRef(
    occurrenceEdges[0].target,
    sessionRef(read.boardIndex, 'inspection-occurrence', 'occurrence-1'),
  ));

  assert.ok(
    result.relations.every((relation) => !sameProductTargetRef(relation.source, unrelatedRef)
      && !sameProductTargetRef(relation.target, unrelatedRef)),
    'a same-title task without typed lineage must never appear as an edge endpoint',
  );

  const nodeKeys = result.relations.flatMap((relation) => [
    productRelationRefKey(relation.source),
    productRelationRefKey(relation.target),
  ]);
  assert.equal(new Set(nodeKeys).size, 3, 'parent, child and occurrence must each appear exactly once');

  const doubled = composeProductRelations({ read, tasks: [...facts, facts[1]!] });
  assert.deepEqual(
    doubled.relations.map((relation) => [
      productRelationRefKey(relation.source),
      productRelationRefKey(relation.target),
      relation.kind,
    ]),
    result.relations.map((relation) => [
      productRelationRefKey(relation.source),
      productRelationRefKey(relation.target),
      relation.kind,
    ]),
    'repeated lineage facts must collapse by exact source, target and kind',
  );
  assert.ok(result.gaps.some((gap) => gap.code === 'relation.requirement-ref-not-recorded'));
  assert.ok(result.gaps.some((gap) => gap.code === 'relation.subscription-ref-not-recorded'));
});

test('T3 unrecorded refs and evidence stay explicit and never become edges', () => {
  const missingParentLineage: RuntimeTaskExecutionLineage = {
    parentTaskId: absentParentTask,
    subscriptionId: 'subscription-2',
    occurrenceId: 'occurrence-2',
  };
  const noEvidenceLineage: RuntimeTaskExecutionLineage = {
    parentTaskId: parentTask,
    subscriptionId: 'subscription-3',
    occurrenceId: 'occurrence-3',
  };
  const read = readWith([
    row(parentTask),
    row(missingParentTask, 'Weekly report', missingParentLineage),
    row(childTask, 'Weekly report', noEvidenceLineage),
    row(plainTask),
  ]);

  const result = composeProductRelations({
    read,
    tasks: [
      { taskId: missingParentTask, executionLineage: missingParentLineage, evidenceRefs: [evidence(missingParentTask)] },
      { taskId: childTask, executionLineage: noEvidenceLineage },
      { taskId: plainTask, identitySource: identitySource('requirement-plain') },
    ],
    focusTaskId: plainTask,
  });

  assert.equal(result.relations.length, 0, 'no unrecorded fact may be rendered as an edge');
  const codes = new Set(result.gaps.map((gap) => gap.code));
  assert.ok(codes.has('relation.parent-ref-not-recorded'));
  assert.ok(codes.has('relation.evidence-not-recorded'));
  assert.ok(codes.has('relation.requirement-ref-not-recorded'));
  const plainGaps = result.gaps.filter((gap) => gap.taskId.value === plainTask.value);
  assert.ok(plainGaps.some((gap) => gap.code === 'relation.execution-lineage-absent' && gap.state === 'absent'));
  assert.ok(plainGaps.some((gap) => gap.code === 'relation.requirement-ref-not-recorded' && gap.state === 'unrecorded'));
});

test('explicit owner relations pass through only with evidence and dedupe by exact refs', () => {
  const read = readWith([row(childTask)]);
  const childRef = interactionRef(read.boardIndex, childTask);
  const memoryTarget: ProductTargetRef = {
    kind: 'session',
    sessionRef: { sourceKind: 'memory-agent', sourceRef: 'memory-session-1' },
    taskRef: childTask,
    scope: taskScope(childTask),
  };
  const relation: ProductRelation = {
    source: childRef,
    target: memoryTarget,
    kind: 'unknown',
    sourceOwner: 'memory-owner',
    evidenceRefs: [evidence(childTask, 'memory')],
  };

  const result = composeProductRelations({ read, relations: [relation, relation] });
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0]!.kind, 'unknown');

  const noEvidence = { ...relation, evidenceRefs: [] } as ProductRelation;
  assert.throws(
    () => composeProductRelations({ read, relations: [noEvidence] }),
    /requires owner evidence/,
  );
});

test('one read result drives a complete, deterministic, duplicate-free relation list', () => {
  const lineage: RuntimeTaskExecutionLineage = {
    parentTaskId: parentTask,
    subscriptionId: 'subscription-1',
    occurrenceId: 'occurrence-1',
  };
  const read = readWith(
    [row(parentTask), row(childTask, 'Weekly report', lineage)],
    [inspectionOccurrence(childTask, 'occurrence-1')],
  );
  const facts: readonly ProductTaskRelationFact[] = [
    { taskId: childTask, executionLineage: lineage, evidenceRefs: [evidence(childTask, 'lineage')] },
  ];

  const first = composeProductRelations({ read, tasks: facts });
  const second = composeProductRelations({ read, tasks: facts });
  assert.deepEqual(
    first.relations.map((relation) => productRelationRefKey(relation.source)),
    second.relations.map((relation) => productRelationRefKey(relation.source)),
  );
  assert.deepEqual(
    composeProductRelationList({ read, tasks: facts }).map((relation) => productRelationRefKey(relation.target)),
    first.relations.map((relation) => productRelationRefKey(relation.target)),
  );
  assert.ok(first.relations.every((relation) => relation.evidenceRefs.length > 0));
});
