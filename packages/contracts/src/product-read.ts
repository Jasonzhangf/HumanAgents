import { ContractError } from './errors.js';
import {
  assertEvidenceRef,
  assertScope,
  type Attention,
  type EvidenceRef,
  type JournalCommitRef,
  type ScopeRef,
  type TaskId,
  type TaskInputRequest,
} from './index.js';
import {
  sameTaskExecutionInstanceIdentity,
  validateTaskExecutionInstanceIdentity,
  type TaskExecutionInstanceIdentity,
} from './agent-activity.js';
import {
  validateCheckpointControlGrant,
  type CheckpointControlGrant,
} from './checkpoint-controls.js';
import { validateJournalCommitRef } from './i2-history.js';
import {
  validateSemanticEventRef,
  type PublicOutputPublication,
  type SemanticEventRef,
} from './semantic-observation.js';

/**
 * Minimal product-read contracts for the five-board UI.
 *
 * These types carry only facts that a declared owner already produced. They do
 * not build a second runtime, do not store authorization in navigation state,
 * and do not turn role names, titles, timestamps or page transport state into
 * identity. The read scope is shared with the UI: packages/ui/contracts/runtime.ts
 * keeps `RuntimeReadScope` as an alias of `ProductReadScope`.
 */

export type ProductReadMode = 'fake' | 'rcc' | 'dsh';

/**
 * Exact read scope. A task scope pairs the project and runtime mode with the
 * task ID. A board or location never uses this value as permission evidence.
 */
export type ProductReadScope =
  | { readonly kind: 'system' }
  | { readonly kind: 'project'; readonly projectKey: string }
  | {
      readonly kind: 'task';
      readonly projectKey: string;
      readonly mode: ProductReadMode;
      readonly taskId: TaskId;
    };

export type ProductBoardKind = 'interaction' | 'orchestration' | 'inspection' | 'execution' | 'memory';

const PRODUCT_BOARD_KINDS: ReadonlySet<string> = new Set<ProductBoardKind>([
  'interaction',
  'orchestration',
  'inspection',
  'execution',
  'memory',
]);

const PRODUCT_READ_MODES: ReadonlySet<string> = new Set<ProductReadMode>(['fake', 'rcc', 'dsh']);

/**
 * Exact product target. The three kinds stay separate: a task, a session source
 * and an execution instance never collapse into one string identity. A session
 * reference keeps the owner vocabulary in `sourceKind`; this contract does not
 * invent a unified session ID.
 */
export type ProductTargetRef =
  | {
      readonly kind: 'interaction';
      readonly taskRef: TaskId;
      readonly scope: Extract<ProductReadScope, { readonly kind: 'task' }>;
    }
  | {
      readonly kind: 'session';
      readonly sessionRef: {
        readonly sourceKind: string;
        readonly sourceRef: string;
      };
      readonly taskRef?: TaskId;
      readonly scope: ProductReadScope;
    }
  | {
      readonly kind: 'execution-instance';
      readonly instance: TaskExecutionInstanceIdentity;
      readonly taskRef: TaskId;
      readonly scope: Extract<ProductReadScope, { readonly kind: 'task' }>;
    };

/**
 * One board entry. `lane` is authoritative display classification; `updatedAt`
 * is intentionally absent because a timestamp never proves Live.
 */
