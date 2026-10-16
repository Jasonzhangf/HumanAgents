import {
  assertProviderExecutionIdentity,
  assertEvidenceRef,
  assertSameScope,
  assertScope,
  validateWorkAssignment,
  validateWorkResult,
  type AnyProviderExecutionIdentityRef,
  type AdmittedTurn,
  type EvidenceRef,
  type ProviderError,
  type ProviderExecutionIdentityRef,
  type ProviderToolCall,
  type ProviderToolResult,
  type ScopeRef,
  type TaskRuntimeIncarnation,
  type WorkAssignment,
  type WorkResult,
} from './index.js';
import {
  assertReviewAssignmentsMatch,
  assertReviewResultMatchesAssignment,
  validateReviewAssignment,
  validateReviewResult,
  type ReviewAssignment,
  type ReviewResult,
} from './review-data.js';
import { ContractError } from './errors.js';
import type { CompletionReadInput } from './operation-completion.js';
import type { RecoveryHoldFacts } from './native-reasoning.js';

/**
 * W1 raw boundary. A Provider produces ordered raw facts. The Runtime owns the
 * business active turn, its acceptance order, and the pause capture body.
 * This module defines the shared types only. It holds no store, registry, codec
 * or runtime state.
 */

/**
 * The active-turn raw boundary identity. Prefixed so the public barrel does not
 * shadow it with the Provider-wide `ProviderExecutionIdentityRef` in index.ts.
 */
export interface ActiveTurnProviderExecutionIdentityRef {
  readonly runtimeId: string;
  readonly executionEpoch: number;
}

export interface ActiveTurnProviderRequestIdentityRef {
  readonly turnId: string;
  readonly requestId: string;
  readonly parentRequestId?: string;
}

export type ContentUnitChannel =
  | 'assistant-text'
  | 'reasoning-text'
  | 'reasoning-summary'
  | 'reasoning-signature'
  | 'tool-arguments';

/** Closed set of provider readback selectors. No arbitrary JSON path or script. */
export type RawAssetView =
  | { readonly kind: 'utf8-text' }
  | { readonly kind: 'text-field'; readonly field: 'text' | 'delta' }
  | { readonly kind: 'content-part'; readonly partIndex: number }
  | { readonly kind: 'arguments' }
  | { readonly kind: 'thinking-field'; readonly field: 'thinking' | 'signature' }
  | { readonly kind: 'reasoning-item'; readonly selector: 'item-text' | 'summary' };

/** A read-only asset descriptor. The digest lives on ref.digest, never duplicated. */
export interface RawAsset {
  readonly ref: EvidenceRef;
  readonly view: RawAssetView;
}

/** The public raw read seam. The Provider readback implements it; the App only assembles it. */
export interface RawContentReadPort {
  read(input: {
    readonly scope: ScopeRef;
    readonly content: RawAsset;
  }): Promise<Uint8Array>;
}

export type ProviderRawFact<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> =
  | {
      readonly kind: 'content';
      readonly contentUnitId: string;
      readonly channel: ContentUnitChannel;
      readonly update: 'delta' | 'full';
      readonly content: RawAsset;
      readonly complete: boolean;
      readonly replacesUnitIds?: readonly string[];
    }
  | {
      readonly kind: 'content-complete';
      readonly contentUnitId: string;
    }
  | {
      readonly kind: 'tool-call';
      readonly contentUnitId: string;
      readonly call: ProviderToolCall;
      readonly rawArguments: RawAsset;
      readonly complete: true;
    }
  | {
      readonly kind: 'tool-result';
      readonly contentUnitId: string;
      readonly callId: string;
      readonly continuationRef: string;
      readonly result: ProviderToolResult<TIdentity>;
      readonly rawOutput: RawAsset;
      readonly complete: true;
    }
  | {
      readonly kind: 'request-complete';
      readonly terminal: 'completed' | 'incomplete' | 'failed' | 'cancelled';
      readonly error?: ProviderError;
    };

export interface RawFactEnvelope<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly request: ActiveTurnProviderRequestIdentityRef;
  readonly producerSeq: number;
  readonly fact: ProviderRawFact<TIdentity>;
}

/** A fact accepted by the Runtime, carrying the Runtime-assigned instance sequence. */
export interface AcceptedRawFact<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> {
  readonly seq: number;
  readonly envelope: RawFactEnvelope<TIdentity>;
}

