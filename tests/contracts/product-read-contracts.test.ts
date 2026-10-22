import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  validateProductBoardIndex,
  validateProductBoardSection,
  validateProductLocation,
  validateProductMessage,
  validateProductMessageActor,
  validateProductPendingDecision,
  validateProductRelation,
  validateProductTargetRef,
  type Attention,
  type EvidenceRef,
  type JournalCommitRef,
  type ProductBoardIndex,
  type ProductBoardItem,
  type ProductBoardSection,
  type ProductLocation,
  type ProductMessage,
  type ProductMessageActor,
  type ProductPendingDecision,
  type ProductRelation,
  type ProductTargetRef,
  type SemanticEventRef,
  type TaskId,
} from '@humanagent/contracts';
import type { CheckpointControlGrant } from '../../packages/contracts/src/checkpoint-controls.js';

const organId = id('organ', 'organ-a');
const taskA = id('task', 'task-a');
const taskB = id('task', 'task-b');

function taskScope(taskId: TaskId = taskA) {
  return {
    kind: 'task' as const,
    projectKey: 'project-a',
    mode: 'fake' as const,
    taskId,
  };
}

function evidence(): EvidenceRef {
  return {
    evidenceId: id('evidence', 'evidence-a'),
    kind: 'execution',
    source: 'journal',
    locator: 'journal://project-a/task-a/1',
    scope: { organId, taskId: taskA },
  };
}

function interactionTarget(): Extract<ProductTargetRef, { readonly kind: 'interaction' }> {
  return { kind: 'interaction', taskRef: taskA, scope: taskScope() };
}

function sessionTarget(): ProductTargetRef {
  return {
    kind: 'session',
    sessionRef: { sourceKind: 'provider-turn', sourceRef: 'turn-a' },
    taskRef: taskA,
    scope: taskScope(),
  };
}

function executionTarget(): ProductTargetRef {
  return {
    kind: 'execution-instance',
    instance: { kind: 'native-execution', execution: { runtimeId: 'runtime-a', executionEpoch: 1 } },
    taskRef: taskA,
    scope: taskScope(),
  };
}

function eventRef(): SemanticEventRef {
  return { eventId: 'event-a', sourceId: 'source-a', scope: { organId, taskId: taskA } };
}

function liveItem(): ProductBoardItem {
  return {
    lane: 'live',
    ref: interactionTarget(),
    title: 'Task A',
    displayState: 'running',
    evidenceRefs: [evidence()],
  };
}

function historyItem(): ProductBoardItem {
  return {
    lane: 'history',
    ref: sessionTarget(),
    title: 'Task A history',
    displayState: 'completed',
    evidenceRefs: [evidence()],
  };
}

function unknownItem(): ProductBoardItem {
  return {
    lane: 'unknown',
    unknownReason: 'the owner did not report a classification',
    ref: executionTarget(),
    title: 'Task A instance',
    displayState: 'unknown',
    evidenceRefs: [evidence()],
  };
}

function boardSection(): ProductBoardSection {
  return {
    board: 'interaction',
    live: [liveItem() as Extract<ProductBoardItem, { readonly lane: 'live' }>],
    history: [historyItem() as Extract<ProductBoardItem, { readonly lane: 'history' }>],
    unknown: [unknownItem() as Extract<ProductBoardItem, { readonly lane: 'unknown' }>],
    failures: [],
  };
}

function boardIndex(): ProductBoardIndex {
  return {
    scope: taskScope(),
    observedAt: '2026-10-21T00:00:00.000Z',
    boards: [boardSection()],
  };
}

function attention(): Attention {
  return {
    attentionId: 'attention-a',
    scope: { organId, taskId: taskA },
    severity: 'attention',
    state: 'open',
    message: 'The task needs a decision.',
    evidenceRefs: [evidence()],
  };
}

function grant(): CheckpointControlGrant {
  return {
    revision: 2,
    requestId: 'grant-a',
    task: taskA,
    owner: 'owner-a',
    capability: {
      actionId: 'task.execute',
      capabilities: ['provider.execution'],
      scope: { organId, taskId: taskA },
    },
    state: 'granted',
    updatedAt: '2026-10-21T00:00:00.000Z',
  };
}

function grantCommit(): JournalCommitRef {
  return { commitId: 'commit-a', journalSeq: 3, recordDigest: 'record-a' };
}

