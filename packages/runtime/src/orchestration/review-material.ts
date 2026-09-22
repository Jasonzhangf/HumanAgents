import { createHash } from 'node:crypto';
import type { WorkAssignment, WorkResult } from '../../../contracts/src/index.js';

/**
 * One produced subject body handed to the reviewer with the ref and digest the
 * orchestration assignment already declared.
 */
export interface ReviewSubjectMaterial {
  readonly ref: string;
  readonly body: string;
  readonly digest: string;
}

/**
 * Review input content. The reviewer evaluates this material; a digest or an
 * evidence locator is never a substitute for the artifact itself.
 */
export interface ReviewMaterial {
  readonly acceptanceCriteria: string;
  readonly acceptanceCriteriaDigest: string;
  readonly subjects: readonly ReviewSubjectMaterial[];
}

export interface ReviewMaterialRequest {
  readonly workerAssignment: WorkAssignment;
  readonly workerResult: WorkResult;
  readonly subjects: readonly { readonly ref: string; readonly body: string }[];
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

export function digestOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
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
 * Missing, empty, or digest-drifted material throws instead of silently
 * degrading into an identity-only review.
 */
export function resolveReviewMaterial(input: ReviewMaterialRequest): ReviewMaterial {
  const { workerAssignment, workerResult } = input;
  const acceptanceCriteria = acceptanceCriteriaContent(workerAssignment);
  if (!acceptanceCriteria.trim()) {
    throw new Error('review acceptance criteria content is empty');
  }
  if (digestOf(acceptanceCriteria) !== workerAssignment.acceptanceCriteriaDigest) {
    throw new Error('review acceptance criteria content does not match acceptanceCriteriaDigest');
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
    const digest = digestOf(subject.body);
    const produced = workerResult.producedArtifactDigests[index];
    if (produced === undefined || produced !== digest) {
      throw new Error('review subject body digest must match the produced artifact digest');
    }
    const carriedBody = workerResult.producedArtifactBodies?.[index];
    if (carriedBody !== undefined && carriedBody !== subject.body) {
      throw new Error('review subject body must match the produced artifact body');
    }
    return { ref: subject.ref, body: subject.body, digest };
  });
  return {
    acceptanceCriteria,
    acceptanceCriteriaDigest: workerAssignment.acceptanceCriteriaDigest,
    subjects,
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
  if (digestOf(material.acceptanceCriteria) !== material.acceptanceCriteriaDigest) {
    throw new Error('review request acceptance criteria content does not match its digest');
  }
  if (material.subjects.length === 0) {
    throw new Error('review request carries no subject bodies');
  }
  for (const subject of material.subjects) {
    if (!subject.body.trim()) throw new Error(`review request carries an empty subject body for ${subject.ref}`);
    if (digestOf(subject.body) !== subject.digest) {
      throw new Error(`review subject body does not match its digest for ${subject.ref}`);
    }
  }
  return material;
}
