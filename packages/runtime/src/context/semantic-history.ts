import {
  assertEvidenceRef,
  canonicalJsonStringify,
  checkpointCommitIdentityV2,
  scopeDigest,
  validateAdmittedTurn,
  validateCheckpointReceiptRelationship,
  type AdmittedTurn,
  type AdmittedTurnIdentity,
  type CanonicalUtcInstant,
  type Checkpoint,
  type CheckpointCommitIdentityV2,
  type CheckpointReceiptRelationshipV1,
  type CheckpointTimeAuthorityMetadata,
  type EvidenceRef,
  type RawAsset,
  type RecoveryHoldFacts,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { isCanonicalInstant } from '../../../contracts/src/time.js';
import { activeTurnCommitId } from './active-turn-journal.js';

/**
 * Runtime-local semantic-history contract. It owns the accepted-view input
 * shape, the two durable phase identities and their fixed intent encodings, the
 * explicit four-part projection, and the committed output D consumes.
 *
 * This module is a pure contract boundary. It does not write a Journal, asset
 * store or checkpoint. A caller must still commit the exact records and verify
 * their receipts through the App persistence owner.
 */

export type SemanticHistoryDigestV1 = `sha256:${string}`;
export type SemanticContextViewIdentityV1 = `context-view:v1:${string}`;
export type SemanticHistoryPublicationIdentityV1 = `history-publication:v1:${string}`;

export class SemanticHistoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SemanticHistoryError';
  }
}

