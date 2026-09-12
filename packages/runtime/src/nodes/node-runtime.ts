import { assertEvidenceRef, assertSameScope, type EvidenceRef, type LifecycleState } from '../../../contracts/src/index.js';
import { assertTransitionLifecycle } from '../../../core/src/lifecycle.js';
import { NodeDispatchError, RuntimeError } from './errors.js';
import {
  assertNodeClosure,
  assertNodeStageTransition,
  validateNodeAdmission,
  validateNodePlan,
  type HarnessNode,
  type NodeAdmission,
  type NodeClosure,
  type NodeDispatchRequest,
  type NodeDispatchResult,
  type NodeObservation,
  type NodeObserveRequest,
  type NodePlan,
  type NodePlanRequest,
  type NodeSettleRequest,
  type NodeStage,
  hasEvidenceIdentityConflict,
} from './node-types.js';
import { NodeStrategyRegistry } from './node-strategies.js';

function nodeStateForStage(stage: NodeStage, closure?: NodeClosure): LifecycleState {
  if (stage === 'created') return 'created';
  if (stage === 'admitted' || stage === 'planned') return 'admitted';
  if (stage === 'dispatched') return 'running';
  if (stage === 'observed') return 'settling';
  if (!closure) throw new RuntimeError('settled node requires a closure');
  return closure.state;
}

function assertNodeEvidence(scope: HarnessNode['scope'], evidenceRefs: readonly EvidenceRef[], ownerRef: string): void {
  for (const evidence of evidenceRefs) {
    try {
      assertEvidenceRef(evidence);
      assertSameScope(scope, evidence.scope);
    } catch (error) {
      throw new RuntimeError(
        error instanceof Error ? error.message : 'node evidence is invalid or outside node scope',
        { ownerRef },
      );
    }
  }
}

function assertNodeClosureEvidence(scope: HarnessNode['scope'], evidenceRefs: readonly EvidenceRef[], ownerRef: string): void {
  for (const evidence of evidenceRefs) {
    try {
      assertEvidenceRef(evidence);
      if (scope.organId.value !== evidence.scope.organId.value || scope.taskId?.value !== evidence.scope.taskId?.value) {
        throw new Error('node closure evidence organ or task does not match node scope');
      }
      if (scope.cycleId && evidence.scope.cycleId && scope.cycleId.value !== evidence.scope.cycleId.value) {
        throw new Error('node closure evidence cycle does not match node scope');
      }
      if (scope.operationId && evidence.scope.operationId && scope.operationId.value !== evidence.scope.operationId.value) {
        throw new Error('node closure evidence operation does not match node scope');
      }
    } catch (error) {
      throw new RuntimeError(
        error instanceof Error ? error.message : 'node closure evidence is invalid or outside task scope',
        { ownerRef },
      );
    }
  }
}

function partitionNodeClosureEvidence(
  scope: HarnessNode['scope'],
  evidenceRefs: readonly EvidenceRef[],
  ownerRef: string,
): { readonly valid: EvidenceRef[]; readonly diagnostic: readonly EvidenceRef[] | undefined } {
  const valid: EvidenceRef[] = [];
  let hasInvalidEvidence = false;
  for (const evidence of evidenceRefs) {
    try {
      assertNodeClosureEvidence(scope, [evidence], ownerRef);
      valid.push(evidence);
    } catch {
      hasInvalidEvidence = true;
    }
  }
  return { valid, diagnostic: hasInvalidEvidence ? [...evidenceRefs] : undefined };
}

export class HarnessNodeRuntime {
  private readonly nodes = new Map<string, HarnessNode>();

  constructor(readonly strategies: NodeStrategyRegistry) {}

  createNode(input: NodeAdmission): HarnessNode {
    validateNodeAdmission(input);
    if (this.nodes.has(input.nodeId)) throw new RuntimeError(`duplicate node: ${input.nodeId}`);
    const node: HarnessNode = { ...input, stage: 'created', state: 'created' };
    this.nodes.set(node.nodeId, node);
    return this.snapshotNode(node.nodeId);
  }

  admit(input: NodeAdmission): HarnessNode {
    if (!this.nodes.has(input.nodeId)) {
      this.createNode(input);
    } else {
      const existing = this.requireNode(input.nodeId);
      if (
        existing.orchestrationPolicyRef !== input.orchestrationPolicyRef
        || existing.ownerRef !== input.ownerRef
        || existing.nodeKind !== input.nodeKind
        || existing.outputContractRef !== input.outputContractRef
      ) {
        throw new RuntimeError(`node admission conflicts with existing node: ${input.nodeId}`);
      }
    }
    const node = this.requireNode(input.nodeId);
    if (node.executionEpoch !== input.executionEpoch) throw new RuntimeError('node admission execution epoch mismatch');
    if (!this.strategies.has(node.orchestrationPolicyRef)) {
      throw new RuntimeError(`unknown node strategy: ${node.orchestrationPolicyRef}`, { ownerRef: node.ownerRef });
    }
    assertNodeStageTransition(node.stage, 'admitted');
    this.nodes.set(node.nodeId, { ...node, stage: 'admitted', state: nodeStateForStage('admitted') });
    return this.snapshotNode(node.nodeId);
  }

