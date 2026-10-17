import {
  assertReviewAssignmentsMatch,
  assertReviewResultMatchesAssignment,
  assertSameScope,
  validateAcceptedChildDelivery,
  validateChildInvocationReferences,
  validateChildInvocationIncarnation,
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
  type CompletionReadInput,
  type CompletionRef,
  type InspectionItemDelivery,
  type ProviderProducerDrainResult,
  type RawAsset,
  type RawFactEnvelope,
  type RecoveryHoldFacts,
  type RuntimeRequestRecord,
  type ScopeRef,
  type TaskRuntimeIncarnation,
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
import {
  activeTurnSegmentCommitId,
  validateActiveTurnSegmentCaptureV2,
  validatePreparedActiveTurnSegmentCaptureV2,
  validateResumedTurnSegmentOpened,
  type ActiveTurnSegmentBinding,
  type ActiveTurnSegmentCaptureV2,
  type PreparedActiveTurnSegmentCaptureV2,
  type ResumedTurnSegmentOpened,
} from '../../../contracts/src/active-turn-segments.js';
import type { JournalCommitRef } from '../../../contracts/src/i2-history.js';
import { ActiveTurnProducerBarrier } from './active-turn-capture.js';
import type {
  ActiveTurnLivePrefix,
  ActiveTurnProductionObligationRef,
  ActiveTurnSegmentLivePrefix,
} from './active-turn-live-prefix.js';

export class RuntimeActiveTurnError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RuntimeActiveTurnError';
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new RuntimeActiveTurnError(code, message, cause === undefined ? undefined : { cause });
}

function projectRequestObligations(requests: readonly RuntimeRequestRecord[]): ActiveTurnProductionObligationRef[] {
  const latest = new Map<string, RuntimeRequestRecord>();
  for (const record of requests) latest.set(record.request.requestId, record);
  return [...latest.values()]
    .filter((record) => record.phase === 'dispatching' || record.phase === 'dispatched' || record.phase === 'waiting')
    .map((record) => ({ kind: 'request', requestId: record.request.requestId, phase: record.phase }));
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

type RecordChildReturnInput = {
  readonly invocationId: string;
  readonly refinedDelivery: RawAsset;
} & (
  | {
      readonly kind: 'execution';
      readonly assignment: WorkAssignment;
      readonly result: WorkResult;
      readonly inspectionDelivery?: InspectionItemDelivery;
    }
  | {
      readonly kind: 'review';
      readonly assignment: ReviewAssignment;
      readonly result: ReviewResult;
    }
);

/**
 * Shared durable-record state for one execution epoch. The v1 active turn and
 * the v2 resumed segment differ only in their binding view and commit identity
 * function, so the mutation, acceptance, ordering and adoption rules live here
 * once.
 */
interface ActiveTurnRecordState {
  readonly records: ActiveTurnJournalRecord[];
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly commitId: (discriminator: string) => string;
  readonly append: (commitId: string, record: ActiveTurnJournalRecord) => Promise<void>;
}

function projectEntries(
  records: readonly ActiveTurnJournalRecord[],
): readonly (AcceptedRawFact | AcceptedChildDelivery)[] {
  return records
    .filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'accepted-fact' | 'child-delivery' }> => (
      record.kind === 'accepted-fact' || record.kind === 'child-delivery'
    ))
    .map((record) => (record.kind === 'accepted-fact' ? record.entry : record.entry))
    .sort((left, right) => left.seq - right.seq);
}

function projectRequests(records: readonly ActiveTurnJournalRecord[]): readonly RuntimeRequestRecord[] {
  return records
    .filter((record): record is Extract<ActiveTurnJournalRecord, { kind: 'request' }> => record.kind === 'request')
    .map((record) => record.record);
}

function projectChildInvocations(records: readonly ActiveTurnJournalRecord[]): readonly ChildInvocationRecord[] {
  const byId = new Map<string, ChildInvocationRecord>();
  for (const record of records) {
    if (record.kind === 'child-invocation') byId.set(record.record.invocationId, record.record);
  }
  return [...byId.values()];
}

/**
 * One child-obligation projection shared by the v1 active turn and the v2
 * resumed segment. A child invocation still owes work while its durable return
 * is missing, while the parent selection decision is pending, or while a
 * returned review lacks its required post-review checkpoint association. A
 * durable adoption or non-selection discharges only this child decision duty;
 * independent request, operation and completion references are untouched.
 */
