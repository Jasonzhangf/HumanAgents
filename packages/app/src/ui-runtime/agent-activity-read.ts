import type {
  JournalCommitRef,
  ScopeRef,
  TaskAgentActivitySelectionFailure,
  TaskAgentActivitySelectionQuery,
  TaskAgentActivityUnavailableSource,
  TaskId,
  TaskIdentityScope,
} from '../../../contracts/src/index.js';
import { validateTaskAgentActivitySelectionQuery } from '../../../contracts/src/agent-activity.js';
import type { JsonlOrganJournal, JournalRecord } from '../../../adapters/jsonl/src/index.js';
import {
  createJsonlActiveTurnSegmentJournal,
  listTaskActiveTurnBindings,
} from '../../../adapters/jsonl/src/active-turn.js';
import {
  closureFromRecord,
  readCommittedNativeSegmentSource,
} from '../checkpoint-journal.js';
import type { DurableJournalReadResult } from './journal.js';
import {
  selectTaskAgentActivity,
  type AgentActivityActiveSource,
  type AgentActivityCurrentAuthority,
  type AgentActivityNativeSource,
  type AgentActivityPoolSource,
  type AgentActivityChildSource,
  type AgentActivityResumedSource,
  type AgentActivityReviewSource,
} from '../../../runtime/src/observation/agent-activity.js';
import { projectRuntimeAgentActivity } from '../../../ui/projection/agent-activity.js';
import type { RuntimeAgentActivityProjection, RuntimeReadResult } from '../../../ui/contracts/runtime.js';

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

export async function assembleTaskAgentActivityCoreSources(
  options: AssembleTaskAgentActivityCoreSourcesOptions,
): Promise<TaskAgentActivityCoreAssembly> {
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
    value: { nativeAllocations, activeTurns, resumedSegments, unavailableSources },
  };
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

export async function readTaskAgentActivityCore(
  options: ReadTaskAgentActivityCoreOptions,
): Promise<RuntimeReadResult<RuntimeAgentActivityProjection>> {
  const assembled = await assembleTaskAgentActivityCoreSources(options);
  if (!assembled.ok) return projectionFailure(assembled.failure);

  return projectRuntimeAgentActivity(selectTaskAgentActivity({
    taskId: options.taskId,
    query: options.query,
    ...(options.currentAuthority === undefined ? {} : { currentAuthority: options.currentAuthority }),
    nativeAllocations: assembled.value.nativeAllocations,
    activeTurns: assembled.value.activeTurns,
    resumedSegments: assembled.value.resumedSegments,
    childInvocations: options.remainingSources.childInvocations,
    runtimePoolLeases: options.remainingSources.runtimePoolLeases,
    milestoneReviews: options.remainingSources.milestoneReviews,
    unavailableSources: assembled.value.unavailableSources,
  }));
}
