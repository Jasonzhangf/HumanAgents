import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  sameProductTargetRef,
  type EvidenceRef,
  type LifecycleState,
  type ProductBoardIndex,
  type ProductBoardItem,
  type ProductMessage,
  type ProductTargetRef,
  type TaskId,
} from '../../packages/contracts/src/index.js';
import type { InspectionOccurrenceRecord } from '../../packages/contracts/src/inspection.js';
import type {
  RuntimeAgentActivityEntryProjection,
  RuntimeAgentActivityProjection,
  RuntimeTaskEventProjection,
  RuntimeTaskListProjection,
  RuntimeTaskRowProjection,
} from '../../packages/ui/contracts/runtime.js';
import {
  composeProductBoardIndex,
  composeProductSessionMessages,
  productBoardCards,
  productBoardDashboard,
  type ProductInteractionFact,
  type ProductMessageFact,
  type ProductReadSelection,
} from '../../packages/app/src/ui-runtime/product-session-read.js';

const organId = id('organ', 'organ-a');
const taskA = id('task', 'task-a');
const taskB = id('task', 'task-b');
const projectA = 'project-a';
const projectB = 'project-b';
const observedAt = '2026-10-21T10:00:00.000Z';

function selection(projectKey: string, taskId?: TaskId): ProductReadSelection {
  return { projectKey, mode: 'fake', ...(taskId === undefined ? {} : { taskId }) };
}

function evidence(taskId: TaskId = taskA, token = 'default'): EvidenceRef {
  const safe = token.replace(/[^A-Za-z0-9._-]/g, '-');
  return {
    evidenceId: id('evidence', `evidence-${taskId.value}-${safe}`),
    kind: 'execution',
    source: 'journal',
    locator: `journal://${taskId.value}/${token}`,
    scope: { organId, taskId },
  };
}

function taskScope(projectKey: string, taskId: TaskId) {
  return { kind: 'task' as const, projectKey, mode: 'fake' as const, taskId };
}

function interactionTarget(projectKey: string, taskId: TaskId): ProductTargetRef {
  return { kind: 'interaction', taskRef: taskId, scope: taskScope(projectKey, taskId) };
}

function row(
  taskId: TaskId,
  state: LifecycleState,
  title = 'Fix login',
): RuntimeTaskRowProjection {
  return {
    taskId,
    title,
    state,
    stateLabel: state,
    currentState: `state ${state}`,
    nextStep: '',
    updatedAt: '2026-10-21T12:34:56.000Z',
    allowedActions: [],
    output: '',
    entry: 'task-dashboard',
  };
}

function taskList(groups: {
  readonly running?: readonly RuntimeTaskRowProjection[];
  readonly waiting?: readonly RuntimeTaskRowProjection[];
  readonly completed?: readonly RuntimeTaskRowProjection[];
  readonly stopped?: readonly RuntimeTaskRowProjection[];
  readonly draft?: readonly RuntimeTaskRowProjection[];
  readonly failed?: readonly RuntimeTaskRowProjection[];
}): RuntimeTaskListProjection {
  const running = groups.running ?? [];
  const waiting = groups.waiting ?? [];
  const completed = groups.completed ?? [];
  const stopped = groups.stopped ?? [];
  const draft = groups.draft ?? [];
  const failed = groups.failed ?? [];
  return {
    surface: 'runtime-task-list',
    mode: 'fake',
    running,
    waiting,
    completed,
    stopped,
    draft,
    failed,
    counts: {
      running: running.length,
      waiting: waiting.length,
      completed: completed.length,
      stopped: stopped.length,
      draft: draft.length,
      failed: failed.length,
      total: running.length + waiting.length + completed.length + stopped.length + draft.length + failed.length,
    },
  };
}