function projectChildObligations(
  childInvocations: readonly ChildInvocationRecord[],
  entries: readonly (AcceptedRawFact | AcceptedChildDelivery)[],
): ActiveTurnProductionObligationRef[] {
  const returned = new Set(
    entries
      .filter((entry): entry is AcceptedChildDelivery => !('envelope' in entry))
      .map((entry) => entry.invocationId),
  );
  return childInvocations
    .filter((invocation) => {
      if (!returned.has(invocation.invocationId)) return true;
      const decided = invocation.adoptedResultSeq !== undefined || invocation.notSelectedResultSeq !== undefined;
      if (!decided) return true;
      return invocation.binding.kind === 'review' && invocation.postReviewCheckpointRef === undefined;
    })
    .map((invocation): ActiveTurnProductionObligationRef => ({
      kind: 'child-invocation',
      invocationId: invocation.invocationId,
      phase: 'pending',
    }));
}

function nextEntrySeq(records: readonly ActiveTurnJournalRecord[]): number {
  const entries = projectEntries(records);
  return entries.length === 0 ? 1 : entries[entries.length - 1]!.seq + 1;
}

async function registerRequestRecord(
  state: ActiveTurnRecordState,
  record: RuntimeRequestRecord,
): Promise<RuntimeRequestRecord> {
  assertSameScope(record.scope, state.scope);
  if (record.parentRequestId !== record.request.parentRequestId) {
    fail('active-turn.request.parent-mismatch', 'request parent must match its identity');
  }
  const requests = projectRequests(state.records);
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
  if (existing) return existing;
  await state.append(state.commitId(`request:${record.request.requestId}:${record.phase}`), { kind: 'request', record });
  return record;
}

async function acceptRawFactRecord(
  state: ActiveTurnRecordState,
  envelope: RawFactEnvelope,
): Promise<AcceptedRawFact> {
  validateRawFactEnvelope(envelope);
  if (!sameProviderExecution(envelope.execution, state.execution)) {
    fail('active-turn.accept.execution-mismatch', 'raw fact execution does not match the open active turn binding');
  }
  assertSameScope(envelope.scope, state.scope);

  const duplicate = projectEntries(state.records).find((entry): entry is AcceptedRawFact => (
    'envelope' in entry
    && sameProviderRequest(entry.envelope.request, envelope.request)
    && entry.envelope.producerSeq === envelope.producerSeq
  ));
  if (duplicate) {
    if (JSON.stringify(duplicate.envelope.fact) !== JSON.stringify(envelope.fact)) {
      fail('active-turn.accept.conflict', 'the same request producer sequence was accepted with different content');
    }
    return duplicate;
  }

  if (!projectRequests(state.records).some((record) => sameProviderRequest(record.request, envelope.request))) {
    fail('active-turn.accept.unregistered-request', 'raw fact must follow durable request registration');
  }
  const seq = nextEntrySeq(state.records);
  const entry: AcceptedRawFact = { seq, envelope };
  validateAcceptedRawFact(entry);
  await state.append(state.commitId(`fact:${envelope.request.requestId}:${envelope.producerSeq}`), {
    kind: 'accepted-fact',
    entry,
  });
  return entry;
}

async function openChildInvocationRecord(
  state: ActiveTurnRecordState,
  input: {
    readonly invocationId: string;
    readonly childTurnId: string;
    readonly checkpointReceiptRef: string;
    readonly binding: ChildCallBinding;
    readonly incarnation?: TaskRuntimeIncarnation;
  },
): Promise<ChildInvocationRecord> {
  if (!input.invocationId.trim() || !input.childTurnId.trim() || !input.checkpointReceiptRef.trim()) {
    fail('active-turn.invocation.incomplete', 'child invocation requires an id, child turn id and checkpoint receipt reference');
  }
  const existing = projectChildInvocations(state.records).find((record) => record.invocationId === input.invocationId);
  if (existing) {
    if (JSON.stringify(existing.binding) !== JSON.stringify(input.binding)) {
      fail('active-turn.invocation.conflict', `child invocation ${input.invocationId} is already bound to a different assignment`);
    }
    return existing;
  }
  if (input.incarnation !== undefined) {
    try {
      validateChildInvocationIncarnation(input.incarnation, input.binding, 'child invocation');
    } catch (error) {
      fail('active-turn.invocation.incarnation-invalid', error instanceof Error ? error.message : 'child invocation incarnation is invalid');
    }
  }
  const record: ChildInvocationRecord = {
    invocationId: input.invocationId,
    childTurnId: input.childTurnId,
    checkpointReceiptRef: input.checkpointReceiptRef,
    binding: input.binding,
    ...(input.incarnation === undefined ? {} : { incarnation: input.incarnation }),
  };
  await state.append(state.commitId(`invocation:${input.invocationId}`), { kind: 'child-invocation', record });
  return record;
}

