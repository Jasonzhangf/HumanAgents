import type {
  AcceptedExecutionChildDelivery,
  AdmittedTurnIdentity,
  BusinessCycleClosedRecord,
  BusinessCycleOpenedRecord,
  ChildInvocationRecord,
  ExecutionChildCallBinding,
  I2JournalPort,
  InspectionExecutionBinding,
  InspectionExecutionOutcome,
  InspectionItemDelivery,
  InspectionItemResultRecord,
  InspectionOccurrenceOpenedRecord,
  InspectionOccurrenceRef,
  InspectionOccurrenceSettledRecord,
  JournalCommitRef,
  NextAction,
  PublishedTaskPlanRevision,
  ScopeRef,
  TurnClosureReference,
  WorkAssignment,
} from '../../../contracts/src/index.js';
import {
  validateInspectionExecutionOutcome,
  validateInspectionItemDelivery,
  validateInspectionItemResultRecord,
} from '../../../contracts/src/i2-history.js';
import type { CommittedCheckpointRecord, NativeCheckpointJournalPort } from '../checkpoints/ports.js';
import { AgentLoopRuntimeError } from './errors.js';

export interface InspectionClock {
  now(): Date;
}

export interface InspectionSelectionContext {
  readonly turn: AdmittedTurnIdentity;
  readonly plan: PublishedTaskPlanRevision;
  readonly planCommitRef: JournalCommitRef;
  readonly cycleOpening: BusinessCycleOpenedRecord;
  readonly cycleOpenedCommitRef: JournalCommitRef;
}

export interface InspectionSettlementReceipt {
  readonly settlementCommitRefs: readonly JournalCommitRef[];
  readonly cycleClosedCommitRef?: JournalCommitRef;
}

export interface InspectionSelectionReader {
  readSelectionContext(logicalTurnId: string): Promise<InspectionSelectionContext>;
}

export interface InspectionOccurrenceOpeningPort {
  open(input: {
    readonly context: InspectionSelectionContext;
    readonly logicalTurnId: string;
    readonly executionScope: ScopeRef;
    readonly assignment: WorkAssignment;
    readonly checkId: string;
  }): Promise<NonNullable<ExecutionChildCallBinding['inspection']>>;
}

export interface InspectionAcceptedDeliveryReader {
  readAcceptedDelivery(invocationId: string): Promise<AcceptedExecutionChildDelivery | null>;
}

export interface InspectionAcceptedDeliveryPort {
  accept(input: {
    readonly invocation: ChildInvocationRecord;
    readonly delivery: AcceptedExecutionChildDelivery;
  }): Promise<InspectionItemDelivery | null>;
}

export interface InspectionOccurrenceFacts {
  readonly logicalTurnId: string;
  readonly opening: {
    readonly record: InspectionOccurrenceOpenedRecord;
    readonly commitRef: JournalCommitRef;
  };
  readonly cycleOpening: {
    readonly record: BusinessCycleOpenedRecord;
    readonly commitRef: JournalCommitRef;
  };
  readonly deliveries: readonly {
    readonly invocation: ChildInvocationRecord;
    readonly delivery: AcceptedExecutionChildDelivery;
  }[];
  readonly items: readonly {
    readonly record: InspectionItemResultRecord;
    readonly commitRef: JournalCommitRef;
  }[];
  readonly definition?: {
    readonly record: import('../../../contracts/src/index.js').DurableInspectionDefinition;
    readonly commitRef: JournalCommitRef;
  };
  readonly settlement?: {
    readonly record: InspectionOccurrenceSettledRecord;
    readonly commitRef: JournalCommitRef;
  };
  readonly close?: {
    readonly record: BusinessCycleClosedRecord;
    readonly commitRef: JournalCommitRef;
  };
}

export interface InspectionOccurrenceReadPort {
  readOccurrenceForTurn(input: {
    readonly logicalTurnId: string;
    readonly taskScope: InspectionOccurrenceRef['scope'];
  }): Promise<InspectionOccurrenceFacts | null>;
  readOccurrencesForStop(input: {
    readonly checkpoint: CommittedCheckpointRecord;
  }): Promise<readonly InspectionOccurrenceFacts[]>;
}