/** The kind of child call a review or execution invocation is bound to. */
export type ChildCallKind = 'execution' | 'review';

export interface ExecutionChildCallBinding {
  readonly kind: 'execution';
  readonly assignment: WorkAssignment;
}

export interface ReviewChildCallBinding {
  readonly kind: 'review';
  readonly assignment: ReviewAssignment;
}

/**
 * The typed assignment a dispatched child call is bound to. It is recorded on
 * the invocation before the child runs, so a returned delivery can be matched
 * to the call that was actually dispatched.
 */
export type ChildCallBinding = ExecutionChildCallBinding | ReviewChildCallBinding;

/**
 * A refined execution delivery accepted into the parent active turn. It carries
 * no Provider envelope and never the child raw transcript. It reuses the real
 * child WorkAssignment/WorkResult identity and the persisted refined asset.
 */
export interface AcceptedExecutionChildDelivery {
  readonly kind: 'execution';
  readonly seq: number;
  readonly invocationId: string;
  readonly refinedDelivery: RawAsset;
  readonly assignment: WorkAssignment;
  readonly result: WorkResult;
}

/**
 * A refined review delivery accepted into the parent active turn. The reviewer
 * return stays a ReviewResult; it is never converted to a WorkResult. It
 * reuses the real ReviewAssignment/ReviewResult identity and the persisted
 * refined asset.
 */
export interface AcceptedReviewChildDelivery {
  readonly kind: 'review';
  readonly seq: number;
  readonly invocationId: string;
  readonly refinedDelivery: RawAsset;
  readonly assignment: ReviewAssignment;
  readonly result: ReviewResult;
}

export type AcceptedChildDelivery = AcceptedExecutionChildDelivery | AcceptedReviewChildDelivery;

/**
 * One Runtime-accepted entry: a Provider raw fact or a refined child delivery.
 * The raw fact carries the producing execution identity, so this stays generic
 * over the neutral identity union while the default preserves the Task-bound shape.
 */
export type AcceptedTurnEntry<
  TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef,
> = AcceptedRawFact<TIdentity> | AcceptedChildDelivery;

export type RuntimeRequestLifecyclePhase = 'dispatching' | 'dispatched' | 'waiting' | 'settled' | 'failed' | 'cancelled';

export interface RuntimeRequestRecord {
  readonly request: ActiveTurnProviderRequestIdentityRef;
  readonly parentRequestId?: string;
  readonly scope: ScopeRef;
  readonly phase: RuntimeRequestLifecyclePhase;
}

/** Required acknowledgement before native Provider dispatch. */
export interface NativeRequestRegistration {
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly record: RuntimeRequestRecord;
}

/** Returned only after this producer's admitted work actually finished. */
export interface ProviderProducerDrainResult {
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly boundaryId: string;
  readonly requests: readonly {
    readonly request: ActiveTurnProviderRequestIdentityRef;
    readonly lastProducerSeq: number;
  }[];
}

export interface ChildInvocationRecord {
  readonly invocationId: string;
  readonly childTurnId: string;
  /** The pre-call checkpoint that anchors recovery before the child runs. */
  readonly checkpointReceiptRef: string;
  /** The typed assignment the dispatched child call is bound to. */
  readonly binding: ChildCallBinding;
  /**
   * The actual acquired execution instance when the producer received a real
   * pool lease. Legacy records without this field keep the relation unknown.
   */
  readonly incarnation?: TaskRuntimeIncarnation;
  /**
   * Set only after the parent receives the matching refined delivery and selects
   * it for adopted semantic context. Mutually exclusive with
   * `notSelectedResultSeq`.
   */
  readonly adoptedResultSeq?: number;
  /**
   * Set only after the parent makes a terminal decision not to select this exact
   * retained delivery for adopted semantic context. It references the same
   * accepted child delivery entry, so the returned delivery stays immutable
   * evidence. Mutually exclusive with `adoptedResultSeq`.
   */
  readonly notSelectedResultSeq?: number;
  /**
   * Set only for a review invocation after the review-result checkpoint is
   * durably committed. It is a separate reference from the pre-call
   * `checkpointReceiptRef`, so the dispatch checkpoint is never read back as the
   * persisted review result.
   */
  readonly postReviewCheckpointRef?: string;
}

