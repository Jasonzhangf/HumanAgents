import type { ActiveTurnJournalRecord } from '../../../runtime/src/context/active-turn-journal.js';
import type { ActiveTurnBinding, ChildInvocationRecord } from '../../../contracts/src/index.js';
import { isProviderToolReportRef } from '../provider-tool-execution.js';

export interface ChildToolReadSource {
  readonly binding: ActiveTurnBinding;
  readonly records: readonly ActiveTurnJournalRecord[];
}

export interface ChildToolEventRecord {
  readonly operationId: string;
  readonly executionEpoch: number;
  readonly seq: number;
  readonly eventId: string;
  readonly kind: 'provider.tool' | 'provider.tool-result';
  readonly state: string;
  readonly summary: string;
  readonly occurredAt?: string;
  readonly evidenceRefs: readonly import('../../../contracts/src/index.js').EvidenceRef[];
  readonly callId?: string;
  readonly toolId?: string;
  readonly requestId?: string;
  readonly parentRequestId?: string;
  readonly turnId?: string;
  readonly arguments?: unknown;
  readonly status?: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown';
  readonly error?: unknown;
  readonly outputRef?: string;
  readonly outputDigest?: string;
  readonly executionFact?: import('../../../contracts/src/index.js').ToolExecutionFact;
  readonly execution: { readonly runtimeId: string; readonly assignmentId: string; readonly role?: string };
}

export function childToolSources(
  parentRecords: readonly ActiveTurnJournalRecord[],
  turns: readonly ChildToolReadSource[],
  taskId: string,
): readonly { readonly invocation: ChildInvocationRecord; readonly turn: ChildToolReadSource }[] {
  const invocationById = new Map<string, ChildInvocationRecord>();
  for (const record of parentRecords) {
    if (record.kind === 'child-invocation') invocationById.set(record.record.invocationId, record.record);
  }
  const selected: { invocation: ChildInvocationRecord; turn: ChildToolReadSource }[] = [];
  for (const invocation of invocationById.values()) {
    const incarnation = invocation.incarnation;
    if (incarnation === undefined || incarnation.taskId.value !== taskId) continue;
    // The invocation carries a dispatch handle. The admitted turn has its
    // own ID and is linked to the invocation by the acquired assignment.
    const matches = turns.filter(({ binding }) => binding.admittedTurn.taskRef.value === taskId
      && binding.admittedTurn.workAssignmentRef === incarnation.assignmentId
      && binding.admittedTurn.executionEpoch === incarnation.executionEpoch
      && binding.execution.runtimeId === incarnation.runtimeId
      && binding.execution.executionEpoch === incarnation.executionEpoch
      && binding.assignment.assignmentId === incarnation.assignmentId
      && binding.assignment.executionEpoch === incarnation.executionEpoch
      && binding.assignment.taskId.value === taskId);
    if (matches.length === 1) selected.push({ invocation, turn: matches[0]! });
  }
  return selected;
}

export function childToolEventRecords(
  selected: readonly { readonly invocation: ChildInvocationRecord; readonly turn: ChildToolReadSource }[],
): readonly ChildToolEventRecord[] {
  const records: ChildToolEventRecord[] = [];
  for (const { invocation, turn } of selected) {
    const incarnation = invocation.incarnation;
    if (incarnation === undefined) continue;
    const operationId = turn.binding.scope.operationId?.value;
    if (operationId === undefined) continue;
    const accepted = turn.records.flatMap((record) => record.kind === 'accepted-fact' ? [record.entry] : []);
    const calls = new Map<string, Extract<import('../../../contracts/src/index.js').ProviderRawFact, { readonly kind: 'tool-call' }>>();
    for (const entry of accepted) {
      const fact = entry.envelope.fact;
      if (fact.kind === 'tool-call') {
        calls.set(JSON.stringify([entry.envelope.request.requestId, fact.call.callId, fact.call.continuationRef]), fact);
      }
    }
    for (const entry of accepted) {
      const fact = entry.envelope.fact;
      if (fact.kind === 'tool-call') {
        const request = entry.envelope.request;
        records.push({
          operationId,
          executionEpoch: incarnation.executionEpoch,
          seq: entry.seq,
          eventId: `child-tool-call:${turn.binding.admittedTurn.turnId}:${entry.seq}`,
          kind: 'provider.tool',
          state: 'tool',
          summary: `${fact.call.toolId} 调用`,
          evidenceRefs: [],
          callId: fact.call.callId,
          toolId: fact.call.toolId,
          requestId: request.requestId,
          parentRequestId: request.parentRequestId,
          turnId: request.turnId,
          arguments: fact.call.arguments,
          execution: { runtimeId: incarnation.runtimeId, assignmentId: incarnation.assignmentId, role: incarnation.roleId },
        });
      } else if (fact.kind === 'tool-result') {
        const request = entry.envelope.request;
        const call = calls.get(JSON.stringify([request.requestId, fact.callId, fact.continuationRef]));
        if (call?.call.toolId !== fact.result.toolId) continue;
        const { outputRef, outputDigest } = fact.result;
        records.push({
          operationId,
          executionEpoch: incarnation.executionEpoch,
          seq: entry.seq,
          eventId: `child-tool-result:${turn.binding.admittedTurn.turnId}:${entry.seq}`,
          kind: 'provider.tool-result',
          state: fact.result.status,
          summary: `${fact.result.toolId} 返回`,
          evidenceRefs: [...fact.result.evidenceRefs],
          callId: fact.callId,
          toolId: fact.result.toolId,
          requestId: request.requestId,
          parentRequestId: request.parentRequestId,
          turnId: request.turnId,
          status: fact.result.status,
          error: fact.result.error,
          ...(isProviderToolReportRef(outputRef) && outputDigest !== undefined ? { outputRef, outputDigest } : {}),
          executionFact: fact.result.executionFact,
          execution: { runtimeId: incarnation.runtimeId, assignmentId: incarnation.assignmentId, role: incarnation.roleId },
        });
      }
    }
  }
  return records;
}
