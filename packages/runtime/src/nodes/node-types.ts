import {
  assertExecutionEpoch,
  type EvidenceRef,
  type LifecycleState,
  type NextAction,
  type ScopeRef,
} from '../../../contracts/src/index.js';
import { requireReference, RuntimeError } from './errors.js';

export const NODE_STAGES = ['created', 'admitted', 'planned', 'dispatched', 'observed', 'settled'] as const;
export type NodeStage = (typeof NODE_STAGES)[number];

export type NodeOutcome = Extract<
  LifecycleState,
  'succeeded' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'stopped' | 'unknown'
>;

export interface NodeAdmission {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly nodeKind: string;
  readonly orchestrationPolicyRef: string;
  readonly inputRefs: readonly string[];
  readonly outputContractRef: string;
  readonly ownerRef: string;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
}

export interface NodeStepResult {
  readonly stepId: string;
  readonly state: NodeOutcome;
  readonly ownerRef?: string;
  readonly summary: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly nextAction?: NextAction;
  readonly conditionRef?: string;
  readonly failureRef?: string;
}

export interface NodeDispatchItem {
  readonly stepId: string;
  readonly kind: string;
  readonly execute: () => Promise<NodeStepResult>;
}

export interface NodePlanRequest {
  readonly nodeId: string;
  readonly executionEpoch: number;
  readonly ownerRef?: string;
  readonly conditionRef?: string;
  readonly inputRefs?: readonly string[];
  readonly items?: readonly NodeDispatchItem[];
  readonly reviewRef?: string;
  readonly remediationRef?: string;
}

export interface NodePlan {
  readonly nodeId: string;
  readonly policyRef: string;
  readonly ownerRef: string;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly outputContractRef: string;
  readonly conditionRef?: string;
  readonly items: readonly NodeDispatchItem[];
  readonly reviewRef?: string;
  readonly remediationRef?: string;
}

export interface NodeDispatchRequest {
  readonly nodeId: string;
  readonly policyRef: string;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly ownerRef: string;
  readonly plan: NodePlan;
}

export interface NodeClosure {
  readonly nodeId: string;
  readonly state: NodeOutcome;
  readonly ownerRef: string;
  readonly nextAction: NextAction;
  readonly conditionRef?: string;
  readonly failureRef?: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Evidence returned by a failed dispatch, retained for diagnosis but never used as authoritative closure evidence. */
  readonly diagnosticEvidenceRefs?: readonly EvidenceRef[];
}

export interface NodeDispatchResult {
  readonly closure: NodeClosure;
}

export interface NodeObserveRequest {
  readonly nodeId: string;
  readonly executionEpoch: number;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface NodeObservation {
  readonly nodeId: string;
  readonly executionEpoch: number;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface NodeSettleRequest {
  readonly nodeId: string;
  readonly executionEpoch: number;
  readonly observation: NodeObservation;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface HarnessNode extends NodeAdmission {
  readonly stage: NodeStage;
  readonly state: LifecycleState;
  readonly plan?: NodePlan;
  readonly closure?: NodeClosure;
  readonly observation?: NodeObservation;
}

function sameEvidenceIdentity(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.evidenceId.scope === right.evidenceId.scope
    && left.evidenceId.value === right.evidenceId.value
    && left.kind === right.kind
    && left.source === right.source
    && left.locator === right.locator
    && left.digest === right.digest
    && left.scope.organId.scope === right.scope.organId.scope
    && left.scope.organId.value === right.scope.organId.value
    && left.scope.taskId?.scope === right.scope.taskId?.scope
    && left.scope.taskId?.value === right.scope.taskId?.value
    && left.scope.cycleId?.scope === right.scope.cycleId?.scope
    && left.scope.cycleId?.value === right.scope.cycleId?.value
    && left.scope.operationId?.scope === right.scope.operationId?.scope
    && left.scope.operationId?.value === right.scope.operationId?.value;
}

export function hasEvidenceIdentityConflict(evidenceRefs: readonly EvidenceRef[]): boolean {
  for (let index = 0; index < evidenceRefs.length; index += 1) {
    const evidence = evidenceRefs[index]!;
    const existing = evidenceRefs.slice(0, index).find((candidate) => candidate.evidenceId.value === evidence.evidenceId.value);
    if (existing && !sameEvidenceIdentity(existing, evidence)) return true;
  }
  return false;
}

export function assertNodeStageTransition(from: NodeStage, to: NodeStage): void {
  const expectedIndex = NODE_STAGES.indexOf(from) + 1;
  if (expectedIndex >= NODE_STAGES.length || NODE_STAGES[expectedIndex] !== to) {
    throw new RuntimeError(`illegal node stage transition: ${from} -> ${to}`);
  }
}

export function assertNodeClosure(closure: NodeClosure): void {
  requireReference(closure.nodeId, 'node closure nodeId');
  requireReference(closure.ownerRef, 'node closure ownerRef');
  requireReference(closure.nextAction.ref, 'node closure nextAction ref');

  if (closure.state === 'waiting') {
    if (closure.nextAction.kind !== 'wait') throw new RuntimeError('waiting node requires wait next action');
    requireReference(closure.conditionRef, 'waiting node conditionRef');
  }
  if (closure.state === 'blocked') {
    if (closure.nextAction.kind !== 'recover' && closure.nextAction.kind !== 'stop') {
      throw new RuntimeError('blocked node requires recover or stop next action');
    }
    requireReference(closure.conditionRef ?? closure.failureRef, 'blocked node conditionRef');
  }
  if (closure.state === 'failed') {
    if (closure.nextAction.kind !== 'recover' && closure.nextAction.kind !== 'stop') {
      throw new RuntimeError('failed node requires recover or stop next action');
    }
    requireReference(closure.failureRef, 'failed node failureRef');
  }
  if ((closure.state === 'cancelled' || closure.state === 'stopped') && closure.nextAction.kind === 'continue') {
    throw new RuntimeError(`${closure.state} node cannot continue`);
  }
  if (closure.state === 'unknown' && closure.nextAction.kind !== 'recover') {
    throw new RuntimeError('unknown node requires recovery next action');
  }
}

export function validateNodeAdmission(input: NodeAdmission): void {
  requireReference(input.nodeId, 'nodeId');
  requireReference(input.nodeKind, 'nodeKind');
  requireReference(input.orchestrationPolicyRef, 'orchestrationPolicyRef');
  requireReference(input.outputContractRef, 'outputContractRef');
  requireReference(input.ownerRef, 'ownerRef');
  assertExecutionEpoch(input.executionEpoch);
}

export function validateNodePlan(plan: NodePlan, expectedPolicyRef: string): void {
  requireReference(plan.nodeId, 'plan nodeId');
  requireReference(plan.ownerRef, 'plan ownerRef');
  assertExecutionEpoch(plan.executionEpoch);
  if (plan.policyRef !== expectedPolicyRef) throw new RuntimeError('node policy cannot change after admission');
  for (const item of plan.items) {
    requireReference(item.stepId, 'dispatch stepId');
    requireReference(item.kind, 'dispatch item kind');
  }
}
