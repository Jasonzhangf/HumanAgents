import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';

// The app test surface models only the `node:fs` members it uses. The journal
// cache needs a file-identity stat key, so declare just the members consumed
// here instead of widening the shared ambient surface.
declare module 'node:fs' {
  export interface Stats {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
  }
  export function statSync(path: string): Stats;
}
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  Checkpoint,
  CheckpointReceiptRelationshipV1,
  CycleId,
  ScopeRef,
  TaskId,
} from '../../../contracts/src/index.js';
import type { RuntimeMode } from '../../../ui/contracts/runtime.js';
import type {
  CheckpointAppendReceipt,
  CheckpointAppendRequest,
  CheckpointChainVerification,
  CheckpointListQuery,
  CheckpointListResult,
  CheckpointRecoveryBinding,
  CommittedCheckpointRecord,
  ExecutionPosition,
  JournalCommitRef,
  LatestCheckpointRecord,
  NativeCheckpointCommitRequest,
  NativeCheckpointJournalPort,
} from '../../../runtime/src/checkpoints/ports.js';
import type { CheckpointClosurePort } from '../../../runtime/src/checkpoints/ports.js';
import type { ClosureRecord, InteractionClosureRecord } from '../../../runtime/src/checkpoints/closure.js';
import type { CheckpointCommitPort } from '../../../runtime/src/control/steering.js';
import type {
  ActiveTurnJournalAppendRequest,
  ActiveTurnJournalPort,
  ActiveTurnJournalRecord,
} from '../../../runtime/src/context/active-turn-journal.js';
import {
  JournalIntegrityError,
  JsonlOrganJournal,
  type JournalRecord,
} from '../../../adapters/jsonl/src/index.js';
import type { RuntimeTaskJournalPort, RuntimeTaskJournalRecord } from '../../../runtime/src/ui-runtime/coordinator.js';
import { checkpointCommitId } from '../../../runtime/src/checkpoints/coordinator.js';
import { createJsonlCheckpointJournal } from '../checkpoint-journal.js';
import type {
  PublicOutputBinding,
  PublicOutputCandidate,
  PublicOutputCommitRef,
  PublicOutputJournalPort,
  PublicOutputPublication,
} from '../../../contracts/src/semantic-observation.js';
import {
  toolExecutionFactIntegrityError,
  validatePersistedToolExecutionFact,
  type ToolExecutionFactOuterIdentity,
} from './tool-fact-validation.js';

// App-owned UI runtime journal. This is not the Organ Journal or the runtime
// lifecycle state; it only stores enough typed projection state for the UI
// runtime server to reconstruct tasks, operation event streams, and counters
// after a process restart without making the browser read raw runtime state.
export type UiRuntimeJournalRecord = RuntimeTaskJournalRecord;

/**
 * Canonical UI runtime checkpoint layout under one project's control root:
 * `<project.checkpointsRoot>/ui-runtime/<mode>/`. The serve entry, the durable
 * reader and the tests all derive paths from these helpers, so a project
 * identity can never be relocated by a second path calculator.
 */
export function uiRuntimeCheckpointRoot(projectCheckpointsRoot: string): string {
  return join(projectCheckpointsRoot, 'ui-runtime');
}

export function uiRuntimeModeRoot(projectCheckpointsRoot: string, mode: RuntimeMode): string {
  return join(uiRuntimeCheckpointRoot(projectCheckpointsRoot), mode);
}

export function uiRuntimeJournalPath(projectCheckpointsRoot: string, mode: RuntimeMode): string {
  return join(uiRuntimeModeRoot(projectCheckpointsRoot, mode), 'ui-runtime-journal.jsonl');
}

/**
 * Canonical control Organ Journal for one mode root. Native checkpoints, public
 * output, task identity and I2 history all commit onto this single physical
 * `task-control.jsonl`, so the producer, the cold reader and the tests resolve
 * one authority instead of a second path calculator. `modeRoot` is the
 * already-derived `<project.checkpointsRoot>/ui-runtime/<mode>` directory.
 */
export function uiRuntimeControlJournalPath(modeRoot: string): string {
  return join(modeRoot, 'task-control.jsonl');
}

export function uiRuntimeTaskCheckpointPath(
  projectCheckpointsRoot: string,
  mode: RuntimeMode,
  taskId: TaskId,
  cycleId: CycleId,
): string {
  return join(uiRuntimeModeRoot(projectCheckpointsRoot, mode), `task-${taskId.value}-cycle-${cycleId.value}.jsonl`);
}

/**
 * One canonical control journal reaches tens of megabytes, and one product
 * board read asks several readers (task identity, agent activity, inspection
 * history, planner duties) about every task. Each reader used to parse the same
 * file again, so the read cost grew with the task count instead of staying one
 * file read.
 *
 * This reader verifies the file once per file state and hands the same verified
 * records to every reader that opens the same path. The cache key is the file
 * identity (`device`, `inode`, `size`, `mtime`), and the Organ Journal is
 * append-only, so any commit changes the key and the next read parses the new
 * content. Nothing about a task, a decision or a control fact is derived or
 * remembered here; only the already committed lines are shared.
 */