export interface ProductBoardItemCommon<TResult> {
  readonly ref: ProductTargetRef;
  readonly title: string;
  readonly displayState: string;
  readonly liveness?: {
    readonly state: string;
    readonly reason: string;
    readonly observedAt: string;
    readonly lastActivityAt?: string;
    readonly lastActivitySource?: string;
    readonly silentForMs?: number;
    readonly silenceBudgetMs?: number;
  };
  readonly publicResult?: TResult;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type ProductBoardItem<TResult = PublicOutputPublication> =
  | (ProductBoardItemCommon<TResult> & { readonly lane: 'live' })
  | (ProductBoardItemCommon<TResult> & { readonly lane: 'history' })
  | (ProductBoardItemCommon<TResult> & { readonly lane: 'unknown'; readonly unknownReason: string });

export interface ProductBoardSection<TResult = PublicOutputPublication> {
  readonly board: ProductBoardKind;
  readonly live: readonly Extract<ProductBoardItem<TResult>, { readonly lane: 'live' }>[];
  readonly history: readonly Extract<ProductBoardItem<TResult>, { readonly lane: 'history' }>[];
  readonly unknown: readonly Extract<ProductBoardItem<TResult>, { readonly lane: 'unknown' }>[];
  readonly failures?: readonly {
    readonly code: string;
    readonly ownerId: string;
    readonly message: string;
    readonly nextAction: string;
  }[];
}

export interface ProductBoardIndex<TResult = PublicOutputPublication> {
  readonly scope: ProductReadScope;
  readonly observedAt: string;
  readonly boards: readonly ProductBoardSection<TResult>[];
}

export type ProductMessageActor =
  | { readonly kind: 'human'; readonly sourceKind: string; readonly sourceRef: string }
  | { readonly kind: 'agent'; readonly sourceKind: string; readonly sourceRef?: string }
  | { readonly kind: 'system'; readonly sourceKind: string; readonly sourceRef?: string }
  | { readonly kind: 'unknown'; readonly sourceKind: string; readonly sourceRef?: string };

export interface ProductMessage {
  readonly ref: SemanticEventRef;
  readonly targetRef: ProductTargetRef;
  readonly actor: ProductMessageActor;
  readonly occurredAt?: string;
  readonly occurredAtUnavailableReason?: string;
  readonly text: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type ProductRelationKind =
  | 'requirement'
  | 'subscription'
  | 'occurrence'
  | 'child-execution'
  | 'checkpoint'
  | 'review'
  | 'planner'
  | 'tool-pair'
  | 'unknown';

const PRODUCT_RELATION_KINDS: ReadonlySet<string> = new Set<ProductRelationKind>([
  'requirement',
  'subscription',
  'occurrence',
  'child-execution',
  'checkpoint',
  'review',
  'planner',
  'tool-pair',
  'unknown',
]);

export interface ProductRelation {
  readonly source: ProductTargetRef;
  readonly target: ProductTargetRef;
  readonly kind: ProductRelationKind;
  readonly sourceOwner: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * Read position only. It carries no principal, grant, decision or control
 * target. Refresh and Back/Forward restore this position and re-read.
 */
export interface ProductLocation {
  readonly board: ProductBoardKind;
  readonly lane: 'live' | 'history';
  readonly focus?: ProductTargetRef;
  readonly scope: ProductReadScope;
}

export type ProductPendingDecisionAction = 'grant' | 'revoke';

const PRODUCT_PENDING_DECISION_ACTIONS: ReadonlySet<string> = new Set<ProductPendingDecisionAction>([
  'grant',
  'revoke',
]);

/**
 * Only the task-grant branch has a formal, verified continue chain. The other
 * two branches preserve the real O2 state: their facts may exist, but no public
 * disposal route exists. They therefore carry no action and an explicit reason.
 */
export type ProductPendingDecision =
  | {
      readonly kind: 'task-grant';
      readonly target: Extract<ProductTargetRef, { readonly kind: 'interaction' }>;
      readonly question: string;
      readonly actions: readonly ProductPendingDecisionAction[];
      readonly state: 'waiting' | 'resolved' | 'revoked' | 'unknown';
      readonly revision?: number;
      readonly readback: {
        readonly grant: CheckpointControlGrant | null;
        readonly commit: JournalCommitRef | null;
      };
      readonly recoveryOwner: string;
    }
  | {
      readonly kind: 'task-input-request';
      readonly target: Extract<ProductTargetRef, { readonly kind: 'interaction' }>;
      readonly request: TaskInputRequest;
      readonly question: string;
      readonly actions: readonly [];
      readonly state: 'unavailable';
      readonly unavailableReason: string;
      readonly recoveryOwner: string;
    }
  | {
      readonly kind: 'attention-decision';
      readonly target: ProductTargetRef;
      readonly attention: Attention;
      readonly question: string;
      readonly actions: readonly [];
      readonly state: 'unavailable';
      readonly unavailableReason: string;
      readonly recoveryOwner: string;
    };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): asserts value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError(`${label} must be an object`);
  }
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError(`${label} must be a non-empty string`);
  }
}

