import type {
  ChildInvocationRecord,
  I2JournalPort,
  JournalCommitRef,
  MilestoneReviewResultRecord,
  ReviewAssignment,
  ScopeRef,
  TaskAgentActivitySelectionFailure,
  TaskAgentActivitySelectionQuery,
  TaskAgentActivityUnavailableSource,
  TaskExecutionInstanceIdentity,
  TaskId,
  TaskIdentityScope,
  WorkAssignment,
  WorkResult,
} from '../../../contracts/src/index.js';
import { validateTaskAgentActivitySelectionQuery } from '../../../contracts/src/agent-activity.js';
import { sameTaskExecutionInstanceIdentity } from '../../../contracts/src/index.js';
import { activeTurnSegmentCommitId } from '../../../contracts/src/active-turn-segments.js';
import type { ResumedTurnSegmentOpened } from '../../../contracts/src/active-turn-segments.js';
import type { JsonlOrganJournal, JournalRecord } from '../../../adapters/jsonl/src/index.js';
import {
  createJsonlActiveTurnSegmentJournal,
  decodeActiveTurnRecords,
  listTaskActiveTurnBindings,
} from '../../../adapters/jsonl/src/active-turn.js';
import {
  closureFromRecord,
  readCommittedNativeSegmentSource,
} from '../checkpoint-journal.js';
import {
  type DurableJournalReadResult,
} from './journal.js';
import {
  activeTurnCommitId,
  type ActiveTurnJournalRecord,
} from '../../../runtime/src/context/active-turn-journal.js';
import {
  selectTaskAgentActivity,
  type AgentActivityActiveSource,
  type AgentActivityChildSource,
  type AgentActivityCurrentAuthority,
  type AgentActivityCurrentLocation,
  type AgentActivityNativeSource,
  type AgentActivityPoolSource,
  type AgentActivityResumedSource,
  type AgentActivityReviewSource,
} from '../../../runtime/src/observation/agent-activity.js';
import type { AgentRuntimePoolManager } from '../../../runtime/src/orchestration/runtime-pool.js';
import type { RuntimeTaskSnapshot } from '../../../runtime/src/ui-runtime/coordinator.js';
import { projectRuntimeAgentActivity } from '../../../ui/projection/agent-activity.js';
import type {
  RuntimeAgentActivityProjection,
  RuntimeReadResult,
  RuntimeReadScope,
} from '../../../ui/contracts/runtime.js';

/**
 * App-owned F09 reader core. It decodes the browser selection syntax, reads the
 * first three durable activity sources, and delegates all classification and
 * projection to the Runtime selector and UI projection owners.
 *
 * The remaining three sources are required inputs here. This function does not
 * create a full-task catalog by silently substituting empty child / pool /
 * review facts.
 */
const OWNER_ID = 'humanagent.app.ui-runtime.agent-activity';

const QUERY_FIELDS = Object.freeze({
  kind: 'agentKind',
  runtimeId: 'agentRuntimeId',
  executionEpoch: 'agentExecutionEpoch',
  roleId: 'agentRoleId',
  generation: 'agentGeneration',
  agentInstanceId: 'agentInstanceId',
  assignmentId: 'agentAssignmentId',
  attempt: 'agentAttempt',
  businessTurnId: 'agentBusinessTurnId',
  segmentId: 'agentSegmentId',
  nodeId: 'agentNodeId',
});

type QueryField = keyof typeof QUERY_FIELDS;

const DETAIL_FIELDS: readonly QueryField[] = [
  'assignmentId',
  'attempt',
  'businessTurnId',
  'segmentId',
  'nodeId',
];
const NUMBERS: readonly QueryField[] = ['executionEpoch', 'generation', 'attempt'];
const DECLARED_KEYS: ReadonlySet<string> = new Set(Object.values(QUERY_FIELDS));

export interface AgentActivitySelectionQueryParams {
  getAll(key: string): readonly string[];
  keys(): Iterable<string>;
}

export type DecodedTaskAgentActivitySelectionQuery =
  | { readonly ok: true; readonly value: TaskAgentActivitySelectionQuery }
  | { readonly ok: false; readonly failure: TaskAgentActivitySelectionFailure };

function selectionFailure(message: string): DecodedTaskAgentActivitySelectionQuery {
  return {
    ok: false,
    failure: {
      code: 'agent-activity.invalid-selection',
      ownerId: OWNER_ID,
      message,
      nextAction: '重新选择完整的运行实例，或返回任务实例列表。',
    },
  };
}

function finishSelection(
  value: TaskAgentActivitySelectionQuery,
  taskId: TaskId,
): DecodedTaskAgentActivitySelectionQuery {
  try {
    return { ok: true, value: validateTaskAgentActivitySelectionQuery(value, taskId) };
  } catch (error) {
    return selectionFailure(error instanceof Error ? error.message : String(error));
  }
}

