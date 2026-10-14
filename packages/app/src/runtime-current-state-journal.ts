import { createHash } from 'node:crypto';
import {
  JsonlOrganJournal,
  JournalIntegrityError,
  JournalCommitConflictError,
  type JournalRecord,
} from '../../adapters/jsonl/src/index.js';
import type { JournalCommitRef, ScopeRef } from '../../contracts/src/index.js';
import type {
  RetainedReentryDuty,
  RuntimeTaskCurrentState,
  RuntimeTaskCurrentStateRead,
  RuntimeTaskCurrentStatePort,
  RuntimeTaskCurrentStateTransition,
} from '../../runtime/src/ui-runtime/current-state.js';

/**
 * One owner-defined typed control record for the Runtime current-state
 * transition. It lives in the existing Organ Journal next to the task's
 * checkpoints. The payload carries the serialization; it is not business
 * payload, UI metadata, a diagnostic event stream, or a second store.
 */
export const RUNTIME_TASK_CURRENT_STATE_SCHEMA_VERSION = 1;
export const RUNTIME_TASK_CURRENT_STATE_PAYLOAD = 'runtime-task-current-state';

interface RuntimeTaskCurrentStatePayload {
  readonly type: typeof RUNTIME_TASK_CURRENT_STATE_PAYLOAD;
  readonly schemaVersion: typeof RUNTIME_TASK_CURRENT_STATE_SCHEMA_VERSION;
  readonly transitionId: string;
  readonly state: RuntimeTaskCurrentState;
}

function receipt(record: JournalRecord): JournalCommitRef {
  if (!record.commitId) throw new JournalIntegrityError('runtime current-state record has no commit identity');
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

function inTask(scope: ScopeRef, task: ScopeRef): boolean {
  return scope.organId.value === task.organId.value && scope.taskId?.value === task.taskId?.value;
}

function readPayload(record: JournalRecord): RuntimeTaskCurrentStatePayload | undefined {
  if (record.kind !== 'event') return undefined;
  const payload = record.payload;
  if (!payload || payload.type !== RUNTIME_TASK_CURRENT_STATE_PAYLOAD) return undefined;
  return payload as unknown as RuntimeTaskCurrentStatePayload;
}

function sameCommitRef(left: JournalCommitRef | null, right: JournalCommitRef | null): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new JournalIntegrityError(`${label} is required`);
}

function assertCurrentState(value: RuntimeTaskCurrentState, taskScope: ScopeRef): void {
  if (!value || typeof value !== 'object') throw new JournalIntegrityError('runtime current-state value is missing');
  if (value.task?.id?.value !== taskScope.taskId?.value || value.task?.organId?.value !== taskScope.organId.value) {
    throw new JournalIntegrityError('runtime current-state Task does not match its task scope');
  }
  if (!value.processing || typeof value.processing.entryPhase !== 'string'
    || typeof value.processing.recoveryResponsibilityRef !== 'string'
    || !Array.isArray(value.processing.hardBlockers)
    || !Array.isArray(value.processing.laterErrorRefs)
    || !Array.isArray(value.processing.stages)) {
    throw new JournalIntegrityError('runtime current-state processing facts are incomplete');
  }
  if (!Array.isArray(value.retainedDuties) || !Array.isArray(value.sourceCommitRefs)) {
    throw new JournalIntegrityError('runtime current-state owner facts are incomplete');
  }
  if (value.currentPlan !== undefined) {
    const plan = value.currentPlan;
    const ref = plan?.revisionCommitRef;
    if (!plan || typeof plan.revisionId !== 'string' || !plan.revisionId.trim()
      || !ref || typeof ref.commitId !== 'string' || !ref.commitId.trim()
      || !Number.isSafeInteger(ref.journalSeq) || ref.journalSeq < 1
      || typeof ref.recordDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.recordDigest)) {
      throw new JournalIntegrityError('runtime current-state current plan reference is incomplete');
    }
  }
}

function assertPayload(record: JournalRecord, taskScope: ScopeRef): RuntimeTaskCurrentState {
  const payload = readPayload(record);
  if (!payload) throw new JournalIntegrityError('runtime current-state record has no current-state payload');
  if (payload.schemaVersion !== RUNTIME_TASK_CURRENT_STATE_SCHEMA_VERSION) {
    throw new JournalIntegrityError('runtime current-state schema version is unsupported');
  }
  nonEmpty(payload.transitionId, 'runtime current-state transition id');
  const value = payload.state;
  assertCurrentState(value, taskScope);
  return value;
}

/**
 * Pure decoder over supplied verified Organ Journal records. It reads only the
 * owner-defined current-state payload inside the task scope and returns the
 * latest committed transition. It performs no I/O, no Provider wait and no
 * reconstruction from UI Journal records, historical Task content, or a
 * display snapshot. Missing serialization is an explicit unknown.
 */
