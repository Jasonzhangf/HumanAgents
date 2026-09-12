import {
  assertBusinessPayload,
  assertSameScope,
  type BusinessPayload,
  type Checkpoint,
  type EvidenceRef,
  type LifecycleState,
  type NextAction,
  type OperationId,
  type OrganId,
  type ScopeKind,
  type ScopeRef,
  type ScopedId,
  type TaskId,
} from '../../../contracts/src/index.js';
import { CoreError, type SteerActorKind } from '../../../core/src/index.js';

export class ControlError extends CoreError {
  readonly cause?: unknown;
  readonly publicationFailure?: unknown;

  constructor(message: string, options?: { readonly cause?: unknown; readonly publicationFailure?: unknown }) {
    super(message);
    this.name = 'ControlError';
    this.cause = options?.cause;
    this.publicationFailure = options?.publicationFailure;
  }
}

export interface RequestStopCommand {
  readonly source: 'control';
  readonly command: 'steer.request-stop';
  readonly actorKind: Extract<SteerActorKind, 'human-operator' | 'harness-control'>;
  readonly hasStopPermission: boolean;
  readonly organId: OrganId;
  readonly taskId: TaskId;
  readonly executionEpoch: number;
  readonly currentState: LifecycleState;
  readonly runtimeId: string;
}

export interface SettleStopCommand {
  readonly source: 'control';
  readonly command: 'steer.settle-stop';
  readonly runtimeId: string;
  readonly executionEpoch: number;
  readonly operationId: OperationId;
  readonly scope: ScopeRef;
  readonly cycleId: { readonly scope: 'cycle'; readonly value: string };
  readonly ownerId: string;
  readonly previousCheckpoint: Checkpoint | null;
  readonly checkpointSeq: number;
  readonly directiveRevision: number;
  readonly stopReason: string;
}

export type ControlCommand = RequestStopCommand | SettleStopCommand;

const STOP_REQUEST_ACTOR_KINDS: readonly RequestStopCommand['actorKind'][] = ['human-operator', 'harness-control'];
const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'created',
  'admitted',
  'running',
  'settling',
  'succeeded',
  'waiting',
  'blocked',
  'failed',
  'cancelled',
  'stopped',
  'unknown',
  'stale',
];
const CHECKPOINT_OUTCOMES: readonly Checkpoint['outcome'][] = [
  'succeeded',
  'waiting',
  'blocked',
  'failed',
  'cancelled',
  'stopped',
  'unknown',
];
const NEXT_ACTION_KINDS: readonly NextAction['kind'][] = ['continue', 'wait', 'stop', 'recover'];
const EVIDENCE_KINDS: readonly EvidenceRef['kind'][] = ['execution', 'tool', 'operation', 'external'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ControlError(`invalid control command: ${message}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`);
  return value;
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const candidate = requireNonEmptyString(value, label);
  if (!allowed.includes(candidate as T)) fail(`${label} must be one of: ${allowed.join(', ')}`);
  return candidate as T;
}

function requireScopedId<K extends ScopeKind>(value: unknown, scope: K, label: string): ScopedId<K> {
  const record = requireRecord(value, label);
  const scopeValue = requireNonEmptyString(record.scope, `${label}.scope`);
  const idValue = requireNonEmptyString(record.value, `${label}.value`);
  if (scopeValue !== scope) fail(`${label} must have ${scope} scope`);
  return { scope, value: idValue };
}

function requireLifecycleState(value: unknown, label: string): LifecycleState {
  const state = requireNonEmptyString(value, label);
  if (!LIFECYCLE_STATES.includes(state as LifecycleState)) fail(`${label} is not a lifecycle state`);
  return state as LifecycleState;
}

function requireScopeRef(value: unknown, label: string): ScopeRef {
  const record = requireRecord(value, label);
  return {
    organId: requireScopedId(record.organId, 'organ', `${label}.organId`),
    ...(record.taskId === undefined ? {} : { taskId: requireScopedId(record.taskId, 'task', `${label}.taskId`) }),
    ...(record.cycleId === undefined ? {} : { cycleId: requireScopedId(record.cycleId, 'cycle', `${label}.cycleId`) }),
    ...(record.operationId === undefined ? {} : { operationId: requireScopedId(record.operationId, 'operation', `${label}.operationId`) }),
  };
}

function requireEvidenceRef(value: unknown, label: string): EvidenceRef {
  const record = requireRecord(value, label);
  return {
    evidenceId: requireScopedId(record.evidenceId, 'evidence', `${label}.evidenceId`),
    kind: requireMember(record.kind, EVIDENCE_KINDS, `${label}.kind`),
    source: requireNonEmptyString(record.source, `${label}.source`),
    locator: requireNonEmptyString(record.locator, `${label}.locator`),
    ...(record.digest === undefined ? {} : { digest: requireNonEmptyString(record.digest, `${label}.digest`) }),
    scope: requireScopeRef(record.scope, `${label}.scope`),
  };
}

function requireEvidenceRefs(value: unknown, label: string): readonly EvidenceRef[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => requireEvidenceRef(entry, `${label}[${index}]`));
}

function requireNextAction(value: unknown, label: string): NextAction {
  const record = requireRecord(value, label);
  const kind = requireMember(record.kind, NEXT_ACTION_KINDS, `${label}.kind`);
  const ref = record.ref === undefined ? undefined : requireNonEmptyString(record.ref, `${label}.ref`);
  return ref === undefined ? { kind } : { kind, ref };
}

