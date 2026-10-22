import {
  sameProductTargetRef,
  validateProductBoardIndex,
  validateProductMessage,
  type EvidenceRef,
  type OrganId,
  type ProductBoardIndex,
  type ProductBoardItem,
  type ProductBoardKind,
  type ProductBoardSection,
  type ProductMessage,
  type ProductMessageActor,
  type ProductReadMode,
  type ProductReadScope,
  type ProductTargetRef,
  type SemanticEventRef,
  type TaskExecutionInstanceIdentity,
  type TaskId,
} from '../../../contracts/src/index.js';
import type { InspectionOccurrenceRecord } from '../../../contracts/src/inspection.js';
import type {
  RuntimeAgentActivityEntryProjection,
  RuntimeAgentActivityProjection,
  RuntimeInspectionOccurrenceProjection,
  RuntimeLivenessProjection,
  RuntimeReadFailure,
  RuntimeReadResult,
  RuntimeTaskEventProjection,
  RuntimeTaskListProjection,
  RuntimeTaskRowProjection,
} from '../../../ui/contracts/runtime.js';

/**
 * A1 board and session composition.
 *
 * This module is a pure read composition. It accepts facts that a declared
 * reader already decoded and arranges them for the five product boards and the
 * human session view. It owns no store, fetches nothing, and never rebuilds
 * identity from titles, roles, timestamps, `task.input` or page transport
 * state. Read failures stay visible on their board and never become an empty
 * live set.
 */
const OWNER_ID = 'humanagent.app.ui-runtime.product-session-read';

export type ProductBoardScope = Extract<
  ProductReadScope,
  { readonly kind: 'project' } | { readonly kind: 'task' }
>;

/**
 * One project/mode selection. The composer derives the exact read scope from
 * this single value, so a caller cannot pass a project with a mismatched task
 * scope or mode.
 */
export interface ProductReadSelection {
  readonly projectKey: string;
  readonly mode: ProductReadMode;
  readonly taskId?: TaskId;
}

export function productSelectionScope(selection: ProductReadSelection): ProductBoardScope {
  return selection.taskId === undefined
    ? { kind: 'project', projectKey: selection.projectKey }
    : { kind: 'task', projectKey: selection.projectKey, mode: selection.mode, taskId: selection.taskId };
}

/**
 * Already-decoded explicit intake fact. `taskRef` is present only when the
 * owner recorded an exact task link (for example a confirmed draft). The
 * interaction owner does not persist a principal today, so no field in this
 * input can claim a human actor.
 */