/**
 * Opens one canonical Organ Journal for reading. Every reader opened through
 * this function sees the same verified records until the file changes on disk,
 * and a concurrent burst is served by one parse instead of one per reader.
 *
 * The verified-record cache is owned by the adapter's `JsonlOrganJournal` and
 * keyed by the file identity. This factory stays a single path-based entry so
 * the app never opens a second cache around the same physical journal.
 */
export function openUiRuntimeOrganJournal(filePath: string): JsonlOrganJournal {
  if (!filePath.trim()) throw new Error('Organ Journal path is required');
  return new JsonlOrganJournal(filePath);
}

export interface DurableJournalReadFailure {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly nextAction: string;
}

export interface DurableJournalReadResult {
  readonly records: readonly UiRuntimeJournalRecord[];
  readonly failure?: DurableJournalReadFailure;
}

/**
 * Reads one project/mode task Journal without lifecycle. A missing file is a
 * legal "no saved task" state; a corrupt file returns an explicit failure so a
 * read model can never turn corruption into an empty project.
 */
export function readUiRuntimeTaskJournal(projectCheckpointsRoot: string, mode: RuntimeMode): DurableJournalReadResult {
  const filePath = uiRuntimeJournalPath(projectCheckpointsRoot, mode);
  try {
    return { records: new UiRuntimeJournal(filePath).replay() };
  } catch (error) {
    return {
      records: [],
      failure: {
        code: 'journal.corrupt',
        ownerId: 'humanagent.app.ui-runtime',
        message: error instanceof Error ? error.message : String(error),
        nextAction: 'inspect the UI runtime journal for this project and mode before reading it',
      },
    };
  }
}

interface JournalValidationContext {
  readonly operationIdentities: Map<string, ToolExecutionFactOuterIdentity>;
  readonly eventIdentities: Map<string, UiRuntimeJournalRecord>;
}

function createJournalValidationContext(): JournalValidationContext {
  return {
    operationIdentities: new Map(),
    eventIdentities: new Map(),
  };
}

function requireRecordString(record: Record<string, unknown>, key: string, filePath: string, line: number): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} is required`);
  }
  return value;
}

function requireRecordObject(record: Record<string, unknown>, key: string, filePath: string, line: number): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} is required`);
  }
  return value as Record<string, unknown>;
}

function requireScopedId(record: Record<string, unknown>, key: string, scope: string, filePath: string, line: number): void {
  const value = requireRecordObject(record, key, filePath, line);
  if (value.scope !== scope) throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key}.scope must be ${scope}`);
  requireRecordString(value, 'value', filePath, line);
}

function requirePositiveInteger(record: Record<string, unknown>, key: string, filePath: string, line: number): void {
  if (!Number.isSafeInteger(record[key]) || Number(record[key]) <= 0) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} is invalid`);
  }
}

/**
 * Optional non-empty string field. Absence is a valid, explicit state: a provider
 * turn id that was never reported must stay absent instead of being invented.
 */
function requireOptionalRecordString(record: Record<string, unknown>, key: string, filePath: string, line: number): void {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} must be a non-empty string when present`);
  }
}

function requireOptionalRecordStringArray(record: Record<string, unknown>, key: string, filePath: string, line: number): void {
  const value = record[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} must be an array when present`);
  }
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} must contain non-empty strings`);
    }
  }
}

function requireBoolean(record: Record<string, unknown>, key: string, filePath: string, line: number): void {
  if (typeof record[key] !== 'boolean') {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: ${key} must be a boolean`);
  }
}