export interface TurnCaptureCut {
  readonly pauseId: string;
  readonly lastSeq: number;
  readonly producersDrained: true;
  readonly frozenAt: string;
}

export interface CompletionRef {
  readonly requestId: string;
  readonly producerSeq: number;
  readonly effectRef?: string;
}

/** The Runtime-owned business identity of one active turn. */
export interface ActiveTurnBinding {
  readonly admittedTurn: AdmittedTurn;
  readonly assignment: WorkAssignment;
  readonly execution: ActiveTurnProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
}

/**
 * The immutable active-turn capture body. F2 saves this body. W2 completion
 * truth is referenced through completionRefs, never copied here.
 */
export interface ActiveTurnCaptureBody {
  readonly version: 1;
  readonly binding: ActiveTurnBinding;
  readonly initialInput: RawAsset;
  readonly entries: readonly AcceptedTurnEntry[];
  readonly requests: readonly RuntimeRequestRecord[];
  readonly childInvocations: readonly ChildInvocationRecord[];
  readonly checkpointPath: readonly string[];
  readonly cut: TurnCaptureCut;
  readonly completionRefs: readonly CompletionRef[];
}

/** Production control proof kept beside, rather than inside, raw content. */
export interface PreparedRecoveryCapture {
  readonly body: ActiveTurnCaptureBody;
  readonly controlRecordCount: number;
  readonly producerDrains: readonly ProviderProducerDrainResult[];
  readonly completionLookups: readonly CompletionReadInput[];
  readonly recovery: RecoveryHoldFacts;
}

export interface RecoveryAssetsReceipt {
  readonly commitIdentity: string;
  readonly journalReceiptRef: string;
  readonly commitFactDigest: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
  readonly turnId: string;
  readonly boundaryId: string;
  readonly capture: RawAsset;
}

export interface RecoveryAssetsReadback {
  readonly receipt: RecoveryAssetsReceipt;
  readonly prepared: PreparedRecoveryCapture;
}

/** Checks source relationships, not the truth of a producer's execution. */
export function validatePreparedRecoveryCapture(input: PreparedRecoveryCapture): void {
  validateActiveTurnCaptureBody(input.body);
  assertNonNegativeSafeInteger(input.controlRecordCount, 'capture controlRecordCount');
  const { body } = input;
  const requests = new Map<string, { request: ActiveTurnProviderRequestIdentityRef; lastProducerSeq: number }>();
  for (const drain of input.producerDrains) {
    if (drain.boundaryId !== body.cut.pauseId
      || drain.execution.runtimeId !== body.binding.execution.runtimeId
      || drain.execution.executionEpoch !== body.binding.execution.executionEpoch) {
      throw new ContractError('producer drain does not belong to this capture boundary and execution');
    }
    for (const record of drain.requests) {
      assertProviderRequestIdentity(record.request, 'drained request');
      assertNonNegativeSafeInteger(record.lastProducerSeq, 'drained request lastProducerSeq');
      if (requests.has(record.request.requestId)) throw new ContractError('capture repeats a drained request');
      requests.set(record.request.requestId, record);
      if (!body.requests.some((candidate) => candidate.request.requestId === record.request.requestId
        && candidate.request.turnId === record.request.turnId
        && candidate.request.parentRequestId === record.request.parentRequestId)) {
        throw new ContractError('drained request is absent from the fixed control cut');
      }
    }
  }
  for (const record of body.requests) {
    if (!requests.has(record.request.requestId)) throw new ContractError('capture request has no producer drain');
  }
  for (const [requestId, drained] of requests) {
    const raw = body.entries.filter((entry) => 'envelope' in entry && entry.envelope.request.requestId === requestId) as AcceptedRawFact[];
    const lastSeq = raw.reduce((last, entry) => Math.max(last, entry.envelope.producerSeq), 0);
    if (lastSeq !== drained.lastProducerSeq) throw new ContractError('producer drain sequence does not match durable raw');
  }
  for (const lookup of input.completionLookups) {
    if (lookup.binding.execution.runtimeId !== body.binding.execution.runtimeId
      || lookup.binding.execution.executionEpoch !== body.binding.execution.executionEpoch
      || lookup.binding.execution.taskId.value !== body.binding.admittedTurn.taskRef.value) {
      throw new ContractError('completion lookup does not belong to the captured execution');
    }
  }
  assertNonEmptyString(input.recovery.recoveryResponsibilityRef, 'capture recovery responsibility');
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError(`${label} must be a non-empty string`);
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ContractError(`${label} must be a positive safe integer`);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ContractError(`${label} must be a non-negative safe integer`);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ContractError(`${label} must be an object`);
}