function activityEntry(input: {
  readonly taskId?: TaskId;
  readonly runtimeId: string;
  readonly executionEpoch?: number;
  readonly currency: 'current' | 'historical' | 'unknown';
  readonly sourceKind?: 'active-turn' | 'closed-turn-planner-call';
}): RuntimeAgentActivityEntryProjection {
  const taskId = input.taskId ?? taskA;
  const executionEpoch = input.executionEpoch ?? 1;
  const sourceKind = input.sourceKind ?? 'active-turn';
  const common = {
    taskId,
    instance: {
      kind: 'native-execution' as const,
      label: input.runtimeId,
      runtimeId: input.runtimeId,
      executionEpoch,
    },
    assignmentId: `assignment-${taskId.value}-${input.runtimeId}`,
    executionEpoch,
    currency: input.currency,
    currencyLabel: input.currency,
    commitRefs: [],
    evidenceRefs: [evidence(taskId, `journal://${taskId.value}/${input.runtimeId}`)],
  };
  if (sourceKind === 'closed-turn-planner-call') {
    return {
      ...common,
      sourceKind: 'closed-turn-planner-call',
      sourceKindLabel: 'closed-turn-planner-call',
    };
  }
  return {
    ...common,
    sourceKind: 'active-turn',
    sourceKindLabel: 'active-turn',
    objective: `objective ${input.runtimeId}`,
  };
}

function activity(
  projectKey: string,
  taskId: TaskId,
  lanes: {
    readonly current?: readonly RuntimeAgentActivityEntryProjection[];
    readonly historical?: readonly RuntimeAgentActivityEntryProjection[];
    readonly unknown?: readonly RuntimeAgentActivityEntryProjection[];
  },
): RuntimeAgentActivityProjection {
  return {
    surface: 'runtime-agent-activity',
    scope: taskScope(projectKey, taskId),
    taskId,
    mode: 'catalog',
    current: lanes.current ?? [],
    historical: lanes.historical ?? [],
    unknown: lanes.unknown ?? [],
    unavailableSources: [],
  };
}

function interaction(
  overrides: Partial<ProductInteractionFact> & { readonly interactionId: string },
): ProductInteractionFact {
  return {
    state: 'awaiting-confirmation',
    rawInput: 'please build it',
    ...overrides,
  };
}

function messageFact(kind: 'human' | 'agent', eventId: string): ProductMessageFact {
  const ref = {
    eventId,
    sourceId: kind === 'human' ? 'authenticated-principal' : 'provider-role',
    scope: { organId, taskId: taskA },
  };
  return {
    ref,
    targetRef: interactionTarget(projectA, taskA),
    actor: kind === 'human'
      ? { kind: 'human', sourceKind: 'authenticated-principal', sourceRef: 'principal-a' }
      : { kind: 'agent', sourceKind: 'provider-role', sourceRef: 'role-reviewer' },
    occurredAt: '2026-10-21T09:59:00.000Z',
    text: kind === 'human' ? 'approved by a real principal' : 'agent reviewed the change',
    evidenceRefs: [evidence()],
  };
}

function event(): RuntimeTaskEventProjection {
  return {
    seq: 7,
    kind: 'provider.output',
    state: 'running',
    summary: 'agent says hi',
    occurredAt: '2026-10-21T10:00:05.000Z',
    evidenceRefs: [evidence()],
  };
}

function assertSameRefSequence(
  left: readonly ProductBoardItem[],
  right: readonly ProductBoardItem[],
): void {
  assert.equal(left.length, right.length);
  for (let index = 0; index < left.length; index += 1) {
    assert.ok(
      sameProductTargetRef(left[index].ref, right[index].ref),
      `ref ${index} differs between cards and dashboard lanes`,
    );
  }
}

function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function items(index: ProductBoardIndex): readonly ProductBoardItem[] {
  return index.boards.flatMap((board) => [...board.live, ...board.history, ...board.unknown]);
}