function fail(code: string, message: string): never {
  throw new SemanticHistoryError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) fail('semantic-history.input.invalid', `${label} must be a plain object`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('semantic-history.input.invalid', `${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('semantic-history.input.invalid', `${label} does not accept ${key}`);
  }
}

function assertNonEmptyString(value: unknown, label: string, code = 'semantic-history.input.invalid'): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) fail(code, `${label} must be a non-empty string`);
}

function assertPositiveSafeInteger(value: unknown, label: string, code = 'semantic-history.input.invalid'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail(code, `${label} must be a positive safe integer`);
  }
}

function assertStringArray(value: unknown, label: string, unique = false): asserts value is readonly string[] {
  if (!Array.isArray(value)) fail('semantic-history.input.invalid', `${label} must be an array`);
  for (const entry of value) assertNonEmptyString(entry, label);
  if (unique && new Set(value).size !== value.length) {
    fail('semantic-history.input.invalid', `${label} must not contain duplicates`);
  }
}

function assertScopedId(value: unknown, scope: 'organ' | 'task' | 'cycle' | 'operation' | 'checkpoint' | 'evidence', label: string): void {
  assertPlainObject(value, label);
  assertExactKeys(value, ['scope', 'value'], [], label);
  if (value.scope !== scope) fail('semantic-history.input.invalid', `${label} must use ${scope} scope`);
  assertNonEmptyString(value.value, `${label}.value`);
}

function assertScopeRefV1(value: unknown, label: string): asserts value is ScopeRef {
  assertPlainObject(value, label);
  assertExactKeys(value, ['organId'], ['taskId', 'cycleId', 'operationId'], label);
  assertScopedId(value.organId, 'organ', `${label}.organId`);
  if (Object.hasOwn(value, 'taskId')) assertScopedId(value.taskId, 'task', `${label}.taskId`);
  if (Object.hasOwn(value, 'cycleId')) assertScopedId(value.cycleId, 'cycle', `${label}.cycleId`);
  if (Object.hasOwn(value, 'operationId')) assertScopedId(value.operationId, 'operation', `${label}.operationId`);
}

function assertRawAssetV1(value: unknown, label: string): asserts value is RawAsset {
  assertPlainObject(value, label);
  assertExactKeys(value, ['ref', 'view'], [], label);
  try {
    assertEvidenceRef(value.ref as EvidenceRef);
  } catch (error) {
    fail('semantic-history.input.invalid', error instanceof Error ? error.message : `${label}.ref is invalid`);
  }
  assertPlainObject(value.view, `${label}.view`);
  const kind = value.view.kind;
  if (kind === 'content-part') {
    const partIndex = value.view.partIndex;
    if (typeof partIndex !== 'number' || !Number.isSafeInteger(partIndex) || partIndex < 0) {
      fail('semantic-history.input.invalid', `${label}.view.partIndex must be a non-negative safe integer`);
    }
    return;
  }
  if (kind === 'utf8-text' || kind === 'arguments') return;
  if (kind === 'text-field' && (value.view.field === 'text' || value.view.field === 'delta')) return;
  if (kind === 'thinking-field' && (value.view.field === 'thinking' || value.view.field === 'signature')) return;
  if (kind === 'reasoning-item' && (value.view.selector === 'item-text' || value.view.selector === 'summary')) return;
  fail('semantic-history.input.invalid', `${label}.view kind is invalid`);
}

function assertEvidenceRefsV1(value: unknown, label: string): asserts value is readonly EvidenceRef[] {
  if (!Array.isArray(value)) fail('semantic-history.input.invalid', `${label} must be an array`);
  for (const evidence of value) {
    try {
      assertEvidenceRef(evidence as EvidenceRef);
    } catch (error) {
      fail('semantic-history.input.invalid', error instanceof Error ? error.message : `${label} entry is invalid`);
    }
  }
}

function assertTimeAuthorityV1(value: unknown, label: string): asserts value is CheckpointTimeAuthorityMetadata {
  assertPlainObject(value, label);
  assertExactKeys(value, ['source', 'owner', 'authorityRef'], [], label);
  if (value.source !== 'harness') fail('semantic-history.input.invalid', `${label}.source must be harness`);
  if (value.owner !== 'runtime-checkpoint-control-owner') {
    fail('semantic-history.input.invalid', `${label}.owner is invalid`);
  }
  assertNonEmptyString(value.authorityRef, `${label}.authorityRef`);
}

function assertSha256DigestV1(value: unknown, label: string): asserts value is SemanticHistoryDigestV1 {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail('semantic-history.input.invalid', `${label} must be a lowercase sha256 digest`);
  }
}

function assertCanonicalInstantV1(value: unknown, label: string): asserts value is CanonicalUtcInstant {
  if (!isCanonicalInstant(value)) fail('semantic-history.input.invalid', `${label} must be a canonical UTC instant`);
}

function assertFourPartSemanticViewV1(value: unknown, label = 'semantics'): asserts value is FourPartSemanticViewV1 {
  assertPlainObject(value, label);
  assertExactKeys(value, ['goal', 'actions', 'result', 'nextStep'], [], label);
  assertNonEmptyString(value.goal, `${label}.goal`);
  assertNonEmptyString(value.actions, `${label}.actions`);
  assertNonEmptyString(value.result, `${label}.result`);
  assertNonEmptyString(value.nextStep, `${label}.nextStep`);
}

function assertSemanticViewAcceptanceV1(value: unknown, label = 'acceptance'): asserts value is SemanticViewAcceptanceV1 {
  assertPlainObject(value, label);
  assertExactKeys(value, ['ownerId', 'acceptanceRef', 'sourceEvidenceRefs'], [], label);
  assertNonEmptyString(value.ownerId, `${label}.ownerId`);
  assertNonEmptyString(value.acceptanceRef, `${label}.acceptanceRef`);
  assertEvidenceRefsV1(value.sourceEvidenceRefs, `${label}.sourceEvidenceRefs`);
}

function assertSemanticHistoryRecoveryV1(value: unknown, label = 'recovery'): asserts value is SemanticHistoryRecoveryV1 {
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    ['recoveryStateRef', 'recoveryResponsibilityRef', 'unresolvedOperationRefs', 'laterErrorRefs'],
    ['firstErrorRef'],
    label,
  );
  assertNonEmptyString(value.recoveryStateRef, `${label}.recoveryStateRef`);
  assertNonEmptyString(value.recoveryResponsibilityRef, `${label}.recoveryResponsibilityRef`);
  assertStringArray(value.unresolvedOperationRefs, `${label}.unresolvedOperationRefs`, true);
  assertStringArray(value.laterErrorRefs, `${label}.laterErrorRefs`, true);
  if (Object.hasOwn(value, 'firstErrorRef')) assertNonEmptyString(value.firstErrorRef, `${label}.firstErrorRef`);
}

function assertSemanticAssetDescriptorV1(value: unknown, label = 'semanticAsset'): asserts value is SemanticAssetDescriptorV1 {
  assertPlainObject(value, label);
  assertExactKeys(value, ['assetId', 'digest', 'locator', 'size'], [], label);
  if (typeof value.assetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.assetId)) {
    fail('semantic-history.input.invalid', `${label}.assetId is invalid`);
  }
  assertSha256DigestV1(value.digest, `${label}.digest`);
  assertNonEmptyString(value.locator, `${label}.locator`);
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
    fail('semantic-history.input.invalid', `${label}.size must be a non-negative safe integer`);
  }
}

function assertAdmittedTurnIdentityV1(value: unknown, label = 'turn'): asserts value is AdmittedTurnIdentity {
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    [
      'turnId', 'workAssignmentRef', 'taskRef', 'scopeRef', 'cycleRef', 'inputRevision',
      'directiveRevision', 'executionEpoch', 'runtimeBindingRef', 'permissionRevision',
    ],
    [],
    label,
  );
  assertNonEmptyString(value.turnId, `${label}.turnId`);
  assertNonEmptyString(value.workAssignmentRef, `${label}.workAssignmentRef`);
  assertScopedId(value.taskRef, 'task', `${label}.taskRef`);
  assertScopeRefV1(value.scopeRef, `${label}.scopeRef`);
  assertScopedId(value.cycleRef, 'cycle', `${label}.cycleRef`);
  assertPositiveSafeInteger(value.inputRevision, `${label}.inputRevision`);
  assertPositiveSafeInteger(value.directiveRevision, `${label}.directiveRevision`);
  assertPositiveSafeInteger(value.executionEpoch, `${label}.executionEpoch`);
  assertNonEmptyString(value.runtimeBindingRef, `${label}.runtimeBindingRef`);
  assertNonEmptyString(value.permissionRevision, `${label}.permissionRevision`);
}

function assertSemanticPhaseReceiptV1(
  value: unknown,
  expected?: { readonly phase?: SemanticPhase; readonly identity?: string },
): asserts value is SemanticPhaseReceiptV1 {
  assertPlainObject(value, 'phase receipt');
  assertExactKeys(
    value,
    ['phase', 'commitIdentity', 'journalReceiptRef', 'journalSeq', 'recordDigest', 'committedAt', 'timeAuthority'],
    [],
    'phase receipt',
  );
  if (value.phase !== 'context-view' && value.phase !== 'history-publication') {
    fail('semantic-history.phase.invalid', 'phase receipt phase is invalid');
  }
  if (expected?.phase !== undefined && value.phase !== expected.phase) {
    fail('semantic-history.phase.mismatch', `phase receipt must be ${expected.phase}`);
  }
  assertNonEmptyString(value.commitIdentity, 'phase receipt commitIdentity');
  if (expected?.identity !== undefined && value.commitIdentity !== expected.identity) {
    fail('semantic-history.phase.identity-mismatch', 'phase receipt commit identity does not match the recomputed identity');
  }
  assertNonEmptyString(value.journalReceiptRef, 'phase receipt journalReceiptRef');
  assertPositiveSafeInteger(value.journalSeq, 'phase receipt journalSeq');
  assertSha256DigestV1(value.recordDigest, 'phase receipt recordDigest');
  assertCanonicalInstantV1(value.committedAt, 'phase receipt committedAt');
  assertTimeAuthorityV1(value.timeAuthority, 'phase receipt timeAuthority');
}

function assertAdoptedChildSourceV1(value: unknown, label = 'adoptedChildren entry'): asserts value is AdoptedChildSourceV1 {
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    [
      'parentTurn', 'invocationId', 'childTurnId', 'deliverySeq', 'adoptionCommitId',
      'deliveryCommitId', 'kind', 'refinedDelivery', 'preCallCheckpointRef',
    ],
    ['postReviewCheckpointRef'],
    label,
  );
  assertAdmittedTurnIdentityV1(value.parentTurn, `${label}.parentTurn`);
  assertNonEmptyString(value.invocationId, `${label}.invocationId`);
  assertNonEmptyString(value.childTurnId, `${label}.childTurnId`);
  assertPositiveSafeInteger(value.deliverySeq, `${label}.deliverySeq`);
  assertNonEmptyString(value.adoptionCommitId, `${label}.adoptionCommitId`);
  assertNonEmptyString(value.deliveryCommitId, `${label}.deliveryCommitId`);
  if (value.kind !== 'execution' && value.kind !== 'review') fail('semantic-history.input.invalid', `${label}.kind is invalid`);
  assertRawAssetV1(value.refinedDelivery, `${label}.refinedDelivery`);
  assertNonEmptyString(value.preCallCheckpointRef, `${label}.preCallCheckpointRef`);
  if (Object.hasOwn(value, 'postReviewCheckpointRef')) {
    if (value.kind !== 'review') {
      fail('semantic-history.adoption.post-review-on-execution', `${label}.postReviewCheckpointRef requires a review invocation`);
    }
    assertNonEmptyString(value.postReviewCheckpointRef, `${label}.postReviewCheckpointRef`);
    if (value.postReviewCheckpointRef === value.preCallCheckpointRef) {
      fail('semantic-history.adoption.post-review-equals-pre-call', `${label} post-review checkpoint must differ from pre-call`);
    }
  }
  if (value.adoptionCommitId !== adoptedChildAdoptionCommitIdV1(value.parentTurn.turnId, value.invocationId)) {
    fail('semantic-history.adoption.commit-mismatch', `${label}.adoptionCommitId does not match the parent turn and invocation`);
  }
  if (value.deliveryCommitId !== adoptedChildDeliveryCommitIdV1(value.parentTurn.turnId, value.invocationId)) {
    fail('semantic-history.adoption.commit-mismatch', `${label}.deliveryCommitId does not match the parent turn and invocation`);
  }
}

function sameAdmittedTurnIdentity(left: AdmittedTurnIdentity, right: AdmittedTurnIdentity): boolean {
  return left.turnId === right.turnId
    && left.workAssignmentRef === right.workAssignmentRef
    && left.taskRef.scope === right.taskRef.scope
    && left.taskRef.value === right.taskRef.value
    && sameScopeRef(left.scopeRef, right.scopeRef)
    && left.cycleRef.scope === right.cycleRef.scope
    && left.cycleRef.value === right.cycleRef.value
    && left.inputRevision === right.inputRevision
    && left.directiveRevision === right.directiveRevision
    && left.executionEpoch === right.executionEpoch
    && left.runtimeBindingRef === right.runtimeBindingRef
    && left.permissionRevision === right.permissionRevision;
}

function sameScopedIdValue(
  left: { readonly scope: string; readonly value: string } | undefined,
  right: { readonly scope: string; readonly value: string } | undefined,
): boolean {
  return left?.scope === right?.scope && left?.value === right?.value;
}

function sameScopeRef(left: ScopeRef, right: ScopeRef): boolean {
  return sameScopedIdValue(left.organId, right.organId)
    && sameScopedIdValue(left.taskId, right.taskId)
    && sameScopedIdValue(left.cycleId, right.cycleId)
    && sameScopedIdValue(left.operationId, right.operationId);
}

function scopeTuple(scope: ScopeRef): readonly (string | null)[] {
  return [
    scope.organId.value,
    scope.taskId?.value ?? null,
    scope.cycleId?.value ?? null,
    scope.operationId?.value ?? null,
  ];
}

function admittedTurnIdentityTuple(turn: AdmittedTurnIdentity): readonly unknown[] {
  return [
    turn.turnId,
    turn.workAssignmentRef,
    [turn.taskRef.scope, turn.taskRef.value],
    scopeTuple(turn.scopeRef),
    [turn.cycleRef.scope, turn.cycleRef.value],
    turn.inputRevision,
    turn.directiveRevision,
    turn.executionEpoch,
    turn.runtimeBindingRef,
    turn.permissionRevision,
  ];
}

function semanticHistoryKeyTupleV1(key: SemanticHistoryKeyV1): readonly unknown[] {
  return ['semantic-history-key/v1', admittedTurnIdentityTuple(key.turn), key.checkpointIdentity];
}

function evidenceRefTuple(evidence: EvidenceRef): readonly unknown[] {
  return [
    evidence.evidenceId.scope,
    evidence.evidenceId.value,
    evidence.kind,
    evidence.source,
    evidence.locator,
    evidence.digest ?? null,
    scopeTuple(evidence.scope),
  ];
}

function acceptanceTuple(acceptance: SemanticViewAcceptanceV1): readonly unknown[] {
  return [
    acceptance.ownerId,
    acceptance.acceptanceRef,
    acceptance.sourceEvidenceRefs.map(evidenceRefTuple),
  ];
}

function assetDescriptorTuple(descriptor: SemanticAssetDescriptorV1): readonly unknown[] {
  return [descriptor.assetId, descriptor.digest, descriptor.locator, descriptor.size];
}

function checkpointBindingTuple(relationship: CheckpointReceiptRelationshipV1): readonly unknown[] {
  return [
    [relationship.checkpoint.id.scope, relationship.checkpoint.id.value],
    scopeTuple(relationship.checkpoint.scope),
    relationship.envelope.version,
    relationship.envelope.identity,
    relationship.envelope.committedAt,
    relationship.envelope.timeAuthority.source,
    relationship.envelope.timeAuthority.owner,
    relationship.envelope.timeAuthority.authorityRef,
    relationship.envelope.intentDigest,
    relationship.receipt.commitIdentity,
    relationship.receipt.checkpointRef,
    relationship.receipt.journalReceiptRef,
    relationship.receipt.committedAt,
    relationship.receipt.timeAuthority.source,
    relationship.receipt.timeAuthority.owner,
    relationship.receipt.timeAuthority.authorityRef,
    relationship.checkpointSeq,
    relationship.journalSeq,
    relationship.recordDigest,
  ];
}

function adoptedChildTuple(child: AdoptedChildSourceV1): readonly unknown[] {
  return [
    admittedTurnIdentityTuple(child.parentTurn),
    child.invocationId,
    child.childTurnId,
    child.deliverySeq,
    child.adoptionCommitId,
    child.deliveryCommitId,
    child.kind,
    [child.refinedDelivery.ref.evidenceId.scope, child.refinedDelivery.ref.evidenceId.value,
      child.refinedDelivery.ref.kind, child.refinedDelivery.ref.source, child.refinedDelivery.ref.locator,
      child.refinedDelivery.ref.digest ?? null, scopeTuple(child.refinedDelivery.ref.scope),
      child.refinedDelivery.view],
    child.preCallCheckpointRef,
    child.postReviewCheckpointRef ?? null,
  ];
}

function recoveryTuple(recovery: SemanticHistoryRecoveryV1): readonly unknown[] {
  return [
    recovery.recoveryStateRef,
    recovery.recoveryResponsibilityRef,
    recovery.unresolvedOperationRefs,
    recovery.firstErrorRef ?? null,
    recovery.laterErrorRefs,
  ];
}

function contextViewReceiptTuple(input: SemanticHistoryPublicationIntentInputV1['contextView']): readonly unknown[] {
  return [
    input.identity,
    input.receipt.phase,
    input.receipt.journalReceiptRef,
    input.receipt.journalSeq,
    input.receipt.recordDigest,
  ];
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Digest(value: string): Promise<SemanticHistoryDigestV1> {
  return `sha256:${await sha256Hex(value)}`;
}

export type SemanticPhase = 'context-view' | 'history-publication';

export interface FourPartSemanticViewV1 {
  readonly goal: string;
  readonly actions: string;
  readonly result: string;
  readonly nextStep: string;
}

export interface SemanticViewAcceptanceV1 {
  readonly ownerId: string;
  readonly acceptanceRef: string;
  readonly sourceEvidenceRefs: readonly EvidenceRef[];
}

export interface SemanticHistoryRecoveryV1 {
  readonly recoveryStateRef: AdmittedTurn['recoveryStateRef'];
  readonly recoveryResponsibilityRef: RecoveryHoldFacts['recoveryResponsibilityRef'];
  readonly unresolvedOperationRefs: RecoveryHoldFacts['unresolvedOperationRefs'];
  readonly firstErrorRef?: RecoveryHoldFacts['firstErrorRef'];
  readonly laterErrorRefs: RecoveryHoldFacts['laterErrorRefs'];
}

export interface SemanticAssetDescriptorV1 {
  readonly assetId: string;
  readonly digest: SemanticHistoryDigestV1;
  readonly locator: string;
  readonly size: number;
}

export interface SemanticAssetBodyV1 {
  readonly version: 1;
  readonly semantics: FourPartSemanticViewV1;
}

export interface AdoptedChildSourceV1 {
  readonly parentTurn: AdmittedTurnIdentity;
  readonly invocationId: string;
  readonly childTurnId: string;
  readonly deliverySeq: number;
  readonly adoptionCommitId: string;
  readonly deliveryCommitId: string;
  readonly kind: 'execution' | 'review';
  readonly refinedDelivery: RawAsset;
  readonly preCallCheckpointRef: string;
  readonly postReviewCheckpointRef?: string;
}

export interface AcceptedSemanticViewInputV1 {
  readonly version: 1;
  readonly admittedTurn: AdmittedTurn;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly acceptance: SemanticViewAcceptanceV1;
  readonly semantics: FourPartSemanticViewV1;
  readonly adoptedChildren: readonly AdoptedChildSourceV1[];
  readonly recovery: SemanticHistoryRecoveryV1;
}

export interface SemanticHistoryKeyInputV1 {
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
}

export interface SemanticHistoryKeyV1 {
  readonly version: 'semantic-history-key/v1';
  readonly turn: AdmittedTurnIdentity;
  readonly checkpointIdentity: CheckpointCommitIdentityV2;
}

export interface SemanticContextViewIntentInputV1 {
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly acceptance: SemanticViewAcceptanceV1;
  readonly semanticAsset: SemanticAssetDescriptorV1;
  readonly adoptedChildren: readonly AdoptedChildSourceV1[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly recovery: SemanticHistoryRecoveryV1;
}

export interface SemanticContextViewBodyV1 {
  readonly kind: 'native-semantic-context-view';
  readonly version: 1;
  readonly identity: SemanticContextViewIdentityV1;
  readonly intentDigest: SemanticHistoryDigestV1;
  readonly committedAt: CanonicalUtcInstant;
  readonly timeAuthority: CheckpointTimeAuthorityMetadata;
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly acceptance: SemanticViewAcceptanceV1;
  readonly semanticAsset: SemanticAssetDescriptorV1;
  readonly adoptedChildren: readonly AdoptedChildSourceV1[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly recovery: SemanticHistoryRecoveryV1;
}

export interface SemanticContextViewBodyInputV1 {
  readonly accepted: AcceptedSemanticViewInputV1;
  readonly semanticAsset: SemanticAssetDescriptorV1;
  readonly committedAt: CanonicalUtcInstant;
  readonly timeAuthority: CheckpointTimeAuthorityMetadata;
}

export interface SemanticPhaseReceiptV1 {
  readonly phase: SemanticPhase;
  readonly commitIdentity: string;
  readonly journalReceiptRef: string;
  readonly journalSeq: number;
  readonly recordDigest: SemanticHistoryDigestV1;
  readonly committedAt: CanonicalUtcInstant;
  readonly timeAuthority: CheckpointTimeAuthorityMetadata;
}

export interface SemanticHistoryPublicationIntentInputV1 {
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly contextView: {
    readonly identity: SemanticContextViewIdentityV1;
    readonly receipt: SemanticPhaseReceiptV1;
  };
}

export interface SemanticHistoryPublicationBodyV1 {
  readonly kind: 'native-semantic-history-publication';
  readonly version: 1;
  readonly identity: SemanticHistoryPublicationIdentityV1;
  readonly intentDigest: SemanticHistoryDigestV1;
  readonly committedAt: CanonicalUtcInstant;
  readonly timeAuthority: CheckpointTimeAuthorityMetadata;
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly contextView: {
    readonly identity: SemanticContextViewIdentityV1;
    readonly receipt: SemanticPhaseReceiptV1;
  };
}

export interface SemanticHistoryPublicationBodyInputV1 {
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly contextView: {
    readonly identity: SemanticContextViewIdentityV1;
    readonly receipt: SemanticPhaseReceiptV1;
  };
  readonly committedAt: CanonicalUtcInstant;
  readonly timeAuthority: CheckpointTimeAuthorityMetadata;
}

export interface SemanticHistoryExactLookupV1 {
  readonly scope: ScopeRef;
  readonly checkpoint: Pick<Checkpoint, 'id' | 'scope'>;
  readonly publicationReceiptRef: string;
}

export interface CommittedSemanticCheckpointV1 {
  readonly version: 1;
  readonly turn: AdmittedTurnIdentity;
  readonly scope: ScopeRef;
  readonly nativeCommitIdentity: CheckpointCommitIdentityV2;
  readonly time: CanonicalUtcInstant;
  readonly description: string;
  readonly semantics: FourPartSemanticViewV1;
  readonly save: {
    readonly checkpoint: CheckpointReceiptRelationshipV1;
    readonly contextView: SemanticPhaseReceiptV1;
    readonly historyPublication: SemanticPhaseReceiptV1;
  };
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly adoptedChildren: readonly AdoptedChildSourceV1[];
  readonly recovery: SemanticHistoryRecoveryV1;
}

export interface CommittedSemanticCheckpointInputV1 {
  readonly turn: AdmittedTurnIdentity;
  readonly checkpoint: CheckpointReceiptRelationshipV1;
  readonly contextView: SemanticPhaseReceiptV1;
  readonly historyPublication: SemanticPhaseReceiptV1;
  readonly semantics: FourPartSemanticViewV1;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly adoptedChildren: readonly AdoptedChildSourceV1[];
  readonly recovery: SemanticHistoryRecoveryV1;
}

/** Explicit projection of the immutable semantic asset body. */
export function projectSemanticAssetBodyV1(semantics: FourPartSemanticViewV1): SemanticAssetBodyV1 {
  assertFourPartSemanticViewV1(semantics);
  return {
    version: 1,
    semantics: {
      goal: semantics.goal,
      actions: semantics.actions,
      result: semantics.result,
      nextStep: semantics.nextStep,
    },
  };
}

/** Deterministic asset bytes. The body carries only version and the four fields. */
export function encodeSemanticAssetBodyV1(semantics: FourPartSemanticViewV1): Uint8Array {
  return new TextEncoder().encode(canonicalJsonStringify(projectSemanticAssetBodyV1(semantics)));
}

export async function semanticAssetDigestV1(semantics: FourPartSemanticViewV1): Promise<SemanticHistoryDigestV1> {
  return await sha256Digest(canonicalJsonStringify(projectSemanticAssetBodyV1(semantics)));
}

/** Stable asset id derived from the actual content digest. */
export function semanticAssetIdV1(digest: SemanticHistoryDigestV1): string {
  assertSha256DigestV1(digest, 'semantic asset digest');
  return `semantic-view-v1-${digest.slice('sha256:'.length)}`;
}

export function adoptedChildAdoptionCommitIdV1(parentTurnId: string, invocationId: string): string {
  assertNonEmptyString(parentTurnId, 'parentTurnId');
  assertNonEmptyString(invocationId, 'invocationId');
  return activeTurnCommitId(parentTurnId, `adopted:${invocationId}`);
}

export function adoptedChildDeliveryCommitIdV1(parentTurnId: string, invocationId: string): string {
  assertNonEmptyString(parentTurnId, 'parentTurnId');
  assertNonEmptyString(invocationId, 'invocationId');
  return activeTurnCommitId(parentTurnId, `delivery:${invocationId}`);
}

/** Explicit AdmittedTurn identity projection; never a whole-object spread. */
export function projectAdmittedTurnIdentityV1(turn: AdmittedTurn): AdmittedTurnIdentity {
  validateAdmittedTurn(turn);
  return {
    turnId: turn.turnId,
    workAssignmentRef: turn.workAssignmentRef,
    taskRef: { scope: turn.taskRef.scope, value: turn.taskRef.value },
    scopeRef: {
      organId: { scope: turn.scopeRef.organId.scope, value: turn.scopeRef.organId.value },
      ...(turn.scopeRef.taskId === undefined ? {} : { taskId: { scope: turn.scopeRef.taskId.scope, value: turn.scopeRef.taskId.value } }),
      ...(turn.scopeRef.cycleId === undefined ? {} : { cycleId: { scope: turn.scopeRef.cycleId.scope, value: turn.scopeRef.cycleId.value } }),
      ...(turn.scopeRef.operationId === undefined ? {} : { operationId: { scope: turn.scopeRef.operationId.scope, value: turn.scopeRef.operationId.value } }),
    },
    cycleRef: { scope: turn.cycleRef.scope, value: turn.cycleRef.value },
    inputRevision: turn.inputRevision,
    directiveRevision: turn.directiveRevision,
    executionEpoch: turn.executionEpoch,
    runtimeBindingRef: turn.runtimeBindingRef,
    permissionRevision: turn.permissionRevision,
  };
}

export async function semanticHistoryKeyV1(input: SemanticHistoryKeyInputV1): Promise<SemanticHistoryKeyV1> {
  assertAdmittedTurnIdentityV1(input.turn, 'key.turn');
  assertPlainObject(input.checkpoint, 'key.checkpoint');
  if (!Object.hasOwn(input.checkpoint, 'id') || !Object.hasOwn(input.checkpoint, 'scope')) {
    fail('semantic-history.input.invalid', 'key.checkpoint requires id and scope');
  }
  assertScopedId(input.checkpoint.id, 'checkpoint', 'key.checkpoint.id');
  assertScopeRefV1(input.checkpoint.scope, 'key.checkpoint.scope');
  const checkpointIdentity = await checkpointCommitIdentityV2({ checkpoint: input.checkpoint });
  return {
    version: 'semantic-history-key/v1',
    turn: input.turn,
    checkpointIdentity,
  };
}

export async function contextViewIdentityV1(input: SemanticHistoryKeyInputV1): Promise<SemanticContextViewIdentityV1> {
  const key = await semanticHistoryKeyV1(input);
  return `context-view:v1:${await sha256Hex(canonicalJsonStringify(semanticHistoryKeyTupleV1(key)))}`;
}

export async function historyPublicationIdentityV1(input: SemanticHistoryKeyInputV1): Promise<SemanticHistoryPublicationIdentityV1> {
  const key = await semanticHistoryKeyV1(input);
  return `history-publication:v1:${await sha256Hex(canonicalJsonStringify(semanticHistoryKeyTupleV1(key)))}`;
}

export async function contextViewIntentDigestV1(
  input: SemanticContextViewIntentInputV1,
): Promise<SemanticHistoryDigestV1> {
  assertAdmittedTurnIdentityV1(input.turn, 'viewIntent.turn');
  assertSemanticViewAcceptanceV1(input.acceptance, 'viewIntent.acceptance');
  assertSemanticAssetDescriptorV1(input.semanticAsset, 'viewIntent.semanticAsset');
  assertEvidenceRefsV1(input.evidenceRefs, 'viewIntent.evidenceRefs');
  assertSemanticHistoryRecoveryV1(input.recovery, 'viewIntent.recovery');
  if (!Array.isArray(input.adoptedChildren)) fail('semantic-history.input.invalid', 'viewIntent.adoptedChildren must be an array');
  for (const child of input.adoptedChildren) assertAdoptedChildSourceV1(child, 'viewIntent.adoptedChildren entry');
  await assertTurnCheckpointRelationshipV1(input.turn, input.checkpoint);
  const key = await semanticHistoryKeyV1({ turn: input.turn, checkpoint: input.checkpoint.checkpoint });
  const tuple = [
    'humanagent.semantic-context-view-intent.v1',
    semanticHistoryKeyTupleV1(key),
    acceptanceTuple(input.acceptance),
    assetDescriptorTuple(input.semanticAsset),
    checkpointBindingTuple(input.checkpoint),
    input.adoptedChildren.map(adoptedChildTuple),
    input.evidenceRefs.map(evidenceRefTuple),
    recoveryTuple(input.recovery),
  ];
  return await sha256Digest(canonicalJsonStringify(tuple));
}

export async function historyPublicationIntentDigestV1(
  input: SemanticHistoryPublicationIntentInputV1,
): Promise<SemanticHistoryDigestV1> {
  assertAdmittedTurnIdentityV1(input.turn, 'publicationIntent.turn');
  assertPlainObject(input.contextView, 'publicationIntent.contextView');
  assertExactKeys(input.contextView, ['identity', 'receipt'], [], 'publicationIntent.contextView');
  assertNonEmptyString(input.contextView.identity, 'publicationIntent.contextView.identity');
  assertSemanticPhaseReceiptV1(input.contextView.receipt, { phase: 'context-view' });
  if (input.contextView.receipt.commitIdentity !== input.contextView.identity) {
    fail('semantic-history.phase.identity-mismatch', 'publicationIntent contextView receipt identity does not match its identity');
  }
  await assertTurnCheckpointRelationshipV1(input.turn, input.checkpoint);
  const key = await semanticHistoryKeyV1({ turn: input.turn, checkpoint: input.checkpoint.checkpoint });
  const tuple = [
    'humanagent.semantic-history-publication-intent.v1',
    semanticHistoryKeyTupleV1(key),
    checkpointBindingTuple(input.checkpoint),
    contextViewReceiptTuple(input.contextView),
  ];
  return await sha256Digest(canonicalJsonStringify(tuple));
}

export async function buildSemanticContextViewBodyV1(
  input: SemanticContextViewBodyInputV1,
): Promise<SemanticContextViewBodyV1> {
  await validateAcceptedSemanticViewInputV1(input.accepted);
  assertSemanticAssetDescriptorV1(input.semanticAsset, 'viewBody.semanticAsset');
  assertCanonicalInstantV1(input.committedAt, 'viewBody.committedAt');
  assertTimeAuthorityV1(input.timeAuthority, 'viewBody.timeAuthority');
  const turn = projectAdmittedTurnIdentityV1(input.accepted.admittedTurn);
  const identity = await contextViewIdentityV1({ turn, checkpoint: input.accepted.checkpoint.checkpoint });
  const evidenceRefs = input.accepted.acceptance.sourceEvidenceRefs;
  const intentDigest = await contextViewIntentDigestV1({
    turn,
    checkpoint: input.accepted.checkpoint,
    acceptance: input.accepted.acceptance,
    semanticAsset: input.semanticAsset,
    adoptedChildren: input.accepted.adoptedChildren,
    evidenceRefs,
    recovery: input.accepted.recovery,
  });
  return {
    kind: 'native-semantic-context-view',
    version: 1,
    identity,
    intentDigest,
    committedAt: input.committedAt,
    timeAuthority: {
      source: input.timeAuthority.source,
      owner: input.timeAuthority.owner,
      authorityRef: input.timeAuthority.authorityRef,
    },
    turn,
    checkpoint: input.accepted.checkpoint,
    acceptance: {
      ownerId: input.accepted.acceptance.ownerId,
      acceptanceRef: input.accepted.acceptance.acceptanceRef,
      sourceEvidenceRefs: [...input.accepted.acceptance.sourceEvidenceRefs],
    },
    semanticAsset: { ...input.semanticAsset },
    adoptedChildren: [...input.accepted.adoptedChildren],
    evidenceRefs: [...evidenceRefs],
    recovery: {
      recoveryStateRef: input.accepted.recovery.recoveryStateRef,
      recoveryResponsibilityRef: input.accepted.recovery.recoveryResponsibilityRef,
      unresolvedOperationRefs: [...input.accepted.recovery.unresolvedOperationRefs],
      ...(input.accepted.recovery.firstErrorRef === undefined ? {} : { firstErrorRef: input.accepted.recovery.firstErrorRef }),
      laterErrorRefs: [...input.accepted.recovery.laterErrorRefs],
    },
  };
}

export async function buildSemanticHistoryPublicationBodyV1(
  input: SemanticHistoryPublicationBodyInputV1,
): Promise<SemanticHistoryPublicationBodyV1> {
  assertCanonicalInstantV1(input.committedAt, 'publicationBody.committedAt');
  assertTimeAuthorityV1(input.timeAuthority, 'publicationBody.timeAuthority');
  const identity = await historyPublicationIdentityV1({ turn: input.turn, checkpoint: input.checkpoint.checkpoint });
  const intentDigest = await historyPublicationIntentDigestV1({
    turn: input.turn,
    checkpoint: input.checkpoint,
    contextView: input.contextView,
  });
  return {
    kind: 'native-semantic-history-publication',
    version: 1,
    identity,
    intentDigest,
    committedAt: input.committedAt,
    timeAuthority: {
      source: input.timeAuthority.source,
      owner: input.timeAuthority.owner,
      authorityRef: input.timeAuthority.authorityRef,
    },
    turn: input.turn,
    checkpoint: input.checkpoint,
    contextView: {
      identity: input.contextView.identity,
      receipt: { ...input.contextView.receipt, timeAuthority: { ...input.contextView.receipt.timeAuthority } },
    },
  };
}

export async function assertTurnCheckpointRelationshipV1(
  turn: AdmittedTurnIdentity,
  relationship: CheckpointReceiptRelationshipV1,
): Promise<void> {
  assertAdmittedTurnIdentityV1(turn, 'turn');
  assertPlainObject(relationship, 'checkpoint relationship');
  assertExactKeys(
    relationship,
    ['checkpoint', 'envelope', 'receipt', 'checkpointSeq', 'journalSeq', 'recordDigest'],
    [],
    'checkpoint relationship',
  );
  try {
    await validateCheckpointReceiptRelationship(relationship);
  } catch (error) {
    fail('semantic-history.relationship.invalid', error instanceof Error ? error.message : 'checkpoint relationship is invalid');
  }
  const checkpoint = relationship.checkpoint;
  if (!sameScopeRef(turn.scopeRef, checkpoint.scope)) {
    fail('semantic-history.relationship.scope-mismatch', 'checkpoint scope does not match the admitted turn scope');
  }
  if (!checkpoint.scope.taskId || checkpoint.scope.taskId.value !== turn.taskRef.value) {
    fail('semantic-history.relationship.task-mismatch', 'checkpoint scope task does not match the admitted turn task');
  }
  if (!checkpoint.scope.cycleId
    || checkpoint.scope.cycleId.value !== turn.cycleRef.value
    || checkpoint.cycleId.value !== turn.cycleRef.value) {
    fail('semantic-history.relationship.cycle-mismatch', 'checkpoint cycle does not match the admitted turn cycle');
  }
  if (checkpoint.executionEpoch !== turn.executionEpoch) {
    fail('semantic-history.relationship.epoch-mismatch', 'checkpoint execution epoch does not match the admitted turn');
  }
  if (checkpoint.directiveRevision !== turn.directiveRevision) {
    fail('semantic-history.relationship.directive-mismatch', 'checkpoint directive revision does not match the admitted turn');
  }
  const recomputed = await checkpointCommitIdentityV2({ checkpoint });
  if (relationship.envelope.identity !== recomputed) {
    fail('semantic-history.relationship.identity-mismatch', 'checkpoint identity cannot be recomputed from its id and scope');
  }
}

export async function validateAcceptedSemanticViewInputV1(input: AcceptedSemanticViewInputV1): Promise<void> {
  assertPlainObject(input, 'accepted semantic view input');
  assertExactKeys(
    input,
    ['version', 'admittedTurn', 'checkpoint', 'acceptance', 'semantics', 'adoptedChildren', 'recovery'],
    [],
    'accepted semantic view input',
  );
  if (input.version !== 1) fail('semantic-history.input.version', 'accepted semantic view input version must be 1');
  try {
    validateAdmittedTurn(input.admittedTurn);
  } catch (error) {
    fail('semantic-history.input.invalid', error instanceof Error ? error.message : 'admitted turn is invalid');
  }
  const turn = projectAdmittedTurnIdentityV1(input.admittedTurn);
  await assertTurnCheckpointRelationshipV1(turn, input.checkpoint);
  assertSemanticViewAcceptanceV1(input.acceptance);
  assertFourPartSemanticViewV1(input.semantics);
  if (!Array.isArray(input.adoptedChildren)) fail('semantic-history.input.invalid', 'adoptedChildren must be an array');
  for (const child of input.adoptedChildren) {
    assertAdoptedChildSourceV1(child);
    if (!sameAdmittedTurnIdentity(child.parentTurn, turn)) {
      fail('semantic-history.adoption.parent-mismatch', 'adopted child parent turn does not match the accepted view turn');
    }
  }
  assertSemanticHistoryRecoveryV1(input.recovery);
  if (input.recovery.recoveryStateRef !== input.admittedTurn.recoveryStateRef) {
    fail('semantic-history.recovery.state-mismatch', 'recovery state reference does not match the admitted turn');
  }
}

export function validateSemanticHistoryExactLookupV1(input: SemanticHistoryExactLookupV1): void {
  assertPlainObject(input, 'semantic history exact lookup');
  assertExactKeys(input, ['scope', 'checkpoint', 'publicationReceiptRef'], [], 'semantic history exact lookup');
  assertScopeRefV1(input.scope, 'exact lookup scope');
  assertPlainObject(input.checkpoint, 'exact lookup checkpoint');
  assertExactKeys(input.checkpoint, ['id', 'scope'], [], 'exact lookup checkpoint');
  assertScopedId(input.checkpoint.id, 'checkpoint', 'exact lookup checkpoint.id');
  assertScopeRefV1(input.checkpoint.scope, 'exact lookup checkpoint.scope');
  if (!sameScopeRef(input.scope, input.checkpoint.scope)) {
    fail('semantic-history.lookup.scope-mismatch', 'exact lookup scope does not match the checkpoint scope');
  }
  if (typeof input.publicationReceiptRef !== 'string'
    || !/^humanagent:\/\/journal-record\/v1\/[0-9a-f]{64}\/\d+\/[0-9a-f]{64}$/.test(input.publicationReceiptRef)) {
    fail('semantic-history.lookup.receipt-invalid', 'publicationReceiptRef must be an actual Journal receipt reference');
  }
}

export async function validateSemanticPhaseReceiptV1(
  receipt: SemanticPhaseReceiptV1,
  expected: { readonly phase: SemanticPhase; readonly identity?: string; readonly scope: ScopeRef },
): Promise<void> {
  assertSemanticPhaseReceiptV1(receipt, expected);
  assertScopeRefV1(expected.scope, 'phase receipt scope');
  const scopeHash = await scopeDigest(expected.scope);
  const expectedRef = `humanagent://journal-record/v1/${scopeHash}/${receipt.journalSeq}/${receipt.recordDigest.slice('sha256:'.length)}`;
  if (receipt.journalReceiptRef !== expectedRef) {
    fail('semantic-history.phase.receipt-mismatch', 'phase receipt reference does not match scope, sequence, and digest');
  }
}

export async function validateSemanticContextViewBodyV1(value: unknown): Promise<void> {
  assertPlainObject(value, 'context view body');
  assertExactKeys(
    value,
    ['kind', 'version', 'identity', 'intentDigest', 'committedAt', 'timeAuthority', 'turn', 'checkpoint',
      'acceptance', 'semanticAsset', 'adoptedChildren', 'evidenceRefs', 'recovery'],
    [],
    'context view body',
  );
  if (value.kind !== 'native-semantic-context-view') fail('semantic-history.body.kind', 'context view body kind is invalid');
  if (value.version !== 1) fail('semantic-history.body.version', 'context view body version must be 1');
  assertAdmittedTurnIdentityV1(value.turn, 'context view body turn');
  assertSemanticViewAcceptanceV1(value.acceptance, 'context view body acceptance');
  assertSemanticAssetDescriptorV1(value.semanticAsset, 'context view body semanticAsset');
  assertEvidenceRefsV1(value.evidenceRefs, 'context view body evidenceRefs');
  assertSemanticHistoryRecoveryV1(value.recovery, 'context view body recovery');
  assertCanonicalInstantV1(value.committedAt, 'context view body committedAt');
  assertTimeAuthorityV1(value.timeAuthority, 'context view body timeAuthority');
  assertSha256DigestV1(value.intentDigest, 'context view body intentDigest');
  if (!Array.isArray(value.adoptedChildren)) fail('semantic-history.input.invalid', 'context view body adoptedChildren must be an array');
  for (const child of value.adoptedChildren) assertAdoptedChildSourceV1(child, 'context view body adoptedChildren entry');
  const turn = value.turn as AdmittedTurnIdentity;
  const relationship = value.checkpoint as CheckpointReceiptRelationshipV1;
  await assertTurnCheckpointRelationshipV1(turn, relationship);
  const identity = await contextViewIdentityV1({ turn, checkpoint: relationship.checkpoint });
  if (value.identity !== identity) fail('semantic-history.body.identity-mismatch', 'context view body identity does not match its turn and checkpoint');
  const intentDigest = await contextViewIntentDigestV1({
    turn,
    checkpoint: relationship,
    acceptance: value.acceptance as SemanticViewAcceptanceV1,
    semanticAsset: value.semanticAsset as SemanticAssetDescriptorV1,
    adoptedChildren: value.adoptedChildren as readonly AdoptedChildSourceV1[],
    evidenceRefs: value.evidenceRefs as readonly EvidenceRef[],
    recovery: value.recovery as SemanticHistoryRecoveryV1,
  });
  if (value.intentDigest !== intentDigest) fail('semantic-history.body.intent-mismatch', 'context view body intent digest does not match its facts');
}

export async function validateSemanticHistoryPublicationBodyV1(value: unknown): Promise<void> {
  assertPlainObject(value, 'history publication body');
  assertExactKeys(
    value,
    ['kind', 'version', 'identity', 'intentDigest', 'committedAt', 'timeAuthority', 'turn', 'checkpoint', 'contextView'],
    [],
    'history publication body',
  );
  if (value.kind !== 'native-semantic-history-publication') {
    fail('semantic-history.body.kind', 'history publication body kind is invalid');
  }
  if (value.version !== 1) fail('semantic-history.body.version', 'history publication body version must be 1');
  assertAdmittedTurnIdentityV1(value.turn, 'history publication body turn');
  assertCanonicalInstantV1(value.committedAt, 'history publication body committedAt');
  assertTimeAuthorityV1(value.timeAuthority, 'history publication body timeAuthority');
  assertSha256DigestV1(value.intentDigest, 'history publication body intentDigest');
  assertPlainObject(value.contextView, 'history publication body contextView');
  assertExactKeys(value.contextView, ['identity', 'receipt'], [], 'history publication body contextView');
  assertNonEmptyString(value.contextView.identity, 'history publication body contextView.identity');
  assertSemanticPhaseReceiptV1(value.contextView.receipt, { phase: 'context-view' });
  if (value.contextView.receipt.commitIdentity !== value.contextView.identity) {
    fail('semantic-history.phase.identity-mismatch', 'history publication body contextView receipt identity does not match its identity');
  }
  const turn = value.turn as AdmittedTurnIdentity;
  const relationship = value.checkpoint as CheckpointReceiptRelationshipV1;
  await assertTurnCheckpointRelationshipV1(turn, relationship);
  const identity = await historyPublicationIdentityV1({ turn, checkpoint: relationship.checkpoint });
  if (value.identity !== identity) fail('semantic-history.body.identity-mismatch', 'history publication body identity does not match its turn and checkpoint');
  const contextView = value.contextView as SemanticHistoryPublicationBodyV1['contextView'];
  const intentDigest = await historyPublicationIntentDigestV1({ turn, checkpoint: relationship, contextView });
  if (value.intentDigest !== intentDigest) fail('semantic-history.body.intent-mismatch', 'history publication body intent digest does not match its facts');
}

export async function projectCommittedSemanticCheckpointV1(
  input: CommittedSemanticCheckpointInputV1,
): Promise<CommittedSemanticCheckpointV1> {
  assertPlainObject(input, 'committed semantic checkpoint input');
  assertAdmittedTurnIdentityV1(input.turn, 'committed checkpoint turn');
  assertFourPartSemanticViewV1(input.semantics, 'committed checkpoint semantics');
  assertEvidenceRefsV1(input.evidenceRefs, 'committed checkpoint evidenceRefs');
  assertSemanticHistoryRecoveryV1(input.recovery, 'committed checkpoint recovery');
  if (!Array.isArray(input.adoptedChildren)) fail('semantic-history.input.invalid', 'committed checkpoint adoptedChildren must be an array');
  for (const child of input.adoptedChildren) assertAdoptedChildSourceV1(child, 'committed checkpoint adoptedChildren entry');
  await assertTurnCheckpointRelationshipV1(input.turn, input.checkpoint);
  const expectedViewIdentity = await contextViewIdentityV1({
    turn: input.turn,
    checkpoint: input.checkpoint.checkpoint,
  });
  const expectedPublicationIdentity = await historyPublicationIdentityV1({
    turn: input.turn,
    checkpoint: input.checkpoint.checkpoint,
  });
  await validateSemanticPhaseReceiptV1(input.contextView, {
    phase: 'context-view',
    identity: expectedViewIdentity,
    scope: input.checkpoint.checkpoint.scope,
  });
  await validateSemanticPhaseReceiptV1(input.historyPublication, {
    phase: 'history-publication',
    identity: expectedPublicationIdentity,
    scope: input.checkpoint.checkpoint.scope,
  });
  if (input.contextView.journalReceiptRef === input.historyPublication.journalReceiptRef
    || input.contextView.journalSeq === input.historyPublication.journalSeq) {
    fail('semantic-history.phase.shared-receipt', 'context-view and history-publication must be different durable records');
  }
  return {
    version: 1,
    turn: input.turn,
    scope: input.checkpoint.checkpoint.scope,
    nativeCommitIdentity: input.checkpoint.envelope.identity,
    time: input.checkpoint.envelope.committedAt,
    description: input.checkpoint.checkpoint.summary,
    semantics: {
      goal: input.semantics.goal,
      actions: input.semantics.actions,
      result: input.semantics.result,
      nextStep: input.semantics.nextStep,
    },
    save: {
      checkpoint: input.checkpoint,
      contextView: input.contextView,
      historyPublication: input.historyPublication,
    },
    evidenceRefs: [...input.evidenceRefs],
    adoptedChildren: [...input.adoptedChildren],
    recovery: {
      recoveryStateRef: input.recovery.recoveryStateRef,
      recoveryResponsibilityRef: input.recovery.recoveryResponsibilityRef,
      unresolvedOperationRefs: [...input.recovery.unresolvedOperationRefs],
      ...(input.recovery.firstErrorRef === undefined ? {} : { firstErrorRef: input.recovery.firstErrorRef }),
      laterErrorRefs: [...input.recovery.laterErrorRefs],
    },
  };
}
