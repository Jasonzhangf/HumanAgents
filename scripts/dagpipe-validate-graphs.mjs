import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const graphDir = join(projectRoot, 'docs', 'dagpipe');
const hanRegex = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const graphs = readdirSync(graphDir)
  .filter((file) => file.endsWith('.graph.json'))
  .sort();

if (graphs.length === 0) {
  throw new Error(`no *.graph.json files found under ${graphDir}`);
}

for (const file of graphs) {
  const graphPath = join(graphDir, file);
  const semanticPath = graphPath.replace(/\.graph\.json$/, '.graph.semantic.json');
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));

  if (!existsSync(semanticPath)) {
    throw new Error(`missing semantic label file for ${file}: expected ${semanticPath}`);
  }

  const semantic = JSON.parse(readFileSync(semanticPath, 'utf8'));
  if (semantic.graph !== graph.id) {
    throw new Error(`semantic graph mismatch for ${file}: expected ${graph.id}, got ${semantic.graph}`);
  }

  const labels = semantic.labels ?? {};
  for (const node of graph.nodes) {
    const label = labels[node.id];
    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new Error(`missing Chinese semantic label for node ${node.id} in ${file}`);
    }
    if (!hanRegex.test(label)) {
      throw new Error(`semantic label for node ${node.id} in ${file} must contain at least one CJK character`);
    }
  }

  execFileSync('dagpipe', ['graph', 'validate', graphPath], { stdio: 'inherit' });
}

console.log(`validated ${graphs.length} DAGpipe graph(s)`);
