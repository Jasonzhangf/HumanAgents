import {
  assertReviewAssignmentsMatch,
  assertReviewResultMatchesAssignment,
  assertSameScope,
  validateAcceptedChildDelivery,
  validateAcceptedRawFact,
  validateActiveTurnCaptureBody,
  validateRawFactEnvelope,
  validateWorkResult,
  type AcceptedChildDelivery,
  type AcceptedRawFact,
  type ActiveTurnBinding,
  type ActiveTurnCaptureBody,
  type ActiveTurnProviderExecutionIdentityRef,
  type ActiveTurnProviderRequestIdentityRef,
  type ChildCallBinding,
  type ChildInvocationRecord,
  type CompletionRef,
  type RawAsset,
  type RawFactEnvelope,
  type RuntimeRequestRecord,
  type ScopeRef,
  type TurnCaptureCut,
  type ReviewAssignment,
  type ReviewResult,
  type WorkAssignment,
  type WorkResult,
} from '../../../contracts/src/index.js';
import {
  activeTurnCommitId,
  type ActiveTurnJournalPort,
  type ActiveTurnJournalRecord,
} from './active-turn-journal.js';
import { ActiveTurnProducerBarrier } from './active-turn-capture.js';

export class RuntimeActiveTurnError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeActiveTurnError';
  }
}

function fail(code: string, message: string): never {
  throw new RuntimeActiveTurnError(code, message);
}

