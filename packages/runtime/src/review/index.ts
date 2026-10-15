import {
  validateWorkResult,
  type EvidenceRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../contracts/src/index.js';
import {
  assertReviewResultMatchesAssignment as assertReviewResultMatchesAssignmentData,
  validateReviewAssignment as validateReviewAssignmentData,
  validateReviewResult as validateReviewResultData,
  REVIEW_KIND_WHITELIST,
  type ReviewAssignment,
  type ReviewFinding,
  type ReviewKind,
  type ReviewResult,
  type ReviewSeverity,
  type ReviewStatus,
} from '../../../contracts/src/index.js';

export {
  REVIEW_KIND_VALUES,
  REVIEW_STATUS_VALUES,
  REVIEW_SEVERITY_VALUES,
  REVIEW_KIND_WHITELIST,
  REVIEW_STATUS_WHITELIST,
  REVIEW_SEVERITY_WHITELIST,
  validateReviewAssignment,
  validateReviewResult,
  assertReviewAssignmentsMatch,
  type ReviewAssignment,
  type ReviewFinding,
  type ReviewKind,
  type ReviewResult,
  type ReviewSeverity,
  type ReviewStatus,
} from '../../../contracts/src/index.js';

export const DEFAULT_REVIEW_KINDS: readonly ReviewKind[] = REVIEW_KIND_WHITELIST;

export const REVIEW_CAPABILITIES: readonly string[] = [
  'audit.read',
  'architecture.review',
  'baseline.review',
  'quality.review',
  'security.review',
  'delivery.review',
  'test.audit',
  'result.audit',
];

const REVIEW_CAPABILITY_BY_KIND: Readonly<Record<ReviewKind, string>> = {
  architecture: 'architecture.review',
  baseline: 'baseline.review',
  quality: 'quality.review',
  security: 'security.review',
  delivery: 'delivery.review',
};

export interface ReviewAssignmentInput {
  readonly workerAssignment: WorkAssignment;
  readonly workerResult: WorkResult;
  readonly reviewKinds?: readonly ReviewKind[];
  readonly subjectRefs: readonly string[];
  readonly subjectDigests: readonly string[];
}

export interface RemediationRequest {
  readonly ownerId: string;
  readonly sourceReviewAssignmentId: string;
  readonly sourceReviewResultId: string;
  readonly findingIds: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly excludedReviewCapabilities: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type NonTerminalReviewDecisionStatus =
  | 'waiting'
  | 'remediation'
  | 'attention';
export type ReviewDecisionStatus =
  | 'succeeded'
  | NonTerminalReviewDecisionStatus
  | 'failed'
  | 'incomplete'
  | 'blocked'
  | 'cancelled';

export interface ReviewDecision {
  readonly status: ReviewDecisionStatus;
  readonly ownerId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly nextAction: {
    readonly kind: 'settle' | 'wait' | 'remediate' | 'stop' | 'review';
    readonly ref: string;
  };
  readonly remediation?: RemediationRequest;
}

export interface ReviewGateInput {
  readonly workerAssignment: WorkAssignment;
  readonly workerResult: WorkResult;
  readonly reviewAssignments?: readonly ReviewAssignment[];
  readonly reviewResults?: readonly ReviewResult[];
  readonly mergeEvidenceRefs?: readonly EvidenceRef[];
  readonly orchestrationManagerId: string;
}

export class ReviewCoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewCoordinatorError';
  }
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new ReviewCoordinatorError(`${label} is required`);
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReviewCoordinatorError(`${label} must be a positive safe integer`);
  }
}

function assertNonEmptyRefs(values: readonly string[], label: string): void {
  for (const value of values) {
    if (!value.trim()) throw new ReviewCoordinatorError(`${label} must be present`);
  }
}

