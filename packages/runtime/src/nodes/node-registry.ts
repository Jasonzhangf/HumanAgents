/**
 * Pipeline node registry: the single source of truth for the thirteen requirement pipeline nodes
 * declared in `docs/architecture/organ-runtime.md` ("Pipeline 节点与完整观测"). Node identity, the
 * owning agent role, the DAG edges and the display row are typed facts here; node business logic
 * (dispatch, admission, settle) is not part of this module.
 *
 * Round semantics ("循环轮次")
 * ---------------------------
 * The round of a node instance is `AssignmentProjection.attempt` (contract field `attempt`,
 * serialized as `WorkAssignment.attempt` / `WorkResult.attempt`). `attempt` is chosen over
 * `executionEpoch` because `executionEpoch` identifies a task-level runtime binding shared by every
 * node of the task, and it is a protected control-plane key that must not be mirrored into node
 * observation facts; `attempt` is the per-node, per-assignment round marker that
 * `validateWorkAssignment`/`validateWorkResult` already require to be a positive safe integer and to
 * match between assignment and result.
 *
 * Observable value changes:
 * - re-classification or re-run of a node (retry, remediation, steer-driven restart) produces a new
 *   assignment for the same node and therefore `attempt + 1`; the previous round stays readable.
 * - a node created fresh because its upstream produced a new task does not inherit the old node's
 *   rounds: it is a distinct node instance and starts again at `attempt = 1`.
 * - `attempt` never changes within one round. This module mints no counter and keeps no separate
 *   round bookkeeping.
 */
import {
  PIPELINE_NODE_IDS,
  PIPELINE_ROWS,
  type AgentRoleDisplay,
  type PipelineNodeId,
} from '../../../contracts/src/index.js';
import { RuntimeError } from './errors.js';

export type PipelineNodeKind =
  | 'interaction.input'
  | 'interaction.normalize'
  | 'orchestration.classify'
  | 'orchestration.queue'
  | 'orchestration.correlate'
  | 'orchestration.admission'
  | 'execution.pipeline'
  | 'review.settle'
  | 'review.output'
  | 'memory.curation';

export interface PipelineNodeDefinition {
  readonly nodeId: PipelineNodeId;
  readonly title: string;
  readonly kind: PipelineNodeKind;
  readonly ownerRole: AgentRoleDisplay;
  readonly upstream: readonly PipelineNodeId[];
  readonly sideColumn: boolean;
}

export class PipelineNodeRegistryError extends RuntimeError {
  readonly nodeId: string;

  constructor(message: string, nodeId: string) {
    super(message);
    this.name = 'PipelineNodeRegistryError';
    this.nodeId = nodeId;
  }
}