function sameScopedId(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameProviderExecution(
  left: ActiveTurnProviderExecutionIdentityRef,
  right: ActiveTurnProviderExecutionIdentityRef,
): boolean {
  return left.runtimeId === right.runtimeId && left.executionEpoch === right.executionEpoch;
}

function sameProviderRequest(
  left: ActiveTurnProviderRequestIdentityRef,
  right: ActiveTurnProviderRequestIdentityRef,
): boolean {
  return left.turnId === right.turnId
    && left.requestId === right.requestId
    && left.parentRequestId === right.parentRequestId;
}

/**
 * Runtime-owned active turn. It owns the binding, the unified acceptance
 * sequence, the request chain and the child linkage. The durable facts live in
 * the injected `ActiveTurnJournalPort`; this class only appends typed records
 * and projects them back on read. It holds no external side effects, so a
 * reconstructed instance can read the same facts without dispatching anything.
 */
export class ActiveTurnContext {
  private readonly records: ActiveTurnJournalRecord[];
  private binding: ActiveTurnBinding;
  private readonly currentTurnRef: string;
  private readonly producers = new ActiveTurnProducerBarrier();
  private mutations: Promise<void> = Promise.resolve();
  private mutationFailure: { readonly cause: unknown } | undefined;
  private frozen = false;
  private drained = false;
  private captured: ActiveTurnCaptureBody | undefined;
  private capturePromise: Promise<ActiveTurnCaptureBody> | undefined;
  private drainPromise: Promise<void> | undefined;

  private constructor(
    private readonly journal: ActiveTurnJournalPort,
    binding: ActiveTurnBinding,
    currentTurnRef: string,
    records: readonly ActiveTurnJournalRecord[],
  ) {
    this.binding = structuredClone(binding);
    this.currentTurnRef = currentTurnRef;
    this.records = structuredClone([...records]);
  }

  /**
   * Opens the durable active turn. The Runtime producer supplies the binding;
   * this method only persists it and returns the live context.
   */
  static async open(input: {
    readonly journal: ActiveTurnJournalPort;
    readonly binding: ActiveTurnBinding;
    readonly currentTurnRef: string;
  }): Promise<ActiveTurnContext> {
    const commitId = activeTurnCommitId(input.binding.admittedTurn.turnId, 'binding-opened');
    await input.journal.append({
      commitId,
      record: { kind: 'binding-opened', binding: input.binding, currentTurnRef: input.currentTurnRef },
    });
    const records = await input.journal.replay();
    const opened = records.find((record) => (
      record.kind === 'binding-opened' && record.binding.admittedTurn.turnId === input.binding.admittedTurn.turnId
    ));
    if (!opened || opened.kind !== 'binding-opened') {
      fail('active-turn.open.missing', 'active turn binding was not durably committed');
    }
    return new ActiveTurnContext(input.journal, opened.binding, opened.currentTurnRef, records);
  }

  /**
   * Rebuilds a read-only consumer from durable facts only. It never dispatches a
   * child and never replays a side effect.
   */
  static async reconstruct(journal: ActiveTurnJournalPort, turnId: string): Promise<ActiveTurnContext> {
    const records = await journal.replay();
    const opened = records.find((record) => (
      record.kind === 'binding-opened' && record.binding.admittedTurn.turnId === turnId
    ));
    if (!opened || opened.kind !== 'binding-opened') {
      fail('active-turn.replay.missing-binding', `no durable binding for active turn ${turnId}`);
    }
    return new ActiveTurnContext(journal, opened.binding, opened.currentTurnRef, records);
  }

  get admittedTurn() {
    return structuredClone(this.binding.admittedTurn);
  }

  get activeBinding(): ActiveTurnBinding {
    return structuredClone(this.binding);
  }

  currentBindingRef(): string {
    return this.currentTurnRef;
  }

  executionIdentity(): ActiveTurnProviderExecutionIdentityRef {
    return structuredClone(this.binding.execution);
  }

  scope(): ScopeRef {
    return structuredClone(this.binding.scope);
  }

  async registerInitialInput(content: RawAsset): Promise<void> {
    const owned = structuredClone(content);
    return this.mutate(async () => {
      assertSameScope(owned.ref.scope, this.binding.scope);
      const previous = this.initialInput();
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(owned)) {
          fail('active-turn.input.conflict', 'initial input cannot change within a business turn');
        }
        return;
      }
      if (!owned.ref.digest) fail('active-turn.input.digest-missing', 'initial input must name actual immutable bytes');
      const record = { kind: 'initial-input' as const, content: owned };
      await this.journal.append({ commitId: activeTurnCommitId(this.admittedTurn.turnId, 'initial-input'), record });
      this.records.push(record);
    });
  }

  initialInput(): RawAsset | undefined {
    const record = this.records.find((entry) => entry.kind === 'initial-input');
    return record?.kind === 'initial-input' ? structuredClone(record.content) : undefined;
  }

  async registerProviderRequest(input: {
    readonly execution: ActiveTurnProviderExecutionIdentityRef;
    readonly record: RuntimeRequestRecord;
  }): Promise<RuntimeRequestRecord> {
    if (!sameProviderExecution(input.execution, this.binding.execution)) {
      fail('active-turn.request.execution-mismatch', 'request registration does not match active execution');
    }
    return this.registerRequest(input.record);
  }

  /**
   * Registers or confirms a real Provider request identity and its lifecycle
   * phase. The Provider owns the request identity; the Runtime only checks it
   * against the open binding and persists it.
   */
  async registerRequest(record: RuntimeRequestRecord): Promise<RuntimeRequestRecord> {
    const owned = structuredClone(record);
    return this.mutate(() => this.registerRequestRecord(owned));
  }

  private async registerRequestRecord(record: RuntimeRequestRecord): Promise<RuntimeRequestRecord> {
    assertSameScope(record.scope, this.binding.scope);
    if (record.parentRequestId !== record.request.parentRequestId) {
      fail('active-turn.request.parent-mismatch', 'request parent must match its identity');
    }
    const requests = this.requests();
    const sameId = requests.find((candidate) => candidate.request.requestId === record.request.requestId);
    if (sameId && !sameProviderRequest(sameId.request, record.request)) {
      fail('active-turn.request.identity-conflict', 'request identity cannot change within a turn');
    }
    if (record.request.parentRequestId !== undefined && !requests.some((candidate) => (
      candidate.request.requestId === record.request.parentRequestId
      && candidate.request.turnId === record.request.turnId
    ))) {
      fail('active-turn.request.unknown-parent', 'continuation parent must be durably registered');
    }
    if (!sameId && record.phase !== 'dispatching') {
      fail('active-turn.request.unregistered', 'request must register dispatching before later phases');
    }
    const existing = requests.find((candidate) => sameProviderRequest(candidate.request, record.request) && candidate.phase === record.phase);
    const commitId = activeTurnCommitId(
      this.binding.admittedTurn.turnId,
      `request:${record.request.requestId}:${record.phase}`,
    );
    if (existing) {
      return structuredClone(existing);
    }
    await this.journal.append({ commitId, record: { kind: 'request', record } });
    this.records.push({ kind: 'request', record });
    return structuredClone(record);
  }

  /**
   * Accepts one Provider raw fact. It verifies the runtime/epoch and exact scope
   * against the open binding, requires causal request registration, dedupes by
   * producer sequence and durably commits before projecting.
   */
  async acceptRawFact(envelope: RawFactEnvelope): Promise<AcceptedRawFact> {
    const owned = structuredClone(envelope);
    return this.mutate(() => this.acceptRawFactRecord(owned));
  }

  private async acceptRawFactRecord(envelope: RawFactEnvelope): Promise<AcceptedRawFact> {
    validateRawFactEnvelope(envelope);
    if (!sameProviderExecution(envelope.execution, this.binding.execution)) {
      fail('active-turn.accept.execution-mismatch', 'raw fact execution does not match the open active turn binding');
    }
    assertSameScope(envelope.scope, this.binding.scope);

    const duplicate = this.entries().find((entry): entry is AcceptedRawFact => (
      'envelope' in entry
      && sameProviderRequest(entry.envelope.request, envelope.request)
      && entry.envelope.producerSeq === envelope.producerSeq
    ));
    if (duplicate) {
      if (JSON.stringify(duplicate.envelope.fact) !== JSON.stringify(envelope.fact)) {
        fail('active-turn.accept.conflict', 'the same request producer sequence was accepted with different content');
      }
      return structuredClone(duplicate);
    }

    if (!this.requests().some((record) => sameProviderRequest(record.request, envelope.request))) {
      fail('active-turn.accept.unregistered-request', 'raw fact must follow durable request registration');
    }
    const seq = this.nextSeq();
    const entry: AcceptedRawFact = { seq, envelope };
    validateAcceptedRawFact(entry);
    const commitId = activeTurnCommitId(
      this.binding.admittedTurn.turnId,
      `fact:${envelope.request.requestId}:${envelope.producerSeq}`,
    );
    await this.journal.append({ commitId, record: { kind: 'accepted-fact', entry } });
    this.records.push({ kind: 'accepted-fact', entry });
    return structuredClone(entry);
  }

  /**
   * Records the durable call checkpoint association for one real child call.
   * The checkpoint receipt must already be committed by the Runtime checkpoint
   * owner; this only links it to the invocation intent.
   */
  async openChildInvocation(input: {
    readonly invocationId: string;
    readonly childTurnId: string;
    readonly checkpointReceiptRef: string;
    readonly binding: ChildCallBinding;
  }): Promise<ChildInvocationRecord> {
    const owned = structuredClone(input);
    return this.mutate(() => this.openChildInvocationRecord(owned));
  }

  private async openChildInvocationRecord(input: {
    readonly invocationId: string;
    readonly childTurnId: string;
    readonly checkpointReceiptRef: string;
    readonly binding: ChildCallBinding;
  }): Promise<ChildInvocationRecord> {
    if (!input.invocationId.trim() || !input.childTurnId.trim() || !input.checkpointReceiptRef.trim()) {
      fail('active-turn.invocation.incomplete', 'child invocation requires an id, child turn id and checkpoint receipt reference');
    }
    const existing = this.childInvocations().find((record) => record.invocationId === input.invocationId);
    if (existing) {
      if (JSON.stringify(existing.binding) !== JSON.stringify(input.binding)) {
        fail('active-turn.invocation.conflict', `child invocation ${input.invocationId} is already bound to a different assignment`);
      }
      return existing;
    }
    const record: ChildInvocationRecord = {
      invocationId: input.invocationId,
      childTurnId: input.childTurnId,
      checkpointReceiptRef: input.checkpointReceiptRef,
      binding: input.binding,
    };
    const commitId = activeTurnCommitId(this.binding.admittedTurn.turnId, `invocation:${input.invocationId}`);
    await this.journal.append({ commitId, record: { kind: 'child-invocation', record } });
    this.records.push({ kind: 'child-invocation', record });
    return record;
  }

  /**
   * Records the refined delivery a real child call returned. It reuses the real
   * child `WorkAssignment`/`WorkResult` identity and never copies the child raw
   * transcript. A mismatched assignment, attempt or execution epoch is rejected
   * before it can enter the parent turn.
   */
  async recordChildReturn(input: {
    readonly invocationId: string;
    readonly refinedDelivery: RawAsset;
  } & (
    | {
        readonly kind: 'execution';
        readonly assignment: WorkAssignment;
        readonly result: WorkResult;
      }
    | {
        readonly kind: 'review';
        readonly assignment: ReviewAssignment;
        readonly result: ReviewResult;
      }
  )): Promise<AcceptedChildDelivery> {
    const owned = structuredClone(input);
    return this.mutate(() => this.recordChildReturnRecord(owned));
  }

  private async recordChildReturnRecord(input: Parameters<ActiveTurnContext['recordChildReturn']>[0]): Promise<AcceptedChildDelivery> {
    const invocation = this.childInvocations().find((record) => record.invocationId === input.invocationId);
    if (!invocation) fail('active-turn.invocation.unknown', `child delivery references unknown invocation ${input.invocationId}`);
    if (input.kind === 'execution') {
      if (invocation.binding.kind !== 'execution') {
        fail('active-turn.child.kind-mismatch', 'execution delivery cannot bind to a review invocation');
      }
      if (input.assignment.assignmentId !== invocation.binding.assignment.assignmentId
        || input.assignment.taskId.value !== invocation.binding.assignment.taskId.value
        || input.assignment.pipelineNodeId !== invocation.binding.assignment.pipelineNodeId
        || input.assignment.attempt !== invocation.binding.assignment.attempt
        || input.assignment.inputRevision !== invocation.binding.assignment.inputRevision) {
        fail('active-turn.child.assignment-mismatch', 'child result assignment does not match its invocation binding');
      }
      if (input.assignment.executionEpoch !== this.binding.execution.executionEpoch
        || input.result.executionEpoch !== this.binding.execution.executionEpoch) {
        fail('active-turn.child.epoch-mismatch', 'child result execution epoch does not match the active turn');
      }
      try {
        validateWorkResult(input.result, input.assignment);
      } catch (error) {
        fail('active-turn.child.result-mismatch', error instanceof Error ? error.message : 'child result does not match its assignment');
      }
    } else {
      if (invocation.binding.kind !== 'review') {
        fail('active-turn.child.kind-mismatch', 'review delivery cannot bind to an execution invocation');
      }
      if (input.assignment.executionEpoch !== this.binding.execution.executionEpoch
        || input.result.executionEpoch !== this.binding.execution.executionEpoch) {
        fail('active-turn.child.epoch-mismatch', 'review result execution epoch does not match the active turn');
      }
      try {
        assertReviewAssignmentsMatch(invocation.binding.assignment, input.assignment);
        assertReviewResultMatchesAssignment(input.assignment, input.result);
      } catch (error) {
        fail('active-turn.child.review-mismatch', error instanceof Error ? error.message : 'review result does not match its invocation binding');
      }
    }
    const seq = this.nextSeq();
    let entry: AcceptedChildDelivery;
    if (input.kind === 'execution') {
      entry = {
        kind: 'execution',
        seq,
        invocationId: input.invocationId,
        refinedDelivery: input.refinedDelivery,
        assignment: input.assignment,
        result: input.result,
      };
    } else {
      entry = {
        kind: 'review',
        seq,
        invocationId: input.invocationId,
        refinedDelivery: input.refinedDelivery,
        assignment: input.assignment,
        result: input.result,
      };
    }
    validateAcceptedChildDelivery(entry);
    const commitId = activeTurnCommitId(
      this.binding.admittedTurn.turnId,
      `delivery:${input.invocationId}`,
    );
    await this.journal.append({ commitId, record: { kind: 'child-delivery', entry } });
    this.records.push({ kind: 'child-delivery', entry });
    return entry;
  }

  /**
   * Records owner adoption separately from the returned delivery. Only a real
   * parent acceptance may set `adoptedResultSeq`.
   */
  async recordChildAdoption(invocationId: string, delivery: AcceptedChildDelivery): Promise<void> {
    const owned = structuredClone(delivery);
    return this.mutate(() => this.recordChildAdoptionRecord(invocationId, owned));
  }

  private async recordChildAdoptionRecord(invocationId: string, delivery: AcceptedChildDelivery): Promise<void> {
    const invocation = this.childInvocations().find((record) => record.invocationId === invocationId);
    if (!invocation) fail('active-turn.invocation.unknown', `adoption references unknown invocation ${invocationId}`);
    const stored = this.entries().find((entry): entry is AcceptedChildDelivery => (
      !('envelope' in entry) && entry.invocationId === invocationId && entry.seq === delivery.seq
    ));
    if (!stored) fail('active-turn.adoption.unreturned', 'cannot adopt a child delivery that was not durably returned');
    if (stored.kind !== invocation.binding.kind) {
      fail('active-turn.adoption.kind-mismatch', 'adopted delivery kind does not match its invocation binding');
    }
    const record: ChildInvocationRecord = { ...invocation, adoptedResultSeq: delivery.seq };
    const commitId = activeTurnCommitId(this.binding.admittedTurn.turnId, `adopted:${invocationId}`);
    await this.journal.append({ commitId, record: { kind: 'child-invocation', record } });
    this.records.push({ kind: 'child-invocation', record });
  }

  /**
   * Associates a review invocation with its committed review-result checkpoint.
   * The pre-call dispatch checkpoint never stands in for the persisted review
   * result, and an unadopted review is not checkpointed as complete.
   */
  async recordReviewCheckpoint(invocationId: string, checkpointReceiptRef: string): Promise<void> {
    return this.mutate(() => this.recordReviewCheckpointRecord(invocationId, checkpointReceiptRef));
  }

  private async recordReviewCheckpointRecord(invocationId: string, checkpointReceiptRef: string): Promise<void> {
    if (!checkpointReceiptRef.trim()) {
      fail('active-turn.review-checkpoint.incomplete', 'review result checkpoint reference is required');
    }
    const invocation = this.childInvocations().find((record) => record.invocationId === invocationId);
    if (!invocation) fail('active-turn.invocation.unknown', `review checkpoint references unknown invocation ${invocationId}`);
    if (invocation.binding.kind !== 'review') {
      fail('active-turn.review-checkpoint.kind-mismatch', 'post-review checkpoint requires a review invocation');
    }
    if (invocation.adoptedResultSeq === undefined) {
      fail('active-turn.review-checkpoint.unadopted', 'cannot checkpoint a review result before parent adoption');
    }
    if (invocation.postReviewCheckpointRef === checkpointReceiptRef) return;
    if (invocation.checkpointReceiptRef === checkpointReceiptRef) {
      fail('active-turn.review-checkpoint.pre-call', 'post-review checkpoint must differ from the pre-call checkpoint');
    }
    if (invocation.postReviewCheckpointRef !== undefined) {
      fail('active-turn.review-checkpoint.conflict', `review invocation ${invocationId} already has a review-result checkpoint`);
    }
    const record: ChildInvocationRecord = { ...invocation, postReviewCheckpointRef: checkpointReceiptRef };
    const commitId = activeTurnCommitId(this.binding.admittedTurn.turnId, `review-checkpoint:${invocationId}`);
    await this.journal.append({ commitId, record: { kind: 'child-invocation', record } });
    this.records.push({ kind: 'child-invocation', record });
  }

  entries(): readonly (AcceptedRawFact | AcceptedChildDelivery)[] {
    return structuredClone(this.records
      .filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'accepted-fact' | 'child-delivery' }> => (
        record.kind === 'accepted-fact' || record.kind === 'child-delivery'
      ))
      .map((record) => (record.kind === 'accepted-fact' ? record.entry : record.entry))
      .sort((left, right) => left.seq - right.seq));
  }

  requests(): readonly RuntimeRequestRecord[] {
    return structuredClone(this.records.filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'request' }> => record.kind === 'request').map((record) => record.record));
  }

  childInvocations(): readonly ChildInvocationRecord[] {
    const byId = new Map<string, ChildInvocationRecord>();
    for (const record of this.records) {
      if (record.kind === 'child-invocation') byId.set(record.record.invocationId, record.record);
    }
    return structuredClone([...byId.values()]);
  }

  /**
   * The immutable capture body for this turn, read from durable facts only. It
   * is what a cold-read consumer sees; it never triggers a child dispatch.
   */
  capture(input: {
    readonly pauseId: string;
    readonly frozenAt: string;
    readonly initialInput: RawAsset;
    readonly checkpointPath: readonly string[];
    readonly completionRefs: readonly CompletionRef[];
  }): ActiveTurnCaptureBody {
    if (!this.drained) fail('active-turn.capture.not-drained', 'prepareCapture must drain producers before reading a capture');
    if (this.captured) {
      if (this.captured.cut.pauseId !== input.pauseId) {
        fail('active-turn.capture.boundary-conflict', 'a frozen segment has one capture boundary');
      }
      return structuredClone(this.captured);
    }
    const entries = this.entries();
    const cut: TurnCaptureCut = {
      pauseId: input.pauseId,
      lastSeq: entries.length === 0 ? 0 : entries[entries.length - 1]!.seq,
      producersDrained: true,
      frozenAt: input.frozenAt,
    };
    const body: ActiveTurnCaptureBody = {
      version: 1,
      binding: this.binding,
      initialInput: input.initialInput,
      entries,
      requests: this.requests(),
      childInvocations: this.childInvocations(),
      checkpointPath: [...input.checkpointPath],
      cut,
      completionRefs: [...input.completionRefs],
    };
    validateActiveTurnCaptureBody(body);
    this.captured = structuredClone(body);
    return structuredClone(this.captured);
  }

  /** Register the entire producer, including its final durable acknowledgement. */
  runProducer<T>(produce: () => T | Promise<T>): Promise<T> {
    return this.producers.run(produce);
  }

  assertProductionOpen(): void { this.producers.assertOpen(); }

  closeAndDrainProducers(): Promise<void> {
    this.drainPromise ??= (async () => {
      await this.producers.closeAndDrain();
      this.frozen = true;
      await this.mutations;
      if (this.mutationFailure) throw this.mutationFailure.cause;
      this.drained = true;
    })();
    return this.drainPromise;
  }

  /** Close admission, await admitted producers and writes, then freeze once. */
  async prepareCapture(input: Parameters<ActiveTurnContext['capture']>[0]): Promise<ActiveTurnCaptureBody> {
    if (!this.capturePromise) {
      const owned = structuredClone(input);
      this.capturePromise = (async () => {
        await this.closeAndDrainProducers();
        return this.capture(owned);
      })();
    }
    const body = await this.capturePromise;
    if (body.cut.pauseId !== input.pauseId) {
      fail('active-turn.capture.boundary-conflict', 'a frozen segment has one capture boundary');
    }
    return structuredClone(body);
  }

  controlRecordCount(): number { return this.records.length; }

  private mutate<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.frozen) return Promise.reject(new RuntimeActiveTurnError('active-turn.frozen', 'cannot mutate a frozen active turn'));
    const result = this.mutations.then(mutation);
    this.mutations = result.then(
      () => undefined,
      (cause: unknown) => { this.mutationFailure ??= { cause }; },
    );
    return result.then((value) => structuredClone(value));
  }

  private nextSeq(): number {
    const entries = this.entries();
    return entries.length === 0 ? 1 : entries[entries.length - 1]!.seq + 1;
  }
}

/** The runtime-local child invocation identity for one assignment attempt. */
export function childInvocationId(input: {
  readonly assignmentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
}): string {
  return `invocation:${input.assignmentId}:${input.attempt}:${input.executionEpoch}`;
}