export function readRuntimeTaskCurrentStateFromRecords(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
): RuntimeTaskCurrentStateRead {
  const matches = records.filter((record) => inTask(record.scope, taskScope)
    && readPayload(record) !== undefined);
  if (matches.length === 0) {
    return { state: 'unknown', reason: 'no committed runtime current-state serialization for this task' };
  }
  const latest = matches[matches.length - 1]!;
  const value = assertPayload(latest, taskScope);
  return { state: 'known', value, stateCommitRef: receipt(latest) };
}

function transitionCommitId(taskScope: ScopeRef, transitionId: string): string {
  const identity = JSON.stringify([
    taskScope.organId.scope, taskScope.organId.value,
    taskScope.taskId?.scope ?? null, taskScope.taskId?.value ?? null,
    transitionId,
  ]);
  return `runtime-current-state:${createHash('sha256').update(identity).digest('hex')}`;
}

function sameTransition(left: RuntimeTaskCurrentStatePayload, right: RuntimeTaskCurrentStateTransition): boolean {
  return left.transitionId === right.transitionId
    && JSON.stringify(left.state) === JSON.stringify(right.state);
}

function findByTransition(
  records: readonly JournalRecord[],
  taskScope: ScopeRef,
  transitionId: string,
): { readonly record: JournalRecord; readonly payload: RuntimeTaskCurrentStatePayload } | null {
  const matches = records.filter((record) => inTask(record.scope, taskScope)
    && readPayload(record)?.transitionId === transitionId);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new JournalIntegrityError('runtime current-state transition has multiple records');
  const record = matches[0]!;
  return { record, payload: readPayload(record)! };
}

export interface RuntimeTaskCurrentStateJournal extends RuntimeTaskCurrentStatePort {
  read(taskScope: ScopeRef): Promise<RuntimeTaskCurrentStateRead>;
}

/**
 * The App serialization owner. It commits a Runtime transition into the same
 * Organ Journal the task already uses. The commit is strict and idempotent:
 * it checks the task scope, the exact predecessor receipt, the transition
 * identity and same-identity content. A stale predecessor or an append failure
 * leaves the prior committed state in place.
 */
export function createJsonlRuntimeTaskCurrentStateJournal(input: {
  readonly journal: JsonlOrganJournal;
}): RuntimeTaskCurrentStateJournal {
  const { journal } = input;

  async function verifiedRecords(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) throw new JournalIntegrityError(verification.error ?? 'runtime current-state Journal is corrupt');
    return verification.records;
  }

  return {
    async commit(transition) {
      nonEmpty(transition.transitionId, 'runtime current-state transition id');
      if (!transition.taskScope.taskId) throw new JournalIntegrityError('runtime current-state requires a task scope');
      if (transition.taskScope.organId.scope !== 'organ' || !transition.taskScope.organId.value
        || transition.taskScope.taskId.scope !== 'task' || !transition.taskScope.taskId.value) {
        throw new JournalIntegrityError('runtime current-state requires a valid organ/task scope');
      }
      assertCurrentState(transition.state, transition.taskScope);
      const commitId = transitionCommitId(transition.taskScope, transition.transitionId);
      let appendError: unknown;
      let committed: JournalCommitRef | undefined;
      try {
        committed = await journal.transaction(({ records }) => {
          const existing = findByTransition(records, transition.taskScope, transition.transitionId);
          if (existing) {
            if (!sameTransition(existing.payload, transition)) {
              throw new JournalCommitConflictError(commitId, existing.record);
            }
            return existing.record;
          }
          const current = readRuntimeTaskCurrentStateFromRecords(records, transition.taskScope);
          const currentRef = current.state === 'known' ? current.stateCommitRef : null;
          if (!sameCommitRef(currentRef, transition.expectedStateCommitRef)) {
            throw new JournalIntegrityError('stale runtime current-state predecessor; the prepared transition is rejected');
          }
          return null;
        }, async (existing, append) => {
          if (existing) return receipt(existing);
          return receipt(await append({
            commitId,
            kind: 'event',
            scope: transition.taskScope,
            payload: {
              type: RUNTIME_TASK_CURRENT_STATE_PAYLOAD,
              schemaVersion: RUNTIME_TASK_CURRENT_STATE_SCHEMA_VERSION,
              transitionId: transition.transitionId,
              state: transition.state,
            },
          }));
        });
      } catch (error) {
        appendError = error;
      }
      const stored = findByTransition(await verifiedRecords(), transition.taskScope, transition.transitionId);
      if (stored) {
        if (!sameTransition(stored.payload, transition)) {
          throw new JournalIntegrityError('runtime current-state exact readback conflicts with the transition');
        }
        const storedRef = receipt(stored.record);
        if (committed && !sameCommitRef(committed, storedRef)) {
          throw new JournalIntegrityError('runtime current-state exact readback receipt conflicts');
        }
        return storedRef;
      }
      if (appendError) throw appendError;
      throw new JournalIntegrityError('runtime current-state exact readback is absent; installation held');
    },
    async read(taskScope) {
      return readRuntimeTaskCurrentStateFromRecords(await verifiedRecords(), taskScope);
    },
  };
}

export type { RetainedReentryDuty };