function optionalText(value: unknown, label: string): void {
  if (value !== undefined) text(value, label);
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ContractError(`${label} must be a non-negative safe integer`);
  }
}

function onlyKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new ContractError(`${label} does not accept ${key}`);
  }
}

function sameTaskId(left: TaskId | undefined, right: TaskId | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.value === right.value;
}

function sameReadScope(left: ProductReadScope, right: ProductReadScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'system') return true;
  if (left.kind === 'project') return right.kind === 'project' && left.projectKey === right.projectKey;
  return right.kind === 'task'
    && left.projectKey === right.projectKey
    && left.mode === right.mode
    && sameTaskId(left.taskId, right.taskId);
}

function validateScopeRef(value: ScopeRef, label: string): void {
  record(value, label);
  record(value.organId, `${label} organId`);
  assertScope(value.organId, 'organ');
  if (value.taskId !== undefined) assertScope(value.taskId, 'task');
  if (value.cycleId !== undefined) assertScope(value.cycleId, 'cycle');
  if (value.operationId !== undefined) assertScope(value.operationId, 'operation');
}

export function validateProductReadScope(scope: ProductReadScope): void {
  record(scope, 'product read scope');
  if (scope.kind === 'system') {
    onlyKeys(scope, ['kind'], 'product read scope');
    return;
  }
  if (scope.kind === 'project') {
    onlyKeys(scope, ['kind', 'projectKey'], 'product read scope');
    text(scope.projectKey, 'product read scope projectKey');
    return;
  }
  if (scope.kind === 'task') {
    onlyKeys(scope, ['kind', 'projectKey', 'mode', 'taskId'], 'product read scope');
    text(scope.projectKey, 'product read scope projectKey');
    if (!PRODUCT_READ_MODES.has(scope.mode)) {
      throw new ContractError('product read scope mode is invalid');
    }
    assertScope(scope.taskId, 'task');
    return;
  }
  throw new ContractError('product read scope kind is invalid');
}

export function validateProductTargetRef(ref: ProductTargetRef): void {
  record(ref, 'product target ref');
  if (ref.kind === 'interaction') {
    onlyKeys(ref, ['kind', 'taskRef', 'scope'], 'interaction target ref');
    assertScope(ref.taskRef, 'task');
    validateProductReadScope(ref.scope);
    if (ref.scope.kind !== 'task' || !sameTaskId(ref.scope.taskId, ref.taskRef)) {
      throw new ContractError('interaction target task does not match its read scope');
    }
    return;
  }
  if (ref.kind === 'session') {
    onlyKeys(ref, ['kind', 'sessionRef', 'taskRef', 'scope'], 'session target ref');
    record(ref.sessionRef, 'session target ref sessionRef');
    onlyKeys(ref.sessionRef, ['sourceKind', 'sourceRef'], 'session target ref sessionRef');
    text(ref.sessionRef.sourceKind, 'session target ref sourceKind');
    text(ref.sessionRef.sourceRef, 'session target ref sourceRef');
    validateProductReadScope(ref.scope);
    if (ref.scope.kind === 'task') {
      if (ref.taskRef === undefined || !sameTaskId(ref.scope.taskId, ref.taskRef)) {
        throw new ContractError('session target task does not match its read scope');
      }
    } else if (ref.taskRef !== undefined) {
      throw new ContractError('session target task requires a task read scope');
    }
    return;
  }
  if (ref.kind === 'execution-instance') {
    onlyKeys(ref, ['kind', 'instance', 'taskRef', 'scope'], 'execution target ref');
    assertScope(ref.taskRef, 'task');
    validateProductReadScope(ref.scope);
    if (ref.scope.kind !== 'task' || !sameTaskId(ref.scope.taskId, ref.taskRef)) {
      throw new ContractError('execution target task does not match its read scope');
    }
    validateTaskExecutionInstanceIdentity(ref.instance, ref.taskRef);
    return;
  }
  throw new ContractError('product target ref kind is invalid');
}