function validateExecutionAllocation(value: unknown, filePath: string, line: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: allocation is required`);
  }
  const allocation = value as Record<string, unknown>;
  requireRecordString(allocation, 'runtimeId', filePath, line);
  requireScopedId(allocation, 'taskId', 'task', filePath, line);
  requireScopedId(allocation, 'operationId', 'operation', filePath, line);
  requirePositiveInteger(allocation, 'executionEpoch', filePath, line);
  requireRecordString(allocation, 'assignmentId', filePath, line);
  const scope = requireRecordObject(allocation, 'scope', filePath, line);
  requireScopedId(scope, 'organId', 'organ', filePath, line);
  requireScopedId(scope, 'taskId', 'task', filePath, line);
  requireScopedId(scope, 'cycleId', 'cycle', filePath, line);
  requireScopedId(scope, 'operationId', 'operation', filePath, line);
  const inputRefs = allocation.inputRefs;
  if (!Array.isArray(inputRefs) || inputRefs.length === 0 || inputRefs.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: allocation.inputRefs are required`);
  }
  requireRecordString(allocation, 'ownerId', filePath, line);
  requirePositiveInteger(allocation, 'directiveRevision', filePath, line);
  requirePositiveInteger(allocation, 'inputRevision', filePath, line);
  requireBoolean(allocation, 'orchestrated', filePath, line);
  if (allocation.role !== undefined) {
    requireRecordString(allocation, 'role', filePath, line);
    if (!['interaction', 'orchestration', 'execution', 'review', 'memory'].includes(String(allocation.role))) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: allocation.role is invalid`);
    }
  }
  if (allocation.configuredAgentId !== undefined) {
    requireRecordString(allocation, 'configuredAgentId', filePath, line);
  }
}

function checkpointIdKey(id: Checkpoint['id']): string {
  return `${id.scope}:${id.value}`;
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function checkpointScopeKey(scope: ScopeRef): string {
  return [
    `${scope.organId.scope}:${scope.organId.value}`,
    `${scope.taskId?.scope ?? '-'}:${scope.taskId?.value ?? '-'}`,
    `${scope.cycleId?.scope ?? '-'}:${scope.cycleId?.value ?? '-'}`,
    `${scope.operationId?.scope ?? '-'}:${scope.operationId?.value ?? '-'}`,
  ].join('|');
}

function checkpointChainKey(id: Checkpoint['id'], scope: ScopeRef): string {
  return `${checkpointIdKey(id)}|${checkpointScopeKey(scope)}`;
}

function validateEvidenceRefs(value: unknown, filePath: string, line: number): void {
  if (!Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: event.evidenceRefs are required`);
  }
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: event evidenceRef must be an object`);
    }
    const ref = candidate as Record<string, unknown>;
    requireScopedId(ref, 'evidenceId', 'evidence', filePath, line);
    requireRecordString(ref, 'kind', filePath, line);
    requireRecordString(ref, 'source', filePath, line);
    requireRecordString(ref, 'locator', filePath, line);
    requireRecordObject(ref, 'scope', filePath, line);
  }
}

function validateRuntimeEvent(value: unknown, filePath: string, line: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: operation.event event is required`);
  }
  const event = value as Record<string, unknown>;
  requireRecordString(event, 'eventId', filePath, line);
  requirePositiveInteger(event, 'seq', filePath, line);
  requireRecordString(event, 'occurredAt', filePath, line);
  requireScopedId(event, 'taskId', 'task', filePath, line);
  requireRecordString(event, 'operationId', filePath, line);
  requirePositiveInteger(event, 'executionEpoch', filePath, line);
  requireRecordString(event, 'kind', filePath, line);
  requireRecordString(event, 'state', filePath, line);
  requireRecordString(event, 'summary', filePath, line);
  requireOptionalRecordString(event, 'turnId', filePath, line);
  requireOptionalRecordString(event, 'requestId', filePath, line);
  requireOptionalRecordString(event, 'parentRequestId', filePath, line);
  requireOptionalRecordString(event, 'providerOccurredAt', filePath, line);
  requireOptionalRecordString(event, 'externalResponseId', filePath, line);
  requireOptionalRecordString(event, 'responseModel', filePath, line);
  requireOptionalRecordStringArray(event, 'outputRefs', filePath, line);
  validateEvidenceRefs(event.evidenceRefs, filePath, line);
}