async function recordChildReturnRecord(
  state: ActiveTurnRecordState,
  input: RecordChildReturnInput,
): Promise<AcceptedChildDelivery> {
  const invocation = projectChildInvocations(state.records).find((record) => record.invocationId === input.invocationId);
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
    if (input.assignment.executionEpoch !== state.execution.executionEpoch
      || input.result.executionEpoch !== state.execution.executionEpoch) {
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
    if (input.assignment.executionEpoch !== state.execution.executionEpoch
      || input.result.executionEpoch !== state.execution.executionEpoch) {
      fail('active-turn.child.epoch-mismatch', 'review result execution epoch does not match the active turn');
    }
    try {
      assertReviewAssignmentsMatch(invocation.binding.assignment, input.assignment);
      assertReviewResultMatchesAssignment(input.assignment, input.result);
    } catch (error) {
      fail('active-turn.child.review-mismatch', error instanceof Error ? error.message : 'review result does not match its invocation binding');
    }
  }
  const seq = nextEntrySeq(state.records);
  let entry: AcceptedChildDelivery;
  if (input.kind === 'execution') {
    entry = {
      kind: 'execution',
      seq,
      invocationId: input.invocationId,
      refinedDelivery: input.refinedDelivery,
      assignment: input.assignment,
      result: input.result,
      ...(input.inspectionDelivery === undefined ? {} : { inspectionDelivery: input.inspectionDelivery }),
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
  if (entry.kind === 'execution'
    && (invocation.binding.kind === 'execution' && invocation.binding.inspection !== undefined
      || entry.inspectionDelivery !== undefined)) {
    try {
      validateChildInvocationReferences([invocation], [entry], 'active-turn');
    } catch (error) {
      fail('active-turn.child.references-invalid', error instanceof Error ? error.message : 'child references are invalid', error);
    }
  }
  await state.append(state.commitId(`delivery:${input.invocationId}`), { kind: 'child-delivery', entry });
  return entry;
}

async function recordChildAdoptionRecord(
  state: ActiveTurnRecordState,
  invocationId: string,
  delivery: AcceptedChildDelivery,
): Promise<void> {
  const invocation = projectChildInvocations(state.records).find((record) => record.invocationId === invocationId);
  if (!invocation) fail('active-turn.invocation.unknown', `adoption references unknown invocation ${invocationId}`);
  if (invocation.notSelectedResultSeq !== undefined) {
    fail('active-turn.adoption.declined', `child invocation ${invocationId} was already declined`);
  }
  const stored = projectEntries(state.records).find((entry): entry is AcceptedChildDelivery => (
    !('envelope' in entry) && entry.invocationId === invocationId && entry.seq === delivery.seq
  ));
  if (!stored) fail('active-turn.adoption.unreturned', 'cannot adopt a child delivery that was not durably returned');
  if (stored.kind !== invocation.binding.kind) {
    fail('active-turn.adoption.kind-mismatch', 'adopted delivery kind does not match its invocation binding');
  }
  const record: ChildInvocationRecord = { ...invocation, adoptedResultSeq: delivery.seq };
  await state.append(state.commitId(`adopted:${invocationId}`), { kind: 'child-invocation', record });
}

async function recordChildNonSelectionRecord(
  state: ActiveTurnRecordState,
  invocationId: string,
): Promise<void> {
  const invocation = projectChildInvocations(state.records).find((record) => record.invocationId === invocationId);
  if (!invocation) fail('active-turn.invocation.unknown', `non-selection references unknown invocation ${invocationId}`);
  const delivery = projectEntries(state.records).find((entry): entry is AcceptedChildDelivery => (
    !('envelope' in entry) && entry.invocationId === invocationId
  ));
  if (!delivery) {
    fail('active-turn.non-selection.unreturned', 'cannot decline a child delivery that has not been durably returned');
  }
  if (delivery.kind !== invocation.binding.kind) {
    fail('active-turn.non-selection.kind-mismatch', 'declined delivery kind does not match its invocation binding');
  }
  if (invocation.adoptedResultSeq !== undefined) {
    fail('active-turn.non-selection.adopted', 'cannot decline a child delivery the parent already adopted');
  }
  if (invocation.notSelectedResultSeq === delivery.seq) return;
  const record: ChildInvocationRecord = { ...invocation, notSelectedResultSeq: delivery.seq };
  await state.append(state.commitId(`not-selected:${invocationId}`), { kind: 'child-invocation', record });
}

async function recordReviewCheckpointRecord(
  state: ActiveTurnRecordState,
  invocationId: string,
  checkpointReceiptRef: string,
): Promise<void> {
  if (!checkpointReceiptRef.trim()) {
    fail('active-turn.review-checkpoint.incomplete', 'review result checkpoint reference is required');
  }
  const invocation = projectChildInvocations(state.records).find((record) => record.invocationId === invocationId);
  if (!invocation) fail('active-turn.invocation.unknown', `review checkpoint references unknown invocation ${invocationId}`);
  if (invocation.binding.kind !== 'review') {
    fail('active-turn.review-checkpoint.kind-mismatch', 'post-review checkpoint requires a review invocation');
  }
  const returned = projectEntries(state.records).find((entry): entry is AcceptedChildDelivery => (
    !('envelope' in entry) && entry.invocationId === invocationId
  ));
  if (!returned || returned.kind !== 'review') {
    fail('active-turn.review-checkpoint.unreturned', 'cannot checkpoint a review result before its durable return');
  }
  if (invocation.postReviewCheckpointRef === checkpointReceiptRef) return;
  if (invocation.checkpointReceiptRef === checkpointReceiptRef) {
    fail('active-turn.review-checkpoint.pre-call', 'post-review checkpoint must differ from the pre-call checkpoint');
  }
  if (invocation.postReviewCheckpointRef !== undefined) {
    fail('active-turn.review-checkpoint.conflict', `review invocation ${invocationId} already has a review-result checkpoint`);
  }
  const record: ChildInvocationRecord = { ...invocation, postReviewCheckpointRef: checkpointReceiptRef };
  await state.append(state.commitId(`review-checkpoint:${invocationId}`), { kind: 'child-invocation', record });
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
    return registerRequestRecord(this.state(), record);
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
    return acceptRawFactRecord(this.state(), envelope);
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
    readonly incarnation?: TaskRuntimeIncarnation;
  }): Promise<ChildInvocationRecord> {
    const owned = structuredClone(input);
    return this.mutate(() => this.openChildInvocationRecord(owned));
  }

  private async openChildInvocationRecord(input: {
    readonly invocationId: string;
    readonly childTurnId: string;
    readonly checkpointReceiptRef: string;
    readonly binding: ChildCallBinding;
    readonly incarnation?: TaskRuntimeIncarnation;
  }): Promise<ChildInvocationRecord> {
    return openChildInvocationRecord(this.state(), input);
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
        readonly inspectionDelivery?: InspectionItemDelivery;
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

  private async recordChildReturnRecord(input: RecordChildReturnInput): Promise<AcceptedChildDelivery> {
    return recordChildReturnRecord(this.state(), input);
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
    return recordChildAdoptionRecord(this.state(), invocationId, delivery);
  }

  /**
   * Records the parent's terminal decision not to select this exact retained
   * delivery. The delivery is resolved from the owner's retained entries; the
   * caller supplies no result bytes or sequence. A missing return or a prior
   * adoption rejects, and a repeated identical decision is idempotent.
   */
  async recordChildNonSelection(invocationId: string): Promise<void> {
    return this.mutate(() => this.recordChildNonSelectionRecord(invocationId));
  }

  private async recordChildNonSelectionRecord(invocationId: string): Promise<void> {
    return recordChildNonSelectionRecord(this.state(), invocationId);
  }

  /**
   * Associates a review invocation with its committed review-result checkpoint.
   * The pre-call dispatch checkpoint never stands in for the persisted review
   * result. The checkpoint requires the durable review return, not adoption: a
   * completed review is checkpointed before the parent decides selection.
   */
  async recordReviewCheckpoint(invocationId: string, checkpointReceiptRef: string): Promise<void> {
    return this.mutate(() => this.recordReviewCheckpointRecord(invocationId, checkpointReceiptRef));
  }

  private async recordReviewCheckpointRecord(invocationId: string, checkpointReceiptRef: string): Promise<void> {
    return recordReviewCheckpointRecord(this.state(), invocationId, checkpointReceiptRef);
  }

  entries(): readonly (AcceptedRawFact | AcceptedChildDelivery)[] {
    return structuredClone(projectEntries(this.records));
  }

  requests(): readonly RuntimeRequestRecord[] {
    return structuredClone(projectRequests(this.records));
  }

  childInvocations(): readonly ChildInvocationRecord[] {
    return structuredClone(projectChildInvocations(this.records));
  }

  /**
   * A live read over the committed projection. It waits for accepted mutations
   * already in the serial queue, but never closes admission, never drains
   * producers and never calls `prepareCapture`. A returned prefix is a detached
   * snapshot: later commits do not mutate it. A required prior mutation failure
   * is a retained error control fact: every read surfaces it instead of reading
   * a successful tail, and a later drain surfaces the same original failure.
   */
  async readLivePrefix(source: string): Promise<ActiveTurnLivePrefix> {
    if (!source.trim()) {
      fail('active-turn.live-prefix.source-missing', 'live prefix requires a segment identity source');
    }
    await this.mutations;
    if (this.mutationFailure) {
      const cause = this.mutationFailure.cause;
      throw new RuntimeActiveTurnError(
        'active-turn.live-prefix.mutation-failed',
        cause instanceof Error ? cause.message : 'a prior required mutation failed',
      );
    }
    const entries = this.entries();
    const requests = this.requests();
    const childInvocations = this.childInvocations();
    const obligations: ActiveTurnProductionObligationRef[] = [
      ...projectRequestObligations(requests),
      ...projectChildObligations(childInvocations, entries),
    ];
    const initialInput = this.initialInput();
    return {
      kind: 'live-accepted-prefix',
      source,
      binding: structuredClone(this.binding),
      ...(initialInput === undefined ? {} : { initialInput }),
      entries,
      requests,
      childInvocations,
      watermark: {
        lastAcceptedSeq: entries.length === 0 ? 0 : entries[entries.length - 1]!.seq,
        controlRecordCount: this.records.length,
      },
      obligations,
    };
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

  private state(): ActiveTurnRecordState {
    return {
      records: this.records,
      execution: this.binding.execution,
      scope: this.binding.scope,
      commitId: (discriminator) => activeTurnCommitId(this.binding.admittedTurn.turnId, discriminator),
      append: async (commitId, record) => {
        await this.journal.append({ commitId, record });
        this.records.push(record);
      },
    };
  }

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
    return nextEntrySeq(this.records);
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

/** One durable segment record kind. A segment never carries a binding or a second initial input. */
export type ActiveTurnSegmentRecord = Exclude<ActiveTurnJournalRecord, { kind: 'binding-opened' | 'initial-input' }>;

/**
 * Owner-injected exact record boundary for one resumed segment. The J1 journal
 * owner provides the physical commit/read; this consumer only names the shape it
 * needs. A segment record keeps the current epoch's request, accepted-fact,
 * child-invocation and child-delivery content under the segment envelope. This
 * port is a consumer contract, not a second Journal or registry.
 */
export interface ActiveTurnSegmentRecordPort {
  appendSegmentRecord(input: {
    readonly businessTurnId: string;
    readonly segmentId: string;
    readonly commitId: string;
    readonly record: ActiveTurnSegmentRecord;
  }): Promise<JournalCommitRef>;
  readSegmentRecords(input: {
    readonly businessTurnId: string;
    readonly segmentId: string;
  }): Promise<readonly ActiveTurnSegmentRecord[]>;
}

export interface OpenActiveTurnSegmentInput {
  /** The actual opened segment record committed by the Journal owner. */
  readonly segment: ResumedTurnSegmentOpened;
  /** The unique original input asset; referenced, never copied or relabeled. */
  readonly initialInput: RawAsset;
  readonly port: ActiveTurnSegmentRecordPort;
}

/**
 * Runtime-owned mutable consumer for one resumed execution segment. It keeps
 * the actual opened record, the current binding and incarnation, and a fresh
 * producer barrier. It never reopens the original active turn, never mints a
 * new `AdmittedTurn` and never copies the old epoch's raw. Records it appends
 * stay in the current epoch with the real business turn id.
 */
export class ActiveTurnSegmentContext {
  private readonly records: ActiveTurnJournalRecord[];
  private readonly segment: ResumedTurnSegmentOpened;
  private readonly initialInputAsset: RawAsset;
  private readonly producers = new ActiveTurnProducerBarrier();
  private mutations: Promise<void> = Promise.resolve();
  private mutationFailure: { readonly cause: unknown } | undefined;
  private frozen = false;
  private drained = false;
  private captured: ActiveTurnSegmentCaptureV2 | undefined;
  private drainPromise: Promise<void> | undefined;

  private constructor(
    private readonly port: ActiveTurnSegmentRecordPort,
    segment: ResumedTurnSegmentOpened,
    initialInput: RawAsset,
    records: readonly ActiveTurnSegmentRecord[],
  ) {
    this.segment = structuredClone(segment);
    this.initialInputAsset = structuredClone(initialInput);
    this.records = structuredClone([...records]);
  }

  static async open(input: OpenActiveTurnSegmentInput): Promise<ActiveTurnSegmentContext> {
    validateResumedTurnSegmentOpened(input.segment);
    if (!input.initialInput.ref.digest) {
      fail('active-turn.segment.input-digest-missing', 'a resumed segment requires the original immutable input digest');
    }
    const records = await input.port.readSegmentRecords({
      businessTurnId: input.segment.businessTurnRef.businessTurnId,
      segmentId: input.segment.segmentId,
    });
    return new ActiveTurnSegmentContext(input.port, input.segment, input.initialInput, records);
  }

  get segmentOpened(): ResumedTurnSegmentOpened {
    return structuredClone(this.segment);
  }

  segmentBinding(): ActiveTurnSegmentBinding {
    return structuredClone(this.segment.binding);
  }

  executionIdentity(): ActiveTurnProviderExecutionIdentityRef {
    return structuredClone(this.segment.binding.execution);
  }

  scope(): ScopeRef {
    return structuredClone(this.segment.binding.scope);
  }

  originalInput(): RawAsset {
    return structuredClone(this.initialInputAsset);
  }

  async registerRequest(record: RuntimeRequestRecord): Promise<RuntimeRequestRecord> {
    const owned = structuredClone(record);
    return this.mutate(() => registerRequestRecord(this.state(), owned));
  }

  async registerProviderRequest(input: {
    readonly execution: ActiveTurnProviderExecutionIdentityRef;
    readonly record: RuntimeRequestRecord;
  }): Promise<RuntimeRequestRecord> {
    if (!sameProviderExecution(input.execution, this.segment.binding.execution)) {
      fail('active-turn.segment-request.execution-mismatch', 'request registration does not match the segment execution');
    }
    return this.registerRequest(input.record);
  }

  async acceptRawFact(envelope: RawFactEnvelope): Promise<AcceptedRawFact> {
    const owned = structuredClone(envelope);
    return this.mutate(() => acceptRawFactRecord(this.state(), owned));
  }

  async openChildInvocation(input: {
    readonly invocationId: string;
    readonly childTurnId: string;
    readonly checkpointReceiptRef: string;
    readonly binding: ChildCallBinding;
    readonly incarnation?: TaskRuntimeIncarnation;
  }): Promise<ChildInvocationRecord> {
    const owned = structuredClone(input);
    return this.mutate(() => openChildInvocationRecord(this.state(), owned));
  }

  async recordChildReturn(input: RecordChildReturnInput): Promise<AcceptedChildDelivery> {
    const owned = structuredClone(input);
    return this.mutate(() => recordChildReturnRecord(this.state(), owned));
  }

  async recordChildAdoption(invocationId: string, delivery: AcceptedChildDelivery): Promise<void> {
    const owned = structuredClone(delivery);
    return this.mutate(() => recordChildAdoptionRecord(this.state(), invocationId, owned));
  }

  async recordChildNonSelection(invocationId: string): Promise<void> {
    return this.mutate(() => recordChildNonSelectionRecord(this.state(), invocationId));
  }

  async recordReviewCheckpoint(invocationId: string, checkpointReceiptRef: string): Promise<void> {
    return this.mutate(() => recordReviewCheckpointRecord(this.state(), invocationId, checkpointReceiptRef));
  }

  entries(): readonly (AcceptedRawFact | AcceptedChildDelivery)[] {
    return structuredClone(projectEntries(this.records));
  }

  requests(): readonly RuntimeRequestRecord[] {
    return structuredClone(projectRequests(this.records));
  }

  childInvocations(): readonly ChildInvocationRecord[] {
    return structuredClone(projectChildInvocations(this.records));
  }

  /**
   * A live read over this segment's committed projection. It waits for accepted
   * mutations already in the queue but never closes admission, never drains
   * producers and never forges a capture cut. A required prior mutation failure
   * is retained and keeps surfacing instead of reading a successful tail.
   */
  async readLivePrefix(): Promise<ActiveTurnSegmentLivePrefix> {
    await this.mutations;
    if (this.mutationFailure) {
      const cause = this.mutationFailure.cause;
      throw new RuntimeActiveTurnError(
        'active-turn.segment-live-prefix.mutation-failed',
        cause instanceof Error ? cause.message : 'a prior required mutation failed',
      );
    }
    const entries = this.entries();
    const requests = this.requests();
    const childInvocations = this.childInvocations();
    const obligations: ActiveTurnProductionObligationRef[] = [
      ...projectRequestObligations(requests),
      ...projectChildObligations(childInvocations, entries),
    ];
    return {
      kind: 'segment-live-accepted-prefix',
      segment: structuredClone(this.segment),
      binding: structuredClone(this.segment.binding),
      initialInput: structuredClone(this.initialInputAsset),
      entries,
      requests,
      childInvocations,
      watermark: {
        lastAcceptedSeq: entries.length === 0 ? 0 : entries[entries.length - 1]!.seq,
        controlRecordCount: this.records.length,
      },
      obligations,
    };
  }

  /**
   * The immutable capture body for this segment, read from durable facts only.
   * It references the unique original input asset and keeps the exact
   * predecessor link. It never copies the old epoch's raw or relabels it.
   */
  captureSegment(input: { readonly boundaryId: string; readonly frozenAt: string }): ActiveTurnSegmentCaptureV2 {
    if (!this.drained) fail('active-turn.segment-capture.not-drained', 'prepareSegmentCapture must drain producers before reading a capture');
    if (this.captured) {
      if (this.captured.cut.pauseId !== input.boundaryId) {
        fail('active-turn.segment-capture.boundary-conflict', 'a frozen segment has one capture boundary');
      }
      return structuredClone(this.captured);
    }
    const entries = this.entries();
    const cut: TurnCaptureCut = {
      pauseId: input.boundaryId,
      lastSeq: entries.length === 0 ? 0 : entries[entries.length - 1]!.seq,
      producersDrained: true,
      frozenAt: input.frozenAt,
    };
    const body: ActiveTurnSegmentCaptureV2 = {
      version: 2,
      segmentId: this.segment.segmentId,
      businessTurnRef: this.segment.businessTurnRef,
      binding: this.segment.binding,
      initialInput: this.initialInputAsset,
      entries,
      requests: this.requests(),
      childInvocations: this.childInvocations(),
      cut,
      predecessor: this.segment.predecessor,
    };
    validateActiveTurnSegmentCaptureV2(body);
    this.captured = structuredClone(body);
    return structuredClone(this.captured);
  }

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

  controlRecordCount(): number { return this.records.length; }

  private state(): ActiveTurnRecordState {
    return {
      records: this.records,
      execution: this.segment.binding.execution,
      scope: this.segment.binding.scope,
      commitId: (discriminator) => activeTurnSegmentCommitId(this.segment.segmentId, discriminator),
      append: async (commitId, record) => {
        if (record.kind === 'binding-opened' || record.kind === 'initial-input') {
          fail('active-turn.segment.record-invalid', 'a resumed segment cannot append binding or initial-input records');
        }
        await this.port.appendSegmentRecord({
          businessTurnId: this.segment.businessTurnRef.businessTurnId,
          segmentId: this.segment.segmentId,
          commitId,
          record,
        });
        this.records.push(record);
      },
    };
  }

  private mutate<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.frozen) return Promise.reject(new RuntimeActiveTurnError('active-turn.segment.frozen', 'cannot mutate a frozen segment'));
    const result = this.mutations.then(mutation);
    this.mutations = result.then(
      () => undefined,
      (cause: unknown) => { this.mutationFailure ??= { cause }; },
    );
    return result.then((value) => structuredClone(value));
  }
}