export interface InspectionBoundaryPort {
  select(input: {
    readonly logicalTurnId: string;
    readonly context: InspectionSelectionContext;
    readonly executionScope: ScopeRef;
    readonly assignment: WorkAssignment;
    readonly checkId: string;
  }): Promise<NonNullable<ExecutionChildCallBinding['inspection']>>;

  acceptDelivery(input: {
    readonly invocation: ChildInvocationRecord;
    readonly delivery: AcceptedExecutionChildDelivery;
  }): Promise<JournalCommitRef | null>;

  settleClosure(input: {
    readonly logicalTurnId: string;
    readonly closure: TurnClosureReference;
    readonly checkpoint: CommittedCheckpointRecord;
    readonly next: NextAction;
    readonly milestoneAlignmentCommitRefs: readonly JournalCommitRef[];
  }): Promise<InspectionSettlementReceipt>;

  settleStop(input: {
    readonly checkpoint: CommittedCheckpointRecord;
  }): Promise<InspectionSettlementReceipt>;
}

export interface InspectionTurnBoundaryDependencies {
  readonly selectionReader: InspectionSelectionReader;
  readonly journal: I2JournalPort;
  readonly occurrenceOpening: InspectionOccurrenceOpeningPort;
  readonly acceptedDeliveryReader: InspectionAcceptedDeliveryReader;
  readonly acceptedDelivery: InspectionAcceptedDeliveryPort;
  readonly occurrences: InspectionOccurrenceReadPort;
  readonly checkpoints: Pick<NativeCheckpointJournalPort, 'readCommitted' | 'readCheckpointRecoveryBinding' | 'readNativeCheckpoint'>;
  readonly clock: InspectionClock;
}

export class InspectionTurnBoundary implements InspectionBoundaryPort {
  private readonly selections = new Map<string, Promise<NonNullable<ExecutionChildCallBinding['inspection']>>>();
  private readonly deliveries = new Map<string, Promise<JournalCommitRef | null>>();
  private readonly settlementOps = new Map<string, Promise<{ readonly record: InspectionOccurrenceSettledRecord; readonly commitRef: JournalCommitRef }>>();
  private readonly cycleCloseOps = new Map<string, Promise<JournalCommitRef | undefined>>();
  private readonly itemCommits = new Map<string, Promise<JournalCommitRef>>();

  constructor(private readonly dependencies: InspectionTurnBoundaryDependencies) {}

  async select(input: {
    readonly logicalTurnId: string;
    readonly context: InspectionSelectionContext;
    readonly executionScope: ScopeRef;
    readonly assignment: WorkAssignment;
    readonly checkId: string;
  }): Promise<NonNullable<ExecutionChildCallBinding['inspection']>> {
    const key = JSON.stringify(input);
    const existing = this.selections.get(key);
    if (existing) return existing;
    const selection = this.selectOnce(input);
    this.selections.set(key, selection);
    try {
      return await selection;
    } finally {
      if (this.selections.get(key) === selection) this.selections.delete(key);
    }
  }

  async acceptDelivery(input: {
    readonly invocation: ChildInvocationRecord;
    readonly delivery: AcceptedExecutionChildDelivery;
  }): Promise<JournalCommitRef | null> {
    const key = JSON.stringify(input);
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const acceptance = this.acceptDeliveryOnce(input);
    this.deliveries.set(key, acceptance);
    try {
      return await acceptance;
    } finally {
      if (this.deliveries.get(key) === acceptance) this.deliveries.delete(key);
    }
  }

