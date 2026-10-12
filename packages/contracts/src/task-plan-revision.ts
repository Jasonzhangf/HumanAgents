import { assertEvidenceRef, assertScope, type BusinessPayload, type EvidenceRef, type ScopeRef } from './index.js';
import { ContractError } from './errors.js';
import { isCanonicalInstant } from './time.js';

export type TaskPlanRevisionId = string;
export type TaskPlanDigest = `sha256:${string}`;

/** The stable, complete plan snapshot. Runtime status and execution attempts are deliberately absent. */
export interface TaskPlanNode {
  readonly nodeId: string;
  readonly kind: string;
  readonly title: string;
  readonly intent: string;
  readonly definition: BusinessPayload;
  readonly phaseId?: string;
}

export interface TaskPlanPhase {
  readonly phaseId: string;
  readonly title: string;
  readonly memberNodeIds: readonly string[];
}

export type TaskPlanRelationKind = 'depends-on' | 'parent-child' | 'sequence';

/** Relations are only those explicitly declared by the plan owner. */
export interface TaskPlanRelation {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: TaskPlanRelationKind;
}

/** The planner explicitly certifies that the snapshot covers the complete task scope. */
export interface TaskPlanCompleteness {
  readonly scope: 'whole-task';
  readonly status: 'complete';
}

/** Business outcomes the task must satisfy; execution/process health belongs elsewhere. */
export interface TaskPlanAcceptanceCriterion {
  readonly criterionId: string;
  readonly description: string;
}

export interface TaskPlanSnapshot {
  readonly title: string;
  readonly summary: string;
  readonly completeness: TaskPlanCompleteness;
  readonly acceptanceCriteria: readonly TaskPlanAcceptanceCriterion[];
  readonly nodes: readonly TaskPlanNode[];
  readonly phases: readonly TaskPlanPhase[];
  readonly relations: readonly TaskPlanRelation[];
}

export interface TaskPlanInputSource {
  readonly requirementId: string;
  readonly inputRevision: number;
  readonly draftId: string;
  readonly draftRevisionVersion: number;
  readonly draftRevisionHash: string;
  readonly confirmationRef: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface TaskPlanRevisionReason {
  readonly kind: 'initial' | 'adjustment' | 'unrecorded';
  readonly text?: string;
  readonly basisRefs: readonly EvidenceRef[];
}

export interface TaskPlanRevisionPredecessor {
  readonly revisionId: TaskPlanRevisionId;
  readonly sequence: number;
  readonly contentDigest: TaskPlanDigest;
}

/** A committed immutable publication. A record is not visible until its journal append succeeds. */
export interface PublishedTaskPlanRevision {
  readonly scope: ScopeRef & { readonly taskId: NonNullable<ScopeRef['taskId']> };
  readonly revisionId: TaskPlanRevisionId;
  readonly sequence: number;
  readonly contentDigest: TaskPlanDigest;
  readonly predecessor: TaskPlanRevisionPredecessor | null;
  readonly snapshot: TaskPlanSnapshot;
  readonly reason: TaskPlanRevisionReason;
  readonly source: TaskPlanInputSource;
  readonly historyCoverage: 'complete-from-task-start' | 'prior-history-unavailable';
  readonly publishedAt: string;
  readonly publishedBy: string;
  /** Assigned by the authoritative journal adapter; never inferred from a projection watermark. */
  readonly journalCommitRef: string;
}

export interface TaskPlanRevisionPublicationInput extends Omit<PublishedTaskPlanRevision, 'contentDigest'> {
  readonly snapshot: TaskPlanSnapshot;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const NON_EMPTY = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function requireText(value: unknown, label: string): asserts value is string {
  if (!NON_EMPTY(value)) throw new ContractError(`${label} must be a non-empty string`);
}

function requireSequence(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ContractError(`${label} must be a positive safe integer`);
  }
}

function requireDigest(value: unknown, label: string): asserts value is TaskPlanDigest {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new ContractError(`${label} must be a lowercase sha256 digest`);
}

function requireStringList(values: readonly string[], label: string): void {
  if (!Array.isArray(values)) throw new ContractError(`${label} must be an array`);
  for (const value of values) requireText(value, `${label} entry`);
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new ContractError(`${label} must not contain duplicates`);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  for (const property of Reflect.ownKeys(value)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, property)) return false;
  }
  return true;
}

function validateJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, label);
    return;
  }
  if (typeof value === 'object') {
    if (!isPlainJsonObject(value)) {
      throw new ContractError(`${label} must contain only plain JSON objects`);
    }
    for (const [key, nested] of Object.entries(value)) {
      requireText(key, `${label} key`);
      validateJsonValue(nested, label);
    }
    return;
  }
  throw new ContractError(`${label} must contain only JSON values`);
}

