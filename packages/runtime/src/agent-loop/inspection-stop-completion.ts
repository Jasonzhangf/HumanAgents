import type {
  BusinessCycleClosedRecord,
  InspectionOccurrenceOpenedRecord,
  InspectionOccurrenceSettledRecord,
  JournalCommitRef,
  NextAction,
} from '../../../contracts/src/index.js';
import { canonicalJsonStringify } from '../../../contracts/src/index.js';
import type { CommittedCheckpointRecord } from '../checkpoints/ports.js';
import type {
  RuntimeInspectionStopCompletion,
  RuntimeInspectionStopSettlementPort,
} from '../ui-runtime/coordinator.js';
import { AgentLoopRuntimeError } from './errors.js';
import type {
  InspectionBoundaryPort,
  InspectionOccurrenceFacts,
  InspectionOccurrenceReadPort,
} from './inspection-turn-boundary.js';

export interface RuntimeInspectionStopCompletionDependencies {
  readonly boundary: Pick<InspectionBoundaryPort, 'settleStop'>;
  readonly occurrences: Pick<InspectionOccurrenceReadPort, 'readOccurrencesForStop'>;
}

interface CompletionEvidence {
  readonly complete: boolean;
  readonly settlementCommitRef?: JournalCommitRef;
  readonly closeCommitRef?: JournalCommitRef;
}

export function hasMatchingInspectionCloseIdentity(input: {
  readonly close: BusinessCycleClosedRecord;
  readonly checkpoint: CommittedCheckpointRecord;
  readonly cycleOpeningCommitRef: JournalCommitRef;
  readonly settlementCommitRef: JournalCommitRef | undefined;
  readonly next: NextAction;
}): boolean {
  const { close, checkpoint } = input;
  return sameRef(close.openedCommitRef, input.cycleOpeningCommitRef)
    && close.cycleId.value === checkpoint.checkpoint.cycleId.value
    && sameRef(close.checkpointCommitRef, checkpoint.commitRef)
    && close.inspectionSettlementCommitRef !== undefined
    && input.settlementCommitRef !== undefined
    && sameRef(close.inspectionSettlementCommitRef, input.settlementCommitRef)
    && close.outcome === input.next.kind
    && JSON.stringify(close.next) === JSON.stringify(input.next);
}

export function createRuntimeInspectionStopSettlementPort(
  dependencies: RuntimeInspectionStopCompletionDependencies,
): RuntimeInspectionStopSettlementPort {
  return {
    async settleStop(input): Promise<RuntimeInspectionStopCompletion> {
      const receipt = await dependencies.boundary.settleStop({ checkpoint: input.checkpoint });
      if (receipt.settlementCommitRefs.length === 0 && receipt.cycleClosedCommitRef === undefined) {
        return { state: 'not-applicable' };
      }
      return receipt.cycleClosedCommitRef === undefined
        ? { state: 'complete', settlementCommitRefs: receipt.settlementCommitRefs }
        : {
            state: 'complete',
            settlementCommitRefs: receipt.settlementCommitRefs,
            cycleClosedCommitRef: receipt.cycleClosedCommitRef,
          };
    },

    async readStopCompletion(input): Promise<RuntimeInspectionStopCompletion> {
      if (input.checkpoint.checkpoint.outcome !== 'stopped') {
        throw new AgentLoopRuntimeError('invalid-state', 'inspection stop completion requires a stopped checkpoint');
      }
      const occurrences = await dependencies.occurrences.readOccurrencesForStop({ checkpoint: input.checkpoint });
      if (occurrences.length === 0) return { state: 'not-applicable' };

      const settlementCommitRefs: JournalCommitRef[] = [];
      let cycleClosedCommitRef: JournalCommitRef | undefined;
      let complete = true;
      for (const occurrence of occurrences) {
        const evidence = inspectCompletion(input.checkpoint, occurrence);
        complete &&= evidence.complete;
        if (evidence.settlementCommitRef !== undefined) settlementCommitRefs.push(evidence.settlementCommitRef);
        if (evidence.closeCommitRef !== undefined) {
          if (cycleClosedCommitRef !== undefined && !sameRef(cycleClosedCommitRef, evidence.closeCommitRef)) {
            throw new AgentLoopRuntimeError('conflict', 'inspection stop completion has conflicting cycle close receipts');
          }
          cycleClosedCommitRef = evidence.closeCommitRef;
        }
      }
      if (!complete) return cycleClosedCommitRef === undefined
        ? { state: 'recovery-required', settlementCommitRefs }
        : { state: 'recovery-required', settlementCommitRefs, cycleClosedCommitRef };
      return cycleClosedCommitRef === undefined
        ? { state: 'complete', settlementCommitRefs }
        : { state: 'complete', settlementCommitRefs, cycleClosedCommitRef };
    },
  };
}

