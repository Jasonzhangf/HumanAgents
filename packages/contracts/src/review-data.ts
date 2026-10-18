import {
  assertEvidenceRef,
  type EvidenceRef,
  type WorkAssignment,
} from './index.js';
import { ContractError } from './errors.js';

/**
 * Shared Review data contract. Contracts owns the shape, the registered value
 * sets and the assignment/result identity match. The Runtime owns review
 * capability admission, severity/gate policy, remediation and assignment
 * creation; it consumes and re-exports these definitions instead of keeping a
 * second schema. This module holds no store, registry, codec or runtime state.
 */

export const REVIEW_KIND_VALUES = [
  'architecture',
  'baseline',
  'quality',
  'security',
  'delivery',
] as const;
export type ReviewKind = (typeof REVIEW_KIND_VALUES)[number];

export const REVIEW_STATUS_VALUES = ['passed', 'failed', 'inconclusive'] as const;
export type ReviewStatus = (typeof REVIEW_STATUS_VALUES)[number];

export const REVIEW_SEVERITY_VALUES = ['P0', 'P1', 'blocker', 'important', 'advisory'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITY_VALUES)[number];

export const REVIEW_KIND_WHITELIST: readonly ReviewKind[] = Object.freeze([...REVIEW_KIND_VALUES]);
export const REVIEW_STATUS_WHITELIST: readonly ReviewStatus[] = Object.freeze([...REVIEW_STATUS_VALUES]);
export const REVIEW_SEVERITY_WHITELIST: readonly ReviewSeverity[] = Object.freeze([...REVIEW_SEVERITY_VALUES]);