export function sameProductTargetRef(left: ProductTargetRef, right: ProductTargetRef): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'interaction') {
    return right.kind === 'interaction'
      && sameTaskId(left.taskRef, right.taskRef)
      && sameReadScope(left.scope, right.scope);
  }
  if (left.kind === 'session') {
    return right.kind === 'session'
      && left.sessionRef.sourceKind === right.sessionRef.sourceKind
      && left.sessionRef.sourceRef === right.sessionRef.sourceRef
      && sameTaskId(left.taskRef, right.taskRef)
      && sameReadScope(left.scope, right.scope);
  }
  return right.kind === 'execution-instance'
    && sameTaskId(left.taskRef, right.taskRef)
    && sameReadScope(left.scope, right.scope)
    && sameTaskExecutionInstanceIdentity(left.instance, right.instance);
}

function validateLiveness(
  value: NonNullable<ProductBoardItemCommon<unknown>['liveness']>,
): void {
  record(value, 'product board item liveness');
  onlyKeys(
    value,
    ['state', 'reason', 'observedAt', 'lastActivityAt', 'lastActivitySource', 'silentForMs', 'silenceBudgetMs'],
    'product board item liveness',
  );
  text(value.state, 'product board item liveness state');
  text(value.reason, 'product board item liveness reason');
  text(value.observedAt, 'product board item liveness observedAt');
  optionalText(value.lastActivityAt, 'product board item liveness lastActivityAt');
  optionalText(value.lastActivitySource, 'product board item liveness lastActivitySource');
  if (value.silentForMs !== undefined) nonNegativeInteger(value.silentForMs, 'product board item liveness silentForMs');
  if (value.silenceBudgetMs !== undefined) nonNegativeInteger(value.silenceBudgetMs, 'product board item liveness silenceBudgetMs');
}

function validateProductBoardItem(item: ProductBoardItem<unknown>, lane: 'live' | 'history' | 'unknown'): void {
  record(item, 'product board item');
  if (item.lane !== lane) {
    throw new ContractError(`product board item lane ${String(item.lane)} is not ${lane}`);
  }
  onlyKeys(
    item,
    lane === 'unknown'
      ? ['lane', 'unknownReason', 'ref', 'title', 'displayState', 'liveness', 'publicResult', 'evidenceRefs']
      : ['lane', 'ref', 'title', 'displayState', 'liveness', 'publicResult', 'evidenceRefs'],
    'product board item',
  );
  validateProductTargetRef(item.ref);
  text(item.title, 'product board item title');
  text(item.displayState, 'product board item displayState');
  if (item.liveness !== undefined) validateLiveness(item.liveness);
  if (item.publicResult !== undefined) record(item.publicResult, 'product board item publicResult');
  if (!Array.isArray(item.evidenceRefs)) throw new ContractError('product board item evidenceRefs must be an array');
  for (const ref of item.evidenceRefs) assertEvidenceRef(ref);
  if (lane === 'unknown') {
    if (item.lane !== 'unknown') throw new ContractError('product board unknown item must keep the unknown lane');
    text(item.unknownReason, 'product board unknown item reason');
  }
}