const FORBIDDEN_BOUNDARY_FIELDS = ['payload', 'metadata', 'summary', 'eventId'] as const;

function assertNoBusinessMirror(value: Record<string, unknown>, label: string): void {
  for (const field of FORBIDDEN_BOUNDARY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) throw new ContractError(`${label} cannot carry ${field}`);
  }
}

function assertRawAsset(value: unknown, label: string): asserts value is RawAsset {
  assertPlainObject(value, label);
  assertEvidenceRef(value.ref as EvidenceRef);
  assertPlainObject(value.view, `${label} view`);
  const kind = value.view.kind;
  if (kind === 'content-part') assertNonNegativeSafeInteger(value.view.partIndex, `${label} view partIndex`);
  else if (kind === 'utf8-text' || kind === 'arguments') return;
  else if (kind === 'text-field' && (value.view.field === 'text' || value.view.field === 'delta')) return;
  else if (kind === 'thinking-field' && (value.view.field === 'thinking' || value.view.field === 'signature')) return;
  else if (kind === 'reasoning-item' && (value.view.selector === 'item-text' || value.view.selector === 'summary')) return;
  else throw new ContractError(`${label} view kind is invalid`);
}

function assertProviderExecution(value: unknown, label: string): asserts value is ActiveTurnProviderExecutionIdentityRef {
  assertPlainObject(value, label);
  assertNonEmptyString(value.runtimeId, `${label} runtimeId`);
  assertPositiveSafeInteger(value.executionEpoch, `${label} executionEpoch`);
}

function assertProviderRequestIdentity(value: unknown, label: string): asserts value is ActiveTurnProviderRequestIdentityRef {
  assertPlainObject(value, label);
  assertNonEmptyString(value.turnId, `${label} turnId`);
  assertNonEmptyString(value.requestId, `${label} requestId`);
  if (value.parentRequestId !== undefined) {
    assertNonEmptyString(value.parentRequestId, `${label} parentRequestId`);
    if (value.parentRequestId === value.requestId) throw new ContractError(`${label} parentRequestId cannot equal requestId`);
  }
}

const CONTENT_CHANNELS: readonly ContentUnitChannel[] = [
  'assistant-text', 'reasoning-text', 'reasoning-summary', 'reasoning-signature', 'tool-arguments',
];

