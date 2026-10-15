import { createHash } from 'node:crypto';
import {
  JournalCommitConflictError,
  JournalIntegrityError,
  type JournalRecord,
  type JsonlOrganJournal,
} from '../../../adapters/jsonl/src/index.js';
import {
  canonicalJsonStringify,
  validateTaskIdentityRecord,
  type JournalCommitRef,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import type {
  ClosedTurnPlannerCallCommittedRecord,
  ClosedTurnPlannerCallJournalPort,
  ClosedTurnPlannerCallRecord,
  ClosedTurnPlannerCallStage,
} from '../../../runtime/src/orchestration/closed-turn-planner-call.js';

/**
 * App-owned serialization for the Runtime closed-turn Planner call records.
 *
 * The Runtime owner defines the typed preparation/invocation/return records and
 * keeps them as control truth in the existing Organ Journal. This codec is the
 * only place that turns those records into a Journal payload and back. It adds
 * no second store, no business metadata and no UI event log.
 */
export const CLOSED_TURN_PLANNER_CALL_PAYLOAD = 'closed-turn-planner-call';
export const CLOSED_TURN_PLANNER_CALL_SCHEMA_VERSION = 1;

interface ClosedTurnPlannerCallPayload {
  readonly type: typeof CLOSED_TURN_PLANNER_CALL_PAYLOAD;
  readonly schemaVersion: typeof CLOSED_TURN_PLANNER_CALL_SCHEMA_VERSION;
  readonly record: ClosedTurnPlannerCallRecord;
}

const STAGE_ORDER: Readonly<Record<ClosedTurnPlannerCallStage, number>> = {
  prepared: 0,
  invoked: 1,
  returned: 2,
};

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JournalIntegrityError(`${label} must be a non-empty string`);
  }
}

function receipt(record: JournalRecord): JournalCommitRef {
  if (record.commitId === undefined) {
    throw new JournalIntegrityError('closed-turn planner call record has no commit identity');
  }
  return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
}

/** Product task identity ignores cycle/operation detail; the duty key carries the rest. */
function inTask(recordScope: ScopeRef, filter: ScopeRef): boolean {
  return recordScope.organId.value === filter.organId.value
    && recordScope.taskId?.value !== undefined
    && recordScope.taskId.value === filter.taskId?.value;
}

function readPayload(record: JournalRecord): ClosedTurnPlannerCallPayload | undefined {
  if (record.kind !== 'event') return undefined;
  const payload = record.payload;
  if (!payload || payload.type !== CLOSED_TURN_PLANNER_CALL_PAYLOAD) return undefined;
  return payload as unknown as ClosedTurnPlannerCallPayload;
}

function stageOf(record: ClosedTurnPlannerCallRecord): ClosedTurnPlannerCallStage {
  return record.stage;
}

function assertRecord(record: ClosedTurnPlannerCallRecord): void {
  if ((record as { kind?: string } | undefined)?.kind === 'initial-task-planner-call') {
    throw new JournalIntegrityError('unsupported abandoned initial-task-planner-call duty; reconcile its owner without rewriting history');
  }
  if (!record || typeof record !== 'object'
    || record.kind !== 'closed-turn-planner-call') {
    throw new JournalIntegrityError('closed-turn planner call record has an unknown kind');
  }
  if (record.stage !== 'prepared' && record.stage !== 'invoked' && record.stage !== 'returned') {
    throw new JournalIntegrityError('closed-turn planner call record has an unknown stage');
  }
  nonEmpty(record.duty?.dutyKey, 'closed-turn planner call duty key');
  nonEmpty(record.duty?.inputDigest, 'closed-turn planner call input digest');
  nonEmpty(record.invocationId, 'closed-turn planner call invocation id');
  if (record.duty.scope.taskId === undefined || record.duty.scope.organId.value.trim().length === 0) {
    throw new JournalIntegrityError('closed-turn planner call duty requires an organ/task scope');
  }
  if (record.duty.taskId.value !== record.duty.scope.taskId.value) {
    throw new JournalIntegrityError('closed-turn planner call duty task does not match its scope');
  }
  nonEmpty(record.duty.closureRef, 'closed-turn planner closure reference');
  if (record.duty.predecessorRevisionId === null) {
    validateTaskIdentityRecord(record.duty.identity);
    if (record.duty.identity.scope.taskId.value !== record.duty.taskId.value
      || record.duty.identity.scope.organId.value !== record.duty.scope.organId.value) {
      throw new JournalIntegrityError('first closed Planner identity does not match its duty');
    }
  } else {
    nonEmpty(record.duty.predecessorRevisionId, 'closed-turn planner predecessor revision');
  }
  if (record.stage === 'returned' && !['continue', 'complete', 'failed'].includes(record.decision)) {
    throw new JournalIntegrityError('closed-turn Planner return requires an alignment decision');
  }
}

