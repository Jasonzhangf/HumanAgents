import { id, type EvidenceRef, type ScopeRef } from '../../contracts/src/index.js';
import type { WorkResult } from '../../contracts/src/index.js';
import type { ReviewResult } from '../../runtime/src/review/index.js';
import type {
  ExecutionAgentPort,
  MergeCoordinatorPort,
  ReviewAgentPort,
} from '../../runtime/src/orchestration/index.js';

export interface ServeOrchestrationPorts {
  readonly executionAgent: ExecutionAgentPort;
  readonly reviewAgent: ReviewAgentPort;
  readonly mergeCoordinator: MergeCoordinatorPort;
}

function evidence(scope: ScopeRef, label: string): EvidenceRef {
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '-');
  return {
    evidenceId: id('evidence', `serve-${safeLabel}`),
    kind: 'operation',
    source: 'humanagent.serve.orchestration',
    locator: `serve/orchestration/${safeLabel}`,
    scope,
  };
}

function outputDigests(input: Parameters<ExecutionAgentPort['execute']>[0]): readonly string[] {
  return input.assignment.expectedArtifactDigests
    ? [...input.assignment.expectedArtifactDigests]
    : input.assignment.targetRefs.map((target) => `sha256:${target}`);
}

/**
 * Deterministic ports used by `serve --mode fake`.
 *
 * They exercise the real M3 manager, review gate, feedback hub, and merge
 * boundary. They do not pretend to be a provider or a production worker.
 */
export function createDeterministicServeOrchestrationPorts(): ServeOrchestrationPorts {
  const executionAgent: ExecutionAgentPort = {
    async execute(input): Promise<WorkResult> {
      const refs = [evidence(input.scope, `work-${input.assignment.assignmentId}`)];
      return {
        taskId: input.assignment.taskId,
        pipelineNodeId: input.assignment.pipelineNodeId,
        agentId: input.agentId,
        assignmentId: input.assignment.assignmentId,
        attempt: input.assignment.attempt,
        executionEpoch: input.assignment.executionEpoch,
        inputRevision: input.assignment.inputRevision,
        producedArtifactRefs: [...input.assignment.expectedOutputRefs],
        producedArtifactDigests: [...outputDigests(input)],
        status: 'succeeded',
        summary: `fake worker completed ${input.assignment.objective}`,
        outputRefs: [...input.assignment.expectedOutputRefs],
        evidenceRefs: refs,
        nextAction: 'review',
      };
    },
  };

  const reviewAgent: ReviewAgentPort = {
    async review(input): Promise<ReviewResult> {
      return {
        resultId: `serve-review-${input.reviewAssignment.assignmentId}`,
        assignmentId: input.reviewAssignment.assignmentId,
        taskId: input.reviewAssignment.taskId,
        workerAgentId: input.reviewAssignment.workerAgentId,
        reviewKind: input.reviewAssignment.reviewKind,
        attempt: input.reviewAssignment.attempt,
        executionEpoch: input.reviewAssignment.executionEpoch,
        inputRevision: input.reviewAssignment.inputRevision,
        acceptanceCriteriaDigest: input.reviewAssignment.acceptanceCriteriaDigest,
        subjectRefs: [...input.reviewAssignment.subjectRefs],
        subjectDigests: [...input.reviewAssignment.subjectDigests],
        status: 'passed',
        findings: [],
        evidenceRefs: [evidence(input.scope, `review-${input.reviewAssignment.assignmentId}`)],
      };
    },
  };

  const mergeCoordinator: MergeCoordinatorPort = {
    async merge(input) {
      return {
        status: 'merged',
        evidenceRefs: [evidence(input.scope, `merge-${input.workerAssignment.assignmentId}`)],
      };
    },
  };

  return { executionAgent, reviewAgent, mergeCoordinator };
}
