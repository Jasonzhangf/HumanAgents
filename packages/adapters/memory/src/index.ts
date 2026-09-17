/// <reference path="./node-modules.d.ts" />
export * from './sources.js';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { kill, pid } from 'node:process';
import {
  ContractError,
  assertContextBudget,
  validateMemoryForgettingPlan,
  validateMemoryForgettingRequest,
  validateMemoryPromotionReceipt,
  validateMemoryQueryRequest,
  validateMemoryReviewReceipt,
  validateMemorySubmission,
  type AgentMemoryContext,
  type AgentMemoryContextInjectionPort,
  type AgentMemoryContextRequest,
  type ContextLayer,
  type MemoryForgettingPlan,
  type MemoryForgettingRequest,
  type MemoryKind,
  type MemoryOperationsPort,
  type MemoryPromotionReceipt,
  type MemoryQueryEntry,
  type MemoryQueryRequest,
  type MemoryQueryResponse,
  type MemoryRecordState,
  type MemoryReviewReceipt,
  type MemoryScope,
  type MemorySubmission,
  type MemorySubmissionReceipt,
  type TaskId,
  type NoveltyRequest,
  type NoveltyResult,
  type RecurrenceRequest,
  type RecurrenceResult,
} from '../../../contracts/src/index.js';

type RecordEntry = { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string; readonly layer?: ContextLayer; readonly summary?: string; };

interface SourceLock {
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly scope: MemoryScope;
}

interface CanonicalRecord {
  readonly memoryId: string;
  readonly namespace: 'project' | 'global';
  readonly projectKey?: string;
  readonly kind: MemoryKind;
  readonly state: MemoryRecordState;
  readonly summary: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly taskId?: TaskId;
  readonly sourceScopeRef: string;
  readonly relevanceReason: string;
}

interface CandidateRecord {
  readonly submission: MemorySubmission;
  readonly candidateId?: string;
  state: 'candidate' | 'approved' | 'rejected';
  review?: MemoryReviewReceipt;
  promotion?: MemoryPromotionReceipt;
}

export const MEMORY_PERSISTENCE_OWNER = 'memory-persistence-adapter';

export interface MemoryPersistenceSnapshot {
  readonly version: 1;
  readonly revision: number;
  readonly records: readonly RecordEntry[];
  readonly canonicalRecords: readonly CanonicalRecord[];
  readonly candidates: readonly CandidateRecord[];
  readonly candidateIds: readonly { readonly candidateId: string; readonly submissionId: string }[];
  readonly forgettingPlans: readonly MemoryForgettingPlan[];
  readonly sourceLocks: readonly SourceLock[];
  readonly attachedEpochs: readonly { readonly agentRuntimeId: string; readonly executionEpoch: number }[];
  readonly attachedContextIds: readonly { readonly agentRuntimeId: string; readonly contextId: string }[];
}

export interface MemoryPersistencePort {
  load(): Promise<MemoryPersistenceSnapshot | undefined>;
  save(snapshot: MemoryPersistenceSnapshot): Promise<void>;
}

export type MemoryPersistenceErrorCode =
  | 'memory-persistence-path-invalid'
  | 'memory-persistence-snapshot-invalid'
  | 'memory-persistence-conflict'
  | 'memory-persistence-io-failure';

export class MemoryPersistenceError extends ContractError {
  constructor(
    readonly code: MemoryPersistenceErrorCode,
    message: string,
    readonly nextAction: { readonly kind: 'recover'; readonly ref: string },
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MemoryPersistenceError';
  }
}

function persistenceError(
  code: MemoryPersistenceErrorCode,
  message: string,
  ref: string,
  cause?: unknown,
): MemoryPersistenceError {
  return new MemoryPersistenceError(code, message, { kind: 'recover', ref }, cause);
}

function invalidSnapshot(message: string, cause?: unknown): never {
  throw persistenceError('memory-persistence-snapshot-invalid', `memory persistence snapshot is invalid: ${message}`, 'memory-persistence-snapshot', cause);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) invalidSnapshot(`${label} must be an object`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) invalidSnapshot(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidSnapshot(`${label} must be a non-negative safe integer`);
  return value as number;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidSnapshot(`${label} must be a positive safe integer`);
  return value as number;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalidSnapshot(`${label} is invalid`);
  return value as T;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) invalidSnapshot(`${label} must be an array`);
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

function normalizeScopedId<K extends 'organ' | 'task' | 'cycle' | 'operation'>(value: unknown, label: string, expectedScope: K): { readonly scope: K; readonly value: string } {
  const input = assertObject(value, label);
  if (input.scope !== expectedScope) invalidSnapshot(`${label} must use ${expectedScope} scope`);
  const idValue = requiredString(input.value, `${label}.value`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(idValue)) invalidSnapshot(`${label}.value is not a valid id`);
  return { scope: expectedScope, value: idValue };
}

function normalizeMemoryScope(value: unknown, label: string): MemoryScope {
  const input = assertObject(value, label);
  const kind = enumValue(input.kind, ['task', 'organ', 'approved-global'] as const, `${label}.kind`);
  const organId = normalizeScopedId(input.organId, `${label}.organId`, 'organ');
  const taskId = input.taskId === undefined ? undefined : normalizeScopedId(input.taskId, `${label}.taskId`, 'task');
  if (kind === 'task' && taskId === undefined) invalidSnapshot(`${label}.taskId is required for task scope`);
  if (kind !== 'task' && taskId !== undefined) invalidSnapshot(`${label}.taskId is only valid for task scope`);
  return { kind, organId, ...(taskId === undefined ? {} : { taskId }) };
}

function normalizeRecordEntry(value: unknown, label: string): RecordEntry {
  const input = assertObject(value, label);
  const layer = input.layer === undefined
    ? undefined
    : enumValue(input.layer, ['current', 'task-recent', 'related', 'approved-long-term', 'raw'] as const, `${label}.layer`);
  const summary = optionalString(input.summary, `${label}.summary`);
  return {
    scope: normalizeMemoryScope(input.scope, `${label}.scope`),
    sourceRef: requiredString(input.sourceRef, `${label}.sourceRef`),
    sourceDigest: requiredString(input.sourceDigest, `${label}.sourceDigest`),
    text: requiredString(input.text, `${label}.text`),
    ...(layer === undefined ? {} : { layer }),
    ...(summary === undefined ? {} : { summary }),
  };
}

