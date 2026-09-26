import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const graphDir = join(projectRoot, 'docs', 'dagpipe');
const ownerRoots = ['packages/', 'docs/', 'scripts/', 'tests/'];
const semverMajor1 = /^1(\.|$)/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function bindingPathForGraph(graphPath, override) {
  if (!override) {
    return graphPath.replace(/\.graph\.json$/, '.graph.binding.json');
  }
  if (override.includes('|')) {
    const [graph, binding] = override.split('|', 2);
    if (resolve(graph) === resolve(graphPath)) {
      return binding;
    }
  }
  return override;
}

export function validateBinding(graph, binding) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  for (const edge of graph.edges ?? []) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`edge.from ${edge.from} is not a graph node`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`edge.to ${edge.to} is not a graph node`);
    }
  }

  const incoming = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map([...nodeIds].map((id) => [id, 0]));
  for (const edge of graph.edges ?? []) {
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    outgoing.set(edge.from, outgoing.get(edge.from) + 1);
  }

  const sources = [...nodeIds].filter((id) => incoming.get(id) === 0);
  const sinks = [...nodeIds].filter((id) => outgoing.get(id) === 0);

  if (sources.length !== 1) {
    throw new Error(`expected single source, got ${sources.length}`);
  }
  if (sinks.length !== 1) {
    throw new Error(`expected single sink, got ${sinks.length}`);
  }

  const source = sources[0];
  const sink = sinks[0];
  const nodeBindings = binding.nodes ?? binding.owners ?? {};

  for (const node of graph.nodes) {
    const bound = nodeBindings[node.id];
    if (!bound || !bound.ownerPath || !bound.ownerRel) {
      throw new Error(`node ${node.id} has no owner binding`);
    }
    if (!ownerRoots.some((root) => bound.ownerRel.startsWith(root))) {
      throw new Error(`ownerRel ${bound.ownerRel} for node ${node.id} is outside allowed roots`);
    }
    if (bound.ownerRel.includes('..')) {
      throw new Error(`ownerRel ${bound.ownerRel} for node ${node.id} must not contain '..'`);
    }
    if (!bound.ownerPath.includes('..') && !isAbsolute(bound.ownerPath)) {
      const ownerPath = resolve(projectRoot, bound.ownerPath);
      const ownerRelative = relative(projectRoot, ownerPath);
      if (ownerRelative.startsWith('..') || isAbsolute(ownerRelative)) {
        throw new Error(`ownerPath ${bound.ownerPath} for node ${node.id} escapes projectRoot`);
      }
      if (!ownerRoots.some((root) => ownerRelative.startsWith(root))) {
        throw new Error(`ownerPath ${bound.ownerPath} for node ${node.id} is outside allowed roots`);
      }
      if (!existsSync(ownerPath)) {
        throw new Error(`ownerPath ${bound.ownerPath} for node ${node.id} does not exist`);
      }
    } else {
      throw new Error(`ownerPath ${bound.ownerPath} for node ${node.id} is not a project-relative path`);
    }
  }

  const adjacency = new Map([...nodeIds].map((id) => [id, []]));
  for (const edge of graph.edges ?? []) {
    adjacency.get(edge.from).push(edge.to);
  }

  const reachable = new Set([source]);
  const queue = [source];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of adjacency.get(current) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  if (!reachable.has(sink)) {
    throw new Error(`sink ${sink} cannot be reached`);
  }
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      throw new Error(`node ${node.id} is unreachable from source`);
    }
  }

  const operator = binding.operator;
  if (!operator || typeof operator.operator !== 'string') {
    throw new Error('operator binding must contain a non-empty operator string');
  }
  if (!operator.operator.startsWith('humanagent-')) {
    throw new Error(`operator ${operator.operator} must start with humanagent-`);
  }
  if (!semverMajor1.test(operator.operator_version ?? '')) {
    throw new Error(`operator_version ${operator.operator_version ?? ''} must be semver-major 1`);
  }

  for (const node of graph.nodes) {
    if (!node.operator.startsWith('humanagent-')) {
      throw new Error(`operator ${node.operator} must start with humanagent-`);
    }
    if (!semverMajor1.test(node.operator_version ?? '')) {
      throw new Error(`operator_version ${node.operator_version ?? ''} must be semver-major 1`);
    }
  }

  return { nodeCount: graph.nodes.length };
}

export function loadGraphBinding(graphPath, override) {
  const graph = readJson(graphPath);
  const bindingPath = bindingPathForGraph(graphPath, override);
  if (!existsSync(bindingPath)) {
    throw new Error(`missing binding file for ${graphPath}: expected ${bindingPath}`);
  }
  const binding = readJson(bindingPath);
  if (!binding.graph) {
    throw new Error(`binding graph missing for ${graphPath}: expected ${graph.id}`);
  }
  if (binding.graph !== graph.id) {
    throw new Error(`binding graph mismatch for ${graphPath}: expected ${graph.id}, got ${binding.graph}`);
  }
  return { graph, binding, bindingPath };
}

function main() {
  const [graphArg, bindingArg] = process.argv.slice(2);
  const graphFilter = process.env.DAGPIPE_GRAPH_PATH || graphArg;
  const override = process.env.DAGPIPE_BIND_OVERRIDE;

  let graphPaths;
  if (graphFilter) {
    if (!existsSync(graphFilter)) {
      throw new Error(`graph path does not exist: ${graphFilter}`);
    }
    graphPaths = [graphFilter];
  } else {
    graphPaths = readdirSync(graphDir)
      .filter((file) => file.endsWith('.graph.json'))
      .sort()
      .map((file) => join(graphDir, file));
  }

  if (graphPaths.length === 0) {
    throw new Error(`no *.graph.json files found under ${graphDir}`);
  }

  for (const graphPath of graphPaths) {
    const { graph, binding } = loadGraphBinding(graphPath, bindingArg || override);
    const result = validateBinding(graph, binding);
    console.log(`bound ${graph.id}: ${result.nodeCount} nodes ok`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