test('target refs keep kind and exact task/session/instance identity separate', () => {
  assert.doesNotThrow(() => validateProductTargetRef(interactionTarget()));
  assert.doesNotThrow(() => validateProductTargetRef(sessionTarget()));
  assert.doesNotThrow(() => validateProductTargetRef(executionTarget()));

  assert.throws(
    () => validateProductTargetRef({
      kind: 'session',
      id: 'one-merged-identity',
      sessionRef: { sourceKind: 'provider-turn', sourceRef: 'turn-a' },
      scope: taskScope(),
    } as unknown as ProductTargetRef),
    ContractError,
  );
  assert.throws(
    () => validateProductTargetRef({
      kind: 'interaction',
      taskRef: taskA,
      scope: taskScope(taskB),
    }),
    ContractError,
  );
  assert.throws(
    () => validateProductTargetRef({
      kind: 'execution-instance',
      instance: { kind: 'native-execution', execution: { runtimeId: 'runtime-a', executionEpoch: 1 } },
      taskRef: taskA,
      scope: { kind: 'task', projectKey: 'project-a', mode: 'fake', taskId: taskB },
    } as unknown as ProductTargetRef),
    ContractError,
  );
});

test('board lanes keep unknown separate from live and history', () => {
  assert.doesNotThrow(() => validateProductBoardIndex(boardIndex()));

  assert.throws(
    () => validateProductBoardSection({
      board: 'interaction',
      live: [unknownItem()],
      history: [],
      unknown: [unknownItem()],
    } as unknown as ProductBoardSection),
    ContractError,
  );
  assert.throws(
    () => validateProductBoardSection({
      board: 'interaction',
      live: [liveItem()],
      history: [liveItem()],
      unknown: [],
    } as unknown as ProductBoardSection),
    ContractError,
  );
  assert.throws(
    () => validateProductBoardIndex({
      ...boardIndex(),
      boards: [boardSection(), boardSection()],
    }),
    ContractError,
  );
});

test('message actors cannot derive human or session identity from an unknown source', () => {
  const message: ProductMessage = {
    ref: eventRef(),
    targetRef: sessionTarget(),
    actor: { kind: 'unknown', sourceKind: 'unknown', sourceRef: 'raw-turn-a' },
    occurredAt: '2026-10-21T00:00:00.000Z',
    text: 'A source owner has not decoded this actor.',
    evidenceRefs: [evidence()],
  };
  assert.doesNotThrow(() => validateProductMessage(message));
  assert.doesNotThrow(() => validateProductMessageActor({
    kind: 'agent',
    sourceKind: 'provider-role',
    sourceRef: 'role-reviewer',
  }));
  assert.doesNotThrow(() => validateProductMessageActor({
    kind: 'human',
    sourceKind: 'authenticated-principal',
    sourceRef: 'principal-a',
  }));

  assert.throws(
    () => validateProductMessageActor({ kind: 'human', sourceKind: 'unknown', sourceRef: 'raw-turn-a' }),
    ContractError,
  );
  assert.throws(
    () => validateProductMessageActor({ kind: 'human', sourceKind: 'task.input', sourceRef: 'task-a' }),
    ContractError,
  );
  assert.throws(
    () => validateProductMessage({
      ...message,
      actor: { kind: 'human', sourceKind: 'unknown', sourceRef: 'turn-a' },
    }),
    ContractError,
  );
  assert.throws(
    () => validateProductMessage({
      ...message,
      occurredAt: undefined,
      occurredAtUnavailableReason: undefined,
    }),
    ContractError,
  );
  assert.doesNotThrow(() => validateProductMessage({
    ...message,
    occurredAt: undefined,
    occurredAtUnavailableReason: 'the owner did not persist an event time',
  }));
});

test('relation kinds are closed and every relation keeps owner evidence', () => {
  const relation: ProductRelation = {
    source: interactionTarget(),
    target: sessionTarget(),
    kind: 'requirement',
    sourceOwner: 'humanagent.runtime.task-identity',
    evidenceRefs: [evidence()],
  };
  assert.doesNotThrow(() => validateProductRelation(relation));

  assert.throws(
    () => validateProductRelation({ ...relation, kind: 'invented' } as unknown as ProductRelation),
    ContractError,
  );
  assert.throws(
    () => validateProductRelation({ ...relation, evidenceRefs: [] }),
    ContractError,
  );
  assert.throws(
    () => validateProductRelation({ ...relation, sourceOwner: ' ' }),
    ContractError,
  );
});