  private async acceptDeliveryOnce(input: {
    readonly invocation: ChildInvocationRecord;
    readonly delivery: AcceptedExecutionChildDelivery;
  }): Promise<JournalCommitRef | null> {
    if (input.invocation.binding.kind !== 'execution' || input.invocation.binding.inspection === undefined) {
      return null;
    }
    const binding = input.invocation.binding.inspection.binding;
    const accepted = await this.dependencies.acceptedDeliveryReader.readAcceptedDelivery(input.invocation.invocationId);
    if (accepted === null) {
      throw new AgentLoopRuntimeError('invalid-state', 'inspection delivery has no durable parent acceptance');
    }
    if (accepted.invocationId !== input.delivery.invocationId || JSON.stringify(accepted) !== JSON.stringify(input.delivery)) {
      throw new AgentLoopRuntimeError('conflict', 'inspection delivery does not match the durable parent acceptance');
    }
    if (accepted.inspectionDelivery === undefined
      || accepted.inspectionDelivery.resultId !== `inspection-result:${input.invocation.invocationId}`) {
      throw new AgentLoopRuntimeError('invalid-state', 'inspection delivery has no exact item result identity');
    }
    const existing = await this.findItem(binding.occurrence, input.invocation.invocationId);
    if (existing !== null) {
      if (JSON.stringify(existing.record.binding) !== JSON.stringify(binding)
        || JSON.stringify(existing.record.delivery) !== JSON.stringify(accepted.inspectionDelivery)) {
        throw new AgentLoopRuntimeError('conflict', 'durable inspection item conflicts with the accepted delivery');
      }
      return existing.commitRef;
    }
    const acceptedItem = await this.dependencies.acceptedDelivery.accept({ invocation: input.invocation, delivery: accepted });
    if (acceptedItem === null) return null;
    if (JSON.stringify(acceptedItem) !== JSON.stringify(accepted.inspectionDelivery)) {
      throw new AgentLoopRuntimeError('conflict', 'accepted inspection check changed the durable delivery');
    }
    return this.commitItem(binding, acceptedItem);
  }

  async settleClosure(input: {
    readonly logicalTurnId: string;
    readonly closure: TurnClosureReference;
    readonly checkpoint: CommittedCheckpointRecord;
    readonly next: NextAction;
    readonly milestoneAlignmentCommitRefs: readonly JournalCommitRef[];
  }): Promise<InspectionSettlementReceipt> {
    const committedAt = await this.assertExactCheckpoint(input.checkpoint);
    if (input.closure.identity.turnId !== input.logicalTurnId
      || input.closure.checkpointId.value !== input.checkpoint.checkpoint.id.value
      || input.closure.checkpointId.scope !== input.checkpoint.checkpoint.id.scope
      || JSON.stringify(input.next) !== JSON.stringify(input.checkpoint.checkpoint.next)) {
      throw new AgentLoopRuntimeError('conflict', 'inspection closure, checkpoint, or next action conflicts');
    }
    const settlementOutcome = closureOutcome(input.closure);
    if (settlementOutcome.declaredOutcome !== undefined) {
      validateInspectionExecutionOutcome(settlementOutcome.declaredOutcome);
    }
    const occurrence = await this.dependencies.occurrences.readOccurrenceForTurn({
      logicalTurnId: input.logicalTurnId,
      taskScope: taskScopeOf(input.checkpoint.checkpoint.scope),
    });
    if (occurrence === null) return { settlementCommitRefs: [] };
    const settlement = await this.settleOccurrence({
      occurrence,
      checkpoint: input.checkpoint,
      committedAt,
      ...settlementOutcome,
    });
    const cycleClosedCommitRef = await this.closeCycleIfTerminal({
      checkpoint: input.checkpoint,
      cycleOpeningCommitRef: occurrence.cycleOpening.commitRef,
      next: input.next,
      alignmentRefs: input.milestoneAlignmentCommitRefs,
      settlement: settlement.commitRef,
      existingClose: occurrence.close,
      committedAt,
    });
    return cycleClosedCommitRef === undefined
      ? { settlementCommitRefs: [settlement.commitRef] }
      : { settlementCommitRefs: [settlement.commitRef], cycleClosedCommitRef };
  }