const NODE_DEFINITIONS: readonly PipelineNodeDefinition[] = [
  {
    nodeId: 'sensory.inbox',
    title: '感知收件',
    kind: 'interaction.input',
    ownerRole: 'interaction',
    upstream: [],
    sideColumn: false,
  },
  {
    nodeId: 'explicit.normalize',
    title: '显式整理',
    kind: 'interaction.normalize',
    ownerRole: 'interaction',
    upstream: ['sensory.inbox'],
    sideColumn: false,
  },
  {
    nodeId: 'implicit.classify',
    title: '隐式分类',
    kind: 'orchestration.classify',
    ownerRole: 'orchestration',
    upstream: ['explicit.normalize'],
    sideColumn: false,
  },
  {
    nodeId: 'interactive.queue',
    title: '交互队列',
    kind: 'orchestration.queue',
    ownerRole: 'orchestration',
    upstream: ['implicit.classify'],
    sideColumn: false,
  },
  {
    nodeId: 'execution.queue',
    title: '执行队列',
    kind: 'orchestration.queue',
    ownerRole: 'orchestration',
    upstream: ['implicit.classify'],
    sideColumn: false,
  },
  {
    nodeId: 'research.queue',
    title: '研究队列',
    kind: 'orchestration.queue',
    ownerRole: 'orchestration',
    upstream: ['implicit.classify'],
    sideColumn: false,
  },
  {
    nodeId: 'maintenance.queue',
    title: '维护队列',
    kind: 'orchestration.queue',
    ownerRole: 'orchestration',
    upstream: ['implicit.classify'],
    sideColumn: false,
  },
  {
    nodeId: 'task.correlate-or-create',
    title: '任务关联或创建',
    kind: 'orchestration.correlate',
    ownerRole: 'orchestration',
    upstream: ['interactive.queue', 'execution.queue', 'research.queue', 'maintenance.queue'],
    sideColumn: false,
  },
  {
    nodeId: 'resource.admission',
    title: '资源准入',
    kind: 'orchestration.admission',
    ownerRole: 'orchestration',
    upstream: ['task.correlate-or-create'],
    sideColumn: false,
  },
  {
    nodeId: 'pipeline.execute',
    title: '流水线执行',
    kind: 'execution.pipeline',
    ownerRole: 'execution',
    upstream: ['resource.admission'],
    sideColumn: false,
  },
  {
    nodeId: 'settle',
    title: '收拢',
    kind: 'review.settle',
    ownerRole: 'review',
    upstream: ['pipeline.execute'],
    sideColumn: false,
  },
  {
    nodeId: 'task.output',
    title: '任务输出',
    kind: 'review.output',
    ownerRole: 'review',
    upstream: ['settle'],
    sideColumn: false,
  },
  {
    nodeId: 'memory.agent',
    title: '经验整理',
    kind: 'memory.curation',
    ownerRole: 'memory',
    // `upstream: ['settle']` is a code-backed edge, not a decoration. The memory agent never reads
    // `task.output`; it consumes the committed checkpoint boundary produced while an operation is
    // settled:
    // - `packages/app/src/agent-operation.ts:559-590` derives the wake trigger from the settled
    //   checkpoint outcome (`memoryTrigger(outcome)`, `packages/app/src/agent-operation.ts:667-671`)
    //   and only publishes after `submitCheckpoint` committed that checkpoint
    //   (`packages/app/src/agent-operation.ts:540-557`).
    // - that event carries the settled checkpoint as its evidence
    //   (`packages/app/src/agent-operation.ts:568-575`, locator `checkpointEvidenceLocator`), and the
    //   analysis request's `sourceRefs` are exactly those evidence locators
    //   (`packages/runtime/src/memory/events.ts:240-253`, used at `:688`).
    // - the memory agent is woken by that request and records those refs as its analysis sources
    //   (`packages/runtime/src/memory/events.ts:757` builds the request from the event,
    //   `packages/runtime/src/memory/agent.ts:873-874` records them).
    // No `task.output` call site exists on the memory path, so `settle` (not `task.output`) is the
    // factual upstream. The node stays in the side column because it curates experience instead of
    // feeding the requirement mainline.
    upstream: ['settle'],
    sideColumn: true,
  },
];

const REGISTRY: readonly PipelineNodeDefinition[] = Object.freeze(
  NODE_DEFINITIONS.map((definition) => Object.freeze({
    ...definition,
    upstream: Object.freeze([...definition.upstream]),
  })),
);

const BY_ID: ReadonlyMap<string, PipelineNodeDefinition> = new Map(
  REGISTRY.map((definition) => [definition.nodeId as string, definition]),
);

const EXPECTED_NODE_COUNT = 13;

function assertRegistryIntegrity(): void {
  if (REGISTRY.length !== EXPECTED_NODE_COUNT) {
    throw new PipelineNodeRegistryError(`pipeline registry must define ${EXPECTED_NODE_COUNT} nodes, got ${REGISTRY.length}`, '');
  }
  for (const nodeId of PIPELINE_NODE_IDS) {
    if (!BY_ID.has(nodeId)) throw new PipelineNodeRegistryError(`pipeline node is not registered: ${nodeId}`, nodeId);
    if (PIPELINE_ROWS[nodeId] === undefined) throw new PipelineNodeRegistryError(`pipeline node has no display row: ${nodeId}`, nodeId);
  }
  if (BY_ID.size !== REGISTRY.length) {
    throw new PipelineNodeRegistryError('pipeline registry contains duplicate node ids', '');
  }
}

assertRegistryIntegrity();

/** Read-only view of every registered pipeline node, in canonical pipeline order. */
export function nodeRegistry(): readonly PipelineNodeDefinition[] {
  return REGISTRY;
}

/** Look up one node definition; unknown ids fail loudly instead of returning undefined. */
export function nodeById(nodeId: string): PipelineNodeDefinition {
  const definition = BY_ID.get(nodeId);
  if (!definition) throw new PipelineNodeRegistryError(`unknown pipeline node: ${nodeId}`, nodeId);
  return definition;
}

export function pipelineNodeRow(nodeId: PipelineNodeId): number {
  return PIPELINE_ROWS[nodeId];
}