function requireCheckpoint(value: unknown, label: string): Checkpoint {
  const record = requireRecord(value, label);
  const outcome = requireLifecycleState(record.outcome, `${label}.outcome`);
  if (!CHECKPOINT_OUTCOMES.includes(outcome as Checkpoint['outcome'])) fail(`${label}.outcome is not a committed checkpoint state`);
  return {
    id: requireScopedId(record.id, 'checkpoint', `${label}.id`),
    scope: requireScopeRef(record.scope, `${label}.scope`),
    cycleId: requireScopedId(record.cycleId, 'cycle', `${label}.cycleId`),
    seq: requirePositiveInteger(record.seq, `${label}.seq`),
    previousCheckpointId: record.previousCheckpointId === null
      ? null
      : requireScopedId(record.previousCheckpointId, 'checkpoint', `${label}.previousCheckpointId`),
    directiveRevision: requirePositiveInteger(record.directiveRevision, `${label}.directiveRevision`),
    executionEpoch: requirePositiveInteger(record.executionEpoch, `${label}.executionEpoch`),
    outcome: outcome as Checkpoint['outcome'],
    summary: requireNonEmptyString(record.summary, `${label}.summary`),
    recoveryStateRef: requireEvidenceRef(record.recoveryStateRef, `${label}.recoveryStateRef`),
    evidenceRefs: requireEvidenceRefs(record.evidenceRefs, `${label}.evidenceRefs`),
    next: requireNextAction(record.next, `${label}.next`),
  };
}

function requireNullableCheckpoint(value: unknown, label: string): Checkpoint | null {
  if (value === null) return null;
  return requireCheckpoint(value, label);
}

function assertRequestStopCommand(record: Record<string, unknown>): void {
  requireMember(record.actorKind, STOP_REQUEST_ACTOR_KINDS, 'request-stop actorKind');
  if (record.hasStopPermission !== true) fail('request-stop hasStopPermission must be true');
  requireScopedId(record.organId, 'organ', 'request-stop organId');
  requireScopedId(record.taskId, 'task', 'request-stop taskId');
  requirePositiveInteger(record.executionEpoch, 'request-stop executionEpoch');
  requireLifecycleState(record.currentState, 'request-stop currentState');
  requireNonEmptyString(record.runtimeId, 'request-stop runtimeId');
}

function assertSettleStopCommand(record: Record<string, unknown>): void {
  requireNonEmptyString(record.runtimeId, 'settle-stop runtimeId');
  requirePositiveInteger(record.executionEpoch, 'settle-stop executionEpoch');
  const operationId = requireScopedId(record.operationId, 'operation', 'settle-stop operationId');
  const scope = requireScopeRef(record.scope, 'settle-stop scope');
  const cycleId = requireScopedId(record.cycleId, 'cycle', 'settle-stop cycleId');
  requireNonEmptyString(record.ownerId, 'settle-stop ownerId');
  const checkpointSeq = requirePositiveInteger(record.checkpointSeq, 'settle-stop checkpointSeq');
  requirePositiveInteger(record.directiveRevision, 'settle-stop directiveRevision');
  const previousCheckpoint = requireNullableCheckpoint(record.previousCheckpoint, 'settle-stop previousCheckpoint');
  requireNonEmptyString(record.stopReason, 'settle-stop stopReason');

  if (!scope.taskId) fail('settle-stop scope task id is required');
  if (!scope.cycleId) fail('settle-stop scope cycle id is required');
  if (!scope.operationId) fail('settle-stop scope operation id is required');
  if (scope.operationId.value !== operationId.value) fail('settle-stop scope operation id does not match command operation id');
  if (scope.cycleId.value !== cycleId.value) fail('settle-stop scope cycle id does not match command cycle id');

  if (previousCheckpoint === null) {
    if (checkpointSeq !== 1) fail('settle-stop root checkpoint must start at sequence 1');
  } else {
    if (previousCheckpoint.seq !== checkpointSeq - 1) fail('settle-stop checkpoint sequence must follow previous checkpoint');
    if (previousCheckpoint.cycleId.value !== cycleId.value) fail('settle-stop previous checkpoint cycle id does not match command cycle id');
    try {
      assertSameScope(scope, previousCheckpoint.scope);
    } catch {
      fail('settle-stop previous checkpoint scope does not match command scope');
    }
  }
}

export function assertControlCommand(value: unknown): asserts value is ControlCommand {
  if (!isRecord(value) || value.source !== 'control' || typeof value.command !== 'string') {
    throw new ControlError('control command must use the control channel');
  }
  if (value.command === 'steer.request-stop') {
    assertRequestStopCommand(value);
    return;
  }
  if (value.command === 'steer.settle-stop') {
    assertSettleStopCommand(value);
    return;
  }
  throw new ControlError(`unknown control command: ${String(value.command)}`);
}

export function assertNoRequirementEnvelopePayload(value: unknown): void {
  if (!isRecord(value)) return;
  const requirementFields = ['requirementId', 'draftId', 'normalizedInput', 'fifoSeq', 'payloadRef'] as const;
  for (const field of requirementFields) {
    if (field in value) throw new ControlError(`requirement field leaked into control command: ${field}`);
  }
}

export function assertBusinessPayloadWithoutControlTruth(payload: BusinessPayload): void {
  try {
    assertBusinessPayload(payload);
  } catch (error) {
    throw new ControlError(`unexpected business payload error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
