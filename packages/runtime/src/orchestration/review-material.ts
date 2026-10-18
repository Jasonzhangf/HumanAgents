import type { EvidenceRef, WorkAssignment, WorkResult } from '../../../contracts/src/index.js';

/**
 * One produced subject body handed to the reviewer with its declared ref.
 */
export interface ReviewSubjectMaterial {
  readonly ref: string;
  readonly body: string;
}

export interface ExecutorReviewEvidence {
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * Review input content. The reviewer evaluates this material; a digest or an
 * evidence locator is never a substitute for the artifact itself.
 */
export interface ReviewMaterial {
  readonly acceptanceCriteria: string;
  readonly subjects: readonly ReviewSubjectMaterial[];
  readonly executorEvidence?: readonly ExecutorReviewEvidence[];
}

export interface ReviewMaterialRequest {
  readonly workerAssignment: WorkAssignment;
  readonly workerResult: WorkResult;
  readonly subjects: readonly { readonly ref: string; readonly body: string }[];
  readonly executorEvidence?: readonly ExecutorReviewEvidence[];
}

/**
 * The fields that define one assignment's canonical acceptance criteria. A
 * WorkAssignment satisfies this shape structurally.
 */
export interface AcceptanceCriteriaSource {
  readonly objective: string;
  readonly successCriteria: readonly string[];
  readonly failureCriteria: readonly string[];
  readonly incompleteCriteria: readonly string[];
}

/**
 * Canonical acceptance criteria content for one assignment. The content is
 * derived from the assignment's declared criteria, so it is reproducible on
 * any owner that already holds the assignment.
 */
export function acceptanceCriteriaContent(assignment: AcceptanceCriteriaSource): string {
  return JSON.stringify({
    objective: assignment.objective,
    successCriteria: [...assignment.successCriteria],
    failureCriteria: [...assignment.failureCriteria],
    incompleteCriteria: [...assignment.incompleteCriteria],
  });
}

/**
 * Assemble and verify the review material before any reviewer is invoked.
 * Missing or empty material throws instead of silently degrading into an
 * identity-only review.
 */
export function resolveReviewMaterial(input: ReviewMaterialRequest): ReviewMaterial {
  const { workerAssignment, workerResult } = input;
  const result = workerResult as WorkResult & { readonly executorEvidence?: readonly ExecutorReviewEvidence[] };
  const acceptanceCriteria = acceptanceCriteriaContent(workerAssignment);
  if (!acceptanceCriteria.trim()) {
    throw new Error('review acceptance criteria content is empty');
  }
  if (input.subjects.length !== workerAssignment.targetRefs.length) {
    throw new Error('review subjects must cover every assignment target ref');
  }
  const subjects = input.subjects.map((subject, index) => {
    const expectedRef = workerAssignment.targetRefs[index];
    if (expectedRef === undefined || subject.ref !== expectedRef) {
      throw new Error('review subject refs must match assignment target refs in order');
    }
    if (!subject.body.trim()) {
      throw new Error(`review subject body is empty for ${subject.ref}`);
    }
    const carriedBody = workerResult.producedArtifactBodies?.[index];
    if (carriedBody !== undefined && carriedBody !== subject.body) {
      throw new Error('review subject body must match the produced artifact body');
    }
    return { ref: subject.ref, body: subject.body };
  });
  return {
    acceptanceCriteria,
    subjects,
    executorEvidence: [
      ...(input.executorEvidence ?? result.executorEvidence ?? []),
    ],
  };
}

/**
 * Reviewer-side gate. The reviewer re-verifies the material it was handed so a
 * drifted prompt cannot silently become an identity-only review.
 */
export function assertReviewMaterial(material: ReviewMaterial | undefined): ReviewMaterial {
  if (material === undefined) {
    throw new Error('review request carries no review material');
  }
  if (!material.acceptanceCriteria.trim()) {
    throw new Error('review request carries empty acceptance criteria content');
  }
  if (material.subjects.length === 0) {
    throw new Error('review request carries no subject bodies');
  }
  const refs = new Set<string>();
  for (const subject of material.subjects) {
    if (!subject.ref.trim()) throw new Error('review request carries an empty subject ref');
    if (refs.has(subject.ref)) throw new Error(`review request carries a duplicate subject ref for ${subject.ref}`);
    refs.add(subject.ref);
    if (!subject.body.trim()) throw new Error(`review request carries an empty subject body for ${subject.ref}`);
  }
  return material;
}