  plan(input: NodePlanRequest): NodePlan {
    const node = this.requireEpoch(input.nodeId, input.executionEpoch);
    if (node.stage !== 'admitted') throw new RuntimeError(`node must be admitted before planning: ${node.stage}`, { ownerRef: node.ownerRef });
    const plan: NodePlan = {
      nodeId: node.nodeId,
      policyRef: node.orchestrationPolicyRef,
      ownerRef: input.ownerRef ?? node.ownerRef,
      executionEpoch: node.executionEpoch,
      scope: node.scope,
      inputRefs: input.inputRefs ?? node.inputRefs,
      outputContractRef: node.outputContractRef,
      conditionRef: input.conditionRef,
      items: input.items ?? [],
      reviewRef: input.reviewRef,
      remediationRef: input.remediationRef,
    };
    validateNodePlan(plan, node.orchestrationPolicyRef);
    assertNodeStageTransition(node.stage, 'planned');
    this.nodes.set(node.nodeId, { ...node, stage: 'planned', state: nodeStateForStage('planned'), plan });
    return plan;
  }

  async dispatch(input: NodeDispatchRequest): Promise<NodeDispatchResult> {
    const node = this.requireEpoch(input.nodeId, input.executionEpoch);
    if (node.stage !== 'planned' || !node.plan) throw new RuntimeError(`node must be planned before dispatch: ${node.stage}`, { ownerRef: node.ownerRef });
    if (input.policyRef !== node.orchestrationPolicyRef) throw new RuntimeError('dispatch policy does not match admitted node policy', { ownerRef: node.ownerRef });
    validateNodePlan(input.plan, node.orchestrationPolicyRef);
    if (input.ownerRef !== node.ownerRef) throw new RuntimeError('dispatch owner does not match admitted node owner', { ownerRef: node.ownerRef });
    assertSameScope(node.scope, input.scope, input.plan.scope);
    if (input.plan.nodeId !== node.nodeId || input.plan.executionEpoch !== node.executionEpoch || input.plan.ownerRef !== node.ownerRef) {
      throw new RuntimeError('dispatch plan does not match the planned node', { ownerRef: node.ownerRef });
    }

    assertNodeStageTransition(node.stage, 'dispatched');
    this.nodes.set(node.nodeId, { ...node, stage: 'dispatched', state: nodeStateForStage('dispatched') });

    try {
      const result = await this.strategies.dispatch(input);
      if (result.closure.nodeId !== node.nodeId || result.closure.ownerRef !== node.ownerRef) {
        const identityFailure = new RuntimeError('node strategy returned a closure for another node identity', { ownerRef: node.ownerRef });
        throw new NodeDispatchError(
          identityFailure.message,
          { ownerRef: node.ownerRef, failureRef: `node-dispatch:${node.nodeId}:identity` },
          {
            outputRefs: result.closure.outputRefs,
            evidenceRefs: result.closure.evidenceRefs,
            cause: identityFailure,
          },
        );
      }
      try {
        assertNodeClosureEvidence(node.scope, result.closure.evidenceRefs, node.ownerRef);
      } catch (cause) {
        const evidenceFailure = new RuntimeError('node strategy returned evidence outside the node task scope', {
          ownerRef: node.ownerRef,
          failureRef: `node-dispatch:${node.nodeId}:evidence-scope`,
          cause,
        });
        throw new NodeDispatchError(
          evidenceFailure.message,
          { ownerRef: node.ownerRef, failureRef: evidenceFailure.failureRef! },
          { outputRefs: result.closure.outputRefs, evidenceRefs: result.closure.evidenceRefs, cause: evidenceFailure },
        );
      }
      assertTransitionLifecycle('admitted', 'running');
      const stored = this.requireNode(node.nodeId);
      this.nodes.set(node.nodeId, {
        ...stored,
        stage: 'dispatched',
        state: nodeStateForStage('dispatched'),
        closure: result.closure,
      });
      return result;
    } catch (error) {
      const failure = error instanceof NodeDispatchError
        ? error
        : new NodeDispatchError(
          error instanceof Error ? error.message : 'node dispatch failed',
          { ownerRef: node.ownerRef, failureRef: `node-dispatch:${node.nodeId}` },
          { outputRefs: [], evidenceRefs: [], cause: error },
        );
      const partitionedEvidence = partitionNodeClosureEvidence(node.scope, failure.evidenceRefs, node.ownerRef);
      const closure: NodeClosure = {
        nodeId: node.nodeId,
        state: 'failed',
        ownerRef: node.ownerRef,
        nextAction: { kind: 'recover', ref: failure.failureRef ?? `node-dispatch:${node.nodeId}` },
        failureRef: failure.failureRef ?? `node-dispatch:${node.nodeId}`,
        outputRefs: [...failure.outputRefs],
        evidenceRefs: partitionedEvidence.valid,
        ...(partitionedEvidence.diagnostic ? { diagnosticEvidenceRefs: partitionedEvidence.diagnostic } : {}),
      };
      assertNodeClosure(closure);
      this.nodes.set(node.nodeId, {
        ...node,
        stage: 'dispatched',
        state: nodeStateForStage('dispatched'),
        closure,
      });
      throw error;
    }
  }