export interface ProductInteractionFact {
  readonly interactionId: string;
  readonly state: string;
  readonly rawInput: string;
  readonly occurredAt?: string;
  readonly taskRef?: TaskId;
  readonly title?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

/**
 * A memory-agent session decoded by its owner. Memory review candidates are not
 * sessions and therefore have no representation in this type.
 */
export interface ProductMemorySessionFact {
  readonly sessionRef: {
    readonly sourceKind: string;
    readonly sourceRef: string;
  };
  readonly taskRef?: TaskId;
  readonly title: string;
  readonly displayState: string;
  readonly currency: 'current' | 'historical' | 'unknown';
  readonly unknownReason?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ProductTaskLivenessFact {
  readonly taskId: TaskId;
  readonly liveness: RuntimeLivenessProjection;
}

/**
 * Facts needed to report why the memory board has no session items. They are
 * metadata for the failure, not board entries.
 */
export interface ProductMemoryReadFacts {
  readonly analysisState: string;
  readonly candidateCount: number;
}

export interface ProductTaskEventFact {
  readonly taskId: TaskId;
  readonly scope?: Extract<ProductReadScope, { readonly kind: 'task' }>;
  readonly events: readonly RuntimeTaskEventProjection[];
}

/**
 * Minimal inspection display fact derived from the I2 occurrence projection.
 * The projection does not carry the full immutable definition object, so this
 * fact keeps only the owner-reported occurrence/definition identity, the real
 * `openedAt`, and a display state derived from the occurrence outcome and item
 * outcomes. It never invents a definition body.
 */
export interface ProductInspectionDisplayFact {
  readonly kind: 'inspection-display';
  readonly occurrenceId: string;
  readonly definitionId: string;
  readonly taskId: TaskId;
  readonly displayState: string;
  readonly openedAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

/** A1 accepts either a full record or the projection-derived display fact. */
export type ProductInspectionFact = InspectionOccurrenceRecord | ProductInspectionDisplayFact;

/**
 * A message fact whose actor/time were already decoded by its owner. Facts
 * without an event time receive an explicit unavailable reason; this composer
 * never substitutes a task update time.
 */
export interface ProductMessageFact {
  readonly ref: SemanticEventRef;
  readonly targetRef: ProductTargetRef;
  readonly actor: ProductMessageActor;
  readonly occurredAt?: string;
  readonly occurredAtUnavailableReason?: string;
  readonly text: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ProductBoardComposeInput {
  readonly selection: ProductReadSelection;
  readonly observedAt: string;
  readonly taskList?: RuntimeReadResult<RuntimeTaskListProjection>;
  readonly agentActivity?: readonly RuntimeReadResult<RuntimeAgentActivityProjection>[];
  readonly interactions?: RuntimeReadResult<readonly ProductInteractionFact[]>;
  readonly inspections?: RuntimeReadResult<readonly ProductInspectionFact[]>;
  readonly memory?: RuntimeReadResult<ProductMemoryReadFacts>;
  readonly memorySessions?: RuntimeReadResult<readonly ProductMemorySessionFact[]>;
  readonly liveness?: readonly ProductTaskLivenessFact[];
}

export interface ProductSessionComposeInput {
  readonly selection: ProductReadSelection;
  readonly organId: OrganId;
  readonly interactions?: RuntimeReadResult<readonly ProductInteractionFact[]>;
  readonly taskEvents?: readonly ProductTaskEventFact[];
  readonly messages?: readonly ProductMessageFact[];
}

export interface ProductSessionReadInput extends ProductBoardComposeInput, ProductSessionComposeInput {}

export interface ProductSessionRead {
  readonly boardIndex: ProductBoardIndex;
  readonly messages: readonly ProductMessage[];
}

export class ProductSessionReadError extends Error {
  readonly failure: RuntimeReadFailure;