export function validateProductBoardSection(section: ProductBoardSection<unknown>): void {
  record(section, 'product board section');
  onlyKeys(section, ['board', 'live', 'history', 'unknown', 'failures'], 'product board section');
  if (!PRODUCT_BOARD_KINDS.has(section.board)) {
    throw new ContractError('product board section board is invalid');
  }
  const lanes = [
    ['live', section.live],
    ['history', section.history],
    ['unknown', section.unknown],
  ] as const;
  const seen: ProductTargetRef[] = [];
  for (const [lane, items] of lanes) {
    if (!Array.isArray(items)) throw new ContractError(`product board section ${lane} must be an array`);
    for (const item of items) {
      validateProductBoardItem(item, lane);
      if (seen.some((existing) => sameProductTargetRef(existing, item.ref))) {
        throw new ContractError('product board item appears in more than one lane');
      }
      seen.push(item.ref);
    }
  }
  if (section.failures !== undefined) {
    if (!Array.isArray(section.failures)) throw new ContractError('product board section failures must be an array');
    for (const failure of section.failures) {
      record(failure, 'product board section failure');
      onlyKeys(failure, ['code', 'ownerId', 'message', 'nextAction'], 'product board section failure');
      text(failure.code, 'product board section failure code');
      text(failure.ownerId, 'product board section failure ownerId');
      text(failure.message, 'product board section failure message');
      text(failure.nextAction, 'product board section failure nextAction');
    }
  }
}

export function validateProductBoardIndex(index: ProductBoardIndex<unknown>): void {
  record(index, 'product board index');
  onlyKeys(index, ['scope', 'observedAt', 'boards'], 'product board index');
  validateProductReadScope(index.scope);
  text(index.observedAt, 'product board index observedAt');
  if (!Array.isArray(index.boards)) throw new ContractError('product board index boards must be an array');
  const boards = new Set<string>();
  for (const section of index.boards) {
    validateProductBoardSection(section);
    if (boards.has(section.board)) throw new ContractError('product board index repeats a board kind');
    boards.add(section.board);
  }
}

const FORBIDDEN_ACTOR_SOURCES: ReadonlySet<string> = new Set(['task.input', 'task.updatedAt']);

export function validateProductMessageActor(actor: ProductMessageActor): void {
  record(actor, 'product message actor');
  onlyKeys(actor, ['kind', 'sourceKind', 'sourceRef'], 'product message actor');
  if (actor.kind !== 'human' && actor.kind !== 'agent' && actor.kind !== 'system' && actor.kind !== 'unknown') {
    throw new ContractError('product message actor kind is invalid');
  }
  text(actor.sourceKind, 'product message actor sourceKind');
  optionalText(actor.sourceRef, 'product message actor sourceRef');
  if (actor.sourceKind === 'unknown' && actor.kind !== 'unknown') {
    throw new ContractError('product message actor with an unknown source must keep kind unknown');
  }
  if (actor.kind !== 'unknown') {
    if (FORBIDDEN_ACTOR_SOURCES.has(actor.sourceKind)) {
      throw new ContractError('product message actor cannot derive identity from task input or task update time');
    }
    if (actor.kind === 'human' && actor.sourceRef === undefined) {
      throw new ContractError('product message human actor requires a decoded principal sourceRef');
    }
  }
}

export function validateProductMessage(message: ProductMessage): void {
  record(message, 'product message');
  onlyKeys(
    message,
    ['ref', 'targetRef', 'actor', 'occurredAt', 'occurredAtUnavailableReason', 'text', 'evidenceRefs'],
    'product message',
  );
  validateSemanticEventRef(message.ref);
  validateProductTargetRef(message.targetRef);
  validateProductMessageActor(message.actor);
  optionalText(message.occurredAt, 'product message occurredAt');
  optionalText(message.occurredAtUnavailableReason, 'product message occurredAtUnavailableReason');
  if (message.occurredAt === undefined && message.occurredAtUnavailableReason === undefined) {
    throw new ContractError('product message must carry an event time or an explicit unavailable reason');
  }
  if (message.occurredAt !== undefined && message.occurredAtUnavailableReason !== undefined) {
    throw new ContractError('product message must not carry both an event time and an unavailable reason');
  }
  text(message.text, 'product message text');
  if (!Array.isArray(message.evidenceRefs)) throw new ContractError('product message evidenceRefs must be an array');
  for (const ref of message.evidenceRefs) assertEvidenceRef(ref);
}