  observe(input: NodeObserveRequest): NodeObservation {
    const node = this.requireEpoch(input.nodeId, input.executionEpoch);
    if (node.stage !== 'dispatched' || !node.closure) {
      throw new RuntimeError(`node must be dispatched with a closure before observation: ${node.stage}`, { ownerRef: node.ownerRef });
    }
    assertNodeStageTransition(node.stage, 'observed');
    const evidenceRefs = input.evidenceRefs ?? [];
    assertNodeEvidence(node.scope, evidenceRefs, node.ownerRef);
    const observation: NodeObservation = {
      nodeId: node.nodeId,
      executionEpoch: node.executionEpoch,
      evidenceRefs,
    };
    this.nodes.set(node.nodeId, { ...node, stage: 'observed', state: nodeStateForStage('observed'), observation });
    return observation;
  }

  settle(input: NodeSettleRequest): NodeClosure {
    const node = this.requireEpoch(input.nodeId, input.executionEpoch);
    if (node.stage !== 'observed' || !node.closure) {
      throw new RuntimeError(`node must be observed before settlement: ${node.stage}`, { ownerRef: node.ownerRef });
    }
    if (input.observation.nodeId !== node.nodeId || input.observation.executionEpoch !== node.executionEpoch) {
      throw new RuntimeError('node settlement observation does not match the node epoch');
    }
    assertNodeEvidence(node.scope, input.observation.evidenceRefs, node.ownerRef);
    const settlementEvidenceRefs = input.evidenceRefs ?? [];
    assertNodeEvidence(node.scope, settlementEvidenceRefs, node.ownerRef);
    const closure: NodeClosure = {
      ...node.closure,
      evidenceRefs: [...node.closure.evidenceRefs, ...settlementEvidenceRefs, ...input.observation.evidenceRefs],
    };
    if (hasEvidenceIdentityConflict(closure.evidenceRefs)) {
      const failureRef = `node-settle:${node.nodeId}:evidence-integrity`;
      const integrityFailure = new RuntimeError('conflicting evidence identity in node settlement', { ownerRef: node.ownerRef, failureRef });
      const failedClosure: NodeClosure = {
        ...closure,
        state: 'failed',
        nextAction: { kind: 'recover', ref: failureRef },
        failureRef,
      };
      assertNodeClosure(failedClosure);
      assertTransitionLifecycle('settling', failedClosure.state);
      assertNodeStageTransition(node.stage, 'settled');
      this.nodes.set(node.nodeId, { ...node, stage: 'settled', state: failedClosure.state, closure: failedClosure });
      throw new NodeDispatchError(integrityFailure.message, { ownerRef: node.ownerRef, failureRef }, {
        outputRefs: failedClosure.outputRefs,
        evidenceRefs: failedClosure.evidenceRefs,
        cause: integrityFailure,
      });
    }
    assertNodeClosure(closure);
    assertTransitionLifecycle('settling', closure.state);
    assertNodeStageTransition(node.stage, 'settled');
    this.nodes.set(node.nodeId, { ...node, stage: 'settled', state: closure.state, closure });
    return closure;
  }

  get(nodeId: string): HarnessNode {
    return this.snapshotNode(nodeId);
  }

  private requireNode(nodeId: string): HarnessNode {
    const node = this.nodes.get(nodeId);
    if (!node) throw new RuntimeError(`unknown node: ${nodeId}`);
    return node;
  }

  private requireEpoch(nodeId: string, executionEpoch: number): HarnessNode {
    const node = this.requireNode(nodeId);
    if (node.executionEpoch !== executionEpoch) throw new RuntimeError(`node execution epoch mismatch: ${executionEpoch}`, { ownerRef: node.ownerRef });
    return node;
  }

  private snapshotNode(nodeId: string): HarnessNode {
    const node = this.requireNode(nodeId);
    return { ...node, inputRefs: [...node.inputRefs], plan: node.plan, closure: node.closure, observation: node.observation };
  }
}