export interface ReviewFinding {
  readonly findingId: string;
  readonly severity: ReviewSeverity;
  readonly locationRef: string;
  readonly problem: string;
  readonly expected: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ReviewAssignment {
  readonly assignmentId: string;
  readonly taskId: string;
  readonly workerAgentId: string;
  readonly reviewKind: ReviewKind;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly inputRevision: number;
  readonly subjectRefs: readonly string[];
  readonly workerCapabilities: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly mergeGate: WorkAssignment['mergeGate'];
}

export interface ReviewResult {
  readonly resultId: string;
  readonly assignmentId: string;
  readonly taskId: string;
  readonly workerAgentId: string;
  readonly reviewKind: ReviewKind;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly inputRevision: number;
  readonly subjectRefs: readonly string[];
  readonly status: ReviewStatus;
  readonly findings: readonly ReviewFinding[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

/** The identity fields a review assignment and its result must agree on. */
type ReviewIdentity = Pick<
  ReviewAssignment,
  | 'assignmentId'
  | 'taskId'
  | 'workerAgentId'
  | 'reviewKind'
  | 'attempt'
  | 'executionEpoch'
  | 'inputRevision'
  | 'subjectRefs'
>;

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ContractError(`${label} must be an object`);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError(`${label} is required`);
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

function assertRefList(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ContractError(`${label} must be a non-empty array`);
  for (const entry of value) nonEmpty(entry, label);
}

function assertUniqueRefs(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new ContractError(`${label} must be an array`);
  const seen = new Set<string>();
  for (const entry of value) {
    nonEmpty(entry, label);
    if (seen.has(entry)) throw new ContractError(`duplicate ${label}: ${entry}`);
    seen.add(entry);
  }
}

function assertEvidenceRefList(value: unknown, label: string): asserts value is readonly EvidenceRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new ContractError(`${label} evidence is required`);
  const seen = new Set<string>();
  for (const ref of value) {
    assertPlainObject(ref, `${label} evidence`);
    assertPlainObject(ref.evidenceId, `${label} evidence id`);
    assertPlainObject(ref.scope, `${label} evidence scope`);
    assertPlainObject((ref.scope as Record<string, unknown>).organId, `${label} evidence organ scope`);
    assertEvidenceRef(ref as unknown as EvidenceRef);
    const key = (ref.evidenceId as { value: string }).value;
    if (seen.has(key)) throw new ContractError(`duplicate ${label} evidence id: ${key}`);
    seen.add(key);
  }
}

export function assertReviewKind(value: unknown): asserts value is ReviewKind {
  if (typeof value !== 'string' || !REVIEW_KIND_WHITELIST.includes(value as ReviewKind)) {
    throw new ContractError(`unregistered review kind: ${String(value)}`);
  }
}

export function assertReviewStatus(value: unknown): asserts value is ReviewStatus {
  if (typeof value !== 'string' || !REVIEW_STATUS_WHITELIST.includes(value as ReviewStatus)) {
    throw new ContractError(`unregistered review status: ${String(value)}`);
  }
}

export function assertReviewSeverity(value: unknown): asserts value is ReviewSeverity {
  if (typeof value !== 'string' || !REVIEW_SEVERITY_WHITELIST.includes(value as ReviewSeverity)) {
    throw new ContractError(`unregistered review severity: ${String(value)}`);
  }
}

function assertSubjectRefs(value: Record<string, unknown>, label: string): void {
  assertRefList(value.subjectRefs, `${label} subject ref`);
  assertUniqueRefs(value.subjectRefs, `${label} subject ref`);
}

/** Structure and registered-value validation for a review assignment. */
export function validateReviewAssignment(input: unknown): asserts input is ReviewAssignment {
  assertPlainObject(input, 'review assignment');
  assertReviewKind(input.reviewKind);
  nonEmpty(input.assignmentId, 'review assignment id');
  nonEmpty(input.taskId, 'review task id');
  nonEmpty(input.workerAgentId, 'review worker agent id');
  assertPositiveSafeInteger(input.attempt, 'review attempt');
  assertPositiveSafeInteger(input.executionEpoch, 'review execution epoch');
  assertPositiveSafeInteger(input.inputRevision, 'review input revision');
  assertSubjectRefs(input, 'review assignment');
  assertUniqueRefs(input.workerCapabilities, 'review worker capability');
  assertUniqueRefs(input.requiredCapabilities, 'review required capability');
  if ((input.requiredCapabilities as readonly string[]).length === 0) {
    throw new ContractError('review required capability is required');
  }
}

/** Structure and registered-value validation for a review result. */
export function validateReviewResult(input: unknown): asserts input is ReviewResult {
  assertPlainObject(input, 'review result');
  assertReviewKind(input.reviewKind);
  assertReviewStatus(input.status);
  nonEmpty(input.resultId, 'review result id');
  nonEmpty(input.assignmentId, 'review result assignment id');
  nonEmpty(input.taskId, 'review result task id');
  nonEmpty(input.workerAgentId, 'review result worker agent id');
  assertPositiveSafeInteger(input.attempt, 'review result attempt');
  assertPositiveSafeInteger(input.executionEpoch, 'review result execution epoch');
  assertPositiveSafeInteger(input.inputRevision, 'review result input revision');
  assertSubjectRefs(input, 'review result');
  assertEvidenceRefList(input.evidenceRefs, 'review result');
  if (!Array.isArray(input.findings)) throw new ContractError('review result findings must be an array');
  const findings = input.findings as readonly ReviewFinding[];
  const findingIds: string[] = [];
  for (const finding of findings) {
    assertPlainObject(finding, 'review finding');
    assertReviewSeverity(finding.severity);
    nonEmpty(finding.findingId, 'review finding id');
    nonEmpty(finding.locationRef, 'review finding location');
    nonEmpty(finding.problem, 'review finding problem');
    nonEmpty(finding.expected, 'review finding expected');
    assertEvidenceRefList(finding.evidenceRefs, 'review finding');
    findingIds.push(finding.findingId);
  }
  assertUniqueRefs(findingIds, 'review finding id');
}

function orderedRefsMatch(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameReviewIdentity(left: ReviewIdentity, right: ReviewIdentity): boolean {
  return left.assignmentId === right.assignmentId
    && left.taskId === right.taskId
    && left.workerAgentId === right.workerAgentId
    && left.reviewKind === right.reviewKind
    && left.attempt === right.attempt
    && left.executionEpoch === right.executionEpoch
    && left.inputRevision === right.inputRevision
    && orderedRefsMatch(left.subjectRefs, right.subjectRefs);
}

/**
 * Two review assignments name the same dispatched review call. Used to bind a
 * returned delivery to the invocation that was actually dispatched.
 */
export function assertReviewAssignmentsMatch(left: unknown, right: unknown): void {
  validateReviewAssignment(left);
  validateReviewAssignment(right);
  if (!sameReviewIdentity(left, right)) throw new ContractError('review assignment identity mismatch');
}

/**
 * A review result must carry the identity of the assignment it answers. A
 * mismatch in any shared field, including the ordered subject refs, means the
 * result belongs to another attempt, epoch or review call.
 */
export function assertReviewResultMatchesAssignment(assignment: unknown, result: unknown): void {
  validateReviewAssignment(assignment);
  validateReviewResult(result);
  if (!sameReviewIdentity(assignment, result)) {
    throw new ContractError('review result does not match its assignment');
  }
}