export function validateProductRelation(relation: ProductRelation): void {
  record(relation, 'product relation');
  onlyKeys(relation, ['source', 'target', 'kind', 'sourceOwner', 'evidenceRefs'], 'product relation');
  validateProductTargetRef(relation.source);
  validateProductTargetRef(relation.target);
  if (!PRODUCT_RELATION_KINDS.has(relation.kind)) {
    throw new ContractError('product relation kind is invalid');
  }
  text(relation.sourceOwner, 'product relation sourceOwner');
  if (!Array.isArray(relation.evidenceRefs) || relation.evidenceRefs.length === 0) {
    throw new ContractError('product relation requires owner evidence');
  }
  for (const ref of relation.evidenceRefs) assertEvidenceRef(ref);
}

function focusMatchesScope(focus: ProductTargetRef, scope: ProductReadScope): boolean {
  if (scope.kind === 'system') return true;
  if (scope.kind === 'project') {
    return (focus.scope.kind === 'project' || focus.scope.kind === 'task')
      && focus.scope.projectKey === scope.projectKey;
  }
  return focus.scope.kind === 'task' && sameTaskId(focus.scope.taskId, scope.taskId);
}

export function validateProductLocation(location: ProductLocation): void {
  record(location, 'product location');
  onlyKeys(location, ['board', 'lane', 'focus', 'scope'], 'product location');
  if (!PRODUCT_BOARD_KINDS.has(location.board)) {
    throw new ContractError('product location board is invalid');
  }
  if (location.lane !== 'live' && location.lane !== 'history') {
    throw new ContractError('product location lane is invalid');
  }
  validateProductReadScope(location.scope);
  if (location.focus !== undefined) {
    validateProductTargetRef(location.focus);
    if (!focusMatchesScope(location.focus, location.scope)) {
      throw new ContractError('product location focus is outside its read scope');
    }
  }
}

function targetTaskId(target: ProductTargetRef): TaskId | undefined {
  if (target.kind === 'session') return target.taskRef;
  return target.taskRef;
}

function validateTaskInputRequest(request: TaskInputRequest, target: ProductTargetRef): void {
  record(request, 'product pending decision request');
  onlyKeys(
    request,
    ['requestId', 'taskId', 'schemaRef', 'reason', 'impact', 'expiresAt'],
    'product pending decision request',
  );
  text(request.requestId, 'product pending decision requestId');
  assertScope(request.taskId, 'task');
  text(request.schemaRef, 'product pending decision schemaRef');
  text(request.reason, 'product pending decision reason');
  text(request.impact, 'product pending decision impact');
  optionalText(request.expiresAt, 'product pending decision expiresAt');
  const taskId = targetTaskId(target);
  if (taskId === undefined || !sameTaskId(taskId, request.taskId)) {
    throw new ContractError('product pending decision request task does not match its target');
  }
}

function validateAttention(attention: Attention, target: ProductTargetRef): void {
  record(attention, 'product pending decision attention');
  text(attention.attentionId, 'product pending decision attentionId');
  validateScopeRef(attention.scope, 'product pending decision attention scope');
  if (attention.severity !== 'info' && attention.severity !== 'attention' && attention.severity !== 'blocker') {
    throw new ContractError('product pending decision attention severity is invalid');
  }
  if (attention.state !== 'open' && attention.state !== 'recovering' && attention.state !== 'resolved') {
    throw new ContractError('product pending decision attention state is invalid');
  }
  text(attention.message, 'product pending decision attention message');
  if (!Array.isArray(attention.evidenceRefs)) {
    throw new ContractError('product pending decision attention evidenceRefs must be an array');
  }
  for (const ref of attention.evidenceRefs) assertEvidenceRef(ref);
  const taskId = targetTaskId(target);
  if (taskId !== undefined && attention.scope.taskId !== undefined && !sameTaskId(attention.scope.taskId, taskId)) {
    throw new ContractError('product pending decision attention task does not match its target');
  }
}

