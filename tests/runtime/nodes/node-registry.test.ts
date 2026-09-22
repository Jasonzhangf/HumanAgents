import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PIPELINE_NODE_IDS,
  PIPELINE_ROWS,
  type AgentRoleDisplay,
  type PipelineNodeId,
} from '../../../packages/contracts/src/index.js';
import {
  nodeById,
  nodeRegistry,
  pipelineNodeRow,
  PipelineNodeRegistryError,
  type PipelineNodeDefinition,
} from '../../../packages/runtime/src/nodes/node-registry.js';

// Structural mirror of `AgentRoleDisplay` in `packages/ui/contracts/models.ts:130`. Declared here so
// the control-side registry cannot silently drift from the UI display role.
type UiAgentRoleDisplay = 'interaction' | 'orchestration' | 'execution' | 'review' | 'memory';

const QUEUE_NODE_IDS = ['interactive.queue', 'execution.queue', 'research.queue', 'maintenance.queue'] as const;

function requireNode(nodeId: string): PipelineNodeDefinition {
  return nodeById(nodeId);
}

function reaches(start: PipelineNodeId, target: PipelineNodeId, seen = new Set<PipelineNodeId>()): boolean {
  const node = requireNode(start);
  if (node.upstream.includes(target)) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  return node.upstream.some((upstream) => reaches(upstream, target, seen));
}

test('pipeline registry holds exactly the thirteen declared nodes with unique ids', () => {
  const registry = nodeRegistry();
  assert.equal(registry.length, 13);
  assert.equal(PIPELINE_NODE_IDS.length, 13);
  assert.deepEqual(
    registry.map((node) => node.nodeId),
    [...PIPELINE_NODE_IDS],
  );
  assert.equal(new Set(registry.map((node) => node.nodeId)).size, 13);
  for (const nodeId of PIPELINE_NODE_IDS) {
    assert.equal(nodeById(nodeId).nodeId, nodeId);
  }
});

test('every pipeline node carries owner role, kind, title and upstream edges', () => {
  const roles: readonly UiAgentRoleDisplay[] = ['interaction', 'orchestration', 'execution', 'review', 'memory'];
  for (const node of nodeRegistry()) {
    assert.ok(node.title.trim().length > 0, `${node.nodeId} title`);
    assert.ok(node.kind.trim().length > 0, `${node.nodeId} kind`);
    const ownerRole: UiAgentRoleDisplay = node.ownerRole;
    const contractRole: AgentRoleDisplay = node.ownerRole;
    assert.ok(roles.includes(ownerRole), `${node.nodeId} owner role`);
    assert.equal(contractRole, ownerRole);
    assert.ok(Array.isArray(node.upstream), `${node.nodeId} upstream`);
  }
});

test('upstream references resolve and the graph is acyclic', () => {
  const registry = nodeRegistry();
  for (const node of registry) {
    for (const upstream of node.upstream) {
      assert.ok(PIPELINE_NODE_IDS.includes(upstream), `${node.nodeId} upstream ${upstream} is unknown`);
      requireNode(upstream);
    }
    assert.equal(requireNode(node.nodeId).upstream.includes(node.nodeId), false, `${node.nodeId} self-edge`);
  }
  assert.deepEqual(requireNode('sensory.inbox').upstream, []);
  for (const node of registry) {
    assert.equal(reaches(node.nodeId, node.nodeId), false, `${node.nodeId} participates in a cycle`);
  }
});

test('queue nodes fan out from implicit.classify and fan in to task.correlate-or-create', () => {
  for (const queueNodeId of QUEUE_NODE_IDS) {
    assert.deepEqual(requireNode(queueNodeId).upstream, ['implicit.classify']);
  }
  assert.deepEqual(
    requireNode('task.correlate-or-create').upstream,
    [...QUEUE_NODE_IDS],
  );
  const downstreamOfQueues = nodeRegistry()
    .filter((node) => QUEUE_NODE_IDS.some((queueNodeId) => node.upstream.includes(queueNodeId)))
    .map((node) => node.nodeId);
  assert.deepEqual(downstreamOfQueues, ['task.correlate-or-create']);
});

test('memory.agent is the only side-column node and rows cover every node', () => {
  const sideColumnNodes = nodeRegistry().filter((node) => node.sideColumn).map((node) => node.nodeId);
  assert.deepEqual(sideColumnNodes, ['memory.agent']);
  for (const nodeId of PIPELINE_NODE_IDS) {
    assert.equal(typeof PIPELINE_ROWS[nodeId], 'number');
    assert.equal(pipelineNodeRow(nodeId), PIPELINE_ROWS[nodeId]);
  }
  assert.equal(PIPELINE_ROWS['sensory.inbox'], 0);
});

test('unknown node ids throw instead of returning undefined', () => {
  assert.throws(() => nodeById('不存在'), PipelineNodeRegistryError);
  assert.throws(() => nodeById('input.received'), PipelineNodeRegistryError);
  assert.throws(() => nodeById(''), PipelineNodeRegistryError);
});