  constructor(message: string, failure: RuntimeReadFailure) {
    super(message);
    this.name = 'ProductSessionReadError';
    this.failure = failure;
  }
}

const BOARD_ORDER: readonly ProductBoardKind[] = [
  'interaction',
  'orchestration',
  'inspection',
  'execution',
  'memory',
];

const TERMINAL_INTERACTION_STATES: ReadonlySet<string> = new Set([
  'confirmed',
  'dispatched',
  'answered',
  'status-only',
  'rejected',
]);

const LIVE_INTERACTION_STATES: ReadonlySet<string> = new Set([
  'received',
  'matching',
  'status-checking',
  'awaiting-intent',
  'awaiting-clarification',
  'awaiting-confirmation',
]);

type LiveItem = Extract<ProductBoardItem, { readonly lane: 'live' }>;
type HistoryItem = Extract<ProductBoardItem, { readonly lane: 'history' }>;
type UnknownItem = Extract<ProductBoardItem, { readonly lane: 'unknown' }>;

interface BoardDraft {
  readonly board: ProductBoardKind;
  readonly live: LiveItem[];
  readonly history: HistoryItem[];
  readonly unknown: UnknownItem[];
  readonly failures: RuntimeReadFailure[];
}

interface TaskRowItemFact {
  readonly row: RuntimeTaskRowProjection;
  readonly lane: 'live' | 'history' | 'unknown';
  readonly unknownReason?: string;
}

function failure(code: string, message: string, nextAction: string): RuntimeReadFailure {
  return { code, ownerId: OWNER_ID, message, nextAction };
}

function boardDraft(board: ProductBoardKind): BoardDraft {
  return { board, live: [], history: [], unknown: [], failures: [] };
}

function hasTarget(draft: BoardDraft, ref: ProductTargetRef): boolean {
  return [...draft.live, ...draft.history, ...draft.unknown]
    .some((item) => sameProductTargetRef(item.ref, ref));
}

function pushItem(draft: BoardDraft, item: ProductBoardItem): void {
  if (hasTarget(draft, item.ref)) {
    draft.failures.push(failure(
      'product-board.duplicate-target',
      `the ${draft.board} board received the same exact target more than once`,
      'fix the owning reader before composing the board',
    ));
    return;
  }
  if (item.lane === 'live') draft.live.push(item);
  else if (item.lane === 'history') draft.history.push(item);
  else draft.unknown.push(item);
}

function toSection(draft: BoardDraft): ProductBoardSection {
  return {
    board: draft.board,
    live: draft.live,
    history: draft.history,
    unknown: draft.unknown,
    ...(draft.failures.length === 0 ? {} : { failures: draft.failures }),
  };
}

function taskScope(
  selection: ProductReadSelection,
  taskId: TaskId,
): Extract<ProductReadScope, { readonly kind: 'task' }> {
  return {
    kind: 'task',
    projectKey: selection.projectKey,
    mode: selection.mode,
    taskId,
  };
}

function scopeMatchesSelection(
  scope: ProductReadScope,
  selection: ProductReadSelection,
  taskId: TaskId,
): boolean {
  if (scope.kind === 'system') return false;
  if (scope.projectKey !== selection.projectKey) return false;
  if (scope.kind === 'project') return selection.taskId === undefined;
  if (scope.mode !== selection.mode) return false;
  if (scope.taskId.value !== taskId.value) return false;
  return selection.taskId === undefined || selection.taskId.value === taskId.value;
}

function targetMatchesSelection(ref: ProductTargetRef, selection: ProductReadSelection): boolean {
  const scope = ref.scope;
  if (scope.kind === 'system') return false;
  if (scope.projectKey !== selection.projectKey) return false;
  if (scope.kind === 'project') return selection.taskId === undefined;
  if (scope.mode !== selection.mode) return false;
  return selection.taskId === undefined || scope.taskId.value === selection.taskId.value;
}

function livenessFor(
  facts: readonly ProductTaskLivenessFact[] | undefined,
  taskId: TaskId,
): RuntimeLivenessProjection | undefined {
  return facts?.find((fact) => fact.taskId.value === taskId.value)?.liveness;
}

function classifyTaskRow(row: RuntimeTaskRowProjection): Pick<TaskRowItemFact, 'lane' | 'unknownReason'> {
  if (row.state === 'unknown') {
    return { lane: 'unknown', unknownReason: 'the task list reported the task state as unknown' };
  }
  if (row.state === 'stale') {
    return { lane: 'unknown', unknownReason: 'the task list reported the task state as stale' };
  }
  if (row.state === 'succeeded' || row.state === 'stopped'
    || row.state === 'failed' || row.state === 'cancelled') {
    return { lane: 'history' };
  }
  // running, settling, waiting, blocked, created and admitted are current,
  // unresolved work in the owner's own list groups. The display state keeps the
  // exact lifecycle name; the lane never claims more than "not terminal".
  return { lane: 'live' };
}

function taskRowFacts(
  taskList: RuntimeTaskListProjection,
  selection: ProductReadSelection,
): { readonly facts: readonly TaskRowItemFact[]; readonly failures: readonly RuntimeReadFailure[] } {
  const failures: RuntimeReadFailure[] = [];
  const orderedRows = [
    ...taskList.running,
    ...taskList.waiting,
    ...taskList.completed,
    ...taskList.stopped,
    ...taskList.failed,
    ...taskList.draft,
  ];
  const seen = new Set<string>();
  const facts: TaskRowItemFact[] = [];
  for (const row of orderedRows) {
    if (selection.taskId !== undefined && row.taskId.value !== selection.taskId.value) continue;
    if (seen.has(row.taskId.value)) {
      failures.push(failure(
        'task-list.duplicate-task',
        `the task list reported task ${row.taskId.value} more than once`,
        'fix the task list projection before composing boards',
      ));
      continue;
    }
    seen.add(row.taskId.value);
    facts.push({ row, ...classifyTaskRow(row) });
  }
  return { facts, failures };
}

function taskRowItem(
  fact: TaskRowItemFact,
  selection: ProductReadSelection,
  livenessFacts: readonly ProductTaskLivenessFact[] | undefined,
): ProductBoardItem {
  const ref: ProductTargetRef = {
    kind: 'interaction',
    taskRef: fact.row.taskId,
    scope: taskScope(selection, fact.row.taskId),
  };
  const liveness = livenessFor(livenessFacts, fact.row.taskId);
  const common = {
    ref,
    title: fact.row.semanticTitle ?? fact.row.title,
    displayState: fact.row.stateLabel,
    ...(liveness === undefined ? {} : { liveness }),
    evidenceRefs: [] as readonly EvidenceRef[],
  };
  if (fact.lane === 'live') return { lane: 'live', ...common };
  if (fact.lane === 'history') return { lane: 'history', ...common };
  return {
    lane: 'unknown',
    ...common,
    unknownReason: fact.unknownReason ?? 'the task list did not classify this row',
  };
}

function interactionLane(state: string): Pick<TaskRowItemFact, 'lane' | 'unknownReason'> {
  if (TERMINAL_INTERACTION_STATES.has(state)) return { lane: 'history' };
  if (LIVE_INTERACTION_STATES.has(state)) return { lane: 'live' };
  return {
    lane: 'unknown',
    unknownReason: `the explicit intake state ${state} has no declared lane classification`,
  };
}

function interactionTargetRef(
  fact: ProductInteractionFact,
  selection: ProductReadSelection,
): ProductTargetRef {
  if (fact.taskRef !== undefined) {
    return { kind: 'interaction', taskRef: fact.taskRef, scope: taskScope(selection, fact.taskRef) };
  }
  return {
    kind: 'session',
    sessionRef: { sourceKind: 'explicit-intake', sourceRef: fact.interactionId },
    scope: productSelectionScope(selection),
  };
}

function interactionItem(
  fact: ProductInteractionFact,
  selection: ProductReadSelection,
): ProductBoardItem {
  const ref = interactionTargetRef(fact, selection);
  const common = {
    ref,
    title: fact.title ?? fact.rawInput,
    displayState: fact.state,
    evidenceRefs: fact.evidenceRefs ?? [],
  };
  const lane = interactionLane(fact.state);
  if (lane.lane === 'live') return { lane: 'live', ...common };
  if (lane.lane === 'history') return { lane: 'history', ...common };
  return { lane: 'unknown', ...common, unknownReason: lane.unknownReason ?? 'unknown interaction state' };
}

function executionInstanceIdentity(
  entry: RuntimeAgentActivityEntryProjection,
): TaskExecutionInstanceIdentity {
  if (entry.instance.kind === 'native-execution') {
    return {
      kind: 'native-execution',
      execution: {
        runtimeId: entry.instance.runtimeId,
        executionEpoch: entry.instance.executionEpoch,
      },
    };
  }
  // The UI projection flattens the same fields the owner keeps in
  // `TaskRuntimeIncarnation`; entry.assignmentId and entry.taskId complete it.
  return {
    kind: 'incarnation',
    incarnation: {
      runtimeId: entry.instance.runtimeId,
      generation: entry.instance.generation,
      agentInstanceId: entry.instance.agentInstanceId,
      roleId: entry.instance.roleId,
      taskId: entry.taskId,
      assignmentId: entry.assignmentId,
      executionEpoch: entry.instance.executionEpoch,
    },
  };
}

function executionItem(
  entry: RuntimeAgentActivityEntryProjection,
  selection: ProductReadSelection,
): ProductBoardItem {
  const ref: ProductTargetRef = {
    kind: 'execution-instance',
    instance: executionInstanceIdentity(entry),
    taskRef: entry.taskId,
    scope: taskScope(selection, entry.taskId),
  };
  const common = {
    ref,
    title: entry.objective ?? entry.sourceKindLabel,
    displayState: entry.currencyLabel,
    evidenceRefs: entry.evidenceRefs,
  };
  if (entry.currency === 'current') return { lane: 'live', ...common };
  if (entry.currency === 'historical') return { lane: 'history', ...common };
  return {
    lane: 'unknown',
    ...common,
    unknownReason: entry.missingSource ?? 'the activity owner reported unknown currency',
  };
}

function addActivity(
  projection: RuntimeAgentActivityProjection,
  execution: BoardDraft,
  orchestration: BoardDraft,
  selection: ProductReadSelection,
): void {
  const declaredScope = projection.scope;
  if (declaredScope !== undefined
    && !scopeMatchesSelection(declaredScope, selection, projection.taskId)) {
    execution.failures.push(failure(
      'agent-activity.scope-mismatch',
      `the activity read for task ${projection.taskId.value} is outside the selected project/mode/task scope`,
      're-read the activity with the exact selected scope',
    ));
    return;
  }
  if (selection.taskId !== undefined && projection.taskId.value !== selection.taskId.value) {
    execution.failures.push(failure(
      'agent-activity.task-mismatch',
      `the activity read for task ${projection.taskId.value} is outside the selected task`,
      're-read the activity with the exact selected task',
    ));
    return;
  }
  for (const entry of [...projection.current, ...projection.historical, ...projection.unknown]) {
    if (entry.taskId.value !== projection.taskId.value) {
      execution.failures.push(failure(
        'agent-activity.entry-task-mismatch',
        `an activity entry for task ${entry.taskId.value} was mounted on task ${projection.taskId.value}`,
        'fix the activity projection before composing the board',
      ));
      continue;
    }
    if (entry.executionEpoch !== entry.instance.executionEpoch) {
      execution.failures.push(failure(
        'agent-activity.epoch-mismatch',
        `an activity entry for task ${entry.taskId.value} has a mismatched execution epoch`,
        'fix the activity projection before composing the board',
      ));
      continue;
    }
    const item = executionItem(entry, selection);
    if (entry.sourceKind === 'closed-turn-planner-call') pushItem(orchestration, item);
    else pushItem(execution, item);
  }
}

function inspectionDisplayState(record: InspectionOccurrenceRecord): string {
  if (record.results.some((result) => result.state === 'failed')) return 'failed';
  if (record.results.length > 0 && record.results.every((result) => result.state === 'completed')) {
    return 'completed';
  }
  return 'recorded';
}

/**
 * Display state for the projection-derived inspection fact. The occurrence
 * `outcome` is the owner's authoritative settlement result; before settlement
 * the item outcomes carry the only observed facts. A failed item stays failed
 * even though an inspection "negative result" is still a completed check.
 */
export function inspectionDisplayStateFromProjection(
  occurrence: RuntimeInspectionOccurrenceProjection,
): string {
  if (occurrence.items.some((item) => item.outcome === 'failed')) return 'failed';
  if (occurrence.outcome === 'completed') return 'completed';
  if (occurrence.outcome === 'failed') return 'failed';
  if (occurrence.outcome === 'blocked') return 'blocked';
  if (occurrence.outcome === 'cancelled') return 'cancelled';
  if (occurrence.outcome === 'pending') return 'open';
  return 'unknown';
}

/**
 * Projection-to-display-fact adapter. It keeps the real `openedAt` and the
 * exact occurrence/definition identity without a fabricated definition body.
 */
export function inspectionDisplayFactFromProjection(
  occurrence: RuntimeInspectionOccurrenceProjection,
  taskId: TaskId,
): ProductInspectionDisplayFact {
  return {
    kind: 'inspection-display',
    occurrenceId: occurrence.occurrenceId,
    definitionId: occurrence.definitionId,
    taskId,
    displayState: inspectionDisplayStateFromProjection(occurrence),
    openedAt: occurrence.openedAt,
    evidenceRefs: occurrence.evidenceRefs,
  };
}

function inspectionItem(
  record: InspectionOccurrenceRecord,
  selection: ProductReadSelection,
): ProductBoardItem {
  const taskId = record.occurrence.scope.taskId;
  return {
    lane: 'history',
    ref: {
      kind: 'session',
      sessionRef: { sourceKind: 'inspection-occurrence', sourceRef: record.occurrence.occurrenceId },
      taskRef: taskId,
      scope: taskScope(selection, taskId),
    },
    title: record.definition.definitionId,
    displayState: inspectionDisplayState(record),
    evidenceRefs: record.evidenceRefs,
  };
}

function inspectionDisplayFactItem(
  fact: ProductInspectionDisplayFact,
  selection: ProductReadSelection,
): ProductBoardItem {
  return {
    lane: 'history',
    ref: {
      kind: 'session',
      sessionRef: { sourceKind: 'inspection-occurrence', sourceRef: fact.occurrenceId },
      taskRef: fact.taskId,
      scope: taskScope(selection, fact.taskId),
    },
    title: fact.definitionId,
    displayState: fact.displayState,
    evidenceRefs: fact.evidenceRefs,
  };
}

function isInspectionDisplayFact(
  fact: ProductInspectionFact,
): fact is ProductInspectionDisplayFact {
  return (fact as ProductInspectionDisplayFact).kind === 'inspection-display';
}

function memorySessionItem(
  fact: ProductMemorySessionFact,
  selection: ProductReadSelection,
): ProductBoardItem {
  const ref: ProductTargetRef = {
    kind: 'session',
    sessionRef: fact.sessionRef,
    ...(fact.taskRef === undefined ? {} : { taskRef: fact.taskRef }),
    scope: fact.taskRef === undefined ? productSelectionScope(selection) : taskScope(selection, fact.taskRef),
  };
  const common = {
    ref,
    title: fact.title,
    displayState: fact.displayState,
    evidenceRefs: fact.evidenceRefs,
  };
  if (fact.currency === 'current') return { lane: 'live', ...common };
  if (fact.currency === 'historical') return { lane: 'history', ...common };
  return {
    lane: 'unknown',
    ...common,
    unknownReason: fact.unknownReason ?? 'the memory session owner reported unknown currency',
  };
}

function addMemory(
  memory: BoardDraft,
  input: ProductBoardComposeInput,
): void {
  if (input.memorySessions?.ok === true) {
    for (const fact of input.memorySessions.value) {
      if (input.selection.taskId !== undefined && fact.taskRef !== undefined
        && fact.taskRef.value !== input.selection.taskId.value) {
        memory.failures.push(failure(
          'memory.session-scope-mismatch',
          `memory session ${fact.sessionRef.sourceRef} belongs to another task`,
          're-read the memory session with the selected task',
        ));
        continue;
      }
      pushItem(memory, memorySessionItem(fact, input.selection));
    }
    return;
  }
  if (input.memorySessions !== undefined && !input.memorySessions.ok) {
    memory.failures.push(input.memorySessions.failure);
  } else {
    memory.failures.push(failure(
      'memory.session-source-unavailable',
      'no declared memory-agent session reader exists; memory review candidates are not sessions',
      'bind a real memory session reader before enumerating the memory board',
    ));
  }
  if (input.memory?.ok === true && input.memory.value.candidateCount > 0) {
    memory.failures.push(failure(
      'memory.candidates-are-not-sessions',
      `the memory review read reported ${input.memory.value.candidateCount} candidates; candidate records are not memory-agent sessions`,
      'keep candidates in the memory review surface and read sessions from their own owner',
    ));
  }
}

export function composeProductBoardIndex(input: ProductBoardComposeInput): ProductBoardIndex {
  const drafts = new Map<ProductBoardKind, BoardDraft>(
    BOARD_ORDER.map((board) => [board, boardDraft(board)]),
  );
  const interaction = drafts.get('interaction')!;
  const orchestration = drafts.get('orchestration')!;
  const inspection = drafts.get('inspection')!;
  const execution = drafts.get('execution')!;
  const memory = drafts.get('memory')!;

  if (input.taskList === undefined) {
    const readFailure = failure(
      'task-list.source-unavailable',
      'the task list reader was not supplied, so orchestration and inspection task rows are unavailable',
      'read the task list before composing the board',
    );
    orchestration.failures.push(readFailure);
    inspection.failures.push(readFailure);
  } else if (!input.taskList.ok) {
    orchestration.failures.push(input.taskList.failure);
    inspection.failures.push(input.taskList.failure);
  } else if (input.taskList.value.mode !== input.selection.mode) {
    const readFailure = failure(
      'task-list.mode-mismatch',
      `the task list mode ${input.taskList.value.mode} does not match the selected mode ${input.selection.mode}`,
      'read the task list for the exact selected mode',
    );
    orchestration.failures.push(readFailure);
    inspection.failures.push(readFailure);
  } else {
    const rows = taskRowFacts(input.taskList.value, input.selection);
    orchestration.failures.push(...rows.failures);
    for (const fact of rows.facts) {
      const item = taskRowItem(fact, input.selection, input.liveness);
      if (fact.row.taskFlow?.kind === 'inspection') pushItem(inspection, item);
      else pushItem(orchestration, item);
    }
  }

  if (input.agentActivity === undefined) {
    execution.failures.push(failure(
      'agent-activity.source-unavailable',
      'the per-task agent activity reader was not supplied',
      'read agent activity for the selected tasks before composing the board',
    ));
  } else {
    for (const read of input.agentActivity) {
      if (!read.ok) execution.failures.push(read.failure);
      else addActivity(read.value, execution, orchestration, input.selection);
    }
  }

  if (input.interactions === undefined) {
    interaction.failures.push(failure(
      'interaction.source-unavailable',
      'no explicit intake list reader is bound',
      'bind the explicit interaction list reader before claiming interaction board items',
    ));
  } else if (!input.interactions.ok) {
    interaction.failures.push(input.interactions.failure);
  } else {
    for (const fact of input.interactions.value) {
      if (input.selection.taskId !== undefined && fact.taskRef === undefined) {
        // An interaction without a recorded task owner belongs to the project
        // overview only. Do not mount it on whichever task is selected.
        continue;
      }
      if (input.selection.taskId !== undefined
        && fact.taskRef?.value !== input.selection.taskId.value) {
        interaction.failures.push(failure(
          'interaction.scope-mismatch',
          `interaction ${fact.interactionId} belongs to another task`,
          're-read interactions with the selected task',
        ));
        continue;
      }
      pushItem(interaction, interactionItem(fact, input.selection));
    }
  }

  if (input.inspections === undefined) {
    inspection.failures.push(failure(
      'inspection.occurrence-source-unavailable',
      'the inspection occurrence history reader was not supplied',
      'read inspection occurrences before claiming inspection history',
    ));
  } else if (!input.inspections.ok) {
    inspection.failures.push(input.inspections.failure);
  } else {
    for (const fact of input.inspections.value) {
      const display = isInspectionDisplayFact(fact);
      const taskId = display ? fact.taskId : fact.occurrence.scope.taskId;
      const occurrenceId = display ? fact.occurrenceId : fact.occurrence.occurrenceId;
      if (input.selection.taskId !== undefined
        && taskId.value !== input.selection.taskId.value) {
        inspection.failures.push(failure(
          'inspection.scope-mismatch',
          `inspection occurrence ${occurrenceId} belongs to another task`,
          're-read inspection occurrences with the selected task',
        ));
        continue;
      }
      if (display) {
        pushItem(inspection, inspectionDisplayFactItem(fact, input.selection));
      } else {
        pushItem(inspection, inspectionItem(fact, input.selection));
      }
    }
  }

  addMemory(memory, input);

  const index: ProductBoardIndex = {
    scope: productSelectionScope(input.selection),
    observedAt: input.observedAt,
    boards: BOARD_ORDER.map((board) => toSection(drafts.get(board)!)),
  };
  validateProductBoardIndex(index);
  return index;
}

function interactionMessage(
  fact: ProductInteractionFact,
  selection: ProductReadSelection,
  organId: OrganId,
): ProductMessage | undefined {
  if (selection.taskId !== undefined
    && fact.taskRef?.value !== selection.taskId.value) {
    return undefined;
  }
  const taskId = fact.taskRef;
  return {
    ref: {
      eventId: fact.interactionId,
      sourceId: 'explicit-intake',
      scope: { organId, ...(taskId === undefined ? {} : { taskId }) },
    },
    targetRef: interactionTargetRef(fact, selection),
    // O1: the interaction owner persists no principal. Keeping the source
    // reference while the actor stays unknown is the truthful read.
    actor: { kind: 'unknown', sourceKind: 'explicit-intake', sourceRef: fact.interactionId },
    ...(fact.occurredAt === undefined
      ? { occurredAtUnavailableReason: 'the explicit intake owner did not persist an event time' }
      : { occurredAt: fact.occurredAt }),
    text: fact.rawInput,
    evidenceRefs: fact.evidenceRefs ?? [],
  };
}

function taskEventMessage(
  fact: ProductTaskEventFact,
  event: RuntimeTaskEventProjection,
  selection: ProductReadSelection,
  organId: OrganId,
): ProductMessage | undefined {
  if (selection.taskId !== undefined && fact.taskId.value !== selection.taskId.value) return undefined;
  const expectedScope = taskScope(selection, fact.taskId);
  if (fact.scope !== undefined
    && (fact.scope.projectKey !== expectedScope.projectKey
      || fact.scope.mode !== expectedScope.mode
      || fact.scope.taskId.value !== expectedScope.taskId.value)) {
    return undefined;
  }
  return {
    ref: {
      eventId: String(event.seq),
      sourceId: 'runtime-task-event',
      scope: { organId, taskId: fact.taskId },
    },
    targetRef: { kind: 'interaction', taskRef: fact.taskId, scope: expectedScope },
    actor: { kind: 'unknown', sourceKind: 'runtime-task-event', sourceRef: event.kind },
    occurredAt: event.occurredAt,
    text: event.summary,
    evidenceRefs: event.evidenceRefs,
  };
}

function passThroughMessage(
  fact: ProductMessageFact,
  selection: ProductReadSelection,
  organId: OrganId,
): ProductMessage | undefined {
  if (fact.ref.scope.organId.value !== organId.value) return undefined;
  if (fact.ref.scope.taskId !== undefined && selection.taskId !== undefined
    && fact.ref.scope.taskId.value !== selection.taskId.value) {
    return undefined;
  }
  if (!targetMatchesSelection(fact.targetRef, selection)) return undefined;
  if (fact.occurredAt === undefined && fact.occurredAtUnavailableReason === undefined) {
    return { ...fact, occurredAtUnavailableReason: 'the owner did not persist an event time' };
  }
  if (fact.occurredAt !== undefined && fact.occurredAtUnavailableReason !== undefined) {
    throw new ProductSessionReadError(
      'a message fact carries both an event time and an unavailable reason',
      failure(
        'message.invalid-time',
        'a message fact carries both an event time and an unavailable reason',
        'fix the owning reader so it reports exactly one time fact',
      ),
    );
  }
  return fact;
}

export function composeProductSessionMessages(
  input: ProductSessionComposeInput,
): readonly ProductMessage[] {
  if (input.interactions !== undefined && !input.interactions.ok) {
    throw new ProductSessionReadError(
      'the explicit interaction read failed, so no interaction messages can be composed',
      input.interactions.failure,
    );
  }
  const messages: ProductMessage[] = [];
  for (const fact of input.interactions?.ok === true ? input.interactions.value : []) {
    const message = interactionMessage(fact, input.selection, input.organId);
    if (message !== undefined) messages.push(message);
  }
  for (const fact of input.taskEvents ?? []) {
    for (const event of fact.events) {
      const message = taskEventMessage(fact, event, input.selection, input.organId);
      if (message !== undefined) messages.push(message);
    }
  }
  for (const fact of input.messages ?? []) {
    const message = passThroughMessage(fact, input.selection, input.organId);
    if (message !== undefined) messages.push(message);
  }
  for (const message of messages) validateProductMessage(message);
  return messages;
}

export function composeProductSessionRead(input: ProductSessionReadInput): ProductSessionRead {
  const boardIndex = composeProductBoardIndex(input);
  if (input.interactions !== undefined && !input.interactions.ok) {
    // The board keeps the interaction read failure. The remaining message
    // sources still compose without pretending the failed read returned [].
    return {
      boardIndex,
      messages: composeProductSessionMessages({
        selection: input.selection,
        organId: input.organId,
        taskEvents: input.taskEvents,
        messages: input.messages,
      }),
    };
  }
  return {
    boardIndex,
    messages: composeProductSessionMessages({
      selection: input.selection,
      organId: input.organId,
      ...(input.interactions === undefined ? {} : { interactions: input.interactions }),
      ...(input.taskEvents === undefined ? {} : { taskEvents: input.taskEvents }),
      ...(input.messages === undefined ? {} : { messages: input.messages }),
    }),
  };
}

export function productBoardDashboard(
  index: ProductBoardIndex,
  board: ProductBoardKind,
): ProductBoardSection | undefined {
  return index.boards.find((section) => section.board === board);
}

/**
 * The single card collection for one board. It is derived from the same index
 * the dashboard section uses, so the two orderings cannot drift.
 */
export function productBoardCards(
  index: ProductBoardIndex,
  board: ProductBoardKind,
): readonly ProductBoardItem[] {
  const section = productBoardDashboard(index, board);
  if (section === undefined) {
    throw new ProductSessionReadError(
      `the board index has no ${board} section`,
      failure(
        'product-board.missing-section',
        `the board index has no ${board} section`,
        'compose the board index with the declared board order',
      ),
    );
  }
  return [...section.live, ...section.history, ...section.unknown];
}