export function validateProductPendingDecision(decision: ProductPendingDecision): void {
  record(decision, 'product pending decision');
  text(decision.question, 'product pending decision question');
  text(decision.recoveryOwner, 'product pending decision recoveryOwner');
  if (decision.kind === 'task-grant') {
    onlyKeys(
      decision,
      ['kind', 'target', 'question', 'actions', 'state', 'revision', 'readback', 'recoveryOwner'],
      'task grant pending decision',
    );
    validateProductTargetRef(decision.target);
    if (decision.target.kind !== 'interaction') {
      throw new ContractError('task grant pending decision requires an interaction target');
    }
    if (!['waiting', 'resolved', 'revoked', 'unknown'].includes(decision.state)) {
      throw new ContractError('task grant pending decision state is invalid');
    }
    if (!Array.isArray(decision.actions) || decision.actions.length === 0) {
      throw new ContractError('task grant pending decision requires a formal action');
    }
    const actions = new Set<string>();
    for (const action of decision.actions) {
      if (!PRODUCT_PENDING_DECISION_ACTIONS.has(action)) {
        throw new ContractError('task grant pending decision action is invalid');
      }
      if (actions.has(action)) throw new ContractError('task grant pending decision repeats an action');
      actions.add(action);
    }
    record(decision.readback, 'task grant pending decision readback');
    onlyKeys(decision.readback, ['grant', 'commit'], 'task grant pending decision readback');
    if (decision.readback.grant === null) {
      if (decision.readback.commit !== null) {
        throw new ContractError('task grant pending decision cannot carry a commit without a grant');
      }
      if (decision.revision !== undefined) {
        throw new ContractError('task grant pending decision cannot carry a revision without a grant');
      }
    } else {
      validateCheckpointControlGrant(decision.readback.grant);
      if (decision.readback.commit === null) {
        throw new ContractError('task grant pending decision is missing its exact commit');
      }
      validateJournalCommitRef(decision.readback.commit);
      if (decision.revision !== undefined) {
        nonNegativeInteger(decision.revision, 'task grant pending decision revision');
        if (decision.revision !== decision.readback.grant.revision) {
          throw new ContractError('task grant pending decision revision does not match its readback');
        }
      }
    }
    return;
  }
  if (decision.kind === 'task-input-request') {
    onlyKeys(
      decision,
      ['kind', 'target', 'request', 'question', 'actions', 'state', 'unavailableReason', 'recoveryOwner'],
      'task input request pending decision',
    );
    validateProductTargetRef(decision.target);
    if (decision.target.kind !== 'interaction') {
      throw new ContractError('task input request pending decision requires an interaction target');
    }
    if (decision.state !== 'unavailable' || decision.actions.length !== 0) {
      throw new ContractError('task input request pending decision cannot offer a formal action');
    }
    text(decision.unavailableReason, 'task input request pending decision unavailableReason');
    validateTaskInputRequest(decision.request, decision.target);
    return;
  }
  if (decision.kind === 'attention-decision') {
    onlyKeys(
      decision,
      ['kind', 'target', 'attention', 'question', 'actions', 'state', 'unavailableReason', 'recoveryOwner'],
      'attention pending decision',
    );
    validateProductTargetRef(decision.target);
    if (decision.state !== 'unavailable' || decision.actions.length !== 0) {
      throw new ContractError('attention pending decision cannot offer a formal action');
    }
    text(decision.unavailableReason, 'attention pending decision unavailableReason');
    validateAttention(decision.attention, decision.target);
    return;
  }
  throw new ContractError('product pending decision kind is invalid');
}