function validateRawFact(fact: unknown, label: string): asserts fact is ProviderRawFact<AnyProviderExecutionIdentityRef> {
  assertPlainObject(fact, label);
  switch (fact.kind) {
    case 'content': {
      assertNonEmptyString(fact.contentUnitId, `${label} contentUnitId`);
      if (!CONTENT_CHANNELS.includes(fact.channel as ContentUnitChannel)) throw new ContractError(`${label} channel is invalid`);
      if (fact.update !== 'delta' && fact.update !== 'full') throw new ContractError(`${label} update is invalid`);
      assertRawAsset(fact.content, `${label} content`);
      if (typeof fact.complete !== 'boolean') throw new ContractError(`${label} complete must be a boolean`);
      if (fact.replacesUnitIds !== undefined) {
        if (fact.update !== 'full') throw new ContractError(`${label} replacesUnitIds requires update full`);
        if (!Array.isArray(fact.replacesUnitIds) || fact.replacesUnitIds.length === 0) throw new ContractError(`${label} replacesUnitIds must be a non-empty array`);
        for (const unitId of fact.replacesUnitIds) assertNonEmptyString(unitId, `${label} replacesUnitIds entry`);
      }
      return;
    }
    case 'content-complete': {
      assertNonEmptyString(fact.contentUnitId, `${label} contentUnitId`);
      return;
    }
    case 'tool-call': {
      assertNonEmptyString(fact.contentUnitId, `${label} contentUnitId`);
      assertPlainObject(fact.call, `${label} call`);
      assertNonEmptyString(fact.call.callId, `${label} call.callId`);
      assertNonEmptyString(fact.call.toolId, `${label} call.toolId`);
      assertNonEmptyString(fact.call.continuationRef, `${label} call.continuationRef`);
      assertRawAsset(fact.rawArguments, `${label} rawArguments`);
      if (fact.complete !== true) throw new ContractError(`${label} tool call must be complete`);
      return;
    }
    case 'tool-result': {
      assertNonEmptyString(fact.contentUnitId, `${label} contentUnitId`);
      assertNonEmptyString(fact.callId, `${label} callId`);
      assertNonEmptyString(fact.continuationRef, `${label} continuationRef`);
      assertPlainObject(fact.result, `${label} result`);
      // The tool result carries the producing execution identity. Validate it with
      // the single contract identity validator so a taskless helper result (full
      // helper identity, no task/cycle) and a legacy Task result both pass, while a
      // half-formed or mixed identity is rejected before the fact is accepted.
      assertProviderExecutionIdentity(fact.result as unknown as AnyProviderExecutionIdentityRef);
      assertNonEmptyString(fact.result.callId, `${label} result.callId`);
      if (fact.result.callId !== fact.callId) throw new ContractError(`${label} result.callId must match callId`);
      assertRawAsset(fact.rawOutput, `${label} rawOutput`);
      if (fact.complete !== true) throw new ContractError(`${label} tool result must be complete`);
      return;
    }
    case 'request-complete': {
      if (fact.terminal !== 'completed' && fact.terminal !== 'incomplete' && fact.terminal !== 'failed' && fact.terminal !== 'cancelled') {
        throw new ContractError(`${label} terminal is invalid`);
      }
      if (fact.error !== undefined) {
        assertPlainObject(fact.error, `${label} error`);
        assertNonEmptyString(fact.error.code, `${label} error.code`);
      }
      return;
    }
    default:
      throw new ContractError(`${label} kind is invalid`);
  }
}

export function validateRawFactEnvelope(input: unknown): asserts input is RawFactEnvelope<AnyProviderExecutionIdentityRef> {
  assertPlainObject(input, 'raw fact envelope');
  assertNoBusinessMirror(input, 'raw fact envelope');
  assertProviderExecution(input.execution, 'raw fact execution');
  assertPlainObject(input.scope, 'raw fact scope');
  assertScope(input.scope.organId as ScopeRef['organId'], 'organ');
  assertProviderRequestIdentity(input.request, 'raw fact request');
  assertPositiveSafeInteger(input.producerSeq, 'raw fact producerSeq');
  validateRawFact(input.fact, 'raw fact');
  // A tool-result fact must belong to the same runtime instance and epoch as its
  // envelope. Otherwise a result produced by another execution could be durably
  // persisted under this request's acceptance order.
  if (input.fact.kind === 'tool-result'
    && (input.fact.result.runtimeId !== input.execution.runtimeId
      || input.fact.result.executionEpoch !== input.execution.executionEpoch)) {
    throw new ContractError('raw fact tool result execution does not match envelope execution');
  }
}

export function validateAcceptedRawFact(input: unknown): asserts input is AcceptedRawFact<AnyProviderExecutionIdentityRef> {
  assertPlainObject(input, 'accepted raw fact');
  assertPositiveSafeInteger(input.seq, 'accepted raw fact seq');
  validateRawFactEnvelope(input.envelope);
}

function assertWorkAssignmentShape(value: unknown, label: string): asserts value is WorkAssignment {
  assertPlainObject(value, label);
  assertPlainObject(value.taskId, `${label} taskId`);
  if (!Array.isArray(value.successCriteria)) throw new ContractError(`${label} successCriteria must be an array`);
  validateWorkAssignment(value as unknown as WorkAssignment);
}

function assertChildCallBinding(value: unknown, label: string): asserts value is ChildCallBinding {
  assertPlainObject(value, label);
  if (value.kind === 'execution') {
    assertWorkAssignmentShape(value.assignment, `${label} assignment`);
    return;
  }
  if (value.kind === 'review') {
    validateReviewAssignment(value.assignment);
    return;
  }
  throw new ContractError(`${label} kind is invalid`);
}