function validatePersistedContract(label: string, validate: () => void): void {
  try {
    validate();
  } catch (error) {
    invalidSnapshot(`${label}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
}

function normalizeCanonicalRecord(value: unknown, label: string): CanonicalRecord {
  const input = assertObject(value, label);
  const namespace = enumValue(input.namespace, ['project', 'global'] as const, `${label}.namespace`);
  const projectKey = optionalString(input.projectKey, `${label}.projectKey`);
  if (namespace === 'project' && projectKey === undefined) invalidSnapshot(`${label}.projectKey is required for project memory`);
  if (namespace === 'global' && projectKey !== undefined) invalidSnapshot(`${label}.projectKey is not valid for global memory`);
  const sourceRefs = stringArray(input.sourceRefs, `${label}.sourceRefs`);
  const sourceDigests = stringArray(input.sourceDigests, `${label}.sourceDigests`);
  if (sourceRefs.length !== sourceDigests.length) invalidSnapshot(`${label}.sourceRefs and sourceDigests must have the same length`);
  const taskId = input.taskId === undefined ? undefined : normalizeScopedId(input.taskId, `${label}.taskId`, 'task');
  return {
    memoryId: requiredString(input.memoryId, `${label}.memoryId`),
    namespace,
    ...(projectKey === undefined ? {} : { projectKey }),
    kind: enumValue(input.kind, ['episodic', 'semantic', 'procedural'] as const, `${label}.kind`),
    state: enumValue(input.state, ['candidate', 'approved', 'active', 'superseded', 'expired', 'archived', 'rejected'] as const, `${label}.state`),
    summary: requiredString(input.summary, `${label}.summary`),
    sourceRefs,
    sourceDigests,
    ...(taskId === undefined ? {} : { taskId }),
    sourceScopeRef: requiredString(input.sourceScopeRef, `${label}.sourceScopeRef`),
    relevanceReason: requiredString(input.relevanceReason, `${label}.relevanceReason`),
  };
}

function normalizeSubmission(value: unknown, label: string): MemorySubmission {
  const input = assertObject(value, label);
  const submission: MemorySubmission = {
    submissionId: requiredString(input.submissionId, `${label}.submissionId`),
    requestId: requiredString(input.requestId, `${label}.requestId`),
    operationId: normalizeScopedId(input.operationId, `${label}.operationId`, 'operation') as MemorySubmission['operationId'],
    bindingRef: requiredString(input.bindingRef, `${label}.bindingRef`),
    actor: input.actor as MemorySubmission['actor'],
    projectKey: requiredString(input.projectKey, `${label}.projectKey`),
    taskId: input.taskId === undefined ? undefined : normalizeScopedId(input.taskId, `${label}.taskId`, 'task') as MemorySubmission['taskId'],
    cycleId: input.cycleId === undefined ? undefined : normalizeScopedId(input.cycleId, `${label}.cycleId`, 'cycle') as MemorySubmission['cycleId'],
    requestedKind: enumValue(input.requestedKind, ['episodic', 'semantic', 'procedural'] as const, `${label}.requestedKind`),
    contentRef: requiredString(input.contentRef, `${label}.contentRef`),
    contentDigest: requiredString(input.contentDigest, `${label}.contentDigest`),
    evidenceRefs: stringArray(input.evidenceRefs, `${label}.evidenceRefs`),
    observation: requiredString(input.observation, `${label}.observation`),
    desiredScope: enumValue(input.desiredScope, ['project', 'global'] as const, `${label}.desiredScope`),
    reason: requiredString(input.reason, `${label}.reason`),
    inputDigest: requiredString(input.inputDigest, `${label}.inputDigest`),
  };
  validatePersistedContract(label, () => validateMemorySubmission(submission));
  return submission;
}

function normalizeReview(value: unknown, label: string): MemoryReviewReceipt {
  const input = assertObject(value, label);
  const review: MemoryReviewReceipt = {
    candidateId: requiredString(input.candidateId, `${label}.candidateId`),
    decision: enumValue(input.decision, ['approve', 'reject', 'defer'] as const, `${label}.decision`),
    actor: input.actor as MemoryReviewReceipt['actor'],
    decisionReason: requiredString(input.decisionReason, `${label}.decisionReason`),
    decidedAt: requiredString(input.decidedAt, `${label}.decidedAt`),
    evidenceRefs: stringArray(input.evidenceRefs, `${label}.evidenceRefs`),
  };
  validatePersistedContract(label, () => validateMemoryReviewReceipt(review));
  return review;
}

function normalizePromotion(value: unknown, label: string): MemoryPromotionReceipt {
  const input = assertObject(value, label);
  const promotion: MemoryPromotionReceipt = {
    candidateId: requiredString(input.candidateId, `${label}.candidateId`),
    from: enumValue(input.from, ['project'] as const, `${label}.from`),
    to: enumValue(input.to, ['global'] as const, `${label}.to`),
    actor: input.actor as MemoryPromotionReceipt['actor'],
    reason: requiredString(input.reason, `${label}.reason`),
    impactScope: requiredString(input.impactScope, `${label}.impactScope`),
    approvalRef: requiredString(input.approvalRef, `${label}.approvalRef`),
    sourceRefs: stringArray(input.sourceRefs, `${label}.sourceRefs`),
    promotedAt: requiredString(input.promotedAt, `${label}.promotedAt`),
  };
  validatePersistedContract(label, () => validateMemoryPromotionReceipt(promotion));
  return promotion;
}

function normalizeCandidateRecord(value: unknown, label: string): CandidateRecord {
  const input = assertObject(value, label);
  const submission = normalizeSubmission(input.submission, `${label}.submission`);
  const candidateId = input.candidateId === undefined ? undefined : requiredString(input.candidateId, `${label}.candidateId`);
  const state = enumValue(input.state, ['candidate', 'approved', 'rejected'] as const, `${label}.state`);
  const review = input.review === undefined ? undefined : normalizeReview(input.review, `${label}.review`);
  if (review !== undefined) {
    if (candidateId !== undefined && review.candidateId !== candidateId) invalidSnapshot(`${label}.review.candidateId must match candidateId`);
    if (review.actor.projectKey !== submission.projectKey) invalidSnapshot(`${label}.review.actor project does not match submission`);
  }
  const promotion = input.promotion === undefined ? undefined : normalizePromotion(input.promotion, `${label}.promotion`);
  if (promotion !== undefined) {
    if (candidateId !== undefined && promotion.candidateId !== candidateId) invalidSnapshot(`${label}.promotion.candidateId must match candidateId`);
    if (promotion.actor.projectKey !== submission.projectKey) invalidSnapshot(`${label}.promotion.actor project does not match submission`);
  }
  if (state === 'candidate' && review !== undefined && review.decision !== 'defer') invalidSnapshot(`${label}.review must defer a candidate`);
  if (state === 'approved' && review?.decision !== 'approve') invalidSnapshot(`${label}.review must approve an approved candidate`);
  if (state === 'rejected' && review?.decision !== 'reject') invalidSnapshot(`${label}.review must reject a rejected candidate`);
  if (state !== 'approved' && promotion !== undefined) invalidSnapshot(`${label}.promotion requires an approved candidate`);
  return {
    submission: { ...submission, evidenceRefs: [...submission.evidenceRefs] },
    ...(candidateId === undefined ? {} : { candidateId }),
    state,
    ...(review === undefined ? {} : { review: { ...review, evidenceRefs: [...review.evidenceRefs] } }),
    ...(promotion === undefined ? {} : { promotion: { ...promotion, sourceRefs: [...promotion.sourceRefs] } }),
  };
}

function normalizeForgettingPlan(value: unknown, label: string): MemoryForgettingPlan {
  const plan = value as MemoryForgettingPlan;
  validatePersistedContract(label, () => validateMemoryForgettingPlan(plan));
  return {
    ...plan,
    actions: plan.actions.map((action) => ({ ...action, sourceRefs: [...action.sourceRefs] })),
    protectedRefs: [...plan.protectedRefs],
  };
}

function normalizeSourceLock(value: unknown, label: string): SourceLock {
  const input = assertObject(value, label);
  return {
    sourceRef: requiredString(input.sourceRef, `${label}.sourceRef`),
    sourceDigest: requiredString(input.sourceDigest, `${label}.sourceDigest`),
    scope: normalizeMemoryScope(input.scope, `${label}.scope`),
  };
}

function normalizeAttachedEpoch(value: unknown, label: string): { readonly agentRuntimeId: string; readonly executionEpoch: number } {
  const input = assertObject(value, label);
  return {
    agentRuntimeId: requiredString(input.agentRuntimeId, `${label}.agentRuntimeId`),
    executionEpoch: positiveSafeInteger(input.executionEpoch, `${label}.executionEpoch`),
  };
}

function normalizeAttachedContext(value: unknown, label: string): { readonly agentRuntimeId: string; readonly contextId: string } {
  const input = assertObject(value, label);
  return {
    agentRuntimeId: requiredString(input.agentRuntimeId, `${label}.agentRuntimeId`),
    contextId: requiredString(input.contextId, `${label}.contextId`),
  };
}

function assertSnapshot(value: unknown): MemoryPersistenceSnapshot {
  const input = assertObject(value, 'snapshot');
  if (input.version !== 1) invalidSnapshot(`unsupported version: ${String(input.version)}`);
  const revision = nonNegativeSafeInteger(input.revision, 'revision');
  const rawRecords = input.records;
  const rawCanonicalRecords = input.canonicalRecords;
  const rawCandidates = input.candidates;
  const rawCandidateIds = input.candidateIds;
  const rawForgettingPlans = input.forgettingPlans;
  const rawSourceLocks = input.sourceLocks;
  const rawAttachedEpochs = input.attachedEpochs;
  const rawAttachedContextIds = input.attachedContextIds;
  if (!Array.isArray(rawRecords)) invalidSnapshot('records must be an array');
  if (!Array.isArray(rawCanonicalRecords)) invalidSnapshot('canonicalRecords must be an array');
  if (!Array.isArray(rawCandidates)) invalidSnapshot('candidates must be an array');
  if (!Array.isArray(rawCandidateIds)) invalidSnapshot('candidateIds must be an array');
  if (!Array.isArray(rawForgettingPlans)) invalidSnapshot('forgettingPlans must be an array');
  if (!Array.isArray(rawSourceLocks)) invalidSnapshot('sourceLocks must be an array');
  if (!Array.isArray(rawAttachedEpochs)) invalidSnapshot('attachedEpochs must be an array');
  if (!Array.isArray(rawAttachedContextIds)) invalidSnapshot('attachedContextIds must be an array');
  const records = rawRecords.map((record, index) => normalizeRecordEntry(record, `records[${index}]`));
  const canonicalRecords = rawCanonicalRecords.map((record, index) => normalizeCanonicalRecord(record, `canonicalRecords[${index}]`));
  const candidates = rawCandidates.map((candidate, index) => normalizeCandidateRecord(candidate, `candidates[${index}]`));
  const candidateIds = rawCandidateIds.map((mapping, index) => {
    const entry = assertObject(mapping, `candidateIds[${index}]`);
    return {
      candidateId: requiredString(entry.candidateId, `candidateIds[${index}].candidateId`),
      submissionId: requiredString(entry.submissionId, `candidateIds[${index}].submissionId`),
    };
  });
  const forgettingPlans = rawForgettingPlans.map((plan, index) => normalizeForgettingPlan(plan, `forgettingPlans[${index}]`));
  const sourceLocks = rawSourceLocks.map((lock, index) => normalizeSourceLock(lock, `sourceLocks[${index}]`));
  const attachedEpochs = rawAttachedEpochs.map((attached, index) => normalizeAttachedEpoch(attached, `attachedEpochs[${index}]`));
  const attachedContextIds = rawAttachedContextIds.map((attached, index) => normalizeAttachedContext(attached, `attachedContextIds[${index}]`));

  const recordsByRef = new Map<string, RecordEntry>();
  for (const record of records) {
    if (recordsByRef.has(record.sourceRef)) invalidSnapshot(`duplicate source record: ${record.sourceRef}`);
    recordsByRef.set(record.sourceRef, record);
  }
  const locksByRef = new Map<string, SourceLock>();
  for (const lock of sourceLocks) {
    if (locksByRef.has(lock.sourceRef)) invalidSnapshot(`duplicate source lock: ${lock.sourceRef}`);
    const record = recordsByRef.get(lock.sourceRef);
    if (!record) invalidSnapshot(`source lock has no record: ${lock.sourceRef}`);
    if (scopeKey(record.scope) !== scopeKey(lock.scope) || record.sourceDigest !== lock.sourceDigest) {
      invalidSnapshot(`source lock does not match record: ${lock.sourceRef}`);
    }
    locksByRef.set(lock.sourceRef, lock);
  }
  for (const record of records) {
    if (!locksByRef.has(record.sourceRef)) invalidSnapshot(`source record has no lock: ${record.sourceRef}`);
  }

  const candidatesBySubmission = new Map<string, CandidateRecord>();
  for (const candidate of candidates) {
    if (candidatesBySubmission.has(candidate.submission.submissionId)) invalidSnapshot(`duplicate candidate submission: ${candidate.submission.submissionId}`);
    if (candidate.candidateId === undefined) invalidSnapshot(`candidate is missing candidateId: ${candidate.submission.submissionId}`);
    candidatesBySubmission.set(candidate.submission.submissionId, candidate);
  }
  const candidateIdsByCandidate = new Map<string, string>();
  for (const mapping of candidateIds) {
    if (candidateIdsByCandidate.has(mapping.candidateId)) invalidSnapshot(`duplicate candidate id: ${mapping.candidateId}`);
    const candidate = candidatesBySubmission.get(mapping.submissionId);
    if (!candidate || candidate.candidateId !== mapping.candidateId) invalidSnapshot(`candidate id mapping does not match candidate: ${mapping.candidateId}`);
    candidateIdsByCandidate.set(mapping.candidateId, mapping.submissionId);
  }
  for (const candidate of candidates) {
    if (candidate.candidateId === undefined || candidateIdsByCandidate.get(candidate.candidateId) !== candidate.submission.submissionId) {
      invalidSnapshot(`candidate is missing its id mapping: ${candidate.submission.submissionId}`);
    }
  }

  const canonicalById = new Map<string, CanonicalRecord>();
  for (const record of canonicalRecords) {
    if (canonicalById.has(record.memoryId)) invalidSnapshot(`duplicate canonical memory id: ${record.memoryId}`);
    const sourceRefs = new Set<string>();
    for (const [index, sourceRef] of record.sourceRefs.entries()) {
      if (sourceRefs.has(sourceRef)) invalidSnapshot(`canonical record has duplicate source ref: ${record.memoryId}:${sourceRef}`);
      sourceRefs.add(sourceRef);
      const source = recordsByRef.get(sourceRef);
      if (!source) invalidSnapshot(`canonical record source is missing: ${record.memoryId}:${sourceRef}`);
      if (source.sourceDigest !== record.sourceDigests[index]) {
        invalidSnapshot(`canonical record source digest mismatch: ${record.memoryId}:${sourceRef}`);
      }
    }
    canonicalById.set(record.memoryId, record);
  }
  for (const candidate of candidates) {
    const candidateId = candidate.candidateId!;
    const projectRecord = canonicalById.get(candidateRecordId(candidateId));
    const globalRecord = canonicalById.get(`global:${candidateRecordId(candidateId)}`);
    if (candidate.state === 'approved') {
      if (!projectRecord) invalidSnapshot(`approved candidate has no canonical record: ${candidateId}`);
      if (projectRecord.namespace !== 'project') invalidSnapshot(`approved candidate canonical record must be project-scoped: ${candidateId}`);
      if (projectRecord.projectKey !== candidate.submission.projectKey) invalidSnapshot(`approved candidate canonical project mismatch: ${candidateId}`);
      if (!['approved', 'superseded', 'expired', 'archived'].includes(projectRecord.state)) invalidSnapshot(`approved candidate canonical state mismatch: ${candidateId}`);
      if (projectRecord.kind !== candidate.submission.requestedKind) invalidSnapshot(`approved candidate canonical kind mismatch: ${candidateId}`);
      if (projectRecord.summary !== candidate.submission.observation) invalidSnapshot(`approved candidate canonical summary mismatch: ${candidateId}`);
    } else if (projectRecord) {
      invalidSnapshot(`non-approved candidate has an approved canonical record: ${candidateId}`);
    }
    if (candidate.promotion === undefined) {
      if (globalRecord) invalidSnapshot(`candidate has a global canonical record without promotion: ${candidateId}`);
      continue;
    }
    if (!globalRecord) invalidSnapshot(`promoted candidate has no global canonical record: ${candidateId}`);
    if (globalRecord.namespace !== 'global' || !['active', 'superseded', 'expired', 'archived'].includes(globalRecord.state)) {
      invalidSnapshot(`promoted candidate global canonical state mismatch: ${candidateId}`);
    }
    if (globalRecord.projectKey !== undefined) invalidSnapshot(`promoted candidate global record cannot retain projectKey: ${candidateId}`);
    if (globalRecord.kind !== candidate.submission.requestedKind) invalidSnapshot(`promoted candidate global kind mismatch: ${candidateId}`);
    if (globalRecord.summary !== candidate.submission.observation) invalidSnapshot(`promoted candidate global summary mismatch: ${candidateId}`);
  }
  for (const plan of forgettingPlans) {
    for (const action of plan.actions) {
      if (action.action === 'cleanup-projection') continue;
      const record = canonicalById.get(action.memoryId);
      if (!record) invalidSnapshot(`forgetting action references an unknown memory: ${action.memoryId}`);
      if (record.namespace !== plan.namespace) invalidSnapshot(`forgetting action namespace mismatch: ${action.memoryId}`);
      if (plan.namespace === 'project' && record.projectKey !== plan.projectKey) invalidSnapshot(`forgetting action project mismatch: ${action.memoryId}`);
    }
  }

  const attachedEpochsByRuntime = new Map<string, number>();
  for (const attached of attachedEpochs) {
    if (attachedEpochsByRuntime.has(attached.agentRuntimeId)) invalidSnapshot(`duplicate attached epoch: ${attached.agentRuntimeId}`);
    attachedEpochsByRuntime.set(attached.agentRuntimeId, attached.executionEpoch);
  }
  const attachedContextsByRuntime = new Map<string, string>();
  for (const attached of attachedContextIds) {
    if (attachedContextsByRuntime.has(attached.agentRuntimeId)) invalidSnapshot(`duplicate attached context: ${attached.agentRuntimeId}`);
    attachedContextsByRuntime.set(attached.agentRuntimeId, attached.contextId);
  }
  for (const runtimeId of attachedEpochsByRuntime.keys()) {
    if (!attachedContextsByRuntime.has(runtimeId)) invalidSnapshot(`attached epoch has no context: ${runtimeId}`);
  }
  for (const runtimeId of attachedContextsByRuntime.keys()) {
    if (!attachedEpochsByRuntime.has(runtimeId)) invalidSnapshot(`attached context has no epoch: ${runtimeId}`);
  }

  return {
    version: 1,
    revision,
    records,
    canonicalRecords,
    candidates,
    candidateIds,
    forgettingPlans,
    sourceLocks,
    attachedEpochs,
    attachedContextIds,
  };
}

function normalizePersistencePath(filePath: string): string {
  if (!filePath.trim() || !isAbsolute(filePath) || normalize(filePath) !== filePath || dirname(filePath) === filePath) {
    throw persistenceError('memory-persistence-path-invalid', 'memory persistence path must be an absolute normalized file path', MEMORY_PERSISTENCE_OWNER);
  }
  return filePath;
}

const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PersistenceLockInfo {
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

function readLockInfo(content: string): PersistenceLockInfo | null {
  try {
    const parsed = JSON.parse(content) as Partial<PersistenceLockInfo>;
    if (
      typeof parsed.pid === 'number'
      && Number.isSafeInteger(parsed.pid)
      && parsed.pid > 0
      && typeof parsed.startedAt === 'string'
      && Number.isFinite(Date.parse(parsed.startedAt))
      && typeof parsed.token === 'string'
      && parsed.token.length > 0
    ) {
      return { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

function processAlive(processId: number): boolean {
  try {
    kill(processId, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

async function readLock(path: string): Promise<PersistenceLockInfo | null> {
  try {
    return readLockInfo(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function evictDeadLock(lockPath: string, expected: PersistenceLockInfo): Promise<boolean> {
  const guardPath = `${lockPath}.evict`;
  try {
    await mkdir(guardPath);
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const current = await readLock(lockPath);
    if (!current || current.pid !== expected.pid || current.token !== expected.token) return false;
    if (processAlive(current.pid)) return false;
    const stalePath = `${lockPath}.stale-${pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return true;
      throw error;
    }
    await rm(stalePath, { force: true });
    return true;
  } finally {
    await rm(guardPath, { recursive: true, force: true });
  }
}

async function acquireLock(filePath: string): Promise<{ readonly path: string; readonly token: string }> {
  const lockPath = `${filePath}.lock`;
  const startedAt = new Date().toISOString();
  const token = `${pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  await mkdir(dirname(filePath), { recursive: true });
  for (;;) {
    const tempLockPath = `${lockPath}.tmp-${pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try {
      const handle = await open(tempLockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid, startedAt, token }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tempLockPath, lockPath);
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        await rm(tempLockPath, { force: true }).catch(() => undefined);
        const current = await readLock(lockPath);
        if (current && !processAlive(current.pid) && await evictDeadLock(lockPath, current)) continue;
        if (Date.now() >= deadline) throw persistenceError('memory-persistence-io-failure', 'memory persistence lock timeout', MEMORY_PERSISTENCE_OWNER);
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      await rm(tempLockPath, { force: true }).catch(() => undefined);
      return { path: lockPath, token };
    } catch (error) {
      await rm(tempLockPath, { force: true }).catch(() => undefined);
      if ((error as { code?: string }).code === 'EEXIST') continue;
      throw error;
    }
  }
}

