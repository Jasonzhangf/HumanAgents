import { ProviderAgentDriver } from '../../adapters/provider/src/index.js';
import {
  id,
  type AgentEvent,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderSettlement,
  type ScopeRef,
  type WorkResult,
} from '../../contracts/src/index.js';
import type { ReviewResult } from '../../runtime/src/review/index.js';
import type {
  ExecutionAgentPort,
  MergeCoordinatorPort,
  ReviewAgentPort,
} from '../../runtime/src/orchestration/index.js';

export interface ServeOrchestrationPorts {
  readonly executionAgent?: ExecutionAgentPort;
  readonly reviewAgent: ReviewAgentPort;
  readonly mergeCoordinator: MergeCoordinatorPort;
}

export interface ProviderServeOrchestrationOptions {
  readonly port: ExecutionRuntimePort;
  readonly binding: ProviderBinding;
  readonly promptSegments: { readonly review: readonly string[] };
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

function scopedEvidence(scope: ScopeRef, label: string): EvidenceRef {
  return evidence(scope, `provider-${label}`);
}

function executionRef(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '-');
  return safe.length > 80 ? safe.slice(0, 80) : safe;
}

function uniqueEvidence(events: readonly AgentEvent[], settlement: ProviderSettlement, scope: ScopeRef): readonly EvidenceRef[] {
  const refs = [...events.flatMap((event) => event.evidenceRefs), ...settlement.evidenceRefs].map((ref) => {
    if (ref.scope.operationId === undefined || ref.scope.operationId.value === scope.operationId?.value) return ref;
    return {
      ...ref,
      evidenceId: id('evidence', `serve-projection-${executionRef(ref.evidenceId.value)}`),
      locator: `${ref.locator}/operation/${executionRef(ref.scope.operationId.value)}`,
      scope,
    };
  });
  const seen = new Set<string>();
  const unique = refs.filter((ref) => {
    if (seen.has(ref.evidenceId.value)) return false;
    seen.add(ref.evidenceId.value);
    return true;
  });
  return unique.length > 0 ? unique : [scopedEvidence(scope, 'no-provider-evidence')];
}

function eventSummary(events: readonly AgentEvent[], fallback: string): string {
  const summaries = events.map((event) => event.summary).filter((summary): summary is string => Boolean(summary?.trim()));
  return summaries.at(-1) ?? fallback;
}

function providerPrompt(
  role: 'execution' | 'review',
  segments: readonly string[],
  body: string,
): string {
  if (segments.length === 0) {
    throw new Error(`missing ${role} agent prompt segments`);
  }
  return [...segments, body].join('\n\n');
}