export function validateChildInvocationIncarnation(
  incarnation: unknown,
  binding: ChildCallBinding,
  label: string,
): asserts incarnation is TaskRuntimeIncarnation {
  assertPlainObject(incarnation, `${label} incarnation`);
  assertNonEmptyString(incarnation.runtimeId, `${label} incarnation runtimeId`);
  assertPositiveSafeInteger(incarnation.generation, `${label} incarnation generation`);
  assertNonEmptyString(incarnation.agentInstanceId, `${label} incarnation agentInstanceId`);
  assertNonEmptyString(incarnation.roleId, `${label} incarnation roleId`);
  assertPlainObject(incarnation.taskId, `${label} incarnation taskId`);
  assertScope(incarnation.taskId as unknown as Parameters<typeof assertScope>[0], 'task');
  assertNonEmptyString(incarnation.assignmentId, `${label} incarnation assignmentId`);
  assertPositiveSafeInteger(incarnation.executionEpoch, `${label} incarnation executionEpoch`);
  const taskId = binding.kind === 'execution' ? binding.assignment.taskId.value : binding.assignment.taskId;
  if (incarnation.taskId.value !== taskId
    || incarnation.assignmentId !== binding.assignment.assignmentId
    || incarnation.executionEpoch !== binding.assignment.executionEpoch) {
    throw new ContractError(`${label} incarnation does not match its invocation binding`);
  }
}

function assertSameExecutionAssignmentIdentity(binding: WorkAssignment, delivery: WorkAssignment): void {
  if (binding.assignmentId !== delivery.assignmentId
    || binding.taskId.value !== delivery.taskId.value
    || binding.pipelineNodeId !== delivery.pipelineNodeId
    || binding.attempt !== delivery.attempt
    || binding.executionEpoch !== delivery.executionEpoch
    || binding.inputRevision !== delivery.inputRevision) {
    throw new ContractError('capture child delivery does not match its invocation assignment');
  }
}

export function validateAcceptedChildDelivery(input: unknown): asserts input is AcceptedChildDelivery {
  assertPlainObject(input, 'accepted child delivery');
  assertPositiveSafeInteger(input.seq, 'accepted child delivery seq');
  assertNonEmptyString(input.invocationId, 'accepted child delivery invocationId');
  assertRawAsset(input.refinedDelivery, 'accepted child delivery refinedDelivery');
  if (input.kind === 'execution') {
    assertWorkAssignmentShape(input.assignment, 'accepted child delivery assignment');
    assertPlainObject(input.result, 'accepted child delivery result');
    validateWorkResult(input.result as unknown as WorkResult, input.assignment);
    return;
  }
  if (input.kind === 'review') {
    validateReviewAssignment(input.assignment);
    validateReviewResult(input.result);
    assertReviewResultMatchesAssignment(input.assignment, input.result);
    return;
  }
  throw new ContractError('accepted child delivery kind is invalid');
}

/**
 * Shared child-reference validation for the v1 capture body and the v2 segment
 * capture. It checks each invocation identity, its typed binding, the pre-call
 * anchor, the optional post-review association and the terminal selection
 * reference. A selection reference (`adoptedResultSeq` or
 * `notSelectedResultSeq`) must resolve to a retained child delivery of the same
 * invocation, kind and assignment identity; the two selection fields are
 * mutually exclusive. It reads typed facts only: it never inspects a Provider
 * outcome and never reconstructs a Runtime decision.
 */
