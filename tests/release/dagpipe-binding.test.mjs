import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binderScript = fileURLToPath(new URL('../../scripts/dagpipe-bind-graphs.mjs', import.meta.url));
const owner = {
  ownerPath: 'packages/app/src/ui-runtime/service.ts',
  ownerRel: 'packages/app/src/ui-runtime/service.ts',
};

function graph({ nodes, edges }) {
  return {
    id: 'fixture-graph',
    version: '1',
    nodes: nodes.map((id) => ({
      id,
      operator: `humanagent-${id}`,
      operator_version: '1',
      inputs: [],
      output: { id: `${id}_output`, schema: 'Object' },
      input_selector: { include: [], exclude: [], predicate: null },
      output_selector: { include: [], exclude: [], predicate: null },
      iterator: 'Whole',
    })),
    edges,
  };
}

function binding({ nodes, operator }) {
  return {
    graph: 'fixture-graph',
    operator: operator ?? { operator: 'humanagent-fixture-graph', operator_version: '1' },
    nodes: Object.fromEntries(nodes.map((id) => [id, owner])),
  };
}

function runBinder({ graphFixture, bindingFixture, skipBinding }) {
  const dir = mkdtempSync(join(tmpdir(), 'dagpipe-binding-'));
  const graphPath = join(dir, 'fixture.graph.json');
  const bindingPath = join(dir, 'fixture.graph.binding.json');
  writeFileSync(graphPath, JSON.stringify(graphFixture, null, 2));
  if (!skipBinding) {
    writeFileSync(bindingPath, JSON.stringify(bindingFixture, null, 2));
  }
  const result = spawnSync(process.execPath, [binderScript, graphPath, bindingPath], {
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  return { result, graphPath, bindingPath };
}

function assertFails(result, message) {
  assert.equal(result.status, 1, `expected non-zero exit, stderr: ${result.stderr}`);
  assert.ok(result.stderr.includes(`\nError: ${message}`), `expected stderr to contain exact error '${message}', got: ${result.stderr}`);
}

test('missing binding file fails closed', () => {
  const nodes = ['a', 'b'];
  const { result, graphPath, bindingPath } = runBinder({
    graphFixture: graph({
      nodes,
      edges: [{ from: 'a', to: 'b', arc_id: 'a_b' }],
    }),
    bindingFixture: null,
    skipBinding: true,
  });
  assertFails(result, `missing binding file for ${graphPath}: expected ${bindingPath}`);
});

test('multiple sources fail closed', () => {
  const nodes = ['a', 'b'];
  const { result } = runBinder({
    graphFixture: graph({ nodes, edges: [] }),
    bindingFixture: binding({ nodes }),
  });
  assertFails(result, 'expected single source, got 2');
});

test('multiple sinks fail closed', () => {
  const nodes = ['a', 'b', 'c'];
  const { result } = runBinder({
    graphFixture: graph({
      nodes,
      edges: [
        { from: 'a', to: 'b', arc_id: 'a_b' },
        { from: 'a', to: 'c', arc_id: 'a_c' },
      ],
    }),
    bindingFixture: binding({ nodes }),
  });
  assertFails(result, 'expected single sink, got 2');
});

test('orphan node unreachable from source fails closed', () => {
  const nodes = ['a', 'b', 'c', 'd'];
  const { result } = runBinder({
    graphFixture: graph({
      nodes,
      edges: [
        { from: 'a', to: 'b', arc_id: 'a_b' },
        { from: 'c', to: 'd', arc_id: 'c_d' },
        { from: 'd', to: 'c', arc_id: 'd_c' },
      ],
    }),
    bindingFixture: binding({ nodes }),
  });
  assertFails(result, 'node c is unreachable from source');
});

test('sink unreachable behind a disconnected cycle fails closed', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'];
  const { result } = runBinder({
    graphFixture: graph({
      nodes,
      edges: [
        { from: 'a', to: 'e', arc_id: 'a_e' },
        { from: 'e', to: 'e', arc_id: 'e_e' },
        { from: 'c', to: 'd', arc_id: 'c_d' },
        { from: 'd', to: 'c', arc_id: 'd_c' },
        { from: 'd', to: 'b', arc_id: 'd_b' },
      ],
    }),
    bindingFixture: binding({ nodes }),
  });
  assertFails(result, 'sink b cannot be reached');
});

test('non-humanagent operator prefix fails closed', () => {
  const nodes = ['a', 'b'];
  const { result } = runBinder({
    graphFixture: graph({
      nodes,
      edges: [{ from: 'a', to: 'b', arc_id: 'a_b' }],
    }),
    bindingFixture: binding({
      nodes,
      operator: { operator: 'evil-operator', operator_version: '1' },
    }),
  });
  assertFails(result, 'operator evil-operator must start with humanagent-');
});

test('missing binding.graph fails closed', () => {
  const nodes = ['a', 'b'];
  const bindingFixture = binding({ nodes });
  delete bindingFixture.graph;
  const { result, graphPath } = runBinder({
    graphFixture: graph({
      nodes,
      edges: [{ from: 'a', to: 'b', arc_id: 'a_b' }],
    }),
    bindingFixture,
  });
  assertFails(result, `binding graph missing for ${graphPath}: expected fixture-graph`);
});

test('unsafe ownerPath fails closed', () => {
  const nodes = ['a', 'b'];
  const bindingFixture = binding({ nodes });
  bindingFixture.nodes.a.ownerPath = '/etc/hosts';
  const { result } = runBinder({
    graphFixture: graph({
      nodes,
      edges: [{ from: 'a', to: 'b', arc_id: 'a_b' }],
    }),
    bindingFixture,
  });
  assertFails(result, 'ownerPath /etc/hosts for node a is not a project-relative path');
});