async function releaseLock(lock: { readonly path: string; readonly token: string }): Promise<void> {
  const current = await readLock(lock.path);
  if (current?.pid === pid && current.token === lock.token) {
    await rm(lock.path, { force: true });
  }
}

export class FilesystemMemoryPersistence implements MemoryPersistencePort {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = normalizePersistencePath(filePath);
  }

  async load(): Promise<MemoryPersistenceSnapshot | undefined> {
    try {
      return await this.readCurrent();
    } catch (error) {
      if (error instanceof MemoryPersistenceError) throw error;
      throw persistenceError('memory-persistence-io-failure', `memory persistence load failed: ${error instanceof Error ? error.message : String(error)}`, MEMORY_PERSISTENCE_OWNER, error);
    }
  }

  async save(snapshot: MemoryPersistenceSnapshot): Promise<void> {
    const normalized = assertSnapshot(snapshot);
    const parent = dirname(this.filePath);
    const tempPath = `${this.filePath}.${pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
    let lock: { readonly path: string; readonly token: string } | undefined;
    try {
      await this.assertNoSymlink(this.filePath);
      await mkdir(parent, { recursive: true });
      await this.assertNoSymlink(this.filePath);
      lock = await acquireLock(this.filePath);
      const current = await this.readCurrent();
      const currentRevision = current?.revision ?? 0;
      if (normalized.revision !== currentRevision + 1) {
        throw persistenceError(
          'memory-persistence-conflict',
          `memory persistence revision conflict: expected ${currentRevision + 1}, received ${normalized.revision}`,
          MEMORY_PERSISTENCE_OWNER,
        );
      }
      const handle = await open(tempPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(normalized)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.filePath);
      const directory = await open(parent, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof MemoryPersistenceError) throw error;
      throw persistenceError('memory-persistence-io-failure', `memory persistence save failed: ${error instanceof Error ? error.message : String(error)}`, MEMORY_PERSISTENCE_OWNER, error);
    } finally {
      if (lock) await releaseLock(lock);
    }
  }

  private async readCurrent(): Promise<MemoryPersistenceSnapshot | undefined> {
    await this.assertNoSymlink(this.filePath);
    const raw = await readFile(this.filePath, 'utf8').catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    });
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw persistenceError('memory-persistence-snapshot-invalid', 'memory persistence snapshot is invalid JSON', 'memory-persistence-snapshot', error);
    }
    return assertSnapshot(parsed);
  }

  private async assertNoSymlink(path: string): Promise<void> {
    let current = path;
    for (;;) {
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) {
          throw persistenceError('memory-persistence-path-invalid', `memory persistence path contains a symlink: ${current}`, MEMORY_PERSISTENCE_OWNER);
        }
      } catch (error) {
        if (error instanceof MemoryPersistenceError) throw error;
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}

function scopeKey(scope: MemoryScope): string { return `${scope.kind}:${scope.organId.value}:${scope.taskId?.value ?? ''}`; }
function visible(record: RecordEntry, scope: MemoryScope): boolean { return scopeKey(record.scope) === scopeKey(scope) || (scope.kind === 'approved-global' && record.scope.kind === 'approved-global' && record.scope.organId.value === scope.organId.value); }
function tokens(text: string): number { return text.trim() ? text.trim().split(/\s+/u).length : 0; }
function stable(value: string): string { let hash = 0; for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 31); return `memory:${(hash >>> 0).toString(16).padStart(8, '0')}`; }
function nonEmpty(value: string, label: string): string { if (!value.trim()) throw new ContractError(`${label} must be non-empty`); return value; }
function candidateRecordId(candidateId: string): string { return `memory-candidate:${candidateId}`; }
function queryVisible(record: CanonicalRecord, request: MemoryQueryRequest): boolean {
  return record.namespace === request.namespace
    && request.kinds.includes(record.kind)
    && request.states.includes(record.state)
    && (request.namespace === 'global' || record.projectKey === request.projectKey)
    && (request.taskId === undefined || (
      record.taskId !== undefined
      && record.taskId.scope === request.taskId.scope
      && record.taskId.value === request.taskId.value
    ));
}

export class DeterministicMemoryBackend implements MemoryOperationsPort, AgentMemoryContextInjectionPort {
  readonly indexVersion = 'fake-memory-v2';
  private readonly persistence?: MemoryPersistencePort;
  private mutationTail: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly records = new Map<string, RecordEntry>();
  private readonly canonicalRecords = new Map<string, CanonicalRecord>();
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly candidateIds = new Map<string, string>();
  private readonly forgettingPlans = new Map<string, MemoryForgettingPlan>();
  private readonly sourceLocks = new Map<string, SourceLock>();
  private readonly attachedEpochs = new Map<string, number>();
  private readonly attachedContextIds = new Map<string, string>();

  constructor(persistence?: MemoryPersistencePort) {
    this.persistence = persistence;
  }

  static async fromPersistence(persistence: MemoryPersistencePort): Promise<DeterministicMemoryBackend> {
    const backend = new DeterministicMemoryBackend(persistence);
    await backend.reload();
    return backend;
  }

  private runMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const current = this.mutationTail.then(operation);
    this.mutationTail = current.then(() => undefined, () => undefined);
    return current;
  }

  async reload(): Promise<void> {
    return this.runMutation(async () => {
      await this.loadAndRestore();
    });
  }

  private async loadAndRestore(): Promise<void> {
    const snapshot = await this.persistence?.load();
    this.restore(snapshot);
  }

  private restore(snapshot: MemoryPersistenceSnapshot | undefined): void {
    this.records.clear();
    this.canonicalRecords.clear();
    this.candidates.clear();
    this.candidateIds.clear();
    this.forgettingPlans.clear();
    this.sourceLocks.clear();
    this.attachedEpochs.clear();
    this.attachedContextIds.clear();
    this.revision = snapshot?.revision ?? 0;
    if (snapshot === undefined) return;
    for (const record of snapshot.records) this.records.set(record.sourceRef, { ...record });
    for (const record of snapshot.canonicalRecords) this.canonicalRecords.set(record.memoryId, { ...record });
    for (const candidate of snapshot.candidates) {
      this.candidates.set(candidate.submission.submissionId, {
        ...candidate,
        submission: { ...candidate.submission, evidenceRefs: [...candidate.submission.evidenceRefs] },
      });
    }
    for (const candidate of snapshot.candidateIds) this.candidateIds.set(candidate.candidateId, candidate.submissionId);
    for (const plan of snapshot.forgettingPlans) this.forgettingPlans.set(plan.planId, { ...plan });
    for (const lock of snapshot.sourceLocks) this.sourceLocks.set(lock.sourceRef, { ...lock });
    for (const attached of snapshot.attachedEpochs) this.attachedEpochs.set(attached.agentRuntimeId, attached.executionEpoch);
    for (const attached of snapshot.attachedContextIds) this.attachedContextIds.set(attached.agentRuntimeId, attached.contextId);
  }

  private snapshot(revision = this.revision): MemoryPersistenceSnapshot {
    return {
      revision,
      version: 1,
      records: [...this.records.values()].map((record) => ({ ...record })),
      canonicalRecords: [...this.canonicalRecords.values()].map((record) => ({
        ...record,
        sourceRefs: [...record.sourceRefs],
        sourceDigests: [...record.sourceDigests],
      })),
      candidates: [...this.candidates.values()].map((candidate) => ({
        ...candidate,
        submission: { ...candidate.submission, evidenceRefs: [...candidate.submission.evidenceRefs] },
      })),
      candidateIds: [...this.candidateIds.entries()].map(([candidateId, submissionId]) => ({ candidateId, submissionId })),
      forgettingPlans: [...this.forgettingPlans.values()].map((plan) => ({ ...plan, actions: plan.actions.map((action) => ({ ...action, sourceRefs: [...action.sourceRefs] })), protectedRefs: [...plan.protectedRefs] })),
      sourceLocks: [...this.sourceLocks.values()].map((lock) => ({ ...lock })),
      attachedEpochs: [...this.attachedEpochs.entries()].map(([agentRuntimeId, executionEpoch]) => ({ agentRuntimeId, executionEpoch })),
      attachedContextIds: [...this.attachedContextIds.entries()].map(([agentRuntimeId, contextId]) => ({ agentRuntimeId, contextId })),
    };
  }

  private async persist(before: MemoryPersistenceSnapshot): Promise<void> {
    if (!this.persistence) return;
    const nextRevision = before.revision + 1;
    try {
      await this.persistence.save(this.snapshot(nextRevision));
      this.revision = nextRevision;
    } catch (error) {
      if (error instanceof MemoryPersistenceError && error.code === 'memory-persistence-conflict') {
        try {
          await this.loadAndRestore();
        } catch (reloadError) {
          throw persistenceError(
            'memory-persistence-conflict',
            `${error.message}; reload after conflict failed: ${reloadError instanceof Error ? reloadError.message : String(reloadError)}`,
            MEMORY_PERSISTENCE_OWNER,
            reloadError,
          );
        }
      } else {
        this.restore(before);
      }
      throw error;
    }
  }

  async ingest(input: { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }): Promise<{ readonly sourceRef: string }> {
    return this.runMutation(async () => {
      if (!input.sourceRef || !input.sourceDigest || !input.text.trim()) throw new ContractError('memory source must have ref, digest, and text');
      const lock = this.sourceLocks.get(input.sourceRef);
      const existing = this.records.get(input.sourceRef);
      if (lock && (scopeKey(lock.scope) !== scopeKey(input.scope) || lock.sourceDigest !== input.sourceDigest)) {
        throw new ContractError(`memory source lock drifted: ${input.sourceRef}`);
      }
      if (existing && (scopeKey(existing.scope) !== scopeKey(input.scope) || existing.sourceDigest !== input.sourceDigest || existing.text !== input.text)) {
        throw new ContractError(`memory source already exists with different content: ${input.sourceRef}`);
      }
      if (existing) return { sourceRef: input.sourceRef };
      if (lock) throw new ContractError(`memory source lock has no authoritative record: ${input.sourceRef}`);
      const before = this.snapshot();
      this.records.set(input.sourceRef, { ...input });
      this.sourceLocks.set(input.sourceRef, {
        sourceRef: input.sourceRef,
        sourceDigest: input.sourceDigest,
        scope: input.scope,
      });
      await this.persist(before);
      return { sourceRef: input.sourceRef };
    });
  }

  async addContextEntry(input: { readonly scope: MemoryScope; readonly sourceRef: string; readonly sourceDigest: string; readonly text: string; readonly layer: ContextLayer; readonly summary?: string }): Promise<void> {
    return this.runMutation(async () => {
      const lock = this.sourceLocks.get(input.sourceRef);
      const existing = this.records.get(input.sourceRef);
      if (lock && (scopeKey(lock.scope) !== scopeKey(input.scope) || lock.sourceDigest !== input.sourceDigest)) {
        throw new ContractError(`memory source lock drifted: ${input.sourceRef}`);
      }
      if (existing && (scopeKey(existing.scope) !== scopeKey(input.scope) || existing.sourceDigest !== input.sourceDigest || existing.text !== input.text || existing.layer !== input.layer || existing.summary !== input.summary)) {
        throw new ContractError(`memory source classification is already authoritative: ${input.sourceRef}`);
      }
      if (existing) return;
      const before = this.snapshot();
      this.records.set(input.sourceRef, { ...input });
      this.sourceLocks.set(input.sourceRef, {
        sourceRef: input.sourceRef,
        sourceDigest: input.sourceDigest,
        scope: input.scope,
      });
      await this.persist(before);
    });
  }

  private storeCanonicalRecord(input: CanonicalRecord): void {
    nonEmpty(input.memoryId, 'memory id');
    nonEmpty(input.summary, 'memory summary');
    if (input.namespace === 'project') nonEmpty(input.projectKey ?? '', 'memory project key');
    if (input.sourceRefs.length !== input.sourceDigests.length) throw new ContractError('memory source refs and digests must match');
    const sourceRefs = new Set<string>();
    for (const [index, sourceRef] of input.sourceRefs.entries()) {
      if (sourceRefs.has(sourceRef)) throw new ContractError(`memory canonical record has duplicate source ref: ${sourceRef}`);
      sourceRefs.add(sourceRef);
      const source = this.records.get(sourceRef);
      if (!source) throw new ContractError(`memory source not found: ${sourceRef}`);
      if (source.sourceDigest !== input.sourceDigests[index]) {
        throw new ContractError(`memory source digest mismatch: ${sourceRef}`);
      }
    }
    this.canonicalRecords.set(input.memoryId, { ...input });
  }

  async addCanonicalRecord(input: CanonicalRecord): Promise<void> {
    return this.runMutation(async () => {
      const before = this.snapshot();
      this.storeCanonicalRecord(input);
      await this.persist(before);
    });
  }

  private sourceDigest(sourceRef: string): string {
    const record = this.records.get(sourceRef);
    if (!record) throw new ContractError(`memory source not found: ${sourceRef}`);
    return record.sourceDigest;
  }

  private mergeSourceRefs(
    existingRefs: readonly string[],
    existingDigests: readonly string[],
    addedRefs: readonly string[],
  ): { readonly sourceRefs: readonly string[]; readonly sourceDigests: readonly string[] } {
    const existing = new Map(existingRefs.map((sourceRef, index) => [sourceRef, existingDigests[index]!]));
    const sourceRefs = [...new Set([...existingRefs, ...addedRefs])];
    return {
      sourceRefs,
      sourceDigests: sourceRefs.map((sourceRef) => existing.get(sourceRef) ?? this.sourceDigest(sourceRef)),
    };
  }

  async search(input: { readonly scope: MemoryScope; readonly query: string; readonly limit: number }): Promise<readonly { readonly sourceRef: string; readonly summary: string }[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new ContractError('memory search limit must be positive');
    const query = input.query.trim().toLowerCase();
    if (!query) throw new ContractError('memory search query must be non-empty');
    const terms = query.split(/\s+/u);
    return [...this.records.values()].filter((record) => visible(record, input.scope)).filter((record) => record.text.toLowerCase() === query || terms.every((term) => record.text.toLowerCase().includes(term))).slice(0, input.limit).map((record) => ({ sourceRef: record.sourceRef, summary: record.summary ?? record.text.slice(0, 120) }));
  }

  async inspect(input: { readonly sourceRef: string }): Promise<{ readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }> { const record = this.records.get(input.sourceRef); if (!record) throw new ContractError(`memory source not found: ${input.sourceRef}`); return { sourceRef: record.sourceRef, sourceDigest: record.sourceDigest, text: record.text }; }
  async compare(input: { readonly leftRef: string; readonly rightRef: string }): Promise<{ readonly relation: 'same' | 'different' | 'unknown' }> { const left = this.records.get(input.leftRef); const right = this.records.get(input.rightRef); return !left || !right ? { relation: 'unknown' } : { relation: left.sourceDigest === right.sourceDigest ? 'same' : 'different' }; }
  async detectNovelty(input: NoveltyRequest): Promise<NoveltyResult> { const candidate = this.records.get(input.candidateRef); if (!candidate) return { classification: 'unknown', matchedRefs: [], reason: 'candidate source unavailable' }; const matches = input.comparisonRefs.filter((ref) => { const record = this.records.get(ref); return record && visible(record, input.scope) && record.sourceDigest === candidate.sourceDigest; }).slice(0, input.limit); return { classification: matches.length ? 'known' : 'novel', matchedRefs: matches, reason: matches.length ? 'matching source digest' : 'no matching source digest' }; }
  async detectRecurrence(input: RecurrenceRequest): Promise<RecurrenceResult> { const matches = input.windowRefs.map((ref) => this.records.get(ref)).filter((record): record is RecordEntry => Boolean(record && visible(record, input.scope) && record.text.includes(input.patternRef))).slice(0, input.limit); return { classification: matches.length > 1 ? 'recurring' : matches.length === 1 ? 'observed' : 'one-off', occurrences: matches.map((record) => ({ ref: record.sourceRef, digest: record.sourceDigest })), reason: matches.length > 1 ? 'pattern observed more than once' : 'deterministic exact pattern count' }; }

  async query(input: MemoryQueryRequest): Promise<MemoryQueryResponse> {
    validateMemoryQueryRequest(input);
    const query = input.query.trim().toLowerCase();
    const terms = query.split(/\s+/u);
    let remaining = input.tokenBudget;
    const omitted: { reason: string; ref?: string }[] = [];
    const entries: MemoryQueryEntry[] = [];
    for (const record of this.canonicalRecords.values()) {
      if (!queryVisible(record, input)) continue;
      if (!(record.summary.toLowerCase() === query || terms.every((term) => record.summary.toLowerCase().includes(term)))) continue;
      const cost = tokens(record.summary);
      if (cost > remaining) {
        omitted.push({ reason: 'token-budget', ref: record.memoryId });
        continue;
      }
      remaining -= cost;
      entries.push({
        memoryId: record.memoryId,
        namespace: record.namespace,
        kind: record.kind,
        state: record.state,
        summary: record.summary,
        sourceRefs: [...record.sourceRefs],
        sourceDigests: [...record.sourceDigests],
        projectKey: record.projectKey,
        sourceScopeRef: record.sourceScopeRef,
        relevanceReason: record.relevanceReason,
      });
      if (entries.length >= input.limit) break;
    }
    return {
      requestId: input.requestId,
      status: 'ready',
      entries,
      indexVersion: this.indexVersion,
      sourceFactRef: `memory-query:${input.requestId}`,
      omitted,
    };
  }

  async submitCandidate(input: MemorySubmission): Promise<MemorySubmissionReceipt> {
    return this.runMutation(async () => {
      validateMemorySubmission(input);
      const existing = this.candidates.get(input.submissionId);
      if (existing) {
        if (
          existing.submission.inputDigest !== input.inputDigest
          || existing.submission.actor.actorId !== input.actor.actorId
          || existing.submission.actor.projectKey !== input.actor.projectKey
          || existing.submission.projectKey !== input.projectKey
        ) {
          throw new ContractError('memory submission identity conflicts with an existing submission');
        }
        const candidateId = existing.candidateId;
        return {
          submissionId: input.submissionId,
          status: 'duplicate',
          candidateId,
          operationId: existing.submission.operationId,
          sourceRef: existing.submission.contentRef,
          sourceFactRef: candidateRecordId(candidateId ?? existing.submission.submissionId),
          nextAction: 'wait-analysis',
        };
      }
      const candidateId = input.submissionId;
      const before = this.snapshot();
      this.candidates.set(input.submissionId, { submission: input, candidateId, state: 'candidate' });
      this.candidateIds.set(candidateId, input.submissionId);
      await this.persist(before);
      return {
        submissionId: input.submissionId,
        status: 'accepted',
        candidateId,
        operationId: input.operationId,
        sourceRef: input.contentRef,
        sourceFactRef: candidateRecordId(input.submissionId),
        nextAction: 'wait-analysis',
      };
    });
  }

  async reviewCandidate(input: MemoryReviewReceipt): Promise<MemoryReviewReceipt> {
    return this.runMutation(async () => {
      validateMemoryReviewReceipt(input);
      const submissionId = this.candidateIds.get(input.candidateId);
      const candidate = submissionId === undefined ? undefined : this.candidates.get(submissionId);
      if (!candidate) throw new ContractError(`memory candidate not found: ${input.candidateId}`);
      if (input.actor.projectKey !== candidate.submission.projectKey) throw new ContractError('memory review actor project mismatch');
      if (candidate.state === 'approved' || candidate.state === 'rejected') {
        throw new ContractError('memory candidate review is already final');
      }
      if (input.decision === 'approve') {
        const submission = candidate.submission;
        const contentDigest = this.sourceDigest(submission.contentRef);
        if (contentDigest !== submission.contentDigest) {
          throw new ContractError('memory submission content digest does not match the ingested source');
        }
        const sources = this.mergeSourceRefs([submission.contentRef], [contentDigest], submission.evidenceRefs);
        const canonicalRecord: CanonicalRecord = {
          memoryId: candidateRecordId(input.candidateId),
          namespace: 'project',
          projectKey: submission.projectKey,
          kind: submission.requestedKind,
          state: 'approved',
          summary: submission.observation,
          sourceRefs: sources.sourceRefs,
          sourceDigests: sources.sourceDigests,
          taskId: submission.taskId,
          sourceScopeRef: `${submission.projectKey}:${submission.taskId?.value ?? 'interaction'}`,
          relevanceReason: submission.reason,
        };
        const before = this.snapshot();
        this.storeCanonicalRecord(canonicalRecord);
        candidate.review = input;
        candidate.state = 'approved';
        await this.persist(before);
        return input;
      }
      const before = this.snapshot();
      candidate.review = input;
      candidate.state = input.decision === 'reject' ? 'rejected' : 'candidate';
      await this.persist(before);
      return input;
    });
  }

  async promoteCandidate(input: MemoryPromotionReceipt): Promise<MemoryPromotionReceipt> {
    return this.runMutation(async () => {
      validateMemoryPromotionReceipt(input);
      const submissionId = this.candidateIds.get(input.candidateId);
      const candidate = submissionId === undefined ? undefined : this.candidates.get(submissionId);
      if (!candidate) throw new ContractError(`memory candidate not found: ${input.candidateId}`);
      if (input.actor.projectKey !== candidate.submission.projectKey) throw new ContractError('memory promotion actor project mismatch');
      if (candidate.state !== 'approved') throw new ContractError('memory promotion requires an approved candidate');
      if (candidate.promotion !== undefined) throw new ContractError('memory candidate promotion is already final');
      const approved = this.canonicalRecords.get(candidateRecordId(input.candidateId));
      if (!approved) throw new ContractError('approved memory record is unavailable');
      const sources = this.mergeSourceRefs(approved.sourceRefs, approved.sourceDigests, [input.approvalRef, ...input.sourceRefs]);
      const promoted: CanonicalRecord = {
        ...approved,
        memoryId: `global:${approved.memoryId}`,
        namespace: 'global',
        projectKey: undefined,
        state: 'active',
        sourceRefs: sources.sourceRefs,
        sourceDigests: sources.sourceDigests,
        relevanceReason: input.reason,
      };
      const before = this.snapshot();
      this.storeCanonicalRecord(promoted);
      candidate.promotion = input;
      await this.persist(before);
      return input;
    });
  }

  async planForgetting(input: MemoryForgettingRequest): Promise<MemoryForgettingPlan> {
    return this.runMutation(async () => {
      validateMemoryForgettingRequest(input);
      const pending = new Map<string, CanonicalRecord>();
      for (const action of input.plan.actions) {
        if (action.action === 'cleanup-projection') continue;
        const record = this.canonicalRecords.get(action.memoryId);
        if (!record) throw new ContractError(`memory record not found for forgetting: ${action.memoryId}`);
        if (record.namespace !== input.plan.namespace) throw new ContractError(`memory forgetting namespace mismatch: ${action.memoryId}`);
        if (input.plan.namespace === 'project' && record.projectKey !== input.plan.projectKey) {
          throw new ContractError(`memory forgetting project mismatch: ${action.memoryId}`);
        }
        pending.set(action.memoryId, {
          ...record,
          state: action.action === 'supersede' ? 'superseded' : action.action === 'expire' ? 'expired' : 'archived',
        });
      }
      const before = this.snapshot();
      this.forgettingPlans.set(input.plan.planId, input.plan);
      for (const [memoryId, record] of pending) this.canonicalRecords.set(memoryId, record);
      await this.persist(before);
      return input.plan;
    });
  }

  async recall(input: AgentMemoryContextRequest): Promise<AgentMemoryContext> {
    return this.runMutation(async () => {
      if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 0) throw new ContractError('context token budget must be finite and non-negative');
      const contextId = stable(`${input.agentRuntimeId}:${scopeKey(input.scope)}:${input.taskId.value}:${input.executionEpoch}:${input.query ?? ''}:${input.layers.join(',')}`);
      let remaining = input.tokenBudget;
      const omitted: { reason: string; sourceRef?: string }[] = [];
      const entries = [...this.records.values()].filter((record) => visible(record, input.scope) && record.layer && input.layers.includes(record.layer)).filter((record) => !input.query || record.text.toLowerCase().includes(input.query.toLowerCase())).flatMap((record) => { const tokenCost = tokens(record.summary ?? record.text); if (tokenCost > remaining) { omitted.push({ reason: 'token-budget', sourceRef: record.sourceRef }); return []; } remaining -= tokenCost; return [{ layer: record.layer!, summary: record.summary ?? record.text, sourceRef: record.sourceRef, sourceDigest: record.sourceDigest, scope: scopeKey(record.scope), tokenCost }]; });
      const context: AgentMemoryContext = { contextId, executionEpoch: input.executionEpoch, entries, omitted, indexVersion: this.indexVersion };
      assertContextBudget(context, input.tokenBudget);
      const before = this.snapshot();
      this.attachedEpochs.set(input.agentRuntimeId, input.executionEpoch);
      this.attachedContextIds.set(input.agentRuntimeId, context.contextId);
      await this.persist(before);
      return context;
    });
  }

  async attach(input: { readonly agentRuntimeId: string; readonly context: AgentMemoryContext }): Promise<{ readonly contextId: string; readonly attached: boolean }> {
    if (this.attachedEpochs.get(input.agentRuntimeId) !== input.context.executionEpoch) throw new ContractError('context execution epoch is not bound to runtime');
    if (this.attachedContextIds.get(input.agentRuntimeId) !== input.context.contextId) throw new ContractError('context id is not bound to runtime recall');
    return { contextId: input.context.contextId, attached: true };
  }
}