export function validateChildInvocationReferences(
  childInvocations: unknown,
  entries: readonly AcceptedTurnEntry[],
  label: string,
): void {
  if (!Array.isArray(childInvocations)) throw new ContractError(`${label} childInvocations must be an array`);
  const invocationById = new Map<string, ChildInvocationRecord>();
  for (const invocation of childInvocations as readonly ChildInvocationRecord[]) {
    assertPlainObject(invocation, `${label} child invocation`);
    assertNonEmptyString(invocation.invocationId, `${label} child invocationId`);
    assertNonEmptyString(invocation.childTurnId, `${label} child turnId`);
    assertNonEmptyString(invocation.checkpointReceiptRef, `${label} child checkpointReceiptRef`);
    assertChildCallBinding(invocation.binding, `${label} child invocation binding`);
    if (invocation.incarnation !== undefined) {
      validateChildInvocationIncarnation(invocation.incarnation, invocation.binding, `${label} child invocation`);
    }
    if (invocation.postReviewCheckpointRef !== undefined) {
      if (invocation.binding.kind !== 'review') throw new ContractError(`${label} child post-review checkpoint requires a review invocation`);
      assertNonEmptyString(invocation.postReviewCheckpointRef, `${label} child postReviewCheckpointRef`);
      if (invocation.postReviewCheckpointRef === invocation.checkpointReceiptRef) {
        throw new ContractError(`${label} child post-review checkpoint must differ from the pre-call checkpoint`);
      }
    }
    if (invocation.adoptedResultSeq !== undefined && invocation.notSelectedResultSeq !== undefined) {
      throw new ContractError(`${label} child invocation cannot both adopt and not select its delivery`);
    }
    for (const selection of [invocation.adoptedResultSeq, invocation.notSelectedResultSeq]) {
      if (selection === undefined) continue;
      assertPositiveSafeInteger(selection, `${label} child selection resultSeq`);
      const selected = entries.find((entry) => entry.seq === selection);
      if (!selected) throw new ContractError(`${label} child selection resultSeq must reference an accepted entry`);
      if ('envelope' in selected) throw new ContractError(`${label} child selection resultSeq must reference a child delivery entry`);
      if (selected.invocationId !== invocation.invocationId) throw new ContractError(`${label} child selection resultSeq must reference the same invocation`);
      if (selected.kind !== invocation.binding.kind) throw new ContractError(`${label} child selection result kind does not match its invocation binding`);
      if (selected.kind === 'execution' && invocation.binding.kind === 'execution') {
        assertSameExecutionAssignmentIdentity(invocation.binding.assignment, selected.assignment);
      } else if (selected.kind === 'review' && invocation.binding.kind === 'review') {
        assertReviewAssignmentsMatch(invocation.binding.assignment, selected.assignment);
      }
    }
    invocationById.set(invocation.invocationId, invocation);
  }
  for (const entry of entries) {
    if ('envelope' in entry) continue;
    const invocation = invocationById.get(entry.invocationId);
    if (!invocation) throw new ContractError(`${label} child delivery must reference a known invocation`);
    if (entry.kind !== invocation.binding.kind) throw new ContractError(`${label} child delivery kind does not match its invocation binding`);
    if (entry.kind === 'execution' && invocation.binding.kind === 'execution') {
      assertSameExecutionAssignmentIdentity(invocation.binding.assignment, entry.assignment);
    } else if (entry.kind === 'review' && invocation.binding.kind === 'review') {
      assertReviewAssignmentsMatch(invocation.binding.assignment, entry.assignment);
    }
  }
}

