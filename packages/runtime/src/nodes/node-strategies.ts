import type {
  NodeClosure,
  NodeDispatchRequest,
  NodeDispatchResult,
  NodeOutcome,
  NodeStepResult,
} from './node-types.js';
import { assertNodeClosure, hasEvidenceIdentityConflict } from './node-types.js';
import { NodeDispatchError, requireReference, RuntimeError } from './errors.js';

export const NODE_STRATEGY_REFS = {
  serial: 'serial',
  parallelJoin: 'parallel-join',
  waitForCondition: 'wait-for-condition',
  reviewRemediation: 'review-remediation',
} as const;

export interface NodeStrategy {
  readonly policyRef: string;
  dispatch(input: NodeDispatchRequest): Promise<NodeDispatchResult>;
}

export class NodeStrategyRegistry {
  private readonly strategies = new Map<string, NodeStrategy>();

  register(strategy: NodeStrategy): void {
    requireReference(strategy.policyRef, 'node strategy policyRef');
    if (this.strategies.has(strategy.policyRef)) {
      throw new RuntimeError(`duplicate node strategy: ${strategy.policyRef}`);
    }
    this.strategies.set(strategy.policyRef, strategy);
  }

  has(policyRef: string): boolean {
    return this.strategies.has(policyRef);
  }

  refs(): readonly string[] {
    return [...this.strategies.keys()];
  }

  async dispatch(input: NodeDispatchRequest): Promise<NodeDispatchResult> {
    const strategy = this.strategies.get(input.policyRef);
    if (!strategy) throw new RuntimeError(`unknown node strategy: ${input.policyRef}`, { ownerRef: input.ownerRef });
    const result = await strategy.dispatch(input);
    try {
      assertNodeClosure(result.closure);
      if (result.closure.nodeId !== input.nodeId) throw new RuntimeError('node strategy returned a result for another node');
      if (hasEvidenceIdentityConflict(result.closure.evidenceRefs)) {
        const integrityFailure = new RuntimeError('conflicting evidence identity in node closure', {
          ownerRef: input.ownerRef,
          failureRef: `node-dispatch:${input.nodeId}:evidence-integrity`,
        });
        throw new NodeDispatchError(
          integrityFailure.message,
          { ownerRef: input.ownerRef, failureRef: integrityFailure.failureRef! },
          { outputRefs: result.closure.outputRefs, evidenceRefs: result.closure.evidenceRefs, cause: integrityFailure },
        );
      }
    } catch (cause) {
      if (cause instanceof NodeDispatchError) throw cause;
      throw new NodeDispatchError(
        cause instanceof Error ? cause.message : 'node strategy returned an invalid closure',
        { ownerRef: input.ownerRef, failureRef: `node-dispatch:${input.nodeId}:closure` },
        {
          outputRefs: result.closure.outputRefs,
          evidenceRefs: result.closure.evidenceRefs,
          cause,
        },
      );
    }
    return result;
  }
}

function closureForStep(
  input: NodeDispatchRequest,
  step: NodeStepResult,
  aggregate?: Pick<NodeClosure, 'outputRefs' | 'evidenceRefs'>,
): NodeClosure {
  const ownerRef = step.ownerRef ?? input.ownerRef;
  const conditionRef = step.conditionRef;
  const failureRef = step.failureRef;
  let nextAction = step.nextAction;

  if (!nextAction) {
    if (step.state === 'waiting') {
      requireReference(conditionRef, 'waiting step conditionRef');
      nextAction = { kind: 'wait', ref: conditionRef };
    } else if (step.state === 'blocked') {
      const ref = conditionRef ?? failureRef;
      requireReference(ref, 'blocked step conditionRef');
      nextAction = { kind: 'recover', ref };
    } else if (step.state === 'failed' || step.state === 'unknown') {
      const ref = failureRef ?? conditionRef;
      requireReference(ref, 'failed step recoveryRef');
      nextAction = { kind: 'recover', ref };
    } else if (step.state === 'cancelled' || step.state === 'stopped') {
      nextAction = { kind: 'stop', ref: step.state };
    } else {
      nextAction = { kind: 'continue', ref: 'checkpoint' };
    }
  }

  const closure: NodeClosure = {
    nodeId: input.nodeId,
    state: step.state,
    ownerRef,
    nextAction,
    conditionRef,
    failureRef,
    outputRefs: aggregate?.outputRefs ?? step.outputRefs,
    evidenceRefs: aggregate?.evidenceRefs ?? step.evidenceRefs,
  };
  assertNodeClosure(closure);
  return closure;
}

function succeededClosure(input: NodeDispatchRequest, outputRefs: readonly string[], evidenceRefs: NodeClosure['evidenceRefs']): NodeClosure {
  const closure: NodeClosure = {
    nodeId: input.nodeId,
    state: 'succeeded',
    ownerRef: input.ownerRef,
    nextAction: { kind: 'continue', ref: 'checkpoint' },
    outputRefs,
    evidenceRefs,
  };
  assertNodeClosure(closure);
  return closure;
}