test('T1 keeps decoded actors and real event time; unknown sources never become human', () => {
  const updatedAt = row(taskA, 'running').updatedAt;
  const messages: readonly ProductMessage[] = composeProductSessionMessages({
    selection: selection(projectA, taskA),
    organId,
    interactions: {
      ok: true,
      value: [interaction({ interactionId: 'interaction-1', taskRef: taskA })],
    },
    taskEvents: [{ taskId: taskA, events: [event()] }],
    messages: [messageFact('human', 'event-human'), messageFact('agent', 'event-agent')],
  });

  const fromInteraction = messages.find((message) => message.ref.sourceId === 'explicit-intake');
  if (fromInteraction === undefined) throw new Error('the interaction message must be composed');
  assert.equal(fromInteraction.actor.kind, 'unknown');
  assert.equal(fromInteraction.occurredAt, undefined);
  assert.match(fromInteraction.occurredAtUnavailableReason ?? '', /event time/);

  const fromEvent = messages.find((message) => message.ref.sourceId === 'runtime-task-event');
  if (fromEvent === undefined) throw new Error('the task event message must be composed');
  assert.equal(fromEvent.actor.kind, 'unknown');
  assert.equal(fromEvent.occurredAt, '2026-10-21T10:00:05.000Z');
  assert.ok(fromEvent.occurredAt !== updatedAt);

  const humans = messages.filter((message) => message.actor.kind === 'human');
  assert.equal(humans.length, 1);
  assert.equal(humans[0].actor.sourceRef, 'principal-a');
  const agents = messages.filter((message) => message.actor.kind === 'agent');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].actor.sourceRef, 'role-reviewer');
});

test('T2 keeps same-name tasks, multi-instance sessions and unknown lanes isolated', () => {
  const currentOne = activityEntry({ runtimeId: 'runtime-a1', currency: 'current' });
  const currentTwo = activityEntry({ runtimeId: 'runtime-a2', currency: 'current' });
  const unknown = activityEntry({ runtimeId: 'runtime-a3', currency: 'unknown' });
  const indexA = composeProductBoardIndex({
    selection: selection(projectA, taskA),
    observedAt,
    taskList: { ok: true, value: taskList({ running: [row(taskA, 'running')] }) },
    agentActivity: [{
      ok: true,
      value: activity(projectA, taskA, { current: [currentOne, currentTwo], unknown: [unknown] }),
    }],
    interactions: {
      ok: true,
      value: [interaction({ interactionId: 'interaction-a', rawInput: 'task A body' })],
    },
    inspections: { ok: true, value: [] },
    memory: { ok: true, value: { analysisState: 'idle', candidateCount: 2 } },
  });
  const indexB = composeProductBoardIndex({
    selection: selection(projectB, taskB),
    observedAt,
    taskList: { ok: true, value: taskList({ running: [row(taskB, 'running')] }) },
    agentActivity: [{
      ok: true,
      value: activity(projectB, taskB, {
        historical: [activityEntry({ taskId: taskB, runtimeId: 'runtime-b1', currency: 'historical' })],
      }),
    }],
    interactions: {
      ok: true,
      value: [interaction({ interactionId: 'interaction-b', rawInput: 'task B body' })],
    },
    inspections: { ok: true, value: [] },
    memory: { ok: true, value: { analysisState: 'idle', candidateCount: 0 } },
  });

  const execution = requireDefined(productBoardDashboard(indexA, 'execution'), 'the execution board must exist');
  assert.equal(execution.live.length, 2);
  assert.ok(sameProductTargetRef(execution.live[0].ref, execution.live[1].ref) === false);
  assert.equal(execution.unknown.length, 1);
  assert.ok(!execution.live.some((item) => sameProductTargetRef(item.ref, execution.unknown[0].ref)));

  for (const item of items(indexA)) {
    const scope = item.ref.scope;
    if (scope.kind === 'system') throw new Error('board item scope cannot be system');
    assert.equal(scope.projectKey, projectA);
    if (scope.kind === 'task') assert.equal(scope.taskId.value, taskA.value);
  }
  for (const item of items(indexB)) {
    const scope = item.ref.scope;
    if (scope.kind === 'system') throw new Error('board item scope cannot be system');
    assert.equal(scope.projectKey, projectB);
    if (scope.kind === 'task') assert.equal(scope.taskId.value, taskB.value);
  }

  for (const board of indexA.boards) {
    const dashboard = requireDefined(
      productBoardDashboard(indexA, board.board),
      `missing dashboard section ${board.board}`,
    );
    const cards = productBoardCards(indexA, board.board);
    assertSameRefSequence(cards, [...dashboard.live, ...dashboard.history, ...dashboard.unknown]);
  }

  const messagesA = composeProductSessionMessages({
    selection: selection(projectA, taskA),
    organId,
    interactions: { ok: true, value: [interaction({ interactionId: 'interaction-a', rawInput: 'task A body' })] },
    taskEvents: [],
  });
  const messagesB = composeProductSessionMessages({
    selection: selection(projectB, taskB),
    organId,
    interactions: { ok: true, value: [interaction({ interactionId: 'interaction-b', rawInput: 'task B body' })] },
    taskEvents: [],
  });
  assert.ok(messagesA.every((message) => !message.text.includes('task B body')));
  assert.ok(messagesB.every((message) => !message.text.includes('task A body')));
});