function validateJournalRecord(
  value: unknown,
  filePath: string,
  line: number,
  context: JournalValidationContext,
): { readonly record: UiRuntimeJournalRecord; readonly duplicate: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`corrupt UI runtime journal ${filePath}:${line}: record must be an object`);
  }
  const record = value as Record<string, unknown>;
  const kind = requireRecordString(record, 'kind', filePath, line);
  if (kind === 'task.created') {
    requireScopedId(record, 'taskId', 'task', filePath, line);
    requireRecordString(record, 'title', filePath, line);
    requireRecordString(record, 'directive', filePath, line);
    requirePositiveInteger(record, 'directiveRevision', filePath, line);
    requireRecordString(record, 'createdAt', filePath, line);
    requirePositiveInteger(record, 'taskCounter', filePath, line);
    return { record: record as unknown as UiRuntimeJournalRecord, duplicate: false };
  }
  if (kind === 'task.updated') {
    requireScopedId(record, 'taskId', 'task', filePath, line);
    requireRecordString(record, 'title', filePath, line);
    requireRecordString(record, 'directive', filePath, line);
    requirePositiveInteger(record, 'directiveRevision', filePath, line);
    requireRecordString(record, 'updatedAt', filePath, line);
    return { record: record as unknown as UiRuntimeJournalRecord, duplicate: false };
  }
  if (kind === 'task.deleted') {
    requireScopedId(record, 'taskId', 'task', filePath, line);
    requireRecordString(record, 'deletedAt', filePath, line);
    return { record: record as unknown as UiRuntimeJournalRecord, duplicate: false };
  }
  if (kind === 'operation.prepared') {
    validateExecutionAllocation(record.allocation, filePath, line);
    const prepared = record as Extract<UiRuntimeJournalRecord, { readonly kind: 'operation.prepared' }>;
    const allocation = prepared.allocation;
    // The allocation is the only identity carrier on this record. Its outer
    // task/operation ids must equal the scope it was frozen with; there is no
    // second top-level copy to re-derive them from.
    if (!sameScopedId(allocation.taskId, allocation.scope.taskId)
      || !sameScopedId(allocation.operationId, allocation.scope.operationId)
    ) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: operation.prepared allocation identity does not match the enclosing record`);
    }
    requireRecordString(record, 'input', filePath, line);
    requirePositiveInteger(record, 'operationCounter', filePath, line);
    requirePositiveInteger(record, 'cycleCounter', filePath, line);
    const operationId = allocation.operationId;
    const taskId = allocation.taskId;
    const existing = context.operationIdentities.get(operationId.value);
    if (
      existing
      && (existing.taskId.value !== taskId.value || existing.executionEpoch !== allocation.executionEpoch)
    ) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: operation.prepared identity conflict for ${operationId.value}`);
    }
    if (!existing) {
      context.operationIdentities.set(operationId.value, {
        taskId,
        operationId,
        executionEpoch: allocation.executionEpoch,
      });
    }
    return { record: record as unknown as UiRuntimeJournalRecord, duplicate: false };
  }
  if (kind === 'operation.started') {
    requireScopedId(record, 'operationId', 'operation', filePath, line);
    requireScopedId(record, 'taskId', 'task', filePath, line);
    requireScopedId(record, 'cycleId', 'cycle', filePath, line);
    const scope = requireRecordObject(record, 'scope', filePath, line);
    requireScopedId(scope, 'organId', 'organ', filePath, line);
    requireScopedId(scope, 'taskId', 'task', filePath, line);
    requireScopedId(scope, 'cycleId', 'cycle', filePath, line);
    requireScopedId(scope, 'operationId', 'operation', filePath, line);
    requireRecordString(record, 'startedAt', filePath, line);
    requirePositiveInteger(record, 'executionEpoch', filePath, line);
    requirePositiveInteger(record, 'operationCounter', filePath, line);
    requirePositiveInteger(record, 'cycleCounter', filePath, line);
    requireRecordString(record, 'input', filePath, line);
    if (record.orchestrated !== undefined && typeof record.orchestrated !== 'boolean') {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: orchestrated must be a boolean`);
    }
    const operationId = requireRecordObject(record, 'operationId', filePath, line) as ToolExecutionFactOuterIdentity['operationId'];
    const taskId = record.taskId as ToolExecutionFactOuterIdentity['taskId'];
    const existing = context.operationIdentities.get(operationId.value);
    if (
      existing
      && (existing.taskId.value !== taskId.value || existing.executionEpoch !== record.executionEpoch)
    ) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: operation.started identity conflict for ${operationId.value}`);
    }
    if (!existing) {
      context.operationIdentities.set(operationId.value, {
        taskId,
        operationId,
        executionEpoch: record.executionEpoch as number,
      });
    }
    return { record: record as unknown as UiRuntimeJournalRecord, duplicate: false };
  }
  if (kind === 'operation.event') {
    requireScopedId(record, 'operationId', 'operation', filePath, line);
    validateRuntimeEvent(record.event, filePath, line);
    const eventRecord = record as Extract<UiRuntimeJournalRecord, { readonly kind: 'operation.event' }>;
    const operationIdentity = context.operationIdentities.get(eventRecord.operationId.value);
    if (operationIdentity === undefined) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: operation.event references unknown operation ${eventRecord.operationId.value}`);
    }
    if (
      eventRecord.event.executionFact === undefined
      && (
        eventRecord.event.operationId !== eventRecord.operationId.value
        || eventRecord.event.taskId.value !== operationIdentity.taskId.value
        || eventRecord.event.executionEpoch !== operationIdentity.executionEpoch
      )
    ) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: operation.event identity does not match enclosing operation ${eventRecord.operationId.value}`);
    }
    try {
      validatePersistedToolExecutionFact(eventRecord.event, operationIdentity);
    } catch (error) {
      throw toolExecutionFactIntegrityError(
        `corrupt UI runtime journal ${filePath}:${line}: ${error instanceof Error ? error.message : 'tool execution fact is invalid'}`,
      );
    }
    if (record.taskOutput !== undefined && typeof record.taskOutput !== 'string') {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: taskOutput must be a string`);
    }
    if (record.error !== undefined) {
      const taskError = requireRecordObject(record, 'error', filePath, line);
      requireRecordString(taskError, 'code', filePath, line);
      requireRecordString(taskError, 'ownerId', filePath, line);
      requireRecordString(taskError, 'message', filePath, line);
      if (typeof taskError.retryable !== 'boolean') throw new Error(`corrupt UI runtime journal ${filePath}:${line}: error.retryable is invalid`);
      requireRecordString(taskError, 'nextAction', filePath, line);
    }
    if (record.zeroEffectAdmissionDenial !== undefined) {
      if (record.zeroEffectAdmissionDenial !== true) {
        throw new Error(`corrupt UI runtime journal ${filePath}:${line}: zeroEffectAdmissionDenial must be true when present`);
      }
      const denialEvent = eventRecord.event;
      if (denialEvent.kind !== 'execution.terminal'
        || denialEvent.state !== 'blocked'
        || denialEvent.terminalPhase !== 'final') {
        throw new Error(`corrupt UI runtime journal ${filePath}:${line}: zeroEffectAdmissionDenial is only valid on a final blocked execution terminal`);
      }
    }
    const identityKey = JSON.stringify([eventRecord.operationId.value, eventRecord.event.eventId]);
    const duplicate = context.eventIdentities.get(identityKey);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(eventRecord)) {
        throw new Error(`corrupt UI runtime journal ${filePath}:${line}: operation.event identity conflict for ${eventRecord.event.eventId}`);
      }
      return { record: duplicate, duplicate: true };
    }
    context.eventIdentities.set(identityKey, eventRecord);
    return { record: eventRecord, duplicate: false };
  }
  if (kind === 'explicit-brain.state') {
    const state = requireRecordObject(record, 'state', filePath, line);
    requireRecordObject(state, 'intake', filePath, line);
    requireRecordObject(state, 'inbox', filePath, line);
    requireRecordObject(state, 'confirmationLedger', filePath, line);
    if (state.decisionTraces !== undefined && !Array.isArray(state.decisionTraces)) {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: state.decisionTraces must be an array`);
    }
    if (state.requirementAdmissions !== undefined) {
      if (!Array.isArray(state.requirementAdmissions)) {
        throw new Error(`corrupt UI runtime journal ${filePath}:${line}: state.requirementAdmissions must be an array`);
      }
      for (const admission of state.requirementAdmissions) {
        if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
          throw new Error(`corrupt UI runtime journal ${filePath}:${line}: requirement admission must be an object`);
        }
        const entry = admission as Record<string, unknown>;
        requireScopedId(entry, 'taskId', 'task', filePath, line);
        if (!['interactive', 'execution', 'research', 'maintenance'].includes(String(entry.queue))) {
          throw new Error(`corrupt UI runtime journal ${filePath}:${line}: requirement admission queue is invalid`);
        }
        const receipt = requireRecordObject(entry, 'receipt', filePath, line);
        const classified = requireRecordObject(receipt, 'classified', filePath, line);
        const decision = requireRecordObject(receipt, 'decision', filePath, line);
        if (!['interactive', 'execution', 'research', 'maintenance'].includes(String(classified.queue))) {
          throw new Error(`corrupt UI runtime journal ${filePath}:${line}: classified queue is invalid`);
        }
        if (!['admitted', 'waiting', 'blocked'].includes(String(decision.status))) {
          throw new Error(`corrupt UI runtime journal ${filePath}:${line}: admission decision status is invalid`);
        }
        if (decision.queue !== classified.queue) {
          throw new Error(`corrupt UI runtime journal ${filePath}:${line}: classified and admission decision queues differ`);
        }
      }
    }
    return { record: record as unknown as UiRuntimeJournalRecord, duplicate: false };
  }
  if (kind === 'interaction.closure') {
    const closure = requireRecordObject(record, 'closure', filePath, line);
    if (closure.closureKind !== 'interaction') {
      throw new Error(`corrupt UI runtime journal ${filePath}:${line}: closure kind must be interaction`);
    }
    requireRecordString(closure, 'closureId', filePath, line);
    requireRecordObject(closure, 'scope', filePath, line);
    requireRecordString(closure, 'reason', filePath, line);
    validateEvidenceRefs(closure.evidenceRefs, filePath, line);
    return { record: record as unknown as UiRuntimeJournalRecord, duplicate: false };
  }
  throw new Error(`corrupt UI runtime journal ${filePath}:${line}: unsupported record kind ${kind}`);
}