  async settleStop(input: {
    readonly checkpoint: CommittedCheckpointRecord;
  }): Promise<InspectionSettlementReceipt> {
    const committedAt = await this.assertExactCheckpoint(input.checkpoint);
    if (input.checkpoint.checkpoint.outcome !== 'stopped') {
      throw new AgentLoopRuntimeError('invalid-state', 'inspection stop settlement requires a committed stopped checkpoint');
    }
    const binding = await this.dependencies.checkpoints.readCheckpointRecoveryBinding(
      input.checkpoint.checkpoint.scope,
      input.checkpoint.commitRef,
    );
    if (binding === null) {
      throw new AgentLoopRuntimeError('invalid-state', 'committed stopped checkpoint has no recovery binding');
    }
    const occurrences = await this.dependencies.occurrences.readOccurrencesForStop({ checkpoint: input.checkpoint });
    const settlementCommitRefs: JournalCommitRef[] = [];
    let cycleClosedCommitRef: JournalCommitRef | undefined;
    for (const occurrence of occurrences) {
      const settlement = await this.settleOccurrence({
        occurrence,
        checkpoint: input.checkpoint,
        committedAt,
        outcome: { status: 'unknown', reason: 'inspection stopped after the execution checkpoint; missing checks retain unknown side effects' },
      });
      settlementCommitRefs.push(settlement.commitRef);
      cycleClosedCommitRef = await this.closeCycleIfTerminal({
        checkpoint: input.checkpoint,
        cycleOpeningCommitRef: occurrence.cycleOpening.commitRef,
        next: { kind: 'stop' },
        alignmentRefs: [],
        settlement: settlement.commitRef,
        existingClose: occurrence.close,
        committedAt,
      }) ?? cycleClosedCommitRef;
    }
    return cycleClosedCommitRef === undefined
      ? { settlementCommitRefs }
      : { settlementCommitRefs, cycleClosedCommitRef };
  }

  private async selectOnce(input: {
    readonly logicalTurnId: string;
    readonly context: InspectionSelectionContext;
    readonly executionScope: ScopeRef;
    readonly assignment: WorkAssignment;
    readonly checkId: string;
  }): Promise<NonNullable<ExecutionChildCallBinding['inspection']>> {
    const durable = await this.dependencies.selectionReader.readSelectionContext(input.logicalTurnId);
    if (!sameSelectionContext(durable, input.context)) {
      throw new AgentLoopRuntimeError('conflict', 'inspection selection context does not match the durable turn binding');
    }
    const selected = await this.dependencies.occurrenceOpening.open({
      context: durable,
      logicalTurnId: input.logicalTurnId,
      executionScope: input.executionScope,
      assignment: input.assignment,
      checkId: input.checkId,
    });
    if (selected.check.checkId !== input.checkId) {
      throw new AgentLoopRuntimeError('conflict', 'opened inspection check conflicts with the selected check');
    }
    return selected;
  }

