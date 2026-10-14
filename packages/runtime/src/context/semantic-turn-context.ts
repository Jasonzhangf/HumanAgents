import {
  assertEvidenceRef,
  assertSameScope,
  validateWorkAssignment,
  type CheckpointId,
  type EvidenceRef,
  type RawAsset,
  type ScopeRef,
  type SemanticClaim,
  type TaskId,
  type WorkAssignment,
} from '../../../contracts/src/index.js';
import { buildContext } from './index.js';

/**
 * Pure semantic turn context builder.
 *
 * It projects a runtime identity prefix, the committed semantic history of
 * completed prior business turns, and the ordered current-turn entries into a
 * stable message sequence. Every field is projected explicitly: it never
 * spreads a whole checkpoint, so a checkpoint's recovery/control/raw fields
 * cannot leak, and it never shares active-turn storage, so two contexts cannot
 * mutate each other's entries.
 */
export class SemanticTurnContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticTurnContextError';
  }
}

export interface SemanticTurnPrefix {
  readonly kind: 'semantic-turn-prefix';
  readonly identity: {
    readonly runtimeId: string;
    readonly taskId: TaskId;
    readonly assignmentId: string;
    readonly pipelineNodeId: string;
    readonly attempt: number;
    readonly executionEpoch: number;
    readonly inputRevision: number;
    readonly scope: ScopeRef;
  };
  readonly rules: readonly string[];
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly failureCriteria: readonly string[];
  readonly incompleteCriteria: readonly string[];
}

/**
 * The exact fields a committed semantic checkpoint contributes to cross-turn
 * history. It is derived from a committed checkpoint by field, never by a
 * whole-object spread.
 */
