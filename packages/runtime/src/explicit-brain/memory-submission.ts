import {
  type MemoryActorContext,
  type MemorySaveCandidateArguments,
  type MemorySubmission,
  type MemorySubmissionReceipt,
  type OperationId,
  validateMemorySubmission,
} from '../../../contracts/src/index.js';
import type { ExplicitBrainRuntimeBinding } from './tool-registry.js';

export interface ExplicitBrainMemoryRuntimeContext {
  readonly requestId: string;
  readonly operationId: OperationId;
  readonly projectKey: string;
  readonly actor: MemoryActorContext;
  readonly contentDigest: string;
  readonly observation: string;
  readonly taskId?: MemorySubmission['taskId'];
  readonly cycleId?: MemorySubmission['cycleId'];
}

export interface MemorySubmissionPort {
  submitCandidate(input: MemorySubmission): Promise<MemorySubmissionReceipt>;
}

/**
 * Converts the model-facing memory candidate tool arguments into the existing
 * MemoryCoordinator submission contract. Runtime-only identity is never read
 * from the model arguments.
 */
export function enrichMemorySaveCandidate(input: {
  readonly binding: ExplicitBrainRuntimeBinding;
  readonly intentArguments: MemorySaveCandidateArguments;
  readonly argumentsDigest: string;
  readonly context: ExplicitBrainMemoryRuntimeContext;
}): MemorySubmission {
  if (input.context.actor.projectKey !== input.context.projectKey) {
    throw new Error('memory actor project does not match runtime project');
  }
  const submission: MemorySubmission = {
    submissionId: input.intentArguments.submissionId,
    requestId: input.context.requestId,
    operationId: input.context.operationId,
    bindingRef: input.binding.bindingRef,
    actor: {
      ...input.context.actor,
      projectKey: input.context.projectKey,
    },
    projectKey: input.context.projectKey,
    taskId: input.context.taskId,
    cycleId: input.context.cycleId,
    requestedKind: input.intentArguments.requestedKind,
    candidateCategory: input.intentArguments.candidateCategory,
    contentRef: input.intentArguments.contentRef,
    contentDigest: input.context.contentDigest,
    evidenceRefs: [...input.intentArguments.evidenceRefs],
    observation: input.context.observation,
    desiredScope: input.intentArguments.desiredScope,
    reason: input.intentArguments.reason,
    inputDigest: input.argumentsDigest,
  };
  validateMemorySubmission(submission);
  return submission;
}

export async function submitMemorySaveCandidate(input: {
  readonly binding: ExplicitBrainRuntimeBinding;
  readonly intentArguments: MemorySaveCandidateArguments;
  readonly argumentsDigest: string;
  readonly context: ExplicitBrainMemoryRuntimeContext;
  readonly port: MemorySubmissionPort;
}): Promise<MemorySubmissionReceipt> {
  return input.port.submitCandidate(enrichMemorySaveCandidate(input));
}