  private async settleOccurrence(input: {
    readonly occurrence: InspectionOccurrenceFacts;
    readonly checkpoint: CommittedCheckpointRecord;
    readonly committedAt: string;
    readonly outcome: InspectionExecutionOutcome;
    readonly declaredOutcome?: InspectionExecutionOutcome;
  }): Promise<{ readonly record: InspectionOccurrenceSettledRecord; readonly commitRef: JournalCommitRef }> {
    const key = `${commitKey(input.checkpoint.commitRef)}\u0000${input.occurrence.opening.record.occurrence.occurrenceId}`;
    const running = this.settlementOps.get(key);
    if (running) return running;
    const pending = this.settleOccurrenceOnce(input);
    this.settlementOps.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.settlementOps.get(key) === pending) this.settlementOps.delete(key);
    }
  }

  private async settleOccurrenceOnce(input: {
    readonly occurrence: InspectionOccurrenceFacts;
    readonly checkpoint: CommittedCheckpointRecord;
    readonly committedAt: string;
    readonly outcome: InspectionExecutionOutcome;
    readonly declaredOutcome?: InspectionExecutionOutcome;
  }): Promise<{ readonly record: InspectionOccurrenceSettledRecord; readonly commitRef: JournalCommitRef }> {
    const durableSettlement = await this.findSettlement(input.occurrence.opening.record.occurrence, input.checkpoint.commitRef);
    const itemRefs: JournalCommitRef[] = [];
    const seen = new Set<string>();
    for (const item of input.occurrence.items) {
      validateInspectionItemResultRecord(item.record);
      if (seen.has(item.record.delivery.checkId)) {
        throw new AgentLoopRuntimeError('conflict', 'inspection occurrence has duplicate durable item results');
      }
      seen.add(item.record.delivery.checkId);
      itemRefs.push(item.commitRef);
    }
    for (const pending of input.occurrence.deliveries) {
      if (pending.invocation.binding.kind !== 'execution') continue;
      const binding = pending.invocation.binding.inspection?.binding;
      if (binding === undefined || pending.delivery.inspectionDelivery === undefined) continue;
      if (seen.has(pending.delivery.inspectionDelivery.checkId)) continue;
      const existing = await this.findItem(binding.occurrence, pending.delivery.invocationId);
      if (existing !== null) {
        if (JSON.stringify(existing.record.binding) !== JSON.stringify(binding)
          || JSON.stringify(existing.record.delivery) !== JSON.stringify(pending.delivery.inspectionDelivery)) {
          throw new AgentLoopRuntimeError('conflict', 'durable inspection item conflicts with a retained delivery');
        }
        itemRefs.push(existing.commitRef);
        seen.add(existing.record.delivery.checkId);
        continue;
      }
      const delivery = await this.dependencies.acceptedDelivery.accept({ ...pending });
      if (delivery === null) {
        throw new AgentLoopRuntimeError('invalid-state', 'accepted inspection delivery returned no item result');
      }
      const itemRef = await this.commitItem(binding, delivery);
      itemRefs.push(itemRef);
      seen.add(delivery.checkId);
    }
    const existing = durableSettlement ?? input.occurrence.settlement ?? null;
    if (existing !== null) {
      if (!sameCommit(existing.record.checkpointCommitRef, input.checkpoint.commitRef)) {
        throw new AgentLoopRuntimeError('conflict', 'inspection settlement binds a different checkpoint');
      }
      if (!sameRefs(existing.record.itemResultCommitRefs, itemRefs)) {
        throw new AgentLoopRuntimeError('conflict', 'inspection settlement item receipts conflict with durable deliveries');
      }
      if (input.declaredOutcome !== undefined && !sameOutcome(existing.record.outcome, input.declaredOutcome)) {
        throw new AgentLoopRuntimeError('conflict', 'inspection settlement outcome conflicts with the declared closure outcome');
      }
      return { record: existing.record, commitRef: existing.commitRef };
    }
    const opened = input.occurrence.opening.record;
    const record: InspectionOccurrenceSettledRecord = {
      kind: 'inspection-occurrence-settled',
      schemaVersion: 1,
      openingCommitRef: input.occurrence.opening.commitRef,
      occurrence: opened.occurrence,
      definition: opened.definition,
      itemResultCommitRefs: itemRefs,
      outcome: input.outcome,
      checkpointCommitRef: input.checkpoint.commitRef,
      settledAt: input.committedAt,
    };
    const committed = await this.dependencies.journal.commit(record);
    return { record, commitRef: committed };
  }

  private async commitItem(
    binding: InspectionExecutionBinding,
    delivery: InspectionItemDelivery,
  ): Promise<JournalCommitRef> {
    const key = `${binding.occurrence.occurrenceId}\u0000${delivery.resultId}`;
    const existing = this.itemCommits.get(key);
    if (existing) return existing;
    const commit = this.commitItemOnce(binding, delivery);
    this.itemCommits.set(key, commit);
    try {
      return await commit;
    } finally {
      if (this.itemCommits.get(key) === commit) this.itemCommits.delete(key);
    }
  }

  private async commitItemOnce(
    binding: InspectionExecutionBinding,
    delivery: InspectionItemDelivery,
  ): Promise<JournalCommitRef> {
    validateInspectionItemDelivery(delivery);
    const record: InspectionItemResultRecord = {
      kind: 'inspection-item-result',
      schemaVersion: 1,
      binding,
      delivery,
    };
    return this.dependencies.journal.commit(record);
  }

  private async findItem(
    occurrence: InspectionOccurrenceRef,
    invocationId: string,
  ): Promise<{ readonly record: InspectionItemResultRecord; readonly commitRef: JournalCommitRef } | null> {
    let cursor: string | undefined;
    let found: { readonly record: InspectionItemResultRecord; readonly commitRef: JournalCommitRef } | null = null;
    do {
      const page = await this.dependencies.journal.list({
        taskScope: occurrence.scope,
        kinds: ['inspection-item-result'],
        inspectionOccurrenceId: occurrence.occurrenceId,
        cursor,
        limit: 100,
      });
      for (const entry of page.entries) {
        if (entry.record.kind === 'inspection-item-result' && entry.record.delivery.resultId === `inspection-result:${invocationId}`) {
          found = { record: entry.record, commitRef: entry.commitRef };
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return found;
  }

  private async findSettlement(
    occurrence: InspectionOccurrenceRef,
    checkpointCommitRef: JournalCommitRef,
  ): Promise<{ readonly record: InspectionOccurrenceSettledRecord; readonly commitRef: JournalCommitRef } | null> {
    let cursor: string | undefined;
    do {
      const page = await this.dependencies.journal.list({
        taskScope: occurrence.scope,
        kinds: ['inspection-occurrence-settled'],
        inspectionOccurrenceId: occurrence.occurrenceId,
        cursor,
        limit: 100,
      });
      for (const entry of page.entries) {
        if (entry.record.kind === 'inspection-occurrence-settled'
          && entry.record.occurrence.occurrenceId === occurrence.occurrenceId
          && sameCommit(entry.record.checkpointCommitRef, checkpointCommitRef)) {
          return { record: entry.record, commitRef: entry.commitRef };
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return null;
  }

  private async findCycleClose(
    checkpoint: CommittedCheckpointRecord,
    cycleOpeningCommitRef: JournalCommitRef,
  ): Promise<{ readonly record: BusinessCycleClosedRecord; readonly commitRef: JournalCommitRef } | null> {
    let cursor: string | undefined;
    do {
      const page = await this.dependencies.journal.list({
        taskScope: checkpoint.checkpoint.scope,
        kinds: ['business-cycle-closed'],
        cycleId: checkpoint.checkpoint.cycleId.value,
        cursor,
        limit: 100,
      });
      for (const entry of page.entries) {
        if (entry.record.kind === 'business-cycle-closed'
          && entry.record.cycleId.value === checkpoint.checkpoint.cycleId.value
          && sameCommit(entry.record.openedCommitRef, cycleOpeningCommitRef)
          && sameCommit(entry.record.checkpointCommitRef, checkpoint.commitRef)) {
          return { record: entry.record, commitRef: entry.commitRef };
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return null;
  }

  private async assertExactCheckpoint(checkpoint: CommittedCheckpointRecord): Promise<string> {
    const exact = await this.dependencies.checkpoints.readCommitted(
      checkpoint.checkpoint.scope,
      checkpoint.checkpoint.id,
    );
    if (exact === null || !sameCommit(exact.commitRef, checkpoint.commitRef)
      || JSON.stringify(exact.checkpoint) !== JSON.stringify(checkpoint.checkpoint)) {
      throw new AgentLoopRuntimeError('invalid-state', 'inspection settlement requires the exact committed checkpoint');
    }
    const relationship = await this.dependencies.checkpoints.readNativeCheckpoint({
      checkpoint: { id: checkpoint.checkpoint.id, scope: checkpoint.checkpoint.scope },
    });
    if (relationship === null
      || JSON.stringify(relationship.checkpoint) !== JSON.stringify(checkpoint.checkpoint)
      || relationship.receipt.committedAt.trim().length === 0) {
      throw new AgentLoopRuntimeError('invalid-state', 'inspection settlement requires checkpoint owner committed time');
    }
    return relationship.receipt.committedAt;
  }

  private async closeCycleIfTerminal(_input: {
    readonly checkpoint: CommittedCheckpointRecord;
    readonly cycleOpeningCommitRef: JournalCommitRef;
    readonly next: NextAction;
    readonly alignmentRefs: readonly JournalCommitRef[];
    readonly settlement?: JournalCommitRef;
    readonly existingClose?: {
      readonly record: BusinessCycleClosedRecord;
      readonly commitRef: JournalCommitRef;
    };
    readonly committedAt: string;
  }): Promise<JournalCommitRef | undefined> {
    if (_input.existingClose) return _input.existingClose.commitRef;
    const cycleKey = `${_input.checkpoint.checkpoint.cycleId.value}\u0000${commitKey(_input.cycleOpeningCommitRef)}`;
    if (_input.next.kind === 'continue' || _input.next.kind === 'wait' || _input.next.kind === 'recover') {
      return undefined;
    }
    if (_input.settlement === undefined) {
      throw new AgentLoopRuntimeError('invalid-state', 'terminal inspection cycle close requires an occurrence settlement');
    }
    const running = this.cycleCloseOps.get(cycleKey);
    if (running) return running;
    const pending = this.closeCycleOnce(_input);
    this.cycleCloseOps.set(cycleKey, pending);
    try {
      return await pending;
    } finally {
      if (this.cycleCloseOps.get(cycleKey) === pending) this.cycleCloseOps.delete(cycleKey);
    }
  }

  private async closeCycleOnce(_input: {
    readonly checkpoint: CommittedCheckpointRecord;
    readonly cycleOpeningCommitRef: JournalCommitRef;
    readonly next: NextAction;
    readonly alignmentRefs: readonly JournalCommitRef[];
    readonly settlement?: JournalCommitRef;
    readonly existingClose?: {
      readonly record: BusinessCycleClosedRecord;
      readonly commitRef: JournalCommitRef;
    };
    readonly committedAt: string;
  }): Promise<JournalCommitRef | undefined> {
    if (_input.existingClose) return _input.existingClose.commitRef;
    const durableClose = await this.findCycleClose(_input.checkpoint, _input.cycleOpeningCommitRef);
    if (durableClose !== null) return durableClose.commitRef;
    if (_input.settlement === undefined) {
      throw new AgentLoopRuntimeError('invalid-state', 'terminal inspection cycle close requires an occurrence settlement');
    }
    const record: BusinessCycleClosedRecord = {
      kind: 'business-cycle-closed',
      schemaVersion: 1,
      openedCommitRef: _input.cycleOpeningCommitRef,
      cycleId: _input.checkpoint.checkpoint.cycleId,
      outcome: _input.next.kind,
      checkpointCommitRef: _input.checkpoint.commitRef,
      milestoneAlignmentCommitRefs: _input.alignmentRefs,
      inspectionSettlementCommitRef: _input.settlement,
      next: _input.next,
      closedAt: _input.committedAt,
    };
    const committed = await this.dependencies.journal.commit(record);
    return committed;
  }
}

function sameSelectionContext(left: InspectionSelectionContext, right: InspectionSelectionContext): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCommit(left: JournalCommitRef, right: JournalCommitRef): boolean {
  return left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest;
}

function commitKey(ref: JournalCommitRef): string {
  return `${ref.commitId}\u0000${ref.journalSeq}\u0000${ref.recordDigest}`;
}

function taskScopeOf(scope: ScopeRef): InspectionOccurrenceRef['scope'] {
  if (scope.organId === undefined || scope.taskId === undefined) {
    throw new AgentLoopRuntimeError('invalid-state', 'inspection checkpoint requires organ and task scope');
  }
  return { organId: scope.organId, taskId: scope.taskId };
}

function sameRefs(left: readonly JournalCommitRef[], right: readonly JournalCommitRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => sameCommit(ref, right[index]!));
}

function closureOutcome(closure: TurnClosureReference): {
  readonly outcome: InspectionExecutionOutcome;
  readonly declaredOutcome?: InspectionExecutionOutcome;
} {
  const declaredOutcome = closure.summary.inspectionOutcome;
  return declaredOutcome === undefined
    ? { outcome: { status: 'unknown', reason: 'turn closed without an explicit inspection outcome' } }
    : { outcome: declaredOutcome, declaredOutcome };
}

function sameOutcome(left: InspectionExecutionOutcome, right: InspectionExecutionOutcome): boolean {
  if (left.status !== right.status) return false;
  if (left.status === 'completed') {
    return right.status === 'completed' && left.judgment === right.judgment;
  }
  if (right.status === 'completed') return false;
  return left.reason === right.reason && left.judgment === right.judgment;
}