function numberValue(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Decode only the documented `agent*` view parameters. `taskId` is always the
 * canonical caller scope; it is never taken from an untrusted URL parameter.
 */
export function decodeTaskAgentActivitySelectionQuery(
  params: AgentActivitySelectionQueryParams,
  taskId: TaskId,
): DecodedTaskAgentActivitySelectionQuery {
  for (const key of params.keys()) {
    if (key.startsWith('agent') && !DECLARED_KEYS.has(key)) {
      return selectionFailure(`未知的实例选择参数：${key}`);
    }
  }

  const fields: Partial<Record<QueryField, string | number>> = {};
  for (const [field, key] of Object.entries(QUERY_FIELDS) as readonly [QueryField, string][]) {
    const values = params.getAll(key);
    if (values.length > 1) return selectionFailure(`实例选择参数重复：${key}`);
    if (values.length === 0) continue;
    const value = values[0];
    if (!value.trim()) return selectionFailure(`实例选择参数为空：${key}`);
    if (NUMBERS.includes(field)) {
      const parsed = numberValue(value);
      if (parsed === undefined) return selectionFailure(`实例选择数字无效：${key}`);
      fields[field] = parsed;
    } else {
      fields[field] = value;
    }
  }

  if (Object.keys(fields).length === 0) {
    const value: TaskAgentActivitySelectionQuery = { taskId };
    return finishSelection(value, taskId);
  }

  const kind = fields.kind;
  if (kind !== 'native-execution' && kind !== 'incarnation') {
    return selectionFailure('实例选择缺少有效的身份类型。');
  }

  const runtimeId = fields.runtimeId;
  const executionEpoch = fields.executionEpoch;
  if (typeof runtimeId !== 'string' || typeof executionEpoch !== 'number') {
    return selectionFailure('实例身份不完整。');
  }

  if (kind === 'native-execution') {
    if (fields.roleId !== undefined || fields.generation !== undefined || fields.agentInstanceId !== undefined) {
      return selectionFailure('原生执行选择包含了运行实例身份。');
    }
    const value: TaskAgentActivitySelectionQuery = {
      taskId,
      instance: { kind, execution: { runtimeId, executionEpoch } },
      ...detailFields(fields),
    };
    return finishSelection(value, taskId);
  }

  const roleId = fields.roleId;
  const generation = fields.generation;
  const agentInstanceId = fields.agentInstanceId;
  const assignmentId = fields.assignmentId;
  if (
    typeof roleId !== 'string'
    || typeof generation !== 'number'
    || typeof agentInstanceId !== 'string'
    || typeof assignmentId !== 'string'
  ) {
    return selectionFailure('实例身份不完整。');
  }
  const value: TaskAgentActivitySelectionQuery = {
    taskId,
    instance: {
      kind,
      incarnation: {
        runtimeId,
        executionEpoch,
        roleId,
        generation,
        agentInstanceId,
        taskId,
        assignmentId,
      },
    },
    ...detailFields(fields),
  };
  return finishSelection(value, taskId);
}

function detailFields(
  fields: Partial<Record<QueryField, string | number>>,
): Pick<
  TaskAgentActivitySelectionQuery,
  'assignmentId' | 'attempt' | 'businessTurnId' | 'segmentId' | 'nodeId'
> {
  const detail: {
    assignmentId?: string;
    attempt?: number;
    businessTurnId?: string;
    segmentId?: string;
    nodeId?: string;
  } = {};
  for (const field of DETAIL_FIELDS) {
    const value = fields[field];
    if (value === undefined) continue;
    if (field === 'attempt') detail.attempt = value as number;
    else if (field === 'assignmentId') detail.assignmentId = value as string;
    else if (field === 'businessTurnId') detail.businessTurnId = value as string;
    else if (field === 'segmentId') detail.segmentId = value as string;
    else if (field === 'nodeId') detail.nodeId = value as string;
  }
  return detail;
}

export interface TaskAgentActivityCoreSources {
  readonly nativeAllocations: readonly AgentActivityNativeSource[];
  readonly activeTurns: readonly AgentActivityActiveSource[];
  readonly resumedSegments: readonly AgentActivityResumedSource[];
  readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
}

export interface TaskAgentActivityRemainingSources {
  readonly childInvocations: readonly AgentActivityChildSource[];
  readonly runtimePoolLeases: readonly AgentActivityPoolSource[];
  readonly milestoneReviews: readonly AgentActivityReviewSource[];
}

export interface AgentActivityCoreReadFailure {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
}

export type TaskAgentActivityCoreAssembly =
  | { readonly ok: true; readonly value: TaskAgentActivityCoreSources }
  | { readonly ok: false; readonly failure: AgentActivityCoreReadFailure };

export interface AssembleTaskAgentActivityCoreSourcesOptions {
  readonly taskId: TaskId;
  readonly taskJournal: DurableJournalReadResult;
  readonly controlJournal: JsonlOrganJournal;
}

interface AssembledTaskAgentActivityCoreContext {
  readonly sources: TaskAgentActivityCoreSources;
  readonly taskScope: TaskIdentityScope;
  readonly controlRecords: readonly JournalRecord[];
}

type TaskAgentActivityCoreContextAssembly =
  | { readonly ok: true; readonly value: AssembledTaskAgentActivityCoreContext }
  | { readonly ok: false; readonly failure: AgentActivityCoreReadFailure };

function readFailure(
  code: string,
  message: string,
  nextAction: string,
): { readonly ok: false; readonly failure: AgentActivityCoreReadFailure } {
  return { ok: false, failure: { code, ownerId: OWNER_ID, message, nextAction } };
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

function journalCommitRef(record: { commitId?: string; seq: number; recordDigest: string }): JournalCommitRef | null {
  if (record.commitId === undefined) return null;
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

/**
 * Exact directive revision only. A later `task.updated` must never rewrite the
 * objective of an older allocation, so there is deliberately no last-wins rule.
 */
function directiveAtRevision(
  taskJournal: DurableJournalReadResult['records'],
  taskId: TaskId,
  directiveRevision: number,
): string | undefined {
  for (const record of taskJournal) {
    if (record.kind !== 'task.created' && record.kind !== 'task.updated') continue;
    if (record.taskId.value !== taskId.value) continue;
    if (record.directiveRevision !== directiveRevision) continue;
    const directive = record.directive.trim();
    if (directive) return directive;
  }
  return undefined;
}

function matchingAllocationBinding(
  bindings: Awaited<ReturnType<typeof listTaskActiveTurnBindings>>,
  allocation: AgentActivityNativeSource['allocation'],
): Awaited<ReturnType<typeof listTaskActiveTurnBindings>>[number] | undefined {
  return bindings.find((entry) =>
    entry.binding.assignment.taskId.value === allocation.taskId.value
    && entry.binding.assignment.assignmentId === allocation.assignmentId
    && entry.binding.execution.executionEpoch === allocation.executionEpoch
    && entry.binding.scope.operationId?.value === allocation.operationId.value);
}

/**
 * Objective priority from the accepted plan: a real binding assignment for the
 * same operation/assignment/epoch, then the exact `directiveRevision`, then the
 * prepared input. No match means the source is missing, never last-wins.
 */
function nativeObjective(input: {
  readonly allocation: AgentActivityNativeSource['allocation'];
  readonly binding: AgentActivityActiveSource['binding'] | undefined;
  readonly preparedInput: string;
  readonly taskJournal: DurableJournalReadResult['records'];
}): string | undefined {
  const fromBinding = input.binding?.assignment.objective.trim();
  if (fromBinding) return fromBinding;
  const fromDirective = directiveAtRevision(
    input.taskJournal,
    input.allocation.taskId,
    input.allocation.directiveRevision,
  );
  if (fromDirective !== undefined) return fromDirective;
  const fromInput = input.preparedInput.trim();
  if (fromInput) return fromInput;
  return undefined;
}

function organIdForTask(
  taskJournal: DurableJournalReadResult['records'],
  controlRecords: readonly { readonly scope: ScopeRef }[],
  taskId: TaskId,
): TaskIdentityScope['organId'] | undefined {
  for (const record of taskJournal) {
    if (record.kind !== 'operation.prepared' || record.allocation.taskId.value !== taskId.value) continue;
    return record.allocation.scope.organId;
  }
  for (const record of controlRecords) {
    if (record.scope.taskId?.value === taskId.value) return record.scope.organId;
  }
  return undefined;
}

function terminalCommitRefs(
  controlRecords: readonly JournalRecord[],
  businessTurnId: string,
  assignmentId: string,
  scope: ScopeRef,
  afterJournalSeq: number,
): JournalCommitRef[] {
  const refs: JournalCommitRef[] = [];
  for (const record of controlRecords) {
    const ref = journalCommitRef(record);
    if (ref === null || ref.journalSeq <= afterJournalSeq) continue;
    const closure = closureFromRecord(record);
    if (closure === null || !('closureKind' in closure) || closure.closureKind !== 'turn-closure') continue;
    // The canonical terminal fact is the business turn closure. It keeps the
    // original business-turn epoch, so a resumed segment's physical epoch must
    // never be used to match it.
    if (closure.identity.turnId !== businessTurnId
      || closure.identity.workAssignmentRef !== assignmentId
      || !sameScope(closure.identity.scopeRef, scope)) continue;
    refs.push(ref);
  }
  return refs;
}

async function assembleTaskAgentActivityCoreContext(
  options: AssembleTaskAgentActivityCoreSourcesOptions,
): Promise<TaskAgentActivityCoreContextAssembly> {
  if (options.taskJournal.failure !== undefined) {
    return readFailure(
      'agent-activity.task-journal-unavailable',
      options.taskJournal.failure.message,
      options.taskJournal.failure.nextAction,
    );
  }

  let controlRecords: Awaited<ReturnType<JsonlOrganJournal['replay']>>;
  try {
    controlRecords = await options.controlJournal.replay();
  } catch (error) {
    return readFailure(
      'agent-activity.control-journal-unavailable',
      error instanceof Error ? error.message : String(error),
      'inspect the control journal for this task before reading agent activity',
    );
  }

  const organId = organIdForTask(options.taskJournal.records, controlRecords, options.taskId);
  if (organId === undefined) {
    return readFailure(
      'agent-activity.organ-scope-missing',
      `no durable scope names organ for task ${options.taskId.value}`,
      'read the task execution allocation or control journal scope before assembling activity',
    );
  }
  const taskScope: TaskIdentityScope = { organId, taskId: options.taskId };

  const activeTurns: AgentActivityActiveSource[] = [];
  const resumedSegments: AgentActivityResumedSource[] = [];
  const unavailableSources: TaskAgentActivityUnavailableSource[] = [];
  let bindings: Awaited<ReturnType<typeof listTaskActiveTurnBindings>> = [];
  try {
    bindings = await listTaskActiveTurnBindings({ journal: options.controlJournal, scope: taskScope });
    for (const entry of bindings) {
      activeTurns.push({
        sourceId: `active-turn:${entry.binding.admittedTurn.turnId}`,
        ownerId: OWNER_ID,
        commitRefs: [],
        evidenceRefs: [],
        boundLive: undefined,
        terminalCommitRefs: terminalCommitRefs(
          controlRecords,
          entry.binding.admittedTurn.turnId,
          entry.binding.assignment.assignmentId,
          entry.binding.scope,
          entry.commitRef.journalSeq,
        ),
        binding: entry.binding,
        bindingCommitRef: entry.commitRef,
      });

      const businessTurnId = entry.binding.admittedTurn.turnId;
      const segmentJournal = createJsonlActiveTurnSegmentJournal({
        journal: options.controlJournal,
        businessTurnId,
      });
      const openedSegments = await segmentJournal.readSegments(businessTurnId);
      for (const opened of openedSegments) {
        const exact = await readCommittedNativeSegmentSource({
          journal: options.controlJournal,
          originalAdmittedTurn: entry.binding.admittedTurn,
          opened,
        });
        resumedSegments.push({
          sourceId: `resumed-segment:${exact.opened.segmentId}`,
          ownerId: OWNER_ID,
          commitRefs: [],
          evidenceRefs: [],
          boundLive: undefined,
          terminalCommitRefs: terminalCommitRefs(
            controlRecords,
            exact.opened.businessTurnRef.businessTurnId,
            exact.opened.binding.assignment.assignmentId,
            exact.opened.binding.scope,
            exact.openedCommitRef.journalSeq,
          ),
          opened: exact.opened,
          openedCommitRef: exact.openedCommitRef,
        });
      }
    }
  } catch (error) {
    return readFailure(
      'agent-activity.control-source-corrupt',
      error instanceof Error ? error.message : String(error),
      'preserve the control journal and repair the source before reading agent activity',
    );
  }

  const nativeAllocations: AgentActivityNativeSource[] = [];
  for (const record of options.taskJournal.records) {
    if (record.kind !== 'operation.prepared' || record.allocation.taskId.value !== options.taskId.value) continue;
    const allocation = record.allocation;
    const allocationBinding = matchingAllocationBinding(bindings, allocation);
    const objective = nativeObjective({
      allocation,
      binding: allocationBinding?.binding,
      preparedInput: record.input,
      taskJournal: options.taskJournal.records,
    });
    if (objective === undefined) {
      unavailableSources.push({
        sourceId: `native-allocation:${allocation.operationId.value}`,
        ownerId: OWNER_ID,
        message: 'native allocation has no provable objective from a binding, exact directive revision, or prepared input',
      });
      continue;
    }
    nativeAllocations.push({
      sourceId: `native-allocation:${allocation.operationId.value}`,
      ownerId: OWNER_ID,
      commitRefs: [],
      evidenceRefs: [],
      boundLive: undefined,
      terminalCommitRefs: terminalCommitRefs(
        controlRecords,
        allocationBinding?.binding.admittedTurn.turnId ?? '',
        allocation.assignmentId,
        allocation.scope,
        0,
      ),
      allocation,
      objective,
    });
  }

  return {
    ok: true,
    value: {
      sources: { nativeAllocations, activeTurns, resumedSegments, unavailableSources },
      taskScope,
      controlRecords,
    },
  };
}

export async function assembleTaskAgentActivityCoreSources(
  options: AssembleTaskAgentActivityCoreSourcesOptions,
): Promise<TaskAgentActivityCoreAssembly> {
  const assembled = await assembleTaskAgentActivityCoreContext(options);
  if (!assembled.ok) return assembled;
  return { ok: true, value: assembled.value.sources };
}

export interface ReadTaskAgentActivityCoreOptions {
  readonly taskId: TaskId;
  readonly query: TaskAgentActivitySelectionQuery;
  readonly taskJournal: DurableJournalReadResult;
  readonly controlJournal: JsonlOrganJournal;
  readonly currentAuthority?: AgentActivityCurrentAuthority;
  readonly remainingSources: TaskAgentActivityRemainingSources;
}

function projectionFailure(
  failure: AgentActivityCoreReadFailure,
): RuntimeReadResult<RuntimeAgentActivityProjection> {
  return { ok: false, failure: { ...failure } };
}

interface SelectAndProjectAgentActivityInput {
  readonly taskId: TaskId;
  readonly query: TaskAgentActivitySelectionQuery;
  readonly currentAuthority?: AgentActivityCurrentAuthority;
  readonly core: TaskAgentActivityCoreSources;
  readonly remainingSources: TaskAgentActivityRemainingSources;
  readonly unavailableSources?: readonly TaskAgentActivityUnavailableSource[];
  readonly scope?: RuntimeReadScope;
}

function selectAndProjectAgentActivity(
  input: SelectAndProjectAgentActivityInput,
): RuntimeReadResult<RuntimeAgentActivityProjection> {
  return projectRuntimeAgentActivity(selectTaskAgentActivity({
    taskId: input.taskId,
    query: input.query,
    ...(input.currentAuthority === undefined ? {} : { currentAuthority: input.currentAuthority }),
    nativeAllocations: input.core.nativeAllocations,
    activeTurns: input.core.activeTurns,
    resumedSegments: input.core.resumedSegments,
    childInvocations: input.remainingSources.childInvocations,
    runtimePoolLeases: input.remainingSources.runtimePoolLeases,
    milestoneReviews: input.remainingSources.milestoneReviews,
    unavailableSources: [
      ...input.core.unavailableSources,
      ...(input.unavailableSources ?? []),
    ],
  }), input.scope);
}

export async function readTaskAgentActivityCore(
  options: ReadTaskAgentActivityCoreOptions,
): Promise<RuntimeReadResult<RuntimeAgentActivityProjection>> {
  const assembled = await assembleTaskAgentActivityCoreContext(options);
  if (!assembled.ok) return projectionFailure(assembled.failure);

  return selectAndProjectAgentActivity({
    taskId: options.taskId,
    query: options.query,
    ...(options.currentAuthority === undefined ? {} : { currentAuthority: options.currentAuthority }),
    core: assembled.value.sources,
    remainingSources: options.remainingSources,
  });
}

/**
 * The objective of one child invocation from its own binding. An execution
 * child reads its real `WorkAssignment.objective`. A review child has no
 * objective on `ReviewAssignment`, so the reviewed target must come from a
 * real owned field or the source stays explicitly unavailable.
 */
function childObjective(record: ChildInvocationRecord, work: readonly ReturnedWork[] = []): string | undefined {
  if (record.binding.kind === 'review') return reviewedObjective(record.binding.assignment, work);
  const objective = record.binding.assignment.objective.trim();
  return objective.length > 0 ? objective : undefined;
}

/** Exact committed envelope of one child invocation, taken from its own carrier. */
function childInvocationEnvelope(
  records: readonly JournalRecord[],
  turnId: string,
  invocationId: string,
): JournalCommitRef | undefined {
  const expected = activeTurnCommitId(turnId, `invocation:${invocationId}`);
  const found = records.find((record) => record.commitId === expected);
  if (found === undefined || found.commitId === undefined) return undefined;
  return { commitId: found.commitId, journalSeq: found.seq, recordDigest: found.recordDigest };
}

/** Exact committed envelope of one segment child invocation. */
function segmentChildInvocationEnvelope(
  records: readonly JournalRecord[],
  segmentId: string,
  invocationId: string,
): JournalCommitRef | undefined {
  const expected = activeTurnSegmentCommitId(segmentId, `invocation:${invocationId}`);
  const found = records.find((record) => record.commitId === expected);
  if (found === undefined || found.commitId === undefined) return undefined;
  return { commitId: found.commitId, journalSeq: found.seq, recordDigest: found.recordDigest };
}

function childSource(input: {
  readonly record: ChildInvocationRecord;
  readonly commitRef: JournalCommitRef;
  readonly parentLocation: AgentActivityCurrentLocation;
  readonly terminalCommitRefs: readonly JournalCommitRef[];
  readonly objective: string;
}): AgentActivityChildSource {
  return {
    sourceId: `child-invocation:${input.record.invocationId}`,
    ownerId: OWNER_ID,
    commitRefs: [],
    evidenceRefs: [],
    boundLive: undefined,
    terminalCommitRefs: input.terminalCommitRefs,
    record: input.record,
    commitRef: input.commitRef,
    // The caller only passes a record whose own binding carries this objective.
    assignment: input.record.binding.assignment,
    objective: input.objective,
    parentLocation: input.parentLocation,
  };
}

export interface AssembleTaskAgentActivityRemainingSourcesOptions {
  readonly taskId: TaskId;
  readonly taskJournal: DurableJournalReadResult;
  readonly controlJournal: JsonlOrganJournal;
  readonly i2Journal: I2JournalPort;
  readonly live?: {
    readonly snapshot?: RuntimeTaskSnapshot;
    readonly currentLocations?: readonly AgentActivityCurrentLocation[];
    readonly inspectPool?: () => ReturnType<AgentRuntimePoolManager['inspect']> | undefined;
  };
}

interface ReturnedWork { readonly assignment: WorkAssignment; readonly result: WorkResult }

function reviewedObjective(review: ReviewAssignment, work: readonly ReturnedWork[]): string | undefined {
  const matches = work.filter(({ assignment, result }) =>
    assignment.taskId.value === review.taskId && result.agentId === review.workerAgentId
    && assignment.executionEpoch === review.executionEpoch && assignment.attempt === review.attempt
    && assignment.inputRevision === review.inputRevision
    && assignment.acceptanceCriteriaDigest === review.acceptanceCriteriaDigest
    && review.subjectRefs.length > 0
    && review.subjectRefs.every((ref, index) => result.producedArtifactRefs.some((artifact, at) =>
      artifact === ref && result.producedArtifactDigests[at] === review.subjectDigests[index])));
  // More than one matching assignment is ambiguous, even if its text happens to agree.
  const assignments = new Map(matches.map(({ assignment }) => [assignment.assignmentId, assignment]));
  if (assignments.size !== 1) return undefined;
  return [...assignments.values()][0]!.objective.trim() || undefined;
}

function missingSource(sourceId: string, message: string): TaskAgentActivityUnavailableSource {
  return { sourceId, ownerId: OWNER_ID, message };
}

/**
 * Child invocations of one task from the two declared durable paths: the
 * admitted active turn and every resumed segment of that turn. Both are read
 * through their own codec over the same verified records, so a record never
 * borrows a parent instance identity and a `childTurnId` never becomes the
 * parent location.
 */
async function assembleChildInvocations(input: {
  readonly taskId: TaskId;
  readonly bindings: readonly TaskActiveTurnBindingEntry[];
  readonly segments: readonly { readonly turnId: string; readonly opened: ResumedTurnSegmentOpened }[];
  readonly controlRecords: readonly JournalRecord[];
  readonly journal: JsonlOrganJournal;
  readonly work: readonly ReturnedWork[];
}): Promise<{
  readonly sources: readonly AgentActivityChildSource[];
  readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
}> {
  const sources: AgentActivityChildSource[] = [];
  const unavailableSources: TaskAgentActivityUnavailableSource[] = [];

  for (const binding of input.bindings) {
    const turnId = binding.binding.admittedTurn.turnId;
    const entries = decodeActiveTurnRecords(input.controlRecords, turnId);
    for (const record of invocationSnapshots(entries)) {
      const envelope = childInvocationEnvelope(input.controlRecords, turnId, record.invocationId);
      if (envelope === undefined) {
        unavailableSources.push(missingSource(
          `child-invocation:${record.invocationId}`,
          'child invocation has no committed invocation envelope',
        ));
        continue;
      }
      if (record.incarnation === undefined) {
        unavailableSources.push(missingSource(
          `child-invocation:${record.invocationId}`,
          'child invocation has no acquired incarnation',
        ));
        continue;
      }
      const objective = childObjective(record, input.work);
      if (objective === undefined) {
        unavailableSources.push(missingSource(
          `child-invocation:${record.invocationId}`,
          'reviewed child invocation has no committed reviewed objective',
        ));
        continue;
      }
      sources.push(childSource({
        record,
        objective,
        commitRef: envelope,
        terminalCommitRefs: childReturnCommits(input.controlRecords, entries, record, turnId),
        parentLocation: {
          // The parent location is the admitted turn that committed this
          // invocation; the child turn id is never used as the parent identity.
          instance: { kind: 'native-execution', execution: binding.binding.execution },
          assignmentId: binding.binding.assignment.assignmentId,
          businessTurnId: turnId,
        },
      }));
    }
  }

  for (const segment of input.segments) {
    const segmentId = segment.opened.segmentId;
    const entries = await createJsonlActiveTurnSegmentJournal({
      journal: input.journal, businessTurnId: segment.turnId,
    }).readSegmentRecords({ businessTurnId: segment.turnId, segmentId });
    for (const record of invocationSnapshots(entries)) {
      const envelope = segmentChildInvocationEnvelope(input.controlRecords, segmentId, record.invocationId);
      if (envelope === undefined) {
        unavailableSources.push(missingSource(
          `child-invocation:${record.invocationId}`,
          'child invocation has no committed invocation envelope',
        ));
        continue;
      }
      if (record.incarnation === undefined) {
        unavailableSources.push(missingSource(
          `child-invocation:${record.invocationId}`,
          'child invocation has no acquired incarnation',
        ));
        continue;
      }
      const objective = childObjective(record, input.work);
      if (objective === undefined) {
        unavailableSources.push(missingSource(
          `child-invocation:${record.invocationId}`,
          'reviewed child invocation has no committed reviewed objective',
        ));
        continue;
      }
      sources.push(childSource({
        record,
        objective,
        commitRef: envelope,
        terminalCommitRefs: childReturnCommits(input.controlRecords, entries, record, segmentId, true),
        parentLocation: {
          instance: { kind: 'incarnation', incarnation: segment.opened.binding.incarnation },
          assignmentId: segment.opened.binding.assignment.assignmentId,
          businessTurnId: segment.turnId,
          segmentId,
        },
      }));
    }
  }

  return { sources, unavailableSources };
}

function invocationSnapshots(entries: readonly ActiveTurnJournalRecord[]): readonly ChildInvocationRecord[] {
  const snapshots = new Map<string, ChildInvocationRecord>();
  for (const entry of entries) {
    if (entry.kind === 'child-invocation') snapshots.set(entry.record.invocationId, entry.record);
  }
  return [...snapshots.values()];
}

/** Only a matching returned delivery proves completion, never a dispatch checkpoint. */
function childReturnCommits(
  records: readonly JournalRecord[],
  entries: readonly ActiveTurnJournalRecord[],
  invocation: ChildInvocationRecord,
  carrierId: string,
  segment = false,
): readonly JournalCommitRef[] {
  const returned = entries.some((entry) => entry.kind === 'child-delivery'
    && entry.entry.invocationId === invocation.invocationId
    && entry.entry.kind === invocation.binding.kind);
  if (!returned) return [];
  const commitId = segment
    ? activeTurnSegmentCommitId(carrierId, `delivery:${invocation.invocationId}`)
    : activeTurnCommitId(carrierId, `delivery:${invocation.invocationId}`);
  const record = records.find((entry) => entry.commitId === commitId);
  const ref = record === undefined ? null : journalCommitRef(record);
  return ref === null ? [] : [ref];
}

type TaskActiveTurnBindingEntry = Awaited<ReturnType<
  typeof listTaskActiveTurnBindings
>>[number];

/** Runtime pool live leases of one task, read only through `manager.inspect()`. */
function assembleRuntimePoolLeases(input: {
  readonly taskId: TaskId;
  readonly inspectPool?: () => ReturnType<AgentRuntimePoolManager['inspect']> | undefined;
  readonly targets: readonly { readonly instance: TaskExecutionInstanceIdentity; readonly objective: string }[];
}): {
  readonly sources: readonly AgentActivityPoolSource[];
  readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
} {
  if (input.inspectPool === undefined) {
    return { sources: [], unavailableSources: [missingSource('runtime-pool', 'runtime pool inspector is unavailable')] };
  }
  const inspected = input.inspectPool();
  if (inspected === undefined) {
    return { sources: [], unavailableSources: [missingSource('runtime-pool', 'runtime pool inspection is unavailable')] };
  }

  const sources: AgentActivityPoolSource[] = [];
  const unavailableSources: TaskAgentActivityUnavailableSource[] = [];
  for (const runtime of inspected.runtimes) {
    const lease = runtime.lease;
    const incarnation = runtime.incarnation;
    if (lease === undefined || incarnation === undefined) continue;
    if (incarnation.taskId.value !== input.taskId.value) continue;
    if (runtime.state === 'disposed' || runtime.state === 'failed') continue;
    const objectives = new Set(input.targets.filter((target) => sameTaskExecutionInstanceIdentity(
      target.instance, { kind: 'incarnation', incarnation },
    )).map((target) => target.objective));
    if (objectives.size === 1) {
      sources.push({ sourceId: `runtime-pool-lease:${lease.leaseId}`, ownerId: OWNER_ID,
        runtime, objective: [...objectives][0]!, commitRefs: [], evidenceRefs: [],
        boundLive: runtime.state === 'running', terminalCommitRefs: [] });
      continue;
    }
    unavailableSources.push(missingSource(`runtime-pool-lease:${lease.leaseId}`,
      'runtime pool inspect has no owned assignment objective'));
  }
  return { sources, unavailableSources };
}

interface MilestoneReviewPages {
  readonly records: readonly { readonly record: MilestoneReviewResultRecord; readonly commitRef: JournalCommitRef }[];
}

/**
 * Milestone review results of one task through the real `I2JournalPort.list`
 * pagination, stopping only when the port reports no next cursor. A review
 * result proves that review delivery completed; it is not a child execution.
 */
async function listMilestoneReviews(input: {
  readonly taskScope: TaskIdentityScope;
  readonly i2Journal: I2JournalPort;
}): Promise<MilestoneReviewPages> {
  const records: { readonly record: MilestoneReviewResultRecord; readonly commitRef: JournalCommitRef }[] = [];
  const limit = I2_MILESTONE_REVIEW_PAGE_LIMIT;
  let cursor: string | undefined;
  for (;;) {
    const page = await input.i2Journal.list({
      taskScope: { organId: input.taskScope.organId, taskId: input.taskScope.taskId },
      kinds: ['milestone-review-result'],
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
    for (const entry of page.entries) {
      if (entry.record.kind !== 'milestone-review-result') continue;
      records.push({ record: entry.record, commitRef: entry.commitRef });
    }
    if (page.nextCursor === undefined) return { records };
    cursor = page.nextCursor;
  }
}

const I2_MILESTONE_REVIEW_PAGE_LIMIT = 200;

function assembleMilestoneReviews(input: {
  readonly taskId: TaskId;
  readonly pages: MilestoneReviewPages;
  readonly work: readonly ReturnedWork[];
}): {
  readonly sources: readonly AgentActivityReviewSource[];
  readonly unavailableSources: readonly TaskAgentActivityUnavailableSource[];
} {
  const sources: AgentActivityReviewSource[] = [];
  const unavailableSources: TaskAgentActivityUnavailableSource[] = [];
  for (const entry of input.pages.records) {
    const record = entry.record;
    if (record.taskScope.taskId?.value !== input.taskId.value) continue;
    const objective = reviewedObjective(record.reviewAssignment, input.work);
    if (objective === undefined) {
      unavailableSources.push(missingSource(`milestone-review:${entry.commitRef.commitId}`,
        'milestone review has no committed reviewed objective'));
      continue;
    }
    sources.push({ sourceId: `milestone-review:${entry.commitRef.commitId}`, ownerId: OWNER_ID,
      record, commitRef: entry.commitRef, objective, commitRefs: [], evidenceRefs: [],
      boundLive: undefined, terminalCommitRefs: [] });
  }
  return { sources, unavailableSources };
}

/** The single App entry that assembles all six declared activity sources. */
export async function readTaskAgentActivity(
  options: AssembleTaskAgentActivityRemainingSourcesOptions & {
    readonly query: TaskAgentActivitySelectionQuery;
    readonly currentAuthority?: AgentActivityCurrentAuthority;
  },
): Promise<RuntimeReadResult<RuntimeAgentActivityProjection>> {
  const assembled = await assembleTaskAgentActivityCoreContext(options);
  if (!assembled.ok) return projectionFailure(assembled.failure);
  try {
    const context = assembled.value;
    const bindings = await listTaskActiveTurnBindings({ journal: options.controlJournal, scope: context.taskScope });
    const work: ReturnedWork[] = [];
    const collectWork = (entries: readonly ActiveTurnJournalRecord[]) => {
      for (const entry of entries) {
        if (entry.kind === 'child-delivery' && entry.entry.kind === 'execution') {
          work.push({ assignment: entry.entry.assignment, result: entry.entry.result });
        }
      }
    };
    for (const { binding } of bindings) collectWork(decodeActiveTurnRecords(context.controlRecords, binding.admittedTurn.turnId));
    for (const { opened } of context.sources.resumedSegments) {
      collectWork(await createJsonlActiveTurnSegmentJournal({ journal: options.controlJournal,
        businessTurnId: opened.businessTurnRef.businessTurnId }).readSegmentRecords({
        businessTurnId: opened.businessTurnRef.businessTurnId, segmentId: opened.segmentId }));
    }
    const child = await assembleChildInvocations({
      taskId: options.taskId,
      bindings,
      work,
      segments: context.sources.resumedSegments.map(({ opened }) => ({
        turnId: opened.businessTurnRef.businessTurnId, opened,
      })),
      controlRecords: context.controlRecords,
      journal: options.controlJournal,
    });
    const pool = assembleRuntimePoolLeases({ taskId: options.taskId,
      targets: [
        ...child.sources.map((source) => ({ instance: { kind: 'incarnation' as const, incarnation: source.record.incarnation! }, objective: source.objective })),
        ...context.sources.resumedSegments.map(({ opened }) => ({ instance: { kind: 'incarnation' as const, incarnation: opened.binding.incarnation }, objective: opened.binding.assignment.objective })),
      ],
      ...(options.live?.inspectPool === undefined ? {} : { inspectPool: options.live.inspectPool }) });
    const pages = await listMilestoneReviews({ taskScope: context.taskScope, i2Journal: options.i2Journal });
    const review = assembleMilestoneReviews({ taskId: options.taskId, pages, work });
    const currentAuthority = options.currentAuthority ?? liveAuthority(options);
    return selectAndProjectAgentActivity({
      taskId: options.taskId, query: options.query, core: context.sources,
      ...(currentAuthority === undefined ? {} : { currentAuthority }),
      remainingSources: { childInvocations: child.sources, runtimePoolLeases: pool.sources, milestoneReviews: review.sources },
      unavailableSources: [...child.unavailableSources, ...pool.unavailableSources, ...review.unavailableSources],
    });
  } catch (error) {
    return projectionFailure(readFailure('agent-activity.remaining-source-unavailable',
      error instanceof Error ? error.message : String(error),
      'preserve and inspect the child, pool or I2 source before retrying').failure);
  }
}

function liveAuthority(options: AssembleTaskAgentActivityRemainingSourcesOptions): AgentActivityCurrentAuthority | undefined {
  const snapshot = options.live?.snapshot;
  if (snapshot?.taskId.value !== options.taskId.value || snapshot.executionEpoch === undefined) return undefined;
  return { taskId: options.taskId, executionEpoch: snapshot.executionEpoch,
    locations: options.live?.currentLocations ?? [] };
}