function sameRecord(left: ClosedTurnPlannerCallRecord, right: ClosedTurnPlannerCallRecord): boolean {
  return canonicalJsonStringify(left as unknown) === canonicalJsonStringify(right as unknown);
}

function commitIdFor(dutyKey: string, stage: ClosedTurnPlannerCallStage): string {
  const identity = `${dutyKey}\0${stage}`;
  return `closed-turn-planner-call:${createHash('sha256').update(identity).digest('hex')}`;
}

function matchingRecords(records: readonly JournalRecord[], scope: ScopeRef, dutyKey: string): readonly JournalRecord[] {
  return records.filter((record) => {
    if (!inTask(record.scope, scope)) return false;
    const payload = readPayload(record);
    if (!payload) return false;
    assertRecord(payload.record);
    return payload.record.duty.dutyKey === dutyKey;
  });
}

function assertSingleDuty(records: readonly JournalRecord[], dutyKey: string): void {
  const digests = new Set<string>();
  for (const record of records) {
    const payload = readPayload(record);
    if (!payload) continue;
    digests.add(payload.record.duty.inputDigest);
  }
  if (digests.size > 1) {
    throw new JournalIntegrityError(`closed-turn planner call duty ${dutyKey} has conflicting input digests`);
  }
}

function furthest(records: readonly JournalRecord[]): JournalRecord {
  let selected: JournalRecord | undefined;
  let selectedOrder = -1;
  for (const record of records) {
    const payload = readPayload(record);
    if (!payload) continue;
    const order = STAGE_ORDER[stageOf(payload.record)];
    if (order === selectedOrder) {
      throw new JournalIntegrityError('closed-turn planner call duty has duplicate committed stages');
    }
    if (order > selectedOrder) {
      selected = record;
      selectedOrder = order;
    }
  }
  if (!selected) throw new JournalIntegrityError('closed-turn planner call duty has no committed stage');
  return selected;
}

/**
 * Serializes the Runtime typed call records into the same authoritative Organ
 * Journal. Each stage is one transaction keyed by the duty and stage, so an
 * identical retry reads back the exact committed record and a changed record
 * under the same identity conflicts instead of overwriting it.
 */