function assertUniqueRefs(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new ReviewCoordinatorError(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertEvidence(value: readonly EvidenceRef[], label: string): void {
  if (value.length === 0) {
    throw new ReviewCoordinatorError(`${label} evidence is required`);
  }
  assertUniqueRefs(
    value.map((ref) => ref.evidenceId.value),
    `${label} evidence id`,
  );
  for (const ref of value) {
    if (!ref.evidenceId.value || !ref.source.trim() || !ref.locator.trim()) {
      throw new ReviewCoordinatorError(`${label} evidence must be present`);
    }
  }
}

function assertNoReviewCapabilities(capabilities: readonly string[], label: string): void {
  for (const capability of capabilities) {
    if (REVIEW_CAPABILITIES.includes(capability)) {
      throw new ReviewCoordinatorError(`${label} must not include review capability: ${capability}`);
    }
  }
}

function workerCapabilities(input: WorkAssignment): readonly string[] {
  const capabilities = input.requiredCapabilities.filter(
    (capability) => !REVIEW_CAPABILITIES.includes(capability),
  );
  return [...capabilities];
}

function hasRemediationSeverity(finding: ReviewFinding): boolean {
  return (
    finding.severity === 'P0' ||
    finding.severity === 'P1' ||
    finding.severity === 'blocker' ||
    finding.severity === 'important'
  );
}

function isReviewCapability(capability: string): boolean {
  return REVIEW_CAPABILITIES.includes(capability);
}

function asReviewCoordinatorError(error: unknown): ReviewCoordinatorError {
  if (error instanceof ReviewCoordinatorError) return error;
  return new ReviewCoordinatorError(error instanceof Error ? error.message : String(error));
}

function assertReviewKind(kind: unknown): asserts kind is ReviewKind {
  if (typeof kind !== 'string' || !REVIEW_KIND_WHITELIST.includes(kind as ReviewKind)) {
    throw new ReviewCoordinatorError(`unregistered review kind: ${String(kind)}`);
  }
}

function reviewCapabilityFor(kind: ReviewKind): string {
  const capability = REVIEW_CAPABILITY_BY_KIND[kind];
  if (!REVIEW_CAPABILITIES.includes(capability)) {
    throw new ReviewCoordinatorError(`review capability is not registered: ${capability}`);
  }
  return capability;
}

export function assertReviewAssignment(input: ReviewAssignment): void {
  try {
    validateReviewAssignmentData(input);
  } catch (error) {
    throw asReviewCoordinatorError(error);
  }
  assertNoReviewCapabilities(input.workerCapabilities, 'review worker capabilities');
  if (!input.requiredCapabilities.some((capability) => capability === reviewCapabilityFor(input.reviewKind))) {
    throw new ReviewCoordinatorError('review assignment must require its review capability');
  }
}

export function assertReviewResult(input: ReviewResult): void {
  try {
    validateReviewResultData(input);
  } catch (error) {
    throw asReviewCoordinatorError(error);
  }
  if (input.findings.length === 0 && input.status !== 'passed') {
    throw new ReviewCoordinatorError('non-passed review result requires findings');
  }
  const remediationFindings = input.findings.filter(hasRemediationSeverity);
  if (input.status === 'passed' && remediationFindings.length > 0) {
    throw new ReviewCoordinatorError('passed review cannot include remediation severity findings');
  }
  if (input.status === 'failed' && remediationFindings.length === 0) {
    throw new ReviewCoordinatorError('failed review requires a remediation severity finding');
  }
}

export function assertReviewResultMatchesAssignment(
  assignment: ReviewAssignment,
  result: ReviewResult,
): void {
  try {
    assertReviewAssignment(assignment);
    assertReviewResult(result);
    assertReviewResultMatchesAssignmentData(assignment, result);
  } catch (error) {
    throw asReviewCoordinatorError(error);
  }
}

export function assertCompleteReviewResults(
  assignments: readonly ReviewAssignment[],
  results: readonly ReviewResult[],
): void {
  assertUniqueRefs(assignments.map((assignment) => assignment.assignmentId), 'review assignment id');
  assertUniqueRefs(results.map((result) => result.resultId), 'review result id');
  assertUniqueRefs(results.map((result) => result.assignmentId), 'review result assignment id');
  const assignedIds = new Set(assignments.map((assignment) => assignment.assignmentId));
  const deliveredIds = new Set(results.map((result) => result.assignmentId));
  if (assignedIds.size !== deliveredIds.size || ![...assignedIds].every((id) => deliveredIds.has(id))) {
    throw new ReviewCoordinatorError('review results must include every review assignment exactly once');
  }
  for (const result of results) {
    const assignment = assignments.find((candidate) => candidate.assignmentId === result.assignmentId);
    if (!assignment) throw new ReviewCoordinatorError('review result has no matching assignment');
    assertReviewResultMatchesAssignment(assignment, result);
  }
}

export function createReviewAssignments(input: ReviewAssignmentInput): readonly ReviewAssignment[] {
  validateWorkResult(input.workerResult, input.workerAssignment);
  nonEmpty(input.workerResult.agentId, 'work result agent id');
  assertUniqueRefs(input.workerAssignment.targetRefs, 'worker assignment target ref');
  assertNonEmptyRefs(input.subjectRefs, 'review subject ref');
  assertNonEmptyRefs(input.subjectDigests, 'review subject digest');
  assertUniqueRefs(input.subjectRefs, 'review subject ref');
  assertUniqueRefs(input.subjectDigests, 'review subject digest');
  if (input.subjectRefs.length !== input.subjectDigests.length) {
    throw new ReviewCoordinatorError('review subject and digest counts must match');
  }
  if (!sameUniqueValues(input.subjectRefs, input.workerAssignment.targetRefs)) {
    throw new ReviewCoordinatorError('review subject refs must match worker assignment target refs');
  }
  const kinds = input.reviewKinds ?? DEFAULT_REVIEW_KINDS;
  for (const kind of kinds) assertReviewKind(kind);
  assertUniqueRefs(kinds, 'review kind');
  const worker = workerCapabilities(input.workerAssignment);
  return kinds.map((kind) => ({
    assignmentId: `${input.workerAssignment.assignmentId}:review:${kind}`,
    taskId: input.workerAssignment.taskId.value,
    workerAgentId: input.workerResult.agentId,
    reviewKind: kind,
    attempt: input.workerAssignment.attempt,
    executionEpoch: input.workerAssignment.executionEpoch,
    inputRevision: input.workerAssignment.inputRevision,
    acceptanceCriteriaDigest: input.workerAssignment.acceptanceCriteriaDigest,
    subjectRefs: [...input.subjectRefs],
    subjectDigests: [...input.subjectDigests],
    workerCapabilities: [...worker],
    requiredCapabilities: [reviewCapabilityFor(kind)],
    mergeGate: input.workerAssignment.mergeGate,
  }));
}

export class ReviewCoordinator {
  private readonly assignments: ReviewAssignment[] = [];
  private readonly results: ReviewResult[] = [];

  private assertCanAddReviewAssignment(assignment: ReviewAssignment): void {
    assertReviewAssignment(assignment);
    if (this.assignments.some((candidate) => candidate.assignmentId === assignment.assignmentId)) {
      throw new ReviewCoordinatorError(`duplicate review assignment id: ${assignment.assignmentId}`);
    }
  }

  addReviewAssignments(assignments: readonly ReviewAssignment[]): void {
    assertUniqueRefs(assignments.map((assignment) => assignment.assignmentId), 'review assignment id');
    for (const assignment of assignments) {
      this.assertCanAddReviewAssignment(assignment);
    }
    for (const assignment of assignments) {
      this.assignments.push(assignment);
    }
  }

  addReviewAssignment(assignment: ReviewAssignment): void {
    this.assertCanAddReviewAssignment(assignment);
    this.assignments.push(assignment);
  }

  addReviewResult(result: ReviewResult): void {
    assertReviewResult(result);
    if (this.results.some((candidate) => candidate.resultId === result.resultId)) {
      throw new ReviewCoordinatorError(`duplicate review result id: ${result.resultId}`);
    }
    if (this.results.some((candidate) => candidate.assignmentId === result.assignmentId)) {
      throw new ReviewCoordinatorError(`duplicate review result assignment id: ${result.assignmentId}`);
    }
    const assignment = this.assignments.find((candidate) => candidate.assignmentId === result.assignmentId);
    if (!assignment) throw new ReviewCoordinatorError('review result has no matching assignment');
    assertReviewResultMatchesAssignment(assignment, result);
    this.results.push(result);
  }

  listReviewAssignments(): readonly ReviewAssignment[] {
    return this.assignments.map((assignment) => ({ ...assignment }));
  }

  listReviewResults(): readonly ReviewResult[] {
    return this.results.map((result) => ({ ...result }));
  }
}

function resultEvidence(result: WorkResult): readonly EvidenceRef[] {
  assertEvidence(result.evidenceRefs, 'work result');
  return [...result.evidenceRefs];
}

function terminalFailureDecision(
  result: WorkResult,
  orchestrationManagerId: string,
): ReviewDecision | null {
  switch (result.status) {
    case 'failed':
      return {
        status: 'failed',
        ownerId: orchestrationManagerId,
        evidenceRefs: resultEvidence(result),
        nextAction: { kind: 'stop', ref: result.failureRef ?? 'failed' },
      };
    case 'incomplete':
      return {
        status: 'incomplete',
        ownerId: orchestrationManagerId,
        evidenceRefs: resultEvidence(result),
        nextAction: { kind: 'remediate', ref: `incomplete:${result.assignmentId}` },
      };
    case 'blocked':
      return {
        status: 'blocked',
        ownerId: orchestrationManagerId,
        evidenceRefs: resultEvidence(result),
        nextAction: { kind: 'remediate', ref: result.failureRef ?? `blocked:${result.assignmentId}` },
      };
    case 'cancelled':
      return {
        status: 'cancelled',
        ownerId: orchestrationManagerId,
        evidenceRefs: resultEvidence(result),
        nextAction: { kind: 'stop', ref: `cancelled:${result.assignmentId}` },
      };
    default:
      return null;
  }
}

function allReviewResultsPassed(
  reviews: readonly ReviewResult[],
): boolean {
  return reviews.length > 0 && reviews.every((result) => result.status === 'passed');
}

function sameUniqueValues(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  if (leftSet.size !== rightSet.size) return false;
  return [...right].every((value) => leftSet.has(value));
}

function assertReviewAssignmentsMatchWorker(
  assignments: readonly ReviewAssignment[],
  workerAssignment: WorkAssignment,
  workerResult: WorkResult,
): void {
  assertUniqueRefs(workerAssignment.targetRefs, 'worker assignment target ref');
  for (const assignment of assignments) {
    if (assignment.assignmentId !== `${workerAssignment.assignmentId}:review:${assignment.reviewKind}`) {
      throw new ReviewCoordinatorError('review assignment is not bound to the current worker assignment');
    }
    if (assignment.taskId !== workerAssignment.taskId.value) {
      throw new ReviewCoordinatorError('review assignment task does not match worker assignment');
    }
    if (assignment.attempt !== workerAssignment.attempt) {
      throw new ReviewCoordinatorError('review assignment attempt does not match worker assignment');
    }
    if (assignment.executionEpoch !== workerAssignment.executionEpoch) {
      throw new ReviewCoordinatorError('review assignment epoch does not match worker assignment');
    }
    if (assignment.inputRevision !== workerAssignment.inputRevision) {
      throw new ReviewCoordinatorError('review assignment input revision does not match worker assignment');
    }
    if (assignment.acceptanceCriteriaDigest !== workerAssignment.acceptanceCriteriaDigest) {
      throw new ReviewCoordinatorError('review assignment acceptance criteria does not match worker assignment');
    }
    if (assignment.workerAgentId !== workerResult.agentId) {
      throw new ReviewCoordinatorError('review assignment worker does not match worker result');
    }
    if (!sameUniqueValues(assignment.subjectRefs, workerAssignment.targetRefs)) {
      throw new ReviewCoordinatorError('review assignment subject refs do not match worker assignment target refs');
    }
  }
}

function buildRemediation(
  orchestrationManagerId: string,
  assignment: ReviewAssignment,
  result: ReviewResult,
): ReviewDecision {
  const findings = result.findings.filter(hasRemediationSeverity);
  const requiredCapabilities = assignment.workerCapabilities.filter(
    (capability) => !isReviewCapability(capability),
  );
  assertNoReviewCapabilities(requiredCapabilities, 'remediation worker capabilities');
  const excludedReviewCapabilities = assignment.workerCapabilities.filter(isReviewCapability);
  return {
    status: 'remediation',
    ownerId: orchestrationManagerId,
    evidenceRefs: [...result.evidenceRefs],
    nextAction: { kind: 'remediate', ref: `review:${result.resultId}` },
    remediation: {
      ownerId: orchestrationManagerId,
      sourceReviewAssignmentId: assignment.assignmentId,
      sourceReviewResultId: result.resultId,
      findingIds: findings.map((finding) => finding.findingId),
      requiredCapabilities,
      excludedReviewCapabilities,
      evidenceRefs: [...result.evidenceRefs],
    },
  };
}

export function decideReviewGate(input: ReviewGateInput): ReviewDecision {
  validateWorkResult(input.workerResult, input.workerAssignment);
  nonEmpty(input.orchestrationManagerId, 'orchestration manager id');

  const terminal = terminalFailureDecision(input.workerResult, input.orchestrationManagerId);
  if (terminal) return terminal;

  if (input.workerResult.nextAction === 'wait') {
    if (!input.workerResult.conditionRef) {
      throw new ReviewCoordinatorError('waiting requires conditionRef');
    }
    return {
      status: 'waiting',
      ownerId: input.orchestrationManagerId,
      evidenceRefs: resultEvidence(input.workerResult),
      nextAction: { kind: 'wait', ref: input.workerResult.conditionRef },
    };
  }

  const assignments = input.reviewAssignments ?? [];
  const results = input.reviewResults ?? [];
  assertReviewAssignmentsMatchWorker(assignments, input.workerAssignment, input.workerResult);
  assertCompleteReviewResults(assignments, results);

  const reviewRequired =
    input.workerResult.nextAction === 'review' ||
    assignments.length > 0;

  if (reviewRequired && assignments.length === 0) {
    return {
      status: 'waiting',
      ownerId: input.orchestrationManagerId,
      evidenceRefs: resultEvidence(input.workerResult),
      nextAction: { kind: 'review', ref: `review:${input.workerResult.assignmentId}` },
    };
  }

  if (reviewRequired && !allReviewResultsPassed(results)) {
    for (const result of results) {
      if (result.status === 'failed') {
        const assignment = assignments.find((candidate) => candidate.assignmentId === result.assignmentId);
        if (assignment) return buildRemediation(input.orchestrationManagerId, assignment, result);
      }
    }
    return {
      status: 'waiting',
      ownerId: input.orchestrationManagerId,
      evidenceRefs: resultEvidence(input.workerResult),
      nextAction: { kind: 'review', ref: `review:${input.workerResult.assignmentId}` },
    };
  }

  if (input.workerAssignment.mergeGate === 'required') {
    const mergeEvidence = input.mergeEvidenceRefs ?? [];
    if (mergeEvidence.length === 0) {
      return {
        status: 'waiting',
        ownerId: input.orchestrationManagerId,
        evidenceRefs: resultEvidence(input.workerResult),
        nextAction: { kind: 'wait', ref: `merge:${input.workerResult.assignmentId}` },
      };
    }
    assertEvidence(mergeEvidence, 'merge');
  }

  return {
    status: 'succeeded',
    ownerId: input.orchestrationManagerId,
    evidenceRefs: [
      ...resultEvidence(input.workerResult),
      ...results.flatMap((result) => result.evidenceRefs),
      ...(input.mergeEvidenceRefs ?? []),
    ],
    nextAction: { kind: 'settle', ref: input.workerResult.assignmentId },
  };
}
