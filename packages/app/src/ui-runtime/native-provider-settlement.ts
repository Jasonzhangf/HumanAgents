import type { JsonlOrganJournal, JournalRecord } from '../../../adapters/jsonl/src/index.js';
import { canonicalJsonStringify, type ScopeRef } from '../../../contracts/src/index.js';
import type { ActiveTurnProviderExecutionIdentityRef } from '../../../contracts/src/active-turn-context.js';
import type { RuntimeTaskProviderSettlementReadPort } from '../../../runtime/src/ui-runtime/coordinator.js';
import type { PreparedExecutionStopFact } from './prepared-execution-stop.js';

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

/** Close custody is separate from the native capture; follow its exact commit links. */
function resourceCloses(records: readonly JournalRecord[], scope: ScopeRef,
  execution: ActiveTurnProviderExecutionIdentityRef): readonly JournalRecord[] {
  const facts = records.flatMap((record) => {
    if (record.payload?.['kind'] !== 'prepared-execution-stop/v1' || !same(record.scope, scope)) return [];
    return [{ record, fact: record.payload['fact'] as PreparedExecutionStopFact }];
  });
  const exact = (ref: { commitId: string; journalSeq: number; recordDigest: string }) => facts.find(({ record }) =>
    record.commitId === ref.commitId && record.seq === ref.journalSeq && record.recordDigest === ref.recordDigest);
  return facts.flatMap(({ record, fact }) => {
    if (fact.kind !== 'resource-closed' || fact.receipt.state !== 'closed') return [];
    const acquisition = exact(fact.acquisition);
    if (acquisition?.fact.kind !== 'resource-acquired') return [];
    const preparation = exact(acquisition.fact.resource.preparation);
    if (preparation?.fact.kind !== 'preparation-entered') return [];
    const allocation = preparation.fact.allocation;
    const binding = acquisition.fact.resource.binding;
    return allocation.runtimeId === execution.runtimeId && allocation.executionEpoch === execution.executionEpoch
      && same(allocation.scope, scope) && same(allocation.taskId, scope.taskId)
      && same(allocation.operationId, scope.operationId)
      && binding.bindingId === fact.receipt.bindingId && binding.providerId === fact.receipt.providerId
      && binding.protocol === fact.receipt.protocol && preparation.record.seq < acquisition.record.seq
      && acquisition.record.seq < record.seq ? [record] : [];
  });
}

/** The cold-source owner supplies the exact typed capture, including v2. */
export function createNativeProviderSettlementReader(input: {
  readonly journal: Pick<JsonlOrganJournal, 'verify'>;
  readonly now: () => Date;
}): RuntimeTaskProviderSettlementReadPort {
  return {
    async read(readInput) {
      const unknown = (reason: string) => ({ state: 'unknown' as const, reason });
      const capture = readInput.currentSegment;
      if (capture === null) return unknown('the cold source tail has no committed recovery-assets receipt; an older completed stream cannot settle the newer attempt');
      const { body, producerDrains } = capture.source.prepared;
      const receipt = capture.source.receipt;
      const businessTurnId = capture.version === 1 ? capture.source.receipt.turnId : capture.source.receipt.businessTurnId;
      const execution = body.binding.execution;
      if (businessTurnId !== readInput.turnId || !same(body.binding.scope, readInput.scope)
        || !same(body.binding.assignment.taskId, readInput.taskId)
        || receipt.boundaryId !== body.cut.pauseId) return unknown('the exact capture does not match the selected business turn, scope and boundary');
      const drains = producerDrains.filter((drain) => same(drain.execution, execution) && drain.boundaryId === receipt.boundaryId);
      if (drains.length !== 1) return unknown('no unique exact producer drain is committed for the current segment');
      const drain = drains[0]!;
      if (drain.requests.length === 0) return unknown('the exact producer drain carries no request');
      const accepted = body.entries.filter((entry) => 'envelope' in entry);
      const prefixes = drain.requests.map((request) => {
        const matching = accepted.filter((entry) => same(entry.envelope.execution, execution)
          && same(entry.envelope.scope, readInput.scope) && same(entry.envelope.request, request.request)
          && entry.envelope.producerSeq === request.lastProducerSeq);
        return matching.length === 1 ? { request, last: matching[0]! } : undefined;
      });
      if (prefixes.some((prefix) => prefix === undefined)) return unknown('a drained Provider request prefix is incomplete at its exact final sequence');
      const terminal = prefixes.reduce((latest, candidate) => !latest || candidate!.last.seq > latest.last.seq ? candidate : latest)!;
      if (terminal.last.envelope.fact.kind !== 'request-complete' || terminal.last.envelope.fact.terminal !== 'completed') {
        return unknown('the latest drained request does not end in an authoritative completed terminal');
      }
      const verification = await input.journal.verify();
      if (!verification.valid) throw new Error(`native Provider settlement read requires a verified Organ Journal: ${verification.error ?? 'unknown'}`);
      const carrier = verification.records.find((record) => record.commitId === receipt.commitIdentity
        && record.seq === receipt.journalSeq && record.recordDigest === receipt.recordDigest);
      if (!carrier || !same(carrier.scope, readInput.scope)) return unknown('the exact capture receipt has no matching committed Journal carrier');
      const closes = resourceCloses(verification.records, readInput.scope, execution)
        .filter((record) => record.seq > receipt.journalSeq);
      if (closes.length !== 1) return unknown('no unique matching committed resource close follows the current capture');
      return { state: 'verified', receipts: [{ providerRequestId: terminal.request.request.requestId,
        state: 'settled', verifiedBy: 'response-stream-eof', verifiedAt: input.now().toISOString() }] };
    },
  };
}