test('location stores only a read position, never authorization state', () => {
  const location: ProductLocation = {
    board: 'interaction',
    lane: 'live',
    focus: interactionTarget(),
    scope: taskScope(),
  };
  assert.doesNotThrow(() => validateProductLocation(location));

  assert.throws(
    () => validateProductLocation({ ...location, authorized: true } as unknown as ProductLocation),
    ContractError,
  );
  assert.throws(
    () => validateProductLocation({ ...location, principal: { id: 'principal-a' } } as unknown as ProductLocation),
    ContractError,
  );
  assert.throws(
    () => validateProductLocation({
      ...location,
      scope: { ...taskScope(), controlTarget: { projectKey: 'project-a', mode: 'rcc' } },
    } as unknown as ProductLocation),
    ContractError,
  );
  assert.throws(
    () => validateProductLocation({
      ...location,
      focus: { kind: 'interaction', taskRef: taskB, scope: taskScope(taskB) },
    }),
    ContractError,
  );
});

test('pending decisions match the O2 control facts and never fake unavailable approval', () => {
  const grantDecision: ProductPendingDecision = {
    kind: 'task-grant',
    target: interactionTarget(),
    question: 'Grant the declared execution capability?',
    actions: ['grant'],
    state: 'waiting',
    revision: 2,
    readback: { grant: grant(), commit: grantCommit() },
    recoveryOwner: 'humanagent.runtime.admission',
  };
  assert.doesNotThrow(() => validateProductPendingDecision(grantDecision));

  assert.throws(
    () => validateProductPendingDecision({
      ...grantDecision,
      readback: { grant: grant(), commit: null },
    } as ProductPendingDecision),
    ContractError,
  );
  assert.throws(
    () => validateProductPendingDecision({ ...grantDecision, revision: 1 } as ProductPendingDecision),
    ContractError,
  );

  const attentionDecision: ProductPendingDecision = {
    kind: 'attention-decision',
    target: interactionTarget(),
    attention: attention(),
    question: 'The attention fact is visible, but no public decision route exists.',
    actions: [],
    state: 'unavailable',
    unavailableReason: 'Attention has no public list or disposal route.',
    recoveryOwner: 'humanagent.runtime.control',
  };
  assert.doesNotThrow(() => validateProductPendingDecision(attentionDecision));
  assert.throws(
    () => validateProductPendingDecision({
      ...attentionDecision,
      actions: ['grant'],
    } as unknown as ProductPendingDecision),
    ContractError,
  );

  const inputDecision: ProductPendingDecision = {
    kind: 'task-input-request',
    target: interactionTarget(),
    request: {
      requestId: 'request-a',
      taskId: taskA,
      schemaRef: 'schema-a',
      reason: 'A field is missing.',
      impact: 'The task cannot continue.',
    },
    question: 'The task input request type has no producer or route.',
    actions: [],
    state: 'unavailable',
    unavailableReason: 'TaskInputRequest is a dead type with no producer, route or consumer.',
    recoveryOwner: 'humanagent.runtime.explicit-brain',
  };
  assert.doesNotThrow(() => validateProductPendingDecision(inputDecision));
  assert.throws(
    () => validateProductPendingDecision({
      ...inputDecision,
      actions: ['grant'],
    } as unknown as ProductPendingDecision),
    ContractError,
  );
});

// These assignments are compile-time assertions. Each @ts-expect-error line must
// fail type checking; tsc reports an unused directive if a forbidden shape starts
// to compile.
function compileTimeOnly(): void {
  // @ts-expect-error ProductTargetRef has no single merged string identity.
  const mergedIdentity: ProductTargetRef = { kind: 'interaction', id: 'task-a', taskRef: taskA, scope: taskScope() };
  // @ts-expect-error An unknown-lane item cannot occupy the live lane.
  const unknownInLive: ProductBoardSection = { board: 'interaction', live: [unknownItem()], history: [], unknown: [] };
  // @ts-expect-error updatedAt is not a board classification fact.
  const updatedAtItem: ProductBoardItem = { ...liveItem(), updatedAt: '2026-10-21T00:00:00.000Z' };
  // @ts-expect-error A human actor must carry a decoded source reference.
  const humanWithoutSource: ProductMessageActor = { kind: 'human', sourceKind: 'authenticated-principal' };
  // @ts-expect-error Relation kind is a closed set.
  const inventedRelationKind: ProductRelation = { source: interactionTarget(), target: sessionTarget(), kind: 'invented', sourceOwner: 'owner-a', evidenceRefs: [evidence()] };
  // @ts-expect-error Location has no authorization field.
  const authorizedLocation: ProductLocation = { board: 'interaction', lane: 'live', scope: taskScope(), authorized: true };
  void mergedIdentity;
  void unknownInLive;
  void updatedAtItem;
  void humanWithoutSource;
  void inventedRelationKind;
  void authorizedLocation;
}

void compileTimeOnly;