export interface CommittedSemanticCheckpointProjection {
  readonly checkpointId: CheckpointId;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly description: string;
  readonly committedAt: string;
  readonly goal: string;
  readonly did: string;
  readonly result: string;
  readonly next: string;
  readonly claims: readonly SemanticClaim[];
  readonly constraints: readonly SemanticClaim[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface SemanticCheckpointHistoryEntry {
  readonly kind: 'semantic-checkpoint';
  readonly checkpointId: CheckpointId;
  readonly executionEpoch: number;
  readonly description: string;
  readonly committedAt: string;
  readonly goal: string;
  readonly did: string;
  readonly result: string;
  readonly next: string;
  readonly claims: readonly SemanticClaim[];
  readonly constraints: readonly SemanticClaim[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * A refined child delivery that an adoption owner actually accepted into the
 * parent active turn. It carries the real refined asset bytes and the child
 * identity, never the child raw transcript.
 */
export interface RefinedChildSemanticDelivery {
  readonly childTurnId: string;
  readonly scope: ScopeRef;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly content: RawAsset;
  readonly bytes: Uint8Array;
}

export interface RefinedChildContext {
  readonly kind: 'refined-child';
  readonly childTurnId: string;
  readonly scope: ScopeRef;
  readonly assignmentId: string;
  readonly executionEpoch: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly content: RawAsset;
  readonly bytes: Uint8Array;
}

export type SemanticTurnInputEntry<T> =
  | { readonly kind: 'message'; readonly message: T }
  | { readonly kind: 'refined-child'; readonly delivery: RefinedChildSemanticDelivery };

export type SemanticTurnContextEntry<T> =
  | { readonly kind: 'message'; readonly message: T }
  | RefinedChildContext;

export type SemanticTurnContextMessage<T> =
  | SemanticTurnPrefix
  | { readonly kind: 'semantic-checkpoint'; readonly checkpoint: SemanticCheckpointHistoryEntry }
  | SemanticTurnContextEntry<T>;

export interface SemanticTurnContextInput<T> {
  readonly runtimeId: string;
  readonly scope: ScopeRef;
  readonly assignment: WorkAssignment;
  readonly rules?: readonly string[];
  readonly semanticCheckpoints: readonly CommittedSemanticCheckpointProjection[];
  readonly activeTurn: readonly SemanticTurnInputEntry<T>[];
}

export interface SemanticTurnContext<T> {
  readonly prefix: SemanticTurnPrefix;
  readonly semanticHistory: readonly SemanticCheckpointHistoryEntry[];
  readonly activeTurn: readonly SemanticTurnContextEntry<T>[];
  readonly messages: readonly SemanticTurnContextMessage<T>[];
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new SemanticTurnContextError(`${label} is required`);
  return value;
}

function positiveEpoch(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SemanticTurnContextError(`${label} must be a positive safe integer`);
  }
  return value;
}

function copyScope(scope: ScopeRef): ScopeRef {
  return {
    organId: { scope: scope.organId.scope, value: scope.organId.value },
    ...(scope.taskId === undefined ? {} : {
      taskId: { scope: scope.taskId.scope, value: scope.taskId.value },
    }),
    ...(scope.cycleId === undefined ? {} : {
      cycleId: { scope: scope.cycleId.scope, value: scope.cycleId.value },
    }),
    ...(scope.operationId === undefined ? {} : {
      operationId: { scope: scope.operationId.scope, value: scope.operationId.value },
    }),
  };
}

function copyClaim(claim: SemanticClaim): SemanticClaim {
  return {
    fact: required(claim.fact, 'semantic claim fact'),
    certainty: claim.certainty,
    sourceRefs: [...claim.sourceRefs],
  };
}

function copyClaims(claims: readonly SemanticClaim[]): readonly SemanticClaim[] {
  return claims.map(copyClaim);
}

function copyEvidenceRef(ref: EvidenceRef): EvidenceRef {
  assertEvidenceRef(ref);
  return {
    evidenceId: { scope: ref.evidenceId.scope, value: ref.evidenceId.value },
    kind: ref.kind,
    source: ref.source,
    locator: ref.locator,
    ...(ref.digest === undefined ? {} : { digest: ref.digest }),
    scope: copyScope(ref.scope),
  };
}

function copyEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return refs.map(copyEvidenceRef);
}

function copyRawAsset(asset: RawAsset): RawAsset {
  return { ref: copyEvidenceRef(asset.ref), view: { ...asset.view } };
}

function assertCompatibleScope(expected: ScopeRef, actual: ScopeRef, label: string): void {
  if (expected.organId.value !== actual.organId.value) {
    throw new SemanticTurnContextError(`${label} organ scope does not match`);
  }
  if (actual.taskId !== undefined && expected.taskId?.value !== actual.taskId.value) {
    throw new SemanticTurnContextError(`${label} task scope does not match`);
  }
  if (actual.cycleId !== undefined && expected.cycleId?.value !== actual.cycleId.value) {
    throw new SemanticTurnContextError(`${label} cycle scope does not match`);
  }
  if (actual.operationId !== undefined && expected.operationId?.value !== actual.operationId.value) {
    throw new SemanticTurnContextError(`${label} operation scope does not match`);
  }
}

function assertTaskCompatibleScope(expected: ScopeRef, actual: ScopeRef, label: string): void {
  if (expected.organId.value !== actual.organId.value) {
    throw new SemanticTurnContextError(`${label} organ scope does not match`);
  }
  if (expected.taskId?.value !== actual.taskId?.value) {
    throw new SemanticTurnContextError(`${label} task scope does not match`);
  }
}

function projectCheckpoint(
  checkpoint: CommittedSemanticCheckpointProjection,
): SemanticCheckpointHistoryEntry {
  positiveEpoch(checkpoint.executionEpoch, 'semantic checkpoint execution epoch');
  return {
    kind: 'semantic-checkpoint',
    checkpointId: {
      scope: checkpoint.checkpointId.scope,
      value: required(checkpoint.checkpointId.value, 'semantic checkpoint id'),
    },
    executionEpoch: checkpoint.executionEpoch,
    description: required(checkpoint.description, 'semantic checkpoint description'),
    committedAt: required(checkpoint.committedAt, 'semantic checkpoint committedAt'),
    goal: required(checkpoint.goal, 'semantic checkpoint goal'),
    did: required(checkpoint.did, 'semantic checkpoint did'),
    result: required(checkpoint.result, 'semantic checkpoint result'),
    next: required(checkpoint.next, 'semantic checkpoint next'),
    claims: copyClaims(checkpoint.claims),
    constraints: copyClaims(checkpoint.constraints),
    evidenceRefs: copyEvidenceRefs(checkpoint.evidenceRefs),
  };
}

function projectChild(delivery: RefinedChildSemanticDelivery): RefinedChildContext {
  positiveEpoch(delivery.executionEpoch, 'refined child execution epoch');
  return {
    kind: 'refined-child',
    childTurnId: required(delivery.childTurnId, 'refined child turn id'),
    scope: copyScope(delivery.scope),
    assignmentId: required(delivery.assignmentId, 'refined child assignment id'),
    executionEpoch: delivery.executionEpoch,
    evidenceRefs: copyEvidenceRefs(delivery.evidenceRefs),
    content: copyRawAsset(delivery.content),
    bytes: new Uint8Array(delivery.bytes),
  };
}

function buildPrefix<T>(input: SemanticTurnContextInput<T>): SemanticTurnPrefix {
  return {
    kind: 'semantic-turn-prefix',
    identity: {
      runtimeId: required(input.runtimeId, 'runtime id'),
      taskId: { scope: input.assignment.taskId.scope, value: input.assignment.taskId.value },
      assignmentId: required(input.assignment.assignmentId, 'assignment id'),
      pipelineNodeId: required(input.assignment.pipelineNodeId, 'pipeline node id'),
      attempt: input.assignment.attempt,
      executionEpoch: input.assignment.executionEpoch,
      inputRevision: input.assignment.inputRevision,
      scope: copyScope(input.scope),
    },
    rules: [...(input.rules ?? [])],
    objective: required(input.assignment.objective, 'assignment objective'),
    successCriteria: [...input.assignment.successCriteria],
    failureCriteria: [...input.assignment.failureCriteria],
    incompleteCriteria: [...input.assignment.incompleteCriteria],
  };
}

function assertInput<T>(input: SemanticTurnContextInput<T>): void {
  validateWorkAssignment(input.assignment);
  required(input.runtimeId, 'runtime id');
  if (input.scope.taskId?.value !== input.assignment.taskId.value) {
    throw new SemanticTurnContextError('runtime scope task does not match assignment task');
  }
  for (const checkpoint of input.semanticCheckpoints) {
    assertSameScope(input.scope, checkpoint.scope);
    for (const ref of checkpoint.evidenceRefs) {
      assertCompatibleScope(input.scope, ref.scope, 'checkpoint evidence');
    }
  }
  for (const entry of input.activeTurn) {
    if (entry.kind !== 'refined-child') continue;
    assertTaskCompatibleScope(input.scope, entry.delivery.scope, 'refined child');
    for (const ref of entry.delivery.evidenceRefs) {
      assertCompatibleScope(entry.delivery.scope, ref.scope, 'refined child evidence');
    }
  }
}

export function buildSemanticTurnContext<T>(
  input: SemanticTurnContextInput<T>,
): SemanticTurnContext<T> {
  assertInput(input);
  const prefix = buildPrefix(input);
  const semanticHistory = input.semanticCheckpoints.map(projectCheckpoint);
  const activeTurn: readonly SemanticTurnContextEntry<T>[] = input.activeTurn.map((entry) => (
    entry.kind === 'message'
      ? { kind: 'message', message: entry.message }
      : projectChild(entry.delivery)
  ));
  const messages = buildContext<SemanticTurnContextMessage<T>>({
    stablePrefix: [prefix],
    indexRefs: semanticHistory.map((checkpoint) => ({ kind: 'semantic-checkpoint', checkpoint })),
    dynamicHead: activeTurn,
    repairRefs: [],
  }).messages;
  return { prefix, semanticHistory, activeTurn, messages };
}