test('T2 turns a foreign-scope activity read into a failure, not a live item', () => {
  const index = composeProductBoardIndex({
    selection: selection(projectA, taskA),
    observedAt,
    taskList: { ok: true, value: taskList({ running: [row(taskA, 'running')] }) },
    agentActivity: [{
      ok: true,
      value: activity(projectB, taskA, {
        current: [activityEntry({ runtimeId: 'runtime-foreign', currency: 'current' })],
      }),
    }],
    interactions: { ok: true, value: [] },
    inspections: { ok: true, value: [] },
  });
  const execution = requireDefined(productBoardDashboard(index, 'execution'), 'the execution board must exist');
  assert.equal(execution.live.length, 0);
  assert.ok((execution.failures ?? []).some((failure) => failure.code.includes('scope')));
});

test('missing readers stay failures while confirmed empty sources stay empty', () => {
  const index = composeProductBoardIndex({
    selection: selection(projectA, taskA),
    observedAt,
    taskList: { ok: true, value: taskList({}) },
    agentActivity: [],
    interactions: { ok: true, value: [] },
    inspections: { ok: true, value: [] },
    memory: { ok: true, value: { analysisState: 'idle', candidateCount: 3 } },
  });

  for (const board of ['interaction', 'orchestration', 'inspection', 'execution'] as const) {
    const section = requireDefined(productBoardDashboard(index, board), `missing section ${board}`);
    assert.equal(section.live.length, 0);
    assert.equal(section.history.length, 0);
    assert.equal(section.unknown.length, 0);
    assert.equal((section.failures ?? []).length, 0);
  }

  const memory = requireDefined(productBoardDashboard(index, 'memory'), 'the memory board must exist');
  assert.equal(memory.live.length + memory.history.length + memory.unknown.length, 0);
  const memoryFailures = memory.failures ?? [];
  assert.ok(memoryFailures.some((failure) => failure.code === 'memory.session-source-unavailable'));
  assert.ok(memoryFailures.some((failure) => failure.code === 'memory.candidates-are-not-sessions'));

  const missing = composeProductBoardIndex({
    selection: selection(projectA, taskA),
    observedAt,
  });
  for (const board of ['interaction', 'orchestration', 'inspection', 'execution', 'memory'] as const) {
    const section = requireDefined(productBoardDashboard(missing, board), `missing section ${board}`);
    assert.equal(section.live.length + section.history.length + section.unknown.length, 0);
    assert.ok((section.failures ?? []).length > 0, `${board} must keep a read failure`);
  }
});

test('inspection occurrences enter history without inventing a live state', () => {
  const occurrence: InspectionOccurrenceRecord = {
    occurrence: {
      scope: { organId, taskId: taskA },
      occurrenceId: 'occurrence-1',
    },
    definition: {
      definitionId: 'definition-1',
      definitionVersion: '1',
      target: { targetRef: 'workspace', sourceRef: 'workspace' },
      checkItems: [{ checkId: 'check-1' }],
    },
    results: [{ checkId: 'check-1', state: 'completed', evidenceRefs: [evidence()] }],
    evidenceRefs: [evidence()],
  };
  const index = composeProductBoardIndex({
    selection: selection(projectA, taskA),
    observedAt,
    taskList: { ok: true, value: taskList({}) },
    agentActivity: [],
    interactions: { ok: true, value: [] },
    inspections: { ok: true, value: [occurrence] },
  });
  const inspection = requireDefined(productBoardDashboard(index, 'inspection'), 'the inspection board must exist');
  assert.equal(inspection.live.length, 0);
  assert.equal(inspection.history.length, 1);
  assert.equal(inspection.history[0].ref.kind, 'session');
});