function sameEvidence(left: NodeClosure['evidenceRefs'][number], right: NodeClosure['evidenceRefs'][number]): boolean {
  return left.evidenceId.value === right.evidenceId.value
    && left.kind === right.kind
    && left.source === right.source
    && left.locator === right.locator
    && left.digest === right.digest
    && left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId?.value === right.scope.taskId?.value
    && left.scope.cycleId?.value === right.scope.cycleId?.value
    && left.scope.operationId?.value === right.scope.operationId?.value;
}

const OUTCOME_PRIORITY: readonly NodeOutcome[] = ['failed', 'blocked', 'unknown', 'cancelled', 'stopped', 'waiting', 'succeeded'];

function blockingResult(input: NodeDispatchRequest, results: readonly NodeStepResult[]): NodeDispatchResult | undefined {
  for (const state of OUTCOME_PRIORITY) {
    const step = results.find((candidate) => candidate.state === state);
    if (step && state !== 'succeeded') {
      return {
        closure: closureForStep(input, step, {
          outputRefs: results.flatMap((result) => result.outputRefs),
          evidenceRefs: results.flatMap((result) => result.evidenceRefs),
        }),
      };
    }
  }
  return undefined;
}

function stepDispatchError(
  input: NodeDispatchRequest,
  stepId: string,
  cause: unknown,
  outputRefs: readonly string[],
  evidenceRefs: readonly NodeClosure['evidenceRefs'][number][],
): NodeDispatchError {
  const nested = cause instanceof NodeDispatchError ? cause : undefined;
  const mergedOutputRefs = [...new Set([...outputRefs, ...(nested?.outputRefs ?? [])])];
  const mergedEvidenceRefs: NodeClosure['evidenceRefs'][number][] = [];
  let evidenceConflict = false;
  for (const evidence of [...evidenceRefs, ...(nested?.evidenceRefs ?? [])]) {
    const existing = mergedEvidenceRefs.find((candidate) => candidate.evidenceId.value === evidence.evidenceId.value);
    if (!existing) {
      mergedEvidenceRefs.push(evidence);
    } else if (!sameEvidence(existing, evidence)) {
      evidenceConflict = true;
      mergedEvidenceRefs.push(evidence);
    }
  }
  const message = cause instanceof Error && cause.message ? `${cause.message} (step ${stepId})` : `node step failed: ${stepId}`;
  const integrityFailure = evidenceConflict
    ? new RuntimeError('conflicting evidence identity in nested node failure', {
        ownerRef: input.ownerRef,
        failureRef: `node-dispatch:${input.nodeId}:${stepId}:evidence-integrity`,
      })
    : undefined;
  return new NodeDispatchError(
    evidenceConflict ? `${message}; conflicting evidence identity` : message,
    { ownerRef: input.ownerRef, failureRef: integrityFailure?.failureRef ?? `node-dispatch:${input.nodeId}:${stepId}` },
    { outputRefs: mergedOutputRefs, evidenceRefs: mergedEvidenceRefs, cause: integrityFailure ? { original: cause, integrity: integrityFailure } : cause },
  );
}

export function serialNodeStrategy(): NodeStrategy {
  return {
    policyRef: NODE_STRATEGY_REFS.serial,
    async dispatch(input: NodeDispatchRequest): Promise<NodeDispatchResult> {
      if (input.plan.items.length === 0) throw new RuntimeError('serial node requires at least one dispatch item', { ownerRef: input.ownerRef });
      const outputRefs: string[] = [];
      const evidenceRefs: NodeClosure['evidenceRefs'][number][] = [];
      for (const item of input.plan.items) {
        let result: NodeStepResult;
        try {
          result = await item.execute();
        } catch (cause) {
          throw stepDispatchError(input, item.stepId, cause, outputRefs, evidenceRefs);
        }
        outputRefs.push(...result.outputRefs);
        evidenceRefs.push(...result.evidenceRefs);
        if (result.state !== 'succeeded') {
          try {
            return { closure: closureForStep(input, result, { outputRefs, evidenceRefs }) };
          } catch (cause) {
            throw stepDispatchError(input, item.stepId, cause, outputRefs, evidenceRefs);
          }
        }
      }
      try {
        return { closure: succeededClosure(input, outputRefs, evidenceRefs) };
      } catch (cause) {
        throw stepDispatchError(input, 'completion', cause, outputRefs, evidenceRefs);
      }
    },
  };
}