export function validateTaskPlanSnapshot(snapshot: TaskPlanSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') throw new ContractError('task plan snapshot must be an object');
  requireText(snapshot.title, 'task plan title');
  requireText(snapshot.summary, 'task plan summary');
  if (!snapshot.completeness || snapshot.completeness.scope !== 'whole-task' || snapshot.completeness.status !== 'complete') {
    throw new ContractError('task plan snapshot must explicitly declare complete whole-task coverage');
  }
  if (!Array.isArray(snapshot.acceptanceCriteria) || snapshot.acceptanceCriteria.length === 0) {
    throw new ContractError('task plan snapshot must include business acceptance criteria');
  }
  const criterionIds = snapshot.acceptanceCriteria.map((criterion) => criterion.criterionId);
  for (const criterion of snapshot.acceptanceCriteria) {
    requireText(criterion.criterionId, 'task plan acceptance criterion id');
    requireText(criterion.description, `task plan acceptance criterion ${criterion.criterionId} description`);
  }
  requireUnique(criterionIds, 'task plan acceptance criterion ids');
  if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) throw new ContractError('task plan nodes must be a non-empty array');
  if (!Array.isArray(snapshot.phases)) throw new ContractError('task plan phases must be an array');
  if (!Array.isArray(snapshot.relations)) throw new ContractError('task plan relations must be an array');

  const nodeIds = snapshot.nodes.map((node) => node.nodeId);
  for (const node of snapshot.nodes) {
    requireText(node.nodeId, 'task plan node id');
    requireText(node.kind, `task plan node ${node.nodeId} kind`);
    requireText(node.title, `task plan node ${node.nodeId} title`);
    requireText(node.intent, `task plan node ${node.nodeId} intent`);
    if (!node.definition || typeof node.definition !== 'object' || Array.isArray(node.definition)) {
      throw new ContractError(`task plan node ${node.nodeId} definition must be an object`);
    }
    validateJsonValue(node.definition, `task plan node ${node.nodeId} definition`);
    if (node.phaseId !== undefined) requireText(node.phaseId, `task plan node ${node.nodeId} phaseId`);
  }
  requireUnique(nodeIds, 'task plan node ids');
  const nodeIdSet = new Set(nodeIds);

  const phaseIds = snapshot.phases.map((phase) => phase.phaseId);
  for (const phase of snapshot.phases) {
    requireText(phase.phaseId, 'task plan phase id');
    requireText(phase.title, `task plan phase ${phase.phaseId} title`);
    requireStringList(phase.memberNodeIds, `task plan phase ${phase.phaseId} members`);
    requireUnique(phase.memberNodeIds, `task plan phase ${phase.phaseId} members`);
    for (const nodeId of phase.memberNodeIds) {
      if (!nodeIdSet.has(nodeId)) throw new ContractError(`task plan phase ${phase.phaseId} references unknown node ${nodeId}`);
    }
  }
  requireUnique(phaseIds, 'task plan phase ids');
  const phaseIdSet = new Set(phaseIds);
  for (const phase of snapshot.phases) {
    for (const nodeId of phase.memberNodeIds) {
      const node = snapshot.nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node?.phaseId !== phase.phaseId) throw new ContractError(`task plan node ${nodeId} phaseId does not match phase membership`);
    }
  }
  for (const node of snapshot.nodes) {
    if (node.phaseId !== undefined && !phaseIdSet.has(node.phaseId)) {
      throw new ContractError(`task plan node ${node.nodeId} references unknown phase ${node.phaseId}`);
    }
    if (node.phaseId !== undefined && !snapshot.phases.find((phase) => phase.phaseId === node.phaseId)?.memberNodeIds.includes(node.nodeId)) {
      throw new ContractError(`task plan phase membership does not include node ${node.nodeId}`);
    }
  }

  const relationKeys = new Set<string>();
  for (const relation of snapshot.relations) {
    requireText(relation.fromNodeId, 'task plan relation fromNodeId');
    requireText(relation.toNodeId, 'task plan relation toNodeId');
    if (relation.fromNodeId === relation.toNodeId) throw new ContractError('task plan relation cannot point to itself');
    if (!nodeIdSet.has(relation.fromNodeId) || !nodeIdSet.has(relation.toNodeId)) {
      throw new ContractError('task plan relation references an unknown node');
    }
    if (!['depends-on', 'parent-child', 'sequence'].includes(relation.kind)) {
      throw new ContractError(`unsupported task plan relation kind: ${String(relation.kind)}`);
    }
    const key = `${relation.kind}\0${relation.fromNodeId}\0${relation.toNodeId}`;
    if (relationKeys.has(key)) throw new ContractError('task plan relations must not contain duplicates');
    relationKeys.add(key);
  }
  for (const kind of ['depends-on', 'parent-child', 'sequence'] as const) {
    const nextByNode = new Map<string, string[]>();
    for (const relation of snapshot.relations) {
      if (relation.kind === kind) nextByNode.set(relation.fromNodeId, [...(nextByNode.get(relation.fromNodeId) ?? []), relation.toNodeId]);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): void => {
      if (visiting.has(nodeId)) throw new ContractError(`task plan ${kind} relations cannot contain a cycle`);
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      for (const next of nextByNode.get(nodeId) ?? []) visit(next);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    for (const nodeId of nodeIds) visit(nodeId);
  }
}