function readJournalRecords(
  filePath: string,
  context: JournalValidationContext,
): { readonly records: readonly UiRuntimeJournalRecord[]; readonly nextLine: number } {
  if (!existsSync(filePath)) return { records: [], nextLine: 1 };
  const records: UiRuntimeJournalRecord[] = [];
  let nextLine = 1;
  const lines = readFileSync(filePath, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed) continue;
    nextLine = index + 2;
    try {
      const validated = validateJournalRecord(JSON.parse(trimmed), filePath, index + 1, context);
      if (!validated.duplicate) records.push(validated.record);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`corrupt UI runtime journal ${filePath}:${index + 1}: invalid JSON`);
      }
      throw error;
    }
  }
  return { records, nextLine };
}

function sameStatIdentity(
  left: { readonly dev?: number; readonly ino?: number; readonly size?: number; readonly mtimeMs?: number } | undefined,
  right: { readonly dev?: number; readonly ino?: number; readonly size?: number; readonly mtimeMs?: number } | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export class UiRuntimeJournal implements RuntimeTaskJournalPort, CheckpointClosurePort {
  constructor(private readonly filePath: string) {}

  // Process-local validated-record cache keyed by the file content identity.
  // Every `append` previously reread and revalidated the whole journal, so a
  // long streaming turn reparsed the entire file for each SSE delta. When the
  // file has not been rewritten by another process, a warm append validates
  // only the new record and the replay returns the cached records. A different
  // content identity (external write, truncation, or rotation) invalidates the
  // cache and forces a full read/validate.
  private cached?: {
    readonly identity: ReturnType<UiRuntimeJournal['statIdentity']>;
    readonly records: readonly UiRuntimeJournalRecord[];
    readonly context: JournalValidationContext;
    readonly nextLine: number;
  };

  private statIdentity(): { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number } | undefined {
    try {
      const info = statSync(this.filePath);
      return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return undefined;
    }
  }

  private readRecords(): {
    readonly records: readonly UiRuntimeJournalRecord[];
    readonly context: JournalValidationContext;
    readonly nextLine: number;
  } {
    const context = createJournalValidationContext();
    const { records, nextLine } = readJournalRecords(this.filePath, context);
    return { records, context, nextLine };
  }

  append(record: UiRuntimeJournalRecord): void {
    const identity = this.statIdentity();
    const cached = this.cached;
    if (cached !== undefined && sameStatIdentity(cached.identity, identity)) {
      const nextLine = cached.nextLine;
      const validated = validateJournalRecord(record, this.filePath, nextLine, cached.context);
      if (validated.duplicate) return;
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
      this.cached = {
        identity: this.statIdentity(),
        records: [...cached.records, validated.record],
        context: cached.context,
        nextLine: nextLine + 1,
      };
      return;
    }
    const { records, context, nextLine } = this.readRecords();
    const validated = validateJournalRecord(record, this.filePath, nextLine, context);
    if (validated.duplicate) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    this.cached = { identity: this.statIdentity(), records: [...records, validated.record], context, nextLine: nextLine + 1 };
  }

  replay(): readonly UiRuntimeJournalRecord[] {
    const identity = this.statIdentity();
    const cached = this.cached;
    if (cached !== undefined && sameStatIdentity(cached.identity, identity)) {
      return cached.records.map((record) => structuredClone(record));
    }
    const { records, context, nextLine } = this.readRecords();
    this.cached = { identity, records, context, nextLine };
    return records.map((record) => structuredClone(record));
  }

  async commit(input: ClosureRecord): Promise<{ readonly closureId: string; readonly committed: true }> {
    if (!('closureKind' in input) || input.closureKind !== 'interaction') {
      throw new Error('UI runtime journal only owns interaction closures');
    }
    const existing = [...this.replay()].reverse().find((record) => (
      record.kind === 'interaction.closure' && record.closure.closureId === input.closureId
    ));
    if (existing?.kind === 'interaction.closure') {
      if (JSON.stringify(existing.closure) !== JSON.stringify(input)) {
        throw new Error(`interaction closure conflict: ${input.closureId}`);
      }
      return { closureId: input.closureId, committed: true };
    }
    this.append({ kind: 'interaction.closure', closure: input });
    return { closureId: input.closureId, committed: true };
  }

  async read(closureId: string): Promise<ClosureRecord | null> {
    const record = [...this.replay()].reverse().find((candidate) => candidate.kind === 'interaction.closure' && candidate.closure.closureId === closureId);
    return record?.kind === 'interaction.closure' ? structuredClone(record.closure) as InteractionClosureRecord : null;
  }
}

// File-backed checkpoint store. Wraps the authoritative JsonlOrganJournal adapter
// (packages/adapters/jsonl) so checkpoint persistence and link validation stay in
// their single owner; the UI runtime only assembles the port.
/**
 * Payload of one durable public-output commit. It records only the public
 * content fact; pending/retry/unknown control truth never enters this payload.
 */
interface PublicOutputPayload {
  readonly type: 'public-output.committed';
  readonly binding: PublicOutputBinding;
  readonly sourceId: string;
  readonly text: string;
}

/**
 * Deterministic commit identity: `public-output:<sha256(canonical binding + sourceId)>`.
 * The text is deliberately excluded so a same-identity/different-text retry is
 * rejected by the existing Journal conflict owner instead of silently diverging.
 */
function publicOutputCommitId(candidate: PublicOutputCandidate): string {
  const binding = candidate.binding;
  const identity = JSON.stringify({
    scope: {
      organId: { scope: binding.scope.organId.scope, value: binding.scope.organId.value },
      taskId: binding.scope.taskId ? { scope: binding.scope.taskId.scope, value: binding.scope.taskId.value } : null,
      cycleId: binding.scope.cycleId ? { scope: binding.scope.cycleId.scope, value: binding.scope.cycleId.value } : null,
      operationId: binding.scope.operationId ? { scope: binding.scope.operationId.scope, value: binding.scope.operationId.value } : null,
    },
    executionEpoch: binding.executionEpoch,
    harnessTurnId: binding.harnessTurnId ?? null,
    providerTurnId: binding.providerTurnId ?? null,
    requestId: binding.requestId ?? null,
    sourceId: candidate.sourceId,
  });
  return `public-output:${createHash('sha256').update(identity).digest('hex')}`;
}

/** Public identity match: scope, executionEpoch and the actually reported Harness turn only. */
function publicOutputBindingMatches(candidate: PublicOutputBinding, requested: PublicOutputBinding): boolean {
  return sameScopedId(candidate.scope.organId, requested.scope.organId)
    && sameScopedId(candidate.scope.taskId, requested.scope.taskId)
    && sameScopedId(candidate.scope.cycleId, requested.scope.cycleId)
    && sameScopedId(candidate.scope.operationId, requested.scope.operationId)
    && candidate.executionEpoch === requested.executionEpoch
    && candidate.harnessTurnId === requested.harnessTurnId;
}

function readPublicOutputPayload(record: import('../../../adapters/jsonl/src/index.js').JournalRecord): PublicOutputPayload | undefined {
  if (record.kind !== 'event') return undefined;
  const payload = record.payload;
  if (!payload || payload.type !== 'public-output.committed') return undefined;
  return payload as unknown as PublicOutputPayload;
}

function publicOutputRefFromRecord(record: import('../../../adapters/jsonl/src/index.js').JournalRecord): PublicOutputCommitRef {
  const payload = readPublicOutputPayload(record);
  if (!payload || record.commitId === undefined) {
    throw new Error('public output commit read back an unexpected journal record');
  }
  return {
    binding: payload.binding,
    sourceId: payload.sourceId,
    commitId: record.commitId,
    journalSeq: record.seq,
    recordDigest: record.recordDigest,
  };
}

export class FileCheckpointStore implements NativeCheckpointJournalPort, CheckpointCommitPort, PublicOutputJournalPort {
  constructor(
    private readonly filePath: string,
    private readonly sharedJournal?: JsonlOrganJournal,
  ) {}

  async verify(_scope: ScopeRef): Promise<CheckpointChainVerification> {
    const verification = await this.journal().verify();
    return verification.valid ? { valid: true } : { valid: false, reason: verification.error ?? 'checkpoint journal is invalid' };
  }

  async readLatest(scope: ScopeRef): Promise<LatestCheckpointRecord | null> {
    const records = await this.journal().replay();
    const checkpointByChain = new Map<string, Checkpoint>();
    for (const record of records) {
      if (record.kind === 'checkpoint' && record.checkpoint) {
        checkpointByChain.set(checkpointChainKey(record.checkpoint.id, record.checkpoint.scope), record.checkpoint);
      }
    }
    const businessCheckpoints = records
      .filter((record) =>
        record.kind === 'checkpoint'
        && record.checkpoint
        && sameScopedId(record.scope.organId, scope.organId)
        && sameScopedId(record.scope.taskId, scope.taskId)
        && sameScopedId(record.scope.cycleId, scope.cycleId))
      .map((record) => record.checkpoint as Checkpoint);
    const exactOperationCheckpoints = scope.operationId
      ? businessCheckpoints.filter((checkpoint) => sameScopedId(checkpoint.scope.operationId, scope.operationId))
      : [];
    const checkpoints = exactOperationCheckpoints.length > 0
      ? exactOperationCheckpoints
      : businessCheckpoints.filter((checkpoint) => !checkpoint.scope.operationId);
    const latest = checkpoints.at(-1);
    if (!latest) return null;
    if (latest.previousCheckpointId === null) {
      return { checkpoint: latest, previous: null };
    }
    const previous = checkpointByChain.get(checkpointChainKey(latest.previousCheckpointId, latest.scope))
      ?? (latest.outcome === 'stopped' && latest.scope.operationId
        ? checkpointByChain.get(checkpointChainKey(latest.previousCheckpointId, {
          organId: latest.scope.organId,
          ...(latest.scope.taskId ? { taskId: latest.scope.taskId } : {}),
          ...(latest.scope.cycleId ? { cycleId: latest.scope.cycleId } : {}),
        }))
        : undefined);
    if (!previous) {
      throw new Error(`corrupt UI runtime checkpoint journal ${this.filePath}: previous checkpoint ${latest.previousCheckpointId.value} is missing`);
    }
    return { checkpoint: latest, previous };
  }

  async append(input: CheckpointAppendRequest): Promise<CheckpointAppendReceipt> {
    const record = await this.journal().append({
      commitId: input.commitId,
      kind: 'checkpoint',
      scope: input.checkpoint.scope,
      checkpoint: input.checkpoint,
    });
    return {
      checkpointId: input.checkpoint.id,
      // The append receipt carries the committed checkpoint's chain sequence,
      // never the journal-global record sequence (`record.seq`).
      seq: input.checkpoint.seq,
      recordDigest: record.recordDigest,
    };
  }

  async commitNativeCheckpoint(
    input: NativeCheckpointCommitRequest,
  ): Promise<CheckpointReceiptRelationshipV1> {
    return this.checkpointPort().commitNativeCheckpoint(input);
  }

  async readNativeCheckpoint(input: {
    readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
  }): Promise<CheckpointReceiptRelationshipV1 | null> {
    return this.checkpointPort().readNativeCheckpoint(input);
  }

  async commit(checkpoint: Checkpoint): Promise<{
    readonly checkpointId: Checkpoint['id'];
    readonly committed: true;
    readonly recordDigest: string;
  }> {
    const receipt = await this.append({
      ownerId: 'humanagent.app',
      commitId: checkpointCommitId(checkpoint),
      checkpoint,
    });
    if (!receipt.recordDigest) {
      throw new Error(`checkpoint commit ${checkpoint.id.value} did not return a journal record digest`);
    }
    return {
      checkpointId: checkpoint.id,
      committed: true,
      recordDigest: receipt.recordDigest,
    };
  }

  // Exact reads use the authoritative JSONL checkpoint owner.
  async readCommitted(scope: ScopeRef, checkpointId: Checkpoint['id']): Promise<CommittedCheckpointRecord | null> {
    return this.checkpointPort().readCommitted(scope, checkpointId);
  }

  async listCommitted(query: CheckpointListQuery): Promise<CheckpointListResult> {
    return this.checkpointPort().listCommitted(query);
  }

  async readExecutionPosition(taskScope: ScopeRef): Promise<ExecutionPosition | null> {
    return this.checkpointPort().readExecutionPosition(taskScope);
  }

  async readCheckpointRecoveryBinding(scope: ScopeRef, checkpointCommitRef: JournalCommitRef): Promise<CheckpointRecoveryBinding | null> {
    return this.checkpointPort().readCheckpointRecoveryBinding(scope, checkpointCommitRef);
  }

  private checkpointPort(): NativeCheckpointJournalPort {
    return createJsonlCheckpointJournal({ filePath: this.filePath, journal: this.journal() });
  }

  /**
   * Commits one accepted public-output candidate onto the SAME task/cycle Organ
   * Journal as checkpoints. Recovery first reads the exact commit id back; a
   * present record reuses its original ref and a missing one appends. The append
   * is idempotent through the adapter's own commit-id handling, and the exact
   * read-back before returning keeps seq/digest tied to the durable record.
   */
  async commitPublicOutput(candidate: PublicOutputCandidate): Promise<PublicOutputCommitRef> {
    const journal = this.journal();
    const commitId = publicOutputCommitId(candidate);
    const existing = await journal.findByCommitId(commitId);
    if (existing) return publicOutputRefFromRecord(existing);
    const record = await journal.append({
      commitId,
      kind: 'event',
      scope: candidate.binding.scope,
      payload: {
        type: 'public-output.committed',
        binding: candidate.binding,
        sourceId: candidate.sourceId,
        text: candidate.text,
      },
    });
    const readback = await journal.findByCommitId(commitId);
    if (!readback || readback.seq !== record.seq || readback.recordDigest !== record.recordDigest) {
      throw new Error(`public output commit ${commitId} could not be read back exactly`);
    }
    return publicOutputRefFromRecord(readback);
  }

  /**
   * Reads the committed public publication for one binding by replaying the
   * same Organ Journal. Only records whose binding matches are returned, ordered
   * by Journal seq; the watermark is the last matching record's seq.
   */
  async readPublicOutputs(binding: PublicOutputBinding): Promise<PublicOutputPublication> {
    const records = await this.journal().replay();
    const commits: { readonly ref: PublicOutputCommitRef; readonly text: string }[] = [];
    for (const record of records) {
      const payload = readPublicOutputPayload(record);
      if (!payload || !publicOutputBindingMatches(payload.binding, binding)) continue;
      commits.push({
        ref: {
          binding: payload.binding,
          sourceId: payload.sourceId,
          commitId: record.commitId!,
          journalSeq: record.seq,
          recordDigest: record.recordDigest,
        },
        text: payload.text,
      });
    }
    commits.sort((left, right) => left.ref.journalSeq - right.ref.journalSeq);
    const last = commits.at(-1);
    return {
      state: 'committed',
      commits,
      ...(last === undefined ? {} : { publicCommitWatermark: last.ref.journalSeq }),
    };
  }

  private journal(): JsonlOrganJournal {
    return this.sharedJournal ?? openUiRuntimeOrganJournal(this.filePath);
  }
}

interface ActiveTurnJournalLine {
  readonly commitId: string;
  readonly record: ActiveTurnJournalRecord;
}

/**
 * File-backed durable port for the Runtime-owned active turn. It appends typed
 * records as JSON lines and dedupes by `commitId`. It stores control facts
 * verbatim; it never mirrors a business payload, summary or log, and it never
 * reconstructs a record from a projection.
 */
export class FileActiveTurnJournal implements ActiveTurnJournalPort {
  constructor(private readonly filePath: string) {}

  async append(input: ActiveTurnJournalAppendRequest): Promise<void> {
    const lines = this.lines();
    const existing = lines.find((line) => line.commitId === input.commitId);
    if (existing) {
      if (JSON.stringify(existing.record) !== JSON.stringify(input.record)) {
        throw new Error(`active turn journal conflict: ${input.commitId}`);
      }
      return;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify({ commitId: input.commitId, record: input.record })}\n`, 'utf8');
  }

  async replay(): Promise<readonly ActiveTurnJournalRecord[]> {
    return this.lines().map((line) => line.record);
  }

  private lines(): readonly ActiveTurnJournalLine[] {
    if (!existsSync(this.filePath)) return [];
    const text = readFileSync(this.filePath, 'utf8');
    const lines: ActiveTurnJournalLine[] = [];
    const rows = text.split('\n');
    for (let index = 0; index < rows.length; index += 1) {
      const trimmed = rows[index]!.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ActiveTurnJournalLine;
        if (typeof parsed.commitId !== 'string' || !parsed.record || typeof parsed.record !== 'object') {
          throw new Error('record shape is invalid');
        }
        lines.push(parsed);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`corrupt active turn journal ${this.filePath}:${index + 1}: invalid JSON`);
        }
        throw error;
      }
    }
    return lines;
  }
}