export function parallelJoinNodeStrategy(): NodeStrategy {
  return {
    policyRef: NODE_STRATEGY_REFS.parallelJoin,
    async dispatch(input: NodeDispatchRequest): Promise<NodeDispatchResult> {
      if (input.plan.items.length < 2) {
        throw new RuntimeError('parallel-join node requires at least two dispatch items', { ownerRef: input.ownerRef });
      }
      let firstFailure: unknown;
      let firstFailureStep: string | undefined;
      let hasFailure = false;
      const settled = await Promise.all(input.plan.items.map((item) =>
        Promise.resolve().then(() => item.execute()).then(
          (value): PromiseFulfilledResult<NodeStepResult> => ({ status: 'fulfilled', value }),
          (reason: unknown): PromiseRejectedResult => {
            if (!hasFailure) {
              hasFailure = true;
              firstFailure = reason;
              firstFailureStep = item.stepId;
            }
            return { status: 'rejected', reason };
          },
        ),
      ));
      if (hasFailure) {
        const completedOutputRefs: string[] = [];
        const completedEvidenceRefs: NodeClosure['evidenceRefs'][number][] = [];
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            completedOutputRefs.push(...result.value.outputRefs);
            completedEvidenceRefs.push(...result.value.evidenceRefs);
          } else if (result.reason instanceof NodeDispatchError && result.reason !== firstFailure) {
            completedOutputRefs.push(...result.reason.outputRefs);
            completedEvidenceRefs.push(...result.reason.evidenceRefs);
          }
        }
        throw stepDispatchError(
          input,
          firstFailureStep ?? 'unknown',
          firstFailure,
          completedOutputRefs,
          completedEvidenceRefs,
        );
      }
      const results = settled.map((result) => (result as PromiseFulfilledResult<NodeStepResult>).value);
      const outputRefs = results.flatMap((result) => result.outputRefs);
      const evidenceRefs = results.flatMap((result) => result.evidenceRefs);
      try {
        const blocked = blockingResult(input, results);
        if (blocked) return blocked;
        return { closure: succeededClosure(input, outputRefs, evidenceRefs) };
      } catch (cause) {
        const step = results.find((result) => result.state !== 'succeeded');
        throw stepDispatchError(input, step?.stepId ?? 'completion', cause, outputRefs, evidenceRefs);
      }
    },
  };
}

export function waitForConditionNodeStrategy(): NodeStrategy {
  return {
    policyRef: NODE_STRATEGY_REFS.waitForCondition,
    async dispatch(input: NodeDispatchRequest): Promise<NodeDispatchResult> {
      const conditionRef = requireReference(input.plan.conditionRef, 'wait-for-condition conditionRef');
      const closure: NodeClosure = {
        nodeId: input.nodeId,
        state: 'waiting',
        ownerRef: input.ownerRef,
        nextAction: { kind: 'wait', ref: conditionRef },
        conditionRef,
        outputRefs: [],
        evidenceRefs: [],
      };
      assertNodeClosure(closure);
      return { closure };
    },
  };
}

export function reviewRemediationNodeStrategy(): NodeStrategy {
  return {
    policyRef: NODE_STRATEGY_REFS.reviewRemediation,
    async dispatch(input: NodeDispatchRequest): Promise<NodeDispatchResult> {
      const outputRefs: string[] = [];
      const evidenceRefs: NodeClosure['evidenceRefs'][number][] = [];
      for (const item of input.plan.items) {
        let result: NodeStepResult;
        try {
          result = await item.execute();
        } catch (cause) {
          throw stepDispatchError(input, item.stepId, cause, outputRefs, evidenceRefs);
        }
        outputRefs.push(...result.outputRefs);
        evidenceRefs.push(...result.evidenceRefs);
        if (result.state === 'succeeded') continue;
        if (!input.plan.remediationRef) {
          try {
            return { closure: closureForStep(input, result, { outputRefs, evidenceRefs }) };
          } catch (cause) {
            throw stepDispatchError(input, item.stepId, cause, outputRefs, evidenceRefs);
          }
        }
        const closure: NodeClosure = {
          nodeId: input.nodeId,
          state: 'blocked',
          ownerRef: input.ownerRef,
          nextAction: { kind: 'recover', ref: input.plan.remediationRef },
          conditionRef: input.plan.conditionRef ?? input.plan.remediationRef,
          failureRef: input.plan.remediationRef,
          outputRefs,
          evidenceRefs,
        };
        try {
          assertNodeClosure(closure);
          return { closure };
        } catch (cause) {
          throw stepDispatchError(input, item.stepId, cause, outputRefs, evidenceRefs);
        }
      }
      try {
        return { closure: succeededClosure(input, outputRefs, evidenceRefs) };
      } catch (cause) {
        throw stepDispatchError(input, 'completion', cause, outputRefs, evidenceRefs);
      }
    },
  };
}

export function createDefaultNodeStrategyRegistry(): NodeStrategyRegistry {
  const registry = new NodeStrategyRegistry();
  registry.register(serialNodeStrategy());
  registry.register(parallelJoinNodeStrategy());
  registry.register(waitForConditionNodeStrategy());
  registry.register(reviewRemediationNodeStrategy());
  return registry;
}