async function runProviderAgent(input: {
  readonly role: 'execution' | 'review';
  readonly port: ExecutionRuntimePort;
  readonly binding: ProviderBinding;
  readonly taskId: Parameters<ExecutionAgentPort['execute']>[0]['assignment']['taskId'];
  readonly assignmentId: string;
  readonly attempt: number;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly prompt: string;
}): Promise<{ readonly events: readonly AgentEvent[]; readonly settlement: ProviderSettlement }> {
  const runtimeId = `serve-${input.role}-${executionRef(input.assignmentId)}-${input.attempt}-${input.executionEpoch}`;
  const operationId = id('operation', `serve-${input.role}-${executionRef(input.assignmentId)}-${input.attempt}`);
  const driver = new ProviderAgentDriver({
    port: input.port,
    binding: input.binding,
    runtimeId,
    taskId: input.taskId,
    operationId,
    executionEpoch: input.executionEpoch,
    assignmentId: input.assignmentId,
    scope: { ...input.scope, operationId },
    inputRefs: [...input.inputRefs, input.prompt],
    ownerId: 'humanagent.app.serve-orchestration',
  });
  let started = false;
  const events: AgentEvent[] = [];
  try {
    await driver.start({
      runtimeId,
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      organId: input.scope.organId,
      ...(input.scope.cycleId === undefined ? {} : { cycleId: input.scope.cycleId }),
      operationId,
    });
    started = true;
    await driver.submit({
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: { prompt: input.prompt },
    });
    for await (const event of driver.observe({ runtimeId })) {
      events.push(event);
      if (event.terminalState !== undefined) break;
    }
  } catch (error) {
    if (started) {
      try {
        await driver.settle({ runtimeId, executionEpoch: input.executionEpoch });
      } catch (settlementError) {
        throw new Error(
          `provider ${input.role} failed and settlement also failed: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
  await driver.settle({ runtimeId, executionEpoch: input.executionEpoch });
  const settlement = driver.settlement();
  if (!settlement) throw new Error(`provider ${input.role} did not expose settlement`);
  return { events, settlement };
}

function reviewMarker(events: readonly AgentEvent[]): 'passed' | 'failed' | 'inconclusive' | undefined {
  const markers = events.flatMap((event) => [...(event.summary ?? '').matchAll(/HUMANAGENT_REVIEW\s*:\s*(passed|failed|inconclusive)/gi)].map((match) => match[1].toLowerCase() as 'passed' | 'failed' | 'inconclusive'));
  if (markers.length === 0 || new Set(markers).size > 1) return undefined;
  return markers[markers.length - 1];
}

/**
 * RCC-backed agent ports. Provider output is evidence; only the provider
 * terminal state and an explicit review marker can advance the Harness gate.
 * Merge remains Harness-owned and never becomes a model tool call.
 */
export function createRccServeOrchestrationPorts(input: ProviderServeOrchestrationOptions): ServeOrchestrationPorts {
  const reviewAgent: ReviewAgentPort = {
    async review(request): Promise<ReviewResult> {
      const prompt = providerPrompt(
        'review',
        input.promptSegments.review,
        JSON.stringify({
          role: 'review',
          reviewKind: request.reviewAssignment.reviewKind,
          acceptanceCriteriaDigest: request.reviewAssignment.acceptanceCriteriaDigest,
          subjectRefs: request.reviewAssignment.subjectRefs,
          subjectDigests: request.reviewAssignment.subjectDigests,
          workerResult: request.workerResult,
          instruction: 'end with HUMANAGENT_REVIEW: passed, failed, or inconclusive',
        }),
      );
      const provider = await runProviderAgent({
        role: 'review',
        port: input.port,
        binding: input.binding,
        taskId: id('task', request.reviewAssignment.taskId),
        assignmentId: request.reviewAssignment.assignmentId,
        attempt: request.reviewAssignment.attempt,
        executionEpoch: request.reviewAssignment.executionEpoch,
        scope: request.scope,
        inputRefs: request.reviewAssignment.subjectRefs,
        prompt,
      });
      const evidenceRefs = uniqueEvidence(provider.events, provider.settlement, request.scope);
      const marker = reviewMarker(provider.events);
      const status: ReviewResult['status'] = provider.settlement.state !== 'succeeded'
        ? provider.settlement.state === 'failed' || provider.settlement.state === 'unknown' ? 'failed' : 'inconclusive'
        : marker ?? 'inconclusive';
      const findings = status === 'failed'
        ? [{
            findingId: `finding-${request.reviewAssignment.assignmentId}`,
            severity: 'important' as const,
            locationRef: request.reviewAssignment.subjectRefs[0] ?? 'review://subject',
            problem: eventSummary(provider.events, 'provider review failed'),
            expected: 'review must pass the assigned acceptance criteria',
            evidenceRefs,
          }]
        : [];
      return {
        resultId: `serve-review-${request.reviewAssignment.assignmentId}`,
        assignmentId: request.reviewAssignment.assignmentId,
        taskId: request.reviewAssignment.taskId,
        workerAgentId: request.reviewAssignment.workerAgentId,
        reviewKind: request.reviewAssignment.reviewKind,
        attempt: request.reviewAssignment.attempt,
        executionEpoch: request.reviewAssignment.executionEpoch,
        inputRevision: request.reviewAssignment.inputRevision,
        acceptanceCriteriaDigest: request.reviewAssignment.acceptanceCriteriaDigest,
        subjectRefs: [...request.reviewAssignment.subjectRefs],
        subjectDigests: [...request.reviewAssignment.subjectDigests],
        status,
        findings,
        evidenceRefs,
      };
    },
  };

  const mergeCoordinator: MergeCoordinatorPort = {
    async merge(request) {
      const evidenceRefs = [
        ...request.workerResult.evidenceRefs,
        ...request.reviewResults.flatMap((review) => review.evidenceRefs),
      ];
      if (request.workerResult.status !== 'succeeded') {
        return {
          status: 'blocked',
          reason: 'Harness merge gate requires a succeeded worker result',
          nextAction: { kind: 'recover', ref: `merge.${request.workerAssignment.assignmentId}.worker` },
          evidenceRefs,
        };
      }
      if (request.reviewResults.length === 0 || request.reviewResults.some((review) => review.status !== 'passed')) {
        return {
          status: 'blocked',
          reason: 'Harness merge gate requires every review to pass',
          nextAction: { kind: 'recover', ref: `merge.${request.workerAssignment.assignmentId}.review` },
          evidenceRefs,
        };
      }
      return {
        status: 'merged',
        evidenceRefs: [...evidenceRefs, scopedEvidence(request.scope, `merge-${request.workerAssignment.assignmentId}`)],
      };
    },
  };
  return { reviewAgent, mergeCoordinator };
}