function inspectCompletion(
  checkpoint: CommittedCheckpointRecord,
  occurrence: InspectionOccurrenceFacts,
): CompletionEvidence {
  const { opening, cycleOpening, settlement, close } = occurrence;
  if (!sameRef(opening.record.cycleOpenedCommitRef, cycleOpening.commitRef)
    || cycleOpening.record.cycle.id.value !== checkpoint.checkpoint.cycleId.value) {
    throw new AgentLoopRuntimeError('conflict', 'inspection occurrence does not match its cycle opening');
  }

  const itemRefs: JournalCommitRef[] = [];
  let itemsComplete = true;
  for (const pending of occurrence.deliveries) {
    const itemRef = matchingItemRef(occurrence, pending);
    if (itemRef === null) itemsComplete = false;
    else itemRefs.push(itemRef);
  }

  if (settlement === undefined) {
    return {
      complete: false,
      ...(close === undefined ? {} : { closeCommitRef: close.commitRef }),
    };
  }
  assertSettlement(checkpoint, occurrence, settlement);
  if (itemsComplete && !sameRefs(settlement.record.itemResultCommitRefs, itemRefs)) {
    throw new AgentLoopRuntimeError('conflict', 'inspection settlement item receipts do not match accepted deliveries');
  }
  if (!itemsComplete) return { complete: false, settlementCommitRef: settlement.commitRef };
  if (close === undefined) return { complete: false, settlementCommitRef: settlement.commitRef };
  assertClose(checkpoint, occurrence, close, settlement.commitRef);
  return { complete: true, settlementCommitRef: settlement.commitRef, closeCommitRef: close.commitRef };
}

function matchingItemRef(
  occurrence: InspectionOccurrenceFacts,
  pending: InspectionOccurrenceFacts['deliveries'][number],
): JournalCommitRef | null {
  if (pending.invocation.binding.kind !== 'execution' || pending.invocation.binding.inspection === undefined) {
    throw new AgentLoopRuntimeError('conflict', 'accepted inspection delivery has no inspection invocation binding');
  }
  const delivery = pending.delivery.inspectionDelivery;
  if (delivery === undefined) return null;
  const matches = occurrence.items.filter((item) => item.record.delivery.resultId === delivery.resultId);
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new AgentLoopRuntimeError('conflict', 'inspection stop completion has duplicate item results');
  }
  const item = matches[0]!;
  if (canonicalJsonStringify(item.record.binding) !== canonicalJsonStringify(pending.invocation.binding.inspection.binding)
    || canonicalJsonStringify(item.record.delivery) !== canonicalJsonStringify(delivery)) {
    throw new AgentLoopRuntimeError('conflict', 'inspection item result does not match its accepted delivery');
  }
  return item.commitRef;
}

function assertSettlement(
  checkpoint: CommittedCheckpointRecord,
  occurrence: InspectionOccurrenceFacts,
  settlement: NonNullable<InspectionOccurrenceFacts['settlement']>,
): void {
  assertOpeningIdentity(occurrence.opening.record, settlement.record);
  if (!sameRef(settlement.record.checkpointCommitRef, checkpoint.commitRef)
    || settlement.record.occurrence.occurrenceId !== occurrence.opening.record.occurrence.occurrenceId
    || !sameRef(settlement.record.openingCommitRef, occurrence.opening.commitRef)) {
    throw new AgentLoopRuntimeError('conflict', 'inspection settlement does not match its stop checkpoint or opening');
  }
}

function assertOpeningIdentity(
  opening: InspectionOccurrenceOpenedRecord,
  settlement: InspectionOccurrenceSettledRecord,
): void {
  if (settlement.occurrence.occurrenceId !== opening.occurrence.occurrenceId
    || settlement.definition.definitionId !== opening.definition.definitionId
    || settlement.definition.definitionVersion !== opening.definition.definitionVersion) {
    throw new AgentLoopRuntimeError('conflict', 'inspection settlement does not match its occurrence opening');
  }
}

function assertClose(
  checkpoint: CommittedCheckpointRecord,
  occurrence: InspectionOccurrenceFacts,
  close: NonNullable<InspectionOccurrenceFacts['close']>,
  settlementCommitRef: JournalCommitRef,
): void {
  assertCloseIdentity(close.record, checkpoint, occurrence.cycleOpening.commitRef, settlementCommitRef);
}

function assertCloseIdentity(
  close: BusinessCycleClosedRecord,
  checkpoint: CommittedCheckpointRecord,
  cycleOpeningCommitRef: JournalCommitRef,
  settlementCommitRef: JournalCommitRef | undefined,
): void {
  if (!hasMatchingInspectionCloseIdentity({ close, checkpoint, cycleOpeningCommitRef, settlementCommitRef,
    next: { kind: 'stop' } })) {
    throw new AgentLoopRuntimeError('conflict', 'inspection cycle close does not match the stop settlement');
  }
}

function sameRef(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function sameRefs(left: readonly JournalCommitRef[], right: readonly JournalCommitRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => sameRef(ref, right[index]!));
}
