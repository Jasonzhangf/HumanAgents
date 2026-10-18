import { ProviderAgentDriver } from '../../adapters/provider/src/index.js';
import type { AgentRole } from '../../config/src/index.js';
import { closeAgentProvider, type AgentProviderComposition } from './agent-driver-composition.js';
import {
  id,
  type AgentEvent,
  type EvidenceRef,
  type ReviewOutput,
  type ExecutionRuntimePort,
  type ProviderBinding,
  type ProviderSettlement,
  type ScopeRef,
  type WorkResult,
} from '../../contracts/src/index.js';
import type { ReviewResult } from '../../runtime/src/review/index.js';
import { assertReviewMaterial } from '../../runtime/src/orchestration/index.js';
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
  readonly prepareAgentProvider?: (input: {
    readonly roleId: AgentRole;
    readonly configuredAgentId?: string;
  }) => Promise<AgentProviderComposition>;
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

/**
 * Deterministic ports used by `serve --mode fake`.
 *
 * They exercise the real M3 manager, review gate, feedback hub, and merge
 * boundary. They do not pretend to be a provider or a production worker.
 */
export function createDeterministicServeOrchestrationPorts(): ServeOrchestrationPorts {
  const execute = async (input: Parameters<ExecutionAgentPort['execute']>[0]): Promise<WorkResult> => {
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
      status: 'succeeded',
      summary: `fake worker completed ${input.assignment.objective}`,
      outputRefs: [...input.assignment.expectedOutputRefs],
      evidenceRefs: refs,
      nextAction: 'review',
    };
  };
  const review = async (input: Parameters<ReviewAgentPort['review']>[0]): Promise<ReviewResult> => ({
    resultId: `serve-review-${input.reviewAssignment.assignmentId}`,
    assignmentId: input.reviewAssignment.assignmentId,
    taskId: input.reviewAssignment.taskId,
    workerAgentId: input.reviewAssignment.workerAgentId,
    reviewKind: input.reviewAssignment.reviewKind,
    attempt: input.reviewAssignment.attempt,
    executionEpoch: input.reviewAssignment.executionEpoch,
    inputRevision: input.reviewAssignment.inputRevision,
    subjectRefs: [...input.reviewAssignment.subjectRefs],
    status: 'passed',
    findings: [],
    evidenceRefs: [evidence(input.scope, `review-${input.reviewAssignment.assignmentId}`)],
  });

  const executionAgent: ExecutionAgentPort = {
    roleId: 'serve-fake-execution',
    createInstance: (create) => ({
      incarnation: create.incarnation,
      execute,
      dispose: async () => {},
    }),
    execute,
  };

  const reviewAgent: ReviewAgentPort = {
    roleId: 'serve-fake-review',
    createInstance: (create) => ({
      incarnation: create.incarnation,
      review: async (input) => ({
        result: await review(input),
        output: { text: `fake review ${input.reviewAssignment.assignmentId}`, artifactRef: null, artifactDigest: null },
        completedAt: new Date().toISOString(),
      }),
      dispose: async () => {},
    }),
    review,
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

/**
 * Provider output arrives as a stream of chunk summaries. The review text is
 * their ordered concatenation: a verdict marker or an explanation may straddle
 * a chunk boundary, so no single chunk is the reviewer's reply.
 */
function reviewerText(events: readonly AgentEvent[]): string {
  return events.map((event) => event.summary ?? '').join('');
}

function eventSummary(events: readonly AgentEvent[], fallback: string): string {
  const text = reviewerText(events);
  return text.trim().length > 0 ? text : fallback;
}

function providerPrompt(
  role: 'review',
  segments: readonly string[],
  body: string,
): string {
  if (segments.length === 0) {
    throw new Error(`missing ${role} agent prompt segments`);
  }
  return [...segments, body].join('\n\n');
}

async function runProviderAgent(input: {
  readonly role: 'review';
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
    if (driver.hasAcquiredExecution()) {
      try {
        await driver.settle({ runtimeId, executionEpoch: input.executionEpoch });
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          `provider ${input.role} failed and settlement also failed: ${error instanceof Error ? error.message : String(error)}`,
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
  const markers = [...reviewerText(events).matchAll(/HUMANAGENT_REVIEW\s*:\s*(passed|failed|inconclusive)/gi)].map((match) => match[1].toLowerCase() as 'passed' | 'failed' | 'inconclusive');
  if (markers.length === 0) return undefined;
  return markers[markers.length - 1];
}

/**
 * A real reviewer can drop the required terminal marker, or return an explicit
 * `inconclusive` verdict, even when its provider call succeeded. Retrying that
 * real call a bounded number of times keeps a non-terminal reply from
 * permanently wedging the Harness review gate. An explicit `passed` or
 * `failed` verdict is honored immediately, so the gate is never steered toward
 * a pass.
 */
const REVIEW_ATTEMPTS = 3;

/**
 * RCC-backed agent ports. Provider output is evidence; only the provider
 * terminal state and an explicit review marker can advance the Harness gate.
 * Merge remains Harness-owned and never becomes a model tool call.
 */
export function createRccServeOrchestrationPorts(input: ProviderServeOrchestrationOptions): ServeOrchestrationPorts {
  const runReview = async (request: Parameters<ReviewAgentPort['review']>[0]): Promise<{
    readonly result: ReviewResult;
    readonly output: ReviewOutput;
  }> => {
      // Fail closed before the reviewer runs: a request without real
      // acceptance criteria and subject bodies could only check identity.
      const material = assertReviewMaterial(request.reviewMaterial);
      const prompt = providerPrompt(
        'review',
        input.promptSegments.review,
        JSON.stringify({
          role: 'review',
          reviewKind: request.reviewAssignment.reviewKind,
          acceptanceCriteria: material.acceptanceCriteria,
          subjects: material.subjects,
          executorEvidence: material.executorEvidence ?? [],
          instruction: 'Evaluate the acceptance criteria against each subject body below, using the provided executorEvidence as first-hand execution evidence to verify the subject bodies. A subject body is the artifact under review; a summary, ref, or digest is never a substitute for it. Judge only from the provided review material; do not require filesystem access or evidence outside this material. End on the final line with exactly HUMANAGENT_REVIEW: passed, failed, or inconclusive',
        }),
      );
      let provider!: Awaited<ReturnType<typeof runProviderAgent>>;
      let marker: ReturnType<typeof reviewMarker>;
      for (let attemptIndex = 0; attemptIndex < REVIEW_ATTEMPTS; attemptIndex += 1) {
        const composition = input.prepareAgentProvider === undefined
          ? undefined
          : await input.prepareAgentProvider({ roleId: 'review' });
        try {
          provider = await runProviderAgent({
            role: 'review',
            port: composition?.port ?? input.port,
            binding: composition?.binding ?? input.binding,
            taskId: id('task', request.reviewAssignment.taskId),
            assignmentId: request.reviewAssignment.assignmentId,
            attempt: request.reviewAssignment.attempt + attemptIndex,
            executionEpoch: request.reviewAssignment.executionEpoch,
            scope: request.scope,
            inputRefs: request.reviewAssignment.subjectRefs,
            prompt,
          });
        } catch (error) {
          if (composition !== undefined) {
            try {
              await closeAgentProvider(composition);
            } catch (closeError) {
              throw new AggregateError([error, closeError], 'provider review failed and close also failed');
            }
          }
          throw error;
        }
        if (composition !== undefined) await closeAgentProvider(composition);
        marker = provider.settlement.state === 'succeeded' ? reviewMarker(provider.events) : undefined;
        if (marker === 'passed' || marker === 'failed' || provider.settlement.state !== 'succeeded') break;
      }
      const evidenceRefs = uniqueEvidence(provider.events, provider.settlement, request.scope);
      const providerFailed = provider.settlement.state !== 'succeeded'
        && (provider.settlement.state === 'failed' || provider.settlement.state === 'unknown');
      const exhaustedInconclusive = provider.settlement.state === 'succeeded'
        && marker !== 'passed'
        && marker !== 'failed';
      const status: ReviewResult['status'] = providerFailed || marker === 'failed'
        ? 'failed'
        : provider.settlement.state === 'succeeded' && marker === 'passed'
          ? 'passed'
          : 'inconclusive';
      const findings = status !== 'passed'
        ? [{
            findingId: `finding-${request.reviewAssignment.assignmentId}`,
            severity: 'important' as const,
            locationRef: request.reviewAssignment.subjectRefs[0] ?? 'review://subject',
            problem: eventSummary(
              provider.events,
              status === 'failed'
                ? providerFailed
                  ? 'provider review failed'
                  : marker === 'failed'
                    ? 'provider review returned an explicit failed verdict'
                    : 'review remained inconclusive after the bounded re-review attempts; escalate or re-review with additional evidence'
                : 'provider review remained inconclusive after the bounded re-review attempts',
            ),
            expected: providerFailed
              ? 'provider review must settle successfully and return a terminal HUMANAGENT_REVIEW verdict'
              : 'review must return a terminal HUMANAGENT_REVIEW passed or failed verdict within the bounded re-review attempts; a bounded recover/re-review consumer must own the inconclusive result',
            evidenceRefs,
          }]
        : [];
      return {
        result: {
          resultId: `serve-review-${request.reviewAssignment.assignmentId}`,
          assignmentId: request.reviewAssignment.assignmentId,
          taskId: request.reviewAssignment.taskId,
          workerAgentId: request.reviewAssignment.workerAgentId,
          reviewKind: request.reviewAssignment.reviewKind,
          attempt: request.reviewAssignment.attempt,
          executionEpoch: request.reviewAssignment.executionEpoch,
          inputRevision: request.reviewAssignment.inputRevision,
          subjectRefs: [...request.reviewAssignment.subjectRefs],
          status,
          findings,
          evidenceRefs,
        },
        output: {
          text: reviewerText(provider.events),
          artifactRef: null,
          artifactDigest: null,
        },
      };
  };
  const review = async (request: Parameters<ReviewAgentPort['review']>[0]): Promise<ReviewResult> =>
    (await runReview(request)).result;
  const reviewAgent: ReviewAgentPort = {
    roleId: 'serve-rcc-review',
    createInstance: (create) => ({
      incarnation: create.incarnation,
      review: async (handleInput) => {
        const { result, output } = await runReview(handleInput);
        return { result, output, completedAt: new Date().toISOString() };
      },
      dispose: async () => {},
    }),
    review,
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