export function createJsonlClosedTurnPlannerCallJournal(input: {
  readonly journal: JsonlOrganJournal;
}): ClosedTurnPlannerCallJournalPort {
  const { journal } = input;

  async function verifiedRecords(): Promise<readonly JournalRecord[]> {
    const verification = await journal.verify();
    if (!verification.valid) {
      throw new JournalIntegrityError(verification.error ?? 'closed-turn planner call Journal is corrupt');
    }
    return verification.records;
  }

  async function read(scope: ScopeRef, dutyKey: string): Promise<ClosedTurnPlannerCallCommittedRecord | null> {
    nonEmpty(dutyKey, 'closed-turn planner call duty key');
    const matches = matchingRecords(await verifiedRecords(), scope, dutyKey);
    if (matches.length === 0) return null;
    assertSingleDuty(matches, dutyKey);
    const selected = furthest(matches);
    const payload = readPayload(selected);
    if (!payload) throw new JournalIntegrityError('closed-turn planner call record has no payload');
    assertRecord(payload.record);
    return { record: payload.record, commitRef: receipt(selected) };
  }

  async function append(record: ClosedTurnPlannerCallRecord): Promise<JournalCommitRef> {
    assertRecord(record);
    const dutyKey = record.duty.dutyKey;
    const stage = record.stage;
    const commitId = commitIdFor(dutyKey, stage);
    const scope = record.duty.scope;
    let committed: JournalCommitRef | undefined;
    let appendError: unknown;
    try {
      committed = await journal.transaction(
        ({ records }) => {
          const existing = records.find((candidate) => candidate.commitId === commitId);
          if (existing) {
            const payload = readPayload(existing);
            if (!payload || !sameRecord(payload.record, record)) {
              throw new JournalCommitConflictError(commitId, existing);
            }
            return { kind: 'existing' as const, record: existing };
          }
          const priorStages = matchingRecords(records, scope, dutyKey);
          assertSingleDuty(priorStages, dutyKey);
          const priorStage = priorStages.reduce<ClosedTurnPlannerCallStage | undefined>((latest, candidate) => {
            const payload = readPayload(candidate);
            if (!payload) return latest;
            const candidateStage = stageOf(payload.record);
            if (latest === undefined || STAGE_ORDER[candidateStage] > STAGE_ORDER[latest]) return candidateStage;
            return latest;
          }, undefined);
          if (stage === 'prepared' && priorStage !== undefined) {
            throw new JournalCommitConflictError(commitId, priorStages[0]!);
          }
          if (stage === 'invoked') {
            if (priorStage !== 'prepared') {
              throw new JournalIntegrityError('closed-turn planner invocation requires its committed preparation');
            }
            const prepared = priorStages.find((candidate) => readPayload(candidate)?.record.stage === 'prepared');
            if (prepared && readPayload(prepared)?.record.invocationId !== record.invocationId) {
              throw new JournalIntegrityError('closed-turn planner invocation does not match its prepared invocation id');
            }
          }
          if (stage === 'returned') {
            if (priorStage !== 'invoked') {
              throw new JournalIntegrityError('closed-turn planner return requires its committed invocation');
            }
            const invoked = priorStages.find((candidate) => readPayload(candidate)?.record.stage === 'invoked');
            if (invoked && readPayload(invoked)?.record.invocationId !== record.invocationId) {
              throw new JournalIntegrityError('closed-turn planner return does not match its invoked invocation id');
            }
          }
          return { kind: 'append' as const, commitId, scope };
        },
        async (plan, appendRecord) => {
          if (plan.kind === 'existing') return receipt(plan.record);
          const appended = await appendRecord({
            commitId: plan.commitId,
            kind: 'event',
            scope: plan.scope,
            payload: {
              type: CLOSED_TURN_PLANNER_CALL_PAYLOAD,
              schemaVersion: CLOSED_TURN_PLANNER_CALL_SCHEMA_VERSION,
              record,
            },
          });
          return receipt(appended);
        },
      );
    } catch (error) {
      appendError = error;
    }
    const stored = await journal.findByCommitId(commitId);
    if (stored) {
      const payload = readPayload(stored);
      if (!payload || !sameRecord(payload.record, record)) {
        throw new JournalIntegrityError('closed-turn planner call exact readback conflicts with the record');
      }
      const storedRef = receipt(stored);
      if (committed && committed.commitId !== storedRef.commitId) {
        throw new JournalIntegrityError('closed-turn planner call exact readback receipt conflicts');
      }
      return storedRef;
    }
    if (appendError) throw appendError;
    throw new JournalIntegrityError('closed-turn planner call exact readback is absent; installation held');
  }

  return { append, read };
}