export function validateTaskPlanRevisionMetadata(revision: PublishedTaskPlanRevision): void {
  if (!revision || typeof revision !== 'object') throw new ContractError('published task plan revision must be an object');
  if (!revision.scope || typeof revision.scope !== 'object' || !revision.scope.organId || !revision.scope.taskId) {
    throw new ContractError('published task plan revision requires organ and task scope');
  }
  assertScope(revision.scope.organId, 'organ');
  assertScope(revision.scope.taskId, 'task');
  requireText(revision.scope.organId.value, 'task plan organId');
  requireText(revision.scope.taskId.value, 'task plan taskId');
  if (revision.scope.cycleId !== undefined || revision.scope.operationId !== undefined) {
    throw new ContractError('published task plan revision scope must be task-level');
  }
  requireText(revision.revisionId, 'task plan revisionId');
  requireSequence(revision.sequence, 'task plan sequence');
  requireDigest(revision.contentDigest, 'task plan contentDigest');
  if (revision.predecessor !== null) {
    requireText(revision.predecessor.revisionId, 'task plan predecessor revisionId');
    requireSequence(revision.predecessor.sequence, 'task plan predecessor sequence');
    requireDigest(revision.predecessor.contentDigest, 'task plan predecessor contentDigest');
  }
  validateTaskPlanSnapshot(revision.snapshot);
  if (!['initial', 'adjustment', 'unrecorded'].includes(revision.reason.kind)) {
    throw new ContractError(`unsupported task plan revision reason: ${String(revision.reason.kind)}`);
  }
  if (revision.reason.kind === 'initial' && revision.sequence !== 1) throw new ContractError('initial task plan revision must be sequence 1');
  if (revision.reason.kind === 'adjustment' && revision.sequence === 1) throw new ContractError('adjustment requires a predecessor revision');
  if (revision.reason.text !== undefined) requireText(revision.reason.text, 'task plan revision reason text');
  if (revision.reason.kind === 'unrecorded' && revision.reason.text !== undefined) {
    throw new ContractError('unrecorded task plan revision reason cannot include text');
  }
  if (!Array.isArray(revision.reason.basisRefs)) throw new ContractError('task plan reason basisRefs must be an array');
  for (const ref of revision.reason.basisRefs) assertEvidenceRef(ref);
  requireText(revision.source.requirementId, 'task plan source requirementId');
  requireSequence(revision.source.inputRevision, 'task plan source inputRevision');
  requireText(revision.source.draftId, 'task plan source draftId');
  requireSequence(revision.source.draftRevisionVersion, 'task plan source draftRevisionVersion');
  requireText(revision.source.draftRevisionHash, 'task plan source draftRevisionHash');
  requireText(revision.source.confirmationRef, 'task plan source confirmationRef');
  if (!Array.isArray(revision.source.evidenceRefs)) throw new ContractError('task plan source evidenceRefs must be an array');
  for (const ref of revision.source.evidenceRefs) assertEvidenceRef(ref);
  if (!['complete-from-task-start', 'prior-history-unavailable'].includes(revision.historyCoverage)) {
    throw new ContractError(`unsupported task plan history coverage: ${String(revision.historyCoverage)}`);
  }
  if (revision.sequence === 1 && revision.predecessor !== null) throw new ContractError('first task plan revision must not have a predecessor');
  if (revision.sequence > 1 && revision.predecessor === null) throw new ContractError('later task plan revision must name its predecessor');
  requireText(revision.publishedAt, 'task plan publishedAt');
  if (!isCanonicalInstant(revision.publishedAt)) throw new ContractError('task plan publishedAt must be a canonical instant');
  requireText(revision.publishedBy, 'task plan publishedBy');
  requireText(revision.journalCommitRef, 'task plan journalCommitRef');
}