export function validateActiveTurnCaptureBody(input: unknown): asserts input is ActiveTurnCaptureBody {
  assertPlainObject(input, 'active turn capture body');
  assertNoBusinessMirror(input, 'active turn capture body');
  if (input.version !== 1) throw new ContractError('active turn capture body version must be 1');

  assertPlainObject(input.binding, 'capture binding');
  const binding = input.binding as unknown as ActiveTurnBinding;
  assertPlainObject(binding.admittedTurn, 'capture binding admittedTurn');
  assertNonEmptyString(binding.admittedTurn.turnId, 'capture binding admittedTurn.turnId');
  assertNonEmptyString(binding.admittedTurn.workAssignmentRef, 'capture binding admittedTurn.workAssignmentRef');
  assertScope(binding.admittedTurn.taskRef, 'task');
  assertScope(binding.admittedTurn.scopeRef.organId, 'organ');
  assertScope(binding.admittedTurn.cycleRef, 'cycle');
  assertPositiveSafeInteger(binding.admittedTurn.executionEpoch, 'capture binding admittedTurn.executionEpoch');
  assertPlainObject(binding.assignment, 'capture binding assignment');
  assertNonEmptyString(binding.assignment.assignmentId, 'capture binding assignment.assignmentId');
  assertScope(binding.assignment.taskId, 'task');
  assertPositiveSafeInteger(binding.assignment.executionEpoch, 'capture binding assignment.executionEpoch');
  assertProviderExecution(binding.execution, 'capture binding execution');
  assertPlainObject(binding.scope, 'capture binding scope');
  assertScope(binding.scope.organId as ScopeRef['organId'], 'organ');
  if (binding.scope.taskId !== undefined) assertScope(binding.scope.taskId, 'task');
  if (binding.scope.cycleId !== undefined) assertScope(binding.scope.cycleId, 'cycle');
  if (binding.scope.operationId !== undefined) assertScope(binding.scope.operationId, 'operation');

  if (binding.admittedTurn.workAssignmentRef !== binding.assignment.assignmentId) {
    throw new ContractError('capture binding assignment does not match admitted turn workAssignmentRef');
  }
  if (binding.admittedTurn.taskRef.value !== binding.assignment.taskId.value) {
    throw new ContractError('capture binding task does not match admitted turn taskRef');
  }
  assertSameScope(binding.admittedTurn.scopeRef, binding.scope);
  if (binding.assignment.executionEpoch !== binding.execution.executionEpoch
    || binding.admittedTurn.executionEpoch !== binding.execution.executionEpoch) {
    throw new ContractError('capture binding executionEpoch mismatch');
  }

  assertRawAsset(input.initialInput, 'capture initialInput');

  if (!Array.isArray(input.entries)) throw new ContractError('capture entries must be an array');
  const entries = input.entries as readonly AcceptedTurnEntry[];
  let previousSeq = 0;
  for (const entry of entries) {
    assertPlainObject(entry, 'capture entry');
    if ('envelope' in entry) {
      validateAcceptedRawFact(entry);
      if (entry.envelope.execution.executionEpoch !== binding.execution.executionEpoch) throw new ContractError('capture entry executionEpoch mismatch');
      assertScope(entry.envelope.scope.organId as ScopeRef['organId'], 'organ');
      assertSameScope(entry.envelope.scope, binding.scope);
    } else {
      validateAcceptedChildDelivery(entry);
    }
    if (entry.seq <= previousSeq) throw new ContractError('capture entries must be ordered by strictly increasing seq');
    previousSeq = entry.seq;
  }

  if (!Array.isArray(input.requests)) throw new ContractError('capture requests must be an array');
  for (const request of input.requests as readonly RuntimeRequestRecord[]) {
    assertPlainObject(request, 'capture request record');
    assertProviderRequestIdentity(request.request, 'capture request record request');
    if (request.parentRequestId !== undefined && request.parentRequestId !== request.request.parentRequestId) {
      throw new ContractError('capture request parentRequestId mismatch');
    }
    assertPlainObject(request.scope, 'capture request record scope');
    assertSameScope(request.scope, binding.scope);
    if (!['dispatching', 'dispatched', 'waiting', 'settled', 'failed', 'cancelled'].includes(request.phase)) {
      throw new ContractError('capture request record phase is invalid');
    }
  }

  validateChildInvocationReferences(input.childInvocations, entries, 'capture');

  if (!Array.isArray(input.checkpointPath)) throw new ContractError('capture checkpointPath must be an array');
  for (const ref of input.checkpointPath as readonly string[]) assertNonEmptyString(ref, 'capture checkpointPath entry');

  assertPlainObject(input.cut, 'capture cut');
  const cut = input.cut as unknown as TurnCaptureCut;
  assertNonEmptyString(cut.pauseId, 'capture cut pauseId');
  assertNonNegativeSafeInteger(cut.lastSeq, 'capture cut lastSeq');
  if (cut.producersDrained !== true) throw new ContractError('capture cut producersDrained must be true');
  assertNonEmptyString(cut.frozenAt, 'capture cut frozenAt');
  const maxEntrySeq = entries.length === 0 ? 0 : entries[entries.length - 1]!.seq;
  if (cut.lastSeq !== maxEntrySeq) throw new ContractError('capture cut lastSeq must equal the last entry seq');

  if (!Array.isArray(input.completionRefs)) throw new ContractError('capture completionRefs must be an array');
  for (const completion of input.completionRefs as readonly CompletionRef[]) {
    assertPlainObject(completion, 'capture completion ref');
    assertNonEmptyString(completion.requestId, 'capture completion ref requestId');
    assertPositiveSafeInteger(completion.producerSeq, 'capture completion ref producerSeq');
    if (completion.effectRef !== undefined) assertNonEmptyString(completion.effectRef, 'capture completion ref effectRef');
  }
}
